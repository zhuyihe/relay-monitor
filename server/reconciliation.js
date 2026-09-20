// 对账深模块：把窗口、上游取数、本站收费、快照和告警收敛在一个 Interface 后。
import {
  queryNewApiReconciliationMetadata,
  queryNewApiTokenWindow,
  queryOwnChannelRevenue,
  queryOwnChannels,
} from "../lib/providers.js";
import { ReconciliationRepository } from "./reconciliation-repository.js";
import { notifyReconciliationHealth } from "./reconciliation-notify.js";

const DAY_MS = 86400000;
const TODAY_TTL_MS = 60000;
const QUERY_TTL_MS = 60000;
const LOG_SYNC_OVERLAP_MS = 3 * 60000;

const HEALTH = {
  READY: { label: "数据正常" },
  GROUP_OR_RATIO_CHANGED: { label: "分组或倍率已变化" },
  KEY_INVALID_OR_DENIED: { label: "Key 不可用或无权限" },
  UPSTREAM_DATA_UNAVAILABLE: { label: "上游账单数据不可用" },
  OWN_FLOW_INCOMPLETE: { label: "本站渠道收费不完整" },
  UPSTREAM_EMPTY_WITH_SALES: { label: "本站有收费但上游无消费" },
  STALE: { label: "数据已过期" },
};

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

function midnight(ms, timezone) {
  const part = zonedParts(ms, timezone);
  return ms - ((part.hour * 3600 + part.minute * 60 + part.second) * 1000) - (ms % 1000);
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
  } else {
    const dayStart = midnight(now, timezone);
    if (preset === "yesterday") {
      startMs = dayStart - DAY_MS;
      endMs = dayStart;
    } else if (preset === "7d") {
      startMs = dayStart - 6 * DAY_MS;
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
  return { code, label: HEALTH[code]?.label || code, detail, stale: code === "STALE" };
}

function toErrorHealth(err, own = false) {
  const code = String(err?.code || "");
  if (!own && code === "UPSTREAM_AUTH_DENIED") {
    return health("KEY_INVALID_OR_DENIED", "上游 PAT 无权读取 Key 或消费日志");
  }
  if (!own && code === "UPSTREAM_TOKEN_ID_UNAVAILABLE") {
    return health("UPSTREAM_DATA_UNAVAILABLE", "上游日志未提供 token_id，无法安全精确对账");
  }
  if (!own && code === "UPSTREAM_LOG_LIMIT") {
    return health("UPSTREAM_DATA_UNAVAILABLE", "上游日志达到可安全读取上限，无法完成精确对账");
  }
  return health(own ? "OWN_FLOW_INCOMPLETE" : "UPSTREAM_DATA_UNAVAILABLE",
    own ? "无法完整读取本站渠道收费" : "无法完整读取上游对账数据");
}

function snapshotKey(window) {
  return window.preset === "today"
    ? `today:${localDate(window.startMs, window.timezone)}`
    : `${window.preset}:${window.startMs}:${window.endMs}`;
}

function sourceSnapshot(token, metadata, upstream, downstream) {
  return {
    upstream: {
      tokenId: token.id,
      tokenName: token.name,
      group: token.group,
      ratio: metadata.groups[token.group]?.ratio ?? null,
      status: token.status,
      latestLogAtMs: upstream?.latestLogAtMs ?? null,
    },
    downstream: {
      coverage: downstream?.coverage ?? null,
      channels: downstream?.channels?.map((channel) => ({ channelId: channel.channelId, quotaUnits: channel.quotaUnits })) || [],
    },
  };
}

function aggregateTokenFacts(scan, facts, startMs, endMs) {
  const inWindow = [...facts.values()].filter((fact) => fact.createdAtMs >= startMs && fact.createdAtMs < endMs);
  return {
    ...scan,
    quotaUnits: inWindow.reduce((sum, fact) => sum + fact.quotaUnits, 0),
    actualGroups: [...new Set(inWindow.map((fact) => fact.group).filter(Boolean))],
    tokenIds: [...new Set(inWindow.map((fact) => fact.tokenId))],
    latestLogAtMs: inWindow.reduce((latest, fact) => Math.max(latest, fact.createdAtMs), 0) || null,
    scanned: facts.size,
  };
}

export function createReconciliationModule(rt) {
  const repository = new ReconciliationRepository(rt.pool);
  const resultCache = (rt._reconciliationResultCache ||= new Map());
  const inflight = (rt._reconciliationInflight ||= new Map());
  const metadataCache = (rt._reconciliationMetadataCache ||= new Map());
  const ownChannelsCache = (rt._reconciliationOwnChannelsCache ||= new Map());
  const tokenLogCaches = (rt._reconciliationTokenLogCaches ||= new Map());

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

  async function upstreamWindowFor(rule, upstream, token, window, { force = false } = {}) {
    // 只有“今天”会随轮询增长：首次全量扫描，之后保留 3 分钟重叠增量扫，按上游日志 ID 去重。
    if (window.preset !== "today" || force) {
      return queryNewApiTokenWindow(upstream, {
        tokenId: token.id, tokenName: token.name, startMs: window.startMs, endMs: window.endMs,
      });
    }
    const key = `${rule.id}:${localDate(window.startMs, window.timezone)}`;
    const cached = tokenLogCaches.get(key);
    if (!cached) {
      const scan = await queryNewApiTokenWindow(upstream, {
        tokenId: token.id, tokenName: token.name, startMs: window.startMs, endMs: window.endMs,
      });
      const facts = new Map(scan.facts.map((fact) => [fact.id, fact]));
      tokenLogCaches.set(key, { tokenId: token.id, scannedToMs: window.endMs, facts });
      return aggregateTokenFacts(scan, facts, window.startMs, window.endMs);
    }
    // Key 被编辑后不能把旧 Key 的内存事实混进新规则。
    if (cached.tokenId !== token.id) {
      tokenLogCaches.delete(key);
      return upstreamWindowFor(rule, upstream, token, window, { force: false });
    }
    const scanStartMs = Math.max(window.startMs, cached.scannedToMs - LOG_SYNC_OVERLAP_MS);
    const scan = await queryNewApiTokenWindow(upstream, {
      tokenId: token.id, tokenName: token.name, startMs: scanStartMs, endMs: window.endMs,
    });
    for (const fact of scan.facts) cached.facts.set(fact.id, fact);
    cached.scannedToMs = window.endMs;
    return aggregateTokenFacts(scan, cached.facts, window.startMs, window.endMs);
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

  async function saveRule(input) {
    const valid = await validateInput(input);
    return repository.createRule({
      upstreamStationId: valid.upstream.id,
      ownStationId: valid.own.id,
      tokenId: valid.token.id,
      tokenName: valid.token.name,
      fixedGroup: valid.token.group,
      timezone: valid.timezone,
      enabled: input?.enabled !== false,
      channels: valid.channels,
    });
  }

  async function updateRule(id, input) {
    const existing = await repository.getRule(id);
    if (!existing) throw new Error("对账规则不存在");
    const valid = await validateInput(input, { excludeRuleId: id });
    return repository.updateRule(id, {
      upstreamStationId: valid.upstream.id,
      ownStationId: valid.own.id,
      tokenId: valid.token.id,
      tokenName: valid.token.name,
      fixedGroup: valid.token.group,
      timezone: valid.timezone,
      enabled: input?.enabled !== false,
      channels: valid.channels,
    });
  }

  async function inspectRule(ruleId, window, { force = false, origin = "manual" } = {}) {
    const rule = await repository.getRule(ruleId);
    if (!rule) throw new Error("对账规则不存在");
    const cacheKey = `${rule.id}:${window.preset}:${window.startMs}:${window.endMs}:${window.timezone}`;
    const ttl = window.preset === "today" ? TODAY_TTL_MS : QUERY_TTL_MS;
    const cached = resultCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < ttl) return cached.value;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const task = (async () => {
      const upstream = upstreamStation(rule.upstreamStationId);
      const own = upstreamStation(rule.ownStationId);
      if (!upstream || upstream.type !== "newapi") return persistUnavailable(rule, window, health("UPSTREAM_DATA_UNAVAILABLE", "上游站点已删除或不是 NewAPI"), origin);
      if (!own || !own.isOwn || own.type !== "newapi") return persistUnavailable(rule, window, health("OWN_FLOW_INCOMPLETE", "本站管理员 NewAPI 站点不可用"), origin);

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
      if (token.name !== rule.tokenName) await repository.updateObservedToken(rule.id, { tokenName: token.name });
      if (token.group !== rule.fixedGroup || token.group === "auto" || token.crossGroupRetry) {
        return persistUnavailable(rule, window, health("GROUP_OR_RATIO_CHANGED", "上游 Key 的固定分组或跨组重试设置已变化"), origin, { metadata, token });
      }
      if (!metadata.groups[token.group]) {
        return persistUnavailable(rule, window, health("GROUP_OR_RATIO_CHANGED", "该固定分组已不在上游账号的当前可用分组中"), origin, { metadata, token });
      }
      const [upstreamResult, downstreamResult, previousMap] = await Promise.all([
        upstreamWindowFor(rule, upstream, token, window, { force }).catch((err) => ({ error: err })),
        queryOwnChannelRevenue(own, { channelIds: rule.channels.map((channel) => channel.channelId), startMs: window.startMs, endMs: window.endMs }).catch((err) => ({ error: err })),
        repository.latestSnapshots([rule.id]),
      ]);
      if (upstreamResult.error) return persistUnavailable(rule, window, toErrorHealth(upstreamResult.error), origin, { metadata, token });
      if (downstreamResult.error) return persistUnavailable(rule, window, toErrorHealth(downstreamResult.error, true), origin, { metadata, token, upstream: upstreamResult });
      if (upstreamResult.tokenIds.length && upstreamResult.tokenIds.some((id) => id !== token.id)) {
        return persistUnavailable(rule, window, health("UPSTREAM_DATA_UNAVAILABLE", "上游日志中的 Key 身份与所选 Key 不一致"), origin, { metadata, token, upstream: upstreamResult, downstream: downstreamResult });
      }
      if (upstreamResult.actualGroups.length && upstreamResult.actualGroups.some((group) => group !== rule.fixedGroup)) {
        return persistUnavailable(rule, window, health("GROUP_OR_RATIO_CHANGED", "上游消费日志显示的实际分组与规则不一致"), origin, { metadata, token, upstream: upstreamResult, downstream: downstreamResult });
      }

      const prior = previousMap.get(rule.id)?.source?.upstream;
      const currentRatio = metadata.groups[token.group]?.ratio ?? null;
      const ratioChanged = prior && prior.ratio != null && currentRatio != null && Number(prior.ratio) !== Number(currentRatio);
      const upstreamUsd = upstreamResult.quotaUnits / upstreamResult.quotaPerUnit;
      const downstreamUsd = downstreamResult.quotaUnits / downstreamResult.quotaPerUnit;
      let resultHealth = health("READY");
      if (ratioChanged) resultHealth = health("GROUP_OR_RATIO_CHANGED", "上游当前 group ratio 与上次观察不同");
      else if (downstreamResult.coverage < 0.999) resultHealth = health("OWN_FLOW_INCOMPLETE", "本站 /api/data/flow 未完整覆盖同窗口收费");
      else if (upstreamResult.quotaUnits <= 0 && downstreamResult.quotaUnits > 0) resultHealth = health("UPSTREAM_EMPTY_WITH_SALES", "本站渠道已有收费，但上游未返回对应窗口消费");

      const channels = downstreamResult.channels.map((channel) => ({
        ...channel,
        share: downstreamResult.quotaUnits > 0 ? channel.quotaUnits / downstreamResult.quotaUnits : 0,
      }));
      const result = {
        rule: { ...rule, tokenName: token.name },
        window,
        upstream: {
          quotaUnits: upstreamResult.quotaUnits,
          quotaPerUnit: upstreamResult.quotaPerUnit,
          amountUsd: upstreamUsd,
          observedAt: upstreamResult.latestLogAtMs || Date.now(),
          status: token.status,
          group: token.group,
          ratio: currentRatio,
        },
        downstream: {
          quotaUnits: downstreamResult.quotaUnits,
          quotaPerUnit: downstreamResult.quotaPerUnit,
          amountUsd: downstreamUsd,
          coverage: downstreamResult.coverage,
          observedAt: Date.now(),
          channels,
        },
        calculation: {
          differenceUsd: downstreamUsd - upstreamUsd,
          marginRate: resultHealth.code === "READY" && downstreamUsd > 0 ? (downstreamUsd - upstreamUsd) / downstreamUsd : null,
        },
        health: resultHealth,
        generatedAt: new Date().toISOString(),
      };
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
    const result = {
      rule,
      window,
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
        observedAt: Date.now(),
        channels: evidence.downstream.channels || [],
      } : null,
      calculation: { differenceUsd: null, marginRate: null },
      health: resultHealth,
      generatedAt: new Date().toISOString(),
    };
    await persistResult(rule, result, origin, evidence.metadata, evidence.token);
    return result;
  }

  async function persistResult(rule, result, origin, metadata = null, token = null) {
    const source = metadata && token ? sourceSnapshot(token, metadata, result.upstream, result.downstream) : {
      upstream: result.upstream ? { group: result.upstream.group, ratio: result.upstream.ratio, status: result.upstream.status } : null,
      downstream: { coverage: result.downstream?.coverage ?? null },
    };
    await repository.saveSnapshot({
      ruleId: rule.id,
      snapshotKey: snapshotKey(result.window),
      windowKind: result.window.preset,
      startMs: result.window.startMs,
      endMs: result.window.endMs,
      localDate: result.window.preset === "today" ? localDate(result.window.startMs, result.window.timezone) : null,
      upstreamQuota: result.upstream?.quotaUnits ?? null,
      upstreamQuotaPerUnit: result.upstream?.quotaPerUnit ?? null,
      upstreamUsd: result.upstream?.amountUsd ?? null,
      downstreamQuota: result.downstream?.quotaUnits ?? null,
      downstreamQuotaPerUnit: result.downstream?.quotaPerUnit ?? null,
      downstreamUsd: result.downstream?.amountUsd ?? null,
      differenceUsd: result.calculation?.differenceUsd ?? null,
      marginRate: result.calculation?.marginRate ?? null,
      coverage: result.downstream?.coverage ?? null,
      healthCode: result.health.code,
      healthDetail: result.health.detail || null,
      source: { ...source, origin },
    });
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
      const ok = await repository.archiveRule(id);
      if (!ok) throw new Error("对账规则不存在");
    },
    async queryRules({ ruleIds = null, ...input } = {}, options = {}) {
      const rules = await repository.listRules();
      const selected = (Array.isArray(ruleIds) && ruleIds.length)
        ? rules.filter((rule) => ruleIds.includes(rule.id))
        : rules.filter((rule) => rule.enabled);
      const now = Date.now();
      const results = await Promise.all(selected.map((rule) => inspectRule(
        rule.id,
        resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now),
        options
      )));
      return { results, generatedAt: new Date(now).toISOString() };
    },
    async refreshDue(now = Date.now()) {
      const rules = (await repository.listRules()).filter((rule) => rule.enabled);
      await Promise.allSettled(rules.map((rule) => inspectRule(
        rule.id,
        resolveReconciliationWindow({ preset: "today", timezone: rule.timezone }, now),
        { origin: "poll" }
      )));
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
