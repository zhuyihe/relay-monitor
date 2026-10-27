// 认出快照里每个渠道现在用的是哪把 Key（K2a）。只认、只显示：不开段、不改账，K2b 才按认出的结果写分段。
import { fingerprintKey } from "../lib/key-fingerprint.js";
import { fetchKeyAgentSnapshot } from "../lib/key-agent-client.js";
import { identifyChannel } from "../lib/key-agent-match.js";
import { queryNewApiReconciliationMetadata, queryRevealedTokenKeys } from "../lib/providers.js";
import { keyAgentConfigOf } from "./key-agent.js";
import { matchCostStations } from "./own-helpers.js";

// 打码对上不止一把候选时，取这几把的完整 Key 精确再分（k-plan §2.2）：有 api_key:reveal 权限就拿到 { tokenId: 完整Key }；
// 没权限按码返回，不抛（调用方按上游汇总成一条需处理，不是逐渠道）；被限流、网络错等别的失败也按码返回，这一轮当认不出，下一轮再试，不重试、不特殊处理。
// 算完指纹立刻从这个函数的调用方手里连引用一起丢掉，不缓存、不进日志、不进库（k-plan §11.3）
async function revealResultOf(revealKeys, station, tokenIds) {
  try { return { ok: true, keys: await revealKeys(station, tokenIds) }; }
  catch (error) { return { ok: false, code: error?.code, scope: error?.scope }; }
}

// 候选上游用地址对（matchCostStations，K1a 改成返回全部最高分候选）；每个候选只读一次 Key 目录（这一轮里共用）；
// Sub2API 的 Key 列表不给 Key 材料，这一版比不了，候选是 Sub2API 时直接跳过。
// 返回 { ok, stale, staleReason, channels: [{ channelId, keyless, slots? }], revealIssues }；channelIds 给了就只认这几个。
// revealIssues：按上游汇总的「少了 api_key:reveal 权限」，还没开始算的渠道只在这一条里列出（不逐渠道报需处理）
export async function identifyChannels(rt, ownStation, { channelIds = null, etag = null, queryMetadata = queryNewApiReconciliationMetadata, revealKeys = queryRevealedTokenKeys } = {}) {
  const config = keyAgentConfigOf(ownStation);
  if (!config) return { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" };
  const snapshot = await fetchKeyAgentSnapshot({ url: config.url, token: config.token, etag });
  if (!snapshot.ok) return snapshot;
  if (snapshot.status === 304) return { ok: true, status: 304, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag, channels: null };

  const upstreams = rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && station.type !== "fixed" && !station.archivedAt);
  const newApiUpstreams = upstreams.filter((station) => station.type === "newapi");
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
  // 指纹在全部已加的上游里找（审核 #131 H1，k-plan §2.2）：每个上游的 Key 目录只读一次（tokensOf 按上游缓存），
  // 不会因为按渠道重复查而多读；候选（地址对上的）是这份里的子集，打码比对只在候选里找，不放大（H2）
  const allTokenLists = await Promise.all(newApiUpstreams.map(async (station) => ({ stationId: station.id, tokens: await tokensOf(station) })));

  const channels = [], rawFingerprintOf = new Map(); // `${channelId}:${index}` -> 读取服务给的指纹（第二轮分打码撞了要用）
  for (const channel of snapshot.channels) {
    if (channelIds && !channelIds.includes(Number(channel.id))) continue;
    if (channel.keyless) { channels.push({ channelId: Number(channel.id), keyless: true }); continue; }
    const candidates = matchCostStations(upstreams, channel.baseUrl).filter((station) => station.type === "newapi");
    const candidateIds = new Set(candidates.map((station) => station.id));
    const candidateTokenLists = allTokenLists.filter((item) => candidateIds.has(item.stationId));
    const identified = identifyChannel(channel, { allTokenLists, candidateTokenLists }, config.fingerprintKey);
    for (const slot of identified.slots) rawFingerprintOf.set(`${identified.channelId}:${slot.index}`, channel.keys.find((key) => Number(key.i) === slot.index)?.f);
    channels.push(identified);
  }

  // 打码撞了：按上游批量 reveal 一次（同一个上游、这一轮内只问一次，几个渠道的候选合并着问）
  const revealIssues = [];
  const neededByStation = new Map();
  for (const channel of channels) {
    if (channel.keyless) continue;
    for (const slot of channel.slots) {
      if (slot.state !== "ambiguous") continue;
      for (const match of slot.matches) {
        if (!neededByStation.has(match.stationId)) neededByStation.set(match.stationId, new Set());
        neededByStation.get(match.stationId).add(Number(match.tokenId));
      }
    }
  }
  if (neededByStation.size) {
    const revealResults = new Map();
    await Promise.all([...neededByStation].map(async ([stationId, tokenIds]) => {
      const station = upstreams.find((item) => item.id === stationId);
      revealResults.set(stationId, station ? await revealResultOf(revealKeys, station, [...tokenIds]) : { ok: false, code: "UPSTREAM_NOT_FOUND" });
    }));
    for (const channel of channels) {
      if (channel.keyless) continue;
      for (const slot of channel.slots) {
        if (slot.state !== "ambiguous") continue;
        const fingerprint = rawFingerprintOf.get(`${channel.channelId}:${slot.index}`);
        const byStation = new Map();
        for (const match of slot.matches) byStation.set(match.stationId, [...(byStation.get(match.stationId) || []), match]);
        const resolved = [];
        let anyUnreadable = false;
        for (const [stationId, candidates] of byStation) {
          const result = revealResults.get(stationId);
          if (!result.ok) {
            anyUnreadable = true;
            // 不另起一种需处理：沿用 #107 那条路已经定好的码（design/ui-copy-spec.md §8.2，这一条还没接进需处理清单，留给接的人用这个码）
            if (result.code === "ACCESS_TOKEN_SCOPE_DENIED" && result.scope === "api_key:reveal") {
              let issue = revealIssues.find((item) => item.upstreamStationId === stationId);
              if (!issue) { issue = { upstreamStationId: stationId, code: "KEY_REVEAL_DENIED", channelIds: [] }; revealIssues.push(issue); }
              if (!issue.channelIds.includes(channel.channelId)) issue.channelIds.push(channel.channelId);
            }
            continue; // 别的失败（限流、网络……）：这一轮当认不出，下一轮再试，不重试、不升需处理
          }
          for (const candidate of candidates) {
            const fullKey = result.keys[candidate.tokenId];
            // 返回里没有这把（超过一轮能取的批数、或上游没给）：没读全，不能当成「这把不是」，保持 ambiguous 下一轮再试
            if (fullKey == null) { anyUnreadable = true; continue; }
            if (fingerprintKey(fullKey, config.fingerprintKey) === fingerprint) resolved.push({ ...candidate, via: "revealed" });
          }
        }
        if (resolved.length === 1) { slot.state = "identified"; slot.matches = resolved; }
        else if (resolved.length > 1) { slot.matches = resolved; } // 仍然不止一把（撞的是真指纹，不是打码误判），维持 ambiguous
        else if (!anyUnreadable) { slot.state = "not_found"; delete slot.matches; } // 候选都读到了、没有一把对上
        // anyUnreadable 且没解出来：保持 ambiguous，matches 不变，下一轮再试
      }
    }
  }

  return { ok: true, status: 200, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag, channels, revealIssues };
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
  trackKeyAgentReachability(rt, ownStation.id, result); // 只在真的问了一次（没命中 4 分钟缓存）才记，不按调用次数记
  if (!result.ok) { rt._keyAgentIdentifyCache = { at: now, stationId: ownStation.id, result, etag: sameStation ? cache.etag : null }; return result; }
  // fetchedAtMs：这一份结果是什么时候真的从读取服务拿到的（200 或 304，不带 X-Agent-Stale 才有）。缓存命中返回的还是原来那份，
  // 所以带的是原来那一刻——K2b 的驱动拿它当「读取服务上一次读成功」的时刻，由驱动在换段落库提交以后再持久化
  // （不在这里写：读完就先写，a 就成了 b，中途重启还会让它退不回去，见 server/reconciliation.js keyAgentRoundFor）
  const resolvedBase = result.status === 304 && sameStation && cache.result?.ok
    ? { ...result, channels: cache.result.channels, revealIssues: cache.result.revealIssues }
    : result;
  const resolved = { ...resolvedBase, fetchedAtMs: result.stale ? null : now };
  rt._keyAgentIdentifyCache = { at: now, stationId: ownStation.id, result: resolved, etag: result.etag ?? (sameStation ? cache.etag : null) };
  return resolved;
}

// 例外三（k-plan §6）：连续几次「拿不到新结果」、从什么时候开始——没配置、读不到（连不上/401/503）、
// 带 X-Agent-Stale 的（读取服务自己读库失败，给的是上一份旧结果）都算拿不到新结果；304（确认没变，读取服务这一轮库读成功）
// 和真的 200 都算拿到了，清零。只记在 OWN 站点这一级（读取服务挂了是整站的事，不分到每条绑定）；只在内存里，
// 和 server/reconciliation.js 的 staleMetadata/metadataCache 一个道理，重启清零可以接受——连续 3 次约 10~15 分钟，不是定金额对不对
function trackKeyAgentReachability(rt, stationId, result) {
  const tracker = (rt._keyAgentReachability ||= new Map());
  const state = tracker.get(stationId) || { consecutiveFailures: 0, unreachableSinceMs: null, lastSuccessAtMs: null };
  const failed = !result.ok || result.stale === true;
  const at = Date.now();
  // lastSuccessAtMs：内存里记的「最近一次真的读到」，例外三从这一刻起先不算（和持久化的 keyAgentLastSuccessAtMs 不是一回事：
  // 那个有「没处理完就不往前推」的规矩，这个只管读不读得到）
  tracker.set(stationId, failed
    ? { consecutiveFailures: state.consecutiveFailures + 1, unreachableSinceMs: state.unreachableSinceMs ?? at, lastSuccessAtMs: state.lastSuccessAtMs }
    : { consecutiveFailures: 0, unreachableSinceMs: null, lastSuccessAtMs: at });
}
// 查这个站点现在的例外三状态：consecutiveFailures 到 3 就该升成需处理 KEY_READER_UNREACHABLE（调用方按 k-plan §6 的表判）
export function keyAgentReachability(rt, stationId) {
  return rt._keyAgentReachability?.get(stationId) || { consecutiveFailures: 0, unreachableSinceMs: null, lastSuccessAtMs: null };
}
