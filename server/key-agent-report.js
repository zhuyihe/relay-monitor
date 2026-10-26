// 和现有绑定对一遍：K2a 认出的「渠道现在用的 Key」和 reconciliation_rules 现在记的绑定不一样时，就是报告里要翻的那一条。
// 只认、只显示：这份报告只给名单，不改绑定；照着改绑定是 K2b 的事。
import { identifyChannelsCached } from "./key-agent-identify.js";

function boundKeysOf(rules, ownStationId, channelId) {
  return rules
    .filter((rule) => rule.enabled && !rule.archivedAt && rule.ownStationId === ownStationId
      && rule.channels.some((member) => Number(member.channelId) === Number(channelId)))
    .map((rule) => ({ stationId: rule.upstreamStationId, tokenId: rule.tokenId, ruleId: rule.id }));
}

const sameKey = (a, b) => a.stationId === b.stationId && Number(a.tokenId) === Number(b.tokenId);

// 一条渠道只在这两种情形才进报告：没绑定但认出来了（没对上）；绑了但认出来的不是同一把 Key（绑错了）。
// 绑了、认不出来（ambiguous/not_found/unresolved）先不进报告：认不出来不代表绑错了，等认得出来再说。
export async function keyBindingReport(rt, ownStation, options = {}) {
  const identified = await identifyChannelsCached(rt, ownStation, options);
  if (!identified.ok) return { ok: false, code: identified.code };
  if (identified.channels == null) return { ok: true, mismatches: [] }; // 刚起步，连一轮都没认过

  const rules = await rt.reconciliation.listRules({ includeArchived: true });
  const mismatches = [];
  for (const channel of identified.channels) {
    if (channel.keyless) continue;
    const bound = boundKeysOf(rules, ownStation.id, channel.channelId);
    const identifiedKeys = (channel.slots || []).flatMap((slot) => (slot.state === "identified" ? slot.matches : []));
    if (!identifiedKeys.length) continue;
    if (!bound.length) {
      mismatches.push({ channelId: channel.channelId, kind: "unbound", identified: identifiedKeys });
    } else if (!bound.some((b) => identifiedKeys.some((m) => sameKey(b, m)))) {
      mismatches.push({ channelId: channel.channelId, kind: "different_key", bound, identified: identifiedKeys });
    }
  }
  return { ok: true, mismatches };
}
