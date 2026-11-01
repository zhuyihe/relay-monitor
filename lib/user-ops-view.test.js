import test from "node:test";
import assert from "node:assert/strict";
import { USERS_VIEW, buildUserDetail, buildUsersView, dayGrid } from "./user-ops-view.js";

const TZ = "Asia/Shanghai", H = 3600000, D = 24 * H;
const NOW = Date.parse("2026-11-02T10:30:00+08:00");
const grid = dayGrid(NOW, TZ);
const N = grid.days;
const BACKFILLED = { done: true, days: 30, total: 30, cursorMs: grid.starts[0] };
// 每天消费：fn(i) i = 0..N-1，最后一格（N-1）是今天
const series = (fn) => Array.from({ length: N }, (_, i) => fn(i));
const user = (id, username, extra = {}) => ({ id, username, role: 1, status: 1, quotaUsd: 100, createdAtMs: NOW - 60 * D, ...extra });
const runway = (extra = {}) => ({ state: "ok", level: 0, days: 20, burnPerDay: 5, balanceUsd: 100, big: false, dailyAvg: 0, ...extra });
const build = (over = {}) => buildUsersView({ now: NOW, tz: TZ, users: [], daily: new Map(), recentHours: new Map(), runways: new Map(), backfill: BACKFILLED, pointsFirstMs: NOW - 8 * D, prepaidAgo: null, ...over });
const rowOf = (view, name) => view.users.find((row) => row.username === name);

test("日历：今天在最后一格，每天的起点按业务时区，夏令时的 23/25 小时日也对得上下标", () => {
  assert.equal(grid.keys[N - 1], "2026-11-02");
  assert.equal(grid.indexOf(NOW), N - 1);
  assert.equal(grid.indexOf(grid.starts[N - 2] + H), N - 2);
  assert.equal(grid.indexOf(grid.starts[N - 1] - 1), N - 2);
  assert.equal(grid.indexOf(grid.starts[0] - 1), -1);
  const la = dayGrid(Date.parse("2026-11-02T10:00:00-08:00"), "America/Los_Angeles");
  assert.deepEqual(la.keys.slice(-3), ["2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.equal(la.starts.at(-1) - la.starts.at(-2), 25 * H, "11-01 是 25 小时日");
  assert.equal(la.indexOf(la.starts.at(-1) - 1), la.days - 2, "25 小时日的最后一刻还在 11-01");
  assert.equal(la.indexOf(la.starts.at(-2) + 24 * H + 30 * 60000), la.days - 2, "第 24 个小时之后还在 11-01，不会提前跳到 11-02");
});

test("近 7 天是最近 7 个整天（不含今天），前 7 天是再往前 7 个整天，今天单列；每一行的数", () => {
  const daily = new Map([["a", series((i) => (i === N - 1 ? 3 : i >= N - 8 ? 10 : i >= N - 15 ? 4 : 0))]]);
  const view = build({ users: [user(1, "a")], daily, runways: new Map([[1, runway()]]) });
  const a = rowOf(view, "a");
  assert.deepEqual([a.week, a.prevWeek, a.today], [70, 28, 0], "今天的 3 美元在整天的格子里，但「今天」来自按小时的用量（这里没给）");
  assert.equal(a.spark.length, USERS_VIEW.SPARK_DAYS);
  assert.deepEqual(a.spark.slice(-7), [10, 10, 10, 10, 10, 10, 10], "小趋势线是最近 14 个整天");
  assert.deepEqual([view.summary.weekCost, view.summary.prevWeekCost, view.summary.weekUsers, view.summary.prevWeekUsers], [70, 28, 1, 1]);
});

test("今天、昨天同一时段、最近使用：来自最近两天按小时的用量", () => {
  const todayStart = grid.starts[N - 1], yesterdayStart = grid.starts[N - 2];
  const hours = new Map([[yesterdayStart + 2 * H, 6], [yesterdayStart + 9 * H, 12], [yesterdayStart + 15 * H, 100], [todayStart + 3 * H, 5], [todayStart + 9 * H, 2]]);
  const view = build({ users: [user(1, "a")], daily: new Map([["a", series(() => 0)]]), recentHours: new Map([["a", hours]]), runways: new Map([[1, runway()]]) });
  const a = rowOf(view, "a");
  assert.equal(a.today, 7);
  assert.deepEqual(a.lastUsed, { ms: todayStart + 10 * H, precise: true }, "最近使用：今天 9 点那一小时的末尾");
  // 现在是 10:30：昨天同一时段 = 昨天 0:00–10:30：6 + 12（9 点那小时整个在内）
  assert.equal(view.summary.yesterdaySameTime, 18);
  assert.equal(view.summary.todayCost, 7);
});

test("状态：一行一个，先后 余额用完 > 快用完 > 在下滑 > 不活跃 > 新用户", () => {
  const down = series((i) => (i >= N - 4 && i <= N - 2 ? 2 : i >= N - 18 && i <= N - 5 ? 20 : 0));
  const wasActive = series((i) => (i < N - 10 && i > N - 25 ? 8 : 0));
  const daily = new Map([["empty", down], ["soon", down], ["down", down], ["inactive", wasActive], ["fresh", series(() => 0)], ["plain", series(() => 6)]]);
  const users = [user(1, "empty"), user(2, "soon"), user(3, "down"), user(4, "inactive"), user(5, "fresh", { createdAtMs: NOW - 2 * D }), user(6, "plain"), user(7, "freshdown", { createdAtMs: NOW - 2 * D })];
  daily.set("freshdown", down);
  const runways = new Map([
    [1, runway({ state: "empty", level: 2, days: 0, balanceUsd: 0 })], [2, runway({ state: "soon", level: 1, days: 2 })],
    [3, runway()], [4, runway()], [5, runway({ state: "none", days: null })], [6, runway()], [7, runway()],
  ]);
  const view = build({ users, daily, runways });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).status), ["empty", "soon", "down", "inactive", "new", null, "down"], "新用户在下滑时标在下滑；快用完压过在下滑");
});

test("在下滑：近 3 天日均比之前 14 天的日均少一半以上；之前 14 天日均不到 $5 的不判", () => {
  const mk = (before, recent) => series((i) => (i >= N - 4 && i <= N - 2 ? recent : i >= N - 18 && i <= N - 5 ? before : 0));
  const users = [user(1, "half"), user(2, "justover"), user(3, "small")];
  const view = build({ users, daily: new Map([["half", mk(20, 9.9)], ["justover", mk(20, 10)], ["small", mk(4.9, 0)]]), runways: new Map(users.map((u) => [u.id, runway()])) });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).status), ["down", null, null], "10 美元刚好是一半，不算少一半以上；之前日均 4.9 不判");
});

test("不活跃：以前有消费、连续 7 个整天（今天也没有）没有消费；从没消费过的不算", () => {
  const before = series((i) => (i === 3 ? 5 : 0));
  const users = [user(1, "was"), user(2, "never"), user(3, "backToday")];
  const view = build({ users, daily: new Map([["was", before], ["never", series(() => 0)], ["backToday", before]]), recentHours: new Map([["backToday", new Map([[grid.starts[N - 1] + H, 1]])]]), runways: new Map(users.map((u) => [u.id, runway()])) });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).status), ["inactive", null, null]);
});

test("新用户：注册 7 天以内（用户列表里的注册时间），注册了还没用过的也算；没有注册时间的不算", () => {
  const users = [user(1, "d6", { createdAtMs: NOW - 6 * D }), user(2, "d8", { createdAtMs: NOW - 8 * D }), user(3, "none", { createdAtMs: null })];
  const view = build({ users, daily: new Map(), runways: new Map(users.map((u) => [u.id, runway({ state: "none", days: null })])) });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).isNew), [true, false, false]);
  assert.equal(rowOf(view, "d6").status, "new");
});

test("补数据没补到的：比前 7 天、在下滑、不活跃不判；今天一直算；重点用户补到 7 天才出", () => {
  const cursorFor = (filledDays) => grid.starts[N - 1 - filledDays];
  const users = [user(1, "a")];
  const view3 = build({ users, daily: new Map(), runways: new Map([[1, runway({ big: true, dailyAvg: 9 })]]), backfill: { done: false, days: 3, total: 30, cursorMs: cursorFor(3) } });
  assert.deepEqual([view3.availableDays, view3.ready.week, view3.ready.compare, view3.ready.inactive, view3.ready.down, view3.big.ready, view3.big.count], [3, false, false, false, false, false, 0]);
  assert.equal(view3.trend.at(-1).available, true, "今天一直算");
  assert.equal(view3.trend.at(-4).available, true);
  assert.equal(view3.trend.at(-5).available, false);
  const view7 = build({ users, daily: new Map(), runways: new Map([[1, runway({ big: true, dailyAvg: 9 })]]), backfill: { done: false, days: 8, total: 30, cursorMs: cursorFor(7) } });
  assert.deepEqual([view7.ready.week, view7.ready.compare, view7.ready.inactive, view7.big.ready, view7.big.count, view7.users[0].big], [true, false, false, true, 1, true]);
  const view17 = build({ users, daily: new Map(), runways: new Map([[1, runway()]]), backfill: { done: false, days: 18, total: 30, cursorMs: cursorFor(17) } });
  assert.deepEqual([view17.ready.compare, view17.ready.inactive, view17.ready.down], [true, true, true]);
  assert.equal(build({ users, daily: new Map(), runways: new Map(), backfill: BACKFILLED }).ready.backfillDone, true);
});

test("余额快照：满 24 小时才有可用天数；预收比 7 天前要快照有 7 天", () => {
  const warm = build({ pointsFirstMs: NOW - 5 * H });
  assert.equal(warm.ready.balance, false);
  assert.equal(build({ pointsFirstMs: NOW - 25 * H }).ready.balance, true);
  assert.equal(build({ pointsFirstMs: null }).ready.balance, false);
  assert.deepEqual([build({ prepaidAgo: null }).ready.prepaidCompare, build({ prepaidAgo: 120 }).ready.prepaidCompare], [false, true]);
  const view = build({ users: [user(1, "a", { quotaUsd: 40 }), user(2, "b", { quotaUsd: 60 })], runways: new Map([[1, runway({ balanceUsd: 40 })], [2, runway({ balanceUsd: 60 })]]), prepaidAgo: 80 });
  assert.deepEqual([view.summary.prepaid, view.summary.prepaidAgo], [100, 80]);
});

test("趋势：每天的消费、有消费的用户数、这天消费最多的前 3 个；管理员不算；新用户数用注册时间，前 30 天也有", () => {
  const daily = new Map([
    ["a", series((i) => (i === N - 2 ? 10 : 0))], ["b", series((i) => (i === N - 2 ? 30 : 0))], ["c", series((i) => (i === N - 2 ? 20 : 0))],
    ["d", series((i) => (i === N - 2 ? 5 : 0))], ["root", series((i) => (i === N - 2 ? 999 : 0))],
  ]);
  const users = [user(1, "a", { createdAtMs: grid.starts[N - 2] + H }), user(2, "b", { createdAtMs: grid.starts[N - 2] + 2 * H }), user(3, "c"), user(4, "d"),
    { ...user(9, "root"), role: 100 }, user(5, "old", { createdAtMs: grid.starts[N - 31] + H })];
  const view = build({ users, daily, runways: new Map(users.map((u) => [u.id, runway()])) });
  const yesterday = view.trend.at(-2);
  assert.deepEqual([yesterday.cost, yesterday.users, yesterday.newUsers], [65, 4, 2]);
  assert.deepEqual(yesterday.top.map((item) => [item.username, item.cost]), [["b", 30], ["c", 20], ["a", 10]]);
  assert.equal(view.trend.length, USERS_VIEW.TREND_DAYS);
  assert.equal(view.prevNewUsers.length, USERS_VIEW.TREND_DAYS);
  assert.equal(view.prevNewUsers.reduce((sum, count) => sum + count, 0), 1, "前 30 天注册的 old 在前 30 天的线上");
});

test("重点用户：只有补到 7 天才出名单，名单按每天花得多的排；列表里的用户带 big 标记", () => {
  const users = [user(1, "a"), user(2, "b"), user(3, "c")];
  const runways = new Map([[1, runway({ big: true, dailyAvg: 5 })], [2, runway({ big: true, dailyAvg: 50 })], [3, runway()]]);
  const view = build({ users, daily: new Map(), runways });
  assert.deepEqual(view.big, { ready: true, ids: [2, 1], count: 2 });
  assert.deepEqual(view.users.filter((row) => row.big).map((row) => row.username).sort(), ["a", "b"]);
});

test("停用且近 30 天没消费的用户不进表；管理员不进表", () => {
  const users = [user(1, "on"), user(2, "off", { status: 2 }), user(3, "offUsed", { status: 2 }), { ...user(4, "root"), role: 100 }];
  const view = build({ users, daily: new Map([["offUsed", series((i) => (i === 5 ? 3 : 0))]]), runways: new Map(users.map((u) => [u.id, runway()])) });
  assert.deepEqual(view.users.map((row) => row.username).sort(), ["offUsed", "on"]);
});

test("抽屉：近 30 天每天的消费、今天每小时、余额变化；往上跳的是充值", () => {
  const todayStart = grid.starts[N - 1];
  const seriesA = series((i) => i);
  const hours = new Map([[todayStart + 2 * H, 1.5]]);
  const points = [[NOW - 3 * D, 50], [NOW - 2 * D, 40], [NOW - D, 140], [NOW - H, 139.8]];
  const detail = buildUserDetail({ now: NOW, tz: TZ, user: user(1, "a"), series: seriesA, hours, points });
  assert.equal(detail.dayBars.length, USERS_VIEW.TREND_DAYS);
  assert.deepEqual(detail.dayBars.at(-1), { day: "2026-11-02", cost: N - 1 });
  assert.equal(detail.hourBars.length, 11, "0 点到 10 点：11 根，每小时一根");
  assert.equal(detail.hourBars[2].cost, 1.5);
  assert.deepEqual(detail.recharges, [{ t: NOW - D, usd: 100 }], "涨 0.05 美元以内不算充值，跳了 100 美元算");
  assert.equal(detail.balance.length, 4);
});
