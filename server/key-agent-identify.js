// 认出快照里每个渠道现在用的是哪把 Key（K2a）。只认、只显示：不开段、不改账，K2b 才按认出的结果写分段。
import { fetchKeyAgentSnapshot } from "../lib/key-agent-client.js";
import { identifyChannel } from "../lib/key-agent-match.js";
import { queryNewApiReconciliationMetadata } from "../lib/providers.js";
import { keyAgentConfigOf } from "./key-agent.js";
import { matchCostStations } from "./own-helpers.js";

// 候选上游用地址对（matchCostStations，K1a 改成返回全部最高分候选）；每个候选只读一次 Key 目录（这一轮里共用）；
// Sub2API 的 Key 列表不给 Key 材料，这一版比不了，候选是 Sub2API 时直接跳过。
// 返回 { ok, stale, staleReason, channels: [{ channelId, keyless, slots? }] }；channelIds 给了就只认这几个
export async function identifyChannels(rt, ownStation, { channelIds = null, etag = null, queryMetadata = queryNewApiReconciliationMetadata } = {}) {
  const config = keyAgentConfigOf(ownStation);
  if (!config) return { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" };
  const snapshot = await fetchKeyAgentSnapshot({ url: config.url, token: config.token, etag });
  if (!snapshot.ok) return snapshot;
  if (snapshot.status === 304) return { ok: true, status: 304, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag, channels: null };

  const upstreams = rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && station.type !== "fixed" && !station.archivedAt);
  const tokenListCache = new Map();
  const tokensOf = (station) => {
    if (!tokenListCache.has(station.id)) {
      const promise = station.type === "newapi"
        ? queryMetadata(station, {}).then((metadata) => metadata.tokens).catch(() => null)
        : Promise.resolve(null); // Sub2API：目录不给 Key 材料
      tokenListCache.set(station.id, promise);
    }
    return tokenListCache.get(station.id);
  };

  const channels = [];
  for (const channel of snapshot.channels) {
    if (channelIds && !channelIds.includes(Number(channel.id))) continue;
    if (channel.keyless) { channels.push({ channelId: Number(channel.id), keyless: true }); continue; }
    const candidates = matchCostStations(upstreams, channel.baseUrl).filter((station) => station.type === "newapi");
    const tokenLists = await Promise.all(candidates.map(async (station) => ({ stationId: station.id, tokens: await tokensOf(station) })));
    channels.push(identifyChannel(channel, tokenLists, config.fingerprintKey));
  }
  return { ok: true, status: 200, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag, channels };
}

// 查一次候选上游的 Key 目录要挨个翻页读，不便宜；缓存节奏和读取服务自己的库读节奏一样（k-plan §2.4 的 4 分钟），
// 查询结果（渠道目录等）一请求一次调这个，不会把所有候选上游的 Key 目录在节奏之外重读一遍。
// 304（读取服务那一侧没变）直接沿用上一次认出的结果，连候选上游都不问
export const IDENTIFY_CACHE_MS = 4 * 60 * 1000;
export async function identifyChannelsCached(rt, ownStation, options = {}) {
  const cache = rt._keyAgentIdentifyCache;
  const now = Date.now();
  if (cache && cache.stationId === ownStation.id && now - cache.at < IDENTIFY_CACHE_MS) return cache.result;
  const sameStation = cache?.stationId === ownStation.id;
  const result = await identifyChannels(rt, ownStation, { ...options, etag: sameStation ? cache.etag : null });
  if (!result.ok) { rt._keyAgentIdentifyCache = { at: now, stationId: ownStation.id, result, etag: sameStation ? cache.etag : null }; return result; }
  const resolved = result.status === 304 && sameStation && cache.result?.ok ? { ...result, channels: cache.result.channels } : result;
  rt._keyAgentIdentifyCache = { at: now, stationId: ownStation.id, result: resolved, etag: result.etag ?? (sameStation ? cache.etag : null) };
  return resolved;
}
