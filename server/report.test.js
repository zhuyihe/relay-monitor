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
  assert.match(body, /口径提示：不算的上游 不算进利润/);
  assert.match(body, /■ 成本明细（昨日）[\s\S]*包月上游/);
  assert.match(body, /■ 用户余额合计：没读到（用户身份或转售记录没读全）/);
  // 用户列表读不到：管理员标不出，排行下面说一句
  assert.match(body, /1\. root  ¥2\.00[\s\S]*2\. customer  ¥1\.00[\s\S]*（用户身份没读到，管理员没标出）/);
  assert.doesNotMatch(body, /（管理员）/);
  // 利润不写：没有收入、毛利、净利的数字
  assert.doesNotMatch(body, /收入\(不含管理员自用\)：|毛利：¥|净利：¥/);
  // 别的照常
  assert.match(body, /■ 用量/);
  assert.match(body, /■ 上游余额/);
  const report = await buildReport(h.rt);
  assert.equal(report.degraded, true);
  // 邮件：收入、毛利、净利三格写「没读到」，毛利、净利下面照常写两项成本
  const tile = (label) => report.html.match(new RegExp(`${label}</div>\\s*<div[^>]*>([^<]*)</div>\\s*(?:<div[^>]*>([^<]*)</div>)?`));
  assert.deepEqual(tile("收入（不含管理员自用）").slice(1), ["没读到", "用户身份或转售记录没读全"]);
  assert.deepEqual(tile("毛利").slice(1), ["没读到", "上游成本 ¥0.00"]);
  assert.deepEqual(tile("净利").slice(1), ["没读到", "固定成本 ¥10.00"]);
  assert.match(report.html, /用户余额合计：没读到（用户身份或转售记录没读全）/);
  assert.match(report.html, /（用户身份没读到，管理员没标出）/);
  assert.match(report.html, /利润口径[\s\S]*不算的上游 不算进利润/);
  assert.match(report.html, /成本明细（昨日）[\s\S]*包月上游/);
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
  const { text } = await buildReport(h.rt);
  assert.match(text, /收入、管理员自用、毛利、净利：没读到（用户身份或转售记录没读全）/);
  assert.match(text, /■ 用户余额合计：¥5\.00（预收，1 个用户）/);
  assert.match(text, /1\. root（管理员）/);
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
  assert.match(report.text, /收入\(不含管理员自用\)：¥10\.00 ｜ 管理员自用：¥100\.00/);
  assert.match(report.text, /净利：¥10\.00/);
  assert.doesNotMatch(report.text, /收入\(不含管理员自用\)：¥110\.00/);
  assert.match(report.html, /收入（不含管理员自用）/);
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
