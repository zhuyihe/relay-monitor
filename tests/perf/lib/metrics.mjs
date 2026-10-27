// 稳态窗口里两个循环的轮数不一定一样多（结账轮询是「上一轮结束后再等 60 秒」），按轮折算才可比
export function perRound(bg) {
  const s = bg?.steady, r = bg?.refreshRound;
  if (!s || !r || !s.reconRounds?.length) return null;
  const sql = Math.round((s.sqlStatements - s.balanceRounds * r.sqlStatements) / s.reconRounds.length);
  const binlog = s.binlogBytes == null ? 0 : Math.round((s.binlogBytes - s.balanceRounds * (r.binlogBytes || 0)) / s.reconRounds.length);
  const rowsExamined = s.rowsExamined == null || r.rowsExamined == null ? null
    : Math.round((s.rowsExamined - s.balanceRounds * r.rowsExamined) / s.reconRounds.length);
  return { sql, binlog, rowsExamined, fake: Math.round((s.fakeRequests - s.balanceRounds * r.fakeRequests) / s.reconRounds.length) };
}

// 整站读（「算应付成本」，应付成本 V1）的三样数，compare 和 summarize 共用：[名字, 类别, 取值函数]。
// 没开开关、base 是没有 own_log_cursor 表的旧版、老结果里没有 ingest 时，值是「不适用」（不是报错）
export const NA = "不适用";
export function duration(ms) {
  if (ms == null) return NA;
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  const min = Math.round(ms / 60000);
  return min < 120 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}
export const INGEST_ROWS = [
  ["每轮 整站读请求（自营 /api/log/ 不带筛选）", "可比", (g) => g.perRound.ownLogAll],
  ["每轮 自营站点全部请求", "可比", (g) => g.perRound.ownRequests],
  ["整站读 任意 180 秒最多 / 360", "可比", (g) => `${g.rateLimit.ownLogAllMax}（${g.rateLimit.ownLogAllMaxPct}%）`],
  ["整站读 180 秒平均 / 360", "可比", (g) => `${g.rateLimit.ownLogAllAvg}（${g.rateLimit.ownLogAllAvgPct}%）`],
  ["整站读 每 300 秒平均", "可比", (g) => (g.rateLimit.ownLogAllAvg300 == null ? NA : g.rateLimit.ownLogAllAvg300)],
  ["自营站点全部 任意 180 秒最多 / 360", "可比", (g) => `${g.rateLimit.ownMax}（${g.rateLimit.ownMaxPct}%）`],
  ["自营站点全部 180 秒平均 / 360", "可比", (g) => `${g.rateLimit.ownAvg}（${g.rateLimit.ownAvgPct}%）`],
  ["自营站点全部 每 300 秒平均", "可比", (g) => (g.rateLimit.ownAvg300 == null ? NA : g.rateLimit.ownAvg300)],
  ["窗口开始 落后（现在 − 120 秒 − 进度）", "参考", (g) => (g.cursorTable && g.catchUp ? duration(g.catchUp.behindStartMs) + (g.catchUp.startFromCursor ? "" : "（窗口开始还没进度，按起点算）") : NA)],
  ["窗口结束 落后", "参考", (g) => (g.cursorTable && g.catchUp ? duration(g.catchUp.behindEndMs) : NA)],
  ["每分钟追了（分钟日志 / 分钟）", "参考", (g) => (g.cursorTable && g.catchUp ? g.catchUp.minutesPerMinute : NA)],
  ["推算：刚打开（从昨天 0 点起）到追平", "参考", (g) => (g.cursorTable && g.catchUp ? (g.catchUp.etaFromFreshMs == null ? "追不上（每分钟追的不到 1 分钟）" : duration(g.catchUp.etaFromFreshMs)) : NA)],
  ["推算：从窗口结束到追平", "参考", (g) => (g.cursorTable && g.catchUp ? (g.catchUp.etaFromNowMs == null ? "追不上" : duration(g.catchUp.etaFromNowMs)) : NA)],
  ["own_log_buckets 行数（窗口结束）", "参考", (g) => (g.cursorTable ? g.progress?.end?.buckets ?? NA : NA)],
];
export function ingestCell(bg, get) {
  const g = bg?.steady?.ingest;
  if (!g) return NA;
  try { return get(g) ?? NA; } catch { return NA; }
}
// 每轮明细：整站读请求、全部请求、问额度前 180 秒已用、推算额度
export function ingestRoundLine(x) {
  return `${x.startAt.slice(11, 19)}：整站读 ${x.ownLogAll}，自营全部 ${x.ownRequests}，问额度前 180 秒已用 ${x.usedBefore}${x.usedPartial ? "（窗口开头不满 180 秒，偏少）" : ""}，推算额度 ${x.allowanceEstimate}`;
}

// 开关的实际值（量之前、量完以后各读一次 GET /api/settings 的 expectedCost）和这段时间实际看到的整站读请求数。
// 实际是关、整站读却不是 0 才算异常（anomaly）。老结果里没有 switch 时按「读不到」写
const switchWord = (v) => (v === true ? "开" : v === false ? "关" : v === null ? "这个版本没有这个开关" : "读不到");
export function ingestSwitch(bg) {
  const g = bg?.steady?.ingest;
  if (!g) return { text: NA, anomaly: false };
  const before = g.switch?.before, after = g.switch?.after;
  const state = !g.switch ? "读不到" : before === after ? switchWord(before) : `量之前${switchWord(before)}、量完${switchWord(after)}`;
  const n = g.ownLogAllTotal ?? g.ownLogKinds?.all ?? null;
  const off = g.switch && (before === false || before === null) && (after === false || after === null);
  const anomaly = Boolean(off && n > 0);
  return { text: `${state}，这段时间整站读 ${n ?? "?"} 个请求${anomaly ? "（开关关着却有整站读）" : ""}`, anomaly };
}

// 「接口量完以后等了 N 秒才开稳态」（steady_delay_sec 和整站读场景的 185 秒取大的）；老结果里没有就写「没记」
export function steadyDelayText(bg) {
  const d = bg?.steadyDelay;
  return d ? `接口量完以后等了 ${d.waitedSec} 秒才开稳态（steady_delay_sec=${d.requestedSec}）` : "接口量完以后等了多久：没记（老结果）";
}
