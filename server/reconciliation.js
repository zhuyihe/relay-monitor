// 对账深模块：把窗口、上游取数、本站收费、快照和告警收敛在一个 Interface 后。
import { createHash } from "node:crypto";
import {
  queryReconciliationMetadata,
  queryNewApiStatus,
  queryKeyReconciliationStat,
  queryOwnChannelRevenue,
  queryOwnChannels,
  unixSecondWindow,
} from "../lib/providers.js";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_CALCULATION_VERSION,
  reconciliationHealthMeta,
} from "../lib/reconciliation-contract.js";
import { ReconciliationRepository } from "./reconciliation-repository.js";
import { notifyReconciliationHealth } from "./reconciliation-notify.js";
import { reconciliationScopeFingerprint, reconciliationSnapshotRecordIdentity } from "../lib/reconciliation-snapshot.js";
import { describeConnectionFailure } from "../lib/connection-test.js";
import { canonicalBillingKey, nextBillingEffectiveFrom, scopePolicyIssues } from "../lib/reconciliation-scope-policy.js";

export { reconciliationScopeFingerprint } from "../lib/reconciliation-snapshot.js";

const DAY_MS = 86400000;
const MAX_CONCURRENT_RULES = 6;

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
const TODAY_TTL_MS = 60000;
const QUERY_TTL_MS = 60000;
const MAX_RESULT_CACHE_ENTRIES = 200;
const STALE_SCOPE = Symbol("STALE_SCOPE");
const MAX_SCOPE_ATTEMPTS = 3;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validateTimezone(input) {
  const timezone = String(input || "Asia/Shanghai");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch {
    throw new Error("时区无效");
  }
  return timezone;
}

function zonedParts(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function shiftedCalendarDate(part, days) {
  const date = new Date(Date.UTC(part.year, part.month - 1, part.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function calendarMidnight(part, timezone) {
  const wallTime = Date.UTC(part.year, part.month - 1, part.day);
  let candidate = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(candidate, timezone);
    const observedWallTime = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const next = wallTime - (observedWallTime - candidate);
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

function midnight(ms, timezone, days = 0) {
  return calendarMidnight(shiftedCalendarDate(zonedParts(ms, timezone), days), timezone);
}

function localDate(ms, timezone) {
  const part = zonedParts(ms, timezone);
  return `${part.year}-${String(part.month).padStart(2, "0")}-${String(part.day).padStart(2, "0")}`;
}

export function resolveReconciliationWindow(input = {}, now = Date.now()) {
  const timezone = validateTimezone(input.timezone);
  const preset = ["today", "yesterday", "7d", "custom"].includes(input.preset) ? input.preset : "today";
  let startMs;
  let endMs;
  // 所有窗口都是规则时区下的半开区间 [startMs, endMs)，结束点不晚于当前时刻。两侧都按秒级日志统计取数，
  // 把窗口延伸到未来取不到更多账单，只会把未来时刻写进快照和界面；晚落库的日志由下一轮刷新补齐。
  if (preset === "custom") {
    startMs = finite(input.startMs);
    endMs = finite(input.endMs);
    if (startMs == null || endMs == null || startMs >= endMs) throw new Error("自定义时间段无效");
    if (endMs > now) throw new Error("自定义时间段不能超过当前时间");
  } else {
    const dayStart = midnight(now, timezone);
    if (preset === "yesterday") {
      startMs = midnight(now, timezone, -1);
      endMs = dayStart;
    } else if (preset === "7d") {
      startMs = midnight(now, timezone, -6);
      endMs = now;
    } else {
      startMs = dayStart;
      endMs = now;
    }
  }
  if (endMs - startMs > 31 * DAY_MS) throw new Error("单次查询时间范围不能超过 31 天");
  return { preset, timezone, startMs: Math.floor(startMs), endMs: Math.floor(endMs) };
}

function publicStation(station) {
  return station ? { id: station.id, name: station.name, type: station.type, monitorEnabled: station.monitorEnabled !== false, cnyPerUsd: station.cnyPerUsd ?? null } : null;
}

function publicMetadata(metadata) {
  return {
    quotaPerUnit: metadata.quotaPerUnit,
    version: metadata.version,
    groups: metadata.groups,
    platform: metadata.platform,
    capability: metadata.capability,
    tokens: metadata.tokens.map((token) => ({
      id: token.id,
      name: token.name,
      status: token.status,
      group: token.group,
      crossGroupRetry: token.crossGroupRetry,
    })),
  };
}

function health(code, detail = "") {
  return { code, label: reconciliationHealthMeta(code).label || code, detail, stale: code === "STALE" };
}

function ruleNotFound() {
  const error = new Error("对账规则不存在");
  error.code = "RULE_NOT_FOUND";
  return error;
}

// 站点编辑会原地改写 station 对象：缓存带上凭据指纹，换了地址、令牌或用户后不再复用旧凭据读到的数据。
function credentialFingerprint(station) {
  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  const fields = [String(station.baseUrl || ""), passwordMode ? "" : String(station.accessToken || ""), String(station.userId || "")];
  if (station.type?.startsWith("sub2api")) fields.push(station.type, station.authMode || "", station.authVersion ?? null,
    passwordMode ? "" : String(station.apiKey || ""),
    passwordMode ? String(station.email || "") : "", passwordMode ? String(station.password || "") : "");
  return createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");
}

function sourceCredentialFingerprint(upstream, own) {
  const stationSource = (station) => station ? [station.id, station.type, !!station.isOwn, credentialFingerprint(station)] : null;
  return createHash("sha256")
    .update(JSON.stringify([stationSource(upstream), stationSource(own)]))
    .digest("hex");
}

function sourceScopeFingerprint(ruleScopeFingerprint, sourceCredential) {
  // 保留旧快照作为证据；站点地址、PAT 或身份变化后不能拿旧账单兜底新来源。
  return createHash("sha256").update(`${ruleScopeFingerprint}:${sourceCredential}`).digest("hex").slice(0, 24);
}

// 本轮还不能核算、也不代表任何异常的结果：不写快照、不告警、不缓存，下一轮刷新再取。
function pendingResult(rule, window, detail, { currentSegment = null, transitionSegments = [], issues = [] } = {}) {
  return {
    rule,
    window,
    requestedWindow: window,
    lastSuccessfulWindow: null,
    currentSegment,
    segments: [],
    transitionSegments,
    upstream: null,
    downstream: null,
    calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
    health: { ...health("PENDING", detail), issues },
    generatedAt: new Date().toISOString(),
  };
}

function intersectSegment(window, segment) {
  const startMs = Math.max(window.startMs, segment.effectiveFrom);
  const endMs = Math.min(window.endMs, segment.effectiveTo ?? window.endMs);
  return startMs < endMs ? { ...window, startMs, endMs } : null;
}

function channelState(status) {
  if (Number(status) === 1) return "enabled";
  if (Number(status) === 2) return "manual_disabled";
  if (Number(status) === 3) return "auto_disabled";
  return "unknown";
}

function healthWithIssues(issues) {
  const priority = ["KEY_INVALID_OR_DENIED", "SOURCE_BINDING_UNCONFIRMED", "CANONICAL_KEY_CONFLICT", "UPSTREAM_DATA_UNAVAILABLE", "OWN_BILLING_UNAVAILABLE", "OWN_FLOW_INCOMPLETE", "UPSTREAM_EMPTY_WITH_SALES", "UPSTREAM_CAPABILITY_UNVERIFIED", "COST_COVERAGE_UNKNOWN", "BILLING_SCOPE_NOT_EFFECTIVE", "BILLING_WINDOW_UNCONFIRMED", "GROUP_DATA_UNAVAILABLE", "PENDING", "SALES_CHANNEL_MISSING", "SALES_CHANNEL_DISABLED", "SALES_CHANNEL_STATE_UNKNOWN", "ROUTE_TRANSITION_DETECTED", "SEGMENT_TIMING_UNCONFIRMED"];
  const first = priority.find((code) => issues.some((issue) => issue.code === code));
  const base = first ? health(first, issues.find((issue) => issue.code === first)?.detail || "") : health("READY");
  return { ...base, issues };
}

function persistenceFailedResult(rule, window) {
  const observedAt = Date.now();
  const channels = rule.channels.map((channel) => ({ ...channel, billingState: "unavailable", quotaUnits: null, amountUsd: null, knownAmountUsd: null }));
  const issue = { code: "PERSISTENCE_FAILED", scope: "persistence", detail: "本轮对账结果未能保存，请稍后重试", observedAt };
  return {
    rule, window, requestedWindow: window, lastSuccessfulWindow: null, currentSegment: null, segments: [], transitionSegments: [],
    upstream: { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: 1, observedAt, window },
    downstream: { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: rule.channels.length, billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION, observedAt, window, channels },
    calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
    health: { ...health("PERSISTENCE_FAILED", issue.detail), issues: [issue] }, generatedAt: new Date().toISOString(),
  };
}

function snapshotReference(record) {
  return {
    generatedAt: record.generatedAt,
    window: record.result.lastSuccessfulWindow || record.result.window,
    upstream: record.result.upstream,
    downstream: record.result.downstream,
    calculation: record.result.calculation,
    health: record.result.health,
  };
}

function toErrorHealth(err, own = false) {
  const code = String(err?.code || "");
  if (!own && code === "UPSTREAM_AUTH_DENIED") {
    return health("KEY_INVALID_OR_DENIED", "上游 PAT 无权读取 Key 或消费日志");
  }
  if (!own && code === "UPSTREAM_STAT_UNAVAILABLE") {
    return health("UPSTREAM_DATA_UNAVAILABLE", "上游日志统计接口不可用或返回无效数据");
  }
  return health(own ? "OWN_BILLING_UNAVAILABLE" : "UPSTREAM_DATA_UNAVAILABLE",
    own ? "无法完整读取本站渠道账单统计" : "无法完整读取上游对账数据");
}

const CALCULATION_BLOCKERS = new Set([
  "KEY_INVALID_OR_DENIED",
  "UPSTREAM_DATA_UNAVAILABLE",
  "OWN_BILLING_UNAVAILABLE",
  "OWN_FLOW_INCOMPLETE",
  "UPSTREAM_EMPTY_WITH_SALES",
  "SOURCE_BINDING_UNCONFIRMED",
  "CANONICAL_KEY_CONFLICT",
  "COST_COVERAGE_UNKNOWN",
  "BILLING_SCOPE_NOT_EFFECTIVE",
  "BILLING_WINDOW_UNCONFIRMED",
  "UPSTREAM_CAPABILITY_UNVERIFIED",
]);

function calculationFromAmounts(upstreamUsd, downstreamUsd, issues = []) {
  const differenceUsd = upstreamUsd == null || downstreamUsd == null ? null : downstreamUsd - upstreamUsd;
  const confirmed = differenceUsd != null && !issues.some((issue) => CALCULATION_BLOCKERS.has(issue.code));
  return {
    differenceUsd,
    profitUsd: confirmed ? differenceUsd : null,
    riskDifferenceUsd: confirmed ? null : differenceUsd,
    marginRate: confirmed && downstreamUsd > 0 ? differenceUsd / downstreamUsd : null,
  };
}

function sourceSnapshot(token, metadata, upstream, downstream) {
  return {
    calculationVersion: RECONCILIATION_CALCULATION_VERSION,
    billingSource: RECONCILIATION_BILLING_SOURCE,
    upstream: {
      tokenId: token.id,
      tokenName: token.name,
      group: token.group,
      ratio: metadata.groups?.[token.group]?.ratio ?? null,
      status: token.status,
      latestLogAtMs: upstream?.latestLogAtMs ?? null,
    },
    downstream: {
      calculationVersion: RECONCILIATION_CALCULATION_VERSION,
      billingSource: RECONCILIATION_BILLING_SOURCE,
      billingCoverage: downstream?.billingCoverage ?? downstream?.coverage ?? null,
      coverage: downstream?.coverage ?? null,
      channels: downstream?.channels?.map((channel) => ({
        channelId: channel.channelId,
        quotaUnits: channel.quotaUnits,
        amountUsd: channel.amountUsd,
      })) || [],
    },
  };
}

export function createReconciliationModule(rt) {
  const repository = new ReconciliationRepository(rt.pool);
  const resultCache = (rt._reconciliationResultCache ||= new Map());
  const inflight = (rt._reconciliationInflight ||= new Map());
  const metadataCache = (rt._reconciliationMetadataCache ||= new Map());
  const ownChannelsCache = (rt._reconciliationOwnChannelsCache ||= new Map());
  const ownChannelsRequests = (rt._reconciliationOwnChannelsRequests ||= new Map());
  const ruleGenerations = (rt._reconciliationRuleGenerations ||= new Map());
  const verifiedRuleCredentials = new WeakMap();
  const billingStation = (station) => station && ["newapi", "sub2api", "sub2api-password"].includes(station.type) && !station.isOwn;
  const billingSourceState = () => {
    const stations = rt.store.list({ includeUnmonitored: true, includeArchived: true })
      .filter((station) => ["newapi", "sub2api", "sub2api-password"].includes(station.type))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { stationIds: stations.map((station) => station.id),
      version: createHash("sha256").update(JSON.stringify([rt._reconciliationBillingGeneration || 0,
        stations.map((station) => [station.id, !!station.isOwn, station.archivedAt || null, credentialFingerprint(station)])])).digest("hex") };
  };
  const sourceState = (rule) => {
    if (!Object.keys(rule.sourceBinding || {}).length) return rule.billingPolicy === "next-complete-day"
      ? { version: "missing-confirmation", status: "unavailable" } : { version: "legacy", status: "confirmed" };
    return rt.onboardingSource?.inspectSource?.(rule) || { version: "unavailable", status: "unavailable" };
  };
  const withSourceLock = (rule, write) => rt.onboardingSource?.withSourceLock ? rt.onboardingSource.withSourceLock(rule, write) : write();
  function serializeWrite(write) {
    const pending = (rt._reconciliationWriteChain || Promise.resolve()).then(write);
    rt._reconciliationWriteChain = pending.catch(() => {});
    return pending;
  }
  function assertSourceConfirmation(rule, channels, confirmation) {
    if (!Object.keys(confirmation.sourceBinding || {}).length) return;
    const members = new Map((rule.channels || []).map((channel) => [channel.channelId, channel]));
    for (const channel of channels) members.set(channel.channelId, channel);
    const proposed = { ...rule, channels: [...members.values()], sourceBinding: { ...rule.sourceBinding, ...confirmation.sourceBinding } };
    if (sourceState(proposed).status !== "confirmed") {
      throw Object.assign(new Error("渠道来源在确认期间变化，请刷新后重新确认"), { code: "SOURCE_BINDING_UNCONFIRMED" });
    }
  }

  const resultKey = (rule, window) => window.preset === "today"
    ? `${rule.id}:today:${window.startMs}:${window.timezone}`
    : `${rule.id}:${window.preset}:${window.startMs}:${window.endMs}:${window.timezone}`;

  function clearRuleResults(ruleId) {
    ruleGenerations.set(ruleId, (ruleGenerations.get(ruleId) || 0) + 1);
    const prefix = `${ruleId}:`;
    for (const key of resultCache.keys()) {
      if (key.startsWith(prefix)) resultCache.delete(key);
    }
    for (const key of inflight.keys()) if (key.startsWith(prefix)) inflight.delete(key);
  }

  // 启用规则集合决定同一实际 Key 的成本归属；一条规则变更也会影响其它规则。
  function clearBillingResults(ruleId) {
    rt._reconciliationBillingGeneration = (rt._reconciliationBillingGeneration || 0) + 1;
    const ids = new Set([ruleId, ...ruleGenerations.keys()]);
    for (const key of [...resultCache.keys(), ...inflight.keys()]) ids.add(key.split(":")[0]);
    for (const id of ids) clearRuleResults(id);
  }

  function cacheResult(key, value, sourceCredential, billingCredential) {
    const now = Date.now();
    const cached = resultCache.get(key);
    const previous = cached?.sourceCredential === sourceCredential && cached?.billingCredential === billingCredential ? cached.value : null;
    const previousEnd = Number(previous?.requestedWindow?.endMs ?? previous?.window?.endMs);
    const nextEnd = Number(value?.requestedWindow?.endMs ?? value?.window?.endMs);
    if (previous && (previousEnd > nextEnd || (previousEnd === nextEnd && String(previous.generatedAt) > String(value.generatedAt)))) return;
    for (const [cachedKey, cached] of resultCache) if (cachedKey !== key && now - cached.at >= QUERY_TTL_MS) resultCache.delete(cachedKey);
    resultCache.set(key, { at: now, value, sourceCredential, billingCredential });
    while (resultCache.size > MAX_RESULT_CACHE_ENTRIES) resultCache.delete(resultCache.keys().next().value);
  }

  async function hasCurrentScope(ruleId, scopeFingerprint, generation) {
    if ((ruleGenerations.get(ruleId) || 0) !== generation) return false;
    const [currentRule, segments] = await Promise.all([repository.getRule(ruleId), repository.listSegments(ruleId)]);
    return !!currentRule && reconciliationScopeFingerprint(currentRule, segments) === scopeFingerprint;
  }

  const ownStation = () => rt.store.list().find((station) => station.isOwn && station.type === "newapi") || null;
  const upstreamStation = (id) => rt.store.get(id) || null;
  const observationCredential = (rule, upstream, own) => {
    const source = sourceState(rule);
    if (source.version === "legacy") return sourceCredentialFingerprint(upstream, own);
    return createHash("sha256").update(JSON.stringify([sourceCredentialFingerprint(upstream, own), source.version, source.status])).digest("hex");
  };
  const currentSourceCredential = (rule) => observationCredential(rule, upstreamStation(rule.upstreamStationId), upstreamStation(rule.ownStationId));
  const withObservationSourceLock = async (rule, sourceCredential, write, billingSource = null) => {
    const verifyAndWrite = async () => currentSourceCredential(rule) === sourceCredential
      && (!billingSource || billingSourceState().version === billingSource.version) ? write() : STALE_SCOPE;
    // Store is the single runtime's source-of-truth boundary.  Older narrow
    // test doubles do not expose it, but production Store always does.
    return withSourceLock(rule, () => typeof rt.store.withStationLocks !== "function" ? verifyAndWrite()
      : rt.store.withStationLocks([rule.upstreamStationId, rule.ownStationId, ...(billingSource?.stationIds || [])], verifyAndWrite));
  };

  // 凭据指纹必须在发请求前取：请求读的是发起时的凭据，等待期间站点可能已被原地改写。
  async function metadataFor(station, { force = false } = {}) {
    const credential = credentialFingerprint(station);
    const cached = metadataCache.get(station.id);
    if (!force && cached?.credential === credential && Date.now() - cached.at < 5 * 60000) return cached.value;
    const value = await queryReconciliationMetadata({ ...station });
    metadataCache.set(station.id, { at: Date.now(), credential, value });
    return value;
  }

  async function ownChannelsFor(station, { force = false } = {}) {
    const credential = credentialFingerprint(station);
    const cached = ownChannelsCache.get(station.id);
    if (!force && cached?.credential === credential && Date.now() - cached.at < 10 * 60000) return cached.value;
    const request = Symbol();
    ownChannelsRequests.set(station.id, request);
    const value = await queryOwnChannels(station);
    if (ownChannelsRequests.get(station.id) === request) ownChannelsCache.set(station.id, { at: Date.now(), credential, value });
    return value;
  }

  async function upstreamWindowFor(upstream, metadata, token, window) {
    return queryKeyReconciliationStat(upstream, {
      token, metadata, timezone: window.timezone,
      startMs: window.startMs,
      endMs: window.endMs,
      // 元数据已用同一 PAT 读到身份和 /api/status（与 Key 校验同一份观察），各分段直接复用，不再逐段探测。
      userId: metadata.userId,
      status: { quotaPerUnit: metadata.quotaPerUnit, version: metadata.version },
    });
  }

  function tokenNameIsUnique(metadata, token) {
    return metadata.platform === "sub2api" || metadata.tokens.filter((item) => item.name === token.name).length === 1;
  }

  async function canonicalRules(canonicalKey, tokenId, { excludeRuleId = null } = {}) {
    const rules = (await repository.listRules()).filter((rule) => rule.enabled && rule.id !== excludeRuleId && rule.tokenId === tokenId);
    const identities = new Map();
    return (await mapWithConcurrency(rules, 4, async (rule) => {
      const configured = upstreamStation(rule.upstreamStationId);
      const station = configured && { ...configured };
      if (!billingStation(station)) return null;
      if (!identities.has(station.id)) identities.set(station.id, metadataFor(station).catch(() => null));
      const metadata = await identities.get(station.id);
      if (credentialFingerprint(upstreamStation(station.id) || {}) !== credentialFingerprint(station)) {
        throw new Error("上游授权在核对期间变化，请刷新后重试");
      }
      if (!metadata || canonicalBillingKey(station, metadata, tokenId) !== canonicalKey) return null;
      verifiedRuleCredentials.set(rule, credentialFingerprint(station));
      return rule;
    })).filter(Boolean);
  }

  async function validateInput(input, { excludeRuleId = null } = {}) {
    const configuredUpstream = upstreamStation(String(input?.upstreamStationId || ""));
    const upstream = configuredUpstream && { ...configuredUpstream };
    if (!billingStation(upstream)) throw new Error("请选择已配置的 NewAPI 或 Sub2API 上游账号");
    const configuredOwn = ownStation();
    const own = configuredOwn && { ...configuredOwn };
    if (!own) throw new Error("还没有标记「我的中转站」的 NewAPI 管理员站点");
    const tokenId = finite(input?.tokenId);
    if (tokenId == null || tokenId <= 0) throw new Error("上游 Key 无效");
    const channelIds = [...new Set((Array.isArray(input?.salesChannelIds) ? input.salesChannelIds : [])
      .map(Number).filter((id) => Number.isFinite(id) && id > 0))];
    if (!channelIds.length) throw new Error("至少选择一个本站销售渠道");
    const timezone = validateTimezone(input?.timezone);
    const [metadata, channels] = await Promise.all([
      metadataFor(upstream, { force: true }),
      ownChannelsFor(own, { force: true }),
    ]);
    const canonicalKey = canonicalBillingKey(upstream, metadata, tokenId);
    if (!canonicalKey) throw new Error("无法验证上游稳定账号身份");
    const matches = await canonicalRules(canonicalKey, tokenId, { excludeRuleId });
    if (matches.length > 1) {
      const error = new Error("多个既有规则对应同一实际 Key，请核对后保留一个启用规则");
      error.code = "CANONICAL_KEY_CONFLICT";
      throw error;
    }
    if (matches[0] && matches[0].ownStationId !== own.id) {
      throw Object.assign(new Error("该实际 Key 的规则属于另一本站来源，请先核对并停止旧规则"), { code: "RULE_OWN_STATION_CONFLICT" });
    }
    const conflicts = await repository.findChannelConflicts(channelIds, { excludeRuleId: matches[0]?.id || excludeRuleId });
    if (conflicts.length) {
      const names = [...new Set(conflicts.map((item) => item.tokenName || item.ruleId))].join("、");
      const error = new Error(`所选渠道已归属启用规则：${names}`);
      error.code = "CHANNEL_CONFLICT";
      error.conflicts = conflicts;
      throw error;
    }
    const token = metadata.tokens.find((item) => item.id === tokenId);
    if (!token) throw new Error("上游 Key 已不存在或当前 PAT 无权读取");
    if (!tokenNameIsUnique(metadata, token)) {
      const error = new Error("上游 Key 名称不唯一，无法安全归属统计账单");
      error.code = "TOKEN_NAME_AMBIGUOUS";
      throw error;
    }
    if (token.status !== 1) throw new Error("上游 Key 未启用");
    if ((metadata.platform !== "sub2api" && !token.group) || token.group === "auto" || token.crossGroupRetry) {
      throw new Error("只能选择固定分组且未开启跨组重试的 Key");
    }
    const byId = new Map(channels.map((channel) => [Number(channel.id), channel]));
    const missing = channelIds.filter((id) => !byId.has(id));
    if (missing.length) throw new Error("所选本站渠道不存在或无管理员权限");
    return {
      upstream,
      own,
      token,
      metadata,
      timezone,
      canonicalKey,
      existingRule: matches[0] || null,
      validationCredential: sourceCredentialFingerprint(upstream, own),
      channels: channelIds.map((id) => ({ channelId: id, name: String(byId.get(id).name || `渠道 ${id}`) })),
    };
  }

  async function validateMutableRuleInput(existing, input) {
    const own = upstreamStation(existing.ownStationId);
    if (!own || !own.isOwn || own.type !== "newapi") throw new Error("还没有标记「我的中转站」的 NewAPI 管理员站点");
    const channelIds = [...new Set((Array.isArray(input?.salesChannelIds) ? input.salesChannelIds : [])
      .map(Number).filter((channelId) => Number.isFinite(channelId) && channelId > 0))];
    if (!channelIds.length) throw new Error("至少选择一个本站销售渠道");
    const timezone = validateTimezone(input?.timezone);
    const [channels, conflicts] = await Promise.all([
      ownChannelsFor(own, { force: true }),
      repository.findChannelConflicts(channelIds, { excludeRuleId: existing.id }),
    ]);
    if (conflicts.length) {
      const names = [...new Set(conflicts.map((item) => item.tokenName || item.ruleId))].join("、");
      const error = new Error(`所选渠道已归属启用规则：${names}`);
      error.code = "CHANNEL_CONFLICT";
      error.conflicts = conflicts;
      throw error;
    }
    const byId = new Map(channels.map((channel) => [Number(channel.id), channel]));
    const missing = channelIds.filter((channelId) => !byId.has(channelId));
    if (missing.length) throw new Error("所选本站渠道不存在或无管理员权限");
    return {
      timezone,
      channels: channelIds.map((channelId) => ({ channelId, name: String(byId.get(channelId).name || `渠道 ${channelId}`) })),
    };
  }

  async function saveRule(input) {
    return serializeWrite(async () => {
      const valid = await validateInput(input);
      const fields = {
        upstreamStationId: valid.upstream.id,
        ownStationId: valid.own.id,
        tokenId: valid.token.id,
        tokenName: valid.token.name,
        fixedGroup: valid.token.group,
        initialRatio: valid.metadata.groups?.[valid.token.group]?.ratio ?? null,
        timezone: valid.timezone,
        enabled: input?.enabled !== false,
        channels: valid.channels,
        provider: valid.metadata.platform || (valid.upstream.type.startsWith("sub2api") ? "sub2api" : "newapi"),
        canonicalKey: valid.canonicalKey,
        billingPolicy: "next-complete-day",
        costCoverage: input?.costCoverage === "complete" ? "complete" : "unknown",
        sourceBinding: input?.sourceBinding || null,
        previewEffectiveFromMs: input?.previewEffectiveFromMs,
      };
      const sourceRule = valid.existingRule || fields;
      const capturedCredential = currentSourceCredential(sourceRule);
      const saved = await withObservationSourceLock(sourceRule, capturedCredential, async () => {
        if (sourceCredentialFingerprint(upstreamStation(valid.upstream.id), upstreamStation(valid.own.id)) !== valid.validationCredential) return STALE_SCOPE;
        assertSourceConfirmation(sourceRule, valid.channels, fields);
        if (valid.existingRule) {
          if (credentialFingerprint(upstreamStation(valid.existingRule.upstreamStationId) || {}) !== verifiedRuleCredentials.get(valid.existingRule)) return STALE_SCOPE;
          // 复用原授权资源和 Key 身份，不因为另一份同账号资源出现而新建成本规则。
          return repository.appendChannels(valid.existingRule.id, valid.channels, {
            costCoverage: fields.costCoverage, sourceBinding: fields.sourceBinding,
            previewEffectiveFromMs: fields.previewEffectiveFromMs,
            provider: fields.provider, canonicalKey: fields.canonicalKey,
          });
        }
        return repository.createRule(fields);
      });
      if (saved === STALE_SCOPE) throw new Error("关联来源已变化，请刷新后重新确认");
      clearBillingResults(saved.id);
      return saved;
    });
  }

  async function updateRule(id, input) {
    return serializeWrite(async () => {
      const existing = await repository.getRule(id);
      if (!existing) throw new Error("对账规则不存在");
      const requestedUpstreamStationId = String(input?.upstreamStationId || "");
      const requestedTokenId = finite(input?.tokenId);
      if (requestedUpstreamStationId !== String(existing.upstreamStationId) || requestedTokenId !== Number(existing.tokenId)) {
        const error = new Error("上游账号和 Key 是规则身份，不能编辑；请停止旧规则后新建规则");
        error.code = "RULE_IDENTITY_IMMUTABLE";
        throw error;
      }
      const capturedCredential = currentSourceCredential(existing);
      const valid = await validateMutableRuleInput(existing, input);
      const changedMembers = JSON.stringify(valid.channels.map((channel) => channel.channelId).sort((a, b) => a - b))
        !== JSON.stringify(existing.channels.map((channel) => channel.channelId).sort((a, b) => a - b));
      const updated = await withObservationSourceLock(existing, capturedCredential, () => {
        assertSourceConfirmation({ ...existing, channels: [] }, valid.channels, input);
        return repository.updateRule(id, {
        upstreamStationId: existing.upstreamStationId,
        ownStationId: existing.ownStationId,
        tokenId: existing.tokenId,
        tokenName: existing.tokenName,
        fixedGroup: existing.fixedGroup,
        timezone: valid.timezone,
        enabled: input?.enabled !== false,
        channels: valid.channels,
        costCoverage: input?.costCoverage ?? (changedMembers ? "unknown" : existing.costCoverage),
        sourceBinding: input?.sourceBinding ?? existing.sourceBinding,
        provider: existing.provider,
        canonicalKey: existing.canonicalKey,
        previewEffectiveFromMs: input?.previewEffectiveFromMs,
        });
      });
      if (updated === STALE_SCOPE) throw new Error("关联来源已变化，请刷新后重新确认");
      clearBillingResults(id);
      return updated;
    });
  }

  async function appendChannels(id, channelIds, confirmation = {}) {
    return serializeWrite(async () => {
      const existing = await repository.getRule(id);
      if (!existing) throw ruleNotFound();
      const configured = upstreamStation(existing.upstreamStationId);
      if (!billingStation(configured)) throw new Error("上游账号不存在");
      const sourceCredential = currentSourceCredential(existing);
      const metadata = await metadataFor({ ...configured }, { force: true });
      const token = metadata.tokens.find((item) => item.id === existing.tokenId);
      if (!token || token.status !== 1 || token.name !== existing.tokenName || !tokenNameIsUnique(metadata, token)
        || token.group === "auto" || token.crossGroupRetry) throw new Error("上游 Key 身份已变化，请重新核对");
      const canonicalKey = canonicalBillingKey(configured, metadata, token.id);
      if (!canonicalKey || (existing.canonicalKey && existing.canonicalKey !== canonicalKey)) throw new Error("上游稳定账号身份已变化，请重新核对");
      if ((await canonicalRules(canonicalKey, token.id, { excludeRuleId: id })).length) {
        throw Object.assign(new Error("多个规则对应同一实际 Key，请先核对"), { code: "CANONICAL_KEY_CONFLICT" });
      }
      const valid = await validateMutableRuleInput(existing, { salesChannelIds: channelIds, timezone: existing.timezone });
      const saved = await withObservationSourceLock(existing, sourceCredential, () => {
        assertSourceConfirmation(existing, valid.channels, confirmation);
        return repository.appendChannels(id, valid.channels, {
        costCoverage: confirmation.costCoverage ?? existing.costCoverage,
        sourceBinding: confirmation.sourceBinding ?? existing.sourceBinding,
        previewEffectiveFromMs: confirmation.previewEffectiveFromMs,
        canonicalKey,
        provider: metadata.platform || (configured.type.startsWith("sub2api") ? "sub2api" : "newapi"),
        });
      });
      if (saved === STALE_SCOPE) throw new Error("关联来源已变化，请刷新后重新确认");
      clearBillingResults(id);
      return saved;
    });
  }

  async function inspectRule(ruleId, window, { force = false, origin = "manual" } = {}) {
    if (!ruleGenerations.has(ruleId)) ruleGenerations.set(ruleId, 0);
    const firstRule = await repository.getRule(ruleId);
    if (!firstRule) throw ruleNotFound();
    const cacheKey = resultKey(firstRule, window);
    const requestCredential = currentSourceCredential(firstRule);
    const requestBilling = billingSourceState();
    const inflightKey = window.preset === "today" ? `${cacheKey}:${window.endMs}:${requestCredential}:${requestBilling.version}` : `${cacheKey}:${requestCredential}:${requestBilling.version}`;
    const ttl = window.preset === "today" ? TODAY_TTL_MS : QUERY_TTL_MS;
    const cached = resultCache.get(cacheKey);
    if (!force && cached?.sourceCredential === requestCredential && cached?.billingCredential === requestBilling.version && Date.now() - cached.at < ttl) return cached.value;
    if (inflight.has(inflightKey)) return inflight.get(inflightKey);

    const inspectScope = async (rule, generation, billingSource) => {
      const currentUpstream = upstreamStation(rule.upstreamStationId);
      const currentOwn = upstreamStation(rule.ownStationId);
      const upstream = currentUpstream && { ...currentUpstream };
      const own = currentOwn && { ...currentOwn };
      const sourceCredential = observationCredential(rule, upstream, own);
      const ownAvailable = !!own && own.isOwn && own.type === "newapi";
      const downstreamEvidence = async () => {
        if (!own || !own.isOwn || own.type !== "newapi") return null;
        const persistedSegments = await repository.listSegments(rule.id).catch(() => []);
        const applicable = rule.billingPolicy === "next-complete-day" && persistedSegments.length
          ? [{ segment: persistedSegments[persistedSegments.length - 1], window }]
          : persistedSegments
          .map((segment) => ({ segment, window: intersectSegment(window, segment) }))
          .filter((item) => item.window);
        if (!applicable.length) return null;
        try {
          const [catalogue, results] = await Promise.all([
            ownChannelsFor(own, { force }).catch(() => null),
            mapWithConcurrency(applicable, 6, ({ window: segmentWindow }) => queryOwnChannelRevenue(own, {
              channelIds: rule.channels.map((channel) => channel.channelId), startMs: segmentWindow.startMs, endMs: segmentWindow.endMs,
            }).catch(() => null)),
          ]);
          const channelById = new Map((catalogue || []).map((channel) => [Number(channel.id), channel]));
          const channelsFor = (result) => rule.channels.map((channel) => {
            const billed = result?.channels?.find((item) => item.channelId === channel.channelId);
            const observed = channelById.get(channel.channelId);
            return {
              ...channel,
              state: catalogue ? (observed ? channelState(observed.status) : "missing") : "unknown",
              stateObservedAt: Date.now(),
              billingState: billed?.billingState || "unavailable",
              quotaUnits: billed?.quotaUnits ?? null,
              amountUsd: billed?.amountUsd ?? null,
              knownAmountUsd: billed?.amountUsd ?? null,
            };
          });
          const downstreamFor = (result, segmentWindow) => result ? {
            ...result, observedAt: Date.now(), window: segmentWindow, channels: channelsFor(result),
          } : {
            state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null,
            successfulCount: 0, expectedCount: rule.channels.length,
            billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION,
            observedAt: Date.now(), window: segmentWindow, channels: channelsFor(null),
          };
          const channels = rule.channels.map((channel) => {
            const rows = results.map((result) => result?.channels?.find((item) => item.channelId === channel.channelId)).filter(Boolean);
            const complete = rows.length === applicable.length && rows.every((item) => item.billingState === "complete" && item.amountUsd != null);
            const known = rows.some((item) => item.amountUsd != null);
            const observed = channelById.get(channel.channelId);
            return {
              ...channel,
              state: catalogue ? (observed ? channelState(observed.status) : "missing") : "unknown",
              stateObservedAt: Date.now(),
              billingState: complete ? "complete" : known ? "partial" : "unavailable",
              quotaUnits: complete ? rows.reduce((sum, item) => sum + item.quotaUnits, 0) : null,
              amountUsd: complete ? rows.reduce((sum, item) => sum + item.amountUsd, 0) : null,
              knownAmountUsd: known ? rows.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : null,
            };
          });
          const successfulCount = results.reduce((sum, result) => sum + (result?.successfulCount ?? 0), 0);
          const expectedCount = applicable.length * rule.channels.length;
          const complete = results.length === applicable.length && results.every((result) => result?.state === "complete");
          const known = results.some((result) => result?.knownAmountUsd != null);
          return {
            state: complete ? "complete" : known ? "partial" : "unavailable",
            quotaUnits: complete ? results.reduce((sum, result) => sum + result.quotaUnits, 0) : null,
            quotaPerUnit: complete ? results[0]?.quotaPerUnit ?? null : null,
            amountUsd: complete ? results.reduce((sum, result) => sum + result.amountUsd, 0) : null,
            knownAmountUsd: known ? results.reduce((sum, result) => sum + (result?.knownAmountUsd ?? 0), 0) : null,
            successfulCount, expectedCount,
            billingSource: RECONCILIATION_BILLING_SOURCE,
            calculationVersion: RECONCILIATION_CALCULATION_VERSION,
            channels,
            segments: applicable.map(({ segment, window: segmentWindow }, index) => ({
              ...segment,
              window: segmentWindow,
              downstream: downstreamFor(results[index], segmentWindow),
            })),
          };
        } catch { return null; }
      };
      const unavailable = async (resultHealth, evidence = {}) => persistUnavailable(rule, window, resultHealth, origin, {
        ...evidence,
        downstream: evidence.downstream ?? await downstreamEvidence(),
      }, generation, sourceCredential, billingSource);
      if (!billingStation(upstream)) return unavailable(health("UPSTREAM_DATA_UNAVAILABLE", "上游账号已删除或不支持账单读取"));

      let metadata;
      try {
        metadata = await metadataFor(upstream, { force });
      } catch (err) {
        return unavailable(toErrorHealth(err));
      }
      const token = metadata.tokens.find((item) => item.id === rule.tokenId);
      if (!token || token.status !== 1) {
        return unavailable(health("KEY_INVALID_OR_DENIED", token ? "上游 Key 已停用" : "上游 Key 不存在或无权限读取"), { metadata, token });
      }
      if (token.name !== rule.tokenName) {
        return unavailable(health("KEY_INVALID_OR_DENIED", "上游 Key 名称已变化，无法确认统计归属"), { metadata, token });
      }
      if (!tokenNameIsUnique(metadata, token)) {
        return unavailable(health("KEY_INVALID_OR_DENIED", "上游 Key 名称不唯一，无法安全归属统计账单"), { metadata, token });
      }
      if (token.group === "auto" || token.crossGroupRetry) {
        return unavailable(health("KEY_INVALID_OR_DENIED", "上游 Key 不再是可核算的固定分组 Key"), { metadata, token });
      }
      const canonicalKey = canonicalBillingKey(upstream, metadata, token.id);
      if (rule.canonicalKey && canonicalKey !== rule.canonicalKey) {
        return unavailable(health("SOURCE_BINDING_UNCONFIRMED", "上游稳定账号身份已变化，需重新核对关联"), { metadata, token });
      }
      const persistedSegments = await repository.listSegments(rule.id);
      if (!persistedSegments.length) return unavailable(health("UPSTREAM_DATA_UNAVAILABLE", "对账规则缺少历史分段"), { metadata, token });
      const catalogueObserved = metadata.groupsAvailable && metadata.groups[token.group]?.ratio != null;
      const currentRatio = catalogueObserved ? metadata.groups[token.group].ratio : null;
      const ratioObservedAt = Date.now();
      const reconciliation = await withObservationSourceLock(rule, sourceCredential, () => repository.observeSource(rule.id, {
        groups: metadata.groupsAvailable ? metadata.groups : {},
        group: token.group,
        ratio: currentRatio,
        tokenName: token.name,
        detectedAt: ratioObservedAt,
      }), billingSource);
      if (reconciliation === STALE_SCOPE) return STALE_SCOPE;
      let segments = reconciliation.segments;
      let currentSegment = reconciliation.currentSegment;
      const issues = scopePolicyIssues(rule, window);
      const observedSource = sourceState(rule);
      if (observedSource.status !== "confirmed") issues.push({ code: "SOURCE_BINDING_UNCONFIRMED", scope: "source", detail: "渠道连接已变化或来源尚未核对，当前金额仅供参考", observedAt: Date.now() });
      const sameKeyRules = canonicalKey ? await canonicalRules(canonicalKey, token.id, { excludeRuleId: rule.id }) : [];
      const duplicateCostOwner = sameKeyRules.length ? [rule, ...sameKeyRules].map((item) => item.id).sort()[0] : rule.id;
      if (sameKeyRules.length) issues.push({ code: "CANONICAL_KEY_CONFLICT", scope: "rule", detail: "多个启用规则使用同一实际 Key，成本只列一次，请核对重复规则", observedAt: Date.now() });
      if (!ownAvailable) issues.push({ code: "OWN_BILLING_UNAVAILABLE", scope: "downstream", detail: "本站管理员 NewAPI 站点不可用", observedAt: Date.now() });
      if (!catalogueObserved && metadata.platform !== "sub2api") {
        issues.push({
          code: "GROUP_DATA_UNAVAILABLE", scope: "upstream", observedAt: Date.now(),
          detail: metadata.groupError || `当前上游分组目录未返回 ${token.group}`,
        });
      }
      if (reconciliation.transitioned) {
        issues.push({ code: "ROUTE_TRANSITION_DETECTED", scope: "rule", detail: "已按首次检测时间切换分段", observedAt: Date.now() });
      }
      const unconfirmedSegments = segments.filter((segment) => segment.timingSource === "detected");
      if (unconfirmedSegments.length) {
        issues.push({
          code: "SEGMENT_TIMING_UNCONFIRMED",
          scope: "segment",
          detail: `有 ${unconfirmedSegments.length} 个分段仍暂按检测时间生效，可在详情中修正实际切换时间`,
          observedAt: Date.now(),
        });
      }
      // today / 近 7 天结束于当前时刻：刚建规则、刚切段或刚过零点时，最新一段还不满一个完整秒，秒级统计无法无重叠地核算。
      // 这段尾巴会随时间变长，本轮整条规则待获取，不能只核算旧分段却把整窗标为已确认；切段通知若因此没发出，下一轮会以分段切换时间待确认补报。
      // 窗口与规则任何分段都不相交（如查规则创建之前的时段）时照常核算为 0，不算待获取：那种情况不会随时间自行恢复。
      const intersecting = segments
        .map((segment) => ({ segment, segmentWindow: intersectSegment(window, segment) }))
        .filter(({ segmentWindow }) => segmentWindow);
      // 新政策查询完整请求窗口；生效前/跨界金额仍是参考，不把裁切窗口冒充整窗。
      const applicable = rule.billingPolicy === "next-complete-day" ? [{ segment: currentSegment, segmentWindow: window }] : intersecting;
      let catalogue = null;
      try { if (ownAvailable) catalogue = await ownChannelsFor(own, { force }); } catch {
        issues.push({ code: "SALES_CHANNEL_STATE_UNKNOWN", scope: "channels", detail: "本站渠道目录读取失败，渠道状态未知", observedAt: Date.now() });
      }
      const channelById = new Map((catalogue || []).map((channel) => [Number(channel.id), channel]));
      const states = rule.channels.map((channel) => {
        const found = channelById.get(channel.channelId);
        const state = catalogue ? (found ? channelState(found.status) : "missing") : "unknown";
        return { ...channel, state, stateObservedAt: Date.now() };
      });
      let channelStatesUpdated;
      try {
        channelStatesUpdated = await withObservationSourceLock(rule, sourceCredential,
          () => repository.updateChannelStates(rule.id, states), billingSource);
      } catch { channelStatesUpdated = null; }
      if (channelStatesUpdated === STALE_SCOPE) return STALE_SCOPE;
      for (const channel of states) {
        if (channel.state === "manual_disabled" || channel.state === "auto_disabled") issues.push({ code: "SALES_CHANNEL_DISABLED", scope: "channel", channelId: channel.channelId, detail: `${channel.name} ${channel.state === "manual_disabled" ? "已手动禁用" : "已自动禁用"}`, observedAt: Date.now() });
        if (channel.state === "missing") issues.push({ code: "SALES_CHANNEL_MISSING", scope: "channel", channelId: channel.channelId, detail: `${channel.name} 已不在本站渠道目录中`, observedAt: Date.now() });
      }
      // 各分段共用本轮的一次本站 /api/status 读取；读取失败时每个分段照常按本站账单不可用处理。
      let ownStatus = null;
      const loadOwnStatus = () => (ownStatus ||= queryNewApiStatus(own));
      const segmentResults = await mapWithConcurrency(applicable, 6, async ({ segment, segmentWindow }) => {
        const [upstreamResult, downstreamResult] = await Promise.all([
          upstreamWindowFor(upstream, metadata, token, segmentWindow).catch((error) => ({ error })),
          (ownAvailable
            ? queryOwnChannelRevenue(own, { channelIds: rule.channels.map((channel) => channel.channelId), startMs: segmentWindow.startMs, endMs: segmentWindow.endMs, loadStatus: loadOwnStatus })
            : Promise.resolve({ error: Object.assign(new Error("本站管理员 NewAPI 站点不可用"), { code: "OWN_BILLING_UNAVAILABLE" }) }))
            .catch((error) => ({ error })),
        ]);
        const segmentIssues = issues.filter((issue) => CALCULATION_BLOCKERS.has(issue.code));
        if (upstreamResult.error) segmentIssues.push({ code: toErrorHealth(upstreamResult.error).code, scope: "segment", detail: toErrorHealth(upstreamResult.error).detail, observedAt: Date.now() });
        if (upstreamResult.emptySecondWindow || downstreamResult.emptySecondWindow) segmentIssues.push({ code: "PENDING", scope: "segment", detail: "分段短于统计秒粒度，稍后刷新即可核算", observedAt: Date.now() });
        if (downstreamResult.error || (downstreamResult.state !== "complete" && downstreamResult.state !== "pending")) {
          segmentIssues.push({ code: "OWN_BILLING_UNAVAILABLE", scope: "segment", detail: "本站渠道账单未完整获取", observedAt: Date.now() });
        }
        const upstreamUnavailable = upstreamResult.error || upstreamResult.emptySecondWindow || upstreamResult.state !== "complete";
        const downstreamUnavailable = downstreamResult.error || downstreamResult.emptySecondWindow || downstreamResult.state !== "complete";
        const upstreamUsd = upstreamUnavailable ? null : upstreamResult.amountUsd;
        if (!upstreamResult.error && upstreamResult.state !== "complete" && !upstreamResult.emptySecondWindow) {
          segmentIssues.push({ code: "UPSTREAM_CAPABILITY_UNVERIFIED", scope: "upstream", detail: "上游尚不能证明当前 Key 的完整账单范围，已有金额作为参考", observedAt: Date.now() });
        }
        const downstreamUsd = downstreamUnavailable ? null : downstreamResult.quotaUnits / downstreamResult.quotaPerUnit;
        if (!upstreamUnavailable && !downstreamUnavailable && upstreamUsd <= 0 && downstreamUsd > 0) segmentIssues.push({ code: "UPSTREAM_EMPTY_WITH_SALES", scope: "segment", detail: "本站渠道已有收费，但上游未返回对应窗口消费", observedAt: Date.now() });
        const segmentHealth = healthWithIssues(segmentIssues);
        return {
          ...segment,
          window: segmentWindow,
          upstream: upstreamUnavailable ? {
            state: upstreamResult.emptySecondWindow ? "pending" : upstreamResult.state || "unavailable",
            quotaUnits: upstreamResult.quotaUnits ?? null, quotaPerUnit: upstreamResult.quotaPerUnit ?? null, amountUsd: null, knownAmountUsd: upstreamResult.knownAmountUsd ?? null,
            successfulCount: upstreamResult.knownAmountUsd != null ? 1 : 0, expectedCount: 1, observedAt: Date.now(), window: segmentWindow,
          } : {
            state: "complete", quotaUnits: upstreamResult.quotaUnits, quotaPerUnit: upstreamResult.quotaPerUnit,
            amountUsd: upstreamUsd, knownAmountUsd: upstreamUsd, successfulCount: 1, expectedCount: 1,
            observedAt: upstreamResult.latestLogAtMs || Date.now(), window: segmentWindow,
          },
          downstream: downstreamResult.error ? {
            state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null,
            successfulCount: 0, expectedCount: rule.channels.length,
            billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION,
            observedAt: Date.now(), window: segmentWindow,
            channels: rule.channels.map((channel) => ({ ...channel, billingState: "unavailable", quotaUnits: null, amountUsd: null, knownAmountUsd: null })),
          } : {
            quotaUnits: downstreamResult.quotaUnits,
            quotaPerUnit: downstreamResult.quotaPerUnit,
            amountUsd: downstreamUnavailable ? null : downstreamUsd,
            knownAmountUsd: downstreamResult.knownAmountUsd,
            state: downstreamResult.state,
            successfulCount: downstreamResult.successfulCount,
            expectedCount: downstreamResult.expectedCount,
            billingSource: downstreamResult.billingSource,
            calculationVersion: downstreamResult.calculationVersion,
            observedAt: Date.now(), window: segmentWindow,
            channels: downstreamResult.channels,
          },
          calculation: calculationFromAmounts(upstreamUsd, downstreamUsd, segmentIssues),
          health: segmentHealth,
        };
      });
      for (const segment of segmentResults) issues.push(...segment.health.issues);
      if (duplicateCostOwner !== rule.id) {
        for (const segment of segmentResults) {
          segment.upstream.duplicateCostReferenceUsd = segment.upstream.knownAmountUsd;
          segment.upstream.amountUsd = null;
          segment.upstream.knownAmountUsd = null;
          segment.upstream.state = "unavailable";
          segment.upstream.duplicateOfRuleId = duplicateCostOwner;
          segment.calculation = calculationFromAmounts(null, segment.downstream.amountUsd, issues);
        }
      }
      const completeUpstream = segmentResults.every((segment) => segment.upstream.state === "complete");
      const completeDownstream = segmentResults.every((segment) => segment.downstream.state === "complete");
      const upstreamUsd = completeUpstream ? segmentResults.reduce((sum, segment) => sum + segment.upstream.amountUsd, 0) : null;
      const downstreamUsd = completeDownstream ? segmentResults.reduce((sum, segment) => sum + segment.downstream.amountUsd, 0) : null;
      const upstreamUnits = completeUpstream ? segmentResults.reduce((sum, segment) => sum + segment.upstream.quotaUnits, 0) : null;
      const downstreamUnits = completeDownstream ? segmentResults.reduce((sum, segment) => sum + segment.downstream.quotaUnits, 0) : null;
      const successfulUpstream = segmentResults.filter((segment) => segment.upstream.state === "complete");
      const knownUpstreamUsd = segmentResults.some((segment) => segment.upstream.knownAmountUsd != null)
        ? segmentResults.reduce((sum, segment) => sum + (segment.upstream.knownAmountUsd ?? 0), 0) : null;
      const allChannels = states.map((channel) => {
        const billingRows = segmentResults.map((segment) => segment.downstream.channels?.find((item) => item.channelId === channel.channelId)).filter(Boolean);
        const complete = billingRows.length === segmentResults.length && billingRows.every((item) => item.billingState === "complete" && item.amountUsd != null);
        const quotaUnits = billingRows.reduce((sum, item) => sum + (item.quotaUnits ?? 0), 0);
        return {
          ...channel,
          billingState: complete ? "complete" : billingRows.some((item) => item.billingState === "complete") ? "partial" : "unavailable",
          quotaUnits: complete ? quotaUnits : null,
          amountUsd: complete ? billingRows.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : null,
          knownAmountUsd: complete ? billingRows.reduce((sum, item) => sum + item.amountUsd, 0) : billingRows.some((item) => item.amountUsd != null)
            ? billingRows.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : null,
          share: completeDownstream && complete ? (downstreamUnits > 0 ? quotaUnits / downstreamUnits : 0) : null,
        };
      });
      const resultHealth = healthWithIssues(issues);
      const result = {
        rule: { ...rule, tokenName: token.name, fixedGroup: currentSegment.group }, window,
        requestedWindow: window,
        lastSuccessfulWindow: null,
        currentSegment,
        segments: segmentResults,
        transitionSegments: segments,
        upstream: {
          state: completeUpstream ? "complete" : knownUpstreamUsd != null ? "partial" : segmentResults.some((segment) => segment.upstream.state === "pending") ? "pending" : "unavailable",
          duplicateOfRuleId: duplicateCostOwner === rule.id ? null : duplicateCostOwner,
          quotaUnits: upstreamUnits,
          quotaPerUnit: segmentResults[0]?.upstream?.quotaPerUnit ?? null,
          amountUsd: upstreamUsd,
          knownAmountUsd: knownUpstreamUsd,
          successfulCount: successfulUpstream.length,
          expectedCount: segmentResults.length,
          observedAt: Date.now(), window, status: token.status, group: currentSegment.group, ratio: currentRatio,
        },
        downstream: {
          state: completeDownstream ? "complete" : segmentResults.some((segment) => segment.downstream.knownAmountUsd != null) ? "partial" : segmentResults.some((segment) => segment.downstream.state === "pending") ? "pending" : "unavailable",
          quotaUnits: downstreamUnits,
          quotaPerUnit: segmentResults[0]?.downstream?.quotaPerUnit ?? null,
          amountUsd: downstreamUsd,
          knownAmountUsd: completeDownstream ? downstreamUsd : segmentResults.reduce((sum, segment) => sum + (segment.downstream.knownAmountUsd ?? 0), 0) || (segmentResults.some((segment) => segment.downstream.knownAmountUsd != null) ? 0 : null),
          successfulCount: segmentResults.reduce((sum, segment) => sum + segment.downstream.successfulCount, 0),
          expectedCount: segmentResults.reduce((sum, segment) => sum + segment.downstream.expectedCount, 0),
          billingSource: RECONCILIATION_BILLING_SOURCE,
          calculationVersion: RECONCILIATION_CALCULATION_VERSION,
          observedAt: Date.now(), window,
          channels: allChannels,
        },
        calculation: calculationFromAmounts(upstreamUsd, downstreamUsd, issues),
        health: resultHealth, generatedAt: new Date().toISOString(),
      };
      const scopeFingerprint = reconciliationScopeFingerprint(rule, segments);
      if (!await hasCurrentScope(rule.id, scopeFingerprint, generation)) return STALE_SCOPE;
      if (currentSourceCredential(rule) !== sourceCredential) return STALE_SCOPE;
      const billingFingerprint = sourceScopeFingerprint(scopeFingerprint, sourceCredential);
      if (result.calculation.profitUsd != null) {
        result.lastSuccessfulAt = result.generatedAt;
        result.lastSuccessfulWindow = window;
      }
      let previous;
      try { previous = await repository.latestSuccessfulResult(rule.id, window, billingFingerprint); } catch {}
      if (previous) {
        result.lastConfirmed = snapshotReference(previous);
      }
      return (await persistResult(rule, result, origin, metadata, token, {
        scopeFingerprint, billingFingerprint, sourceCredential, generation, billingSource,
      })) ? result : STALE_SCOPE;
    };
    // 口径在查询期间变化时，在共享的 in-flight 任务内重跑，加入等待的调用方也只会拿到最新口径的结果。
    // 编辑会注销本任务的 in-flight 登记：期间已有调用方按新口径另起任务时直接等它，不再重复取数和写快照；
    // 否则重新登记，让重跑期间到达的调用方加入本任务。
    let task;
    const run = async () => {
      let rule = firstRule;
      for (let attempt = 1; ; attempt += 1) {
        const generation = ruleGenerations.get(ruleId) || 0;
        const sourceCredential = currentSourceCredential(rule);
        const billingSource = billingSourceState();
        const value = await inspectScope(rule, generation, billingSource).catch((error) => {
          if (billingSourceState().version !== billingSource.version) return STALE_SCOPE;
          throw error;
        });
        if (value !== STALE_SCOPE && (ruleGenerations.get(ruleId) || 0) === generation
          && currentSourceCredential(rule) === sourceCredential && billingSourceState().version === billingSource.version) {
          if (value.health.code !== "PENDING") cacheResult(cacheKey, value, sourceCredential, billingSource.version);
          return value;
        }
        const newer = inflight.get(inflightKey);
        if (newer && newer !== task) return newer;
        // 口径被连续改动时不再重跑：只让这条规则本轮待获取，不能让整个多规则查询失败。
        if (attempt >= MAX_SCOPE_ATTEMPTS) return pendingResult(rule, window, "查询期间对账口径多次变化，下一轮刷新时重新获取");
        inflight.set(inflightKey, task);
        rule = await repository.getRule(ruleId);
        if (!rule) throw ruleNotFound();
      }
    };
    task = run();
    inflight.set(inflightKey, task);
    try { return await task; } finally {
      if (inflight.get(inflightKey) === task) inflight.delete(inflightKey);
    }
  }

  async function persistUnavailable(rule, window, resultHealth, origin, evidence = {}, generation = 0, sourceCredential = currentSourceCredential(rule), billingSource = null) {
    const persistedSegments = await repository.listSegments(rule.id).catch(() => []);
    const currentSegment = persistedSegments[persistedSegments.length - 1] || null;
    const scopeFingerprint = reconciliationScopeFingerprint(rule, persistedSegments);
    const currentRule = await repository.getRule(rule.id).catch(() => null);
    if (!currentRule || reconciliationScopeFingerprint(currentRule, persistedSegments) !== scopeFingerprint || (ruleGenerations.get(rule.id) || 0) !== generation) return STALE_SCOPE;
    if (currentSourceCredential(rule) !== sourceCredential) return STALE_SCOPE;
    const billingFingerprint = sourceScopeFingerprint(scopeFingerprint, sourceCredential);
      const unavailable = {
      rule,
      window,
      requestedWindow: window,
      lastSuccessfulWindow: null,
      currentSegment,
      transitionSegments: persistedSegments,
      upstream: evidence.upstream ? {
        state: "complete",
        quotaUnits: evidence.upstream.quotaUnits,
        quotaPerUnit: evidence.upstream.quotaPerUnit,
        amountUsd: evidence.upstream.quotaUnits / evidence.upstream.quotaPerUnit,
        observedAt: evidence.upstream.latestLogAtMs || Date.now(),
        status: evidence.token?.status ?? null,
        group: evidence.token?.group ?? null,
        ratio: evidence.metadata?.groups?.[evidence.token?.group]?.ratio ?? null,
      } : { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: 1, observedAt: Date.now(), window },
      downstream: evidence.downstream ? {
        state: evidence.downstream.state || "unavailable",
        quotaUnits: evidence.downstream.quotaUnits,
        quotaPerUnit: evidence.downstream.quotaPerUnit,
        amountUsd: evidence.downstream.state === "complete" && Number.isFinite(evidence.downstream.quotaUnits) && Number.isFinite(evidence.downstream.quotaPerUnit) && evidence.downstream.quotaPerUnit > 0
          ? evidence.downstream.quotaUnits / evidence.downstream.quotaPerUnit : null,
        knownAmountUsd: evidence.downstream.knownAmountUsd ?? null,
        successfulCount: evidence.downstream.successfulCount ?? 0,
        expectedCount: evidence.downstream.expectedCount ?? rule.channels.length,
        billingSource: evidence.downstream.billingSource || RECONCILIATION_BILLING_SOURCE,
        calculationVersion: evidence.downstream.calculationVersion || RECONCILIATION_CALCULATION_VERSION,
        observedAt: Date.now(), window,
        channels: evidence.downstream.channels || [],
      } : { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: rule.channels.length, observedAt: Date.now(), window, channels: rule.channels.map((channel) => ({ ...channel, billingState: "unavailable", quotaUnits: null, amountUsd: null, knownAmountUsd: null })) },
      calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
      health: resultHealth,
      generatedAt: new Date().toISOString(),
    };
    unavailable.segments = (evidence.downstream?.segments || []).map((segment) => ({
      ...segment,
      upstream: {
        state: resultHealth.code === "PENDING" ? "pending" : "unavailable",
        quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null,
        successfulCount: 0, expectedCount: 1, observedAt: Date.now(), window: segment.window,
      },
      downstream: segment.downstream,
      calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
      health: resultHealth,
    }));
    let previous;
    try { previous = await repository.latestSuccessfulResult(rule.id, window, billingFingerprint); } catch {}
    if (previous) {
      unavailable.lastConfirmed = snapshotReference(previous);
    }
    return (await persistResult(rule, unavailable, origin, evidence.metadata, evidence.token, { scopeFingerprint, billingFingerprint, sourceCredential, generation, billingSource })) ? unavailable : STALE_SCOPE;
  }

  async function persistResult(rule, result, origin, metadata = null, token = null, { saveSnapshots = true, scopeFingerprint = null, billingFingerprint = null, sourceCredential = null, generation = 0, billingSource = null } = {}) {
    const segmentSnapshots = result.segments?.length ? result.segments : [{ id: result.currentSegment?.id || null, window: result.window, upstream: result.upstream, downstream: result.downstream, calculation: result.calculation, health: result.health }];
    const snapshots = ["observation", ...(result.calculation?.profitUsd != null ? ["confirmed"] : [])]
      .flatMap((recordType) => segmentSnapshots.map((segment) => ({ ...segment, recordType })));
    // 数据库事务核验规则/分段口径；快照键和失败兜底另用包含两侧站点来源的口径。
    const save = () => repository.saveSnapshotsForScope(rule.id, scopeFingerprint, snapshots.map((segment) => {
      const source = metadata && token ? sourceSnapshot(token, metadata, segment.upstream, segment.downstream) : {
        calculationVersion: RECONCILIATION_CALCULATION_VERSION,
        billingSource: RECONCILIATION_BILLING_SOURCE,
        upstream: segment.upstream ? { group: segment.upstream.group, ratio: segment.upstream.ratio, status: segment.upstream.status } : null,
        downstream: {
          calculationVersion: RECONCILIATION_CALCULATION_VERSION,
          billingSource: RECONCILIATION_BILLING_SOURCE,
          billingCoverage: segment.downstream?.billingCoverage ?? segment.downstream?.coverage ?? null,
          coverage: segment.downstream?.coverage ?? null,
          channels: segment.downstream?.channels?.map((channel) => ({
            channelId: channel.channelId,
            quotaUnits: channel.quotaUnits,
            amountUsd: channel.amountUsd,
          })) || [],
        },
      };
      return {
        ruleId: rule.id,
        segmentId: segment.id,
        snapshotKey: reconciliationSnapshotRecordIdentity(result.window, billingFingerprint, segment.recordType, segment.id),
        windowKind: result.window.preset,
        startMs: segment.window.startMs,
        endMs: segment.window.endMs,
        localDate: result.window.preset === "today" ? localDate(result.window.startMs, result.window.timezone) : null,
        upstreamQuota: segment.upstream?.quotaUnits ?? null,
        upstreamQuotaPerUnit: segment.upstream?.quotaPerUnit ?? null,
        upstreamUsd: segment.upstream?.amountUsd ?? null,
        downstreamQuota: segment.downstream?.quotaUnits ?? null,
        downstreamQuotaPerUnit: segment.downstream?.quotaPerUnit ?? null,
        downstreamUsd: segment.downstream?.amountUsd ?? null,
        differenceUsd: segment.calculation?.differenceUsd ?? null,
        marginRate: segment.calculation?.marginRate ?? null,
        coverage: segment.downstream?.coverage ?? null,
        healthCode: segment.health?.code || result.health.code,
        healthDetail: segment.health?.detail || result.health.detail || null,
        source: {
          ...source,
          scopePolicy: { billingPolicy: rule.billingPolicy, scopeVersion: rule.scopeVersion, billingEffectiveFrom: rule.billingEffectiveFrom,
            costCoverage: rule.costCoverage, sourceBinding: rule.sourceBinding, sourceState: sourceState(rule) },
          recordType: segment.recordType,
          scopeFingerprint: billingFingerprint,
          segment: (() => {
            const evidence = segment.group != null ? segment : result.currentSegment;
            return evidence ? {
              group: evidence.group,
              ratio: evidence.ratio,
              ratioObservedAt: evidence.ratioObservedAt ?? null,
              ratioSource: evidence.ratioSource ?? null,
              timingSource: evidence.timingSource,
            } : null;
          })(),
          origin,
          window: result.window,
          resultGeneratedAt: result.generatedAt,
          result: {
            window: result.window,
            requestedWindow: result.requestedWindow,
            lastSuccessfulWindow: result.lastSuccessfulWindow,
            currentSegment: result.currentSegment,
            transitionSegments: result.transitionSegments,
            segments: result.segments,
            upstream: result.upstream,
            downstream: result.downstream,
            calculation: result.calculation,
            health: result.health,
            generatedAt: result.generatedAt,
          },
        },
      };
    }));
    // 调用方已核对过口径；写快照的事务会在规则行锁内再按库里的口径核对一次，这里只需挡住已作废的代次。
    if (currentSourceCredential(rule) !== sourceCredential) return false;
    if (saveSnapshots) {
      let saved;
      try {
        saved = await withObservationSourceLock(rule, sourceCredential, async () => {
          if ((ruleGenerations.get(rule.id) || 0) !== generation) return false;
          return save();
        }, billingSource);
      } catch {
        const error = new Error("对账结果未能保存");
        error.code = "PERSISTENCE_FAILED";
        throw error;
      }
      if (saved !== true) return false;
    }
    if (!await hasCurrentScope(rule.id, scopeFingerprint, generation)) return false;
    if (currentSourceCredential(rule) !== sourceCredential) return false;
    if (result.health.code !== "PENDING") {
      try { await notifyReconciliationHealth(rt, repository, rule, result); } catch (err) {
        console.error("渠道对账通知失败:", err?.message || String(err));
      }
    }
    return true;
  }

  return {
    async getConfiguration({ forceChannels = false } = {}) {
      const own = ownStation();
      const rules = await repository.listRules();
      const upstreams = rt.store.list({ includeUnmonitored: true }).filter((station) => billingStation(station) && !station.archivedAt).map(publicStation);
      let channels = [];
      let channelsError = null;
      if (own) {
        try { channels = await ownChannelsFor(own, { force: forceChannels }); } catch (err) {
          // 上游错误原文可能回显令牌：接口只返回固定提示，服务端日志只记脱敏后的原因。
          console.error("本站渠道目录读取失败:", describeConnectionFailure(err?.message || String(err), own).diagnostic);
          channelsError = "本站渠道目录读取失败，请检查管理员权限或稍后重试";
        }
      }
      return { ownStation: publicStation(own), upstreams, channels, channelsError, rules };
    },

    async getUpstreamKeys(stationId, { force = false } = {}) {
      const station = upstreamStation(stationId);
      if (!billingStation(station)) throw new Error("上游站点不存在");
      return publicMetadata(await metadataFor(station, { force }));
    },

    createRule: saveRule,
    updateRule,
    appendChannels,
    listRules: () => repository.listRules(),
    nextBillingEffectiveFrom,
    async findRuleForKey(stationId, tokenId) {
      const station = upstreamStation(stationId);
      if (!billingStation(station)) throw new Error("上游账号不存在");
      const metadata = await metadataFor(station);
      const key = canonicalBillingKey(station, metadata, tokenId);
      if (!key) throw new Error("无法验证上游稳定账号身份");
      const matches = await canonicalRules(key, Number(tokenId));
      if (matches.length > 1) throw Object.assign(new Error("多个启用规则对应同一实际 Key，请核对"), { code: "CANONICAL_KEY_CONFLICT" });
      return matches[0] || null;
    },
    async archiveRule(id) {
      const rule = await repository.getRule(id);
      if (!rule) throw new Error("对账规则不存在或已停止");
      const ok = await repository.archiveRule(id);
      if (!ok) throw new Error("对账规则不存在或已停止");
      clearBillingResults(id);
      return {
        ruleId: rule.id,
        tokenName: rule.tokenName,
        fixedGroup: rule.fixedGroup,
        releasedChannelCount: rule.channels.length,
      };
    },
    async listSegments(id) {
      const rule = await repository.getRule(id, { includeArchived: true });
      if (!rule) throw new Error("对账规则不存在");
      return repository.listSegments(id);
    },
    async correctTransition(ruleId, segmentId, effectiveAt) {
      const rule = await repository.getRule(ruleId, { includeArchived: true });
      if (!rule) throw new Error("对账规则不存在");
      const segments = await repository.correctTransition(ruleId, segmentId, effectiveAt);
      clearRuleResults(ruleId);
      return segments;
    },
    async queryRules({ ruleIds = null, ...input } = {}, options = {}) {
      for (let attempt = 1; ; attempt += 1) {
        const billingSource = billingSourceState();
        const rules = await repository.listRules();
        const selected = (Array.isArray(ruleIds) && ruleIds.length)
          ? rules.filter((rule) => ruleIds.includes(rule.id))
          : rules.filter((rule) => rule.enabled);
        const now = Date.now();
        const results = await mapWithConcurrency(selected, MAX_CONCURRENT_RULES, (rule) => inspectRule(
          rule.id,
          resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now),
          attempt === 1 ? options : { ...options, force: false }
        ).catch((err) => {
          // 列出规则后才被停止的规则从本轮结果中去掉，不能让整个多规则查询失败。
          if (err?.code === "RULE_NOT_FOUND") return null;
          if (err?.code === "PERSISTENCE_FAILED") return persistenceFailedResult(rule, resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now));
          throw err;
        }));
        if (billingSourceState().version === billingSource.version) return { results: results.filter(Boolean), generatedAt: new Date(now).toISOString() };
        if (attempt >= MAX_SCOPE_ATTEMPTS) return { results: selected.map((rule) => pendingResult(rule,
          resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now), "查询期间成本来源多次变化，下一轮刷新时重新获取")),
          generatedAt: new Date(now).toISOString() };
      }
    },
    async refreshDue(now = Date.now()) {
      const rules = (await repository.listRules()).filter((rule) => rule.enabled);
      await mapWithConcurrency(rules, MAX_CONCURRENT_RULES, (rule) => inspectRule(
        rule.id,
        resolveReconciliationWindow({ preset: "today", timezone: rule.timezone }, now),
        { origin: "poll" }
      ).catch(() => null));
    },
  };
}

export function startReconciliationPolling(rt) {
  const module = (rt.reconciliation ||= createReconciliationModule(rt));
  const sec = Math.max(60, Number(rt.store.settings.refreshIntervalSec) || 60);
  if (rt._reconciliationPollTimer && rt._reconciliationPollSec === sec) return module;
  if (rt._reconciliationPollTimer) clearInterval(rt._reconciliationPollTimer);
  rt._reconciliationPollSec = sec;
  rt._reconciliationPollTimer = setInterval(() => module.refreshDue().catch(() => {}), sec * 1000);
  if (rt._reconciliationPollTimer.unref) rt._reconciliationPollTimer.unref();
  module.refreshDue().catch(() => {});
  return module;
}
