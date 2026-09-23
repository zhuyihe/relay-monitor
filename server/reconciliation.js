// 对账深模块：把窗口、上游取数、本站收费、快照和告警收敛在一个 Interface 后。
import {
  queryNewApiReconciliationMetadata,
  queryNewApiTokenStat,
  queryOwnChannelRevenue,
  queryOwnChannels,
} from "../lib/providers.js";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_CALCULATION_VERSION,
  reconciliationHealthMeta,
} from "../lib/reconciliation-contract.js";
import { ReconciliationRepository } from "./reconciliation-repository.js";
import { notifyReconciliationHealth } from "./reconciliation-notify.js";

const DAY_MS = 86400000;
const TODAY_WINDOW_END_OFFSET_MS = 60 * 60 * 1000;
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
      endMs = now + TODAY_WINDOW_END_OFFSET_MS;
    }
  }
  if (endMs - startMs > 31 * DAY_MS) throw new Error("单次查询时间范围不能超过 31 天");
  return { preset, timezone, startMs: Math.floor(startMs), endMs: Math.floor(endMs) };
}

function publicStation(station) {
  return station ? { id: station.id, name: station.name, type: station.type, cnyPerUsd: station.cnyPerUsd ?? null } : null;
}

function publicMetadata(metadata) {
  return {
    quotaPerUnit: metadata.quotaPerUnit,
    version: metadata.version,
    groups: metadata.groups,
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
  const priority = ["KEY_INVALID_OR_DENIED", "UPSTREAM_DATA_UNAVAILABLE", "OWN_BILLING_UNAVAILABLE", "OWN_FLOW_INCOMPLETE", "UPSTREAM_EMPTY_WITH_SALES", "SALES_CHANNEL_MISSING", "SALES_CHANNEL_DISABLED", "SALES_CHANNEL_STATE_UNKNOWN", "ROUTE_TRANSITION_DETECTED", "SEGMENT_TIMING_UNCONFIRMED"];
  const first = priority.find((code) => issues.some((issue) => issue.code === code));
  const base = first ? health(first, issues.find((issue) => issue.code === first)?.detail || "") : health("READY");
  return { ...base, issues };
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

function snapshotKey(window) {
  return window.preset === "today"
    ? `today:${localDate(window.startMs, window.timezone)}`
    : `${window.preset}:${window.startMs}:${window.endMs}`;
}

function sourceSnapshot(token, metadata, upstream, downstream) {
  return {
    calculationVersion: RECONCILIATION_CALCULATION_VERSION,
    billingSource: RECONCILIATION_BILLING_SOURCE,
    upstream: {
      tokenId: token.id,
      tokenName: token.name,
      group: token.group,
      ratio: metadata.groups[token.group]?.ratio ?? null,
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
  const lastSuccessfulResults = (rt._reconciliationLastSuccessfulResults ||= new Map());

  const resultKey = (rule, window) => window.preset === "today"
    ? `${rule.id}:today:${window.startMs}:${window.timezone}`
    : `${rule.id}:${window.preset}:${window.startMs}:${window.endMs}:${window.timezone}`;

  function clearRuleResults(ruleId) {
    const prefix = `${ruleId}:`;
    for (const key of resultCache.keys()) {
      if (key.startsWith(prefix)) resultCache.delete(key);
    }
  }

  const ownStation = () => rt.store.list().find((station) => station.isOwn && station.type === "newapi") || null;
  const upstreamStation = (id) => rt.store.get(id) || null;

  async function metadataFor(station, { force = false } = {}) {
    const cached = metadataCache.get(station.id);
    if (!force && cached && Date.now() - cached.at < 5 * 60000) return cached.value;
    const value = await queryNewApiReconciliationMetadata(station);
    metadataCache.set(station.id, { at: Date.now(), value });
    return value;
  }

  async function ownChannelsFor(station, { force = false } = {}) {
    const cached = ownChannelsCache.get(station.id);
    if (!force && cached && Date.now() - cached.at < 10 * 60000) return cached.value;
    const value = await queryOwnChannels(station);
    ownChannelsCache.set(station.id, { at: Date.now(), value });
    return value;
  }

  async function upstreamWindowFor(upstream, token, window) {
    return queryNewApiTokenStat(upstream, {
      tokenName: token.name,
      startMs: window.startMs,
      endMs: window.endMs,
    });
  }

  function tokenNameIsUnique(metadata, token) {
    return metadata.tokens.filter((item) => item.name === token.name).length === 1;
  }

  async function validateInput(input, { excludeRuleId = null } = {}) {
    const upstream = upstreamStation(String(input?.upstreamStationId || ""));
    if (!upstream || upstream.type !== "newapi" || upstream.isOwn) throw new Error("请选择已配置的 NewAPI 上游站点");
    const own = ownStation();
    if (!own) throw new Error("还没有标记「我的中转站」的 NewAPI 管理员站点");
    const tokenId = finite(input?.tokenId);
    if (tokenId == null || tokenId <= 0) throw new Error("上游 Key 无效");
    const channelIds = [...new Set((Array.isArray(input?.salesChannelIds) ? input.salesChannelIds : [])
      .map(Number).filter((id) => Number.isFinite(id) && id > 0))];
    if (!channelIds.length) throw new Error("至少选择一个本站销售渠道");
    const timezone = validateTimezone(input?.timezone);
    const [metadata, channels, conflicts, tokenConflict] = await Promise.all([
      metadataFor(upstream, { force: true }),
      ownChannelsFor(own, { force: true }),
      repository.findChannelConflicts(channelIds, { excludeRuleId }),
      repository.findTokenConflict(upstream.id, tokenId, { excludeRuleId }),
    ]);
    if (conflicts.length) {
      const names = [...new Set(conflicts.map((item) => item.tokenName || item.ruleId))].join("、");
      const error = new Error(`所选渠道已归属启用规则：${names}`);
      error.code = "CHANNEL_CONFLICT";
      error.conflicts = conflicts;
      throw error;
    }
    if (tokenConflict) {
      const error = new Error(`该上游 Key 已归属规则：${tokenConflict.tokenName || tokenConflict.ruleId}`);
      error.code = "TOKEN_CONFLICT";
      error.conflict = tokenConflict;
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
    if (!token.group || token.group === "auto" || token.crossGroupRetry) {
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
    const valid = await validateInput(input);
    return repository.createRule({
      upstreamStationId: valid.upstream.id,
      ownStationId: valid.own.id,
      tokenId: valid.token.id,
      tokenName: valid.token.name,
      fixedGroup: valid.token.group,
      initialRatio: valid.metadata.groups[valid.token.group]?.ratio ?? null,
      timezone: valid.timezone,
      enabled: input?.enabled !== false,
      channels: valid.channels,
    });
  }

  async function updateRule(id, input) {
    const existing = await repository.getRule(id);
    if (!existing) throw new Error("对账规则不存在");
    const requestedUpstreamStationId = String(input?.upstreamStationId || "");
    const requestedTokenId = finite(input?.tokenId);
    if (requestedUpstreamStationId !== String(existing.upstreamStationId) || requestedTokenId !== Number(existing.tokenId)) {
      const error = new Error("上游账号和 Key 是规则身份，不能编辑；请停止旧规则后新建规则");
      error.code = "RULE_IDENTITY_IMMUTABLE";
      throw error;
    }
    const valid = await validateMutableRuleInput(existing, input);
    const updated = await repository.updateRule(id, {
      upstreamStationId: existing.upstreamStationId,
      ownStationId: existing.ownStationId,
      tokenId: existing.tokenId,
      tokenName: existing.tokenName,
      fixedGroup: existing.fixedGroup,
      timezone: valid.timezone,
      enabled: input?.enabled !== false,
      channels: valid.channels,
    });
    clearRuleResults(id);
    return updated;
  }

  async function inspectRule(ruleId, window, { force = false, origin = "manual" } = {}) {
    const rule = await repository.getRule(ruleId);
    if (!rule) throw new Error("对账规则不存在");
    const cacheKey = resultKey(rule, window);
    const ttl = window.preset === "today" ? TODAY_TTL_MS : QUERY_TTL_MS;
    const cached = resultCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < ttl) return cached.value;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const task = (async () => {
      const upstream = upstreamStation(rule.upstreamStationId);
      const own = upstreamStation(rule.ownStationId);
      if (!upstream || upstream.type !== "newapi") return persistUnavailable(rule, window, health("UPSTREAM_DATA_UNAVAILABLE", "上游站点已删除或不是 NewAPI"), origin);
      if (!own || !own.isOwn || own.type !== "newapi") return persistUnavailable(rule, window, health("OWN_BILLING_UNAVAILABLE", "本站管理员 NewAPI 站点不可用"), origin);

      let metadata;
      try {
        metadata = await metadataFor(upstream, { force });
      } catch (err) {
        return persistUnavailable(rule, window, toErrorHealth(err), origin);
      }
      const token = metadata.tokens.find((item) => item.id === rule.tokenId);
      if (!token || token.status !== 1) {
        return persistUnavailable(rule, window, health("KEY_INVALID_OR_DENIED", token ? "上游 Key 已停用" : "上游 Key 不存在或无权限读取"), origin, { metadata, token });
      }
      if (token.name !== rule.tokenName) {
        return persistUnavailable(rule, window, health("KEY_INVALID_OR_DENIED", "上游 Key 名称已变化，无法确认统计归属"), origin, { metadata, token });
      }
      if (!tokenNameIsUnique(metadata, token)) {
        return persistUnavailable(rule, window, health("KEY_INVALID_OR_DENIED", "上游 Key 名称不唯一，无法安全归属统计账单"), origin, { metadata, token });
      }
      if (token.group === "auto" || token.crossGroupRetry) {
        return persistUnavailable(rule, window, health("KEY_INVALID_OR_DENIED", "上游 Key 不再是可核算的固定分组 Key"), origin, { metadata, token });
      }
      if (!metadata.groups[token.group]) {
        return persistUnavailable(rule, window, health("UPSTREAM_DATA_UNAVAILABLE", "该固定分组已不在上游账号的当前可用分组中"), origin, { metadata, token });
      }
      let segments = await repository.listSegments(rule.id);
      if (!segments.length) return persistUnavailable(rule, window, health("UPSTREAM_DATA_UNAVAILABLE", "对账规则缺少历史分段"), origin, { metadata, token });
      const currentRatio = metadata.groups[token.group]?.ratio ?? null;
      const ratioObservedAt = Date.now();
      if (await repository.backfillMissingSegmentRatios(rule.id, metadata.groups, ratioObservedAt, segments)) {
        segments = await repository.listSegments(rule.id);
      }
      const openSegment = segments[segments.length - 1];
      const reconciliation = await repository.reconcileCurrentSegment(rule.id, {
        group: token.group,
        ratio: currentRatio,
        // When detection arrives after a group switch, the account catalogue is
        // the only honest source available for the previous open segment.
        // Missing catalogue data remains null rather than being inferred.
        currentSegmentRatio: metadata.groups[openSegment.group]?.ratio ?? null,
        detectedAt: ratioObservedAt,
      });
      segments = reconciliation.segments;
      let currentSegment = reconciliation.currentSegment;
      const issues = [];
      if (reconciliation.transitioned) {
        await repository.updateObservedToken(rule.id, { tokenName: token.name, fixedGroup: token.group });
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
      const applicable = segments.map((segment) => ({ segment, segmentWindow: intersectSegment(window, segment) })).filter((item) => item.segmentWindow);
      let catalogue = null;
      try { catalogue = await ownChannelsFor(own, { force }); } catch {
        issues.push({ code: "SALES_CHANNEL_STATE_UNKNOWN", scope: "channels", detail: "本站渠道目录读取失败，渠道状态未知", observedAt: Date.now() });
      }
      const channelById = new Map((catalogue || []).map((channel) => [Number(channel.id), channel]));
      const states = rule.channels.map((channel) => {
        const found = channelById.get(channel.channelId);
        const state = catalogue ? (found ? channelState(found.status) : "missing") : "unknown";
        return { ...channel, state, stateObservedAt: Date.now() };
      });
      await repository.updateChannelStates(rule.id, states).catch(() => {});
      for (const channel of states) {
        if (channel.state === "manual_disabled" || channel.state === "auto_disabled") issues.push({ code: "SALES_CHANNEL_DISABLED", scope: "channel", channelId: channel.channelId, detail: `${channel.name} ${channel.state === "manual_disabled" ? "已手动禁用" : "已自动禁用"}`, observedAt: Date.now() });
        if (channel.state === "missing") issues.push({ code: "SALES_CHANNEL_MISSING", scope: "channel", channelId: channel.channelId, detail: `${channel.name} 已不在本站渠道目录中`, observedAt: Date.now() });
      }
      const segmentResults = await Promise.all(applicable.map(async ({ segment, segmentWindow }) => {
        const [upstreamResult, downstreamResult] = await Promise.all([
          upstreamWindowFor(upstream, token, segmentWindow).catch((error) => ({ error })),
          queryOwnChannelRevenue(own, { channelIds: rule.channels.map((channel) => channel.channelId), startMs: segmentWindow.startMs, endMs: segmentWindow.endMs }).catch((error) => ({ error })),
        ]);
        const segmentIssues = [];
        if (upstreamResult.error) segmentIssues.push({ code: toErrorHealth(upstreamResult.error).code, scope: "segment", detail: toErrorHealth(upstreamResult.error).detail, observedAt: Date.now() });
        if (upstreamResult.emptySecondWindow || downstreamResult.emptySecondWindow) segmentIssues.push({ code: "UPSTREAM_DATA_UNAVAILABLE", scope: "segment", detail: "分段短于统计秒粒度，无法无重叠地核算", observedAt: Date.now() });
        if (downstreamResult.error) segmentIssues.push({ code: toErrorHealth(downstreamResult.error, true).code, scope: "segment", detail: toErrorHealth(downstreamResult.error, true).detail, observedAt: Date.now() });
        const upstreamUnavailable = upstreamResult.error || upstreamResult.emptySecondWindow;
        const downstreamUnavailable = downstreamResult.error || downstreamResult.emptySecondWindow;
        const upstreamUsd = upstreamUnavailable ? null : upstreamResult.quotaUnits / upstreamResult.quotaPerUnit;
        const downstreamUsd = downstreamUnavailable ? null : downstreamResult.quotaUnits / downstreamResult.quotaPerUnit;
        if (!upstreamUnavailable && !downstreamUnavailable && upstreamResult.quotaUnits <= 0 && downstreamResult.quotaUnits > 0) segmentIssues.push({ code: "UPSTREAM_EMPTY_WITH_SALES", scope: "segment", detail: "本站渠道已有收费，但上游未返回对应窗口消费", observedAt: Date.now() });
        const segmentHealth = healthWithIssues(segmentIssues);
        return {
          ...segment,
          window: segmentWindow,
          upstream: upstreamUnavailable ? null : { quotaUnits: upstreamResult.quotaUnits, quotaPerUnit: upstreamResult.quotaPerUnit, amountUsd: upstreamUsd, observedAt: upstreamResult.latestLogAtMs || Date.now() },
          downstream: downstreamUnavailable ? null : {
            quotaUnits: downstreamResult.quotaUnits,
            quotaPerUnit: downstreamResult.quotaPerUnit,
            amountUsd: downstreamUsd,
            coverage: downstreamResult.coverage,
            billingCoverage: downstreamResult.billingCoverage,
            billingSource: downstreamResult.billingSource,
            calculationVersion: downstreamResult.calculationVersion,
            channels: downstreamResult.channels,
          },
          calculation: calculationFromAmounts(upstreamUsd, downstreamUsd, segmentIssues),
          health: segmentHealth,
        };
      }));
      for (const segment of segmentResults) issues.push(...segment.health.issues);
      const completeUpstream = segmentResults.every((segment) => segment.upstream);
      const completeDownstream = segmentResults.every((segment) => segment.downstream);
      const upstreamUsd = completeUpstream ? segmentResults.reduce((sum, segment) => sum + segment.upstream.amountUsd, 0) : null;
      const downstreamUsd = completeDownstream ? segmentResults.reduce((sum, segment) => sum + segment.downstream.amountUsd, 0) : null;
      const upstreamUnits = completeUpstream ? segmentResults.reduce((sum, segment) => sum + segment.upstream.quotaUnits, 0) : null;
      const downstreamUnits = completeDownstream ? segmentResults.reduce((sum, segment) => sum + segment.downstream.quotaUnits, 0) : null;
      const allChannels = states.map((channel) => {
        const quotaUnits = segmentResults.reduce((sum, segment) => sum + Number(segment.downstream?.channels?.find((item) => item.channelId === channel.channelId)?.quotaUnits || 0), 0);
        return {
          ...channel,
          quotaUnits: completeDownstream ? quotaUnits : null,
          amountUsd: completeDownstream ? segmentResults.reduce((sum, segment) => sum + Number(segment.downstream?.channels?.find((item) => item.channelId === channel.channelId)?.amountUsd || 0), 0) : null,
          share: completeDownstream ? (downstreamUnits > 0 ? quotaUnits / downstreamUnits : 0) : null,
        };
      });
      const resultHealth = healthWithIssues(issues);
      const result = {
        rule: { ...rule, tokenName: token.name, fixedGroup: currentSegment.group }, window,
        requestedWindow: window,
        lastSuccessfulWindow: window,
        currentSegment,
        segments: segmentResults,
        transitionSegments: segments,
        upstream: upstreamUsd == null ? null : { quotaUnits: upstreamUnits, quotaPerUnit: segmentResults[0]?.upstream?.quotaPerUnit ?? null, amountUsd: upstreamUsd, observedAt: Date.now(), status: token.status, group: currentSegment.group, ratio: currentSegment.ratio },
        downstream: {
          quotaUnits: downstreamUnits,
          quotaPerUnit: segmentResults[0]?.downstream?.quotaPerUnit ?? null,
          amountUsd: downstreamUsd,
          coverage: completeDownstream ? 1 : 0,
          billingCoverage: completeDownstream ? 1 : 0,
          billingSource: RECONCILIATION_BILLING_SOURCE,
          calculationVersion: RECONCILIATION_CALCULATION_VERSION,
          observedAt: Date.now(),
          channels: allChannels,
        },
        calculation: calculationFromAmounts(upstreamUsd, downstreamUsd, issues),
        health: resultHealth, generatedAt: new Date().toISOString(),
      };
      const sourceUnavailable = issues.some((issue) => ["KEY_INVALID_OR_DENIED", "UPSTREAM_DATA_UNAVAILABLE", "OWN_BILLING_UNAVAILABLE", "OWN_FLOW_INCOMPLETE"].includes(issue.code));
      if (result.calculation.profitUsd != null) {
        result.lastSuccessfulAt = result.generatedAt;
        lastSuccessfulResults.set(cacheKey, { result, at: result.generatedAt });
      }
      const previous = lastSuccessfulResults.get(cacheKey)
        || await repository.latestSuccessfulResult(rule.id, window).catch(() => null);
      if (sourceUnavailable && previous) {
        const stale = {
          ...previous.result,
          rule: result.rule,
          currentSegment,
          transitionSegments: segments,
          health: { ...resultHealth, stale: true },
          window: previous.result.lastSuccessfulWindow || previous.result.window,
          requestedWindow: window,
          lastSuccessfulWindow: previous.result.lastSuccessfulWindow || previous.result.window,
          lastSuccessfulAt: previous.at || previous.generatedAt,
          generatedAt: result.generatedAt,
        };
        await persistResult(rule, stale, origin, metadata, token, { saveSnapshots: false });
        return stale;
      }
      await persistResult(rule, result, origin, metadata, token);
      return result;
    })();
    inflight.set(cacheKey, task);
    try {
      const value = await task;
      resultCache.set(cacheKey, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(cacheKey);
    }
  }

  async function persistUnavailable(rule, window, resultHealth, origin, evidence = {}) {
    const persistedSegments = await repository.listSegments(rule.id).catch(() => []);
    const currentSegment = persistedSegments[persistedSegments.length - 1] || null;
    const unavailable = {
      rule,
      window,
      requestedWindow: window,
      lastSuccessfulWindow: null,
      currentSegment,
      transitionSegments: persistedSegments,
      upstream: evidence.upstream ? {
        quotaUnits: evidence.upstream.quotaUnits,
        quotaPerUnit: evidence.upstream.quotaPerUnit,
        amountUsd: evidence.upstream.quotaUnits / evidence.upstream.quotaPerUnit,
        observedAt: evidence.upstream.latestLogAtMs || Date.now(),
        status: evidence.token?.status ?? null,
        group: evidence.token?.group ?? null,
        ratio: evidence.metadata?.groups?.[evidence.token?.group]?.ratio ?? null,
      } : null,
      downstream: evidence.downstream ? {
        quotaUnits: evidence.downstream.quotaUnits,
        quotaPerUnit: evidence.downstream.quotaPerUnit,
        amountUsd: evidence.downstream.quotaUnits / evidence.downstream.quotaPerUnit,
        coverage: evidence.downstream.coverage,
        billingCoverage: evidence.downstream.billingCoverage ?? evidence.downstream.coverage,
        billingSource: evidence.downstream.billingSource || RECONCILIATION_BILLING_SOURCE,
        calculationVersion: evidence.downstream.calculationVersion || RECONCILIATION_CALCULATION_VERSION,
        observedAt: Date.now(),
        channels: evidence.downstream.channels || [],
      } : null,
      calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
      health: resultHealth,
      generatedAt: new Date().toISOString(),
    };
    const previous = lastSuccessfulResults.get(resultKey(rule, window))
      || await repository.latestSuccessfulResult(rule.id, window).catch(() => null);
    const result = previous ? {
      ...previous.result,
      rule,
      window: previous.result.lastSuccessfulWindow || previous.result.window,
      requestedWindow: window,
      lastSuccessfulWindow: previous.result.lastSuccessfulWindow || previous.result.window,
      currentSegment: currentSegment || previous.result.currentSegment,
      transitionSegments: persistedSegments.length ? persistedSegments : previous.result.transitionSegments,
      health: { ...resultHealth, stale: true },
      lastSuccessfulAt: previous.at || previous.generatedAt,
      generatedAt: unavailable.generatedAt,
    } : unavailable;
    await persistResult(rule, result, origin, evidence.metadata, evidence.token, { saveSnapshots: !previous });
    return result;
  }

  async function persistResult(rule, result, origin, metadata = null, token = null, { saveSnapshots = true } = {}) {
    const snapshots = result.segments?.length ? result.segments : [{ id: result.currentSegment?.id || null, window: result.window, upstream: result.upstream, downstream: result.downstream, calculation: result.calculation, health: result.health }];
    const save = () => Promise.all(snapshots.map((segment) => {
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
      return repository.saveSnapshot({
        ruleId: rule.id,
        segmentId: segment.id,
        snapshotKey: `${snapshotKey(segment.window)}:${segment.id || "legacy"}`,
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
          resultGeneratedAt: result.lastSuccessfulAt === result.generatedAt ? result.generatedAt : null,
          result: result.lastSuccessfulAt === result.generatedAt ? {
            currentSegment: result.currentSegment,
            transitionSegments: result.transitionSegments,
            segments: result.segments,
            upstream: result.upstream,
            downstream: result.downstream,
            calculation: result.calculation,
          } : null,
        },
      });
    }));
    if (saveSnapshots) await save();
    try { await notifyReconciliationHealth(rt, repository, rule, result); } catch (err) {
      console.error("渠道对账通知失败:", err?.message || String(err));
    }
  }

  return {
    async getConfiguration() {
      const own = ownStation();
      const rules = await repository.listRules();
      const upstreams = rt.store.list().filter((station) => station.type === "newapi" && !station.isOwn && !station.archivedAt).map(publicStation);
      let channels = [];
      let channelsError = null;
      if (own) {
        try { channels = await ownChannelsFor(own); } catch (err) { channelsError = String(err?.message || err); }
      }
      return { ownStation: publicStation(own), upstreams, channels, channelsError, rules };
    },

    async getUpstreamKeys(stationId, { force = false } = {}) {
      const station = upstreamStation(stationId);
      if (!station || station.type !== "newapi" || station.isOwn) throw new Error("上游站点不存在");
      return publicMetadata(await metadataFor(station, { force }));
    },

    createRule: saveRule,
    updateRule,
    async archiveRule(id) {
      const rule = await repository.getRule(id);
      if (!rule) throw new Error("对账规则不存在或已停止");
      const ok = await repository.archiveRule(id);
      if (!ok) throw new Error("对账规则不存在或已停止");
      clearRuleResults(id);
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
      for (const key of resultCache.keys()) if (key.startsWith(`${ruleId}:`)) resultCache.delete(key);
      return segments;
     },
    async queryRules({ ruleIds = null, ...input } = {}, options = {}) {
      const rules = await repository.listRules();
      const selected = (Array.isArray(ruleIds) && ruleIds.length)
        ? rules.filter((rule) => ruleIds.includes(rule.id))
        : rules.filter((rule) => rule.enabled);
      const now = Date.now();
      const results = await mapWithConcurrency(selected, MAX_CONCURRENT_RULES, (rule) => inspectRule(
        rule.id,
        resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now),
        options
      ));
      return { results, generatedAt: new Date(now).toISOString() };
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
