import { createHash, randomUUID } from "node:crypto";
import { queryNewApiReconciliationMetadata, queryReconciliationMetadata, queryAccountIdentity, queryKeyReconciliationStat, queryOwnChannels, queryStation } from "../lib/providers.js";
import { describeConnectionFailure } from "../lib/connection-test.js";
import { onboardingBaseUrl, publicOnboardingStation, onboardingConnectionPatch, normalizeBatchInput,
  coalesceVerifiedBatchGroups, normalizeBatchRecoveryIntent } from "../lib/channel-onboarding.js";
import { stationBusinessVersion } from "../db/store.js";
import { nextBillingEffectiveFrom, completedBillingDayWindow, canonicalBillingKey, applyScopePolicy } from "../lib/reconciliation-scope-policy.js";
import { ChannelOnboardingRepository } from "./channel-onboarding-repository.js";
import { refreshStation } from "./refresh.js";
import { normalizeReconciliationScopeIntent } from "./reconciliation.js";

// 验证后才保存。重试和同进程并发接入按上游地址 + 账号身份复用，避免重复监控同一余额。
export async function connectNewApiUpstream(rt, input, queryMetadata = queryNewApiReconciliationMetadata) {
  const baseUrl = onboardingBaseUrl(input?.baseUrl);
  const accessToken = String(input?.accessToken || "").trim();
  if (!baseUrl) throw new Error("请填写有效的上游站点根地址");
  if (!accessToken) throw new Error("请填写上游账号的系统访问令牌");
  const connection = { type: "newapi", baseUrl, accessToken, userId: String(input?.userId || "").trim() };
  let metadata;
  try { metadata = await queryMetadata(connection); } catch (err) {
    throw new Error(describeConnectionFailure(err?.message || String(err), connection).diagnostic);
  }
  const userId = String(metadata.userId || "").trim();
  if (!userId) throw new Error("无法确认上游账号身份，请填写用户 ID 后重试");

  const pending = (rt._newApiOnboardingChain || Promise.resolve()).then(async () => {
    const existing = rt.store.list().find((station) => station.type === "newapi" && !station.isOwn && !station.archivedAt
      && onboardingBaseUrl(station.baseUrl) === baseUrl
      && (String(station.userId || "").trim() === userId
        || (!station.userId && String(station.accessToken || "").replace(/^Bearer\s+/i, "").trim() === accessToken.replace(/^Bearer\s+/i, ""))));
    if (existing) return { station: { id: existing.id, name: existing.name, type: existing.type, baseUrl: existing.baseUrl }, created: false };
    const station = await rt.store.add({ ...connection, userId, name: String(input?.name || "").trim() || "上游账号" });
    return { station: { id: station.id, name: station.name, type: station.type, baseUrl: station.baseUrl }, created: true };
  });
  rt._newApiOnboardingChain = pending.catch(() => {});
  return pending;
}

const ACCOUNT_TYPES = ["newapi", "sub2api", "sub2api-password"];
const TYPES = [...ACCOUNT_TYPES, "newapi-key"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const authFields = ["type", "baseUrl", "accessToken", "userId", "apiKey", "email", "password"];
const authVersion = (station) => hash([station?.authVersion || 1, ...authFields.map((field) => station?.[field] || "")]);
const ownVersion = (station, source) => station ? hash([stationBusinessVersion(station), source?.namespaceKey || null]) : null;
const revisionOf = (namespaceKey, channel) => hash([namespaceKey, Number(channel.id), channel.type, onboardingBaseUrl(channel.baseUrl) || channel.baseUrl]);

function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

const previewFailure = (code, message) => Object.assign(new Error(message), { code });

function ownSourceIdentity(station, identity) {
  const baseUrl = onboardingBaseUrl(identity?.baseUrl), accountId = String(identity?.accountId || "").trim();
  if (identity?.provider !== "newapi" || !accountId || baseUrl !== onboardingBaseUrl(station.baseUrl)) {
    throw Object.assign(new Error("本站未提供可验证的稳定账号身份"), { code: "OWN_IDENTITY_UNVERIFIED" });
  }
  return { stationId: station.id, provider: "newapi", baseUrl, accountId, namespaceKey: hash(["newapi", baseUrl, accountId]) };
}

function connectionInput(input, { authorization = false } = {}) {
  if (!input || !TYPES.includes(input.type) || authorization && !ACCOUNT_TYPES.includes(input.type)) {
    throw new Error("请选择支持的上游类型");
  }
  const baseUrl = onboardingBaseUrl(input.baseUrl);
  if (!baseUrl) throw new Error("请填写有效的上游站点根地址");
  const connection = { type: input.type, baseUrl, name: String(input.name || "上游账号").trim(), isOwn: false };
  const fields = input.type === "newapi" ? ["accessToken", "userId"]
    : input.type === "newapi-key" ? ["apiKey"] : input.type === "sub2api" ? ["accessToken"] : ["email", "password"];
  for (const field of fields) connection[field] = String(input[field] || "").trim();
  if (input.type === "sub2api-password") connection.password = String(input.password || "");
  for (const field of ["cnyPerUsd", "lowBalanceUsd", "noRenewal", "includeInProfit", "costAliases"]) {
    if (field in input) connection[field] = input[field];
  }
  if (authorization) Object.assign(connection, { monitorEnabled: false, includeInProfit: false });
  return connection;
}

function accountIdentity(connection, metadata) {
  const accountId = metadata?.accountId ?? metadata?.userId;
  if (accountId == null || String(accountId).trim() === "") return null;
  return { provider: metadata.platform || (connection.type.startsWith("sub2api") ? "sub2api" : "newapi"),
    baseUrl: onboardingBaseUrl(metadata.baseUrl || connection.baseUrl), accountId: String(accountId) };
}

function sameIdentity(first, second) {
  return !!first && !!second && first.provider === second.provider && first.accountId === second.accountId
    && onboardingBaseUrl(first.baseUrl) === onboardingBaseUrl(second.baseUrl);
}

function sameCredentials(first, second) {
  const firstPatch = onboardingConnectionPatch(first), secondPatch = onboardingConnectionPatch(second);
  return first.type === second.type && onboardingBaseUrl(first.baseUrl) === onboardingBaseUrl(second.baseUrl)
    && authFields.filter((field) => !["type", "baseUrl"].includes(field)).every((field) =>
      String(firstPatch[field] || "") === String(secondPatch[field] || ""));
}

function safeTokens(tokens = []) {
  return tokens.map((token) => ({ id: token.id, name: token.name, status: token.status, group: token.group,
    crossGroupRetry: !!token.crossGroupRetry, maskedKey: /[*•]/.test(token.maskedKey || "") ? token.maskedKey : "" }));
}

function failure(error, connections = []) {
  return describeConnectionFailure(error?.message || error || "接入失败", connections).diagnostic;
}

export function createChannelOnboardingModule(rt, dependencies = {}) {
  const repository = dependencies.repository || new ChannelOnboardingRepository(rt.pool);
  const queryChannels = dependencies.queryChannels || queryOwnChannels;
  const queryMetadata = dependencies.queryMetadata || queryReconciliationMetadata;
  const queryIdentity = dependencies.queryIdentity || queryAccountIdentity;
  const queryStat = dependencies.queryStat || queryKeyReconciliationStat;
  const queryMonitor = dependencies.queryMonitor || queryStation;
  const refresh = dependencies.refresh || refreshStation;
  const now = dependencies.now || Date.now;
  let catalogue = null, links = [], syncError = null;
  const previews = new Map(), guardFacts = new WeakMap();
  const own = () => rt.store.list().find((station) => station.isOwn && station.type === "newapi") || null;
  const resources = () => rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && TYPES.includes(station.type));
  const reusable = (item) => item && (item.existing || item.candidate);
  const sourceVersion = () => ownVersion(own(), catalogue?.ownSource);
  const stale = () => !catalogue?.ownSource || catalogue.ownStationId !== own()?.id || catalogue.sourceVersion !== sourceVersion()
    || !!syncError || now() - catalogue.syncedAt > 5 * 60000;

  function withSourceLock(_rule, write) {
    const pending = (rt._channelSourceChain || Promise.resolve()).then(write);
    rt._channelSourceChain = pending.catch(() => {});
    return pending;
  }

  const stationLock = (ids, write) => rt.store.withStationLocks ? rt.store.withStationLocks(ids, write) : write();
  const rules = () => rt.reconciliation?.listRules?.() || Promise.resolve([]);

  function sourceChannel(input) {
    const station = own();
    if (!station || input.ownStationId !== station.id) throw new Error("本站配置已变化，请重新发现渠道");
    if (stale()) throw Object.assign(new Error("渠道目录已过期，请同步后重新确认"), { code: "CHANNEL_CATALOGUE_STALE" });
    const channel = catalogue.channels.find((item) => Number(item.id) === Number(input.channelId));
    if (!channel || channel.missing || channel.revision !== input.channelRevision) {
      throw Object.assign(new Error("渠道连接配置已变化，请重新确认"), { code: "CHANNEL_SOURCE_CHANGED" });
    }
    return channel;
  }

  function inspectSource(rule) {
    const hasBinding = Object.keys(rule.sourceBinding || {}).length > 0;
    if (!hasBinding && !rule.ownSource) return { version: "legacy", status: "confirmed", issues: [] };
    const station = own();
    const entries = (rule.channels || []).map((member) => {
      const id = Number(member.channelId);
      const channel = catalogue?.channels?.find((item) => Number(item.id) === id);
      return [id, rule.sourceBinding?.[id] || null, channel?.revision || null, !!channel?.missing];
    }).sort(([a], [b]) => a - b);
    const available = !!station && rule.ownStationId === station.id && catalogue?.ownStationId === station.id && !stale();
    const sameNamespace = !!rule.ownSource && rule.ownSource.namespaceKey === catalogue?.ownSource?.namespaceKey;
    const confirmed = available && sameNamespace && (!hasBinding || entries.every(([, binding, revision, missing]) => binding && binding === revision && !missing));
    const status = !available ? "unavailable" : confirmed ? "confirmed" : "review_required";
    return { version: hash([sourceVersion(), catalogue?.sourceVersion || null, rule.ownSource?.namespaceKey || null, entries]), status,
      issues: confirmed ? [] : [{ code: "SOURCE_BINDING_UNCONFIRMED", detail: "渠道来源已变化或待核对，当前金额仅供参考" }] };
  }

  function getSourceCatalogue() {
    const source = catalogue?.ownSource;
    return {
      ownSource: source ? { stationId: source.stationId, provider: source.provider, baseUrl: source.baseUrl,
        accountId: source.accountId, namespaceKey: source.namespaceKey } : null,
      sourceVersion: sourceVersion(), syncedAt: catalogue?.syncedAt || null, stale: stale(),
      totalValidated: catalogue?.totalValidated === true, catalogueTotal: catalogue?.catalogueTotal ?? null,
      channels: (catalogue?.channels || []).map((channel) => ({ id: channel.id, name: channel.name, type: channel.type,
        status: channel.status, baseUrl: channel.baseUrl, groups: [...(channel.groups || [])], revision: channel.revision, missing: !!channel.missing })),
    };
  }

  function expirePreviews() {
    for (const [id, value] of previews) if (value.expiresAtMs <= now()) previews.delete(id);
  }

  function getPreviewGuard(previewId, groupId) {
    expirePreviews();
    const value = previews.get(previewId);
    const group = value?.groups.find((entry) => entry.requestedGroupIds.includes(groupId));
    if (!group) throw previewFailure("PREVIEW_REQUIRED", "请重新验证并确认完整 Key 范围");
    return group.guard;
  }

  function assertPreviewGuard(guard, { basis, preview, postSaveResourceVersions } = {}) {
    const facts = guardFacts.get(guard);
    if (!facts || !previews.has(facts.previewId) || facts.expiresAtMs <= now()) {
      throw previewFailure("PREVIEW_REQUIRED", "预览已过期，请恢复已保存结果后重新验证");
    }
    const changed = () => { throw previewFailure("PREVIEW_BASIS_CHANGED", "来源、资源或 Key 范围已变化，请重新预览"); };
    if (!basis || !preview || stale() || sourceVersion() !== facts.basis.sourceVersion
        || catalogue.ownSource.namespaceKey !== facts.basis.ownSource.namespaceKey) changed();
    const approved = Object.fromEntries([...facts.saved].map(([id, saved]) => [id, saved.version]));
    if (postSaveResourceVersions && hash(postSaveResourceVersions) !== hash(approved)) changed();
    const versions = { ...facts.basis.resourceVersions, ...approved };
    for (const [id, version] of Object.entries(versions)) {
      const station = rt.store.get(id);
      if (!station || (station.authVersion || 1) !== version.authVersion || stationBusinessVersion(station) !== version.resourceVersion) changed();
      if (basis.resourceVersions?.[id] && hash(basis.resourceVersions[id]) !== hash(version)) changed();
    }
    for (const [id, version] of Object.entries(basis.resourceVersions || {})) {
      if (!versions[id] || hash(version) !== hash(versions[id])) changed();
    }
    const fields = ["ownSource", "sourceVersion", "channelRevisions", "accountIdentity", "canonicalKey", "tokenId", "keyVersion",
      "existingRuleId", "existingScopeVersion", "existingChannelIds", "proposedChannelIds", "timezone", "coverageDeclaration"];
    if (fields.some((field) => hash(basis[field]) !== hash(facts.basis[field]))) changed();
    if (preview.scopeChanged && preview.billingEffectiveFromMs !== facts.preview.billingEffectiveFromMs) {
      const error = previewFailure("EFFECTIVE_PREVIEW_CHANGED", "确认时间已跨过日期边界，请查看新的生效日期并重新预览");
      error.billingEffectiveFrom = preview.billingEffectiveFromMs;
      error.nextPreview = { billingEffectiveFromMs: preview.billingEffectiveFromMs, timezone: basis.timezone,
        proposedChannelIds: basis.proposedChannelIds, coverageDeclaration: basis.coverageDeclaration };
      throw error;
    }
    if (hash(preview) !== hash(facts.preview) || basis.billingEffectiveFromMs !== facts.basis.billingEffectiveFromMs) changed();
  }

  function registerPreview(groups, retryInput = null) {
    expirePreviews();
    while (previews.size >= 100) previews.delete(previews.keys().next().value);
    const previewId = randomUUID(), expiresAtMs = now() + 10 * 60000;
    const storedGroups = structuredClone(groups);
    const value = { previewId, expiresAtMs, retryInput: structuredClone(retryInput), groups: storedGroups };
    for (const group of storedGroups) {
      const facts = { previewId, expiresAtMs, basis: frozen(structuredClone(group.basis)),
        preview: frozen(structuredClone(group.preview)), saved: new Map(), roles: group.roles,
        digest: group.digest, scopeIntent: frozen(structuredClone(group.scopeIntent || null)) };
      const guard = Object.freeze({ basis: facts.basis, preview: facts.preview,
        scopeIntent: facts.scopeIntent,
        requestedChannelIds: Object.freeze(group.channels.map((channel) => channel.channelId)),
        get postSaveResourceVersions() { return frozen(Object.fromEntries([...facts.saved].map(([id, saved]) => [id, { ...saved.version }]))); } });
      group.guard = guard;
      guardFacts.set(guard, facts);
    }
    previews.set(previewId, value);
    return value;
  }

  function registerBatchPreview(input, groups, retryInput) {
    return registerPreview(groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [...group.requestedGroupIds],
      selectionIds: [...group.selectionIds], channels: structuredClone(group.channels), basis: structuredClone(group.basis),
      preview: structuredClone(group.preview), roles: structuredClone(group.roles), scopeIntent: group.scopeIntent,
      digest: batchGroupDigest(input, group) })), retryInput);
  }

  function batchGroupDigest(input, group) {
    return hash([input.requestId, input.ownStationId,
      input.selections.filter((selection) => group.selectionIds.includes(selection.selectionId)).sort((a, b) => a.selectionId.localeCompare(b.selectionId)),
      input.groups.filter((entry) => group.requestedGroupIds.includes(entry.groupId)).sort((a, b) => a.groupId.localeCompare(b.groupId))]);
  }

  function recordBatchSave(guard, selectionId, role, item, station, credentialUpdated = false) {
    const facts = guardFacts.get(guard), target = facts?.roles.find((entry) => entry.selectionId === selectionId && entry.role === role);
    if (!target || !["primary", "dedicated"].includes(role) || facts.roles.some((entry) => entry.role === "additional" && entry.stationId === station.id)
        || target.stationId && target.stationId !== station.id || target.type !== station.type
        || !sameIdentity(target.identity, item.identity) && (target.identity || item.identity)
        || item.identity && !sameIdentity(station.verifiedIdentity, item.identity)) {
      throw previewFailure("PREVIEW_BASIS_CHANGED", "保存目标与原预览的身份或用途不一致，请重新预览");
    }
    facts.saved.set(station.id, { selectionId, role, identity: item.identity, credentialUpdated,
      version: { authVersion: station.authVersion || 1, resourceVersion: stationBusinessVersion(station) } });
  }

  async function list() {
    const station = own(), allRules = await rules(), upstreams = resources();
    const channels = catalogue?.ownStationId === station?.id ? catalogue.channels : [];
    return {
      ownStation: publicOnboardingStation(station), upstreams: upstreams.map(publicOnboardingStation), rules: allRules,
      channels: channels.map((channel) => {
        const monitorLinks = links.filter((link) => link.ownStationId === station.id && link.channelId === Number(channel.id)
          && rt.store.get(link.stationId) && rt.store.get(link.stationId).monitorEnabled !== false && !rt.store.get(link.stationId).archivedAt);
        const relatedRules = allRules.filter((rule) => rule.enabled && !rule.archivedAt && rule.ownStationId === station.id
          && rule.channels.some((member) => Number(member.channelId) === Number(channel.id)));
        const needsReview = channel.missing || monitorLinks.some((link) => link.channelRevision !== channel.revision);
        return { ...channel,
          candidates: upstreams.filter((candidate) => onboardingBaseUrl(candidate.baseUrl)
            && onboardingBaseUrl(candidate.baseUrl) === onboardingBaseUrl(channel.baseUrl)).map((candidate) => candidate.id),
          monitor: { status: needsReview ? "review_required" : monitorLinks.length ? "linked" : "unlinked",
            stationIds: monitorLinks.map((link) => link.stationId) },
          reconciliation: { status: relatedRules.some((rule) => inspectSource(rule).status !== "confirmed") ? "review_required"
            : relatedRules.length ? "configured" : "unconfigured", ruleIds: relatedRules.map((rule) => rule.id) },
        };
      }),
      syncedAt: catalogue?.syncedAt || null, stale: stale(), error: syncError,
    };
  }

  async function sync() {
    if (rt._channelOnboardingSync) return rt._channelOnboardingSync;
    const pending = (async () => {
      const station = own();
      if (!station) { syncError = "请先配置我的 New API 站点"; return list(); }
      const resourceVersion = stationBusinessVersion(station), connection = structuredClone(station);
      try {
        const ownSource = ownSourceIdentity(connection, await queryIdentity(connection));
        connection.userId ||= ownSource.accountId;
        const channels = await queryChannels(connection);
        const nextChannels = channels.map((channel) => ({
          id: Number(channel.id), name: String(channel.name || ""), type: channel.type, status: channel.status,
          baseUrl: channel.baseUrl, groups: channel.groups || [], revision: revisionOf(ownSource.namespaceKey, channel), missing: false,
        }));
        await withSourceLock(null, () => stationLock([station.id], async () => {
          if (stationBusinessVersion(own()) !== resourceVersion) throw new Error("本站授权在同步期间发生变化，请重试");
          const previous = catalogue?.ownSource?.namespaceKey === ownSource.namespaceKey ? catalogue.channels : [];
          const ids = new Set(nextChannels.map((channel) => channel.id));
          const value = { ownStationId: station.id, ownSource, sourceVersion: ownVersion(station, ownSource), syncedAt: now(),
            totalValidated: channels.totalValidated === true, catalogueTotal: channels.catalogueTotal ?? null,
            channels: [...nextChannels, ...previous.filter((channel) => !ids.has(channel.id))
              .map((channel) => channels.totalValidated === true ? { ...channel, missing: true } : channel)] };
          await repository.saveCatalogue(value);
          catalogue = value;
          syncError = null;
          rt._reconciliationResultCache?.clear();
          delete rt._ownChannelsCache;
        }));
      } catch (error) { syncError = failure(error, [connection]); }
      return list();
    })().finally(() => { rt._channelOnboardingSync = null; });
    rt._channelOnboardingSync = pending;
    return pending;
  }

  async function verify(connection, existing = null) {
    const version = existing ? authVersion(existing) : null;
    const resourceVersion = existing ? stationBusinessVersion(existing) : null;
    const expectedAuthVersion = existing?.authVersion || 1;
    const copy = structuredClone(connection);
    let metadata = null, metadataError = null, identity = null;
    if (ACCOUNT_TYPES.includes(copy.type)) {
      try { identity = await queryIdentity(copy); } catch (error) {
        metadataError = new Error(failure(error, [connection, copy]));
      }
      if (identity && existing?.verifiedIdentity && !sameIdentity(identity, existing.verifiedIdentity)) {
        throw Object.assign(new Error("资源的实际账号身份已变化，请重新确认关联"), { code: "ACCOUNT_IDENTITY_CHANGED" });
      }
      try { metadata = await queryMetadata(copy); } catch (error) {
        metadataError = new Error(failure(error, [connection, copy]));
      }
      if (metadata && identity && !sameIdentity(identity, accountIdentity(copy, metadata))) {
        throw Object.assign(new Error("账号身份在验证期间发生变化，请重新验证"), { code: "ACCOUNT_IDENTITY_CHANGED" });
      }
      if (metadata && !identity) {
        metadata = null;
        metadataError = new Error("账号身份未核验或在验证期间发生变化，请重新验证");
      }
    }
    if (!metadata) {
      const previous = structuredClone(copy);
      try {
        const observation = await queryMonitor(copy);
        if (!observation.result?.ok) throw new Error(observation.result?.error || metadataError);
      } catch (error) { throw new Error(failure(error, [connection, previous, copy])); }
    }
    return { connection: copy, existing, version, resourceVersion, expectedAuthVersion, metadata, metadataError, identity };
  }

  async function resolveCandidate(item, purpose) {
    if (!item || item.existing) return;
    const candidates = resources().filter((candidate) => (purpose !== "monitor" || candidate.monitorEnabled !== false)
      && onboardingBaseUrl(candidate.baseUrl) === onboardingBaseUrl(item.connection.baseUrl)
      && (item.connection.type === "newapi-key" ? candidate.type === "newapi-key"
        : ACCOUNT_TYPES.includes(candidate.type) && candidate.type.startsWith("sub2api") === item.connection.type.startsWith("sub2api")));
    const matches = [];
    let unknown = candidates.length > 0 && item.connection.type !== "newapi-key" && !item.identity;
    for (const candidate of candidates) {
      const basis = { version: authVersion(candidate), resourceVersion: stationBusinessVersion(candidate),
        expectedAuthVersion: candidate.authVersion || 1 };
      let identity = null;
      if (candidate.type === "newapi-key") {
        if (!sameCredentials(candidate, item.connection)) continue;
      } else {
        try { identity = await queryIdentity(structuredClone(candidate)); } catch { unknown = true; continue; }
        if (!item.identity || !sameIdentity(identity, item.identity)) continue;
        if (candidate.verifiedIdentity && !sameIdentity(candidate.verifiedIdentity, identity)) {
          throw Object.assign(new Error("旧资源的实际账号身份已变化，请重新确认关联"), { code: "ACCOUNT_IDENTITY_CHANGED" });
        }
      }
      if (authVersion(rt.store.get(candidate.id)) !== basis.version
          || stationBusinessVersion(rt.store.get(candidate.id)) !== basis.resourceVersion) {
        throw Object.assign(new Error("候选资源配置已变化，请重新验证"), { code: "AUTHORIZATION_CHANGED" });
      }
      matches.push({ candidate, candidateIdentity: identity, ...basis });
    }
    if (matches.length > 1 || !matches.length && unknown) {
      throw Object.assign(new Error("旧资源身份尚无法唯一确认，请明确选择资源并核验"), { code: "IDENTITY_CONFLICT" });
    }
    if (matches.length) Object.assign(item, matches[0]);
  }

  async function prepareBatchSelection(selection, requested) {
    const selected = selection.stationId ? rt.store.get(selection.stationId) : null;
    if (selection.stationId && (!selected || selected.archivedAt || selected.isOwn || !TYPES.includes(selected.type)
        || selection.monitor && selected.monitorEnabled === false)) throw new Error("所选资源不存在或用途不匹配");
    const main = await verify(selected || connectionInput(selection.newStation, { authorization: !selection.monitor }), selected);
    const additional = [];
    for (const id of selection.additionalMonitorStationIds.filter((id) => id !== selected?.id)) {
      const station = rt.store.get(id);
      if (!station || station.archivedAt || station.isOwn || station.monitorEnabled === false || !TYPES.includes(station.type)) throw new Error("额外监控资源不可用");
      const item = await verify(station, station);
      if (main.identity && item.identity && !sameIdentity(main.identity, item.identity)) throw new Error("额外监控资源属于不同账号");
      additional.push(item);
    }
    let billing = null, billingError = null;
    if (requested) {
      const authorization = selection.reconciliationAuthorization;
      try {
        if (authorization?.stationId) {
          const station = rt.store.get(authorization.stationId);
          if (!station || station.archivedAt || station.isOwn || !ACCOUNT_TYPES.includes(station.type)) throw new Error("账单授权不存在");
          billing = station.id === selected?.id ? main : await verify(station, station);
        } else if (authorization?.newAuthorization) {
          if (main.connection.type !== "newapi-key") throw new Error("只有独立 Key 监控可以新增专用账号授权");
          billing = await verify(connectionInput(authorization.newAuthorization, { authorization: true }));
        } else if (ACCOUNT_TYPES.includes(main.connection.type)) billing = main;
      } catch (error) { billingError = failure(error, [authorization?.newAuthorization, rt.store.get(authorization?.stationId)]); }
    }
    if (main.identity && billing?.identity && !sameIdentity(main.identity, billing.identity)) throw new Error("监控和账单授权属于不同账号");
    await resolveCandidate(main, selection.monitor ? "monitor" : "authorization");
    if (billing && billing !== main) await resolveCandidate(billing, "authorization");
    for (const item of [main, ...additional, billing].filter(Boolean)) {
      const station = reusable(item);
      if (station && stationBusinessVersion(rt.store.get(station.id)) !== item.resourceVersion) {
        throw previewFailure("PREVIEW_BASIS_CHANGED", "验证期间资源配置已变化，请重新预览");
      }
    }
    return { main, additional, billing, billingError };
  }

  const resourceVersionOf = (station) => ({ authVersion: station.authVersion || 1, resourceVersion: stationBusinessVersion(station) });
  const accountKeyOf = (identity) => identity ? hash([identity.provider, onboardingBaseUrl(identity.baseUrl), String(identity.accountId)]) : null;

  function resultGroup(group) {
    return { groupId: group.groupId, requestedGroupIds: [...group.requestedGroupIds], canonicalKey: group.reconciliation?.canonicalKey || group.canonicalKey || null,
      complete: false, monitor: { status: "pending", stationIds: [] },
      reconciliation: { status: group.reconciliationRequested ? "pending" : "not_requested" },
      channels: group.channels.map((channel) => ({ ...channel, complete: false, stationIds: [], ruleId: null, remainingActions: [] })),
      saved: { stationIds: [], authorizationStationId: null, links: [], ruleId: null, scopeVersion: null, billingEffectiveFromMs: null }, remainingActions: [] };
  }

  function finishGroup(result, actions = []) {
    result.remainingActions = [...new Set(actions)];
    result.complete = !result.remainingActions.length;
    for (const channel of result.channels) {
      channel.complete = result.complete;
      channel.stationIds = [...result.monitor.stationIds];
      channel.ruleId = result.saved.ruleId;
      channel.remainingActions = [...result.remainingActions];
      if (result.code) channel.code = result.code;
      if (result.reason) channel.reason = result.reason;
    }
    return result;
  }

  function publicBatchStation(station, identity, allRules) {
    if (!station) return null;
    const balance = station.balance && { ...station.balance,
      ...(station.balance.error ? { error: failure(station.balance.error, [station]) } : {}) };
    return { id: station.id || null, name: station.name || "上游账号", type: station.type, baseUrl: station.baseUrl,
      monitorEnabled: station.monitorEnabled !== false, archivedAt: station.archivedAt || null,
      authVersion: station.authVersion || 1, resourceVersion: station.id ? stationBusinessVersion(station) : null,
      identity: identity || null, verification: identity ? "verified" : "unverified",
      purposes: { monitor: station.monitorEnabled !== false, billingRuleIds: allRules.filter((rule) => rule.enabled && !rule.archivedAt && rule.upstreamStationId === station.id).map((rule) => rule.id) },
      balance: balance || null, lowBalanceUsd: station.lowBalanceUsd ?? null, cnyPerUsd: station.cnyPerUsd ?? null,
      includeInProfit: station.includeInProfit !== false, noRenewal: !!station.noRenewal,
      hasAccessToken: !!station.accessToken, hasApiKey: !!station.apiKey, hasPassword: !!station.password };
  }

  function groupResources(group, prepared) {
    const versions = {}, roles = [];
    const source = own();
    if (source) versions[source.id] = resourceVersionOf(source);
    for (const id of group.selectionIds) {
      const value = prepared.get(id);
      if (!value?.main) continue;
      for (const [role, item] of [["primary", value.main], ["dedicated", value.billing === value.main ? null : value.billing]]) {
        if (!item) continue;
        const station = reusable(item);
        if (station) versions[station.id] = { authVersion: item.expectedAuthVersion, resourceVersion: item.resourceVersion };
        roles.push({ selectionId: id, role, stationId: station?.id || null,
          type: station && !value.selection.updateCredentials ? station.type : item.connection.type, identity: item.identity,
          credentialUpdateRequested: !!station && value.selection.updateCredentials && !sameCredentials(station, item.connection) });
      }
      for (const item of value.additional) {
        versions[item.existing.id] = { authVersion: item.expectedAuthVersion, resourceVersion: item.resourceVersion };
        roles.push({ selectionId: id, role: "additional", stationId: item.existing.id, type: item.existing.type, identity: item.identity });
      }
    }
    return { versions, roles };
  }

  function monitorGroupProof(group, source, versions) {
    const ids = group.channels.map((channel) => channel.channelId).sort((a, b) => a - b);
    return { basis: { ownSource: source.ownSource, sourceVersion: source.sourceVersion,
      channelRevisions: Object.fromEntries(group.channels.map((channel) => [channel.channelId, channel.channelRevision])),
      resourceVersions: versions, accountIdentity: null, canonicalKey: null, tokenId: null, keyVersion: null,
      existingRuleId: null, existingScopeVersion: null, existingChannelIds: [], proposedChannelIds: ids,
      timezone: group.reconciliation?.timezone || "Asia/Shanghai", billingEffectiveFromMs: null,
      coverageDeclaration: group.reconciliation?.coverageDeclaration || { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] } },
    preview: { costCoverage: group.reconciliation?.coverageDeclaration.answer === "none" ? "complete" : "unknown",
      billingEffectiveFromMs: null, firstQueryableAtMs: null, scopeChanged: false } };
  }

  async function batchProbeState(input, { register = true } = {}) {
    const source = getSourceCatalogue(), sourceStationVersion = stationBusinessVersion(own());
    if (!source.ownSource) throw previewFailure("CHANNEL_CATALOGUE_STALE", "请先同步并核验本站渠道来源");
    const prepared = new Map(), allRules = await rules();
    for (const selection of input.selections) {
      try {
        const value = await prepareBatchSelection(selection, input.groups.some((group) => group.selectionId === selection.selectionId && group.reconciliation));
        prepared.set(selection.selectionId, { ...value, selection });
      } catch (error) {
        prepared.set(selection.selectionId, { selection, error: previewFailure(error.code || "VERIFICATION_FAILED",
          failure(error, [selection.newStation, selection.reconciliationAuthorization?.newAuthorization, rt.store.get(selection.stationId), own()])) });
      }
    }
    const rawGroups = [];
    for (const requested of input.groups) {
      const value = prepared.get(requested.selectionId), group = { ...requested, canonicalKey: null, ownNamespaceKey: source.ownSource.namespaceKey,
        authorizationIntent: null, status: requested.reconciliation ? "unavailable" : "monitor_only" };
      try {
        if (value.error) throw value.error;
        for (const channel of requested.channels) sourceChannel({ ownStationId: input.ownStationId, ...channel });
        if (stationBusinessVersion(own()) !== sourceStationVersion || sourceVersion() !== source.sourceVersion) {
          throw previewFailure("PREVIEW_BASIS_CHANGED", "验证期间本站来源已变化，请重新预览");
        }
        if (requested.reconciliation) {
          const billing = value.billing;
          group.status = billingStatus(billing, true).status;
          if (value.billingError) group.reason = value.billingError;
          else if (group.status !== "ready") group.reason = billingStatus(billing, true).reason;
          const token = billing?.metadata?.tokens?.find((item) => Number(item.id) === requested.reconciliation.tokenId);
          if (token && billing.connection.type.startsWith("sub2api") && billing.metadata.capability?.state === "unverified") {
            try {
              const observation = await queryStat(structuredClone(billing.connection), { token, metadata: billing.metadata,
                ...completedBillingDayWindow(requested.reconciliation.timezone || "Asia/Shanghai", now()) });
              billing.metadata.capability = observation.capability || { state: "unverified", reason: "DEPLOYMENT_NOT_VERIFIED" };
              group.status = billingStatus(billing, true).status;
              group.reason = billingStatus(billing, true).reason;
            } catch (error) { group.reason = failure(error, [billing.connection]); }
          }
          if (token && billing.identity) group.intentCanonicalKey = canonicalBillingKey(billing.connection, billing.metadata, token.id);
          if (group.status === "ready" && token && billing.identity) {
            group.canonicalKey = group.intentCanonicalKey;
            const existing = allRules.find((rule) => rule.enabled && !rule.archivedAt && rule.canonicalKey === group.canonicalKey);
            group.reconciliation = { ...requested.reconciliation, timezone: requested.reconciliation.timezone || existing?.timezone || "Asia/Shanghai" };
            const authorization = value.selection.reconciliationAuthorization;
            group.authorizationIntent = authorization?.stationId || value.selection.stationId && !authorization?.newAuthorization
              ? null : hash(onboardingConnectionPatch(billing.connection));
          } else if (group.status === "ready") {
            group.status = "unavailable"; group.code = "KEY_REQUIRED"; group.reason = "请选择实际使用的上游 Key";
          }
        }
      } catch (error) { group.status = "unavailable"; group.code = error.code || "VERIFICATION_FAILED"; group.reason = failure(error); }
      rawGroups.push(group);
    }
    const partition = new Map();
    for (const group of rawGroups) {
      const key = group.canonicalKey && `${group.ownNamespaceKey}:${group.canonicalKey}` || `group:${group.groupId}`;
      if (!partition.has(key)) partition.set(key, []);
      partition.get(key).push(group);
    }
    const groups = [];
    for (const values of partition.values()) {
      try { groups.push(...coalesceVerifiedBatchGroups(values)); }
      catch (error) { groups.push(...values.map((group) => ({ ...group, requestedGroupIds: [group.groupId], selectionIds: [group.selectionId],
        status: "unavailable", code: "GROUP_CONFLICT", reason: failure(error) }))); }
    }
    for (const group of groups) {
      const { versions, roles } = groupResources(group, prepared);
      group.roles = roles;
      Object.assign(group, monitorGroupProof(group, source, versions));
      if (group.status === "ready" && group.reconciliation) {
        try {
          const value = prepared.get(group.selectionIds[0]), billing = value.billing;
          const financial = await rt.reconciliation.previewKeyScope({ upstreamStationId: reusable(billing)?.id || null,
            tokenId: group.reconciliation.tokenId, salesChannelIds: group.channels.map((channel) => channel.channelId),
            timezone: group.reconciliation.timezone, coverageDeclaration: group.reconciliation.coverageDeclaration,
            costCoverage: group.reconciliation.coverageDeclaration.answer === "none" ? "complete" : "unknown", ownSource: source.ownSource },
          { authorization: { station: { ...structuredClone(billing.connection), id: reusable(billing)?.id || null,
            authVersion: billing.expectedAuthVersion || 1 }, metadata: structuredClone(billing.metadata) } });
          group.basis = { ...financial.basis, resourceVersions: { ...financial.basis.resourceVersions, ...versions } };
          group.preview = financial.preview; group.existingRule = financial.existingRule;
        } catch (error) {
          group.status = error.code === "BILLING_CAPABILITY_UNVERIFIED" ? "unverified" : "unavailable";
          group.code = error.code || "FINANCIAL_PREVIEW_FAILED"; group.reason = failure(error, [prepared.get(group.selectionIds[0])?.billing?.connection, own()]);
        }
      }
      if (group.status === "ready" && group.reconciliation) {
        group.scopeIntent = normalizeReconciliationScopeIntent("append", group.basis.existingRuleId, {
          tokenId: group.reconciliation.tokenId, salesChannelIds: group.channels.map((channel) => channel.channelId),
          timezone: group.basis.timezone, coverageDeclaration: group.basis.coverageDeclaration,
        }, { timezone: group.basis.timezone, enabled: group.existingRule?.enabled ?? true });
      }
    }
    const retryInput = { requestId: input.requestId, source: { ownStationId: input.ownStationId, ownSource: source.ownSource, sourceVersion: source.sourceVersion },
      selections: input.selections.map((selection) => {
        const value = prepared.get(selection.selectionId), main = value.main, station = reusable(main), billing = value.billing;
        return { selectionId: selection.selectionId, stationId: station?.id || selection.stationId || null,
          type: main ? station && !selection.updateCredentials ? station.type : main.connection.type : selection.newStation?.type || rt.store.get(selection.stationId)?.type || "newapi",
          baseUrl: main?.connection.baseUrl || selection.newStation?.baseUrl || rt.store.get(selection.stationId)?.baseUrl || "",
          monitor: selection.monitor, additionalMonitorStationIds: [...selection.additionalMonitorStationIds], accountIdentity: main?.identity || null,
          authorizationStationId: reusable(billing)?.id || null, authorizationIdentity: billing?.identity || null,
          credentialUpdateRequested: selection.updateCredentials && [main, billing].filter(Boolean)
            .some((item) => reusable(item) && !sameCredentials(reusable(item), item.connection)) };
      }),
      groups: groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [...group.requestedGroupIds], selectionIds: [...group.selectionIds],
        channels: structuredClone(group.channels), reconciliationRequested: !!group.reconciliation,
        reconciliation: group.intentCanonicalKey && group.reconciliation?.tokenId ? { canonicalKey: group.intentCanonicalKey,
          tokenId: group.reconciliation.tokenId, timezone: group.basis.timezone, coverageDeclaration: group.basis.coverageDeclaration,
          previewEffectiveFromMs: group.preview.billingEffectiveFromMs } : null })) };
    const record = register ? registerBatchPreview(input, groups, retryInput) : null;
    const output = { requestId: input.requestId, previewId: record?.previewId || null, expiresAtMs: record?.expiresAtMs || null,
      source: { ownSource: source.ownSource, sourceVersion: source.sourceVersion, resourceVersion: sourceStationVersion },
      selections: input.selections.map((selection) => {
        const value = prepared.get(selection.selectionId), primary = reusable(value.main), authorization = reusable(value.billing);
        return { selectionId: selection.selectionId, station: publicBatchStation(primary || value.main?.connection, value.main?.identity, allRules),
          monitor: { status: value.error ? "unavailable" : "verified", ...(value.error ? { reason: value.error.message } : {}) },
          authorizationStationId: authorization?.id || null, accountIdentity: value.main?.identity || null, tokens: safeTokens(value.billing?.metadata?.tokens),
          credentialUpdateRequired: !!primary && !sameCredentials(primary, value.main.connection) || !!authorization && !sameCredentials(authorization, value.billing.connection) };
      }),
      groups: groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [...group.requestedGroupIds], selectionIds: [...group.selectionIds],
        requestedChannelIds: group.channels.map((channel) => channel.channelId), status: group.status,
        ...(group.reason ? { reason: group.reason } : {}), ...(group.code ? { code: group.code } : {}), basis: group.basis, preview: group.preview })), retryInput };
    return { input, prepared, groups, record, output };
  }

  async function probeBatch(input) {
    return (await batchProbeState(normalizeBatchInput(input))).output;
  }

  async function probeRuleEdit(id, input) {
    const existing = (await rules()).find((rule) => rule.id === id && !rule.archivedAt);
    if (!existing) throw previewFailure("RULE_NOT_FOUND", "规则不存在或已归档");
    const source = getSourceCatalogue(), sourceConnection = structuredClone(own());
    const upstream = structuredClone(rt.store.get(existing.upstreamStationId));
    const versions = Object.fromEntries([sourceConnection, upstream].filter(Boolean).map((station) => [station.id, stationBusinessVersion(station)]));
    const originalRule = (rule) => hash([rule.id, rule.upstreamStationId, rule.ownStationId, rule.tokenId, rule.scopeVersion,
      rule.channels.map((channel) => channel.channelId).sort((a, b) => a - b), rule.timezone, rule.enabled,
      rule.canonicalKey, rule.ownSource, rule.sourceBinding, rule.costCoverage, rule.coverageDeclaration, rule.billingEffectiveFrom]);
    try {
      const scopeIntent = normalizeReconciliationScopeIntent("replace", id, input, existing);
      const financial = await rt.reconciliation.previewKeyScope(scopeIntent.normalizedPutIntent, { replaceRuleId: id });
      const latest = (await rules()).find((rule) => rule.id === id && !rule.archivedAt);
      if (!latest || originalRule(existing) !== originalRule(financial.existingRule) || originalRule(existing) !== originalRule(latest)
          || getSourceCatalogue().stale || sourceVersion() !== source.sourceVersion
          || Object.entries(versions).some(([stationId, version]) => stationBusinessVersion(rt.store.get(stationId)) !== version)) {
        throw previewFailure("PREVIEW_BASIS_CHANGED", "规则、来源或授权在验证期间变化，请重新预览");
      }
      const groupId = "rule-edit";
      const record = registerPreview([{ groupId, requestedGroupIds: [groupId], selectionIds: [], roles: [],
        channels: financial.basis.proposedChannelIds.map((channelId) => ({ channelId, channelRevision: financial.basis.channelRevisions[channelId] })),
        basis: financial.basis, preview: financial.preview, scopeIntent, digest: hash(scopeIntent) }]);
      return { previewId: record.previewId, groupId, expiresAtMs: record.expiresAtMs,
        existingRule: financial.existingRule, basis: financial.basis, preview: financial.preview };
    } catch (error) {
      throw previewFailure(error.code || "RULE_PREVIEW_FAILED", failure(error, [sourceConnection, upstream, own(), rt.store.get(existing.upstreamStationId)]));
    }
  }

  function currentGroupContext(group, guard, latestRule) {
    if (group.status === "ready" && latestRule?.enabled === false) throw previewFailure("PREVIEW_BASIS_CHANGED", "原财务规则已停用，请重新预览");
    const source = getSourceCatalogue(), ids = [...new Set([...(latestRule?.channels || []).map((channel) => Number(channel.channelId)),
      ...group.channels.map((channel) => channel.channelId)])].sort((a, b) => a - b);
    const channelRevisions = {};
    for (const id of ids) {
      const channel = source.channels.find((item) => item.id === id);
      if (!channel || channel.missing) throw previewFailure("PREVIEW_BASIS_CHANGED", "完整渠道范围的来源已变化，请重新预览");
      channelRevisions[id] = channel.revision;
    }
    const resourceVersions = Object.fromEntries([...new Set([...Object.keys(guard.basis.resourceVersions),
      ...Object.keys(guard.postSaveResourceVersions)])].sort().map((id) => [id, resourceVersionOf(rt.store.get(id) || {})]));
    const basis = { ...group.basis, ownSource: source.ownSource, sourceVersion: source.sourceVersion, channelRevisions, resourceVersions };
    if (group.status !== "ready" || !group.reconciliation) return { basis, preview: group.preview, postSaveResourceVersions: guard.postSaveResourceVersions };
    const policy = applyScopePolicy(latestRule, { ...latestRule, channels: ids.map((channelId) => ({ channelId })), timezone: group.basis.timezone,
      tokenId: group.basis.tokenId, canonicalKey: group.basis.canonicalKey, ownSource: source.ownSource, sourceBinding: channelRevisions,
      costCoverage: group.preview.costCoverage, coverageDeclaration: group.basis.coverageDeclaration }, now(), { append: !!latestRule });
    Object.assign(basis, { existingRuleId: latestRule?.id || null, existingScopeVersion: latestRule?.scopeVersion || null,
      existingChannelIds: (latestRule?.channels || []).map((channel) => Number(channel.channelId)).sort((a, b) => a - b),
      proposedChannelIds: ids, billingEffectiveFromMs: latestRule?.billingEffectiveFrom ?? null,
      timezone: policy.timezone, coverageDeclaration: policy.coverageDeclaration });
    return { basis, preview: { costCoverage: policy.costCoverage, billingEffectiveFromMs: policy.billingEffectiveFrom,
      firstQueryableAtMs: policy.billingEffectiveFrom == null ? null : nextBillingEffectiveFrom(policy.timezone, policy.billingEffectiveFrom),
      scopeChanged: policy.scopeChanged }, postSaveResourceVersions: guard.postSaveResourceVersions };
  }

  async function persistBatchItem(item, selection, role, guard, assertCurrent) {
    let station = reusable(item), saved = false, credentialUpdated = false;
    if (station) {
      if (station.archivedAt || station.isOwn || role === "primary" && selection.monitor && station.monitorEnabled === false) throw new Error("资源用途已变化");
      const protectedAdditional = guardFacts.get(guard).roles.some((entry) => entry.role === "additional" && entry.stationId === station.id);
      const options = { verifiedIdentity: item.identity, expectedAuthVersion: item.expectedAuthVersion,
        expectedResourceVersion: item.resourceVersion, guard: assertCurrent };
      if (selection.updateCredentials && !sameCredentials(station, item.connection)) {
        if (protectedAdditional) throw previewFailure("PREVIEW_BASIS_CHANGED", "额外监控资源不能随主授权保存一起修改");
        if (!sameIdentity(item.candidateIdentity || item.identity, item.identity)) throw new Error("更新授权必须属于同一账号");
        station = await rt.store.updateLocked(station.id, onboardingConnectionPatch(item.connection), options);
        saved = true; credentialUpdated = true;
      } else if (item.identity && !sameIdentity(station.verifiedIdentity, item.identity) && !protectedAdditional) {
        station = await rt.store.updateLocked(station.id, {}, options);
        saved = true;
      }
    } else {
      const monitor = role === "primary" && selection.monitor;
      station = await rt.store.add({ ...item.connection, monitorEnabled: monitor, includeInProfit: monitor && item.connection.includeInProfit !== false, isOwn: false },
        { verifiedIdentity: item.identity, guard: assertCurrent, onboardingOrigin: { requestId: selection.requestId,
          selectionId: selection.selectionId, accountKey: accountKeyOf(item.identity), type: item.connection.type, purpose: monitor ? "monitor" : "billing" } });
      saved = true;
    }
    return { station, saved, credentialUpdated, item, role, selectionId: selection.selectionId };
  }

  async function connectBatchNow(rawInput) {
    const input = normalizeBatchInput(rawInput), financialRequested = input.groups.some((group) => group.reconciliation);
    const sourceConnection = structuredClone(own());
    expirePreviews();
    const original = input.previewId && previews.get(input.previewId);
    if (original && !original.retryInput) throw previewFailure("PREVIEW_REQUIRED", "规则编辑预览不能用于批量接入，请重新预览");
    if (financialRequested && !original && !input.previewId) throw previewFailure("PREVIEW_REQUIRED", "财务接入需要当前服务端预览，请先验证后确认");
    const state = await batchProbeState(input, { register: !original && !financialRequested });
    const record = original || state.record;
    if (!record) {
      const recovered = await recoverBatch(state.output.retryInput);
      if (recovered.complete) return recovered;
      for (const result of recovered.groups) if (!result.complete) {
        result.code = "PREVIEW_REQUIRED";
        finishGroup(result, [...result.remainingActions, "repreview"]);
      }
      return recovered;
    }
    const retryInput = structuredClone(record.retryInput), recovered = await recoverBatch(retryInput);
    const results = [], savedSelections = new Map(), newAccounts = new Map();
    const saveItem = async (item, selection, role, guard, assertCurrent) => {
      const key = !reusable(item) && item.identity ? hash([accountKeyOf(item.identity), role === "primary" && selection.monitor,
        item.connection.type, onboardingConnectionPatch(item.connection)]) : null;
      if (key && newAccounts.has(key)) return { ...newAccounts.get(key), item, role, selectionId: selection.selectionId };
      const saved = await persistBatchItem(item, selection, role, guard, assertCurrent);
      if (key) newAccounts.set(key, saved);
      return saved;
    };
    const noteSave = (saved) => {
      if (!saved.saved) return;
      for (const proof of record.groups) {
        const facts = guardFacts.get(proof.guard);
        for (const target of facts.roles.filter((entry) => ["primary", "dedicated"].includes(entry.role)
          && (entry.selectionId === saved.selectionId && entry.role === saved.role || entry.stationId === saved.station.id))) {
          if (!facts.roles.some((entry) => entry.role === "additional" && entry.stationId === saved.station.id)) {
            recordBatchSave(proof.guard, target.selectionId, target.role, saved.item, saved.station, saved.credentialUpdated);
          }
        }
      }
    };
    for (const group of state.groups) {
      const originalGroup = record.groups.find((entry) => entry.requestedGroupIds.includes(group.groupId)), result = resultGroup({ ...group, reconciliationRequested: !!group.reconciliation });
      const values = group.selectionIds.map((id) => state.prepared.get(id)), updatesRequested = values.some((value) => value.selection.updateCredentials
        && [value.main, value.billing].filter(Boolean).some((item) => reusable(item) && !sameCredentials(reusable(item), item.connection)));
      const recoveredGroup = recovered.groups.find((entry) => entry.requestedGroupIds.includes(group.groupId));
      if (recoveredGroup?.code === "CREDENTIAL_UPDATE_UNCONFIRMED" && originalGroup) {
        const facts = guardFacts.get(originalGroup.guard), targets = facts.roles.filter((role) => role.credentialUpdateRequested);
        if (targets.length && targets.every((target) => [...facts.saved.entries()].some(([id, saved]) => saved.credentialUpdated
            && (id === target.stationId || saved.selectionId === target.selectionId && saved.role === target.role)
            && hash(saved.version) === hash(resourceVersionOf(rt.store.get(id) || {}))))) {
          delete recoveredGroup.code; delete recoveredGroup.reason;
          finishGroup(recoveredGroup, recoveredGroup.remainingActions.filter((action) => action !== "repreview"));
        }
      }
      if (recoveredGroup?.complete && !updatesRequested && originalGroup && originalGroup.digest === batchGroupDigest(input, originalGroup)) {
        results.push(recoveredGroup); continue;
      }
      if (recoveredGroup && originalGroup?.digest === batchGroupDigest(input, originalGroup)) {
        result.saved = structuredClone(recoveredGroup.saved);
        result.monitor = structuredClone(recoveredGroup.monitor);
        result.reconciliation = structuredClone(recoveredGroup.reconciliation);
      }
      const actions = [];
      let authorization = null, latestRule = null, guard = originalGroup?.guard;
      try {
        if (!originalGroup || originalGroup.digest !== batchGroupDigest(input, originalGroup)
            || hash([...originalGroup.requestedGroupIds].sort()) !== hash([...group.requestedGroupIds].sort())) {
          throw previewFailure("PREVIEW_BASIS_CHANGED", "本组选择或使用范围与原预览不同，请重新预览");
        }
        if (values.some((value) => value.error) || group.code === "GROUP_CONFLICT") {
          throw previewFailure(group.code || values.find((value) => value.error).error.code, group.reason || "资源验证失败");
        }
        const ids = [...new Set([...Object.keys(guard.basis.resourceVersions), ...Object.keys(guard.postSaveResourceVersions)])];
        await withSourceLock(null, () => stationLock(ids, async () => {
          const currentRules = await rules();
          latestRule = currentRules.find((rule) => rule.id === group.basis.existingRuleId)
            || currentRules.find((rule) => rule.enabled && !rule.archivedAt && rule.canonicalKey === group.basis.canonicalKey) || null;
          const assertCurrent = () => assertPreviewGuard(guard, currentGroupContext(group, guard, latestRule));
          assertCurrent();
          if (values.some((value) => !value.selection.updateCredentials && [value.main, value.billing].filter(Boolean)
              .some((item) => reusable(item) && !sameCredentials(reusable(item), item.connection)))) {
            throw previewFailure("AUTHORIZATION_UPDATE_REQUIRED", "旧资源授权与本次输入不同，请明确确认更新授权");
          }
          const newlyCreatedIds = [];
          for (const value of values) {
            const selection = { ...value.selection, requestId: input.requestId };
            let saved = savedSelections.get(selection.selectionId);
            if (!saved) {
              const primary = await saveItem(value.main, selection, "primary", guard, assertCurrent);
              noteSave(primary);
              saved = { primary, billing: value.billing === value.main ? primary : null };
              savedSelections.set(selection.selectionId, saved);
              if (!guard.basis.resourceVersions[primary.station.id]) newlyCreatedIds.push(primary.station.id);
            }
            if (selection.monitor && !result.saved.stationIds.includes(saved.primary.station.id)) result.saved.stationIds.push(saved.primary.station.id);
            if (group.reconciliation && value.billing && !saved.billing) {
              const billing = await saveItem(value.billing, selection, "dedicated", guard, assertCurrent);
              noteSave(billing); saved.billing = billing;
              if (!guard.basis.resourceVersions[billing.station.id]) newlyCreatedIds.push(billing.station.id);
            }
            if (group.reconciliation && saved.billing && !authorization) authorization = saved.billing.station;
            for (const extra of value.additional) if (!result.saved.stationIds.includes(extra.existing.id)) result.saved.stationIds.push(extra.existing.id);
            if (authorization) result.saved.authorizationStationId = authorization.id;
            assertCurrent();
          }
          const monitorIds = [...result.saved.stationIds], linksToSave = group.channels.flatMap((channel) => monitorIds.map((stationId) => ({ ownStationId: input.ownStationId,
            channelId: channel.channelId, stationId, channelRevision: channel.channelRevision, confirmedAt: now() })));
          // Newly published IDs are locked too, before the whole link transaction starts.
          await stationLock(newlyCreatedIds, async () => {
            assertCurrent();
            const confirmed = await repository.saveLinks(linksToSave, { guard: assertCurrent });
            const replaced = new Set(confirmed.map((link) => JSON.stringify([link.ownStationId, link.channelId, link.stationId])));
            links = [...links.filter((link) => !replaced.has(JSON.stringify([link.ownStationId, link.channelId, link.stationId]))), ...confirmed];
            result.saved.links = confirmed;
            result.monitor = { status: monitorIds.length ? "linked" : "not_requested", stationIds: monitorIds };
          });
        }));
        for (const id of result.saved.stationIds) Promise.resolve(refresh(rt, rt.store.get(id))).catch(() => {});
        if (group.reconciliation) {
          if (group.code === "KEY_REQUIRED" || !group.reconciliation.tokenId) actions.push("select_key");
          else if (group.status !== "ready" || !authorization) {
            result.reconciliation = { status: ["unverified", "unsupported", "unavailable"].includes(group.status) ? group.status : "unavailable", reason: group.reason };
            actions.push(["GROUP_CONFLICT", "RULE_DISABLED", "PREVIEW_BASIS_CHANGED"].includes(group.code) ? "repreview" : "verify_capability");
          } else {
            // The financial service owns its source → Store → Repository locks.
            assertPreviewGuard(guard, currentGroupContext(group, guard, latestRule));
            const confirmation = { ownSource: guard.basis.ownSource, sourceBinding: guard.basis.channelRevisions,
              coverageDeclaration: guard.basis.coverageDeclaration, costCoverage: guard.preview.costCoverage,
              timezone: guard.basis.timezone, previewEffectiveFromMs: guard.preview.billingEffectiveFromMs };
            const rule = group.basis.existingRuleId
              ? await rt.reconciliation.appendChannels(group.basis.existingRuleId, group.channels.map((channel) => channel.channelId), confirmation, { previewGuard: guard })
              : await rt.reconciliation.createRule({ upstreamStationId: authorization.id, tokenId: group.reconciliation.tokenId,
                salesChannelIds: group.channels.map((channel) => channel.channelId), ...confirmation }, { previewGuard: guard });
            result.saved.ruleId = rule.id; result.saved.scopeVersion = rule.scopeVersion; result.saved.billingEffectiveFromMs = rule.billingEffectiveFrom;
            result.saved.authorizationStationId = rule.upstreamStationId;
            result.reconciliation = { status: "configured", ruleId: rule.id, scopeVersion: rule.scopeVersion, billingEffectiveFromMs: rule.billingEffectiveFrom };
          }
        }
      } catch (error) {
        if (!error.code && guard) {
          try { assertPreviewGuard(guard, currentGroupContext(group, guard, latestRule)); }
          catch (changed) { error = changed; }
        }
        result.code = error.code || "ONBOARDING_FAILED";
        result.reason = failure(error, [sourceConnection, own(), ...values.flatMap((value) => [value.main?.connection, value.billing?.connection])]);
        if (error.nextPreview) result.nextPreview = error.nextPreview;
        else if (error.code === "EFFECTIVE_PREVIEW_CHANGED") result.nextPreview = { billingEffectiveFromMs: error.billingEffectiveFrom,
          timezone: group.basis.timezone, proposedChannelIds: group.basis.proposedChannelIds, coverageDeclaration: group.basis.coverageDeclaration };
        actions.push(error.code === "AUTHORIZATION_UPDATE_REQUIRED" ? "verify_identity"
          : ["PREVIEW_REQUIRED", "PREVIEW_BASIS_CHANGED", "EFFECTIVE_PREVIEW_CHANGED", "GROUP_CONFLICT"].includes(error.code) ? "repreview"
            : updatesRequested ? "repreview"
          : result.monitor.status === "linked" || result.monitor.status === "not_requested" ? "retry_rule"
            : result.saved.stationIds.length ? "retry_links" : "supply_credentials");
        if (result.monitor.status === "pending") result.monitor.status = "unavailable";
        if (group.reconciliation && result.reconciliation.status !== "configured") {
          result.reconciliation = { ...result.reconciliation, status: result.reconciliation.status === "pending" ? "unavailable" : result.reconciliation.status,
            reason: result.reason };
        }
      }
      results.push(finishGroup(result, actions));
    }
    return { requestId: input.requestId, complete: results.every((result) => result.complete), groups: results, retryInput };
  }

  function connectBatch(input) {
    const pending = (rt._channelOnboardingConnect || Promise.resolve()).then(() => connectBatchNow(input));
    rt._channelOnboardingConnect = pending.catch(() => {});
    return pending;
  }

  async function recoverBatch(rawIntent) {
    const intent = normalizeBatchRecoveryIntent(rawIntent);
    const persistedLinks = await repository.listLinks(), allRules = await (rt.reconciliation?.listRules?.({ includeArchived: true }) || []);
    const stations = rt.store.list({ includeArchived: true, includeUnmonitored: true }), verified = new Map();
    const currentSource = getSourceCatalogue();
    let sourceMatches = !currentSource.stale && currentSource.ownSource?.namespaceKey === intent.source.ownSource.namespaceKey
      && own()?.id === intent.source.ownStationId;
    try {
      const identity = ownSourceIdentity(own(), await queryIdentity(structuredClone(own())));
      sourceMatches &&= identity.namespaceKey === intent.source.ownSource.namespaceKey;
    } catch { sourceMatches = false; }
    async function verifySaved(station) {
      if (!verified.has(station.id)) verified.set(station.id, (async () => {
        const version = stationBusinessVersion(station), copy = structuredClone(station);
        try {
          const identity = ACCOUNT_TYPES.includes(copy.type) ? await queryIdentity(copy) : null;
          if (station.verifiedIdentity && identity && !sameIdentity(station.verifiedIdentity, identity)) return null;
          if (copy.type === "newapi-key" && !(await queryMonitor(copy)).result?.ok) return null;
          if (stationBusinessVersion(rt.store.get(station.id)) !== version) return null;
          return { station, identity, connection: copy };
        } catch { return null; }
      })());
      return verified.get(station.id);
    }
    const recovered = new Map();
    for (const selection of intent.selections) {
      const selectedChannels = intent.groups.filter((group) => group.selectionIds.includes(selection.selectionId)).flatMap((group) => group.channels);
      async function locate(purpose, expectedIdentity, explicitId, primary = false) {
        const candidates = stations.filter((station) => !station.archivedAt && !station.isOwn
          && (purpose !== "monitor" || station.monitorEnabled !== false)
          && (primary ? (station.type === selection.type || selection.credentialUpdateRequested && explicitId
            && station.type.startsWith("sub2api") && selection.type.startsWith("sub2api"))
            && onboardingBaseUrl(station.baseUrl) === selection.baseUrl : ACCOUNT_TYPES.includes(station.type))
          && (!explicitId || station.id === explicitId));
        const matches = [];
        for (const station of candidates) {
          const item = await verifySaved(station);
          if (!item || expectedIdentity && !sameIdentity(item.identity, expectedIdentity)) continue;
          const marker = station.onboardingOrigin;
          const origin = marker?.requestId === intent.requestId && marker.selectionId === selection.selectionId
            && marker.type === station.type && marker.purpose === purpose && marker.accountKey === accountKeyOf(item.identity);
          const related = selectedChannels.every((channel) => persistedLinks.some((link) => link.ownStationId === intent.source.ownStationId
            && link.channelId === channel.channelId && link.channelRevision === channel.channelRevision && link.stationId === station.id));
          if (station.type === "newapi-key" && !explicitId && !origin) continue;
          if (!explicitId && !origin && !related && primary && !expectedIdentity) continue;
          matches.push({ ...item, origin, related });
        }
        const original = matches.filter((item) => item.origin);
        const related = matches.filter((item) => item.related);
        const chosen = original.length ? original : related.length ? related : matches.filter((item) => explicitId || expectedIdentity || !primary);
        if (chosen.length > 1) throw previewFailure("IDENTITY_CONFLICT", "已保存资源身份不唯一，请明确选择并核验");
        return chosen[0] || null;
      }
      try {
        const primary = await locate(selection.monitor ? "monitor" : "billing", selection.accountIdentity, selection.stationId, true);
        if (primary && ACCOUNT_TYPES.includes(primary.station.type) && !selection.accountIdentity) {
          recovered.set(selection.selectionId, { error: previewFailure("LEGACY_IDENTITY_UNVERIFIED", "原账号身份未核验，请重新验证") });
          continue;
        }
        const additional = [];
        for (const id of selection.additionalMonitorStationIds) {
          const station = rt.store.get(id), item = station && await verifySaved(station);
          if (!item || station.archivedAt || station.isOwn || station.monitorEnabled === false
              || selection.accountIdentity && item.identity && !sameIdentity(item.identity, selection.accountIdentity)) throw new Error("额外监控资源待核验");
          additional.push(item);
        }
        let billing = null;
        if (selection.authorizationIdentity) {
          billing = primary && sameIdentity(primary.identity, selection.authorizationIdentity)
            && (!selection.authorizationStationId || selection.authorizationStationId === primary.station.id) ? primary
            : await locate("billing", selection.authorizationIdentity, selection.authorizationStationId);
        }
        recovered.set(selection.selectionId, { primary, additional, billing });
      } catch (error) { recovered.set(selection.selectionId, { error }); }
    }
    const results = [];
    for (const group of intent.groups) {
      const result = resultGroup(group), actions = [], selected = group.selectionIds.map((id) => [intent.selections.find((item) => item.selectionId === id), recovered.get(id)]);
      const monitorIds = [], billing = [];
      for (const [selection, value] of selected) {
        if (value?.error) { result.code = value.error.code || "IDENTITY_UNVERIFIED"; result.reason = failure(value.error); actions.push("verify_identity"); continue; }
        if (!value?.primary) { actions.push(selection.type === "newapi-key" ? "verify_identity" : "supply_credentials"); continue; }
        if (selection.monitor) monitorIds.push(value.primary.station.id);
        monitorIds.push(...value.additional.map((item) => item.station.id));
        if (value.billing) billing.push(value.billing);
      }
      const ids = [...new Set(monitorIds)];
      result.saved.stationIds = ids;
      const expectedMonitor = selected.some(([selection]) => selection.monitor || selection.additionalMonitorStationIds.length);
      const sourceValid = sourceMatches && group.channels.every((member) => currentSource.channels.some((channel) => channel.id === member.channelId
        && !channel.missing && channel.revision === member.channelRevision));
      if (!sourceValid) { result.code = "PREVIEW_BASIS_CHANGED"; actions.push("repreview"); }
      const related = persistedLinks.filter((link) => link.ownStationId === intent.source.ownStationId && ids.includes(link.stationId)
        && group.channels.some((channel) => channel.channelId === link.channelId && channel.channelRevision === link.channelRevision));
      result.saved.links = related;
      const linked = !actions.includes("verify_identity") && !actions.includes("supply_credentials") && group.channels.every((channel) => ids.every((id) => related.some((link) => link.channelId === channel.channelId && link.stationId === id)));
      result.monitor = { status: !expectedMonitor ? "not_requested" : linked && ids.length ? "linked" : "pending", stationIds: ids };
      if (expectedMonitor && !linked && ids.length) actions.push("retry_links");
      if (billing.length) result.saved.authorizationStationId = billing[0].station.id;
      if (group.reconciliationRequested) {
        if (!group.reconciliation) actions.push("select_key");
        else if (!billing.length) actions.push("supply_credentials");
        else {
          const bill = group.reconciliation;
          try {
            const owner = billing[0], metadata = await queryMetadata(structuredClone(owner.connection));
            if (!sameIdentity(owner.identity, accountIdentity(owner.connection, metadata)) || !metadata.tokens.some((token) => Number(token.id) === bill.tokenId)
                || canonicalBillingKey(owner.station, metadata, bill.tokenId) !== bill.canonicalKey) throw new Error("原财务 Key 身份待核验");
            const matches = allRules.filter((rule) => !rule.archivedAt && rule.enabled && rule.canonicalKey === bill.canonicalKey
              && rule.ownStationId === intent.source.ownStationId && rule.ownSource?.namespaceKey === intent.source.ownSource.namespaceKey
               && rule.tokenId === bill.tokenId && rule.timezone === bill.timezone && inspectSource(rule).status === "confirmed"
              && hash(rule.coverageDeclaration) === hash(bill.coverageDeclaration)
              && (bill.previewEffectiveFromMs == null || rule.billingEffectiveFrom === bill.previewEffectiveFromMs)
              && group.channels.every((channel) => rule.channels.some((member) => Number(member.channelId) === channel.channelId)
                && rule.sourceBinding?.[channel.channelId] === channel.channelRevision));
            if (matches.length === 1 && sourceValid) {
              const rule = matches[0], actual = rt.store.get(rule.upstreamStationId), actualIdentity = actual && await verifySaved(actual);
              if (!actualIdentity || !sameIdentity(actualIdentity.identity, owner.identity)) throw new Error("规则原授权身份待核验");
              result.saved.ruleId = rule.id; result.saved.scopeVersion = rule.scopeVersion;
              result.saved.billingEffectiveFromMs = rule.billingEffectiveFrom;
              result.reconciliation = { status: "configured", ruleId: rule.id, scopeVersion: rule.scopeVersion, billingEffectiveFromMs: rule.billingEffectiveFrom };
              result.saved.authorizationStationId = actual.id;
            } else actions.push("retry_rule");
          } catch { actions.push("verify_capability"); result.reconciliation.status = "unavailable"; }
        }
      }
      if (selected.some(([selection]) => selection.credentialUpdateRequested)) {
        result.code = "CREDENTIAL_UPDATE_UNCONFIRMED";
        result.reason = "关联已保存，授权更新结果尚未确认，请重新预览";
        actions.push("repreview");
      }
      results.push(finishGroup(result, actions));
    }
    return { requestId: intent.requestId, complete: results.every((result) => result.complete), groups: results, retryInput: intent };
  }

  function billingStatus(item, requested) {
    if (!requested) return { status: "not_requested" };
    if (!item) return { status: "unavailable", reason: "请在同一入口补充账号账单授权" };
    if (!item.metadata) return { status: "unavailable", reason: failure(item.metadataError, [item.connection]) };
    const capability = item.metadata.capability?.state || "unverified";
    return { status: capability === "supported" ? "ready" : capability,
      reason: capability === "supported" ? null : item.metadata.capability?.reason || "账单能力尚未验证" };
  }

  function singleBatchInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw previewFailure("INVALID_REQUEST", "接入请求格式无效");
    const previous = input.previewId && previews.get(input.previewId);
    const requestId = input.requestId || previous?.retryInput?.requestId || randomUUID();
    const authorization = input.reconciliation;
    const selection = { selectionId: "primary", monitor: true, stationId: input.stationId, newStation: input.newStation,
      additionalMonitorStationIds: input.additionalMonitorStationIds || [], updateCredentials: input.updateCredentials === true };
    if (authorization?.upstreamStationId || authorization?.newAuthorization) selection.reconciliationAuthorization = {
      stationId: authorization.upstreamStationId, newAuthorization: authorization.newAuthorization };
    return { requestId, ownStationId: input.ownStationId, selections: [selection],
      groups: [{ groupId: input.groupId || "single", selectionId: "primary",
        channels: [{ channelId: Number(input.channelId), channelRevision: input.channelRevision }],
        reconciliation: authorization ? { tokenId: authorization.tokenId == null ? undefined : Number(authorization.tokenId),
          timezone: authorization.timezone, coverageDeclaration: authorization.coverageDeclaration
            || { answer: authorization.costCoverage === "complete" ? "none" : "unknown", otherUse: null, uncoveredOwnChannelIds: [] } } : null }],
      ...(input.previewId ? { previewId: input.previewId } : {}) };
  }

  async function probe(input) {
    const result = await probeBatch(singleBatchInput(input)), selection = result.selections[0], group = result.groups[0];
    if (selection.monitor.status === "unavailable") throw previewFailure(group.code || "ONBOARDING_FAILED", selection.monitor.reason);
    if (["CHANNEL_CATALOGUE_STALE", "CHANNEL_SOURCE_CHANGED", "PREVIEW_BASIS_CHANGED"].includes(group.code)) {
      throw previewFailure(group.code, group.reason);
    }
    return { requestId: result.requestId, previewId: result.previewId, groupId: group.groupId, expiresAtMs: result.expiresAtMs,
      station: selection.station, monitor: selection.monitor,
      reconciliation: { status: input.reconciliation ? group.code === "KEY_REQUIRED" ? "ready" : group.status : "not_requested",
        reason: group.reason || null, tokens: selection.tokens, upstreamStationId: selection.authorizationStationId,
        existingRuleId: group.basis.existingRuleId, existingChannelIds: group.basis.existingChannelIds },
      preview: { ...group.preview, timezone: group.basis.timezone }, channelRevision: input.channelRevision,
      credentialUpdateRequired: selection.credentialUpdateRequired, batchRetryInput: result.retryInput };
  }

  async function connect(input) {
    if (input?.reconciliation && !input.previewId) throw previewFailure("PREVIEW_REQUIRED", "财务接入需要当前服务端预览，请先验证后确认");
    const result = await connectBatch(singleBatchInput(input)), group = result.groups[0];
    if (!group.saved.stationIds.length && group.monitor.status === "unavailable" && group.reason
        && !["PREVIEW_REQUIRED", "PREVIEW_BASIS_CHANGED", "EFFECTIVE_PREVIEW_CHANGED"].includes(group.code)) {
      throw previewFailure(group.code || "ONBOARDING_FAILED", group.reason);
    }
    const retryInput = { requestId: result.requestId, ownStationId: input.ownStationId, channelId: Number(input.channelId),
      channelRevision: input.channelRevision, stationId: group.saved.stationIds[0] || input.stationId,
      additionalMonitorStationIds: input.additionalMonitorStationIds || [] };
    if (input.reconciliation) retryInput.reconciliation = { upstreamStationId: group.saved.authorizationStationId || input.reconciliation.upstreamStationId,
      tokenId: input.reconciliation.tokenId, timezone: input.reconciliation.timezone || "Asia/Shanghai",
      costCoverage: input.reconciliation.costCoverage || "unknown", coverageDeclaration: input.reconciliation.coverageDeclaration,
      previewEffectiveFromMs: result.retryInput.groups[0].reconciliation?.previewEffectiveFromMs ?? null };
    return { complete: group.complete, monitor: group.monitor, reconciliation: group.reconciliation,
      saved: { ...group.saved, link: group.saved.links }, retryInput, batchRetryInput: result.retryInput,
      ...(group.code ? { code: group.code } : {}), ...(group.nextPreview ? { preview: { ...group.nextPreview,
        costCoverage: input.reconciliation?.costCoverage || "unknown" } } : {}) };
  }

  return { list, sync, probe, connect, inspectSource, getRuleSource: inspectSource, getSourceCatalogue, withSourceLock,
    getPreviewGuard, assertPreviewGuard, probeBatch, connectBatch, recoverBatch, probeRuleEdit,
    async load() { [catalogue, links] = await Promise.all([repository.getCatalogue(), repository.listLinks()]); return this; } };
}

export async function startChannelOnboarding(rt, dependencies = {}) {
  if (rt.channelOnboarding) return rt.channelOnboarding;
  if (!rt._channelOnboardingStart) rt._channelOnboardingStart = (async () => {
    const module = await createChannelOnboardingModule(rt, dependencies).load();
    rt.channelOnboarding = module;
    rt.onboardingSource = module;
    if (!rt._channelOnboardingTimer) {
      rt._channelOnboardingTimer = setInterval(() => module.sync().catch(() => {}), 5 * 60000);
      rt._channelOnboardingTimer.unref?.();
    }
    module.sync().catch(() => {});
    return module;
  })().catch((error) => { rt._channelOnboardingStart = null; throw error; });
  return rt._channelOnboardingStart;
}
