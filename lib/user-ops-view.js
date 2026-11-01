// 用户运营页（概览、用户两个页签和用户抽屉）要的数：纯函数，输入是后台采集存下来的东西（server/user-ops.js、server/user-ops-page.js 读出来给），
// 输出是接口的响应。钱都是美元，页面按自营站点的汇率换算。
// 口径（design 用户运营 v5–v8）：
//   - 「近 7 天」是最近 7 个整天，不含今天；「前 7 天」是再往前 7 个整天；今天单独一列，不混进去比；
//   - 状态一行只标一个，先后：余额用完 > 快用完 > 在下滑 > 已流失 > 新消费；
//   - 在下滑：近 3 天日均比之前 14 天的日均少一半以上，之前 14 天日均不到 $5 的不判（要补满 17 个整天才判）；
//   - 已流失：前 30 天（近 7 天再往前的 30 个整天）里有消费，近 7 天（含今天）没有（要补到 37 个整天才判）；
//   - 新消费：第一次花钱在近 7 天以内（含今天）。「第一次」按累计消费判断：用户列表里的累计消费和这段数据里的消费合计差不多（差额不超过一点小误差），
//     说明以前一分没花过；不是「这段数据里第一次有用量」，不然隔了几个月又回来的老用户会被当成新的；
//   - 补数据（回补 90 天）还没补到的天不算：页面按 ready 里的几个开关写「—」「补满后再比」。
import { dayKeyInTz, dayStartInTz, shiftDayLabel } from "./business-time.js";
import { usageUsdBetween } from "./user-balance.js";

const HOUR_MS = 3600000, DAY_MS = 86400000;

export const USERS_VIEW = Object.freeze({
  DAYS: 90, // 读 90 天的按天消费（近 30 天趋势 + 前 30 天的虚线；月留存要再往前 30 天）
  TREND_DAYS: 30,
  SPARK_DAYS: 14,
  WEEK: 7,
  NEW_DAYS: 7, // 新消费：第一次花钱在最近 7 个整天加今天以内
  NEW_TOL_USD: 0.5, // 累计消费和这段数据的合计差多少以内算「以前没花过」：取这个和累计消费的 2% 里大的（数据看板每几分钟才落一次）
  NEW_TOL_SHARE: 0.02,
  DOWN_RECENT: 3,
  DOWN_BEFORE: 14,
  DOWN_MIN_DAILY_USD: 5,
  CHURN_DAYS: 7, // 近 7 天没有消费
  CHURN_BEFORE: 30, // 之前 30 天里有消费
  ACTIVE_DAYS: 30, // 用户页签的默认范围：近 30 天有消费
  PAGE_SIZE: 50,
  TOP: 3, // 趋势图悬停：这天消费最多的前 3 个
  NEW_TOP: 5, // 新消费用户的悬停：列出前 5 位
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
// 近 7 天（重点用户、近 7 天消费）要补到 7 个整天
export const weekReadyOf = (grid, backfill, now) => availableDaysOf(grid, filledFromOf(backfill, now)) >= USERS_VIEW.WEEK;

/**
 * users：用户列表里的 [{ id, username, role, status, quotaUsd, usedUsd（累计消费）, createdAtMs, group }]
 * daily：Map(用户名 → 长度 DAYS 的数组，每天消费美元，最后一格是今天)；调用方只放没补到的天以外的数，没补到的天是 0，由 ready 说明
 * recentHours：Map(用户名 → Map(小时起点 ms → 美元))，昨天 0 点到现在（今天、昨天同一时段、最近使用用）
 * runways：Map(用户 id → server/user-ops.js 算好的余额状况 { state, level, days, burnPerDay, balanceUsd, big, dailyAvg })
 * backfill：{ done, days, total, cursorMs }；pointsFirstMs：余额快照最早一条的时刻（没有是 null）；prepaidAgo：7 天前的预收（没有是 null）
 * 返回的 users 是全部的行；接口给页面的是 queryUsers 筛、排、切片以后的一页（概览要的几个数已经在 summary、facts 里）
 */
export function buildUsersView({ now, tz, users, daily, recentHours, runways, backfill, pointsFirstMs = null, prepaidAgo = null, syncedMs = now, fresh = true }) {
  const grid = dayGrid(now, tz);
  const N = grid.days;
  const filledFrom = filledFromOf(backfill, now);
  const availableDays = availableDaysOf(grid, filledFrom);
  const ready = {
    backfillDone: !!backfill?.done,
    week: availableDays >= USERS_VIEW.WEEK, // 近 7 天消费、重点用户
    compare: availableDays >= 2 * USERS_VIEW.WEEK, // 比前 7 天
    churn: availableDays >= USERS_VIEW.CHURN_DAYS + USERS_VIEW.CHURN_BEFORE, // 已流失
    down: availableDays >= USERS_VIEW.DOWN_RECENT + USERS_VIEW.DOWN_BEFORE,
    balance: pointsFirstMs != null && now - pointsFirstMs >= 24 * HOUR_MS, // 可用天数等快照记满 24 小时
    prepaidCompare: prepaidAgo != null,
  };
  const eligible = users.filter((user) => user.role < 10 && (user.status === 1 || sum(daily.get(user.username) || []) > 0));
  const bigIds = ready.week ? eligible.filter((user) => runways.get(Number(user.id))?.big).sort((a, b) => (runways.get(Number(b.id)).dailyAvg || 0) - (runways.get(Number(a.id)).dailyAvg || 0) || a.id - b.id).map((user) => Number(user.id)) : [];
  const bigSet = new Set(bigIds);
  const adminNames = new Set(users.filter((user) => user.role >= 10).map((user) => user.username));

  // 每位用户第一次有消费的那一天（下标）：只有「累计消费和这段数据的合计差不多」才算数（以前没花过），否则是 -1
  const firstSpendOf = (user, series) => {
    const total = sum(series), used = Number(user.usedUsd);
    if (!(total > 0) || !Number.isFinite(used)) return -1;
    if (used - total > Math.max(USERS_VIEW.NEW_TOL_USD, USERS_VIEW.NEW_TOL_SHARE * used)) return -1;
    return series.findIndex((value) => value > 0);
  };
  const firstSpend = new Map();

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
    const first = firstSpendOf(user, series);
    if (first >= 0) firstSpend.set(user.username, first);
    const isNew = first >= N - 1 - USERS_VIEW.NEW_DAYS; // 最近 7 个整天加今天
    const down = ready.down && before >= USERS_VIEW.DOWN_MIN_DAILY_USD && recent3 * 2 < before;
    const priorSpent = series.slice(N - 1 - USERS_VIEW.CHURN_DAYS - USERS_VIEW.CHURN_BEFORE, N - 1 - USERS_VIEW.CHURN_DAYS).some((value) => value > 0);
    const churned = ready.churn && priorSpent && week === 0 && today === 0;
    const status = runway.state === "empty" ? "empty" : runway.level >= 1 && runway.state === "soon" ? "soon" : down ? "down" : churned ? "churned" : isNew ? "new" : null;
    rows.push({
      id: Number(user.id), username: user.username, big: bigSet.has(Number(user.id)), disabled: user.status !== 1,
      group: user.group || "", createdAtMs: user.createdAtMs ?? null, usedUsd: Number.isFinite(Number(user.usedUsd)) ? Number(user.usedUsd) : null, isNew,
      active30: series.slice(N - USERS_VIEW.ACTIVE_DAYS).some((value) => value > 0),
      week, prevWeek, today, balanceUsd: user.quotaUsd ?? runway.balanceUsd, // 用户列表里的是最新的（实时一档每分钟读一次），状况里的是上一个整轮的
      runwayState: runway.state, days: runway.days ?? null, burnPerDay: runway.burnPerDay ?? null, level: runway.level || 0,
      status, lastUsed, spark: series.slice(N - 1 - USERS_VIEW.SPARK_DAYS, N - 1),
    });
  }

  // 趋势：每天的消费、有消费的用户数、第一次花钱的用户数，今天只到现在；悬停要这天消费最多的前 3 个、这天第一次花钱的前 5 位
  const nonAdmin = [...daily.keys()].filter((name) => !adminNames.has(name));
  const newByDay = new Map(); // 下标 → [{ username, cost }]
  for (const [name, index] of firstSpend) {
    if (adminNames.has(name)) continue;
    let list = newByDay.get(index);
    if (!list) newByDay.set(index, list = []);
    list.push({ username: name, cost: daily.get(name)?.[index] || 0 });
  }
  const trend = [];
  const firstTrend = N - USERS_VIEW.TREND_DAYS;
  for (let i = firstTrend; i < N; i += 1) {
    let cost = 0, usersCount = 0;
    const top = [];
    for (const name of nonAdmin) {
      const value = daily.get(name)[i];
      if (!(value > 0)) continue;
      cost += value; usersCount += 1; top.push({ username: name, cost: value });
    }
    top.sort((a, b) => b.cost - a.cost || a.username.localeCompare(b.username));
    const fresh30 = (newByDay.get(i) || []).sort((a, b) => b.cost - a.cost || a.username.localeCompare(b.username));
    trend.push({ day: grid.keys[i], available: grid.starts[i] >= filledFrom || i === N - 1, cost, users: usersCount, newUsers: fresh30.length, newTop: fresh30.slice(0, USERS_VIEW.NEW_TOP), top: top.slice(0, USERS_VIEW.TOP) });
  }
  // 前 30 天（图上的虚线）：每天的消费、有消费的用户数、第一次花钱的用户数，位置和 trend 一一对应；没补到的天 available 是 false
  const prevTrend = [];
  for (let i = firstTrend - USERS_VIEW.TREND_DAYS; i < firstTrend; i += 1) {
    let cost = 0, usersCount = 0;
    for (const name of nonAdmin) {
      const value = daily.get(name)[i];
      if (value > 0) { cost += value; usersCount += 1; }
    }
    prevTrend.push({ day: grid.keys[i], available: grid.starts[i] >= filledFrom, cost, users: usersCount, newUsers: (newByDay.get(i) || []).length });
  }

  // 今天和昨天同一时段（按小时用量折算）
  let yesterdaySame = 0;
  const upTo = yesterdayStart + (now - todayStart);
  for (const user of eligible) { const hours = recentHours.get(user.username); if (hours) yesterdaySame += usageUsdBetween(hours, yesterdayStart, upTo); }
  const weekCost = sum(rows.map((row) => row.week)), prevWeekCost = sum(rows.map((row) => row.prevWeek));
  const countNew = (from, to) => [...firstSpend].filter(([name, index]) => !adminNames.has(name) && index >= from && index <= to).length;
  const summary = {
    todayCost: sum(rows.map((row) => row.today)), yesterdaySameTime: yesterdaySame,
    weekCost, prevWeekCost,
    weekUsers: rows.filter((row) => row.week > 0).length, prevWeekUsers: rows.filter((row) => row.prevWeek > 0).length,
    weekNewUsers: countNew(N - 8, N - 2), prevWeekNewUsers: countNew(N - 15, N - 9),
    newUsers30: trend.reduce((total, day) => total + day.newUsers, 0), prevNewUsers30: prevTrend.reduce((total, day) => total + day.newUsers, 0),
    prepaid: sum(rows.map((row) => row.balanceUsd || 0)), prepaidAgo,
    bigWeek: sum(rows.filter((row) => row.big).map((row) => row.week)), // 重点用户近 7 天一共花了多少（「5 个重点用户占 82%」）
  };
  // 概览那句话要的几位：涨得最多的、在下滑的（按一天少花多少排）；快用完的重点用户个数
  const riser = [...rows].filter((row) => row.week - row.prevWeek > 0).sort((a, b) => (b.week - b.prevWeek) - (a.week - a.prevWeek) || a.username.localeCompare(b.username))[0] || null;
  const downRows = rows.filter((row) => row.status === "down").sort((a, b) => (b.prevWeek - b.week) - (a.prevWeek - a.week) || a.username.localeCompare(b.username));
  const facts = {
    riser: riser ? { id: riser.id, username: riser.username, delta: riser.week - riser.prevWeek } : null,
    down: downRows.map((row) => ({ id: row.id, username: row.username })),
    soonBig: rows.filter((row) => row.big && (row.status === "soon" || row.status === "empty")).length,
  };
  return { asOf: now, tz, today: grid.today, ready, availableDays, backfill: { done: !!backfill?.done, days: backfill?.days ?? 0, total: backfill?.total ?? USERS_VIEW.DAYS }, fresh, syncedMs,
    big: { ready: ready.week, ids: bigIds, count: bigIds.length }, summary, facts, trend, prevTrend, users: rows };
}

// ---- 用户页签：服务端筛、排、切片（一页 50 个）----
// query：{ scope: "active30" | "all", big, only: "all" | "soon" | "down" | "new" | "churned", groups: string[], q, sort, dir, page }
// 个数跟着前面的筛选算（范围 → 只看重点 → 状态），分组和搜索只筛表，不改这些个数；合计行只算筛出来的那些人
export const USER_SCOPES = Object.freeze(["active30", "all"]);
export const USER_ONLY = Object.freeze(["all", "soon", "down", "new", "churned"]);
export const USER_SORTS = Object.freeze(["user", "week", "today", "balance", "last"]);
const soonOf = (row) => row.status === "soon" || row.status === "empty"; // 快用完这一类含余额用完
const onlyMatch = (row, only) => (only === "all" ? true : only === "soon" ? soonOf(row) : only === "new" ? row.isNew : row.status === only);

const sortValueOf = (row, key) => (key === "user" ? row.username : key === "week" ? row.week : key === "today" ? row.today : key === "balance" ? row.balanceUsd : row.lastUsed?.ms ?? null);

export function queryUsers(rows, query = {}, ready = {}) {
  const scope = USER_SCOPES.includes(query.scope) ? query.scope : "active30";
  const only = USER_ONLY.includes(query.only) ? query.only : "all";
  const big = query.big === true;
  const groups = Array.isArray(query.groups) ? query.groups.filter(Boolean) : [];
  const key = String(query.q || "").trim().toLowerCase();
  const sort = USER_SORTS.includes(query.sort) ? query.sort : "week";
  const dir = query.dir === "asc" ? 1 : -1;
  const pageSize = USERS_VIEW.PAGE_SIZE;

  const inScope = scope === "all" ? rows : rows.filter((row) => row.active30);
  const inBig = big ? inScope.filter((row) => row.big) : inScope;
  const counts = {
    scope: { active30: rows.filter((row) => row.active30).length, all: rows.length },
    big: inScope.filter((row) => row.big).length,
    only: {
      all: inBig.length,
      soon: ready.balance ? inBig.filter(soonOf).length : null,
      down: ready.down ? inBig.filter((row) => row.status === "down").length : null,
      new: inBig.filter((row) => row.isNew).length,
      churned: ready.churn ? inBig.filter((row) => row.status === "churned").length : null,
    },
  };
  const matched = inBig.filter((row) => onlyMatch(row, only) && (!groups.length || groups.includes(row.group)) && (!key || row.username.toLowerCase().includes(key)));
  // 空值（还没用过、没有余额）不管升降都排最后；同值时先按近 7 天消费，再今天，再名字，排法稳定
  matched.sort((a, b) => {
    const x = sortValueOf(a, sort), y = sortValueOf(b, sort);
    if ((x == null) !== (y == null)) return x == null ? 1 : -1;
    const primary = x == null ? 0 : typeof x === "string" ? x.localeCompare(y, "zh-CN") * dir : (x - y) * dir;
    return primary || b.week - a.week || b.today - a.today || a.username.localeCompare(b.username, "zh-CN");
  });
  const total = matched.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page)) || 1));
  const totals = { count: total, week: sum(matched.map((row) => row.week)), prevWeek: sum(matched.map((row) => row.prevWeek)), today: sum(matched.map((row) => row.today)), balance: sum(matched.map((row) => row.balanceUsd || 0)) };
  const groupNames = [...new Set(rows.map((row) => row.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  return { rows: matched.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize, totals, counts, groups: groupNames };
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
