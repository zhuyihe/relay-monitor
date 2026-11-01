// 用户运营的后台（server/user-ops.js）：假的自营站点（用户列表、按小时用量），内存存储，假时钟；一步 10 分钟
import test from "node:test";
import assert from "node:assert/strict";
import { createUserOps, forgetUserOps } from "./user-ops.js";
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
      return reply({ total: site.users.length, items: site.users.map((user) => ({ id: user.id, username: user.username, display_name: "", role: user.role, status: user.status, quota: Math.round(user.balance * QUOTA_PER_UNIT), used_quota: 0 })) });
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
    return { status: 404, text: async () => "{}" };
  });
  const sent = [];
  const rt = { store: { list: () => [own], settings: { ...settings }, rules: { onUserBalance: true, renotifyHours: 24, userBalanceChannelIds: [], ...rules }, channels } };
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

// 一群用户：两位大客户（日均 120、72）、十位中等用户（日均 48，凑出全站的八成要用到这些人）、一位小用户、一位闲置号、一位管理员
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

test("端到端：两位重点用户一起快用完 → 24 小时后一条推送、按日均消费从高到低；各自降到二级再推一次；小用户不是大客户不推送；没有重复", async (t) => {
  const f = makeSite(t, crowd(), { rules: { renotifyHours: 0 } }); // 0 = 同一级只提醒一次；每天重复提醒另有用例
  await f.stepsTo(72);
  assert.equal(f.sent.length, 3, f.sent.map((item) => `${item.title}\n${item.body}`).join("\n=====\n"));
  const [first, second, third] = f.sent;
  assert.equal(first.title, "【重点用户快用完】big1 等 2 位");
  assert.match(first.body.split("\n")[0], /^用户：big1 /);
  assert.match(first.body.split("\n")[1], /^用户：big2 /);
  assert.match(second.body, /用户：big1 .*余额用完|用户：big1 .*还够/);
  assert.equal(second.body.split("\n").filter((line) => line.startsWith("用户：")).length, 1);
  assert.match(third.body, /用户：big2 /);
  assert.ok(f.sent.every((item) => !item.body.includes("small") && !item.body.includes("mid") && !item.body.includes("idle") && !item.body.includes("root")), "不是大客户、闲置号、管理员都不推");
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

test("规则「用户余额」默认关：不推送，也不记提醒状态", async (t) => {
  const f = makeSite(t, crowd(), { rules: { onUserBalance: false } });
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
  // 三位用户都是大客户；A 每天花 24 美元，24 小时时余额 60（还够 2.5 天，一级），到 49 小时还是一级（还够 1.5 天）
  const f = makeSite(t, [{ id: 1, username: "A", balance: 84, burn: 1 }, { id: 2, username: "B", balance: 9000, burn: 1 }, { id: 3, username: "C", balance: 9000, burn: 1 }], { rules: { renotifyHours: 24 } });
  await f.stepsTo(24 + 23);
  assert.equal(f.sent.length, 1, "A 一级推过一次，23 小时后还没到再提醒的时候");
  await f.stepsTo(24 + 25);
  assert.equal(f.sent.length, 2, "过了 24 小时仍然在一级：再提醒一次");
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
