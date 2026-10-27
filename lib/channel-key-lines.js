// 「渠道」页签每个渠道下面的「用过的 Key」（用语规范 §3.1「用过的 Key」、binding-flow 第 3 节）：这个渠道在不同时间用过的 Key，
// 连同分组和倍率，一段一行。从这个渠道经手过的绑定（在算的和已停的）的分段里读出来：纯函数，不读库、不读上游。
//
// 一行 = { fromMs, toMs, between, key: { upstreamStationId, tokenId, tokenName }, group, ratio }：
//   fromMs 这把 Key 从什么时候起用（第一把是绑定开始算的时刻）；toMs 这一段到什么时候结束，还在用的是 null；
//   between 换的时刻定不出时（两次读取之间换的）是 [a, b]，页面写「15:19–16:05 之间换成 oai-2」，定得出时是 null；
//   group、ratio 是这一段的分组和倍率（Sub2API 读不到倍率，ratio 是 null）。
// 同一把 Key、同样的分组和倍率连着的几段并成一行（重新分组、合组时绑定换了一条，Key 没换，不多出一行）。时间从早到晚。
const keyIdOf = (key) => `${key.upstreamStationId ?? ""}:${key.tokenId}`;

// rules：这个渠道经手过的绑定，每条 { createdAt, billingEffectiveFrom, upstreamStationId, tokenId, tokenName, segments: [...] }；
// segments 是仓库的分段（effectiveFrom 毫秒、effectiveTo、group、ratio、timingSource、keys: [{ upstreamStationId, tokenId, tokenName }]）
export function channelKeyLines(rules) {
  const ordered = [...rules].sort((x, y) => (Date.parse(x.createdAt) || 0) - (Date.parse(y.createdAt) || 0));
  const lines = [];
  let previous = null; // 上一段用的那把 Key 的 id
  for (const rule of ordered) {
    const startedAt = Number.isFinite(rule.billingEffectiveFrom) ? rule.billingEffectiveFrom : Date.parse(rule.createdAt);
    const segments = [...(rule.segments || [])].sort((x, y) => x.effectiveFrom - y.effectiveFrom);
    segments.forEach((segment, index) => {
      const own = { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId, tokenName: rule.tokenName };
      const keys = Array.isArray(segment.keys) && segment.keys.length ? segment.keys : [own];
      // 过渡段 [a, b) 里放着两把 Key：用的是新换上的那把（上一段没有的）；没有上一段的（第一段）取绑定自己的
      const fresh = keys.filter((key) => keyIdOf(key) !== previous);
      const key = (segment.timingSource === "key_change_window" && fresh.length ? fresh[fresh.length - 1] : keys.find((item) => keyIdOf(item) === keyIdOf(own)) ?? keys[0]);
      const fromMs = index === 0 && lines.length === 0 ? startedAt : index === 0 ? Math.max(segment.effectiveFrom, startedAt) : segment.effectiveFrom;
      const line = { fromMs, toMs: segment.effectiveTo ?? null, between: segment.timingSource === "key_change_window" ? [segment.effectiveFrom, segment.effectiveTo] : null,
        key: { upstreamStationId: key.upstreamStationId ?? rule.upstreamStationId, tokenId: Number(key.tokenId), tokenName: key.tokenName ?? null }, group: segment.group ?? null, ratio: segment.ratio ?? null };
      const last = lines[lines.length - 1];
      if (last && keyIdOf(last.key) === keyIdOf(line.key) && last.group === line.group && last.ratio === line.ratio) {
        last.toMs = line.toMs;
        last.between ??= line.between;
      } else lines.push(line);
      previous = keyIdOf(line.key);
    });
  }
  return lines;
}
