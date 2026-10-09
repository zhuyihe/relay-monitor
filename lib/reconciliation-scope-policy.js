import { createHash } from "node:crypto";

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

export function canonicalBillingKey(station, metadata, tokenId) {
  const provider = metadata?.platform || metadata?.provider || station.verifiedIdentity?.provider || (station.type.startsWith("sub2api") ? "sub2api" : "newapi");
  const accountId = metadata?.accountId ?? metadata?.userId ?? station.verifiedIdentity?.accountId;
  if (accountId == null || String(accountId).trim() === "") return null;
  const panel = new URL(String(station.baseUrl || "").trim()).href.replace(/\/+$/, "");
  return createHash("sha256").update(JSON.stringify([provider, panel, String(accountId), String(tokenId)])).digest("hex");
}

export function scopePolicyIssues(rule, window, now = Date.now()) {
  if (rule.billingPolicy !== "next-complete-day") return [];
  const issues = [];
  const issue = (code, detail) => issues.push({ code, scope: "rule", detail, observedAt: now });
  if (rule.costCoverage !== "complete") issue("COST_COVERAGE_UNKNOWN", "尚未确认该 Key 的全部消费均对应关联渠道，金额仅供参考");
  if (!Number.isFinite(rule.billingEffectiveFrom) || window.startMs < rule.billingEffectiveFrom) {
    issue("BILLING_SCOPE_NOT_EFFECTIVE", "本次范围包含关联生效之前的时段，金额仅供参考");
  }
  const midnight = (ms) => startOfDate(parts(ms, window.timezone), window.timezone);
  if (window.startMs !== midnight(window.startMs) || window.endMs !== midnight(window.endMs)
    || window.endMs > midnight(now) || window.timezone !== rule.timezone) {
    issue("BILLING_WINDOW_UNCONFIRMED", "精确利润需使用已结束的共同完整自然日，当前窗口金额仅供参考");
  }
  return issues;
}

function bindings(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => Number(a) - Number(b)));
}

export function applyScopePolicy(existing, input, now = Date.now()) {
  const channelIds = (channels) => (channels || []).map((channel) => Number(channel.channelId)).sort((a, b) => a - b);
  const costCoverage = input.costCoverage ?? existing?.costCoverage ?? "unknown";
  const sourceBinding = input.sourceBinding ?? existing?.sourceBinding ?? null;
  const changed = !existing || JSON.stringify(channelIds(existing.channels)) !== JSON.stringify(channelIds(input.channels))
    || existing.timezone !== input.timezone || existing.enabled !== (input.enabled !== false)
    || costCoverage !== existing.costCoverage
    || JSON.stringify(bindings(sourceBinding)) !== JSON.stringify(bindings(existing.sourceBinding));
  if (!changed) return { ...input, billingPolicy: existing.billingPolicy || "legacy-v3", scopeVersion: existing.scopeVersion || 1,
    billingEffectiveFrom: existing.billingEffectiveFrom ?? null, costCoverage, sourceBinding, scopeChanged: false };
  const billingEffectiveFrom = nextBillingEffectiveFrom(input.timezone, now);
  if (input.previewEffectiveFromMs != null && Number(input.previewEffectiveFromMs) !== billingEffectiveFrom) {
    const error = new Error("确认时间已跨过日期边界，请查看更新后的生效日期并重新确认");
    error.code = "EFFECTIVE_PREVIEW_CHANGED";
    error.billingEffectiveFrom = billingEffectiveFrom;
    throw error;
  }
  return { ...input, billingPolicy: "next-complete-day", scopeVersion: existing ? (existing.scopeVersion || 1) + 1 : 1,
    billingEffectiveFrom, costCoverage, sourceBinding, scopeChanged: true };
}
