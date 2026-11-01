// 后台轮询（server/refresh.js）：自营站点（用户的 New API，余额只用来发现读不到、令牌失效）后台每 5 分钟才读一次，上游站点每轮都读；
// 手动刷新、保存后的刷新所有站点都读；自营站点的后台读取和渠道目录同步、账号身份共用 /api/user/self
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { refreshAll } from "./refresh.js";
import { queryAccountIdentity, resetOwnSelfShare } from "../lib/providers.js";
import { OWN_LOAD } from "../lib/own-load.js";

beforeEach(() => resetOwnSelfShare());

function makeRt(t, { ownFails = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url.host + url.pathname);
    if (ownFails && url.host === "own.test") return Response.json({ success: false, message: "bad token" }, { status: 401 });
    return Response.json({ success: true, data: { id: 1, username: "u", quota: 5000000, used_quota: 0 } });
  });
  const stations = [
    { id: "own", name: "我的站点", type: "newapi", isOwn: true, monitorEnabled: true, baseUrl: "https://own.test", accessToken: "t", userId: "1" },
    { id: "up1", name: "上游", type: "newapi", monitorEnabled: true, baseUrl: "https://up1.test", accessToken: "t", userId: "2" },
  ];
  const rt = {
    store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), rules: {}, channels: [], settings: { lowBalanceUsd: 5 }, save: async () => {} },
    history: { append() {}, predict: () => null },
  };
  return { rt, calls, stations };
}
const hits = (calls, host) => calls.filter((call) => call.startsWith(host)).length;

test("后台轮询：上游站点每轮都读，自营站点每 5 分钟才读一次；手动刷新所有站点都读", async (t) => {
  const { rt, calls } = makeRt(t);
  let now = 1000000;
  t.mock.method(Date, "now", () => now); // /api/user/self 的共用（4 分钟）也按这个钟走
  await refreshAll(rt, { background: true, now });
  assert.deepEqual([hits(calls, "own.test"), hits(calls, "up1.test")], [1, 1], "第一轮都读");
  for (let minute = 1; minute <= 4; minute += 1) { now += 60000; await refreshAll(rt, { background: true, now }); }
  assert.deepEqual([hits(calls, "own.test"), hits(calls, "up1.test")], [1, 5], "每分钟一轮：上游每轮读，自营站点还没到 5 分钟");
  now += 60000;
  await refreshAll(rt, { background: true, now });
  assert.deepEqual([hits(calls, "own.test"), hits(calls, "up1.test")], [2, 6], "满 5 分钟：自营站点读一次");
  now += 60000;
  await refreshAll(rt);
  assert.deepEqual([hits(calls, "own.test"), hits(calls, "up1.test")], [3, 7], "手动刷新（不是后台）：自营站点也读，不用共用的");
  now += 60000;
  await refreshAll(rt, { background: true, now });
  assert.equal(hits(calls, "own.test"), 3, "手动刷新算一次读：之后又从头数 5 分钟");
  assert.equal(OWN_LOAD.STATION_POLL_MS, 5 * 60000);
});

test("读不到自营站点时照样发现：后台轮询读到 401 就记 ok:false（告警评估照常），不会因为 5 分钟一次而丢；读失败的结果不被 /api/user/self 的共用留住", async (t) => {
  const { rt, stations } = makeRt(t, { ownFails: true });
  await refreshAll(rt, { background: true, now: 1000000 });
  assert.equal(stations[0].balance.ok, false);
  assert.equal(stations[1].balance.ok, true);
});

test("自营站点的后台轮询和账号身份（渠道目录同步、对账）共用一次 /api/user/self；手动刷新、强制重读真读", async (t) => {
  const { rt, calls, stations } = makeRt(t);
  await refreshAll(rt, { background: true, now: 1000000 });
  assert.equal(hits(calls, "own.test"), 1);
  const identity = await queryAccountIdentity(stations[0], { shareOwnSelf: true });
  assert.deepEqual(identity, { provider: "newapi", baseUrl: "https://own.test", accountId: "1" });
  assert.equal(hits(calls, "own.test"), 1, "身份读取用了轮询刚读到的");
  await queryAccountIdentity(stations[0]);
  assert.equal(hits(calls, "own.test"), 2, "不 share 的（强制重读）真读");
});

test("令牌作废的那一轮，自营站点的后台轮询必须真读并发现失败：不沿用渠道目录同步、账号身份刚读到的成功结果；失败还会清掉共用里旧的成功结果", async (t) => {
  let revoked = false, calls = 0;
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return revoked ? Response.json({ success: false, message: "bad token" }, { status: 401 }) : Response.json({ success: true, data: { id: 1, username: "u", quota: 5000000, used_quota: 0 } }); });
  const own = { id: "own", name: "我的站点", type: "newapi", isOwn: true, monitorEnabled: true, baseUrl: "https://own.test", accessToken: "t", userId: "1" };
  const rt = { store: { list: () => [own], get: () => own, rules: {}, channels: [], settings: { lowBalanceUsd: 5 }, save: async () => {} }, history: { append() {}, predict: () => null } };
  // 渠道目录同步（共用，不是轮询）刚读到成功的结果
  await queryAccountIdentity(own, { shareOwnSelf: true });
  assert.equal(calls, 1);
  // 令牌这时作废；3 分钟后（在共用的 4 分钟之内）轮询到点：必须自己真读，读到 401
  revoked = true; now += 5 * 60000 - 1; // 轮询的 5 分钟间隔也到了
  await refreshAll(rt, { background: true, now });
  assert.equal(calls, 2, "轮询真读了，没有沿用刚才同步读到的成功结果");
  assert.equal(own.balance.ok, false, "发现令牌作废");
  // 失败把共用里旧的成功结果清掉：之后的同步、身份读取也真读，读到 401
  await assert.rejects(queryAccountIdentity(own, { shareOwnSelf: true }));
  assert.equal(calls, 3);
});
