// 读取服务认出的打码/指纹，和候选上游的 Key 目录比对，认出这个渠道现在用的是哪把 Key（K2a 只认、只显示，不开段）。
// k-plan 第二节 2.2：先按指纹（完整 Key 读得到时）、再按打码；打码撞了不止一把才要 reveal（server/key-agent.js 另处理）。
import { fingerprintKey, normalizeKey } from "./key-fingerprint.js";

const MIN_FULL_KEY_LENGTH = 16;
const SEPARATOR = /[^0-9A-Za-z]+/;

// 上游 /api/token/ 给的那一串，到底是完整 Key 还是打码：两边打码都是「前 4 位 + 分隔符 + 后 4 位」（不管分隔符具体是什么字符），
// 按非字母数字切开，正好两段、各 4 位就认成打码；切开只有一段、够长就认成完整 Key；再短或者形状古怪的当读不到
export function classifyUpstreamKey(raw) {
  const normalized = normalizeKey(raw);
  if (!normalized) return null;
  const segments = normalized.split(SEPARATOR).filter(Boolean);
  if (segments.length === 2 && segments[0].length === 4 && segments[1].length === 4) {
    return { kind: "masked", front: segments[0].toLowerCase(), back: segments[1].toLowerCase() };
  }
  if (segments.length === 1 && segments[0].length >= MIN_FULL_KEY_LENGTH) return { kind: "full", key: raw };
  return null;
}

// 读取服务自己给的打码「AbC1…9f0c」也拆成前 4 后 4，和上面同一套比法
function maskParts(masked) {
  const segments = String(masked ?? "").split(SEPARATOR).filter(Boolean);
  return segments.length === 2 ? { front: segments[0].toLowerCase(), back: segments[1].toLowerCase() } : null;
}

// 一个渠道的一把 Key（agent 的 keys[i]，{ i, m: 打码, f: 指纹 }）认是哪把（审核 #131 H1：指纹和打码查的范围不一样，
// 不能用同一份 tokenLists）：
//   - 指纹（完整 Key 读得到才有，比如 Sub2API 的 Key 目录）在**全部已加的上游**里找，不限候选——渠道填的是代理、
//     内网地址时，地址对不上任何候选，但指纹照样能精确认出是哪个上游的哪把 Key，这正是方案要解决的场景。
//   - 打码只能在**候选上游**（地址对上的）里找：打码只有前 4 后 4，放大到全部上游会把别的账号打码一样的 Key
//     认成这一把，算错账（审核 H2）。
// allTokenLists / candidateTokenLists: [{ stationId, tokens: [{ id, name, maskedKey }] | null }]（tokens 为 null
// 表示这个上游这一轮没读到，不能当「没有这把」，要算「这一轮认不出」，等下一轮）。candidateTokenLists 是
// allTokenLists 里地址对上的那一部分（调用方按同一份 tokensOf 缓存取，不会多读）。
// fingerprintKeyBytes 派生自这个自营站点的 keyAgent 令牌。返回：
//   { state: "identified", matches: [{ stationId, tokenId, tokenName, via }] }  唯一一把，精确指纹或打码只撞一把
//   { state: "ambiguous", matches: [...] }                                      打码（或指纹，理论上不会）撞了不止一把，要 reveal 才能分
//   { state: "not_found" }                                                      全部都读到了、都没有这把
//   { state: "unresolved" }                                                     至少一个这一轮没读到，不下结论
// via：这一把是指纹认出的（"fingerprint"）还是打码认出的（"mask"），k-plan §3.2 的 match_source 要用
export function identifyKeySlot(slot, { allTokenLists, candidateTokenLists }, fingerprintKeyBytes) {
  const fingerprint = String(slot?.f ?? ""), theirMask = maskParts(slot?.m);
  let unresolvedFingerprint = false, unresolvedMask = false;
  const exact = [], maskedOnly = [];
  for (const { stationId, tokens } of allTokenLists) {
    if (tokens == null) { unresolvedFingerprint = true; continue; }
    for (const token of tokens) {
      // token.fingerprint：上游目录读取时就地算好的（Sub2API，完整 Key 读到就丢了，这里只有指纹）；
      // 没有就看 maskedKey 里是不是完整 Key（老版 New API），在这里算
      const classified = token.fingerprint ? null : classifyUpstreamKey(token.maskedKey);
      if (token.fingerprint ? token.fingerprint === fingerprint : classified?.kind === "full" && fingerprintKey(classified.key, fingerprintKeyBytes) === fingerprint) {
        exact.push({ stationId, tokenId: token.id, tokenName: token.name, via: "fingerprint" });
      }
    }
  }
  for (const { stationId, tokens } of candidateTokenLists) {
    if (tokens == null) { unresolvedMask = true; continue; }
    for (const token of tokens) {
      const classified = classifyUpstreamKey(token.maskedKey);
      if (classified?.kind === "masked" && theirMask && classified.front === theirMask.front && classified.back === theirMask.back) {
        maskedOnly.push({ stationId, tokenId: token.id, tokenName: token.name, via: "mask" });
      }
    }
  }
  if (exact.length === 1) return { state: "identified", matches: exact };
  if (exact.length > 1) return { state: "ambiguous", matches: exact }; // 指纹撞车不该发生，照「要 reveal」一样处理（这里用不上，指纹本身已经是从完整 Key 来的）
  if (maskedOnly.length === 1) return { state: "identified", matches: maskedOnly };
  if (maskedOnly.length > 1) return { state: "ambiguous", matches: maskedOnly };
  return (unresolvedFingerprint || unresolvedMask) ? { state: "unresolved" } : { state: "not_found" };
}

// 一个渠道（agent 快照里的一条）认出来是什么样：keyless 的渠道不比；一个渠道可能有几把 Key（多 Key 渠道），每把各认一次
export function identifyChannel(channel, tokenLists, fingerprintKeyBytes) {
  if (channel?.keyless) return { channelId: Number(channel.id), keyless: true };
  const slots = Array.isArray(channel?.keys) ? channel.keys : [];
  return { channelId: Number(channel?.id), keyless: false, slots: slots.map((slot) => ({ index: Number(slot.i), ...identifyKeySlot(slot, tokenLists, fingerprintKeyBytes) })) };
}
