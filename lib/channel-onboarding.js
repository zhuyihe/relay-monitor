import { COVERAGE_ANSWERS, coverageAnswerOption } from "./reconciliation-contract.js";

// 地址仅用于提示候选账号；不能凭同名分组或相同域名直接确认成本身份。
export function onboardingBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return ""; }
}

export function groupOnboardingResources(resources, channels) {
  const linkedIds = new Set(channels.flatMap((channel) => channel.monitor?.stationIds || []));
  const candidateIds = new Set(channels.flatMap((channel) => channel.candidates || []).map((candidate) => candidate?.id || candidate));
  const addresses = new Set(channels.map((channel) => onboardingBaseUrl(channel.baseUrl)).filter(Boolean));
  const linked = [], matched = [], others = [];
  for (const resource of resources) {
    if (linkedIds.has(resource.id)) linked.push(resource);
    else if (candidateIds.has(resource.id) || addresses.has(onboardingBaseUrl(resource.baseUrl))) matched.push(resource);
    else others.push(resource);
  }
  return { matched: [...linked, ...matched], others };
}

export function pendingChannelConnections({ channels = [], rules = [], upstreams = [], ownStation = null } = {}) {
  const occupied = new Set(rules.filter((rule) => rule.enabled && !rule.archivedAt && (!ownStation || rule.ownStationId === ownStation.id))
    .flatMap((rule) => (rule.channels || []).map((channel) => Number(channel.channelId))));
  return channels.filter((channel) => !occupied.has(Number(channel.id))).map((channel) => {
    const baseUrl = onboardingBaseUrl(channel.baseUrl);
    return {
      ...channel,
      candidates: baseUrl ? upstreams.filter((station) => station.type === "newapi" && !station.isOwn && !station.archivedAt
        && onboardingBaseUrl(station.baseUrl) === baseUrl) : [],
    };
  });
}

export function channelConnectionRule(rules, ownStationId, upstreamStationId, tokenId) {
  return rules.find((rule) => rule.enabled && !rule.archivedAt && rule.ownStationId === ownStationId
    && rule.upstreamStationId === upstreamStationId && Number(rule.tokenId) === Number(tokenId)) || null;
}

export function publicOnboardingStation(station) {
  if (!station) return null;
  const identity = station.verifiedIdentity;
  return {
    id: station.id || null, name: station.name || "上游账号", type: station.type,
    baseUrl: station.baseUrl, monitorEnabled: station.monitorEnabled !== false,
    identity: identity ? { provider: identity.provider, accountId: identity.accountId } : null,
  };
}

export function onboardingConnectionPatch(connection) {
  const applicable = connection.type === "newapi" ? ["accessToken", "userId"]
    : connection.type === "newapi-key" ? ["apiKey"] : connection.type === "sub2api" ? ["accessToken"] : ["email", "password"];
  return Object.fromEntries(["type", "baseUrl", "accessToken", "userId", "apiKey", "email", "password"].map((field) =>
    [field, ["type", "baseUrl"].includes(field) || applicable.includes(field) ? connection[field] || "" : ""]));
}

// 这里 throw 的文字只给开发看（design/ui-copy-spec.md §12.4），界面按 code 用 lib/error-copy.js 的 describeError 说：
// INVALID_REQUEST 说「页面已过期」，ENDPOINT_MISMATCH 说「连不上这个地址」，GROUP_CONFLICT 说「内容有变化」。
// 原文只进「查看详细原因」给技术同事看，所以 batchId 的 label 直接写字段名。
function batchError(message, code = "INVALID_REQUEST") {
  return Object.assign(new Error(message), { code });
}

// 渠道绑定的两种用途：只关联上游账号看余额，或绑定一把 Key 算利润（§5.6「只看余额」）。
export const ONBOARDING_PURPOSES = Object.freeze({ monitor: "看余额", billing: "算利润" });
// 两种用途一个都没选时的那句话；界面和这里的开发校验共用。
export const ONBOARDING_PURPOSE_REQUIRED = `请选「${ONBOARDING_PURPOSES.monitor}」或「${ONBOARDING_PURPOSES.billing}」`;

// 渠道绑定和改绑定共用的话，两边都从这里取；用语按 design/ui-copy-spec.md。
export const BINDING_COPY = Object.freeze({
  preview: "预览",
  channelRequired: "请至少选一个渠道",
  uncoveredChannels: "还在用这把 Key 但没绑定的渠道",
  // 一次都没读到自营站点的渠道时（§8.1）
  channelsUnreadable: "读不到自营站点的渠道",
});

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function batchId(value, label, max = 64) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw batchError(`${label} 无效`);
  return value.trim();
}

function batchConnection(value, authorization = false) {
  if (!object(value) || !["newapi", "newapi-key", "sub2api", "sub2api-password"].includes(value.type)
      || authorization && value.type === "newapi-key") throw batchError("上游连接类型无效");
  const baseUrl = onboardingBaseUrl(value.baseUrl);
  if (!baseUrl) throw batchError("上游站点根地址无效", "ENDPOINT_MISMATCH");
  const patch = onboardingConnectionPatch({ ...value, baseUrl });
  const result = { type: value.type, baseUrl };
  for (const field of value.type === "newapi" ? ["accessToken", "userId"]
    : value.type === "newapi-key" ? ["apiKey"] : value.type === "sub2api" ? ["accessToken"] : ["email", "password"]) {
    result[field] = field === "password" ? String(patch[field]) : String(patch[field]).trim();
  }
  for (const field of ["name", "cnyPerUsd", "lowBalanceUsd", "noRenewal", "includeInProfit", "costAliases"]) {
    if (field in value) result[field] = value[field];
  }
  return result;
}

// 「去回答」的回答以 COVERAGE_ANSWERS 为准：归一后的 answer / otherUse 必须是表里的一项（other_use 没写 otherUse 的算「说不清是哪」），
// 写了 otherUse 也只能是表里有的值。
export function normalizeCoverageDeclaration(value) {
  const option = object(value) ? coverageAnswerOption(value) : null;
  if (!option || value.otherUse != null && !COVERAGE_ANSWERS.some((item) => item.otherUse === value.otherUse)
      || value.uncoveredOwnChannelIds != null && !Array.isArray(value.uncoveredOwnChannelIds)) throw batchError("Key 使用范围声明无效");
  const ids = (value.uncoveredOwnChannelIds || []).map(Number);
  if (ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw batchError("未覆盖渠道无效");
  return { answer: option.answer, otherUse: option.otherUse, uncoveredOwnChannelIds: [...new Set(ids)].sort((a, b) => a - b) };
}

export function normalizeBatchInput(input) {
  if (!object(input)) throw batchError("提交的内容不完整，请刷新后重新打开");
  if (typeof input.requestId !== "string"
      || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.requestId)) throw batchError("请求标识无效");
  if (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > 100
      || !Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) throw batchError("提交的内容不完整，请刷新后重新打开");
  const ownStationId = batchId(input.ownStationId, "ownStationId", 128), selectionIds = new Set(), groupIds = new Set(), channelGroups = new Map();
  const selections = input.selections.map((value) => {
    if (!object(value) || !!value.stationId === !!value.newStation || typeof value.monitor !== "boolean") throw batchError("资源选择格式无效");
    const selectionId = batchId(value.selectionId, "selectionId");
    if (selectionIds.has(selectionId)) throw batchError("资源选择标识重复");
    selectionIds.add(selectionId);
    const selection = { selectionId, monitor: value.monitor, updateCredentials: value.updateCredentials === true };
    if (value.stationId) selection.stationId = batchId(value.stationId, "stationId", 128);
    else {
      selection.newStation = batchConnection(value.newStation);
      if (!value.monitor && selection.newStation.type === "newapi-key") throw batchError(`只用 Key 的上游要选「${ONBOARDING_PURPOSES.monitor}」`);
    }
    if (value.additionalMonitorStationIds != null && (!Array.isArray(value.additionalMonitorStationIds) || value.additionalMonitorStationIds.length > 100)) throw batchError("额外监控资源格式无效");
    selection.additionalMonitorStationIds = [...new Set((value.additionalMonitorStationIds || []).map((id) => batchId(id, "additionalMonitorStationIds", 128)))].sort();
    if (value.reconciliationAuthorization != null) {
      const authorization = value.reconciliationAuthorization;
      if (!object(authorization) || !!authorization.stationId === !!authorization.newAuthorization) throw batchError("账单授权选择无效");
      selection.reconciliationAuthorization = authorization.stationId ? { stationId: batchId(authorization.stationId, "reconciliationAuthorization.stationId", 128) }
        : { newAuthorization: batchConnection(authorization.newAuthorization, true) };
    }
    return selection;
  });
  const selectionById = new Map(selections.map((selection) => [selection.selectionId, selection]));
  const groups = input.groups.map((value) => {
    if (!object(value) || !Array.isArray(value.channels) || !value.channels.length) throw batchError("渠道分组格式无效");
    const groupId = batchId(value.groupId, "groupId"), selectionId = batchId(value.selectionId, "selectionId");
    if (groupIds.has(groupId) || !selectionIds.has(selectionId)) throw batchError("渠道分组标识重复或资源选择不存在");
    groupIds.add(groupId);
    const unique = new Map();
    for (const channel of value.channels) {
      if (!object(channel) || !Number.isSafeInteger(channel.channelId) || channel.channelId <= 0) throw batchError("渠道标识无效");
      const revision = batchId(channel.channelRevision, "channelRevision", 128);
      if (channelGroups.has(channel.channelId) && channelGroups.get(channel.channelId) !== groupId) throw batchError("同一渠道不能分配给多个分组");
      if (unique.has(channel.channelId) && unique.get(channel.channelId).channelRevision !== revision) throw batchError("渠道版本冲突");
      channelGroups.set(channel.channelId, groupId);
      unique.set(channel.channelId, { channelId: channel.channelId, channelRevision: revision });
    }
    let reconciliation = null;
    if (value.reconciliation != null) {
      if (!object(value.reconciliation)) throw batchError("账单配置格式无效");
      const tokenId = value.reconciliation.tokenId;
      if (tokenId != null && (!Number.isSafeInteger(tokenId) || tokenId <= 0)) throw batchError("实际 Key 标识无效");
      reconciliation = { coverageDeclaration: normalizeCoverageDeclaration(value.reconciliation.coverageDeclaration) };
      if (tokenId != null) reconciliation.tokenId = tokenId;
      if (value.reconciliation.timezone != null) reconciliation.timezone = batchId(value.reconciliation.timezone, "timezone");
    }
    const selection = selectionById.get(selectionId);
    if (!selection.monitor && !selection.additionalMonitorStationIds.length && !reconciliation) throw batchError(ONBOARDING_PURPOSE_REQUIRED);
    return { groupId, selectionId, channels: [...unique.values()].sort((a, b) => a.channelId - b.channelId), reconciliation };
  });
  if (!channelGroups.size || channelGroups.size > 100) throw batchError("一次选 1 到 100 个渠道");
  return { requestId: input.requestId, ownStationId, selections, groups,
    ...(input.previewId ? { previewId: batchId(input.previewId, "previewId", 128) } : {}) };
}

// Only verified canonical Keys may coalesce; panel URLs never identify a financial group.
export function coalesceVerifiedBatchGroups(groups) {
  const result = [], keys = new Map();
  for (const group of groups) {
    const key = group.canonicalKey && `${group.ownNamespaceKey}:${group.canonicalKey}`;
    const previous = key && keys.get(key);
    if (!previous) {
      const value = { ...group, requestedGroupIds: [group.groupId], selectionIds: [group.selectionId], channels: [...group.channels] };
      result.push(value);
      if (key) keys.set(key, value);
      continue;
    }
    if (JSON.stringify(previous.reconciliation) !== JSON.stringify(group.reconciliation)
        || previous.authorizationIntent !== group.authorizationIntent) throw batchError("同一 Key 的使用范围、时区或授权选择冲突", "GROUP_CONFLICT");
    previous.requestedGroupIds.push(group.groupId);
    if (!previous.selectionIds.includes(group.selectionId)) previous.selectionIds.push(group.selectionId);
    previous.channels.push(...group.channels);
    previous.channels.sort((a, b) => a.channelId - b.channelId);
  }
  return result;
}

export function normalizeBatchRecoveryIntent(input) {
  if (!object(input) || typeof input.requestId !== "string"
      || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.requestId)
      || !object(input.source) || !Array.isArray(input.selections) || !input.selections.length || input.selections.length > 100
      || !Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) throw batchError("上次没做完的内容不完整，请刷新后重新打开");
  const identity = (value) => {
    if (value == null) return null;
    const baseUrl = onboardingBaseUrl(value?.baseUrl);
    if (!object(value) || !["newapi", "sub2api"].includes(value.provider) || !baseUrl || !String(value.accountId || "").trim()) throw batchError("恢复账号身份无效");
    return { provider: value.provider, baseUrl, accountId: String(value.accountId).trim() };
  };
  const ownIdentity = identity(input.source.ownSource);
  if (!ownIdentity || ownIdentity.provider !== "newapi") throw batchError("恢复本站来源无效");
  const ownStationId = batchId(input.source.ownStationId, "ownStationId", 128);
  if (input.source.ownSource.stationId !== ownStationId) throw batchError("恢复本站资源与来源不一致");
  const source = { ownStationId, ownSource: { stationId: batchId(input.source.ownSource.stationId, "ownSource.stationId", 128),
    ...ownIdentity, namespaceKey: batchId(input.source.ownSource.namespaceKey, "ownSource.namespaceKey", 128) },
  sourceVersion: batchId(input.source.sourceVersion, "sourceVersion", 128) };
  const selectionIds = new Set(), groupIds = new Set(), channels = new Set();
  const selections = input.selections.map((value) => {
    if (!object(value) || !["newapi", "newapi-key", "sub2api", "sub2api-password"].includes(value.type)
        || !onboardingBaseUrl(value.baseUrl) || typeof value.monitor !== "boolean"
        || !Array.isArray(value.additionalMonitorStationIds)) throw batchError("恢复资源选择无效");
    const selectionId = batchId(value.selectionId, "selectionId");
    if (selectionIds.has(selectionId)) throw batchError("恢复资源选择重复");
    selectionIds.add(selectionId);
    return { selectionId, stationId: value.stationId ? batchId(value.stationId, "stationId", 128) : null,
      type: value.type, baseUrl: onboardingBaseUrl(value.baseUrl), monitor: value.monitor,
      additionalMonitorStationIds: [...new Set(value.additionalMonitorStationIds.map((id) => batchId(id, "additionalMonitorStationIds", 128)))].sort(),
      accountIdentity: identity(value.accountIdentity), authorizationStationId: value.authorizationStationId ? batchId(value.authorizationStationId, "authorizationStationId", 128) : null,
      authorizationIdentity: identity(value.authorizationIdentity), credentialUpdateRequested: value.credentialUpdateRequested === true };
  });
  const groups = input.groups.map((value) => {
    if (!object(value) || !Array.isArray(value.requestedGroupIds) || !value.requestedGroupIds.length
        || !Array.isArray(value.selectionIds) || !value.selectionIds.length || !Array.isArray(value.channels) || !value.channels.length
        || typeof value.reconciliationRequested !== "boolean") throw batchError("恢复渠道分组无效");
    const groupId = batchId(value.groupId, "groupId");
    const requestedGroupIds = value.requestedGroupIds.map((id) => batchId(id, "requestedGroupIds"));
    if (!requestedGroupIds.includes(groupId) || requestedGroupIds.some((id) => groupIds.has(id))) throw batchError("恢复渠道分组重复");
    requestedGroupIds.forEach((id) => groupIds.add(id));
    const selected = [...new Set(value.selectionIds.map((id) => batchId(id, "selectionId")))];
    if (selected.some((id) => !selectionIds.has(id))) throw batchError("恢复资源选择不存在");
    const members = value.channels.map((channel) => {
      if (!object(channel) || !Number.isSafeInteger(channel.channelId) || channel.channelId <= 0 || channels.has(channel.channelId)) throw batchError("恢复渠道标识重复或无效");
      channels.add(channel.channelId);
      return { channelId: channel.channelId, channelRevision: batchId(channel.channelRevision, "channelRevision", 128) };
    });
    let reconciliation = null;
    if (value.reconciliation != null) {
      const bill = value.reconciliation;
      if (!object(bill) || !Number.isSafeInteger(bill.tokenId) || bill.tokenId <= 0
          || bill.previewEffectiveFromMs != null && (!Number.isSafeInteger(bill.previewEffectiveFromMs) || bill.previewEffectiveFromMs < 0)) throw batchError("恢复账单配置无效");
      reconciliation = { canonicalKey: batchId(bill.canonicalKey, "canonicalKey", 128), tokenId: bill.tokenId,
        timezone: batchId(bill.timezone, "timezone"), coverageDeclaration: normalizeCoverageDeclaration(bill.coverageDeclaration),
        previewEffectiveFromMs: bill.previewEffectiveFromMs ?? null };
    }
    return { groupId, requestedGroupIds, selectionIds: selected, channels: members, reconciliationRequested: value.reconciliationRequested, reconciliation };
  });
  if (channels.size > 100 || groupIds.size > 100) throw batchError("恢复请求范围超过 100 个渠道或分组");
  return { requestId: input.requestId, source, selections, groups };
}
