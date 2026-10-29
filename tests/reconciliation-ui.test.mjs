// Start the local dev server first. Set PLAYWRIGHT_MODULE to a Playwright module
// path when it is bundled outside this project, and PLAYWRIGHT_CHANNEL=msedge
// when Chromium is unavailable locally.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import realTest from "node:test";
import { after } from "node:test";
import assert from "node:assert/strict";
import { deriveKnownChannelCoverage, summarizeReconciliationWindowGroups } from "../lib/reconciliation-view.js";
import { BINDING_COPY, CREDENTIAL_FIELDS, ONBOARDING_KEY_ONLY_MONITOR, ONBOARDING_PURPOSES, ONBOARDING_PURPOSE_HINT, ONBOARDING_PURPOSE_REQUIRED, SECRET_FIELD_TEXT, UPSTREAM_FORM_TEXT, UPSTREAM_TYPES, normalizeBatchInput } from "../lib/channel-onboarding.js";
import { ADMIN_UNMARKED, BALANCE_STATE_TEXT, EMPTY, basisText, FIXED_COST_TEXT, INCOME_UNREAD, MINUS, NO_UPSTREAM_TEXT, OWN_STATION_UNSET, OWN_STATION_UNSET_TITLE, RANGE_TEXT, formatDayKey, RATE_UNSET_PARITY, RATE_UNSET_USD, SELL_PRICE_UNSET, formatCompact, formatRate, formatSellPrice, formatZonedDateTime, formatZonedTime, formatZonedWindow, formatMoney, refreshFailedText } from "../lib/format.js";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, INCOMPLETE_DAY_TEXT, coverageNeedsAnswer, fillIssueCopy, reconciliationChannelStatus, reconciliationIssue } from "../lib/reconciliation-contract.js";
import { DESTINATION_CHANGED, HISTORY_KEPT, testReadText, workflowAction, workflowActionMeta } from "../lib/workflow-actions.js";
import { CONSOLE_UNREACHABLE, ERROR_CATEGORIES, describeError, errorText, failureSentence, failureText } from "../lib/error-copy.js";
import { NAV_LABELS, STATION_TABS } from "../lib/brand.js";
import { CHANNEL_TYPES } from "../lib/notify.js";
import { costBasisOf } from "../lib/profit.js";
// 成本估算、用量分析页上的字（页面文件不能导出，放在同目录的 copy.ts；node 直接读 .ts）
import { COPY as ANALYTICS_COPY } from "../app/(dashboard)/analytics/copy.ts";
import { COPY as USAGE_COPY } from "../app/(dashboard)/usage/copy.ts";
import { COPY as SETTINGS_COPY } from "../app/(dashboard)/settings/copy.ts";
import { COPY as NOTIFICATIONS_COPY } from "../app/(dashboard)/notifications/copy.ts";
import { COPY as LOGIN_COPY } from "../app/login/copy.ts";
// 每日利润页上的字（一张对账表，app/(dashboard)/reconciliation/copy.ts）
import { COPY as PROFIT_COPY } from "../app/(dashboard)/reconciliation/copy.ts";

// 每一步操作的默认等待：CI 机器慢、几路同时跑时放宽到 10 秒（UI_STEP_TIMEOUT_MS），本地照旧 5 秒
const UI_STEP_TIMEOUT_MS = Number(process.env.UI_STEP_TIMEOUT_MS) || 5_000;
// 等用例自己造的 Promise（例如「页面已经发出这个请求」，在路由处理里 resolve）：Playwright 的等待管不到它，
// 页面那一下没发生就会一直等下去，整条用例卡到超时还看不出卡在哪。限时是每一步等待的 3 倍（本地 15 秒、CI 30 秒），到点报出在等什么
const WITHIN_MS = UI_STEP_TIMEOUT_MS * 3;
function within(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`等了 ${WITHIN_MS / 1000} 秒还没等到：${label}`)), WITHIN_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 分几路同时跑（CI、本地测试台）：UI_SHARDS 路时按注册顺序轮流分，这一路只登记 UI_SHARD 那一份；不设就全跑
const UI_SHARD = Number(process.env.UI_SHARD || 0), UI_SHARDS = Number(process.env.UI_SHARDS || 1);
let shardIndex = 0;
const test = UI_SHARDS > 1
  ? new Proxy(realTest, { apply: (target, self, args) => (shardIndex++ % UI_SHARDS === UI_SHARD ? Reflect.apply(target, self, args) : undefined) })
  : realTest;

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
    rule: { id, tokenName: name, upstreamStationId: "upstream-1", ownStationId: "own-1", ownSource: billingSource, enabled: true, billingPolicy: "immediate", costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] }, fixedGroup: "default", channels: [{ channelId: Number(id.slice(-1)), name: `Channel ${id}` }] },
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

// ---- 每日利润（一张对账表，app/(dashboard)/reconciliation）的夹具：POST /api/reconciliation/profit 的整页响应、GET …/profit/detail 的计算明细 ----
// 一行一个渠道，渠道名就叫 Rule A / Rule B…（openFixturePage 等第一行出来时找的也是它）。日子按业务时区：今天 10月9日，昨天 10月8日
const PROFIT_TZ = "Asia/Shanghai", PROFIT_TODAY = "2026-10-09", PROFIT_YESTERDAY = "2026-10-08", PROFIT_AS_OF = "2026-10-09T03:00:00.000Z";
const profitDayStart = (label) => Date.parse(`${label}T00:00:00+08:00`);
function profitRow(id, name, o = {}) {
  const channels = o.channels || [{ channelId: Number(id.slice(-1)), name }];
  const income = o.income ?? 2.5, cost = o.cost ?? 1, gapUsd = o.gapUsd ?? null;
  const dayState = gapUsd == null ? null : Math.abs(gapUsd) > 0.05 && (!o.expected || Math.abs(gapUsd / o.expected) > 0.02) ? (gapUsd > 0 ? "over" : "under") : "within";
  const state = o.attention ? "attention" : o.state || dayState || (o.reason ? "uncomputable" : "today");
  return {
    rowKey: `upstream-1:${id}`, ruleIds: [id], channels, upstream: { stationId: "upstream-1", name: "Fixture upstream", provider: "newapi" },
    key: { name, groupName: "default", groupRatio: 1, upstreamKeyUrl: null }, rates: { income: null, cost: null, costBasis: "usage" },
    startedOn: o.startedOn ?? null, startedAt: null, counted: !o.attention,
    incomeUsd: o.attention ? null : income, actualCostUsd: o.attention ? null : cost, grossProfitUsd: o.attention ? null : income - cost, uncountedIncomeUsd: o.attention ? income : null,
    expectedCostUsd: o.expected ?? null,
    gap: { usd: gapUsd, rate: gapUsd != null && o.expected ? gapUsd / o.expected : null, state, mismatchedDays: o.mismatchedDays || (dayState && dayState !== "within" ? [{ day: o.day || PROFIT_YESTERDAY, usd: gapUsd, state: dayState }] : []), days: o.days ?? (gapUsd != null ? 1 : 0), reason: o.reason || null, missingPriceModels: o.missing || [] },
    attention: o.attention || null, excludedDays: o.attention ? 1 : 0,
    daily: o.daily || (gapUsd != null ? [{ day: PROFIT_YESTERDAY, state: "fixed", gapUsd, gapState: dayState, reason: null, tokens: 720000 }]
      // 看今天：近 7 天——前 6 天已固定（只有昨天有差额，用 latest 的），最后一格今天
      : [...["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", PROFIT_YESTERDAY].map((day) => ({ day, state: "fixed", gapUsd: day === PROFIT_YESTERDAY ? o.latest?.usd ?? null : null, gapState: day === PROFIT_YESTERDAY ? o.latest?.state ?? null : null, reason: null, tokens: 720000 })), { day: PROFIT_TODAY, state: "today", gapUsd: null, gapState: null, reason: null, tokens: null }]),
    latestSettledGap: "latest" in o ? o.latest : gapUsd != null ? { day: PROFIT_YESTERDAY, usd: gapUsd, state: dayState, reason: null } : null,
  };
}
// preset：today（默认）/ yesterday / 7d；整页的数由各行加出来，和接口一样只加算进来的行、算得出差额的行
function profitPage(rows, o = {}) {
  const preset = o.preset || "today", today = preset === "today" || preset === "7d";
  const range = preset === "yesterday" ? { preset, startMs: profitDayStart(PROFIT_YESTERDAY), endMs: profitDayStart(PROFIT_TODAY), timezone: PROFIT_TZ }
    : preset === "7d" ? { preset, startMs: profitDayStart("2026-10-03"), endMs: Date.parse(PROFIT_AS_OF), timezone: PROFIT_TZ }
    : { preset: o.customPreset || preset, startMs: o.startMs ?? profitDayStart(PROFIT_TODAY), endMs: o.endMs ?? Date.parse(PROFIT_AS_OF), timezone: PROFIT_TZ };
  const counted = rows.filter((row) => row.counted), judged = rows.filter((row) => row.gap.usd != null);
  const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);
  const channelCount = (list) => sum(list, (row) => row.channels.length);
  const incomeUsd = counted.length ? sum(counted, (row) => row.incomeUsd) : null, actualCostUsd = counted.length ? sum(counted, (row) => row.actualCostUsd) : null;
  const overUsd = sum(judged, (row) => row.gap.state === "over" ? row.gap.usd : 0), underUsd = -sum(judged, (row) => row.gap.state === "under" ? row.gap.usd : 0), gapUsd = judged.length ? sum(judged, (row) => row.gap.usd) : null;
  const latestRows = rows.filter((row) => row.latestSettledGap);
  const uncomputable = {}; for (const row of rows) if (row.gap.reason) uncomputable[row.gap.reason] = (uncomputable[row.gap.reason] || 0) + row.channels.length;
  return {
    range, today: PROFIT_TODAY, dayCounts: preset === "yesterday" ? { fixed: 1, reading: 0, today: 0 } : preset === "7d" ? { fixed: 6, reading: 0, today: 1 } : { fixed: 0, reading: 0, today: 1 },
    pageTotals: { incomeUsd, actualCostUsd, grossProfitUsd: incomeUsd == null ? null : incomeUsd - actualCostUsd, grossMarginRate: incomeUsd ? (incomeUsd - actualCostUsd) / incomeUsd : null },
    gap: preset === "today" ? { days: { first: null, last: null, count: 0, contiguous: false }, expectedCostUsd: null, actualCostUsd: null, usd: null, overUsd: 0, underUsd: 0, withinUsd: 0, rowCount: 0 }
      : { days: preset === "7d" ? { first: "2026-10-03", last: PROFIT_YESTERDAY, count: 6, contiguous: true } : { first: PROFIT_YESTERDAY, last: PROFIT_YESTERDAY, count: 1, contiguous: true }, expectedCostUsd: judged.length ? sum(judged, (row) => row.expectedCostUsd) : null, actualCostUsd: judged.length ? sum(judged, (row) => row.actualCostUsd) : null,
        usd: gapUsd, overUsd, underUsd, withinUsd: gapUsd == null ? 0 : gapUsd - overUsd + underUsd, rowCount: judged.length },
    latestSettledGap: preset === "today" && latestRows.length ? { day: PROFIT_YESTERDAY, usd: sum(latestRows, (row) => row.latestSettledGap.usd), mismatchedRowCount: latestRows.filter((row) => ["over", "under"].includes(row.latestSettledGap.state)).length } : null,
    counts: { channels: channelCount(rows), countedChannels: channelCount(counted), mismatchedChannels: channelCount(rows.filter((row) => ["over", "under"].includes(preset === "today" ? row.latestSettledGap?.state : row.gap.state))), attentionChannels: channelCount(rows.filter((row) => row.attention)), uncomputable, mismatchedDays: { over: judged.filter((row) => row.gap.state === "over").length, under: judged.filter((row) => row.gap.state === "under").length } },
    gapThreshold: { usd: 0.05, rate: 0.02 }, rows, asOf: o.asOf || PROFIT_AS_OF, tz: PROFIT_TZ, displayCurrency: "USD", fixedCostUsd: o.fixedCostUsd ?? 0.5, netProfitUsd: incomeUsd == null ? null : incomeUsd - actualCostUsd - (o.fixedCostUsd ?? 0.5),
    ownIncomeUnavailable: o.ownIncomeUnavailable || null, unaccountedUpstreamCostUsd: o.unaccounted ?? null, unlinkedChannelCount: o.unlinked ?? 0, rateUnset: o.rateUnset || [], fixedOffProfitStations: [],
  };
}
function profitDetail(o = {}) {
  return { day: PROFIT_YESTERDAY, settled: true, income: { usd: 2.5, adminUsage: { usd: 0.12, deducted: "all" }, byChannel: [{ channelId: 1, usd: 2.5 }] },
    expected: { usd: 1, reason: null, groupName: "default", groupRatio: 1, segments: [], byModel: [{ model: "gpt-4o", upstreamModel: null, requests: 3, inputTokens: 600000, outputTokens: 120000, cacheReadTokens: 0, cacheWriteTokens: 0, pricesPerMillion: { input: 2.5, output: 10, cacheRead: null, cacheWrite: null }, beforeRatioUsd: 1, usd: 1 }], missingPriceModels: [], byChannel: [], tokens: 720000 },
    actual: { usd: 1.2, keyName: "Rule A" }, gap: { usd: 0.2, rate: 0.2, state: "over" }, grossProfitUsd: 1.3, fixedAt: "2026-10-09T00:05:00.000Z", revisions: 1, ...o };
}
// 昨天（全固定）的三行：Rule A 多扣对不上、Rule B 门槛以内、Rule C 少扣对不上
const yesterdayRows = () => [profitRow("rule-1", "Rule A", { expected: 1, cost: 1.2, gapUsd: 0.2 }), profitRow("rule-2", "Rule B", { expected: 1, cost: 1.01, gapUsd: 0.01 }), profitRow("rule-3", "Rule C", { expected: 1, cost: 0.9, gapUsd: -0.1 })];
const todayRows = () => [profitRow("rule-1", "Rule A", { latest: { day: PROFIT_YESTERDAY, usd: 0.2, state: "over", reason: null } }), profitRow("rule-2", "Rule B", { latest: { day: PROFIT_YESTERDAY, usd: 0.01, state: "within", reason: null } }),
  // 今天 9:30 才开始算的新渠道：昨天还没开始算
  { ...profitRow("rule-3", "Rule C", { latest: null }), startedOn: PROFIT_TODAY, startedAt: Date.parse("2026-10-09T01:30:00.000Z") }];
const profitConfiguration = (rows) => ({ ...configuration, ownStation: { id: "own-1", cnyPerUsd: 7 }, rules: rows.map((row) => ({ id: row.ruleIds[0], tokenName: row.key.name, upstreamStationId: "upstream-1", ownStationId: "own-1", enabled: true, archivedAt: null, timezone: PROFIT_TZ, channels: row.channels })) });
// 打开每日利润页：记下整页请求的 body（profitReads）、/query 的 body（queries）、计算明细的参数（detailReads）；pageOf(body) 按请求的范围给整页
async function openDailyPage(t, options = {}) {
  const profitReads = [], queries = [], detailReads = [], rows = options.rows || todayRows();
  const pageOf = options.pageOf || ((body) => body.preset === "yesterday" ? profitPage(yesterdayRows(), { preset: "yesterday" }) : profitPage(rows, { preset: body.preset === "7d" || body.preset === "month" ? "7d" : "today", customPreset: body.preset, ...(body.preset === "custom" ? { startMs: body.startMs, endMs: body.endMs } : {}), ...options.pageOptions }));
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, options.configuration || profitConfiguration(rows));
    if (url.pathname === "/api/settings") return fulfill(route, { settings: {}, tz: PROFIT_TZ, ownLog: options.ownLog ?? null });
    // 侧栏数需处理的条数
    if (url.pathname === "/api/reconciliation" && method === "GET") return fulfill(route, { actions: [] });
    if (url.pathname === "/api/reconciliation/profit") { const body = route.request().postDataJSON(); profitReads.push(body); return options.profit ? options.profit(route, body, profitReads.length) : fulfill(route, pageOf(body)); }
    if (url.pathname === "/api/reconciliation/query") { const body = route.request().postDataJSON(); queries.push(body); return options.query ? options.query(route, body) : fulfill(route, { results: [] }); }
    // 计算明细里「改时间」读倍率变化记录（options.segments）
    if (/^\/api\/reconciliation\/rules\/[^/]+\/segments$/.test(url.pathname) && method === "GET") return fulfill(route, { segments: options.segments || [] });
    if (url.pathname === "/api/reconciliation/profit/detail") { const params = Object.fromEntries(url.searchParams); detailReads.push(params); return options.detail ? options.detail(route, params) : fulfill(route, profitDetail({ day: params.day })); }
    // 手动选 Key：默认没有（目录没读到），用例里传 channelOptions 才出下拉框
    if (url.pathname === "/api/reconciliation/channels/options") return fulfill(route, options.channelOptions || { ok: false, code: "CHANNEL_CATALOGUE_STALE" });
    if (options.extraAPI) return options.extraAPI(route, url.pathname);
    throw new Error("unexpected daily fixture API: " + url.pathname);
  }, options.viewport, options.clock, null, options.path);
  return { page, profitReads, queries, detailReads };
}
// 页面上的字都来自 copy.ts（页面文件不能导出）和共用的常量，这里只填夹具的数
const metricOf = (page, title) => page.locator(".jy-profit-metric").filter({ has: page.getByText(title, { exact: true }) });
const rowOf = (page, name) => page.locator(`.jy-profit-row[data-row-key]`).filter({ has: page.locator(".jy-profit-row__toggle", { hasText: name }) });
const cardOf = (page, name) => page.locator(".jy-profit-card").filter({ has: page.locator(".jy-profit-card__top", { hasText: name }) });
const presets = (page) => page.getByRole("group", { name: PROFIT_COPY.rangeLabel, exact: true });
const pickPreset = (page, label) => presets(page).getByRole("button", { name: label, exact: true }).filter({ visible: true }).click();
const filterSeg = (page) => page.getByRole("group", { name: PROFIT_COPY.table.filterLabel, exact: true });

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
  await page.getByRole("button", { name: new RegExp(`^${PROFIT_COPY.expanded.dayCell("10月8日")}`) }).first().click();
  const drawer = page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule A", "10月8日"), exact: true });
  const timing = drawer.getByRole("region", { name: "改时间", exact: true });
  await timing.waitFor();
  await timing.getByText("保存以后，改到的那几天会按新的时间重新算，已经固定的也一样。31 天以前的不自动重算；要按新的时间算，到每日利润选那天点「重新读取」。", { exact: true }).waitFor();
  const input = timing.getByPlaceholder("倍率变化的时间");
  await input.fill("2026年10月8日 09:30");
  await input.press("Enter");
  await timing.getByRole("button", { name: "改时间", exact: true }).click();
  await page.getByText("时间已修改，但最新结果没读到，请重新读取", { exact: true }).waitFor();
  assert.equal(saved, 1);
  assert.equal(await page.getByText("已修改，受影响的日子已重算", { exact: true }).count(), 0);
});

test("每日利润默认打开今天：整页一次 POST /profit；页顶一句；四个数；表没有应付成本列、最后一列是昨天的差额；今天写「明天出」不写 0；合计只加算进来的、等于顶上第一个数", async (t) => {
  const { page, profitReads, queries } = await openDailyPage(t);
  assert.deepEqual(profitReads, [{ preset: "today" }]); assert.equal(queries.length, 0);
  await page.locator(".jy-profit-caption").getByText("10月9日 0:00–11:00 · " + PROFIT_COPY.todayCaption, { exact: true }).waitFor();
  const gross = metricOf(page, PROFIT_COPY.metric.grossToday); await gross.getByText("$4.50", { exact: true }).waitFor();
  await gross.getByText(PROFIT_COPY.metric.equation("$7.50", "$3.00"), { exact: true }).waitFor(); await gross.getByText(PROFIT_COPY.metric.netToday("$0.50", "$4.00"), { exact: true }).waitFor();
  await metricOf(page, PROFIT_COPY.metric.gapToday).getByText(PROFIT_COPY.metric.tomorrow, { exact: true }).waitFor();
  const latest = metricOf(page, PROFIT_COPY.metric.lessThanExpectedDay("昨天")); await latest.getByText("$0.21", { exact: true }).waitFor(); await latest.locator("p", { hasText: PROFIT_COPY.metric.mismatchedChannelsLink(1) }).waitFor();
  await metricOf(page, PROFIT_COPY.metric.uncounted).getByText(PROFIT_COPY.metric.allCounted, { exact: true }).waitFor();
  // 表头：渠道、收入、上游成本、毛利、昨天的差额；没有应付成本
  const headers = await page.locator(".jy-profit-table thead th").allInnerTexts();
  assert.deepEqual(headers.map((text) => text.replace(/\s+/g, "")), [PROFIT_COPY.table.col.channel, PROFIT_COPY.table.col.income, PROFIT_COPY.table.col.actual, PROFIT_COPY.table.col.gross, PROFIT_COPY.table.col.margin, PROFIT_COPY.table.yesterdayGap]);
  const rowA = rowOf(page, "Rule A"); await rowA.locator(".jy-profit-gap__main", { hasText: "多扣 $0.20" }).waitFor(); await rowA.locator(".jy-profit-tag", { hasText: PROFIT_COPY.gap.tag }).waitFor(); assert.ok((await rowA.getAttribute("class")).includes("jy-profit-row--over"));
  await rowOf(page, "Rule B").getByText("+$0.01", { exact: true }).waitFor();
  // 昨天还没开始算的渠道写原因，不写 $0.00
  await rowOf(page, "Rule C").getByText(PROFIT_COPY.gap.yesterdayNotStarted, { exact: true }).waitFor(); assert.equal(await page.getByText("$0.00", { exact: true }).count(), 0);
  await rowOf(page, "Rule C").getByText(`Fixture upstream · ${PROFIT_COPY.table.keyName("Rule C")} · ${PROFIT_COPY.table.group("default", "1.0")} · ${PROFIT_COPY.table.startedToday("9:30")}`, { exact: true }).waitFor();
  const totals = page.locator(".jy-profit-totals"); await totals.getByText(PROFIT_COPY.table.totals(3), { exact: true }).waitFor(); await totals.getByText("$4.50", { exact: true }).waitFor(); await totals.getByText("$7.50", { exact: true }).waitFor();
  // 对不上的行默认展开：「差在哪」写昨天（Token 和差额），接「今天的明天出」；近 7 天七个小格，最后一格今天「明天出」
  const expanded = page.locator(".jy-profit-row__expanded").first(); await expanded.getByText(`${PROFIT_COPY.expanded.latestDay("昨天", "72 万", "多扣 $0.20")}${PROFIT_COPY.expanded.todayTomorrow}`, { exact: true }).waitFor();
  const days = expanded.getByRole("group", { name: PROFIT_COPY.expanded.dailyTitle, exact: true }); assert.equal(await days.locator(".jy-profit-day").count(), 7); await days.getByRole("button", { name: `${PROFIT_COPY.expanded.dayCell("10月9日")} ${PROFIT_COPY.gap.tomorrow}`, exact: true }).waitFor();
  // 标题旁的数是灰色徽标
  assert.ok((await page.locator(".jy-profit-panel .jy-count-badge").getAttribute("class")).includes("jy-count-badge--muted"));
  // 没有需处理区块、日条、按天看、等式
  assert.equal(await page.locator(".jy-attention, .jy-eq, .jy-equation").count(), 0); assert.equal(await page.getByText("按天看", { exact: true }).count(), 0);
});

test("切昨天：五个数一行（收入、应付成本、上游成本、差额、毛利），对不上的行红底 / 蓝底带标签，门槛以内灰字；比预期少赚拆成多扣、少扣、门槛以内；筛选和合计按渠道数", async (t) => {
  const { page, profitReads } = await openDailyPage(t);
  await pickPreset(page, PROFIT_COPY.presets.yesterday);
  await page.locator(".jy-profit-caption").getByText("10月8日 周四 · " + PROFIT_COPY.fixed, { exact: true }).waitFor(); assert.deepEqual(profitReads.at(-1), { preset: "yesterday" });
  const headers = await page.locator(".jy-profit-table thead th").allInnerTexts();
  assert.deepEqual(headers.map((text) => text.replace(/\s+/g, "")), [PROFIT_COPY.table.col.channel, PROFIT_COPY.table.col.income, PROFIT_COPY.table.col.expected, PROFIT_COPY.table.col.actual, `${PROFIT_COPY.table.col.gap}${PROFIT_COPY.table.col.gapSub}`.replace(/\s+/g, ""), PROFIT_COPY.table.col.gross, PROFIT_COPY.table.col.margin]);
  const less = metricOf(page, PROFIT_COPY.metric.lessThanExpected); await less.getByText("$0.11", { exact: true }).waitFor(); await less.getByText(PROFIT_COPY.metric.gapBreakdown("$0.20", "$0.10", "+$0.01"), { exact: true }).waitFor(); await less.getByText(PROFIT_COPY.metric.gapRows(3), { exact: true }).waitFor();
  await metricOf(page, PROFIT_COPY.metric.mismatched).getByText(PROFIT_COPY.metric.channels(2), { exact: true }).waitFor();
  assert.ok((await less.getAttribute("class")).includes("jy-profit-metric--crit")); assert.ok(!(await metricOf(page, PROFIT_COPY.metric.mismatched).getAttribute("class")).includes("jy-profit-metric--crit"));
  const rowA = rowOf(page, "Rule A"), rowC = rowOf(page, "Rule C");
  await rowA.locator(".jy-profit-gap__main", { hasText: "多扣 $0.20" }).waitFor(); await rowA.getByText(PROFIT_COPY.gap.overRate("20%"), { exact: true }).waitFor(); assert.ok((await rowA.getAttribute("class")).includes("jy-profit-row--over"));
  await rowC.locator(".jy-profit-gap__main", { hasText: "少扣 $0.10" }).waitFor(); await rowC.getByText(PROFIT_COPY.gap.underRate("10%"), { exact: true }).waitFor(); assert.ok((await rowC.getAttribute("class")).includes("jy-profit-row--under"));
  assert.ok(!(await rowOf(page, "Rule B").getAttribute("class")).includes("jy-profit-row--"));
  // 金额不上色：对不上靠标签，数字还是墨色
  assert.equal(await rowA.locator(".jy-profit-gap__main").evaluate((node) => getComputedStyle(node).color), await rowOf(page, "Rule B").locator(".jy-profit-num").first().evaluate((node) => getComputedStyle(node).color));
  // 筛选：全部 3 / 对不上 2 / 需处理 0，0 也能点
  const seg = filterSeg(page); await seg.getByRole("button", { name: `${PROFIT_COPY.table.filterMismatched} 2`, exact: true }).click(); assert.equal(await page.locator(".jy-profit-row[data-row-key]").count(), 2);
  await seg.getByRole("button", { name: `${PROFIT_COPY.table.filterAttention} 0`, exact: true }).click(); await page.getByText(PROFIT_COPY.table.noMatch, { exact: true }).waitFor();
  await seg.getByRole("button", { name: `${PROFIT_COPY.table.filterAll} 3`, exact: true }).click();
  const totals = page.locator(".jy-profit-totals"); await totals.getByText(PROFIT_COPY.table.totals(3), { exact: true }).waitFor(); await totals.getByText("$3.00", { exact: true }).waitFor(); await totals.getByText("+$0.11", { exact: true }).waitFor();
  assert.equal(profitReads.length, 2, "筛选不再请求");
});

test("点开一行：对不上的默认展开，「差在哪」一句写用量、倍率、应付和实付；近 7 天每天的小格，点一格或「看计算明细」打开那天的计算明细抽屉（GET /profit/detail）", async (t) => {
  const { page, detailReads } = await openDailyPage(t, { pageOf: () => profitPage(yesterdayRows(), { preset: "yesterday" }) });
  const rowA = rowOf(page, "Rule A"), rowB = rowOf(page, "Rule B");
  assert.equal(await rowA.locator(".jy-profit-row__toggle").getAttribute("aria-expanded"), "true"); assert.equal(await rowB.locator(".jy-profit-row__toggle").getAttribute("aria-expanded"), "false");
  const expanded = page.locator(".jy-profit-row__expanded").first(); await expanded.getByText(PROFIT_COPY.expanded.where, { exact: true }).waitFor();
  await expanded.getByText(PROFIT_COPY.expanded.single("72 万", "default 分组 ×1.0", "$1.00", "$1.20"), { exact: true }).waitFor();
  const days = expanded.getByRole("group", { name: PROFIT_COPY.expanded.dailyTitle, exact: true }); await days.getByRole("button", { name: `${PROFIT_COPY.expanded.dayCell("10月8日")} +0.20`, exact: true }).waitFor();
  // 第一版没有上游后台地址，不出「到上游后台查这把 Key」
  assert.equal(await expanded.getByText(PROFIT_COPY.expanded.upstreamKey, { exact: true }).count(), 0);
  await expanded.getByRole("button", { name: PROFIT_COPY.expanded.seeDetail, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule A", "10月8日"), exact: true }); await drawer.waitFor();
  assert.deepEqual(detailReads, [{ ruleIds: "rule-1", day: PROFIT_YESTERDAY }]);
  await drawer.getByText(`${PROFIT_COPY.detail.incomeFrom("Rule A")}，${PROFIT_COPY.detail.adminAll("$0.12")}。`, { exact: true }).waitFor();
  await drawer.getByText(PROFIT_COPY.detail.expectedIntro("Fixture upstream", "default 分组 ×1.0"), { exact: true }).waitFor();
  const models = drawer.locator(".jy-profit-models"); await models.getByText("gpt-4o", { exact: true }).waitFor(); await models.locator("td", { hasText: PROFIT_COPY.detail.usage("60 万", "12 万") }).waitFor(); await models.locator("td small", { hasText: PROFIT_COPY.detail.unitPrice("$2.50", "$10") }).waitFor();
  await drawer.getByText(PROFIT_COPY.detail.actualFrom("Rule A"), { exact: true }).waitFor(); await drawer.getByText("多扣 $0.20", { exact: true }).waitFor(); await drawer.getByText(PROFIT_COPY.detail.ratioSame("default 分组 ×1.0"), { exact: true }).waitFor();
  await drawer.getByText("10月9日 8:05", { exact: true }).waitFor(); await drawer.getByText(PROFIT_COPY.detail.notRevised, { exact: true }).waitFor();
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
  // 收起、再展开 Rule B，点它的小格
  await rowB.locator(".jy-profit-row__toggle").click(); await page.locator(".jy-profit-row__expanded").nth(1).getByRole("button", { name: `${PROFIT_COPY.expanded.dayCell("10月8日")} ${PROFIT_COPY.expanded.dot}`, exact: true }).click();
  await page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule B", "10月8日"), exact: true }).waitFor(); assert.deepEqual(detailReads.at(-1), { ruleIds: "rule-2", day: PROFIT_YESTERDAY });
});

test("需处理那一行：原因、附注和按钮同一行，差额写「—」，收入照写、实付「读不到」、不进合计；「重新读取」只读这一行（/query 带 observe）再读整页；顶上「没算进来」点名是哪个", async (t) => {
  const attention = { code: "KEY_INVALID_OR_DENIED", title: reconciliationIssue("KEY_INVALID_OR_DENIED").title, detail: reconciliationIssue("KEY_INVALID_OR_DENIED").detail, action: workflowAction("update_authorization", { stationId: "upstream-1" }), fromDay: "2026-10-01", moreCount: 1 };
  const retryable = { ...attention, code: "OWN_BILLING_UNAVAILABLE", title: reconciliationIssue("OWN_BILLING_UNAVAILABLE").title, detail: "", action: workflowAction("retry_bill", { ruleId: "rule-3", window }, { code: "WAITING_FOR_BILL" }), moreCount: 0 };
  const rows = [profitRow("rule-1", "Rule A", { expected: 1, cost: 1.2, gapUsd: 0.2 }), profitRow("rule-2", "Rule B", { attention, channels: [{ channelId: 2, name: "Rule B" }, { channelId: 4, name: "Rule D" }] }), profitRow("rule-3", "Rule C", { attention: retryable })];
  const { page, queries, profitReads } = await openDailyPage(t, { rows, pageOf: () => profitPage(rows, { preset: "yesterday" }) });
  const rowB = rowOf(page, "Rule B、Rule D"); assert.ok((await rowB.getAttribute("class")).includes("jy-profit-row--attention"));
  // 看今天时需处理那一行同样带「· 10月1日起没算进利润」
  const today = await openDailyPage(t, { rows: [rows[0], rows[1]], pageOf: () => profitPage([rows[0], rows[1]]) });
  await today.page.locator(".jy-profit-attention").filter({ hasText: attention.title }).getByText(new RegExp(` · ${PROFIT_COPY.attention.since("10月1日")} · `)).waitFor();
  await rowB.getByText("$2.50", { exact: true }).waitFor(); await rowB.getByText(PROFIT_COPY.table.unreadable, { exact: true }).waitFor(); assert.equal(await rowB.locator(".jy-profit-num").filter({ hasText: EMPTY }).count(), 4); // 差额、毛利、毛利率（新加的一列）和应付成本这几格都写「—」
  await page.locator(".jy-profit-attention").filter({ hasText: attention.title }).getByText(`${PROFIT_COPY.attention.prefix}${attention.title}。${attention.detail} · ${PROFIT_COPY.attention.since("10月1日")} · ${PROFIT_COPY.attention.more(1)}`, { exact: true }).waitFor();
  const update = page.getByRole("link", { name: `${UPDATE_AUTH} Rule B、Rule D`, exact: true }); assert.equal(await update.getAttribute("href"), attention.action.href);
  // 排序：多扣的在前、需处理第二；筛选「需处理 3」按渠道数
  assert.deepEqual(await page.locator(".jy-profit-row__toggle strong").allInnerTexts(), ["Rule A", "Rule B、Rule D", "Rule C"]);
  await filterSeg(page).getByRole("button", { name: `${PROFIT_COPY.table.filterAttention} 3`, exact: true }).waitFor();
  const uncounted = metricOf(page, PROFIT_COPY.metric.uncomputable); await uncounted.getByText(PROFIT_COPY.metric.channels(0), { exact: true }).waitFor(); await uncounted.getByText(PROFIT_COPY.metric.attentionCount(3), { exact: true }).waitFor();
  const totals = page.locator(".jy-profit-totals"); await totals.getByText(PROFIT_COPY.table.totals(1), { exact: true }).waitFor(); await totals.getByText("$2.50", { exact: true }).waitFor();
  // 重新读取：只带这一行的绑定、带 observe，然后再读整页
  await page.getByRole("button", { name: `${RETRY} Rule C`, exact: true }).click(); await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
  assert.deepEqual(queries, [{ preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: ["rule-3"], observe: true }]); assert.equal(profitReads.length, 2);
});

test("空和出错：还没有在算利润的渠道时表的位置写一句加「开始算利润」（没设置自营站点时是「设置自营站点」）；刷新失败页顶一条、下面照旧显示上次的数；读不到自营站点的收入时页顶一条", async (t) => {
  const empty = await openDailyPage(t, { rows: [], pageOf: () => profitPage([]), path: "/reconciliation" });
  await empty.page.getByText(PROFIT_COPY.table.emptyTitle, { exact: true }).waitFor(); await empty.page.getByText(PROFIT_COPY.table.emptyDesc, { exact: true }).waitFor();
  assert.equal(await empty.page.getByRole("link", { name: PROFIT_COPY.table.startCounting, exact: true }).getAttribute("href"), "/stations?view=accounts"); assert.equal(await empty.page.locator(".jy-profit-summary").count(), 0);
  const unset = await openDailyPage(t, { rows: [], pageOf: () => profitPage([]), configuration: { ...configuration, ownStation: null, rules: [] }, path: "/reconciliation" });
  await unset.page.getByRole("link", { name: PROFIT_COPY.table.setupOwnStation, exact: true }).waitFor();
  // 刷新失败：第一次读到，刷新时 503
  let fail = false;
  const failing = await openDailyPage(t, { profit: (route, body) => fail ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture reload failed" }) }) : fulfill(route, profitPage(todayRows())) });
  fail = true; await failing.page.getByRole("button", { name: "刷新当前页面数据", exact: true }).click();
  await failing.page.locator(".jy-banner").getByText(refreshFailedText(Date.parse(PROFIT_AS_OF), PROFIT_TZ), { exact: true }).waitFor(); await rowOf(failing.page, "Rule A").locator(".jy-profit-gap__main", { hasText: "多扣 $0.20" }).waitFor();
  assert.deepEqual(failing.queries, [{ preset: "today", observe: true }]);
  // 读不到自营站点的收入：和运营总览同一句，收入、毛利写「—」，上游成本照常
  const rows = todayRows().map((row) => ({ ...row, incomeUsd: null, grossProfitUsd: null }));
  const unread = await openDailyPage(t, { rows, pageOf: () => ({ ...profitPage(rows, { ownIncomeUnavailable: { code: "OWN_INCOME_UNCONFIRMED" } }), pageTotals: { incomeUsd: null, actualCostUsd: 3, grossProfitUsd: null, grossMarginRate: null }, netProfitUsd: null }) });
  await unread.page.locator(".jy-banner").getByText(`${INCOME_UNREAD.title}：${describeError({ code: "OWN_INCOME_UNCONFIRMED" }).text}。`, { exact: true }).waitFor();
  await rowOf(unread.page, "Rule A").getByText("$1.00", { exact: true }).waitFor(); assert.equal(await rowOf(unread.page, "Rule A").locator(".jy-profit-num").filter({ hasText: EMPTY }).count(), 3); // 收入读不到：收入、毛利、毛利率三格「—」
});

test("表下面一行：没算进利润的上游成本、还没算利润的渠道、没设置汇率、收费记录读到哪儿了（落后 1 小时以上才写，链到系统设置）", async (t) => {
  const { page } = await openDailyPage(t, { pageOptions: { unaccounted: 3.1, unlinked: 2, rateUnset: [{ id: "upstream-1", name: "Fixture upstream" }] }, ownLog: { coveredToMs: Date.parse(PROFIT_AS_OF) - 2 * 3600000, behindMs: 2 * 3600000 } });
  const notes = page.locator(".jy-profit-notes"); await notes.locator("span", { hasText: PROFIT_COPY.notice.unaccounted("$3.10") }).waitFor(); await notes.locator("span", { hasText: PROFIT_COPY.notice.unlinked(2) }).waitFor(); await notes.getByText(RATE_UNSET_USD, { exact: true }).waitFor();
  await notes.locator("span", { hasText: /自营站点的收费记录读得慢，只读到 (10月9日 )?9:00，这以后的应付成本还没算。/ }).waitFor(); assert.equal(await notes.getByRole("link", { name: PROFIT_COPY.notice.goSettings, exact: true }).getAttribute("href"), "/settings");
  const fresh = await openDailyPage(t, { ownLog: { coveredToMs: Date.parse(PROFIT_AS_OF) - 60000, behindMs: 60000 } }); await rowOf(fresh.page, "Rule A").waitFor(); assert.equal(await fresh.page.locator(".jy-profit-notes").count(), 0);
});

test("近 7 天 / 本月：不出应付成本列；差额只加已固定的日子，表头写「已固定的 6 天（10月3日–10月8日）」，行上写「其中 2 天对不上」；今天开始的渠道差额「明天出」，名字下面写「今天开始算」", async (t) => {
  const rows = [profitRow("rule-1", "Rule A", { gapUsd: 0.3, expected: 6, days: 6, mismatchedDays: [{ day: "2026-10-07", usd: 0.1, state: "over" }, { day: PROFIT_YESTERDAY, usd: 0.2, state: "over" }] }), profitRow("rule-2", "Rule B", { gapUsd: 0.01, expected: 6, days: 6 }),
    { ...profitRow("rule-3", "Rule C", { latest: null }), startedOn: PROFIT_TODAY }];
  const { page } = await openDailyPage(t, { rows, pageOf: (body) => profitPage(rows, { preset: "7d", customPreset: body.preset }), path: "/reconciliation" });
  await pickPreset(page, PROFIT_COPY.presets["7d"]);
  await page.locator(".jy-profit-caption").getByText(`10月3日–10月9日 · ${PROFIT_COPY.daysFixed(6)}，${PROFIT_COPY.todayLive}`, { exact: true }).waitFor();
  const headers = await page.locator(".jy-profit-table thead th").allInnerTexts();
  assert.deepEqual(headers.map((text) => text.replace(/\s+/g, "")), [PROFIT_COPY.table.col.channel, PROFIT_COPY.table.col.income, PROFIT_COPY.table.col.actual, PROFIT_COPY.table.col.gross, PROFIT_COPY.table.col.margin, `${PROFIT_COPY.table.col.gap}${PROFIT_COPY.table.gapFixedDaysRange(6, "10月3日–10月8日")}`.replace(/\s+/g, "")]);
  const rowA = rowOf(page, "Rule A"); await rowA.locator(".jy-profit-gap__main", { hasText: "多扣 $0.30" }).waitFor(); await rowA.getByText(PROFIT_COPY.gap.mismatchedDaysIn(2), { exact: true }).waitFor();
  await metricOf(page, PROFIT_COPY.metric.lessThanExpectedFixed(6)).getByText("$0.31", { exact: true }).waitFor();
  const rowC = rowOf(page, "Rule C"); await rowC.getByText(PROFIT_COPY.gap.tomorrow, { exact: true }).waitFor(); await rowC.getByText(new RegExp(` · ${PROFIT_COPY.table.startedTodayShort}$`)).waitFor();
});

test("手机 390：顶上一张卡片（毛利大字、底下一行昨天的差额和「看昨天」）、筛选一排、一个渠道一张卡片；点开五个数竖排、小格横滑、「看计算明细」整屏；不横向滚动", async (t) => {
  const { page, profitReads } = await openDailyPage(t, { viewport: { width: 390, height: 844 } });
  const summary = page.locator(".jy-profit-summary--mobile"); await summary.getByText(PROFIT_COPY.metric.grossTodayMobile, { exact: true }).waitFor(); await summary.getByText("$4.50", { exact: true }).waitFor();
  await summary.locator(".jy-profit-summary__foot").getByText(`${PROFIT_COPY.metric.lessThanExpectedDay("昨天")} $0.21 · ${PROFIT_COPY.metric.mismatchedChannelsLink(1)}`, { exact: true }).waitFor();
  assert.equal(await page.locator(".jy-profit-table").count(), 0);
  const cardA = cardOf(page, "Rule A"); await cardA.getByText("$1.50", { exact: true }).waitFor(); await cardA.getByText(PROFIT_COPY.table.mobileIncomeActual("$2.50", "$1.00"), { exact: true }).waitFor();
  // 差额那一行写成一行「昨天差额 多扣 $0.20 [对不上]」「昨天差额 —（昨天还没开始算）」；卡片一律默认收起（桌面才默认展开对不上的）
  await cardA.locator(".jy-profit-card__line", { hasText: PROFIT_COPY.table.gapLine(PROFIT_COPY.table.yesterdayGapShort, "多扣 $0.20", "") }).locator(".jy-profit-tag", { hasText: PROFIT_COPY.gap.tag }).waitFor();
  await cardOf(page, "Rule C").getByText(PROFIT_COPY.table.gapLine(PROFIT_COPY.table.yesterdayGapShort, EMPTY, PROFIT_COPY.gap.yesterdayNotStarted), { exact: true }).waitFor();
  assert.equal(await page.locator(".jy-profit-card.is-open").count(), 0);
  assert.ok((await cardA.getAttribute("class")).includes("jy-profit-row--over"));
  await summary.getByRole("button", { name: PROFIT_COPY.metric.seeDay("昨天"), exact: true }).click(); assert.deepEqual(profitReads.at(-1), { preset: "yesterday" });
  const card = cardOf(page, "Rule A"); await card.locator(".jy-profit-card__line", { hasText: PROFIT_COPY.table.gapLine(PROFIT_COPY.table.col.gap, "多扣 $0.20", "") }).waitFor(); assert.equal(await page.locator(".jy-profit-card.is-open").count(), 0); await card.locator(".jy-profit-card__head").click();
  const facts = card.locator(".jy-profit-card__facts"); assert.deepEqual(await facts.locator("dt").allInnerTexts(), [PROFIT_COPY.table.col.income, PROFIT_COPY.table.col.expected, PROFIT_COPY.table.col.actual, PROFIT_COPY.table.col.gap, PROFIT_COPY.table.col.gross, PROFIT_COPY.table.col.margin]);
  await card.getByRole("group", { name: PROFIT_COPY.expanded.dailyTitle, exact: true }).waitFor();
  await card.getByRole("button", { name: PROFIT_COPY.expanded.seeDetailShort, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule A", "10月8日"), exact: true }); await drawer.waitFor();
  assert.ok((await page.locator(".ant-drawer-content-wrapper").filter({ has: drawer }).boundingBox()).width >= 389);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "390px document root overflows horizontally");
});

const shellFallback = { "/api/meta": { types: [], rules: {}, settings: {} }, "/api/stations": { stations: [], settings: {} }, "/api/reconciliation/channels/options": { ok: false, code: "CHANNEL_CATALOGUE_STALE" } };
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
  page.setDefaultTimeout(UI_STEP_TIMEOUT_MS);
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
  if (path.startsWith("/reconciliation")) await page.getByText("Rule A").or(page.getByText(PROFIT_COPY.table.emptyTitle, { exact: true })).first().waitFor();
  return page;
}

async function fulfill(route, body) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

// 从提醒或上游账单的链接进来：链接里的日期对不上、绑定已解除、地址坏了，都在页面顶上写一句话（§8.1）
const destinationAlert = (page, title) => page.locator(".ant-alert").filter({ has: page.getByText(title, { exact: true }) });
const DESTINATION_EXPIRED = `${ERROR_CATEGORIES.expired.text}。`, DESTINATION_REMOVED = "这条绑定已解除";

test("workflow retry destination opens the linked day, expands that row with its detail, and retries only that row before re-reading the page", async (t) => {
  const path = `/reconciliation?action=retry&ruleId=rule-1&startMs=${window.startMs}&endMs=${window.endMs}&timezone=Asia%2FShanghai`;
  const { page, profitReads, queries, detailReads } = await openDailyPage(t, { path, pageOf: (body) => profitPage(yesterdayRows(), { preset: "yesterday", customPreset: body.preset }) });
  assert.deepEqual(profitReads[0], { preset: "custom", startMs: window.startMs, endMs: window.endMs });
  const drawer = page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule A", "10月8日"), exact: true }); await drawer.waitFor(); assert.deepEqual(detailReads, [{ ruleIds: "rule-1", day: PROFIT_YESTERDAY }]);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
  assert.equal(await rowOf(page, "Rule A").locator(".jy-profit-row__toggle").getAttribute("aria-expanded"), "true");
  // 顶上写这条和链接那天，放「重新读取」
  await destinationAlert(page, `Rule A · ${formatZonedWindow(window)}`).getByRole("button", { name: RETRY, exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
  assert.deepEqual(queries, [{ preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: ["rule-1"], observe: true }]); assert.equal(profitReads.length, 2);
});

test("每日利润 is read-only: no create or edit entry; the attention row's fix links back to 上游资源 and nothing is written", async (t) => {
  const attention = { code: "CANONICAL_KEY_CONFLICT", title: reconciliationIssue("CANONICAL_KEY_CONFLICT").title, detail: reconciliationIssue("CANONICAL_KEY_CONFLICT").detail, action: workflowAction("review_conflict", { ruleId: "rule-1" }), fromDay: null, moreCount: 0 };
  const rows = [profitRow("rule-1", "Rule A", { attention }), profitRow("rule-2", "Rule B", { expected: 1, cost: 1.01, gapUsd: 0.01 })];
  const { page, queries } = await openDailyPage(t, { rows, pageOf: () => profitPage(rows, { preset: "yesterday" }) }), writeLike = new RegExp(`^(添加|编辑|停止|更换|操作|${[EDIT_BINDING, CONNECT, workflowActionMeta("swap_key").label, workflowActionMeta("unbind").label].join("|")})`);
  const FIX = workflowActionMeta("review_conflict").label;
  await page.locator(".jy-profit-attention").getByText(`${PROFIT_COPY.attention.prefix}${attention.title}。${attention.detail}`, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: writeLike }).count(), 0); assert.equal(await page.getByRole("dialog", { name: CONNECT }).count(), 0);
  assert.equal(await page.getByRole("link", { name: `${FIX} Rule A`, exact: true }).getAttribute("href"), "/stations?action=conflict&ruleId=rule-1");
  assert.equal(await rowOf(page, "Rule B").locator('a[href^="/stations"]').count(), 0); assert.equal(queries.length, 0);
  // 每日利润不再嵌渠道接入：不读接入目录，也没有任何接入写请求
  const calls = onboardingRequests.get(page); assert.equal(calls.filter((call) => call.pathname === "/api/channel-onboarding").length, 0); assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
});

test("confirmed history shows the Oct8 time, Key and channels it was fixed with, not current channel 9 or source details", async (t) => {
  const { page, reads, historyReads, records } = await openConfirmedHistoryPage(t, { groupHistory: true }); const summary = page.locator(".jy-profit-summary"), before = await summary.innerText(); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(page, drawer); const record = await expandConfirmedRecord(drawer, records[0]); await drawer.locator(`tr.ant-table-row[data-row-key="${records[0].historyId}"]`).getByText("old-1、old-2、old-3", { exact: true }).waitFor(); await historyFact(record, "时间", formatZonedWindow(records[0].window)); await historyFact(record, "Key", "old-name"); await record.getByText("来自自营站点 3 个渠道的收费记录", { exact: true }).waitFor();
  // A1：来源（平台、地址、账号、namespace）和范围版本不再上页面（§11）
  assert.doesNotMatch(await record.innerText(), /New channel 9|new-name|范围版本|old-own|old-up\.test|newapi|namespace/); assert.equal(await summary.innerText(), before); assert.deepEqual(historyReads[0], { ruleId: "rule-1", params: { limit: "20" } }); assert.ok(reads.some((read) => read.params.includeArchived === "true")); assert.ok(historyReads.every((read) => read.params.limit === "20"));
});

test("confirmed history remains discoverable after stopping and reload even without an own station", async (t) => {
  const { page, reads, historyReads, stopElsewhere } = await openConfirmedHistoryPage(t, { removeOwnAfterStop: true }); stopElsewhere(); await page.reload(); await page.getByText(PROFIT_COPY.table.emptyTitle, { exact: true }).waitFor(); await page.getByRole("link", { name: PROFIT_COPY.table.setupOwnStation, exact: true }).waitFor(); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(page, drawer, historyOption("Rule A", true)); await drawer.getByText(historyCount(1), { exact: true }).waitFor(); assert.equal(reads.filter((read) => read.method !== "GET" && read.path !== "/api/reconciliation/query" && read.path !== "/api/reconciliation/profit").length, 0); assert.equal(historyReads.length, 1); assert.ok(reads.some((read) => read.params.includeArchived === "true")); assert.ok(reads.filter((read) => read.path.endsWith("/confirmed")).every((read) => read.method === "GET"));
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
  const { page } = await openConfirmedHistoryPage(t, { history(route, read) { if (read.ruleId === "rule-1") return new Promise((resolve) => { deferred = { route, resolve }; ready(); }); return fulfill(route, { ruleId: read.ruleId, readOnly: true, records: [other], nextCursor: null }); } }); await page.getByRole("button", { name: HISTORY, exact: true }).click(); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }); await chooseConfirmedHistoryRule(page, drawer); await within(started, "打开以前的每日记录后页面去读 rule-1 的记录"); await chooseConfirmedHistoryRule(page, drawer, historyOption("new-name", true)); await drawer.locator("tr.ant-table-row", { hasText: "saved-other-rule" }).waitFor(); deferred.resolve(fulfill(deferred.route, { ruleId: "rule-1", readOnly: true, records: [original], nextCursor: null })); await page.waitForResponse((response) => response.url().includes("/rule-1/confirmed")); assert.equal(await drawer.locator("tr.ant-table-row", { hasText: "old-name" }).count(), 0);
});

test("confirmed history selector and record expansion support keyboard at 320/390/768/1440 without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, records } = await openConfirmedHistoryPage(t, { viewport: { width, height: 900 } }); const entry = page.getByRole("button", { name: HISTORY, exact: true }); await entry.focus(); await page.keyboard.press("Enter"); const drawer = page.getByRole("dialog", { name: HISTORY, exact: true }), select = drawer.getByRole("combobox", { name: "绑定", exact: true }); await drawer.waitFor(); await page.waitForFunction(() => !document.querySelector(".ant-drawer-open .ant-drawer-content-wrapper")?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")); await select.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await drawer.getByText(historyCount(1), { exact: true }).waitFor(); const record = await expandConfirmedRecord(drawer, records[0], width < 768); await historyFact(record, "Key", "old-name"); await page.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `confirmed history overflow at ${width}`); if (width < 768) assert.equal(await drawer.locator(".ant-drawer-body").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `confirmed history drawer overflow at ${width}`); await drawer.locator(".ant-drawer-close").focus(); await page.keyboard.press("Enter"); await drawer.waitFor({ state: "hidden" });
  }
});

test("今天每 30 秒重读一次（只读 POST /profit，不带 observe）；本月 5 分钟一次；昨天不轮询；选了自定义还没查询时暂停", async (t) => {
  // 浏览器时钟被快进后，响应的取数时刻跟着走，免得「数据截至」被判成过期而换掉提示文案
  let skewMs = 0;
  const { page, profitReads, queries } = await openDailyPage(t, { clock: true, pageOf: (body) => ({ ...(body.preset === "yesterday" ? profitPage(yesterdayRows(), { preset: "yesterday" }) : profitPage(todayRows(), { preset: body.preset === "month" ? "7d" : "today", customPreset: body.preset })), asOf: new Date(Date.now() + skewMs).toISOString() }) });
  const advance = async (ms) => { skewMs += ms; await page.clock.fastForward(ms); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const freshness = (title) => page.locator(`.jy-freshness[title="${title}"]`).waitFor();
  await freshness("数据每 30 秒自动刷新"); assert.deepEqual(profitReads, [{ preset: "today" }]);
  await advance(31000); await settle(); assert.deepEqual(profitReads.slice(1), [{ preset: "today" }]); assert.equal(queries.length, 0);
  await pickPreset(page, PROFIT_COPY.presets.yesterday); await freshness("当前时间范围不自动刷新，可点右侧刷新"); assert.deepEqual(profitReads.at(-1), { preset: "yesterday" });
  await advance(310000); await settle(); assert.equal(profitReads.length, 3);
  await pickPreset(page, PROFIT_COPY.presets.month); await freshness("数据每 5 分钟自动刷新"); assert.deepEqual(profitReads.at(-1), { preset: "month" });
  await advance(290000); await settle(); assert.equal(profitReads.length, 4); await advance(20000); await settle(); assert.deepEqual(profitReads.at(-1), { preset: "month" }); assert.equal(profitReads.length, 5);
  await pickPreset(page, PROFIT_COPY.presets.custom); await page.getByRole("button", { name: PROFIT_COPY.query, exact: true }).waitFor(); await freshness("当前时间范围不自动刷新，可点右侧刷新");
  await advance(310000); await settle(); assert.equal(profitReads.length, 5); assert.equal(queries.length, 0);
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
  // 加上游默认只有地址和令牌：固定成本在「更多设置」里选类型
  await drawer.getByText("更多设置", { exact: true }).click();
  await drawer.getByRole("combobox", { name: "类型", exact: true }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: "固定成本" }).click();
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

test("上游列表：所有上游都旧了（后台刷新卡住）时每一行都标「数据截至」，按服务端此刻比，不按别的上游比", async (t) => {
  const now = Date.now(), hourAgo = new Date(now - 3600000).toISOString();
  const station = (id, name) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, cnyPerUsd: 7,
    balance: { ok: true, remaining: 100, checkedAt: hourAgo }, prediction: { etaDays: 30, burnPerDay: 3, basis: "近 3 小时" }, spark: [] });
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [station("st-a", "A 上游"), station("st-b", "B 上游")], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date(now).toISOString() });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {}, settings: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    throw new Error("unexpected API: " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: new Date(now).toISOString() }), "/stations");
  const table = page.locator(".jy-stations-table");
  for (const name of ["A 上游", "B 上游"]) await table.locator("tbody tr", { hasText: name }).first().locator("td").nth(1).getByText(/^数据截至 (\d{1,2}月\d{1,2}日 )?\d{1,2}:\d{2}$/).waitFor();
});

test("上游列表：测试读取不写库，读成功的那一行在下次刷新列表之前不标「数据截至」，刷新列表以后照常按读取时刻判断", async (t) => {
  const now = Date.now(), hourAgo = new Date(now - 3600000).toISOString(); const tests = [];
  const station = { id: "st-x", name: "X 上游", type: "newapi", baseUrl: "https://st-x.test", monitorEnabled: true, cnyPerUsd: 7,
    balance: { ok: false, error: "HTTP 503", code: "UPSTREAM_REQUEST_FAILED", checkedAt: hourAgo }, prediction: null, spark: [] };
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: [station], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date(now).toISOString() });
    if (path === "/api/stations/test") { tests.push(route.request().postDataJSON()); return fulfill(route, { ok: true, latencyMs: 12, account: "x-account", remaining: 50, currency: null }); }
    if (path === "/api/refresh") return fulfill(route, { stations: [] });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {}, settings: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    throw new Error("unexpected API: " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: new Date(now).toISOString() }), "/stations");
  const table = page.locator(".jy-stations-table");
  const row = table.locator("tbody tr", { hasText: "X 上游" }).first();
  // 读不到余额：下面一行说原因，带「测试读取」
  await row.getByRole("button", { name: /X 上游：读不到/ }).click();
  await page.locator(".jy-issue-pop").getByRole("button", { name: TEST_READ }).click();
  await row.getByText("$50.00", { exact: true }).waitFor();
  assert.deepEqual(tests, [{ stationId: "st-x", type: "newapi" }]);
  // 读取时刻还是一小时前的（不拿浏览器的时刻），但显示的是刚读到的余额，这一行不标「数据截至」
  assert.equal(await row.locator("td").nth(1).getByText(/数据截至/).count(), 0);
  // 下一次刷新列表：服务端那边读得到了，读取时刻仍是一小时前，这一行照常标「数据截至」
  station.balance = { ok: true, remaining: 40, account: "x-account", checkedAt: hourAgo };
  await page.getByRole("button", { name: REFRESH, exact: true }).first().click();
  await row.getByText("$40.00", { exact: true }).waitFor();
  await row.locator("td").nth(1).getByText(/^数据截至 (\d{1,2}月\d{1,2}日 )?\d{1,2}:\d{2}$/).waitFor();
});

// 读不到余额：名字后面的红色感叹号（行高不变）；「另有 N 件」在列表下面
async function openIssuePage(t, viewport, { code = "AUTHENTICATION_FAILED" } = {}) {
  const now = Date.now(), tests = [];
  const ok = (id, name) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, hasAccessToken: true, balance: { ok: true, remaining: 100, checkedAt: new Date(now).toISOString() }, prediction: { etaDays: 30, burnPerDay: 3, basis: "近 3 小时" }, spark: [] });
  const stations = [ok("a", "主力上游"), { id: "bad", name: "邮箱密码登录", type: "sub2api-password", baseUrl: "https://mail.example.io", monitorEnabled: true,
    balance: { ok: false, code, error: 'POST /api/v1/auth/login → 401 {"code":"INVALID_CREDENTIALS"}', checkedAt: new Date(now - 60000).toISOString() }, prediction: null, spark: [] }];
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations, settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date(now).toISOString() });
    if (path === "/api/stations/test") { tests.push(route.request().postDataJSON()); return fulfill(route, { ok: true, latencyMs: 12, account: "x", remaining: 50, currency: null }); }
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "sub2api-password", label: "Sub2API 账号（邮箱密码）", needs: ["email", "password"] }, { value: "newapi", label: "New API 账号", needs: ["accessToken", "userId"] }], rules: {}, settings: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [{ id: "c1", kind: "review_conflict", label: "处理重复", stationId: null, ruleId: "r", channelIds: [], href: "/stations?action=conflict&ruleId=r" }] });
    throw new Error("unexpected API: " + path);
  }, viewport, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: new Date(now).toISOString() }), "/stations");
  return { page, tests };
}

test("上游列表：读不到余额的问题收进名字后面的感叹号——行高不变、悬停一句、点开气泡（原因、数据截至、详细原因、测试读取、更新登录信息）", async (t) => {
  const { page, tests } = await openIssuePage(t, undefined);
  await page.setViewportSize({ width: 1440, height: 900 });
  const table = page.locator(".jy-stations-table");
  const row = table.locator("tbody tr", { hasText: "邮箱密码登录" }).first(), other = table.locator("tbody tr", { hasText: "主力上游" }).first();
  await row.waitFor();
  assert.equal(await table.locator(".jy-stations-issue").count(), 0, "不再另起一行写原因");
  assert.equal(await table.locator("tbody tr").count(), 2, "没有多出来的说明行");
  const bang = row.getByRole("button", { name: /邮箱密码登录：读不到/ });
  assert.ok(Math.abs((await row.boundingBox()).height - (await other.boundingBox()).height) < 4, "行高不变");
  await bang.hover();
  const tip = page.getByRole("tooltip").getByText(/^读不到：登录信息不对或过期了 · 数据截至/); await tip.waitFor();
  if (process.env.UI_SHOT_DIR) await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/issue-hover-1440x900.png` });
  await bang.click();
  const pop = page.locator(".jy-issue-pop"); await pop.waitFor();
  assert.match(await pop.locator("b").innerText(), /^读不到：登录信息不对或过期了$/);
  await pop.getByText(/^数据截至/).waitFor(); await pop.getByText("查看详细原因").waitFor();
  assert.equal(await pop.getByRole("button", { name: "测试读取" }).isVisible(), true);
  if (process.env.UI_SHOT_DIR) { await page.mouse.move(700, 600); await page.waitForTimeout(500); await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/issue-pop-1440x900.png` }); }
  await pop.getByRole("button", { name: "测试读取" }).click();
  await page.waitForFunction(() => !document.querySelector(".jy-issue-pop"), null, { timeout: 5000 }).catch(() => {});
  assert.deepEqual(tests, [{ stationId: "bad", type: "sub2api-password" }]);
});

test("上游列表：登录信息、权限、人机验证这类问题的气泡多一个「更新登录信息」，打开编辑抽屉、停在登录那一栏；别的问题没有这个按钮", async (t) => {
  const { page } = await openIssuePage(t, undefined);
  await page.setViewportSize({ width: 1440, height: 900 });
  const row = page.locator(".jy-stations-table tbody tr", { hasText: "邮箱密码登录" }).first();
  await row.getByRole("button", { name: /邮箱密码登录：读不到/ }).click();
  await page.locator(".jy-issue-pop").getByRole("button", { name: "更新登录信息" }).click();
  const drawer = page.getByRole("dialog"); await drawer.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "password" || document.activeElement?.getAttribute("id")?.endsWith("password"), null, { timeout: 5000 });
});

test("上游列表：不是登录问题（连不上）的气泡没有「更新登录信息」；「另有 N 件」在列表下面、手机卡片的感叹号也在名字后面", async (t) => {
  const { page } = await openIssuePage(t, undefined, { code: "UPSTREAM_REQUEST_FAILED" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".jy-stations-table tbody tr", { hasText: "邮箱密码登录" }).first().getByRole("button", { name: /邮箱密码登录：读不到/ }).click();
  await page.locator(".jy-issue-pop").waitFor();
  assert.equal(await page.locator(".jy-issue-pop").getByRole("button", { name: "更新登录信息" }).count(), 0);
  await page.keyboard.press("Escape");
  await page.goto(page.url().split("?")[0] + "?filter=attention");
  const note = page.getByText(/另有 \d+ 件需处理的事不在某一个上游上/);
  await note.waitFor();
  const table = await page.locator(".jy-stations-table").boundingBox(), noteBox = await note.boundingBox();
  assert.ok(noteBox.y >= table.y + table.height - 1, "「另有 N 件」在列表下面");
  const mobile = await openIssuePage(t, { width: 375, height: 812 });
  const card = mobile.page.locator(".jy-stations-m li", { hasText: "邮箱密码登录" }).first();
  await card.getByRole("button", { name: /邮箱密码登录：读不到/ }).click();
  await mobile.page.locator(".jy-issue-pop").waitFor();
  assert.equal(await mobile.page.locator(".jy-stations-issue").count(), 0);
  if (process.env.UI_SHOT_DIR) { await mobile.page.waitForTimeout(500); await mobile.page.screenshot({ path: `${process.env.UI_SHOT_DIR}/issue-pop-375x812.png` }); }
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
test("成本估算：只有「上游成本构成」和「每天的上游成本」两块，数读每日利润同一份；只有近 7 天、近 30 天和自定义；页顶有「每日利润」链接", async (t) => {
  const rows = [profitRow("rule-1", "Rule A", { income: 5, cost: 2 }), profitRow("rule-2", "Rule B", { income: 3, cost: 1 })];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/settings") return fulfill(route, { settings: {}, tz: PROFIT_TZ });
    if (path === "/api/reconciliation/profit") return fulfill(route, { ...profitPage(rows), unaccountedUpstreamCostUsd: 0.5,
      dailyCost: [{ day: "2026-10-07", actualCostUsd: 2 }, { day: PROFIT_TODAY, actualCostUsd: 1 }] });
    throw new Error("unexpected cost fixture API: " + path);
  }, undefined, false, null, "/analytics");
  await page.getByRole("region", { name: ANALYTICS_COPY.panel.mix, exact: true }).waitFor();
  await page.getByRole("region", { name: ANALYTICS_COPY.panel.daily, exact: true }).waitFor();
  assert.equal(await page.getByRole("region").filter({ hasText: ANALYTICS_COPY.panel.heat }).count(), 0, "花费时段已删");
  await page.getByText(ANALYTICS_COPY.unaccounted, { exact: false }).first().waitFor();
  await page.getByText(ANALYTICS_COPY.todayLegend, { exact: false }).first().waitFor();
  await page.getByRole("link", { name: "每日利润", exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "近 90 天", exact: true }).count(), 0, "没有近 90 天");
});

const failJSON = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

test("自营业务两行 8 + 4：每日收入只画收入、不再读 /api/analytics，消费最多的用户、模型各前 5；利润怎么算、选转售 Key、按明细细算都是收起区", async (t) => {
  const analytics = myLayoutAnalytics;
  const adminKeys = [], paths = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    paths.push(url.pathname);
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/own/analytics") return fulfill(route, analytics(url.searchParams.get("range") || "7d"));
    if (url.pathname === "/api/own/admin-keys") { adminKeys.push(route.request().method()); return fulfill(route, { accounts: [{ username: "root", role: 100, enumerable: true, tokens: [{ name: "sale", flagged: true, usedUsd: 1 }] }] }); }
    // 只画收入以后，自营业务不再读慢的 /api/analytics（请求了就会报错）
    throw new Error("unexpected my fixture API: " + url.pathname);
  }, undefined, false, null, "/my");
  await page.setViewportSize({ width: 1440, height: 900 });
  const region = (name) => page.getByRole("region", { name, exact: true });
  const income = region("每日收入"), users = region("消费最多的用户"), forecast = region("预计花费"), models = region("消费最多的模型");
  await income.waitFor(); await users.waitFor(); await forecast.waitFor(); await models.waitFor();
  // 指标行在等式上面，这次只放等式里没有的三格（收入、毛利等 G 再补，同一个数一页只出现一次）
  const metrics = region("这段时间的用量");
  assert.deepEqual((await metrics.locator("dt").allInnerTexts()).map((x) => x.trim()), ["有消费的用户", "请求数", "Token（不含缓存）"]);
  await metrics.getByText("5 个", { exact: true }).waitFor();
  assert.doesNotMatch(await metrics.innerText(), /[¥$]/);
  assert.ok((await metrics.boundingBox()).y < (await region(`${RANGE_TEXT["7d"]}经营`).boundingBox()).y, "指标行在利润等式上面");
  // 「消费」合计在「消费最多的模型」下面，等于模型那几条加起来（按模型加总；用户的条按用户加总，可能对不上，所以不放用户下面）
  assert.equal(await users.locator(".jy-my-facts").count(), 0);
  assert.deepEqual((await models.locator(".jy-my-facts li").allInnerTexts()).map((x) => x.trim()), [`消费 ${formatMoney(2530 * 7)}`]);
  // 管理员自用是 0 时「消费」和收入相等，不写那句（免得让人糊涂）；有管理员自用的情况在下面没设置售价那一页查
  assert.equal(await models.getByText("含管理员自用，和收入不是一个数。", { exact: true }).count(), 0);
  // 人数只在指标行里写一次：用户排行右上角不带数字
  await users.getByRole("button", { name: "看全部用户", exact: true }).waitFor();
  assert.equal(await users.getByText(/全部 \d+ 个用户/).count(), 0);
  for (const [main, side] of [[income, users], [forecast, models]]) {
    const [m, sd] = [await main.boundingBox(), await side.boundingBox()];
    assert.ok(sd.x > m.x + m.width, "右边那块在左边那块右边");
    assert.ok(m.width / sd.width > 1.8 && m.width / sd.width < 2.2, `宽度约 2:1（${Math.round(m.width)} / ${Math.round(sd.width)}）`);
    assert.ok(Math.abs(m.y - sd.y) < 1 && Math.abs(m.height - sd.height) < 1, "上沿对齐、一样高");
  }
  // 每日收入只画收入：图例里没有上游成本，也没有每日净利；表格只有日期和收入两列、没有合计行（合计在等式里）
  await income.locator(".jy-legend").getByText("收入", { exact: true }).waitFor();
  // 说明里那句「上游成本在成本估算里看。」不算：只查图例
  assert.equal(await income.locator(".jy-legend").getByText("上游成本").count(), 0); assert.equal(await income.getByText("每日净利").count(), 0);
  await income.getByRole("button", { name: "表格", exact: true }).click();
  await income.locator("table").waitFor();
  assert.deepEqual((await income.locator("thead th").allInnerTexts()).map((x) => x.trim()), ["日期", "收入"]);
  assert.equal(await income.locator("tfoot").count(), 0);
  // 每天的收入照接口的逐日收入写，新的在上；第一行是今天（写「截至」几点），其余几天不写
  const incomeRows = income.locator("tbody tr");
  assert.deepEqual((await incomeRows.locator("td:last-child").allInnerTexts()).map((x) => x.trim()), [1600, 1500, 1400, 1300, 1200, 1100, 1000].map((v) => formatMoney(v)));
  assert.match(await incomeRows.first().locator("td").first().innerText(), /截至/);
  assert.equal(await incomeRows.locator("td:first-child", { hasText: "截至" }).count(), 1);
  // 设置了售价：收入是准确数，不带「≈」；说明末尾去成本估算看上游成本，带当前时间范围
  assert.doesNotMatch(await income.locator("tbody").innerText(), /≈/);
  assert.equal(await income.getByRole("link", { name: "成本估算", exact: true }).getAttribute("href"), "/analytics?range=7d");
  // 消费最多的模型：前 5 加一行「其他 2 个模型」（等于并掉的两个之和），右上角去「模型与渠道」
  assert.equal(await models.locator(".jy-hbars li").count(), 6);
  await models.locator(".jy-hbars li", { hasText: "其他 2 个模型" }).getByText(formatMoney(30 * 7), { exact: true }).waitFor();
  await models.getByRole("button", { name: "全部 7 个模型", exact: true }).waitFor();
  // 利润怎么算：摘要不带金额；明细收在共用的收起区里，默认收起
  const basis = region("利润怎么算");
  const basisMore = basis.getByRole("button", { name: "收入和成本怎么算、转售 Key、各上游成本", exact: true });
  assert.equal(await basisMore.getAttribute("class"), "jy-more__toggle"); assert.equal(await basisMore.getAttribute("aria-expanded"), "false");
  await basisMore.click();
  // 选转售 Key：也是收起区，点开时才读管理员账号的 Key，「取消」收起
  const pick = basis.getByRole("button", { name: "选转售 Key", exact: true });
  assert.equal(await pick.getAttribute("class"), "jy-more__toggle"); assert.equal(adminKeys.length, 0);
  await pick.click(); await basis.locator(".jy-my-mgr .jy-my-account h4", { hasText: "root" }).waitFor(); assert.deepEqual(adminKeys, ["GET"]);
  await basis.getByRole("button", { name: "取消", exact: true }).click(); assert.equal(await pick.getAttribute("aria-expanded"), "false");
  // 收起以后焦点回到「选转售 Key」按钮；「保存并重算」以后也一样
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "选转售 Key");
  await pick.click(); await basis.locator(".jy-my-mgr .jy-my-account h4", { hasText: "root" }).waitFor();
  await basis.getByRole("button", { name: "保存并重算", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "选转售 Key");
  assert.deepEqual(adminKeys, ["GET", "GET", "PUT"]);
  // 换范围、点顶栏刷新：一直没请求过 /api/analytics（逐个记下请求过的路径再查）
  await page.getByRole("button", { name: RANGE_TEXT["30d"], exact: true }).click();
  await page.waitForURL(/range=30d/); await income.locator('a[href="/analytics?range=30d"]').waitFor();
  const ownReads = () => paths.filter((x) => x === "/api/own/analytics").length, before = ownReads();
  await page.getByRole("button", { name: "刷新当前页面数据", exact: true }).click();
  for (let i = 0; i < 50 && ownReads() === before; i++) await page.waitForTimeout(100);
  assert.ok(ownReads() > before, "顶栏刷新重读了自营站点接口");
  assert.ok(paths.includes("/api/own/analytics")); assert.equal(paths.filter((x) => x === "/api/analytics").length, 0);
  // 按明细细算（模型与渠道标签页）：收起区，默认收起
  await page.getByRole("tab", { name: "模型与渠道", exact: true }).click();
  const audit = page.getByRole("button", { name: "细算的条数和结果", exact: true });
  await audit.waitFor(); assert.equal(await audit.getAttribute("class"), "jy-more__toggle"); assert.equal(await audit.getAttribute("aria-expanded"), "false");
  await page.context().close();

  // 没设置售价：收入是估算，和等式同一个判断——每日收入的数值都带「≈」，说明里接上那句原因
  const unpriced = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/own/analytics") return fulfill(route, myLayoutAnalytics(url.searchParams.get("range") || "7d", { sellPrice: false }));
    throw new Error("unexpected my fixture API: " + url.pathname);
  }, undefined, false, null, "/my");
  const estIncome = unpriced.getByRole("region", { name: "每日收入", exact: true });
  await unpriced.getByRole("region", { name: "消费最多的模型", exact: true }).getByText("含管理员自用，和收入不是一个数。", { exact: true }).waitFor();
  // 原因那句只在等式下面写一次，每日收入的说明里只写一句短的
  await estIncome.getByText("收入是估算，原因见上面的利润等式。", { exact: false }).waitFor();
  assert.equal((await unpriced.locator("main").innerText()).split(SELL_PRICE_UNSET).length - 1, 1, "「没设置售价」那句全页只出现一次");
  await estIncome.getByRole("button", { name: "表格", exact: true }).click();
  const est = (await estIncome.locator("tbody td:last-child").allInnerTexts()).map((x) => x.trim());
  assert.equal(est.length, 7); assert.ok(est.every((x) => x.startsWith("≈")), est.join(" "));
  // 悬停和读屏里的收入也带「≈」：键盘到最后一天，读屏那句写「收入 ≈…」
  await estIncome.getByRole("button", { name: "图表", exact: true }).click();
  const chart = estIncome.locator(".jy-chart-stack"); await chart.focus(); await chart.press("End");
  assert.match(await estIncome.locator(".sr-only[aria-live]").innerText(), /收入 ≈/);
  // 选「今天」：这块只画收入，说明不再提净利
  await unpriced.getByRole("button", { name: RANGE_TEXT.today, exact: true }).click();
  const todayOnly = unpriced.getByRole("region", { name: "每日收入", exact: true });
  await todayOnly.getByText(/看每天的收入；/).waitFor();
  assert.doesNotMatch(await todayOnly.innerText(), /净利/);
  await unpriced.context().close();

  // 「今天」按数据自己的结束时间判断：数据停在昨天 23:30（跨零点后还没刷新），昨天那一行才是「今天」（写「截至」）
  const startOfToday = Date.parse(`${shanghaiDay(Date.now())}T00:00:00+08:00`);
  const stale = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/own/analytics") {
      const a = myLayoutAnalytics(url.searchParams.get("range") || "7d"), yesterday = shiftDay(shanghaiDay(Date.now()), -1);
      return fulfill(route, { ...a, endMs: startOfToday - 30 * 60000, incomeDaily: a.incomeDaily.map((x, i) => ({ ...x, date: shiftDay(yesterday, i - 6) })) });
    }
    throw new Error("unexpected my fixture API: " + url.pathname);
  }, undefined, false, null, "/my");
  const staleIncome = stale.getByRole("region", { name: "每日收入", exact: true });
  await staleIncome.getByRole("button", { name: "表格", exact: true }).click();
  const staleRows = staleIncome.locator("tbody tr");
  await staleRows.first().waitFor();
  assert.match(await staleRows.first().locator("td").first().innerText(), /截至/);
  assert.equal(await staleIncome.locator("tbody td:first-child", { hasText: "截至" }).count(), 1);
  await stale.context().close();

  // 第一次加载时的骨架和概览同一个版式：块名是新的（「每日收入」，不是「收入与上游成本」），两行 8 + 4
  let release; const held = new Promise((done) => { release = done; });
  const slow = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/own/analytics") { await held; return fulfill(route, myLayoutAnalytics(url.searchParams.get("range") || "7d")); }
    throw new Error("unexpected my fixture API: " + url.pathname);
  }, undefined, false, null, "/my");
  t.after(() => release());
  const busy = slow.locator(".jy-page[aria-busy=true]");
  await busy.waitFor();
  for (const name of ["这段时间的用量", "每日收入", "消费最多的用户", "预计花费"]) await busy.getByRole("region", { name, exact: true }).waitFor();
  assert.equal(await busy.getByText("收入与上游成本").count(), 0);
  assert.equal(await busy.locator(".jy-grid-8-4").count(), 2);
  release();
  await slow.getByRole("region", { name: "消费最多的模型", exact: true }).waitFor();
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
  assert.equal(await totals.locator(".jy-kpi-figure").filter({ hasText: /^—$/ }).count(), 3);
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

test("告警中心 8 + 4、系统设置两栏（1440）：通知方式一个一行，提醒节奏、历史概况收成一句；手机上通知方式在最前", async (t) => {
  const two = [{ id: "c1", name: "运维群", type: "telegram", enabled: true, config: {}, hasSecret: {} }, { id: "c2", name: "老板邮箱", type: "telegram", enabled: false, config: {}, hasSecret: {} }];
  let channels = two;
  const rules = { onLow: true, onExhaust: true, onError: true, onRecover: false, onEta: true, etaDays: 3, etaUnit: "days", renotifyHours: 6, errorThreshold: 1, errorRetrySec: 60, channelsFor: {} };
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword: false });
    if (url.pathname === "/api/notifications") return fulfill(route, { channels, rules, channelTypes: [{ value: "telegram", label: "Telegram", fields: [] }] });
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture({ lowBalanceUsd: 5, dailyReport: { enabled: true, time: "09:00", channelIds: ["c1"] } }));
    if (url.pathname === "/api/settings") return fulfill(route, settingsFixture());
    throw new Error("unexpected layout fixture API: " + url.pathname);
  };
  const page = await openFixturePage(t, handler, undefined, false, null, "/notifications");
  await page.setViewportSize({ width: 1440, height: 900 });
  const region = (name) => page.getByRole("region", { name, exact: true });
  const [rulesP, chP, reportP] = [region(NOTIFICATIONS_COPY.rules), region(NOTIFICATIONS_COPY.channels), region(NOTIFICATIONS_COPY.report)];
  // 等读到数据（骨架的块名一样）：规则的开关、通知方式那一行、日报的开关
  await rulesP.getByRole("switch").first().waitFor(); await chP.locator(".jy-notifications-chlist > li").first().waitFor(); await reportP.getByRole("switch").first().waitFor();
  // 左 8 列提醒规则；右 4 列通知方式在上、日报在下
  const [r, c, d] = [await rulesP.boundingBox(), await chP.boundingBox(), await reportP.boundingBox()];
  assert.ok(c.x > r.x + r.width && Math.abs(c.x - d.x) < 1, "通知方式、日报在提醒规则右边一栏");
  assert.ok(r.width / c.width > 1.8 && r.width / c.width < 2.2, `宽度约 2:1（${Math.round(r.width)} / ${Math.round(c.width)}）`);
  assert.ok(Math.abs(r.y - c.y) < 1 && d.y > c.y + c.height, "上沿对齐，日报在通知方式下面");
  // 2 个通知方式时，规则那块不被右栏撑出大片空白（§1.4 第 3 条）：右栏（通知方式 + 日报）最多比规则长一行字，可以更短（旁边那块下面空着是允许的）
  const ruleContent = await rulesP.locator(".jy-notifications-pad").boundingBox();
  assert.ok((d.y + d.height) - (r.y + r.height) <= 24, `右栏比规则长了 ${Math.round((d.y + d.height) - (r.y + r.height))}`);
  assert.ok((r.y + r.height) - (ruleContent.y + ruleContent.height) <= 48, `规则那块内容下面的空白（${Math.round((r.y + r.height) - (ruleContent.y + ruleContent.height))}）`);
  // 日报排紧：开关和发送时间一行；「预览」「立即发送」的说明在悬停和读屏里
  const [sw, time] = [await reportP.getByRole("switch").first().boundingBox(), await reportP.getByLabel("发送时间", { exact: true }).boundingBox()];
  assert.ok(Math.abs(sw.y - time.y) < 16 && time.x > sw.x, "开关和发送时间同一行");
  assert.equal(await reportP.getByRole("button", { name: NOTIFICATIONS_COPY.reportSend }).getAttribute("title"), NOTIFICATIONS_COPY.reportSendTip);
  // 通知方式一个一行（4 列里不放表格）：名字、开关；类型 · 测试结果；测试、编辑、删除常驻
  assert.equal(await chP.locator("table").count(), 0);
  const items = chP.locator(".jy-notifications-chlist > li");
  assert.equal(await items.count(), 2);
  await items.first().getByText("运维群", { exact: true }).waitFor();
  for (const name of [NOTIFICATIONS_COPY.testAria("运维群"), NOTIFICATIONS_COPY.editAria("运维群"), NOTIFICATIONS_COPY.removeAria("运维群")]) assert.equal(await items.first().getByRole("button", { name, exact: true }).isVisible(), true, name);
  // 提醒节奏收成一句（按已保存的数写），两个输入框在收起区里
  await rulesP.getByText(NOTIFICATIONS_COPY.paceSummary(6, 60), { exact: true }).waitFor();
  const pace = rulesP.getByRole("button", { name: NOTIFICATIONS_COPY.pace, exact: true });
  assert.equal(await pace.getAttribute("class"), "jy-more__toggle"); assert.equal(await pace.getAttribute("aria-expanded"), "false");
  assert.equal(await rulesP.getByLabel(NOTIFICATIONS_COPY.renotify, { exact: true }).count(), 0);
  await pace.click(); await rulesP.getByLabel(NOTIFICATIONS_COPY.renotify, { exact: true }).waitFor();
  // 通知方式多时只露前 2 个（启用的在前），其余收进「还有 N 个」：6 个和 12 个时整页一样高
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `通知${i}`, type: "telegram", enabled: i !== 0, config: {}, hasSecret: {} }));
  const pageHeight = async (n) => {
    channels = many(n); await page.reload(); await chP.locator(".jy-notifications-chlist > li").first().waitFor();
    return page.evaluate(() => document.documentElement.scrollHeight);
  };
  const h6 = await pageHeight(6), h12 = await pageHeight(12);
  assert.equal(h12, h6, `页面高度不随通知方式个数涨（6 个 ${h6}，12 个 ${h12}）`);
  assert.equal(await chP.locator(".jy-notifications-chlist > li").count(), 2);
  await chP.getByRole("button", { name: NOTIFICATIONS_COPY.moreChannels(10), exact: true }).waitFor();
  // 12 个时规则那块也不被右栏撑出空白：规则最后一行内容（提醒节奏那一句）到面板底边，除了面板自己的下内边距（24），不超过一行字
  const [rule12, last12] = [await rulesP.boundingBox(), await rulesP.locator(".jy-notifications-pad").boundingBox()];
  assert.ok((rule12.y + rule12.height) - (last12.y + last12.height) <= 24, `12 个时规则内容下面空了 ${Math.round((rule12.y + rule12.height) - (last12.y + last12.height))}`);
  // 停用的排在后面
  assert.equal(await chP.locator(".jy-notifications-chlist > li").first().getByText("通知1", { exact: true }).count(), 1);
  channels = two;
  // 手机：通知方式在最前，然后提醒规则、日报（页面里就换了先后，读屏、键盘跟着走）
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await rulesP.getByRole("switch").first().waitFor(); await chP.locator(".jy-notifications-chlist > li").first().waitFor(); await reportP.getByRole("switch").first().waitFor();
  const order = await page.locator(".jy-page > .jy-panel, .jy-page > section").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") || el.querySelector("h2")?.textContent?.trim()));
  const at = (name) => order.findIndex((x) => x && x.startsWith(name));
  assert.ok(at(NOTIFICATIONS_COPY.channels) >= 0 && at(NOTIFICATIONS_COPY.channels) < at(NOTIFICATIONS_COPY.rules) && at(NOTIFICATIONS_COPY.rules) < at(NOTIFICATIONS_COPY.report), order.join(" / "));

  // 系统设置：左边刷新与数据、历史数据保留，右边账户安全、关于
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(new URL("/settings", page.url()).href);
  const sRegion = (name) => page.getByRole("region", { name, exact: true });
  await page.getByLabel(SETTINGS_COPY.interval, { exact: true }).waitFor();
  const [refresh, retention, account, about] = await Promise.all([SETTINGS_COPY.refresh, SETTINGS_COPY.retention, SETTINGS_COPY.account, SETTINGS_COPY.about].map((name) => sRegion(name).boundingBox()));
  assert.ok(Math.abs(refresh.x - retention.x) < 1 && Math.abs(account.x - about.x) < 1 && account.x > refresh.x + refresh.width, "两栏");
  assert.ok(Math.abs(refresh.width - account.width) < 2, "两栏一样宽");
  assert.ok(Math.abs(refresh.y - account.y) < 1 && retention.y > refresh.y && about.y > account.y, "上沿对齐，各自上下排");
  // 历史概况、最近自动清理收起，露一句记录数和最早的日子
  const ret = sRegion(SETTINGS_COPY.retention);
  await ret.getByText(/^共 1,234 条记录，最早 \d{1,2}月\d{1,2}日$/).waitFor();
  const health = ret.getByRole("button", { name: SETTINGS_COPY.healthMore, exact: true });
  assert.equal(await health.getAttribute("aria-expanded"), "false");
  assert.equal(await ret.getByRole("heading", { name: SETTINGS_COPY.overview, exact: true }).count(), 0);
  await health.click(); await ret.getByRole("heading", { name: SETTINGS_COPY.overview, exact: true }).waitFor();
});

test("告警中心提醒节奏在新布局下照常自动保存：展开改数、收起就存上；清空一个框时收不起来、报错一直看得到，改正以后别的数也存上", async (t) => {
  const channels = [{ id: "c1", name: "运维群", type: "telegram", enabled: true, config: {}, hasSecret: {} }];
  let rules = { onLow: true, onExhaust: true, onError: true, onRecover: false, onEta: true, etaDays: 3, etaUnit: "days", renotifyHours: 6, errorThreshold: 1, errorRetrySec: 60, channelsFor: {} };
  const puts = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/notifications/rules" && method === "PUT") { const body = route.request().postDataJSON(); puts.push(body); rules = { ...rules, ...body }; return fulfill(route, { rules }); }
    if (url.pathname === "/api/notifications") return fulfill(route, { channels, rules, channelTypes: [{ value: "telegram", label: "Telegram", fields: [] }] });
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture({ lowBalanceUsd: 5, dailyReport: { enabled: false, time: "09:00", channelIds: [] } }));
    throw new Error("unexpected pace fixture API: " + method + " " + url.pathname);
  }, undefined, false, null, "/notifications");
  await page.setViewportSize({ width: 1440, height: 900 });
  const rulesP = page.getByRole("region", { name: NOTIFICATIONS_COPY.rules, exact: true });
  const pace = rulesP.getByRole("button", { name: NOTIFICATIONS_COPY.pace, exact: true });
  await pace.waitFor();
  const wait = async (n) => { for (let i = 0; puts.length < n && i < 50; i++) await page.waitForTimeout(100); };
  // 展开、改「重复提醒间隔」、收起：离开输入框就存，收起不丢；那一句按新存的数写
  await pace.click();
  const renotify = rulesP.getByLabel(NOTIFICATIONS_COPY.renotify, { exact: true });
  await renotify.fill("12");
  await pace.click(); await wait(1);
  assert.equal(puts.length, 1); assert.equal(puts[0].renotifyHours, 12);
  assert.equal(await pace.getAttribute("aria-expanded"), "false");
  await rulesP.getByText(NOTIFICATIONS_COPY.paceSummary(12, 60), { exact: true }).waitFor();
  // 展开以后那一句不写（两个框下面各有说明，不说两遍）
  await pace.click();
  assert.equal(await rulesP.getByText(NOTIFICATIONS_COPY.paceSummary(12, 60), { exact: true }).count(), 0);
  // 清空「重复提醒间隔」再点收起：报错，收不起来，报错一直看得到
  await renotify.fill(""); await pace.click(); await page.waitForTimeout(300);
  assert.equal(await pace.getAttribute("aria-expanded"), "true");
  // 再点一次收起：收不起来，但有反应——焦点跳到出错的那一格
  await pace.click(); await page.waitForTimeout(200);
  assert.equal(await pace.getAttribute("aria-expanded"), "true");
  assert.equal(await renotify.evaluate((el) => el === document.activeElement), true);
  await rulesP.getByText(new RegExp(NOTIFICATIONS_COPY.renotifyZero)).first().waitFor();
  // 去改「提醒天数」：这一组校验不过，没存；报错照样看得到
  const eta = rulesP.getByLabel(NOTIFICATIONS_COPY.etaLabel, { exact: true });
  await eta.fill("5"); await eta.press("Tab"); await page.waitForTimeout(400);
  assert.equal(puts.length, 1);
  assert.equal(await renotify.isVisible(), true);
  // 改正以后，两个数一起存上，可以收起
  await renotify.fill("8"); await renotify.press("Tab"); await wait(2);
  assert.equal(puts[1].renotifyHours, 8); assert.equal(puts[1].etaDays, 5);
  await pace.click(); assert.equal(await pace.getAttribute("aria-expanded"), "false");
  // 768–1199 单栏：提醒规则、通知方式、日报（页面里的先后，不分栏）
  await page.setViewportSize({ width: 1000, height: 900 }); await page.reload();
  await rulesP.getByRole("switch").first().waitFor();
  const order = await page.locator(".jy-panel").evaluateAll((els) => els.map((el) => el.querySelector("h2")?.textContent?.trim()).filter(Boolean));
  const at = (name) => order.findIndex((x) => x.startsWith(name));
  assert.ok(at(NOTIFICATIONS_COPY.rules) < at(NOTIFICATIONS_COPY.channels) && at(NOTIFICATIONS_COPY.channels) < at(NOTIFICATIONS_COPY.report), order.join(" / "));
  const [r, c] = [await rulesP.boundingBox(), await page.getByRole("region", { name: NOTIFICATIONS_COPY.channels, exact: true }).boundingBox()];
  assert.ok(Math.abs(r.x - c.x) < 1 && c.y > r.y, "单栏");
});

test("系统设置：首次登录必须先改密码时只有账户安全一块、不分栏；上次自动清理没完成时历史概况直接展开、上面那一句不写", async (t) => {
  let isDefaultPassword = true, cleanupFailed = false;
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "admin", isDefaultPassword });
    if (url.pathname === "/api/settings") {
      const base = settingsFixture();
      return fulfill(route, cleanupFailed ? { ...base, history: { ...base.history, cleanup: { lastError: "cleanup timeout", lastRunAt: new Date().toISOString() } } } : base);
    }
    if (url.pathname === "/api/meta") return fulfill(route, metaFixture());
    throw new Error("unexpected settings fixture API: " + url.pathname);
  }, undefined, false, null, "/settings");
  await page.setViewportSize({ width: 1440, height: 900 });
  const region = (name) => page.getByRole("region", { name, exact: true });
  await region(SETTINGS_COPY.account).getByRole("button", { name: SETTINGS_COPY.changePassword, exact: true }).waitFor();
  for (const name of [SETTINGS_COPY.refresh, SETTINGS_COPY.retention, SETTINGS_COPY.about]) assert.equal(await region(name).count(), 0, name);
  assert.equal(await page.locator(".jy-settings-grid").count(), 0);
  // 改完密码以后两栏，清理没完成：历史概况直接展开，记录数那一句不写
  isDefaultPassword = false; cleanupFailed = true; await page.reload();
  const ret = region(SETTINGS_COPY.retention);
  await ret.getByRole("heading", { name: SETTINGS_COPY.overview, exact: true }).waitFor();
  assert.equal(await ret.getByRole("button", { name: SETTINGS_COPY.healthMore, exact: true }).getAttribute("aria-expanded"), "true");
  assert.equal(await ret.getByText(/^共 .* 条记录，最早/).count(), 0);
  await ret.getByText(new RegExp(SETTINGS_COPY.cleanupFailed)).first().waitFor();
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
  assert.equal(await drawer.getByLabel("渠道里用的其他地址", { exact: true }).count(), 0); assert.equal(await drawer.getByText("不再续费", { exact: true }).isVisible(), false);
  // 改成按用量算：原来的值照旧填着（藏起来时没丢）
  const pickType = async (label) => { await drawer.getByRole("combobox", { name: "类型", exact: true }).click(); await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: label }).first().click(); };
  await pickType("New API"); await drawer.getByLabel("汇率", { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel("汇率", { exact: true }).inputValue(), "7.2"); assert.equal(await drawer.getByLabel("余额提醒线", { exact: true }).inputValue(), "3");
  // 改回固定成本、改一笔金额后保存：汇率、余额提醒线、其他地址照原值带上；不再续费一律 false（会关掉到期提醒，固定成本的表单里没有这个开关）
  await pickType("固定成本"); await drawer.getByLabel("第 1 笔金额（¥）", { exact: true }).fill("320");
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  for (let wait = 0; !saves.length && wait < 50; wait++) await page.waitForTimeout(100);
  assert.equal(saves.length, 1); assert.equal(saves[0].type, "fixed"); assert.equal(saves[0].fixedPurchases[0].amount, "320");
  assert.equal(saves[0].cnyPerUsd, "7.2"); assert.equal(saves[0].lowBalanceUsd, "3"); assert.equal("costAliases" in saves[0], false, "其他地址不在表单里，不带过去（已存的照旧）"); assert.equal(saves[0].noRenewal, false);
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
  assert.equal("costAliases" in saves[0], false); assert.equal(saves[0].lowBalanceUsd, "3"); assert.equal(saves[0].noRenewal, true);
});

test("加上游只填地址和访问令牌：离开令牌栏就试读，下面写「类型 · 名字 · 余额」，读到了才能新增；要用户 ID 的才露出那一栏", async (t) => {
  const detects = [], creates = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations" && method === "GET") return fulfill(route, { stations: [], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/stations" && method === "POST") { creates.push(route.request().postDataJSON()); return fulfill(route, { station: { id: "n1" } }); }
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API 账号", needs: ["accessToken", "userId"] }, { value: "fixed", label: "固定成本", needs: [] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/stations/detect") {
      const body = route.request().postDataJSON(); detects.push(body);
      return fulfill(route, body.userId ? { ok: true, type: "newapi", name: "演示·主力账号", account: "演示·主力账号", remaining: 158.72, currency: "USD" } : { ok: false, needsUserId: true, type: "newapi" });
    }
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations?edit=new");
  const drawer = page.getByRole("dialog", { name: UPSTREAM_FORM_TEXT.create, exact: true }); await drawer.waitFor();
  const save = drawer.getByRole("button", { name: UPSTREAM_FORM_TEXT.create, exact: true });
  assert.equal(await save.isDisabled(), true, "还没读到：不能新增");
  await drawer.getByLabel("站点地址", { exact: true }).fill("https://api.example.com");
  await drawer.getByLabel("访问令牌", { exact: true }).fill("pat-123"); await drawer.getByLabel("站点地址", { exact: true }).click();
  const userId = drawer.getByLabel("用户 ID", { exact: false }); await userId.waitFor();
  assert.deepEqual(detects.map((d) => [d.baseUrl, d.token, d.userId]), [["https://api.example.com", "pat-123", ""]]);
  await userId.fill("7"); await drawer.getByLabel("站点地址", { exact: true }).click();
  await drawer.getByText("New API 账号 · 演示·主力账号 · 余额", { exact: false }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".ant-drawer .ant-btn-primary[disabled]"));
  await save.click();
  for (let wait = 0; !creates.length && wait < 50; wait++) await page.waitForTimeout(100);
  assert.deepEqual([creates[0].type, creates[0].name, creates[0].accessToken, creates[0].userId, creates[0].baseUrl], ["newapi", "演示·主力账号", "pat-123", "7", "https://api.example.com"]);
});

test("上游资源：「渠道」一列写几个或「没有渠道」，不能挂渠道的类型写「—」；点开右边抽屉，绑定渠道（渠道默认选第一个、Key 只剩一把替你选好）发 select-key", async (t) => {
  const posts = [];
  const up = (id, name, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, hasAccessToken: true, balance: { ok: true, remaining: 100, checkedAt: new Date().toISOString() }, prediction: { etaDays: 30, burnPerDay: 3, basis: "近 3 小时" }, ...extra });
  const stations = [{ id: "own", name: "我的站", type: "newapi", isOwn: true, baseUrl: "https://own.test", monitorEnabled: true }, up("up1", "主力上游"), up("up2", "没有渠道上游"), up("up3", "备用上游三"), up("up4", "备用上游四"), up("kk", "只用 Key", { type: "newapi-key" })];
  const channels = [
    { channelId: 1, name: "高速 A", address: "up1.test", ruleId: "r1", upstreamStationId: "up1", tokenId: 9, tokenName: "oai", tokenGroup: "default", sinceDay: "2026-10-12", suggestedUpstreamId: null },
    { channelId: 5, name: "新模型 P", address: "elsewhere.test", ruleId: null, upstreamStationId: null, tokenId: null, tokenName: null, tokenGroup: null, sinceDay: null, suggestedUpstreamId: null },
    { channelId: 6, name: "长文本 Q", address: "up1.test", ruleId: null, upstreamStationId: null, tokenId: null, tokenName: null, tokenGroup: null, sinceDay: null, suggestedUpstreamId: "up1" }];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations, settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date().toISOString() });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/reconciliation/channels/options") return fulfill(route, { ok: true, upstreams: [{ id: "up1", name: "主力上游" }], channels });
    if (path === "/api/reconciliation/upstreams/up1/keys") return fulfill(route, { platform: "newapi", tokens: [{ id: 9, name: "oai", status: 1, group: "default" }, { id: 30, name: "oai-16", status: 1, group: "default" }, { id: 31, name: "停用的", status: 2 }] });
    if (path === "/api/reconciliation/channels/select-key") { posts.push(route.request().postDataJSON()); return fulfill(route, { changed: true }); }
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  const table = page.locator(".jy-stations-table");
  const cell = (name) => table.locator("tbody tr", { hasText: name }).first().locator("td").nth(2);
  await cell("主力上游").getByText("1 个", { exact: true }).waitFor();
  await cell("没有渠道上游").getByText("没有渠道", { exact: true }).waitFor();
  assert.equal(await cell("只用 Key").innerText(), "—", "不能挂渠道的类型写「—」");
  await cell("主力上游").getByRole("button").click();
  const drawer = page.getByRole("dialog", { name: /主力上游的渠道/ }); await drawer.waitFor();
  assert.deepEqual(await drawer.locator("thead th").allInnerTexts(), ["渠道", "Key", "绑定日期", "操作"]);
  await drawer.getByText("oai · 分组 default", { exact: true }).waitFor();
  await drawer.getByText("10月12日", { exact: true }).waitFor();
  assert.equal(await drawer.getByText(/利润|开始算|停止算/).count(), 0, "上游资源里不出现利润");
  await drawer.getByRole("button", { name: "＋ 绑定渠道" }).click();
  await page.getByRole("dialog", { name: "绑定渠道", exact: true }).getByText("主力上游 · up1.test", { exact: true }).waitFor();
});

test("上游资源：别的列的数字很长时，「渠道」一列的「2 个」「没有渠道」「—」仍各占一行（1280、1440、1920、2560 宽）", async (t) => {
  const now = Date.now();
  const spark = Array.from({ length: 24 }, (_, i) => [now - (24 - i) * 3600e3, 35101 + (24 - i) * 6700]);
  const long = { balance: { ok: true, remaining: 35101.28, checkedAt: new Date().toISOString() }, prediction: { etaDays: 2, burnPerDay: 161091, basis: "近 3 小时" }, spark, todayUsed: 56124, todayIsEstimate: true };
  const up = (id, name, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, hasAccessToken: true, ...long, ...extra });
  const stations = [{ id: "own", name: "我的站", type: "newapi", isOwn: true, baseUrl: "https://own.test", monitorEnabled: true }, up("up1", "主力上游"), up("up2", "没有渠道上游"), up("up3", "备用上游三"), up("up4", "备用上游四"), up("kk", "只用 Key", { type: "newapi-key" })];
  const chan = (channelId, name) => ({ channelId, name, address: "up1.test", ruleId: `r${channelId}`, upstreamStationId: "up1", tokenId: channelId, tokenName: "oai", tokenGroup: "default", sinceDay: "2026-10-12", suggestedUpstreamId: null });
  const channels = [chan(1, "高速 A"), chan(2, "高速 B")];
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations, settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date().toISOString() });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/reconciliation/channels/options") return fulfill(route, { ok: true, upstreams: [{ id: "up1", name: "主力上游" }], channels });
    throw new Error("unexpected API: " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  const table = page.locator(".jy-stations-table");
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width, height });
    await table.locator("tbody tr", { hasText: "主力上游" }).first().locator("td").nth(2).getByText("2 个", { exact: true }).waitFor();
    for (const [name, text] of [["主力上游", "2 个"], ["没有渠道上游", "没有渠道"], ["只用 Key", "—"]]) {
      const cell = table.locator("tbody tr", { hasText: name }).first().locator("td").nth(2);
      assert.equal((await cell.innerText()).trim(), text);
      const box = await cell.getByText(text, { exact: true }).boundingBox();
      assert.ok(box.height <= 24, `${width} 宽：「${text}」应占一行，实际高 ${box.height}`);
    }
    assert.ok((await table.locator("thead th").nth(2).locator("xpath=.").boundingBox()).height <= 48, "表头不折行");
    const fit = await page.evaluate(() => {
      const w = document.querySelector(".jy-table-wrap"), t = document.querySelector(".jy-stations-table"), sub = t.querySelector("tbody .jy-stations-sub > span");
      return { wrap: w.clientWidth, table: t.scrollWidth, subLines: Math.round(sub.getBoundingClientRect().height / parseFloat(getComputedStyle(sub).lineHeight)) };
    });
    if (width >= 1440) assert.ok(fit.table <= fit.wrap, `${width} 宽下表格不该要左右拖（表 ${fit.table}，容器 ${fit.wrap}），「约 N 天」不能被右边固定的操作列盖住`);
    else if (process.env.UI_SHOT_DIR) console.log(`${width} 宽：表 ${fit.table}，容器 ${fit.wrap}，要左右拖 ${fit.table - fit.wrap}px`);
    if (width >= 1920) assert.equal(fit.subLines, 1, `${width} 宽位置够，状态小字该一行放下`);
    if (process.env.UI_SHOT_DIR) await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/stations-${width}x${height}.png` });
    if (width >= 1920 && process.env.UI_SHOT_DIR) {
      await table.locator("tbody tr", { hasText: "主力上游" }).first().getByRole("button", { name: /主力上游的渠道/ }).click();
      await page.getByRole("dialog", { name: /主力上游的渠道/ }).waitFor();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/drawer-${width}x${height}.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: /主力上游的渠道/ }).waitFor({ state: "hidden" });
    }
    if (width === 1440) {
      const long = "「高速 A」有收入，但选的 Key 没用量，请到每日利润页换一把 Key 或者先解绑这个渠道，再回来看这一行";
      const lines = await page.evaluate((text) => { const span = document.querySelector(".jy-stations-table tbody .jy-stations-sub > span"); span.textContent = text; const r = span.getBoundingClientRect(); return Math.round(r.height / parseFloat(getComputedStyle(span).lineHeight)); }, long);
      assert.equal(lines, 2, "状态小字最多两行，多的省略");
      if (process.env.UI_SHOT_DIR) await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/stations-long-title-1440x900.png` });
      await page.reload(); await table.locator("tbody tr", { hasText: "主力上游" }).first().waitFor();
    }
  }
});

// 「绑定渠道」小窗口：和线上一样多的渠道（30 个左右，名字多是网址，6 个已禁用）
async function openBindModal(t, { upstream, host, keys, matching }) {
  const posts = [];
  const names = ["https://api.lumen-cloud.com.cn", "http://10.8.3.21:3000/", "https://relay.example-hub.com/keys/claude-sonnet-premium-pool-overseas-backup", "星河-sonnet4.6-1.6", "https://gw.tianqi-ai.cn/keys", "碎-az-美西A2-1.9", "k7", "aws-东京-gpt5-1.2", "zz-azure-欧洲-2.0", "备用线路-03"];
  const channels = Array.from({ length: 30 }, (_, i) => {
    const channelId = 100 + i, name = i < 10 ? names[i] : `渠道-${i}-${["gpt", "claude", "gemini"][i % 3]}`;
    return { channelId, name, address: i === 5 ? "hub.example-relay.com" : i === 8 ? "az.bridge-cloud.net" : `h${i}.example.net`, enabled: i < 24, ruleId: null, upstreamStationId: null, tokenId: null, tokenName: null, tokenGroup: null, sinceDay: null, suggestedUpstreamId: null };
  });
  channels.push({ channelId: 200, name: "az-备用-0.8", address: "az.bridge-cloud.net", enabled: false, ruleId: null, upstreamStationId: null, tokenId: null, tokenName: null, tokenGroup: null, sinceDay: null, suggestedUpstreamId: null });
  channels.push({ channelId: 1, name: "已绑的", address: host, enabled: true, ruleId: "r1", upstreamStationId: "up1", tokenId: 9, tokenName: "oai", tokenGroup: "default", sinceDay: "2026-10-12", suggestedUpstreamId: null });
  for (const [index, id] of matching.entries()) Object.assign(channels.find((item) => item.channelId === id), { suggestedUpstreamId: "up1", ...(index === 0 ? { name: `${upstream}-claude4.6-1.5`, address: host } : {}) });
  const stations = [{ id: "own", name: "我的站", type: "newapi", isOwn: true, baseUrl: "https://own.test", monitorEnabled: true },
    { id: "up1", name: upstream, type: "newapi", baseUrl: `https://${host}`, monitorEnabled: true, hasAccessToken: true, balance: { ok: true, remaining: 100, checkedAt: new Date().toISOString() }, prediction: { etaDays: 30, burnPerDay: 3, basis: "近 3 小时" } }];
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations, settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date().toISOString() });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/reconciliation/channels/options") return fulfill(route, { ok: true, upstreams: [{ id: "up1", name: upstream }], channels });
    if (path === "/api/reconciliation/upstreams/up1/keys") return fulfill(route, { platform: "newapi", tokens: keys });
    if (path === "/api/reconciliation/channels/select-key") { posts.push(route.request().postDataJSON()); return fulfill(route, { changed: true }); }
    throw new Error("unexpected API: " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".jy-stations-table tbody tr", { hasText: upstream }).first().locator("td").nth(2).getByRole("button").click();
  const drawer = page.getByRole("dialog", { name: new RegExp(`${upstream}的渠道`) }); await drawer.waitFor();
  await drawer.getByRole("button", { name: "＋ 绑定渠道" }).click();
  const bind = page.getByRole("dialog", { name: "绑定渠道", exact: true }); await bind.waitFor();
  await page.waitForTimeout(500);
  return { page, bind, posts };
}
const shot = async (page, name) => { if (process.env.UI_SHOT_DIR) await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/${name}.png` }); };
// 弹窗什么都不超出去：弹窗在屏幕里，渠道列表框、搜索框在弹窗里
async function assertBindModalFits(page, bind) {
  const viewport = page.viewportSize(), box = (await bind.boundingBox());
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height, `弹窗放得进 ${viewport.width}×${viewport.height}：${JSON.stringify(box)}`);
  for (const selector of [".jy-bind-search", ".jy-bind-list", ".ant-select"]) {
    const inner = await bind.locator(selector).first().boundingBox();
    assert.ok(inner.x >= box.x && inner.x + inner.width <= box.x + box.width + 0.5, `${selector} 不超出弹窗 ${JSON.stringify([box, inner])}`);
  }
  const phone = viewport.width < 768;
  assert.equal(Math.round((await bind.locator(".jy-bind-list").boundingBox()).height), phone ? 260 : 300, "渠道列表框固定高：电脑 300，手机 260");
  if (phone) assert.equal(Math.round(box.width), viewport.width - 24, "手机上弹窗宽 = 屏宽减 24");
  else assert.equal(Math.round(box.width), 520);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "页面没有横向滚动");
}

test("上游资源：绑定渠道（地址对得上一个）：对得上的一组在前、默认选好，Key 只剩一把也选好，「绑定」能点，提交的是这个渠道和这把 Key", async (t) => {
  const { page, bind, posts } = await openBindModal(t, { upstream: "云帆", host: "api.yunfan-ai.com", matching: [100], keys: [{ id: 9, name: "oai", status: 1, group: "default" }, { id: 30, name: "oai-07", status: 1, group: "default" }, { id: 31, name: "停用的", status: 2 }] });
  await bind.getByText("云帆 · api.yunfan-ai.com", { exact: true }).waitFor();
  assert.deepEqual(await bind.locator(".jy-bind-group").allInnerTexts(), ["地址对得上这个上游", "其他渠道"]);
  assert.equal(await bind.getByRole("radio", { name: /云帆-claude4.6-1.5/ }).isChecked(), true, "只有一个启用的渠道对得上，默认选好");
  assert.equal(await bind.getByText("已禁用", { exact: true }).count(), 0, "已禁用的默认不列");
  await bind.getByText("显示已禁用的 7 个", { exact: true }).waitFor();
  assert.equal(await bind.getByText(/没有渠道的地址对得上/).count(), 0);
  await bind.getByText("这个上游只剩这一把 Key 没绑渠道，已经替你选好", { exact: true }).waitFor();
  assert.equal(await bind.getByRole("button", { name: "绑定", exact: true }).isEnabled(), true);
  assert.equal(await bind.getByText(/利润/).count(), 0, "小窗口里不出现「利润」");
  await assertBindModalFits(page, bind);
  await shot(page, "bind-match-1440x900");
  await page.setViewportSize({ width: 375, height: 812 }); await page.waitForTimeout(400);
  await assertBindModalFits(page, bind);
  const rows = await bind.locator(".jy-bind-row").first().boundingBox(), line = await bind.locator(".jy-bind-row .jy-bind-name").first().boundingBox(), addr = await bind.locator(".jy-bind-row .jy-bind-addr").first().boundingBox();
  assert.ok(addr.y > line.y + line.height - 2, "手机上地址在名字下面一行");
  assert.ok(rows.height > 40);
  await shot(page, "bind-match-375x812");
  await bind.getByRole("button", { name: "绑定", exact: true }).click();
  for (let i = 0; i < 60 && !posts.length; i++) await page.waitForTimeout(100);
  assert.deepEqual(posts[0], { ownStationId: "own", channelId: 100, upstreamStationId: "up1", tokenId: 30 });
});

test("上游资源：绑定渠道（一个都对不上）：有提示、什么都不选、「绑定」灰着；搜得到名字或地址；搜不到有提示；已禁用的点开才列、带「已禁用」标签", async (t) => {
  const { page, bind, posts } = await openBindModal(t, { upstream: "星港", host: "platform.xinggang.ai", matching: [], keys: [{ id: 30, name: "oai-07", status: 1, group: "default" }, { id: 31, name: "oai-08", status: 1, group: "default" }] });
  await bind.getByText("没有渠道的地址对得上这个上游，用上面的搜索按名字或地址找。", { exact: true }).waitFor();
  assert.equal(await bind.locator(".jy-bind-group").count(), 0, "只有一组，不写标题");
  assert.equal(await bind.getByRole("radio", { checked: true }).count(), 0, "对不上就什么都不选");
  assert.equal(await bind.getByRole("button", { name: "绑定", exact: true }).isDisabled(), true, "选好之前「绑定」是灰的");
  await assertBindModalFits(page, bind);
  await bind.getByRole("searchbox").or(bind.getByPlaceholder("搜渠道名或地址")).first().fill("az");
  assert.deepEqual(await bind.locator(".jy-bind-name").allInnerTexts(), ["碎-az-美西A2-1.9", "zz-azure-欧洲-2.0"], "搜渠道名或地址");
  assert.equal(await bind.getByText("已禁用", { exact: true }).count(), 0);
  await bind.getByText("显示已禁用的 1 个", { exact: true }).click();
  await bind.getByText("收起已禁用的", { exact: true }).waitFor();
  assert.deepEqual(await bind.locator(".jy-bind-name").last().innerText(), "az-备用-0.8", "已禁用的排最后");
  await bind.locator(".jy-bind-off").waitFor();
  assert.equal(await bind.locator(".jy-bind-off").innerText(), "已禁用");
  await shot(page, "bind-none-1440x900");
  await bind.getByPlaceholder("搜渠道名或地址").fill("没有这个名字");
  await bind.getByText("没有这个名字或地址的渠道", { exact: true }).waitFor();
  await bind.getByPlaceholder("搜渠道名或地址").fill("az");
  await bind.getByRole("radio", { name: /碎-az-美西A2-1.9/ }).check();
  assert.equal(await bind.getByRole("button", { name: "绑定", exact: true }).isDisabled(), true, "Key 没选之前还是灰的");
  await bind.locator(".ant-select").click(); await page.getByTitle("oai-08 · 分组 default").click();
  assert.equal(await bind.getByRole("button", { name: "绑定", exact: true }).isEnabled(), true);
  await bind.getByPlaceholder("搜渠道名或地址").fill("zz");
  assert.equal(await bind.getByRole("button", { name: "绑定", exact: true }).isDisabled(), true, "选的渠道被搜索挡住了，不算选着");
  await bind.getByPlaceholder("搜渠道名或地址").fill("");
  await page.setViewportSize({ width: 375, height: 812 }); await page.waitForTimeout(400);
  await assertBindModalFits(page, bind);
  await shot(page, "bind-none-375x812");
  assert.equal(posts.length, 0);
});

// 上游列表的默认排法：线上那种大数字。A 约 5 小时、B 7 小时、C 23 小时，Q 没在花钱，「不再续费」和自营在最下面
async function openOrderPage(t, viewport) {
  const day = 24;
  const up = (id, name, remaining, hoursLeft, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, monitorEnabled: true, hasAccessToken: true,
    balance: { ok: true, remaining, checkedAt: new Date().toISOString() },
    prediction: hoursLeft == null ? { etaDays: null, burnPerDay: 0, basis: "近 3 小时" } : { etaDays: Math.round(hoursLeft / day * 10) / 10, burnPerDay: remaining / hoursLeft * day, basis: "近 3 小时" },
    spark: Array.from({ length: 24 }, (_, i) => [Date.now() - (24 - i) * 3600e3, remaining + (24 - i) * 6700]), todayUsed: 56124, todayIsEstimate: true, ...extra });
  const state = { stations: [
    { id: "own", name: "我的站", type: "newapi", isOwn: true, baseUrl: "https://own.test", monitorEnabled: true },
    up("c", "C 上游", 20413, 23), up("a", "A 上游", 35101.28, 35101.28 / 161091.13 * day), up("b", "B 上游", 23585, 7), up("q", "Q 没在花钱", 80000, null), up("n", "N 不再续费", 9000, 2, { noRenewal: true }),
  ] };
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations: state.stations, settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date().toISOString() });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/reconciliation/channels/options") return fulfill(route, { ok: true, upstreams: state.stations.filter((x) => !x.isOwn).map((x) => ({ id: x.id, name: x.name })), channels: [] });
    throw new Error("unexpected API: " + path);
  }, viewport, !viewport, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  return { page, state };
}
const orderOf = (page, mobile) => page.locator(mobile ? ".jy-stations-m li .m-top" : ".jy-stations-table tbody .jy-stations-name-line > button.link").allInnerTexts();

test("上游列表默认排法：照还能撑多久排（A 5 小时、B 7 小时、C 23 小时），没在花钱的在后面，不再续费和自营在最下；开着抽屉时数据变了顺序不动，关掉以后才变", async (t) => {
  const { page, state } = await openOrderPage(t, undefined);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".jy-stations-table tbody tr", { hasText: "A 上游" }).first().waitFor();
  assert.deepEqual(await orderOf(page), ["A 上游", "B 上游", "C 上游", "Q 没在花钱", "我的站", "N 不再续费"]);
  if (process.env.UI_SHOT_DIR) await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/order-1440x900.png` });
  await page.locator(".jy-stations-table tbody tr", { hasText: "C 上游" }).first().locator("td").nth(2).getByRole("button").click();
  const drawer = page.getByRole("dialog", { name: /C 上游的渠道/ }); await drawer.waitFor();
  // 给 A 充值：A 余额变成 ¥135,101，撑得比 B、C 都久；自动刷新来了，但抽屉开着，顺序不动
  const a = state.stations.find((x) => x.id === "a"); a.balance.remaining = 135101.28; a.prediction = { etaDays: 0.8, burnPerDay: 161091.13, basis: "近 3 小时" };
  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/stations");
  await page.clock.fastForward(61000); await refreshed; await page.waitForTimeout(300);
  assert.deepEqual(await orderOf(page), ["A 上游", "B 上游", "C 上游", "Q 没在花钱", "我的站", "N 不再续费"], "抽屉开着，顺序不动");
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".jy-stations-table tbody tr")?.textContent?.includes("B 上游"));
  assert.deepEqual(await orderOf(page), ["B 上游", "A 上游", "C 上游", "Q 没在花钱", "我的站", "N 不再续费"], "关掉以后按新顺序：B、A、C");
});

test("上游列表默认排法：手机卡片的顺序和电脑一样", async (t) => {
  const { page } = await openOrderPage(t, { width: 375, height: 812 });
  await page.locator(".jy-stations-m li").first().waitFor();
  assert.deepEqual(await orderOf(page, true), ["A 上游", "B 上游", "C 上游", "Q 没在花钱", "我的站", "N 不再续费"]);
  if (process.env.UI_SHOT_DIR) await page.screenshot({ path: `${process.env.UI_SHOT_DIR}/order-375x812.png` });
});

test("上游资源：抽屉里「解绑」先弹确认框，写清楚不再挂在这个上游下面，确认后发 stop", async (t) => {
  const stops = [];
  const stations = [{ id: "own", name: "我的站", type: "newapi", isOwn: true, baseUrl: "https://own.test", monitorEnabled: true },
    { id: "up1", name: "主力上游", type: "newapi", baseUrl: "https://up1.test", monitorEnabled: true, hasAccessToken: true, balance: { ok: true, remaining: 100, checkedAt: new Date().toISOString() }, prediction: { etaDays: 30, burnPerDay: 3, basis: "近 3 小时" } }];
  const channels = [{ channelId: 1, name: "高速 A", address: "up1.test", ruleId: "r1", upstreamStationId: "up1", tokenId: 9, tokenName: "oai", tokenGroup: "default", sinceDay: "2026-10-12", suggestedUpstreamId: null }];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/stations") return fulfill(route, { stations, settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, generatedAt: new Date().toISOString() });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    if (path === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (path === "/api/reconciliation/channels/options") return fulfill(route, { ok: true, upstreams: [{ id: "up1", name: "主力上游" }], channels });
    if (path === "/api/reconciliation/channels/stop") { stops.push(route.request().postDataJSON()); channels.length = 0; return fulfill(route, { stopped: [], optedOut: [] }); }
    throw new Error("unexpected API: " + method + " " + path);
  }, undefined, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }), "/stations");
  await page.locator(".jy-stations-table tbody tr", { hasText: "主力上游" }).first().locator("td").nth(2).getByRole("button").click();
  const drawer = page.getByRole("dialog", { name: /主力上游的渠道/ }); await drawer.waitFor();
  await drawer.getByRole("button", { name: "解绑 高速 A", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "解绑「高速 A」？", exact: true });
  await confirm.getByText("解绑后，「高速 A」不再挂在主力上游下面，以后可以再绑。", { exact: true }).waitFor();
  await confirm.getByRole("button", { name: "解绑", exact: true }).click();
  for (let i = 0; i < 60 && !stops.length; i++) await page.waitForTimeout(100);
  assert.deepEqual(stops[0], { ownStationId: "own", channelIds: [1] });
  await drawer.getByText("这个上游下还没有渠道", { exact: true }).waitFor();
});

// ---- 合并重复的上游（K1a，design/ux/k1a-merge.md 第 9 节验收清单）-------------------------------------
const MERGE_TZ = "Asia/Shanghai";
const mergeBrief = (id, name) => ({ id, name });
const mergeEstimate = () => ({ windows: [
  { days: 7, before: { cny: 3211.2 }, after: { cny: 1070.4 } }, { days: 30, before: { cny: 13982.4 }, after: { cny: 4660.8 } }] });
const mergeGroupOf = (extra = {}) => ({
  key: { provider: "newapi", baseUrl: "https://api.example.com", accountId: "1024" },
  retained: { id: "m-a", name: "主力上游", baseUrl: "https://api.example.com", createdAt: "2026-10-03T02:00:00.000Z" },
  merged: [mergeBrief("m-b", "主力上游（2）"), mergeBrief("m-c", "主力上游·备用")],
  ruleIds: [], linkCount: 0, droppedLinkCount: 0, costAliasesAfter: [], blockers: [], canMerge: true, estimate: mergeEstimate(), rateNote: null,
  versions: { "m-a": { authVersion: 1, resourceVersion: "v-a" }, "m-b": { authVersion: 2, resourceVersion: "v-b" }, "m-c": { authVersion: 1, resourceVersion: "v-c" } }, ...extra,
});
const mergeBlockedGroup = () => mergeGroupOf({
  retained: { id: "k-a", name: "拼车团队", baseUrl: "https://pool.example.net", createdAt: "2026-10-05T02:00:00.000Z" },
  merged: [mergeBrief("k-b", "拼车团队（旧）")], canMerge: false,
  blockers: [{ code: "RULE_KEY_CONFLICT", detail: "", tokenId: 5, tokenName: "oai", ruleId: "rule-oai", stationIds: ["k-a", "k-b"] }],
  estimate: { windows: [{ days: 7, before: { cny: 16.8 }, after: { cny: 8.4 } }, { days: 30, before: { cny: 72 }, after: { cny: 36 } }] },
});
const mergeCountsOf = (model) => ({ mergeable: model.groups.filter((g) => g.canMerge).length, blocked: model.groups.filter((g) => !g.canMerge).length,
  accounts: model.groups.length, upstreams: model.groups.reduce((n, g) => n + 1 + g.merged.length, 0), records: model.records.length });
// model.failMerge / failUndo：下一次 POST 回的错（一次性），{ status（默认 409）, ...body }
async function openMergePage(t, model, { viewport, path = "/stations" } = {}) {
  const calls = [];
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url()), p = url.pathname, method = route.request().method();
    if (p === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (p === "/api/stations") return fulfill(route, { stations: [{ id: "m-a", name: "主力上游", type: "newapi", baseUrl: "https://api.example.com", monitorEnabled: true, balance: { ok: true, remaining: 12.3, checkedAt: new Date().toISOString() }, prediction: null, spark: [] }],
      settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, tz: MERGE_TZ, generatedAt: new Date().toISOString(), merge: mergeCountsOf(model) });
    if (p === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {}, settings: {} });
    if (p === "/api/reconciliation") return fulfill(route, { results: [], actions: [] });
    if (/^\/api\/stations\/[^/]+$/.test(p) && method === "PUT") {
      const body = route.request().postDataJSON(); calls.push({ path: p, body });
      // model.failResume：「恢复监控」时回的错（一次性），比如版本对不上的 409
      if (model.failResume) { const { status = 409, ...failure } = model.failResume; model.failResume = null; return failJSON(route, status, failure); }
      model.groups = model.groups.map((g) => ({ ...g, blockers: g.blockers.filter((b) => b.code !== "MONITOR_MISMATCH"), canMerge: g.blockers.every((b) => b.code === "MONITOR_MISMATCH") }));
      return fulfill(route, { station: { id: p.split("/").pop() } });
    }
    if (p === "/api/upstream-merges" && method === "GET") model.gets = (model.gets || 0) + 1;
    if (p === "/api/upstream-merges" && method === "GET") return fulfill(route, { groups: model.groups, records: model.records, counts: mergeCountsOf(model), tz: MERGE_TZ });
    if (p === "/api/upstream-merges" && method === "POST") {
      const body = route.request().postDataJSON(); calls.push({ path: p, body });
      if (model.failMerge) { const { status = 409, ...failure } = model.failMerge; model.failMerge = null; return failJSON(route, status, failure); }
      const group = model.groups.find((g) => g.retained.id === body.retainedId);
      model.groups = model.groups.filter((g) => g !== group);
      model.records.unshift({ mergeId: `mg_${calls.length}`, mergedAtMs: Date.parse("2026-10-25T06:30:00Z"), undoneAtMs: null, retained: { id: group.retained.id, name: group.retained.name }, merged: group.merged, undoable: true, undoBlocked: null, group });
      return fulfill(route, { mergeId: `mg_${calls.length}` });
    }
    if (p === "/api/upstream-merges/undo") {
      const body = route.request().postDataJSON(); calls.push({ path: p, body });
      if (model.failUndo) { const { status = 409, ...failure } = model.failUndo; model.failUndo = null; return failJSON(route, status, failure); }
      const record = model.records.find((r) => r.mergeId === body.mergeId); record.undoneAtMs = Date.parse("2026-10-25T07:10:00Z"); record.undoable = false; model.groups.push(record.group);
      return fulfill(route, { mergeId: body.mergeId });
    }
    throw new Error("unexpected API: " + method + " " + p);
  }, viewport, false, (route) => fulfill(route, { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: new Date().toISOString() }), path);
  return { page, calls };
}
const mergeDrawer = (page) => page.getByRole("dialog", { name: "合并重复的上游", exact: true });
const mergeCard = (page, name) => page.locator("section.jy-merge-card").filter({ has: page.getByRole("heading", { name: new RegExp(`^「${name}」这一组`) }) });

test("合并重复的上游：没有要合的、合并记录里也没东西时，上游列表没有提示也没有「合并记录」", async (t) => {
  const { page } = await openMergePage(t, { groups: [], records: [] });
  await page.getByRole("button", { name: "主力上游 的更多操作", exact: true }).first().waitFor();
  assert.equal(await page.getByTestId("merge-notice").count(), 0);
  assert.equal(await page.getByRole("button", { name: "更多操作", exact: true }).count(), 0);
});

test("合并重复的上游：提示写有几组，点「查看」打开抽屉；一组一张卡片，没有「全部合并」；合并先确认、确认后这一组消失、合并记录多一行", async (t) => {
  const model = { groups: [mergeGroupOf(), mergeBlockedGroup()], records: [] };
  const { page, calls } = await openMergePage(t, model);
  const notice = page.getByTestId("merge-notice");
  await notice.getByText("有 2 组上游是同一个账号，合成一个以后成本估算不再重复算", { exact: true }).waitFor();
  await notice.getByRole("button", { name: "查看", exact: true }).click();
  const drawer = mergeDrawer(page); await drawer.waitFor();
  await drawer.getByText("下面每组是同一个上游账号（类型、地址、账号 ID 都一样），被加成了几个上游。合成一个以后，成本估算不再重复算；每日利润不受影响。", { exact: true }).waitFor();
  const card = mergeCard(page, "主力上游");
  await card.getByText("3 个上游", { exact: true }).waitFor();
  await card.getByText("「主力上游（2）」「主力上游·备用」并进「主力上游」", { exact: true }).waitFor();
  await card.getByText("留下的是最早加的那个（10月3日 加的，余额历史最长）；名字以后可以在编辑上游里改。地址 api.example.com、账号 ID 1024 都一样。", { exact: true }).waitFor();
  await card.getByText("近 7 天", { exact: true }).waitFor(); await card.getByText("¥3,211.20 → ¥1,070.40", { exact: true }).waitFor();
  await card.getByText("¥13,982.40 → ¥4,660.80", { exact: true }).waitFor(); await card.getByText("这个账号加成了 3 个上游", { exact: true }).waitFor();
  assert.equal(await drawer.getByRole("button", { name: /全部合并/ }).count(), 0);
  // 合不了的那组：标「合不了」，「合并」灰着，写清是哪把 Key 在哪两个上游下，有「处理重复」
  const blocked = mergeCard(page, "拼车团队");
  await blocked.getByText("合不了", { exact: true }).waitFor();
  assert.equal(await blocked.getByRole("button", { name: "合并", exact: true }).isDisabled(), true);
  await blocked.getByText("「拼车团队」和「拼车团队（旧）」下都绑了 Key「oai」，合成一个以后这把 Key 会算两次。先在需处理里处理「这把 Key 绑了两次」那一条，再回来合。", { exact: true }).waitFor();
  await blocked.getByRole("button", { name: "处理重复", exact: true }).waitFor();
  // 合并：先确认
  await card.getByRole("button", { name: "合并", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
  await confirm.getByText("「主力上游（2）」「主力上游·备用」会并进「主力上游」：它们从上游列表里消失，不再单独读余额；登录信息、余额历史都留着。", { exact: true }).waitFor();
  await confirm.getByText("绑定改到「主力上游」上，每日利润不变。成本估算近 30 天从 ¥13,982.40 变成 ¥4,660.80，不再重复算。", { exact: true }).waitFor();
  await confirm.getByText("合错了可以在「合并记录」里退回。", { exact: true }).waitFor();
  assert.equal(calls.length, 0);
  await confirm.getByRole("button", { name: "取消", exact: true }).click(); await confirm.waitFor({ state: "hidden" });
  assert.equal(calls.length, 0);
  await card.getByRole("button", { name: "合并", exact: true }).click(); await confirm.waitFor();
  await confirm.getByRole("button", { name: "合并", exact: true }).click(); await confirm.waitFor({ state: "hidden" });
  assert.deepEqual(calls, [{ path: "/api/upstream-merges", body: { retainedId: "m-a", mergedIds: ["m-b", "m-c"] } }]);
  await page.getByText("已合并，上游列表少了 2 个", { exact: true }).waitFor();
  await card.waitFor({ state: "detached" });
  // 合并记录：收起区，点开一行一次
  const records = drawer.getByRole("button", { name: "合并记录（1 次）", exact: true }); await records.click();
  await drawer.getByText(formatZonedDateTime(Date.parse("2026-10-25T06:30:00Z"), MERGE_TZ), { exact: true }).waitFor();
  await drawer.getByText("「主力上游（2）」「主力上游·备用」并进「主力上游」", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "退回", exact: true }).waitFor();
});

test("合并重复的上游：碰上 409（这一组在别处变了）写「这一组已经变了，刷新后再看。」，按钮是「刷新」不是「再试一次」，点了关掉确认框、重读清单", async (t) => {
  const model = { groups: [mergeGroupOf()], records: [], failMerge: { error: "清单变了", code: "UPSTREAM_MERGE_STALE" } };
  const { page, calls } = await openMergePage(t, model);
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  await mergeCard(page, "主力上游").getByRole("button", { name: "合并", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
  await confirm.getByRole("button", { name: "合并", exact: true }).click();
  await confirm.getByText("这一组已经变了，刷新后再看。", { exact: true }).waitFor();
  assert.equal(await confirm.getByRole("button", { name: "再试一次", exact: true }).count(), 0);
  // 别处已经合过了：刷新以后这一组不在清单里
  model.groups = [];
  await confirm.getByRole("button", { name: "刷新", exact: true }).click(); await confirm.waitFor({ state: "hidden" });
  assert.equal(calls.length, 1, "没有再发一次合并");
  await mergeDrawer(page).getByText("没有要合的上游了。", { exact: true }).waitFor();
});

test("合并重复的上游：别的没成（连不上之类）写「合并没成：原因。什么都没改。」，按钮换成「再试一次」，再点成功", async (t) => {
  const model = { groups: [mergeGroupOf()], records: [], failMerge: { status: 500, error: "boom" } };
  const { page, calls } = await openMergePage(t, model);
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  await mergeCard(page, "主力上游").getByRole("button", { name: "合并", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
  await confirm.getByRole("button", { name: "合并", exact: true }).click();
  await confirm.getByText("合并没成：操作没完成，请稍后再试。什么都没改。", { exact: true }).waitFor();
  await confirm.getByRole("button", { name: "再试一次", exact: true }).click(); await confirm.waitFor({ state: "hidden" });
  assert.equal(calls.length, 2);
  await page.getByText("已合并，上游列表少了 2 个", { exact: true }).waitFor();
});

test("合并重复的上游：退回碰上 409 写「这次合并已经变了，刷新后再看。」[刷新]", async (t) => {
  const group = mergeGroupOf();
  const record = { mergeId: "mg_x", mergedAtMs: Date.parse("2026-10-20T01:12:00Z"), undoneAtMs: null, retained: { id: "m-a", name: "主力上游" }, merged: [mergeBrief("m-b", "主力上游（2）")], undoable: true, undoBlocked: null, group };
  const model = { groups: [], records: [record], failUndo: { error: "已经退回了", code: "UPSTREAM_MERGE_STALE" } };
  const { page } = await openMergePage(t, model);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "合并记录", exact: true }).click();
  const drawer = mergeDrawer(page); await drawer.getByRole("button", { name: "合并记录（1 次）", exact: true }).click();
  await drawer.getByRole("button", { name: "退回", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "退回这次合并？", exact: true }); await confirm.waitFor();
  await confirm.getByRole("button", { name: "退回", exact: true }).click();
  await confirm.getByText("这次合并已经变了，刷新后再看。", { exact: true }).waitFor();
  assert.equal(await confirm.getByRole("button", { name: "再试一次", exact: true }).count(), 0);
  await confirm.getByRole("button", { name: "刷新", exact: true }).click(); await confirm.waitFor({ state: "hidden" });
});

test("合并重复的上游：只有合不了的组时提示换一句；「处理重复」去现成的那个地方；前后的数带「≈」时照写", async (t) => {
  const blocked = mergeBlockedGroup(); blocked.estimate = { windows: [{ days: 7, approx: true, before: { cny: 3211.2 }, after: { cny: 1070.4 } }, { days: 30, approx: true, before: { cny: 13982.4 }, after: { cny: 4660.8 } }] };
  const { page } = await openMergePage(t, { groups: [blocked], records: [] });
  await page.getByTestId("merge-notice").getByText("有 1 组上游是同一个账号，现在还合不了", { exact: true }).waitFor();
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "拼车团队");
  await card.getByText("≈ ¥3,211.20 → ≈ ¥1,070.40", { exact: true }).waitFor();
  await card.getByRole("button", { name: "处理重复", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/stations" && url.searchParams.get("action") === "conflict" && url.searchParams.get("ruleId") === "rule-oai");
});

test("合并重复的上游：前后的数一样时，确认框第二句只写绑定改到哪、每日利润不变", async (t) => {
  const same = mergeGroupOf({ estimate: { windows: [{ days: 7, before: { cny: 5 }, after: { cny: 5 } }, { days: 30, before: { cny: 21.32 }, after: { cny: 21.32 } }] } });
  const { page } = await openMergePage(t, { groups: [same], records: [] });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  await mergeCard(page, "主力上游").getByRole("button", { name: "合并", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
  await confirm.getByText("绑定改到「主力上游」上，每日利润不变。", { exact: true }).waitFor();
  assert.equal(await confirm.getByText(/从 .* 变成/).count(), 0);
});

test("合并重复的上游：合并记录里「退回」先确认，退回后那一行写已退回、不再有按钮，这一组回到清单；退回不了的按钮灰着、悬停写原因", async (t) => {
  const group = mergeGroupOf();
  const record = (extra) => ({ mergeId: "mg_x", mergedAtMs: Date.parse("2026-10-20T01:12:00Z"), undoneAtMs: null, retained: { id: "m-a", name: "主力上游" }, merged: [mergeBrief("m-b", "主力上游（2）")], undoable: true, undoBlocked: null, group, ...extra });
  const model = { groups: [], records: [record(), record({ mergeId: "mg_gone", undoable: false, undoBlocked: { code: "UPSTREAM_DELETED", detail: "「主力上游（3）」已经删了，退回不了" } })] };
  const { page, calls } = await openMergePage(t, model);
  // 没有要合的组，提示不出现；合并记录入口在「⋯」里
  assert.equal(await page.getByTestId("merge-notice").count(), 0);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "合并记录", exact: true }).click();
  const drawer = mergeDrawer(page); await drawer.getByText("没有要合的上游了。", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "合并记录（2 次）", exact: true }).click();
  const rows = drawer.locator("li.jy-merge-record");
  const gone = rows.nth(1);
  assert.equal(await gone.getByRole("button", { name: "退回", exact: true }).isDisabled(), true);
  assert.equal(await gone.getByRole("button", { name: "退回", exact: true }).getAttribute("title"), "「主力上游（3）」已经删了，退回不了");
  // 原因也写在这一行下面（悬停提示键盘、读屏、手机读不到）
  await gone.getByText("「主力上游（3）」已经删了，退回不了", { exact: true }).waitFor();
  // 桌面宽度下原因另起一行，正文不能被压扁（不换行时「并进」那段文字会是 0 宽、逐字竖排，getByText 对 0 宽节点也算可见，所以要量）
  const text = await gone.locator(".jy-merge-record__text").boundingBox();
  assert.ok(text.width > 150 && text.height < 40, `正文 ${text.width}×${text.height}`);
  const why = await gone.locator(".jy-merge-record__why").boundingBox(), when = await gone.locator(".jy-merge-record__when").boundingBox();
  assert.ok(why.y > when.y + when.height - 1, "原因在下一行");
  await rows.first().getByRole("button", { name: "退回", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "退回这次合并？", exact: true }); await confirm.waitFor();
  await confirm.getByText("「主力上游（2）」回到上游列表，接着各自读余额；成本估算又会把这个账号重复算。", { exact: true }).waitFor();
  await confirm.getByText("合并以后在「主力上游」上加的绑定和改的设置，留在「主力上游」上，不跟着走。", { exact: true }).waitFor();
  await confirm.getByRole("button", { name: "退回", exact: true }).click(); await confirm.waitFor({ state: "hidden" });
  assert.deepEqual(calls, [{ path: "/api/upstream-merges/undo", body: { mergeId: "mg_x" } }]);
  await page.getByText("已退回", { exact: true }).first().waitFor();
  await rows.first().getByText(`已退回（${formatZonedDateTime(Date.parse("2026-10-25T07:10:00Z"), MERGE_TZ)}）`, { exact: true }).waitFor();
  assert.equal(await rows.first().getByRole("button", { name: "退回", exact: true }).count(), 0);
  await mergeCard(page, "主力上游").waitFor();
});

test("合并重复的上游：手机上抽屉从底部升起占满，按钮至少 44 高", async (t) => {
  const { page } = await openMergePage(t, { groups: [mergeGroupOf()], records: [] }, { viewport: { width: 390, height: 844 } });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const drawer = mergeDrawer(page); await drawer.waitFor();
  const box = await page.locator(".ant-drawer-content-wrapper").filter({ has: page.getByTestId("merge-drawer") }).boundingBox();
  assert.ok(box.width >= 389 && box.height >= 843, `抽屉占满：${box.width}×${box.height}`);
  assert.ok((await mergeCard(page, "主力上游").getByRole("button", { name: "合并", exact: true }).boundingBox()).height >= 44);
  assert.ok((await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).boundingBox()).height >= 44, "提示条里的「查看」");
  await mergeCard(page, "主力上游").getByRole("button", { name: "合并", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await sheet.waitFor();
  // 弹窗出现时有缩放动画，这时量到的高度不准（CI 上间歇失败过）：读样式里的最小高度，不量动画中的外框
  for (const name of ["取消", "合并"]) {
    const minHeight = await sheet.getByRole("button", { name, exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
    assert.ok(minHeight >= 44, `确认框里的「${name}」最小高度 ${minHeight}`);
  }
});

test("合并重复的上游：另外几种合不了的一项一行，按钮放第一项的；「恢复监控」就地恢复被暂停的那个，改成一样以后「合并」能点", async (t) => {
  const blocked = mergeGroupOf({ merged: [mergeBrief("m-b", "主力上游（2）")], canMerge: false, blockers: [
    { code: "MONITOR_MISMATCH", detail: "", monitoredIds: ["m-a"], pausedIds: ["m-b"], differsIds: ["m-b"] },
    { code: "PROFIT_MISMATCH", detail: "", countedIds: ["m-a"], uncountedIds: ["m-b"], differsIds: ["m-b"] }] });
  const model = { groups: [blocked], records: [] };
  const { page, calls } = await openMergePage(t, model);
  await page.getByTestId("merge-notice").getByText("有 1 组上游是同一个账号，现在还合不了", { exact: true }).waitFor();
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "主力上游");
  await card.getByText("「主力上游」在读余额，「主力上游（2）」暂停了监控，合成一个以后不知道该不该接着读。先改成一样（都恢复监控，或者都暂停），再回来合。", { exact: true }).waitFor();
  await card.getByText("「主力上游」算进利润，「主力上游（2）」不算进利润，合成一个以后不知道该按哪个算。先在编辑上游里改成一样，再回来合。", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "合并", exact: true }).isDisabled(), true);
  assert.equal(await card.getByRole("button", { name: "编辑上游", exact: true }).count(), 0, "按钮只放第一项的");
  await card.getByRole("button", { name: "恢复监控", exact: true }).click();
  // 先问一句：不是点一下就改
  const resumeConfirm = page.getByRole("dialog", { name: "恢复监控「主力上游（2）」？", exact: true }); await resumeConfirm.waitFor();
  await resumeConfirm.getByText("恢复以后接着读它的余额。这一组改成一样以后就能合。", { exact: true }).waitFor();
  assert.equal(calls.length, 0);
  await resumeConfirm.getByRole("button", { name: "取消", exact: true }).click(); await resumeConfirm.waitFor({ state: "hidden" });
  assert.equal(calls.length, 0);
  await card.getByRole("button", { name: "恢复监控", exact: true }).click(); await resumeConfirm.waitFor();
  await resumeConfirm.getByRole("button", { name: "恢复监控", exact: true }).click();
  await page.getByText("已恢复监控", { exact: true }).waitFor();
  // 带着清单上看到的版本号去改
  assert.deepEqual(calls, [{ path: "/api/stations/m-b", body: { monitorEnabled: true, expectedAuthVersion: 2, expectedResourceVersion: "v-b" } }]);
  await card.getByRole("button", { name: "编辑上游", exact: true }).waitFor();
});

test("合并重复的上游：被合掉的那个记了固定成本时，按钮「编辑上游」打开它；标了转售 Key 的只写说明、没有按钮", async (t) => {
  const fixed = mergeGroupOf({ merged: [mergeBrief("m-b", "主力上游（2）")], canMerge: false, blockers: [{ code: "MERGED_HAS_FIXED_COST", detail: "", stationId: "m-b" }] });
  const { page } = await openMergePage(t, { groups: [fixed], records: [] });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "主力上游");
  await card.getByText("「主力上游（2）」记了固定成本，合掉以后这几笔就不算了。先在「主力上游」上记上同样的固定成本、再从「主力上游（2）」上删掉，再回来合。", { exact: true }).waitFor();
  await card.getByRole("button", { name: "编辑上游", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/stations" && url.searchParams.get("edit") === "m-b");
  const resold = mergeGroupOf({ merged: [mergeBrief("m-b", "主力上游（2）")], canMerge: false, blockers: [{ code: "MERGED_HAS_RESOLD_KEYS", detail: "", stationId: "m-b" }] });
  const next = await openMergePage(t, { groups: [resold], records: [] });
  await next.page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const soldCard = mergeCard(next.page, "主力上游");
  await soldCard.getByText("「主力上游（2）」上还标着转售 Key，合掉以后这些标记就不算了。先把它上面的转售标记取消，再回来合。", { exact: true }).waitFor();
  assert.equal(await soldCard.getByRole("button").count(), 1, "只有灰着的「合并」");
});

test("合并重复的上游：留下的没设汇率、被合掉的设了，合不了，写清汇率，按钮「编辑上游」打开留下的；估算写「—」", async (t) => {
  const group = mergeGroupOf({ merged: [mergeBrief("m-b", "主力上游（2）")], canMerge: false, estimate: null,
    blockers: [{ code: "RATE_UNSET_ON_RETAINED", detail: "", stationId: "m-a", mergedRates: [{ id: "m-b", rate: 7.2 }] }] });
  const { page } = await openMergePage(t, { groups: [group], records: [] });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "主力上游");
  await card.getByText("「主力上游」没设汇率，「主力上游（2）」设了（1 美元 = 7.20 元），合掉以后这个汇率就不算了。先给「主力上游」设上汇率，再回来合。", { exact: true }).waitFor();
  await card.getByText("— → —", { exact: true }).first().waitFor();
  assert.equal(await card.getByRole("button", { name: "合并", exact: true }).isDisabled(), true);
  await card.getByRole("button", { name: "编辑上游", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/stations" && url.searchParams.get("edit") === "m-a");
});

test("合并重复的上游：两边都设了汇率但不一样，不挡合并，卡片灰字和确认框里写按留下的那个算", async (t) => {
  const group = mergeGroupOf({ merged: [mergeBrief("m-b", "主力上游（2）")], rateNote: { retainedRate: 7.2, others: [{ id: "m-b", rate: 7.1 }] } });
  const { page } = await openMergePage(t, { groups: [group], records: [] });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "主力上游");
  await card.getByTestId("merge-rate-note").getByText("合并以后汇率按「主力上游」的 1 美元 = 7.20 元算（「主力上游（2）」是 7.10 元）。", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "合并", exact: true }).isEnabled(), true);
  await card.getByRole("button", { name: "合并", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
  await confirm.getByText("绑定改到「主力上游」上，每日利润不变。合并以后汇率按「主力上游」的 1 美元 = 7.20 元算（「主力上游（2）」是 7.10 元）。成本估算近 30 天从 ¥13,982.40 变成 ¥4,660.80，不再重复算。", { exact: true }).waitFor();
});

test("合并重复的上游：重新打开抽屉先不显示上次的卡片", async (t) => {
  const model = { groups: [mergeGroupOf()], records: [] };
  const { page } = await openMergePage(t, model);
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  await mergeCard(page, "主力上游").waitFor();
  await page.keyboard.press("Escape");
  await mergeDrawer(page).waitFor({ state: "hidden" });
  model.groups = [];
  await page.route("**/api/upstream-merges", async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await route.fallback(); });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  await mergeDrawer(page).waitFor();
  assert.equal(await mergeCard(page, "主力上游").count(), 0, "加载期间不显示旧卡片");
});

test("合并重复的上游：这一组没有按量算进利润的上游时，卡片不写「¥0.00 → ¥0.00」，换一句灰字；确认框只写绑定改到哪、每日利润不变", async (t) => {
  const zero = (noCounted) => ({ noCounted, windows: [{ days: 7, before: { cny: 0 }, after: { cny: 0 } }, { days: 30, before: { cny: 0 }, after: { cny: 0 } }] });
  for (const [noCounted, note] of [["fixed_cost", "这一组都按固定成本算，成本估算里没有按用量算的花费，合并前后不变。"], ["not_in_profit", "这一组都不算进利润，成本估算不算它们，合并前后不变。"]]) {
    const { page } = await openMergePage(t, { groups: [mergeGroupOf({ estimate: zero(noCounted) })], records: [] });
    await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
    const card = mergeCard(page, "主力上游");
    await card.getByText(note, { exact: true }).waitFor();
    await card.getByText("这个账号加成了 3 个上游", { exact: true }).waitFor();
    assert.equal(await card.getByText("→", { exact: false }).count(), 0, "没有前后的数");
    assert.equal(await card.getByText("近 7 天", { exact: true }).count(), 0);
    await card.getByRole("button", { name: "合并", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
    await confirm.getByText("绑定改到「主力上游」上，每日利润不变。", { exact: true }).waitFor();
    assert.equal(await confirm.getByText(/从 .* 变成/).count(), 0);
  }
});

test("合并重复的上游：留下的设了汇率、被合掉的没设（或设的不一样）：不挡合并，卡片和确认框都写合并以后按留下的那个算，没设的写「没设汇率」", async (t) => {
  const rateNote = { retainedRate: 7.2, others: [{ id: "m-b", rate: null }, { id: "m-c", rate: 7.1 }] };
  const { page } = await openMergePage(t, { groups: [mergeGroupOf({ rateNote })], records: [] });
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "主力上游");
  const sentence = "合并以后汇率按「主力上游」的 1 美元 = 7.20 元算（「主力上游（2）」没设汇率，「主力上游·备用」是 7.10 元）。";
  await card.getByTestId("merge-rate-note").getByText(sentence, { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "合并", exact: true }).isEnabled(), true);
  await card.getByRole("button", { name: "合并", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "合并「主力上游」这一组？", exact: true }); await confirm.waitFor();
  await confirm.getByText(`绑定改到「主力上游」上，每日利润不变。${sentence}成本估算近 30 天从 ¥13,982.40 变成 ¥4,660.80，不再重复算。`, { exact: true }).waitFor();
});

test("合并重复的上游：点「取消」只关框，不重读清单；「恢复监控」碰上版本对不上写「这个上游刚被改过，刷新后再看。」，按钮是「刷新」，点了重读清单、关掉确认框", async (t) => {
  const blocked = mergeGroupOf({ merged: [mergeBrief("m-b", "主力上游（2）")], canMerge: false, blockers: [
    { code: "MONITOR_MISMATCH", detail: "", monitoredIds: ["m-a"], pausedIds: ["m-b"], differsIds: ["m-b"] }] });
  const model = { groups: [blocked], records: [], failResume: { status: 409, code: "RESOURCE_CHANGED", error: "changed" } };
  const { page, calls } = await openMergePage(t, model);
  await page.getByTestId("merge-notice").getByRole("button", { name: "查看", exact: true }).click();
  const card = mergeCard(page, "主力上游"); await card.waitFor();
  // 取消只关框
  await card.getByRole("button", { name: "恢复监控", exact: true }).click();
  const resumeConfirm = page.getByRole("dialog", { name: "恢复监控「主力上游（2）」？", exact: true }); await resumeConfirm.waitFor();
  const getsBefore = model.gets;
  await resumeConfirm.getByRole("button", { name: "取消", exact: true }).click(); await resumeConfirm.waitFor({ state: "hidden" });
  assert.equal(model.gets, getsBefore, "取消不重读清单");
  assert.equal(calls.length, 0);
  // 版本对不上
  await card.getByRole("button", { name: "恢复监控", exact: true }).click(); await resumeConfirm.waitFor();
  await resumeConfirm.getByRole("button", { name: "恢复监控", exact: true }).click();
  await resumeConfirm.getByText("这个上游刚被改过，刷新后再看。", { exact: true }).waitFor();
  assert.equal(await resumeConfirm.getByRole("button", { name: "恢复监控", exact: true }).count(), 0, "按钮换成「刷新」");
  assert.equal(calls.length, 1);
  model.groups = [];
  await resumeConfirm.getByRole("button", { name: "刷新", exact: true }).click(); await resumeConfirm.waitFor({ state: "hidden" });
  assert.equal(calls.length, 1, "刷新不再发恢复监控");
  await mergeDrawer(page).getByText("没有要合的上游了。", { exact: true }).waitFor();
});

test("这天重算的数比原来少了一半多（需处理）：点「重新读取」先弹确认框写出原来和重算的数，取消不发请求，确认才带确认读取（C3）", async (t) => {
  const shrunk = { side: "revenue", before: { revenueUsd: 45.17, costUsd: 15.12 }, after: { revenueUsd: 12.4, costUsd: 15.1 } };
  const window = { startMs: profitDayStart(PROFIT_YESTERDAY), endMs: profitDayStart(PROFIT_TODAY), timezone: PROFIT_TZ };
  const action = { id: "retry", kind: "retry_bill", label: "重新读取", accountKey: null, stationId: null, ruleId: "rule-1", ownStationId: null, channelIds: [], window, href: null };
  const attention = (id, extra = {}) => ({ code: "RESETTLE_SHRUNK", title: "这天重算的数比原来少了一半多", detail: "", action: { ...action, ruleId: id }, fromDay: PROFIT_YESTERDAY, moreCount: 0, shrunk: null, ...extra });
  const rows = [profitRow("rule-1", "Rule A", { attention: attention("rule-1", { shrunk }) }), profitRow("rule-2", "Rule B", { attention: attention("rule-2") })];
  const { page, queries } = await openDailyPage(t, { rows });
  const dialog = page.getByRole("dialog", { name: "按重算的数固定 10月8日？", exact: true });
  // 取消：不发请求
  await page.getByRole("button", { name: "重新读取 Rule A", exact: true }).click(); await dialog.waitFor();
  await dialog.getByText("收入：原来 $45.17，重算 $12.40", { exact: true }).waitFor();
  await dialog.getByText("上游成本：原来 $15.12，重算 $15.10", { exact: true }).waitFor();
  await dialog.getByText("会再读一次记录，按读到的数固定；原来的数不再留着。", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(queries.length, 0, "取消不读取");
  // 确认：带确认读取
  await page.getByRole("button", { name: "重新读取 Rule A", exact: true }).click(); await dialog.waitFor();
  const read = page.waitForResponse((response) => response.url().endsWith("/api/reconciliation/query"));
  await dialog.getByRole("button", { name: "重新读取", exact: true }).click(); await read;
  assert.equal(queries.length, 1); assert.equal(queries[0].confirmShrink, true); assert.equal(queries[0].observe, true); assert.deepEqual(queries[0].confirmedAfter, { revenueUsd: 12.4, costUsd: 15.1 }, "带上框里写的重算数");
  // 别的行（没有这个问题）点「重新读取」不弹框、不带确认
  const readB = page.waitForResponse((response) => response.url().endsWith("/api/reconciliation/query")); // 点之前先等，免得响应比等待先到
  await page.getByRole("button", { name: "重新读取 Rule B", exact: true }).click(); await readB;
  assert.equal(queries[1].confirmShrink, undefined); assert.equal(await page.getByRole("dialog").count(), 0);
});

test("昨天还没开始算的渠道（C②）：看昨天时差额写「—」加「还没开始算」，不写 0、不算对不上", async (t) => {
  const rows = [...yesterdayRows().slice(0, 2), profitRow("rule-3", "Rule C", { reason: "NOT_STARTED", state: "none", income: 0, cost: 0 })];
  const { page } = await openDailyPage(t, { pageOf: () => profitPage(rows, { preset: "yesterday" }) });
  await pickPreset(page, PROFIT_COPY.presets.yesterday);
  const rowC = rowOf(page, "Rule C"); await rowC.waitFor();
  await rowC.getByText(PROFIT_COPY.gap.reason.NOT_STARTED, { exact: true }).waitFor();
  assert.equal(await rowC.locator(".jy-profit-tag").count(), 0, "没有「对不上」标签");
});

test("改时间以后有几天太早没自动重算：成功提示写出是哪几天、为什么，不自动消失，点关闭才收起（C2b）", async (t) => {
  const segment = { id: "past-transition", group: "default", ratio: 1, timingSource: "detected", effectiveFrom: window.startMs, effectiveTo: null };
  const { page } = await openDailyPage(t, {
    segments: [segment],
    query: (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture reload failed" }) }),
    extraAPI(route, path) {
      if (path !== "/api/reconciliation/rules/rule-1/transitions/past-transition") throw new Error("unexpected daily fixture API: " + path);
      return fulfill(route, { segments: [segment], resettle: { recent: 4, tooOld: ["2025-12-30", "2025-12-31", "2026-01-01"] } });
    },
  });
  await page.getByRole("button", { name: new RegExp(`^${PROFIT_COPY.expanded.dayCell("10月8日")}`) }).first().click();
  const timing = page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule A", "10月8日"), exact: true }).getByRole("region", { name: "改时间", exact: true });
  await timing.waitFor();
  const input = timing.getByPlaceholder("倍率变化的时间"); await input.fill("2026年10月8日 09:30"); await input.press("Enter");
  await timing.getByRole("button", { name: "改时间", exact: true }).click();
  const notice = page.locator(".ant-notification-notice").filter({ hasText: "时间已修改，改到的那几天会重新算。其中 2025年12月30日–1月1日 在 31 天以前，没自动重算；要按新的时间算，到每日利润选那天点「重新读取」。" });
  await notice.waitFor();
  await page.waitForTimeout(5500);
  assert.equal(await notice.count(), 1, "5 秒以后还在");
  await notice.locator(".ant-notification-notice-close").click(); await notice.waitFor({ state: "hidden" });
});

test("重新检查（R2）：点了才读一次自营站点的设置，读完提示结果，每日利润自己重读整页（不是打开页面就读）", async (t) => {
  const attention = { code: "OWN_CONSUME_LOG_OFF", title: reconciliationIssue("OWN_CONSUME_LOG_OFF").title, detail: "", action: workflowAction("recheck_consume_log", {}), fromDay: "2026-10-01", moreCount: 0 };
  const rows = [profitRow("rule-1", "Rule A", { expected: 1, cost: 1.2, gapUsd: 0.2 }), profitRow("rule-2", "Rule B", { attention })];
  let checks = 0;
  const { page, profitReads } = await openDailyPage(t, { rows, pageOf: () => profitPage(rows, { preset: "yesterday" }),
    extraAPI(route, path) {
      if (path !== "/api/own/consume-log") throw new Error("unexpected daily fixture API: " + path);
      assert.equal(route.request().method(), "POST"); checks += 1;
      return fulfill(route, { status: { state: "on" } });
    } });
  await rowOf(page, "Rule B").waitFor();
  assert.equal(checks, 0, "打开页面不读设置");
  const before = profitReads.length;
  await page.getByRole("button", { name: `重新检查 Rule B`, exact: true }).click();
  await page.locator(".ant-message").getByText("已经在记收费记录了", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
  assert.equal(checks, 1, "只读一次");
  for (let i = 0; i < 50 && profitReads.length === before; i += 1) await page.waitForTimeout(100);
  assert.equal(profitReads.length, before + 1, "点完重读整页");
});

test("昨天里有「还在读取」的日子：5 分钟重读一次（只读 POST /profit，不带 force），读完变已固定就不再读（审核 2 #128）", async (t) => {
  let yesterdayReads = 0, skewMs = 0;
  const { page, profitReads } = await openDailyPage(t, { clock: true, pageOf: (body) => {
    if (body.preset !== "yesterday") return { ...profitPage(todayRows(), { preset: "today" }), asOf: new Date(Date.now() + skewMs).toISOString() };
    yesterdayReads += 1;
    const base = profitPage(yesterdayRows(), { preset: "yesterday" });
    return { ...base, asOf: new Date(Date.now() + skewMs).toISOString(), dayCounts: yesterdayReads === 1 ? { fixed: 0, reading: 1, today: 0 } : { fixed: 1, reading: 0, today: 0 } };
  } });
  const advance = async (ms) => { skewMs += ms; await page.clock.fastForward(ms); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  await pickPreset(page, PROFIT_COPY.presets.yesterday); await page.locator(`.jy-freshness[title="数据每 5 分钟自动刷新"]`).waitFor();
  const before = profitReads.length;
  assert.deepEqual(profitReads.at(-1), { preset: "yesterday" });
  await advance(290000); await settle(); assert.equal(profitReads.length, before, "5 分钟以前不读");
  await advance(20000); await settle(); assert.equal(profitReads.length, before + 1, "5 分钟到了重读一次");
  assert.deepEqual(profitReads.at(-1), { preset: "yesterday" }, "不带 force、不带 observe");
  await page.locator(`.jy-freshness[title="当前时间范围不自动刷新，可点右侧刷新"]`).waitFor();
  await advance(600000); await settle(); assert.equal(profitReads.length, before + 1, "已固定以后不再读");
});

test("手机 320：一个渠道一张卡片，点开能看计算明细，页面不横向溢出", async (t) => {
  const { page } = await openDailyPage(t, { viewport: { width: 320, height: 800 } });
  assert.equal(await page.locator(".jy-profit-table").count(), 0);
  const summary = page.locator(".jy-profit-summary--mobile"); await summary.waitFor();
  await summary.getByRole("button", { name: PROFIT_COPY.metric.seeDay("昨天"), exact: true }).click();
  const card = cardOf(page, "Rule A"); await card.waitFor();
  assert.equal(await page.locator(".jy-profit-card.is-open").count(), 0, "卡片默认收起，点头部才展开（和 390 一样）");
  await card.locator(".jy-profit-card__head").click();
  await card.getByRole("group", { name: PROFIT_COPY.expanded.dailyTitle, exact: true }).waitFor();
  await card.getByRole("button", { name: PROFIT_COPY.expanded.seeDetailShort, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: PROFIT_COPY.detail.title("Rule A", "10月8日"), exact: true }); await drawer.waitFor();
  assert.ok((await page.locator(".ant-drawer-content-wrapper").filter({ has: drawer }).boundingBox()).width >= 319);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "320px document root overflows horizontally");
});

// ---- 自营业务用例共用的夹具（原来夹在已删用例之间）----
// 利润等式里收入那一格留空时写的字（profit-equation.tsx 的 EQ_TEXT.unsetRevenue；组件文件带 JSX，node 读不了）
const EQ_UNSET_REVENUE = "没设置";
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
// 运营总览「今天收入和上游成本」用的大金额：收入 ¥12,345.67、上游成本 ¥23,456.80（5 个按用量算的上游）、5 位用户（售价 7，按 1 美元额度 = 7 元算）
function bigOwnAnalytics(range = "today") {
  const base = unconfirmedOwnAnalytics(range);
  const costs = [9000, 6000, 4000, 2456.8, 2000].map((cny, i) => ({ stationId: `up-${i}`, name: `Upstream ${i}`, channels: ["Sales"], mode: "usage", usd: cny / 7, cny }));
  const { incomeUnconfirmed, ...profit } = base.profit;
  // 其余两位（2.2 + 1.3）× 7 = ¥24.50，和前 3 名（¥42、¥35、¥21）都不一样：写成「拿第 3 名的数」查得出来
  return { ...base, byUser: [6, 5, 3, 2.2, 1.3].map((cost, i) => ({ user: `user${i}`, tokens: 1000, cost, requests: 3, isAdmin: false })),
    profit: { ...profit, incomeCny: 12345.67, upstreamCostCny: 23456.8, fixedCostCny: 1234.56, totalCostCny: 24691.36, grossProfitCny: -11111.13, netProfitCny: -12345.69, costs } };
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
    // 每日收入只画收入，取自营站点接口的逐日收入：自营业务不再读慢的 /api/analytics（ui-design-spec §5.3）
    throw new Error("unexpected my fixture API: " + url.pathname);
  }, undefined, false, null, "/my");
}
// 收入确认了的近 7 天：逐日收入 7 天（最早一天 ¥1,000，往后每天多 ¥100，最后一天是今天），7 个模型（前 5 + 其他 2 个）；
// sellPrice: false 时自营站点没设置售价（收入按 1 美元额度 = 1 元估算）
function myLayoutAnalytics(range = "7d", { sellPrice = true } = {}) {
  const base = bigOwnAnalytics(range), end = shanghaiDay(Date.now());
  const incomeDaily = Array.from({ length: 7 }, (_, i) => ({ date: shiftDay(end, i - 6), incomeCny: 1000 + i * 100 }));
  const byModel = [700, 600, 500, 400, 300, 20, 10].map((cost, i) => ({ model: `model-${i}`, tokens: 1000, cost, requests: 3 }));
  // 没设置售价：服务端在 profit 里带上 sell_price_unset 那条说明（等式下面写一次）
  const unpriced = { station: { id: "own-1", name: "Fixture own" }, profit: { ...base.profit, adminUsageCny: 3, warnings: [SELL_PRICE_UNSET], warningCodes: ["sell_price_unset"] } };
  return { ...base, incomeDaily, byModel, ...(sellPrice ? {} : unpriced) };
}

// ---- 共用夹具（原来夹在已删用例之间）----
// 展开的记录里一项：左边名称，右边写法（Detail，recon-parts.tsx）
async function historyFact(record, label, value) { await record.locator(".reconciliation-detail").filter({ has: record.page().locator(".reconciliation-detail__label").filter({ hasText: exactText(label) }) }).locator(".reconciliation-detail__value").filter({ hasText: exactText(value) }).first().waitFor(); }
// 账号卡片里的事实按 dt/dd 成对展示：等到这一项的值出现
const exactText = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
async function expandConfirmedRecord(drawer, record, compact = false) { const button = compact ? drawer.getByRole("button", { name: new RegExp(` · ${historyKey(record).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first() : drawer.locator(`tr.ant-table-row[data-row-key="${record.historyId}"]`); await button.focus(); await drawer.page().keyboard.press("Enter"); return drawer.locator(`[data-history-id="${record.historyId}"]`); }
// 记录里没有 Key 名称和 ID 时写「—」，不拿现在的绑定去补
const historyKey = (record) => record.upstreamSource.tokenName || (record.upstreamSource.tokenId != null ? `Key #${record.upstreamSource.tokenId}` : EMPTY);
async function chooseConfirmedHistoryRule(page, drawer, label = historyOption("Rule A")) { await drawer.getByRole("combobox", { name: "绑定", exact: true }).click(); await page.getByText(label, { exact: true }).last().click(); }
const historyOption = (key, ended = false) => `${key} · ${HISTORY_UPSTREAM} · ${ended ? "已解除绑定" : "在用"}`;
const HISTORY_FIXED_NOTE = `这个上游现在计入固定成本；没标「${FIXED_COST_TEXT}」的日子是当时按用量算的上游成本，不改。`;
const historyCount = (n) => `${n} 条每日记录 · 按美元显示。只列每天的记录，以前的数据还在。`;
// 以前的每日记录（recon-history.tsx）：抽屉标题和入口按钮都是「以前的每日记录」，绑定下拉写「Key · 上游 · 在用 / 已解除绑定」
const HISTORY = workflowActionMeta("open_history").label, HISTORY_UPSTREAM = configuration.upstreams[0].name;
async function openConfirmedHistoryPage(t, options = {}) {
  const current = rule("rule-1", "Rule A", 10); Object.assign(current.rule, { enabled: true, archivedAt: null, scopeVersion: 2, tokenId: 99, channels: [{ channelId: 9, name: "New channel 9" }] });
  if (options.groupHistory) current.transitionSegments = [{ id: "seg-old", group: "g1", ratio: 1, effectiveFrom: 1000, effectiveTo: 1500 }, { id: "seg-new", group: "g2", ratio: 2, effectiveFrom: 1500, effectiveTo: null }];
  const archived = { ...current.rule, id: "old-rule", tokenName: "new-name", enabled: false, archivedAt: "2026-10-09T00:00:00Z" }, reads = [], historyReads = [], queries = [];
  const records = options.records || [confirmedHistoryRecord()];
  const page = await openFixturePage(t, async (route) => {
    const request = route.request(), url = new URL(request.url()); reads.push({ path: url.pathname, method: request.method(), params: Object.fromEntries(url.searchParams) });
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, { ...configuration, ...(options.upstreams ? { upstreams: options.upstreams } : {}), ownStation: current.rule.archivedAt && options.removeOwnAfterStop ? null : { ...configuration.ownStation, cnyPerUsd: options.rate || null }, rules: [current.rule, archived].filter((rule) => !rule.archivedAt || url.searchParams.get("includeArchived") === "true") });
    if (url.pathname === "/api/reconciliation" && request.method() === "GET") return fulfill(route, { actions: [] });
    if (url.pathname === "/api/settings") return fulfill(route, { settings: {}, tz: PROFIT_TZ, ownLog: null });
    if (url.pathname === "/api/reconciliation/profit") { const body = request.postDataJSON(); queries.push(body); return fulfill(route, profitPage(current.rule.archivedAt ? [] : [profitRow("rule-1", "Rule A", { expected: 1, cost: 1.2, gapUsd: 0.2 })], { preset: body.preset === "yesterday" ? "yesterday" : "today" })); }
    if (url.pathname === "/api/reconciliation/query") { const body = request.postDataJSON(); queries.push(body); assert.ok(!body.ruleIds?.some((id) => id === archived.id || current.rule.archivedAt && id === current.rule.id)); return fulfill(route, { results: [] }); }
    if (url.pathname.endsWith("/segments")) return fulfill(route, { segments: current.transitionSegments || [] });
    if (url.pathname.endsWith("/confirmed")) { assert.equal(request.method(), "GET"); historyReads.push({ ruleId: url.pathname.split("/").at(-2), params: Object.fromEntries(url.searchParams) }); return options.history ? options.history(route, historyReads.at(-1), historyReads.length) : fulfill(route, { ruleId: historyReads.at(-1).ruleId, readOnly: true, records, nextCursor: null }); }
    throw new Error("unexpected confirmed history fixture API: " + url.pathname);
  }, options.viewport);
  const badge = page.getByRole("button", { name: "Collapse issues badge", exact: true }); if (await badge.isVisible()) await badge.click();
  // 核算页只读：停止核算在上游账单完成，这里只模拟它已发生
  const stopElsewhere = () => Object.assign(current.rule, { enabled: false, archivedAt: "2026-10-09T00:00:00Z" });
  return { page, reads, historyReads, queries, records, stopElsewhere };
}
function confirmedHistoryRecord(id = "saved-oct8", profit = 1) {
  const window = { preset: "yesterday", startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z"), timezone: "Asia/Shanghai" };
  const side = (amount) => ({ state: "complete", quotaUnits: amount * 100, quotaPerUnit: 100, amountUsd: amount, knownAmountUsd: amount, countedAmountUsd: null, successfulCount: 1, expectedCount: 1, observedAt: null, window });
  const channels = [1, 2, 3].map((channelId) => ({ channelId, name: "old-" + channelId }));
  return { historyId: id, confirmedAt: "2026-10-08T16:01:00.000Z", window, ownSource: { stationId: "old-own", provider: "newapi", baseUrl: "https://old-own.test", accountId: "11", namespaceKey: "old-own-namespace" }, upstreamSource: { provider: "newapi", baseUrl: "https://old-up.test", accountId: "7", tokenId: 9, tokenName: "old-name" }, scopeVersion: 1, scopeFingerprint: "old-scope", billingEffectiveFromMs: window.startMs, channels, amountBasis: { id: "channel-billing-usd-v3", currency: "USD", billingSource: "channel-log-stat", calculationVersion: 3, conversion: "quota_per_unit" }, upstream: side(2), downstream: { ...side(2 + profit), channels: channels.map((channel) => ({ ...channel, billingState: "complete", quotaUnits: 100, amountUsd: 1, knownAmountUsd: 1 })) }, calculation: { differenceUsd: profit, profitUsd: profit, riskDifferenceUsd: null, marginRate: profit / (2 + profit) }, sourceCompleteness: "complete" };
}
const ownSource = { stationId: "own-1", provider: "newapi", baseUrl: "https://own.example", accountId: "1", namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", "https://own.example", "1"])).digest("hex") };
const UPDATE_AUTH = workflowActionMeta("update_authorization").label, USE_SAVED = "用已有上游", NEW_UPSTREAM = "新增上游", CREATE_HINT = "保存后，别的渠道也能直接用这个上游。";
// 渠道绑定的话：按钮名来自 lib/workflow-actions.js，其余在 app/components/channel-onboarding.tsx 的 COPY 表（tsx 测试里引用不到，照抄原句）
const CONNECT = workflowActionMeta("connect_channels").label, EDIT_BINDING = workflowActionMeta("edit_binding").label, TEST_READ = workflowActionMeta("verify_identity").label, REFRESH = workflowActionMeta("refresh").label, RETRY = workflowActionMeta("retry_bill").label;
const preview = { billingEffectiveFromMs: null, firstQueryableAtMs: null, scopeChanged: true };

test("占位：夹具段结束", () => {});

test("手动选 Key：每个渠道一行有「选 Key」下拉框，绑过的换 Key 只发 tokenId；还没算利润的渠道选上游和 Key 就开始算", async (t) => {
  const posts = [];
  const channelOptions = { ok: true, upstreams: [{ id: "upstream-1", name: "Up" }], channels: [
    { channelId: 1, name: "Channel A", ruleId: "rule-1", upstreamStationId: "upstream-1", tokenId: 9, tokenName: "Key 9", suggestedUpstreamId: null },
    { channelId: 5, name: "新渠道", ruleId: null, upstreamStationId: null, tokenId: null, tokenName: null, suggestedUpstreamId: "upstream-1" }] };
  const { page } = await openDailyPage(t, { channelOptions, extraAPI(route, path) {
    if (path === "/api/reconciliation/upstreams/upstream-1/keys") return fulfill(route, { platform: "newapi", tokens: [{ id: 9, name: "Key 9", status: 1 }, { id: 20, name: "Key 20", status: 1 }, { id: 21, name: "停用的", status: 2 }] });
    if (path === "/api/reconciliation/channels/select-key") { posts.push(route.request().postDataJSON()); return fulfill(route, { changed: true, ruleId: "rule-1" }); }
    return fulfill(route, {});
  } });
  const until = async (check) => { for (let i = 0; i < 60 && !(await check()); i++) await page.waitForTimeout(100); };
  const rowA = rowOf(page, "Rule A");
  await rowA.getByLabel("选 Key：Channel A").waitFor();
  await rowA.getByLabel("选 Key：Channel A").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByTitle("Key 20").click();
  await within(until(() => posts.length === 1), "换 Key 请求");
  assert.deepEqual(posts[0], { ownStationId: "own-1", channelId: 1, tokenId: 20 });
  // 还没算利润的渠道：上游默认选上地址对得上的那个，选 Key 以后带上游一起发
  const unbound = page.getByRole("region", { name: "还没算利润的渠道" });
  await unbound.getByText("新渠道").waitFor();
  await unbound.getByLabel("选 Key：新渠道").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last().getByTitle("Key 20").click();
  await within(until(() => posts.length === 2), "开始算请求");
  assert.deepEqual(posts[1], { ownStationId: "own-1", channelId: 5, upstreamStationId: "upstream-1", tokenId: 20 });
});
