// 认出快照里每个渠道现在用的是哪把 Key（K2a）。只认、只显示：不开段、不改账，K2b 才按认出的结果写分段。
import { createHash } from "node:crypto";
import { fingerprintKey } from "../lib/key-fingerprint.js";
import { fetchKeyAgentSnapshot } from "../lib/key-agent-client.js";
import { identifyChannel, identifyKeySlot, classifyUpstreamKey } from "../lib/key-agent-match.js";
import { queryNewApiReconciliationMetadata, queryReconciliationMetadata, queryRevealedTokenKeys } from "../lib/providers.js";
import { keyAgentConfigOf } from "./key-agent.js";
import { stationBusinessVersion } from "../db/store.js";
import { matchCostStations } from "./own-helpers.js";

// 读过一次发现目录里没有完整 Key 的上游，这么久之内不再为指纹去读它（新版 New API 的目录只给打码）
const CATALOG_KIND_TTL_MS = 60 * 60 * 1000;
// Sub2API 的目录每读一次是 3 个请求（身份核对前后各一次 + Key 列表，密码型再加登录 5 个），读取服务的快照一变（渠道被自动禁用/启用也会）
// 就要全读一遍：按站点缓存 5 分钟（和对账 P1b 的目录缓存一个节奏）。缓存里只有 id、名字、状态、指纹，没有完整 Key；
// 站点的地址、登录信息变了（stationBusinessVersion）就不用旧的；读失败不缓存
const SUB2_CATALOGUE_TTL_MS = 5 * 60 * 1000;
// 缓存只记一个摘要当版本戳（判「读取服务的密钥换没换」），不把派生出来的指纹密钥本身放进长期存在的缓存对象
const keyStamp = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
function sub2CatalogueOf(rt, station, config, querySub2Metadata) {
  const cache = (rt._keyAgentSub2Catalogue ||= new Map());
  const version = stationBusinessVersion(station);
  const hit = cache.get(station.id);
  if (hit && hit.version === version && hit.keyStamp === keyStamp(config.fingerprintKey) && Date.now() - hit.at < SUB2_CATALOGUE_TTL_MS) return Promise.resolve(hit.tokens);
  return querySub2Metadata(station, { fingerprintOf: (raw) => fingerprintKey(raw, config.fingerprintKey) })
    .then((metadata) => { cache.set(station.id, { at: Date.now(), version, keyStamp: keyStamp(config.fingerprintKey), tokens: metadata.tokens }); return metadata.tokens; })
    .catch(() => null);
}

// 打码对上不止一把候选时，取这几把的完整 Key 精确再分（k-plan §2.2）：有 api_key:reveal 权限就拿到 { tokenId: 完整Key }；
// 没权限按码返回，不抛（调用方按上游汇总成一条需处理，不是逐渠道）；被限流、网络错等别的失败也按码返回，这一轮当认不出，下一轮再试，不重试、不特殊处理。
// 算完指纹立刻从这个函数的调用方手里连引用一起丢掉，不缓存、不进日志、不进库（k-plan §11.3）
async function revealResultOf(revealKeys, station, tokenIds) {
  try { return { ok: true, keys: await revealKeys(station, tokenIds) }; }
  catch (error) { return { ok: false, code: error?.code, scope: error?.scope }; }
}

// 候选上游用地址对（matchCostStations，K1a 改成返回全部最高分候选）；每个候选只读一次 Key 目录（这一轮里共用）；
// Sub2API 的 Key 列表每一项都带完整 Key（v0.2.18 handler/dto/mappers.go:87），读目录时就地算成指纹、完整 Key 当场丢掉（queryReconciliationMetadata 的 fingerprintOf），
// 只能比指纹；它的目录没有打码，所以不参与打码那一步。
// 返回 { ok, stale, staleReason, channels: [{ channelId, keyless, slots? }], revealIssues }；channelIds 给了就只认这几个。
// revealIssues：按上游汇总的「少了 api_key:reveal 权限」，还没开始算的渠道只在这一条里列出（不逐渠道报需处理）
// cachedSnapshot：上一次读取服务给的原始渠道列表（{ channels }）。读取服务回 304（它那一份没变）时，调用方想重新对一遍上游目录就传它——
// 304 只说明读取服务的数没变，不说明上游目录没变（用户加了上游、补了 api_key:reveal 权限，渠道还是那把 Key，认出来的结果就该变）；
// 不传就照旧：304 直接返回 channels: null，由调用方沿用上一次认出的结果
export async function identifyChannels(rt, ownStation, { channelIds = null, etag = null, cachedSnapshot = null, queryMetadata = queryNewApiReconciliationMetadata, querySub2Metadata = queryReconciliationMetadata, revealKeys = queryRevealedTokenKeys } = {}) {
  const config = keyAgentConfigOf(ownStation);
  if (!config) return { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" };
  let snapshot = await fetchKeyAgentSnapshot({ url: config.url, token: config.token, etag });
  if (!snapshot.ok) return snapshot;
  if (snapshot.status === 304) {
    if (!cachedSnapshot?.channels) return { ok: true, status: 304, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag, channels: null };
    snapshot = { ...snapshot, channels: cachedSnapshot.channels };
  }

  const upstreams = rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && station.type !== "fixed" && !station.archivedAt);
  const isSub2 = (station) => station.type === "sub2api" || station.type === "sub2api-password";
  const identifiableUpstreams = upstreams.filter((station) => station.type === "newapi" || isSub2(station));
  const tokenListCache = new Map();
  const tokensOf = (station) => {
    if (!tokenListCache.has(station.id)) {
      const promise = station.type === "newapi"
        ? queryMetadata(station, {}).then((metadata) => metadata.tokens).catch(() => null)
        : isSub2(station)
          ? sub2CatalogueOf(rt, station, config, querySub2Metadata)
          : Promise.resolve(null);
      tokenListCache.set(station.id, promise);
    }
    return tokenListCache.get(station.id);
  };
  // 指纹在全部已加的 New API 上游里找（审核 #131 H1，k-plan §2.2），打码只在候选（地址对上的）里找（H2）。
  // 但读一个上游的 Key 目录要翻页，不便宜（审核 #131 第 2 轮：别多读上游），所以分两步：
  //   1. 先只读候选上游，和只认候选时一样（每个候选只读一次，这一轮里共用）；认得出的渠道到这里就结束，零额外读取。
  //   2. 只有第一步之后还有渠道认不出（not_found：渠道填的是代理/内网地址，或者换成了哪都没有的 Key），才为指纹去读
  //      非候选的 New API 上游目录。而且新版 New API（≥ v0.11.4）的目录只给打码、比不了指纹：读过一次发现没有完整 Key 的上游，
  //      记在 rt._keyAgentCatalogKinds 里 1 小时内不再为指纹读它。
  //   这里读目录是 queryNewApiReconciliationMetadata 自己读，没有走对账模块里 P1b 的 5 分钟目录缓存（那份缓存在对账模块内部，
  //   这里拿不到）；识别结果整体有 4 分钟缓存（identifyChannelsCached），304 时连这些都不读。
  const catalogKinds = (rt._keyAgentCatalogKinds ||= new Map()); // upstreamId -> { hasFullKeys, at }
  const loadedLists = new Map(); // upstreamId -> { stationId, tokens }：这一轮读过的目录
  const loadList = async (station) => {
    if (!loadedLists.has(station.id)) {
      const tokens = await tokensOf(station);
      // 空目录（刚建的账号还没有 Key）说明不了这个上游给不给完整 Key，不记种类——不然 1 小时内不再为指纹读它，用户刚建的 Key 认不出来
      if (tokens?.length) catalogKinds.set(station.id, { hasFullKeys: tokens.some((token) => token.fingerprint || classifyUpstreamKey(token.maskedKey)?.kind === "full"), at: Date.now() });
      loadedLists.set(station.id, { stationId: station.id, tokens });
    }
    return loadedLists.get(station.id);
  };

  const channels = [], pendingChannels = [], rawFingerprintOf = new Map(); // `${channelId}:${index}` -> 读取服务给的指纹（第二轮分打码撞了要用）
  for (const channel of snapshot.channels) {
    if (channelIds && !channelIds.includes(Number(channel.id))) continue;
    if (channel.keyless) { channels.push({ channelId: Number(channel.id), keyless: true }); continue; }
    const candidates = matchCostStations(upstreams, channel.baseUrl).filter((station) => station.type === "newapi" || isSub2(station));
    const candidateTokenLists = await Promise.all(candidates.map(loadList));
    const identified = identifyChannel(channel, { allTokenLists: candidateTokenLists, candidateTokenLists }, config.fingerprintKey);
    for (const slot of identified.slots) rawFingerprintOf.set(`${identified.channelId}:${slot.index}`, channel.keys.find((key) => Number(key.i) === slot.index)?.f);
    channels.push(identified);
    if (identified.slots.some((slot) => slot.state === "not_found")) pendingChannels.push({ channel, identified, candidateTokenLists });
  }
  if (pendingChannels.length) {
    const kindFresh = (station) => { const kind = catalogKinds.get(station.id); return kind && Date.now() - kind.at < CATALOG_KIND_TTL_MS ? kind : null; };
    const others = identifiableUpstreams.filter((station) => !loadedLists.has(station.id) && kindFresh(station)?.hasFullKeys !== false);
    await Promise.all(others.map(loadList));
    const allTokenLists = [...loadedLists.values()];
    for (const { channel, identified, candidateTokenLists } of pendingChannels) {
      identified.slots = identified.slots.map((slot) => slot.state !== "not_found" ? slot
        : { index: slot.index, ...identifyKeySlot(channel.keys.find((key) => Number(key.i) === slot.index), { allTokenLists, candidateTokenLists }, config.fingerprintKey) });
    }
  }

  // 打码撞了：按上游批量 reveal 一次（同一个上游、这一轮内只问一次，几个渠道的候选合并着问）
  const revealIssues = [];
  const neededByStation = new Map();
  for (const channel of channels) {
    if (channel.keyless) continue;
    for (const slot of channel.slots) {
      if (slot.state !== "ambiguous" || !slot.matches.every((match) => match.via === "mask")) continue; // 指纹撞车 reveal 分不开：保持 ambiguous
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
        if (slot.state !== "ambiguous" || !slot.matches.every((match) => match.via === "mask")) continue;
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

  const result = { ok: true, status: snapshot.status, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag, channels, revealIssues };
  // 原始渠道列表（带指纹、打码）给缓存层留着重新比对用：不可枚举，不会跟着结果被展开、序列化出去
  Object.defineProperty(result, "snapshotChannels", { value: snapshot.channels, enumerable: false });
  return result;
}

// 查一次候选上游的 Key 目录要挨个翻页读，不便宜；缓存节奏和读取服务自己的库读节奏一样（k-plan §2.4 的 4 分钟），
// 查询结果（渠道目录等）一请求一次调这个，不会把所有候选上游的 Key 目录在节奏之外重读一遍。
// 304（读取服务那一侧没变）直接沿用上一次认出的结果，连候选上游都不问
export const IDENTIFY_CACHE_MS = 4 * 60 * 1000;
// 认出的结果里还有没认定的（not_found、ambiguous、unresolved，或者少了 api_key:reveal 权限）：这类状态会随上游目录、权限变化自己好，
// 读取服务回 304 也要重新对一遍上游目录；全都认定了（identified / keyless）的，304 就沿用，不多读上游（审核 #131「别多读上游」）
// 没认定的状态（渠道 Key 不在已加的上游里是会持续很久的真实场景）重新对上游目录的间隔：读取服务回 304 时最多每 15 分钟对一次，
// 不是每次缓存到期（4 分钟）都把候选上游的目录读一遍——持续 not_found 的渠道每个候选上游每小时最多读 4 次
export const UNRESOLVED_RECHECK_MS = 15 * 60 * 1000;
const hasUnresolved = (result) => (result?.revealIssues?.length ?? 0) > 0
  || (result?.channels || []).some((channel) => !channel.keyless && (channel.slots || []).some((slot) => slot.state !== "identified"));
const unresolvedCount = (result) => (result?.channels || []).reduce((total, channel) => total + (channel.slots || []).filter((slot) => slot.state === "unresolved").length, 0);
// 缓存分两份：result 是最近一次问的结果（失败了也记，4 分钟内不重复问）；lastGood 是最近一次读成功的结果、etag、原始渠道列表，
// 失败结果不会覆盖它——一次 503 之后恢复回 304 时，沿用的还是失败之前认出的 channels，不是 null
export async function identifyChannelsCached(rt, ownStation, options = {}) {
  // 同一个自营站点同时来几个调用（轮询、页面查询、报告）：合并成一次，别各读一遍上游目录（缓存在 await 之后才写，挡不住同时进来的）
  const inflight = (rt._keyAgentIdentifyInflight ||= new Map());
  if (inflight.has(ownStation.id)) return inflight.get(ownStation.id);
  const promise = identifyChannelsCachedOnce(rt, ownStation, options).finally(() => inflight.delete(ownStation.id));
  inflight.set(ownStation.id, promise);
  return promise;
}
async function identifyChannelsCachedOnce(rt, ownStation, options) {
  const cache = rt._keyAgentIdentifyCache;
  const now = Date.now();
  // options.fresh：用户点「开始算利润」这种要拿最新结果的地方，不用 4 分钟缓存（etag 照用，读取服务没变就是 304）
  if (!options.fresh && cache && cache.stationId === ownStation.id && now - cache.at < IDENTIFY_CACHE_MS) return cache.result;
  const sameStation = cache?.stationId === ownStation.id;
  const good = sameStation ? cache.lastGood ?? null : null;
  const result = await identifyChannels(rt, ownStation, { ...options, etag: good?.etag ?? null,
    cachedSnapshot: good && hasUnresolved(good.result) && now - good.comparedAt >= UNRESOLVED_RECHECK_MS ? { channels: good.snapshotChannels } : null });
  trackKeyAgentReachability(rt, ownStation.id, result); // 只在真的问了一次（没命中 4 分钟缓存）才记，不按调用次数记
  if (!result.ok) { rt._keyAgentIdentifyCache = { at: now, stationId: ownStation.id, result, lastGood: good }; return result; }
  // fetchedAtMs：这一份结果是什么时候真的从读取服务拿到的（200 或 304，不带 X-Agent-Stale 才有）。缓存命中返回的还是原来那份，
  // 所以带的是原来那一刻——K2b 的驱动拿它当「读取服务上一次读成功」的时刻，由驱动在换段落库提交以后再持久化
  // （不在这里写：读完就先写，a 就成了 b，中途重启还会让它退不回去，见 server/reconciliation.js keyAgentRoundFor）
  // 304 重新对上游目录时某个候选上游这一轮读不到（slot 变成 unresolved）：这次比对不算数——读取服务那一份没变（304），上一份认出来的
  // 还是对的，不让一次上游抖动把原本认得出的渠道降级、再沿用十几分钟；也不更新 comparedAt，下一轮缓存到期接着重对
  const recheckFailed = result.status === 304 && result.channels != null && !!good && unresolvedCount(result) > unresolvedCount(good.result);
  const resolvedBase = (result.channels == null || recheckFailed) && good
    ? { ...result, channels: good.result.channels, revealIssues: good.result.revealIssues }
    : result;
  const resolved = { ...resolvedBase, fetchedAtMs: result.stale ? null : now };
  // 带 X-Agent-Stale 的是读取服务给的旧结果，不当「最近一次读成功」留下，也不换 etag
  // comparedAt：最近一次真的拿上游目录比对的时刻（200，或者 304 但重新比对了）；纯沿用旧结果的 304 不更新它
  const compared = result.channels != null && !recheckFailed;
  const nextGood = result.stale ? good : { etag: result.etag ?? good?.etag ?? null, result: resolved, snapshotChannels: result.snapshotChannels ?? good?.snapshotChannels ?? null,
    comparedAt: compared ? now : good?.comparedAt ?? now };
  rt._keyAgentIdentifyCache = { at: now, stationId: ownStation.id, result: resolved, lastGood: nextGood };
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
