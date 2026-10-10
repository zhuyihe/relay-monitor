// 地址仅用于提示候选账号；不能凭同名分组或相同域名直接确认成本身份。
export function onboardingBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return ""; }
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

function invalidBatch(message) {
  throw Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function batchId(value, label, max = 64) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) invalidBatch(`${label}无效`);
  return value.trim();
}

function batchConnection(value, authorization = false) {
  if (!object(value) || !["newapi", "newapi-key", "sub2api", "sub2api-password"].includes(value.type)
      || authorization && value.type === "newapi-key") invalidBatch("上游连接类型无效");
  const baseUrl = onboardingBaseUrl(value.baseUrl);
  if (!baseUrl) invalidBatch("上游站点根地址无效");
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

export function normalizeCoverageDeclaration(value) {
  if (!object(value) || !["none", "other_use", "unknown"].includes(value.answer)
      || value.otherUse != null && !["own_channels", "external", "unspecified"].includes(value.otherUse)
      || value.uncoveredOwnChannelIds != null && !Array.isArray(value.uncoveredOwnChannelIds)) invalidBatch("Key 使用范围声明无效");
  const ids = (value.uncoveredOwnChannelIds || []).map(Number);
  if (ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) invalidBatch("未覆盖渠道无效");
  return { answer: value.answer, otherUse: value.answer === "other_use" ? value.otherUse || "unspecified" : null,
    uncoveredOwnChannelIds: [...new Set(ids)].sort((a, b) => a - b) };
}

export function normalizeBatchInput(input) {
  if (!object(input) || typeof input.requestId !== "string"
      || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.requestId)
      || !Array.isArray(input.selections) || !input.selections.length || input.selections.length > 100
      || !Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) invalidBatch("批量接入请求格式无效");
  const ownStationId = batchId(input.ownStationId, "本站资源", 128), selectionIds = new Set(), groupIds = new Set(), channelGroups = new Map();
  const selections = input.selections.map((value) => {
    if (!object(value) || !!value.stationId === !!value.newStation || typeof value.monitor !== "boolean") invalidBatch("资源选择格式无效");
    const selectionId = batchId(value.selectionId, "资源选择标识");
    if (selectionIds.has(selectionId)) invalidBatch("资源选择标识重复");
    selectionIds.add(selectionId);
    const selection = { selectionId, monitor: value.monitor, updateCredentials: value.updateCredentials === true };
    if (value.stationId) selection.stationId = batchId(value.stationId, "资源", 128);
    else {
      selection.newStation = batchConnection(value.newStation);
      if (!value.monitor && selection.newStation.type === "newapi-key") invalidBatch("独立 API Key 必须请求监控");
    }
    if (value.additionalMonitorStationIds != null && (!Array.isArray(value.additionalMonitorStationIds) || value.additionalMonitorStationIds.length > 100)) invalidBatch("额外监控资源格式无效");
    selection.additionalMonitorStationIds = [...new Set((value.additionalMonitorStationIds || []).map((id) => batchId(id, "额外监控资源", 128)))].sort();
    if (value.reconciliationAuthorization != null) {
      const authorization = value.reconciliationAuthorization;
      if (!object(authorization) || !!authorization.stationId === !!authorization.newAuthorization) invalidBatch("账单授权选择无效");
      selection.reconciliationAuthorization = authorization.stationId ? { stationId: batchId(authorization.stationId, "账单授权资源", 128) }
        : { newAuthorization: batchConnection(authorization.newAuthorization, true) };
    }
    return selection;
  });
  const groups = input.groups.map((value) => {
    if (!object(value) || !Array.isArray(value.channels) || !value.channels.length) invalidBatch("渠道分组格式无效");
    const groupId = batchId(value.groupId, "渠道分组标识"), selectionId = batchId(value.selectionId, "资源选择标识");
    if (groupIds.has(groupId) || !selectionIds.has(selectionId)) invalidBatch("渠道分组标识重复或资源选择不存在");
    groupIds.add(groupId);
    const unique = new Map();
    for (const channel of value.channels) {
      if (!object(channel) || !Number.isSafeInteger(channel.channelId) || channel.channelId <= 0) invalidBatch("渠道标识无效");
      const revision = batchId(channel.channelRevision, "渠道版本", 128);
      if (channelGroups.has(channel.channelId) && channelGroups.get(channel.channelId) !== groupId) invalidBatch("同一渠道不能分配给多个分组");
      if (unique.has(channel.channelId) && unique.get(channel.channelId).channelRevision !== revision) invalidBatch("渠道版本冲突");
      channelGroups.set(channel.channelId, groupId);
      unique.set(channel.channelId, { channelId: channel.channelId, channelRevision: revision });
    }
    let reconciliation = null;
    if (value.reconciliation != null) {
      if (!object(value.reconciliation)) invalidBatch("账单配置格式无效");
      const tokenId = value.reconciliation.tokenId;
      if (tokenId != null && (!Number.isSafeInteger(tokenId) || tokenId <= 0)) invalidBatch("实际 Key 标识无效");
      reconciliation = { coverageDeclaration: normalizeCoverageDeclaration(value.reconciliation.coverageDeclaration) };
      if (tokenId != null) reconciliation.tokenId = tokenId;
      if (value.reconciliation.timezone != null) reconciliation.timezone = batchId(value.reconciliation.timezone, "时区");
    }
    return { groupId, selectionId, channels: [...unique.values()].sort((a, b) => a.channelId - b.channelId), reconciliation };
  });
  if (!channelGroups.size || channelGroups.size > 100) invalidBatch("每次请选择 1 至 100 个渠道");
  return { requestId: input.requestId, ownStationId, selections, groups,
    ...(input.previewId ? { previewId: batchId(input.previewId, "预览标识", 128) } : {}) };
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
        || previous.authorizationIntent !== group.authorizationIntent) invalidBatch("同一 Key 的使用范围、时区或授权选择冲突");
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
      || !Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) invalidBatch("恢复请求格式无效");
  const identity = (value) => {
    if (value == null) return null;
    const baseUrl = onboardingBaseUrl(value?.baseUrl);
    if (!object(value) || !["newapi", "sub2api"].includes(value.provider) || !baseUrl || !String(value.accountId || "").trim()) invalidBatch("恢复账号身份无效");
    return { provider: value.provider, baseUrl, accountId: String(value.accountId).trim() };
  };
  const ownIdentity = identity(input.source.ownSource);
  if (!ownIdentity || ownIdentity.provider !== "newapi") invalidBatch("恢复本站来源无效");
  const ownStationId = batchId(input.source.ownStationId, "本站资源", 128);
  if (input.source.ownSource.stationId !== ownStationId) invalidBatch("恢复本站资源与来源不一致");
  const source = { ownStationId, ownSource: { stationId: batchId(input.source.ownSource.stationId, "本站来源资源", 128),
    ...ownIdentity, namespaceKey: batchId(input.source.ownSource.namespaceKey, "来源命名空间", 128) },
  sourceVersion: batchId(input.source.sourceVersion, "来源版本", 128) };
  const selectionIds = new Set(), groupIds = new Set(), channels = new Set();
  const selections = input.selections.map((value) => {
    if (!object(value) || !["newapi", "newapi-key", "sub2api", "sub2api-password"].includes(value.type)
        || !onboardingBaseUrl(value.baseUrl) || typeof value.monitor !== "boolean"
        || !Array.isArray(value.additionalMonitorStationIds)) invalidBatch("恢复资源选择无效");
    const selectionId = batchId(value.selectionId, "资源选择标识");
    if (selectionIds.has(selectionId)) invalidBatch("恢复资源选择重复");
    selectionIds.add(selectionId);
    return { selectionId, stationId: value.stationId ? batchId(value.stationId, "资源", 128) : null,
      type: value.type, baseUrl: onboardingBaseUrl(value.baseUrl), monitor: value.monitor,
      additionalMonitorStationIds: [...new Set(value.additionalMonitorStationIds.map((id) => batchId(id, "额外资源", 128)))].sort(),
      accountIdentity: identity(value.accountIdentity), authorizationStationId: value.authorizationStationId ? batchId(value.authorizationStationId, "账单资源", 128) : null,
      authorizationIdentity: identity(value.authorizationIdentity), credentialUpdateRequested: value.credentialUpdateRequested === true };
  });
  const groups = input.groups.map((value) => {
    if (!object(value) || !Array.isArray(value.requestedGroupIds) || !value.requestedGroupIds.length
        || !Array.isArray(value.selectionIds) || !value.selectionIds.length || !Array.isArray(value.channels) || !value.channels.length
        || typeof value.reconciliationRequested !== "boolean") invalidBatch("恢复渠道分组无效");
    const groupId = batchId(value.groupId, "渠道分组标识");
    const requestedGroupIds = value.requestedGroupIds.map((id) => batchId(id, "原分组标识"));
    if (!requestedGroupIds.includes(groupId) || requestedGroupIds.some((id) => groupIds.has(id))) invalidBatch("恢复渠道分组重复");
    requestedGroupIds.forEach((id) => groupIds.add(id));
    const selected = [...new Set(value.selectionIds.map((id) => batchId(id, "资源选择标识")))];
    if (selected.some((id) => !selectionIds.has(id))) invalidBatch("恢复资源选择不存在");
    const members = value.channels.map((channel) => {
      if (!object(channel) || !Number.isSafeInteger(channel.channelId) || channel.channelId <= 0 || channels.has(channel.channelId)) invalidBatch("恢复渠道标识重复或无效");
      channels.add(channel.channelId);
      return { channelId: channel.channelId, channelRevision: batchId(channel.channelRevision, "渠道版本", 128) };
    });
    let reconciliation = null;
    if (value.reconciliation != null) {
      const bill = value.reconciliation;
      if (!object(bill) || !Number.isSafeInteger(bill.tokenId) || bill.tokenId <= 0
          || bill.previewEffectiveFromMs != null && (!Number.isSafeInteger(bill.previewEffectiveFromMs) || bill.previewEffectiveFromMs < 0)) invalidBatch("恢复账单配置无效");
      reconciliation = { canonicalKey: batchId(bill.canonicalKey, "财务 Key", 128), tokenId: bill.tokenId,
        timezone: batchId(bill.timezone, "时区"), coverageDeclaration: normalizeCoverageDeclaration(bill.coverageDeclaration),
        previewEffectiveFromMs: bill.previewEffectiveFromMs ?? null };
    }
    return { groupId, requestedGroupIds, selectionIds: selected, channels: members, reconciliationRequested: value.reconciliationRequested, reconciliation };
  });
  if (channels.size > 100 || groupIds.size > 100) invalidBatch("恢复请求范围超过 100 个渠道或分组");
  return { requestId: input.requestId, source, selections, groups };
}
