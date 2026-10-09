import test from "node:test";
import assert from "node:assert/strict";
import { Store, stationBusinessVersion } from "./store.js";
import { refreshStation } from "../server/refresh.js";
import { selectCostUpstreams } from "../server/own-helpers.js";

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
  assert.equal(store.get("old").monitorEnabled, true);
  assert.equal(store.get("old").authVersion, 1);
});

test("账单专用授权全量保存且不进入监控或整体成本", async (t) => {
  const pool = fakePool();
  const conn = await pool.getConnection();
  let documents = [];
  t.mock.method(conn, "query", async (sql, params) => {
    if (sql.startsWith("INSERT INTO stations")) documents = params[0].map((row) => JSON.parse(row[2]));
    return [[]];
  });
  const store = new Store(pool);
  const normal = await store.add({ type: "newapi", name: "现有监控" });
  const grant = await store.add({
    type: "newapi", name: "账单授权", monitorEnabled: false, includeInProfit: true, isOwn: true,
  });
  assert.deepEqual(store.list().map((s) => s.id), [normal.id]);
  assert.deepEqual(store.list({ includeUnmonitored: true }).map((s) => s.id), [normal.id, grant.id]);
  assert.equal(store.get(grant.id).includeInProfit, false);
  assert.equal(store.get(grant.id).isOwn, false);
  assert.equal(documents.length, 2);
  const restarted = await new Store(fakePool(documents)).load();
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.get(grant.id).monitorEnabled, false);
  await restarted.update(grant.id, { includeInProfit: true, isOwn: true });
  assert.equal(restarted.get(grant.id).includeInProfit, false);
  assert.equal(restarted.get(grant.id).isOwn, false);
  assert.equal(selectCostUpstreams([{ ...grant, includeInProfit: true }], "own").included.length, 0);
});

test("身份只能由服务端验证参数保存，真实授权变更作废身份和令牌", async () => {
  const store = new Store(fakePool());
  const identity = { provider: "sub2api", baseUrl: "https://supplier.example/", accountId: "81" };
  const station = await store.add({
    type: "sub2api-password", baseUrl: "https://supplier.example", email: "a@example", password: "secret",
    verifiedIdentity: identity, authVersion: 99,
  });
  assert.equal(station.verifiedIdentity, null);
  assert.equal(station.authVersion, 1);
  await store.update(station.id, { verifiedIdentity: identity, authVersion: 99 });
  assert.equal(station.verifiedIdentity, null);
  await store.update(station.id, {}, { verifiedIdentity: identity });
  assert.equal(station.verifiedIdentity.accountId, "81");
  assert.equal(station.verifiedIdentity.baseUrl, "https://supplier.example");
  station.s2Tokens = { accessToken: "rotated" };
  await store.save();
  assert.equal(station.authVersion, 1, "automatic JWT rotation is not an account change");
  await store.update(station.id, { name: "新名字", password: "secret" });
  assert.equal(station.authVersion, 1);
  assert.equal(station.verifiedIdentity.accountId, "81");
  await store.update(station.id, { email: "b@example" });
  assert.equal(station.authVersion, 2);
  assert.equal(station.verifiedIdentity, null);
  assert.equal(station.s2Tokens, null);
  await store.update(station.id, { password: "new" }, { verifiedIdentity: { ...identity, accountId: "82" } });
  assert.equal(station.authVersion, 3);
  assert.equal(station.verifiedIdentity.accountId, "82");
});

test("服务端验证结果不能覆盖已经编辑的新授权版本", async () => {
  const store = new Store(fakePool());
  const station = await store.add({ type: "newapi", baseUrl: "https://supplier.example", accessToken: "old" });
  await store.update(station.id, { accessToken: "new" });
  await assert.rejects(store.update(station.id, {}, {
    expectedAuthVersion: 1, verifiedIdentity: { provider: "newapi", baseUrl: "https://supplier.example", accountId: "old-account" },
  }), (error) => error.code === "AUTHORIZATION_CHANGED");
  assert.equal(station.accessToken, "new");
  assert.equal(station.authVersion, 2);
  assert.equal(station.verifiedIdentity, null);
});

test("资源业务版本包含用途/身份/归档，自动令牌刷新和名称不改变版本", async () => {
  const store = new Store(fakePool());
  const station = await store.add({ type: "sub2api", baseUrl: "https://supplier.example/", accessToken: "jwt" });
  const before = stationBusinessVersion(station);
  station.s2Tokens = { accessToken: "renewed", refreshToken: "renewed-refresh" };
  await store.update(station.id, { name: "Renamed" });
  assert.equal(stationBusinessVersion(station), before);
  await store.update(station.id, { monitorEnabled: false });
  assert.notEqual(stationBusinessVersion(station), before);
  await assert.rejects(store.update(station.id, { name: "Stale edit" }, { expectedResourceVersion: before }),
    (error) => error.code === "RESOURCE_CHANGED");
  assert.equal(station.name, "Renamed");
  const paused = stationBusinessVersion(station);
  await store.update(station.id, {}, { verifiedIdentity: { provider: "sub2api", baseUrl: station.baseUrl, accountId: "7" } });
  assert.notEqual(stationBusinessVersion(station), paused);
  const verified = stationBusinessVersion(station);
  await store.archive(station.id);
  assert.notEqual(stationBusinessVersion(station), verified);
});

test("updateLocked不递归加锁，guard/CAS与marker在同次提交后发布，失败保留旧配置", async (t) => {
  const pool = fakePool(), conn = await pool.getConnection(), store = new Store(pool);
  const station = await store.add({ type: "sub2api", baseUrl: "https://supplier.example", accessToken: "old-jwt",
    onboardingOrigin: { requestId: "forged" }, authorizationUpdateRef: { requestId: "forged" } });
  assert.equal(station.onboardingOrigin, undefined);
  assert.equal(station.authorizationUpdateRef, undefined);
  let documents;
  t.mock.method(conn, "query", async (sql, params) => {
    if (sql.startsWith("INSERT INTO stations")) documents = params[0].map((row) => JSON.parse(row[2]));
    return [[]];
  });
  const options = { expectedAuthVersion: 1, expectedResourceVersion: stationBusinessVersion(station),
    verifiedIdentity: { provider: "sub2api", baseUrl: station.baseUrl, accountId: "7" },
    authorizationUpdateRef: { requestId: "rotation", accountKey: "account", authVersion: 99, secret: "forged-secret" },
    guard: (current) => { assert.equal(current, station); assert.equal(current.type, "sub2api"); } };
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  t.mock.method(conn, "commit", async () => { entered(); await new Promise((resolve) => { release = resolve; }); throw new Error("offline"); });
  const change = { type: "sub2api-password", email: "a@example", password: "new-password" };
  const pending = store.withStationLocks([station.id], () => store.updateLocked(station.id, change, options));
  const rejection = assert.rejects(pending, /保存失败/);
  await reached;
  assert.equal(station.accessToken, "old-jwt");
  assert.equal(station.authorizationUpdateRef, undefined);
  assert.equal(documents[0].accessToken, "");
  assert.equal(documents[0].authorizationUpdateRef.authVersion, 2);
  assert.equal(documents[0].authorizationUpdateRef.secret, undefined);
  release();
  await rejection;
  assert.equal(station.type, "sub2api");
  assert.equal(station.verifiedIdentity, null);
  t.mock.method(conn, "commit", async () => {});
  await store.withStationLocks([station.id], () => store.updateLocked(station.id, change, options));
  assert.equal(station.type, "sub2api-password");
  assert.equal(station.accessToken, "");
  assert.equal(station.authVersion, 2);
  assert.deepEqual(station.authorizationUpdateRef, { requestId: "rotation", accountKey: "account", authVersion: 2, authorizationType: "sub2api-password" });
  await assert.rejects(store.update(station.id, {}, { guard: () => { throw new Error("basis changed"); } }), /basis changed/);
  const count = store.list({ includeUnmonitored: true }).length;
  await assert.rejects(store.add({ type: "newapi" }, { guard: () => { throw new Error("basis changed"); } }), /basis changed/);
  assert.equal(store.list({ includeUnmonitored: true }).length, count);
  const origin = await store.add({ type: "newapi-key", apiKey: "call-key", password: "ignored-password" }, {
    onboardingOrigin: { requestId: "batch", selectionId: "key", accountKey: null, type: "newapi-key", purpose: "monitor", secret: "ignored-secret" },
    guard: (current) => assert.equal(current, null),
  });
  assert.deepEqual(origin.onboardingOrigin, { requestId: "batch", selectionId: "key", accountKey: null, type: "newapi-key", purpose: "monitor" });
  assert.equal(origin.password, "");
  await store.update(station.id, { type: "sub2api", accessToken: "replacement-jwt" });
  assert.equal(station.email, ""); assert.equal(station.password, "");
  assert.equal(station.authorizationUpdateRef, null);
});

test("用途与身份在提交前保持旧值，失败不发布并可重试", async (t) => {
  const pool = fakePool();
  const conn = await pool.getConnection();
  const store = new Store(pool);
  const station = await store.add({ type: "newapi", baseUrl: "https://supplier.example", accessToken: "old" });
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  t.mock.method(conn, "commit", async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  const pending = store.update(station.id, { monitorEnabled: false }, {
    verifiedIdentity: { provider: "newapi", baseUrl: "https://supplier.example", accountId: "1" },
  });
  await reached;
  assert.equal(store.list().length, 1);
  assert.equal(station.verifiedIdentity, null);
  release();
  await pending;
  assert.equal(store.list().length, 0);
  assert.equal(station.verifiedIdentity.accountId, "1");
  t.mock.method(conn, "commit", async () => { throw new Error("offline"); });
  await assert.rejects(store.update(station.id, { monitorEnabled: true, accessToken: "new" }), /保存失败/);
  assert.equal(station.monitorEnabled, false);
  assert.equal(station.authVersion, 1);
  assert.equal(station.verifiedIdentity.accountId, "1");
  t.mock.method(conn, "commit", async () => {});
  await store.update(station.id, { monitorEnabled: true, accessToken: "new" });
  assert.equal(station.monitorEnabled, true);
  assert.equal(station.authVersion, 2);
  assert.equal(station.verifiedIdentity, null);
});

test("按 ID 刷新账单授权不请求上游或写历史告警", async (t) => {
  const store = new Store(fakePool());
  const grant = await store.add({ type: "newapi", monitorEnabled: false });
  const forbidden = () => { throw new Error("must not monitor a billing-only grant"); };
  t.mock.method(globalThis, "fetch", forbidden);
  assert.equal(await refreshStation({ store, history: { append: forbidden, predict: forbidden } }, grant), null);
  assert.equal(await refreshStation({ store, history: { append: forbidden, predict: forbidden } },
    { ...grant, monitorEnabled: true }), null, "a stale caller cannot bypass persisted purpose");
  assert.equal(grant.balance, null);
  assert.equal(grant.alertState, null);
});

test("在途余额查询期间关闭监控后丢弃历史和告警", async (t) => {
  const store = new Store(fakePool());
  const station = await store.add({ type: "newapi", baseUrl: "https://supplier.example", accessToken: "test" });
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify({ success: true, data: { quota: 500000, used_quota: 0 } }));
  });
  const forbidden = () => { throw new Error("disabled station must not write history or evaluate alerts"); };
  const pending = refreshStation({ store, history: { append: forbidden, predict: forbidden } }, station);
  await reached;
  await store.update(station.id, { monitorEnabled: false });
  release();
  assert.equal((await pending).ok, true);
  assert.equal(station.balance, null);
  assert.equal(station.alertState, null);
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

for (const initialAlertState of [{ state: "unknown", errorCount: 0, noRenewalLowNotifiedAt: 20 }, null]) {
  test(`续费计划提交保留后台更新的告警状态（${initialAlertState ? "已有状态" : "初始为空"}）`, async (t) => {
    const pool = fakePool();
    const connection = await pool.getConnection();
    const store = new Store(pool);
    const station = await store.add({ name: "source", type: "newapi", baseUrl: "https://source.example", noRenewal: true });
    station.alertState = structuredClone(initialAlertState);
    store.data.notifications.rules = { ...store.rules, errorThreshold: 3, errorRetrySec: 0 };
    t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 503 }));
    const writes = [];
    connection.query = async (sql, [values] = []) => {
      if (sql.startsWith("INSERT INTO stations")) writes.push(JSON.parse(values[0][2]));
      return [[]];
    };
    let entered;
    let release;
    let commits = 0;
    const reached = new Promise((resolve) => { entered = resolve; });
    connection.commit = async () => {
      if (++commits === 1) {
        entered();
        await new Promise((resolve) => { release = resolve; });
      }
    };
    const update = store.update(station.id, { noRenewal: false });
    t.after(() => release?.());
    await reached;
    let refreshed;
    const refreshReached = new Promise((resolve) => { refreshed = resolve; });
    const save = store.save.bind(store);
    t.mock.method(store, "save", () => { refreshed(); return save(); });
    const refresh = refreshStation({ store, history: { predict: () => null } }, station);
    await refreshReached;
    assert.equal(station.alertState.errorCount, 1);
    const latest = { ...station.alertState, notifiedAt: 30, etaNotifiedAt: 40, noRenewalLowNotifiedAt: 50 };
    station.alertState = latest;
    release();
    await Promise.all([update, refresh]);
    const expected = { ...latest };
    delete expected.noRenewalLowNotifiedAt;
    assert.equal(station.noRenewal, false);
    assert.deepEqual(station.alertState, expected);
    assert.deepEqual(writes.at(-1).alertState, expected);
  });
}

test("ordinary pure-Key credential changes invalidate onboarding recovery marker in the committed configuration", async () => {
  const store = new Store(fakePool());
  const origin = { requestId: "request", selectionId: "key", accountKey: null, type: "newapi-key", purpose: "monitor" };
  const station = await store.add({ type: "newapi-key", baseUrl: "https://up.test", apiKey: "original" }, { onboardingOrigin: origin });
  await store.update(station.id, { name: "renamed" });
  assert.deepEqual(station.onboardingOrigin, origin);
  await store.update(station.id, { apiKey: "replacement", onboardingOrigin: origin });
  assert.equal(station.onboardingOrigin, null, "HTTP-shaped marker cannot preserve the old recovery intent");
  await store.update(station.id, { apiKey: "verified-new" }, { onboardingOrigin: { ...origin, requestId: "new-request" } });
  assert.equal(station.onboardingOrigin.requestId, "new-request");
});
