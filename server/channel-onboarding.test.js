import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connectNewApiUpstream, createChannelOnboardingModule, startChannelOnboarding } from "./channel-onboarding.js";
import { Store, stationBusinessVersion } from "../db/store.js";
import { applyScopePolicy, nextBillingEffectiveFrom, canonicalBillingKey } from "../lib/reconciliation-scope-policy.js";
import { queryAccountIdentity, queryOwnChannels } from "../lib/providers.js";
import { createReconciliationModule } from "./reconciliation.js";
import { handleChannelOnboardingRequest } from "../app/api/channel-onboarding/handler.js";

function fixture(stations = []) {
  let writes = 0;
  let failNext = false;
  const rt = { store: {
    list: () => stations,
    async add(input) {
      writes += 1;
      await Promise.resolve();
      if (failNext) { failNext = false; throw new Error("保存失败，请稍后重试"); }
      const station = { ...input, id: `station-${writes}` };
      stations.push(station);
      return station;
    },
  } };
  return { rt, stations, writes: () => writes, fail: () => { failNext = true; } };
}
const input = { name: "Supplier", baseUrl: "https://up.example/", accessToken: "secret-pat" };
const metadata = async () => ({ userId: "7", tokens: [], groups: {} });

async function accountReadFixture(t) {
  let writes = 0;
  const pool = { getConnection: async () => ({ beginTransaction: async () => {}, query: async () => { writes += 1; return [[]]; },
    commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new Store(pool), identities = { A: { provider: "newapi", baseUrl: "https://same.test", accountId: "A" },
    B: { provider: "newapi", baseUrl: "https://same.test", accountId: "B" } };
  async function add(id, input, identity) {
    const station = await store.add({ name: id, type: "newapi", baseUrl: "https://same.test/", accessToken: `${id}-pat`, ...input }, { verifiedIdentity: identity });
    station.id = id; return station;
  }
  const own = await add("own", { isOwn: true, baseUrl: "https://own.test" });
  const a1 = await add("A-monitor-1", { lowBalanceUsd: 27, cnyPerUsd: 0.7, noRenewal: true, includeInProfit: false }, identities.A);
  const a2 = await add("A-monitor-2", {}, identities.A);
  const billing = await add("A-billing", { monitorEnabled: false }, identities.A);
  const b = await add("B-monitor", {}, identities.B);
  const pure = await add("pure-key", { type: "newapi-key", apiKey: "independent-key" });
  const unknown = await add("unknown-legacy", { userId: "A" });
  const archived = await add("A-archived", {}, identities.A); await store.archive(archived.id);
  a1.balance = { ok: false, error: "403 A-monitor-1-pat old-access old-refresh", remaining: 10, raw: { password: "private-raw" },
    accessToken: "private-balance", diagnostics: { password: "private-diagnostics" }, account: { password: "private-object" } };
  a1.s2Tokens = { accessToken: "old-access", refreshToken: "old-refresh" }; a1.alertState = { errorCount: 9, privateAlert: true };
  a1.onboardingOrigin = { requestId: "private-origin" }; a1.authorizationUpdateRef = { requestId: "private-update" };
  a2.balance = { ok: true, remaining: 10, used: 2, total: 12, currency: "USD" };
  billing.balance = { ok: true, remaining: 10 }; pure.verifiedIdentity = { ...identities.A }; // Pure Key is never account identity evidence.
  const ownSource = { stationId: own.id, provider: "newapi", baseUrl: own.baseUrl, accountId: "1",
    namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", own.baseUrl, "1"])).digest("hex") };
  const state = { catalogue: { ownStationId: own.id, ownSource, syncedAt: 1, sourceVersion: "old-local-source", totalValidated: true, catalogueTotal: 3,
    channels: [1, 2, 3].map((id) => ({ id, name: `Channel ${id}`, type: 1, status: id === 2 ? 2 : 1,
      baseUrl: "https://same.test", revision: `revision-${id}`, groups: ["sales"], missing: id === 3 })) },
    links: [a1, a2, pure].map((station) => ({ ownStationId: own.id, channelId: 1, stationId: station.id, channelRevision: "revision-1", confirmedAt: 1 })),
    rules: [] };
  const rule = (id, station, tokenId, ids, extra = {}) => ({ id, upstreamStationId: station.id, ownStationId: own.id, tokenId, tokenName: `Key ${tokenId}`,
    canonicalKey: canonicalBillingKey(station, station.verifiedIdentity, tokenId), provider: "newapi", ownSource,
    sourceBinding: Object.fromEntries(ids.map((channelId) => [channelId, `revision-${channelId}`])),
    channels: ids.map((channelId) => ({ channelId, name: `Channel ${channelId}` })), enabled: true, archivedAt: null,
    costCoverage: "unknown", coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] },
    scopeVersion: 3, timezone: "Asia/Shanghai", billingEffectiveFrom: Date.parse("2026-10-09T16:00:00Z"), ...extra });
  state.rules = [rule("A-active", billing, 9, [1]), rule("A-history", archived, 9, [3], { enabled: false, archivedAt: "2026-10-01T00:00:00Z", scopeVersion: 1 }),
    rule("A-stopped", a2, 10, [2], { enabled: false }), rule("B-active", b, 9, [2], { costCoverage: "complete", coverageDeclaration: { answer: "none" } })];
  const rt = { store, reconciliation: { listRules: async (options) => { assert.equal(options.includeArchived, true); return structuredClone(state.rules); } } };
  const fail = async () => { throw new Error("account read must not request upstreams"); };
  t.mock.method(globalThis, "fetch", fail);
  const repository = { getCatalogue: async () => structuredClone(state.catalogue), listLinks: async () => structuredClone(state.links), saveLinks: fail, saveCatalogue: fail };
  rt.channelOnboarding = await createChannelOnboardingModule(rt, { repository, now: () => Date.parse("2026-10-09T07:00:00Z"),
    queryChannels: fail, queryIdentity: fail, queryMetadata: fail, queryMonitor: fail }).load();
  writes = 0;
  return { rt, store, a1, a2, billing, b, pure, unknown, archived, state, rule, writes: () => writes };
}

async function authorizationFixture(t, type = "newapi") {
  const state = { now: Date.parse("2026-10-09T07:00:00Z"), docs: [], meta: {}, links: [], rules: [], requests: [],
    commits: 0, rollbacks: 0, sqlHook: null, requestHook: null, failStationId: null, generated: 0, history: [{ stationId: "st_u04_a1", remaining: 20 }] };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input), token = options.headers?.Authorization || "", body = options.body && JSON.parse(options.body);
    state.requests.push({ path: url.pathname, token, body }); await state.requestHook?.(url, options);
    if (token.includes("denied") || state.deniedTokens?.includes(token.replace(/^Bearer\s+/i, ""))) return { status: 403, text: async () => JSON.stringify({ success: false, code: 403, message: token }) };
    const account = token.includes("-B") || body?.email === "b@example.test" ? 43 : url.host === "own.test" ? 1 : 42;
    let data = { id: account };
    if (url.pathname.endsWith("/auth/login") || url.pathname.endsWith("/auth/refresh")) {
      state.generated += 1; data = { access_token: `generated-access-${state.generated}-A`, refresh_token: `generated-refresh-${state.generated}-A`, expires_in: 3600 };
    }
    return { status: 200, text: async () => JSON.stringify(url.pathname.startsWith("/api/v1/") ? { code: 0, data } : { success: true, data }) };
  });
  const read = (sql, params = []) => {
    if (sql.includes("SELECT id, doc FROM stations")) return [state.docs.map((doc) => ({ id: doc.id, doc: structuredClone(doc) }))];
    if (sql.includes("FROM reconciliation_rule_channels")) return [state.rules.flatMap((rule) => rule.members.map((member) => ({ rule_id: rule.id, ...member })))];
    if (sql.includes("FROM reconciliation_rules")) return [structuredClone(sql.includes("WHERE archived_at IS NULL") ? state.rules.filter((rule) => !rule.archived_at) : state.rules)];
    if (sql.includes("FROM channel_monitor_links")) return [structuredClone(state.links)];
    if (sql.includes("FROM meta")) return [Object.entries(state.meta).filter(([key]) => !params.length || params[0] === key || sql.includes("IN ('settings'"))
      .map(([k, v]) => ({ k, v: structuredClone(v) }))];
    throw new Error(`unexpected read: ${sql}`);
  };
  const pool = { query: async (...args) => read(...args), getConnection: async () => {
    let draft;
    return { beginTransaction: async () => { draft = structuredClone({ docs: state.docs, meta: state.meta }); },
      async query(sql, params = []) {
        if (sql.startsWith("DELETE FROM stations")) draft.docs = params.length ? draft.docs.filter((doc) => params[0].includes(doc.id)) : [];
        else if (sql.startsWith("INSERT INTO stations")) {
          const docs = params[0].map((row) => JSON.parse(row[2])), failed = docs.find((doc) => doc.id === state.failStationId);
          if (failed && JSON.stringify(failed) !== JSON.stringify(state.docs.find((doc) => doc.id === failed.id))) throw new Error("synthetic Store failure");
          draft.docs = docs;
        } else if (sql.startsWith("INSERT INTO meta")) for (const [key, value] of params[0]) draft.meta[key] = JSON.parse(value);
        else return read(sql, params);
        await state.sqlHook?.(sql, params); return [[]];
      }, commit: async () => { state.docs = draft.docs; state.meta = draft.meta; state.commits += 1; },
      rollback: async () => { state.rollbacks += 1; }, release() {} };
  } };
  let store = new Store(pool);
  const provider = type.startsWith("sub2api") ? "sub2api" : "newapi", identity = { provider, baseUrl: "https://same.test", accountId: "42" };
  const add = async (id, input, verifiedIdentity = identity) => {
    const station = await store.add({ type, baseUrl: identity.baseUrl, accessToken: `${id}-A`, email: "a@example.test", password: "old-password-A",
      lowBalanceUsd: 31, cnyPerUsd: 0.8, noRenewal: true, ...input }, { verifiedIdentity }); station.id = id; return station;
  };
  const own = await add("st_u04_own", { type: "newapi", baseUrl: "https://own.test", isOwn: true }, { provider: "newapi", baseUrl: "https://own.test", accountId: "1" });
  const a1 = await add("st_u04_a1", { includeInProfit: false }), a2 = await add("st_u04_a2", {}), billing = await add("st_u04_billing", { monitorEnabled: false });
  const pure = await add("st_u04_key", { type: "newapi-key", apiKey: "independent-Key-A" }, null);
  const b = await add("st_u04_b", { accessToken: "account-B", email: "b@example.test" }, { ...identity, accountId: "43" });
  const unknown = await add("st_u04_unknown", { accessToken: "denied-A", email: "unknown@example.test" }, null);
  const archived = await add("st_u04_archived", {}); await store.archive(archived.id);
  const other = await add("st_u04_other", { baseUrl: "https://other.test" }, { ...identity, baseUrl: "https://other.test" });
  a1.alertState = { errorCount: 2, status: "low" }; a1.costAliases = ["retained-alias"];
  const ownSource = { stationId: own.id, provider: "newapi", baseUrl: own.baseUrl, accountId: "1",
    namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", own.baseUrl, "1"])).digest("hex") };
  state.meta.channel_onboarding_catalogue = { ownStationId: own.id, ownSource, syncedAt: state.now,
    sourceVersion: createHash("sha256").update(JSON.stringify([stationBusinessVersion(own), ownSource.namespaceKey])).digest("hex"),
    channels: [1, 2].map((id) => ({ id, name: `Sales ${id}`, type: 1, baseUrl: "https://same.test", status: 1, groups: ["g"], revision: `revision-${id}` })) };
  state.links = [a1, a2, pure].map((station) => ({ own_station_id: own.id, channel_id: 1, station_id: station.id, channel_revision: "revision-1", confirmed_at_ms: 1 }));
  state.rules = [{ id: "rule_u04", upstream_station_id: billing.id, own_station_id: own.id, token_id: 9, token_name: "Key 9", enabled: true,
    provider, canonical_key: canonicalBillingKey(billing, identity, 9), billing_policy: "next-complete-day", scope_version: 3,
    billing_effective_from_ms: Date.parse("2026-10-09T16:00:00Z"), timezone: "Asia/Shanghai", cost_coverage: "complete",
    source_binding: { version: 2, ownSource, channels: { 1: "revision-1" }, coverageDeclaration: { answer: "none" } },
    members: [{ channel_id: 1, channel_name: "Sales 1" }] }];
  store.data.auth = { isDefault: false }; await store.save();
  let rt;
  async function restart() {
    store = new Store(pool); await store.load(); rt = { pool, store, history: { predict: () => null, sparkline: () => [], usedSince: () => 0 },
      sessions: { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 } };
    rt.reconciliation = createReconciliationModule(rt); rt.channelOnboarding = rt.onboardingSource = await createChannelOnboardingModule(rt, { now: () => state.now }).load();
  }
  await restart(); state.commits = 0;
  const accountKey = createHash("sha256").update(JSON.stringify([provider, identity.baseUrl, "42"])).digest("hex");
  const input = { requestId: "u04-operation", targetStationIds: [a1.id, a2.id, billing.id],
    authorization: type === "sub2api-password" ? { type, baseUrl: identity.baseUrl, email: "a@example.test", password: "replacement-password-A" }
      : { type, baseUrl: identity.baseUrl, accessToken: "replacement-A" } };
  const http = (operation, body) => handleChannelOnboardingRequest(new Request("https://local.test/api/channel-onboarding/accounts/account/authorization", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), rt, operation, { accountKey });
  return { state, get rt() { return rt; }, get store() { return store; }, ids: { own: own.id, a1: a1.id, a2: a2.id, billing: billing.id,
    pure: pure.id, b: b.id, unknown: unknown.id, archived: archived.id, other: other.id }, accountKey, input, restart, http };
}

test("U04 genuine Provider+Store+关系Repository HTTP probe零保存，三个eligible原ID并排除pureKey/own/B/unknown/archived/other", async (t) => {
  const f = await authorizationFixture(t), before = structuredClone(f.store.data);
  const input = { ...f.input, targetStationIds: Object.values(f.ids), authorization: { ...f.input.authorization,
    verifiedIdentity: { accountId: "forged" }, authorizationUpdateRef: { requestId: "forged" }, guard: "forged" }, accountKey: "forged" };
  const response = await f.http("probeAccountAuthorization", input); assert.equal(response.status, 200);
  const probe = await response.json(); assert.equal(probe.accountKey, f.accountKey);
  assert.deepEqual(probe.targets.map((target) => target.stationId), f.input.targetStationIds);
  assert.deepEqual(probe.excluded.map((target) => target.stationId), [f.ids.own, f.ids.pure, f.ids.b, f.ids.unknown, f.ids.archived, f.ids.other]);
  assert.deepEqual(probe.targets[2].purposes, { monitor: false, billingRuleIds: ["rule_u04"] });
  assert.deepEqual(probe.targets[0].monitorChannelIds, [1]); assert.deepEqual(probe.targets[2].billingChannelIds, [1]);
  assert.deepEqual(probe.impact, { monitorStationIds: [f.ids.a1, f.ids.a2], billingRuleIds: ["rule_u04"], channels: [{ ownStationId: f.ids.own, channelId: 1, name: "Sales 1" }] });
  assert.doesNotMatch(JSON.stringify(probe), /replacement-A|st_u04_a1-A|denied-A|forged|authorizationUpdateRef|password|digest/);
  assert.deepEqual(f.store.data, before); assert.equal(f.state.commits, 0);
  const wrong = await f.http("probeAccountAuthorization", { ...f.input, requestId: "wrong", authorization: { ...f.input.authorization, accessToken: "replacement-B" } });
  assert.equal(wrong.status, 400); assert.equal((await wrong.json()).code, "ACCOUNT_IDENTITY_CHANGED"); assert.equal(f.state.commits, 0);
  const result = await (await f.http("updateAccountAuthorization", { ...input, previewId: probe.previewId })).json();
  assert.equal(result.complete, false); assert.equal(result.targets.length, Object.keys(f.ids).length);
  assert.equal(result.targets.filter((target) => target.status === "updated").length, 3);
  assert.ok([f.ids.own, f.ids.pure, f.ids.b, f.ids.unknown, f.ids.archived, f.ids.other].every((id) =>
    JSON.stringify(f.store.get(id)) === JSON.stringify(before.stations.find((station) => station.id === id))));
});

test("U04 public一次confirm保持用途设置/alerts/links/rules/history，readonly recover0fetch0write，重启重复不重改或延期", async (t) => {
  const f = await authorizationFixture(t), before = structuredClone({ rules: f.state.rules, links: f.state.links, history: f.state.history });
  const original = structuredClone(f.store.get(f.ids.a1));
  const probe = await (await f.http("probeAccountAuthorization", f.input)).json();
  const updated = await (await f.http("updateAccountAuthorization", { ...f.input, previewId: probe.previewId })).json();
  assert.equal(updated.complete, true); assert.ok(updated.targets.every((target) => target.status === "updated" && target.savedAuthVersion === 2));
  const station = f.store.get(f.ids.a1); for (const field of ["id", "monitorEnabled", "lowBalanceUsd", "cnyPerUsd", "includeInProfit", "noRenewal", "alertState", "costAliases"]) assert.deepEqual(station[field], original[field]);
  assert.equal(f.store.get(f.ids.billing).monitorEnabled, false); assert.equal(f.store.get(f.ids.billing).includeInProfit, false);
  assert.deepEqual({ rules: f.state.rules, links: f.state.links, history: f.state.history }, before);
  assert.doesNotMatch(JSON.stringify(updated), /replacement-A|authorizationUpdateRef|accessToken|password|digest/);
  await f.restart(); const requests = f.state.requests.length, commits = f.state.commits;
  const recovered = await (await f.http("recoverAccountAuthorization", probe.retryInput)).json();
  assert.equal(recovered.complete, true); assert.ok(recovered.targets.every((target) => target.status === "already_updated"));
  assert.equal(f.state.requests.length, requests); assert.equal(f.state.commits, commits);
  f.state.now += 86400000;
  const retry = await (await f.http("updateAccountAuthorization", { ...f.input, previewId: probe.previewId })).json();
  assert.equal(retry.complete, true); assert.equal(f.state.commits, commits); assert.deepEqual(f.state.rules, before.rules);
  const changed = await f.http("probeAccountAuthorization", { ...f.input, authorization: { ...f.input.authorization, accessToken: "other-desired-A" } });
  assert.equal(changed.status, 400); assert.equal((await changed.json()).code, "OPERATION_CHANGED");
});

test("U04 public Store单目标失败保留partial，response-loss+restart由saved donor fresh验证只补缺项", async (t) => {
  const f = await authorizationFixture(t), probe = await (await f.http("probeAccountAuthorization", f.input)).json();
  f.state.failStationId = f.ids.a2;
  const partial = await (await f.http("updateAccountAuthorization", { ...f.input, previewId: probe.previewId })).json();
  assert.equal(partial.complete, false); assert.deepEqual(partial.targets.map((target) => target.status), ["updated", "failed", "updated"]);
  assert.equal(f.store.get(f.ids.a2).authVersion, 1); assert.equal(f.store.get(f.ids.a2).authorizationUpdateRef, undefined);
  assert.equal(f.state.docs.find((doc) => doc.id === f.ids.a2).accessToken, "st_u04_a2-A");
  await f.restart(); const requests = f.state.requests.length;
  const recovered = await (await f.http("recoverAccountAuthorization", probe.retryInput)).json();
  assert.deepEqual(recovered.targets.map((target) => target.status), ["already_updated", "repreview_required", "already_updated"]);
  assert.equal(f.state.requests.length, requests); assert.equal(recovered.complete, false);
  f.state.failStationId = null;
  const retryInput = { ...probe.retryInput, reuseSavedAuthorization: true }, retryProbe = await (await f.http("probeAccountAuthorization", retryInput)).json();
  assert.ok(f.state.requests.length > requests, "saved donor is actually reverified on new probe");
  const completed = await (await f.http("updateAccountAuthorization", { ...retryInput, previewId: retryProbe.previewId })).json();
  assert.equal(completed.complete, true); assert.deepEqual(completed.targets.map((target) => target.status), ["already_updated", "updated", "already_updated"]);
  assert.ok(f.input.targetStationIds.every((id) => f.store.get(id).authVersion === 2));
  await f.restart(); const writes = f.state.commits;
  assert.equal((await (await f.http("recoverAccountAuthorization", probe.retryInput)).json()).complete, true); assert.equal(f.state.commits, writes);
});

test("U04 public已核验当前版本可更换过期授权，unknown目标必须用旧凭据实际核验不能按同域归并", async (t) => {
  const f = await authorizationFixture(t); f.state.deniedTokens = [f.store.get(f.ids.a1).accessToken];
  const unknownA = await f.store.add({ type: "newapi", baseUrl: "https://same.test", accessToken: "unknown-valid-A" });
  const unknownB = await f.store.add({ type: "newapi", baseUrl: "https://same.test", accessToken: "unknown-valid-B" });
  const input = { ...f.input, targetStationIds: [f.ids.a1, unknownA.id, unknownB.id] }, requests = f.state.requests.length, commits = f.state.commits;
  const probe = await (await f.http("probeAccountAuthorization", input)).json();
  assert.deepEqual(probe.targets.map((target) => target.stationId), [f.ids.a1, unknownA.id]);
  assert.deepEqual(probe.excluded.map((target) => target.stationId), [unknownB.id]);
  assert.equal(f.state.requests.length - requests, 3, "one replacement plus two unknown current credentials; known expired credential is not required");
  assert.equal(unknownA.verifiedIdentity, null); assert.equal(f.state.commits, commits);
  const updated = await (await f.http("updateAccountAuthorization", { ...input, previewId: probe.previewId })).json();
  assert.equal(updated.complete, false); assert.deepEqual(updated.targets.map((target) => target.status), ["updated", "updated", "failed"]);
  assert.equal(f.store.get(unknownA.id).verifiedIdentity.accountId, "42"); assert.equal(f.store.get(unknownB.id).verifiedIdentity, null);
});

test("U04 public原资源、source、link、rule版本变化拒绝旧预览且零授权写入", async (t) => {
  for (const change of ["resource", "source", "link", "rule"]) await t.test(change, async (child) => {
    const f = await authorizationFixture(child), probe = await (await f.http("probeAccountAuthorization", f.input)).json();
    if (change === "resource") await f.store.update(f.ids.a2, { monitorEnabled: false });
    if (change === "source") await f.store.update(f.ids.own, { accessToken: "rotated-own-A" });
    if (change === "link") f.state.links.push({ own_station_id: f.ids.own, channel_id: 2, station_id: f.ids.a1, channel_revision: "revision-2", confirmed_at_ms: 2 });
    if (change === "rule") f.state.rules[0].scope_version += 1;
    const before = structuredClone(f.store.data), commits = f.state.commits;
    const result = await (await f.http("updateAccountAuthorization", { ...f.input, previewId: probe.previewId })).json();
    assert.equal(result.complete, false); assert.equal(result.targets.length, 3);
    assert.ok(result.targets.every((target) => target.status === "repreview_required"));
    assert.ok(result.targets.every((target) => ["RESOURCE_CHANGED", "PREVIEW_BASIS_CHANGED"].includes(target.code)));
    assert.deepEqual(f.store.data, before); assert.equal(f.state.commits, commits);
  });
});

test("U04 public实际Store SQL后预览失效rollback，之前成功目标保留且未保存目标版本不提升", async (t) => {
  const f = await authorizationFixture(t), probe = await (await f.http("probeAccountAuthorization", f.input)).json();
  f.state.sqlHook = (sql) => { if (sql.startsWith("INSERT INTO stations") && f.state.commits === 1) f.state.now = probe.expiresAtMs; };
  const result = await (await f.http("updateAccountAuthorization", { ...f.input, previewId: probe.previewId })).json();
  assert.equal(result.complete, false); assert.deepEqual(result.targets.map((target) => target.status), ["updated", "repreview_required", "repreview_required"]);
  assert.equal(result.targets[1].code, "PREVIEW_BASIS_CHANGED"); assert.equal(f.state.rollbacks, 1); assert.equal(f.state.commits, 1);
  for (const id of [f.ids.a2, f.ids.billing]) {
    assert.equal(f.store.get(id).authVersion, 1); assert.equal(f.store.get(id).authorizationUpdateRef, undefined);
    assert.equal(f.state.docs.find((doc) => doc.id === id).accessToken, `${id}-A`);
  }
  assert.equal(f.store.get(f.ids.a1).authVersion, 2);
  f.state.sqlHook = null; await f.restart(); const requests = f.state.requests.length, commits = f.state.commits;
  const recovered = await (await f.http("recoverAccountAuthorization", probe.retryInput)).json();
  assert.deepEqual(recovered.targets.map((target) => target.status), ["already_updated", "repreview_required", "repreview_required"]);
  assert.equal(f.state.requests.length, requests); assert.equal(f.state.commits, commits);
});

test("U04 public JWT→密码→JWT清理hidden凭据，临时JWT续期不推进authVersion或泄漏返回", async (t) => {
  const f = await authorizationFixture(t, "sub2api"), before = structuredClone({ rules: f.state.rules, links: f.state.links, history: f.state.history });
  const passwordInput = { ...f.input, requestId: "password-rotation", authorization: { type: "sub2api-password", baseUrl: "https://same.test", email: "a@example.test", password: "replacement-password-A" } };
  const probe = await (await f.http("probeAccountAuthorization", passwordInput)).json();
  const result = await (await f.http("updateAccountAuthorization", { ...passwordInput, previewId: probe.previewId })).json();
  assert.equal(result.complete, true, JSON.stringify(result));
  for (const id of f.input.targetStationIds) {
    const station = f.store.get(id); assert.equal(station.type, "sub2api-password"); assert.equal(station.accessToken, "");
    assert.equal(station.password, "replacement-password-A"); assert.equal(station.s2Tokens, null); assert.equal(station.authVersion, 2);
  }
  const station = f.store.get(f.ids.a1), resourceVersion = stationBusinessVersion(station);
  await queryAccountIdentity(station); const generated = f.state.generated; f.state.now += 7200000; await queryAccountIdentity(station);
  assert.ok(f.state.generated > generated); assert.equal(station.authVersion, 2); assert.equal(stationBusinessVersion(station), resourceVersion);
  const recovered = await (await f.http("recoverAccountAuthorization", probe.retryInput)).json(); assert.equal(recovered.complete, true);
  const jwtInput = { ...f.input, requestId: "jwt-rotation", authorization: { type: "sub2api", baseUrl: "https://same.test", accessToken: "replacement-JWT-A" } };
  const jwtProbe = await (await f.http("probeAccountAuthorization", jwtInput)).json();
  const jwtResult = await (await f.http("updateAccountAuthorization", { ...jwtInput, previewId: jwtProbe.previewId })).json(); assert.equal(jwtResult.complete, true);
  for (const id of f.input.targetStationIds) {
    const saved = f.store.get(id); assert.equal(saved.type, "sub2api"); assert.equal(saved.email, ""); assert.equal(saved.password, "");
    assert.equal(saved.s2Tokens, null); assert.equal(saved.accessToken, "replacement-JWT-A"); assert.equal(saved.authVersion, 3);
  }
  assert.deepEqual({ rules: f.state.rules, links: f.state.links, history: f.state.history }, before);
  assert.doesNotMatch(JSON.stringify([probe, result, recovered, jwtProbe, jwtResult]), /generated-access|generated-refresh|replacement-password|replacement-JWT|authorizationUpdateRef|s2Tokens/);
});

test("U04 public无donor要求新输入，失效donor不能复用，同operation改凭据即使重启也拒绝", async (t) => {
  const f = await authorizationFixture(t), single = { ...f.input, targetStationIds: [f.ids.a1] };
  const probe = await (await f.http("probeAccountAuthorization", single)).json(); f.state.failStationId = f.ids.a1;
  const failed = await (await f.http("updateAccountAuthorization", { ...single, previewId: probe.previewId })).json(); assert.equal(failed.complete, false);
  await f.restart(); const recovered = await (await f.http("recoverAccountAuthorization", probe.retryInput)).json();
  assert.deepEqual(recovered.targets[0].remainingActions, ["supply_credentials", "repreview"]);
  const noDonor = await f.http("probeAccountAuthorization", { ...probe.retryInput, reuseSavedAuthorization: true });
  assert.equal((await noDonor.json()).code, "SAVED_AUTHORIZATION_UNAVAILABLE");
  f.state.failStationId = null;
  const fresh = await (await f.http("probeAccountAuthorization", single)).json();
  assert.equal((await (await f.http("updateAccountAuthorization", { ...single, previewId: fresh.previewId })).json()).complete, true);
  await f.restart();
  const changed = await f.http("updateAccountAuthorization", { ...single, authorization: { ...single.authorization, accessToken: "changed-A" }, previewId: fresh.previewId });
  assert.equal((await changed.json()).code, "OPERATION_CHANGED");
  await f.store.update(f.ids.a1, { accessToken: "ordinary-edit-A" }); assert.equal(f.store.get(f.ids.a1).authorizationUpdateRef, null);
  const invalidated = await (await f.http("recoverAccountAuthorization", fresh.retryInput)).json();
  assert.equal(invalidated.complete, false); assert.deepEqual(invalidated.targets[0].remainingActions, ["supply_credentials", "repreview"]);
  const reuse = await f.http("probeAccountAuthorization", { ...fresh.retryInput, reuseSavedAuthorization: true });
  assert.equal((await reuse.json()).code, "SAVED_AUTHORIZATION_UNAVAILABLE");
});

test("U04 public readonly恢复只证明已保存结果，过期donor在新的probe实际核验失败且不泄漏授权", async (t) => {
  const f = await authorizationFixture(t), input = { ...f.input, targetStationIds: [f.ids.a1, f.ids.a2] };
  const probe = await (await f.http("probeAccountAuthorization", input)).json(); f.state.failStationId = f.ids.a2;
  const partial = await (await f.http("updateAccountAuthorization", { ...input, previewId: probe.previewId })).json(); assert.equal(partial.complete, false);
  await f.restart(); f.state.deniedTokens = ["replacement-A"];
  const requests = f.state.requests.length, commits = f.state.commits;
  const recovered = await (await f.http("recoverAccountAuthorization", probe.retryInput)).json();
  assert.deepEqual(recovered.targets.map((target) => target.status), ["already_updated", "repreview_required"]);
  assert.equal(f.state.requests.length, requests); assert.equal(f.state.commits, commits);
  const rejected = await f.http("probeAccountAuthorization", { ...probe.retryInput, reuseSavedAuthorization: true });
  assert.equal(rejected.status, 400); const error = await rejected.json(); assert.equal(error.code, "AUTHORIZATION_UNVERIFIED");
  assert.doesNotMatch(JSON.stringify(error), /replacement-A/); assert.ok(f.state.requests.length > requests); assert.equal(f.state.commits, commits);
  assert.equal(f.store.get(f.ids.a2).authorizationUpdateRef, undefined);
});

test("U04 ordinary monitor暂停走实际PUT/CAS，仅停监控估算且保留bill/scope/date/link/history与own用途", async (t) => {
  const f = await authorizationFixture(t), before = structuredClone({ rules: f.state.rules, links: f.state.links, history: f.state.history });
  const station = f.store.get(f.ids.a1), ownVersion = stationBusinessVersion(f.store.get(f.ids.own)), authVersion = station.authVersion;
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return next(url, context);
  } });
  let PUT; try { ({ PUT } = await import("../app/api/stations/[id]/route.js")); } finally { hooks.deregister(); }
  const response = await PUT(new Request("https://local.test/api/stations/one", { method: "PUT", body: JSON.stringify({ monitorEnabled: false,
    expectedAuthVersion: authVersion, expectedResourceVersion: stationBusinessVersion(station) }) }), f.rt, { id: station.id });
  assert.equal(response.status, 200); assert.equal(station.monitorEnabled, false); assert.equal(station.includeInProfit, false);
  assert.equal(station.authVersion, authVersion); assert.equal(station.isOwn, false);
  assert.deepEqual({ rules: f.state.rules, links: f.state.links, history: f.state.history }, before);
  assert.equal(f.state.rules[0].enabled, true); assert.equal(stationBusinessVersion(f.store.get(f.ids.own)), ownVersion);
  const preview = await (await f.http("probeAccountAuthorization", f.input)).json();
  assert.deepEqual(preview.impact.monitorStationIds, [f.ids.a2]); assert.deepEqual(preview.impact.billingRuleIds, ["rule_u04"]);
  assert.equal(preview.targets[0].purposes.monitor, false); assert.equal(preview.targets[2].purposes.monitor, false);
  const stale = await PUT(new Request("https://local.test/api/stations/one", { method: "PUT", body: JSON.stringify({ monitorEnabled: true,
    expectedResourceVersion: "old-version" }) }), f.rt, { id: station.id }); assert.equal(stale.status, 400);
  assert.equal(station.monitorEnabled, false); assert.deepEqual(f.state.rules, before.rules);
});

test("U03 actual Store本地全量账号视图同域A/B分离，两old monitor与dedicated保持ID，纯Key/unknown不借关联推断身份", async (t) => {
  const f = await accountReadFixture(t), before = structuredClone(f.store.data), model = await f.rt.channelOnboarding.listAccounts();
  assert.equal(model.accounts.length, 2); const a = model.accounts.find((account) => account.identity.accountId === "A"), b = model.accounts.find((account) => account.identity.accountId === "B");
  assert.notEqual(a.accountKey, b.accountKey); assert.equal(a.siteKey, b.siteKey);
  assert.equal(a.accountKey, createHash("sha256").update(JSON.stringify(["newapi", "https://same.test", "A"])).digest("hex"));
  assert.deepEqual(a.resources.map((resource) => resource.id), ["A-archived", "A-billing", "A-monitor-1", "A-monitor-2"]);
  const dedicated = a.resources.find((resource) => resource.id === "A-billing"); assert.equal(dedicated.monitorEnabled, false);
  assert.deepEqual(dedicated.purposes, { monitor: false, billingRuleIds: ["A-active"] });
  const monitor = a.resources.find((resource) => resource.id === "A-monitor-1"); assert.equal(monitor.lowBalanceUsd, 27);
  assert.equal(monitor.cnyPerUsd, 0.7); assert.equal(monitor.includeInProfit, false); assert.equal(monitor.noRenewal, true);
  assert.equal(monitor.resourceVersion, stationBusinessVersion(f.a1)); assert.equal(monitor.authVersion, 1);
  assert.equal(monitor.balance.remaining, 10); assert.equal(monitor.balance.account, null);
  assert.doesNotMatch(JSON.stringify(model), /A-monitor-1-pat|old-access|old-refresh|private-|independent-key|s2Tokens|alertState|onboardingOrigin|authorizationUpdateRef/);
  assert.deepEqual(model.unverifiedResources.map((resource) => resource.id), ["pure-key", "unknown-legacy"]);
  assert.ok(model.unverifiedResources.every((resource) => resource.identity === null && resource.verification === "unverified"));
  assert.deepEqual(model.channels[0].monitor.stationIds, ["A-monitor-1", "A-monitor-2", "pure-key"]);
  assert.ok(!model.accounts.flatMap((account) => account.resources).some((resource) => resource.id === "own"));
  assert.ok(!("balance" in a)); assert.deepEqual(f.store.data, before); assert.equal(f.writes(), 0);
  const key = a.keys.find((item) => item.tokenId === 9); assert.deepEqual(key.ruleIds, ["A-active", "A-history"]);
  assert.deepEqual(key.activeRuleIds, ["A-active"]); assert.deepEqual(key.channels.map((channel) => channel.channelId), [1, 3]);
  assert.equal(key.scopeVersion, 3); assert.equal(key.billingEffectiveFromMs, Date.parse("2026-10-09T16:00:00Z"));
  assert.equal(key.firstQueryableAtMs, Date.parse("2026-10-10T16:00:00Z")); assert.equal(key.scopeAmbiguous, false);
  const kinds = new Set(model.actions.map((action) => action.kind));
  for (const kind of ["update_authorization", "inspect_balance", "verify_identity", "connect_channels", "confirm_coverage", "wait_effective", "review_source"]) assert.ok(kinds.has(kind), kind);
  for (const item of model.actions) {
    const href = new URL(item.href, "https://local.test");
    assert.ok(["/stations", "/reconciliation"].includes(href.pathname)); assert.ok(item.id && item.label); assert.equal(item.window, null);
    if (item.stationId) assert.ok(f.store.get(item.stationId)); if (item.ruleId) assert.ok(f.state.rules.some((rule) => rule.id === item.ruleId));
    assert.notEqual(item.stationId, "own");
  }
  assert.deepEqual((await f.rt.channelOnboarding.listAccounts()).actions, model.actions);
  monitor.balance.remaining = 999; key.channels[0].ownSource.accountId = "changed";
  assert.equal(f.a1.balance.remaining, 10); assert.equal(f.state.rules[0].ownSource.accountId, "1");
});

test("U03 public历史关系保留，0active标历史，多active口径冲突不制造统一scope，未知legacy不伪造canonicalKey", async (t) => {
  const f = await accountReadFixture(t);
  f.state.rules.push(f.rule("A-conflict", f.a1, 9, [2], { scopeVersion: 4, costCoverage: "complete", coverageDeclaration: { answer: "none" }, timezone: "UTC" }),
    f.rule("A-legacy", f.a2, 11, [1], { canonicalKey: null }),
    f.rule("A-old-identity", f.a2, 12, [3], { canonicalKey: canonicalBillingKey(f.b, f.b.verifiedIdentity, 12) }));
  const model = await f.rt.channelOnboarding.listAccounts(), a = model.accounts.find((account) => account.identity.accountId === "A");
  const key = a.keys.find((item) => item.tokenId === 9); assert.deepEqual(key.activeRuleIds, ["A-active", "A-conflict"]);
  assert.equal(key.scopeAmbiguous, true); assert.equal(key.costCoverage, "unknown"); assert.equal(key.scopeVersion, null);
  assert.equal(key.billingEffectiveFromMs, null); assert.equal(key.firstQueryableAtMs, null); assert.equal(key.coverageDeclaration.answer, "unknown");
  assert.ok(!a.actions.some((action) => action.kind === "wait_effective" && ["A-active", "A-conflict"].includes(action.ruleId)));
  const stopped = a.keys.find((item) => item.tokenId === 10); assert.deepEqual(stopped.activeRuleIds, []); assert.equal(stopped.scopeAmbiguous, false);
  assert.ok(!a.actions.some((action) => ["confirm_coverage", "wait_effective"].includes(action.kind) && action.ruleId === "A-stopped"));
  assert.deepEqual(a.resources.find((resource) => resource.id === f.a2.id).purposes.billingRuleIds, ["A-legacy", "A-old-identity", "A-stopped"]);
  assert.ok(!a.keys.some((item) => [11, 12].includes(item.tokenId)));
  assert.deepEqual(a.actions.filter((action) => action.kind === "verify_capability").map((action) => action.ruleId).sort(), ["A-legacy", "A-old-identity"]);
  assert.deepEqual(model.channels.find((channel) => channel.id === 3).reconciliation.ruleIds, ["A-history", "A-old-identity"]);
  f.state.rules = f.state.rules.filter((rule) => rule.id !== "A-conflict");
  f.state.rules.push(f.rule("A-membership-conflict", f.a1, 9, [2]));
  const membership = (await f.rt.channelOnboarding.listAccounts()).accounts.find((account) => account.identity.accountId === "A").keys.find((item) => item.tokenId === 9);
  assert.equal(membership.scopeAmbiguous, true, "equal scope version/policy still cannot unify different channel sets");
  assert.equal(membership.scopeVersion, null);
  assert.equal(f.writes(), 0);
});

test("U03 actual Repository全量入口保留archived/disabled关系；Store真实改PAT后旧身份作废，JWT自动续期不影响账号版本", async (t) => {
  const f = await accountReadFixture(t), statements = [];
  const pool = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes("FROM reconciliation_rule_channels")) return [f.state.rules.flatMap((rule) => rule.channels.map((channel) =>
      ({ rule_id: rule.id, channel_id: channel.channelId, channel_name: channel.name })))];
    assert.ok(sql.includes("FROM reconciliation_rules"));
    const rules = sql.includes("WHERE archived_at IS NULL") ? f.state.rules.filter((rule) => !rule.archivedAt) : f.state.rules;
    return [rules.map((rule) => ({ id: rule.id, upstream_station_id: rule.upstreamStationId, own_station_id: rule.ownStationId, token_id: rule.tokenId,
      token_name: rule.tokenName, timezone: rule.timezone, enabled: rule.enabled, billing_policy: "next-complete-day", scope_version: rule.scopeVersion,
      billing_effective_from_ms: rule.billingEffectiveFrom, cost_coverage: rule.costCoverage, provider: rule.provider, canonical_key: rule.canonicalKey,
      source_binding: { version: 2, channels: rule.sourceBinding, ownSource: rule.ownSource, coverageDeclaration: rule.coverageDeclaration }, archived_at: rule.archivedAt }))];
  } };
  f.rt.reconciliation = createReconciliationModule({ store: f.store, pool });
  let model = await f.rt.channelOnboarding.listAccounts(), a = model.accounts.find((account) => account.identity.accountId === "A");
  assert.ok(statements.some((sql) => sql.includes("FROM reconciliation_rules") && !sql.includes("WHERE archived_at")));
  assert.ok(statements.every((sql) => sql.trim().startsWith("SELECT")));
  assert.deepEqual(a.keys.find((key) => key.tokenId === 9).ruleIds, ["A-active", "A-history"]);
  assert.deepEqual(a.keys.find((key) => key.tokenId === 10).activeRuleIds, []); assert.equal(f.writes(), 0);
  const oldVersion = stationBusinessVersion(f.a1); f.a1.s2Tokens = { accessToken: "automatic-jwt", refreshToken: "automatic-refresh" };
  assert.equal(stationBusinessVersion(f.a1), oldVersion);
  await f.store.update(f.a1.id, { accessToken: "replacement-pat" });
  model = await f.rt.channelOnboarding.listAccounts();
  const resource = model.unverifiedResources.find((item) => item.id === f.a1.id);
  assert.equal(resource.authVersion, 2); assert.notEqual(resource.resourceVersion, oldVersion); assert.equal(resource.identity, null);
  assert.ok(!model.accounts.flatMap((account) => account.resources).some((item) => item.id === f.a1.id));
  const subIdentity = { provider: "sub2api", baseUrl: "https://same.test", accountId: "A" };
  await f.store.add({ type: "sub2api", baseUrl: "https://same.test/", accessToken: "sub-jwt" }, { verifiedIdentity: subIdentity });
  await f.store.add({ type: "sub2api-password", baseUrl: "https://same.test", email: "sub@example.test", password: "sub-password" }, { verifiedIdentity: subIdentity });
  model = await f.rt.channelOnboarding.listAccounts(); const sub = model.accounts.find((account) => account.identity.provider === "sub2api");
  assert.equal(sub.resources.length, 2); assert.notEqual(sub.accountKey, a.accountKey); assert.notEqual(sub.siteKey, a.siteKey);
  assert.doesNotMatch(JSON.stringify(model), /replacement-pat|sub-jwt|sub-password|sub@example/);
});

async function genuineBatchFixture(t) {
  const state = { now: Date.parse("2026-10-09T07:00:00Z"), rules: [], members: [], created: 0, ruleWrites: 0,
    catalogue: null, links: [], linkGate: null, failLinks: false, failRuleKey: null, requests: [], requestHook: null,
    channels: Array.from({ length: 10 }, (_, index) => index + 1) };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input);
    state.requests.push({ host: url.host, path: url.pathname, authorization: options.headers?.Authorization });
    await state.requestHook?.(url, options);
    if (url.pathname.endsWith("/dashboard/billing/subscription")) return { status: 200, text: async () => JSON.stringify({ hard_limit_usd: 100 }) };
    if (url.pathname.endsWith("/dashboard/billing/usage")) return { status: 200, text: async () => JSON.stringify({ total_usage: 1 }) };
    const data = url.pathname === "/api/user/self" ? { id: url.host === "own.test" ? 1 : 42, quota: 100, used_quota: 1 }
      : url.pathname === "/api/status" ? { quota_per_unit: 100 }
        : url.pathname === "/api/user/self/groups" ? { g1: { ratio: 1 } }
          : url.pathname === "/api/token/" ? { total: 2, items: [9, 10].map((id) => ({ id, name: `Key ${id}`, status: 1, group: "g1", cross_group_retry: false })) }
            : url.pathname === "/api/channel/" ? { total: state.channels.length, items: state.channels.map((id) => ({ id, name: `Channel ${id}`,
              type: 1, status: 1, base_url: "https://up.test", group: "g1" })) } : { quota: 100 };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const read = (sql, params = [], draft = state) => {
    if (sql.includes("JOIN reconciliation_rule_channels")) return [draft.members.filter((member) => params[0].includes(member.channel_id)
      && member.rule_id !== params[1] && draft.rules.find((rule) => rule.id === member.rule_id)?.enabled)
      .map((member) => ({ id: member.rule_id, channel_id: member.channel_id, token_name: "Key" }))];
    if (sql.includes("FROM reconciliation_rule_channels")) return [draft.members.filter((member) => (Array.isArray(params[0]) ? params[0] : [params[0]]).includes(member.rule_id))];
    if (sql.includes("FROM reconciliation_rules")) return [params.length ? draft.rules.filter((rule) => rule.id === params[0]) : draft.rules.filter((rule) => !rule.archived_at)];
    return [[]];
  };
  const pool = { query: async (...args) => read(...args), getConnection: async () => {
    let draft;
    return { beginTransaction: async () => { draft = structuredClone({ rules: state.rules, members: state.members }); },
      async query(sql, params = []) {
        if (sql.startsWith("SELECT")) return read(sql, params, draft);
        if (sql.startsWith("INSERT INTO reconciliation_rules")) {
          if (params[3] === state.failRuleKey) throw new Error("rule save failed");
          const [id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, timezone, enabled, active_token_key,
            billing_policy, scope_version, billing_effective_from_ms, cost_coverage, provider, canonical_key, source_binding] = params;
          draft.rules.push({ id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, timezone, enabled, active_token_key,
            billing_policy, scope_version, billing_effective_from_ms, cost_coverage, provider, canonical_key, source_binding });
          state.created += 1; state.ruleWrites += 1;
        } else if (sql.startsWith("UPDATE reconciliation_rules")) {
          const rule = draft.rules.find((item) => item.id === params[15]);
          [rule.upstream_station_id, rule.own_station_id, rule.token_id, rule.token_name, rule.fixed_group, rule.timezone, rule.enabled,
            rule.active_token_key, rule.billing_policy, rule.scope_version, rule.billing_effective_from_ms, rule.cost_coverage,
            rule.provider, rule.canonical_key, rule.source_binding] = params;
          state.ruleWrites += 1;
        } else if (sql.startsWith("DELETE FROM reconciliation_rule_channels")) draft.members = draft.members.filter((member) => member.rule_id !== params[0]);
        else if (sql.startsWith("INSERT INTO reconciliation_rule_channels")) draft.members.push(...params[0].map(([rule_id, channel_id, channel_name, active_channel_key]) =>
          ({ rule_id, channel_id, channel_name, active_channel_key })));
        return [{ affectedRows: 1 }];
      }, commit: async () => { state.rules = draft.rules; state.members = draft.members; }, rollback: async () => {}, release() {} };
  } };
  const storePool = { getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[]], commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new Store(storePool), own = await store.add({ type: "newapi", baseUrl: "https://own.test", accessToken: "admin", isOwn: true });
  const supplier = await store.add({ name: "Existing", type: "newapi", baseUrl: "https://up.test", accessToken: "pat", lowBalanceUsd: 20 });
  const repository = { getCatalogue: async () => state.catalogue, listLinks: async () => structuredClone(state.links),
    saveCatalogue: async (value) => { state.catalogue = structuredClone(value); },
    async saveLinks(values, { guard } = {}) {
      guard?.(); await state.linkGate?.(values); guard?.();
      if (state.failLinks) throw new Error("link save failed");
      const replaced = new Set(values.map((value) => JSON.stringify([value.ownStationId, value.channelId, value.stationId])));
      state.links = [...state.links.filter((value) => !replaced.has(JSON.stringify([value.ownStationId, value.channelId, value.stationId]))), ...structuredClone(values)];
      return structuredClone(values);
    } };
  const rt = { pool, store };
  async function restart() {
    rt.reconciliation = createReconciliationModule(rt);
    rt.channelOnboarding = rt.onboardingSource = await createChannelOnboardingModule(rt, { repository, now: () => state.now, refresh: async () => {} }).load();
  }
  await restart(); await rt.channelOnboarding.sync();
  const request = (groups = [[1, 2, 3, 4, 5]], keys = [9]) => ({ requestId: "4a102bfe-f680-4ad8-92ac-26e732b07c9b", ownStationId: own.id,
    selections: [{ selectionId: "account", stationId: supplier.id, monitor: true }],
    groups: groups.map((ids, index) => ({ groupId: `group-${index + 1}`, selectionId: "account", channels: ids.map((channelId) => ({ channelId,
      channelRevision: rt.channelOnboarding.getSourceCatalogue().channels.find((channel) => channel.id === channelId).revision })),
    reconciliation: { tokenId: keys[index] || 9, coverageDeclaration: { answer: "none" } } })) });
  return { state, rt, store, own, supplier, request, restart };
}

async function ruleEditRoutes() {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status=200) => Response.json(value, {status});" };
    return next(url, context);
  } });
  try {
    const { POST } = await import("../app/api/reconciliation/rules/[id]/preview/route.js");
    const { PUT } = await import("../app/api/reconciliation/rules/[id]/route.js");
    return { POST, PUT };
  } finally { hooks.deregister(); }
}

test("genuine HTTP batch既有账号五渠道零凭据只建一个Key scope，probe无写，重启恢复不依赖返回ID", async (t) => {
  const f = await genuineBatchFixture(t), input = f.request([[1], [2], [3], [4], [5]]);
  const before = structuredClone(f.store.data);
  const req = (body) => new Request("http://local/api/channel-onboarding/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const probe = await (await handleChannelOnboardingRequest(req(input), f.rt, "probeBatch")).json();
  assert.equal(probe.groups.length, 1); assert.deepEqual(probe.groups[0].requestedGroupIds, ["group-1", "group-2", "group-3", "group-4", "group-5"]);
  assert.deepEqual(probe.groups[0].basis.proposedChannelIds, [1, 2, 3, 4, 5]); assert.equal(probe.groups[0].status, "ready");
  assert.deepEqual(f.store.data, before); assert.equal(f.state.ruleWrites, 0); assert.deepEqual(f.state.links, []);
  const response = await handleChannelOnboardingRequest(req({ ...input, previewId: probe.previewId }), f.rt, "connectBatch");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.groups.length, 1);
  assert.equal(f.state.created, 1); assert.equal(f.state.ruleWrites, 1); assert.equal(f.store.list().length, 2);
  assert.equal(result.groups[0].saved.scopeVersion, 1); assert.equal(result.groups[0].channels.length, 5); assert.equal(f.state.links.length, 5);
  const saved = result.groups[0].saved;
  f.state.now += 24 * 3600000;
  await f.restart(); await f.rt.channelOnboarding.sync();
  const recovered = await (await handleChannelOnboardingRequest(req(probe.retryInput), f.rt, "recoverBatch")).json();
  assert.equal(recovered.complete, true, JSON.stringify(recovered)); assert.equal(recovered.groups[0].saved.ruleId, saved.ruleId);
  assert.equal(recovered.groups[0].saved.billingEffectiveFromMs, saved.billingEffectiveFromMs); assert.equal(f.state.ruleWrites, 1);
  const repeated = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(repeated.complete, true); assert.equal(f.state.ruleWrites, 1); assert.equal(f.store.list().length, 2);
  assert.doesNotMatch(JSON.stringify([probe, result, recovered]), /"(?:accessToken|apiKey|password|s2Tokens|onboardingOrigin)"/);
});

test("genuine batch多个新选择同实际账号同Key合并只保存一个资源和一个scope", async (t) => {
  const f = await genuineBatchFixture(t);
  await f.store.archive(f.supplier.id);
  const input = f.request([[1], [2], [3], [4], [5]]);
  input.selections = input.groups.map((group, index) => ({ selectionId: `new-${index}`, monitor: true,
    newStation: { type: "newapi", baseUrl: "https://up.test", accessToken: "new-pat" } }));
  input.groups.forEach((group, index) => { group.selectionId = `new-${index}`; });
  const probe = await f.rt.channelOnboarding.probeBatch(input);
  assert.equal(probe.groups.length, 1);
  const result = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(f.store.list().length, 2); assert.equal(result.groups[0].saved.stationIds.length, 1);
  assert.equal(f.state.ruleWrites, 1); assert.equal(f.state.links.length, 5);
  assert.equal((await f.rt.channelOnboarding.recoverBatch(probe.retryInput)).complete, true);
});

test("genuine batch一次追加完整existing加new union，scope只推进一次，重复确认保留日期", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2, 3]]);
  const firstProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: firstProbe.previewId });
  const input = f.request([[4], [5], [6], [7], [8]]), probe = await f.rt.channelOnboarding.probeBatch(input);
  assert.deepEqual(probe.groups[0].basis.existingChannelIds, [1, 2, 3]);
  assert.deepEqual(probe.groups[0].basis.proposedChannelIds, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(f.state.ruleWrites, 1);
  const result = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.groups[0].saved.ruleId, first.groups[0].saved.ruleId);
  assert.equal(result.groups[0].saved.scopeVersion, 2); assert.equal(f.state.ruleWrites, 2);
  assert.equal(f.state.members.length, 8);
  f.state.now += 24 * 3600000; await f.rt.channelOnboarding.sync();
  const repeat = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(repeat.complete, true); assert.equal(f.state.ruleWrites, 2);
  assert.equal(repeat.groups[0].saved.billingEffectiveFromMs, result.groups[0].saved.billingEffectiveFromMs);
});

test("genuine batch两Key部分规则失败保留全部组渠道与savedIDs，restart后只补缺项", async (t) => {
  const f = await genuineBatchFixture(t), input = f.request([[1, 2], [3, 4]], [9, 10]);
  const probe = await f.rt.channelOnboarding.probeBatch(input); f.state.failRuleKey = 10;
  const result = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(result.complete, false); assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].complete, true); assert.equal(result.groups[1].complete, false);
  assert.deepEqual(result.groups.map((group) => group.channels.map((channel) => channel.channelId)), [[1, 2], [3, 4]]);
  assert.deepEqual(result.groups[1].saved.stationIds, [f.supplier.id]); assert.equal(result.groups[1].monitor.status, "linked");
  const first = result.groups[0].saved;
  await f.restart(); f.state.failRuleKey = null;
  const recovered = await f.rt.channelOnboarding.recoverBatch(probe.retryInput);
  assert.equal(recovered.groups[0].complete, true); assert.equal(recovered.groups[1].complete, false);
  const fresh = await f.rt.channelOnboarding.probeBatch(input);
  const done = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: fresh.previewId });
  assert.equal(done.complete, true, JSON.stringify(done)); assert.equal(f.state.ruleWrites, 2);
  assert.equal(done.groups[0].saved.scopeVersion, first.scopeVersion);
  assert.equal(done.groups[0].saved.billingEffectiveFromMs, first.billingEffectiveFromMs);
  assert.equal(f.store.list().length, 2); assert.equal(f.state.links.length, 4);
});

test("genuine public recover既有关系不能证明失败或response-loss后的同账号PAT更新", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1]]);
  const initialProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: initialProbe.previewId });
  const input = f.request([[1]]);
  input.selections = [{ selectionId: "account", monitor: true, updateCredentials: true,
    newStation: { type: "newapi", baseUrl: "https://up.test", accessToken: "replacement-pat" } }];
  const probe = await f.rt.channelOnboarding.probeBatch(input);
  assert.equal(probe.retryInput.selections[0].credentialUpdateRequested, true);
  const oldUpdate = f.store.updateLocked.bind(f.store);
  const mocked = t.mock.method(f.store, "updateLocked", async () => { throw new Error("store save failed"); });
  const failed = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(failed.complete, false); assert.deepEqual(failed.groups[0].saved.stationIds, [f.supplier.id]);
  assert.ok(failed.groups[0].remainingActions.includes("repreview")); assert.equal(f.supplier.accessToken, "pat");
  mocked.mock.restore();
  const before = structuredClone(f.store.data);
  const recoveredFailure = await f.rt.channelOnboarding.recoverBatch(probe.retryInput);
  assert.equal(recoveredFailure.complete, false); assert.equal(recoveredFailure.groups[0].code, "CREDENTIAL_UPDATE_UNCONFIRMED");
  assert.equal(recoveredFailure.groups[0].reconciliation.status, "configured");
  assert.deepEqual(f.store.data, before); assert.deepEqual(recoveredFailure.groups[0].saved.stationIds, [f.supplier.id]);
  const completed = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(completed.complete, true, JSON.stringify(completed)); assert.equal(f.supplier.accessToken, "replacement-pat");
  assert.equal(completed.groups[0].saved.scopeVersion, first.groups[0].saved.scopeVersion);
  assert.equal(completed.groups[0].saved.billingEffectiveFromMs, first.groups[0].saved.billingEffectiveFromMs);
  assert.equal((await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId })).complete, true);
  await f.restart();
  const req = new Request("http://local/api/channel-onboarding/batch/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(probe.retryInput) });
  const recoveredLostResponse = await (await handleChannelOnboardingRequest(req, f.rt, "recoverBatch")).json();
  assert.equal(recoveredLostResponse.complete, false); assert.equal(recoveredLostResponse.groups[0].code, "CREDENTIAL_UPDATE_UNCONFIRMED");
  assert.equal(recoveredLostResponse.groups[0].saved.ruleId, first.groups[0].saved.ruleId);
  const fresh = await f.rt.channelOnboarding.probeBatch(input);
  assert.equal(fresh.retryInput.selections[0].credentialUpdateRequested, false);
  t.mock.method(f.store, "updateLocked", async (...args) => { assert.fail("identical saved credentials must not be updated again"); return oldUpdate(...args); });
  const confirmed = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: fresh.previewId });
  assert.equal(confirmed.complete, true); assert.equal(f.store.list().length, 2);
  assert.equal(confirmed.groups[0].saved.scopeVersion, first.groups[0].saved.scopeVersion);
  assert.equal(confirmed.groups[0].saved.billingEffectiveFromMs, first.groups[0].saved.billingEffectiveFromMs);
});

test("genuine batch纯监控无财务proof可用，monitor false新账号维持专用用途", async (t) => {
  const f = await genuineBatchFixture(t), monitorInput = f.request([[1]]);
  monitorInput.groups[0].reconciliation = null;
  const monitor = await f.rt.channelOnboarding.connectBatch(monitorInput);
  assert.equal(monitor.complete, true); assert.equal(monitor.groups[0].reconciliation.status, "not_requested");
  assert.equal(f.state.ruleWrites, 0); assert.deepEqual(monitor.groups[0].saved.stationIds, [f.supplier.id]);
  const dedicatedInput = f.request([[2]]);
  dedicatedInput.selections = [{ selectionId: "account", monitor: false,
    newStation: { type: "newapi", baseUrl: "https://billing.test", accessToken: "billing-pat" } }];
  const probe = await f.rt.channelOnboarding.probeBatch(dedicatedInput);
  const result = await f.rt.channelOnboarding.connectBatch({ ...dedicatedInput, previewId: probe.previewId });
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.groups[0].monitor.status, "not_requested");
  assert.deepEqual(result.groups[0].saved.stationIds, []);
  const station = f.store.get(result.groups[0].saved.authorizationStationId);
  assert.equal(station.monitorEnabled, false); assert.equal(station.includeInProfit, false); assert.equal(station.isOwn, false);
  assert.equal(f.state.links.length, 1); assert.equal(f.state.ruleWrites, 1);
  assert.equal((await f.rt.channelOnboarding.recoverBatch(probe.retryInput)).complete, true);
});

test("genuine batch纯Key监控配新dedicated授权，origin只由server创建且普通改Key使旧recover失效", async (t) => {
  const f = await genuineBatchFixture(t), input = f.request([[1, 2]]);
  input.selections = [{ selectionId: "account", monitor: true,
    newStation: { type: "newapi-key", baseUrl: "https://call.test/v1", apiKey: "key-secret",
      verifiedIdentity: { provider: "newapi", accountId: "forged", baseUrl: "https://call.test" }, onboardingOrigin: { requestId: "forged" } },
    reconciliationAuthorization: { newAuthorization: { type: "newapi", baseUrl: "https://billing.test", accessToken: "billing-pat" } } }];
  const req = (body) => new Request("http://local/api/channel-onboarding/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const probe = await (await handleChannelOnboardingRequest(req(input), f.rt, "probeBatch")).json();
  const result = await (await handleChannelOnboardingRequest(req({ ...input, previewId: probe.previewId, guard: {}, markers: {} }), f.rt, "connectBatch")).json();
  assert.equal(result.complete, true, JSON.stringify(result));
  const primary = f.store.get(result.groups[0].saved.stationIds[0]), dedicated = f.store.get(result.groups[0].saved.authorizationStationId);
  assert.equal(primary.verifiedIdentity, null); assert.equal(primary.onboardingOrigin.accountKey, null);
  assert.equal(primary.onboardingOrigin.requestId, input.requestId); assert.equal(dedicated.monitorEnabled, false);
  assert.equal((await f.rt.channelOnboarding.recoverBatch(probe.retryInput)).complete, true);
  await f.store.update(primary.id, { apiKey: "replacement-key", onboardingOrigin: primary.onboardingOrigin });
  assert.equal(primary.onboardingOrigin, null);
  const recovered = await (await handleChannelOnboardingRequest(req(probe.retryInput), f.rt, "recoverBatch")).json();
  assert.equal(recovered.complete, false); assert.ok(recovered.groups[0].remainingActions.includes("verify_identity"));
  assert.equal(f.store.list({ includeUnmonitored: true }).length, 4);
});

for (const change of ["source", "primary", "additional", "purpose", "dedicated"]) {
  test(`genuine batch ${change}业务版本在取得提交锁前变化，Store/link/rule零写`, async (t) => {
    const f = await genuineBatchFixture(t), input = f.request([[1, 2]]);
    let target = f.supplier;
    if (change === "additional" || change === "dedicated") {
      target = await f.store.add({ type: "newapi", baseUrl: "https://up.test", accessToken: "second-pat",
        monitorEnabled: change !== "dedicated" });
      if (change === "additional") input.selections[0].additionalMonitorStationIds = [target.id];
      else input.selections[0].reconciliationAuthorization = { stationId: target.id };
    }
    const probe = await f.rt.channelOnboarding.probeBatch(input);
    const original = f.store.withStationLocks.bind(f.store);
    let changed = false, expected;
    t.mock.method(f.store, "withStationLocks", async (ids, write) => {
      if (!changed && ids.length > 1 && ids.includes(f.supplier.id)) {
        changed = true;
        await f.store.update(change === "source" ? f.own.id : target.id,
          change === "purpose" ? { monitorEnabled: false } : { accessToken: "changed-pat" });
        expected = structuredClone(f.store.data);
      }
      return original(ids, write);
    });
    const result = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
    assert.equal(changed, true); assert.equal(result.complete, false);
    assert.equal(result.groups[0].code, "PREVIEW_BASIS_CHANGED");
    assert.deepEqual(result.groups[0].remainingActions, ["repreview"]);
    assert.deepEqual(f.store.data, expected); assert.deepEqual(f.state.links, []); assert.equal(f.state.ruleWrites, 0);
  });
}

test("genuine batch只改第二组coverage使该组repreview，其余组成功结果仍保留", async (t) => {
  const f = await genuineBatchFixture(t), input = f.request([[1], [2]], [9, 10]);
  const probe = await f.rt.channelOnboarding.probeBatch(input);
  input.groups[1].reconciliation.coverageDeclaration = { answer: "unknown" };
  const result = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(result.complete, false); assert.equal(result.groups[0].complete, true);
  assert.equal(result.groups[1].code, "PREVIEW_BASIS_CHANGED");
  assert.deepEqual(result.groups[1].remainingActions, ["repreview"]);
  assert.deepEqual(result.groups.map((group) => group.channels.map((channel) => channel.channelId)), [[1], [2]]);
  assert.equal(f.state.ruleWrites, 1); assert.equal(f.state.links.length, 1);
});

test("genuine batch新资源ID在link保存期间持锁，后续用途编辑让金融guard拒绝原proof", async (t) => {
  const f = await genuineBatchFixture(t); await f.store.archive(f.supplier.id);
  const input = f.request([[1]]);
  input.selections = [{ selectionId: "account", monitor: true,
    newStation: { type: "newapi", baseUrl: "https://up.test", accessToken: "new-pat" } }];
  const probe = await f.rt.channelOnboarding.probeBatch(input);
  let reached, release, editing, edited = false, stationId;
  const started = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.state.linkGate = async (values) => {
    stationId = values[0].stationId;
    editing = f.store.update(stationId, { monitorEnabled: false }).then(() => { edited = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(edited, false); assert.equal(f.store.get(stationId).monitorEnabled, true);
    reached(); await gate;
  };
  const pending = f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  await started; release();
  const result = await pending; await editing;
  assert.equal(result.complete, false, JSON.stringify(result)); assert.equal(result.groups[0].code, "PREVIEW_BASIS_CHANGED", JSON.stringify(result));
  assert.equal(f.state.links.length, 1); assert.equal(f.state.ruleWrites, 0);
  assert.deepEqual(result.groups[0].saved.stationIds, [stationId]); assert.equal(f.store.get(stationId).monitorEnabled, false);
});

test("U08 genuine HTTP原preview在link失败后不重启重试，不递归资源锁且财务与来源队列可继续", async (t) => {
  for (const mode of ["account", "dedicated"]) await t.test(mode, async (child) => {
    const f = await genuineBatchFixture(child); await f.store.archive(f.supplier.id);
    const input = f.request([[1]]), settings = { lowBalanceUsd: 33, cnyPerUsd: 0.8, noRenewal: true, includeInProfit: false,
      costAliases: ["retained-new-alias"] };
    input.selections = [{ selectionId: "account", monitor: true, newStation: mode === "account"
      ? { type: "newapi", baseUrl: "https://up.test", accessToken: "new-account-pat", ...settings }
      : { type: "newapi-key", baseUrl: "https://call.test/v1", apiKey: "new-call-key", ...settings },
      ...(mode === "dedicated" ? { reconciliationAuthorization: { newAuthorization: {
        type: "newapi", baseUrl: "https://up.test", accessToken: "new-dedicated-pat" } } } : {}) }];
    if (mode === "account") input.groups[0].reconciliation = null;
    const http = (operation, body) => handleChannelOnboardingRequest(new Request("http://local/api/channel-onboarding/batch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), f.rt, operation);
    const held = new Set(), lockAttempts = [], originalLock = f.store.withStationLocks.bind(f.store);
    child.mock.method(f.store, "withStationLocks", (ids, write) => {
      const requested = [...new Set(ids.filter(Boolean))].sort();
      lockAttempts.push({ requested, overlaps: requested.filter((id) => held.has(id)) });
      return originalLock(ids, async () => {
        requested.forEach((id) => held.add(id));
        try { return await write(); } finally { requested.forEach((id) => held.delete(id)); }
      });
    });
    const bounded = async (pending) => {
      let timer;
      try { return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`retry/queue exceeded 1000ms: ${JSON.stringify(lockAttempts)}`)), 1000);
      })]); } finally { clearTimeout(timer); }
    };
    const probe = await (await http("probeBatch", input)).json(), confirmation = { ...input, previewId: probe.previewId };
    f.state.failLinks = true;
    const partial = await (await http("connectBatch", confirmation)).json();
    assert.equal(partial.complete, false); assert.equal(partial.groups[0].saved.stationIds.length, 1);
    const savedId = partial.groups[0].saved.stationIds[0], authorizationId = partial.groups[0].saved.authorizationStationId;
    const count = f.store.list({ includeUnmonitored: true, includeArchived: true }).length;
    assert.equal(count, mode === "account" ? 3 : 4); assert.deepEqual(f.state.links, []); assert.equal(f.state.ruleWrites, 0);
    assert.ok(lockAttempts.some((attempt) => attempt.requested.includes(savedId)), "first-published monitor is held for links");
    if (mode === "dedicated") {
      assert.ok(authorizationId); assert.notEqual(authorizationId, savedId);
      assert.ok(lockAttempts.some((attempt) => attempt.requested.includes(authorizationId)), "first-published dedicated authorization is held for links");
    }
    f.state.failLinks = false;
    const response = await bounded(http("connectBatch", confirmation)); assert.equal(response.status, 200);
    const completed = await response.json(); assert.equal(completed.complete, true, JSON.stringify(completed));
    assert.deepEqual(completed.groups[0].saved.stationIds, [savedId]); assert.equal(f.state.links.length, 1);
    assert.equal(f.store.list({ includeUnmonitored: true, includeArchived: true }).length, count);
    assert.equal(f.store.get(savedId).monitorEnabled, true);
    assert.deepEqual(Object.fromEntries(Object.keys(settings).map((key) => [key, f.store.get(savedId)[key]])), settings);
    if (mode === "dedicated") {
      assert.equal(completed.groups[0].saved.authorizationStationId, authorizationId);
      assert.equal(f.store.get(authorizationId).monitorEnabled, false); assert.equal(f.store.get(authorizationId).includeInProfit, false);
      assert.equal(completed.groups[0].saved.billingEffectiveFromMs, probe.groups[0].preview.billingEffectiveFromMs);
    }
    const repeated = await (await bounded(http("connectBatch", confirmation))).json();
    assert.equal(repeated.complete, true); assert.equal(f.state.ruleWrites, mode === "account" ? 0 : 1);
    const selected = { selectionId: "account", stationId: savedId, monitor: true,
      ...(mode === "dedicated" ? { reconciliationAuthorization: { stationId: authorizationId } } : {}) };
    if (mode === "account") {
      const initialBill = f.request([[1]]); initialBill.selections = [selected];
      const initialProbe = await (await http("probeBatch", initialBill)).json();
      assert.equal((await (await bounded(http("connectBatch", { ...initialBill, previewId: initialProbe.previewId }))).json()).complete, true);
    }
    assert.equal(f.state.ruleWrites, 1); assert.equal(f.state.created, 1);
    await bounded(f.rt.channelOnboarding.sync());
    const next = f.request([[2]]); next.selections = [selected];
    const nextProbe = await (await http("probeBatch", next)).json();
    let appends = 0; const append = f.rt.reconciliation.appendChannels;
    child.mock.method(f.rt.reconciliation, "appendChannels", async (...args) => { appends += 1; return append(...args); });
    const appended = await (await bounded(http("connectBatch", { ...next, previewId: nextProbe.previewId }))).json();
    assert.equal(appended.complete, true, JSON.stringify(appended)); assert.equal(appends, 1);
    assert.equal(appended.groups[0].saved.scopeVersion, 2); assert.equal(f.state.ruleWrites, 2); assert.equal(f.state.created, 1);
    assert.deepEqual(f.state.members.map((member) => member.channel_id).sort(), [1, 2]);
    f.state.now += 24 * 3600000; await bounded(f.rt.channelOnboarding.sync());
    const later = await (await bounded(http("connectBatch", { ...next, previewId: nextProbe.previewId }))).json();
    assert.equal(later.complete, true); assert.equal(appends, 1); assert.equal(f.state.ruleWrites, 2);
    assert.equal(later.groups[0].saved.billingEffectiveFromMs, appended.groups[0].saved.billingEffectiveFromMs);
    assert.equal(f.store.list({ includeUnmonitored: true, includeArchived: true }).length, count);
    assert.ok(lockAttempts.every((attempt) => !attempt.overlaps.length), JSON.stringify(lockAttempts));
    assert.equal(held.size, 0); assert.equal(f.store._stationLocks.size, 0);
    assert.doesNotMatch(JSON.stringify([probe, partial, completed, later]), /new-account-pat|new-call-key|new-dedicated-pat|onboardingOrigin/);
  });
});

test("genuine public pureKey保存后link失败，restart从origin恢复原ID并仅补link", async (t) => {
  const f = await genuineBatchFixture(t), input = f.request([[1]]);
  input.selections = [{ selectionId: "account", monitor: true,
    newStation: { type: "newapi-key", baseUrl: "https://call.test/v1", apiKey: "key-secret" } }];
  input.groups[0].reconciliation = null; f.state.failLinks = true;
  const partial = await f.rt.channelOnboarding.connectBatch(input);
  assert.equal(partial.complete, false); assert.equal(partial.groups[0].saved.stationIds.length, 1);
  assert.equal(partial.retryInput.selections[0].stationId, null); assert.deepEqual(f.state.links, []);
  const savedId = partial.groups[0].saved.stationIds[0];
  await f.restart(); f.state.failLinks = false;
  const recovered = await f.rt.channelOnboarding.recoverBatch(partial.retryInput);
  assert.equal(recovered.complete, false); assert.deepEqual(recovered.groups[0].saved.stationIds, [savedId]);
  assert.ok(recovered.groups[0].remainingActions.includes("retry_links"));
  const completed = await f.rt.channelOnboarding.connectBatch(input);
  assert.equal(completed.complete, true); assert.deepEqual(completed.groups[0].saved.stationIds, [savedId]);
  assert.equal(f.store.list().length, 3); assert.equal(f.state.links.length, 1);
});

test("genuine old single HTTP财务missing proof拒绝，probe/confirm仍投影原结果字段", async (t) => {
  const f = await genuineBatchFixture(t), batch = f.request([[1]]);
  const input = { ownStationId: f.own.id, stationId: f.supplier.id, ...batch.groups[0].channels[0],
    reconciliation: { tokenId: 9, costCoverage: "complete", timezone: "Asia/Shanghai" } };
  const req = (body) => new Request("http://local/api/channel-onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const missing = await handleChannelOnboardingRequest(req(input), f.rt, "connect");
  assert.equal(missing.status, 400); assert.equal((await missing.json()).code, "PREVIEW_REQUIRED");
  assert.equal(f.state.ruleWrites, 0); assert.equal(f.state.links.length, 0);
  const probe = await (await handleChannelOnboardingRequest(req(input), f.rt, "probe")).json();
  assert.equal(probe.monitor.status, "verified"); assert.equal(probe.reconciliation.status, "ready");
  const result = await (await handleChannelOnboardingRequest(req({ ...input, previewId: probe.previewId }), f.rt, "connect")).json();
  assert.equal(result.complete, true); assert.equal(result.monitor.status, "linked");
  assert.equal(result.reconciliation.status, "configured"); assert.equal(result.saved.stationIds[0], f.supplier.id);
  assert.equal(result.saved.link.length, 1); assert.ok(result.retryInput.stationId); assert.ok(result.batchRetryInput.groups);
});

test("genuine batch两个明确旧ID同实际账号/Key但合法PAT不同，合并并保留各ID及原billing owner", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1]]);
  const initialProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: initialProbe.previewId });
  const second = await f.store.add({ type: "newapi", baseUrl: "https://up.test", accessToken: "another-valid-pat", lowBalanceUsd: 35 });
  const input = f.request([[2], [3]]);
  input.selections.push({ selectionId: "second", stationId: second.id, monitor: true });
  input.groups[1].selectionId = "second";
  const probe = await f.rt.channelOnboarding.probeBatch(input);
  assert.equal(probe.groups.length, 1); assert.equal(probe.groups[0].status, "ready");
  assert.deepEqual(probe.groups[0].basis.proposedChannelIds, [1, 2, 3]);
  assert.ok(probe.groups[0].basis.resourceVersions[f.supplier.id]); assert.ok(probe.groups[0].basis.resourceVersions[second.id]);
  const result = await f.rt.channelOnboarding.connectBatch({ ...input, previewId: probe.previewId });
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].requestedGroupIds, ["group-1", "group-2"]);
  assert.deepEqual(result.groups[0].saved.stationIds, [f.supplier.id, second.id]);
  assert.equal(result.groups[0].saved.authorizationStationId, f.supplier.id); assert.equal(result.groups[0].saved.ruleId, first.groups[0].saved.ruleId);
  assert.equal(result.groups[0].saved.scopeVersion, 2); assert.equal(f.state.ruleWrites, 2);
  assert.equal(second.accessToken, "another-valid-pat"); assert.equal(second.authVersion, 1); assert.equal(second.lowBalanceUsd, 35);
  assert.equal(f.store.list().length, 3);
});

test("U02 actual issuer只绑定最终set且可删除missing旧成员，私有replace意图含enabled且probe零写", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2, 3]]);
  const firstProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: firstProbe.previewId });
  const id = first.groups[0].saved.ruleId;
  f.state.channels = f.state.channels.filter((channelId) => channelId !== 1); await f.rt.channelOnboarding.sync();
  const before = structuredClone({ stations: f.store.data, rules: f.state.rules, members: f.state.members, links: f.state.links });
  const input = { upstreamStationId: f.supplier.id, tokenId: 9, salesChannelIds: [3, 2, 3], enabled: false,
    coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [1] },
    replaceRuleId: "forged", authorization: {}, guard: {}, sourceBinding: { 2: "forged" }, ownSource: { namespaceKey: "forged" } };
  const probe = await f.rt.channelOnboarding.probeRuleEdit(id, input);
  assert.deepEqual(probe.basis.existingChannelIds, [1, 2, 3]); assert.deepEqual(probe.basis.proposedChannelIds, [2, 3]);
  assert.deepEqual(Object.keys(probe.basis.channelRevisions), ["2", "3"]); assert.equal(probe.preview.costCoverage, "unknown");
  assert.equal(probe.preview.scopeChanged, true); assert.equal(probe.existingRule.id, id);
  assert.doesNotMatch(JSON.stringify(probe), /scopeIntent|normalizedPutIntent|forged|accessToken|password/);
  assert.deepEqual({ stations: f.store.data, rules: f.state.rules, members: f.state.members, links: f.state.links }, before);
  const guard = f.rt.channelOnboarding.getPreviewGuard(probe.previewId, probe.groupId);
  assert.equal(guard.scopeIntent.kind, "replace"); assert.equal(guard.scopeIntent.targetRuleId, id);
  assert.equal(guard.scopeIntent.existingEnabled, true); assert.equal(guard.scopeIntent.normalizedPutIntent.enabled, false);
  assert.deepEqual(guard.scopeIntent.normalizedPutIntent.salesChannelIds, [2, 3]);
  assert.throws(() => guard.scopeIntent.normalizedPutIntent.salesChannelIds.push(8), TypeError);
  assert.throws(() => f.rt.channelOnboarding.assertPreviewGuard({ ...guard }, { basis: probe.basis, preview: probe.preview }),
    (error) => error.code === "PREVIEW_REQUIRED");
  await assert.rejects(f.rt.channelOnboarding.connectBatch({ ...initial, previewId: probe.previewId }), (error) => error.code === "PREVIEW_REQUIRED");
  const saved = await f.rt.reconciliation.updateRule(id, { upstreamStationId: f.supplier.id, tokenId: 9,
    salesChannelIds: [2, 3], enabled: false, coverageDeclaration: input.coverageDeclaration }, { previewGuard: guard });
  assert.deepEqual(saved.channels.map((channel) => channel.channelId), [2, 3]);
  assert.equal(saved.enabled, false); assert.equal(saved.costCoverage, "unknown"); assert.equal(saved.scopeVersion, 2);
  assert.deepEqual(f.state.links, before.links); assert.deepEqual(f.store.data, before.stations);
});

test("U02 actual issuer拒绝取消声明与immutable Key变化，验证途中授权变化不能签发proof", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2]]);
  const firstProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: firstProbe.previewId });
  const id = first.groups[0].saved.ruleId, input = { upstreamStationId: f.supplier.id, tokenId: 9,
    salesChannelIds: [2], coverageDeclaration: { answer: "none" } };
  await assert.rejects(f.rt.channelOnboarding.probeRuleEdit(id, { ...input, coverageDeclaration: undefined }), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(f.rt.channelOnboarding.probeRuleEdit(id, { ...input, tokenId: 10 }), (error) => error.code === "RULE_IDENTITY_IMMUTABLE");
  let changed = false;
  f.state.requestHook = async (url) => {
    if (!changed && url.host === "up.test" && url.pathname === "/api/user/self") {
      changed = true; await f.store.update(f.supplier.id, { accessToken: "replacement-pat" });
    }
  };
  await assert.rejects(f.rt.channelOnboarding.probeRuleEdit(id, input), (error) => error.code === "PREVIEW_BASIS_CHANGED");
  assert.equal(f.state.ruleWrites, 1); assert.deepEqual(f.state.members.map((member) => member.channel_id), [1, 2]);
});

test("U02 actual HTTP一次preview一次PUT精确删除/同时增删/时区声明编辑，重启相同配置不延期", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2]]);
  const firstProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: firstProbe.previewId });
  const id = first.groups[0].saved.ruleId, { POST, PUT } = await ruleEditRoutes(), links = structuredClone(f.state.links);
  const request = (body) => new Request("http://local/api/reconciliation/rules/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const edits = [
    { upstreamStationId: f.supplier.id, tokenId: 9, salesChannelIds: [2], coverageDeclaration: { answer: "none" } },
    { upstreamStationId: f.supplier.id, tokenId: 9, salesChannelIds: [2, 3], coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [1] } },
    { upstreamStationId: f.supplier.id, tokenId: 9, salesChannelIds: [2, 3], timezone: "UTC", coverageDeclaration: { answer: "unknown" } },
  ];
  let saved;
  for (const [index, input] of edits.entries()) {
    const before = f.state.ruleWrites, response = await POST(request(input), f.rt, { id });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const preview = await response.json();
    assert.deepEqual(preview.basis.proposedChannelIds, input.salesChannelIds); assert.equal(f.state.ruleWrites, before);
    const updated = await PUT(request({ ...input, previewId: preview.previewId, groupId: preview.groupId }), f.rt, { id });
    assert.equal(updated.status, 200, JSON.stringify(await updated.clone().json()));
    saved = (await updated.json()).rule;
    assert.equal(saved.id, id); assert.equal(saved.upstreamStationId, f.supplier.id); assert.equal(saved.tokenId, 9);
    assert.deepEqual(saved.channels.map((channel) => channel.channelId), input.salesChannelIds); assert.equal(saved.scopeVersion, index + 2);
    assert.equal(saved.costCoverage, input.coverageDeclaration.answer === "none" ? "complete" : "unknown");
    assert.deepEqual(f.state.links, links); assert.equal(f.store.list().length, 2);
  }
  f.state.now += 24 * 3600000; await f.restart(); await f.rt.channelOnboarding.sync();
  const repeated = await PUT(request(edits[2]), f.rt, { id });
  assert.equal(repeated.status, 200, JSON.stringify(await repeated.clone().json()));
  const rule = (await repeated.json()).rule;
  assert.equal(rule.scopeVersion, saved.scopeVersion); assert.equal(rule.billingEffectiveFrom, saved.billingEffectiveFrom);
  assert.equal(f.state.ruleWrites, 4);
});

test("U02 actual HTTP拒绝append跨操作/replace跨target/篡改最终set声明时区enabled，全部零写", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2], [4]], [9, 10]);
  const initialProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: initialProbe.previewId });
  const id = first.groups[0].saved.ruleId, otherId = first.groups[1].saved.ruleId, { POST, PUT } = await ruleEditRoutes();
  const req = (body) => new Request("http://local/api/reconciliation/rules", { method: "POST", body: JSON.stringify(body) });
  const input = { upstreamStationId: f.supplier.id, tokenId: 9, salesChannelIds: [2, 3], timezone: "Asia/Shanghai", enabled: true,
    coverageDeclaration: { answer: "none" } };
  const preview = await (await POST(req({ ...input, replaceRuleId: otherId, options: { replaceRuleId: otherId }, guard: {} }), f.rt, { id })).json();
  assert.equal(preview.basis.existingRuleId, id);
  const proof = { previewId: preview.previewId, groupId: preview.groupId };
  const before = structuredClone({ rules: f.state.rules, members: f.state.members, writes: f.state.ruleWrites });
  const bodies = [
    { ...input, salesChannelIds: [2], ...proof }, { ...input, timezone: "UTC", ...proof },
    { ...input, enabled: false, ...proof }, { ...input, coverageDeclaration: { answer: "unknown" }, ...proof },
  ];
  for (const body of bodies) {
    const rejected = await PUT(req(body), f.rt, { id });
    assert.equal(rejected.status, 409, JSON.stringify(await rejected.clone().json()));
    assert.equal((await rejected.json()).code, "PREVIEW_BASIS_CHANGED");
  }
  const acrossTarget = await PUT(req({ ...input, tokenId: 10, salesChannelIds: [4, 5], ...proof }), f.rt, { id: otherId });
  assert.equal(acrossTarget.status, 409); assert.ok(["PREVIEW_BASIS_CHANGED", "RULE_IDENTITY_IMMUTABLE"].includes((await acrossTarget.json()).code));
  const appendInput = f.request([[1, 2, 3]]), append = await f.rt.channelOnboarding.probeBatch(appendInput);
  const acrossOperation = await PUT(req({ ...input, salesChannelIds: [1, 2, 3], previewId: append.previewId, groupId: "group-1" }), f.rt, { id });
  assert.equal(acrossOperation.status, 409); assert.equal((await acrossOperation.json()).code, "PREVIEW_BASIS_CHANGED");
  assert.deepEqual({ rules: f.state.rules, members: f.state.members, writes: f.state.ruleWrites }, before);
});

test("U02 actual HTTP跨午夜edit零写后要求新预览，相同成功最终配置次日重试不延期", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2]]);
  const firstProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: firstProbe.previewId });
  const id = first.groups[0].saved.ruleId, { POST, PUT } = await ruleEditRoutes();
  const req = (body) => new Request("http://local/api/reconciliation/rules", { method: "POST", body: JSON.stringify(body) });
  const input = { upstreamStationId: f.supplier.id, tokenId: 9, salesChannelIds: [2], coverageDeclaration: { answer: "none" } };
  f.state.now = Date.parse("2026-10-09T15:59:50Z"); await f.rt.channelOnboarding.sync();
  const preview = await (await POST(req(input), f.rt, { id })).json();
  const before = structuredClone({ stations: f.store.data, links: f.state.links, rules: f.state.rules, members: f.state.members });
  f.state.now = Date.parse("2026-10-09T16:00:01Z"); await f.rt.channelOnboarding.sync();
  const stale = await PUT(req({ ...input, previewId: preview.previewId, groupId: preview.groupId }), f.rt, { id });
  assert.equal(stale.status, 409); const error = await stale.json();
  assert.equal(error.code, "EFFECTIVE_PREVIEW_CHANGED"); assert.equal(error.nextPreview.billingEffectiveFromMs, Date.parse("2026-10-10T16:00:00Z"));
  assert.deepEqual({ stations: f.store.data, links: f.state.links, rules: f.state.rules, members: f.state.members }, before);
  assert.equal(f.state.ruleWrites, 1);
  const fresh = await (await POST(req(input), f.rt, { id })).json();
  const result = await PUT(req({ ...input, previewId: fresh.previewId, groupId: fresh.groupId }), f.rt, { id });
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  const saved = (await result.json()).rule;
  assert.equal(saved.scopeVersion, 2); assert.equal(saved.billingEffectiveFrom, Date.parse("2026-10-10T16:00:00Z"));
  f.state.now += 24 * 3600000; await f.rt.channelOnboarding.sync();
  const repeated = await PUT(req(input), f.rt, { id });
  assert.equal(repeated.status, 200); const rule = (await repeated.json()).rule;
  assert.equal(rule.scopeVersion, saved.scopeVersion); assert.equal(rule.billingEffectiveFrom, saved.billingEffectiveFrom);
});

test("U02 edit与batch使用同一100项/10min preview map，取消和restart不写资源关联规则", async (t) => {
  const f = await genuineBatchFixture(t), initial = f.request([[1, 2]]);
  const firstProbe = await f.rt.channelOnboarding.probeBatch(initial);
  const first = await f.rt.channelOnboarding.connectBatch({ ...initial, previewId: firstProbe.previewId });
  const id = first.groups[0].saved.ruleId, input = { upstreamStationId: f.supplier.id, tokenId: 9,
    salesChannelIds: [2], coverageDeclaration: { answer: "unknown" } };
  const before = structuredClone({ stations: f.store.data, links: f.state.links, rules: f.state.rules, members: f.state.members });
  const oldest = await f.rt.channelOnboarding.probeRuleEdit(id, input);
  let latest;
  for (let index = 0; index < 100; index++) latest = await f.rt.channelOnboarding.probeRuleEdit(id, input);
  assert.throws(() => f.rt.channelOnboarding.getPreviewGuard(firstProbe.previewId, "group-1"), (error) => error.code === "PREVIEW_REQUIRED");
  assert.throws(() => f.rt.channelOnboarding.getPreviewGuard(oldest.previewId, oldest.groupId), (error) => error.code === "PREVIEW_REQUIRED");
  assert.equal(f.rt.channelOnboarding.getPreviewGuard(latest.previewId, latest.groupId).scopeIntent.kind, "replace");
  assert.deepEqual({ stations: f.store.data, links: f.state.links, rules: f.state.rules, members: f.state.members }, before);
  f.state.now += 10 * 60000;
  assert.throws(() => f.rt.channelOnboarding.getPreviewGuard(latest.previewId, latest.groupId), (error) => error.code === "PREVIEW_REQUIRED");
  await f.restart();
  assert.throws(() => f.rt.channelOnboarding.getPreviewGuard(latest.previewId, latest.groupId), (error) => error.code === "PREVIEW_REQUIRED");
  assert.equal(f.state.ruleWrites, 1);
});

test("concurrent connections and a response retry share one persisted monitor and never return credentials", async () => {
  const state = fixture();
  const results = await Promise.all([connectNewApiUpstream(state.rt, input, metadata), connectNewApiUpstream(state.rt, input, metadata)]);
  results.push(await connectNewApiUpstream(state.rt, input, metadata));
  assert.equal(state.writes(), 1);
  assert.equal(state.stations[0].userId, "7");
  assert.deepEqual(results.map((result) => result.station.id), ["station-1", "station-1", "station-1"]);
  assert.deepEqual(results.map((result) => result.created), [true, false, false]);
  assert.equal(JSON.stringify(results).includes("secret-pat"), false);
});

test("different users at the same URL remain distinct and own/archived stations are not reused", async () => {
  const state = fixture([
    { id: "own", type: "newapi", baseUrl: input.baseUrl, userId: "7", isOwn: true },
    { id: "archived", type: "newapi", baseUrl: input.baseUrl, userId: "7", archivedAt: "2026-10-09" },
    { id: "another", type: "newapi", baseUrl: input.baseUrl, userId: "8" },
  ]);
  const result = await connectNewApiUpstream(state.rt, input, metadata);
  assert.equal(result.created, true);
  assert.equal(state.writes(), 1);
  assert.equal(state.stations.length, 4);
});

test("legacy account with identical PAT can be reused without a stored user ID", async () => {
  const state = fixture([{ id: "legacy", type: "newapi", baseUrl: input.baseUrl, accessToken: "Bearer secret-pat" }]);
  assert.equal((await connectNewApiUpstream(state.rt, input, metadata)).station.id, "legacy");
  assert.equal(state.writes(), 0);
});

test("failed provider verification is redacted and cannot persist a monitor", async () => {
  const state = fixture();
  await assert.rejects(connectNewApiUpstream(state.rt, input, async () => { throw new Error("token secret-pat denied"); }), (err) => !err.message.includes("secret-pat"));
  await assert.rejects(connectNewApiUpstream(state.rt, input, async () => ({})), /无法确认上游账号身份/);
  assert.equal(state.writes(), 0);
});

test("a rejected account write does not appear successful or poison the next connection", async () => {
  const state = fixture();
  state.fail();
  await assert.rejects(connectNewApiUpstream(state.rt, input, metadata), /保存失败/);
  assert.equal(state.stations.length, 0);
  const result = await connectNewApiUpstream(state.rt, input, metadata);
  assert.equal(result.created, true);
  assert.equal(state.stations.length, 1);
});

async function onboardingFixture() {
  const pool = { getConnection: async () => ({
    beginTransaction: async () => {}, query: async () => [[]], commit: async () => {}, rollback: async () => {}, release() {},
  }) };
  const store = new Store(pool);
  const own = await store.add({ name: "Own", type: "newapi", baseUrl: "https://own.example", accessToken: "own-secret", isOwn: true });
  const state = { now: Date.parse("2026-10-09T07:00:00Z"), pages: [{ id: 1, name: "Channel", type: 1,
    status: 1, baseUrl: "https://up.example", groups: ["sales"] }], catalogue: null, links: [], rules: [],
    refreshes: [], metadataCalls: [], failLinks: false, failRule: false, syncFailure: false,
    capability: "supported", catalogueGate: null, totalValidated: true, statCalls: [], statCapability: null };
  const repository = {
    async getCatalogue() { return structuredClone(state.catalogue); },
    async listLinks() { return structuredClone(state.links); },
    async saveCatalogue(value) {
      if (state.catalogueGate) await state.catalogueGate();
      state.catalogue = structuredClone(value);
    },
    async saveLinks(values) {
      if (state.failLinks) { state.failLinks = false; throw new Error("关联写入失败"); }
      const saved = [];
      for (const value of values) {
        const index = state.links.findIndex((link) => link.ownStationId === value.ownStationId
          && link.channelId === value.channelId && link.stationId === value.stationId);
        const link = index < 0 || state.links[index].channelRevision !== value.channelRevision ? { ...value } : state.links[index];
        if (index < 0) state.links.push(link); else state.links[index] = link;
        saved.push(link);
      }
      return structuredClone(saved);
    },
  };
  const dependencies = { repository, now: () => state.now,
    queryIdentity: async (connection) => ({ provider: connection.type.startsWith("sub2api") ? "sub2api" : "newapi",
      accountId: connection.userId || "7", baseUrl: connection.baseUrl }),
    queryChannels: async () => {
      if (state.syncFailure) throw new Error("network temporarily unavailable");
      return Object.defineProperties(structuredClone(state.pages), {
        totalValidated: { value: state.totalValidated }, catalogueTotal: { value: state.totalValidated ? state.pages.length : null },
      });
    },
    queryMetadata: async (connection) => {
      state.metadataCalls.push(structuredClone(connection));
      if (connection.accessToken === "invalid") throw new Error("denied token invalid");
      connection.s2Tokens = { accessToken: "temporary-jwt" };
      return { platform: connection.type.startsWith("sub2api") ? "sub2api" : "newapi",
        accountId: connection.userId || "7", baseUrl: connection.baseUrl,
        capability: { state: state.capability, reason: state.capability === "supported" ? null : "DEPLOYMENT_NOT_VERIFIED" },
        tokens: [{ id: 8, name: "Key", status: 1, group: "fixed", maskedKey: "raw-secret-key" }], groups: {} };
    },
    queryMonitor: async (connection) => ({ result: connection.accessToken === "invalid"
      ? { ok: false, error: "denied invalid" } : { ok: true, remaining: 10 } }),
    queryStat: async (connection, input) => {
      state.statCalls.push({ connection: structuredClone(connection), input: structuredClone(input) });
      return { complete: state.statCapability === "supported", knownAmountUsd: state.statCapability ? 2 : 0,
        capability: { state: state.statCapability || state.capability, reason: "DEPLOYMENT_NOT_VERIFIED" } };
    },
    refresh: async (_rt, station) => { state.refreshes.push(station.id); },
  };
  const rt = { store, pool };
  const financialPreview = async (input, { authorization = null, previewGuard = null } = {}) => {
    const station = authorization?.station || store.get(input.upstreamStationId), metadata = authorization?.metadata || await dependencies.queryMetadata(structuredClone(station));
    if (!authorization && state.statCapability) metadata.capability.state = state.statCapability;
    const canonicalKey = canonicalBillingKey(station, metadata, input.tokenId);
    const existing = state.rules.find((rule) => rule.canonicalKey === canonicalKey || rule.upstreamStationId === input.upstreamStationId && rule.tokenId === input.tokenId) || null;
    const source = rt.onboardingSource.getSourceCatalogue(), ids = [...new Set([...(existing?.channels || []).map((channel) => channel.channelId), ...input.salesChannelIds])].sort((a, b) => a - b);
    const binding = Object.fromEntries(ids.map((id) => [id, source.channels.find((channel) => channel.id === id)?.revision]));
    const value = { ...existing, ...input, canonicalKey, provider: metadata.platform, ownStationId: own.id, ownSource: source.ownSource,
      sourceBinding: binding, channels: ids.map((channelId) => ({ channelId })), timezone: input.timezone || existing?.timezone || "Asia/Shanghai" };
    delete value.previewEffectiveFromMs;
    const policy = applyScopePolicy(existing, value, state.now, { append: !!existing });
    const token = metadata.tokens.find((item) => Number(item.id) === Number(input.tokenId));
    const keyVersion = createHash("sha256").update(JSON.stringify([token.id, token.name, token.group, token.status, !!token.crossGroupRetry,
      metadata.quotaPerUnit ?? null, metadata.groups?.[token.group]?.ratio ?? null, metadata.capability.state || null,
      metadata.capability.currency || null, metadata.capability.window || null, metadata.capability.reason || null,
      metadata.billingTimezone?.state || null, metadata.billingTimezone?.timezone || null])).digest("hex");
    const versions = Object.fromEntries([...new Set([own.id, station.id, existing?.upstreamStationId,
      ...Object.keys(previewGuard?.basis.resourceVersions || {}), ...Object.keys(previewGuard?.postSaveResourceVersions || {})].filter(Boolean))].sort()
      .map((id) => [id, { authVersion: store.get(id)?.authVersion || 1, resourceVersion: stationBusinessVersion(store.get(id)) }]));
    return { existingRule: existing, policy, basis: { ownSource: source.ownSource, sourceVersion: source.sourceVersion,
      channelRevisions: binding, resourceVersions: versions, accountIdentity: { provider: metadata.platform, baseUrl: station.baseUrl, accountId: String(metadata.accountId) },
      canonicalKey, tokenId: token.id, keyVersion, existingRuleId: existing?.id || null, existingScopeVersion: existing?.scopeVersion || null,
      existingChannelIds: (existing?.channels || []).map((channel) => channel.channelId).sort((a, b) => a - b), proposedChannelIds: ids,
      timezone: policy.timezone, billingEffectiveFromMs: existing?.billingEffectiveFrom ?? null, coverageDeclaration: policy.coverageDeclaration },
    preview: { costCoverage: policy.costCoverage, billingEffectiveFromMs: policy.billingEffectiveFrom,
      firstQueryableAtMs: nextBillingEffectiveFrom(policy.timezone, policy.billingEffectiveFrom), scopeChanged: policy.scopeChanged } };
  };
  const saveRule = async (existing, input, { previewGuard } = {}) => rt.onboardingSource.withSourceLock(null, async () => {
    const context = await financialPreview({ ...input, salesChannelIds: input.channels.map((channel) => channel.channelId) }, { previewGuard });
    rt.onboardingSource.assertPreviewGuard(previewGuard, { basis: context.basis, preview: context.preview, postSaveResourceVersions: previewGuard.postSaveResourceVersions });
    if (state.failRule) { state.failRule = false; throw new Error("规则写入失败"); }
    const rule = { id: existing?.id || `rule-${state.rules.length + 1}`, enabled: true, ...context.policy };
    rt.onboardingSource.assertPreviewGuard(previewGuard, { basis: context.basis, preview: context.preview, postSaveResourceVersions: previewGuard.postSaveResourceVersions });
    const index = state.rules.findIndex((item) => item.id === rule.id);
    if (index < 0) state.rules.push(rule); else state.rules[index] = rule;
    return structuredClone(rule);
  });
  rt.reconciliation = {
    previewKeyScope: financialPreview,
    listRules: async () => structuredClone(state.rules),
    findRuleForKey: async (stationId, tokenId) => state.rules.find((rule) => rule.upstreamStationId === stationId
      && rule.tokenId === Number(tokenId)) || null,
    createRule: async (input, options) => saveRule(null, { ...input,
      ownStationId: own.id,
      channels: input.salesChannelIds.map((channelId) => ({ channelId, name: `Channel ${channelId}` })) }, options),
    appendChannels: async (id, ids, confirmation, options) => {
      const rule = state.rules.find((item) => item.id === id);
      return saveRule(rule, { ...rule, ...confirmation, sourceBinding: { ...rule.sourceBinding, ...confirmation.sourceBinding },
        channels: [...new Set([...rule.channels.map((member) => member.channelId), ...ids])].map((channelId) => ({ channelId })) }, options);
    },
  };
  let module;
  async function restart() {
    module = await createChannelOnboardingModule(rt, dependencies).load();
    rt.channelOnboarding = rt.onboardingSource = module;
    return module;
  }
  await restart();
  await module.sync();
  const request = (fields = {}) => ({ ownStationId: own.id, channelId: state.pages[0]?.id || 1,
    channelRevision: state.catalogue.channels.find((channel) => channel.id === (fields.channelId || 1)).revision,
    newStation: { name: "Supplier", type: "newapi", baseUrl: "https://up.example", accessToken: "supplier-secret" }, ...fields });
  const billing = () => ({ tokenId: 8, costCoverage: "complete", timezone: "Asia/Shanghai",
    previewEffectiveFromMs: nextBillingEffectiveFrom("Asia/Shanghai", state.now) });
  return { rt, own, state, dependencies, repository, request, billing, restart, get module() { return module; } };
}

async function connectWithPreview(f, input) {
  if (input.reconciliation && !input.previewId) {
    const preview = await f.module.probe(input);
    input = { ...input, requestId: preview.requestId, previewId: preview.previewId, groupId: preview.groupId };
  }
  return f.module.connect(input);
}

test("统一 probe 验证混合上游不保存、取消无副作用且公开响应无凭证", async () => {
  const f = await onboardingFixture();
  const result = await f.module.probe(f.request({ reconciliation: f.billing() }));
  assert.equal(result.monitor.status, "verified");
  assert.equal(result.reconciliation.status, "ready");
  assert.equal(f.rt.store.list({ includeUnmonitored: true }).length, 1);
  assert.deepEqual(f.state.links, []);
  assert.deepEqual(f.state.rules, []);
  assert.deepEqual(f.state.refreshes, []);
  assert.equal(JSON.stringify(result).includes("supplier-secret"), false);
  assert.equal(JSON.stringify(result).includes("raw-secret-key"), false);
  const all = await f.module.list();
  assert.equal(all.channels[0].monitor.status, "unlinked");
  assert.equal(all.channels[0].reconciliation.status, "unconfigured");
  assert.equal(f.state.catalogue.totalValidated, true);
  assert.equal(f.state.catalogue.catalogueTotal, 1);
});

test("两个并发一次接入及重启重试复用资源、成本对象和生效日期", async () => {
  const f = await onboardingFixture();
  const input = f.request({ reconciliation: f.billing() });
  const [first, second] = await Promise.all([connectWithPreview(f,input), connectWithPreview(f,input)]);
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(f.rt.store.list().length, 2);
  assert.equal(f.state.rules.length, 1);
  assert.equal(f.state.links.length, 1);
  const before = { scopeVersion: f.state.rules[0].scopeVersion, effective: f.state.rules[0].billingEffectiveFrom };
  await f.restart();
  f.state.now += 24 * 3600000;
  await f.module.sync();
  const repeated = await connectWithPreview(f,{ ...input, reconciliation: { ...f.billing() } });
  assert.equal(repeated.complete, true);
  assert.equal(f.state.rules[0].scopeVersion, before.scopeVersion);
  assert.equal(f.state.rules[0].billingEffectiveFrom, before.effective);
  assert.equal(JSON.stringify([first, second, repeated]).includes("supplier-secret"), false);
});

test("Key 监控补账单授权只保存专用授权，能力待验证可原地恢复", async () => {
  const f = await onboardingFixture();
  f.state.capability = "unverified";
  const input = f.request({ newStation: { name: "Key monitor", type: "newapi-key", baseUrl: "https://call.example/v1", apiKey: "call-secret" },
    reconciliation: { ...f.billing(), newAuthorization: { type: "sub2api-password", baseUrl: "https://panel.example",
      email: "supplier@example", password: "password-secret" } } });
  const partial = await connectWithPreview(f,input);
  assert.equal(partial.complete, false);
  assert.equal(partial.monitor.status, "linked");
  assert.equal(partial.reconciliation.status, "unverified");
  const authorization = f.rt.store.get(partial.saved.authorizationStationId);
  assert.equal(authorization.monitorEnabled, false);
  assert.equal(authorization.includeInProfit, false);
  assert.equal(authorization.isOwn, false);
  assert.equal(f.rt.store.list().length, 2);
  assert.equal(f.rt.store.list({ includeUnmonitored: true }).length, 3);
  assert.deepEqual(f.state.refreshes, partial.monitor.stationIds);
  assert.equal(JSON.stringify(partial).includes("call-secret"), false);
  assert.equal(JSON.stringify(partial).includes("password-secret"), false);
  await f.restart();
  f.state.capability = "supported";
  const completed = await connectWithPreview(f,partial.retryInput);
  assert.equal(completed.complete, true);
  assert.equal(f.rt.store.list({ includeUnmonitored: true }).length, 3);
  assert.equal(f.state.rules.length, 1);
});

test("关联或规则部分保存失败返回成功 ID，重试免凭证且不重复创建", async () => {
  for (const stage of ["failLinks", "failRule"]) {
    const f = await onboardingFixture();
    f.state[stage] = true;
    const partial = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
    assert.equal(partial.complete, false);
    assert.equal(partial.saved.stationIds.length, 1);
    assert.equal(JSON.stringify(partial.retryInput).includes("secret"), false);
    await f.restart();
    const completed = await connectWithPreview(f,partial.retryInput);
    assert.equal(completed.complete, true);
    assert.equal(f.rt.store.list().length, 2);
    assert.equal(f.state.links.length, 1);
    assert.equal(f.state.rules.length, 1);
  }
});

test("U06公开list仅投影已核验OwnSource白名单，零上游请求与持久写", async (t) => {
  const f = await onboardingFixture();
  Object.assign(f.state.catalogue.ownSource, { accessToken: "private-source-token", raw: { password: "private-source-password" },
    authorizationUpdateRef: { requestId: "private-source-marker" } });
  f.dependencies.queryIdentity = async () => { assert.fail("list must not verify upstream identity"); };
  f.dependencies.queryChannels = async () => { assert.fail("list must not fetch upstream channels"); };
  await f.restart();
  t.mock.method(f.repository, "saveCatalogue", async () => { assert.fail("list must not save catalogue"); });
  t.mock.method(f.repository, "saveLinks", async () => { assert.fail("list must not save links"); });
  t.mock.method(f.rt.store, "_writeNow", async () => { assert.fail("list must not save Store"); });
  const before = structuredClone({ store: f.rt.store.data, catalogue: f.state.catalogue, rules: f.state.rules, links: f.state.links });
  const result = await f.module.list(), source = f.module.getSourceCatalogue();
  assert.deepEqual(result.ownSource, source.ownSource); assert.equal(result.sourceVersion, source.sourceVersion);
  assert.deepEqual(Object.keys(result.ownSource).sort(), ["accountId", "baseUrl", "namespaceKey", "provider", "stationId"]);
  assert.equal(result.stale, false); assert.equal(result.ownSource.accountId, "7");
  assert.doesNotMatch(JSON.stringify(result), /own-secret|private-source|accessToken|password|authorizationUpdateRef|raw/);
  result.ownSource.accountId = "copied-identity";
  assert.equal((await f.module.list()).ownSource.accountId, "7", "public source is a detached projection");
  assert.deepEqual({ store: f.rt.store.data, catalogue: f.state.catalogue, rules: f.state.rules, links: f.state.links }, before);
});

test("U06普通授权变化及sync失败保留最后核验来源，不能把旧namespace认作当前账号", async (t) => {
  const f = await onboardingFixture(), initial = await f.module.list();
  await f.rt.store.update(f.own.id, { accessToken: "next-own-secret", userId: "8" });
  const stale = await f.module.list();
  assert.deepEqual(stale.ownSource, initial.ownSource); assert.equal(stale.stale, true);
  assert.notEqual(stale.sourceVersion, initial.sourceVersion); assert.equal(stale.ownSource.accountId, "7");
  f.dependencies.queryIdentity = async () => { throw new Error("denied next-own-secret"); };
  await f.restart();
  t.mock.method(f.repository, "saveCatalogue", async () => { assert.fail("failed sync must not save catalogue"); });
  const failed = await f.module.sync();
  assert.deepEqual(failed.ownSource, initial.ownSource); assert.equal(failed.sourceVersion, stale.sourceVersion);
  assert.equal(failed.stale, true); assert.ok(failed.error);
  assert.doesNotMatch(JSON.stringify(failed), /own-secret|next-own-secret|accessToken|password/);
});

test("目录失败保留旧副本并阻止新关联，缺项标记核对而不删除资源", async () => {
  const f = await onboardingFixture();
  const connected = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  f.state.syncFailure = true;
  const failed = await f.module.sync();
  assert.equal(failed.stale, true);
  assert.equal(failed.channels.length, 1);
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "unavailable");
  await assert.rejects(f.module.probe(f.request()), (error) => error.code === "CHANNEL_CATALOGUE_STALE");
  assert.equal(f.rt.store.get(connected.saved.stationIds[0]).name, "Supplier");
  f.state.syncFailure = false;
  f.state.pages = [];
  const missing = await f.module.sync();
  assert.equal(missing.channels[0].missing, true);
  assert.equal(missing.channels[0].reconciliation.status, "review_required");
  assert.equal(f.state.links.length, 1);
  assert.equal(f.state.rules.length, 1);
});

test("名称分组同步不改变财务来源版本，可见地址与本站授权变化立即失效", async () => {
  const f = await onboardingFixture();
  await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  const rule = f.state.rules[0], before = f.module.inspectSource(rule);
  f.state.pages[0].name = "Renamed";
  f.state.pages[0].groups = ["new-sales"];
  f.state.now += 10000;
  await f.module.sync();
  assert.deepEqual(f.module.inspectSource(rule), before);
  f.state.pages[0].baseUrl = "https://different.example";
  await f.module.sync();
  assert.equal(f.module.inspectSource(rule).status, "review_required");
  assert.notEqual(f.module.inspectSource(rule).version, before.version);
  await f.rt.store.update(f.own.id, { accessToken: "new-own-secret" });
  assert.equal(f.module.inspectSource(rule).status, "unavailable");
});

test("真实OwnSource替换后sync不能重新确认旧binding，新namespace不继承旧目录", async (t) => {
  const f = await onboardingFixture();
  const fixtureIdentity = f.dependencies.queryIdentity;
  const identities = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/api/user/self");
    identities.push({ host: url.hostname, authorization: options.headers.Authorization });
    const id = url.hostname === "own-b.test" ? 22 : 11;
    return { status: 200, text: async () => JSON.stringify({ success: true, data: { id } }) };
  });
  f.dependencies.queryIdentity = (connection) => connection.isOwn ? queryAccountIdentity(connection) : fixtureIdentity(connection);
  f.state.pages.push({ ...f.state.pages[0], id: 2, name: "Only A" });
  await f.restart();
  await f.module.sync();
  const initial = f.module.getSourceCatalogue();
  assert.deepEqual(initial.ownSource, { stationId: f.own.id, provider: "newapi", baseUrl: "https://own.example", accountId: "11",
    namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", "https://own.example", "11"])).digest("hex") });
  const connected = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  assert.equal(connected.complete, true);
  const rule = f.state.rules[0], original = structuredClone(rule);
  assert.equal(f.module.inspectSource(rule).status, "confirmed");
  await f.rt.store.update(f.own.id, { baseUrl: "https://own-b.test", accessToken: "own-b-pat" });
  assert.equal(f.module.inspectSource(rule).status, "unavailable");
  f.state.pages = [f.state.pages[0]];
  await f.module.sync();
  const replaced = f.module.getSourceCatalogue();
  assert.equal(replaced.ownSource.accountId, "22");
  assert.notEqual(replaced.ownSource.namespaceKey, initial.ownSource.namespaceKey);
  assert.notEqual(replaced.channels[0].revision, initial.channels[0].revision);
  assert.deepEqual(replaced.channels.map((channel) => channel.id), [1]);
  assert.equal(replaced.catalogueTotal, 1); assert.equal(replaced.totalValidated, true); assert.equal(replaced.stale, false);
  const inspected = f.module.inspectSource(rule);
  assert.equal(inspected.status, "review_required");
  assert.equal(inspected.issues[0].code, "SOURCE_BINDING_UNCONFIRMED");
  assert.equal(f.module.inspectSource({ ...rule, sourceBinding: null }).status, "review_required", "anchored legacy rules also retain their original namespace");
  assert.deepEqual(rule, original);
  await f.restart();
  assert.equal(f.module.inspectSource(rule).status, "review_required");
  assert.equal(f.module.getSourceCatalogue().ownSource.namespaceKey, replaced.ownSource.namespaceKey);
  assert.ok(identities.some((request) => request.authorization === "Bearer own-b-pat"));
});

test("真实同源PAT轮换只改变sourceVersion，预览与重复确认保留原scope和生效日", async (t) => {
  const f = await onboardingFixture(), fixtureIdentity = f.dependencies.queryIdentity;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(new URL(input).pathname, "/api/user/self");
    requests += 1;
    return { status: 200, text: async () => JSON.stringify({ success: true, data: { id: 11 } }) };
  });
  f.dependencies.queryIdentity = (connection) => connection.isOwn ? queryAccountIdentity(connection) : fixtureIdentity(connection);
  await f.restart(); await f.module.sync();
  const connected = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  assert.equal(connected.complete, true);
  const rule = f.state.rules[0], before = { scopeVersion: rule.scopeVersion, effective: rule.billingEffectiveFrom,
    namespace: rule.ownSource.namespaceKey, revision: f.module.getSourceCatalogue().channels[0].revision,
    sourceVersion: f.module.getSourceCatalogue().sourceVersion };
  await f.rt.store.update(f.own.id, { accessToken: "rotated-own-pat" });
  assert.equal(f.module.getSourceCatalogue().stale, true);
  assert.notEqual(f.module.getSourceCatalogue().sourceVersion, before.sourceVersion);
  f.state.now += 24 * 3600000;
  await f.module.sync();
  const current = f.module.getSourceCatalogue();
  assert.equal(current.ownSource.namespaceKey, before.namespace);
  assert.equal(current.channels[0].revision, before.revision);
  assert.equal(f.module.inspectSource(rule).status, "confirmed");
  const input = f.request({ newStation: undefined, stationId: connected.saved.stationIds[0], reconciliation: f.billing() });
  assert.equal((await f.module.probe(input)).preview.billingEffectiveFromMs, before.effective);
  assert.equal((await connectWithPreview(f,input)).complete, true);
  assert.equal(f.state.rules[0].scopeVersion, before.scopeVersion);
  assert.equal(f.state.rules[0].billingEffectiveFrom, before.effective);
  const count = requests;
  current.ownSource.accountId = "forged"; current.channels[0].groups.push("forged");
  assert.equal(f.module.getSourceCatalogue().ownSource.accountId, "11");
  assert.deepEqual(f.module.getSourceCatalogue().channels[0].groups, ["sales"]);
  assert.equal(requests, count, "synchronous reads perform no upstream requests");
  assert.equal(JSON.stringify(f.module.getSourceCatalogue()).includes("rotated-own-pat"), false);
});

test("同namespace保留validated missing渠道，无total/失败标记不伪造完整目录", async () => {
  const f = await onboardingFixture();
  f.state.pages.push({ ...f.state.pages[0], id: 2 });
  await f.module.sync();
  const before = f.module.getSourceCatalogue();
  f.state.pages = [f.state.pages[0]];
  f.state.now += 10;
  await f.module.sync();
  let current = f.module.getSourceCatalogue();
  assert.equal(current.sourceVersion, before.sourceVersion, "sync time is not a business version");
  assert.deepEqual(current.channels.map((channel) => [channel.id, channel.missing]), [[1, false], [2, true]]);
  assert.equal(current.catalogueTotal, 1); assert.equal(current.totalValidated, true);
  f.state.totalValidated = false; f.state.pages = [];
  await f.module.sync();
  current = f.module.getSourceCatalogue();
  assert.equal(current.totalValidated, false); assert.equal(current.catalogueTotal, null);
  assert.deepEqual(current.channels.map((channel) => [channel.id, channel.missing]), [[1, false], [2, true]]);
  f.state.syncFailure = true;
  await f.module.sync();
  assert.equal(f.module.getSourceCatalogue().stale, true);
  assert.deepEqual(f.module.getSourceCatalogue().channels, current.channels);
});

test("公开recover读回pureKey持久资源和关联，普通同域改Key后旧marker不能证明原intent完成", async () => {
  const f = await onboardingFixture(), requestId = "4a102bfe-f680-4ad8-92ac-26e732b07c9b";
  const channel = f.module.getSourceCatalogue().channels[0];
  const primary = await f.rt.store.add({ type: "newapi-key", baseUrl: "https://up.example", apiKey: "original-key" },
    { onboardingOrigin: { requestId, selectionId: "key", accountKey: null, type: "newapi-key", purpose: "monitor" } });
  f.state.links.push({ ownStationId: f.own.id, channelId: 1, stationId: primary.id, channelRevision: channel.revision, confirmedAt: f.state.now });
  const source = f.module.getSourceCatalogue(), intent = { requestId, source: { ownStationId: f.own.id, ownSource: source.ownSource, sourceVersion: source.sourceVersion },
    selections: [{ selectionId: "key", stationId: null, type: "newapi-key", baseUrl: "https://up.example", monitor: true,
      additionalMonitorStationIds: [], accountIdentity: null, authorizationStationId: null, authorizationIdentity: null }],
    groups: [{ groupId: "sales", requestedGroupIds: ["sales"], selectionIds: ["key"], channels: [{ channelId: 1, channelRevision: channel.revision }],
      reconciliationRequested: false, reconciliation: null }] };
  await f.restart();
  const before = structuredClone(f.rt.store.data), recovered = await f.module.recoverBatch(intent);
  assert.equal(recovered.complete, true); assert.deepEqual(recovered.groups[0].saved.stationIds, [primary.id]);
  assert.deepEqual(f.rt.store.data, before, "recover performs no Store configuration write");
  await f.rt.store.update(primary.id, { apiKey: "replacement-key", onboardingOrigin: primary.onboardingOrigin });
  assert.equal(primary.onboardingOrigin, null);
  await f.restart();
  const pending = await f.module.recoverBatch(intent);
  assert.equal(pending.complete, false); assert.ok(pending.groups[0].remainingActions.includes("verify_identity"));
  assert.deepEqual(pending.groups[0].saved.stationIds, []);
  assert.equal(f.rt.store.list().length, 2, "recovery never creates a substitute resource");
});

test("目录和规则提交共用来源锁，目录失败不提前发布新来源", async () => {
  const f = await onboardingFixture();
  await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  const rule = f.state.rules[0], original = f.module.inspectSource(rule);
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  const commit = f.module.withSourceLock(rule, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    assert.deepEqual(f.module.inspectSource(rule), original);
  });
  await reached;
  f.state.pages[0].baseUrl = "https://new.example";
  const syncing = f.module.sync();
  await Promise.resolve();
  assert.deepEqual(f.module.inspectSource(rule), original);
  release();
  await Promise.all([commit, syncing]);
  assert.equal(f.module.inspectSource(rule).status, "review_required");
  const current = f.module.inspectSource(rule);
  f.state.pages[0].baseUrl = "https://unsaved.example";
  f.state.catalogueGate = async () => { throw new Error("catalogue commit failed"); };
  await f.module.sync();
  assert.equal(f.module.inspectSource(rule).version, current.version);
  assert.equal(f.module.inspectSource(rule).status, "unavailable");
});

test("未验证 total 的缺项保留原目录状态，TTL过期阻断新精确账单来源", async () => {
  const f = await onboardingFixture();
  await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  f.state.totalValidated = false;
  f.state.pages = [];
  const retained = await f.module.sync();
  assert.equal(retained.channels[0].missing, false);
  assert.equal(retained.channels[0].monitor.status, "linked");
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "confirmed");
  f.state.now += 5 * 60000 + 1;
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "unavailable");
  await assert.rejects(f.module.probe({ ...f.request(), stationId: f.state.links[0].stationId, newStation: undefined }), /目录已过期/);
});

test("Sub2 首次选实际 Key 后核验已结束完整日，JWT和密码模式均能解锁账单配置", async () => {
  for (const type of ["sub2api", "sub2api-password"]) {
    const f = await onboardingFixture();
    f.state.capability = "unverified";
    const input = f.request({ newStation: { type, baseUrl: "https://up.example", accessToken: "jwt-secret",
      email: "supplier@example", password: "password-secret" }, reconciliation: f.billing() });
    const pending = await f.module.probe(input);
    assert.equal(pending.reconciliation.status, "unverified", "a zero bill is insufficient capability evidence");
    assert.equal(f.rt.store.list().length, 1);
    f.state.statCapability = "supported";
    const preview = await f.module.probe(input);
    assert.equal(preview.reconciliation.status, "ready");
    const call = f.state.statCalls.at(-1);
    assert.equal(call.input.metadata.capability.state, "unverified", "the adapter is called before metadata is ready");
    assert.equal(call.input.token.id, 8);
    assert.equal(call.input.startMs, Date.parse("2026-10-07T16:00:00Z"));
    assert.equal(call.input.endMs, Date.parse("2026-10-08T16:00:00Z"));
    const complete = await connectWithPreview(f,input);
    assert.equal(complete.complete, true);
    assert.equal(f.state.rules.length, 1);
    assert.equal(f.rt.store.list().length, 2);
  }
});

test("低权限账号可接监控，账单暂时失败保留关系且不宣称完成", async () => {
  const f = await onboardingFixture();
  f.dependencies.queryMetadata = async () => { throw new Error("账单权限不可用 supplier-secret"); };
  await f.restart();
  const partial = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  assert.equal(partial.complete, false);
  assert.equal(partial.monitor.status, "linked");
  assert.equal(partial.reconciliation.status, "unavailable");
  assert.equal(f.state.rules.length, 0);
  assert.equal(f.state.links.length, 1);
  assert.equal(JSON.stringify(partial).includes("supplier-secret"), false);
});

test("原成员来源变更影响重试预览，不静默延后既有完整日边界", async () => {
  const f = await onboardingFixture();
  f.state.pages.push({ ...f.state.pages[0], id: 2 });
  await f.module.sync();
  const first = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  await connectWithPreview(f,f.request({ channelId: 2, newStation: undefined, stationId: first.saved.stationIds[0], reconciliation: f.billing() }));
  const previousEffective = f.state.rules[0].billingEffectiveFrom;
  const request = f.request({ newStation: undefined, stationId: first.saved.stationIds[0], reconciliation: f.billing() });
  const original = await f.module.probe(request);
  f.state.now += 24 * 3600000;
  f.state.pages[1].baseUrl = "https://other.example";
  await f.module.sync();
  const preview = await f.module.probe(request);
  assert.notEqual(preview.preview.billingEffectiveFromMs, previousEffective);
  const changed = await f.module.connect({ ...request, requestId: original.requestId, previewId: original.previewId });
  assert.equal(changed.complete, false);
  assert.ok(["PREVIEW_REQUIRED", "PREVIEW_BASIS_CHANGED"].includes(changed.code));
  assert.equal(f.state.rules[0].billingEffectiveFrom, previousEffective);
  const confirmed = await f.module.connect({ ...request, requestId: preview.requestId, previewId: preview.previewId });
  assert.equal(confirmed.complete, true, JSON.stringify(confirmed));
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "confirmed");
});

test("追加旧规则完整确认财务来源但不捏造原渠道监控关系", async () => {
  const f = await onboardingFixture();
  f.state.pages.push({ ...f.state.pages[0], id: 2, name: "New channel" });
  await f.module.sync();
  const station = await f.rt.store.add({ type: "newapi", name: "Existing", baseUrl: "https://up.example", accessToken: "supplier-secret" });
  f.state.rules.push({ id: "old-rule", ownStationId: f.own.id, upstreamStationId: station.id, tokenId: 8,
    channels: [{ channelId: 1 }], timezone: "Asia/Shanghai", enabled: true, billingPolicy: "legacy-v3", scopeVersion: 1 });
  const connected = await connectWithPreview(f,f.request({ channelId: 2, newStation: undefined, stationId: station.id, reconciliation: f.billing() }));
  assert.equal(connected.complete, true);
  assert.equal(connected.saved.ruleId, "old-rule");
  assert.deepEqual(f.state.rules[0].channels.map((member) => member.channelId), [1, 2]);
  assert.deepEqual(Object.keys(f.state.rules[0].sourceBinding), ["1", "2"]);
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "confirmed");
  assert.deepEqual(f.state.links.map((link) => link.channelId), [2]);
});

test("跨午夜原预览在资源关联规则零写前返回新边界，重新预览才能确认", async () => {
  const f = await onboardingFixture();
  f.state.now = Date.parse("2026-10-09T15:59:50Z");
  await f.module.sync();
  const input = f.request({ reconciliation: f.billing() });
  const preview = await f.module.probe(input);
  f.state.now = Date.parse("2026-10-09T16:00:01Z");
  await f.module.sync();
  const changed = await f.module.connect({ ...input, requestId: preview.requestId, previewId: preview.previewId });
  assert.equal(changed.complete, false);
  assert.equal(changed.code, "EFFECTIVE_PREVIEW_CHANGED");
  assert.equal(changed.monitor.status, "unavailable");
  assert.equal(changed.preview.billingEffectiveFromMs, nextBillingEffectiveFrom("Asia/Shanghai", f.state.now));
  assert.equal(f.state.rules.length, 0);
  assert.deepEqual(f.state.links, []);
  assert.equal(f.rt.store.list().length, 1);
  const completed = await connectWithPreview(f,input);
  assert.equal(completed.complete, true);
  assert.equal(f.rt.store.list().length, 2);
});

test("在途验证不能保存已编辑授权身份，临时令牌不共享给 Store", async () => {
  const f = await onboardingFixture();
  const station = await f.rt.store.add({ type: "sub2api-password", name: "Existing", baseUrl: "https://up.example",
    email: "old@example", password: "secret" });
  const previousQuery = f.dependencies.queryMetadata;
  f.dependencies.queryMetadata = async (connection) => {
    const result = await previousQuery(connection);
    await f.rt.store.update(station.id, { email: "new@example" });
    return result;
  };
  await f.restart();
  await assert.rejects(f.module.probe(f.request({ newStation: undefined, stationId: station.id })), (error) => error.code === "PREVIEW_BASIS_CHANGED");
  assert.equal(station.s2Tokens, null);
  assert.equal(station.verifiedIdentity, null);
  assert.deepEqual(f.state.links, []);
});

test("旧候选身份核验期间被编辑时不覆盖、不新增重复资源或保存关联", async () => {
  const f = await onboardingFixture();
  const legacy = await f.rt.store.add({ type: "sub2api", baseUrl: "https://up.example", accessToken: "legacy-jwt" });
  const identity = f.dependencies.queryIdentity;
  f.dependencies.queryIdentity = async (connection) => {
    const result = await identity(connection);
    if (connection.id === legacy.id) await f.rt.store.update(legacy.id, { accessToken: "edited-jwt" });
    return result;
  };
  await f.restart();
  await assert.rejects(connectWithPreview(f,f.request({ updateCredentials: true,
    newStation: { type: "sub2api-password", baseUrl: "https://up.example", email: "a@example", password: "new-password" } })),
    (error) => error.code === "AUTHORIZATION_CHANGED");
  assert.equal(legacy.accessToken, "edited-jwt");
  assert.equal(legacy.authVersion, 2);
  assert.equal(legacy.verifiedIdentity, null);
  assert.equal(f.rt.store.list().length, 2);
  assert.deepEqual(f.state.links, []);
});

test("候选当前身份与已保存身份冲突时不能当成同账号授权轮换", async () => {
  const f = await onboardingFixture();
  const legacy = await f.rt.store.add({ type: "sub2api", baseUrl: "https://up.example", accessToken: "legacy-jwt" }, {
    verifiedIdentity: { provider: "sub2api", baseUrl: "https://up.example", accountId: "previous-account" },
  });
  await assert.rejects(connectWithPreview(f,f.request({ updateCredentials: true,
    newStation: { type: "sub2api-password", baseUrl: "https://up.example", email: "a@example", password: "new-password" } })),
    (error) => error.code === "ACCOUNT_IDENTITY_CHANGED");
  assert.equal(legacy.type, "sub2api");
  assert.equal(legacy.verifiedIdentity.accountId, "previous-account");
  assert.equal(f.rt.store.list().length, 2);
  assert.deepEqual(f.state.links, []);
});

test("同地址不同账号不合并，更新同账号授权须明确确认并保留运营设置", async () => {
  const f = await onboardingFixture();
  const existing = await f.rt.store.add({ name: "Configured", type: "newapi", baseUrl: "https://up.example",
    accessToken: "invalid", userId: "7", lowBalanceUsd: 42, includeInProfit: false }, {
    verifiedIdentity: { provider: "newapi", baseUrl: "https://up.example", accountId: "7" },
  });
  const input = f.request();
  const preview = await f.module.probe(input);
  assert.equal(preview.station.id, existing.id);
  assert.equal(preview.credentialUpdateRequired, true);
  const declined = await connectWithPreview(f,input);
  assert.equal(declined.complete, false);
  assert.equal(existing.accessToken, "invalid");
  const approved = await connectWithPreview(f,{ ...input, updateCredentials: true });
  assert.equal(approved.complete, true);
  assert.equal(approved.saved.stationIds[0], existing.id);
  assert.equal(existing.accessToken, "supplier-secret");
  assert.equal(existing.lowBalanceUsd, 42);
  assert.equal(existing.includeInProfit, false);
  assert.equal(existing.authVersion, 2);
  const other = await connectWithPreview(f,f.request({ newStation: { ...input.newStation, userId: "9", accessToken: "other-secret" } }));
  assert.equal(other.complete, true);
  assert.notEqual(other.saved.stationIds[0], existing.id);
});

test("Key补授权发现旧专用授权时提示更新，确认后复用且维持用途隔离", async () => {
  const f = await onboardingFixture();
  const grant = await f.rt.store.add({ type: "newapi", baseUrl: "https://panel.example", accessToken: "invalid", userId: "7",
    name: "Billing grant", monitorEnabled: false, cnyPerUsd: 0.5 }, {
    verifiedIdentity: { provider: "newapi", baseUrl: "https://panel.example", accountId: "7" },
  });
  const input = f.request({ newStation: { type: "newapi-key", baseUrl: "https://call.example/v1", apiKey: "call-secret" },
    reconciliation: { ...f.billing(), newAuthorization: { type: "newapi", baseUrl: "https://panel.example",
      accessToken: "new-account-secret", userId: "7" } } });
  const preview = await f.module.probe(input);
  assert.equal(preview.credentialUpdateRequired, true);
  assert.equal(preview.reconciliation.upstreamStationId, grant.id);
  const completed = await connectWithPreview(f,{ ...input, updateCredentials: true });
  assert.equal(completed.complete, true);
  assert.equal(completed.saved.authorizationStationId, grant.id);
  assert.equal(grant.accessToken, "new-account-secret");
  assert.equal(grant.monitorEnabled, false);
  assert.equal(grant.includeInProfit, false);
  assert.equal(grant.cnyPerUsd, 0.5);
  assert.equal(f.rt.store.list({ includeUnmonitored: true }).length, 3);
});

test("新监控的probe与保存均不把账单专用授权误当监控复用", async () => {
  const f = await onboardingFixture();
  const grant = await f.rt.store.add({ type: "newapi", baseUrl: "https://up.example", accessToken: "supplier-secret",
    monitorEnabled: false }, { verifiedIdentity: { provider: "newapi", baseUrl: "https://up.example", accountId: "7" } });
  const preview = await f.module.probe(f.request());
  assert.equal(preview.station.id, null);
  const completed = await connectWithPreview(f,f.request());
  assert.equal(completed.complete, true);
  assert.notEqual(completed.saved.stationIds[0], grant.id);
  assert.equal(grant.monitorEnabled, false);
});

test("重复启动只载入一个模块和一个五分钟定时器", async (t) => {
  const f = await onboardingFixture();
  delete f.rt.channelOnboarding;
  const [first, second] = await Promise.all([startChannelOnboarding(f.rt, f.dependencies), startChannelOnboarding(f.rt, f.dependencies)]);
  t.after(() => clearInterval(f.rt._channelOnboardingTimer));
  assert.equal(first, second);
  assert.equal(f.rt.onboardingSource, first);
  assert.equal(f.rt._channelOnboardingTimer._idleTimeout, 5 * 60000);
});

test("下游目录错误回显本站旧凭证时，接入的部分结果和重试信息仍脱敏", async (t) => {
  const f = await onboardingFixture();
  const previousToken = f.own.accessToken;
  let reached, release;
  const started = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(new URL(input).host, "own.example");
    assert.equal(options.headers.Authorization, previousToken);
    reached();
    await gate;
    return { status: 500, text: async () => JSON.stringify({ message: `request rejected for ${previousToken}` }) };
  });
  f.rt.reconciliation.createRule = async () => queryOwnChannels(structuredClone(f.own));
  const pending = connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  await started;
  await f.rt.store.update(f.own.id, { accessToken: "replacement-own-secret" });
  release();
  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.monitor.status, "linked");
  assert.equal(result.reconciliation.status, "unavailable");
  assert.equal(result.code, "PREVIEW_BASIS_CHANGED");
  assert.match(result.reconciliation.reason, /重新预览/);
  for (const secret of [previousToken, "replacement-own-secret", "supplier-secret"]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(result.saved.stationIds.length, 1);
  assert.equal(result.retryInput.stationId, result.saved.stationIds[0]);
});

test("接入失败边界独立脱敏对账错误中的本站旧值、现值和上游凭证", async () => {
  const f = await onboardingFixture();
  const previousToken = f.own.accessToken;
  f.rt.reconciliation.createRule = async () => {
    await f.rt.store.update(f.own.id, { accessToken: "replacement-own-secret" });
    throw new Error(`request rejected for ${previousToken}, replacement-own-secret, supplier-secret`);
  };
  const result = await connectWithPreview(f,f.request({ reconciliation: f.billing() }));
  assert.equal(result.complete, false);
  assert.equal(result.monitor.status, "linked");
  assert.equal(result.reconciliation.status, "unavailable");
  for (const secret of [previousToken, "replacement-own-secret", "supplier-secret"]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(result.retryInput.stationId, result.saved.stationIds[0]);
});
