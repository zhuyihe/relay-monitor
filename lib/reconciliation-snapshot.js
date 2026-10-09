import { createHash } from "node:crypto";

function localDate(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function reconciliationScopeFingerprint(rule, segments) {
  const scope = {
    upstreamStationId: rule.upstreamStationId,
    ownStationId: rule.ownStationId,
    tokenId: Number(rule.tokenId),
    tokenName: rule.tokenName,
    timezone: rule.timezone,
    channelIds: rule.channels.map((channel) => Number(channel.channelId)).sort((a, b) => a - b),
    segments: segments.map((segment) => ({
      id: segment.id,
      group: segment.group,
      ratio: segment.ratio,
      effectiveFrom: segment.effectiveFrom,
      effectiveTo: segment.effectiveTo,
    })),
  };
  // 未改变的 v3 规则保持原快照身份；新范围不能读取旧范围为当前账单。
  if (rule.billingPolicy === "next-complete-day" || Object.keys(rule.sourceBinding || {}).length) {
    scope.billingPolicy = rule.billingPolicy;
    scope.scopeVersion = rule.scopeVersion;
    scope.billingEffectiveFrom = rule.billingEffectiveFrom;
    scope.costCoverage = rule.costCoverage;
    scope.canonicalKey = rule.canonicalKey;
    scope.sourceBinding = Object.fromEntries(Object.entries(rule.sourceBinding || {}).sort(([a], [b]) => Number(a) - Number(b)));
    if (rule.ownSource) scope.ownSource = rule.ownSource;
    if (rule.coverageDeclaration) scope.coverageDeclaration = rule.coverageDeclaration;
  }
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 24);
}

export function reconciliationSnapshotIdentity(window, scopeFingerprint) {
  if (window.preset === "today") return `today:${localDate(window.startMs, window.timezone)}:${window.timezone}:${scopeFingerprint}`;
  if (window.preset === "7d") return `7d:${window.startMs}:${window.timezone}:${scopeFingerprint}`;
  return `${window.preset}:${window.startMs}:${window.endMs}:${window.timezone}:${scopeFingerprint}`;
}

// Snapshot keys are indexed VARCHAR(128). Keep record-kind separation and the
// whole logical identity in a compact digest rather than letting a long custom
// timezone or segment id overflow the database key.
export function reconciliationSnapshotRecordIdentity(window, scopeFingerprint, recordType, segmentId) {
  const type = recordType === "confirmed" ? "c" : "o";
  const identity = reconciliationSnapshotIdentity(window, scopeFingerprint);
  const logicalDigest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const segmentDigest = createHash("sha256").update(String(segmentId || "legacy")).digest("hex").slice(0, 16);
  return `r3:${type}:${logicalDigest}:${segmentDigest}`;
}

export function reconciliationSnapshotRecordPrefix(window, scopeFingerprint, recordType) {
  const type = recordType === "confirmed" ? "c" : "o";
  const identity = reconciliationSnapshotIdentity(window, scopeFingerprint);
  const logicalDigest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `r3:${type}:${logicalDigest}:`;
}

function savedIdentity(value) {
  if (!value || !["newapi", "sub2api"].includes(value.provider)) return null;
  let baseUrl = null;
  try {
    const url = new URL(value.baseUrl);
    baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch { /* Original identity may be absent in legacy evidence. */ }
  return { provider: value.provider, baseUrl, accountId: value.accountId == null ? null : String(value.accountId) };
}

function savedOwnSource(value) {
  if (value?.provider !== "newapi") return null;
  const identity = savedIdentity(value);
  return identity ? { stationId: value.stationId == null ? null : String(value.stationId), ...identity,
    namespaceKey: value.namespaceKey == null ? null : String(value.namespaceKey) } : null;
}

function savedChannels(value) {
  return (Array.isArray(value) ? value : []).filter((channel) => Number.isSafeInteger(Number(channel.channelId)) && Number(channel.channelId) > 0)
    .map((channel) => ({ channelId: Number(channel.channelId), name: typeof channel.name === "string" ? channel.name : null }));
}

export function reconciliationRuleEvidence(rule, upstreamIdentity) {
  return { ownSource: savedOwnSource(rule.ownSource), upstreamIdentity: savedIdentity(upstreamIdentity),
    canonicalKey: rule.canonicalKey || null, tokenId: rule.tokenId, tokenName: rule.tokenName,
    channels: savedChannels(rule.channels), scopeVersion: rule.scopeVersion ?? null };
}

export function reconciliationConfirmedHistoryRecord(row) {
  let source = row.source;
  if (typeof source === "string") { try { source = JSON.parse(source); } catch { source = null; } }
  source ||= {};
  const result = source.result || {}, evidence = source.ruleEvidence || {}, policy = source.scopePolicy || {};
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const original = source.window;
  const logical = number(original?.startMs) != null && number(original?.endMs) != null && original.endMs > original.startMs;
  const window = { preset: typeof original?.preset === "string" ? original.preset : row.window_kind,
    startMs: logical ? original.startMs : Number(row.window_start_ms), endMs: logical ? original.endMs : Number(row.window_end_ms),
    timezone: logical && typeof original.timezone === "string" ? original.timezone : null };
  const ownSource = savedOwnSource(evidence.ownSource || policy.ownSource || source.ownSource || result.ownSource);
  const upstreamIdentity = savedIdentity(evidence.upstreamIdentity || source.upstreamIdentity);
  const channels = savedChannels(evidence.channels || result.downstream?.channels || source.downstream?.channels);
  const tokenId = number(evidence.tokenId ?? source.upstream?.tokenId), tokenName = evidence.tokenName ?? source.upstream?.tokenName ?? null;
  const side = (value = {}) => ({ state: ["complete", "partial", "unavailable", "pending"].includes(value.state) ? value.state : null,
    quotaUnits: number(value.quotaUnits), quotaPerUnit: number(value.quotaPerUnit), amountUsd: number(value.amountUsd),
    knownAmountUsd: number(value.knownAmountUsd), countedAmountUsd: number(value.countedAmountUsd),
    successfulCount: number(value.successfulCount), expectedCount: number(value.expectedCount), observedAt: number(value.observedAt), window });
  const billedChannels = result.downstream?.channels || source.downstream?.channels;
  const downstream = { ...side(result.downstream), channels: (Array.isArray(billedChannels) ? billedChannels : []).map((channel) => ({
    ...savedChannels([channel])[0], billingState: ["complete", "partial", "unavailable", "pending"].includes(channel.billingState) ? channel.billingState : null,
    quotaUnits: number(channel.quotaUnits), amountUsd: number(channel.amountUsd), knownAmountUsd: number(channel.knownAmountUsd),
  })).filter((channel) => channel.channelId != null) };
  const scopeVersion = number(evidence.scopeVersion ?? policy.scopeVersion);
  const calculation = Object.fromEntries(["differenceUsd", "profitUsd", "riskDifferenceUsd", "marginRate"].map((key) => [key, number(result.calculation?.[key])]));
  const amountBasis = { id: "channel-billing-usd-v3", currency: "USD", billingSource: "channel-log-stat",
    calculationVersion: 3, conversion: upstreamIdentity?.provider === "sub2api" ? "provider_cost_usd"
      : number(result.upstream?.quotaPerUnit) > 0 ? "quota_per_unit" : null };
  const scopeFingerprint = typeof source.scopeFingerprint === "string" ? source.scopeFingerprint : null;
  const originalGeneration = typeof source.resultGeneratedAt === "string" ? source.resultGeneratedAt : null;
  const confirmedAt = originalGeneration && Number.isFinite(Date.parse(originalGeneration)) ? originalGeneration : new Date(row.generated_at).toISOString();
  return { historyId: createHash("sha256").update(JSON.stringify([row.rule_id, window, scopeFingerprint, originalGeneration,
    logical && scopeFingerprint && originalGeneration ? null : row.snapshot_key])).digest("hex").slice(0, 24),
    confirmedAt, window, ownSource,
    upstreamSource: { provider: upstreamIdentity?.provider ?? null, baseUrl: upstreamIdentity?.baseUrl ?? null,
      accountId: upstreamIdentity?.accountId ?? null, tokenId, tokenName: typeof tokenName === "string" ? tokenName : null },
    scopeVersion, scopeFingerprint,
    billingEffectiveFromMs: number(policy.billingEffectiveFrom ?? result.scope?.billingEffectiveFromMs), channels, amountBasis,
    upstream: side(result.upstream), downstream, calculation,
    sourceCompleteness: logical && ownSource?.namespaceKey && upstreamIdentity?.accountId && upstreamIdentity.baseUrl
      && typeof evidence.canonicalKey === "string" && tokenId != null && typeof tokenName === "string" && scopeVersion != null && channels.length
      && channels.every((channel) => channel.name != null) ? "complete" : "legacy_partial" };
}
