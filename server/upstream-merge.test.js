import test from "node:test";
import assert from "node:assert/strict";
import { applyUpstreamMerge, cachedMergeCounts, estimateGroups, invalidateMergeCounts, undoUpstreamMerge } from "./upstream-merge.js";
import { businessTimeZone, dayKeyInTz, shiftDayLabel } from "../lib/business-time.js";

const NOW = Date.parse("2026-10-25T06:00:00Z");
const TODAY = dayKeyInTz(NOW, businessTimeZone());
const day = (back) => shiftDayLabel(TODAY, -back);
const identity = { provider: "newapi", baseUrl: "https://up.example.com", accountId: "42" };
const station = (id, created, extra = {}) => ({ id, name: id, type: "newapi", baseUrl: identity.baseUrl, createdAt: created, monitorEnabled: true, includeInProfit: true,
  costAliases: [], fixedPurchases: [], resoldAdminKeys: [], verifiedIdentity: identity, ...extra });
const group = (blockers = []) => ({ retained: { id: "a", name: "a" }, merged: [{ id: "b", name: "b" }], blockers });
const fakeRt = (stations, { rows = [], onQuery = () => {} } = {}) => ({
  store: { get: (id) => stations.find((s) => s.id === id), getWithMerged: (id) => stations.find((s) => s.id === id), list: () => stations },
  pool: { async query(sql, params) {
    onQuery(sql);
    if (/FROM reconciliation_rules/.test(sql)) return [[]];
    if (/FROM channel_monitor_links/.test(sql)) return [[]];
    if (/COUNT\(DISTINCT merge_id\)/.test(sql)) return [[{ n: 0 }]];
    // 和真库一样只回问到的那几个上游的行
    if (/station_daily_usage/.test(sql)) return [rows.filter((row) => params[0].includes(row.stationId))];
    throw new Error("unexpected query: " + sql);
  } },
});

test("估算和成本估算页一样只算「按用量计费、算进利润」的上游：留下的记了固定成本，前后都不含它的用量；被合掉的不算进利润，也不含", async () => {
  const rows = [{ stationId: "a", date: day(0), usd: 10 }, { stationId: "b", date: day(0), usd: 4 }];
  const fixedRetained = fakeRt([station("a", "2026-03-01T00:00:00Z", { fixedPurchases: [{ amount: 100, days: 30, startDate: null }] }), station("b", "2026-03-02T00:00:00Z")], { rows });
  const [fixed] = await estimateGroups(fixedRetained, [group()], { now: NOW });
  assert.deepEqual([fixed.windows[0].before.cny, fixed.windows[0].after.cny], [4, 0]);
  assert.deepEqual(fixed.windows[0].before.upstreams.map((u) => [u.stationId, u.counted]), [["a", false], ["b", true]]);
  const uncounted = fakeRt([station("a", "2026-03-01T00:00:00Z", { includeInProfit: false }), station("b", "2026-03-02T00:00:00Z", { includeInProfit: false })], { rows });
  const [none] = await estimateGroups(uncounted, [group()], { now: NOW });
  assert.deepEqual([none.windows[0].before.cny, none.windows[0].after.cny, none.windows[0].approx], [0, 0, false]);
});

test("窗口起点：近 7 天是今天往前 6 天，近 30 天往前 29 天，第 7、30 天以前的不算", async () => {
  const rows = [[0, 1], [6, 2], [7, 4], [29, 8], [30, 16]].map(([back, usd]) => ({ stationId: "a", date: day(back), usd }));
  let queried;
  const rt = fakeRt([station("a", "2026-03-01T00:00:00Z"), station("b", "2026-03-02T00:00:00Z")], { rows: rows.filter((row) => row.date >= day(29)), onQuery: (sql) => { queried = sql; } });
  const [estimate] = await estimateGroups(rt, [group()], { now: NOW });
  assert.deepEqual(estimate.windows.map((w) => [w.days, w.before.cny]), [[7, 3], [30, 15]]);
  assert.ok(queried.includes("station_daily_usage"));
});

test("留下的没设汇率、被合掉的设了：这一组的估算是 null（前后的汇率不一样，加起来没有意义）", async () => {
  const rt = fakeRt([station("a", "2026-03-01T00:00:00Z"), station("b", "2026-03-02T00:00:00Z", { cnyPerUsd: 7.2 })], { rows: [{ stationId: "b", date: day(0), usd: 1 }] });
  assert.deepEqual(await estimateGroups(rt, [group([{ code: "RATE_UNSET_ON_RETAINED" }])], { now: NOW }), [null]);
});

test("入口的几个数：并发冷调用只发一轮查询；合并、退回作废以后在途的那一次读完也不写回旧值", async () => {
  let queries = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const rt = fakeRt([station("a", "2026-03-01T00:00:00Z"), station("b", "2026-03-02T00:00:00Z")], { onQuery: () => { queries += 1; } });
  const original = rt.pool.query;
  rt.pool.query = async (sql, params) => { await gate; return original(sql, params); };
  const calls = Array.from({ length: 20 }, () => cachedMergeCounts(rt, { now: NOW }));
  invalidateMergeCounts(rt);
  release();
  const results = await Promise.all(calls);
  assert.equal(queries, 3, "20 个并发调用共用一轮查询：绑定、关联、合并次数各一条");
  assert.ok(results.every((counts) => counts === results[0]));
  assert.equal(rt._mergeCounts.at, 0, "作废以后在途的结果不写回缓存");
  const again = await cachedMergeCounts(rt, { now: NOW + 1 });
  assert.equal(queries, 6);
  assert.deepEqual(again, { mergeable: 1, blocked: 0, accounts: 1, upstreams: 2, records: 0 });
  await cachedMergeCounts(rt, { now: NOW + 2 });
  assert.equal(queries, 6, "1 分钟内走缓存");
  await cachedMergeCounts(rt, { now: NOW + 61_000 });
  assert.equal(queries, 9);
});

test("入口校验：合并缺编号、不是数组、元素不是字符串，退回缺编号或编号不是字符串，一律 UPSTREAM_MERGE_INVALID，不会去读库、更不会「退回最近一次」", async () => {
  const rt = fakeRt([]);
  rt.pool.query = async () => assert.fail("must not query");
  for (const input of [{}, { retainedId: "a" }, { retainedId: "a", mergedIds: "b" }, { retainedId: "a", mergedIds: [] }, { retainedId: "a", mergedIds: [1] }, { retainedId: "", mergedIds: ["b"] }, { retainedId: 5, mergedIds: ["b"] }, { retainedId: "a", mergedIds: [{ toString: "x" }] }]) {
    await assert.rejects(applyUpstreamMerge(rt, input), { code: "UPSTREAM_MERGE_INVALID" }, JSON.stringify(input));
  }
  for (const input of [{}, { mergeId: "" }, { mergeId: "  " }, { mergeId: 1 }, { mergeId: null }, { mergeId: ["mg_1"] }]) {
    await assert.rejects(undoUpstreamMerge(rt, input), { code: "UPSTREAM_MERGE_INVALID" }, JSON.stringify(input));
  }
});
