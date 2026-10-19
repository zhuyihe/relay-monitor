import { createHash } from "node:crypto";
import { COVERAGE_ANSWERS, isScopedBillingPolicy, reconciliationAccountingStart, reconciliationIssue } from "./reconciliation-contract.js";

export { isScopedBillingPolicy, reconciliationAccountingStart };

function parts(ms, timezone) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (key) => Number(values.find((part) => part.type === key)?.value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

function startOfDate(date, timezone) {
  const wall = Date.UTC(date.year, date.month - 1, date.day);
  let candidate = wall;
  for (let i = 0; i < 4; i += 1) {
    const actual = parts(candidate, timezone);
    const next = wall - (Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) - candidate);
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

export function nextBillingEffectiveFrom(timezone = "Asia/Shanghai", now = Date.now()) {
  const today = parts(now, timezone);
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return startOfDate({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() }, timezone);
}

export function completedBillingDayWindow(timezone = "Asia/Shanghai", now = Date.now()) {
  const today = parts(now, timezone);
  const yesterday = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  return { startMs: startOfDate({ year: yesterday.getUTCFullYear(), month: yesterday.getUTCMonth() + 1, day: yesterday.getUTCDate() }, timezone),
    endMs: startOfDate(today, timezone), timezone };
}

export function startOfBillingDay(ms, timezone = "Asia/Shanghai") {
  return startOfDate(parts(ms, timezone), timezone);
}

// 窗口里有一部分早于最近一次修改：过渡期这部分也按当前配置计算。
export function scopeRecalculatedInWindow(rule, window) {
  const start = reconciliationAccountingStart(rule);
  return start != null && (rule.scopeVersion || 1) > 1 && Number.isFinite(rule.billingEffectiveFrom)
    && window.startMs < rule.billingEffectiveFrom && window.endMs > start;
}

export function reconciliationBillingSchedule(rule) {
  const effectiveFrom = Number.isFinite(rule.billingEffectiveFrom) ? rule.billingEffectiveFrom : null;
  const accountingStart = reconciliationAccountingStart(rule) ?? effectiveFrom;
  const firstSettleAt = accountingStart == null ? null : nextBillingEffectiveFrom(rule.timezone, accountingStart);
  return { scopeVersion: rule.scopeVersion ?? null, billingEffectiveFromMs: effectiveFrom, accountingStartMs: accountingStart,
    firstFullDayStartMs: accountingStart == null ? null : startOfBillingDay(accountingStart, rule.timezone) === accountingStart ? accountingStart : firstSettleAt,
    firstQueryableAtMs: firstSettleAt };
}

export function isCompletedBillingWindow(window, now = Date.now()) {
  if (!window || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs <= window.startMs) return false;
  const midnight = (ms) => startOfDate(parts(ms, window.timezone), window.timezone);
  return window.startMs === midnight(window.startMs) && window.endMs === midnight(window.endMs) && window.endMs <= midnight(now);
}

// 窗口恰好是 timezone 下的一个自然日时返回该日（YYYY-MM-DD），否则 null。账本只按自然日记账。
export function billingDayOf(window) {
  if (!window || typeof window.timezone !== "string" || !window.timezone
    || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) return null;
  try {
    if (startOfBillingDay(window.startMs, window.timezone) !== window.startMs
      || nextBillingEffectiveFrom(window.timezone, window.startMs) !== window.endMs) return null;
    const day = parts(window.startMs, window.timezone);
    return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function canonicalBillingKey(station, metadata, tokenId) {
  const provider = metadata?.platform || metadata?.provider || station.verifiedIdentity?.provider || (station.type.startsWith("sub2api") ? "sub2api" : "newapi");
  const accountId = metadata?.accountId ?? metadata?.userId ?? station.verifiedIdentity?.accountId;
  if (accountId == null || String(accountId).trim() === "") return null;
  const panel = new URL(String(station.baseUrl || "").trim()).href.replace(/\/+$/, "");
  return createHash("sha256").update(JSON.stringify([provider, panel, String(accountId), String(tokenId)])).digest("hex");
}

export function scopePolicyIssues(rule, window, now = Date.now()) {
  if (!isScopedBillingPolicy(rule.billingPolicy) || rule.costCoverage === "complete") return [];
  // 说明用问题表里同一句（§5.2），不另写
  return [{ code: "COST_COVERAGE_UNKNOWN", scope: "rule", detail: reconciliationIssue("COST_COVERAGE_UNKNOWN").detail, observedAt: now }];
}

function bindings(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([id, revision]) => /^\d+$/.test(id) && Number(id) > 0 && typeof revision === "string")
    .sort(([a], [b]) => Number(a) - Number(b)));
}

// 「去回答」的回答以 COVERAGE_ANSWERS 为准：answer 认不出时按 costCoverage 退回，otherUse 只留表里有的 answer / otherUse 组合。
function coverageDeclaration(value, costCoverage = "unknown") {
  const answer = COVERAGE_ANSWERS.some((item) => item.answer === value?.answer) ? value.answer : costCoverage === "complete" ? "none" : "unknown";
  const option = COVERAGE_ANSWERS.find((item) => item.answer === answer && item.otherUse && item.otherUse === value?.otherUse);
  return { answer, otherUse: option ? option.otherUse : null,
    uncoveredOwnChannelIds: [...new Set((Array.isArray(value?.uncoveredOwnChannelIds) ? value.uncoveredOwnChannelIds : []).map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b) };
}

export function normalizeRuleSourceBinding(value, costCoverage = "unknown") {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const envelope = value?.version === 2;
  const source = envelope ? value.ownSource : null;
  const ownSource = source?.provider === "newapi" && source.stationId && source.baseUrl && source.accountId != null && source.namespaceKey
    ? { stationId: String(source.stationId), provider: "newapi", baseUrl: String(source.baseUrl), accountId: String(source.accountId), namespaceKey: String(source.namespaceKey) } : null;
  return { sourceBinding: value == null ? null : bindings(envelope ? value.channels : value), ownSource,
    coverageDeclaration: coverageDeclaration(envelope ? value.coverageDeclaration : null, costCoverage) };
}

export function serializeRuleSourceBinding(rule) {
  if (rule.sourceBinding == null && !rule.ownSource) return null;
  return { version: 2, channels: bindings(rule.sourceBinding), ownSource: rule.ownSource || null,
    coverageDeclaration: coverageDeclaration(rule.coverageDeclaration, rule.costCoverage) };
}

export function applyScopePolicy(existing, input, now = Date.now(), { append = false } = {}) {
  const explicitDeclaration = input.coverageDeclaration != null;
  const explicitCoverage = input.costCoverage != null;
  input = { ...existing, ...input };
  if (append) {
    const channels = new Map((existing?.channels || []).map((channel) => [channel.channelId, channel]));
    for (const channel of input.channels || []) channels.set(channel.channelId, channel);
    input.channels = [...channels.values()];
    input.sourceBinding = { ...existing?.sourceBinding, ...input.sourceBinding };
  }
  const channelIds = (channels) => (channels || []).map((channel) => Number(channel.channelId)).sort((a, b) => a - b);
  const declaredCoverage = input.costCoverage ?? existing?.costCoverage ?? "unknown";
  const sourceBinding = input.sourceBinding ?? existing?.sourceBinding ?? null;
  const ownSource = input.ownSource ?? existing?.ownSource ?? null;
  const declaration = coverageDeclaration(explicitDeclaration ? input.coverageDeclaration : explicitCoverage ? null : existing?.coverageDeclaration, declaredCoverage);
  const costCoverage = explicitDeclaration ? declaration.answer === "none" ? "complete" : "unknown" : declaredCoverage;
  const changed = !existing || JSON.stringify(channelIds(existing.channels)) !== JSON.stringify(channelIds(input.channels))
    || existing.timezone !== input.timezone
    || (existing.canonicalKey || null) !== (input.canonicalKey || null) || String(existing.tokenId ?? "") !== String(input.tokenId ?? "")
    || costCoverage !== existing.costCoverage
    || JSON.stringify(bindings(sourceBinding)) !== JSON.stringify(bindings(existing.sourceBinding))
    || (ownSource?.namespaceKey || null) !== (existing.ownSource?.namespaceKey || null)
    || JSON.stringify(declaration) !== JSON.stringify(coverageDeclaration(existing.coverageDeclaration, existing.costCoverage));
  if (!changed) return { ...input, billingPolicy: existing.billingPolicy || "legacy-v3", scopeVersion: existing.scopeVersion || 1,
    billingEffectiveFrom: existing.billingEffectiveFrom ?? null, costCoverage, sourceBinding, ownSource, coverageDeclaration: declaration, scopeChanged: false };
  // 确认即生效：生效时刻就是本次保存时刻。previewEffectiveFromMs 仍被旧客户端带上，这里不再据此拒绝。
  return { ...input, billingPolicy: "immediate", scopeVersion: existing ? (existing.scopeVersion || 1) + 1 : 1,
    billingEffectiveFrom: now, costCoverage, sourceBinding, ownSource, coverageDeclaration: declaration, scopeChanged: true };
}
