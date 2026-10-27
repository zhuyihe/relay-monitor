// 每日利润的计算明细（用语规范 §9 的「上游成本（换了 Key 的那天）」「Key 挪到了别的渠道」）：一条绑定这一天换了 Key、Key 在两条绑定之间挪了手的那些时刻。
// 纯函数，不读库：segments 是仓库的分段（effectiveFrom、effectiveTo 毫秒，timingSource，keys: [{ upstreamStationId, tokenId, tokenName }]），day 是 { startMs, endMs }。
const idOf = (key) => `${key.upstreamStationId ?? ""}:${Number(key.tokenId)}`;
const keyOf = (key) => ({ upstreamStationId: key.upstreamStationId ?? null, tokenId: Number(key.tokenId), tokenName: key.tokenName ?? null });

// 这一天里这条绑定换 Key 的几次：[{ atMs, between, from, to }]，按时间排好。
//   between：换的时刻定不出时是 [a, b]（两次读取之间换的：过渡段的头和尾），定得出时是 null；atMs 是 b（定得出时就是换的那一刻）；
//   from：换走的那把 Key（上一段有、这一段没有的），to：换上的那把。只是倍率或分组变了、Key 没换的不算
export function keyChangesOnDay(segments, day) {
  const list = [...(Array.isArray(segments) ? segments : [])].filter((segment) => Number.isFinite(Number(segment?.effectiveFrom))).sort((x, y) => Number(x.effectiveFrom) - Number(y.effectiveFrom));
  const idsOf = (segment) => new Map((segment?.keys || []).map((key) => [idOf(key), key]));
  const inDay = (ms) => ms > day.startMs && ms < day.endMs;
  const changes = [];
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1], segment = list[index];
    if (previous.timingSource === "key_change_window") continue; // 过渡段结束：这次换 Key 已经在进过渡段那一刻记过
    const before = idsOf(previous), after = idsOf(segment);
    const arrived = [...after].filter(([id]) => !before.has(id)).map(([, key]) => key);
    if (segment.timingSource === "key_change_window") {
      // 过渡段 [a, b)：里面放着旧 Key 和新 Key，b 以后的下一段只有新 Key；换走的 = 上一段有、下一段没有的
      const next = idsOf(list[index + 1]);
      const gone = [...before].filter(([id]) => !next.has(id)).map(([, key]) => key);
      const from = Number(segment.effectiveFrom), to = Number.isFinite(Number(segment.effectiveTo)) ? Number(segment.effectiveTo) : from;
      if (!inDay(from) && !inDay(to)) continue;
      for (const oldKey of gone) for (const newKey of arrived) changes.push({ atMs: to, between: [from, to], from: keyOf(oldKey), to: keyOf(newKey) });
      continue;
    }
    const at = Number(segment.effectiveFrom);
    if (!inDay(at)) continue;
    const left = [...before].filter(([id]) => !after.has(id)).map(([, key]) => key);
    // 只有换走没有换上、或者只有换上没有换走（一组里有渠道走了 / 来了）：不是这条绑定自己换 Key，不在这里写
    for (const oldKey of left) for (const newKey of arrived) changes.push({ atMs: at, between: null, from: keyOf(oldKey), to: keyOf(newKey) });
  }
  return changes.sort((x, y) => x.atMs - y.atMs);
}

// 这一天 Key 在两条绑定之间挪了手：rule 这条绑定这一天换走的 Key，别的绑定在同一刻（相差不到一分钟）起握上了；或者 rule 换上的 Key 别的绑定在同一刻放下了。
// others：[{ id, channelNames, segments }]（同一个自营站点下别的绑定，在算的、已停的）。返回 [{ key, atMs, fromNames, toNames }]，同一把 Key 同一刻只记一次
const SAME_MOMENT_MS = 60000;
export function keyMovesOnDay(rule, changes, others, day) {
  const moves = [], seen = new Set();
  const starts = (other, key, atMs) => (other.segments || []).some((segment) => Math.abs(Number(segment.effectiveFrom) - atMs) <= SAME_MOMENT_MS && (segment.keys || []).some((item) => idOf(item) === idOf(key)) && Number(segment.effectiveFrom) > day.startMs);
  const ends = (other, key, atMs) => (other.segments || []).some((segment) => segment.effectiveTo != null && Math.abs(Number(segment.effectiveTo) - atMs) <= SAME_MOMENT_MS && (segment.keys || []).some((item) => idOf(item) === idOf(key)));
  for (const change of changes) {
    for (const other of others) {
      if (other.id === rule.id) continue;
      const out = starts(other, change.from, change.atMs), into = ends(other, change.to, change.atMs);
      if (out) { const id = `${idOf(change.from)}@${change.atMs}`; if (!seen.has(id)) { seen.add(id); moves.push({ key: change.from, atMs: change.atMs, fromNames: rule.channelNames, toNames: other.channelNames }); } }
      if (into) { const id = `${idOf(change.to)}@${change.atMs}`; if (!seen.has(id)) { seen.add(id); moves.push({ key: change.to, atMs: change.atMs, fromNames: other.channelNames, toNames: rule.channelNames }); } }
    }
  }
  return moves.sort((x, y) => x.atMs - y.atMs);
}
