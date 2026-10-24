// 成本估算页的数据整理（app/(dashboard)/analytics/derive.ts）：日期写法、缺记录的说法、收入报错、汇率来源。
// node 直接跑 .ts（去掉类型），derive.ts 的导入都带 .js 后缀
import test from "node:test";
import assert from "node:assert/strict";
import { addDays, derive, deriveHeat, gapSummary, md, runsText } from "../app/(dashboard)/analytics/derive.ts";
import { dayKeyInTz } from "../lib/business-time.js";
import { EMPTY } from "../lib/format.js";

const TZ = "Asia/Shanghai";
// 「今年」按跑测试时的业务时区算，写日期时跟着当年走，跨年也不会失效
const year = Number(dayKeyInTz(Date.now(), TZ).slice(0, 4));
const day = (md_) => `${year}-${md_}`;

test("md: 接口给的日期今年写「10月9日」，往年带年份，空的写「—」", () => {
  assert.equal(md(day("10-09"), TZ), "10月9日");
  assert.equal(md(`${year - 1}-10-09`, TZ), `${year - 1}年10月9日`);
  assert.equal(md(null, TZ), EMPTY);
  assert.equal(md("", TZ), EMPTY);
});

test("runsText: 连续的日子合成一段，用短横线；超过 max 段写「等」", () => {
  assert.equal(runsText([day("10-01"), day("10-02"), day("10-03"), day("10-05")], TZ), "10月1日–10月3日、10月5日");
  assert.equal(runsText([day("10-01"), day("10-03"), day("10-05"), day("10-07")], TZ), "10月1日、10月3日、10月5日等");
  assert.equal(runsText([day("10-01"), day("10-03"), day("10-05"), day("10-07")], TZ, 6), "10月1日、10月3日、10月5日、10月7日");
  // 跨月也算连续
  assert.equal(runsText([day("09-30"), day("10-01")], TZ), "9月30日–10月1日");
  assert.equal(runsText([], TZ), "");
});

test("gapSummary: 点名前两个上游，其余合成「另有 N 个上游」；没名字的写「未命名上游」", () => {
  assert.equal(gapSummary([]), "");
  assert.equal(gapSummary([{ stationName: "A", missingDays: 3 }]), "A 缺 3 天");
  assert.equal(gapSummary([{ stationName: "A", missingDays: 3 }, { stationName: "", missingDays: 0 }, { stationName: "C", missingDays: 1 }]), "A 缺 3 天、未命名上游 有几段没有记录，另有 1 个上游");
});

// 3 天：up-a 每天都有记录，up-b 第 2 天缺，第 3 天谁都没有；up-c 按固定成本算；own 是自营站点不算成本
function analytics(overrides = {}) {
  const start = day("10-01"), end = day("10-03");
  return {
    days: 3, start, end, tz: TZ,
    stations: [
      { id: "up-a", name: "A", totalCny: 30, fixedCny: 0, cnyPerUsd: 7, runway: { etaDays: 2, burnPerDay: 1, basis: "近 3 小时" } },
      { id: "up-b", name: "", totalCny: 5, fixedCny: 0, cnyPerUsd: null, runway: { etaDays: 9, burnPerDay: 2, basis: null } },
      { id: "up-c", name: "C", costBasis: "fixed", fixedCny: 6, totalCny: 0 },
      { id: "own-1", name: "我的站点", isOwn: true, totalCny: 100, runway: { etaDays: 1, burnPerDay: 1 } },
    ],
    daily: [
      { stationId: "up-a", date: start, cny: 10 }, { stationId: "up-b", date: start, cny: 5 },
      { stationId: "up-a", date: addDays(start, 1), cny: 20 },
      // 自营站点和范围外的记录都不算
      { stationId: "own-1", date: start, cny: 99 }, { stationId: "up-a", date: addDays(start, -1), cny: 99 },
    ],
    fixedDaily: [start, addDays(start, 1), end].map((date) => ({ stationId: "up-c", date, cny: 2 })),
    coverage: { earliestDate: start, stationGaps: [{ stationId: "up-b", stationName: "", availableDays: 1, missingDays: 2 }, { stationId: "up-a", stationName: "A", availableDays: 2, missingDays: 1 }] },
    heatmap: [], heatmapAvailability: { available: true },
    ...overrides,
  };
}

test("derive: 缺记录的日子不补 0，部分上游缺的标成部分；固定成本计个数；名字走 stationDisplayName", () => {
  const dv = derive(analytics(), null);
  assert.equal(dv.tz, TZ);
  assert.deepEqual(dv.missingDates, [day("10-03")]);
  assert.deepEqual(dv.partialDates, [day("10-02")]);
  assert.deepEqual(dv.rows.map((r) => r.cost), [15, 20, null]);
  assert.equal(dv.rows[2].today, true);
  assert.equal(dv.usage, 35);
  assert.equal(dv.fixed, 6);
  assert.equal(dv.fixedCount, 1);
  assert.equal(dv.monitoredCount, 2);
  assert.equal(dv.usageApprox, true);
  // 只按有记录的两天算日均：(15 + 2 + 20 + 2) / 2
  assert.equal(dv.kpi.coveredDays, 2);
  assert.equal(dv.kpi.avg, 19.5);
  assert.equal(dv.kpi.peak.date, day("10-02"));
  // 成本构成和可用天数不含自营站点；没名字的上游写「未命名上游」，可用天数最紧的在前
  assert.deepEqual(dv.mix.map((m) => [m.name, m.usage + m.fixed]), [["A", 30], ["C", 6], ["未命名上游", 5]]);
  assert.deepEqual(dv.runway.map((r) => [r.name, r.days]), [["A", 2], ["未命名上游", 9]]);
  // 花费按各上游的汇率换成人民币，没设置汇率的按 1 比 1；写法和运营总览、上游列表一样带「≈」（burnCellText）
  assert.deepEqual(dv.runway.map((r) => r.burn), ["≈ ¥7.00", "≈ ¥2.00"]);
  assert.equal(dv.hasIncome, false);
  assert.equal(dv.incomeError, null);
  assert.equal(dv.ownNoRate, false);
});

test("derive: 一个上游都没有记录时，按用量计费的上游不算缺数据", () => {
  const dv = derive(analytics({ daily: [], coverage: { earliestDate: null, stationGaps: [] } }), null);
  assert.equal(dv.monitoredCount, 0);
  assert.deepEqual(dv.missingDates, []);
  assert.equal(dv.usageApprox, false);
});

const trend = (start, n, cost) => Array.from({ length: n }, (_, i) => ({ t: Date.parse(`${addDays(start, i)}T00:00:00+08:00`), cost }));

test("derive: 收入按每天消费分到天；没设置售价时 ownNoRate 只认 rateSnapshotOf 的 configured", () => {
  const data = analytics();
  // 自营收入取近 7 天：3 天范围是从中分出来的
  const own = { station: { id: "own-1", cnyPerUsd: 7.5 }, profit: { incomeCny: 7 * 7.5 * 10 }, trend: trend(addDays(data.start, -4), 7, 10), tz: TZ };
  const dv = derive(data, own);
  assert.equal(dv.hasIncome, true);
  assert.equal(dv.ownNoRate, false);
  assert.equal(dv.revenueSplit, true);
  assert.equal(dv.ownDays, 7);
  assert.equal(dv.revenue, 3 * 75);
  assert.equal(dv.revenueApprox, true);
  // cnyPerUsd 没设置：按 1 比 1，标成估算
  const unset = derive(data, { ...own, station: { id: "own-1", cnyPerUsd: null }, profit: { incomeCny: 70 } });
  assert.equal(unset.ownNoRate, true);
  assert.equal(unset.revenueApprox, true);
  // 设成 1 也是设置过的，不算没设置
  const parity = derive(data, { ...own, station: { id: "own-1", cnyPerUsd: 1 }, profit: { incomeCny: 70 } });
  assert.equal(parity.ownNoRate, false);
});

test("derive: 优先使用真实分日收入，含管理员自用的模型趋势不再改变收入形状", () => {
  const data = analytics();
  const own = { station: { cnyPerUsd: 7 }, tz: TZ, profit: { incomeCny: 70 },
    trend: [{ ...trend(data.start, 1, 100)[0] }, { ...trend(addDays(data.start, 1), 1, 10)[0] }],
    incomeDaily: [{ date: data.start, incomeCny: 0 }, { date: addDays(data.start, 1), incomeCny: 70 }, { date: data.end, incomeCny: 0 }],
    incomeDailyApprox: false };
  const dv = derive(data, own);
  assert.deepEqual(dv.rows.map((r) => r.rev), [0, 70, 0]);
  assert.equal(dv.revenue, 70);
  assert.equal(dv.revenueApprox, false);
  assert.equal(dv.revenueSplit, false, "真实分日收入截取日期不需要比例估算");
  assert.equal(dv.incomeEstimated, false);
});

test("derive: 旧接口完整七天也必须标估算，1 元分七天守恒为 1 元", () => {
  const data = analytics({ days: 7, end: day("10-07") });
  const own = { station: { cnyPerUsd: 1 }, tz: TZ, profit: { incomeCny: 1 }, trend: trend(data.start, 7, 1) };
  const dv = derive(data, own);
  assert.equal(dv.revenue, 1);
  assert.equal(dv.revenueSplit, false);
  assert.equal(dv.incomeEstimated, true);
  assert.equal(dv.revenueApprox, true);
  assert.equal(Math.round(dv.rows.reduce((sum, row) => sum + row.rev, 0) * 100), 100);
});

test("derive: 算收入时报错带上 code 和原文，页面按码归类；没有每天的记录时给一句原因", () => {
  const data = analytics();
  const failed = derive(data, { station: { id: "own-1" }, profit: { error: "HTTP 403 forbidden", errorCode: "UPSTREAM_AUTH_DENIED" }, trend: [] });
  assert.deepEqual(failed.incomeError, { code: "UPSTREAM_AUTH_DENIED", message: "HTTP 403 forbidden" });
  assert.equal(failed.hasIncome, false);
  assert.equal(failed.incomeIssue, null);
  const noTrend = derive(data, { station: { id: "own-1" }, profit: { incomeCny: 10 } });
  assert.equal(noTrend.incomeIssue, "自营站点没有给出每天的消费记录。");
  assert.equal(noTrend.incomeError, null);
  const zeroTrend = derive(data, { station: { id: "own-1" }, profit: { incomeCny: 10 }, trend: trend(data.start, 3, 0) });
  assert.equal(zeroTrend.incomeIssue, "有收入，但没有每天的消费记录，没法分到每天。");
  // 下游没有消费：收入就是 0，照常显示
  const none = derive(data, { station: { id: "own-1" }, profit: { incomeCny: 0 }, trend: trend(data.start, 3, 0) });
  assert.equal(none.hasIncome, true);
  assert.equal(none.revenue, 0);
});

test("deriveHeat: 超过 30 天不画；缺每小时记录时带上缺的上游", () => {
  assert.equal(deriveHeat({ days: 90 }).reason, "range-not-supported");
  const short = deriveHeat({ days: 30, heatmapAvailability: { available: false, reason: "incomplete-raw-history", coverage: { stationGaps: [{ stationId: "up-a", stationName: "A", missingDays: 2 }] } } });
  assert.equal(short.available, false);
  assert.equal(gapSummary(short.gaps), "A 缺 2 天");
  const ok = deriveHeat({ days: 7, heatmapAvailability: { available: true }, heatmap: [{ weekday: 0, hour: 9, cny: 1.234 }, { weekday: 9, hour: 9, cny: 5 }] });
  assert.equal(ok.grid[0][9], 1.23);
  assert.equal(ok.empty, false);
});
