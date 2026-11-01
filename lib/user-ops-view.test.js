import test from "node:test";
import assert from "node:assert/strict";
import { USERS_VIEW, buildUserDetail, buildUsersView, dayGrid, queryUsers } from "./user-ops-view.js";

const TZ = "Asia/Shanghai", H = 3600000, D = 24 * H;
const NOW = Date.parse("2026-11-02T10:30:00+08:00");
const grid = dayGrid(NOW, TZ);
const N = grid.days;
const BACKFILLED = { done: true, days: 90, total: 90, cursorMs: grid.starts[0] };
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

test("前 30 天（图上的虚线）：和近 30 天一一对应，消费、有消费的用户数；没补到的天 available 是 false", () => {
  assert.equal(N, 90, "网格 90 天：近 30 天 + 前 30 天 + 月留存要的再往前 30 天");
  const daily = new Map([["a", series((i) => (i < N - 30 ? 2 : 5))], ["b", series((i) => (i % 2 ? 1 : 0))], ["root", series(() => 100)]]);
  const view = build({ users: [user(1, "a"), user(2, "b"), user(99, "root", { role: 100 })], daily, runways: new Map([[1, runway()], [2, runway()]]) });
  assert.equal(view.prevTrend.length, 30);
  assert.equal(view.prevTrend[0].day, grid.keys[N - 60]);
  assert.equal(view.prevTrend.at(-1).day, grid.keys[N - 31]);
  assert.deepEqual([view.prevTrend[0].cost, view.prevTrend[0].users], [2, 1], "前 30 天的第 0 天：a 花 2，b 偶数天没有；管理员不算");
  assert.deepEqual([view.prevTrend[1].cost, view.prevTrend[1].users], [3, 2]);
  assert.deepEqual([view.trend[0].day, view.trend[0].cost], [grid.keys[N - 30], 5 + 0], "近 30 天从倒数第 30 天起");
  assert.ok(view.prevTrend.every((day) => day.available));
  // 回补才补到 20 天：前 30 天整段都没补到
  const partial = build({ users: [user(1, "a")], daily: new Map([["a", series((i) => (i >= N - 20 ? 5 : 0))]]), runways: new Map([[1, runway()]]), backfill: { done: false, days: 20, total: 90, cursorMs: grid.starts[N - 21] } });
  assert.ok(partial.prevTrend.every((day) => !day.available));
  assert.equal(partial.trend.filter((day) => day.available).length, 21, "近 30 天里补到的 20 天 + 今天");
  // 补到 45 天：前 30 天里只有后 15 天有
  const mid = build({ users: [user(1, "a")], daily: new Map([["a", series((i) => (i >= N - 45 ? 5 : 0))]]), runways: new Map([[1, runway()]]), backfill: { done: false, days: 45, total: 90, cursorMs: grid.starts[N - 45] } });
  assert.deepEqual([mid.prevTrend.filter((day) => day.available).length, mid.prevTrend[14].available, mid.prevTrend[15].available], [15, false, true]);
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

test("状态：一行一个，先后 余额用完 > 快用完 > 在下滑 > 已流失 > 新消费", () => {
  const down = series((i) => (i >= N - 4 && i <= N - 2 ? 2 : i >= N - 18 && i <= N - 5 ? 20 : 0));
  const wasActive = series((i) => (i < N - 10 && i > N - 25 ? 8 : 0));
  const fresh = series((i) => (i >= N - 3 ? 4 : 0));
  const daily = new Map([["empty", down], ["soon", down], ["down", down], ["churned", wasActive], ["fresh", fresh], ["plain", series(() => 6)]]);
  const users = [user(1, "empty"), user(2, "soon"), user(3, "down"), user(4, "churned"), user(5, "fresh", { usedUsd: 12 }), user(6, "plain")];
  const runways = new Map([
    [1, runway({ state: "empty", level: 2, days: 0, balanceUsd: 0 })], [2, runway({ state: "soon", level: 1, days: 2 })],
    [3, runway()], [4, runway()], [5, runway({ state: "none", days: null })], [6, runway()],
  ]);
  const view = build({ users, daily, runways });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).status), ["empty", "soon", "down", "churned", "new", null], "快用完压过在下滑");
});

test("在下滑：近 3 天日均比之前 14 天的日均少一半以上；之前 14 天日均不到 $5 的不判", () => {
  const mk = (before, recent) => series((i) => (i >= N - 4 && i <= N - 2 ? recent : i >= N - 18 && i <= N - 5 ? before : 0));
  const users = [user(1, "half"), user(2, "justover"), user(3, "small")];
  const view = build({ users, daily: new Map([["half", mk(20, 9.9)], ["justover", mk(20, 10)], ["small", mk(4.9, 0)]]), runways: new Map(users.map((u) => [u.id, runway()])) });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).status), ["down", null, null], "10 美元刚好是一半，不算少一半以上；之前日均 4.9 不判");
});

test("已流失：前 30 天（近 7 天再往前的 30 个整天）里有消费、近 7 天和今天都没有；更早以前花过、从没花过的不算", () => {
  const at = (index) => series((i) => (i === index ? 5 : 0));
  const users = [user(1, "gone"), user(2, "longGone"), user(3, "never"), user(4, "backToday"), user(5, "edgeIn"), user(6, "edgeOut"), user(7, "lastWeek")];
  const view = build({
    users,
    daily: new Map([["gone", at(N - 20)], ["longGone", at(N - 50)], ["never", series(() => 0)], ["backToday", at(N - 20)], ["edgeIn", at(N - 38)], ["edgeOut", at(N - 39)], ["lastWeek", at(N - 8)]]),
    recentHours: new Map([["backToday", new Map([[grid.starts[N - 1] + H, 1]])]]),
    runways: new Map(users.map((u) => [u.id, runway()])),
  });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).status), ["churned", null, null, null, "churned", null, null], "前 30 天是倒数第 38 天到第 9 天：第 38 天算，第 39 天不算；近 7 天里花过的不算");
});

test("新消费：第一次花钱在近 7 天以内（含今天）；累计消费比这段数据多出一截的是以前花过的老用户，不算新", () => {
  const spend = (first, usd = 4) => series((i) => (i >= first ? usd : 0));
  const users = [
    user(1, "newer", { usedUsd: 4 * 5 }), // 第一次花钱在倒数第 5 天
    user(2, "veteran", { usedUsd: 4 * N }), // 数据一开始就在花
    user(3, "returning", { usedUsd: 500 }), // 数据里第一次花钱在近 7 天，但累计消费 500：以前花过
    user(4, "today", { usedUsd: 4 }), // 今天第一次
    user(5, "prevWeek", { usedUsd: 4 * 12 }), // 前 7 天第一次（倒数第 12 天）
    user(6, "long", { usedUsd: 4 * 40 }), // 倒数第 40 天（前 30 天之前）
    user(7, "tolSmall", { usedUsd: 4 * 5 + 0.4 }), // 差 0.4 美元：数据看板还没落齐，算新
    user(8, "tolOver", { usedUsd: 4 * 5 + 0.6 }), // 差 0.6：不算
    user(9, "tolBig", { usedUsd: 4 * 5 + 15 }), // 累计 35：差 15 超过 2%（0.7）：不算
    user(10, "noUsed"), // 没有累计消费：不算
  ];
  const daily = new Map([["newer", spend(N - 5)], ["veteran", spend(0)], ["returning", spend(N - 3)], ["today", series((i) => (i === N - 1 ? 4 : 0))], ["prevWeek", spend(N - 12)], ["long", spend(N - 40)],
    ["tolSmall", spend(N - 5)], ["tolOver", spend(N - 5)], ["tolBig", spend(N - 5)], ["noUsed", spend(N - 5)]]);
  const view = build({ users, daily, runways: new Map(users.map((u) => [u.id, runway()])) });
  assert.deepEqual(users.map((u) => rowOf(view, u.username).isNew), [true, false, false, true, false, false, true, false, false, false]);
  assert.equal(rowOf(view, "newer").status, "new");
  // 概览的数：近 7 天（倒数第 8 天到第 2 天）第一次花钱的：newer、tolSmall；前 7 天（倒数第 15 天到第 9 天）：prevWeek
  assert.deepEqual([view.summary.weekNewUsers, view.summary.prevWeekNewUsers], [2, 1]);
  // 近 30 天 4 位（newer、today、prevWeek、tolSmall）、前 30 天 1 位（long 在倒数第 40 天，在前 30 天里）
  assert.deepEqual([view.summary.newUsers30, view.summary.prevNewUsers30], [4, 1]);
  const day = view.trend.at(-1 - 4); // 倒数第 5 天
  assert.equal(day.newUsers, 2);
  assert.deepEqual(day.newTop.map((item) => item.username).sort(), ["newer", "tolSmall"]);
  assert.equal(view.trend.at(-1).newUsers, 1, "今天第一次花钱的在今天那根柱子上，但不进「近 7 天」的数");
  assert.equal(view.prevTrend.reduce((sum, d) => sum + d.newUsers, 0), 1);
});

test("补数据没补到的：比前 7 天、在下滑、已流失不判；今天一直算；重点用户补到 7 天才出", () => {
  const cursorFor = (filledDays) => grid.starts[N - 1 - filledDays];
  const users = [user(1, "a")];
  const view3 = build({ users, daily: new Map(), runways: new Map([[1, runway({ big: true, dailyAvg: 9 })]]), backfill: { done: false, days: 3, total: 30, cursorMs: cursorFor(3) } });
  assert.deepEqual([view3.availableDays, view3.ready.week, view3.ready.compare, view3.ready.churn, view3.ready.down, view3.big.ready, view3.big.count], [3, false, false, false, false, false, 0]);
  assert.equal(view3.trend.at(-1).available, true, "今天一直算");
  assert.equal(view3.trend.at(-4).available, true);
  assert.equal(view3.trend.at(-5).available, false);
  const view7 = build({ users, daily: new Map(), runways: new Map([[1, runway({ big: true, dailyAvg: 9 })]]), backfill: { done: false, days: 8, total: 30, cursorMs: cursorFor(7) } });
  assert.deepEqual([view7.ready.week, view7.ready.compare, view7.ready.churn, view7.big.ready, view7.big.count, view7.users[0].big], [true, false, false, true, 1, true]);
  const view17 = build({ users, daily: new Map(), runways: new Map([[1, runway()]]), backfill: { done: false, days: 18, total: 30, cursorMs: cursorFor(17) } });
  assert.deepEqual([view17.ready.compare, view17.ready.churn, view17.ready.down], [true, false, true], "已流失要补到 37 天");
  const view37 = build({ users, daily: new Map(), runways: new Map([[1, runway()]]), backfill: { done: false, days: 38, total: 90, cursorMs: cursorFor(37) } });
  assert.equal(view37.ready.churn, true);
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

test("趋势：每天的消费、有消费的用户数、这天消费最多的前 3 个；管理员不算；新消费的用户数看第一次花钱那天", () => {
  const daily = new Map([
    ["a", series((i) => (i === N - 2 ? 10 : 0))], ["b", series((i) => (i === N - 2 ? 30 : 0))], ["c", series((i) => (i === N - 2 ? 20 : 0))],
    ["d", series((i) => (i === N - 2 ? 5 : 0))], ["root", series((i) => (i === N - 2 ? 999 : 0))],
  ]);
  const users = [user(1, "a", { usedUsd: 10 }), user(2, "b", { usedUsd: 30 }), user(3, "c", { usedUsd: 900 }), user(4, "d"), { ...user(9, "root"), role: 100, usedUsd: 999 }];
  const view = build({ users, daily, runways: new Map(users.map((u) => [u.id, runway()])) });
  const yesterday = view.trend.at(-2);
  assert.deepEqual([yesterday.cost, yesterday.users, yesterday.newUsers], [65, 4, 2], "a、b 累计消费就是这一天，第一次花钱；c 以前花过；d 没有累计消费；管理员不算");
  assert.deepEqual(yesterday.newTop.map((item) => [item.username, item.cost]), [["b", 30], ["a", 10]]);
  assert.deepEqual(yesterday.top.map((item) => [item.username, item.cost]), [["b", 30], ["c", 20], ["a", 10]]);
  assert.equal(view.trend.length, USERS_VIEW.TREND_DAYS);
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

// ---- 用户页签：服务端筛、排、切片 ----
const mkRow = (id, over = {}) => ({ id, username: `u${String(id).padStart(3, "0")}`, big: false, disabled: false, group: "default", createdAtMs: null, usedUsd: null, isNew: false, active30: true,
  week: 0, prevWeek: 0, today: 0, balanceUsd: 10, runwayState: "ok", days: 20, burnPerDay: 1, level: 0, status: null, lastUsed: null, spark: [], ...over });
const READY = { balance: true, down: true, churn: true };
const names = (result) => result.rows.map((row) => row.username);

test("用户页签·范围：默认近 30 天有消费，切到全部才有其余的人；个数两边都给", () => {
  const rows = [mkRow(1), mkRow(2, { active30: false }), mkRow(3, { active30: false })];
  assert.deepEqual(names(queryUsers(rows, {}, READY)), ["u001"]);
  const all = queryUsers(rows, { scope: "all" }, READY);
  assert.equal(all.total, 3);
  assert.deepEqual(all.counts.scope, { active30: 1, all: 3 });
});

test("用户页签·筛选叠着用：个数跟着前面的筛选（范围 → 重点 → 状态）算，分组和搜索只筛表；快用完这一类含余额用完", () => {
  const rows = [
    mkRow(1, { big: true, status: "soon", group: "vip" }), mkRow(2, { big: true, status: "empty", group: "default" }), mkRow(3, { status: "down", group: "vip" }),
    mkRow(4, { status: "churned", active30: false }), mkRow(5, { isNew: true, status: "new", group: "vip" }), mkRow(6, { big: true, status: null, group: "vip" }),
  ];
  const all = queryUsers(rows, { scope: "all" }, READY);
  assert.deepEqual(all.counts.only, { all: 6, soon: 2, down: 1, new: 1, churned: 1 });
  assert.equal(all.counts.big, 3);
  const bigOnly = queryUsers(rows, { scope: "all", big: true }, READY);
  assert.deepEqual(bigOnly.counts.only, { all: 3, soon: 2, down: 0, new: 0, churned: 0 }, "只看重点用户：状态的个数只数重点用户");
  assert.deepEqual(names(queryUsers(rows, { scope: "all", only: "soon" }, READY)).sort(), ["u001", "u002"]);
  const vip = queryUsers(rows, { scope: "all", only: "soon", groups: ["vip"] }, READY);
  assert.deepEqual(names(vip), ["u001"]);
  assert.equal(vip.counts.only.soon, 2, "分组只筛表，状态的个数不跟着变");
  assert.deepEqual(names(queryUsers(rows, { scope: "all", groups: ["vip", "default"] }, READY)).length, 5 + 1);
  assert.deepEqual(names(queryUsers(rows, { scope: "all", q: " U00 " }, READY)).length, 6, "搜索不分大小写，前后空格不算");
  assert.deepEqual(names(queryUsers(rows, { scope: "all", q: "u003" }, READY)), ["u003"]);
  assert.deepEqual(queryUsers(rows, {}, READY).counts.only.churned, 0, "默认范围里没有已流失的（他们近 30 天没消费），切全部才有");
});

test("用户页签·还判不了的类（余额没记满、没补满）个数是 null；分组名单是所有用户的分组，按名字排", () => {
  const rows = [mkRow(1, { group: "vip" }), mkRow(2, { group: "default" }), mkRow(3, { group: "" })];
  const result = queryUsers(rows, {}, {});
  assert.deepEqual([result.counts.only.soon, result.counts.only.down, result.counts.only.churned], [null, null, null]);
  assert.equal(result.counts.only.all, 3);
  assert.deepEqual(result.groups, ["default", "vip"]);
});

test("用户页签·排序：默认近 7 天消费从高到低，同值按今天再按名字；空值不管升降都在最后；点用户名按名字排", () => {
  const rows = [mkRow(1, { week: 5, today: 1 }), mkRow(2, { week: 9 }), mkRow(3, { week: 5, today: 3 }), mkRow(4, { week: 5, today: 3, username: "aaa" })];
  assert.deepEqual(names(queryUsers(rows, {}, READY)), ["u002", "aaa", "u003", "u001"]);
  assert.deepEqual(names(queryUsers(rows, { sort: "week", dir: "asc" }, READY)), ["aaa", "u003", "u001", "u002"], "升序：同值时还是今天多的在前、再按名字");
  const used = [mkRow(1, { lastUsed: { ms: 100, precise: true } }), mkRow(2, { lastUsed: null }), mkRow(3, { lastUsed: { ms: 300, precise: true } })];
  assert.deepEqual(names(queryUsers(used, { sort: "last" }, READY)), ["u003", "u001", "u002"]);
  assert.deepEqual(names(queryUsers(used, { sort: "last", dir: "asc" }, READY)), ["u001", "u003", "u002"], "没用过的升序也在最后");
  assert.deepEqual(names(queryUsers([mkRow(1, { username: "bob" }), mkRow(2, { username: "alice" })], { sort: "user", dir: "asc" }, READY)), ["alice", "bob"]);
  assert.deepEqual(names(queryUsers([mkRow(1, { balanceUsd: 5 }), mkRow(2, { balanceUsd: 50 })], { sort: "balance" }, READY)), ["u002", "u001"]);
  assert.deepEqual(names(queryUsers(rows, { sort: "bogus", dir: "bogus" }, READY)), ["u002", "aaa", "u003", "u001"], "不认识的排法回到默认");
});

test("用户页签·每页 50 个：翻页、页码越界回到最后一页；合计行只算筛出来的所有人（不只是这一页）", () => {
  const rows = Array.from({ length: 120 }, (_, i) => mkRow(i + 1, { week: 120 - i, prevWeek: 1, today: 2, balanceUsd: 3 }));
  const first = queryUsers(rows, {}, READY);
  assert.deepEqual([first.rows.length, first.total, first.page, first.pages, first.pageSize], [50, 120, 1, 3, 50]);
  assert.deepEqual(first.totals, { count: 120, week: (120 * 121) / 2, prevWeek: 120, today: 240, balance: 360 });
  const third = queryUsers(rows, { page: 3 }, READY);
  assert.deepEqual([third.rows.length, third.rows[0].week, third.page], [20, 20, 3]);
  assert.equal(queryUsers(rows, { page: 99 }, READY).page, 3);
  assert.equal(queryUsers(rows, { page: "x" }, READY).page, 1);
  const some = queryUsers(rows, { q: "u00" }, READY);
  assert.deepEqual([some.total, some.totals.count, some.totals.today], [9, 9, 18], "合计行只算筛出来的 9 个人");
  const none = queryUsers(rows, { q: "zzz" }, READY);
  assert.deepEqual([none.rows.length, none.total, none.pages, none.page, none.totals.week], [0, 0, 1, 1, 0]);
});
