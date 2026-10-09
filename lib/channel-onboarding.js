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
