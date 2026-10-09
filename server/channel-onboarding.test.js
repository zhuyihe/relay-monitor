import test from "node:test";
import assert from "node:assert/strict";
import { connectNewApiUpstream, createChannelOnboardingModule, startChannelOnboarding } from "./channel-onboarding.js";
import { Store } from "../db/store.js";
import { applyScopePolicy, nextBillingEffectiveFrom } from "../lib/reconciliation-scope-policy.js";
import { queryOwnChannels } from "../lib/providers.js";

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
  const saveRule = async (existing, input) => rt.onboardingSource.withSourceLock(null, () => {
    if (state.failRule) { state.failRule = false; throw new Error("规则写入失败"); }
    const rule = { id: existing?.id || `rule-${state.rules.length + 1}`, enabled: true, ...applyScopePolicy(existing, input, state.now) };
    const index = state.rules.findIndex((item) => item.id === rule.id);
    if (index < 0) state.rules.push(rule); else state.rules[index] = rule;
    return structuredClone(rule);
  });
  rt.reconciliation = {
    listRules: async () => structuredClone(state.rules),
    findRuleForKey: async (stationId, tokenId) => state.rules.find((rule) => rule.upstreamStationId === stationId
      && rule.tokenId === Number(tokenId)) || null,
    createRule: async (input) => saveRule(null, { ...input,
      ownStationId: own.id,
      channels: input.salesChannelIds.map((channelId) => ({ channelId, name: `Channel ${channelId}` })) }),
    appendChannels: async (id, ids, confirmation) => {
      const rule = state.rules.find((item) => item.id === id);
      return saveRule(rule, { ...rule, ...confirmation, sourceBinding: { ...rule.sourceBinding, ...confirmation.sourceBinding },
        channels: [...new Set([...rule.channels.map((member) => member.channelId), ...ids])].map((channelId) => ({ channelId })) });
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
  const [first, second] = await Promise.all([f.module.connect(input), f.module.connect(input)]);
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(f.rt.store.list().length, 2);
  assert.equal(f.state.rules.length, 1);
  assert.equal(f.state.links.length, 1);
  const before = { scopeVersion: f.state.rules[0].scopeVersion, effective: f.state.rules[0].billingEffectiveFrom };
  await f.restart();
  f.state.now += 24 * 3600000;
  await f.module.sync();
  const repeated = await f.module.connect({ ...input, reconciliation: { ...f.billing() } });
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
  const partial = await f.module.connect(input);
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
  const completed = await f.module.connect(partial.retryInput);
  assert.equal(completed.complete, true);
  assert.equal(f.rt.store.list({ includeUnmonitored: true }).length, 3);
  assert.equal(f.state.rules.length, 1);
});

test("关联或规则部分保存失败返回成功 ID，重试免凭证且不重复创建", async () => {
  for (const stage of ["failLinks", "failRule"]) {
    const f = await onboardingFixture();
    f.state[stage] = true;
    const partial = await f.module.connect(f.request({ reconciliation: f.billing() }));
    assert.equal(partial.complete, false);
    assert.equal(partial.saved.stationIds.length, 1);
    assert.equal(JSON.stringify(partial.retryInput).includes("secret"), false);
    await f.restart();
    const completed = await f.module.connect(partial.retryInput);
    assert.equal(completed.complete, true);
    assert.equal(f.rt.store.list().length, 2);
    assert.equal(f.state.links.length, 1);
    assert.equal(f.state.rules.length, 1);
  }
});

test("目录失败保留旧副本并阻止新关联，缺项标记核对而不删除资源", async () => {
  const f = await onboardingFixture();
  const connected = await f.module.connect(f.request({ reconciliation: f.billing() }));
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
  await f.module.connect(f.request({ reconciliation: f.billing() }));
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

test("目录和规则提交共用来源锁，目录失败不提前发布新来源", async () => {
  const f = await onboardingFixture();
  await f.module.connect(f.request({ reconciliation: f.billing() }));
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
  await f.module.connect(f.request({ reconciliation: f.billing() }));
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
    const complete = await f.module.connect(input);
    assert.equal(complete.complete, true);
    assert.equal(f.state.rules.length, 1);
    assert.equal(f.rt.store.list().length, 2);
  }
});

test("低权限账号可接监控，账单暂时失败保留关系且不宣称完成", async () => {
  const f = await onboardingFixture();
  f.dependencies.queryMetadata = async () => { throw new Error("账单权限不可用 supplier-secret"); };
  await f.restart();
  const partial = await f.module.connect(f.request({ reconciliation: f.billing() }));
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
  const first = await f.module.connect(f.request({ reconciliation: f.billing() }));
  await f.module.connect(f.request({ channelId: 2, newStation: undefined, stationId: first.saved.stationIds[0], reconciliation: f.billing() }));
  const previousEffective = f.state.rules[0].billingEffectiveFrom;
  f.state.now += 24 * 3600000;
  f.state.pages[1].baseUrl = "https://other.example";
  await f.module.sync();
  const request = f.request({ newStation: undefined, stationId: first.saved.stationIds[0],
    reconciliation: { ...f.billing(), previewEffectiveFromMs: previousEffective } });
  const preview = await f.module.probe(request);
  assert.notEqual(preview.preview.billingEffectiveFromMs, previousEffective);
  const changed = await f.module.connect(request);
  assert.equal(changed.code, "EFFECTIVE_PREVIEW_CHANGED");
  assert.equal(f.state.rules[0].billingEffectiveFrom, previousEffective);
  const confirmed = await f.module.connect({ ...changed.retryInput,
    reconciliation: { ...changed.retryInput.reconciliation, previewEffectiveFromMs: changed.preview.billingEffectiveFromMs } });
  assert.equal(confirmed.complete, true);
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "confirmed");
});

test("追加旧规则完整确认财务来源但不捏造原渠道监控关系", async () => {
  const f = await onboardingFixture();
  f.state.pages.push({ ...f.state.pages[0], id: 2, name: "New channel" });
  await f.module.sync();
  const station = await f.rt.store.add({ type: "newapi", name: "Existing", baseUrl: "https://up.example", accessToken: "supplier-secret" });
  f.state.rules.push({ id: "old-rule", ownStationId: f.own.id, upstreamStationId: station.id, tokenId: 8,
    channels: [{ channelId: 1 }], timezone: "Asia/Shanghai", enabled: true, billingPolicy: "legacy-v3", scopeVersion: 1 });
  const connected = await f.module.connect(f.request({ channelId: 2, newStation: undefined, stationId: station.id, reconciliation: f.billing() }));
  assert.equal(connected.complete, true);
  assert.equal(connected.saved.ruleId, "old-rule");
  assert.deepEqual(f.state.rules[0].channels.map((member) => member.channelId), [1, 2]);
  assert.deepEqual(Object.keys(f.state.rules[0].sourceBinding), ["1", "2"]);
  assert.equal(f.module.inspectSource(f.state.rules[0]).status, "confirmed");
  assert.deepEqual(f.state.links.map((link) => link.channelId), [2]);
});

test("跨午夜返回新预览，保留监控但不写规则，重新确认才建立账单范围", async () => {
  const f = await onboardingFixture();
  const input = f.request({ reconciliation: f.billing() });
  f.state.now = Date.parse("2026-10-09T16:00:01Z");
  await f.module.sync();
  const changed = await f.module.connect(input);
  assert.equal(changed.complete, false);
  assert.equal(changed.code, "EFFECTIVE_PREVIEW_CHANGED");
  assert.equal(changed.monitor.status, "linked");
  assert.equal(changed.preview.billingEffectiveFromMs, nextBillingEffectiveFrom("Asia/Shanghai", f.state.now));
  assert.equal(f.state.rules.length, 0);
  const completed = await f.module.connect({ ...changed.retryInput, reconciliation: {
    ...changed.retryInput.reconciliation, previewEffectiveFromMs: changed.preview.billingEffectiveFromMs } });
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
  await assert.rejects(f.module.probe(f.request({ newStation: undefined, stationId: station.id })), /授权配置已变化/);
  assert.equal(station.s2Tokens, null);
  assert.equal(station.verifiedIdentity, null);
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
  const declined = await f.module.connect(input);
  assert.equal(declined.complete, false);
  assert.equal(existing.accessToken, "invalid");
  const approved = await f.module.connect({ ...input, updateCredentials: true });
  assert.equal(approved.complete, true);
  assert.equal(approved.saved.stationIds[0], existing.id);
  assert.equal(existing.accessToken, "supplier-secret");
  assert.equal(existing.lowBalanceUsd, 42);
  assert.equal(existing.includeInProfit, false);
  assert.equal(existing.authVersion, 2);
  const other = await f.module.connect(f.request({ newStation: { ...input.newStation, userId: "9", accessToken: "other-secret" } }));
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
  const completed = await f.module.connect({ ...input, updateCredentials: true });
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
  const completed = await f.module.connect(f.request());
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
  const pending = f.module.connect(f.request({ reconciliation: f.billing() }));
  await started;
  await f.rt.store.update(f.own.id, { accessToken: "replacement-own-secret" });
  release();
  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.monitor.status, "linked");
  assert.equal(result.reconciliation.status, "unavailable");
  assert.match(result.reconciliation.reason, /已隐藏/);
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
  const result = await f.module.connect(f.request({ reconciliation: f.billing() }));
  assert.equal(result.complete, false);
  assert.equal(result.monitor.status, "linked");
  assert.equal(result.reconciliation.status, "unavailable");
  for (const secret of [previousToken, "replacement-own-secret", "supplier-secret"]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(result.retryInput.stationId, result.saved.stationIds[0]);
});
