// 分段记 Key（计划 K1c）：一段里可能有几把 Key，上游成本是这几把各取一次再相加（k-plan 3.5）。
// 这一版每段只有一把（rules 上那把），走的还是原来的单次取数，结果逐字不变；多把 Key、已删 Key 的路径给 K2b 开段以后用。

// 这一段要取的 Key。segmentKeys 是仓库给分段带的 segment.keys（不进 JSON）；没有就是这条绑定自己的那把。
// 返回 { token, deleted }：token 是目录里的 Key（取数要名字、id），目录里没有的（已删）带上分段里记的名字和 id
export function segmentKeyTokens({ segmentKeys, ruleToken, metadata, upstreamStationId }) {
  const keys = Array.isArray(segmentKeys) && segmentKeys.length ? segmentKeys : null;
  if (!keys) return [{ token: ruleToken, deleted: false, own: true }];
  return keys.map((key) => {
    if (key.upstreamStationId != null && key.upstreamStationId !== upstreamStationId) return { token: null, deleted: false, foreign: true, key }; // 换到另一个上游的 Key：调用方去那个上游读
    const listed = (metadata?.tokens || []).find((item) => item.id === Number(key.tokenId));
    if (listed) return { token: listed, deleted: false };
    return { token: { id: Number(key.tokenId), name: key.tokenName ?? null, deleted: true }, deleted: true };
  });
}

// 几把 Key 各取一次的结果相加。全部 complete 才 complete；有一把还在等（emptySecondWindow）整体就在等；
// 金额两边都按各自的单位（New API 是额度，Sub2API 是美元）相加，单位不一样（不该出现）当读不到
export function sumKeyStats(results) {
  if (results.length === 1) return results[0];
  const first = results[0];
  const sum = (field) => results.every((item) => Number.isFinite(item[field])) ? results.reduce((total, item) => total + item[field], 0) : null;
  const complete = results.every((item) => item.complete === true || item.state === "complete");
  const pending = results.some((item) => item.emptySecondWindow);
  const quotaPerUnits = new Set(results.map((item) => item.quotaPerUnit ?? null));
  const mixedUnits = quotaPerUnits.size > 1;
  const quotaUnits = mixedUnits ? null : sum("quotaUnits");
  const quotaPerUnit = mixedUnits ? null : first.quotaPerUnit ?? null;
  // 单位不一样（New API 的额度、Sub2API 的美元：换到另一个上游的 Key 在过渡段里和旧 Key 一起算）：各自折成美元再相加，额度不加
  const amountUsd = complete ? (mixedUnits ? sum("amountUsd") : first.quotaPerUnit != null ? (quotaUnits == null ? null : quotaUnits / quotaPerUnit) : sum("amountUsd")) : null;
  const known = results.map((item) => item.knownAmountUsd ?? item.amountUsd);
  const knownAmountUsd = known.every(Number.isFinite) ? known.reduce((total, value) => total + value, 0) : null;
  return { ...first, state: pending ? "pending" : complete ? "complete" : results.some((item) => item.state === "partial") ? "partial" : "unavailable",
    complete: complete && !pending, emptySecondWindow: pending || undefined, quotaUnits, quotaPerUnit, amountUsd, knownAmountUsd,
    ...(first.actualCostUsd != null ? { actualCostUsd: sum("actualCostUsd") } : {}),
    latestLogAtMs: Math.max(...results.map((item) => item.latestLogAtMs || 0)) || first.latestLogAtMs,
    keyCount: results.length };
}

// 按 Key 整体取数的规则（scoped：immediate / next-complete-day）一个窗口原来只用最新那一段的 Key 整窗取上游成本；
// 窗口里换过 Key 时（K2b 开的段）旧 Key 在换之前的用量、过渡段 [a, b) 里的两把都得取到：把窗口按段切成几截，每截用自己那段的 Key。
// 返回 null（窗口里各段用的 Key 都一样，包括只是倍率变了的、没换过 Key 的——保持原来的整窗单次取数，结果逐字不变）
// 或者 [{ segment, window }]：按时间排好、首尾相接，相邻两截 Key 一样的合成一截（少打上游）。
// 第一段的起点不当边界（核算起点那天从 0 点起整天算，段起点可能是当天中途），最后一段的终点不当边界。
export function keyPiecesOf(segments, window, ruleTokenId) {
  const list = (Array.isArray(segments) ? segments : []).filter((segment) => Number.isFinite(Number(segment?.effectiveFrom)))
    .sort((a, b) => Number(a.effectiveFrom) - Number(b.effectiveFrom));
  if (list.length < 2) return null;
  const idsOf = (segment) => (Array.isArray(segment.keys) && segment.keys.length ? segment.keys.map((key) => String(key.tokenId)) : [String(ruleTokenId)]).sort().join(",");
  const pieces = [];
  list.forEach((segment, index) => {
    const startMs = index === 0 ? window.startMs : Math.max(window.startMs, Number(segment.effectiveFrom));
    const endMs = Math.min(window.endMs, segment.effectiveTo == null ? Infinity : Number(segment.effectiveTo));
    if (!(startMs < endMs)) return;
    const ids = idsOf(segment), last = pieces.at(-1);
    if (last && last.ids === ids && last.window.endMs === startMs) { last.window = { ...last.window, endMs }; return; }
    pieces.push({ segment, window: { ...window, startMs, endMs }, ids });
  });
  // 只剩一截、而且它的 Key 就是最新那段的：和原来整窗用最新段一样，不用改。一截但不是最新段的 Key（窗口整个落在换 Key 之前，
  // 比如换了以后又去读换之前的某一天）也得走这里，不然整天会拿新 Key 去取
  if (pieces.length < 2 && pieces[0]?.ids === idsOf(list.at(-1))) return null;
  if (!pieces.length) return null;
  return pieces.map(({ segment, window: pieceWindow }) => ({ segment, window: pieceWindow }));
}

// 每把 Key 在这个窗口里归一条绑定的时间段（结账前的占用检查和 Sub2API 逐条拆账共用，只有这一份）：按每一截（keyPiecesOf 切出来的段 ∩ 窗口）的段认领，
// 再和这把 Key 的认领下限 claimFloors（Map：Key id → 毫秒）取交集，相邻的并成一段。段里没记 Key 的（老数据）用 fallbackKey（这条绑定自己的那把）。
// 返回 Map：「上游:Key」 → { key, windows: [{ startMs, endMs }] }
export function claimedKeyWindows(pieces, { fallbackKey, claimFloors = null } = {}) {
  const claimed = new Map();
  for (const { segment, window: piece } of pieces) {
    const keys = segment.keys?.length ? segment.keys : [fallbackKey];
    for (const key of keys) {
      const id = `${key.upstreamStationId ?? ""}:${key.tokenId}`;
      const startMs = Math.max(piece.startMs, claimFloors?.get(id) ?? -Infinity), endMs = piece.endMs;
      if (!(startMs < endMs)) continue;
      const entry = claimed.get(id) || { key, windows: [] };
      const last = entry.windows.at(-1);
      if (last && last.endMs === startMs) last.endMs = endMs; else entry.windows.push({ startMs, endMs });
      claimed.set(id, entry);
    }
  }
  return claimed;
}

// 结账前的 Key 占用检查（纯计算，不读库）：同一个自营站点下，这一天里每把 Key 被哪几条绑定认领了哪些时间段。
//   重叠：两条绑定认领了同一把 Key 的同一段时间——这段的上游成本会算两遍。
//   空档：一条绑定认领这把 Key 到 t1 为止（它自己还在算，没停），另一条也在算的绑定从 t2 > t1 才认领——t1 到 t2 之间的用量没人算。
//     停掉的绑定（t1 就是它停的那一刻）、后来才建的绑定（t1 时它还没在算）、这把 Key 后来没有任何在算的绑定认领（挪给了没在算的渠道），都是正常的空档，不算。
// claimants：[{ ruleId, startMs, archivedAtMs, claims: Map（claimedKeyWindows 的结果） }]；keyIds：只看这些 Key（被检查的那条绑定这一天用到的）。
// 返回 [{ type: "overlap" | "gap", keyId, key, ruleIds: [先, 后], fromMs, toMs }]，空数组就是没问题
export function keyClaimProblems(claimants, keyIds) {
  const problems = [];
  const runningAt = (claimant, atMs) => (claimant.startMs == null || claimant.startMs <= atMs) && (claimant.archivedAtMs == null || claimant.archivedAtMs > atMs);
  for (const keyId of keyIds) {
    const items = [];
    for (const claimant of claimants) {
      const entry = claimant.claims.get(keyId);
      if (entry) for (const window of entry.windows) items.push({ claimant, key: entry.key, startMs: window.startMs, endMs: window.endMs });
    }
    items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let reach = null; // 前面各段里最晚的结束，和它的主人
    for (const item of items) {
      if (reach && reach.claimant.ruleId !== item.claimant.ruleId) {
        if (item.startMs < reach.endMs) problems.push({ type: "overlap", keyId, key: item.key, ruleIds: [reach.claimant.ruleId, item.claimant.ruleId], fromMs: item.startMs, toMs: Math.min(reach.endMs, item.endMs) });
        else if (item.startMs > reach.endMs && runningAt(reach.claimant, reach.endMs) && runningAt(item.claimant, reach.endMs)) problems.push({ type: "gap", keyId, key: item.key, ruleIds: [reach.claimant.ruleId, item.claimant.ruleId], fromMs: reach.endMs, toMs: item.startMs });
      }
      if (!reach || item.endMs > reach.endMs) reach = { claimant: item.claimant, endMs: item.endMs };
    }
  }
  return problems;
}
