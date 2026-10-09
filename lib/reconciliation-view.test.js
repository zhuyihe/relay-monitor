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
} from "./reconciliation-view.js";

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

  assert.deepEqual(flags.status, { label: "对账结果保存失败", tone: "danger" });
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
