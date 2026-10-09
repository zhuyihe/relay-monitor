import { createHash } from "node:crypto";
import { queryNewApiReconciliationMetadata, queryReconciliationMetadata, queryKeyReconciliationStat, queryOwnChannels, queryStation } from "../lib/providers.js";
import { describeConnectionFailure } from "../lib/connection-test.js";
import { onboardingBaseUrl, publicOnboardingStation } from "../lib/channel-onboarding.js";
import { nextBillingEffectiveFrom, completedBillingDayWindow } from "../lib/reconciliation-scope-policy.js";
import { ChannelOnboardingRepository } from "./channel-onboarding-repository.js";
import { refreshStation } from "./refresh.js";

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
const ownVersion = (station) => station ? hash([station.id, authVersion(station), station.isOwn, station.archivedAt]) : null;
const revisionOf = (ownId, channel) => hash([ownId, Number(channel.id), channel.type, onboardingBaseUrl(channel.baseUrl) || channel.baseUrl]);

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
  return first.type === second.type && onboardingBaseUrl(first.baseUrl) === onboardingBaseUrl(second.baseUrl)
    && authFields.filter((field) => !["type", "baseUrl"].includes(field)).every((field) =>
      String(first[field] || "") === String(second[field] || ""));
}

function safeTokens(tokens = []) {
  return tokens.map((token) => ({ id: token.id, name: token.name, status: token.status, group: token.group,
    crossGroupRetry: !!token.crossGroupRetry, maskedKey: /[*•]/.test(token.maskedKey || "") ? token.maskedKey : "" }));
}

function failure(error, connections = []) {
  let reason = String(error?.message || error || "接入失败");
  for (const connection of connections) reason = describeConnectionFailure(reason, connection).diagnostic;
  return reason;
}

export function createChannelOnboardingModule(rt, dependencies = {}) {
  const repository = dependencies.repository || new ChannelOnboardingRepository(rt.pool);
  const queryChannels = dependencies.queryChannels || queryOwnChannels;
  const queryMetadata = dependencies.queryMetadata || queryReconciliationMetadata;
  const queryStat = dependencies.queryStat || queryKeyReconciliationStat;
  const queryMonitor = dependencies.queryMonitor || queryStation;
  const refresh = dependencies.refresh || refreshStation;
  const now = dependencies.now || Date.now;
  let catalogue = null, links = [], syncError = null;
  const own = () => rt.store.list().find((station) => station.isOwn && station.type === "newapi") || null;
  const resources = () => rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && TYPES.includes(station.type));
  const reusable = (item, purpose = "authorization") => item && (item.existing || resources().find((candidate) =>
    (purpose !== "monitor" || candidate.monitorEnabled !== false)
    && (sameIdentity(candidate.verifiedIdentity, item.identity) || sameCredentials(candidate, item.connection))));
  const stale = () => !catalogue || catalogue.ownStationId !== own()?.id || catalogue.sourceVersion !== ownVersion(own())
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
    if (!Object.keys(rule.sourceBinding || {}).length) return { version: "legacy", status: "confirmed", issues: [] };
    const station = own();
    const entries = (rule.channels || []).map((member) => {
      const id = Number(member.channelId);
      const channel = catalogue?.channels?.find((item) => Number(item.id) === id);
      return [id, rule.sourceBinding[id] || null, channel?.revision || null, !!channel?.missing];
    }).sort(([a], [b]) => a - b);
    const available = !!station && rule.ownStationId === station.id && catalogue?.ownStationId === station.id
      && catalogue.sourceVersion === ownVersion(station) && !stale();
    const confirmed = available && entries.every(([, binding, revision, missing]) => binding && binding === revision && !missing);
    const status = !available ? "unavailable" : confirmed ? "confirmed" : "review_required";
    return { version: hash([ownVersion(station), catalogue?.sourceVersion || null, entries]), status,
      issues: confirmed ? [] : [{ code: "SOURCE_BINDING_UNCONFIRMED", detail: "渠道来源已变化或待核对，当前金额仅供参考" }] };
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
      const version = ownVersion(station), connection = structuredClone(station);
      try {
        const channels = await queryChannels(connection);
        const nextChannels = channels.map((channel) => ({
          id: Number(channel.id), name: String(channel.name || ""), type: channel.type, status: channel.status,
          baseUrl: channel.baseUrl, groups: channel.groups || [], revision: revisionOf(station.id, channel), missing: false,
        }));
        await withSourceLock(null, () => stationLock([station.id], async () => {
          if (ownVersion(own()) !== version) throw new Error("本站授权在同步期间发生变化，请重试");
          const previous = catalogue?.ownStationId === station.id ? catalogue.channels : [];
          const ids = new Set(nextChannels.map((channel) => channel.id));
          const value = { ownStationId: station.id, sourceVersion: version, syncedAt: now(),
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
    const copy = structuredClone(connection);
    let metadata = null, metadataError = null;
    if (ACCOUNT_TYPES.includes(copy.type)) {
      try { metadata = await queryMetadata(copy); } catch (error) { metadataError = error; }
    }
    if (!metadata) {
      const observation = await queryMonitor(copy);
      if (!observation.result?.ok) throw new Error(failure(observation.result?.error || metadataError, [copy]));
    }
    return { connection: copy, existing, version,
      metadata, metadataError, identity: accountIdentity(copy, metadata) };
  }

  async function prepare(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("接入请求格式无效");
    if (input.additionalMonitorStationIds != null && !Array.isArray(input.additionalMonitorStationIds)) throw new Error("额外监控资源格式无效");
    const channel = sourceChannel(input);
    if (!!input.stationId === !!input.newStation) throw new Error("请选择已有监控资源或新增资源");
    const selected = input.stationId ? rt.store.get(input.stationId) : null;
    if (input.stationId && (!selected || selected.archivedAt || selected.isOwn || selected.monitorEnabled === false || !TYPES.includes(selected.type))) {
      throw new Error("所选监控资源不存在或不可用于渠道接入");
    }
    const main = await verify(selected || connectionInput(input.newStation), selected);
    const additional = [];
    for (const id of [...new Set(input.additionalMonitorStationIds || [])].filter((id) => id !== selected?.id)) {
      const candidate = rt.store.get(id);
      if (!candidate || candidate.archivedAt || candidate.isOwn || candidate.monitorEnabled === false || !TYPES.includes(candidate.type)) {
        throw new Error("额外监控关联必须选择已有可用资源");
      }
      const extra = await verify(candidate, candidate);
      if (main.identity && extra.identity && !sameIdentity(main.identity, extra.identity)) throw new Error("额外监控资源属于不同上游账号");
      additional.push(extra);
    }
    let billing = null, billingError = null;
    if (input.reconciliation) {
      const selection = input.reconciliation;
      if (selection.upstreamStationId && selection.newAuthorization) throw new Error("请选择已有账单授权或新增授权");
      try { if (selection.upstreamStationId) {
        const candidate = rt.store.get(selection.upstreamStationId);
        if (!candidate || candidate.archivedAt || candidate.isOwn || !ACCOUNT_TYPES.includes(candidate.type)) throw new Error("账单授权不存在");
        billing = candidate.id === selected?.id ? main : await verify(candidate, candidate);
      } else if (selection.newAuthorization) {
        if (main.connection.type !== "newapi-key") throw new Error("仅 Key 监控需要补充独立账号授权");
        billing = await verify(connectionInput(selection.newAuthorization, { authorization: true }));
      } else if (ACCOUNT_TYPES.includes(main.connection.type)) billing = main;
      } catch (error) {
        billingError = failure(error, [selection.newAuthorization, rt.store.get(selection.upstreamStationId)]);
      }
    }
    if (main.identity && billing?.identity && !sameIdentity(main.identity, billing.identity)) throw new Error("监控与账单授权属于不同账号");
    if (billing?.metadata && billing.connection.type.startsWith("sub2api")
        && billing.metadata.capability?.state !== "supported" && billing.metadata.capability?.state !== "unsupported"
        && input.reconciliation?.tokenId != null) {
      const token = billing.metadata.tokens.find((item) => item.id === Number(input.reconciliation.tokenId));
      if (token) {
        try {
          const window = completedBillingDayWindow(input.reconciliation.timezone || "Asia/Shanghai", now());
          const observed = await queryStat(structuredClone(billing.connection), { token, metadata: billing.metadata, ...window });
          billing.metadata.capability = observed.capability || { state: "unverified", reason: "DEPLOYMENT_NOT_VERIFIED" };
        } catch (error) {
          billing.metadata.capability = { state: "unverified", reason: failure(error, [billing.connection]) };
        }
      }
    }
    sourceChannel(input);
    for (const item of [main, ...additional, billing].filter(Boolean)) {
      if (item.existing && authVersion(rt.store.get(item.existing.id)) !== item.version) throw new Error("授权配置已变化，请重新验证");
    }
    return { channel, main, additional, billing, billingError };
  }

  function billingStatus(item, requested) {
    if (!requested) return { status: "not_requested" };
    if (!item) return { status: "unavailable", reason: "请在同一入口补充账号账单授权" };
    if (!item.metadata) return { status: "unavailable", reason: failure(item.metadataError, [item.connection]) };
    const capability = item.metadata.capability?.state || "unverified";
    return { status: capability === "supported" ? "ready" : capability,
      reason: capability === "supported" ? null : item.metadata.capability?.reason || "账单能力尚未验证" };
  }

  async function preview(input, prepared) {
    let existing = null;
    const billingStation = reusable(prepared.billing);
    if (billingStation && input.reconciliation?.tokenId != null && rt.reconciliation?.findRuleForKey) {
      existing = await rt.reconciliation.findRuleForKey(billingStation.id, input.reconciliation.tokenId);
    }
    const timezone = existing?.timezone || input.reconciliation?.timezone || "Asia/Shanghai";
    const coverage = input.reconciliation?.costCoverage === "complete" ? "complete" : "unknown";
    const unchanged = existing && existing.channels.some((member) => Number(member.channelId) === Number(input.channelId))
      && existing.costCoverage === coverage && existing.channels.every((member) => {
        const channel = catalogue.channels.find((item) => item.id === Number(member.channelId));
        return channel && !channel.missing && existing.sourceBinding?.[member.channelId] === channel.revision;
      });
    return { existing, value: { billingEffectiveFromMs: unchanged ? existing.billingEffectiveFrom : nextBillingEffectiveFrom(timezone, now()),
      costCoverage: coverage, timezone } };
  }

  async function probe(input) {
    const prepared = await prepare(input);
    const result = billingStatus(prepared.billing, !!input.reconciliation);
    if (prepared.billingError) result.reason = prepared.billingError;
    let proposed;
    try { proposed = await preview(input, prepared); } catch (error) {
      result.status = "unavailable";
      result.reason = failure(error, [prepared.billing?.connection]);
      proposed = { existing: null, value: { billingEffectiveFromMs: nextBillingEffectiveFrom("Asia/Shanghai", now()),
        costCoverage: "unknown", timezone: "Asia/Shanghai" } };
    }
    const candidate = reusable(prepared.main, "monitor"), billingCandidate = reusable(prepared.billing);
    return { station: publicOnboardingStation(prepared.main.existing || candidate || prepared.main.connection),
      monitor: { status: "verified" }, reconciliation: { ...result, tokens: safeTokens(prepared.billing?.metadata?.tokens),
        upstreamStationId: billingCandidate?.id || null, existingRuleId: proposed.existing?.id || null,
        existingChannelIds: (proposed.existing?.channels || []).map((member) => member.channelId) },
      preview: proposed.value, channelRevision: prepared.channel.revision,
      credentialUpdateRequired: !!candidate && !sameCredentials(candidate, prepared.main.connection)
        || !!billingCandidate && !sameCredentials(billingCandidate, prepared.billing.connection),
    };
  }

  async function persist(item, input, purpose = "monitor") {
    let station = reusable(item, purpose);
    if (station) {
      if (station.archivedAt || station.isOwn || purpose === "monitor" && station.monitorEnabled === false) {
        throw new Error("所选资源用途已变化，请重新选择");
      }
      if (item.existing && authVersion(station) !== item.version) throw new Error("授权配置已变化，请重新验证");
      if (input.updateCredentials && !sameCredentials(station, item.connection)) {
        if (!sameIdentity(station.verifiedIdentity, item.identity)) throw new Error("更新授权必须确认同一稳定账号身份");
        const patch = Object.fromEntries(authFields.filter((field) => field in item.connection).map((field) => [field, item.connection[field]]));
        station = await rt.store.update(station.id, patch, { verifiedIdentity: item.identity, expectedAuthVersion: station.authVersion || 1 });
      } else if (item.identity && !sameCredentials(station, item.connection)) {
        const original = await verify(station, station);
        if (!sameIdentity(original.identity, item.identity)) throw new Error("已有授权不可用，请明确确认更新授权");
      } else if (item.identity) {
        station = await rt.store.update(station.id, {}, { verifiedIdentity: item.identity, expectedAuthVersion: station.authVersion || 1 });
      }
      return station;
    }
    station = await rt.store.add({ ...item.connection,
      monitorEnabled: purpose === "monitor", includeInProfit: purpose === "monitor" && item.connection.includeInProfit !== false,
      isOwn: false }, { verifiedIdentity: item.identity });
    return station;
  }

  async function connectNow(input) {
    const prepared = await prepare(input), requested = !!input.reconciliation;
    const result = { complete: false, monitor: { status: "pending", stationIds: [] },
      reconciliation: billingStatus(prepared.billing, requested), saved: { stationIds: [] }, retryInput: {} };
    if (prepared.billingError) result.reconciliation.reason = prepared.billingError;
    const connections = [...[prepared.main, ...prepared.additional, prepared.billing].filter(Boolean).map((item) => item.connection), structuredClone(own())];
    let primary, authorization;
    let billingTimezone = input.reconciliation?.timezone || "Asia/Shanghai";
    try {
      // Network verification precedes the source/Store commit boundaries.
      primary = await persist(prepared.main, input);
      result.saved.stationIds.push(primary.id);
      result.retryInput = { ownStationId: input.ownStationId, channelId: input.channelId,
        channelRevision: input.channelRevision, stationId: primary.id,
        additionalMonitorStationIds: input.additionalMonitorStationIds || [] };
      if (prepared.billing === prepared.main) authorization = primary;
      else if (prepared.billing) {
        authorization = await persist(prepared.billing, input, "authorization");
        result.saved.authorizationStationId = authorization.id;
      }
      if (requested) result.retryInput.reconciliation = {
        upstreamStationId: authorization?.id, tokenId: input.reconciliation.tokenId,
        costCoverage: input.reconciliation.costCoverage || "unknown", timezone: input.reconciliation.timezone || "Asia/Shanghai",
        previewEffectiveFromMs: input.reconciliation.previewEffectiveFromMs,
      };
      const monitorIds = [...new Set([primary.id, ...prepared.additional.map((item) => item.existing.id)])];
      const persistedVersions = [primary, authorization].filter(Boolean).map((station) => [station.id, authVersion(station)]);
      await withSourceLock(null, () => stationLock([input.ownStationId, ...monitorIds, authorization?.id].filter(Boolean), async () => {
        sourceChannel(input);
        for (const [id, version] of persistedVersions) if (authVersion(rt.store.get(id)) !== version) throw new Error("授权配置已变化，请重新验证");
        for (const id of monitorIds) {
          const station = rt.store.get(id);
          if (!station || station.archivedAt || station.isOwn || station.monitorEnabled === false) throw new Error("监控资源用途已变化，请重新选择");
        }
        if (authorization && (authorization.archivedAt || authorization.isOwn)) throw new Error("账单授权用途已变化，请重新选择");
        for (const item of prepared.additional) if (authVersion(rt.store.get(item.existing.id)) !== item.version) throw new Error("额外资源授权已变化");
        const confirmed = await repository.saveLinks(monitorIds.map((stationId) => ({ ownStationId: input.ownStationId,
          channelId: Number(input.channelId), stationId, channelRevision: prepared.channel.revision, confirmedAt: now() })));
        const replaced = new Set(confirmed.map((link) => JSON.stringify([link.ownStationId, link.channelId, link.stationId])));
        links = [...links.filter((link) => !replaced.has(JSON.stringify([link.ownStationId, link.channelId, link.stationId]))), ...confirmed];
        result.saved.link = confirmed;
        result.monitor = { status: "linked", stationIds: monitorIds };
      }));
      for (const id of monitorIds) Promise.resolve(refresh(rt, rt.store.get(id))).catch(() => {});
      if (!requested) { result.complete = true; return result; }
      if (result.reconciliation.status !== "ready") return result;
      if (!authorization || !Number.isSafeInteger(Number(input.reconciliation.tokenId)) || Number(input.reconciliation.tokenId) <= 0) {
        result.reconciliation = { status: "unavailable", reason: "请选择实际使用的上游 Key" };
        return result;
      }
      if (!rt.reconciliation) throw new Error("对账模块尚未就绪，请原地重试");
      // The reconciliation module acquires its own source → Store → rule lock.
      // Never call it while holding our source lock.
      sourceChannel(input);
      const existing = await rt.reconciliation.findRuleForKey(authorization.id, input.reconciliation.tokenId);
      sourceChannel(input);
      billingTimezone = existing?.timezone || billingTimezone;
      result.retryInput.reconciliation.timezone = billingTimezone;
      const ids = [...new Set([...(existing?.channels || []).map((member) => Number(member.channelId)), Number(input.channelId)])];
      const sourceBinding = {};
      for (const id of ids) {
        const channel = catalogue.channels.find((item) => item.id === id);
        if (!channel || channel.missing) throw new Error("原有关联渠道来源待核对，请刷新目录后重新确认");
        sourceBinding[id] = channel.revision;
      }
      const confirmation = { costCoverage: input.reconciliation.costCoverage === "complete" ? "complete" : "unknown", sourceBinding,
        previewEffectiveFromMs: input.reconciliation.previewEffectiveFromMs };
      connections.push(structuredClone(own()));
      const rule = existing ? await rt.reconciliation.appendChannels(existing.id, [Number(input.channelId)], confirmation)
        : await rt.reconciliation.createRule({ upstreamStationId: authorization.id, tokenId: Number(input.reconciliation.tokenId),
          salesChannelIds: [Number(input.channelId)], timezone: billingTimezone, ...confirmation });
      result.saved.ruleId = rule.id;
      result.reconciliation = { status: "configured", ruleId: rule.id, billingEffectiveFromMs: rule.billingEffectiveFrom };
      result.complete = true;
    } catch (error) {
      const target = result.monitor.status === "linked" ? "reconciliation" : "monitor";
      result[target] = { ...result[target], status: "unavailable", reason: failure(error, [...connections, own(), rt.store.get(input.ownStationId)]) };
      if (error.code) result.code = error.code;
      if (error.code === "EFFECTIVE_PREVIEW_CHANGED") result.preview = {
        billingEffectiveFromMs: error.billingEffectiveFrom, timezone: billingTimezone,
        costCoverage: input.reconciliation?.costCoverage || "unknown",
      };
    }
    return result;
  }

  function connect(input) {
    const pending = (rt._channelOnboardingConnect || Promise.resolve()).then(() => connectNow(input));
    rt._channelOnboardingConnect = pending.catch(() => {});
    return pending;
  }

  return { list, sync, probe, connect, inspectSource, getRuleSource: inspectSource, withSourceLock,
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
