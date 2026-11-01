// 模型供需 v5「缺货失败」的几个纯函数（lib/models-headroom.js 的 buildHeadroom 用）：主要原因、失败最多的时段、按原因给的建议。
// 「缺货失败」= 近 24 小时最终没买到的请求（F，server/own-error-supply.js，下限）；原因只分四种：没钱（auth_quota）、限流（rate_limit）、故障（upstream）、没渠道（no_channel）。
export const LOST = Object.freeze({
  FAIL_WINDOW_HOURS: 3, // 失败最多的时段最长连续几小时
  FAIL_TRIM_BELOW: 0.7, // 时段两头的小时低于窗口里最高那个小时的这个比例就去掉
});

// 主要原因：没有开着的渠道 → no_channel（不管有没有失败，货根本没地方来）；否则按 F 的原因拆开，最多的那个；一样多时 没钱 > 限流 > 故障。F 全是 0 返回 null
export function causeOf({ noOpenChannel, byReason }) {
  if (noOpenChannel) return "no_channel";
  let best = null;
  for (const reason of ["auth_quota", "rate_limit", "upstream"]) if ((byReason[reason] || 0) > (best ? byReason[best] : 0)) best = reason;
  return best;
}

// 失败最多的时段：hours 是按时间先后的最近 24 个小时 [{ hour（墙上时钟 0–23）, f }]，找连续 FAIL_WINDOW_HOURS 小时里 f 加起来最多的，
// 两头太低（低于最高那个小时的 70%）的去掉，最短 1 小时；一个失败都没有返回 null。返回 { hours: [钟点…] }，可以跨午夜（[23, 0]）
export function failWindow(hours) {
  const L = Math.min(LOST.FAIL_WINDOW_HOURS, hours.length);
  let best = -1, bestSum = 0;
  for (let start = 0; start + L <= hours.length; start += 1) {
    let sum = 0;
    for (let k = 0; k < L; k += 1) sum += hours[start + k].f;
    if (sum > bestSum) { bestSum = sum; best = start; }
  }
  if (best < 0) return null;
  let window = hours.slice(best, best + L);
  const top = Math.max(...window.map((h) => h.f));
  while (window.length > 1) {
    const head = window[0].f, tail = window[window.length - 1].f;
    if (Math.min(head, tail) >= LOST.FAIL_TRIM_BELOW * top) break;
    window = head <= tail ? window.slice(1) : window.slice(0, -1);
  }
  return { hours: window.map((h) => h.hour) };
}

// 建议，按原因给，只给数、不替用户改站（页面拼字）：
//   auth_quota  → topup：先给 X 充值（hoursLeft：它的余额还能撑几小时，读不到是 null）
//   rate_limit  → rateLimit：给 X 加 Key（addKeys：{ n, perKey }，只在测到上限时有，否则 null；accountLimited：X 是按账号限的，加 Key 没用，该找它提额度），或把量挪到 Y（moveTo，没有可挪的是 null）
//   upstream    → fault：X 在出错，先把量挪到 Y（moveTo）
//   no_channel  → openChannel：这个模型没有开着的渠道，去开一个
//   没有原因    → none
// main：失败最多的那家上游 { upstreamId, name }，没有（渠道没绑上游）是 null；moveTo：{ upstreamId, name } 或 null
export function lostRecoOf({ cause, main, hoursLeft = null, moveTo = null, addKeys = null, accountLimited = false }) {
  const up = main ? { upstreamId: main.upstreamId, name: main.name } : { upstreamId: null, name: null };
  if (cause === "no_channel") return { kind: "openChannel" };
  if (cause === "auth_quota") return { kind: "topup", ...up, hoursLeft };
  if (cause === "rate_limit") return { kind: "rateLimit", ...up, accountLimited, addKeys: accountLimited ? null : addKeys, moveTo };
  if (cause === "upstream") return { kind: "fault", ...up, moveTo };
  return { kind: "none" };
}
