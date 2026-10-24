// Start the local dev server first. Set PLAYWRIGHT_MODULE to a Playwright module
// path when it is bundled outside this project, and PLAYWRIGHT_CHANNEL=msedge
// when Chromium is unavailable locally.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import { deriveKnownChannelCoverage, reconciliationAccountingStartText, reconciliationNotCountedCostText, reconciliationRowFlags, summarizeReconciliationWindowGroups, summarizeUnaccountedUpstream } from "../lib/reconciliation-view.js";
import { BINDING_COPY, CREDENTIAL_FIELDS, ONBOARDING_KEY_ONLY_MONITOR, ONBOARDING_PURPOSES, ONBOARDING_PURPOSE_HINT, ONBOARDING_PURPOSE_REQUIRED, SECRET_FIELD_TEXT, UPSTREAM_FORM_TEXT, UPSTREAM_TYPES, normalizeBatchInput } from "../lib/channel-onboarding.js";
import { ADMIN_UNMARKED, BALANCE_STATE_TEXT, EMPTY, basisText, FIXED_COST_TEXT, INCOME_UNREAD, MINUS, NO_UPSTREAM_TEXT, OWN_STATION_UNSET, OWN_STATION_UNSET_TITLE, RANGE_TEXT, formatDayKey, RATE_UNSET_PARITY, RATE_UNSET_USD, SELL_PRICE_UNSET, formatAsOf, formatCompact, formatDayZone, formatRate, formatSellPrice, formatZonedDateTime, formatZonedTime, formatZonedWindow, formatMoney, refreshFailedText } from "../lib/format.js";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, INCOMPLETE_DAY_TEXT, fillIssueCopy, reconciliationChannelStatus, reconciliationCoverageText, reconciliationIssue } from "../lib/reconciliation-contract.js";
import { DESTINATION_CHANGED, HISTORY_KEPT, testReadText, workflowAction, workflowActionMeta } from "../lib/workflow-actions.js";
import { CONSOLE_UNREACHABLE, ERROR_CATEGORIES, describeError, errorText, failureSentence, failureText } from "../lib/error-copy.js";
import { NAV_LABELS, STATION_TABS } from "../lib/brand.js";
import { CHANNEL_TYPES } from "../lib/notify.js";
// 成本估算、用量分析页上的字（页面文件不能导出，放在同目录的 copy.ts；node 直接读 .ts）
import { COPY as ANALYTICS_COPY } from "../app/(dashboard)/analytics/copy.ts";
import { COPY as USAGE_COPY } from "../app/(dashboard)/usage/copy.ts";
import { COPY as SETTINGS_COPY } from "../app/(dashboard)/settings/copy.ts";
import { COPY as NOTIFICATIONS_COPY } from "../app/(dashboard)/notifications/copy.ts";
import { COPY as LOGIN_COPY } from "../app/login/copy.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
// 一个测试进程共用一个浏览器：每条用例开自己的 context（cookie、存储、时钟互不影响），用完关掉 context，
// 进程里的用例都跑完再关浏览器。原来每条用例都单独启动、关闭一次浏览器，这占了每条时间的一大块。
// 用例中途要关掉某个页面时关它的 context（page.context().close()），不要关浏览器
let sharedBrowser = null;
async function launchBrowser() {
  const current = await sharedBrowser?.catch(() => null);
  if (current?.isConnected()) return current;
  sharedBrowser = chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chromium" });
  return sharedBrowser;
}
after(async () => { await (await sharedBrowser?.catch(() => null))?.close().catch(() => {}); });
// 走过加载的按钮：antd 按钮的加载图标退场动画常停在半截（机器忙、打包版里更常见），图标宽 0、透明，看不见，
// 却留在按钮里（aria-label="loading"），按钮已经不在加载了，无障碍名字却成了「loading 确认绑定」。
// settleButtonLookups 让 getByRole("button", { name: "…", exact: true }) 在原来的准确名字之外，只多认这一种：
// 名字是「loading 名字」、按钮又不在加载（没有 ant-btn-loading）。真在加载的按钮照旧找不到，和原来按准确名字找一样，
// 点击、isEnabled、waitFor 都会等到加载结束；用 aria-label 起名的按钮名字不受图标影响，照旧随时找得到。
// 每条用例开页面时调用（两处 newPage），新写的用例不用再记着；找按钮一律写准确名字，不另写正则
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let buttonLookupsSettled = false;
function settleButtonLookups(page) {
  if (buttonLookupsSettled) return;
  buttonLookupsSettled = true;
  for (const proto of [Object.getPrototypeOf(page), Object.getPrototypeOf(page.locator("body")), Object.getPrototypeOf(page.frameLocator("iframe"))]) {
    const getByRole = proto.getByRole;
    proto.getByRole = function (role, options) {
      const exact = getByRole.call(this, role, options);
      if (role !== "button" || !options?.exact || typeof options.name !== "string") return exact;
      const stuck = getByRole.call(this, role, { ...options, name: new RegExp(`^loading ${escapeRegExp(options.name)}$`), exact: false });
      return exact.or(stuck.and(this.locator(":not(.ant-btn-loading)")));
    };
  }
}
const baseURL = process.env.RECONCILIATION_UI_BASE_URL || "http://127.0.0.1:3099";

const window = { preset: "yesterday", startMs: 1791388800000, endMs: 1791475200000, timezone: "Asia/Shanghai" };
const billingSource = { stationId: "own-1", provider: "newapi", baseUrl: "https://own.test", accountId: "1", namespaceKey: "d1a1290bfda92d88694126df4ddb3d0f26a6cca87938341857157cd4cc399d83" };
const amountBasis = { id: "channel-billing-usd-v3", currency: "USD", billingSource: "channel-log-stat", calculationVersion: 3, conversion: "quota_per_unit" };

function rule(id, name, amount, resultWindow = window) {
  return {
    rule: { id, tokenName: name, upstreamStationId: "upstream-1", ownStationId: "own-1", ownSource: billingSource, enabled: true, costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] }, fixedGroup: "default", channels: [{ channelId: Number(id.slice(-1)), name: `Channel ${id}` }] },
    ownSource: billingSource, amountBasis, billingTimezone: { state: "verified", timezone: resultWindow.timezone }, scope: { scopeVersion: 1, billingEffectiveFromMs: 1791302400000, firstFullDayStartMs: 1791302400000, firstQueryableAtMs: 1791388800000 }, actions: [],
    requestedWindow: resultWindow,
    window: resultWindow,
    downstream: { state: "complete", calculationVersion: 3, billingSource: "channel-log-stat", amountUsd: amount, knownAmountUsd: amount, successfulCount: 1, expectedCount: 1, window: resultWindow, channels: [{ channelId: Number(id.slice(-1)), name: `Channel ${id}`, state: "enabled", billingState: "complete", amountUsd: amount, knownAmountUsd: amount }] },
    upstream: { state: "complete", calculationVersion: 3, amountUsd: 1, knownAmountUsd: 1, countedAmountUsd: 1, ownershipState: "unique", successfulCount: 1, expectedCount: 1, group: "default", window: resultWindow },
    calculation: { profitUsd: amount - 1, marginRate: (amount - 1) / amount },
    health: { code: "READY", issues: [] },
    lastSuccessfulAt: "2026-10-08T00:00:00.000Z",
  };
}

const configuration = {
  ownStation: { id: "own-1", cnyPerUsd: null },
  upstreams: [{ id: "upstream-1", name: "Fixture upstream" }],
  channels: [],
  rules: [rule("rule-1", "Rule A", 10).rule, rule("rule-2", "Rule B", 20).rule, rule("rule-3", "Rule C", 30).rule],
};

function response(results) {
  const rules = results.map((row) => row.rule), channels = [...new Map(rules.flatMap((row) => row.channels).map((channel) => [channel.channelId, { ...channel, status: 1 }])).values()];
  const catalogue = { ownSource: billingSource, stale: false, totalValidated: true, catalogueTotal: channels.length, channels };
  const isCompletedWindow = (range) => range.preset !== "today" && range.endMs - range.startMs >= 23 * 3600000;
  const coverage = deriveKnownChannelCoverage(catalogue, rules, results, { isCompletedWindow });
  const grouped = summarizeReconciliationWindowGroups(results, { isCompletedWindow, coverageFor: (range) => deriveKnownChannelCoverage(catalogue, rules, results, { window: range, isCompletedWindow }) });
  return { generatedAt: "2026-10-09T03:00:00.000Z", results, ...grouped, coverage, actions: [] };
}
function cachedResponse(model, rows) { Object.assign(model, response(model.results.map((row) => rows.find((next) => next.rule.id === row.rule.id) || row))); return response(rows); }

function dailyRows(resultWindow = window) { return [rule("rule-1", "Rule A", 2.5, resultWindow), rule("rule-2", "Rule B", 2.5, resultWindow), rule("rule-3", "Rule C", 2.5, resultWindow)]; }
function dailyResponse(rows = dailyRows(), options = {}) {
  const rules = options.rules || rows.map((row) => row.rule);
  const catalogue = { ownSource: billingSource, stale: false, totalValidated: true, catalogueTotal: 10, channels: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}`, status: 1 })), ...options.catalogue };
  const isCompletedWindow = (range) => range.preset !== "today" && range.endMs - range.startMs >= 23 * 3600000;
  const coverage = deriveKnownChannelCoverage(catalogue, rules, rows, { isCompletedWindow });
  const currency = options.displayCurrency || "USD";
  const grouped = summarizeReconciliationWindowGroups(rows, { currency, isCompletedWindow, coverageFor: (range, source) => deriveKnownChannelCoverage(catalogue, rules.filter((rule) => rule.ownSource?.namespaceKey === source?.namespaceKey), rows.filter((row) => row.ownSource?.namespaceKey === source?.namespaceKey), { window: range, isCompletedWindow }) });
  const extra = { displayCurrency: currency, unconfiguredRateStations: options.unconfiguredRateStations || [], fixedOffProfitStations: options.fixedOffProfitStations || [],
    ...(options.unaccountedUpstream ? { unaccountedUpstream: options.unaccountedUpstream } : {}) };
  return { generatedAt: "2026-10-09T03:00:00.000Z", results: rows, ...grouped, coverage, actions: coverage.channels.flatMap((channel) => channel.actions), ...extra };
}
async function openDailyPage(t, options = {}) {
  const reads = [], queries = [], initial = options.data || dailyResponse();
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, { ...configuration, ownStation: { id: "own-1", cnyPerUsd: 7 }, ...(options.upstreams ? { upstreams: options.upstreams } : {}), rules: initial.results.map((row) => row.rule) });
    if (url.pathname === "/api/reconciliation") { reads.push(Object.fromEntries(url.searchParams)); return options.read ? options.read(route, reads.length, initial) : fulfill(route, initial); }
    if (url.pathname === "/api/reconciliation/query") { const body = route.request().postDataJSON(); queries.push(body); return options.query ? options.query(route, body, initial) : fulfill(route, initial); }
    if (url.pathname.endsWith("/segments")) return fulfill(route, { segments: options.segments || [] });
    if (options.extraAPI) return options.extraAPI(route, url.pathname);
    throw new Error("unexpected daily fixture API: " + url.pathname);
  }, options.viewport, false, null, options.path);
  return { page, reads, queries, initial };
}
// 页面上的话都来自共用的常量和函数（design/ui-copy-spec.md），这里只填测试数据对应的数字
const coverageText = (known, accounted) => reconciliationCoverageText({ knownChannelCount: known, accountedChannelCount: accounted });
// 汇总里的一项：按标签整句找，「上游成本」不会找到「没算进利润的上游成本」，「毛利」不会找到「毛利率」
const summaryMetric = (scope, label) => scope.locator(".reconciliation-summary-metric").filter({ has: scope.page().getByText(label, { exact: true }) });
// 计算明细里一项的值
const detailValue = (scope, label) => scope.locator(".reconciliation-detail").filter({ has: scope.page().getByText(label, { exact: true }) }).locator(".reconciliation-detail__value");

test("changing a past transition reports saved time without claiming fixed days were recalculated", async (t) => {
  let saved = 0;
  const segment = { id: "past-transition", group: "default", ratio: 1, timingSource: "detected",
    effectiveFrom: window.startMs, effectiveTo: null };
  const { page } = await openDailyPage(t, {
    segments: [segment],
    query: (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture reload failed" }) }),
    extraAPI(route, path) {
      if (path !== "/api/reconciliation/rules/rule-1/transitions/past-transition") throw new Error("unexpected daily fixture API: " + path);
      assert.equal(route.request().method(), "PUT");
      saved += 1;
      return fulfill(route, { segments: [segment] });
    },
  });
  await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true });
  const timing = drawer.getByRole("region", { name: "改时间", exact: true });
  await timing.waitFor();
  await timing.getByText("保存后，未固定的结果按新时间计算。系统会尝试更新昨天的固定记录，更早的固定记录暂不自动更新。", { exact: true }).waitFor();
  const input = timing.getByPlaceholder("倍率变化的时间");
  await input.fill("2026年10月8日 09:30");
  await input.press("Enter");
  await timing.getByRole("button", { name: "改时间", exact: true }).click();
  await page.getByText("时间已修改，但最新结果没读到，请重新读取", { exact: true }).waitFor();
  assert.equal(saved, 1);
  assert.equal(await page.getByText("已修改，受影响的日子已重算", { exact: true }).count(), 0);
});

test("daily billing defaults to complete yesterday and global 3/10 coverage survives search and status filters", async (t) => {
  const { page, reads } = await openDailyPage(t); const summary = page.getByRole("region", { name: "汇总", exact: true });
  assert.deepEqual(reads[0], { preset: "yesterday" }); await summary.getByText("$7.50", { exact: true }).waitFor(); await summary.getByText("$4.50", { exact: true }).waitFor(); assert.equal(await summary.getByText(/¥/).count(), 0);
  const coverage = page.getByRole("region", { name: "渠道", exact: true }); await coverage.getByText(coverageText(10, 3), { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "搜索上游、Key、渠道名或渠道 ID", exact: true }).fill("Rule A"); assert.equal(await page.locator("tr.ant-table-row").count(), 1); await summary.getByText("$7.50", { exact: true }).waitFor();
  await page.getByRole("group", { name: "状态筛选" }).getByRole("button", { name: "亏损 0", exact: true }).click(); await page.getByText("没有匹配的绑定", { exact: true }).waitFor(); await coverage.getByText(coverageText(10, 3), { exact: true }).waitFor();
  await coverage.locator(".ant-collapse-header", { hasText: "查看没算进来的" }).click(); await coverage.getByText("渠道 9", { exact: true }).waitFor(); assert.ok((await coverage.textContent()).includes("没绑定")); assert.equal(reads.length, 1);
});

// 3b：汇率都设置了才整页按人民币；收费按本站汇率、成本按该上游汇率；固定采购成本记 0
const ratedUpstreams = [...configuration.upstreams, { id: "fixed-1", name: "Fixed upstream" }];
const configuredRate = (stationId, cnyPerUsd) => ({ stationId, cnyPerUsd, source: "configured" });
const defaultRate = (stationId) => ({ stationId, cnyPerUsd: 1, source: "default" });
function ratedDailyRows() {
  const rows = dailyRows();
  for (const row of rows) row.rates = { income: configuredRate("own-1", 7), cost: configuredRate("upstream-1", 6), costBasis: "usage" };
  rows[2].rule.upstreamStationId = "fixed-1"; rows[2].rates = { income: configuredRate("own-1", 7), cost: configuredRate("fixed-1", 6), costBasis: "fixed" };
  return rows;
}
function unaccountedFor(rows, currency, usage = { usd: 4, mode: "usage" }) {
  const summarized = summarizeUnaccountedUpstream([{ station: { id: "upstream-1", name: "Fixture upstream" }, rate: configuredRate("upstream-1", 6), usage }], rows, { currency });
  return { ...summarized, window, fixedStations: [{ id: "fixed-1", name: "Fixed upstream" }], excludedStations: [] };
}

test("3b daily page switches to yuan only when every station has a rate, with fixed purchases at zero cost", async (t) => {
  const rows = ratedDailyRows();
  const { page } = await openDailyPage(t, { upstreams: ratedUpstreams, data: dailyResponse(rows, { displayCurrency: "CNY", unaccountedUpstream: unaccountedFor(rows, "CNY") }) });
  const summary = page.getByRole("region", { name: "汇总", exact: true }), metric = (label) => summaryMetric(summary, label);
  await metric("收入").getByText("¥52.50", { exact: true }).waitFor(); await metric("上游成本").getByText("¥12.00", { exact: true }).waitFor(); await metric("毛利").getByText("¥40.50", { exact: true }).waitFor();
  assert.doesNotMatch(await summary.locator(".reconciliation-summary__metrics").innerText(), /\$/);
  // 页脚：已固定的日子按固定时记下的汇率，其余按各自设置的汇率；有包月上游的绑定时说明上游成本写「计入固定成本」，净利去自营业务看
  await summary.getByText("按各自设置的汇率换算成人民币（已固定的日子按固定时记下的汇率）。").waitFor();
  await summary.getByText(`包月上游的上游成本写「${FIXED_COST_TEXT}」；扣掉固定成本后的净利见${NAV_LABELS.my}。`).waitFor();
  assert.equal(await summary.getByRole("link", { name: NAV_LABELS.my, exact: true }).getAttribute("href"), "/my");
  const rowA = page.locator("tr.ant-table-row", { hasText: "Rule A" }), rowC = page.locator("tr.ant-table-row", { hasText: "Rule C" });
  await rowA.getByText("¥17.50", { exact: true }).waitFor(); await rowA.getByText("¥6.00", { exact: true }).waitFor(); await rowA.getByText("¥11.50", { exact: true }).waitFor();
  // 包月上游的上游成本一格只写「计入固定成本」，不写金额（§3.2）；毛利 = 收入
  await rowC.getByText("Fixed upstream", { exact: true }).waitFor(); assert.equal(await rowC.locator(".reconciliation-table-amount", { hasText: FIXED_COST_TEXT }).innerText(), FIXED_COST_TEXT); assert.equal(await rowC.getByText("¥17.50", { exact: true }).count(), 2);
  // 没算进利润的上游成本：上游扣费 $4 − 已算进利润 $2，按该上游汇率 6 折算
  const unaccounted = summary.getByRole("region", { name: "没算进利润的上游成本", exact: true });
  await unaccounted.locator(".reconciliation-summary-metric").getByText("¥12.00", { exact: true }).waitFor(); await unaccounted.getByText("计入固定成本的上游不在这里：Fixed upstream。").waitFor();
  await unaccounted.locator(".ant-collapse-header", { hasText: "查看各上游" }).click(); await unaccounted.getByText("上游扣费 ¥24.00 · 已算进利润 ¥12.00 · 没算进利润 ¥12.00", { exact: true }).waitFor(); await unaccounted.getByText(formatRate(6), { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click(); let drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true });
  await detailValue(drawer, "汇率").getByText(`收入按 ${formatRate(7)}，上游成本按 ${formatRate(6)}`, { exact: true }).waitFor();
  // 计算明细只写白话（§9）：上游成本按上游汇率折算、写明来自哪把 Key 的用量；毛利按两边分别折算后相减
  assert.match(await detailValue(drawer, "上游成本").innerText(), /^¥6\.00\s*来自 Key「Rule A」的用量记录$/); assert.equal(await detailValue(drawer, "毛利").innerText(), "¥11.50"); await drawer.locator(".ant-drawer-close").click();
  await page.getByRole("button", { name: "查看 Rule C 的计算明细", exact: true }).click(); drawer = page.getByRole("dialog", { name: "Rule C · 计算明细", exact: true });
  assert.equal(await detailValue(drawer, "上游成本").innerText(), FIXED_COST_TEXT); assert.equal(await detailValue(drawer, "汇率").innerText(), formatRate(7));
  // 看「今天」时，去自营业务的链接也带上今天
  await drawer.locator(".ant-drawer-close").click();
  await page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "今天", exact: true }).filter({ visible: true }).click();
  await summary.locator('a[href="/my?range=today"]', { hasText: NAV_LABELS.my }).waitFor();
  assert.doesNotMatch(await summary.innerText(), new RegExp(`${NAV_LABELS.my}也不算`));
  // 包月上游暂停监控、不算进利润或已归档时，自营业务也不算它的固定成本，按服务端给出的上游点名
  const offProfit = await openDailyPage(t, { upstreams: ratedUpstreams, data: dailyResponse(rows, { displayCurrency: "CNY", fixedOffProfitStations: [{ id: "fixed-1", name: "Fixed upstream" }],
    unaccountedUpstream: { ...unaccountedFor(rows, "CNY"), fixedStations: [] } }) });
  await offProfit.page.getByRole("region", { name: "汇总", exact: true }).getByText(`其中「Fixed upstream」暂停监控、不算进利润或已归档，${NAV_LABELS.my}也不算它的固定成本。`).waitFor();
  const twoOff = await openDailyPage(t, { upstreams: ratedUpstreams, data: dailyResponse(rows, { displayCurrency: "CNY",
    fixedOffProfitStations: [{ id: "fixed-1", name: "Fixed upstream" }, { id: "fixed-2", name: "Second fixed" }], unaccountedUpstream: { ...unaccountedFor(rows, "CNY"), fixedStations: [] } }) });
  await twoOff.page.getByRole("region", { name: "汇总", exact: true }).getByText(`其中「Fixed upstream」、「Second fixed」暂停监控、不算进利润或已归档，${NAV_LABELS.my}也不算它们的固定成本。`).waitFor();
});

test("3b partially configured rates keep system dollars everywhere and name the stations still missing a rate", async (t) => {
  const rows = ratedDailyRows(); for (const row of rows.slice(0, 2)) row.rates.cost = defaultRate("upstream-1");
  const { page } = await openDailyPage(t, { upstreams: ratedUpstreams, data: dailyResponse(rows, { unconfiguredRateStations: [{ id: "upstream-1", name: "Fixture upstream" }], unaccountedUpstream: unaccountedFor(rows, "USD") }) });
  await page.getByText(RATE_UNSET_USD, { exact: true }).waitFor(); await page.getByText("没设置汇率的：Fixture upstream", { exact: true }).waitFor();
  const summary = page.getByRole("region", { name: "汇总", exact: true }), metric = (label) => summaryMetric(summary, label);
  await metric("收入").getByText("$7.50", { exact: true }).waitFor(); await metric("上游成本").getByText("$2.00", { exact: true }).waitFor(); await metric("毛利").getByText("$5.50", { exact: true }).waitFor();
  await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("$1.50", { exact: true }).waitFor(); assert.equal(await page.locator("tr.ant-table-row", { hasText: "Rule C" }).locator(".reconciliation-table-amount", { hasText: FIXED_COST_TEXT }).innerText(), FIXED_COST_TEXT);
  await summary.getByRole("region", { name: "没算进利润的上游成本", exact: true }).locator(".reconciliation-summary-metric").getByText("$2.00", { exact: true }).waitFor();
  await summary.getByText(new RegExp(`${RATE_UNSET_USD}。.*包月上游的上游成本写「${FIXED_COST_TEXT}」`)).waitFor();
  assert.doesNotMatch(await page.locator(".reconciliation-page").innerText(), /¥/);
  // 一个汇率都没设置时不提示
  const next = await openDailyPage(t, { data: dailyResponse(dailyRows()) }); await next.page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("$2.50", { exact: true }).waitFor(); assert.equal(await next.page.getByText(RATE_UNSET_USD, { exact: true }).count(), 0);
  assert.equal(await next.page.getByText(/包月上游的上游成本写/).count(), 0, "没有包月上游的绑定时不提");
});

test("3b live today rows share one window although each stops at its own fetch time", async (t) => {
  const start = window.endMs, rows = dailyRows({ ...window, preset: "today", startMs: start, endMs: start + 3 * 3600000 });
  const later = { ...rows[1].window, endMs: start + 3 * 3600000 + 1500 };
  Object.assign(rows[1], { window: later, requestedWindow: later }); rows[1].downstream.window = rows[1].upstream.window = later;
  const { page } = await openDailyPage(t, { data: dailyResponse(rows) });
  // 三条请求的是同一个「今天」，只出一份汇总，不逐组列出；日期取最早的截止点
  await summaryMetric(page.getByRole("region", { name: "汇总", exact: true }), "收入").getByText("$7.50", { exact: true }).waitFor(); assert.equal(await page.locator(".reconciliation-window-groups").count(), 0);
  assert.equal(await page.locator(".reconciliation-window").innerText(), formatZonedWindow({ ...window, preset: "today", startMs: start, endMs: start + 3 * 3600000 }));
  assert.equal(await page.getByText("这几条绑定没法放在一起汇总，分开写在下面", { exact: true }).count(), 0);
});

test("3b pending upstream account usage re-reads silently at most three times, and refresh starts a new round", async (t) => {
  const reads = [], queries = [], completedReads = new Set(), rows = ratedDailyRows();
  const respond = (usage) => ({ ...dailyResponse(rows, { unaccountedUpstream: unaccountedFor(rows, "USD", usage) }), generatedAt: new Date(Date.now()).toISOString() });
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, { ...configuration, rules: rows.map((row) => row.rule) });
    if (url.pathname === "/api/reconciliation") {
      const readNo = reads.push(Object.fromEntries(url.searchParams));
      // 重读慢一点返回，读取期间检查汇总没有切到「仅供参考」
      if (readNo > 1) await new Promise((resolve) => setTimeout(resolve, 400));
      await fulfill(route, respond(readNo >= 5 ? { usd: 4, mode: "usage" } : null));
      completedReads.add(readNo);
      return;
    }
    if (url.pathname === "/api/reconciliation/query") { queries.push(route.request().postDataJSON()); return fulfill(route, respond(null)); }
    throw new Error("unexpected API: " + url.pathname);
  }, undefined, true);
  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await settle(20); assert.ok(check()); };
  const advanceUntilRead = async (expected) => {
    // 请求响应后，React 才安排下一轮。小步推进并让出事件循环，不假设固定延迟已足够应用响应。
    for (let i = 0; i < 150 && reads.length < expected; i += 1) {
      await page.clock.fastForward(100);
      await settle(20);
    }
    assert.equal(reads.length, expected);
    await until(() => completedReads.has(expected));
  };
  const summary = page.getByRole("region", { name: "汇总", exact: true }), unaccounted = summary.getByRole("region", { name: "没算进利润的上游成本", exact: true });
  await unaccounted.getByText("读取中", { exact: true }).first().waitFor(); await unaccounted.getByText(/上游暂时读不到，系统会自动再读。/).waitFor(); assert.equal(reads.length, 1);
  for (const expected of [2, 3, 4]) {
    await advanceUntilRead(expected);
    // 只重读上游扣费，汇总不提示「读取中」或刷新失败
    assert.equal(await summary.locator(".ant-alert").count(), 0);
    await summaryMetric(summary, "收入").getByText("$7.50", { exact: true }).waitFor();
  }
  await unaccounted.getByText(/上游暂时读不到，可以点「刷新」再读。/).waitFor();
  await page.clock.fastForward(20000); await settle(); assert.equal(reads.length, 4);
  assert.ok(reads.every((read) => read.preset === "yesterday"));
  // 「刷新」是新的窗口请求：重新给 3 次重读，读到后不再重读
  await page.getByRole("button", { name: "刷新当前页面数据", exact: true }).click(); await until(() => queries.length === 1); assert.equal(queries[0].observe, true);
  await unaccounted.getByText(/上游暂时读不到，系统会自动再读。/).waitFor();
  await advanceUntilRead(5);
  await unaccounted.locator(".reconciliation-summary-metric").getByText("$2.00", { exact: true }).waitFor(); assert.equal(await unaccounted.getByText(/上游暂时读不到/).count(), 0);
  // 金额渲染后还要让本次绘制的 effect 清掉 pending 定时器，之后再跨过完整观察期。
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.clock.fastForward(20000); await settle(); assert.equal(reads.length, 5);
});

test("3b unaccounted upstream copy explains partial reads, excluded upstreams and accounts over-accounted by fetch timing", async (t) => {
  const rows = ratedDailyRows();
  const summarized = summarizeUnaccountedUpstream([
    { station: { id: "upstream-1", name: "Fixture upstream" }, rate: configuredRate("upstream-1", 6), usage: { usd: 1, mode: "usage" } },
    { station: { id: "upstream-2", name: "Second upstream" }, rate: configuredRate("upstream-2", 6), usage: { usd: 3, mode: "history", lowerBound: true, note: "读不到用量，改按余额变化估算；历史数据不够，金额偏低" } },
  ], rows, { currency: "USD" });
  const { page } = await openDailyPage(t, { data: dailyResponse(rows, { unaccountedUpstream: { ...summarized, window, fixedStations: [], excludedStations: [{ id: "excluded-1", name: "Excluded upstream" }] } }) });
  const unaccounted = page.getByRole("region", { name: "没算进利润的上游成本", exact: true });
  await unaccounted.getByText(/部分上游没读全。/).waitFor(); await unaccounted.getByText(/有的上游已算进利润的多于上游扣费，合计里按 0 算。/).waitFor();
  await unaccounted.getByText(/不算进利润的上游不在这里：Excluded upstream（绑在它上面的 Key 仍按用量算上游成本）。/).waitFor();
  // 合计只加没算进利润为正的上游：Second upstream 的 $3（下限），Fixture upstream 的 −$1 按 0 算
  await unaccounted.locator(".reconciliation-summary-metric").getByText("$3.00", { exact: true }).waitFor();
  await unaccounted.locator(".ant-collapse-header", { hasText: "查看各上游" }).click(); await unaccounted.getByText(`上游扣费 $1.00 · 已算进利润 $2.00 · 没算进利润 ${MINUS}$1.00`, { exact: true }).waitFor();
  // 只是取数时刻不同：写在这个上游自己的说明里
  await unaccounted.getByText("已算进利润的多于上游扣费：上游的扣费可能还没记全", { exact: true }).waitFor();
  await unaccounted.getByText(/历史数据不够，金额偏低/).waitFor(); assert.equal(await unaccounted.getByText(/数据截至/).count(), 0);
  // 多算的原因写在各上游自己的说明里：只是取数时刻不同、只是汇率不同、两者都有各一句；不算进利润的上游有多个时说「它们」。
  // 按人民币看时，绑定的上游成本按 costRate 折算，这个上游按 1 美元 = 6 元，上游扣费为 usd
  const reasons = async (kind, usd, costRate, note, excludedStations = []) => {
    const rated = ratedDailyRows(); for (const row of rated.slice(0, 2)) row.rates.cost = configuredRate("upstream-1", costRate);
    const result = summarizeUnaccountedUpstream([{ station: { id: "upstream-1", name: "Fixture upstream" }, rate: configuredRate("upstream-1", 6), usage: { usd, mode: "usage" } }], rated, { currency: "CNY" });
    assert.equal(result.accounts[0].overAccounted, kind);
    const opened = await openDailyPage(t, { upstreams: ratedUpstreams, data: dailyResponse(rated, { displayCurrency: "CNY", unaccountedUpstream: { ...result, window, fixedStations: [], excludedStations } }) });
    const block = opened.page.getByRole("region", { name: "没算进利润的上游成本", exact: true });
    await block.getByText(/有的上游已算进利润的多于上游扣费，合计里按 0 算。/).waitFor();
    await block.locator(".ant-collapse-header", { hasText: "查看各上游" }).click();
    // 说明排在汇率之后、句末就是这一句，取数时刻那句不会被当成「两者都有」那句的一部分
    await block.getByText(new RegExp(`^${formatRate(6)}；(.+；)?${note}$`)).waitFor();
    return block;
  };
  await reasons("timing", 1, 6, "已算进利润的多于上游扣费：上游的扣费可能还没记全");
  await reasons("rate", 2.1, 7, "已算进利润的多于上游扣费：两边汇率不同");
  const mixed = await reasons("mixed", 1.5, 7, "已算进利润的多于上游扣费：上游的扣费可能还没记全，两边汇率也不同", [{ id: "excluded-1", name: "Excluded upstream" }, { id: "excluded-2", name: "Second excluded" }]);
  await mixed.getByText(/不算进利润的上游不在这里：Excluded upstream、Second excluded（绑在它们上面的 Key 仍按用量算上游成本）。/).waitFor();
});

test("3b live window account usage shows when each upstream account was read", async (t) => {
  const start = window.endMs, live = { ...window, preset: "today", startMs: start, endMs: start + 3 * 3600000 }, rows = dailyRows(live);
  const summarized = summarizeUnaccountedUpstream([{ station: { id: "upstream-1", name: "Fixture upstream" }, rate: null, usage: { usd: 9, mode: "usage", endMs: live.endMs - 120000 } }], rows, { currency: "USD" });
  const { page } = await openDailyPage(t, { data: dailyResponse(rows, { unaccountedUpstream: { ...summarized, window: live, fixedStations: [], excludedStations: [] } }) });
  const unaccounted = page.getByRole("region", { name: "没算进利润的上游成本", exact: true });
  await unaccounted.locator(".ant-collapse-header", { hasText: "查看各上游" }).click(); await unaccounted.getByText(formatAsOf(live.endMs - 120000, live.timezone), { exact: true }).waitFor();
});

test("daily mobile pagination changes only visible rules and retains global amounts and coverage", async (t) => {
  const rows = Array.from({ length: 5 }, (_, index) => rule(`rule-${index + 1}`, `Rule ${String.fromCharCode(65 + index)}`, 2.5)); const { page, reads } = await openDailyPage(t, { data: dailyResponse(rows), viewport: { width: 390, height: 844 } });
  const summary = page.getByRole("region", { name: "汇总", exact: true }), coverage = page.getByRole("region", { name: "渠道", exact: true }); await summary.getByText("$12.50", { exact: true }).waitFor(); await coverage.getByText(coverageText(10, 5), { exact: true }).waitFor(); assert.equal(await page.locator(".reconciliation-mobile-item").count(), 4);
  await page.getByRole("button", { name: "下一页", exact: false }).click(); await page.locator(".reconciliation-mobile-item", { hasText: "Rule E" }).waitFor(); assert.equal(await page.locator(".reconciliation-mobile-item").count(), 1); await summary.getByText("$12.50", { exact: true }).waitFor(); await coverage.getByText(coverageText(10, 5), { exact: true }).waitFor(); assert.equal(reads.length, 1);
});

// 没法放在一起汇总时，汇总写「—」和一句说明，分组逐个列在下面；组名写这天，和业务时区不同的组写按哪个时区算一天
const GROUPED_CAPTION = "这几条绑定没法放在一起汇总，分开写在下面";
async function assertGroupedSummary(page) {
  const empty = page.getByRole("region", { name: "汇总", exact: true }).locator(".reconciliation-summary__empty");
  await empty.getByText(GROUPED_CAPTION, { exact: true }).waitFor(); assert.equal(await empty.textContent(), `${EMPTY}${GROUPED_CAPTION}`);
}
const windowCaption = async (page) => { const caption = page.locator(".reconciliation-window"); await caption.waitFor(); return caption.innerText(); };

test("daily billing keeps absolute Shanghai and UTC groups separate and combines only verified equal windows", async (t) => {
  const rows = dailyRows(); rows[1] = rule("rule-2", "Rule B", 2.5, { preset: "yesterday", timezone: "UTC", startMs: Date.parse("2026-10-08T00:00:00Z"), endMs: Date.parse("2026-10-09T00:00:00Z") });
  const { page } = await openDailyPage(t, { data: dailyResponse(rows) }); const summary = page.getByRole("region", { name: "汇总", exact: true }); await assertGroupedSummary(page); assert.equal(await summary.getByText("$7.50", { exact: true }).count(), 0);
  const groups = page.locator(".reconciliation-window-groups .ant-collapse-item"); assert.equal(await groups.count(), 2);
  const shanghaiLabel = formatZonedWindow(window), utcLabel = `${formatZonedWindow(rows[1].window)} · ${formatDayZone("UTC")}`;
  const shanghai = groups.filter({ has: page.getByText(shanghaiLabel, { exact: true }) }), utc = groups.filter({ has: page.getByText(utcLabel, { exact: true }) }); assert.equal(await shanghai.count(), 1); assert.equal(await utc.count(), 1);
  await utc.locator(".ant-collapse-header").focus(); await page.keyboard.press("Enter"); await summaryMetric(utc, "收入").getByText("$2.50", { exact: true }).waitFor(); await summaryMetric(utc, "上游成本").getByText("$1.00", { exact: true }).waitFor();
  await shanghai.locator(".ant-collapse-header").focus(); await page.keyboard.press("Enter"); await summaryMetric(shanghai, "收入").getByText("$5.00", { exact: true }).waitFor();
  const combined = dailyRows(); combined[1] = rule("rule-2", "Rule B", 2.5, { ...window, timezone: "Asia/Singapore" });
  const next = await openDailyPage(t, { data: dailyResponse(combined), query(route, body) { assert.equal(body.preset, "today"); const today = dailyRows({ ...window, preset: "today", startMs: window.endMs, endMs: Date.parse("2026-10-09T03:00:00Z") }); for (const row of today) row.calculation = { profitUsd: null, marginRate: null, riskDifferenceUsd: 1.5 }; return fulfill(route, dailyResponse(today)); } });
  // 起止相同、时区都核实过的两种时区合成一个汇总，不再分组
  const nextSummary = next.page.getByRole("region", { name: "汇总", exact: true }); await summaryMetric(nextSummary, "收入").getByText("$7.50", { exact: true }).waitFor(); assert.equal(await next.page.locator(".reconciliation-window-groups").count(), 0); assert.equal(await nextSummary.locator(".reconciliation-summary__empty").count(), 0);
  await next.page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "今天", exact: true }).filter({ visible: true }).click(); const todaySummary = next.page.getByRole("region", { name: "汇总", exact: true }); await summaryMetric(todaySummary, "毛利").getByText(EMPTY, { exact: true }).waitFor(); await summaryMetric(todaySummary, "收入").getByText("$7.50", { exact: true }).waitFor(); assert.equal(next.queries[0].preset, "today");
});

test("daily row retry uses one selected query then reloads full GET before showing current aggregates", async (t) => {
  let reload, ready; const started = new Promise((resolve) => { ready = resolve; }); const initial = dailyResponse();
  const { page, reads, queries } = await openDailyPage(t, { data: initial, read(route, count) { if (count === 1) return fulfill(route, initial); return new Promise((resolve) => { reload = { route, resolve }; ready(); }); }, query(route, body) { assert.deepEqual(body.ruleIds, ["rule-1"]); const rows = dailyRows(); rows[0] = rule("rule-1", "Rule A", 4); return fulfill(route, dailyResponse([rows[0]], { rules: initial.results.map((row) => row.rule) })); } });
  const summary = page.getByRole("region", { name: "汇总", exact: true });
  await page.getByRole("button", { name: "重新读取 Rule A", exact: true }).click(); await started; await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("$4.00", { exact: true }).waitFor(); await summary.locator(".ant-alert", { hasText: "读取中" }).waitFor(); assert.deepEqual(reads[1], { preset: "yesterday" }); assert.equal(queries.length, 1); assert.deepEqual([queries[0].startMs, queries[0].endMs], [window.startMs, window.endMs]);
  const full = dailyRows(); full[0] = rule("rule-1", "Rule A", 4); reload.resolve(fulfill(reload.route, dailyResponse(full))); await summary.getByText("$9.00", { exact: true }).waitFor(); assert.equal(await summary.locator(".ant-alert").count(), 0); await page.getByRole("region", { name: "渠道", exact: true }).getByText(coverageText(10, 3), { exact: true }).waitFor();
});

test("daily summary re-read ignores an earlier aggregate when another row finishes during it", async (t) => {
  const gets = [], retries = new Map(), initial = dailyResponse(); let getReady; const getStarted = new Promise((resolve) => { getReady = resolve; });
  const { page, reads } = await openDailyPage(t, { data: initial, read(route, count) { if (count === 1) return fulfill(route, initial); return new Promise((resolve) => { gets.push({ route, resolve }); getReady(); }); }, query(route, body) { return new Promise((resolve) => retries.set(body.ruleIds[0], { route, resolve })); } });
  await page.getByRole("button", { name: "重新读取 Rule A", exact: true }).click(); await page.getByRole("button", { name: "重新读取 Rule B", exact: true }).click(); const rows = dailyRows(); rows[0] = rule("rule-1", "Rule A", 4); retries.get("rule-1").resolve(fulfill(retries.get("rule-1").route, dailyResponse([rows[0]]))); await getStarted;
  rows[1] = rule("rule-2", "Rule B", 5); retries.get("rule-2").resolve(fulfill(retries.get("rule-2").route, dailyResponse([rows[1]])));
  // 等两个按钮都不在加载（按钮上的 ant-btn-loading），不等加载图标消失：打包版里图标的退场动画常停在半截，
  // 图标已经看不见（宽 0、透明），元素却一直留着
  await page.waitForFunction(() => !document.querySelector(".ant-btn-loading")); assert.equal(reads.length, 3);
  const summary = page.getByRole("region", { name: "汇总", exact: true });
  const earlier = dailyRows(); earlier[0] = rows[0]; gets[0].resolve(fulfill(gets[0].route, dailyResponse(earlier))); await page.locator("tr.ant-table-row", { hasText: "Rule B" }).getByText("$5.00", { exact: true }).waitFor(); await summary.locator(".ant-alert", { hasText: "读取中" }).waitFor();
  gets[1].resolve(fulfill(gets[1].route, dailyResponse(rows))); await summary.getByText("$11.50", { exact: true }).waitFor();
});

test("daily full-summary read failure keeps successful row and retries full GET without another financial query", async (t) => {
  const rows = dailyRows(); let successful = false;
  const { page, reads, queries } = await openDailyPage(t, { read(route, count) { if (count === 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture summary unavailable" }) }); return fulfill(route, dailyResponse(rows)); }, query(route) { rows[0] = rule("rule-1", "Rule A", 4); successful = true; return fulfill(route, dailyResponse([rows[0]])); } });
  const summary = page.getByRole("region", { name: "汇总", exact: true });
  await page.getByRole("button", { name: "重新读取 Rule A", exact: true }).click(); await summary.getByText(refreshFailedText(Date.parse("2026-10-09T03:00:00.000Z")), { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("$4.00", { exact: true }).waitFor(); assert.equal(successful, true);
  await summary.getByRole("button", { name: "刷新", exact: true }).click(); await summary.getByText("$9.00", { exact: true }).waitFor(); assert.equal(await summary.locator(".ant-alert").count(), 0); assert.equal(queries.length, 1); assert.equal(reads.length, 3); assert.ok(reads.every((read) => read.preset === "yesterday"));
});

test("daily coverage retains disabled and missing known channels and zero active rules after stopping", async (t) => {
  const rows = dailyRows(), channels = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}`, status: index === 1 ? 2 : 1, missing: index === 8 }));
  rows[1].downstream.channels[0].state = "manual_disabled"; rows[2].rule.channels = [{ channelId: 9, name: "渠道 9" }]; rows[2].downstream.channels[0] = { ...rows[2].downstream.channels[0], channelId: 9, name: "渠道 9", state: "missing" }; rows[2].health = { code: "SOURCE_BINDING_UNCONFIRMED", issues: [{ code: "SOURCE_BINDING_UNCONFIRMED", detail: "原渠道已缺失，需要核对来源" }] }; rows[2].calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null };
  const data = dailyResponse(rows, { catalogue: { channels } }); const { page } = await openDailyPage(t, { data, query(route) { return fulfill(route, dailyResponse([], { rules: rows.map((row) => ({ ...row.rule, enabled: false, archivedAt: "2026-10-09T03:00:00.000Z" })), catalogue: { channels } })); } });
  const disabledTag = reconciliationIssue("SALES_CHANNEL_DISABLED").tag, missingTag = reconciliationIssue("SALES_CHANNEL_MISSING").tag;
  const coverage = page.getByRole("region", { name: "渠道", exact: true }); await coverage.getByText(coverageText(10, 2), { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule C" }).getByText("$2.50", { exact: true }).waitFor();
  // 停用、删除的渠道仍算在已知渠道里，列表的渠道一栏写「已停用 1」「已删除 1」
  assert.equal(await page.locator("tr.ant-table-row", { hasText: "Rule B" }).locator(".reconciliation-table-channels small").textContent(), `${disabledTag} 1`);
  assert.equal(await page.locator("tr.ant-table-row", { hasText: "Rule C" }).locator(".reconciliation-table-channels small").textContent(), `${missingTag} 1`);
  // 「查看没算进来的」只列没算进利润的渠道：停用但算进了利润的渠道 2 不在里面；删除的渠道 9 名字旁标「已删除」（§4）
  await coverage.locator(".ant-collapse-header").click(); const missing = coverage.locator(".reconciliation-coverage__channel").filter({ has: page.getByText("渠道 9", { exact: true }) });
  await missing.getByText("需处理", { exact: true }).waitFor(); await missing.getByText(reconciliationIssue("SOURCE_BINDING_UNCONFIRMED").title, { exact: true }).waitFor(); assert.equal(await coverage.getByText("渠道 2", { exact: true }).count(), 0);
  await missing.locator(".reconciliation-coverage__heading").getByText(missingTag, { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前页面数据", exact: true }).click(); await page.getByText("还没有绑定", { exact: true }).waitFor(); await coverage.getByText(coverageText(10, 0), { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "汇总", exact: true }).locator(".reconciliation-summary__empty").textContent(), EMPTY);
});

test("daily duplicate sales and shared Key costs use server totals while raw row evidence remains visible", async (t) => {
  const rows = dailyRows(); rows[1].rule.channels = structuredClone(rows[0].rule.channels); rows[1].downstream.channels = structuredClone(rows[0].downstream.channels); rows[1].upstream.countedAmountUsd = null; rows[1].upstream.ownershipState = "duplicate";
  for (const row of rows.slice(0, 2)) { row.calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null }; row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT", detail: "rule-1、rule-2 重复归属" }] }; }
  // 汇总按服务端合计：重复的渠道收入只算一次，没算进来的那份上游成本不加，毛利只加能算出来的
  const { page } = await openDailyPage(t, { data: dailyResponse(rows) }); const summary = page.getByRole("region", { name: "汇总", exact: true }); await summaryMetric(summary, "收入").getByText("$5.00", { exact: true }).waitFor(); await summaryMetric(summary, "上游成本").getByText("$2.00", { exact: true }).waitFor(); await summaryMetric(summary, "毛利").getByText("$1.50", { exact: true }).waitFor();
  // 有共同汇总时不列分组，没算进来的那份上游成本在汇总里点名
  await summary.getByText(reconciliationNotCountedCostText(["rule-2"], rows), { exact: true }).waitFor();
  const duplicate = reconciliationIssue("DUPLICATE_CHANNEL_ASSIGNMENT");
  const rowB = page.locator("tr.ant-table-row", { hasText: "Rule B" }); await rowB.getByText("$2.50", { exact: true }).waitFor(); await rowB.getByText("$1.00", { exact: true }).waitFor(); await rowB.getByText("需处理", { exact: true }).waitFor(); await rowB.getByText(duplicate.plain, { exact: true }).waitFor();
  const coverage = page.getByRole("region", { name: "渠道", exact: true }); await coverage.locator(".ant-collapse-header").click(); const channel = coverage.locator(".reconciliation-coverage__channel").filter({ has: page.getByText("渠道 1", { exact: true }) });
  await channel.getByText("需处理", { exact: true }).waitFor(); await channel.getByText(fillIssueCopy(duplicate.title, duplicate.plain, { channel: "渠道 1" }), { exact: true }).waitFor(); assert.equal(await channel.getByRole("link", { name: workflowActionMeta("review_conflict").label, exact: true }).getAttribute("href"), workflowAction("review_conflict", { ruleId: "rule-1" }).href);
});

test("daily Sub2API unverified timezone keeps zero and actual dollar reference without confirmed day profit", async (t) => {
  const row = dailyRows()[0]; row.amountBasis = { ...amountBasis, conversion: "provider_cost_usd" }; row.billingTimezone = { state: "unverified", timezone: "Asia/Shanghai", reason: "BILLING_TIMEZONE_UNVERIFIED" }; row.upstream = { ...row.upstream, state: "partial", amountUsd: null, knownAmountUsd: 0, countedAmountUsd: 0, quotaPerUnit: null }; row.calculation = { profitUsd: null, marginRate: null, riskDifferenceUsd: 2.5 }; row.health = { code: "BILLING_TIMEZONE_UNVERIFIED", issues: [{ code: "BILLING_TIMEZONE_UNVERIFIED", detail: "当前部署自然日边界尚未核验" }] };
  const { page } = await openDailyPage(t, { data: dailyResponse([row]) }); await assertGroupedSummary(page); await page.locator("tr.ant-table-row", { hasText: "Rule A" }).locator("td", { hasText: "$0.00（没读全）" }).waitFor();
  await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true }); await drawer.locator(".ant-alert", { hasText: reconciliationIssue("BILLING_TIMEZONE_UNVERIFIED").title }).waitFor();
  assert.match(await detailValue(drawer, "上游成本").innerText(), /^\$0\.00（没读全）\s*来自 Key「Rule A」的用量记录$/); assert.equal((await detailValue(drawer, "毛利").innerText()).trim(), EMPTY); assert.equal(await drawer.getByText("确认利润", { exact: true }).count(), 0);
});

test("daily late bill and new scope retain requested yesterday and expose first full bill schedule", async (t) => {
  const row = dailyRows()[0]; row.upstream = { ...row.upstream, amountUsd: 0, knownAmountUsd: 0, countedAmountUsd: 0 }; row.calculation = { profitUsd: null, riskDifferenceUsd: 2.5, marginRate: null }; row.health = { code: "WAITING_FOR_BILL", issues: [{ code: "WAITING_FOR_BILL", detail: "最新已结束日账单尚未就绪" }] }; row.scope = { scopeVersion: 2, billingEffectiveFromMs: Date.parse("2026-10-09T16:00:00Z"), firstFullDayStartMs: Date.parse("2026-10-09T16:00:00Z"), firstQueryableAtMs: Date.parse("2026-10-10T16:00:00Z") };
  // 页面按绑定的生效方式和生效时间算「开始统计」（rule.billingPolicy / billingEffectiveFrom），不读 scope
  row.rule.billingPolicy = "immediate"; row.rule.billingEffectiveFrom = Date.parse("2026-10-09T16:00:00Z");
  // 这天过去 7 天还没读全，读取类问题变成需处理
  const { page, queries } = await openDailyPage(t, { data: dailyResponse([row]) }); const rowA = page.locator("tr.ant-table-row", { hasText: "Rule A" }); await rowA.getByText("需处理", { exact: true }).waitFor(); await rowA.getByText(reconciliationIssue("WAITING_FOR_BILL").title, { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true }); await detailValue(drawer, "开始统计").waitFor();
  assert.equal(await detailValue(drawer, "时间").innerText(), formatZonedWindow(window)); assert.equal(await detailValue(drawer, "开始统计").innerText(), "10月10日"); await drawer.locator(".ant-drawer-close").click();
  const retried = page.waitForResponse((response) => response.url().endsWith("/api/reconciliation/query")); await page.getByRole("button", { name: "重新读取 Rule A", exact: true }).click(); await retried; assert.deepEqual([queries[0].preset, queries[0].startMs, queries[0].endMs], ["custom", window.startMs, window.endMs]);
});

test("daily groups display exact 23/25-hour DST boundaries and work by keyboard at four widths", async (t) => {
  for (const [width, start, end, day] of [[320, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", "3月8日"], [390, "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", "11月1日"], [768, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", "3月8日"], [1440, "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", "11月1日"]]) {
    const range = { preset: "yesterday", timezone: "America/New_York", startMs: Date.parse(start), endMs: Date.parse(end) };
    const row = dailyRows(range)[0]; const { page } = await openDailyPage(t, { data: dailyResponse([row]), viewport: { width, height: 900 } });
    // 23、25 小时的一天按北美东部时间正好是一整天，只写日期，旁边写按哪个时区算一天
    const zone = formatDayZone("America/New_York"); assert.equal(formatZonedWindow(range), day); assert.equal(await windowCaption(page), day); await page.locator(".reconciliation-head").getByText(zone, { exact: true }).waitFor();
    const coverage = page.getByRole("region", { name: "渠道", exact: true }); await coverage.locator(".ant-collapse-header").focus(); await page.keyboard.press("Enter"); await coverage.getByText("渠道 9", { exact: true }).waitFor(); await page.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).focus(); await page.keyboard.press("Enter"); const drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true });
    assert.match(await detailValue(drawer, "时间").innerText(), new RegExp(`^${day}\\s*${zone}$`));
  }
});

test("daily mismatched provider window shows original returned interval and never confirms requested day profit", async (t) => {
  const row = dailyRows()[0], actual = { ...window, startMs: window.startMs - 86400000, endMs: window.endMs - 86400000 }; row.window = actual; row.upstream.window = actual; row.downstream.window = actual; row.calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null }; row.health = { code: "BILLING_WINDOW_MISMATCH", issues: [{ code: "BILLING_WINDOW_MISMATCH", detail: "上游返回原账单区间与请求窗口不同" }] };
  // 页面和计算明细写请求的这天，分组写上游实际返回的那天
  const { page } = await openDailyPage(t, { data: dailyResponse([row]) }); await assertGroupedSummary(page); assert.equal(await windowCaption(page), formatZonedWindow(window));
  await page.locator(".reconciliation-window-groups .ant-collapse-header").getByText(formatZonedWindow(actual), { exact: true }).waitFor(); assert.notEqual(formatZonedWindow(actual), formatZonedWindow(window));
  await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true }); await drawer.locator(".ant-alert", { hasText: reconciliationIssue("BILLING_WINDOW_MISMATCH").title }).waitFor();
  assert.equal(await detailValue(drawer, "时间").innerText(), formatZonedWindow(window)); assert.equal((await detailValue(drawer, "毛利").innerText()).trim(), EMPTY); assert.equal(await drawer.getByText("确认利润", { exact: true }).count(), 0);
});

test("daily unknown catalogue and unknown-source retained members do not become full-site coverage", async (t) => {
  const rows = dailyRows(), rules = rows.map((row) => row.rule); rules.push({ ...rules[0], id: "legacy-unknown", enabled: false, ownSource: null, channels: [{ channelId: 9, name: "旧来源渠道 9" }] });
  const { page } = await openDailyPage(t, { data: dailyResponse(rows, { rules, catalogue: { stale: true } }) }); const coverage = page.getByRole("region", { name: "渠道", exact: true }); await coverage.getByText(coverageText(11, 0), { exact: true }).waitFor();
  // 渠道目录不是最新、旧绑定来源不明：一个也不算进利润，也不当成「没绑定」，都要先确认来源
  await coverage.locator(".ant-collapse-header").click(); await coverage.getByText("渠道 9", { exact: true }).waitFor(); await coverage.getByText("旧来源渠道 9", { exact: true }).waitFor();
  const listed = coverage.locator(".reconciliation-coverage__channel"); assert.equal(await listed.count(), 11); assert.equal(await coverage.getByText("没绑定", { exact: true }).count(), 0);
  const legacy = listed.filter({ has: page.getByText("旧来源渠道 9", { exact: true }) }); await legacy.getByText("需处理", { exact: true }).waitFor(); await legacy.getByText(reconciliationIssue("SOURCE_BINDING_UNCONFIRMED").title, { exact: true }).waitFor();
});

test("daily zero and negative confirmed subtotals remain numeric while unknown whole-Key use is reference", async (t) => {
  const rows = [rule("rule-1", "Rule A", 1), rule("rule-2", "Rule B", 0)]; const { page } = await openDailyPage(t, { data: dailyResponse(rows) }); const summary = page.getByRole("region", { name: "汇总", exact: true }); await summaryMetric(summary, "毛利").getByText(`${MINUS}$1.00`, { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("$0.00", { exact: true }).waitFor();
  const unknown = dailyRows()[0]; unknown.rule.costCoverage = "unknown"; unknown.rule.coverageDeclaration = { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] }; unknown.calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null }; unknown.health = { code: "COST_COVERAGE_UNKNOWN", issues: [{ code: "COST_COVERAGE_UNKNOWN", detail: "同 Key 仍有站外调用" }] };
  const next = await openDailyPage(t, { data: dailyResponse([unknown]) }); const row = next.page.locator("tr.ant-table-row", { hasText: "Rule A" }); await row.getByText("$2.50", { exact: true }).waitFor(); await row.getByText("$1.00", { exact: true }).waitFor(); await row.getByText("需处理", { exact: true }).waitFor(); await row.getByText(COVERAGE_QUESTION, { exact: true }).waitFor();
  const coverage = next.page.getByRole("region", { name: "渠道", exact: true }); await coverage.locator(".ant-collapse-header").click(); const channel = coverage.locator(".reconciliation-coverage__channel").filter({ has: next.page.getByText("渠道 1", { exact: true }) });
  await channel.getByText("需处理", { exact: true }).waitFor(); await channel.getByText(COVERAGE_QUESTION, { exact: true }).waitFor(); assert.equal(await channel.getByRole("link", { name: workflowActionMeta("confirm_coverage").label, exact: true }).getAttribute("href"), workflowAction("confirm_coverage", { ruleId: "rule-1" }).href);
});

const shellFallback = { "/api/meta": { types: [], rules: {}, settings: {} }, "/api/stations": { stations: [], settings: {} } };
// 每个页面收到的渠道接入请求，供只读断言使用
const onboardingRequests = new WeakMap();
async function openFixturePage(t, handler, viewport, clock = false, onboardingHandler = null, path = "/reconciliation") {
  const browser = await launchBrowser();
  const context = await browser.newContext({ serviceWorkers: "block", ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}) });
  t.after(() => context.close());
  const page = await context.newPage(), onboardingCalls = [];
  settleButtonLookups(page);
  onboardingRequests.set(page, onboardingCalls);
  if (clock) await page.clock.install();
  page.setDefaultTimeout(5_000);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/api/channel-onboarding")) {
      onboardingCalls.push({ method: route.request().method(), pathname });
      if (onboardingHandler) return onboardingHandler(route);
      // 没有声明接入处理的用例只允许读
      if (route.request().method() !== "GET") throw new Error("unexpected onboarding write: " + route.request().method() + " " + pathname);
      return fulfill(route, { ownStation: null, channels: [], upstreams: [], rules: [], stale: false });
    }
    try { return await handler(route); }
    catch (error) {
      // 外壳侧栏在每个页面读这两个接口算待处理条数；用例没有声明时给空数据，其余未声明的接口照常失败
      if (shellFallback[pathname] && route.request().method() === "GET" && /^unexpected /.test(error?.message || "")) return fulfill(route, shellFallback[pathname]);
      throw error;
    }
  });
  await page.goto(`${baseURL}${path}`, { timeout: 30000 });
  // 核算页等第一行出来；其他页面（上游资源）由调用方等自己的就绪标志
  if (path.startsWith("/reconciliation")) await page.getByText("Rule A").first().waitFor();
  return page;
}

async function fulfill(route, body) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

// 从提醒或上游账单的链接进来：链接里的日期对不上、绑定已解除、地址坏了，都在页面顶上写一句话（§8.1）
const destinationAlert = (page, title) => page.locator(".reconciliation-alerts .ant-alert").filter({ has: page.getByText(title, { exact: true }) });
const DESTINATION_EXPIRED = `${ERROR_CATEGORIES.expired.text}。`, DESTINATION_REMOVED = "这条绑定已解除";

test("workflow retry destination verifies the original absolute window and retries it once before full re-read", async (t) => {
  const path = `/reconciliation?action=retry&ruleId=rule-1&startMs=${window.startMs}&endMs=${window.endMs}&timezone=Asia%2FShanghai`;
  const { page, reads, queries } = await openDailyPage(t, { path });
  const drawer = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true }); await drawer.waitFor();
  assert.deepEqual(reads[0], { preset: "custom", startMs: String(window.startMs), endMs: String(window.endMs) });
  // 顶上写这条和链接那天，放「重新读取」
  await destinationAlert(page, `Rule A · ${formatZonedWindow(window)}`).getByRole("button", { name: "重新读取", exact: true }).waitFor();
  assert.equal(queries.length, 0); await drawer.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
  assert.deepEqual(queries, [{ preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: ["rule-1"], observe: true }]);
  assert.deepEqual(reads[1], reads[0]);
});

test("workflow rejects invalid, deleted and changed-zone bill destinations with a usable reload", async (t) => {
  for (const [suffix, title] of [["action=unknown&ruleId=rule-1", DESTINATION_EXPIRED], ["action=scope&ruleId=deleted-rule", DESTINATION_REMOVED], [`action=retry&ruleId=rule-1&startMs=${window.startMs}&endMs=${window.endMs}&timezone=UTC`, DESTINATION_CHANGED], ["action=retry&ruleId=rule-1&startMs=bad&endMs=1&timezone=Asia%2FShanghai", DESTINATION_EXPIRED]]) {
    const { page, queries } = await openDailyPage(t, { path: "/reconciliation?" + suffix });
    const alert = destinationAlert(page, title); await alert.waitFor();
    // 已解除的那条刷新也回不来，不放「刷新」；其余的「刷新」回到每日利润重新打开
    if (title === DESTINATION_REMOVED) assert.equal(await alert.getByRole("link", { name: "刷新", exact: true }).count(), 0);
    else assert.equal(await alert.getByRole("link", { name: "刷新", exact: true }).getAttribute("href"), "/reconciliation");
    assert.equal(queries.length, 0); assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.getByRole("button", { name: "重新读取", exact: true }).count(), 0);
  }
});

test("workflow scope and conflict destinations expose saved history and all conflict rule corrections", async (t) => {
  const scopedRows = dailyRows(); scopedRows[0].rule.billingPolicy = "immediate"; scopedRows[0].rule.billingEffectiveFrom = window.startMs + 6 * 3600000;
  const scope = await openDailyPage(t, { path: "/reconciliation?action=scope&ruleId=rule-1", data: dailyResponse(scopedRows) });
  const drawer = scope.page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true });
  assert.equal(await detailValue(drawer, "开始统计").innerText(), reconciliationAccountingStartText(scopedRows[0].rule, window.timezone)); await drawer.getByRole("button", { name: "以前的每日记录", exact: true }).waitFor();
  const rows = dailyRows(); for (const row of rows.slice(0, 2)) row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT", ruleIds: ["rule-1", "rule-2"], detail: "销售渠道重复归属" }] };
  const conflict = await openDailyPage(t, { path: "/reconciliation?action=conflict&ruleId=rule-1", data: dailyResponse(rows) }); const detail = conflict.page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true });
  await detail.getByText(reconciliationRowFlags(rows[0]).displayStatus.title, { exact: true }).waitFor(); await detail.getByRole("button", { name: "查看 Rule B", exact: true }).click();
  const second = conflict.page.getByRole("dialog", { name: "Rule B · 计算明细", exact: true }); const fix = second.getByRole("link", { name: workflowActionMeta("review_conflict").label, exact: true }); await fix.waitFor(); assert.equal(await fix.getAttribute("href"), "/stations?action=conflict&ruleId=rule-2");
});

function onboardingFixture(existing = true, type = "newapi", ids = [4]) {
  return {
    ownStation: { id: "own-1", baseUrl: "https://own.example" },
    ownSource, sourceVersion: "source-v1",
    upstreams: existing ? [{ id: "upstream-1", name: "Fixture upstream", type, monitorEnabled: true, baseUrl: "https://up.example", authVersion: 1, resourceVersion: "resource-upstream-1", identity: type === "newapi-key" ? null : { provider: type.startsWith("sub2api") ? "sub2api" : "newapi", accountId: "42" } }] : [],
    channels: ids.map((id) => ({ id, name: id === 4 ? "New channel" : "New channel " + id, status: 1, baseUrl: "https://up.example", groups: ["local-sales"], revision: "revision-" + id, candidates: existing ? ["upstream-1"] : [], monitor: { status: "unlinked", stationIds: [] }, reconciliation: { status: "unconfigured", ruleIds: [] } })),
    rules: existing && type !== "newapi-key" ? [{ ...rule("rule-1", "Rule A", 10).rule, ownStationId: "own-1", ownSource, tokenId: 7, tokenName: "Supplier Key", timezone: "Asia/Shanghai", scopeVersion: 1, canonicalKey: createHash("sha256").update(JSON.stringify([type.startsWith("sub2api") ? "sub2api" : "newapi", "https://up.example", "42", "7"])).digest("hex"), channels: [1, 2, 3].map((channelId) => ({ channelId, name: "Sales " + channelId })), enabled: true }] : [],
    syncedAt: "2026-10-09T06:00:00.000Z", stale: false,
  };
}
const onboardingTokens = [{ id: 7, name: "Supplier Key", status: 1, group: "upstream-group" }, { id: 8, name: "New Key", status: 1, group: "upstream-group" }];
const preview = { billingEffectiveFromMs: null, firstQueryableAtMs: null, scopeChanged: true };
const ownSource = { stationId: "own-1", provider: "newapi", baseUrl: "https://own.example", accountId: "1", namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", "https://own.example", "1"])).digest("hex") };

function onboardingAccounts(config) {
  const accounts = new Map(), unverifiedResources = [];
  for (const station of config.upstreams) {
    const identity = station.identity && { ...station.identity, baseUrl: station.baseUrl };
    const resource = { archivedAt: null, authVersion: 1, resourceVersion: "resource-" + station.id, verification: identity ? "verified" : "unverified", purposes: { monitor: station.monitorEnabled !== false, billingRuleIds: config.rules.filter((rule) => rule.upstreamStationId === station.id).map((rule) => rule.id) }, balance: { ok: true, remaining: 10 }, hasAccessToken: station.type !== "newapi-key", hasApiKey: station.type === "newapi-key", hasPassword: false, ...station, identity };
    if (!identity) { unverifiedResources.push(resource); continue; }
    const accountKey = createHash("sha256").update(JSON.stringify([identity.provider, identity.baseUrl, identity.accountId])).digest("hex");
    if (!accounts.has(accountKey)) accounts.set(accountKey, { accountKey, siteKey: identity.provider + ":" + identity.baseUrl, identity, resources: [], keys: [], actions: [] });
    accounts.get(accountKey).resources.push(resource);
  }
  for (const account of accounts.values()) for (const rule of config.rules.filter((rule) => rule.canonicalKey && account.resources.some((resource) => resource.id === rule.upstreamStationId))) {
    let key = account.keys.find((entry) => entry.tokenId === rule.tokenId);
    if (!key) { key = { canonicalKey: rule.canonicalKey, tokenId: rule.tokenId, tokenName: rule.tokenName, ruleIds: [], activeRuleIds: [], scopeAmbiguous: false, channels: [], associations: [], costCoverage: rule.costCoverage, coverageDeclaration: rule.coverageDeclaration, scopeVersion: rule.scopeVersion, billingEffectiveFromMs: null, firstQueryableAtMs: null }; account.keys.push(key); }
    key.ruleIds.push(rule.id); if (rule.enabled && !rule.archivedAt) key.activeRuleIds.push(rule.id);
    key.channels.push(...rule.channels.map((channel) => ({ ...channel, ownStationId: rule.ownStationId, ownSource: rule.ownSource })));
    key.associations.push({ ruleId: rule.id, status: rule.enabled && !rule.archivedAt ? "active" : "stopped", upstreamStationId: rule.upstreamStationId, ownStationId: rule.ownStationId, timezone: rule.timezone || "Asia/Shanghai", channels: rule.channels, costCoverage: rule.costCoverage, coverageDeclaration: rule.coverageDeclaration, scopeVersion: rule.scopeVersion || 1, billingEffectiveFromMs: null, accountingStartMs: null, conflict: false, conflictRuleIds: [], stoppedAt: rule.archivedAt || null });
  }
  return { accounts: [...accounts.values()], unverifiedResources, channels: config.channels, actions: [], generatedAt: "2026-10-09T07:00:00.000Z" };
}

function onboardingDirectory(config, id, tokens = onboardingTokens) {
  const station = config.upstreams.find((entry) => entry.id === id);
  return { quotaPerUnit: 500000, version: "keys-v1", groups: {}, platform: station?.identity?.provider || "newapi", capability: { state: "supported", currency: "USD", window: "second" }, billingTimezone: { state: "verified", timezone: "Asia/Shanghai" }, tokens, identity: { provider: station?.identity?.provider || "newapi", baseUrl: station?.baseUrl || "https://up.example", accountId: station?.identity?.accountId || "42" }, resourceVersion: station?.resourceVersion || "resource-" + id, probe: null };
}

function onboardingAuthorizationFixture(config, { failTarget = false } = {}) {
  const authorizationProbes = [], authorizationWrites = [], previews = new Map();
  return { authorizationProbes, authorizationWrites, accountOperation(route, path) {
    const body = route.request().postDataJSON(), account = onboardingAccounts(config).accounts.find((entry) => path.includes(entry.accountKey)); assert.ok(account);
    if (path.endsWith("/probe")) {
      authorizationProbes.push(body);
      const targets = body.targetStationIds.map((stationId) => { const resource = account.resources.find((entry) => entry.id === stationId); assert.ok(resource); return { stationId, authVersion: resource.authVersion, resourceVersion: resource.resourceVersion, currentType: resource.type, newType: body.authorization?.type || resource.type, purposes: resource.purposes, monitorChannelIds: [], billingRuleIds: resource.purposes.billingRuleIds, billingChannelIds: [] }; });
      const preview = { requestId: body.requestId, previewId: "targeted-auth-" + authorizationProbes.length, expiresAtMs: Date.now() + 600000, accountKey: account.accountKey, identity: account.identity, targets, excluded: [], impact: { monitorStationIds: targets.filter((entry) => entry.purposes.monitor).map((entry) => entry.stationId), billingRuleIds: [], channels: [] }, retryInput: { requestId: body.requestId, targetStationIds: body.targetStationIds } };
      previews.set(body.requestId, preview); return fulfill(route, preview);
    }
    authorizationWrites.push(body); const preview = previews.get(body.requestId); assert.equal(body.previewId, preview.previewId);
    const targets = preview.targets.map((target) => {
      if (failTarget) return { stationId: target.stationId, status: "failed", savedAuthVersion: null, code: "AUTHORIZATION_UPDATE_FAILED", reason: "本目标更新失败，请重试", remainingActions: ["repreview"] };
      const resource = config.upstreams.find((entry) => entry.id === target.stationId); resource.authVersion = (resource.authVersion || 1) + 1; resource.resourceVersion = (resource.resourceVersion || "resource-" + resource.id) + "-updated";
      return { stationId: target.stationId, status: "updated", savedAuthVersion: resource.authVersion, remainingActions: [] };
    });
    return fulfill(route, { requestId: body.requestId, accountKey: account.accountKey, complete: !failTarget, targets, excluded: [], impact: preview.impact, retryInput: preview.retryInput });
  } };
}

function probeResult(body, config, options = {}) {
  const selection = body.selections[0];
  const linkOnly = !selection.stationId && !selection.newStation;
  const selectedStation = config.upstreams.find((entry) => entry.id === selection.stationId), billingStation = config.upstreams.find((entry) => entry.id === selection.reconciliationAuthorization?.stationId);
  const accountIdentity = { provider: billingStation?.identity?.provider || selectedStation?.identity?.provider || (selection.newStation?.type?.startsWith("sub2api") ? "sub2api" : "newapi"), baseUrl: billingStation?.baseUrl || selection.newStation?.baseUrl || selectedStation?.baseUrl || "https://up.example", accountId: billingStation?.identity?.accountId || selectedStation?.identity?.accountId || "42" };
  const mainIdentity = linkOnly || (selection.newStation?.type || config.upstreams.find((entry) => entry.id === selection.stationId)?.type) === "newapi-key" ? null : accountIdentity;
  const groups = body.groups.map((group) => {
    const tokenId = group.reconciliation?.tokenId || null;
    const existingRule = config.rules.find((rule) => rule.enabled && !rule.archivedAt && rule.tokenId === tokenId);
    const existing = existingRule?.channels.map((channel) => channel.channelId) || [];
    const proposed = [...new Set([...existing, ...group.channels.map((entry) => entry.channelId)])];
    const monitorChanges = group.channels.map((channel) => {
      const current = config.channels.find((entry) => entry.id === channel.channelId), previousStationIds = current?.monitor?.stationIds || [];
      const proposedStationIds = [...new Set([...previousStationIds.filter((id) => !(channel.removeMonitorStationIds || []).includes(id)), ...(selection.monitor ? [selection.stationId || "new-up"] : []), ...(selection.additionalMonitorStationIds || [])])];
      return { channelId: channel.channelId, previousStationIds, proposedStationIds, addedStationIds: proposedStationIds.filter((id) => !previousStationIds.includes(id)), removedStationIds: previousStationIds.filter((id) => !proposedStationIds.includes(id)) };
    });
    return {
      groupId: group.groupId, requestedGroupIds: [group.groupId], selectionIds: [group.selectionId], requestedChannelIds: group.channels.map((entry) => entry.channelId),
      status: group.reconciliation ? options.billingStatus || (tokenId ? "ready" : "unavailable") : "monitor_only",
      ...(group.reconciliation && !tokenId && !options.billingStatus ? { code: "KEY_REQUIRED", reason: "请选择实际使用的上游 Key" } : {}),
      basis: { ownSource, sourceVersion: "source-v1", channelRevisions: Object.fromEntries(proposed.map((id) => [id, "revision-" + id])), resourceVersions: {}, accountIdentity, canonicalKey: tokenId ? existingRule?.canonicalKey || createHash("sha256").update(JSON.stringify([accountIdentity.provider, accountIdentity.baseUrl, accountIdentity.accountId, String(tokenId)])).digest("hex") : null, tokenId, keyVersion: tokenId ? "key-v1" : null, existingRuleId: existingRule?.id || null, existingScopeVersion: existingRule?.scopeVersion || null, existingChannelIds: existing, proposedChannelIds: proposed, timezone: group.reconciliation?.timezone || "Asia/Shanghai", billingEffectiveFromMs: preview.billingEffectiveFromMs, coverageDeclaration: group.reconciliation?.coverageDeclaration || { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] } },
      preview: { ...preview, costCoverage: group.reconciliation?.coverageDeclaration.answer === "none" ? "complete" : "unknown" },
      monitorChanges,
    };
  });
  return {
    requestId: body.requestId, previewId: "preview-" + body.requestId, expiresAtMs: Date.now() + 600000, source: { ownSource, sourceVersion: "source-v1", resourceVersion: "own-v1" },
    selections: [{ selectionId: selection.selectionId, station: linkOnly ? null : { id: selection.stationId || "new-up", name: "Fixture upstream" }, monitor: { status: "verified" }, authorizationStationId: selection.reconciliationAuthorization?.stationId || (mainIdentity ? selection.stationId || null : null), accountIdentity: mainIdentity, tokens: options.billingStatus ? [] : onboardingTokens, credentialUpdateRequired: !!options.requireUpdate }],
    groups,
    retryInput: { requestId: body.requestId, source: { ownStationId: body.ownStationId, ownSource, sourceVersion: "source-v1" }, selections: [{ selectionId: selection.selectionId, stationId: selection.stationId || null, type: linkOnly ? null : selection.newStation?.type || config.upstreams.find((entry) => entry.id === selection.stationId)?.type || "newapi", baseUrl: linkOnly ? null : selection.newStation?.baseUrl || "https://up.example", ...(linkOnly ? { linkOnly: true } : {}), monitor: selection.monitor, additionalMonitorStationIds: selection.additionalMonitorStationIds || [], accountIdentity: mainIdentity, authorizationStationId: selection.reconciliationAuthorization?.stationId || null, authorizationIdentity: linkOnly ? null : accountIdentity, credentialUpdateRequested: !!selection.updateCredentials && !!selection.newStation }], groups: groups.map((group, index) => ({ groupId: group.groupId, requestedGroupIds: group.requestedGroupIds, selectionIds: group.selectionIds, channels: body.groups[index].channels, reconciliationRequested: !!body.groups[index].reconciliation, reconciliation: group.basis.tokenId ? { canonicalKey: group.basis.canonicalKey, tokenId: group.basis.tokenId, timezone: group.basis.timezone, coverageDeclaration: group.basis.coverageDeclaration, previewEffectiveFromMs: preview.billingEffectiveFromMs } : null })) },
  };
}
function batchResult(body, probe, complete = true) {
  return { requestId: body.requestId, complete, retryInput: probe.retryInput, groups: probe.groups.map((group) => ({
    groupId: group.groupId, requestedGroupIds: group.requestedGroupIds, canonicalKey: group.basis.canonicalKey, complete,
    monitor: { status: body.selections[0].monitor ? "linked" : "not_requested", stationIds: body.selections[0].monitor ? [body.selections[0].stationId || "new-up"] : [] },
    reconciliation: { status: body.groups[0].reconciliation ? complete ? "configured" : "unverified" : "not_requested", ruleId: complete ? "rule-" + (group.basis.tokenId || "monitor") : undefined },
    saved: { stationIds: body.selections[0].monitor ? [body.selections[0].stationId || "new-up"] : [], authorizationStationId: !body.groups[0].reconciliation ? null : !body.selections[0].monitor ? body.selections[0].stationId || "new-billing-auth" : body.selections[0].reconciliationAuthorization ? body.selections[0].reconciliationAuthorization.stationId || "billing-auth" : null, links: [], ruleId: complete && body.groups[0].reconciliation ? "rule-" + group.basis.tokenId : null, scopeVersion: 2, billingEffectiveFromMs: Date.parse("2026-10-10T12:00:00+08:00") },
    channels: body.groups.find((entry) => entry.groupId === group.groupId).channels.map((entry) => ({ ...entry, complete, stationIds: [body.selections[0].stationId || "new-up"], ruleId: complete ? "rule-" + group.basis.tokenId : null, remainingActions: complete ? [] : ["retry_rule"] })),
    remainingActions: complete ? [] : ["repreview"],
  })) };
}
async function openOnboardingPage(t, options = {}) {
  const config = options.config || onboardingFixture(), probes = [], writes = [], reads = [], recoveries = [], operations = new Map();
  let latestProbe, latestResult;
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (/^\/api\/reconciliation\/upstreams\/[^/]+\/keys$/.test(path)) {
      reads.push({ path, method: route.request().method(), query: new URL(route.request().url()).search });
      if (options.keyDirectory) return options.keyDirectory(route, path, reads, config);
      if (options.readonlyAPI) return options.readonlyAPI(route, path);
      return fulfill(route, onboardingDirectory(config, decodeURIComponent(path.split("/")[4]), options.tokens));
    }
    if (path === "/api/reconciliation/configuration") return fulfill(route, options.ruleConfiguration || configuration);
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, options.ruleModel || response(options.ruleResults || [rule("rule-1", "Rule A", 10)]));
    if (options.extraAPI) return options.extraAPI(route, path);
    throw new Error("unexpected fixture API: " + path);
  }, options.viewport, !!options.clock, async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/channel-onboarding/accounts") { reads.push({ path, method: request.method() }); return options.accounts ? options.accounts(route, reads) : fulfill(route, options.accountModel || onboardingAccounts(config)); }
    if (options.accountOperation && path.startsWith("/api/channel-onboarding/accounts/")) return options.accountOperation(route, path);
    if (/^\/api\/channel-onboarding\/resources\/[^/]+\/identity$/.test(path) && options.extraAPI) return options.extraAPI(route, path);
    if (request.method() === "GET" || path.endsWith("/sync")) { reads.push({ path, method: request.method() }); return options.discovery ? options.discovery(route, reads, config) : fulfill(route, config); }
    const body = request.postDataJSON();
    if (path === "/api/channel-onboarding/batch/probe") { probes.push(body); latestProbe = options.probe ? options.probe(body, probes.length, config) : probeResult(body, config, options); latestProbe.previewId += "-" + probes.length; operations.set(body.requestId, { ...(operations.get(body.requestId) || {}), input: body, probe: latestProbe }); return fulfill(route, latestProbe); }
    if (path === "/api/channel-onboarding/batch/recover") { recoveries.push(body); const operation = operations.get(body.requestId); return fulfill(route, options.recover ? options.recover(body, operation?.result) : operation?.result || batchResult(operation.input, operation.probe, false)); }
    assert.equal(path, "/api/channel-onboarding/batch");
    writes.push(body);
    latestResult = options.connect ? options.connect(body, writes.length, latestProbe) : batchResult(body, latestProbe);
    operations.get(body.requestId).result = latestResult;
    if (latestResult.complete) for (const group of body.groups) for (const channel of group.channels) {
      const entry = config.channels.find((entry) => entry.id === channel.channelId);
      const change = latestProbe.groups.find((entry) => entry.groupId === group.groupId).monitorChanges.find((entry) => entry.channelId === channel.channelId);
      entry.monitor = { status: change.proposedStationIds.length ? "linked" : "unlinked", stationIds: change.proposedStationIds };
      if (group.reconciliation) entry.reconciliation = { status: "configured", ruleIds: ["rule-1"] };
    }
    if (options.loseResponseAt === writes.length) return route.abort("failed");
    return fulfill(route, latestResult);
  }, options.onboardingPath || "/stations?view=onboarding");
  const channelButton = newChannelButton(page);
  if (config.stale) await channelButton.waitFor();
  else await channelButton.click({ trial: true });
  return { page, config, probes, writes, reads, recoveries };
}
// 渠道绑定的话：按钮名来自 lib/workflow-actions.js，其余在 app/components/channel-onboarding.tsx 的 COPY 表（tsx 测试里引用不到，照抄原句）
const CONNECT = workflowActionMeta("connect_channels").label, EDIT_BINDING = workflowActionMeta("edit_binding").label, TEST_READ = workflowActionMeta("verify_identity").label, REFRESH = workflowActionMeta("refresh").label, RETRY = workflowActionMeta("retry_bill").label;
// 单条「重新读取」没成时那一句：和 app/(dashboard)/reconciliation/recon-format.ts 的 RETRY_FAILED_TEXT 一致（§8.1）
const RETRY_FAILED = "重新读取没完成，请稍后再试";
const UPDATE_AUTH = workflowActionMeta("update_authorization").label, USE_SAVED = "用已有上游", NEW_UPSTREAM = "新增上游", CREATE_HINT = "保存后，别的渠道也能直接用这个上游。";
const CONFIRM_BINDING = "确认绑定", PROBE_OK = `${testReadText({ ok: true, bill: false })}，还没保存`, ACCESS_TOKEN = "访问令牌";
const BILLING_CHECKBOX = `同时${ONBOARDING_PURPOSES.billing}（绑定 Key）`, ONLY_THESE = COVERAGE_ANSWERS.find((entry) => entry.value === "none").label, UNSURE = COVERAGE_ANSWERS.find((entry) => entry.value === "unknown").label;
const connectButton = (name, action = CONNECT) => `${action}「${name}」`;
const keyOption = (name, group = "upstream-group") => `${name} · 分组 ${group}`;
// 已经看余额或算利润的渠道按钮是「改绑定「X」」，其余是「去绑定「X」」
const newChannelButton = (page) => page.getByRole("button", { name: new RegExp(`^(${CONNECT}|${EDIT_BINDING})「New channel」$`) });
async function openOnboardingDrawer(page, batch = false) {
  if (batch) { await page.getByText("选中筛出来的渠道（最多 100 个）", { exact: true }).click(); await page.getByRole("button", { name: new RegExp(`^${CONNECT}（\\d+ 个渠道）$`) }).click(); }
  else await newChannelButton(page).click();
  return page.getByRole("dialog", { name: CONNECT, exact: true });
}
async function verifyOnboarding(drawer) {
  const button = drawer.getByRole("button", { name: TEST_READ, exact: true });
  await button.scrollIntoViewIfNeeded();
  const devBadge = drawer.page().getByRole("button", { name: "Collapse issues badge", exact: true });
  if (await devBadge.isVisible()) await devBadge.click();
  const response = drawer.page().waitForResponse((response) => new URL(response.url()).pathname === "/api/channel-onboarding/batch/probe");
  await button.click(); await response; await drawer.getByText(PROBE_OK, { exact: true }).waitFor();
}
// 「这把 Key 还给别处用吗？」一开始不选（ui-copy-spec §5.2）：选好 Key 以后先回答，再测试读取；几把 Key 时按 Key 名找
async function answerCoverage(page, drawer, { key, answer = ONLY_THESE } = {}) { await drawer.getByRole("combobox", { name: key ? `${key} · ${COVERAGE_QUESTION}` : COVERAGE_QUESTION, exact: true }).click(); await page.getByText(answer, { exact: true }).last().click(); }
async function chooseKey(page, drawer, name = "Supplier Key") { await drawer.getByRole("combobox", { name: "Key", exact: true }).click(); await page.getByText(keyOption(name), { exact: true }).last().click(); }
// 已绑定过 Key 的渠道勾的是「改绑定（算利润）」；新填的登录信息要先测试读取一次才列得出 Key
async function enableBilling(page, drawer, key = "Supplier Key") {
  await drawer.getByRole("checkbox", { name: new RegExp(`^(${BILLING_CHECKBOX}|${EDIT_BINDING}（${ONBOARDING_PURPOSES.billing}）)$`) }).check();
  const select = drawer.getByRole("combobox", { name: "Key", exact: true });
  if (await select.isDisabled() && await drawer.locator("form").count()) await verifyOnboarding(drawer);
  await chooseKey(page, drawer, key);
  await answerCoverage(page, drawer);
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true); await verifyOnboarding(drawer);
}
async function saveOnboarding(drawer) { await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await drawer.waitFor({ state: "hidden" }); }
// 报错只写归类后的那句（§8.2），原文收在「查看详细原因」里：找到收着这段原文的那一处，核对它前面写的那句
async function problemShown(scope, raw, code) {
  const detail = scope.locator("details.jy-error-detail", { has: scope.page().getByText(raw, { exact: true }) }).first();
  await detail.waitFor();
  assert.equal(await detail.evaluate((node) => node.parentElement.firstChild.textContent), describeError({ code, reason: raw }).text);
}
// 填访问令牌的输入框；补账单登录信息时旁边还有一个同名的「访问令牌」下拉框，只认输入框
const tokenField = (scope) => scope.locator("input[type=password]").and(scope.getByLabel(ACCESS_TOKEN, { exact: true }));
// 页面顶部「接着做完：渠道名」接着上次没做完的；抽屉里的「接着做完」把剩下的保存掉
const FINISH = "接着做完", RESUME = new RegExp(`^${FINISH}：`);
// 只看余额时不出现算利润的预览：上游账号、从哪天开始算、同一把 Key 只算一次
const BILLING_PREVIEW = /上游账号：|从现在开始算利润|开始统计|上游成本只算一次/;
// 渠道绑定抽屉里其余的字段和按钮名（和 app/components/channel-onboarding.tsx 的 COPY 一致）
const MONITOR = ONBOARDING_PURPOSES.monitor, EDIT_BILLING = `${EDIT_BINDING}（${ONBOARDING_PURPOSES.billing}）`, RESUME_MONITOR = workflowActionMeta("resume_monitor").label;
const KEY_ACCOUNT = "这把 Key 属于哪个上游账号", NEW_AUTHORIZATION = "填一个新的访问令牌", REUSE_SAVED = "用已保存的", CREDENTIAL_TITLE = { primary: "这个上游账号已经保存过", authorization: "读账单用的上游账号已经保存过" };
const UPDATE_FIXTURE = connectButton("Fixture upstream", UPDATE_AUTH), PARTIAL = "还有几步没做完，做完的会保留", upstreamType = (value) => UPSTREAM_TYPES.find((entry) => entry.value === value).label;
const apiKeyField = (scope) => scope.locator("input[type=password]").and(scope.getByLabel(CREDENTIAL_FIELDS.apiKey.label, { exact: true }));

test("configured channel management preserves monitors and Key billing without a preview or write", async (t) => {
  const config = onboardingFixture(); config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1"] }; config.channels[0].reconciliation = { status: "configured", ruleIds: ["rule-1"] }; config.rules[0].channels.push({ channelId: 4, name: "New channel" });
  const { page, probes, writes, reads } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByText("现在的设置", { exact: true }).waitFor(); await drawer.getByText(`${MONITOR}：Fixture upstream`, { exact: true }).waitFor();
  await drawer.getByText(`${ONBOARDING_PURPOSES.billing}：Fixture upstream · Supplier Key · 渠道 #1、渠道 #2、渠道 #3、New channel`, { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("radio", { name: "不改", exact: true }).isChecked(), true);
  assert.equal(await drawer.getByRole("checkbox", { name: EDIT_BILLING, exact: true }).isChecked(), false);
  assert.equal(await drawer.getByRole("button", { name: TEST_READ, exact: true }).count(), 0);
  const done = drawer.getByRole("button", { name: "完成", exact: true }); assert.equal(await done.isEnabled(), true);
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).count(), 0); await done.click(); await drawer.waitFor({ state: "hidden" });
  assert.equal(probes.length, 0); assert.equal(writes.length, 0); assert.equal(reads.filter((entry) => entry.path.endsWith("/keys")).length, 0);
});

test("configured binding with unknown coverage says bound without claiming its income is accounted", async (t) => {
  const config = onboardingFixture();
  config.channels[0].reconciliation = { status: "configured", ruleIds: ["rule-1"] };
  Object.assign(config.rules[0], { costCoverage: "unknown", coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] } });
  const { page, writes } = await openOnboardingPage(t, { config });
  const row = page.locator(".ant-list-item").filter({ hasText: "New channel" });
  await row.getByText("已绑定", { exact: true }).waitFor();
  assert.equal(await row.getByText("已算进利润", { exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "状态", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("已绑定", { exact: true }).click();
  await row.getByText("已绑定", { exact: true }).waitFor();
  assert.equal(writes.length, 0);
});

test("billing-only configured channel keeps monitoring unchanged and prefills its Key coverage and timezone when edited", async (t) => {
  const config = onboardingFixture(); config.channels[0].reconciliation = { status: "configured", ruleIds: ["rule-1"] }; config.rules[0].channels.push({ channelId: 4, name: "New channel" }); config.rules[0].timezone = "UTC";
  const { page, probes, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page);
  assert.equal(await drawer.getByRole("radio", { name: "不改", exact: true }).isChecked(), true); assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).count(), 0);
  assert.equal(await drawer.getByRole("button", { name: TEST_READ, exact: true }).count(), 0); assert.equal(writes.length, 0);
  await drawer.getByRole("checkbox", { name: EDIT_BILLING, exact: true }).check(); await drawer.getByText(keyOption("Supplier Key"), { exact: true }).waitFor();
  await drawer.getByText(ONLY_THESE, { exact: true }).waitFor(); assert.equal(probes.length, 0); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(probes.length, 1); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].groups[0].reconciliation.tokenId, 7); assert.equal(writes[0].groups[0].reconciliation.timezone, "UTC"); assert.equal(writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.deepEqual(config.channels[0].monitor.stationIds, []);
});

test("saved account reads its Key directory and complete scope before one final preview", async (t) => {
  const { page, probes, writes, reads } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await chooseKey(page, drawer);
  await drawer.getByText("绑定后这把 Key 的渠道：渠道 #1、渠道 #2、渠道 #3、New channel", { exact: true }).waitFor();
  await drawer.getByRole("combobox", { name: COVERAGE_QUESTION, exact: true }).click(); await page.getByText(ONLY_THESE, { exact: true }).last().click();
  assert.equal(probes.length, 0); assert.equal(writes.length, 0);
  const directoryReads = reads.filter((entry) => entry.path.endsWith("/keys")); assert.equal(directoryReads.length, 1); assert.equal(directoryReads[0].query, "?force=true");
  await verifyOnboarding(drawer); assert.equal(probes.length, 1); assert.equal(probes[0].groups[0].reconciliation.coverageDeclaration.answer, "none");
  await drawer.getByText("Key：Supplier Key", { exact: true }).waitFor(); await drawer.getByText("上游账号：https://up.example · 账号 42", { exact: true }).waitFor(); await saveOnboarding(drawer); assert.equal(writes.length, 1);
});

test("duplicate Key names remain distinguishable by ID in selection and final preview", async (t) => {
  const tokens = onboardingTokens.map((token) => ({ ...token, name: "default" }));
  const { page, writes } = await openOnboardingPage(t, { tokens }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await drawer.getByRole("combobox", { name: CREDENTIAL_FIELDS.apiKey.label, exact: true }).click();
  await page.getByText(keyOption("default（Key #7）"), { exact: true }).last().waitFor(); await page.getByText(keyOption("default（Key #8）"), { exact: true }).last().click();
  await answerCoverage(page, drawer); await verifyOnboarding(drawer); await drawer.getByText("Key：default（Key #8）", { exact: true }).waitFor(); await saveOnboarding(drawer); assert.equal(writes[0].groups[0].reconciliation.tokenId, 8);
});

test("late directory responses cannot replace the newly selected account Keys", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ ...config.upstreams[0], id: "account-B", name: "Account B", identity: { provider: "newapi", accountId: "84" } });
  let releaseFirst; const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const { page, writes } = await openOnboardingPage(t, { config, async keyDirectory(route, path) {
    const id = path.split("/")[4]; if (id === "upstream-1") await holdFirst;
    return fulfill(route, onboardingDirectory(config, id, id === "account-B" ? [{ id: 8, name: "Account B Key", group: "upstream-group", status: 1 }] : onboardingTokens));
  } });
  const drawer = await openOnboardingDrawer(page), firstRequest = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/upstream-1/keys")); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await firstRequest;
  await drawer.getByRole("combobox", { name: "上游", exact: true }).fill("Account B"); await page.getByText("Account B · 账号 84", { exact: true }).last().click();
  await chooseKey(page, drawer, "Account B Key", 8); const late = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/upstream-1/keys")); releaseFirst(); await late;
  await drawer.getByRole("combobox", { name: CREDENTIAL_FIELDS.apiKey.label, exact: true }).click(); const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)"); await dropdown.getByText(keyOption("Account B Key"), { exact: true }).waitFor(); assert.equal(await dropdown.getByText(keyOption("Supplier Key"), { exact: true }).count(), 0); await page.keyboard.press("Escape");
  await answerCoverage(page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].stationId, "account-B"); assert.equal(writes[0].groups[0].reconciliation.tokenId, 8);
});

test("unreadable account Key directory explains authorization retry without claiming the account has no Keys", async (t) => {
  let attempts = 0;
  const { page, probes, writes, reads } = await openOnboardingPage(t, { keyDirectory(route, path, reads, config) {
    const result = onboardingDirectory(config, "upstream-1"); if (++attempts === 1) { result.tokens = []; result.capability = { ...result.capability, state: "unverified", reason: "KEY_METADATA_UNAVAILABLE" }; } return fulfill(route, result);
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await drawer.getByText(failureText("读不到这个账号的 Key", { code: "KEY_METADATA_UNAVAILABLE" }), { exact: true }).waitFor();
  assert.equal(await drawer.getByText("这个账号里还没有能用的 Key，请先在上游建一把。", { exact: true }).count(), 0); assert.equal(probes.length, 0); assert.equal(writes.length, 0);
  await drawer.getByRole("button", { name: REFRESH, exact: true }).click(); await chooseKey(page, drawer); assert.equal(reads.filter((entry) => entry.path.endsWith("/keys")).length, 2);
  await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1);
});

test("pure Key billing never selects an unrelated first account automatically", async (t) => {
  const config = onboardingFixture(true, "newapi-key"); config.upstreams.unshift({ id: "unrelated", name: "Unrelated account", type: "sub2api", baseUrl: "https://unrelated.example", monitorEnabled: true, identity: { provider: "sub2api", accountId: "99" } });
  const { page, probes, writes, reads } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await drawer.getByText("选实际的上游账号，地址对得上只是提示", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("combobox", { name: KEY_ACCOUNT, exact: true }).inputValue(), "");
  assert.equal(await drawer.getByRole("combobox", { name: CREDENTIAL_FIELDS.apiKey.label, exact: true }).isDisabled(), true);
  assert.equal(reads.filter((entry) => entry.path.endsWith("/keys")).length, 0); assert.equal(probes.length, 0); assert.equal(writes.length, 0);
});

test("monitor replacement previews every old link and removes only the selected channel links on confirmation", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ ...config.upstreams[0], id: "old-extra", name: "Old additional monitor" }, { ...config.upstreams[0], id: "replacement", name: "Replacement monitor", identity: { provider: "newapi", accountId: "84" } }); config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1", "old-extra"] };
  const { page, probes, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("radio", { name: "换上游", exact: true }).check(); await drawer.getByRole("combobox", { name: "上游", exact: true }).fill("Replacement monitor"); await page.getByText("Replacement monitor · 账号 84", { exact: true }).last().click();
  await verifyOnboarding(drawer); const changes = drawer.getByRole("region", { name: "「New channel」看余额的变化", exact: true }); await changes.getByText("去掉：Fixture upstream、Old additional monitor", { exact: true }).waitFor(); await changes.getByText("加上：Replacement monitor", { exact: true }).waitFor();
  assert.equal(writes.length, 0); assert.deepEqual(probes[0].groups[0].channels[0].removeMonitorStationIds, ["upstream-1", "old-extra"]); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].stationId, "replacement"); assert.deepEqual(config.channels[0].monitor.stationIds, ["replacement"]); assert.equal(writes[0].groups[0].reconciliation, null);
});

test("monitor removal needs no new resource and requires an explicit guarded link preview", async (t) => {
  const config = onboardingFixture(); config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1"] }; config.channels[0].reconciliation = { status: "configured", ruleIds: ["rule-1"] };
  const { page, probes, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page); await drawer.getByRole("radio", { name: "去掉上游", exact: true }).check();
  assert.equal(await drawer.getByRole("checkbox", { name: "去掉「Fixture upstream」", exact: true }).isChecked(), true); assert.equal(await drawer.getByRole("combobox", { name: "上游", exact: true }).count(), 0);
  await verifyOnboarding(drawer); const removal = drawer.getByRole("region", { name: "「New channel」看余额的变化", exact: true }); await removal.getByText("去掉：Fixture upstream", { exact: true }).waitFor();
  // 预览只写有内容的行（ui-design-spec §5.2）：没有「不变：—」「加上：—」
  assert.equal(await removal.getByText(/^(不变|加上)：/).count(), 0);
  assert.equal(writes.length, 0); assert.equal("stationId" in probes[0].selections[0], false); assert.equal("newStation" in probes[0].selections[0], false); assert.equal(probes[0].selections[0].monitor, false);
  assert.deepEqual(probes[0].groups[0].channels[0].removeMonitorStationIds, ["upstream-1"]); await saveOnboarding(drawer); assert.deepEqual(config.channels[0].monitor.stationIds, []); assert.deepEqual(config.channels[0].reconciliation.ruleIds, ["rule-1"]);
});

test("paused replacement target cannot silently become removal of the existing monitor", async (t) => {
  const config = onboardingFixture(); config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1"] }; config.upstreams.push({ ...config.upstreams[0], id: "paused", name: "Paused replacement", monitorEnabled: false });
  const { page, probes, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page); await drawer.getByRole("radio", { name: "换上游", exact: true }).check();
  await drawer.getByRole("combobox", { name: "上游", exact: true }).fill("Paused replacement"); await page.getByText("Paused replacement · 账号 42 · 暂停监控", { exact: true }).last().click();
  await drawer.getByText("这个上游暂停了监控，恢复后就能看余额。", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("button", { name: TEST_READ, exact: true }).isDisabled(), true); assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true);
  assert.equal(probes.length, 0); assert.equal(writes.length, 0); assert.deepEqual(config.channels[0].monitor.stationIds, ["upstream-1"]);
});

test("paused resource explains activation and reuses its settings before channel association", async (t) => {
  const config = onboardingFixture(); config.upstreams[0].monitorEnabled = false; config.upstreams[0].includeInProfit = true; config.upstreams[0].lowBalanceUsd = 27; const mutations = [];
  const { page, writes } = await openOnboardingPage(t, { config, extraAPI(route, path) {
    if (path === "/api/stations/upstream-1" && route.request().method() === "PUT") { const body = route.request().postDataJSON(); mutations.push(body); config.upstreams[0].monitorEnabled = body.monitorEnabled; config.upstreams[0].resourceVersion += "-enabled"; return fulfill(route, { ok: true }); }
    throw new Error("unexpected paused fixture API: " + path);
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByText("这个上游暂停了监控，恢复后就能看余额。", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isDisabled(), true);
  await drawer.getByRole("button", { name: RESUME_MONITOR, exact: true }).click(); const confirmation = page.getByRole("dialog", { name: `${RESUME_MONITOR}「Fixture upstream」？`, exact: true }); await confirmation.getByRole("button", { name: RESUME_MONITOR, exact: true }).click(); await confirmation.waitFor({ state: "hidden" });
  assert.deepEqual(mutations, [{ monitorEnabled: true, expectedAuthVersion: 1, expectedResourceVersion: "resource-upstream-1" }]); assert.equal(config.upstreams[0].includeInProfit, true); assert.equal(config.upstreams[0].lowBalanceUsd, 27);
  assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), true); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].stationId, "upstream-1");
});

test("multiple unfinished saves survive unrelated previews and resume their own operation", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5]), connect(body, count, probe) { return batchResult(body, probe, false); } });
  const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await drawer.getByText(PARTIAL, { exact: true }).waitFor(); await drawer.locator(".ant-drawer-close").click(); await drawer.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: connectButton("New channel 5"), exact: true }).click(); await verifyOnboarding(drawer);
  let pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem("channel-onboarding-pending-v06"))); assert.equal(pending.length, 1); assert.equal(pending[0].requestId, writes[0].requestId);
  await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await drawer.getByText(PARTIAL, { exact: true }).waitFor(); await drawer.locator(".ant-drawer-close").click(); await drawer.waitFor({ state: "hidden" });
  pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem("channel-onboarding-pending-v06"))); assert.deepEqual(pending.map((entry) => entry.requestId), writes.map((entry) => entry.requestId)); assert.doesNotMatch(JSON.stringify(pending), /accessToken|apiKey|password/);
  await page.reload(); const pendingList = page.getByRole("region", { name: "还没做完", exact: true }), resume = pendingList.getByRole("button"); await resume.first().waitFor(); assert.equal(await resume.count(), 2);
  const channelResume = page.getByRole("button", { name: connectButton("New channel 5", FINISH), exact: true }); assert.equal(await channelResume.textContent(), FINISH); await channelResume.click(); await drawer.getByText(PARTIAL, { exact: true }).waitFor(); assert.equal(recoveries[0].requestId, writes[1].requestId); assert.deepEqual(recoveries[0].groups[0].channels.map((channel) => channel.channelId), [5]);
  await drawer.locator(".ant-drawer-close").click(); await drawer.waitFor({ state: "hidden" }); await pendingList.getByRole("button", { name: `${FINISH}：New channel`, exact: true }).click(); await drawer.getByText(PARTIAL, { exact: true }).waitFor(); assert.equal(recoveries[1].requestId, writes[0].requestId); assert.equal(writes.length, 2);
});

test("shared authorization update preserves the channel draft and Escape closes only the top drawer", async (t) => {
  const config = onboardingFixture(), authorizationProbes = [], authorizationWrites = [];
  const { page, probes, writes } = await openOnboardingPage(t, { config, async accountOperation(route, path) {
    const body = route.request().postDataJSON(), account = onboardingAccounts(config).accounts[0], target = account.resources[0];
    const impact = { monitorStationIds: [target.id], billingRuleIds: ["rule-1"], channels: [] };
    if (path.endsWith("/probe")) { authorizationProbes.push(body); return fulfill(route, { requestId: body.requestId, previewId: "shared-auth-preview", expiresAtMs: Date.now() + 600000, accountKey: account.accountKey, identity: account.identity, targets: [{ stationId: target.id, authVersion: target.authVersion, resourceVersion: target.resourceVersion, currentType: target.type, newType: body.authorization.type, purposes: target.purposes, monitorChannelIds: [], billingRuleIds: ["rule-1"], billingChannelIds: [] }], excluded: [], impact, retryInput: { requestId: body.requestId, targetStationIds: body.targetStationIds } }); }
    authorizationWrites.push(body); config.upstreams[0].authVersion += 1; config.upstreams[0].resourceVersion += "-updated";
    return fulfill(route, { requestId: body.requestId, accountKey: account.accountKey, complete: true, targets: [{ stationId: target.id, status: "updated", savedAuthVersion: 2, remainingActions: [] }], excluded: [], impact, retryInput: { requestId: body.requestId, targetStationIds: body.targetStationIds } });
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await chooseKey(page, drawer); await drawer.getByRole("combobox", { name: COVERAGE_QUESTION, exact: true }).click(); await page.getByText(ONLY_THESE, { exact: true }).last().click();
  await drawer.getByRole("button", { name: UPDATE_FIXTURE, exact: true }).click(); const authorization = authorizationDialog(page, "42"); await authorization.waitFor();
  await page.keyboard.press("Escape"); await authorization.waitFor({ state: "hidden" }); assert.equal(await drawer.isVisible(), true); assert.equal(await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).isChecked(), true); await drawer.getByText(keyOption("Supplier Key"), { exact: true }).waitFor();
  await drawer.getByRole("button", { name: UPDATE_FIXTURE, exact: true }).click(); await authorization.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-updated-pat"); await previewAuthorization(authorization); await confirmAccountAuthorization(authorization);
  assert.deepEqual(authorizationProbes[0].targetStationIds, ["upstream-1"]); assert.deepEqual(authorizationWrites[0].targetStationIds, ["upstream-1"]); assert.equal(authorizationWrites[0].previewId, "shared-auth-preview"); assert.equal(writes.length, 0); assert.equal(probes.length, 0);
  await authorization.locator(".ant-drawer-close").click(); await authorization.waitFor({ state: "hidden" }); assert.equal(await drawer.isVisible(), true); await drawer.getByText(keyOption("Supplier Key"), { exact: true }).waitFor();
  await verifyOnboarding(drawer); assert.equal(probes[0].groups[0].reconciliation.tokenId, 7); assert.equal(probes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("newStation" in writes[0].selections[0], false);
});

test("updating an existing billing account preserves the new primary pure Key draft", async (t) => {
  const config = onboardingFixture(), auth = onboardingAuthorizationFixture(config);
  const { page, probes, writes } = await openOnboardingPage(t, { config, accountOperation: auth.accountOperation }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click(); await drawer.getByLabel(CREDENTIAL_FIELDS.type.label, { exact: true }).click(); await page.getByText(upstreamType("newapi-key"), { exact: true }).last().click();
  await drawer.getByLabel(CREDENTIAL_FIELDS.name.label, { exact: true }).fill("Primary Key draft"); await apiKeyField(drawer).fill("fixture-primary-key-secret"); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await drawer.getByRole("combobox", { name: KEY_ACCOUNT, exact: true }).click(); await page.getByText("Fixture upstream · 账号 42 · https://up.example", { exact: true }).last().click(); await chooseKey(page, drawer, "New Key");
  await drawer.getByRole("combobox", { name: COVERAGE_QUESTION, exact: true }).click(); await page.getByText(ONLY_THESE, { exact: true }).last().click();
  await drawer.getByRole("button", { name: UPDATE_FIXTURE, exact: true }).click(); const authorization = authorizationDialog(page, "42");
  await authorization.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-billing-account-pat"); await previewAuthorization(authorization); await confirmAccountAuthorization(authorization); await authorization.locator(".ant-drawer-close").click(); await authorization.waitFor({ state: "hidden" });
  assert.equal(await apiKeyField(drawer).inputValue(), "fixture-primary-key-secret"); assert.equal(await drawer.getByLabel(CREDENTIAL_FIELDS.name.label, { exact: true }).inputValue(), "Primary Key draft");
  assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), true); assert.equal(await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).isChecked(), true); await drawer.getByText(keyOption("New Key"), { exact: true }).waitFor(); await drawer.getByText(ONLY_THESE, { exact: true }).waitFor();
  assert.equal(writes.length, 0); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(probes.at(-1).selections[0].newStation.type, "newapi-key"); assert.equal(writes[0].selections[0].newStation.apiKey, "fixture-primary-key-secret"); assert.equal("stationId" in writes[0].selections[0], false); assert.deepEqual(writes[0].selections[0].reconciliationAuthorization, { stationId: "upstream-1" }); assert.equal(writes[0].groups[0].reconciliation.tokenId, 8); assert.equal(writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.deepEqual(auth.authorizationWrites[0].targetStationIds, ["upstream-1"]);
});

test("updating a duplicate primary account explicitly adopts the saved resource", async (t) => {
  const config = onboardingFixture(), auth = onboardingAuthorizationFixture(config);
  const { page, writes } = await openOnboardingPage(t, { config, accountOperation: auth.accountOperation, probe(body, count, config) {
    const next = probeResult(body, config), selection = next.selections[0]; selection.credentialUpdates = [];
    if (body.selections[0].newStation) { selection.station.id = "upstream-1"; selection.credentialUpdates = [{ role: "primary", stationId: "upstream-1" }]; selection.credentialUpdateRequired = true; }
    return next;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click(); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-duplicate-primary-pat"); await verifyOnboarding(drawer);
  await drawer.getByRole("button", { name: UPDATE_AUTH, exact: true }).click(); const authorization = authorizationDialog(page, "42");
  assert.equal(await authorization.getByLabel(ACCESS_TOKEN, { exact: true }).inputValue(), "fixture-duplicate-primary-pat"); await previewAuthorization(authorization); await confirmAccountAuthorization(authorization); await authorization.locator(".ant-drawer-close").click(); await authorization.waitFor({ state: "hidden" });
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0); await drawer.getByText("Fixture upstream · 账号 42", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), true);
  await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("newStation" in writes[0].selections[0], false); assert.deepEqual(auth.authorizationWrites[0].targetStationIds, ["upstream-1"]);
});

for (const action of ["reuse", "update", "failed update"]) {
  test(`duplicate billing authorization ${action} targets only the saved billing account and preserves the new Key`, async (t) => {
    const config = onboardingFixture(), auth = onboardingAuthorizationFixture(config, { failTarget: action === "failed update" });
    const { page, writes } = await openOnboardingPage(t, { config, accountOperation: auth.accountOperation, probe(body, count, config) {
      const next = probeResult(body, config), selection = next.selections[0]; selection.credentialUpdates = [];
      if (body.selections[0].reconciliationAuthorization?.newAuthorization) { selection.station.id = null; selection.credentialUpdates = [{ role: "authorization", stationId: "upstream-1" }]; selection.credentialUpdateRequired = true; }
      return next;
    } });
    const drawer = await openOnboardingDrawer(page); await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click(); await drawer.getByLabel(CREDENTIAL_FIELDS.type.label, { exact: true }).click(); await page.getByText(upstreamType("newapi-key"), { exact: true }).last().click();
    await apiKeyField(drawer).fill("fixture-primary-key-secret"); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await drawer.getByRole("combobox", { name: KEY_ACCOUNT, exact: true }).click(); await page.getByText(NEW_AUTHORIZATION, { exact: true }).last().click(); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-duplicate-billing-pat");
    await verifyOnboarding(drawer); await drawer.getByText(CREDENTIAL_TITLE.authorization, { exact: true }).waitFor(); assert.equal(await drawer.getByText(CREDENTIAL_TITLE.primary, { exact: true }).count(), 0); assert.equal(await drawer.getByRole("button", { name: REUSE_SAVED, exact: true }).count(), 1); assert.equal(await drawer.getByRole("button", { name: UPDATE_AUTH, exact: true }).count(), 1);
    await chooseKey(page, drawer, "New Key"); await drawer.getByRole("combobox", { name: COVERAGE_QUESTION, exact: true }).click(); await page.getByText(ONLY_THESE, { exact: true }).last().click();
    if (action === "reuse") await drawer.getByRole("button", { name: REUSE_SAVED, exact: true }).click();
    else {
      await drawer.getByRole("button", { name: UPDATE_AUTH, exact: true }).click(); const authorization = authorizationDialog(page, "42");
      assert.equal(await authorization.getByLabel(ACCESS_TOKEN, { exact: true }).inputValue(), "fixture-duplicate-billing-pat"); await previewAuthorization(authorization); await confirmAccountAuthorization(authorization); await authorization.locator(".ant-drawer-close").click(); await authorization.waitFor({ state: "hidden" }); assert.deepEqual(auth.authorizationWrites[0].targetStationIds, ["upstream-1"]);
    }
    assert.equal(await apiKeyField(drawer).inputValue(), "fixture-primary-key-secret"); assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), true); assert.equal(await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).isChecked(), true); assert.equal(writes.length, 0);
    if (action === "failed update") { assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).inputValue(), "fixture-duplicate-billing-pat"); await drawer.getByText(NEW_AUTHORIZATION, { exact: true }).waitFor(); assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true); return; }
    assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0); await drawer.getByText(keyOption("New Key"), { exact: true }).waitFor(); await drawer.getByText(ONLY_THESE, { exact: true }).waitFor(); await verifyOnboarding(drawer); await saveOnboarding(drawer);
    assert.equal(writes[0].selections[0].newStation.type, "newapi-key"); assert.equal(writes[0].selections[0].newStation.apiKey, "fixture-primary-key-secret"); assert.equal("stationId" in writes[0].selections[0], false); assert.deepEqual(writes[0].selections[0].reconciliationAuthorization, { stationId: "upstream-1" }); assert.equal(writes[0].groups[0].reconciliation.tokenId, 8); assert.equal(writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.equal(auth.authorizationWrites.length, action === "reuse" ? 0 : 1);
  });
}

test("returning from a new pure Key to a saved account clears the hidden dedicated billing authorization", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check(); await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click();
  await drawer.getByLabel(CREDENTIAL_FIELDS.type.label, { exact: true }).click(); await page.getByText(upstreamType("newapi-key"), { exact: true }).last().click();
  await drawer.getByRole("combobox", { name: KEY_ACCOUNT, exact: true }).click(); await page.getByText(NEW_AUTHORIZATION, { exact: true }).last().click();
  await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-abandoned-dedicated-authorization"); await drawer.getByRole("button", { name: USE_SAVED, exact: true }).click();
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0); assert.equal(await drawer.locator("form#channel-onboarding-authorization").count(), 0);
  await chooseKey(page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(probes.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("reconciliationAuthorization" in probes[0].selections[0], false); assert.equal("reconciliationAuthorization" in writes[0].selections[0], false); assert.doesNotMatch(JSON.stringify(writes), /fixture-abandoned-dedicated-authorization/);
});

test("a new pure Key upstream asks for balance monitoring before any test read", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).uncheck(); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click();
  await drawer.getByLabel(CREDENTIAL_FIELDS.type.label, { exact: true }).click(); await page.getByText(upstreamType("newapi-key"), { exact: true }).last().click();
  await drawer.getByRole("button", { name: TEST_READ, exact: true }).click();
  // 页面上直接说要选「看余额」，不发测试读取、也不说页面过期
  await drawer.getByText(ONBOARDING_KEY_ONLY_MONITOR, { exact: true }).waitFor();
  assert.equal(probes.length, 0); assert.equal(writes.length, 0); assert.equal(await drawer.getByText(ERROR_CATEGORIES.expired.text).count(), 0);
});

test("billing-only purpose survives opening a new account and returning to saved reuse", async (t) => {
  const { page, writes } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).uncheck(); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click(); assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), false);
  await drawer.getByRole("button", { name: USE_SAVED, exact: true }).click(); assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), false);
  await enableBilling(page, drawer); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("newStation" in writes[0].selections[0], false); assert.deepEqual(writes[0].selections[0].additionalMonitorStationIds, []);
});

test("billing-only purpose survives selecting a different saved account", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ ...config.upstreams[0], id: "account-B", name: "Account B", baseUrl: "https://b.example", identity: { provider: "newapi", accountId: "84" } });
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).uncheck(); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await drawer.getByRole("combobox", { name: "上游", exact: true }).fill("Account B"); await page.getByText("Account B · 账号 84", { exact: true }).last().click();
  assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), false); await enableBilling(page, drawer, "New Key"); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].stationId, "account-B"); assert.equal(writes[0].groups[0].reconciliation.tokenId, 8); assert.equal("reconciliationAuthorization" in writes[0].selections[0], false); assert.deepEqual(writes[0].selections[0].additionalMonitorStationIds, []);
});

test("partial additional Key monitoring preserves the primary account billing authorization when retried", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ id: "extra-key", name: "Additional pure Key", type: "newapi-key", baseUrl: "https://up.example", monitorEnabled: true });
  const { page, probes, writes } = await openOnboardingPage(t, { config, connect(body, count, probe) {
    const result = batchResult(body, probe, count > 1), group = result.groups[0];
    group.saved.stationIds = ["extra-key"]; group.saved.authorizationStationId = "upstream-1"; group.monitor = { status: "linked", stationIds: ["extra-key"] };
    if (count === 1) { group.reconciliation = { status: "pending", reason: "附加监控已保存，账号账单待重试" }; group.remainingActions = ["retry_rule"]; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).uncheck(); await drawer.getByText("同时看其他上游的余额（可选）", { exact: true }).click(); await drawer.getByRole("combobox", { name: "其他上游", exact: true }).click(); await page.getByText("Additional pure Key", { exact: true }).last().click();
  await enableBilling(page, drawer); await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await problemShown(drawer, "附加监控已保存，账号账单待重试");
  await drawer.getByText("Fixture upstream · 账号 42", { exact: true }).waitFor(); assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0);
  await verifyOnboarding(drawer); await drawer.getByRole("button", { name: FINISH, exact: true }).click(); await drawer.waitFor({ state: "hidden" });
  assert.equal(writes.length, 2); assert.ok(probes.every((body) => body.selections[0].stationId === "upstream-1")); assert.ok(writes.every((body) => body.selections[0].monitor === false && body.selections[0].stationId === "upstream-1")); assert.deepEqual(writes[1].selections[0].additionalMonitorStationIds, ["extra-key"]); assert.equal(writes[1].groups[0].reconciliation.tokenId, 7); assert.equal("reconciliationAuthorization" in writes[1].selections[0], false);
});

test("saved upstream reuse prioritizes matching accounts from the end of a long list without choosing an ambiguous account", async (t) => {
  const config = onboardingFixture();
  config.upstreams[0].name = "碎";
  config.upstreams.push({ ...config.upstreams[0], id: "upstream-2", name: "同站点账号 B", identity: { provider: "newapi", accountId: "84" } });
  config.channels[0].candidates = ["upstream-1", "upstream-2"];
  config.upstreams.unshift(...Array.from({ length: 20 }, (_, id) => ({ id: "other-" + id, name: "Other " + id, type: "newapi", baseUrl: `https://other-${id}.example`, monitorEnabled: true })));
  const { page, probes, writes } = await openOnboardingPage(t, { config });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByText(USE_SAVED, { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0);
  assert.equal(await drawer.getByRole("button", { name: TEST_READ, exact: true }).isDisabled(), true);
  const select = drawer.getByRole("combobox", { name: "上游", exact: true });
  await select.click();
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await dropdown.getByText("地址对得上的上游（2）", { exact: true }).waitFor();
  const choices = await dropdown.locator(".ant-select-item-option-content").allTextContents();
  assert.match(choices[0], /^碎 · .*账号 42/); assert.match(choices[1], /^同站点账号 B · .*账号 84/);
  await select.fill("碎"); await dropdown.locator(".ant-select-item-option-content", { hasText: "碎 ·" }).click();
  await enableBilling(page, drawer); await saveOnboarding(drawer);
  assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1");
  assert.equal(writes[0].selections[0].monitor, true); assert.equal(writes[0].groups[0].reconciliation.tokenId, 7);
  assert.equal("newStation" in writes[0].selections[0], false); assert.equal(writes[0].selections[0].updateCredentials, false);
  assert.ok(probes.every((body) => !("newStation" in body.selections[0])));
});

test("saved upstream reuse stays the default without a matching address and searches all other resources", async (t) => {
  const config = onboardingFixture(); config.channels[0].baseUrl = "https://unknown.example"; config.channels[0].candidates = [];
  const { page, writes } = await openOnboardingPage(t, { config });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByText(USE_SAVED, { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0);
  const select = drawer.getByRole("combobox", { name: "上游", exact: true });
  await select.fill("up.example");
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await dropdown.getByText("其他上游（1）", { exact: true }).waitFor();
  await dropdown.locator(".ant-select-item-option-content", { hasText: "Fixture upstream" }).click();
  await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("newStation" in writes[0].selections[0], false);
});

test("duplicate account creation directs reuse or shared authorization update without rotating credentials in the batch", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { probe(body, count, config) { return probeResult(body, config, { requireUpdate: !!body.selections[0].newStation }); } });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("button", { name: NEW_UPSTREAM, exact: true }).click();
  await drawer.getByText(CREATE_HINT, { exact: true }).waitFor();
  await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-replacement");
  await verifyOnboarding(drawer);
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true);
  // 同一个上游账号已经存过：只能用已保存的，或者另开「更新登录信息」确认，不在这里顺手换掉
  await drawer.getByText("这个上游账号已经保存过", { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("button", { name: UPDATE_AUTH, exact: true }).count(), 1);
  assert.equal(await drawer.getByRole("checkbox", { name: /更新/ }).count(), 0);
  assert.equal(writes.length, 0);
  await drawer.getByRole("button", { name: "用已保存的", exact: true }).click();
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true);
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0);
  await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].updateCredentials, false); assert.equal("newStation" in writes[0].selections[0], false);
});

test("empty resource directory explains first authorization and keeps it explicit", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByText(NEW_UPSTREAM, { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("button", { name: USE_SAVED, exact: true }).count(), 0);
  await drawer.getByText(CREATE_HINT, { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 1);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 0);
});

test("onboarding without randomUUID keeps valid request IDs within an operation and renews them when reopened", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(true) });
  await page.evaluate(() => Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined }));
  const drawer = await openOnboardingDrawer(page);
  await verifyOnboarding(drawer);
  const first = normalizeBatchInput(probes[0]).requestId;
  const repeated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/channel-onboarding/batch/probe");
  await verifyOnboarding(drawer); await repeated;
  assert.equal(normalizeBatchInput(probes[1]).requestId, first);
  await drawer.locator("button.ant-btn-loading").waitFor({ state: "hidden" });
  await drawer.locator(".ant-drawer-close").click(); await drawer.waitFor({ state: "hidden" });
  const reopened = await openOnboardingDrawer(page); await verifyOnboarding(reopened);
  assert.notEqual(normalizeBatchInput(probes[2]).requestId, first);
  assert.equal(writes.length, 0);
});

test("onboarding without browser cryptography does not partially open a drawer or send a request", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t);
  await page.evaluate(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
    Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, value: undefined });
  });
  await page.getByRole("button", { name: connectButton("New channel"), exact: true }).click();
  await page.getByText(failureText("打开失败", { code: "BROWSER_UNSUPPORTED" }), { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: CONNECT, exact: true }).count(), 0);
  assert.equal(probes.length, 0); assert.equal(writes.length, 0);
});

test("discovery refresh preserves the panel state for Enter, Space and click", { timeout: 45000 }, async (t) => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  settleButtonLookups(page);
  page.setDefaultTimeout(5_000);
  const catalogue = onboardingFixture();
  const requests = [];
  let syncs = 0;
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(baseURL).origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/channel-onboarding" || url.pathname === "/api/channel-onboarding/sync") {
      if (url.pathname.endsWith("/sync")) syncs++;
      return fulfill(route, catalogue);
    }
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (url.pathname === "/api/reconciliation") return fulfill(route, response([rule("rule-1", "Rule A", 10)]));
    if (url.pathname === "/api/channel-onboarding/accounts") return fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00Z" });
    if (shellFallback[url.pathname]) return fulfill(route, shellFallback[url.pathname]);
    throw new Error("unexpected fixture API: " + url.pathname);
  });
  // 渠道绑定只在「上游资源 › 渠道绑定」标签里
  await page.goto(`${baseURL}/stations?view=onboarding`, { timeout: 30000 });
  // 「渠道绑定 · N」标题右边的「刷新」重新读自营站点的渠道
  const discovery = page.locator(".ant-collapse-header").getByRole("button", { name: REFRESH, exact: true });
  const header = page.locator(".ant-collapse-item").filter({ has: discovery }).locator(".ant-collapse-header");
  const settled = () => page.locator(`.ant-collapse-header button[aria-label="${REFRESH}"].ant-btn-loading`).waitFor({ state: "detached" });
  await discovery.waitFor();
  await page.getByRole("button", { name: connectButton("New channel"), exact: true }).click({ trial: true });
  await settled();
  assert.equal(await header.getAttribute("aria-expanded"), "true");
  for (const expanded of ["true", "false"]) {
    for (const action of ["Enter", "Space", "click"]) {
      const before = syncs;
      const refreshed = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/channel-onboarding/sync");
      await discovery.focus();
      if (action === "click") await discovery.click();
      else await page.keyboard.press(action);
      await refreshed;
      await settled();
      assert.equal(syncs, before + 1, `${expanded} panel: ${action} refreshes once`);
      assert.equal(await header.getAttribute("aria-expanded"), expanded, `${expanded} panel: ${action} preserves expansion`);
      assert.equal(await discovery.evaluate((button) => button === document.activeElement), true, `${action} preserves button focus`);
    }
    const before = syncs;
    await header.focus();
    await page.keyboard.press("Enter");
    assert.equal(await header.getAttribute("aria-expanded"), expanded === "true" ? "false" : "true");
    assert.equal(syncs, before, "the parent title does not refresh discovery");
  }
  assert.ok(requests.every((entry) => entry.method === "GET" || entry.path === "/api/channel-onboarding/sync"));
  console.log(JSON.stringify({ discoveryActions: 6, parentTitleActions: 2, mockedApiRequests: requests.length, syncs, productMutations: 0 }));
});

test("five existing-account channels choose one Key and confirm one genuine batch without credentials", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5, 6, 7, 8]) });
  const drawer = await openOnboardingDrawer(page, true); assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0);
  // 预览里写绑定后这把 Key 的渠道：已绑定的 #1–#3 加上这次的五个
  await enableBilling(page, drawer); await drawer.locator(".ant-alert-description").getByText("绑定后这把 Key 的渠道：渠道 #1、渠道 #2、渠道 #3、New channel、New channel 5、New channel 6、New channel 7、New channel 8", { exact: true }).waitFor();
  await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].selections.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].groups.length, 1); assert.deepEqual(writes[0].groups[0].channels.map((entry) => entry.channelId), [4, 5, 6, 7, 8]); assert.equal(writes[0].groups[0].reconciliation.tokenId, 7); assert.equal(writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.ok(writes[0].previewId); assert.equal(probes.length, 1); assert.equal(probes[0].groups[0].reconciliation.tokenId, 7); assert.equal("newStation" in writes[0].selections[0], false);
});

test("different saved resource IDs for the same verified account reuse one existing authorization", async (t) => {
  const config = onboardingFixture(true, "newapi", [4, 5]);
  config.upstreams.push({ ...config.upstreams[0], id: "upstream-2", name: "Same account, another saved PAT" });
  config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1"] };
  config.channels[1].monitor = { status: "linked", stationIds: ["upstream-2"] };
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page, true);
  assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0);
  await enableBilling(page, drawer); await saveOnboarding(drawer);
  assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].selections[0].monitor, false); assert.equal("newStation" in writes[0].selections[0], false); assert.equal(writes[0].groups.length, 1); assert.deepEqual(writes[0].groups[0].channels.map((entry) => entry.channelId), [4, 5]); assert.deepEqual(config.channels.map((channel) => channel.monitor.stationIds), [["upstream-1"], ["upstream-2"]]);
});

test("different Keys remain explicit groups and partial saves recover after reload using public intent", async (t) => {
  const { page, probes, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5]), connect(body, count, probe) {
    const result = batchResult(body, probe);
    if (count === 1) { result.complete = false; const second = result.groups[1]; second.complete = false; second.saved.ruleId = null; second.reconciliation = { status: "pending", reason: "第二把 Key 账单配置保存失败" }; second.channels.forEach((entry) => { entry.complete = false; entry.ruleId = null; entry.remainingActions = ["retry_rule"]; }); second.remainingActions = ["repreview"]; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page, true); await drawer.getByText(BILLING_CHECKBOX, { exact: true }).click(); await chooseKey(page, drawer); await drawer.getByText("这些渠道用的 Key 不一样，分别选", { exact: true }).click();
  await drawer.getByRole("combobox", { name: "「New channel 5」的 Key", exact: true }).click(); await page.getByText(keyOption("New Key"), { exact: true }).last().click();
  await answerCoverage(page, drawer, { key: "Supplier Key" }); await answerCoverage(page, drawer, { key: "New Key" }); await verifyOnboarding(drawer);
  await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await drawer.getByText("还有几步没做完，做完的会保留", { exact: true }).waitFor(); await problemShown(drawer, "第二把 Key 账单配置保存失败"); assert.equal(writes.length, 1); assert.deepEqual(writes[0].groups.map((group) => group.reconciliation.tokenId), [7, 8]);
  await page.reload(); await page.getByRole("button", { name: RESUME }).click(); await problemShown(drawer, "第二把 Key 账单配置保存失败");
  assert.equal(recoveries[0].requestId, writes[0].requestId); assert.deepEqual(recoveries[0].groups.map((group) => group.channels.map((entry) => entry.channelId)), [[4], [5]]); assert.equal("accessToken" in recoveries[0].selections[0], false); assert.equal("saved" in recoveries[0], false); assert.equal(recoveries[0].groups.length, 2);
  await verifyOnboarding(drawer); await drawer.getByRole("button", { name: FINISH, exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 2); assert.equal(writes[1].selections[0].stationId, "upstream-1"); assert.deepEqual(writes[1].groups.map((group) => group.channels.map((entry) => entry.channelId)), [[4], [5]]);
});

test("new New API credentials are entered once and keyboard cancellation after a probe creates nothing", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-new-pat"); await enableBilling(page, drawer);
  await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click({ trial: true }); assert.equal(writes.length, 0); assert.equal(probes.at(-1).selections[0].newStation.accessToken, "fixture-new-pat");
  // 下拉框展开时 Esc 只收起下拉框；紧接着（收起动画还没结束）再按 Esc 要能关掉抽屉（#413）
  const scope = drawer.getByRole("combobox", { name: COVERAGE_QUESTION, exact: true }); await scope.click(); await page.waitForFunction((label) => document.querySelector(`[aria-label="${label}"][aria-expanded="true"]`), COVERAGE_QUESTION);
  await page.keyboard.press("Escape"); await page.waitForFunction((label) => document.querySelector(`[aria-label="${label}"][aria-expanded="false"]`), COVERAGE_QUESTION); assert.equal(await drawer.isVisible(), true);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 0);
  // 刚打开、焦点还没进抽屉时 Esc 也能关
  await openOnboardingDrawer(page); await drawer.waitFor(); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 0);
});

test("monitor-only onboarding needs no Key and submits one batch", async (t) => {
  const { page, writes } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer);
  assert.equal(await drawer.getByText(BILLING_PREVIEW).count(), 0);
  await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].monitor, true); assert.equal(writes[0].groups[0].reconciliation, null);
});

test("monitor-only preview preserves an actual channel verification failure", async (t) => {
  const { page } = await openOnboardingPage(t, { probe(body, count, config) {
    const probe = probeResult(body, config);
    Object.assign(probe.groups[0], { status: "unavailable", code: "CHANNEL_CHANGED", reason: "渠道版本已变化，请重新发现" });
    return probe;
  } });
  const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer);
  await drawer.locator(".ant-alert-warning").getByText("还没做完", { exact: true }).waitFor();
  await problemShown(drawer, "渠道版本已变化，请重新发现", "CHANNEL_CHANGED");
  assert.equal(await drawer.getByText(BILLING_PREVIEW).count(), 0);
});

test("onboarding requires a purpose and recovers by selecting balance monitoring", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t);
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: ONBOARDING_PURPOSES.monitor, exact: true }).uncheck();
  await drawer.getByText(ONBOARDING_PURPOSE_REQUIRED, { exact: true }).waitFor(); await drawer.getByText(ONBOARDING_PURPOSE_HINT, { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("button", { name: TEST_READ, exact: true }).count(), 0);
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true);
  assert.equal(probes.length, 0); assert.equal(writes.length, 0);
  await drawer.getByRole("checkbox", { name: ONBOARDING_PURPOSES.monitor, exact: true }).check();
  await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].monitor, true);
});

test("pending Key billing can be deselected to save only balance monitoring", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { probe(body, count, config) {
    const probe = probeResult(body, config);
    if (body.groups[0].reconciliation) Object.assign(probe.groups[0], { status: "unavailable", code: "KEY_REQUIRED", reason: "请选择实际使用的上游 Key" });
    return probe;
  } });
  const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await verifyOnboarding(drawer);
  await drawer.getByText("还没绑定 Key", { exact: true }).waitFor(); await problemShown(drawer, "请选择实际使用的上游 Key", "KEY_REQUIRED");
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true);
  await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).uncheck();
  await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes.length, 1); assert.equal(writes[0].groups[0].reconciliation, null);
});

test("Sub2API password mode clears hidden credentials and preserves unsupported billing as partial", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false), billingStatus: "unsupported", connect(body, count, probe) { const result = batchResult(body, probe, false); result.groups[0].reconciliation = { status: "unsupported", reason: "当前部署账单能力不支持" }; return result; } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("hidden-old-pat"); await drawer.getByLabel("类型", { exact: true }).click(); await page.getByText("Sub2API 账号（邮箱密码）", { exact: true }).last().click(); await drawer.getByLabel("登录邮箱", { exact: true }).fill("fixture@example.test"); await drawer.getByLabel("登录密码", { exact: true }).fill("fixture-password");
  await drawer.getByText(BILLING_CHECKBOX, { exact: true }).click(); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click();
  // 余额已保存，账单读不到的那一半留着没做完
  await drawer.getByText(`${ONBOARDING_PURPOSES.monitor}：已保存；${ONBOARDING_PURPOSES.billing}：${reconciliationChannelStatus("unsupported").label}`, { exact: true }).waitFor(); await problemShown(drawer, "当前部署账单能力不支持");
  assert.equal(writes[0].selections[0].newStation.type, "sub2api-password"); assert.equal("accessToken" in writes[0].selections[0].newStation, false); assert.equal(writes[0].selections[0].newStation.password, "fixture-password");
});

test("pure Key monitor supplements one dedicated billing authorization", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi-key") }); const drawer = await openOnboardingDrawer(page); await drawer.getByText(BILLING_CHECKBOX, { exact: true }).click(); await drawer.getByRole("combobox", { name: "这把 Key 属于哪个上游账号", exact: true }).click(); await page.getByText("填一个新的访问令牌", { exact: true }).last().click(); await drawer.getByText("访问令牌只填一次", { exact: true }).waitFor(); await tokenField(drawer).fill("fixture-billing-pat"); await verifyOnboarding(drawer); await chooseKey(page, drawer); await answerCoverage(page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].selections[0].reconciliationAuthorization.newAuthorization.accessToken, "fixture-billing-pat");
});

test("pure Key recovery after reload reuses the saved dedicated billing authorization", async (t) => {
  const config = onboardingFixture(true, "newapi-key");
  const { page, probes, writes, recoveries } = await openOnboardingPage(t, { config, connect(body, count, probe) {
    const result = batchResult(body, probe, count > 1); result.groups[0].saved.authorizationStationId = "billing-auth";
    if (count === 1) { config.upstreams.push({ id: "billing-auth", name: "Saved billing account", type: "newapi", monitorEnabled: false, baseUrl: "https://up.example", identity: { provider: "newapi", accountId: "42" } }); result.groups[0].reason = "授权已保存，规则待完成"; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByText(BILLING_CHECKBOX, { exact: true }).click(); await drawer.getByRole("combobox", { name: "这把 Key 属于哪个上游账号", exact: true }).click(); await page.getByText("填一个新的访问令牌", { exact: true }).last().click(); await tokenField(drawer).fill("fixture-billing-pat"); await verifyOnboarding(drawer); await chooseKey(page, drawer); await answerCoverage(page, drawer); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await problemShown(drawer, "授权已保存，规则待完成");
  await page.reload(); await page.getByRole("button", { name: RESUME }).click(); await problemShown(drawer, "授权已保存，规则待完成"); assert.equal(await tokenField(drawer).count(), 0);
  await verifyOnboarding(drawer); assert.equal(probes.at(-1).selections[0].reconciliationAuthorization.stationId, "billing-auth"); assert.equal(recoveries[0].selections[0].accountIdentity, null); await drawer.getByRole("button", { name: FINISH, exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 2); assert.equal("newAuthorization" in writes[1].selections[0].reconciliationAuthorization, false);
});

test("additional account and Key monitors retain their explicit overlap warning", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ id: "key-monitor", name: "Extra Key monitor", type: "newapi-key", monitorEnabled: true, baseUrl: "https://up.example" });
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时看其他上游的余额（可选）", { exact: true }).click(); await drawer.getByRole("combobox", { name: "其他上游", exact: true }).click(); await page.getByText("Extra Key monitor", { exact: true }).last().click(); await drawer.getByText(`同一个上游账号的余额和 Key 额度可能是同一笔花费，绑定只算一次上游成本；${NAV_LABELS.analytics}里要不要算两次，请到上游设置看「算进利润」开关。`, { exact: true }).waitFor(); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.deepEqual(writes[0].selections[0].additionalMonitorStationIds, ["key-monitor"]);
});

test("connection edits invalidate proof while a display-name edit preserves it", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-pat"); await verifyOnboarding(drawer); await drawer.getByLabel("上游名称", { exact: true }).fill("Renamed"); assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isEnabled(), true); await drawer.getByLabel("站点地址", { exact: true }).fill("https://another.example"); assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true); assert.equal(writes.length, 0);
});

test("same-account credentials never bypass the separate authorization update confirmation", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(false), requireUpdate: true });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-replacement"); await verifyOnboarding(drawer);
  assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true); await drawer.getByRole("button", { name: UPDATE_AUTH, exact: true }).waitFor();
  assert.equal(writes.length, 0); assert.equal(recoveries.length, 0); assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).inputValue(), "fixture-replacement");
});

test("manual discovery keeps a stale catalogue visible and disables new binding", async (t) => {
  const { page } = await openOnboardingPage(t, { discovery(route, reads, config) { return fulfill(route, reads.filter((entry) => entry.path.endsWith("/sync")).length > 1 ? { ...config, stale: true, error: "fixture catalogue unavailable" } : config); } });
  // 刷新失败时还列着上次读到的渠道，写「刷新失败，数据截至…」，要刷新成功才能绑定
  await page.locator(".ant-collapse-header").getByRole("button", { name: REFRESH, exact: true }).click(); const stale = page.locator(".ant-alert-warning").filter({ has: page.getByText(refreshFailedText("2026-10-09T06:00:00.000Z"), { exact: true }) }); await stale.waitFor();
  await stale.getByText("刷新后才能绑定", { exact: true }).waitFor(); await page.getByText("New channel", { exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: connectButton("New channel"), exact: true }).isDisabled(), true);
});

test("channel search and status filters do not silently select another account", async (t) => {
  const config = onboardingFixture(true, "newapi", [4, 5]); config.channels[1].baseUrl = "https://other.example"; config.channels[1].candidates = ["other-account"]; config.upstreams.push({ id: "other-account", name: "Other account", type: "newapi", baseUrl: "https://other.example", monitorEnabled: true });
  const { page } = await openOnboardingPage(t, { config }); await page.getByRole("textbox", { name: "搜索渠道", exact: true }).fill("local-sales"); const drawer = await openOnboardingDrawer(page, true); assert.equal(await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).count(), 0); await drawer.getByText(USE_SAVED, { exact: true }).waitFor(); assert.equal(await drawer.getByRole("button", { name: TEST_READ, exact: true }).isDisabled(), true); assert.equal(await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).isDisabled(), true);
});

test("five-channel batches fit 320/390/768/1440 widths without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5, 6, 7, 8]), viewport: { width, height: 900 } });
    const drawer = await openOnboardingDrawer(page, true); await enableBilling(page, drawer); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await saveOnboarding(drawer); assert.equal(writes.length, 1); await page.close();
  }
});

// 改绑定抽屉（app/(dashboard)/stations/association-editor.tsx 的 COPY 表，tsx 测试里引用不到，照抄原句）
const BINDING_TARGET = "Key 9 · Own station", EDIT_DRAWER = new RegExp(`^${EDIT_BINDING} · `), EDIT_AFTER = "改后的渠道", EDIT_REMOVED = "去掉的渠道", EDIT_PREVIEW_TITLE = "预览，还没保存";
const COVERAGE_UNKNOWN = reconciliationIssue("COST_COVERAGE_UNKNOWN"), CHANNEL_TWICE = reconciliationIssue("DUPLICATE_CHANNEL_ASSIGNMENT"), KEY_TWICE = reconciliationIssue("CANONICAL_KEY_CONFLICT");
const editBindingButton = (scope, target = BINDING_TARGET) => scope.getByRole("button", { name: `${EDIT_BINDING} ${target}`, exact: true });
// 上游账单里一把 Key 的折叠行：Key 名后跟状态标签（app/(dashboard)/stations/account-center.tsx 的 COPY.activeCount / needsAction / unbound / notBound）
const keyRow = (scope, name) => scope.getByRole("button", { name: new RegExp(`(?:^|\\s)${name} (?:\\d+ 条在用|需处理|已解除绑定|没绑定)`) });
const ariaExpanded = (label, expanded) => [({ label, expanded }) => [...document.querySelectorAll("[aria-label]")].some((node) => node.getAttribute("aria-label") === label && node.getAttribute("aria-expanded") === expanded), { label, expanded }];

test("上游账单 edits one 核算关联 by a fresh exact preview and one PUT, and Esc closes the editor on open and right after a dropdown", async (t) => {
  const declaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
  const rules = [{ id: "A-active", tokenName: "Key 9", tokenId: 9, upstreamStationId: "A-billing", ownStationId: "own", enabled: true, archivedAt: null, timezone: "Asia/Shanghai", costCoverage: "unknown", coverageDeclaration: declaration, channels: [1, 3].map((channelId) => ({ channelId, name: "Channel " + channelId })) },
    { id: "B-active", tokenName: "B Key", tokenId: 9, upstreamStationId: "B-monitor", ownStationId: "own", enabled: true, archivedAt: null, timezone: "Asia/Shanghai", costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] }, channels: [{ channelId: 2, name: "Channel 2" }] }];
  const ruleConfiguration = { ownStation: { id: "own", cnyPerUsd: null }, upstreams: [{ id: "A-billing", name: "A billing" }], channels: [1, 2, 3, 4].map((id) => ({ id, name: "Channel " + id, status: 1 })), rules };
  let previewCount = 0;
  const { page, center, model, mutations, accountRequests } = await openAccountsPage(t, { ruleConfiguration, mutation(route, mutation) {
    if (mutation.path === "/api/reconciliation/rules/A-active/preview" && mutation.method === "POST") return fulfill(route, { previewId: "exact-rule-preview-" + ++previewCount, groupId: "rule-edit", expiresAtMs: Date.now() + 600000,
      basis: { existingChannelIds: [1, 3], proposedChannelIds: mutation.body.salesChannelIds, timezone: "Asia/Shanghai" }, preview: { scopeChanged: true, costCoverage: "unknown", billingEffectiveFromMs: null } });
    if (mutation.path === "/api/reconciliation/rules/A-active" && mutation.method === "PUT") return fulfill(route, { rule: { ...rules[0], channels: mutation.body.salesChannelIds.map((channelId) => ({ channelId })) } });
    throw new Error("unexpected rule fixture API: " + mutation.method + " " + mutation.path);
  } });
  const account = await expandAccount(center, model.accounts[0]); await keyRow(account, "Key 9").click();
  const edit = editBindingButton(account.locator('[data-rule-id="A-active"]')), drawer = page.getByRole("dialog", { name: EDIT_DRAWER });
  // 解除过的绑定只读：有「已解除绑定」标签，没有任何按钮
  await edit.waitFor(); const history = account.locator('[data-rule-id="A-history"]'); await history.getByText("已解除绑定", { exact: true }).waitFor(); assert.equal(await history.getByRole("button").count(), 0);
  // 刚打开、焦点还没进抽屉时 Esc 也能关
  await edit.click(); await drawer.waitFor(); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
  // 下拉框展开时 Esc 只收起下拉框；紧接着（收起动画还没结束）再按 Esc 要能关掉抽屉（#413）
  await edit.click(); const uses = drawer.getByRole("combobox", { name: COVERAGE_QUESTION, exact: true }); await uses.click(); await page.waitForFunction(...ariaExpanded(COVERAGE_QUESTION, "true"));
  await page.keyboard.press("Escape"); await page.waitForFunction(...ariaExpanded(COVERAGE_QUESTION, "false")); assert.equal(await drawer.isVisible(), true);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(mutations.length, 0);
  // 上游和 Key 只读显示；时区等于业务时区（Asia/Shanghai）时不写
  await edit.click(); await waitForFact(drawer, "上游", "A billing"); await waitForFact(drawer, "Key", "Key 9");
  assert.equal(await drawer.locator("dt").filter({ hasText: exactText("时区") }).count(), 0); assert.equal(await drawer.getByText("Asia/Shanghai").count(), 0);
  await drawer.locator('.ant-select-selection-item[title="Channel 1"] .ant-select-selection-item-remove').click();
  await drawer.getByLabel("渠道", { exact: true }).click(); assert.equal(await page.locator(".ant-select-item-option-disabled", { hasText: "Channel 2（已绑了别的 Key：B Key）" }).count(), 1);
  await page.getByText("Channel 4", { exact: true }).last().click(); await drawer.getByLabel("渠道", { exact: true }).press("Escape"); assert.equal(await drawer.isVisible(), true);
  const previewButton = drawer.getByRole("button", { name: BINDING_COPY.preview, exact: true }), confirm = drawer.getByRole("button", { name: EDIT_BINDING, exact: true });
  await previewButton.click(); const previewAlert = drawer.locator(".ant-alert").filter({ hasText: EDIT_PREVIEW_TITLE }); await previewAlert.getByText(`${EDIT_AFTER}：Channel 3、Channel 4`, { exact: true }).waitFor(); await previewAlert.getByText(`${EDIT_REMOVED}：Channel 1；${HISTORY_KEPT}。`, { exact: true }).waitFor();
  // 回答「不确定」时预览说明利润先不算
  await previewAlert.getByText(COVERAGE_UNKNOWN.title + COVERAGE_UNKNOWN.detail, { exact: true }).waitFor(); assert.equal(mutations.filter((entry) => entry.method === "PUT").length, 0);
  // 预览后再改渠道：旧预览作废，确认前必须按当前选择重新预览
  await drawer.locator('.ant-select-selection-item[title="Channel 4"] .ant-select-selection-item-remove').click(); await confirm.waitFor({ state: "detached" });
  await drawer.getByLabel("渠道", { exact: true }).click(); await page.getByText("Channel 4", { exact: true }).last().click(); await drawer.getByLabel("渠道", { exact: true }).press("Escape");
  await previewButton.click(); await drawer.getByText(`${EDIT_AFTER}：Channel 3、Channel 4`, { exact: true }).waitFor(); await confirm.waitFor();
  const reads = accountRequests.length; await confirm.click(); await drawer.waitFor({ state: "hidden" }); await page.locator(".ant-message").getByText(workflowActionMeta("edit_binding").done, { exact: true }).waitFor();
  assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [["POST", "/api/reconciliation/rules/A-active/preview"], ["POST", "/api/reconciliation/rules/A-active/preview"], ["PUT", "/api/reconciliation/rules/A-active"]]);
  const put = mutations[2].body; assert.deepEqual(put.salesChannelIds, [3, 4]); assert.equal(put.tokenId, 9); assert.equal(put.upstreamStationId, "A-billing"); assert.equal(put.timezone, "Asia/Shanghai");
  assert.equal(put.groupId, "rule-edit"); assert.equal(put.previewId, "exact-rule-preview-2"); assert.deepEqual(put.coverageDeclaration, declaration);
  // 保存后重读一次上游账单，不多读
  for (let wait = 0; accountRequests.length <= reads && wait < 50; wait++) await page.waitForTimeout(100); await page.waitForTimeout(500); assert.equal(accountRequests.length, reads + 1);
});

test("4a 上游账单：固定采购上游的核算关联用途待确认时注明不影响毛利，编辑预览同样说明", async (t) => {
  const declaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
  const rules = [{ id: "A-active", tokenName: "Key 9", tokenId: 9, upstreamStationId: "A-billing", ownStationId: "own", enabled: true, archivedAt: null, timezone: "Asia/Shanghai", costCoverage: "unknown", coverageDeclaration: declaration, channels: [1, 3].map((channelId) => ({ channelId, name: "Channel " + channelId })) }];
  const ruleConfiguration = { ownStation: { id: "own", cnyPerUsd: null }, upstreams: [{ id: "A-billing", name: "A billing" }], channels: [1, 2, 3].map((id) => ({ id, name: "Channel " + id, status: 1 })), rules };
  const model = accountReadFixture(); model.accounts[0].resources.find((resource) => resource.id === "A-billing").fixedPurchases = [{ amount: 300, days: 30 }];
  const { page, center } = await openAccountsPage(t, { model, ruleConfiguration, mutation(route, mutation) {
    if (mutation.path === "/api/reconciliation/rules/A-active/preview" && mutation.method === "POST") return fulfill(route, { previewId: "fixed-preview", groupId: "rule-edit", expiresAtMs: Date.now() + 600000,
      basis: { existingChannelIds: [1, 3], proposedChannelIds: mutation.body.salesChannelIds, timezone: "Asia/Shanghai" }, preview: { scopeChanged: false, costCoverage: "unknown", billingEffectiveFromMs: null } });
    throw new Error("unexpected rule fixture API: " + mutation.method + " " + mutation.path);
  } });
  const account = await expandAccount(center, model.accounts[0]); await keyRow(account, "Key 9").click(); const active = account.locator('[data-rule-id="A-active"]');
  // 固定成本的上游：写明上游成本计入固定成本；Key 用途照常显示，但不再说「利润先不算」
  await waitForFact(active, "上游成本", FIXED_COST_TEXT); await waitForFact(active, COVERAGE_QUESTION, `${COVERAGE_ANSWERS.find((entry) => entry.value === "own_channels").label}：Channel 2`);
  await editBindingButton(active).click(); const drawer = page.getByRole("dialog", { name: EDIT_DRAWER });
  await waitForFact(drawer, "上游", "A billing"); await drawer.getByRole("button", { name: BINDING_COPY.preview, exact: true }).click();
  const previewAlert = drawer.locator(".ant-alert").filter({ hasText: EDIT_PREVIEW_TITLE }); await previewAlert.getByText(`${EDIT_AFTER}：Channel 1、Channel 3`, { exact: true }).waitFor();
  // 预览里不提「这把 Key 还给别处用吗？…利润先不算」：上游成本是固定的，Key 的其他用途不影响利润
  assert.equal(await previewAlert.getByText(COVERAGE_UNKNOWN.title + COVERAGE_UNKNOWN.detail, { exact: true }).count(), 0); assert.equal(await previewAlert.getByText(COVERAGE_UNKNOWN.title).count(), 0);
});

test("上游账单 lets a 核算关联 remove a channel it already shares with another active 核算关联", async (t) => {
  const declaration = { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] };
  const rule = (id, tokenName, upstreamStationId, channelIds) => ({ id, tokenName, tokenId: 9, upstreamStationId, ownStationId: "own", enabled: true, archivedAt: null, timezone: "Asia/Shanghai", costCoverage: "complete", coverageDeclaration: declaration, channels: channelIds.map((channelId) => ({ channelId, name: "Channel " + channelId })) });
  const rules = [rule("A-active", "Key 9", "A-billing", [1, 3]), rule("C-dup", "C Key", "B-monitor", [3])];
  const ruleConfiguration = { ownStation: { id: "own", cnyPerUsd: null }, upstreams: [{ id: "A-billing", name: "A billing" }], channels: [1, 2, 3].map((id) => ({ id, name: "Channel " + id, status: 1 })), rules };
  const model = accountReadFixture(); Object.assign(model.accounts[0].keys[0].associations[0], { conflict: true, conflictRuleIds: ["C-dup"], keyConflictRuleIds: [], channelConflictRuleIds: ["C-dup"], duplicateChannelIds: [3] });
  const { page, center, mutations } = await openAccountsPage(t, { model, ruleConfiguration, mutation(route, mutation) {
    if (mutation.path === "/api/reconciliation/rules/A-active/preview" && mutation.method === "POST") return fulfill(route, { previewId: "dup-preview", groupId: "dup-edit", expiresAtMs: Date.now() + 600000,
      basis: { existingChannelIds: [1, 3], proposedChannelIds: mutation.body.salesChannelIds, timezone: "Asia/Shanghai" }, preview: { scopeChanged: true, costCoverage: "complete", billingEffectiveFromMs: null } });
    if (mutation.path === "/api/reconciliation/rules/A-active" && mutation.method === "PUT") return fulfill(route, { rule: { ...rules[0], channels: mutation.body.salesChannelIds.map((channelId) => ({ channelId })) } });
    throw new Error("unexpected rule fixture API: " + mutation.method + " " + mutation.path);
  } });
  const account = await expandAccount(center, model.accounts[0]); await keyRow(account, "Key 9").click(); const active = account.locator('[data-rule-id="A-active"]');
  // 只有渠道重复（Key 没重复）：只说渠道绑了两把 Key，并指出和哪条重复
  const banner = active.locator(".jy-banner"); await banner.locator("b").filter({ hasText: exactText(fillIssueCopy(CHANNEL_TWICE.title, CHANNEL_TWICE.plain, { channel: "Channel 3" })) }).waitFor();
  await banner.getByText(`：${CHANNEL_TWICE.detail}`, { exact: true }).waitFor(); assert.equal(await banner.getByText(KEY_TWICE.title, { exact: true }).count(), 0);
  await editBindingButton(active).click(); const drawer = page.getByRole("dialog", { name: EDIT_DRAWER });
  const duplicate = drawer.locator('.ant-select-selection-item[title="Channel 3（已绑了别的 Key：C Key，去掉一条）"]'); await duplicate.waitFor();
  await duplicate.locator(".ant-select-selection-item-remove").click(); await duplicate.waitFor({ state: "detached" });
  await drawer.getByLabel("渠道", { exact: true }).click(); assert.equal(await page.locator(".ant-select-item-option:not(.ant-select-item-option-disabled)", { hasText: "Channel 3（已绑了别的 Key：C Key，去掉一条）" }).count(), 1); await drawer.getByLabel("渠道", { exact: true }).press("Escape");
  await drawer.getByRole("button", { name: BINDING_COPY.preview, exact: true }).click(); await drawer.getByText(`${EDIT_AFTER}：Channel 1`, { exact: true }).waitFor(); await drawer.getByRole("button", { name: EDIT_BINDING, exact: true }).click(); await drawer.waitFor({ state: "hidden" });
  assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [["POST", "/api/reconciliation/rules/A-active/preview"], ["PUT", "/api/reconciliation/rules/A-active"]]); assert.deepEqual(mutations[1].body.salesChannelIds, [1]); assert.equal(mutations[1].body.previewId, "dup-preview");
});

test("账单核算 is read-only: no create or edit entry, fixes link back to 上游账单", async (t) => {
  // Rule A、Rule B 渠道重复（需处理），Rule C 正常：只有需处理的行才有去上游账单处理的链接
  const rows = dailyRows(); for (const row of rows.slice(0, 2)) row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT", ruleIds: ["rule-1", "rule-2"], detail: "销售渠道重复归属" }] };
  const { page } = await openDailyPage(t, { data: dailyResponse(rows) }), writeLike = new RegExp(`^(添加|编辑|停止|更换|操作|${[EDIT_BINDING, CONNECT, workflowActionMeta("swap_key").label, workflowActionMeta("unbind").label].join("|")})`);
  const FIX = workflowActionMeta("review_conflict").label, fixHref = (ruleId) => workflowAction("review_conflict", { ruleId }).href;
  await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("需处理", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: writeLike }).count(), 0); assert.equal(await page.getByText("编辑当前范围").count(), 0);
  assert.equal(await page.getByRole("dialog", { name: CONNECT }).count(), 0);
  assert.equal(await page.getByRole("link", { name: `去${STATION_TABS.bills}`, exact: true }).getAttribute("href"), "/stations?view=bills");
  const rowLinks = await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByRole("link", { name: `${FIX} Rule A`, exact: true }).evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  assert.deepEqual(rowLinks, [fixHref("rule-1")]); assert.equal(fixHref("rule-1"), "/stations?action=conflict&ruleId=rule-1");
  assert.equal(await page.locator("tr.ant-table-row", { hasText: "Rule C" }).locator('a[href^="/stations"]').count(), 0);
  await page.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click(); const detail = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true }), fix = detail.getByRole("link", { name: FIX, exact: true });
  assert.equal(await fix.getAttribute("href"), fixHref("rule-1")); assert.equal(await detail.getByRole("button", { name: writeLike }).count(), 0);
  // 核算页不再嵌渠道接入：不读接入目录，也没有任何接入写请求
  const calls = onboardingRequests.get(page); assert.equal(calls.filter((call) => call.pathname === "/api/channel-onboarding").length, 0); assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
});

test("a lost batch response recovers persisted results without returned browser IDs or another confirm", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { loseResponseAt: 1 });
  const drawer = await openOnboardingDrawer(page); await enableBilling(page, drawer); await drawer.getByRole("button", { name: CONFIRM_BINDING, exact: true }).click(); await drawer.getByText(workflowActionMeta("connect_channels").done, { exact: true }).waitFor();
  assert.equal(writes.length, 1); assert.equal(recoveries.length, 1); assert.equal(recoveries[0].requestId, writes[0].requestId); assert.equal(recoveries[0].selections[0].stationId, "upstream-1"); assert.equal("saved" in recoveries[0], false); assert.equal(await drawer.getByRole("button", { name: FINISH, exact: true }).isDisabled(), true);
});

test("a new billing-only account is confirmed without creating another monitor", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fixture-billing-only"); await drawer.getByText(ONBOARDING_PURPOSES.monitor, { exact: true }).click(); await enableBilling(page, drawer); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].newStation.accessToken, "fixture-billing-only");
});

test("switching a billing-only new account authorization type does not silently enable monitoring", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page);
  await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).uncheck(); await drawer.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).check();
  await drawer.getByLabel(CREDENTIAL_FIELDS.type.label, { exact: true }).click(); await page.getByText(upstreamType("sub2api-password"), { exact: true }).last().click(); await drawer.getByLabel(CREDENTIAL_FIELDS.email.label, { exact: true }).fill("billing-only@example.test"); await drawer.getByLabel(CREDENTIAL_FIELDS.password.label, { exact: true }).fill("fixture-billing-only-password");
  assert.equal(await drawer.getByRole("checkbox", { name: MONITOR, exact: true }).isChecked(), false); await enableBilling(page, drawer); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].newStation.type, "sub2api-password"); assert.equal("accessToken" in writes[0].selections[0].newStation, false); assert.deepEqual(writes[0].selections[0].additionalMonitorStationIds, []);
});

test("the resources page retains the same batch entry and original resource configuration", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { extraAPI(route, path) {
    if (path === "/api/stations") return fulfill(route, { stations: [], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    throw new Error("unexpected station fixture API: " + path);
  } });
  await page.goto(baseURL + "/stations?view=onboarding"); const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].groups[0].channels[0].channelId, 4); await page.getByRole("tab", { name: STATION_TABS.list, exact: true }).click(); await page.getByRole("button", { name: UPSTREAM_FORM_TEXT.create, exact: true }).first().click(); await page.getByRole("dialog", { name: UPSTREAM_FORM_TEXT.create, exact: true }).waitFor();
});

test("catalogue sync occurs on entry and manual discovery, without page-minute polling", async (t) => {
  const { page, reads } = await openOnboardingPage(t, { clock: true }); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 1); await page.clock.fastForward(70000); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 1); await page.locator(".ant-collapse-header").getByRole("button", { name: REFRESH, exact: true }).click(); await page.getByRole("button", { name: connectButton("New channel"), exact: true }).click({ trial: true }); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 2);
});

// Public shapes and facts from server/channel-onboarding.test.js accountReadFixture/U03 cases.
function accountReadFixture() {
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const identity = (provider, accountId) => ({ provider, baseUrl: "https://same.test", accountId });
  const source = { stationId: "own", provider: "newapi", baseUrl: "https://own.test", accountId: "1", namespaceKey: hash(["newapi", "https://own.test", "1"]) };
  const resource = (id, account, extra = {}) => ({ id, name: id, type: "newapi", baseUrl: "https://same.test", monitorEnabled: true, archivedAt: null, authVersion: 1, resourceVersion: "version-" + id,
    identity: account, verification: account ? "verified" : "unverified", purposes: { monitor: true, billingRuleIds: [] }, balance: { ok: true, remaining: 10 }, lowBalanceUsd: null, cnyPerUsd: null, includeInProfit: true, noRenewal: false, hasAccessToken: true, hasApiKey: false, hasPassword: false, ...extra });
  const member = (channelId) => ({ ownSource: source, ownStationId: "own", channelId, name: "Channel " + channelId });
  const aIdentity = identity("newapi", "A"), bIdentity = identity("newapi", "B"), subIdentity = identity("sub2api", "A");
  const aKey = hash(["newapi", "https://same.test", "A"]), bKey = hash(["newapi", "https://same.test", "B"]), subKey = hash(["sub2api", "https://same.test", "A"]);
  const action = (kind, target = {}) => ({ id: kind + ":" + hash(target), kind, label: workflowActionMeta(kind).label, accountKey: null, stationId: null, ruleId: null, ownStationId: null, channelIds: [], window: null, href: "/stations", ...target });
  const channelRef = (channelId) => ({ channelId, name: "Channel " + channelId });
  const association = (ruleId, extra = {}) => ({ ruleId, status: "active", upstreamStationId: null, ownStationId: "own", timezone: "Asia/Shanghai", channels: [channelRef(1)], costCoverage: "unknown",
    coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] }, scopeVersion: 3, billingEffectiveFromMs: 1791561600000, accountingStartMs: 1791561600000, conflict: false, conflictRuleIds: [], stoppedAt: null, ...extra });
  const stopped = (ruleId, extra = {}) => association(ruleId, { status: "stopped", scopeVersion: 1, stoppedAt: "2026-10-01T00:00:00Z", ...extra });
  const key = (accountId, tokenId, extra = {}) => ({ canonicalKey: hash(["newapi", "https://same.test", accountId, tokenId]), tokenId, tokenName: "Key " + tokenId,
    ruleIds: [accountId + "-active"], activeRuleIds: [accountId + "-active"], scopeAmbiguous: false, channels: [member(1)], costCoverage: "unknown", coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] }, scopeVersion: 3, billingEffectiveFromMs: 1791561600000, firstQueryableAtMs: 1791648000000, ...extra });
  const a = { accountKey: aKey, siteKey: hash(["newapi", "https://same.test"]), identity: aIdentity,
    resources: [resource("A-archived", aIdentity, { archivedAt: "2026-10-01T00:00:00Z", purposes: { monitor: true, billingRuleIds: ["A-history"] } }), resource("A-billing", aIdentity, { monitorEnabled: false, purposes: { monitor: false, billingRuleIds: ["A-active"] } }),
      resource("A-monitor-1", aIdentity, { lowBalanceUsd: 27, cnyPerUsd: 0.7, includeInProfit: false, noRenewal: true, balance: { ok: false, remaining: 10, account: null, error: "403 [已隐藏] [已隐藏] [已隐藏]" } }), resource("A-monitor-2", aIdentity, { purposes: { monitor: true, billingRuleIds: ["A-stopped"] } })],
    keys: [key("A", 9, { ruleIds: ["A-active", "A-history"], channels: [member(1), member(3)], associations: [association("A-active", { upstreamStationId: "A-billing", channels: [channelRef(1), channelRef(3)] }), stopped("A-history", { upstreamStationId: "A-archived" })] }),
      key("A", 10, { ruleIds: ["A-stopped"], activeRuleIds: [], channels: [member(2)], associations: [stopped("A-stopped", { upstreamStationId: "A-monitor-2", channels: [channelRef(2)] })] })],
    actions: [action("update_authorization", { accountKey: aKey, href: `/stations?action=authorization&accountKey=${aKey}` }), action("confirm_coverage", { accountKey: aKey, ruleId: "A-active", ownStationId: "own", channelIds: [2], href: "/stations?action=coverage&ruleId=A-active" })] };
  const b = { accountKey: bKey, siteKey: a.siteKey, identity: bIdentity, resources: [resource("B-monitor", bIdentity)], keys: [key("B", 9, { costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] }, channels: [member(2)],
    associations: [association("B-active", { upstreamStationId: "B-monitor", channels: [channelRef(2)], costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } })] })], actions: [action("inspect_balance", { accountKey: bKey, stationId: "B-monitor" })] };
  const sub = { accountKey: subKey, siteKey: hash(["sub2api", "https://same.test"]), identity: subIdentity, resources: [resource("Sub-JWT", subIdentity, { type: "sub2api" }), resource("Sub-password", subIdentity, { type: "sub2api-password", hasAccessToken: false, hasPassword: true })], keys: [], actions: [] };
  const unverifiedResources = [resource("pure-key", null, { type: "newapi-key", hasAccessToken: false, hasApiKey: true }), resource("unknown-legacy", null)];
  const channels = [1, 2, 3].map((id) => ({ id, name: "Channel " + id, type: 1, status: id === 2 ? 2 : 1, baseUrl: "https://same.test", groups: ["sales"], revision: "revision-" + id, missing: id === 3,
    monitor: { status: id === 1 ? "linked" : "unlinked", stationIds: id === 1 ? ["A-monitor-1", "A-monitor-2", "pure-key"] : [] }, reconciliation: { status: "configured", ruleIds: id === 1 ? ["A-active"] : id === 2 ? ["B-active", "A-stopped"] : ["A-history"] } }));
  return { accounts: [a, b, sub], unverifiedResources, channels, actions: [...a.actions, ...b.actions, action("connect_channels", { stationId: "pure-key", ownStationId: "own", channelIds: [1], href: "/stations?action=connect&ownStationId=own&channelIds=1" }), action("verify_identity", { stationId: "unknown-legacy", ownStationId: "own", href: "/stations?action=verify&stationId=unknown-legacy" })], generatedAt: "2026-10-09T07:00:00.000Z" };
}
// 账号卡片里的事实按 dt/dd 成对展示：等到这一项的值出现
const exactText = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
async function waitForFact(scope, term, value) {
  await scope.locator("dt").filter({ hasText: exactText(term) }).locator("xpath=following-sibling::dd[1]").filter({ hasText: exactText(value) }).first().waitFor();
}

async function openAccountsPage(t, options = {}) {
  const model = options.model || accountReadFixture(), mutations = [], accountRequests = [];
  const originalStations = [
    { id: options.ownStationId || "own", name: "Own station", type: "newapi", baseUrl: "https://own.test", isOwn: true, monitorEnabled: true, hasAccessToken: true, balance: { ok: true, remaining: 50 } },
    ...model.accounts.flatMap((account) => account.resources), ...model.unverifiedResources,
  ].map((entry) => ({ ...entry, isOwn: !!entry.isOwn, userId: ["A-monitor-1", "st_u04_a1"].includes(entry.id) ? "operator-A" : "", email: entry.id === "Sub-password" ? "saved-sub@example.test" : "", costAliases: ["A-monitor-1", "st_u04_a1"].includes(entry.id) ? ["kept_alias"] : [], tokenInfo: null, prediction: null, spark: [], todayUsed: null }));
  const onboarded = await openOnboardingPage(t, { ...options, viewport: options.viewport, accountModel: model, accountOperation: options.accountOperation, accounts(route) {
    accountRequests.push(route.request().method()); return options.accounts ? options.accounts(route, accountRequests.length, model) : fulfill(route, model);
  }, extraAPI(route, path) {
    if (route.request().method() !== "GET") { const mutation = { path, method: route.request().method(), body: route.request().postData() ? route.request().postDataJSON() : null }; mutations.push(mutation); if (options.mutation) return options.mutation(route, mutation, originalStations); throw new Error("unexpected account-center write"); }
    if (path === "/api/stations") { const params = new URL(route.request().url()).searchParams; return fulfill(route, { stations: originalStations.filter((entry) => (!entry.archivedAt || params.get("includeArchived") === "true") && (entry.monitorEnabled !== false || params.get("includeUnmonitored") === "true")), settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } }); }
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }, { value: "newapi-key", label: "Key", needs: ["apiKey"] }, { value: "sub2api", label: "Sub2API", needs: ["accessToken"] }, { value: "sub2api-password", label: "Sub2API password", needs: ["email", "password"] }], rules: {} });
    if (options.readonlyAPI) return options.readonlyAPI(route, path);
    throw new Error("unexpected account fixture API: " + path);
  } });
  const { page } = onboarded;
  // 上游账号、Key 与绑定在「上游账单」标签里；绑定类事项落到「渠道绑定」标签，上游账单此时不可见
  const path = options.path || "/stations?view=bills", onboardingDestination = /[?&]action=(?:connect|coverage|source)(?:&|$)/.test(path);
  // 预载的渠道接入页也读过一次账号；计数从目标页开始
  accountRequests.length = 0;
  await page.goto(baseURL + path); const center = page.getByRole("region", { name: STATION_TABS.bills }); if (onboardingDestination) await page.getByRole("tab", { name: STATION_TABS.onboarding, selected: true }).waitFor(); else if (options.initialFailure) await center.getByRole("button", { name: `${REFRESH}${STATION_TABS.bills}`, exact: true }).waitFor(); else if (!options.path) await center.getByText(/^3 个上游账号；/).waitFor(); else await center.getByText(/^\d+ 个上游账号/).waitFor();
  if (/action=verify(?:&|-billing&)/.test(options.path || "") && !options.path.includes("stationId=deleted")) {
    const verification = page.getByRole("dialog", { name: new RegExp(`^${TEST_READ} · `) }); await verification.waitFor();
    await page.waitForFunction((dialog) => !dialog.closest(".ant-drawer")?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity), await verification.elementHandle());
  }
  const badge = page.getByRole("button", { name: "Collapse issues badge", exact: true }); if (await badge.isVisible()) await badge.click();
  return { ...onboarded, page, center, model, mutations, accountRequests, originalStations };
}
async function expandAccount(center, account) { await center.locator(`[data-site-key="${account.siteKey}"]`).getByRole("button", { name: new RegExp("账号 " + account.identity.accountId + " ") }).click(); return center.locator(`[data-account-key="${account.accountKey}"]`); }

test("workflow channel and complete-Key destinations reuse one batch confirmation with known ninth channel", async (t) => {
  const config = onboardingFixture(true, "newapi", [1, 2, 3, 4, 9]); config.rules[0].channels = [1, 2, 3].map((channelId) => ({ channelId, name: "Sales " + channelId })); config.rules[0].coverageDeclaration = { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [9] }; config.rules[0].timezone = "UTC";
  const opened = await openAccountsPage(t, { config, path: "/stations?action=coverage&ruleId=rule-1" });
  const drawer = opened.page.getByRole("dialog", { name: CONNECT, exact: true }); await drawer.getByText("已选 4 个渠道", { exact: true }).waitFor(); assert.equal(await tokenField(drawer).count(), 0); await answerCoverage(opened.page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(opened.writes.length, 1); assert.deepEqual(opened.writes[0].groups[0].channels.map((channel) => channel.channelId), [1, 2, 3, 9]); assert.equal(opened.writes[0].groups[0].reconciliation.tokenId, 7); assert.equal(opened.writes[0].groups[0].reconciliation.timezone, "UTC"); assert.equal(opened.writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.equal(opened.writes[0].selections[0].stationId, "upstream-1"); assert.equal(opened.writes[0].selections[0].monitor, false);
  const connected = await openAccountsPage(t, { path: "/stations?action=connect&ownStationId=own-1&channelIds=4" }); const single = connected.page.getByRole("dialog", { name: CONNECT, exact: true }); await single.getByText("已选 1 个渠道", { exact: true }).waitFor();
  // 从需处理的「有 N 个渠道还没绑定」进来，要的就是算利润：「算利润」默认勾上（ui-design-spec §5.2）
  assert.equal(await single.getByRole("checkbox", { name: BILLING_CHECKBOX, exact: true }).isChecked(), true); await chooseKey(connected.page, single, "New Key"); await answerCoverage(connected.page, single); await verifyOnboarding(single); await saveOnboarding(single);
  assert.equal(connected.writes.length, 1); assert.equal(connected.writes[0].groups[0].reconciliation.tokenId, 8); assert.equal(connected.writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none");
});

// 渠道绑定页打不开处理目标时（§8.2）：顶部一条提示，带「刷新」和回到渠道绑定的「返回」，不打开抽屉
async function destinationProblem(page, title) {
  const alert = page.locator(".ant-alert").filter({ has: page.locator(".ant-alert-title").filter({ hasText: exactText(title) }) });
  await alert.waitFor(); await alert.getByRole("button", { name: REFRESH, exact: true }).waitFor();
  assert.equal(await alert.getByRole("link", { name: "返回", exact: true }).getAttribute("href"), "/stations");
  return alert;
}
test("workflow stale channel, changed source and stopped coverage destinations keep an actionable reload", async (t) => {
  for (const path of ["/stations?action=connect&ownStationId=own-1&channelIds=999", "/stations?action=connect&ownStationId=another-source&channelIds=4", "/stations?action=coverage&ruleId=stopped-rule", "/stations?action=source&ownStationId=another-source"]) {
    const opened = await openAccountsPage(t, { path }); await destinationProblem(opened.page, DESTINATION_CHANGED); assert.equal(opened.writes.length, 0); assert.equal(opened.probes.length, 0); assert.equal(await opened.page.getByRole("dialog").count(), 0);
  }
  const config = onboardingFixture(true, "newapi", [1, 2, 3, 4]); config.ownSource = { ...ownSource, accountId: "2", namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", ownSource.baseUrl, "2"])).digest("hex") };
  const changed = await openAccountsPage(t, { config, path: "/stations?action=coverage&ruleId=rule-1" }); const SOURCE = reconciliationIssue("SOURCE_BINDING_UNCONFIRMED");
  const problem = await destinationProblem(changed.page, SOURCE.title); await problem.getByText(SOURCE.detail, { exact: true }).waitFor();
  assert.equal(await problem.getByRole("link", { name: workflowActionMeta("review_source").label, exact: true }).getAttribute("href"), workflowAction("review_source", { ownStationId: config.ownStation.id }).href);
  assert.equal(await changed.page.getByRole("dialog").count(), 0); assert.equal(changed.probes.length, 0); assert.equal(changed.writes.length, 0);
});

test("workflow balance destination focuses original resource settings and account authorization opens its existing flow", async (t) => {
  const opened = await openAccountsPage(t, { path: "/stations?stationId=A-monitor-1" }); const focused = opened.page.getByRole("region", { name: workflowActionMeta("inspect_balance").label, exact: true }); await focused.getByText("A-monitor-1", { exact: true }).waitFor(); assert.equal(await focused.getByText("A-monitor-2", { exact: true }).count(), 0); await focused.getByRole("button", { name: "编辑上游", exact: true }).click(); const editor = opened.page.getByRole("dialog", { name: /^编辑上游：/ }); await editor.waitFor(); assert.equal(await editor.getByLabel(CREDENTIAL_FIELDS.userId.label, { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("余额提醒线", { exact: true }).inputValue(), "27");
  const authorized = await openAuthorizationPage(t); await authorized.page.goto(`${baseURL}/stations?action=authorization&accountKey=${authorized.model.accounts[0].accountKey}`); const drawer = authorized.page.getByRole("dialog", { name: `${UPDATE_AUTH} · 上游账号 42`, exact: true }); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("u06-once"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.equal(authorized.updates.length, 1); assert.deepEqual(authorized.updates[0].targetStationIds.sort(), ["st_u04_a1", "st_u04_a2", "st_u04_billing"]);
});

test("billing authorization station link opens the verified account and rejects conflicting account identity", async (t) => {
  const opened = await openAuthorizationPage(t, { path: "/stations?action=authorization&stationId=st_u04_a1" });
  await authorizationDialog(opened.page, "42").waitFor();
  assert.equal(opened.probes.length, 0);
  assert.equal(opened.updates.length, 0);
  await opened.page.goto(`${baseURL}/stations?action=authorization&stationId=st_u04_a1&accountKey=${opened.model.accounts[1].accountKey}`);
  await opened.page.locator(".jy-banner[role=alert]").filter({ has: opened.page.locator("b").filter({ hasText: exactText(DESTINATION_CHANGED) }) }).waitFor();
  assert.equal(await opened.page.getByRole("dialog").count(), 0);
  assert.equal(opened.updates.length, 0);
});

test("workflow source destination distinguishes last verified stale namespace and explicit current sync", async (t) => {
  const config = { ...onboardingFixture(), ownSource, sourceVersion: "source-v1", stale: true, error: "source unavailable" }; let current = false;
  const opened = await openAccountsPage(t, { config, path: "/stations?action=source&ownStationId=own-1", discovery(route, reads) { return fulfill(route, current ? { ...config, ownSource: { ...ownSource, accountId: "2", namespaceKey: "new-source-namespace" }, sourceVersion: "source-v2", stale: false, error: null } : config); } });
  // 自营站点的账号号不再上页面（§3.3）：过期时标题写「刷新失败，数据截至 …」，原因原文收在「查看详细原因」；手动刷新读到最新后改为确认绑定的提示
  const SOURCE = reconciliationIssue("SOURCE_BINDING_UNCONFIRMED"), title = (text) => source.locator(".ant-alert-title").filter({ hasText: exactText(text) });
  const source = opened.page.getByRole("region", { name: workflowActionMeta("review_source").label, exact: true }); await title(refreshFailedText(config.syncedAt, config.tz)).waitFor();
  assert.ok((await source.textContent()).includes(`自营站点：${EMPTY} · ${ownSource.baseUrl}`)); assert.equal(await source.locator("details.jy-error-detail").filter({ hasText: config.error }).count(), 1);
  current = true; await source.getByRole("button", { name: REFRESH, exact: true }).click(); await title(SOURCE.title).waitFor(); await source.getByText(SOURCE.detail, { exact: true }).waitFor();
  assert.equal(await source.locator("details.jy-error-detail").count(), 0); assert.equal(await title(refreshFailedText(config.syncedAt, config.tz)).count(), 0); assert.equal(opened.writes.length, 0); assert.equal(opened.probes.length, 0);
});

function keyVerificationFixture(provider = "newapi", timezone = "UTC", selected = false) {
  const capability = { state: "supported", currency: "USD", window: provider === "sub2api" ? "natural-day" : "second" };
  const billingTimezone = provider === "sub2api" ? { state: "unverified", timezone, reason: "BILLING_TIMEZONE_UNVERIFIED" } : { state: "verified", timezone };
  return { quotaPerUnit: provider === "newapi" ? 100 : null, version: provider === "newapi" ? "deployment-v1" : "", groups: provider === "newapi" ? { g: { ratio: 1, description: "" } } : {}, platform: provider,
    capability: provider === "sub2api" ? { state: "unverified", currency: "USD", window: "natural-day", reason: "DEPLOYMENT_NOT_VERIFIED" } : capability,
    billingTimezone, tokens: [{ id: 9, name: "actual-key", status: 1, group: provider === "newapi" ? "g" : "", crossGroupRetry: false }], identity: { provider, baseUrl: "https://same.test", accountId: "42" }, resourceVersion: "verified-resource-version",
    probe: selected ? { tokenId: 9, state: "complete", complete: true, window: timezone === "UTC" ? { startMs: 1791417600000, endMs: 1791504000000, timezone } : { startMs: 1791388800000, endMs: 1791475200000, timezone }, currency: "USD", amountUsd: provider === "newapi" ? 0 : 3.25, knownAmountUsd: provider === "newapi" ? 0 : 3.25, actualCostUsd: provider === "sub2api" ? 3.25 : null, quotaUnits: provider === "newapi" ? 0 : null, quotaPerUnit: provider === "newapi" ? 100 : null, capability, billingTimezone } : null };
}

// 测试读取抽屉（§3.5）：标题「测试读取 · 上游名」，读到上游账号写「能读到上游账号 N」，下面一个「确认」把这个上游归到这个上游账号下
const verificationDialog = (page, name) => page.getByRole("dialog", { name: `${TEST_READ} · ${name}`, exact: true });
const confirmIdentityButton = (drawer) => drawer.getByRole("button", { name: "确认", exact: true });
const IDENTITY_READ = (accountId) => `能读到上游账号 ${accountId}`;
const VERIFY_KEY = "选一把 Key", VERIFY_SELECTED = "测试读取选中的 Key", SWAP_KEY = workflowActionMeta("swap_key").label;
for (const width of [320, 390, 768, 1440]) {
  test(`F06 legacy account identity is explicitly confirmed without channels at ${width}px`, async (t) => {
    const model = accountReadFixture(), original = model.unverifiedResources.find((resource) => resource.id === "unknown-legacy");
    model.accounts = []; model.unverifiedResources = [original]; model.channels = []; model.actions = [];
    const read = keyVerificationFixture(); read.resourceVersion = original.resourceVersion;
    read.tokens = []; read.capability = { state: "unverified", currency: "USD", window: "second", reason: "KEY_METADATA_UNAVAILABLE" };
    const accountKey = createHash("sha256").update(JSON.stringify([read.identity.provider, read.identity.baseUrl, read.identity.accountId])).digest("hex");
    const opened = await openAccountsPage(t, { model, viewport: { width, height: 900 }, path: "/stations?action=verify&stationId=unknown-legacy",
      readonlyAPI(route) { return fulfill(route, read); }, mutation(route, mutation, stations) {
        assert.equal(mutation.path, "/api/channel-onboarding/resources/unknown-legacy/identity"); assert.equal(mutation.method, "POST");
        assert.deepEqual(mutation.body, { identity: read.identity, resourceVersion: read.resourceVersion });
        const resource = { ...original, identity: read.identity, verification: "verified", resourceVersion: "saved-resource-version" };
        Object.assign(stations.find((station) => station.id === original.id), resource);
        model.accounts = [{ accountKey, siteKey: createHash("sha256").update(JSON.stringify([read.identity.provider, read.identity.baseUrl])).digest("hex"),
          identity: read.identity, resources: [resource], keys: [], actions: [] }]; model.unverifiedResources = [];
        return fulfill(route, { stationId: original.id, identity: read.identity, accountKey, resourceVersion: resource.resourceVersion });
      } });
    const drawer = verificationDialog(opened.page, "unknown-legacy"), confirm = confirmIdentityButton(drawer);
    assert.equal(await confirm.count(), 0);
    await drawer.getByRole("button", { name: TEST_READ, exact: true }).click();
    await alertTitle(drawer, IDENTITY_READ("42")).waitFor(); assert.equal(opened.mutations.length, 0);
    await confirm.focus(); await opened.page.keyboard.press("Enter"); await drawer.waitFor({ state: "hidden" });
    await opened.center.getByText(/^1 个上游账号；0 个上游还没确认上游账号/).waitFor();
    await opened.center.getByRole("button", { name: `${UPDATE_AUTH} 上游账号 42`, exact: true }).waitFor();
    assert.equal(opened.mutations.length, 1); assert.equal(opened.writes.length, 0);
    assert.equal(await opened.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  });
}

test("F06 a rejected identity save remains retryable and requires a new read before another confirmation", async (t) => {
  const opened = await openAccountsPage(t, { path: "/stations?action=verify&stationId=unknown-legacy",
    readonlyAPI(route) { return fulfill(route, keyVerificationFixture()); }, mutation(route) {
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "RESOURCE_CHANGED", error: "资源配置已变化，请重新核验" }) });
    } });
  const drawer = verificationDialog(opened.page, "unknown-legacy"), confirm = confirmIdentityButton(drawer);
  await drawer.getByRole("button", { name: TEST_READ, exact: true }).click();
  await confirm.click();
  // 保存被拒：写「保存失败：内容有变化，请重新预览。」，接口原文收在「查看详细原因」
  const rejected = alertWithTitle(drawer, failureText("保存失败", { code: "RESOURCE_CHANGED", error: "资源配置已变化，请重新核验" })); await rejected.waitFor();
  assert.equal(await rejected.locator("details.jy-error-detail").filter({ hasText: "资源配置已变化，请重新核验" }).count(), 1);
  assert.equal(await confirm.count(), 0);
  await drawer.getByRole("button", { name: TEST_READ, exact: true }).click();
  await alertTitle(drawer, IDENTITY_READ("42")).waitFor();
  await confirm.waitFor();
  assert.equal(opened.mutations.length, 1); assert.equal(opened.writes.length, 0);
});
test("workflow identity and selected-Key read preserve actual zero and separate Sub2 date capability from timezone", async (t) => {
  for (const [stationId, provider, action, timezone] of [["unknown-legacy", "newapi", "verify", "UTC"], ["Sub-password", "sub2api", "verify-billing", "Asia/Shanghai"]]) {
    const reads = []; const opened = await openAccountsPage(t, { path: `/stations?action=${action}&stationId=${stationId}`, readonlyAPI(route, path) {
      assert.equal(path, `/api/reconciliation/upstreams/${stationId}/keys`); const params = Object.fromEntries(new URL(route.request().url()).searchParams); reads.push(params); return fulfill(route, keyVerificationFixture(provider, params.timezone, !!params.tokenId));
    } });
    // Key 下拉写「名称 · 分组 g」，没有分组时只写名称；读出来的上游成本是 0 也照写 $0.00
    const drawer = verificationDialog(opened.page, stationId); await drawer.waitFor(); await drawer.getByRole("textbox", { name: "时区", exact: true }).fill(timezone); await drawer.getByRole("button", { name: TEST_READ, exact: true }).click(); await alertTitle(drawer, IDENTITY_READ("42")).waitFor(); await drawer.getByRole("combobox", { name: VERIFY_KEY, exact: true }).click(); await opened.page.getByText(provider === "newapi" ? "actual-key · 分组 g" : "actual-key", { exact: true }).last().click(); await drawer.getByRole("button", { name: VERIFY_SELECTED, exact: true }).click(); await alertTitle(drawer, "actual-key 的上游成本").waitFor();
    assert.deepEqual(reads, [{ force: "true", timezone }, { force: "true", timezone, tokenId: "9" }]); assert.ok((await drawer.textContent()).includes(provider === "newapi" ? "上游成本 $0.00" : "上游成本 $3.25")); assert.ok((await drawer.textContent()).includes("这里只是测试读取，不改利润。")); if (provider === "sub2api") { await drawer.getByText(testReadText({ ok: true }), { exact: true }).waitFor(); await drawer.getByText(reconciliationIssue("BILLING_TIMEZONE_UNVERIFIED").title, { exact: true }).waitFor(); } assert.equal(opened.mutations.length, 0); assert.equal(opened.writes.length, 0);
  }
});

test("workflow unreadable Key directory remains partial and pure-Key fallback uses the full original editor", async (t) => {
  const opened = await openAccountsPage(t, { path: "/stations?action=verify&stationId=unknown-legacy", readonlyAPI(route) {
    const partial = keyVerificationFixture(); Object.assign(partial, { quotaPerUnit: null, version: "", groups: {}, tokens: [], capability: { state: "unverified", currency: "USD", window: "second", reason: "KEY_METADATA_UNAVAILABLE" }, billingTimezone: { state: "unverified", timezone: "Asia/Shanghai", reason: "KEY_METADATA_UNAVAILABLE" } }); return fulfill(route, partial);
  } }); const drawer = verificationDialog(opened.page, "unknown-legacy"); await drawer.getByRole("button", { name: TEST_READ, exact: true }).click(); await alertTitle(drawer, testReadText({ ok: false, reason: describeError({ code: "KEY_METADATA_UNAVAILABLE" }).text })).waitFor(); assert.equal(await drawer.getByRole("combobox", { name: VERIFY_KEY, exact: true }).count(), 0); assert.equal(opened.mutations.length, 0);
  const pure = await openAccountsPage(t, { path: "/stations?action=verify-billing&stationId=pure-key", readonlyAPI() { assert.fail("pure Key must not enter account probe"); } }); const pureDrawer = verificationDialog(pure.page, "pure-key"); await alertTitle(pureDrawer, "只有一把 Key，读不到上游账号").waitFor(); await pureDrawer.getByRole("button", { name: UPDATE_AUTH, exact: true }).click(); const editor = pure.page.getByRole("dialog", { name: /^编辑上游：/ }); await editor.waitFor(); assert.equal(await editor.getByLabel(CREDENTIAL_FIELDS.name.label, { exact: true }).inputValue(), "pure-key"); assert.equal(pure.mutations.length, 0);
});

test("workflow external Key use stops the old rule before selecting a new Key while unknown use stays reference", async (t) => {
  const config = onboardingFixture(true, "newapi", [1, 2, 3, 4]); config.rules[0].channels = [1, 2, 3].map((channelId) => ({ channelId })); config.rules[0].coverageDeclaration = { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] };
  const opened = await openAccountsPage(t, { config, path: "/stations?action=coverage&ruleId=rule-1", mutation(route, mutation) { assert.equal(mutation.path, "/api/reconciliation/rules/rule-1"); assert.equal(mutation.method, "DELETE"); config.rules[0].enabled = false; return fulfill(route, { ok: true }); } }); const drawer = opened.page.getByRole("dialog", { name: CONNECT, exact: true }); await alertTitle(drawer, COVERAGE_QUESTION).waitFor(); assert.equal(await drawer.getByRole("combobox", { name: "Key", exact: true }).isDisabled(), true);
  // 「换 Key」先确认：站外也在用就给站外单开一把 Key，旧 Key 以前的每日记录还在
  await drawer.getByRole("button", { name: SWAP_KEY, exact: true }).click(); const confirm = opened.page.getByRole("dialog", { name: `${SWAP_KEY}？`, exact: true }); await confirm.getByText(`站外也在用的话，先在上游给站外单开一把 Key。换成新 Key 后，旧 Key ${HISTORY_KEPT}。`, { exact: true }).waitFor(); assert.equal(opened.writes.length, 0); await confirm.getByRole("button", { name: SWAP_KEY, exact: true }).click(); await confirm.waitFor({ state: "hidden" }); assert.equal(opened.mutations.length, 1);
  await verifyOnboarding(drawer); await chooseKey(opened.page, drawer, "New Key"); await answerCoverage(opened.page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(opened.writes.length, 1); assert.equal(opened.writes[0].groups[0].reconciliation.tokenId, 8); assert.equal(opened.writes[0].selections[0].stationId, "upstream-1");
  const unknown = await openAccountsPage(t, { config: onboardingFixture(true, "newapi", [1, 2, 3, 4]), path: "/stations?action=coverage&ruleId=rule-1" }); const unknownDrawer = unknown.page.getByRole("dialog", { name: CONNECT, exact: true });
  // 从「去回答」进来一开始不选：没回答就测试读取，先提示回答，不发请求（ui-copy-spec §5.2、§8.2）
  await unknownDrawer.getByRole("button", { name: TEST_READ, exact: true }).click(); await unknownDrawer.getByText(`请回答「${COVERAGE_QUESTION}」`, { exact: true }).waitFor(); assert.equal(unknown.probes.length, 0);
  // 答「不确定」：选项下面和预览都写这个回答的后果，不写「从现在开始算利润」
  await answerCoverage(unknown.page, unknownDrawer, { answer: UNSURE }); await unknownDrawer.getByText("选「不确定」的话，利润先不算", { exact: true }).waitFor(); await verifyOnboarding(unknownDrawer);
  await unknownDrawer.getByText("同一把 Key 的上游成本只算一次；选「不确定」的话，利润先不算", { exact: true }).waitFor(); assert.equal(await unknownDrawer.getByText("从现在开始算利润，今天就能看到；过了零点自动固定。", { exact: true }).count(), 0);
  assert.equal(unknown.mutations.length, 0); assert.equal(unknown.writes.length, 0); assert.equal(unknown.probes[0].groups[0].reconciliation.coverageDeclaration.answer, "unknown");
});

test("workflow overview merges stable public actions and preserves prior actions on a partial read failure", async (t) => {
  let reads = 0; const opened = await openAccountsPage(t, { accounts(route, count, model) { reads += 1; return count > 2 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture account read unavailable" }) }) : fulfill(route, model); }, readonlyAPI(route, path) {
    // 总览的经营数据不在本用例范围内：只读接口给不可用，页面照常展示需处理的事
    if (path === "/api/own/analytics") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture analytics unavailable" }) });
    assert.equal(path, "/api/history/overview"); return fulfill(route, { series: [] });
  } });
  await opened.page.goto(baseURL); const region = opened.page.getByRole("region", { name: "需处理", exact: true }); const authLink = new RegExp(`^${UPDATE_AUTH}（`); await region.getByRole("link", { name: authLink }).waitFor(); assert.equal(await region.getByRole("link", { name: new RegExp(`^${workflowActionMeta("confirm_coverage").label}（`) }).count(), 1); const before = await region.getByRole("listitem").count(); await region.getByRole("button", { name: `${workflowActionMeta("refresh").label}需处理的事`, exact: true }).click();
  // 有一处没读到：写「刷新失败，数据截至 …。」，上次读到的事项照常列出
  await region.locator(".jy-ov-banner-text").filter({ hasText: /^刷新失败，数据截至 .+。$/ }).waitFor(); assert.equal(await region.getByRole("listitem").count(), before); const href = await region.getByRole("link", { name: authLink }).getAttribute("href"); assert.equal(href, opened.model.accounts[0].actions[0].href); assert.equal(opened.mutations.length, 0); assert.ok(reads >= 3);
});

test("运营总览在手机上先列需处理，再是利润等式；桌面照旧等式在前", async (t) => {
  const readonlyAPI = (route, path) => path === "/api/own/analytics" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture analytics unavailable" }) }) : (assert.equal(path, "/api/history/overview"), fulfill(route, { series: [] }));
  for (const [width, attentionFirst] of [[390, true], [1440, false]]) {
    const opened = await openAccountsPage(t, { readonlyAPI }); await opened.page.setViewportSize({ width, height: 844 }); await opened.page.goto(baseURL);
    const attention = opened.page.getByRole("region", { name: "需处理", exact: true }), equation = opened.page.getByRole("region", { name: `${RANGE_TEXT.today}经营`, exact: true });
    await attention.waitFor(); await equation.waitFor();
    // 按 DOM 先后比（读屏和键盘也按这个顺序），不只看位置；宽度判断在挂载后才定下来，等它一下
    const order = async () => opened.page.evaluate(() => { const [attention, equation] = ["需处理", "今天经营"].map((name) => [...document.querySelectorAll("section.jy-panel")].find((node) => node.querySelector("h2")?.textContent === name)); return !!(attention && equation && attention.compareDocumentPosition(equation) & Node.DOCUMENT_POSITION_FOLLOWING); });
    let before = await order(); for (let wait = 0; before !== attentionFirst && wait < 30; wait++) { await opened.page.waitForTimeout(100); before = await order(); }
    assert.equal(before, attentionFirst, `宽 ${width} 时需处理${attentionFirst ? "应在" : "不应在"}利润等式前面`);
  }
});

test("workflow read failures and deleted verification targets expose a safe retry with no save", async (t) => {
  let calls = 0; const opened = await openAccountsPage(t, { path: "/stations?action=verify-billing&stationId=unknown-legacy", readonlyAPI(route) { calls += 1; if (calls === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "KEY_PROBE_UNAVAILABLE", retryable: true, error: "账号身份暂时无法核验，请检查授权或稍后重试" }) }); return fulfill(route, keyVerificationFixture("newapi", "Asia/Shanghai")); } }); const drawer = verificationDialog(opened.page, "unknown-legacy"); await drawer.getByRole("button", { name: TEST_READ, exact: true }).click();
  // 读不到：写「读不到：」加归类后的原因，原文收在「查看详细原因」，旁边一个「刷新」；再测试读取一次就好
  const failed = alertWithTitle(drawer, testReadText({ ok: false, reason: describeError({ code: "KEY_PROBE_UNAVAILABLE" }).text })); await failed.waitFor(); await failed.getByRole("button", { name: REFRESH, exact: true }).waitFor(); assert.equal(await failed.locator("details.jy-error-detail").filter({ hasText: "账号身份暂时无法核验，请检查授权或稍后重试" }).count(), 1);
  await drawer.getByRole("button", { name: TEST_READ, exact: true }).click(); await alertTitle(drawer, IDENTITY_READ("42")).waitFor(); assert.equal(calls, 2); assert.equal(opened.mutations.length, 0);
  // 处理目标不在了：顶部一条提示（上游没了写「找不到这个上游。」，上游账号变了写「这条已经变了」），带「刷新」和「返回上游列表」，不打开抽屉
  for (const [path, title] of [["/stations?action=verify&stationId=deleted", `${ERROR_CATEGORIES.not_found.text}。`], ["/stations?action=authorization&accountKey=deleted", DESTINATION_CHANGED], ["/stations?stationId=deleted", `${ERROR_CATEGORIES.not_found.text}。`]]) {
    const unavailable = await openAccountsPage(t, { path }); const banner = unavailable.page.locator(".jy-banner[role=alert]").filter({ has: unavailable.page.locator("b").filter({ hasText: exactText(title) }) }); await banner.waitFor(); await banner.getByRole("button", { name: REFRESH, exact: true }).waitFor();
    assert.equal(await banner.getByRole("link", { name: `返回${STATION_TABS.list}`, exact: true }).getAttribute("href"), "/stations"); assert.equal(await unavailable.page.getByRole("dialog").count(), 0); assert.equal(unavailable.mutations.length, 0);
  }
});

test("workflow verification keyboard and financial source links fit 320/390/768/1440 widths", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const opened = await openAccountsPage(t, { viewport: { width, height: 900 }, path: "/stations?action=verify-billing&stationId=Sub-password", readonlyAPI(route, path) {
      if (path.endsWith("/keys")) { const params = new URL(route.request().url()).searchParams; return fulfill(route, keyVerificationFixture("sub2api", params.get("timezone"), params.has("tokenId"))); }
      if (path === "/api/analytics") return fulfill(route, { days: 30, start: "2026-09-09", end: "2026-10-08", selection: { includeArchived: false, stationCount: 0, archivedStationCount: 0 }, coverage: { earliestDate: null, latestDate: null, availableDays: 0, requestedDays: 30, monitoredStationCount: 0, isComplete: false, stationGaps: [] }, stations: [], daily: [], fixedDaily: [], heatmap: [], heatmapAvailable: false, heatmapAvailability: { available: false, reason: "no-cost-stations", coverage: null }, generatedAt: "2026-10-09T03:00:00Z" });
      if (path === "/api/own/analytics") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }) });
      throw new Error("unexpected financial navigation fixture: " + path);
    } });
    const drawer = verificationDialog(opened.page, "Sub-password"); const directory = drawer.getByRole("button", { name: TEST_READ, exact: true }); await directory.focus(); await opened.page.keyboard.press("Enter"); await alertTitle(drawer, IDENTITY_READ("42")).waitFor(); const key = drawer.getByRole("combobox", { name: VERIFY_KEY, exact: true }); await key.focus(); await opened.page.keyboard.press("ArrowDown"); await opened.page.keyboard.press("Enter"); const probe = drawer.getByRole("button", { name: VERIFY_SELECTED, exact: true }); await probe.focus(); await opened.page.keyboard.press("Enter"); await alertTitle(drawer, "actual-key 的上游成本").waitFor();
    await opened.page.waitForFunction((dialog) => !dialog.closest(".ant-drawer")?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity), await drawer.elementHandle());
    const overflow = await opened.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      elements: [...document.querySelectorAll("body *")].filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8)
        .map((node) => ({ tag: node.tagName, className: node.className, right: node.getBoundingClientRect().right, text: node.textContent?.slice(0, 100) })) }));
    assert.ok(overflow.scroll <= overflow.client, JSON.stringify({ width, ...overflow }));
    await drawer.locator(".ant-drawer-close").focus(); await opened.page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
    await opened.page.goto(baseURL + "/analytics", { timeout: 30000 }); await opened.page.getByText(ANALYTICS_COPY.sourceTitle, { exact: true }).waitFor(); const bill = opened.page.locator('.page-toolbar a[href="/reconciliation"]'); await bill.waitFor(); await bill.focus(); await opened.page.keyboard.press("Enter"); await opened.page.getByRole("region", { name: "汇总", exact: true }).waitFor(); await opened.page.getByRole("link", { name: NAV_LABELS.analytics, exact: true }).last().waitFor(); assert.ok(await opened.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)); assert.equal(opened.mutations.length, 0); await opened.page.context().close();
  }
});

async function openAuthorizationPage(t, options = {}) {
  const model = accountReadFixture(), probes = [], updates = [], recoveries = [], operations = new Map();
  const rename = { "A-monitor-1": "st_u04_a1", "A-monitor-2": "st_u04_a2", "A-billing": "st_u04_billing", "A-archived": "st_u04_archived", "B-monitor": "st_u04_b", "pure-key": "st_u04_key", "unknown-legacy": "st_u04_unknown", own: "st_u04_own" };
  const account = model.accounts[0], b = model.accounts[1]; account.identity.accountId = "42"; b.identity.accountId = "43";
  for (const item of [account, b]) {
    item.accountKey = createHash("sha256").update(JSON.stringify([item.identity.provider, item.identity.baseUrl, item.identity.accountId])).digest("hex");
    for (const resource of item.resources) { resource.id = rename[resource.id] || resource.id; resource.identity = { ...item.identity }; resource.purposes.billingRuleIds = resource.id === "st_u04_billing" ? ["rule_u04"] : []; }
    for (const key of item.keys) if (key.activeRuleIds.length) { key.ruleIds = item === account ? ["rule_u04", "rule_history"] : ["rule_b"]; key.activeRuleIds = [key.ruleIds[0]]; key.associations.forEach((association, index) => { association.ruleId = key.ruleIds[index]; }); }
    for (const key of item.keys) for (const association of key.associations) { association.upstreamStationId = rename[association.upstreamStationId] || association.upstreamStationId; association.ownStationId = "st_u04_own"; }
  }
  for (const resource of model.unverifiedResources) resource.id = rename[resource.id];
  for (const channel of model.channels) { channel.monitor.stationIds = channel.monitor.stationIds.map((id) => rename[id] || id); channel.reconciliation.ruleIds = channel.id === 1 ? ["rule_u04"] : channel.reconciliation.ruleIds; }
  for (const item of model.accounts) for (const key of item.keys) for (const channel of key.channels) { channel.ownStationId = "st_u04_own"; channel.ownSource.stationId = "st_u04_own"; }
  let originalStations, donorRejected = false;
  const resources = model.accounts.flatMap((item) => item.resources);
  const intent = (body) => ({ requestId: body.requestId, targetStationIds: [...body.targetStationIds] });
  const impact = (targets) => ({ monitorStationIds: targets.filter((target) => target.purposes.monitor).map((target) => target.stationId), billingRuleIds: [...new Set(targets.flatMap((target) => target.billingRuleIds))], channels: [{ ownStationId: "st_u04_own", channelId: 1, name: "Sales 1" }] });
  const project = (body, targetAccount) => {
    const targets = body.targetStationIds.flatMap((id) => {
      const resource = targetAccount.resources.find((entry) => entry.id === id && !entry.archivedAt);
      return resource ? [{ stationId: id, authVersion: resource.authVersion, resourceVersion: resource.resourceVersion, currentType: resource.type, newType: body.authorization?.type || resource.type, purposes: resource.purposes, monitorChannelIds: resource.purposes.monitor ? [1] : [], billingRuleIds: resource.purposes.billingRuleIds, billingChannelIds: resource.purposes.billingRuleIds.length ? [1] : [] }] : [];
    });
    return { requestId: body.requestId, previewId: "authorization-preview-" + probes.length, expiresAtMs: Date.now() + 600000, accountKey: targetAccount.accountKey, identity: targetAccount.identity, targets, excluded: body.targetStationIds.filter((id) => !targets.some((target) => target.stationId === id)).map((stationId) => ({ stationId, reason: "账号身份未核验，已排除" })), impact: impact(targets), retryInput: intent(body) };
  };
  const opened = await openAccountsPage(t, { model, viewport: options.viewport, path: options.path, ownStationId: "st_u04_own", async accountOperation(route, path) {
    const body = route.request().postDataJSON(), targetAccount = model.accounts.find((item) => path.includes(item.accountKey)); assert.ok(targetAccount);
    if (path.endsWith("/probe")) {
      probes.push(body);
      if (body.authorization?.accessToken === "account-B") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "ACCOUNT_IDENTITY_CHANGED", error: "替换授权属于另一个账号，请另行接入" }) });
      if (body.reuseSavedAuthorization && options.invalidDonor && !donorRejected) { donorRejected = true; return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "AUTHORIZATION_UNVERIFIED", error: "已保存授权验证失败 [已隐藏]" }) }); }
      if (body.reuseSavedAuthorization && options.noDonor) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "SAVED_AUTHORIZATION_UNAVAILABLE", error: "尚无已确认更新的授权可复用，请重新输入" }) });
      const preview = project(body, targetAccount); operations.set(body.requestId, { preview, saved: operations.get(body.requestId)?.saved || new Set() }); return fulfill(route, preview);
    }
    const operation = operations.get(body.requestId); assert.ok(operation, "recovery uses the original credential-free intent");
    if (path.endsWith("/recover")) {
      recoveries.push(body); assert.deepEqual(body, operation.preview.retryInput);
      const targets = body.targetStationIds.map((stationId) => ({ stationId, status: operation.saved.has(stationId) ? "already_updated" : "repreview_required", savedAuthVersion: operation.saved.has(stationId) ? 2 : null, ...(operation.saved.has(stationId) ? {} : { code: "PREVIEW_REQUIRED", reason: "请重新预览" }), remainingActions: operation.saved.has(stationId) ? [] : ["repreview"] }));
      return fulfill(route, { requestId: body.requestId, accountKey: targetAccount.accountKey, complete: targets.every((target) => target.status === "already_updated"), targets, excluded: operation.preview.excluded, impact: operation.preview.impact, retryInput: intent(body) });
    }
    updates.push(body); assert.equal(body.previewId, operation.preview.previewId);
    const targets = operation.preview.targets.map((target) => {
      if (operation.saved.has(target.stationId)) return { stationId: target.stationId, status: "already_updated", savedAuthVersion: 2, remainingActions: [] };
      if ((options.partial && target.stationId === "st_u04_a2" || options.noDonor) && updates.length === 1) return { stationId: target.stationId, status: "failed", savedAuthVersion: null, code: "AUTHORIZATION_UPDATE_FAILED", reason: "保存失败，请稍后重试", remainingActions: ["repreview"] };
      operation.saved.add(target.stationId); const resource = resources.find((entry) => entry.id === target.stationId); resource.authVersion += 1; resource.resourceVersion += "-updated"; resource.type = target.newType;
      Object.assign(originalStations.find((entry) => entry.id === target.stationId), { authVersion: resource.authVersion, resourceVersion: resource.resourceVersion, type: resource.type });
      return { stationId: target.stationId, status: "updated", savedAuthVersion: resource.authVersion, remainingActions: [] };
    });
    targets.push(...operation.preview.excluded.map((target) => ({ stationId: target.stationId, status: "failed", savedAuthVersion: null, code: "TARGET_EXCLUDED", reason: target.reason, remainingActions: ["verify_identity", "repreview"] })));
    const result = { requestId: body.requestId, accountKey: targetAccount.accountKey, complete: targets.every((target) => target.status !== "failed"), targets, excluded: operation.preview.excluded, impact: operation.preview.impact, retryInput: operation.preview.retryInput };
    if (options.loseResponse && updates.length === 1) return route.abort("failed"); return fulfill(route, result);
  }, mutation(route, mutation, stations) {
    if (mutation.method === "PUT") {
      const id = decodeURIComponent(mutation.path.split("/").at(-1)), resource = resources.find((entry) => entry.id === id); assert.ok(resource);
      assert.deepEqual(Object.keys(mutation.body).sort(), ["expectedAuthVersion", "expectedResourceVersion", "monitorEnabled"]);
      assert.equal(mutation.body.expectedAuthVersion, resource.authVersion); assert.equal(mutation.body.expectedResourceVersion, resource.resourceVersion);
      resource.monitorEnabled = mutation.body.monitorEnabled; resource.purposes.monitor = mutation.body.monitorEnabled; if (!resource.monitorEnabled) resource.includeInProfit = false; resource.resourceVersion += "-purpose";
      Object.assign(stations.find((entry) => entry.id === id), { monitorEnabled: resource.monitorEnabled, includeInProfit: resource.includeInProfit, resourceVersion: resource.resourceVersion }); return fulfill(route, { ok: true });
    }
    assert.equal(mutation.method, "DELETE"); const ruleId = mutation.path.split("/").at(-1); for (const item of model.accounts) for (const key of item.keys) {
      key.activeRuleIds = key.activeRuleIds.filter((id) => id !== ruleId);
      for (const association of key.associations) if (association.ruleId === ruleId) Object.assign(association, { status: "stopped", stoppedAt: "2026-10-09T07:30:00Z", conflict: false, conflictRuleIds: [] });
    }
    return fulfill(route, { ok: true });
  } });
  originalStations = opened.originalStations;
  return { ...opened, probes, updates, recoveries };
}
// 更新登录信息（§3.7）：账号卡片里的按钮写「更新登录信息 上游账号 N」，抽屉标题「更新登录信息 · 上游账号 N」
const authorizationDialog = (page, accountId) => page.getByRole("dialog", { name: `${UPDATE_AUTH} · 上游账号 ${accountId}`, exact: true });
const authorizationConfirm = (drawer) => drawer.getByRole("button", { name: `确认${UPDATE_AUTH}`, exact: true });
const alertTitle = (scope, text) => scope.locator(".ant-alert-title").filter({ hasText: typeof text === "string" ? exactText(text) : text });
// 带这个标题的整条提示（标题和「查看详细原因」在同一条里）
const alertWithTitle = (scope, text) => scope.locator(".ant-alert").filter({ has: scope.page().locator(".ant-alert-title").filter({ hasText: exactText(text) }) });
const REFILL_TITLE = (code) => `${describeError({ code }).text}。请重新填写登录信息。`;
async function openAccountAuthorization(page, center, account) {
  const expanded = await expandAccount(center, account); await expanded.getByRole("button", { name: `${UPDATE_AUTH} 上游账号 ${account.identity.accountId}`, exact: true }).click();
  return authorizationDialog(page, account.identity.accountId);
}
// 已有保存结果时预览按钮写「重新预览」，沿用已保存的登录信息
async function previewAuthorization(drawer, again = false) { await drawer.getByRole("button", { name: again ? "重新预览" : BINDING_COPY.preview, exact: true }).click(); await alertTitle(drawer, "预览，还没保存").waitFor(); }
// 确认后预览卡片收起、抽屉恢复可关闭，再等结果标题：全部更新上，或「有 N 个上游没更新上」
async function confirmAccountAuthorization(drawer) {
  await authorizationConfirm(drawer).click(); await alertTitle(drawer, "预览，还没保存").waitFor({ state: "hidden" }); await drawer.locator(".ant-drawer-close").waitFor();
  await alertTitle(drawer, new RegExp(`^(${workflowActionMeta("update_authorization").done}|有 \\d+ 个上游没更新上，已更新的不变)$`)).waitFor();
}

test("account authorization without randomUUID renews IDs on input changes and confirms the preview ID", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t);
  await page.evaluate(() => Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined }));
  const drawer = await openAccountAuthorization(page, center, model.accounts[0]);
  await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("first-fixture-pat"); await previewAuthorization(drawer);
  const first = probes[0].requestId;
  assert.match(first, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("second-fixture-pat"); await previewAuthorization(drawer);
  assert.notEqual(probes[1].requestId, first);
  assert.match(probes[1].requestId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  await confirmAccountAuthorization(drawer);
  assert.equal(updates[0].requestId, probes[1].requestId);
});

test("account authorization without browser cryptography does not partially open or send an update", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t);
  await page.evaluate(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
    Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, value: undefined });
  });
  await openAccountAuthorization(page, center, model.accounts[0]);
  // 报错按码归类后显示「浏览器太旧」那一句（原文「当前浏览器无法生成请求标识…」不在提示里），写在页面顶部，不说成刷新失败
  await center.getByText(describeError({ code: "BROWSER_UNSUPPORTED" }).text, { exact: true }).waitFor();
  assert.equal(await center.getByText(/刷新失败/).count(), 0);
  assert.equal(await authorizationDialog(page, "42").count(), 0);
  assert.equal(probes.length, 0); assert.equal(updates.length, 0);
});

test("account authorization inputs once and confirms three explicit targets while excluding same-site B, own, archived and pure Key", async (t) => {
  const { page, center, model, probes, updates, originalStations } = await openAuthorizationPage(t), account = model.accounts[0]; const before = originalStations.map((resource) => ({ id: resource.id, userId: resource.userId, costAliases: resource.costAliases, lowBalanceUsd: resource.lowBalanceUsd, cnyPerUsd: resource.cnyPerUsd, includeInProfit: resource.includeInProfit, noRenewal: resource.noRenewal }));
  const drawer = await openAccountAuthorization(page, center, account); assert.equal(await drawer.locator('input[type="password"]').count(), 1); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("one-new-pat"); await previewAuthorization(drawer);
  assert.deepEqual(probes[0].targetStationIds, ["st_u04_billing", "st_u04_a1", "st_u04_a2"]); assert.deepEqual(probes[0].authorization, { type: "newapi", baseUrl: "https://same.test", accessToken: "one-new-pat", userId: "42" });
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("account-authorization-recovery-v05"))); assert.deepEqual(stored, { accountKey: account.accountKey, retryInput: { requestId: probes[0].requestId, targetStationIds: probes[0].targetStationIds } }); assert.doesNotMatch(JSON.stringify(stored), /pat|authorization|previewId|marker/);
  // 「不跟着更新」按名字列出归档、同站其他上游账号、只用 Key 和自营站点；影响只写绑定条数，不写绑定编号
  await drawer.getByText(/^不跟着更新：.*A-archived（已归档）.*B-monitor（其他上游账号）.*pure-key（只用 Key）.*Own station（自营站点）$/).waitFor(); await drawer.getByText("用到它的绑定 1 条", { exact: true }).waitFor(); assert.equal(await drawer.getByText(/rule_u04/).count(), 0);
  await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); assert.equal(await drawer.locator('[data-authorization-target]').count(), 3); assert.equal(await drawer.locator('input[type="password"]').count(), 0); assert.equal(await page.evaluate(() => sessionStorage.getItem("account-authorization-recovery-v05")), null);
  assert.deepEqual(originalStations.map((resource) => ({ id: resource.id, userId: resource.userId, costAliases: resource.costAliases, lowBalanceUsd: resource.lowBalanceUsd, cnyPerUsd: resource.cnyPerUsd, includeInProfit: resource.includeInProfit, noRenewal: resource.noRenewal })), before); assert.equal(model.accounts[1].resources[0].authVersion, 1);
});

test("Sub2API JWT and password switches clear hidden authorization and invalidate the previous preview", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[2]);
  const TOKEN = "登录令牌", TYPE = "类型", PASSWORD_TYPE = "Sub2API 账号（邮箱密码）", TOKEN_TYPE = "Sub2API 账号（登录令牌）";
  await drawer.getByLabel(TOKEN, { exact: true }).fill("old-jwt-input"); await previewAuthorization(drawer); await drawer.getByRole("combobox", { name: TYPE, exact: true }).click(); await page.getByText(PASSWORD_TYPE, { exact: true }).last().click(); assert.equal(await authorizationConfirm(drawer).isDisabled(), true);
  await drawer.getByLabel("登录邮箱", { exact: true }).fill("new@example.test"); await drawer.getByLabel("登录密码", { exact: true }).fill("temporary-password"); await previewAuthorization(drawer); assert.equal(probes[1].authorization.accessToken, undefined);
  await drawer.getByRole("combobox", { name: TYPE, exact: true }).click(); await page.getByText(TOKEN_TYPE, { exact: true }).last().click(); assert.equal(await drawer.getByLabel(TOKEN, { exact: true }).inputValue(), ""); await drawer.getByLabel(TOKEN, { exact: true }).fill("new-jwt-input"); await previewAuthorization(drawer); assert.deepEqual(probes[2].authorization, { type: "sub2api", baseUrl: "https://same.test", accessToken: "new-jwt-input" }); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); assert.notEqual(probes[0].requestId, probes[2].requestId);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); await center.locator(`[data-account-key="${model.accounts[2].accountKey}"]`).getByRole("button", { name: `${UPDATE_AUTH} 上游账号 A`, exact: true }).click(); await drawer.getByRole("combobox", { name: TYPE, exact: true }).click(); await page.getByText(PASSWORD_TYPE, { exact: true }).last().click(); assert.equal(await drawer.getByLabel("登录邮箱", { exact: true }).inputValue(), ""); assert.equal(await drawer.getByLabel("登录密码", { exact: true }).inputValue(), ""); await drawer.getByLabel("登录邮箱", { exact: true }).fill("final@example.test"); await drawer.getByLabel("登录密码", { exact: true }).fill("final-password"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.deepEqual(updates[1].authorization, { type: "sub2api-password", baseUrl: "https://same.test", email: "final@example.test", password: "final-password" });
});

test("partial authorization reload uses readonly recovery before a new saved-donor preview and one confirmation", async (t) => {
  // 没更新上的上游按原因归类后显示（lib/error-copy.js），原文进「查看详细原因」
  const failed = describeError({ status: "failed", code: "AUTHORIZATION_UPDATE_FAILED", reason: "保存失败，请稍后重试" });
  const { page, center, model, probes, updates, recoveries } = await openAuthorizationPage(t, { partial: true }); let drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("partial-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer);
  const a2 = drawer.locator('[data-authorization-target="st_u04_a2"]'); await a2.getByText(`A-monitor-2：${failed.text}`, { exact: true }).waitFor(); assert.equal(await a2.locator("details.jy-error-detail").filter({ hasText: failed.raw }).count(), 1);
  await page.reload(); await center.getByRole("button", { name: `查看上次${UPDATE_AUTH}的结果`, exact: true }).click(); drawer = authorizationDialog(page, "42"); await drawer.getByText("A-monitor-1：已更新过，不用再改", { exact: true }).waitFor(); assert.equal(probes.length, 1); assert.equal(updates.length, 1); assert.equal(recoveries.length, 1); assert.deepEqual(recoveries[0], { requestId: probes[0].requestId, targetStationIds: probes[0].targetStationIds });
  await previewAuthorization(drawer, true); assert.equal(probes[1].reuseSavedAuthorization, true); assert.equal(probes[1].authorization, undefined); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a1").authVersion, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a2").authVersion, 2);
});

test("authorization response loss reads saved outcomes without submitting the update again", async (t) => {
  const { page, center, model, updates, recoveries } = await openAuthorizationPage(t, { loseResponse: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("response-loss-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByText("A-billing：已更新过，不用再改", { exact: true }).waitFor(); assert.equal(updates.length, 1); assert.equal(recoveries.length, 1); assert.equal(await page.evaluate(() => sessionStorage.getItem("account-authorization-recovery-v05")), null);
});

test("an invalid saved donor starts a new authorization operation for only unfinished targets", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t, { partial: true, invalidDonor: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("initial-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer);
  // 已保存的登录信息用不了：提示重新填写，原文收在「查看详细原因」
  await drawer.getByRole("button", { name: "重新预览", exact: true }).click(); const refill = alertWithTitle(drawer, REFILL_TITLE("AUTHORIZATION_UNVERIFIED")); await refill.waitFor(); assert.equal(await refill.locator("details.jy-error-detail").filter({ hasText: "已保存授权验证失败" }).count(), 1);
  await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("replacement-pat"); await previewAuthorization(drawer); assert.notEqual(probes[2].requestId, probes[0].requestId); assert.deepEqual(probes[2].targetStationIds, ["st_u04_a2"]); await drawer.getByText(/^已更新，这次不再改：.*A-monitor-1/).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a1").authVersion, 2);
});

test("unknown authorization targets are opt-in and exclusions never count as updated resources", async (t) => {
  const excludedText = describeError({ reason: "账号身份未核验，已排除" }).text;
  const { page, center, model, probes, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); const unknown = drawer.getByRole("checkbox", { name: "更新 unknown-legacy", exact: true }); assert.equal(await unknown.isChecked(), false); await unknown.check(); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("checked-pat"); await previewAuthorization(drawer); assert.equal(probes[0].targetStationIds.includes("st_u04_unknown"), true); await drawer.getByText(`不跟着更新 unknown-legacy：${excludedText}`, { exact: true }).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); await alertTitle(drawer, "有 1 个上游没更新上，已更新的不变").waitFor(); await drawer.locator('[data-authorization-target="st_u04_unknown"]').getByText(`unknown-legacy：${excludedText}`, { exact: true }).waitFor(); assert.equal(await alertTitle(drawer, workflowActionMeta("update_authorization").done).count(), 0);
  await drawer.getByRole("button", { name: "重新填写登录信息", exact: true }).click(); assert.equal(await drawer.getByRole("checkbox", { name: "更新 A-monitor-1", exact: true }).isChecked(), false); assert.equal(await drawer.getByRole("checkbox", { name: "更新 A-monitor-2", exact: true }).isChecked(), false); assert.equal(await drawer.getByRole("checkbox", { name: "更新 A-billing", exact: true }).isChecked(), false); assert.equal(await unknown.isChecked(), false); assert.equal(updates.length, 1);
});

test("authorization from same-site account B cannot update account A and requires a fresh valid preview", async (t) => {
  const { page, center, model, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("account-B"); await drawer.getByRole("button", { name: BINDING_COPY.preview, exact: true }).click();
  const changed = alertWithTitle(drawer, describeError({ code: "ACCOUNT_IDENTITY_CHANGED" }).text); await changed.waitFor(); assert.equal(await changed.locator("details.jy-error-detail").filter({ hasText: "替换授权属于另一个账号，请另行接入" }).count(), 1);
  assert.equal(await authorizationConfirm(drawer).isDisabled(), true); assert.equal(updates.length, 0); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("correct-account-A"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1);
});

test("authorization with no saved donor requests fresh input and a new operation without a preview bypass", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t, { noDonor: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("failed-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer);
  await drawer.getByRole("button", { name: "重新预览", exact: true }).click(); const refill = alertWithTitle(drawer, REFILL_TITLE("SAVED_AUTHORIZATION_UNAVAILABLE")); await refill.waitFor(); assert.equal(await refill.locator("details.jy-error-detail").filter({ hasText: "尚无已确认更新的授权可复用" }).count(), 1); assert.equal(updates.length, 1);
  await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("fresh-pat"); await previewAuthorization(drawer); assert.notEqual(probes[2].requestId, probes[0].requestId); assert.equal(probes[2].targetStationIds.length, 3); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2);
});

test("pause and re-enable retain complete resource settings while stopping one 核算关联 leaves other monitors and history intact", async (t) => {
  const PAUSE = workflowActionMeta("pause_monitor"), RESUMED = workflowActionMeta("resume_monitor"), UNBIND = workflowActionMeta("unbind"), pauseTag = () => resource().locator(".jy-tag").filter({ hasText: exactText(PAUSE.label) });
  const { page, center, model, mutations, originalStations } = await openAuthorizationPage(t); let a = await expandAccount(center, model.accounts[0]); const resource = () => a.locator('[data-resource-id="st_u04_a1"]'); await resource().getByRole("button", { name: `${PAUSE.label} A-monitor-1`, exact: true }).click(); let modal = page.getByRole("dialog", { name: `${PAUSE.label}「A-monitor-1」？`, exact: true }); await modal.getByText("暂停后不再刷新这个上游的余额，随时可以恢复；绑定照常算利润。", { exact: true }).waitFor(); await modal.getByRole("button", { name: `确认${PAUSE.label}`, exact: true }).click(); await modal.waitFor({ state: "hidden" }); await page.reload(); await center.getByText(/^3 个上游账号；/).waitFor(); a = await expandAccount(center, model.accounts[0]); await pauseTag().waitFor(); await resource().getByText("暂停监控时不刷新余额，绑定照常算利润。", { exact: true }).waitFor(); assert.equal(await page.locator(".resource-list-card").getByText("A-monitor-1", { exact: true }).count(), 0);
  await resource().getByRole("button", { name: "编辑上游 A-monitor-1", exact: true }).click(); const editor = page.getByRole("dialog", { name: /^编辑上游：/ }); assert.equal(await editor.getByLabel(CREDENTIAL_FIELDS.userId.label, { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("渠道里用的其他地址", { exact: true }).inputValue(), "kept_alias"); await editor.getByRole("button", { name: /取\s*消/ }).click();
  await resource().getByRole("button", { name: `${RESUMED.label} A-monitor-1`, exact: true }).click(); modal = page.getByRole("dialog", { name: `${RESUMED.label}「A-monitor-1」？`, exact: true }); await waitForFact(modal, "利润", "不算进利润"); await modal.getByRole("button", { name: `确认${RESUMED.label}`, exact: true }).click(); await modal.waitFor({ state: "hidden" }); await resource().getByRole("button", { name: `${PAUSE.label} A-monitor-1`, exact: true }).waitFor(); assert.equal(await pauseTag().count(), 0); assert.equal(originalStations.find((entry) => entry.id === "st_u04_a1").includeInProfit, false);
  // 解除绑定：确认框按 Key、自营站点和空出来的渠道说，不写绑定编号
  await keyRow(a, "Key 9").click(); await a.getByRole("button", { name: `${UNBIND.label} Key 9 · Own station`, exact: true }).click(); modal = page.getByRole("dialog", { name: `${UNBIND.label}？`, exact: true }); await waitForFact(modal, "Key", "Key 9"); await waitForFact(modal, "自营站点", "Own station"); await waitForFact(modal, "解除后空出来的渠道", "Channel 1、Channel 3"); await modal.getByRole("button", { name: `确认${UNBIND.label}`, exact: true }).click(); await modal.waitFor({ state: "hidden" });
  await a.locator('[data-rule-id="rule_u04"]').getByText("已解除绑定", { exact: true }).waitFor(); await a.locator('[data-rule-id="rule_history"]').getByText("已解除绑定", { exact: true }).waitFor(); await keyRow(a, "Key 9").getByText("已解除绑定", { exact: true }).waitFor(); assert.equal(await a.getByRole("button", { name: `${UNBIND.label} Key 9 · Own station`, exact: true }).count(), 0); assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [["PUT", "/api/stations/st_u04_a1"], ["PUT", "/api/stations/st_u04_a1"], ["DELETE", "/api/reconciliation/rules/rule_u04"]]); assert.equal(model.accounts[0].resources.find((entry) => entry.id === "st_u04_a2").monitorEnabled, true); assert.equal(model.accounts[0].keys[0].ruleIds.includes("rule_history"), true); assert.equal(await center.getByRole("button", { name: new RegExp(`${PAUSE.label} Own station`) }).count(), 0);
});

test("authorization target changes invalidate preview and keyboard cancellation works at 320/390/768/1440 without overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, center, model, updates } = await openAuthorizationPage(t, { viewport: { width, height: 900 } }); // 320px 时「预览」按钮正好落在 Next 开发模式左下角的悬浮标记下面（只在开发服务器上有），先把它藏起来
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel(ACCESS_TOKEN, { exact: true }).fill("width-pat"); await previewAuthorization(drawer); const target = drawer.getByRole("checkbox", { name: "更新 A-monitor-2", exact: true }); await target.focus(); await page.keyboard.press("Space"); assert.equal(await authorizationConfirm(drawer).isDisabled(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `authorization overflow at ${width}`); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(updates.length, 0);
  }
});

// 上游账单（account-center.tsx）的写法：上游卡片写「余额提醒线 / 汇率 / 算不算进利润」，绑定写「渠道 / 开始统计 / 这把 Key 还给别处用吗？」，按钮名后跟「Key · 自营站点」
const PAUSE_MONITOR = workflowActionMeta("pause_monitor").label, UNBIND_LABEL = workflowActionMeta("unbind").label, SWAP_LABEL = workflowActionMeta("swap_key").label;
const OWN_CHANNELS_ANSWER = COVERAGE_ANSWERS.find((entry) => entry.value === "own_channels").label, OWNER_UNVERIFIED = reconciliationIssue("COST_OWNER_UNVERIFIED");
const accountCaption = (accounts, unverified, unmatched) => new RegExp(`^${accounts} 个上游账号；${unverified} 个上游还没确认上游账号${unmatched == null ? "" : `；${unmatched} 条绑定还没归到 Key 下`} · `);
test("account center preserves mixed accounts, original resource IDs, dedicated purpose and independent pure Keys", async (t) => {
  const model = accountReadFixture(); model.accounts[1].actions[0].href = "/stations?stationId=B-monitor";
  const { page, center, mutations, probes, writes } = await openAccountsPage(t, { model });
  assert.equal(await center.locator("[data-site-key]").count(), 2); const a = await expandAccount(center, model.accounts[0]), b = await expandAccount(center, model.accounts[1]), sub = await expandAccount(center, model.accounts[2]);
  assert.equal(await a.locator("[data-resource-id]").count(), 3); assert.equal(await b.locator("[data-resource-id='B-monitor']").count(), 1); assert.equal(await sub.locator("[data-resource-id]").count(), 2);
  // 暂停监控的上游：标签「暂停监控」，按钮「编辑上游 名称」；提醒线、汇率、算不算进利润、不再续费写在一行
  const dedicated = a.locator("[data-resource-id='A-billing']"); await dedicated.locator(".jy-tag").filter({ hasText: exactText(PAUSE_MONITOR) }).waitFor(); await dedicated.getByRole("button", { name: "编辑上游 A-billing", exact: true }).waitFor(); assert.equal(await page.locator(".resource-list-card").getByText("A-billing", { exact: true }).count(), 0); await a.getByText(`余额提醒线：$27.00；汇率：${formatRate(0.7)}；不算进利润；不再续费`, { exact: true }).waitFor();
  assert.equal(await a.locator("[data-resource-id='pure-key']").count(), 0); await center.locator("[data-unverified-resource-id='pure-key']").getByText("对上的渠道：Channel 1", { exact: true }).waitFor(); await center.locator("[data-unverified-resource-id='unknown-legacy']").locator(".jy-tag").filter({ hasText: exactText("还没确认上游账号") }).waitFor(); assert.equal(await center.locator("[data-resource-id='own']").count(), 0);
  // 绑定只写渠道、开始统计和「这把 Key 还给别处用吗？」的回答；没答完整时补「利润先不算」，不再显示范围版本
  await keyRow(a, "Key 9").click(); const active = a.locator('[data-rule-id="A-active"]'); await waitForFact(active, "渠道", "Channel 1、Channel 3"); await waitForFact(active, COVERAGE_QUESTION, `${OWN_CHANNELS_ANSWER}：Channel 2；利润先不算`); assert.equal(await active.locator("dt").filter({ hasText: /范围版本/ }).count(), 0);
  const history = a.locator('[data-rule-id="A-history"]'); await history.getByText("已解除绑定", { exact: true }).waitFor(); assert.equal(await history.getByRole("button").count(), 0); assert.ok(await active.evaluate((node) => node.compareDocumentPosition(document.querySelector('[data-rule-id="A-history"]')) & Node.DOCUMENT_POSITION_FOLLOWING));
  await keyRow(a, "Key 10").click(); await keyRow(a, "Key 10").getByText("已解除绑定", { exact: true }).waitFor(); await waitForFact(a.locator('[data-rule-id="A-stopped"]'), "渠道", "Channel 2"); assert.equal(await a.getByRole("button", { name: `${EDIT_BINDING} Key 10 · Own station`, exact: true }).count(), 0);
  await page.getByRole("button", { name: "显示归档的上游", exact: true }).click(); await a.locator("[data-resource-id='A-archived']").waitFor(); assert.doesNotMatch(await center.innerText(), /余额合计|总余额|\$30\.00/);
  // 自营站点不进上游账单，仍在上游列表里
  await page.getByRole("tab", { name: STATION_TABS.list, exact: true }).click(); await page.locator(".jy-stations-flag").filter({ hasText: exactText("自营站点") }).first().waitFor(); await page.getByRole("tab", { name: STATION_TABS.bills, exact: true }).click(); await center.waitFor();
  const destinations = [
    { scope: a, label: UPDATE_AUTH, params: { action: "authorization", accountKey: model.accounts[0].accountKey } },
    { scope: a, label: workflowActionMeta("confirm_coverage").label, params: { action: "coverage", ruleId: "A-active" } },
    { scope: b, label: workflowActionMeta("inspect_balance").label, params: { stationId: "B-monitor" } },
    { scope: center.locator("[data-unverified-resource-id='pure-key']"), label: CONNECT, params: { action: "connect", ownStationId: "own", channelIds: "1" } },
    { scope: center.locator("[data-unverified-resource-id='unknown-legacy']"), label: TEST_READ, params: { action: "verify", stationId: "unknown-legacy" } },
  ];
  const allowedHrefs = [];
  for (const { scope, label, params } of destinations) {
    const href = await scope.getByRole("link", { name: label, exact: true }).getAttribute("href"), target = new URL(href, baseURL);
    assert.equal(target.origin, new URL(baseURL).origin); assert.equal(target.pathname, "/stations"); assert.deepEqual(Object.fromEntries(target.searchParams), params); allowedHrefs.push(href);
  }
  assert.deepEqual((await center.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")))).sort(), allowedHrefs.sort());
  // 「换 Key」只在在用的绑定上，走渠道绑定里回答「这把 Key 还给别处用吗？」的流程
  for (const id of ["A-history", "A-stopped"]) assert.equal(await a.locator(`[data-rule-id="${id}"]`).getByRole("button", { name: new RegExp(`^${SWAP_LABEL} `) }).count(), 0);
  await a.getByRole("button", { name: `${SWAP_LABEL} Key 9 · Own station`, exact: true }).click(); await page.getByRole("tab", { name: STATION_TABS.onboarding, selected: true }).waitFor();
  assert.equal(mutations.length, 0); assert.equal(probes.length, 0); assert.equal(writes.length, 0);
});

// 同一页里两把 Key 同名时（§3.1）：名字后面都加上编号，按钮也按带编号的名字点
test("same-name Keys in one account list both carry their Key number", async (t) => {
  const model = accountReadFixture(); model.accounts[0].keys[1].tokenName = "Key 9";
  const { center, mutations } = await openAccountsPage(t, { model }); const a = await expandAccount(center, model.accounts[0]);
  await keyRow(a, "Key 9（Key #9）").waitFor(); await keyRow(a, "Key 9（Key #10）").waitFor(); assert.equal(await keyRow(a, "Key 9").count(), 0);
  await keyRow(a, "Key 9（Key #9）").click(); await a.getByRole("button", { name: `${EDIT_BINDING} Key 9（Key #9） · Own station`, exact: true }).waitFor();
  await keyRow(a, "Key 9（Key #10）").click(); await keyRow(a, "Key 9（Key #10）").getByText("已解除绑定", { exact: true }).waitFor(); await waitForFact(a.locator('[data-rule-id="A-stopped"]'), "渠道", "Channel 2");
  assert.equal(mutations.length, 0);
});

test("account search and attention filters preserve relationships and open only the original complete editor object", async (t) => {
  const search = (center) => center.getByRole("textbox", { name: `搜索${STATION_TABS.bills}` });
  const { page, center, model, mutations } = await openAccountsPage(t); await search(center).fill("A-monitor-1"); await center.getByText(accountCaption(1, 0)).waitFor(); const a = await expandAccount(center, model.accounts[0]);
  await a.getByRole("button", { name: "编辑上游 A-monitor-1", exact: true }).click(); const editor = page.getByRole("dialog", { name: /^编辑上游：/ }); await editor.waitFor(); assert.equal(await editor.getByLabel(CREDENTIAL_FIELDS.userId.label, { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("渠道里用的其他地址", { exact: true }).inputValue(), "kept_alias"); await editor.getByRole("button", { name: /取\s*消/ }).click(); await editor.waitFor({ state: "hidden" });
  await search(center).fill("Sub-password"); const sub = await expandAccount(center, model.accounts[2]); await sub.getByRole("button", { name: "编辑上游 Sub-password", exact: true }).click(); await editor.waitFor(); assert.equal(await editor.getByLabel("登录邮箱", { exact: true }).inputValue(), "saved-sub@example.test"); await editor.getByRole("button", { name: /取\s*消/ }).click(); await editor.waitFor({ state: "hidden" });
  await search(center).fill("Key 10"); await expandAccount(center, model.accounts[0]); await keyRow(a, "Key 10").click(); await a.getByText("Channel 2", { exact: true }).waitFor(); assert.equal(await a.locator("[data-resource-id]").count(), 3);
  await search(center).fill(""); await center.getByRole("combobox", { name: "筛选上游账号" }).click(); await page.getByText("需处理", { exact: true }).last().click(); await center.getByText(accountCaption(1, 2)).waitFor(); assert.equal(await center.getByRole("button", { name: /账号 B / }).count(), 0);
  await search(center).fill("pure-key"); await center.getByText(accountCaption(0, 1)).waitFor(); await center.locator("[data-unverified-resource-id='pure-key']").waitFor(); assert.equal(mutations.length, 0);
});

test("duplicate ownership deep link expands both active 核算关联 and never shows one scope as unified", async (t) => {
  const model = accountReadFixture(), key = model.accounts[0].keys[0]; Object.assign(key, { activeRuleIds: ["A-active", "A-conflict"], ruleIds: ["A-active", "A-conflict", "A-history"], scopeAmbiguous: true, costCoverage: "unknown", coverageDeclaration: { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] }, scopeVersion: null, billingEffectiveFromMs: null, firstQueryableAtMs: null }); key.channels.push({ ownSource: null, ownStationId: "old-own", channelId: 1, name: "Legacy channel 1" });
  Object.assign(key.associations[0], { conflict: true, conflictRuleIds: ["A-conflict"], keyConflictRuleIds: ["A-conflict"], channelConflictRuleIds: [], duplicateChannelIds: [] }); key.associations.splice(1, 0, { ...key.associations[0], ruleId: "A-conflict", ownStationId: "old-own", scopeVersion: 1, channels: [{ channelId: 1, name: "Legacy channel 1" }], conflictRuleIds: ["A-active"], keyConflictRuleIds: ["A-active"] });
  const { center } = await openAccountsPage(t, { model, path: "/stations?action=conflict&ruleId=A-conflict" }); const a = center.locator(`[data-account-key="${model.accounts[0].accountKey}"]`), scope = a.locator(`[data-canonical-key="${key.canonicalKey}"]`);
  await keyRow(a, "Key 9").locator(".jy-tag").filter({ hasText: exactText("需处理") }).waitFor();
  // 两条重复的绑定都标「需处理」，各写「这把 Key 绑了两次」和对方是哪条（按 Key 和自营站点说；自营站点已不在时写「—」，不写编号）
  const first = scope.locator('[data-rule-id="A-active"]'), second = scope.locator('[data-rule-id="A-conflict"]');
  for (const [binding, other] of [[first, `Key 9 · 自营站点 ${EMPTY}`], [second, "Key 9 · 自营站点 Own station"]]) {
    await binding.locator(".jy-tag").filter({ hasText: exactText("需处理") }).waitFor(); const banner = binding.locator(".jy-banner");
    await banner.locator("p").filter({ hasText: exactText(`${KEY_TWICE.title}：${KEY_TWICE.detail}`) }).waitFor(); assert.equal(await banner.getByText(/同时绑了两把 Key/).count(), 0); await banner.getByText(`和它重复的：${other}`, { exact: true }).waitFor();
  }
  await second.locator("b").filter({ hasText: exactText(`自营站点 ${EMPTY}`) }).waitFor(); await waitForFact(second, "渠道", "Legacy channel 1"); assert.match(await second.getAttribute("class"), /is-focused/); assert.doesNotMatch(await first.getAttribute("class"), /is-focused/);
  // 开始统计 / 解除时间只按绑定各自显示，Key 头上不给一个合并后的时间
  assert.equal(await scope.locator("dt").filter({ hasText: exactText("开始统计") }).count(), 2); assert.equal(await scope.locator("dt").filter({ hasText: exactText("解除时间") }).count(), 1); assert.equal(await scope.locator("[data-rule-id]").count(), 3);
  assert.doesNotMatch(await keyRow(a, "Key 9").innerText(), /开始统计|解除时间|范围/);
  for (const [binding, target] of [[first, "Key 9 · Own station"], [second, `Key 9 · ${EMPTY}`]]) { await binding.getByRole("button", { name: `${EDIT_BINDING} ${target}`, exact: true }).waitFor(); await binding.getByRole("button", { name: `${UNBIND_LABEL} ${target}`, exact: true }).waitFor(); }
  const history = scope.locator('[data-rule-id="A-history"]'); assert.equal(await history.getByText("需处理").count(), 0); assert.equal(await history.locator(".jy-banner").count(), 0);
});

test("active 核算关联 outside verified Keys stay listed with their reason, verification link and a working stop", async (t) => {
  const model = accountReadFixture(), base = model.accounts[0].keys[0].associations[0];
  Object.assign(base, { conflict: true, conflictRuleIds: ["U-legacy"], keyConflictRuleIds: [], channelConflictRuleIds: ["U-legacy"], duplicateChannelIds: [3] });
  const unmatched = (ruleId, extra) => ({ ...base, ruleId, scopeVersion: 1, conflict: false, conflictRuleIds: [], keyConflictRuleIds: [], channelConflictRuleIds: [], duplicateChannelIds: [], ...extra });
  model.unmatchedAssociations = [
    unmatched("U-gone", { upstreamStationId: "deleted-station", channels: [{ channelId: 4, name: "Channel 4" }], reason: "missing_resource", tokenId: 5, tokenName: "Gone Key" }),
    unmatched("U-legacy", { upstreamStationId: "unknown-legacy", channels: [{ channelId: 3, name: "Channel 3" }], conflict: true, conflictRuleIds: ["A-active"], channelConflictRuleIds: ["A-active"], duplicateChannelIds: [3], reason: "unverified_resource", tokenId: 9, tokenName: "Legacy Key" }),
  ];
  const { page, center, mutations } = await openAccountsPage(t, { model, path: "/stations?action=conflict&ruleId=A-active", mutation(route, mutation) {
    assert.deepEqual([mutation.method, mutation.path], ["DELETE", "/api/reconciliation/rules/U-gone"]); model.unmatchedAssociations = model.unmatchedAssociations.filter((item) => item.ruleId !== "U-gone"); return fulfill(route, { ok: true });
  } });
  // 冲突的另一方不在任何 Key 下：不按上游账号筛选，两边都看得到
  await center.getByText(accountCaption(3, 2, 2)).waitFor();
  const section = center.locator("[data-unmatched-associations]"), legacy = section.locator('[data-rule-id="U-legacy"]'), gone = section.locator('[data-rule-id="U-gone"]'), channelTwice = fillIssueCopy(CHANNEL_TWICE.title, CHANNEL_TWICE.plain, { channel: "Channel 3" });
  const active = center.locator(`[data-account-key="${model.accounts[0].accountKey}"] [data-rule-id="A-active"]`); await active.locator(".jy-banner p").filter({ hasText: exactText(`${channelTwice}：${CHANNEL_TWICE.detail}`) }).waitFor(); await active.getByText("和它重复的：Legacy Key · 自营站点 Own station", { exact: true }).waitFor(); assert.match(await active.getAttribute("class"), /is-focused/);
  await legacy.locator("b").filter({ hasText: exactText("Legacy Key") }).waitFor(); await legacy.locator(".jy-tag").filter({ hasText: exactText("需处理") }).waitFor(); await legacy.getByText(`${OWNER_UNVERIFIED.title}：${OWNER_UNVERIFIED.detail}`, { exact: true }).waitFor();
  await legacy.locator(".jy-banner p").filter({ hasText: exactText(`${channelTwice}：${CHANNEL_TWICE.detail}`) }).waitFor(); await legacy.getByText("和它重复的：Key 9 · 自营站点 Own station", { exact: true }).waitFor();
  await waitForFact(legacy, "上游", "unknown-legacy"); await waitForFact(legacy, "自营站点", "Own station"); await waitForFact(legacy, "渠道", "Channel 3");
  assert.equal(await legacy.getByRole("link", { name: TEST_READ, exact: true }).getAttribute("href"), "/stations?action=verify&stationId=unknown-legacy");
  // 上游已删除：写「找不到这个上游：…请解除绑定」，上游一栏写「—」，不给处理链接，只能解除绑定
  await gone.getByText(`${ERROR_CATEGORIES.not_found.text}：上游已删除，这条绑定读不到上游成本，请解除绑定`, { exact: true }).waitFor(); await waitForFact(gone, "上游", EMPTY); assert.equal(await gone.getByRole("link").count(), 0);
  await center.getByRole("textbox", { name: `搜索${STATION_TABS.bills}` }).fill("Gone Key"); await center.getByText(accountCaption(0, 0, 1)).waitFor(); assert.equal(await legacy.count(), 0);
  await gone.getByRole("button", { name: `${UNBIND_LABEL} Gone Key · Own station`, exact: true }).click(); const modal = page.getByRole("dialog", { name: `${UNBIND_LABEL}？`, exact: true });
  await waitForFact(modal, "Key", "Gone Key"); await waitForFact(modal, "自营站点", "Own station"); await waitForFact(modal, "解除后空出来的渠道", "Channel 4"); await modal.getByRole("button", { name: `确认${UNBIND_LABEL}`, exact: true }).click(); await modal.waitFor({ state: "hidden" });
  await gone.waitFor({ state: "detached" }); await center.getByRole("textbox", { name: `搜索${STATION_TABS.bills}` }).fill(""); await legacy.waitFor(); await center.getByText(accountCaption(3, 2, 1)).waitFor(); assert.equal(await section.locator("[data-rule-id]").count(), 1);
  assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [["DELETE", "/api/reconciliation/rules/U-gone"]]);
});

test("account read failure retains the last public relationships and retry restores the center", async (t) => {
  const { center, model, accountRequests, mutations } = await openAccountsPage(t, { accounts(route, count, model) { return count === 2 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "上游账单暂不可用" }) }) : fulfill(route, model); } });
  // 刷新没读到：写「刷新失败，数据截至 …。」和归类后的原因，上次读到的上游账号照常列出；横幅里的「刷新」再读一次
  await center.getByRole("button", { name: REFRESH, exact: true }).click(); const banner = center.locator(".jy-banner[role=alert]"); await banner.locator("b").filter({ hasText: exactText(refreshFailedText(model.generatedAt)) }).waitFor(); await banner.getByText(describeError(Object.assign(new Error("上游账单暂不可用"), { status: 503 })).text, { exact: true }).waitFor(); await banner.locator("details.jy-error-detail").filter({ hasText: "上游账单暂不可用" }).waitFor();
  await center.getByRole("button", { name: /账号 B / }).waitFor(); await center.getByRole("button", { name: `${REFRESH}${STATION_TABS.bills}`, exact: true }).click(); await banner.waitFor({ state: "hidden" }); assert.deepEqual(accountRequests, ["GET", "GET", "GET"]); assert.equal(mutations.length, 0);
});

test("an initial account read failure offers a working retry without affecting original monitoring resources", async (t) => {
  const { page, center, accountRequests } = await openAccountsPage(t, { initialFailure: true, accounts(route, count, model) { return count === 1 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "上游账单暂不可用" }) }) : fulfill(route, model); } });
  await center.locator(".jy-banner[role=alert] b").filter({ hasText: exactText(`读不到${STATION_TABS.bills}：${describeError(Object.assign(new Error("上游账单暂不可用"), { status: 503 })).text}。`) }).waitFor();
  // 上游列表照常可用
  await page.getByRole("tab", { name: STATION_TABS.list, exact: true }).click(); await page.locator(".jy-stations-flag").filter({ hasText: exactText("自营站点") }).first().waitFor(); await page.getByRole("tab", { name: STATION_TABS.bills, exact: true }).click();
  await center.getByRole("button", { name: `${REFRESH}${STATION_TABS.bills}`, exact: true }).click(); await center.getByText(/^3 个上游账号；/).waitFor(); assert.deepEqual(accountRequests, ["GET", "GET"]);
});

test("account and Key expansion works by keyboard across 320/390/768/1440 widths without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, center, model } = await openAccountsPage(t, { viewport: { width, height: 900 } }); const site = center.locator(`[data-site-key="${model.accounts[0].siteKey}"]`), accountButton = site.getByRole("button", { name: /账号 A / }); await accountButton.focus(); await page.keyboard.press("Enter"); const a = center.locator(`[data-account-key="${model.accounts[0].accountKey}"]`); await a.waitFor(); const keyButton = keyRow(a, "Key 9"); await keyButton.focus(); await page.keyboard.press("Enter"); await a.getByText("Channel 1、Channel 3", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `account center overflow at ${width}`); await keyButton.focus(); await page.keyboard.press("Enter"); await a.getByText("Channel 1、Channel 3", { exact: true }).waitFor({ state: "hidden" });
  }
});

function confirmedHistoryRecord(id = "saved-oct8", profit = 1) {
  const window = { preset: "yesterday", startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z"), timezone: "Asia/Shanghai" };
  const side = (amount) => ({ state: "complete", quotaUnits: amount * 100, quotaPerUnit: 100, amountUsd: amount, knownAmountUsd: amount, countedAmountUsd: null, successfulCount: 1, expectedCount: 1, observedAt: null, window });
  const channels = [1, 2, 3].map((channelId) => ({ channelId, name: "old-" + channelId }));
  return { historyId: id, confirmedAt: "2026-10-08T16:01:00.000Z", window, ownSource: { stationId: "old-own", provider: "newapi", baseUrl: "https://old-own.test", accountId: "11", namespaceKey: "old-own-namespace" }, upstreamSource: { provider: "newapi", baseUrl: "https://old-up.test", accountId: "7", tokenId: 9, tokenName: "old-name" }, scopeVersion: 1, scopeFingerprint: "old-scope", billingEffectiveFromMs: window.startMs, channels, amountBasis: { id: "channel-billing-usd-v3", currency: "USD", billingSource: "channel-log-stat", calculationVersion: 3, conversion: "quota_per_unit" }, upstream: side(2), downstream: { ...side(2 + profit), channels: channels.map((channel) => ({ ...channel, billingState: "complete", quotaUnits: 100, amountUsd: 1, knownAmountUsd: 1 })) }, calculation: { differenceUsd: profit, profitUsd: profit, riskDifferenceUsd: null, marginRate: profit / (2 + profit) }, sourceCompleteness: "complete" };
}
async function openConfirmedHistoryPage(t, options = {}) {
  const current = rule("rule-1", "Rule A", 10); Object.assign(current.rule, { enabled: true, archivedAt: null, scopeVersion: 2, tokenId: 99, channels: [{ channelId: 9, name: "New channel 9" }] });
  if (options.groupHistory) current.transitionSegments = [{ id: "seg-old", group: "g1", ratio: 1, effectiveFrom: 1000, effectiveTo: 1500 }, { id: "seg-new", group: "g2", ratio: 2, effectiveFrom: 1500, effectiveTo: null }];
  const archived = { ...current.rule, id: "old-rule", tokenName: "new-name", enabled: false, archivedAt: "2026-10-09T00:00:00Z" }, reads = [], historyReads = [], queries = [];
  const records = options.records || [confirmedHistoryRecord()];
  const page = await openFixturePage(t, async (route) => {
    const request = route.request(), url = new URL(request.url()); reads.push({ path: url.pathname, method: request.method(), params: Object.fromEntries(url.searchParams) });
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, { ...configuration, ...(options.upstreams ? { upstreams: options.upstreams } : {}), ownStation: current.rule.archivedAt && options.removeOwnAfterStop ? null : { ...configuration.ownStation, cnyPerUsd: options.rate || null }, rules: [current.rule, archived].filter((rule) => !rule.archivedAt || url.searchParams.get("includeArchived") === "true") });
    if (url.pathname === "/api/reconciliation" || url.pathname === "/api/reconciliation/query") { if (request.method() === "POST") { const body = request.postDataJSON(); queries.push(body); assert.ok(!body.ruleIds?.some((id) => id === archived.id || current.rule.archivedAt && id === current.rule.id)); } return fulfill(route, response(current.rule.archivedAt ? [] : [current])); }
    if (url.pathname.endsWith("/segments")) return fulfill(route, { segments: current.transitionSegments || [] });
    if (url.pathname.endsWith("/confirmed")) { assert.equal(request.method(), "GET"); historyReads.push({ ruleId: url.pathname.split("/").at(-2), params: Object.fromEntries(url.searchParams) }); return options.history ? options.history(route, historyReads.at(-1), historyReads.length) : fulfill(route, { ruleId: historyReads.at(-1).ruleId, readOnly: true, records, nextCursor: null }); }
    throw new Error("unexpected confirmed history fixture API: " + url.pathname);
  }, options.viewport);
  const badge = page.getByRole("button", { name: "Collapse issues badge", exact: true }); if (await badge.isVisible()) await badge.click();
  // 核算页只读：停止核算在上游账单完成，这里只模拟它已发生
  const stopElsewhere = () => Object.assign(current.rule, { enabled: false, archivedAt: "2026-10-09T00:00:00Z" });
  return { page, reads, historyReads, queries, records, stopElsewhere };
}
// 以前的每日记录（recon-history.tsx）：抽屉标题和入口按钮都是「以前的每日记录」，绑定下拉写「Key · 上游 · 在用 / 已解除绑定」
const HISTORY = workflowActionMeta("open_history").label, HISTORY_UPSTREAM = configuration.upstreams[0].name;
const historyOption = (key, ended = false) => `${key} · ${HISTORY_UPSTREAM} · ${ended ? "已解除绑定" : "在用"}`;
const historyCount = (n) => `${n} 条每日记录 · 按美元显示。只列每天的记录，以前的数据还在。`;
const HISTORY_FIXED_NOTE = `这个上游现在计入固定成本；没标「${FIXED_COST_TEXT}」的日子是当时按用量算的上游成本，不改。`;
// 记录里没有 Key 名称和 ID 时写「—」，不拿现在的绑定去补
const historyKey = (record) => record.upstreamSource.tokenName || (record.upstreamSource.tokenId != null ? `Key #${record.upstreamSource.tokenId}` : EMPTY);
async function chooseConfirmedHistoryRule(page, drawer, label = historyOption("Rule A")) { await drawer.getByRole("combobox", { name: "绑定", exact: true }).click(); await page.getByText(label, { exact: true }).last().click(); }
async function expandConfirmedRecord(drawer, record, compact = false) { const button = compact ? drawer.getByRole("button", { name: new RegExp(` · ${historyKey(record).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first() : drawer.locator(`tr.ant-table-row[data-row-key="${record.historyId}"]`); await button.focus(); await drawer.page().keyboard.press("Enter"); return drawer.locator(`[data-history-id="${record.historyId}"]`); }
// 展开的记录里一项：左边名称，右边写法（Detail，recon-parts.tsx）
async function historyFact(record, label, value) { await record.locator(".reconciliation-detail").filter({ has: record.page().locator(".reconciliation-detail__label").filter({ hasText: exactText(label) }) }).locator(".reconciliation-detail__value").filter({ hasText: exactText(value) }).first().waitFor(); }

test("confirmed history shows the Oct8 time, Key and channels it was fixed with, not current channel 9 or source details", async (t) => {
  const { page, reads, historyReads, records } = await openConfirmedHistoryPage(t, { groupHistory: true }); const summary = page.locator(".reconciliation-summary"), before = await summary.innerText(); const row = page.locator("tr.ant-table-row", { hasText: "Rule A" }).first(); await row.focus(); await page.keyboard.press("Enter"); await page.getByRole("region", { name: "Rule A 的倍率变化", exact: true }).getByText("倍率变化 · 1 次", { exact: true }).waitFor(); await row.getByRole("button", { name: "查看 Rule A 的计算明细", exact: true }).click(); const detail = page.getByRole("dialog", { name: "Rule A · 计算明细", exact: true }); await detail.getByRole("region", { name: "各渠道收入", exact: true }).getByText("New channel 9", { exact: true }).waitFor(); await detail.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); const record = await expandConfirmedRecord(drawer, records[0]); await drawer.locator(`tr.ant-table-row[data-row-key="${records[0].historyId}"]`).getByText("old-1、old-2、old-3", { exact: true }).waitFor(); await historyFact(record, "时间", formatZonedWindow(records[0].window)); await historyFact(record, "Key", "old-name"); await record.getByText("来自自营站点 3 个渠道的收费记录", { exact: true }).waitFor();
  // A1：来源（平台、地址、账号、namespace）和范围版本不再上页面（§11）
  assert.doesNotMatch(await record.innerText(), /New channel 9|new-name|范围版本|old-own|old-up\.test|newapi|namespace/); assert.equal(await summary.innerText(), before); assert.deepEqual(historyReads[0], { ruleId: "rule-1", params: { limit: "20" } }); assert.ok(reads.some((read) => read.params.includeArchived === "true")); assert.ok(historyReads.every((read) => read.params.limit === "20"));
});

test("confirmed history remains discoverable after stopping and reload even without an own station", async (t) => {
  const { page, reads, historyReads, stopElsewhere } = await openConfirmedHistoryPage(t, { removeOwnAfterStop: true }); stopElsewhere(); await page.reload(); await page.getByText(OWN_STATION_UNSET_TITLE, { exact: true }).waitFor(); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(page, drawer, historyOption("Rule A", true)); await drawer.getByText(historyCount(1), { exact: true }).waitFor(); assert.equal(reads.filter((read) => read.method !== "GET" && read.path !== "/api/reconciliation/query").length, 0); assert.equal(historyReads.length, 1); assert.ok(reads.some((read) => read.params.includeArchived === "true")); assert.ok(reads.filter((read) => read.path.endsWith("/confirmed")).every((read) => read.method === "GET"));
});

test("confirmed history keeps zero and negative original profit and labels incomplete legacy evidence without filling current identity", async (t) => {
  const zero = confirmedHistoryRecord("zero", 0), negative = confirmedHistoryRecord("negative", -1), legacy = confirmedHistoryRecord("legacy"); zero.upstreamSource.tokenName = "old-zero"; negative.upstreamSource.tokenName = "old-negative"; Object.assign(legacy, { ownSource: null, scopeVersion: null, scopeFingerprint: null, billingEffectiveFromMs: null, sourceCompleteness: "legacy_partial" }); legacy.window.timezone = null; legacy.upstreamSource = { provider: null, baseUrl: null, accountId: null, tokenId: null, tokenName: null };
  const { page } = await openConfirmedHistoryPage(t, { records: [zero, negative, legacy], rate: 7 }); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(page, drawer); await drawer.locator("tr.ant-table-row", { hasText: "old-zero" }).getByText("$0.00", { exact: true }).waitFor(); await drawer.locator("tr.ant-table-row", { hasText: "old-negative" }).getByText(`${MINUS}$1.00`, { exact: true }).waitFor();
  // 早期记录缺来源和时区：行上和展开后都写「这天的数据不完整」；没记下的 Key 写「—」，不拿现在的绑定去补
  await drawer.locator(`tr.ant-table-row[data-row-key="${legacy.historyId}"]`).getByText(INCOMPLETE_DAY_TEXT, { exact: true }).waitFor(); const record = await expandConfirmedRecord(drawer, legacy); await record.getByText(INCOMPLETE_DAY_TEXT, { exact: true }).waitFor(); await historyFact(record, "Key", EMPTY); await historyFact(record, "汇率", EMPTY); assert.doesNotMatch(await record.innerText(), /Fixture upstream|upstream-1|New channel 9|Rule A|new-name|¥/);
});

test("3b confirmed history for a fixed-purchase upstream keeps the original Key-usage cost and explains today's zero cost", async (t) => {
  const note = HISTORY_FIXED_NOTE;
  const fixed = await openConfirmedHistoryPage(t, { upstreams: configuration.upstreams.map((station) => ({ ...station, costBasis: "fixed" })) });
  await fixed.page.getByRole("button", { name: HISTORY, exact: true }).click(); let drawer = fixed.page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(fixed.page, drawer);
  await drawer.getByText(note, { exact: true }).waitFor(); await drawer.locator("tr.ant-table-row", { hasText: "old-name" }).getByText("$2.00", { exact: true }).waitFor(); await drawer.locator("tr.ant-table-row", { hasText: "old-name" }).getByText("$1.00", { exact: true }).waitFor();
  const usage = await openConfirmedHistoryPage(t, { upstreams: configuration.upstreams.map((station) => ({ ...station, costBasis: "usage" })) });
  await usage.page.getByRole("button", { name: HISTORY, exact: true }).click(); drawer = usage.page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(usage.page, drawer);
  await drawer.getByText(historyCount(1), { exact: true }).waitFor(); assert.equal(await drawer.getByText(note, { exact: true }).count(), 0);
});

test("4a ledger history shows each record's settle-time cost basis, revision and rates; the fixed note only covers Key-usage records", async (t) => {
  const note = HISTORY_FIXED_NOTE, fixedUpstreams = configuration.upstreams.map((station) => ({ ...station, costBasis: "fixed" }));
  const fixed = { ...confirmedHistoryRecord("ledger-fixed", 3), billDate: "2026-10-08", revision: 2, settlementSource: "resettle", settledRates: { income: 7.1, cost: null }, costBasis: "fixed" }; fixed.upstreamSource = { ...fixed.upstreamSource, tokenName: "fixed-key" };
  const migrated = { ...confirmedHistoryRecord("ledger-migrated"), billDate: "2026-10-07", revision: 1, settlementSource: "migrated", settledRates: { income: null, cost: null }, costBasis: null }; migrated.upstreamSource = { ...migrated.upstreamSource, tokenName: "migrated-key" };
  const mixed = await openConfirmedHistoryPage(t, { records: [fixed, migrated], upstreams: fixedUpstreams });
  await mixed.page.getByRole("button", { name: HISTORY, exact: true }).click(); let drawer = mixed.page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(mixed.page, drawer);
  await drawer.getByText(note, { exact: true }).waitFor(); const fixedRow = drawer.locator("tr.ant-table-row", { hasText: "fixed-key" }), migratedRow = drawer.locator("tr.ant-table-row", { hasText: "migrated-key" });
  // 固定时计入固定成本的那天：上游成本一格写「计入固定成本」，不写金额（§3.2）；重新固定过的写「改过 N 次」（§4）
  await fixedRow.getByText(FIXED_COST_TEXT, { exact: true }).waitFor(); assert.equal(await fixedRow.getByText("$2.00", { exact: true }).count(), 0); assert.equal(await fixedRow.getByText("$0.00", { exact: true }).count(), 0); await fixedRow.getByText("改过 1 次", { exact: true }).waitFor(); await fixedRow.getByText("$3.00", { exact: true }).waitFor();
  // 以前的数据（迁移的旧账）按用量算，没改过，不加说明
  await migratedRow.getByText("$2.00", { exact: true }).waitFor(); assert.equal(await migratedRow.getByText(FIXED_COST_TEXT).count(), 0); assert.equal(await migratedRow.getByText(/改过/).count(), 0);
  let record = await expandConfirmedRecord(drawer, fixed); await historyFact(record, "收入", "$5.00来自自营站点 3 个渠道的收费记录"); await historyFact(record, "上游成本", FIXED_COST_TEXT); await historyFact(record, "毛利", "$3.00"); await historyFact(record, "改过", "改过 1 次"); await historyFact(record, "汇率", `${formatRate(7.1)}，${formatZonedDateTime(fixed.confirmedAt, fixed.window.timezone)} 固定时记下`); assert.doesNotMatch(await record.innerText(), /\$2\.00/);
  record = await expandConfirmedRecord(drawer, migrated); await historyFact(record, "收入", "$3.00来自自营站点 3 个渠道的收费记录"); await historyFact(record, "上游成本", "$2.00"); await historyFact(record, "毛利", "$1.00"); await historyFact(record, "汇率", EMPTY); assert.doesNotMatch(await record.innerText(), new RegExp(`成本计法|未设置|改过|${FIXED_COST_TEXT}`));
  const onlyFixed = await openConfirmedHistoryPage(t, { records: [fixed], upstreams: fixedUpstreams });
  await onlyFixed.page.getByRole("button", { name: HISTORY, exact: true }).click(); drawer = onlyFixed.page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(onlyFixed.page, drawer);
  await drawer.getByText(historyCount(1), { exact: true }).waitFor(); assert.equal(await drawer.getByText(note, { exact: true }).count(), 0, "全是计入固定成本的日子时不需要说明");
});

test("confirmed history pagination failure retains read records and retry reuses the opaque cursor without duplicate history", async (t) => {
  const first = confirmedHistoryRecord(), second = confirmedHistoryRecord("saved-negative", -1), cursor = Buffer.from(JSON.stringify([first.window.endMs, "2026-10-08 16:01:01", "old-bill-z"])).toString("base64url"); let failed = false;
  const { page, historyReads } = await openConfirmedHistoryPage(t, { history(route, read) { if (read.params.cursor && !failed) { failed = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "HISTORY_UNAVAILABLE", error: "确认账单历史暂不可用", retryable: true }) }); } return fulfill(route, { ruleId: read.ruleId, readOnly: true, records: read.params.cursor ? [second] : [first], nextCursor: read.params.cursor ? null : cursor }); } }); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); const before = Date.now(); await chooseConfirmedHistoryRule(page, drawer); await drawer.getByText(historyCount(1), { exact: true }).waitFor(); const after = Date.now(); await drawer.getByRole("button", { name: "加载更多", exact: true }).click();
  // 已经读到一页时，失败写「刷新失败，数据截至 …」（上一次读到的时间），原因收在「查看详细原因」里；刷新按原 cursor 再读一次
  const failure = drawer.locator(".ant-alert", { has: page.locator("details.jy-error-detail") }); await failure.waitFor(); assert.ok([refreshFailedText(before), refreshFailedText(after)].includes(await failure.locator(".ant-alert-title").innerText()), await failure.locator(".ant-alert-title").innerText()); assert.equal(await failure.getByText("确认账单历史暂不可用", { exact: true }).count(), 1); assert.equal(await drawer.locator("tr.ant-table-row").count(), 1); await failure.getByRole("button", { name: REFRESH, exact: true }).click(); await drawer.getByText(historyCount(2), { exact: true }).waitFor(); assert.deepEqual(historyReads[1], historyReads[2]); assert.equal(historyReads[2].params.cursor, cursor); assert.equal(await drawer.getByRole("button", { name: "加载更多", exact: true }).count(), 0);
});

test("confirmed history rule changes ignore a late response from the previous rule", async (t) => {
  let deferred, ready; const started = new Promise((resolve) => { ready = resolve; }); const original = confirmedHistoryRecord(), other = confirmedHistoryRecord("other-rule"); other.upstreamSource.tokenName = "saved-other-rule";
  const { page } = await openConfirmedHistoryPage(t, { history(route, read) { if (read.ruleId === "rule-1") return new Promise((resolve) => { deferred = { route, resolve }; ready(); }); return fulfill(route, { ruleId: read.ruleId, readOnly: true, records: [other], nextCursor: null }); } }); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(page, drawer); await started; await chooseConfirmedHistoryRule(page, drawer, historyOption("new-name", true)); await drawer.locator("tr.ant-table-row", { hasText: "saved-other-rule" }).waitFor(); deferred.resolve(fulfill(deferred.route, { ruleId: "rule-1", readOnly: true, records: [original], nextCursor: null })); await page.waitForResponse((response) => response.url().includes("/rule-1/confirmed")); assert.equal(await drawer.locator("tr.ant-table-row", { hasText: "old-name" }).count(), 0);
});

test("confirmed history selector and record expansion support keyboard at 320/390/768/1440 without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, records } = await openConfirmedHistoryPage(t, { viewport: { width, height: 900 } }); const entry = page.getByRole("button", { name: HISTORY, exact: true }); await entry.focus(); await page.keyboard.press("Enter"); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }), select = drawer.getByRole("combobox", { name: "绑定", exact: true }); await drawer.waitFor(); await page.waitForFunction(() => !document.querySelector(".ant-drawer-open .ant-drawer-content-wrapper")?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")); await select.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await drawer.getByText(historyCount(1), { exact: true }).waitFor(); const record = await expandConfirmedRecord(drawer, records[0], width < 768); await historyFact(record, "Key", "old-name"); await page.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `confirmed history overflow at ${width}`); if (width < 768) assert.equal(await drawer.locator(".ant-drawer-body").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `confirmed history drawer overflow at ${width}`); await drawer.locator(".ant-drawer-close").focus(); await page.keyboard.press("Enter"); await drawer.waitFor({ state: "hidden" });
  }
});

test("two rule retries retain both independently returned amounts", async (t) => {
  const deferred = new Map();
  const requestStarted = new Map();
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (url.pathname === "/api/reconciliation") return fulfill(route, initial);
    if (url.pathname === "/api/reconciliation/query") {
      const { ruleIds } = route.request().postDataJSON();
      if (ruleIds?.[0]) return new Promise((resolve) => {
        deferred.set(ruleIds[0], { route, resolve });
        requestStarted.get(ruleIds[0])();
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  });

  const rowA = page.locator("tr", { hasText: "Rule A" });
  const rowB = page.locator("tr", { hasText: "Rule B" });
  await rowA.getByText("$10.00", { exact: true }).waitFor();
  await rowB.getByText("$20.00", { exact: true }).waitFor();
  const retryAStarted = new Promise((resolve) => requestStarted.set("rule-1", resolve));
  const retryBStarted = new Promise((resolve) => requestStarted.set("rule-2", resolve));
  await rowA.getByRole("button", { name: `${RETRY} Rule A`, exact: true }).click();
  await rowB.getByRole("button", { name: `${RETRY} Rule B`, exact: true }).click();
  await retryAStarted;
  await retryBStarted;
  deferred.get("rule-1").resolve(fulfill(deferred.get("rule-1").route, cachedResponse(initial, [rule("rule-1", "Rule A", 101)])));
  await page.locator("tr", { hasText: "$101.00" }).waitFor();
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, cachedResponse(initial, [rule("rule-2", "Rule B", 41)])));
  await page.locator("tr", { hasText: "$41.00" }).waitFor();
});

// 同一日期范围刷新时，列表和汇总都还是上次读到的、彼此对得上，汇总照旧显示、不加「读取中」；新数据回来后一起换掉
test("a same-preset refresh keeps old totals beside the old rows until its replacement arrives", async (t) => {
  let deferred;
  let startQuery;
  const queryStarted = new Promise((resolve) => { startQuery = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (url.pathname === "/api/reconciliation") return fulfill(route, initial);
    if (url.pathname === "/api/reconciliation/query") return new Promise((resolve) => { deferred = { route, resolve }; startQuery(); });
    return fulfill(route, { message: "unexpected API request" });
  });

  await page.locator("tr", { hasText: "$10.00" }).waitFor();
  const summary = page.locator(".reconciliation-summary");
  await summary.getByText("$60.00", { exact: true }).waitFor();
  await summary.getByText("$57.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前页面数据" }).click();
  await queryStarted;
  await page.locator("tr", { hasText: "$10.00" }).waitFor();
  await summary.getByText("$57.00", { exact: true }).waitFor();
  assert.equal(await summary.locator(".ant-alert").count(), 0); assert.equal(await summary.getByText("$63.00", { exact: true }).count(), 0);
  deferred.resolve(fulfill(deferred.route, response([rule("rule-1", "Rule A", 11), rule("rule-2", "Rule B", 21), rule("rule-3", "Rule C", 31)])));
  await summary.getByText("$63.00", { exact: true }).waitFor();
  await page.locator("tr", { hasText: "$11.00" }).waitFor();
  assert.equal(await summary.getByText("$57.00", { exact: true }).count(), 0); assert.equal(await summary.locator(".ant-alert").count(), 0);
});

test("a later retry may finish before an earlier retry without losing either result", async (t) => {
  const deferred = new Map();
  const started = new Map();
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const id = route.request().postDataJSON().ruleIds?.[0];
      return new Promise((resolve) => { deferred.set(id, { route, resolve }); started.get(id)(); });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const readyA = new Promise((resolve) => started.set("rule-1", resolve));
  const readyB = new Promise((resolve) => started.set("rule-2", resolve));
  await page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: `${RETRY} Rule A`, exact: true }).click();
  await page.locator("tr", { hasText: "Rule B" }).getByRole("button", { name: `${RETRY} Rule B`, exact: true }).click();
  await Promise.all([readyA, readyB]);
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, cachedResponse(initial, [rule("rule-2", "Rule B", 42)])));
  await page.locator("tr", { hasText: "$42.00" }).waitFor();
  deferred.get("rule-1").resolve(fulfill(deferred.get("rule-1").route, cachedResponse(initial, [rule("rule-1", "Rule A", 102)])));
  await page.locator("tr", { hasText: "$102.00" }).waitFor();
});

test("one failed retry leaves another rule's successful result and controls usable", async (t) => {
  const deferred = new Map();
  const started = new Map();
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const id = route.request().postDataJSON().ruleIds?.[0];
      return new Promise((resolve) => { deferred.set(id, { route, resolve }); started.get(id)(); });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const readyA = new Promise((resolve) => started.set("rule-1", resolve));
  const readyB = new Promise((resolve) => started.set("rule-2", resolve));
  const rowA = page.locator("tr", { hasText: "Rule A" });
  const rowB = page.locator("tr", { hasText: "Rule B" });
  const retryAButton = rowA.getByRole("button", { name: `${RETRY} Rule A`, exact: true });
  const retryBButton = rowB.getByRole("button", { name: `${RETRY} Rule B`, exact: true });
  await retryAButton.click();
  await retryBButton.click();
  await Promise.all([readyA, readyB]);
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, cachedResponse(initial, [rule("rule-2", "Rule B", 43)])));
  await rowB.getByText("$43.00", { exact: true }).waitFor();
  await retryBButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  deferred.get("rule-1").resolve(deferred.get("rule-1").route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture retry failure" }) }));
  // 行里写「重新读取没完成，请稍后再试」（recon-format.ts RETRY_FAILED_TEXT，§8.1），原文收在「查看详细原因」里
  const failure = rowA.locator("details.jy-error-detail", { has: page.getByText("fixture retry failure", { exact: true }) });
  await failure.waitFor();
  assert.equal(await failure.evaluate((node) => node.parentElement.firstChild.textContent), RETRY_FAILED);
  await rowB.getByText("$43.00", { exact: true }).waitFor();
  assert.equal(await retryAButton.isDisabled(), false); assert.equal(await retryBButton.isDisabled(), false);
});

test("a late single-rule response from an old window cannot replace a newer window", async (t) => {
  const oldWindow = window;
  const newWindow = { preset: "7d", startMs: 10, endMs: 2000, timezone: "Asia/Shanghai" };
  const deferred = {};
  const started = {};
  const initial = response([rule("rule-1", "Rule A", 10, oldWindow), rule("rule-2", "Rule B", 20, oldWindow), rule("rule-3", "Rule C", 30, oldWindow)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const body = route.request().postDataJSON();
      const key = body.ruleIds?.[0] ? "oldRetry" : "newWindow";
      return new Promise((resolve) => { deferred[key] = { route, resolve }; started[key](); });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const oldRetryStarted = new Promise((resolve) => { started.oldRetry = resolve; });
  const newWindowStarted = new Promise((resolve) => { started.newWindow = resolve; });
  const retryAButton = page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: `${RETRY} Rule A`, exact: true });
  await retryAButton.click();
  await oldRetryStarted;
  await page.getByRole("group", { name: "时间范围", exact: true }).getByRole("button", { name: "近 7 天", exact: true }).filter({ visible: true }).click();
  await newWindowStarted;
  deferred.newWindow.resolve(fulfill(deferred.newWindow.route, response([rule("rule-1", "Rule A", 70, newWindow), rule("rule-2", "Rule B", 80, newWindow), rule("rule-3", "Rule C", 90, newWindow)])));
  await page.locator("tr", { hasText: "$70.00" }).waitFor();
  await retryAButton.locator(".ant-btn-loading-icon").waitFor();
  deferred.oldRetry.resolve(fulfill(deferred.oldRetry.route, response([rule("rule-1", "Rule A", 101, oldWindow)])));
  await retryAButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  await page.locator("tr", { hasText: "$70.00" }).waitFor();
  await page.locator("tr", { hasText: "$101.00" }).waitFor({ state: "hidden" });
});

test("a bulk response replaces a newer retry when their actual windows differ", async (t) => {
  const bulkWindow = { preset: "yesterday", startMs: window.endMs, endMs: window.endMs + 86400000, timezone: "Asia/Shanghai" };
  let bulk;
  let retry;
  let resolveBulkStarted;
  let resolveRetryStarted;
  const bulkStarted = new Promise((resolve) => { resolveBulkStarted = resolve; });
  const retryStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const isRetry = Boolean(route.request().postDataJSON().ruleIds?.[0]);
      return new Promise((resolve) => {
        if (isRetry) { retry = { route, resolve }; resolveRetryStarted(); }
        else { bulk = { route, resolve }; resolveBulkStarted(); }
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const summary = page.locator(".reconciliation-summary");
  await summary.getByText("$60.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前页面数据" }).click();
  await bulkStarted;
  await page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: `${RETRY} Rule A`, exact: true }).click();
  await retryStarted;
  const retryDelivery = fulfill(retry.route, cachedResponse(initial, [rule("rule-1", "Rule A", 101)]));
  retry.resolve(retryDelivery);
  await retryDelivery;
  await page.locator("tr", { hasText: "$101.00" }).waitFor();
  bulk.resolve(fulfill(bulk.route, response([rule("rule-1", "Rule A", 70, bulkWindow), rule("rule-2", "Rule B", 80, bulkWindow), rule("rule-3", "Rule C", 90, bulkWindow)])));
  await page.locator("tr", { hasText: "$70.00" }).waitFor();
  await page.locator("tr", { hasText: "$101.00" }).waitFor({ state: "hidden" });
  await summary.getByText("$240.00", { exact: true }).waitFor();
});

test("a late bulk response for the same window preserves a newer rule retry", async (t) => {
  let bulk;
  let retry;
  let resolveBulkStarted;
  let resolveRetryStarted;
  const bulkStarted = new Promise((resolve) => { resolveBulkStarted = resolve; });
  const retryStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const isRetry = Boolean(route.request().postDataJSON().ruleIds?.[0]);
      return new Promise((resolve) => {
        if (isRetry) { retry = { route, resolve }; resolveRetryStarted(); }
        else { bulk = { route, resolve }; resolveBulkStarted(); }
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  });
  const rowA = page.locator("tr", { hasText: "Rule A" });
  const retryAButton = rowA.getByRole("button", { name: `${RETRY} Rule A`, exact: true });
  const summary = page.locator(".reconciliation-summary");
  await page.getByRole("button", { name: "刷新当前页面数据" }).click();
  await bulkStarted;
  await retryAButton.click();
  await retryStarted;
  retry.resolve(fulfill(retry.route, cachedResponse(initial, [rule("rule-1", "Rule A", 101)])));
  await rowA.getByText("$101.00", { exact: true }).waitFor();
  bulk.resolve(fulfill(bulk.route, response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)])));
  await retryAButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  await rowA.getByText("$101.00", { exact: true }).waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor();
});

async function verifyMobileRefreshAndRetry(t, width) {
  let retry;
  let refresh;
  let resolveRetryStarted;
  let resolveRefreshStarted;
  const retryRequestStarted = new Promise((resolve) => { resolveRetryStarted = resolve; });
  const refreshRequestStarted = new Promise((resolve) => { resolveRefreshStarted = resolve; });
  const initial = response([rule("rule-1", "Rule A", 10), rule("rule-2", "Rule B", 20), rule("rule-3", "Rule C", 30)]);
  const page = await openFixturePage(t, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (pathname === "/api/reconciliation") return fulfill(route, initial);
    if (pathname === "/api/reconciliation/query") {
      const target = route.request().postDataJSON().ruleIds?.[0] ? "retry" : "refresh";
      return new Promise((resolve) => {
        if (target === "retry") { retry = { route, resolve }; resolveRetryStarted(); }
        else { refresh = { route, resolve }; resolveRefreshStarted(); }
      });
    }
    return fulfill(route, { message: "unexpected API request" });
  }, { width, height: 844 });
  const cardA = page.locator(".reconciliation-mobile-item", { hasText: "Rule A" });
  const summary = page.locator(".reconciliation-summary");
  await cardA.waitFor();
  if (!(await cardA.textContent())?.includes("$10.00")) throw new Error(`unexpected mobile card: ${await cardA.textContent()}`);
  await cardA.getByRole("button", { name: `${RETRY} Rule A`, exact: true }).click();
  await retryRequestStarted;
  retry.resolve(fulfill(retry.route, cachedResponse(initial, [rule("rule-1", "Rule A", 101)])));
  await cardA.getByText("$101.00").waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前页面数据" }).click();
  await refreshRequestStarted;
  // 同一日期范围刷新时卡片和汇总都还是上次读到的、彼此对得上，汇总照旧显示、不加「读取中」
  await cardA.getByText("$101.00").waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor();
  assert.equal(await summary.locator(".ant-alert").count(), 0);
  refresh.resolve(fulfill(refresh.route, response([rule("rule-1", "Rule A", 11), rule("rule-2", "Rule B", 21), rule("rule-3", "Rule C", 31)])));
  await cardA.getByText("$11.00").waitFor();
  await summary.getByText("$63.00", { exact: true }).waitFor();
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)) throw new Error(`${width}px document root overflows horizontally`);
}

test("390px mobile refresh and retry remain usable without root overflow", async (t) => {
  await verifyMobileRefreshAndRetry(t, 390);
});

test("320px mobile refresh and retry remain usable without root overflow", async (t) => {
  await verifyMobileRefreshAndRetry(t, 320);
});

test("本月 queries the month window, live windows poll read-only on their own cadence, and a pending 自定义 pauses polling", async (t) => {
  const reads = [], queries = [];
  // 浏览器时钟被快进后，响应的取数时刻跟着走，免得「数据截至」被判成过期而换掉提示文案
  let skewMs = 0;
  const fresh = (preset) => ({ ...response([rule("rule-1", "Rule A", 10, { ...window, preset }), rule("rule-2", "Rule B", 20, { ...window, preset }), rule("rule-3", "Rule C", 30, { ...window, preset })]), generatedAt: new Date(Date.now() + skewMs).toISOString() });
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, configuration);
    if (url.pathname === "/api/reconciliation") { const params = Object.fromEntries(url.searchParams); reads.push(params); return fulfill(route, fresh(params.preset)); }
    if (url.pathname === "/api/reconciliation/query") { const body = route.request().postDataJSON(); queries.push(body); return fulfill(route, fresh(body.preset)); }
    throw new Error("unexpected API: " + url.pathname);
  }, undefined, true);
  const advance = async (ms) => { skewMs += ms; await page.clock.fastForward(ms); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const presets = page.getByRole("group", { name: "时间范围", exact: true });
  const freshness = (title) => page.locator(`.jy-freshness[title="${title}"]`).waitFor();

  // 昨天是已结束的窗口，不轮询
  await freshness("当前时间范围不自动刷新，可点右侧刷新");
  assert.deepEqual(reads, [{ preset: "yesterday" }]);
  await advance(310000); await settle();
  assert.equal(reads.length, 1); assert.equal(queries.length, 0);

  // 本月点选即查，只读（不带 observe）；之后 5 分钟重读一次
  await presets.getByRole("button", { name: "本月", exact: true }).filter({ visible: true }).click();
  await freshness("数据每 5 分钟自动刷新");
  assert.deepEqual(queries, [{ preset: "month" }]);
  await advance(290000); await settle();
  assert.equal(reads.length, 1);
  await advance(20000); await settle();
  assert.deepEqual(reads.slice(1), [{ preset: "month" }]);

  // 选了自定义还没查询：仍显示本月的数据，标明当前显示的窗口，暂停轮询
  await presets.getByRole("button", { name: "自定义", exact: true }).filter({ visible: true }).click();
  await page.getByText(/^当前显示：/).waitFor();
  await freshness("当前时间范围不自动刷新，可点右侧刷新");
  await advance(310000); await settle();
  assert.equal(reads.length, 2); assert.equal(queries.length, 1);

  // 今天 30 秒重读一次
  await presets.getByRole("button", { name: "今天", exact: true }).filter({ visible: true }).click();
  await freshness("数据每 30 秒自动刷新");
  assert.deepEqual(queries.at(-1), { preset: "today" });
  await advance(31000); await settle();
  assert.deepEqual(reads.slice(2), [{ preset: "today" }]);
  assert.equal(queries.length, 2);
});

test("上游编辑页的 Esc 先收起展开的日期面板，再交给抽屉关闭", async (t) => {
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "fixed", label: "固定成本", needs: [] }, { value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    // 侧栏待办计数读昨天的账单
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    throw new Error("unexpected API: " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  await page.getByText(NO_UPSTREAM_TEXT, { exact: true }).waitFor();
  await page.getByRole("button", { name: UPSTREAM_FORM_TEXT.create, exact: true }).first().click();
  const drawer = page.getByRole("dialog", { name: UPSTREAM_FORM_TEXT.create, exact: true });
  await drawer.waitFor();
  await drawer.getByRole("button", { name: "再记一笔", exact: true }).click();
  await drawer.getByRole("group", { name: "第 2 笔固定成本记录", exact: true }).getByPlaceholder("开始日期").click();
  const panel = page.locator(".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)");
  await panel.waitFor();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  // A zero-size appear frame can look hidden before the picker has actually closed.
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".ant-picker-dropdown")).every((node) =>
    node.classList.contains("ant-picker-dropdown-hidden") || Array.from(node.classList).some((name) => name.endsWith("-leave"))));
  assert.equal(await drawer.isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "放弃修改", exact: true }).count(), 0);
  // 第二次 Esc 交给抽屉：有没保存的固定成本记录，先确认是否放弃
  await page.keyboard.press("Escape");
  const discard = page.getByRole("button", { name: "放弃修改", exact: true });
  await discard.waitFor();
  assert.equal(await drawer.isVisible(), true);
  await discard.click();
  await drawer.waitFor({ state: "hidden" });
});

test("上游列表一行两行字：没有「数据截至」一列，只在数据旧的那一行写；状态格只放状态，要处理的事在行末，编辑挪进「⋯」", async (t) => {
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  // 刷新间隔 30 秒：比最新的那个旧 60 秒以上才算旧。45 秒的不算（门槛写成 1 倍会抓到），90 秒的算（间隔写死 60 会抓到）
  const station = (id, name, readAt, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, cnyPerUsd: 7,
    balance: { ok: true, remaining: 100, account: `${id}-account`, checkedAt: iso(readAt) }, prediction: { etaDays: 30, burnPerDay: 3, basis: "近 3 小时" },
    spark: [[now - 7200000, 103], [now, 100]], ...extra });
  const stations = [
    station("st-fresh", "Fresh 上游", now),
    station("st-near", "Near 上游", now - 45000),
    station("st-stale", "Stale 上游", now - 90000),
    // 读不到余额的那一行下面另有一行说原因，状态格不再标「数据截至」
    station("st-broken", "Broken 上游", now - 3600000, { balance: { ok: false, error: "HTTP 401: invalid token", code: "AUTHENTICATION_FAILED", checkedAt: iso(now - 3600000) } }),
    // 没有小图的行：金额和有小图的行上下对齐
    station("st-nospark", "NoSpark 上游", now, { spark: [] }),
    // 名字很长又有两个标签：还是两行字，名字省略
    station("st-long", "一个名字特别特别特别特别特别特别特别长的上游（演示）", now, { demo: true, includeInProfit: false }),
    // 有档位又有两件事：状态格「余额偏低 · 还有 1 件」，下一行是第一件事的标题，不是档位说明
    station("st-todo", "Todo 上游", now, { balance: { ok: true, remaining: 2, account: "todo-account", checkedAt: iso(now) } }),
    // 只有事、没有档位：「需处理」，排在正常的行前面
    station("st-only", "Only 上游", now),
  ];
  const action = (kind, stationId) => ({ id: `${kind}:${stationId}`, kind, label: TEST_READ, title: reconciliationIssue(kind === "verify_identity" ? "COST_OWNER_UNVERIFIED" : "UPSTREAM_CAPABILITY_UNVERIFIED").title, detail: "",
    href: `/stations?action=${kind === "verify_identity" ? "verify" : "verify-billing"}&stationId=${stationId}`, stationId });
  const actions = [action("verify_identity", "st-todo"), action("verify_capability", "st-todo"), action("verify_identity", "st-only")];
  const handler = async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations, settings: { refreshIntervalSec: 30, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {}, settings: { refreshIntervalSec: 30, lowBalanceUsd: 5 } });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions });
    throw new Error("unexpected API: " + path);
  };
  const accounts = (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: iso(now) });
  const page = await openFixturePage(t, handler, undefined, false, accounts, "/stations");
  const table = page.locator(".jy-stations-table");
  const row = (name) => table.locator("tbody tr", { hasText: name }).first();
  const status = (name) => row(name).locator("td").nth(1);
  const AS_OF = /^数据截至 (\d{1,2}月\d{1,2}日 )?\d{1,2}:\d{2}$/;
  await row("Only 上游").waitFor();
  // 列：上游、状态、余额、日均花费、可用天数、操作；没有「数据截至」
  assert.deepEqual((await table.locator("thead th").allInnerTexts()).map((x) => x.trim()), ["上游", "状态", "余额", "日均花费", "可用天数", "操作"]);
  // 一行两行字：行高 56 以内，长名字加两个标签也一样；地址和账号名在名称下面同一行
  for (const name of ["Fresh 上游", "Stale 上游", "Todo 上游", "Only 上游", "NoSpark 上游", "一个名字特别"]) { const h = (await row(name).boundingBox()).height; assert.ok(h <= 56, `${name} 一行不超过 56 高（${h}）`); }
  await row("Fresh 上游").getByText("st-fresh.test · st-fresh-account", { exact: true }).waitFor();
  // 有小图、没有小图的行，金额右边对齐
  const right = async (name) => { const box = await row(name).locator(".jy-stations-money").boundingBox(); return Math.round(box.x + box.width); };
  assert.equal(await right("NoSpark 上游"), await right("Fresh 上游"));
  const amountX = async (name) => row(name).locator(".jy-stations-money").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el.lastChild); return Math.round(r.getBoundingClientRect().left); });
  assert.equal(await amountX("NoSpark 上游"), await amountX("Fresh 上游"));
  // 按哪段花费估的只在悬停和读屏里
  assert.equal(await row("Fresh 上游").locator(`[title="${basisText("近 3 小时")}"]`).count(), 1);
  assert.equal(await row("Fresh 上游").locator(".sr-only").filter({ hasText: basisText("近 3 小时") }).count(), 1);
  // 数据旧：只比别的上游里最新的那个旧两轮刷新以上的才写；读不到余额的行不写
  for (const name of ["Fresh 上游", "Near 上游"]) assert.equal(await status(name).getByText(/数据截至/).count(), 0, name);
  await status("Stale 上游").getByText(AS_OF).waitFor();
  assert.equal(await status("Broken 上游").getByText(/数据截至/).count(), 0);
  // 有档位又有两件事：状态格「余额偏低 · 还有 1 件」，下一行是第一件事的标题；不放链接、按钮
  await status("Todo 上游").getByText(`${BALANCE_STATE_TEXT.low} · 还有 1 件`, { exact: true }).waitFor();
  await status("Todo 上游").getByText(actions[0].title, { exact: true }).waitFor();
  assert.equal(await status("Todo 上游").getByRole("button").count(), 0);
  // 只有事：「需处理」，排在正常的行前面
  await status("Only 上游").getByText("需处理", { exact: true }).waitFor();
  const order = (await table.locator("tbody tr .jy-res-name button.link").allInnerTexts());
  assert.ok(order.indexOf("Only 上游") < order.indexOf("Fresh 上游"), order.join(","));
  // 行末是第一件事的按钮，键盘也能按；「编辑」挪进「⋯」，第二件事在「⋯」最上面写「按钮名：标题」
  const todo = row("Todo 上游");
  const lead = todo.getByRole("button", { name: `${TEST_READ}（Todo 上游）`, exact: true });
  assert.equal(await todo.getByRole("button", { name: "编辑 Todo 上游", exact: true }).count(), 0);
  await todo.getByRole("button", { name: "Todo 上游 的更多操作", exact: true }).focus(); await page.keyboard.press("Enter");
  const items = page.getByRole("menuitem");
  await items.first().waitFor();
  assert.equal((await items.first().innerText()).trim(), `${TEST_READ}：${actions[1].title}`);
  await page.getByRole("menuitem", { name: "编辑", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  // 行末的按钮在本页打开那件事（测试读取的抽屉），不跳页
  await lead.focus(); await page.keyboard.press("Enter");
  const verifying = page.getByRole("dialog", { name: new RegExp(`^${TEST_READ}`) }); await verifying.waitFor();
  await page.keyboard.press("Escape"); await verifying.waitFor({ state: "hidden" });
  // 点名称打开编辑；读屏多一句「点名称打开编辑」，不和行末的「编辑 上游名」重名
  const name = row("Fresh 上游").getByRole("button", { name: "Fresh 上游", exact: true });
  assert.equal(await name.getAttribute("aria-describedby"), "stations-edit-hint");
  await page.locator("#stations-edit-hint").getByText("点名称打开编辑", { exact: true }).waitFor({ state: "attached" });
  await name.click(); await page.getByRole("dialog", { name: /Fresh 上游/ }).waitFor();
  await page.keyboard.press("Escape");
  // 没有要处理的事的行，行末照旧是「编辑」
  await row("Fresh 上游").getByRole("button", { name: "编辑 Fresh 上游", exact: true }).waitFor();

  // 手机上一张卡片两行：名称、状态、「⋯」；余额 · 可用天数。有要处理的事时多一行：标题和按钮。小图、刷新、编辑都在「⋯」里
  const mobile = await openFixturePage(t, handler, { width: 390, height: 844 }, false, accounts, "/stations");
  const card = (name) => mobile.locator(".jy-stations-m li", { hasText: name }).first();
  await card("Only 上游").getByRole("button", { name: `${TEST_READ}（Only 上游）`, exact: true }).waitFor();
  assert.ok((await card("Fresh 上游").boundingBox()).height <= 90, "没有事的卡片两行");
  for (const name of ["Only 上游", "Todo 上游"]) assert.ok((await card(name).boundingBox()).height <= 120, `${name} 的卡片三行`);
  await card("Only 上游").getByText(actions[2].title, { exact: true }).waitFor();
  assert.equal(await card("Fresh 上游").getByRole("button", { name: REFRESH }).count(), 0);
  assert.equal(await card("Fresh 上游").locator(".jy-spark-btn").count(), 0);
  // 数据旧又有余额、可用天数：可以折成三行，不再多
  await card("Stale 上游").getByText(AS_OF).waitFor();
  assert.ok((await card("Stale 上游").boundingBox()).height <= 110, "最多三行");
  await card("Fresh 上游").getByRole("button", { name: "Fresh 上游 的更多操作", exact: true }).click();
  for (const item of ["编辑", REFRESH, "余额趋势"]) await mobile.getByRole("menuitem", { name: item, exact: true }).waitFor();
});

test("上游列表手机卡片：没设置汇率时余额照写「（没设置汇率）」，不让人当成人民币；设了汇率只写金额", async (t) => {
  const now = Date.now();
  const station = (id, name, cnyPerUsd) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, cnyPerUsd,
    balance: { ok: true, remaining: 12.3, checkedAt: new Date(now).toISOString() }, prediction: { etaDays: 30, burnPerDay: 0.4, basis: "近 3 小时" }, spark: [] });
  const mobile = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [station("st-unset", "Unset 上游", null), station("st-set", "Set 上游", 7.2)], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {}, settings: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    throw new Error("unexpected API: " + path);
  }, { width: 390, height: 844 }, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: new Date(now).toISOString() }), "/stations");
  const card = (name) => mobile.locator(".jy-stations-m li", { hasText: name }).first();
  await card("Unset 上游").getByText(`${formatMoney(12.3)}（没设置汇率）`, { exact: true }).waitFor();
  await card("Set 上游").getByText("$12.30", { exact: true }).waitFor();
});

test("删除上游要输入这个上游的名字：不一致时按钮不能点、回车也不删，一致后才发出删除", async (t) => {
  const deletes = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations/del-1" && method === "DELETE") { deletes.push({ query: url.search, body: route.request().postDataJSON() }); return fulfill(route, { ok: true }); }
    if (path === "/api/stations") return fulfill(route, { stations: deletes.length ? [] : [{ id: "del-1", name: "Alpha 上游", type: "newapi", baseUrl: "https://alpha.test", monitorEnabled: true, balance: { ok: true, remaining: 10, checkedAt: "2026-10-09T07:00:00.000Z" }, prediction: null, spark: [] }], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  await page.getByRole("button", { name: "Alpha 上游 的更多操作", exact: true }).first().click();
  await page.getByRole("menuitem", { name: `${workflowActionMeta("delete_upstream").label}…` }).click();
  const dialog = page.getByRole("dialog", { name: `${workflowActionMeta("delete_upstream").label}「Alpha 上游」？`, exact: true });
  await dialog.waitFor();
  const input = dialog.getByLabel(`输入「Alpha 上游」确认${workflowActionMeta("delete_upstream").label}`, { exact: true });
  const ok = dialog.getByRole("button", { name: workflowActionMeta("delete_upstream").label, exact: true });
  assert.equal(await ok.isDisabled(), true);
  // 以前要输入 DELETE；现在输入名字，DELETE 和只输一半都不算
  for (const typed of ["DELETE", "Alpha"]) {
    await input.fill(typed);
    assert.equal(await ok.isDisabled(), true);
    await input.press("Enter");
  }
  assert.equal(deletes.length, 0);
  // 前后空格不算；回车和点按钮一样
  await input.fill("  Alpha 上游 ");
  assert.equal(await ok.isEnabled(), true);
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(deletes, [{ query: "?purge=true", body: { confirm: "DELETE" } }]);
  await page.getByText(NO_UPSTREAM_TEXT, { exact: true }).waitFor();
});

const BUSINESS_TZ = "Asia/Shanghai";
const shanghaiDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const shiftDay = (key, n) => { const d = new Date(key + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 成本估算的接口数据：按真实的今天往前排，一个按用量计费的上游每天都有记录
function costAnalyticsFixture(days) {
  const end = shanghaiDay(Date.now()), start = shiftDay(end, -(days - 1)), dates = Array.from({ length: days }, (_, i) => shiftDay(start, i));
  return { days, start, end, tz: BUSINESS_TZ, generatedAt: new Date().toISOString(), selection: { includeArchived: false, stationCount: 1, archivedStationCount: 0 },
    coverage: { earliestDate: start, latestDate: end, availableDays: days, requestedDays: days, monitoredStationCount: 1, isComplete: true, stationGaps: [] },
    stations: [{ id: "up-a", name: "Fixture upstream", type: "newapi", cnyPerUsd: 7, totalCny: days * 10, fixedCny: 0, runway: { etaDays: 5, burnPerDay: 1, basis: "近 3 小时" } }],
    daily: dates.map((date) => ({ stationId: "up-a", date, cny: 10 })), fixedDaily: [], heatmap: [], heatmapAvailable: true, heatmapAvailability: { available: days <= 30, reason: days <= 30 ? null : "range-not-supported", coverage: null } };
}
// 成本估算的可用天数用上游列表的余额和提醒线判断档位（balanceViewOf）：默认余额在提醒线以上、约 5 天，和接口的可用天数一致
const costStationsFixture = (balance = { ok: true, remaining: 30 }, prediction = { etaDays: 5, burnPerDay: 1 }) => ({ stations: [{ id: "up-a", name: "Fixture upstream", type: "newapi", cnyPerUsd: 7, monitorEnabled: true, balance, prediction, spark: [] }], settings: { lowBalanceUsd: 5 } });
async function openCostPage(t, own, path = "/analytics", { stations = costStationsFixture(), meta = (route) => fulfill(route, { rules: { etaDays: 3 }, settings: { lowBalanceUsd: 5 } }), analytics = costAnalyticsFixture } = {}) {
  const ownReads = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/stations") return fulfill(route, stations);
    if (url.pathname === "/api/meta") return meta(route);
    if (url.pathname === "/api/analytics") return fulfill(route, analytics(Number(url.searchParams.get("days")) || 30));
    if (url.pathname === "/api/own/analytics") { ownReads.push(url.searchParams.get("range")); return own(route); }
    throw new Error("unexpected cost fixture API: " + url.pathname);
  }, undefined, false, null, path);
  await page.getByText(ANALYTICS_COPY.sourceTitle, { exact: true }).waitFor();
  return { page, ownReads, equation: page.getByRole("region", { name: ANALYTICS_COPY.eqTitle, exact: true }) };
}
const failJSON = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

test("成本估算：「数字怎么来的」「没算进去的数据」默认收起，只露一行结论；点按钮或页里「查看没算进去的数据」才展开", async (t) => {
  const own = (route) => failJSON(route, 400, { error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" });
  // 最早的 3 天上游一条记录都没有：页里会出「查看没算进去的数据」，没算进去的数据那句写「3 天没有记录」
  const analytics = (days) => {
    const f = costAnalyticsFixture(days); f.daily = f.daily.slice(3); const earliestDate = f.daily[0].date;
    f.coverage = { ...f.coverage, earliestDate, availableDays: days - 3, isComplete: false, stationGaps: [{ stationId: "up-a", stationName: "Fixture upstream", availableDays: days - 3, missingDays: 3, earliestDate }] };
    return f;
  };
  const { page } = await openCostPage(t, own, "/analytics", { analytics });
  // 页顶只露一句（ui-copy-spec §8.4），长说明在按钮后面
  await page.getByText(ANALYTICS_COPY.sourceShort, { exact: true }).waitFor();
  assert.equal(await page.getByText(ANALYTICS_COPY.sourceBody, { exact: true }).count(), 0);
  const source = page.getByRole("button", { name: ANALYTICS_COPY.sourceTitle, exact: true });
  assert.equal(await source.getAttribute("aria-expanded"), "false"); await source.click();
  assert.equal(await source.getAttribute("aria-expanded"), "true");
  await page.getByText(ANALYTICS_COPY.sourceBody, { exact: true }).waitFor();
  await source.click(); assert.equal(await page.getByText(ANALYTICS_COPY.sourceBody, { exact: true }).count(), 0);
  // 没算进去的数据：结论一句和按钮在同一行，规则和明细在「哪些天、哪些上游缺记录」后面
  const coverage = page.locator("#analytics-coverage");
  const details = coverage.getByRole("button", { name: ANALYTICS_COPY.coverageCaption, exact: true });
  const lead = coverage.getByText(ANALYTICS_COPY.leadGaps(ANALYTICS_COPY.leadMissingDays(3), 3), { exact: true });
  await lead.waitFor(); await details.waitFor();
  const [leadBox, buttonBox] = [await lead.boundingBox(), await details.boundingBox()];
  assert.ok(Math.abs(leadBox.y + leadBox.height - (buttonBox.y + buttonBox.height)) < 8, "结论和按钮在同一行");
  assert.equal(await coverage.locator("dl").count(), 0); assert.equal(await coverage.getByText(ANALYTICS_COPY.gapRule).count(), 0);
  await details.click(); await coverage.locator("dl").getByText(ANALYTICS_COPY.kvRange, { exact: true }).waitFor();
  await coverage.getByText(ANALYTICS_COPY.gapRule, { exact: true }).waitFor();
  await details.click(); assert.equal(await coverage.locator("dl").count(), 0);
  // 点页里真的「查看没算进去的数据」：展开并滚过去；收起后再点同一个链接也展开（地址栏的 # 没变）
  const link = page.getByRole("link", { name: ANALYTICS_COPY.coverageLink, exact: true }).first();
  await link.click(); await coverage.locator("dl").waitFor(); assert.equal(await details.getAttribute("aria-expanded"), "true");
  await details.click(); assert.equal(await coverage.locator("dl").count(), 0);
  await link.scrollIntoViewIfNeeded(); await link.click(); await coverage.locator("dl").waitFor();
  // 带着 #analytics-coverage 刷新：那一块等数据读回来才出现，出现后展开并滚到它
  await page.reload(); await coverage.locator("dl").waitFor(); assert.equal(await details.getAttribute("aria-expanded"), "true");
  await page.waitForFunction(() => { const r = document.getElementById("analytics-coverage")?.getBoundingClientRect(); return r && r.top >= 0 && r.top < window.innerHeight / 2; });
});

test("成本估算：没缺记录时「没算进去的数据」只留一句、不出「哪些天、哪些上游缺记录」；只缺 1 天时说「这一天」", async (t) => {
  const own = (route) => failJSON(route, 400, { error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" });
  let missing = 0;
  const analytics = (days) => {
    const f = costAnalyticsFixture(days); if (!missing) return f;
    f.daily = f.daily.slice(missing); const earliestDate = f.daily[0].date;
    f.coverage = { ...f.coverage, earliestDate, availableDays: days - missing, isComplete: false, stationGaps: [{ stationId: "up-a", stationName: "Fixture upstream", availableDays: days - missing, missingDays: missing, earliestDate }] };
    return f;
  };
  const { page } = await openCostPage(t, own, "/analytics", { analytics });
  const coverage = page.locator("#analytics-coverage");
  await coverage.getByText(ANALYTICS_COPY.leadFull(30, 1), { exact: true }).waitFor();
  assert.equal(await coverage.getByRole("button").count(), 0);
  missing = 1; await page.reload();
  await coverage.getByText(ANALYTICS_COPY.leadGaps(ANALYTICS_COPY.leadMissingDays(1), 1), { exact: true }).waitFor();
  assert.match(await coverage.innerText(), /这一天的上游成本没算全/);
  await coverage.getByRole("button", { name: ANALYTICS_COPY.coverageCaption, exact: true }).waitFor();
});

test("成本估算的可用天数和运营总览同一个档位：余额在提醒线以下写「余额偏低」，不只按天数写「快用完」", async (t) => {
  const own = (route) => failJSON(route, 400, { error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" });
  const low = await openCostPage(t, own, "/analytics", { stations: costStationsFixture({ ok: true, remaining: 2 }, { etaDays: 1.5, burnPerDay: 1 }) });
  const runway = low.page.getByRole("region", { name: ANALYTICS_COPY.panel.runway, exact: true }); await runway.getByText(BALANCE_STATE_TEXT.low, { exact: true }).waitFor();
  assert.equal(await runway.getByText(BALANCE_STATE_TEXT.soon, { exact: true }).count(), 0);
  // 读不到提醒规则（/api/meta 失败）：提醒线用上游列表带回来的，照样是「余额偏低」
  const noMeta = await openCostPage(t, own, "/analytics", { stations: costStationsFixture({ ok: true, remaining: 2 }, { etaDays: 1.5, burnPerDay: 1 }), meta: (route) => failJSON(route, 500, { error: "boom" }) });
  const noMetaRunway = noMeta.page.getByRole("region", { name: ANALYTICS_COPY.panel.runway, exact: true }); await noMetaRunway.getByText(BALANCE_STATE_TEXT.low, { exact: true }).waitFor();
  assert.equal(await noMetaRunway.getByText(BALANCE_STATE_TEXT.soon, { exact: true }).count(), 0);
  // 读不到余额：和运营总览一样画成虚线框（is-unknown），不画实心空条
  const unreadable = await openCostPage(t, own, "/analytics", { stations: costStationsFixture({ ok: false, error: "403" }, { etaDays: 5, burnPerDay: 1 }) });
  const unreadableRunway = unreadable.page.getByRole("region", { name: ANALYTICS_COPY.panel.runway, exact: true }); await unreadableRunway.getByText(BALANCE_STATE_TEXT.unreadable, { exact: true }).waitFor();
  assert.equal(await unreadableRunway.locator(".jy-track.is-unknown").count(), 1); assert.equal(await unreadableRunway.locator(".jy-track .fill").count(), 0);
  // 余额在提醒线以上、约 5 天：还是「快用完」
  const soon = await openCostPage(t, own); const soonRunway = soon.page.getByRole("region", { name: ANALYTICS_COPY.panel.runway, exact: true }); await soonRunway.getByText(BALANCE_STATE_TEXT.soon, { exact: true }).waitFor();
});
// 利润等式里收入那一格留空时写的字（profit-equation.tsx 的 EQ_TEXT.unsetRevenue；组件文件带 JSX，node 读不了）
const EQ_UNSET_REVENUE = "没设置";

test("成本估算：收入算不出来时按原因说——没设置、超过 30 天、读不到、没法按天算各一句，原文收进「查看详细原因」", async (t) => {
  const unset = await openCostPage(t, (route) => failJSON(route, 400, { error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }));
  await unset.equation.getByText(EQ_UNSET_REVENUE, { exact: true }).waitFor();
  await unset.equation.getByText(new RegExp(`^${OWN_STATION_UNSET_TITLE}，`)).waitFor();
  assert.equal(await unset.equation.getByRole("link", { name: workflowActionMeta("setup_own_station").label, exact: true }).getAttribute("href"), workflowAction("setup_own_station").href);
  await unset.page.context().close();

  // 超过 30 天：不去读自营收入，只算成本，给「切换到近 30 天」
  const long = await openCostPage(t, () => { throw new Error("unexpected own read for 90 days"); }, "/analytics?range=90d");
  await long.equation.getByText(ANALYTICS_COPY.longRangeNote, { exact: true }).waitFor();
  await long.equation.locator(".jy-partial-note").filter({ hasText: ANALYTICS_COPY.longRangeNotice }).getByRole("link", { name: ANALYTICS_COPY.switchTo(RANGE_TEXT["30d"]), exact: true }).waitFor();
  assert.deepEqual(long.ownReads, []);
  await long.page.context().close();

  // 接口报错和接口正常、但算收入时报错，是同一句；状态码 502 也按接口给的码归类
  const raw = "own upstream said 403 forbidden";
  for (const own of [(route) => failJSON(route, 502, { error: raw, code: "UPSTREAM_AUTH_DENIED" }),
    (route) => fulfill(route, { station: { id: "own-1", name: "Fixture own", cnyPerUsd: 7.5 }, profit: { error: raw, errorCode: "UPSTREAM_AUTH_DENIED" }, trend: [], tz: BUSINESS_TZ })]) {
    const failed = await openCostPage(t, own);
    const sentence = `${failureSentence(INCOME_UNREAD.title, ERROR_CATEGORIES.permission.text)}${INCOME_UNREAD.costOnly}`;
    const notice = failed.equation.locator(".jy-partial-note").filter({ hasText: sentence }); await notice.waitFor();
    await failed.equation.getByText(INCOME_UNREAD.empty, { exact: true }).waitFor();
    await notice.getByRole("button", { name: REFRESH, exact: true }).waitFor();
    // 原文默认收起，展开「查看详细原因」才看得到
    assert.equal(await failed.page.getByText(raw, { exact: true }).isVisible(), false);
    await notice.getByText("查看详细原因", { exact: true }).click(); await failed.page.getByText(raw, { exact: true }).waitFor();
    await failed.page.context().close();
  }

  // 自营站点读到了，但没有每天的消费记录：收入没法分到每天，说原因，不当成报错
  const unsplit = await openCostPage(t, (route) => fulfill(route, { station: { id: "own-1", name: "Fixture own", cnyPerUsd: 7.5 }, profit: { incomeCny: 10 }, tz: BUSINESS_TZ }));
  await unsplit.equation.getByText(ANALYTICS_COPY.incomeUnsplitEmpty, { exact: true }).waitFor();
  await unsplit.equation.locator(".jy-partial-note").filter({ hasText: `${ANALYTICS_COPY.incomeUnsplit}：自营站点没有给出每天的消费记录。` }).waitFor();
  assert.equal(await unsplit.equation.getByText("查看详细原因", { exact: true }).count(), 0);
});

// 收入确认不了时（用户身份或转售记录没读全），/api/own/analytics 照常返回（server/own-helpers.js 的 unconfirmedIncomeProfit）：
// 两项成本照常，收入、管理员自用、毛利、净利是 null，原因在 profit.incomeUnconfirmed；用户列表也读不到时多一个 usersUnavailable
const INCOME_UNCONFIRMED = { error: "用户「newbie」的身份没读到，收入和利润暂时算不出", errorCode: "OWN_INCOME_UNCONFIRMED" };
const USERS_UNAVAILABLE = { error: "fixture user list unavailable", errorCode: "UPSTREAM_REQUEST_FAILED" };
const PROFIT_FAILED = "利润暂时算不出"; // profit-equation.tsx 的 EQ_TEXT.profitFailed（组件文件带 JSX，node 读不了）
function unconfirmedOwnAnalytics(range = "7d", { usersUnavailable = false } = {}) {
  const endMs = Date.now(), span = range === "today" ? 3600000 : 7 * 86400000, startMs = endMs - span;
  return { range, tz: BUSINESS_TZ, startMs, endMs, prevWindow: { startMs: startMs - span, endMs: startMs, spanDays: span / 86400000 },
    station: { id: "own-1", name: "Fixture own", cnyPerUsd: 7 }, tokenScope: "billed",
    byModel: [{ model: "fixture-model", tokens: 3000, cost: 5, requests: 5 }],
    // 用户列表读不到时谁是管理员标不出，都按普通用户给
    byUser: [{ user: "customer", tokens: 1000, cost: 2, requests: 3, isAdmin: false }, { user: "root", tokens: 2000, cost: 3, requests: 2, isAdmin: !usersUnavailable }],
    prevUserAvailable: true, userBalances: usersUnavailable ? null : [{ user: "customer", balanceUsd: 4, usedUsd: 2, status: 1 }],
    flow: { byGroup: [], byChannel: [], byUserGroup: [], coveredUsd: 0, coveragePct: null, prevWindow: { startMs: startMs - span, endMs: startMs } },
    trend: [], daily: [], forecast: null, hourly: null, incomeDaily: null, incomeDailyApprox: false, generatedAt: new Date().toISOString(),
    profit: { incomeCny: null, adminUsageCny: null, resoldCny: null, grossProfitCny: null, netProfitCny: null, grossMarginPct: null, netMarginPct: null, profitCny: null, marginPct: null,
      upstreamCostCny: 3.5, fixedCostCny: 1.25, totalCostCny: 4.75, unmatched: [], complete: true, estimated: false, excludedStationIds: [], rateUnsetStations: [], warnings: [], warningCodes: [], windowDays: 7,
      // 已标记的转售 Key 照常列出、金额是 null；没读到的那把带报错
      resoldKeys: [{ username: "root", tokenName: "sale", usd: null, cny: null, error: "fixture stat unavailable", errorCode: "UPSTREAM_REQUEST_FAILED" },
        { username: "root", tokenName: "promo", usd: null, cny: null }],
      costs: [{ stationId: "up-usage", name: "Usage upstream", channels: ["Sales"], mode: "usage", usd: 0.5, cny: 3.5 },
        { stationId: "up-fixed", name: "Fixed upstream", channels: ["Sales"], mode: "fixed", note: "", active: 1, expired: 0, upcoming: 0, total: 1, cny: 1.25 }],
      incomeUnconfirmed: INCOME_UNCONFIRMED },
    ...(usersUnavailable ? { usersUnavailable: USERS_UNAVAILABLE } : {}) };
}
// 利润等式在收入读不到时：收入写「读不到」，毛利、净利留空、下面写「读不到收入」；下方一句原因加「刷新」，原文收起。
// costs 给了就核对两项成本照常显示（成本估算页的成本来自 /api/analytics，不核对）
async function expectIncomeUnread(equation, costs = null) {
  const reason = errorText({ code: "OWN_INCOME_UNCONFIRMED" }), page = equation.page();
  const notice = equation.locator(".jy-partial-note").filter({ hasText: `${failureSentence(INCOME_UNREAD.title, reason)}${INCOME_UNREAD.costOnly}` });
  await notice.waitFor(); await notice.getByRole("button", { name: REFRESH, exact: true }).waitFor();
  assert.equal(await page.getByText(INCOME_UNCONFIRMED.error, { exact: true }).filter({ visible: true }).count(), 0);
  const term = (label) => equation.locator(".jy-eq-term:not(.is-carry)").filter({ has: page.locator(".jy-eq-label").filter({ hasText: new RegExp(`^${label}$`) }) });
  const value = async (label) => (await term(label).locator(".jy-eq-value").textContent()).trim();
  assert.equal(await value("收入"), INCOME_UNREAD.empty);
  for (const label of ["毛利", "净利"]) { assert.equal(await value(label), EMPTY); assert.equal((await term(label).locator(".jy-eq-note").textContent()).trim(), INCOME_UNREAD.profit); }
  if (costs) { assert.equal(await value("上游成本"), formatMoney(costs.upstream)); assert.equal(await value("固定成本"), formatMoney(costs.fixed)); }
  assert.doesNotMatch(await equation.innerText(), /NaN|undefined/);
  // 原文收在说明里的「查看详细原因」，点开才看得到
  await notice.getByText("查看详细原因", { exact: true }).click(); await notice.getByText(INCOME_UNCONFIRMED.error, { exact: true }).waitFor();
}
async function openUnconfirmedMyPage(t, options) {
  return openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/own/analytics") return fulfill(route, unconfirmedOwnAnalytics(url.searchParams.get("range") || "7d", options));
    if (url.pathname === "/api/analytics") return fulfill(route, costAnalyticsFixture(Number(url.searchParams.get("days")) || 7));
    throw new Error("unexpected my fixture API: " + url.pathname);
  }, undefined, false, null, "/my");
}

test("收入确认不了时：成本估算、自营业务的利润等式收入几项写「读不到」并说原因，两项成本照常；用户表说合计含管理员账号；用户列表也读不到时说管理员没标出", async (t) => {
  const cost = await openCostPage(t, (route) => fulfill(route, { ...unconfirmedOwnAnalytics(), trend: [] }));
  await expectIncomeUnread(cost.equation);
  await cost.page.context().close();

  // 自营业务默认近 7 天：利润等式叫「近 7 天经营」（profit-equation.tsx 的 EQ_TEXT.business）
  const page = await openUnconfirmedMyPage(t);
  await expectIncomeUnread(page.getByRole("region", { name: `${RANGE_TEXT["7d"]}经营`, exact: true }), { upstream: 3.5, fixed: 1.25 });
  // 利润那块不整块报错（报错框的标题里没有「利润暂时算不出」；原文收在「查看详细原因」里，可能也带这几个字）
  assert.equal(await page.locator(".jy-state[role=alert] h3").filter({ hasText: PROFIT_FAILED }).count(), 0);
  // 每日趋势只画成本，说明跟着改（overview-tab.tsx 的 COPY.trendNoIncome）
  await page.getByText(`按天。${INCOME_UNREAD.title}，这里只画成本。`).first().waitFor();
  assert.doesNotMatch(await page.locator("main").innerText(), /NaN|undefined/);
  // 「利润怎么算」照常打开：收入写「读不到（原因）」，两项成本照常；转售 Key 照常列出、金额写「—」，没读到的那把标「读不到」，照常能选（lib/format.js 的 BASIS_TITLE、profit-basis.tsx 的 COPY）
  await page.getByRole("button", { name: "利润怎么算", exact: true }).click();
  const basis = page.getByRole("region", { name: "利润怎么算", exact: true });
  await basis.getByText(`收入 ${INCOME_UNREAD.empty}（${errorText({ code: "OWN_INCOME_UNCONFIRMED" })}），上游成本 ${formatMoney(3.5)}，固定成本 ${formatMoney(1.25)}，2 个转售 Key`, { exact: false }).waitFor();
  const resold = basis.getByRole("table", { name: "已标记的转售 Key", exact: true });
  await resold.waitFor();
  const resoldRow = (token) => resold.locator("tbody tr").filter({ has: page.getByText(token, { exact: true }) });
  assert.equal((await resoldRow("promo").locator("td").last().textContent()).trim(), EMPTY);
  assert.equal((await resoldRow("sale").locator("td").last().textContent()).trim(), EMPTY);
  await resoldRow("sale").getByText("读不到", { exact: true }).waitFor();
  assert.equal(await resoldRow("promo").getByText("读不到", { exact: true }).count(), 0);
  assert.equal(await basis.getByRole("button", { name: "选转售 Key", exact: true }).isEnabled(), true);
  // 用户标签页照常列出有消费的用户；收入没算出来，合计只说含多少管理员账号的消费（root 3 美元 × 7）
  await page.getByRole("tab", { name: "用户", exact: true }).click();
  await page.getByText("customer", { exact: true }).first().waitFor();
  await page.getByText(`合计含管理员账号的 ${formatMoney(21)}。`).waitFor();
  await page.context().close();

  // 用户列表也读不到：消费最多的用户、用户表下说管理员没标出；用户余额那块说原因、带刷新，不悄悄消失（shared.tsx 的 MY_TEXT.topUsers、users-tab.tsx 的 COPY.balTitle / balFailed）
  const blind = await openUnconfirmedMyPage(t, { usersUnavailable: true });
  await blind.getByRole("region", { name: "消费最多的用户", exact: true }).getByText(`${ADMIN_UNMARKED}。`, { exact: true }).waitFor();
  await blind.getByRole("tab", { name: "用户", exact: true }).click();
  const balances = blind.getByRole("region", { name: "用户余额", exact: true }).locator(".jy-state[role=alert]").filter({ hasText: failureSentence("读不到用户余额", errorText(USERS_UNAVAILABLE)) });
  await balances.waitFor(); await balances.getByRole("button", { name: REFRESH, exact: true }).waitFor();
  await blind.getByText(`${ADMIN_UNMARKED}。`).first().waitFor();
  assert.equal(await blind.getByText(/合计含管理员/).count(), 0);
});

test("运营总览：收入确认不了时利润等式收入几项写「读不到」、两项成本照常；收入面板说原因，不拿用户消费拼出收入合计", async (t) => {
  const opened = await openAccountsPage(t, { readonlyAPI(route, path) {
    if (path === "/api/own/analytics") return fulfill(route, unconfirmedOwnAnalytics(new URL(route.request().url()).searchParams.get("range") || "today"));
    assert.equal(path, "/api/history/overview"); return fulfill(route, { series: [] });
  } });
  await opened.page.goto(baseURL);
  // 运营总览默认看今天：利润等式叫「今天经营」，收入面板叫「今天收入」（EQ_TEXT.business、page.tsx 的 COPY.income；组件文件带 JSX，node 读不了）
  await expectIncomeUnread(opened.page.getByRole("region", { name: `${RANGE_TEXT.today}经营`, exact: true }), { upstream: 3.5, fixed: 1.25 });
  const revenue = opened.page.getByRole("region", { name: `${RANGE_TEXT.today}收入`, exact: true });
  const failed = revenue.locator(".jy-state[role=alert]").filter({ hasText: failureSentence(INCOME_UNREAD.title, errorText({ code: "OWN_INCOME_UNCONFIRMED" })) });
  await failed.waitFor(); await failed.getByRole("button", { name: REFRESH, exact: true }).waitFor();
  assert.doesNotMatch(await revenue.innerText(), /customer|root|¥/);
  // 上游成本块照常（page.tsx 的 COPY.upstreamCost）：按用量算的上游和合计
  const cost = opened.page.getByRole("region", { name: `${RANGE_TEXT.today}上游成本`, exact: true });
  await cost.getByText("Usage upstream", { exact: true }).waitFor();
  assert.match(await cost.innerText(), new RegExp(formatMoney(3.5).replace(".", "\\.")));
  assert.equal(opened.mutations.length, 0);
});

test("用量分析：全部上游都读不到时只说一处——黄条默认展开原因，合计只写「—」，下面不再放空状态", async (t) => {
  const now = Date.now();
  const usage = { range: "today", granularity: "hour", startMs: now - 3600000, endMs: now, tz: BUSINESS_TZ, generatedAt: new Date(now).toISOString(), stations: [
    { id: "up-b", name: "Broken upstream", type: "newapi", cnyPerUsd: 7, isOwn: false, ok: false, error: "HTTP 401: invalid token", code: "AUTHENTICATION_FAILED" },
    { id: "up-c", name: "Busy upstream", type: "newapi", cnyPerUsd: 7, isOwn: false, ok: false, error: "HTTP 503", code: "UPSTREAM_REQUEST_FAILED" },
  ] };
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/usage") return fulfill(route, usage);
    throw new Error("unexpected usage fixture API: " + url.pathname);
  }, undefined, false, null, "/usage");
  const failedLine = page.locator(".jy-usage-failed-line"); await failedLine.getByText(USAGE_COPY.failedAll(2), { exact: true }).waitFor();
  // 后面接下一步：恢复后会自己出来，不用做什么
  assert.match(await failedLine.innerText(), new RegExp(USAGE_COPY.failedNext));
  const why = failedLine.getByRole("button", { name: USAGE_COPY.failedWhy, exact: true });
  assert.equal(await why.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(".jy-usage-failed li").count(), 2);
  const totals = page.getByRole("region", { name: USAGE_COPY.totalsLabel, exact: true });
  assert.equal(await totals.locator(".jy-usage-figure").filter({ hasText: /^—$/ }).count(), 3);
  assert.equal(await totals.locator("dl .jy-caption").count(), 0);
  // 读不到这件事只有黄条一处：不再有「这段时间没有用量」那类空状态
  assert.equal(await page.getByText(USAGE_COPY.emptyTitle, { exact: true }).count(), 0);
  assert.equal(await page.getByText(/读不到/).count(), await failedLine.getByText(/读不到/).count());
  // 只有 1 个上游时说「这个上游」；筛到自营站点时说自营站点，不叫它上游
  usage.stations = [usage.stations[0]]; await page.reload();
  await failedLine.getByText(USAGE_COPY.failedAll(1), { exact: true }).waitFor();
  assert.doesNotMatch(await failedLine.innerText(), /1 个上游/);
  usage.stations = [{ ...usage.stations[0], id: "own-1", name: "Fixture own", isOwn: true }]; await page.goto(page.url().split("?")[0] + "?station=own-1");
  await failedLine.getByText(USAGE_COPY.failedOwn, { exact: true }).waitFor();
});

test("用量分析：读不到用量的上游按码说一句、原文收起；没设置汇率只数有花费的上游；后台刷新失败保留上次的数据；单独看自营站点按售价说", async (t) => {
  const generatedAt = new Date().toISOString(); let fail = false; const reads = [];
  const hourAgo = Date.now() - 3600000;
  const usage = { range: "today", granularity: "hour", startMs: hourAgo, endMs: Date.now(), tz: BUSINESS_TZ, generatedAt, stations: [
    { id: "up-a", name: "Fixture upstream", type: "newapi", cnyPerUsd: null, isOwn: false, ok: true, summary: { tokens: 1234567, cost: 1.5, requests: 12 },
      models: [{ model: "gpt-4o", tokens: 1234567, cost: 1.5, requests: 12 }], trend: [{ t: hourAgo, tokens: 1234567, cost: 1.5, requests: 12 }] },
    // 没设置汇率但这段时间没花钱：不影响合计，不算进「没设置汇率」
    { id: "up-idle", name: "Idle upstream", type: "newapi", cnyPerUsd: null, isOwn: false, ok: true, summary: { tokens: 0, cost: 0, requests: 0 }, models: [], trend: [] },
    { id: "up-b", name: "Broken upstream", type: "newapi", cnyPerUsd: 7, isOwn: false, ok: false, error: "HTTP 401: invalid token", code: "AUTHENTICATION_FAILED" },
    { id: "own-1", name: "Fixture own", type: "newapi", cnyPerUsd: null, isOwn: true, ok: true, summary: { tokens: 5000, cost: 2, requests: 3 },
      models: [{ model: "gpt-4o", tokens: 5000, cost: 2, requests: 3 }], trend: [{ t: hourAgo, tokens: 5000, cost: 2, requests: 3 }] },
  ] };
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/usage") { reads.push(url.searchParams.get("range")); return fail ? failJSON(route, 502, { error: "gateway boom", code: "UPSTREAM_REQUEST_FAILED" }) : fulfill(route, usage); }
    throw new Error("unexpected usage fixture API: " + url.pathname);
  };
  const page = await openFixturePage(t, handler, undefined, false, null, "/usage");
  const totals = page.getByRole("region", { name: USAGE_COPY.totalsLabel, exact: true });
  await totals.getByText(formatCompact(1234567), { exact: true }).waitFor();
  // 读不到的上游默认只一行（ui-copy-spec §8.4）：「看原因」展开才列出每个上游；合计里那一格不再写「N 个读不到」
  const failedLine = page.locator(".jy-usage-failed-line"); await failedLine.getByText(USAGE_COPY.failedSome(1), { exact: true }).waitFor();
  assert.equal(await page.locator(".jy-usage-failed li").count(), 0);
  assert.equal(await totals.getByText(/个读不到/).count(), 0);
  const why = failedLine.getByRole("button", { name: USAGE_COPY.failedWhy, exact: true });
  assert.equal(await why.getAttribute("aria-expanded"), "false"); await why.click(); assert.equal(await why.getAttribute("aria-expanded"), "true");
  const failed = page.locator(".jy-usage-failed li"); await failed.waitFor();
  assert.match(await failed.innerText(), new RegExp(`^${failureSentence("Broken upstream", ERROR_CATEGORIES.auth.text)}`));
  assert.doesNotMatch(await failed.innerText(), /invalid token/);
  await totals.getByText(USAGE_COPY.rateUnset(1), { exact: true }).waitFor();
  // 「合计里不含它们」只在黄条那一行说，合计各格下面不再写（ui-copy-spec §8.4）
  assert.equal(await totals.getByText(/不含读不到/).count(), 0);
  await totals.getByText(USAGE_COPY.cost, { exact: true }).waitFor();

  // 切回标签页时重新读，这次读不到：上次的数字留着，横幅说刷新失败和数据截至的时刻，按码说原因
  fail = true; const before = reads.length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const banner = page.locator(".jy-banner[role=alert]").filter({ hasText: refreshFailedText(Date.parse(generatedAt), BUSINESS_TZ) }); await banner.waitFor();
  assert.ok(reads.length > before);
  await banner.getByText(ERROR_CATEGORIES.busy.text, { exact: true }).waitFor();
  await totals.getByText(formatCompact(1234567), { exact: true }).waitFor();
  fail = false; await banner.getByRole("button", { name: REFRESH, exact: true }).click(); await banner.waitFor({ state: "detached" });
  await page.context().close();

  // 只看自营站点：算的是用户消费，没设置售价时写售价那句，不说「上游没设置汇率」
  const own = await openFixturePage(t, handler, undefined, false, null, "/usage?station=own-1");
  const ownTotals = own.getByRole("region", { name: USAGE_COPY.totalsLabel, exact: true });
  await ownTotals.getByText(USAGE_COPY.ownCost, { exact: true }).waitFor();
  await ownTotals.getByText(SELL_PRICE_UNSET, { exact: true }).waitFor();
  assert.equal(await ownTotals.getByText(USAGE_COPY.cost, { exact: true }).count(), 0);
  assert.equal(await ownTotals.getByText(RATE_UNSET_PARITY).count(), 0);
});

// 系统设置、告警中心、登录页的接口数据
const settingsFixture = () => ({ settings: { refreshIntervalSec: 60, lowBalanceUsd: 5, historyRetentionDays: null },
  history: { earliestAt: "2026-09-01T01:00:00Z", latestAt: new Date().toISOString(), pointCount: 1234, tableBytes: 2048, retentionDays: null, cleanup: {} }, tz: BUSINESS_TZ });
// 「保存失败」「X没存上」取自 app/components/data-state.tsx 的 SAVE_STATE_TEXT（组件文件带 JSX，node 读不了）
const SAVE_FAILED = "保存失败";
const notSaved = (label) => `${label}没存上`;
const metaFixture = (settings = {}) => ({ types: [], channelTypes: [], rules: {}, settings, app: { version: "2.2.0", commit: "abc1234" }, tz: BUSINESS_TZ });

test("系统设置改密码：按接口给的码把报错放到对应的输入框，原密码不对落在「原密码」下，别的放在表单顶部", async (t) => {
  const answers = [
    (route) => failJSON(route, 400, { error: errorText({ code: "WRONG_PASSWORD" }), code: "WRONG_PASSWORD" }),
    (route) => failJSON(route, 400, { error: errorText({ code: "PASSWORD_TOO_SHORT" }), code: "PASSWORD_TOO_SHORT" }),
    (route) => failJSON(route, 500, { error: "db write timeout" }),
  ];
  const posts = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword: false });
    if (url.pathname === "/api/settings") return fulfill(route, settingsFixture());
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture());
    if (url.pathname === "/api/auth/password") { posts.push(route.request().postDataJSON()); return answers[posts.length - 1](route); }
    throw new Error("unexpected settings fixture API: " + url.pathname);
  }, undefined, false, null, "/settings");
  const account = page.getByRole("region", { name: SETTINGS_COPY.account, exact: true });
  const oldInput = account.getByLabel(SETTINGS_COPY.oldPassword, { exact: true }), newInput = account.getByLabel(SETTINGS_COPY.newPassword, { exact: true });
  const fieldError = async (input) => page.locator(`#${await input.getAttribute("aria-describedby")}`).innerText();
  const submit = async () => {
    await oldInput.fill("wrong-one"); await newInput.fill("new-secret"); await account.getByLabel(SETTINGS_COPY.confirmPassword, { exact: true }).fill("new-secret");
    // 点过一次后 antd 会往按钮里插别的元素（点击波纹、保存中的转圈图标），读屏名字不一定完全等于按钮上的字；
    // 区块里只有这一个按钮，按包含找
    await account.getByRole("button", { name: SETTINGS_COPY.changePassword }).click();
  };
  // 软件版本和侧栏一样写，括号里是编号
  await page.getByText("2.2.0（abc1234）", { exact: true }).waitFor();

  await submit(); await page.waitForFunction(() => document.querySelector("[aria-invalid=true]"));
  assert.equal(await oldInput.getAttribute("aria-invalid"), "true");
  assert.equal(await fieldError(oldInput), errorText({ code: "WRONG_PASSWORD" }));
  assert.equal(await account.locator(".jy-banner[role=alert]").count(), 0);

  await submit(); await page.waitForFunction(() => document.activeElement?.getAttribute("aria-invalid") === "true" && document.activeElement?.getAttribute("autocomplete") === "new-password");
  assert.equal(await fieldError(newInput), errorText({ code: "PASSWORD_TOO_SHORT" }));

  // 原文里有 timeout：这是控制台自己的接口，不说成「连不上这个地址」
  await submit();
  const banner = account.locator(".jy-banner[role=alert]"); await banner.waitFor();
  await banner.getByText(`${SETTINGS_COPY.changeFailed}：${ERROR_CATEGORIES.other.text}。`, { exact: true }).waitFor();
  assert.doesNotMatch(await banner.innerText(), /db write timeout/);
  await banner.getByText("查看详细原因", { exact: true }).waitFor();
  assert.equal(posts.length, 3);
});

test("系统设置：接口说登录信息没加密时页顶提示一条（不写环境变量名）；加密了、或者老接口不带这个字段时不提示", async (t) => {
  for (const [secretsEncrypted, shown] of [[false, true], [true, false], [undefined, false]]) {
    const page = await openFixturePage(t, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword: false });
      if (url.pathname === "/api/settings") return fulfill(route, { ...settingsFixture(), ...(secretsEncrypted === undefined ? {} : { secretsEncrypted }) });
      if (url.pathname === "/api/meta") return fulfill(route, metaFixture());
      throw new Error("unexpected settings fixture API: " + url.pathname);
    }, undefined, false, null, "/settings");
    // 骨架屏的区块名一样，要等读到设置后才有的输入框
    await page.getByLabel(SETTINGS_COPY.interval, { exact: true }).waitFor();
    const notice = page.locator(".jy-banner", { hasText: SETTINGS_COPY.plainSecrets });
    assert.equal(await notice.count(), shown ? 1 : 0, String(secretsEncrypted));
    if (shown) {
      await notice.getByText(SETTINGS_COPY.plainSecretsHint, { exact: true }).waitFor();
      assert.doesNotMatch(await notice.innerText(), /RELAY_SECRET_KEY|[A-Za-z]/);
    }
    await page.close();
  }
});

test("登录页按码说：用户名或密码不对时标红输入框，试太多次时不标红，别的报错按控制台自己的说法写「登录失败：原因。」", async (t) => {
  const answers = [
    (route) => failJSON(route, 401, { error: errorText({ code: "LOGIN_FAILED" }), code: "LOGIN_FAILED" }),
    (route) => failJSON(route, 429, { error: errorText({ code: "LOGIN_RATE_LIMITED" }), code: "LOGIN_RATE_LIMITED" }),
    (route) => failJSON(route, 500, { error: "session store down: timeout" }),
    (route) => failJSON(route, 502, { error: "bad gateway" }),
    (route) => route.abort("internetdisconnected"),
  ];
  let calls = 0;
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/login") return answers[calls++](route);
    throw new Error("unexpected login fixture API: " + url.pathname);
  }, undefined, false, null, "/login");
  const login = async () => {
    await page.getByLabel(LOGIN_COPY.username, { exact: true }).fill("admin"); await page.getByLabel(LOGIN_COPY.password, { exact: true }).fill("secret");
    // 同上：点过一次后按钮里可能多了别的元素，按包含找（整页只有这一个按钮）
    await page.getByRole("button", { name: LOGIN_COPY.submit }).click();
  };
  const alert = page.locator(".jy-login-error");
  const red = () => page.locator(".ant-form-item-has-error").count();

  await login(); await alert.getByText(errorText({ code: "LOGIN_FAILED" }), { exact: true }).waitFor();
  assert.equal(await red(), 2);
  await login(); await alert.getByText(errorText({ code: "LOGIN_RATE_LIMITED" }), { exact: true }).waitFor();
  assert.equal(await red(), 0);
  // 控制台自己的接口：原文里的 timeout、代理的 502 不说成「连不上这个地址」「上游繁忙」
  await login(); await alert.getByText(`${LOGIN_COPY.failed}：${ERROR_CATEGORIES.other.text}。`, { exact: true }).waitFor();
  assert.equal(await red(), 0);
  assert.equal(await alert.getByText("session store down: timeout").isVisible(), false);
  await alert.getByText("查看详细原因", { exact: true }).waitFor();
  await login(); await alert.getByText(`${LOGIN_COPY.failed}：${ERROR_CATEGORIES.not_ready.text}。`, { exact: true }).waitFor();
  await login(); await alert.getByText(CONSOLE_UNREACHABLE, { exact: true }).waitFor();
  assert.equal(await red(), 0);
});

test("告警中心：没有通知方式时整页只放「还没有通知方式」；有了以后规则名取余额档位的共用叫法，上次定时发送写成「10月20日」，立即发送没发出去时说清楚", async (t) => {
  const yesterday = shiftDay(shanghaiDay(Date.now()), -1);
  const rules = { onLow: true, onExhaust: true, onError: true, onRecover: false, onEta: true, etaDays: 3, etaUnit: "days", renotifyHours: 24, errorThreshold: 1, errorRetrySec: 30, channelsFor: {} };
  let sends = 0, channels = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels, rules, channelTypes: [{ value: "telegram", label: "Telegram", fields: [] }] });
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture({ dailyReport: { enabled: true, time: "09:00", channelIds: [], lastSent: yesterday } }));
    // 第一次：接口没带认得的码；第二次：没有能发日报的通知方式（带码）
    if (url.pathname === "/api/report/send") return sends++ === 0
      ? failJSON(route, 400, { error: "boom: 没有启用的日报通知渠道" })
      : failJSON(route, 400, { error: errorText({ code: "REPORT_NO_CHANNELS" }), code: "REPORT_NO_CHANNELS" });
    throw new Error("unexpected notifications fixture API: " + url.pathname);
  }, undefined, false, null, "/notifications");
  // 还没有通知方式：只放这一件事（ui-copy-spec §8.3），提醒规则、日报、页首那条都不出
  await page.getByRole("region", { name: NOTIFICATIONS_COPY.channels, exact: true }).getByText(NOTIFICATIONS_COPY.emptyHint, { exact: true }).waitFor();
  for (const title of [NOTIFICATIONS_COPY.rules, NOTIFICATIONS_COPY.report]) assert.equal(await page.getByRole("region", { name: title, exact: true }).count(), 0);
  assert.equal(await page.locator(".jy-banner").count(), 0);
  // 有了通知方式（但都停用了）：规则、日报出来，页首说通知方式都停用了
  channels = [{ id: "c1", name: "运维群", type: "telegram", enabled: false, config: {}, hasSecret: {} }];
  await page.reload();
  for (const title of [NOTIFICATIONS_COPY.rules, NOTIFICATIONS_COPY.channels, NOTIFICATIONS_COPY.report]) await page.getByRole("region", { name: title, exact: true }).waitFor();
  const ruleTable = page.locator(".jy-notifications-rules");
  for (const name of [BALANCE_STATE_TEXT.low, BALANCE_STATE_TEXT.empty, BALANCE_STATE_TEXT.unreadable, NOTIFICATIONS_COPY.recover, BALANCE_STATE_TEXT.soon])
    await ruleTable.getByText(name, { exact: true }).waitFor();
  // 打开了提醒却没有启用的通知方式：页首提醒发不出去
  await page.getByText(NOTIFICATIONS_COPY.noDeliveryOff, { exact: true }).waitFor();
  await page.getByText(NOTIFICATIONS_COPY.reportLastSent(formatDayKey(yesterday, BUSINESS_TZ)), { exact: true }).waitFor();
  // 「立即发送」在发之前就出错：说没发出去，原文进「查看详细原因」，不写「几点发送」
  await page.getByRole("button", { name: NOTIFICATIONS_COPY.reportSend }).click();
  const result = page.locator(".jy-test-result--bad"); await result.waitFor();
  await result.getByText(failureSentence(NOTIFICATIONS_COPY.reportNotSent, ERROR_CATEGORIES.other.text), { exact: true }).waitFor();
  await result.getByText("查看详细原因", { exact: true }).waitFor();
  assert.doesNotMatch(await result.innerText(), /发送$|没有启用的日报通知渠道/m);
  // 带码时说清楚是哪一种，接口给的就是这句，不再放「查看详细原因」
  await page.getByRole("button", { name: NOTIFICATIONS_COPY.reportSend }).click();
  await result.getByText(failureSentence(NOTIFICATIONS_COPY.reportNotSent, errorText({ code: "REPORT_NO_CHANNELS" })), { exact: true }).waitFor();
  assert.equal(await result.getByText("查看详细原因", { exact: true }).count(), 0);
});

test("告警一处设完：余额提醒线在「余额偏低」那一行，离开输入框就存；日报改了就存；系统设置不再有余额提醒线，刷新间隔、保留天数改了马上存", async (t) => {
  const rules = { onLow: true, onExhaust: true, onError: true, onRecover: false, onEta: true, etaDays: 3, etaUnit: "days", renotifyHours: 24, errorThreshold: 1, errorRetrySec: 30, channelsFor: {} };
  const puts = [];
  let settings = { lowBalanceUsd: 5, refreshIntervalSec: 60, historyRetentionDays: null, dailyReport: { enabled: false, time: "09:00", channelIds: [] } };
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword: false });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels: [{ id: "c1", name: "运维群", type: "telegram", enabled: true, config: {}, hasSecret: {} }], rules, channelTypes: [{ value: "telegram", label: "Telegram", fields: [] }] });
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture(settings));
    if (url.pathname === "/api/settings" && method === "PUT") {
      const body = route.request().postDataJSON(); puts.push(body);
      settings = { ...settings, ...body, ...(body.dailyReport ? { dailyReport: { ...settings.dailyReport, ...body.dailyReport } } : {}) };
      return fulfill(route, { settings, history: settingsFixture().history, tz: BUSINESS_TZ });
    }
    if (url.pathname === "/api/settings") return fulfill(route, { ...settingsFixture(), settings });
    throw new Error("unexpected alerts fixture API: " + method + " " + url.pathname);
  }, undefined, false, null, "/notifications");
  const rulesPanel = page.getByRole("region", { name: NOTIFICATIONS_COPY.rules, exact: true });
  const low = rulesPanel.getByLabel(NOTIFICATIONS_COPY.lowLabel, { exact: true });
  await low.waitFor(); assert.equal(await low.inputValue(), "5");
  await rulesPanel.getByText(NOTIFICATIONS_COPY.lowHint, { exact: true }).waitFor();
  await low.fill("3"); await low.press("Tab");
  for (let wait = 0; !puts.length && wait < 50; wait++) await page.waitForTimeout(100);
  assert.deepEqual(puts[0], { lowBalanceUsd: 3 });
  await rulesPanel.getByText(/^已保存 /).waitFor();
  // 日报：打开开关就存，没有「保存」按钮
  const report = page.getByRole("region", { name: NOTIFICATIONS_COPY.report, exact: true });
  assert.equal(await report.getByRole("button", { name: NOTIFICATIONS_COPY.save, exact: true }).count(), 0);
  await report.getByRole("switch").first().click();
  for (let wait = 0; puts.length < 2 && wait < 50; wait++) await page.waitForTimeout(100);
  assert.deepEqual(puts[1], { dailyReport: { enabled: true, time: "09:00", channelIds: [] } });

  // 系统设置：没有「余额提醒线」区块，「刷新与数据」下面一句链到告警中心；刷新间隔离开输入框就存，只带这一项
  await page.goto(new URL("/settings", page.url()).href);
  const refresh = page.getByRole("region", { name: SETTINGS_COPY.refresh, exact: true });
  const interval = refresh.getByLabel(SETTINGS_COPY.interval, { exact: true }); await interval.waitFor();
  assert.equal(await page.getByRole("region", { name: "余额提醒线", exact: true }).count(), 0);
  assert.equal(await refresh.getByRole("link", { name: NAV_LABELS.notifications, exact: true }).getAttribute("href"), "/notifications");
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
  await interval.fill("120"); await interval.press("Enter");
  for (let wait = 0; puts.length < 3 && wait < 50; wait++) await page.waitForTimeout(100);
  assert.deepEqual(puts[2], { refreshIntervalSec: 120 });
  await refresh.getByText(/^已保存 /).waitFor();
  // 保留天数：改长（一直保留 → 不缩短）不用确认，选了就存
  const retention = page.getByRole("region", { name: SETTINGS_COPY.retention, exact: true });
  settings = { ...settings, historyRetentionDays: 30 }; await page.reload(); await retention.getByLabel(SETTINGS_COPY.keep, { exact: true }).waitFor();
  await retention.getByLabel(SETTINGS_COPY.keep, { exact: true }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: SETTINGS_COPY.keepDays(90) }).first().click();
  for (let wait = 0; puts.length < 4 && wait < 50; wait++) await page.waitForTimeout(100);
  assert.deepEqual(puts[3], { historyRetentionDays: 90 });
});

test("改了马上保存：没有通知方式时提醒线和提醒天数也能改；存不进去回到已保存的值并留下「保存失败」；回车后再离开只存一次；一个字一个字地输入不存；缩短保留天数取消就回到原值、不存", async (t) => {
  const rules = { onLow: true, onExhaust: true, onError: true, onRecover: false, onEta: false, etaDays: 3, etaUnit: "days", renotifyHours: 24, errorThreshold: 1, errorRetrySec: 30, channelsFor: {} };
  const puts = [], rulePuts = [], previews = [];
  let failSettings = false, failRules = false, channels = [];
  let settings = { lowBalanceUsd: 5, refreshIntervalSec: 60, historyRetentionDays: null, dailyReport: { enabled: false, time: "09:00", channelIds: [] } };
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword: false });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels, rules, channelTypes: [{ value: "telegram", label: "Telegram", fields: [] }] });
    if (url.pathname === "/api/notifications/rules" && method === "PUT") {
      rulePuts.push(route.request().postDataJSON());
      if (failRules) return failJSON(route, 500, { error: "rules write timeout" });
      Object.assign(rules, route.request().postDataJSON()); return fulfill(route, { rules });
    }
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture(settings));
    if (url.pathname === "/api/settings/history-preview") { previews.push(url.searchParams.get("days")); return fulfill(route, { preview: { retentionDays: 30, cutoffAt: new Date().toISOString(), pointCount: 12, earliestAt: null, latestAt: null } }); }
    if (url.pathname === "/api/settings" && method === "PUT") {
      const body = route.request().postDataJSON(); puts.push(body);
      if (failSettings) return failJSON(route, 500, { error: "settings write timeout" });
      settings = { ...settings, ...body, ...(body.dailyReport ? { dailyReport: { ...settings.dailyReport, ...body.dailyReport } } : {}) };
      return fulfill(route, { settings, history: settingsFixture().history, tz: BUSINESS_TZ });
    }
    if (url.pathname === "/api/settings") return fulfill(route, { ...settingsFixture(), settings });
    throw new Error("unexpected autosave fixture API: " + method + " " + url.pathname);
  }, undefined, false, null, "/notifications");
  const wait = async (list, n) => { for (let i = 0; list.length < n && i < 50; i++) await page.waitForTimeout(100); };

  // 没有通知方式：空状态下面那一小块里有提醒线和提醒天数；「快用完」关着也能改天数
  const lines = page.getByRole("region", { name: NOTIFICATIONS_COPY.linesTitle, exact: true }); await lines.waitFor();
  assert.equal(await page.getByRole("region", { name: NOTIFICATIONS_COPY.rules, exact: true }).count(), 0);
  const eta = lines.getByLabel(NOTIFICATIONS_COPY.etaLabel, { exact: true });
  assert.equal(await eta.isEnabled(), true);
  await eta.fill("5"); await eta.press("Tab"); await wait(rulePuts, 1);
  assert.equal(rulePuts.length, 1); assert.equal(rulePuts[0].etaDays, 5);
  // 一个字一个字地输入：离开输入框之前不存；回车后紧接着 Tab，只存一次
  const low = lines.getByLabel(NOTIFICATIONS_COPY.lowLabel, { exact: true });
  await low.fill(""); await low.pressSequentially("12", { delay: 80 }); await page.waitForTimeout(300);
  assert.equal(puts.length, 0);
  await low.press("Enter"); await low.press("Tab"); await wait(puts, 1); await page.waitForTimeout(400);
  assert.deepEqual(puts, [{ lowBalanceUsd: 12 }]);
  // 存不进去：回到已保存的 12，标题旁留「保存失败」，下一次存成功才消失
  failSettings = true;
  await low.fill("20"); await low.press("Tab"); await wait(puts, 2);
  await lines.getByText(new RegExp(`^${notSaved(NOTIFICATIONS_COPY.lowLabel)}：`)).waitFor();
  assert.equal(await low.inputValue(), "12");
  failRules = true;
  await eta.fill("7"); await eta.press("Tab"); await wait(rulePuts, 2);
  for (let i = 0; i < 20 && await eta.inputValue() !== "5.00"; i++) await page.waitForTimeout(100);
  assert.equal(await eta.inputValue(), "5.00");
  failSettings = false; failRules = false;
  await low.fill("15"); await low.press("Tab"); await wait(puts, 3);
  // 提醒天数那一组还没存上，「保存失败」还在，说的是「提醒天数」（这时页面上没有「提醒规则」）；它存上以后才消失
  await lines.getByText(new RegExp(`^${notSaved(NOTIFICATIONS_COPY.etaLabel)}：`)).waitFor();
  await eta.fill("6"); await eta.press("Tab"); await wait(rulePuts, 3);
  for (let i = 0; i < 20 && await lines.getByText(/没存上：/).count(); i++) await page.waitForTimeout(100);
  assert.equal(await lines.getByText(/没存上：/).count(), 0);

  // 有通知方式以后：这两个数回到规则那几行里，那一小块不再出现
  channels = [{ id: "c1", name: "运维群", type: "telegram", enabled: true, config: {}, hasSecret: {} }];
  await page.reload();
  const rulesPanel = page.getByRole("region", { name: NOTIFICATIONS_COPY.rules, exact: true }); await rulesPanel.waitFor();
  assert.equal(await page.getByRole("region", { name: NOTIFICATIONS_COPY.linesTitle, exact: true }).count(), 0);
  assert.equal(await rulesPanel.getByLabel(NOTIFICATIONS_COPY.etaLabel, { exact: true }).isEnabled(), true);
  // 日报存不进去：开关回到「关」
  failSettings = true;
  const report = page.getByRole("region", { name: NOTIFICATIONS_COPY.report, exact: true });
  const sw = report.getByRole("switch").first(); await sw.click(); await wait(puts, 4);
  await report.getByText(/没存上：/).waitFor();
  assert.equal(await sw.getAttribute("aria-checked"), "false");
  failSettings = false;

  // 系统设置：刷新间隔存不进去回到 60；缩短保留天数（一直保留 → 90 天）先预览、取消就回到原值，不发 PUT
  await page.goto(new URL("/settings", page.url()).href);
  const refresh = page.getByRole("region", { name: SETTINGS_COPY.refresh, exact: true });
  const interval = refresh.getByLabel(SETTINGS_COPY.interval, { exact: true }); await interval.waitFor();
  failSettings = true;
  const before = puts.length;
  await interval.fill("90"); await interval.press("Tab"); await wait(puts, before + 1);
  await refresh.getByText(/没存上：/).waitFor();
  assert.equal(await interval.inputValue(), "60");
  failSettings = false;
  const retention = page.getByRole("region", { name: SETTINGS_COPY.retention, exact: true });
  const putsBefore = puts.length;
  await retention.getByLabel(SETTINGS_COPY.keep, { exact: true }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: SETTINGS_COPY.keepDays(90) }).first().click();
  const dialog = page.getByRole("dialog", { name: SETTINGS_COPY.confirmTitle, exact: true }); await dialog.waitFor();
  assert.deepEqual(previews, ["90"]);
  await dialog.getByRole("button", { name: SETTINGS_COPY.cancel, exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await retention.locator(`.ant-select-content[title="${SETTINGS_COPY.keepForever}"]`).waitFor();
  await page.waitForTimeout(300);
  assert.equal(puts.length, putsBefore);
});

test("改了马上保存（重叠的保存）：排着的旧值不存也不弹确认框；失败回到最新已保存的值；保存途中又改的输入不被盖掉；回车再离开只弹一个确认框；预览读不到、确认后存不进去、开关存不进去都写哪一组没存上；读不到提醒线时就地重试", async (t) => {
  const rules = { onLow: true, onExhaust: true, onError: true, onRecover: false, onEta: true, etaDays: 3, etaUnit: "days", renotifyHours: 24, errorThreshold: 1, errorRetrySec: 30, channelsFor: {} };
  const puts = [], previews = [], rulePuts = [];
  let slow = 0, failLow = null, failPreview = false, failRetention = false, failRules = false, failMeta = false, channels = [];
  let settings = { lowBalanceUsd: 5, refreshIntervalSec: 60, historyRetentionDays: null, dailyReport: { enabled: false, time: "09:00", channelIds: [] } };
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword: false });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels, rules, channelTypes: [{ value: "telegram", label: "Telegram", fields: [] }] });
    if (url.pathname === "/api/notifications/rules" && method === "PUT") {
      rulePuts.push(route.request().postDataJSON());
      if (failRules) return failJSON(route, 500, { error: "rules write timeout" });
      Object.assign(rules, route.request().postDataJSON()); return fulfill(route, { rules });
    }
    if (url.pathname === "/api/meta") return failMeta ? failJSON(route, 500, { error: "meta down" }) : fulfill(route, metaFixture(settings));
    if (url.pathname === "/api/settings/history-preview") {
      previews.push(url.searchParams.get("days"));
      return failPreview ? failJSON(route, 500, { error: "preview down" }) : fulfill(route, { preview: { retentionDays: 30, cutoffAt: new Date().toISOString(), pointCount: 12, earliestAt: null, latestAt: null } });
    }
    if (url.pathname === "/api/settings" && method === "PUT") {
      const body = route.request().postDataJSON(); puts.push(body);
      if (slow) await sleep(slow);
      if (failLow != null && body.lowBalanceUsd === failLow) return failJSON(route, 500, { error: "settings write timeout" });
      if (failRetention && "historyRetentionDays" in body) return failJSON(route, 500, { error: "cleanup failed" });
      settings = { ...settings, ...body };
      return fulfill(route, { settings, history: settingsFixture().history, tz: BUSINESS_TZ });
    }
    if (url.pathname === "/api/settings") return fulfill(route, { ...settingsFixture(), settings });
    throw new Error("unexpected overlap fixture API: " + method + " " + url.pathname);
  }, undefined, false, null, "/notifications");
  const until = async (check) => { for (let i = 0; i < 60 && !(await check()); i++) await page.waitForTimeout(100); };

  // 读不到余额提醒线（/api/meta 失败）：那一小块里就地说、能重试，重试成功后框能改
  failMeta = true; await page.reload();
  const lines = page.getByRole("region", { name: NOTIFICATIONS_COPY.linesTitle, exact: true }); await lines.waitFor();
  await lines.getByText(new RegExp(`^${NOTIFICATIONS_COPY.linesFailed}`)).waitFor();
  const low = lines.getByLabel(NOTIFICATIONS_COPY.lowLabel, { exact: true });
  assert.equal(await low.isEnabled(), false);
  failMeta = false; await lines.getByRole("button", { name: workflowActionMeta("refresh").label, exact: true }).click();
  await until(async () => low.isEnabled()); assert.equal(await low.inputValue(), "5");
  // 那一小块里提醒线下面只有前半句
  await lines.getByText(NOTIFICATIONS_COPY.lowHintWhere, { exact: true }).waitFor();
  assert.equal(await lines.getByText(NOTIFICATIONS_COPY.lowHint, { exact: true }).count(), 0);

  // 重叠：7 慢慢存（会成），途中又提交 9（会失败）→ 回到最新已保存的 7，不是发起时的 5
  slow = 600; failLow = 9;
  await low.fill("7"); await low.press("Tab"); await until(async () => puts.length >= 1);
  await low.fill("9"); await low.press("Tab");
  await until(async () => puts.length >= 2 && (await lines.getByText(new RegExp(`^${notSaved(NOTIFICATIONS_COPY.lowLabel)}：`)).count()) > 0);
  assert.equal(await low.inputValue(), "7");
  // 保存途中又改、还没离开的输入不被盖掉
  failLow = null;
  await low.fill("11"); await low.press("Tab"); await page.waitForTimeout(100);
  await low.fill("13"); await until(async () => puts.length >= 3); await page.waitForTimeout(800);
  assert.equal(await low.inputValue(), "13");
  await low.press("Tab"); await until(async () => puts.length >= 4); slow = 0;

  // 有通知方式：开关、「发到」存不进去，标题旁写「提醒开关没存上」，开关回到原样
  channels = [{ id: "c1", name: "运维群", type: "telegram", enabled: true, config: {}, hasSecret: {} }];
  await page.reload();
  const rulesPanel = page.getByRole("region", { name: NOTIFICATIONS_COPY.rules, exact: true }); await rulesPanel.waitFor();
  failRules = true;
  const lowSwitch = rulesPanel.getByRole("switch").first(); await lowSwitch.click();
  await rulesPanel.getByText(new RegExp(`^${notSaved(NOTIFICATIONS_COPY.groupToggles)}：`)).waitFor();
  assert.equal(await lowSwitch.getAttribute("aria-checked"), "true");
  failRules = false;

  // 系统设置：刷新间隔慢慢存时，自定义保留天数填 20 回车（排着）、又选 365（排着）→ 只为 365 预览、弹确认框，20 不存
  await page.goto(new URL("/settings", page.url()).href);
  const refresh = page.getByRole("region", { name: SETTINGS_COPY.refresh, exact: true });
  const interval = refresh.getByLabel(SETTINGS_COPY.interval, { exact: true }); await interval.waitFor();
  const retention = page.getByRole("region", { name: SETTINGS_COPY.retention, exact: true });
  const pick = async (label) => { await retention.getByLabel(SETTINGS_COPY.keep, { exact: true }).click(); await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: label }).first().click(); };
  slow = 3000; const before = puts.length;
  await interval.fill("120"); await interval.press("Tab"); await page.waitForTimeout(100);
  await pick(SETTINGS_COPY.keepCustom);
  const custom = retention.getByLabel(SETTINGS_COPY.keepCustomLabel, { exact: true }); await custom.fill("20"); await custom.press("Enter");
  await pick(SETTINGS_COPY.keepDays(365));
  const dialog = page.getByRole("dialog", { name: SETTINGS_COPY.confirmTitle, exact: true }); await dialog.waitFor({ timeout: 8000 });
  assert.deepEqual(previews, ["365"]);
  await dialog.getByRole("button", { name: SETTINGS_COPY.cancel, exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await page.waitForTimeout(300); slow = 0;
  assert.deepEqual(puts.slice(before), [{ refreshIntervalSec: 120 }]);
  // 自定义 20：回车后紧接着离开，只预览一次、只弹一个确认框
  await pick(SETTINGS_COPY.keepCustom); await custom.fill("20"); await custom.press("Enter"); await custom.press("Tab");
  await dialog.waitFor();
  // 确认后存不进去：写「历史数据保留没存上」，回到一直保留
  failRetention = true;
  await dialog.getByRole("button", { name: SETTINGS_COPY.confirmOk, exact: true }).click();
  await retention.getByText(new RegExp(`^${notSaved(SETTINGS_COPY.retention)}：`)).waitFor();
  await retention.locator(`.ant-select-content[title="${SETTINGS_COPY.keepForever}"]`).waitFor();
  // 点了确认以后，第二次提交（Tab 那一次）也没有冒出来：还是只预览了两次、没有第二个确认框
  await page.waitForTimeout(800);
  assert.deepEqual(previews, ["365", "20"]); assert.equal(await page.getByRole("dialog", { name: SETTINGS_COPY.confirmTitle, exact: true }).count(), 0);
  failRetention = false;
  // 先成功存一次 365，把上面的「没存上」清掉
  await pick(SETTINGS_COPY.keepDays(365)); await dialog.waitFor(); await page.waitForTimeout(400);
  await dialog.getByRole("button", { name: SETTINGS_COPY.confirmOk, exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await until(async () => (await retention.getByText(new RegExp(`^${notSaved(SETTINGS_COPY.retention)}：`)).count()) === 0);
  assert.equal(await retention.getByText(new RegExp(`^${notSaved(SETTINGS_COPY.retention)}：`)).count(), 0);
  // 预览读不到：写没存上、回到 365，不弹确认框
  failPreview = true;
  await pick(SETTINGS_COPY.keepDays(90));
  await until(async () => previews.length >= 4);
  await retention.getByText(new RegExp(`^${notSaved(SETTINGS_COPY.retention)}：`)).waitFor();
  assert.equal(await page.getByRole("dialog", { name: SETTINGS_COPY.confirmTitle, exact: true }).count(), 0);
  await retention.locator(`.ant-select-content[title="${SETTINGS_COPY.keepDays(365)}"]`).waitFor();
});

test("告警中心通知方式没发出去：测试结果、日报发送结果按通知方式的说法写，原文各自进「查看详细原因」；没设置自营站点时预览说清楚、带「去设置」", async (t) => {
  let sends = 0;
  const channels = [
    { id: "c1", name: "运维群", type: "telegram", enabled: true, config: { botToken: "", chatId: "42", apiBase: "" }, hasSecret: { botToken: true } },
    { id: "c2", name: "", type: "dingtalk", enabled: true, config: { webhook: "", secret: "" }, hasSecret: { webhook: true } },
  ];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels, rules: { onLow: true, channelsFor: {} }, channelTypes: CHANNEL_TYPES });
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture({ dailyReport: { enabled: true, time: "09:00", channelIds: [] } }));
    // 测试发送：Telegram 说 Token 不对（原文是英文的 Unauthorized）
    if (url.pathname === "/api/notifications/test") return fulfill(route, { ok: false, error: "Unauthorized", code: "NOTIFY_AUTH_FAILED" });
    // 第一次两个都没发出去，第二次只有运维群发出去了
    if (url.pathname === "/api/report/send") return fulfill(route, { ok: true, results: sends++ === 0 ? [
      { id: "c1", name: "运维群", ok: false, error: "Unauthorized", code: "NOTIFY_AUTH_FAILED" },
      { id: "c2", name: "", ok: false, error: "keywords not in content", code: "NOTIFY_KEYWORD_MISSING" },
    ] : [
      { id: "c1", name: "运维群", ok: true },
      { id: "c2", name: "", ok: false, error: "keywords not in content", code: "NOTIFY_KEYWORD_MISSING" },
    ] });
    if (url.pathname === "/api/report/preview") return failJSON(route, 400, { error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" });
    throw new Error("unexpected notifications fixture API: " + url.pathname);
  }, undefined, false, null, "/notifications");
  // 列表里点「测试」：说通知方式自己的那句，不说上游的「登录信息不对或过期了」，原文进「查看详细原因」
  await page.getByRole("button", { name: NOTIFICATIONS_COPY.testAria("运维群"), exact: true }).first().click();
  const cell = page.locator(".jy-notifications-test").first();
  await cell.getByText(errorText({ code: "NOTIFY_AUTH_FAILED" }), { exact: true }).waitFor();
  assert.doesNotMatch(await cell.innerText(), new RegExp(ERROR_CATEGORIES.auth.text));
  await cell.getByText("查看详细原因", { exact: true }).click();
  await cell.getByText("Unauthorized", { exact: true }).waitFor();
  // 立即发送：每个没发出去的通知方式一行，没名字的写「未命名通知方式」，各带「查看详细原因」
  await page.getByRole("button", { name: NOTIFICATIONS_COPY.reportSend }).click();
  const result = page.locator(".jy-notifications-actions + div .jy-test-result--bad");
  await result.getByText(NOTIFICATIONS_COPY.reportNotSent, { exact: true }).waitFor();
  await result.getByText(`运维群：${errorText({ code: "NOTIFY_AUTH_FAILED" })}`).waitFor();
  await result.getByText(`${NOTIFICATIONS_COPY.unnamed}：${errorText({ code: "NOTIFY_KEYWORD_MISSING" })}`).waitFor();
  assert.equal(await result.getByText("查看详细原因", { exact: true }).count(), 2);
  assert.doesNotMatch(await result.innerText(), /c2：/);
  // 部分发出去了：不是红框，写「N 个通知方式里 M 个发出去了」，没发出去的那个照样一行、带「查看详细原因」
  await page.getByRole("button", { name: NOTIFICATIONS_COPY.reportSend }).click();
  const partial = page.locator(".jy-notifications-actions + div .jy-test-result");
  await partial.getByText(NOTIFICATIONS_COPY.reportSent(1, 2), { exact: true }).waitFor();
  assert.equal(await partial.evaluate((el) => el.classList.contains("jy-test-result--bad")), false);
  await partial.getByText(`${NOTIFICATIONS_COPY.unnamed}：${errorText({ code: "NOTIFY_KEYWORD_MISSING" })}`).waitFor();
  assert.equal(await partial.getByText("查看详细原因", { exact: true }).count(), 1);
  assert.doesNotMatch(await partial.innerText(), /运维群：/);
  // 预览：没设置自营站点时直接说 §8.1 那句、带「去设置」，不拼「读不到日报预览：」，显示在日报区块里
  await page.getByRole("button", { name: NOTIFICATIONS_COPY.reportPreview }).click();
  await result.getByText(OWN_STATION_UNSET, { exact: true }).waitFor();
  const setup = workflowAction("setup_own_station");
  assert.equal(await result.getByRole("link", { name: setup.label, exact: true }).getAttribute("href"), setup.href);
  assert.doesNotMatch(await result.innerText(), new RegExp(NOTIFICATIONS_COPY.previewFailed));
});

test("告警中心通知方式：接口不回传密钥；只改名字也能保存、不提交密钥；改了地址没重填时说清楚、不关弹窗", async (t) => {
  const code = "ENDPOINT_CHANGED_SECRET_REQUIRED";
  const telegram = { id: "c1", name: "运维群", type: "telegram", enabled: true, config: { botToken: "", chatId: "42", apiBase: "" }, hasSecret: { botToken: true } };
  const channelTypes = CHANNEL_TYPES.filter((type) => type.value === "telegram");
  const apiBaseLabel = channelTypes[0].fields.find((field) => field.key === "apiBase").label;
  const puts = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels: [telegram], rules: { onLow: true, channelsFor: {} }, channelTypes });
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture({ dailyReport: { enabled: false, time: "09:00", channelIds: [] } }));
    if (url.pathname === "/api/notifications/channels/c1" && method === "PUT") {
      const body = route.request().postDataJSON(); puts.push(body);
      return body.config.apiBase ? failJSON(route, 400, { error: errorText({ code }), code }) : fulfill(route, { channel: { ...telegram, name: body.name } });
    }
    throw new Error("unexpected notifications fixture API: " + method + " " + url.pathname);
  }, undefined, false, null, "/notifications");
  const openEdit = async () => {
    await page.getByRole("button", { name: NOTIFICATIONS_COPY.editAria("运维群"), exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: NOTIFICATIONS_COPY.editTitle, exact: true }); await dialog.waitFor();
    return dialog;
  };
  let dialog = await openEdit();
  // 密钥框从空开始，写「已保存」，下面说不填就接着用
  const token = dialog.getByLabel("Bot Token", { exact: true });
  assert.equal(await token.inputValue(), "");
  assert.equal(await token.getAttribute("placeholder"), SECRET_FIELD_TEXT.saved);
  await dialog.getByText(SECRET_FIELD_TEXT.keep(" Bot Token"), { exact: true }).waitFor();
  await dialog.getByLabel(NOTIFICATIONS_COPY.name, { exact: true }).fill("运维群2");
  await dialog.getByRole("button", { name: NOTIFICATIONS_COPY.save }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(puts[0], { name: "运维群2", type: "telegram", config: { botToken: "", chatId: "42", apiBase: "" } });

  dialog = await openEdit();
  await dialog.getByLabel(apiBaseLabel, { exact: true }).fill("https://evil.example");
  await dialog.getByRole("button", { name: NOTIFICATIONS_COPY.save }).click();
  await page.getByText(`${SAVE_FAILED}：${errorText({ code })}。`, { exact: true }).waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(puts[1].config.botToken, "");
});

test("余额趋势按业务时区写时间：横轴刻度落在业务时区的 0 点和整点，预计用完的时刻也按业务时区写，和浏览器所在时区无关", async (t) => {
  // 业务时区用加尔各答（UTC+5:30，不是默认的上海，也不是三个浏览器时区之一）：当地 10月10日 0:00 起每小时读一次，预计当地 3:30 用完
  const TZ = "Asia/Kolkata", HOUR = 3_600_000, T0 = Date.parse("2026-10-09T18:30:00Z"), eta = T0 + 3.5 * HOUR;
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { tz: TZ, stations: [{ id: "s1", name: "Alpha 上游", type: "newapi", baseUrl: "https://alpha.test", userId: "7", hasAccessToken: true, monitorEnabled: true,
      balance: { ok: true, remaining: 10, checkedAt: new Date(T0 + 2 * HOUR).toISOString() }, prediction: null, spark: [[T0, 12], [T0 + 2 * HOUR, 10]] }], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [], rules: {}, tz: TZ });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/stations/s1/history") {
      return fulfill(route, { points: [[T0, 12], [T0 + HOUR, 11], [T0 + 2 * HOUR, 10]], prediction: { burnPerDay: 24, etaDays: 0.06, etaAt: new Date(eta).toISOString() } });
    }
    throw new Error("unexpected API: " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  await page.getByRole("button", { name: "Alpha 上游 的余额趋势", exact: true }).first().click();
  const modal = page.getByRole("dialog", { name: "Alpha 上游 的余额趋势", exact: true }); await modal.waitFor();
  // 「约 10月10日 3:30 用完」：图例和读数两处
  await modal.getByText(`约 ${formatZonedDateTime(eta, TZ)} 用完`, { exact: true }).first().waitFor();
  // 横轴：当地 0 点写日期，其余是当地整点
  const ticks = await modal.locator('svg text[data-axis="x"]').allTextContents();
  assert.deepEqual(ticks, [formatDayKey("2026-10-10", TZ), ...[1, 2, 3].map((h) => formatZonedTime(T0 + h * HOUR, TZ))]);
});

test("编辑上游改了地址的站点：留空的令牌不带过去，测试读取说「换了地址…请重新填」", async (t) => {
  const code = "ENDPOINT_CHANGED_SECRET_REQUIRED";
  const tests = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [{ id: "s1", name: "Alpha 上游", type: "newapi", baseUrl: "https://alpha.test", userId: "7", hasAccessToken: true, monitorEnabled: true, balance: { ok: true, remaining: 10, checkedAt: "2026-10-09T07:00:00.000Z" }, prediction: null, spark: [] }], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/stations/test" && method === "POST") {
      tests.push(route.request().postDataJSON());
      return fulfill(route, { ok: false, code, category: "other", message: errorText({ code }), action: null });
    }
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations?edit=s1");
  const drawer = page.getByRole("dialog", { name: UPSTREAM_FORM_TEXT.editTitle("Alpha 上游"), exact: true }); await drawer.waitFor();
  await drawer.getByLabel(CREDENTIAL_FIELDS.baseUrl.label, { exact: true }).fill("https://evil.test");
  await drawer.getByRole("button", { name: TEST_READ }).click();
  await drawer.getByText(testReadText({ ok: false, reason: errorText({ code }) }), { exact: true }).waitFor();
  assert.equal(tests[0].baseUrl, "https://evil.test");
  assert.equal(tests[0].accessToken, "");
});

test("编辑固定成本的上游：用不到的汇率、余额提醒线、其他地址藏起来，保存时照原值带上，改回按用量算时还在；不再续费照旧写 false", async (t) => {
  const saves = [];
  const fixed = { id: "box", name: "服务器", type: "fixed", baseUrl: "", includeInProfit: true, costAliases: ["10.0.0.9:8080"], lowBalanceUsd: 3, noRenewal: true, cnyPerUsd: 7.2, monitorEnabled: true,
    fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }], balance: null, prediction: null, spark: [] };
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [fixed], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }, { value: "fixed", label: "固定成本", needs: [] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/stations/box" && method === "PUT") { saves.push(route.request().postDataJSON()); return fulfill(route, { ok: true }); }
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations?edit=box");
  const drawer = page.getByRole("dialog", { name: UPSTREAM_FORM_TEXT.editTitle("服务器"), exact: true }); await drawer.waitFor();
  assert.equal(await drawer.getByLabel("汇率", { exact: true }).isVisible(), false); assert.equal(await drawer.getByLabel("余额提醒线", { exact: true }).isVisible(), false);
  assert.equal(await drawer.getByLabel("渠道里用的其他地址", { exact: true }).isVisible(), false); assert.equal(await drawer.getByText("不再续费", { exact: true }).isVisible(), false);
  // 改成按用量算：原来的值照旧填着（藏起来时没丢）
  const pickType = async (label) => { await drawer.getByRole("combobox", { name: "类型", exact: true }).click(); await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: label }).first().click(); };
  await pickType("New API"); await drawer.getByLabel("汇率", { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel("汇率", { exact: true }).inputValue(), "7.2"); assert.equal(await drawer.getByLabel("余额提醒线", { exact: true }).inputValue(), "3");
  assert.equal(await drawer.getByLabel("渠道里用的其他地址", { exact: true }).inputValue(), "10.0.0.9:8080");
  // 改回固定成本、改一笔金额后保存：汇率、余额提醒线、其他地址照原值带上；不再续费一律 false（会关掉到期提醒，固定成本的表单里没有这个开关）
  await pickType("固定成本"); await drawer.getByLabel("第 1 笔金额（¥）", { exact: true }).fill("320");
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  for (let wait = 0; !saves.length && wait < 50; wait++) await page.waitForTimeout(100);
  assert.equal(saves.length, 1); assert.equal(saves[0].type, "fixed"); assert.equal(saves[0].fixedPurchases[0].amount, "320");
  assert.equal(saves[0].cnyPerUsd, "7.2"); assert.equal(saves[0].lowBalanceUsd, "3"); assert.deepEqual(saves[0].costAliases, ["10.0.0.9:8080"]); assert.equal(saves[0].noRenewal, false);
});

test("编辑自营站点：「汇率」那一格叫「售价」，只对上游有用的设置藏起来，保存时照旧带上原来的值", async (t) => {
  const saves = [];
  const own = { id: "own", name: "我的站", type: "newapi", baseUrl: "https://own.test", userId: "1", hasAccessToken: true, isOwn: true, includeInProfit: true, costAliases: ["10.0.0.8:8080"], lowBalanceUsd: 3, noRenewal: true, cnyPerUsd: 7.5, monitorEnabled: true, balance: { ok: true, remaining: 10, checkedAt: "2026-10-09T07:00:00.000Z" }, prediction: null, spark: [] };
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [own], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/stations/own" && method === "PUT") { saves.push(route.request().postDataJSON()); return fulfill(route, { ok: true }); }
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations?edit=own");
  const drawer = page.getByRole("dialog", { name: UPSTREAM_FORM_TEXT.editTitle("我的站"), exact: true }); await drawer.waitFor();
  // 自营站点那一格叫「售价」（ui-copy-spec §7），说明照售价写，不说余额提醒
  assert.equal(await drawer.getByLabel("售价", { exact: true }).inputValue(), "7.5"); await drawer.getByText(`${formatSellPrice(7.5)}。`, { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel("汇率", { exact: true }).count(), 0);
  // 「算进利润」「渠道里用的其他地址」藏起来；「余额提醒线」「不再续费」照旧显示（自营站点的余额也推送提醒）
  assert.equal(await drawer.getByText("算进利润", { exact: true }).isVisible(), false); assert.equal(await drawer.getByLabel("渠道里用的其他地址", { exact: true }).isVisible(), false);
  assert.equal(await drawer.getByLabel("余额提醒线", { exact: true }).inputValue(), "3"); assert.equal(await drawer.getByText("不再续费", { exact: true }).isVisible(), true);
  // 改售价后保存：藏起来的设置照旧带上原来的值，不清空（ui-design-spec §5.2）
  await drawer.getByLabel("售价", { exact: true }).fill("8"); await drawer.getByRole("button", { name: "保存", exact: true }).click();
  for (let wait = 0; !saves.length && wait < 50; wait++) await page.waitForTimeout(100);
  assert.equal(saves.length, 1); assert.equal(saves[0].cnyPerUsd, "8"); assert.equal(saves[0].isOwn, true); assert.equal(saves[0].includeInProfit, true);
  assert.deepEqual(saves[0].costAliases, ["10.0.0.8:8080"]); assert.equal(saves[0].lowBalanceUsd, "3"); assert.equal(saves[0].noRenewal, true);
});
