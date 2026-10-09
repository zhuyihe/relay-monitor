import { RECONCILIATION_CALCULATION_VERSION, reconciliationHealthMeta } from "./reconciliation-contract.js";

export function formatReconciliationMoney(amount, rate) {
  if (amount == null) return "—";
  const raw = Number(amount);
  const cnyRate = Number(rate);
  const useCny = Number.isFinite(cnyRate) && cnyRate > 0;
  const value = raw * (useCny ? cnyRate : 1);
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const prefix = `${value < 0 ? "-" : ""}${useCny ? "¥" : "$"}`;
  if (absolute > 0 && absolute < 0.000000005) return `${prefix}${absolute.toExponential(2)}`;
  return `${prefix}${absolute.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: absolute > 0 && absolute < 0.005 ? 8 : 2,
  })}`;
}

export function reconciliationBillingBasis(billing) {
  if (!["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return "—（旧版待刷新）";
  const value = billing?.amountUsd ?? billing?.knownAmountUsd;
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const amount = `${value} USD${billing?.state === "partial" ? "（部分）" : ""}`;
  const units = Number(billing.quotaUnits);
  const perUnit = Number(billing.quotaPerUnit);
  if (billing.quotaUnits == null || billing.quotaPerUnit == null || !Number.isFinite(units) || !Number.isFinite(perUnit) || perUnit <= 0) return amount;
  return `${units.toLocaleString("en-US")} ÷ ${perUnit.toLocaleString("en-US")} = ${amount}`;
}

export function reconciliationCalculationValues(calculation, health, item = null) {
  const confirmed = calculation?.profitUsd != null && isConfirmedCalculation(item);
  return {
    confirmed,
    profitUsd: confirmed ? calculation?.profitUsd : null,
    riskDifferenceUsd: confirmed ? null : calculation?.riskDifferenceUsd ?? null,
    marginRate: confirmed ? calculation?.marginRate ?? null : null,
  };
}

function finiteMoney(value) {
  const amount = Number(value);
  return value != null && Number.isFinite(amount) ? amount : null;
}

function billingState(billing) {
  if (["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return billing.state;
  return "unavailable";
}

function billingCoverage(billing, state) {
  const successfulCount = Number(billing?.successfulCount);
  const expectedCount = Number(billing?.expectedCount);
  if (Number.isInteger(successfulCount) && successfulCount >= 0 && Number.isInteger(expectedCount) && expectedCount >= 0) {
    return { successfulCount, expectedCount };
  }
  return state === "complete" ? { successfulCount: 1, expectedCount: 1 } : { successfulCount: 0, expectedCount: 0 };
}

function windowsMatch(a, b) {
  if (a?.startMs !== b?.startMs || a?.endMs !== b?.endMs) return false;
  if (a?.timezone === b?.timezone) return true;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: a.timezone }).resolvedOptions().timeZone
    === new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }).resolvedOptions().timeZone; } catch { return false; }
}

function hasCurrentCalculationVersion(item) {
  return Number(item?.calculationVersion ?? item?.downstream?.calculationVersion) === RECONCILIATION_CALCULATION_VERSION;
}

function hasCurrentBillingSide(item, billing) {
  if (item?.health?.stale || !hasCurrentCalculationVersion(item)) return false;
  const window = item?.requestedWindow ?? item?.window;
  return !!billing?.window && (!window || windowsMatch(window, billing.window));
}

function hasCurrentBillingPair(item) {
  return hasCurrentBillingSide(item, item?.downstream)
    && hasCurrentBillingSide(item, item?.upstream)
    && windowsMatch(item?.downstream?.window, item?.upstream?.window);
}

function isConfirmedCalculation(item) {
  return hasCurrentBillingPair(item)
    && (!item?.billingTimezone || item.billingTimezone.state === "verified")
    && !item?.health?.issues?.some((issue) => ["DUPLICATE_CHANNEL_ASSIGNMENT", "BILLING_WINDOW_MISMATCH", "BILLING_TIMEZONE_UNVERIFIED"].includes(issue.code))
    && (!item?.upstream?.ownershipState || item.upstream.ownershipState === "unique")
    && billingState(item?.downstream) === "complete"
    && billingState(item?.upstream) === "complete"
    && finiteMoney(item?.downstream?.amountUsd) != null
    && finiteMoney(item?.upstream?.amountUsd) != null;
}

export function summarizeReconciliationTotals(results = []) {
  const totals = results.reduce((acc, item) => {
    for (const [side, key] of [[item?.downstream, "income"], [item?.upstream, "cost"]]) {
      const state = billingState(side);
      const current = hasCurrentBillingSide(item, side);
      const amount = key === "cost" && side && Object.hasOwn(side, "countedAmountUsd") ? side.countedAmountUsd : side?.knownAmountUsd ?? side?.amountUsd;
      const known = current ? finiteMoney(amount) : null;
      const coverage = current ? billingCoverage(side, state) : { successfulCount: 0, expectedCount: 0 };
      acc[`${key}Coverage`][current && state === "complete" ? "complete" : current && state === "partial" ? "partial" : "missing"] += 1;
      acc[`${key}Coverage`].successfulCount += coverage.successfulCount;
      acc[`${key}Coverage`].expectedCount += coverage.expectedCount;
      if (known != null) {
        acc[key] += known;
        acc[`${key}Sampled`] = true;
      }
      if (state !== "complete") acc[`${key}Complete`] = false;
      if (!current) acc[`${key}Complete`] = false;
      if (key === "cost" && side?.ownershipState === "unknown") acc.costComplete = false;
    }
    const calculation = reconciliationCalculationValues(item?.calculation, item?.health, item);
    const profit = finiteMoney(calculation.profitUsd);
    const confirmed = calculation.confirmed && profit != null;
    if (confirmed) {
      acc.profit += profit;
      acc.profitSampled = true;
      acc.profitCoverage.confirmed += 1;
      const confirmedIncome = finiteMoney(item?.downstream?.amountUsd);
      if (confirmedIncome != null) acc.confirmedIncome += confirmedIncome;
    } else {
      acc.profitComplete = false;
      acc.profitCoverage.missing += 1;
    }
    if (!calculation.confirmed) {
      const riskDifference = hasCurrentBillingPair(item) ? finiteMoney(calculation.riskDifferenceUsd) : null;
      if (riskDifference != null) {
        if (acc.riskDifference != null) acc.riskDifference += riskDifference;
      } else acc.riskDifference = null;
    }
    return acc;
  }, {
    income: 0, cost: 0, profit: 0, confirmedIncome: 0, riskDifference: 0,
    incomeSampled: false, costSampled: false, profitSampled: false,
    incomeComplete: true, costComplete: true, profitComplete: true,
    incomeCoverage: { complete: 0, partial: 0, missing: 0, successfulCount: 0, expectedCount: 0 },
    costCoverage: { complete: 0, partial: 0, missing: 0, successfulCount: 0, expectedCount: 0 },
    profitCoverage: { confirmed: 0, missing: 0 },
  });
  return {
    ...totals,
    income: totals.incomeSampled ? totals.income : null,
    cost: totals.costSampled ? totals.cost : null,
    profit: totals.profitSampled ? totals.profit : null,
    confirmedMarginRate: totals.confirmedIncome > 0 && totals.profitSampled ? totals.profit / totals.confirmedIncome : null,
  };
}

export function reconciliationWorkflowAction(kind, { rule = {}, channelIds = [], window = null, ownStationId = null } = {}) {
  const definitions = {
    connect_channels: ["接入这些渠道", "/stations", "connect"], verify_identity: ["核验账号身份", "/stations", "verify"],
    verify_capability: ["核验账单能力", "/stations", "verify-billing"], confirm_coverage: ["核对这把 Key 的全部用途", "/stations", "coverage"],
    retry_bill: ["重查该窗口账单", "/reconciliation", "retry"], review_conflict: ["处理重复归属", "/reconciliation", "conflict"],
    wait_effective: ["查看生效时间", "/reconciliation", "scope"], review_source: ["核对本站来源", "/stations", "source"],
  };
  const [label, path, action] = definitions[kind];
  const ids = [...new Set(channelIds.map(Number))].sort((a, b) => a - b);
  const ownId = ownStationId || rule.ownStationId || null;
  const query = new URLSearchParams({ action });
  if (["confirm_coverage", "retry_bill", "review_conflict", "wait_effective"].includes(kind)) query.set("ruleId", rule.id);
  if (["verify_identity", "verify_capability"].includes(kind)) query.set("stationId", rule.upstreamStationId);
  if (["connect_channels", "review_source"].includes(kind)) query.set("ownStationId", ownId || "");
  if (kind === "connect_channels") query.set("channelIds", ids.join(","));
  const range = window ? { startMs: window.startMs, endMs: window.endMs, timezone: window.timezone } : null;
  if (kind === "retry_bill" && range) for (const [key, value] of Object.entries(range)) query.set(key, String(value));
  return { id: `${kind}:${rule.id || ownId || "unknown"}:${ids.join(",")}:${range ? `${range.startMs}:${range.endMs}` : ""}`,
    kind, label, accountKey: null, stationId: rule.upstreamStationId || null, ruleId: rule.id || null, ownStationId: ownId,
    channelIds: ids, window: range, href: `${path}?${query}` };
}

export function reconciliationResultActions(result) {
  const codes = new Set((result.health?.issues || []).map((issue) => issue.code));
  if (result.health?.code) codes.add(result.health.code);
  const kinds = [];
  if (codes.has("SOURCE_BINDING_UNCONFIRMED")) kinds.push("review_source");
  if (codes.has("LEGACY_IDENTITY_UNVERIFIED") || codes.has("COST_OWNER_UNVERIFIED")) kinds.push("verify_identity");
  if (codes.has("UPSTREAM_CAPABILITY_UNVERIFIED") || codes.has("BILLING_TIMEZONE_UNVERIFIED")) kinds.push("verify_capability");
  if (codes.has("COST_COVERAGE_UNKNOWN")) kinds.push("confirm_coverage");
  if (codes.has("BILLING_SCOPE_NOT_EFFECTIVE")) kinds.push("wait_effective");
  if (codes.has("CANONICAL_KEY_CONFLICT") || codes.has("DUPLICATE_CHANNEL_ASSIGNMENT")) kinds.push("review_conflict");
  if (["WAITING_FOR_BILL", "UPSTREAM_DATA_UNAVAILABLE", "OWN_BILLING_UNAVAILABLE", "BILLING_WINDOW_MISMATCH", "PENDING"].some((code) => codes.has(code))) kinds.push("retry_bill");
  return kinds.map((kind) => reconciliationWorkflowAction(kind, { rule: result.rule, channelIds: result.rule?.channels?.map((channel) => channel.channelId) || [], window: result.requestedWindow || result.window }));
}

export function deriveKnownChannelCoverage(catalogue, rules, results, { window = null, isCompletedWindow } = {}) {
  const source = catalogue?.ownSource || null, entries = new Map();
  const current = !!source?.namespaceKey && !catalogue?.stale && catalogue?.totalValidated === true && Number.isInteger(catalogue.catalogueTotal);
  const add = (ownSource, ownStationId, channel, rule = null) => {
    const key = `${ownSource?.namespaceKey || `unknown:${ownStationId}:${rule?.id || "catalogue"}`}:${channel.channelId ?? channel.id}`;
    const previous = entries.get(key), id = Number(channel.channelId ?? channel.id);
    const entry = previous || { ownSource, ownStationId, channelId: id, name: channel.name || `渠道 ${id}`,
      operatingState: channel.missing ? "missing" : channel.state || ({ 1: "enabled", 2: "manual_disabled", 3: "auto_disabled" }[channel.status] || "unknown"), rules: [] };
    if (rule) entry.rules.push(rule);
    entries.set(key, entry);
  };
  for (const channel of catalogue?.channels || []) add(source, source?.stationId || "", channel);
  for (const rule of rules) for (const channel of rule.channels || []) add(rule.ownSource || null, rule.ownStationId, channel, rule);
  let missingQueryEvidence = false;
  const channels = [...entries.values()].map((entry) => {
    const active = entry.rules.filter((rule) => rule.enabled && !rule.archivedAt);
    const issues = [], kinds = [];
    if (active.length > 1) { issues.push("DUPLICATE_CHANNEL_ASSIGNMENT"); kinds.push("review_conflict"); }
    if (!current || !entry.ownSource || entry.ownSource.namespaceKey !== source?.namespaceKey) { issues.push("SOURCE_BINDING_UNCONFIRMED"); kinds.push("review_source"); }
    if (!active.length) { issues.push("CHANNEL_UNLINKED"); kinds.push("connect_channels"); }
    const rule = active[0], result = rule && results.find((item) => item.rule.id === rule.id && (!window
      || item.window.startMs === window.startMs && item.window.endMs === window.endMs));
    if (rule) {
      const range = window || result?.window;
      if (range && rule.billingPolicy === "next-complete-day" && (!Number.isFinite(rule.billingEffectiveFrom) || range.startMs < rule.billingEffectiveFrom)) {
        issues.push("BILLING_SCOPE_NOT_EFFECTIVE"); kinds.push("wait_effective");
      }
      const billed = result?.downstream?.channels?.find((channel) => channel.channelId === entry.channelId);
      if (!result) { missingQueryEvidence = true; issues.push("BILLING_EVIDENCE_NOT_QUERIED"); }
      if (!result || billed?.billingState !== "complete" || finiteMoney(billed.amountUsd) == null || result.upstream?.state !== "complete"
        || !hasCurrentBillingPair(result)
        || result.health?.issues?.some((issue) => ["WAITING_FOR_BILL", "BILLING_WINDOW_MISMATCH"].includes(issue.code))) {
        issues.push("BILLING_MISSING"); if (result) kinds.push("retry_bill");
      }
      if (rule.costCoverage !== "complete" || rule.coverageDeclaration?.answer !== "none" || result?.billingTimezone?.state !== "verified"
        || !range || !isCompletedWindow?.(range) || result?.upstream?.ownershipState !== "unique") {
        issues.push("COST_COVERAGE_UNKNOWN"); kinds.push(rule.costCoverage !== "complete" ? "confirm_coverage" : "verify_capability");
      }
      if (result && (!result.ownSource || result.ownSource.namespaceKey !== entry.ownSource?.namespaceKey
        || result.health?.code === "SOURCE_BINDING_UNCONFIRMED" || result.health?.code === "LEGACY_IDENTITY_UNVERIFIED"
        || result.health?.issues?.some((issue) => ["SOURCE_BINDING_UNCONFIRMED", "LEGACY_IDENTITY_UNVERIFIED"].includes(issue.code)))) issues.push("SOURCE_BINDING_UNCONFIRMED");
    }
    const status = issues.includes("DUPLICATE_CHANNEL_ASSIGNMENT") ? "duplicate" : issues.includes("SOURCE_BINDING_UNCONFIRMED") ? "source_unverified"
      : !active.length ? "unlinked" : issues.includes("BILLING_SCOPE_NOT_EFFECTIVE") ? "not_effective" : issues.includes("BILLING_MISSING") ? "billing_missing"
        : issues.includes("COST_COVERAGE_UNKNOWN") ? "coverage_unknown" : "accounted";
    return { ownSource: entry.ownSource, ownStationId: entry.ownStationId, channelId: entry.channelId, name: entry.name,
      operatingState: entry.operatingState, ruleIds: entry.rules.map((item) => item.id).sort(), status, issues: [...new Set(issues)],
      actions: [...new Set(kinds)].map((kind) => reconciliationWorkflowAction(kind, { rule: rule || {}, ownStationId: entry.ownStationId,
        channelIds: [entry.channelId], window: window || result?.window || null })) };
  }).sort((a, b) => (a.ownSource?.namespaceKey || a.ownStationId).localeCompare(b.ownSource?.namespaceKey || b.ownStationId) || a.channelId - b.channelId);
  const accountedChannelCount = channels.filter((channel) => channel.status === "accounted").length;
  return { label: "known-channel-coverage", state: !current || missingQueryEvidence ? "unknown" : accountedChannelCount === channels.length ? "complete_known" : "partial",
    catalogueState: current ? "verified" : "unknown", wholeSiteState: "unverified", knownChannelCount: channels.length, accountedChannelCount, channels };
}

export function summarizeReconciliationWindowGroups(results, { isCompletedWindow, coverageFor } = {}) {
  const eligible = (row) => row.rule.costCoverage === "complete" && row.rule.coverageDeclaration?.answer === "none"
    && row.billingTimezone?.state === "verified" && isCompletedWindow?.(row.window) && row.window.preset !== "today"
    && isConfirmedCalculation(row) && finiteMoney(row.calculation?.profitUsd) != null;
  const groups = new Map();
  for (const result of results) {
    const window = result.window, basis = result.amountBasis;
    const key = JSON.stringify([result.ownSource?.namespaceKey || `unknown:${result.rule.id}`, window.startMs, window.endMs,
      basis?.id, basis?.currency, basis?.billingSource, basis?.calculationVersion, basis?.conversion,
      result.billingTimezone?.state === "verified" ? null : window.timezone]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  const windowGroups = [...groups].map(([groupKey, rows]) => {
    const first = rows[0], sales = new Map();
    let cost = 0, costSampled = false, profit = 0, profitSampled = false, confirmedIncome = 0;
    const notCountedCostRuleIds = [];
    for (const row of rows) {
      const side = row.downstream;
      if (hasCurrentBillingSide(row, side)) for (const channel of side.channels || []) {
        const amount = finiteMoney(channel.knownAmountUsd ?? channel.amountUsd);
        if (amount == null) continue;
        const id = `${row.ownSource?.namespaceKey || `unknown:${row.rule.id}`}:${channel.channelId}`;
        const sample = { amount, at: Number(side.observedAt) || Date.parse(row.generatedAt) || 0, generatedAt: Date.parse(row.generatedAt) || 0 };
        const previous = sales.get(id);
        if (!previous || previous.at < sample.at || previous.at === sample.at && previous.generatedAt < sample.generatedAt) sales.set(id, sample);
      }
      const amount = Object.hasOwn(row.upstream || {}, "countedAmountUsd") ? row.upstream.countedAmountUsd : row.upstream?.knownAmountUsd ?? row.upstream?.amountUsd;
      if (hasCurrentBillingSide(row, row.upstream) && finiteMoney(amount) != null) { cost += finiteMoney(amount); costSampled = true; }
      else if (finiteMoney(row.upstream?.knownAmountUsd ?? row.upstream?.amountUsd) != null) notCountedCostRuleIds.push(row.rule.id);
      if (eligible(row)) {
        profit += row.calculation.profitUsd; profitSampled = true; confirmedIncome += row.downstream.amountUsd;
      }
    }
    const coverage = coverageFor(first.window, first.ownSource);
    return { groupKey, ownSource: first.ownSource, window: { startMs: first.window.startMs, endMs: first.window.endMs },
      timezones: [...new Set(rows.map((row) => row.window.timezone))].sort(), amountBasis: first.amountBasis, ruleIds: rows.map((row) => row.rule.id),
      totals: { knownIncomeUsd: sales.size ? [...sales.values()].reduce((sum, sample) => sum + sample.amount, 0) : null,
        knownCostUsd: costSampled ? cost : null, confirmedProfitUsd: profitSampled ? profit : null,
        confirmedMarginRate: profitSampled && confirmedIncome > 0 ? profit / confirmedIncome : null,
        profitComplete: coverage.state === "complete_known" && rows.every(eligible),
        notCountedCostRuleIds }, coverage, actions: [...new Map(rows.flatMap((row) => row.actions || []).map((action) => [action.id, action])).values()] };
  });
  const compatible = windowGroups.length === 1 && results.every((row) => row.ownSource?.namespaceKey && row.amountBasis?.conversion
    && row.billingTimezone?.state === "verified" && row.window.preset !== "today" && isCompletedWindow?.(row.window)
    && !row.health?.issues?.some((issue) => ["SOURCE_BINDING_UNCONFIRMED", "LEGACY_IDENTITY_UNVERIFIED", "BILLING_WINDOW_MISMATCH"].includes(issue.code)));
  return { windowGroups, commonSummary: compatible ? { groupKey: windowGroups[0].groupKey, totals: windowGroups[0].totals, coverage: windowGroups[0].coverage } : null };
}

export function mergeReconciliationSegments(historySegments = [], calculatedSegments = [], refreshedHistorySegments = []) {
  const history = Array.isArray(historySegments) ? historySegments : [];
  const calculated = Array.isArray(calculatedSegments) ? calculatedSegments : [];
  const refreshed = Array.isArray(refreshedHistorySegments) ? refreshedHistorySegments : [];
  const calculatedById = new Map(calculated.map((segment) => [segment?.id, segment]));
  const refreshedById = new Map(refreshed.map((segment) => [segment?.id, segment]));
  const merged = history.map((segment) => ({
    ...segment,
    ...(calculatedById.get(segment?.id) || {}),
    ...(refreshedById.get(segment?.id) || {}),
  }));
  const mergedIds = new Set(history.map((segment) => segment?.id));
  for (const segment of calculated) {
    if (!mergedIds.has(segment?.id)) {
      merged.push({ ...segment, ...(refreshedById.get(segment?.id) || {}) });
      mergedIds.add(segment?.id);
    }
  }
  for (const segment of refreshed) {
    if (!mergedIds.has(segment?.id)) {
      merged.push(segment);
      mergedIds.add(segment?.id);
    }
  }
  return merged;
}

export function hasReconciliationHistory(segments = []) {
  return segments.slice(1).some((segment, index) => {
    const previous = segments[index];
    if ((segment.group || "") !== (previous.group || "")) return true;
    if (previous.ratio == null || segment.ratio == null) return false;
    const before = Number(previous.ratio);
    const after = Number(segment.ratio);
    return Number.isFinite(before) && Number.isFinite(after) && before !== after;
  });
}

export function mergeReconciliationChannels(ruleChannels = [], observedChannels = []) {
  const configured = Array.isArray(ruleChannels) ? ruleChannels : [];
  const observed = Array.isArray(observedChannels) ? observedChannels : [];
  if (!configured.length) return observed;
  const observedById = new Map(observed.map((channel) => [Number(channel?.channelId ?? channel?.id), channel]));
  return configured.map((channel) => ({
    ...channel,
    ...(observedById.get(Number(channel?.channelId ?? channel?.id)) || {}),
  }));
}

export function summarizeReconciliationFreshness(results = []) {
  const staleResults = results.filter((item) => item?.health?.stale);
  const coverageEnds = staleResults
    .map((item) => Number(item?.lastSuccessfulWindow?.endMs))
    .filter(Number.isFinite);
  return {
    staleCount: staleResults.length,
    coverageEndMs: coverageEnds.length ? Math.min(...coverageEnds) : null,
  };
}

export function reconciliationRowFlags(item = {}) {
  const issues = item?.health?.issues || [];
  const codes = new Set([item?.health?.code, ...issues.map((issue) => issue?.code)]);
  const healthCode = item?.health?.code;
  const healthMeta = reconciliationHealthMeta(healthCode);
  const healthLabel = healthCode === "GROUP_DATA_UNAVAILABLE" ? "当前上游分组目录不可用"
    : healthCode === "PERSISTENCE_FAILED" ? "对账结果保存失败" : healthMeta.label;
  const calculation = reconciliationCalculationValues(item?.calculation, item?.health, item);
  const profit = calculation.profitUsd;
  const confirmedProfit = profit == null ? null : Number(profit);
  const pending = codes.has("SEGMENT_TIMING_UNCONFIRMED") || codes.has("ROUTE_TRANSITION_DETECTED")
    || [...(item?.transitionSegments || []), ...(item?.segments || [])].some((segment) => segment?.timingSource === "detected");
  const negative = profit != null && Number.isFinite(confirmedProfit) && confirmedProfit < 0;
  const serious = healthMeta.tone === "error" || healthCode === "PERSISTENCE_FAILED";
  const stale = !!item?.health?.stale;
  const nonTransitionHealth = healthCode !== "READY" && healthCode !== "ROUTE_TRANSITION_DETECTED" && healthCode !== "SEGMENT_TIMING_UNCONFIRMED";
  let status;
  let severity;
  if (serious) {
    status = { label: item.health?.label || healthLabel, tone: "danger" };
    severity = 0;
  } else if (negative) {
    status = { label: "负毛利", tone: "danger" };
    severity = 1;
  } else if (stale) {
    status = { label: "数据过期", tone: "neutral" };
    severity = 2;
  } else if (nonTransitionHealth) {
    status = { label: item?.health?.label || healthLabel || "数据待获取", tone: healthMeta.tone === "warning" || healthCode === "GROUP_DATA_UNAVAILABLE" ? "warning" : "neutral" };
    severity = 3;
  } else if (pending) {
    status = { label: "待确认", tone: "warning" };
    severity = 4;
  } else {
    status = { label: "正常", tone: "success" };
    severity = 5;
  }
  const disabledCount = mergeReconciliationChannels(item?.rule?.channels, item?.downstream?.channels)
    .filter((channel) => channel.state === "manual_disabled" || channel.state === "auto_disabled").length;
  return {
    pending,
    negative,
    attention: pending || stale || healthCode !== "READY",
    status,
    secondaryStatuses: disabledCount && status.label !== "本站销售渠道已禁用"
      ? [{ label: `渠道禁用 ${disabledCount}`, tone: "warning" }]
      : [],
    severity,
  };
}

export function filterReconciliationResults(results = [], upstreams = [], search = "", filter = "all") {
  const needle = String(search).trim().toLocaleLowerCase();
  const stations = new Map((Array.isArray(upstreams) ? upstreams : []).map((station) => [String(station.id), station.name]));
  return results.filter((item) => {
    const flags = reconciliationRowFlags(item);
    if (filter === "attention" && !flags.attention && !flags.negative) return false;
    if (filter === "negative" && !flags.negative) return false;
    if (filter === "pending" && !flags.pending) return false;
    if (!needle) return true;
    const rule = item?.rule || {};
    const channelNames = mergeReconciliationChannels(rule.channels, item?.downstream?.channels)
      .flatMap((channel) => [channel.name || `渠道 ${channel.channelId ?? channel.id ?? ""}`, `ID ${channel.channelId ?? channel.id ?? ""}`]);
    const fields = [stations.get(String(rule.upstreamStationId)), rule.tokenName,
      item?.currentSegment?.group, item?.upstream?.group, rule.fixedGroup, ...channelNames];
    return fields.some((field) => String(field || "").toLocaleLowerCase().includes(needle));
  }).sort((a, b) => reconciliationRowFlags(a).severity - reconciliationRowFlags(b).severity);
}
