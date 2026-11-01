import test from "node:test";
import assert from "node:assert/strict";
import { USER_BALANCE, bigUsersOf, dailyAverages, decideUserAlert, usageUsdBetween, userBalanceMessage, userRunway, walletConsumption } from "./user-balance.js";

const H = 3600000, D = 24 * H, MIN = 60000;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const TZ = "Asia/Shanghai";
// 每 10 分钟一条快照：balanceAt(t) 给这一刻的余额
const series = (fromMs, toMs, balanceAt, step = 10 * MIN) => { const out = []; for (let t = fromMs; t <= toMs; t += step) out.push([t, Math.round(balanceAt(t) * 1e6) / 1e6]); return out; };
const hoursOf = (fromMs, toMs, usdPerHour) => { const map = new Map(); for (let h = Math.floor(fromMs / H) * H; h < toMs; h += H) map.set(h, usdPerHour); return map; };

test("降：每小时降 1 美元，日均 24，还够 余额 ÷ 24 天", () => {
  const start = NOW - 48 * H;
  const points = series(start, NOW, (t) => 100 - (t - start) / H);
  const runway = userRunway({ points, hours: new Map(), now: NOW });
  assert.equal(runway.burnPerDay, 24);
  assert.equal(runway.balanceUsd, 52);
  assert.equal(runway.days, 2.2);
  assert.deepEqual([runway.state, runway.level], ["soon", 1]);
});

test("涨（勤充小额）：一小时充一笔 10 美元、同时每小时花 8 美元；涨的那一格用按小时的用量补，日均 192，不会算成 160", () => {
  const start = NOW - 48 * H;
  // 每小时前 50 分钟每 10 分钟降 8/6，第 6 格（最后 10 分钟）降 8/6 又充 10：净涨 8.667
  let balance = 300;
  const points = [[start, balance]];
  for (let t = start + 10 * MIN; t <= NOW; t += 10 * MIN) {
    balance -= 8 / 6;
    if (Math.round((t - start) / (10 * MIN)) % 6 === 0) balance += 10;
    points.push([t, Math.round(balance * 1e6) / 1e6]);
  }
  const hours = hoursOf(start, NOW, 8);
  const withUsage = walletConsumption(points, hours, { now: NOW, windowMs: 2 * D, syncedMs: NOW });
  const withoutUsage = walletConsumption(points, new Map(), { now: NOW, windowMs: 2 * D, syncedMs: NOW });
  assert.ok(Math.abs(withUsage.burnPerDay - 192) < 4, `用量补上：${withUsage.burnPerDay}`);
  assert.ok(withoutUsage.burnPerDay < 170, `不补：${withoutUsage.burnPerDay}（涨的格子整格丢掉，算慢了）`);
});

test("涨的那一格隔得太久（平稳 22 小时、用量一直有，然后充一次值）：不用用量补，不出假的快用完", () => {
  // 余额一直 100 不动（有套餐，用量不扣钱包），24 小时一条的保底快照，22 小时后充到 170；用量每小时 10 美元
  const points = [[NOW - 47 * H, 100], [NOW - 23 * H, 100], [NOW - 1 * H, 170], [NOW, 170]];
  const hours = hoursOf(NOW - 48 * H, NOW, 10);
  const week = walletConsumption(points, hours, { now: NOW, windowMs: 7 * D, syncedMs: NOW });
  assert.equal(week.consumed, 0, "涨的那一格隔了 22 小时，钱包这段没在扣钱，算 0（以前会补上 220 美元用量）");
  assert.ok(week.positiveMs > 40 * H, "时间照算");
  const runway = userRunway({ points, hours, now: NOW });
  assert.deepEqual([runway.state, runway.level], ["none", 0]);
  // 同样的充值，两头快照隔 10 分钟（每轮都在变的用户）：照旧用量补
  const busy = [[NOW - 50 * MIN, 100], [NOW - 40 * MIN, 170], [NOW, 170]];
  assert.ok(Math.abs(walletConsumption(busy, hours, { now: NOW, windowMs: D, syncedMs: NOW }).consumed - 10 / 6) < 1e-6, "隔 10 分钟的涨格照旧补：10 美元/小时 × 10 分钟");
  const gapEdge = walletConsumption([[NOW - 3 * H, 100], [NOW - 3 * H + 20 * MIN, 150], [NOW, 150]], hoursOf(NOW - 4 * H, NOW, 6), { now: NOW, windowMs: D, syncedMs: NOW });
  assert.ok(Math.abs(gapEdge.consumed - 2) < 1e-6, "刚好 20 分钟还补：6 美元/小时 × 1/3 小时 = 2");
  const gapOver = walletConsumption([[NOW - 3 * H, 100], [NOW - 3 * H + 21 * MIN, 150], [NOW, 150]], hoursOf(NOW - 4 * H, NOW, 6), { now: NOW, windowMs: D, syncedMs: NOW });
  assert.equal(gapOver.consumed, 0, "21 分钟就不补");
});

test("订阅：用量一直有、余额一直不动（套餐里的消费不扣钱包）→ 速度是 0，不当成花钱，状态「近期没有花费」", () => {
  const start = NOW - 3 * D;
  const points = series(start, NOW, () => 50, 6 * H);
  const runway = userRunway({ points, hours: hoursOf(start, NOW, 10), now: NOW });
  assert.deepEqual([runway.state, runway.level, runway.days, runway.hasConsumption], ["none", 0, null, false]);
});

test("冷启动：快照不满 24 小时，算不出（—），不判；满了才判", () => {
  const points = series(NOW - 12 * H, NOW, (t) => 100 - (t - (NOW - 12 * H)) / H);
  assert.deepEqual([userRunway({ points, hours: new Map(), now: NOW }).state, userRunway({ points, hours: new Map(), now: NOW }).days], ["warming", null]);
  const longer = series(NOW - 25 * H, NOW, (t) => 100 - 1.5 * (t - (NOW - 25 * H)) / H);
  assert.equal(userRunway({ points: longer, hours: new Map(), now: NOW }).state, "soon");
});

test("余额 0 停用几天后又充值：分母只算余额大于 0 的时间，停用的几天不稀释速度", () => {
  const start = NOW - 7 * D;
  // 第 1 天：余额 5 → 0（降 5）；接着 0 余额停用 3 天；第 5 天开头充 20，之后每小时降 1，一直到现在（约 2 天）
  const rechargeAt = start + 4 * D;
  const points = [];
  for (let t = start; t <= NOW; t += H) {
    let b;
    if (t < start + D) b = 5 - 5 * ((t - start) / D);
    else if (t < rechargeAt) b = 0;
    else b = 200 - (t - rechargeAt) / H;
    points.push([t, Math.round(b * 1e6) / 1e6]);
  }
  const week = walletConsumption(points, hoursOf(start, NOW, 0), { now: NOW, windowMs: 7 * D, syncedMs: NOW });
  const positiveHours = week.positiveMs / H;
  assert.ok(Math.abs(positiveHours - 96) < 2, `停用的 3 天（72 小时）不算：${positiveHours}`);
  assert.ok(Math.abs(week.consumed - (5 + 72)) < 1, `降的合计：${week.consumed}`);
  const naive = week.consumed / 7;
  assert.ok(week.burnPerDay > naive * 1.4, `比按 7 天整段摊要快：${week.burnPerDay} vs ${naive}`);
  // 余额是 0、近 7 天没有消费的闲置号：idle，不算用完；有消费的用完才算 empty
  const idle = userRunway({ points: series(start, NOW, () => 0, 6 * H), hours: new Map(), now: NOW });
  assert.deepEqual([idle.state, idle.level], ["idle", 0]);
  const emptyStart = NOW - 30 * H;
  const empty = userRunway({ points: series(emptyStart, NOW, (t) => Math.max(0, 30 - (t - emptyStart) / H)), hours: new Map(), now: NOW });
  assert.deepEqual([empty.state, empty.level], ["empty", 2]);
});

test("近 7 天和最近 24 小时取快的：前几天慢、最近一天突然快，取快的（宁可早提醒）", () => {
  const start = NOW - 7 * D;
  const points = series(start, NOW, (t) => (t < NOW - D ? 1000 - (t - start) / H * 1 : 1000 - 6 * 24 - (t - (NOW - D)) / H * 10));
  const runway = userRunway({ points, hours: new Map(), now: NOW });
  assert.ok(runway.burnPerDay > 200, `取最近 24 小时的 240：${runway.burnPerDay}`);
});

test("最近 20 分钟内结束的涨格用量还没到齐：先不计，也不算时间", () => {
  const start = NOW - 30 * H;
  const points = [...series(start, NOW - 5 * MIN, () => 100, H), [NOW - 5 * MIN, 150], [NOW, 149]];
  const week = walletConsumption(points, hoursOf(start, NOW, 9), { now: NOW, windowMs: 2 * D, syncedMs: NOW });
  assert.ok(week.consumed < 1.01, `涨格没计：${week.consumed}`);
});

test("按小时的用量按重叠时长折算（当前不满一小时的桶只覆盖到同步时刻）", () => {
  const hour = 10 * H;
  const hours = new Map([[hour, 6]]);
  assert.equal(usageUsdBetween(hours, hour, hour + 30 * MIN), 3);
  assert.equal(usageUsdBetween(hours, hour + 10 * MIN, hour + 20 * MIN, hour + 30 * MIN), 2, "同步到 30 分：桶只有 30 分钟，6 美元匀在这 30 分钟里，10 分钟是 2 美元");
  assert.equal(usageUsdBetween(hours, hour + 40 * MIN, hour + 50 * MIN, hour + 30 * MIN), 0, "同步之后的部分没有数");
});

test("每个用户有消费的那几天的日均：没消费的天不算进分母", () => {
  const day = (offset, hourOffset = 3) => Date.parse("2026-10-28T00:00:00+08:00") + offset * D + hourOffset * H;
  const rows = [
    { username: "a", hourMs: day(0), usd: 10 }, { username: "a", hourMs: day(0, 5), usd: 5 }, { username: "a", hourMs: day(2), usd: 15 },
    { username: "b", hourMs: day(1), usd: 7 }, { username: "c", hourMs: day(1), usd: 0 },
  ];
  const averages = dailyAverages(rows, TZ);
  assert.equal(averages.get("a"), 15, "两天有消费：(15 + 15) ÷ 2");
  assert.equal(averages.get("b"), 7);
  assert.equal(averages.has("c"), false);
});

test("重点用户：日均从高到低累加到全站的八成，至少 3 人，不足 3 人全算，没消费的不算", () => {
  const ids = (list) => bigUsersOf(list.map((dailyAvg, index) => ({ id: index + 1, dailyAvg })));
  assert.deepEqual(ids([50, 30, 10, 5, 3, 2]), [1, 2, 3], "50、80 就到八成了，补满 3 人");
  assert.deepEqual(ids([30, 25, 20, 15, 5, 5]), [1, 2, 3, 4], "30、55、75、90：第 4 位跨过八成");
  assert.deepEqual(ids([60, 25, 5, 4, 3, 3]), [1, 2, 3]);
  assert.deepEqual(ids([10, 5]), [1, 2]);
  assert.deepEqual(ids([0, 0, 8, 2]), [3, 4], "没消费的不进");
  assert.deepEqual(bigUsersOf([{ id: "b", dailyAvg: 5 }, { id: "a", dailyAvg: 5 }, { id: "c", dailyAvg: 5 }, { id: "d", dailyAvg: 5 }, { id: "e", dailyAvg: 5 }]), ["a", "b", "c", "d"], "一样的按 id 排，结果稳定");
});

test("提醒判断：升到新一级推一次；同一级 24 小时内不重复；24 小时后按 renotifyHours 重复；0 = 只提醒一次", () => {
  const runway = (level, extra = {}) => ({ state: level ? "soon" : "ok", level, days: level === 2 ? 0.8 : level === 1 ? 2.5 : 10, balanceUsd: 10, ...extra });
  let decision = decideUserAlert({ prev: null, runway: runway(1), now: NOW });
  assert.equal(decision.push, true);
  assert.deepEqual(decision.state, { level: 1, notifiedAt: NOW, lastBalanceUsd: 10 });
  const sameLevel = (at, hours) => decideUserAlert({ prev: decision.state, runway: runway(1), now: at, repushHours: hours });
  assert.equal(sameLevel(NOW + 23 * H, 24).push, false);
  assert.equal(sameLevel(NOW + 25 * H, 24).push, true);
  assert.equal(sameLevel(NOW + 23 * H, 1).push, false, "renotifyHours 设得再小，同一级也不会不到 24 小时又推");
  assert.equal(sameLevel(NOW + 50 * H, 0).push, false, "0 = 只提醒一次");
  const up = decideUserAlert({ prev: decision.state, runway: runway(2), now: NOW + H });
  assert.deepEqual([up.push, up.state.level], [true, 2]);
  const down = decideUserAlert({ prev: up.state, runway: runway(1), now: NOW + 2 * H });
  assert.deepEqual([down.push, down.state.level], [false, 2], "二级降回一级不再推，也不清零");
});

test("提醒清零：只有预计天数回到一级线的 1.2 倍以上才清零；余额涨了不算；在线上下抖动不重复推", () => {
  const prev = { level: 1, notifiedAt: NOW, lastBalanceUsd: 10 };
  const ok = (days, balanceUsd = 10) => ({ state: "ok", level: 0, days, balanceUsd });
  assert.equal(decideUserAlert({ prev, runway: ok(3.3), now: NOW + H }).state.level, 1, "回到 3.3 天（< 3.6）还不清零");
  const cleared = decideUserAlert({ prev, runway: ok(3.7), now: NOW + H });
  assert.deepEqual([cleared.push, cleared.state.level, cleared.state.notifiedAt], [false, 0, null]);
  assert.equal(decideUserAlert({ prev: cleared.state, runway: { state: "soon", level: 1, days: 2.9, balanceUsd: 8 }, now: NOW + 2 * H }).push, true, "清零以后再降下来重新计数、再推一次");
  const recharged = decideUserAlert({ prev, runway: { state: "soon", level: 1, days: 2.8, balanceUsd: 10.5 }, now: NOW + H });
  assert.equal(recharged.push, false, "余额涨了、预计天数还在线以内：不清零，同一级 24 小时内不重复");
  assert.deepEqual([recharged.state.level, recharged.state.notifiedAt], [1, NOW]);
});

test("一直充小额：每小时花 3 美元、每小时充 5 美元、剩约 2 天，24 小时只推 1 次", () => {
  let prev = null, pushes = 0, balance = 144; // 144 ÷ 72（日均）= 2 天
  for (let hour = 0; hour < 24; hour += 1) {
    const runway = { state: "soon", level: 1, days: balance / 72, balanceUsd: balance };
    const decision = decideUserAlert({ prev, runway, now: NOW + hour * H, repushHours: 24 });
    if (decision.push) pushes += 1;
    prev = decision.state;
    balance += 5 - 3; // 余额每小时净涨 2，预计天数 2.0 → 2.7，一直没出 3.6 天
  }
  assert.equal(pushes, 1);
});

test("推送正文：几位一起推，按日均消费从高到低排；标题写「重点用户快用完」，全部用完才写「重点用户余额用完」", () => {
  const { title, body } = userBalanceMessage([
    { username: "small", balanceUsd: 10, burnPerDay: 5, days: 2, level: 1, dailyAvg: 5 },
    { username: "big", balanceUsd: 0, burnPerDay: 120, days: 0, level: 2, dailyAvg: 120 },
  ], "11月1日 20:00");
  assert.equal(title, "【重点用户快用完】big 等 2 位");
  const lines = body.split("\n");
  assert.match(lines[0], /^用户：big · 余额 \$0\.00 · 日均花费 \$120\.00 · 余额用完$/);
  assert.match(lines[1], /^用户：small · 余额 \$10\.00 · 日均花费 \$5\.00 · 还够约 2 天$/);
  assert.match(lines.at(-1), /炬元告警中心$/);
  assert.equal(userBalanceMessage([{ username: "alice", balanceUsd: 20, burnPerDay: 10, days: 2, level: 1, dailyAvg: 10 }], "t").title, "【重点用户快用完】alice 可用约 2 天");
  assert.equal(userBalanceMessage([{ username: "alice", balanceUsd: 0, burnPerDay: 10, days: 0, level: 2, dailyAvg: 10 }], "t").title, "【重点用户余额用完】alice");
  assert.equal(userBalanceMessage([{ username: "a", balanceUsd: 0, burnPerDay: 10, days: 0, level: 2, dailyAvg: 10 }, { username: "b", balanceUsd: 0, burnPerDay: 5, days: 0, level: 2, dailyAvg: 5 }], "t").title, "【重点用户余额用完】a 等 2 位");
  assert.ok(USER_BALANCE.CLEAR_FACTOR === 1.2 && USER_BALANCE.LEVEL1_DAYS === 3 && USER_BALANCE.LEVEL2_DAYS === 1);
});
