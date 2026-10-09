import test from "node:test";
import assert from "node:assert/strict";
import { handleChannelOnboardingRequest } from "./handler.js";
import { createChannelOnboardingModule } from "../../../server/channel-onboarding.js";
import { Store } from "../../../db/store.js";
import { queryAccountIdentity } from "../../../lib/providers.js";

async function liveOnboarding(dependencies = {}) {
  const pool = { getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[]],
    commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new Store(pool);
  const own = await store.add({ type: "newapi", baseUrl: "https://own.test", accessToken: "own-pat", isOwn: true });
  let catalogue = null, links = [];
  const rt = { pool, store, reconciliation: { listRules: async () => [] } };
  rt.channelOnboarding = await createChannelOnboardingModule(rt, {
    repository: { getCatalogue: async () => catalogue, listLinks: async () => links,
      saveCatalogue: async (value) => { catalogue = structuredClone(value); },
      saveLinks: async (values) => { links = values; return values; } },
    queryChannels: async () => [{ id: 1, type: 1, name: "Sales", baseUrl: "https://up.test", groups: [] }],
    refresh: async () => {}, ...dependencies,
    queryIdentity: async (connection) => connection.isOwn
      ? { provider: "newapi", baseUrl: connection.baseUrl, accountId: "1" }
      : (dependencies.queryIdentity || queryAccountIdentity)(connection),
  }).load();
  await rt.channelOnboarding.sync();
  const channel = (await rt.channelOnboarding.list()).channels[0];
  return { rt, own, input: { ownStationId: own.id, channelId: 1, channelRevision: channel.revision }, links: () => links };
}

const request = (body = {}) => new Request("http://localhost/api/channel-onboarding", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("U03 authenticated accounts GET走实际wrapper/module，全量read无上游或写入，忽略查询伪造identity/guard", async (t) => {
  const f = await liveOnboarding();
  const identity = { provider: "newapi", baseUrl: "https://up.test", accountId: "7" };
  const monitor = await f.rt.store.add({ name: "Monitor", type: "newapi", baseUrl: identity.baseUrl, accessToken: "monitor-pat" }, { verifiedIdentity: identity });
  const dedicated = await f.rt.store.add({ name: "Billing", type: "newapi", baseUrl: identity.baseUrl, accessToken: "billing-pat", monitorEnabled: false }, { verifiedIdentity: identity });
  await f.rt.store.archive(monitor.id);
  const pure = await f.rt.store.add({ type: "newapi-key", baseUrl: identity.baseUrl, apiKey: "pure-api-key" });
  f.rt.store.data.auth = { ...f.rt.store.auth, isDefault: false };
  f.rt.sessions = { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 };
  const before = structuredClone(f.rt.store.data);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("GET must not query upstream"); });
  t.mock.method(f.rt.store, "_writeNow", async () => { assert.fail("GET must not save Store"); });
  const { registerHooks } = await import("node:module");
  globalThis.__u03AccountsRuntime = f.rt;
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === "next/server" ? { url: "test:u03-next", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:u03-next") return { format: "module", shortCircuit: true, source: "export const NextResponse = {json:(value,init)=>Response.json(value,init)};" };
      if (url.endsWith("/lib/runtime.js")) return { format: "module", shortCircuit: true, source: "export const getRuntime = async () => globalThis.__u03AccountsRuntime;" };
      return next(url, context);
    },
  });
  try {
    const { GET } = await import("./accounts/route.js");
    const url = "http://localhost/api/channel-onboarding/accounts?verifiedIdentity=forged&guard=forged";
    const unauthenticated = await GET(new Request(url)); assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, "UNAUTHORIZED");
    const response = await GET(new Request(url, { headers: { cookie: "rm_session=valid" } }));
    assert.equal(response.status, 200); const model = await response.json(); assert.equal(model.accounts.length, 1);
    assert.deepEqual(model.accounts[0].resources.map((resource) => resource.id).sort(), [monitor.id, dedicated.id].sort());
    assert.deepEqual(model.unverifiedResources.map((resource) => resource.id), [pure.id]);
    assert.doesNotMatch(JSON.stringify(model), /monitor-pat|billing-pat|pure-api-key|forged|verifiedIdentity/);
    assert.deepEqual(f.rt.store.data, before);
    globalThis.__u03AccountsRuntime = { ...f.rt, channelOnboarding: null };
    assert.equal((await GET(new Request(url, { headers: { cookie: "rm_session=valid" } }))).status, 503);
  } finally { hooks.deregister(); delete globalThis.__u03AccountsRuntime; }
});

test("U03 accounts读取失败诊断隐藏全量saved凭据和JWT，不要求GET body", async () => {
  const connection = { accessToken: "saved-pat", password: "saved-password", s2Tokens: { accessToken: "saved-access", refreshToken: "saved-refresh" } };
  const rt = { store: { list: () => [connection] }, channelOnboarding: { listAccounts: async () => { throw new Error("saved-pat saved-password saved-access saved-refresh"); } } };
  const response = await handleChannelOnboardingRequest(new Request("http://localhost/api/channel-onboarding/accounts"), rt, "listAccounts");
  assert.equal(response.status, 400); assert.doesNotMatch(JSON.stringify(await response.json()), /saved-pat|saved-password|saved-access|saved-refresh/);
});

test("HTTP边界保留partial状态与公开重试ID，不能把200当作完成", async () => {
  const result = { complete: false, monitor: { status: "linked", stationIds: ["monitor"] },
    reconciliation: { status: "unverified", reason: "DEPLOYMENT_NOT_VERIFIED" },
    saved: { stationIds: ["monitor"], authorizationStationId: "grant" }, retryInput: { stationId: "monitor" } };
  const response = await handleChannelOnboardingRequest(request(), { channelOnboarding: { connect: async () => result } }, "connect");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
});

test("HTTP边界保留来源变化码且隐藏错误回显凭证", async () => {
  const rt = { channelOnboarding: { probe: async () => {
    throw Object.assign(new Error("token private-secret changed"), { code: "CHANNEL_SOURCE_CHANGED" });
  } } };
  const response = await handleChannelOnboardingRequest(request({ newStation: { accessToken: "private-secret" } }), rt, "probe");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "CHANNEL_SOURCE_CHANGED");
  assert.equal(body.error.includes("private-secret"), false);
});

test("HTTP拒绝坏JSON，不回显包含密码的解析错误", async () => {
  const bad = new Request("http://localhost/api/channel-onboarding", { method: "POST", body: "private-password is not JSON" });
  const response = await handleChannelOnboardingRequest(bad, { channelOnboarding: {} }, "connect");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "请求格式无效", code: "INVALID_REQUEST" });
});

test("HTTP目录查询/即时同步调用公开模块，未初始化明确503", async () => {
  const rt = { channelOnboarding: { list: async () => ({ channels: [], stale: true }),
    sync: async () => ({ channels: [{ id: 1 }], stale: false }) } };
  assert.deepEqual(await (await handleChannelOnboardingRequest(request(), rt, "list")).json(), { channels: [], stale: true });
  assert.deepEqual(await (await handleChannelOnboardingRequest(request(), rt, "sync")).json(), { channels: [{ id: 1 }], stale: false });
  assert.equal((await handleChannelOnboardingRequest(request(), {}, "list")).status, 503);
});

test("HTTP批量与recover薄入口保留每组partial，并只把body作为业务输入", async () => {
  const seen = [];
  const value = { requestId: "request", complete: false, groups: [{ groupId: "saved", complete: true }, { groupId: "pending", complete: false,
    remainingActions: ["repreview"] }] };
  const module = Object.fromEntries(["probeBatch", "connectBatch", "recoverBatch"].map((operation) => [operation, async (...args) => {
    seen.push({ operation, args }); return value;
  }]));
  for (const operation of Object.keys(module)) {
    const response = await handleChannelOnboardingRequest(request({ input: "intent", guard: "forged" }), { channelOnboarding: module }, operation);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), value);
  }
  assert.equal(seen.length, 3);
  assert.ok(seen.every((call) => call.args[1] && !call.args[1].guard));
  const invalid = await handleChannelOnboardingRequest(request([]), { channelOnboarding: module }, "probeBatch");
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "INVALID_REQUEST");
});

test("真实Provider密码fallback裸JWT回显不能进入HTTP，probe取消不保存", async (t) => {
  const access = "fixture-generated-access-jwt", refresh = "fixture-generated-refresh-jwt";
  t.mock.method(globalThis, "fetch", async (input) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/auth/me")) return { status: 500, text: async () => JSON.stringify({ message: `rejected ${access} ${refresh}` }) };
    const data = path.endsWith("/auth/login") ? { access_token: access, refresh_token: refresh, expires_in: 3600 } : {};
    return { status: 200, text: async () => JSON.stringify({ code: 0, data }) };
  });
  const f = await liveOnboarding();
  const response = await handleChannelOnboardingRequest(request({ ...f.input,
    newStation: { type: "sub2api-password", baseUrl: "https://up.test", email: "a@example.test", password: "fixture-password" } }), f.rt, "probe");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "VERIFICATION_FAILED");
  assert.doesNotMatch(JSON.stringify(body), /fixture-generated|fixture-password/);
  assert.match(body.error, /已隐藏/);
  assert.equal(f.rt.store.list({ includeUnmonitored: true }).length, 1);
  assert.deepEqual(f.links(), []);
});

test("orchestration独立隐藏注入Provider的旧/临时/当前裸JWT", async () => {
  const f = await liveOnboarding({
    queryIdentity: async () => { throw new Error("identity unavailable"); },
    queryMetadata: async (connection) => {
      connection.s2Tokens = { accessToken: "temporary-access", refreshToken: "temporary-refresh" };
      throw new Error("metadata unavailable");
    },
    queryMonitor: async (connection) => {
      connection.s2Tokens = { accessToken: "current-access", refreshToken: "current-refresh" };
      return { result: { ok: false, error: "old-access old-refresh temporary-access temporary-refresh current-access current-refresh" } };
    },
  });
  const legacy = await f.rt.store.add({ type: "sub2api-password", baseUrl: "https://up.test", email: "a@example", password: "password" });
  legacy.s2Tokens = { accessToken: "old-access", refreshToken: "old-refresh" };
  const response = await handleChannelOnboardingRequest(request({ ...f.input, stationId: legacy.id }), f.rt, "probe");
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /old-access|old-refresh|temporary-access|temporary-refresh|current-access|current-refresh/);
  assert.deepEqual(legacy.s2Tokens, { accessToken: "old-access", refreshToken: "old-refresh" });
  assert.equal(legacy.verifiedIdentity, null);
});

test("旧Sub2 JWT经当前身份核验后密码更新复用原ID，同域不同账号保持独立", async (t) => {
  const identityRequests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/keys")) return { status: 403, text: async () => JSON.stringify({ code: 403, message: "Key permission denied" }) };
    const account = options?.headers?.Authorization?.includes("account-8") ? 8 : 7;
    if (path.endsWith("/auth/me")) identityRequests.push(options.headers.Authorization);
    const data = path.endsWith("/auth/login")
      ? { access_token: JSON.parse(options.body).email === "other@example.test" ? "account-8-jwt" : "account-7-jwt", refresh_token: "refresh-jwt", expires_in: 3600 }
      : path.endsWith("/auth/me") ? { id: account, balance: 10 } : {};
    return { status: 200, text: async () => JSON.stringify({ code: 0, data }) };
  });
  const f = await liveOnboarding();
  const legacy = await f.rt.store.add({ type: "sub2api", baseUrl: "https://up.test", accessToken: "old-account-7-jwt",
    name: "Original", lowBalanceUsd: 42, includeInProfit: false, noRenewal: true });
  legacy.apiKey = "obsolete-key"; legacy.email = "obsolete-email"; legacy.password = "obsolete-password";
  legacy.alertState = { status: "low", errorCount: 3 };
  const replacement = { type: "sub2api-password", baseUrl: "https://up.test", email: "same@example.test", password: "replacement-password",
    verifiedIdentity: { provider: "sub2api", baseUrl: "https://up.test", accountId: "forged" },
    onboardingOrigin: { requestId: "forged" }, authorizationUpdateRef: { requestId: "forged" }, guard: "forged" };
  const body = { ...f.input, newStation: replacement, updateCredentials: true };
  const preview = await (await handleChannelOnboardingRequest(request(body), f.rt, "probe")).json();
  assert.equal(preview.station.id, legacy.id);
  assert.equal(preview.credentialUpdateRequired, true);
  assert.equal(legacy.verifiedIdentity, null);
  assert.equal(legacy.type, "sub2api");
  assert.ok(identityRequests.includes("Bearer old-account-7-jwt"));
  const batchInput = { requestId: "91776f02-a520-47f2-a581-3cda3017d929", ownStationId: f.own.id,
    selections: [{ selectionId: "legacy", newStation: replacement, monitor: true, updateCredentials: true }],
    groups: [{ groupId: "monitor", selectionId: "legacy", channels: [{ channelId: 1, channelRevision: f.input.channelRevision }] }] };
  const batchProbe = await (await handleChannelOnboardingRequest(request(batchInput), f.rt, "probeBatch")).json();
  const mocked = t.mock.method(f.rt.store, "updateLocked", async () => { throw new Error("store save failed"); });
  const failed = await (await handleChannelOnboardingRequest(request({ ...batchInput, previewId: batchProbe.previewId }), f.rt, "connectBatch")).json();
  assert.equal(failed.complete, false); assert.deepEqual(failed.groups[0].saved.stationIds, [legacy.id]);
  mocked.mock.restore();
  const recovered = await (await handleChannelOnboardingRequest(request(batchProbe.retryInput), f.rt, "recoverBatch")).json();
  assert.equal(recovered.complete, false); assert.equal(recovered.groups[0].code, "CREDENTIAL_UPDATE_UNCONFIRMED");
  assert.deepEqual(recovered.groups[0].saved.stationIds, [legacy.id]); assert.equal(legacy.type, "sub2api");
  const connected = await (await handleChannelOnboardingRequest(request(body), f.rt, "connect")).json();
  assert.equal(connected.complete, true);
  assert.deepEqual(connected.saved.stationIds, [legacy.id]);
  assert.equal(f.rt.store.list().length, 2);
  assert.equal(legacy.type, "sub2api-password");
  assert.equal(legacy.verifiedIdentity.accountId, "7");
  assert.equal(legacy.authVersion, 2);
  assert.equal(legacy.accessToken, ""); assert.equal(legacy.apiKey, ""); assert.equal(legacy.userId, "");
  assert.equal(legacy.lowBalanceUsd, 42); assert.equal(legacy.includeInProfit, false); assert.equal(legacy.noRenewal, true);
  assert.deepEqual(legacy.alertState, { status: "low", errorCount: 3 });
  assert.equal(legacy.onboardingOrigin, undefined); assert.equal(legacy.authorizationUpdateRef, null);
  const another = await (await handleChannelOnboardingRequest(request({ ...body,
    newStation: { ...replacement, email: "other@example.test" } }), f.rt, "connect")).json();
  assert.equal(another.complete, true);
  assert.notEqual(another.saved.stationIds[0], legacy.id);
  assert.equal(f.rt.store.get(another.saved.stationIds[0]).verifiedIdentity.accountId, "8");
  assert.equal(f.rt.store.list().length, 3);
});
