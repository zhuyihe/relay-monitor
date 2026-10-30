// 上游列表的默认排法（纯函数，不依赖 React；表格和手机卡片用同一个）。从上到下四组：
//   1 要马上动手的：余额用完、读不到余额（含登录过期）、身上挂着红色需处理的（组内先用完，再读不到，再红色需处理，同类按名字）；
//   2 正在花钱的（余额读得到、isSpending）：按「照最近的花法还能撑多少小时」从短到长；包月的上游有到期日的也在这一组，按离到期还剩多少小时排；
//   3 最近没在花钱的（含还没读取、算不出速度的）：按余额从多到少，按页面上显示的人民币金额比（没设汇率的按原数）；
//   4 最底下：自营站点、不再续费的（按名字）。
// 小时现算、不舍入：后台的可用天数舍到 0.1 天，差几个小时的上游会并列，并列就只剩名字顺序，一直不变。
const HOUR_MS = 3600 * 1000;
const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN");

// item：{ id, name, bottom（自营站点或不再续费）, red（挂着红色需处理）, empty（余额用完）, unreadable（读不到余额）,
//         remaining（余额，美元额度）, burnPerDay（日均花费，同一单位；没在花钱是 0 或 null）, cny（页面上显示的人民币余额）, endAt（包月的到期时间戳，没有是 null）}
export function hoursLeft(item, now) {
  if (item.endAt != null) return Math.max(0, (Number(item.endAt) - now) / HOUR_MS);
  if (!item.unreadable && !item.empty && Number(item.remaining) > 0 && Number(item.burnPerDay) > 0) return (Number(item.remaining) / Number(item.burnPerDay)) * 24;
  return null;
}

export function upstreamGroupOf(item, now) {
  if (item.bottom) return 4;
  if (item.empty || item.unreadable || item.red) return 1;
  return hoursLeft(item, now) != null ? 2 : 3;
}

const urgency = (item) => (item.empty ? 0 : item.unreadable ? 1 : 2);

export function orderUpstreams(items, now) {
  const rank = new Map(items.map((item) => [item.id, { group: upstreamGroupOf(item, now), hours: hoursLeft(item, now) }]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id), rb = rank.get(b.id);
    if (ra.group !== rb.group) return ra.group - rb.group;
    if (ra.group === 1) return urgency(a) - urgency(b) || byName(a, b);
    if (ra.group === 2) return ra.hours - rb.hours || byName(a, b);
    if (ra.group === 3) return (Number(b.cny) || 0) - (Number(a.cny) || 0) || byName(a, b);
    return byName(a, b);
  });
}
