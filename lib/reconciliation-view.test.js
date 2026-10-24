import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  hasReconciliationHistory,
  reconciliationRowFlags,
  filterReconciliationResults,
  formatReconciliationMoney,
  reconciliationBillingText,
  reconciliationCalculationValues,
  summarizeReconciliationWindowGroups,
  deriveKnownChannelCoverage,
  reconciliationSettlement,
  reconciliationRowCurrency,
  reconciliationDisplayCurrency,
  reconciliationRateFactors,
  summarizeUnaccountedUpstream,
  fixedOffProfitStations,
  attributeAuthorizationRules,
  formatReconciliationAmount,
  reconciliationResultActions,
  reconciliationDisplayStatus,
  reconciliationRatioChange,
  reconciliationAccountingStartText,
  reconciliationChannelName,
  reconciliationKeyName,
  reconciliationKeyNamer,
  reconciliationNotCountedText,
  reconciliationChannelTag,
  RECONCILIATION_READING_GRACE_MS,
} from "./reconciliation-view.js";
import { COVERAGE_QUESTION, INCOMPLETE_DAY_TEXT, RECONCILIATION_SETTLE_DELAY_MS, reconciliationChannelStatus, reconciliationIssue } from "./reconciliation-contract.js";

// 固定时刻，不随机器时区和当前日期变：上海 10月9日 13:00。dailyViewRow 的那一天是上海 10月8日。
const NOW = Date.parse("2026-10-09T05:00:00Z");
// 那一天结束已经过了 7 天：读取类问题变成需处理
const LATE = Date.parse("2026-10-20T00:00:00Z");
const DAY_START = Date.parse("2026-10-07T16:00:00Z");
const DAY_END = Date.parse("2026-10-08T16:00:00Z");
const DAY = { startMs: DAY_START, endMs: DAY_END, timezone: "Asia/Shanghai" };
const names = (rows) => rows.map((item) => item.rule.tokenName);

test("微额金额保留可辨认的数值和符号，零金额仍显示零，亏损用真减号", () => {
  assert.equal(formatReconciliationMoney(-0.0001, null), "−$0.0001");
  assert.equal(formatReconciliationMoney(0.001, null), "$0.001");
  assert.equal(formatReconciliationMoney(-0.0001, 7), "−¥0.0007");
  assert.equal(formatReconciliationMoney(0, null), "$0.00");
  assert.equal(formatReconciliationMoney(1234.5, null), "$1,234.50");
  assert.equal(formatReconciliationMoney(null, null), "—");
  const tiny = formatReconciliationMoney(-1e-10, null);
  assert.ok(tiny.startsWith("−$") && tiny !== "−$0.00", `极小的亏损也不显示成零：${tiny}`);
});

// lib/format.js 开头约定「不用科学计数法」，页面上也不该出现英文字母 e（§12.6）
test("极小金额不用科学计数法", () => {
  assert.doesNotMatch(formatReconciliationMoney(-1e-10, null), /e/i);
});

test("收入和成本一格：读全了只写金额，读到一部分写「（没读全）」，旧数据写「这天的数据不完整」", () => {
  assert.equal(INCOMPLETE_DAY_TEXT, "这天的数据不完整");
  // 计算明细里只写美元金额，不再列 quota 算式（§3.6 不说 quota）
  assert.equal(reconciliationBillingText({ state: "complete", quotaUnits: 1, quotaPerUnit: 10000, amountUsd: 0.0001 }), "$0.0001");
  assert.equal(reconciliationBillingText({ state: "complete", amountUsd: 0.0001 }), "$0.0001");
  assert.equal(reconciliationBillingText({ state: "complete", amountUsd: -0.0001996 }), "−$0.0001996");
  assert.equal(reconciliationBillingText({ amountUsd: 0.0001 }), INCOMPLETE_DAY_TEXT, "没有读取状态的旧数据");
  assert.equal(reconciliationBillingText(null), INCOMPLETE_DAY_TEXT);

  assert.equal(reconciliationBillingText({ state: "complete", amountUsd: null }), "—");
  assert.equal(reconciliationBillingText({ state: "complete", amountUsd: 2 }, 7), "¥14.00");
  assert.equal(reconciliationBillingText({ state: "partial", knownAmountUsd: 1.2, amountUsd: null }), "$1.20（没读全）");
  assert.equal(reconciliationBillingText({ state: "partial" }), "没读全");
  assert.equal(reconciliationBillingText({ state: "pending" }), "读取中");
  assert.equal(reconciliationBillingText({ state: "unavailable", amountUsd: null }), "读不到");
  assert.equal(reconciliationBillingText({ state: "unavailable", knownAmountUsd: 0.5 }), "$0.50（没读全）");
  assert.equal(reconciliationBillingText({ state: "bogus", amountUsd: 1 }), INCOMPLETE_DAY_TEXT);
});

test("分段时间线按 ID 合并历史证据与当前窗口账单", () => {
  const history = [
    { id: "old", group: "AWS-Bedrock3", ratio: 2.9 },
    { id: "current", group: "AWS-Bedrock2", ratio: 3 },
  ];
  const calculated = [
    { id: "old", downstream: { amountUsd: 63.23 }, upstream: { amountUsd: 55.61 } },
    { id: "current", downstream: { amountUsd: 12.5 }, upstream: { amountUsd: 10 } },
  ];

  assert.deepEqual(mergeReconciliationSegments(history, calculated), [
    { id: "old", group: "AWS-Bedrock3", ratio: 2.9, downstream: { amountUsd: 63.23 }, upstream: { amountUsd: 55.61 } },
    { id: "current", group: "AWS-Bedrock2", ratio: 3, downstream: { amountUsd: 12.5 }, upstream: { amountUsd: 10 } },
  ]);
});

test("只有真实分组或已知倍率变化才显示可展开历史", () => {
  assert.equal(hasReconciliationHistory([{ group: "AWS-Bedrock3", ratio: 2.9 }]), false);
  assert.equal(hasReconciliationHistory([{ group: null, ratio: null }, { group: undefined, ratio: null }]), false);
  assert.equal(hasReconciliationHistory([{ group: "AWS-Bedrock3", ratio: null }, { group: "AWS-Bedrock3", ratio: 2.9 }]), false);
  assert.equal(hasReconciliationHistory([{ group: "AWS-Bedrock3", ratio: 2.9 }, { group: "AWS-Bedrock3", ratio: 3 }]), true);
  assert.equal(hasReconciliationHistory([{ group: "AWS-Bedrock3", ratio: null }, { group: "AWS-Bedrock2", ratio: 3 }]), true);
});

test("详情刷新后的分段历史覆盖旧生效时间，同时保留当前窗口财务数据", () => {
  const merged = mergeReconciliationSegments(
    [{ id: "current", group: "AWS-Bedrock2", effectiveFrom: 1000 }],
    [{ id: "current", downstream: { amountUsd: 12.5 }, upstream: { amountUsd: 10 } }],
    [{ id: "current", group: "AWS-Bedrock2", effectiveFrom: 1200, timingSource: "operator_confirmed" }]
  );

  assert.deepEqual(merged, [{
    id: "current", group: "AWS-Bedrock2", effectiveFrom: 1200, timingSource: "operator_confirmed",
    downstream: { amountUsd: 12.5 }, upstream: { amountUsd: 10 },
  }]);
});

test("查询失败时仍保留规则绑定的全部销售渠道", () => {
  const configured = [
    { channelId: 10, name: "渠道 A", state: "enabled" },
    { channelId: 11, name: "渠道 B", state: "manual_disabled" },
  ];
  const observed = [{ channelId: 10, name: "渠道 A", amountUsd: 20, share: 1 }];

  assert.deepEqual(mergeReconciliationChannels(configured, observed), [
    { channelId: 10, name: "渠道 A", state: "enabled", amountUsd: 20, share: 1 },
    { channelId: 11, name: "渠道 B", state: "manual_disabled" },
  ]);
});

// 亏损不是需处理（§4）：只标「亏损」、进亏损筛选，利润照常显示。这两条结果没有日期，状态和时钟无关。
test("搜索可按上游、Key、分组和销售渠道过滤；亏损只标「亏损」，不进需处理", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const results = [
    { calculationVersion: 3, requestedWindow: currentWindow, rule: { upstreamStationId: "s1", tokenName: "awsb-3", channels: [{ channelId: 1, name: "小福星-awsb" }] }, currentSegment: { group: "AWS-Bedrock2" }, downstream: { state: "complete", amountUsd: 10, window: currentWindow }, upstream: { state: "complete", amountUsd: 12, window: currentWindow }, health: { code: "READY" }, calculation: { profitUsd: -2 } },
    { rule: { upstreamStationId: "s2", tokenName: "oai", channels: [{ channelId: 2, name: "OpenAI 出口" }] }, currentSegment: { group: "oai" }, health: { code: "READY" }, calculation: { profitUsd: 4 } },
  ];
  const upstreams = [{ id: "s1", name: "小福星" }, { id: "s2", name: "另一上游" }];
  for (const search of ["小福星", "awsb-3", "Bedrock2", "小福星-awsb"]) {
    assert.deepEqual(names(filterReconciliationResults(results, upstreams, search)), ["awsb-3"]);
  }
  assert.deepEqual(names(filterReconciliationResults(results, upstreams, "ID 2")), ["oai"]);
  assert.deepEqual(names(filterReconciliationResults(results, upstreams, "", "negative")), ["awsb-3"]);
  assert.deepEqual(names(filterReconciliationResults(results, upstreams, "", "attention")), [], "亏损不算需处理");
  const flags = reconciliationRowFlags(results[0], "USD", { now: NOW });
  assert.deepEqual([flags.displayStatus.state, flags.negative, flags.attention, flags.tags, flags.severity, flags.values.profit],
    ["live", true, false, ["亏损"], 1, -2]);
});

test("倍率变化的时间是系统估的：只是提示，带「改时间」按钮，不进需处理", () => {
  const stable = { rule: { id: "stable", tokenName: "stable", upstreamStationId: "up" }, health: { code: "READY" }, segments: [{ group: "A", timingSource: "initial" }] };
  const changed = { rule: { id: "changed", tokenName: "changed", upstreamStationId: "up" }, health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, transitionSegments: [], segments: [{ group: "A", timingSource: "initial" }, { group: "B", timingSource: "detected" }] };
  const status = reconciliationDisplayStatus(changed, { now: NOW });
  assert.equal(status.state, "live");
  assert.deepEqual(status.hints.map((hint) => hint.text), ["倍率变化的时间是系统估的"]);
  assert.deepEqual([status.hints[0].action.kind, status.hints[0].action.label, status.hints[0].action.href], ["correct_timing", "改时间", null], "在当前页面上改，不跳转");
  assert.deepEqual(filterReconciliationResults([stable, changed], [], "", "attention"), []);
  assert.deepEqual(reconciliationDisplayStatus(stable, { now: NOW }).hints, []);
});

// 旧用例保护的不变式：没有健康码的结果要人看一眼。现在显示「实时」、利润「—」、没有一句原因，
// 和 §5.5 兜底（认不出就「这条暂时算不出利润」）、§7（「—」要带原因）不一致。
test("没有健康码的结果不显示成实时", () => {
  assert.equal(reconciliationRowFlags({ health: {}, calculation: {} }, "USD", { now: NOW }).attention, true);
});

test("读取类问题 7 天内显示实时加「还在读取」，过了 7 天才变成需处理；提示类问题一直在", () => {
  const item = dailyViewRow("a", 3);
  item.health = { code: "UPSTREAM_DATA_UNAVAILABLE", issues: [{ code: "SEGMENT_TIMING_UNCONFIRMED" }] };
  Object.assign(item.upstream, { state: "unavailable", amountUsd: null, countedAmountUsd: null });
  item.calculation = { profitUsd: null, marginRate: null };
  const target = { accountKey: null, stationId: "up", ruleId: "a", ownStationId: "own", channelIds: [1], window: DAY };
  const timing = { id: `correct_timing::up:a:own:1:${DAY_START}-${DAY_END}`, kind: "correct_timing", label: "改时间",
    title: "倍率变化的时间是系统估的", detail: "", ...target, code: "SEGMENT_TIMING_UNCONFIRMED", href: null };
  const timingHint = { code: "SEGMENT_TIMING_UNCONFIRMED", text: "倍率变化的时间是系统估的", action: timing };
  assert.deepEqual(reconciliationDisplayStatus(item, { now: NOW }), { state: "live", label: "实时", asOf: "数据截至 8:00", note: "还在读取",
    hints: [{ code: "UPSTREAM_DATA_UNAVAILABLE", text: "上游暂时读不到，系统会自动再读", action: null }, timingHint], actions: [] });
  assert.equal(reconciliationSettlement(item, { now: NOW }), "pending");
  assert.deepEqual(reconciliationResultActions(item, { now: NOW }), [], "还在自动重读，不进运营总览");

  const retry = { id: `retry_bill::up:a:own:1:${DAY_START}-${DAY_END}`, kind: "retry_bill", label: "重新读取",
    title: "上游这天的用量记录一直读不到", detail: "", ...target, code: "UPSTREAM_DATA_UNAVAILABLE",
    href: `/reconciliation?action=retry&ruleId=a&startMs=${DAY_START}&endMs=${DAY_END}&timezone=Asia%2FShanghai` };
  assert.deepEqual(reconciliationDisplayStatus(item, { now: LATE }), { state: "action", label: "需处理", title: "上游这天的用量记录一直读不到",
    detail: "", moreCount: 0, action: retry, hints: [timingHint], actions: [retry] });
  const flags = reconciliationRowFlags(item, "USD", { now: LATE });
  assert.deepEqual([flags.attention, flags.severity, flags.values.profit, flags.tags], [true, 0, null, []]);
  assert.equal(reconciliationSettlement(item, { now: LATE }), "unavailable");
});

test("各问题码按 §5 的种类显示：读取类先提示后需处理，提示类不改状态，旧码统一说这天的数据不完整", () => {
  const withCode = (id, code, extra = {}) => {
    const row = dailyViewRow(id, 3);
    row.health = { code, issues: [], ...extra };
    return row;
  };
  const empty = withCode("empty", "UPSTREAM_EMPTY_WITH_SALES");
  assert.deepEqual(reconciliationDisplayStatus(empty, { now: NOW }).hints, [{ code: "UPSTREAM_EMPTY_WITH_SALES", text: "有收入，但上游的用量还没到", action: null }]);
  const emptyLate = reconciliationDisplayStatus(empty, { now: LATE });
  assert.deepEqual([emptyLate.state, emptyLate.title, emptyLate.detail, emptyLate.action.label, emptyLate.action.href],
    ["action", "有收入，但上游一直没有用量记录", "可能绑错了 Key", "改绑定", "/stations?action=scope&ruleId=empty"]);

  // 渠道停用只在渠道名旁标「已停用」，不加提示、不改状态
  const disabled = reconciliationDisplayStatus(withCode("disabled", "SALES_CHANNEL_DISABLED"), { now: NOW });
  assert.deepEqual([disabled.state, disabled.hints], ["live", []]);

  // 以前的数据里还带着的旧码（§5.5）：归读取类，7 天内提示，过了 7 天需处理，都说「这天的数据不完整」
  for (const code of ["STALE", "GROUP_OR_RATIO_CHANGED", "BILLING_WINDOW_UNCONFIRMED", "OWN_FLOW_INCOMPLETE"]) {
    const row = withCode(code, code);
    assert.deepEqual(reconciliationDisplayStatus(row, { now: NOW }).hints, [{ code, text: INCOMPLETE_DAY_TEXT, action: null }], code);
    const late = reconciliationDisplayStatus(row, { now: LATE });
    assert.deepEqual([late.state, late.title, late.action.label], ["action", INCOMPLETE_DAY_TEXT, "重新读取"], code);
  }
  // 服务端只在 STALE 时带 stale（server/reconciliation.js）：利润不算，界面不再单独写「数据过期」（§3.6）
  const stale = withCode("stale", "STALE", { stale: true });
  const staleFlags = reconciliationRowFlags(stale, "USD", { now: NOW });
  assert.deepEqual([staleFlags.values.profit, staleFlags.displayStatus.hints.map((hint) => hint.text)], [null, [INCOMPLETE_DAY_TEXT]]);

  // 倍率变了：知道几点变的就写出时刻，不知道就用不带时刻的那一句
  const route = withCode("route", "ROUTE_TRANSITION_DETECTED");
  assert.deepEqual(reconciliationDisplayStatus(route, { now: NOW }).hints, [{ code: "ROUTE_TRANSITION_DETECTED", text: "倍率变了，这天分两段算", action: null }]);
  route.transitionSegments = [{ id: "s1", effectiveFrom: DAY_START, ratio: 1 }, { id: "s2", effectiveFrom: Date.parse("2026-10-08T06:30:00Z"), ratio: 1.2 }];
  assert.deepEqual(reconciliationDisplayStatus(route, { now: NOW }).hints.map((hint) => hint.text), ["倍率在 14:30 变了，这天分两段算"]);

  // 亏损的同时有读取类问题：7 天内照常标亏损；变成需处理后利润写「—」，不再标亏损（§4）
  const loss = ratedRow("loss", 1, 2);
  loss.health = { code: "UPSTREAM_EMPTY_WITH_SALES", issues: [] };
  const fresh = reconciliationRowFlags(loss, "USD", { now: NOW });
  assert.deepEqual([fresh.displayStatus.state, fresh.negative, fresh.tags], ["live", true, ["亏损"]]);
  const late = reconciliationRowFlags(loss, "USD", { now: LATE });
  assert.deepEqual([late.displayStatus.state, late.values.profit, late.negative, late.tags], ["action", null, false, []]);
});

test("亏损和渠道停用同时显示，不把停用渠道的历史收入归零", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const item = {
    calculationVersion: 3,
    requestedWindow: currentWindow,
    rule: { channels: [{ channelId: 312, name: "小福星-awsb-2.9", state: "manual_disabled" }] },
    downstream: { state: "complete", amountUsd: 0.0001, window: currentWindow, channels: [{ channelId: 312, amountUsd: 0.0001 }] },
    upstream: { state: "complete", amountUsd: 0.0002996, window: currentWindow },
    calculation: { profitUsd: -0.0001996, marginRate: -1.996 },
    health: { code: "SALES_CHANNEL_DISABLED" },
  };
  const flags = reconciliationRowFlags(item, "USD", { now: NOW });
  assert.deepEqual([flags.displayStatus.state, flags.negative, flags.tags, flags.displayStatus.hints], ["live", true, ["亏损"], []]);
  assert.equal(reconciliationChannelTag(item.rule.channels[0]), "已停用");
  assert.equal(formatReconciliationMoney(flags.values.profit), "−$0.0001996");
  assert.equal(mergeReconciliationChannels(item.rule.channels, item.downstream.channels)[0].amountUsd, 0.0001);
});

// 列表排序用每行的 displayStatus（服务端按当时的时刻算好）；这里先按固定时刻算好，免得随今天的日期变。
test("默认列表按需处理、亏损、实时、已固定排序；需处理筛选只留需处理", () => {
  const settled = { ...dailyViewRow("settled", 3), settledAt: "2026-10-08T16:05:00Z" };
  const live = dailyViewRow("live", 3);
  live.health = { code: "SEGMENT_TIMING_UNCONFIRMED", issues: [] };
  const negative = ratedRow("negative", 1, 2);
  const unavailable = dailyViewRow("unavailable", 3);
  unavailable.health = { code: "UPSTREAM_DATA_UNAVAILABLE", issues: [] };
  Object.assign(unavailable.upstream, { state: "unavailable", amountUsd: null, countedAmountUsd: null });
  unavailable.calculation = { profitUsd: null, marginRate: null };
  const denied = dailyViewRow("denied", 3);
  denied.health = { code: "KEY_INVALID_OR_DENIED", issues: [] };
  const results = [settled, live, negative, unavailable, denied];
  for (const row of results) row.displayStatus = reconciliationDisplayStatus(row, { now: LATE });
  // 同一级的保持原来的先后
  assert.deepEqual(names(filterReconciliationResults(results)), ["unavailable", "denied", "negative", "live", "settled"]);
  assert.deepEqual(names(filterReconciliationResults(results, [], "", "attention")), ["unavailable", "denied"]);
  assert.deepEqual(names(filterReconciliationResults(results, [], "", "negative")), ["negative"]);
});

// 旧用例里没有日期的「上游读不到」排在需处理最前。现在没有日期就永远算不到「过了 7 天」，一直是实时。
test("没有日期的结果读不到账单，也不会一直显示成实时", () => {
  const row = { rule: { id: "old", tokenName: "old" }, health: { code: "UPSTREAM_DATA_UNAVAILABLE" } };
  assert.equal(reconciliationRowFlags(row, "USD", { now: LATE }).attention, true);
});

test("归属未知保留raw账单，汇总只计counted成本；旧DTO兼容且不能确认重复利润", () => {
  const window = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const row = { calculationVersion: 3, window, rule: { id: "r1" }, health: { code: "COST_OWNER_UNVERIFIED" },
    upstream: { state: "complete", amountUsd: 1, knownAmountUsd: 1, countedAmountUsd: null, ownershipState: "unknown", window },
    downstream: { state: "complete", amountUsd: 2.5, window }, calculation: { profitUsd: 1.5 } };
  const totals = (rows) => summarizeReconciliationWindowGroups(rows, { coverageFor: () => ({ state: "complete_known" }) }).windowGroups[0].totals;
  const unknown = totals([row]);
  assert.equal(unknown.knownCostUsd, null);
  assert.deepEqual(unknown.attentionRuleIds, ["r1"]);
  assert.equal(unknown.confirmedProfitUsd, null);
  assert.equal(reconciliationBillingText(row.upstream), "$1.00", "真实费用仍可展示依据");
  const duplicates = [row, row].map((item, index) => ({ ...item, rule: { id: `r${index + 1}` }, upstream: { ...item.upstream,
    ownershipState: "duplicate", countedAmountUsd: index === 0 ? 1 : null } }));
  // 归属没确认是需处理：上游成本也不加，原始金额留在它那一行（两条没有共同来源，各成一组，这里看第一组）
  const duplicated = totals(duplicates);
  assert.deepEqual([duplicated.knownCostUsd, duplicated.attentionRuleIds], [null, ["r1"]]);
  assert.equal(duplicated.confirmedProfitUsd, null);
  assert.equal(row.upstream.amountUsd, 1);
  // 旧 DTO 没有 countedAmountUsd：算出来的那条照 amountUsd 加上游成本
  const legacy = { ...row, health: { code: "READY", issues: [] }, billingTimezone: { state: "verified", timezone: window.timezone },
    rule: { id: "r1", costCoverage: "complete", coverageDeclaration: { answer: "none" } }, upstream: { state: "complete", amountUsd: 1, window } };
  assert.deepEqual([totals([legacy]).knownCostUsd, totals([legacy]).confirmedProfitUsd], [1, 1.5]);
});

test("分组读不到只在倍率格写「暂时读不到」，不改状态，已知金额照常显示", () => {
  const item = {
    health: { code: "GROUP_DATA_UNAVAILABLE" },
    downstream: { state: "complete", amountUsd: 0 },
    upstream: { state: "complete", amountUsd: 2 },
  };
  const flags = reconciliationRowFlags(item, "USD", { now: NOW });
  assert.deepEqual([flags.displayStatus.state, flags.attention, flags.displayStatus.hints], ["live", false, []]);
  assert.equal(reconciliationIssue("GROUP_DATA_UNAVAILABLE").ratio, "暂时读不到");
  assert.equal(reconciliationBillingText(item.upstream), "$2.00");
  assert.equal(reconciliationBillingText(item.downstream), "$0.00");
});

test("这次结果没存上：7 天内只是提示，过了 7 天还没存上才需处理", () => {
  const row = dailyViewRow("persist", 3);
  row.health = { code: "PERSISTENCE_FAILED", issues: [] };
  const fresh = reconciliationRowFlags(row, "USD", { now: NOW });
  assert.deepEqual([fresh.attention, fresh.severity, fresh.displayStatus.hints.map((hint) => hint.text)], [false, 2, ["这次结果没存上，系统会再存"]]);
  const late = reconciliationRowFlags(row, "USD", { now: LATE });
  assert.deepEqual([late.attention, late.severity, late.displayStatus.title, late.displayStatus.action.label, late.values.profit],
    [true, 0, "这天的结果一直没存上", "重新读取", null]);
});

test("确认利润仅接受当前 v3 双侧完整同窗结果，风险差额也不混入过期窗口", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const confirmed = {
    calculationVersion: 3,
    health: { code: "READY" },
    requestedWindow: currentWindow,
    downstream: { state: "complete", amountUsd: 10, window: currentWindow },
    upstream: { state: "complete", amountUsd: 12, window: currentWindow },
    calculation: { profitUsd: -2, marginRate: -0.2 },
  };
  const legacy = { ...confirmed, calculationVersion: 2 };

  assert.equal(reconciliationCalculationValues(confirmed.calculation, confirmed.health, confirmed).confirmed, true);
  assert.equal(reconciliationRowFlags(confirmed, "USD", { now: NOW }).negative, true);
  assert.equal(reconciliationCalculationValues(legacy.calculation, legacy.health, legacy).confirmed, false);
  assert.equal(reconciliationRowFlags(legacy, "USD", { now: NOW }).negative, false);
});

function dailyViewRow(id, income, { observedAt = 1, namespaceKey = "own-a" } = {}) {
  const ownSource = { stationId: "own", provider: "newapi", baseUrl: "https://own.test", accountId: "1", namespaceKey };
  const window = { preset: "yesterday", startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z"), timezone: "Asia/Shanghai" };
  return { rule: { id, tokenName: id, ownStationId: "own", upstreamStationId: "up", ownSource, enabled: true, timezone: window.timezone,
    billingPolicy: "next-complete-day", billingEffectiveFrom: window.startMs, costCoverage: "complete", coverageDeclaration: { answer: "none" }, channels: [{ channelId: 1, name: "渠道1" }] },
    ownSource, window, requestedWindow: window, billingTimezone: { state: "verified", timezone: window.timezone },
    amountBasis: { id: "channel-billing-usd-v3", currency: "USD", billingSource: "channel-log-stat", calculationVersion: 3, conversion: "quota_per_unit" },
    calculationVersion: 3, upstream: { state: "complete", amountUsd: 1, countedAmountUsd: 1, ownershipState: "unique", window },
    downstream: { state: "complete", amountUsd: income, window, observedAt, channels: [{ channelId: 1, billingState: "complete", amountUsd: income, knownAmountUsd: income }] },
    calculation: { profitUsd: income - 1, marginRate: (income - 1) / income }, health: { code: "READY", issues: [] }, generatedAt: "2026-10-09T00:00:00Z", actions: [] };
}

test("B1 窗口比较的两个调用点：渠道覆盖按请求比（今天截止点不同也算这段），账单窗口的时区别名算同一个", () => {
  // 覆盖度：请求的是「今天」到 15:00，这条结果截至 13:00，同一预设同一起点就是同一段
  const row = dailyViewRow("live", 3), start = row.window.startMs;
  const today = { preset: "today", startMs: start, endMs: start + 13 * 3600000, timezone: "Asia/Shanghai" };
  Object.assign(row, { window: today, requestedWindow: today });
  row.upstream.window = today; row.downstream.window = today;
  const catalogue = { ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] };
  const coverage = deriveKnownChannelCoverage(catalogue, [row.rule], [row], { window: { ...today, endMs: start + 15 * 3600000 } });
  assert.equal(coverage.channels[0].status, "accounted");
  assert.equal(coverage.channels[0].issues.includes("BILLING_EVIDENCE_NOT_QUERIED"), false);
  // 上游回填的账单窗口写的是 asia/shanghai，请求的是 Asia/Shanghai：照样算对得上，毛利算已核实
  const alias = dailyViewRow("alias", 3);
  alias.upstream.window = { ...alias.window, timezone: "asia/shanghai" };
  alias.downstream.window = { ...alias.window, timezone: "asia/shanghai" };
  assert.equal(reconciliationCalculationValues(alias.calculation, alias.health, alias).confirmed, true);
  alias.downstream.window = { ...alias.window, timezone: "UTC" };
  assert.equal(reconciliationCalculationValues(alias.calculation, alias.health, alias).confirmed, false, "真不同的时区不算");
});

test("汇总只加算出来的绑定：收入、上游成本、毛利同一个范围，需处理的那条不加，旁边说一句", () => {
  const counted = dailyViewRow("a", 3);
  const pending = dailyViewRow("b", 2.5);
  // 体检 §7.3 的样子：这条 Key 的用途没回答，毛利算不出来；原来它的收入、上游成本照样加进汇总，毛利却不加
  Object.assign(pending.rule, { costCoverage: "unknown", coverageDeclaration: { answer: "unknown" } });
  pending.calculation = { profitUsd: null, marginRate: null };
  pending.health = { code: "COST_COVERAGE_UNKNOWN", issues: [{ code: "COST_COVERAGE_UNKNOWN" }] };
  const { windowGroups: [group] } = summarizeReconciliationWindowGroups([counted, pending], { coverageFor: () => ({ state: "partial" }) });
  assert.deepEqual([group.totals.knownIncomeUsd, group.totals.knownCostUsd, group.totals.confirmedProfitUsd], [3, 1, 2]);
  assert.equal(group.totals.knownIncomeUsd - group.totals.knownCostUsd, group.totals.confirmedProfitUsd, "财务一减就对得上");
  assert.deepEqual([group.totals.display.knownIncome, group.totals.display.knownCost, group.totals.display.confirmedProfit], [3, 1, 2]);
  assert.deepEqual(group.totals.attentionRuleIds, ["b"]);
  // 全都需处理：三个数都写「—」
  const { windowGroups: [none] } = summarizeReconciliationWindowGroups([pending], { coverageFor: () => ({ state: "partial" }) });
  assert.deepEqual([none.totals.knownIncomeUsd, none.totals.knownCostUsd, none.totals.confirmedProfitUsd, none.totals.display.knownIncome], [null, null, null, null]);
});

test("读取失败超过 7 天：那一行、旁边那句、渠道都说需处理，渠道的原因和按钮取那一行的", () => {
  const row = dailyViewRow("late", 3);
  Object.assign(row.upstream, { state: "unavailable", amountUsd: null, knownAmountUsd: null, countedAmountUsd: null });
  row.calculation = { profitUsd: null, marginRate: null };
  row.health = { code: "UPSTREAM_DATA_UNAVAILABLE", issues: [{ code: "UPSTREAM_DATA_UNAVAILABLE" }] };
  row.displayStatus = reconciliationDisplayStatus(row, { now: LATE });
  assert.equal(row.displayStatus.state, "action", "前提：过了 7 天，读取类问题变成需处理");
  const catalogue = { ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] };
  const coverage = deriveKnownChannelCoverage(catalogue, [row.rule], [row]);
  const [channel] = coverage.channels;
  assert.deepEqual([channel.status, channel.reason], ["row_attention", row.displayStatus.title]);
  assert.deepEqual(channel.actions.map((action) => action.id), row.displayStatus.actions.map((action) => action.id));
  assert.equal(reconciliationChannelStatus(channel.status, {}, channel.issues).label, "需处理");
  const { windowGroups: [group] } = summarizeReconciliationWindowGroups([row], { coverageFor: () => coverage });
  assert.deepEqual([group.totals.attentionRuleIds, group.totals.readingRuleIds], [["late"], []]);
  // 7 天以内还是读取中：渠道写「还在读取」，旁边那句也说还在读取
  row.displayStatus = reconciliationDisplayStatus(row, { now: NOW });
  assert.equal(deriveKnownChannelCoverage(catalogue, [row.rule], [row]).channels[0].status, "billing_missing");
  assert.deepEqual(summarizeReconciliationWindowGroups([row], { coverageFor: () => coverage }).windowGroups[0].totals.readingRuleIds, ["late"]);
});

test("汇总旁边那句（§4、F2）：几条绑定需处理、几条还在读取没算进来；只有一天时点名是哪天", () => {
  const now = Date.parse("2026-10-24T05:00:00Z");
  const text = (attentionRuleIds, readingRuleIds, window) => reconciliationNotCountedText({ attentionRuleIds, readingRuleIds }, window, now);
  const yesterday = { preset: "yesterday", startMs: Date.parse("2026-10-22T16:00:00Z"), endMs: Date.parse("2026-10-23T16:00:00Z"), timezone: "Asia/Shanghai" };
  assert.equal(text([], [], yesterday), "");
  assert.equal(reconciliationNotCountedText(undefined, yesterday, now), "");
  assert.equal(text(["a"], [], yesterday), "其中 10月23日 有 1 条绑定需处理，没算进来。");
  assert.equal(text([], ["b", "c"], yesterday), "其中 10月23日 有 2 条绑定还在读取，没算进来。");
  assert.equal(text(["a"], ["b", "c"], yesterday), "其中 10月23日 有 1 条绑定需处理、2 条还在读取，没算进来。");
  assert.equal(text(["a", "b", "a"], [], { ...yesterday, preset: "custom" }), "其中 10月23日 有 2 条绑定需处理，没算进来。", "自定义的一整天也点名，同一条只数一次");
  const today = { preset: "today", startMs: Date.parse("2026-10-23T16:00:00Z"), endMs: now, timezone: "Asia/Shanghai" };
  assert.equal(text([], ["b"], today), "其中 10月24日 有 1 条绑定还在读取，没算进来。");
  const week = { preset: "7d", startMs: Date.parse("2026-10-17T16:00:00Z"), endMs: now, timezone: "Asia/Shanghai" };
  assert.equal(text(["a"], ["b", "c"], week), "其中 1 条绑定需处理、2 条还在读取，没算进来。");
  assert.equal(text([], ["b", "c"], week), "其中 2 条绑定还在读取，没算进来。");
  assert.equal(text(["a"], [], { ...yesterday, timezone: undefined }), "其中 1 条绑定需处理，没算进来。", "不知道时区就不点名");
});

test("U05公开view对重复渠道采用同窗最新成功金额，保留raw且搜索/分页不更改全量聚合", () => {
  const rows = [dailyViewRow("older", 2), dailyViewRow("newer", 3, { observedAt: 2 })];
  for (const row of rows) row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT" }] };
  const catalogue = { ownSource: rows[0].ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] };
  const coverage = deriveKnownChannelCoverage(catalogue, rows.map((row) => row.rule), rows);
  const full = summarizeReconciliationWindowGroups(rows, { coverageFor: () => coverage });
  // 同一个渠道绑了两条：两条都是需处理，汇总三个数都不加（原来收入、上游成本照加，毛利是空的）
  assert.deepEqual([full.windowGroups[0].totals.knownIncomeUsd, full.windowGroups[0].totals.knownCostUsd, full.windowGroups[0].totals.confirmedProfitUsd], [null, null, null]);
  assert.deepEqual(full.windowGroups[0].totals.attentionRuleIds, ["older", "newer"]);
  assert.equal(coverage.channels[0].status, "duplicate"); assert.equal(coverage.accountedChannelCount, 0);
  // 同一个渠道绑了两条：按钮是「处理重复」，标题点名渠道，指向第一条绑定
  const [conflict] = coverage.channels[0].actions;
  assert.deepEqual([conflict.kind, conflict.label, conflict.title, conflict.href],
    ["review_conflict", "处理重复", "渠道「渠道1」同时绑了两把 Key", "/stations?action=conflict&ruleId=older"]);
  assert.equal(reconciliationCalculationValues(rows[0].calculation, rows[0].health, rows[0]).confirmed, false);
  const filtered = filterReconciliationResults(rows, [], "older");
  assert.equal(filtered.length, 1); assert.equal(filtered[0].downstream.amountUsd, 2);
  assert.equal(rows[1].downstream.amountUsd, 3); assert.deepEqual(full.windowGroups[0].totals.attentionRuleIds, ["older", "newer"]);
  assert.equal(rows.slice(0, 1).length, 1); assert.equal(full.windowGroups[0].coverage.knownChannelCount, 1);
});

test("U05公开view保留0/负确认毛利，未知时区/实际窗口不匹配阻止确认并保持金额依据", () => {
  const row = dailyViewRow("bill", 1);
  const coverage = { state: "complete_known" };
  const group = () => summarizeReconciliationWindowGroups([row], { coverageFor: () => coverage });
  assert.equal(group().windowGroups[0].totals.confirmedProfitUsd, 0);
  row.calculation.profitUsd = -1; row.upstream.amountUsd = 2; row.upstream.countedAmountUsd = 2;
  assert.equal(group().commonSummary.totals.confirmedProfitUsd, -1);
  row.billingTimezone = { state: "unverified", timezone: row.window.timezone };
  assert.equal(group().commonSummary, null); assert.equal(group().windowGroups[0].totals.confirmedProfitUsd, null);
  assert.equal(reconciliationCalculationValues(row.calculation, row.health, row).confirmed, false);
  assert.equal(reconciliationBillingText(row.upstream), "$2.00");
  row.billingTimezone.state = "verified"; row.upstream.window = { ...row.window, endMs: row.window.endMs - 1000 };
  row.health.issues = [{ code: "BILLING_WINDOW_MISMATCH" }];
  // 窗口对不上是需处理：汇总三个数都不加，金额依据留在这一行
  assert.equal(group().commonSummary, null);
  assert.deepEqual([group().windowGroups[0].totals.knownIncomeUsd, group().windowGroups[0].totals.knownCostUsd, group().windowGroups[0].totals.attentionRuleIds], [null, null, ["bill"]]);
  assert.equal(row.upstream.amountUsd, 2);
});

// 旧的 settlement 字段（接口里保留）由界面状态推出：已固定看有没有固定下来（settledAt），不再看窗口是否整天结束。
test("今天的窗口直接汇总实时毛利；settlement 区分实时、已固定、已结束、读取中和需处理", () => {
  const now = NOW;
  const today = { preset: "today", startMs: Date.parse("2026-10-08T16:00:00Z"), endMs: now, timezone: "Asia/Shanghai" };
  const row = dailyViewRow("live", 3);
  for (const side of [row.upstream, row.downstream]) side.window = today;
  Object.assign(row, { window: today, requestedWindow: today });
  const coverage = { state: "complete_known" };
  const grouped = summarizeReconciliationWindowGroups([row], { coverageFor: () => coverage });
  assert.equal(grouped.windowGroups[0].totals.confirmedProfitUsd, 2);
  assert.equal(grouped.windowGroups[0].totals.profitComplete, true);
  assert.equal(grouped.commonSummary.totals.confirmedProfitUsd, 2);
  assert.equal(reconciliationCalculationValues(row.calculation, row.health, row).confirmed, true);
  assert.equal(reconciliationSettlement(row, { now }), "live", "截至当前时刻的窗口仍是实时");
  assert.equal(reconciliationSettlement({ ...dailyViewRow("settled", 3), settledAt: "2026-10-08T16:05:00Z" }, { now }), "settled");
  assert.equal(reconciliationSettlement(dailyViewRow("ended", 3), { now }), "ended", "结束了但还没固定下来");
  // 刚结束不到 15 分钟还算实时，上游账单还在陆续入账
  assert.equal(reconciliationSettlement(dailyViewRow("just", 3), { now: DAY_END + 10 * 60000 }), "live");
  assert.equal(reconciliationSettlement(dailyViewRow("just", 3), { now: DAY_END + RECONCILIATION_SETTLE_DELAY_MS }), "ended");
  const partial = dailyViewRow("partial", 3), past = { ...today, preset: "custom", startMs: today.startMs - 86400000 + 3600000, endMs: today.startMs - 3600000 };
  for (const side of [partial.upstream, partial.downstream]) side.window = past;
  Object.assign(partial, { window: past, requestedWindow: past });
  assert.equal(reconciliationSettlement(partial, { now }), "ended", "早已结束的非整日窗口不固定，也不再是实时");
  const waiting = { ...dailyViewRow("waiting", 3), calculation: { profitUsd: null, riskDifferenceUsd: 2 }, health: { code: "WAITING_FOR_BILL", issues: [] } };
  assert.equal(reconciliationSettlement(waiting, { now }), "pending");
  const broken = { ...dailyViewRow("broken", 3), calculation: { profitUsd: null }, health: { code: "KEY_INVALID_OR_DENIED", issues: [] } };
  assert.equal(reconciliationSettlement(broken, { now }), "unavailable");
  const legacyDuplicate = { ...dailyViewRow("dup", 3), settledAt: "2026-10-08T16:05:00Z", health: { code: "READY", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT" }] } };
  assert.notEqual(reconciliationSettlement(legacyDuplicate, { now }), "settled", "旧记录里的重复归属毛利不当作已固定");
  assert.equal(reconciliationDisplayStatus(legacyDuplicate, { now }).state, "action");
});

test("已固定的日子悬停写几点固定；固定之后又改过标「改过」，可以和「亏损」一起显示", () => {
  const settledAt = "2026-10-08T16:05:00Z";
  const row = { ...dailyViewRow("fixed", 3), settledAt, ledger: { revision: 1 } };
  const flags = reconciliationRowFlags(row, "USD", { now: NOW });
  assert.deepEqual([flags.displayStatus.state, flags.displayStatus.label, flags.displayStatus.note, flags.displayStatus.revised, flags.tags, flags.severity],
    ["settled", "已固定", "10月9日 0:05 固定", false, [], 3]);
  const revised = reconciliationRowFlags({ ...row, ledger: { revision: 2 } }, "USD", { now: NOW });
  assert.deepEqual([revised.displayStatus.revised, revised.tags], [true, ["改过"]]);
  const loss = reconciliationRowFlags({ ...ratedRow("loss", 1, 2), settledAt, ledger: { revision: 2 } }, "USD", { now: NOW });
  assert.deepEqual([loss.tags, loss.severity], [["改过", "亏损"], 1]);
  // 今天按新配置重算不再单独标出：§4 的小标签只有 改过 / 亏损 / 已停用 / 已删除 / ≈
  const plain = reconciliationRowFlags(dailyViewRow("edited", 3), "USD", { now: NOW });
  const edited = reconciliationRowFlags({ ...dailyViewRow("edited", 3), scope: { recalculated: true } }, "USD", { now: NOW });
  assert.deepEqual([edited.displayStatus, edited.tags], [plain.displayStatus, []]);
});

function ratedRow(id, income, cost, { own = null, up = null, costBasis = "usage", channelId = 1 } = {}) {
  const row = dailyViewRow(id, income);
  row.rule.channels[0].channelId = channelId; row.downstream.channels[0].channelId = channelId;
  Object.assign(row.upstream, { amountUsd: cost, countedAmountUsd: cost });
  row.calculation = { profitUsd: income - cost, marginRate: (income - cost) / income };
  const rate = (cnyPerUsd) => (cnyPerUsd ? { cnyPerUsd, source: "configured" } : { cnyPerUsd: 1, source: "default" });
  row.rates = { income: { stationId: "own", ...rate(own) }, cost: { stationId: "up", ...rate(up) }, costBasis };
  return row;
}

test("3b 币种：默认按系统原值 USD，只有本站和按用量计成本的上游都设置了汇率才按人民币", () => {
  assert.equal(reconciliationRowCurrency(undefined), "USD");
  assert.equal(reconciliationRowCurrency(ratedRow("a", 3, 1).rates), "USD");
  assert.equal(reconciliationRowCurrency(ratedRow("a", 3, 1, { own: 7 }).rates), "USD", "上游没设置汇率");
  assert.equal(reconciliationRowCurrency(ratedRow("a", 3, 1, { up: 6 }).rates), "USD", "本站没设置汇率");
  assert.equal(reconciliationRowCurrency(ratedRow("a", 3, 1, { own: 7, up: 6 }).rates), "CNY");
  assert.equal(reconciliationRowCurrency(ratedRow("a", 3, 1, { own: 7, costBasis: "fixed" }).rates), "CNY", "固定采购上游不需要汇率");
  assert.equal(reconciliationDisplayCurrency([]), "USD");
  assert.equal(reconciliationDisplayCurrency([ratedRow("a", 3, 1, { own: 7, up: 6 })]), "CNY");
  assert.equal(reconciliationDisplayCurrency([ratedRow("a", 3, 1, { own: 7, up: 6 }), ratedRow("b", 3, 1, { own: 7 })]), "USD", "一页只用一种币种");
  assert.deepEqual(reconciliationRateFactors(ratedRow("a", 3, 1).rates), { currency: "USD", income: 1, cost: 1, fixedCost: false });
  assert.deepEqual(reconciliationRateFactors(ratedRow("a", 3, 1, { costBasis: "fixed" }).rates), { currency: "USD", income: 1, cost: 0, fixedCost: true });
  assert.equal(reconciliationRateFactors(ratedRow("a", 3, 1, { own: 7 }).rates, "CNY"), null);
  assert.deepEqual(reconciliationRateFactors(ratedRow("a", 3, 1, { own: 7, up: 6 }).rates, "CNY"), { currency: "CNY", income: 7, cost: 6, fixedCost: false });
  assert.equal(formatReconciliationAmount(34.5, "CNY"), "¥34.50");
  assert.equal(formatReconciliationAmount(4.5, "USD"), "$4.50");
});

test("3b 单条毛利：两侧分别折算后相减，固定采购成本记 0，缺两侧金额的旧快照退回 USD", () => {
  const usd = ratedRow("usd", 3, 1);
  assert.deepEqual(reconciliationCalculationValues(usd.calculation, usd.health, usd),
    { confirmed: true, profitUsd: 2, riskDifferenceUsd: null, marginRate: 2 / 3, currency: "USD", profit: 2, riskDifference: null, margin: 2 / 3 });
  const cny = ratedRow("cny", 3, 1, { own: 7, up: 6 });
  const values = reconciliationCalculationValues(cny.calculation, cny.health, cny, "CNY");
  assert.deepEqual([values.currency, values.profit, values.profitUsd], ["CNY", 15, 2], "$3×7 − $1×6");
  assert.ok(Math.abs(values.margin - 15 / 21) < 1e-9);
  assert.equal(reconciliationCalculationValues(cny.calculation, cny.health, cny).currency, "USD", "没要求人民币就按原值");
  const fixed = ratedRow("fixed", 1, 2, { costBasis: "fixed" });
  const fixedValues = reconciliationCalculationValues(fixed.calculation, fixed.health, fixed);
  assert.deepEqual([fixedValues.currency, fixedValues.profitUsd, fixedValues.profit, fixedValues.margin], ["USD", -1, 1, 1]);
  assert.equal(reconciliationRowFlags(fixed, "USD", { now: NOW }).negative, false, "固定采购上游的用量不计成本，不算亏损");
  assert.equal(reconciliationRowFlags(ratedRow("loss", 1, 2), "USD", { now: NOW }).negative, true);
  const waiting = ratedRow("waiting", 3, 1, { own: 7, up: 6 });
  waiting.calculation = { profitUsd: null, riskDifferenceUsd: 2 }; waiting.health = { code: "WAITING_FOR_BILL", issues: [] };
  const risk = reconciliationCalculationValues(waiting.calculation, waiting.health, waiting, "CNY");
  assert.deepEqual([risk.profit, risk.riskDifference, risk.margin], [null, 15, null]);
  const legacy = ratedRow("legacy", 3, 1, { own: 7, up: 6 });
  delete legacy.downstream.amountUsd;
  const legacyValues = reconciliationCalculationValues(legacy.calculation, legacy.health, legacy, "CNY");
  assert.deepEqual([legacyValues.currency, legacyValues.profit, legacyValues.riskDifference], ["USD", legacyValues.profitUsd, legacyValues.riskDifferenceUsd]);
});

test("3b 汇总显示口径：全部可折算才按人民币，固定采购成本记 0；USD 原始口径不变", () => {
  const coverageFor = () => ({ state: "complete_known" });
  const rows = [ratedRow("a", 3, 1, { own: 7, up: 6 }), ratedRow("b", 2, 1, { own: 7, up: 6, channelId: 2 })];
  const cny = summarizeReconciliationWindowGroups(rows, { coverageFor }).commonSummary.totals;
  assert.deepEqual([cny.knownIncomeUsd, cny.knownCostUsd, cny.confirmedProfitUsd], [5, 2, 3]);
  assert.deepEqual([cny.display.currency, cny.display.knownIncome, cny.display.knownCost, cny.display.confirmedProfit], ["CNY", 35, 12, 23]);
  assert.ok(Math.abs(cny.display.confirmedMarginRate - 23 / 35) < 1e-9);
  const usd = summarizeReconciliationWindowGroups(rows, { coverageFor, currency: "USD" }).commonSummary.totals.display;
  assert.deepEqual([usd.currency, usd.knownIncome, usd.knownCost, usd.confirmedProfit], ["USD", 5, 2, 3]);
  rows[1].rates.cost = { stationId: "up", cnyPerUsd: 1, source: "default" };
  assert.equal(summarizeReconciliationWindowGroups(rows, { coverageFor }).commonSummary.totals.display.currency, "USD", "缺一个汇率整页按 USD");
  assert.equal(summarizeReconciliationWindowGroups(rows, { coverageFor, currency: "CNY" }).commonSummary.totals.display.currency, "USD", "强制人民币但有一行折算不了也退回 USD");
  rows[1].rates.costBasis = "fixed";
  const mixed = summarizeReconciliationWindowGroups(rows, { coverageFor }).commonSummary.totals.display;
  assert.deepEqual([mixed.currency, mixed.knownCost, mixed.confirmedProfit], ["CNY", 6, 29], "$3×7 − $1×6 + $2×7 − 0");
});

test("3b 实时窗口：同一预设同一起点就是同一窗口，各关联截止点不同也合成一组", () => {
  const start = Date.parse("2026-10-08T16:00:00Z");
  const live = (endMs) => ({ preset: "today", startMs: start, endMs, timezone: "Asia/Shanghai" });
  const rows = [ratedRow("a", 3, 1), ratedRow("b", 2, 1, { channelId: 2 })];
  rows.forEach((row, index) => {
    const window = live(start + 3600000 + index * 1500);
    for (const side of [row.upstream, row.downstream]) side.window = window;
    Object.assign(row, { window, requestedWindow: window });
  });
  const grouped = summarizeReconciliationWindowGroups(rows, { coverageFor: () => ({ state: "complete_known" }) });
  assert.equal(grouped.windowGroups.length, 1);
  assert.deepEqual(grouped.windowGroups[0].window, { startMs: start, endMs: start + 3600000, preset: "today" }, "截止点取最早的一条");
  assert.equal(grouped.commonSummary.totals.confirmedProfitUsd, 3);
});

test("3b 未纳入核算的上游消费：账号扣费 − 已核算成本，状态、说明和币种", () => {
  const station = { id: "up", name: "上游" };
  const rows = [ratedRow("a", 3, 1), ratedRow("b", 2, 0.5, { channelId: 2 }), { ...ratedRow("other", 9, 9), rule: { ...ratedRow("x", 1, 1).rule, upstreamStationId: "elsewhere" } }];
  const configured = { cnyPerUsd: 6, source: "configured" };
  const done = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api", endMs: 5 } }], rows, { currency: "CNY" });
  assert.deepEqual([done.state, done.currency, done.total], ["complete", "CNY", 3]);
  assert.deepEqual(done.accounts[0], { stationId: "up", name: "上游", rate: 6, mode: "api", endMs: 5, state: "complete", notes: [], ruleIds: ["a", "b"],
    accountUsd: 2, accountedUsd: 1.5, unaccountedUsd: 0.5, account: 12, accounted: 9, unaccounted: 3, overAccounted: null });
  const usd = summarizeUnaccountedUpstream([{ station, rate: { cnyPerUsd: 1, source: "default" }, usage: { usd: 2, mode: "api" } }], rows, { currency: "CNY" });
  assert.deepEqual([usd.currency, usd.total, usd.accounts[0].rate], ["USD", 0.5, null], "缺汇率按 USD 原值");
  assert.equal(summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], rows).currency, "USD", "默认 USD");
  const pending = summarizeUnaccountedUpstream([{ station, rate: configured, usage: null }, { station: { id: "b", name: "B" }, rate: configured, usage: { usd: 1 } }], rows);
  assert.deepEqual([pending.state, pending.total, pending.accounts[0].state], ["pending", null, "pending"]);
  // 服务端读不到时给的说明就是 §5.3 的那句提示（server/reconciliation.js 的 issueText）
  const unavailableNote = reconciliationIssue("UPSTREAM_DATA_UNAVAILABLE").hint;
  const unavailable = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: null, mode: "unavailable", note: unavailableNote } }], rows);
  assert.deepEqual([unavailable.state, unavailable.total, unavailable.accounts[0].notes], ["partial", 0, [unavailableNote]]);
  const estimated = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 1, mode: "history" }, approximate: true }], rows);
  assert.equal(estimated.state, "estimated");
  assert.deepEqual(estimated.accounts[0].notes, ["这个上游按整天给用量，自选时间按整天算", "已算进利润的多于上游扣费：上游的扣费可能还没记全"]);
  assert.equal(estimated.accounts[0].unaccountedUsd, -0.5, "负数照实给出，不吞掉");
  assert.equal(estimated.accounts[0].overAccounted, "timing");
  assert.equal(estimated.total, 0, "负的未纳入不抵消其他账号");
  const mixed = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 1, mode: "api" } },
    { station: { id: "solo", name: "独立" }, rate: configured, usage: { usd: 2, mode: "api" } }], rows);
  assert.deepEqual([mixed.accounts.map((account) => account.unaccountedUsd), mixed.total], [[-0.5, 2], 2]);
  // 浮点相减的极小差额按 0 计：0.3 − (0.1 + 0.2) 不算多核算
  const floatRows = [ratedRow("a", 3, 0.1), ratedRow("b", 2, 0.2, { channelId: 2 })];
  const exact = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 0.3, mode: "api" } }], floatRows, { currency: "CNY" }).accounts[0];
  assert.deepEqual([exact.unaccountedUsd, exact.unaccounted, exact.overAccounted, exact.notes], [0, 0, null, []]);
  // 金额大时累加误差超过 1e-9：500 条 $3333.33 的合计和 $1666665 差约 8e-9，阈值按金额量级放大
  const bigRows = Array.from({ length: 500 }, (_, index) => ratedRow(`big${index}`, 4000, 3333.33));
  const big = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 1666665, mode: "api" } }], bigRows, { currency: "CNY" }).accounts[0];
  assert.notEqual(big.accountUsd - big.accountedUsd, 0, "测试前提：累加确实有误差");
  assert.deepEqual([big.unaccountedUsd, big.unaccounted, big.overAccounted, big.notes], [0, 0, null, []]);
  // 真实的小额差不吞：$0.01，大额合计上也一样
  const cent = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 0.29, mode: "api" } }], floatRows).accounts[0];
  assert.deepEqual([cent.overAccounted, Math.round(cent.unaccountedUsd * 100)], ["timing", -1]);
  for (const [usd, cents, overAccounted] of [[1666665.01, 1, null], [1666664.99, -1, "timing"], [1666665.0001, 0, null]]) {
    const off = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd, mode: "api" } }], bigRows, { currency: "CNY" }).accounts[0];
    assert.deepEqual([Math.round(off.unaccountedUsd * 100), off.overAccounted], [cents, overAccounted], `账号扣费 $${usd}`);
    assert.notEqual(off.unaccountedUsd, 0, `账号扣费 $${usd}：不到一分的真实差额也保留`);
  }
  // 余额历史没覆盖整个时段时服务端在说明后面接「历史数据不够，金额偏低」
  const lowerBound = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 3, mode: "history", lowerBound: true, note: "历史数据不够，金额偏低" } }], rows);
  assert.deepEqual([lowerBound.state, lowerBound.total, lowerBound.accounts[0].state, lowerBound.accounts[0].notes], ["partial", 1.5, "partial", ["历史数据不够，金额偏低"]]);
  // 上游成本没读全的那条，毛利算不出来，不算进利润（和汇总同一个判断）：它的扣费都留在「没算进利润」里
  rows[1].upstream.state = "partial";
  const partial = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], rows);
  assert.deepEqual([partial.accounts[0].accountedUsd, partial.accounts[0].unaccountedUsd, partial.accounts[0].notes], [1, 1, []]);
  // 需处理的那条也一样：它的成本不算已算进利润
  rows[1].upstream.state = "complete";
  rows[1].displayStatus = { state: "action" };
  const attention = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], rows);
  assert.deepEqual([attention.accounts[0].accountedUsd, attention.accounts[0].unaccountedUsd], [1, 1]);
  delete rows[1].displayStatus;
  assert.deepEqual(summarizeUnaccountedUpstream([], rows), { state: "complete", currency: "USD", total: 0, accounts: [] });
});

test("汇总的上游成本 + 没算进利润的上游成本 = 上游扣费：需处理、还在读取的绑定只出现在「没算进利润」里", () => {
  const station = { id: "up", name: "上游" };
  const counted = ratedRow("a", 3, 1), attention = ratedRow("b", 2, 0.5, { channelId: 2 }), reading = ratedRow("c", 2, 0.25, { channelId: 3 });
  attention.displayStatus = { state: "action" };
  reading.upstream.state = "partial";
  const rows = [counted, attention, reading];
  const { windowGroups: [group] } = summarizeReconciliationWindowGroups(rows, { coverageFor: () => ({ state: "partial" }) });
  const [account] = summarizeUnaccountedUpstream([{ station, rate: { cnyPerUsd: 1, source: "default" }, usage: { usd: 3, mode: "api" } }], rows).accounts;
  // 原来需处理、还在读取的两条（$0.5 + $0.25）也算成「已算进利润」：已算进利润 $1.75、没算进利润 $1.25，和汇总的 $1 对不上
  assert.deepEqual([group.totals.knownCostUsd, account.accountedUsd, account.unaccountedUsd], [1, 1, 2]);
  assert.equal(group.totals.knownCostUsd + account.unaccountedUsd, account.accountUsd, "两块加起来就是上游扣费");
  assert.deepEqual([group.totals.attentionRuleIds, group.totals.readingRuleIds], [["b"], ["c"]]);
  assert.equal(reconciliationNotCountedText(group.totals, counted.window, Date.parse("2026-10-24T00:00:00Z")), "其中 10月8日 有 1 条绑定需处理、1 条还在读取，没算进来。");
});

// 已固定的日子按账本记下的汇率显示成本：未纳入面板的已核算也按行上的汇率折算，和明细行对得上
test("4a 未纳入核算的上游消费：已固定的日子按固定时的汇率折算已核算，汇率差单独说明", () => {
  const station = { id: "up", name: "上游" };
  const configured = { cnyPerUsd: 6, source: "configured" };
  const settled = ratedRow("a", 3, 1, { own: 7, up: 7 });
  const current = ratedRow("b", 2, 0.5, { own: 7, up: 6, channelId: 2 });
  const summary = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], [settled, current], { currency: "CNY" });
  const note = "已固定的日子按固定时记下的汇率换算，差额里有汇率差";
  assert.deepEqual([summary.accounts[0].accounted, summary.accounts[0].account, summary.accounts[0].unaccounted, summary.accounts[0].notes],
    [10, 12, 2, [note]], "1×7 + 0.5×6 = 10，2×6 − 10 = 2");
  assert.equal(summary.accounts[0].unaccountedUsd, 0.5);
  // 汇率相同：没有汇率差，不提示
  const same = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], [ratedRow("a", 3, 1, { own: 7, up: 6 })], { currency: "CNY" });
  assert.deepEqual([same.accounts[0].accounted, same.accounts[0].notes], [6, []]);
  // 固定采购的行成本记 0，这里比的是 Key 用量，按账号汇率折算，不算汇率差
  const fixed = ratedRow("f", 3, 1, { own: 7, up: 9, costBasis: "fixed" });
  const fixedSummary = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], [fixed], { currency: "CNY" });
  assert.deepEqual([fixedSummary.accounts[0].accounted, fixedSummary.accounts[0].notes], [6, []]);
  // 按 USD 显示时不折算
  const usd = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], [settled, current]);
  assert.deepEqual([usd.accounts[0].accounted, usd.accounts[0].unaccounted, usd.accounts[0].notes], [1.5, 0.5, []]);
});

test("3b 固定采购关联所在站点不在我的站点摊销范围时点名，每个站点一次", () => {
  const stations = { amortized: { id: "amortized", name: "摊销中" }, off: { id: "off", name: "不摊销" }, usage: { id: "usage", name: "按用量" } };
  const on = (id, host, costBasis = "fixed") => ({ ...ratedRow(id, 3, 1, { costBasis }), rule: { ...ratedRow(id, 3, 1).rule, upstreamStationId: host } });
  const rows = [on("r1", "amortized"), on("r2", "off"), on("r3", "off"), on("r4", "usage", "usage"), on("r5", "deleted")];
  assert.deepEqual(fixedOffProfitStations(rows, { amortizedIds: ["amortized"], stationOf: (id) => stations[id] || null }), [{ id: "off", name: "不摊销" }]);
  assert.deepEqual(fixedOffProfitStations(rows, { amortizedIds: ["amortized", "off"], stationOf: (id) => stations[id] || null }), []);
  assert.deepEqual(fixedOffProfitStations(rows, { stationOf: (id) => stations[id] || null }), [{ id: "amortized", name: "摊销中" }, { id: "off", name: "不摊销" }]);
});

// 没开监控的站点（账单授权）上的核算关联：只有核验过的账号身份相同或渠道接到了这个监控站点时才归属，地址相同不算。
test("3b 未开监控的站点上的核算关联：身份或监控关联确认后归到监控账号，无法确认时只标出来", () => {
  const identity = (accountId, baseUrl = "https://up.test") => ({ provider: "newapi", baseUrl, accountId });
  const auth = { id: "auth", name: "授权A", baseUrl: "https://up.test/", monitorEnabled: false, verifiedIdentity: identity("7") };
  const keyA = { id: "keyA", name: "KeyA", baseUrl: "https://up.test", monitorEnabled: true };
  const keyB = { id: "keyB", name: "KeyB", baseUrl: "https://up.test", monitorEnabled: true };
  const other = { id: "other", name: "别站", baseUrl: "https://other.test", monitorEnabled: true };
  const stations = { auth, keyA, keyB, other, fixed: { id: "fixed", name: "固定", baseUrl: "https://up.test", monitorEnabled: true } };
  const onAuth = (id, channelId = 1, host = "auth") => ({ ...ratedRow(id, 3, 1, { channelId }), rule: { ...ratedRow(id, 3, 1, { channelId }).rule, upstreamStationId: host } });
  const attribute = (usageStations, rows, monitorLinks = []) => Object.fromEntries(attributeAuthorizationRules({ usageStations, rows, stationOf: (id) => stations[id], monitorLinks }));
  const entry = (ruleId) => ({ ruleId, stationId: "auth", stationName: "授权A" });
  const link = (stationId, channelId = 1, ownStationId = "own") => ({ ownStationId, channelId, stationId });

  // 同站点只有一个监控账号也不能凭地址归属
  assert.deepEqual(attribute([keyA, other], [onAuth("r1")]), { keyA: { borrowed: [], uncertain: [entry("r1")] } });
  // 渠道接到了这个监控站点：归属；别的本站、别的渠道的监控关联不算
  assert.deepEqual(attribute([keyA, keyB], [onAuth("r1")], [link("keyB")]), { keyB: { borrowed: [entry("r1")], uncertain: [] } });
  assert.deepEqual(attribute([keyA], [onAuth("r1")], [link("keyA", 2), link("keyA", 1, "own2")]), { keyA: { borrowed: [], uncertain: [entry("r1")] } });
  // 核验过的账号身份相同：归属；身份不同的不是候选
  const sameAccount = { ...keyA, verifiedIdentity: identity("7", "https://up.test/") }, otherAccount = { ...keyB, verifiedIdentity: identity("8") };
  assert.deepEqual(attribute([sameAccount, otherAccount], [onAuth("r1")]), { keyA: { borrowed: [entry("r1")], uncertain: [] } });
  assert.deepEqual(attribute([otherAccount], [onAuth("r1")], [link("keyB")]), {}, "身份不同时监控关联也不能归属");
  // 两个都能确认（都接了监控）：不归属，在两边都标出来
  assert.deepEqual(attribute([keyA, keyB], [onAuth("r1")], [link("keyA"), link("keyB")]),
    { keyA: { borrowed: [], uncertain: [entry("r1")] }, keyB: { borrowed: [], uncertain: [entry("r1")] } });
  // 一个靠身份确认、另一个靠监控关联确认：仍是两个候选，不归属
  assert.deepEqual(attribute([sameAccount, keyB], [onAuth("r1")], [link("keyB")]),
    { keyA: { borrowed: [], uncertain: [entry("r1")] }, keyB: { borrowed: [], uncertain: [entry("r1")] } });
  // 授权没核验身份时，身份核验过的监控账号仍是候选，渠道接到它就归属
  stations.auth = { ...auth, verifiedIdentity: undefined };
  assert.deepEqual(attribute([sameAccount], [onAuth("r1")]), { keyA: { borrowed: [], uncertain: [entry("r1")] } });
  assert.deepEqual(attribute([sameAccount], [onAuth("r1")], [link("keyA")]), { keyA: { borrowed: [entry("r1")], uncertain: [] } });
  stations.auth = auth;
  // 监控关联不要求地址相同：渠道接到了另一个地址的 Key 监控也归属
  const panel = { id: "panel", name: "面板", baseUrl: "https://api.up.test", monitorEnabled: true };
  assert.deepEqual(attribute([keyA, panel], [onAuth("r1")], [link("panel")]), { panel: { borrowed: [entry("r1")], uncertain: [] } });
  // 开着监控的上游（固定采购、不计入成本）、找不到的站点都不处理
  assert.deepEqual(attribute([keyA], [onAuth("r1", 1, "fixed"), onAuth("r2", 1, "gone")]), {});
  // 没开监控的固定采购上游：关联成本记 0，不归属也不标，差额留在未纳入里
  const fixedRule = onAuth("r1");
  fixedRule.rates = { ...fixedRule.rates, costBasis: "fixed" };
  assert.deepEqual(attribute([keyA], [fixedRule], [link("keyA")]), {});
  // 重复归属的非归属方成本记在别的关联上，无法确认时不标；账单取不到的仍标
  const duplicate = onAuth("r1"), unavailable = onAuth("r2", 2);
  Object.assign(duplicate.upstream, { countedAmountUsd: null, ownershipState: "duplicate", duplicateOfRuleId: "r0" });
  Object.assign(unavailable.upstream, { state: "unavailable", amountUsd: null, knownAmountUsd: null, countedAmountUsd: null });
  assert.deepEqual(attribute([keyA], [duplicate, unavailable]), { keyA: { borrowed: [], uncertain: [entry("r2")] } });
  assert.deepEqual(attribute([keyA], [duplicate], [link("keyA")]), { keyA: { borrowed: [entry("r1")], uncertain: [] } });
  // 授权没有地址：没有同地址的候选，只能靠监控关联
  stations.auth = { ...auth, baseUrl: "" };
  assert.deepEqual(attribute([keyA], [onAuth("r1")]), {});
  assert.deepEqual(attribute([keyA], [onAuth("r1")], [link("keyA")]), { keyA: { borrowed: [entry("r1")], uncertain: [] } });
  stations.auth = auth;
  // 已经在按用量对比的账号上的关联不再借
  assert.deepEqual(attribute([keyA, { ...auth, monitorEnabled: true }], [onAuth("r1")]), {});
  // 同地址有两个没开监控的站点：各自分组
  stations.auth2 = { ...auth, id: "auth2", name: "授权B", verifiedIdentity: undefined };
  assert.deepEqual(attribute([keyA], [onAuth("r1"), onAuth("r2", 2, "auth2"), onAuth("r3", 3)]),
    { keyA: { borrowed: [], uncertain: [entry("r1"), { ruleId: "r2", stationId: "auth2", stationName: "授权B" }, entry("r3")] } });

  // 汇总：借来的关联计入已核算，无法确认的让账号变成「部分」；说明按上游点名，不列绑定 ID
  const own = ratedRow("k1", 2, 0.5, { channelId: 3 });
  own.rule = { ...own.rule, upstreamStationId: "keyA" };
  const rows = [own, onAuth("r1"), onAuth("r2", 2)];
  const rate = { cnyPerUsd: 1, source: "default" }, usage = { usd: 4, mode: "api" };
  const borrowedNote = "已算进利润的部分含暂停监控的上游「授权A」上的绑定";
  const borrowed = summarizeUnaccountedUpstream([{ station: keyA, rate, usage, borrowed: [entry("r1"), entry("r2")] }], rows);
  assert.deepEqual([borrowed.state, borrowed.total], ["complete", 1.5]);
  assert.deepEqual(borrowed.accounts[0], { stationId: "keyA", name: "KeyA", rate: null, mode: "api", endMs: null, state: "complete",
    notes: [borrowedNote], ruleIds: ["k1", "r1", "r2"],
    accountUsd: 4, accountedUsd: 2.5, unaccountedUsd: 1.5, account: 4, accounted: 2.5, unaccounted: 1.5, overAccounted: null });
  const entryB = (ruleId) => ({ ruleId, stationId: "auth2", stationName: "授权B" });
  const uncertain = summarizeUnaccountedUpstream([{ station: keyA, rate, usage, uncertain: [entry("r1"), entryB("r9"), entry("r2")] }], rows);
  assert.deepEqual([uncertain.state, uncertain.total, uncertain.accounts[0].ruleIds, uncertain.accounts[0].accountedUsd], ["partial", 3.5, ["k1"], 0.5]);
  const uncertainNote = (name) => `暂停监控的上游「${name}」上的绑定还没确认属于哪个上游账号，没算进利润的上游成本可能偏高；到「渠道绑定」里把渠道对上这个上游后就能确认`;
  assert.deepEqual(uncertain.accounts[0].notes, [uncertainNote("授权A"), uncertainNote("授权B")]);
  // 借来的关联账单没读全：毛利算不出，不算进利润，它的扣费整个落在「没算进利润」里，不再说「已算进利润的金额偏低」
  rows[1].upstream.state = "partial";
  const incomplete = summarizeUnaccountedUpstream([{ station: keyA, rate, usage, borrowed: [entry("r1")] }], rows);
  assert.deepEqual([incomplete.state, incomplete.accounts[0].accountedUsd, incomplete.accounts[0].notes], ["complete", 0.5, [borrowedNote]]);
  rows[1].upstream.state = "complete";

  // 人民币：借来的关联按它自己上游的汇率折算，和明细行一致；未纳入 = 账号扣费按本账号汇率 − 已核算
  const cnyRows = [ratedRow("k1", 2, 0.5, { own: 7, up: 6 }), { ...ratedRow("r1", 3, 1, { own: 7, up: 7 }), rule: { ...ratedRow("r1", 3, 1).rule, upstreamStationId: "auth" } }];
  cnyRows[0].rule = { ...cnyRows[0].rule, upstreamStationId: "keyA" };
  const cny = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage, borrowed: [entry("r1")] }], cnyRows, { currency: "CNY" });
  assert.deepEqual([cny.currency, cny.total], ["CNY", 14]);
  const rateNote = "上游「授权A」的汇率和这个上游账号不一样，差额里有汇率差；两边的汇率设成一样就没有了";
  assert.deepEqual(cny.accounts[0].notes, [borrowedNote, rateNote]);
  assert.deepEqual([cny.accounts[0].accountedUsd, cny.accounts[0].unaccountedUsd, cny.accounts[0].account, cny.accounts[0].accounted, cny.accounts[0].unaccounted],
    [1.5, 2.5, 24, 10, 14], "0.5×6 + 1×7 = 10，4×6 − 10 = 14");
  const usd = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage, borrowed: [entry("r1")] }], cnyRows);
  assert.deepEqual([usd.currency, usd.accounts[0].accounted, usd.accounts[0].unaccounted, usd.accounts[0].notes],
    ["USD", 1.5, 2.5, [borrowedNote]], "按 USD 时不折算，也没有汇率差");
  // 借来的关联所在站点没设汇率：按这个账号的汇率折算，没有汇率差
  const unrated = [cnyRows[0], { ...cnyRows[1], rates: ratedRow("r1", 3, 1, { own: 7 }).rates }];
  const fallback = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage, borrowed: [entry("r1")] }], unrated, { currency: "CNY" });
  assert.deepEqual([fallback.accounts[0].accounted, fallback.accounts[0].unaccounted, fallback.accounts[0].notes], [9, 15, [borrowedNote]]);
  // 汇率差让人民币和美元的正负相反：「已算进利润的多于上游扣费」按显示的金额判断
  const signRows = (cost, up) => [{ ...ratedRow("r1", 3, cost, { own: 7, up }), rule: { ...ratedRow("r1", 3, cost).rule, upstreamStationId: "auth" } }];
  const signCase = (usd, cost, up, currency = "CNY") => summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" },
    usage: { usd, mode: "api" }, borrowed: [entry("r1")] }], signRows(cost, up), { currency }).accounts[0];
  const timing = "已算进利润的多于上游扣费：上游的扣费可能还没记全";
  const flippedNegative = signCase(1, 0.5, 14);
  assert.deepEqual([flippedNegative.unaccountedUsd, flippedNegative.unaccounted, flippedNegative.overAccounted, flippedNegative.notes.slice(1)],
    [0.5, -1, "rate", [rateNote, "已算进利润的多于上游扣费：两边汇率不同"]], "$0.5 未纳入，按 ¥6 和 ¥14 折算后 6 − 7 = −1");
  const flippedPositive = signCase(2, 2.5, 4);
  assert.deepEqual([flippedPositive.unaccountedUsd, flippedPositive.unaccounted, flippedPositive.overAccounted, flippedPositive.notes.slice(1)],
    [-0.5, 2, null, [rateNote]], "美元多核算 $0.5，按 ¥6 和 ¥4 折算后 12 − 10 = 2，不提示多核算");
  const usdNegative = signCase(2, 2.5, 4, "USD");
  assert.deepEqual([usdNegative.unaccounted, usdNegative.overAccounted, usdNegative.notes.slice(1)], [-0.5, "timing", [timing]]);
  // 美元和人民币都多核算：汇率差让多核算更多时说两者都有，汇率差让多核算更少时只说上游的扣费可能还没记全
  const bothNegative = signCase(1, 1.5, 7);
  assert.deepEqual([bothNegative.unaccountedUsd, bothNegative.unaccounted, bothNegative.overAccounted, bothNegative.notes.slice(1)],
    [-0.5, -4.5, "mixed", [rateNote, "已算进利润的多于上游扣费：上游的扣费可能还没记全，两边汇率也不同"]], "6 − 1.5×7 = −4.5");
  const rateLowers = signCase(1, 2, 4);
  assert.deepEqual([rateLowers.unaccountedUsd, rateLowers.unaccounted, rateLowers.overAccounted, rateLowers.notes.slice(1)],
    [-1, -2, "timing", [rateNote, timing]], "6 − 2×4 = −2");
  // 归属来的关联成本为 0：没有汇率差，也不提示
  const zeroCost = signCase(1, 0, 14);
  assert.deepEqual([zeroCost.accounted, zeroCost.unaccounted, zeroCost.overAccounted, zeroCost.notes.slice(1)], [0, 6, null, []]);
  // 美元恰好相等（浮点误差按 0 计），人民币因汇率差为负：只说汇率
  const evenRows = [0.1, 0.2].map((cost, index) => ({ ...ratedRow(`e${index}`, 3, cost, { own: 7, up: 8, channelId: index + 1 }),
    rule: { ...ratedRow(`e${index}`, 3, cost).rule, upstreamStationId: "auth" } }));
  const even = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage: { usd: 0.3, mode: "api" },
    borrowed: [entry("e0"), entry("e1")] }], evenRows, { currency: "CNY" }).accounts[0];
  assert.equal(even.unaccountedUsd, 0);
  assert.ok(Math.abs(even.unaccounted + 0.6) < 1e-12, "1.8 − 0.3×8 = −0.6");
  assert.deepEqual([even.overAccounted, even.notes.at(-1)], ["rate", "已算进利润的多于上游扣费：两边汇率不同"]);
  // 人民币一侧的误差也按金额量级判断：333 条 $3333.33 按 ¥8 折算，账号按 ¥6，账号扣费正好等于按 ¥8 折算的已核算
  const bigBorrowed = Array.from({ length: 333 }, (_, index) => ({ ...ratedRow(`g${index}`, 4000, 3333.33, { own: 7, up: 8, channelId: index + 1 }),
    rule: { ...ratedRow(`g${index}`, 4000, 3333.33).rule, upstreamStationId: "auth" } }));
  let bigCost = 0, bigGap = 0;
  for (const row of bigBorrowed) { bigCost += row.upstream.countedAmountUsd; bigGap += row.upstream.countedAmountUsd * 2; }
  const bigUsd = bigCost * 8 / 6;
  assert.ok(Math.abs((bigUsd - bigCost) * 6 - bigGap) > 1e-10, "测试前提：人民币一侧确实有累加误差");
  const bigEven = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage: { usd: bigUsd, mode: "api" },
    borrowed: bigBorrowed.map((row) => entry(row.rule.id)) }], bigBorrowed, { currency: "CNY" }).accounts[0];
  assert.ok(bigEven.unaccountedUsd > 0);
  assert.deepEqual([bigEven.unaccounted, bigEven.overAccounted], [0, null]);
});

// 服务端对固定采购上游的结果：Key 账单取不到、成本归属未核验都标 reference，毛利 = 收入。
function fixedReferenceRow(id, income, { costBasis = "fixed" } = {}) {
  const row = ratedRow(id, income, 0, { costBasis });
  const reference = costBasis === "fixed" ? { reference: true } : {};
  Object.assign(row.upstream, { state: "unavailable", amountUsd: null, countedAmountUsd: null, ownershipState: "unknown", window: null });
  row.calculation = costBasis === "fixed" ? { differenceUsd: income, profitUsd: income, riskDifferenceUsd: null, marginRate: 1 }
    : { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null };
  row.health = { code: costBasis === "fixed" ? "READY" : "UPSTREAM_DATA_UNAVAILABLE", issues: [
    { code: "UPSTREAM_DATA_UNAVAILABLE", side: "upstream", ...reference },
    { code: "WAITING_FOR_BILL", side: "upstream", ...reference },
    { code: "BILLING_WINDOW_MISMATCH", side: "upstream", ...reference },
    { code: "COST_OWNER_UNVERIFIED", side: "upstream", ...reference },
  ] };
  return row;
}

test("4a 固定采购上游：只作参考的上游问题不挡毛利、不出处理动作，渠道算已核算，汇总成本记 0；按用量的照旧挡住", () => {
  const catalogue = (row) => ({ ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] });
  const fixed = fixedReferenceRow("fixed", 3);
  const values = reconciliationCalculationValues(fixed.calculation, fixed.health, fixed);
  assert.deepEqual([values.confirmed, values.profitUsd, values.profit, values.margin], [true, 3, 3, 1]);
  assert.equal(reconciliationSettlement(fixed, { now: NOW }), "ended", "还没固定下来");
  assert.equal(reconciliationSettlement({ ...fixed, settledAt: "2026-10-08T16:05:00Z" }, { now: NOW }), "settled");
  assert.deepEqual(reconciliationResultActions(fixed, { now: LATE }), [], "过了 7 天，只作参考的读取问题也不出动作");
  assert.deepEqual(reconciliationDisplayStatus(fixed, { now: NOW }).hints, [], "包月上游的上游侧问题不显示（§5.4）");
  const coverage = deriveKnownChannelCoverage(catalogue(fixed), [fixed.rule], [fixed]);
  assert.deepEqual([coverage.state, coverage.channels[0].status, coverage.channels[0].issues], ["complete_known", "accounted", []]);
  const grouped = summarizeReconciliationWindowGroups([fixed], { coverageFor: () => coverage });
  assert.ok(grouped.commonSummary, "只作参考的窗口不一致不拆开汇总");
  const totals = grouped.commonSummary.totals;
  // 固定成本的上游成本记 0，原始美元那份和显示那份一样：$3 − $0 = $3
  assert.deepEqual([totals.knownIncomeUsd, totals.knownCostUsd, totals.confirmedProfitUsd, totals.profitComplete], [3, 0, 3, true]);
  assert.deepEqual([totals.display.knownCost, totals.display.confirmedProfit, totals.display.confirmedMarginRate], [0, 3, 1]);

  const usage = fixedReferenceRow("usage", 3, { costBasis: "usage" });
  assert.equal(reconciliationCalculationValues(usage.calculation, usage.health, usage).confirmed, false);
  assert.notEqual(reconciliationSettlement(usage, { now: NOW }), "settled");
  // 要人动手的马上出；读取类的过了 7 天才出，几个读取问题共用一个「重新读取」
  assert.deepEqual(reconciliationResultActions(usage, { now: NOW }).map((action) => action.kind), ["verify_identity"]);
  assert.deepEqual(reconciliationResultActions(usage, { now: LATE }).map((action) => action.kind), ["verify_identity", "retry_bill"]);
  const usageCoverage = deriveKnownChannelCoverage(catalogue(usage), [usage.rule], [usage]);
  assert.equal(usageCoverage.channels[0].status, "billing_missing");
  assert.ok(usageCoverage.channels[0].issues.includes("COST_OWNER_UNVERIFIED"));
  const usageGrouped = summarizeReconciliationWindowGroups([usage], { coverageFor: () => usageCoverage });
  assert.equal(usageGrouped.commonSummary, null);
  assert.deepEqual([usageGrouped.windowGroups[0].totals.confirmedProfitUsd, usageGrouped.windowGroups[0].totals.display.knownCost], [null, null]);

  // 固定采购但本站一侧的问题仍然挡住：本站账单不是同一窗口就不给毛利。
  const ownMismatch = fixedReferenceRow("own", 3);
  ownMismatch.downstream.window = { ...ownMismatch.window, endMs: ownMismatch.window.endMs - 1000 };
  assert.equal(reconciliationCalculationValues(ownMismatch.calculation, ownMismatch.health, ownMismatch).confirmed, false);
  ownMismatch.downstream.window = ownMismatch.window;
  ownMismatch.health.issues.push({ code: "BILLING_WINDOW_MISMATCH", side: "downstream" });
  assert.equal(reconciliationCalculationValues(ownMismatch.calculation, ownMismatch.health, ownMismatch).confirmed, false);
  assert.deepEqual(reconciliationResultActions(ownMismatch, { now: NOW }), [], "7 天内系统自己重读");
  assert.deepEqual(reconciliationResultActions(ownMismatch, { now: LATE }).map((action) => action.kind), ["retry_bill"]);
  assert.equal(summarizeReconciliationWindowGroups([ownMismatch], { coverageFor: () => coverage }).commonSummary, null);
});

test("4a 固定采购上游：Key 还有没有其他用途没确认不影响渠道覆盖和汇总毛利；按用量的仍要回答", () => {
  const catalogue = (row) => ({ ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] });
  const unconfirmed = (row) => {
    row.rule = { ...row.rule, costCoverage: "unknown", coverageDeclaration: { answer: "unknown" } };
    return row;
  };
  const fixed = unconfirmed(fixedReferenceRow("fixed", 3));
  fixed.health.issues.push({ code: "COST_COVERAGE_UNKNOWN", side: "upstream", reference: true });
  const coverage = deriveKnownChannelCoverage(catalogue(fixed), [fixed.rule], [fixed]);
  assert.deepEqual([coverage.state, coverage.channels[0].status, coverage.channels[0].issues, coverage.channels[0].actions], ["complete_known", "accounted", [], []]);
  const totals = summarizeReconciliationWindowGroups([fixed], { coverageFor: () => coverage }).commonSummary.totals;
  assert.deepEqual([totals.confirmedProfitUsd, totals.profitComplete], [3, true]);

  const usage = unconfirmed(ratedRow("usage", 3, 1));
  usage.health = { code: "READY", issues: [] };
  const usageCoverage = deriveKnownChannelCoverage(catalogue(usage), [usage.rule], [usage]);
  assert.deepEqual([usageCoverage.channels[0].status, usageCoverage.channels[0].actions.map((action) => action.kind)], ["coverage_unknown", ["confirm_coverage"]]);
  const [answer] = usageCoverage.channels[0].actions;
  assert.deepEqual([answer.label, answer.title, answer.href], ["去回答", COVERAGE_QUESTION, "/stations?action=coverage&ruleId=usage"]);
  const usageTotals = summarizeReconciliationWindowGroups([usage], { coverageFor: () => usageCoverage }).windowGroups[0].totals;
  assert.equal(usageTotals.confirmedProfitUsd, null, "按用量计成本、用途没确认：不计入已确认毛利");
});

test("不认识的码按需处理显示「这条暂时算不出利润」和「刷新」，码只带在状态上给控制台", () => {
  const row = dailyViewRow("new", 3);
  row.health = { code: "SOMETHING_NEW", issues: [] };
  const status = reconciliationDisplayStatus(row, { now: NOW });
  assert.deepEqual([status.state, status.label, status.title, status.detail, status.action.kind, status.action.label, status.action.href, status.code],
    ["action", "需处理", "这条暂时算不出利润", "", "refresh", "刷新", null, "SOMETHING_NEW"]);
  assert.equal(reconciliationRowFlags(row, "USD", { now: NOW }).values.profit, null, "需处理时利润写「—」");
  // 认得的码不带 code
  const denied = dailyViewRow("denied", 3);
  denied.health = { code: "KEY_INVALID_OR_DENIED", issues: [] };
  const known = reconciliationDisplayStatus(denied, { now: NOW });
  assert.equal(Object.hasOwn(known, "code"), false);
  assert.deepEqual([known.title, known.detail, known.action.label, known.action.href],
    ["上游拒绝读取这把 Key", "Key 可能已被删除，或上游的登录信息过期了", "更新登录信息", "/stations?action=authorization&stationId=up"]);
});

function multiIssueRow() {
  const row = dailyViewRow("multi", 3);
  row.health = { code: "WAITING_FOR_BILL", issues: [{ code: "KEY_INVALID_OR_DENIED" }, { code: "CANONICAL_KEY_CONFLICT" }, { code: "DUPLICATE_CHANNEL_ASSIGNMENT", channelId: 1 }] };
  return row;
}

test("有几个问题时只露出最要紧的一条，其余算进「还有 N 个问题」；同一个按钮只出一次", () => {
  const row = multiIssueRow();
  const now = reconciliationDisplayStatus(row, { now: NOW });
  assert.deepEqual([now.state, now.title, now.moreCount, now.action.kind], ["action", "上游拒绝读取这把 Key", 2, "update_authorization"]);
  assert.deepEqual(now.actions.map((action) => action.kind), ["update_authorization", "review_conflict"]);
  assert.deepEqual(now.hints.map((hint) => hint.text), ["这天的账单还没读全"], "读取类 7 天内仍只是提示");
  const late = reconciliationDisplayStatus(row, { now: LATE });
  assert.deepEqual([late.moreCount, late.actions.map((action) => action.kind), late.hints], [3, ["update_authorization", "review_conflict", "retry_bill"], []]);
});

// 「处理重复」同时对应「这把 Key 绑了两次」和「渠道同时绑了两把 Key」，按 §5.2 的先后应取前一条的标题
test("同一个按钮对应几个问题时，事项标题取最靠前的问题", () => {
  const status = reconciliationDisplayStatus(multiIssueRow(), { now: NOW });
  assert.equal(status.actions[1].title, "这把 Key 绑了两次");
});

test("文案里的渠道名、开始统计时刻：填得上就填，填不上用不带名字的那一句", () => {
  const dup = (source) => {
    const row = dailyViewRow("dup", 3);
    row.health = { code: "READY", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT", ...source }] };
    return reconciliationDisplayStatus(row, { now: NOW }).title;
  };
  assert.equal(dup({ channelId: 1 }), "渠道「渠道1」同时绑了两把 Key");
  assert.equal(dup({ channelId: "1" }), "渠道「渠道1」同时绑了两把 Key", "渠道号是字符串也认得");
  assert.equal(dup({}), "有渠道同时绑了两把 Key");
  assert.equal(dup({ channelId: 99 }), "有渠道同时绑了两把 Key", "绑定里没有这个渠道");

  const scoped = (rule) => {
    const row = dailyViewRow("scope", 3);
    Object.assign(row.rule, rule);
    row.health = { code: "BILLING_SCOPE_NOT_EFFECTIVE", issues: [] };
    return reconciliationDisplayStatus(row, { now: NOW }).hints.map((hint) => hint.text);
  };
  assert.deepEqual(scoped({}), ["从 10月8日 开始统计"], "0:00 开始的只写日期");
  assert.deepEqual(scoped({ billingEffectiveFrom: Date.parse("2026-10-08T06:30:00Z") }), ["从 10月8日 14:30 开始统计"]);
  assert.deepEqual(scoped({ billingPolicy: "legacy" }), ["还没开始统计"], "没有开始统计的时刻：用不带时刻的那一句");
});

test("这天最后一次倍率变化：同一天只写时刻，跨天写日期，前后倍率读不到为 null", () => {
  const at = (iso) => Date.parse(iso);
  const item = { window: DAY, transitionSegments: [
    { id: "s2", effectiveFrom: at("2026-10-08T06:30:00Z"), ratio: 1.2 },
    { id: "s1", effectiveFrom: DAY_START, ratio: 1 },
  ] };
  assert.deepEqual(reconciliationRatioChange(item, "Asia/Shanghai", NOW), { at: at("2026-10-08T06:30:00Z"), time: "14:30", from: 1, to: 1.2 });
  // 最后一次变化算数；分段历史里带的倍率合进来
  item.segments = [{ id: "s3", effectiveFrom: at("2026-10-08T10:00:00Z") }];
  item.transitionSegments.push({ id: "s3", ratio: 1.5 });
  assert.deepEqual(reconciliationRatioChange(item, "Asia/Shanghai", NOW), { at: at("2026-10-08T10:00:00Z"), time: "18:00", from: 1.2, to: 1.5 });
  // 两天的窗口里第二天变的：写日期
  const twoDays = { window: { ...DAY, endMs: DAY_END + 86400000 }, transitionSegments: [{ id: "s1", effectiveFrom: DAY_START, ratio: 1 }, { id: "s2", effectiveFrom: at("2026-10-09T02:00:00Z") }] };
  assert.deepEqual(reconciliationRatioChange(twoDays, "Asia/Shanghai", NOW), { at: at("2026-10-09T02:00:00Z"), time: "10月9日 10:00", from: 1, to: null });
  // 正好在这天结束时变的不算这天；这天里没变过、没有日期都为 null
  assert.equal(reconciliationRatioChange({ window: DAY, transitionSegments: [{ id: "s1", effectiveFrom: DAY_START }, { id: "s2", effectiveFrom: DAY_END }] }, "Asia/Shanghai", NOW), null);
  assert.equal(reconciliationRatioChange({ window: DAY, transitionSegments: [{ id: "s1", effectiveFrom: DAY_START }] }, "Asia/Shanghai", NOW), null);
  assert.equal(reconciliationRatioChange({ transitionSegments: item.transitionSegments }, "Asia/Shanghai", NOW), null);
});

test("开始统计的时刻：0:00 只写日期，否则写到分钟；取创建时刻和生效时刻里早的那个；往年带年份", () => {
  const zone = "Asia/Shanghai";
  const rule = (extra) => ({ billingPolicy: "immediate", billingEffectiveFrom: DAY_START, ...extra });
  assert.equal(reconciliationAccountingStartText(rule(), zone, NOW), "10月8日");
  assert.equal(reconciliationAccountingStartText(rule({ billingEffectiveFrom: Date.parse("2026-10-08T06:30:00Z") }), zone, NOW), "10月8日 14:30");
  assert.equal(reconciliationAccountingStartText(rule({ billingEffectiveFrom: Date.parse("2026-10-08T06:30:00Z"), createdAt: "2026-10-08T02:00:00Z" }), zone, NOW), "10月8日 10:00");
  assert.equal(reconciliationAccountingStartText(rule({ billingPolicy: "legacy" }), zone, NOW), "");
  assert.equal(reconciliationAccountingStartText(rule({ billingEffectiveFrom: Date.parse("2025-06-01T16:00:00Z") }), zone, NOW), "2025年6月2日");
  // 换个时区看同一时刻
  assert.equal(reconciliationAccountingStartText(rule(), "UTC", NOW), "10月7日 16:00");
});

test("渠道和 Key 没有名字时写编号，同名的 Key 加编号区分，渠道名旁的小标签只有已停用和已删除，搜索也认编号", () => {
  assert.equal(reconciliationChannelName({ channelId: 12, name: "" }), "渠道 #12");
  assert.equal(reconciliationChannelName({ id: 7 }), "渠道 #7");
  assert.equal(reconciliationChannelName({ channelId: 12, name: "出口" }), "出口");
  assert.equal(reconciliationChannelName(null), "渠道");
  assert.equal(reconciliationKeyName({ tokenName: "", tokenId: 34 }), "Key #34");
  assert.equal(reconciliationKeyName({ tokenId: 0 }), "Key #0");
  assert.equal(reconciliationKeyName({ tokenName: "awsb" }), "awsb");
  assert.equal(reconciliationKeyName(null), "Key");
  const keys = [{ tokenName: "default", tokenId: 7 }, { tokenName: "default", tokenId: 8 }, { tokenName: "awsb", tokenId: 9 }];
  assert.equal(reconciliationKeyName(keys[0], keys), "default（Key #7）");
  assert.equal(reconciliationKeyName(keys[1], keys), "default（Key #8）");
  assert.equal(reconciliationKeyName(keys[2], keys), "awsb");
  assert.equal(reconciliationKeyName(keys[0], [keys[0]]), "default");
  assert.equal(reconciliationKeyName({ tokenId: 34 }, keys), "Key #34");
  assert.equal(reconciliationKeyNamer(keys)(keys[1]), "default（Key #8）");
  const sameName = keys.slice(0, 2).map((rule, index) => ({ rule: { ...rule, id: `r${index}`, upstreamStationId: index + 1 } }));
  assert.deepEqual(filterReconciliationResults(sameName, [], "key #8").map((item) => item.rule.id), ["r1"], "搜索认页面上显示的编号");
  assert.equal(reconciliationChannelTag({ missing: true }), "已删除");
  assert.equal(reconciliationChannelTag({ state: "missing" }), "已删除");
  assert.equal(reconciliationChannelTag({ state: "manual_disabled" }), "已停用");
  assert.equal(reconciliationChannelTag({ state: "auto_disabled" }), "已停用");
  assert.equal(reconciliationChannelTag({ state: "enabled" }), null);
  assert.equal(reconciliationChannelTag(null), null);
  // 渠道列表（deriveKnownChannelCoverage）的渠道只带 operatingState，自营站点渠道目录的只带 status 数字
  assert.equal(reconciliationChannelTag({ operatingState: "missing", status: "unlinked" }), "已删除");
  assert.equal(reconciliationChannelTag({ operatingState: "auto_disabled", status: "accounted" }), "已停用");
  assert.equal(reconciliationChannelTag({ operatingState: "enabled", status: "accounted" }), null);
  assert.equal(reconciliationChannelTag({ status: 2 }), "已停用");
  assert.equal(reconciliationChannelTag({ status: "3" }), "已停用");
  assert.equal(reconciliationChannelTag({ status: 1 }), null);
  assert.equal(reconciliationChannelTag({ missing: true, status: 1 }), "已删除");
  // 渠道列表里停用、删除的渠道名旁也有标签（每日利润页「查看没算进来的」）
  const tagged = dailyViewRow("tagged", 3);
  tagged.rule.channels = [{ channelId: 1, name: "渠道1" }, { channelId: 2, name: "渠道2", missing: true }];
  const directory = { ownSource: tagged.ownSource, stale: false, totalValidated: true, catalogueTotal: 2, channels: [{ id: 1, name: "渠道1", status: 1 }, { id: 3, name: "渠道3", status: 2 }] };
  const tags = deriveKnownChannelCoverage(directory, [tagged.rule], [tagged]).channels.map((channel) => [channel.channelId, reconciliationChannelTag(channel)]);
  assert.deepEqual(tags, [[1, null], [2, "已删除"], [3, "已停用"]]);
  const row = { rule: { tokenName: "", tokenId: 34, upstreamStationId: "s", channels: [{ channelId: 12, name: "" }] }, health: { code: "READY" } };
  assert.deepEqual(filterReconciliationResults([row], [], "Key #34"), [row]);
  assert.deepEqual(filterReconciliationResults([row], [], "渠道 #12"), [row]);
});

test("读取类问题正好过 7 天才变成需处理；今天和自选时间不写「还在读取」", () => {
  assert.equal(RECONCILIATION_READING_GRACE_MS, 7 * 86_400_000);
  const row = dailyViewRow("edge", 3);
  row.health = { code: "UPSTREAM_DATA_UNAVAILABLE", issues: [] };
  assert.equal(reconciliationDisplayStatus(row, { now: DAY_END + RECONCILIATION_READING_GRACE_MS - 1 }).state, "live");
  assert.equal(reconciliationDisplayStatus(row, { now: DAY_END + RECONCILIATION_READING_GRACE_MS }).state, "action");
  // 这天刚结束就算过去的日子
  assert.equal(reconciliationDisplayStatus(dailyViewRow("ready", 3), { now: DAY_END }).note, "还在读取");
  assert.equal(reconciliationDisplayStatus(dailyViewRow("ready", 3), { now: DAY_END - 1 }).note, "");
  const today = { preset: "today", startMs: DAY_END, endMs: NOW, timezone: "Asia/Shanghai" };
  const live = { ...dailyViewRow("today", 3), window: today, requestedWindow: today };
  assert.deepEqual(pick(reconciliationDisplayStatus(live, { now: NOW }), ["state", "asOf", "note"]), { state: "live", asOf: "数据截至 8:00", note: "" });
  const custom = { preset: "custom", startMs: DAY_START + 3600000, endMs: DAY_END - 3600000, timezone: "Asia/Shanghai" };
  assert.equal(reconciliationDisplayStatus({ ...dailyViewRow("custom", 3), window: custom }, { now: NOW }).note, "", "不是整天的不写「还在读取」");
  // 不是当天读的，「数据截至」带上日期
  assert.equal(reconciliationDisplayStatus(dailyViewRow("old", 3), { now: LATE }).asOf, "数据截至 10月9日 8:00");
});

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

test("渠道列表的事项：没绑定的渠道给「去绑定」，时区没确认给「测试读取」", () => {
  const row = dailyViewRow("bound", 3);
  const catalogue = { ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 2,
    channels: [{ id: 1, name: "渠道1", status: 1 }, { id: 2, name: "", status: 2 }] };
  const coverage = deriveKnownChannelCoverage(catalogue, [row.rule], [row]);
  assert.deepEqual([coverage.state, coverage.knownChannelCount, coverage.accountedChannelCount], ["partial", 2, 1]);
  const unlinked = coverage.channels[1];
  assert.deepEqual([unlinked.name, unlinked.operatingState, unlinked.status], ["渠道 #2", "manual_disabled", "unlinked"]);
  assert.deepEqual(unlinked.actions.map((action) => [action.kind, action.label, action.title, action.detail, action.href]),
    [["connect_channels", "去绑定", "有 1 个渠道还没绑定", "绑定之后才能算这些渠道的利润", "/stations?action=connect&ownStationId=own&channelIds=2"]]);

  row.billingTimezone = { state: "unverified", timezone: row.window.timezone };
  const unverified = deriveKnownChannelCoverage(catalogue, [row.rule], [row]).channels[0];
  assert.equal(unverified.status, "coverage_unknown");
  assert.deepEqual(unverified.actions.map((action) => [action.kind, action.label, action.title, action.href]),
    [["verify_capability", "测试读取", "还没确认这个上游按哪个时区算一天", "/stations?action=verify-billing&stationId=up"]]);
});

// §3.6「读取时间」不上页面；design/ui-copy-spec.md 里也没有这几句（代码注释引的 §5.8 不存在）
test("已算进利润的多于上游扣费时，说明里不出现「读取时间」", () => {
  const station = { id: "up", name: "上游" };
  const rows = [ratedRow("a", 3, 1), ratedRow("b", 2, 0.5, { channelId: 2 })];
  const over = summarizeUnaccountedUpstream([{ station, rate: { cnyPerUsd: 6, source: "configured" }, usage: { usd: 1, mode: "api" } }], rows).accounts[0];
  assert.equal(over.overAccounted, "timing");
  for (const note of over.notes) assert.doesNotMatch(note, /读取时间/, note);
});
