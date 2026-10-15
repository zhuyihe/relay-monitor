import { RECONCILIATION_CALCULATION_VERSION, reconciliationHealthMeta, isScopedBillingPolicy, reconciliationAccountingStart, isLiveReconciliationPreset } from "./reconciliation-contract.js";
import { onboardingBaseUrl } from "./channel-onboarding.js";

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

// 按币种显示已经折算好的金额：人民币直接显示，美元原样显示。
export function formatReconciliationAmount(amount, currency) {
  return formatReconciliationMoney(amount, currency === "CNY" ? 1 : null);
}

// 金额默认按系统原值（USD）显示；本站和按用量计成本的上游都设置了汇率时，这条关联才能按人民币显示：
// 收入按本站汇率、成本按该上游自己的汇率折算，和「我的站点」一致。
export function reconciliationRowCurrency(rates) {
  const configured = (rate) => rate?.source === "configured" && Number(rate.cnyPerUsd) > 0;
  return configured(rates?.income) && (rates.costBasis === "fixed" || configured(rates?.cost)) ? "CNY" : "USD";
}

// 一页只用一种币种：每条关联都能按人民币显示才用人民币，否则全部按 USD，免得同一列混着两种币种。
export function reconciliationDisplayCurrency(rows = []) {
  return rows.length && rows.every((row) => reconciliationRowCurrency(row?.rates) === "CNY") ? "CNY" : "USD";
}

// 收入、成本各自乘的系数。固定采购的上游用量不计成本（采购费作为固定成本摊销），成本系数为 0，与币种无关。
// 要求人民币但这条关联缺汇率时返回 null。
export function reconciliationRateFactors(rates, currency = "USD") {
  const fixedCost = rates?.costBasis === "fixed";
  if (currency !== "CNY") return { currency: "USD", income: 1, cost: fixedCost ? 0 : 1, fixedCost };
  if (reconciliationRowCurrency(rates) !== "CNY") return null;
  return { currency: "CNY", income: Number(rates.income.cnyPerUsd), cost: fixedCost ? 0 : Number(rates.cost.cnyPerUsd), fixedCost };
}

// 今天、近 7 天、本月截至取数时刻，每条关联的截止点各不相同：同一预设、同一起点就是同一个窗口。
export function sameReconciliationWindow(a, b) {
  if (!a || !b || a.startMs !== b.startMs) return false;
  return isLiveReconciliationPreset(a.preset) || isLiveReconciliationPreset(b.preset) ? a.preset === b.preset : a.endMs === b.endMs;
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

// *Usd / marginRate 是账单原币（USD）原始口径；profit / riskDifference / margin 是页面显示口径：
// 按 currency 折算（缺汇率时退回 USD），固定采购上游的成本记为 0，两侧分别折算后相减。
export function reconciliationCalculationValues(calculation, health, item = null, currency = "USD") {
  const confirmed = calculation?.profitUsd != null && hasTrustworthyProfit(item);
  const profitUsd = confirmed ? calculation?.profitUsd : null;
  const riskDifferenceUsd = confirmed ? null : calculation?.riskDifferenceUsd ?? null;
  const marginRate = confirmed ? calculation?.marginRate ?? null : null;
  const usd = { confirmed, profitUsd, riskDifferenceUsd, marginRate };
  const factors = reconciliationRateFactors(item?.rates, currency) || reconciliationRateFactors(item?.rates);
  const income = finiteMoney(item?.downstream?.amountUsd), cost = finiteMoney(item?.upstream?.amountUsd);
  const identity = factors.income === 1 && factors.cost === 1;
  // 缺两侧金额（旧快照）时没法分别折算，按原始 USD 口径显示。
  if (identity || income == null || cost == null) {
    return { ...usd, currency: identity ? factors.currency : "USD", profit: profitUsd, riskDifference: riskDifferenceUsd, margin: marginRate };
  }
  const difference = income * factors.income - cost * factors.cost;
  return { ...usd, currency: factors.currency,
    profit: profitUsd == null ? null : difference,
    riskDifference: riskDifferenceUsd == null ? null : difference,
    margin: profitUsd == null || !(income > 0) ? null : difference / (income * factors.income) };
}

function finiteMoney(value) {
  const amount = Number(value);
  return value != null && Number.isFinite(amount) ? amount : null;
}

function billingState(billing) {
  if (["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return billing.state;
  return "unavailable";
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

// 毛利由服务端判定；历史快照里可能有旧版 DTO，视图再挡一次服务端同样会拦下的情况。不看窗口是否结束：今天也给实时毛利。
function hasTrustworthyProfit(item) {
  return hasCurrentBillingPair(item)
    && (!item?.billingTimezone || item.billingTimezone.state === "verified")
    && !item?.health?.issues?.some((issue) => ["DUPLICATE_CHANNEL_ASSIGNMENT", "BILLING_WINDOW_MISMATCH", "BILLING_TIMEZONE_UNVERIFIED"].includes(issue.code))
    && (!item?.upstream?.ownershipState || item.upstream.ownershipState === "unique")
    && billingState(item?.downstream) === "complete"
    && billingState(item?.upstream) === "complete"
    && finiteMoney(item?.downstream?.amountUsd) != null
    && finiteMoney(item?.upstream?.amountUsd) != null;
}

// 结账状态：有毛利时，可结账的整自然日为已结账，早已结束的其他窗口（如非整日的自定义时段）为已结束，其余为实时；
// 没有毛利时按问题严重程度分为不可用和待结账。
export function reconciliationSettlement(item, { isCompletedWindow, isEndedWindow } = {}) {
  if (finiteMoney(item?.calculation?.profitUsd) != null && hasTrustworthyProfit(item)) {
    return isCompletedWindow?.(item.window) ? "settled" : isEndedWindow?.(item.window) ? "ended" : "live";
  }
  return reconciliationHealthMeta(item?.health?.code).tone === "error" ? "unavailable" : "pending";
}

export function reconciliationWorkflowAction(kind, { rule = {}, channelIds = [], window = null, ownStationId = null } = {}) {
  const definitions = {
    connect_channels: ["接入这些渠道", "/stations", "connect"], verify_identity: ["核验账号身份", "/stations", "verify"],
    verify_capability: ["核验账单能力", "/stations", "verify-billing"], confirm_coverage: ["核对这把 Key 的全部用途", "/stations", "coverage"],
    retry_bill: ["重查该窗口账单", "/reconciliation", "retry"], review_conflict: ["处理重复归属", "/stations", "conflict"],
    wait_effective: ["查看生效时间", "/stations", "scope"], review_source: ["核对本站来源", "/stations", "source"],
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

export function deriveKnownChannelCoverage(catalogue, rules, results, { window = null } = {}) {
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
    const rule = active[0], result = rule && results.find((item) => item.rule.id === rule.id && (!window || sameReconciliationWindow(item.window, window)));
    if (rule) {
      const range = window || result?.window;
      const accountingStart = isScopedBillingPolicy(rule.billingPolicy) ? reconciliationAccountingStart(rule) : null;
      if (range && accountingStart != null && range.endMs <= accountingStart) {
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
        || !range || result?.upstream?.ownershipState !== "unique") {
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

// 页面显示口径的小计：按 currency 折算（任何一行折算不了就整组按 USD），固定采购上游的成本记为 0。
function displayTotals(rows, currency, eligible) {
  const factorsOf = (row) => reconciliationRateFactors(row.rates, currency);
  if (currency === "CNY" && !rows.every(factorsOf)) return displayTotals(rows, "USD", eligible);
  const sales = new Map();
  let cost = 0, costSampled = false, profit = 0, profitSampled = false, confirmedIncome = 0;
  for (const row of rows) {
    const side = row.downstream, factors = factorsOf(row);
    if (hasCurrentBillingSide(row, side)) for (const channel of side.channels || []) {
      const amount = finiteMoney(channel.knownAmountUsd ?? channel.amountUsd);
      if (amount == null) continue;
      const id = `${row.ownSource?.namespaceKey || `unknown:${row.rule.id}`}:${channel.channelId}`;
      const sample = { amount: amount * factors.income, at: Number(side.observedAt) || Date.parse(row.generatedAt) || 0, generatedAt: Date.parse(row.generatedAt) || 0 };
      const previous = sales.get(id);
      if (!previous || previous.at < sample.at || previous.at === sample.at && previous.generatedAt < sample.generatedAt) sales.set(id, sample);
    }
    const amount = Object.hasOwn(row.upstream || {}, "countedAmountUsd") ? row.upstream.countedAmountUsd : row.upstream?.knownAmountUsd ?? row.upstream?.amountUsd;
    if (hasCurrentBillingSide(row, row.upstream) && finiteMoney(amount) != null) { cost += finiteMoney(amount) * factors.cost; costSampled = true; }
    if (eligible(row)) {
      const values = reconciliationCalculationValues(row.calculation, row.health, row, currency);
      if (values.currency !== currency) return displayTotals(rows, "USD", eligible);
      profit += values.profit; profitSampled = true; confirmedIncome += row.downstream.amountUsd * factors.income;
    }
  }
  return { currency, knownIncome: sales.size ? [...sales.values()].reduce((sum, sample) => sum + sample.amount, 0) : null,
    knownCost: costSampled ? cost : null, confirmedProfit: profitSampled ? profit : null,
    confirmedMarginRate: profitSampled && confirmedIncome > 0 ? profit / confirmedIncome : null };
}

// totals 的 *Usd 字段是账单原币原始口径；display 是页面显示口径（currency 默认按这批结果能否全部按人民币显示决定）。
export function summarizeReconciliationWindowGroups(results, { coverageFor, currency = reconciliationDisplayCurrency(results) } = {}) {
  // 今天和不完整窗口同样汇总实时毛利；是否已结账看每行的 settlement。
  const eligible = (row) => row.rule.costCoverage === "complete" && row.rule.coverageDeclaration?.answer === "none"
    && row.billingTimezone?.state === "verified" && hasTrustworthyProfit(row) && finiteMoney(row.calculation?.profitUsd) != null;
  const groups = new Map();
  for (const result of results) {
    const window = result.window, basis = result.amountBasis;
    // 实时窗口每条关联截止点不同，按预设分组；组内截止点取最早的一条，所有行都至少覆盖到这里。
    const key = JSON.stringify([result.ownSource?.namespaceKey || `unknown:${result.rule.id}`, window.startMs,
      isLiveReconciliationPreset(window.preset) ? `live:${window.preset}` : window.endMs,
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
      if (hasCurrentBillingSide(row, row.upstream) && finiteMoney(amount) != null) {
        cost += finiteMoney(amount); costSampled = true;
      } else if (finiteMoney(row.upstream?.knownAmountUsd ?? row.upstream?.amountUsd) != null) notCountedCostRuleIds.push(row.rule.id);
      if (eligible(row)) {
        profit += row.calculation.profitUsd; profitSampled = true; confirmedIncome += row.downstream.amountUsd;
      }
    }
    const coverage = coverageFor(first.window, first.ownSource);
    const endMs = Math.min(...rows.map((row) => row.window.endMs));
    return { groupKey, ownSource: first.ownSource,
      window: { startMs: first.window.startMs, endMs, ...(isLiveReconciliationPreset(first.window.preset) ? { preset: first.window.preset } : {}) },
      timezones: [...new Set(rows.map((row) => row.window.timezone))].sort(), amountBasis: first.amountBasis, ruleIds: rows.map((row) => row.rule.id),
      totals: { knownIncomeUsd: sales.size ? [...sales.values()].reduce((sum, sample) => sum + sample.amount, 0) : null,
        knownCostUsd: costSampled ? cost : null, confirmedProfitUsd: profitSampled ? profit : null,
        confirmedMarginRate: profitSampled && confirmedIncome > 0 ? profit / confirmedIncome : null,
        profitComplete: coverage.state === "complete_known" && rows.every(eligible),
        notCountedCostRuleIds, display: displayTotals(rows, currency, eligible) }, coverage, actions: [...new Map(rows.flatMap((row) => row.actions || []).map((action) => [action.id, action])).values()] };
  });
  const compatible = windowGroups.length === 1 && results.every((row) => row.ownSource?.namespaceKey && row.amountBasis?.conversion
    && row.billingTimezone?.state === "verified"
    && !row.health?.issues?.some((issue) => ["SOURCE_BINDING_UNCONFIRMED", "LEGACY_IDENTITY_UNVERIFIED", "BILLING_WINDOW_MISMATCH"].includes(issue.code)));
  return { windowGroups, commonSummary: compatible ? { groupKey: windowGroups[0].groupKey, totals: windowGroups[0].totals, coverage: windowGroups[0].coverage } : null };
}

// 核算关联建在没开监控的账单授权上时（独立 Key 监控 + 专用账号授权），按用量对比的账号找不到自己的关联，
// 已核算会少算、未纳入会多算。能确认是同一账号（核验过的账号身份相同），或关联的销售渠道接到了这个监控站点时，
// 把关联归到这个账号；有多个候选或无法确认时不归属，只在同站点的候选账号上标出来。地址相同本身不能确认成本身份。
// 固定采购、设为不计入成本的上游开着监控，按各自口径处理，不在这里归属。
// monitorLinks: 当前有效的监控关联 [{ ownStationId, channelId, stationId }]。
// 返回 Map<监控账号 stationId, { borrowed: [{ ruleId, stationId, stationName }], uncertain: [...] }>
export function attributeAuthorizationRules({ usageStations = [], rows = [], stationOf = () => null, monitorLinks = [] } = {}) {
  const result = new Map();
  const add = (stationId, kind, entry) => {
    const key = String(stationId);
    if (!result.has(key)) result.set(key, { borrowed: [], uncertain: [] });
    result.get(key)[kind].push(entry);
  };
  const accountOf = (station) => {
    const identity = station?.verifiedIdentity, accountId = String(identity?.accountId || "").trim();
    return accountId ? [identity.provider, onboardingBaseUrl(identity.baseUrl), accountId].join("|") : null;
  };
  const usageIds = new Set(usageStations.map((station) => String(station.id)));
  for (const row of rows) {
    const hostId = row.rule?.upstreamStationId;
    if (hostId == null || usageIds.has(String(hostId))) continue;
    const host = stationOf(hostId);
    if (!host || host.monitorEnabled !== false) continue;
    const site = onboardingBaseUrl(host.baseUrl), hostAccount = accountOf(host);
    if (!site) continue;
    const candidates = usageStations.filter((station) => {
      if (onboardingBaseUrl(station.baseUrl) !== site) return false;
      const account = accountOf(station);
      return !account || !hostAccount || account === hostAccount;
    });
    if (!candidates.length) continue;
    const channelIds = new Set((row.rule.channels || []).map((channel) => Number(channel.channelId)));
    const linked = (station) => monitorLinks.some((link) => String(link.stationId) === String(station.id)
      && String(link.ownStationId) === String(row.rule.ownStationId) && channelIds.has(Number(link.channelId)));
    const confirmed = candidates.filter((station) => (hostAccount && accountOf(station) === hostAccount) || linked(station));
    const entry = { ruleId: row.rule.id, stationId: host.id, stationName: host.name };
    if (confirmed.length === 1) add(confirmed[0].id, "borrowed", entry);
    else for (const station of confirmed.length ? confirmed : candidates) add(station.id, "uncertain", entry);
  }
  return result;
}

function groupByStation(entries) {
  const grouped = new Map();
  for (const { ruleId, stationId, stationName } of entries) {
    const key = String(stationId);
    if (!grouped.has(key)) grouped.set(key, { name: stationName || key, ids: [] });
    grouped.get(key).ids.push(ruleId);
  }
  return [...grouped.values()].map(({ name, ids }) => [name, ids]);
}

// 未纳入核算的上游消费 = 各按用量计费上游的账号级扣费 − 本窗口已计入核算的 Key 成本。
// 账号级扣费和「我的站点」的上游成本同一取数，所以核算已计入成本加上本项就是我的站点的上游成本。
// 设为不计入成本的上游不做账号级对比（我的站点不计它的成本），但建在它上面的核算关联仍按 Key 用量计成本。
// currency 为 CNY 且每个上游都设置了汇率时按各自汇率折算人民币，否则按 USD 原值。*Usd 字段始终是 USD。
// accounts: [{ station: { id, name }, rate: { cnyPerUsd, source }, usage: { usd, mode, note, endMs, lowerBound } | null（读取中）, approximate,
//   borrowed, uncertain }]，borrowed / uncertain 来自 attributeAuthorizationRules。
// lowerBound：余额历史没覆盖整个时段，账号扣费只是下限。负的未纳入（多为取数时刻不同）在明细里保留，合计按 0 计。
export function summarizeUnaccountedUpstream(accounts = [], rows = [], { currency = "USD" } = {}) {
  const cny = currency === "CNY" && accounts.every(({ rate }) => rate?.source === "configured" && Number(rate.cnyPerUsd) > 0);
  const items = accounts.map(({ station, rate, usage, approximate = false, borrowed = [], uncertain = [] }) => {
    const borrowedIds = new Set(borrowed.map((entry) => String(entry.ruleId)));
    const ruleRows = rows.filter((row) => String(row.rule?.upstreamStationId) === String(station.id) || borrowedIds.has(String(row.rule?.id)));
    let accountedUsd = 0, accountedComplete = true;
    for (const row of ruleRows) {
      const current = hasCurrentBillingSide(row, row.upstream);
      const counted = current ? finiteMoney(row.upstream?.countedAmountUsd) : null;
      if (counted != null) accountedUsd += counted;
      // 重复归属的成本记在归属关联上；归属待核验或账单不完整时，已核算金额只是下限。
      if (!current || billingState(row.upstream) !== "complete" || row.upstream?.ownershipState === "unknown") accountedComplete = false;
    }
    const factor = cny ? Number(rate.cnyPerUsd) : 1;
    const accountUsd = usage ? finiteMoney(usage.usd) : null;
    const unaccountedUsd = accountUsd == null ? null : accountUsd - accountedUsd;
    const notes = [];
    if (usage?.note) notes.push(usage.note);
    if (approximate) notes.push("Sub2API 用量按自然日返回，自定义时段按整日计");
    if (!accountedComplete) notes.push("部分关联的上游成本未取全，已核算金额偏低");
    for (const [name, ids] of groupByStation(borrowed)) notes.push(`已核算含账单授权「${name}」上的核算关联 ${ids.join("、")}`);
    for (const [name, ids] of groupByStation(uncertain)) notes.push(`同站点账单授权「${name}」上的核算关联 ${ids.join("、")} 无法确认是否属于这个账号，未纳入金额可能偏高`);
    if (unaccountedUsd != null && unaccountedUsd < 0) notes.push("已核算成本高于账号扣费，多为两边取数时刻不同或上游扣费尚未入账");
    const state = !usage ? "pending" : accountUsd == null ? "unavailable" : !accountedComplete || usage.lowerBound || uncertain.length ? "partial"
      : approximate || usage.mode === "history" ? "estimated" : "complete";
    return { stationId: station.id, name: station.name, rate: cny ? factor : null,
      mode: usage?.mode ?? null, endMs: usage?.endMs ?? null, state, notes, ruleIds: ruleRows.map((row) => row.rule.id),
      accountUsd, accountedUsd, unaccountedUsd,
      account: accountUsd == null ? null : accountUsd * factor, accounted: accountedUsd * factor,
      unaccounted: unaccountedUsd == null ? null : unaccountedUsd * factor };
  });
  const has = (state) => items.some((item) => item.state === state);
  const state = has("pending") ? "pending" : has("unavailable") || has("partial") ? "partial" : has("estimated") ? "estimated" : "complete";
  return { state, currency: cny ? "CNY" : "USD",
    total: state === "pending" ? null : items.reduce((sum, item) => sum + Math.max(0, item.unaccounted ?? 0), 0), accounts: items };
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

export function reconciliationRowFlags(item = {}, currency = "USD") {
  const issues = item?.health?.issues || [];
  const codes = new Set([item?.health?.code, ...issues.map((issue) => issue?.code)]);
  const healthCode = item?.health?.code;
  const healthMeta = reconciliationHealthMeta(healthCode);
  const healthLabel = healthCode === "GROUP_DATA_UNAVAILABLE" ? "当前上游分组目录不可用"
    : healthCode === "PERSISTENCE_FAILED" ? "核算结果保存失败" : healthMeta.label;
  const calculation = reconciliationCalculationValues(item?.calculation, item?.health, item, currency);
  // 负毛利按显示口径判断：固定采购上游的成本记为 0，账单原币差额为负也不算负毛利。
  const profit = calculation.profit;
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
    secondaryStatuses: [
      ...(disabledCount && status.label !== "本站销售渠道已禁用" ? [{ label: `渠道禁用 ${disabledCount}`, tone: "warning" }] : []),
      ...(item?.scope?.recalculated ? [{ label: "已按新配置重算", tone: "neutral" }] : []),
      ...(item?.scope?.notEffective ? [{ label: "关联生效前，不计金额", tone: "neutral" }] : []),
    ],
    severity,
  };
}

export function filterReconciliationResults(results = [], upstreams = [], search = "", filter = "all", currency = "USD") {
  const needle = String(search).trim().toLocaleLowerCase();
  const stations = new Map((Array.isArray(upstreams) ? upstreams : []).map((station) => [String(station.id), station.name]));
  return results.filter((item) => {
    const flags = reconciliationRowFlags(item, currency);
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
  }).sort((a, b) => reconciliationRowFlags(a, currency).severity - reconciliationRowFlags(b, currency).severity);
}
