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
  summarizeReconciliationWindowGroups,
  deriveKnownChannelCoverage,
  reconciliationSettlement,
  reconciliationRowCurrency,
  reconciliationDisplayCurrency,
  reconciliationRateFactors,
  sameReconciliationWindow,
  summarizeUnaccountedUpstream,
  fixedOffProfitStations,
  attributeAuthorizationRules,
  formatReconciliationAmount,
  reconciliationResultActions,
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

test("归属未知保留raw账单，汇总只计counted成本；旧DTO兼容且不能确认重复利润", () => {
  const window = { startMs: 10, endMs: 20, timezone: "Asia/Shanghai" };
  const row = { calculationVersion: 3, window, rule: { id: "r1" }, health: { code: "COST_OWNER_UNVERIFIED" },
    upstream: { state: "complete", amountUsd: 1, knownAmountUsd: 1, countedAmountUsd: null, ownershipState: "unknown", window },
    downstream: { state: "complete", amountUsd: 2.5, window }, calculation: { profitUsd: 1.5 } };
  const totals = (rows) => summarizeReconciliationWindowGroups(rows, { coverageFor: () => ({ state: "complete_known" }) }).windowGroups[0].totals;
  const unknown = totals([row]);
  assert.equal(unknown.knownCostUsd, null);
  assert.deepEqual(unknown.notCountedCostRuleIds, ["r1"]);
  assert.equal(unknown.confirmedProfitUsd, null);
  assert.equal(reconciliationBillingBasis(row.upstream), "1 USD", "真实费用仍可展示依据");
  const duplicates = [row, row].map((item, index) => ({ ...item, rule: { id: `r${index + 1}` }, upstream: { ...item.upstream,
    ownershipState: "duplicate", countedAmountUsd: index === 0 ? 1 : null } }));
  const duplicated = totals(duplicates);
  assert.equal(duplicated.knownCostUsd, 1);
  assert.equal(duplicated.confirmedProfitUsd, null);
  assert.equal(row.upstream.amountUsd, 1);
  const legacy = { ...row, upstream: { state: "complete", amountUsd: 1, window } };
  assert.equal(totals([legacy]).knownCostUsd, 1);
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
    accountUsd: 2, accountedUsd: 1.5, unaccountedUsd: 0.5, account: 12, accounted: 9, unaccounted: 3, overAccounted: null });
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
  const lowerBound = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 3, mode: "history", lowerBound: true, note: "余额历史没覆盖整个时段，金额偏低" } }], rows);
  assert.deepEqual([lowerBound.state, lowerBound.total, lowerBound.accounts[0].state, lowerBound.accounts[0].notes], ["partial", 1.5, "partial", ["余额历史没覆盖整个时段，金额偏低"]]);
  rows[1].upstream.state = "partial";
  const partial = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], rows);
  assert.deepEqual([partial.state, partial.accounts[0].notes], ["partial", ["部分关联的上游成本未取全，已核算金额偏低"]]);
  assert.deepEqual(summarizeUnaccountedUpstream([], rows), { state: "complete", currency: "USD", total: 0, accounts: [] });
});

// 已结账的日子按账本记下的汇率显示成本：未纳入面板的已核算也按行上的汇率折算，和明细行对得上
test("4a 未纳入核算的上游消费：已结账的日子按结账时的汇率折算已核算，汇率差单独说明", () => {
  const station = { id: "up", name: "上游" };
  const configured = { cnyPerUsd: 6, source: "configured" };
  const settled = ratedRow("a", 3, 1, { own: 7, up: 7 });
  const current = ratedRow("b", 2, 0.5, { own: 7, up: 6, channelId: 2 });
  const summary = summarizeUnaccountedUpstream([{ station, rate: configured, usage: { usd: 2, mode: "api" } }], [settled, current], { currency: "CNY" });
  const note = "已结账的日子按结账时记下的汇率折算，和这个账号当前的汇率不同，未纳入含汇率差";
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

  // 汇总：借来的关联计入已核算，无法确认的让账号变成「部分」
  const own = ratedRow("k1", 2, 0.5, { channelId: 3 });
  own.rule = { ...own.rule, upstreamStationId: "keyA" };
  const rows = [own, onAuth("r1"), onAuth("r2", 2)];
  const rate = { cnyPerUsd: 1, source: "default" }, usage = { usd: 4, mode: "api" };
  const borrowed = summarizeUnaccountedUpstream([{ station: keyA, rate, usage, borrowed: [entry("r1"), entry("r2")] }], rows);
  assert.deepEqual([borrowed.state, borrowed.total], ["complete", 1.5]);
  assert.deepEqual(borrowed.accounts[0], { stationId: "keyA", name: "KeyA", rate: null, mode: "api", endMs: null, state: "complete",
    notes: ["已核算含未开监控的站点「授权A」上的核算关联 r1、r2"], ruleIds: ["k1", "r1", "r2"],
    accountUsd: 4, accountedUsd: 2.5, unaccountedUsd: 1.5, account: 4, accounted: 2.5, unaccounted: 1.5, overAccounted: null });
  const entryB = (ruleId) => ({ ruleId, stationId: "auth2", stationName: "授权B" });
  const uncertain = summarizeUnaccountedUpstream([{ station: keyA, rate, usage, uncertain: [entry("r1"), entryB("r9"), entry("r2")] }], rows);
  assert.deepEqual([uncertain.state, uncertain.total, uncertain.accounts[0].ruleIds, uncertain.accounts[0].accountedUsd], ["partial", 3.5, ["k1"], 0.5]);
  assert.deepEqual(uncertain.accounts[0].notes, [
    "未开监控的站点「授权A」上的核算关联 r1、r2 无法确认是否属于这个账号，未纳入金额可能偏高；在渠道接入里把对应渠道的监控关联到这个站点后可确认",
    "未开监控的站点「授权B」上的核算关联 r9 无法确认是否属于这个账号，未纳入金额可能偏高；在渠道接入里把对应渠道的监控关联到这个站点后可确认"]);
  // 借来的关联账单不完整：已核算只是下限
  rows[1].upstream.state = "partial";
  const incomplete = summarizeUnaccountedUpstream([{ station: keyA, rate, usage, borrowed: [entry("r1")] }], rows);
  assert.deepEqual([incomplete.state, incomplete.accounts[0].notes], ["partial", ["部分关联的上游成本未取全，已核算金额偏低", "已核算含未开监控的站点「授权A」上的核算关联 r1"]]);
  rows[1].upstream.state = "complete";

  // 人民币：借来的关联按它自己上游的汇率折算，和明细行一致；未纳入 = 账号扣费按本账号汇率 − 已核算
  const cnyRows = [ratedRow("k1", 2, 0.5, { own: 7, up: 6 }), { ...ratedRow("r1", 3, 1, { own: 7, up: 7 }), rule: { ...ratedRow("r1", 3, 1).rule, upstreamStationId: "auth" } }];
  cnyRows[0].rule = { ...cnyRows[0].rule, upstreamStationId: "keyA" };
  const cny = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage, borrowed: [entry("r1")] }], cnyRows, { currency: "CNY" });
  assert.deepEqual([cny.currency, cny.total], ["CNY", 14]);
  const rateNote = "未开监控的站点「授权A」的汇率和这个账号不同，核算关联 r1 按该站点的汇率折算，未纳入含汇率差，把两个站点的汇率设成一致后可消除";
  assert.deepEqual(cny.accounts[0].notes, ["已核算含未开监控的站点「授权A」上的核算关联 r1", rateNote]);
  assert.deepEqual([cny.accounts[0].accountedUsd, cny.accounts[0].unaccountedUsd, cny.accounts[0].account, cny.accounts[0].accounted, cny.accounts[0].unaccounted],
    [1.5, 2.5, 24, 10, 14], "0.5×6 + 1×7 = 10，4×6 − 10 = 14");
  const usd = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage, borrowed: [entry("r1")] }], cnyRows);
  assert.deepEqual([usd.currency, usd.accounts[0].accounted, usd.accounts[0].unaccounted, usd.accounts[0].notes],
    ["USD", 1.5, 2.5, ["已核算含未开监控的站点「授权A」上的核算关联 r1"]], "按 USD 时不折算，也没有汇率差");
  // 借来的关联所在站点没设汇率：按这个账号的汇率折算，没有汇率差
  const unrated = [cnyRows[0], { ...cnyRows[1], rates: ratedRow("r1", 3, 1, { own: 7 }).rates }];
  const fallback = summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" }, usage, borrowed: [entry("r1")] }], unrated, { currency: "CNY" });
  assert.deepEqual([fallback.accounts[0].accounted, fallback.accounts[0].unaccounted, fallback.accounts[0].notes], [9, 15, ["已核算含未开监控的站点「授权A」上的核算关联 r1"]]);
  // 汇率差让人民币和美元的正负相反：「已核算高于账号扣费」按显示的金额判断
  const signRows = (cost, up) => [{ ...ratedRow("r1", 3, cost, { own: 7, up }), rule: { ...ratedRow("r1", 3, cost).rule, upstreamStationId: "auth" } }];
  const signCase = (usd, cost, up, currency = "CNY") => summarizeUnaccountedUpstream([{ station: keyA, rate: { cnyPerUsd: 6, source: "configured" },
    usage: { usd, mode: "api" }, borrowed: [entry("r1")] }], signRows(cost, up), { currency }).accounts[0];
  const flippedNegative = signCase(1, 0.5, 14);
  assert.deepEqual([flippedNegative.unaccountedUsd, flippedNegative.unaccounted, flippedNegative.overAccounted, flippedNegative.notes.slice(1)],
    [0.5, -1, "rate", [rateNote, "按各自汇率折算后已核算高于账号扣费，差额来自汇率不同"]], "$0.5 未纳入，按 ¥6 和 ¥14 折算后 6 − 7 = −1");
  const flippedPositive = signCase(2, 2.5, 4);
  assert.deepEqual([flippedPositive.unaccountedUsd, flippedPositive.unaccounted, flippedPositive.overAccounted, flippedPositive.notes.slice(1)],
    [-0.5, 2, null, [rateNote]], "美元多核算 $0.5，按 ¥6 和 ¥4 折算后 12 − 10 = 2，不提示多核算");
  const usdNegative = signCase(2, 2.5, 4, "USD");
  assert.deepEqual([usdNegative.unaccounted, usdNegative.overAccounted, usdNegative.notes.slice(1)], [-0.5, "timing", ["已核算成本高于账号扣费，多为两边取数时刻不同或上游扣费尚未入账"]]);
  // 美元和人民币都多核算：汇率差让多核算更多时说两者都有，汇率差让多核算更少时只说取数时刻
  const bothNegative = signCase(1, 1.5, 7);
  assert.deepEqual([bothNegative.unaccountedUsd, bothNegative.unaccounted, bothNegative.overAccounted, bothNegative.notes.slice(1)],
    [-0.5, -4.5, "mixed", [rateNote, "已核算成本高于账号扣费，差额来自两边取数时刻不同（或上游扣费尚未入账）和汇率不同"]], "6 − 1.5×7 = −4.5");
  const rateLowers = signCase(1, 2, 4);
  assert.deepEqual([rateLowers.unaccountedUsd, rateLowers.unaccounted, rateLowers.overAccounted, rateLowers.notes.slice(1)],
    [-1, -2, "timing", [rateNote, "已核算成本高于账号扣费，多为两边取数时刻不同或上游扣费尚未入账"]], "6 − 2×4 = −2");
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
  assert.deepEqual([even.overAccounted, even.notes.at(-1)], ["rate", "按各自汇率折算后已核算高于账号扣费，差额来自汇率不同"]);
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
  const isCompletedWindow = (window) => isCompletedBillingWindow(window, Date.parse("2026-10-09T00:00:00Z"));
  const catalogue = (row) => ({ ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] });
  const fixed = fixedReferenceRow("fixed", 3);
  const values = reconciliationCalculationValues(fixed.calculation, fixed.health, fixed);
  assert.deepEqual([values.confirmed, values.profitUsd, values.profit, values.margin], [true, 3, 3, 1]);
  assert.equal(reconciliationSettlement(fixed, { isCompletedWindow }), "settled");
  assert.deepEqual(reconciliationResultActions(fixed), []);
  const coverage = deriveKnownChannelCoverage(catalogue(fixed), [fixed.rule], [fixed], { isCompletedWindow });
  assert.deepEqual([coverage.state, coverage.channels[0].status, coverage.channels[0].issues], ["complete_known", "accounted", []]);
  const grouped = summarizeReconciliationWindowGroups([fixed], { coverageFor: () => coverage });
  assert.ok(grouped.commonSummary, "只作参考的窗口不一致不拆开汇总");
  const totals = grouped.commonSummary.totals;
  assert.deepEqual([totals.knownIncomeUsd, totals.knownCostUsd, totals.confirmedProfitUsd, totals.profitComplete], [3, null, 3, true]);
  assert.deepEqual([totals.display.knownCost, totals.display.confirmedProfit, totals.display.confirmedMarginRate], [0, 3, 1]);

  const usage = fixedReferenceRow("usage", 3, { costBasis: "usage" });
  assert.equal(reconciliationCalculationValues(usage.calculation, usage.health, usage).confirmed, false);
  assert.notEqual(reconciliationSettlement(usage, { isCompletedWindow }), "settled");
  assert.deepEqual(reconciliationResultActions(usage).map((action) => action.kind), ["verify_identity", "retry_bill"]);
  const usageCoverage = deriveKnownChannelCoverage(catalogue(usage), [usage.rule], [usage], { isCompletedWindow });
  assert.equal(usageCoverage.channels[0].status, "billing_missing");
  assert.ok(usageCoverage.channels[0].issues.includes("COST_COVERAGE_UNKNOWN"));
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
  assert.ok(reconciliationResultActions(ownMismatch).some((action) => action.kind === "retry_bill"));
  assert.equal(summarizeReconciliationWindowGroups([ownMismatch], { coverageFor: () => coverage }).commonSummary, null);
});

test("4a 固定采购上游：Key 还有没有其他用途没确认不影响渠道覆盖和汇总毛利；按用量的仍标用途待确认", () => {
  const isCompletedWindow = (window) => isCompletedBillingWindow(window, Date.parse("2026-10-09T00:00:00Z"));
  const catalogue = (row) => ({ ownSource: row.ownSource, stale: false, totalValidated: true, catalogueTotal: 1, channels: [{ id: 1, name: "渠道1", status: 1 }] });
  const unconfirmed = (row) => {
    row.rule = { ...row.rule, costCoverage: "unknown", coverageDeclaration: { answer: "unknown" } };
    return row;
  };
  const fixed = unconfirmed(fixedReferenceRow("fixed", 3));
  fixed.health.issues.push({ code: "COST_COVERAGE_UNKNOWN", side: "upstream", reference: true });
  const coverage = deriveKnownChannelCoverage(catalogue(fixed), [fixed.rule], [fixed], { isCompletedWindow });
  assert.deepEqual([coverage.state, coverage.channels[0].status, coverage.channels[0].issues, coverage.channels[0].actions], ["complete_known", "accounted", [], []]);
  const totals = summarizeReconciliationWindowGroups([fixed], { coverageFor: () => coverage }).commonSummary.totals;
  assert.deepEqual([totals.confirmedProfitUsd, totals.profitComplete], [3, true]);

  const usage = unconfirmed(ratedRow("usage", 3, 1));
  usage.health = { code: "READY", issues: [] };
  const usageCoverage = deriveKnownChannelCoverage(catalogue(usage), [usage.rule], [usage], { isCompletedWindow });
  assert.deepEqual([usageCoverage.channels[0].status, usageCoverage.channels[0].actions.map((action) => action.kind)], ["coverage_unknown", ["confirm_coverage"]]);
  const usageTotals = summarizeReconciliationWindowGroups([usage], { coverageFor: () => usageCoverage }).windowGroups[0].totals;
  assert.equal(usageTotals.confirmedProfitUsd, null, "按用量计成本、用途没确认：不计入已确认毛利");
});
