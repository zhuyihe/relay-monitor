// 用户运营的后台（server/user-ops.js）：假的自营站点（用户列表、按小时用量），内存存储，假时钟；一步 10 分钟
import test from "node:test";
import assert from "node:assert/strict";
import { createUserOps, forgetUserOps } from "./user-ops.js";
import { bigUsersSummary, userDetail, usersPage, usersResponse } from "./user-ops-page.js";
import { churnResponse } from "./user-ops-churn.js";
import { MemoryUserOpsStore } from "./test-support/user-ops-memory-store.js";
import { noteOwnRequest, resetOwnRequestBudget } from "../lib/own-request-budget.js";

const H = 3600000, MIN = 60000;
const START = Date.parse("2026-11-01T12:00:00Z");
const QUOTA_PER_UNIT = 500000;
const own = { id: "own1", name: "我的站点", isOwn: true, type: "newapi", baseUrl: "https://own.test", accessToken: "tok" };

// users：[{ id, username, role?, status?, balance, burn（每小时花多少美元，余额每步跟着降，用量表按小时生成） }]
function makeSite(t, users, { rules = {}, settings = {}, channels = [{ id: "c1", enabled: true, type: "webhook", name: "钉" }], send = null, tweak = {} } = {}) {
  resetOwnRequestBudget();
  const clock = { now: START };
  t.mock.method(Date, "now", () => clock.now);
  const site = { users: users.map((user) => ({ role: 1, status: 1, burn: 0, ...user })), requests: [], soft: false, softBackfill: false, hard: false };
  // 累计消费：用户可以自己给（used），也可以写 "auto"：从 since 起每小时 burn 美元一直到现在（since 之前没花过）
  const usedOf = (user) => (user.used === "auto" ? user.burn * Math.max(0, Math.floor(clock.now / 3600000) - Math.ceil((user.since ?? 0) / 3600000) + 1) : user.used ?? 0);
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    if (url.host !== "own.test") return { status: 404, text: async () => "{}" };
    site.requests.push(`${url.pathname}${url.pathname === "/api/data/users" ? `?${Number(url.searchParams.get("end_timestamp")) - Number(url.searchParams.get("start_timestamp")) > 4 * 3600 ? "day" : "recent"}` : ""}`);
    if (site.gate) await site.gate;
    if (site.hard) return { status: 500, text: async () => "{}" };
    const reply = (data) => ({ status: 200, text: async () => JSON.stringify({ success: true, data }) });
    const soft = { status: 200, text: async () => JSON.stringify({ success: false, message: "busy" }) };
    if (url.pathname === "/api/user/") {
      if (site.soft) return soft;
      return reply({ total: site.users.length, items: site.users.map((user) => ({ id: user.id, username: user.username, display_name: "", role: user.role, status: user.status, quota: Math.round(user.balance * QUOTA_PER_UNIT), used_quota: Math.round(usedOf(user) * QUOTA_PER_UNIT), group: user.group || "default", created_at: Math.floor((user.createdAt ?? START - 200 * 24 * H) / 1000) })) });
    }
    if (url.pathname === "/api/data/users") {
      const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
      const isDay = end - start > 4 * 3600;
      if (site.soft || (isDay && site.softBackfill)) return soft;
      const rows = [];
      for (const user of site.users) {
        if (!(user.burn > 0)) continue;
        for (let hour = Math.max(Math.ceil(start / 3600) * 3600, Math.ceil((user.since ?? 0) / 3600000) * 3600); hour <= Math.min(end, Math.floor(clock.now / 3600000) * 3600 - 0, user.until != null ? Math.floor(user.until / 1000) : Infinity); hour += 3600) {
          rows.push({ username: user.username, created_at: hour, token_used: 100, quota: Math.round(user.burn * QUOTA_PER_UNIT), count: 3 });
        }
      }
      return reply(rows);
    }
    if (url.pathname === "/api/data/flow") {
      if (site.flowFail) return { status: 500, text: async () => "{}" };
      return reply(site.flow || []);
    }
    if (url.pathname === "/api/data/") {
      // 一个用户按模型分（/api/data/?username=）：6 个模型，占比 40/25/15/10/6/4
      const username = url.searchParams.get("username"), user = site.users.find((item) => item.username === username);
      if (!user || !(user.burn > 0)) return reply([]);
      const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
      const weights = [40, 25, 15, 10, 6, 4], rows = [];
      for (let hour = Math.ceil(start / 3600) * 3600; hour <= Math.min(end, Math.floor(clock.now / 3600000) * 3600); hour += 3600) {
        weights.forEach((weight, index) => rows.push({ username, model_name: `model-${index + 1}`, created_at: hour, token_used: 10, quota: Math.round(user.burn * QUOTA_PER_UNIT * weight / 100), count: 1 }));
      }
      return reply(rows);
    }
    return { status: 404, text: async () => "{}" };
  });
  const sent = [];
  const rt = { store: { list: () => [own], settings: { ...settings }, rules: { onUserExhaust: true, onUserEta: true, renotifyHours: 24, etaDays: 3, userEtaDays: 3, ...rules }, channels } };
  const store = new MemoryUserOpsStore();
  const api = { ops: createUserOps(rt, { store, send: send || (async (list, title, body) => { sent.push({ title, body }); return [{ ok: true }]; }) }) };
  // 一步：时钟走 10 分钟，余额按每小时的花费降，然后跑一轮（api.ops 可以换成「重启以后」新建的那个）
  const step = async (options) => {
    clock.now += 10 * MIN;
    for (const user of site.users) if (user.burn > 0) user.balance = Math.max(0, user.balance - user.burn / 6);
    return api.ops.runOnce(options);
  };
  const stepsTo = async (hours) => { while (clock.now < START + hours * H) await step(); };
  const count = (path) => site.requests.filter((item) => item.startsWith(path)).length;
  return Object.assign(api, { site, clock, rt, store, sent, step, stepsTo, count, rules: rt.store.rules, newOps: () => createUserOps(rt, { store, send: async (list, title, body) => { sent.push({ title, body }); return [{ ok: true }]; } }) });
}

// 一群用户：两位重点用户（日均 120、72）、十位中等用户（日均 48，凑出全站的八成要用到这些人）、一位小用户、一位闲置号、一位管理员
const crowd = (extra = {}) => [
  { id: 1, username: "big1", balance: 280, burn: 5 },
  { id: 2, username: "big2", balance: 280, burn: 3 },
  ...Array.from({ length: 10 }, (_, index) => ({ id: 10 + index, username: `mid${index}`, balance: 5000, burn: 2 })),
  { id: 30, username: "small", balance: 3, burn: 0.1 },
  { id: 31, username: "idle", balance: 0, burn: 0 },
  { id: 99, username: "root", role: 100, balance: 1, burn: 0 },
  ...(extra.users || []),
];

test("第一轮：给非管理员用户记余额快照、读最近 3 小时用量、回补 3 天；对用户 New API 的请求：用户列表 1 + data/users 4", async (t) => {
  const f = makeSite(t, crowd());
  const out = await f.step();
  assert.deepEqual([out.snapshots, out.errors.length, out.backfill.steps], [14, 0, 3], "管理员不记");
  assert.equal(f.count("/api/user/"), 1);
  assert.equal(f.count("/api/data/users?recent"), 1);
  assert.equal(f.count("/api/data/users?day"), 3);
  const points = await f.store.listBalancePoints("own1", 0);
  assert.equal(points.size, 14);
  assert.equal(points.has(99), false);
  const usage = await f.store.listUsageHours("own1", 0);
  assert.ok(usage.length > 0 && usage.every((row) => row.quota > 0));
});

test("回补 90 天：每轮最多 3 个请求，30 轮补完；补完以后每轮只剩用户列表 + 最近 3 小时两个请求；回补期间页面写补全进度", async (t) => {
  const f = makeSite(t, crowd());
  const progress = [];
  for (let run = 1; run <= 30; run += 1) { await f.step(); progress.push(f.ops.getView().backfill); }
  assert.deepEqual([progress[0].done, progress[0].days, progress[0].total], [false, 3, 90], "补全中 3/90");
  assert.deepEqual([progress[4].done, progress[4].days], [false, 15]);
  assert.deepEqual([progress[18].done, progress[18].core, progress[18].days], [false, false, 57]);
  assert.deepEqual([progress[19].done, progress[19].core, progress[19].days], [false, true, 60], "补到 60 天：提醒可以判了，后 30 天接着补");
  assert.deepEqual([progress[28].done, progress[28].days], [false, 87]);
  assert.deepEqual([progress.at(-1).done, progress.at(-1).days], [true, 90]);
  assert.equal(f.count("/api/data/users?day"), 90, "一天一个请求，共 90 个");
  const before = f.site.requests.length;
  await f.step();
  assert.deepEqual(f.site.requests.slice(before), ["/api/user/", "/api/data/users?recent"]);
});

test("已经补完 60 天的站升级以后：目标往前挪到 90 天，从补到的地方接着往前补 30 天（一天一个请求，不重补前 60 天），提醒不被拦", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 20; run += 1) await f.step();
  assert.equal(f.ops.getView().backfill.core, true);
  // 模拟升级前的库：目标是 60 天（比现在的目标晚 30 天），而且已经补完
  const progress = await f.store.getProgress("own1");
  const day = 86400000;
  await f.store.saveProgress("own1", { backfillTargetMs: progress.backfillTargetMs + 30 * day, backfillCursorMs: progress.backfillTargetMs + 30 * day }, f.clock.now);
  const before = f.count("/api/data/users?day");
  await f.step();
  assert.equal(f.count("/api/data/users?day") - before, 3, "接着往前补，每轮 3 个");
  const view = f.ops.getView();
  assert.deepEqual([view.backfill.done, view.backfill.core], [false, true], "还在补，但提醒照常（前 60 天都有）");
  for (let run = 0; run < 9; run += 1) await f.step();
  assert.equal(f.ops.getView().backfill.done, true);
  assert.equal(f.count("/api/data/users?day") - before, 30, "只多读了 30 天");
});

test("总开关关了：一个请求都不发；10 分钟内再跑一次：跳过；额度断路了：整轮不读", async (t) => {
  const off = makeSite(t, crowd(), { settings: { userOpsEnabled: false } });
  assert.deepEqual(await off.step(), { skipped: "off" });
  assert.equal(off.site.requests.length, 0);
  const g = makeSite(t, crowd());
  await g.step();
  assert.deepEqual(await g.ops.runOnce(), { skipped: "interval" });
  const h = makeSite(t, crowd());
  noteOwnRequest("https://own.test/api/x", { status: 500, now: h.clock.now + 10 * MIN });
  assert.deepEqual(await h.step(), { skipped: "budget" });
  assert.equal(h.site.requests.length, 0);
  const i = makeSite(t, crowd());
  for (let n = 0; n < 220; n += 1) noteOwnRequest("https://own.test/api/x", { status: 200, now: i.clock.now + 10 * MIN - 1000 });
  assert.deepEqual(await i.step(), { skipped: "budget" }, "最近 180 秒已经发了很多请求：让给别的读取");
});

test("余额快照：变了才写，没变的每天补一条", async (t) => {
  const f = makeSite(t, [{ id: 1, username: "a", balance: 10, burn: 0 }, { id: 2, username: "b", balance: 20, burn: 0 }]);
  assert.equal((await f.step()).snapshots, 2);
  assert.equal((await f.step()).snapshots, 0, "没变不写");
  f.site.users[0].balance = 9;
  assert.equal((await f.step()).snapshots, 1, "只写变了的那位");
  await f.stepsTo(26);
  const points = await f.store.listBalancePoints("own1", 0);
  assert.equal(points.get(2).length, 2, "b 没变，满 24 小时补了一条");
});

test("端到端：两位重点用户一起快用完 → 24 小时后一条推送、按日均消费从高到低；余额用完再推一次（只有快用完、余额用完两档）；小用户不是重点用户不推送；没有重复", async (t) => {
  const f = makeSite(t, crowd(), { rules: { renotifyHours: 0 } }); // 0 = 同一级只提醒一次；每天重复提醒另有用例
  await f.stepsTo(72);
  assert.equal(f.sent.length, 2, f.sent.map((item) => `${item.title}\n${item.body}`).join("\n=====\n"));
  const [first, second] = f.sent;
  assert.equal(first.title, "【重点用户快用完】big1 等 2 位");
  assert.match(first.body.split("\n")[0], /^用户：big1 /);
  assert.match(first.body.split("\n")[1], /^用户：big2 /);
  assert.equal(second.title, "【重点用户余额用完】big1", "big1 余额用完是单独一档，当轮就推；中间没有「1 天以内」那一档");
  assert.equal(second.body.split("\n").filter((line) => line.startsWith("用户：")).length, 1);
  assert.ok(f.sent.every((item) => !item.body.includes("small") && !item.body.includes("mid") && !item.body.includes("idle") && !item.body.includes("root")), "不是重点用户、闲置号、管理员都不推");
  const view = f.ops.getView();
  assert.equal(view.users.get(30).big, false);
  assert.ok(view.users.get(30).level >= 1, "小用户列表里照样有状态，只是不推送");
  assert.deepEqual([view.users.get(1).big, view.users.get(2).big], [true, true]);
  assert.equal(view.users.get(31).state, "idle", "余额 0、近 7 天没消费的号不算用完");
});

test("推送在 24 小时之后才出：快照不满 24 小时写「—」、不判、不推", async (t) => {
  const f = makeSite(t, crowd());
  await f.stepsTo(23);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ops.getView().users.get(1).state, "warming");
  assert.equal(f.ops.getView().users.get(1).days, null);
  await f.stepsTo(25);
  assert.equal(f.sent.length, 1);
});

test("两条规则（重点用户余额用完、重点用户快用完）都关：不推送，也不记提醒状态", async (t) => {
  const f = makeSite(t, crowd(), { rules: { onUserExhaust: false, onUserEta: false } });
  await f.stepsTo(40);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.getAlertStates("own1")).size, 0);
});

test("重启以后不重复推：提醒状态在库里", async (t) => {
  const f = makeSite(t, crowd());
  await f.stepsTo(25);
  assert.equal(f.sent.length, 1);
  f.ops = f.newOps(); // 重启：内存里的快照缓存、限频都没了，只剩库
  for (let n = 0; n < 6; n += 1) await f.step();
  assert.equal(f.sent.length, 1, "同一级 24 小时内不重复");
});

test("充到够用：预计天数回到一级线的 1.2 倍以上，这一级的提醒清零重新计数，这一刻不推送", async (t) => {
  const f = makeSite(t, crowd());
  await f.stepsTo(25);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.getAlertStates("own1")).get(1).level, 1);
  f.site.users[0].balance += 1000;
  await f.step();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.getAlertStates("own1")).get(1).level, 0);
});

test("没有可用的通知方式：一条都没送到，提醒状态退回，下一轮再试", async (t) => {
  const f = makeSite(t, crowd(), { channels: [], send: async () => [] });
  await f.stepsTo(26);
  assert.equal((await f.store.getAlertStates("own1")).get(1)?.level ?? 0, 0, "没送到不记已发");
  f.ops = f.newOps();
  await f.step();
  assert.equal(f.sent.length, 1, "通知方式配好以后下一轮补推");
});

test("数据过期不推送：用户列表和用量超过 30 分钟没读成，到了该推的时候也不推；恢复以后再推", async (t) => {
  const f = makeSite(t, crowd());
  await f.stepsTo(22);
  f.site.soft = true;
  await f.stepsTo(26);
  assert.equal(f.sent.length, 0, "读不到的这几个小时：快照和用量都过期了");
  assert.equal(f.ops.getView().fresh, false);
  f.site.soft = false;
  await f.step();
  assert.equal(f.sent.length, 0, "数据恢复了，但中间看不见的这段不能算「持续」：重新计 30 分钟");
  assert.ok([...(await f.store.getAlertStates("own1")).values()].every((state) => state.soonSince == null || state.soonSince >= f.clock.now - 10 * 60000), "第一次判成快用完的时刻在数据过期时清掉了");
  for (let n = 0; n < 3; n += 1) await f.step();
  assert.equal(f.sent.length, 1, "恢复以后持续满 30 分钟才推");
});

test("回补没完成之前不推送：回补读不成，到了 24 小时也不推；补完以后再推", async (t) => {
  const f = makeSite(t, crowd());
  f.site.softBackfill = true;
  await f.stepsTo(30);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ops.getView().backfill.done, false);
  f.site.softBackfill = false;
  await f.stepsTo(36);
  assert.equal(f.ops.getView().backfill.done, true);
  assert.equal(f.sent.length >= 1, true);
});

test("读用户列表失败不拖垮别的：这一轮用量照样读、错误记在结果里", async (t) => {
  const f = makeSite(t, crowd());
  await f.step();
  f.site.users.forEach((user) => { user.balance -= 1; });
  const original = f.site.soft;
  f.site.soft = true;
  const out = await f.step();
  assert.ok(out.errors.some((error) => error.startsWith("users")));
  f.site.soft = original;
});

test("一级提醒一直没好：按 renotifyHours（默认 24 小时）每天最多再提醒一次", async (t) => {
  // 三位用户都是重点用户；A 每天花 24 美元，24 小时时余额 60（还够 2.5 天，一级），到 49 小时还是一级（还够 1.5 天）
  const f = makeSite(t, [{ id: 1, username: "A", balance: 84, burn: 1 }, { id: 2, username: "B", balance: 9000, burn: 1 }, { id: 3, username: "C", balance: 9000, burn: 1 }], { rules: { renotifyHours: 24 } });
  await f.stepsTo(24 + 23);
  assert.equal(f.sent.length, 1, "A 一级推过一次，23 小时后还没到再提醒的时候");
  await f.stepsTo(24 + 25);
  assert.equal(f.sent.length, 2, "过了 24 小时仍然在一级：再提醒一次");
});

// ===== 用户运营页的接口（server/user-ops-page.js）=====
const pageOf = (f) => usersPage(f.rt, f.ops, f.store, { now: f.clock.now });

test("整页：补完 90 天以后，用户表、概览的数、重点用户、趋势都出来；状态来自余额和用量", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await f.step();
  const page = await pageOf(f);
  assert.deepEqual([page.starting, page.ready.backfillDone, page.ready.week, page.ready.compare, page.ready.down, page.ready.balance], [undefined, true, true, true, true, false], "余额快照才记了 2 小时：可用天数还不出");
  assert.equal(page.users.length, 14, "15 个账号里管理员不进表；闲置号（余额 0、没消费）也在表里，只是不标状态");
  const names = page.users.map((row) => row.username);
  assert.ok(names.includes("big1") && names.includes("idle") && !names.includes("root"));
  assert.equal(page.trend.length, 30);
  assert.equal(page.prevTrend.length, 30);
  assert.ok(page.prevTrend.every((day) => day.available && day.cost > 0), "前 30 天也补到了");
  assert.ok(page.trend.every((day) => day.available));
  const big1 = page.users.find((row) => row.username === "big1");
  assert.equal(big1.week, 5 * 24 * 7, "近 7 天（7 个整天）= 每小时 5 美元 × 168");
  assert.equal(big1.big, true);
  assert.equal(page.big.ready, true);
  assert.ok(page.big.count >= 3);
  assert.equal(page.rate, 1);
  assert.ok(page.summary.weekCost > 0 && page.summary.prevWeekCost > 0);
  assert.equal(page.users.find((row) => row.username === "idle").status, null);
});

test("整页：回补没补完时，比前 7 天、在下滑这些不判，重点用户不出；没读到过数时是 starting", async (t) => {
  const f = makeSite(t, crowd());
  const before = await pageOf(f);
  assert.equal(before.starting, true);
  assert.deepEqual([before.backfill.done, before.backfill.days, before.backfill.total], [false, 0, 90]);
  await f.step();
  const page = await pageOf(f);
  assert.deepEqual([page.ready.week, page.ready.compare, page.ready.down, page.big.ready, page.big.count], [false, false, false, false, 0]);
  assert.equal(page.backfill.done, false);
  assert.ok(page.users.length > 0, "用户表照常有（余额、今天的数先有）");
});

test("整页只在采集那一轮变了才重算；整天的消费记在内存里，下一轮只重读最近两天的按小时用量", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await f.step();
  const first = await pageOf(f);
  const afterFirst = f.store.calls.usageRowsRead;
  assert.equal(await pageOf(f), first, "同一轮：直接用缓存，对象都是同一个");
  assert.equal(f.store.calls.usageRowsRead, afterFirst, "没读库");
  await f.step();
  const readsBefore = f.store.calls.usageRowsRead;
  const second = await pageOf(f);
  const read = f.store.calls.usageRowsRead - readsBefore;
  assert.ok(second !== first);
  const eachDay = 14 * 24; // 每个有消费的用户每天最多 24 行（这里 14 个用户里 12 个在花钱）
  assert.ok(read <= 2.3 * 12 * 24 + 100, `只重读最近两天：${read} 行（整 35 天是 ${35 * 12 * 24} 行，每天 ${eachDay}）`);
  assert.deepEqual(second.users.map((row) => row.week), first.users.map((row) => row.week), "整天的数没变");
});

test("抽屉：近 30 天每天、今天每小时、余额变化和充值、近 7 天按模型分（前 4 个 + 其他）；按用户名缓存 10 分钟", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await f.step();
  f.site.users.find((user) => user.username === "big1").balance += 500; // 充值
  await f.step();
  const modelRequests = () => f.site.requests.filter((item) => item === "/api/data/").length;
  const before = modelRequests();
  const detail = await userDetail(f.rt, f.ops, f.store, 1, { now: f.clock.now });
  assert.equal(detail.username, "big1");
  assert.equal(detail.dayBars.length, 30);
  assert.equal(detail.dayBars.at(-2).cost, 5 * 24);
  assert.ok(detail.hourBars.length >= 1);
  assert.equal(detail.recharges.length, 1);
  assert.ok(detail.recharges[0].usd > 400);
  assert.deepEqual(detail.models.models.map((item) => [item.model, Math.round(item.share * 100)]), [["model-1", 40], ["model-2", 25], ["model-3", 15], ["model-4", 10]]);
  assert.deepEqual([detail.models.others.count, Math.round(detail.models.others.share * 100)], [2, 10]);
  assert.equal(modelRequests() - before, 1, "点开读 1 个");
  await userDetail(f.rt, f.ops, f.store, 1, { now: f.clock.now });
  assert.equal(modelRequests() - before, 1, "10 分钟内再点开：用缓存，不再读");
  assert.equal(detail.user.status, null);
  assert.equal(detail.user.big, true);
});

test("抽屉：额度紧或断路时不读按模型分（BUSY），别的照给；用户不存在、是管理员是 notFound；没设置自营站点是 unset", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 3; run += 1) await f.step();
  for (let n = 0; n < 220; n += 1) noteOwnRequest("https://own.test/api/x", { status: 200, now: f.clock.now });
  const before = f.site.requests.length;
  const busy = await userDetail(f.rt, f.ops, f.store, 1, { now: f.clock.now });
  assert.deepEqual([busy.models.models, busy.models.error], [null, "BUSY"]);
  assert.equal(busy.dayBars.length, 30);
  assert.equal(f.site.requests.length, before, "一个请求都没发");
  assert.equal((await userDetail(f.rt, f.ops, f.store, 99, { now: f.clock.now })).notFound, true, "管理员不给看");
  assert.equal((await userDetail(f.rt, f.ops, f.store, 12345, { now: f.clock.now })).notFound, true);
  const none = { store: { list: () => [], settings: {}, rules: {}, channels: [] } };
  assert.equal((await usersPage(none, f.ops, f.store)).unset, true);
});

test("同一个用户同时点几次，按模型分只读一次", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 3; run += 1) await f.step();
  const before = f.site.requests.filter((item) => item === "/api/data/").length;
  await Promise.all([1, 2, 3].map(() => userDetail(f.rt, f.ops, f.store, 1, { now: f.clock.now })));
  assert.equal(f.site.requests.filter((item) => item === "/api/data/").length - before, 1);
});

// 余额用完和快用完各有各的「发到」：big1 的余额在 20 小时时被清零（余额用完），big2 余额不多（快用完），两个在同一轮到点
const bigPair = () => [
  { id: 1, username: "big1", balance: 5000, burn: 5 },
  { id: 2, username: "big2", balance: 100, burn: 3 },
  ...Array.from({ length: 10 }, (_, index) => ({ id: 10 + index, username: `mid${index}`, balance: 5000, burn: 2 })),
];
const twoChannels = [{ id: "c1", enabled: true, type: "webhook", name: "钉" }, { id: "c2", enabled: true, type: "webhook", name: "飞书" }];
const perEvent = { renotifyHours: 0, channelsFor: { userExhaust: ["c1"], userEta: ["c2"] } };

test("「发到」各管各的：同一轮既有余额用完又有快用完，分两条推，余额用完只发到它选的通知方式，快用完只发到它选的", async (t) => {
  const sentTo = [];
  const send = async (list, title, body) => { sentTo.push({ ids: list.map((channel) => channel.id), title, body }); return [{ ok: true }]; };
  const f = makeSite(t, bigPair(), { channels: twoChannels, send, rules: perEvent });
  await f.stepsTo(20);
  f.site.users[0].balance = 0;
  await f.stepsTo(26);
  assert.equal(sentTo.length, 2, sentTo.map((item) => `${item.ids}\n${item.body}`).join("\n=====\n"));
  const exhaust = sentTo.find((item) => item.ids.join() === "c1"), eta = sentTo.find((item) => item.ids.join() === "c2");
  assert.ok(exhaust && eta);
  assert.match(exhaust.body, /用户：big1 /);
  assert.ok(!exhaust.body.includes("big2"));
  assert.match(eta.body, /用户：big2 /);
  assert.ok(!eta.body.includes("big1"));
  assert.equal(f.ops.getView().users.get(1).state, "empty");
});

test("一条都没送到：退回级别和提醒时刻（第一次判成快用完的时刻留着），下一轮再试；合成一条发到两个「发到」的并集，只要有一个通知方式收到就算送到", async (t) => {
  const calls = [];
  let down = true;
  const send = async (list, title, body) => { calls.push({ ids: list.map((channel) => channel.id), title, body }); return list.map(() => ({ ok: !down })); };
  const f = makeSite(t, bigPair(), { channels: twoChannels, send, rules: perEvent });
  await f.stepsTo(20);
  f.site.users[0].balance = 0; // big1 余额用完，big2 快用完
  for (let n = 0; n < 400 && !calls.length; n += 1) await f.step();
  assert.equal(calls[0].title, "【重点用户余额用完】big1", "余额用完当轮就推，不等");
  assert.deepEqual(calls[0].ids, ["c1"], "只有余额用完时发到它选的");
  let states = await f.store.getAlertStates("own1");
  assert.equal(states.get(1)?.level ?? 0, 0, "没送到：退回");
  assert.equal(await f.store.getProgress("own1").then((progress) => progress.alertPushedMs ?? null), null, "没送到：不算推过");
  assert.ok(states.get(2).soonSince != null, "big2 第一次判成快用完的时刻留着");
  await f.step(); await f.step();
  down = false; // 通知方式好了
  await f.step(); // 离 big2 第一次快用完满 30 分钟：和 big1 的余额用完合成一条
  const merged = calls.at(-1);
  assert.equal(merged.title, "【重点用户余额用完】big1 等 2 位");
  assert.deepEqual(merged.ids.sort(), ["c1", "c2"], "合成一条：两个「发到」的并集");
  states = await f.store.getAlertStates("own1");
  assert.deepEqual([states.get(1).level, states.get(2).level], [2, 1]);
  assert.ok((await f.store.getProgress("own1")).alertPushedMs != null);
});

// ===== 防刷屏：快用完要持续 30 分钟才推；30 分钟内新触发的合成一条；余额用完不等 =====
// 一群大户：A（id 1）余额少，一开始就快用完；B、C、D 钱多，用例里再把余额拨低；十位中等用户垫底。提醒线 3 天
const calmUsers = () => [
  { id: 1, username: "alice", balance: 300, burn: 5 },
  { id: 2, username: "bob", balance: 5000, burn: 5 },
  { id: 3, username: "carol", balance: 5000, burn: 5 },
  { id: 4, username: "dave", balance: 5000, burn: 5 },
  ...Array.from({ length: 10 }, (_, index) => ({ id: 10 + index, username: `mid${index}`, balance: 5000, burn: 2 })),
];
// 数据凑够 24 小时、alice 第一次判成快用完的那一轮（r0）；返回这一轮的时刻
async function toFirstSoon(f) {
  for (let n = 0; n < 400 && f.ops.getView()?.users.get(1)?.state !== "soon"; n += 1) await f.step();
  assert.equal(f.ops.getView()?.users.get(1)?.state, "soon", "alice 应该判成快用完");
  return f.clock.now;
}
const titles = (f) => f.sent.map((item) => item.title);

test("防刷屏：一阵突发，20 分钟后就不是快用完了：不推，第一次判成快用完的时刻清掉，下次重新计", async (t) => {
  const f = makeSite(t, calmUsers(), { rules: { renotifyHours: 0 } });
  const t0 = await toFirstSoon(f);
  assert.equal(f.sent.length, 0, "第一轮判成快用完：先记时刻，不推");
  assert.equal((await f.store.getAlertStates("own1")).get(1).soonSince, t0);
  await f.step(); await f.step(); // r1、r2：20 分钟
  assert.equal(f.sent.length, 0);
  f.rules.userEtaDays = 0.0001; // 速度降下来、不再算快用完（提醒线拉到很小，等价于这一轮不是快用完）
  await f.step();
  assert.equal((await f.store.getAlertStates("own1")).get(1).soonSince, null, "有一轮不是快用完，时刻清掉");
  f.rules.userEtaDays = 3;
  for (let n = 0; n < 3; n += 1) await f.step();
  assert.equal(f.sent.length, 0, "又是快用完：从头计，还没满 30 分钟");
  await f.step();
  assert.equal(f.sent.length, 1, "重新持续满 30 分钟才推");
});

test("防刷屏：一直是快用完，第一次判成快用完之后满 30 分钟的那一轮推一次，之后不重复", async (t) => {
  const f = makeSite(t, calmUsers(), { rules: { renotifyHours: 0 } });
  const t0 = await toFirstSoon(f);
  for (let n = 1; n <= 2; n += 1) { await f.step(); assert.equal(f.sent.length, 0, `第 ${n * 10} 分钟`); }
  await f.step();
  assert.equal(f.clock.now - t0, 30 * 60000);
  assert.equal(f.sent.length, 1, "第 30 分钟推一次");
  assert.match(f.sent[0].title, /^【重点用户快用完】alice 可用约 /);
  assert.match(f.sent[0].body, /用户：alice /);
  for (let n = 0; n < 6; n += 1) await f.step();
  assert.equal(f.sent.length, 1, "同一档不重复");
});

test("防刷屏：余额用完不等，当轮就推；快用完还没满 30 分钟的不带", async (t) => {
  const f = makeSite(t, calmUsers(), { rules: { renotifyHours: 0 } });
  await toFirstSoon(f); // alice 快用完（刚记时刻）
  f.site.users[1].balance = 0; // bob 余额用完
  await f.step();
  assert.deepEqual(titles(f), ["【重点用户余额用完】bob"], "余额用完当轮就推，只有 bob：alice 才快用完 10 分钟，不带");
});

test("防刷屏：推完 10 分钟内又有两人触发，先攒着，满 30 分钟合成一条推（重启以后也一样）", async (t) => {
  const f = makeSite(t, calmUsers(), { rules: { renotifyHours: 0 } });
  await toFirstSoon(f); // r0：alice 快用完
  await f.step();       // r1
  f.site.users[1].balance = 60; // bob 在 r2 前后触发快用完（第一次判成快用完是 r2）
  await f.step();       // r2
  f.site.users[2].balance = 60; // carol 在 r3 触发
  await f.step();       // r3：alice 满 30 分钟，推（上一条用户提醒是这一刻）
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].body, /用户：alice /);
  assert.ok(!f.sent[0].body.includes("bob") && !f.sent[0].body.includes("carol"));
  await f.step();       // r4：bob 满 30 分钟的是 r5，这里都还不到
  await f.step();       // r5：bob 满 30 分钟，但上一条推出去才 20 分钟：攒着
  assert.equal(f.sent.length, 1, "上一条推出去不满 30 分钟：攒着不推");
  f.ops = f.newOps();   // 重启：攒着的状态（第一次快用完的时刻、上一条推出去的时刻）都在库里
  await f.step();       // r6：carol 也满了，上一条推出去 30 分钟：合成一条
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].title, "【重点用户快用完】bob 等 2 位", "bob、carol 合成一条");
  assert.match(f.sent[1].body, /用户：bob /);
  assert.match(f.sent[1].body, /用户：carol /);
  await f.step(); await f.step();
  assert.equal(f.sent.length, 2, "之后不重复");
});

test("防刷屏：余额用完插队时，带上已经满足 30 分钟、攒着的快用完，合成同一条", async (t) => {
  const f = makeSite(t, calmUsers(), { rules: { renotifyHours: 0 } });
  await toFirstSoon(f); // r0
  await f.step();       // r1
  f.site.users[1].balance = 60;
  await f.step();       // r2：bob 开始
  f.site.users[2].balance = 60;
  await f.step();       // r3：alice 推（第一条）；carol 开始
  await f.step();       // r4
  assert.equal(f.sent.length, 1);
  f.site.users[3].balance = 0; // dave 余额用完
  await f.step();       // r5：bob 已满 30 分钟（攒着），carol 才 20 分钟；dave 插队，带上 bob，不带 carol
  assert.equal(f.sent.length, 2, titles(f).join("\n"));
  assert.equal(f.sent[1].title, "【重点用户余额用完】dave 等 2 位");
  const lines = f.sent[1].body.split("\n").filter((line) => line.startsWith("用户："));
  assert.match(lines[0], /^用户：dave /, "余额用完的排在前面");
  assert.match(lines[1], /^用户：bob /);
  assert.equal(lines.length, 2, "carol 才满 20 分钟，不带");
  await f.step(); await f.step(); // r6：carol 满 30 分钟，但上一条（r5）才推出去 10 分钟：攒着；r7 同
  assert.equal(f.sent.length, 2, "carol 攒着");
  await f.step(); // r8：上一条推出去满 30 分钟：carol 自己推
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2].title, /^【重点用户快用完】carol /);
});

test("防刷屏：重启以后接着算——第一次判成快用完的时刻在库里，重启不重新计，也不提前推", async (t) => {
  const f = makeSite(t, calmUsers(), { rules: { renotifyHours: 0 } });
  const t0 = await toFirstSoon(f);
  await f.step();
  f.ops = f.newOps(); // 重启
  await f.step(); // t0 + 20
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.getAlertStates("own1")).get(1).soonSince, t0, "时刻没变");
  f.ops = f.newOps();
  await f.step(); // t0 + 30：满了，推
  assert.equal(f.sent.length, 1);
});

test("告警中心那句「现在是 N 个重点用户」的名单：近 7 天补到以后才有，按每天花得多的排；没补到是 ready: false、名单空；没设置自营站点是 unset", async (t) => {
  const f = makeSite(t, crowd());
  assert.deepEqual(bigUsersSummary(f.rt, f.ops, { now: f.clock.now }), { ready: false, big: [] }, "一轮都没跑");
  await f.step();
  assert.deepEqual(bigUsersSummary(f.rt, f.ops, { now: f.clock.now }), { ready: false, big: [] }, "回补才补了 3 天");
  for (let run = 0; run < 2; run += 1) await f.step();
  const half = bigUsersSummary(f.rt, f.ops, { now: f.clock.now });
  assert.equal(half.ready, true, "补到 7 个整天（第 3 轮 9 天）就能算");
  assert.deepEqual(half.big.slice(0, 2).map((user) => user.username), ["big1", "big2"], "每天花得多的在前（big1 日均 120、big2 72）");
  assert.ok(half.big.length >= 3);
  const none = { store: { list: () => [], settings: {}, rules: {}, channels: [] } };
  assert.equal(bigUsersSummary(none, f.ops).unset, true);
});

test("预收「比 7 天前」：快照满 7 天才有；7 天前的预收 = 那一刻每个用户最后一次记下的余额加起来（管理员不算）", async (t) => {
  const f = makeSite(t, crowd());
  await f.stepsTo(30);
  const early = await pageOf(f);
  assert.equal(early.ready.prepaidCompare, false);
  assert.equal(early.summary.prepaidAgo, null);
  await f.stepsTo(8 * 24);
  const page = await pageOf(f);
  assert.equal(page.ready.prepaidCompare, true);
  // 起点后 24 小时（= 现在往前 7 天）：big1 280−120、big2 280−72、十位中等用户各 5000−48、small 3−2.4、idle 0
  assert.ok(Math.abs(page.summary.prepaidAgo - (160 + 208 + 10 * 4952 + 0.6)) < 0.01, String(page.summary.prepaidAgo));
  assert.ok(page.summary.prepaid < page.summary.prepaidAgo, "余额一直在降");
});

test("删除自营站点（或改地址）时正在跑的那一轮：迟到的写不会把数据写回来，下一轮从头来", async (t) => {
  const f = makeSite(t, crowd());
  f.rt.pool = {};
  f.rt._userOpsStore = f.store;
  await f.step();
  assert.ok((await f.store.listUsageHours("own1", 0)).length > 0);
  let release;
  f.site.gate = new Promise((resolve) => { release = resolve; });
  const running = f.step(); // 对自营站点的第一个请求挂住
  await new Promise((resolve) => setTimeout(resolve, 20));
  await forgetUserOps(f.rt, "own1");
  release();
  assert.deepEqual(await running, { skipped: "changed" }, "站点没了，这一轮结束，不记成错误");
  assert.equal((await f.store.listUsageHours("own1", 0)).length, 0);
  assert.equal((await f.store.listBalancePoints("own1", 0)).size, 0);
  assert.equal(await f.store.getProgress("own1"), null, "进度行没有被写回来（写回来的话回补目标是空的，一路往 1970 年读）");
  assert.equal(f.ops.getView(), null);
  f.site.gate = null;
  const next = await f.step();
  assert.equal(next.backfill.steps, 3, "下一轮从头回补");
  assert.ok((await f.store.getProgress("own1")).backfillTargetMs > START - 91 * 24 * H);
  assert.equal(f.ops._state.lastUsers.length, f.site.users.length, "用户列表是新读的");
});

test("回补进度行只有半截（回补目标是空的）：重新初始化，不会一路往 1970 年读", async (t) => {
  const f = makeSite(t, crowd());
  await f.store.saveProgress("own1", { backfillCursorMs: START, balanceSyncedMs: START });
  const out = await f.step();
  assert.equal(out.backfill.steps, 3);
  const progress = await f.store.getProgress("own1");
  assert.ok(progress.backfillTargetMs > START - 91 * 24 * H && progress.backfillTargetMs < START - 89 * 24 * H, String(progress.backfillTargetMs));
  assert.equal(f.count("/api/data/users?day"), 3);
});

test("一直在充小额：余额每小时都在涨、预计天数一直在提醒线以内，不会每小时推一次", async (t) => {
  const f = makeSite(t, crowd());
  await f.stepsTo(25);
  assert.equal(f.sent.length, 1);
  for (let hour = 0; hour < 22; hour += 1) {
    for (let n = 0; n < 6; n += 1) await f.step();
    f.site.users[0].balance += 6; // big1 每小时花 5，充 6：余额涨，预计天数还在 3 天以内
  }
  assert.equal(f.sent.length, 1, f.sent.map((item) => item.title).join("\n"));
});

// ===== 有人在看：每分钟一档 =====
// viewing：页面一直开着（到点前 10 秒来取了一次数）
const minuteStep = (f, minutes = 1, { viewing = false } = {}) => async () => {
  f.clock.now += minutes * MIN - (viewing ? 10000 : 0);
  if (viewing) { f.ops.markViewing(); f.clock.now += 10000; }
  for (const user of f.site.users) if (user.burn > 0) user.balance = Math.max(0, user.balance - (user.burn / 60) * minutes);
  return f.ops.runOnce();
};

test("页面开着（页面来取数续 90 秒）：每 5 分钟读一次用户列表和最近 3 小时的用量，不写快照；到 10 分钟照旧整轮；没人看就只有 10 分钟一档", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await f.step(); // 回补补完，整轮刚跑过
  const minute = minuteStep(f);
  // 没人看：1 分钟后什么都不读
  let before = f.site.requests.length;
  assert.deepEqual(await minute(), { skipped: "interval" });
  assert.equal(f.site.requests.length, before);
  // 有人看，但离上一次读还不到 5 分钟：不读（以前每分钟读一次，给用户站减负）
  for (let n = 0; n < 3; n += 1) { f.ops.markViewing(); assert.deepEqual(await minute(), { skipped: "interval" }, `第 ${n + 2} 分钟`); }
  assert.equal(f.site.requests.length, before, "页面开着，5 分钟之内也不读");
  // 满 5 分钟：2 个请求（用户列表 1 + data/users 最近几个小时 1），不写余额快照
  const points = f.store.calls.addBalancePoints;
  f.ops.markViewing();
  const live = await minute();
  assert.equal(live.live, true);
  assert.deepEqual(f.site.requests.slice(before), ["/api/user/", "/api/data/users?recent"]);
  assert.equal(f.store.calls.addBalancePoints, points, "实时一档不写快照");
  // 没有页面再来取：再过 1 分钟也不读
  assert.deepEqual(await minute(), { skipped: "interval" });
  // 到 10 分钟整轮：照旧写快照、重算（有没有人看都做）
  f.ops.markViewing();
  while (f.clock.now < f.ops.getView().at + 9 * MIN) { f.ops.markViewing(); assert.deepEqual(await minute(), { skipped: "interval" }); }
  f.ops.markViewing();
  const full = await minute();
  assert.equal(full.live, undefined, "第 10 分钟是整轮");
  assert.ok(f.store.calls.addBalancePoints > points && full.snapshots > 0);
  assert.equal(f.ops.getView().at, f.clock.now, "整轮重算了");
});

test("「有人在看」按页面来取数续 90 秒：离上一次读满 5 分钟时，89 秒前来取过算在看，91 秒前来取的不算", async (t) => {
  const watched = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await watched.step();
  watched.clock.now += 211000; watched.ops.markViewing(); watched.clock.now += 89000;
  assert.equal((await watched.ops.runOnce()).live, true);
  const gone = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await gone.step();
  gone.clock.now += 209000; gone.ops.markViewing(); gone.clock.now += 91000;
  assert.deepEqual(await gone.ops.runOnce(), { skipped: "interval" });
});

test("实时一档：页面上的余额、数据截至的时刻每 5 分钟更新；还能用几天、重点用户、提醒不动；额度紧时不读", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await f.step();
  const minute = minuteStep(f, 5, { viewing: true });
  const first = await pageOf(f);
  const fullAt = f.ops.getView().at;
  assert.equal(first.syncedMs, fullAt);
  await minute();
  const page = await pageOf(f);
  assert.ok(page !== first, "数更新了，整页重算");
  assert.equal(page.syncedMs, f.clock.now);
  const big1 = f.site.users.find((user) => user.username === "big1");
  assert.ok(Math.abs(page.users.find((row) => row.username === "big1").balanceUsd - big1.balance) < 1e-4, "余额是这一次读到的");
  assert.equal(f.ops.getView().at, fullAt, "整轮的结果（可用天数、重点用户）没重算");
  assert.equal(await pageOf(f), page, "同一时刻再取：用缓存");
  // 额度紧：另起一个站点（离整轮还有 5 分钟，实时一档到点）：一个请求都不发
  const tight = makeSite(t, crowd());
  for (let run = 0; run < 32; run += 1) await tight.step();
  const tightMinute = minuteStep(tight, 5, { viewing: true });
  for (let n = 0; n < 220; n += 1) noteOwnRequest("https://own.test/api/x", { status: 200, now: tight.clock.now + 5 * MIN });
  const before = tight.site.requests.length;
  assert.deepEqual(await tightMinute(), { skipped: "budget" });
  assert.equal(tight.site.requests.length, before, "额度紧：一个请求都不发");
});

test("实时一档：回补没补完时接着补，页面上的补全进度跟着走；对自营站点每次（5 分钟一次）的请求：用户列表 1 + data/users 1，回补最多再加 3", async (t) => {
  const f = makeSite(t, crowd());
  await f.step();
  assert.equal(f.ops.getView().backfill.days, 3);
  const minute = minuteStep(f, 5, { viewing: true });
  const before = f.site.requests.length;
  const out = await minute();
  assert.equal(out.backfill.steps, 3);
  assert.equal(f.ops.getView().backfill.days, 6, "补全进度跟着走");
  assert.equal(f.site.requests.length - before, 5, "用户列表 1 + 最近 3 小时 1 + 回补 3");
});

test("重点用户快用完的提醒天数是自己的（rules.userEtaDays），和上游的提醒天数（etaDays）各设各的", async (t) => {
  const tight = makeSite(t, crowd(), { rules: { etaDays: 30, userEtaDays: 0.5 } }); // 上游设得很宽，重点用户设得很紧
  await tight.stepsTo(25);
  assert.equal(tight.sent.length, 0, "big1 还够约 1.3 天，没进 0.5 天，不推");
  assert.equal(tight.ops.getView().level1Days, 0.5);
  const wide = makeSite(t, crowd(), { rules: { etaDays: 0.5, userEtaDays: 3 } }); // 反过来
  await wide.stepsTo(25);
  assert.equal(wide.sent.length, 1, "上游设得再紧，重点用户照自己的 3 天");
  assert.equal(wide.ops.getView().level1Days, 3);
});

test("只有两档：快用完、余额用完；先推了「快用完」，之后余额变 0，当轮就推「余额用完」，不用等 24 小时", async (t) => {
  const sent = [];
  const send = async (list, title, body) => { sent.push({ title, body }); return [{ ok: true }]; };
  const f = makeSite(t, bigPair(), { send, rules: { renotifyHours: 0 } });
  await f.stepsTo(26);
  assert.ok(sent.some((item) => /^【重点用户快用完】big2 可用约 \d+ 小时$/.test(item.title)), sent.map((item) => item.title).join("\n")); // 还够 1.4 天，在提醒线（这里设的 3 天）以内
  const before = sent.length;
  f.site.users[1].balance = 0.0001; // 下一步降到 0
  await f.step();
  assert.equal(sent.length, before + 1, "余额变 0 的这一轮就推了");
  assert.equal(sent.at(-1).title, "【重点用户余额用完】big2");
  assert.equal((await f.store.getAlertStates("own1")).get(2).level, 2);
  await f.step();
  assert.equal(sent.length, before + 1, "同一档不重复");
});

// ===== v8：分组、累计消费、新消费用户、已流失、用户表分页 =====
test("整页：分组和累计消费来自用户列表；第一次花钱在近 7 天的算新消费用户（累计消费 = 这段数据里的消费），以前花过的老用户不算", async (t) => {
  const since = START - 3 * 24 * H;
  const f = makeSite(t, [
    ...crowd().filter((user) => user.id !== 1),
    { id: 1, username: "big1", balance: 5000, burn: 5, group: "vip", used: 99999 }, // 一直在花，累计消费远大于这段数据里的
    { id: 40, username: "fresh", balance: 100, burn: 2, since, used: "auto", group: "enterprise" }, // 3 天前第一次花钱
    { id: 41, username: "comeback", balance: 100, burn: 2, since, used: 5000 }, // 数据里 3 天前开始花，但累计消费 5000：以前花过
  ]);
  for (let run = 0; run < 32; run += 1) await f.step();
  const page = await pageOf(f);
  const row = (name) => page.users.find((item) => item.username === name);
  assert.deepEqual([row("big1").group, row("fresh").group, row("big1").usedUsd], ["vip", "enterprise", 99999]);
  assert.deepEqual([row("fresh").isNew, row("fresh").status, row("comeback").isNew, row("big1").isNew], [true, "new", false, false]);
  assert.deepEqual([page.summary.weekNewUsers, page.summary.newUsers30], [1, 1], "只有 fresh：crowd 里的其他人一开始就在花（第一次花钱在 90 天前）");
  assert.deepEqual(page.trend.filter((day) => day.newUsers > 0).map((day) => day.newTop.map((item) => item.username)), [["fresh"]]);
  // 分组：筛选的下拉列表是所有用户的分组
  const response = usersResponse(page, new URLSearchParams("scope=all"));
  assert.deepEqual(response.list.groups, ["default", "enterprise", "vip"]);
  assert.equal(response.users, undefined);
});

test("整页：用户表在服务端筛选、分页——范围、重点、状态、分组、搜索、排序都在接口里，一页 50 个，合计行只算筛出来的", async (t) => {
  const many = Array.from({ length: 70 }, (_, index) => ({ id: 100 + index, username: `m${String(index).padStart(2, "0")}`, balance: 5000, burn: 0.05 + index / 1000, group: index % 2 ? "vip" : "default" }));
  const f = makeSite(t, [...crowd(), ...many, { id: 200, username: "quiet", balance: 5, burn: 0 }]);
  for (let run = 0; run < 32; run += 1) await f.step();
  const page = await pageOf(f);
  const ask = (query) => usersResponse(page, new URLSearchParams(query)).list;
  const first = ask("");
  assert.deepEqual([first.rows.length, first.total, first.pages, first.pageSize], [50, 83, 2, 50], "默认范围：近 30 天有消费的（crowd 里 13 位在花钱的 + 70 位），不含 quiet、idle 这类没消费的");
  assert.equal(first.counts.scope.all, 85);
  assert.equal(ask("scope=all").total, 85);
  assert.deepEqual(first.rows.map((row) => row.username).slice(0, 2), ["big1", "big2"], "默认按近 7 天消费从高到低");
  const second = ask("page=2");
  assert.equal(second.rows.length, 33);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 83, "两页没有重复");
  const vip = ask("group=vip");
  assert.deepEqual([vip.total, vip.rows.every((row) => row.group === "vip")], [35, true]);
  assert.equal(vip.totals.count, 35);
  assert.ok(Math.abs(vip.totals.week - vip.rows.reduce((sum, row) => sum + row.week, 0)) < 1e-6);
  assert.equal(ask("q=m07").total, 1);
  assert.equal(ask("big=1").total, page.big.count);
  assert.equal(ask("sort=user&dir=asc").rows[0].username, "big1");
  assert.equal(page.users.length, 85, "整页里全部的行还在内存里，给抽屉和概览用");
});

test("整页：已流失——前 30 天花过钱、近 7 天一分没花；只在更早以前花过的不算", async (t) => {
  const f = makeSite(t, [
    ...crowd(),
    { id: 50, username: "gone", balance: 5000, burn: 3, until: START - 25 * 24 * H }, // 25 天前停的
    { id: 51, username: "longgone", balance: 5000, burn: 3, until: START - 50 * 24 * H },
  ]);
  for (let run = 0; run < 32; run += 1) await f.step();
  const page = await pageOf(f);
  const row = (name) => page.users.find((item) => item.username === name);
  assert.equal(page.ready.churn, true);
  assert.deepEqual([row("gone").status, row("longgone").status], ["churned", null]);
  const counts = usersResponse(page, new URLSearchParams("scope=all")).list.counts;
  assert.equal(counts.only.churned, 1);
});

// ===== v8 流失页签（server/user-ops-churn.js）=====
const flowRow = (username, model, usd, extra = {}) => ({ username, use_group: "default", model_name: model, channel_id: 1, channel_name: "渠道一", token_used: 10, count: 2, quota: Math.round(usd * QUOTA_PER_UNIT), ...extra });
// 一位用户（drop）在今天（业务时区 11-02）0 点以后一分钱没花，之前一直每小时 5 美元；别人照常
const churnUsers = () => [...crowd().filter((user) => user.id !== 2), { id: 2, username: "drop", balance: 5000, burn: 5, until: Date.parse("2026-11-01T15:59:59Z") }];
const churnPage = (f, query = "") => churnResponse(f.rt, f.ops, f.store, new URLSearchParams(query), { now: f.clock.now });

test("流失页：今天明显少了——读库里过去 7 天同一时段的小时用量；过去几天的小时数按天记在内存里，同一轮再来只读今天的", async (t) => {
  const f = makeSite(t, churnUsers());
  assert.equal((await churnPage(f)).starting, true, "后台还没读到过数");
  await f.stepsTo(10.5); // 业务时区 06:30：昨天已经结束 6 小时，可以按天记下来
  const first = f.store.calls.usageRowsRead;
  const page = await churnPage(f);
  const readFirst = f.store.calls.usageRowsRead - first;
  assert.equal(page.ready.today, true);
  const drop = page.list.rows.find((row) => row.username === "drop");
  assert.ok(drop, JSON.stringify(page.list.rows.map((row) => [row.username, row.status])));
  assert.deepEqual([drop.status, Math.round(drop.before), drop.after, Math.round(drop.loss)], ["todayLow", 30, 0, 120], "平时 0 点到 6 点 $30 → 今天 $0；一天少花 5 × 24 = 120");
  assert.equal(page.list.rows.some((row) => row.username === "big1"), false, "照常花的不在表里");
  const second = f.store.calls.usageRowsRead;
  await churnPage(f);
  assert.ok(f.store.calls.usageRowsRead - second <= 100, `同一轮再来只读今天（6 个小时 × 12 位用户）（${f.store.calls.usageRowsRead - second} 行），第一次读了 ${readFirst} 行`);
  assert.ok(readFirst > 7 * 24 * 10, "第一次读了过去 7 天的小时行");
  assert.deepEqual(page.summary.down.count, 0);
});

test("流失页：每位用户主要用的模型来自 /api/data/flow 一个请求，缓存 10 分钟；额度紧时不读、写 BUSY；读失败也不拦页面", async (t) => {
  const f = makeSite(t, churnUsers());
  f.site.flow = [flowRow("drop", "gpt-4o", 100), flowRow("drop", "claude", 30), flowRow("drop", "claude", 30, { channel_id: 2, channel_name: "渠道二" }), flowRow("big1", "gpt-4o", 5)];
  for (let run = 0; run < 32; run += 1) await f.step();
  const count = () => f.site.requests.filter((item) => item === "/api/data/flow").length;
  const before = count();
  const page = await churnPage(f);
  assert.equal(page.modelsError, null);
  assert.equal(page.list.rows.find((row) => row.username === "drop").model, "gpt-4o", "近 30 天花得最多：gpt-4o 100 比 claude 60 多（两个渠道的 claude 加起来）");
  assert.equal(count() - before, 1);
  await churnPage(f);
  assert.equal(count() - before, 1, "10 分钟内再来：用缓存，不再读");
  await f.step(); // 10 分钟以后
  await churnPage(f);
  assert.equal(count() - before, 2);
  // 额度紧：不发请求
  const g = makeSite(t, churnUsers());
  g.site.flow = [flowRow("drop", "gpt-4o", 100)];
  for (let run = 0; run < 32; run += 1) await g.step();
  for (let n = 0; n < 220; n += 1) noteOwnRequest("https://own.test/api/x", { status: 200, now: g.clock.now });
  const flowBefore = g.site.requests.filter((item) => item === "/api/data/flow").length;
  const busy = await churnPage(g);
  assert.equal(busy.modelsError, "BUSY");
  assert.equal(busy.list.rows.find((row) => row.username === "drop").model, null, "主要用的模型写「—」，别的照常");
  assert.equal(g.site.requests.filter((item) => item === "/api/data/flow").length, flowBefore, "一个请求都没发");
  // 读失败
  const h = makeSite(t, churnUsers());
  h.site.flowFail = true;
  for (let run = 0; run < 32; run += 1) await h.step();
  const failed = await churnPage(h);
  assert.ok(failed.modelsError);
  assert.equal(failed.list.rows.find((row) => row.username === "drop").status, "todayLow");
  // 一直读不成（404、权限不够）：10 分钟内每分钟来取，也只去用户的站上读一次
  const flowCount = () => h.site.requests.filter((item) => item === "/api/data/flow").length;
  assert.equal(flowCount(), 1);
  for (let minute = 1; minute <= 9; minute += 1) { h.clock.now += MIN; await churnPage(h); }
  assert.equal(flowCount(), 1, "失败也挡 10 分钟");
  h.clock.now += MIN;
  await churnPage(h);
  assert.equal(flowCount(), 2, "过了 10 分钟再试一次");
});

test("流失页：没读到过数是 starting，没设置自营站点是 unset；过去 7 个整天没补全时今天明显少了不判（ready.today 是 false），别的照常", async (t) => {
  const f = makeSite(t, churnUsers());
  for (let run = 0; run < 3; run += 1) await f.step();
  const page = await churnPage(f);
  assert.deepEqual([page.ready.today, page.ready.churn, page.ready.down], [false, false, false]);
  assert.equal(page.list.counts.only.todayLow, null, "个数写「—」，不是 0");
  assert.deepEqual(page.summary.retention, null);
  const none = { store: { list: () => [], settings: {}, rules: {}, channels: [] } };
  assert.equal((await churnResponse(none, f.ops, f.store, new URLSearchParams())).unset, true);
});

test("流失页：用户数据超过 30 分钟没读到时，今天明显少了先不判（不会把所有人都标上）；恢复以后照常", async (t) => {
  const f = makeSite(t, churnUsers());
  await f.stepsTo(10.5);
  assert.equal((await churnPage(f)).list.rows.some((row) => row.status === "todayLow"), true);
  f.site.soft = true; // 用户列表、用量都读不到
  await f.stepsTo(13);
  assert.equal(f.ops.getView().fresh, false);
  const stale = await churnPage(f);
  assert.equal(stale.fresh, false);
  assert.equal(stale.ready.today, false);
  assert.equal(stale.sameUntilMs, null);
  assert.equal(stale.list.rows.some((row) => row.status === "todayLow"), false, "一个都没标");
  assert.equal(stale.list.counts.only.todayLow, null, "个数写「—」，不是 0");
  f.site.soft = false;
  await f.step();
  const back = await churnPage(f);
  assert.equal(back.ready.today, true);
  assert.equal(back.list.rows.find((row) => row.username === "drop")?.status, "todayLow");
});
