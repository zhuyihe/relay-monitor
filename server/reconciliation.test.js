import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationModule, mapWithConcurrency, reconciliationScopeFingerprint, resolveReconciliationWindow, normalizeReconciliationScopeIntent } from "./reconciliation.js";
import { ReconciliationRepository, reconciliationOwnerRuleState } from "./reconciliation-repository.js";
import { reconciliationSnapshotIdentity, reconciliationConfirmedHistoryRecord } from "../lib/reconciliation-snapshot.js";
import { Store } from "../db/store.js";
import { canonicalBillingKey, nextBillingEffectiveFrom } from "../lib/reconciliation-scope-policy.js";
import { serializeRuleSourceBinding } from "../lib/reconciliation-scope-policy.js";
import { createChannelOnboardingModule } from "./channel-onboarding.js";
import { createHash } from "node:crypto";
import { summarizeReconciliationTotals } from "../lib/reconciliation-view.js";

function trustedLegacyRule(rule, stations = [], upstreamAccountId = 7, ownAccountId = 7) {
  const upstream = stations.find((station) => station.id === rule.upstream_station_id) || { type: "newapi", baseUrl: "https://upstream.test" };
  const own = stations.find((station) => station.id === rule.own_station_id) || { id: rule.own_station_id, baseUrl: "https://own.test" };
  const baseUrl = new URL(own.baseUrl).href.replace(/\/+$/, "");
  const ownSource = { stationId: own.id, provider: "newapi", baseUrl, accountId: String(ownAccountId),
    namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", baseUrl, String(ownAccountId)])).digest("hex") };
  rule.canonical_key = canonicalBillingKey(upstream, { platform: "newapi", accountId: upstreamAccountId }, rule.token_id);
  rule.source_binding = serializeRuleSourceBinding({ sourceBinding: null, ownSource, costCoverage: rule.cost_coverage || "unknown" });
}

function observationRepositoryFixture({ segments, rule = { id: "rr", token_name: "stable", fixed_group: "g1", archived_at: null }, hooks = {}, fail = null }) {
  const state = { rule: { ...rule }, segments: structuredClone(segments), commits: 0, rollbacks: 0, releases: 0 };
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [state.segments];
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async getConnection() {
      await hooks.beforeConnection?.();
      let working;
      return {
        async beginTransaction() { working = structuredClone(state); },
        async commit() {
          await hooks.beforeCommit?.();
          state.commits += 1;
          state.rule = working.rule;
          state.segments = working.segments;
        },
        async rollback() { state.rollbacks += 1; }, release() { state.releases += 1; },
        async query(sql, params = []) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [working.rule.archived_at ? [] : [working.rule]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [working.segments];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) {
            if (fail === "ratio") throw new Error("ratio write failed");
            const row = working.segments.find((item) => item.id === params[2]);
            if (row) { row.group_ratio = params[0]; row.ratio_observed_at_ms = params[1]; row.ratio_source = "group_catalog"; }
            return [{ affectedRows: row ? 1 : 0 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET effective_to_ms")) {
            if (fail === "close") throw new Error("close failed");
            const row = working.segments.find((item) => item.id === params[1]);
            if (row) row.effective_to_ms = params[0];
            return [{ affectedRows: row ? 1 : 0 }];
          }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            if (fail === "insert") { fail = null; throw new Error("insert failed"); }
            working.segments.push({ id: params[0], rule_id: params[1], group_name: params[2], group_ratio: params[3], ratio_observed_at_ms: params[4], ratio_source: params[5], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rules SET token_name")) {
            if (fail === "rule") { fail = null; throw new Error("rule write failed"); }
            working.rule.token_name = params[0]; working.rule.fixed_group = params[1];
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  return { state, repository: new ReconciliationRepository(pool) };
}

function sourceStore() {
  const conn = { beginTransaction: async () => {}, query: async () => [[]], commit: async () => {}, rollback: async () => {}, release() {} };
  const store = new Store({ getConnection: async () => conn });
  store.data.stations = [
    { id: "up", type: "newapi", baseUrl: "https://up.example", accessToken: "old" },
    { id: "own", type: "newapi", isOwn: true, baseUrl: "https://own.example", accessToken: "admin" },
  ];
  return store;
}

test("observeSource atomically backfills an unknown ratio without transitioning", async () => {
  const { state, repository } = observationRepositoryFixture({ segments: [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null }] });
  const observed = await repository.observeSource("rr", { groups: { g1: { ratio: 1.5 } }, group: "g1", ratio: 1.5, tokenName: "stable", detectedAt: 2000 });
  assert.equal(observed.transitioned, false);
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].group_ratio, 1.5);
  assert.equal(state.rule.fixed_group, "g1");
});

test("observeSource commits a real ratio transition and current rule group together", async () => {
  const { state, repository } = observationRepositoryFixture({ segments: [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null }] });
  const observed = await repository.observeSource("rr", { groups: { g1: { ratio: 2 } }, group: "g1", ratio: 2, tokenName: "renamed", detectedAt: 2000 });
  assert.equal(observed.transitioned, true);
  assert.deepEqual(state.segments.map((segment) => [segment.group_name, segment.group_ratio, segment.effective_to_ms]), [["g1", 1, 2000], ["g1", 2, null]]);
  assert.deepEqual([state.rule.token_name, state.rule.fixed_group], ["renamed", "g1"]);
});

test("observeSource rollback leaves no partial ratio or segment history and releases the source lock", async () => {
  for (const failure of ["insert", "rule"]) {
    const { state, repository } = observationRepositoryFixture({ segments: [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null }], fail: failure });
    const store = sourceStore();
    await assert.rejects(store.withStationLocks(["up", "own"], () => repository.observeSource("rr", {
      groups: { g1: { ratio: 1 }, g2: { ratio: 2 } }, group: "g2", ratio: 2, tokenName: "stable", detectedAt: 2000,
    })), failure === "insert" ? /insert failed/ : /rule write failed/);
    assert.deepEqual(state.segments, [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null }]);
    assert.deepEqual([state.commits, state.rollbacks, state.releases], [0, 1, 1]);
    await repository.observeSource("rr", { groups: { g1: { ratio: 1 } }, group: "g1", ratio: 1, tokenName: "stable", detectedAt: 3000 });
    assert.equal(state.commits, 1, "connection may be reused after rollback");
    await store.update("up", { accessToken: "new" });
    assert.equal(store.get("up").accessToken, "new", "failed observation must release the source lock");
  }
});

test("Store.update queues behind observeSource connection and commit boundaries", async () => {
  let releaseConnection;
  let enteredConnection;
  const connectionReached = new Promise((resolve) => { enteredConnection = resolve; });
  const fixture = observationRepositoryFixture({
    segments: [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null }],
    hooks: { beforeConnection: async () => { enteredConnection(); await new Promise((resolve) => { releaseConnection = resolve; }); } },
  });
  const store = sourceStore();
  const observation = store.withStationLocks(["up", "own"], () => fixture.repository.observeSource("rr", { groups: { g1: { ratio: 1 } }, group: "g1", ratio: 1, tokenName: "stable", detectedAt: 2000 }));
  await connectionReached;
  const edit = store.update("up", { accessToken: "new" });
  await Promise.resolve();
  assert.equal(store.get("up").accessToken, "old");
  releaseConnection();
  await Promise.all([observation, edit]);
  assert.equal(store.get("up").accessToken, "new");

  let releaseCommit;
  let enteredCommit;
  const commitReached = new Promise((resolve) => { enteredCommit = resolve; });
  const commitFixture = observationRepositoryFixture({
    segments: [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null }],
    hooks: { beforeCommit: async () => { enteredCommit(); await new Promise((resolve) => { releaseCommit = resolve; }); } },
  });
  const commitStore = sourceStore();
  const committing = commitStore.withStationLocks(["up", "own"], () => commitFixture.repository.observeSource("rr", { groups: { g1: { ratio: 1 } }, group: "g1", ratio: 1, tokenName: "stable", detectedAt: 2000 }));
  await commitReached;
  const committingEdit = commitStore.update("up", { accessToken: "new" });
  await Promise.resolve();
  assert.equal(commitStore.get("up").accessToken, "old", "source edit must wait while transaction commit is pending");
  releaseCommit();
  await Promise.all([committing, committingEdit]);
  assert.equal(commitStore.get("up").accessToken, "new");
});

test("快照读写共用同一逻辑窗口身份", () => {
  const scope = "same-scope";
  const sevenDay = { preset: "7d", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  assert.equal(reconciliationSnapshotIdentity(sevenDay, scope), "7d:1000:Asia/Shanghai:same-scope");
  assert.equal(reconciliationSnapshotIdentity({ ...sevenDay, endMs: 3000 }, scope), "7d:1000:Asia/Shanghai:same-scope");
  assert.equal(reconciliationSnapshotIdentity({ ...sevenDay, preset: "custom" }, scope), "custom:1000:2000:Asia/Shanghai:same-scope");
});

test("今天的较早慢查询不能复用或覆盖较晚查询的缓存", async () => {
  const rule = { id: "rr_today_cache", upstream_station_id: "missing", own_station_id: "own", token_id: 1, token_name: "key", fixed_group: "group", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: rule.id, group_name: "group", group_ratio: 1, effective_from_ms: 1, effective_to_ms: null, detected_at_ms: 1, timing_source: "operator_confirmed" };
  let releaseFirstLookup;
  let firstLookupReached;
  const firstLookup = new Promise((resolve) => { firstLookupReached = resolve; });
  let lookupCount = 0;
  const query = async (sql) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    if (sql.includes("FROM reconciliation_snapshots")) {
      if (++lookupCount === 1) {
        firstLookupReached();
        return new Promise((resolve) => { releaseFirstLookup = () => resolve([[]]); });
      }
      return [[]];
    }
    if (sql.includes("FROM reconciliation_alert_state")) return [[{ active: 1, first_seen_at: 1, last_seen_at: 1, last_notified_at: 1 }]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const reconciliation = createReconciliationModule(rt);
  const input = { ruleIds: [rule.id], preset: "today", timezone: "Asia/Shanghai" };
  const older = reconciliation.queryRules(input, { force: true });
  await firstLookup;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const newer = reconciliation.queryRules(input, { force: true });
  let timeout;
  let newerResponse;
  try {
    newerResponse = await Promise.race([
      newer,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("较晚查询错误地等待了旧查询")), 1500); }),
    ]);
  } finally {
    clearTimeout(timeout);
    releaseFirstLookup();
  }
  const olderResponse = await older;
  const olderEnd = olderResponse.results[0].window.endMs;
  const newerEnd = newerResponse.results[0].window.endMs;
  assert.ok(newerEnd > olderEnd, "较晚的今天窗口必须独立查询，不能共用旧 in-flight 任务");
  assert.equal([...rt._reconciliationResultCache.values()][0].value.window.endMs, newerEnd,
    "较早完成的旧窗口不能覆盖较晚窗口的缓存");
});

test("成功快照查询不会因最新候选无效而漏掉较早有效账单", async () => {
  const window = { preset: "7d", startMs: 1000, endMs: 5000, timezone: "Asia/Shanghai" };
  const valid = {
    recordType: "confirmed", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "scope",
    window: { ...window, endMs: 4000 }, resultGeneratedAt: "2026-09-23T09:00:00.000Z",
    result: { calculation: { differenceUsd: 2, profitUsd: 2, riskDifferenceUsd: null, marginRate: 0.5 } },
  };
  const repository = new ReconciliationRepository({
    async query(sql) {
      assert.doesNotMatch(sql, /LIMIT 1(?!\d)/);
      return [[
        { health_code: "READY", source: "{not-json" },
        { health_code: "READY", source: JSON.stringify({ ...valid, calculationVersion: 1, resultGeneratedAt: "2026-09-23T10:00:00.000Z" }) },
        { health_code: "READY", source: JSON.stringify(valid) },
      ]];
    },
  });

  assert.equal((await repository.latestSuccessfulResult("rr", window, "scope"))?.generatedAt, valid.resultGeneratedAt);
});

test("应用层口径检查后、快照 INSERT 前发生编辑时，原子保存拒绝旧口径", async () => {
  const calls = [];
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FROM reconciliation_rules")) return [[{ id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null }]];
          if (sql.includes("FROM reconciliation_rule_channels")) return [[{ channel_id: 2, channel_name: "changed" }]];
          if (sql.includes("FROM reconciliation_rule_segments")) return [[{ id: "s1", rule_id: "rr", group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }]];
          throw new Error(`unexpected query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  const expectedScope = reconciliationScopeFingerprint({ upstreamStationId: "up", ownStationId: "own", tokenId: 1, tokenName: "token", timezone: "Asia/Shanghai", channels: [{ channelId: 1 }] }, [{ id: "s1", group: "g", ratio: 1, effectiveFrom: 1000, effectiveTo: null }]);

  assert.equal(await repository.saveSnapshotsForScope("rr", expectedScope, [{ snapshotKey: "key" }]), false);
  assert.equal(calls.some((call) => call.sql?.includes("INSERT INTO reconciliation_snapshots")), false);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
});

test("较早成功或未确认快照都不能覆盖更晚的确认快照", async () => {
  const calls = [];
  const rule = { id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [{ id: "s1", rule_id: "rr", group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  const source = { recordType: "confirmed", window: { endMs: 5000 }, resultGeneratedAt: "2026-10-08T00:00:00.000Z", result: { calculation: { profitUsd: 1 } } };
  const pool = { async getConnection() { return {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("FROM reconciliation_snapshots")) return [[{ source: JSON.stringify(source) }]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) throw new Error("superseded snapshot must not write");
      throw new Error(`unexpected query: ${sql}`);
    },
  }; } };
  const expected = reconciliationScopeFingerprint({ upstreamStationId: "up", ownStationId: "own", tokenId: 1, tokenName: "token", timezone: "Asia/Shanghai", channels: [] }, [{ id: "s1", group: "g", ratio: 1, effectiveFrom: 1000, effectiveTo: null }]);
  const repository = new ReconciliationRepository(pool);
  for (const profitUsd of [1, null]) {
    assert.equal(await repository.saveSnapshotsForScope("rr", expected, [{ snapshotKey: "7d:1000:Asia/Shanghai:scope:s1", source: { recordType: "confirmed", window: { endMs: 4000 }, resultGeneratedAt: "2026-10-07T00:00:00.000Z", result: { calculation: { profitUsd } } } }]), true);
  }
  assert.equal(calls.some((call) => call.sql?.includes("INSERT INTO reconciliation_snapshots")), false);
  assert.ok(calls.some((call) => call.sql.includes("FROM reconciliation_rules") && call.sql.includes("FOR UPDATE")), "同一规则的快照写入仍由规则行锁串行");
  assert.equal(calls.some((call) => call.sql.includes("FROM reconciliation_snapshots") && call.sql.includes("FOR UPDATE")), false, "快照行不加锁定读，避免不存在的键产生间隙锁死锁");
});

test("持久化成功账单只接受相同核算口径，并从记录类型命名空间筛选候选快照", async () => {
  const window = { preset: "7d", startMs: 1000, endMs: 5000, timezone: "Asia/Shanghai" };
  const calls = [];
  const source = {
    recordType: "confirmed", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "current-scope",
    window: { ...window, endMs: 4000 }, resultGeneratedAt: "2026-09-23T10:00:00.000Z",
    result: { calculation: { differenceUsd: 2, profitUsd: 2, riskDifferenceUsd: null, marginRate: 0.5 } },
  };
  const repository = new ReconciliationRepository({
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ health_code: "READY", source: JSON.stringify(source) }]];
    },
  });

  assert.equal(await repository.latestSuccessfulResult("rr", window, "changed-scope"), null);
  await assert.rejects(() => repository.latestSuccessfulResult("rr", window), /必须指定核算口径/);
  assert.match(calls[0].sql, /window_end_ms <= \?/);
  assert.equal(calls[0].params[2], window.endMs);
  assert.equal((await repository.latestSuccessfulResult("rr", window, "current-scope"))?.result.calculation.profitUsd, 2);
});

test("成功快照查询不把时区文本拼接进有限长度快照键", async () => {
  const calls = [];
  const repository = new ReconciliationRepository({ async query(sql, params) { calls.push({ sql, params }); return [[]]; } });
  await repository.latestSuccessfulResult("rr", { preset: "7d", startMs: 1000, endMs: 2000, timezone: "America/Port_of_Spain" }, "scope");
  assert.match(calls[0].sql, /snapshot_key LIKE/);
  assert.match(calls[0].params[3], /^r3:c:[0-9a-f]{24}:%$/);
});

test("双命名空间快照批量写入第二条失败时整个事务回滚", async () => {
  const calls = [];
  const rule = { id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: "rr", group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" };
  let inserts = 0;
  const query = async (sql, params) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    if (sql.includes("SELECT source FROM reconciliation_snapshots")) return [[]];
    if (sql.includes("INSERT INTO reconciliation_snapshots")) {
      inserts += 1;
      if (inserts === 2) throw new Error("second insert failed");
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const pool = { async getConnection() { return {
    async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); }, query,
  }; } };
  const repository = new ReconciliationRepository(pool);
  const scope = reconciliationScopeFingerprint({ upstreamStationId: "up", ownStationId: "own", tokenId: 1, tokenName: "token", timezone: "Asia/Shanghai", channels: [] }, [{ id: "s1", group: "g", ratio: 1, effectiveFrom: 1000, effectiveTo: null }]);
  const source = (recordType) => ({ recordType, window: { endMs: 2000 }, resultGeneratedAt: "2026-10-08T00:00:00.000Z", result: { calculation: { profitUsd: recordType === "confirmed" ? 1 : null } } });
  await assert.rejects(() => repository.saveSnapshotsForScope("rr", scope, [
    { snapshotKey: "r3:o:scope:s1", source: source("observation") },
    { snapshotKey: "r3:c:scope:s1", source: source("confirmed") },
  ]), /second insert failed/);
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("R03 Repository核验owner状态并在INSERT前和commit前执行guard，失败原子回滚", async () => {
  for (const failure of ["owner", "before", "commit"]) {
    const rule = { id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
    const calls = [];
    const pending = [];
    const committed = [];
    let guardCalls = 0;
    const query = async (sql, params) => {
      if (sql.includes("FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels") || sql.includes("FROM reconciliation_rule_segments") || sql.includes("FROM reconciliation_snapshots")) return [[]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) { pending.push(params[2]); return [{ affectedRows: 1 }]; }
      throw new Error(`unexpected query: ${sql}`);
    };
    const repository = new ReconciliationRepository({ query, async getConnection() { return { query,
      async beginTransaction() {}, async commit() { calls.push("commit"); committed.push(...pending); },
      async rollback() { calls.push("rollback"); pending.length = 0; }, release() {},
    }; } });
    const original = await repository.getRule("rr");
    const expectedOwnerState = reconciliationOwnerRuleState([original]);
    if (failure === "owner") rule.enabled = 0;
    const saved = await repository.saveSnapshotsForScope("rr", reconciliationScopeFingerprint(original, []), [{ snapshotKey: "observation", source: { recordType: "observation" } }], {
      expectedOwnerState, guard: () => ++guardCalls < (failure === "before" ? 1 : 2),
    });
    assert.equal(saved, false);
    assert.deepEqual(calls, ["rollback"]);
    assert.deepEqual(committed, []);
    assert.equal(guardCalls, failure === "owner" ? 0 : failure === "before" ? 1 : 2);
  }
});

test("observation 单调写入不会覆盖较新的 observation 或确认命名空间", async () => {
  const stored = new Map();
  const rule = { id: "rr", upstream_station_id: "up", own_station_id: "own", token_id: 1, token_name: "token", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: "rr", group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" };
  let inserts = 0;
  const query = async (sql, params) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    if (sql.includes("SELECT source FROM reconciliation_snapshots")) return [[stored.get(params[1])].filter(Boolean)];
    if (sql.includes("INSERT INTO reconciliation_snapshots")) { inserts += 1; stored.set(params[2], { source: params.at(-1) }); return [{ affectedRows: 1 }]; }
    throw new Error(`unexpected query: ${sql}`);
  };
  const pool = { async getConnection() { return { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, query }; } };
  const repository = new ReconciliationRepository(pool);
  const scope = reconciliationScopeFingerprint({ upstreamStationId: "up", ownStationId: "own", tokenId: 1, tokenName: "token", timezone: "Asia/Shanghai", channels: [] }, [{ id: "s1", group: "g", ratio: 1, effectiveFrom: 1000, effectiveTo: null }]);
  const observation = (endMs, generatedAt) => ({ recordType: "observation", window: { endMs }, resultGeneratedAt: generatedAt, result: { calculation: { profitUsd: null } } });
  const confirmed = { recordType: "confirmed", window: { endMs: 2000 }, resultGeneratedAt: "2026-10-08T03:00:00.000Z", result: { calculation: { profitUsd: 1 } } };
  await repository.saveSnapshotsForScope("rr", scope, [{ snapshotKey: "r3:o:scope:s1", source: observation(2000, "2026-10-08T02:00:00.000Z") }, { snapshotKey: "r3:c:scope:s1", source: confirmed }]);
  await repository.saveSnapshotsForScope("rr", scope, [{ snapshotKey: "r3:o:scope:s1", source: observation(1900, "2026-10-08T04:00:00.000Z") }]);
  await repository.saveSnapshotsForScope("rr", scope, [{ snapshotKey: "r3:o:scope:s1", source: observation(2000, "2026-10-08T01:00:00.000Z") }]);
  assert.equal(inserts, 2);
  assert.equal(JSON.parse(stored.get("r3:o:scope:s1").source).resultGeneratedAt, "2026-10-08T02:00:00.000Z");
  assert.equal(JSON.parse(stored.get("r3:c:scope:s1").source).resultGeneratedAt, "2026-10-08T03:00:00.000Z");
});


test("多规则查询限制同时执行数且保持结果顺序", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency(Array.from({ length: 18 }, (_, index) => index), 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(result, Array.from({ length: 18 }, (_, index) => index * 2));
});

test("打开添加规则时可强制刷新本站渠道目录", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return {
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { total: 1, items: [
        { id: requests === 1 ? 312 : 333, name: requests === 1 ? "小福星-awsb-2.9" : "小福星-awsb_3-2.9", status: 1 },
      ] } }),
    };
  });
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });

  assert.deepEqual((await reconciliation.getConfiguration()).channels.map((channel) => channel.id), [312]);
  assert.deepEqual((await reconciliation.getConfiguration()).channels.map((channel) => channel.id), [312]);
  assert.deepEqual((await reconciliation.getConfiguration({ forceChannels: true })).channels.map((channel) => channel.id), [333]);
  assert.equal(requests, 2);
});

test("并发强制刷新时较晚完成的旧目录不能覆盖最新渠道缓存", async (t) => {
  const pending = [];
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => pending.push(resolve)));
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });
  const responseFor = (id) => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, data: { total: 1, items: [{ id, name: `渠道 ${id}`, status: 1 }] } }),
  });

  const older = reconciliation.getConfiguration({ forceChannels: true });
  const newer = reconciliation.getConfiguration({ forceChannels: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1](responseFor(333));
  assert.deepEqual((await newer).channels.map((channel) => channel.id), [333]);
  pending[0](responseFor(312));
  assert.deepEqual((await older).channels.map((channel) => channel.id), [312]);
  assert.deepEqual((await reconciliation.getConfiguration()).channels.map((channel) => channel.id), [333]);
  assert.equal(pending.length, 2);
});

test("渠道目录失败时配置接口不回显上游错误中的令牌，服务端日志只记脱敏原因", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    status: 500,
    text: async () => JSON.stringify({ success: false, message: "Authorization: Bearer sk-sensitive-value; admin test-token rejected" }),
  }));
  const logged = [];
  t.mock.method(console, "error", (...args) => { logged.push(args.join(" ")); });
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });

  const configuration = await reconciliation.getConfiguration();
  assert.equal(configuration.channels.length, 0);
  assert.match(configuration.channelsError, /本站渠道目录读取失败/);
  assert.doesNotMatch(JSON.stringify(configuration), /sk-sensitive-value|test-token/);
  assert.equal(logged.length, 1, "失败原因要留在服务端日志里便于排查");
  assert.match(logged[0], /本站渠道目录读取失败:.*rejected/);
  assert.doesNotMatch(logged[0], /sk-sensitive-value|test-token/);
});

test("同一个上游 Key 不能同时建立两条启用对账规则", async () => {
  const calls = [];
  const repository = new ReconciliationRepository({
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ id: "rr_existing", token_name: "oai", fixed_group: "oai" }]];
    },
  });

  assert.deepEqual(
    await repository.findTokenConflict("upstream-1", 42),
    { ruleId: "rr_existing", tokenName: "oai", fixedGroup: "oai" }
  );
  assert.deepEqual(calls[0].params, ["upstream-1", 42]);
  assert.match(calls[0].sql, /enabled = 1/);
  assert.match(calls[0].sql, /archived_at IS NULL/);
});

test("停止对账规则原子释放 Key 和渠道声明，并返回释放摘要", async () => {
  let active = true;
  let channelsReleased = false;
  const calls = [];
  const rule = {
    id: "rr_release", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "release-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
    archived_at: null, created_at: null, updated_at: null,
  };
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules")) return [active && params[0] === "rr_release" ? [rule] : []];
      if (sql.startsWith("SELECT rule_id, channel_id")) return [[
        { rule_id: "rr_release", channel_id: 1, channel_name: "渠道一" },
        { rule_id: "rr_release", channel_id: 2, channel_name: "渠道二" },
      ]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.startsWith("SELECT id FROM reconciliation_rules")) return [active ? [{ id: "rr_release" }] : []];
          if (sql.startsWith("UPDATE reconciliation_rules")) {
            const affectedRows = active ? 1 : 0;
            active = false;
            return [{ affectedRows }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_channels")) {
            channelsReleased = true;
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null } });

  assert.deepEqual(await module.archiveRule("rr_release"), {
    ruleId: "rr_release", tokenName: "release-key", fixedGroup: "fixed", releasedChannelCount: 2,
  });
  assert.equal(channelsReleased, true);
  assert.match(calls.find((call) => call.sql?.startsWith("UPDATE reconciliation_rules")).sql, /active_token_key = NULL/);
  assert.match(calls.find((call) => call.sql?.startsWith("UPDATE reconciliation_rule_channels")).sql, /active_channel_key = NULL/);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
  await assert.rejects(() => module.archiveRule("rr_missing"), /不存在或已停止/);
  await assert.rejects(() => module.archiveRule("rr_release"), /不存在或已停止/);
});

test("停止对账规则遇到并发归档时不释放渠道且返回错误", async () => {
  const calls = [];
  const rule = {
    id: "rr_race", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "race-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
    archived_at: null, created_at: null, updated_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.startsWith("SELECT rule_id, channel_id")) return [[{ rule_id: "rr_race", channel_id: 1, channel_name: "渠道" }]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); },
        async query(sql) {
          calls.push(sql);
          if (sql.startsWith("SELECT id FROM reconciliation_rules")) return [[{ id: "rr_race" }]];
          if (sql.startsWith("UPDATE reconciliation_rules")) return [{ affectedRows: 0 }];
          if (sql.startsWith("UPDATE reconciliation_rule_channels")) throw new Error("channel release must not run");
          throw new Error(`unexpected transaction query: ${sql}`);
        },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null } });

  await assert.rejects(() => module.archiveRule("rr_race"), /不存在或已停止/);
  assert.equal(calls.some((call) => typeof call === "string" && call.startsWith("UPDATE reconciliation_rule_channels")), false);
  assert.deepEqual(calls.filter((call) => ["begin", "commit", "release"].includes(call)), ["begin", "commit", "release"]);
});

test("默认最近已结束日按规则时区切零点，today显式保留当前窗口", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 12:26:08
  const window = resolveReconciliationWindow({ timezone: "Asia/Shanghai" }, now);
  assert.equal(window.startMs, Date.parse("2026-09-18T16:00:00.000Z"));
  assert.equal(window.endMs, Date.parse("2026-09-19T16:00:00.000Z"));
  assert.equal(resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, now).endMs, now);
  assert.equal(window.timezone, "Asia/Shanghai");
});

test("预设窗口都不会结束在当前时刻之后，自定义窗口超过当前时间会被拒绝", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z");
  for (const preset of ["today", "yesterday", "7d"]) {
    assert.ok(resolveReconciliationWindow({ preset, timezone: "Asia/Shanghai" }, now).endMs <= now, preset);
  }
  assert.equal(resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, now).endMs, now);
  assert.throws(() => resolveReconciliationWindow({ preset: "custom", timezone: "Asia/Shanghai", startMs: now - 1, endMs: now + 1 }, now), /不能超过当前时间/);
});

test("昨天和近 7 天对账窗口保留原有结束时间语义", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 12:26:08
  const dayStart = Date.parse("2026-09-19T16:00:00.000Z");
  assert.deepEqual(
    resolveReconciliationWindow({ preset: "yesterday", timezone: "Asia/Shanghai" }, now),
    { preset: "yesterday", timezone: "Asia/Shanghai", startMs: dayStart - 86400000, endMs: dayStart }
  );
  assert.deepEqual(
    resolveReconciliationWindow({ preset: "7d", timezone: "Asia/Shanghai" }, now),
    { preset: "7d", timezone: "Asia/Shanghai", startMs: dayStart - 6 * 86400000, endMs: now }
  );
});

test("DST 切换日按时区日历零点计算昨天与近 7 天", () => {
  const timezone = "America/New_York";
  const springNow = Date.parse("2026-03-08T16:00:00.000Z"); // DST start day, 12:00 EDT
  const springYesterday = resolveReconciliationWindow({ preset: "yesterday", timezone }, springNow);
  assert.equal(springYesterday.startMs, Date.parse("2026-03-07T05:00:00.000Z"));
  assert.equal(springYesterday.endMs, Date.parse("2026-03-08T05:00:00.000Z"));
  assert.equal(resolveReconciliationWindow({ preset: "7d", timezone }, springNow).startMs, Date.parse("2026-03-02T05:00:00.000Z"));

  const fallNow = Date.parse("2026-11-01T17:00:00.000Z"); // DST end day, 12:00 EST
  const fallYesterday = resolveReconciliationWindow({ preset: "yesterday", timezone }, fallNow);
  assert.equal(fallYesterday.startMs, Date.parse("2026-10-31T04:00:00.000Z"));
  assert.equal(fallYesterday.endMs, Date.parse("2026-11-01T04:00:00.000Z"));
  assert.equal(resolveReconciliationWindow({ preset: "7d", timezone }, fallNow).startMs, Date.parse("2026-10-26T04:00:00.000Z"));
});

test("编辑规则不能替换上游账号或 Key，且拒绝发生在元数据读取之前", async () => {
  const rule = {
    id: "rr_identity", upstream_station_id: "upstream-a", own_station_id: "own", token_id: 9,
    token_name: "fixed-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  let queries = 0;
  const pool = {
    async query(sql) {
      queries += 1;
      if (sql.startsWith("SELECT * FROM reconciliation_rules WHERE id")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      throw new Error(`metadata or update query must not run: ${sql}`);
    },
  };
  const module = createReconciliationModule({
    pool,
    store: {
      list: () => [{ id: "upstream-a", type: "newapi" }, { id: "own", type: "newapi", isOwn: true }],
      get: (id) => ({ id, type: "newapi" }),
    },
  });
  const input = { upstreamStationId: "upstream-a", tokenId: 10, salesChannelIds: [1], timezone: "Asia/Shanghai" };
  await assert.rejects(
    () => module.updateRule(rule.id, input),
    (error) => error.code === "RULE_IDENTITY_IMMUTABLE" && /规则身份/.test(error.message)
  );
  assert.equal(queries, 2);
});

test("旧编辑缺少金融proof时拒绝渠道/时区变化，原Key展示与分组无写入", async (t) => {
  const { createServer } = await import("node:http");
  const paths = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const path = url.pathname;
    paths.push(path);
    const body = path === "/api/channel/"
      ? { success: true, data: { items: Number(url.searchParams.get("p")) <= 1 ? [{ id: 2, name: "渠道二", status: 1 }] : [] } }
      : path === "/api/user/self" ? { success: true, data: { id: 7 } }
        : { success: false, message: "upstream metadata must not be read" };
    response.writeHead(body.success ? 200 : 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const row = {
    id: "rr_mutable", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "stable-key", fixed_group: "old-group", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules WHERE id")) return [[row]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("JOIN reconciliation_rule_channels")) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.startsWith("SELECT * FROM reconciliation_rules")) return [[row]];
          if (sql.startsWith("SELECT * FROM reconciliation_rule_channels")) return [[]];
          if (sql.startsWith("UPDATE reconciliation_rules")) {
            row.token_name = params[3];
            row.fixed_group = params[4];
            row.timezone = params[5];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("DELETE FROM reconciliation_rule_channels") || sql.startsWith("INSERT INTO reconciliation_rule_channels")) return [{ affectedRows: 1 }];
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "upstream-pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  await assert.rejects(module.updateRule(row.id, { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [2], timezone: "America/New_York" }),
    (error) => error.code === "PREVIEW_REQUIRED");

  assert.equal(paths.filter((path) => path === "/api/user/self").length, 2);
  assert.equal(paths.filter((path) => path === "/api/channel/").length, 2);
  assert.equal(paths.some((path) => path === "/api/token/" || path === "/api/user/self/groups"), false);
  assert.equal(row.token_name, "stable-key");
  assert.equal(row.fixed_group, "old-group");
  assert.equal(row.timezone, "Asia/Shanghai");
});

test("自定义对账窗口使用半开区间并拒绝超过 31 天", () => {
  const startMs = Date.parse("2026-09-01T00:00:00.000Z");
  const endMs = Date.parse("2026-09-02T00:00:00.000Z");
  assert.deepEqual(
    resolveReconciliationWindow({ preset: "custom", timezone: "Asia/Shanghai", startMs, endMs }),
    { preset: "custom", timezone: "Asia/Shanghai", startMs, endMs }
  );
  assert.throws(
    () => resolveReconciliationWindow(
      { preset: "custom", startMs, endMs: startMs + 32 * 86400000 },
      startMs + 33 * 86400000
    ),
    /31 天/
  );
  assert.throws(
    () => resolveReconciliationWindow({ preset: "custom", startMs, endMs: endMs + 1 }, endMs),
    /不能超过当前时间/
  );
});

test("空渠道不会生成批量渠道插入", async () => {
  const queries = [];
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT * FROM reconciliation_rules")) return [[{
        id: "rr-existing", upstream_station_id: "upstream-1", own_station_id: "own-1", token_id: 42,
        token_name: "oai", fixed_group: "oai", timezone: "Asia/Shanghai", enabled: 1,
      }]];
      if (sql.startsWith("SELECT * FROM reconciliation_rule_channels")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const repository = new ReconciliationRepository({
    async getConnection() { return connection; },
    async query() { return [[]]; },
  });
  const input = {
    upstreamStationId: "upstream-1", ownStationId: "own-1", tokenId: 42,
    tokenName: "oai", fixedGroup: "oai", timezone: "Asia/Shanghai", channels: [],
  };

  await repository.createRule(input);
  await repository.updateRule("rr-existing", input);

  assert.equal(queries.filter(({ sql }) => sql.includes("reconciliation_rule_channels") && sql.includes("INSERT")).length, 0);
});

test("归档规则使当前成本归属的缓存失效", async () => {
  const connection = {
    async beginTransaction() {},
    async query() { return [{ affectedRows: 1 }]; },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const rt = {
    pool: {
      async getConnection() { return connection; },
      async query(sql) {
        if (sql.includes("SELECT * FROM reconciliation_rules")) return [[{
          id: "rr-archived", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
          token_name: "archived-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
          archived_at: null, created_at: null, updated_at: null,
        }]];
        if (sql.includes("FROM reconciliation_rule_channels")) return [[{
          rule_id: "rr-archived", channel_id: 1, channel_name: "渠道",
        }]];
        throw new Error(`unexpected query: ${sql}`);
      },
    },
    store: { list() { return []; }, get() { return null; } },
    _reconciliationResultCache: new Map([
      ["rr-archived:today:1:2:Asia/Shanghai", { at: Date.now(), value: {} }],
      ["rr-remaining:today:1:2:Asia/Shanghai", { at: Date.now(), value: {} }],
    ]),
  };

  await createReconciliationModule(rt).archiveRule("rr-archived");

  assert.equal(rt._reconciliationResultCache.has("rr-archived:today:1:2:Asia/Shanghai"), false);
  assert.equal(rt._reconciliationResultCache.has("rr-remaining:today:1:2:Asia/Shanghai"), false);
});

test("统计接口不会绕过已变更的固定 Key 元数据", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const body = url.pathname === "/api/status"
      ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self"
        ? { success: true, data: { id: 42 } }
      : url.pathname === "/api/user/self/groups"
        ? { success: true, data: { fixed: { ratio: 1 } } }
        : url.pathname === "/api/token/"
          ? { success: true, data: { total: 1, items: [{ id: 9, name: "renamed-key", status: 1, group: "fixed", cross_group_retry: false }] } }
          : null;
    assert.notEqual(url.pathname, "/api/log/self/stat", "changed Key must be rejected before stat aggregation");
    response.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body || { success: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rule = {
    id: "rr_test", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "original-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1,
    archived_at: null, created_at: null, updated_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: "rr_test", channel_id: 1, channel_name: "渠道" }]];
      return [[]];
    },
  };
  pool.getConnection = async () => ({
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    query: (...args) => pool.query(...args),
  });
  const stations = [
    { id: "upstream", type: "newapi", baseUrl, accessToken: "pat" },
    { id: "own", type: "newapi", isOwn: true },
  ];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const { results } = await module.queryRules({
    ruleIds: ["rr_test"], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });
  const result = results[0];
  assert.equal(result.health.code, "KEY_INVALID_OR_DENIED");
  assert.match(result.health.detail, /名称已变化/);
});

test("短于一秒的分段标记为不可核算，且不调用上游 stat 或本站收费接口", async (t) => {
  const { createServer } = await import("node:http");
  const aggregateCalls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (["/api/log/self/stat", "/api/log/stat", "/api/data/flow", "/api/data/"].includes(url.pathname)) aggregateCalls.push(url.pathname);
    const body = url.pathname === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self" ? { success: true, data: { id: 1 } }
        : url.pathname === "/api/user/self/groups" ? { success: true, data: { fixed: { ratio: 1 } } }
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, name: "fixed-key", status: 1, group: "fixed", cross_group_retry: false }] } }
            : url.pathname === "/api/channel/" ? { success: true, data: { items: [{ id: 1, name: "渠道", status: 1 }] } }
              : { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = { id: "rr_short", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "fixed-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: rule.id, group_name: "fixed", group_ratio: 1, ratio_observed_at_ms: 1, ratio_source: "group_catalog", effective_from_ms: 0, effective_to_ms: null, detected_at_ms: 0, timing_source: "operator_confirmed" };
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        query: (...args) => pool.query(...args),
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  trustedLegacyRule(rule, stations, 1, 1);
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1500, endMs: 1999 }, { force: true });

  assert.deepEqual(aggregateCalls, []);
  assert.equal(results[0].health.code, "PENDING");
  assert.equal(results[0].upstream.state, "pending");
  assert.equal(results[0].downstream.amountUsd, null);
});

test("同名上游 Key 无法唯一归属时 fail closed，不能请求 stat 或计算利润", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const body = url.pathname === "/api/status"
      ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self"
        ? { success: true, data: { id: 42 } }
        : url.pathname === "/api/user/self/groups"
          ? { success: true, data: { fixed: { ratio: 1 } } }
          : url.pathname === "/api/token/"
            ? { success: true, data: { total: 2, items: [
              { id: 9, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
              { id: 10, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
            ] } }
            : null;
    assert.notEqual(url.pathname, "/api/log/self/stat", "ambiguous names must not be reconciled");
    response.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body || { success: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = {
    id: "rr_duplicate", upstream_station_id: "upstream", own_station_id: "own", token_id: 9,
    token_name: "duplicate-key", fixed_group: "fixed", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[{
        id: "s1", rule_id: rule.id, group_name: "fixed", group_ratio: 1, effective_from_ms: 1000,
        effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed",
      }]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  pool.getConnection = async () => ({
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    query: (...args) => pool.query(...args),
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000 }, { force: true });
  assert.equal(results[0].health.code, "KEY_INVALID_OR_DENIED");
  assert.match(results[0].health.detail, /名称不唯一/);
  assert.equal(results[0].calculation.differenceUsd, null);
});

test("创建规则遇到同名上游 Key 时 fail closed", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const path = url.pathname;
    const body = path === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : path === "/api/user/self" ? { success: true, data: { id: 1 } }
        : path === "/api/user/self/groups" ? { success: true, data: { fixed: { ratio: 1 } } }
          : path === "/api/token/" ? { success: true, data: { total: 2, items: [
            { id: 9, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
            { id: 10, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
          ] } }
            : path === "/api/channel/" ? { success: true, data: { items: Number(url.searchParams.get("p")) <= 1 ? [{ id: 1, name: "渠道", status: 1 }] : [] } }
              : { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const pool = {
    async query(sql) {
      return [[]];
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  const input = { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [1], timezone: "Asia/Shanghai" };
  await assert.rejects(() => module.createRule(input), (err) => err.code === "TOKEN_NAME_AMBIGUOUS");
});

test("跨分段窗口分别核算并以合计金额重算毛利率，同时保留渠道禁用状态", async (t) => {
  const { createServer } = await import("node:http");
  const statRequests = [];
  let upstreamBroken = false;
  let ownBillingBroken = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const start = Number(url.searchParams.get("start_timestamp"));
    let body;
    if (url.pathname === "/api/status") body = { success: true, data: { quota_per_unit: 100 } };
    else if (url.pathname === "/api/user/self") body = { success: true, data: { id: 7 } };
    else if (url.pathname === "/api/user/self/groups") body = { success: true, data: { g1: { ratio: 2.9 }, g2: { ratio: 2.6 } } };
    else if (url.pathname === "/api/token/") body = { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } };
    else if (url.pathname === "/api/log/self/stat") {
      statRequests.push({ tokenName: url.searchParams.get("token_name"), group: url.searchParams.get("group"), start, end: Number(url.searchParams.get("end_timestamp")) });
      body = upstreamBroken ? { success: false, message: "stat unavailable" } : { success: true, data: { quota: start === 1000 ? 0 : 100 } };
    }
    else if (url.pathname === "/api/log/stat") {
      assert.equal(url.searchParams.get("channel"), "1");
      assert.equal(url.searchParams.has("channel_id"), false);
      body = ownBillingBroken
        ? { success: false, message: "channel stat unavailable" }
        : { success: true, data: { quota: start === 1000 ? 200 : 100 } };
    }
    else if (url.pathname === "/api/channel/") body = { success: true, data: { items: Number(url.searchParams.get("p")) <= 1 ? [{ id: 1, name: "渠道", status: 2 }] : [] } };
    else body = { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = { id: "rr_segments", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [
    { id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2.9, ratio_observed_at_ms: 1000001, ratio_source: "group_catalog", effective_from_ms: 1000000, effective_to_ms: 1030000, detected_at_ms: 1030000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: rule.id, group_name: "g2", group_ratio: 2.6, ratio_observed_at_ms: 1030001, ratio_source: "group_catalog", effective_from_ms: 1030000, effective_to_ms: null, detected_at_ms: 1030000, timing_source: "detected" },
  ];
  const snapshotSources = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      if (sql.includes("FROM reconciliation_snapshots")) {
        return [snapshotSources.map((source) => ({ source: JSON.stringify(source) }))];
      }
      if (sql.includes("INSERT INTO reconciliation_snapshots")) {
        snapshotSources.push(JSON.parse(params.at(-1)));
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
          if (sql.includes("effective_to_ms IS NULL") && sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) {
            snapshotSources.push(JSON.parse(params.at(-1)));
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rules SET token_name")) return [{ affectedRows: 1 }];
          if (sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) { segments[0].group_ratio = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { segments[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            segments.push({ id: params[0], rule_id: rule.id, group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  trustedLegacyRule(rule, stations);
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  const result = results[0];
  assert.equal(result.segments.length, 2);
  assert.equal(result.upstream.amountUsd, 1);
  assert.equal(result.downstream.amountUsd, 3);
  assert.equal(result.downstream.billingSource, "channel-log-stat");
  assert.equal(result.downstream.calculationVersion, 3);
  assert.equal(result.downstream.successfulCount, 2);
  assert.equal(result.downstream.expectedCount, 2);
  assert.equal(result.calculation.differenceUsd, 2);
  assert.equal(result.calculation.profitUsd, null, "an upstream-empty sales anomaly is a risk difference, never confirmed profit");
  assert.equal(result.calculation.riskDifferenceUsd, 2);
  assert.equal(result.calculation.marginRate, null, "an upstream-empty sales anomaly must invalidate the aggregate margin");
  assert.equal(result.downstream.channels[0].state, "manual_disabled");
  assert.equal(result.health.code, "UPSTREAM_EMPTY_WITH_SALES", "billing anomalies must outrank transition-timing notices");
  assert.ok(result.health.issues.some((issue) => issue.code === "UPSTREAM_EMPTY_WITH_SALES"));
  assert.deepEqual([...statRequests].sort((left, right) => left.start - right.start), [
    { tokenName: "stable", group: null, start: 1000, end: 1029 },
    { tokenName: "stable", group: null, start: 1030, end: 1059 },
  ], "each half-open segment must query its own token-only window exactly once");
  assert.ok(result.health.issues.some((issue) => issue.code === "SALES_CHANNEL_DISABLED"));
  assert.ok(result.health.issues.some((issue) => issue.code === "SEGMENT_TIMING_UNCONFIRMED"));
  assert.deepEqual(snapshotSources[0].segment, {
    group: "g1", ratio: 2.9, ratioObservedAt: 1000001, ratioSource: "group_catalog", timingSource: "operator_confirmed",
  });
  assert.equal(snapshotSources[0].calculationVersion, 3);
  assert.equal(snapshotSources[0].billingSource, "channel-log-stat");
  assert.equal(snapshotSources[0].downstream.calculationVersion, 3);
  assert.deepEqual(
    snapshotSources.filter(Boolean).map((source) => source.downstream.channels),
    [
      [{ channelId: 1, quotaUnits: 200, amountUsd: 2 }],
      [{ channelId: 1, quotaUnits: 100, amountUsd: 1 }],
    ],
    "即使利润被阻断，每个分段也必须保存自己的渠道收费证据"
  );
  ownBillingBroken = true;
  const afterBillingFailure = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(afterBillingFailure.results[0].health.code, "OWN_BILLING_UNAVAILABLE");
  assert.equal(afterBillingFailure.results[0].downstream.amountUsd, null, "任一渠道账单失败后不得保留部分收费");
  assert.equal(afterBillingFailure.results[0].downstream.channels[0].quotaUnits, null);
  assert.equal(afterBillingFailure.results[0].downstream.channels[0].share, null, "账单不完整时渠道占比必须保持未知");
  assert.equal(afterBillingFailure.results[0].calculation.profitUsd, null);
  assert.equal(afterBillingFailure.results[0].calculation.marginRate, null);
  ownBillingBroken = false;
  upstreamBroken = true;
  const afterAnomaly = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(afterAnomaly.results[0].lastSuccessfulAt, undefined, "上游空消费异常不能作为后续失败的最近成功账单");
  assert.equal(afterAnomaly.results[0].health.stale, false);
  upstreamBroken = false;
  const second = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.ok(second.results[0].health.issues.some((issue) => issue.code === "SEGMENT_TIMING_UNCONFIRMED"), "unconfirmed timing must persist until an operator confirms it");
  const realNow = Date.now;
  let now = Date.parse("2026-09-20T04:26:08.000Z");
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const todayA = await module.queryRules({ ruleIds: [rule.id], preset: "today" }, { force: true });
  const todayAmount = todayA.results[0].upstream.amountUsd;
  const todaySuccessAt = todayA.results[0].lastSuccessfulAt;
  upstreamBroken = true;
  const restarted = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  const restartedResult = await restarted.queryRules({
    ruleIds: [rule.id], preset: "today",
  }, { force: true });
  assert.equal(restartedResult.results[0].lastConfirmed.generatedAt, todaySuccessAt, "a restarted process must preserve the persisted confirmed time when partial collection fails");
  assert.equal(restartedResult.results[0].window.endMs, todayA.results[0].window.endMs, "a restarted process must retain the persisted data coverage window");
  assert.ok(restartedResult.results[0].requestedWindow.endMs >= restartedResult.results[0].window.endMs);
  now += 30000;
  const todayB = await module.queryRules({ ruleIds: [rule.id], preset: "today" }, { force: true });
  assert.equal(todayB.results[0].health.stale, false);
  assert.equal(todayB.results[0].upstream.amountUsd, null);
  assert.equal(todayB.results[0].lastConfirmed.upstream.amountUsd, todayAmount);
  assert.equal(todayB.results[0].lastConfirmed.generatedAt, todaySuccessAt);
  assert.ok(todayB.results[0].requestedWindow.endMs >= todayB.results[0].window.endMs);
  now += 86400000;
  const nextDayToday = await module.queryRules({ ruleIds: [rule.id], preset: "today" }, { force: true });
  assert.equal(nextDayToday.results[0].upstream.amountUsd, null, "a different local day must not reuse yesterday's today result");
  assert.equal(nextDayToday.results[0].health.stale, false);
  const otherWindow = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1060000, endMs: 1120000 }, { force: true });
  assert.equal(otherWindow.results[0].upstream.amountUsd, null, "a failed second window must not reuse the first window's cost");
  assert.equal(otherWindow.results[0].lastSuccessfulAt, undefined);
  assert.equal(otherWindow.results[0].health.stale, false);
  const stale = await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(stale.results[0].health.stale, false, "异常账单不能作为后续失败的陈旧成功账单");
  assert.equal(stale.results[0].lastSuccessfulAt, undefined);
});

test("多分段查询不会按分段重复探测上游身份或两侧 /api/status", async (t) => {
  const { createServer } = await import("node:http");
  const upstreamCounts = {};
  const ownCounts = {};
  const statUsers = [];
  let ownStatusBroken = false;
  const serve = (counts, route) => createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    counts[url.pathname] = (counts[url.pathname] || 0) + 1;
    const body = route(url, request) || { success: false };
    response.writeHead(body.success === false ? 500 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const upstreamServer = serve(upstreamCounts, (url, request) => {
    if (url.pathname === "/api/status") return { success: true, data: { quota_per_unit: 100 } };
    if (url.pathname === "/api/user/self") return { success: true, data: { id: 7 } };
    if (url.pathname === "/api/user/self/groups") return { success: true, data: { g1: { ratio: 1 }, g2: { ratio: 2 } } };
    if (url.pathname === "/api/token/") return { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } };
    if (url.pathname === "/api/log/self/stat") {
      statUsers.push(request.headers["new-api-user"]);
      return { success: true, data: { quota: 100 } };
    }
  });
  const ownServer = serve(ownCounts, (url) => {
    if (url.pathname === "/api/user/self") return { success: true, data: { id: 1 } };
    if (url.pathname === "/api/status") return ownStatusBroken ? { success: false, message: "status unavailable" } : { success: true, data: { quota_per_unit: 100 } };
    if (url.pathname === "/api/log/stat") return { success: true, data: { quota: 250 } };
    if (url.pathname === "/api/channel/") return { success: true, data: { total: 1, items: [{ id: 1, name: "渠道", status: 1 }] } };
  });
  await Promise.all([upstreamServer, ownServer].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  t.after(() => { upstreamServer.close(); ownServer.close(); });
  const rule = { id: "rr_request_budget", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [1000000, 1030000, 1060000, 1090000].map((from, index) => ({
    id: `s${index + 1}`, rule_id: rule.id, group_name: index % 2 ? "g2" : "g1", group_ratio: index % 2 ? 2 : 1,
    ratio_observed_at_ms: from, ratio_source: "group_catalog",
    effective_from_ms: from, effective_to_ms: index === 3 ? null : from + 30000,
    detected_at_ms: from, timing_source: "operator_confirmed",
  }));
  const query = async (sql) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道", channel_status: null }]];
    if (sql.includes("effective_to_ms IS NULL")) return [[segments[3]]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
    if (sql.includes("FROM reconciliation_snapshots") || sql.includes("reconciliation_alert_state")) return [[]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const stations = [
    { id: "upstream", type: "newapi", baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, accessToken: "pat" },
    { id: "own", type: "newapi", isOwn: true, baseUrl: `http://127.0.0.1:${ownServer.address().port}`, accessToken: "admin" },
  ];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  trustedLegacyRule(rule, stations, 7, 1);
  const window = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1120000 };

  const { results: [result] } = await module.queryRules(window, { force: true });
  assert.equal(result.segments.length, 4);
  assert.equal(result.health.code, "READY");
  assert.equal(result.upstream.amountUsd, 4);
  assert.equal(result.downstream.amountUsd, 10);
  assert.equal(result.calculation.profitUsd, 6);
  assert.deepEqual(upstreamCounts, {
    "/api/user/self": 1, "/api/status": 1, "/api/user/self/groups": 1, "/api/token/": 1, "/api/log/self/stat": 4,
  }, "上游身份与 /api/status 只在读取元数据时各探测一次，分段只请求自己的 stat");
  assert.deepEqual(statUsers, ["7", "7", "7", "7"], "分段 stat 复用元数据解析出的 PAT 身份");
  assert.deepEqual(ownCounts, { "/api/user/self": 1, "/api/channel/": 1, "/api/status": 1, "/api/log/stat": 4 }, "本站身份和 /api/status 每轮只读一次，由各分段共用");

  for (const counts of [upstreamCounts, ownCounts]) for (const path of Object.keys(counts)) delete counts[path];
  ownStatusBroken = true;
  const { results: [broken] } = await module.queryRules(window, { force: true });
  assert.equal(ownCounts["/api/status"], 1, "本站 /api/status 失败时也不会按分段重试");
  assert.deepEqual(broken.segments.map((segment) => segment.health.issues.map((issue) => issue.code)), Array(4).fill(["OWN_BILLING_UNAVAILABLE"]));
  assert.equal(broken.downstream.amountUsd, null);
  assert.equal(broken.calculation.profitUsd, null);
});

test("检测到 group 或 ratio 变化时关闭旧分段、保留历史并只打开一个新分段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: 2.9, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  const calls = [];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return [[rows.find((row) => row.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) { rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" }); return [{ affectedRows: 1 }]; }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  const segments = await repository.transitionSegment("rr", { group: "g2", ratio: 2.6, detectedAt: 2000 });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].effectiveTo, 2000);
  assert.equal(segments[1].group, "g2");
  assert.equal(segments[1].ratio, 2.6);
  assert.equal(segments.filter((segment) => segment.effectiveTo == null).length, 1);
  assert.equal(calls.filter((call) => call.sql.startsWith("INSERT INTO reconciliation_rule_segments")).length, 1);
});

test("首次观察到已知倍率会补全当前 legacy 分段，随后切组才可保留上一段倍率", async (t) => {
  const { createServer } = await import("node:http");
  let currentGroup = "AWS_Bedrock3";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const body = url.pathname === "/api/status" ? { success: true, data: { quota_per_unit: 100 } }
      : url.pathname === "/api/user/self" ? { success: true, data: { id: 7 } }
        : url.pathname === "/api/user/self/groups" ? { success: true, data: { AWS_Bedrock3: { ratio: 2.9 }, AWS_Bedrock2: { ratio: 2.6 } } }
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, name: "stable", status: 1, group: currentGroup, cross_group_retry: false }] } }
            : url.pathname === "/api/log/self/stat" ? { success: true, data: { quota: 100 } }
              : url.pathname === "/api/log/stat" ? { success: true, data: { quota: 100 } }
                  : url.pathname === "/api/channel/" ? { success: true, data: { items: [{ id: 1, name: "渠道", status: 1 }] } }
                    : { success: false };
    response.writeHead(body.success === false ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const rule = { id: "rr_legacy_ratio", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "AWS_Bedrock3", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  trustedLegacyRule(rule, [{ id: "upstream", type: "newapi", baseUrl: `http://127.0.0.1:${server.address().port}` },
    { id: "own", baseUrl: `http://127.0.0.1:${server.address().port}` }]);
  const segments = [{ id: "s_legacy", rule_id: rule.id, group_name: "AWS_Bedrock3", group_ratio: null, effective_from_ms: 0, effective_to_ms: null, detected_at_ms: 0, timing_source: "legacy" }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道" }]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[{ rule_id: rule.id, channel_id: 1, channel_name: "渠道" }]];
          if (sql.includes("effective_to_ms IS NULL") && sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) return [{ affectedRows: 1 }];
          if (sql.startsWith("UPDATE reconciliation_rules SET token_name")) return [{ affectedRows: 1 }];
          if (sql.includes("FOR UPDATE")) return [[segments.find((segment) => segment.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) { segments[0].group_ratio = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { segments[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            segments.push({ id: params[0], rule_id: rule.id, group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(segments[0].group_ratio, 2.9, "same-group first observation must backfill the current open segment ratio");
  assert.equal(segments.length, 1, "a normal single-group rule must not gain a segment while its ratio is first observed");
  currentGroup = "AWS_Bedrock2";
  await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].group_ratio, 2.9, "the closed predecessor keeps its observed ratio");
  assert.equal(segments[1].group_name, "AWS_Bedrock2");
  assert.equal(segments[1].group_ratio, 2.6);
});

test("已迁移的倍率未知分段在上游首次返回倍率时补全当前分段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "legacy" }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows[0]]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) { rows[0].group_ratio = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) { rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" }); return [{ affectedRows: 1 }]; }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const segments = await new ReconciliationRepository(pool).transitionSegment("rr", { group: "g1", ratio: 2.9, detectedAt: 2000 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].effectiveFrom, 1000);
  assert.equal(segments[0].effectiveTo, null);
  assert.equal(segments[0].ratio, 2.9);
});

test("首次检测已切组时用仍存在的旧组目录倍率补全旧段，再开启新段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "AWS-Bedrock3", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "legacy", ratio_observed_at_ms: null, ratio_source: null }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows.find((row) => row.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) {
            rows[0].group_ratio = params[0]; rows[0].ratio_observed_at_ms = params[1]; rows[0].ratio_source = "group_catalog";
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], ratio_observed_at_ms: params[4], ratio_source: params[5], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  const result = await repository.reconcileCurrentSegment("rr", { group: "AWS-Bedrock2", ratio: 3, currentSegmentRatio: 2.9, detectedAt: 2000 });
  assert.equal(result.transitioned, true);
  assert.equal(result.ratioBackfilled, true);
  assert.deepEqual(result.segments.map((segment) => [segment.group, segment.ratio]), [["AWS-Bedrock3", 2.9], ["AWS-Bedrock2", 3]]);
  assert.equal(result.segments[0].ratioSource, "group_catalog");
  const repeated = await repository.reconcileCurrentSegment("rr", { group: "AWS-Bedrock2", ratio: 3, currentSegmentRatio: 3, detectedAt: 3000 });
  assert.equal(repeated.transitioned, false);
  assert.equal(repeated.ratioBackfilled, false);
  assert.equal(repeated.segments.length, 2, "unchanged refreshes must not create extra segments");
});

test("旧组已不在本轮目录时切组不会伪造旧段倍率", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "AWS-Bedrock3", group_ratio: null, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "legacy" }];
  const pool = {
    async query(sql) { if (sql.includes("FROM reconciliation_rule_segments")) return [rows]; throw new Error(`unexpected query: ${sql}`); },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows[0]]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) { rows[0].effective_to_ms = params[0]; return [{ affectedRows: 1 }]; }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) { rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" }); return [{ affectedRows: 1 }]; }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const result = await new ReconciliationRepository(pool).reconcileCurrentSegment("rr", { group: "AWS-Bedrock2", ratio: 3, currentSegmentRatio: null, detectedAt: 2000 });
  assert.equal(result.ratioBackfilled, false);
  assert.equal(result.segments[0].ratio, null);
  assert.equal(result.segments[1].ratio, 3);
});

test("切回原分组仍保留新的历史分段", async () => {
  const rows = [{ id: "s1", rule_id: "rr", group_name: "g1", group_ratio: 2.9, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FOR UPDATE")) return [[rows.find((row) => row.effective_to_ms == null)]];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            rows.find((row) => row.id === params[1]).effective_to_ms = params[0];
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
            rows.push({ id: params[0], rule_id: "rr", group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  await repository.transitionSegment("rr", { group: "g2", ratio: 2.6, detectedAt: 2000 });
  const segments = await repository.transitionSegment("rr", { group: "g1", ratio: 2.9, detectedAt: 3000 });
  assert.deepEqual(segments.map((segment) => segment.group), ["g1", "g2", "g1"]);
  assert.deepEqual(segments.map((segment) => segment.effectiveTo), [2000, 3000, null]);
});

test("修正切换时间锁定相邻分段，并保留旧快照作为历史证据", async () => {
  const rows = [
    { id: "s1", rule_id: "rr", effective_from_ms: 1000, effective_to_ms: 2000, created_at: "2026-01-01" },
    { id: "s2", rule_id: "rr", effective_from_ms: 2000, effective_to_ms: 3000, created_at: "2026-01-02" },
    { id: "s3", rule_id: "rr", effective_from_ms: 3000, effective_to_ms: null, created_at: "2026-01-03" },
  ];
  const calls = [];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return [rows];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            rows[0].effective_to_ms = params[1];
            rows[1].effective_from_ms = params[3];
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const segments = await new ReconciliationRepository(pool).correctTransition("rr", "s2", 2500);
  assert.equal(segments[0].effectiveTo, 2500);
  assert.equal(segments[1].effectiveFrom, 2500);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
  assert.ok(calls.some((call) => call.sql?.includes("FOR UPDATE")));
  assert.equal(calls.some((call) => call.sql?.startsWith("DELETE FROM reconciliation_snapshots")), false);
});

test("查询中修正切换时间后，旧失败任务不会写入或缓存旧分段结果", async () => {
  const rule = { id: "rr_race_scope", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  trustedLegacyRule(rule);
  const segments = [
    { id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: rule.id, group_name: "g2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "detected" },
  ];
  let releaseOldRead;
  let delayOldRead = true;
  const writes = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) {
        if (delayOldRead) {
          delayOldRead = false;
          return new Promise((resolve) => { releaseOldRead = () => resolve([segments.map((row) => ({ ...row, effective_to_ms: row.id === "s1" ? 2000 : null, effective_from_ms: row.id === "s2" ? 2000 : row.effective_from_ms }))]); });
        }
        return [segments];
      }
      if (sql.includes("FROM reconciliation_snapshots")) return [[]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
          if (sql.includes("FOR UPDATE")) return [segments];
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            segments[0].effective_to_ms = params[1];
            segments[1].effective_from_ms = params[3];
            segments[1].timing_source = "operator_confirmed";
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const module = createReconciliationModule(rt);
  const pending = module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 }, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  await module.correctTransition(rule.id, "s2", 2500);
  releaseOldRead();
  const { results } = await pending;

  assert.equal(results[0].currentSegment.id, "s2");
  assert.equal(results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(writes.length, 1, "only the restarted query may persist an unavailable snapshot");
  assert.equal(writes[0][1], "s2", "the old task must not write the pre-correction segment");
  assert.equal([...rt._reconciliationResultCache.values()][0].value.currentSegment.effectiveFrom, 2500);
});

test("加入同一 in-flight 查询的调用方在口径变化后也只拿到新口径结果", async () => {
  const rule = { id: "rr_joined_scope", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  trustedLegacyRule(rule);
  const segments = [
    { id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: rule.id, group_name: "g2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "detected" },
  ];
  let releaseOldRead;
  let delayOldRead = true;
  const writes = [];
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) {
        if (delayOldRead) {
          delayOldRead = false;
          return new Promise((resolve) => { releaseOldRead = () => resolve([segments.map((row) => ({ ...row, effective_to_ms: row.id === "s1" ? 2000 : null, effective_from_ms: row.id === "s2" ? 2000 : row.effective_from_ms }))]); });
        }
        return [segments];
      }
      if (sql.includes("FROM reconciliation_snapshots")) return [[]];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) { writes.push(params); return [{ affectedRows: 1 }]; }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            segments[0].effective_to_ms = params[1];
            segments[1].effective_from_ms = params[3];
            segments[1].timing_source = "operator_confirmed";
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = module.queryRules(input, { force: true });
  await tick();
  const joined = module.queryRules(input);
  for (let i = 0; i < 5; i += 1) await tick();
  await module.correctTransition(rule.id, "s2", 2500);
  releaseOldRead();
  const [firstResponse, joinedResponse] = await Promise.all([first, joined]);

  assert.equal(firstResponse.results[0].currentSegment.effectiveFrom, 2500);
  // 路由把结果序列化成 JSON；内部作废标记一旦漏出就会变成 null，前端读取 requestedWindow 时崩溃。
  const joinedJson = JSON.parse(JSON.stringify(joinedResponse));
  assert.notEqual(joinedJson.results[0], null);
  assert.equal(joinedJson.results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(writes.length, 1, "两个调用方共享一次重跑，只写入一次新口径快照");
});

test("查询期间口径持续变化时最多尝试 3 次，本轮返回待获取且不缓存", async () => {
  const rule = { id: "rr_unstable_scope", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segments = [{ id: "s1", rule_id: rule.id, group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" }];
  let channelReads = 0;
  let segmentReads = 0;
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      // 每次读取都像刚被编辑过一样换一个渠道，口径指纹永远对不上。
      if (sql.includes("FROM reconciliation_rule_channels")) {
        channelReads += 1;
        // 重试一旦失去上限，就在这里失败而不是让测试挂死。
        if (channelReads > 20) throw new Error("口径重试没有上限");
        return [[{ rule_id: rule.id, channel_id: channelReads, channel_name: `渠道 ${channelReads}` }]];
      }
      if (sql.includes("FROM reconciliation_rule_segments")) {
        segmentReads += 1;
        return [segments];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() { throw new Error("口径不一致时不能开启快照写入事务"); },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const module = createReconciliationModule(rt);
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 };

  const { results } = await module.queryRules(input, { force: true });
  assert.equal(results[0].rule.id, rule.id);
  assert.equal(results[0].health.code, "PENDING", "口径被连续改动时只让这条规则本轮待获取，不能让整个查询失败");
  assert.equal(results[0].calculation.profitUsd, null);
  assert.equal(results[0].requestedWindow.endMs, 3000);
  assert.equal(segmentReads, 3, "每次尝试读取一次分段，总共只尝试 3 次");
  assert.equal(rt._reconciliationResultCache.size, 0, "待获取结果不能进缓存");

  await module.queryRules(input);
  assert.equal(segmentReads, 6, "下一轮非强制查询必须重新取数，不能命中待获取结果");
});

// 测试中途可挂起的检查点：hold() 挂起调用方并让 reached 完成，release() 放行。
function holdPoint() {
  let reach;
  let release;
  const reached = new Promise((resolve) => { reach = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { reached, release, hold: () => { reach(); return released; } };
}

// 上游站点缺失的规则走不可用落库路径，不需要网络；成功账单查询、告警读取、快照事务提交都可挂起，
// 用来在查询中途插入切换时间修正。
function scopeRaceFixture(id, { beforeLookup = null, beforeAlertRead = null, beforeSnapshotCommit = null } = {}) {
  const rule = { id, upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g2", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  trustedLegacyRule(rule);
  const segments = [
    { id: "s1", rule_id: id, group_name: "g1", group_ratio: 2, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "operator_confirmed" },
    { id: "s2", rule_id: id, group_name: "g2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "detected" },
  ];
  const state = { writes: [], lookups: 0, alertInserts: 0 };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [segments];
      if (sql.includes("FROM reconciliation_snapshots")) {
        state.lookups += 1;
        await beforeLookup?.(state.lookups);
        return [[]];
      }
      if (sql.includes("SELECT * FROM reconciliation_alert_state")) {
        await beforeAlertRead?.();
        return [[]];
      }
      if (sql.includes("INSERT INTO reconciliation_alert_state")) state.alertInserts += 1;
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      let wroteSnapshots = false;
      return {
        async beginTransaction() {}, async rollback() {}, release() {},
        async commit() { if (wroteSnapshots) await beforeSnapshotCommit?.(); },
        async query(sql, params) {
          if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) return [[rule]];
          if (sql.includes("FROM reconciliation_rule_channels") && sql.includes("FOR UPDATE")) return [[]];
          if (sql.includes("FROM reconciliation_rule_segments") && sql.includes("FOR UPDATE")) return [segments];
          if (sql.includes("FROM reconciliation_snapshots")) return [[]];
          if (sql.includes("INSERT INTO reconciliation_snapshots")) {
            wroteSnapshots = true;
            state.writes.push(params);
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith("UPDATE reconciliation_rule_segments")) {
            segments[0].effective_to_ms = params[1];
            segments[1].effective_from_ms = params[3];
            segments[1].timing_source = "operator_confirmed";
            return [{ affectedRows: 2 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const input = { ruleIds: [id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 };
  return { rule, state, rt, input, module: createReconciliationModule(rt) };
}

test("编辑后已有调用方按新口径另起任务时，旧任务直接等它，不重复取数和写快照", async () => {
  const lookups = [holdPoint(), holdPoint()];
  const { rule, state, module, input } = scopeRaceFixture("rr_join_newer", { beforeLookup: (count) => lookups[count - 1]?.hold() });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const older = module.queryRules(input, { force: true });
  await lookups[0].reached;
  await module.correctTransition(rule.id, "s2", 2500);
  const newer = module.queryRules(input, { force: true });
  await lookups[1].reached;
  lookups[0].release();
  for (let i = 0; i < 5; i += 1) await tick();
  lookups[1].release();
  const [olderResponse, newerResponse] = await Promise.all([older, newer]);

  assert.equal(olderResponse.results[0], newerResponse.results[0], "旧任务直接复用新口径任务的结果");
  assert.equal(olderResponse.results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(state.lookups, 2, "旧任务作废后不能自己再重跑一轮");
  assert.equal(state.writes.length, 1, "两个任务只写入一次新口径快照");
  assert.equal(state.writes[0][1], "s2");
});

test("落库和通知期间口径被修正时，旧口径结果既不返回也不缓存", async () => {
  const alertRead = holdPoint();
  let held = false;
  const { rule, rt, module, input } = scopeRaceFixture("rr_generation_race", {
    beforeAlertRead: () => {
      if (held) return;
      held = true;
      return alertRead.hold();
    },
  });
  const pending = module.queryRules(input, { force: true });
  await alertRead.reached;
  await module.correctTransition(rule.id, "s2", 2500);
  alertRead.release();
  const { results } = await pending;

  assert.equal(results[0].currentSegment.effectiveFrom, 2500);
  assert.equal([...rt._reconciliationResultCache.values()][0].value.currentSegment.effectiveFrom, 2500);
});

test("快照事务提交后、通知前口径被修正时，不为旧口径记录告警", async () => {
  const commit = holdPoint();
  let held = false;
  const { rule, state, module, input } = scopeRaceFixture("rr_notify_race", {
    beforeSnapshotCommit: () => {
      if (held) return;
      held = true;
      return commit.hold();
    },
  });
  const pending = module.queryRules(input, { force: true });
  await commit.reached;
  await module.correctTransition(rule.id, "s2", 2500);
  commit.release();
  const { results } = await pending;

  assert.equal(results[0].currentSegment.effectiveFrom, 2500);
  assert.equal(state.alertInserts, 1, "只能按新口径记录一次告警状态");
});

// 真实取数路径的夹具：两侧 NewAPI 由 fetch 替身应答，数据库按 SQL 路由。
// 每个分段上游消费 $1、本站渠道收费 $2.5，利润 $1.5。
function liveReconciliationFixture(t, { segments: specs, extraRuleIds = [], duplicateKeys = false, failSnapshotForRule = null, onRequest = null, metadataGroups = null, metadataFailure = false, failLatestLookup = false, ownChannels = null, channelsByRule = {}, channelObservedAt = null, onSnapshotInsert = null, onRepositoryConnection = null, onRepositoryCommit = null }) {
  const ratios = { g1: 1, g2: 2 };
  const segments = specs.map(({ id, group, from, to = null, ratio = ratios[group] }) => ({
    id, rule_id: "rr_live", group_name: group, group_ratio: ratio,
    ratio_observed_at_ms: from, ratio_source: "group_catalog",
    effective_from_ms: from, effective_to_ms: to, detected_at_ms: from, timing_source: "operator_confirmed",
  }));
  const open = segments.find((segment) => segment.effective_to_ms == null);
  const rule = { id: "rr_live", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: open.group_name, timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const rules = [rule, ...extraRuleIds.map((id, index) => ({ ...rule, id, token_id: duplicateKeys ? 9 : 10 + index, token_name: duplicateKeys ? "stable" : `stable-${id}` }))];
  const allSegments = [...segments, ...extraRuleIds.flatMap((ruleId) => segments.map((segment) => ({ ...segment, id: `${segment.id}-${ruleId}`, rule_id: ruleId })) )];
  const state = { upstreamQuota: 100, ownQuota: 250, statCalls: [], requests: [], writes: 0, alertQueries: 0, snapshots: new Map(), channelStates: new Map(), channelStateWrites: [], ratioWrites: [], commits: [] };
  const query = async (sql, params) => {
    if (sql.includes("INSERT INTO reconciliation_snapshots")) {
      if (failSnapshotForRule === params[0]) throw new Error("snapshot insert rejected");
      state.writes += 1;
      state.snapshots.set(params[2], {
        rule_id: params[0], segment_id: params[1], snapshot_key: params[2], window_kind: params[3],
        window_start_ms: params[4], window_end_ms: params[5], health_code: params[16], health_detail: params[17],
        source: params[18], generated_at: new Date().toISOString(),
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT source FROM reconciliation_snapshots") && sql.includes("snapshot_key = ?")) return [[state.snapshots.get(params[1])].filter(Boolean)];
    if (sql.includes("FROM reconciliation_snapshots")) {
      if (failLatestLookup && sql.includes("snapshot_key LIKE")) throw new Error("latest snapshot lookup failed");
      return [[...state.snapshots.values()].filter((snapshot) => !params?.[0] || snapshot.rule_id === params[0])];
    }
    if (sql.includes("reconciliation_alert_state")) {
      state.alertQueries += 1;
      return [[]];
    }
    if (sql.includes("effective_to_ms IS NULL")) return [[allSegments.find((segment) => segment.rule_id === params?.[0] && segment.effective_to_ms == null)]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [allSegments.filter((segment) => !params?.[0] || segment.rule_id === params[0])];
    if (sql.includes("FROM reconciliation_rule_channels")) {
      const ids = Array.isArray(params?.[0]) ? params[0] : [params?.[0] || rule.id];
      return [ids.flatMap((ruleId) => (channelsByRule[ruleId] || [1]).map((channelId) => ({ rule_id: ruleId, channel_id: channelId, channel_name: channelsByRule[ruleId] ? `渠道 ${channelId}` : "渠道", channel_status: null, status_observed_at_ms: channelObservedAt })))];
    }
    if (sql.includes("FROM reconciliation_rules")) return [rules.filter((item) => (!params?.[0] || item.id === params[0]) && (!sql.includes("archived_at IS NULL") || !item.archived_at))];
    if (sql.startsWith("UPDATE reconciliation_rules SET enabled = 0, active_token_key = NULL")) {
      const archived = rules.find((item) => item.id === params[0] && !item.archived_at);
      if (!archived) return [{ affectedRows: 0 }];
      Object.assign(archived, { enabled: 0, active_token_key: null, archived_at: new Date().toISOString() });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE reconciliation_rules") && sql.includes("active_token_key = ?")) {
      const updated = rules.find((item) => item.id === params[15]);
      if (!updated) return [{ affectedRows: 0 }];
      [updated.upstream_station_id, updated.own_station_id, updated.token_id, updated.token_name,
        updated.fixed_group, updated.timezone, updated.enabled, updated.active_token_key,
        updated.billing_policy, updated.scope_version, updated.billing_effective_from_ms,
        updated.cost_coverage, updated.provider, updated.canonical_key, updated.source_binding] = params;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE reconciliation_rules SET provider = ?")) {
      const updated = rules.find((item) => item.id === params[3]);
      if (!updated) return [{ affectedRows: 0 }];
      [updated.provider, updated.canonical_key, updated.source_binding] = params;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) {
      const segment = segments.find((item) => item.id === params[2]);
      state.ratioWrites.push(params[0]);
      if (segment) segment.group_ratio = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE reconciliation_rule_segments SET effective_to_ms")) {
      const segment = segments.find((item) => item.id === params[1]);
      if (segment) segment.effective_to_ms = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) {
      segments.push({ id: params[0], rule_id: params[1], group_name: params[2], group_ratio: params[3], effective_from_ms: params[6], effective_to_ms: null, detected_at_ms: params[7], timing_source: "detected" });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("UPDATE reconciliation_rule_channels") && !sql.includes("active_channel_key = NULL")) {
      state.channelStateWrites.push(params[0]);
      state.channelStates.set(params[5], params[0]);
      return [{ affectedRows: 1 }];
    }
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      await onRepositoryConnection?.();
      const transaction = { snapshots: [], archivedRuleIds: [] };
      return { async query(sql, params) {
        const result = await query(sql, params);
        if (sql.includes("INSERT INTO reconciliation_snapshots")) {
          const snapshot = { ruleId: params[0], source: JSON.parse(params.at(-1)) };
          transaction.snapshots.push(snapshot);
          await onSnapshotInsert?.(snapshot);
        }
        if (sql.startsWith("UPDATE reconciliation_rules SET enabled = 0, active_token_key = NULL")) transaction.archivedRuleIds.push(params[0]);
        return result;
      }, async beginTransaction() {}, async commit() { await onRepositoryCommit?.(transaction); state.commits.push(transaction); }, async rollback() {}, release() {} };
    },
  };
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const stat = (side, url, quota) => {
    state.statCalls.push({ side, start: Number(url.searchParams.get("start_timestamp")), end: Number(url.searchParams.get("end_timestamp")) });
    return quota == null ? reply(500, { success: false }) : reply(200, { success: true, data: { quota } });
  };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    const request = { host: url.host, path: url.pathname, authorization: init.headers?.Authorization ?? null };
    state.requests.push(request);
    if (onRequest) await onRequest(request);
    if (url.pathname === "/api/status") return reply(200, { success: true, data: { quota_per_unit: 100, version: "v" } });
    if (url.host === "upstream.test") {
      if (url.pathname === "/api/user/self") return reply(200, { success: true, data: { id: 7 } });
      if (url.pathname === "/api/user/self/groups") return reply(200, { success: true, data: metadataGroups ? metadataGroups(request) : { g1: { ratio: 1 }, g2: { ratio: 2 } } });
      if (url.pathname === "/api/token/") {
        if (metadataFailure) return reply(500, { success: false });
        const distinct = [...new Map(rules.map((item) => [item.token_id, item])).values()];
        return reply(200, { success: true, data: { total: distinct.length, items: distinct.map((item) => ({ id: item.token_id, name: item.token_name, status: 1, group: rule.fixed_group, cross_group_retry: false })) } });
      }
      if (url.pathname === "/api/log/self/stat") return stat("upstream", url, state.upstreamQuota);
    }
    if (url.host === "own.test") {
      if (url.pathname === "/api/user/self") return reply(200, { success: true, data: { id: 1 } });
      if (url.pathname === "/api/channel/") {
        const items = ownChannels ? ownChannels(request) : [{ id: 1, name: "渠道", status: 1 }];
        return reply(200, { success: true, data: { total: items.length, items } });
      }
      if (url.pathname === "/api/log/stat") return stat("own", url, state.ownQuota);
    }
    return reply(404, { success: false });
  });
  const stations = [
    { id: "upstream", name: "上游", type: "newapi", baseUrl: "https://upstream.test", accessToken: "pat", authVersion: 1 },
    { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin", authVersion: 1 },
  ];
  const rt = { pool, store: { list: () => stations, get: (stationId) => stations.find((station) => station.id === stationId) || null, channels: [] } };
  return { rule, state, segments, stations, rt, module: createReconciliationModule(rt) };
}

test("上游分组目录缺少当前组时仍独立获取本站渠道收费", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    metadataGroups: () => ({ g2: { ratio: 2 } }),
  });

  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });

  assert.equal(results[0].health.issues.some((issue) => issue.code === "GROUP_DATA_UNAVAILABLE"), true);
  assert.equal(results[0].downstream.knownAmountUsd, 2.5);
  assert.equal(state.statCalls.filter((call) => call.side === "own").length, 1, "目录异常不能阻断本站账单请求");
});

test("当前组倍率无效时父级不回显历史倍率，历史分段仍保留证据", async (t) => {
  const { rule, segments, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", ratio: 3, from: 1000 }],
    metadataGroups: () => ({ g1: { ratio: null }, g2: { ratio: 2 } }),
  });
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });

  assert.equal(results[0].upstream.ratio, null);
  assert.equal(results[0].currentSegment.ratio, 3);
  assert.equal(segments[0].group_ratio, 3);
  assert.equal(state.ratioWrites.length, 0);
  assert.ok(results[0].health.issues.some((issue) => issue.code === "GROUP_DATA_UNAVAILABLE"));
});

test("本站站点缺失时仍独立获取已确认上游成本", async (t) => {
  const { rule, state, stations, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
  });
  stations[1].isOwn = false;
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });
  assert.equal(results[0].upstream.amountUsd, 1);
  assert.equal(results[0].downstream.state, "unavailable");
  assert.equal(state.statCalls.filter((call) => call.side === "upstream").length, 1);
  assert.equal(state.statCalls.filter((call) => call.side === "own").length, 0);
});

test("上游元数据失败时按适用分段独立保留本站渠道收费和渠道状态", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: 1000, to: 1030000 },
      { id: "s2", group: "g2", from: 1030000 },
    ],
    metadataFailure: true,
    ownChannels: () => [{ id: 1, name: "渠道", status: 2 }],
  });

  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });

  const result = results[0];
  assert.equal(result.health.code, "UPSTREAM_DATA_UNAVAILABLE");
  assert.equal(result.downstream.state, "complete");
  assert.equal(result.downstream.amountUsd, 5);
  assert.equal(result.downstream.successfulCount, 2);
  assert.equal(result.downstream.expectedCount, 2);
  assert.equal(result.downstream.channels[0].state, "manual_disabled");
  assert.deepEqual(state.statCalls.filter((call) => call.side === "own").map(({ start, end }) => [start, end]), [[1000, 1029], [1030, 1059]]);
});

test("今天窗口刚过零点不满一个统计秒时返回待获取并持久化 observation", async (t) => {
  const dayStart = Date.parse("2026-09-19T16:00:00.000Z"); // Asia/Shanghai 2026-09-20 00:00
  const { rule, rt, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: dayStart - 3600000 }] });
  const realNow = Date.now;
  let now = dayStart + 500;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const input = { ruleIds: [rule.id], preset: "today", timezone: "Asia/Shanghai" };

  await module.refreshDue(now);
  const pending = await module.queryRules(input);
  assert.equal(pending.results[0].health.code, "PENDING");
  assert.equal(pending.results[0].calculation.profitUsd, null);
  assert.deepEqual(state.statCalls, [], "不满一秒的窗口不能向任何一侧请求统计");
  assert.equal(state.writes, 2, "待获取也要保留本轮 observation，供重启后读取");
  assert.ok([...state.snapshots.values()].every((snapshot) => JSON.parse(snapshot.source).recordType === "observation"));
  assert.equal(state.alertQueries, 0, "待获取既不能告警也不能清除告警");
  assert.equal(rt._reconciliationResultCache.size, 0, "待获取不能进缓存");

  now = dayStart + 1500;
  const ready = await module.queryRules(input);
  assert.equal(ready.results[0].health.code, "READY", "满一个统计秒后，非强制查询必须立即重新核算");
  assert.equal(ready.results[0].calculation.profitUsd, 1.5);
});

test("规则刚创建不满一个统计秒时，今天和近 7 天都返回待获取", async (t) => {
  const createdAt = Date.parse("2026-09-20T04:26:08.200Z");
  const { rule, rt, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: createdAt }] });
  const realNow = Date.now;
  let now = createdAt + 700;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  for (const preset of ["today", "7d"]) {
    const { results } = await module.queryRules({ ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" }, { force: true });
    assert.equal(results[0].health.code, "PENDING", `${preset} 不能把不满一秒的新分段当成上游数据不可用`);
  }
  assert.deepEqual(state.statCalls, []);
  assert.equal(state.writes, 2, "两个待获取窗口各自持久化 observation");
  assert.equal(state.alertQueries, 0);
  assert.equal(rt._reconciliationResultCache.size, 0);

  now = createdAt + 2000;
  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "today", timezone: "Asia/Shanghai" });
  assert.equal(results[0].health.code, "READY");
  assert.equal(results[0].calculation.profitUsd, 1.5);
});

test("今天和近 7 天刚切段且新分段不足一秒时，不把已结束分段冒充整窗确认账单", async (t) => {
  const switchedAt = Date.parse("2026-09-20T04:26:08.000Z") + 900;
  const { rule, state, rt, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: switchedAt - 3600000, to: switchedAt },
      { id: "s2", group: "g2", from: switchedAt },
    ],
  });
  const realNow = Date.now;
  let now = switchedAt + 300;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  for (const preset of ["today", "7d"]) {
    const { results } = await module.queryRules({ ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" }, { force: true });
    assert.equal(results[0].health.code, "PENDING", `${preset} 不能确认缺少最新分段的整窗账单`);
    assert.equal(results[0].currentSegment.id, "s2");
    assert.equal(results[0].calculation.profitUsd, null);
  }
  assert.equal(state.statCalls.length, 4, "旧的完整分段仍应独立取数，不能被不足一秒的新尾段丢弃");
  assert.equal(state.writes, 4, "每个窗口的两个分段都持久化 observation");
  assert.equal(rt._reconciliationResultCache.size, 0);

  now = switchedAt + 2000;
  const ready = await module.queryRules({ ruleIds: [rule.id], preset: "7d", timezone: "Asia/Shanghai" });
  assert.equal(ready.results[0].health.code, "READY");
  assert.deepEqual(ready.results[0].segments.map((segment) => segment.id), ["s1", "s2"]);
  assert.equal(ready.results[0].calculation.profitUsd, 3);
});

test("窗口完全在规则生效之前时照常核算为 0，不返回不会自行恢复的待获取", async (t) => {
  const createdAt = Date.parse("2026-09-20T02:00:00.000Z"); // Asia/Shanghai 2026-09-20 10:00
  const { rule, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: createdAt }] });
  const realNow = Date.now;
  Date.now = () => createdAt + 7200000;
  t.after(() => { Date.now = realNow; });

  const inputs = [
    { ruleIds: [rule.id], preset: "yesterday", timezone: "Asia/Shanghai" },
    { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: createdAt - 7200000, endMs: createdAt - 3600000 },
  ];
  for (const input of inputs) {
    const { results } = await module.queryRules(input, { force: true });
    assert.equal(results[0].health.code, "READY", `${input.preset} 窗口内规则尚未生效，应按 0 核算`);
    assert.equal(results[0].calculation.profitUsd, 0);
  }
  assert.deepEqual(state.statCalls, [], "没有相交分段时不需要请求任何一侧的统计");
});

test("今天和近 7 天中间有不满一秒的已结束分段时不能跳过，按不可核算处理", async (t) => {
  const switchedAt = Date.parse("2026-09-20T04:26:08.200Z");
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: switchedAt - 3600000, to: switchedAt },
      { id: "s2", group: "g2", from: switchedAt, to: switchedAt + 500 },
      { id: "s3", group: "g1", from: switchedAt + 500 },
    ],
  });
  const realNow = Date.now;
  Date.now = () => switchedAt + 3600000;
  t.after(() => { Date.now = realNow; });

  for (const preset of ["today", "7d"]) {
    state.statCalls.length = 0;
    const { results } = await module.queryRules({ ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" }, { force: true });
    assert.equal(results[0].health.code, "PENDING", `${preset} 有未满一秒的分段时整窗仍待获取`);
    assert.equal(results[0].calculation.profitUsd, null);
    assert.deepEqual(results[0].segments.map((segment) => [segment.id, segment.health.code]), [["s1", "READY"], ["s2", "PENDING"], ["s3", "READY"]]);
    assert.equal(state.statCalls.length, 4, `${preset} 两侧只统计 s1 和 s3`);
  }
});

test("两侧都已应答的上游空消费异常不能被旧的确认利润掩盖，数据源不可用时才回退", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000 }] });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const confirmed = await module.queryRules(input, { force: true });
  assert.equal(confirmed.results[0].calculation.profitUsd, 1.5);
  assert.equal(state.writes, 2, "完整结果保存 observation 与 confirmed 两份记录");
  const savedSource = [...state.snapshots.values()][0].source;

  state.upstreamQuota = 0;
  const anomaly = await module.queryRules(input, { force: true });
  assert.equal(anomaly.results[0].health.code, "UPSTREAM_EMPTY_WITH_SALES");
  assert.equal(anomaly.results[0].health.stale, false, "两侧都已应答时展示本轮异常，不能回退到旧账单");
  assert.equal(anomaly.results[0].calculation.profitUsd, null);
  assert.equal(anomaly.results[0].calculation.riskDifferenceUsd, 2.5);
  assert.equal(state.writes, 3, "未确认异常追加 observation，不覆盖 confirmed");
  assert.ok([...state.snapshots.values()].some((snapshot) => JSON.parse(snapshot.source).recordType === "confirmed"));

  state.upstreamQuota = null;
  const unavailable = await module.queryRules(input, { force: true });
  assert.equal(unavailable.results[0].health.code, "UPSTREAM_DATA_UNAVAILABLE");
  assert.equal(unavailable.results[0].health.stale, false);
  assert.equal(unavailable.results[0].calculation.profitUsd, null);
  assert.equal(unavailable.results[0].lastConfirmed.calculation.profitUsd, 1.5);
  assert.equal(state.writes, 4);
});

test("多分段两侧取数并行发出", async (t) => {
  let arrived = 0;
  let releaseStats;
  const allStatsInFlight = new Promise((resolve) => { releaseStats = resolve; });
  const { rule, module } = liveReconciliationFixture(t, {
    segments: [
      { id: "s1", group: "g1", from: 1000000, to: 1030000 },
      { id: "s2", group: "g2", from: 1030000 },
    ],
    // 两个分段 × 两侧共 4 个统计请求全部发出后才统一应答；串行取数会卡在第一个分段。
    onRequest: async ({ path }) => {
      if (!path.startsWith("/api/log/")) return;
      if (++arrived === 4) releaseStats();
      await allStatsInFlight;
    },
  });
  let timeout;
  try {
    const { results } = await Promise.race([
      module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("分段取数被串行化")), 2000); }),
    ]);
    assert.equal(results[0].health.code, "READY");
    assert.equal(results[0].calculation.profitUsd, 3);
  } finally {
    clearTimeout(timeout);
    releaseStats();
  }
});

test("站点凭据原地改写后，元数据和渠道目录缓存不再复用旧凭据读到的数据", async (t) => {
  let hold = null;
  const { stations, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    onRequest: (request) => hold?.(request),
  });
  const requestsTo = (host, path) => state.requests.filter((request) => request.host === host && request.path === path);

  await module.getUpstreamKeys("upstream");
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 1, "同一凭据在有效期内复用缓存");
  stations[0].accessToken = "pat-2";
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 2, "换了 PAT 后必须重新读取");
  assert.equal(requestsTo("upstream.test", "/api/token/").at(-1).authorization, "Bearer pat-2");

  // 请求发出后凭据才被改写：缓存要记在发起请求时的凭据名下，不能把旧 PAT 读到的数据当成新 PAT 的。
  const identityProbe = holdPoint();
  hold = (request) => {
    if (request.path !== "/api/user/self") return;
    hold = null;
    return identityProbe.hold();
  };
  const inFlight = module.getUpstreamKeys("upstream", { force: true });
  await identityProbe.reached;
  stations[0].accessToken = "pat-3";
  identityProbe.release();
  await inFlight;
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 3);
  assert.equal(requestsTo("upstream.test", "/api/token/").at(-1).authorization, "Bearer pat-2");
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 4, "旧 PAT 读到的数据不能记到新 PAT 名下");

  await module.getConfiguration();
  await module.getConfiguration();
  assert.equal(requestsTo("own.test", "/api/channel/").length, 1);
  stations[1].accessToken = "admin-2";
  const configuration = await module.getConfiguration();
  assert.equal(requestsTo("own.test", "/api/channel/").length, 2, "换了本站管理员令牌后必须重新读取渠道目录");
  assert.equal(requestsTo("own.test", "/api/channel/").at(-1).authorization, "admin-2");
  assert.equal(configuration.channelsError, null);
});

test("最近确认快照读取失败不丢弃本轮 observation 和 confirmed 写入", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }], failLatestLookup: true,
  });
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });
  assert.equal(results[0].calculation.profitUsd, 1.5);
  assert.equal(results[0].lastConfirmed, undefined);
  assert.equal(state.writes, 2, "参考读取失败不能跳过 observation 与 confirmed 双写");
});

test("同批规则中快照写入失败只返回该规则的 PERSISTENCE_FAILED", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    extraRuleIds: ["rr_snapshot_fail"], channelsByRule: { rr_snapshot_fail: [2] }, failSnapshotForRule: "rr_snapshot_fail",
  });
  const { results } = await module.queryRules({
    ruleIds: [rule.id, "rr_snapshot_fail"], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000,
  }, { force: true });
  assert.equal(results.length, 2);
  assert.equal(results[0].calculation.profitUsd, 1.5);
  assert.equal(results[1].health.code, "PERSISTENCE_FAILED");
  assert.equal(results[1].calculation.profitUsd, null);
  assert.equal(results[1].upstream.state, "unavailable");
  assert.equal(results[1].downstream.calculationVersion, 3);
  assert.equal(state.writes, 2, "正常规则仍须完成 observation 与 confirmed 双写");
});

test("分段账单查询最多同时推进六个分段", async (t) => {
  let active = 0;
  let peak = 0;
  const segments = Array.from({ length: 9 }, (_, index) => ({
    id: `s${index}`, group: index % 2 ? "g2" : "g1",
    from: 1000000 + index * 10000,
    to: index === 8 ? null : 1000000 + (index + 1) * 10000,
  }));
  const { rule, module } = liveReconciliationFixture(t, {
    segments,
    onRequest: async ({ path }) => {
      if (!path.startsWith("/api/log/")) return;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
    },
  });
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1090000,
  }, { force: true });
  assert.equal(results[0].segments.length, 9);
  assert.ok(peak <= 12, `6 个分段的两侧请求峰值应不超过 12，实际 ${peak}`);
  assert.ok(peak >= 10, "回归应覆盖分段并发而不是退化为串行");
});

test("上游 PAT 在元数据请求期间变化时，不确认混用新旧凭据的账单", async (t) => {
  const metadataRead = holdPoint();
  let held = false;
  const { rule, state, stations, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    onRequest: ({ host, path, authorization }) => {
      if (held || host !== "upstream.test" || path !== "/api/token/" || authorization !== "Bearer pat") return;
      held = true;
      return metadataRead.hold();
    },
  });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const pending = module.queryRules(input, { force: true });
  await metadataRead.reached;
  stations[0].accessToken = "pat-2";
  metadataRead.release();
  const { results } = await pending;

  const refreshedMetadata = state.requests.some((request) => request.host === "upstream.test"
    && request.path === "/api/token/" && request.authorization === "Bearer pat-2");
  assert.ok(results[0].calculation.profitUsd == null || refreshedMetadata,
    "确认账单前必须用新 PAT 重新验证 Key，而不能用旧元数据配新统计");
});

test("过期上游目录响应不会提交旧倍率或分段", async (t) => {
  const groupsRead = holdPoint();
  let held = false;
  const { rule, state, segments, stations, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", ratio: null, from: 1000 }],
    metadataGroups: ({ authorization }) => authorization === "Bearer pat" ? { g1: { ratio: 7 } } : { g1: { ratio: 1 } },
    onRequest: ({ host, path, authorization }) => {
      if (held || host !== "upstream.test" || path !== "/api/user/self/groups" || authorization !== "Bearer pat") return;
      held = true;
      return groupsRead.hold();
    },
  });
  const pending = module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  await groupsRead.reached;
  stations[0].accessToken = "pat-2";
  groupsRead.release();
  await pending;

  assert.equal(segments.length, 1, "old catalogue must not create a transition");
  assert.notEqual(segments[0].group_ratio, 7, "old catalogue ratio must never commit");
  assert.ok(!state.ratioWrites.includes(7), "old catalogue ratio must never be written, even if a retry later succeeds");
});

test("本站管理员令牌在渠道目录请求期间变化时，不确认混用新旧站点的账单", async (t) => {
  const channelsRead = holdPoint();
  let held = false;
  const { rule, state, stations, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    onRequest: ({ host, path, authorization }) => {
      if (held || host !== "own.test" || path !== "/api/channel/" || authorization !== "admin") return;
      held = true;
      return channelsRead.hold();
    },
  });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const pending = module.queryRules(input, { force: true });
  await channelsRead.reached;
  stations[1].accessToken = "admin-2";
  channelsRead.release();
  const { results } = await pending;

  const refreshedChannels = state.requests.some((request) => request.host === "own.test"
    && request.path === "/api/channel/" && request.authorization === "admin-2");
  assert.ok(results[0].calculation.profitUsd == null || refreshedChannels,
    "确认账单前必须用新管理员令牌重新读取渠道目录");
});

test("过期本站渠道目录不会提交旧的禁用状态", async (t) => {
  const channelsRead = holdPoint();
  let held = false;
  const { rule, state, stations, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    ownChannels: ({ authorization }) => [{ id: 1, name: "渠道", status: authorization === "admin" ? 2 : 1 }],
    onRequest: ({ host, path, authorization }) => {
      if (held || host !== "own.test" || path !== "/api/channel/" || authorization !== "admin") return;
      held = true;
      return channelsRead.hold();
    },
  });
  const pending = module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  await channelsRead.reached;
  stations[1].accessToken = "admin-2";
  channelsRead.release();
  await pending;

  assert.ok(!state.channelStateWrites.includes("manual_disabled"), "old directory status must never be written, even if a retry later succeeds");
  assert.notEqual(state.channelStates.get(1), "manual_disabled", "old directory status must never commit");
  assert.equal(state.channelStates.get(1), "enabled");
});

test("真实对账观察在连接和提交边界阻塞 Store.update", async (t) => {
  for (const phase of ["connection", "commit"]) {
    let release;
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    let held = false;
    const fixture = liveReconciliationFixture(t, {
      segments: [{ id: "s1", group: "g1", from: 1000 }],
      onRepositoryConnection: phase === "connection" ? async () => {
        if (held) return;
        held = true; entered(); await new Promise((resolve) => { release = resolve; });
      } : null,
      onRepositoryCommit: phase === "commit" ? async () => {
        if (held) return;
        held = true; entered(); await new Promise((resolve) => { release = resolve; });
      } : null,
    });
    const store = new Store({ getConnection: async () => ({ beginTransaction: async () => {}, query: async () => [[]], commit: async () => {}, rollback: async () => {}, release() {} }) });
    store.data.stations = fixture.stations;
    fixture.rt.store = store;
    const pending = fixture.module.queryRules({ ruleIds: [fixture.rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
    await reached;
    const edit = store.update("upstream", { accessToken: "new" });
    await Promise.resolve();
    assert.equal(store.get("upstream").accessToken, "pat", `${phase} must retain old source until observation commits`);
    release();
    await Promise.all([pending, edit]);
    assert.equal(store.get("upstream").accessToken, "new");
  }
});

test("上游 PAT 更换后不可复用旧凭据的结果缓存和成功快照", async (t) => {
  let denyNewPat = false;
  const { rule, state, stations, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    onRequest: ({ host, path, authorization }) => {
      if (denyNewPat && host === "upstream.test" && path === "/api/user/self/groups"
        && authorization === "Bearer pat-2") throw new Error("新 PAT 暂时不可用");
    },
  });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const initial = await module.queryRules(input, { force: true });
  assert.equal(initial.results[0].calculation.profitUsd, 1.5);
  const oldSnapshotKeys = [...state.snapshots.keys()];

  stations[0].accessToken = "pat-2";
  denyNewPat = true;
  for (const force of [false, true]) {
    const { results } = await module.queryRules(input, { force });
    assert.equal(results[0].health.issues.some((issue) => issue.code === "GROUP_DATA_UNAVAILABLE"), true);
    assert.equal(results[0].health.stale, false);
  }
  assert.ok(oldSnapshotKeys.every((key) => state.snapshots.has(key)), "旧证据仍应保留");
});

test("列出规则后才被停止的规则从本轮结果中去掉，其余规则照常返回", async () => {
  const active = { id: "rr_active", upstream_station_id: "missing", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const archived = { ...active, id: "rr_archived", token_id: 10 };
  const segment = { id: "s1", rule_id: active.id, group_name: "g", group_ratio: 1, effective_from_ms: 1000, effective_to_ms: null, detected_at_ms: 1000, timing_source: "operator_confirmed" };
  const query = async (sql, params) => {
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    // 规则列表里还有它，按 id 读取时它已被停止。
    if (sql.includes("FROM reconciliation_rules")) return sql.includes("WHERE id = ?") ? [params[0] === archived.id ? [] : [active]] : [[active, archived]];
    if (sql.includes("FROM reconciliation_snapshots") || sql.includes("reconciliation_alert_state")) return [[]];
    return [{ affectedRows: 1 }];
  };
  const pool = {
    query,
    async getConnection() {
      return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });

  const { results } = await module.queryRules({ ruleIds: [active.id, archived.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 3000 }, { force: true });
  assert.deepEqual(results.map((result) => result.rule.id), [active.id]);
});

test("upstream unavailable retains persisted segment evidence in the response and snapshot", async () => {
  const rule = {
    id: "rr_unavailable", upstream_station_id: "missing-upstream", own_station_id: "own", token_id: 9,
    token_name: "stable", fixed_group: "g1", timezone: "Asia/Shanghai", enabled: 1, archived_at: null,
  };
  trustedLegacyRule(rule);
  const snapshots = [];
  const snapshotRows = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT * FROM reconciliation_rules")) return [[rule]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("FROM reconciliation_rule_segments")) return [[{
        id: "s1", rule_id: rule.id, group_name: "g1", group_ratio: 2.9,
        ratio_observed_at_ms: 1234, ratio_source: "group_catalog", effective_from_ms: 1000,
        effective_to_ms: null, detected_at_ms: 1234, timing_source: "operator_confirmed",
      }]];
      if (sql.includes("FROM reconciliation_snapshots")) return [snapshotRows];
      if (sql.includes("reconciliation_alert_state")) return [[]];
      if (sql.includes("INSERT INTO reconciliation_snapshots")) {
        snapshots.push({ segmentId: params[1], snapshotKey: params[2], source: JSON.parse(params.at(-1)) });
        snapshotRows.push({
          rule_id: params[0], segment_id: params[1], snapshot_key: params[2], window_kind: params[3],
          window_start_ms: params[4], window_end_ms: params[5], health_code: params[16], health_detail: params[17],
          source: params[18], generated_at: "2026-09-22T10:00:00.000Z",
        });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  pool.getConnection = async () => ({
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    query: (...args) => pool.query(...args),
  });
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const { results } = await module.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000,
  }, { force: true });

  assert.equal(results[0].health.code, "UPSTREAM_DATA_UNAVAILABLE");
  assert.equal(results[0].lastSuccessfulAt, undefined, "首次读取失败不能伪称有最近成功结果");
  assert.equal(results[0].currentSegment.group, "g1");
  assert.equal(results[0].currentSegment.ratio, 2.9);
  assert.equal(results[0].currentSegment.ratioObservedAt, 1234);
  assert.equal(results[0].currentSegment.ratioSource, "group_catalog");
  assert.deepEqual(results[0].transitionSegments.map((segment) => segment.id), ["s1"]);
  assert.equal(snapshots[0].segmentId, "s1");
  assert.match(snapshots[0].snapshotKey, /^r3:o:/);
  assert.deepEqual(snapshots[0].source.segment, {
    group: "g1", ratio: 2.9, ratioObservedAt: 1234, ratioSource: "group_catalog", timingSource: "operator_confirmed",
  });
  const restarted = createReconciliationModule({ pool, store: { list: () => [], get: () => null, channels: [] } });
  const second = await restarted.queryRules({
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000, endMs: 2000,
  }, { force: true });
  assert.equal(second.results[0].lastSuccessfulAt, undefined, "第一次失败快照不能被第二次失败恢复为最近成功");
  assert.equal(second.results[0].health.stale, false);
});

test("进程重启后只恢复同一完整窗口和站点来源的成功账单，失败不覆盖该快照", async (t) => {
  const { rule, state, rt, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000 }] });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const initial = await module.queryRules(input, { force: true });
  assert.equal(initial.results[0].calculation.profitUsd, 1.5);
  const writes = state.writes;

  state.upstreamQuota = null;
  const restarted = createReconciliationModule({ pool: rt.pool, store: rt.store });
  const { results } = await restarted.queryRules(input, { force: true });
  assert.equal(results[0].health.stale, false);
  assert.equal(results[0].upstream.amountUsd, null);
  assert.equal(results[0].downstream.amountUsd, 2.5);
  assert.equal(results[0].calculation.profitUsd, null);
  assert.equal(results[0].lastConfirmed.calculation.profitUsd, 1.5);
  assert.equal(state.writes, writes + 1, "上游故障保存本轮 observation 而不覆盖 confirmed");
});

test("持久化 today 成功账单可用于同日较晚窗口，不能跨本地日期复用", async () => {
  const first = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-20T04:26:08.000Z"));
  const rows = [{
    health_code: "READY",
    source: JSON.stringify({ recordType: "confirmed", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "scope", window: first, resultGeneratedAt: "2026-09-20T04:26:08.000Z", result: { upstream: { amountUsd: 2.5 }, calculation: { differenceUsd: 2.5, profitUsd: 2.5, riskDifferenceUsd: null, marginRate: 0.5 } } }),
  }];
  const repository = new ReconciliationRepository({
    async query() { return [rows]; },
  });
  const sameDay = { ...first, endMs: first.endMs + 30000 };
  assert.equal((await repository.latestSuccessfulResult("rr", sameDay, "scope"))?.result.upstream.amountUsd, 2.5);
  const nextDay = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-21T04:26:08.000Z"));
  assert.equal(await repository.latestSuccessfulResult("rr", nextDay, "scope"), null);
});

test("重启后的仓储公开读取同口径 observation，且不伪称未确认窗口成功", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const source = {
    recordType: "observation", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "scope",
    window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
    result: {
      window, lastSuccessfulWindow: null,
      upstream: { state: "partial", amountUsd: null, knownAmountUsd: 1, successfulCount: 1, expectedCount: 2 },
      downstream: { state: "complete", amountUsd: 2, knownAmountUsd: 2, successfulCount: 2, expectedCount: 2 },
      calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
      health: { code: "UPSTREAM_DATA_UNAVAILABLE" },
    },
  };
  const repository = new ReconciliationRepository({ async query() { return [[{ health_code: "UPSTREAM_DATA_UNAVAILABLE", source: JSON.stringify(source) }]]; } });
  const observed = await repository.latestObservation("rr", window, "scope");
  assert.equal(observed?.result.upstream.knownAmountUsd, 1);
  assert.equal(observed?.result.lastSuccessfulWindow, null);
  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
});

test("零利润的完整账单仍可作为最近成功结果恢复", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "READY", source: JSON.stringify({
        recordType: "confirmed", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "scope",
        window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 0, profitUsd: 0, riskDifferenceUsd: null, marginRate: 0 } },
      }) }]];
    },
  });
  const result = await repository.latestSuccessfulResult("rr", window, "scope");
  assert.equal(result?.result.calculation.profitUsd, 0);
  assert.equal(result?.result.calculation.marginRate, 0);
});

test("旧版 flow 收费快照即使曾有利润也不能作为最近成功账单复用", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "READY", source: JSON.stringify({
        scopeFingerprint: "scope", window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 2.5, profitUsd: 2.5, riskDifferenceUsd: null, marginRate: 0.5 } },
      }) }]];
    },
  });

  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
});

test("非确认的旧快照不会被兼容逻辑伪造成利润", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "UPSTREAM_EMPTY_WITH_SALES", source: JSON.stringify({
        scopeFingerprint: "scope", window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: 2.5, marginRate: 0.5 } },
      }) }]];
    },
  });
  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
});

test("仓储不会把失败或异常快照当作最近成功账单", async () => {
  const window = { preset: "custom", startMs: 1000, endMs: 2000, timezone: "Asia/Shanghai" };
  const repository = new ReconciliationRepository({
    async query() {
      return [[{ health_code: "UPSTREAM_DATA_UNAVAILABLE", source: JSON.stringify({
        scopeFingerprint: "scope", window, resultGeneratedAt: "2026-09-22T10:00:00.000Z",
        result: { calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null } },
      }) }]];
    },
  });
  assert.equal(await repository.latestSuccessfulResult("rr", window, "scope"), null);
});

test("known catalogue ratios backfill closed legacy segments without changing boundaries", async () => {
  const rows = [
    { id: "old", rule_id: "rr", group_name: "AWS-Bedrock3", group_ratio: null, effective_from_ms: 1000, effective_to_ms: 2000, detected_at_ms: 2000, timing_source: "detected" },
    { id: "current", rule_id: "rr", group_name: "AWS-Bedrock2", group_ratio: 3, effective_from_ms: 2000, effective_to_ms: null, detected_at_ms: 2000, timing_source: "operator_confirmed" },
  ];
  const calls = [];
  const pool = {
    async query(sql) {
      if (sql.includes("FROM reconciliation_rule_segments")) return [rows];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push("begin"); }, async commit() { calls.push("commit"); }, async rollback() {}, release() { calls.push("release"); },
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.includes("FOR UPDATE")) return [rows];
          if (sql.startsWith("UPDATE reconciliation_rule_segments SET group_ratio")) {
            const row = rows.find((item) => item.id === params[2]);
            row.group_ratio = params[0];
            row.ratio_observed_at_ms = params[1];
            row.ratio_source = "group_catalog";
            return [{ affectedRows: 1 }];
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const repository = new ReconciliationRepository(pool);
  assert.equal(await repository.backfillMissingSegmentRatios("rr", {
    "AWS-Bedrock3": { ratio: 2.9 }, "AWS-Bedrock2": { ratio: 3 }, Missing: { ratio: null },
  }, 3000), 1);
  assert.equal(rows[0].group_ratio, 2.9);
  assert.equal(rows[0].ratio_observed_at_ms, 3000);
  assert.equal(rows[0].ratio_source, "group_catalog");
  assert.deepEqual(rows.map((row) => [row.id, row.effective_from_ms, row.effective_to_ms]), [["old", 1000, 2000], ["current", 2000, null]]);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["begin", "commit", "release"]);
});

test("R02 legacy首次安全锚定先于观察；换账号不写分组、倍率、渠道或快照", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  const store = new Store(f.rt.pool);
  store.data.stations = f.stations;
  f.rt.store = store;
  const input = { ruleIds: [f.rule.id], preset: "custom", startMs: 1000000, endMs: 1060000 };
  const observe = ReconciliationRepository.prototype.observeSource;
  t.mock.method(ReconciliationRepository.prototype, "observeSource", async function (...args) {
    assert.equal(f.rule.canonical_key, canonicalBillingKey(f.stations[0], { provider: "newapi", accountId: "7" }, 9));
    assert.equal(JSON.parse(f.rule.source_binding).ownSource.accountId, "1");
    return observe.apply(this, args);
  });
  const first = (await f.module.queryRules(input, { force: true })).results[0];
  assert.equal(first.calculation.profitUsd, 1.5);
  assert.equal(first.rule.billingPolicy, "legacy-v3");
  assert.equal(first.rule.scopeVersion, 1);
  assert.equal(first.rule.billingEffectiveFrom, null);
  const before = { segments: structuredClone(f.segments), snapshots: [...f.state.snapshots.values()], ratios: [...f.state.ratioWrites], states: [...f.state.channelStateWrites] };
  const oldFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host === "upstream.test" && init?.headers?.Authorization === "Bearer replacement-account") {
      const data = url.pathname === "/api/user/self" ? { id: 8 }
        : url.pathname === "/api/token/" ? { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g2", cross_group_retry: false }] }
          : url.pathname === "/api/user/self/groups" ? { g2: { ratio: 20 } } : null;
      if (data) return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
    }
    return oldFetch(input, init);
  });
  await store.update("upstream", { accessToken: "replacement-account" });
  const changed = (await f.module.queryRules(input, { force: true })).results[0];
  assert.equal(changed.health.code, "SOURCE_BINDING_UNCONFIRMED");
  assert.equal(changed.calculation.profitUsd, null);
  assert.equal(changed.downstream.knownAmountUsd, 2.5);
  assert.deepEqual(f.segments, before.segments);
  assert.deepEqual([...f.state.snapshots.values()], before.snapshots);
  assert.deepEqual(f.state.ratioWrites, before.ratios);
  assert.deepEqual(f.state.channelStateWrites, before.states);
  assert.equal(f.rule.fixed_group, "g1");
});

test("R02 Repository首锚定拒绝已有渠道观察，持久原身份匹配才保留旧范围锚定", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }], channelObservedAt: 123 });
  const repository = new ReconciliationRepository(f.rt.pool);
  const original = { ...f.rule };
  trustedLegacyRule(original, f.stations, 7, 1);
  const identity = { provider: "newapi", canonicalKey: original.canonical_key, ownSource: original.source_binding.ownSource };
  const before = await repository.getRule(f.rule.id);
  const options = { expectedScopeFingerprint: reconciliationScopeFingerprint(before, await repository.listSegments(f.rule.id)), allowInitialAnchoring: true };
  await assert.rejects(repository.anchorRuleIdentity(f.rule.id, identity, options), { code: "LEGACY_IDENTITY_UNVERIFIED" });
  assert.equal(f.rule.canonical_key, undefined);
  f.state.snapshots.set("original-identity", { rule_id: f.rule.id, source: JSON.stringify({ scopePolicy: {
    canonicalKey: identity.canonicalKey, ownSource: { ...identity.ownSource, namespaceKey: "different" },
  } }) });
  await assert.rejects(repository.anchorRuleIdentity(f.rule.id, identity, options), { code: "LEGACY_IDENTITY_UNVERIFIED" });
  f.state.snapshots.get("original-identity").source = JSON.stringify({ scopePolicy: identity });
  const anchored = await repository.anchorRuleIdentity(f.rule.id, identity, { ...options, allowInitialAnchoring: false });
  assert.equal(anchored.canonicalKey, identity.canonicalKey);
  assert.deepEqual(anchored.ownSource, identity.ownSource);
  assert.equal(anchored.billingPolicy, before.billingPolicy);
  assert.equal(anchored.scopeVersion, before.scopeVersion);
  assert.equal(anchored.billingEffectiveFrom, before.billingEffectiveFrom);
  assert.deepEqual(anchored.channels, before.channels);
  assert.equal(f.state.writes, 0);
});

test("R02有旧历史但无原身份时，当前verifiedIdentity不能倒推原规则或落库", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  f.stations[0].verifiedIdentity = { provider: "newapi", baseUrl: "https://upstream.test", accountId: "7" };
  f.state.snapshots.set("old-observation", { rule_id: f.rule.id, snapshot_key: "old-observation", source: JSON.stringify({
    recordType: "observation", upstream: { tokenId: 9, tokenName: "stable" }, result: { calculation: { profitUsd: null } },
  }) });
  const snapshots = [...f.state.snapshots.values()];
  const segments = structuredClone(f.segments);
  const result = (await f.module.queryRules({ preset: "custom", startMs: 1000000, endMs: 1060000 }, { force: true })).results[0];
  assert.equal(result.health.code, "LEGACY_IDENTITY_UNVERIFIED");
  assert.match(result.health.detail, /确认新的账号和本站范围/);
  assert.equal(result.calculation.profitUsd, null);
  assert.equal(result.upstream.knownAmountUsd, 1);
  assert.equal(result.downstream.knownAmountUsd, 2.5);
  assert.equal(f.rule.canonical_key, undefined);
  assert.deepEqual(f.segments, segments);
  assert.deepEqual([...f.state.snapshots.values()], snapshots);
  assert.deepEqual(f.state.ratioWrites, []);
  assert.deepEqual(f.state.channelStateWrites, []);
});

test("R02本站同源PAT不延期；A换B并同步仍不确认旧A，旧快照来源保留", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-12T07:00:00Z"));
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  const store = new Store(f.rt.pool);
  store.data.stations = f.stations;
  f.rt.store = store;
  let catalogue = null;
  const onboarding = await createChannelOnboardingModule(f.rt, { repository: {
    getCatalogue: async () => catalogue, listLinks: async () => [],
    saveCatalogue: async (value) => { catalogue = structuredClone(value); },
  } }).load();
  f.rt.onboardingSource = onboarding;
  await onboarding.sync();
  const sourceA = onboarding.getSourceCatalogue().ownSource;
  const revisionA = onboarding.getSourceCatalogue().channels[0].revision;
  const effective = Date.parse("2026-10-10T16:00:00Z");
  Object.assign(f.rule, { canonical_key: canonicalBillingKey(f.stations[0], { provider: "newapi", accountId: "7" }, 9),
    billing_policy: "next-complete-day", scope_version: 1, billing_effective_from_ms: effective, cost_coverage: "complete",
    source_binding: serializeRuleSourceBinding({ sourceBinding: { 1: revisionA }, ownSource: sourceA, costCoverage: "complete" }) });
  const input = { preset: "custom", startMs: effective, endMs: effective + 86400000 };
  assert.equal((await f.module.queryRules(input, { force: true })).results[0].calculation.profitUsd, 1.5);
  await store.update("own", { accessToken: "same-source-pat" });
  await onboarding.sync();
  assert.equal(onboarding.getSourceCatalogue().ownSource.namespaceKey, sourceA.namespaceKey);
  const rotated = await f.module.appendChannels(f.rule.id, [1], { sourceBinding: { 1: revisionA }, ownSource: sourceA, costCoverage: "complete" });
  assert.equal(rotated.scopeVersion, 1);
  assert.equal(rotated.billingEffectiveFrom, effective);
  const snapshots = [...f.state.snapshots.values()];
  const oldFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host === "own-b.test") {
      const data = url.pathname === "/api/user/self" ? { id: 2 }
        : url.pathname === "/api/status" ? { quota_per_unit: 100 }
          : url.pathname === "/api/channel/" ? { total: 1, items: [{ id: 1, name: "渠道", status: 1 }] }
            : url.pathname === "/api/log/stat" ? { quota: 500 } : null;
      return { status: data ? 200 : 404, text: async () => JSON.stringify({ success: !!data, data }) };
    }
    return oldFetch(input, init);
  });
  await store.update("own", { baseUrl: "https://own-b.test", accessToken: "source-b-pat" });
  await onboarding.sync();
  assert.notEqual(onboarding.getSourceCatalogue().ownSource.namespaceKey, sourceA.namespaceKey);
  const changed = (await f.module.queryRules(input, { force: true })).results[0];
  assert.equal(changed.health.code, "SOURCE_BINDING_UNCONFIRMED");
  assert.equal(changed.calculation.profitUsd, null);
  assert.equal(changed.downstream.knownAmountUsd, 5);
  assert.equal(changed.rule.scopeVersion, 1);
  assert.equal(changed.rule.ownSource.namespaceKey, sourceA.namespaceKey);
  assert.deepEqual([...f.state.snapshots.values()], snapshots);
  assert.ok(snapshots.every((snapshot) => JSON.parse(snapshot.source).scopePolicy.ownSource.namespaceKey === sourceA.namespaceKey));
});

function membershipFixture() {
  const state = { rules: [{ id: "rr_members", upstream_station_id: "up", own_station_id: "own", token_id: 9,
    token_name: "stable", fixed_group: "g1", timezone: "Asia/Shanghai", enabled: 1, archived_at: null }],
    channels: [{ rule_id: "rr_members", channel_id: 1, channel_name: "一" }], created: 0, ruleWrites: 0, rollbacks: 0, failChannels: false };
  let lockTail = Promise.resolve();
  const read = (sql, params = [], target = state) => {
    if (sql.includes("JOIN reconciliation_rule_channels")) return [target.channels.filter((channel) => params[0].includes(channel.channel_id)
      && channel.rule_id !== params[1]).map((channel) => ({ id: channel.rule_id, channel_id: channel.channel_id, token_name: "stable" }))];
    if (sql.includes("FROM reconciliation_rule_channels")) {
      const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
      return [target.channels.filter((channel) => ids.includes(channel.rule_id))];
    }
    if (sql.includes("FROM reconciliation_rules")) return [params.length ? target.rules.filter((rule) => rule.id === params[0]) : target.rules];
    throw new Error(`Unexpected read: ${sql}`);
  };
  const pool = { query: async (...args) => read(...args), async getConnection() {
    let releaseLock;
    let working;
    return {
      async beginTransaction() { working = structuredClone({ ...state, onRuleWrite: undefined }); },
      async query(sql, params = []) {
        if (sql.includes("FROM reconciliation_rules") && sql.includes("FOR UPDATE")) {
          const previous = lockTail;
          lockTail = new Promise((resolve) => { releaseLock = resolve; });
          await previous;
          working = structuredClone({ ...state, onRuleWrite: undefined });
          return read(sql, params, working);
        }
        if (sql.startsWith("SELECT")) return read(sql, params, working);
        if (sql.startsWith("UPDATE reconciliation_rules")) {
          const rule = working.rules.find((item) => item.id === params[15]);
          if (!rule) return [{ affectedRows: 0 }];
          working.ruleWrites += 1;
          [rule.upstream_station_id, rule.own_station_id, rule.token_id, rule.token_name, rule.fixed_group, rule.timezone,
            rule.enabled, rule.active_token_key, rule.billing_policy, rule.scope_version, rule.billing_effective_from_ms,
            rule.cost_coverage, rule.provider, rule.canonical_key, rule.source_binding] = params;
          await state.onRuleWrite?.();
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("DELETE FROM reconciliation_rule_channels")) {
          working.channels = working.channels.filter((channel) => channel.rule_id !== params[0]);
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO reconciliation_rule_channels")) {
          if (state.failChannels) throw new Error("channel insert failed");
          working.channels.push(...params[0].map(([rule_id, channel_id, channel_name, active_channel_key]) => ({ rule_id, channel_id, channel_name, active_channel_key })));
          return [{ affectedRows: params[0].length }];
        }
        if (sql.startsWith("INSERT INTO reconciliation_rules")) {
          if (!state.allowCreate) { state.created += 1; throw new Error("must reuse existing rule"); }
          const [id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, timezone, enabled, active_token_key,
            billing_policy, scope_version, billing_effective_from_ms, cost_coverage, provider, canonical_key, source_binding] = params;
          working.rules.push({ id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, timezone, enabled,
            active_token_key, billing_policy, scope_version, billing_effective_from_ms, cost_coverage, provider, canonical_key, source_binding });
          working.created += 1;
          await state.onRuleWrite?.();
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("INSERT INTO reconciliation_rule_segments")) return [{ affectedRows: 1 }];
        throw new Error(`Unexpected write: ${sql}`);
      },
      async commit() { state.rules = working.rules; state.channels = working.channels; state.created = working.created; state.ruleWrites = working.ruleWrites; },
      async rollback() { state.rollbacks += 1; },
      release() { releaseLock?.(); },
    };
  } };
  return { state, pool, repository: new ReconciliationRepository(pool) };
}

async function financialFixture(t, { create = false } = {}) {
  const fixture = membershipFixture();
  if (create) { fixture.state.rules = []; fixture.state.channels = []; fixture.state.allowCreate = true; }
  const store = sourceStore();
  store.data.stations = [{ id: "up", name: "Upstream", type: "newapi", baseUrl: "https://up.test", accessToken: "pat", authVersion: 1 },
    { id: "own", name: "Own", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin", authVersion: 1 }];
  const remote = { accountId: 42, ownAccountId: 1, tokenId: 9, channels: [1, 2, 3, 4, 5], requests: [] };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    remote.requests.push({ host: url.host, path: url.pathname, authorization: init.headers?.Authorization });
    const data = url.pathname === "/api/user/self" ? { id: url.host === "own.test" ? remote.ownAccountId : remote.accountId, quota: 100, used_quota: 1 }
      : url.pathname === "/api/status" ? { quota_per_unit: 100 }
        : url.pathname === "/api/user/self/groups" ? { g1: { ratio: 1 } }
          : url.pathname === "/api/token/" ? { total: 1, items: [{ id: remote.tokenId, name: "stable", status: 1, group: "g1", cross_group_retry: false }] }
            : url.pathname === "/api/channel/" ? { total: remote.channels.length, items: remote.channels.map((id) => ({ id, name: `Channel ${id}`, type: 1, status: 1, base_url: "https://up.test", group: "g1" })) }
              : { quota: 100 };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const persisted = { catalogue: null, links: [] };
  const repository = { getCatalogue: async () => persisted.catalogue, listLinks: async () => persisted.links,
    saveCatalogue: async (value) => { persisted.catalogue = structuredClone(value); },
    saveLinks: async (values) => { persisted.links.push(...structuredClone(values)); return structuredClone(values); } };
  const rt = { store, pool: fixture.pool };
  rt.reconciliation = createReconciliationModule(rt);
  rt.onboardingSource = rt.channelOnboarding = createChannelOnboardingModule(rt, { repository, refresh: async () => {} });
  await rt.onboardingSource.sync();
  return { ...fixture, rt, module: rt.reconciliation, store, remote, persisted,
    input: { upstreamStationId: "up", tokenId: 9, salesChannelIds: [2, 3, 4, 5], timezone: "Asia/Shanghai",
      coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } } };
}

function financialBatchInput(f, channelIds = f.input.salesChannelIds, selection = {}) {
  const catalogue = f.rt.onboardingSource.getSourceCatalogue();
  return { requestId: "11111111-1111-4111-8111-111111111111", ownStationId: "own",
    selections: [{ selectionId: "s", stationId: "up", monitor: true, ...selection }],
    groups: [{ groupId: "g", selectionId: "s", channels: channelIds.map((channelId) => ({ channelId,
      channelRevision: catalogue.channels.find((channel) => channel.id === channelId).revision })),
    reconciliation: { tokenId: f.remote.tokenId, timezone: "Asia/Shanghai", coverageDeclaration: f.input.coverageDeclaration } }] };
}

async function financialProof(f, channelIds, selection) {
  const input = financialBatchInput(f, channelIds, selection), probe = await f.rt.onboardingSource.probeBatch(input);
  assert.equal(probe.groups[0].status, "ready", JSON.stringify(probe.groups[0]));
  return { input, probe, guard: f.rt.onboardingSource.getPreviewGuard(probe.previewId, "g") };
}

async function financialRuleRoutes() {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status=200) => Response.json(value, {status});" };
    return next(url, context);
  } });
  try {
    const { POST } = await import("../app/api/reconciliation/rules/route.js");
    const { PUT } = await import("../app/api/reconciliation/rules/[id]/route.js");
    const { POST: PREVIEW } = await import("../app/api/reconciliation/rules/[id]/preview/route.js");
    return { POST, PUT, PREVIEW };
  } finally { hooks.deregister(); }
}

test("U01 dry-read使用真实Key与来源并集，无写入且不把采样时间纳入keyVersion", async (t) => {
  const f = await financialFixture(t);
  const before = structuredClone(f.state.rules);
  const first = await f.module.previewKeyScope(f.input);
  assert.deepEqual(first.basis.existingChannelIds, [1]);
  assert.deepEqual(first.basis.proposedChannelIds, [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(first.basis.channelRevisions), ["1", "2", "3", "4", "5"]);
  assert.equal(first.basis.billingEffectiveFromMs, null);
  assert.equal(first.preview.scopeChanged, true);
  assert.equal(first.preview.costCoverage, "complete");
  assert.equal(first.preview.billingEffectiveFromMs, nextBillingEffectiveFrom("Asia/Shanghai"));
  const second = await f.module.previewKeyScope(f.input);
  assert.equal(first.basis.keyVersion, second.basis.keyVersion);
  assert.deepEqual(f.state.rules, before);
  const metadata = await f.module.getUpstreamKeys("up", { force: true });
  await assert.rejects(f.module.previewKeyScope(f.input, { authorization: { station: f.store.get("up"),
    metadata: { ...metadata, platform: "newapi", accountId: 42, capability: { state: "unverified" } } } }),
  (error) => error.code === "BILLING_CAPABILITY_UNVERIFIED");
});

test("U02 exact replace dryread最终集合/原成员完整绑定，缺声明不继承旧complete且零写", async (t) => {
  const f = await financialFixture(t);
  f.state.channels.push({ rule_id: "rr_members", channel_id: 2, channel_name: "two" });
  const body = { ...f.input, salesChannelIds: [3, 2, 3], enabled: false };
  const before = structuredClone(f.state.rules);
  const result = await f.module.previewKeyScope(body, { replaceRuleId: "rr_members" });
  assert.deepEqual(result.basis.existingChannelIds, [1, 2]);
  assert.deepEqual(result.basis.proposedChannelIds, [2, 3]);
  assert.deepEqual(Object.keys(result.basis.channelRevisions), ["2", "3"]);
  assert.deepEqual(f.state.rules, before);
  const intent = normalizeReconciliationScopeIntent("replace", "rr_members", body, { timezone: "Asia/Shanghai", enabled: true });
  assert.deepEqual(intent, { kind: "replace", targetRuleId: "rr_members", existingEnabled: true, normalizedPutIntent: {
    upstreamStationId: "up", tokenId: 9, salesChannelIds: [2, 3], timezone: "Asia/Shanghai", enabled: false, coverageDeclaration: f.input.coverageDeclaration } });
  await assert.rejects(f.module.previewKeyScope({ ...body, coverageDeclaration: undefined }, { replaceRuleId: "rr_members" }),
    (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(f.module.previewKeyScope({ ...body, tokenId: 10 }, { replaceRuleId: "rr_members" }),
    (error) => error.code === "RULE_IDENTITY_IMMUTABLE");
});

test("U01公共旧POST/PUT拒绝body伪造guard/options，真实runtime拒绝复制proof引用", async (t) => {
  const f = await financialFixture(t, { create: true });
  const { POST, PUT } = await financialRuleRoutes();
  const body = { ...f.input, previewGuard: { basis: {} }, options: { previewGuard: { basis: {} }, authorization: { station: f.store.get("up") } } };
  const request = () => new Request("https://app.test/api/reconciliation/rules", { method: "POST", body: JSON.stringify(body) });
  let response = await POST(request(), f.rt);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PREVIEW_REQUIRED");
  assert.equal(f.state.created, 0);
  f.state.rules.push({ id: "rr_members", upstream_station_id: "up", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: "g1", timezone: "Asia/Shanghai", enabled: 1 });
  f.state.channels.push({ rule_id: "rr_members", channel_id: 1, channel_name: "one" });
  response = await PUT(request(), f.rt, { id: "rr_members" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "PREVIEW_REQUIRED");
  const proof = await f.module.previewKeyScope(f.input);
  await assert.rejects(f.module.createRule(f.input, { previewGuard: { basis: proof.basis, preview: proof.preview, postSaveResourceVersions: {} } }),
    (error) => error.code === "PREVIEW_REQUIRED");
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1]);
  assert.equal(f.state.rules[0].scope_version, undefined);
});

test("U01财务Repository guard在SQL前和commit前执行，后者失败无成员/日期部分提交", async () => {
  const f = membershipFixture();
  let calls = 0;
  await assert.rejects(f.repository.appendChannels("rr_members", [{ channelId: 2, name: "two" }], { costCoverage: "complete" }, {
    guard(existing, channels, policy) {
      calls += 1;
      assert.equal(existing.id, "rr_members");
      assert.deepEqual(channels.map((channel) => channel.channelId), [1]);
      assert.deepEqual(policy.channels.map((channel) => channel.channelId), [1, 2]);
      if (calls === 2) throw Object.assign(new Error("proof changed before commit"), { code: "PREVIEW_BASIS_CHANGED" });
    },
  }), (error) => error.code === "PREVIEW_BASIS_CHANGED");
  assert.equal(calls, 2);
  assert.equal(f.state.rollbacks, 1);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1]);
  assert.equal(f.state.rules[0].scope_version, undefined);
});

test("U01行锁写入期间跨午夜在commit guard重算完整日，拒绝旧日期且回滚", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = membershipFixture(), expected = nextBillingEffectiveFrom("Asia/Shanghai", now);
  f.state.onRuleWrite = () => { now += 2000; };
  let calls = 0;
  await assert.rejects(f.repository.appendChannels("rr_members", [{ channelId: 2, name: "two" }], { costCoverage: "complete" }, {
    guard(_existing, _channels, policy) {
      calls += 1;
      if (policy.billingEffectiveFrom !== expected) throw Object.assign(new Error("date boundary changed"), { code: "EFFECTIVE_PREVIEW_CHANGED" });
    },
  }), (error) => error.code === "EFFECTIVE_PREVIEW_CHANGED");
  assert.equal(calls, 2);
  assert.equal(f.state.rules[0].billing_effective_from_ms, undefined);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1]);
});

test("U01真public probe授权整组五渠道一次scope；复制引用失败，旧POST/PUT明确消费proof", async (t) => {
  const f = await financialFixture(t, { create: true });
  const proof = await financialProof(f, [1, 2, 3, 4, 5]);
  const body = { ...f.input, salesChannelIds: [1, 2, 3, 4, 5], previewId: proof.probe.previewId, groupId: "g" };
  await assert.rejects(f.module.createRule(body, { previewGuard: { ...proof.guard } }), (error) => error.code === "PREVIEW_REQUIRED");
  const { POST, PUT } = await financialRuleRoutes();
  const response = await POST(new Request("https://app.test/rules", { method: "POST", body: JSON.stringify(body) }), f.rt);
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const { rule } = await response.json();
  assert.deepEqual(rule.channels.map((channel) => channel.channelId), [1, 2, 3, 4, 5]);
  assert.equal(rule.scopeVersion, 1);
  assert.equal(f.state.created, 1);
  const second = await financialProof(f, [1, 2, 3, 4, 5]);
  const updated = await PUT(new Request("https://app.test/rules", { method: "PUT", body: JSON.stringify({ ...body, previewId: second.probe.previewId }) }), f.rt, { id: rule.id });
  assert.equal(updated.status, 409);
  assert.equal((await updated.json()).code, "PREVIEW_BASIS_CHANGED", "append proof即使最终集合相同也不能授权PUT");
});

test("U02真实issuer+HTTP删除/同时增删精确替换，不继承被删成员的complete覆盖", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-09T07:00:00Z"));
  const f = await financialFixture(t), { PREVIEW, PUT } = await financialRuleRoutes();
  f.state.channels.push({ rule_id: "rr_members", channel_id: 2, channel_name: "two" });
  const body = { ...f.input, salesChannelIds: [2] };
  const request = (value) => new Request("https://app.test/rules/rr_members", { method: "POST", body: JSON.stringify(value) });
  const response = await PREVIEW(request({ ...body, replaceRuleId: "fake", authorization: { station: { id: "fake" } }, scopeIntent: { kind: "append" } }), f.rt, { id: "rr_members" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const proof = await response.json();
  assert.deepEqual(proof.basis.existingChannelIds, [1, 2]);
  assert.deepEqual(proof.basis.proposedChannelIds, [2]);
  assert.equal(f.state.rules[0].canonical_key, undefined, "preview不得锚定旧来源或写规则");
  let confirmed = await PUT(request({ ...body, previewId: proof.previewId, groupId: proof.groupId }), f.rt, { id: "rr_members" });
  assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
  const first = (await confirmed.json()).rule;
  assert.equal(first.id, "rr_members");
  assert.deepEqual(first.channels.map((channel) => channel.channelId), [2]);
  assert.equal(first.scopeVersion, 2);
  assert.equal(first.billingEffectiveFrom, Date.parse("2026-10-09T16:00:00Z"));
  const mixed = { ...body, salesChannelIds: [3], coverageDeclaration: { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [2] } };
  const next = await f.rt.onboardingSource.probeRuleEdit("rr_members", mixed);
  confirmed = await PUT(request({ ...mixed, previewId: next.previewId, groupId: next.groupId }), f.rt, { id: "rr_members" });
  assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
  const changed = (await confirmed.json()).rule;
  assert.deepEqual(changed.channels.map((channel) => channel.channelId), [3]);
  assert.equal(changed.costCoverage, "unknown");
  assert.equal(changed.scopeVersion, 3);
  assert.deepEqual(first.channels.map((channel) => channel.channelId), [2], "原scope DTO成员保留");
});

test("U02同一PUT成功后次日/重启/过期preview只读重试，scope/day和SQL次数不变", async (t) => {
  let now = Date.parse("2026-10-09T07:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t), { PUT } = await financialRuleRoutes();
  const body = { ...f.input, salesChannelIds: [2], enabled: false };
  const proof = await f.rt.onboardingSource.probeRuleEdit("rr_members", body);
  const send = (input) => PUT(new Request("https://app.test/rules/rr_members", { method: "PUT", body: JSON.stringify(input) }), f.rt, { id: "rr_members" });
  const confirmed = await send({ ...body, previewId: proof.previewId, groupId: proof.groupId });
  assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
  const first = (await confirmed.json()).rule, writes = f.state.ruleWrites;
  const immediate = await send({ ...body, previewId: proof.previewId, groupId: proof.groupId });
  assert.equal(immediate.status, 200, JSON.stringify(await immediate.clone().json()));
  assert.equal(f.state.ruleWrites, writes);
  now += 86400000; await f.rt.onboardingSource.sync();
  f.rt.reconciliation = f.module = createReconciliationModule(f.rt);
  for (const input of [body, { ...body, previewId: "lost-after-restart", groupId: proof.groupId }]) {
    const response = await send(input);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const current = (await response.json()).rule;
    assert.equal(current.scopeVersion, first.scopeVersion);
    assert.equal(current.billingEffectiveFrom, first.billingEffectiveFrom);
    assert.equal(f.state.ruleWrites, writes);
  }
  const unproved = await send({ ...body, salesChannelIds: [3], previewId: "lost-after-restart", groupId: proof.groupId });
  assert.equal(unproved.status, 409);
  assert.equal((await unproved.json()).code, "PREVIEW_REQUIRED");
  assert.equal(f.state.ruleWrites, writes);
});

test("U02 genuine PUT SQL期间跨午夜在commit guard回滚，不留下成员或身份锚定", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t), { PUT } = await financialRuleRoutes();
  const body = { ...f.input, salesChannelIds: [2] }, proof = await f.rt.onboardingSource.probeRuleEdit("rr_members", body);
  f.state.onRuleWrite = () => { now += 2000; };
  const response = await PUT(new Request("https://app.test/rules/rr_members", { method: "PUT", body: JSON.stringify({ ...body,
    previewId: proof.previewId, groupId: proof.groupId }) }), f.rt, { id: "rr_members" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "EFFECTIVE_PREVIEW_CHANGED");
  assert.equal(f.state.ruleWrites, 0);
  assert.equal(f.state.rules[0].canonical_key, undefined);
  assert.equal(f.state.rules[0].scope_version, undefined);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1]);
});

test("U02 exact replace旧preview不得删除并发新成员，fresh final意图可保留它", async (t) => {
  const f = await financialFixture(t), body = { ...f.input, salesChannelIds: [2] };
  const proof = await f.rt.onboardingSource.probeRuleEdit("rr_members", body), append = await financialProof(f, [3]);
  await f.module.appendChannels("rr_members", [3], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: append.guard });
  const writes = f.state.ruleWrites;
  await assert.rejects(f.module.updateRule("rr_members", body, { previewGuard: f.rt.onboardingSource.getPreviewGuard(proof.previewId, proof.groupId) }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  assert.equal(f.state.ruleWrites, writes);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 3]);
  const nextBody = { ...body, salesChannelIds: [2, 3] }, next = await f.rt.onboardingSource.probeRuleEdit("rr_members", nextBody);
  const rule = await f.module.updateRule("rr_members", nextBody, { previewGuard: f.rt.onboardingSource.getPreviewGuard(next.previewId, next.groupId) });
  assert.deepEqual(rule.channels.map((channel) => channel.channelId), [2, 3]);
});

test("U02 private original enabled事实拒绝preview后停用，fresh replace可明确恢复", async (t) => {
  const f = await financialFixture(t), body = { ...f.input, salesChannelIds: [2], enabled: true };
  const proof = await f.rt.onboardingSource.probeRuleEdit("rr_members", body);
  await f.module.updateRule("rr_members", { ...body, salesChannelIds: [1], enabled: false, coverageDeclaration: undefined });
  const writes = f.state.ruleWrites;
  await assert.rejects(f.module.updateRule("rr_members", body, { previewGuard: f.rt.onboardingSource.getPreviewGuard(proof.previewId, proof.groupId) }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  assert.equal(f.state.ruleWrites, writes);
  const fresh = await f.rt.onboardingSource.probeRuleEdit("rr_members", body);
  const saved = await f.module.updateRule("rr_members", body, { previewGuard: f.rt.onboardingSource.getPreviewGuard(fresh.previewId, fresh.groupId) });
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.channels.map((channel) => channel.channelId), [2]);
  assert.equal(saved.scopeVersion, 2);
});

test("U01真正public batch确认一次保存五渠道金融组，消费成功资源证明并恢复相同重试", async (t) => {
  const f = await financialFixture(t, { create: true }), proof = await financialProof(f, [1, 2, 3, 4, 5]);
  const result = await f.rt.onboardingSource.connectBatch({ ...proof.input, previewId: proof.probe.previewId });
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].reconciliation.status, "configured");
  assert.equal(result.groups[0].saved.scopeVersion, 1);
  assert.equal(f.state.created, 1);
  assert.equal(f.persisted.links.length, 5);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(proof.guard.postSaveResourceVersions), ["up"]);
  assert.equal(f.store.get("up").verifiedIdentity.accountId, "42");
  const recovered = await f.rt.onboardingSource.connectBatch({ ...proof.input, previewId: proof.probe.previewId });
  assert.equal(recovered.complete, true, JSON.stringify(recovered));
  assert.equal(f.state.created, 1);
  assert.equal(f.state.rules[0].scope_version, 1);
  assert.equal(f.persisted.links.length, 5);
});

test("U01真正public batch跨午夜拒绝发生在resource/link/rule任何写入前", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t, { create: true }), proof = await financialProof(f, [1, 2, 3, 4, 5]);
  const before = structuredClone(f.store.data.stations);
  now += 2000;
  const result = await f.rt.onboardingSource.connectBatch({ ...proof.input, previewId: proof.probe.previewId });
  assert.equal(result.complete, false);
  assert.equal(result.groups[0].code, "EFFECTIVE_PREVIEW_CHANGED", JSON.stringify(result));
  assert.ok(result.groups[0].remainingActions.includes("repreview"));
  assert.equal(result.groups[0].nextPreview.billingEffectiveFromMs, Date.parse("2026-10-10T16:00:00Z"));
  assert.deepEqual(f.store.data.stations, before);
  assert.equal(f.persisted.links.length, 0);
  assert.equal(f.state.created, 0);
});

test("U01真正public batch并发旧预览拒绝，重新预览完整并集保留另一成功追加", async (t) => {
  const f = await financialFixture(t), a = await financialProof(f, [2]), b = await financialProof(f, [3]);
  const [first, stale] = await Promise.all([
    f.rt.onboardingSource.connectBatch({ ...a.input, previewId: a.probe.previewId }),
    f.rt.onboardingSource.connectBatch({ ...b.input, previewId: b.probe.previewId }),
  ]);
  assert.equal(first.complete, true, JSON.stringify(first));
  assert.equal(stale.complete, false);
  assert.equal(stale.groups[0].code, "PREVIEW_BASIS_CHANGED", JSON.stringify(stale));
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 2]);
  assert.deepEqual(f.persisted.links.map((link) => link.channelId), [2]);
  const fresh = await financialProof(f, [3]);
  assert.deepEqual(fresh.probe.groups[0].basis.proposedChannelIds, [1, 2, 3]);
  const second = await f.rt.onboardingSource.connectBatch({ ...fresh.input, previewId: fresh.probe.previewId });
  assert.equal(second.complete, true, JSON.stringify(second));
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 2, 3]);
  assert.equal(f.state.rules[0].scope_version, 3);
});

test("U01public proof下两个旧资源同actual账号/Key复用原规则及原billing授权", async (t) => {
  const f = await financialFixture(t);
  f.store.data.stations.push({ ...f.store.get("up"), id: "duplicate", accessToken: "another-same-account-pat" });
  const proof = await financialProof(f, [2], { stationId: "duplicate" });
  const rule = await f.module.createRule({ ...f.input, upstreamStationId: "duplicate", salesChannelIds: [2] }, { previewGuard: proof.guard });
  assert.equal(rule.id, "rr_members");
  assert.equal(rule.upstreamStationId, "up");
  assert.deepEqual(rule.channels.map((channel) => channel.channelId), [1, 2]);
  assert.equal(rule.canonicalKey, canonicalBillingKey(f.store.get("up"), { platform: "newapi", accountId: 42 }, 9));
  assert.equal(f.state.created, 0);
});

test("U01真public preview跨午夜在金融提交前拒绝，已完成无proof重试保留日期", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t), proof = await financialProof(f);
  now += 2000;
  await assert.rejects(f.module.appendChannels("rr_members", f.input.salesChannelIds, { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: proof.guard }),
    (error) => error.code === "EFFECTIVE_PREVIEW_CHANGED" && error.nextPreview.billingEffectiveFromMs === Date.parse("2026-10-10T16:00:00Z"));
  assert.equal(f.state.rules[0].scope_version, undefined);
  const next = await financialProof(f);
  const saved = await f.module.appendChannels("rr_members", f.input.salesChannelIds, { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: next.guard });
  assert.equal(saved.scopeVersion, 2);
  now += 86400000;
  await f.rt.onboardingSource.sync();
  const retry = await f.module.appendChannels("rr_members", f.input.salesChannelIds, { coverageDeclaration: f.input.coverageDeclaration });
  assert.equal(retry.scopeVersion, saved.scopeVersion);
  assert.equal(retry.billingEffectiveFrom, saved.billingEffectiveFrom);
});

test("U01public preview之后规则停用不消费旧proof；启停仍保留原policy/day", async (t) => {
  const f = await financialFixture(t), proof = await financialProof(f);
  await f.module.updateRule("rr_members", { upstreamStationId: "up", tokenId: 9, salesChannelIds: [1], timezone: "Asia/Shanghai", enabled: false });
  await assert.rejects(f.module.appendChannels("rr_members", [2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: proof.guard }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  await assert.rejects(f.module.previewKeyScope(f.input), (error) => error.code === "RULE_DISABLED");
  assert.equal(f.state.rules[0].scope_version, 1);
  assert.equal(f.state.rules[0].billing_effective_from_ms, null);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1]);
});

test("U01并发append旧basis拒绝且无部分提交，fresh public preview保留两次追加", async (t) => {
  const f = await financialFixture(t);
  const a = await financialProof(f, [2]), b = await financialProof(f, [3]);
  const results = await Promise.allSettled([
    f.module.appendChannels("rr_members", [2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: a.guard }),
    f.module.appendChannels("rr_members", [3], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: b.guard }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "PREVIEW_BASIS_CHANGED");
  const first = results[0].value;
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 2]);
  assert.equal(f.state.rules[0].scope_version, first.scopeVersion);
  const next = await financialProof(f, [3]);
  const merged = await f.module.appendChannels("rr_members", [3], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: next.guard });
  assert.deepEqual(merged.channels.map((channel) => channel.channelId), [1, 2, 3]);
  assert.equal(merged.scopeVersion, first.scopeVersion + 1);
});

test("U01public guard核验额外监控/独立billing auth；同actual账号轮换后新预览不延期", async (t) => {
  const f = await financialFixture(t);
  for (const id of ["extra", "billing"]) f.store.data.stations.push({ ...f.store.get("up"), id, accessToken: `${id}-pat` });
  const selection = { additionalMonitorStationIds: ["extra"], reconciliationAuthorization: { stationId: "billing" } };
  const original = await financialProof(f, [1, 2], selection);
  const saved = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: original.guard });
  const monitorProof = await financialProof(f, [1, 2], selection);
  await f.store.update("extra", { monitorEnabled: false });
  await assert.rejects(f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: monitorProof.guard }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  await f.store.update("extra", { monitorEnabled: true });
  const authProof = await financialProof(f, [1, 2], selection);
  await f.store.update("billing", { accessToken: "same-account-rotated-pat" }, { verifiedIdentity: { provider: "newapi", baseUrl: "https://up.test", accountId: "42" } });
  await assert.rejects(f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: authProof.guard }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  const fresh = await financialProof(f, [1, 2], selection);
  assert.equal(fresh.probe.groups[0].preview.scopeChanged, false);
  const unchanged = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: fresh.guard });
  assert.equal(unchanged.billingEffectiveFrom, saved.billingEffectiveFrom);
  assert.equal(unchanged.scopeVersion, saved.scopeVersion);
});

test("U01actual账号/ownnamespace改变要求新完整日，旧history不被提前锚定", async (t) => {
  let now = Date.parse("2026-10-09T07:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t), original = await financialProof(f, [1, 2]);
  const anchors = t.mock.method(ReconciliationRepository.prototype, "anchorRuleIdentity");
  const observations = t.mock.method(ReconciliationRepository.prototype, "observeSource");
  assert.equal(f.state.rules[0].canonical_key, undefined);
  const first = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: original.guard });
  now += 86400000; await f.rt.onboardingSource.sync();
  const stale = await financialProof(f, [1, 2]);
  f.remote.accountId = 43;
  await assert.rejects(f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: stale.guard }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  const account = await financialProof(f, [1, 2]);
  const changed = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: account.guard });
  assert.notEqual(changed.canonicalKey, first.canonicalKey);
  assert.equal(changed.scopeVersion, first.scopeVersion + 1);
  assert.equal(changed.billingEffectiveFrom, nextBillingEffectiveFrom("Asia/Shanghai", now));
  now += 86400000;
  f.remote.ownAccountId = 2; await f.rt.onboardingSource.sync();
  const namespace = await financialProof(f, [1, 2]);
  const moved = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: namespace.guard });
  assert.equal(moved.scopeVersion, changed.scopeVersion + 1);
  assert.notEqual(moved.ownSource.namespaceKey, changed.ownSource.namespaceKey);
  assert.equal(moved.billingEffectiveFrom, nextBillingEffectiveFrom("Asia/Shanghai", now));
  assert.equal(anchors.mock.callCount(), 0);
  assert.equal(observations.mock.callCount(), 0, "scope确认不得先改旧来源/倍率历史");
});

test("U01真实Sub2API public proof允许自动JWT续期，显式密码修改废弃proof且同账号不延期", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-09T07:00:00Z"));
  const f = await financialFixture(t), station = f.store.get("up"), previousFetch = globalThis.fetch;
  Object.assign(station, { type: "sub2api-password", email: "fixture@example.test", password: "old-password", s2Tokens: { accessToken: "before-jwt" } });
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    if (url.host !== "up.test") return previousFetch(input, init);
    const reply = (status, data) => ({ status, text: async () => JSON.stringify({ code: status === 200 ? 0 : 1, data }) });
    if (url.pathname === "/api/v1/auth/login") return reply(200, { access_token: JSON.parse(init.body).password, refresh_token: "refresh", expires_in: 3600 });
    if (url.pathname === "/api/v1/auth/me") return reply(200, { id: 42 });
    if (url.pathname === "/api/v1/keys") return reply(200, { total: 1, items: [{ id: 9, user_id: 42, name: "stable", status: "active", group_id: 7 }] });
    if (url.pathname.startsWith("/api/v1/keys/")) return reply(404, {});
    return reply(200, { total_actual_cost: url.searchParams.get("api_key_id") === "9" && url.searchParams.get("start_date") === "2026-10-08" ? 1 : 0 });
  });
  const proof = await financialProof(f, [1, 2]);
  station.s2Tokens = { accessToken: "automatically-renewed-jwt", expiresAt: Date.now() + 1000000 };
  const first = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: proof.guard });
  assert.equal(station.s2Tokens.accessToken, "automatically-renewed-jwt");
  const beforePassword = await financialProof(f, [1, 2]);
  await f.store.update("up", { password: "new-password" }, { verifiedIdentity: { provider: "sub2api", baseUrl: "https://up.test", accountId: "42" } });
  await assert.rejects(f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: beforePassword.guard }),
    (error) => error.code === "PREVIEW_BASIS_CHANGED");
  const next = await financialProof(f, [1, 2]);
  const retried = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: next.guard });
  assert.equal(retried.billingEffectiveFrom, first.billingEffectiveFrom);
  assert.equal(retried.scopeVersion, first.scopeVersion);
});

test("Repository 并发追加在行锁内读取最新并集，次日幂等重试不延期", async (t) => {
  let now = Date.parse("2026-10-09T07:00:00Z");
  t.mock.method(Date, "now", () => now);
  const { repository, state } = membershipFixture();
  await Promise.all([
    repository.appendChannels("rr_members", [{ channelId: 2, name: "二" }], { costCoverage: "complete", sourceBinding: { 2: "r2" } }),
    repository.appendChannels("rr_members", [{ channelId: 3, name: "三" }], { costCoverage: "complete", sourceBinding: { 3: "r3" } }),
  ]);
  const first = await repository.getRule("rr_members");
  assert.deepEqual(first.channels.map((channel) => channel.channelId).sort(), [1, 2, 3]);
  assert.equal(first.scopeVersion, 3);
  assert.deepEqual(first.sourceBinding, { 2: "r2", 3: "r3" });
  assert.equal(first.billingEffectiveFrom, Date.parse("2026-10-09T16:00:00Z"));
  now += 86400000;
  const retry = await repository.appendChannels("rr_members", [{ channelId: 2, name: "二" }], { costCoverage: "complete", sourceBinding: { 2: "r2" }, previewEffectiveFromMs: first.billingEffectiveFrom });
  assert.equal(retry.scopeVersion, first.scopeVersion);
  assert.equal(retry.billingEffectiveFrom, first.billingEffectiveFrom);
  state.failChannels = true;
  await assert.rejects(repository.appendChannels("rr_members", [{ channelId: 4, name: "四" }]), /channel insert failed/);
  assert.equal(state.rollbacks, 1);
  assert.deepEqual((await repository.getRule("rr_members")).channels.map((channel) => channel.channelId).sort(), [1, 2, 3]);
});

test("旧PUT成员编辑没有金融proof不推进范围或清理当前缓存", async (t) => {
  const now = Date.parse("2026-10-09T07:00:00Z");
  t.mock.method(Date, "now", () => now);
  const { pool, state } = membershipFixture();
  const stations = [{ id: "up", type: "newapi", baseUrl: "https://up.test", accessToken: "pat" },
    { id: "own", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin" }];
  t.mock.method(globalThis, "fetch", async (input) => ({ status: 200, text: async () => JSON.stringify({ success: true,
    data: new URL(input).pathname === "/api/user/self" ? { id: 42 } : { total: 1, items: [{ id: 2, name: "二", status: 1 }] } }) }));
  const rt = { pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) },
    _reconciliationResultCache: new Map([["rr_members:today:old", { value: { calculation: { profitUsd: 9 } } }]]) };
  await assert.rejects(createReconciliationModule(rt).updateRule("rr_members", { upstreamStationId: "up", tokenId: 9, salesChannelIds: [2], timezone: "Asia/Shanghai" }),
    (error) => error.code === "PREVIEW_REQUIRED");
  assert.equal(rt._reconciliationResultCache.size, 1);
  assert.equal(state.rules[0].scope_version, undefined);
  assert.deepEqual(state.channels.map((channel) => channel.channel_id), [1]);
});

test("两个旧资源同账号新金融创建不能绕过proof或产生第二份成本", async (t) => {
  const { pool, state } = membershipFixture();
  const stations = [{ id: "up", type: "newapi", baseUrl: "https://up.test", accessToken: "pat-1" },
    { id: "duplicate", type: "newapi", baseUrl: "https://up.test/", accessToken: "pat-2" },
    { id: "own", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin" }];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    const data = url.pathname === "/api/user/self" ? { id: 42 }
      : url.pathname === "/api/status" ? { quota_per_unit: 100 }
        : url.pathname === "/api/user/self/groups" ? { g1: { ratio: 1 } }
          : url.pathname === "/api/token/" ? { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g1", cross_group_retry: false }] }
            : { total: 1, items: [{ id: 2, name: "二", status: 1 }] };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  await assert.rejects(module.createRule({ upstreamStationId: "duplicate", tokenId: 9, salesChannelIds: [2], timezone: "Asia/Shanghai", costCoverage: "complete" }),
    (error) => error.code === "PREVIEW_REQUIRED");
  assert.deepEqual(state.channels.map((channel) => channel.channel_id), [1]);
  assert.equal(state.created, 0);
});

test("新范围生效前、跨界和未结束窗口保留两侧金额，只有完整日确认利润", async (t) => {
  const now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const effective = Date.parse("2026-10-09T16:00:00Z");
  const { rule, module, state, rt } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  Object.assign(rule, { billing_policy: "next-complete-day", scope_version: 2, billing_effective_from_ms: effective, cost_coverage: "complete", source_binding: { 1: "r1" } });
  rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const query = async (startMs, endMs) => (await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs, endMs }, { force: true })).results[0];
  for (const [start, end, code] of [[effective - 86400000, effective, "BILLING_SCOPE_NOT_EFFECTIVE"],
    [effective - 86400000, effective + 86400000, "BILLING_SCOPE_NOT_EFFECTIVE"],
    [effective + 86400000, now, "BILLING_WINDOW_UNCONFIRMED"]]) {
    const result = await query(start, end);
    assert.equal(result.upstream.amountUsd, 1);
    assert.equal(result.downstream.amountUsd, 2.5);
    assert.equal(result.calculation.profitUsd, null);
    assert.ok(result.health.issues.some((issue) => issue.code === code));
    assert.deepEqual(result.segments[0].window, result.window, "不把生效边界裁切后金额冒充整窗");
  }
  const confirmed = await query(effective, effective + 86400000);
  assert.equal(confirmed.calculation.profitUsd, 1.5);
  rule.cost_coverage = "unknown";
  const unknown = await query(effective, effective + 86400000);
  assert.equal(unknown.calculation.profitUsd, null);
  assert.equal(unknown.upstream.knownAmountUsd, 1);
  assert.ok(unknown.health.issues.some((issue) => issue.code === "COST_COVERAGE_UNKNOWN"));
  assert.equal([...state.snapshots.values()].filter((snapshot) => JSON.parse(snapshot.source).recordType === "confirmed").length, 1);
});

test("来源版本变化废弃旧在途查询和缓存，待核对保留独立账单金额", async (t) => {
  const wait = holdPoint();
  let first = true;
  const { rule, module, state, rt } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }],
    onRequest: (request) => { if (request.path === "/api/log/self/stat" && first) { first = false; return wait.hold(); } } });
  rule.source_binding = { 1: "before" };
  let source = { version: "before", status: "confirmed" };
  rt.onboardingSource = { inspectSource: () => source, withSourceLock: (_rule, write) => write() };
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const pending = module.queryRules(input, { force: true });
  await wait.reached;
  source = { version: "after", status: "review_required" };
  wait.release();
  const result = (await pending).results[0];
  assert.equal(result.calculation.profitUsd, null);
  assert.equal(result.upstream.knownAmountUsd, 1);
  assert.equal(result.downstream.knownAmountUsd, 2.5);
  assert.ok(result.health.issues.some((issue) => issue.code === "SOURCE_BINDING_UNCONFIRMED"));
  assert.equal(state.writes, 1, "只有新版本 observation 可以保存，旧查询不能保存确认账单");
  const requests = state.statCalls.length;
  source = { version: "confirmed-again", status: "confirmed" };
  const refreshed = (await module.queryRules(input)).results[0];
  assert.equal(refreshed.calculation.profitUsd, 1.5);
  assert.ok(state.statCalls.length > requests, "来源变化不得命中旧缓存");
});

test("绑定来源尚未初始化时不确认利润，旧未绑定规则仍按 v3 读取", async (t) => {
  const { rule, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  rule.source_binding = { 1: "revision" };
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const result = (await module.queryRules(input, { force: true })).results[0];
  assert.equal(result.calculation.profitUsd, null);
  assert.equal(result.upstream.amountUsd, 1);
  assert.equal(result.downstream.amountUsd, 2.5);
});

test("旧重叠规则保留历史与收入，当前同 Key 成本只列一次且不确认利润", async (t) => {
  const { rule, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_overlap"], duplicateKeys: true });
  const { results } = await module.queryRules({ ruleIds: [rule.id, "rr_overlap"], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.ok(results.every((result) => result.calculation.profitUsd === null && result.health.issues.some((issue) => issue.code === "CANONICAL_KEY_CONFLICT")));
  assert.equal(results.reduce((sum, result) => sum + (result.upstream.countedAmountUsd ?? 0), 0), 1);
  assert.equal(results.reduce((sum, result) => sum + (result.upstream.knownAmountUsd ?? 0), 0), 2, "每行保留真实成本参考");
  assert.equal(results.reduce((sum, result) => sum + result.downstream.knownAmountUsd, 0), 5);
  assert.equal(results[1].upstream.duplicateOfRuleId, rule.id);
  assert.equal(results[1].segments[0].upstream.knownAmountUsd, 1);
  assert.equal(summarizeReconciliationTotals(results).cost, 1);
});

test("同 Key 规则停用再恢复后，普通查询不能复用另一规则的旧成本缓存", async (t) => {
  const { rule, module, rt } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_overlap"], duplicateKeys: true,
  });
  const edit = { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [1], timezone: "Asia/Shanghai" };
  await module.updateRule(rule.id, { ...edit, enabled: false });
  const input = { preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const before = (await module.queryRules(input, { force: false })).results;
  assert.equal(before.length, 1);
  assert.equal(before[0].upstream.knownAmountUsd, 1);
  assert.ok(rt._reconciliationResultCache.size);
  await module.updateRule(rule.id, { ...edit, enabled: true });
  const after = (await module.queryRules(input, { force: false })).results;
  assert.equal(after.length, 2);
  assert.equal(after.reduce((sum, result) => sum + (result.upstream.countedAmountUsd ?? 0), 0), 1);
  assert.ok(after.every((result) => result.calculation.profitUsd == null));
  assert.equal(after.find((result) => result.rule.id === "rr_overlap").upstream.duplicateOfRuleId, rule.id);
});

test("恢复同 Key 成本 owner 时，另一规则旧在途结果不能提交或重新填充缓存", async (t) => {
  const wait = holdPoint();
  let held = false;
  const { rule, module, state, rt } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_overlap"], duplicateKeys: true,
    onRequest: (request) => {
      if (request.path === "/api/log/self/stat" && !held) { held = true; return wait.hold(); }
    },
  });
  const edit = { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [1], timezone: "Asia/Shanghai" };
  await module.updateRule(rule.id, { ...edit, enabled: false });
  const input = { ruleIds: ["rr_overlap"], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const pending = module.queryRules(input, { force: false });
  await wait.reached;
  await module.updateRule(rule.id, { ...edit, enabled: true });
  wait.release();
  const result = (await pending).results[0];
  assert.equal(result.upstream.countedAmountUsd, null);
  assert.equal(result.upstream.duplicateOfRuleId, rule.id);
  assert.equal(state.writes, 1, "旧 owner 的成本观察不得落库");
  for (const row of state.snapshots.values()) {
    assert.equal(JSON.parse(row.source).result.upstream.countedAmountUsd, null);
  }
  for (const cached of rt._reconciliationResultCache.values()) {
    assert.equal(cached.value.upstream.countedAmountUsd, null);
  }
});

async function separateAccountCostFixture(t, options = {}) {
  const fixture = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_overlap"], duplicateKeys: true, channelsByRule: { rr_overlap: [2] }, ...options });
  const [rules] = await fixture.rt.pool.query("SELECT * FROM reconciliation_rules");
  rules.find((rule) => rule.id === "rr_overlap").upstream_station_id = "second";
  fixture.stations[0].accessToken = "account-eight";
  fixture.stations.push({ ...fixture.stations[0], id: "second", accessToken: "account-seven" });
  const store = sourceStore();
  store.data.stations = fixture.stations;
  fixture.rt.store = store;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host === "upstream.test" && url.pathname === "/api/user/self") {
      return { status: 200, text: async () => JSON.stringify({ success: true,
        data: { id: init.headers.Authorization === "Bearer account-eight" ? 8 : 7 } }) };
    }
    return originalFetch(input, init);
  });
  return { ...fixture, store };
}

test("两个规则从不同账号改成同账号后，原身份范围保留参考且不自动合并", async (t) => {
  const { module, store, state } = await separateAccountCostFixture(t);
  const input = { preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const before = (await module.queryRules(input, { force: false })).results;
  assert.equal(before.reduce((sum, result) => sum + (result.upstream.knownAmountUsd ?? 0), 0), 2);
  const saved = structuredClone([...state.snapshots.values()].filter((snapshot) => snapshot.rule_id === "rr_live"));
  await store.update("upstream", { accessToken: "account-seven" });
  const after = (await module.queryRules(input, { force: false })).results;
  assert.equal(after.reduce((sum, result) => sum + (result.upstream.knownAmountUsd ?? 0), 0), 1);
  assert.equal(after.find((result) => result.rule.id === "rr_live").health.code, "SOURCE_BINDING_UNCONFIRMED");
  assert.equal(after.find((result) => result.rule.id === "rr_live").calculation.profitUsd, null);
  assert.equal(after.find((result) => result.rule.id === "rr_overlap").calculation.profitUsd, 1.5);
  assert.deepEqual([...state.snapshots.values()].filter((snapshot) => snapshot.rule_id === "rr_live"), saved, "替换原账号的规则不得写入原范围");
});

test("其它参与成本判定的资源换凭证时，旧在途成本不能保存或缓存", async (t) => {
  const wait = holdPoint();
  let held = false;
  const { module, store, state, rt } = await separateAccountCostFixture(t, {
    onRequest: (request) => {
      if (request.path === "/api/log/self/stat" && !held) { held = true; return wait.hold(); }
    },
  });
  const pending = module.queryRules({ ruleIds: ["rr_overlap"], preset: "custom", timezone: "Asia/Shanghai",
    startMs: 1000000, endMs: 1060000 }, { force: false });
  await wait.reached;
  await store.update("upstream", { accessToken: "account-seven" });
  wait.release();
  const result = (await pending).results[0];
  assert.equal(result.upstream.countedAmountUsd, null);
  assert.equal(result.upstream.duplicateOfRuleId, "rr_live");
  assert.equal(state.writes, 1, "只有新的 duplicate 参考观察能保存");
  for (const row of state.snapshots.values()) assert.equal(JSON.parse(row.source).result.upstream.countedAmountUsd, null);
  for (const cached of rt._reconciliationResultCache.values()) assert.equal(cached.value.upstream.countedAmountUsd, null);
});

test("R03整批共享fresh owner证据，暂时metadata失败不自选唯一owner或重复计成本", async (t) => {
  const f = await separateAccountCostFixture(t);
  f.stations[0].accessToken = "account-seven";
  f.stations.find((station) => station.id === "second").accessToken = "candidate-seven";
  const oldFetch = globalThis.fetch;
  const identityCalls = new Map();
  let failCandidate = true;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/api/user/self") {
      const credential = init.headers.Authorization;
      identityCalls.set(credential, (identityCalls.get(credential) || 0) + 1);
      if (credential === "Bearer candidate-seven" && failCandidate) {
        failCandidate = false;
        return { status: 500, text: async () => JSON.stringify({ success: false }) };
      }
    }
    return oldFetch(input, init);
  });
  const input = { preset: "custom", startMs: 1000000, endMs: 1060000 };
  const results = (await f.module.queryRules(input, { force: true })).results;
  const healthy = results.find((result) => result.rule.id === "rr_live");
  assert.equal(healthy.upstream.knownAmountUsd, 1);
  assert.equal(healthy.upstream.countedAmountUsd, null);
  assert.equal(healthy.upstream.ownershipState, "unknown");
  assert.deepEqual(healthy.upstream.unverifiedOwnerRuleIds, ["rr_overlap"]);
  assert.equal(healthy.health.code, "COST_OWNER_UNVERIFIED");
  assert.ok(results.every((result) => result.calculation.profitUsd == null));
  assert.equal(summarizeReconciliationTotals(results).cost, null);
  assert.equal(summarizeReconciliationTotals(results).income, 5);
  for (const credential of ["Bearer account-seven", "Bearer candidate-seven", "Bearer admin"]) assert.equal(identityCalls.get(credential), 1);
  assert.ok([...f.state.snapshots.values()].every((snapshot) => JSON.parse(snapshot.source).recordType === "observation"));
  failCandidate = true;
  const single = (await f.module.queryRules({ ...input, ruleIds: ["rr_live"] })).results[0];
  assert.equal(single.upstream.ownershipState, "unknown", "只查一行仍核验未选中的参与owner");
  assert.equal(single.upstream.countedAmountUsd, null);
  const recovered = (await f.module.queryRules(input)).results;
  assert.equal(summarizeReconciliationTotals(recovered).cost, 1);
  assert.ok(recovered.every((result) => result.upstream.knownAmountUsd === 1 && result.calculation.profitUsd == null));
  for (const credential of ["Bearer account-seven", "Bearer candidate-seven", "Bearer admin"]) assert.equal(identityCalls.get(credential), 3);
});

test("R03归档owner与另一规则observation INSERT/commit串行，归档后不提交旧owner证据", async (t) => {
  for (const boundary of ["insert", "commit"]) await t.test(boundary, async (t) => {
    const wait = holdPoint();
    let held = false;
    const hold = async () => { if (!held) { held = true; await wait.hold(); } };
    const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_overlap"], duplicateKeys: true,
      onSnapshotInsert: (snapshot) => boundary === "insert" && snapshot.ruleId === "rr_overlap" ? hold() : null,
      onRepositoryCommit: (transaction) => boundary === "commit" && transaction.snapshots.some((snapshot) => snapshot.ruleId === "rr_overlap") ? hold() : null,
    });
    const store = new Store(f.rt.pool);
    store.data.stations = f.stations;
    f.rt.store = store;
    let catalogue = null;
    const onboarding = await createChannelOnboardingModule(f.rt, { repository: {
      getCatalogue: async () => catalogue, listLinks: async () => [], saveCatalogue: async (value) => { catalogue = structuredClone(value); },
    } }).load();
    f.rt.onboardingSource = onboarding;
    await onboarding.sync();
    const [rules] = await f.rt.pool.query("SELECT * FROM reconciliation_rules");
    for (const rule of rules) trustedLegacyRule(rule, f.stations, 7, 1);
    const input = { ruleIds: ["rr_overlap"], preset: "custom", startMs: 1000000, endMs: 1060000 };
    await f.module.queryRules({ ...input, ruleIds: ["rr_live"] }, { force: true });
    const ownerHistory = structuredClone([...f.state.snapshots.values()].filter((snapshot) => snapshot.rule_id === "rr_live"));
    const pending = f.module.queryRules(input, { force: true });
    await wait.reached;
    let archived = false;
    const stopping = f.module.archiveRule("rr_live").then(() => { archived = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(archived, false, "公开归档必须等待已持有source/Store锁的观察事务");
    assert.equal(f.rule.archived_at, null);
    wait.release();
    await Promise.all([pending, stopping]);
    const archiveIndex = f.state.commits.findIndex((transaction) => transaction.archivedRuleIds.includes("rr_live"));
    assert.ok(archiveIndex >= 0);
    assert.ok(f.state.commits.slice(0, archiveIndex).some((transaction) => transaction.snapshots.some((snapshot) => snapshot.source.result.upstream.duplicateOfRuleId === "rr_live")));
    assert.ok(f.state.commits.slice(archiveIndex + 1).every((transaction) => transaction.snapshots.every((snapshot) => snapshot.source.result.upstream.duplicateOfRuleId !== "rr_live")), "旧owner的observation不可在归档后提交");
    const current = (await f.module.queryRules(input)).results[0];
    assert.equal(current.upstream.countedAmountUsd, 1);
    assert.equal(current.upstream.ownershipState, "unique");
    assert.equal(current.calculation.profitUsd, 1.5);
    assert.deepEqual([...f.state.snapshots.values()].filter((snapshot) => snapshot.rule_id === "rr_live"), ownerHistory, "已归档owner的旧历史保留只读");
  });
});

test("观察事务提交期间也锁定其它参与成本归属判定的资源", async (t) => {
  const wait = holdPoint();
  let held = false;
  const { module, store } = await separateAccountCostFixture(t, {
    onRepositoryCommit: () => { if (!held) { held = true; return wait.hold(); } },
  });
  const pending = module.queryRules({ ruleIds: ["rr_overlap"], preset: "custom", timezone: "Asia/Shanghai",
    startMs: 1000000, endMs: 1060000 }, { force: false });
  await wait.reached;
  let changed = false;
  const edit = store.update("upstream", { accessToken: "account-seven" }).then(() => { changed = true; });
  await Promise.resolve();
  assert.equal(changed, false);
  assert.equal(store.get("upstream").accessToken, "account-eight");
  wait.release();
  await Promise.all([pending, edit]);
  assert.equal(store.get("upstream").accessToken, "account-seven");
});

test("整批查询期间账号归属改变，不能混合早返回的旧缓存利润和新成本 owner", async (t) => {
  const wait = holdPoint();
  let hold = false;
  const { module, store } = await separateAccountCostFixture(t, {
    onRequest: (request) => {
      if (hold && request.path === "/api/log/self/stat") { hold = false; return wait.hold(); }
    },
  });
  const input = { preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const cached = (await module.queryRules({ ...input, ruleIds: ["rr_live"] }, { force: false })).results[0];
  assert.equal(cached.calculation.profitUsd, 1.5);
  hold = true;
  const pending = module.queryRules(input, { force: false });
  await wait.reached;
  await store.update("upstream", { accessToken: "account-seven" });
  wait.release();
  const after = (await pending).results;
  assert.equal(after.reduce((sum, result) => sum + (result.upstream.knownAmountUsd ?? 0), 0), 1);
  assert.equal(after.find((result) => result.rule.id === "rr_live").health.code, "SOURCE_BINDING_UNCONFIRMED");
  assert.equal(after.find((result) => result.rule.id === "rr_live").calculation.profitUsd, null);
  assert.equal(after.find((result) => result.rule.id === "rr_overlap").calculation.profitUsd, 1.5);
});

test("参与成本判定资源持续换凭证时，整批有界返回待获取且不保存旧成本", async (t) => {
  let fixture, changes = 0;
  fixture = await separateAccountCostFixture(t, {
    onRequest: async (request) => {
      if (request.path === "/api/log/self/stat") await fixture.store.update("upstream", { accessToken: `account-seven-${++changes}` });
    },
  });
  const { results } = await fixture.module.queryRules({ ruleIds: ["rr_overlap"], preset: "custom", timezone: "Asia/Shanghai",
    startMs: 1000000, endMs: 1060000 }, { force: false });
  assert.equal(results[0].health.code, "PENDING");
  assert.equal(results[0].upstream?.knownAmountUsd ?? null, null);
  assert.equal(fixture.state.writes, 0);
  assert.equal(fixture.rt._reconciliationResultCache.size, 0);
  assert.ok(changes <= 9, "单行与整批均最多重试三次");
});

test("换到另一稳定账号的授权不能写入原 Key 的分段或来源历史", async (t) => {
  const { rule, module, state, segments, stations } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", ratio: null, from: 0 }],
  });
  rule.canonical_key = canonicalBillingKey(stations[0], { platform: "newapi", accountId: 7 }, 9);
  stations[0].accessToken = "replacement-account-pat";
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host === "upstream.test" && url.pathname === "/api/user/self") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { id: 8 } }) };
    }
    if (url.host === "upstream.test" && url.pathname === "/api/token/") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 1,
        items: [{ id: 9, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } }) };
    }
    return originalFetch(input, init);
  });
  const historyBefore = structuredClone(segments);
  const observed = t.mock.method(ReconciliationRepository.prototype, "observeSource");
  const result = (await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai",
    startMs: 1000000, endMs: 1060000 }, { force: true })).results[0];
  assert.equal(result.health.code, "SOURCE_BINDING_UNCONFIRMED");
  assert.equal(result.calculation.profitUsd, null);
  assert.equal(result.downstream.knownAmountUsd, 2.5, "本站金额仍独立保留");
  assert.equal(observed.mock.callCount(), 0, "账号身份核对须先于任何来源历史写入");
  assert.deepEqual(segments, historyBefore);
  assert.equal(rule.fixed_group, "g1");
  assert.deepEqual(state.ratioWrites, []);
  assert.deepEqual(state.channelStateWrites, []);
  assert.equal(state.statCalls.filter((call) => call.side === "upstream").length, 0);
});

test("Sub2API Key/date核验保留实际扣费，缺部署时区证据不确认整日利润", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  const { rule, rt, stations, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "7", ratio: null, from: 0 }] });
  Object.assign(stations[0], { type: "sub2api", baseUrl: "https://sub2-caller.test", accessToken: "jwt" });
  const startMs = Date.parse("2026-10-09T16:00:00Z");
  Object.assign(rule, { billing_policy: "next-complete-day", scope_version: 1, billing_effective_from_ms: startMs, cost_coverage: "complete", source_binding: { 1: "r1" } });
  rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const ownFetch = globalThis.fetch;
  let cost = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host !== "sub2-caller.test") return ownFetch(input, init);
    const reply = (status, data) => ({ status, text: async () => JSON.stringify({ code: status === 200 ? 0 : 1, data }) });
    if (url.pathname === "/api/v1/auth/me") return reply(200, { id: 7 });
    if (url.pathname === "/api/v1/keys") return reply(200, { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: "active", group_id: 7 }] });
    if (url.pathname.startsWith("/api/v1/keys/")) return reply(404, {});
    const control = url.searchParams.get("api_key_id") !== "9" || url.searchParams.get("start_date") !== "2026-10-10";
    return reply(200, cost == null ? { total_cost: 100 } : { total_actual_cost: control ? 0 : cost });
  });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs, endMs: startMs + 86400000 };
  const zero = (await module.queryRules(input, { force: true })).results[0];
  assert.equal(zero.upstream.state, "partial");
  assert.equal(zero.upstream.knownAmountUsd, 0);
  assert.equal(zero.downstream.amountUsd, 2.5);
  assert.equal(zero.calculation.profitUsd, null);
  cost = 1;
  const complete = (await module.queryRules(input, { force: true })).results[0];
  assert.equal(complete.upstream.amountUsd, 1);
  assert.equal(complete.upstream.quotaPerUnit, null, "实际美元扣费不通过不存在的 quota 除数推算");
  assert.equal(complete.calculation.profitUsd, null);
  assert.equal(complete.billingTimezone.state, "unverified");
  assert.ok(complete.health.issues.some((issue) => issue.code === "BILLING_TIMEZONE_UNVERIFIED"));
  cost = null;
  const missing = (await module.queryRules(input, { force: true })).results[0];
  assert.equal(missing.upstream.knownAmountUsd, null);
  assert.equal(missing.downstream.knownAmountUsd, 2.5);
  assert.equal(missing.calculation.profitUsd, null);
});

test("Sub2API 密码/邮箱变更废弃元数据缓存，JWT 自动续期不改变授权身份", async (t) => {
  const { stations, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "7", ratio: null, from: 0 }] });
  Object.assign(stations[0], { type: "sub2api-password", baseUrl: "https://sub2-cache.test", email: "old@example.test", password: "old-password", authVersion: 1 });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, auth: init.headers?.Authorization });
    const data = url.pathname === "/api/v1/auth/login" ? { access_token: JSON.parse(init.body).password, refresh_token: "r", expires_in: 3600 }
      : url.pathname === "/api/v1/auth/me" ? { id: 7 }
        : { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: "active", group_id: 7 }] };
    return { status: 200, text: async () => JSON.stringify({ code: 0, data }) };
  });
  await module.getUpstreamKeys("upstream");
  stations[0].s2Tokens = { accessToken: "rotated-jwt", expiresAt: Date.now() + 1000000 };
  await module.getUpstreamKeys("upstream");
  assert.equal(requests.filter((request) => request.path === "/api/v1/keys").length, 1);
  Object.assign(stations[0], { email: "new@example.test", password: "new-password", authVersion: 2 });
  await module.getUpstreamKeys("upstream");
  const keys = requests.filter((request) => request.path === "/api/v1/keys");
  assert.equal(keys.length, 2);
  assert.equal(keys.at(-1).auth, "Bearer new-password");
  assert.equal(stations[0].s2Tokens.accessToken, "rotated-jwt", "账单查询只使用临时连接");
});

test("目录在创建取数期间变化时，即使新的待核对状态稳定也不能提交过期确认", async (t) => {
  const { pool, state } = membershipFixture();
  const stations = [{ id: "up", type: "newapi", baseUrl: "https://up.test", accessToken: "pat" },
    { id: "own", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin" }];
  let revision = "before";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/channel/") revision = "after";
    const data = url.pathname === "/api/user/self" ? { id: 42 }
      : url.pathname === "/api/status" ? { quota_per_unit: 100 }
        : url.pathname === "/api/user/self/groups" ? { g1: { ratio: 1 } }
          : url.pathname === "/api/token/" ? { total: 1, items: [{ id: 9, name: "stable", status: 1, group: "g1", cross_group_retry: false }] }
            : { total: 1, items: [{ id: 2, name: "二", status: 1 }] };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const rt = { pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) },
    onboardingSource: { inspectSource: (rule) => ({ version: revision, status: rule.sourceBinding?.[2] === revision ? "confirmed" : "review_required" }) } };
  await assert.rejects(createReconciliationModule(rt).createRule({ upstreamStationId: "up", tokenId: 9, salesChannelIds: [2], timezone: "Asia/Shanghai",
    costCoverage: "complete", sourceBinding: { 1: "r1", 2: "before" } }), (error) => error.code === "PREVIEW_REQUIRED");
  assert.equal(state.rules[0].scope_version, undefined);
  assert.deepEqual(state.channels.map((channel) => channel.channel_id), [1]);
});

test("Sub2API 密码在账单请求期间变化时，旧扣费不能写快照或重新填充缓存", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  const { rule, rt, stations, module, state } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "7", ratio: null, from: 0 }] });
  Object.assign(stations[0], { type: "sub2api-password", baseUrl: "https://sub2-password-race.test", email: "old@example.test", password: "old-password", authVersion: 1 });
  const startMs = Date.parse("2026-10-09T16:00:00Z");
  Object.assign(rule, { billing_policy: "next-complete-day", scope_version: 1, billing_effective_from_ms: startMs, cost_coverage: "complete", source_binding: { 1: "r1" } });
  rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const ownFetch = globalThis.fetch;
  const oldStat = holdPoint();
  let held = false;
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    if (url.host !== "sub2-password-race.test") return ownFetch(input, init);
    const reply = (status, data) => ({ status, text: async () => JSON.stringify({ code: status === 200 ? 0 : 1, data }) });
    if (url.pathname === "/api/v1/auth/login") return reply(200, { access_token: JSON.parse(init.body).password, expires_in: 3600 });
    if (url.pathname === "/api/v1/auth/me") return reply(200, { id: 7 });
    if (url.pathname === "/api/v1/keys") return reply(200, { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: "active", group_id: 7 }] });
    if (url.pathname.startsWith("/api/v1/keys/")) return reply(404, {});
    const control = url.searchParams.get("api_key_id") !== "9" || url.searchParams.get("start_date") !== "2026-10-10";
    const old = init.headers.Authorization === "Bearer old-password";
    if (!control && old && !held) { held = true; await oldStat.hold(); }
    return reply(200, { total_actual_cost: control ? 0 : old ? 1 : 2 });
  });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs, endMs: startMs + 86400000 };
  const pending = module.queryRules(input, { force: true });
  await oldStat.reached;
  Object.assign(stations[0], { email: "new@example.test", password: "new-password", authVersion: 2 });
  oldStat.release();
  const result = (await pending).results[0];
  assert.equal(result.upstream.amountUsd, 2);
  assert.equal(result.calculation.profitUsd, null, "新授权的实际成本保留，缺时区证据仍不确认整日利润");
  assert.equal(result.billingTimezone.state, "unverified");
  assert.equal(state.writes, 1, "只写新授权的 observation，旧扣费不得落库");
  assert.ok([...state.snapshots.values()].every((snapshot) => JSON.parse(snapshot.source).result.upstream.amountUsd === 2));
  assert.equal([...rt._reconciliationResultCache.values()][0].value.upstream.amountUsd, 2);
});

function confirmedHistoryFixture() {
  const startMs = Date.parse("2026-10-07T16:00:00Z"), endMs = startMs + 86400000;
  const window = { preset: "yesterday", startMs, endMs, timezone: "Asia/Shanghai" };
  const ownSource = { stationId: "old-own", provider: "newapi", baseUrl: "https://old-own.test", accountId: "11", namespaceKey: "old-own-namespace" };
  const source = { calculationVersion: 3, billingSource: "channel-log-stat", recordType: "confirmed", window,
    scopeFingerprint: "old-scope", resultGeneratedAt: "2026-10-08T16:01:00.000Z",
    scopePolicy: { scopeVersion: 1, billingEffectiveFrom: startMs, ownSource },
    ruleEvidence: { ownSource, upstreamIdentity: { provider: "newapi", baseUrl: "https://old-up.test", accountId: "7" },
      canonicalKey: "old-key", tokenId: 9, tokenName: "old-name", channels: [{ channelId: 1, name: "old-one" }], scopeVersion: 1 },
    result: { upstream: { state: "complete", amountUsd: 2, knownAmountUsd: 2, quotaUnits: 200, quotaPerUnit: 100, accessToken: "raw-secret" },
      downstream: { state: "complete", amountUsd: 3, knownAmountUsd: 3, channels: [{ channelId: 1, name: "old-one", billingState: "complete", amountUsd: 3, password: "raw-secret" }] },
      calculation: { differenceUsd: 1, profitUsd: 1, marginRate: 1 / 3 }, diagnostic: { apiKey: "raw-secret" } },
    raw: { password: "raw-secret" } };
  const row = { rule_id: "old-rule", snapshot_key: "old-bill-a", window_kind: "yesterday", window_start_ms: startMs,
    window_end_ms: endMs, generated_at: new Date("2026-10-08T16:01:01Z"), cursor_generated_at: "2026-10-08 16:01:01", source };
  const state = { rows: [row], queries: [], fail: false, rule: { id: "old-rule", upstream_station_id: "new-up", own_station_id: "new-own",
    token_id: 99, token_name: "new-name", timezone: "UTC", scope_version: 2, enabled: 0, archived_at: new Date("2026-10-09T00:00:00Z") } };
  const pool = { async getConnection() { assert.fail("history must not open a write transaction"); }, async query(sql, params = []) {
    state.queries.push({ sql, params });
    assert.ok(sql.startsWith("SELECT") || sql.startsWith("WITH"), "history/configuration only read");
    if (state.fail) throw new Error("database failure raw-secret");
    if (sql.includes("WITH evidence AS")) {
      assert.match(sql, /ROW_NUMBER\(\) OVER/); assert.match(sql, /WHERE logical_rank = 1 AND logical_start >= \? AND logical_end <= \?/);
      const filtered = state.rows.filter((entry) => entry.rule_id === params[0]);
      const start = params.length > 4 ? filtered.findIndex((entry) => entry.snapshot_key === params[8]) + 1 : 0;
      return [filtered.slice(start, start + params.at(-1))];
    }
    if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: "old-rule", channel_id: 2, channel_name: "new-two" }]];
    if (sql.includes("FROM reconciliation_rules")) return [[state.rule].filter((rule) => (!params.length || rule.id === params[0])
      && (!sql.includes("archived_at IS NULL") || !rule.archived_at))];
    assert.fail(`Unexpected history read: ${sql}`);
  } };
  const rt = { pool, store: { list: () => [], get: () => null, auth: { isDefault: false } },
    sessions: { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 } };
  return { state, rt, row, source, window, module: createReconciliationModule(rt), repository: new ReconciliationRepository(pool) };
}

test("U05已归档规则历史保留原scope/source/window/members且白名单不泄漏raw，零上游零写", async (t) => {
  const f = confirmedHistoryFixture();
  t.mock.method(globalThis, "fetch", async () => { assert.fail("history must not query upstream"); });
  const result = await f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs });
  assert.equal(result.readOnly, true); assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.deepEqual(record.window, f.window); assert.equal(record.scopeVersion, 1);
  assert.equal(record.ownSource.accountId, "11"); assert.equal(record.upstreamSource.accountId, "7");
  assert.equal(record.upstreamSource.tokenId, 9); assert.equal(record.upstreamSource.tokenName, "old-name");
  assert.deepEqual(record.channels, [{ channelId: 1, name: "old-one" }]); assert.equal(record.sourceCompleteness, "complete");
  assert.doesNotMatch(JSON.stringify(result), /raw-secret|accessToken|password|apiKey|new-two|new-name|diagnostic/);
  assert.equal(record.calculation.profitUsd, 1); assert.equal(record.downstream.amountUsd, 3);
  assert.ok(f.state.queries.every(({ sql }) => !sql.includes("FOR UPDATE") && !sql.includes("scopeFingerprint =")));
  f.state.fail = true;
  await assert.rejects(f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs }),
    (error) => error.code === "HISTORY_UNAVAILABLE" && !error.message.includes("raw-secret"));
});

test("U05历史真实长epoch原窗口JSON不被physical半段替换，同logical账单historyId稳定", async (t) => {
  const f = confirmedHistoryFixture();
  t.mock.method(globalThis, "fetch", async () => { assert.fail("history must not query upstream"); });
  const window = { preset: "yesterday", startMs: 1791417600000, endMs: 1791504000000, timezone: "UTC" };
  const source = { ...f.source, window, scopeFingerprint: "original-scope", resultGeneratedAt: "2026-10-09T00:00:00Z",
    result: { ...f.source.result, calculation: { profitUsd: 4 } } };
  const midpoint = window.startMs + 12 * 3600000;
  const records = [];
  for (const [snapshot_key, window_start_ms, window_end_ms] of [
    ["original-a", window.startMs, midpoint], ["original-z", midpoint, window.endMs],
  ]) {
    // Feed each possible SQL representative separately; collapse/range are verified by the MySQL engine cases.
    f.state.rows = [{ ...f.row, snapshot_key, window_start_ms, window_end_ms, source: JSON.stringify(source) }];
    const result = await f.module.getConfirmedHistory("old-rule", { startMs: window.startMs, endMs: window.endMs });
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.deepEqual(record.window, window);
    assert.deepEqual(record.upstream.window, window); assert.deepEqual(record.downstream.window, window);
    assert.equal(record.calculation.profitUsd, 4); assert.equal(record.scopeFingerprint, "original-scope");
    assert.doesNotMatch(JSON.stringify(result), /raw-secret|new-name|new-two/);
    records.push(record);
  }
  assert.equal(records[0].historyId, records[1].historyId);
  assert.ok(f.state.queries.every(({ sql }) => sql.startsWith("SELECT") || sql.startsWith("WITH")));
});

test("U05历史storage cursor/limit+1分页与legacy distinct ID，0及负profit原样保留", async () => {
  const f = confirmedHistoryFixture();
  const first = { ...structuredClone(f.row), snapshot_key: "old-bill-z", source: { ...structuredClone(f.source), result: { ...structuredClone(f.source.result), calculation: { profitUsd: 0 } } } };
  const second = { ...structuredClone(f.row), snapshot_key: "old-bill-y", source: { ...structuredClone(f.source), scopeFingerprint: "second-scope", result: { ...structuredClone(f.source.result), calculation: { profitUsd: -1 } } } };
  f.state.rows = [first, second];
  const options = { startMs: f.window.startMs, endMs: f.window.endMs, limit: 1 };
  const page1 = await f.repository.listConfirmedHistory("old-rule", options);
  assert.equal(page1.records[0].calculation.profitUsd, 0); assert.ok(page1.nextCursor);
  assert.deepEqual(JSON.parse(Buffer.from(page1.nextCursor, "base64url")), [f.window.endMs, "2026-10-08 16:01:01", "old-bill-z"]);
  const page2 = await f.repository.listConfirmedHistory("old-rule", { ...options, cursor: page1.nextCursor });
  assert.equal(page2.records[0].calculation.profitUsd, -1); assert.equal(page2.nextCursor, null);
  assert.notEqual(page1.records[0].historyId, page2.records[0].historyId);
  assert.equal(f.state.queries[0].params.at(-1), 2);
  const legacy = { ...f.row, source: { ...f.source, window: null, ruleEvidence: null, scopeFingerprint: null, resultGeneratedAt: null } };
  const a = reconciliationConfirmedHistoryRecord(legacy), b = reconciliationConfirmedHistoryRecord({ ...legacy, snapshot_key: "other-legacy" });
  assert.notEqual(a.historyId, b.historyId); assert.equal(a.sourceCompleteness, "legacy_partial");
  assert.equal(a.window.timezone, null); assert.equal(a.upstreamSource.accountId, null);
  assert.deepEqual(a.channels, [{ channelId: 1, name: "old-one" }]);
  const sameLogical = reconciliationConfirmedHistoryRecord({ ...f.row, snapshot_key: "another-segment", window_start_ms: f.window.startMs + 1000 });
  assert.equal(sameLogical.historyId, reconciliationConfirmedHistoryRecord(f.row).historyId);
  f.state.rows = ["legacy-null-z", "legacy-null-y"].map((snapshot_key) => ({ ...legacy, snapshot_key, source: { ...legacy.source, window: f.window } }));
  const nullFacts = await f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs });
  assert.equal(nullFacts.records.length, 2);
  assert.notEqual(nullFacts.records[0].historyId, nullFacts.records[1].historyId, "原scope/generation显式JSON null仍以saved row区分");
  assert.ok(nullFacts.records.every((record) => record.sourceCompleteness === "legacy_partial" && record.upstreamSource.accountId == null));
});

test("U05历史请求31日默认/最大与数量cap，非法参数在数据库读取前拒绝", async (t) => {
  const f = confirmedHistoryFixture(), now = Date.parse("2026-10-09T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  await f.module.getConfirmedHistory("old-rule");
  const query = f.state.queries.find(({ sql }) => sql.includes("WITH evidence AS"));
  assert.deepEqual(query.params, ["old-rule", now - 31 * 86400000, now, 21]);
  await f.module.getConfirmedHistory("old-rule", { limit: 100 }); assert.equal(f.state.queries.at(-1).params.at(-1), 51);
  for (const input of [{ startMs: now - 32 * 86400000, endMs: now }, { startMs: now, endMs: now }, { limit: 0 },
    { limit: 1.5 }, { cursor: "bad" }, { cursor: Buffer.from(JSON.stringify([1, "2026-02-31 00:00:00", "a"])).toString("base64url") }, { endMs: "" }]) {
    const before = f.state.queries.length;
    await assert.rejects(f.module.getConfirmedHistory("old-rule", input), (error) => error.code === "INVALID_REQUEST");
    assert.equal(f.state.queries.length, before);
  }
});

test("U05真实withAuth历史/configuration opt-in：归档入口可发现、默认/非法flag不返回，错误安全可重试", async (t) => {
  const f = confirmedHistoryFixture();
  t.mock.method(globalThis, "fetch", async () => { assert.fail("read-only history must not fetch upstream"); });
  const { registerHooks } = await import("node:module");
  globalThis.__u05HistoryRuntime = f.rt;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "next/server") return { url: "test:u05-history-next", shortCircuit: true };
    if (specifier.endsWith("/lib/api.js")) return { url: new URL(`${specifier}?u05-history-auth`, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === "test:u05-history-next") return { format: "module", shortCircuit: true, source: "export const NextResponse={json:(value,init)=>Response.json(value,init)};" };
    if (url.endsWith("/lib/runtime.js")) return { format: "module", shortCircuit: true, source: "export const getRuntime=async()=>globalThis.__u05HistoryRuntime;" };
    return next(url, context);
  } });
  try {
    const { GET } = await import("../app/api/reconciliation/rules/[id]/confirmed/route.js");
    const { GET: CONFIGURATION } = await import("../app/api/reconciliation/configuration/route.js");
    const url = `http://localhost/api/reconciliation/rules/old-rule/confirmed?startMs=${f.window.startMs}&endMs=${f.window.endMs}`;
    const ctx = { params: Promise.resolve({ id: "old-rule" }) };
    assert.equal((await GET(new Request(url), ctx)).status, 401);
    const request = (value) => new Request(value, { headers: { cookie: "rm_session=valid" } });
    const response = await GET(request(url), ctx); assert.equal(response.status, 200);
    assert.equal((await response.json()).records[0].upstreamSource.tokenName, "old-name");
    for (const suffix of ["", "?includeArchived=1", "?includeArchived=TRUE", "?includeArchived=false"]) {
      assert.deepEqual((await (await CONFIGURATION(request(`http://localhost/api/reconciliation/configuration${suffix}`))).json()).rules, []);
    }
    const archived = await (await CONFIGURATION(request("http://localhost/api/reconciliation/configuration?includeArchived=true"))).json();
    assert.equal(archived.rules[0].id, "old-rule"); assert.ok(archived.rules[0].archivedAt);
    const invalid = await GET(request(`${url}&cursor=bad`), ctx); assert.equal(invalid.status, 400);
    const missing = await GET(request(url), { params: { id: "missing" } }); assert.equal(missing.status, 404);
    f.state.fail = true;
    const failed = await GET(request(url), ctx); assert.equal(failed.status, 503);
    const body = await failed.json(); assert.equal(body.code, "HISTORY_UNAVAILABLE"); assert.equal(body.retryable, true);
    assert.doesNotMatch(JSON.stringify(body), /raw-secret|database failure/);
  } finally { hooks.deregister(); delete globalThis.__u05HistoryRuntime; }
});

test("U05未来snapshot保存原ruleEvidence，随后配置/成员变化不能改写已存原账", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000000 }] });
  trustedLegacyRule(f.rule, f.stations, 7, 1);
  await f.module.queryRules({ ruleIds: [f.rule.id], preset: "custom", startMs: 1000000, endMs: 1060000 }, { force: true });
  const snapshot = [...f.state.snapshots.values()].find((row) => JSON.parse(row.source).recordType === "confirmed");
  assert.ok(snapshot);
  const evidence = JSON.parse(snapshot.source).ruleEvidence;
  assert.deepEqual(evidence.upstreamIdentity, { provider: "newapi", baseUrl: "https://upstream.test", accountId: "7" });
  assert.deepEqual(evidence.channels, [{ channelId: 1, name: "渠道" }]); assert.equal(evidence.tokenName, "stable");
  f.rule.token_name = "new-name"; f.rule.scope_version = 2; f.stations[0].baseUrl = "https://new-up.test";
  assert.deepEqual(JSON.parse(snapshot.source).ruleEvidence, evidence);
  assert.doesNotMatch(JSON.stringify(evidence), /accessToken|password|apiKey|admin|pat/);
});

async function completedDayFixture(t, { now = "2026-10-09T03:00:00Z", channelsByRule = { rr_live: [1], rr_two: [2], rr_three: [3] }, ...options } = {}) {
  t.mock.method(Date, "now", () => Date.parse(now));
  const channels = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}`, status: 1, revision: `r${index + 1}` }));
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_two", "rr_three"],
    ownChannels: () => channels.filter((channel) => !channel.missing), channelsByRule, ...options });
  const [rows] = await f.rt.pool.query("SELECT * FROM reconciliation_rules");
  for (const row of rows) {
    Object.assign(row, { billing_policy: "next-complete-day", scope_version: 1, billing_effective_from_ms: Date.parse("2026-10-06T16:00:00Z"), cost_coverage: "complete" });
    trustedLegacyRule(row, f.stations, 7, 1);
    row.source_binding.channels = Object.fromEntries((channelsByRule[row.id] || [1]).map((id) => [id, `r${id}`]));
  }
  const catalogue = { ownSource: rows[0].source_binding.ownSource, sourceVersion: "catalogue-v1", syncedAt: Date.now(), stale: false,
    totalValidated: true, catalogueTotal: 10, channels };
  f.rt.onboardingSource = { getSourceCatalogue: () => structuredClone(catalogue), inspectSource: () => ({ version: catalogue.sourceVersion, status: "confirmed", issues: [] }) };
  return { ...f, rows, catalogue, channels };
}

test("U05真实NewAPI默认完整昨日：3/10全局known覆盖、局部重试复用同窗有效事实且group仅选中金额", async (t) => {
  const f = await completedDayFixture(t);
  const full = await f.module.queryRules();
  assert.equal(full.results.length, 3);
  assert.equal(full.results[0].window.preset, "yesterday");
  assert.deepEqual([full.results[0].window.startMs, full.results[0].window.endMs], [Date.parse("2026-10-07T16:00:00Z"), Date.parse("2026-10-08T16:00:00Z")]);
  assert.ok(full.results.every((row) => row.billingTimezone.state === "verified" && row.calculation.profitUsd === 1.5));
  assert.deepEqual([full.coverage.knownChannelCount, full.coverage.accountedChannelCount, full.coverage.state, full.coverage.wholeSiteState], [10, 3, "partial", "unverified"]);
  assert.equal(full.windowGroups.length, 1);
  assert.deepEqual(full.commonSummary.totals, { knownIncomeUsd: 7.5, knownCostUsd: 3, confirmedProfitUsd: 4.5, confirmedMarginRate: 0.6, profitComplete: false, notCountedCostRuleIds: [] });
  const selected = await f.module.queryRules({ ruleIds: ["rr_live"] });
  assert.equal(selected.results.length, 1);
  assert.equal(selected.windowGroups[0].totals.knownIncomeUsd, 2.5, "局部group totals仅含本次选中规则");
  assert.deepEqual([selected.coverage.knownChannelCount, selected.coverage.accountedChannelCount], [10, 3], "同窗有效且未改业务事实的缓存账单保持全局known覆盖");
  assert.deepEqual([selected.windowGroups[0].coverage.knownChannelCount, selected.windowGroups[0].coverage.accountedChannelCount], [10, 3]);
  assert.equal(f.state.statCalls.length, 6, "局部force=false可复用已有本窗账单");
  assert.ok(full.coverage.channels.find((channel) => channel.channelId === 9).actions.some((action) => action.href === "/stations?action=connect&ownStationId=own&channelIds=9"));
});

test("U05首次局部缺其余账单证据为unknown，0规则仍0/10；凭据/Key业务变化不能借旧cache变accounted", async (t) => {
  const f = await completedDayFixture(t);
  const first = await f.module.queryRules({ ruleIds: ["rr_live"] });
  assert.deepEqual([first.coverage.knownChannelCount, first.coverage.accountedChannelCount, first.coverage.state], [10, 1, "unknown"]);
  assert.ok(first.coverage.channels.find((channel) => channel.channelId === 2).issues.includes("BILLING_EVIDENCE_NOT_QUERIED"));
  await f.module.queryRules();
  f.stations[0].authVersion = 2;
  const changed = await f.module.queryRules({ ruleIds: ["rr_live"] });
  assert.deepEqual([changed.coverage.knownChannelCount, changed.coverage.accountedChannelCount, changed.coverage.state], [10, 1, "unknown"]);
  await f.module.queryRules();
  const oldFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host === "upstream.test" && url.pathname === "/api/token/") return { status: 200, text: async () => JSON.stringify({ success: true,
      data: { total: 3, items: f.rows.map((row) => ({ id: row.token_id, name: row.id === "rr_two" ? "changed-name" : row.token_name, group: "g1", status: 1 })) } }) };
    return oldFetch(input, init);
  });
  const keyChanged = await f.module.queryRules({ ruleIds: ["rr_live"] });
  assert.equal(keyChanged.coverage.accountedChannelCount, 1);
  assert.equal(keyChanged.coverage.state, "unknown");
  for (const row of f.rows) row.enabled = 0;
  const calls = f.state.requests.length;
  const empty = await f.module.queryRules();
  assert.deepEqual(empty.results, []);
  assert.deepEqual([empty.coverage.knownChannelCount, empty.coverage.accountedChannelCount, empty.coverage.state], [10, 0, "partial"]);
  assert.equal(f.state.requests.length, calls, "无启用规则只读已保存目录，不抓新账单");
  assert.equal(empty.commonSummary, null);
});

test("U05昨天有收费而今天disabled/missing仍保留真实金额，stale/无total/unknown来源不冒充全站覆盖", async (t) => {
  const f = await completedDayFixture(t, { channelsByRule: { rr_live: [1], rr_two: [2], rr_three: [9] } });
  f.channels[1].status = 2; f.channels[8].missing = true;
  f.rt.onboardingSource.inspectSource = (rule) => ({ version: f.catalogue.sourceVersion, status: rule.channels.some((channel) => channel.channelId === 9) ? "review_required" : "confirmed" });
  const actual = await f.module.queryRules();
  const missing = actual.results.find((row) => row.rule.id === "rr_three");
  assert.equal(missing.downstream.channels[0].state, "missing");
  assert.equal(missing.downstream.amountUsd, 2.5);
  assert.equal(missing.calculation.profitUsd, null);
  assert.equal(actual.results.find((row) => row.rule.id === "rr_two").downstream.amountUsd, 2.5);
  assert.deepEqual([actual.coverage.knownChannelCount, actual.coverage.accountedChannelCount], [10, 2]);
  assert.equal(actual.coverage.channels.find((channel) => channel.channelId === 2).operatingState, "manual_disabled");
  assert.equal(actual.coverage.channels.find((channel) => channel.channelId === 9).operatingState, "missing");
  assert.equal(actual.windowGroups[0].totals.knownIncomeUsd, 7.5);
  assert.equal(actual.commonSummary, null, "来源待核对的参与规则不形成共同整日汇总");
  f.catalogue.stale = true;
  const stale = await f.module.queryRules();
  assert.deepEqual([stale.coverage.state, stale.coverage.catalogueState, stale.coverage.accountedChannelCount], ["unknown", "unknown", 0]);
  assert.equal(stale.coverage.knownChannelCount, 10);
  f.catalogue.stale = false; f.catalogue.totalValidated = false; f.catalogue.catalogueTotal = null;
  assert.equal((await f.module.queryRules()).coverage.state, "unknown");
  f.rows[2].source_binding = null; f.rows[2].enabled = 0;
  const unknown = await f.module.queryRules();
  assert.equal(unknown.coverage.knownChannelCount, 11, "缺原namespace的旧对象不能按同一个数字9合并到目录");
  assert.equal(unknown.coverage.channels.filter((channel) => channel.channelId === 9).length, 2);
});

test("U05重复实际来源渠道收入只按最新成功样本计一次，所有冲突利润null且Key成本仍单次", async (t) => {
  const f = await completedDayFixture(t, { channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [3] } });
  const actual = await f.module.queryRules();
  for (const row of actual.results.filter((item) => item.rule.id !== "rr_three")) {
    assert.equal(row.downstream.amountUsd, 2.5); assert.equal(row.calculation.profitUsd, null);
    assert.ok(row.health.issues.some((issue) => issue.code === "DUPLICATE_CHANNEL_ASSIGNMENT" && issue.ruleIds.includes("rr_live") && issue.ruleIds.includes("rr_two")));
    assert.ok(row.actions.some((action) => action.kind === "review_conflict"));
  }
  assert.deepEqual([actual.coverage.knownChannelCount, actual.coverage.accountedChannelCount], [10, 1]);
  assert.equal(actual.coverage.channels.find((channel) => channel.channelId === 1).status, "duplicate");
  assert.deepEqual([actual.windowGroups[0].totals.knownIncomeUsd, actual.windowGroups[0].totals.knownCostUsd, actual.windowGroups[0].totals.confirmedProfitUsd], [5, 3, 1.5]);
  assert.ok([...f.state.snapshots.values()].filter((row) => ["rr_live", "rr_two"].includes(row.rule_id)).every((row) => JSON.parse(row.source).recordType === "observation"));
  f.rows[1].token_id = f.rows[0].token_id; f.rows[1].token_name = f.rows[0].token_name;
  trustedLegacyRule(f.rows[1], f.stations, 7, 1); f.rows[1].source_binding.channels = { 1: "r1" };
  const shared = await f.module.queryRules({}, { force: true });
  assert.equal(shared.windowGroups[0].totals.knownCostUsd, 2);
  assert.deepEqual(shared.windowGroups[0].totals.notCountedCostRuleIds, ["rr_two"]);
  assert.equal(shared.results.find((row) => row.rule.id === "rr_two").upstream.amountUsd, 1, "重复Key的raw成本仍显示，父级counted金额仅一次");
});

test("U05真实旧规则首次安全锚定共享namespace阻断重复成员，首轮不能落confirmed利润", async (t) => {
  const f = await completedDayFixture(t, { channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [3] } });
  for (const row of f.rows) Object.assign(row, { billing_policy: "legacy-v3", canonical_key: null, source_binding: null });
  const before = f.rows.map((row) => [row.id, row.scope_version, row.billing_effective_from_ms]);
  const actual = await f.module.queryRules();
  assert.ok(actual.results.filter((row) => row.rule.id !== "rr_three").every((row) => row.calculation.profitUsd == null && row.health.issues.some((issue) => issue.code === "DUPLICATE_CHANNEL_ASSIGNMENT")));
  assert.equal(actual.windowGroups[0].totals.knownIncomeUsd, 5);
  assert.ok([...f.state.snapshots.values()].filter((row) => row.rule_id !== "rr_three").every((row) => JSON.parse(row.source).recordType === "observation"));
  assert.deepEqual(f.rows.map((row) => [row.id, row.scope_version, row.billing_effective_from_ms]), before, "安全首锚定不推进原范围日期和版本");
});

test("U05实际Shanghai/UTC按绝对窗口分组；同绝对已核验标签可合组，today/custom短窗不进完整日汇总", async (t) => {
  const f = await completedDayFixture(t);
  f.rows[1].timezone = "UTC";
  const split = await f.module.queryRules();
  assert.equal(split.windowGroups.length, 2); assert.equal(split.commonSummary, null);
  assert.notEqual(split.results[0].window.startMs, split.results[1].window.startMs);
  assert.ok(split.results.every((row) => row.billingTimezone.state === "verified"));
  f.rows[1].timezone = "Asia/Singapore";
  const compatible = await f.module.queryRules();
  assert.equal(compatible.windowGroups.length, 1); assert.ok(compatible.commonSummary);
  assert.deepEqual(compatible.windowGroups[0].timezones, ["Asia/Shanghai", "Asia/Singapore"]);
  const today = await f.module.queryRules({ preset: "today" });
  assert.equal(today.commonSummary, null); assert.equal(today.windowGroups[0].totals.confirmedProfitUsd, null);
  assert.ok(today.results.every((row) => row.calculation.profitUsd == null));
  for (const row of f.rows) Object.assign(row, { billing_policy: "legacy-v3", source_binding: { ...row.source_binding, channels: {} } });
  const custom = await f.module.queryRules({ preset: "custom", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(custom.results[0].calculation.profitUsd, 1.5, " untouched v3同epoch短区间仍保留原账语义");
  assert.equal(custom.commonSummary, null); assert.equal(custom.windowGroups[0].totals.confirmedProfitUsd, null);
});

test("U05最新已结束窗口等待账单：zero/失败均保留该日，真实retry action不拿旧成功日替换", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.queryRules({ preset: "custom", startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: Date.parse("2026-10-07T16:00:00Z") });
  for (const value of [0, null]) {
    f.state.upstreamQuota = value;
    const late = await f.module.queryRules({}, { force: true });
    assert.ok(late.results.every((row) => row.health.code === "WAITING_FOR_BILL" && row.calculation.profitUsd == null));
    for (const row of late.results) {
      assert.equal(row.window.preset, "yesterday"); assert.equal(row.window.startMs, Date.parse("2026-10-07T16:00:00Z"));
      assert.equal(row.downstream.amountUsd, 2.5);
      const action = row.actions.find((item) => item.kind === "retry_bill");
      assert.deepEqual(action.window, { startMs: row.window.startMs, endMs: row.window.endMs, timezone: row.window.timezone });
      assert.ok(action.href.includes(`startMs=${row.window.startMs}&endMs=${row.window.endMs}&timezone=Asia%2FShanghai`));
    }
    assert.equal(late.commonSummary?.totals.confirmedProfitUsd ?? null, null);
    assert.equal(late.coverage.accountedChannelCount, 0);
  }
});

test("U05真实Provider+module DST23/25小时、未完首日保留完整请求与scope action", async (t) => {
  const f = await completedDayFixture(t);
  for (const row of f.rows) row.timezone = "America/New_York";
  for (const [now, start, end, hours] of [["2026-03-09T16:00:00Z", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23],
    ["2026-11-02T16:00:00Z", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25]]) {
    t.mock.method(Date, "now", () => Date.parse(now));
    for (const row of f.rows) row.billing_effective_from_ms = Date.parse(start);
    const actual = await f.module.queryRules({}, { force: true });
    const row = actual.results[0];
    assert.deepEqual([row.window.startMs, row.window.endMs], [Date.parse(start), Date.parse(end)]);
    assert.equal((row.window.endMs - row.window.startMs) / 3600000, hours);
    assert.equal(row.scope.firstQueryableAtMs, Date.parse(end));
    assert.equal(row.calculation.profitUsd, 1.5); assert.ok(actual.commonSummary);
    assert.ok(f.state.statCalls.slice(-6).every((call) => call.start === Math.ceil(row.window.startMs / 1000) && call.end === Math.ceil(row.window.endMs / 1000) - 1));
  }
  t.mock.method(Date, "now", () => Date.parse("2026-10-09T03:00:00Z"));
  for (const row of f.rows) Object.assign(row, { timezone: "Asia/Shanghai", billing_effective_from_ms: Date.parse("2026-10-09T16:00:00Z") });
  const before = await f.module.queryRules({}, { force: true });
  assert.ok(before.results.every((row) => row.calculation.profitUsd == null && row.window.startMs === Date.parse("2026-10-07T16:00:00Z") && row.downstream.amountUsd === 2.5));
  assert.equal(before.coverage.channels.find((channel) => channel.channelId === 1).status, "not_effective");
  assert.ok(before.results[0].actions.some((action) => action.kind === "wait_effective" && action.href === "/reconciliation?action=scope&ruleId=rr_live"));
});

test("U05真实withAuth GET/POST默认昨日、显式today参考、局部body与覆盖action完整透传", async (t) => {
  const f = await completedDayFixture(t);
  f.rt.store.auth = { isDefault: false };
  f.rt.sessions = { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 };
  const { registerHooks } = await import("node:module");
  globalThis.__u05DayRuntime = f.rt;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "next/server") return { url: "test:u05-day-next", shortCircuit: true };
    if (specifier.endsWith("/runtime.js")) return { url: "test:u05-day-runtime", shortCircuit: true };
    if (specifier.endsWith("/lib/api.js")) return { url: new URL(`${specifier}?u05-day-auth`, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === "test:u05-day-next") return { format: "module", shortCircuit: true, source: "export const NextResponse={json:(value,init)=>Response.json(value,init)};" };
    if (url === "test:u05-day-runtime") return { format: "module", shortCircuit: true, source: "export const getRuntime=async()=>globalThis.__u05DayRuntime;" };
    return next(url, context);
  } });
  try {
    const { GET } = await import("../app/api/reconciliation/route.js?u05-day");
    const { POST } = await import("../app/api/reconciliation/query/route.js?u05-day");
    const get = (suffix = "", authenticated = true) => GET(new Request(`http://localhost/api/reconciliation${suffix}`, { headers: authenticated ? { cookie: "rm_session=valid" } : {} }));
    assert.equal((await get("", false)).status, 401);
    for (const suffix of ["", "?preset=invalid"]) {
      const response = await get(suffix); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.results[0].window.preset, "yesterday");
      assert.deepEqual([body.coverage.knownChannelCount, body.coverage.accountedChannelCount], [10, 3]);
      assert.equal(body.windowGroups[0].totals.knownIncomeUsd, 7.5); assert.equal(body.actions[0].accountKey, null);
    }
    const today = await (await get("?preset=today")).json(); assert.equal(today.commonSummary, null);
    assert.equal(today.results[0].window.endMs, Date.now()); assert.equal(today.windowGroups[0].totals.confirmedProfitUsd, null);
    const response = await POST(new Request("http://localhost/api/reconciliation/query", { method: "POST", headers: { cookie: "rm_session=valid" }, body: JSON.stringify({ ruleIds: ["rr_live"] }) }));
    assert.equal(response.status, 200); const one = await response.json();
    assert.equal(one.results[0].window.preset, "yesterday"); assert.equal(one.results.length, 1);
    assert.deepEqual([one.coverage.knownChannelCount, one.coverage.accountedChannelCount], [10, 3]);
    assert.equal(one.windowGroups[0].totals.knownIncomeUsd, 2.5);
    assert.ok(one.actions.some((action) => action.kind === "connect_channels" && action.channelIds.includes(9)));
    assert.doesNotMatch(JSON.stringify(one), /Bearer|accessToken|apiKey|admin"|"pat"/);
  } finally { hooks.deregister(); delete globalThis.__u05DayRuntime; }
});

test("U05实际Provider返回窗口保留到公开row/segment/snapshot，不可用请求窗口覆盖并假确认", async (t) => {
  const f = await completedDayFixture(t);
  const { registerHooks } = await import("node:module");
  const providerUrl = new URL("../lib/providers.js?u05-original-window", import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/providers.js")) return { url: "test:u05-mismatched-provider", shortCircuit: true };
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === "test:u05-mismatched-provider") return { format: "module", shortCircuit: true, source: `
      import * as actual from ${JSON.stringify(providerUrl)};
      export * from ${JSON.stringify(providerUrl)};
      export async function queryKeyReconciliationStat(...args) {
        const result = await actual.queryKeyReconciliationStat(...args);
        return { ...result, window: { ...result.window, endMs: result.window.endMs - 1000 } };
      }` };
    return next(url, context);
  } });
  try {
    const { createReconciliationModule: moduleWithDifferentActualWindow } = await import("./reconciliation.js?u05-actual-window");
    const result = await moduleWithDifferentActualWindow(f.rt).queryRules();
    for (const row of result.results) {
      assert.equal(row.upstream.amountUsd, 1); assert.equal(row.downstream.amountUsd, 2.5);
      assert.equal(row.upstream.window.endMs, row.window.endMs - 1000);
      assert.equal(row.segments[0].upstream.window.endMs, row.window.endMs - 1000);
      assert.equal(row.billingTimezone.state, "unverified"); assert.equal(row.calculation.profitUsd, null);
      assert.ok(row.health.issues.some((issue) => issue.code === "BILLING_WINDOW_MISMATCH"));
    }
    assert.equal(result.commonSummary, null); assert.equal(result.coverage.accountedChannelCount, 0);
    assert.equal(result.windowGroups[0].totals.knownIncomeUsd, 7.5);
    assert.equal(result.windowGroups[0].totals.knownCostUsd, null, "实际另一个窗口的raw成本不能计入所请求共同窗口");
    assert.ok([...f.state.snapshots.values()].every((snapshot) => {
      const source = JSON.parse(snapshot.source);
      return source.recordType === "observation" && source.result.upstream.window.endMs === source.window.endMs - 1000;
    }));
  } finally { hooks.deregister(); }
});

test("U05公开metadata按canonical requested zone隔离缓存并透传真实Provider时区证据", async (t) => {
  const f = await completedDayFixture(t);
  const shanghai = await f.module.getUpstreamKeys("upstream", { timezone: "Asia/Shanghai" });
  const utc = await f.module.getUpstreamKeys("upstream", { timezone: "UTC" });
  const alias = await f.module.getUpstreamKeys("upstream", { timezone: "Etc/UTC" });
  assert.deepEqual(shanghai.billingTimezone, { state: "verified", timezone: "Asia/Shanghai" });
  assert.deepEqual(utc.billingTimezone, { state: "verified", timezone: "UTC" });
  assert.deepEqual(alias.billingTimezone, utc.billingTimezone);
  assert.equal(f.state.requests.filter((request) => request.path === "/api/token/").length, 2, "跨zone不能复用另一zone metadata，同canonicalzone仍可复用");
  assert.doesNotMatch(JSON.stringify(utc), /accessToken|apiKey|Bearer/);
});

test("U05 external/unknown全Key用途保留原始金额与实际coverage action，整日profit不可确认", async (t) => {
  const f = await completedDayFixture(t);
  f.rows[0].cost_coverage = "unknown";
  f.rows[0].source_binding.coverageDeclaration = { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] };
  f.rows[1].cost_coverage = "unknown";
  f.rows[1].source_binding.coverageDeclaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
  const actual = await f.module.queryRules();
  assert.deepEqual([actual.coverage.knownChannelCount, actual.coverage.accountedChannelCount], [10, 1]);
  for (const row of actual.results.filter((item) => item.rule.id !== "rr_three")) {
    assert.equal(row.calculation.profitUsd, null); assert.equal(row.upstream.amountUsd, 1); assert.equal(row.downstream.amountUsd, 2.5);
    assert.ok(row.actions.some((action) => action.kind === "confirm_coverage" && action.href === `/stations?action=coverage&ruleId=${row.rule.id}`));
  }
  assert.equal(actual.windowGroups[0].totals.knownIncomeUsd, 7.5);
  assert.equal(actual.windowGroups[0].totals.confirmedProfitUsd, 1.5);
  assert.equal(actual.windowGroups[0].totals.profitComplete, false);
});
