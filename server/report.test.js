import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../db/store.js";
import { startReportScheduler } from "./report.js";

const START = Date.parse("2026-10-08T01:00:00Z"); // 北京时间 09:00

function setup(t, { now = START, own = true, channels = ["a", "b"] } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const database = { settings: null, failNextCommit: false };
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
  const failures = new Set();
  const controls = { beforeData: null, afterDelivery: null };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.hostname === "notify.example") {
      const id = url.pathname.slice(1);
      deliveries.push(id);
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
  return { rt, database, deliveries, failures, controls, tick: () => tick() };
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
