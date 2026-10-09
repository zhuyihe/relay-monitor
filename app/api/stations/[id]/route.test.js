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
