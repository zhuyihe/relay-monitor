import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  hasReconciliationHistory,
  summarizeReconciliationFreshness,
  reconciliationRowFlags,
  filterReconciliationResults,
  formatReconciliationMoney,
  reconciliationBillingBasis,
  reconciliationCalculationValues,
  summarizeReconciliationTotals,
  summarizeReconciliationWindowGroups,
  deriveKnownChannelCoverage,
  reconciliationSettlement,
  reconciliationRowCurrency,
  reconciliationDisplayCurrency,
  reconciliationRateFactors,
  sameReconciliationWindow,
  summarizeUnaccountedUpstream,
  formatReconciliationAmount,
} from "./reconciliation-view.js";
import { isCompletedBillingWindow } from "./reconciliation-scope-policy.js";

test("微额金额保留可辨认的数值和符号，零金额仍显示零", () => {
  assert.equal(formatReconciliationMoney(-0.0001, null), "-$0.0001");
  assert.equal(formatReconciliationMoney(0.001, null), "$0.001");
  assert.equal(formatReconciliationMoney(-0.0001, 7), "-¥0.0007");
  assert.equal(formatReconciliationMoney(0, null), "$0.00");
  assert.equal(formatReconciliationMoney(1234.5, null), "$1,234.50");
  assert.equal(formatReconciliationMoney(null, null), "—");
  assert.equal(formatReconciliationMoney(-1e-10, null), "-$1.00e-10");
});

test("账单依据展示未舍入的金额及来源 quota", () => {
  assert.equal(reconciliationBillingBasis({ state: "complete", quotaUnits: 1, quotaPerUnit: 10000, amountUsd: 0.0001 }), "1 ÷ 10,000 = 0.0001 USD");
  assert.equal(reconciliationBillingBasis({ state: "complete", amountUsd: 0.0001 }), "0.0001 USD");
  assert.equal(reconciliationBillingBasis({ state: "complete", amountUsd: -0.0001996 }), "-0.0001996 USD");
  assert.equal(reconciliationBillingBasis({ amountUsd: 0.0001 }), "—（旧版待刷新）");
  assert.equal(reconciliationBillingBasis(null), "—（旧版待刷新）");
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

test("混合新鲜与过期结果只使用过期规则的成功覆盖时间", () => {
  const summary = summarizeReconciliationFreshness([
    { health: { stale: false }, window: { endMs: 9000 }, lastSuccessfulWindow: { endMs: 9000 } },
    { health: { stale: true }, window: { endMs: 9000 }, lastSuccessfulWindow: { endMs: 5000 } },
  ]);

  assert.deepEqual(summary, { staleCount: 1, coverageEndMs: 5000 });
});

test("搜索可按上游、Key、分组和销售渠道过滤，负毛利不冒充健康", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const results = [
    { calculationVersion: 3, requestedWindow: currentWindow, rule: { upstreamStationId: "s1", tokenName: "awsb-3", channels: [{ channelId: 1, name: "小福星-awsb" }] }, currentSegment: { group: "AWS-Bedrock2" }, downstream: { state: "complete", amountUsd: 10, window: currentWindow }, upstream: { state: "complete", amountUsd: 12, window: currentWindow }, health: { code: "READY" }, calculation: { profitUsd: -2 } },
    { rule: { upstreamStationId: "s2", tokenName: "oai", channels: [{ channelId: 2, name: "OpenAI 出口" }] }, currentSegment: { group: "oai" }, health: { code: "READY" }, calculation: { profitUsd: 4 } },
  ];
  const upstreams = [{ id: "s1", name: "小福星" }, { id: "s2", name: "另一上游" }];
  for (const search of ["小福星", "awsb-3", "Bedrock2", "小福星-awsb"]) {
    assert.deepEqual(filterReconciliationResults(results, upstreams, search).map((item) => item.rule.tokenName), ["awsb-3"]);
  }
  assert.deepEqual(filterReconciliationResults(results, upstreams, "ID 2").map((item) => item.rule.tokenName), ["oai"]);
  assert.deepEqual(filterReconciliationResults(results, upstreams, "", "negative").map((item) => item.rule.tokenName), ["awsb-3"]);
  assert.deepEqual(filterReconciliationResults(results, upstreams, "", "attention").map((item) => item.rule.tokenName), ["awsb-3"]);
  assert.equal(reconciliationRowFlags(results[0]).pending, false);
  assert.equal(reconciliationRowFlags(results[0]).negative, true);
  assert.equal(reconciliationRowFlags(results[0]).attention, false);
});

test("只有真实检测到切换的规则进入待确认筛选", () => {
  const stable = { rule: { tokenName: "stable" }, health: { code: "READY" }, segments: [{ group: "A", timingSource: "initial" }] };
  const changed = { rule: { tokenName: "changed" }, health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, transitionSegments: [], segments: [{ group: "A", timingSource: "initial" }, { group: "B", timingSource: "detected" }] };
  assert.deepEqual(filterReconciliationResults([stable, changed], [], "", "pending"), [changed]);
  assert.equal(reconciliationRowFlags({ health: {}, calculation: {} }).attention, true);
});

test("严重账单错误优先于仍待确认的切换状态", () => {
  const item = {
    health: { code: "UPSTREAM_DATA_UNAVAILABLE", issues: [{ code: "SEGMENT_TIMING_UNCONFIRMED" }] },
    transitionSegments: [{ timingSource: "detected" }],
  };
  assert.deepEqual(reconciliationRowFlags(item).status, { label: "上游账单数据不可用", tone: "danger" });
});

test("非切换告警与旧账单优先于待确认，纯切换和负毛利仍按原优先级展示", () => {
  const pending = [{ timingSource: "detected" }];
  for (const [code, label] of [
    ["UPSTREAM_EMPTY_WITH_SALES", "本站有收费但上游无消费"],
    ["SALES_CHANNEL_DISABLED", "本站销售渠道已禁用"],
    ["OWN_FLOW_INCOMPLETE", "旧版本站收费数据不完整"],
  ]) {
    assert.equal(reconciliationRowFlags({ health: { code }, transitionSegments: pending }).status.label, label);
  }
  assert.equal(reconciliationRowFlags({ health: { code: "READY", stale: true }, transitionSegments: pending }).status.label, "数据过期");
  assert.equal(reconciliationRowFlags({ health: { code: "ROUTE_TRANSITION_DETECTED" }, transitionSegments: pending }).status.label, "待确认");
  assert.equal(reconciliationRowFlags({ health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, transitionSegments: pending }).status.label, "待确认");
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  assert.equal(reconciliationRowFlags({ calculationVersion: 3, requestedWindow: currentWindow, health: { code: "UPSTREAM_EMPTY_WITH_SALES" }, transitionSegments: pending, downstream: { state: "complete", amountUsd: 1, window: currentWindow }, upstream: { state: "complete", amountUsd: 2, window: currentWindow }, calculation: { profitUsd: -1 } }).status.label, "负毛利");
});

test("负毛利与本站渠道禁用同时显示，不把禁用渠道的历史账单归零", () => {
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
  const flags = reconciliationRowFlags(item);
  assert.equal(flags.status.label, "负毛利");
  assert.deepEqual(flags.secondaryStatuses, [{ label: "渠道禁用 1", tone: "warning" }]);
  assert.equal(summarizeReconciliationTotals([item]).income, 0.0001);
  assert.equal(summarizeReconciliationTotals([item]).profit, -0.0001996);
});

test("默认和需处理列表按严重错误、负毛利、待确认、健康排序", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const results = [
    { rule: { tokenName: "healthy" }, health: { code: "READY" }, calculation: { profitUsd: 10 } },
    { rule: { tokenName: "pending" }, health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, transitionSegments: [{ timingSource: "detected" }] },
    { calculationVersion: 3, requestedWindow: currentWindow, rule: { tokenName: "negative" }, downstream: { state: "complete", amountUsd: 10, window: currentWindow }, upstream: { state: "complete", amountUsd: 12, window: currentWindow }, health: { code: "READY" }, calculation: { profitUsd: -2 } },
    { rule: { tokenName: "unavailable" }, health: { code: "UPSTREAM_DATA_UNAVAILABLE" } },
  ];
  assert.deepEqual(filterReconciliationResults(results).map((item) => item.rule.tokenName), ["unavailable", "negative", "pending", "healthy"]);
  assert.deepEqual(filterReconciliationResults(results, [], "", "attention").map((item) => item.rule.tokenName), ["unavailable", "negative", "pending"]);
});

test("风险差额缺失不能被汇总成零，真实零账单仍显示零", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const sides = { downstream: { state: "partial", window: currentWindow }, upstream: { state: "partial", window: currentWindow } };
  const missing = { ...sides, calculationVersion: 3, requestedWindow: currentWindow, health: { code: "UPSTREAM_DATA_UNAVAILABLE" }, calculation: { profitUsd: null, riskDifferenceUsd: null } };
  const zero = { ...sides, calculationVersion: 3, requestedWindow: currentWindow, health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, calculation: { profitUsd: null, riskDifferenceUsd: 0 } };
  assert.equal(summarizeReconciliationTotals([missing]).riskDifference, null);
  assert.equal(summarizeReconciliationTotals([zero]).riskDifference, 0);
  assert.equal(summarizeReconciliationTotals([missing, zero]).riskDifference, null);
});

test("汇总保留两侧已获取小计，利润与毛利率只使用同窗确认规则", () => {
  const currentWindow = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const summary = summarizeReconciliationTotals([
    {
      calculationVersion: 3, requestedWindow: currentWindow,
      downstream: { state: "complete", amountUsd: 100, knownAmountUsd: 100, successfulCount: 1, expectedCount: 1, window: currentWindow },
      upstream: { state: "complete", amountUsd: 70, knownAmountUsd: 70, successfulCount: 1, expectedCount: 1, window: currentWindow },
      calculation: { profitUsd: 30, marginRate: 0.3 },
      health: { code: "READY" },
    },
    {
      calculationVersion: 3, requestedWindow: currentWindow,
      downstream: { state: "partial", amountUsd: null, knownAmountUsd: 40, successfulCount: 1, expectedCount: 2, window: currentWindow },
      upstream: { state: "unavailable", amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: 1, window: currentWindow },
      calculation: { profitUsd: null },
      health: { code: "OWN_BILLING_UNAVAILABLE" },
    },
    {
      calculationVersion: 3, requestedWindow: currentWindow,
      downstream: { state: "unavailable", amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: 1, window: currentWindow },
      upstream: { state: "partial", amountUsd: null, knownAmountUsd: 20, successfulCount: 1, expectedCount: 2, window: currentWindow },
      calculation: { profitUsd: null },
      health: { code: "UPSTREAM_DATA_UNAVAILABLE" },
    },
  ]);

  assert.equal(summary.income, 140);
  assert.equal(summary.cost, 90);
  assert.equal(summary.profit, 30);
  assert.equal(summary.confirmedIncome, 100);
  assert.equal(summary.confirmedMarginRate, 0.3);
  assert.deepEqual(summary.incomeCoverage, { complete: 1, partial: 1, missing: 1, successfulCount: 2, expectedCount: 4 });
  assert.deepEqual(summary.costCoverage, { complete: 1, partial: 1, missing: 1, successfulCount: 2, expectedCount: 4 });
  assert.deepEqual(summary.profitCoverage, { confirmed: 1, missing: 2 });
});

test("旧参考、过期结果和不同时窗的完整金额不进入当前汇总或利润", () => {
  const summary = summarizeReconciliationTotals([
    {
      calculationVersion: 3,
      health: { code: "READY", stale: true },
      requestedWindow: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" },
      downstream: { state: "complete", amountUsd: 100, window: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" } },
      upstream: { state: "complete", amountUsd: 70, window: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" } },
      calculation: { profitUsd: 30 },
      lastConfirmed: { downstream: { amountUsd: 100 }, upstream: { amountUsd: 70 }, calculation: { profitUsd: 30 } },
    },
    {
      calculationVersion: 3,
      health: { code: "READY" },
      requestedWindow: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" },
      downstream: { state: "complete", amountUsd: 40, window: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" } },
      upstream: { state: "complete", amountUsd: 10, window: { startMs: 11, endMs: 20, timezone: "Asia/Shanghai" } },
      calculation: { profitUsd: 30 },
    },
    {
      calculationVersion: 3,
      health: { code: "READY" },
      requestedWindow: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" },
      downstream: { state: "complete", amountUsd: 5, window: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" } },
      upstream: { state: "complete", amountUsd: 2, window: { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" } },
      calculation: { differenceUsd: 3 },
    },
  ]);

  assert.equal(summary.income, 45);
  assert.equal(summary.cost, 2);
  assert.equal(summary.profit, null);
  assert.equal(summary.confirmedIncome, 0);
});

test("归属未知保留raw账单，汇总只计counted成本；旧DTO兼容且不能确认重复利润", () => {
  const window = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const row = { calculationVersion: 3, window, health: { code: "COST_OWNER_UNVERIFIED" },
    upstream: { state: "complete", amountUsd: 1, knownAmountUsd: 1, countedAmountUsd: null, ownershipState: "unknown", window },
    downstream: { state: "complete", amountUsd: 2.5, window }, calculation: { profitUsd: 1.5 } };
  const unknown = summarizeReconciliationTotals([row]);
  assert.equal(unknown.cost, null);
  assert.equal(unknown.costComplete, false);
  assert.equal(unknown.income, 2.5);
  assert.equal(unknown.profit, null);
  assert.equal(reconciliationBillingBasis(row.upstream), "1 USD", "真实费用仍可展示依据");
  const duplicates = [row, row].map((item, index) => ({ ...item, upstream: { ...item.upstream,
    ownershipState: "duplicate", countedAmountUsd: index === 0 ? 1 : null } }));
  const duplicated = summarizeReconciliationTotals(duplicates);
  assert.equal(duplicated.cost, 1);
  assert.equal(duplicated.profit, null);
  assert.equal(row.upstream.amountUsd, 1);
  const legacy = { ...row, upstream: { state: "complete", amountUsd: 1, window } };
  assert.equal(summarizeReconciliationTotals([legacy]).cost, 1);
});

test("分组目录异常保留为独立文字告警，不把已知账单改成全条不可用", () => {
  const flags = reconciliationRowFlags({
    health: { code: "GROUP_DATA_UNAVAILABLE" },
    downstream: { state: "complete", amountUsd: 0 },
    upstream: { state: "complete", amountUsd: 2 },
  });

  assert.deepEqual(flags.status, { label: "当前上游分组目录不可用", tone: "warning" });
  assert.equal(flags.attention, true);
});

test("单规则保存失败是需处理的严重状态，不影响其他规则的汇总资格", () => {
  const flags = reconciliationRowFlags({ health: { code: "PERSISTENCE_FAILED" } });

  assert.deepEqual(flags.status, { label: "核算结果保存失败", tone: "danger" });
  assert.equal(flags.attention, true);
  assert.equal(flags.severity, 0);
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
  const wrongRequestedWindow = {
    ...confirmed,
    requestedWindow: { startMs: 11, endMs: 20, timezone: "Asia/Shanghai" },
    calculation: { profitUsd: null, riskDifferenceUsd: 2 },
  };

  assert.equal(reconciliationCalculationValues(confirmed.calculation, confirmed.health, confirmed).confirmed, true);
  assert.equal(reconciliationRowFlags(confirmed).negative, true);
  assert.equal(reconciliationCalculationValues(legacy.calculation, legacy.health, legacy).confirmed, false);
  assert.equal(reconciliationRowFlags(legacy).negative, false);

  const summary = summarizeReconciliationTotals([confirmed, legacy, wrongRequestedWindow]);
  assert.equal(summary.income, 10);
  assert.equal(summary.cost, 12);
  assert.equal(summary.profit, -2);
  assert.equal(summary.riskDifference, null);
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

test("U05公开view对重复渠道采用同窗最新成功金额，保留raw且搜索/分页不更改全量聚合", () => {
  const rows = [dailyViewRow("older", 2), dailyViewRow("newer", 3, { observedAt: 2 })];
  for (const row of rows) row.health = { code: "DUPLICATE_CHANNEL_ASSIGNMENT", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT" }] };
  const isCompletedWindow = (window) => isCompletedBillingWindow(window, Date.parse("2026-10-09T00:00:00Z"));
  const catalogue = { ownSource: rows[0].ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] };
  const coverage = deriveKnownChannelCoverage(catalogue, rows.map((row) => row.rule), rows, { isCompletedWindow });
  const full = summarizeReconciliationWindowGroups(rows, { isCompletedWindow, coverageFor: () => coverage });
  assert.deepEqual([full.windowGroups[0].totals.knownIncomeUsd, full.windowGroups[0].totals.knownCostUsd, full.windowGroups[0].totals.confirmedProfitUsd], [3, 2, null]);
  assert.equal(coverage.channels[0].status, "duplicate"); assert.equal(coverage.accountedChannelCount, 0);
  assert.equal(reconciliationCalculationValues(rows[0].calculation, rows[0].health, rows[0]).confirmed, false);
  const filtered = filterReconciliationResults(rows, [], "older");
  assert.equal(filtered.length, 1); assert.equal(filtered[0].downstream.amountUsd, 2);
  assert.equal(rows[1].downstream.amountUsd, 3); assert.equal(full.windowGroups[0].totals.knownIncomeUsd, 3);
  assert.equal(rows.slice(0, 1).length, 1); assert.equal(full.windowGroups[0].coverage.knownChannelCount, 1);
});

test("U05公开view保留0/负确认毛利，未知时区/实际窗口不匹配阻止确认并保持金额依据", () => {
  const row = dailyViewRow("bill", 1);
  const isCompletedWindow = (window) => isCompletedBillingWindow(window, Date.parse("2026-10-09T00:00:00Z"));
  const coverage = { state: "complete_known" };
  const group = () => summarizeReconciliationWindowGroups([row], { isCompletedWindow, coverageFor: () => coverage });
  assert.equal(group().windowGroups[0].totals.confirmedProfitUsd, 0);
  row.calculation.profitUsd = -1; row.upstream.amountUsd = 2; row.upstream.countedAmountUsd = 2;
  assert.equal(group().commonSummary.totals.confirmedProfitUsd, -1);
  row.billingTimezone = { state: "unverified", timezone: row.window.timezone };
  assert.equal(group().commonSummary, null); assert.equal(group().windowGroups[0].totals.confirmedProfitUsd, null);
  assert.equal(reconciliationCalculationValues(row.calculation, row.health, row).confirmed, false);
  assert.equal(reconciliationBillingBasis(row.upstream), "2 USD");
  row.billingTimezone.state = "verified"; row.upstream.window = { ...row.window, endMs: row.window.endMs - 1000 };
  row.health.issues = [{ code: "BILLING_WINDOW_MISMATCH" }];
  assert.equal(group().commonSummary, null); assert.equal(group().windowGroups[0].totals.knownIncomeUsd, 1);
  assert.equal(group().windowGroups[0].totals.knownCostUsd, null); assert.equal(row.upstream.amountUsd, 2);
});

test("今天的窗口直接汇总实时毛利；结账状态区分实时、已结账、已结束、待结账和不可用", () => {
  const now = Date.parse("2026-10-09T05:00:00Z");
  const isCompletedWindow = (window) => isCompletedBillingWindow(window, now);
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
  assert.equal(reconciliationSettlement(row, { isCompletedWindow }), "live");
  assert.equal(reconciliationSettlement(dailyViewRow("settled", 3), { isCompletedWindow }), "settled");
  const isEndedWindow = (range) => range.endMs <= now - 15 * 60000;
  assert.equal(reconciliationSettlement(row, { isCompletedWindow, isEndedWindow }), "live", "截至当前时刻的窗口仍是实时");
  const partial = dailyViewRow("partial", 3), past = { ...today, preset: "custom", startMs: today.startMs - 86400000 + 3600000, endMs: today.startMs - 3600000 };
  for (const side of [partial.upstream, partial.downstream]) side.window = past;
  Object.assign(partial, { window: past, requestedWindow: past });
  assert.equal(reconciliationSettlement(partial, { isCompletedWindow, isEndedWindow }), "ended", "早已结束的非整日窗口不结账，也不再是实时");
  assert.equal(reconciliationSettlement(dailyViewRow("settled", 3), { isCompletedWindow, isEndedWindow }), "settled");
  const waiting = { ...dailyViewRow("waiting", 3), calculation: { profitUsd: null, riskDifferenceUsd: 2 }, health: { code: "WAITING_FOR_BILL", issues: [] } };
  assert.equal(reconciliationSettlement(waiting, { isCompletedWindow }), "pending");
  const broken = { ...dailyViewRow("broken", 3), calculation: { profitUsd: null }, health: { code: "KEY_INVALID_OR_DENIED", issues: [] } };
  assert.equal(reconciliationSettlement(broken, { isCompletedWindow }), "unavailable");
  const legacyDuplicate = { ...dailyViewRow("dup", 3), health: { code: "READY", issues: [{ code: "DUPLICATE_CHANNEL_ASSIGNMENT" }] } };
  assert.notEqual(reconciliationSettlement(legacyDuplicate, { isCompletedWindow }), "settled", "旧快照里的重复归属毛利不当作已结账");
});

test("修改后今天按新配置重算时给出次要标签，不改变主状态", () => {
  const row = dailyViewRow("edited", 3);
  const plain = reconciliationRowFlags(row);
  const flags = reconciliationRowFlags({ ...row, scope: { recalculated: true } });
  assert.deepEqual(flags.status, plain.status);
  assert.deepEqual(flags.secondaryStatuses, [{ label: "已按新配置重算", tone: "neutral" }]);
  assert.deepEqual(plain.secondaryStatuses, []);
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
  assert.equal(reconciliationRowFlags(fixed).negative, false, "固定采购上游的用量不计成本，不算负毛利");
  assert.equal(reconciliationRowFlags(ratedRow("loss", 1, 2)).negative, true);
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
  assert.equal(sameReconciliationWindow(live(start + 1000), live(start + 2000)), true);
  assert.equal(sameReconciliationWindow(live(start + 1000), { ...live(start + 1000), preset: "custom" }), false);
  assert.equal(sameReconciliationWindow({ preset: "custom", startMs: start, endMs: 1 }, { preset: "custom", startMs: start, endMs: 2 }), false);
  assert.equal(sameReconciliationWindow({ startMs: start, endMs: 1 }, { startMs: start, endMs: 1 }), true);
  assert.equal(sameReconciliationWindow(null, live(1)), false);
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
    accountUsd: 2, accountedUsd: 1.5, unaccountedUsd: 0.5, account: 12, accounted: 9, unaccounted: 3 });
  const usd = summarizeUnaccountedUpstream([{ station, rate: { cnyPerUsd: 1, source: "default" }, usage: { usd: 2, mode: "api" } }], rows, { currency: "CNY" });
  assert.deepEqual([usd.currency, usd.total, usd.accounts[0].rate], ["USD", 0.5, null], "缺汇率按 USD 原值");
  assert.equal(summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], rows).currency, "USD", "默认 USD");
  const pending = summarizeUnaccountedUpstream([{ station, rate: configured, usage: null }, { station: { id: "b", name: "B" }, rate: configured, usage: { usd: 1 } }], rows);
  assert.deepEqual([pending.state, pending.total, pending.accounts[0].state], ["pending", null, "pending"]);
  const unavailable = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: null, mode: "unavailable", note: "上游用量读取失败" } }], rows);
  assert.deepEqual([unavailable.state, unavailable.total, unavailable.accounts[0].notes], ["partial", 0, ["上游用量读取失败"]]);
  const estimated = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 1, mode: "history" }, approximate: true }], rows);
  assert.equal(estimated.state, "estimated");
  assert.deepEqual(estimated.accounts[0].notes, ["Sub2API 用量按自然日返回，自定义时段按整日计", "已核算成本高于账号扣费，多为两边取数时刻不同或上游扣费尚未入账"]);
  assert.equal(estimated.accounts[0].unaccountedUsd, -0.5, "负数照实给出，不吞掉");
  rows[1].upstream.state = "partial";
  const partial = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], rows);
  assert.deepEqual([partial.state, partial.accounts[0].notes], ["partial", ["部分关联的上游成本未取全，已核算金额偏低"]]);
  assert.deepEqual(summarizeUnaccountedUpstream([], rows), { state: "complete", currency: "USD", total: 0, accounts: [] });
});
