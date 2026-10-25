// 自营站点记不记收费记录（New API 的 LogConsumeEnabled，用语规范里叫「收费记录」）：关着的时间段怎么记、哪段窗口碰到了关着的段。
// 纯函数，服务端、页面都能用（不引 node: 模块）。读设置的是 lib/providers.js 的 queryOwnConsumeLog，存的是站点记录上的
// consumeLogOffPeriods（own-revenue-plan 第二节）；这里只管：读到开着/关着以后段怎么变，一段窗口碰没碰到关着的段。
export const CONSUME_LOG_KEEP_MS = 31 * 24 * 3600000; // 只留最近 31 天（终点早于这个的段删掉）
export const CONSUME_LOG_LOOKBACK_MS = 120000; // 起点往前留 120 秒：站点的钟和这边不一样，最新一条日志的时刻不是读到它那一刻

const finite = (value) => Number.isFinite(Number(value)) && value != null;

// 存进站点记录的样子：[{ fromMs, toMs | null }]，按起点排好，坏的丢掉（toMs 为 null 表示还关着；最多只有一段还关着）
export function normalizeOffPeriods(input) {
  if (!Array.isArray(input)) return [];
  const periods = input.filter((item) => finite(item?.fromMs) && (item.toMs == null || (finite(item.toMs) && Number(item.toMs) >= Number(item.fromMs))))
    .map((item) => ({ fromMs: Number(item.fromMs), toMs: item.toMs == null ? null : Number(item.toMs) }))
    .sort((a, b) => a.fromMs - b.fromMs);
  // 有两段都没结束（数据坏了才会有）：前面那段当作在下一段开始时就关了
  return periods.map((period, index) => period.toMs == null && index < periods.length - 1 ? { ...period, toMs: Math.max(period.fromMs, periods[index + 1].fromMs) } : period);
}

/**
 * 读到设置以后，关着的段怎么变（返回新的段；没变化返回 null，调用方不写库）。
 * reading：{ state: "on" | "off", at }；offFromMs：这次读到关着、而且还没有一段在关着时，这一段从哪起算
 * （最后一次能证明开着的时刻，调用方按「内存里最近读到开着的时刻」「最新一条日志的时刻往前 120 秒」取最晚的）。
 */
export function applyConsumeLogReading(periods, reading, { offFromMs = null } = {}) {
  const current = normalizeOffPeriods(periods);
  const at = Number(reading.at);
  const prune = (list) => list.filter((period) => period.toMs == null || period.toMs >= at - CONSUME_LOG_KEEP_MS);
  const open = current.find((period) => period.toMs == null) ?? null;
  let next = current;
  if (reading.state === "off" && !open) {
    const fromMs = finite(offFromMs) ? Math.min(Number(offFromMs), at) : at;
    next = [...current, { fromMs, toMs: null }];
  } else if (reading.state === "on" && open) {
    next = current.map((period) => period === open ? { ...period, toMs: Math.max(at, period.fromMs) } : period);
  }
  next = prune(next);
  const same = next.length === current.length && next.every((period, index) => period.fromMs === current[index].fromMs && period.toMs === current[index].toMs);
  return same ? null : next;
}

/**
 * 一段窗口 [startMs, endMs) 碰没碰到关着的段：{ open: 碰到还关着的那一段, closed: 碰到已经开回来的段 }。
 * 还关着的段当作一直关到现在（终点算无穷大）。
 */
export function consumeLogOffOverlap(periods, window) {
  const out = { open: false, closed: false };
  // 起点不早于终点（整天都在开始统计之前，裁剪以后是空的）：没有碰到什么
  if (!window || !finite(window.startMs) || !finite(window.endMs) || Number(window.startMs) >= Number(window.endMs)) return out;
  for (const period of normalizeOffPeriods(periods)) {
    const to = period.toMs == null ? Infinity : period.toMs;
    if (period.fromMs < window.endMs && to > window.startMs) out[period.toMs == null ? "open" : "closed"] = true;
  }
  return out;
}

// New API 返回的设置项里 LogConsumeEnabled 的值：和它自己的判断一样，字符串里只有 "true" 算开，其余字符串都算关；布尔照字面；这一项缺了（undefined、null）返回 null（读不到）
export function parseConsumeLogValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return null;
}
