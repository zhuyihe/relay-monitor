// 用户运营页（概览、用户两个页签和用户抽屉）要的数：纯函数，输入是后台采集存下来的东西（server/user-ops.js、server/user-ops-page.js 读出来给），
// 输出是接口的响应。钱都是美元，页面按自营站点的汇率换算。
// 口径（design 用户运营 v5–v7）：
//   - 「近 7 天」是最近 7 个整天，不含今天；「前 7 天」是再往前 7 个整天；今天单独一列，不混进去比；
//   - 状态一行只标一个，先后：余额用完 > 快用完 > 在下滑 > 不活跃 > 新用户；
//   - 在下滑：近 3 天日均比之前 14 天的日均少一半以上，之前 14 天日均不到 $5 的不判（要补满 17 个整天才判）；
//   - 不活跃：以前有消费，已经连续 7 个整天（含今天没有）没有消费（要补到 8 个整天才判）；
//   - 新用户：注册 7 天以内（用户列表里的注册时间），注册了还没用过的也算；
//   - 补数据（回补 30 天）还没补到的天不算：页面按 ready 里的几个开关写「—」「补满后再比」。
import { dayKeyInTz, dayStartInTz, shiftDayLabel } from "./business-time.js";
import { usageUsdBetween } from "./user-balance.js";

const HOUR_MS = 3600000, DAY_MS = 86400000;

export const USERS_VIEW = Object.freeze({
  DAYS: 35, // 读 35 天的按天消费（30 天趋势 + 余量）
  TREND_DAYS: 30,
  SPARK_DAYS: 14,
  WEEK: 7,
  NEW_MS: 7 * DAY_MS,
  DOWN_RECENT: 3,
  DOWN_BEFORE: 14,
  DOWN_MIN_DAILY_USD: 5,
  INACTIVE_DAYS: 7,
  TOP: 3, // 趋势图悬停：这天消费最多的前 3 个
});

// 每一天的起点（毫秒，业务时区）：从最早的一天到今天；indexOf(ms) 给这一刻在第几天（夏令时的 23/25 小时日也对）
export function dayGrid(now, tz, days = USERS_VIEW.DAYS) {
  const today = dayKeyInTz(now, tz);
  const keys = Array.from({ length: days }, (_, i) => shiftDayLabel(today, -(days - 1 - i)));
  const starts = keys.map((key) => dayStartInTz(key, tz));
  const indexOf = (ms) => {
    let i = Math.min(days - 1, Math.max(0, Math.floor((ms - starts[0]) / DAY_MS)));
    while (i > 0 && ms < starts[i]) i -= 1;
    while (i + 1 < days && ms >= starts[i + 1]) i += 1;
    return ms < starts[0] ? -1 : i;
  };
  return { today, keys, starts, indexOf, days };
}

const sum = (list) => list.reduce((total, value) => total + value, 0);

// 回补读到了的整天有几天：从昨天往前连续数（回补从今天往回补，cursorMs 是补到哪一刻）
export const filledFromOf = (backfill, now) => (backfill?.done ? -Infinity : backfill?.cursorMs ?? now);
export function availableDaysOf(grid, filledFrom) {
  let days = 0;
  for (let i = grid.days - 2; i >= 0 && grid.starts[i] >= filledFrom; i -= 1) days += 1;
  return days;
}
// 近 7 天（大客户、近 7 天消费）要补到 7 个整天
export const weekReadyOf = (grid, backfill, now) => availableDaysOf(grid, filledFromOf(backfill, now)) >= USERS_VIEW.WEEK;

/**
 * users：用户列表里的 [{ id, username, role, status, quotaUsd, createdAtMs }]
 * daily：Map(用户名 → 长度 DAYS 的数组，每天消费美元，最后一格是今天)；调用方只放没补到的天以外的数，没补到的天是 0，由 ready 说明
 * recentHours：Map(用户名 → Map(小时起点 ms → 美元))，昨天 0 点到现在（今天、昨天同一时段、最近使用用）
 * runways：Map(用户 id → server/user-ops.js 算好的余额状况 { state, level, days, burnPerDay, balanceUsd, big, dailyAvg })
 * backfill：{ done, days, total, cursorMs }；pointsFirstMs：余额快照最早一条的时刻（没有是 null）；prepaidAgo：7 天前的预收（没有是 null）
 */
export function buildUsersView({ now, tz, users, daily, recentHours, runways, backfill, pointsFirstMs = null, prepaidAgo = null, syncedMs = now, fresh = true }) {
  const grid = dayGrid(now, tz);
  const N = grid.days;
  const filledFrom = filledFromOf(backfill, now);
  const availableDays = availableDaysOf(grid, filledFrom);
  const ready = {
    backfillDone: !!backfill?.done,
    week: availableDays >= USERS_VIEW.WEEK, // 近 7 天消费、大客户
    compare: availableDays >= 2 * USERS_VIEW.WEEK, // 比前 7 天
    inactive: availableDays >= USERS_VIEW.INACTIVE_DAYS + 1,
    down: availableDays >= USERS_VIEW.DOWN_RECENT + USERS_VIEW.DOWN_BEFORE,
    balance: pointsFirstMs != null && now - pointsFirstMs >= 24 * HOUR_MS, // 可用天数等快照记满 24 小时
    prepaidCompare: prepaidAgo != null,
  };
  const eligible = users.filter((user) => user.role < 10 && (user.status === 1 || sum(daily.get(user.username) || []) > 0));
  const bigIds = ready.week ? eligible.filter((user) => runways.get(Number(user.id))?.big).sort((a, b) => (runways.get(Number(b.id)).dailyAvg || 0) - (runways.get(Number(a.id)).dailyAvg || 0) || a.id - b.id).map((user) => Number(user.id)) : [];
  const bigSet = new Set(bigIds);
  const adminNames = new Set(users.filter((user) => user.role >= 10).map((user) => user.username));

  const rows = [];
  const todayStart = grid.starts[N - 1], yesterdayStart = grid.starts[N - 2];
  for (const user of eligible) {
    const series = daily.get(user.username) || new Array(N).fill(0);
    const days = (from, to) => sum(series.slice(from, to + 1));
    const week = days(N - 8, N - 2), prevWeek = days(N - 15, N - 9);
    const recent3 = days(N - 1 - USERS_VIEW.DOWN_RECENT, N - 2) / USERS_VIEW.DOWN_RECENT;
    const before = days(N - 1 - USERS_VIEW.DOWN_RECENT - USERS_VIEW.DOWN_BEFORE, N - 2 - USERS_VIEW.DOWN_RECENT) / USERS_VIEW.DOWN_BEFORE;
    const hours = recentHours.get(user.username);
    let today = 0, lastHourMs = null;
    if (hours) for (const [hour, usd] of hours) {
      if (hour >= todayStart) today += usd;
      if (usd > 0 && (lastHourMs == null || hour > lastHourMs)) lastHourMs = hour;
    }
    // 最近使用：最近两天有消费的最后一小时；再早的按天（那天结束前的某个时刻，只写日子）
    let lastUsed = null;
    if (lastHourMs != null) lastUsed = { ms: lastHourMs + HOUR_MS, precise: true };
    else for (let i = N - 3; i >= 0; i -= 1) if (series[i] > 0) { lastUsed = { ms: grid.starts[i], precise: false }; break; }
    const runway = runways.get(Number(user.id)) || { state: "warming", level: 0, days: null, burnPerDay: null, balanceUsd: user.quotaUsd };
    const isNew = user.createdAtMs != null && now - user.createdAtMs < USERS_VIEW.NEW_MS && now >= user.createdAtMs;
    const hadBefore = series.slice(0, N - 8).some((value) => value > 0);
    const down = ready.down && before >= USERS_VIEW.DOWN_MIN_DAILY_USD && recent3 * 2 < before;
    const inactive = ready.inactive && hadBefore && week === 0 && today === 0;
    const status = runway.state === "empty" ? "empty" : runway.level >= 1 && runway.state === "soon" ? "soon" : down ? "down" : inactive ? "inactive" : isNew ? "new" : null;
    rows.push({
      id: Number(user.id), username: user.username, big: bigSet.has(Number(user.id)), disabled: user.status !== 1,
      createdAtMs: user.createdAtMs ?? null, isNew, week, prevWeek, today, balanceUsd: runway.balanceUsd ?? user.quotaUsd,
      runwayState: runway.state, days: runway.days ?? null, burnPerDay: runway.burnPerDay ?? null, level: runway.level || 0,
      status, lastUsed, spark: series.slice(N - 1 - USERS_VIEW.SPARK_DAYS, N - 1),
    });
  }

  // 趋势：每天的消费、有消费的用户数、新用户数，今天只到现在；悬停要这天消费最多的前 3 个
  const nonAdmin = [...daily.keys()].filter((name) => !adminNames.has(name));
  const trend = [];
  const firstTrend = N - USERS_VIEW.TREND_DAYS;
  for (let i = firstTrend; i < N; i += 1) {
    let cost = 0, users = 0;
    const top = [];
    for (const name of nonAdmin) {
      const value = daily.get(name)[i];
      if (!(value > 0)) continue;
      cost += value; users += 1; top.push({ username: name, cost: value });
    }
    top.sort((a, b) => b.cost - a.cost || a.username.localeCompare(b.username));
    trend.push({ day: grid.keys[i], available: grid.starts[i] >= filledFrom || i === N - 1, cost, users, newUsers: 0, top: top.slice(0, USERS_VIEW.TOP) });
  }
  // 新用户：每天新注册的人数；前 30 天也有（注册时间一读就有）
  const prevNew = new Array(USERS_VIEW.TREND_DAYS).fill(0);
  const prevStart = dayStartInTz(shiftDayLabel(grid.keys[firstTrend], -USERS_VIEW.TREND_DAYS), tz);
  for (const user of users) {
    if (user.role >= 10 || user.createdAtMs == null || user.createdAtMs >= now) continue;
    if (user.createdAtMs >= grid.starts[firstTrend]) { const i = grid.indexOf(user.createdAtMs); if (i >= firstTrend) trend[i - firstTrend].newUsers += 1; }
    else if (user.createdAtMs >= prevStart) prevNew[Math.min(USERS_VIEW.TREND_DAYS - 1, Math.floor((user.createdAtMs - prevStart) / DAY_MS))] += 1;
  }

  // 今天和昨天同一时段（按小时用量折算）
  let yesterdaySame = 0;
  const upTo = yesterdayStart + (now - todayStart);
  for (const user of eligible) { const hours = recentHours.get(user.username); if (hours) yesterdaySame += usageUsdBetween(hours, yesterdayStart, upTo); }
  const week = sum(rows.map((row) => row.week)), prevWeek = sum(rows.map((row) => row.prevWeek));
  const summary = {
    todayCost: sum(rows.map((row) => row.today)), yesterdaySameTime: yesterdaySame,
    weekCost: week, prevWeekCost: prevWeek,
    weekUsers: rows.filter((row) => row.week > 0).length, prevWeekUsers: rows.filter((row) => row.prevWeek > 0).length,
    prepaid: sum(rows.map((row) => row.balanceUsd || 0)), prepaidAgo,
  };
  return { asOf: now, tz, today: grid.today, ready, availableDays, backfill: { done: !!backfill?.done, days: backfill?.days ?? 0, total: backfill?.total ?? USERS_VIEW.TREND_DAYS }, fresh, syncedMs,
    big: { ready: ready.week, ids: bigIds, count: bigIds.length }, summary, trend, prevNewUsers: prevNew, users: rows };
}

// 抽屉：一个用户近 30 天每天的消费、今天每小时、余额变化和充值
export function buildUserDetail({ now, tz, user, series, hours, points }) {
  const grid = dayGrid(now, tz);
  const N = grid.days, first = N - USERS_VIEW.TREND_DAYS;
  const todayStart = grid.starts[N - 1];
  const dayBars = [];
  for (let i = first; i < N; i += 1) dayBars.push({ day: grid.keys[i], cost: series[i] || 0 });
  const hourBars = [];
  for (let hour = todayStart; hour <= now; hour += HOUR_MS) hourBars.push({ hourMs: hour, cost: hours?.get(hour) || 0 });
  // 余额变化：快照；往上跳的那一下是充值（和上游同一个门槛 0.05 美元），充值的数 = 涨了多少
  const balance = (points || []).map(([t, usd]) => ({ t, usd }));
  const recharges = [];
  for (let i = 1; i < balance.length; i += 1) if (balance[i].usd > balance[i - 1].usd + 0.05) recharges.push({ t: balance[i].t, usd: balance[i].usd - balance[i - 1].usd });
  return { id: user.id, username: user.username, dayBars, hourBars, balance, recharges };
}
