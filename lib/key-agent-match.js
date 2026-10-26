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

// 一个渠道的一把 Key（agent 的 keys[i]，{ i, m: 打码, f: 指纹 }）在候选上游列表里认是哪把。
// tokenLists: [{ stationId, tokens: [{ id, name, maskedKey }] | null }]（tokens 为 null 表示这个候选这一轮没读到，
// 不能当「没有这把」，要算「这一轮认不出」，等下一轮）。fingerprintKeyBytes 派生自这个自营站点的 keyAgent 令牌。
// 返回：
//   { state: "identified", matches: [{ stationId, tokenId, tokenName }] }    唯一一把，精确指纹或打码只撞一把
//   { state: "ambiguous", matches: [...] }                                   打码撞了不止一把（或指纹撞了，理论上不会），要 reveal 才能分
//   { state: "not_found" }                                                   候选都读到了、都没有这把
//   { state: "unresolved" }                                                  至少一个候选这一轮没读到，不下结论
export function identifyKeySlot(slot, tokenLists, fingerprintKeyBytes) {
  const fingerprint = String(slot?.f ?? ""), theirMask = maskParts(slot?.m);
  let unresolved = false;
  const exact = [], maskedOnly = [];
  for (const { stationId, tokens } of tokenLists) {
    if (tokens == null) { unresolved = true; continue; }
    for (const token of tokens) {
      const classified = classifyUpstreamKey(token.maskedKey);
      if (!classified) continue;
      if (classified.kind === "full") {
        if (fingerprintKey(classified.key, fingerprintKeyBytes) === fingerprint) exact.push({ stationId, tokenId: token.id, tokenName: token.name });
      } else if (theirMask && classified.front === theirMask.front && classified.back === theirMask.back) {
        maskedOnly.push({ stationId, tokenId: token.id, tokenName: token.name });
      }
    }
  }
  if (exact.length === 1) return { state: "identified", matches: exact };
  if (exact.length > 1) return { state: "ambiguous", matches: exact }; // 指纹撞车不该发生，照「要 reveal」一样处理（这里用不上，指纹本身已经是从完整 Key 来的）
  if (maskedOnly.length === 1) return { state: "identified", matches: maskedOnly };
  if (maskedOnly.length > 1) return { state: "ambiguous", matches: maskedOnly };
  return unresolved ? { state: "unresolved" } : { state: "not_found" };
}

// 一个渠道（agent 快照里的一条）认出来是什么样：keyless 的渠道不比；一个渠道可能有几把 Key（多 Key 渠道），每把各认一次
export function identifyChannel(channel, tokenLists, fingerprintKeyBytes) {
  if (channel?.keyless) return { channelId: Number(channel.id), keyless: true };
  const slots = Array.isArray(channel?.keys) ? channel.keys : [];
  return { channelId: Number(channel?.id), keyless: false, slots: slots.map((slot) => ({ index: Number(slot.i), ...identifyKeySlot(slot, tokenLists, fingerprintKeyBytes) })) };
}
