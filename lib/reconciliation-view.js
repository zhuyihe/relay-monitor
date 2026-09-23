import { reconciliationHealthMeta } from "./reconciliation-contract.js";

export function reconciliationCalculationValues(calculation, health) {
  const legacy = calculation?.profitUsd === undefined && calculation?.riskDifferenceUsd === undefined;
  const confirmed = calculation?.profitUsd != null || (legacy && health?.code === "READY" && calculation?.differenceUsd != null);
  return {
    confirmed,
    profitUsd: confirmed ? calculation?.profitUsd ?? calculation?.differenceUsd : null,
    riskDifferenceUsd: confirmed ? null : calculation?.riskDifferenceUsd ?? calculation?.differenceUsd ?? null,
    marginRate: confirmed ? calculation?.marginRate ?? null : null,
  };
}

export function summarizeReconciliationTotals(results = []) {
  return results.reduce((acc, item) => {
    const incomeValue = item?.downstream?.amountUsd;
    const costValue = item?.upstream?.amountUsd;
    const income = Number(incomeValue);
    const cost = Number(costValue);
    if (incomeValue != null && Number.isFinite(income)) acc.income += income;
    else acc.incomeComplete = false;
    if (costValue != null && Number.isFinite(cost)) acc.cost += cost;
    else acc.costComplete = false;
    const calculation = reconciliationCalculationValues(item?.calculation, item?.health);
    const profit = Number(calculation.profitUsd);
    if (calculation.confirmed && Number.isFinite(profit)) acc.profit += profit;
    else acc.profitComplete = false;
    if (!calculation.confirmed) {
      const riskDifference = Number(calculation.riskDifferenceUsd);
      if (calculation.riskDifferenceUsd != null && Number.isFinite(riskDifference)) {
        if (acc.riskDifference != null) acc.riskDifference += riskDifference;
      } else acc.riskDifference = null;
    }
    return acc;
  }, { income: 0, cost: 0, profit: 0, riskDifference: 0, incomeComplete: true, costComplete: true, profitComplete: true });
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
  const calculation = item?.calculation;
  const profit = calculation?.profitUsd ?? (calculation?.profitUsd === undefined && calculation?.riskDifferenceUsd === undefined && healthCode === "READY" ? calculation?.differenceUsd : null);
  const confirmedProfit = profit == null ? null : Number(profit);
  const pending = codes.has("SEGMENT_TIMING_UNCONFIRMED") || codes.has("ROUTE_TRANSITION_DETECTED")
    || [...(item?.transitionSegments || []), ...(item?.segments || [])].some((segment) => segment?.timingSource === "detected");
  const negative = profit != null && Number.isFinite(confirmedProfit) && confirmedProfit < 0;
  const serious = healthMeta.tone === "error";
  const stale = !!item?.health?.stale;
  const nonTransitionHealth = healthCode !== "READY" && healthCode !== "ROUTE_TRANSITION_DETECTED" && healthCode !== "SEGMENT_TIMING_UNCONFIRMED";
  let status;
  let severity;
  if (serious) {
    status = { label: item.health?.label || healthMeta.label, tone: "danger" };
    severity = 0;
  } else if (negative) {
    status = { label: "负毛利", tone: "danger" };
    severity = 1;
  } else if (stale) {
    status = { label: "数据过期", tone: "neutral" };
    severity = 2;
  } else if (nonTransitionHealth) {
    status = { label: item?.health?.label || healthMeta.label || "数据待获取", tone: healthMeta.tone === "warning" ? "warning" : "neutral" };
    severity = 3;
  } else if (pending) {
    status = { label: "待确认", tone: "warning" };
    severity = 4;
  } else {
    status = { label: "正常", tone: "success" };
    severity = 5;
  }
  return {
    pending,
    negative,
    attention: pending || stale || healthCode !== "READY",
    status,
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
      .map((channel) => channel.name || `渠道 ${channel.channelId ?? channel.id ?? ""}`);
    const fields = [stations.get(String(rule.upstreamStationId)), rule.tokenName,
      item?.currentSegment?.group, item?.upstream?.group, rule.fixedGroup, ...channelNames];
    return fields.some((field) => String(field || "").toLocaleLowerCase().includes(needle));
  }).sort((a, b) => reconciliationRowFlags(a).severity - reconciliationRowFlags(b).severity);
}
