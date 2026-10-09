import test from "node:test";
import assert from "node:assert/strict";
import { purgeStation } from "./purge.js";
import { registerHooks } from "node:module";
import { Store, stationBusinessVersion } from "../../../../db/store.js";

async function stationRoute() {
  // Replace only the Next/runtime authentication adapter; execute the actual PUT handler and Store.
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return nextLoad(url, context);
  } });
  try { return await import("./route.js"); } finally { hook.deregister(); }
}

test("公共PUT明确映射CAS，忽略伪造identity/markers/guard，restore保留用途设置", async () => {
  const { PUT } = await stationRoute();
  const pool = { getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[]],
    commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new Store(pool);
  const station = await store.add({ type: "sub2api-password", baseUrl: "https://put.test", email: "a@example", password: "saved-password",
    monitorEnabled: false, lowBalanceUsd: 23, cnyPerUsd: 0.5, noRenewal: true });
  station.onboardingOrigin = { requestId: "server-origin" };
  station.authorizationUpdateRef = { requestId: "server-rotation" };
  station.alertState = { errorCount: 3 };
  const rt = { store, history: { predict: () => null, sparkline: () => [], usedSince: () => 0 } };
  const send = (body) => PUT(new Request("https://local.test/api/stations/one", { method: "PUT", body: JSON.stringify(body) }), rt, { id: station.id });
  const response = await send({ name: "Renamed", expectedAuthVersion: 1, expectedResourceVersion: stationBusinessVersion(station),
    verifiedIdentity: { provider: "sub2api", baseUrl: station.baseUrl, accountId: "forged" },
    onboardingOrigin: { requestId: "forged" }, authorizationUpdateRef: { requestId: "forged" }, guard: { bypass: true } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(station.verifiedIdentity, null);
  assert.equal(station.onboardingOrigin.requestId, "server-origin");
  assert.equal(station.authorizationUpdateRef.requestId, "server-rotation");
  assert.equal("onboardingOrigin" in result.station, false);
  assert.equal("authorizationUpdateRef" in result.station, false);
  assert.equal("verifiedIdentity" in result.station && result.station.verifiedIdentity != null, false);
  const oldVersion = stationBusinessVersion(station);
  await store.archive(station.id);
  const stale = await send({ archived: false, expectedAuthVersion: 1, expectedResourceVersion: oldVersion });
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).code, "RESOURCE_CHANGED");
  assert.ok(station.archivedAt, "a rejected restore must not publish before its CAS check");
  const restored = await send({ archived: false, expectedAuthVersion: 1, expectedResourceVersion: stationBusinessVersion(station) });
  assert.equal(restored.status, 200);
  assert.equal(station.archivedAt, null);
  assert.equal(station.monitorEnabled, false); assert.equal(station.isOwn, false); assert.equal(station.includeInProfit, false);
  assert.equal(station.lowBalanceUsd, 23); assert.equal(station.cnyPerUsd, 0.5); assert.equal(station.noRenewal, true);
  assert.deepEqual(station.alertState, { errorCount: 3 });
  const staleAuth = await send({ name: "Ignored", expectedAuthVersion: 99 });
  assert.equal(staleAuth.status, 400);
  assert.equal((await staleAuth.json()).code, "AUTHORIZATION_CHANGED");
  assert.equal(station.name, "Renamed");
});

test("U04 actual authenticated GET显式includeUnmonitored可重载暂停和专用授权完整编辑数据，默认/非法值不开放全量", async (t) => {
  const pool = { getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[]],
    commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new Store(pool);
  const own = await store.add({ type: "newapi", baseUrl: "https://own.test", accessToken: "own-secret", isOwn: true });
  const paused = await store.add({ type: "newapi", baseUrl: "https://up.test", accessToken: "monitor-secret", userId: "41",
    costAliases: ["old-alias"], lowBalanceUsd: 17, cnyPerUsd: 0.7, noRenewal: true, fixedPurchases: [{ amount: 200, days: 30, startDate: "2026-10-01" }] });
  const dedicated = await store.add({ type: "sub2api-password", baseUrl: "https://billing.test", email: "billing@example.test", password: "billing-password", monitorEnabled: false,
    costAliases: ["billing-alias"], lowBalanceUsd: 29, cnyPerUsd: 0.6, noRenewal: true });
  const archived = await store.add({ type: "newapi", baseUrl: "https://archived.test", accessToken: "archived-secret" }); await store.archive(archived.id);
  paused.onboardingOrigin = { requestId: "internal-origin" }; paused.authorizationUpdateRef = { requestId: "internal-update" };
  dedicated.s2Tokens = { accessToken: "generated-access", refreshToken: "generated-refresh" };
  store.data.auth = { username: "admin", isDefault: false };
  const rt = { store, history: { predict: () => null, sparkline: () => [], usedSince: () => 0 },
    sessions: { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 } };
  const { PUT } = await stationRoute();
  const pausedResponse = await PUT(new Request("http://localhost/api/stations/one", { method: "PUT", body: JSON.stringify({ monitorEnabled: false,
    expectedAuthVersion: paused.authVersion, expectedResourceVersion: stationBusinessVersion(paused) }) }), rt, { id: paused.id });
  assert.equal(pausedResponse.status, 200); assert.equal(paused.monitorEnabled, false); assert.equal(own.isOwn, true);
  const before = structuredClone(store.data);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("GET must not fetch upstream"); });
  t.mock.method(store, "_writeNow", async () => { assert.fail("GET must not write"); });
  globalThis.__u04StationsRuntime = rt;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/server") return { url: "test:u04-stations-next", shortCircuit: true };
      // Isolate the actual authentication adapter from the older PUT handler-only fixture.
      if (specifier === "../../../lib/api.js" && context.parentURL?.endsWith("/app/api/stations/route.js")) {
        return { url: new URL("../../../../lib/api.js?u04-stations-get", import.meta.url).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === "test:u04-stations-next") return { format: "module", shortCircuit: true, source: "export const NextResponse = {json:(value,init)=>Response.json(value,init)};" };
      if (url.endsWith("/lib/runtime.js")) return { format: "module", shortCircuit: true, source: "export const getRuntime = async () => globalThis.__u04StationsRuntime;" };
      return next(url, context);
    },
  });
  try {
    const { GET } = await import("../route.js");
    const get = (query = "", authenticated = true) => GET(new Request(`http://localhost/api/stations${query}`, { headers: authenticated ? { cookie: "rm_session=valid" } : {} }));
    assert.equal((await get("?includeUnmonitored=true", false)).status, 401);
    for (const query of ["", "?includeUnmonitored=false", "?includeUnmonitored=1", "?includeUnmonitored=TRUE", "?includeUnmonitored=invalid"]) {
      assert.deepEqual((await (await get(query)).json()).stations.map((station) => station.id), [own.id]);
    }
    const full = await (await get("?includeUnmonitored=true")).json();
    assert.deepEqual(full.stations.map((station) => station.id), [own.id, paused.id, dedicated.id]);
    const monitor = full.stations.find((station) => station.id === paused.id), billing = full.stations.find((station) => station.id === dedicated.id);
    for (const field of ["id", "userId", "costAliases", "lowBalanceUsd", "cnyPerUsd", "noRenewal", "fixedPurchases", "monitorEnabled", "includeInProfit"]) assert.deepEqual(monitor[field], paused[field]);
    for (const field of ["id", "email", "costAliases", "lowBalanceUsd", "cnyPerUsd", "noRenewal", "monitorEnabled", "includeInProfit"]) assert.deepEqual(billing[field], dedicated[field]);
    assert.doesNotMatch(JSON.stringify(full), /own-secret|monitor-secret|billing-password|generated-access|generated-refresh|internal-origin|internal-update|authorizationUpdateRef|onboardingOrigin|s2Tokens/);
    assert.equal(monitor.hasAccessToken, true); assert.equal(billing.hasPassword, true);
    assert.deepEqual((await (await get("?includeArchived=true")).json()).stations.map((station) => station.id), [own.id, archived.id]);
    assert.deepEqual((await (await get("?includeArchived=true&includeUnmonitored=true")).json()).stations.map((station) => station.id), [own.id, paused.id, dedicated.id, archived.id]);
    assert.deepEqual(store.data, before);
  } finally { hooks.deregister(); delete globalThis.__u04StationsRuntime; }
});

test("彻底删除先清除历史；历史清除失败后保留资源以便重试", async () => {
  let purgeAttempts = 0;
  let removeCalls = 0;
  const station = { id: "station-1" };
  const rt = {
    store: {
      get: () => station,
      remove: async () => { removeCalls += 1; return true; },
    },
    history: {
      purge: async () => {
        purgeAttempts += 1;
        if (purgeAttempts === 1) throw new Error("history database unavailable");
      },
    },
  };

  await assert.rejects(purgeStation(rt, station.id), /history database unavailable/);
  assert.equal(removeCalls, 0);

  assert.deepEqual(await purgeStation(rt, station.id), { ok: true, alreadyPurged: false });
  assert.equal(removeCalls, 1);
});
