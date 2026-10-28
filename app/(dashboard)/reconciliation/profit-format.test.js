// 每日利润页的纯函数（profit-format.ts）：差额那一格怎么写、原因码翻字、排序筛选、小格状态、合计行、四个数、页顶一句、表下面那一行。
// node 直接跑 .ts（去掉类型）；profit-format.ts 引 lib 下的带 .js 后缀，引同目录的 copy.ts 不带后缀（Turbopack 打包要这样），node 靠下面的 resolve 钩子补上 .ts。夹具照 lib/profit-page.test.js 的形状（接口响应）。
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 同目录里不带后缀的相对导入（"./copy"）：有同名 .ts 就补上 .ts；别的照旧
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    const path = fileURLToPath(new URL(specifier, context.parentURL));
    if (!existsSync(path) && existsSync(`${path}.ts`)) return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });

const { COPY } = await import("./copy.ts");
const {
  attentionNote, dayCellView, filterCounts, filterRows, footerNotes, gapCell, gapHeader, gapReasonText, heldNote, metrics, pageMoney, rangeCaption, rowMoney, rowSubtitle, rowTone,
  marginText, showExpectedColumn, livePollMs, LIVE_POLL_MS, LIVE_POLL_LONG_MS, signedMoney, totalsRow, utcOffsetText, whereGapText, unitPriceText, adminUsageText, ratioLine,
} = await import("./profit-format.ts");
const { dayKeyInTz, dayStartInTz } = await import("../../../lib/business-time.js");
const { EMPTY, RATE_UNSET_USD } = await import("../../../lib/format.js");

const TZ = "Asia/Shanghai";
// 「今年」按跑测试时的业务时区算，写日期时跟着当年走，跨年也不会失效
const year = Number(dayKeyInTz(Date.now(), TZ).slice(0, 4));
const D = (md) => `${year}-${md}`;
const NOW = dayStartInTz(D("10-26"), TZ) + 14.5 * 3600000; // 10-26 14:30 上海
const ctx = { currency: "USD", tz: TZ, now: NOW };

function row(overrides = {}) {
  return {
    rowKey: "up:7", ruleIds: ["a"], channels: [{ channelId: 1, name: "备用 C" }], upstream: { stationId: "up", name: "拼车团队", provider: "newapi" },
    key: { name: "team-c", groupName: "vip", groupRatio: 0.8, upstreamKeyUrl: null }, rates: { income: null, cost: null, costBasis: "usage" },
    startedOn: null, startedAt: null, counted: true, incomeUsd: 14.6, actualCostUsd: 9.2, grossProfitUsd: 5.4, uncountedIncomeUsd: null, expectedCostUsd: 8,
    gap: { usd: 1.2, rate: 0.15, state: "over", mismatchedDays: [{ day: D("10-25"), usd: 1.2, state: "over" }], days: 1, reason: null, missingPriceModels: [] },
    attention: null, excludedDays: 0, daily: [], latestSettledGap: { day: D("10-25"), usd: 1.2, state: "over", reason: null }, ...overrides,
  };
}
function page(overrides = {}) {
  const startMs = dayStartInTz(D("10-25"), TZ);
  return {
    range: { preset: "yesterday", startMs, endMs: dayStartInTz(D("10-26"), TZ), timezone: TZ }, today: D("10-26"), dayCounts: { fixed: 1, reading: 0, today: 0 },
    pageTotals: { incomeUsd: 103.7, actualCostUsd: 64.51, grossProfitUsd: 39.19, grossMarginRate: 39.19 / 103.7 },
    gap: { days: { first: D("10-25"), last: D("10-25"), count: 1, contiguous: true }, expectedCostUsd: 57.6, actualCostUsd: 58.31, usd: 0.71, overUsd: 1.2, underUsd: 0.5, withinUsd: 0.01, rowCount: 3 },
    latestSettledGap: null, counts: { channels: 7, countedChannels: 6, mismatchedChannels: 2, attentionChannels: 1, uncomputable: { UPSTREAM_PRICE_UNSUPPORTED: 1, MODEL_PRICE_MISSING: 1 }, mismatchedDays: { over: 1, under: 1 } },
    gapThreshold: { usd: 0.05, rate: 0.02 }, rows: [row()], asOf: new Date(NOW).toISOString(), tz: TZ, displayCurrency: "USD", fixedCostUsd: 2.33, netProfitUsd: 36.86,
    ownIncomeUnavailable: null, unaccountedUpstreamCostUsd: 4.2, unlinkedChannelCount: 2, rateUnset: [{ id: "up", name: "拼车团队" }], fixedOffProfitStations: [], ...overrides,
  };
}
const todayPage = (overrides = {}) => page({ range: { preset: "today", startMs: dayStartInTz(D("10-26"), TZ), endMs: NOW, timezone: TZ }, dayCounts: { fixed: 0, reading: 0, today: 1 },
  gap: { days: { first: null, last: null, count: 0, contiguous: false }, expectedCostUsd: null, actualCostUsd: null, usd: null, overUsd: 0, underUsd: 0, withinUsd: 0, rowCount: 0 },
  latestSettledGap: { day: D("10-25"), usd: 0.71, mismatchedRowCount: 2 }, ...overrides });
const weekPage = (overrides = {}) => page({ range: { preset: "7d", startMs: dayStartInTz(D("10-20"), TZ), endMs: NOW, timezone: TZ }, dayCounts: { fixed: 6, reading: 0, today: 1 },
  gap: { days: { first: D("10-20"), last: D("10-25"), count: 6, contiguous: true }, expectedCostUsd: 300, actualCostUsd: 301.65, usd: 1.65, overUsd: 2.1, underUsd: 0.5, withinUsd: 0.05, rowCount: 5 }, ...overrides });

test("按人民币显示：固定成本直接用接口给的人民币原值，不拿美元再按自营站点汇率折回（两边汇率不同也不变）", () => {
  const r = row(); r.rates = { ...r.rates, income: 7.2 };
  const p = page({ rows: [r], fixedCostUsd: 700 / 6.8, fixedCostCny: 700, displayCurrency: "CNY" });
  assert.equal(pageMoney(p, "CNY").fixedCost, 700);
  assert.equal(pageMoney(p, "USD").fixedCost, 700 / 6.8);
  assert.equal(pageMoney(p, "CNY").fixedExact, true, "人民币原值：固定成本前面不带「≈」");
  assert.equal(pageMoney(page({ rows: [r], fixedCostUsd: 100, displayCurrency: "CNY" }), "CNY").fixedExact, false, "接口没给人民币原值时才是折算的");
});

test("差额那一格（§5.7）：多扣 / 少扣带百分比和「对不上」；门槛以内灰字写数；今天「明天出」；算不了写「—」和原因", () => {
  const p = page();
  assert.deepEqual(gapCell(row(), p, ctx), { main: "多扣 $1.20", sub: "比应付多 15%", tag: true, tone: "over", muted: false });
  assert.deepEqual(gapCell(row({ gap: { usd: -0.5, rate: -0.036, state: "under", mismatchedDays: [{ day: D("10-25"), usd: -0.5, state: "under" }], days: 1, reason: null, missingPriceModels: [] } }), p, ctx),
    { main: "少扣 $0.50", sub: "比应付少 3.6%", tag: true, tone: "under", muted: false });
  assert.deepEqual(gapCell(row({ gap: { usd: 0.01, rate: 0.0003, state: "within", mismatchedDays: [], days: 1, reason: null, missingPriceModels: [] } }), p, ctx), { main: "+$0.01", sub: "", tag: false, tone: null, muted: true });
  assert.deepEqual(gapCell(row({ gap: { usd: null, rate: null, state: "uncomputable", mismatchedDays: [], days: 0, reason: "UPSTREAM_PRICE_UNSUPPORTED", missingPriceModels: [] } }), p, ctx), { main: EMPTY, sub: "Sub2API 上游读不到价格", tag: false, tone: null, muted: false });
  assert.equal(gapCell(row({ gap: { usd: null, rate: null, state: "uncomputable", mismatchedDays: [], days: 0, reason: "MODEL_PRICE_MISSING", missingPriceModels: ["o3-pro"] } }), p, ctx).sub, "上游没给 o3-pro 的价格");
  assert.equal(gapCell(row({ gap: { usd: null, rate: null, state: "uncomputable", mismatchedDays: [], days: 0, reason: "MODEL_PRICE_MISSING", missingPriceModels: ["o3-pro", "a", "b"] } }), p, ctx).sub, "上游没给 o3-pro 等 3 个模型的价格");
  assert.deepEqual(gapCell(row({ gap: { usd: null, rate: null, state: "reading", mismatchedDays: [], days: 0, reason: null, missingPriceModels: [] } }), p, ctx), { main: EMPTY, sub: "还在读取", tag: false, tone: null, muted: false });
  assert.deepEqual(gapCell(row({ attention: { code: "X", title: "t", detail: null, action: null, fromDay: null, moreCount: 0 }, gap: { usd: null, rate: null, state: "attention", mismatchedDays: [], days: 0, reason: null, missingPriceModels: [] } }), p, ctx), { main: EMPTY, sub: "", tag: false, tone: null, muted: false });
  // 多天：差额后面写其中几天对不上
  assert.deepEqual(gapCell(row({ gap: { usd: 2.1, rate: 0.1, state: "over", mismatchedDays: [{ day: D("10-24"), usd: 0.9, state: "over" }, { day: D("10-25"), usd: 1.2, state: "over" }], days: 6, reason: null, missingPriceModels: [] } }), weekPage(), ctx),
    { main: "多扣 $2.10", sub: "其中 2 天对不上", tag: true, tone: "over", muted: false });
  assert.equal(gapCell(row({ gap: { usd: null, rate: null, state: "today", mismatchedDays: [], days: 0, reason: null, missingPriceModels: [] } }), weekPage(), ctx).main, "明天出");
  // 不写 0
  assert.notEqual(gapCell(row({ gap: { usd: null, rate: null, state: "today", mismatchedDays: [], days: 0, reason: null, missingPriceModels: [] } }), weekPage(), ctx).main, "$0.00");
});

test("看今天时差额那一列是最近一个已固定日子的：对不上照写，昨天还没开始算、算不出的写原因", () => {
  const p = todayPage();
  assert.deepEqual(gapCell(row(), p, ctx), { main: "多扣 $1.20", sub: "", tag: true, tone: "over", muted: false });
  assert.deepEqual(gapCell(row({ latestSettledGap: { day: D("10-25"), usd: 0.01, state: "within", reason: null } }), p, ctx), { main: "+$0.01", sub: "", tag: false, tone: null, muted: true });
  assert.equal(gapCell(row({ latestSettledGap: null, startedOn: D("10-26") }), p, ctx).sub, "昨天还没开始算");
  assert.equal(gapCell(row({ latestSettledGap: { day: D("10-25"), usd: null, state: null, reason: "EXPECTED_COST_NOT_RECORDED" } }), p, ctx).sub, "这天在开始算应付成本以前，没算");
  // latestSettledGap 自己带 reason: NOT_STARTED（接口按字段表允许给）：照「还没开始算」写，不进 reason 表（设计验收 10-26）
  assert.equal(gapCell(row({ latestSettledGap: { day: D("10-25"), usd: null, state: null, reason: "NOT_STARTED" } }), p, ctx).sub, "昨天还没开始算");
  const p24 = todayPage({ latestSettledGap: { day: D("10-24"), usd: 0.9, mismatchedRowCount: 1 } });
  assert.equal(gapCell(row({ latestSettledGap: { day: D("10-24"), usd: null, state: null, reason: "NOT_STARTED" } }), p24, ctx).sub, "10月24日还没开始算");
  // 最近固定的日子不是昨天时，表头跟着写那一天
  assert.equal(gapHeader(todayPage({ latestSettledGap: { day: D("10-24"), usd: 0.9, mismatchedRowCount: 1 } }), ctx).title, "10月24日的差额");
  assert.equal(gapHeader(p, ctx).title, "昨天的差额");
});

test("原因码翻字：「算应付成本」关着分固定了没有；一天不从整点开始写时差", () => {
  assert.equal(gapReasonText("EXPECTED_COST_DISABLED"), "「算应付成本」关了，这天没算，以后打开也不补");
  assert.equal(gapReasonText("EXPECTED_COST_DISABLED", [], { settled: false }), "「算应付成本」关着");
  assert.equal(gapReasonText("EXPECTED_COST_LAGGING"), "收费记录还没读到这天");
  assert.equal(gapReasonText("KEY_SHARED"), "这把 Key 别处也在用");
  assert.equal(gapReasonText("GROUP_AUTO"), "这把 Key 的分组会自动换");
  assert.equal(gapReasonText("CACHE_FIELDS_UNKNOWN"), "自营站点的记录看不出缓存用了多少");
  assert.equal(gapReasonText("MODEL_PRICE_UNREADABLE"), "读不到上游的模型价格");
  assert.equal(gapReasonText("DAY_BOUNDARY_UNSUPPORTED", [], { zone: "Asia/Kolkata" }), "这个上游按 UTC+5:30 算一天，算不了应付成本");
  assert.equal(utcOffsetText("Asia/Kathmandu"), "UTC+5:45");
  assert.equal(utcOffsetText("Asia/Shanghai"), "UTC+8");
  assert.equal(utcOffsetText("America/Sao_Paulo", Date.UTC(year, 0, 15)), "UTC−3");
  assert.equal(gapReasonText("SOMETHING_NEW"), "算不出");
  assert.equal(gapReasonText(null), "");
});

test("排序和筛选按渠道数：合用一把 Key 的两个渠道算 2 个；底色：多扣红、需处理橙、少扣蓝", () => {
  const over = row(), under = row({ rowKey: "b", channels: [{ channelId: 2, name: "直连 E" }], gap: { ...row().gap, usd: -0.5, state: "under" }, latestSettledGap: { day: D("10-25"), usd: -0.5, state: "under", reason: null } });
  const attention = row({ rowKey: "c", channels: [{ channelId: 3, name: "备用 F" }, { channelId: 4, name: "备用 G" }], counted: false, attention: { code: "KEY_INVALID_OR_DENIED", title: "上游拒绝读取这把 Key", detail: null, action: null, fromDay: D("10-17"), moreCount: 0 }, gap: { ...row().gap, usd: null, state: "attention" }, latestSettledGap: null, excludedDays: 1 });
  const p = page({ rows: [over, attention, under] });
  assert.deepEqual(filterCounts(p), { all: 4, mismatched: 2, attention: 2 });
  assert.deepEqual(filterRows(p.rows, "mismatched", p).map((r) => r.rowKey), ["up:7", "b"]);
  assert.deepEqual(filterRows(p.rows, "attention", p).map((r) => r.rowKey), ["c"]);
  assert.deepEqual(p.rows.map((r) => rowTone(r, p)), ["over", "attention", "under"]);
  // 看今天按最近一个已固定日子判
  assert.deepEqual(filterCounts(todayPage({ rows: [over, attention, under] })), { all: 4, mismatched: 2, attention: 2 });
  assert.equal(attentionNote(attention, p, ctx), "10月17日起没算进利润");
  assert.equal(attentionNote(attention, todayPage(), ctx), "10月17日起没算进利润", "看今天也写");
  assert.equal(attentionNote({ ...attention, excludedDays: 7 }, weekPage(), ctx), "10月17日起没算进利润，这 7 天都不在合计里");
});

test("名字下面那行小字：上游 · Key · 分组倍率 · 范围中间开始算的写开始日期，今天开始的写时刻", () => {
  assert.equal(rowSubtitle(row(), page(), ctx), "拼车团队 · Key team-c · vip 分组 ×0.8");
  assert.equal(rowSubtitle(row({ channels: [{ channelId: 1, name: "高速 A" }, { channelId: 2, name: "备用 B" }], key: { name: "oai", groupName: "default", groupRatio: 1, upstreamKeyUrl: null } }), page(), ctx), "拼车团队 · 2 个渠道合用 Key oai · default 分组 ×1.0");
  assert.equal(rowSubtitle(row({ startedOn: D("10-24") }), weekPage(), ctx), "拼车团队 · Key team-c · vip 分组 ×0.8 · 10月24日 开始算");
  assert.equal(rowSubtitle(row({ startedOn: D("10-26"), startedAt: NOW }), weekPage(), ctx), "拼车团队 · Key team-c · vip 分组 ×0.8 · 今天 14:30 开始算，0 点以后的都算进来了");
  // 范围第一天就开始的不写；看今天时今天开始的照写时刻
  assert.equal(rowSubtitle(row({ startedOn: D("10-20") }), weekPage(), ctx), "拼车团队 · Key team-c · vip 分组 ×0.8");
  assert.equal(rowSubtitle(row({ startedOn: D("10-26"), startedAt: NOW }), todayPage(), ctx), "拼车团队 · Key team-c · vip 分组 ×0.8 · 今天 14:30 开始算，0 点以后的都算进来了");
});

test("每天的小格：对不上的那天上底色写数，对得上写「·」，今天虚线框「明天出」，没开始算的灰掉；月份已在上面写了，格子只写「20日」", () => {
  const p = weekPage();
  const cells = [
    { day: D("10-20"), state: "notStarted", gapUsd: null, gapState: null, reason: null, tokens: null },
    { day: D("10-24"), state: "fixed", gapUsd: 0.9, gapState: "over", reason: null, tokens: 100 },
    { day: D("10-23"), state: "fixed", gapUsd: 0.01, gapState: "within", reason: null, tokens: 100 },
    { day: D("10-22"), state: "fixed", gapUsd: null, gapState: null, reason: "MODEL_PRICE_MISSING", tokens: 100 },
    { day: D("10-21"), state: "reading", gapUsd: null, gapState: null, reason: null, tokens: null },
    { day: D("10-26"), state: "today", gapUsd: null, gapState: null, reason: null, tokens: null },
  ].map((cell) => dayCellView(cell, p, ctx, null));
  assert.deepEqual(cells.map((c) => [c.label, c.text, c.tone, c.today, c.disabled, c.clickable]), [
    ["20日", EMPTY, null, false, true, false], ["24日", "+0.90", "over", false, false, true], ["23日", "·", null, false, false, true],
    ["22日", EMPTY, null, false, false, true], ["21日", EMPTY, null, false, false, false], ["今天", "明天出", null, true, false, true],
  ]);
  assert.equal(cells[1].title, "10月24日的差额");
});

test("「差在哪」那一句：看一天写用量、分组倍率、应付和实付，带上前面也对不上的日子；看几天列出对不上的日子", () => {
  const r = row({ daily: [{ day: D("10-24"), state: "fixed", gapUsd: 0.9, gapState: "over", reason: null, tokens: 2_000_000 }, { day: D("10-25"), state: "fixed", gapUsd: 1.2, gapState: "over", reason: null, tokens: 2_880_000 }] });
  assert.equal(whereGapText(r, page(), ctx), "自营站点这个渠道这天用了 288 万 Token，按上游的价格和 vip 分组 ×0.8 算，应付成本 $8.00；上游这把 Key 这天实付 $9.20。10月24日 也多扣 $0.90。");
  const w = row({ gap: { usd: 2.1, rate: 0.1, state: "over", mismatchedDays: [{ day: D("10-24"), usd: 0.9, state: "over" }, { day: D("10-25"), usd: 1.2, state: "over" }], days: 6, reason: null, missingPriceModels: [] } });
  assert.equal(whereGapText(w, weekPage(), ctx), "10月24日 多扣 $0.90，10月25日 多扣 $1.20，其余 4 天对得上。点一天看那天的计算明细。");
  assert.equal(whereGapText(row({ gap: { usd: 0.05, rate: 0.001, state: "within", mismatchedDays: [], days: 6, reason: null, missingPriceModels: [] } }), weekPage(), ctx), "这几天都对得上。点一天看那天的计算明细。");
  assert.equal(whereGapText(row({ gap: { usd: null, rate: null, state: "today", mismatchedDays: [], days: 0, reason: null, missingPriceModels: [] } }), weekPage(), ctx), "今天的应付成本和差额明天出。");
  // 看今天：写最近一个已固定的日子（Token 在那天的小格里、差额用 latestSettledGap），后面接「今天的明天出」
  const todayRow = row({ gap: { usd: null, rate: null, state: "today", mismatchedDays: [], days: 0, reason: null, missingPriceModels: [] }, daily: [{ day: D("10-25"), state: "fixed", gapUsd: 1.2, gapState: "over", reason: null, tokens: 2_880_000 }, { day: D("10-26"), state: "today", gapUsd: null, gapState: null, reason: null, tokens: null }] });
  assert.equal(whereGapText(todayRow, todayPage(), ctx), "昨天：自营站点这个渠道用了 288 万 Token，多扣 $1.20。今天的明天出。", "设计验收 10-26：去掉「差额」两个字");
  assert.equal(whereGapText({ ...todayRow, daily: [], latestSettledGap: { day: D("10-25"), usd: 0.01, state: "within", reason: null } }, todayPage(), ctx), "昨天：+$0.01。今天的明天出。");
  assert.equal(whereGapText({ ...todayRow, latestSettledGap: { day: D("10-25"), usd: null, state: null, reason: "KEY_SHARED" } }, todayPage(), ctx), "昨天：算不了差额（这把 Key 别处也在用）。今天的明天出。");
  assert.equal(whereGapText({ ...todayRow, latestSettledGap: null }, todayPage(), ctx), "今天的应付成本和差额明天出。");
});

test("表头和合计行：全固定出应付成本一列，有今天时不出、表头写清是哪几天；合计只加算进来的，应付和差额只加算得出的那几行", () => {
  const fixed = page();
  assert.equal(showExpectedColumn(fixed), true);
  assert.deepEqual(gapHeader(fixed, ctx), { title: "差额", sub: "上游成本 − 应付" });
  const totals = totalsRow(page({ rows: [row(), row({ rowKey: "b", channels: [{ channelId: 2, name: "x" }] }), row({ rowKey: "c", channels: [{ channelId: 3, name: "y" }] }), row({ rowKey: "d", channels: [{ channelId: 4, name: "z" }], gap: { ...row().gap, usd: null, state: "uncomputable", reason: "KEY_SHARED" } })] }), ctx);
  assert.deepEqual(totals, { label: "合计（算进来的 6 个渠道）", income: "$103.70", actual: "$64.51", gross: "$39.19", expected: "$57.60", expectedSub: "只有 3 行", gap: "+$0.71", gapSub: "同样这 3 行" });
  const week = weekPage();
  assert.equal(showExpectedColumn(week), false);
  assert.deepEqual(gapHeader(week, ctx), { title: "差额", sub: "已固定的 6 天（10月20日–10月25日）" });
  assert.equal(gapHeader(weekPage({ gap: { ...week.gap, days: { ...week.gap.days, contiguous: false } } }), ctx).sub, "已固定的 6 天");
  const weekTotals = totalsRow(week, ctx);
  assert.equal(weekTotals.expected, EMPTY); assert.equal(weekTotals.gap, "+$1.65");
  // 看今天：差额合计是最近一个已固定日子的
  assert.equal(totalsRow(todayPage(), ctx).gap, "+$0.71");
});

test("合计行：已固定、又因为重算的事需处理、照算进来的行，括号里补一句「其中 N 个还没重算」；手机顶上卡片最后一行写同一句不带「合计」（设计 10-26 定）", () => {
  const held = row({ rowKey: "h", channels: [{ channelId: 5, name: "h1" }, { channelId: 6, name: "h2" }], counted: true,
    attention: { code: "RESETTLE_SHRUNK", title: "这天重算的数比原来少了一半多", detail: null, action: null, fromDay: null, moreCount: 0 } });
  const p = page({ rows: [row(), held], counts: { channels: 3, countedChannels: 3, mismatchedChannels: 0, attentionChannels: 2, uncomputable: {}, mismatchedDays: { over: 0, under: 0 } } });
  assert.equal(totalsRow(p, ctx).label, "合计（算进来的 3 个渠道；其中 2 个还没重算，先按原来固定的数算）");
  assert.equal(heldNote(p), "其中 2 个还没重算，先按原来固定的数算");
  // 没有这种行：照旧，不带这半句
  const plain = page({ rows: [row()], counts: { channels: 1, countedChannels: 1, mismatchedChannels: 1, attentionChannels: 0, uncomputable: {}, mismatchedDays: { over: 1, under: 0 } } });
  assert.equal(totalsRow(plain, ctx).label, "合计（算进来的 1 个渠道）");
  assert.equal(heldNote(plain), "");
  // 需处理但没算进合计（counted:false）的不算
  const excluded = row({ rowKey: "e", channels: [{ channelId: 7, name: "e1" }], counted: false,
    attention: { code: "RESETTLE_SHRUNK", title: "t", detail: null, action: null, fromDay: null, moreCount: 0 } });
  assert.equal(heldNote(page({ rows: [row(), excluded] })), "", "counted 是 false 的不算「照算进了合计」");
});

test("四个数：今天 / 已固定 / 近 7 天各一套标题；上游整体少扣写「比预期多赚」不写负数；净利只在毛利下面一行", () => {
  const today = metrics(todayPage(), ctx);
  assert.deepEqual(today.map((m) => [m.title, m.value]), [["今天到现在的毛利", "$39.19"], ["今天的差额", "明天出"], ["昨天比预期少赚", "$0.71"], ["没算进来", "全部算进来了"]]);
  assert.deepEqual(today[0].lines, ["收入 $103.70 − 上游成本 $64.51", "毛利率 37.8%", "扣今天的固定成本 $2.33 后，净利 $36.86"]);
  assert.deepEqual(today[1].lines, ["应付成本和差额，等今天过了零点、固定以后才算"]);
  // 几个渠道对不上按行上最近一个已固定日子的状态数（夹具里只有一行）
  assert.deepEqual([today[2].lines, today[2].link], [["1 个渠道对不上"], { text: "看昨天", day: D("10-25") }]);
  assert.equal(today[2].crit, true);
  const fixed = metrics(page(), ctx);
  assert.deepEqual(fixed.map((m) => [m.title, m.value]), [["毛利", "$39.19"], ["比预期少赚", "$0.71"], ["对不上", "2 个渠道"], ["算不了差额", "2 个渠道"]]);
  assert.deepEqual(fixed[1].lines, ["多扣 $1.20 · 少扣 $0.50 · 门槛以内 +$0.01", "只算算得出应付成本的 3 行"]);
  assert.deepEqual(fixed[2].lines, ["差额同时超过 $0.05 和应付成本的 2%"]);
  // 「算不了差额」的小字短写，第二行另有几个需处理；「对不上」那一格不上色
  assert.deepEqual(fixed[3].lines, ["Sub2API 上游 1 个 · 有模型没价格 1 个", "另有 1 个需处理，没算进来"]); assert.equal(fixed[2].crit, false);
  assert.equal(fixed[0].lines[2], "扣固定成本 $2.33 后，净利 $36.86");
  const more = metrics(page({ gap: { ...page().gap, usd: -0.3, overUsd: 0, underUsd: 0.3, withinUsd: 0 }, counts: { ...page().counts, mismatchedChannels: 1 } }), ctx)[1];
  assert.deepEqual([more.title, more.value, more.crit], ["比预期多赚", "$0.30", false]);
  const week = metrics(weekPage(), ctx);
  assert.deepEqual(week.map((m) => m.title), ["近 7 天毛利", "比预期少赚（已固定的 6 天）", "对不上", "没算进来"]);
  assert.deepEqual(week[2].lines, ["这 6 天里有一天对不上，就算这个渠道对不上"]);
  // 固定成本算不出（有上游没设汇率）时净利先不算，不写 0
  assert.equal(metrics(page({ fixedCostUsd: null, netProfitUsd: null }), ctx)[0].lines[2], "固定成本算不出，净利先不算");
});

test("页顶一句（§2、§6）：今天写 0:00–现在；一天写日期和周几、已固定；几天写几天已固定、今天实时", () => {
  assert.equal(rangeCaption(todayPage(), ctx), "10月26日 0:00–14:30 · 今天的数还会变，过了零点自动固定");
  assert.equal(rangeCaption(page(), ctx), `10月25日 ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(Date.UTC(year, 9, 25)).getUTCDay()]} · 已固定`);
  assert.equal(rangeCaption(weekPage(), ctx), "10月20日–10月26日 · 6 天已固定，今天实时");
  assert.equal(rangeCaption(weekPage({ dayCounts: { fixed: 4, reading: 1, today: 1 } }), ctx), "10月20日–10月26日 · 4 天已固定，1 天还在读取，今天实时");
  assert.equal(rangeCaption(page({ range: { preset: "custom", startMs: dayStartInTz(D("10-18"), TZ), endMs: dayStartInTz(D("10-25"), TZ), timezone: TZ }, dayCounts: { fixed: 7, reading: 0, today: 0 } }), ctx), "10月18日–10月24日 · 已固定");
});

test("按人民币显示：收入按自营站点的汇率、成本和差额按上游的汇率换算，整页的数由各行加起来", () => {
  const cny = { currency: "CNY", tz: TZ, now: NOW };
  const r = row({ rates: { income: 7, cost: 6, costBasis: "usage" } });
  const m = rowMoney(r, "CNY");
  assert.deepEqual([m.income, m.actual, m.gross.toFixed(2), m.gap.toFixed(2)], [14.6 * 7, 9.2 * 6, (14.6 * 7 - 9.2 * 6).toFixed(2), (1.2 * 6).toFixed(2)]);
  assert.equal(gapCell(r, page(), cny).main, "多扣 ¥7.20");
  const money = pageMoney(page({ rows: [r] }), "CNY");
  assert.deepEqual([money.income, money.actual, money.gap.toFixed(2), money.over.toFixed(2)], [14.6 * 7, 9.2 * 6, "7.20", "7.20"]);
  assert.equal(signedMoney(-0.5, "CNY"), "−¥0.50");
  // 固定成本、没算进利润的上游成本是按自营站点汇率换的：带「≈」
  const cnyPage = page({ rows: [r], unaccountedUpstreamCostUsd: 4.2 });
  assert.equal(metrics(cnyPage, cny)[0].lines[2], "扣固定成本 ≈ ¥16.31 后，净利 ≈ ¥" + (14.6 * 7 - 9.2 * 6 - 2.33 * 7).toFixed(2));
  assert.equal(footerNotes(cnyPage, cny, { upstreams: "/stations", start: "/s", settings: "/settings" })[0].text, "另有 ≈ ¥29.40 上游成本没算进利润");
});

test("表下面那一行：没算进利润的上游成本、还没算利润的渠道、没设置汇率；收费记录落后 1 小时以上才写读到哪儿了", () => {
  const hrefs = { upstreams: "/stations", start: "/stations?view=accounts", settings: "/settings" };
  const notes = footerNotes(page(), ctx, hrefs, { coveredToMs: NOW - 2 * 3600000 });
  assert.deepEqual(notes.map((n) => [n.key, n.text, n.link?.text]), [
    ["unaccounted", "另有 $4.20 上游成本没算进利润", "查看各上游"], ["unlinked", "另有 2 个渠道还没算利润", "开始算利润"], ["rate", RATE_UNSET_USD, undefined],
    ["lagging", "自营站点的收费记录读得慢，只读到 12:30，这以后的应付成本还没算。", "去设置"],
  ]);
  assert.equal(footerNotes(page(), ctx, hrefs, { coveredToMs: NOW - 10 * 60000 }).some((n) => n.key === "lagging"), false);
  assert.equal(footerNotes(page(), ctx, hrefs, { coveredToMs: NOW - 10 * 60000, behindMs: 2 * 3600000 }).some((n) => n.key === "lagging"), true);
  assert.deepEqual(footerNotes(page({ unaccountedUpstreamCostUsd: null, unlinkedChannelCount: 0, rateUnset: [] }), ctx, hrefs, null), []);
});

test("计算明细里的几句：单价每百万 Token，管理员自用扣没扣，倍率变没变", () => {
  assert.equal(unitPriceText({ input: 3, output: 15 }), "每百万 Token $3 / $15");
  assert.equal(unitPriceText({ input: 2.5, output: 10 }), "每百万 Token $2.50 / $10");
  assert.equal(unitPriceText(null), "");
  const usd = (v) => `$${v.toFixed(2)}`;
  assert.equal(adminUsageText({ usd: 0.12, deducted: "all" }, usd), "已扣除管理员自用 $0.12");
  assert.equal(adminUsageText({ usd: 0, deducted: "all" }, usd), "");
  assert.equal(adminUsageText({ usd: 0.12, deducted: "some" }, usd), "已扣除管理员自用 $0.12（部分日子没扣）");
  assert.equal(adminUsageText({ usd: null, deducted: "none" }, usd), COPY.detail.adminNone);
  const detail = (segments) => ({ expected: { groupName: "vip", groupRatio: 0.8, segments } });
  assert.equal(ratioLine(detail([]), TZ), "vip 分组 ×0.8，这天没变过");
  assert.equal(ratioLine(detail([{ startMs: dayStartInTz(D("10-25"), TZ), endMs: 0, ratio: 1 }, { startMs: dayStartInTz(D("10-25"), TZ) + 14.5 * 3600000, endMs: 0, ratio: 1.2 }]), TZ), "倍率在 14:30 从 1.0 变成 1.2，分两段算");
});

test("轮询判定：范围里含今天才轮询——「今天」、含今天的自定义 30 秒，「近 7 天」「本月」5 分钟；昨天、不含今天的自定义不轮询（审核 #128）", () => {
  const todayStart = dayStartInTz(D("10-26"), TZ);
  assert.equal(livePollMs({ preset: "today" }, NOW, TZ), LIVE_POLL_MS);
  assert.equal(LIVE_POLL_MS, 30000);
  assert.equal(livePollMs({ preset: "custom", startMs: dayStartInTz(D("10-20"), TZ), endMs: NOW }, NOW, TZ), LIVE_POLL_MS, "自定义到现在：含今天");
  assert.equal(livePollMs({ preset: "custom", startMs: dayStartInTz(D("10-20"), TZ), endMs: todayStart + 86400000 }, NOW, TZ), LIVE_POLL_MS, "自定义到今天结束：含今天");
  assert.equal(livePollMs({ preset: "custom", startMs: dayStartInTz(D("10-20"), TZ), endMs: todayStart }, NOW, TZ), null, "自定义恰好到今天 0 点为止：不含今天");
  assert.equal(livePollMs({ preset: "custom", startMs: dayStartInTz(D("10-20"), TZ), endMs: todayStart - 1 }, NOW, TZ), null);
  assert.equal(livePollMs({ preset: "custom" }, NOW, TZ), null, "自定义没给终点：不轮询");
  assert.equal(livePollMs({ preset: "yesterday" }, NOW, TZ), null, "昨天已固定");
  assert.equal(livePollMs({ preset: "yesterday" }, NOW, TZ, true), LIVE_POLL_LONG_MS, "昨天还有在读取的日子：5 分钟一次");
  assert.equal(livePollMs({ preset: "custom", startMs: dayStartInTz(D("10-20"), TZ), endMs: todayStart }, NOW, TZ, true), LIVE_POLL_LONG_MS, "不含今天的自定义也一样");
  assert.equal(livePollMs({ preset: "today" }, NOW, TZ, true), LIVE_POLL_MS, "含今天的照旧 30 秒");
  for (const preset of ["7d", "month"]) assert.equal(livePollMs({ preset }, NOW, TZ), LIVE_POLL_LONG_MS, `${preset} 含今天：和旧页面一样 5 分钟一次`);
  assert.equal(LIVE_POLL_LONG_MS, 300000);
});

test("marginText：毛利 ÷ 收入；收入是 0 或毛利算不出写「—」", () => {
  assert.equal(marginText(5.4, 14.6), "37.0%");
  assert.equal(marginText(-1, 10), "−10.0%");
  assert.equal(marginText(null, 10), EMPTY);
  assert.equal(marginText(3, 0), EMPTY);
  assert.equal(marginText(3, null), EMPTY);
});

test("footerNotes：这一版还不算利润的渠道只提示一句，最多点三个名，再多写「等 N 个渠道」", () => {
  const hrefs = { upstreams: "/stations", start: "/s", settings: "/settings" };
  const note = (unsupportedChannels) => footerNotes({ ...page(), unsupportedChannels }, ctx, hrefs).find((n) => n.key === "unsupported")?.text;
  assert.equal(note([]), undefined);
  assert.equal(note([{ channelId: 1, name: "渠道 A", reason: "KEY_IN_OTHER_UPSTREAM", upstreamNames: ["甲", "乙"], withNames: [] }]), "这一版还不算利润的渠道：「渠道 A」它的 Key 在上游「甲」「乙」里都有");
  assert.equal(note([{ channelId: 2, name: "高速 C", reason: "KEY_SHARED_WITH_MULTI_KEY", upstreamNames: [], withNames: ["高速 B"] }]), "这一版还不算利润的渠道：「高速 C」它和「高速 B」用同一把 Key");
  assert.equal(note([{ channelId: 2, name: "高速 C", reason: "KEY_SHARED_WITH_MULTI_KEY", upstreamNames: [], withNames: ["高速 B", "高速 D"] }]), "这一版还不算利润的渠道：「高速 C」它和「高速 B」等 2 个渠道用同一把 Key");
  assert.equal(note([{ channelId: 3, name: "X", reason: "MULTI_KEY", upstreamNames: [], withNames: [] }]), "这一版还不算利润的渠道：「X」它填了不止一把 Key");
  const many = [1, 2, 3, 4, 5].map((id) => ({ channelId: id, name: `渠道${id}`, reason: "MULTI_KEY", upstreamNames: [], withNames: [] }));
  assert.match(note(many), /；等 5 个渠道$/);
  assert.equal(note(many).split("；").length, 4, "点三个名 + 等 N 个");
});
