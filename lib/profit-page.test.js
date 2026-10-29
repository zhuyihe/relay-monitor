import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_COST_NOT_RECORDED, FIXED_COST_UPSTREAM, PROFIT_DAILY_MAX_DAYS, buildProfitDetail, buildProfitPage, dayLabelsOf, fixedCostOfRange } from "./profit-page.js";

const TZ = "Asia/Shanghai";
const D = (label) => Date.parse(`${label}T16:00:00Z`) - 86400000 + 86400000; // 上海这天 0 点 = 前一天 16:00Z
const dayStart = (label) => { const [y, m, d] = label.split("-").map(Number); return Date.UTC(y, m - 1, d) - 8 * 3600000; };
const NOW = dayStart("2026-10-26") + 14.5 * 3600000; // 10-26 14:30 上海
const win = (from, to, preset) => ({ preset, startMs: dayStart(from), endMs: dayStart(to), timezone: TZ });

function resultOf({ id, upstreamStationId = "up", tokenId = 7, tokenName = "k", channels = [1], window, income = 10, cost = 6, profit = 4, group = "vip", ratio = 0.8,
  attention = false, settledAt = null, effectiveFrom = null, costBasis = "usage", shrunk = null }) {
  const rule = { id, upstreamStationId, ownStationId: "own", tokenId, tokenName, fixedGroup: group, timezone: TZ, billingPolicy: "next-complete-day", costCoverage: "complete",
    billingEffectiveFrom: effectiveFrom, channels: channels.map((channelId) => ({ channelId, name: `渠道 ${channelId}` })) };
  return { rule, window, requestedWindow: window, calculationVersion: 3, settledAt,
    downstream: { state: "complete", amountUsd: income, knownAmountUsd: income, window, channels: channels.map((channelId) => ({ channelId, amountUsd: income / channels.length })) },
    upstream: { state: "complete", amountUsd: cost, knownAmountUsd: cost, countedAmountUsd: costBasis === "fixed" ? 0 : cost, window, group, ratio, ownershipState: "unique" },
    calculation: { profitUsd: profit }, rates: { costBasis }, health: { code: "READY", issues: [] }, billingTimezone: { state: "verified" },
    displayStatus: shrunk ? { state: "action", title: "这天重算的数比原来少了一半多", detail: "系统没有自动换掉", action: { id: "a", kind: "retry_bill", code: "RESETTLE_SHRUNK" }, moreCount: 0, code: "RESETTLE_SHRUNK", shrunk }
      : attention ? { state: "action", title: "自营站点这天的收费记录读不到", detail: "系统会再读", action: { id: "a", kind: "retry_bill" }, moreCount: 1, code: "OWN_BILLING_UNAVAILABLE" }
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
  assert.deepEqual(merged.rates, { income: null, cost: null, costBasis: "usage" }, "换算用的汇率（夹具没设）");
  assert.deepEqual([merged.incomeUsd, merged.actualCostUsd, merged.grossProfitUsd, merged.expectedCostUsd], [15, 9.2, 5.8, 8.19]);
  assert.deepEqual([merged.gap.state, merged.gap.usd.toFixed(2), merged.gap.rate.toFixed(4), merged.gap.days, merged.gap.mismatchedDays.map((item) => [item.day, item.usd.toFixed(2), item.state])], ["over", "1.01", "0.1233", 1, [["2026-10-25", "1.01", "over"]]]);
  assert.deepEqual(merged.daily.map((day) => day.day).slice(-2), ["2026-10-24", "2026-10-25"], "看一天给近 7 天，到那天为止");
  assert.equal(merged.daily.length, 7);
  assert.deepEqual({ ...merged.daily.at(-1), gapUsd: merged.daily.at(-1).gapUsd.toFixed(2) }, { day: "2026-10-25", state: "fixed", gapUsd: "1.01", gapState: "over", reason: null, tokens: 1500, incomeUsd: 20, actualCostUsd: 9.2, grossUsd: 10.8 });
  assert.equal(merged.daily.at(-2).state, "reading", "前一天没有账本行：还在读取");
  assert.deepEqual([unreadable.gap.state, unreadable.gap.reason, unreadable.gap.usd, unreadable.expectedCostUsd], ["none", "MODEL_PRICE_UNREADABLE", null, null]);
  assert.deepEqual([attention.attention.code, attention.attention.moreCount, attention.counted, attention.incomeUsd, attention.uncountedIncomeUsd, attention.excludedDays, attention.gap.state], ["OWN_BILLING_UNAVAILABLE", 1, false, null, 7, 1, "reading"], "需处理只在 attention 字段，gap.state 还是看有没有账本行");
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
  assert.deepEqual([a.gap.state, a.gap.usd, a.expectedCostUsd, a.daily.length, a.daily.at(-1).state, a.daily.at(-2).state, a.daily.at(-2).gapUsd, a.daily[0].state], ["today", null, null, 7, "today", "fixed", 2, "reading"], "看今天也给近 7 天：前 6 天 + 今天");
  // 每天的收入、上游成本、毛利：已固定的取账本，今天取这一行整段的数（范围里只有今天时就是整段）
  assert.deepEqual(a.daily.slice(-3).map((day) => [day.day, day.incomeUsd, day.actualCostUsd, day.grossUsd]), [["2026-10-24", 10, 5, 5], ["2026-10-25", 10, 7, 3], ["2026-10-26", 10, 6, 4]]);
  assert.deepEqual(a.daily[0].incomeUsd, null, "还在读取的天没有数");
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
  assert.deepEqual([page.gap.overUsd, page.gap.underUsd, page.gap.withinUsd, page.gap.rowCount, page.counts.mismatchedDays], [5, 1, 0, 2, { over: 5, under: 1 }], "underUsd 是正数");
  assert.equal(page.pageTotals.incomeUsd, 79, "收入是整段（含今天）");
  // 自定义 40 天：小格只给最后 31 天
  const long = { preset: "custom", startMs: dayStart("2026-09-17"), endMs: NOW, timezone: TZ };
  const longPage = buildProfitPage({ results: [resultOf({ id: "a", window: long })], window: long, now: NOW, stationOf, dayFacts: [] });
  assert.equal(longPage.rows[0].daily.length, PROFIT_DAILY_MAX_DAYS);
  assert.equal(longPage.rows[0].daily.at(-1).day, "2026-10-26");
  assert.deepEqual(longPage.dayCounts, { fixed: 0, reading: 39, today: 1 }, "没有账本行的过去日子都算还在读取");
});

test("合用一把 Key 的两条绑定，一天只有一条写了账本：这天不算已固定（审核 #126 M1）", () => {
  const window = win("2026-10-20", "2026-10-26", "7d");
  const results = [resultOf({ id: "a", channels: [1], window, income: 10, cost: 6, profit: 4 }), resultOf({ id: "b", channels: [2], window, income: 5, cost: 3, profit: 2 })];
  // 2026-10-25 两条都写了账本；2026-10-24 只有 a 写了（b 还在读取）
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [fact("a", "2026-10-24", { cost: 6, expected: 5 }), fact("a", "2026-10-25", { cost: 6, expected: 6 }), fact("b", "2026-10-25", { cost: 3, expected: 3 })] });
  const row = page.rows.find((item) => item.rowKey === "up:7");
  assert.deepEqual(row.gap.days, 1, "只有 2026-10-25 两条都齐，算已固定；2026-10-24 不算");
  assert.deepEqual(row.gap.mismatchedDays.map((item) => item.day), [], "10-25 门槛以内，10-24 不进差额（还在读取）");
  assert.equal(row.daily.find((item) => item.day === "2026-10-24").state, "reading", "一条没写账本，这天还不算 fixed");
});

test("固定成本的上游不比差额：state 是 none + FIXED_COST_UPSTREAM，不进「对不上」也不进「算不了差额」；明细实付记 0", () => {
  const window = win("2026-10-25", "2026-10-26", "yesterday"), settledAt = "2026-10-26T00:20:00.000Z";
  const results = [resultOf({ id: "f", upstreamStationId: "up2", tokenId: 20, channels: [9], window, income: 10, cost: 0, profit: 10, settledAt, costBasis: "fixed" })];
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [fact("f", "2026-10-25", { cost: 0, expected: 5, tokens: 100 })] });
  const row = page.rows.find((item) => item.rowKey === "up2:20");
  assert.deepEqual([row.gap.state, row.gap.reason, row.gap.usd, row.gap.days, row.actualCostUsd], ["none", FIXED_COST_UPSTREAM, null, 0, 0]);
  assert.deepEqual(page.counts.uncomputable, {}, "固定成本的上游不进「算不了差额」");
  assert.equal(page.counts.mismatchedChannels, 0);
  // 点开的小格、最近一个已固定的日子也不能照账本数据判出 over/under（审核 #126 第 2 轮 中：M2 没改全，行上说不比、点开却有数字自相矛盾）
  assert.deepEqual([row.daily.at(-1).gapUsd, row.daily.at(-1).gapState, row.daily.at(-1).reason], [null, null, FIXED_COST_UPSTREAM]);
  assert.deepEqual(row.latestSettledGap, { day: "2026-10-25", usd: null, state: null, reason: FIXED_COST_UPSTREAM });
  assert.deepEqual(page.latestSettledGap, { day: "2026-10-25", usd: null, mismatchedRowCount: 0 }, "整页最近一个已固定的日子：固定成本这行不提供差额、不算对不上");
});

test("这天重算的数比原来少了一半多（RESETTLE_SHRUNK）：shrunk 透传给 attention，页面拿它弹确认框（C3，审核 #126/#128 盘点）", () => {
  const window = win("2026-10-25", "2026-10-26", "yesterday"), settledAt = "2026-10-26T00:20:00.000Z";
  const shrunk = { side: "revenue", before: { revenueUsd: 10, costUsd: 6 }, after: { revenueUsd: 4, costUsd: 6 } };
  const results = [resultOf({ id: "s", upstreamStationId: "up2", tokenId: 30, channels: [11], window, income: 4, cost: 6, profit: -2, settledAt, shrunk })];
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [] });
  const row = page.rows.find((item) => item.rowKey === "up2:30");
  assert.deepEqual(row.attention.code, "RESETTLE_SHRUNK");
  assert.deepEqual(row.attention.shrunk, shrunk);
  assert.equal(row.counted, true, "照算进汇总，只多一句提示（审核 C3 中-2）");
});

test("范围还没开始算：state 是 none + NOT_STARTED（不再是单独的 notStarted state）", () => {
  const window = win("2026-10-25", "2026-10-26", "yesterday");
  const started = dayStart("2026-10-27");
  const results = [resultOf({ id: "g", upstreamStationId: "up2", tokenId: 21, channels: [10], window, effectiveFrom: started })];
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [] });
  const row = page.rows.find((item) => item.rowKey === "up2:21");
  assert.deepEqual([row.gap.state, row.gap.reason], ["none", "NOT_STARTED"]);
});

// ---- 固定成本跟着每天一起固定（G）----
// 固定成本的上游：每笔 300 元 30 天 = 每天 10 元；汇率 1 美元 = 5 元（每天 $2）
const fixedStation = (extra = {}) => ({ id: "fx", name: "包月上游", type: "fixed", cnyPerUsd: 5, fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }], ...extra });
const fixedRule = (id, ownStationId = "own") => ({ rule: { id, upstreamStationId: "fx", ownStationId } });
const range = (from, to) => ({ window: { startMs: dayStart(from), endMs: dayStart(to), timezone: TZ }, labels: dayLabelsOf({ startMs: dayStart(from), endMs: dayStart(to) }, TZ, NOW) });
// 账本那天的成本计法（决定那天按固定还是按用量）；固定成本那天的金额和汇率在 reconciliation_fixed_cost_days（fixedDay）
const fixedFact = (day, extra = {}) => ({ ruleId: "r1", billDate: day, costBasis: "fixed", costRate: 5, ...extra });
const fixedDay = (day, costCny, costRate = 5, stationId = "fx", basis = "fixed") => ({ stationId, billDate: day, basis, costCny, costRate, note: null });

test("固定成本：已固定的日子读表里那天记下的金额和汇率，以后改了购买记录、汇率，已固定的日子不变", () => {
  const { window, labels } = range("2026-10-20", "2026-10-22");
  const args = { results: [fixedRule("r1")], labels, window, now: NOW, tz: TZ, dayFacts: [fixedFact("2026-10-20"), fixedFact("2026-10-21")], fixedDays: [fixedDay("2026-10-20", 12, 6), fixedDay("2026-10-21", 0)] };
  // 购买记录后来改成每天 100 元、汇率改成 1 美元 = 2 元：表里记着的那两天不受影响
  const changed = fixedStation({ cnyPerUsd: 2, fixedPurchases: [{ amount: 3000, days: 30, startDate: "2026-10-01" }] });
  const out = fixedCostOfRange({ ...args, stations: [changed] });
  assert.equal(out.usd, 12 / 6, "10-20 记了 12 元、汇率 6 = $2；10-21 记了 0（那天没有固定成本，补记购买记录也不改）");
  assert.equal(out.cny, 12, "人民币原值直接相加，不经汇率");
  assert.equal(fixedCostOfRange({ ...args, stations: [fixedStation()] }).usd, 12 / 6);
});

test("固定成本：没有绑定的固定上游也读表；表里没有的日子（上线前还没补的、还没固定的）按现在的购买记录摊，今天只摊到现在；按用量的那天不摊", () => {
  const { window, labels } = range("2026-10-23", "2026-10-27");
  // 10-23 表里有；10-24 表里没有（按现在的摊）；10-25 账本是按用量：不摊；10-26 是今天：到 14:30 摊 10 × 14.5/24 元
  const withUsage = fixedCostOfRange({ stations: [fixedStation()], results: [fixedRule("r1")], labels, window, now: NOW, tz: TZ, dayFacts: [fixedFact("2026-10-25", { costBasis: "usage" })], fixedDays: [fixedDay("2026-10-23", 20, 4)] });
  // 10-23：20/4 = 5；10-24：10/5 = 2；10-25 不摊；10-26（今天）：10×14.5/24/5
  assert.ok(Math.abs(withUsage.usd - (5 + 2 + (10 * 14.5 / 24) / 5)) < 1e-9, String(withUsage.usd));
});

test("固定成本：自营站点关着收费记录碰到的日子不扣（关着的、已经开回来的都算），不碰到的照扣", () => {
  const { window, labels } = range("2026-10-23", "2026-10-26");
  const common = { stations: [fixedStation()], results: [fixedRule("r1")], labels, window, now: NOW, tz: TZ,
    dayFacts: ["2026-10-23", "2026-10-24", "2026-10-25"].map((day) => fixedFact(day)), fixedDays: ["2026-10-23", "2026-10-24", "2026-10-25"].map((day) => fixedDay(day, 10)) };
  assert.equal(fixedCostOfRange({ ...common, offPeriodsOf: () => [] }).usd, 6, "三天各 $2");
  // 10-24 中午关、10-24 夜里开回来（已开回来的段）：10-24 不扣，另两天照扣
  const closed = [{ fromMs: dayStart("2026-10-24") + 12 * 3600000, toMs: dayStart("2026-10-24") + 22 * 3600000 }];
  assert.equal(fixedCostOfRange({ ...common, offPeriodsOf: () => closed }).usd, 4);
  // 10-25 起一直关着（还关着的段）：10-25 以后都不扣，10-23、10-24 照扣
  const open = [{ fromMs: dayStart("2026-10-25") + 3600000, toMs: null }];
  assert.equal(fixedCostOfRange({ ...common, offPeriodsOf: () => open }).usd, 4);
  // 只看这个上游绑定的自营站点：别的自营站点关着不管
  assert.equal(fixedCostOfRange({ ...common, offPeriodsOf: (own) => (own === "other-own" ? open : []) }).usd, 6);
});

test("固定成本：有一个固定成本的上游没设汇率（表里那天也没记汇率），整段给 null 并点名；设了的照算不受影响", () => {
  const { window, labels } = range("2026-10-20", "2026-10-21");
  const results = [fixedRule("r1"), { rule: { id: "r2", upstreamStationId: "fx2", ownStationId: "own" } }];
  const out = fixedCostOfRange({ stations: [fixedStation(), fixedStation({ id: "fx2", name: "没设汇率", cnyPerUsd: null })], results, labels, window, now: NOW, tz: TZ, dayFacts: [fixedFact("2026-10-20")],
    fixedDays: [fixedDay("2026-10-20", 10), fixedDay("2026-10-20", 10, null, "fx2")] });
  assert.deepEqual([out.usd, out.rateUnset], [null, [{ id: "fx2", name: "没设汇率" }]]);
  // 表里那天记了汇率：以后把汇率删了，也还能折
  const kept = fixedCostOfRange({ stations: [fixedStation({ id: "fx2", name: "删了汇率", cnyPerUsd: null })], results: [], labels, window, now: NOW, tz: TZ, dayFacts: [], fixedDays: [fixedDay("2026-10-20", 10, 5, "fx2")] });
  assert.deepEqual([kept.usd, kept.rateUnset], [2, []]);
});

test("计算明细：固定这天时设置一直读不到的，带 settingUnreadable；没有的是 false", () => {
  const piece = (consumeLogSetting) => ({ rule: { id: "r1" }, result: { downstream: { amountUsd: 1 }, ...(consumeLogSetting ? { consumeLogSetting } : {}) }, expected: null, entry: { settledAt: "2026-10-09T00:05:00Z", revision: 1 } });
  assert.equal(buildProfitDetail([piece({ state: "unreadable", reason: "too_long" })], { day: "2026-10-08" }).settingUnreadable, true);
  assert.equal(buildProfitDetail([piece(null)], { day: "2026-10-08" }).settingUnreadable, false);
});

test("固定成本：已固定的日子只认表——上游现在改成按用量、归档、不算进利润（不在 stations 里）也照样算；表里标按用量的那天记 0，绑定停了也不回退到现在的购买记录", () => {
  const { window, labels } = range("2026-10-20", "2026-10-23");
  const fixedDays = [fixedDay("2026-10-20", 10), fixedDay("2026-10-21", 0, null, "fx", "usage"), fixedDay("2026-10-22", 10)];
  // 上游现在不是固定成本了（stations 里没有它），也没有绑定：以前固定下来的 10-20、10-22 仍各 $2，10-21 是 0
  const gone = fixedCostOfRange({ stations: [], nameOf: () => "老上游", results: [], labels, window, now: NOW, tz: TZ, dayFacts: [], fixedDays });
  assert.deepEqual([gone.usd, gone.cny, gone.rateUnset], [4, 20, []]);
  // 它又是固定成本的上游、购买记录改成每天 100 元：10-21 表里标按用量，不回退到现在的购买记录；表里没有的 10-23 以后才按现在的算（范围到 10-23 之前）
  const changed = fixedStation({ fixedPurchases: [{ amount: 3000, days: 30, startDate: "2026-10-01" }] });
  assert.equal(fixedCostOfRange({ stations: [changed], results: [], labels, window, now: NOW, tz: TZ, dayFacts: [], fixedDays }).usd, 4);
  // 表里标 excluded 的日子也是 0
  assert.equal(fixedCostOfRange({ stations: [], results: [], labels, window, now: NOW, tz: TZ, dayFacts: [], fixedDays: [fixedDay("2026-10-20", 0, null, "fx", "excluded")] }).usd, 0);
});

test("固定成本：毛利里去掉的「永远不固定的日子」固定成本也不扣——这个上游所有绑定那天都是才不扣，只有一条是不去掉", () => {
  const { window, labels } = range("2026-10-23", "2026-10-26");
  const fixedDays = ["2026-10-23", "2026-10-24", "2026-10-25"].map((day) => fixedDay(day, 10));
  const results = [fixedRule("r1"), fixedRule("r2")];
  const base = { stations: [fixedStation()], results, labels, window, now: NOW, tz: TZ, dayFacts: [], fixedDays };
  const sticky = (rule, day) => new Map([[rule, new Map([[day, "RESETTLE_SHRUNK"]])]]);
  assert.equal(fixedCostOfRange({ ...base, stickyDays: sticky("r1", "2026-10-24") }).usd, 6, "只有一条绑定在冲突期：照扣");
  const both = new Map([["r1", new Map([["2026-10-24", "RESETTLE_SHRUNK"]])], ["r2", new Map([["2026-10-24", "OWN_CONSUME_LOG_GAP"]])]]);
  assert.equal(fixedCostOfRange({ ...base, stickyDays: both }).usd, 4, "所有绑定那天都是：不扣");
});

test("固定成本：永远不固定的日子只看那天已经开始算的绑定——B 到 10-25 才开始算，10-24 只有 A 在算且是冲突期，固定成本不扣", () => {
  const { window, labels } = range("2026-10-23", "2026-10-26");
  const fixedDays = ["2026-10-23", "2026-10-24", "2026-10-25"].map((day) => fixedDay(day, 10));
  const started = (id, day) => ({ rule: { id, upstreamStationId: "fx", ownStationId: "own", timezone: TZ, billingPolicy: "immediate", billingEffectiveFrom: dayStart(day), createdAt: new Date(dayStart(day)).toISOString() } });
  const results = [started("r1", "2026-10-01"), started("r2", "2026-10-25")];
  const stickyDays = new Map([["r1", new Map([["2026-10-24", "RESETTLE_SHRUNK"]])]]);
  assert.equal(fixedCostOfRange({ stations: [fixedStation()], results, labels, window, now: NOW, tz: TZ, dayFacts: [], fixedDays, stickyDays }).usd, 4, "10-24 只有 A 在算：不扣，另两天 $2 + $2");
});

test("每天的上游成本 dailyCost：已固定的日子取账本里那天的数，今天是这一行整段实付减去已固定几天的剩余；只加算进利润的行", () => {
  const window = win("2026-10-24", "2026-10-27", "custom"), settledAt = "2026-10-26T00:20:00.000Z";
  // 三天里 10-24、10-25 已固定（各 4、6），今天 10-26 还没固定；整段实付 14 = 4 + 6 + 今天 4
  const results = [resultOf({ id: "a", window, income: 30, cost: 14, profit: 16, settledAt })];
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: [fact("a", "2026-10-24", { cost: 4 }), fact("a", "2026-10-25", { cost: 6 })] });
  assert.deepEqual(page.dailyCost.map((d) => [d.day, d.actualCostUsd, d.actualCostCny]), [["2026-10-24", 4, 4], ["2026-10-25", 6, 6], ["2026-10-26", 4, 4]]);
});

// ---- 多天范围按天算：底（今天的现读）需处理、或中间某天被挡时，这一行不整行丢掉 ----
const weekWindow = () => win("2026-10-20", "2026-10-27", "7d");
const sumOf = (list) => list.reduce((total, value) => total + value, 0);

test("多天：一行每天的收入、成本、毛利加起来等于这一行（已固定的天取账本，今天取整段减已固定）；各行加起来等于整页四个数", () => {
  const window = weekWindow();
  const results = [resultOf({ id: "a", window, income: 30, cost: 18, profit: 12 }), resultOf({ id: "c", upstreamStationId: "up2", tokenId: 9, tokenName: "k2", channels: [3], window, income: 12, cost: 6, profit: 6 })];
  const facts = [fact("a", "2026-10-24", { cost: 6 }), fact("a", "2026-10-25", { cost: 6 }), fact("c", "2026-10-25", { cost: 3 })]; // 账本每天收入 10
  const page = buildProfitPage({ results, window, now: NOW, stationOf, dayFacts: facts });
  const a = page.rows.find((row) => row.rowKey === "up:7"), c = page.rows.find((row) => row.rowKey === "up2:9");
  const counted = (row, field) => sumOf(row.daily.filter((day) => day[field] != null).map((day) => day[field]));
  assert.deepEqual([counted(a, "incomeUsd"), counted(a, "actualCostUsd"), counted(a, "grossUsd")], [a.incomeUsd, a.actualCostUsd, a.grossProfitUsd], "一行：每天加起来 = 这一行的合计");
  assert.deepEqual([a.incomeUsd, a.actualCostUsd, a.grossProfitUsd], [30, 18, 12]);
  assert.deepEqual([a.daily.at(-1).state, a.daily.at(-1).incomeUsd, a.daily.at(-1).actualCostUsd, a.daily.at(-1).grossUsd], ["today", 10, 6, 4], "今天 = 整段 30 − 已固定两天 20");
  assert.deepEqual([page.pageTotals.incomeUsd, page.pageTotals.actualCostUsd, page.pageTotals.grossProfitUsd], [sumOf(page.rows.map((row) => row.incomeUsd)), sumOf(page.rows.map((row) => row.actualCostUsd)), sumOf(page.rows.map((row) => row.grossProfitUsd))], "各行加起来 = 整页的数");
  // 柱状图每天 = 那天算进来的各行之和
  const dayGross = (day) => sumOf(page.rows.map((row) => row.daily.find((cell) => cell.day === day)?.grossUsd ?? 0));
  assert.deepEqual([dayGross("2026-10-24"), dayGross("2026-10-25")], [4, 11], "10-24 只有 a（10−6）；10-25 a 是 4、c 是 10−3");
  assert.equal(c.daily.find((cell) => cell.day === "2026-10-25").grossUsd, 7);
});

test("多天：底（今天）需处理时，这一行不整行丢掉——已固定几天的和照算进来、今天写需处理、感叹号（attention）留着；各天和合计对得上", () => {
  const window = weekWindow();
  // server 的 dailyProfitResults 给的：底需处理（displayStatus 是需处理），但账本两天的和（收入 20、成本 12）和 countedDays 照给
  const blocked = { ...resultOf({ id: "a", window, income: 20, cost: 12, profit: 8, attention: true }), countedDays: 2 };
  const ok = resultOf({ id: "c", upstreamStationId: "up2", tokenId: 9, tokenName: "k2", channels: [3], window, income: 12, cost: 6, profit: 6 });
  const page = buildProfitPage({ results: [blocked, ok], window, now: NOW, stationOf, dayFacts: [fact("a", "2026-10-24", { cost: 6 }), fact("a", "2026-10-25", { cost: 6 })] });
  const a = page.rows.find((row) => row.rowKey === "up:7");
  assert.deepEqual([a.counted, a.incomeUsd, a.actualCostUsd, a.grossProfitUsd], [true, 20, 12, 8], "算进来的天（账本两天）照算");
  assert.equal(a.attention.code, "OWN_BILLING_UNAVAILABLE", "需处理留着：名字后面亮感叹号");
  const today = a.daily.at(-1);
  assert.deepEqual([today.state, today.incomeUsd, today.actualCostUsd, today.grossUsd], ["attention", null, null, null], "今天需处理：写「—」，不当 0、不算进今天");
  assert.deepEqual(a.daily.filter((cell) => cell.state === "fixed").map((cell) => cell.grossUsd), [4, 4]);
  assert.equal(page.pageTotals.incomeUsd, 32, "整页 = a 的 20 + c 的 12");
  assert.deepEqual([page.counts.countedChannels, page.counts.attentionChannels], [2, 1]);
  assert.equal(a.excludedDays, 1, "没算进来的是今天这一天（过去的天都算进来了）");
});

test("多天：中间某天被挡（状态表里要人处理的码）：这天不进合计、这天小格写需处理，行上补一件需处理（标题和按钮从码来），其余天照算", () => {
  const window = weekWindow();
  const results = [resultOf({ id: "a", window, income: 20, cost: 12, profit: 8 })];
  const stickyDays = new Map([["a", new Map([["2026-10-23", "CHANNEL_KEY_NO_USAGE"]])]]);
  const page = buildProfitPage({ results, window, now: NOW, stationOf, stickyDays, dayFacts: [fact("a", "2026-10-24", { cost: 6 }), fact("a", "2026-10-25", { cost: 6 })] });
  const a = page.rows[0];
  const blockedCell = a.daily.find((cell) => cell.day === "2026-10-23");
  assert.deepEqual([blockedCell.state, blockedCell.incomeUsd, blockedCell.actualCostUsd, blockedCell.grossUsd, blockedCell.reason], ["attention", null, null, null, "CHANNEL_KEY_NO_USAGE"]);
  assert.deepEqual([a.counted, a.incomeUsd, a.excludedDays], [true, 20, 1]);
  assert.equal(a.attention.code, "CHANNEL_KEY_NO_USAGE");
  assert.equal(a.attention.action.kind, "go_swap_key");
  assert.equal(a.attention.fromDay, "2026-10-23");
  assert.match(a.attention.title, /渠道 1.*2026|10月23日|没用量/);
  assert.deepEqual(a.daily.filter((cell) => cell.state === "fixed").map((cell) => cell.day), ["2026-10-24", "2026-10-25"]);
  assert.deepEqual([page.dayCounts.excluded, page.dayCounts.reading], [1, 3], "被挡的天不当成「还在读取」（那三天夹具里没账本才是读取中）");
});

test("只有今天、今天又需处理（没有已固定的天可算）：这一行不算进来，收入不进合计，成本、毛利写「—」", () => {
  const window = win("2026-10-26", "2026-10-27", "today");
  const page = buildProfitPage({ results: [resultOf({ id: "a", window, income: 7, cost: 0, profit: 0, attention: true })], window, now: NOW, stationOf, dayFacts: [] });
  const a = page.rows[0];
  assert.deepEqual([a.counted, a.incomeUsd, a.actualCostUsd, a.grossProfitUsd, a.uncountedIncomeUsd], [false, null, null, null, 7]);
  assert.deepEqual([page.pageTotals.incomeUsd, page.counts.countedChannels], [null, 0]);
  assert.equal(a.daily.at(-1).grossUsd, null);
});
