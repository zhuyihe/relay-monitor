import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  summarizeReconciliationFreshness,
  reconciliationRowFlags,
  filterReconciliationResults,
  formatReconciliationMoney,
  reconciliationBillingBasis,
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
  assert.equal(reconciliationBillingBasis({ quotaUnits: 1, quotaPerUnit: 10000, amountUsd: 0.0001 }), "1 ÷ 10,000 = 0.0001 USD");
  assert.equal(reconciliationBillingBasis({ amountUsd: 0.0001 }), "0.0001 USD");
  assert.equal(reconciliationBillingBasis({ amountUsd: -0.0001996 }), "-0.0001996 USD");
  assert.equal(reconciliationBillingBasis(null), "—");
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

test("混合新鲜与过期结果只使用过期规则的成功覆盖时间", () => {
  const summary = summarizeReconciliationFreshness([
    { health: { stale: false }, window: { endMs: 9000 }, lastSuccessfulWindow: { endMs: 9000 } },
    { health: { stale: true }, window: { endMs: 9000 }, lastSuccessfulWindow: { endMs: 5000 } },
  ]);

  assert.deepEqual(summary, { staleCount: 1, coverageEndMs: 5000 });
});

test("搜索可按上游、Key、分组和销售渠道过滤，负毛利不冒充健康", () => {
  const results = [
    { rule: { upstreamStationId: "s1", tokenName: "awsb-3", channels: [{ channelId: 1, name: "小福星-awsb" }] }, currentSegment: { group: "AWS-Bedrock2" }, health: { code: "READY" }, calculation: { profitUsd: -2 } },
    { rule: { upstreamStationId: "s2", tokenName: "oai", channels: [{ channelId: 2, name: "OpenAI 出口" }] }, currentSegment: { group: "oai" }, health: { code: "READY" }, calculation: { profitUsd: 4 } },
  ];
  const upstreams = [{ id: "s1", name: "小福星" }, { id: "s2", name: "另一上游" }];
  for (const search of ["小福星", "awsb-3", "Bedrock2", "小福星-awsb"]) {
    assert.deepEqual(filterReconciliationResults(results, upstreams, search).map((item) => item.rule.tokenName), ["awsb-3"]);
  }
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
  assert.equal(reconciliationRowFlags({ health: { code: "UPSTREAM_EMPTY_WITH_SALES" }, transitionSegments: pending, calculation: { profitUsd: -1 } }).status.label, "负毛利");
});

test("负毛利与本站渠道禁用同时显示，不把禁用渠道的历史账单归零", () => {
  const item = {
    rule: { channels: [{ channelId: 312, name: "小福星-awsb-2.9", state: "manual_disabled" }] },
    downstream: { amountUsd: 0.0001, channels: [{ channelId: 312, amountUsd: 0.0001 }] },
    upstream: { amountUsd: 0.0002996 },
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
  const results = [
    { rule: { tokenName: "healthy" }, health: { code: "READY" }, calculation: { profitUsd: 10 } },
    { rule: { tokenName: "pending" }, health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, transitionSegments: [{ timingSource: "detected" }] },
    { rule: { tokenName: "negative" }, health: { code: "READY" }, calculation: { profitUsd: -2 } },
    { rule: { tokenName: "unavailable" }, health: { code: "UPSTREAM_DATA_UNAVAILABLE" } },
  ];
  assert.deepEqual(filterReconciliationResults(results).map((item) => item.rule.tokenName), ["unavailable", "negative", "pending", "healthy"]);
  assert.deepEqual(filterReconciliationResults(results, [], "", "attention").map((item) => item.rule.tokenName), ["unavailable", "negative", "pending"]);
});

test("风险差额缺失不能被汇总成零，真实零账单仍显示零", () => {
  const missing = { health: { code: "UPSTREAM_DATA_UNAVAILABLE" }, calculation: { profitUsd: null, riskDifferenceUsd: null } };
  const zero = { health: { code: "SEGMENT_TIMING_UNCONFIRMED" }, calculation: { profitUsd: null, riskDifferenceUsd: 0 } };
  assert.equal(summarizeReconciliationTotals([missing]).riskDifference, null);
  assert.equal(summarizeReconciliationTotals([zero]).riskDifference, 0);
  assert.equal(summarizeReconciliationTotals([missing, zero]).riskDifference, null);
});
