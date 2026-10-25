import test from "node:test";
import assert from "node:assert/strict";
import { deriveAgentKeys } from "../lib/key-fingerprint.js";
import { buildSnapshot, channelView, createSnapshotSource } from "./snapshot.js";

const { fingerprintKey } = deriveAgentKeys("snapshot-test-secret-0123456789-abcdefgh");
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
