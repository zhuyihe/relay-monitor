import test from "node:test";
import assert from "node:assert/strict";
import { buildUsersView, dayGrid } from "./user-ops-view.js";
import { CHURN_VIEW, buildChurnView, queryChurn } from "./user-ops-churn.js";

const TZ = "Asia/Shanghai", H = 3600000, D = 24 * H;
const NOW = Date.parse("2026-11-02T10:30:00+08:00");
const grid = dayGrid(NOW, TZ);
const N = grid.days;
const FULL = { done: true, days: 90, total: 90, cursorMs: grid.starts[0] };
const series = (fn) => Array.from({ length: N }, (_, i) => fn(i));
const user = (id, username, extra = {}) => ({ id, username, role: 1, status: 1, quotaUsd: 100, createdAtMs: NOW - 200 * D, group: "default", usedUsd: null, ...extra });
const runway = (extra = {}) => ({ state: "ok", level: 0, days: 20, burnPerDay: 5, balanceUsd: 100, big: false, dailyAvg: 0, ...extra });

// users：[{ user, series, today?（今天到现在，按小时用量，默认 0）, sameTime?, big? }]；返回 [churn 视图, 用户视图]
function churn(entries, { backfill = FULL, models = null, noSameTime = false } = {}) {
  const users = entries.map((entry) => entry.user);
  const daily = new Map(entries.map((entry) => [entry.user.username, entry.series]));
  const recentHours = new Map(entries.filter((entry) => entry.today).map((entry) => [entry.user.username, new Map([[grid.starts[N - 1] + H, entry.today]])]));
  const runways = new Map(entries.map((entry) => [entry.user.id, runway({ big: !!entry.big })]));
  const view = buildUsersView({ now: NOW, tz: TZ, users, daily, recentHours, runways, backfill, pointsFirstMs: NOW - 8 * D, prepaidAgo: null });
  const sameTime = noSameTime ? null : new Map(entries.filter((entry) => entry.sameTime).map((entry) => [entry.user.username, entry.sameTime]));
  const result = buildChurnView({ now: NOW, tz: TZ, rows: view.users, daily, sameTime, models, ready: view.ready, backfill });
  return [result, view];
}
const mk = (before, recent) => series((i) => (i >= N - 4 && i <= N - 2 ? recent : i >= N - 18 && i <= N - 5 ? before : 0));
const item = (result, name) => result.items.find((entry) => entry.username === name);

test("在下滑：和用户页签同一个规则；一天少花多少 = 之前 14 天日均 − 近 3 天日均；之前日均 → 最近日均写在行里", () => {
  const entries = [
    { user: user(1, "half"), series: mk(20, 9.9) },
    { user: user(2, "justover"), series: mk(20, 10) }, // 刚好一半：不算
    { user: user(3, "small"), series: mk(4.9, 0) }, // 之前日均不到 $5：不判
  ];
  const [result, view] = churn(entries);
  assert.deepEqual(result.items.map((entry) => entry.username), ["half"]);
  const half = item(result, "half");
  assert.deepEqual([half.status, half.before, +half.after.toFixed(2), +half.loss.toFixed(2)], ["down", 20, 9.9, 10.1]);
  assert.equal(view.users.find((row) => row.username === "half").status, "down", "用户页签也标在下滑");
  assert.deepEqual(result.summary.down, { count: 1, loss: half.loss });
});

test("今天明显少了：今天到现在比过去 7 天同一时段的平均少一半以上、平时同一时段 ≥ $5 才判；一天少花多少按过去 7 天日均折算", () => {
  const sameTime = (today, usual) => ({ today, usual, usualDay: 40 });
  const entries = [
    { user: user(1, "low"), series: series(() => 40), sameTime: sameTime(3, 10) },
    { user: user(2, "exactHalf"), series: series(() => 40), sameTime: sameTime(5, 10) },
    { user: user(3, "thin"), series: series(() => 40), sameTime: sameTime(0, 4.9) }, // 平时同一时段不到 $5：不判
    { user: user(4, "none"), series: series(() => 40) }, // 今天一分没有读到（库里没行）：不在 sameTime 里
  ];
  const [result] = churn(entries);
  assert.deepEqual(result.items.map((entry) => entry.username), ["low"]);
  const low = item(result, "low");
  assert.deepEqual([low.status, low.before, low.after, +low.loss.toFixed(2)], ["todayLow", 10, 3, 28], "40 ×（1 − 3/10）= 28");
  assert.equal(result.ready.today, true);
  const [off] = churn(entries, { noSameTime: true });
  assert.equal(off.ready.today, false, "过去 7 天没补全、刚过 0 点：不判，不是 0 个");
  assert.equal(off.items.length, 0);
});

test("已流失：和用户页签同一个规则；一天少花多少 = 流失前 14 天（最后一次有消费那天往前）的日均；本周新流失是最后一次消费在 8～14 天前的", () => {
  const spendTo = (last, usd = 5, days = 11) => series((i) => (i <= last && i > last - days ? usd : 0));
  const entries = [
    { user: user(1, "justChurned"), series: spendTo(N - 9) }, // 最后一次消费在 8 天前：今天算起第 8 天，刚变成已流失
    { user: user(2, "weekOld"), series: spendTo(N - 15) }, // 14 天前：还算本周新流失
    { user: user(3, "older"), series: spendTo(N - 16) }, // 15 天前：不是本周新流失
    { user: user(4, "longGone"), series: spendTo(N - 20) },
    { user: user(5, "tooLong"), series: spendTo(N - 45) }, // 前 30 天里没有消费：不算已流失
    { user: user(6, "active"), series: series(() => 5) },
  ];
  const [result, view] = churn(entries);
  assert.deepEqual(result.items.filter((entry) => entry.status === "churned").map((entry) => entry.username).sort(), ["justChurned", "longGone", "older", "weekOld"]);
  const justChurned = item(result, "justChurned");
  assert.deepEqual([justChurned.daysAgo, +justChurned.before.toFixed(4), justChurned.after, +justChurned.loss.toFixed(4)], [8, +(55 / 14).toFixed(4), 0, +(55 / 14).toFixed(4)], "11 天每天 5 美元，除以 14");
  assert.deepEqual([item(result, "weekOld").daysAgo, item(result, "older").daysAgo], [14, 15]);
  assert.equal(result.summary.newChurn.count, 2, "justChurned、weekOld");
  assert.ok(Math.abs(result.summary.newChurn.monthly - 2 * (55 / 14) * 30) < 1e-9, "以前每月花 = 流失前 14 天日均 × 30，两位加起来");
  assert.equal(view.users.find((row) => row.username === "tooLong").status, null);
  assert.equal(item(result, "tooLong"), undefined);
  assert.ok(result.items.map((entry) => entry.loss).every((loss, i, list) => i === 0 || list[i - 1] >= loss), "按一天少花多少从高到低排");
});

test("一个人只标一个状态：今天明显少了 > 在下滑 > 已流失", () => {
  const sameTime = { today: 0, usual: 10, usualDay: 30 };
  const [result] = churn([
    { user: user(1, "both"), series: mk(20, 2), sameTime },
    { user: user(2, "downOnly"), series: mk(20, 2) },
  ]);
  assert.deepEqual([item(result, "both").status, item(result, "both").loss, item(result, "downOnly").status], ["todayLow", 30, "down"]);
});

test("已流失排在在下滑前面：停了 8 天、前 14 天日均不低的人标「已流失」（一天少花 = 流失前 14 天日均），才停 5 天的是「在下滑」", () => {
  const stopAt = (last) => series((i) => (i <= last && i > last - 18 ? 20 : 0));
  const [result, view] = churn([{ user: user(1, "stopped8"), series: stopAt(N - 9) }, { user: user(2, "stopped5"), series: stopAt(N - 6) }]);
  assert.deepEqual([item(result, "stopped8").status, item(result, "stopped5").status], ["churned", "down"]);
  assert.equal(Math.round(item(result, "stopped8").loss * 100) / 100, Math.round((14 * 20 / 14) * 100) / 100, "流失前 14 天每天 $20");
  assert.equal(view.users.find((row) => row.username === "stopped8").status, "churned", "用户页签是同一个顺序");
});

test("回流：近 7 天（含今天）又有消费、开始之前已经连续 7 天以上没消费、再早有过消费；第一次花钱的、断得不够久的不算", () => {
  const burst = (from, to, usd = 6) => series((i) => ((i >= from && i <= to) || (i >= 0 && i < 5) ? usd : 0)); // 开头 5 天有过，再 burst
  const entries = [
    { user: user(1, "back"), series: burst(N - 3, N - 2) }, // 断了 80 多天
    { user: user(2, "gap7"), series: series((i) => (i === N - 20 || (i >= N - 6 && i <= N - 2) ? 6 : 0)) }, // N-19..N-7 共 13 天空档后回来
    { user: user(3, "gap6"), series: series((i) => (i === N - 14 || (i >= N - 7 && i <= N - 2) ? 6 : 0)) }, // 空档 N-13..N-8 = 6 天：不够
    { user: user(4, "first", { usedUsd: 18 }), series: series((i) => (i >= N - 4 && i <= N - 2 ? 6 : 0)) }, // 第一次花钱：累计消费 = 数据里的
    { user: user(5, "olderBefore", { usedUsd: 5000 }), series: series((i) => (i >= N - 4 && i <= N - 2 ? 6 : 0)) }, // 数据里没有更早的，但累计消费 5000：以前花过
    { user: user(6, "todayBack"), series: series((i) => (i === 3 || i === N - 1 ? 6 : 0)), today: 6 }, // 今天回来的
    { user: user(7, "steady"), series: series(() => 6) },
  ];
  const [result] = churn(entries);
  assert.deepEqual(result.returned.map((entry) => entry.username).sort(), ["back", "gap7", "olderBefore", "todayBack"]);
  assert.equal(result.summary.returned.count, 4);
  assert.deepEqual(result.summary.returned.top.map((entry) => entry.username), ["gap7", "olderBefore", "back"], "点名最多 3 位，按近 7 天花得多的排");
});

test("回流那格：点名最多 3 位，按花得多的排；花得一样按名字", () => {
  const entries = ["d", "c", "b", "a"].map((name, index) => ({ user: user(index + 1, name), series: series((i) => (i === 2 ? 5 : i >= N - 3 && i <= N - 2 ? 6 : 0)) }));
  const [result] = churn(entries);
  assert.deepEqual(result.summary.returned.top.map((entry) => entry.username), ["a", "b", "c"]);
  assert.equal(result.summary.returned.count, 4);
  assert.equal(CHURN_VIEW.RETURN_NAMES, 3);
});

test("月留存：上个 30 天花过钱的人里，这个 30 天还在花的占比；上一期是再往前 30 天；补到的天数不够就不出", () => {
  // 上个 30 天（倒数第 60 到第 31 天）的 10 位：7 位这个 30 天还在花；再往前 30 天（倒数第 90 到第 61 天）的 8 位：6 位上个 30 天还在花
  const prevCohort = (name, id, keptPrev, keptNow) => ({ user: user(id, name), series: series((i) => (i === 5 || (keptPrev && i === N - 45) || (keptNow && i === N - 5) ? 3 : 0)) });
  const entries = [];
  for (let k = 0; k < 8; k += 1) entries.push(prevCohort(`p${k}`, k + 1, k < 6, false)); // 前 8 位只在前一期有；其中 6 位上个 30 天还花
  for (let k = 0; k < 4; k += 1) entries.push({ user: user(20 + k, `n${k}`), series: series((i) => (i === N - 45 || i === N - 5 ? 3 : 0)) }); // 上个 30 天花、这个 30 天还花
  for (let k = 0; k < 3; k += 1) entries.push({ user: user(30 + k, `m${k}`), series: series((i) => (i === N - 45 ? 3 : 0)) }); // 上个 30 天花、这个 30 天没花
  const [result] = churn(entries);
  const retention = result.summary.retention;
  // 上个 30 天花过钱的：前一期 6 位（p0–p5）+ n0–n3 + m0–m2 = 13 位；这个 30 天还在花的 4 位（n）
  assert.deepEqual([retention.cohort, retention.kept], [13, 4]);
  assert.ok(Math.abs(retention.rate - 4 / 13) < 1e-9);
  assert.deepEqual([retention.prev.cohort, retention.prev.kept], [8, 6], "上一期：前一期的 8 位里 6 位上个 30 天还花");
  assert.ok(Math.abs(retention.prev.rate - 0.75) < 1e-9);
  // 只补到 70 天：上一期要 90 天，不出；补到 50 天：本期也不出
  const partial = (days) => ({ done: false, days, total: 90, cursorMs: grid.starts[N - 1 - days] });
  const [seventy] = churn(entries, { backfill: partial(70) });
  assert.equal(seventy.summary.retention.prev, null);
  assert.equal(seventy.ready.retentionPrev, false);
  const [fifty] = churn(entries, { backfill: partial(50) });
  assert.equal(fifty.summary.retention, null);
  // 上个 30 天没有花钱的人：比例是 null
  const [none] = churn([{ user: user(1, "x"), series: series(() => 0) }]);
  assert.deepEqual([none.summary.retention.cohort, none.summary.retention.rate], [0, null]);
});

test("主要用的模型：来自流失页那份近 30 天的数，没有的写 null", () => {
  const [result] = churn([{ user: user(1, "a"), series: mk(20, 2) }, { user: user(2, "b"), series: mk(20, 2) }], { models: new Map([["a", "gpt-4o"]]) });
  assert.deepEqual([item(result, "a").model, item(result, "b").model], ["gpt-4o", null]);
  const [unread] = churn([{ user: user(1, "a"), series: mk(20, 2) }]);
  assert.equal(item(unread, "a").model, null);
});

test("主表：只列在少花钱的人，按一天少花多少排；个数跟着「只看重点用户」；搜索不改个数；每页 50 个；合计行是这些人一天一共少花多少", () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({ user: user(index + 1, `u${String(index + 1).padStart(2, "0")}`), series: mk(10 + index, 1), big: index < 2 }));
  entries.push({ user: user(100, "gone"), series: series((i) => (i >= N - 25 && i < N - 15 ? 8 : 0)) });
  entries.push({ user: user(101, "fine"), series: series(() => 7) });
  const [result] = churn(entries);
  const all = queryChurn(result, {});
  assert.deepEqual([all.rows.length, all.total, all.pages, all.counts.only], [50, 61, 2, { all: 61, todayLow: 0, down: 60, churned: 1, returned: 0 }]);
  assert.equal(all.rows[0].username, "u60", "损失最大的排最前面");
  assert.equal(all.counts.big, 2);
  assert.equal(queryChurn(result, { page: 2 }).rows.length, 11);
  const big = queryChurn(result, { big: true });
  assert.deepEqual([big.total, big.counts.only.down, big.counts.only.churned], [2, 2, 0]);
  const searched = queryChurn(result, { q: "U6" });
  assert.deepEqual([searched.total, searched.counts.only.all], [1, 61], "搜索只筛表，个数不变");
  const churned = queryChurn(result, { only: "churned" });
  assert.deepEqual([churned.rows.map((row) => row.username), churned.totals.count], [["gone"], 1]);
  const downs = queryChurn(result, { only: "down" });
  assert.ok(Math.abs(downs.totals.loss - result.items.filter((entry) => entry.status === "down").reduce((total, entry) => total + entry.loss, 0)) < 1e-9, "合计行算筛出来的所有人，不只是这一页");
  assert.equal(queryChurn(result, { only: "bogus" }).total, 61);
});

test("主表还判不了的类个数是 null（页面写「—」）：今天明显少了要过去 7 天补全、在下滑要 17 天、已流失和回流要 37 天", () => {
  const [result] = churn([{ user: user(1, "a"), series: mk(20, 2) }], { backfill: { done: false, days: 3, total: 90, cursorMs: grid.starts[N - 4] } });
  const query = queryChurn(result, {});
  assert.deepEqual(query.counts.only, { all: 0, todayLow: null, down: null, churned: null, returned: null });
});

test("回流的人在表里单列：选「回流」时列回流的人，没有「一天少花多少」", () => {
  const [result] = churn([{ user: user(1, "back"), series: series((i) => (i === 2 || i === N - 2 ? 6 : 0)) }, { user: user(2, "down"), series: mk(20, 2) }]);
  const list = queryChurn(result, { only: "returned" });
  assert.deepEqual(list.rows.map((row) => [row.username, row.status, row.loss]), [["back", "returned", null]]);
  assert.equal(list.totals.loss, 0);
  assert.equal(queryChurn(result, {}).rows.some((row) => row.status === "returned"), false, "默认的表里没有回流的人");
});
