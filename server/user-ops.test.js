// 用户运营的后台（server/user-ops.js）：假的自营站点（用户列表、按小时用量），内存存储，假时钟；一步 10 分钟
import test from "node:test";
import assert from "node:assert/strict";
import { createUserOps, forgetUserOps } from "./user-ops.js";
import { bigUsersSummary, userDetail, usersPage } from "./user-ops-page.js";
import { MemoryUserOpsStore } from "./test-support/user-ops-memory-store.js";
import { noteOwnRequest, resetOwnRequestBudget } from "../lib/own-request-budget.js";

const H = 3600000, MIN = 60000;
const START = Date.parse("2026-11-01T12:00:00Z");
const QUOTA_PER_UNIT = 500000;
const own = { id: "own1", name: "我的站点", isOwn: true, type: "newapi", baseUrl: "https://own.test", accessToken: "tok" };

// users：[{ id, username, role?, status?, balance, burn（每小时花多少美元，余额每步跟着降，用量表按小时生成） }]
function makeSite(t, users, { rules = {}, settings = {}, channels = [{ id: "c1", enabled: true, type: "webhook", name: "钉" }], send = null, mail = null, tweak = {} } = {}) {
  resetOwnRequestBudget();
  const clock = { now: START };
  t.mock.method(Date, "now", () => clock.now);
  const site = { users: users.map((user) => ({ role: 1, status: 1, burn: 0, ...user })), requests: [], soft: false, softBackfill: false, hard: false };
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
      return reply({ total: site.users.length, items: site.users.map((user) => ({ id: user.id, username: user.username, display_name: "", email: user.email, role: user.role, status: user.status, quota: Math.round(user.balance * QUOTA_PER_UNIT), used_quota: 0 })) });
    }
    if (url.pathname === "/api/data/users") {
      const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
      const isDay = end - start > 4 * 3600;
      if (site.soft || (isDay && site.softBackfill)) return soft;
      const rows = [];
      for (const user of site.users) {
        if (!(user.burn > 0)) continue;
        for (let hour = Math.ceil(start / 3600) * 3600; hour <= Math.min(end, Math.floor(clock.now / 3600000) * 3600 - 0); hour += 3600) {
          rows.push({ username: user.username, created_at: hour, token_used: 100, quota: Math.round(user.burn * QUOTA_PER_UNIT), count: 3 });
        }
      }
      return reply(rows);
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
  const mails = [];
  const sendMail = mail || (async (channel, to, content) => { mails.push({ channelId: channel.id, to, subject: content.subject, text: content.text, html: content.html }); return { ok: true }; });
  const api = { ops: createUserOps(rt, { store, mail: sendMail, send: send || (async (list, title, body) => { sent.push({ title, body }); return [{ ok: true }]; }) }) };
  // 一步：时钟走 10 分钟，余额按每小时的花费降，然后跑一轮（api.ops 可以换成「重启以后」新建的那个）
  const step = async (options) => {
    clock.now += 10 * MIN;
    for (const user of site.users) if (user.burn > 0) user.balance = Math.max(0, user.balance - user.burn / 6);
    return api.ops.runOnce(options);
  };
  const stepsTo = async (hours) => { while (clock.now < START + hours * H) await step(); };
  const count = (path) => site.requests.filter((item) => item.startsWith(path)).length;
  return Object.assign(api, { site, clock, rt, store, sent, mails, step, stepsTo, count, rules: rt.store.rules, newOps: () => createUserOps(rt, { store, mail: sendMail, send: async (list, title, body) => { sent.push({ title, body }); return [{ ok: true }]; } }) });
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

test("回补 60 天：每轮最多 3 个请求，20 轮补完；补完以后每轮只剩用户列表 + 最近 3 小时两个请求；回补期间页面写补全进度", async (t) => {
  const f = makeSite(t, crowd());
  const progress = [];
  for (let run = 1; run <= 20; run += 1) { await f.step(); progress.push(f.ops.getView().backfill); }
  assert.deepEqual([progress[0].done, progress[0].days, progress[0].total], [false, 3, 60], "补全中 3/60");
  assert.deepEqual([progress[4].done, progress[4].days], [false, 15]);
  assert.deepEqual([progress[18].done, progress[18].days], [false, 57]);
  assert.deepEqual([progress.at(-1).done, progress.at(-1).days], [true, 60]);
  assert.equal(f.count("/api/data/users?day"), 60, "一天一个请求，共 60 个");
  const before = f.site.requests.length;
  await f.step();
  assert.deepEqual(f.site.requests.slice(before), ["/api/user/", "/api/data/users?recent"]);
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

test("端到端：两位重点用户一起快用完 → 24 小时后一条推送、按日均消费从高到低；各自降到二级再推一次、余额用完再推一次；小用户不是重点用户不推送；没有重复", async (t) => {
  const f = makeSite(t, crowd(), { rules: { renotifyHours: 0 } }); // 0 = 同一级只提醒一次；每天重复提醒另有用例
  await f.stepsTo(72);
  assert.equal(f.sent.length, 4, f.sent.map((item) => `${item.title}\n${item.body}`).join("\n=====\n"));
  const [first, second, third, fourth] = f.sent;
  assert.equal(first.title, "【重点用户快用完】big1 等 2 位");
  assert.match(first.body.split("\n")[0], /^用户：big1 /);
  assert.match(first.body.split("\n")[1], /^用户：big2 /);
  assert.match(second.body, /用户：big1 .*还够/, "big1 先到二级（预计 1 天内）");
  assert.equal(second.body.split("\n").filter((line) => line.startsWith("用户：")).length, 1);
  assert.equal(third.title, "【重点用户余额用完】big1", "big1 余额用完是单独一档，当轮就推");
  assert.match(fourth.body, /用户：big2 /);
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
  assert.equal(f.sent.length, 1);
});

test("回补没完成之前不推送：回补读不成，到了 24 小时也不推；补完以后再推", async (t) => {
  const f = makeSite(t, crowd());
  f.site.softBackfill = true;
  await f.stepsTo(30);
  assert.equal(f.sent.length, 0);
  assert.equal(f.ops.getView().backfill.done, false);
  f.site.softBackfill = false;
  await f.stepsTo(34);
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

test("整页：补完 60 天以后，用户表、概览的数、重点用户、趋势都出来；状态来自余额和用量", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 22; run += 1) await f.step();
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
  assert.deepEqual([before.backfill.done, before.backfill.days, before.backfill.total], [false, 0, 60]);
  await f.step();
  const page = await pageOf(f);
  assert.deepEqual([page.ready.week, page.ready.compare, page.ready.down, page.big.ready, page.big.count], [false, false, false, false, 0]);
  assert.equal(page.backfill.done, false);
  assert.ok(page.users.length > 0, "用户表照常有（余额、今天的数先有）");
});

test("整页只在采集那一轮变了才重算；整天的消费记在内存里，下一轮只重读最近两天的按小时用量", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 22; run += 1) await f.step();
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
  for (let run = 0; run < 22; run += 1) await f.step();
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

test("某一种的通知方式没送到：只退回这一种的提醒状态（下一轮再试），另一种照常记已发", async (t) => {
  const sent = [];
  const send = async (list, title, body) => (list[0]?.id === "c1" ? [{ ok: false }] : (sent.push({ title, body }), [{ ok: true }]));
  const f = makeSite(t, bigPair(), { channels: twoChannels, send, rules: perEvent });
  await f.stepsTo(20);
  f.site.users[0].balance = 0;
  await f.stepsTo(28);
  assert.equal(sent.length, 1, "快用完推出去了，只推一次");
  assert.match(sent[0].body, /big2/);
  const states = await f.store.getAlertStates("own1");
  assert.equal(states.get(1)?.level ?? 0, 0, "余额用完一直没送到，就一直没记已发");
  assert.ok(states.get(2).level >= 1, "快用完记了已发");
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
  assert.ok((await f.store.getProgress("own1")).backfillTargetMs > START - 61 * 24 * H);
  assert.equal(f.ops._state.lastUsers.length, f.site.users.length, "用户列表是新读的");
});

test("回补进度行只有半截（回补目标是空的）：重新初始化，不会一路往 1970 年读", async (t) => {
  const f = makeSite(t, crowd());
  await f.store.saveProgress("own1", { backfillCursorMs: START, balanceSyncedMs: START });
  const out = await f.step();
  assert.equal(out.backfill.steps, 3);
  const progress = await f.store.getProgress("own1");
  assert.ok(progress.backfillTargetMs > START - 61 * 24 * H && progress.backfillTargetMs < START - 59 * 24 * H, String(progress.backfillTargetMs));
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
const minuteStep = (f) => async () => {
  f.clock.now += MIN;
  for (const user of f.site.users) if (user.burn > 0) user.balance = Math.max(0, user.balance - user.burn / 60);
  return f.ops.runOnce();
};

test("页面开着（页面来取数续 90 秒）：每分钟读一次用户列表和最近 3 小时的用量，不写快照；到 10 分钟照旧整轮；没人看就只有 10 分钟一档", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 22; run += 1) await f.step(); // 回补补完，整轮刚跑过
  const minute = minuteStep(f);
  // 没人看：1 分钟后什么都不读
  let before = f.site.requests.length;
  assert.deepEqual(await minute(), { skipped: "interval" });
  assert.equal(f.site.requests.length, before);
  // 有人看：每分钟 2 个请求（用户列表 1 + data/users 最近几个小时 1），不写余额快照
  const points = f.store.calls.addBalancePoints;
  f.ops.markViewing();
  before = f.site.requests.length;
  const live = await minute();
  assert.equal(live.live, true);
  assert.deepEqual(f.site.requests.slice(before), ["/api/user/", "/api/data/users?recent"]);
  assert.equal(f.store.calls.addBalancePoints, points, "实时一档不写快照");
  // 没有页面再来取：下一分钟就不读了
  assert.deepEqual(await minute(), { skipped: "interval" });
  // 页面来取一次续 90 秒：89 秒后还算在看，91 秒后不算
  f.ops.markViewing();
  f.clock.now += 89000;
  assert.equal((await f.ops.runOnce()).live, true);
  f.ops.markViewing();
  f.clock.now += 91000;
  assert.deepEqual(await f.ops.runOnce(), { skipped: "interval" });
  // 页面每分钟来一次：一直是实时一档；第 10 分钟整轮到点，照旧写快照、重算
  f.ops.markViewing();
  while (f.clock.now < f.ops.getView().at + 9 * MIN) { f.ops.markViewing(); assert.equal((await minute()).live, true, String(f.clock.now - f.ops.getView().at)); }
  f.ops.markViewing();
  const full = await minute();
  assert.equal(full.live, undefined, "第 10 分钟是整轮");
  assert.ok(f.store.calls.addBalancePoints > points && full.snapshots > 0);
  assert.equal(f.ops.getView().at, f.clock.now, "整轮重算了");
});

test("实时一档：页面上的余额、数据截至的时刻每分钟更新；还能用几天、重点用户、提醒不动；额度紧时不读", async (t) => {
  const f = makeSite(t, crowd());
  for (let run = 0; run < 22; run += 1) await f.step();
  const minute = minuteStep(f);
  const first = await pageOf(f);
  const fullAt = f.ops.getView().at;
  assert.equal(first.syncedMs, fullAt);
  f.ops.markViewing();
  await minute();
  const page = await pageOf(f);
  assert.ok(page !== first, "数更新了，整页重算");
  assert.equal(page.syncedMs, f.clock.now);
  const big1 = f.site.users.find((user) => user.username === "big1");
  assert.ok(Math.abs(page.users.find((row) => row.username === "big1").balanceUsd - big1.balance) < 1e-4, "余额是这一分钟读到的");
  assert.equal(f.ops.getView().at, fullAt, "整轮的结果（可用天数、重点用户）没重算");
  assert.equal(await pageOf(f), page, "同一时刻再取：用缓存");
  for (let n = 0; n < 220; n += 1) noteOwnRequest("https://own.test/api/x", { status: 200, now: f.clock.now });
  f.ops.markViewing();
  const before = f.site.requests.length;
  assert.deepEqual(await minute(), { skipped: "budget" });
  assert.equal(f.site.requests.length, before, "额度紧：一个请求都不发");
});

test("实时一档：回补没补完时接着补，页面上的补全进度跟着走；对自营站点每分钟的请求：用户列表 1 + data/users 1，回补最多再加 3", async (t) => {
  const f = makeSite(t, crowd());
  await f.step();
  assert.equal(f.ops.getView().backfill.days, 3);
  const minute = minuteStep(f);
  f.ops.markViewing();
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

test("余额用完单独算一档：先推了「一天内快用完」（二级），之后余额变 0，当轮就推「余额用完」，不用等 24 小时", async (t) => {
  const sent = [];
  const send = async (list, title, body) => { sent.push({ title, body }); return [{ ok: true }]; };
  const f = makeSite(t, bigPair(), { send, rules: { renotifyHours: 0 } });
  await f.stepsTo(26);
  f.site.users[1].balance = 40; // big2：日均 72，剩 40 = 0.56 天，二级
  await f.step();
  assert.ok(sent.some((item) => item.title === "【重点用户快用完】big2 可用不到 1 天"), sent.map((item) => item.title).join("\n"));
  const before = sent.length;
  f.site.users[1].balance = 0.0001; // 下一步降到 0
  await f.step();
  assert.equal(sent.length, before + 1, "余额变 0 的这一轮就推了");
  assert.equal(sent.at(-1).title, "【重点用户余额用完】big2");
  assert.equal((await f.store.getAlertStates("own1")).get(2).level, 3);
  await f.step();
  assert.equal(sent.length, before + 1, "同一档不重复");
});

// ===== 给重点用户发邮件 =====
const mailChannel = { id: "m1", enabled: true, type: "smtp", name: "邮件", config: { host: "smtp.test", from: "我的站点 <noreply@own.test>", to: "owner@own.test" } };
const mailRules = { onUserMail: true, userMailChannelId: "m1" };
// 两位重点用户：big1 钱多（不会快用完），big2 余额 220、每天花 72，约 24 小时后进 3 天，约 51 小时后进 1 天，约 73 小时用完；都填了邮箱；另有十位中等用户（凑出全站八成）
const mailUsers = (extra = {}) => [
  { id: 1, username: "big1", balance: 5000, burn: 5, email: "big1@mail.test" },
  { id: 2, username: "big2", balance: 220, burn: 3, email: "big2@mail.test", ...extra },
  ...Array.from({ length: 10 }, (_, index) => ({ id: 10 + index, username: `mid${index}`, balance: 5000, burn: 2, email: `mid${index}@mail.test` })),
];
const mailSite = (t, users = mailUsers(), { rules = {}, ...rest } = {}) => makeSite(t, users, { channels: [mailChannel], ...rest, rules: { renotifyHours: 0, ...mailRules, ...rules } });

test("给用户发邮件：第一封在可用天数进提醒天数时，第二封在 1 天以内，用完不再发第三封；只发给重点用户、用站长选的通知方式、写自营站点的名字", async (t) => {
  const f = mailSite(t);
  await f.stepsTo(40);
  assert.equal(f.mails.length, 1, f.mails.map((item) => item.subject).join("\n"));
  const first = f.mails[0];
  assert.deepEqual([first.channelId, first.to], ["m1", "big2@mail.test"]);
  assert.match(first.subject, /^我的站点 账户余额快用完了，还能用约 2 天$/);
  assert.match(first.text, /^您好，big2：/);
  assert.match(first.text, /充值页：|去充值：https:\/\/own\.test\/wallet/);
  assert.ok(!first.text.includes("炬元") && !first.html.includes("炬元"), "邮件里不出现控制台的名字");
  assert.match(first.html, /href="https:\/\/own\.test\/wallet"/);
  await f.stepsTo(60);
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[1].subject, /^我的站点 账户余额快用完了，大约只够用 (1 天|\d+ 小时)$/);
  await f.stepsTo(90);
  assert.equal(f.mails.length, 2, "余额用完不再发第三封（一轮最多两封）");
  assert.equal(f.ops.getView().users.get(2).state, "empty");
  assert.ok(f.mails.every((item) => item.to !== "big1@mail.test" && !item.to.startsWith("mid")), "只发给重点用户里快用完的，没快用完的不发");
  const states = await f.store.getMailStates("own1");
  assert.deepEqual([states.get(2).level, states.get(2).retryAt], [2, null], "发成功以后清掉重试时刻");
});

test("给用户发邮件：开关默认关；关着不发也不补发——只把级别记到当前，打开以后只有新的一级才发", async (t) => {
  const f = mailSite(t, mailUsers(), { rules: { onUserMail: false } });
  await f.stepsTo(40);
  assert.equal(f.mails.length, 0);
  assert.equal((await f.store.getMailStates("own1")).get(2).level, 1, "关着也记着级别");
  f.rules.onUserMail = true;
  await f.stepsTo(45);
  assert.equal(f.mails.length, 0, "打开的时候已经在第一级，不补发第一封");
  await f.stepsTo(60);
  assert.equal(f.mails.length, 1, "到了第二级才发第二封");
  assert.match(f.mails[0].subject, /大约只够用/);
});

test("给用户发邮件：没选通知方式、选的被停用或不是邮件类、用户没填邮箱，都不发；没填邮箱的不写状态", async (t) => {
  const none = mailSite(t, mailUsers(), { rules: { userMailChannelId: null } });
  await none.stepsTo(40);
  assert.equal(none.mails.length, 0, "没选通知方式");
  const disabled = mailSite(t, mailUsers(), { channels: [{ ...mailChannel, enabled: false }] });
  await disabled.stepsTo(40);
  assert.equal(disabled.mails.length, 0);
  const wrongType = mailSite(t, mailUsers(), { channels: [{ ...mailChannel, type: "webhook" }] });
  await wrongType.stepsTo(40);
  assert.equal(wrongType.mails.length, 0);
  const noEmail = mailSite(t, mailUsers({ email: "" }));
  await noEmail.stepsTo(40);
  assert.equal(noEmail.mails.length, 0);
  assert.equal((await noEmail.store.getMailStates("own1")).has(2), false, "没邮箱：不写状态，填了以后下一轮再看");
  noEmail.site.users[1].email = "late@mail.test";
  await noEmail.step();
  assert.equal(noEmail.mails.length, 1, "后来填了邮箱，当前这一级补上");
  assert.equal(noEmail.mails[0].to, "late@mail.test");
});

test("给用户发邮件：一轮最多 5 封，多的下一轮接着发", async (t) => {
  const users = Array.from({ length: 10 }, (_, index) => ({ id: 10 + index, username: `u${index}`, balance: 220, burn: 3, email: `u${index}@mail.test` }));
  const f = mailSite(t, users);
  let counts = [];
  let before = 0;
  while (f.clock.now < START + 30 * H) {
    await f.step();
    if (f.mails.length !== before) { counts.push(f.mails.length - before); before = f.mails.length; }
  }
  assert.deepEqual(counts, [5, 3], `重点用户 8 位（占全站八成）：第一轮 5 封，下一轮 3 封（${counts}）`);
  assert.equal(new Set(f.mails.map((item) => item.to)).size, 8, "没有重复发给同一个人");
});

test("给用户发邮件：先写级别再发；没发出去 30 分钟后再试一次，只试一次", async (t) => {
  let calls = 0, stateAtSend = null;
  const holder = {};
  const mail = async (channel, to, content) => {
    calls += 1;
    stateAtSend = (await holder.f.store.getMailStates("own1")).get(2);
    return { ok: false, code: "NETWORK_UNREACHABLE" };
  };
  const f = mailSite(t, mailUsers(), { mail });
  holder.f = f;
  await f.stepsTo(24);
  while (calls === 0) await f.step();
  assert.equal(calls, 1);
  assert.deepEqual([stateAtSend.level, stateAtSend.tries, stateAtSend.retryAt != null], [1, 1, true], "发之前级别和重试时刻已经在库里");
  await f.step(); await f.step();
  assert.equal(calls, 1, "30 分钟内不重试");
  await f.step();
  assert.equal(calls, 2, "30 分钟后试一次");
  for (let n = 0; n < 12; n += 1) await f.step();
  assert.equal(calls, 2, "只试一次，再失败就不发了");
  assert.deepEqual((await f.store.getMailStates("own1")).get(2), { level: 1, retryAt: null, tries: 2 });
});

test("给用户发邮件：重启以后不重复发（级别在库里）；充值充到够用以后重新开始一轮", async (t) => {
  const f = mailSite(t);
  await f.stepsTo(30);
  assert.equal(f.mails.length, 1);
  f.ops = f.newOps();
  for (let n = 0; n < 6; n += 1) await f.step();
  assert.equal(f.mails.length, 1, "重启不重复");
  f.site.users[1].balance += 2000; // 充值：天数回到提醒线的 1.2 倍以上
  await f.step();
  assert.equal((await f.store.getMailStates("own1")).get(2).level, 0, "清零，重新开始一轮");
  f.site.users[1].balance = 150; // 又降到 3 天以内
  await f.stepsTo(32);
  assert.equal(f.mails.length, 2, "新的一轮又发第一封");
  assert.match(f.mails[1].subject, /账户余额快用完了/);
});

test("邮箱只在内存里：不进日志、不进库、不进整页和抽屉的响应、不进推送；发信失败也不留收件人", async (t) => {
  const logs = [];
  for (const name of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, name, (...args) => { logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); });
  const f = mailSite(t, mailUsers(), { mail: async (channel, to) => ({ ok: false, code: "NETWORK_UNREACHABLE", error: `550 <${to}> user unknown` }) });
  await f.stepsTo(60);
  const page = await usersPage(f.rt, f.ops, f.store, { now: f.clock.now });
  const detail = await userDetail(f.rt, f.ops, f.store, 2, { now: f.clock.now });
  const dump = JSON.stringify([
    logs, page, detail, f.sent,
    [...f.ops.getView().users.values()], f.ops.getUsers(),
    [...f.store.usage.values()], [...f.store.points.values()], [...f.store.progress.values()], [...f.store.alerts.values()], [...f.store.mails.values()], [...f.store.mails.keys()],
  ]);
  assert.ok(!dump.includes("@mail.test"), "整个运行过程里没有任何用户邮箱");
});

test("给用户发邮件：用户填的邮箱带逗号、换行、尖括号的，当没填邮箱——不发、不写状态；填干净的以后下一轮补当前这一级", async (t) => {
  const bad = ["big2@mail.test,victim@x.test", "big2@mail.test，victim@x.test", "a@b.test\r\nBcc: victim@x.test", "Big <big2@mail.test>"];
  for (const email of bad) {
    const f = mailSite(t, mailUsers({ email }));
    await f.stepsTo(40);
    assert.deepEqual(f.mails, [], JSON.stringify(email));
    assert.equal((await f.store.getMailStates("own1")).has(2), false);
  }
  const f = mailSite(t, mailUsers({ email: "x@y.test,victim@x.test" }));
  await f.stepsTo(40);
  f.site.users[1].email = "big2@mail.test";
  await f.step();
  assert.deepEqual(f.mails.map((item) => item.to), ["big2@mail.test"]);
});
