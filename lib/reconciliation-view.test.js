import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  reconciliationRowFlags,
  formatReconciliationMoney,
  reconciliationCalculationValues,
  summarizeReconciliationWindowGroups,
  deriveKnownChannelCoverage,
  reconciliationRowCurrency,
  reconciliationDisplayCurrency,
  reconciliationRateFactors,
  fixedOffProfitStations,
  reconciliationResultActions,
  reconciliationDisplayStatus,
  reconciliationRatioChange,
  reconciliationKeyChange,
  reconciliationAccountingStartText,
  countsInSummary,
  heldOldNumber,
  reconciliationNotStarted,
  resettleShrunkConfirm,
  reconciliationChannelName,
  reconciliationKeyName,
  reconciliationKeyNamer,
  reconciliationChannelTag,
  RECONCILIATION_READING_GRACE_MS,
} from "./reconciliation-view.js";
import { INCOMPLETE_DAY_TEXT, reconciliationChannelStatus, reconciliationIssue } from "./reconciliation-contract.js";

// 固定时刻，不随机器时区和当前日期变：上海 10月9日 13:00。dailyViewRow 的那一天是上海 10月8日。
const NOW = Date.parse("2026-10-09T05:00:00Z");
// 那一天结束已经过了 7 天：读取类问题变成需处理
const LATE = Date.parse("2026-10-20T00:00:00Z");
const DAY_START = Date.parse("2026-10-07T16:00:00Z");
const DAY_END = Date.parse("2026-10-08T16:00:00Z");
const DAY = { startMs: DAY_START, endMs: DAY_END, timezone: "Asia/Shanghai" };

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

test("倍率变化的时间是系统估的：只是提示，不进需处理", () => {
  const stable = { rule: { id: "stable", tokenName: "stable", upstreamStationId: "up" }, health: { code: "READY" }, segments: [{ group: "A", timingSource: "initial" }] };
  const changed = { rule: { id: "changed", tokenName: "changed", upstreamStationId: "up" }, health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, transitionSegments: [], segments: [{ group: "A", timingSource: "initial" }, { group: "B", timingSource: "detected" }] };
  const status = reconciliationDisplayStatus(changed, { now: NOW });
  assert.equal(status.state, "live");
  assert.deepEqual(status.hints.map((hint) => hint.text), ["倍率变化的时间是系统估的"]);
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
  const timingHint = { code: "SEGMENT_TIMING_UNCONFIRMED", text: "倍率变化的时间是系统估的", action: null };
  assert.deepEqual(reconciliationDisplayStatus(item, { now: NOW }), { state: "live", label: "实时", asOf: "数据截至 8:00", note: "还在读取",
    hints: [{ code: "UPSTREAM_DATA_UNAVAILABLE", text: "上游暂时读不到，系统会自动再读", action: null }, timingHint], actions: [] });
  assert.deepEqual(reconciliationResultActions(item, { now: NOW }), [], "还在自动重读，不进运营总览");

  const retry = { id: `retry_bill::up:a:own:1:${DAY_START}-${DAY_END}`, kind: "retry_bill", label: "重新读取",
    title: "上游这天的用量记录一直读不到", detail: "", ...target, code: "UPSTREAM_DATA_UNAVAILABLE",
    href: `/reconciliation?action=retry&ruleId=a&startMs=${DAY_START}&endMs=${DAY_END}&timezone=Asia%2FShanghai` };
  assert.deepEqual(reconciliationDisplayStatus(item, { now: LATE }), { state: "action", label: "需处理", title: "上游这天的用量记录一直读不到",
    detail: "", moreCount: 0, action: retry, hints: [timingHint], actions: [retry] });
  const flags = reconciliationRowFlags(item, "USD", { now: LATE });
  assert.deepEqual([flags.attention, flags.severity, flags.values.profit, flags.tags], [true, 0, null, []]);
});

test("K2b：换 Key 那天的一句话——今天/过去的日子、倍率一起变、换的时刻定不出三种写法；换 Key 开的段不算倍率变化", () => {
  const T0 = Date.UTC(2026, 9, 11, 16); // 上海 10-12 0:00
  const day = { startMs: T0, endMs: T0 + 86400000, timezone: "Asia/Shanghai", preset: "custom" };
  const at = (h, m) => T0 + (h * 60 + m) * 60000;
  const seg = (from, extra = {}) => ({ effectiveFrom: from, ratio: 1, timingSource: "detected", ...extra });
  const item = (segments) => ({ window: day, transitionSegments: segments, segments: [] });
  const exact = item([seg(0), seg(at(14, 29), { timingSource: "key_change_window" }), seg(at(14, 30), { timingSource: "key_change" })]);
  assert.equal(reconciliationKeyChange(exact, "Asia/Shanghai", T0 + 86400000 * 3), "14:30 换了 Key", "过去的日子");
  assert.equal(reconciliationKeyChange(exact, "Asia/Shanghai", at(15, 0)), "今天 14:30 换了 Key", "今天");
  const ratio = item([seg(0), seg(at(14, 29), { timingSource: "key_change_window" }), seg(at(14, 30), { timingSource: "key_change", ratio: 1.2 })]);
  assert.equal(reconciliationKeyChange(ratio, "Asia/Shanghai", T0 + 86400000 * 3), "14:30 换了 Key（倍率从 1.0 变成 1.2）");
  const unknown = item([seg(0), seg(at(15, 19), { timingSource: "key_change_window" }), seg(at(16, 5), { timingSource: "key_change" })]);
  assert.equal(reconciliationKeyChange(unknown, "Asia/Shanghai", T0 + 86400000 * 3), "15:19–16:05 之间换了 Key，按 16:05 切开");
  assert.equal(reconciliationKeyChange(item([seg(0), seg(at(14, 30))]), "Asia/Shanghai", T0 + 86400000 * 3), null, "只是倍率变了：不是换 Key");
  assert.equal(reconciliationRatioChange(ratio, "Asia/Shanghai", T0 + 86400000 * 3), null, "倍率变化那一句不把换 Key 开的段算进去");
  // 走完整的显示：KEY_CHANGED 这条码出「换了 Key」那一句，不给「改时间」
  const row = dailyViewRow("k", 3);
  row.window = day;
  row.transitionSegments = exact.transitionSegments;
  row.health = { code: "KEY_CHANGED", issues: [{ code: "KEY_CHANGED" }] };
  const status = reconciliationDisplayStatus(row, { now: T0 + 86400000 * 3 });
  assert.deepEqual(status.hints.map((hint) => hint.text), ["14:30 换了 Key"]);
  assert.equal(status.hints[0].action, null, "不给「改时间」");
});

test("K2b：读不到渠道 Key——说明里「从 {time} 起」用服务端带来的 sinceMs，和这天同一天只写钟点，不同天带日期", () => {
  const row = (code, sinceMs) => {
    const item = dailyViewRow("k", 3);
    item.health = { code, issues: [], sinceMs };
    return item;
  };
  const sameDay = reconciliationDisplayStatus(row("KEY_READER_UNREACHABLE", DAY_START + 15 * 3600000 + 19 * 60000), { now: LATE });
  assert.equal(sameDay.state, "action");
  assert.equal(sameDay.title, "读不到你站的渠道 Key");
  assert.match(sameDay.detail, /^从 \d+:19 起各渠道的利润先不算；连上以后接着算$/);
  // 不同天：带日期
  const otherDay = reconciliationDisplayStatus(row("KEY_READER_UNREACHABLE", DAY_START - 3600000), { now: LATE });
  assert.match(otherDay.detail, /^从 \d+月\d+日 \d+:\d+ 起各渠道的利润先不算/);
  // 没带 sinceMs 时（旧数据）退回不带时刻的那一句，不出现空的「从  起」
  const noTime = reconciliationDisplayStatus(row("KEY_READER_UNREACHABLE", undefined), { now: LATE });
  assert.equal(noTime.detail, "连上以后接着算");
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
  row.billingTimezone.state = "verified"; row.upstream.window = { ...row.window, endMs: row.window.endMs - 1000 };
  row.health.issues = [{ code: "BILLING_WINDOW_MISMATCH" }];
  // 窗口对不上是需处理：汇总三个数都不加，金额依据留在这一行
  assert.equal(group().commonSummary, null);
  assert.deepEqual([group().windowGroups[0].totals.knownIncomeUsd, group().windowGroups[0].totals.knownCostUsd, group().windowGroups[0].totals.attentionRuleIds], [null, null, ["bill"]]);
  assert.equal(row.upstream.amountUsd, 2);
});

// 已固定看有没有固定下来（settledAt），不再看窗口是否整天结束。
test("今天的窗口直接汇总实时毛利；界面状态区分实时、已固定和需处理", () => {
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
  assert.equal(reconciliationDisplayStatus(row, { now }).state, "live", "截至当前时刻的窗口仍是实时");
  assert.equal(reconciliationDisplayStatus({ ...dailyViewRow("settled", 3), settledAt: "2026-10-08T16:05:00Z" }, { now }).state, "settled");
  assert.equal(reconciliationDisplayStatus(dailyViewRow("ended", 3), { now }).state, "live", "结束了但还没固定下来");
  const partial = dailyViewRow("partial", 3), past = { ...today, preset: "custom", startMs: today.startMs - 86400000 + 3600000, endMs: today.startMs - 3600000 };
  for (const side of [partial.upstream, partial.downstream]) side.window = past;
  Object.assign(partial, { window: past, requestedWindow: past });
  assert.equal(reconciliationDisplayStatus(partial, { now }).state, "live", "早已结束的非整日窗口不固定");
  const waiting = { ...dailyViewRow("waiting", 3), calculation: { profitUsd: null, riskDifferenceUsd: 2 }, health: { code: "WAITING_FOR_BILL", issues: [] } };
  assert.equal(reconciliationDisplayStatus(waiting, { now }).state, "live");
  const broken = { ...dailyViewRow("broken", 3), calculation: { profitUsd: null }, health: { code: "KEY_INVALID_OR_DENIED", issues: [] } };
  assert.equal(reconciliationDisplayStatus(broken, { now }).state, "action");
  const legacyDuplicate = { ...dailyViewRow("dup", 3), settledAt: "2026-10-08T16:05:00Z", health: { code: "READY", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT" }] } };
  assert.notEqual(reconciliationDisplayStatus(legacyDuplicate, { now }).state, "settled", "旧记录里的重复归属毛利不当作已固定");
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

test("3b 固定采购关联所在站点不在我的站点摊销范围时点名，每个站点一次", () => {
  const stations = { amortized: { id: "amortized", name: "摊销中" }, off: { id: "off", name: "不摊销" }, usage: { id: "usage", name: "按用量" } };
  const on = (id, host, costBasis = "fixed") => ({ ...ratedRow(id, 3, 1, { costBasis }), rule: { ...ratedRow(id, 3, 1).rule, upstreamStationId: host } });
  const rows = [on("r1", "amortized"), on("r2", "off"), on("r3", "off"), on("r4", "usage", "usage"), on("r5", "deleted")];
  assert.deepEqual(fixedOffProfitStations(rows, { amortizedIds: ["amortized"], stationOf: (id) => stations[id] || null }), [{ id: "off", name: "不摊销" }]);
  assert.deepEqual(fixedOffProfitStations(rows, { amortizedIds: ["amortized", "off"], stationOf: (id) => stations[id] || null }), []);
  assert.deepEqual(fixedOffProfitStations(rows, { stationOf: (id) => stations[id] || null }), [{ id: "amortized", name: "摊销中" }, { id: "off", name: "不摊销" }]);
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
  assert.equal(reconciliationDisplayStatus(fixed, { now: NOW }).state, "live", "还没固定下来");
  assert.equal(reconciliationDisplayStatus({ ...fixed, settledAt: "2026-10-08T16:05:00Z" }, { now: NOW }).state, "settled");
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
  assert.notEqual(reconciliationDisplayStatus(usage, { now: NOW }).state, "settled");
  // 要人动手的马上出；读取类的过了 7 天才出，几个读取问题共用一个「重新读取」
  // 「Key 属于哪个上游账号」没确认：系统自己试读，不出「测试读取」，读取类的过了 7 天才出「重新读取」
  assert.deepEqual(reconciliationResultActions(usage, { now: NOW }).map((action) => action.kind), []);
  assert.deepEqual(reconciliationResultActions(usage, { now: LATE }).map((action) => action.kind), ["retry_bill"]);
  const usageCoverage = deriveKnownChannelCoverage(catalogue(usage), [usage.rule], [usage]);
  assert.equal(usageCoverage.channels[0].status, "row_attention", "身份没确认不再是渠道自己的原因，这行自己是需处理就照这行说");
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

test("4a 固定采购上游：Key 还有没有其他用途没确认不影响渠道覆盖和汇总毛利；按用量的也不再问", () => {
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
  // 新口径：不再问「这把 Key 还给别处用吗」，按用量的也一样照常算
  assert.deepEqual([usageCoverage.channels[0].status, usageCoverage.channels[0].actions.map((action) => action.kind)], ["accounted", []]);
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
  assert.deepEqual(scoped({ billingEffectiveFrom: Date.parse("2026-10-08T06:30:00Z") }), ["从 10月8日 开始统计"], "当天中途绑上的也从那天 0 点算，不写 14:30");
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
  assert.equal(reconciliationAccountingStartText(rule({ billingEffectiveFrom: Date.parse("2026-10-08T06:30:00Z") }), zone, NOW), "10月8日", "当天中途绑上的：从那天 0 点算，只写日期");
  assert.equal(reconciliationAccountingStartText(rule({ billingEffectiveFrom: Date.parse("2026-10-08T06:30:00Z"), createdAt: "2026-10-08T02:00:00Z" }), zone, NOW), "10月8日");
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

test("渠道列表的事项：没绑定的渠道给「去绑定」，时区没确认不再给「测试读取」", () => {
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
  // 时区没确认：系统自己试读，渠道不出「测试读取」，只是还在读取
  assert.deepEqual(unverified.actions.map((action) => action.kind), []);
});

test("「这天重算的数比原来少了一半多」的确认框：标题写日期，收入和上游成本各一行（没变的也写），固定成本不写上游成本，不是这种日子没有框", () => {
  const item = { window: { startMs: Date.parse("2026-10-22T16:00:00Z"), timezone: "Asia/Shanghai" },
    displayStatus: { shrunk: { side: "revenue", before: { revenueUsd: 45.17, costUsd: 15.12 }, after: { revenueUsd: 12.4, costUsd: 15.1 } } } };
  assert.deepEqual(resettleShrunkConfirm(item, { now: NOW }), { title: "按重算的数固定 10月23日？",
    lines: ["收入：原来 $45.17，重算 $12.40", "上游成本：原来 $15.12，重算 $15.10"],
    hint: "会再读一次记录，按读到的数固定；原来的数不再留着。", okText: "重新读取", cancelText: "取消", after: { revenueUsd: 12.4, costUsd: 15.1 } });
  const fixed = { ...item, displayStatus: { shrunk: { side: "revenue", before: { revenueUsd: 10, costUsd: null }, after: { revenueUsd: 0, costUsd: null } } } };
  assert.deepEqual(resettleShrunkConfirm(fixed, { now: NOW }).lines, ["收入：原来 $10.00，重算 $0.00"]);
  assert.equal(resettleShrunkConfirm({ ...item, displayStatus: { state: "settled" } }, { now: NOW }), null);
  assert.equal(resettleShrunkConfirm(null), null);
});

test("C② 整天在开始统计之前的日子：不算状态（写「还没开始统计」和从哪天开始），收入、上游成本、毛利不算，不算进汇总，也不算需处理、不算还在读取", () => {
  const started = dailyViewRow("a", 3), before = dailyViewRow("b", 4);
  // b 从 10月9日 0:00 才开始统计，这天是 10月8日
  before.rule.billingEffectiveFrom = Date.parse("2026-10-08T16:00:00Z");
  assert.equal(reconciliationNotStarted(before), true);
  assert.equal(reconciliationNotStarted(started), false);
  const status = reconciliationDisplayStatus(before, { now: Date.parse("2026-10-09T05:00:00Z") });
  assert.deepEqual([status.state, status.label, status.note], ["not_started", "还没开始统计", "从 10月9日 开始统计"]);
  const flags = reconciliationRowFlags(before, "USD", { now: Date.parse("2026-10-09T05:00:00Z") });
  assert.deepEqual([flags.values.profit, flags.values.margin, flags.attention, flags.severity], [null, null, false, 4], "毛利写「—」，排在已固定后面");
  const { windowGroups } = summarizeReconciliationWindowGroups([started, before], { coverageFor: () => ({ state: "complete_known" }) });
  const totals = windowGroups[0].totals;
  assert.deepEqual([totals.confirmedProfitUsd, totals.attentionRuleIds, totals.readingRuleIds, totals.notStartedRuleIds], [2, [], [], ["b"]], "只加 a，b 单独记着");
  // 服务端算好的标记优先，旧数据没有标记时按开始统计的时刻比；旧版规则（没有开始统计的时刻）不判
  assert.equal(reconciliationNotStarted({ ...started, scope: { notEffective: true } }), true);
  assert.equal(reconciliationNotStarted({ ...started, rule: { ...started.rule, billingPolicy: "legacy-v3" } }), false);
});

// ---- 令牌作废、少了权限（用语规范 §5.2）：标题按拿得到的东西分三档，说明两种 ----
test("令牌少了权限：标题三档（上游名和少的那一项都有 / 只有上游名 / 都没有），自营站点一侧总有名字；说明在不知道少哪一项时让人照清单勾", () => {
  const item = (issue) => ({ health: { code: "ACCESS_TOKEN_SCOPE_DENIED", issues: [{ code: "ACCESS_TOKEN_SCOPE_DENIED", ...issue }] },
    window: { startMs: Date.UTC(2026, 9, 7), endMs: Date.UTC(2026, 9, 8), timezone: "Asia/Shanghai" }, rule: { id: "r1", upstreamStationId: "up", ownStationId: "own", channels: [] } });
  const status = (issue) => reconciliationDisplayStatus(item(issue), { now: Date.UTC(2026, 9, 9) });
  const upstreamScopes = "profile:read、api_key:read、usage:read", ownScopes = "profile:read、channel:read、log:read、user:read、usage:read、option:read";
  const known = "「usage:read」是 New API 说少了的那一项。给令牌补上这项权限，或者换一个带这项权限的令牌";
  const unknown = (scopes) => `New API 没说少的是哪一项。给令牌勾上这些权限：${scopes}，或者换一个带这些权限的令牌`;
  // 上游名和少的那一项都有
  let result = status({ side: "upstream", stationName: "主力", missingScope: "usage:read" });
  assert.deepEqual([result.state, result.title, result.detail], ["action", "上游「主力」的令牌少了「usage:read」的权限", known]);
  // 有上游名，不知道少的是哪一项：标题照样带上游名，说明让人照这一侧的清单勾
  result = status({ side: "upstream", stationName: "主力" });
  assert.deepEqual([result.title, result.detail], ["上游「主力」的令牌少了权限", unknown(upstreamScopes)]);
  // 连上游名都没有（拿不到名字）：标题不带名字；说明里的清单还是上游那一侧的
  result = status({ side: "upstream", stationName: "" });
  assert.deepEqual([result.title, result.detail], ["令牌少了权限", unknown(upstreamScopes)]);
  result = status({ side: "upstream", missingScope: "usage:read" });
  assert.deepEqual([result.title, result.detail], ["令牌少了权限", known], "有少的那一项但没有上游名：没有名字就用不带名字的那一句，说明照旧");
  // 自营站点一侧：对象总是「自营站点」，清单是自营站点那一侧的
  result = status({ missingScope: "log:read" });
  assert.deepEqual([result.title, result.detail], ["自营站点的令牌少了「log:read」的权限", known.replace("usage:read", "log:read")]);
  result = status({});
  assert.deepEqual([result.title, result.detail], ["自营站点的令牌少了权限", unknown(ownScopes)]);
  // 作废那一条：同样分两侧，清单从表里来
  const retired = reconciliationDisplayStatus({ ...item({ side: "upstream", stationName: "主力" }), health: { code: "ACCESS_TOKEN_LEGACY_RETIRED", issues: [{ code: "ACCESS_TOKEN_LEGACY_RETIRED", side: "upstream", stationName: "主力" }] } }, { now: Date.UTC(2026, 9, 9) });
  assert.deepEqual([retired.title, retired.detail.endsWith(upstreamScopes)], ["上游「主力」的访问令牌已经作废了", true]);
});

test("已固定、重算的事要处理的日子（审核 C3 中-2）：照算进汇总、毛利照显示，只多一句提示；有别的问题的照旧不算", () => {
  const now = Date.parse("2026-10-09T05:00:00Z");
  const held = dailyViewRow("a", 4); held.settledAt = "2026-10-09T00:10:00Z";
  held.health = { code: "READY", issues: [{ code: "RESETTLE_SHRUNK", scope: "history", detail: "", shrunk: { side: "revenue", before: { revenueUsd: 4, costUsd: 1 }, after: { revenueUsd: 0, costUsd: 1 } } }] };
  const normal = dailyViewRow("b", 3);
  const status = reconciliationDisplayStatus(held, { now });
  assert.deepEqual([status.state, status.action.code, heldOldNumber(held)], ["action", "RESETTLE_SHRUNK", true]);
  assert.equal(countsInSummary(held), true);
  assert.equal(reconciliationRowFlags(held, "USD", { now }).values.profit, 3, "毛利照显示，不写「—」");
  assert.equal(reconciliationRowFlags(held, "USD", { now }).attention, true, "仍标需处理");
  const { windowGroups } = summarizeReconciliationWindowGroups([held, normal], { coverageFor: () => ({ state: "complete_known" }) });
  const totals = windowGroups[0].totals;
  assert.deepEqual([totals.confirmedProfitUsd, totals.attentionRuleIds, totals.heldRuleIds], [5, [], ["a"]]);
  // 还有别的问题（比如来源没确认）或账本里没有这天：照旧需处理、不算
  const other = { ...held, health: { ...held.health, issues: [...held.health.issues, { code: "SOURCE_BINDING_UNCONFIRMED", scope: "source", detail: "" }] } };
  assert.equal(heldOldNumber(other), false);
  assert.equal(countsInSummary(other), false);
  assert.equal(heldOldNumber({ ...held, settledAt: null }), false, "账本里没有这天");
});

test("K2b：「检查连接」去自营站点的抽屉（读取服务令牌那一栏），不是这条绑定的上游；KEY_REVEAL_DENIED 的「更新登录信息」去缺权限的那个上游，没带就退回绑定自己的上游", () => {
  const row = (code, extra = {}) => {
    const item = dailyViewRow("k", 3);
    item.health = { code, issues: [], sinceMs: DAY_START, ...extra };
    return item;
  };
  const reader = reconciliationDisplayStatus(row("KEY_READER_UNREACHABLE"), { now: LATE });
  assert.equal(reader.action.kind, "check_connection");
  assert.match(reader.action.href, /edit=own(?:&|$)/, "自营站点（rule.ownStationId），不是上游 up");
  const badUrl = reconciliationDisplayStatus(row("KEY_AGENT_URL_INVALID"), { now: LATE });
  assert.equal(badUrl.title, "读取服务的地址不对");
  assert.equal(badUrl.action.kind, "fix_agent_url");
  assert.match(badUrl.action.href, /edit=own&focus=keyAgentUrl$/);
  const badToken = reconciliationDisplayStatus(row("KEY_AGENT_UNAUTHORIZED"), { now: LATE });
  assert.equal(badToken.title, "读取服务的令牌对不上");
  assert.equal(badToken.action.kind, "fix_agent_token");
  assert.match(badToken.action.href, /edit=own&focus=keyAgentSecret$/);
  const denied = reconciliationDisplayStatus(row("KEY_REVEAL_DENIED", { upstreamStationId: "up-other" }), { now: LATE });
  assert.equal(denied.action.kind, "update_authorization");
  assert.match(denied.action.href, /stationId=up-other(?:&|$)/, "缺权限的那个上游");
  const fallback = reconciliationDisplayStatus(row("KEY_REVEAL_DENIED"), { now: LATE });
  assert.match(fallback.action.href, /stationId=up(?:&|$)/, "没带就退回绑定自己的上游");
});

test("K2b：实时「今天」窗口（endMs 就是取数时刻）里也出「今天 14:30 换了 Key」", () => {
  const T0 = Date.UTC(2026, 9, 11, 16); // 上海 10-12 0:00
  const at = (h, m) => T0 + (h * 60 + m) * 60000;
  const seg = (from, extra = {}) => ({ effectiveFrom: from, ratio: 1, timingSource: "detected", ...extra });
  const live = { window: { startMs: T0, endMs: at(15, 0), timezone: "Asia/Shanghai", preset: "today" },
    transitionSegments: [seg(0), seg(at(14, 29), { timingSource: "key_change_window" }), seg(at(14, 30), { timingSource: "key_change" })], segments: [] };
  assert.equal(reconciliationKeyChange(live, "Asia/Shanghai", at(15, 0)), "今天 14:30 换了 Key");
  assert.equal(reconciliationKeyChange(live, "Asia/Shanghai", T0 + 3 * 86400000), "14:30 换了 Key", "过了几天再看：不写今天");
});

test("KEY_INVALID_OR_DENIED 按情况分开写：找不到 Key（去换 Key）、被拒（说明改写、按钮更新登录信息）、没带情况的还是原来那句；详细原因（diagnostic）原样带到需处理上，读取类过了 7 天也带", () => {
  const rule = { id: "r1", upstreamStationId: "up", ownStationId: "own", channels: [{ channelId: 1 }] };
  const now = Date.parse("2026-10-30T10:00:00Z"), window = { startMs: now - 3600000, endMs: now, timezone: "Asia/Shanghai" };
  const status = (health, w = window) => reconciliationDisplayStatus({ rule, window: w, requestedWindow: w, health, calculation: {}, downstream: {}, upstream: {} }, { now });
  const missing = status({ code: "KEY_INVALID_OR_DENIED", variant: "missing", issues: [] });
  assert.deepEqual([missing.title, missing.detail, missing.action.kind, missing.action.label], ["上游里找不到这把 Key", "可能在上游删了或重建了，换成渠道现在用的那把", "go_swap_key", "去换 Key"]);
  const denied = status({ code: "KEY_INVALID_OR_DENIED", variant: "denied", diagnostic: "HTTP 403 · /api/log/self/stat · 上游回：无权", issues: [] });
  assert.deepEqual([denied.title, denied.detail, denied.action.kind, denied.diagnostic], ["上游拒绝读取这把 Key", "上游不让查这把 Key 的用量：可能是登录过期，也可能是这个上游关了日志查询", "update_authorization", "HTTP 403 · /api/log/self/stat · 上游回：无权"]);
  const plain = status({ code: "KEY_INVALID_OR_DENIED", issues: [] });
  assert.deepEqual([plain.title, plain.detail, plain.diagnostic], ["上游拒绝读取这把 Key", "Key 可能已被删除，或上游的登录信息过期了", undefined]);
  // 读取类（超时）：当天不是需处理；过了 7 天升成需处理，气泡里带着详细原因
  const old = { startMs: now - 9 * 86400000, endMs: now - 8 * 86400000, timezone: "Asia/Shanghai" };
  assert.equal(status({ code: "UPSTREAM_DATA_UNAVAILABLE", diagnostic: "/api/log/self/stat · 错误：timeout", issues: [] }).state, "live");
  const late = status({ code: "UPSTREAM_DATA_UNAVAILABLE", diagnostic: "/api/log/self/stat · 错误：timeout", issues: [] }, old);
  assert.deepEqual([late.state, late.diagnostic], ["action", "/api/log/self/stat · 错误：timeout"]);
});
