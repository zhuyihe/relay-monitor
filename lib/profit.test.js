import test from "node:test";
import assert from "node:assert/strict";
import { amortizeFixedCost, balanceMoneyOf, costBasisOf, countsInProfit, fixedCostNowOf, isConfiguredRate, isLoss, profitApproxOf, rateSnapshotOf, ratesFor, splitByCumulative, splitProfitWarnings, summarizeProfit, toCny } from "./profit.js";
import { dayStartInTz } from "./business-time.js";
import { RATE_UNSET_PARITY } from "./format.js";

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
  assert.equal(later.note, "10月12日起");
  assert.deepEqual([later.active, later.upcoming, later.expired, later.total], [1, 0, 0, 1]);
  const expired = amortizeFixedCost([{ amount: 70, days: 7, startDate: "2026-10-01" }], { startMs: start, endMs: end, tz: SH });
  assert.equal(expired.cny, 0);
  assert.equal(expired.note, "已到期");
  assert.deepEqual([expired.active, expired.upcoming, expired.expired, expired.total], [0, 0, 1, 1]);
  const mixed = amortizeFixedCost([
    { amount: 70, days: 7, startDate: "2026-10-01" },
    { amount: 70, days: 7, startDate: "2026-10-10" },
  ], { startMs: start, endMs: end, tz: SH });
  assert.equal(mixed.note, "1 笔在用，1 笔已到期");
  assert.equal(mixed.cny, 50);
});

test("固定成本的笔数句：只写不为 0 的，全部到期写已到期，还没开始的单笔写开始日期", () => {
  const start = dayStartInTz("2026-10-08", SH);
  const end = dayStartInTz("2026-10-15", SH);
  const opts = { startMs: start, endMs: end, tz: SH };
  const three = amortizeFixedCost([
    { amount: 70, days: 7, startDate: "2026-10-01" },
    { amount: 70, days: 7, startDate: "2026-10-10" },
    { amount: 70, days: 7, startDate: "2026-10-20" },
    { amount: 300, days: 30 },
  ], opts);
  assert.equal(three.note, "2 笔在用，1 笔还没开始，1 笔已到期");
  assert.deepEqual([three.active, three.upcoming, three.expired, three.total], [2, 1, 1, 4]);
  // 窗口结束那一刻才开始的，算还没开始
  const atEnd = amortizeFixedCost([{ amount: 70, days: 7, startDate: "2026-10-15" }], opts);
  assert.equal(atEnd.note, "10月15日起");
  assert.deepEqual([atEnd.active, atEnd.upcoming, atEnd.cny], [0, 1, 0]);
  const allExpired = amortizeFixedCost([
    { amount: 70, days: 7, startDate: "2026-09-01" },
    { amount: 70, days: 7, startDate: "2026-10-01" },
  ], opts);
  assert.equal(allExpired.note, "已到期");
  // 往年的开始日期带年份（§6）
  const lastYear = amortizeFixedCost([{ amount: 3650, days: 3650, startDate: "2025-10-12" }], {
    startMs: dayStartInTz("2025-10-01", SH), endMs: end, tz: SH,
  });
  assert.equal(lastYear.note, "2025年10月12日起");
  // 单笔、在窗口开始前就在用的不写
  assert.equal(amortizeFixedCost([{ amount: 300, days: 30, startDate: "2026-10-01" }], opts).note, null);
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
  assert.equal(res.upcoming, 0);
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
  assert.equal(toCny(2, rateSnapshotOf({ cnyPerUsd: 7.1 })), 14.2);
  assert.equal(toCny("x", rateSnapshotOf({ cnyPerUsd: 7.1 })), 0);
});

test("设没设汇率只有一个判断：rateSnapshotOf 标成 configured 而且是正数", () => {
  for (const value of [7.2, "7.2", 0.5]) assert.equal(isConfiguredRate(rateSnapshotOf({ cnyPerUsd: value })), true, String(value));
  for (const value of [null, undefined, "", 0, -1, "abc"]) assert.equal(isConfiguredRate(rateSnapshotOf({ cnyPerUsd: value })), false, String(value));
  assert.equal(isConfiguredRate({ cnyPerUsd: "7.200000", source: "configured" }), true, "账本 DECIMAL 读出的字符串");
  assert.equal(isConfiguredRate({ cnyPerUsd: 0, source: "configured" }), false);
  assert.equal(isConfiguredRate({ cnyPerUsd: 7.2, source: "default" }), false);
  assert.equal(isConfiguredRate(null), false);
});

test("一条绑定的汇率：账本存了用存的，没存的按现在的设置；成本计法依次取账本、结果、现在的设置", () => {
  const own = { id: "own", cnyPerUsd: 7.3 }, upstream = { id: "up", cnyPerUsd: 7.1, fixedPurchases: [] };
  assert.deepEqual(ratesFor({ own, upstream }), { income: { cnyPerUsd: 7.3, source: "configured" }, cost: { cnyPerUsd: 7.1, source: "configured" }, costBasis: "usage" });
  const saved = { rates: { income: 7, cost: null }, costBasis: "fixed" };
  assert.deepEqual(ratesFor({ own, upstream, saved, costBasis: "usage" }),
    { income: { cnyPerUsd: 7, source: "configured" }, cost: { cnyPerUsd: 7.1, source: "configured" }, costBasis: "fixed" });
  assert.deepEqual(ratesFor({ own: null, upstream: null, saved: { rates: { income: null, cost: null }, costBasis: null }, costBasis: "fixed" }),
    { income: { cnyPerUsd: 1, source: "default" }, cost: { cnyPerUsd: 1, source: "default" }, costBasis: "fixed" }, "站点删了、账本没存汇率");
  assert.equal(ratesFor({ own, upstream: { type: "fixed" } }).costBasis, "fixed");
  assert.equal(ratesFor({ own, upstream: null }).costBasis, "usage");
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

test("利润提示按码分成原因和说明，不看文字", () => {
  const profit = {
    warnings: ["2 个在用的渠道没对上上游；已添加的上游照常算成本", "1 个上游按余额变化估算", "自营 没设置售价，暂按 1 美元额度 = 1 元算", "A 没设置汇率，暂按 1 美元 = 1 元算。", "B 不算进利润"],
    warningCodes: ["unmatched_channels", "estimated_cost", "sell_price_unset", "rate_unset", "excluded_upstreams"],
  };
  assert.deepEqual(splitProfitWarnings(profit), {
    reasons: ["1 个上游按余额变化估算。", "自营 没设置售价，暂按 1 美元额度 = 1 元算。", "A 没设置汇率，暂按 1 美元 = 1 元算。"],
    notes: ["2 个在用的渠道没对上上游；已添加的上游照常算成本。", "B 不算进利润。"],
  });
  // 文字里带「估算」但码是说明，照样算说明；没有码的都算说明
  assert.deepEqual(splitProfitWarnings({ warnings: ["按余额变化估算"], warningCodes: ["unmatched_channels"] }), { reasons: [], notes: ["按余额变化估算。"] });
  assert.deepEqual(splitProfitWarnings({ warnings: ["x"] }), { reasons: [], notes: ["x。"] });
  assert.deepEqual(splitProfitWarnings(null), { reasons: [], notes: [] });
});

test("balanceMoneyOf: 设置了汇率写美元和约多少人民币，没设置按 1 美元 = 1 元写人民币", () => {
  assert.deepEqual(balanceMoneyOf({ cnyPerUsd: 7.2 }, 12.3), {
    text: "$12.30", cny: "约 ¥88.56", full: "$12.30（约 ¥88.56）", note: "按 1 美元 = 7.20 元换算",
  });
  assert.deepEqual(balanceMoneyOf({}, 12.3), { text: "¥12.30", cny: null, full: "¥12.30（没设置汇率）", note: RATE_UNSET_PARITY });
  // 汇率填了 0 或负数，和没设置一样
  assert.equal(balanceMoneyOf({ cnyPerUsd: 0 }, 12.3).cny, null);
  assert.equal(balanceMoneyOf({ cnyPerUsd: 7.2 }, -1.5).full, "−$1.50（约 −¥10.80）");
});

test("fixedCostNowOf: 笔数和 amortizeFixedCost 同一口径；每天合计和最近到期只算在用的", () => {
  const now = dayStartInTz("2026-10-14", SH) + DAY / 2;
  const purchases = [
    { amount: 300, days: 30, startDate: "2026-10-01" }, // 在用，10 月 31 日到期
    { amount: 70, days: 7 }, // 没填开始日期，一直算在用，没有到期日
    { amount: 100, days: 5, startDate: "2026-09-01" }, // 已到期
    { amount: 50, days: 10, startDate: "2026-10-20" }, // 还没开始
    { amount: -1, days: 5 }, { amount: 10, days: 0 }, // 算不了，不计
  ];
  const got = fixedCostNowOf(purchases, { now, tz: SH });
  const counts = amortizeFixedCost(purchases, { startMs: now, endMs: now, tz: SH });
  assert.deepEqual(got, {
    active: 2, expired: 1, upcoming: 1, total: 4, note: counts.note,
    daily: 20, nextEnd: dayStartInTz("2026-10-31", SH),
  });
  assert.deepEqual(fixedCostNowOf([], { now, tz: SH }), { active: 0, expired: 0, upcoming: 0, total: 0, note: amortizeFixedCost([], { startMs: now, endMs: now, tz: SH }).note, daily: 0, nextEnd: null });
  // 到期那一刻起不再算在用
  const end = dayStartInTz("2026-10-31", SH);
  assert.equal(fixedCostNowOf([purchases[0]], { now: end, tz: SH }).daily, 0);
  assert.equal(fixedCostNowOf([purchases[0]], { now: end - 1, tz: SH }).daily, 10);
});

test("countsInProfit: 自营站点和关掉「算进利润」的不算，没填的按算进", () => {
  assert.equal(countsInProfit({ id: "a" }), true);
  assert.equal(countsInProfit({ id: "a", includeInProfit: true }), true);
  assert.equal(countsInProfit({ id: "a", includeInProfit: false }), false);
  assert.equal(countsInProfit({ id: "own", isOwn: true, includeInProfit: true }), false);
  assert.equal(countsInProfit(null), false);
});

test("isLoss：小于 0 而且舍到分以后不是 0 才算亏损", () => {
  assert.equal(isLoss(-30), true);
  assert.equal(isLoss(-0.005), true);
  assert.equal(isLoss(-0.004), false, "写出来是 ¥0.00，不标亏损");
  assert.equal(isLoss(0), false);
  assert.equal(isLoss(12), false);
  assert.equal(isLoss(null), false);
});

test("profitApproxOf：没设置售价时收入是估算的；按余额变化估算、没设置汇率时上游成本是估算的；毛利、净利还看说明里的原因", () => {
  const own = { cnyPerUsd: 7.5 };
  assert.deepEqual(profitApproxOf({ warnings: [], warningCodes: [] }, own), { income: false, upstream: false, result: false });
  assert.deepEqual(profitApproxOf({ warnings: [], warningCodes: [] }, { cnyPerUsd: null }), { income: true, upstream: false, result: true });
  assert.deepEqual(profitApproxOf({ estimated: true }, own), { income: false, upstream: true, result: true });
  assert.deepEqual(profitApproxOf({ rateUnsetStations: [{ id: "a" }] }, own), { income: false, upstream: true, result: true });
  // 只有说明、没有影响准不准的：不是估算
  assert.deepEqual(profitApproxOf({ warnings: ["A 不算进利润"], warningCodes: ["excluded_upstreams"] }, own), { income: false, upstream: false, result: false });
  // 读不到时（{ error, errorCode }）也不出错
  assert.deepEqual(profitApproxOf({ error: "x", errorCode: "NOT_READY" }, own), { income: false, upstream: false, result: false });
});
