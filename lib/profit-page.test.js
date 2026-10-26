import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_COST_NOT_RECORDED, PROFIT_DAILY_MAX_DAYS, buildProfitPage, dayLabelsOf } from "./profit-page.js";

const TZ = "Asia/Shanghai";
const D = (label) => Date.parse(`${label}T16:00:00Z`) - 86400000 + 86400000; // 上海这天 0 点 = 前一天 16:00Z
const dayStart = (label) => { const [y, m, d] = label.split("-").map(Number); return Date.UTC(y, m - 1, d) - 8 * 3600000; };
const NOW = dayStart("2026-10-26") + 14.5 * 3600000; // 10-26 14:30 上海
const win = (from, to, preset) => ({ preset, startMs: dayStart(from), endMs: dayStart(to), timezone: TZ });

function resultOf({ id, upstreamStationId = "up", tokenId = 7, tokenName = "k", channels = [1], window, income = 10, cost = 6, profit = 4, group = "vip", ratio = 0.8,
  attention = false, settledAt = null, effectiveFrom = null }) {
  const rule = { id, upstreamStationId, ownStationId: "own", tokenId, tokenName, fixedGroup: group, timezone: TZ, billingPolicy: "next-complete-day", costCoverage: "complete",
    billingEffectiveFrom: effectiveFrom, channels: channels.map((channelId) => ({ channelId, name: `渠道 ${channelId}` })) };
  return { rule, window, requestedWindow: window, calculationVersion: 3, settledAt,
    downstream: { state: "complete", amountUsd: income, knownAmountUsd: income, window, channels: channels.map((channelId) => ({ channelId, amountUsd: income / channels.length })) },
    upstream: { state: "complete", amountUsd: cost, knownAmountUsd: cost, countedAmountUsd: cost, window, group, ratio, ownershipState: "unique" },
    calculation: { profitUsd: profit }, rates: { costBasis: "usage" }, health: { code: "READY", issues: [] }, billingTimezone: { state: "verified" },
    displayStatus: attention ? { state: "action", title: "自营站点这天的收费记录读不到", detail: "系统会再读", action: { id: "a", kind: "retry_bill" }, moreCount: 1, code: "OWN_BILLING_UNAVAILABLE" }
      : { state: settledAt ? "settled" : "live" } };
}
const fact = (ruleId, billDate, { cost = 6, expected = 5, reason = null, tokens = 1000, settledAt = "2026-10-26T00:20:00.000Z" } = {}) =>
  ({ ruleId, billDate, revision: 1, settledAt, revenueUsd: 10, costUsd: cost, costBasis: "usage", expectedCostUsd: expected, gapReason: reason, tokens });
const stationOf = (id) => ({ up: { id: "up", name: "拼车团队", type: "newapi" }, up2: { id: "up2", name: "备用", type: "newapi" } })[id] || null;

test("范围里的日子：按业务时区从起点数到终点或今天", () => {
  assert.deepEqual(dayLabelsOf(win("2026-10-20", "2026-10-27", "7d"), TZ, NOW), ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.deepEqual(dayLabelsOf(win("2026-10-25", "2026-10-26", "yesterday"), TZ, NOW), ["2026-10-25"]);
});

test("看昨天（全固定）：同一把 Key 的两条绑定合成一行、金额相加；差额按行按天判；对不上多扣的排最前；算不出的给原因；整页数按渠道数", () => {
  const window = win("2026-10-25", "2026-10-26", "yesterday"), settledAt = "2026-10-26T00:20:00.000Z";
  const results = [
    resultOf({ id: "a", channels: [1], window, income: 10, cost: 6, profit: 4, settledAt }),
    resultOf({ id: "b", channels: [2], window, income: 5, cost: 3.2, profit: 1.8, settledAt }),
    resultOf({ id: "c", upstreamStationId: "up2", tokenId: 9, tokenName: "k2", channels: [3], window, income: 20, cost: 8, profit: 12, settledAt }),
    resultOf({ id: "d", upstreamStationId: "up2", tokenId: 10, tokenName: "k3", channels: [4, 5], window, income: 7, cost: 1, profit: 6, settledAt, attention: true }),
  ];
  // a 多扣 1（应付 5 实付 6，20%）；b 门槛以内；c 读不到价目表；d 需处理（账本里也没它这天的行）
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [fact("a", "2026-10-25", { cost: 6, expected: 5, tokens: 1000 }), fact("b", "2026-10-25", { cost: 3.2, expected: 3.19, tokens: 500 }),
    fact("c", "2026-10-25", { cost: 8, expected: null, reason: "MODEL_PRICE_UNREADABLE", tokens: null })] });
  assert.deepEqual(page.dayCounts, { fixed: 1, reading: 0, today: 0 });
  assert.deepEqual(page.rows.map((row) => row.rowKey), ["up:7", "up2:10", "up2:9"], "多扣的在前、需处理第二、其余按毛利");
  const [merged, attention, unreadable] = page.rows;
  assert.deepEqual(merged.channels.map((channel) => channel.channelId), [1, 2]);
  assert.deepEqual([merged.key.name, merged.key.groupName, merged.key.groupRatio, merged.key.upstreamKeyUrl, merged.upstream.name], ["k", "vip", 0.8, null, "拼车团队"]);
  assert.deepEqual([merged.incomeUsd, merged.actualCostUsd, merged.grossProfitUsd, merged.expectedCostUsd], [15, 9.2, 5.8, 8.19]);
  assert.deepEqual([merged.gap.state, merged.gap.usd.toFixed(2), merged.gap.rate.toFixed(4), merged.gap.days, merged.gap.mismatchedDays.map((item) => [item.day, item.usd.toFixed(2), item.state])], ["over", "1.01", "0.1233", 1, [["2026-10-25", "1.01", "over"]]]);
  assert.deepEqual(merged.daily.map((day) => day.day).slice(-2), ["2026-10-24", "2026-10-25"], "看一天给近 7 天，到那天为止");
  assert.equal(merged.daily.length, 7);
  assert.deepEqual({ ...merged.daily.at(-1), gapUsd: merged.daily.at(-1).gapUsd.toFixed(2) }, { day: "2026-10-25", state: "fixed", gapUsd: "1.01", gapState: "over", reason: null, tokens: 1500 });
  assert.equal(merged.daily.at(-2).state, "reading", "前一天没有账本行：还在读取");
  assert.deepEqual([unreadable.gap.state, unreadable.gap.reason, unreadable.gap.usd, unreadable.expectedCostUsd], ["uncomputable", "MODEL_PRICE_UNREADABLE", null, null]);
  assert.deepEqual([attention.attention.code, attention.attention.moreCount, attention.counted, attention.incomeUsd, attention.uncountedIncomeUsd, attention.excludedDays, attention.gap.state], ["OWN_BILLING_UNAVAILABLE", 1, false, null, 7, 1, "attention"]);
  assert.deepEqual(page.pageTotals, { incomeUsd: 35, actualCostUsd: 17.2, grossProfitUsd: 17.8, grossMarginRate: 17.8 / 35 }, "只加算进来的三行");
  // 合用一把 Key 的两条绑定这一天合成一行再判：6+3.2 对 5+3.19，多扣 1.01（不是分开判成 1.00 多扣、0.01 门槛以内）
  assert.deepEqual([page.gap.usd.toFixed(2), page.gap.overUsd.toFixed(2), page.gap.underUsd, page.gap.withinUsd, page.gap.rowCount, page.gap.days], ["1.01", "1.01", 0, 0, 1, { first: "2026-10-25", last: "2026-10-25", count: 1, contiguous: true }]);
  assert.deepEqual(page.counts, { channels: 5, countedChannels: 3, mismatchedChannels: 2, attentionChannels: 2, uncomputable: { MODEL_PRICE_UNREADABLE: 1 }, mismatchedDays: { over: 1, under: 0 } });
  assert.deepEqual(page.gapThreshold, { usd: 0.05, rate: 0.02 });
});

test("看今天：差额「明天出」、不给应付成本；最近一个已固定的日子给 latestSettledGap；V1-b 以前固定的日子原因是 EXPECTED_COST_NOT_RECORDED", () => {
  const window = { preset: "today", startMs: dayStart("2026-10-26"), endMs: NOW, timezone: TZ };
  const results = [resultOf({ id: "a", window }), resultOf({ id: "c", upstreamStationId: "up2", tokenId: 9, channels: [3], window })];
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [fact("a", "2026-10-25", { cost: 7, expected: 5 }), fact("a", "2026-10-24", { cost: 5, expected: 5 }),
    fact("c", "2026-10-25", { cost: 2, expected: null, reason: null })] });
  assert.deepEqual(page.dayCounts, { fixed: 0, reading: 0, today: 1 });
  const a = page.rows.find((row) => row.rowKey === "up:7"), c = page.rows.find((row) => row.rowKey === "up2:9");
  assert.deepEqual([a.gap.state, a.gap.usd, a.expectedCostUsd, a.daily.length, a.daily[0].state], ["today", null, null, 1, "today"]);
  assert.deepEqual(a.latestSettledGap, { day: "2026-10-25", usd: 2, state: "over", reason: null });
  assert.deepEqual(c.latestSettledGap, { day: "2026-10-25", usd: null, state: null, reason: EXPECTED_COST_NOT_RECORDED });
  assert.deepEqual(page.latestSettledGap, { day: "2026-10-25", usd: 2, mismatchedRowCount: 1 });
  assert.equal(page.gap.rowCount, 0, "今天没有已固定的差额");
});

test("近 7 天含今天：已固定 / 今天各几天；差额只加已固定的日子；范围中间开始算的行写 startedOn、小格 notStarted；多天小格最多 31 个", () => {
  const window = { preset: "7d", startMs: dayStart("2026-10-20"), endMs: NOW, timezone: TZ };
  const started = dayStart("2026-10-24");
  const results = [resultOf({ id: "a", window, income: 70, cost: 42, profit: 28 }), resultOf({ id: "e", upstreamStationId: "up2", tokenId: 11, channels: [6], window, effectiveFrom: started, income: 9, cost: 6, profit: 3 })];
  const facts = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"].map((day) => fact("a", day, { cost: day === "2026-10-22" ? 4 : 6, expected: 5 }));
  facts.push(fact("e", "2026-10-24", { cost: 6, expected: 6 }), fact("e", "2026-10-25", { cost: 6, expected: 6 }));
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: facts });
  assert.deepEqual(page.dayCounts, { fixed: 6, reading: 0, today: 1 });
  const a = page.rows.find((row) => row.rowKey === "up:7"), e = page.rows.find((row) => row.rowKey === "up2:11");
  assert.equal(a.expectedCostUsd, null, "范围里有今天：不给应付成本");
  assert.deepEqual([a.gap.state, a.gap.days, a.gap.usd, a.gap.mismatchedDays.map((item) => [item.day, item.state])], ["over", 6, 4, [["2026-10-20", "over"], ["2026-10-21", "over"], ["2026-10-22", "under"], ["2026-10-23", "over"], ["2026-10-24", "over"], ["2026-10-25", "over"]]]);
  assert.deepEqual([e.startedOn, e.startedAt, e.gap.state, e.gap.days], ["2026-10-24", null, "within", 2]);
  assert.deepEqual(e.daily.map((day) => day.state), ["notStarted", "notStarted", "notStarted", "notStarted", "fixed", "fixed", "today"]);
  assert.deepEqual(page.gap.days, { first: "2026-10-20", last: "2026-10-25", count: 6, contiguous: true });
  assert.deepEqual([page.gap.overUsd, page.gap.underUsd, page.gap.withinUsd, page.gap.rowCount, page.counts.mismatchedDays], [5, -1, 0, 2, { over: 5, under: 1 }]);
  assert.equal(page.pageTotals.incomeUsd, 79, "收入是整段（含今天）");
  // 自定义 40 天：小格只给最后 31 天
  const long = { preset: "custom", startMs: dayStart("2026-09-17"), endMs: NOW, timezone: TZ };
  const longPage = buildProfitPage({ results: [resultOf({ id: "a", window: long })], window: long, now: NOW, stationOf, dayFacts: [] });
  assert.equal(longPage.rows[0].daily.length, PROFIT_DAILY_MAX_DAYS);
  assert.equal(longPage.rows[0].daily.at(-1).day, "2026-10-26");
  assert.deepEqual(longPage.dayCounts, { fixed: 0, reading: 39, today: 1 }, "没有账本行的过去日子都算还在读取");
});
