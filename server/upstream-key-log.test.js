import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamKeyLogReader } from "./upstream-key-log.js";
import { queryKeyReconciliationStat } from "../lib/providers.js";

const HOUR = 3600000, START = Date.UTC(2026, 10, 24);
const station = { type: "newapi", baseUrl: "https://upstream.test", accessToken: "private-pat", authVersion: 1 };
const metadata = { accountId: 7, userId: 7, quotaPerUnit: 100 };
const row = (id, quota, second, name = "renamed") => ({ id: 0, token_id: id, quota, created_at: START / 1000 + second, type: 2, token_name: name, user_id: 7 });

class MemoryStore {
  rows = new Map();
  n = 0;
  key(source, a, b) { return `${source}:${a}:${b}`; }
  async get(source, a, b) { return structuredClone(this.rows.get(this.key(source, a, b)) || null); }
  async put(source, a, b, value, expectedRevision) {
    const key = this.key(source, a, b);
    if ((this.rows.get(key)?.revision ?? null) !== expectedRevision) return null;
    const saved = { revision: String(++this.n), value: structuredClone(value) };
    this.rows.set(key, saved); return saved;
  }
}

function fixture(rows, options = {}) {
  const store = options.store || new MemoryStore(), calls = [];
  const clock = { value: START + 2 * HOUR };
  const inWindow = (args) => rows.filter((r) => r.created_at * 1000 >= args.startMs && r.created_at * 1000 < args.endMs).sort((a, b) => b.created_at - a.created_at);
  const page = async (_station, args) => {
    calls.push({ kind: "page", ...args });
    const all = inWindow(args), offset = (args.page || 0) * 100;
    return { format: "items", total: all.length, rows: all.slice(offset, offset + 100) };
  };
  const stat = async (_station, args) => {
    calls.push({ kind: "stat", ...args });
    assert.equal(args.accountTotal, true);
    return { quotaUnits: inWindow(args).reduce((sum, r) => sum + r.quota, 0), quotaPerUnit: 100 };
  };
  const reader = createUpstreamKeyLogReader({ store, page, stat, now: () => clock.value, ...options });
  const read = (id = 9, extra = {}) => reader.read(station, { metadata, token: { id, name: "renamed" }, startMs: START, endMs: START + HOUR, ...extra });
  return { store, calls, clock, reader, read, page, stat };
}

test("改名前、中间名和新名的费用按 token_id 合并；100 把 Key 共用一份账号读取，同名费用不混入", async () => {
  const f = fixture([row(9, 20, 1, "old"), row(9, 30, 2, "middle"), row(9, 40, 3, "new"), row(10, 900, 4, "old")]);
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => f.read(index === 99 ? 10 : 9)));
  assert.equal(results[0].complete, true);
  assert.equal(results[0].quotaUnits, 90);
  assert.equal(results[99].quotaUnits, 900);
  assert.equal(f.calls.length, 3, "一次列表加两次账号统计，和绑定数无关");
  const saved = JSON.stringify([...f.store.rows]);
  assert.ok(!saved.includes("private-pat"));
  assert.ok(!saved.includes("middle"));
});

test("预算用尽标为 pending，重启读取器后从持久化页进度恢复，不把半份数据当成零费用", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => row(index % 2 ? 9 : 10, 1, index));
  const f = fixture(rows, { maxRequests: 3 });
  const pending = await queryKeyReconciliationStat(station, { token: { id: 9 }, metadata, startMs: START, endMs: START + HOUR,
    newApiStat: () => f.read() });
  assert.deepEqual([pending.state, pending.complete, pending.amountUsd, pending.knownAmountUsd], ["pending", false, null, null]);
  const next = fixture(rows, { store: f.store });
  const result = await next.read();
  assert.equal(result.quotaUnits, 75);
  assert.equal(result.complete, true);
  assert.deepEqual(next.calls.filter((c) => c.kind === "page").map((c) => c.page || 0), [0, 2, 0], "先核对首页、接着读取，不重复累计前两页");
});

test("迟到日志导致账号总额度变化时重读；读完整后也必须与账号额度对上", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => row(9, 1, index));
  const f = fixture(rows, { maxRequests: 3 });
  assert.equal((await f.read()).complete, false);
  rows.push(row(9, 50, 1, "late-old-name"));
  const next = fixture(rows, { store: f.store });
  assert.equal((await next.read()).quotaUnits, 200);
  const wrong = fixture([row(9, 10, 1)], { stat: async () => ({ quotaUnits: 11 }) });
  assert.deepEqual([(await wrong.read()).complete, (await wrong.read()).quotaUnits], [false, null]);
});

test("预算包含统计请求；只读不写、不新增请求；凭据或账号改变不能复用旧聚合", async () => {
  const f = fixture([row(9, 10, 1)]);
  const readonly = await f.read(9, { readOnly: true });
  assert.equal(readonly.complete, false); assert.equal(f.calls.length, 0); assert.equal(f.store.rows.size, 0);
  assert.equal((await f.read()).quotaUnits, 10);
  const n = f.calls.length;
  assert.equal((await f.read(9, { readOnly: true })).quotaUnits, 10);
  assert.equal(f.calls.length, n);
  await assert.rejects(f.read(9, { metadata: { ...metadata, accountId: 8 } }), /账号身份/);
  assert.equal((await f.read(9, { metadata: { ...metadata, accountId: 8, userId: 8 }, readOnly: true })).complete, false);
  const changed = await f.reader.read({ ...station, accessToken: "different-pat" }, { metadata, token: { id: 9 }, startMs: START, endMs: START + HOUR, readOnly: true });
  assert.equal(changed.complete, false);
});

test("不把个人日志的显示 id 当唯一编号，截断、重复页、缺 token_id 或越界日志均不能给出完整费用", async () => {
  const sameId = fixture([row(9, 10, 1), row(9, 20, 2)]);
  assert.equal((await sameId.read()).quotaUnits, 30);
  const repeated = fixture(Array.from({ length: 100 }, (_, i) => row(9, 1, i)), {
    page: async () => ({ format: "array", total: null, rows: Array.from({ length: 100 }, (_, i) => row(9, 1, i)) }),
  });
  await assert.rejects(repeated.read(), /翻页没有前进/);
  for (const bad of [{ ...row(9, 1, 1), token_id: undefined }, row(0, 1, 1), row(9, 1, 99999), { ...row(9, 1, 1), user_id: 8 }]) {
    const f = fixture([], { page: async () => ({ format: "items", total: 1, rows: [bad] }) });
    await assert.rejects(f.read(), /窗口身份/);
  }
  const capped = fixture([row(9, 1, 1)], { page: async () => ({ format: "items", total: 200, rows: [row(9, 1, 1)] }) });
  assert.equal((await capped.read()).complete, false);
});

test("密集窗口二分为稳定子窗口；当前窗口向前推进时可复用已经读完的旧子窗口", async () => {
  const rows = Array.from({ length: 900 }, (_, index) => row(9, 1, index * 2));
  const f = fixture(rows, { maxRequests: 200 });
  const first = await f.read(9, { endMs: START + 900000 });
  assert.equal(first.complete, true); assert.equal(first.quotaUnits, 450);
  assert.ok([...f.store.rows.values()].some((item) => item.value.split));
  f.clock.value += 60000;
  const next = await f.read(9, { endMs: START + 1800000 });
  assert.equal(next.complete, true); assert.equal(next.quotaUnits, 900);
  const short = await f.read(9, { startMs: START + 1500, endMs: START + 3999 });
  assert.equal(short.quotaUnits, 1, "只计算完整落在窗口内的秒，邻段不重叠");
});

test("并发 worker 的持久化 CAS 失败时不发布完整金额", async () => {
  const store = new MemoryStore(); store.put = async () => null;
  const f = fixture([row(9, 10, 1)], { store });
  assert.equal((await f.read()).complete, false);
});

test("当前小时向前推进时不把缓存覆盖以后的新消费算成零，结束满等待期后重新核验迟到消费", async () => {
  const rows = [row(9, 10, 60)];
  const f = fixture(rows);
  f.clock.value = START + 1800000;
  assert.equal((await f.read(9, { endMs: f.clock.value })).quotaUnits, 10);
  f.clock.value += 60000; rows.push(row(9, 20, 1801));
  assert.equal((await f.read(9, { endMs: f.clock.value })).quotaUnits, 30);
  f.clock.value = START + HOUR + 10 * 60000;
  assert.equal((await f.read()).quotaUnits, 30);
  f.clock.value += 10 * 60000; rows.push(row(9, 40, 1802, "late-old-name"));
  assert.equal((await f.read()).quotaUnits, 70, "结账等待期前读到的整小时不直接复用来结账");
});

test("重结按登记请求时刻重新读取，不能复用请求以前的历史聚合；后续轮次可接着用新聚合", async () => {
  const rows = [row(9, 10, 1)], f = fixture(rows);
  assert.equal((await f.read()).quotaUnits, 10);
  f.clock.value += 60000; rows.push(row(9, 20, 2));
  const freshAfterMs = f.clock.value;
  assert.equal((await f.read(9, { freshAfterMs })).quotaUnits, 30);
  const count = f.calls.length;
  f.clock.value += 60000;
  assert.equal((await f.read(9, { freshAfterMs })).quotaUnits, 30);
  assert.equal(f.calls.length, count, "跨轮不反复作废相同重结请求已经读全的窗口");
});
