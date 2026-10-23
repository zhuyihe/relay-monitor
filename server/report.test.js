import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../db/store.js";
import { BRAND, NOTIFY_KEYWORD } from "../lib/brand.js";
import { buildReport, reportDayWindow, sendReport, startReportScheduler } from "./report.js";

const START = Date.parse("2026-10-08T01:00:00Z"); // 北京时间 09:00

function setup(t, { now = START, own = true, channels = ["a", "b"] } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const database = { settings: null, failNextCommit: false, beforeCommit: null };
  const pool = {
    getConnection: async () => {
      let settings;
      return {
        beginTransaction: async () => {},
        query: async (sql, [values] = []) => {
          if (sql.startsWith("INSERT INTO meta")) settings = JSON.parse(values.find(([key]) => key === "settings")[1]);
          return [[]];
        },
        commit: async () => {
          await database.beforeCommit?.();
          if (database.failNextCommit) {
            database.failNextCommit = false;
            throw new Error("simulated persistence failure");
          }
          database.settings = settings;
        },
        rollback: async () => {},
        release: () => {},
      };
    },
  };
  const store = new Store(pool);
  store.data.settings = { ...store.settings, dailyReport: { enabled: true, time: "09:00", channelIds: [], lastSent: null } };
  store.data.stations = own ? [{ id: "own", type: "newapi", isOwn: true, name: "Own", baseUrl: "https://source.example", accessToken: "test", cnyPerUsd: 1 }] : [];
  store.data.notifications.channels = channels.map((id) => ({ id, type: "webhook", name: id, config: { url: `https://notify.example/${id}` } }));
  const rt = { store, history: {} };
  const deliveries = [];
  const sentBodies = [];
  const failures = new Set();
  const controls = { beforeData: null, afterDelivery: null };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "notify.example") {
      const id = url.pathname.slice(1);
      deliveries.push(id);
      sentBodies.push(JSON.parse(init.body));
      controls.afterDelivery?.(id);
      return new Response("{}", { status: failures.has(id) ? 503 : 200 });
    }
    if (url.pathname.startsWith("/api/data")) await controls.beforeData?.();
    return new Response(JSON.stringify({ success: true, data: [] }));
  });
  let tick;
  t.mock.method(globalThis, "setInterval", (fn) => { tick = fn; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  startReportScheduler(rt);
  return { rt, database, deliveries, sentBodies, failures, controls, tick: () => tick() };
}

test("日报生成失败不标记已发送，并在计划分钟后重试", async (t) => {
  const h = setup(t, { own: false });
  await h.tick();
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  assert.equal(h.rt.store.settings.dailyReport.delivery.attempts, 1);
  t.mock.timers.tick(60000);
  await h.tick();
  assert.equal(h.rt.store.settings.dailyReport.delivery.attempts, 2);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
});

test("部分发送成功后的重启只重试未成功渠道", async (t) => {
  const h = setup(t);
  h.failures.add("b");
  await h.tick();
  assert.deepEqual(h.deliveries, ["a", "b"]);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  assert.deepEqual(h.database.settings.dailyReport.delivery.successfulChannelIds, ["a"]);
  h.rt.store.data.settings = structuredClone(h.database.settings);
  delete h.rt._reportDelivery;
  h.failures.clear();
  t.mock.timers.tick(60000);
  startReportScheduler(h.rt);
  await h.tick();
  assert.deepEqual(h.deliveries, ["a", "b", "b"]);
  assert.equal(h.database.settings.dailyReport.lastSent, "2026-10-08");
  await h.tick();
  assert.deepEqual(h.deliveries, ["a", "b", "b"]);
});

test("日报重试有退避和次数上限，下一天重新开始", async (t) => {
  const h = setup(t, { now: START - 60000, channels: ["a"] });
  h.failures.add("a");
  await h.tick();
  assert.equal(h.deliveries.length, 0);
  t.mock.timers.tick(60000);
  await h.tick();
  let count = 1;
  for (const delayMinutes of [1, 2, 4, 8]) {
    t.mock.timers.tick(delayMinutes * 60000 - 30000);
    await h.tick();
    assert.equal(h.deliveries.length, count);
    t.mock.timers.tick(30000);
    await h.tick();
    assert.equal(h.deliveries.length, ++count);
  }
  t.mock.timers.tick(3600000);
  await h.tick();
  assert.equal(h.deliveries.length, 5);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  t.mock.timers.tick(86400000 - 15 * 60000 - 3600000);
  h.failures.clear();
  await h.tick();
  assert.equal(h.deliveries.length, 6);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, "2026-10-09");
});

test("日报生成与发送期间不会重入，也不会提前标记已发送", async (t) => {
  const h = setup(t, { channels: ["a"] });
  let release;
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  h.controls.beforeData = async () => { entered(); await gate; };
  const first = h.tick();
  t.after(async () => { release(); await first; });
  await reached;
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  await h.tick();
  assert.equal(h.deliveries.length, 0);
  release();
  await first;
  assert.deepEqual(h.deliveries, ["a"]);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, "2026-10-08");
});

test("发送前进度写库失败不会发送，数据库恢复后继续", async (t) => {
  const h = setup(t, { channels: ["a"] });
  h.database.failNextCommit = true;
  await h.tick();
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  t.mock.timers.tick(60000);
  await h.tick();
  assert.deepEqual(h.deliveries, ["a"]);
  assert.equal(h.database.settings.dailyReport.lastSent, "2026-10-08");
});

test("发送成功后的写库失败不会在同一进程重复发送", async (t) => {
  const h = setup(t, { channels: ["a"] });
  h.controls.afterDelivery = () => { h.database.failNextCommit = true; };
  await h.tick();
  assert.deepEqual(h.deliveries, ["a"]);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  h.controls.afterDelivery = null;
  t.mock.timers.tick(60000);
  await h.tick();
  assert.deepEqual(h.deliveries, ["a"]);
  assert.equal(h.database.settings.dailyReport.lastSent, "2026-10-08");
});

test("没有启用渠道时不标记已发送，用户设置不能覆盖发送进度", async (t) => {
  const h = setup(t, { channels: [] });
  await h.tick();
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
  const delivery = structuredClone(h.rt.store.settings.dailyReport.delivery);
  await h.rt.store.updateSettings({ dailyReport: { time: "10:00", lastSent: "forged", delivery: { attempts: 0 } } });
  assert.deepEqual(h.rt.store.settings.dailyReport.delivery, delivery);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, null);
});

test("立即发送：没有启用渠道时直接报错，不去读上游生成日报", async (t) => {
  const h = setup(t, { channels: [] });
  await assert.rejects(sendReport(h.rt), { code: "REPORT_NO_CHANNELS" });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("日报的标题和正文都带推荐给机器人设的关键词（炬元），钉钉、飞书设了关键词也能收到", async (t) => {
  const h = setup(t, { channels: ["a"] });
  await sendReport(h.rt);
  const [{ title, body }] = h.sentBodies;
  assert.equal(NOTIFY_KEYWORD, BRAND.name);
  assert.ok(title.includes(NOTIFY_KEYWORD), title);
  assert.ok(body.includes(NOTIFY_KEYWORD), body.slice(0, 80));
  // 告警中心的落款、日报的落款也都带
  for (const signature of [BRAND.notificationSignature, BRAND.reportSignature]) assert.ok(signature.includes(NOTIFY_KEYWORD), signature);
});

test("立即发送：返回每个渠道的结果列表", async (t) => {
  const h = setup(t);
  h.failures.add("b");
  const sent = await sendReport(h.rt);
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.results.map(({ id, ok }) => ({ id, ok })), [{ id: "a", ok: true }, { id: "b", ok: false }]);
  assert.deepEqual(h.deliveries, ["a", "b"]);
});

test("角色目录读不到时日报照发：收入、管理员自用、毛利、净利、预收写「没读到」，不写虚假的收入和利润，别的照常", async (t) => {
  const h = setup(t);
  // 一个包月上游（固定成本 ¥10/天）、一个不算进利润的上游（口径提示）；昨天 root、customer 有消费
  h.rt.store.data.stations.push(
    { id: "fixed-up", type: "newapi-key", name: "包月上游", cnyPerUsd: 7, fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }] },
    { id: "skip-up", type: "newapi", name: "不算的上游", includeInProfit: false });
  const { dayStart } = reportDayWindow();
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host === "notify.example") { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (url.pathname === "/api/user/") return Response.json({ success: false, message: "unavailable" }, { status: 503 });
    if (url.pathname === "/api/data/users") return Response.json({ success: true, data: [
      { username: "root", created_at: (dayStart + 3600000) / 1000, quota: 2 * 500000, token_used: 1, count: 1 },
      { username: "customer", created_at: (dayStart + 7200000) / 1000, quota: 1 * 500000, token_used: 1, count: 1 },
    ] });
    return Response.json({ success: true, data: [] });
  });
  const result = await sendReport(h.rt);
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  const { body } = sent[0];
  assert.match(body, /收入、管理员自用、毛利、净利：没读到（用户身份或转售记录没读全）/);
  // 两项成本、口径提示、成本明细照常
  assert.match(body, /上游成本：¥0\.00 ｜ 固定成本：¥10\.00/);
  assert.match(body, /利润怎么算：不算的上游 不算进利润。/);
  assert.match(body, /■ 成本明细\n- 包月上游  ¥10\.00（固定成本）/);
  assert.match(body, /■ 预收：没读到（用户身份或转售记录没读全）/);
  // 用户列表读不到：管理员标不出，排行下面说一句
  assert.match(body, /1\. root  ¥2\.00[\s\S]*2\. customer  ¥1\.00[\s\S]*（用户身份没读到，管理员没标出）/);
  assert.doesNotMatch(body, /（管理员）/);
  // 利润不写：没有收入、毛利、净利的数字
  assert.doesNotMatch(body, /收入：|毛利：¥|净利：¥/);
  // 别的照常
  assert.match(body, /■ 用量/);
  assert.match(body, /■ 上游余额/);
  const report = await buildReport(h.rt);
  assert.equal(report.degraded, true);
  // 邮件：收入、毛利、净利三格写「没读到」，毛利、净利下面照常写两项成本
  const tile = (label) => report.html.match(new RegExp(`${label}</div>\\s*<div[^>]*>([^<]*)</div>\\s*(?:<div[^>]*>([^<]*)</div>)?`));
  assert.deepEqual(tile("收入").slice(1), ["没读到", "用户身份或转售记录没读全"]);
  assert.deepEqual(tile("毛利").slice(1), ["没读到", "上游成本 ¥0.00"]);
  assert.deepEqual(tile("净利").slice(1), ["没读到", "固定成本 ¥10.00"]);
  assert.match(report.html, /预收：没读到（用户身份或转售记录没读全）/);
  assert.match(report.html, /（用户身份没读到，管理员没标出）/);
  assert.match(report.html, /利润怎么算[\s\S]*不算的上游 不算进利润。/);
  assert.match(report.html, /成本明细[\s\S]*包月上游/);
  assert.doesNotMatch(report.html, /NaN|undefined|null/);
});

test("定时发送：收入确认不了时先按退避重试，最后一次还确认不了才发降级的那份", async (t) => {
  const h = setup(t);
  let usersDown = true;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "notify.example") { h.deliveries.push(url.pathname.slice(1)); h.sentBodies.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (url.pathname === "/api/user/") return usersDown ? Response.json({ success: false, message: "unavailable" }, { status: 503 })
      : Response.json({ success: true, data: { items: [{ id: 1, username: "root", role: 100 }], total: 1 } });
    return Response.json({ success: true, data: [] });
  });
  await h.tick();
  assert.deepEqual(h.deliveries, [], "第一次先不发");
  for (const delayMinutes of [1, 2, 4]) {
    t.mock.timers.tick(delayMinutes * 60000);
    await h.tick();
  }
  assert.deepEqual(h.deliveries, [], "前四次都不发");
  assert.equal(h.rt.store.settings.dailyReport.delivery.attempts, 4);
  t.mock.timers.tick(8 * 60000);
  await h.tick();
  assert.deepEqual(h.deliveries, ["a", "b"], "第五次照发降级的那份");
  assert.match(h.sentBodies[0].body, /没读到（用户身份或转售记录没读全）/);
  assert.equal(h.rt.store.settings.dailyReport.lastSent, h.rt.store.settings.dailyReport.delivery.day);
});

test("定时发送：收入确认不了时先不发，重试时恢复了就发完整的那份", async (t) => {
  const h2 = setup(t);
  let usersDown = true;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "notify.example") { h2.deliveries.push(url.pathname.slice(1)); h2.sentBodies.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (url.pathname === "/api/user/") return usersDown ? Response.json({ success: false, message: "unavailable" }, { status: 503 })
      : Response.json({ success: true, data: { items: [{ id: 1, username: "root", role: 100 }], total: 1 } });
    return Response.json({ success: true, data: [] });
  });
  await h2.tick();
  usersDown = false;
  t.mock.timers.tick(60000);
  await h2.tick();
  assert.deepEqual(h2.deliveries, ["a", "b"]);
  assert.doesNotMatch(h2.sentBodies[0].body, /没读到/);
});

test("转售记录没读全、用户列表读得到时：收入那几项写「没读到」，预收和管理员标记照常", async (t) => {
  const h = setup(t);
  h.rt.store.data.stations[0].resoldAdminKeys = [{ username: "root", tokenName: "sale" }];
  const { dayStart } = reportDayWindow();
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.host === "notify.example") return new Response("{}", { status: 200 });
    if (url.pathname === "/api/user/") return Response.json({ success: true, data: { items: [
      { id: 1, username: "root", role: 100, quota: 0, used_quota: 0, status: 1 },
      { id: 2, username: "customer", role: 1, quota: 5 * 500000, used_quota: 0, status: 1 },
    ], total: 2 } });
    if (url.pathname === "/api/data/users") return Response.json({ success: true, data: [
      { username: "root", created_at: (dayStart + 3600000) / 1000, quota: 2 * 500000, token_used: 1, count: 1 },
    ] });
    if (url.pathname === "/api/log/stat") return Response.json({ success: false, message: "unavailable" }, { status: 503 });
    return Response.json({ success: true, data: [] });
  });
  const { text, html } = await buildReport(h.rt);
  assert.match(text, /收入、管理员自用、毛利、净利：没读到（用户身份或转售记录没读全）/);
  assert.match(text, /■ 预收：¥5\.00（1 个用户）/);
  assert.match(text, /1\. root（管理员）/);
  // 用户列表读得到：管理员照常标出，不写「管理员没标出」（文字版和邮件版都是）
  assert.doesNotMatch(text, /管理员没标出/);
  assert.doesNotMatch(html, /管理员没标出/);
  assert.match(html, /root <span[^>]*>管理员<\/span>/);
});

test("日报与自营分析共用已确认的收入分类，管理员自用不计收入，异步修改售价不混入同一份日报", async (t) => {
  const h = setup(t);
  const { dayStart } = reportDayWindow();
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/channel/") h.rt.store.list()[0].cnyPerUsd = 2;
    const data = url.pathname === "/api/user/"
      ? { items: [{ id: 1, username: "root", role: 100 }, { id: 2, username: "customer", role: 1 }], total: 2 }
      : url.pathname === "/api/channel/" ? { items: [], total: 0 }
        : url.pathname.startsWith("/api/data") ? [
          { username: "root", model_name: "m", created_at: dayStart / 1000 + 3600, quota: 100 * 500000, token_used: 10, count: 1 },
          { username: "customer", model_name: "m", created_at: dayStart / 1000 + 7200, quota: 10 * 500000, token_used: 10, count: 1 },
        ] : [];
    return Response.json({ success: true, data });
  });
  const report = await buildReport(h.rt);
  assert.match(report.text, /收入：¥10\.00 ｜ 管理员自用：¥100\.00/);
  assert.match(report.text, /净利：¥10\.00/);
  assert.doesNotMatch(report.text, /收入：¥110\.00/);
  assert.match(report.html, />收入<\/div>\s*<div[^>]*>¥10\.00<\/div>/);
});

for (const kind of ["generation", "partial"]) {
  test(`慢事务后的${kind === "generation" ? "生成失败" : "部分发送失败"}从失败完成时退避`, async (t) => {
    const h = setup(t, { own: kind !== "generation" });
    if (kind === "partial") h.failures.add("b");
    h.database.beforeCommit = () => {
      h.database.beforeCommit = null;
      t.mock.timers.tick(90000);
    };
    await h.tick();
    const delivery = h.rt.store.settings.dailyReport.delivery;
    assert.equal(delivery.nextAttemptAt, START + 150000);
    assert.equal(h.database.settings.dailyReport.delivery.nextAttemptAt, START + 150000);
    t.mock.timers.tick(59999);
    await h.tick();
    assert.equal(h.rt._reportDelivery.attempts, 1);
    t.mock.timers.tick(1);
    await h.tick();
    assert.equal(h.rt._reportDelivery.attempts, 2);
    if (kind === "partial") assert.deepEqual(h.deliveries, ["a", "b", "b"]);
  });
}

test("慢的发送前写库失败仍持久化完整退避，重启后不会提前重试", async (t) => {
  const h = setup(t, { channels: ["a"] });
  h.database.failNextCommit = true;
  h.database.beforeCommit = () => {
    h.database.beforeCommit = null;
    t.mock.timers.tick(90000);
  };
  await h.tick();
  assert.equal(h.rt._reportDelivery.nextAttemptAt, START + 150000);
  assert.equal(h.database.settings.dailyReport.delivery.nextAttemptAt, START + 150000);
  assert.deepEqual(h.deliveries, []);
  h.rt.store.data.settings = structuredClone(h.database.settings);
  delete h.rt._reportDelivery;
  startReportScheduler(h.rt);
  t.mock.timers.tick(59999);
  await h.tick();
  assert.deepEqual(h.deliveries, []);
  t.mock.timers.tick(1);
  await h.tick();
  assert.deepEqual(h.deliveries, ["a"]);
});

test("退避进度写库也失败时，从最后一次失败完成时保留运行时退避", async (t) => {
  const h = setup(t, { channels: ["a"] });
  h.database.beforeCommit = () => {
    t.mock.timers.tick(90000);
    h.database.failNextCommit = true;
  };
  await h.tick();
  assert.equal(h.rt._reportDelivery.nextAttemptAt, Date.now() + 60000);
  h.database.beforeCommit = null;
  t.mock.timers.tick(59999);
  await h.tick();
  assert.deepEqual(h.deliveries, []);
  t.mock.timers.tick(1);
  await h.tick();
  assert.deepEqual(h.deliveries, ["a"]);
});

test("日报的「昨天」按业务时区的日历天切：与进程时区无关，夏令时切换日是 25 小时", () => {
  // 北京时间 10-14 08:30：昨天 = 10-13 整天
  const sh = reportDayWindow(Date.parse("2026-10-14T00:30:00Z"), "Asia/Shanghai");
  assert.equal(sh.todayLabel, "2026-10-14");
  assert.equal(sh.dayStart, Date.parse("2026-10-12T16:00:00Z"));
  assert.equal(sh.dayEnd, Date.parse("2026-10-13T16:00:00Z"));
  assert.equal(sh.wideStart, Date.parse("2026-09-09T16:00:00Z"));
  // 纽约 2026-11-01 夏令时结束，这一天有 25 小时
  const ny = reportDayWindow(Date.parse("2026-11-02T17:00:00Z"), "America/New_York");
  assert.equal(ny.todayLabel, "2026-11-02");
  assert.equal(ny.dayStart, Date.parse("2026-11-01T04:00:00Z"));
  assert.equal(ny.dayEnd, Date.parse("2026-11-02T05:00:00Z"));
  assert.equal(ny.dayEnd - ny.dayStart, 25 * 3600000);
});

// ---- 日报的字（design/ui-copy-spec.md §10） ---------------------------------------------------
const USD = 500000; // New API 的 1 美元额度
const DAY_MS = 86400000;
const upstream = (id, name, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.example`, accessToken: "t", cnyPerUsd: 7.2, ...extra });

// 一份完整的日报：自营站点售价 7.5，三个用户（root 是管理员）；消费记录从 20 天前起每天 $100，统计的那天 $140。
// 上游有正常、偏低、快用完（没设汇率、不算进利润）、用完、读不到、还没读取、近期没有花费、归档的，外加一个包月的服务器。
// prior(i) 是 i 天前那天的消费（美元），null 表示那天没有记录
function richSetup(t, { now = START, sellPrice = 7.5, prior = () => 100, priorDays = 20, today = { "gpt-4o": 120, "claude-3": 20 }, usersDown = false, channelsDown = false } = {}) {
  const h = setup(t, { now, channels: [] });
  const { dayStart } = reportDayWindow();
  h.rt.store.data.stations[0].cnyPerUsd = sellPrice;
  h.rt.store.data.stations.push(
    upstream("main", "主力上游", { balance: { ok: true, remaining: 400 } }),
    upstream("spare", "备用上游", { balance: { ok: true, remaining: 4 } }),
    upstream("soon", "快用完上游", { cnyPerUsd: null, includeInProfit: false, balance: { ok: true, remaining: 50 } }),
    upstream("empty", "用完上游", { balance: { ok: true, remaining: 0 } }),
    upstream("broken", "读不到上游", { balance: { ok: false, error: "Unauthorized: token sk-abc expired", code: "AUTHENTICATION_FAILED" } }),
    upstream("fresh", "新上游"),
    upstream("idle", "闲置上游", { balance: { ok: true, remaining: 100 } }),
    upstream("gone", "归档上游", { archivedAt: "2026-10-01T00:00:00.000Z", balance: { ok: true, remaining: 1 } }),
    { id: "server", name: "服务器", type: "fixed", fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }] },
  );
  const predictions = {
    main: { burnPerDay: 50, etaDays: 8 }, spare: { burnPerDay: 2.1, etaDays: 1.9 }, soon: { burnPerDay: 10, etaDays: 5 },
    empty: { burnPerDay: 3, etaDays: 0 }, idle: { burnPerDay: 0, etaDays: null },
  };
  h.rt.history = { predict: (id) => predictions[id] ?? null, usedBetween: () => 0 };
  const sec = (dayOffset, hour = 10) => (dayStart + dayOffset * DAY_MS + hour * 3600000) / 1000;
  const users = [
    { id: 1, username: "root", role: 100, quota: 0, used_quota: 0, status: 1 },
    { id: 2, username: "alice", role: 1, quota: 20 * USD, used_quota: 0, status: 1 },
    { id: 3, username: "bob", role: 1, quota: 6 * USD, used_quota: 0, status: 1 },
  ];
  const ok = (data) => Response.json({ success: true, data });
  const down = () => Response.json({ success: false, message: "unavailable" }, { status: 503 });
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.host === "source.example") {
      if (url.pathname === "/api/user/") return usersDown ? down() : ok({ items: users, total: users.length });
      if (url.pathname === "/api/channel/") return channelsDown ? down() : ok({ items: [], total: 0 });
      if (url.pathname === "/api/data/users") return ok([
        { username: "alice", created_at: sec(0), quota: 80 * USD, token_used: 5000000, count: 20000 },
        { username: "root", created_at: sec(0), quota: 40 * USD, token_used: 3000000, count: 10000 },
        { username: "bob", created_at: sec(0), quota: 20 * USD, token_used: 2000000, count: 5000 },
      ]);
      if (url.pathname === "/api/data/") {
        const rows = [];
        for (let i = priorDays; i >= 1; i--) {
          const usd = prior(i);
          if (usd != null) rows.push({ model_name: "gpt-4o", created_at: sec(-i), quota: usd * USD, token_used: 1000, count: 10 });
        }
        if (today["gpt-4o"]) rows.push({ model_name: "gpt-4o", created_at: sec(0), quota: today["gpt-4o"] * USD, token_used: 8000000, count: 30000 });
        if (today["claude-3"]) rows.push({ model_name: "claude-3", created_at: sec(0, 15), quota: today["claude-3"] * USD, token_used: 2000000, count: 5000 });
        return ok(rows);
      }
      return ok([]);
    }
    // 上游的用量：主力上游这天用了 $50，别的没有
    if (url.pathname === "/api/data/self") return ok(url.host === "main.example" ? [{ model_name: "gpt-4o", created_at: sec(0), quota: 50 * USD, token_used: 1, count: 1 }] : []);
    return ok([]);
  });
  return h;
}

// 邮件里的一个指标格：[数, 下面那行]（下面那行里有颜色的话原样带着 HTML）
const tile = (html, label) => {
  const m = html.match(new RegExp(`>${label}</div>\\s*<div[^>]*>([^<]*)</div>\\s*(?:<div[^>]*>(.*?)</div>)?`));
  return m ? [m[1], m[2] ?? ""] : null;
};
// 预计花费那几行的数随预测方法变，只看写法
const BAND = "预计 ¥[\\d,]+\\.\\d\\d( 到 ¥[\\d,]+\\.\\d\\d)?";
const FORECAST_LINES = new RegExp(`\\n\\n■ 预计花费\\n今天：${BAND}\\n未来 7 天：${BAND}\\n按过去 21 天估算(，过去 2 周平均差 ±\\d+%)?\\n`);

test("日报按 §10 写：标题、统计的那天、经营概览、用量、排行、成本明细、上游余额、预收、预计花费、落款", async (t) => {
  const h = richSetup(t);
  const { title, text } = await buildReport(h.rt);
  assert.equal(title, "【炬元日报】Own 10月7日");
  assert.match(text, FORECAST_LINES);
  assert.equal(text.replace(FORECAST_LINES, "\n"), [
    "【炬元日报】Own · 10月7日（周三）",
    "统计的是 10月7日 一整天",
    "",
    "■ 经营概览",
    "消费：¥1,050.00（环比 +40.0%；比前 7 天日均 ¥750.00 高 40.0%）",
    "收入：¥750.00 ｜ 管理员自用：¥300.00",
    "上游成本：¥360.00 ｜ 毛利：¥390.00（毛利率 52.0%）",
    "固定成本：¥10.00 ｜ 净利：¥380.00（净利率 50.7%）",
    "利润怎么算：快用完上游 不算进利润。",
    "",
    "■ 用量",
    "请求数 3.5 万 ｜ Token（不含缓存）1,000 万 ｜ 有消费的用户 3 个",
    "",
    "■ 用得最多的模型",
    "1. gpt-4o  ¥900.00（Token 800 万 · 请求数 3 万）",
    "2. claude-3  ¥150.00（Token 200 万 · 请求数 5,000）",
    "",
    "■ 消费最多的用户",
    "1. alice  ¥600.00（Token 500 万）",
    "2. root（管理员）  ¥300.00（Token 300 万）",
    "3. bob  ¥150.00（Token 200 万）",
    "",
    "■ 成本明细",
    "- 主力上游  ¥360.00（按用量算）",
    "- 服务器  ¥10.00（固定成本）",
    "- 备用上游  ¥0.00（按用量算）",
    "- 用完上游  ¥0.00（按用量算）",
    "- 读不到上游  ¥0.00（按用量算）",
    "- 新上游  ¥0.00（按用量算）",
    "- 闲置上游  ¥0.00（按用量算）",
    "",
    "■ 上游余额",
    "- 主力上游：$400.00（约 ¥2,880.00），日均花费 ≈ ¥360.00，可用约 8 天",
    "- 备用上游：$4.00（约 ¥28.80），余额偏低，日均花费 ≈ ¥15.12，可用约 2 天",
    "- 快用完上游：¥50.00（没设置汇率），快用完，日均花费 ≈ ¥10.00，可用约 5 天",
    "- 用完上游：$0.00（约 ¥0.00），余额用完",
    "- 读不到上游：读不到余额（登录信息不对或过期了）",
    "- 新上游：还没读取",
    "- 闲置上游：$100.00（约 ¥720.00），近期没有花费",
    "",
    "■ 预收：¥195.00（2 个用户）",
    "",
    "由炬元控制台生成",
  ].join("\n"));
  // 不写上游返回的原文、不标 ⚠、归档的上游不列
  assert.doesNotMatch(text, /Unauthorized|sk-abc|⚠|归档上游/);
});

test("日报的邮件版和文字版同样的字：四个格子、近 14 天消费、排行、上游余额的颜色、预收、落款", async (t) => {
  const h = richSetup(t);
  const { html } = await buildReport(h.rt);
  assert.deepEqual(tile(html, "消费"), ["¥1,050.00", "环比 +40.0% · 比前 7 天日均高 40.0%"]);
  assert.deepEqual(tile(html, "收入"), ["¥750.00", "管理员自用 ¥300.00"]);
  assert.deepEqual(tile(html, "毛利"), ["¥390.00", "毛利率 52.0% · 上游成本 ¥360.00"]);
  assert.deepEqual(tile(html, "净利"), ["¥380.00", "净利率 50.7% · 固定成本 ¥10.00"]);
  assert.match(html, />炬元 · Own 日报</);
  assert.match(html, />10月7日（周三） · 由炬元控制台生成</);
  // 近 14 天：左下第一天，右下最后一天和那天的消费
  assert.match(html, />近 14 天消费</);
  assert.match(html, />9月24日</);
  assert.match(html, />10月7日 · ¥1,050.00</);
  assert.match(html, />用量：请求数 3\.5 万 · Token（不含缓存）1,000 万 · 有消费的用户 3 个</);
  assert.match(html, />用得最多的模型</);
  // 管理员用次要颜色，不标红；「利润怎么算」用墨色
  assert.match(html, /root <span style="color:#667085;font-size:10px">管理员<\/span>/);
  assert.match(html, />利润怎么算<[\s\S]*?color:#152033[^>]*>快用完上游 不算进利润。</);
  // 上游余额：档位名的颜色和上游列表一样（提醒天数以内红、7 天以内黄），右边写余额、下面写人民币或「没设置汇率」
  assert.match(html, /备用上游 <span style="color:#B42F2F;font-size:11px">余额偏低<\/span>/);
  assert.match(html, /快用完上游 <span style="color:#915500;font-size:11px">快用完<\/span>/);
  assert.match(html, /读不到上游 <span style="color:#B42F2F;font-size:11px">读不到余额（登录信息不对或过期了）<\/span>/);
  assert.match(html, /\$400\.00<div[^>]*>约 ¥2,880\.00<\/div>/);
  assert.match(html, /¥50\.00<div[^>]*>没设置汇率<\/div>/);
  assert.match(html, />预收：¥195\.00（2 个用户）</);
  assert.match(html, />预计花费</);
  assert.match(html, />由炬元控制台生成 · 每日经营日报</);
  assert.doesNotMatch(html, /NaN|undefined|null|⚠|Unauthorized|sk-abc|归档上游|#137a63|#c83c3c/i);
});

test("日报：亏损写「−¥…（亏损）」、不写利润率；没设置售价时收入、毛利、净利加「≈」，说明里影响准不准的在前", async (t) => {
  const h = richSetup(t, { sellPrice: null });
  const { text, html } = await buildReport(h.rt);
  assert.match(text, /\n消费：¥140\.00（环比 \+40\.0%；比前 7 天日均 ¥100\.00 高 40\.0%）\n/);
  assert.match(text, /\n收入：≈ ¥100\.00 ｜ 管理员自用：¥40\.00\n/);
  assert.match(text, /\n上游成本：¥360\.00 ｜ 毛利：≈ −¥260\.00（亏损）\n/);
  assert.match(text, /\n固定成本：¥10\.00 ｜ 净利：≈ −¥270\.00（亏损）\n/);
  assert.match(text, /\n利润怎么算：Own 没设置售价，暂按 1 美元额度 = 1 元算。快用完上游 不算进利润。\n/);
  // 邮件：亏损的数字仍是墨色，利润率换成红色的「亏损」
  assert.deepEqual(tile(html, "毛利"), ["≈ −¥260.00", '<span style="color:#B42F2F">亏损</span> · 上游成本 ¥360.00']);
  assert.deepEqual(tile(html, "净利"), ["≈ −¥270.00", '<span style="color:#B42F2F">亏损</span> · 固定成本 ¥10.00']);
});

test("日报：成本读不到时收入照写，上游成本、固定成本、毛利、净利合成一行「没读到（原因）」，不写利润说明和成本明细", async (t) => {
  const h = richSetup(t, { channelsDown: true });
  const { text, html, degraded } = await buildReport(h.rt);
  assert.equal(degraded, false);
  const reason = "上游暂时繁忙，系统稍后会自动再读";
  assert.match(text, new RegExp(`\\n收入：¥750\\.00 ｜ 管理员自用：¥300\\.00\\n上游成本、固定成本、毛利、净利：没读到（${reason}）\\n\\n■ 用量\\n`));
  assert.doesNotMatch(text, /利润怎么算|■ 成本明细|毛利：¥|净利：¥/);
  assert.deepEqual(tile(html, "收入"), ["¥750.00", "管理员自用 ¥300.00"]);
  assert.deepEqual(tile(html, "毛利"), ["没读到", reason]);
  assert.deepEqual(tile(html, "净利"), ["没读到", reason]);
  assert.doesNotMatch(html, />利润怎么算<|>成本明细</);
});

test("日报：收入和成本都读不到时各写一行，原因各说各的；预收、管理员标记也写没读到", async (t) => {
  const h = richSetup(t, { channelsDown: true, usersDown: true });
  const { text, html, degraded } = await buildReport(h.rt);
  assert.equal(degraded, true);
  assert.match(text, /\n收入、管理员自用、毛利、净利：没读到（用户身份或转售记录没读全）\n上游成本、固定成本：没读到（上游暂时繁忙，系统稍后会自动再读）\n\n■ 用量\n/);
  assert.match(text, /\n3\. bob  ¥150\.00（Token 200 万）\n（用户身份没读到，管理员没标出）\n/);
  assert.match(text, /\n■ 预收：没读到（用户身份或转售记录没读全）\n/);
  assert.deepEqual(tile(html, "收入"), ["没读到", "用户身份或转售记录没读全"]);
  assert.deepEqual(tile(html, "毛利"), ["没读到", "上游暂时繁忙，系统稍后会自动再读"]);
});

test("日报的消费对比：前一天没有消费不写环比；前面不满 7 天、平均是 0 不写前 7 天日均；差不到 0.05% 写持平", async (t) => {
  // 每种情况各起一份（假时钟、假请求各自一套）
  const cases = [
    ["只有 3 天记录：只写环比", { priorDays: 3 }, "消费：¥1,050.00（环比 +40.0%）"],
    ["前一天没有消费：不写环比", { prior: (i) => (i === 1 ? 0 : 100) }, "消费：¥1,050.00（比前 7 天日均 ¥642.86 高 63.3%）"],
    ["前 7 天都没有记录：两个都不写，不带括号", { prior: (i) => (i <= 7 ? null : 100) }, "消费：¥1,050.00"],
    ["比前 7 天日均低", { prior: () => 200 }, "消费：¥1,050.00（环比 −30.0%；比前 7 天日均 ¥1,500.00 低 30.0%）"],
    ["和前 7 天日均一样", { prior: () => 140 }, "消费：¥1,050.00（环比 0.0%；和前 7 天日均持平）"],
    ["这天和以前都没有消费", { priorDays: 0, today: {} }, "消费：¥0.00"],
  ];
  for (const [name, options, expected] of cases) {
    await t.test(name, async (st) => {
      const h = richSetup(st, options);
      const { text } = await buildReport(h.rt);
      assert.equal(text.split("\n").find((line) => line.startsWith("消费：")), expected);
    });
  }
});

test("日报的日期按业务时区写，往年带年份", async (t) => {
  const h = richSetup(t, { now: Date.parse("2027-01-01T01:00:00Z") });
  const { title, text } = await buildReport(h.rt);
  assert.equal(title, "【炬元日报】Own 2026年12月31日");
  assert.match(text, /^【炬元日报】Own · 2026年12月31日（周四）\n统计的是 2026年12月31日 一整天\n/);
});
