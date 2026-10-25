// 合并重复的上游（K1a）：同一个上游账号被加成了几个上游时，留下最早的那个，把其余的并进它。
// 「同一个账号」就是类型、站点地址、账号 ID 三样都一样（和 storedIdentity 同一口径）。
// 这里只有纯函数：算出哪些上游要合成哪个、合并以后文档和绑定会怎么改、有没有挡着不能合的事。
// 真正改库的在 server/upstream-merge.js，所有的写在同一个事务里（db/store.js 的 mergeUpstreams）。
import { onboardingBaseUrl, storedIdentity } from "./channel-onboarding.js";

export const MERGE_BLOCKERS = Object.freeze({
  MONITOR_MISMATCH: "MONITOR_MISMATCH",
  PROFIT_MISMATCH: "PROFIT_MISMATCH",
  MERGED_HAS_FIXED_COST: "MERGED_HAS_FIXED_COST",
  RULE_KEY_CONFLICT: "RULE_KEY_CONFLICT",
});

export const isMergedStation = (station) => !!station?.mergedInto;

const createdMs = (station) => {
  const ms = Date.parse(station.createdAt || "");
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
};

const groupKeyOf = (identity) => JSON.stringify([identity.provider, identity.baseUrl, identity.accountId]);

// 参与合并的上游：不是自营站点、没归档、没被合过、读出了账号 ID（只用一把 Key、读不出账号的不合）
export function mergeCandidates(stations) {
  return (stations || []).filter((station) => station && !station.isOwn && !station.archivedAt && !isMergedStation(station) && storedIdentity(station));
}

// 合并以后留下的那个的别名：自己原来的，加上被合掉的地址和别名；同一个地址（只差个结尾的 /）不重复，留下那个自己的地址不记
export function mergedCostAliases(retained, merged) {
  const keyOf = (value) => onboardingBaseUrl(value) || String(value || "").trim();
  const seen = new Set([keyOf(retained.baseUrl)]);
  const out = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text || seen.has(keyOf(text))) return;
    seen.add(keyOf(text));
    out.push(text);
  };
  for (const alias of Array.isArray(retained.costAliases) ? retained.costAliases : []) add(alias);
  for (const station of merged) {
    add(station.baseUrl);
    for (const alias of Array.isArray(station.costAliases) ? station.costAliases : []) add(alias);
  }
  return out;
}

// rules：[{ id, upstreamStationId, tokenId, tokenName, enabled, activeKey }]，activeKey 是它现在占着的「同一把 Key 只能一条在用」的键（没占着是 null）
// links：[{ ownStationId, channelId, stationId }]
// 返回 { groups }，每组：
//   key              { provider, baseUrl, accountId }
//   retained         留下的（创建最早的，一样早按 id）
//   merged           被合掉的，按创建时间
//   ruleIds / linkCount   跟着改指向的绑定、看余额关联
//   droppedLinkCount 改指向时和留下那个已有的关联重复、会被去掉的
//   costAliasesAfter 合并以后留下那个的别名
//   blockers         挡着不能合的事（有就不让合）；每条 { code, detail }
//   canMerge
export function planUpstreamMerges({ stations, rules = [], links = [] }) {
  const byKey = new Map();
  for (const station of mergeCandidates(stations)) {
    const identity = storedIdentity(station);
    const key = groupKeyOf(identity);
    if (!byKey.has(key)) byKey.set(key, { identity, members: [] });
    byKey.get(key).members.push(station);
  }
  // 绑定、关联按上游分好、占着的键只收一次：几千条绑定、几百组时每组都从头扫一遍会慢到几百毫秒
  const rulesByStation = new Map(), linksByStation = new Map(), taken = new Map();
  const bucket = (map, id, item) => { if (!map.has(id)) map.set(id, []); map.get(id).push(item); };
  for (const rule of rules) {
    bucket(rulesByStation, rule.upstreamStationId, rule);
    if (rule.activeKey) taken.set(rule.activeKey, rule);
  }
  for (const link of links) bucket(linksByStation, link.stationId, link);
  const groups = [];
  for (const { identity, members } of byKey.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => createdMs(a) - createdMs(b) || String(a.id).localeCompare(String(b.id)));
    const [retained, ...merged] = members;
    const blockers = [];
    const monitored = new Set(members.map((station) => station.monitorEnabled !== false));
    if (monitored.size > 1) blockers.push({ code: MERGE_BLOCKERS.MONITOR_MISMATCH, detail: "有的在监控、有的暂停了" });
    const counted = new Set(members.map((station) => station.includeInProfit !== false));
    if (counted.size > 1) blockers.push({ code: MERGE_BLOCKERS.PROFIT_MISMATCH, detail: "有的算进利润、有的不算" });
    for (const station of merged) {
      if ((station.fixedPurchases || []).length || (station.resoldAdminKeys || []).length) {
        blockers.push({ code: MERGE_BLOCKERS.MERGED_HAS_FIXED_COST, detail: `${station.name} 有固定成本或转售记录` });
      }
    }
    // 没有 canonicalKey 的绑定，占着的键是「上游 id:Key id」，改指向留下的以后这个键变了：撞上留下那个已有的同一把 Key 就不能合
    const moving = merged.flatMap((station) => rulesByStation.get(station.id) || []);
    // 撞上的是哪把 Key、在哪两个上游下（页面上写给用户看：先去处理这条重复的绑定）
    const claimed = new Map();
    for (const rule of moving) {
      if (!rule.activeKey || rule.activeKey !== `${rule.upstreamStationId}:${rule.tokenId}`) continue;
      const next = `${retained.id}:${rule.tokenId}`;
      const other = taken.get(next) || claimed.get(next);
      if (other) {
        blockers.push({ code: MERGE_BLOCKERS.RULE_KEY_CONFLICT, detail: `Key #${rule.tokenId} 已经有一条绑定在用`,
          tokenId: rule.tokenId, tokenName: rule.tokenName ?? other.tokenName ?? null, stationIds: [...new Set([other.upstreamStationId, rule.upstreamStationId])].sort() });
      } else claimed.set(next, rule);
    }
    const movingLinks = merged.flatMap((station) => linksByStation.get(station.id) || []);
    const seen = new Set((linksByStation.get(retained.id) || []).map((link) => `${link.ownStationId}:${link.channelId}`));
    let dropped = 0;
    for (const link of movingLinks) {
      const id = `${link.ownStationId}:${link.channelId}`;
      if (seen.has(id)) dropped += 1;
      else seen.add(id);
    }
    const brief = (station) => ({ id: station.id, name: station.name, baseUrl: station.baseUrl, createdAt: station.createdAt || null });
    groups.push({
      key: { ...identity },
      retained: brief(retained),
      merged: merged.map(brief),
      ruleIds: moving.map((rule) => rule.id).sort(),
      linkCount: movingLinks.length,
      droppedLinkCount: dropped,
      costAliasesAfter: mergedCostAliases(retained, merged),
      blockers,
      canMerge: blockers.length === 0,
    });
  }
  return { groups: groups.sort((a, b) => a.retained.name.localeCompare(b.retained.name) || a.retained.id.localeCompare(b.retained.id)) };
}

// 合并以后上游文档的改动：留下的只改别名；被合掉的记下并进了谁、什么时候（不改别的，凭据照样留着）
export function mergedStationPatches(group, { nowIso }) {
  return {
    retained: { costAliases: group.costAliasesAfter },
    merged: Object.fromEntries(group.merged.map((station) => [station.id, { mergedInto: group.retained.id, mergedAt: nowIso }])),
  };
}
