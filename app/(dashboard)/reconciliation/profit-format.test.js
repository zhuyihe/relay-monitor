// 每日利润页的纯函数（profit-format.ts）：页顶一句、四个数、渠道表的排法和每天一行、柱状图的数、合计行、原因码翻字、表下面那一行、计算明细里的几句。
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
  attentionSuffix, chartDays, dayRows, footerNotes, gapReasonText, grossMetric, metrics, nextSort, pageMoney, rangeCaption, rowMoney, sortRows, totalsRow, verifyView,
  marginText, livePollMs, LIVE_POLL_MS, LIVE_POLL_LONG_MS, signedMoney, utcOffsetText, unitPriceText, adminUsageText, ratioLine,
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

test("表下面那一行：没算进利润的上游成本、还没算利润的渠道、没设置汇率；收费记录落后 1 小时以上才写读到哪儿了", () => {
  const hrefs = { upstreams: "/stations", settings: "/settings" };
  const notes = footerNotes(page(), ctx, hrefs, { coveredToMs: NOW - 2 * 3600000 });
  assert.deepEqual(notes.map((n) => [n.key, n.text, n.link?.text]), [
    ["unaccounted", "另有 $4.20 上游成本没算进利润", "查看各上游"], ["unlinked", "还有 2 个渠道没绑定上游，没算进来。", "去上游资源"], ["rate", RATE_UNSET_USD, undefined],
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

test("footerNotes：这一版还不算利润的渠道（Key 在两个上游里都有）只提示一句，最多点三个名，再多写「等 N 个渠道」", () => {
  const hrefs = { upstreams: "/stations", settings: "/settings" };
  const note = (unsupportedChannels) => footerNotes({ ...page(), unsupportedChannels }, ctx, hrefs).find((n) => n.key === "unsupported")?.text;
  const item = (id, upstreamNames = ["甲", "乙"]) => ({ channelId: id, name: `渠道 ${id}`, reason: "KEY_IN_OTHER_UPSTREAM", upstreamNames });
  assert.equal(note([]), undefined);
  assert.equal(note([item(1)]), "这一版还不算利润的渠道：「渠道 1」它的 Key 在上游「甲」「乙」里都有");
  assert.equal(note([item(1), item(2)]), "这一版还不算利润的渠道：「渠道 1」它的 Key 在上游「甲」「乙」里都有；「渠道 2」它的 Key 在上游「甲」「乙」里都有");
  const many = [1, 2, 3, 4, 5].map((id) => item(id));
  assert.match(note(many), /；等 5 个渠道$/);
  assert.equal(note(many).split("；").length, 4, "点三个名 + 等 N 个");
});

test("footerNotes：多天范围里没算进来的天写一句", () => {
  const hrefs = { upstreams: "/stations", settings: "/settings" };
  const notes = (notCountedDays) => footerNotes({ ...page(), notCountedDays }, ctx, hrefs).map((n) => n.text);
  assert.deepEqual(notes({ count: 0 }).filter((t) => /还没固定/.test(t)), []);
  assert.ok(notes({ count: 3 }).includes("有 3 天还没固定，没算进来"));
});


// ---- 新的：渠道表、每天一行、柱状图、四个数、合计行、页顶一句、核对上游扣费的结论 ----
const day = (md, state, overrides = {}) => ({ day: D(md), state, gapUsd: null, gapState: null, reason: null, tokens: null, incomeUsd: null, actualCostUsd: null, grossUsd: null, ...overrides });
const fixedDay = (md, income, cost) => day(md, "fixed", { incomeUsd: income, actualCostUsd: cost, grossUsd: income - cost });
const chan = (name, income, cost, extra = {}) => row({ rowKey: name, channels: [{ channelId: name.length, name }], incomeUsd: income, actualCostUsd: cost, grossProfitUsd: income - cost, ...extra });

test("渠道表默认按毛利从高到低，亏钱的在后面；没算进利润的行排最后；点表头换列、再点换方向，名字从小到大", () => {
  const rows = [chan("丙", 10, 12), chan("甲", 50, 20), chan("乙", 30, 10), chan("丁", 99, 0, { counted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, uncountedIncomeUsd: 99 })];
  const names = (sort) => sortRows(rows, sort, ctx).map((r) => r.channels[0].name);
  assert.deepEqual(names({ key: "gross", dir: "desc" }), ["甲", "乙", "丙", "丁"], "毛利 30、20、−2，没算进来的排最后");
  assert.deepEqual(names({ key: "gross", dir: "asc" }), ["丙", "乙", "甲", "丁"], "反过来，没算进来的还是最后");
  assert.deepEqual(names({ key: "margin", dir: "desc" }), ["乙", "甲", "丙", "丁"], "毛利率 66.7%、60%、−20%");
  assert.deepEqual(names({ key: "income", dir: "desc" }), ["丁", "甲", "乙", "丙"], "收入没算进来的也读得到（排第一）");
  assert.deepEqual(names({ key: "name", dir: "asc" }).length, 4);
  assert.deepEqual(nextSort({ key: "gross", dir: "desc" }, "gross"), { key: "gross", dir: "asc" });
  assert.deepEqual(nextSort({ key: "gross", dir: "asc" }, "gross"), { key: "gross", dir: "desc" });
  assert.deepEqual(nextSort({ key: "gross", dir: "desc" }, "income"), { key: "income", dir: "desc" });
  assert.deepEqual(nextSort({ key: "gross", dir: "desc" }, "name"), { key: "name", dir: "asc" });
});

test("点开一个渠道：一天一行，新的在上；已固定写已固定、今天和还在读取写实时、需处理写需处理；没开始算、还没到的不列；亏钱标出来", () => {
  const r = chan("甲", 100, 60, { daily: [day("10-22", "notStarted"), fixedDay("10-23", 20, 30), day("10-24", "attention", { reason: "OWN_CONSUME_LOG_GAP" }), fixedDay("10-25", 40, 25),
    day("10-26", "today", { incomeUsd: 8, actualCostUsd: 5, grossUsd: 3 }), day("10-27", "future")] });
  const rows = dayRows(r, weekPage({ rows: [r] }), ctx);
  assert.deepEqual(rows.map((x) => [x.label.split(" ")[0], x.state, x.stateText, x.income, x.actual, x.gross, x.margin, x.negative]), [
    ["10月26日", "live", "实时", "$8.00", "$5.00", "$3.00", "37.5%", false],
    ["10月25日", "fixed", "已固定", "$40.00", "$25.00", "$15.00", "37.5%", false],
    ["10月24日", "attention", "需处理", EMPTY, EMPTY, EMPTY, EMPTY, false],
    ["10月23日", "fixed", "已固定", "$20.00", "$30.00", "−$10.00", "−50.0%", true],
  ]);
  assert.match(rows[0].label, /今天$/, "今天写「今天」，别的天写周几");
  assert.match(rows[1].label, /周[日一二三四五六]$/);
});

test("每天的毛利：多天才有；一天 = 算进利润的渠道这天的数相加；今天和没固定的天浅色；需处理没算进来的渠道不加；一个数都没有的天不画", () => {
  assert.deepEqual(chartDays(page(), ctx), [], "一天的范围不画");
  const a = chan("甲", 100, 60, { daily: [fixedDay("10-24", 10, 4), fixedDay("10-25", 20, 12), day("10-26", "today", { incomeUsd: 5, actualCostUsd: 2, grossUsd: 3 })] });
  const b = chan("乙", 50, 30, { daily: [fixedDay("10-24", 6, 1), day("10-25", "reading"), day("10-26", "today", { incomeUsd: 1, actualCostUsd: 1, grossUsd: 0 })] });
  const held = chan("丙", null, null, { counted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, daily: [fixedDay("10-24", 1000, 1)] });
  const days = chartDays(weekPage({ range: { ...weekPage().range, startMs: dayStartInTz(D("10-24"), TZ) }, rows: [a, b, held] }), ctx);
  assert.deepEqual(days.map((x) => [x.day, x.income, x.actual, x.gross, x.light, x.stateText]), [
    [D("10-24"), 16, 5, 11, false, "已固定"],
    [D("10-25"), 20, 12, 8, true, "实时"],
  ].concat([[D("10-26"), 6, 3, 3, true, "实时"]]), "10-25 乙还在读取：这天没固定，用浅色，只加有数的渠道");
  assert.deepEqual(days.map((x) => x.margin), ["68.8%", "40.0%", "50.0%"]);
});

test("四个数：收入、上游成本、毛利、毛利率；按人民币时各行按各自汇率换算再加", () => {
  assert.deepEqual(metrics(page(), ctx).map((m) => [m.title, m.value]), [["收入", "$103.70"], ["上游成本", "$64.51"], ["毛利", "$39.19"], ["毛利率", "37.8%"]]);
  const cny = { currency: "CNY", tz: TZ, now: NOW };
  const r = row({ rates: { income: 7, cost: 6, costBasis: "usage" } });
  const m = rowMoney(r, "CNY");
  assert.deepEqual([m.income, m.actual, m.gross.toFixed(2)], [14.6 * 7, 9.2 * 6, (14.6 * 7 - 9.2 * 6).toFixed(2)]);
  assert.equal(pageMoney(page({ rows: [r] }), "CNY").income, 14.6 * 7);
  assert.equal(signedMoney(-0.5, "CNY"), "−¥0.50");
  assert.deepEqual(metrics(page({ rows: [r] }), cny).map((x) => x.value).slice(0, 3), ["¥102.20", "¥55.20", "¥47.00"]);
  assert.equal(metrics(page({ rows: [], pageTotals: { incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, grossMarginRate: null } }), ctx)[3].value, EMPTY, "没有渠道算进来：毛利率写「—」");
});

test("合计行：只加算进来的渠道；已固定又因为重算需处理、照算进来的，括号里补一句", () => {
  assert.deepEqual(totalsRow(page(), ctx), { label: "合计（算进来的 6 个渠道）", income: "$103.70", actual: "$64.51", gross: "$39.19", margin: "37.8%" });
  const held = row({ attention: { code: "RESETTLE_SHRUNK", title: "t", detail: null, action: null, fromDay: null, moreCount: 0, shrunk: null } });
  assert.equal(totalsRow(page({ rows: [held] }), ctx).label, "合计（算进来的 6 个渠道；其中 1 个还没重算，先按原来固定的数算）");
});

test("页顶一句：需处理没算进来的渠道接在后面——单天「其中 N 个渠道需处理，没算进来」，多天「其中 N 个渠道有 M 天需处理，没算进来」；算进来的、没有需处理的不接", () => {
  const out = chan("丙", null, null, { counted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, excludedDays: 3, channels: [{ channelId: 1, name: "丙" }, { channelId: 2, name: "丁" }],
    attention: { code: "OWN_BILLING_UNAVAILABLE", title: "t", detail: null, action: null, fromDay: null, moreCount: 0, shrunk: null } });
  assert.equal(attentionSuffix(page()), "");
  assert.equal(rangeCaption(page({ rows: [out] }), ctx).endsWith(" · 其中 2 个渠道需处理，没算进来"), true, "按渠道数，同一把 Key 的两个渠道算 2 个");
  assert.equal(rangeCaption(weekPage({ rows: [out] }), ctx), "10月20日–10月26日 · 6 天已固定，今天实时 · 其中 2 个渠道需处理，没算进来", "多天也只写渠道数：现在整个渠道整段不进合计，写天数会让人以为只少了几天");
  const one = chan("戊", null, null, { counted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, excludedDays: 2, attention: out.attention });
  assert.equal(attentionSuffix(weekPage({ rows: [one, { ...one, excludedDays: 3 }] })), "其中 2 个渠道需处理，没算进来");
  // 提示类的（今天提醒换 Key，照常算进来）：再接一句，和需处理的那句用「 · 」隔开
  const hint = row({ notice: { code: "CHANNEL_KEY_IDLE_TODAY", text: "t", detail: null, action: null } });
  assert.equal(attentionSuffix(page({ rows: [hint] })), "其中 1 个渠道成本可能少算了");
  assert.equal(attentionSuffix(page({ rows: [hint, out] })), "其中 2 个渠道需处理，没算进来 · 其中 1 个渠道成本可能少算了");
  assert.equal(rangeCaption(todayPage({ rows: [out] }), ctx), "10月26日 0:00–14:30 · 今天的数还会变，过了零点自动固定 · 其中 2 个渠道需处理，没算进来");
  assert.equal(attentionSuffix(page({ rows: [row({ attention: out.attention })] })), "", "算进来的行（已固定又需处理）不算没算进来");
});

test("「核对上游扣费」的结论：对得上、多扣 / 少扣、换了 Key、今天；对不上的默认展开，别的收起", () => {
  const base = (gap, expected = {}) => ({ day: D("10-25"), settled: true, gap, expected: { reason: null, missingPriceModels: [], ...expected } });
  const p = page();
  assert.deepEqual(verifyView(base({ usd: 9.26, rate: 0.085, state: "over" }), p, ctx, null), { text: "多扣 $9.26，对不上", open: true, tone: "crit" });
  assert.deepEqual(verifyView(base({ usd: -0.7, rate: -0.05, state: "under" }), p, ctx, null), { text: "少扣 $0.70，对不上", open: true, tone: "crit" });
  assert.deepEqual(verifyView(base({ usd: 0.01, rate: 0, state: "within" }), p, ctx, null), { text: "对得上", open: false, tone: null });
  assert.deepEqual(verifyView(base(null, { reason: "KEY_CHANGE_RATIO_DIFFERS" }), p, ctx, null), { text: "这天换了 Key，不比差额", open: false, tone: null });
  assert.deepEqual(verifyView(base(null, { reason: "KEY_SHARED" }), p, ctx, null), { text: "这把 Key 别处也在用", open: false, tone: null });
  assert.deepEqual(verifyView({ ...base(null), day: p.today }, p, ctx, null), { text: "明天出", open: false, tone: null });
  assert.equal(verifyView(base({ usd: 1, rate: 0.1, state: "over" }), p, { ...ctx, currency: "CNY" }, 6).text, "多扣 ¥6.00，对不上");
});

test("运营总览的毛利一格（grossMetric）：今天、已固定、近 7 天各一套标题；收入 − 上游成本、毛利率、净利三行照旧", () => {
  const today = grossMetric(todayPage(), ctx);
  assert.deepEqual([today.title, today.value], ["今天到现在的毛利", "$39.19"]);
  assert.deepEqual(today.lines, ["收入 $103.70 − 上游成本 $64.51", "毛利率 37.8%", "扣今天的固定成本 $2.33 后，净利 $36.86"]);
  assert.equal(grossMetric(page(), ctx).lines[2], "扣固定成本 $2.33 后，净利 $36.86");
  assert.equal(grossMetric(weekPage(), ctx).title, "近 7 天毛利");
  assert.equal(grossMetric(page({ fixedCostUsd: null, netProfitUsd: null }), ctx).lines[2], "固定成本算不出，净利先不算");
  const cny = { currency: "CNY", tz: TZ, now: NOW };
  assert.equal(grossMetric(page({ rows: [row({ rates: { income: 7, cost: 6, costBasis: "usage" } })] }), cny).lines[2], "扣固定成本 ≈ ¥16.31 后，净利 ≈ ¥" + (14.6 * 7 - 9.2 * 6 - 2.33 * 7).toFixed(2));
});
