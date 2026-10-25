import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentKeys } from "../lib/key-fingerprint.js";
import { buildSnapshot, breakerPause, channelView, createSnapshotSource } from "./snapshot.js";
import { ReadFailure } from "./reader.js";

const { fingerprintKey } = deriveAgentKeys("Sn4pshotKd83LmQwRtYx9zPa5vBn7cJf4hGs2");
const view = (row) => channelView({ id: 1, name: "c", type: 1, status: 1, base_url: "", channel_info: null, ...row }, fingerprintKey);
const PLAIN = "sk-AbC1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c";

test("按渠道类型认 keyless：串看着像普通 Key 也不给打码（Baidu、Xunfei、AWS、Codex）；腾讯 23、即梦 51 的普通 Bearer Key 照常打码", () => {
  for (const type of [23, 51]) assert.equal(view({ type, key: PLAIN }).keys.length, 1, `type ${type}`);
  for (const type of [23, 51]) assert.equal(view({ type, key: "appid|secretid|secretkey" }).keyless, true, `type ${type} 的 | 串靠样子认`);
  for (const type of [15, 18, 33, 57]) {
    const out = view({ type, key: PLAIN });
    assert.equal(out.keyless, true, `type ${type}`);
    assert.ok(!("keys" in out));
  }
});

test("按串的样子认 keyless：JSON 账号文件、ak|sk、token|appid，不管渠道类型是几", () => {
  for (const key of ['{"type":"service_account","private_key":"x"}', "AKIAEXAMPLE|secretsecretsecretsecret", "token-token-token-token-token|1234"]) {
    for (const type of [1, 41, 46, 50]) {
      const out = view({ type, key });
      assert.equal(out.keyless, true, `${type} ${key.slice(0, 8)}`);
      assert.doesNotMatch(JSON.stringify(out), /secretsecret|service_account|token-token/);
    }
  }
});

test("Vertex 的 api_key 模式是一把普通的 key，照常打码和指纹", () => {
  const out = view({ type: 41, key: "AIzaSyD-example_0123456789abcdefghijklmnopq" });
  assert.equal(out.keyless, undefined);
  assert.equal(out.keys.length, 1);
  assert.equal(out.keys[0].m, "AIza…nopq");
});

test("普通渠道：打码、指纹、顺序；channel_info 给对象、JSON 文字、坏文字都认", () => {
  assert.deepEqual(view({ key: PLAIN }).keys.map((k) => k.m), ["AbC1…9f0c"]);
  const multi = "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.equal(view({ key: multi, channel_info: { is_multi_key: true } }).keys.length, 2);
  assert.equal(view({ key: multi, channel_info: '{"is_multi_key":true}' }).keys.length, 2);
  assert.equal(view({ key: multi, channel_info: "{坏的" }).keys.length, 1);
  assert.equal(view({ key: multi, channel_info: "" }).keys.length, 1);
  assert.equal(view({ key: multi, channel_info: { is_multi_key: "true" } }).keys.length, 1);
});

test("PostgreSQL 的 bigint 以文字回来也认；ETag 只随内容变，不随读库时刻变", () => {
  assert.equal(view({ id: "7", type: "1", status: "2" }).id, 7);
  const rows = [{ id: 1, name: "a", type: 1, status: 1, base_url: "", key: PLAIN, channel_info: null }];
  const a = buildSnapshot(rows, { db: "mysql", fingerprintKeyBytes: fingerprintKey, now: 1 });
  const b = buildSnapshot(rows, { db: "mysql", fingerprintKeyBytes: fingerprintKey, now: 2 });
  assert.equal(a.etag, b.etag);
  assert.notDeepEqual(a.body, b.body);
  assert.notEqual(buildSnapshot(rows, { db: "sqlite", fingerprintKeyBytes: fingerprintKey, now: 1 }).etag, a.etag);
});

test("时钟往回拨：缓存的年龄是负的，说不清，重读一次，不让它一直当新的", async () => {
  let reads = 0, t = 1_000_000;
  const source = createSnapshotSource({ reader: { async read() { reads += 1; return []; } }, db: "mysql", fingerprintKeyBytes: fingerprintKey, now: () => t });
  await source.get(); await source.get();
  assert.equal(reads, 1);
  t -= 3_600_000;
  await source.get();
  assert.equal(reads, 2);
  await source.get();
  assert.equal(reads, 2);
});

const MIN = 60_000;
const sourceWith = (read, t, extra = {}) => createSnapshotSource({ reader: { read }, db: "mysql", fingerprintKeyBytes: fingerprintKey, now: () => t.v, ...extra });

test("读库的节奏：4 分钟内不管问多少次都用缓存，过了 4 分钟再有人来问才读；没人问就不读", async () => {
  let reads = 0;
  const t = { v: 10 * 60 * MIN };
  const source = sourceWith(async () => { reads += 1; return []; }, t);
  await source.get();
  for (let i = 0; i < 100; i += 1) { t.v += 2000; await source.get(); }
  assert.equal(reads, 1, "200 秒里问了 100 次");
  t.v += 60 * MIN;
  assert.equal(reads, 1, "时间过了，但没人问就不读");
  await source.get();
  assert.equal(reads, 2);
});

test("断路：出错后停 10 分钟，再错翻倍，最多 1 小时；停的时候来问也不读；读成功就清零", async () => {
  let reads = 0, fail = true;
  const t = { v: 10 * 60 * MIN };
  const events = [];
  const source = sourceWith(async () => { reads += 1; if (fail) throw new ReadFailure("DB_TIMEOUT", "ER_QUERY_TIMEOUT"); return []; }, t, { onBreaker: (e) => events.push(e) });
  const pauses = [10, 20, 40, 60, 60];
  for (const minutes of pauses) {
    const before = reads;
    assert.equal((await source.get()).code, "DB_TIMEOUT");
    assert.equal(reads, before + 1);
    t.v += minutes * MIN - 1;
    await source.get(); await source.get();
    assert.equal(reads, before + 1, `${minutes} 分钟还没到，不读`);
    t.v += 2;
  }
  assert.deepEqual(events.map((e) => e.pauseMs / MIN), [10, 20, 40, 60, 60]);
  fail = false;
  assert.equal((await source.get()).ok, true);
  const afterOk = reads;
  t.v += 3 * MIN;
  await source.get();
  assert.equal(reads, afterOk, "成功以后回到 4 分钟的节奏");
  fail = true; t.v += 5 * MIN;
  await source.get();
  assert.equal(events.at(-1).pauseMs / MIN, 10, "成功以后断路清零，从 10 分钟重新数");
});

test("DB_LIMIT（连接数、每小时语句额度到顶）：停到下一个整点；ACCOUNT_TOO_BROAD 按普通断路", async () => {
  assert.equal(breakerPause(1, "DB_LIMIT", Date.UTC(2026, 0, 1, 10, 20, 0)), 40 * MIN);
  assert.equal(breakerPause(3, "DB_LIMIT", Date.UTC(2026, 0, 1, 10, 59, 59)), 1000);
  assert.equal(breakerPause(1, "DB_ERROR", 0), 10 * MIN);
  let reads = 0;
  const t = { v: Date.UTC(2026, 0, 1, 10, 20, 0) };
  const source = sourceWith(async () => { reads += 1; throw new ReadFailure("DB_LIMIT", "ER_USER_LIMIT_REACHED"); }, t);
  await source.get();
  t.v = Date.UTC(2026, 0, 1, 10, 59, 59);
  await source.get();
  assert.equal(reads, 1);
  t.v = Date.UTC(2026, 0, 1, 11, 0, 1);
  await source.get();
  assert.equal(reads, 2);
});

test("PAUSED：不碰 reader，回 PAUSED", async () => {
  let reads = 0;
  const source = sourceWith(async () => { reads += 1; return []; }, { v: 1 }, { paused: true });
  const snapshot = await source.get();
  assert.deepEqual([snapshot.ok, snapshot.code, reads], [false, "PAUSED", 0]);
});

test("时钟往回拨，断路停到的时刻比最长还远：不让它一直停", async () => {
  let reads = 0;
  const t = { v: 10 * 60 * MIN };
  const source = sourceWith(async () => { reads += 1; throw new ReadFailure("DB_ERROR", "X"); }, t);
  await source.get();
  t.v -= 3 * 60 * MIN;
  await source.get();
  assert.equal(reads, 2);
});
