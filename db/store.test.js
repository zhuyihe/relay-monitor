import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.js";

function fakePool(stations = []) {
  const conn = {
    beginTransaction: async () => {},
    query: async () => [[]],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  return {
    query: async (sql) => {
      if (sql.startsWith("SELECT id, doc FROM stations")) {
        return [stations.map((doc) => ({ id: doc.id, doc }))];
      }
      if (sql.startsWith("SELECT k, v FROM meta")) {
        return [[
          { k: "settings", v: {} },
          { k: "auth", v: { username: "admin", salt: "test", hash: "test" } },
          { k: "notifications", v: { channels: [], rules: {} } },
        ]];
      }
      return [[]];
    },
    getConnection: async () => conn,
  };
}

test("旧站点数据升级时默认保持续费", async () => {
  const store = await new Store(fakePool([{ id: "old", name: "旧站点", fixedPurchases: [] }])).load();
  assert.equal(store.get("old").noRenewal, false);
});

test("重新标记不再续费会重置单次提醒资格", async () => {
  const store = new Store(fakePool());
  store.data.stations = [{
    id: "station-1",
    noRenewal: true,
    alertState: { state: "warn", notifiedAt: 10, noRenewalLowNotifiedAt: 20 },
  }];

  await store.update("station-1", { noRenewal: false });
  assert.equal(store.get("station-1").alertState.noRenewalLowNotifiedAt, undefined);
  await store.update("station-1", { noRenewal: true });
  assert.equal(store.get("station-1").noRenewal, true);

  await store.update("station-1", { type: "fixed", noRenewal: true });
  assert.equal(store.get("station-1").noRenewal, false);
});

test("成本渠道匹配别名会清理空值并去重", async () => {
  const store = new Store(fakePool());
  const added = await store.add({
    name: "上游",
    type: "newapi",
    baseUrl: "https://public.example.com",
    costAliases: [" internal-host ", "", "internal-host", "10.0.0.8:8080"],
  });
  assert.deepEqual(added.costAliases, ["internal-host", "10.0.0.8:8080"]);

  await store.update(added.id, { costAliases: "alias-a, alias-b\nalias-a" });
  assert.deepEqual(store.get(added.id).costAliases, ["alias-a", "alias-b"]);
});

test("监控上游默认计入利润成本并可显式排除", async () => {
  const store = new Store(fakePool());
  const included = await store.add({ name: "负载均衡后的上游", type: "newapi", baseUrl: "https://a.example.com" });
  const excluded = await store.add({
    name: "重复汇总节点", type: "sub2api-password", baseUrl: "https://b.example.com", includeInProfit: false,
  });
  assert.equal(store.get(included.id).includeInProfit, true);
  assert.equal(store.get(excluded.id).includeInProfit, false);

  await store.update(excluded.id, { includeInProfit: true });
  assert.equal(store.get(excluded.id).includeInProfit, true);
});

test("渠道绑定：只接受存在的渠道 id，字段级合并", async () => {
  const store = new Store(fakePool());
  store.data.notifications.channels = [
    { id: "ch-1", name: "A", type: "webhook", enabled: true },
    { id: "ch-2", name: "B", type: "webhook", enabled: true },
  ];
  const r1 = await store.updateRules({ channelsFor: { low: ["ch-1", "bogus"], eta: ["ch-2"] } });
  assert.deepEqual(r1.channelsFor.low, ["ch-1"]);
  assert.deepEqual(r1.channelsFor.eta, ["ch-2"]);
  assert.deepEqual(r1.channelsFor.exhaust, []);
  // 只更新载荷里出现的键，其余绑定保持
  const r2 = await store.updateRules({ channelsFor: { exhaust: ["ch-2"] } });
  assert.deepEqual(r2.channelsFor.low, ["ch-1"]);
  assert.deepEqual(r2.channelsFor.exhaust, ["ch-2"]);
});

test("删除渠道时清理告警绑定与日报渠道里的死 id", async () => {
  const store = new Store(fakePool());
  store.data.notifications.channels = [
    { id: "ch-1", name: "A", type: "webhook", enabled: true },
    { id: "ch-2", name: "B", type: "webhook", enabled: true },
  ];
  await store.updateRules({ channelsFor: { low: ["ch-1", "ch-2"], error: ["ch-1"] } });
  store.data.settings.dailyReport = { enabled: true, time: "09:00", channelIds: ["ch-1", "ch-2"], lastSent: null };

  await store.removeChannel("ch-1");
  assert.deepEqual(store.rules.channelsFor.low, ["ch-2"]);
  assert.deepEqual(store.rules.channelsFor.error, []);
  assert.deepEqual(store.settings.dailyReport.channelIds, ["ch-2"]);
});

test("加载旧规则时补齐渠道绑定字段且不共享默认对象", async () => {
  const a = await new Store(fakePool()).load();
  const b = await new Store(fakePool()).load();
  assert.deepEqual(a.rules.channelsFor, { low: [], exhaust: [], error: [], recover: [], eta: [] });
  a.rules.channelsFor.low.push("x");
  assert.deepEqual(b.rules.channelsFor.low, []);
});

test("历史默认永久保留，归档资源不进入默认列表但仍可显式查询", async () => {
  const store = new Store(fakePool());
  const station = await store.add({ name: "历史资源", type: "newapi", baseUrl: "https://a.example.com" });
  assert.equal(store.settings.historyRetentionDays, null);

  await store.archive(station.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ includeArchived: true }).length, 1);
  assert.ok(store.get(station.id).archivedAt);
});

test("站点编辑等待同一站点的观察提交边界", async () => {
  const store = new Store(fakePool());
  const station = await store.add({ name: "来源", type: "newapi", baseUrl: "https://old.example", accessToken: "old" });
  let release;
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const observation = store.withStationLocks([station.id], async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await reached;
  const update = store.update(station.id, { accessToken: "new" });
  await Promise.resolve();
  assert.equal(store.get(station.id).accessToken, "old", "edit must not mutate memory before observation commits");
  release();
  await Promise.all([observation, update]);
  assert.equal(store.get(station.id).accessToken, "new");
});

test("写库失败向调用方报错，后续串行保存仍能成功", async () => {
  const pool = fakePool();
  const connection = await pool.getConnection();
  const failure = new Error("simulated database failure");
  let attempts = 0;
  pool.getConnection = async () => {
    if (++attempts === 1) throw failure;
    return connection;
  };
  const store = new Store(pool);
  const failed = assert.rejects(store.save(), /保存失败/);
  const recovered = store.save();
  await Promise.all([failed, recovered]);
  assert.equal(attempts, 2);
});

test("配置写库失败不会发布账号、设置、通知或站点变更", async () => {
  const changes = [
    (store) => store.updateSettings({ refreshIntervalSec: 90 }),
    (store) => store.setPassword("new-admin", "new-password"),
    (store) => store.add({ name: "new", type: "newapi" }),
    (store) => store.update("station", { name: "new", password: "new-password", noRenewal: true }),
    (store) => store.remove("station"),
    (store) => store.archive("station"),
    (store) => store.restore("archived"),
    (store) => store.addChannel({ name: "new", type: "webhook" }),
    (store) => store.updateChannel("channel", { name: "new", config: { url: "new" } }),
    (store) => store.removeChannel("channel"),
    (store) => store.updateRules({ onLow: false, channelsFor: { low: [] } }),
  ];
  for (const change of changes) {
    const pool = fakePool();
    pool.getConnection = async () => { throw new Error("database offline"); };
    const store = new Store(pool);
    store.data = structuredClone(store.data);
    store.data.auth = { username: "admin", salt: "old", hash: "old", isDefault: false };
    store.data.stations = [
      { id: "station", name: "old", type: "newapi", archivedAt: null, alertState: { state: "warn" } },
      { id: "archived", name: "archived", archivedAt: "2026-10-01T00:00:00.000Z" },
    ];
    store.data.notifications.channels = [{ id: "channel", name: "old", config: { url: "old" } }];
    store.data.notifications.rules.channelsFor = { low: ["channel"] };
    store.data.settings.dailyReport.channelIds = ["channel"];
    const previous = structuredClone(store.data);
    await assert.rejects(change(store), /保存失败/);
    assert.deepEqual(store.data, previous);
  }
});

test("配置提交前读到旧值，并发配置保存不会相互覆盖", async () => {
  const pool = fakePool();
  const connection = await pool.getConnection();
  let entered;
  let release;
  const reached = new Promise((resolve) => { entered = resolve; });
  connection.commit = async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    connection.commit = async () => {};
  };
  const store = new Store(pool);
  const first = store.updateSettings({ refreshIntervalSec: 90 });
  await reached;
  assert.equal(store.settings.refreshIntervalSec, 60);
  const second = store.updateSettings({ lowBalanceUsd: 8 });
  release();
  await Promise.all([first, second]);
  assert.equal(store.settings.refreshIntervalSec, 90);
  assert.equal(store.settings.lowBalanceUsd, 8);
});

test("站点配置提交保留对象身份及提交期间更新的余额和令牌", async () => {
  const pool = fakePool();
  const connection = await pool.getConnection();
  const store = new Store(pool);
  const station = await store.add({ name: "old", type: "sub2api-password" });
  let entered;
  let release;
  const reached = new Promise((resolve) => { entered = resolve; });
  connection.commit = async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  };
  const update = store.update(station.id, { name: "new" });
  await reached;
  assert.equal(station.name, "old");
  station.balance = { ok: true, remaining: 20 };
  station.s2Tokens = { accessToken: "refreshed" };
  release();
  assert.equal(await update, station);
  assert.equal(store.get(station.id), station);
  assert.equal(station.name, "new");
  assert.deepEqual(station.balance, { ok: true, remaining: 20 });
  assert.equal(station.s2Tokens.accessToken, "refreshed");
});

test("凭证修改提交时作废后台刚取得的旧凭证令牌", async (t) => {
  const pool = fakePool();
  const connection = await pool.getConnection();
  const store = new Store(pool);
  const station = await store.add({ name: "old", type: "sub2api-password", password: "old-password" });
  let entered;
  let release;
  const reached = new Promise((resolve) => { entered = resolve; });
  connection.commit = async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  };
  t.after(() => release?.());
  const update = store.update(station.id, { password: "new-password" });
  await reached;
  station.s2Tokens = { accessToken: "old-credentials-token" };
  release();
  await update;
  assert.equal(station.password, "new-password");
  assert.equal(station.s2Tokens, null);
});
