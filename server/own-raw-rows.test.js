// 自营站点原始行的共用缓存读法（server/own-raw-rows.js）：同一份在缓存时间内只读一次、同时来的只发一个、换站点不串、失败不缓存
import test from "node:test";
import assert from "node:assert/strict";
import { readOwnRows } from "./own-raw-rows.js";

const own = { id: "own1", baseUrl: "https://own.test", userId: "1", authVersion: 1 };
const MIN = 60000, T0 = Date.parse("2026-11-01T12:00:00Z");

function fakeReaders() {
  const calls = [];
  const make = (kind) => async (site, startMs, endMs) => { calls.push({ kind, site: site.id, startMs, endMs }); return [{ kind, startMs }]; };
  return { calls, readers: { model: make("model"), user: make("user"), flow: make("flow") } };
}

test("缓存时间内同一份只读一次：不同的人、不同的页面读到的是同一份行", async () => {
  const rt = {}, { calls, readers } = fakeReaders();
  const a = await readOwnRows(rt, own, "model", T0 - 35 * 86400000, T0, { now: T0, readers });
  const b = await readOwnRows(rt, own, "model", T0 - 35 * 86400000, T0 + 30000, { now: T0 + 30000, readers });
  assert.equal(a, b);
  assert.equal(calls.length, 1, "结束时刻是「现在」的窗口，现在不一样也是同一个窗口");
});

test("缓存多久由调用方说：2 分钟的调用方在 3 分钟后重读，10 分钟的调用方用同一份；过了 10 分钟都重读", async () => {
  const rt = {}, { calls, readers } = fakeReaders();
  const start = T0 - 86400000;
  await readOwnRows(rt, own, "flow", start, T0, { now: T0, readers, ttlMs: 10 * MIN });
  await readOwnRows(rt, own, "flow", start, T0 + 3 * MIN, { now: T0 + 3 * MIN, readers, ttlMs: 10 * MIN });
  assert.equal(calls.length, 1, "10 分钟的调用方 3 分钟后还用同一份");
  await readOwnRows(rt, own, "flow", start, T0 + 3 * MIN, { now: T0 + 3 * MIN, readers, ttlMs: 2 * MIN });
  assert.equal(calls.length, 2, "2 分钟的调用方嫌旧，重读");
  await readOwnRows(rt, own, "flow", start, T0 + 4 * MIN, { now: T0 + 4 * MIN, readers, ttlMs: 10 * MIN });
  assert.equal(calls.length, 2, "重读的那份是新的，10 分钟的调用方也用它");
  await readOwnRows(rt, own, "flow", start, T0 + 20 * MIN, { now: T0 + 20 * MIN, readers, ttlMs: 10 * MIN });
  assert.equal(calls.length, 3);
});

test("同时来的几个请求只发一个；读失败的不缓存，下一次重读", async () => {
  const rt = {};
  let calls = 0, fail = true, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const readers = { model: async () => { calls += 1; await gate; if (fail) throw new Error("boom"); return [1]; } };
  const first = readOwnRows(rt, own, "model", 1, T0, { now: T0, readers });
  const second = readOwnRows(rt, own, "model", 1, T0, { now: T0 + 1000, readers });
  release();
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(calls, 1, "同时来的只发了一个");
  fail = false;
  assert.deepEqual(await readOwnRows(rt, own, "model", 1, T0, { now: T0 + 2000, readers }), [1]);
  assert.equal(calls, 2, "失败的没缓存");
});

test("换了窗口、种类、站点地址或配置版本，就是另一份；固定结束时刻的窗口（上一个等长窗口）按结束时刻分", async () => {
  const rt = {}, { calls, readers } = fakeReaders();
  const opts = { now: T0, readers };
  await readOwnRows(rt, own, "model", 1, T0, opts);
  await readOwnRows(rt, own, "user", 1, T0, opts);
  await readOwnRows(rt, own, "model", 2, T0, opts);
  await readOwnRows(rt, { ...own, baseUrl: "https://other.test" }, "model", 1, T0, opts);
  await readOwnRows(rt, { ...own, authVersion: 2 }, "model", 1, T0, opts);
  await readOwnRows(rt, own, "model", 1, T0 - 10 * 86400000, opts);
  await readOwnRows(rt, own, "model", 1, T0 - 9 * 86400000, opts);
  assert.equal(calls.length, 7);
  await readOwnRows(rt, own, "model", 1, T0 - 10 * 86400000, opts);
  assert.equal(calls.length, 7, "固定结束时刻的窗口再读命中缓存");
  await assert.rejects(readOwnRows(rt, own, "bogus", 1, T0, opts), /unknown/);
});

test("缓存有上限：太多的窗口把最老的挤掉", async () => {
  const rt = {}, { calls, readers } = fakeReaders();
  for (let i = 0; i < 40; i += 1) await readOwnRows(rt, own, "model", i, T0, { now: T0, readers });
  assert.ok(rt._ownRawRows.size <= 12);
  await readOwnRows(rt, own, "model", 0, T0, { now: T0, readers });
  assert.equal(calls.length, 41, "最老的那份被挤掉了，要重读");
});

test("failTtlMs：读失败以后这个窗口在这么久之内不再重试，直接给同一个错；不传的调用方不受影响；额度拦下的（beforeRead）不算失败", async () => {
  const rt = {};
  let calls = 0;
  const boom = new Error("404");
  const readers = { flow: async () => { calls += 1; throw boom; } };
  const ask = (now, options = {}) => readOwnRows(rt, own, "flow", 1, T0 + now, { now: T0 + now, readers, ...options }); // 结束时刻是「现在」
  await assert.rejects(ask(0, { failTtlMs: 10 * MIN }), (error) => error === boom);
  assert.equal(calls, 1);
  for (const minutes of [1, 2, 9]) await assert.rejects(ask(minutes * MIN, { failTtlMs: 10 * MIN }), (error) => error === boom);
  assert.equal(calls, 1, "10 分钟内每分钟来取，也只读过一次");
  await assert.rejects(ask(5 * MIN), (error) => error === boom);
  assert.equal(calls, 2, "没传 failTtlMs 的调用方（自营业务）照旧每次都读");
  await assert.rejects(ask(11 * MIN, { failTtlMs: 10 * MIN }));
  assert.equal(calls, 3, "过了 10 分钟再读一次");
  // 额度拦下的不记：下一次额度好了就能读
  const rt2 = {};
  let ok = false, reads = 0;
  const readers2 = { flow: async () => { reads += 1; return [1]; } };
  const guarded = (now) => readOwnRows(rt2, own, "flow", 1, T0 + now, { now: T0 + now, readers: readers2, failTtlMs: 10 * MIN, beforeRead: () => { if (!ok) throw Object.assign(new Error("busy"), { code: "BUSY" }); } });
  await assert.rejects(guarded(0), { code: "BUSY" });
  ok = true;
  assert.deepEqual(await guarded(MIN), [1]);
  assert.equal(reads, 1);
  // 读成功以后缓存照旧
  assert.deepEqual(await guarded(2 * MIN), [1]);
  assert.equal(reads, 1);
});
