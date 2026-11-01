// 用户余额（用户运营第一步）：纯函数，服务端的后台采集（server/user-ops.js）和以后的页面都用这里的算法。
// 「用户」都是自营站点（用户自己的 New API）上的用户，不是登录控制台的人。
//
// 还能用几天：
//   - 余额一直是每个用户一串快照 [[时刻, 美元]]（变了才写，没变每天补一条）；速度按钱包余额真正下降的速度算（有订阅的用户，套餐里的消费不扣余额，不能按用量算）；
//   - 每一格（相邻两次快照）：余额降了，降多少就算花多少；余额涨了，说明这格里有充值，这一格的消费改用「按小时的用量」里同一段时间的用量
//     （按重叠时长折算，假设一小时内匀速）；没变的算 0。最近 SETTLE_MS 内结束的涨格，用量还没到齐（quota_data 5 分钟落一次库、我们 10 分钟读一次），先不计；
//     涨格超过 FILL_MAX_GAP_MS（20 分钟）就不用用量补，这一格算 0：快照是变了才写，很长一段平稳说明钱包这段时间没在扣钱（可能在用套餐，也可能闲着），
//     这时再拿用量去补，会把套餐用掉的量算成钱包消费（平稳 22 小时、每小时 $10，然后充一次值，$70 的余额会被算成只剩 0.3 天，出一个假的快用完）；
//   - 分母只算余额大于 0 的时间（余额是 0 停用的几天不算进去）；
//   - 近 7 天和最近 24 小时各算一个速度，取快的（宁可早提醒）；
//   - 快照还不满 24 小时：算不出，写「—」，不判、不推送。
// 还能用几天 = 余额 ÷ 日均，日均舍到分以后是 0 就当近期没有花费（和上游同一个算法，db/history.js 的 forecastFrom）。
import { forecastFrom } from "../db/history.js";
import { BRAND } from "./brand.js";
import { dayKeyInTz } from "./business-time.js";

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

export const USER_BALANCE = Object.freeze({
  LEVEL1_DAYS: 0.5, // 快用完：预计 ≤ 半天（12 小时）用完；告警中心「重点用户快用完」的提醒线，默认值（站长可以改）
  CLEAR_FACTOR: 1.2, // 预计天数回到一级线的 1.2 倍以上才清零（防止在线上下抖动反复发）
  WARMUP_MS: DAY_MS, // 快照满 24 小时才判
  SETTLE_MS: 20 * 60000, // 最近这么久结束的涨格不计（用量还没到齐）
  FILL_MAX_GAP_MS: 20 * 60000, // 涨格的两头快照隔得比这个久，不用用量补（正常用钱包的用户每轮余额都在变，每一格都在一个采集间隔上下）
  WINDOW_MS: 7 * DAY_MS,
  FAST_WINDOW_MS: DAY_MS,
  MIN_POSITIVE_MS: 6 * HOUR_MS, // 余额大于 0 的时间不到这么久，算不出速度
  BIG_SHARE: 0.8, // 重点用户：近 7 天消费从高到低累加到全站的八成
  BIG_MIN: 3, // 至少 3 人
  FRESH_MS: 30 * 60000, // 快照或用量超过这么久没读成，标「数据过期」，不推送
  MIN_REPUSH_MS: DAY_MS, // 同一级 24 小时内不重复
});

// 一段时间 [t0, t1) 内的用量（美元）：hours 是 Map(小时起点 ms → 美元)；syncedMs 之后的部分还没读到，
// 当前这个不满一小时的桶只覆盖到 syncedMs，按已有的时长折算
export function usageUsdBetween(hours, t0, t1, syncedMs = Infinity) {
  if (!hours || !(t1 > t0)) return 0;
  let usd = 0;
  for (let hour = Math.floor(t0 / HOUR_MS) * HOUR_MS; hour < t1; hour += HOUR_MS) {
    const bucket = hours.get(hour);
    if (!(bucket > 0)) continue;
    const span = Math.min(HOUR_MS, Math.max(1, syncedMs - hour));
    const from = Math.max(t0, hour), to = Math.min(t1, hour + span);
    if (to > from) usd += bucket * ((to - from) / span);
  }
  return usd;
}

// 一个窗口里钱包余额真正花掉了多少、余额大于 0 的有多少毫秒；points 按时刻升序 [[t, 美元]]
export function walletConsumption(points, hours, { now, windowMs, syncedMs = now }) {
  const windowStart = now - windowMs;
  let consumed = 0, positiveMs = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [t0, b0] = points[i];
    const next = points[i + 1];
    const t1 = next ? next[0] : now, b1 = next ? next[1] : b0;
    const start = Math.max(t0, windowStart), end = Math.min(t1, now);
    if (!(end > start)) continue;
    if (b1 < b0 - 1e-9) {
      // 降：算在后一个快照那一刻；整格都在窗口里或后一个快照在窗口里才算
      if (t1 >= windowStart && t1 <= now) consumed += b0 - b1;
      if (b0 > 0) positiveMs += end - start;
    } else if (b1 > b0 + 1e-9) {
      // 涨：这一格有充值，消费用同一段时间的用量；用量还没到齐的格子整格先不计（时间也不计）；
      // 隔得太久的格子（t1 - t0 超过 FILL_MAX_GAP_MS）钱包这段没在扣钱，不用用量补，算 0（时间照算）
      if (t1 > now - USER_BALANCE.SETTLE_MS) continue;
      if (t1 - t0 <= USER_BALANCE.FILL_MAX_GAP_MS) consumed += usageUsdBetween(hours, start, end, syncedMs);
      if (b0 > 0) positiveMs += end - start;
    } else if (b0 > 0) positiveMs += end - start;
  }
  return { consumed, positiveMs, burnPerDay: positiveMs >= USER_BALANCE.MIN_POSITIVE_MS ? (consumed / positiveMs) * DAY_MS : null };
}

/**
 * 一个用户现在的余额状况。
 * points：这个用户的余额快照（升序）；hours：这个用户按小时的用量 Map（美元）；firstPointMs：最早一条快照的时刻（比 points 里的还早也行）。
 * 返回 { state, level, days, burnPerDay, balanceUsd, hasConsumption }：
 *   state：warming 快照不满 24 小时 / idle 余额是 0 但近 7 天没有消费（闲置号，不算）/ empty 余额用完（近 7 天有消费）/
 *          soon 预计快用完（level 1 或 2）/ ok 够用 / none 近期没有花费或算不出速度
 *   level：0 没事、1 快用完（预计 ≤ 提醒线，默认半天）、2 余额用完（只有两档，和上游监控一样；余额用完当轮就推，不用等 24 小时）
 */
export function userRunway({ points, hours, now, firstPointMs = points?.[0]?.[0], syncedMs = now, level1Days = USER_BALANCE.LEVEL1_DAYS }) {
  const last = points?.at(-1);
  if (!last) return { state: "warming", level: 0, days: null, burnPerDay: null, balanceUsd: null, hasConsumption: false };
  const balanceUsd = last[1];
  if (!(now - (firstPointMs ?? last[0]) >= USER_BALANCE.WARMUP_MS)) return { state: "warming", level: 0, days: null, burnPerDay: null, balanceUsd, hasConsumption: false };
  const week = walletConsumption(points, hours, { now, windowMs: USER_BALANCE.WINDOW_MS, syncedMs });
  const day = walletConsumption(points, hours, { now, windowMs: USER_BALANCE.FAST_WINDOW_MS, syncedMs });
  const hasConsumption = week.consumed > 0;
  const burn = Math.max(week.burnPerDay ?? 0, day.burnPerDay ?? 0);
  if (balanceUsd <= 0) return { state: hasConsumption ? "empty" : "idle", level: hasConsumption ? 2 : 0, days: hasConsumption ? 0 : null, burnPerDay: burn || null, balanceUsd, hasConsumption };
  if (!(burn > 0)) return { state: "none", level: 0, days: null, burnPerDay: null, balanceUsd, hasConsumption };
  const forecast = forecastFrom({ burnPerDay: burn, samples: points.length, spanHours: Math.min(168, (now - points[0][0]) / HOUR_MS) }, [now, balanceUsd], "wallet");
  if (forecast.etaDays == null) return { state: "none", level: 0, days: null, burnPerDay: null, balanceUsd, hasConsumption };
  const days = forecast.etaDays;
  // 只有两档，和上游监控一样：预计到提醒线以内是快用完（1），余额用完是 2
  const level = days <= level1Days ? 1 : 0;
  return { state: level ? "soon" : "ok", level, days, burnPerDay: forecast.burnPerDay, balanceUsd, hasConsumption };
}

// 每个用户近 7 天「有消费的那几天」的日均消费（美元，业务时区的自然日）：rows [{ username, hourMs, usd }]（已经限定在近 7 天）。返回 Map(username → 日均)
export function dailyAverages(rows, tz) {
  const days = new Map(); // username → Map(day → usd)
  for (const { username, hourMs, usd } of rows) {
    if (!(usd > 0)) continue;
    let byDay = days.get(username);
    if (!byDay) days.set(username, byDay = new Map());
    const day = dayKeyInTz(hourMs, tz);
    byDay.set(day, (byDay.get(day) || 0) + usd);
  }
  const out = new Map();
  for (const [username, byDay] of days) {
    let total = 0;
    for (const usd of byDay.values()) total += usd;
    out.set(username, total / byDay.size);
  }
  return out;
}

// 重点用户：按近 7 天消费从高到低排，往下累加到占全站近 7 天消费的八成为止（含跨过八成的那一位），至少 3 人，不足 3 人就全算。
// 排序和累加用的是同一个量（近 7 天消费），页面上「占近 7 天消费 26%」「合起来占 83%」说的也是它；「有消费那几天的日均」只用来算可用天数的速度。
// users：[{ id, week }]（week 是近 7 天消费），调用方已经排除管理员；返回按近 7 天消费从高到低的 id 数组
export function bigUsersOf(users, { share = USER_BALANCE.BIG_SHARE, min = USER_BALANCE.BIG_MIN } = {}) {
  const list = users.filter((user) => user.week > 0).sort((a, b) => b.week - a.week || String(a.id).localeCompare(String(b.id)));
  const total = list.reduce((sum, user) => sum + user.week, 0);
  const out = [];
  let cumulative = 0;
  for (const user of list) {
    if (out.length >= min && cumulative >= share * total - 1e-9) break;
    out.push(user.id);
    cumulative += user.week;
  }
  return out;
}

// 提醒判断：同一级 24 小时内不重复；预计天数回到一级线的 1.2 倍以上才清零重新计数。
// 只看余额涨了不算清零：一直在充小额的用户余额每小时都在涨，预计天数却没离开提醒线，不能每次充值都当没提醒过。
// prev：库里这个用户的状态 { level, notifiedAt, lastBalanceUsd }（没有是 null）；runway：userRunway 的结果；
// repushHours：给站长的重复提醒间隔（规则的 renotifyHours，0 = 只提醒一次；不小于 24 小时）
// 返回 { push, state }：push 为 true 就该推送这一级，state 是推完以后要存的状态
export function decideUserAlert({ prev, runway, now, repushHours = 24, level1Days = USER_BALANCE.LEVEL1_DAYS }) {
  const balance = runway.balanceUsd;
  let level = prev?.level ?? 0, notifiedAt = prev?.notifiedAt ?? null;
  const comfortable = runway.state === "ok" && runway.days != null && runway.days >= level1Days * USER_BALANCE.CLEAR_FACTOR;
  if (comfortable) { level = 0; notifiedAt = null; }
  const next = (extra) => ({ level, notifiedAt, lastBalanceUsd: balance, ...extra });
  if (runway.level > level) return { push: true, state: next({ level: runway.level, notifiedAt: now }) };
  const repushMs = repushHours > 0 ? Math.max(repushHours * HOUR_MS, USER_BALANCE.MIN_REPUSH_MS) : null;
  if (runway.level > 0 && runway.level === level && repushMs != null && notifiedAt != null && now - notifiedAt >= repushMs) return { push: true, state: next({ notifiedAt: now }) };
  return { push: false, state: next() };
}

// 推送的字（design/ui-copy-spec.md §10 用户余额）。一次推一条，几位一起推，按日均消费从高到低排
export const USER_ALERT_TEXT = Object.freeze({
  // 「【重点用户快用完】alice 可用约 2 天」「【重点用户余额用完】alice」；几位一起时写「alice 等 3 位」，正文里一位一行。全是余额用完才写余额用完
  title: (names, allEmpty, days) => `【${allEmpty ? "重点用户余额用完" : "重点用户快用完"}】${names.length === 1 ? `${names[0]}${days && !allEmpty ? ` 可用${days}` : ""}` : `${names[0]} 等 ${names.length} 位`}`,
  user: "用户",
  balance: "余额",
  burn: "日均花费",
  days: "还够",
  empty: "余额用完",
  daysValue: (days) => (days < 1 ? (days * 24 < 1 ? "不到 1 小时" : `约 ${Math.round(days * 24)} 小时`) : `约 ${Math.round(days * 10) / 10} 天`),
  note: "说明",
  noteText: "按钱包余额下降的速度估算；充到够用以后会重新计数",
  time: "时间",
});

const money = (usd) => `$${(Math.round(usd * 100) / 100).toFixed(2)}`;

// items：[{ username, balanceUsd, burnPerDay, days, level, dailyAvg }]；返回 { title, body }
export function userBalanceMessage(items, timeText) {
  const sorted = [...items].sort((a, b) => (b.dailyAvg || 0) - (a.dailyAvg || 0) || String(a.username).localeCompare(String(b.username)));
  const lines = [];
  for (const item of sorted) {
    const status = item.balanceUsd <= 0 ? USER_ALERT_TEXT.empty : `${USER_ALERT_TEXT.days}${USER_ALERT_TEXT.daysValue(item.days)}`;
    lines.push(`${USER_ALERT_TEXT.user}：${item.username} · ${USER_ALERT_TEXT.balance} ${money(item.balanceUsd)} · ${USER_ALERT_TEXT.burn} ${item.burnPerDay != null ? money(item.burnPerDay) : "—"} · ${status}`);
  }
  lines.push(`${USER_ALERT_TEXT.note}：${USER_ALERT_TEXT.noteText}`, `${USER_ALERT_TEXT.time}：${timeText}`, BRAND.notificationSignature);
  const allEmpty = sorted.every((item) => item.balanceUsd <= 0);
  return { title: USER_ALERT_TEXT.title(sorted.map((item) => item.username), allEmpty, sorted.length === 1 && sorted[0].days != null ? USER_ALERT_TEXT.daysValue(sorted[0].days) : ""), body: lines.join("\n") };
}
