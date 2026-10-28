// 分段记 Key（计划 K1c）：一段里可能有几把 Key，上游成本是这几把各取一次再相加（k-plan 3.5）。
// 这一版每段只有一把（rules 上那把），走的还是原来的单次取数，结果逐字不变；多把 Key、已删 Key 的路径给 K2b 开段以后用。

// 这一段要取的 Key。segmentKeys 是仓库给分段带的 segment.keys（不进 JSON）；没有就是这条绑定自己的那把。
// 返回 { token, deleted }：token 是目录里的 Key（取数要名字、id），目录里没有的（已删）带上分段里记的名字和 id
export function segmentKeyTokens({ segmentKeys, ruleToken, metadata, upstreamStationId }) {
  const keys = Array.isArray(segmentKeys) && segmentKeys.length ? segmentKeys : null;
  if (!keys) return [{ token: ruleToken, deleted: false, own: true }];
  return keys.map((key) => {
    if (key.upstreamStationId != null && key.upstreamStationId !== upstreamStationId) return { token: null, deleted: false, foreign: true, key };
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
  const amountUsd = complete && !mixedUnits ? (first.quotaPerUnit != null ? (quotaUnits == null ? null : quotaUnits / quotaPerUnit) : sum("amountUsd")) : null;
  const known = results.map((item) => item.knownAmountUsd ?? item.amountUsd);
  const knownAmountUsd = known.every(Number.isFinite) ? known.reduce((total, value) => total + value, 0) : null;
  return { ...first, state: pending ? "pending" : complete ? "complete" : results.some((item) => item.state === "partial") ? "partial" : "unavailable",
    complete: complete && !pending, emptySecondWindow: pending || undefined, quotaUnits, quotaPerUnit, amountUsd, knownAmountUsd,
    ...(first.actualCostUsd != null ? { actualCostUsd: sum("actualCostUsd") } : {}),
    latestLogAtMs: Math.max(...results.map((item) => item.latestLogAtMs || 0)) || first.latestLogAtMs,
    keyCount: results.length };
}
