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
  return a?.startMs === b?.startMs && a?.endMs === b?.endMs && a?.timezone === b?.timezone;
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
