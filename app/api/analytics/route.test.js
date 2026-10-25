import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { hasRawWindowCoverage, summarizeCoverage } from "./coverage.js";
import { amortizeFixedCost, splitByCumulative } from "../../../lib/profit.js";

const days = [
  { date: "2026-09-18" },
  { date: "2026-09-19" },
  { date: "2026-09-20" },
];

test("经营分析覆盖率以每个受监控资源为准，不用任一资源并集冒充完整", () => {
  const stations = [{ id: "a", name: "完整" }, { id: "b", name: "缺口" }];
  const bounds = new Map([
    ["a", { earliestDate: "2026-09-18", latestDate: "2026-09-20" }],
    ["b", { earliestDate: "2026-09-18", latestDate: "2026-09-20" }],
  ]);
  const coverage = summarizeCoverage(stations, days, [
    { stationId: "a", date: "2026-09-18" },
    { stationId: "a", date: "2026-09-19" },
    { stationId: "a", date: "2026-09-20" },
    { stationId: "b", date: "2026-09-18" },
    // b 在 19 日没有快照，不得被 a 的同日记录补成 0 成本。
    { stationId: "b", date: "2026-09-20" },
  ], bounds);

  assert.equal(coverage.isComplete, false);
  assert.equal(coverage.availableDays, 2);
  assert.deepEqual(coverage.stationGaps, [{
    stationId: "b",
    stationName: "缺口",
    archivedAt: null,
    earliestDate: "2026-09-18",
    latestDate: "2026-09-20",
    availableDays: 2,
    missingDays: 1,
    isComplete: false,
  }]);
});

test("热力图需要完整原始日期和窗口起点基线", () => {
  const stations = [{ id: "a", name: "成本资源" }];
  const rawBounds = new Map([["a", {
    earliestAt: new Date("2026-09-18T12:00:00").getTime(),
    earliestDate: "2026-09-18",
    latestDate: "2026-09-20",
  }]]);
  const rawCoverage = summarizeCoverage(stations, days, days.map(({ date }) => ({ stationId: "a", date })), rawBounds);

  assert.equal(rawCoverage.isComplete, true);
  assert.equal(hasRawWindowCoverage(rawCoverage, stations, rawBounds, new Date("2026-09-18T00:00:00").getTime()), false);
});

async function analyticsRoute() {
  // 只替换鉴权适配层，执行真实的 GET 处理函数
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return nextLoad(url, context);
  } });
  try { return await import("./route.js"); } finally { hook.deregister(); }
}

test("经营分析按业务时区划日：热力图按上海时间分桶、只含按用量计成本的上游，固定成本今天只摊到现在", async (t) => {
  // 上海 2026-10-14 12:00
  const NOW = Date.UTC(2026, 9, 14, 4, 0);
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const SLOT = 15 * 60 * 1000;
  const startMs = Date.UTC(2026, 9, 7, 16); // 上海 10-08 00:00
  const stations = [
    { id: "own", name: "自营", type: "newapi", isOwn: true, cnyPerUsd: 7 },
    { id: "u", name: "按量上游", type: "newapi", cnyPerUsd: 7 },
    { id: "f", name: "包月上游", type: "newapi", cnyPerUsd: 7, fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }] },
  ];
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("UNION ALL")) {
      // 窗口前的基线 + 每天一点；UTC 10-13 16:30 = 上海 10-14 周三 00:30 余额掉了 $2，之后一点不变
      const daily = (i, remaining) => ({ station_id: "u", t: startMs + i * 86400000 + 3600000, remaining });
      return [[{ station_id: "u", t: startMs - 3600000, remaining: 100 }, ...Array.from({ length: 6 }, (_, i) => daily(i, 100)),
        { station_id: "u", t: Date.UTC(2026, 9, 13, 16, 30), remaining: 98 }, daily(6, 98)]];
    }
    if (sql.includes("MIN(t)")) return [[{ stationId: "u", earliestAt: startMs - 3600000, latestAt: NOW - 60000 }]];
    return [[]];
  } };
  const rt = { pool, store: { list: () => stations }, history: { predict: () => null } };
  const { GET } = await analyticsRoute();
  const res = await GET(new Request("https://local.test/api/analytics?days=7"), rt);
  const body = await res.json();

  assert.equal(body.tz, "Asia/Shanghai");
  assert.equal(body.start, "2026-10-08");
  assert.equal(body.end, "2026-10-14");
  const pointCalls = calls.filter((c) => c.sql.includes("history_points") && !c.sql.includes("MIN(t)"));
  assert.equal(pointCalls.length, 1, "窗口里的原始快照只读一次，不再每个点一次子查询");
  assert.deepEqual(pointCalls[0].params, [["u"], startMs, Number.MAX_SAFE_INTEGER, ["u"], startMs], "包月上游不进热力图，窗口起点是上海零点");
  assert.equal(SLOT, 15 * 60 * 1000);
  assert.equal(body.heatmapAvailability.available, true);
  // 2026-10-14 是周三（weekday 0 = 周一）
  assert.deepEqual(body.heatmap, [{ weekday: 2, hour: 0, cny: 14 }]);
  const fixed = Object.fromEntries(body.fixedDaily.map((r) => [r.date, r.cny]));
  assert.equal(fixed["2026-10-08"], 10);
  assert.equal(fixed["2026-10-14"], 5, "今天只摊到中午");
  const byId = Object.fromEntries(body.stations.map((s) => [s.id, s]));
  assert.equal(byId.f.costBasis, "fixed");
  assert.equal(byId.u.costBasis, "usage");
  assert.equal(byId.f.fixedCny, 65);
});

test("固定成本逐日摊销不逐日舍入：站点合计与整段摊销（我的站点口径）一致，小额付费也不会被舍成 0", async (t) => {
  const NOW = Date.UTC(2026, 9, 14, 4, 0); // 上海 10-14 12:00
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const startMs = Date.UTC(2026, 9, 7, 16); // 上海 10-08 00:00
  const stations = [
    { id: "a", name: "除不尽", type: "newapi", fixedPurchases: [{ amount: 100, days: 30, startDate: "2026-10-01" }] },
    { id: "b", name: "小额年付", type: "newapi", fixedPurchases: [{ amount: 1, days: 365 }] },
  ];
  const rt = { pool: { query: async () => [[]] }, store: { list: () => stations }, history: { predict: () => null } };
  const { GET } = await analyticsRoute();
  const body = await (await GET(new Request("https://local.test/api/analytics?days=7"), rt)).json();
  const byId = Object.fromEntries(body.stations.map((s) => [s.id, s]));
  for (const s of stations) {
    const whole = amortizeFixedCost(s.fixedPurchases, { startMs, endMs: NOW, tz: "Asia/Shanghai" }).cny;
    assert.equal(byId[s.id].fixedCny, whole, `${s.name} 合计应等于整段摊销`);
  }
  assert.equal(byId.a.fixedCny, 21.67);
  assert.equal(byId.b.fixedCny, 0.02);
  assert.equal(body.fixedDaily.filter((r) => r.stationId === "b").length, 7, "每天几厘钱的摊销也要保留");
  // 页面的逐日固定成本：按逐日摊销的累计占比把合计分回每天，相加正好等于合计（趋势表、累计图与等式一致）
  for (const s of stations) {
    const daily = body.fixedDaily.filter((r) => r.stationId === s.id).map((r) => r.cny);
    const rows = splitByCumulative(daily, byId[s.id].fixedCny);
    assert.equal(Math.round(rows.reduce((a, v) => a + v, 0) * 100), Math.round(byId[s.id].fixedCny * 100), `${s.name} 逐日之和应等于合计`);
  }
});

test("固定成本合计恰好落在半分上时，也与「我的站点」整段摊销一致", async (t) => {
  // 6 元 / 90 天的常驻付费，近 30 天截至上海 10-14 04:12：摊 29.175 天，正好 1.945 元
  const NOW = Date.UTC(2026, 9, 13, 20, 12);
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const startMs = Date.UTC(2026, 8, 14, 16); // 上海 09-15 00:00
  const purchases = [{ amount: 6, days: 90 }];
  const rt = { pool: { query: async () => [[]] }, store: { list: () => [{ id: "c", name: "半分", type: "newapi", fixedPurchases: purchases }] }, history: { predict: () => null } };
  const { GET } = await analyticsRoute();
  const body = await (await GET(new Request("https://local.test/api/analytics?days=30"), rt)).json();
  assert.equal(body.stations[0].fixedCny, amortizeFixedCost(purchases, { startMs, endMs: NOW, tz: "Asia/Shanghai" }).cny);
});

test("自定义范围传开始日期：天数按业务时区的今天算，超出范围的收窄到 1..365 天", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 14, 4, 0) }); // 上海 10-14 12:00
  const rt = { pool: { query: async () => [[]] }, store: { list: () => [] }, history: { predict: () => null } };
  const { GET } = await analyticsRoute();
  const get = async (q) => (await GET(new Request(`https://local.test/api/analytics?${q}`), rt)).json();
  const pick = ({ days, start, end }) => ({ days, start, end });
  assert.deepEqual(pick(await get("start=2026-10-08")), { days: 7, start: "2026-10-08", end: "2026-10-14" });
  assert.deepEqual(pick(await get("start=2026-10-14&days=30")), { days: 1, start: "2026-10-14", end: "2026-10-14" }, "start 优先于 days");
  assert.deepEqual(pick(await get("start=2026-10-15")), { days: 1, start: "2026-10-14", end: "2026-10-14" }, "晚于今天按只看今天");
  assert.equal((await get("start=2024-01-01")).days, 365);
  assert.equal((await get("start=2026-02-30&days=7")).days, 7, "不合法的日期忽略，回到 days");
});
