// 上游每天花了多少（从上游自己那边读到的）和日均花费的算法，只写在这一处。
// 页面和服务端共用，不引 node: 模块。
//   日均花费 = max（近 7 个整天的平均每天花费，最近 24 小时实际花费）
//     - 7 天平均让数字稳；最近 24 小时（用控制台自己的余额快照，只算下降的部分）是保险：花得突然变快时可用天数跟着变短，快用完提醒不会晚
//     - 近 7 天不满 7 天的数（上游才开了几天）按有数的那几天平均；开头还没花钱的那几天不算（那时账号多半还没开）
//     - 一天的数都没有（对方不给读、又是新加的）：返回 null，调用方退回余额快照的老办法（db/history.js）
import { shiftDayLabel } from "./business-time.js";

export const UPSTREAM_SPEND = Object.freeze({
  // 新上游第一次读余额成功以后，一次性读过去这么多个整天（New API 的 /api/data/self 一次最多一个月）
  BACKFILL_DAYS: 30,
  // 库里留这么多天
  KEEP_DAYS: 40,
  // 日均花费取近这么多个整天的平均
  AVERAGE_DAYS: 7,
  // 业务时区过了零点多久再读昨天（New API 的数据看板是定时写的，刚过零点昨天最后一段还没写全）
  DAILY_READ_DELAY_MS: 20 * 60000,
  // 花费突然暴涨时别等 24 小时慢慢反映：最近 3 小时的速度超过（近 7 天平均、最近 24 小时取大的）这么多倍，才按最近 3 小时的速度算。
  // 忙的时段本来就比全天平均快，倍数太小每天下午数字和排序又会跳（1.5 倍以内的忙闲交替不动它）
  SURGE_FACTOR: 2,
  // 对方不给读：隔这么久最多再问一次
  DENIED_RETRY_MS: 7 * 86400000,
  // 读失败（连不上、超时、对方繁忙）：第一次隔这么久再读，每次翻倍，最长 6 小时
  RETRY_BASE_MS: 10 * 60000,
  RETRY_MAX_MS: 6 * 3600000,
  // 补读几个上游之间隔开，一个补完再补下一个；按天退回 stat 时每个请求之间也隔开
  BACKFILL_GAP_MS: 20000,
  STAT_GAP_MS: 1000,
  // 后台多久看一次有没有要读的（没有要读的时候不发任何请求）
  TICK_MS: 5 * 60000,
});

// 近 AVERAGE_DAYS 个整天（today 前面的几天）的平均每天花费。rows：[{ day: "YYYY-MM-DD", usd }]；today：业务时区「今天」的日期。
// 这 7 天里一天的数都没有返回 null；开头连着的 0 不算（上游那时还没开始花钱）；读到了但全是 0 返回 { average: 0, days: 0 }
export function averageDailySpend(rows, today, days = UPSTREAM_SPEND.AVERAGE_DAYS) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const byDay = new Map(rows.map((row) => [row.day, Number(row.usd) || 0]));
  const values = [];
  for (let back = days; back >= 1; back -= 1) {
    const day = shiftDayLabel(today, -back);
    if (byDay.has(day)) values.push(byDay.get(day));
  }
  if (!values.length) return null;
  while (values.length && !(values[0] > 0)) values.shift();
  if (!values.length) return { average: 0, days: 0 }; // 读到了、近 7 天一分钱没花
  return { average: values.reduce((sum, value) => sum + value, 0) / values.length, days: values.length };
}

// 日均花费是怎么来的（prediction.basis）：week 近 7 天平均；fast24h 取的是最近 24 小时（花得比平时快）；fallback 没有每天花费、退回余额快照的老办法
export const SPEND_BASIS = Object.freeze({ week: "7d", fast: "fast24h", fallback: "fallback" });

// 日均花费：近 7 天平均和最近 24 小时实际花费取大的；再看最近 3 小时的速度（rate3h，每天多少，db/history.js burnRate 现成的那个，点不够算不出就是 null）：
// 超过上面那个数的 SURGE_FACTOR 倍，才按最近 3 小时的速度算（花费突然暴涨，快用完提醒不晚）。
// last24h：最近 24 小时余额快照里下降的总和（不满 24 小时就是读到多少算多少，不放大）。
// 返回 { burnPerDay, basis, days } 或 null（一天的数都没有，退回老办法）。basis 是 SPEND_BASIS 里的 week / fast（取了最近 24 小时或最近 3 小时），页面用 lib/format.js 的 basisText 读
export function dailyBurn({ rows, today, last24h = 0, rate3h = null }) {
  const week = averageDailySpend(rows, today);
  if (!week) return null;
  const recent = Number(last24h) > 0 ? Number(last24h) : 0;
  const base = Math.max(week.average, recent);
  if (Number(rate3h) > 0 && Number(rate3h) > UPSTREAM_SPEND.SURGE_FACTOR * base) return { burnPerDay: Number(rate3h), basis: SPEND_BASIS.fast, days: week.days };
  return recent > week.average
    ? { burnPerDay: recent, basis: SPEND_BASIS.fast, days: week.days }
    : { burnPerDay: week.average, basis: SPEND_BASIS.week, days: week.days };
}

// 哪些上游读得了「每天花了多少」：自营站点不读（它的余额不参与上游花费），固定成本、sk 密钥模式没有用量接口
export const SPEND_TYPES = Object.freeze(["newapi", "sub2api", "sub2api-password"]);
export const spendReadable = (station) => !!station && !station.isOwn && SPEND_TYPES.includes(station.type);

// 近 30 个整天（不含今天）里上游自己那边读到的天：{ state, days }。state：ok（读到了）/ denied（对方不给读以前的用量）/
// failed（上次读失败、会再试）/ pending（新上游，还没读到、正在读）
export function spendView(rows, { denied = false, failed = false, today } = {}) {
  const from = shiftDayLabel(today, -UPSTREAM_SPEND.BACKFILL_DAYS);
  const days = (rows || []).filter((row) => row.day >= from && row.day < today).map(({ day, usd }) => ({ day, usd }));
  return { state: days.length ? "ok" : denied ? "denied" : failed ? "failed" : "pending", days };
}
