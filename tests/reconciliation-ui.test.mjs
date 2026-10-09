// Start the local dev server first. Set PLAYWRIGHT_MODULE to a Playwright module
// path when it is bundled outside this project, and PLAYWRIGHT_CHANNEL=msedge
// when Chromium is unavailable locally.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveKnownChannelCoverage, summarizeReconciliationWindowGroups } from "../lib/reconciliation-view.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
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
  const grouped = summarizeReconciliationWindowGroups(rows, { isCompletedWindow, coverageFor: (range, source) => deriveKnownChannelCoverage(catalogue, rules.filter((rule) => rule.ownSource?.namespaceKey === source?.namespaceKey), rows.filter((row) => row.ownSource?.namespaceKey === source?.namespaceKey), { window: range, isCompletedWindow }) });
  return { generatedAt: "2026-10-09T03:00:00.000Z", results: rows, ...grouped, coverage, actions: coverage.channels.flatMap((channel) => channel.actions) };
}
async function openDailyPage(t, options = {}) {
  const reads = [], queries = [], initial = options.data || dailyResponse();
  const page = await openFixturePage(t, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, { ...configuration, ownStation: { id: "own-1", cnyPerUsd: 7 }, rules: initial.results.map((row) => row.rule) });
    if (url.pathname === "/api/reconciliation") { reads.push(Object.fromEntries(url.searchParams)); return options.read ? options.read(route, reads.length, initial) : fulfill(route, initial); }
    if (url.pathname === "/api/reconciliation/query") { const body = route.request().postDataJSON(); queries.push(body); return options.query ? options.query(route, body, initial) : fulfill(route, initial); }
    if (url.pathname.endsWith("/segments")) return fulfill(route, { segments: [] });
    throw new Error("unexpected daily fixture API: " + url.pathname);
  }, options.viewport, false, null, options.path);
  return { page, reads, queries, initial };
}

test("daily billing defaults to complete yesterday and global 3/10 coverage survives search and status filters", async (t) => {
  const { page, reads } = await openDailyPage(t); const summary = page.getByRole("region", { name: "对账汇总", exact: true });
  assert.deepEqual(reads[0], { preset: "yesterday" }); await summary.getByText("$7.50", { exact: true }).waitFor(); await summary.getByText("$4.50", { exact: true }).waitFor(); assert.equal(await summary.getByText(/¥/).count(), 0);
  const coverage = page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await coverage.getByText("已知渠道覆盖：已核算 3/10", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "搜索上游、Key、渠道名称或 ID", exact: true }).fill("Rule A"); assert.equal(await page.locator("tr.ant-table-row").count(), 1); await summary.getByText("$7.50", { exact: true }).waitFor();
  await page.getByText("负毛利 0", { exact: true }).click(); await page.getByText("没有匹配的对账规则", { exact: true }).waitFor(); await coverage.getByText("已知渠道覆盖：已核算 3/10", { exact: true }).waitFor();
  await coverage.locator(".ant-collapse-header", { hasText: "查看全部已知渠道与未核算原因" }).click(); await coverage.getByText("渠道 9 · ID 9", { exact: true }).waitFor(); assert.ok((await coverage.textContent()).includes("尚未关联账单规则")); assert.equal(reads.length, 1);
});

test("daily mobile pagination changes only visible rules and retains global amounts and coverage", async (t) => {
  const rows = Array.from({ length: 5 }, (_, index) => rule(`rule-${index + 1}`, `Rule ${String.fromCharCode(65 + index)}`, 2.5)); const { page, reads } = await openDailyPage(t, { data: dailyResponse(rows), viewport: { width: 390, height: 844 } });
  const summary = page.getByRole("region", { name: "对账汇总", exact: true }), coverage = page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await summary.getByText("$12.50", { exact: true }).waitFor(); await coverage.getByText("已知渠道覆盖：已核算 5/10", { exact: true }).waitFor(); assert.equal(await page.locator(".reconciliation-mobile-item").count(), 4);
  await page.getByRole("button", { name: "下一页", exact: false }).click(); await page.locator(".reconciliation-mobile-item", { hasText: "Rule E" }).waitFor(); assert.equal(await page.locator(".reconciliation-mobile-item").count(), 1); await summary.getByText("$12.50", { exact: true }).waitFor(); await coverage.getByText("已知渠道覆盖：已核算 5/10", { exact: true }).waitFor(); assert.equal(reads.length, 1);
});

test("daily billing keeps absolute Shanghai and UTC groups separate and combines only verified equal windows", async (t) => {
  const rows = dailyRows(); rows[1] = rule("rule-2", "Rule B", 2.5, { preset: "yesterday", timezone: "UTC", startMs: Date.parse("2026-10-08T00:00:00Z"), endMs: Date.parse("2026-10-09T00:00:00Z") });
  const { page } = await openDailyPage(t, { data: dailyResponse(rows) }); const summary = page.getByRole("region", { name: "对账汇总", exact: true }); await summary.getByText("暂无共同整日汇总", { exact: true }).waitFor(); assert.equal(await summary.getByText("$7.50", { exact: true }).count(), 0);
  const groups = page.locator(".ant-collapse-header", { hasText: /^账单窗口/ }); assert.equal(await groups.count(), 2); await groups.first().focus(); await page.keyboard.press("Enter"); await page.getByText("2026-10-07T16:00:00.000Z — 2026-10-08T16:00:00.000Z", { exact: true }).waitFor();
  const combined = dailyRows(); combined[1] = rule("rule-2", "Rule B", 2.5, { ...window, timezone: "Asia/Singapore" });
  const next = await openDailyPage(t, { data: dailyResponse(combined), query(route, body) { assert.equal(body.preset, "today"); const today = dailyRows({ ...window, preset: "today", startMs: window.endMs, endMs: Date.parse("2026-10-09T03:00:00Z") }); for (const row of today) row.calculation = { profitUsd: null, marginRate: null, riskDifferenceUsd: 1.5 }; return fulfill(route, dailyResponse(today)); } }); await next.page.getByRole("region", { name: "对账汇总", exact: true }).getByText("$7.50", { exact: true }).waitFor(); assert.equal(await next.page.locator(".ant-collapse-header", { hasText: /^账单窗口/ }).count(), 1); await next.page.locator(".ant-collapse-header", { hasText: /账单窗口.*Asia\/Shanghai \/ Asia\/Singapore/ }).waitFor();
  await next.page.getByText("今天", { exact: true }).click(); await next.page.locator(".reconciliation-query-action").first().click(); await next.page.getByRole("region", { name: "对账汇总", exact: true }).getByText("暂无共同整日汇总", { exact: true }).waitFor(); assert.equal(next.queries[0].preset, "today");
});

test("daily row retry uses one selected query then reloads full GET before showing current aggregates", async (t) => {
  let reload, ready; const started = new Promise((resolve) => { ready = resolve; }); const initial = dailyResponse();
  const { page, reads, queries } = await openDailyPage(t, { data: initial, read(route, count) { if (count === 1) return fulfill(route, initial); return new Promise((resolve) => { reload = { route, resolve }; ready(); }); }, query(route, body) { assert.deepEqual(body.ruleIds, ["rule-1"]); const rows = dailyRows(); rows[0] = rule("rule-1", "Rule A", 4); return fulfill(route, dailyResponse([rows[0]], { rules: initial.results.map((row) => row.rule) })); } });
  await page.getByRole("button", { name: /重试.*Rule A/ }).click(); await started; await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("¥28.00", { exact: true }).waitFor(); await page.getByText("全量摘要仅供参考，正在核对当前窗口", { exact: true }).waitFor(); assert.deepEqual(reads[1], { preset: "yesterday" }); assert.equal(queries.length, 1); assert.deepEqual([queries[0].startMs, queries[0].endMs], [window.startMs, window.endMs]);
  const full = dailyRows(); full[0] = rule("rule-1", "Rule A", 4); reload.resolve(fulfill(reload.route, dailyResponse(full))); await page.getByRole("region", { name: "对账汇总", exact: true }).getByText("$9.00", { exact: true }).waitFor(); await page.getByRole("region", { name: "已知渠道覆盖", exact: true }).getByText("已知渠道覆盖：已核算 3/10", { exact: true }).waitFor();
});

test("daily summary re-read ignores an earlier aggregate when another row finishes during it", async (t) => {
  const gets = [], retries = new Map(), initial = dailyResponse(); let getReady; const getStarted = new Promise((resolve) => { getReady = resolve; });
  const { page, reads } = await openDailyPage(t, { data: initial, read(route, count) { if (count === 1) return fulfill(route, initial); return new Promise((resolve) => { gets.push({ route, resolve }); getReady(); }); }, query(route, body) { return new Promise((resolve) => retries.set(body.ruleIds[0], { route, resolve })); } });
  await page.getByRole("button", { name: /重试.*Rule A/ }).click(); await page.getByRole("button", { name: /重试.*Rule B/ }).click(); const rows = dailyRows(); rows[0] = rule("rule-1", "Rule A", 4); retries.get("rule-1").resolve(fulfill(retries.get("rule-1").route, dailyResponse([rows[0]]))); await getStarted;
  rows[1] = rule("rule-2", "Rule B", 5); retries.get("rule-2").resolve(fulfill(retries.get("rule-2").route, dailyResponse([rows[1]]))); await page.waitForFunction(() => document.querySelectorAll(".ant-btn-loading-icon").length === 0); assert.equal(reads.length, 3);
  const earlier = dailyRows(); earlier[0] = rows[0]; gets[0].resolve(fulfill(gets[0].route, dailyResponse(earlier))); await page.locator("tr.ant-table-row", { hasText: "Rule B" }).getByText("¥35.00", { exact: true }).waitFor(); await page.getByText("全量摘要仅供参考，正在核对当前窗口", { exact: true }).waitFor();
  gets[1].resolve(fulfill(gets[1].route, dailyResponse(rows))); await page.getByRole("region", { name: "对账汇总", exact: true }).getByText("$11.50", { exact: true }).waitFor();
});

test("daily full-summary read failure keeps successful row and retries full GET without another financial query", async (t) => {
  const rows = dailyRows(); let successful = false;
  const { page, reads, queries } = await openDailyPage(t, { read(route, count) { if (count === 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture summary unavailable" }) }); return fulfill(route, dailyResponse(rows)); }, query(route) { rows[0] = rule("rule-1", "Rule A", 4); successful = true; return fulfill(route, dailyResponse([rows[0]])); } });
  await page.getByRole("button", { name: /重试.*Rule A/ }).click(); await page.getByText("全量汇总读取失败 · 摘要仅供参考", { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("¥28.00", { exact: true }).waitFor(); assert.equal(successful, true); await page.getByRole("button", { name: "重读全量汇总", exact: true }).click(); await page.getByRole("region", { name: "对账汇总", exact: true }).getByText("$9.00", { exact: true }).waitFor(); assert.equal(queries.length, 1); assert.equal(reads.length, 3); assert.ok(reads.every((read) => read.preset === "yesterday"));
});

test("daily coverage retains disabled and missing known channels and zero active rules after stopping", async (t) => {
  const rows = dailyRows(), channels = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}`, status: index === 1 ? 2 : 1, missing: index === 8 }));
  rows[1].downstream.channels[0].state = "manual_disabled"; rows[2].rule.channels = [{ channelId: 9, name: "渠道 9" }]; rows[2].downstream.channels[0] = { ...rows[2].downstream.channels[0], channelId: 9, name: "渠道 9", state: "missing" }; rows[2].health = { code: "SOURCE_BINDING_UNCONFIRMED", issues: [{ code: "SOURCE_BINDING_UNCONFIRMED", detail: "原渠道已缺失，需要核对来源" }] }; rows[2].calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null };
  const data = dailyResponse(rows, { catalogue: { channels } }); const { page } = await openDailyPage(t, { data, query(route) { return fulfill(route, dailyResponse([], { rules: rows.map((row) => ({ ...row.rule, enabled: false, archivedAt: "2026-10-09T03:00:00.000Z" })), catalogue: { channels } })); } });
  const coverage = page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await coverage.getByText("已知渠道覆盖：已核算 2/10", { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule C" }).getByText("¥17.50", { exact: true }).waitFor();
  await coverage.locator(".ant-collapse-header").click(); await coverage.getByText("渠道 9 · ID 9", { exact: true }).waitFor(); assert.ok((await coverage.textContent()).includes("已缺失")); assert.ok((await coverage.textContent()).includes("手动禁用"));
  await page.getByRole("button", { name: "刷新当前对账窗口", exact: true }).click(); await page.getByText("还没有启用的对账规则", { exact: true }).waitFor(); await coverage.getByText("已知渠道覆盖：已核算 0/10", { exact: true }).waitFor(); await page.getByRole("region", { name: "对账汇总", exact: true }).getByText("暂无共同整日汇总", { exact: true }).waitFor();
});

test("daily duplicate sales and shared Key costs use server totals while raw row evidence remains visible", async (t) => {
  const rows = dailyRows(); rows[1].rule.channels = structuredClone(rows[0].rule.channels); rows[1].downstream.channels = structuredClone(rows[0].downstream.channels); rows[1].upstream.countedAmountUsd = null; rows[1].upstream.ownershipState = "duplicate";
  for (const row of rows.slice(0, 2)) { row.calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null }; row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT", detail: "rule-1、rule-2 重复归属" }] }; }
  const { page } = await openDailyPage(t, { data: dailyResponse(rows) }); const summary = page.getByRole("region", { name: "对账汇总", exact: true }); await summary.getByText("$5.00", { exact: true }).waitFor(); await summary.getByText("$2.00", { exact: true }).waitFor(); await summary.getByText("$1.50", { exact: true }).waitFor();
  const rowB = page.locator("tr.ant-table-row", { hasText: "Rule B" }); await rowB.getByText("¥17.50", { exact: true }).waitFor(); await rowB.getByText("¥7.00", { exact: true }).waitFor(); await rowB.getByText("待核算", { exact: true }).waitFor();
  await page.locator(".ant-collapse-header", { hasText: /^账单窗口/ }).click(); await page.getByText(/未计入成本的规则：rule-2/).waitFor(); const coverage = page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await coverage.locator(".ant-collapse-header").click(); await coverage.getByText("重复归属", { exact: true }).waitFor();
});

test("daily Sub2API unverified timezone keeps zero and actual dollar reference without confirmed day profit", async (t) => {
  const row = dailyRows()[0]; row.amountBasis = { ...amountBasis, conversion: "provider_cost_usd" }; row.billingTimezone = { state: "unverified", timezone: "Asia/Shanghai", reason: "BILLING_TIMEZONE_UNVERIFIED" }; row.upstream = { ...row.upstream, state: "partial", amountUsd: null, knownAmountUsd: 0, countedAmountUsd: 0, quotaPerUnit: null }; row.calculation = { profitUsd: null, marginRate: null, riskDifferenceUsd: 2.5 }; row.health = { code: "BILLING_TIMEZONE_UNVERIFIED", issues: [{ code: "BILLING_TIMEZONE_UNVERIFIED", detail: "当前部署自然日边界尚未核验" }] };
  const { page } = await openDailyPage(t, { data: dailyResponse([row]) }); await page.getByRole("region", { name: "对账汇总", exact: true }).getByText("暂无共同整日汇总", { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule A" }).locator("td", { hasText: "¥0.00 · 部分" }).waitFor();
  await page.getByRole("button", { name: "查看 Rule A 的对账详情", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await drawer.getByText(/Asia\/Shanghai · 待核验，原金额仅供参考/).waitFor(); await drawer.locator(".ant-collapse-header", { hasText: "查看原始账单与计算依据" }).click(); await drawer.getByText("0 USD（部分）", { exact: true }).waitFor(); assert.equal(await drawer.getByText("确认利润", { exact: true }).count(), 0);
});

test("daily late bill and new scope retain requested yesterday and expose first full bill schedule", async (t) => {
  const row = dailyRows()[0]; row.upstream = { ...row.upstream, amountUsd: 0, knownAmountUsd: 0, countedAmountUsd: 0 }; row.calculation = { profitUsd: null, riskDifferenceUsd: 2.5, marginRate: null }; row.health = { code: "WAITING_FOR_BILL", issues: [{ code: "WAITING_FOR_BILL", detail: "最新已结束日账单尚未就绪" }] }; row.scope = { scopeVersion: 2, billingEffectiveFromMs: Date.parse("2026-10-09T16:00:00Z"), firstFullDayStartMs: Date.parse("2026-10-09T16:00:00Z"), firstQueryableAtMs: Date.parse("2026-10-10T16:00:00Z") };
  const { page, queries } = await openDailyPage(t, { data: dailyResponse([row]) }); await page.getByText("等待该窗口账单", { exact: true }).waitFor(); await page.getByRole("button", { name: "查看 Rule A 的对账详情", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await drawer.getByText("2026-10-09T16:00:00.000Z", { exact: true }).waitFor(); await drawer.getByText("2026-10-10T16:00:00.000Z", { exact: true }).waitFor(); await drawer.locator(".ant-drawer-close").click();
  const retried = page.waitForResponse((response) => response.url().endsWith("/api/reconciliation/query")); await page.getByRole("button", { name: /重试.*Rule A/ }).click(); await retried; assert.deepEqual([queries[0].preset, queries[0].startMs, queries[0].endMs], ["custom", window.startMs, window.endMs]);
});

test("daily groups display exact 23/25-hour DST boundaries and work by keyboard at four widths", async (t) => {
  for (const [width, start, end] of [[320, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"], [390, "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"], [768, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"], [1440, "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"]]) {
    const row = dailyRows({ preset: "yesterday", timezone: "America/New_York", startMs: Date.parse(start), endMs: Date.parse(end) })[0]; const { page } = await openDailyPage(t, { data: dailyResponse([row]), viewport: { width, height: 900 } });
    const group = page.locator(".ant-collapse-header", { hasText: /^账单窗口/ }); await group.focus(); await page.keyboard.press("Enter"); await page.getByText(`${new Date(start).toISOString()} — ${new Date(end).toISOString()}`, { exact: true }).waitFor();
    const coverage = page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await coverage.locator(".ant-collapse-header").focus(); await page.keyboard.press("Enter"); await coverage.getByText("渠道 9 · ID 9", { exact: true }).waitFor(); await page.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
});

test("daily mismatched provider window shows original returned interval and never confirms requested day profit", async (t) => {
  const row = dailyRows()[0], actual = { ...window, startMs: window.startMs - 86400000, endMs: window.endMs - 86400000 }; row.window = actual; row.upstream.window = actual; row.downstream.window = actual; row.calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null }; row.health = { code: "BILLING_WINDOW_MISMATCH", issues: [{ code: "BILLING_WINDOW_MISMATCH", detail: "上游返回原账单区间与请求窗口不同" }] };
  const { page } = await openDailyPage(t, { data: dailyResponse([row]) }); await page.getByRole("region", { name: "对账汇总", exact: true }).getByText("暂无共同整日汇总", { exact: true }).waitFor(); await page.locator(".ant-collapse-header", { hasText: /^账单窗口/ }).click(); await page.getByText("2026-10-06T16:00:00.000Z — 2026-10-07T16:00:00.000Z", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看 Rule A 的对账详情", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await drawer.getByText("返回账单实际窗口", { exact: true }).waitFor(); assert.ok((await drawer.textContent()).includes("10/07 00:00")); assert.ok((await drawer.textContent()).includes("10/09 00:00")); assert.equal(await drawer.getByText("确认利润", { exact: true }).count(), 0);
});

test("daily unknown catalogue and unknown-source retained members do not become full-site coverage", async (t) => {
  const rows = dailyRows(), rules = rows.map((row) => row.rule); rules.push({ ...rules[0], id: "legacy-unknown", enabled: false, ownSource: null, channels: [{ channelId: 9, name: "旧来源渠道 9" }] });
  const { page } = await openDailyPage(t, { data: dailyResponse(rows, { rules, catalogue: { stale: true } }) }); const coverage = page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await coverage.getByText("已知渠道覆盖：已核算 0/11", { exact: true }).waitFor(); assert.ok((await coverage.textContent()).includes("当前目录覆盖未知")); assert.ok((await coverage.textContent()).includes("全站历史渠道全集未核验")); await coverage.locator(".ant-collapse-header").click(); await coverage.getByText("渠道 9 · ID 9", { exact: true }).waitFor(); await coverage.getByText("旧来源渠道 9 · ID 9", { exact: true }).waitFor();
});

test("daily zero and negative confirmed subtotals remain numeric while unknown whole-Key use is reference", async (t) => {
  const rows = [rule("rule-1", "Rule A", 1), rule("rule-2", "Rule B", 0)]; const { page } = await openDailyPage(t, { data: dailyResponse(rows) }); const summary = page.getByRole("region", { name: "对账汇总", exact: true }); await summary.getByText("-$1.00", { exact: true }).waitFor(); await page.locator("tr.ant-table-row", { hasText: "Rule A" }).getByText("¥0.00", { exact: true }).waitFor();
  const unknown = dailyRows()[0]; unknown.rule.costCoverage = "unknown"; unknown.rule.coverageDeclaration = { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] }; unknown.calculation = { profitUsd: null, riskDifferenceUsd: 1.5, marginRate: null }; unknown.health = { code: "COST_COVERAGE_UNKNOWN", issues: [{ code: "COST_COVERAGE_UNKNOWN", detail: "同 Key 仍有站外调用" }] };
  const next = await openDailyPage(t, { data: dailyResponse([unknown]) }); const row = next.page.locator("tr.ant-table-row", { hasText: "Rule A" }); await row.getByText("¥17.50", { exact: true }).waitFor(); await row.getByText("¥7.00", { exact: true }).waitFor(); await row.getByText("待核算", { exact: true }).waitFor(); const coverage = next.page.getByRole("region", { name: "已知渠道覆盖", exact: true }); await coverage.locator(".ant-collapse-header").click(); await coverage.getByText("Key 用途待确认", { exact: true }).waitFor(); await coverage.getByText("待处理：核对这把 Key 的全部用途", { exact: true }).waitFor();
});

async function openFixturePage(t, handler, viewport, clock = false, onboardingHandler = null, path = "/reconciliation") {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chromium" });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block", ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.setDefaultTimeout(5_000);
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/api/channel-onboarding")) {
      return onboardingHandler ? onboardingHandler(route) : fulfill(route, { ownStation: null, channels: [], upstreams: [], rules: [], stale: false });
    }
    return handler(route);
  });
  await page.goto(`${baseURL}${path}`, { timeout: 30000 });
  await page.getByText("Rule A").first().waitFor();
  return page;
}

async function fulfill(route, body) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

test("workflow retry destination verifies the original absolute window and retries it once before full re-read", async (t) => {
  const path = `/reconciliation?action=retry&ruleId=rule-1&startMs=${window.startMs}&endMs=${window.endMs}&timezone=Asia%2FShanghai`;
  const { page, reads, queries } = await openDailyPage(t, { path });
  const drawer = page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await drawer.waitFor();
  assert.deepEqual(reads[0], { preset: "custom", startMs: String(window.startMs), endMs: String(window.endMs) });
  assert.equal(queries.length, 0); await drawer.getByRole("button", { name: "重查该窗口账单", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".ant-btn-loading"));
  assert.deepEqual(queries, [{ preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: ["rule-1"] }]);
  assert.deepEqual(reads[1], reads[0]);
});

test("workflow rejects invalid, deleted and changed-zone bill destinations with a usable reload", async (t) => {
  for (const suffix of ["action=unknown&ruleId=rule-1", "action=scope&ruleId=deleted-rule", `action=retry&ruleId=rule-1&startMs=${window.startMs}&endMs=${window.endMs}&timezone=UTC`, "action=retry&ruleId=rule-1&startMs=bad&endMs=1&timezone=Asia%2FShanghai"]) {
    const { page, queries } = await openDailyPage(t, { path: "/reconciliation?" + suffix });
    await page.getByRole("button", { name: "刷新处理目标", exact: true }).waitFor(); assert.equal(queries.length, 0); assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.getByRole("button", { name: "重查该窗口账单", exact: true }).count(), 0);
  }
});

test("workflow scope and conflict destinations expose saved history and all conflict rule corrections", async (t) => {
  const scope = await openDailyPage(t, { path: "/reconciliation?action=scope&ruleId=rule-1" });
  const drawer = scope.page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await drawer.getByText("当前范围完整日生效", { exact: true }).waitFor(); await drawer.getByRole("button", { name: "查看已确认账单历史", exact: true }).waitFor();
  const rows = dailyRows(); for (const row of rows.slice(0, 2)) row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT", ruleIds: ["rule-1", "rule-2"], detail: "销售渠道重复归属" }] };
  const conflict = await openDailyPage(t, { path: "/reconciliation?action=conflict&ruleId=rule-1", data: dailyResponse(rows) }); const detail = conflict.page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await detail.getByText("重复销售归属待处理", { exact: true }).waitFor(); await detail.getByRole("button", { name: "核对 rule-2", exact: true }).click(); const second = conflict.page.getByRole("dialog", { name: "Rule B · 对账详情", exact: true }); await second.getByRole("button", { name: "编辑当前范围", exact: true }).waitFor();
});

function onboardingFixture(existing = true, type = "newapi", ids = [4]) {
  return {
    ownStation: { id: "own-1", baseUrl: "https://own.example" },
    ownSource, sourceVersion: "source-v1",
    upstreams: existing ? [{ id: "upstream-1", name: "Fixture upstream", type, monitorEnabled: true, baseUrl: "https://up.example", identity: type === "newapi-key" ? null : { provider: type.startsWith("sub2api") ? "sub2api" : "newapi", accountId: "42" } }] : [],
    channels: ids.map((id) => ({ id, name: id === 4 ? "New channel" : "New channel " + id, status: 1, baseUrl: "https://up.example", groups: ["local-sales"], revision: "revision-" + id, candidates: existing ? ["upstream-1"] : [], monitor: { status: "unlinked", stationIds: [] }, reconciliation: { status: "unconfigured", ruleIds: [] } })),
    rules: existing ? [{ ...rule("rule-1", "Rule A", 10).rule, ownStationId: "own-1", ownSource, tokenId: 7, enabled: true }] : [],
    syncedAt: "2026-10-09T06:00:00.000Z", stale: false,
  };
}
const onboardingTokens = [{ id: 7, name: "Supplier Key", status: 1, group: "upstream-group" }, { id: 8, name: "New Key", status: 1, group: "upstream-group" }];
const preview = { billingEffectiveFromMs: Date.parse("2026-10-10T00:00:00+08:00"), firstQueryableAtMs: Date.parse("2026-10-11T00:00:00+08:00"), scopeChanged: true };
const ownSource = { stationId: "own-1", provider: "newapi", baseUrl: "https://own.example", accountId: "1", namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", "https://own.example", "1"])).digest("hex") };

function probeResult(body, config, options = {}) {
  const selection = body.selections[0];
  const accountIdentity = { provider: selection.newStation?.type?.startsWith("sub2api") ? "sub2api" : "newapi", baseUrl: selection.newStation?.baseUrl || "https://up.example", accountId: "42" };
  const mainIdentity = (selection.newStation?.type || config.upstreams.find((entry) => entry.id === selection.stationId)?.type) === "newapi-key" ? null : accountIdentity;
  const groups = body.groups.map((group) => {
    const tokenId = group.reconciliation?.tokenId || null;
    const existing = tokenId === 7 ? [1, 2, 3] : [];
    const proposed = [...new Set([...existing, ...group.channels.map((entry) => entry.channelId)])];
    return {
      groupId: group.groupId, requestedGroupIds: [group.groupId], selectionIds: [group.selectionId], requestedChannelIds: group.channels.map((entry) => entry.channelId),
      status: group.reconciliation ? options.billingStatus || "ready" : "monitor_only",
      basis: { ownSource, sourceVersion: "source-v1", channelRevisions: Object.fromEntries(proposed.map((id) => [id, "revision-" + id])), resourceVersions: {}, accountIdentity, canonicalKey: tokenId ? "canonical-" + tokenId : null, tokenId, keyVersion: tokenId ? "key-v1" : null, existingRuleId: tokenId === 7 ? "rule-1" : null, existingScopeVersion: tokenId === 7 ? 1 : null, existingChannelIds: existing, proposedChannelIds: proposed, timezone: group.reconciliation?.timezone || "Asia/Shanghai", billingEffectiveFromMs: preview.billingEffectiveFromMs, coverageDeclaration: group.reconciliation?.coverageDeclaration || { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] } },
      preview: { ...preview, costCoverage: group.reconciliation?.coverageDeclaration.answer === "none" ? "complete" : "unknown" },
    };
  });
  return {
    requestId: body.requestId, previewId: "preview-" + body.requestId, expiresAtMs: Date.now() + 600000, source: { ownSource, sourceVersion: "source-v1", resourceVersion: "own-v1" },
    selections: [{ selectionId: selection.selectionId, station: { id: selection.stationId || "new-up", name: "Fixture upstream" }, monitor: { status: "verified" }, authorizationStationId: selection.reconciliationAuthorization?.stationId || (mainIdentity ? selection.stationId || null : null), accountIdentity: mainIdentity, tokens: options.billingStatus ? [] : onboardingTokens, credentialUpdateRequired: !!options.requireUpdate }],
    groups,
    retryInput: { requestId: body.requestId, source: { ownStationId: body.ownStationId, ownSource, sourceVersion: "source-v1" }, selections: [{ selectionId: selection.selectionId, stationId: selection.stationId || null, type: selection.newStation?.type || config.upstreams.find((entry) => entry.id === selection.stationId)?.type || "newapi", baseUrl: selection.newStation?.baseUrl || "https://up.example", monitor: selection.monitor, additionalMonitorStationIds: selection.additionalMonitorStationIds || [], accountIdentity: mainIdentity, authorizationStationId: selection.reconciliationAuthorization?.stationId || null, authorizationIdentity: accountIdentity, credentialUpdateRequested: !!selection.updateCredentials && !!selection.newStation }], groups: groups.map((group, index) => ({ groupId: group.groupId, requestedGroupIds: group.requestedGroupIds, selectionIds: group.selectionIds, channels: body.groups[index].channels, reconciliationRequested: !!body.groups[index].reconciliation, reconciliation: group.basis.tokenId ? { canonicalKey: group.basis.canonicalKey, tokenId: group.basis.tokenId, timezone: "Asia/Shanghai", coverageDeclaration: group.basis.coverageDeclaration, previewEffectiveFromMs: preview.billingEffectiveFromMs } : null })) },
  };
}
function batchResult(body, probe, complete = true) {
  return { requestId: body.requestId, complete, retryInput: probe.retryInput, groups: probe.groups.map((group) => ({
    groupId: group.groupId, requestedGroupIds: group.requestedGroupIds, canonicalKey: group.basis.canonicalKey, complete,
    monitor: { status: body.selections[0].monitor ? "linked" : "not_requested", stationIds: body.selections[0].monitor ? [body.selections[0].stationId || "new-up"] : [] },
    reconciliation: { status: body.groups[0].reconciliation ? complete ? "configured" : "unverified" : "not_requested", ruleId: complete ? "rule-" + (group.basis.tokenId || "monitor") : undefined },
    saved: { stationIds: body.selections[0].monitor ? [body.selections[0].stationId || "new-up"] : [], authorizationStationId: !body.selections[0].monitor ? body.selections[0].stationId || "new-billing-auth" : body.selections[0].reconciliationAuthorization ? body.selections[0].reconciliationAuthorization.stationId || "billing-auth" : null, links: [], ruleId: complete && body.groups[0].reconciliation ? "rule-" + group.basis.tokenId : null, scopeVersion: 2, billingEffectiveFromMs: preview.billingEffectiveFromMs },
    channels: body.groups.find((entry) => entry.groupId === group.groupId).channels.map((entry) => ({ ...entry, complete, stationIds: [body.selections[0].stationId || "new-up"], ruleId: complete ? "rule-" + group.basis.tokenId : null, remainingActions: complete ? [] : ["retry_rule"] })),
    remainingActions: complete ? [] : ["repreview"],
  })) };
}
async function openOnboardingPage(t, options = {}) {
  const config = options.config || onboardingFixture(), probes = [], writes = [], reads = [], recoveries = [];
  let latestProbe, latestResult;
  const page = await openFixturePage(t, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (path === "/api/reconciliation/configuration") return fulfill(route, options.ruleConfiguration || configuration);
    if (path === "/api/reconciliation" || path === "/api/reconciliation/query") return fulfill(route, options.ruleModel || response(options.ruleResults || [rule("rule-1", "Rule A", 10)]));
    if (options.extraAPI) return options.extraAPI(route, path);
    throw new Error("unexpected fixture API: " + path);
  }, options.viewport, !!options.clock, async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/channel-onboarding/accounts") { reads.push({ path, method: request.method() }); return options.accounts ? options.accounts(route, reads) : fulfill(route, options.accountModel || { accounts: [], unverifiedResources: [], channels: [], actions: [], generatedAt: "2026-10-09T07:00:00.000Z" }); }
    if (options.accountOperation && path.startsWith("/api/channel-onboarding/accounts/")) return options.accountOperation(route, path);
    if (request.method() === "GET" || path.endsWith("/sync")) { reads.push({ path, method: request.method() }); return options.discovery ? options.discovery(route, reads, config) : fulfill(route, config); }
    const body = request.postDataJSON();
    if (path === "/api/channel-onboarding/batch/probe") { probes.push(body); latestProbe = options.probe ? options.probe(body, probes.length, config) : probeResult(body, config, options); latestProbe.previewId += "-" + probes.length; return fulfill(route, latestProbe); }
    if (path === "/api/channel-onboarding/batch/recover") { recoveries.push(body); return fulfill(route, options.recover ? options.recover(body, latestResult) : latestResult || batchResult({ ...probes.at(-1) }, latestProbe, false)); }
    assert.equal(path, "/api/channel-onboarding/batch");
    writes.push(body);
    latestResult = options.connect ? options.connect(body, writes.length, latestProbe) : batchResult(body, latestProbe);
    if (latestResult.complete) for (const group of body.groups) for (const channel of group.channels) {
      const entry = config.channels.find((entry) => entry.id === channel.channelId);
      entry.monitor = { status: "linked", stationIds: [body.selections[0].stationId || "new-up"] }; entry.reconciliation = { status: group.reconciliation ? "configured" : "unconfigured", ruleIds: group.reconciliation ? ["rule-1"] : [] };
    }
    if (options.loseResponseAt === writes.length) return route.abort("failed");
    return fulfill(route, latestResult);
  });
  if (config.stale) await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).waitFor();
  else await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).click({ trial: true });
  return { page, config, probes, writes, reads, recoveries };
}
async function openOnboardingDrawer(page, batch = false) {
  if (batch) { await page.getByText("选择当前筛选渠道（最多 100 个）", { exact: true }).click(); await page.getByRole("button", { name: "批量接入所选渠道", exact: true }).click(); }
  else await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).click();
  return page.getByRole("dialog", { name: "接入监控与对账" });
}
async function verifyOnboarding(drawer) {
  const button = drawer.getByRole("button", { name: "验证并预览", exact: true });
  await button.scrollIntoViewIfNeeded();
  const devBadge = drawer.page().getByRole("button", { name: "Collapse issues badge", exact: true });
  if (await devBadge.isVisible()) await devBadge.click();
  await button.click(); await drawer.getByText("监控连接已验证，尚未保存", { exact: true }).waitFor();
}
async function chooseKey(page, drawer, name = "Supplier Key") { await drawer.getByRole("combobox", { name: "接入上游 Key", exact: true }).click(); await page.getByText(name + " · 上游分组 upstream-group", { exact: true }).last().click(); }
async function enableBilling(page, drawer, key = "Supplier Key") {
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await verifyOnboarding(drawer); await chooseKey(page, drawer, key); await verifyOnboarding(drawer);
  await drawer.getByRole("combobox", { name: "Key 消费范围", exact: true }).click(); await page.getByText("没有", { exact: true }).last().click();
  assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true); await verifyOnboarding(drawer);
}
async function saveOnboarding(drawer) { await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); }

test("five existing-account channels choose one Key and confirm one genuine batch without credentials", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5, 6, 7, 8]) });
  const drawer = await openOnboardingDrawer(page, true); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await enableBilling(page, drawer); await drawer.getByText("完整范围：#1、#2、#3、New channel、New channel 5、New channel 6、New channel 7、New channel 8", { exact: true }).waitFor();
  await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].selections.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].groups.length, 1); assert.deepEqual(writes[0].groups[0].channels.map((entry) => entry.channelId), [4, 5, 6, 7, 8]); assert.equal(writes[0].groups[0].reconciliation.tokenId, 7); assert.equal(writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.ok(writes[0].previewId); assert.equal(probes.filter((entry) => entry.groups[0].reconciliation?.tokenId === 7).length, 2); assert.equal("newStation" in writes[0].selections[0], false);
});

test("different saved resource IDs for the same verified account reuse one existing authorization", async (t) => {
  const config = onboardingFixture(true, "newapi", [4, 5]);
  config.upstreams.push({ ...config.upstreams[0], id: "upstream-2", name: "Same account, another saved PAT" });
  config.channels[0].monitor = { status: "linked", stationIds: ["upstream-1"] };
  config.channels[1].monitor = { status: "linked", stationIds: ["upstream-2"] };
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page, true);
  assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await enableBilling(page, drawer); await saveOnboarding(drawer);
  assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal("newStation" in writes[0].selections[0], false); assert.equal(writes[0].groups.length, 1); assert.deepEqual(writes[0].groups[0].channels.map((entry) => entry.channelId), [4, 5]);
});

test("different Keys remain explicit groups and partial saves recover after reload using public intent", async (t) => {
  const { page, probes, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5]), connect(body, count, probe) {
    const result = batchResult(body, probe);
    if (count === 1) { result.complete = false; const second = result.groups[1]; second.complete = false; second.saved.ruleId = null; second.reconciliation = { status: "pending", reason: "第二把 Key 账单配置保存失败" }; second.channels.forEach((entry) => { entry.complete = false; entry.ruleId = null; entry.remainingActions = ["retry_rule"]; }); second.remainingActions = ["repreview"]; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page, true); await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await verifyOnboarding(drawer); await chooseKey(page, drawer); await drawer.getByText("这些渠道使用不同 Key，分别指定", { exact: true }).click();
  await drawer.getByRole("combobox", { name: "渠道 5 的上游 Key", exact: true }).click(); await page.getByText("New Key · 上游分组 upstream-group", { exact: true }).last().click(); await verifyOnboarding(drawer);
  await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("第二把 Key 账单配置保存失败", { exact: true }).waitFor(); assert.equal(writes.length, 1); assert.deepEqual(writes[0].groups.map((group) => group.reconciliation.tokenId), [7, 8]);
  await page.reload(); await page.getByRole("button", { name: "恢复上次接入", exact: true }).click(); await drawer.getByText("第二把 Key 账单配置保存失败", { exact: true }).waitFor();
  assert.equal(recoveries[0].requestId, writes[0].requestId); assert.deepEqual(recoveries[0].groups.map((group) => group.channels.map((entry) => entry.channelId)), [[4], [5]]); assert.equal("accessToken" in recoveries[0].selections[0], false); assert.equal("saved" in recoveries[0], false); assert.equal(recoveries[0].groups.length, 2);
  await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "重试未完成步骤", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 2); assert.equal(writes[1].selections[0].stationId, "upstream-1"); assert.deepEqual(writes[1].groups.map((group) => group.channels.map((entry) => entry.channelId)), [[4], [5]]);
});

test("new New API credentials are entered once and keyboard cancellation after a probe creates nothing", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-new-pat"); await enableBilling(page, drawer);
  await drawer.getByRole("button", { name: "确认关联", exact: true }).click({ trial: true }); assert.equal(writes.length, 0); assert.equal(probes.at(-1).selections[0].newStation.accessToken, "fixture-new-pat"); await drawer.getByRole("button", { name: "验证并预览", exact: true }).focus(); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 0);
});

test("monitor-only onboarding needs no Key and submits one batch", async (t) => {
  const { page, writes } = await openOnboardingPage(t); const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].groups[0].reconciliation, null);
});

test("Sub2API password mode clears hidden credentials and preserves unsupported billing as partial", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false), billingStatus: "unsupported", connect(body, count, probe) { const result = batchResult(body, probe, false); result.groups[0].reconciliation = { status: "unsupported", reason: "当前部署账单能力不支持" }; return result; } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("hidden-old-pat"); await drawer.getByLabel("监控方式", { exact: true }).click(); await page.getByText("Sub2API · 账号密码", { exact: true }).last().click(); await drawer.getByLabel("上游登录邮箱", { exact: true }).fill("fixture@example.test"); await drawer.getByLabel("上游登录密码", { exact: true }).fill("fixture-password");
  await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("当前部署账单能力不支持", { exact: true }).waitFor();
  assert.equal(writes[0].selections[0].newStation.type, "sub2api-password"); assert.equal("accessToken" in writes[0].selections[0].newStation, false); assert.equal(writes[0].selections[0].newStation.password, "fixture-password");
});

test("pure Key monitor supplements one dedicated billing authorization", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi-key") }); const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await drawer.getByText("账单授权只补一次", { exact: true }).waitFor(); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-billing-pat"); await verifyOnboarding(drawer); await chooseKey(page, drawer); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].selections[0].reconciliationAuthorization.newAuthorization.accessToken, "fixture-billing-pat");
});

test("pure Key recovery after reload reuses the saved dedicated billing authorization", async (t) => {
  const config = onboardingFixture(true, "newapi-key");
  const { page, probes, writes, recoveries } = await openOnboardingPage(t, { config, connect(body, count, probe) {
    const result = batchResult(body, probe, count > 1); result.groups[0].saved.authorizationStationId = "billing-auth";
    if (count === 1) { config.upstreams.push({ id: "billing-auth", name: "Saved billing account", type: "newapi", monitorEnabled: false, baseUrl: "https://up.example", identity: { provider: "newapi", accountId: "42" } }); result.groups[0].reason = "授权已保存，规则待完成"; }
    return result;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时配置 Key 对账", { exact: true }).click(); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-billing-pat"); await verifyOnboarding(drawer); await chooseKey(page, drawer); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("授权已保存，规则待完成", { exact: true }).waitFor();
  await page.reload(); await page.getByRole("button", { name: "恢复上次接入", exact: true }).click(); await drawer.getByText("授权已保存，规则待完成", { exact: true }).waitFor(); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0);
  await verifyOnboarding(drawer); assert.equal(probes.at(-1).selections[0].reconciliationAuthorization.stationId, "billing-auth"); assert.equal(recoveries[0].selections[0].accountIdentity, null); await drawer.getByRole("button", { name: "重试未完成步骤", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(writes.length, 2); assert.equal("newAuthorization" in writes[1].selections[0].reconciliationAuthorization, false);
});

test("additional account and Key monitors retain their explicit overlap warning", async (t) => {
  const config = onboardingFixture(); config.upstreams.push({ id: "key-monitor", name: "Extra Key monitor", type: "newapi-key", monitorEnabled: true, baseUrl: "https://up.example" });
  const { page, writes } = await openOnboardingPage(t, { config }); const drawer = await openOnboardingDrawer(page); await drawer.getByText("同时关联其他已有监控资源（可选）", { exact: true }).click(); await drawer.getByRole("combobox", { name: "其他监控资源", exact: true }).click(); await page.getByText("Extra Key monitor", { exact: true }).last().click(); await drawer.getByText("核对整体监控成本", { exact: true }).waitFor(); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.deepEqual(writes[0].selections[0].additionalMonitorStationIds, ["key-monitor"]);
});

test("connection edits invalidate proof while a display-name edit preserves it", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-pat"); await verifyOnboarding(drawer); await drawer.getByLabel("上游资源名称", { exact: true }).fill("Renamed"); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isEnabled(), true); await drawer.getByLabel("上游站点地址", { exact: true }).fill("https://another.example"); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true); assert.equal(writes.length, 0);
});

test("same-account update needs explicit consent and recovery cannot claim existing relations prove rotation", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { config: onboardingFixture(false), requireUpdate: true, connect(body, count, probe) {
    const result = batchResult(body, probe, false); result.groups[0].code = "CREDENTIAL_UPDATE_UNCONFIRMED"; result.groups[0].reason = "关联已保存，授权更新结果尚未确认，请重新预览"; result.groups[0].remainingActions = ["repreview"]; result.groups[0].reconciliation.status = "configured"; result.groups[0].saved.ruleId = "rule-7"; return result;
  } });
  const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-replacement"); await verifyOnboarding(drawer); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true); await drawer.getByText("已发现相同账号，确认用本次授权更新已有凭证", { exact: true }).click(); await verifyOnboarding(drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("关联已保存，授权更新结果尚未确认，请重新预览", { exact: true }).waitFor(); await drawer.getByRole("button", { name: "核对已保存结果", exact: true }).click(); assert.equal(writes[0].selections[0].updateCredentials, true); assert.equal(recoveries[0].selections[0].credentialUpdateRequested, true); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).inputValue(), "fixture-replacement");
});

test("manual discovery keeps a stale catalogue visible and disables new binding", async (t) => {
  const { page } = await openOnboardingPage(t, { discovery(route, reads, config) { return fulfill(route, reads.length > 2 ? { ...config, stale: true, error: "fixture catalogue unavailable" } : config); } });
  await page.getByRole("button", { name: "发现新渠道", exact: true }).click(); await page.getByText("渠道目录读取失败，正在显示上次发现的渠道", { exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).isDisabled(), true);
});

test("channel search and status filters do not silently select another account", async (t) => {
  const config = onboardingFixture(true, "newapi", [4, 5]); config.channels[1].baseUrl = "https://other.example"; config.channels[1].candidates = ["other-account"]; config.upstreams.push({ id: "other-account", name: "Other account", type: "newapi", baseUrl: "https://other.example", monitorEnabled: true });
  const { page } = await openOnboardingPage(t, { config }); await page.getByRole("textbox", { name: "搜索接入渠道", exact: true }).fill("local-sales"); const drawer = await openOnboardingDrawer(page, true); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 1); assert.equal(await drawer.getByRole("button", { name: "确认关联", exact: true }).isDisabled(), true);
});

test("five-channel batches fit 320/390/768/1440 widths without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(true, "newapi", [4, 5, 6, 7, 8]), viewport: { width, height: 900 } });
    const drawer = await openOnboardingDrawer(page, true); await enableBilling(page, drawer); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true); await saveOnboarding(drawer); assert.equal(writes.length, 1); await page.close();
  }
});

test("old rule editor previews one exact final set and confirms one PUT without recreating the rule", async (t) => {
  const row = rule("rule-1", "Rule A", 10);
  row.rule = { ...row.rule, tokenId: 7, timezone: "Asia/Shanghai", channels: [1, 2].map((channelId) => ({ channelId, name: "Sales " + channelId })) };
  const config = { ...configuration, channels: [1, 2, 3].map((id) => ({ id, name: "Sales " + id, status: 1 })), rules: [{ ...row.rule, enabled: true }] };
  const previews = [], puts = [];
  const { page } = await openOnboardingPage(t, { ruleConfiguration: config, ruleResults: [row], extraAPI(route, path) {
    const body = route.request().postDataJSON();
    if (path === "/api/reconciliation/rules/rule-1/preview") {
      previews.push(body);
      const group = probeResult({ requestId: "fixture", ownStationId: "own-1", selections: [{ selectionId: "primary", stationId: "upstream-1", monitor: false }], groups: [{ groupId: "rule-edit", selectionId: "primary", channels: body.salesChannelIds.map((channelId) => ({ channelId, channelRevision: "revision-" + channelId })), reconciliation: { tokenId: 7, coverageDeclaration: body.coverageDeclaration } }] }, onboardingFixture()).groups[0];
      return fulfill(route, { previewId: "exact-rule-preview", groupId: "rule-edit", expiresAtMs: Date.now() + 600000, basis: { ...group.basis, existingChannelIds: [1, 2], proposedChannelIds: body.salesChannelIds }, preview: group.preview });
    }
    if (path === "/api/reconciliation/rules/rule-1" && route.request().method() === "PUT") { puts.push(body); return fulfill(route, { rule: { ...row.rule, channels: body.salesChannelIds.map((channelId) => ({ channelId })) } }); }
    throw new Error("unexpected rule fixture API: " + path);
  } });
  await page.getByRole("button", { name: "操作 Rule A 的规则", exact: true }).click(); await page.getByText("编辑规则", { exact: true }).last().click();
  const drawer = page.getByRole("dialog", { name: "编辑对账规则", exact: true });
  await drawer.locator('.ant-select-selection-item[title="Sales 1 · ID 1"] .ant-select-selection-item-remove').click();
  await drawer.getByLabel("本站销售渠道", { exact: true }).click(); await page.getByText("Sales 3 · ID 3", { exact: true }).last().click(); await drawer.getByLabel("本站销售渠道", { exact: true }).press("Escape");
  await drawer.getByRole("button", { name: "预览对账规则", exact: true }).click(); await drawer.getByText("最终渠道：#2、#3", { exact: true }).waitFor(); await drawer.getByText("释放渠道：#1；原账单保留。", { exact: true }).waitFor(); assert.equal(puts.length, 0);
  await drawer.getByRole("button", { name: "保存对账规则", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(previews.length, 1); assert.equal(puts.length, 1); assert.deepEqual(puts[0].salesChannelIds, [2, 3]); assert.equal(puts[0].tokenId, 7); assert.equal(puts[0].groupId, "rule-edit"); assert.equal(puts[0].previewId, "exact-rule-preview"); assert.equal(puts[0].coverageDeclaration.answer, "unknown");
});

test("manual create uses genuine batch proof and retains account monitoring purpose", async (t) => {
  const { page, probes, writes } = await openOnboardingPage(t, { ruleConfiguration: { ...configuration, channels: [{ id: 4, name: "New channel", status: 1 }] }, extraAPI(route, path) {
    if (path === "/api/reconciliation/upstreams/upstream-1/keys") return fulfill(route, { tokens: onboardingTokens, groups: {} });
    throw new Error("unexpected create fixture API: " + path);
  } });
  await page.getByRole("button", { name: "添加对账规则", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "添加对账规则", exact: true });
  await drawer.getByLabel("上游账号", { exact: true }).click(); await page.getByText("Fixture upstream", { exact: true }).last().click(); await drawer.getByLabel("固定分组 Key", { exact: true }).click(); await page.getByText("Supplier Key · upstream-group", { exact: true }).last().click(); await drawer.getByLabel("本站销售渠道", { exact: true }).click(); await page.getByText("New channel · ID 4", { exact: true }).last().click(); await drawer.getByLabel("对账时区", { exact: true }).click();
  await drawer.getByRole("button", { name: "预览对账规则", exact: true }).click(); await drawer.getByText("最终渠道：#1、#2、#3、#4", { exact: true }).waitFor(); assert.equal(writes.length, 0); await drawer.getByRole("button", { name: "保存对账规则", exact: true }).click(); await drawer.waitFor({ state: "hidden" }); assert.equal(probes.length, 1); assert.equal(writes.length, 1); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].stationId, "upstream-1"); assert.equal(writes[0].previewId, "preview-" + writes[0].requestId + "-1");
});

test("a lost batch response recovers persisted results without returned browser IDs or another confirm", async (t) => {
  const { page, writes, recoveries } = await openOnboardingPage(t, { loseResponseAt: 1 });
  const drawer = await openOnboardingDrawer(page); await enableBilling(page, drawer); await drawer.getByRole("button", { name: "确认关联", exact: true }).click(); await drawer.getByText("全部请求步骤已保存", { exact: true }).waitFor();
  assert.equal(writes.length, 1); assert.equal(recoveries.length, 1); assert.equal(recoveries[0].requestId, writes[0].requestId); assert.equal(recoveries[0].selections[0].stationId, "upstream-1"); assert.equal("saved" in recoveries[0], false); assert.equal(await drawer.getByRole("button", { name: "重试未完成步骤", exact: true }).isDisabled(), true);
});

test("a new billing-only account is confirmed without creating another monitor", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { config: onboardingFixture(false) }); const drawer = await openOnboardingDrawer(page); await drawer.getByLabel("上游系统访问令牌", { exact: true }).fill("fixture-billing-only"); await drawer.getByText("关联余额监控", { exact: true }).click(); await enableBilling(page, drawer); await saveOnboarding(drawer); assert.equal(writes[0].selections[0].monitor, false); assert.equal(writes[0].selections[0].newStation.accessToken, "fixture-billing-only");
});

test("the resources page retains the same batch entry and original resource configuration", async (t) => {
  const { page, writes } = await openOnboardingPage(t, { extraAPI(route, path) {
    if (path === "/api/stations") return fulfill(route, { stations: [], settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 } });
    if (path === "/api/meta") return fulfill(route, { types: [{ value: "newapi", label: "New API", needs: ["accessToken", "userId"] }], rules: {} });
    throw new Error("unexpected station fixture API: " + path);
  } });
  await page.goto(baseURL + "/stations"); const drawer = await openOnboardingDrawer(page); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(writes.length, 1); assert.equal(writes[0].groups[0].channels[0].channelId, 4); await page.getByRole("button", { name: /添加资源/ }).click(); await page.getByRole("dialog", { name: "添加上游资源", exact: true }).waitFor();
});

test("catalogue sync occurs on entry and manual discovery, without page-minute polling", async (t) => {
  const { page, reads } = await openOnboardingPage(t, { clock: true }); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 1); await page.clock.fastForward(70000); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 1); await page.getByRole("button", { name: "发现新渠道", exact: true }).click(); await page.getByRole("button", { name: "接入渠道 New channel", exact: true }).click({ trial: true }); assert.equal(reads.filter((entry) => entry.path.endsWith("/sync")).length, 2);
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
  const action = (kind, label, target = {}) => ({ id: kind + ":" + hash(target), kind, label, accountKey: null, stationId: null, ruleId: null, ownStationId: null, channelIds: [], window: null, href: "/stations", ...target });
  const key = (accountId, tokenId, extra = {}) => ({ canonicalKey: hash(["newapi", "https://same.test", accountId, tokenId]), tokenId, tokenName: "Key " + tokenId,
    ruleIds: [accountId + "-active"], activeRuleIds: [accountId + "-active"], scopeAmbiguous: false, channels: [member(1)], costCoverage: "unknown", coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] }, scopeVersion: 3, billingEffectiveFromMs: 1791561600000, firstQueryableAtMs: 1791648000000, ...extra });
  const a = { accountKey: aKey, siteKey: hash(["newapi", "https://same.test"]), identity: aIdentity,
    resources: [resource("A-archived", aIdentity, { archivedAt: "2026-10-01T00:00:00Z", purposes: { monitor: true, billingRuleIds: ["A-history"] } }), resource("A-billing", aIdentity, { monitorEnabled: false, purposes: { monitor: false, billingRuleIds: ["A-active"] } }),
      resource("A-monitor-1", aIdentity, { lowBalanceUsd: 27, cnyPerUsd: 0.7, includeInProfit: false, noRenewal: true, balance: { ok: false, remaining: 10, account: null, error: "403 [已隐藏] [已隐藏] [已隐藏]" } }), resource("A-monitor-2", aIdentity, { purposes: { monitor: true, billingRuleIds: ["A-stopped"] } })],
    keys: [key("A", 9, { ruleIds: ["A-active", "A-history"], channels: [member(1), member(3)] }), key("A", 10, { ruleIds: ["A-stopped"], activeRuleIds: [], channels: [member(2)] })],
    actions: [action("update_authorization", "更新账号授权", { accountKey: aKey, href: `/stations?action=authorization&accountKey=${aKey}` }), action("confirm_coverage", "核对这把 Key 的全部用途", { accountKey: aKey, ruleId: "A-active", ownStationId: "own", channelIds: [2], href: "/stations?action=coverage&ruleId=A-active" })] };
  const b = { accountKey: bKey, siteKey: a.siteKey, identity: bIdentity, resources: [resource("B-monitor", bIdentity)], keys: [key("B", 9, { costCoverage: "complete", coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] }, channels: [member(2)] })], actions: [action("inspect_balance", "查看余额与监控", { accountKey: bKey, stationId: "B-monitor" })] };
  const sub = { accountKey: subKey, siteKey: hash(["sub2api", "https://same.test"]), identity: subIdentity, resources: [resource("Sub-JWT", subIdentity, { type: "sub2api" }), resource("Sub-password", subIdentity, { type: "sub2api-password", hasAccessToken: false, hasPassword: true })], keys: [], actions: [] };
  const unverifiedResources = [resource("pure-key", null, { type: "newapi-key", hasAccessToken: false, hasApiKey: true }), resource("unknown-legacy", null)];
  const channels = [1, 2, 3].map((id) => ({ id, name: "Channel " + id, type: 1, status: id === 2 ? 2 : 1, baseUrl: "https://same.test", groups: ["sales"], revision: "revision-" + id, missing: id === 3,
    monitor: { status: id === 1 ? "linked" : "unlinked", stationIds: id === 1 ? ["A-monitor-1", "A-monitor-2", "pure-key"] : [] }, reconciliation: { status: "configured", ruleIds: id === 1 ? ["A-active"] : id === 2 ? ["B-active", "A-stopped"] : ["A-history"] } }));
  return { accounts: [a, b, sub], unverifiedResources, channels, actions: [...a.actions, ...b.actions, action("connect_channels", "接入这些渠道", { stationId: "pure-key", ownStationId: "own", channelIds: [1], href: "/stations?action=connect&ownStationId=own&channelIds=1" }), action("verify_identity", "核验账号身份", { stationId: "unknown-legacy", ownStationId: "own", href: "/stations?action=verify&stationId=unknown-legacy" })], generatedAt: "2026-10-09T07:00:00.000Z" };
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
  await page.goto(baseURL + (options.path || "/stations")); const center = page.getByRole("region", { name: "账号关系中心" }); if (options.initialFailure) await center.getByRole("button", { name: "重试账号关系", exact: true }).waitFor(); else if (!options.path) await center.getByText(/显示 3\/3 个已核验账号/).waitFor(); else await center.getByText(/显示 .* 个已核验账号/).waitFor();
  const badge = page.getByRole("button", { name: "Collapse issues badge", exact: true }); if (await badge.isVisible()) await badge.click();
  return { ...onboarded, page, center, model, mutations, accountRequests, originalStations };
}
async function expandAccount(center, account) { await center.locator(`[data-site-key="${account.siteKey}"]`).getByRole("button", { name: new RegExp("账号 " + account.identity.accountId + " ") }).click(); return center.locator(`[data-account-key="${account.accountKey}"]`); }

test("workflow channel and complete-Key destinations reuse one batch confirmation with known ninth channel", async (t) => {
  const config = onboardingFixture(true, "newapi", [1, 2, 3, 4, 9]); config.rules[0].channels = [1, 2, 3].map((channelId) => ({ channelId, name: "Sales " + channelId })); config.rules[0].coverageDeclaration = { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [9] }; config.rules[0].timezone = "UTC";
  const opened = await openAccountsPage(t, { config, path: "/stations?action=coverage&ruleId=rule-1" });
  const drawer = opened.page.getByRole("dialog", { name: "接入监控与对账", exact: true }); await drawer.getByText("本次选择 4 个渠道", { exact: true }).waitFor(); assert.equal(await drawer.getByLabel("上游系统访问令牌", { exact: true }).count(), 0); await verifyOnboarding(drawer); await drawer.getByRole("combobox", { name: "Key 消费范围", exact: true }).click(); await opened.page.getByText("没有", { exact: true }).last().click(); await verifyOnboarding(drawer); await saveOnboarding(drawer);
  assert.equal(opened.writes.length, 1); assert.deepEqual(opened.writes[0].groups[0].channels.map((channel) => channel.channelId), [1, 2, 3, 9]); assert.equal(opened.writes[0].groups[0].reconciliation.tokenId, 7); assert.equal(opened.writes[0].groups[0].reconciliation.timezone, "UTC"); assert.equal(opened.writes[0].groups[0].reconciliation.coverageDeclaration.answer, "none"); assert.equal(opened.writes[0].selections[0].stationId, "upstream-1");
  const connected = await openAccountsPage(t, { path: "/stations?action=connect&ownStationId=own-1&channelIds=4" }); const single = connected.page.getByRole("dialog", { name: "接入监控与对账", exact: true }); await single.getByText("本次选择 1 个渠道", { exact: true }).waitFor(); await verifyOnboarding(single); await saveOnboarding(single); assert.equal(connected.writes.length, 1);
});

test("workflow stale channel, changed source and stopped coverage destinations keep an actionable reload", async (t) => {
  for (const path of ["/stations?action=connect&ownStationId=own-1&channelIds=999", "/stations?action=connect&ownStationId=another-source&channelIds=4", "/stations?action=coverage&ruleId=stopped-rule", "/stations?action=source&ownStationId=another-source"]) {
    const opened = await openAccountsPage(t, { path }); await opened.page.getByRole("button", { name: "刷新处理目标", exact: true }).waitFor(); assert.equal(opened.writes.length, 0); assert.equal(opened.probes.length, 0); assert.equal(await opened.page.getByRole("dialog").count(), 0);
  }
  const config = onboardingFixture(true, "newapi", [1, 2, 3, 4]); config.ownSource = { ...ownSource, accountId: "2", namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", ownSource.baseUrl, "2"])).digest("hex") };
  const changed = await openAccountsPage(t, { config, path: "/stations?action=coverage&ruleId=rule-1" }); await changed.page.getByText("原规则的本站来源与当前核验来源不同，请先核对本站来源；原历史账单不会改归新来源。", { exact: true }).waitFor(); assert.equal(changed.probes.length, 0); assert.equal(changed.writes.length, 0);
});

test("workflow balance destination focuses original resource settings and account authorization opens its existing flow", async (t) => {
  const opened = await openAccountsPage(t, { path: "/stations?stationId=A-monitor-1" }); const focused = opened.page.getByRole("region", { name: "定位原资源余额与监控", exact: true }); await focused.getByText("A-monitor-1", { exact: true }).waitFor(); assert.equal(await focused.getByText("A-monitor-2", { exact: true }).count(), 0); await focused.getByRole("button", { name: "原资源设置", exact: true }).click(); const editor = opened.page.getByRole("dialog", { name: "编辑上游资源", exact: true }); await editor.waitFor(); assert.equal(await editor.getByLabel("用户 ID（New-Api-User）", { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("低余额告警阈值（按站点余额 $ 计，可留空）", { exact: true }).inputValue(), "27");
  const authorized = await openAuthorizationPage(t); await authorized.page.goto(`${baseURL}/stations?action=authorization&accountKey=${authorized.model.accounts[0].accountKey}`); const drawer = authorized.page.getByRole("dialog", { name: "更新账号授权 · 42", exact: true }); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("u06-once"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.equal(authorized.updates.length, 1); assert.deepEqual(authorized.updates[0].targetStationIds.sort(), ["st_u04_a1", "st_u04_a2", "st_u04_billing"]);
});

test("workflow source destination distinguishes last verified stale namespace and explicit current sync", async (t) => {
  const config = { ...onboardingFixture(), ownSource, sourceVersion: "source-v1", stale: true, error: "source unavailable" }; let current = false;
  const opened = await openAccountsPage(t, { config, path: "/stations?action=source&ownStationId=own-1", discovery(route, reads) { return fulfill(route, current ? { ...config, ownSource: { ...ownSource, accountId: "2", namespaceKey: "new-source-namespace" }, sourceVersion: "source-v2", stale: false, error: null } : config); } });
  const source = opened.page.getByRole("region", { name: "核对本站来源", exact: true }); await source.getByText("目录已过期，以下为最后核验来源", { exact: true }).waitFor(); assert.ok((await source.textContent()).includes("实际账号 1")); current = true; await source.getByRole("button", { name: "读取最新本站渠道", exact: true }).click(); await source.getByText("当前已核验本站来源", { exact: true }).waitFor(); assert.ok((await source.textContent()).includes("实际账号 2")); assert.equal(opened.writes.length, 0); assert.equal(opened.probes.length, 0);
});

function keyVerificationFixture(provider = "newapi", timezone = "UTC", selected = false) {
  const capability = { state: "supported", currency: "USD", window: provider === "sub2api" ? "natural-day" : "second" };
  const billingTimezone = provider === "sub2api" ? { state: "unverified", timezone, reason: "BILLING_TIMEZONE_UNVERIFIED" } : { state: "verified", timezone };
  return { quotaPerUnit: provider === "newapi" ? 100 : null, version: provider === "newapi" ? "deployment-v1" : "", groups: provider === "newapi" ? { g: { ratio: 1, description: "" } } : {}, platform: provider,
    capability: provider === "sub2api" ? { state: "unverified", currency: "USD", window: "natural-day", reason: "DEPLOYMENT_NOT_VERIFIED" } : capability,
    billingTimezone, tokens: [{ id: 9, name: "actual-key", status: 1, group: provider === "newapi" ? "g" : "", crossGroupRetry: false }], identity: { provider, baseUrl: "https://same.test", accountId: "42" }, resourceVersion: "verified-resource-version",
    probe: selected ? { tokenId: 9, state: "complete", complete: true, window: timezone === "UTC" ? { startMs: 1791417600000, endMs: 1791504000000, timezone } : { startMs: 1791388800000, endMs: 1791475200000, timezone }, currency: "USD", amountUsd: provider === "newapi" ? 0 : 3.25, knownAmountUsd: provider === "newapi" ? 0 : 3.25, actualCostUsd: provider === "sub2api" ? 3.25 : null, quotaUnits: provider === "newapi" ? 0 : null, quotaPerUnit: provider === "newapi" ? 100 : null, capability, billingTimezone } : null };
}
test("workflow identity and selected-Key read preserve actual zero and separate Sub2 date capability from timezone", async (t) => {
  for (const [stationId, provider, action, timezone] of [["unknown-legacy", "newapi", "verify", "UTC"], ["Sub-password", "sub2api", "verify-billing", "Asia/Shanghai"]]) {
    const reads = []; const opened = await openAccountsPage(t, { path: `/stations?action=${action}&stationId=${stationId}`, readonlyAPI(route, path) {
      assert.equal(path, `/api/reconciliation/upstreams/${stationId}/keys`); const params = Object.fromEntries(new URL(route.request().url()).searchParams); reads.push(params); return fulfill(route, keyVerificationFixture(provider, params.timezone, !!params.tokenId));
    } });
    const drawer = opened.page.getByRole("dialog", { name: `核验账号与账单能力 · ${stationId}`, exact: true }); await drawer.waitFor(); await drawer.getByRole("textbox", { name: "核验账单时区", exact: true }).fill(timezone); await drawer.getByRole("button", { name: "实际核验账号与 Key 目录", exact: true }).click(); await drawer.getByText("本次实际账号已核验：42", { exact: true }).waitFor(); await drawer.getByRole("combobox", { name: "核验实际 Key", exact: true }).click(); await opened.page.getByText(`actual-key · #9 · ${provider === "newapi" ? "g" : "无分组"}`, { exact: true }).last().click(); await drawer.getByRole("button", { name: "核验所选 Key 账单", exact: true }).click(); await drawer.getByText(provider === "newapi" ? "所选 Key 原统计" : "所选 Key 扣费参考", { exact: true }).waitFor();
    assert.deepEqual(reads, [{ force: "true", timezone }, { force: "true", timezone, tokenId: "9" }]); assert.ok((await drawer.textContent()).includes(provider === "newapi" ? "原金额：$0.00" : "原金额：$3.25")); assert.ok((await drawer.textContent()).includes("此处不确认利润")); if (provider === "sub2api") { assert.ok((await drawer.textContent()).includes("本次 Key / 日期能力：已支持")); assert.ok((await drawer.textContent()).includes("未核验，原金额仅供参考")); } assert.equal(opened.mutations.length, 0); assert.equal(opened.writes.length, 0);
  }
});

test("workflow unreadable Key directory remains partial and pure-Key fallback uses the full original editor", async (t) => {
  const opened = await openAccountsPage(t, { path: "/stations?action=verify&stationId=unknown-legacy", readonlyAPI(route) {
    const partial = keyVerificationFixture(); Object.assign(partial, { quotaPerUnit: null, version: "", groups: {}, tokens: [], capability: { state: "unverified", currency: "USD", window: "second", reason: "KEY_METADATA_UNAVAILABLE" }, billingTimezone: { state: "unverified", timezone: "Asia/Shanghai", reason: "KEY_METADATA_UNAVAILABLE" } }); return fulfill(route, partial);
  } }); const drawer = opened.page.getByRole("dialog", { name: "核验账号与账单能力 · unknown-legacy", exact: true }); await drawer.getByRole("button", { name: "实际核验账号与 Key 目录", exact: true }).click(); await drawer.getByText("Key 目录无法读取，请检查目录权限或稍后重试", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("combobox", { name: "核验实际 Key", exact: true }).count(), 0); assert.equal(opened.mutations.length, 0);
  const pure = await openAccountsPage(t, { path: "/stations?action=verify-billing&stationId=pure-key", readonlyAPI() { assert.fail("pure Key must not enter account probe"); } }); const pureDrawer = pure.page.getByRole("dialog", { name: "核验账号与账单能力 · pure-key", exact: true }); await pureDrawer.getByText("纯 Key 保持独立，不能推断所属账号", { exact: true }).waitFor(); await pureDrawer.getByRole("button", { name: "补充原资源授权", exact: true }).click(); const editor = pure.page.getByRole("dialog", { name: "编辑上游资源", exact: true }); await editor.waitFor(); assert.equal(await editor.getByLabel("名称", { exact: true }).inputValue(), "pure-key"); assert.equal(pure.mutations.length, 0);
});

test("workflow external Key use stops the old rule before selecting a new Key while unknown use stays reference", async (t) => {
  const config = onboardingFixture(true, "newapi", [1, 2, 3, 4]); config.rules[0].channels = [1, 2, 3].map((channelId) => ({ channelId })); config.rules[0].coverageDeclaration = { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] };
  const opened = await openAccountsPage(t, { config, path: "/stations?action=coverage&ruleId=rule-1", mutation(route, mutation) { assert.equal(mutation.path, "/api/reconciliation/rules/rule-1"); assert.equal(mutation.method, "DELETE"); config.rules[0].enabled = false; return fulfill(route, { ok: true }); } }); const drawer = opened.page.getByRole("dialog", { name: "接入监控与对账", exact: true }); await drawer.getByText("核对既有 Key 的完整用途", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("combobox", { name: "接入上游 Key", exact: true }).isDisabled(), true);
  await drawer.getByRole("button", { name: "隔离站外调用后关联新 Key", exact: true }).click(); const confirm = opened.page.getByRole("dialog", { name: "停止旧 Key 核算后重新关联？", exact: true }); await confirm.getByText(/原账、旧范围与监控资源保留/).waitFor(); assert.equal(opened.writes.length, 0); await confirm.getByRole("button", { name: "停止旧规则并选择新 Key", exact: true }).click(); await confirm.waitFor({ state: "hidden" }); assert.equal(opened.mutations.length, 1);
  await verifyOnboarding(drawer); await chooseKey(opened.page, drawer, "New Key"); await verifyOnboarding(drawer); await drawer.getByRole("combobox", { name: "Key 消费范围", exact: true }).click(); await opened.page.getByText("没有", { exact: true }).last().click(); await verifyOnboarding(drawer); await saveOnboarding(drawer); assert.equal(opened.writes.length, 1); assert.equal(opened.writes[0].groups[0].reconciliation.tokenId, 8); assert.equal(opened.writes[0].selections[0].stationId, "upstream-1");
  const unknown = await openAccountsPage(t, { config: onboardingFixture(true, "newapi", [1, 2, 3, 4]), path: "/stations?action=coverage&ruleId=rule-1" }); const unknownDrawer = unknown.page.getByRole("dialog", { name: "接入监控与对账", exact: true }); await verifyOnboarding(unknownDrawer); await unknownDrawer.getByText(/保留成本与收入参考，账面毛利待确认/).waitFor(); await unknownDrawer.getByRole("button", { name: "验证并预览", exact: true }).waitFor(); assert.equal(unknown.mutations.length, 0); assert.equal(unknown.writes.length, 0); assert.equal(unknown.probes[0].groups[0].reconciliation.coverageDeclaration.answer, "unknown");
});

test("workflow overview merges stable public actions and preserves prior actions on a partial read failure", async (t) => {
  let reads = 0; const opened = await openAccountsPage(t, { accounts(route, count, model) { reads += 1; return count > 2 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture account read unavailable" }) }) : fulfill(route, model); }, readonlyAPI(route, path) { assert.equal(path, "/api/history/overview"); return fulfill(route, { series: [] }); } });
  await opened.page.goto(baseURL); const region = opened.page.getByRole("region", { name: "需要处理", exact: true }); await region.getByRole("link", { name: "更新账号授权", exact: true }).waitFor(); assert.equal(await region.getByRole("link", { name: "核对这把 Key 的全部用途", exact: true }).count(), 1); const before = await region.getByRole("listitem").count(); await region.getByRole("button", { name: "刷新处理事项", exact: true }).click(); await region.getByText("部分账号或账单事项未能更新，保留上次已读事项。", { exact: true }).waitFor(); assert.equal(await region.getByRole("listitem").count(), before); const href = await region.getByRole("link", { name: "更新账号授权", exact: true }).getAttribute("href"); assert.equal(href, opened.model.accounts[0].actions[0].href); assert.equal(opened.mutations.length, 0); assert.ok(reads >= 3);
});

test("workflow read failures and deleted verification targets expose a safe retry with no save", async (t) => {
  let calls = 0; const opened = await openAccountsPage(t, { path: "/stations?action=verify-billing&stationId=unknown-legacy", readonlyAPI(route) { calls += 1; if (calls === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "KEY_PROBE_UNAVAILABLE", retryable: true, error: "账号身份暂时无法核验，请检查授权或稍后重试" }) }); return fulfill(route, keyVerificationFixture("newapi", "Asia/Shanghai")); } }); const drawer = opened.page.getByRole("dialog", { name: "核验账号与账单能力 · unknown-legacy", exact: true }); await drawer.getByRole("button", { name: "实际核验账号与 Key 目录", exact: true }).click(); await drawer.getByRole("button", { name: "刷新处理目标", exact: true }).waitFor(); await drawer.getByRole("button", { name: "实际核验账号与 Key 目录", exact: true }).click(); await drawer.getByText("本次实际账号已核验：42", { exact: true }).waitFor(); assert.equal(calls, 2); assert.equal(opened.mutations.length, 0);
  for (const path of ["/stations?action=verify&stationId=deleted", "/stations?action=authorization&accountKey=deleted", "/stations?stationId=deleted"]) { const unavailable = await openAccountsPage(t, { path }); await unavailable.page.getByRole("button", { name: "刷新处理目标", exact: true }).waitFor(); assert.equal(await unavailable.page.getByRole("dialog").count(), 0); assert.equal(unavailable.mutations.length, 0); }
});

test("workflow verification keyboard and financial source links fit 320/390/768/1440 widths", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const opened = await openAccountsPage(t, { viewport: { width, height: 900 }, path: "/stations?action=verify-billing&stationId=Sub-password", readonlyAPI(route, path) {
      if (path.endsWith("/keys")) { const params = new URL(route.request().url()).searchParams; return fulfill(route, keyVerificationFixture("sub2api", params.get("timezone"), params.has("tokenId"))); }
      if (path === "/api/analytics") return fulfill(route, { days: 30, start: "2026-09-09", end: "2026-10-08", selection: { includeArchived: false, stationCount: 0, archivedStationCount: 0 }, coverage: { earliestDate: null, latestDate: null, availableDays: 0, requestedDays: 30, monitoredStationCount: 0, isComplete: false, stationGaps: [] }, stations: [], daily: [], fixedDaily: [], heatmap: [], heatmapAvailable: false, heatmapAvailability: { available: false, reason: "no-cost-stations", coverage: null }, generatedAt: "2026-10-09T03:00:00Z" });
      if (path === "/api/own/analytics") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "还没有标记「我的中转站」" }) });
      throw new Error("unexpected financial navigation fixture: " + path);
    } });
    const drawer = opened.page.getByRole("dialog", { name: "核验账号与账单能力 · Sub-password", exact: true }); const directory = drawer.getByRole("button", { name: "实际核验账号与 Key 目录", exact: true }); await directory.focus(); await opened.page.keyboard.press("Enter"); await drawer.getByText("本次实际账号已核验：42", { exact: true }).waitFor(); const key = drawer.getByRole("combobox", { name: "核验实际 Key", exact: true }); await key.focus(); await opened.page.keyboard.press("ArrowDown"); await opened.page.keyboard.press("Enter"); const probe = drawer.getByRole("button", { name: "核验所选 Key 账单", exact: true }); await probe.focus(); await opened.page.keyboard.press("Enter"); await drawer.getByText("所选 Key 扣费参考", { exact: true }).waitFor(); assert.ok(await opened.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)); await drawer.locator(".ant-drawer-close").focus(); await opened.page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
    await opened.page.goto(baseURL + "/analytics", { timeout: 30000 }); await opened.page.getByText("监控估算来源", { exact: true }).waitFor(); const bill = opened.page.locator('.page-toolbar a[href="/reconciliation"]'); await bill.waitFor(); await bill.focus(); await opened.page.keyboard.press("Enter"); await opened.page.getByRole("region", { name: "对账汇总", exact: true }).waitFor(); await opened.page.getByRole("link", { name: "监控估算", exact: true }).last().waitFor(); assert.ok(await opened.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)); assert.equal(opened.mutations.length, 0); await opened.page.context().browser().close();
  }
});

async function openAuthorizationPage(t, options = {}) {
  const model = accountReadFixture(), probes = [], updates = [], recoveries = [], operations = new Map();
  const rename = { "A-monitor-1": "st_u04_a1", "A-monitor-2": "st_u04_a2", "A-billing": "st_u04_billing", "A-archived": "st_u04_archived", "B-monitor": "st_u04_b", "pure-key": "st_u04_key", "unknown-legacy": "st_u04_unknown", own: "st_u04_own" };
  const account = model.accounts[0], b = model.accounts[1]; account.identity.accountId = "42"; b.identity.accountId = "43";
  for (const item of [account, b]) {
    item.accountKey = createHash("sha256").update(JSON.stringify([item.identity.provider, item.identity.baseUrl, item.identity.accountId])).digest("hex");
    for (const resource of item.resources) { resource.id = rename[resource.id] || resource.id; resource.identity = { ...item.identity }; resource.purposes.billingRuleIds = resource.id === "st_u04_billing" ? ["rule_u04"] : []; }
    for (const key of item.keys) if (key.activeRuleIds.length) { key.ruleIds = item === account ? ["rule_u04", "rule_history"] : ["rule_b"]; key.activeRuleIds = [key.ruleIds[0]]; }
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
    assert.equal(mutation.method, "DELETE"); const ruleId = mutation.path.split("/").at(-1); for (const item of model.accounts) for (const key of item.keys) key.activeRuleIds = key.activeRuleIds.filter((id) => id !== ruleId); return fulfill(route, { ok: true });
  } });
  originalStations = opened.originalStations;
  return { ...opened, probes, updates, recoveries };
}
async function openAccountAuthorization(page, center, account) {
  const expanded = await expandAccount(center, account); await expanded.getByRole("button", { name: `更新账号授权 ${account.identity.provider} ${account.identity.accountId}`, exact: true }).click();
  return page.getByRole("dialog", { name: `更新账号授权 · ${account.identity.accountId}`, exact: true });
}
async function previewAuthorization(drawer) { await drawer.getByRole("button", { name: "预览授权更新", exact: true }).click(); await drawer.getByText("授权更新预览，尚未保存", { exact: true }).waitFor(); }
async function confirmAccountAuthorization(drawer) { const button = drawer.getByRole("button", { name: "确认更新所选授权", exact: true }); await button.click(); await drawer.getByText(/本次所选目标已完成授权更新|部分目标尚未更新，已保存目标保留/).waitFor(); await drawer.locator(".ant-drawer-close").waitFor(); }

test("account authorization inputs once and confirms three explicit targets while excluding same-site B, own, archived and pure Key", async (t) => {
  const { page, center, model, probes, updates, originalStations } = await openAuthorizationPage(t), account = model.accounts[0]; const before = originalStations.map((resource) => ({ id: resource.id, userId: resource.userId, costAliases: resource.costAliases, lowBalanceUsd: resource.lowBalanceUsd, cnyPerUsd: resource.cnyPerUsd, includeInProfit: resource.includeInProfit, noRenewal: resource.noRenewal }));
  const drawer = await openAccountAuthorization(page, center, account); assert.equal(await drawer.locator('input[type="password"]').count(), 1); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("one-new-pat"); await previewAuthorization(drawer);
  assert.deepEqual(probes[0].targetStationIds, ["st_u04_billing", "st_u04_a1", "st_u04_a2"]); assert.deepEqual(probes[0].authorization, { type: "newapi", baseUrl: "https://same.test", accessToken: "one-new-pat", userId: "42" });
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("account-authorization-recovery-v05"))); assert.deepEqual(stored, { accountKey: account.accountKey, retryInput: { requestId: probes[0].requestId, targetStationIds: probes[0].targetStationIds } }); assert.doesNotMatch(JSON.stringify(stored), /pat|authorization|previewId|marker/);
  await drawer.getByText(/排除记录：.*已归档.*其他账号.*纯 Key.*本站/).waitFor(); await drawer.getByText("影响账单规则：rule_u04", { exact: true }).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); assert.equal(await drawer.locator('[data-authorization-target]').count(), 3); assert.equal(await drawer.locator('input[type="password"]').count(), 0); assert.equal(await page.evaluate(() => sessionStorage.getItem("account-authorization-recovery-v05")), null);
  assert.deepEqual(originalStations.map((resource) => ({ id: resource.id, userId: resource.userId, costAliases: resource.costAliases, lowBalanceUsd: resource.lowBalanceUsd, cnyPerUsd: resource.cnyPerUsd, includeInProfit: resource.includeInProfit, noRenewal: resource.noRenewal })), before); assert.equal(model.accounts[1].resources[0].authVersion, 1);
});

test("Sub2API JWT and password switches clear hidden authorization and invalidate the previous preview", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[2]);
  await drawer.getByLabel("更新访问令牌", { exact: true }).fill("old-jwt-input"); await previewAuthorization(drawer); await drawer.getByRole("combobox", { name: "更新授权方式", exact: true }).click(); await page.getByText("Sub2API 邮箱与密码", { exact: true }).last().click(); assert.equal(await drawer.getByRole("button", { name: "确认更新所选授权", exact: true }).isDisabled(), true);
  await drawer.getByLabel("更新登录邮箱", { exact: true }).fill("new@example.test"); await drawer.getByLabel("更新登录密码", { exact: true }).fill("temporary-password"); await previewAuthorization(drawer); assert.equal(probes[1].authorization.accessToken, undefined);
  await drawer.getByRole("combobox", { name: "更新授权方式", exact: true }).click(); await page.getByText("Sub2API 登录令牌", { exact: true }).last().click(); assert.equal(await drawer.getByLabel("更新访问令牌", { exact: true }).inputValue(), ""); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("new-jwt-input"); await previewAuthorization(drawer); assert.deepEqual(probes[2].authorization, { type: "sub2api", baseUrl: "https://same.test", accessToken: "new-jwt-input" }); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); assert.notEqual(probes[0].requestId, probes[2].requestId);
  await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); await center.locator(`[data-account-key="${model.accounts[2].accountKey}"]`).getByRole("button", { name: "更新账号授权 sub2api A", exact: true }).click(); await drawer.getByRole("combobox", { name: "更新授权方式", exact: true }).click(); await page.getByText("Sub2API 邮箱与密码", { exact: true }).last().click(); assert.equal(await drawer.getByLabel("更新登录邮箱", { exact: true }).inputValue(), ""); assert.equal(await drawer.getByLabel("更新登录密码", { exact: true }).inputValue(), ""); await drawer.getByLabel("更新登录邮箱", { exact: true }).fill("final@example.test"); await drawer.getByLabel("更新登录密码", { exact: true }).fill("final-password"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.deepEqual(updates[1].authorization, { type: "sub2api-password", baseUrl: "https://same.test", email: "final@example.test", password: "final-password" });
});

test("partial authorization reload uses readonly recovery before a new saved-donor preview and one confirmation", async (t) => {
  const { page, center, model, probes, updates, recoveries } = await openAuthorizationPage(t, { partial: true }); let drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("partial-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.locator('[data-authorization-target="st_u04_a2"]').getByText("A-monitor-2：更新失败", { exact: true }).waitFor();
  await page.reload(); await center.getByRole("button", { name: "恢复上次授权更新", exact: true }).click(); drawer = page.getByRole("dialog", { name: "更新账号授权 · 42", exact: true }); await drawer.getByText("A-monitor-1：已保存，无需重复更新", { exact: true }).waitFor(); assert.equal(probes.length, 1); assert.equal(updates.length, 1); assert.equal(recoveries.length, 1); assert.deepEqual(recoveries[0], { requestId: probes[0].requestId, targetStationIds: probes[0].targetStationIds });
  await drawer.getByRole("button", { name: "重新验证并补未完成", exact: true }).click(); await drawer.getByText("授权更新预览，尚未保存", { exact: true }).waitFor(); assert.equal(probes[1].reuseSavedAuthorization, true); assert.equal(probes[1].authorization, undefined); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a1").authVersion, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a2").authVersion, 2);
});

test("authorization response loss reads saved outcomes without submitting the update again", async (t) => {
  const { page, center, model, updates, recoveries } = await openAuthorizationPage(t, { loseResponse: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("response-loss-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByText("A-billing：已保存，无需重复更新", { exact: true }).waitFor(); assert.equal(updates.length, 1); assert.equal(recoveries.length, 1); assert.equal(await page.evaluate(() => sessionStorage.getItem("account-authorization-recovery-v05")), null);
});

test("an invalid saved donor starts a new authorization operation for only unfinished targets", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t, { partial: true, invalidDonor: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("initial-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByRole("button", { name: "重新验证并补未完成", exact: true }).click(); await drawer.getByText(/请重新输入授权，已开始新的更新操作/).waitFor(); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("replacement-pat"); await previewAuthorization(drawer); assert.notEqual(probes[2].requestId, probes[0].requestId); assert.deepEqual(probes[2].targetStationIds, ["st_u04_a2"]); await drawer.getByText(/已确认更新，本次不再改写：.*A-monitor-1/).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2); assert.equal(model.accounts[0].resources.find((resource) => resource.id === "st_u04_a1").authVersion, 2);
});

test("unknown authorization targets are opt-in and exclusions never count as updated resources", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); const unknown = drawer.getByRole("checkbox", { name: "更新目标 unknown-legacy", exact: true }); assert.equal(await unknown.isChecked(), false); await unknown.check(); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("checked-pat"); await previewAuthorization(drawer); assert.equal(probes[0].targetStationIds.includes("st_u04_unknown"), true); await drawer.getByText("排除 unknown-legacy：账号身份未核验，已排除", { exact: true }).waitFor(); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1); await drawer.getByText("部分目标尚未更新，已保存目标保留", { exact: true }).waitFor(); await drawer.locator('[data-authorization-target="st_u04_unknown"]').getByText("unknown-legacy：更新失败", { exact: true }).waitFor(); assert.equal(await drawer.getByText("本次所选目标已完成授权更新", { exact: true }).count(), 0);
  await drawer.getByRole("button", { name: "重新输入授权，开始新的更新", exact: true }).click(); assert.equal(await drawer.getByRole("checkbox", { name: "更新目标 A-monitor-1", exact: true }).isChecked(), false); assert.equal(await drawer.getByRole("checkbox", { name: "更新目标 A-monitor-2", exact: true }).isChecked(), false); assert.equal(await drawer.getByRole("checkbox", { name: "更新目标 A-billing", exact: true }).isChecked(), false); assert.equal(await unknown.isChecked(), false); assert.equal(updates.length, 1);
});

test("authorization from same-site account B cannot update account A and requires a fresh valid preview", async (t) => {
  const { page, center, model, updates } = await openAuthorizationPage(t); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("account-B"); await drawer.getByRole("button", { name: "预览授权更新", exact: true }).click(); await drawer.getByText("替换授权属于另一个账号，请另行接入", { exact: true }).waitFor(); assert.equal(await drawer.getByRole("button", { name: "确认更新所选授权", exact: true }).isDisabled(), true); assert.equal(updates.length, 0); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("correct-account-A"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 1);
});

test("authorization with no saved donor requests fresh input and a new operation without a preview bypass", async (t) => {
  const { page, center, model, probes, updates } = await openAuthorizationPage(t, { noDonor: true }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("failed-pat"); await previewAuthorization(drawer); await confirmAccountAuthorization(drawer); await drawer.getByRole("button", { name: "重新验证并补未完成", exact: true }).click(); await drawer.getByText(/尚无已确认更新的授权可复用/).waitFor(); assert.equal(updates.length, 1); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("fresh-pat"); await previewAuthorization(drawer); assert.notEqual(probes[2].requestId, probes[0].requestId); assert.equal(probes[2].targetStationIds.length, 3); await confirmAccountAuthorization(drawer); assert.equal(updates.length, 2);
});

test("pause and re-enable retain complete resource settings while stopping one Key leaves other monitors and history intact", async (t) => {
  const { page, center, model, mutations, originalStations } = await openAuthorizationPage(t); let a = await expandAccount(center, model.accounts[0]); const resource = () => a.locator('[data-resource-id="st_u04_a1"]'); await resource().getByRole("button", { name: "暂停监控 A-monitor-1", exact: true }).click(); let modal = page.getByRole("dialog", { name: "暂停「A-monitor-1」监控？", exact: true }); await modal.getByText(/Key 账单核算继续/).waitFor(); await modal.getByRole("button", { name: "确认用途操作", exact: true }).click(); await modal.waitFor({ state: "hidden" }); await page.reload(); await center.getByText(/显示 3\/3/).waitFor(); a = await expandAccount(center, model.accounts[0]); await resource().getByText("监控暂停 / 未启用", { exact: true }).waitFor(); assert.equal(await page.locator(".resource-list-card").getByText("A-monitor-1", { exact: true }).count(), 0);
  await resource().getByRole("button", { name: "查看原资源设置 A-monitor-1", exact: true }).click(); const editor = page.getByRole("dialog", { name: "编辑上游资源", exact: true }); assert.equal(await editor.getByLabel("用户 ID（New-Api-User）", { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("成本渠道匹配别名", { exact: true }).inputValue(), "kept_alias"); await editor.getByRole("button", { name: /取\s*消/ }).click();
  await resource().getByRole("button", { name: "启用监控 A-monitor-1", exact: true }).click(); modal = page.getByRole("dialog", { name: "启用「A-monitor-1」监控？", exact: true }); await modal.getByText("现有成本设置：不纳入", { exact: true }).waitFor(); await modal.getByRole("button", { name: "确认用途操作", exact: true }).click(); await modal.waitFor({ state: "hidden" }); await resource().getByText("余额监控", { exact: true }).waitFor(); assert.equal(originalStations.find((entry) => entry.id === "st_u04_a1").includeInProfit, false);
  await a.getByRole("button", { name: /Key 9 · #9/ }).click(); await a.getByRole("button", { name: "停止 Key 9 的账单核算", exact: true }).click(); modal = page.getByRole("dialog", { name: "停止此 Key 的账单核算？", exact: true }); await modal.getByText(/Channel 1 #1.*st_u04_own/).waitFor(); await modal.getByRole("button", { name: "确认用途操作", exact: true }).click(); await modal.waitFor({ state: "hidden" }); await a.getByText("有效规则：无", { exact: true }).first().waitFor(); assert.equal(await a.getByRole("button", { name: "停止 Key 9 的账单核算", exact: true }).count(), 0); assert.deepEqual(mutations.map(({ method, path }) => [method, path]), [["PUT", "/api/stations/st_u04_a1"], ["PUT", "/api/stations/st_u04_a1"], ["DELETE", "/api/reconciliation/rules/rule_u04"]]); assert.equal(model.accounts[0].resources.find((entry) => entry.id === "st_u04_a2").monitorEnabled, true); assert.equal(model.accounts[0].keys[0].ruleIds.includes("rule_history"), true); assert.equal(await center.getByRole("button", { name: /暂停监控 st_u04_own/ }).count(), 0);
});

test("authorization target changes invalidate preview and keyboard cancellation works at 320/390/768/1440 without overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, center, model, updates } = await openAuthorizationPage(t, { viewport: { width, height: 900 } }); const drawer = await openAccountAuthorization(page, center, model.accounts[0]); await drawer.getByLabel("更新访问令牌", { exact: true }).fill("width-pat"); await previewAuthorization(drawer); const target = drawer.getByRole("checkbox", { name: "更新目标 A-monitor-2", exact: true }); await target.focus(); await page.keyboard.press("Space"); assert.equal(await drawer.getByRole("button", { name: "确认更新所选授权", exact: true }).isDisabled(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `authorization overflow at ${width}`); await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" }); assert.equal(updates.length, 0);
  }
});

test("account center preserves mixed accounts, original resource IDs, dedicated purpose and independent pure Keys", async (t) => {
  const { page, center, model, mutations } = await openAccountsPage(t);
  assert.equal(await center.locator("[data-site-key]").count(), 2); const a = await expandAccount(center, model.accounts[0]), b = await expandAccount(center, model.accounts[1]), sub = await expandAccount(center, model.accounts[2]);
  assert.equal(await a.locator("[data-resource-id]").count(), 3); assert.equal(await b.locator("[data-resource-id='B-monitor']").count(), 1); assert.equal(await sub.locator("[data-resource-id]").count(), 2);
  const dedicated = a.locator("[data-resource-id='A-billing']"); await dedicated.getByText("监控暂停 / 未启用", { exact: true }).waitFor(); await dedicated.getByRole("button", { name: "查看原资源设置 A-billing", exact: true }).waitFor(); assert.equal(await page.locator(".resource-list-card").getByText("A-billing", { exact: true }).count(), 0); await a.getByText(/提醒阈值：\$27.00；折算汇率：0.7 RMB\/USD；成本设置：不纳入；不再续费/).waitFor();
  assert.equal(await a.locator("[data-resource-id='pure-key']").count(), 0); await center.locator("[data-unverified-resource-id='pure-key']").getByText("关联本站渠道：Channel 1 #1", { exact: true }).waitFor(); await center.locator("[data-unverified-resource-id='unknown-legacy']").getByText("账号身份待核验", { exact: true }).waitFor(); assert.equal(await center.locator("[data-resource-id='own']").count(), 0);
  await a.getByRole("button", { name: /Key 9 · #9/ }).click(); await a.getByText("Channel 3 · #3", { exact: true }).waitFor(); await a.getByText("当前范围版本：3 · 用途范围待确认", { exact: true }).waitFor(); await a.getByRole("button", { name: /Key 10 · #10/ }).click(); await a.getByText("历史范围版本：3 · 用途范围待确认", { exact: true }).waitFor(); await a.getByText("有效规则：无", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看归档资源", exact: true }).click(); await a.locator("[data-resource-id='A-archived']").waitFor(); await page.getByText("自营", { exact: true }).waitFor(); assert.doesNotMatch(await center.innerText(), /余额合计|总余额|\$30\.00/); assert.equal(await center.getByRole("link").count(), 0); assert.equal(mutations.length, 0);
});

test("account search and attention filters preserve relationships and open only the original complete editor object", async (t) => {
  const { page, center, model, mutations } = await openAccountsPage(t); await center.getByRole("textbox", { name: "搜索账号关系" }).fill("A-monitor-1"); await center.getByText(/显示 1\/3 个已核验账号/).waitFor(); const a = await expandAccount(center, model.accounts[0]);
  await a.getByRole("button", { name: "查看原资源设置 A-monitor-1", exact: true }).click(); const editor = page.getByRole("dialog", { name: "编辑上游资源", exact: true }); await editor.waitFor(); assert.equal(await editor.getByLabel("用户 ID（New-Api-User）", { exact: true }).inputValue(), "operator-A"); assert.equal(await editor.getByLabel("成本渠道匹配别名", { exact: true }).inputValue(), "kept_alias"); await editor.getByRole("button", { name: /取\s*消/ }).click(); await editor.waitFor({ state: "hidden" });
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill("Sub-password"); const sub = await expandAccount(center, model.accounts[2]); await sub.getByRole("button", { name: "查看原资源设置 Sub-password", exact: true }).click(); await editor.waitFor(); assert.equal(await editor.getByLabel("登录邮箱", { exact: true }).inputValue(), "saved-sub@example.test"); await editor.getByRole("button", { name: /取\s*消/ }).click(); await editor.waitFor({ state: "hidden" });
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill("Key 10"); await expandAccount(center, model.accounts[0]); await a.getByRole("button", { name: /Key 10 · #10/ }).click(); await a.getByText("Channel 2 · #2", { exact: true }).waitFor(); assert.equal(await a.locator("[data-resource-id]").count(), 3);
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill(""); await center.getByRole("combobox", { name: "账号关系状态" }).click(); await page.getByText("需处理", { exact: true }).last().click(); await center.getByText(/显示 1\/3 个已核验账号/).waitFor(); assert.equal(await center.getByRole("button", { name: /账号 B / }).count(), 0);
  await center.getByRole("textbox", { name: "搜索账号关系" }).fill("pure-key"); await center.getByText(/显示 0\/3 个已核验账号；待核验资源 1\/2/).waitFor(); await center.locator("[data-unverified-resource-id='pure-key']").waitFor(); assert.equal(mutations.length, 0);
});

test("conflicting active Key scopes remain unknown and never expose one selected scope as unified", async (t) => {
  const model = accountReadFixture(), key = model.accounts[0].keys[0]; Object.assign(key, { activeRuleIds: ["A-active", "A-conflict"], ruleIds: ["A-active", "A-conflict", "A-history"], scopeAmbiguous: true, costCoverage: "unknown", coverageDeclaration: { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] }, scopeVersion: null, billingEffectiveFromMs: null, firstQueryableAtMs: null }); key.channels.push({ ownSource: null, ownStationId: "old-own", channelId: 1, name: "Legacy channel 1" });
  const { center } = await openAccountsPage(t, { model }); const a = await expandAccount(center, model.accounts[0]); await a.getByRole("button", { name: /Key 9 · #9/ }).click(); const scope = a.locator(`[data-canonical-key="${key.canonicalKey}"]`); await scope.getByText("存在多个有效规则，范围待核对", { exact: true }).waitFor(); await scope.getByText("来源待核验 · old-own", { exact: true }).waitFor(); assert.doesNotMatch(await scope.innerText(), /当前范围版本|生效边界|2026-10/); assert.match(await scope.innerText(), /A-active、A-conflict/);
});

test("account read failure retains the last public relationships and retry restores the center", async (t) => {
  const { center, accountRequests, mutations } = await openAccountsPage(t, { accounts(route, count, model) { return count === 2 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "账号关系暂不可用" }) }) : fulfill(route, model); } });
  await center.getByRole("button", { name: "刷新账号关系", exact: true }).click(); await center.getByText("账号关系刷新失败，正在显示上次结果", { exact: true }).waitFor(); await center.getByRole("button", { name: /账号 B / }).waitFor(); await center.getByRole("button", { name: "重试账号关系", exact: true }).click(); await center.getByText("账号关系刷新失败，正在显示上次结果", { exact: true }).waitFor({ state: "hidden" }); assert.deepEqual(accountRequests, ["GET", "GET", "GET"]); assert.equal(mutations.length, 0);
});

test("an initial account read failure offers a working retry without affecting original monitoring resources", async (t) => {
  const { page, center, accountRequests } = await openAccountsPage(t, { initialFailure: true, accounts(route, count, model) { return count === 1 ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "账号关系暂不可用" }) }) : fulfill(route, model); } });
  await page.getByText("自营", { exact: true }).waitFor(); await center.getByRole("button", { name: "重试账号关系", exact: true }).click(); await center.getByText(/显示 3\/3 个已核验账号/).waitFor(); assert.deepEqual(accountRequests, ["GET", "GET"]);
});

test("account and Key expansion works by keyboard across 320/390/768/1440 widths without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, center, model } = await openAccountsPage(t, { viewport: { width, height: 900 } }); const site = center.locator(`[data-site-key="${model.accounts[0].siteKey}"]`), accountButton = site.getByRole("button", { name: /账号 A / }); await accountButton.focus(); await page.keyboard.press("Enter"); const a = center.locator(`[data-account-key="${model.accounts[0].accountKey}"]`); await a.waitFor(); const keyButton = a.getByRole("button", { name: /Key 9 · #9/ }); await keyButton.focus(); await page.keyboard.press("Enter"); await a.getByText("Channel 3 · #3", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `account center overflow at ${width}`); await keyButton.focus(); await page.keyboard.press("Enter"); await a.getByText("Channel 3 · #3", { exact: true }).waitFor({ state: "hidden" });
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
  const archived = { ...current.rule, id: "old-rule", tokenName: "new-name", enabled: false, archivedAt: "2026-10-09T00:00:00Z" }, reads = [], historyReads = [], queries = [], writes = [];
  const records = options.records || [confirmedHistoryRecord()];
  const page = await openFixturePage(t, async (route) => {
    const request = route.request(), url = new URL(request.url()); reads.push({ path: url.pathname, method: request.method(), params: Object.fromEntries(url.searchParams) });
    if (url.pathname === "/api/auth/me") return fulfill(route, { username: "fixture" });
    if (url.pathname === "/api/reconciliation/configuration") return fulfill(route, { ...configuration, ownStation: current.rule.archivedAt && options.removeOwnAfterStop ? null : { ...configuration.ownStation, cnyPerUsd: options.rate || null }, rules: [current.rule, archived].filter((rule) => !rule.archivedAt || url.searchParams.get("includeArchived") === "true") });
    if (url.pathname === "/api/reconciliation" || url.pathname === "/api/reconciliation/query") { if (request.method() === "POST") { const body = request.postDataJSON(); queries.push(body); assert.ok(!body.ruleIds?.some((id) => id === archived.id || current.rule.archivedAt && id === current.rule.id)); } return fulfill(route, response(current.rule.archivedAt ? [] : [current])); }
    if (url.pathname.endsWith("/segments")) return fulfill(route, { segments: current.transitionSegments || [] });
    if (url.pathname.endsWith("/confirmed")) { assert.equal(request.method(), "GET"); historyReads.push({ ruleId: url.pathname.split("/").at(-2), params: Object.fromEntries(url.searchParams) }); return options.history ? options.history(route, historyReads.at(-1), historyReads.length) : fulfill(route, { ruleId: historyReads.at(-1).ruleId, readOnly: true, records, nextCursor: null }); }
    if (request.method() === "DELETE" && url.pathname === "/api/reconciliation/rules/rule-1") { writes.push(url.pathname); current.rule.enabled = false; current.rule.archivedAt = "2026-10-09T00:00:00Z"; return fulfill(route, { ruleId: "rule-1", tokenName: "Rule A", fixedGroup: "default", releasedChannelCount: 1 }); }
    throw new Error("unexpected confirmed history fixture API: " + url.pathname);
  }, options.viewport);
  const badge = page.getByRole("button", { name: "Collapse issues badge", exact: true }); if (await badge.isVisible()) await badge.click();
  return { page, reads, historyReads, queries, writes, records };
}
async function chooseConfirmedHistoryRule(page, drawer, label = "Rule A · 当前规则 · rule-1") { await drawer.getByRole("combobox", { name: "历史账单规则", exact: true }).click(); await page.getByText(label, { exact: true }).last().click(); }
async function expandConfirmedRecord(drawer, record, compact = false) { const button = compact ? drawer.getByRole("button", { name: new RegExp((record.upstreamSource.tokenName ?? "原 Key 名称未保存") + " · 原范围") }).first() : drawer.locator("tr.ant-table-row", { hasText: record.upstreamSource.tokenName || "原 Key 名称未保存" }).first(); await button.focus(); await drawer.page().keyboard.press("Enter"); return drawer.locator(`[data-history-id="${record.historyId}"]`); }

test("confirmed history preserves Oct8 original scope, sources and members independently of current channel 9 and group history", async (t) => {
  const { page, reads, historyReads, records } = await openConfirmedHistoryPage(t, { groupHistory: true }); const summary = page.locator(".reconciliation-summary"), before = await summary.innerText(); const row = page.locator("tr.ant-table-row", { hasText: "Rule A" }).first(); await row.focus(); await page.keyboard.press("Enter"); await page.getByText("分组与倍率历史 · 2 段", { exact: true }).waitFor(); await row.getByRole("button", { name: "查看 Rule A 的对账详情", exact: true }).click(); const detail = page.getByRole("dialog", { name: "Rule A · 对账详情", exact: true }); await detail.getByText("New channel 9 · ID 9", { exact: false }).first().waitFor(); await detail.getByRole("button", { name: "查看已确认账单历史", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "已确认账单历史", exact: true }); const record = await expandConfirmedRecord(drawer, records[0]); await record.getByText("old-1 · ID 1、old-2 · ID 2、old-3 · ID 3", { exact: true }).waitFor(); await record.getByText("newapi · https://old-up.test · 账号 7", { exact: true }).waitFor(); await record.getByText(/old-own-namespace/).waitFor(); await record.getByText("old-name · #9 · 范围版本 1", { exact: true }).waitFor(); assert.doesNotMatch(await record.innerText(), /New channel 9|new-name|范围版本 2/); assert.equal(await summary.innerText(), before); assert.deepEqual(historyReads[0], { ruleId: "rule-1", params: { limit: "20" } }); assert.ok(reads.some((read) => read.params.includeArchived === "true")); assert.ok(historyReads.every((read) => read.params.limit === "20"));
});

test("confirmed history remains discoverable after stopping and reload even without an own station", async (t) => {
  const { page, reads, historyReads, writes } = await openConfirmedHistoryPage(t, { removeOwnAfterStop: true }); await page.getByRole("button", { name: "操作 Rule A 的规则", exact: true }).click(); await page.getByText("停止并释放", { exact: true }).last().click(); const stop = page.getByRole("dialog", { name: "停止并释放此对账规则？", exact: true }); await stop.getByRole("button", { name: "停止并释放", exact: true }).click(); await stop.waitFor({ state: "hidden" }); await page.reload(); await page.getByText("还不能开始对账", { exact: true }).waitFor(); await page.getByRole("button", { name: "查看已确认账单历史", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "已确认账单历史", exact: true }); await chooseConfirmedHistoryRule(page, drawer, "Rule A · 已停止 / 归档 · rule-1"); await drawer.getByText("已读取 1 条原确认记录 · 仅 USD 原账，不使用当前汇率换算。", { exact: true }).waitFor(); assert.deepEqual(writes, ["/api/reconciliation/rules/rule-1"]); assert.equal(historyReads.length, 1); assert.ok(reads.some((read) => read.params.includeArchived === "true")); assert.ok(reads.filter((read) => read.path.endsWith("/confirmed")).every((read) => read.method === "GET"));
});

test("confirmed history keeps zero and negative original profit and labels incomplete legacy evidence without filling current identity", async (t) => {
  const zero = confirmedHistoryRecord("zero", 0), negative = confirmedHistoryRecord("negative", -1), legacy = confirmedHistoryRecord("legacy"); zero.upstreamSource.tokenName = "old-zero"; negative.upstreamSource.tokenName = "old-negative"; Object.assign(legacy, { ownSource: null, scopeVersion: null, scopeFingerprint: null, billingEffectiveFromMs: null, sourceCompleteness: "legacy_partial" }); legacy.window.timezone = null; legacy.upstreamSource = { provider: null, baseUrl: null, accountId: null, tokenId: null, tokenName: null };
  const { page } = await openConfirmedHistoryPage(t, { records: [zero, negative, legacy], rate: 7 }); await page.getByRole("button", { name: "查看已确认账单历史", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "已确认账单历史", exact: true }); await chooseConfirmedHistoryRule(page, drawer); await drawer.locator("tr.ant-table-row", { hasText: "old-zero" }).getByText("$0.00", { exact: true }).waitFor(); await drawer.locator("tr.ant-table-row", { hasText: "old-negative" }).getByText("-$1.00", { exact: true }).waitFor(); const record = await expandConfirmedRecord(drawer, legacy); await record.getByText("旧记录信息不完整", { exact: true }).waitFor(); await record.getByText("原本站来源未保存", { exact: true }).waitFor(); await record.getByText(/原时区未保存/).waitFor(); await record.getByText("原平台未保存 · 原地址未保存 · 账号 未保存", { exact: true }).waitFor(); assert.doesNotMatch(await record.innerText(), /Fixture upstream|upstream-1|New channel 9|¥/);
});

test("confirmed history pagination failure retains read records and retry reuses the opaque cursor without duplicate history", async (t) => {
  const first = confirmedHistoryRecord(), second = confirmedHistoryRecord("saved-negative", -1), cursor = Buffer.from(JSON.stringify([first.window.endMs, "2026-10-08 16:01:01", "old-bill-z"])).toString("base64url"); let failed = false;
  const { page, historyReads } = await openConfirmedHistoryPage(t, { history(route, read) { if (read.params.cursor && !failed) { failed = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "HISTORY_UNAVAILABLE", error: "确认账单历史暂不可用", retryable: true }) }); } return fulfill(route, { ruleId: read.ruleId, readOnly: true, records: read.params.cursor ? [second] : [first], nextCursor: read.params.cursor ? null : cursor }); } }); await page.getByRole("button", { name: "查看已确认账单历史", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "已确认账单历史", exact: true }); await chooseConfirmedHistoryRule(page, drawer); await drawer.getByRole("button", { name: "读取更多原确认账单", exact: true }).click(); await drawer.getByText("确认账单历史读取失败", { exact: true }).waitFor(); assert.equal(await drawer.locator("tr.ant-table-row").count(), 1); await drawer.getByRole("button", { name: "重试确认账单历史", exact: true }).click(); await drawer.getByText("已读取 2 条原确认记录 · 仅 USD 原账，不使用当前汇率换算。", { exact: true }).waitFor(); assert.deepEqual(historyReads[1], historyReads[2]); assert.equal(historyReads[2].params.cursor, cursor); assert.equal(await drawer.getByRole("button", { name: "读取更多原确认账单", exact: true }).count(), 0);
});

test("confirmed history rule changes ignore a late response from the previous rule", async (t) => {
  let deferred, ready; const started = new Promise((resolve) => { ready = resolve; }); const original = confirmedHistoryRecord(), other = confirmedHistoryRecord("other-rule"); other.upstreamSource.tokenName = "saved-other-rule";
  const { page } = await openConfirmedHistoryPage(t, { history(route, read) { if (read.ruleId === "rule-1") return new Promise((resolve) => { deferred = { route, resolve }; ready(); }); return fulfill(route, { ruleId: read.ruleId, readOnly: true, records: [other], nextCursor: null }); } }); await page.getByRole("button", { name: "查看已确认账单历史", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "已确认账单历史", exact: true }); await chooseConfirmedHistoryRule(page, drawer); await started; await chooseConfirmedHistoryRule(page, drawer, "new-name · 已停止 / 归档 · old-rule"); await drawer.locator("tr.ant-table-row", { hasText: "saved-other-rule" }).waitFor(); deferred.resolve(fulfill(deferred.route, { ruleId: "rule-1", readOnly: true, records: [original], nextCursor: null })); await page.waitForResponse((response) => response.url().includes("/rule-1/confirmed")); assert.equal(await drawer.locator("tr.ant-table-row", { hasText: "old-name" }).count(), 0);
});

test("confirmed history selector and record expansion support keyboard at 320/390/768/1440 without root overflow", async (t) => {
  for (const width of [320, 390, 768, 1440]) {
    const { page, records } = await openConfirmedHistoryPage(t, { viewport: { width, height: 900 } }); const entry = page.getByRole("button", { name: "查看已确认账单历史", exact: true }); await entry.focus(); await page.keyboard.press("Enter"); const drawer = page.getByRole("dialog", { name: "已确认账单历史", exact: true }), select = drawer.getByRole("combobox", { name: "历史账单规则", exact: true }); await drawer.waitFor(); await page.waitForFunction(() => !document.querySelector(".ant-drawer-open .ant-drawer-content-wrapper")?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")); await select.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await drawer.getByText("已读取 1 条原确认记录 · 仅 USD 原账，不使用当前汇率换算。", { exact: true }).waitFor(); const record = await expandConfirmedRecord(drawer, records[0], width < 768); await record.getByText("old-name · #9 · 范围版本 1", { exact: true }).waitFor(); await page.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `confirmed history overflow at ${width}`); if (width < 768) assert.equal(await drawer.locator(".ant-drawer-body").evaluate((element) => element.scrollWidth <= element.clientWidth), true, `confirmed history drawer overflow at ${width}`); await drawer.locator(".ant-drawer-close").focus(); await page.keyboard.press("Enter"); await drawer.waitFor({ state: "hidden" });
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
  await rowA.getByRole("button", { name: /重试.*Rule A/ }).click();
  await rowB.getByRole("button", { name: /重试.*Rule B/ }).click();
  await retryAStarted;
  await retryBStarted;
  deferred.get("rule-1").resolve(fulfill(deferred.get("rule-1").route, cachedResponse(initial, [rule("rule-1", "Rule A", 101)])));
  await page.locator("tr", { hasText: "$101.00" }).waitFor();
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, cachedResponse(initial, [rule("rule-2", "Rule B", 41)])));
  await page.locator("tr", { hasText: "$41.00" }).waitFor();
});

test("a same-preset refresh marks old totals as reference until its replacement arrives", async (t) => {
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
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await queryStarted;
  await page.getByText("全量摘要仅供参考，正在核对当前窗口", { exact: true }).waitFor();
  await page.locator("tr", { hasText: "$10.00" }).waitFor();
  await summary.getByText("$60.00", { exact: true }).waitFor({ state: "hidden" });
  deferred.resolve(fulfill(deferred.route, response([rule("rule-1", "Rule A", 11), rule("rule-2", "Rule B", 21), rule("rule-3", "Rule C", 31)])));
  await page.getByText("全量摘要仅供参考，正在核对当前窗口", { exact: true }).waitFor({ state: "hidden" });
  await summary.getByText("$63.00", { exact: true }).waitFor();
  await page.locator("tr", { hasText: "$11.00" }).waitFor();
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
  await page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: /重试.*Rule A/ }).click();
  await page.locator("tr", { hasText: "Rule B" }).getByRole("button", { name: /重试.*Rule B/ }).click();
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
  const retryAButton = rowA.getByRole("button", { name: /重试.*Rule A/ });
  const retryBButton = rowB.getByRole("button", { name: /重试.*Rule B/ });
  await retryAButton.click();
  await retryBButton.click();
  await Promise.all([readyA, readyB]);
  deferred.get("rule-2").resolve(fulfill(deferred.get("rule-2").route, cachedResponse(initial, [rule("rule-2", "Rule B", 43)])));
  await rowB.getByText("$43.00", { exact: true }).waitFor();
  await retryBButton.locator(".ant-btn-loading-icon").waitFor({ state: "hidden" });
  deferred.get("rule-1").resolve(deferred.get("rule-1").route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture retry failure" }) }));
  await rowA.getByText("fixture retry failure", { exact: true }).waitFor();
  await rowB.getByText("$43.00", { exact: true }).waitFor();
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
  const retryAButton = page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: /重试.*Rule A/ });
  await retryAButton.click();
  await oldRetryStarted;
  await page.getByText("近 7 天", { exact: true }).click();
  await page.locator(".reconciliation-query-action").first().click();
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
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await bulkStarted;
  await page.locator("tr", { hasText: "Rule A" }).getByRole("button", { name: /重试.*Rule A/ }).click();
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
  const retryAButton = rowA.getByRole("button", { name: /重试.*Rule A/ });
  const summary = page.locator(".reconciliation-summary");
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
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
  await cardA.getByRole("button", { name: "重试当前规则", exact: true }).click();
  await retryRequestStarted;
  retry.resolve(fulfill(retry.route, cachedResponse(initial, [rule("rule-1", "Rule A", 101)])));
  await cardA.getByText("$101.00").waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前对账窗口" }).click();
  await refreshRequestStarted;
  await cardA.getByText("$101.00").waitFor();
  await page.getByText("全量摘要仅供参考，正在核对当前窗口", { exact: true }).waitFor();
  await summary.getByText("$151.00", { exact: true }).waitFor({ state: "hidden" });
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
