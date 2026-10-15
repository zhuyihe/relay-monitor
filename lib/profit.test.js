import test from "node:test";
import assert from "node:assert/strict";
import { amortizeFixedCost, costBasisOf, rateSnapshotOf, splitByCumulative, summarizeProfit, toCny } from "./profit.js";
import { dayStartInTz } from "./business-time.js";

const SH = "Asia/Shanghai";
const DAY = 86400000;

test("固定成本按毫秒摊销：今天只摊到现在，不按整天", () => {
  const today = dayStartInTz("2026-10-14", SH);
  const purchases = [{ amount: 300, days: 30, startDate: "2026-10-01" }];
  // 今天 12:00：每天 ¥10，摊半天
  assert.equal(amortizeFixedCost(purchases, { startMs: today, endMs: today + DAY / 2, tz: SH }).cny, 5);
  // 整天
  assert.equal(amortizeFixedCost(purchases, { startMs: today, endMs: today + DAY, tz: SH }).cny, 10);
  // 按天切开再相加 = 整段一次算
  const start = dayStartInTz("2026-10-08", SH);
  const end = today + DAY / 4;
  let sum = 0;
  for (let t = start; t < end; t += DAY) sum += amortizeFixedCost(purchases, { startMs: t, endMs: Math.min(t + DAY, end), tz: SH }).cny;
  assert.equal(Math.round(sum * 100) / 100, amortizeFixedCost(purchases, { startMs: start, endMs: end, tz: SH }).cny);
});

test("固定成本只摊生效区间与窗口的重叠部分，并给出说明", () => {
  const start = dayStartInTz("2026-10-08", SH);
  const end = dayStartInTz("2026-10-15", SH);
  const later = amortizeFixedCost([{ amount: 70, days: 7, startDate: "2026-10-12" }], { startMs: start, endMs: end, tz: SH });
  assert.equal(later.cny, 30);
  assert.equal(later.note, "2026-10-12 起");
  const expired = amortizeFixedCost([{ amount: 70, days: 7, startDate: "2026-10-01" }], { startMs: start, endMs: end, tz: SH });
  assert.equal(expired.cny, 0);
  assert.equal(expired.note, "已到期");
  const mixed = amortizeFixedCost([
    { amount: 70, days: 7, startDate: "2026-10-01" },
    { amount: 70, days: 7, startDate: "2026-10-10" },
  ], { startMs: start, endMs: end, tz: SH });
  assert.equal(mixed.note, "1/2 笔生效中");
  assert.equal(mixed.cny, 50);
});

test("没填开始日期的固定成本整段窗口都摊；非法记录跳过", () => {
  const start = dayStartInTz("2026-10-08", SH);
  const res = amortizeFixedCost([
    { amount: 300, days: 30 },
    { amount: 100, days: 0 },
    { amount: "abc", days: 10 },
  ], { startMs: start, endMs: start + 3 * DAY, tz: SH });
  assert.equal(res.cny, 30);
  assert.equal(res.total, 1);
  assert.equal(res.active, 1);
  assert.equal(res.note, null);
});

test("配置了固定付费的上游只按摊销计成本", () => {
  assert.equal(costBasisOf({ type: "newapi" }), "usage");
  assert.equal(costBasisOf({ type: "newapi", fixedPurchases: [{ amount: 1, days: 1 }] }), "fixed");
  assert.equal(costBasisOf({ type: "fixed" }), "fixed");
});

test("汇率快照：未配置按 1:1 并标明默认值", () => {
  assert.deepEqual(rateSnapshotOf({ cnyPerUsd: 7.2 }), { cnyPerUsd: 7.2, source: "configured" });
  assert.deepEqual(rateSnapshotOf({ cnyPerUsd: 0 }), { cnyPerUsd: 1, source: "default" });
  assert.deepEqual(rateSnapshotOf({}), { cnyPerUsd: 1, source: "default" });
  assert.equal(toCny(1.234, { cnyPerUsd: 7 }), 8.64);
  assert.equal(toCny(2, 7.1), 14.2);
});

test("毛利 = 收入 − 上游成本；净利 = 毛利 − 固定成本", () => {
  assert.deepEqual(summarizeProfit({ incomeCny: 100, upstreamCostCny: 60, fixedCostCny: 15 }), {
    grossProfitCny: 40, netProfitCny: 25, grossMarginPct: 40, netMarginPct: 25,
  });
  assert.deepEqual(summarizeProfit({ incomeCny: 0, upstreamCostCny: 5, fixedCostCny: 1 }), {
    grossProfitCny: -5, netProfitCny: -6, grossMarginPct: null, netMarginPct: null,
  });
  // 两位小数相减不出现浮点尾差
  assert.equal(summarizeProfit({ incomeCny: 0.3, upstreamCostCny: 0.1, fixedCostCny: 0.1 }).netProfitCny, 0.1);
});

test("合计按累计占比摊回逐日：各项之和正好等于合计", () => {
  const cents = (list) => Math.round(list.reduce((a, v) => a + v, 0) * 100);
  // 100 元 / 30 天，摊 30 天：逐日 3.33 相加是 99.90，按累计分配后正好 100
  const even = splitByCumulative(Array(30).fill(100 / 30), 100);
  assert.equal(cents(even), 10000);
  assert.ok(even.every((v) => v === 3.33 || v === 3.34), "每天与 3.33 最多差 1 分");
  // 1 元 / 365 天，摊 7 天：逐日都舍成 0 时合计会丢光，这里仍然有 2 分落在某几天
  const tiny = splitByCumulative(Array(7).fill(1 / 365), 0.02);
  assert.equal(cents(tiny), 2);
  assert.deepEqual(tiny.filter((v) => v > 0), [0.01, 0.01]);
  // 尾部是 0 的日子不分到钱；权重全为 0 时都是 0
  assert.deepEqual(splitByCumulative([1, 1, 0], 0.03), [0.02, 0.01, 0]);
  assert.deepEqual(splitByCumulative([0, 0], 5), [0, 0]);
  assert.deepEqual(splitByCumulative([], 5), []);
});
