import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationModule, mapWithConcurrency, reconciliationScopeFingerprint, resolveReconciliationWindow, normalizeReconciliationScopeIntent, ruleTimezoneFor } from "./reconciliation.js";
import { ReconciliationRepository, copySegment, reconciliationOwnerRuleState, reconciliationOwnerScope } from "./reconciliation-repository.js";
import { MemoryReconciliationRepository } from "./test-support/reconciliation-memory-repository.js";
import { reconciliationSnapshotIdentity, reconciliationConfirmedHistoryRecord } from "../lib/reconciliation-snapshot.js";
import { RECONCILIATION_LEDGER_COLUMNS } from "../lib/reconciliation-ledger.js";
import { SETTLE_LOOKBACK_MAX_PER_ROUND } from "../lib/reconciliation-settlement.js";
import { Store } from "../db/store.js";
import { canonicalBillingKey, nextBillingEffectiveFrom } from "../lib/reconciliation-scope-policy.js";
import { coverageNeedsAnswer, reconciliationCoverageText, reconciliationIssue } from "../lib/reconciliation-contract.js";
import { reconciliationNotCountedText } from "../lib/reconciliation-view.js";
import { serializeRuleSourceBinding } from "../lib/reconciliation-scope-policy.js";
import { createChannelOnboardingModule } from "./channel-onboarding.js";
import { createHash } from "node:crypto";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { createFakeSub2Api, secondsInDay } from "./test-support/fake-sub2api.js";
import { createFakeNewApi } from "./test-support/fake-newapi.js";
import { createChannelProfitModule } from "./channel-profit.js";
import { resetOwnRequestBudget } from "../lib/own-request-budget.js";
import { billingCapabilityAliases } from "../lib/billing-capability-storage.js";
import { maskKey } from "../lib/key-fingerprint.js";

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
          if (sql.includes("FROM reconciliation_rules") && (sql.includes("FOR UPDATE") || sql.includes("WHERE token_id = ?"))) return [working.rule.archived_at ? [] : [working.rule]];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
  store._metaSecrets.billing_identity_key = "source-fixture-billing-key"; // 生产启动由 Store.load 载入，fixture 直接构造。
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
  assert.equal(reconciliationSnapshotIdentity({ ...sevenDay, preset: "month", endMs: 4000 }, scope), "month:1000:Asia/Shanghai:same-scope");
});

test("近 7 天和本月的轮询在缓存有效期内复用上次结果", async () => {
  const rule = { id: "rr_live_cache", upstream_station_id: "missing", own_station_id: "own", token_id: 1, token_name: "key", fixed_group: "group", timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const segment = { id: "s1", rule_id: rule.id, group_name: "group", group_ratio: 1, effective_from_ms: 1, effective_to_ms: null, detected_at_ms: 1, timing_source: "operator_confirmed" };
  const query = async (sql) => {
    if (sql.includes("FROM reconciliation_rules")) return [[rule]];
    if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
    if (sql.includes("FROM reconciliation_rule_segments")) return [[segment]];
    if (sql.includes("FROM reconciliation_snapshots")) return [[]];
    if (sql.includes("FROM reconciliation_alert_state")) return [[{ active: 1, first_seen_at: 1, last_seen_at: 1, last_notified_at: 1 }]];
    return [{ affectedRows: 1 }];
  };
  const pool = { query, async getConnection() { return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} }; } };
  const rt = { pool, store: { list: () => [], get: () => null, channels: [] } };
  const reconciliation = createReconciliationModule(rt);
  for (const preset of ["7d", "month"]) {
    const input = { ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" };
    const first = await reconciliation.queryRules(input, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await reconciliation.queryRules(input);
    assert.equal(second.results[0].window.endMs, first.results[0].window.endMs, `${preset} 截止点后移不应让缓存失效`);
    assert.equal([...rt._reconciliationResultCache.keys()].filter((key) => key.includes(`:${preset}:`)).length, 1);
  }
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
  // 确认账单只认已结束的完整自然日窗口。
  const window = { preset: "yesterday", startMs: Date.parse("2026-09-21T16:00:00.000Z"), endMs: Date.parse("2026-09-22T16:00:00.000Z"), timezone: "Asia/Shanghai" };
  const valid = {
    recordType: "confirmed", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "scope",
    window: { ...window }, resultGeneratedAt: "2026-09-23T09:00:00.000Z",
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
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
  const window = { preset: "yesterday", startMs: Date.parse("2026-09-21T16:00:00.000Z"), endMs: Date.parse("2026-09-22T16:00:00.000Z"), timezone: "Asia/Shanghai" };
  const calls = [];
  const source = {
    recordType: "confirmed", calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "current-scope",
    window: { ...window }, resultGeneratedAt: "2026-09-23T10:00:00.000Z",
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
    if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
      throw new Error(`unexpected query: ${sql}`);
    };
    const repository = new ReconciliationRepository({ query, async getConnection() { return { query,
      async beginTransaction() {}, async commit() { calls.push("commit"); committed.push(...pending); },
      async rollback() { calls.push("rollback"); pending.length = 0; }, release() {},
    }; } });
    const original = await repository.getRule("rr");
    const expectedOwnerState = reconciliationOwnerScope([original], original.tokenId);
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
    if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
  // 自营站点 500 说「自营站点暂时读不到」，不说成上游繁忙；详细原因是脱敏后的原文
  assert.match(configuration.channelsError, /rejected/);
  assert.equal(configuration.channelsErrorCode, "OWN_STATION_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(configuration), /sk-sensitive-value|test-token/);
  assert.equal(logged.length, 1, "失败原因要留在服务端日志里便于排查");
  assert.match(logged[0], /本站渠道目录读取失败:.*rejected/);
  assert.doesNotMatch(logged[0], /sk-sensitive-value|test-token/);
});

test("渠道目录连不上时，详细原因和 code 说的是同一件事", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  t.mock.method(console, "error", () => {});
  const own = { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test-token" };
  const reconciliation = createReconciliationModule({
    pool: { async query() { return [[]]; } },
    store: { list: () => [own], get: () => own },
  });

  const configuration = await reconciliation.getConfiguration();
  // 读不到的是自营站点的渠道：连不上说「自营站点暂时读不到」（lib/error-copy.js ownStationErrorCode），详细原因是原文
  assert.equal(configuration.channelsErrorCode, "OWN_STATION_UNAVAILABLE");
  assert.equal(configuration.channelsError, "fetch failed");
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
  await assert.rejects(() => module.archiveRule("rr_missing"), { code: "RULE_NOT_FOUND" });
  await assert.rejects(() => module.archiveRule("rr_release"), { code: "RULE_NOT_FOUND" });
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
          throw new Error(`unexpected transaction query: ${sql}`);
        },
        async commit() { calls.push("commit"); },
        async rollback() { calls.push("rollback"); },
        release() { calls.push("release"); },
      };
    },
  };
  const module = createReconciliationModule({ pool, store: { list: () => [], get: () => null } });

  await assert.rejects(() => module.archiveRule("rr_race"), { code: "RULE_NOT_FOUND" });
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
  for (const preset of ["today", "yesterday", "7d", "month"]) {
    assert.ok(resolveReconciliationWindow({ preset, timezone: "Asia/Shanghai" }, now).endMs <= now, preset);
  }
  assert.equal(resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, now).endMs, now);
  assert.throws(() => resolveReconciliationWindow({ preset: "custom", timezone: "Asia/Shanghai", startMs: now - 1, endMs: now + 1 }, now), { code: "TIME_RANGE_FUTURE" });
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

test("本月从时区当地 1 日零点到当前时刻，跨夏令时多一小时也不受 31 天上限限制", () => {
  const now = Date.parse("2026-09-20T04:26:08.000Z"); // 上海 9 月 20 日 12:26:08
  assert.deepEqual(resolveReconciliationWindow({ preset: "month", timezone: "Asia/Shanghai" }, now),
    { preset: "month", timezone: "Asia/Shanghai", startMs: Date.parse("2026-08-31T16:00:00.000Z"), endMs: now });
  // 当地 1 日凌晨，UTC 还在上个月
  const firstDay = Date.parse("2026-09-30T17:00:00.000Z"); // 上海 10 月 1 日 01:00
  assert.equal(resolveReconciliationWindow({ preset: "month", timezone: "Asia/Shanghai" }, firstDay).startMs, Date.parse("2026-09-30T16:00:00.000Z"));
  // 柏林 10 月有 31 天又 1 小时（10 月 25 日退出夏令时），月末最后一小时窗口超过 31 天
  const lastHour = Date.parse("2026-10-31T22:30:00.000Z"); // 柏林 10 月 31 日 23:30 CET
  const month = resolveReconciliationWindow({ preset: "month", timezone: "Europe/Berlin" }, lastHour);
  assert.equal(month.startMs, Date.parse("2026-09-30T22:00:00.000Z"));
  assert.equal(month.endMs, lastHour);
  assert.ok(month.endMs - month.startMs > 31 * 86400000);
  assert.throws(() => resolveReconciliationWindow({ preset: "custom", timezone: "Europe/Berlin", startMs: month.startMs, endMs: month.endMs }, lastHour), { code: "TIME_RANGE_TOO_LONG" });
  assert.equal(resolveReconciliationWindow({ preset: "bogus", timezone: "Asia/Shanghai" }, now).preset, "yesterday");
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
    { code: "RULE_IDENTITY_IMMUTABLE" }
  );
  assert.equal(queries, 2);
});

test("旧编辑缺少金融proof时拒绝渠道变化；时区建好以后不能改，没传时区沿用原值；原Key展示与分组无写入", async (t) => {
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
    token_name: "stable-key", fixed_group: "old-group", timezone: "UTC", enabled: 1, archived_at: null,
  };
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT * FROM reconciliation_rules WHERE id")) return [[row]];
      if (sql.includes("FROM reconciliation_rule_channels")) return [[]];
      if (sql.includes("JOIN reconciliation_rule_channels")) return [[]];
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
          throw new Error(`unexpected transaction query: ${sql}`);
        },
      };
    },
  };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stations = [{ id: "upstream", type: "newapi", baseUrl, accessToken: "upstream-pat" }, { id: "own", type: "newapi", isOwn: true, baseUrl, accessToken: "admin" }];
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  // 改时区：先于任何读取就拒绝（C1，TIMEZONE_IMMUTABLE）；别名算同一个时区，不拒
  await assert.rejects(module.updateRule(row.id, { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [2], timezone: "America/New_York" }),
    (error) => error.code === "TIMEZONE_IMMUTABLE");
  assert.deepEqual(paths, []);
  await assert.rejects(module.updateRule(row.id, { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [2], timezone: "Etc/UTC" }),
    (error) => error.code === "PREVIEW_REQUIRED");
  paths.length = 0;
  // 没传时区：沿用原值 UTC（原来会被改成上海、当成改了范围），只有渠道变了，照旧要预览
  await assert.rejects(module.updateRule(row.id, { upstreamStationId: "upstream", tokenId: 9, salesChannelIds: [2] }),
    (error) => error.code === "PREVIEW_REQUIRED");

  assert.equal(paths.filter((path) => path === "/api/user/self").length, 2);
  assert.equal(paths.filter((path) => path === "/api/channel/").length, 2);
  assert.equal(paths.some((path) => path === "/api/token/" || path === "/api/user/self/groups"), false);
  assert.equal(row.token_name, "stable-key");
  assert.equal(row.fixed_group, "old-group");
  assert.equal(row.timezone, "UTC");
});

test("C1 绑定的时区：新建没传用业务时区，建好以后不能改——没传沿用原值，别名算同一个，传了别的报 TIMEZONE_IMMUTABLE", (t) => {
  const saved = process.env.BUSINESS_TIME_ZONE;
  t.after(() => { if (saved == null) delete process.env.BUSINESS_TIME_ZONE; else process.env.BUSINESS_TIME_ZONE = saved; });
  process.env.BUSINESS_TIME_ZONE = "America/Los_Angeles";
  assert.equal(ruleTimezoneFor(null, undefined), "America/Los_Angeles", "新建没传：业务时区，不是写死的上海");
  assert.equal(ruleTimezoneFor(null, ""), "America/Los_Angeles");
  assert.equal(ruleTimezoneFor(null, "UTC"), "UTC");
  assert.throws(() => ruleTimezoneFor(null, "Mars/Base"), (error) => error.code === "TIMEZONE_INVALID");
  const existing = { timezone: "Asia/Shanghai" };
  assert.equal(ruleTimezoneFor(existing, undefined), "Asia/Shanghai", "已有的没传：沿用原值，不按业务时区改");
  assert.equal(ruleTimezoneFor(existing, "PRC"), "Asia/Shanghai", "别名算同一个，存的还是原来的写法");
  assert.throws(() => ruleTimezoneFor(existing, "UTC"), (error) => error.code === "TIMEZONE_IMMUTABLE");
  assert.throws(() => ruleTimezoneFor(existing, "Mars/Base"), (error) => error.code === "TIMEZONE_INVALID");
  // 范围意图：新建没传按业务时区；已有的传了别的时区报 TIMEZONE_IMMUTABLE，不当成「时区不对」
  const input = { tokenId: 9, salesChannelIds: [2], coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } };
  assert.equal(normalizeReconciliationScopeIntent("append", null, input).normalizedAppendIntent.timezone, "America/Los_Angeles");
  assert.throws(() => normalizeReconciliationScopeIntent("replace", "rr_1", { ...input, upstreamStationId: "up", timezone: "UTC" }, existing),
    (error) => error.code === "TIMEZONE_IMMUTABLE");
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
    { code: "TIME_RANGE_FUTURE" }
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
        if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          ? { success: true, data: { total: 1, items: [{ id: 9, user_id: 42, name: "renamed-key", status: 1, group: "fixed", cross_group_retry: false }] } }
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
  assert.match(result.health.detail, /改名了/);
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
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, user_id: 1, name: "fixed-key", status: 1, group: "fixed", cross_group_retry: false }] } }
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
              { id: 9, user_id: 42, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
              { id: 10, user_id: 42, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
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
  assert.match(results[0].health.detail, /同名/);
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
            { id: 9, user_id: 1, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
            { id: 10, user_id: 1, name: "duplicate-key", status: 1, group: "fixed", cross_group_retry: false },
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
    else if (url.pathname === "/api/token/") body = { success: true, data: { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } };
    else if (url.pathname === "/api/log/self/stat") {
      statRequests.push({ tokenName: url.searchParams.get("token_name"), group: url.searchParams.get("group"), start, end: Number(url.searchParams.get("end_timestamp")) });
      body = upstreamBroken ? { success: false, message: "stat unavailable" } : { success: true, data: { quota: start === 1000 ? 0 : 100 } };
    }
    else if (url.pathname === "/api/user/") body = ownUsersApi(url);
    else if ((url.pathname === "/api/log/" || url.pathname === "/api/log/stat") && ownSourceRead(url)) body = ownTestLogApi(url);
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
  // 单个自然日的结账写进账本：事务里取最新一版再插入，读取时取同一天的最新一版。
  const ledgerRows = [];
  const ledgerTop = ([ruleId, billDate]) => ledgerRows.filter((row) => row.rule_id === ruleId && row.bill_date === billDate)
    .sort((a, b) => b.revision - a.revision).slice(0, 1);
  const ledgerQuery = (sql, params) => {
    if (sql.startsWith("INSERT INTO reconciliation_ledger")) {
      ledgerRows.push(Object.fromEntries(RECONCILIATION_LEDGER_COLUMNS.map((column, index) => [column, params[index]])));
      return [{ affectedRows: 1 }];
    }
    return [ledgerTop(params)];
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("reconciliation_settlement_state")) return sql.startsWith("SELECT") ? [[]] : [{ affectedRows: 0 }];
      if (sql.includes("FROM reconciliation_ledger")) return ledgerQuery(sql, params);
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
          if (sql.includes("reconciliation_settlement_state")) return [{ affectedRows: 0 }];
          if (sql.includes("reconciliation_ledger")) return ledgerQuery(sql, params);
          if (sql.includes("FROM reconciliation_rules") && (sql.includes("FOR UPDATE") || sql.includes("WHERE token_id = ?"))) return [[rule]];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
  // 只有已结束的完整日才保存确认账单，所以用"昨日"验证重启后保留确认时间、不跨日复用。
  const dayA = await module.queryRules({ ruleIds: [rule.id], preset: "yesterday" }, { force: true });
  const dayAmount = dayA.results[0].upstream.amountUsd;
  const daySuccessAt = dayA.results[0].lastSuccessfulAt;
  assert.ok(daySuccessAt, JSON.stringify(dayA.results[0].health));
  upstreamBroken = true;
  const restarted = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id), channels: [] } });
  const restartedResult = await restarted.queryRules({
    ruleIds: [rule.id], preset: "yesterday",
  }, { force: true });
  assert.equal(restartedResult.results[0].lastConfirmed.generatedAt, daySuccessAt, "重启后已结账的日子直接读结账记录，保留结账时间");
  assert.equal(restartedResult.results[0].settledAt, daySuccessAt);
  assert.equal(restartedResult.results[0].window.endMs, dayA.results[0].window.endMs, "a restarted process must retain the persisted data coverage window");
  assert.ok(restartedResult.results[0].requestedWindow.endMs >= restartedResult.results[0].window.endMs);
  now += 30000;
  const dayB = await module.queryRules({ ruleIds: [rule.id], preset: "yesterday" }, { force: true });
  assert.equal(dayB.results[0].upstream.amountUsd, dayAmount, "已结账的日子再刷新也不向上游重新取数");
  assert.equal(dayB.results[0].settledAt, daySuccessAt);
  // 重新结账（修正切换时间后）才重新取数；这次上游失败时保留上次结账。
  const resettled = await module.queryRules({ ruleIds: [rule.id], preset: "yesterday" }, { force: true, resettle: true });
  assert.equal(resettled.results[0].health.stale, false);
  assert.equal(resettled.results[0].upstream.amountUsd, null);
  assert.equal(resettled.results[0].lastConfirmed.upstream.amountUsd, dayAmount);
  assert.equal(resettled.results[0].lastConfirmed.generatedAt, daySuccessAt);
  assert.ok(resettled.results[0].requestedWindow.endMs >= resettled.results[0].window.endMs);
  assert.deepEqual(ledgerRows.map((row) => [row.revision, row.source]), [[1, "settle"]], "昨天只结一次账，重新结账失败不写新版本");
  now += 86400000;
  const nextDay = await module.queryRules({ ruleIds: [rule.id], preset: "yesterday" }, { force: true });
  assert.equal(nextDay.results[0].upstream.amountUsd, null, "a different local day must not reuse the previous day's confirmed result");
  assert.equal(nextDay.results[0].lastConfirmed, undefined);
  assert.equal(nextDay.results[0].health.stale, false);
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
    if (url.pathname === "/api/token/") return { success: true, data: { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } };
    if (url.pathname === "/api/log/self/stat") {
      statUsers.push(request.headers["new-api-user"]);
      return { success: true, data: { quota: 100 } };
    }
  });
  const ownServer = serve(ownCounts, (url) => {
    if (url.pathname === "/api/user/self") return { success: true, data: { id: 1 } };
    if (url.pathname === "/api/status") return ownStatusBroken ? { success: false, message: "status unavailable" } : { success: true, data: { quota_per_unit: 100 } };
    if (url.pathname === "/api/user/") return ownUsersApi(url);
    if ((url.pathname === "/api/log/" || url.pathname === "/api/log/stat") && ownSourceRead(url)) return ownTestLogApi(url);
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
  // 管理员自用（R1）：每段窗口读 3 个来源（管理员 root、两个渠道测试名字「模型测试」「Model test」）各一次列表，4 段共 12 次；用户列表（管理员名单）一轮共用一次。
  // 方案里「一段窗口一次，分段时每段各一次」
  assert.deepEqual(ownCounts, { "/api/user/self": 1, "/api/channel/": 1, "/api/status": 1, "/api/log/stat": 12, "/api/log/": 4, "/api/user/": 1, "/api/option/": 1 }, "本站身份和 /api/status 每轮只读一次，由各分段共用");

  for (const counts of [upstreamCounts, ownCounts]) for (const path of Object.keys(counts)) delete counts[path];
  ownStatusBroken = true;
  const { results: [broken] } = await module.queryRules(window, { force: true });
  assert.equal(ownCounts["/api/status"], 2, "本站 /api/status 失败时，等着它的几段共用一次重读，不按分段重试（4 段只多 1 次）");
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          : url.pathname === "/api/token/" ? { success: true, data: { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: 1, group: currentGroup, cross_group_retry: false }] } }
            : url.pathname === "/api/log/self/stat" ? { success: true, data: { quota: 100 } }
              : url.pathname === "/api/user/" ? ownUsersApi(url)
              : (url.pathname === "/api/log/" || url.pathname === "/api/log/stat") && ownSourceRead(url) ? ownTestLogApi(url)
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
          if (sql.includes("FROM reconciliation_rules") && (sql.includes("FOR UPDATE") || sql.includes("WHERE token_id = ?"))) return [[rule]];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("FROM reconciliation_rules") && (sql.includes("FOR UPDATE") || sql.includes("WHERE token_id = ?"))) return [[rule]];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("FROM reconciliation_rules") && (sql.includes("FOR UPDATE") || sql.includes("WHERE token_id = ?"))) return [[rule]];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("FROM reconciliation_rules") && (sql.includes("FOR UPDATE") || sql.includes("WHERE token_id = ?"))) return [[rule]];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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

// 真实取数路径的夹具：两侧 NewAPI 由 fetch 替身应答，数据库用内存 Repository。
// 每个分段上游消费 $1、本站渠道收费 $2.5，利润 $1.5。
// 已结束的上海完整自然日：只有这种窗口的利润会保存为确认账单。
const SETTLED_DAY = { startMs: Date.parse("2026-09-18T16:00:00.000Z"), endMs: Date.parse("2026-09-19T16:00:00.000Z") };

// 自营站点管理端日志（own-revenue-plan 第一节）：每日利润每个渠道的收入扣掉管理员自己花的钱，再兜底扣渠道测试（type 2、token_id 0、固定的 token_name）。
// 列表照 GetAllLogs：按 token_name 或 username 筛（MySQL 默认排序规则不分大小写，所以 model test 也会回来）、起止秒、created_at 与 id 倒序、
// page_size 上限 100，带 total；stat 是同样筛法的 quota 总和。logs 的每一项：{ id, channel, quota, created_at（秒）, token_name, username（默认 alice，不是管理员）, token_id（默认 0） }
const ownSourceRead = (url) => !!(url.searchParams.get("token_name") || url.searchParams.get("username"));
const OWN_USERS = [{ id: 1, username: "root", display_name: "Root", role: 100, status: 1 }, { id: 2, username: "alice", display_name: "", role: 1, status: 1 }];
// 用户列表：新版 data.items，p=0 当第一页；翻到空页为止
function ownUsersApi(url, users = OWN_USERS) {
  const page = Math.max(1, Number(url.searchParams.get("p") || 1)), size = Math.min(100, Number(url.searchParams.get("page_size") || 10));
  return { success: true, data: { total: users.length, items: users.slice((page - 1) * size, page * size) } };
}
function ownTestLogApi(url, logs = []) {
  const name = url.searchParams.get("token_name"), user = url.searchParams.get("username"), channel = url.searchParams.get("channel");
  const start = Number(url.searchParams.get("start_timestamp") || 0), end = Number(url.searchParams.get("end_timestamp") || 0) || Infinity;
  const matched = logs.map((log) => ({ username: "alice", ...log }))
    .filter((log) => (name == null || String(log.token_name).toLowerCase() === String(name).toLowerCase()) && (user == null || log.username === user) && (channel == null || String(log.channel) === channel) && log.created_at >= start && log.created_at <= end)
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  if (url.pathname === "/api/log/stat") return { success: true, data: { quota: matched.reduce((sum, log) => sum + log.quota, 0) } };
  const size = Math.min(100, Number(url.searchParams.get("page_size") || 10)), page = Math.max(1, Number(url.searchParams.get("p") || 1));
  const items = matched.slice((page - 1) * size, page * size).map((log) => ({ type: 2, token_id: 0, ...log }));
  return { success: true, data: { total: matched.length, items } };
}

// 换 Key 的端到端两种规则都跑：immediate（生产的绑定，按 Key 整体取数）和 legacy-v3（旧版，按段取）
const POLICIES = ["immediate", "legacy"];

function liveReconciliationFixture(t, { segments: specs, extraRuleIds = [], duplicateKeys = false, failSnapshotForRule = null, onRequest = null, metadataGroups = null, metadataFailure = false, failLatestLookup = false, ownChannels = null, channelsByRule = {}, channelObservedAt = null, onSnapshotInsert = null, onRepositoryConnection = null, onRepositoryCommit = null, moduleOptions = {}, keyAgent = null, tokenKeyOf = null, extraTokens = [], revealScopeDenied = false, policy = "legacy", usageOf = null, sub2api = null, extraStations = [], extraHosts = {} }) {
  const ratios = { g1: 1, g2: 2 };
  const segments = specs.map(({ id, group, from, to = null, ratio = ratios[group] }) => ({
    id, rule_id: "rr_live", group_name: group, group_ratio: ratio,
    ratio_observed_at_ms: from, ratio_source: "group_catalog",
    effective_from_ms: from, effective_to_ms: to, detected_at_ms: from, timing_source: "operator_confirmed",
  }));
  const open = segments.find((segment) => segment.effective_to_ms == null);
  const rule = { id: "rr_live", upstream_station_id: "upstream", own_station_id: "own", token_id: 9, token_name: "stable", fixed_group: open.group_name, timezone: "Asia/Shanghai", enabled: 1, archived_at: null };
  const rules = [rule, ...extraRuleIds.map((id, index) => ({ ...rule, id, token_id: duplicateKeys ? 9 : 10 + index, token_name: duplicateKeys ? "stable" : `stable-${id}` }))];
  // policy: "immediate" 是生产的绑定（按 Key 整体取数，scoped）；默认 legacy（旧版，按段取）。换 Key 的用例两种都要跑
  if (policy === "immediate") for (const item of rules) {
    const effective = Date.parse("2026-10-01T00:00:00Z");
    Object.assign(item, { billing_policy: "immediate", scope_version: 1, billing_effective_from_ms: effective, created_at: new Date(effective), cost_coverage: "complete", source_binding: { 1: "r1" } });
  }
  const allSegments = [...segments, ...extraRuleIds.flatMap((ruleId) => segments.map((segment) => ({ ...segment, id: `${segment.id}-${ruleId}`, rule_id: ruleId })) )];
  const channels = rules.flatMap((item) => (channelsByRule[item.id] || [1]).map((channelId) => ({
    rule_id: item.id, channel_id: channelId, channel_name: channelsByRule[item.id] ? `渠道 ${channelId}` : "渠道",
    active_channel_key: null, channel_status: null, status_observed_at_ms: channelObservedAt, status_changed_at_ms: null,
  })));
  const repository = new MemoryReconciliationRepository({ rules, channels, segments: allSegments, hooks: {
    beforeTransaction: () => onRepositoryConnection?.(),
    beforeRead: (name) => {
      if (failLatestLookup && name === "latestRecord") throw new Error("latest snapshot lookup failed");
    },
    beforeSnapshotWrite: (entry) => {
      if (failSnapshotForRule === entry.ruleId) throw new Error("snapshot insert rejected");
    },
    afterSnapshotWrite: (entry, tx) => tx && onSnapshotInsert?.({ ruleId: entry.ruleId, source: entry.source }),
    beforeCommit: (tx) => onRepositoryCommit?.(tx),
    // 返回的 segments 跟随主规则已提交的分段，切换出的新分段也会出现在里面。
    afterCommit: () => segments.splice(0, segments.length, ...repository.tables.segments.filter((segment) => segment.rule_id === rule.id)),
  } });
  const { log, tables } = repository;
  // 测试按快照键直接读写已提交的快照行；set 只是预置数据，不计入写入次数。
  const snapshots = {
    get: (key) => tables.snapshots.find((row) => row.snapshot_key === key),
    has: (key) => tables.snapshots.some((row) => row.snapshot_key === key),
    set(key, row) {
      const index = tables.snapshots.findIndex((item) => item.snapshot_key === key);
      const next = { ...row, snapshot_key: key };
      if (index >= 0) tables.snapshots[index] = next; else tables.snapshots.push(next);
      return snapshots;
    },
    keys: () => tables.snapshots.map((row) => row.snapshot_key).values(),
    values: () => tables.snapshots.slice().values(),
    get size() { return tables.snapshots.length; },
  };
  const state = {
    upstreamQuota: 100, ownQuota: 250, testLogs: [], ownUsers: OWN_USERS, statCalls: [], requests: [], snapshots,
    get writes() { return log.snapshotWrites.length; },
    get ledgerWrites() { return log.ledgerWrites; },
    // 已提交的账本行，detail 解析成对象。
    get ledger() { return tables.ledger.map((row) => ({ ...row, detail: JSON.parse(row.detail) })); },
    get alertQueries() { return log.alertCalls.length; },
    get ratioWrites() { return log.ratioWrites.map((entry) => entry.ratio); },
    get channelStateWrites() { return log.channelStateWrites.map((entry) => entry.state); },
    get channelStates() { return new Map(log.channelStateWrites.map((entry) => [entry.channelId, entry.state])); },
    get commits() { return log.commits; },
  };
  // 只给 Store 用；对账表一律走 repository，误用直接报错。
  const pool = {
    async query(sql) {
      if (/reconciliation_/.test(sql)) throw new Error(`对账表应经由 repository 访问：${sql}`);
      return [{ affectedRows: 1 }];
    },
    async getConnection() {
      return { query: pool.query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    },
  };
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const stat = (side, url, quota) => {
    state.statCalls.push({ side, start: Number(url.searchParams.get("start_timestamp")), end: Number(url.searchParams.get("end_timestamp")) });
    return quota == null ? reply(500, { success: false }) : reply(200, { success: true, data: { quota } });
  };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    const request = { host: url.host, path: url.pathname, authorization: init.headers?.Authorization ?? null, query: url.search, sourceRead: ownSourceRead(url) };
    state.requests.push(request);
    if (onRequest) await onRequest(request);
    const hosted = extraHosts[url.host]?.handle(url); // 第二个上游（换到另一个上游的 Key 的测试）：server/test-support/fake-newapi.js / fake-sub2api.js
    if (hosted) return hosted;
    if (url.pathname === "/api/status") return reply(200, { success: true, data: { quota_per_unit: 100, version: "v" } });
    // 自营站点的设置（R2）：默认记着收费记录；state.consumeLog 改成 "false" 就是关了，state.optionReply 整个换掉（没权限等）
    if (url.pathname === "/api/option/") return state.optionReply ? reply(...state.optionReply) : reply(200, { success: true, data: [{ key: "SMTPToken", value: "secret" }, { key: "LogConsumeEnabled", value: state.consumeLog ?? "true" }] });
    if (url.host === "upstream.test") {
      const sub2Hit = sub2api?.handle(url); if (sub2Hit) return sub2Hit; // 假 Sub2API 上游（server/test-support/fake-sub2api.js）
      if (url.pathname === "/api/user/self") return reply(200, { success: true, data: { id: 7 } });
      if (url.pathname === "/api/user/self/groups") return reply(200, { success: true, data: metadataGroups ? metadataGroups(request) : { g1: { ratio: 1 }, g2: { ratio: 2 } } });
      if (url.pathname === "/api/token/") {
        if (metadataFailure) return reply(500, { success: false });
        const distinct = [...new Map(rules.map((item) => [item.token_id, item])).values()];
        // 换 Key 的测试里仓库会把规则上的 token_id 原地改成新 Key（夹具的 rules 和仓库共用同一批对象），
        // 这时 extraTokens 里同一把已经在 distinct 里了，不能列两遍（目录里同一把出现两次，读取会报分页重复）
        const extra = extraTokens.filter((item) => !distinct.some((existing) => Number(existing.token_id) === Number(item.tokenId)))
          .map((item) => ({ token_id: item.tokenId, token_name: item.name }));
        return reply(200, { success: true, data: { total: distinct.length + extra.length, items: [...distinct, ...extra].map((item) => ({ id: item.token_id, user_id: init.headers?.["New-Api-User"], name: item.token_name, status: 1, group: rule.fixed_group, cross_group_retry: false,
          ...(tokenKeyOf ? { key: maskKey(tokenKeyOf(item.token_id)) } : {}) })) } });
      }
      // usageOf(token_name, 起秒, 止秒（含）) 给了就按 Key 名字、按时间段回用量（量钱对不对：每把 Key 的用量只能被算一次）；没给就一律 state.upstreamQuota
      if (url.pathname === "/api/log/self/stat") return stat("upstream", url, usageOf ? usageOf(url.searchParams.get("token_name"), Number(url.searchParams.get("start_timestamp")), Number(url.searchParams.get("end_timestamp"))) : state.upstreamQuota);
      // 取完整 Key（打码撞了才会问，K2a）：没有 api_key:reveal 权限
      if (url.pathname === "/api/token/batch/keys" && revealScopeDenied) return reply(403, { success: false, code: "ACCESS_TOKEN_SCOPE_DENIED", message: "The access token lacks the required permission: api_key:reveal" });
    }
    if (url.host === "own.test") {
      if (url.pathname === "/api/user/self") return reply(200, { success: true, data: { id: 1 } });
      if (url.pathname === "/api/channel/") {
        const items = ownChannels ? ownChannels(request) : [{ id: 1, name: "渠道", status: 1 }];
        return reply(200, { success: true, data: { total: items.length, items } });
      }
      // 渠道测试日志（R1）：带 token_name 的列表和 stat，不算渠道收费统计，不进 statCalls
      if ((url.pathname === "/api/log/" || url.pathname === "/api/log/stat") && ownSourceRead(url)) return reply(200, ownTestLogApi(url, state.testLogs));
      // 最新一条消费日志（轮询判断站点安不安静用，没有筛选条件）：只在 state.latestLogProbe 打开时给，别的测试照旧读不到
      if (state.latestLogProbe && url.pathname === "/api/log/" && !ownSourceRead(url)) return reply(200, ownTestLogApi(url, state.testLogs));
      // 整站消费日志（V1-a 的整站读，不带筛选）：只在 state.fullLogList 打开时给，别的测试照旧读不到（404）
      if (state.fullLogList && url.pathname === "/api/log/" && !ownSourceRead(url)) return reply(200, ownTestLogApi(url, state.testLogs));
      if (url.pathname === "/api/user/") return reply(200, ownUsersApi(url, state.ownUsers));
      if (url.pathname === "/api/log/stat") return stat("own", url, state.ownQuota);
      // 渠道 Key 读取服务（K2a/K2b）：只在传了 keyAgent 的测试里有这条路，别的测试这个站点没配，keyAgentConfigOf 直接判没配，不会问
      if (url.pathname === "/key-agent/keys" && keyAgent) {
        if (keyAgent.down) return { status: 503, headers: { get: () => null }, json: async () => ({}) }; // 读取服务读不到（例外三）
        const channels = typeof keyAgent.channels === "function" ? keyAgent.channels(request) : keyAgent.channels;
        // 和真读取服务一样：带 If-None-Match 且内容没变回 304（ETag 由渠道内容算，这里内容变了 etag 就变）
        const etag = `"ka-${JSON.stringify(channels).length}-${createHash("sha256").update(JSON.stringify(channels)).digest("hex").slice(0, 8)}"`;
        if (init.headers?.["If-None-Match"] === etag) return { status: 304, headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) }, json: async () => ({}) };
        return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
          json: async () => ({ v: 1, db: "mysql", readAt: Date.now() - (keyAgent.readLagMs ?? 0), channels }) };
      }
    }
    return reply(404, { success: false });
  });
  const stations = [
    { id: "upstream", name: "上游", type: "newapi", baseUrl: "https://upstream.test", accessToken: "pat", authVersion: 1 },
    { id: "own", name: "本站", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin", authVersion: 1,
      ...(keyAgent ? { keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: keyAgent.secret } : {}) },
    ...extraStations,
  ];
  const rt = { pool, store: { list: () => stations, get: (stationId) => stations.find((station) => station.id === stationId) || null,
    // 只覆盖本测试要用的字段（R2 的 consumeLogOffPeriods 由监控写回站点记录）
    update: async (stationId, patch) => Object.assign(stations.find((station) => station.id === stationId), patch),
    channels: [], billingIdentityKey: "reconciliation-fixture-billing-key",
    // 对应 Store 真正的 setKeyAgentLastSuccessAt：只往前挪不回退；夹具直接改这个站点对象的字段就够了
    // （真正的 Store 每次写会换一个新对象，但调用方总是在调用前先把旧值存进局部变量，这里简化成原地改不影响那段逻辑）
    async setKeyAgentLastSuccessAt(id, atMs) {
      const station = stations.find((item) => item.id === id);
      if (station && (station.keyAgentLastSuccessAtMs == null || atMs > station.keyAgentLastSuccessAtMs)) station.keyAgentLastSuccessAtMs = atMs;
    } } };
  // 整站日志读取（V1-a）默认关着：这个夹具的假站点没有不带筛选的 /api/log/；要测它的用例自己传 ownLogIngest: true 和内存桶
  if (policy === "immediate") rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  return { rule, state, segments, stations, rt, repository, module: createReconciliationModule(rt, { repository, ownLogStore: new MemoryOwnLogStore(), ownLogIngest: false, ...moduleOptions }) };
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

  for (const preset of ["today", "7d", "month"]) {
    state.statCalls.length = 0;
    const { results } = await module.queryRules({ ruleIds: [rule.id], preset, timezone: "Asia/Shanghai" }, { force: true });
    assert.equal(results[0].health.code, "PENDING", `${preset} 有未满一秒的分段时整窗仍待获取`);
    assert.equal(results[0].calculation.profitUsd, null);
    assert.deepEqual(results[0].segments.map((segment) => [segment.id, segment.health.code]), [["s1", "READY"], ["s2", "PENDING"], ["s3", "READY"]]);
    assert.equal(state.statCalls.length, 4, `${preset} 两侧只统计 s1 和 s3`);
  }
});

test("本月截至取数时刻：给实时毛利、只存 observation，同起点较晚截止的查询能读回较早记录", async (t) => {
  const { rule, repository, module, state } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000 }] });
  const realNow = Date.now;
  const now = Date.parse("2026-09-20T04:26:08.000Z");
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  const { results } = await module.queryRules({ ruleIds: [rule.id], preset: "month" }, { force: true });
  assert.deepEqual(results[0].window, { preset: "month", timezone: "Asia/Shanghai", startMs: Date.parse("2026-08-31T16:00:00.000Z"), endMs: now });
  assert.equal(results[0].health.code, "READY");
  // 本月没固定的天分两块读：过去的整天一块、今天一块（R1 多天修复）——自营一侧每个渠道 2 个 stat；夹具的 stat 不管窗口都回 250，钱不是真数，只断言块数和有毛利
  assert.ok(results[0].calculation.profitUsd != null);
  assert.equal(state.statCalls.filter((call) => call.side === "own").length, 2, "过去的整天、今天各一块");
  assert.equal(results[0].displayStatus.state, "live");
  assert.equal("settlement" in results[0], false, "旧字段 settlement 已删");
  const saved = repository.tables.snapshots.map((row) => [row.window_kind, JSON.parse(row.source).recordType]);
  assert.deepEqual(saved, [["month", "observation"]], "本月还没结束，不写结账记录");
  const fingerprint = JSON.parse(repository.tables.snapshots[0].source).scopeFingerprint;
  const later = await repository.latestObservation(rule.id, { ...results[0].window, endMs: now + 60000 }, fingerprint);
  assert.equal(later?.result.calculation.profitUsd, results[0].calculation.profitUsd);
});

test("两侧都已应答的上游空消费异常不能被旧的确认利润掩盖，数据源不可用时才回退", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000 }] });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", ...SETTLED_DAY };
  const confirmed = await module.queryRules(input, { force: true });
  assert.equal(confirmed.results[0].calculation.profitUsd, 1.5);
  assert.equal(state.writes, 1, "已结束完整日的完整结果记一份 observation");
  assert.deepEqual(state.ledgerWrites.map((entry) => [entry.revision, entry.source]), [[1, "settle"]], "结账写进账本");

  state.upstreamQuota = 0;
  const calls = state.statCalls.length;
  const settled = await module.queryRules(input, { force: true });
  assert.equal(settled.results[0].calculation.profitUsd, 1.5, "已结账的日子再刷新直接读结账记录");
  assert.equal(state.statCalls.length, calls);
  assert.equal(state.writes, 1);
  // 以下都是重新结账（修正切换时间后）的取数。
  const anomaly = await module.queryRules(input, { force: true, resettle: true });
  // 已结束完整日上游为 0 时首要状态是“等待该窗口账单”，空消费异常仍作为本轮 issue 保留。
  assert.equal(anomaly.results[0].health.code, "WAITING_FOR_BILL");
  assert.ok(anomaly.results[0].health.issues.some((issue) => issue.code === "UPSTREAM_EMPTY_WITH_SALES"));
  assert.equal(anomaly.results[0].health.stale, false, "两侧都已应答时展示本轮异常，不能回退到旧账单");
  assert.equal(anomaly.results[0].calculation.profitUsd, null);
  assert.equal(anomaly.results[0].calculation.riskDifferenceUsd, 2.5);
  assert.equal(state.writes, 2, "未确认异常追加 observation，不改写账本");
  assert.equal(state.ledgerWrites.length, 1);

  state.upstreamQuota = null;
  const unavailable = await module.queryRules(input, { force: true, resettle: true });
  assert.equal(unavailable.results[0].health.code, "WAITING_FOR_BILL");
  assert.ok(unavailable.results[0].health.issues.some((issue) => issue.code === "UPSTREAM_DATA_UNAVAILABLE"));
  assert.equal(unavailable.results[0].health.stale, false);
  assert.equal(unavailable.results[0].calculation.profitUsd, null);
  assert.equal(unavailable.results[0].lastConfirmed.calculation.profitUsd, 1.5);
  assert.equal(state.writes, 3);
  assert.equal(state.ledgerWrites.length, 1);
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
  stations[0].authVersion += 1;
  identityProbe.release();
  await assert.rejects(inFlight, (error) => error.code === "RESOURCE_CHANGED");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 2, "身份等待后已改授权，不能继续读取旧授权的 Key 目录");
  assert.equal(requestsTo("upstream.test", "/api/token/").at(-1).authorization, "Bearer pat-2");
  await module.getUpstreamKeys("upstream");
  assert.equal(requestsTo("upstream.test", "/api/token/").length, 3, "旧 PAT 读到的数据不能记到新 PAT 名下");

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
    ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", ...SETTLED_DAY,
  }, { force: true });
  assert.equal(results[0].calculation.profitUsd, 1.5);
  assert.equal(results[0].lastConfirmed, undefined);
  assert.equal(state.writes, 1, "参考读取失败不能跳过 observation");
  assert.equal(state.ledgerWrites.length, 1, "参考读取失败不能跳过结账");
});

test("同批规则中快照写入失败只返回该规则的 PERSISTENCE_FAILED", async (t) => {
  const { rule, state, module } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    extraRuleIds: ["rr_snapshot_fail"], channelsByRule: { rr_snapshot_fail: [2] }, failSnapshotForRule: "rr_snapshot_fail",
  });
  const { results } = await module.queryRules({
    ruleIds: [rule.id, "rr_snapshot_fail"], preset: "custom", timezone: "Asia/Shanghai", ...SETTLED_DAY,
  }, { force: true });
  assert.equal(results.length, 2);
  assert.equal(results[0].calculation.profitUsd, 1.5);
  assert.equal(results[1].health.code, "PERSISTENCE_FAILED");
  assert.equal(results[1].calculation.profitUsd, null);
  assert.equal(results[1].upstream.state, "unavailable");
  assert.equal(results[1].downstream.calculationVersion, 3);
  assert.equal(state.writes, 1, "正常规则仍须写 observation");
  assert.deepEqual(state.ledgerWrites.map((entry) => entry.ruleId), [rule.id], "正常规则仍须结账，失败的规则不写账本");
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
      if (sql.includes("SELECT * FROM reconciliation_rules") || sql.includes("SELECT id FROM reconciliation_rules WHERE token_id = ?")) return [[rule]];
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
  const { rule, state, rt, repository, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000 }] });
  const input = { ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", ...SETTLED_DAY };
  const initial = await module.queryRules(input, { force: true });
  assert.equal(initial.results[0].calculation.profitUsd, 1.5);
  const writes = state.writes;

  state.upstreamQuota = null;
  const restarted = createReconciliationModule({ pool: rt.pool, store: rt.store }, { repository });
  // 重启后已结账的日子直接读结账记录，不重新取数也不再结一次账。
  const settled = await restarted.queryRules(input, { force: true });
  assert.equal(settled.results[0].calculation.profitUsd, 1.5);
  assert.equal(settled.results[0].settledAt, initial.results[0].lastSuccessfulAt);
  assert.equal(state.writes, writes);

  // 重新结账时上游故障：保存本轮 observation，不覆盖已有结账。
  const { results } = await restarted.queryRules(input, { force: true, resettle: true });
  assert.equal(results[0].health.stale, false);
  assert.equal(results[0].upstream.amountUsd, null);
  assert.equal(results[0].downstream.amountUsd, 2.5);
  assert.equal(results[0].calculation.profitUsd, null);
  assert.equal(results[0].lastConfirmed.calculation.profitUsd, 1.5);
  assert.equal(state.writes, writes + 1, "上游故障保存本轮 observation 而不覆盖 confirmed");
});

test("持久化 today observation 可用于同日较晚窗口、不能跨本地日期复用；未结束 today 不作为确认账单", async () => {
  const first = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-20T04:26:08.000Z"));
  const source = { calculationVersion: 3, billingSource: "channel-log-stat", scopeFingerprint: "scope", window: first, resultGeneratedAt: "2026-09-20T04:26:08.000Z",
    result: { upstream: { amountUsd: 2.5 }, calculation: { differenceUsd: 2.5, profitUsd: 2.5, riskDifferenceUsd: null, marginRate: 0.5 } } };
  const rows = [
    { health_code: "READY", source: JSON.stringify({ ...source, recordType: "observation" }) },
    // 旧版本曾把未结束的 today 也写成 confirmed。
    { health_code: "READY", source: JSON.stringify({ ...source, recordType: "confirmed" }) },
  ];
  const repository = new ReconciliationRepository({
    async query() { return [rows]; },
  });
  const sameDay = { ...first, endMs: first.endMs + 30000 };
  assert.equal((await repository.latestObservation("rr", sameDay, "scope"))?.result.upstream.amountUsd, 2.5);
  assert.equal(await repository.latestSuccessfulResult("rr", sameDay, "scope"), null, "未结束的 today 不是确认账单");
  const nextDay = resolveReconciliationWindow({ preset: "today", timezone: "Asia/Shanghai" }, Date.parse("2026-09-21T04:26:08.000Z"));
  assert.equal(await repository.latestObservation("rr", nextDay, "scope"), null);
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
  const window = { preset: "custom", startMs: Date.parse("2026-09-20T16:00:00.000Z"), endMs: Date.parse("2026-09-21T16:00:00.000Z"), timezone: "Asia/Shanghai" };
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
      if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          if (sql.includes("INSERT INTO reconciliation_settlement_state")) return [{ affectedRows: 1 }]; // 改时间时写的重结请求（C2b）
          if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
  const observe = f.repository.observeSource;
  t.mock.method(f.repository, "observeSource", async function (...args) {
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
        : url.pathname === "/api/token/" ? { total: 1, items: [{ id: 9, user_id: 8, name: "stable", status: 1, group: "g2", cross_group_retry: false }] }
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
  const repository = f.repository;
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
  assert.match(result.health.detail, /请确认这条绑定的上游账号和自营站点/);
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
            : url.pathname === "/api/user/" ? ownUsersApi(url).data
              : (url.pathname === "/api/log/" || url.pathname === "/api/log/stat") && ownSourceRead(url) ? ownTestLogApi(url).data
              : url.pathname === "/api/log/stat" ? { quota: 500 } : null;
      return { status: data ? 200 : 404, text: async () => JSON.stringify({ success: !!data, data }) };
    }
    return oldFetch(input, init);
  });
  await store.update("own", { baseUrl: "https://own-b.test", accessToken: "source-b-pat" });
  await onboarding.sync();
  assert.notEqual(onboarding.getSourceCatalogue().ownSource.namespaceKey, sourceA.namespaceKey);
  // 已结账的日子不跟着换来源重算，仍是按 A 结的账。
  const settled = (await f.module.queryRules(input, { force: true })).results[0];
  assert.equal(settled.calculation.profitUsd, 1.5);
  assert.ok(settled.settledAt);
  assert.deepEqual([...f.state.snapshots.values()], snapshots);
  // 重新结账时按 B 取数，但 B 没有确认过来源绑定，不能确认。
  const changed = (await f.module.queryRules(input, { force: true, resettle: true })).results[0];
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
    channels: [{ rule_id: "rr_members", channel_id: 1, channel_name: "一" }], created: 0, ruleWrites: 0, rollbacks: 0, failChannels: false,
    capabilities: new Map() };
  let lockTail = Promise.resolve();
  const read = (sql, params = [], target = state) => {
    if (sql.includes("reconciliation_billing_capabilities")) {
      if (sql.startsWith("SELECT")) return [state.capabilities.has(params[0]) ? [{ capability: state.capabilities.get(params[0]) }] : []];
      if (sql.startsWith("INSERT")) { state.capabilities.set(params[0], params[1]); return [{ affectedRows: 1 }]; }
      if (sql.includes("WHERE identity")) for (const identity of Array.isArray(params[0]) ? params[0] : [params[0]]) state.capabilities.delete(identity);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("JOIN reconciliation_rule_channels")) return [target.channels.filter((channel) => params[0].includes(channel.channel_id)
      && channel.rule_id !== params[1]).map((channel) => ({ id: channel.rule_id, channel_id: channel.channel_id, token_name: "stable" }))];
    if (sql.includes("FROM reconciliation_rule_channels")) {
      const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
      return [target.channels.filter((channel) => ids.includes(channel.rule_id))];
    }
    if (sql.includes("FROM reconciliation_rules")) return [params.length ? target.rules.filter((rule) => rule.id === params[0]) : target.rules];
    if (sql.includes("MAX(s.effective_to_ms) AS held_until")) return [[{ held_until: null }]]; // 新绑定的下限：没有别的绑定握过这把 Key
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
        if (sql.startsWith("UPDATE reconciliation_rule_channels")) {
          const row = working.channels.find((channel) => channel.rule_id === params[2] && channel.channel_id === params[3]);
          if (row) { row.channel_name = params[0]; row.active_channel_key = params[1]; }
          return [{ affectedRows: row ? 1 : 0 }];
        }
        if (sql.startsWith("DELETE FROM reconciliation_rule_channels")) {
          const kept = sql.includes("NOT IN") ? params[1] : [];
          working.channels = working.channels.filter((channel) => channel.rule_id !== params[0] || kept.includes(channel.channel_id));
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
        if (sql.includes("reconciliation_segment_keys")) return [{ affectedRows: 0 }];
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
          : url.pathname === "/api/token/" ? { total: 1, items: [{ id: remote.tokenId, user_id: remote.accountId, name: "stable", status: 1, group: "g1", cross_group_retry: false }] }
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
  assert.equal(first.preview.billingEffectiveFromMs, null, "范围变化在确认时刻生效，预览不给生效时间");
  assert.equal(first.preview.firstQueryableAtMs, null);
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

test("U01行锁写入期间跨午夜不再拒绝，commit guard复核后按保存时刻立即生效", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = membershipFixture(), savedAt = now;
  f.state.onRuleWrite = () => { now += 2000; };
  const seen = [];
  const rule = await f.repository.appendChannels("rr_members", [{ channelId: 2, name: "two" }], { costCoverage: "complete" }, {
    guard(_existing, _channels, policy) { seen.push([policy.billingPolicy, policy.scopeVersion, policy.scopeChanged]); },
  });
  assert.deepEqual(seen, [["immediate", 2, true], ["immediate", 2, true]], "SQL前和commit前各复核一次");
  assert.equal(f.state.rollbacks, 0);
  assert.equal(f.state.rules[0].billing_effective_from_ms, savedAt);
  assert.equal(rule.billingEffectiveFrom, savedAt);
  assert.notEqual(rule.billingEffectiveFrom, nextBillingEffectiveFrom("Asia/Shanghai", savedAt), "不再推迟到下一个完整日");
  assert.equal(rule.scopeVersion, 2);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 2]);
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
  assert.equal(first.billingEffectiveFrom, Date.parse("2026-10-09T07:00:00Z"), "确认时刻即生效");
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

test("U02 genuine PUT SQL期间跨午夜仍一次提交，按保存时刻生效并精确替换成员", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t), { PUT } = await financialRuleRoutes();
  const body = { ...f.input, salesChannelIds: [2] }, proof = await f.rt.onboardingSource.probeRuleEdit("rr_members", body);
  const savedAt = now;
  f.state.onRuleWrite = () => { now += 2000; };
  const response = await PUT(new Request("https://app.test/rules/rr_members", { method: "PUT", body: JSON.stringify({ ...body,
    previewId: proof.previewId, groupId: proof.groupId }) }), f.rt, { id: "rr_members" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const { rule } = await response.json();
  assert.equal(rule.scopeVersion, 2);
  assert.equal(rule.billingEffectiveFrom, savedAt);
  assert.deepEqual(rule.channels.map((channel) => channel.channelId), [2]);
  assert.equal(f.state.ruleWrites, 1);
  assert.equal(f.state.rollbacks, 0);
  assert.equal(f.state.rules[0].scope_version, 2);
  assert.equal(f.state.rules[0].canonical_key, rule.canonicalKey);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [2]);
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
  assert.deepEqual(rule.channels.map((channel) => channel.channelId).sort((a, b) => a - b), [2, 3]);
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

test("U01真正public batch预览后跨午夜确认仍一次保存，按保存时刻生效无需重新预览", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t, { create: true }), proof = await financialProof(f, [1, 2, 3, 4, 5]);
  assert.equal(proof.probe.groups[0].preview.billingEffectiveFromMs, null);
  now += 2000;
  const result = await f.rt.onboardingSource.connectBatch({ ...proof.input, previewId: proof.probe.previewId });
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.groups[0].reconciliation.status, "configured");
  assert.equal(result.groups[0].saved.scopeVersion, 1);
  assert.equal(result.groups[0].saved.billingEffectiveFromMs, now, "生效时刻是保存时刻而非下一个完整日");
  assert.equal(f.state.rules[0].billing_effective_from_ms, now);
  assert.equal(f.persisted.links.length, 5);
  assert.equal(f.state.created, 1);
  assert.deepEqual(f.state.channels.map((channel) => channel.channel_id), [1, 2, 3, 4, 5]);
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

test("U01真public preview跨午夜后仍可确认并按保存时刻生效，已完成无proof重试保留日期", async (t) => {
  let now = Date.parse("2026-10-09T15:59:59Z");
  t.mock.method(Date, "now", () => now);
  const f = await financialFixture(t), proof = await financialProof(f);
  now += 2000;
  const saved = await f.module.appendChannels("rr_members", f.input.salesChannelIds, { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: proof.guard });
  assert.equal(saved.scopeVersion, 2);
  assert.equal(saved.billingEffectiveFrom, now);
  assert.deepEqual(saved.channels.map((channel) => channel.channelId).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
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

test("U01actual账号/ownnamespace改变推进scope版本并从确认时刻生效，旧history不被提前锚定", async (t) => {
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
  assert.equal(changed.billingEffectiveFrom, now);
  now += 86400000;
  f.remote.ownAccountId = 2; await f.rt.onboardingSource.sync();
  const namespace = await financialProof(f, [1, 2]);
  const moved = await f.module.appendChannels("rr_members", [1, 2], { coverageDeclaration: f.input.coverageDeclaration }, { previewGuard: namespace.guard });
  assert.equal(moved.scopeVersion, changed.scopeVersion + 1);
  assert.notEqual(moved.ownSource.namespaceKey, changed.ownSource.namespaceKey);
  assert.equal(moved.billingEffectiveFrom, now);
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
  assert.equal(first.billingEffectiveFrom, Date.parse("2026-10-09T07:00:00Z"), "确认时刻即生效");
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
          : url.pathname === "/api/token/" ? { total: 1, items: [{ id: 9, user_id: 42, name: "stable", status: 1, group: "g1", cross_group_retry: false }] }
            : { total: 1, items: [{ id: 2, name: "二", status: 1 }] };
    return { status: 200, text: async () => JSON.stringify({ success: true, data }) };
  });
  const module = createReconciliationModule({ pool, store: { list: () => stations, get: (id) => stations.find((station) => station.id === id) } });
  await assert.rejects(module.createRule({ upstreamStationId: "duplicate", tokenId: 9, salesChannelIds: [2], timezone: "Asia/Shanghai", costCoverage: "complete" }),
    (error) => error.code === "PREVIEW_REQUIRED");
  assert.deepEqual(state.channels.map((channel) => channel.channel_id), [1]);
  assert.equal(state.created, 0);
});

test("C3 用户 10-26：当天中途绑上，从那天 0 点整天算（上午的用量算进来），和 0 点就绑上的结果一样", async (t) => {
  const dayStart = Date.parse("2026-10-09T16:00:00Z"); // 上海 10-10 0:00
  const now = dayStart + 8 * 3600000; // 当天 8:00 起算的 8 小时后，16:00
  t.mock.method(Date, "now", () => now);
  const run = async (effective) => {
    const { rule, module, state, rt } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
    Object.assign(rule, { billing_policy: "immediate", scope_version: 1, billing_effective_from_ms: effective, created_at: new Date(effective), cost_coverage: "complete", source_binding: { 1: "r1" } });
    rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
    const result = (await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: dayStart, endMs: now }, { force: true })).results[0];
    return { result, calls: state.statCalls.map((call) => [call.side, call.start]) };
  };
  const midnight = await run(dayStart);
  const afternoon = await run(dayStart + 6 * 3600000 + 30 * 60000); // 14:30 才绑上
  assert.deepEqual(afternoon.calls, midnight.calls, "两边都从当天 0 点取（不从 14:30）");
  assert.ok(afternoon.calls.length > 0 && afternoon.calls.every(([, start]) => start === dayStart / 1000));
  assert.deepEqual([afternoon.result.upstream.amountUsd, afternoon.result.downstream.amountUsd, afternoon.result.calculation.profitUsd],
    [midnight.result.upstream.amountUsd, midnight.result.downstream.amountUsd, midnight.result.calculation.profitUsd], "上午的用量也算进来");
  assert.equal(afternoon.result.scope.accountedFromMs, null, "整天都在统计里，不再有「从 14:30 起」");
  assert.deepEqual(afternoon.result.segments[0].window, { ...afternoon.result.window, startMs: dayStart });
});

test("新范围从生效时刻起核算：生效前窗口不取数，跨界窗口只算生效后，未结束窗口给实时利润，只有完整日确认", async (t) => {
  const now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const effective = Date.parse("2026-10-09T16:00:00Z");
  const { rule, module, state, rt } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  Object.assign(rule, { billing_policy: "next-complete-day", scope_version: 2, billing_effective_from_ms: effective, cost_coverage: "complete", source_binding: { 1: "r1" } });
  rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const query = async (startMs, endMs) => (await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs, endMs }, { force: true })).results[0];
  const blockers = ["BILLING_SCOPE_NOT_EFFECTIVE", "BILLING_WINDOW_UNCONFIRMED"];
  // 多日窗口仍写确认快照，单个自然日写进账本。
  const confirmedCount = () => [...state.snapshots.values()].filter((snapshot) => JSON.parse(snapshot.source).recordType === "confirmed").length + state.ledgerWrites.length;
  let calls = state.statCalls.length;
  const before = await query(effective - 86400000, effective);
  assert.equal(state.statCalls.length, calls, "生效前窗口不向任何一侧取数");
  assert.deepEqual(before.segments, []);
  assert.equal(before.upstream.amountUsd, 0);
  assert.equal(before.downstream.amountUsd, 0);
  assert.equal(before.calculation.profitUsd, 0);
  assert.ok(!before.health.issues.some((issue) => blockers.includes(issue.code)));
  calls = state.statCalls.length;
  const crossing = await query(effective - 86400000, effective + 86400000);
  assert.equal(crossing.upstream.amountUsd, 1);
  assert.equal(crossing.downstream.amountUsd, 2.5);
  assert.equal(crossing.calculation.profitUsd, 1.5);
  assert.deepEqual(crossing.segments[0].window, { ...crossing.window, startMs: effective }, "只核算生效时刻之后的部分");
  assert.ok(state.statCalls.slice(calls).every((call) => call.start === effective / 1000), JSON.stringify(state.statCalls.slice(calls)));
  assert.equal(crossing.scope.accountedFromMs, effective);
  assert.equal(crossing.scope.recalculated, true);
  assert.equal(crossing.displayStatus.state, "settled");
  assert.ok(!crossing.health.issues.some((issue) => blockers.includes(issue.code)));
  const written = confirmedCount();
  const live = await query(effective + 86400000, now);
  assert.equal(live.upstream.amountUsd, 1);
  assert.equal(live.downstream.amountUsd, 2.5);
  assert.equal(live.calculation.profitUsd, 1.5, "未结束窗口给出实时利润");
  assert.equal(live.displayStatus.state, "live");
  assert.equal(live.scope.accountedFromMs, null);
  assert.ok(!live.health.issues.some((issue) => blockers.includes(issue.code)));
  assert.equal(confirmedCount(), written, "未结束窗口只保存 observation，不写确认账单");
  const confirmed = await query(effective, effective + 86400000);
  assert.equal(confirmed.calculation.profitUsd, 1.5);
  assert.equal(confirmed.scope.recalculated, false);
  assert.equal(confirmed.displayStatus.state, "settled");
  rule.cost_coverage = "unknown";
  assert.equal((await query(effective, effective + 86400000)).settledAt, confirmed.lastSuccessfulAt, "已结账的日子不跟着改覆盖范围重算");
  const unknown = (await module.queryRules({ ruleIds: [rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: effective, endMs: effective + 86400000 }, { force: true, resettle: true })).results[0];
  assert.equal(unknown.calculation.profitUsd, null);
  assert.equal(unknown.upstream.knownAmountUsd, 1);
  assert.ok(unknown.health.issues.some((issue) => issue.code === "COST_COVERAGE_UNKNOWN"));
  assert.equal(confirmedCount(), written + 1, "覆盖未知的结果不写确认账单");
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
});

// 同 Key 的另一条规则挂在本站第 2 个渠道：同一渠道不能同时归属两条启用规则，否则改规则会被渠道冲突拦下。
const overlapOnSecondChannel = { channelsByRule: { rr_overlap: [2] }, ownChannels: () => [{ id: 1, name: "渠道", status: 1 }, { id: 2, name: "渠道 2", status: 1 }] };

test("同 Key 规则停用再恢复后，普通查询不能复用另一规则的旧成本缓存", async (t) => {
  const { rule, module, rt } = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_overlap"], duplicateKeys: true, ...overlapOnSecondChannel,
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
    segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_overlap"], duplicateKeys: true, ...overlapOnSecondChannel,
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
  const rules = fixture.repository.tables.rules;
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
  assert.ok(results.every((result) => result.upstream.countedAmountUsd == null), "归属未核验时不计任何成本");
  assert.equal(results.reduce((sum, result) => sum + result.downstream.knownAmountUsd, 0), 5);
  for (const credential of ["Bearer account-seven", "Bearer candidate-seven", "Bearer admin"]) assert.equal(identityCalls.get(credential), 1);
  assert.ok([...f.state.snapshots.values()].every((snapshot) => JSON.parse(snapshot.source).recordType === "observation"));
  failCandidate = true;
  const single = (await f.module.queryRules({ ...input, ruleIds: ["rr_live"] })).results[0];
  assert.equal(single.upstream.ownershipState, "unknown", "只查一行仍核验未选中的参与owner");
  assert.equal(single.upstream.countedAmountUsd, null);
  const recovered = (await f.module.queryRules(input)).results;
  assert.equal(recovered.reduce((sum, result) => sum + (result.upstream.countedAmountUsd ?? 0), 0), 1);
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
    const rules = f.repository.tables.rules;
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
  const { rule, module, state, segments, stations, repository } = liveReconciliationFixture(t, {
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
        items: [{ id: 9, user_id: 8, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } }) };
    }
    return originalFetch(input, init);
  });
  const historyBefore = structuredClone(segments);
  const observed = t.mock.method(repository, "observeSource");
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

test("Sub2API Key/date核验后按业务时区确认整日利润，零值或缺实际扣费不确认", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  const { rule, state, rt, stations, module } = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "7", ratio: null, from: 0 }] });
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
  cost = null;
  const missing = (await module.queryRules(input, { force: true })).results[0];
  assert.equal(missing.upstream.knownAmountUsd, null);
  assert.equal(missing.downstream.knownAmountUsd, 2.5);
  assert.equal(missing.calculation.profitUsd, null);
  cost = 1;
  const complete = (await module.queryRules(input, { force: true })).results[0];
  assert.equal(complete.upstream.amountUsd, 1);
  assert.equal(complete.upstream.quotaPerUnit, null, "实际美元扣费不通过不存在的 quota 除数推算");
  assert.equal(complete.calculation.profitUsd, 1.5);
  assert.deepEqual(complete.billingTimezone, { state: "verified", timezone: "Asia/Shanghai" });
  assert.ok(!complete.health.issues.some((issue) => /BILLING_TIMEZONE/.test(issue.code)));
  // 确认记录即最终结果：之后上游再变，同一天直接读确认记录，不再取数也不再写库。
  const writes = state.writes;
  cost = null;
  const final = (await module.queryRules(input, { force: true })).results[0];
  assert.ok(complete.settledAt, "整日利润已结账");
  assert.deepEqual([final.calculation.profitUsd, final.settledAt], [1.5, complete.settledAt], "已确认的一天不被之后的缺字段结果覆盖");
  assert.equal(state.writes, writes);
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
          : url.pathname === "/api/token/" ? { total: 1, items: [{ id: 9, user_id: 42, name: "stable", status: 1, group: "g1", cross_group_retry: false }] }
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
  assert.equal(result.calculation.profitUsd, 0.5, "利润只按新授权的实际成本计算");
  assert.equal(result.billingTimezone.state, "verified");
  assert.equal(state.writes, 1, "只写新授权的 observation，旧扣费不得落库");
  assert.ok([...state.snapshots.values()].every((snapshot) => JSON.parse(snapshot.source).result.upstream.amountUsd === 2));
  assert.deepEqual(state.ledger.map((row) => [row.cost_usd, row.detail.result.upstream.amountUsd]), [[2, 2]], "账本只记新授权的扣费");
  assert.equal([...rt._reconciliationResultCache.values()][0].value.upstream.amountUsd, 2);
});

// Sub2API 上游（Key 9，按 start_date 给实际扣费）+ 本站 NewAPI 收入 2.5；control 计数能力核验发出的不存在 Key 请求。
function sub2ReconciliationFixture(t, { baseUrl, costs = {}, ...live }) {
  const f = liveReconciliationFixture(t, { ...live, segments: [{ id: "s1", group: "7", ratio: null, from: 0 }] });
  Object.assign(f.stations[0], { type: "sub2api", baseUrl, accessToken: "jwt" });
  Object.assign(f.rule, { billing_policy: "next-complete-day", scope_version: 1, billing_effective_from_ms: Date.parse("2026-10-09T16:00:00Z"),
    cost_coverage: "complete", source_binding: { 1: "r1" } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const host = new URL(baseUrl).host, ownFetch = globalThis.fetch;
  const sub2 = { costs, controls: 0, stats: [], missing: false, onRequest: null, accountId: 7 };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host !== host) return ownFetch(input, init);
    await sub2.onRequest?.(url);
    const reply = (status, data) => ({ status, text: async () => JSON.stringify({ code: status === 200 ? 0 : 1, data }) });
    if (url.pathname === "/api/v1/auth/me") return reply(200, { id: sub2.accountId });
    if (url.pathname === "/api/v1/keys") return reply(200, { total: 1, items: [{ id: 9, user_id: 7, name: "stable", status: "active", group_id: 7 }] });
    if (url.pathname.startsWith("/api/v1/keys/")) { sub2.controls += 1; return reply(404, {}); }
    sub2.stats.push(Object.fromEntries(url.searchParams));
    if (sub2.missing) return reply(200, { total_cost: 100 });
    const cost = url.searchParams.get("api_key_id") === "9" ? sub2.costs[url.searchParams.get("start_date")] ?? 0 : 0;
    return reply(200, { total_actual_cost: cost });
  });
  const sources = () => [...f.state.snapshots.values()].map((row) => JSON.parse(row.source));
  const restart = () => createReconciliationModule({ pool: f.rt.pool, store: f.rt.store, onboardingSource: f.rt.onboardingSource }, { repository: f.repository });
  return { ...f, sub2, sources, restart, today: { ruleIds: [f.rule.id], preset: "today", timezone: "Asia/Shanghai" } };
}

test("S3 Sub2API 账单能力：用 Store 密钥兼容旧 HMAC 的包装身份，零消费的日子不用重新核验也算完整账单", async (t) => {
  const now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-hmac-server.test", costs: {} });
  // 真的 Store：密钥从它的 getter 来，getter 改了名这里就会失败
  const conn = { beginTransaction: async () => {}, query: async () => [[]], commit: async () => {}, rollback: async () => {}, release: () => {} };
  const store = await new Store({ query: async (sql) => [sql.startsWith("SELECT k, v FROM meta") ? [{ k: "auth", v: { username: "admin", salt: "s", hash: "h" } }] : []],
    getConnection: async () => conn }).load();
  Object.defineProperty(f.rt.store, "billingIdentityKey", { get: () => store.billingIdentityKey });
  const digest = createHash("sha256").update(JSON.stringify(["https://sub2-hmac-server.test", "7", "Asia/Shanghai", "token", "jwt", null])).digest("hex");
  // 旧 S3 HMAC 行升级成 W(HMAC(K,D))，和新写的 W(D) 均能由适配器只读找到。
  const verifiedAt = now - 3 * 86400000;
  await f.repository.saveBillingCapability(billingCapabilityAliases(store.billingIdentityKey, digest)[1],
    { state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason: "RUNTIME_FILTERS_VERIFIED" });
  f.repository.log.capabilityWrites.length = 0;
  await f.module.refreshDue(now);
  assert.equal(f.sub2.controls, 0, "沿用改过身份的核验结果");
  assert.deepEqual(f.repository.log.capabilityWrites, []);
  // 零消费的昨天：没有能力就只是参考扣费（partial），要等有消费的那天重新核验；有能力就是完整的 0
  // 结账（settle）不写观测快照：看轮询算出的昨天（结果缓存里那份，页面只读查询直接拿到）
  const [yesterday] = (await f.module.queryRules({ preset: "yesterday" }, { mode: "evaluate", origin: "page" })).results;
  assert.deepEqual([yesterday.upstream.state, yesterday.upstream.amountUsd], ["complete", 0]);
  assert.equal(f.sub2.controls, 0, "页面只读查询也不重新核验");
});

test("1c Sub2API 今日实时毛利：页面查询只读不核验不写库，轮询核验能力并只结账昨天", async (t) => {
  const now = Date.parse("2026-10-11T01:00:00Z"); // 上海 10-11 09:00
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-live-today.test", costs: { "2026-10-11": 1, "2026-10-10": 2 } });
  const before = (await f.module.queryRules(f.today, { mode: "evaluate", origin: "page" })).results[0];
  assert.deepEqual([before.health.code, before.upstream, before.calculation.profitUsd], ["PENDING", null, null], "首次观测前页面只提示等待");
  assert.equal(f.sub2.controls, 0, "页面查询不发起能力核验"); assert.deepEqual(f.sub2.stats, []);
  assert.deepEqual(f.repository.log.capabilityWrites, []);
  assert.equal(f.state.writes, 0);

  await f.module.refreshDue(now);
  assert.deepEqual(f.repository.log.capabilityWrites.map((entry) => entry.method), ["saveBillingCapability"]);
  assert.deepEqual(f.sources().filter((source) => source.recordType === "confirmed"), [], "单个自然日结账写账本，不再写确认快照");
  assert.deepEqual(f.state.ledger.map((row) => [row.bill_date, row.window_start_ms, row.detail.result.calculation.profitUsd]),
    [["2026-10-10", Date.parse("2026-10-09T16:00:00Z"), 0.5]], "只结账昨天，今天的半天不进账本");
  assert.ok(f.sources().some((source) => source.recordType === "observation" && source.window.startMs === Date.parse("2026-10-10T16:00:00Z")));

  const writes = f.state.writes, controls = f.sub2.controls, ledgerWrites = f.state.ledgerWrites.length;
  const after = (await f.module.queryRules(f.today, { mode: "evaluate", origin: "page" })).results[0];
  assert.deepEqual([after.upstream.state, after.upstream.amountUsd, after.calculation.profitUsd], ["complete", 1, 1.5]);
  assert.deepEqual(after.billingTimezone, { state: "verified", timezone: "Asia/Shanghai" });
  assert.ok(!after.health.issues.some((issue) => /BILLING_TIMEZONE|WINDOW/.test(issue.code)));
  assert.equal(after.window.endMs, now, "今天截至当前时刻");
  assert.equal(f.sub2.controls, controls); assert.equal(f.state.writes, writes); assert.equal(f.state.ledgerWrites.length, ledgerWrites);

  // 存储清空后重启：页面查询只读，不借用进程缓存，也不顺手重新核验或补写能力。
  f.repository.tables.capabilities.splice(0);
  const capabilityWrites = f.repository.log.capabilityWrites.length;
  const cleared = (await f.restart().queryRules(f.today, { mode: "evaluate", origin: "page" })).results[0];
  assert.deepEqual([cleared.upstream.state, cleared.calculation.profitUsd], ["partial", null], "存储清空后不借用进程缓存");
  assert.equal(f.sub2.controls, controls, "页面查询不重新核验");
  assert.equal(f.repository.log.capabilityWrites.length, capabilityWrites, "页面查询不补写能力"); assert.equal(f.state.writes, writes);
});

test("1c Sub2API 能力核验结果落库：重启后页面沿用，存储清空后不借用进程缓存，满 7 天观测才重新核验", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-capability-restart.test", costs: { "2026-10-11": 1, "2026-10-17": 1, "2026-10-18": 1 } });
  await f.module.queryRules(f.today, { force: true });
  assert.equal(f.sub2.controls, 1); assert.equal(f.repository.tables.capabilities.length, 1);

  const page = (await f.restart().queryRules(f.today, { mode: "evaluate", origin: "page" })).results[0];
  assert.equal(page.calculation.profitUsd, 1.5, "重启后页面沿用已落库的核验结果");
  assert.equal(f.sub2.controls, 1);

  f.repository.tables.capabilities.splice(0);
  const cleared = (await f.restart().queryRules(f.today, { mode: "evaluate", origin: "page" })).results[0];
  assert.deepEqual([cleared.upstream.state, cleared.calculation.profitUsd], ["partial", null], "存储里没有核验结果时不借用进程内缓存");
  await f.restart().queryRules(f.today, { force: true });
  assert.equal(f.sub2.controls, 2, "观测重新核验");

  now += 6 * 86400000;
  await f.restart().queryRules(f.today, { force: true });
  assert.equal(f.sub2.controls, 2, "7 天内沿用");
  now += 86400000;
  assert.equal((await f.restart().queryRules(f.today, { mode: "evaluate", force: true, origin: "manual" })).results[0].calculation.profitUsd, 1.5,
    "到期的核验结果在页面上继续沿用");
  assert.equal(f.sub2.controls, 2, "页面查询到期也不核验");
  await f.restart().queryRules(f.today, { force: true });
  assert.equal(f.sub2.controls, 3, "满 7 天观测重新核验");
});

test("1c Sub2API 实际扣费字段消失：页面查询不删核验结果，观测才作废", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-capability-invalidate.test", costs: { "2026-10-11": 1 } });
  await f.module.queryRules(f.today, { force: true });
  assert.equal(f.repository.tables.capabilities.length, 1);
  f.sub2.missing = true;
  const page = (await f.module.queryRules(f.today, { mode: "evaluate", force: true, origin: "manual" })).results[0];
  assert.equal(page.calculation.profitUsd, null);
  assert.equal(f.repository.tables.capabilities.length, 1, "只读查询不改写能力存储");
  await f.module.queryRules(f.today, { force: true });
  assert.equal(f.repository.tables.capabilities.length, 0, "观测确认字段消失后作废核验结果");
  assert.deepEqual(f.repository.log.capabilityWrites.map((entry) => entry.method), ["saveBillingCapability", "deleteBillingCapability"]);
});

test("1c 轮询按规则实际取数时刻定今天的截止点，Sub2API 实时区间不因排队变旧", async (t) => {
  const start = Date.parse("2026-10-11T01:00:00Z");
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-poll-clock.test", costs: { "2026-10-11": 1 } });
  let advanced = false;
  f.sub2.onRequest = (url) => {
    if (!advanced && url.pathname === "/api/v1/keys") { advanced = true; now += 10 * 60000; }
  };
  await f.module.refreshDue(start);
  const observation = f.sources().find((source) => source.recordType === "observation" && source.window.startMs === Date.parse("2026-10-10T16:00:00Z"));
  assert.equal(observation.window.endMs, start + 10 * 60000);
  assert.equal(observation.result.upstream.amountUsd, 1);
  assert.ok(!observation.result.health.issues.some((issue) => issue.code === "UPSTREAM_WINDOW_UNSUPPORTED"));
});

test("1c 多规则查询按规则轮到时刻定今天的截止点，排在并发上限之后的 Sub2API 规则不因排队变旧", async (t) => {
  const start = Date.parse("2026-10-11T01:00:00Z");
  let now = start;
  t.mock.method(Date, "now", () => now);
  const extraRuleIds = ["rr_q1", "rr_q2", "rr_q3", "rr_q4", "rr_q5", "rr_q6"];
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-query-clock.test", costs: { "2026-10-11": 1 }, extraRuleIds,
    channelsByRule: Object.fromEntries(extraRuleIds.map((id, index) => [id, [index + 2]])) });
  // 主规则排到第 7 个：前 6 个占满并发，第一个开始处理时时钟走 10 分钟，主规则轮到时已超出实时区间允许的偏差。
  f.repository.tables.rules.push(f.repository.tables.rules.shift());
  const beforeRead = f.repository.hooks.beforeRead;
  let advanced = false;
  f.repository.hooks.beforeRead = (name, args) => {
    if (!advanced && name === "getRule" && extraRuleIds.includes(args[0])) { advanced = true; now += 10 * 60000; }
    return beforeRead(name, args);
  };
  const results = (await f.module.queryRules({ ...f.today, ruleIds: [f.rule.id, ...extraRuleIds] }, { force: true })).results;
  assert.ok(advanced);
  const result = results.find((item) => item.rule.id === f.rule.id);
  assert.equal(result.window.endMs, start + 10 * 60000, "主规则按轮到时刻截止");
  assert.deepEqual([result.upstream.state, result.upstream.amountUsd, result.calculation.profitUsd], ["complete", 1, 1.5]);
  assert.ok(!result.health.issues.some((issue) => issue.code === "UPSTREAM_WINDOW_UNSUPPORTED"));
});

test("1c 观测结果不让位给截止点更晚的只读结果：下一轮轮询命中观测缓存，不重复取数写库", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-cache-observed.test", costs: { "2026-10-11": 1 } });
  await f.module.queryRules(f.today, { force: true });
  now += 2 * 60000;
  const point = holdPoint();
  let held = false;
  f.sub2.onRequest = async (url) => {
    if (!held && url.pathname === "/api/v1/usage/stats") { held = true; await point.hold(); }
  };
  // 轮询取数挂起期间页面查询算出截止点更晚的只读结果，随后轮询才写回观测结果。
  const polling = f.module.queryRules(f.today, { force: true });
  await point.reached;
  now += 30000;
  const page = (await f.module.queryRules(f.today, { mode: "evaluate", origin: "page" })).results[0];
  assert.equal(page.window.endMs, now);
  point.release();
  const observed = (await polling).results[0];
  assert.equal(observed.window.endMs, now - 30000);
  assert.ok([...f.rt._reconciliationResultCache.values()].some((entry) => entry.observed && entry.value.window?.endMs === now - 30000), "缓存保留观测结果");
  const stats = f.sub2.stats.length, writes = f.state.writes;
  const next = (await f.module.queryRules(f.today)).results[0];
  assert.equal(next.calculation.profitUsd, 1.5);
  assert.equal(f.sub2.stats.length, stats, "下一轮轮询命中观测缓存，不重复取数"); assert.equal(f.state.writes, writes, "也不重复写库");
});

test("1c Sub2API 能力核验结果写入或作废后，Key 目录随即反映新的能力状态，不等 5 分钟缓存过期", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-metadata-capability.test", costs: { "2026-10-11": 1 } });
  const keys = async () => (await f.module.getUpstreamKeys("upstream", { timezone: "Asia/Shanghai" })).capability.state;
  assert.equal(await keys(), "unverified");
  await f.module.queryRules(f.today, { force: true });
  assert.equal(f.repository.tables.capabilities.length, 1);
  assert.equal(await keys(), "supported", "核验通过后目录不沿用缓存里的未核验");
  f.sub2.missing = true;
  await f.module.queryRules(f.today, { force: true });
  assert.equal(f.repository.tables.capabilities.length, 0);
  assert.equal(await keys(), "unverified", "作废后目录不沿用缓存里的已核验");
});

test("1c 某一侧取数失败时只提示取数失败，不提示去核验时区或能力", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-one-side-failure.test", costs: { "2026-10-11": 1 } });
  f.sub2.onRequest = (url) => {
    if (url.pathname === "/api/v1/usage/stats") throw new Error("socket hang up");
  };
  const result = (await f.module.queryRules(f.today, { force: true })).results[0];
  const codes = result.health.issues.map((issue) => issue.code);
  assert.ok(codes.includes("UPSTREAM_DATA_UNAVAILABLE"), codes.join());
  assert.ok(!codes.includes("BILLING_TIMEZONE_UNVERIFIED"), codes.join());
  assert.ok(!result.actions.some((action) => action.kind === "verify_capability"), "不引导去核验能力");
});

test("1c Sub2API 作废能力时存储删除失败：进程内记下作废，存储残留的旧能力不再算完整账单，下次观测重新核验", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-11T01:00:00Z"));
  t.mock.method(console, "warn", () => {});
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-capability-revoke.test", costs: { "2026-10-11": 1 } });
  await f.module.queryRules(f.today, { force: true });
  assert.deepEqual([f.sub2.controls, f.repository.tables.capabilities.length], [1, 1]);
  f.sub2.missing = true;
  f.repository.hooks.beforeCapabilityWrite = (method) => {
    if (method === "deleteBillingCapability") throw new Error("capability delete failed");
  };
  await f.module.queryRules(f.today, { force: true });
  assert.equal(f.repository.tables.capabilities.length, 1, "删除失败，存储里残留旧能力");
  // 字段恢复后页面只读查询：残留的旧能力已在进程内作废，只给参考扣费。
  f.sub2.missing = false;
  const page = (await f.module.queryRules(f.today, { mode: "evaluate", force: true, origin: "manual" })).results[0];
  assert.deepEqual([page.upstream.state, page.upstream.knownAmountUsd, page.calculation.profitUsd], ["partial", 1, null], "不借残留能力算完整账单");
  assert.equal(f.sub2.controls, 1, "页面查询不核验");
  f.repository.hooks.beforeCapabilityWrite = null;
  const polled = (await f.module.queryRules(f.today, { force: true })).results[0];
  assert.equal(f.sub2.controls, 2, "下次观测重新核验");
  assert.equal(polled.calculation.profitUsd, 1.5);
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
  // 账本行按 mysql2 读出的形状：日期由 DATE_FORMAT 给出字符串，DECIMAL 是字符串，detail 是 JSON 文本。
  const ledgerRow = ({ ruleId = "old-rule", billDate = "2026-10-08", revision = 1, start = startMs, end = endMs, detail = source,
    costBasis = "usage", entrySource = "settle", revenueRate = null, costRate = null } = {}) => ({
    rule_id: ruleId, bill_date: billDate, revision, version_id: null, timezone: "Asia/Shanghai", window_start_ms: start, window_end_ms: end,
    revenue_usd: String(detail?.result?.downstream?.amountUsd ?? 3), cost_usd: "2.00000000", revenue_rate: revenueRate == null ? null : String(revenueRate),
    cost_rate: costRate == null ? null : String(costRate), cost_basis: costBasis, source: entrySource, detail: JSON.stringify(detail),
    settled_at: "2026-10-08 16:01:00.000000" });
  const state = { rows: [ledgerRow()], queries: [], fail: false, rule: { id: "old-rule", upstream_station_id: "new-up", own_station_id: "new-own",
    token_id: 99, token_name: "new-name", timezone: "UTC", scope_version: 2, enabled: 0, archived_at: new Date("2026-10-09T00:00:00Z") } };
  const pool = { async getConnection() { assert.fail("history must not open a write transaction"); }, async query(sql, params = []) {
    state.queries.push({ sql, params });
    assert.ok(sql.startsWith("SELECT"), "history/configuration only read");
    if (state.fail) throw new Error("database failure raw-secret");
    if (sql.includes("FROM reconciliation_ledger")) {
      assert.match(sql, /revision = \(SELECT MAX\(revision\) FROM reconciliation_ledger m WHERE m\.rule_id = l\.rule_id AND m\.bill_date = l\.bill_date\)/);
      assert.match(sql, /ORDER BY bill_date DESC, rule_id DESC LIMIT \?/);
      const [ruleId, from, to] = params, after = params.length > 4 ? [params[3], params[5]] : null;
      const latest = (row) => !state.rows.some((other) => other.rule_id === row.rule_id && other.bill_date === row.bill_date && other.revision > row.revision);
      const rows = state.rows.filter((row) => row.rule_id === ruleId && row.window_start_ms >= from && row.window_end_ms <= to && latest(row)
        && (!after || row.bill_date < after[0] || (row.bill_date === after[0] && row.rule_id < after[1])))
        .sort((a, b) => b.bill_date.localeCompare(a.bill_date) || b.rule_id.localeCompare(a.rule_id));
      return [rows.slice(0, params.at(-1))];
    }
    if (sql.includes("FROM reconciliation_rule_channels")) return [[{ rule_id: "old-rule", channel_id: 2, channel_name: "new-two" }]];
    if (sql.includes("FROM reconciliation_rules")) return [[state.rule].filter((rule) => (!params.length || rule.id === params[0])
      && (!sql.includes("archived_at IS NULL") || !rule.archived_at))];
    assert.fail(`Unexpected history read: ${sql}`);
  } };
  const rt = { pool, store: { list: () => [], get: () => null, auth: { isDefault: false } },
    sessions: { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 } };
  return { state, rt, ledgerRow, source, window, module: createReconciliationModule(rt), repository: new ReconciliationRepository(pool) };
}

test("U05已归档规则历史读账本：保留原scope/source/window/members且白名单不泄漏raw，零上游零写", async (t) => {
  const f = confirmedHistoryFixture();
  t.mock.method(globalThis, "fetch", async () => { assert.fail("history must not query upstream"); });
  f.state.rows[0] = f.ledgerRow({ revenueRate: 7.1, costBasis: "fixed" });
  const result = await f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs });
  assert.equal(result.readOnly, true); assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.deepEqual(record.window, f.window); assert.equal(record.scopeVersion, 1);
  assert.equal(record.ownSource.accountId, "11"); assert.equal(record.upstreamSource.accountId, "7");
  assert.equal(record.upstreamSource.tokenId, 9); assert.equal(record.upstreamSource.tokenName, "old-name");
  assert.deepEqual(record.channels, [{ channelId: 1, name: "old-one" }]); assert.equal(record.sourceCompleteness, "complete");
  assert.doesNotMatch(JSON.stringify(result), /raw-secret|accessToken|password|apiKey|new-two|new-name|diagnostic/);
  assert.equal(record.calculation.profitUsd, 1); assert.equal(record.downstream.amountUsd, 3);
  assert.deepEqual([record.billDate, record.revision, record.settlementSource, record.confirmedAt, record.costBasis],
    ["2026-10-08", 1, "settle", "2026-10-08T16:01:00.000Z", "fixed"]);
  assert.deepEqual(record.settledRates, { income: 7.1, cost: null });
  assert.ok(f.state.queries.every(({ sql }) => !sql.includes("FOR UPDATE") && !sql.includes("reconciliation_snapshots")));
  f.state.fail = true;
  await assert.rejects(f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs }),
    (error) => error.code === "HISTORY_UNAVAILABLE" && !error.message.includes("raw-secret"));
});

test("U05账本历史每天只给最新一版，窗口以账本行为准，同一版historyId稳定、换版即变", async (t) => {
  const f = confirmedHistoryFixture();
  t.mock.method(globalThis, "fetch", async () => { assert.fail("history must not query upstream"); });
  // 原记录里的窗口和账本行不一致时以账本行为准（账本行是结账时按自然日写下的）。
  const drifted = { ...f.source, window: { ...f.window, startMs: f.window.startMs + 1000, timezone: "UTC" },
    result: { ...f.source.result, calculation: { profitUsd: 4 } } };
  f.state.rows = [f.ledgerRow(), f.ledgerRow({ revision: 2, entrySource: "resettle", detail: drifted })];
  const first = await f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs });
  assert.equal(first.records.length, 1);
  const [record] = first.records;
  assert.deepEqual([record.revision, record.settlementSource, record.calculation.profitUsd], [2, "resettle", 4]);
  assert.deepEqual(record.window, f.window); assert.deepEqual(record.upstream.window, f.window); assert.deepEqual(record.downstream.window, f.window);
  const again = await f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs });
  assert.equal(again.records[0].historyId, record.historyId);
  f.state.rows.push(f.ledgerRow({ revision: 3, entrySource: "resettle", detail: drifted }));
  const third = await f.module.getConfirmedHistory("old-rule", { startMs: f.window.startMs, endMs: f.window.endMs });
  assert.equal(third.records[0].revision, 3); assert.notEqual(third.records[0].historyId, record.historyId);
  assert.ok(f.state.queries.every(({ sql }) => sql.startsWith("SELECT")));
});

test("U05账本历史游标(日期,规则)与limit+1分页，0及负profit原样保留，迁移的旧账信息不全时标出", async () => {
  const f = confirmedHistoryFixture();
  const withProfit = (profitUsd) => ({ ...structuredClone(f.source), result: { ...structuredClone(f.source.result), calculation: { profitUsd } } });
  const previous = { start: f.window.startMs - 86400000, end: f.window.startMs };
  f.state.rows = [f.ledgerRow({ detail: withProfit(0) }), f.ledgerRow({ billDate: "2026-10-07", ...previous, detail: withProfit(-1) })];
  const options = { startMs: f.window.startMs - 86400000, endMs: f.window.endMs, limit: 1 };
  const page1 = await f.repository.listLedgerHistory("old-rule", options);
  assert.equal(page1.records[0].calculation.profitUsd, 0); assert.ok(page1.nextCursor);
  assert.deepEqual(JSON.parse(Buffer.from(page1.nextCursor, "base64url")), ["2026-10-08", "old-rule"]);
  const page2 = await f.repository.listLedgerHistory("old-rule", { ...options, cursor: page1.nextCursor });
  assert.equal(page2.records[0].calculation.profitUsd, -1); assert.equal(page2.records[0].billDate, "2026-10-07"); assert.equal(page2.nextCursor, null);
  assert.notEqual(page1.records[0].historyId, page2.records[0].historyId);
  assert.equal(f.state.queries[0].params.at(-1), 2);
  assert.deepEqual(f.state.queries[1].params.slice(3, 6), ["2026-10-08", "2026-10-08", "old-rule"]);
  // 迁移的旧账：原来源没存全时照样列出，标成信息不完整，不拿当前配置去补。
  const legacy = { ...f.source, ruleEvidence: null, scopePolicy: null, scopeFingerprint: null };
  f.state.rows = [f.ledgerRow({ detail: legacy, costBasis: null, entrySource: "migrated" }), f.ledgerRow({ billDate: "2026-10-07", ...previous, detail: legacy, costBasis: null, entrySource: "migrated" })];
  const migrated = await f.module.getConfirmedHistory("old-rule", { ...options, limit: 20 });
  assert.equal(migrated.records.length, 2);
  assert.notEqual(migrated.records[0].historyId, migrated.records[1].historyId);
  assert.ok(migrated.records.every((record) => record.sourceCompleteness === "legacy_partial" && record.upstreamSource.accountId == null
    && record.settlementSource === "migrated" && record.costBasis === null && record.window.timezone === "Asia/Shanghai"));
  const a = reconciliationConfirmedHistoryRecord({ rule_id: "old-rule", snapshot_key: "a", window_kind: "yesterday", window_start_ms: f.window.startMs,
    window_end_ms: f.window.endMs, generated_at: new Date("2026-10-08T16:01:01Z"), source: { ...f.source, window: null, ruleEvidence: null, scopeFingerprint: null, resultGeneratedAt: null } });
  assert.equal(a.sourceCompleteness, "legacy_partial"); assert.equal(a.window.timezone, null); assert.deepEqual(a.channels, [{ channelId: 1, name: "old-one" }]);
});

test("U05历史请求31日默认/最大与数量cap，非法参数在数据库读取前拒绝", async (t) => {
  const f = confirmedHistoryFixture(), now = Date.parse("2026-10-09T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  await f.module.getConfirmedHistory("old-rule");
  const query = f.state.queries.find(({ sql }) => sql.includes("FROM reconciliation_ledger"));
  assert.deepEqual(query.params, ["old-rule", now - 31 * 86400000, now, 21]);
  await f.module.getConfirmedHistory("old-rule", { limit: 100 }); assert.equal(f.state.queries.at(-1).params.at(-1), 51);
  for (const input of [{ startMs: now - 32 * 86400000, endMs: now }, { startMs: now, endMs: now }, { limit: 0 },
    { limit: 1.5 }, { cursor: "bad" }, { cursor: Buffer.from(JSON.stringify(["2026-02-31", "a"])).toString("base64url") },
    { cursor: Buffer.from(JSON.stringify([1, "2026-10-08 16:01:01", "old-bill-z"])).toString("base64url") }, { endMs: "" }]) {
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
  await f.module.queryRules({ ruleIds: [f.rule.id], preset: "custom", timezone: "Asia/Shanghai", ...SETTLED_DAY }, { force: true });
  // 单个自然日的结账存在账本行的 detail 里。
  const [row] = f.repository.tables.ledger;
  assert.ok(row);
  const evidence = JSON.parse(row.detail).ruleEvidence;
  assert.deepEqual(evidence.upstreamIdentity, { provider: "newapi", baseUrl: "https://upstream.test", accountId: "7" });
  assert.deepEqual(evidence.channels, [{ channelId: 1, name: "渠道" }]); assert.equal(evidence.tokenName, "stable");
  f.rule.token_name = "new-name"; f.rule.scope_version = 2; f.stations[0].baseUrl = "https://new-up.test";
  assert.deepEqual(JSON.parse(f.repository.tables.ledger[0].detail).ruleEvidence, evidence);
  const [history] = (await f.module.getConfirmedHistory(f.rule.id, { startMs: SETTLED_DAY.startMs, endMs: SETTLED_DAY.endMs })).records;
  assert.deepEqual([history.upstreamSource.tokenName, history.upstreamSource.baseUrl], ["stable", "https://upstream.test"], "历史账单按结账时的原账展示");
  assert.doesNotMatch(JSON.stringify(evidence), /accessToken|password|apiKey|admin|pat/);
});

// 回看更早的日子缺省不开（启动等待 1 天）：缺省的等待是随机 1–5 分钟，数每轮请求的测试会时有时无地多出回看的请求；要测回看的自己给 lookbackDelayMs
// 状态表里带重结请求的日子（改切换时间写进去的；重启也在）
const requestedDays = async (f, ruleId = "rr_live") => (await f.repository.listSettlementStates([ruleId])).filter((state) => state.resettleRequestedAt != null).map((state) => state.billDate);
async function completedDayFixture(t, { now = "2026-10-09T03:00:00Z", clock = null, channelsByRule = { rr_live: [1], rr_two: [2], rr_three: [3] }, moduleOptions = {}, ...options } = {}) {
  t.mock.method(Date, "now", clock || (() => Date.parse(now)));
  const channels = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `渠道 ${index + 1}`, status: 1, revision: `r${index + 1}` }));
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_two", "rr_three"],
    ownChannels: () => channels.filter((channel) => !channel.missing), channelsByRule, moduleOptions: { lookbackDelayMs: 24 * 3600000, ...moduleOptions }, ...options });
  const rows = f.repository.tables.rules;
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

// 自营站点的管理端日志列表替身（计划 P1a 判断有没有新的消费用），照 New API model/log.go GetAllLogs：
// 按 start_timestamp 筛，按「时刻倒序、再按编号倒序」排，带 total（起点以后一共几条）；clickhouse 时编号换成显示序号（第一条永远是 1）
function ownLogList(logs, calls = [], { clickhouse = false, testLogs = [] } = {}) {
  return (url) => {
    // 渠道测试日志（R1）按 token_name 读，不是 P1a 看全站有没有新消费的那次读，不记进 calls
    if (ownSourceRead(url)) return { status: 200, text: async () => JSON.stringify(ownTestLogApi(url, testLogs)) };
    const since = Number(url.searchParams.get("start_timestamp"));
    calls.push(since);
    const matched = logs.filter((log) => log.created_at >= since).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    const items = matched.slice(0, 1).map((log, index) => clickhouse ? { ...log, id: index + 1 } : log);
    return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: matched.length, items } }) };
  };
}

test("P1a 轮询省请求和写入：自营 /api/status 每轮一次；全站没有新的消费就沿用渠道收费；渠道状态、「今天」快照没变不写，满 10 分钟照写", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1, 4], rr_two: [2], rr_three: [3] } });
  const logs = [{ id: 1, created_at: Math.floor(now / 1000) - 60 }], siteCalls = [];
  const newLog = (created_at = Math.floor(now / 1000) - 1) => logs.push({ id: logs.length + 1, created_at });
  const siteLogs = ownLogList(logs, siteCalls);
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    return prev(input, init);
  });
  const ownCalls = (path) => f.state.requests.filter((request) => request.host === "own.test" && request.path === path && !request.sourceRead).length;
  const todayWrites = () => f.repository.log.snapshotWrites.filter((entry) => entry.source?.window?.preset === "today").length;
  const round = async () => {
    const before = { status: ownCalls("/api/status"), channel: ownCalls("/api/log/stat"), states: f.state.channelStateWrites.length, today: todayWrites(), site: siteCalls.length };
    await f.module.refreshDue(now);
    return { status: ownCalls("/api/status") - before.status, channel: ownCalls("/api/log/stat") - before.channel,
      states: f.state.channelStateWrites.length - before.states, today: todayWrites() - before.today, site: siteCalls.length - before.site };
  };

  // 第一轮：没有上一轮可比，照旧逐个渠道读（今天 4 个渠道 + 结昨天 4 个）；三条绑定共用一次 /api/status；记下最新一条日志
  assert.deepEqual(await round(), { status: 1, channel: 8, states: 4, today: 3, site: 2 });
  assert.deepEqual(siteCalls.slice(-2), [Math.floor(now / 1000) - 2 * 3600, logs[0].created_at - 120],
    "还没读到过日志：先从现在往前 2 小时数，最新一条离那个起点超过 10 分钟，马上按它往前 120 秒定起点再读一次");
  const first = (await f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" })).results.map((row) => row.downstream.amountUsd);

  // 一分钟后，全站这段时间没有新的消费：一个渠道请求都不发，沿用（沿用前照样读一次 /api/status，三条绑定共用）；渠道状态没变，不写。
  // 「今天」快照这一轮还会写一次：第一轮才写下渠道状态的变化时刻，快照里的渠道带上了它（内容真的变了）
  now += 60000;
  assert.deepEqual(await round(), { status: 1, channel: 0, states: 0, today: 3, site: 1 });
  assert.equal(siteCalls.at(-1), logs[0].created_at - 120, "起点不挪：还是最新一条（站点的时刻）往前 120 秒");
  const reused = (await f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" })).results;
  assert.ok(reused.every((row) => row.window.endMs === now && row.downstream.window.endMs === now), "沿用的收费，窗口终点换成这次的");
  assert.deepEqual(reused.map((row) => row.downstream.amountUsd), first);
  const fresh = (await f.module.queryRules({ preset: "today" }, { mode: "evaluate", force: true, origin: "manual" })).results;
  assert.deepEqual(fresh.map((row) => [row.downstream.amountUsd, row.calculation.profitUsd]), reused.map((row) => [row.downstream.amountUsd, row.calculation.profitUsd]),
    "和现读的一样");

  // 再一分钟，还是没有新的消费：什么都不读、不写
  now += 60000;
  assert.deepEqual(await round(), { status: 1, channel: 0, states: 0, today: 0, site: 1 });

  // 又过一分钟，有了新的消费：照旧逐个渠道读，金额变了，「今天」快照照写
  now += 60000; newLog(); f.state.ownQuota = 300;
  assert.deepEqual(await round(), { status: 1, channel: 4, states: 0, today: 3, site: 1 });

  // 再一分钟没有新的消费，但渠道 4 在自营站点里停用了：只写这一个渠道的状态（同一条绑定里的渠道 1 没变，不写）
  now += 60000;
  f.channels.find((channel) => channel.id === 4).status = 2;
  f.rt._reconciliationOwnChannelsCache.clear();
  assert.deepEqual(await round(), { status: 1, channel: 0, states: 1, today: 1, site: 1 });
  // 之后满 10 分钟，渠道状态的观测时刻和「今天」快照照写（不发渠道请求）
  now += 10 * 60000;
  assert.deepEqual(await round(), { status: 1, channel: 0, states: 4, today: 3, site: 1 });

  // 全站那一次读失败：这一轮照旧逐个读
  now += 60000;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/" && !ownSourceRead(url)) { siteCalls.push(null); return { status: 500, text: async () => "{}" }; }
    return prev(input, init);
  });
  assert.equal((await round()).channel, 4);
});

test("P1a 自营站点时钟偏慢 10 分钟、日志晚 60 多秒才写进去：起点以后的条数变了，照旧现读，一分钱不少算", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const sec = () => Math.floor(now / 1000);
  // 每条日志 100 额度（quota_per_unit 100，1 美元）；渠道的收费按日志现算
  // 站点的钟比控制台慢 10 分钟：站点记的时刻都是控制台的 10 分钟前。起点按站点的时刻定（最新那条往前 120 秒），
  // 落后 10 分钟以上才挪（挪的那一轮照常读）；这里的日志都离起点不远，不会挪
  const SLOW = 600;
  const logs = [1, 2, 3].map((channel, index) => ({ id: index + 1, channel, created_at: sec() - SLOW - 60, quota: 100 }));
  const add = (channel, created_at) => logs.push({ id: logs.length + 1, channel, created_at, quota: 100 });
  const siteLogs = ownLogList(logs);
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && ownSourceRead(url)) return { status: 200, text: async () => JSON.stringify(ownTestLogApi(url)) };
    if (url.host === "own.test" && url.pathname === "/api/log/stat") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      const channel = Number(url.searchParams.get("channel")), start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
      const quota = logs.filter((log) => log.channel === channel && log.created_at >= start && log.created_at <= end).reduce((sum, log) => sum + log.quota, 0);
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota } }) };
    }
    return prev(input, init);
  });
  const channelReads = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat" && !request.sourceRead).length;
  const round = async () => { now += 60000; const before = channelReads(); await f.module.refreshDue(now); return channelReads() - before; };
  const live = async () => (await f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] }, { mode: "evaluate", origin: "page" })).results[0].downstream.amountUsd;

  await round();
  assert.equal(await round(), 0, "没有新日志：沿用");
  assert.equal(await live(), 1);

  // 站点的钟慢 10 分钟：新日志记的时刻是控制台的 10 分钟前，不在控制台的「上一轮到现在」里，但起点以后的条数变了
  add(1, sec() - SLOW);
  assert.ok(await round() > 0, "照旧现读");
  assert.equal(await live(), 2, "慢了的那条也算进来");
  assert.equal(await round(), 0);

  // 日志晚 60 秒才写进去：记的时刻比已经读到的最新一条还早 60 秒，排不到第一，但起点以后的条数变了（起点往前留了 120 秒）
  add(1, Math.max(...logs.map((log) => log.created_at)) - 60);
  assert.ok(await round() > 0, "照旧现读");
  assert.equal(await live(), 3, "晚到的那条也算进来");
  assert.equal(await round(), 0);

  // 站点的钟忽然快了 10 分钟：新日志记的时刻在控制台的「现在」之后，这时窗口还包不住它；之后几轮编号、条数都不变，但不能沿用
  add(1, sec() + 600);
  assert.ok(await round() > 0);
  assert.ok(await round() > 0, "最新那条的时刻还没被读到的窗口包住，照旧现读");
  for (let i = 0; i < 9; i += 1) await round();
  assert.equal(await live(), 4, "控制台的钟走过那一刻以后算进来");
  assert.equal(await round(), 0, "包住以后接着沿用");
});

test("P1a 审核第二轮：晚 1 秒、ClickHouse 显示序号、钟慢加读失败后安静、起点挪动、老版本没有条数，都不少算", async (t) => {
  const setup = async (st, { clickhouse = false, slow = 0, noTotal = false } = {}) => {
    let now = Date.parse("2026-10-09T03:00:00Z");
    const f = await completedDayFixture(st, { clock: () => now });
    const sec = () => Math.floor(now / 1000) - slow;
    const logs = [1, 2, 3].map((channel, index) => ({ id: index + 1, channel, created_at: sec() - 60, quota: 100 }));
    const siteLogs = ownLogList(logs, [], { clickhouse });
    let failChannel = false;
    const prev = globalThis.fetch;
    st.mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "own.test" && url.pathname === "/api/log/") {
        const reply = siteLogs(url);
        if (!noTotal) return reply;
        const body = JSON.parse(await reply.text());
        return { status: 200, text: async () => JSON.stringify({ success: true, data: body.data.items }) };
      }
      if (url.host === "own.test" && url.pathname === "/api/log/stat" && ownSourceRead(url)) return { status: 200, text: async () => JSON.stringify(ownTestLogApi(url)) };
      if (url.host === "own.test" && url.pathname === "/api/log/stat") {
        f.state.requests.push({ host: url.host, path: url.pathname });
        if (failChannel) return { status: 500, text: async () => "{}" };
        const channel = Number(url.searchParams.get("channel")), start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
        const quota = logs.filter((log) => log.channel === channel && log.created_at >= start && log.created_at <= end).reduce((sum, log) => sum + log.quota, 0);
        return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota } }) };
      }
      return prev(input, init);
    });
    const reads = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat" && !request.sourceRead).length;
    return {
      f, logs, sec,
      add: (channel, created_at) => logs.push({ id: logs.length + 1, channel, created_at, quota: 100 }),
      failChannels: (value) => { failChannel = value; },
      round: async (ms = 60000) => { now += ms; const before = reads(); await f.module.refreshDue(now); return reads() - before; },
      live: async () => (await f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] }, { mode: "evaluate", origin: "page" })).results[0].downstream.amountUsd,
    };
  };

  await t.test("晚 1 秒：两条并发的请求跨秒，后写进去的那条时刻早 1 秒，排不到第一", async (st) => {
    const s = await setup(st);
    await s.round(); assert.equal(await s.round(), 0);
    const newest = Math.max(...s.logs.map((log) => log.created_at));
    s.add(2, s.sec()); s.add(1, s.sec() - 1);
    assert.ok(await s.round() > 0);
    assert.equal(await s.live(), 2, "晚 1 秒的那条算进来");
    assert.ok(newest < s.sec());
  });

  await t.test("ClickHouse 日志库：编号是显示序号（第一条永远是 1），站点的钟慢 10 分钟，每轮都有消费也照样现读", async (st) => {
    const s = await setup(st, { clickhouse: true, slow: 600 });
    await s.round(); assert.equal(await s.round(), 0);
    for (let i = 2; i <= 4; i += 1) {
      s.add(1, s.sec());
      assert.ok(await s.round() > 0, `第 ${i} 条`);
      assert.equal(await s.live(), i);
    }
  });

  await t.test("站点的钟慢 10 分钟、有消费那轮渠道读失败、接着安静：不能沿用读失败以前的那份", async (st) => {
    const s = await setup(st, { slow: 600 });
    await s.round(); assert.equal(await s.round(), 0);
    s.add(1, s.sec()); s.failChannels(true);
    await s.round();
    s.failChannels(false);
    assert.ok(await s.round() > 0, "安静了，但记下的那份早于这段安静的起点，照旧现读");
    assert.equal(await s.live(), 2);
    assert.equal(await s.round(), 0);
  });

  await t.test("起点落后最新一条 10 分钟以上才挪，挪的那一轮照常读，之后接着沿用", async (st) => {
    const s = await setup(st);
    await s.round(); assert.equal(await s.round(), 0);
    assert.equal(await s.round(11 * 60000), 0, "11 分钟没有新消费，一直沿用");
    s.add(1, s.sec());
    assert.ok(await s.round() > 0, "有新消费");
    assert.ok(await s.round() > 0, "最新一条离起点超过 10 分钟，起点挪了，这一轮照常读");
    assert.equal(await s.round(), 0, "之后接着沿用");
  });

  await t.test("起点挪的那一轮：起点以前的几条掉出去、同时补进来同样多条晚到的，条数和最新一条都没变，也照常读", async (st) => {
    const s = await setup(st);
    await s.round(); assert.equal(await s.round(), 0);
    assert.equal(await s.round(11 * 60000), 0);
    s.add(2, s.sec());
    assert.ok(await s.round() > 0, "有新消费");
    const newest = Math.max(...s.logs.map((log) => log.created_at));
    for (let i = 0; i < 3; i += 1) s.add(1, newest - 30); // 起点挪到 newest−120：开头 3 条掉出去、晚到 3 条补进来
    assert.ok(await s.round() > 0, "起点挪了，照常读");
    assert.equal(await s.live(), 4, "晚到的 3 条算进来");
  });

  await t.test("ClickHouse 同一轮删一条、加一条（时刻落在已读到的范围里）：编号永远是 1、条数不变，只有时刻变了，也照常读", async (st) => {
    const s = await setup(st, { clickhouse: true });
    await s.round(); assert.equal(await s.round(), 0);
    const newest = Math.max(...s.logs.map((log) => log.created_at));
    s.logs.splice(s.logs.findIndex((log) => log.channel === 3), 1);
    s.add(1, newest + 11);
    assert.ok(await s.round() > 0, "时刻变了，照常读");
    assert.equal(await s.live(), 2);
  });

  await t.test("老版本列表不给条数：不当成没有新的消费，每轮照常读", async (st) => {
    const s = await setup(st, { noTotal: true });
    await s.round();
    assert.ok(await s.round() > 0);
    assert.ok(await s.round() > 0);
  });
});

test("P1a 沿用渠道收费的边界：额度换算变了、读失败后进入安静期、换凭据、同一轮 /api/status 失败、跨零点、分段终点往前改，都照旧现读", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let ownQuotaPerUnit = 100, failChannelStat = false, failStatusOnce = false;
  const logs = [{ id: 1, created_at: Math.floor(now / 1000) - 600 }];
  const newLog = () => logs.push({ id: logs.length + 1, created_at: Math.floor(now / 1000) });
  const siteLogs = ownLogList(logs);
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && failChannelStat) {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 500, text: async () => "{}" };
    }
    if (url.host === "own.test" && url.pathname === "/api/status") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      if (failStatusOnce) {
        failStatusOnce = false;
        // 晚一点再失败：其余绑定这时都在等这同一次
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: 500, text: async () => "{}" };
      }
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota_per_unit: ownQuotaPerUnit, version: "v" } }) };
    }
    return prev(input, init);
  });
  const channelReads = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat" && !request.sourceRead).length;
  const round = async (ms = 60000) => { now += ms; const before = channelReads(); await f.module.refreshDue(now); return channelReads() - before; };
  const today = async () => (await f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" })).results;
  const amounts = async () => (await today()).map((row) => row.downstream.amountUsd);

  assert.equal(await round(0), 6, "第一轮：今天 3 个渠道、结昨天 3 个");
  assert.equal(await round(), 0, "没有新消费：沿用");
  assert.deepEqual(await amounts(), [2.5, 2.5, 2.5]);

  // 额度换算改了：不拿旧的换算算钱，照旧现读
  ownQuotaPerUnit = 200;
  assert.equal(await round(), 3);
  assert.deepEqual(await amounts(), [1.25, 1.25, 1.25]);
  assert.equal(await round(), 0, "按新换算记下以后接着沿用");

  // 有新消费、渠道读失败，接着进入安静期：失败那轮没记下，安静期里不能沿用更早的那份
  newLog(); failChannelStat = true;
  await round();
  failChannelStat = false;
  assert.equal(await round(), 3, "读失败之后的安静期照旧现读");
  assert.equal(await round(), 0);

  // 换了自营站点的凭据：照旧现读
  f.stations.find((station) => station.id === "own").accessToken = "admin-2";
  assert.equal(await round(), 3);
  assert.equal(await round(), 0);

  // 同一轮共用的 /api/status 那一次失败了：等着它的绑定自己再读一次，不跟着一起失败
  newLog(); failStatusOnce = true;
  await round();
  const failed = (await today()).filter((row) => row.downstream.amountUsd == null);
  assert.ok(failed.length <= 1, "最多发起那一条失败");
  await round();

  // 分段终点往前改到上一次读到的时刻之前：同一个起点的那份不能沿用（只有按分段取数的旧口径会切成几段）
  f.rows.find((row) => row.id === "rr_live").billing_policy = "legacy-v3";
  await round();
  assert.equal(await round(), 0, "旧口径一段时照样沿用");
  const segments = f.repository.tables.segments.filter((segment) => segment.rule_id === "rr_live");
  const cut = now - 30 * 60000;
  segments[0].effective_to_ms = cut;
  f.repository.tables.segments.push({ ...segments[0], id: "s1-late", effective_from_ms: cut, effective_to_ms: null, detected_at_ms: cut });
  assert.equal(await round(), 2, "rr_live 两段都现读：前一段终点早于上次读到的时刻，不能沿用");

  // 跨零点（上海 10-10 00:00 = 10-09 16:00Z），内容没变：窗口换了一天，照旧现读，「今天」快照照写
  const writes = () => f.repository.log.snapshotWrites.filter((entry) => entry.source?.window?.preset === "today").length;
  now = Date.parse("2026-10-09T15:58:30Z");
  assert.equal(await round(), 1, "零点前一分钟还在沿用（只有 rr_live 已经结束的前一段照旧现读）");
  const before = writes();
  assert.ok(await round() >= 3, "新的一天照旧现读");
  assert.ok(writes() - before >= 3, "新的一天的快照照写");

  // 清缓存（自营站点的身份或渠道目录变了）以后不沿用
  assert.equal(await round(), 0);
  f.module.invalidateSources();
  assert.equal(await round(), 3, "清缓存以后照旧现读");

  // 快照指纹一条绑定只留一份；停用的绑定下一轮清掉
  const fingerprints = () => [...f.rt._reconciliationObservationWrites.keys()].map((key) => key.slice(0, key.indexOf(":")));
  assert.deepEqual(fingerprints().sort(), ["rr_live", "rr_three", "rr_two"]);
  f.rows.find((row) => row.id === "rr_three").enabled = 0;
  await round();
  assert.deepEqual(fingerprints().sort(), ["rr_live", "rr_two"]);
});

// 减压 PR（用户 10-26 定插到最前面；总指挥 10-26 定：只做「没人看就放慢」，按渠道判安静不做，P1a 的探测和它的测试不动）：
// 没人看「今天」页面超过 10 分钟，所有渠道都放慢到 5 分钟一轮；有人看照旧每分钟；空闲后有人来立刻跑一轮；结账、页面直接来看都不受影响
test("减压 PR：没人看「今天」页面超过 10 分钟就放慢，有人看照旧每分钟；空闲后有人来立刻刷一轮；页面直接来看、结账都照旧现读", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now }); // 默认 rr_live:[1]、rr_two:[2]、rr_three:[3]，同一个自营站点
  const logs = [{ id: 1, created_at: Math.floor(now / 1000) - 60 }];
  const newLog = () => logs.push({ id: logs.length + 1, created_at: Math.floor(now / 1000) - 1 });
  const siteLogs = ownLogList(logs, []);
  const prev = globalThis.fetch;
  let quota2 = 100;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !ownSourceRead(url)) {
      f.state.requests.push({ host: url.host, path: url.pathname, query: url.search });
      const channel = Number(url.searchParams.get("channel"));
      const quota = channel === 2 ? quota2 : 100;
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota } }) };
    }
    return prev(input, init);
  });
  const statCallsFor = (channelId) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat"
    && new URLSearchParams(request.query).get("channel") === String(channelId)).length;
  const liveTwo = async () => (await f.module.queryRules({ preset: "today", ruleIds: ["rr_two"] }, { mode: "evaluate", origin: "page" })).results[0].downstream.amountUsd;
  // 每轮都让站点整体「不安静」（newLog），这样「没人看才放慢」才用得到——站点整体安静时，整站那道总闸直接把所有渠道都挡住，
  // 轮不到这里（审核报告里说的「整站探测当总闸」，P1a 的范围，这个 PR 不碰）
  const round = async (ms = 60000) => { now += ms; newLog(); const before = statCallsFor(2); await f.module.refreshDue(now); return statCallsFor(2) - before; };

  await liveTwo(); // 有人正在看：记一下这一刻
  assert.equal(await round(), 2, "有人看：照旧每分钟问；这一轮还要结昨天，渠道 2 多问一次");
  assert.equal(await round(), 1, "有人看：照旧每分钟问");

  // 没人看「今天」页面超过 10 分钟：所有渠道（不管本身有没有新消费，渠道 2 的 quota 其实一直没变）都放慢到 5 分钟一轮
  for (let i = 0; i < 11; i += 1) await round(); // 11 分钟没有页面来看，超过 OWN_VIEWER_IDLE_MS
  const idleReads = statCallsFor(2);
  quota2 = 200; // 这期间其实有新消费，但没人看，不该马上问
  assert.equal(await round(), 0, "没人看超过 10 分钟：不是每轮都问了");
  assert.equal(statCallsFor(2), idleReads, "这一轮真的没问（沿用），不是刚好问到了同样的数");
  // 页面这时直接来看（不是走后台轮询那条路）：不管后台这一轮是不是沿用的，页面自己现算一遍，看到的是真数，不是沿用的旧数
  assert.equal(await liveTwo(), 2, "页面直接来看：现读，看到新消费，不是沿用的旧数（减压 PR 的沿用结果不进页面能读到的缓存）");

  // 刚才那次页面来看，就是「有人回来了」：下一轮立刻恢复每分钟，不用再等 5 分钟
  assert.equal(await round(), 1, "空闲后有人来，下一轮立刻刷一轮，不等满 5 分钟的间隔");
  assert.equal(await round(), 1, "恢复以后照旧每分钟问");

  // 结账（昨天）不走这条省请求的路，照旧现读：第一轮已经结过昨天，这里确认它当时是真读的，不受「今天」这边放慢影响
  const yesterday = await f.module.queryRules({ preset: "yesterday", ruleIds: ["rr_two"] }, { mode: "evaluate", origin: "page" });
  assert.equal(yesterday.results.length, 1);
  assert.ok(yesterday.results[0].downstream.amountUsd != null, "昨天已经结过账，有数");
});

// 减压 PR（总指挥 10-26 定）：进程刚启动、还没有任何页面来过——生产启动那一处传 viewerIdleSince（启动时刻），从那一刻起算 10 分钟没人看就放慢；
// 之后来一次页面请求，下一轮立刻补一轮。测试默认不传（null），从没人看过不算没人看，P1a 那组照旧
test("减压 PR：启动后一直没有页面来（传了 viewerIdleSince），过 10 分钟就放慢；再来一次页面请求，下一轮立刻补一轮", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { viewerIdleSince: now } });
  const logs = [{ id: 1, created_at: Math.floor(now / 1000) - 60 }];
  const newLog = () => logs.push({ id: logs.length + 1, created_at: Math.floor(now / 1000) - 1 });
  const siteLogs = ownLogList(logs, []);
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !ownSourceRead(url)) {
      f.state.requests.push({ host: url.host, path: url.pathname, query: url.search });
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota: 100 } }) };
    }
    return prev(input, init);
  });
  const statCallsFor = (channelId) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat"
    && new URLSearchParams(request.query).get("channel") === String(channelId)).length;
  const round = async (ms = 60000) => { now += ms; newLog(); const before = statCallsFor(2); await f.module.refreshDue(now); return statCallsFor(2) - before; };

  assert.equal(await round(), 2, "刚启动：还没满 10 分钟，照旧每分钟问；这一轮还要结昨天，渠道 2 多问一次");
  for (let i = 0; i < 8; i += 1) assert.equal(await round(), 1, "启动后 10 分钟内：照旧每分钟问");
  await round(); // 满 10 分钟，这一轮还是正常问的（门槛是超过 10 分钟）
  await round();
  assert.equal(await round(), 0, "启动后一直没有页面来，超过 10 分钟：放慢，这一轮沿用");
  assert.equal(await round(), 0, "还在放慢");
  await f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" });
  assert.equal(await round(), 1, "有页面来了：下一轮立刻补一轮，不等满 5 分钟");
  assert.equal(await round(), 1, "有人看：照旧每分钟问");
});

// 审核 #137 中-1、低-4：放慢那一轮沿用的旧数不能被站点级缓存（ownRevenueCache）吃进去、之后整站沿用时当成刚读到的数给人看；放慢期间满 5 分钟要真去问一次
test("减压 PR（审核 #137 低-4）：放慢期间满 5 分钟会真问一次、问到新数", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const logs = [{ id: 1, created_at: Math.floor(now / 1000) - 60 }];
  const newLog = () => logs.push({ id: logs.length + 1, created_at: Math.floor(now / 1000) - 1 });
  const siteLogs = ownLogList(logs, []);
  const prev = globalThis.fetch;
  let quota2 = 100;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !ownSourceRead(url)) {
      f.state.requests.push({ host: url.host, path: url.pathname, query: url.search });
      const channel = Number(url.searchParams.get("channel"));
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota: channel === 2 ? quota2 : 100 } }) };
    }
    return prev(input, init);
  });
  const statCallsFor = (channelId) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat"
    && new URLSearchParams(request.query).get("channel") === String(channelId)).length;
  const liveTwo = async () => (await f.module.queryRules({ preset: "today", ruleIds: ["rr_two"] }, { mode: "evaluate", origin: "page" })).results[0].downstream.amountUsd;
  const round = async (fresh = true) => { now += 60000; if (fresh) newLog(); const before = statCallsFor(2); await f.module.refreshDue(now); return statCallsFor(2) - before; };

  await liveTwo(); await round(); await round();
  for (let i = 0; i < 11; i += 1) await round(); // 没人看超过 10 分钟，进入放慢
  quota2 = 200; // 有新消费，但这一轮渠道 2 沿用
  assert.equal(await round(), 0, "放慢：这一轮沿用");
  // 放慢期间满 5 分钟要真问一次（改成 60 分钟会抓到）
  const asked = [];
  for (let i = 0; i < 5; i += 1) asked.push(await round());
  assert.ok(asked.some((n) => n > 0), "放慢期间满 5 分钟会真问一次");
  assert.equal(await liveTwo(), 2, "问到了新数");
});

test("减压 PR（审核 #137 中-1 复现）：没人看时渠道来了新消费、马上转安静——页面来看是新数，不是放慢那轮沿用后被站点级缓存吃进去的旧数", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const logs = [{ id: 1, created_at: Math.floor(now / 1000) - 60 }];
  const newLog = () => logs.push({ id: logs.length + 1, created_at: Math.floor(now / 1000) - 1 });
  const siteLogs = ownLogList(logs, []);
  const prev = globalThis.fetch;
  let quota2 = 100;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !ownSourceRead(url)) {
      f.state.requests.push({ host: url.host, path: url.pathname, query: url.search });
      const channel = Number(url.searchParams.get("channel"));
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota: channel === 2 ? quota2 : 100 } }) };
    }
    return prev(input, init);
  });
  const statCallsFor = (channelId) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat"
    && new URLSearchParams(request.query).get("channel") === String(channelId)).length;
  const liveTwo = async () => (await f.module.queryRules({ preset: "today", ruleIds: ["rr_two"] }, { mode: "evaluate", origin: "page" })).results[0].downstream.amountUsd;
  const round = async (fresh = true) => { now += 60000; if (fresh) newLog(); const before = statCallsFor(2); await f.module.refreshDue(now); return statCallsFor(2) - before; };

  await liveTwo(); await round(); await round();
  for (let i = 0; i < 11; i += 1) await round(); // 没人看超过 10 分钟，进入放慢
  quota2 = 200; // 有新消费，但这一轮渠道 2 沿用
  assert.equal(await round(), 0, "放慢：这一轮沿用");
  let askedWhileQuiet = 0;
  for (let i = 0; i < 3; i += 1) askedWhileQuiet += await round(false); // 站点转安静（没有新日志），整站沿用
  assert.ok(askedWhileQuiet > 0, "轮询这一侧：站点转安静后，沿用的渠道要真去问，不能一直沿用旧数（页面现算会掩盖这一点，所以单独断言）");
  assert.equal(await liveTwo(), 2, "页面来看：新数 2，不是放慢那轮沿用的旧数 1");
});

// 审核 #137 中-3：没人看期间某一轮真问了渠道，但读到的窗口没包住最新那条日志（站点钟快、日志落在终点那一秒）；之后站点安静，不能一直沿用旧数
test("减压 PR（审核 #137 中-3）：站点的钟快、真问那一轮没包住最新日志，之后站点安静——轮询这一侧要补问，不能一直沿用旧数", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const sec = () => Math.floor(now / 1000);
  const logs = [{ id: 1, channel: 2, created_at: sec() - 60, quota: 100 }];
  const add = (created_at) => logs.push({ id: logs.length + 1, channel: 2, created_at, quota: 100 });
  const siteLogs = ownLogList(logs, []);
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/") return siteLogs(url);
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !ownSourceRead(url)) {
      f.state.requests.push({ host: url.host, path: url.pathname, query: url.search });
      const channel = Number(url.searchParams.get("channel")), start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
      const quota = logs.filter((log) => log.channel === channel && log.created_at >= start && log.created_at <= end).reduce((sum, log) => sum + log.quota, 0);
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota } }) };
    }
    return prev(input, init);
  });
  const statCallsFor = (channelId) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat"
    && new URLSearchParams(request.query).get("channel") === String(channelId)).length;
  const liveTwo = async () => (await f.module.queryRules({ preset: "today", ruleIds: ["rr_two"] }, { mode: "evaluate", origin: "page" })).results[0].downstream.amountUsd;
  const round = async () => { now += 60000; const before = statCallsFor(2); await f.module.refreshDue(now); return statCallsFor(2) - before; };

  await liveTwo(); await round(); await round();
  for (let i = 0; i < 11; i += 1) await round(); // 没人看超过 10 分钟，进入放慢
  // 找到真问的那一轮，之后数 4 轮沿用，在下一个真问的那一轮前加一笔「站点钟快 30 秒」的日志
  let guard = 0; while ((await round()) === 0 && guard++ < 10);
  for (let i = 0; i < 4; i += 1) assert.equal(await round(), 0, "放慢：沿用");
  add(sec() + 60 + 30); // 这一轮真问时它还在窗口终点之后（站点钟快）
  assert.ok((await round()) > 0, "真问了，但没包住那笔日志，读到旧数");
  let asked = 0;
  for (let i = 0; i < 3; i += 1) asked += await round(); // 之后站点没有新日志：不能一直沿用旧数
  assert.ok(asked > 0, "站点转安静后，没包住最新日志的渠道要补问");
  assert.equal(await liveTwo(), 2, "页面看到的是新数");
});

test("P1b 轮询按时间重读上游：分组和 Key 目录 5 分钟、身份和 /api/status 30 分钟；Key 账单报错、有收入而 Key 用量为 0、目录里找不到 Key，下一轮马上全部重读；页面「刷新」照旧强制", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let dropKey = false;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    // 这一轮的 Key 目录里没有绑定的 Key 9
    if (dropKey && url.host === "upstream.test" && url.pathname === "/api/token/") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 2, items: [
        { id: 10, user_id: 7, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
        { id: 11, user_id: 7, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } }) };
    }
    return prev(input, init);
  });
  const paths = ["/api/user/self", "/api/status", "/api/user/self/groups", "/api/token/"];
  const upstreamReads = () => Object.fromEntries(paths.map((path) => [path, f.state.requests.filter((request) => request.host === "upstream.test" && request.path === path).length]));
  const diff = (before) => { const after = upstreamReads(); return paths.map((path) => after[path] - before[path]); };
  const round = async (minutes) => { now += minutes * 60000; const before = upstreamReads(); await f.module.refreshDue(now); return diff(before); };
  const FULL = [1, 1, 1, 1], CATALOGUE = [0, 0, 1, 1], NONE = [0, 0, 0, 0];

  assert.deepEqual(await round(0), FULL, "第一轮全部读");
  assert.deepEqual(await round(1), NONE, "5 分钟内一样都不读");
  assert.deepEqual(await round(4), CATALOGUE, "满 5 分钟：只重读分组和 Key 目录，身份和 /api/status 沿用");
  assert.deepEqual(await round(1), NONE);
  assert.deepEqual(await round(25), FULL, "满 30 分钟：身份和 /api/status 也重读");

  // 异常一：Key 账单报错 → 下一轮马上全部重读
  f.state.upstreamQuota = null;
  assert.deepEqual(await round(1), NONE, "报错这一轮还在缓存期里");
  f.state.upstreamQuota = 100;
  assert.deepEqual(await round(1), FULL, "下一轮全部重读");
  assert.deepEqual(await round(1), NONE, "重读过就不再强制");

  // 异常二：渠道有收入而 Key 用量为 0 → 下一轮马上全部重读
  f.state.upstreamQuota = 0;
  assert.deepEqual(await round(1), NONE);
  f.state.upstreamQuota = 100;
  assert.deepEqual(await round(1), FULL);

  // 异常三：目录里找不到绑定的 Key（目录到点重读时发现）→ 下一轮马上全部重读，身份也重读
  dropKey = true;
  assert.deepEqual(await round(5), CATALOGUE);
  dropKey = false;
  assert.deepEqual(await round(1), FULL);

  // 没有异常时一样都不读；页面「刷新」照旧强制全部重读
  assert.deepEqual(await round(1), NONE);
  const before = upstreamReads();
  await f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] }, { mode: "observe", force: true, origin: "manual" });
  assert.deepEqual(diff(before), FULL);
});

test("P1b 身份正好满 30 分钟就重读、不等目录到期；改了凭据下一轮全读；强制读失败记号留着；沿用身份读目录失败、清缓存以后下一轮全读", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let failPath = null;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === failPath) {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 401, text: async () => JSON.stringify({ success: false, message: "unauthorized" }) };
    }
    return prev(input, init);
  });
  const paths = ["/api/user/self", "/api/status", "/api/user/self/groups", "/api/token/"];
  const upstreamReads = () => Object.fromEntries(paths.map((path) => [path, f.state.requests.filter((request) => request.host === "upstream.test" && request.path === path).length]));
  const round = async (ms) => {
    now += ms;
    const before = upstreamReads();
    await f.module.refreshDue(now);
    const after = upstreamReads();
    return paths.map((path) => after[path] - before[path]);
  };
  const MIN = 60000, FULL = [1, 1, 1, 1], CATALOGUE = [0, 0, 1, 1], NONE = [0, 0, 0, 0];

  assert.deepEqual(await round(0), FULL);
  assert.deepEqual(await round(29 * MIN + 59000), CATALOGUE, "身份读了 29:59，还沿用");
  assert.deepEqual(await round(1000), FULL, "正好 30:00：身份到期就重读，目录 1 秒前才读过也不等");
  assert.deepEqual(await round(MIN), NONE);

  // 改了凭据：缓存不能再用，下一轮全读
  f.stations[0].accessToken = "pat-2";
  assert.deepEqual(await round(MIN), FULL, "改了凭据下一轮全读");
  assert.deepEqual(await round(MIN), NONE);

  // Key 账单报错记了号；强制重读那一轮身份读失败：记号留着，下一轮接着全读
  f.state.upstreamQuota = null;
  assert.deepEqual(await round(MIN), NONE);
  f.state.upstreamQuota = 100;
  failPath = "/api/user/self";
  assert.deepEqual(await round(MIN), [1, 0, 0, 0], "强制重读，身份那一步就失败了");
  failPath = null;
  assert.deepEqual(await round(MIN), FULL, "失败了记号还在，下一轮接着全读");
  assert.deepEqual(await round(MIN), NONE, "读成功才清掉");

  // 目录到期、拿沿用的身份读目录失败：记号，下一轮全读（不再每轮拿旧身份重读）
  failPath = "/api/token/";
  assert.deepEqual(await round(5 * MIN), CATALOGUE);
  failPath = null;
  assert.deepEqual(await round(MIN), FULL, "沿用身份读失败，下一轮全读");
  assert.deepEqual(await round(MIN), NONE);

  // 自营站点的身份或渠道目录真变了时，渠道同步会清上游缓存：下一轮全读
  f.module.invalidateSources();
  assert.deepEqual(await round(MIN), FULL);
});

test("P1b 沿用身份时上游拒绝读 Key 账单：这一轮先算还在读取，不说「上游拒绝读取这把 Key」；下一轮现读身份以后还被拒才说", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let denyStat = false;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (denyStat && url.host === "upstream.test" && url.pathname === "/api/log/self/stat") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 401, text: async () => JSON.stringify({ success: false, message: "unauthorized" }) };
    }
    return prev(input, init);
  });
  // 轮询记下的告警状态：拒绝读取会推送，还在读取不推送
  const codes = async () => f.repository.tables.alerts.filter((row) => row.rule_id === "rr_live" && Number(row.active) === 1).map((row) => row.event_code);
  const identityReads = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/user/self").length;
  await f.module.refreshDue(now);
  assert.equal((await codes()).includes("KEY_INVALID_OR_DENIED"), false);

  denyStat = true;
  now += 60000;
  let before = identityReads();
  await f.module.refreshDue(now);
  assert.equal(identityReads() - before, 0, "这一轮沿用身份");
  assert.equal((await codes()).includes("KEY_INVALID_OR_DENIED"), false, "先算还在读取，不说拒绝，也就不推送");

  now += 60000;
  before = identityReads();
  await f.module.refreshDue(now);
  assert.equal(identityReads() - before, 1, "下一轮现读身份");
  assert.ok((await codes()).includes("KEY_INVALID_OR_DENIED"), "现读身份以后还被拒：才说上游拒绝");
});

test("P1b Sub2API 沿用身份那一轮读账单时发现账号换了：先算还在读取、不推送，下一轮全量重读再定；auth/me 偶尔超时照常推送", async (t) => {
  for (const scenario of ["换了账号", "auth/me 超时"]) {
    await t.test(scenario, async (st) => {
      let now = Date.parse("2026-10-11T01:00:00Z");
      st.mock.method(Date, "now", () => now);
      const f = sub2ReconciliationFixture(st, { baseUrl: `https://sub2-reuse-${scenario === "换了账号" ? "owner" : "timeout"}.test`, costs: { "2026-10-11": 1, "2026-10-10": 2 } });
      const codes = () => f.repository.tables.alerts.filter((row) => row.rule_id === f.rule.id && Number(row.active) === 1).map((row) => row.event_code);
      await f.module.refreshDue(now);
      // 第一轮核验了账单能力，能力变了会清掉 Key 目录缓存；再跑一轮，让目录和身份进缓存
      now += 60000;
      await f.module.refreshDue(now);
      assert.deepEqual(codes(), []);
      if (scenario === "换了账号") f.sub2.accountId = 8;
      else f.sub2.onRequest = (url) => { if (url.pathname === "/api/v1/auth/me") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
      now += 60000;
      await f.module.refreshDue(now); // 这一轮 Key 目录和身份都沿用缓存，只有读账单时核对 auth/me
      if (scenario === "换了账号") {
        assert.deepEqual(codes(), [], "沿用身份时账号对不上：先算还在读取，不推「上游这天的用量记录一直读不到」");
        let catalogueReads = 0;
        f.sub2.onRequest = (url) => { if (url.pathname === "/api/v1/keys") catalogueReads += 1; };
        now += 60000;
        await f.module.refreshDue(now);
        assert.ok(catalogueReads > 0, "下一轮全部重读 Key 目录和身份");
        assert.deepEqual(codes(), [], "重读以后和以前一样卡在读目录那一步（账号对不上），不推送");
      } else {
        assert.ok(codes().includes("UPSTREAM_DATA_UNAVAILABLE"), `auth/me 超时不是账号换了：照常推送（${codes()}）`);
      }
    });
  }
});

test("P1b 分组没读到的那份 Key 目录不缓存：下一轮照常重读，上游恢复了马上就好", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let groupsDown = false, groupReads = 0;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/user/self/groups") {
      groupReads += 1;
      if (groupsDown) return { status: 500, text: async () => JSON.stringify({ success: false, message: "busy" }) };
    }
    return prev(input, init);
  });
  await f.module.refreshDue(now);
  groupsDown = true;
  now += 6 * 60000; // 目录到期，这一轮重读时分组读不到
  await f.module.refreshDue(now);
  groupsDown = false;
  now += 60000;
  const before = groupReads;
  await f.module.refreshDue(now);
  assert.equal(groupReads - before, 1, "分组没读到的那份没进缓存，下一轮照常重读");
  now += 60000;
  const after = groupReads;
  await f.module.refreshDue(now);
  assert.equal(groupReads - after, 0, "读全了的照常缓存 5 分钟");
});

test("P1b 上游的 Key 目录不带 user_id：照旧挡住不结，要人处理「对方的版本不支持这项功能」，不说会自动再读", async (t) => {
  const now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/token/") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 3, items: [
        { id: 9, name: "stable", status: 1, group: "g1", cross_group_retry: false },
        { id: 10, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
        { id: 11, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } }) };
    }
    return prev(input, init);
  });
  const [row] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" })).results;
  assert.deepEqual([row.health.code, row.calculation.profitUsd], ["UPSTREAM_FEATURE_UNSUPPORTED", null]);
  assert.equal(reconciliationIssue(row.health.code).kind, "action", "要人处理");
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.length, 0, "不结账");
});

test("P1b 结账那一轮先把要结的上游全部重读：quota_per_unit 在两次轮询之间变了，账本用新值", async (t) => {
  // 绑定按上海时区算一天；10-09 这天在 16:00Z 结束，过 15 分钟才结账
  let now = Date.parse("2026-10-09T16:01:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let quotaPerUnit = 100;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/status") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota_per_unit: quotaPerUnit, version: "v" } }) };
    }
    return prev(input, init);
  });
  const statusReads = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/status").length;
  const settledDay = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-09");

  await f.module.refreshDue(now);
  assert.equal(settledDay().length, 0, "还没到结账的时刻");
  // 两次轮询之间上游改了 quota_per_unit；目录到期重读时沿用旧的 /api/status
  quotaPerUnit = 200;
  now += 6 * 60000;
  let before = statusReads();
  await f.module.refreshDue(now);
  assert.equal(statusReads() - before, 0, "平常的轮询沿用 /api/status");
  assert.equal(settledDay().length, 0);

  now += 9 * 60000;
  before = statusReads();
  await f.module.refreshDue(now);
  assert.equal(statusReads() - before, 1, "结账那一轮现读 /api/status");
  const [entry] = settledDay();
  assert.ok(entry, "这一轮结了账");
  assert.equal(Number(entry.cost_usd), f.state.upstreamQuota / 200, "账本用新的 quota_per_unit");
});

test("P1b 结账那一轮先重读的是要结账的那条绑定的上游：它不排第一、在另一个时区，结账前 quota_per_unit 改了，账本照样用新值", async (t) => {
  // rr_two 改成洛杉矶时区：它的 10-09 在 10-10 07:00Z 结束，07:15Z 以后结账；排在前面的 rr_live（上海）那时早就结完了
  let now = Date.parse("2026-10-10T06:50:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  f.rows.find((row) => row.id === "rr_two").timezone = "America/Los_Angeles";
  let quotaPerUnit = 100;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/status") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota_per_unit: quotaPerUnit, version: "v" } }) };
    }
    return prev(input, init);
  });
  const statusReads = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/status").length;
  const settled = (ruleId, day) => f.state.ledger.filter((row) => row.rule_id === ruleId && row.bill_date === day);

  // 06:50 第一轮读了 /api/status（30 分钟内沿用）；之后每 10 分钟一轮
  await f.module.refreshDue(now);
  assert.equal(settled("rr_live", "2026-10-09").length, 1, "排在第一的 rr_live 这时已经结完");
  for (const at of ["07:00", "07:10"]) {
    now = Date.parse(`2026-10-10T${at}:00Z`);
    if (at === "07:00") quotaPerUnit = 200; // 两次读 /api/status 之间上游改了 quota_per_unit
    const before = statusReads();
    await f.module.refreshDue(now);
    assert.equal(statusReads() - before, 0, `${at} 平常的轮询沿用 06:50 读的 /api/status`);
  }
  assert.equal(settled("rr_two", "2026-10-09").length, 0, "rr_two 的 10-09 还没到结账的时刻");
  // 07:16：只有 rr_two 要结账（离上次读 /api/status 26 分钟，还没到 30 分钟），它的上游要先重读
  now = Date.parse("2026-10-10T07:16:00Z");
  const before = statusReads();
  await f.module.refreshDue(now);
  assert.equal(statusReads() - before, 1, "结账那一轮现读 /api/status");
  const [entry] = settled("rr_two", "2026-10-09");
  assert.ok(entry, "这一轮结了 rr_two 的 10-09");
  assert.equal(Number(entry.cost_usd), f.state.upstreamQuota / 200, "账本用新的 quota_per_unit");
});

test("C2a 回看也先把要结的上游全部重读：quota_per_unit 在两次轮询之间变了，回看结的那天用新值；没有要结的日子就不重读", async (t) => {
  // 上海时区 10-09 11:00：昨天是 10-08，更早要回看的是 10-07（10-07 起开始统计）；每轮只回看 1 天
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 1 } });
  let quotaPerUnit = 100;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/status") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota_per_unit: quotaPerUnit, version: "v" } }) };
    }
    return prev(input, init);
  });
  const statusReads = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/status").length;
  const booked = (day) => f.state.ledger.filter((row) => row.bill_date === day).map((row) => [row.rule_id, Number(row.cost_usd)]).sort();

  await f.module.refreshDue(now);
  assert.deepEqual(booked("2026-10-08").map(([id]) => id), ["rr_live", "rr_three", "rr_two"], "昨天三条都结了");
  assert.deepEqual(booked("2026-10-07").map(([id]) => id), ["rr_live"], "回看这一轮只结 1 天");
  assert.deepEqual(f.state.ledger.map((row) => [row.rule_id, row.bill_date, row.detail.settlement?.trigger]).sort(),
    [["rr_live", "2026-10-07", "late"], ["rr_live", "2026-10-08", "poll"], ["rr_three", "2026-10-08", "poll"], ["rr_two", "2026-10-08", "poll"]],
    "账本明细记下怎么结的：轮询结昨天 poll、回看更早的日子 late");
  const yesterdayCost = Object.fromEntries(booked("2026-10-08"));

  // 两次轮询之间上游改了 quota_per_unit；这一轮只有回看要结（rr_two 的 10-07），照样现读 /api/status
  quotaPerUnit = 200;
  now += 6 * 60000;
  let before = statusReads();
  await f.module.refreshDue(now);
  assert.equal(statusReads() - before, 1, "回看那一轮现读 /api/status");
  assert.deepEqual(booked("2026-10-07").map(([id]) => id), ["rr_live", "rr_two"]);
  assert.equal(Object.fromEntries(booked("2026-10-07")).rr_two, yesterdayCost.rr_two / 2, "回看结的那天用新的 quota_per_unit");

  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(booked("2026-10-07").map(([id]) => id), ["rr_live", "rr_three", "rr_two"]);
  // 没有要结的日子了：平常的轮询沿用 /api/status
  now += 60000;
  before = statusReads();
  await f.module.refreshDue(now);
  assert.equal(statusReads() - before, 0, "没有要结的日子，不重读");
});

test("B1 结果缓存按请求比：「今天」过了半分钟再单独重读一条，别的绑定照样用缓存里的账单（截止点不同也是同一段）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const full = await f.module.queryRules({ preset: "today" });
  assert.equal(full.results.length, 3);
  assert.ok(full.results.every((row) => row.window.preset === "today" && row.window.endMs === Date.parse("2026-10-09T03:00:00Z")));
  now += 30000;
  const selected = await f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] });
  assert.equal(selected.coverage.accountedChannelCount, full.coverage.accountedChannelCount, "另外两条绑定的账单从缓存里取到了");
  assert.ok(!selected.coverage.channels.some((channel) => channel.issues.includes("BILLING_EVIDENCE_NOT_QUERIED")));
});

test("B-L1 重结内容相同不写新版：这次的结果（会进缓存）固定时刻也照账本里那一版，不显示成新的时刻", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  await f.module.refreshDue(now);
  const first = f.state.ledger.filter((entry) => entry.rule_id === "rr_live");
  assert.equal(first.length, 1, "前提：昨天结了第 1 版");
  const settledAt = (await f.repository.latestLedgerEntry("rr_live", { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z"), timezone: "Asia/Shanghai" })).settledAt;
  // 一小时后重结，上游、本站都没变
  now += 3600000;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now: Date.now() - 1 });
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((entry) => entry.rule_id === "rr_live" && entry.bill_date === "2026-10-08").length, 1, "内容相同，不写第 2 版（一小时后回看也开始了，更早的日子另算）");
  const page = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.deepEqual([page.results[0].displayStatus.state, page.results[0].settledAt], ["settled", settledAt], "固定时刻还是第 1 版的");
});

test("旧规则（legacy-v3）不要求回答 Key 用途：汇总照加、旁边那句不提、渠道算已算进利润、那一行不是需处理，四处一致", async (t) => {
  const f = await completedDayFixture(t);
  const legacy = f.rows.find((row) => row.id === "rr_two");
  Object.assign(legacy, { billing_policy: "legacy-v3", cost_coverage: "unknown" });
  legacy.source_binding.coverageDeclaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
  const result = await f.module.queryRules();
  const row = result.results.find((item) => item.rule.id === "rr_two");
  assert.notEqual(row.displayStatus.state, "action", "每日利润那一行不是需处理");
  assert.ok(!row.health.issues.some((issue) => issue.code === "COST_COVERAGE_UNKNOWN"));
  const totals = result.windowGroups[0].totals;
  assert.deepEqual([totals.knownIncomeUsd, totals.knownCostUsd, totals.confirmedProfitUsd, totals.attentionRuleIds, totals.readingRuleIds], [7.5, 3, 4.5, [], []], "汇总照加，旁边那句没有话");
  assert.equal(result.coverage.channels.find((channel) => channel.channelId === 2).status, "accounted", "渠道算已算进利润");
});

test("已固定的那天按固定时的结论：之后把 Key 用途改成「不确定」，那天照样已固定、算进汇总、渠道算已算进利润", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.refreshDue(Date.now());
  assert.equal(f.state.ledger.length, 3, "前提：轮询结掉了昨天");
  const two = f.rows.find((row) => row.id === "rr_two");
  two.cost_coverage = "unknown";
  two.source_binding.coverageDeclaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
  f.rt._reconciliationResultCache?.clear?.();
  const page = await f.module.queryRules({ preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  const row = page.results.find((item) => item.rule.id === "rr_two");
  assert.deepEqual([row.displayStatus.state, row.calculation.profitUsd], ["settled", 1.5], "那一行仍是已固定 $1.50");
  const totals = page.windowGroups[0].totals;
  assert.deepEqual([totals.knownIncomeUsd, totals.knownCostUsd, totals.confirmedProfitUsd, totals.attentionRuleIds, totals.readingRuleIds], [7.5, 3, 4.5, [], []], "汇总照加，旁边那句没有话");
  assert.equal(page.coverage.channels.find((channel) => channel.channelId === 2).status, "accounted", "渠道也算已算进利润");
});

test("汇总和渠道那句同一个判断：今天有收入、上游用量还是 0 的绑定，汇总不加，渠道也不算已算进利润，旁边那句说它还在读取", async (t) => {
  const f = await completedDayFixture(t, { now: "2026-10-09T02:00:00Z" }); // 上海 10:00
  const prev = globalThis.fetch; // fixture 已经替换过的 fetch：没拦下的请求都交回去
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    // rr_two 那把 Key 今天还没有用量
    if (url.host === "upstream.test" && url.pathname === "/api/log/self/stat" && url.searchParams.get("token_name") === "stable-rr_two")
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { quota: 0 } }) };
    return prev(input, init);
  });
  const module = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: accountUsageStub({ upstream: 5 }).stationUsageCost });
  const r = await module.queryRules({ preset: "today" }, { accountUsage: true });
  const two = r.results.find((row) => row.rule.id === "rr_two");
  assert.deepEqual([two.displayStatus.state, two.health.code, two.billingTimezone.state, two.calculation.profitUsd], ["live", "UPSTREAM_EMPTY_WITH_SALES", "verified", null], "前提：还在读取，毛利算不出来");
  const { display, attentionRuleIds, readingRuleIds } = r.commonSummary.totals;
  assert.deepEqual([display.knownIncome, display.knownCost, display.confirmedProfit, attentionRuleIds, readingRuleIds], [5, 2, 3, [], ["rr_two"]]);
  assert.equal(reconciliationCoverageText(r.commonSummary.coverage), "10 个渠道里 2 个已算进利润", "汇总没加的，渠道也不算已算进利润");
  assert.equal(reconciliationNotCountedText(r.commonSummary.totals, r.results[0].requestedWindow, Date.now()), "其中 10月9日 有 1 条绑定还在读取，没算进来。");
  // 没算进利润的上游成本：扣费 $5，其中算进利润 $2，没算进 $3
  assert.deepEqual([r.unaccountedUpstream.accounts[0].accountedUsd, r.unaccountedUpstream.accounts[0].unaccountedUsd], [2, 3]);
});

test("U05真实NewAPI默认完整昨日：3/10全局known覆盖、局部重试复用同窗有效事实且group仅选中金额", async (t) => {
  const f = await completedDayFixture(t);
  const full = await f.module.queryRules();
  assert.equal(full.results.length, 3);
  assert.equal(full.results[0].window.preset, "yesterday");
  assert.deepEqual([full.results[0].window.startMs, full.results[0].window.endMs], [Date.parse("2026-10-07T16:00:00Z"), Date.parse("2026-10-08T16:00:00Z")]);
  assert.ok(full.results.every((row) => row.billingTimezone.state === "verified" && row.calculation.profitUsd === 1.5));
  assert.deepEqual([full.coverage.knownChannelCount, full.coverage.accountedChannelCount, full.coverage.state, full.coverage.wholeSiteState], [10, 3, "partial", "unverified"]);
  assert.equal(full.windowGroups.length, 1);
  // 一个汇率都没设置：按系统原值（USD）显示，也不提示缺汇率。
  assert.deepEqual(full.commonSummary.totals, { knownIncomeUsd: 7.5, knownCostUsd: 3, confirmedProfitUsd: 4.5, confirmedMarginRate: 0.6, profitComplete: false, attentionRuleIds: [], heldRuleIds: [], notStartedRuleIds: [], readingRuleIds: [],
    display: { currency: "USD", knownIncome: 7.5, knownCost: 3, confirmedProfit: 4.5, confirmedMarginRate: 0.6 } });
  assert.deepEqual([full.displayCurrency, full.unconfiguredRateStations], ["USD", []]);
  assert.equal(full.unaccountedUpstream, undefined, "没要求账号级对比时不附带");
  const selected = await f.module.queryRules({ ruleIds: ["rr_live"] });
  assert.equal(selected.results.length, 1);
  assert.equal(selected.windowGroups[0].totals.knownIncomeUsd, 2.5, "局部group totals仅含本次选中规则");
  assert.deepEqual([selected.coverage.knownChannelCount, selected.coverage.accountedChannelCount], [10, 3], "同窗有效且未改业务事实的缓存账单保持全局known覆盖");
  assert.deepEqual([selected.windowGroups[0].coverage.knownChannelCount, selected.windowGroups[0].coverage.accountedChannelCount], [10, 3]);
  assert.equal(f.state.statCalls.length, 6, "局部force=false可复用已有本窗账单");
  assert.ok(full.coverage.channels.find((channel) => channel.channelId === 9).actions.some((action) => action.href === "/stations?action=connect&ownStationId=own&channelIds=9"));
});

// 账号级用量替身：记录调用，按站点返回扣费。
function accountUsageStub(usdByStation, { delayMs = 0 } = {}) {
  const calls = [];
  const stationUsageCost = async (rt, station, range) => {
    calls.push({ stationId: station.id, ...range });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const usd = usdByStation[station.id];
    if (usd instanceof Error) throw usd;
    return { usd, mode: "api", error: "should-not-leak" };
  };
  return { calls, stationUsageCost };
}

test("3b 核算按人民币：收入按本站汇率、成本按上游汇率；未纳入核算的上游消费 = 账号扣费 − 已核算成本", async (t) => {
  const f = await completedDayFixture(t);
  f.stations.find((station) => station.id === "own").cnyPerUsd = 7;
  f.stations.find((station) => station.id === "upstream").cnyPerUsd = 6;
  const usage = accountUsageStub({ upstream: 5 });
  const module = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: usage.stationUsageCost });
  const full = await module.queryRules({}, { accountUsage: true });
  assert.deepEqual(full.results[0].rates, { income: { stationId: "own", cnyPerUsd: 7, source: "configured" },
    cost: { stationId: "upstream", cnyPerUsd: 6, source: "configured" }, costBasis: "usage" });
  assert.deepEqual([full.displayCurrency, full.unconfiguredRateStations], ["CNY", []]);
  const display = full.commonSummary.totals.display;
  assert.deepEqual([display.currency, display.knownIncome, display.knownCost, display.confirmedProfit], ["CNY", 52.5, 18, 34.5], "每条 $2.5×7 − $1×6");
  assert.ok(Math.abs(display.confirmedMarginRate - 34.5 / 52.5) < 1e-9);
  assert.equal(full.commonSummary.totals.confirmedProfitUsd, 4.5, "USD 原始口径不变");
  const unaccounted = full.unaccountedUpstream;
  assert.deepEqual([unaccounted.state, unaccounted.currency, unaccounted.total], ["complete", "CNY", 12], "账号扣费 $5 − 已核算 $3，按上游汇率 6");
  assert.deepEqual(unaccounted.accounts.map((item) => [item.stationId, item.accountUsd, item.accountedUsd, item.unaccountedUsd, item.account, item.accounted, item.ruleIds.length]),
    [["upstream", 5, 3, 2, 30, 18, 3]]);
  assert.deepEqual(unaccounted.window, { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z"), timezone: "Asia/Shanghai", preset: "yesterday" });
  assert.deepEqual([unaccounted.fixedStations, unaccounted.excludedStations], [[], []]);
  assert.ok(!JSON.stringify(unaccounted).includes("should-not-leak"), "上游错误原文不进响应");
  assert.deepEqual(usage.calls.map((call) => [call.stationId, call.startMs, call.endMs, call.tz, call.today]),
    [["upstream", Date.parse("2026-10-07T16:00:00Z"), Date.parse("2026-10-08T16:00:00Z"), "Asia/Shanghai", false]], "同窗只取一次");
  // 缓存期内重读不再取上游；只有页面「刷新」才重新读。
  await module.queryRules({}, { accountUsage: true });
  assert.equal(usage.calls.length, 1);
  await module.queryRules({}, { accountUsage: "refresh", force: true });
  assert.equal(usage.calls.length, 2);
  // 按关联查询和没要求时都不附带，也不取上游。
  const selected = await module.queryRules({ ruleIds: ["rr_live"] }, { accountUsage: true });
  assert.equal(selected.unaccountedUpstream, undefined);
  assert.equal(usage.calls.length, 2);
});

// 独立 Key 监控 + 专用账号授权：核算关联建在没开监控的授权站点上，按用量对比的是 Key 监控站点。
test("3b 未开监控的站点上的核算关联：渠道接到 Key 监控站点时计入它的已核算，无法确认时标为部分", async (t) => {
  const f = await completedDayFixture(t);
  Object.assign(f.stations.find((station) => station.id === "upstream"), { monitorEnabled: false, includeInProfit: false });
  f.stations.push({ id: "key", name: "Key 监控", type: "newapi-key", baseUrl: "https://upstream.test/", apiKey: "sk-test", authVersion: 1 });
  const usage = accountUsageStub({ key: 5 });
  const module = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: usage.stationUsageCost });
  let unaccounted = (await module.queryRules({}, { accountUsage: true })).unaccountedUpstream;
  assert.deepEqual(unaccounted.accounts.map((item) => [item.stationId, item.state, item.accountUsd, item.accountedUsd, item.unaccountedUsd, item.ruleIds]),
    [["key", "partial", 5, 0, 5, []]], "地址相同不能确认是同一账号");
  assert.deepEqual(unaccounted.accounts[0].notes, ["暂停监控的上游「上游」上的绑定还没确认属于哪个上游账号，没算进利润的上游成本可能偏高；到「渠道绑定」里把渠道对上这个上游后就能确认"]);
  assert.deepEqual([unaccounted.state, unaccounted.excludedStations], ["partial", []], "授权站点没开监控，不算设为不计入成本的上游");
  const links = [1, 2, 3].map((channelId) => ({ ownStationId: "own", channelId, stationId: "key", channelRevision: `r${channelId}` }));
  f.rt.onboardingSource.getMonitorLinks = () => links;
  unaccounted = (await module.queryRules({}, { accountUsage: true })).unaccountedUpstream;
  assert.deepEqual(unaccounted.accounts.map((item) => [item.state, item.accountedUsd, item.unaccountedUsd, item.ruleIds, item.notes]),
    [["complete", 3, 2, ["rr_live", "rr_two", "rr_three"], ["已算进利润的部分含暂停监控的上游「上游」上的绑定"]]]);
  assert.deepEqual([unaccounted.state, unaccounted.total], ["complete", 2]);
  links.splice(1);
  unaccounted = (await module.queryRules({}, { accountUsage: true })).unaccountedUpstream;
  assert.deepEqual(unaccounted.accounts.map((item) => [item.state, item.accountedUsd, item.ruleIds]), [["partial", 1, ["rr_live"]]], "只有接了监控的渠道上的关联才归属");
  assert.deepEqual(unaccounted.accounts[0].notes, ["已算进利润的部分含暂停监控的上游「上游」上的绑定",
    "暂停监控的上游「上游」上的绑定还没确认属于哪个上游账号，没算进利润的上游成本可能偏高；到「渠道绑定」里把渠道对上这个上游后就能确认"]);
  assert.equal(usage.calls.length, 1);
  // 监控关联不要求地址相同：Key 监控换成另一个地址，接了监控的渠道仍归属，其余没有同地址的候选，不再标出
  f.stations.find((station) => station.id === "key").baseUrl = "https://api.upstream.test/";
  unaccounted = (await module.queryRules({}, { accountUsage: true })).unaccountedUpstream;
  assert.deepEqual(unaccounted.accounts.map((item) => [item.state, item.accountedUsd, item.ruleIds, item.notes]),
    [["complete", 1, ["rr_live"], ["已算进利润的部分含暂停监控的上游「上游」上的绑定"]]]);
  assert.equal(usage.calls.length, 2, "账号用量按缓存复用，站点地址变了才重新取");
});

test("3b 固定采购上游：核算成本记 0，不用它的汇率；账号级对比只列为固定采购", async (t) => {
  const f = await completedDayFixture(t);
  const upstream = f.stations.find((station) => station.id === "upstream");
  upstream.fixedPurchases = [{ amount: 300, days: 30 }];
  const usage = accountUsageStub({ upstream: 5 });
  const module = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: usage.stationUsageCost });
  let full = await module.queryRules({}, { accountUsage: true });
  assert.equal(full.results[0].rates.costBasis, "fixed");
  assert.deepEqual(full.commonSummary.totals.display, { currency: "USD", knownIncome: 7.5, knownCost: 0, confirmedProfit: 7.5, confirmedMarginRate: 1 });
  assert.deepEqual([full.unaccountedUpstream.state, full.unaccountedUpstream.total, full.unaccountedUpstream.accounts], ["complete", 0, []]);
  assert.deepEqual(full.unaccountedUpstream.fixedStations, [{ id: "upstream", name: "上游" }]);
  assert.deepEqual(full.fixedOffProfitStations, [], "我的站点会摊销它的采购费");
  f.stations.find((station) => station.id === "own").cnyPerUsd = 7;
  full = await module.queryRules({}, { accountUsage: true });
  assert.deepEqual([full.displayCurrency, full.unconfiguredRateStations], ["CNY", []], "只需要本站汇率");
  assert.deepEqual([full.commonSummary.totals.display.knownIncome, full.commonSummary.totals.display.confirmedProfit], [52.5, 52.5]);
  // 我的站点只摊销开了监控、计入成本、没归档的固定采购站点；关联建在其他固定采购站点上时点名，成本照样记 0
  const offProfit = [
    [{ includeInProfit: false }, [{ id: "upstream", name: "上游" }], [], "设为不计入成本的固定采购上游列在固定采购里"],
    [{ monitorEnabled: false }, [], [], "没开监控的站点不做账号级对比"],
    [{ archivedAt: "2026-10-01T00:00:00Z" }, [], [], "已归档"],
  ];
  // 测试桩的 list 不按归档和监控过滤，这里照真实 store 的选项过滤：默认不列出归档和没开监控的站点
  const list = f.rt.store.list;
  const filtered = t.mock.method(f.rt.store, "list", (options = {}) => list(options).filter((station) =>
    (options.includeArchived || !station.archivedAt) && (options.includeUnmonitored || station.monitorEnabled !== false)));
  try {
    for (const [patch, fixedStations, excludedStations, message] of offProfit) {
      const saved = { ...upstream };
      Object.assign(upstream, patch);
      try {
        full = await module.queryRules({}, { accountUsage: true });
      } finally {
        for (const key of Object.keys(patch)) delete upstream[key];
        Object.assign(upstream, saved);
      }
      assert.deepEqual(full.results.map((row) => row.rates.costBasis), ["fixed", "fixed", "fixed"], message);
      assert.equal(full.commonSummary?.totals.display.knownCost, 0, message);
      assert.deepEqual(full.fixedOffProfitStations, [{ id: "upstream", name: "上游" }], `${message}：三条关联在同一站点上，只点名一次`);
      assert.deepEqual([full.unaccountedUpstream?.fixedStations, full.unaccountedUpstream?.excludedStations], [fixedStations, excludedStations], message);
    }
  } finally {
    filtered.mock.restore();
  }
  // 测试桩不过滤时也按归档判断
  upstream.archivedAt = "2026-10-01T00:00:00Z";
  full = await module.queryRules({}, { accountUsage: true });
  delete upstream.archivedAt;
  assert.deepEqual(full.fixedOffProfitStations, [{ id: "upstream", name: "上游" }]);
  assert.equal(usage.calls.length, 0);
});

test("3b 只设置了部分汇率：整页仍按 USD 原值显示，并列出还没设置的站点", async (t) => {
  const f = await completedDayFixture(t);
  f.stations.find((station) => station.id === "own").cnyPerUsd = 7;
  const full = await f.module.queryRules();
  assert.equal(full.displayCurrency, "USD");
  assert.deepEqual(full.unconfiguredRateStations, [{ id: "upstream", name: "上游" }]);
  assert.equal(full.commonSummary.totals.display.currency, "USD");
  assert.equal(full.commonSummary.totals.display.confirmedProfit, 4.5);
});

test("3b 账号用量读取失败或超时：核算照常返回，失败记为不可用，超时记为读取中", async (t) => {
  const f = await completedDayFixture(t);
  const failing = accountUsageStub({ upstream: new Error("token sk-secret rejected") });
  const failed = await createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: failing.stationUsageCost })
    .queryRules({}, { accountUsage: true });
  assert.equal(failed.results.length, 3);
  assert.equal(failed.unaccountedUpstream.state, "partial");
  assert.deepEqual([failed.unaccountedUpstream.accounts[0].state, failed.unaccountedUpstream.accounts[0].accountUsd], ["unavailable", null]);
  assert.ok(!JSON.stringify(failed.unaccountedUpstream).includes("sk-secret"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = accountUsageStub({ upstream: 5 }, { delayMs: 60000 });
  const pending = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: slow.stationUsageCost }).queryRules({}, { accountUsage: true });
  for (let i = 0; i < 50 && slow.calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 200; i += 1) { await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.tick(100); }
  const response = await pending;
  assert.deepEqual([response.unaccountedUpstream.state, response.unaccountedUpstream.total], ["pending", null]);
  assert.equal(response.unaccountedUpstream.accounts[0].state, "pending");
});

test("3b 账号用量走真实取数：sk 密钥站点没有用量接口，余额历史不够时记为读不到，历史不全时金额只是下限", async (t) => {
  const f = await completedDayFixture(t);
  f.stations.find((station) => station.id === "upstream").includeInProfit = false;
  f.stations.push({ id: "keyonly", type: "newapi-key", name: "密钥上游", baseUrl: "https://keyonly.test", apiKey: "sk-keyonly-secret" });
  const history = { used: 0, covered: false, calls: [] };
  f.rt.history = { usedBetween: (...args) => { history.calls.push(args); return history.used; }, covers: () => history.covered };
  const read = () => createReconciliationModule(f.rt, { repository: f.repository }).queryRules({}, { accountUsage: true });
  let full = await read();
  assert.deepEqual(full.unaccountedUpstream.excludedStations, [{ id: "upstream", name: "上游" }]);
  assert.equal(full.commonSummary.totals.knownCostUsd, 3, "设为不计入成本的上游，核算关联仍按 Key 用量计成本");
  assert.deepEqual(full.unaccountedUpstream.accounts.map((item) => [item.stationId, item.state, item.accountUsd, item.notes]),
    [["keyonly", "unavailable", null, ["上游暂时读不到，系统会自动再读"]]]);
  assert.deepEqual([full.unaccountedUpstream.state, full.unaccountedUpstream.total], ["partial", 0]);
  assert.deepEqual(history.calls[0], ["keyonly", Date.parse("2026-10-07T16:00:00Z"), Date.parse("2026-10-08T16:00:00Z")]);
  history.used = 3;
  full = await read();
  assert.deepEqual(full.unaccountedUpstream.accounts.map((item) => [item.state, item.accountUsd, item.notes]),
    [["partial", 3, ["读不到用量，改按余额变化估算；历史数据不够，金额偏低"]]]);
  assert.deepEqual([full.unaccountedUpstream.state, full.unaccountedUpstream.total], ["partial", 3]);
  Object.assign(history, { used: 0, covered: true });
  full = await read();
  assert.deepEqual(full.unaccountedUpstream.accounts.map((item) => [item.state, item.accountUsd, item.notes]),
    [["estimated", 0, ["读不到用量，改按余额变化估算"]]], "历史覆盖整个时段时 0 就是真的没消耗");
  assert.ok(!JSON.stringify(full).includes("sk-keyonly-secret") && !JSON.stringify(full).includes("sk 密钥模式"));
});

test("3b 账号用量预热：各关联时区解析出不同窗口时不取数，同一窗口只按一个时区取一次", async (t) => {
  const f = await completedDayFixture(t);
  const usage = accountUsageStub({ upstream: 4 });
  const module = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: usage.stationUsageCost });
  f.rows[1].timezone = "UTC";
  const split = await module.queryRules({}, { accountUsage: true });
  assert.equal(split.commonSummary, null);
  assert.equal(split.unaccountedUpstream ?? null, null);
  assert.equal(usage.calls.length, 0, "没有共同汇总就不读账号用量");
  f.rows[1].timezone = "Asia/Chongqing";
  const aliased = await module.queryRules({}, { accountUsage: true });
  assert.ok(aliased.unaccountedUpstream);
  assert.deepEqual(usage.calls.map((call) => [call.stationId, call.startMs, call.endMs]), [["upstream", Date.parse("2026-10-07T16:00:00Z"), Date.parse("2026-10-08T16:00:00Z")]]);
});

test("3b 实时窗口：各关联截止点不同仍归同一组，共同汇总和账号级对比照常给出", async (t) => {
  let tick = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => (tick += 1) });
  const usage = accountUsageStub({ upstream: 4 });
  const module = createReconciliationModule(f.rt, { repository: f.repository, stationUsageCost: usage.stationUsageCost });
  const today = await module.queryRules({ preset: "today" }, { accountUsage: true });
  assert.equal(today.results.length, 3);
  assert.ok(new Set(today.results.map((row) => row.window.endMs)).size > 1, "截止点逐条不同");
  assert.equal(today.windowGroups.length, 1);
  assert.equal(today.windowGroups[0].window.preset, "today");
  assert.equal(today.windowGroups[0].window.endMs, Math.min(...today.results.map((row) => row.window.endMs)));
  assert.ok(today.commonSummary);
  assert.equal(today.unaccountedUpstream.window.preset, "today");
  assert.deepEqual(usage.calls.map((call) => [call.startMs, call.today]), [[Date.parse("2026-10-08T16:00:00Z"), true]]);
  // 下一次轮询截止点后移，同一预设仍命中账号用量缓存。
  await module.queryRules({ preset: "today" }, { accountUsage: true });
  assert.equal(usage.calls.length, 1);
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
      data: { total: 3, items: f.rows.map((row) => ({ id: row.token_id, user_id: 7, name: row.id === "rr_two" ? "changed-name" : row.token_name, group: "g1", status: 1 })) } }) };
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
  // 汇总只加算出来的绑定（§4）：渠道 3 在自营站点删了、毛利算不出的 rr_three 是需处理，不加，金额留在它自己那一行
  assert.deepEqual([actual.windowGroups[0].totals.knownIncomeUsd, actual.windowGroups[0].totals.attentionRuleIds], [5, ["rr_three"]]);
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
  // 重复的两条是需处理，收入、上游成本、毛利都不加，只剩 rr_three：$2.5 − $1 = $1.5，财务一减就对得上
  assert.deepEqual([actual.windowGroups[0].totals.knownIncomeUsd, actual.windowGroups[0].totals.knownCostUsd, actual.windowGroups[0].totals.confirmedProfitUsd], [2.5, 1, 1.5]);
  assert.deepEqual(actual.windowGroups[0].totals.attentionRuleIds, ["rr_live", "rr_two"]);
  assert.ok([...f.state.snapshots.values()].filter((row) => ["rr_live", "rr_two"].includes(row.rule_id)).every((row) => JSON.parse(row.source).recordType === "observation"));
  f.rows[1].token_id = f.rows[0].token_id; f.rows[1].token_name = f.rows[0].token_name;
  trustedLegacyRule(f.rows[1], f.stations, 7, 1); f.rows[1].source_binding.channels = { 1: "r1" };
  const shared = await f.module.queryRules({}, { force: true });
  // 两条共用一把 Key、还都绑着渠道 1：都是需处理，汇总只剩 rr_three 的上游成本
  assert.equal(shared.windowGroups[0].totals.knownCostUsd, 1);
  assert.deepEqual(shared.windowGroups[0].totals.attentionRuleIds, ["rr_live", "rr_two"]);
  assert.equal(shared.results.find((row) => row.rule.id === "rr_two").upstream.amountUsd, 1, "重复Key的raw成本仍显示，父级counted金额仅一次");
});

test("U05真实旧规则首次安全锚定共享namespace阻断重复成员，首轮不能落confirmed利润", async (t) => {
  const f = await completedDayFixture(t, { channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [3] } });
  for (const row of f.rows) Object.assign(row, { billing_policy: "legacy-v3", canonical_key: null, source_binding: null });
  const before = f.rows.map((row) => [row.id, row.scope_version, row.billing_effective_from_ms]);
  const actual = await f.module.queryRules();
  assert.ok(actual.results.filter((row) => row.rule.id !== "rr_three").every((row) => row.calculation.profitUsd == null && row.health.issues.some((issue) => issue.code === "DUPLICATE_CHANNEL_ASSIGNMENT")));
  assert.equal(actual.windowGroups[0].totals.knownIncomeUsd, 2.5, "重复的两条需处理，不加");
  assert.ok([...f.state.snapshots.values()].filter((row) => row.rule_id !== "rr_three").every((row) => JSON.parse(row.source).recordType === "observation"));
  assert.deepEqual(f.rows.map((row) => [row.id, row.scope_version, row.billing_effective_from_ms]), before, "安全首锚定不推进原范围日期和版本");
});

test("U05实际Shanghai/UTC按绝对窗口分组；同绝对已核验标签可合组，today/custom短窗给实时利润并进入汇总但不写确认账单", async (t) => {
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
  const confirmedCount = () => [...f.state.snapshots.values()].filter((snapshot) => JSON.parse(snapshot.source).recordType === "confirmed").length;
  const confirmedBefore = confirmedCount();
  const today = await f.module.queryRules({ preset: "today" });
  assert.equal(today.windowGroups.length, 1); assert.ok(today.commonSummary, "today 同绝对窗口、覆盖已核验时进入汇总");
  assert.equal(today.windowGroups[0].totals.confirmedProfitUsd, 4.5); assert.equal(today.commonSummary.totals.confirmedProfitUsd, 4.5);
  assert.ok(today.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "live"), "today 给出实时利润，但未结束窗口不结算");
  for (const row of f.rows) Object.assign(row, { billing_policy: "legacy-v3", source_binding: { ...row.source_binding, channels: {} } });
  const custom = await f.module.queryRules({ preset: "custom", startMs: 1000000, endMs: 1060000 }, { force: true });
  assert.equal(custom.results[0].calculation.profitUsd, 1.5, " untouched v3同epoch短区间仍保留原账语义");
  assert.ok(custom.results.every((row) => row.displayStatus.state === "live" && !row.settledAt), "早已结束的非完整日 custom 窗口是已结束，不是已结账");
  assert.ok(custom.commonSummary); assert.equal(custom.windowGroups[0].totals.confirmedProfitUsd, 4.5);
  assert.equal(confirmedCount(), confirmedBefore, "today/custom 短窗只保存 observation，不写确认账单");
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
      // 7 天内系统会自己再读：这天还是「实时」，只提示还没读全，不出「重新读取」的待办（§4、§5.3）
      assert.equal(row.displayStatus.state, "live"); assert.deepEqual(row.displayStatus.hints.map((hint) => hint.text), ["这天的账单还没读全"]);
      assert.equal(row.actions.some((item) => item.kind === "retry_bill"), false);
    }
    assert.equal(late.commonSummary?.totals.confirmedProfitUsd ?? null, null);
    assert.equal(late.coverage.accountedChannelCount, 0);
  }
});

test("U05真实Provider+module DST23/25小时、生效前窗口保留完整请求、不取数并给出scope action", async (t) => {
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
  const callsBefore = f.state.statCalls.length;
  const before = await f.module.queryRules({}, { force: true });
  // 整个窗口早于核算起点：保留原请求窗口，不取数，金额和毛利按 0 计；覆盖范围标为未生效并给出查看生效时间入口。
  assert.ok(before.results.every((row) => row.calculation.profitUsd === 0 && row.window.startMs === Date.parse("2026-10-07T16:00:00Z")
    && row.downstream.amountUsd === 0 && row.upstream.amountUsd === 0 && row.segments.length === 0));
  assert.equal(f.state.statCalls.length, callsBefore, "生效前窗口不向任何一侧取数");
  // 已知成本同样确定为 0：汇总里不能出现“毛利 0、成本未知”的矛盾，也不能写成确认账单。
  assert.ok(before.results.every((row) => row.scope.notEffective === true && row.upstream.knownAmountUsd === 0 && row.upstream.countedAmountUsd === 0 && row.downstream.knownAmountUsd === 0));
  // 整天在开始统计之前的日子（C②）：这条绑定这天不算状态，不加进汇总（收入、上游成本、毛利都不加），不算需处理，也不算还在读取
  assert.ok(before.results.every((row) => row.displayStatus.state === "not_started" && row.displayStatus.label === "还没开始统计"));
  assert.equal(before.windowGroups.length, 1); assert.equal(before.windowGroups[0].totals.knownCostUsd, null);
  assert.deepEqual([before.windowGroups[0].totals.attentionRuleIds, before.windowGroups[0].totals.readingRuleIds], [[], []]);
  assert.equal(before.windowGroups[0].totals.notStartedRuleIds.length, before.results.length);
  assert.equal([...f.state.snapshots.values()].some((snapshot) => JSON.parse(snapshot.source).recordType === "confirmed" && JSON.parse(snapshot.source).window?.endMs === Date.parse("2026-10-08T16:00:00Z")), false);
  const notEffective = before.coverage.channels.find((channel) => channel.channelId === 1);
  assert.equal(notEffective.status, "not_effective"); assert.deepEqual(notEffective.issues, ["BILLING_SCOPE_NOT_EFFECTIVE"]);
  // 还没开始统计不用人处理：渠道写「从 X 开始统计」，不出按钮（§5.6）
  assert.deepEqual(notEffective.actions, []);
});

test("U05轮询结账：昨天结束满15分钟才写昨天整日confirmed，结清后不再取数，无利润10分钟后重试，核算起点不早于昨天结束不结账", async (t) => {
  const f = await completedDayFixture(t);
  const yesterday = { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") }; // 上海 10-08 整日
  let now = yesterday.endMs + 5 * 60000; // 上海 10-09 00:05
  t.mock.method(Date, "now", () => now);
  // rr_two 昨天中午才创建、今天零点才生效：核算起点取较早的创建时刻，昨天仍要结账。
  Object.assign(f.rows[1], { created_at: new Date("2026-10-08T04:00:00Z"), billing_effective_from_ms: yesterday.endMs });
  // rr_three 今天零点才创建并生效：核算起点恰为昨天结束，昨天没有账可结。
  Object.assign(f.rows[2], { created_at: new Date(yesterday.endMs), billing_effective_from_ms: yesterday.endMs });
  const sources = () => [...f.state.snapshots.values()].map((snapshot) => ({ ruleId: snapshot.rule_id, ...JSON.parse(snapshot.source) }));
  // 结账写进账本，快照表只留观测记录。
  const confirmed = () => f.state.ledger.map((row) => ({ ruleId: row.rule_id, ...row.detail }));
  const yesterdayCalls = () => f.state.statCalls.filter((call) => call.end === yesterday.endMs / 1000 - 1).length;
  // 结账状态表（计划 C2a）：没结成的日子一行，结成了就删掉
  const settlements = () => f.repository.tables.settlementState.map((row) => [`${row.rule_id}:${row.bill_date}`, row.retry_reason, row.next_attempt_at_ms]).sort();
  const key = (ruleId) => `${ruleId}:2026-10-08`;

  await f.module.refreshDue(now);
  assert.equal(yesterdayCalls(), 0, "昨天结束未满 15 分钟不结账、不取昨天的数");
  assert.equal(confirmed().length, 0);
  assert.ok(sources().length > 0 && sources().every((source) => source.recordType === "observation" && source.window.startMs === yesterday.endMs), "只观测今天");
  assert.deepEqual(settlements(), []);

  now = yesterday.endMs + 15 * 60000; f.state.upstreamQuota = null; // 刚满 15 分钟，但上游账单还取不到
  await f.module.refreshDue(now);
  assert.equal(yesterdayCalls(), 4, "rr_live/rr_two 两侧各取一次昨天，rr_three 不取");
  assert.equal(confirmed().length, 0, "没有利润不写确认账单");
  assert.deepEqual(settlements(), [[key("rr_live"), "WAITING_FOR_BILL", now + 10 * 60000], [key("rr_two"), "WAITING_FOR_BILL", now + 10 * 60000]]);

  f.state.upstreamQuota = 100;
  now = yesterday.endMs + 24 * 60000 + 59999; // 已过结果缓存期，但未到 10 分钟重试点
  await f.module.refreshDue(now);
  assert.equal(yesterdayCalls(), 4, "未结清的昨天 10 分钟内不重试");
  assert.equal(confirmed().length, 0);

  now = yesterday.endMs + 25 * 60000;
  await f.module.refreshDue(now);
  assert.equal(yesterdayCalls(), 8, "到重试点后重新取昨天");
  assert.deepEqual(confirmed().map((source) => source.ruleId).sort(), ["rr_live", "rr_two"]);
  for (const source of confirmed()) assert.deepEqual(source.window, { preset: "yesterday", ...yesterday, timezone: "Asia/Shanghai" });
  assert.deepEqual(settlements(), [], "结成了，状态行删掉");

  now = yesterday.endMs + 60 * 60000;
  await f.module.refreshDue(now);
  assert.equal(yesterdayCalls(), 8, "已结清的昨天不再取数");
  assert.equal(confirmed().length, 2, "已结清的昨天不再写账本");
  assert.ok(sources().every((source) => source.recordType === "observation"), "快照表只写 observation");
});

test("U05结账等待期：昨天结束未满15分钟手动查询只给实时毛利不写确认，满15分钟轮询不复用该缓存、重新取数后结账", async (t) => {
  const f = await completedDayFixture(t);
  const yesterday = { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") }; // 上海 10-08 整日
  let now = yesterday.endMs + 14 * 60000 + 30000; // 上海 10-09 00:14:30
  t.mock.method(Date, "now", () => now);
  const confirmedRows = () => f.state.ledger;
  const yesterdayCalls = () => f.state.statCalls.filter((call) => call.end === yesterday.endMs / 1000 - 1).length;

  f.state.upstreamQuota = 50; // 上游账单还在陆续入账
  const early = await f.module.queryRules({ preset: "yesterday" });
  assert.ok(early.results.every((row) => row.calculation.profitUsd === 2 && row.displayStatus.state === "live"), "等待期内昨天只是实时金额");
  assert.equal(confirmedRows().length, 0, "等待期内的手动查询不写确认账单");
  const calls = yesterdayCalls();
  assert.equal(calls, 6);

  now = yesterday.endMs + 15 * 60000; f.state.upstreamQuota = 100; // 30 秒后，手动查询的结果仍在缓存期内
  await f.module.refreshDue(now);
  assert.equal(yesterdayCalls(), calls + 6, "结账重新取昨天，不复用等待期的缓存");
  assert.equal(confirmedRows().length, 3);
  assert.ok(confirmedRows().every((row) => row.cost_usd === 1), "结账用的是满 15 分钟后的上游金额");
  const settled = await f.module.queryRules({ preset: "yesterday" });
  assert.ok(settled.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "settled"));
  assert.equal(yesterdayCalls(), calls + 6, "结账结果进入缓存，随后的查询直接复用");
});

test("module修正切换时间在来源锁内改分段并清空缓存：非强制查询重新取数并按新分段核算", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000000, to: 1030000 }, { id: "s2", group: "g2", from: 1030000 }] });
  trustedLegacyRule(f.rule, f.stations, 7, 1);
  const locks = new Store({}), lockedIds = [];
  f.rt.store.withStationLocks = (ids, action) => { lockedIds.push([...new Set(ids)].sort()); return locks.withStationLocks(ids, action); };
  const input = { ruleIds: [f.rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const windows = (result) => result.segments.map((segment) => [segment.id, segment.window.startMs, segment.window.endMs]);
  const first = await f.module.queryRules(input);
  assert.deepEqual(windows(first.results[0]), [["s1", 1000000, 1030000], ["s2", 1030000, 1060000]]);
  const calls = f.state.statCalls.length;
  assert.equal(calls, 4);
  await f.module.queryRules(input);
  assert.equal(f.state.statCalls.length, calls, "修正前非强制查询命中缓存");

  const correction = holdPoint(), repositoryCorrect = f.repository.correctTransition.bind(f.repository);
  f.repository.correctTransition = async (...args) => { await correction.hold(); return repositoryCorrect(...args); };
  const pending = f.module.correctTransition(f.rule.id, "s2", 1045000);
  await correction.reached;
  assert.deepEqual(lockedIds.at(-1), ["own", "upstream"], "修正在两侧站点来源锁内进行");
  let cacheAtEdit = null;
  const edit = f.rt.store.withStationLocks(["upstream"], () => { cacheAtEdit = f.rt._reconciliationResultCache.size; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cacheAtEdit, null, "修正期间站点编辑须等待来源锁");
  correction.release();
  const { segments } = await pending; await edit;
  assert.equal(cacheAtEdit, 0, "释放来源锁前已清空本规则缓存");
  assert.deepEqual(segments.map((segment) => [segment.id, segment.effectiveFrom, segment.effectiveTo, segment.timingSource]),
    [["s1", 1000000, 1045000, "operator_confirmed"], ["s2", 1045000, null, "operator_confirmed"]]);
  // 这条绑定没有开始统计的时刻、建绑定的时刻也读不到：不能判断哪些日子在开始统计之前，按改到的日子都写（有开始统计时刻的见下面的契约测试）
  assert.deepEqual(await requestedDays(f, f.rule.id), ["1970-01-01"]);

  const after = await f.module.queryRules(input);
  assert.equal(f.state.statCalls.length, calls + 4, "修正后非强制查询不能复用旧分段缓存");
  for (const side of ["upstream", "own"]) {
    assert.deepEqual(f.state.statCalls.slice(calls).filter((call) => call.side === side).map((call) => [call.start, call.end]).sort(), [[1000, 1044], [1045, 1059]]);
  }
  assert.deepEqual(windows(after.results[0]), [["s1", 1000000, 1045000], ["s2", 1045000, 1060000]]);
  assert.equal(after.results[0].currentSegment.effectiveFrom, 1045000);
  assert.equal(after.results[0].calculation.profitUsd, 3);
});

test("U05真实withAuth GET/POST默认昨日、显式today实时利润、局部body与覆盖action完整透传", async (t) => {
  const f = await completedDayFixture(t);
  f.rt.reconciliation = f.module; // 路由复用夹具模块，从而读写同一个内存 repository
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
    // 显式 today 透传实时利润：进入汇总，但每行都是未结账的 live。
    const today = await (await get("?preset=today")).json(); assert.ok(today.commonSummary);
    assert.equal(today.results[0].window.endMs, Date.now()); assert.equal(today.windowGroups[0].totals.confirmedProfitUsd, 4.5);
    assert.ok(today.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "live"));
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
    const result = await moduleWithDifferentActualWindow(f.rt, { repository: f.repository }).queryRules();
    for (const row of result.results) {
      assert.equal(row.upstream.amountUsd, 1); assert.equal(row.downstream.amountUsd, 2.5);
      assert.equal(row.upstream.window.endMs, row.window.endMs - 1000);
      assert.equal(row.segments[0].upstream.window.endMs, row.window.endMs - 1000);
      assert.equal(row.billingTimezone.state, "unverified"); assert.equal(row.calculation.profitUsd, null);
      assert.ok(row.health.issues.some((issue) => issue.code === "BILLING_WINDOW_MISMATCH"));
    }
    assert.equal(result.commonSummary, null); assert.equal(result.coverage.accountedChannelCount, 0);
    // 窗口对不上的都没算出来，三个数都不加
    assert.deepEqual([result.windowGroups[0].totals.knownIncomeUsd, result.windowGroups[0].totals.knownCostUsd, result.windowGroups[0].totals.confirmedProfitUsd], [null, null, null]);
    assert.deepEqual(result.windowGroups[0].totals.attentionRuleIds, ["rr_live", "rr_two", "rr_three"]);
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
  // 没回答完的两条是需处理，不加：只剩 rr_three，$2.5 − $1 = $1.5（原来收入写 $7.5、毛利写 $1.5，一减对不上）
  assert.deepEqual([actual.windowGroups[0].totals.knownIncomeUsd, actual.windowGroups[0].totals.knownCostUsd, actual.windowGroups[0].totals.confirmedProfitUsd], [2.5, 1, 1.5]);
  assert.deepEqual(actual.windowGroups[0].totals.attentionRuleIds, ["rr_live", "rr_two"]);
  assert.equal(actual.windowGroups[0].totals.profitComplete, false);
});

function upstreamReadFixture(t, type = "newapi") {
  // 显式 Key 核验只读写账单能力表（核验结果要在重启后仍有效），不碰其他表。
  const capabilities = new Map();
  const pool = { async query(sql, params = []) {
    if (!sql.includes("reconciliation_billing_capabilities")) assert.fail("Key read must not access SQL");
    if (sql.startsWith("SELECT")) return [capabilities.has(params[0]) ? [{ capability: capabilities.get(params[0]) }] : []];
    if (sql.startsWith("INSERT")) capabilities.set(params[0], params[1]);
    else if (sql.includes("WHERE identity")) for (const identity of Array.isArray(params[0]) ? params[0] : [params[0]]) capabilities.delete(identity);
    return [{ affectedRows: 1 }];
  }, async getConnection() { assert.fail("Key read must not save"); } };
  const store = new Store(pool);
  store._metaSecrets.billing_identity_key = "upstream-read-fixture-billing-key";
  store.data.auth = { isDefault: false };
  store.data.stations = [{ id: "resource", type, name: "Old account", baseUrl: `https://u06-${type}-${t.name.length}.test`,
    accessToken: "saved-secret", authVersion: 1, monitorEnabled: false,
    ...(type === "sub2api-password" ? { email: "old@example.test", password: "saved-password",
      s2Tokens: { accessToken: "stored-auto-jwt", refreshToken: "stored-auto-refresh", expiresAt: 1 } } : {}) }];
  const state = { requests: [], accountId: 42, selfCount: 0, cost: 3.25, quota: 0, directoryError: false, missingAmount: false, onRequest: null, identityAt: null };
  const reply = (status, data) => ({ status, text: async () => JSON.stringify(type === "newapi"
    ? { success: status < 300, data, message: status >= 300 ? "permission denied Bearer raw-secret" : undefined }
    : { code: status >= 300 ? status : 0, data, message: status >= 300 ? "permission denied Bearer raw-secret" : undefined }) });
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input)); state.requests.push({ url, authorization: init.headers?.Authorization });
    await state.onRequest?.(url);
    if (["/api/user/self", "/api/v1/auth/me"].includes(url.pathname)) {
      state.selfCount += 1;
      return reply(200, { id: state.identityAt?.(state.selfCount) ?? state.accountId, password: "raw-secret" });
    }
    if (url.pathname === "/api/status") return reply(200, { quota_per_unit: 100, version: "deployment-v1" });
    if (url.pathname === "/api/user/self/groups") return reply(200, { g: { ratio: 1 } });
    if (url.pathname === "/api/token/") return state.directoryError ? reply(403, null)
      : reply(200, { total: 1, items: [{ id: 9, user_id: init.headers?.["New-Api-User"], name: "actual-key", status: 1, group: "g", key: "raw-call-secret" }] });
    if (url.pathname === "/api/log/self/stat") return reply(200, { quota: state.quota, accessToken: "raw-secret" });
    if (url.pathname === "/api/v1/settings/public") return reply(200, { turnstile_enabled: false });
    if (url.pathname === "/api/v1/auth/login") return reply(200, { access_token: "fresh-auto-jwt", refresh_token: "fresh-auto-refresh", expires_in: 3600 });
    if (url.pathname === "/api/v1/keys") return state.directoryError ? reply(403, null)
      : reply(200, { total: 1, items: [{ id: 9, user_id: state.accountId, name: "actual-key", status: "active", group_id: null, key: "raw-call-secret" }] });
    if (url.pathname.startsWith("/api/v1/keys/")) return reply(404, null);
    if (url.pathname === "/api/v1/usage/stats") {
      if (url.searchParams.get("api_key_id") !== "9") return reply(404, null);
      const future = Date.parse(url.searchParams.get("start_date")) > Date.now();
      return reply(200, state.missingAmount ? { total_cost: 19 } : { total_actual_cost: future ? 0 : state.cost, total_cost: 19, accessToken: "raw-secret" });
    }
    assert.fail(`Unexpected Key read: ${url.pathname}`);
  });
  const rt = { store, pool, sessions: { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 } };
  const module = rt.reconciliation = createReconciliationModule(rt);
  return { rt, module, store, state, station: store.get("resource") };
}

test("U06实际NewAPI Key读取：默认旧目录不加身份请求，explicit actual identity/zero/probe白名单且零写", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-09T03:00:00Z"));
  const f = upstreamReadFixture(t), before = structuredClone(f.store.data);
  const original = await f.module.getUpstreamKeys("resource");
  assert.equal(f.state.selfCount, 1, "默认只沿原metadata路径，不加独立accountprobe");
  assert.equal(original.identity, null); assert.equal(original.probe, null); assert.equal(original.version, "deployment-v1");
  const verified = await f.module.getUpstreamKeys("resource", { force: true });
  assert.equal(f.state.selfCount, 3, "force使用独立actual身份，再与metadata身份核对");
  assert.deepEqual(verified.identity, { provider: "newapi", baseUrl: f.station.baseUrl, accountId: "42" });
  assert.equal(verified.resourceVersion, original.resourceVersion); assert.equal(verified.probe, null);
  const selected = await f.module.getUpstreamKeys("resource", { tokenId: "9", timezone: "Etc/UTC" });
  assert.equal(f.state.selfCount, 5, "显式选Key即使force=false仍走actual身份核验");
  assert.deepEqual(selected.probe.window, { startMs: Date.parse("2026-10-08T00:00:00Z"), endMs: Date.parse("2026-10-09T00:00:00Z"), timezone: "UTC" });
  assert.deepEqual([selected.probe.amountUsd, selected.probe.knownAmountUsd, selected.probe.quotaUnits, selected.probe.actualCostUsd], [0, 0, 0, null]);
  assert.equal(selected.probe.currency, "USD"); assert.equal(selected.probe.complete, true); assert.equal(selected.version, "deployment-v1");
  assert.deepEqual(Object.keys(selected.probe).sort(), ["tokenId", "state", "complete", "window", "currency", "amountUsd", "knownAmountUsd", "actualCostUsd", "quotaUnits", "quotaPerUnit", "capability", "billingTimezone"].sort());
  const stat = f.state.requests.find(({ url }) => url.pathname === "/api/log/self/stat").url;
  assert.equal(stat.searchParams.get("token_name"), "actual-key"); assert.equal(stat.searchParams.get("end_timestamp"), String(selected.probe.window.endMs / 1000 - 1));
  await assert.rejects(f.module.getUpstreamKeys("resource", { tokenId: 99 }), (error) => error.code === "INVALID_REQUEST");
  assert.equal(f.state.requests.filter(({ url }) => url.pathname === "/api/log/self/stat").length, 1, "仅目录中的实际选Key可调用stat");
  assert.doesNotMatch(JSON.stringify(selected), /raw-|saved-secret|accessToken|password|maskedKey|observedAt/);
  assert.deepEqual(f.store.data, before);
});

test("U06实际目录权限失败：仅force无Key安全partial，default仍原错误、selectedKey拒绝", async (t) => {
  const f = upstreamReadFixture(t), before = structuredClone(f.store.data); f.state.directoryError = true;
  await assert.rejects(f.module.getUpstreamKeys("resource"), (error) => error.code === "UPSTREAM_AUTH_DENIED");
  const partial = await f.module.getUpstreamKeys("resource", { force: true, timezone: "UTC" });
  assert.equal(partial.identity.accountId, "42"); assert.equal(partial.probe, null);
  assert.deepEqual([partial.quotaPerUnit, partial.version, partial.groups, partial.tokens], [null, "", {}, []]);
  assert.equal(partial.capability.reason, "KEY_METADATA_UNAVAILABLE");
  assert.deepEqual(partial.billingTimezone, { state: "unverified", timezone: "UTC", reason: "KEY_METADATA_UNAVAILABLE" });
  await assert.rejects(f.module.getUpstreamKeys("resource", { tokenId: 9 }), (error) => error.code === "KEY_METADATA_UNAVAILABLE" && !error.message.includes("raw-secret"));
  assert.deepEqual(f.store.data, before);
});

test("U06非法zone/token、own/pureKey不触发accountprobe；存userId不能冒充actual身份", async (t) => {
  const f = upstreamReadFixture(t);
  for (const options of [{ timezone: "invalid/zone" }, { timezone: "" }, ...[0, -1, 1.5, "", " 9", "9e0", true, Number.MAX_SAFE_INTEGER + 1].map((tokenId) => ({ tokenId }))]) {
    await assert.rejects(f.module.getUpstreamKeys("resource", options), (error) => error.code === "INVALID_REQUEST");
  }
  for (const patch of [{ type: "newapi-key" }, { type: "newapi", isOwn: true }]) {
    Object.assign(f.station, patch);
    await assert.rejects(f.module.getUpstreamKeys("resource", { force: true, tokenId: 9 }), { code: "UPSTREAM_NOT_FOUND" });
  }
  assert.equal(f.state.requests.length, 0);
  Object.assign(f.station, { type: "newapi", isOwn: false, userId: 7 });
  await assert.rejects(f.module.getUpstreamKeys("resource", { force: true }), (error) => error.code === "KEY_PROBE_UNAVAILABLE");
  assert.equal(f.station.userId, 7); assert.equal(f.station.verifiedIdentity, undefined);
  assert.equal(f.state.requests.length, 1, "actual 42与存7不同，不能借存身份继续目录/统计");
});

test("U06 actual identity/metadata冲突与每个await业务版本漂移均拒绝，零SQL/身份回填", async (t) => {
  for (const phase of ["identity", "metadata", "stat", "crosscheck"]) await t.test(phase, async (child) => {
    const f = upstreamReadFixture(child);
    if (phase === "crosscheck") f.state.identityAt = (count) => count === 1 ? 42 : 43;
    else f.state.onRequest = (url) => {
      const expected = { identity: "/api/user/self", metadata: "/api/token/", stat: "/api/log/self/stat" }[phase];
      if (url.pathname === expected) { f.station.monitorEnabled = true; f.state.onRequest = null; }
    };
    await assert.rejects(f.module.getUpstreamKeys("resource", { force: true, tokenId: 9 }), (error) => error.code === "RESOURCE_CHANGED");
    assert.equal(f.station.verifiedIdentity, undefined);
    if (phase !== "stat") assert.equal(f.state.requests.some(({ url }) => url.pathname === "/api/log/self/stat"), false);
  });
});

test("U06实际Sub2API selectedKey保留3.25/0/unknown与Key-date能力，zone独立核验且共享JWT不写", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-09T03:00:00Z"));
  const f = upstreamReadFixture(t, "sub2api-password"), before = structuredClone(f.store.data);
  const first = await f.module.getUpstreamKeys("resource", { tokenId: 9 });
  assert.equal(first.identity.accountId, "42"); assert.equal(first.probe.capability.state, "supported");
  assert.deepEqual([first.probe.amountUsd, first.probe.knownAmountUsd, first.probe.actualCostUsd], [3.25, 3.25, 3.25]);
  assert.deepEqual(first.probe.billingTimezone, { state: "verified", timezone: "Asia/Shanghai" });
  f.state.cost = 0;
  const zero = await f.module.getUpstreamKeys("resource", { tokenId: 9 });
  assert.deepEqual([zero.probe.amountUsd, zero.probe.knownAmountUsd, zero.probe.actualCostUsd], [0, 0, 0]);
  const otherZone = await f.module.getUpstreamKeys("resource", { tokenId: 9, timezone: "UTC" });
  assert.deepEqual([otherZone.probe.complete, otherZone.probe.amountUsd, otherZone.probe.knownAmountUsd], [false, null, 0]);
  f.state.missingAmount = true;
  const unknown = await f.module.getUpstreamKeys("resource", { tokenId: 9 });
  assert.deepEqual([unknown.probe.amountUsd, unknown.probe.knownAmountUsd, unknown.probe.actualCostUsd], [null, null, null]);
  assert.equal(unknown.probe.capability.state, "unsupported");
  assert.doesNotMatch(JSON.stringify([first, zero, otherZone, unknown]), /raw-|saved-password|fresh-auto|stored-auto|accessToken/);
  assert.deepEqual(f.store.data, before);
});

test("U06真实withAuth keys GET：登录/zone/token/drift400、原default500、selected503与force精确参数", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-09T03:00:00Z"));
  t.mock.method(console, "error", () => {});
  const f = upstreamReadFixture(t), { registerHooks } = await import("node:module");
  globalThis.__u06KeysRuntime = f.rt;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "next/server") return { url: "test:u06-keys-next", shortCircuit: true };
    if (specifier.endsWith("/runtime.js")) return { url: "test:u06-keys-runtime", shortCircuit: true };
    if (specifier.endsWith("/lib/api.js")) return { url: new URL(`${specifier}?u06-keys-auth`, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === "test:u06-keys-next") return { format: "module", shortCircuit: true, source: "export const NextResponse={json:(value,init)=>Response.json(value,init)};" };
    if (url === "test:u06-keys-runtime") return { format: "module", shortCircuit: true, source: "export const getRuntime=async()=>globalThis.__u06KeysRuntime;" };
    return next(url, context);
  } });
  try {
    const { GET } = await import("../app/api/reconciliation/upstreams/[id]/keys/route.js?u06-keys");
    const get = (suffix = "", authenticated = true) => GET(new Request(`http://localhost/api/reconciliation/upstreams/resource/keys${suffix}`,
      { headers: authenticated ? { cookie: "rm_session=valid" } : {} }), { params: Promise.resolve({ id: "resource" }) });
    assert.equal((await get("", false)).status, 401); assert.equal(f.state.requests.length, 0);
    for (const suffix of ["?timezone=", "?timezone=invalid", "?tokenId=0", "?tokenId=9e0", "?tokenId=9007199254740992"]) {
      const response = await get(suffix); assert.equal(response.status, 400); assert.equal((await response.json()).code, "INVALID_REQUEST");
    }
    assert.equal(f.state.requests.length, 0);
    const old = await (await get("?force=TRUE")).json(); assert.equal(old.identity, null); assert.equal(old.probe, null);
    assert.equal(f.state.selfCount, 1, "force只接受原exact true");
    const ready = await get("?force=true&tokenId=9&timezone=UTC"); assert.equal(ready.status, 200);
    const body = await ready.json(); assert.equal(body.identity.accountId, "42"); assert.equal(body.probe.amountUsd, 0);
    assert.equal(body.probe.window.timezone, "UTC"); assert.match(body.resourceVersion, /^[a-f0-9]{64}$/);
    assert.equal(body.version, "deployment-v1"); assert.doesNotMatch(JSON.stringify(body), /raw-|saved-secret|accessToken|password/);
    f.state.quota = null;
    const statError = await get("?tokenId=9"); assert.equal(statError.status, 503);
    assert.deepEqual(await statError.json(), { error: "上游暂时读不到，请稍后再试", code: "KEY_PROBE_UNAVAILABLE", retryable: true });
    f.state.quota = 0;
    f.state.directoryError = true; f.rt._reconciliationMetadataCache.clear();
    // 没兜住的 500 带上原报错的码，界面按码归类（lib/api.js）
    const oldError = await get(); assert.equal(oldError.status, 500); const oldBody = await oldError.json();
    assert.deepEqual(Object.keys(oldBody), ["error", "code"]); assert.equal(oldBody.code, "UPSTREAM_AUTH_DENIED");
    assert.doesNotMatch(oldBody.error, /raw-secret/);
    const selectedError = await get("?tokenId=9"); assert.equal(selectedError.status, 503);
    assert.deepEqual(await selectedError.json(), { error: "读不到这个上游的 Key 列表", code: "KEY_METADATA_UNAVAILABLE", retryable: true });
    const partial = await get("?force=true"); assert.equal(partial.status, 200); assert.equal((await partial.json()).capability.reason, "KEY_METADATA_UNAVAILABLE");
    f.state.directoryError = false; f.state.onRequest = () => { f.station.authVersion += 1; f.state.onRequest = null; };
    const changed = await get("?force=true"); assert.equal(changed.status, 400); assert.equal((await changed.json()).code, "RESOURCE_CHANGED");
    assert.equal(f.station.verifiedIdentity, undefined);
  } finally { hooks.deregister(); delete globalThis.__u06KeysRuntime; }
});

test("1b页面查询只读：昨天和今天都给出毛利，但不开写事务、不查告警状态、不写渠道状态", async (t) => {
  const f = await completedDayFixture(t);
  const page = (preset) => f.module.queryRules({ preset }, { mode: "evaluate", origin: "page" });
  const yesterday = await page("yesterday");
  // 页面查询不结账：结账账本里还没有昨天，昨天仍是「实时」，旧的 settlement 字段写已结束
  assert.ok(yesterday.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "live" && !row.settledAt));
  const today = await page("today");
  assert.ok(today.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "live"));
  assert.deepEqual(f.state.commits.map((tx) => tx.name), [], "页面查询不开写事务");
  assert.deepEqual([f.state.writes, f.state.alertQueries, f.state.channelStateWrites.length, f.state.snapshots.size], [0, 0, 0, 0]);
});

test("1b已结账的昨天：页面查询直接读结账记录不再取数，上游事后变动不影响；重启后也以结账记录为准", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.refreshDue(Date.now());
  assert.equal(f.state.ledger.length, 3, "轮询结掉昨天");
  f.rt._reconciliationResultCache.clear();
  const calls = f.state.statCalls.length, writes = f.state.writes, ledgerWrites = f.state.ledgerWrites.length;
  f.state.upstreamQuota = 50; // 上游事后又补了账，已结账的日子不跟着变
  const page = await f.module.queryRules({ preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.equal(f.state.statCalls.length, calls, "已结账的昨天不打上游");
  assert.ok(page.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "settled" && row.settledAt && row.lastConfirmed));
  const queried = await f.module.queryRules({ preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" });
  assert.equal(f.state.statCalls.length, calls, "「查询」跳过缓存也不重新取已结账的日子");
  assert.ok(queried.results.every((row) => row.calculation.profitUsd === 1.5 && row.settledAt));

  // 重启后内存缓存都没了；来源口径由接入模块持久化，开头就能认出结账记录，不必取数。
  const restarted = { pool: f.rt.pool, store: f.rt.store, onboardingSource: f.rt.onboardingSource };
  const again = await createReconciliationModule(restarted, { repository: f.repository }).queryRules({ preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.ok(again.results.every((row) => row.calculation.profitUsd === 1.5 && row.displayStatus.state === "settled" && row.settledAt));
  assert.equal(f.state.statCalls.length, calls, "重启后也不打上游");
  assert.equal(f.state.writes, writes, "页面查询不追加任何快照");
  assert.equal(f.state.ledgerWrites.length, ledgerWrites, "也不写账本");
});

test("固定账读取失败只影响该规则：不把失败当无账重新取数，不缓存失败，重试恢复原账", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.refreshDue(Date.now());
  f.rt._reconciliationResultCache.clear();
  const ledger = structuredClone(f.state.ledger), calls = f.state.statCalls.length, writes = f.state.writes;
  f.state.upstreamQuota = 50; // 上游事后补记的金额不能替代固定账。
  const latest = f.repository.latestLedgerEntry.bind(f.repository);
  let failing = true;
  t.mock.method(f.repository, "latestLedgerEntry", async (ruleId, ...args) => {
    if (ruleId === "rr_live" && failing) throw new Error("temporary SELECT failure: raw-secret");
    return latest(ruleId, ...args);
  });
  for (const mode of ["evaluate", "observe"]) {
    const response = await f.module.queryRules({ preset: "yesterday" }, { mode, force: true });
    const failed = response.results.find((row) => row.rule.id === "rr_live");
    assert.equal(failed.health.code, "HISTORY_UNAVAILABLE");
    assert.deepEqual([failed.calculation.profitUsd, failed.upstream.knownAmountUsd, failed.downstream.knownAmountUsd], [null, null, null]);
    assert.ok(response.results.filter((row) => row.rule.id !== "rr_live").every((row) => row.settledAt && row.calculation.profitUsd === 1.5));
    assert.doesNotMatch(JSON.stringify(response), /raw-secret|temporary SELECT/);
    assert.ok([...f.rt._reconciliationResultCache].every(([key]) => !key.startsWith("rr_live:")), "读取失败不进入结果缓存");
  }
  assert.equal(f.state.statCalls.length, calls, "固定账读取失败也不重新获取两侧财务金额");
  assert.equal(f.state.writes, writes);
  assert.deepEqual(f.state.ledger, ledger);
  failing = false;
  const recovered = (await f.module.queryRules({ preset: "yesterday", ruleIds: ["rr_live"] }, { mode: "evaluate" })).results[0];
  assert.deepEqual([recovered.health.code, recovered.calculation.profitUsd, recovered.ledger.revision], ["READY", 1.5, 1]);
  assert.equal(f.state.statCalls.length, calls);
});

test("旧多日固定快照保留原来源，读取失败也不降级为上游重新计算", async (t) => {
  const f = await completedDayFixture(t);
  const input = { preset: "custom", ruleIds: ["rr_live"], startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") };
  const settled = (await f.module.queryRules(input, { mode: "observe", force: true })).results[0];
  assert.ok(settled.settledAt);
  f.rt._reconciliationResultCache.clear();
  f.stations.find((station) => station.id === "own").userId = "2";
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/user/self") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { id: 2 } }) };
    }
    return fetch(input, init);
  });
  const original = (await f.module.queryRules(input, { mode: "evaluate", force: true })).results[0];
  assert.deepEqual(original.ownSource, settled.ownSource, "旧快照也保留保存时账号");
  const calls = f.state.statCalls.length, writes = f.state.writes;
  t.mock.method(f.repository, "latestSettlement", async () => { throw new Error("old snapshot SELECT failed"); });
  const failed = (await f.module.queryRules(input, { mode: "evaluate", force: true })).results[0];
  assert.equal(failed.health.code, "HISTORY_UNAVAILABLE");
  assert.equal(failed.calculation.profitUsd, null);
  assert.equal(f.state.statCalls.length, calls);
  assert.equal(f.state.writes, writes);
});

test("固定账存在但内容无法读取时保持不可用，不按没有账重新取数", async (t) => {
  const f = await completedDayFixture(t);
  const input = { preset: "yesterday", ruleIds: ["rr_live"] };
  await f.module.queryRules(input, { mode: "observe", force: true });
  f.repository.tables.ledger[0].detail = "{}";
  const calls = f.state.statCalls.length, writes = f.state.writes;
  const failed = (await f.module.queryRules(input, { mode: "evaluate", force: true })).results[0];
  assert.deepEqual([failed.health.code, failed.calculation.profitUsd], ["HISTORY_UNAVAILABLE", null]);
  assert.equal(f.state.statCalls.length, calls);
  assert.equal(f.state.writes, writes);
});

test("换本站账号后固定账保留原来源：新旧来源分组，旧收入不并入当前账号", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.queryRules({ preset: "yesterday", ruleIds: ["rr_live"] }, { mode: "observe", force: true });
  const saved = structuredClone(f.state.ledger), source = saved[0].detail.result.ownSource;
  const store = new Store(f.rt.pool);
  store.data.stations = f.stations;
  f.rt.store = store;
  await store.update("own", { accessToken: "replacement-account-pat", userId: "2" });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/user/self") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { id: 2 } }) };
    }
    return fetch(input, init);
  });
  for (const mode of ["evaluate", "observe"]) {
    const response = await f.module.queryRules({ preset: "yesterday" }, { mode, force: true });
    const fixed = response.results.find((row) => row.rule.id === "rr_live");
    assert.deepEqual(fixed.ownSource, source);
    assert.deepEqual(fixed.rule.ownSource, source);
    assert.deepEqual([fixed.health.code, fixed.calculation.profitUsd, fixed.ledger.revision], ["READY", 1.5, 1]);
    assert.equal(response.windowGroups.length, 2);
    const oldGroup = response.windowGroups.find((group) => group.ownSource?.namespaceKey === source.namespaceKey);
    const newGroup = response.windowGroups.find((group) => group.ownSource?.accountId === "2");
    assert.deepEqual(oldGroup.ruleIds, ["rr_live"]);
    assert.equal(oldGroup.totals.knownIncomeUsd, 2.5);
    assert.ok(newGroup && !newGroup.ruleIds.includes("rr_live"));
    assert.equal(response.commonSummary, null, "不同账号的财务事实不能形成共同汇总");
  }
  assert.deepEqual(f.state.ledger, saved);
});

test("缺原始来源的固定账保持未知，不借当前身份生成共同汇总", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.queryRules({ preset: "yesterday", ruleIds: ["rr_live"] }, { mode: "observe", force: true });
  const entry = f.repository.tables.ledger[0], detail = JSON.parse(entry.detail);
  delete detail.result.ownSource;
  delete detail.ruleEvidence.ownSource;
  delete detail.scopePolicy.ownSource;
  entry.detail = JSON.stringify(detail);
  f.rt._reconciliationResultCache.clear();
  const response = await f.module.queryRules({ preset: "yesterday", ruleIds: ["rr_live"] }, { mode: "evaluate", force: true });
  assert.equal(response.results[0].calculation.profitUsd, 1.5);
  assert.equal(response.results[0].ownSource, null);
  assert.equal(response.commonSummary, null);
});

test("1b单个自然日只认账本：快照表里迁移没搬的旧确认记录（窗口结束不满15分钟写下）不算结账，只读查询重新取数", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.refreshDue(Date.now());
  // 1a 之前窗口一结束就写确认记录，迁移不搬这种早写的记录：把账本行挪回快照表、改成早写的样子。
  for (const row of f.repository.tables.ledger.splice(0)) {
    const source = { ...JSON.parse(row.detail), recordType: "confirmed" };
    source.resultGeneratedAt = source.result.generatedAt = "2026-10-08T16:05:00.000Z";
    await f.repository.saveSnapshot({ ruleId: row.rule_id, snapshotKey: `legacy-${row.rule_id}`, windowKind: "yesterday",
      startMs: row.window_start_ms, endMs: row.window_end_ms, healthCode: source.result.health.code, source });
  }
  f.rt._reconciliationResultCache.clear();
  const calls = f.state.statCalls.length;
  f.state.upstreamQuota = 50;
  const page = await f.module.queryRules({ preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.ok(f.state.statCalls.length > calls, "早写的记录不当结账记录，重新取数");
  assert.ok(page.results.every((row) => !row.settledAt && row.calculation.profitUsd !== 1.5));
});

const COMPLETED_YESTERDAY = { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") }; // completedDayFixture 的上海 10-08 整日
const confirmedRows = (f) => f.state.ledger;
const yesterdayStatCalls = (f) => f.state.statCalls.filter((call) => call.end === COMPLETED_YESTERDAY.endMs / 1000 - 1).length;

test("结账后改关联、换查账凭据：已结账的昨天查询和刷新都沿用结账记录，轮询也不再结一次账", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.refreshDue(Date.now());
  assert.equal(confirmedRows(f).length, 3);
  f.rows[0].scope_version = 2; // 编辑关联会升口径版本，口径指纹随之变化
  Object.assign(f.stations[0], { accessToken: "rotated-pat", authVersion: 2 }); // 换了上游查账凭据
  f.rt._reconciliationResultCache.clear();
  const calls = yesterdayStatCalls(f), rows = confirmedRows(f).length;
  f.state.upstreamQuota = 50; // 上游事后变动也不影响已结账的日子
  for (const mode of ["evaluate", "observe"]) {
    const { results } = await f.module.queryRules({ preset: "yesterday" }, { mode, force: true, origin: "manual" });
    assert.ok(results.every((row) => row.calculation.profitUsd === 1.5 && row.settledAt), `${mode}: ${JSON.stringify(results.map((row) => row.health))}`);
  }
  await f.module.refreshDue(Date.now());
  assert.equal(yesterdayStatCalls(f), calls, "账本里已经有昨天：轮询不再取数");
  assert.equal(confirmedRows(f).length, rows, "不按新口径再写一版账");
  assert.deepEqual(f.repository.tables.settlementState, []);
});

test("重启后轮询认出已有结账记录：不重新取昨天、不再结一次账", async (t) => {
  const f = await completedDayFixture(t);
  await f.module.refreshDue(Date.now());
  const calls = yesterdayStatCalls(f), writes = f.state.writes;
  const rt = { pool: f.rt.pool, store: f.rt.store, onboardingSource: f.rt.onboardingSource };
  await createReconciliationModule(rt, { repository: f.repository }).refreshDue(Date.now());
  assert.equal(yesterdayStatCalls(f), calls);
  assert.equal(confirmedRows(f).length, 3);
  assert.deepEqual(f.state.ledgerWrites.map((entry) => [entry.revision, entry.source]), Array(3).fill([1, "settle"]), `writes ${writes} -> ${f.state.writes}`);
  assert.deepEqual(f.repository.tables.settlementState, [], "重启以后靠账本认出已经结过，不靠内存");
});

test("昨天结账 READY 不动告警：今天的告警不被清掉", async (t) => {
  const f = await completedDayFixture(t);
  const todayStart = COMPLETED_YESTERDAY.endMs / 1000;
  const oldFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    // 今天的上游账单取不到，昨天的正常。
    if (url.pathname === "/api/log/self/stat" && Number(url.searchParams.get("start_timestamp")) === todayStart) {
      return { status: 500, text: async () => JSON.stringify({ success: false }) };
    }
    return oldFetch(input, init);
  });
  await f.module.refreshDue(Date.now());
  assert.equal(confirmedRows(f).length, 3, "昨天照常结账");
  const alerts = f.repository.log.alertCalls;
  assert.ok(alerts.some((call) => call.method === "setAlertState" && call.next.active), JSON.stringify(alerts));
  assert.deepEqual(alerts.filter((call) => call.method === "clearActiveAlerts"), [], "昨天结账 READY 不能清掉今天的告警");
});

test("修正切换时间后下一轮轮询重新结账昨天，以新结账记录为准，之后不再重复取数", async (t) => {
  const transition = Date.parse("2026-10-08T04:00:00Z"); // 昨天中午切换
  const f = await completedDayFixture(t, { segments: [{ id: "s1", group: "g1", from: 0, to: transition }, { id: "s2", group: "g1", from: transition }] });
  let now = Date.parse("2026-10-09T03:00:00Z");
  t.mock.method(Date, "now", () => now);
  await f.module.refreshDue(now);
  const yesterday = async () => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate" })).results[0];
  const before = await yesterday();
  assert.ok(before.settledAt);

  await f.module.correctTransition("rr_live", "s2", transition - 3600000);
  assert.deepEqual(await requestedDays(f), ["2026-10-08"], "改到的昨天写了一条重结请求（在状态表里，不在内存里）");
  assert.equal((await yesterday()).settledAt, before.settledAt, "重新结账之前仍是原来的结账");
  f.state.upstreamQuota = 50;
  now += 60000;
  const calls = yesterdayStatCalls(f), rows = confirmedRows(f).length;
  await f.module.refreshDue(now);
  assert.ok(yesterdayStatCalls(f) > calls, "重新结账要重新取昨天");
  assert.equal(confirmedRows(f).length, rows + 1, "按新分段写下一版账");
  assert.deepEqual(f.state.ledgerWrites.at(-1), { ruleId: "rr_live", billDate: "2026-10-08", revision: 2, source: "resettle" });
  assert.deepEqual(await requestedDays(f), [], "结成了，请求办完（在写账本的事务里消费）");
  const after = await yesterday();
  assert.ok(after.settledAt > before.settledAt, "以新结账记录为准");
  assert.equal(after.upstream.amountUsd, before.upstream.amountUsd / 2);

  now += 60000;
  const settledCalls = yesterdayStatCalls(f);
  await f.module.refreshDue(now);
  assert.equal(yesterdayStatCalls(f), settledCalls, "重新结账完成后不再取昨天");
});

// 换一个 rt、同一个仓库：当作进程重启（内存里的缓存、退避都没了，库里的东西还在）
const restartedModule = (f, moduleOptions = {}) => {
  const rt = Object.fromEntries(Object.entries(f.rt).filter(([key]) => !key.startsWith("_reconciliation")));
  return createReconciliationModule(rt, { repository: f.repository, ...moduleOptions });
};

test("C2b 改切换时间：落到的每个已结束的业务日各写一条请求，进程重启（换一个 rt）后轮询照样把它们都重结，办完请求清掉", async (t) => {
  const transition = Date.parse("2026-10-07T04:00:00Z"); // 上海 10-07 中午切换
  const moduleOptions = { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 };
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions, segments: [{ id: "s1", group: "g1", from: 0, to: transition }, { id: "s2", group: "g1", from: transition }] });
  var now = Date.parse("2026-10-09T03:00:00Z");
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.module.refreshDue(now);
  const booked = () => f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => [row.bill_date, row.revision]).sort();
  assert.deepEqual(booked(), [["2026-10-07", 1], ["2026-10-08", 1]], "前提：两天都结了第 1 版");
  // 切换时间往后改到 10-08 20:00（上海）：10-07 中午到 10-08 晚上，落到 10-07、10-08 两天，各一条请求
  await f.module.correctTransition("rr_live", "s2", Date.parse("2026-10-08T12:00:00Z"));
  assert.deepEqual(await requestedDays(f), ["2026-10-07", "2026-10-08"]);
  const requests = (await f.repository.listSettlementStates(["rr_live"])).map((row) => [row.billDate, row.resettleReason]);
  assert.deepEqual(requests, [["2026-10-07", "transition"], ["2026-10-08", "transition"]]);
  // 重启：内存里什么都没有了，请求在状态表里
  const restarted = restartedModule(f, moduleOptions);
  f.state.upstreamQuota = 50;
  now += 60000;
  await restarted.refreshDue(now);
  assert.deepEqual(booked(), [["2026-10-07", 1], ["2026-10-07", 2], ["2026-10-08", 1], ["2026-10-08", 2]], "两天都按新分段写了第 2 版");
  assert.deepEqual(f.state.ledgerWrites.slice(-2).map((write) => write.source), ["resettle", "resettle"]);
  assert.deepEqual(await requestedDays(f), [], "办完了，请求清掉");
  // 之后不再重结
  const calls = f.state.statCalls.length;
  now += 60000;
  await restarted.refreshDue(now);
  assert.equal(f.state.statCalls.filter((call) => call.start < Date.parse("2026-10-08T16:00:00Z") / 1000).length, f.state.statCalls.slice(0, calls).filter((call) => call.start < Date.parse("2026-10-08T16:00:00Z") / 1000).length, "办完以后不再取过去的日子");
});

test("C2b 重结请求不受 7 天回看限制（改的时间可能在很久以前）；请求提出满 7 天还没结成就放弃，不再自动试", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-08-31T16:00:00Z"); }
  const start = (day) => Date.parse(`${day}T00:00:00+08:00`) / 1000;
  const touched = (day) => f.state.statCalls.some((call) => call.start === start(day));
  // 09-20 离今天 19 天，在 7 天回看以外；请求是昨天提的：照样去结
  await f.repository.requestResettle("rr_live", ["2026-09-20"], { now: now - 24 * 3600000 });
  await f.module.refreshDue(now);
  assert.ok(touched("2026-09-20"), "回看范围以外、有请求的日子也去结");
  assert.ok(f.state.ledger.some((row) => row.rule_id === "rr_live" && row.bill_date === "2026-09-20"));
  assert.deepEqual(await requestedDays(f), [], "结成了，请求办完");
  // 09-21 的请求是 8 天前提的：放弃，不取，状态行留着等清理
  f.state.statCalls.length = 0;
  await f.repository.requestResettle("rr_live", ["2026-09-21"], { now: now - 8 * 24 * 3600000 });
  now += 60000;
  await f.module.refreshDue(now);
  assert.equal(touched("2026-09-21"), false, "请求满 7 天放弃");
  assert.equal(f.state.ledger.some((row) => row.bill_date === "2026-09-21"), false);
  assert.deepEqual(await requestedDays(f), ["2026-09-21"]);
  // 页面上这天标成需处理（R6）：放弃了的请求，现在显示的还是改之前的数
  const gaveUp = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: start("2026-09-21") * 1000, endMs: start("2026-09-22") * 1000 }, { mode: "evaluate", origin: "page" })).results[0].displayStatus;
  assert.deepEqual([gaveUp.state, gaveUp.title, gaveUp.action.kind], ["action", "改了时间的这天没重算成", "retry_bill"]);
  // 7 天以内的请求（还在试）不标
  await f.repository.requestResettle("rr_live", ["2026-09-22"], { now: now - 24 * 3600000 });
  await f.module.refreshDue(now);
  const trying = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: start("2026-09-22") * 1000, endMs: start("2026-09-23") * 1000 }, { mode: "evaluate", origin: "page" })).results[0].displayStatus;
  assert.notEqual(trying.state, "action");
});

test("C2b 取数期间又来了新的重结请求：这次结成的只办完它读到的那一条，新请求留着，下一轮再重结", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  let injected = false;
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0 },
    onRequest: async (request) => {
      if (!injected && request.host === "upstream.test" && request.path === "/api/log/self/stat" && await requestedDays(f).then((days) => days.length)) {
        injected = true;
        await f.repository.requestResettle("rr_live", ["2026-10-08"], { now: now + 5 });
      }
    } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.module.refreshDue(now);
  const rev = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => row.revision);
  assert.deepEqual(rev(), [1]);
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  f.state.upstreamQuota = 50;
  now += 60000;
  await f.module.refreshDue(now);
  assert.equal(injected, true);
  assert.deepEqual(rev(), [1, 2], "这一次按读到的请求重结了");
  assert.deepEqual(await requestedDays(f), ["2026-10-08"], "取数期间提的新请求没被这次吃掉");
  f.state.upstreamQuota = 60;
  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(rev(), [1, 2, 3], "下一轮按新请求再重结一次");
  assert.deepEqual(await requestedDays(f), []);
});

test("C2b 中-1：重结用账本里记下的汇率和成本计法，不用现在的设置：只改汇率、读数没变，重结不写新版；读数变了写新版，新版的汇率等于旧版", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const [upstream, own] = f.stations;
  upstream.cnyPerUsd = 7.2; own.cnyPerUsd = 7.1;
  await f.module.refreshDue(now);
  const revisions = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => [row.revision, Number(row.cost_rate), Number(row.revenue_rate)]);
  assert.deepEqual(revisions(), [[1, 7.2, 7.1]], "前提：第 1 版记下当时的汇率");
  // 现在的设置变了，读数没变：改时间只该重算分段影响的金额，汇率不跟着换，内容相同就不写新版
  upstream.cnyPerUsd = 6.6; own.cnyPerUsd = 6.5;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(revisions(), [[1, 7.2, 7.1]], "只改了汇率：重结不写新版");
  assert.deepEqual(await requestedDays(f), [], "请求办完了");
  // 读数变了：写新版，汇率还是当时记下的
  f.state.upstreamQuota = 80;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(revisions(), [[1, 7.2, 7.1], [2, 7.2, 7.1]], "新版的汇率等于旧版");
});

test("C2b 总指挥定的 2：改了绑定以后（C2a 的 blocked 生效），改时间写的重结请求也照样挡，回看不自动结，用户点「重新读取」才结", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const OLDER = { startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: Date.parse("2026-10-07T16:00:00Z") }; // 10-07
  const liveLedger = () => ledgerDays(f).filter((row) => row[0] === "rr_live").map((row) => row[1]).sort();
  f.state.upstreamQuota = null;
  await f.module.refreshDue(now);
  const row = f.repository.tables.rules.find((r) => r.id === "rr_live");
  row.created_at = new Date("2026-10-01T00:00:00Z");
  row.scope_version = Number(row.scope_version || 1) + 1;
  row.billing_effective_from_ms = now; // 改了绑定：10-07 在这个时刻以前，回看不自动结
  f.state.upstreamQuota = 100;
  now += 10 * 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(liveLedger(), ["2026-10-08"], "前提：昨天结了，10-07 被 blocked 挡着");
  // 改时间落到 10-07：写了请求，回看照样不结
  await f.repository.requestResettle("rr_live", ["2026-10-07"], { now });
  assert.deepEqual(await requestedDays(f), ["2026-10-07"]);
  now += 60000;
  const calls = f.state.statCalls.length;
  await f.module.refreshDue(now);
  assert.deepEqual(liveLedger(), ["2026-10-08"], "有请求也不绕过 blocked");
  assert.deepEqual(await requestedDays(f), ["2026-10-07"], "请求留着");
  assert.equal(f.state.statCalls.slice(calls).filter((call) => call.start === OLDER.startMs / 1000).length, 0, "也没取这天的账单");
  // 手动「重新读取」能结，请求跟着办完
  const manual = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: OLDER.startMs, endMs: OLDER.endMs }, { mode: "observe", force: true, origin: "manual" });
  assert.ok(manual.results[0].settledAt);
  assert.deepEqual(liveLedger(), ["2026-10-07", "2026-10-08"]);
  assert.deepEqual(await requestedDays(f), []);
});

test("C2b 总指挥定的 3：改的时间落到 31 天以前的日子不写请求，记一条要人处理的状态行（RESETTLE_TOO_OLD），回看不自动重结；31 天以内的照常写请求、重结，账本明细记 transition；点「重新读取」才重结更早的", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const transition = Date.parse("2026-09-20T04:00:00Z"); // 19 天前
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 20, lookbackTimeMs: 60000 },
    segments: [{ id: "s1", group: "g1", from: 0, to: transition }, { id: "s2", group: "g1", from: transition }] });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-07-31T16:00:00Z"); }
  // 改到 40 天前（8 月 30 日）：[8/30 12:00, 9/20 12:00) 落到 8/30…9/20 这些天
  const corrected = await f.module.correctTransition("rr_live", "s2", Date.parse("2026-08-30T04:00:00Z"));
  assert.equal(corrected.segments.length, 2, "返回新的分段");
  // 提示要说清哪几天没自动重算：会自动重算的天数、太早的日期（从早到晚）
  assert.deepEqual([corrected.resettle.tooOld[0], corrected.resettle.tooOld.at(-1), corrected.resettle.recent], ["2026-08-30", "2026-09-07", 13]);
  const rows = await f.repository.listSettlementStates(["rr_live"]);
  const tooOld = rows.filter((row) => row.manualReason === "RESETTLE_TOO_OLD").map((row) => row.billDate);
  const recent = rows.filter((row) => row.manualReason == null).map((row) => row.billDate);
  assert.ok(tooOld.length > 0 && recent.length > 0);
  assert.equal(tooOld.at(-1), "2026-09-07", "8 月 30 日到 9 月 7 日整天结束已经在 31 天以前");
  assert.equal(recent[0], "2026-09-08");
  assert.ok(rows.every((row) => row.resettleRequestedAt != null && row.resettleReason === "transition"), "请求都记在行里（不然已固定的清理会把行删掉）");
  // 轮询：31 天以内的结了（detail 记 transition），更早的不取、状态行留着
  f.state.statCalls.length = 0;
  await f.module.refreshDue(now);
  const dayStart = (day) => Date.parse(`${day}T00:00:00+08:00`) / 1000;
  assert.ok(recent.every((day) => f.state.statCalls.some((call) => call.start === dayStart(day))), "31 天以内的都去结了");
  assert.equal(tooOld.some((day) => f.state.statCalls.some((call) => call.start === dayStart(day))), false, "更早的不自动重结");
  assert.deepEqual((await f.repository.listSettlementStates(["rr_live"])).map((row) => row.billDate), tooOld, "更早的行还在，等人确认");
  assert.ok(f.state.ledger.filter((row) => row.rule_id === "rr_live" && recent.includes(row.bill_date)).every((row) => row.detail.settlement.trigger === "transition"), "账本明细的 trigger 是 transition，不是 late");
  // 用户点「重新读取」：就是人确认，结了，行跟着删
  const day = tooOld.at(-1);
  const startMs = Date.parse(`${day}T00:00:00+08:00`);
  const manual = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs, endMs: startMs + 86400000 }, { mode: "observe", force: true, origin: "manual" });
  assert.ok(manual.results[0].settledAt);
  assert.equal((await f.repository.listSettlementStates(["rr_live"])).some((row) => row.billDate === day), false);
});

test("C2b 总指挥定的 3（明显少就不写）：重结读出来的收入比账本最新一版少一半以上（旧值至少 0.5 美元）不写新版，记 RESETTLE_SHRUNK 等人确认，页面仍是旧数、不自动再试；手动「重新读取」确认以后才覆盖", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.module.refreshDue(now); // 本站 250 → 收入 2.5 美元，上游 100 → 成本 1 美元
  const revisions = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => [row.revision, Number(row.revenue_usd), Number(row.cost_usd)]);
  assert.deepEqual(revisions(), [[1, 2.5, 1]], "前提");
  const resettle = async () => { await f.repository.requestResettle("rr_live", ["2026-10-08"], { now }); now += 60000; await f.module.refreshDue(now); };
  const state = async () => (await f.repository.listSettlementStates(["rr_live"])).find((row) => row.billDate === "2026-10-08");
  // 本站读出来是 0（日志过了保留期之类）：不写新版，记要人处理的状态行，请求保留
  f.state.ownQuota = 0;
  await resettle();
  assert.deepEqual(revisions(), [[1, 2.5, 1]], "不写新版");
  const blocked = await state();
  assert.deepEqual([blocked.manualReason, blocked.resettleRequestedAt != null, blocked.nextAttemptAt], ["RESETTLE_SHRUNK", true, null], "要人处理、请求还在、不自动再试");
  assert.deepEqual(blocked.detail?.shrunk, { side: "revenue", before: { revenueUsd: 2.5, costUsd: 1 }, after: { revenueUsd: 0, costUsd: 1 } },
    "状态行记下少的是收入，原来和重算的收入、上游成本各多少（确认框直接读，不用再去上游读）");
  const page = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.equal(page.results[0].calculation.profitUsd, 1.5, "页面仍是已固定的旧数");
  // 页面上这天标成需处理，说明里写少的是收入，确认框要的原来 / 重算的数也在里面
  const status = page.results[0].displayStatus;
  assert.deepEqual([status.state, status.title, status.action.kind, status.shrunk], ["action", "这天重算的数比原来少了一半多", "retry_bill",
    { side: "revenue", before: { revenueUsd: 2.5, costUsd: 1 }, after: { revenueUsd: 0, costUsd: 1 } }]);
  assert.match(status.detail, /^重算出来的收入不到原来的一半/);
  // 账本里还是原来固定的数：单日汇总照算（和多天一致），毛利照显示，只多一句提示
  const heldPage = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.deepEqual([heldPage.commonSummary.totals.confirmedProfitUsd, heldPage.commonSummary.totals.attentionRuleIds, heldPage.commonSummary.totals.heldRuleIds], [1.5, [], ["rr_live"]]);
  const week = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs + 1 }, { mode: "evaluate", origin: "page" });
  void week;
  // 之后的轮询不再自动取这天
  const calls = f.state.statCalls.length;
  now += 3 * 3600000;
  await f.module.refreshDue(now);
  assert.equal(f.state.statCalls.slice(calls).filter((call) => call.end === COMPLETED_YESTERDAY.endMs / 1000 - 1).length, 0, "不自动再试");
  // 手动「重新读取」没有确认（页面通用的按钮，C3 的确认框还没做）：照样先挡着，不覆盖
  f.state.ownQuota = 0;
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual" });
  assert.deepEqual(revisions(), [[1, 2.5, 1]], "没确认：不写新版");
  assert.equal((await state()).manualReason, "RESETTLE_SHRUNK", "仍是要人处理");
  // 明说确认了（C3 确认框点「重新读取」会传 confirmShrink）：覆盖
  f.state.ownQuota = 0;
  const manual = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual", confirmShrink: true, confirmedAfter: (await state()).detail.shrunk.after });
  assert.ok(manual.results[0].settledAt);
  assert.equal(revisions().at(-1)[1], 0, "手动确认以后写了新版（收入 0）");
  assert.equal(await state(), undefined, "状态行删了");
});

test("C2b 设计的确认：改了时间太早没自动重算的日子（RESETTLE_TOO_OLD），点「重新读取」读出来的数要是又比原来少了一半多，照样先挡下记 RESETTLE_SHRUNK，不直接换掉", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-08-31T16:00:00Z"); }
  // 10-07 先结好一版（收入 2.5、成本 1）
  await f.module.refreshDue(now);
  await f.repository.requestResettle("rr_live", ["2026-10-07"], { now: now - 1 });
  // 把这天标成「太早没自动重算」（改时间落在 31 天以前时写的行；这里直接造一条同样的行）
  await f.repository.requestResettle("rr_live", ["2026-10-07"], { now, manualReason: "RESETTLE_TOO_OLD" });
  const ledger = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-07").map((row) => [row.revision, Number(row.revenue_usd)]);
  const before = ledger();
  const dayQuery = { ruleIds: ["rr_live"], preset: "custom", startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: Date.parse("2026-10-07T16:00:00Z") };
  // 页面上这天标成需处理：太早没自动重算，现在显示的还是改之前的数
  const noticed = (await f.module.queryRules(dayQuery, { mode: "evaluate", origin: "page" })).results[0].displayStatus;
  assert.deepEqual([noticed.state, noticed.title, noticed.action.kind], ["action", "改了时间的这天太早，没自动重算", "retry_bill"]);
  const manual = () => f.module.queryRules(dayQuery, { mode: "observe", force: true, origin: "manual" });
  f.state.ownQuota = 0;
  await manual();
  assert.deepEqual(ledger(), before, "又少了一半多：没写新版");
  const row = (await f.repository.listSettlementStates(["rr_live"])).find((item) => item.billDate === "2026-10-07");
  assert.equal(row.manualReason, "RESETTLE_SHRUNK");
  // 这时用户在确认框点了「重新读取」（传 confirmShrink）：RESETTLE_SHRUNK 的日子照读到的数覆盖
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: Date.parse("2026-10-07T16:00:00Z") }, { mode: "observe", force: true, origin: "manual", confirmShrink: true, confirmedAfter: row.detail.shrunk.after });
  assert.equal(ledger().at(-1)[1], 0, "确认以后写了新版");
  assert.equal((await f.repository.listSettlementStates(["rr_live"])).some((item) => item.billDate === "2026-10-07"), false);
});

test("C2b 审核二轮中-1：有重结请求的日子遇到要人处理的原因，原因没了以后本地重判写得进状态行，下一轮就重结", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  let keyStatus = 1;
  const f = await completedDayFixture(t, { clock: () => now });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/token/") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 3, items: [
        { id: 9, user_id: 7, name: "stable", status: keyStatus, group: "g1", cross_group_retry: false },
        { id: 10, user_id: 7, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
        { id: 11, user_id: 7, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } }) };
    }
    return prev(input, init);
  });
  const revisions = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => row.revision);
  const state = () => f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  await f.module.refreshDue(now);
  assert.deepEqual(revisions(), [1], "前提：这天已经固定");
  // 改了时间提了请求，这时 Key 被停用：要人处理，请求留在行里
  keyStatus = 2;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  await f.module.refreshDue(now);
  assert.equal(state()?.manual_reason, "KEY_INVALID_OR_DENIED");
  assert.ok(state().resettle_requested_at_ms != null, "请求还在");
  // 人把 Key 启用了：到点本地重判，原因没了——这一步要写得进状态行（有请求的行）
  keyStatus = 1;
  now += 10 * 60000;
  await f.module.refreshDue(now);
  assert.equal(state()?.last_detail?.cleared, true, "原因没了，写进状态行");
  now += 60000;
  f.state.ownQuota = 300; // 重结读到的数和原来不一样，才会写新的一版
  await f.module.refreshDue(now);
  assert.deepEqual(revisions(), [1, 2], "下一轮重结，不再卡着");
  assert.equal(state(), undefined, "请求办完，行删掉");
});

test("C2b 审核二轮中-2：RESETTLE_TOO_OLD 的日子手动读取没结成不丢「太早」标记，轮询不会去自动重结它；普通请求日手动读取读出来少了一半多也先挡下", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-08-31T16:00:00Z"); }
  await f.module.refreshDue(now);
  const ledger = (day) => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === day).map((row) => [row.revision, Number(row.revenue_usd)]);
  const row = (day) => f.repository.tables.settlementState.find((item) => item.rule_id === "rr_live" && item.bill_date === day);
  const manual = (day, extra = {}) => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: Date.parse(`${day}T00:00:00+08:00`), endMs: Date.parse(`${day}T00:00:00+08:00`) + 86400000 }, { mode: "observe", force: true, origin: "manual", ...extra });
  const day = "2026-10-07";
  await f.repository.requestResettle("rr_live", [day], { now, manualReason: "RESETTLE_TOO_OLD" });
  const before = ledger(day);
  // 手动读取没结成（上游 500）：行不动，仍是「太早」
  let upstreamStatus = 500;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (upstreamStatus && url.host === "upstream.test" && url.pathname === "/api/log/self/stat") return { status: upstreamStatus, text: async () => JSON.stringify({ success: false, message: "x" }) };
    return prev(input, init);
  });
  await manual(day);
  assert.equal(row(day)?.manual_reason, "RESETTLE_TOO_OLD", "标记还在");
  assert.deepEqual(ledger(day), before);
  // 轮询不会去自动重结它
  now += 3600000;
  upstreamStatus = 0;
  await f.module.refreshDue(now);
  assert.deepEqual(ledger(day), before, "没有自动重结");
  assert.equal(row(day)?.manual_reason, "RESETTLE_TOO_OLD");
  // 普通请求日：手动读取读出来少了一半多，先挡下（不再是「手动就是确认」）
  const plain = "2026-10-08";
  await f.repository.requestResettle("rr_live", [plain], { now });
  const plainBefore = ledger(plain);
  f.state.ownQuota = 0;
  await manual(plain);
  assert.deepEqual(ledger(plain), plainBefore, "少了一半多：没写新版");
  assert.equal(row(plain)?.manual_reason, "RESETTLE_SHRUNK");
});

test("C3 审核要总指挥定 2：SHRUNK 确认时再读到的数和确认框里写的「重算」不一样，再挡一次、记下新的数；一样才写", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-08-31T16:00:00Z"); }
  await f.module.refreshDue(now); // 10-08 固定：收入 2.5、成本 1
  const ledger = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => Number(row.revenue_usd));
  const state = async () => (await f.repository.listSettlementStates(["rr_live"])).find((row) => row.billDate === "2026-10-08");
  const confirm = (after) => f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual", confirmShrink: true, confirmedAfter: after });
  f.state.ownQuota = 0; // 重算出来收入 0
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual" }); // 先挡下：框里会写重算 $0
  assert.deepEqual((await state()).detail.shrunk.after, { revenueUsd: 0, costUsd: 1 });
  // 确认框写的是 $0，再读到的是 $1.2：不一样，再挡一次，状态行换成新的数
  f.state.ownQuota = 120;
  await confirm({ revenueUsd: 0, costUsd: 1 });
  assert.deepEqual(ledger(), [2.5], "没写新版");
  const again = await state();
  assert.equal(again.manualReason, "RESETTLE_SHRUNK");
  assert.deepEqual(again.detail.shrunk.after, { revenueUsd: 1.2, costUsd: 1 }, "记下新的数，框里下次写它");
  // 这次框里写的就是 $1.2，再读到的还是 $1.2：写
  await confirm({ revenueUsd: 1.2, costUsd: 1 });
  assert.deepEqual(ledger(), [2.5, 1.2]);
  assert.equal(await state(), undefined);
});

test("C3 审核二轮中-3：确认请求不带 confirmedAfter（直接调接口）也再挡一次，不直接写", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-08-31T16:00:00Z"); }
  await f.module.refreshDue(now);
  const ledger = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => Number(row.revenue_usd));
  f.state.ownQuota = 0;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual" });
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual", confirmShrink: true });
  assert.deepEqual(ledger(), [2.5], "没带确认框里的数：不写");
  const row = (await f.repository.listSettlementStates(["rr_live"])).find((item) => item.billDate === "2026-10-08");
  assert.equal(row.manualReason, "RESETTLE_SHRUNK");
});

test("C3 审核 C2b 低-A：确认参数误传给普通请求日或 RESETTLE_TOO_OLD 的日子，照样判「少了一半多」先挡下，只有状态行是 RESETTLE_SHRUNK 的那天才跳过", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) { row.enabled = row.id === "rr_live" ? 1 : 0; row.billing_effective_from_ms = Date.parse("2026-08-31T16:00:00Z"); }
  await f.module.refreshDue(now); // 10-08 固定：收入 2.5、成本 1
  const ledger = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => Number(row.revenue_usd));
  const state = async () => (await f.repository.listSettlementStates(["rr_live"])).find((row) => row.billDate === "2026-10-08");
  const read = async () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual", confirmShrink: true, confirmedAfter: (await state())?.detail?.shrunk?.after ?? { revenueUsd: 0, costUsd: 1 } });
  f.state.ownQuota = 0;
  // 普通请求日（行里没有 RESETTLE_SHRUNK）
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  await read();
  assert.deepEqual(ledger(), [2.5], "没写新版");
  assert.equal((await state()).manualReason, "RESETTLE_SHRUNK", "挡下，记成要人处理");
  // RESETTLE_TOO_OLD 的日子
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now: now + 1, manualReason: "RESETTLE_TOO_OLD" });
  await read();
  assert.deepEqual(ledger(), [2.5]);
  assert.equal((await state()).manualReason, "RESETTLE_SHRUNK");
  // 这时状态行是 RESETTLE_SHRUNK：带确认才覆盖（确认框写的数和再读到的一样）
  await read();
  assert.deepEqual(ledger(), [2.5, 0], "状态行是 RESETTLE_SHRUNK、带了确认：照读到的数固定");
});

test("C2b 总指挥定的 3：旧值小于 0.5 美元的不判「明显少」（零头不误伤）；少 30% 的照常写新版", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  f.state.ownQuota = 40; f.state.upstreamQuota = 20; // 收入 0.4、成本 0.2：都小于 0.5
  await f.module.refreshDue(now);
  const revisions = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => row.revision);
  assert.deepEqual(revisions(), [1]);
  f.state.ownQuota = 0;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(revisions(), [1, 2], "旧值太小，不判明显少，照常写");
  // 旧值 2.5：少 30%（收入 1.75）照常写
  f.state.ownQuota = 250; f.state.upstreamQuota = 100;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  await f.module.refreshDue(now);
  f.state.ownQuota = 175;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  await f.module.refreshDue(now);
  assert.equal(revisions().length, 4, "少 30% 照常写新版");
});

test("C3 解除绑定以后补结解除前的日子：New API 解除当天账本行是整天窗口、金额只算到解除那一刻，解除以后的日子不结，也不再观测今天", async (t) => {
  const archivedAt = Date.parse("2026-10-08T06:30:00Z"); // 上海 10-08 14:30
  let now = archivedAt;
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.module.archiveRule("rr_live");
  assert.equal((await f.repository.getRule("rr_live", { includeArchived: true })).archivedAtMs, archivedAt, "解除时刻按毫秒存");
  const calls = f.state.statCalls.length, todayBefore = f.repository.log.snapshotWrites.length;
  now = Date.parse("2026-10-09T03:00:00Z"); // 上海 10-09 11:00：10-08 已过完
  await f.module.refreshDue(now);
  const days = () => [...new Set(f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date))].sort();
  assert.deepEqual(days(), ["2026-10-07", "2026-10-08"], "解除前的整天和解除当天都固定了，解除以后的 10-09 不结");
  // 解除当天：账本行窗口仍是整天，取数只取到解除那一刻
  const row = f.state.ledger.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.deepEqual([Number(row.window_start_ms), Number(row.window_end_ms)], [COMPLETED_YESTERDAY.startMs, COMPLETED_YESTERDAY.endMs]);
  const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
  assert.equal(detail.result.scope.accountedToMs, archivedAt, "明细记统计到解除那一刻");
  const archiveDayCalls = f.state.statCalls.slice(calls).filter((call) => call.start === COMPLETED_YESTERDAY.startMs / 1000);
  assert.ok(archiveDayCalls.length > 0 && archiveDayCalls.every((call) => call.end === archivedAt / 1000 - 1), JSON.stringify(archiveDayCalls));
  const fullDayCalls = f.state.statCalls.slice(calls).filter((call) => call.start === (COMPLETED_YESTERDAY.startMs - 86400000) / 1000);
  assert.ok(fullDayCalls.length > 0 && fullDayCalls.every((call) => call.end === COMPLETED_YESTERDAY.startMs / 1000 - 1), "解除前的整天取整天");
  assert.equal(f.repository.log.snapshotWrites.length, todayBefore, "已解除的不写「今天」快照");
  // 以前的每日记录里：解除当天记着统计到解除那一刻，解除前的整天没有
  const { records } = await f.module.getConfirmedHistory("rr_live", { startMs: COMPLETED_YESTERDAY.startMs - 2 * 86400000, endMs: COMPLETED_YESTERDAY.endMs });
  assert.deepEqual(records.map((record) => [record.billDate, record.accountedToMs]).sort(), [["2026-10-07", null], ["2026-10-08", archivedAt]]);
  assert.ok(records.every((record) => record.accountingStartMs === Date.parse("2026-10-06T16:00:00Z")), "开始统计是开始那天的 0 点");
  // 再过一轮：账本里已有、没有新的事
  const written = f.state.ledgerWrites.length;
  now += 600000;
  await f.module.refreshDue(now);
  assert.equal(f.state.ledgerWrites.length, written);
  assert.deepEqual(await f.repository.listSettlementStates(["rr_live"]), []);
});

test("C3 审核中-1：已解除的绑定补结时，同一段时间里别的绑定也占着同一个渠道就挡住（不重复算收入）；隔天才绑上的不挡", async (t) => {
  const archivedAt = Date.parse("2026-10-08T06:30:00Z"); // 上海 10-08 14:30 解除
  let now = archivedAt;
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [3] }, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  const effective = (id, at) => { f.rows.find((row) => row.id === id).billing_effective_from_ms = Date.parse(at); };
  effective("rr_live", "2026-10-06T16:00:00Z"); effective("rr_two", "2026-10-06T16:00:00Z"); // 10-07 起两条同时占着渠道 1
  await f.module.archiveRule("rr_live");
  now = Date.parse("2026-10-09T03:00:00Z");
  await f.module.refreshDue(now);
  const days = (id) => [...new Set(f.state.ledger.filter((row) => row.rule_id === id).map((row) => row.bill_date))].sort();
  assert.deepEqual(days("rr_live"), [], "同一时段还有别的绑定占着渠道 1：已解除的这条不补结，收入不算两遍");
  const state = (await f.repository.listSettlementStates(["rr_live"])).find((row) => row.billDate === "2026-10-07");
  assert.equal(state?.manualReason, "DUPLICATE_CHANNEL_ASSIGNMENT", "记成要人处理");
});

test("C3 用户 10-26 + 审核对拍 S4a：当天解除又绑回同一渠道，新绑定从解除那一刻起算，旧绑定那天照结，两条加起来正好一整天（不重叠、不挡）", async (t) => {
  const archivedAt = Date.parse("2026-10-08T06:30:00Z"); // 上海 10-08 14:30 解除
  let now = archivedAt;
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [3] }, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  const row = (id) => f.rows.find((item) => item.id === id);
  row("rr_live").billing_effective_from_ms = Date.parse("2026-10-06T16:00:00Z");
  row("rr_two").billing_effective_from_ms = archivedAt + 1800000; // 15:00 绑上
  row("rr_two").accounting_floor_ms = archivedAt;                // 建的时候仓库算出的下限（同一天更早解除了占着渠道 1 的 New API 绑定）
  await f.module.archiveRule("rr_live");
  now = Date.parse("2026-10-09T03:00:00Z");
  await f.module.refreshDue(now);
  const ledgerOf = (id, day) => f.state.ledger.find((item) => item.rule_id === id && item.bill_date === day);
  assert.ok(ledgerOf("rr_live", "2026-10-08"), "旧绑定那天照结（算到 14:30）");
  assert.ok(ledgerOf("rr_two", "2026-10-08"), "新绑定那天也结");
  const detail = (item) => (typeof item.detail === "string" ? JSON.parse(item.detail) : item.detail).result.scope;
  assert.equal(detail(ledgerOf("rr_live", "2026-10-08")).accountedToMs, archivedAt);
  assert.equal(detail(ledgerOf("rr_two", "2026-10-08")).accountedFromMs, archivedAt, "新绑定从旧的解除那一刻起算");
  const stat = f.state.statCalls.filter((call) => call.start === COMPLETED_YESTERDAY.startMs / 1000 || call.start === archivedAt / 1000);
  assert.ok(stat.some((call) => call.end === archivedAt / 1000 - 1) && stat.some((call) => call.start === archivedAt / 1000), "两段取数首尾相接，不重叠");
  assert.equal((await f.repository.listSettlementStates(["rr_live"])).length, 0, "没有被挡");
});

test("C3 审核二轮中-1：当天换绑两次（A→B→C），每条都按自己的核算起点判，不互相挡，三段首尾相接", async (t) => {
  const a = Date.parse("2026-10-08T02:00:00Z"), b = Date.parse("2026-10-08T06:00:00Z"); // 上海 10:00 和 14:00 换绑
  let now = b;
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [1] }, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 1 : 0;
  const row = (id) => f.rows.find((item) => item.id === id);
  row("rr_live").billing_effective_from_ms = Date.parse("2026-10-06T16:00:00Z");
  row("rr_two").billing_effective_from_ms = a + 60000; row("rr_two").accounting_floor_ms = a; row("rr_two").archived_at = new Date(b); row("rr_two").archived_at_ms = b; row("rr_two").enabled = 0; row("rr_two").canonical_key = row("rr_two").canonical_key;
  row("rr_live").archived_at = new Date(a); row("rr_live").archived_at_ms = a; row("rr_live").enabled = 0;
  row("rr_three").billing_effective_from_ms = b + 60000; row("rr_three").accounting_floor_ms = b;
  now = Date.parse("2026-10-09T03:00:00Z");
  await f.module.refreshDue(now);
  const days = (id) => f.state.ledger.filter((item) => item.rule_id === id && item.bill_date === "2026-10-08").length;
  assert.deepEqual(["rr_live", "rr_two", "rr_three"].map(days), [1, 1, 1], "三条都结了，没有被挡");
  assert.equal((await f.repository.listSettlementStates(["rr_live", "rr_two"])).length, 0);
});

test("C3 审核中-1：别的绑定是解除以后才占上这个渠道的（隔天绑上），已解除的照常补结", async (t) => {
  const archivedAt = Date.parse("2026-10-08T06:30:00Z");
  let now = archivedAt;
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1], rr_two: [1], rr_three: [3] }, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  f.rows.find((row) => row.id === "rr_live").billing_effective_from_ms = Date.parse("2026-10-06T16:00:00Z");
  f.rows.find((row) => row.id === "rr_two").billing_effective_from_ms = Date.parse("2026-10-08T16:00:00Z"); // 10-09 0:00 才开始，在解除以后
  await f.module.archiveRule("rr_live");
  now = Date.parse("2026-10-09T03:00:00Z");
  await f.module.refreshDue(now);
  assert.deepEqual([...new Set(f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date))].sort(), ["2026-10-07", "2026-10-08"]);
});

test("C3 Sub2API 上游解除当天不结（只能按整天读），解除前的整天照结", async (t) => {
  let now = Date.parse("2026-10-10T06:30:00Z"); // 上海 10-10 14:30 解除
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-archive.test", costs: { "2026-10-08": 2, "2026-10-09": 2, "2026-10-10": 2 }, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  Object.assign(f.rule, { billing_effective_from_ms: Date.parse("2026-10-07T16:00:00Z"), provider: "sub2api" });
  f.rule.canonical_key = canonicalBillingKey(f.stations[0], { platform: "sub2api", accountId: 7 }, f.rule.token_id);
  await f.module.queryRules(f.today, { force: true }); // 解除前页面刷新过一次：核验过账单能力（落库），以后补结不用再核验
  await f.module.archiveRule(f.rule.id);
  now = Date.parse("2026-10-11T01:00:00Z"); // 上海 10-11 09:00
  const statsBefore = f.sub2.stats.length;
  await f.module.refreshDue(now);
  assert.deepEqual([...new Set(f.state.ledger.map((row) => row.bill_date))].sort(), ["2026-10-08", "2026-10-09"], "解除当天 10-10 不结");
  const asked = f.sub2.stats.slice(statsBefore).filter((stat) => stat.api_key_id === "9").map((stat) => stat.start_date);
  assert.ok(!asked.includes("2026-10-10"), "解除当天连账单都不取");
});

test("C3 审核二轮中-2（总指挥定）：当天从 New API 换绑到 Sub2API，新绑定那天收入从旧绑定解除那一刻起算，上游成本取这把 Key 全天的；明细标「上游按整天」", async (t) => {
  const floor = Date.parse("2026-10-10T06:30:00Z"); // 上海 10-10 14:30 换绑
  let now = floor + 3600000;
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-swap.test", costs: { "2026-10-10": 2 }, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  Object.assign(f.rule, { billing_effective_from_ms: floor + 60000, accounting_floor_ms: floor, provider: "sub2api" });
  f.rule.canonical_key = canonicalBillingKey(f.stations[0], { platform: "sub2api", accountId: 7 }, f.rule.token_id);
  await f.module.queryRules(f.today, { force: true }); // 核验账单能力
  now = Date.parse("2026-10-11T01:00:00Z");
  const own = f.state.statCalls.length, up = f.sub2.stats.length;
  await f.module.refreshDue(now);
  const row = f.state.ledger.find((item) => item.bill_date === "2026-10-10");
  assert.ok(row, "那天结了");
  const scope = (typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail).result.scope;
  assert.deepEqual([scope.accountedFromMs, scope.upstreamWholeDay], [floor, true]);
  assert.ok(f.state.statCalls.slice(own).some((call) => call.start === floor / 1000), "本站收入从换绑那一刻起取");
  assert.ok(f.sub2.stats.slice(up).some((stat) => stat.api_key_id === "9" && stat.start_date === "2026-10-10"), "上游按整天取");
});

test("K1c：一段里有几把 Key，上游成本是各取一次再相加（一把在目录里、一把已删按名字取）；分段没带 Key 或只有绑定自己那把时和原来逐字相同", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const live = f.rows.find((row) => row.id === "rr_live");
  const costOf = () => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").map((row) => Number(row.cost_usd));
  // 分段表里有绑定自己那一把 Key：和没有 Key 行时一样
  const segment = f.repository.tables.segments.find((row) => row.rule_id === "rr_live" && row.effective_to_ms == null);
  f.repository.tables.segmentKeys.push({ segment_id: segment.id, upstream_station_id: live.upstream_station_id, token_id: live.token_id, token_name: live.token_name, key_mask: null, match_source: "initial", active_token_key: null });
  await f.module.refreshDue(now);
  assert.deepEqual(costOf(), [1], "一把 Key：上游成本 1（额度 100 ÷ 100）");
  // 再加一把已经从目录里删掉的 Key（按名字取，每把各取一次）：成本相加
  f.repository.tables.segmentKeys.push({ segment_id: segment.id, upstream_station_id: live.upstream_station_id, token_id: 77, token_name: "gone-key", key_mask: null, match_source: "fingerprint", active_token_key: null });
  const calls = f.state.statCalls.length;
  await f.repository.requestResettle("rr_live", ["2026-10-08"], { now });
  now += 60000;
  f.state.upstreamQuota = 100;
  await f.module.refreshDue(now);
  assert.deepEqual(costOf(), [1, 2], "两把 Key 各 1 相加，写第 2 版");
  assert.equal(f.state.statCalls.slice(calls).filter((call) => call.side === "upstream" && call.start === COMPLETED_YESTERDAY.startMs / 1000).length, 2, "每把 Key 取一次");
});

// 这一轮按「要结的上游」整批重读目录（planSettlement 的 staleMetadata 标记）已经盖住了「昨天」「回看预算内」这两类，
// 这条额外加的是不挂在那两类上也要对：已删 Key 的减法本身必须重读，不依赖调用方记得先标 staleMetadata
// （K2b 要加新的开段/认 Key 路径，不能指望每条新路径都记得照 refreshDue 那样先标一遍）
test("K2b 前置：Sub2API 已删 Key 的减法（非只读）强制重读一次 Key 目录，不靠调用方先标 staleMetadata；只读查询不触发", async (t) => {
  const now0 = Date.parse("2026-10-11T01:00:00Z"); // 上海 10-11 09:00
  let now = now0;
  t.mock.method(Date, "now", () => now);
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "7", ratio: null, from: 0 }] });
  const baseUrl = "https://sub2-stale-metadata.test";
  Object.assign(f.stations[0], { type: "sub2api", baseUrl, accessToken: "jwt" });
  Object.assign(f.rule, { billing_policy: "next-complete-day", scope_version: 1, billing_effective_from_ms: Date.parse("2026-10-09T16:00:00Z"),
    cost_coverage: "complete", source_binding: { 1: "r1" } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const host = new URL(baseUrl).host, ownFetch = globalThis.fetch;
  // sub2.tokens 是「上游这一刻真的有哪些 Key」：一开始只有 9，模拟新 Key 10 是在第一次读目录以后才建的
  const sub2 = { tokens: [{ id: 9, user_id: 7, name: "stable", status: "active", group_id: 7 }], keysCalls: 0,
    costs: { 9: { "2026-10-10": 3 }, 10: { "2026-10-10": 4 } }, total: { "2026-10-10": 10 } };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.host !== host) return ownFetch(input, init);
    const reply = (status, data) => ({ status, text: async () => JSON.stringify({ code: status === 200 ? 0 : 1, data }) });
    if (url.pathname === "/api/v1/auth/me") return reply(200, { id: 7 });
    if (url.pathname === "/api/v1/keys") { sub2.keysCalls += 1; return reply(200, { total: sub2.tokens.length, items: sub2.tokens }); }
    if (url.pathname.startsWith("/api/v1/keys/")) return reply(404, {});
    const date = url.searchParams.get("start_date"), keyId = url.searchParams.get("api_key_id");
    const cost = keyId == null ? sub2.total[date] ?? 0 : sub2.costs[keyId]?.[date] ?? 0;
    return reply(200, { total_actual_cost: cost });
  });

  await f.module.refreshDue(now); // 基线：只有绑定自己那把 Key（9），正常结账
  assert.deepEqual(f.state.ledger.map((row) => [row.bill_date, row.detail.result.calculation.upstream?.amountUsd ?? row.cost_usd]).filter(([d]) => d === "2026-10-10"), [["2026-10-10", 3]]);
  assert.equal(sub2.keysCalls, 1);

  // 这时候上游建了新 Key 10（有用量）：目录缓存还没过期（5 分钟内），自然不会知道
  sub2.tokens = [{ id: 9, user_id: 7, name: "stable", status: "active", group_id: 7 }, { id: 10, user_id: 7, name: "oai-2", status: "active", group_id: 7 }];
  // 分段里再加一把已经从目录删掉的 Key（77）：和 K1c 原有测试同一个造法
  const segment = f.repository.tables.segments.find((row) => row.rule_id === "rr_live" && row.effective_to_ms == null);
  f.repository.tables.segmentKeys.push({ segment_id: segment.id, upstream_station_id: "upstream", token_id: f.rule.token_id, token_name: f.rule.token_name, key_mask: null, match_source: "initial", active_token_key: null });
  f.repository.tables.segmentKeys.push({ segment_id: segment.id, upstream_station_id: "upstream", token_id: 77, token_name: "gone-key", key_mask: null, match_source: "fingerprint", active_token_key: null });
  const keysCallsBefore = sub2.keysCalls;
  await f.repository.requestResettle("rr_live", ["2026-10-10"], { now });
  now += 60000; // 远没到 5 分钟，普通轮询不会自然重读目录
  await f.module.refreshDue(now);
  assert.ok(sub2.keysCalls > keysCallsBefore, "已删 Key 这一轮强制重读了一次目录（不管这个上游是不是也被 planSettlement 标过 staleMetadata）");
  // 10 − 3（Key 9）− 4（Key 10）= 3：减法要把新 Key 10 也扣掉，不是 10 − 3 = 7（把 Key 10 的钱错算成已删 Key 的）。
  // 这一轮恰好也在 planSettlement 的「昨天」范围里、本来就会被标 staleMetadata，这个数本来就会是对的；
  // 这条测试证明的是重读的码路径真的跑了（上一行的请求数），不是只靠外层那道已有的保险
  assert.deepEqual(f.state.ledger.filter((row) => row.bill_date === "2026-10-10").map((row) => Number(row.cost_usd)), [3, 3 + 3]);

  // 只读查询（页面）不强制重读，也不改任何状态
  const readKeysCalls = sub2.keysCalls;
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", timezone: "Asia/Shanghai", startMs: Date.parse("2026-10-09T16:00:00Z"), endMs: Date.parse("2026-10-10T16:00:00Z") }, { mode: "evaluate", origin: "page" });
  assert.equal(sub2.keysCalls, readKeysCalls, "只读查询不强制重读目录");
});

// K2b：分组、合组检测接进结账流程（不能等 K2c）。下面两条证明接进去以后账本是安全的：
// 冲突的绑定那几天既不会固定下来（没有账本行），也不会把同一笔钱算给两条绑定（不会出现两条账本行同一天同一把 Key 都算了钱）。
const KEY_AGENT_SECRET = "K7m2-xP9q" + "R4t".repeat(10);

for (const policy of POLICIES) test("K2b：合组——早退只挡从第一次认出冲突那一刻（b）起的窗口；b 以前已经结过的日子不受影响，冲突解开以后恢复正常 [" + policy + "]", async (t) => {
  // 设计约定：今天 14:00 第一次认出合组，昨天那条绑定的账和这件事无关，拖过 7 天才进需处理——
  // 这条测试证明：10-11（b 以前）正常固定且不会被后面几轮动；10-12（跨过 b 的那天）不固定；
  // 10-13（合组解开以后）恢复正常，三天都不会把同一把 Key 的钱算给两条绑定。
  let now = Date.parse("2026-10-12T01:00:00Z"); // 上海 10-12 09:00，合组从一开始就在（b 落在这一轮里）
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  let colliding = true;
  const f = liveReconciliationFixture(t, { policy,
    segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_b"],
    channelsByRule: { rr_live: [1], rr_b: [2] },
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    keyAgent: {
      secret: KEY_AGENT_SECRET,
      // colliding 时渠道 1（rr_live）和渠道 2（rr_b）这一轮都认出是 token 9——合组了，分不清这把 Key 该算给哪条；
      // 解开以后各认各的（渠道 2 认出 token 10，和 rr_b 自己原来那把一致）
      channels: () => [
        { id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keyNine), f: "unused-1" }] },
        { id: 2, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(colliding ? keyNine : keyTen), f: "unused-2" }] },
      ],
    },
  });
  const rowsOf = (date) => f.state.ledger.filter((row) => row.bill_date === date);

  await f.module.refreshDue(now); // 结「昨天」10-11：这一刻（b）落在 10-12，10-11 整天都在 b 以前，不受影响
  const oct11 = rowsOf("2026-10-11");
  assert.equal(oct11.length, 2, "10-11 两条绑定都正常固定（在 b 以前，和合组这件事无关）");

  now = Date.parse("2026-10-13T01:00:00Z"); // 上海 10-13 09:00，合组还在
  await f.module.refreshDue(now); // 结「昨天」10-12：10-12 这一天跨过了 b（b 落在 10-12 当天），该挡
  assert.deepEqual(rowsOf("2026-10-12"), [], "10-12（跨过 b 的那天）两条绑定都没有固定下来的行");
  assert.deepEqual(rowsOf("2026-10-11"), oct11, "10-11 已经固定的行没有被后面几轮动过");

  colliding = false; // 合组解开（比如渠道 2 换回了自己的 Key）
  now = Date.parse("2026-10-14T01:00:00Z");
  await f.module.refreshDue(now); // 结「昨天」10-13：冲突期间（10-12 09:00 到解开）渠道 2 用的 Key 的钱没有进过任何一条绑定的段——不能带着缺的钱固定
  assert.deepEqual(rowsOf("2026-10-13"), [], "合组解开以后，冲突期间的 10-13 仍然不固定（K2c 重新分组落库以前不知道渠道 2 那段用的是哪把 Key）");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null, "事项本身解开了");
  const closed = (await f.repository.getRule("rr_live")).keyIssueClosed;
  assert.deepEqual([closed.code, closed.sinceMs, closed.untilMs], ["KEY_GROUP_CHANGED", Date.parse("2026-10-12T01:00:00Z"), Date.parse("2026-10-14T01:00:00Z")], "记着冲突期间 [认出, 解开)，只挡这一段");
  now = Date.parse("2026-10-15T01:00:00Z");
  await f.module.refreshDue(now); // 结 10-14：这一天碰到冲突期间（解开在 10-14 09:00），也不固定
  assert.deepEqual(rowsOf("2026-10-14"), []);
  now = Date.parse("2026-10-16T01:00:00Z");
  await f.module.refreshDue(now); // 结 10-15：整天在解开以后，照常固定
  assert.equal(rowsOf("2026-10-15").length, 2, "解开以后的日子恢复正常固定");
});

for (const policy of POLICIES) test("K2b：分组——一条绑定名下两个渠道，这一轮认出的 Key 不再是同一把，只挡跨过 b 的那天；b 以前的照常固定，不相关的别的绑定照常结账 [" + policy + "]", async (t) => {
  let now = Date.parse("2026-10-12T01:00:00Z"); // 上海 10-12 09:00，分组从一开始就在（b 落在这一轮里）
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  const f = liveReconciliationFixture(t, { policy,
    segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_b"], // 只是为了让上游目录真的列出 token 10；rr_b 自己的渠道（3）不在读取服务快照里，不参与这次检测
    channelsByRule: { rr_live: [1, 2], rr_b: [3] },
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    keyAgent: {
      secret: KEY_AGENT_SECRET,
      // rr_live 的渠道 1 认出 token 9（自己原来那把，没变），渠道 2 这一轮认出的是 token 10——组散了
      channels: () => [
        { id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keyNine), f: "unused-1" }] },
        { id: 2, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keyTen), f: "unused-2" }] },
      ],
    },
  });
  const rowsOf = (ruleId, date) => f.state.ledger.filter((row) => row.rule_id === ruleId && row.bill_date === date);

  await f.module.refreshDue(now); // 结「昨天」10-11：b 落在 10-12，10-11 整天在 b 以前，不受影响
  assert.equal(rowsOf("rr_live", "2026-10-11").length, 1, "10-11（在 b 以前）照常固定");
  assert.equal(rowsOf("rr_b", "2026-10-10").length + rowsOf("rr_b", "2026-10-11").length > 0, true, "不相关的绑定（渠道没在识别结果里）照常结账");

  now = Date.parse("2026-10-13T01:00:00Z");
  await f.module.refreshDue(now); // 结「昨天」10-12：这天跨过了 b，该挡
  assert.deepEqual(rowsOf("rr_live", "2026-10-12"), [], "组散了，10-12（跨过 b 的那天）不固定、不结账");
  assert.ok(rowsOf("rr_b", "2026-10-12").length > 0, "不相关的绑定（渠道没在这次识别结果里）照常结账，不连坐");
});

for (const policy of POLICIES) test("K2b：没有冲突的正常换 Key——识别→算计划→落库接上了：开出过渡段，rules.token_id/canonical_key 一起换，换完照常结账固定（不被 SOURCE_BINDING_UNCONFIRMED 挡住） [" + policy + "]", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z"); // 上海 10-11 09:00，先走一轮，渠道还是原来的 token 9
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  let currentKey = keyNine; // 渠道 1 这一轮用的 Key，后面改成 keyTen 模拟换 Key
  const f = liveReconciliationFixture(t, { policy,
    segments: [{ id: "s1", group: "g1", from: 0 }],
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    // 10：一开始没有任何绑定用它，是「凭空出现的新 Key」，不是挪过来的；9：旧 Key 换掉以后上游目录里还在（规则上的 token_id 改成 10 以后夹具不再替它列）
    extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }],
    keyAgent: {
      secret: KEY_AGENT_SECRET,
      channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(currentKey), f: "unused" }] }],
    },
  });
  await f.module.refreshDue(now); // 第一轮：锚定身份，渠道还是 token 9，没有变化
  const anchored = await f.repository.getRule("rr_live");
  assert.ok(anchored.canonicalKey, "第一轮已经锚定");
  assert.equal(anchored.tokenId, 9);

  currentKey = keyTen; // 第二天：渠道真的换成了 token 10
  now = Date.parse("2026-10-12T01:00:00Z");
  await f.module.refreshDue(now); // 这一轮认出换了，算计划、落库

  const changed = await f.repository.getRule("rr_live");
  assert.equal(changed.tokenId, 10, "rules.token_id 跟着换了");
  assert.notEqual(changed.canonicalKey, anchored.canonicalKey, "canonical_key 跟着 token_id 一起换，不然下次结账会被 SOURCE_BINDING_UNCONFIRMED 挡住");
  const segments = await f.repository.listSegments("rr_live");
  assert.equal(segments.length, 3, "原段关掉 + 过渡段（两把 Key，已关）+ 新段（token 10，开着）");
  assert.deepEqual(segments[2].keys.map((key) => key.tokenId), [10]);
  assert.deepEqual(segments[1].keys.map((key) => key.tokenId).sort((a, b) => a - b), [9, 10], "过渡段两把 Key 都记着");
  // 正常换 Key：a 是上一次读成功的时刻（第一轮 10-11 01:00Z），b 是这一轮读到的时刻（10-12 01:00Z）
  assert.equal(segments[1].effectiveFrom, Date.parse("2026-10-11T01:00:00Z"), "a = 上一次读成功的时刻");
  assert.equal(segments[1].effectiveTo, Date.parse("2026-10-12T01:00:00Z"), "b = 这一轮读到新 Key 的时刻");
  assert.equal(f.stations[1].keyAgentLastSuccessAtMs, Date.parse("2026-10-12T01:00:00Z"), "换段落库以后，这一轮的成功时刻才记下来");

  now = Date.parse("2026-10-13T01:00:00Z");
  await f.module.refreshDue(now); // 结「昨天」10-12：换完以后照常结账，不会被挡住
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-12").length, 1,
    "换了 Key 以后 10-12 照常固定，没有被 SOURCE_BINDING_UNCONFIRMED 挡住");
  // 换 Key 那天（design/ui-copy-spec.md §5.4）：出「换了 Key」那一句，不出「倍率变化的时间是系统估的」（也就不给「改时间」）
  const day = await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", timezone: "Asia/Shanghai",
    startMs: Date.parse("2026-10-11T16:00:00Z"), endMs: Date.parse("2026-10-12T16:00:00Z") }, { force: true });
  const codes = day.results[0].health.issues.map((issue) => issue.code);
  // 钱：换 Key 当天上游成本 = 过渡段 [0 点, b) 两把 Key 各 1 + b 起新 Key 1（夹具的 stat 每次回 1 美元）；两种规则都得是 3
  // （immediate 以前整天只按最新那把取，只有 1）
  assert.equal(day.results[0].upstream.amountUsd, 3, `换 Key 当天旧 Key 那份也算进来（${policy}）`);
  assert.ok(codes.includes("KEY_CHANGED"), "换 Key 那天有这一句");
  assert.equal(codes.includes("SEGMENT_TIMING_UNCONFIRMED"), false, "换 Key 开的段不是估的倍率变化，不出旧提示");
  assert.deepEqual(segments.slice(1).map((segment) => segment.timingSource), ["key_change_window", "key_change"]);
});

// 生产的绑定都是 immediate（scoped）：换 Key 当天上游成本也得按段取（旧 Key 换之前的用量、过渡段里两把都取），
// 不能整天只按最新那把取。夹具的 stat 每次回 1 美元，数请求就是数金额
test("K2b：immediate（scoped）规则换 Key——换 Key 当天上游成本按段取各自的 Key（过渡段两把都取），没换 Key 的窗口还是整窗一次", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  let currentKey = keyNine;
  const f = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }],
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(currentKey), f: "unused" }] }] },
  });
  const effective = Date.parse("2026-10-01T00:00:00Z");
  Object.assign(f.rule, { billing_policy: "immediate", scope_version: 1, billing_effective_from_ms: effective, created_at: new Date(effective), cost_coverage: "complete", source_binding: { 1: "r1" } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const dayOf = async (startIso, endIso) => {
    const before = f.state.requests.length;
    const result = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", timezone: "Asia/Shanghai",
      startMs: Date.parse(startIso), endMs: Date.parse(endIso) }, { force: true })).results[0];
    const stats = f.state.requests.slice(before).filter((request) => request.host === "upstream.test" && request.path === "/api/log/self/stat")
      .map((request) => { const q = new URLSearchParams(request.query); return [q.get("token_name"), Number(q.get("start_timestamp")), Number(q.get("end_timestamp"))]; })
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])) || x[1] - y[1]);
    return { result, stats };
  };
  const sec = (iso) => Date.parse(iso) / 1000;

  await f.module.refreshDue(now); // 第一轮：锚定
  now = Date.parse("2026-10-11T16:00:00Z"); // 还没换 Key：10-11 整天（上海）只有 token 9，整窗一次
  const beforeChange = await dayOf("2026-10-10T16:00:00Z", "2026-10-11T16:00:00Z");
  assert.deepEqual(beforeChange.stats, [["stable", sec("2026-10-10T16:00:00Z"), sec("2026-10-11T16:00:00Z") - 1]], "没换 Key：整窗一次，和以前一样");

  currentKey = keyTen;
  now = Date.parse("2026-10-12T01:00:00Z");
  await f.module.refreshDue(now); // 认出换了，落库：段 [0, a) token 9、[a, b) 两把、[b, ) token 10；a = 上一次读成功的时刻，b = 现在
  const a = sec("2026-10-11T01:00:00Z"), b = sec("2026-10-12T01:00:00Z");
  assert.deepEqual((await f.repository.listSegments("rr_live")).map((s) => s.keys.map((k) => k.tokenId)), [[9], [9, 10], [10]]);

  now = Date.parse("2026-10-13T01:00:00Z");
  // 10-12（b 所在的那天）：[0 点, b) 过渡段两把都取，[b, 24 点) 只取新的
  const changeDay = await dayOf("2026-10-11T16:00:00Z", "2026-10-12T16:00:00Z");
  assert.deepEqual(changeDay.stats, [["oai-2", sec("2026-10-11T16:00:00Z"), b - 1], ["oai-2", b, sec("2026-10-12T16:00:00Z") - 1], ["stable", sec("2026-10-11T16:00:00Z"), b - 1]],
    "换 Key 当天：过渡段里旧 Key 那份也取了（以前整天只取 oai-2 一条）");
  assert.equal(changeDay.result.upstream.amountUsd, 3, "三次各 1 美元");
  // 换了以后的整天：只有新 Key，整窗一次
  now = Date.parse("2026-10-14T01:00:00Z");
  const later = await dayOf("2026-10-12T16:00:00Z", "2026-10-13T16:00:00Z");
  assert.deepEqual(later.stats, [["oai-2", sec("2026-10-12T16:00:00Z"), sec("2026-10-13T16:00:00Z") - 1]]);
});

for (const policy of POLICIES) test("K2b：读完、落库前重启——这一轮的成功时刻要等落库以后才写，重启后 a 还是上一次读成功的时刻，[t, b) 不漏 [" + policy + "]", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  let currentKey = keyNine;
  const f = liveReconciliationFixture(t, { policy,
    segments: [{ id: "s1", group: "g1", from: 0 }],
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(currentKey), f: "unused" }] }] },
  });
  const own = f.stations[1];
  await f.module.refreshDue(now); // 第一轮 10-11 01:00Z：没变化，成功时刻记下 T1
  const t1 = Date.parse("2026-10-11T01:00:00Z");
  assert.equal(own.keyAgentLastSuccessAtMs, t1);

  currentKey = keyTen;
  now = Date.parse("2026-10-11T14:30:00Z"); // 真正换 Key 在 T1 和这一轮之间的某一刻，这一轮 14:30 才读到
  const original = f.repository.applyKeyChangePlans.bind(f.repository);
  const seenAtApply = [];
  let crash = true;
  f.repository.applyKeyChangePlans = async (...args) => {
    seenAtApply.push(own.keyAgentLastSuccessAtMs); // 落库的这一刻，库里「上一次读成功」还应该是 T1，不是这一轮的 14:30
    if (crash) { crash = false; throw new Error("进程在落库前被杀了"); }
    return original(...args);
  };
  await f.module.refreshDue(now);
  assert.deepEqual(seenAtApply, [t1], "落库时站点的成功时刻还是上一次的，没有读完就先写成 b");
  assert.equal((await f.repository.getRule("rr_live")).tokenId, 9, "这一轮没落库，绑定原样");
  assert.equal(own.keyAgentLastSuccessAtMs, t1, "没落库，成功时刻不往前推：重启以后 a 还是 T1");

  // 「重启」：内存里的识别缓存丢了，站点上持久化的成功时刻还在
  f.rt._keyAgentIdentifyCache = null;
  now = Date.parse("2026-10-11T14:34:00Z");
  await f.module.refreshDue(now);
  const segments = await f.repository.listSegments("rr_live");
  assert.equal(segments.length, 3);
  assert.equal(segments[1].effectiveFrom, t1, "重启后 a 还是上一次读成功的 T1，不是 b——[t, b) 在过渡段里，不漏");
  assert.equal(segments[1].effectiveTo, now);
  assert.deepEqual(segments[1].keys.map((key) => key.tokenId).sort((a, b) => a - b), [9, 10]);
  assert.equal(own.keyAgentLastSuccessAtMs, now, "换段落库以后才记下这一轮");
});

for (const policy of POLICIES) test("K2b：冲突几轮以后解开再换段——站点的成功时刻没往前推，换段的 a 用开着那段的起点，不漏 [" + policy + "]", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10), keyEleven = "sk-" + "Elev".repeat(10);
  let keys = { 1: keyNine, 2: keyNine }; // 一条绑定两个渠道（组），都用 token 9
  const f = liveReconciliationFixture(t, { policy,
    segments: [{ id: "s1", group: "g1", from: 1000 }],
    channelsByRule: { rr_live: [1, 2] },
    tokenKeyOf: (tokenId) => ({ 9: keyNine, 10: keyTen, 11: keyEleven })[tokenId],
    extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }, { tokenId: 11, name: "oai-3" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [1, 2].map((id) => ({ id, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[id]), f: "unused" }] })) },
  });
  const own = f.stations[1];
  await f.module.refreshDue(now); // T1：正常，成功时刻记下 T1
  const t1 = Date.parse("2026-10-11T01:00:00Z");
  assert.equal(own.keyAgentLastSuccessAtMs, t1);

  keys = { 1: keyTen, 2: keyEleven }; // 组散了：两个渠道各换了一把不一样的
  now = Date.parse("2026-10-12T01:00:00Z");
  await f.module.refreshDue(now);
  now = Date.parse("2026-10-12T01:10:00Z");
  f.rt._keyAgentIdentifyCache = null;
  await f.module.refreshDue(now); // 又一轮，还是冲突
  assert.equal((await f.repository.getRule("rr_live")).tokenId, 9, "冲突期间不换段");
  assert.equal(own.keyAgentLastSuccessAtMs, t1, "有没处理完的冲突，站点的成功时刻不往前推");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue?.code, "KEY_GROUP_CHANGED", "冲突已经记下了（带着 b）");

  keys = { 1: keyTen, 2: keyTen }; // 冲突解开：两个渠道又一样了，都换成了 token 10
  now = Date.parse("2026-10-12T01:20:00Z");
  f.rt._keyAgentIdentifyCache = null;
  await f.module.refreshDue(now);
  const rule = await f.repository.getRule("rr_live");
  assert.equal(rule.tokenId, 10, "解开以后换段");
  assert.equal(rule.keyIssue, null, "冲突记号清掉了");
  const segments = await f.repository.listSegments("rr_live");
  const transitional = segments.find((segment) => segment.keys.length === 2);
  assert.equal(transitional.effectiveFrom, 1000, "带着冲突的绑定，a 用开着那段的起点，不是站点的 T1");
  assert.equal(transitional.effectiveTo, now);
  assert.equal(own.keyAgentLastSuccessAtMs, now, "换段落库、冲突清掉以后，成功时刻才往前推");
});

for (const policy of POLICIES) test("K2b：两条绑定互换 Key（挪过）——同一个事务清空再写不撞自己的唯一约束，两边都按 b 切开不开过渡段，成本主人看到的是换完以后的 Key [" + policy + "]", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  let swapped = false;
  const f = liveReconciliationFixture(t, { policy,
    segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_b"],
    channelsByRule: { rr_live: [1], rr_b: [2] },
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [
      { id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(swapped ? keyTen : keyNine), f: "unused-1" }] },
      { id: 2, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(swapped ? keyNine : keyTen), f: "unused-2" }] },
    ] },
  });
  await f.module.refreshDue(now);
  assert.ok((await f.repository.getRule("rr_live")).canonicalKey && (await f.repository.getRule("rr_b")).canonicalKey, "第一轮两条都锚定了");
  // 生产里绑定建的时候 rules.active_token_key 就是 canonical key（createRule），开着那段的 Key 行抄的同一个值；夹具的规则没有，
  // 补上——不然互换时撞不上唯一约束，「互换必须同组一个事务」（server/reconciliation.js applyKeyAgentChangesFor 的分组）去掉了测试也是绿的
  for (const row of f.repository.tables.rules) row.active_token_key = row.canonical_key;
  for (const keyRow of f.repository.tables.segmentKeys) keyRow.active_token_key = f.repository.tables.rules.find((row) => row.token_id === keyRow.token_id)?.canonical_key ?? null;

  swapped = true; // 两个渠道互换了 Key
  now = Date.parse("2026-10-12T01:00:00Z");
  await f.module.refreshDue(now);
  const a = await f.repository.getRule("rr_live"), b = await f.repository.getRule("rr_b");
  assert.deepEqual([a.tokenId, b.tokenId], [10, 9], "互换成功，没有撞唯一约束");
  assert.equal(a.keyIssue, null);
  assert.equal(b.keyIssue, null, "互换不是分组合组，不记冲突");
  for (const ruleId of ["rr_live", "rr_b"]) {
    const segments = await f.repository.listSegments(ruleId);
    assert.equal(segments.length, 2, "挪过：按 b 切开，只有旧段和新段，没有两把 Key 都算的过渡段");
    assert.equal(segments[0].effectiveTo, now);
    assert.equal(segments[1].effectiveFrom, now);
    assert.equal(segments[1].keys.length, 1);
  }
  assert.equal((await f.repository.listSegments("rr_live"))[1].keys[0].tokenId, 10);
  assert.equal((await f.repository.listSegments("rr_b"))[1].keys[0].tokenId, 9);
});

// 例外三（binding-flow.md §2）：读取服务读不到新结果。从最后一次读到的时刻起这个站点下各渠道先不算（实时·还在读取，过了零点也不固定）；
// 连续 3 次才升成需处理 KEY_READER_UNREACHABLE；最后一次读到以前的日子不受影响；连上以后 Key 没变就照常算、换了就是 [a, b) 过渡段。
async function readerOutageFixture(t) {
  const clock = { now: Date.parse("2026-10-11T01:00:00Z") };
  t.mock.method(Date, "now", () => clock.now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10);
  const agent = { secret: KEY_AGENT_SECRET, down: false, key: keyNine, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(agent.key), f: "unused" }] }] };
  const f = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }],
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }],
    keyAgent: agent,
  });
  const round = async (isoTime) => {
    clock.now = Date.parse(isoTime);
    f.rt._keyAgentIdentifyCache = null; // 每一轮都真的去问读取服务（不命中 4 分钟缓存）
    await f.module.refreshDue(clock.now);
  };
  const state = async (billDate) => (await f.repository.listSettlementStates(["rr_live"], { billDates: [billDate] }))[0] || null;
  const booked = (billDate) => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === billDate).length;
  return { f, agent, keyTen, round, state, booked };
}

// 时间线（上海 UTC+8，一天在 UTC 16:00 结束，结账等 15 分钟）：R0 10-11 16:05Z 读得到（最后一次读到）——这时 10-11 刚结束还没到结账的点；
// 读取服务停了：R1 10-11 16:30Z、R2 10-12 16:20Z、R3 10-12 16:35Z 各读不到一次（连续 3 次）；R4 10-12 17:00Z 连上
test("K2b 例外三：读不到——最后一次读到以前结束的日子照常固定，以后的不固定；前 2 次是「还在读取」，第 3 次升成需处理；连上、Key 没变——照常算，不开过渡段", async (t) => {
  const { f, agent, round, state, booked } = await readerOutageFixture(t);
  await round("2026-10-11T16:05:00Z"); // R0：读得到，最后一次读到是这一刻
  assert.equal(booked("2026-10-11"), 0, "10-11 刚结束，还没到结账的点");

  agent.down = true; // 读取服务停了
  await round("2026-10-11T16:30:00Z"); // R1：第 1 次读不到。10-11 在最后一次读到以前就结束了，照常结账
  assert.equal(booked("2026-10-11"), 1, "最后一次读到以前结束的日子，读不到也照常固定");

  await round("2026-10-12T16:20:00Z"); // R2：第 2 次。10-12 在最后一次读到以后才结束：先不算
  assert.equal(booked("2026-10-12"), 0, "最后一次读到以后结束的日子不固定");
  assert.equal((await state("2026-10-12"))?.retryReason, "KEY_AGENT_UNAVAILABLE", "前 2 次是读取类：实时·还在读取，系统会自己再读");

  await round("2026-10-12T16:35:00Z"); // R3：第 3 次，连续 3 次才进需处理
  assert.equal((await state("2026-10-12"))?.manualReason, "KEY_READER_UNREACHABLE", "连续 3 次升成需处理");
  assert.equal(booked("2026-10-12"), 0, "过了零点也不固定");
  const before = await f.repository.getRule("rr_live");

  agent.down = false; // R4：连上了，Key 没变
  await round("2026-10-12T17:00:00Z");
  await round("2026-10-12T17:15:00Z"); // 需处理的那天每 10 分钟本地重判一次，读到了就接着算
  assert.equal(booked("2026-10-12"), 1, "连上、Key 没变：这段时间的数照常算、照常固定，不提示");
  assert.equal((await f.repository.getRule("rr_live")).tokenId, before.tokenId, "没换 Key 就不动绑定");
  assert.equal((await f.repository.listSegments("rr_live")).length, 1, "没有过渡段");
});

test("K2b 例外三：读不到期间渠道换了 Key，连上以后——[a, b) 过渡段的 a 是最后一次读到旧 Key 的时刻，b 是连上的时刻，读不到那段时间花的钱照常算进来", async (t) => {
  const { f, agent, keyTen, round, state, booked } = await readerOutageFixture(t);
  await round("2026-10-11T16:05:00Z"); // R0：最后一次读到旧 Key（token 9）：a
  const a = Date.parse("2026-10-11T16:05:00Z");
  agent.down = true;
  await round("2026-10-11T16:30:00Z");
  await round("2026-10-12T16:20:00Z");
  await round("2026-10-12T16:35:00Z");
  assert.equal((await state("2026-10-12"))?.manualReason, "KEY_READER_UNREACHABLE");
  assert.equal((await f.repository.getRule("rr_live")).tokenId, 9, "读不到期间不换段");

  agent.down = false;
  agent.key = keyTen; // 读不到期间渠道已经换成了 token 10
  await round("2026-10-12T17:00:00Z"); // R4：b，重新读到的时刻
  const b = Date.parse("2026-10-12T17:00:00Z");
  assert.equal((await f.repository.getRule("rr_live")).tokenId, 10, "连上以后换段");
  const transitional = (await f.repository.listSegments("rr_live")).find((segment) => segment.keys.length === 2);
  assert.equal(transitional.effectiveFrom, a, "a = 最后一次读到旧 Key 的时刻");
  assert.equal(transitional.effectiveTo, b, "b = 重新读到的时刻");
  await round("2026-10-12T17:15:00Z");
  assert.equal(booked("2026-10-12"), 1, "读不到那段时间的数照常算进来、照常固定");
});

test("K2b：渠道换成了一把不在已加上游里的 Key（CHANNEL_KEY_UNMATCHED，流程稿例外一）——从认出的那一刻起不结账、记需处理；那一刻以前的日子照常固定；换回来（或把上游加进来）以后恢复", async (t) => {
  const { f, agent, round, state, booked } = await readerOutageFixture(t);
  const keyNine = agent.key;
  await round("2026-10-11T16:05:00Z"); // R0：正常，渠道用 token 9
  agent.key = "sk-" + "Unkn".repeat(10); // 渠道换成了一把哪个已加的上游里都没有的 Key
  await round("2026-10-11T16:30:00Z"); // R1：认出来了（b）。10-11 在 b 以前就结束了，照常结账
  const issue = (await f.repository.getRule("rr_live")).keyIssue;
  assert.equal(issue.code, "CHANNEL_KEY_UNMATCHED");
  assert.equal(issue.sinceMs, Date.parse("2026-10-11T16:30:00Z"), "b = 第一次认出来的时刻");
  assert.equal(booked("2026-10-11"), 1, "b 以前结束的日子照常固定");
  await round("2026-10-12T16:20:00Z"); // R2：10-12 在 b 以后结束：不结账
  assert.equal(booked("2026-10-12"), 0);
  assert.equal((await state("2026-10-12"))?.manualReason, "CHANNEL_KEY_UNMATCHED", "要人处理的（需处理），不是读取类");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue.sinceMs, issue.sinceMs, "同一件事沿用第一次的 b，不随每轮往后挪");
  assert.equal((await f.repository.getRule("rr_live")).tokenId, 9, "不碰绑定");

  agent.key = keyNine; // 换回来了
  await round("2026-10-12T16:40:00Z");
  await round("2026-10-12T16:55:00Z"); // 需处理的那天每 10 分钟本地重判一次
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null, "解开以后记号清掉");
  assert.equal(booked("2026-10-12"), 1, "恢复以后照常算、照常固定");
});

test("K2b：渠道没锚定过（还没开始算）时换成了不在已加上游里的 Key——不进需处理，只在原处写一句（流程稿附录 4）", async (t) => {
  const { f, agent, round } = await readerOutageFixture(t);
  f.repository.tables.rules.find((row) => row.id === "rr_live").canonical_key = null; // 假装还没锚定
  f.repository.tables.rules.find((row) => row.id === "rr_live").source_binding = null;
  agent.key = "sk-" + "Unkn".repeat(10);
  await round("2026-10-11T16:30:00Z");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null);
});

test("K2b：打码撞了、上游令牌没有 api_key:reveal 权限（KEY_REVEAL_DENIED）——从认出来的那一刻起不结账、记需处理", async (t) => {
  let now = Date.parse("2026-10-11T16:05:00Z");
  t.mock.method(Date, "now", () => now);
  const keyNine = "sk-" + "Nine".repeat(10), keyNineLookalike = "sk-Nine" + "abc".repeat(8) + "Nine"; // 前 4 后 4 一样、中间不一样
  const agent = { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keyNine), f: "no-match" }] }] };
  const f = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }],
    tokenKeyOf: (tokenId) => (tokenId === 12 ? keyNineLookalike : keyNine),
    extraTokens: [{ tokenId: 12, name: "lookalike" }],
    keyAgent: agent, revealScopeDenied: true,
  });
  const round = async (iso) => { now = Date.parse(iso); f.rt._keyAgentIdentifyCache = null; await f.module.refreshDue(now); };
  await round("2026-10-11T16:30:00Z");
  const issue = (await f.repository.getRule("rr_live")).keyIssue;
  assert.equal(issue?.code, "KEY_REVEAL_DENIED");
  await round("2026-10-12T16:20:00Z");
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-12").length, 0, "分不清是哪把，这天不固定");
  const [settleState] = await f.repository.listSettlementStates(["rr_live"], { billDates: ["2026-10-12"] });
  assert.equal(settleState?.manualReason, "KEY_REVEAL_DENIED", "要人处理的（给令牌补权限），不是读取类");
  // 「更新登录信息」要去缺权限的那个上游：服务端把它带在 health 上（页面按它落点；没带就退回绑定自己的上游）
  const day = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", timezone: "Asia/Shanghai",
    startMs: Date.parse("2026-10-11T16:00:00Z"), endMs: Date.parse("2026-10-12T16:00:00Z") }, { force: true })).results[0];
  assert.equal(day.health.code, "KEY_REVEAL_DENIED");
  assert.equal(day.health.upstreamStationId, "upstream", "缺 api_key:reveal 权限的上游");
});

test("K2b：Sub2API 上游上一把 Key 在两条绑定之间挪（同一天切不开）——这两条这几天先不结账，记一个会自己好的「读取中」，不换段、不动绑定；等按逐条用量拆开的后续 PR", async (t) => {
  let now = Date.parse("2026-10-11T16:05:00Z");
  t.mock.method(Date, "now", () => now);
  const f = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_b"],
    channelsByRule: { rr_live: [1], rr_b: [2] },
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [] },
  });
  Object.assign(f.stations[0], { type: "sub2api", accessToken: "jwt" }); // 这里直接塞一份识别结果；上游当 Sub2API 读（下面补上 Sub2API 的身份和 Key 目录接口）
  const newApiFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== "upstream.test") return newApiFetch(input, init);
    const data = url.pathname === "/api/v1/auth/me" ? { id: 42 }
      : url.pathname === "/api/v1/keys" ? { total: 2, items: [[9, "stable"], [10, "stable-rr_b"]].map(([id, name]) => ({ id, user_id: 42, name, status: "active", group_id: null })) } : null;
    return { status: data ? 200 : 404, text: async () => JSON.stringify({ code: data ? 0 : 404, data }) };
  });
  for (const row of f.repository.tables.rules) row.canonical_key = canonicalBillingKey(f.stations[0], { platform: "sub2api", accountId: "42" }, row.token_id);
  const match = (tokenId) => [{ stationId: "upstream", tokenId, tokenName: `k${tokenId}`, via: "fingerprint" }];
  const slot = (tokenId) => ({ index: 0, state: "identified", matches: match(tokenId) });
  // 两条绑定互换 Key：rr_live（token 9）现在用 10，rr_b（token 10）现在用 9
  f.rt._keyAgentIdentifyCache = { at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, revealIssues: [],
    channels: [{ channelId: 1, keyless: false, slots: [slot(10)] }, { channelId: 2, keyless: false, slots: [slot(9)] }] } };
  await f.module.refreshDue(now);
  const [a, b] = [await f.repository.getRule("rr_live"), await f.repository.getRule("rr_b")];
  assert.deepEqual([a.tokenId, b.tokenId], [9, 10], "没动绑定");
  assert.equal((await f.repository.listSegments("rr_live")).length, 1, "没换段");
  assert.equal((await f.repository.listSegments("rr_b")).length, 1);
  assert.equal(a.keyIssue?.code, "PENDING", "会自己好的「读取中」，不是需处理");
  assert.equal(b.keyIssue?.code, "PENDING");
  assert.equal(reconciliationIssue("PENDING").kind, "reading");
  assert.equal(f.stations[1].keyAgentLastSuccessAtMs ?? null, null, "这一轮没处理完，站点的成功时刻不往前推");
  // 当天不入账：挪过的那天（b 以后结束的 10-12）这两条都不固定，账本没有行；状态是会自己好的「读取中」
  now = Date.parse("2026-10-12T16:20:00Z");
  f.rt._keyAgentIdentifyCache = { ...f.rt._keyAgentIdentifyCache, at: now, result: { ...f.rt._keyAgentIdentifyCache.result, fetchedAtMs: now } };
  await f.module.refreshDue(now);
  const booked = (ruleId, billDate) => f.state.ledger.filter((row) => row.rule_id === ruleId && row.bill_date === billDate).length;
  assert.deepEqual([booked("rr_live", "2026-10-12"), booked("rr_b", "2026-10-12")], [0, 0], "挪过 Key 的这一天两条绑定都不入账");
  const [state] = await f.repository.listSettlementStates(["rr_live"], { billDates: ["2026-10-12"] });
  assert.equal(state?.retryReason, "PENDING", "会自己好的读取类，不是要人处理");
  assert.equal(state?.manualReason ?? null, null);
});

test("C3 解除时刻早于 7 天、没锚定过的、旧版（legacy）的绑定不补结", async (t) => {
  let now = Date.parse("2026-10-01T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.module.archiveRule("rr_live"); // 10-01 解除
  now = Date.parse("2026-10-12T03:00:00Z"); // 11 天以后
  const calls = f.state.statCalls.length;
  await f.module.refreshDue(now);
  assert.equal(f.state.statCalls.length, calls, "解除得太早：不取数");
  // 没锚定过：解除前没人保证这把 Key 只有它在用
  const g = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of g.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  g.rows.find((row) => row.id === "rr_live").canonical_key = null;
  now = Date.parse("2026-10-09T03:00:00Z");
  await g.module.archiveRule("rr_live");
  const gCalls = g.state.statCalls.length;
  now += 3600000;
  await g.module.refreshDue(now);
  assert.equal(g.state.statCalls.length, gCalls, "没锚定过的不补结");
  // 旧版（legacy）规则：不是按整体取数的，不补结
  const h = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of h.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  h.rows.find((row) => row.id === "rr_live").billing_policy = "legacy-v3";
  await h.module.archiveRule("rr_live");
  const hCalls = h.state.statCalls.length;
  now += 3600000;
  await h.module.refreshDue(now);
  assert.equal(h.state.statCalls.length, hCalls, "旧版规则不补结");
});

test("C2a 修正切换时间后重结昨天没成：10 分钟后再试，不是每轮都重取", async (t) => {
  const transition = Date.parse("2026-10-08T04:00:00Z");
  const f = await completedDayFixture(t, { segments: [{ id: "s1", group: "g1", from: 0, to: transition }, { id: "s2", group: "g1", from: transition }] });
  let now = Date.parse("2026-10-09T03:00:00Z");
  t.mock.method(Date, "now", () => now);
  await f.module.refreshDue(now);
  await f.module.correctTransition("rr_live", "s2", transition - 3600000);
  f.state.upstreamQuota = null; // 上游这时读不到
  now += 60000;
  let calls = yesterdayStatCalls(f);
  await f.module.refreshDue(now);
  assert.ok(yesterdayStatCalls(f) > calls, "第一次重结照常取");
  assert.deepEqual(await requestedDays(f), ["2026-10-08"], "没成，请求还在");
  for (let minute = 1; minute < 10; minute += 1) {
    now += 60000;
    calls = yesterdayStatCalls(f);
    await f.module.refreshDue(now);
    assert.equal(yesterdayStatCalls(f), calls, `第 ${minute} 分钟不重取`);
  }
  f.state.upstreamQuota = 50;
  now += 60000;
  calls = yesterdayStatCalls(f);
  await f.module.refreshDue(now);
  assert.ok(yesterdayStatCalls(f) > calls, "满 10 分钟再试");
  assert.deepEqual(await requestedDays(f), [], "这次成了");
  assert.deepEqual(f.state.ledgerWrites.at(-1), { ruleId: "rr_live", billDate: "2026-10-08", revision: 2, source: "resettle" });
});

test("1b同步来源时作废正在进行的计算：查询改用重新取的 Key 目录重算", async (t) => {
  // 第一次取上游账单时停住，模拟计算进行到一半。
  let gate = null, reached, release;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }],
    onRequest: (request) => request.path === "/api/log/self/stat" && gate ? gate() : null });
  trustedLegacyRule(f.rule, f.stations, 7, 1);
  gate = () => { gate = null; reached(); return held; };
  const running = f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" });
  await arrived;
  const mark = f.state.requests.length;
  f.module.invalidateSources();
  release();
  const result = await running;
  assert.ok(f.state.requests.slice(mark).some((request) => request.path === "/api/token/"), "作废后重新取 Key 目录再算");
  assert.equal(result.results[0].calculation.profitUsd, 1.5);
  const calls = f.state.statCalls.length;
  await f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" });
  assert.equal(f.state.statCalls.length, calls, "缓存的是重算后的结果");
});

test("1b未锚定的旧规则：页面查询显示等待首次观测且不锚定，观测一次后页面查询即可核算", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }] });
  const page = () => f.module.queryRules({ preset: "today" }, { mode: "evaluate", origin: "page" });
  const before = await page();
  assert.equal(before.results[0].health.code, "PENDING");
  assert.equal(before.results[0].health.detail, "读取中");
  assert.equal(before.results[0].calculation.profitUsd, null);
  assert.deepEqual(f.state.commits.map((tx) => tx.name), [], "只读查询不锚定身份");
  assert.deepEqual(f.state.statCalls, [], "还没观测过就不取上下游账单");

  await f.module.queryRules({ preset: "today" }, { mode: "observe", origin: "manual" });
  assert.ok(f.state.commits.some((tx) => tx.name === "anchorRuleIdentity"), "观测时锚定身份");
  f.rt._reconciliationResultCache.clear();
  const after = await page();
  assert.equal(after.results[0].calculation.profitUsd, 1.5);
});

test("1b只读缓存跟随已持久化分段：别处提交了分段变化后，非强制页面查询重新计算", async (t) => {
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 1000000, to: 1030000 }, { id: "s2", group: "g2", from: 1030000 }] });
  trustedLegacyRule(f.rule, f.stations, 7, 1);
  const input = { ruleIds: [f.rule.id], preset: "custom", timezone: "Asia/Shanghai", startMs: 1000000, endMs: 1060000 };
  const page = () => f.module.queryRules(input, { mode: "evaluate", origin: "page" });
  const windows = (result) => result.segments.map((segment) => [segment.id, segment.window.startMs, segment.window.endMs]);
  assert.deepEqual(windows((await page()).results[0]), [["s1", 1000000, 1030000], ["s2", 1030000, 1060000]]);
  const calls = f.state.statCalls.length;
  await page();
  assert.equal(f.state.statCalls.length, calls, "分段没变时命中只读缓存");
  await f.repository.correctTransition(f.rule.id, "s2", 1045000); // 绕过模块，模拟轮询等别处已提交的分段变化
  const after = await page();
  assert.equal(f.state.statCalls.length, calls + 4, "分段变了不能用旧缓存");
  assert.deepEqual(windows(after.results[0]), [["s1", 1000000, 1045000], ["s2", 1045000, 1060000]]);
  assert.equal(f.state.writes, 0);
});

test("1b观测不复用只读缓存：页面先算过今天，观测仍重新取数并只写观测记录；观测的缓存页面可以直接用", async (t) => {
  const f = await completedDayFixture(t);
  const today = (mode) => f.module.queryRules({ preset: "today" }, { mode, origin: mode === "evaluate" ? "page" : "manual" });
  await today("evaluate");
  const calls = f.state.statCalls.length;
  assert.equal(f.state.writes, 0);
  await today("observe");
  assert.ok(f.state.statCalls.length > calls, "观测要自己取数，不能拿只读结果跳过写库");
  const sources = [...f.state.snapshots.values()].map((row) => JSON.parse(row.source));
  assert.ok(sources.length > 0 && sources.every((source) => source.recordType === "observation"), "今天的半天只写观测，不写确认");
  const observed = f.state.statCalls.length;
  await today("evaluate");
  assert.equal(f.state.statCalls.length, observed);
});

test("1b接入后的首次观测只在后台轮询运行时触发；同步来源后 Key 目录和结果缓存都重新取", async (t) => {
  const f = await completedDayFixture(t);
  assert.equal(f.module.observeSoon(["rr_live"]), null, "没有后台轮询（测试、脚本）时不观测");
  assert.equal(f.state.requests.length, 0);
  f.rt._reconciliationPollTimer = {};
  assert.equal(f.module.observeSoon([]), null);
  await f.module.observeSoon(["rr_live"]);
  const sources = [...f.state.snapshots.values()].map((row) => ({ ruleId: row.rule_id, ...JSON.parse(row.source) }));
  assert.ok(sources.length > 0 && sources.every((source) => source.ruleId === "rr_live" && source.recordType === "observation" && source.window.preset === "today"));

  const directory = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/token/").length;
  const listed = directory();
  await f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] }, { mode: "evaluate", origin: "page" });
  assert.equal(directory(), listed, "只读查询沿用 Key 目录缓存");
  f.module.invalidateSources();
  assert.equal(f.rt._reconciliationResultCache.size, 0);
  await f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] }, { mode: "evaluate", origin: "page" });
  assert.ok(directory() > listed, "同步来源后重新取 Key 目录");
});

test("1b接口：GET 和 POST 默认只读零写入，只有带 observe:true 的「刷新」才观测写库", async (t) => {
  const f = await completedDayFixture(t);
  f.rt.reconciliation = f.module;
  f.rt.store.auth = { isDefault: false };
  f.rt.sessions = { verify: (token) => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 };
  const { registerHooks } = await import("node:module");
  globalThis.__p1bRuntime = f.rt;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "next/server") return { url: "test:p1b-next", shortCircuit: true };
    if (specifier.endsWith("/runtime.js")) return { url: "test:p1b-runtime", shortCircuit: true };
    if (specifier.endsWith("/lib/api.js")) return { url: new URL(`${specifier}?p1b-auth`, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === "test:p1b-next") return { format: "module", shortCircuit: true, source: "export const NextResponse={json:(value,init)=>Response.json(value,init)};" };
    if (url === "test:p1b-runtime") return { format: "module", shortCircuit: true, source: "export const getRuntime=async()=>globalThis.__p1bRuntime;" };
    return next(url, context);
  } });
  try {
    const { GET } = await import("../app/api/reconciliation/route.js?p1b");
    const { POST } = await import("../app/api/reconciliation/query/route.js?p1b");
    const headers = { cookie: "rm_session=valid" };
    const post = (body) => POST(new Request("http://localhost/api/reconciliation/query", { method: "POST", headers, body: JSON.stringify(body) }));
    for (const response of [await GET(new Request("http://localhost/api/reconciliation", { headers })),
      await GET(new Request("http://localhost/api/reconciliation?preset=today&force=true", { headers })), await post({ preset: "today" }), await post({ preset: "yesterday" })]) {
      assert.equal(response.status, 200);
      assert.ok((await response.json()).results.every((row) => row.calculation.profitUsd === 1.5));
    }
    assert.deepEqual([f.state.commits.length, f.state.writes, f.state.alertQueries], [0, 0, 0], "页面查询零写入、零告警");
    const refreshed = await post({ preset: "today", observe: true });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).results.length, 3);
    const sources = [...f.state.snapshots.values()].map((row) => JSON.parse(row.source));
    assert.ok(sources.length >= 3 && sources.every((source) => source.recordType === "observation"), "「刷新」观测今天并写观测记录");
  } finally { hooks.deregister(); delete globalThis.__p1bRuntime; }
});

test("4a 账本记下结账时配置的汇率和成本计法：之后改汇率、改成固定采购，已结账的昨天照旧；当时没设的汇率按当前配置", async (t) => {
  const f = await completedDayFixture(t);
  const own = f.stations.find((station) => station.id === "own"), upstream = f.stations.find((station) => station.id === "upstream");
  own.cnyPerUsd = 7.1;
  await f.module.refreshDue(Date.now());
  assert.deepEqual(f.state.ledger.map((row) => [row.bill_date, row.revision, row.source, row.revenue_usd, row.cost_usd, row.revenue_rate, row.cost_rate, row.cost_basis]),
    Array(3).fill(["2026-10-08", 1, "settle", 2.5, 1, 7.1, null, "usage"]));
  own.cnyPerUsd = 8; upstream.cnyPerUsd = 6.5; upstream.fixedPurchases = [{ amount: 300, days: 30 }];
  f.rt._reconciliationResultCache.clear();
  const { results } = await f.module.queryRules({ preset: "yesterday" }, { mode: "evaluate", origin: "page" });
  assert.equal(results.length, 3);
  for (const row of results) {
    assert.deepEqual([row.displayStatus.state, row.calculation.profitUsd], ["settled", 1.5], "已结账的毛利不按固定采购重算");
    assert.deepEqual(row.rates, { income: { stationId: "own", cnyPerUsd: 7.1, source: "configured" },
      cost: { stationId: "upstream", cnyPerUsd: 6.5, source: "configured" }, costBasis: "usage" });
    assert.deepEqual(row.ledger, { billDate: "2026-10-08", revision: 1, source: "settle", settledAt: row.settledAt, rates: { income: 7.1, cost: null }, costBasis: "usage" });
  }
  // 今天还没结账，按当前配置：固定采购、成本记 0。
  const today = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "evaluate", origin: "page" })).results[0];
  assert.deepEqual([today.rates.costBasis, today.rates.income.cnyPerUsd, today.ledger], ["fixed", 8, undefined]);
});

test("结账在途改变成本计法和双边汇率：废弃旧任务，重读后只保存一致的新配置", async (t) => {
  for (const initialFixed of [true, false]) await t.test(initialFixed ? "固定采购改按用量" : "按用量改固定采购", async (t) => {
    const wait = holdPoint();
    let held = false;
    const f = await completedDayFixture(t, { onRequest: (request) => {
      if (request.path === "/api/log/self/stat" && !held) { held = true; return wait.hold(); }
    } });
    const upstream = f.stations.find((station) => station.id === "upstream"), own = f.stations.find((station) => station.id === "own");
    upstream.fixedPurchases = initialFixed ? [{ amount: 300, days: 30 }] : [];
    upstream.cnyPerUsd = 6;
    own.cnyPerUsd = 7.1;
    const store = new Store(f.rt.pool);
    store.data.stations = f.stations;
    f.rt.store = store;
    const input = { preset: "yesterday", ruleIds: ["rr_live"] };
    const pending = f.module.queryRules(input, { mode: "observe", force: true });
    await wait.reached;
    await store.update("upstream", { fixedPurchases: initialFixed ? [] : [{ amount: 300, days: 30 }], cnyPerUsd: 6.9 });
    await store.update("own", { cnyPerUsd: 7.8 });
    const expectedBasis = initialFixed ? "usage" : "fixed", expectedProfit = initialFixed ? 1.5 : 2.5;
    const fresh = (await f.module.queryRules(input, { mode: "evaluate" })).results[0];
    assert.deepEqual([fresh.costBasis, fresh.calculation.profitUsd], [expectedBasis, expectedProfit], "新配置请求不能加入仍挂起的旧财务任务");
    wait.release();
    const row = (await pending).results[0];
    assert.deepEqual([row.health.code, row.costBasis, row.calculation.profitUsd], ["READY", expectedBasis, expectedProfit]);
    assert.ok(f.state.statCalls.filter((call) => call.side === "upstream").length >= 2, "配置改变后必须重新核算，不能给旧结果换个计法标签");
    assert.equal(f.state.ledger.length, 1);
    assert.deepEqual(f.state.ledger.map((entry) => [entry.revision, entry.cost_basis, entry.revenue_rate, entry.cost_rate, entry.detail.result.calculation.profitUsd]),
      [[1, expectedBasis, 7.8, 6.9, expectedProfit]]);
    assert.ok([...f.state.snapshots.values()].every((snapshot) => JSON.parse(snapshot.source).result.costBasis === expectedBasis), "旧配置的观察也不能提交");
    f.rt._reconciliationResultCache.clear();
    const fixed = (await f.module.queryRules(input, { mode: "evaluate", force: true })).results[0];
    assert.deepEqual([fixed.calculation.profitUsd, fixed.rates.costBasis, fixed.rates.income.cnyPerUsd, fixed.rates.cost.cnyPerUsd],
      [expectedProfit, expectedBasis, 7.8, 6.9]);
  });
});

test("未固定结果缓存随成本计法和任一侧汇率变化失效，页面不沿用旧利润", async (t) => {
  const f = await completedDayFixture(t);
  const store = new Store(f.rt.pool);
  store.data.stations = f.stations;
  f.rt.store = store;
  await store.update("upstream", { cnyPerUsd: 6 });
  await store.update("own", { cnyPerUsd: 7.1 });
  const query = () => f.module.queryRules({ preset: "today", ruleIds: ["rr_live"] }, { mode: "evaluate" });
  assert.equal((await query()).results[0].calculation.profitUsd, 1.5);
  let calls = f.state.statCalls.length;
  await store.update("upstream", { fixedPurchases: [{ amount: 300, days: 30 }] });
  const changed = (await query()).results[0];
  assert.deepEqual([changed.calculation.profitUsd, changed.rates.costBasis], [2.5, "fixed"]);
  assert.ok(f.state.statCalls.length > calls);
  for (const [stationId, rate] of [["own", 7.8], ["upstream", 6.9]]) {
    calls = f.state.statCalls.length;
    await store.update(stationId, { cnyPerUsd: rate });
    const row = (await query()).results[0];
    assert.ok(f.state.statCalls.length > calls, `${stationId} 汇率修改不能复用旧财务配置的缓存`);
    assert.equal(stationId === "own" ? row.rates.income.cnyPerUsd : row.rates.cost.cnyPerUsd, rate);
    assert.equal(row.calculation.profitUsd, 2.5);
  }
  assert.equal(f.state.writes, 0, "只读页面计算仍然不写库");
});

test("4a 固定采购上游：Key 账单取不到或为空只作参考，毛利 = 收入、按本站时区照常结账；按用量计成本的上游仍被挡住", async (t) => {
  for (const [label, quota] of [["取不到", null], ["为空", 0]]) {
    for (const fixed of [true, false]) {
      await t.test(`${label}·${fixed ? "固定采购" : "按用量"}`, async (st) => {
        const f = await completedDayFixture(st);
        if (fixed) f.stations.find((station) => station.id === "upstream").fixedPurchases = [{ amount: 300, days: 30 }];
        f.state.upstreamQuota = quota;
        const [row] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" })).results;
        const upstreamIssues = row.health.issues.filter((issue) => issue.side === "upstream");
        assert.ok(upstreamIssues.length, JSON.stringify(row.health));
        if (fixed) {
          assert.deepEqual([row.health.code, row.calculation.profitUsd, row.costBasis], ["READY", 2.5, "fixed"], JSON.stringify(row.health));
          assert.ok(upstreamIssues.every((issue) => issue.reference === true));
          assert.deepEqual(row.billingTimezone, { state: "verified", timezone: "Asia/Shanghai" }, "成本不取自上游账单，只看本站一侧的时区");
        } else {
          assert.equal(row.calculation.profitUsd, null);
          assert.notEqual(row.health.code, "READY");
          assert.ok(upstreamIssues.every((issue) => !issue.reference));
        }
        await f.module.refreshDue(Date.now());
        const ledger = f.state.ledger.filter((entry) => entry.rule_id === "rr_live");
        assert.deepEqual(ledger.map((entry) => [entry.cost_usd, entry.cost_basis, entry.revenue_usd, entry.detail.result.calculation.profitUsd]),
          fixed ? [[quota == null ? null : 0, "fixed", 2.5, 2.5]] : [], "固定采购照常结账，成本记原始 Key 用量（取不到为空）");
      });
    }
  }
});

test("C1 成本计法在提前返回之前就定：固定成本、锚定过的上游一侧读不到（Key 用不了、目录或身份读不到、上游账号换了人），只作参考，毛利 = 收入、照常结账，不拿读到的目录当证据；本站一侧、没锚定过的照旧挡；按用量的照旧挡", async (t) => {
  const reply = (host, pathname, body) => ({ host, pathname, body });
  const keyDisabled = reply("upstream.test", "/api/token/", { success: true, data: { total: 3, items: [
    { id: 9, user_id: 7, name: "stable", status: 2, group: "g1", cross_group_retry: false },
    { id: 10, user_id: 7, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
    { id: 11, user_id: 7, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } });
  // [说明, 固定成本时要有的上游侧参考问题码, 按用量时的健康码, 设置]
  const cases = [
    ["Key 停用了", "KEY_INVALID_OR_DENIED", "KEY_INVALID_OR_DENIED", { replies: [keyDisabled] }],
    ["Key 目录读不到", "UPSTREAM_DATA_UNAVAILABLE", "UPSTREAM_DATA_UNAVAILABLE", { options: { metadataFailure: true } }],
    ["上游账号身份读不到", "UPSTREAM_DATA_UNAVAILABLE", "UPSTREAM_DATA_UNAVAILABLE", { replies: [reply("upstream.test", "/api/user/self", { success: false })] }],
    ["上游账号换了人", "SOURCE_BINDING_UNCONFIRMED", "SOURCE_BINDING_UNCONFIRMED", { replies: [reply("upstream.test", "/api/user/self", { success: true, data: { id: 8 } })] }],
    // 换成的 8 号账号里也有一把 id 9 的 Key，名字不同：不能拿它来显示、记账
    ["上游账号换了人，新账号里 id 相同的 Key 名字不同", "KEY_INVALID_OR_DENIED", "KEY_INVALID_OR_DENIED", { replies: [reply("upstream.test", "/api/user/self", { success: true, data: { id: 8 } }),
      reply("upstream.test", "/api/token/", { success: true, data: { total: 1, items: [{ id: 9, user_id: 8, name: "别人的 Key", status: 1, group: "g1", cross_group_retry: false }] } })] }],
    ["本站读不到（本站一侧照旧挡）", null, "OWN_BILLING_UNAVAILABLE", { ownDown: true, blocksFixed: true }],
    ["本站账号换了人（本站一侧照旧挡）", null, "SOURCE_BINDING_UNCONFIRMED", { blocksFixed: true, replies: [reply("own.test", "/api/user/self", { success: true, data: { id: 9 } })] }],
    ["没锚定过、上游账号身份读不到（照旧挡）", null, "UPSTREAM_DATA_UNAVAILABLE", { unanchored: "canonicalKey", blocksFixed: true, replies: [reply("upstream.test", "/api/user/self", { success: false })] }],
    ["只缺本站来源的锚定、Key 停用（照旧挡）", null, "KEY_INVALID_OR_DENIED", { unanchored: "ownSource", blocksFixed: true, replies: [keyDisabled] }],
  ];
  for (const [label, referenceCode, usageCode, { replies = [], options = {}, ownDown = false, unanchored = null, blocksFixed = false }] of cases) {
    for (const fixed of [true, false]) {
      await t.test(`${label}·${fixed ? "固定成本" : "按用量"}`, async (st) => {
        const f = await completedDayFixture(st, options);
        if (fixed) f.stations.find((station) => station.id === "upstream").fixedPurchases = [{ amount: 300, days: 30 }];
        if (ownDown) f.state.ownQuota = null;
        const live = f.rows.find((row) => row.id === "rr_live");
        if (unanchored === "canonicalKey") live.canonical_key = null;
        if (unanchored === "ownSource") live.source_binding.ownSource = null;
        if (replies.length) {
          const prev = globalThis.fetch;
          st.mock.method(globalThis, "fetch", async (input, init) => {
            const url = new URL(String(input));
            const hit = replies.find((item) => item.host === url.host && item.pathname === url.pathname);
            if (hit) return { status: hit.body.success ? 200 : 500, text: async () => JSON.stringify(hit.body) };
            return prev(input, init);
          });
        }
        const [row] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" })).results;
        const passes = fixed && !blocksFixed;
        if (passes) {
          assert.deepEqual([row.health.code, row.calculation.profitUsd, row.costBasis], ["READY", 2.5, "fixed"], JSON.stringify(row.health));
          const upstreamIssues = row.health.issues.filter((issue) => issue.side === "upstream");
          assert.ok(upstreamIssues.length && upstreamIssues.every((issue) => issue.reference === true), JSON.stringify(row.health.issues));
          assert.ok(upstreamIssues.some((issue) => issue.code === referenceCode), JSON.stringify(upstreamIssues));
          assert.equal(f.state.statCalls.filter((call) => call.side === "upstream").length, 0, "上游读不到时不取上游用量");
          assert.equal(row.rule.tokenName, "stable", "Key 名用绑定上存的，不用读到的目录");
        } else {
          assert.deepEqual([row.calculation.profitUsd, row.health.code], [null, usageCode], JSON.stringify(row.health));
        }
        // 页面「刷新」（观测）也一样，不出错
        const [observed] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual" })).results;
        assert.equal(observed.calculation.profitUsd, passes ? 2.5 : null, JSON.stringify(observed.health));
        await f.module.refreshDue(Date.now());
        const ledger = f.state.ledger.filter((entry) => entry.rule_id === "rr_live");
        assert.deepEqual(ledger.map((entry) => [entry.cost_usd, entry.cost_basis, entry.revenue_usd, entry.detail.result.calculation.profitUsd]),
          passes ? [[null, "fixed", 2.5, 2.5]] : [], "固定成本照常结账，上游用量没读，成本记空");
        if (passes) {
          // 读到的上游身份、Key 不进账本（上游账号可能已经换了人）；以前的每日记录不把这天说成「数据不完整」
          const { ruleEvidence } = ledger[0].detail;
          assert.deepEqual([ruleEvidence.upstreamIdentity, ruleEvidence.tokenId, ruleEvidence.tokenName], [null, 9, "stable"]);
          assert.equal(ledger[0].detail.upstream?.tokenId, undefined, "快照里不记读到的 Key");
          const history = await f.module.getConfirmedHistory("rr_live", { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") });
          assert.deepEqual(history.records.map((record) => [record.sourceCompleteness, record.upstreamSource.tokenName]), [["complete", "stable"]]);
        }
      });
    }
  }
});

test("C1 第二轮：固定成本、上游账号换了人时，读到的目录不拿来改分段、不拿去读上游用量、不进快照（N1–N3）", async (t) => {
  const reply = (host, pathname, body) => ({ host, pathname, body });
  const otherAccount = [reply("upstream.test", "/api/user/self", { success: true, data: { id: 8 } }),
    // 8 号账号里也有一把 id 9 的 Key，名字一样，但在别的分组（倍率 2）
    reply("upstream.test", "/api/token/", { success: true, data: { total: 1, items: [{ id: 9, user_id: 8, name: "stable", status: 1, group: "g2", cross_group_retry: false }] } })];
  const setup = async (st, replies, options = {}) => {
    const f = await completedDayFixture(st, options);
    f.stations.find((station) => station.id === "upstream").fixedPurchases = [{ amount: 300, days: 30 }];
    const prev = globalThis.fetch;
    st.mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(String(input));
      const hit = replies.find((item) => item.host === url.host && item.pathname === url.pathname);
      if (hit) return { status: hit.body.success ? 200 : 500, text: async () => JSON.stringify(hit.body) };
      return prev(input, init);
    });
    return f;
  };
  const segmentsOf = (f) => f.repository.tables.segments.filter((segment) => segment.rule_id === "rr_live")
    .map((segment) => [segment.group_name, segment.group_ratio, segment.effective_to_ms]);

  await t.test("N3 刷新今天以后，分段和倍率都不变", async (st) => {
    const f = await setup(st, otherAccount);
    const before = segmentsOf(f);
    await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" });
    await f.module.refreshDue(Date.now());
    assert.deepEqual(segmentsOf(f), before, "不按别人的 Key 切到 g2");
    assert.deepEqual(f.state.ratioWrites, []);
  });

  await t.test("N1 Key 用不了、本站账号也换了人：不拿那把 Key 去读上游用量", async (st) => {
    const keyDisabled = reply("upstream.test", "/api/token/", { success: true, data: { total: 3, items: [
      { id: 9, user_id: 7, name: "stable", status: 2, group: "g1", cross_group_retry: false },
      { id: 10, user_id: 7, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
      { id: 11, user_id: 7, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } });
    const f = await setup(st, [keyDisabled, reply("own.test", "/api/user/self", { success: true, data: { id: 9 } })]);
    const [row] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" })).results;
    assert.equal(row.health.code, "SOURCE_BINDING_UNCONFIRMED");
    assert.equal(f.state.statCalls.filter((call) => call.side === "upstream").length, 0, "不读上游用量");
    assert.notEqual(row.upstream?.state, "complete");
  });

  await t.test("N2 没有分段时提前返回：观测快照里不记别人的 Key", async (st) => {
    const f = await setup(st, otherAccount);
    f.repository.tables.segments = f.repository.tables.segments.filter((segment) => segment.rule_id !== "rr_live");
    await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" });
    const sources = f.repository.tables.snapshots.filter((row) => row.rule_id === "rr_live")
      .map((row) => typeof row.source === "string" ? JSON.parse(row.source) : row.source);
    assert.ok(sources.length, "写了观测快照");
    assert.ok(sources.every((source) => source.upstream?.group !== "g2" && source.upstream?.ratio !== 2), "不记别人那把 Key 的分组、倍率");
    assert.ok(sources.every((source) => source.ruleEvidence?.upstreamIdentity == null), "也不记换成的那个上游账号");
  });
});

test("C1 固定成本的上游读不到时，面板类型按绑定存的；旧绑定没存就按上游站点的类型（Sub2API 不会被当成 New API）", async (t) => {
  const f = await completedDayFixture(t, { metadataFailure: true });
  const upstream = f.stations.find((station) => station.id === "upstream");
  Object.assign(upstream, { type: "sub2api", fixedPurchases: [{ amount: 300, days: 30 }] });
  const live = f.rows.find((row) => row.id === "rr_live");
  live.provider = null;
  const [row] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" })).results;
  assert.deepEqual([row.costBasis, row.calculation.profitUsd, row.amountBasis.conversion], ["fixed", 2.5, "provider_cost_usd"], JSON.stringify(row.health));
});

test("4a 固定采购上游：Key 还有没有其他用途没确认、上游分组目录取不到只作参考，毛利 = 收入、照常结账；按用量计成本的上游仍被挡住", async (t) => {
  const cases = [
    ["用途待确认", "COST_COVERAGE_UNKNOWN", {}, (f) => {
      const row = f.rows.find((rule) => rule.id === "rr_live");
      row.cost_coverage = "unknown";
      row.source_binding.coverageDeclaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
    }],
    ["分组目录取不到", "GROUP_DATA_UNAVAILABLE", { metadataGroups: () => ({ g2: { ratio: 2 } }) }, () => {}],
  ];
  for (const [label, code, options, setup] of cases) {
    for (const fixed of [true, false]) {
      await t.test(`${label}·${fixed ? "固定采购" : "按用量"}`, async (st) => {
        const f = await completedDayFixture(st, options);
        setup(f);
        if (fixed) f.stations.find((station) => station.id === "upstream").fixedPurchases = [{ amount: 300, days: 30 }];
        const [row] = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "evaluate", force: true, origin: "manual" })).results;
        const issue = row.health.issues.find((item) => item.code === code);
        assert.ok(issue, JSON.stringify(row.health));
        if (fixed) {
          assert.deepEqual([issue.side, issue.reference], ["upstream", true]);
          assert.deepEqual([row.health.code, row.calculation.profitUsd], ["READY", 2.5], JSON.stringify(row.health));
        } else {
          assert.equal(issue.reference, undefined);
          if (code === "COST_COVERAGE_UNKNOWN") assert.equal(row.calculation.profitUsd, null);
          assert.notEqual(row.health.code, "READY");
        }
        await f.module.refreshDue(Date.now());
        const ledger = f.state.ledger.filter((entry) => entry.rule_id === "rr_live");
        assert.equal(ledger.length, fixed || code !== "COST_COVERAGE_UNKNOWN" ? 1 : 0, "固定采购照常结账");
        if (fixed) assert.deepEqual([ledger[0].cost_basis, ledger[0].detail.result.calculation.profitUsd], ["fixed", 2.5]);
      });
    }
  }
});

// ---- C2a：结账状态表、回看、退避、手动也走 settle ----

const states = (f) => f.repository.tables.settlementState.map((row) => [row.rule_id, row.bill_date, row.retry_reason ?? row.manual_reason, row.attempts]).sort();
const ledgerDays = (f) => f.state.ledger.map((row) => [row.rule_id, row.bill_date]).sort();

test("C2a 回看：昨天不占预算；更早的日子每轮最多 K 天、同一个上游同时 1 天、这一轮没成就不再给这个上游取；没结成的记进状态表，结成了删掉", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 上海 10-09 11:00；开始统计是 10-07 0 点，10-07、10-08 两天能结
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 2, lookbackTimeMs: 60000 } });
  // 自营有收入、上游账单读不到：主码是 WAITING_FOR_BILL，UPSTREAM_DATA_UNAVAILABLE 只在 health.issues 的上游那一侧里，
  // 「同一上游这一轮不再取别的日子」要看 issues（审核 C2a 第二轮低-2）
  f.state.upstreamQuota = null; // 上游账单读不到
  // 方案钉住的性能点：每轮只批量读两次（状态表、账本近几天的日期），不按绑定逐条查（安全审核 C2a 低-7）
  const reads = { listSettlementStates: [], listLedgerDays: [] };
  const beforeRead = f.repository.hooks.beforeRead;
  f.repository.hooks.beforeRead = (name, args) => {
    if (name in reads) reads[name].push(args);
    return beforeRead?.(name, args);
  };
  await f.module.refreshDue(now);
  assert.equal(reads.listSettlementStates.length, 1, "这一轮只批量读一次状态表，不按绑定逐条查");
  assert.equal(reads.listLedgerDays.length, 1, "这一轮只批量读一次账本近几天的日期，不按绑定逐条查");
  assert.ok(reads.listSettlementStates[0][0].length >= 3, "一次性带着这一轮全部绑定的 id（SQL 的 rule_id IN），不是单个 id");
  assert.deepEqual(new Set(reads.listSettlementStates[0][0]), new Set(["rr_live", "rr_two", "rr_three"]));
  assert.deepEqual(states(f), [
    ["rr_live", "2026-10-07", "WAITING_FOR_BILL", 1],
    ["rr_live", "2026-10-08", "WAITING_FOR_BILL", 1], ["rr_three", "2026-10-08", "WAITING_FOR_BILL", 1], ["rr_two", "2026-10-08", "WAITING_FOR_BILL", 1],
  ], "昨天三条都试；更早的那天只试了一天：三条共用一个上游，限流/连不上这一轮它没成就不再取（方案 6.4）");
  assert.deepEqual(ledgerDays(f), []);

  // 上游好了，10 分钟后：昨天三条都结；更早的日子预算 2 天，一个上游一次一天
  f.state.ownQuota = 250;
  f.state.upstreamQuota = 100;
  now += 10 * 60000;
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((row) => row.bill_date === "2026-10-08").length, 3, "昨天三条都结了");
  assert.equal(f.state.ledger.filter((row) => row.bill_date === "2026-10-07").length, 2, "更早的日子这一轮只取 2 天");
  assert.deepEqual(states(f), [], "试过的都结成了，状态行删掉；还剩一天没轮到（没试过的没有行）");
  now += 60000;
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.length, 6, "剩下那天下一轮结了");
  now += 60000;
  const calls = f.state.statCalls.length;
  await f.module.refreshDue(now);
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  assert.equal(f.state.statCalls.slice(calls).filter((call) => call.start < todayStart).length, 0, "账本里都有了：只观测今天，不再取过去的日子");
});

test("C2a 低-4（第二轮低-2 后）：自营有收入、上游读不到时主码是 WAITING_FOR_BILL，issues 里上游那一侧是 UPSTREAM_DATA_UNAVAILABLE——同一上游这一轮只试一个更早的日子", async (t) => {
  let now = Date.parse("2026-10-10T03:00:00Z"); // 上海 10-10 11:00；开始统计 10-07 0 点：昨天 10-09，更早两天 10-08、10-07
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  // 默认自营这边有收入（ownQuota: 250）：上游这边读不到时主码是 WAITING_FOR_BILL（这天的账单还没读全），上游整体读不到的信号在 issues 里，
  // 回看要看 issues（审核 C2a 第二轮低-2：实测 40 条绑定积压、上游挂着时，只看主码一轮打了 55 次）
  f.state.upstreamQuota = null;
  await f.module.refreshDue(now);
  assert.deepEqual(states(f).filter((row) => row[0] === "rr_live").map((row) => [row[1], row[2]]),
    [["2026-10-08", "WAITING_FOR_BILL"], ["2026-10-09", "WAITING_FOR_BILL"]], "昨天试了；更早的只试了最新一天，10-07 这一轮不再给同一个上游取");
});

test("C2b 低-4：读账单报「接口对不上」（404）这类只挡这一天，同一上游别的日子这一轮照样试；限流、5xx、连不上才不再给它取别的日子", async (t) => {
  let now = Date.parse("2026-10-10T03:00:00Z"); // 昨天 10-09，更早两天 10-08、10-07
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  let status = 404;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/log/self/stat" && url.searchParams.get("token_name") === "stable") {
      f.state.statCalls.push({ side: "upstream", start: Number(url.searchParams.get("start_timestamp")), end: Number(url.searchParams.get("end_timestamp")) });
      return { status, text: async () => JSON.stringify({ success: false, message: "x" }) };
    }
    return prev(input, init);
  });
  const triedDays = () => states(f).filter((row) => row[0] === "rr_live").map((row) => row[1]);
  await f.module.refreshDue(now);
  assert.deepEqual(triedDays(), ["2026-10-07", "2026-10-08", "2026-10-09"], "404：不是限流也不是连不上，三天都试了（以前统一收成 UPSTREAM_DATA_UNAVAILABLE 会被当成上游整体读不到）");
  // 限流（429）：这个上游这一刻整体读不到，昨天试了以后更早的只再试最新一天
  f.repository.tables.settlementState.length = 0;
  status = 429;
  now += 3600000;
  await f.module.refreshDue(now);
  assert.deepEqual(triedDays(), ["2026-10-08", "2026-10-09"], "429：更早的日子只试了最新一天");
});

test("C2a 中-2：改绑定之前还没固定的日子，D3 做好以前回看不自动结；昨天照旧、手动照常能结（安全审核 C2a 中-2，总指挥 10-25 定）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 上海 10-09 11:00；开始统计 10-07 0 点：昨天 10-08，更早一天 10-07
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  const OLDER = { startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: Date.parse("2026-10-07T16:00:00Z") }; // 10-07
  const liveStates = () => states(f).filter((row) => row[0] === "rr_live").map((row) => row[1]);
  const liveLedger = () => ledgerDays(f).filter((row) => row[0] === "rr_live").map((row) => row[1]).sort();
  f.state.upstreamQuota = null; // 上游读不到，攒出两天没结
  await f.module.refreshDue(now);
  assert.deepEqual(liveLedger(), []);
  assert.deepEqual(liveStates(), ["2026-10-07", "2026-10-08"], "两天都留了状态行");

  // 改绑定：绑定早就建好了（创建时刻定在两天之前），只是这把绑定的 scope 版本往前走一位，生效时刻晚于这两天结束——
  // reconciliationAccountingStart 取 createdAt 和 billingEffectiveFrom 两者较早的那个，createdAt 够早时「开始统计之前」
  // 不会被误判，这条新约束才用得上（不然会被更早的 not_effective 挡住，根本走不到这条判断）
  const row = f.repository.tables.rules.find((r) => r.id === "rr_live");
  row.created_at = new Date("2026-10-01T00:00:00Z");
  row.scope_version = Number(row.scope_version || 1) + 1;
  row.billing_effective_from_ms = now;
  f.state.upstreamQuota = 100; // 上游恢复
  now += 10 * 60000; // 等到退避表第一档的重试时刻
  await f.module.refreshDue(now);
  assert.deepEqual(liveLedger(), ["2026-10-08"], "昨天照旧自动结了；更早那天改绑定之前还没固定，回看不自动结");
  assert.deepEqual(liveStates(), ["2026-10-07"], "这天的状态行还在，没有被回看清掉");

  // 手动「重新读取」照常能结
  const manual = (window) => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: window.startMs, endMs: window.endMs }, { mode: "observe", force: true, origin: "manual" });
  const result = (await manual(OLDER)).results[0];
  assert.ok(result.settledAt, "手动不受这条约束，照常能结");
  assert.deepEqual(liveLedger(), ["2026-10-07", "2026-10-08"]);
  assert.deepEqual(liveStates(), [], "状态行在记账的事务里删掉了");
  // 再跑一轮回看：两天都已经有账本了，不再触发这条约束
  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(liveLedger(), ["2026-10-07", "2026-10-08"]);
});

test("C2a 中-A：这把 Key 还给别处用吗没回答时没结的日子，回答（改了绑定，生效时刻往后推）以后回看能结，按新回答算（总指挥 10-25，D 设计稿 §3.1 第 2 种）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 开始统计 10-07 0 点：昨天 10-08，更早一天 10-07
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  const live = f.repository.tables.rules.find((r) => r.id === "rr_live");
  live.created_at = new Date("2026-10-01T00:00:00Z");
  live.cost_coverage = "unknown";
  live.source_binding.coverageDeclaration = { answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] };
  const liveStates = () => states(f).filter((row) => row[0] === "rr_live").map((row) => [row[1], row[2]]);
  const liveLedger = () => f.state.ledger.filter((row) => row.rule_id === "rr_live");
  await f.module.refreshDue(now);
  assert.deepEqual(liveLedger(), [], "没回答：结不了");
  assert.deepEqual(liveStates(), [["2026-10-07", "COST_COVERAGE_UNKNOWN"], ["2026-10-08", "COST_COVERAGE_UNKNOWN"]]);

  // 回答：改成已确认，走 updateRule 的效果——代次往前一位、生效时刻推到现在，晚于这两天结束
  live.cost_coverage = "complete";
  delete live.source_binding.coverageDeclaration;
  live.scope_version = Number(live.scope_version || 1) + 1;
  live.billing_effective_from_ms = now;
  now += 10 * 60000;
  await f.module.refreshDue(now); // 到了重判的时刻：本地看挡着的原因没了，记 cleared
  now += 60000;
  await f.module.refreshDue(now); // 下一轮去结
  assert.deepEqual(liveLedger().map((row) => row.bill_date).sort(), ["2026-10-07", "2026-10-08"], "更早那天也不被 blocked 挡着，两天都结了");
  assert.ok(liveLedger().every((row) => row.detail.result.calculation.profitUsd != null), "按新回答算出了毛利");
  assert.deepEqual(liveStates(), []);
});

test("C2a 回看每轮最多补 15 个「绑定×天」：积压 18 个只补最新的 15 个，剩下的下一轮接着补；昨天不占这 15 个（审核 C2a 积压场景）", async (t) => {
  assert.equal(SETTLE_LOOKBACK_MAX_PER_ROUND, 15);
  let now = Date.parse("2026-10-16T03:00:00Z"); // 上海 10-16 11:00；开始统计 10-07 0 点：昨天 10-15；更早 10-09 到 10-14 共 6 天，三条绑定一共 18 个
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 100, lookbackTimeMs: 60000 } });
  const booked = () => f.state.ledger.map((row) => row.bill_date);
  const count = (date) => booked().filter((day) => day === date).length;
  await f.module.refreshDue(now);
  assert.equal(count("2026-10-15"), 3, "昨天三条都结了，不占这 15 个");
  const older = booked().filter((day) => day !== "2026-10-15");
  assert.equal(older.length, SETTLE_LOOKBACK_MAX_PER_ROUND, "更早的日子这一轮只补 15 个，不是 18 个");
  assert.equal(count("2026-10-09"), 0, "最老的那天没轮到：新的日子先补");
  for (const date of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]) assert.equal(count(date), 3, `${date} 三条都补了`);
  now += 60000;
  await f.module.refreshDue(now);
  assert.equal(count("2026-10-09"), 3, "剩下的下一轮接着补");
});

test("C2a 回看有时间上限：已经发出去的那一天照常做完，用到时间就停，剩下的下一轮接着取；今天的观测在回看之前做完", async (t) => {
  let now = Date.parse("2026-10-12T03:00:00Z"); // 开始统计 10-07 0 点：10-07 到 10-11 共 5 天，其中 10-11 是昨天
  const order = [];
  const f = await completedDayFixture(t, { now: "2026-10-12T03:00:00Z", clock: () => now, extraRuleIds: [], channelsByRule: { rr_live: [1], rr_two: [2], rr_three: [3] },
    // 每取一次上游账单花 7 秒
    onRequest: (request) => { if (request.path === "/api/log/self/stat") { now += 7000; order.push(now); } },
    moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 100, lookbackTimeMs: 20000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const todayWrites = () => f.repository.log.snapshotWrites.filter((entry) => entry.source?.window?.preset === "today").length;
  await f.module.refreshDue(now);
  assert.equal(todayWrites(), 1, "今天先观测了");
  const booked = f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date).sort();
  assert.ok(booked.includes("2026-10-11"), "昨天不受时间上限");
  const older = booked.filter((day) => day !== "2026-10-11");
  assert.equal(older.length, 3, `第 0、7、14 秒各发出一天，第 21 秒用到 20 秒就停：${older}`);
  now += 60000;
  await f.module.refreshDue(now);
  now += 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date).sort(),
    ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"], "剩下的下一轮接着取");
});

test("C2a 启动后等一会儿才回看（今天、昨天照常）；重启以后退避还在，不提前重试", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 3 * 60000, lookbackBudget: 10 } });
  f.state.upstreamQuota = null;
  await f.module.refreshDue(now);
  assert.deepEqual([...new Set(states(f).map(([, day]) => day))], ["2026-10-08"], "等待期里只结昨天");
  now += 3 * 60000;
  await f.module.refreshDue(now);
  assert.ok(states(f).some(([, day]) => day === "2026-10-07"), "等够了开始回看");

  // 换一个运行时（当成重启），同一个仓库：昨天那几行还在退避里，不提前重试
  const attempts = states(f).filter(([, day]) => day === "2026-10-08").map(([, , , n]) => n);
  const rt = { pool: f.rt.pool, store: f.rt.store, onboardingSource: f.rt.onboardingSource };
  now += 60000;
  await createReconciliationModule(rt, { repository: f.repository, lookbackDelayMs: 0 }).refreshDue(now);
  assert.deepEqual(states(f).filter(([, day]) => day === "2026-10-08").map(([, , , n]) => n), attempts, "没到下次重试的时刻，重启后也不试");
});

test("C2a 手动「重新读取」过去的整天走结账：结不成只更新原因、不推后自动的退避、不计次数；结成了写账本、删状态行", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  f.state.upstreamQuota = null;
  await f.module.refreshDue(now);
  const before = f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  assert.deepEqual([before.attempts, before.next_attempt_at_ms], [1, now + 10 * 60000]);
  const manual = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
  now += 60000;
  const failed = (await manual()).results[0];
  assert.equal(failed.calculation.profitUsd, null);
  const after = f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  assert.deepEqual([after.attempts, after.next_attempt_at_ms, after.last_attempt_at_ms], [1, now - 60000 + 10 * 60000, now], "手动的不计次数、不推后退避");
  f.state.upstreamQuota = 100;
  now += 60000;
  const settled = (await manual()).results[0];
  assert.equal(settled.calculation.profitUsd, 1.5);
  assert.ok(settled.settledAt, "结成了");
  assert.equal(f.repository.tables.settlementState.some((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08"), false, "状态行在记账的事务里删掉");
  assert.deepEqual(f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => [row.bill_date, row.revision, row.source, row.detail.settlement?.trigger]),
    [["2026-10-08", 1, "settle", "manual"]], "账本明细记下是手动结的");
});

test("C2a 结成新版以后不再读一次账本行：result 自己就是刚写进去的那一版（安全审核 C2a 低-3）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  let reads = 0;
  const beforeRead = f.repository.hooks.beforeRead;
  f.repository.hooks.beforeRead = (name, args) => {
    if (name === "latestLedgerEntry") reads += 1;
    return beforeRead?.(name, args);
  };
  const manual = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
  const settled = (await manual()).results[0];
  assert.ok(settled.settledAt, "结成了");
  assert.equal(reads, 2, "只剩取数前读已固定的账、previousSuccess 两次；写了新版以后 bookedResult 不再多读一次（以前是 3 次）");
  // 和真的从账本行读出来的 ledgerReference 一样（版本、来源、固定时刻、汇率、成本计法），不是另算一份
  const row = f.state.ledger.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.deepEqual(settled.ledger, { billDate: row.bill_date, revision: row.revision, source: row.source, settledAt: settled.settledAt,
    rates: { income: row.revenue_rate ?? null, cost: row.cost_rate ?? null }, costBasis: row.cost_basis }, "result.ledger 直接补好，和账本里写进去的那一行一致");
});

test("C2a 第二轮低-3：result.ledger 的汇率按账本精度（6 位小数）取整、来源是账本里的来源，带 lastConfirmed；和之后从账本读出来的逐字一致", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  f.stations.find((station) => station.id === "own").cnyPerUsd = 7.1234567; // 第 7 位以后账本存不下
  f.stations.find((station) => station.id === "upstream").cnyPerUsd = 6.5;
  const window = { startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs };
  const manual = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", ...window }, { mode: "observe", force: true, origin: "manual" });
  const written = (await manual()).results[0];
  assert.equal(written.ledger.rates.income, 7.123457, "按账本的 6 位小数取整");
  const read = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", ...window }, { mode: "evaluate", origin: "page" })).results[0];
  assert.deepEqual(written.ledger, read.ledger, "写的那次和之后读出来的逐字一致（汇率、来源、版本、固定时刻）");
  assert.deepEqual(written.lastConfirmed, read.lastConfirmed, "最近确认的那份也带上");
  assert.equal(written.lastSuccessfulAt, read.lastSuccessfulAt);
});

test("C2a 结账时渠道目录用 10 分钟内的缓存：一轮结好几天，只读一次渠道目录，不是每天一次（安全审核 C2a 低-3）", async (t) => {
  let now = Date.parse("2026-10-11T03:00:00Z"); // 开始统计 10-07 0 点：昨天 10-10，更早 10-08、10-09 共三天，三天都没结
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const channelReads = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/channel/").length;
  await f.module.refreshDue(now);
  const settled = f.state.ledger.filter((row) => row.rule_id === "rr_live").length;
  assert.ok(settled >= 3, `这一轮结了好几天：${settled}`);
  assert.ok(channelReads() <= 2, `结 ${settled} 天，渠道目录最多读一两次（今天的观测一次，结账用缓存），实际 ${channelReads()} 次`);
});

// ---- R1 每日利润的收入扣掉管理员自用（own-revenue-plan 第一节，用户 10-25 定）：收入是渠道的收费统计减掉管理员自己花的钱，转售的管理员 Key 照算收入，
// 渠道测试（type 2、token_id 0、固定名字）只兜底扣不在管理员名下的；固定进账本的也是减过的 ----
const ydayStart = COMPLETED_YESTERDAY.startMs / 1000;
const usage = (id, quota, extra = {}) => ({ id, channel: 1, quota, created_at: ydayStart + 100 + id, token_name: "root-key", username: "root", ...extra });
const manualYesterday = (f) => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
const sourceReads = (f) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/" && request.sourceRead).length;

test("R1 结账：渠道收费里管理员自己花的钱减掉再固定进账本，计算明细带上减掉的美元；累计和全站总额度相等时不重翻", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  // 渠道 1 的收费统计 250 额度，里面有管理员 root 花的 30 + 20，还有普通用户 alice 的（不减）
  f.state.testLogs.push(usage(1, 30), usage(2, 20, { token_name: "other-key" }), usage(3, 77, { username: "alice", token_name: "alice-key" }));
  const settled = (await manualYesterday(f)).results[0];
  assert.equal(settled.downstream.quotaUnits, 200, "250 − 管理员的 50");
  assert.equal(settled.downstream.amountUsd, 2);
  assert.equal(settled.downstream.adminUsageAmountUsd, 0.5, "计算明细：其中管理员自用");
  const row = f.state.ledger.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.equal(row.detail.result.downstream.amountUsd, 2, "固定进账本的收入是减过的");
  assert.equal(row.detail.result.downstream.adminUsageAmountUsd, 0.5);
  assert.equal(sourceReads(f), 1, "有消费的只有 root：它的累计和全站总额度对上了，没有整段重翻；测试名字下总额度是 0，不翻列表");
});

test("R1 转售的管理员 Key 照样算收入：它名下的行不减", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  f.stations.find((station) => station.id === "own").resoldAdminKeys = [{ username: "root", tokenName: "resale-key" }];
  f.state.testLogs.push(usage(1, 30), usage(2, 100, { token_name: "resale-key" }));
  const settled = (await manualYesterday(f)).results[0];
  assert.equal(settled.downstream.quotaUnits, 220, "只减 root 自己用的 30，转售那把的 100 照算收入");
  assert.equal(settled.downstream.adminUsageAmountUsd, 0.3);
});

test("R1 兜底：渠道测试记录（token_id 0、固定名字）在普通用户名下的才减，在管理员名下的已经在管理员那一条里，不减两次", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  f.state.testLogs.push(
    usage(1, 30, { token_name: "模型测试" }), // 管理员发起的测试：按管理员减一次
    usage(2, 20, { token_name: "Model test", username: "alice" }), // 记在普通用户名下的测试：兜底减
    usage(3, 999, { token_name: "模型测试", username: "alice", token_id: 7 }), // 普通用户自己的 Key 起了同名：token_id 不是 0，不减
  );
  const settled = (await manualYesterday(f)).results[0];
  assert.equal(settled.downstream.quotaUnits, 250 - 30 - 20);
  assert.equal(settled.downstream.adminUsageAmountUsd, 0.5);
});

test("R1 不是管理员的不减：用户列表里 role 小于 10 的名下的消费都算收入", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  f.state.testLogs.push(usage(1, 40, { username: "alice", token_name: "alice-key" }));
  const settled = (await manualYesterday(f)).results[0];
  assert.equal(settled.downstream.quotaUnits, 250);
  assert.equal(settled.downstream.adminUsageAmountUsd, 0);
  assert.equal(sourceReads(f), 0, "root 名下没有消费、测试名字下也没有：结账只查了总额度，没翻列表");
});

test("R1 结账对账不等（日志晚写、编号比上次小）：整段重翻，晚写的那条也扣掉", async (t) => {
  let now = Date.parse("2026-10-08T12:00:00Z"); // 上海 10-08 20:00：这天还没过完，先在「今天」里把 root 的累计记下来
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  f.state.testLogs.push(usage(1, 30));
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" });
  // 之后补进来一条编号更小、时间更早的晚写日志：接着翻（按编号停）碰到旧编号就停，漏了它
  f.state.testLogs.push(usage(0, 15, { created_at: ydayStart + 50 }));
  now = Date.parse("2026-10-09T03:00:00Z");
  const settled = (await manualYesterday(f)).results[0];
  assert.equal(settled.downstream.adminUsageAmountUsd, 0.45, "累计只有 30，全站总额度是 45，对不上，整段重翻，晚写的 15 也扣了");
});

test("R1 今天：按各来源上次的编号接着翻，没有新日志时每个来源只翻第一页；新日志只加新的", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  f.state.testLogs.push({ id: 1, channel: 1, quota: 40, created_at: todayStart + 60, token_name: "root-key", username: "root" });
  const today = async () => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  const first = await today();
  assert.equal(first.downstream.quotaUnits, 210, "今天的收入减掉了管理员的 40");
  const afterFirst = sourceReads(f);
  now += 60000;
  f.state.testLogs.push({ id: 2, channel: 1, quota: 10, created_at: Math.floor(now / 1000) - 5, token_name: "root-key", username: "root" });
  const second = await today();
  assert.equal(second.downstream.quotaUnits, 200, "只加了新的 10，不是重算一遍");
  assert.equal(sourceReads(f) - afterFirst, 1, "一轮只读管理员 root 那一个来源的一页；渠道测试名字两个兜底来源 10 分钟内读过的不再读");
  now += 11 * 60000;
  const afterSecond = sourceReads(f);
  await today();
  assert.equal(sourceReads(f) - afterSecond, 1, "过了 10 分钟，兜底来源只用 stat 比一下（全在管理员名下就不翻页），列表只读管理员 root 那一页");
});

test("R1 今天翻到一半失败（限流）：下一轮从下一页接着翻，翻完再按编号补上中间新写进来的；不会每轮从第 1 页重来（审核 R1 中-2）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  for (let id = 1; id <= 250; id += 1) f.state.testLogs.push({ id, channel: 1, quota: id === 1 || id === 250 ? 1 : 0, created_at: todayStart + id, token_name: "root-key", username: "root" }); // 额度小，只为数页数；第 1 条和最后一条各 1
  const prev = globalThis.fetch, pages = [];
  let failPageTwo = true;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/" && url.searchParams.get("username") === "root") {
      pages.push(Number(url.searchParams.get("p")));
      if (failPageTwo && url.searchParams.get("p") === "2") return { status: 500, text: async () => "{}" };
    }
    return prev(input, init);
  });
  const today = async () => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  await today();
  assert.deepEqual(pages, [1, 2], "第 2 页失败");
  failPageTwo = false; pages.length = 0;
  now += 60000;
  // 失败到下一轮之间又写进来 5 条：终点往后挪了，第 1 页要补，不能漏
  for (let id = 251; id <= 255; id += 1) f.state.testLogs.push({ id, channel: 1, quota: 1, created_at: Math.floor(now / 1000) - 5, token_name: "root-key", username: "root" });
  const second = await today();
  assert.deepEqual(pages, [2, 3, 1], "先从第 2 页接着翻到底（用当时的终点），再按编号补一页新的，没有从第 1 页重来");
  assert.equal(second.downstream.adminUsageQuotaUnits, 2 + 5, "第 2 页接着翻到的两条加后写进来的 5 条，一条不漏不重");
});

test("R1 今天翻完补页那次失败：下一轮从补页接着来，用补页的终点，不漏（审核 R1 中-2）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  for (let id = 1; id <= 250; id += 1) f.state.testLogs.push({ id, channel: 1, quota: id === 1 || id === 250 ? 1 : 0, created_at: todayStart + id, token_name: "root-key", username: "root" });
  const prev = globalThis.fetch;
  let pageTwoRequests = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/" && url.searchParams.get("username") === "root" && url.searchParams.get("p") === "2") {
      pageTwoRequests += 1;
      // 第 1 次：第一轮翻到第 2 页失败；第 3 次：第二轮补页（新写进来的行有两页）补到第 2 页失败
      if (pageTwoRequests === 1 || pageTwoRequests === 3) return { status: 500, text: async () => "{}" };
    }
    return prev(input, init);
  });
  const today = async () => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  await today();
  now += 60000;
  for (let id = 251; id <= 400; id += 1) f.state.testLogs.push({ id, channel: 1, quota: 1, created_at: Math.floor(now / 1000) - 5, token_name: "root-key", username: "root" });
  await today();
  now += 60000;
  const third = await today();
  assert.equal(third.downstream.adminUsageQuotaUnits, 2 + 150, "补页失败的下一轮接着补：新写的 150 条一条不漏");
});

test("R1 多条绑定各要一个渠道、日志很多：按渠道 stat 只查没查过的渠道，第一页只读一次；过去窗口后面的轮询不再发请求（审核 R1 中-3）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  for (let id = 1; id <= 1200; id += 1) f.state.testLogs.push(usage(id, id <= 2 ? 1 : 0, { channel: id % 2 ? 1 : 2 })); // 额度小，只为让页数多；总额度 2
  f.state.testLogs.push(usage(4000, 1, { token_name: "模型测试", token_id: 0, channel: 1 })); // root 名下一条渠道测试（额度 1，总额度不是 0）：渠道测试名字那个来源有东西，要查「全在管理员名下吗」
  const rootReads = () => f.state.requests.filter((request) => request.host === "own.test" && /^\/api\/log\//.test(request.path) && /username=root/.test(request.query));
  const settle = (ruleId) => f.module.queryRules({ ruleIds: [ruleId], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
  await settle("rr_live");
  const afterFirst = rootReads().length, requestsBefore = f.state.requests.length;
  await settle("rr_two");
  const second = rootReads().slice(afterFirst);
  assert.ok(second.every((request) => request.path === "/api/log/stat"), `第二条绑定没有再翻页或读第一页：${second.map((r) => r.path).join(",")}`);
  const statChannels = second.filter((request) => /channel=/.test(request.query)).length;
  assert.ok(statChannels <= 1, `第二条绑定只补查渠道 2 一次：${statChannels}`);
  // 渠道测试名字那两个来源：第二条绑定只各查一次总额度（没变就沿用），不再查「每个管理员名下有多少」那几个 stat（审核 CI：每天结 80 条从 1.2 秒变 7–14 秒；审核 #127 低-1）
  const perAdminStats = (from) => f.state.requests.slice(from).filter((request) => request.host === "own.test" && request.path === "/api/log/stat" && /token_name=/.test(request.query) && /username=/.test(request.query)).length;
  assert.ok(perAdminStats(0) > 0, "第一条绑定查过每个管理员名下的");
  assert.equal(perAdminStats(requestsBefore), 0, "第二条绑定沿用，不再按管理员逐个查");
  // 总额度变了（晚到一条渠道测试记录）：第三条绑定（要算的渠道 3 还没覆盖，不走整份沿用）重查
  f.state.testLogs.push(usage(5000, 1, { token_name: "模型测试", token_id: 0, username: "alice", channel: 3 }));
  f.rows.find((row) => row.id === "rr_three").enabled = 1;
  const beforeChanged = f.state.requests.length;
  await settle("rr_three");
  assert.ok(perAdminStats(beforeChanged) > 0, "总额度变了：按管理员逐个重查");
  // 过了 10 分钟：重查（把 rr_two 这天的账本行拿掉，让它真的再结一次）
  now += 11 * 60000;
  const beforeLater = f.state.requests.length;
  for (let i = f.repository.tables.ledger.length - 1; i >= 0; i -= 1) if (f.repository.tables.ledger[i].rule_id === "rr_two") f.repository.tables.ledger.splice(i, 1);
  f.rt._reconciliationResultCache.clear();
  await settle("rr_two");
  assert.ok(perAdminStats(beforeLater) > 0, "第 11 分钟：不再沿用");
  // 过去窗口：页面再看（非结账）不发请求
  now += 5 * 60000;
  const before = rootReads().length;
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "evaluate", origin: "page", force: true });
  await f.module.queryRules({ ruleIds: ["rr_two"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "evaluate", origin: "page", force: true });
  assert.equal(rootReads().length - before, 0, "过去窗口的管理员日志不再读");
});

test("R1 合并补查：绑定从只要渠道 1 到又要渠道 2，已经查过的渠道 1 的数不能丢（审核 R1 低-2）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  const dayBefore = ydayStart - 86400; // 10-07，没固定：每次都现读
  for (let id = 1; id <= 1200; id += 1) f.state.testLogs.push(usage(id, id <= 2 ? 1 : 0, { channel: id % 2 ? 1 : 2, created_at: dayBefore + 100 + id }));
  const window = { startMs: COMPLETED_YESTERDAY.startMs - 86400000, endMs: COMPLETED_YESTERDAY.startMs };
  const view = async (ruleId) => (await f.module.queryRules({ ruleIds: [ruleId], preset: "custom", ...window }, { mode: "evaluate", origin: "page", force: true })).results[0];
  assert.equal((await view("rr_live")).downstream.adminUsageQuotaUnits, 1, "渠道 1 上管理员自用 1");
  assert.equal((await view("rr_two")).downstream.adminUsageQuotaUnits, 1, "渠道 2 上也是 1");
  now += 40000; // 过了 30 秒，不走「刚读过直接用」，要走合并补查那条
  assert.equal((await view("rr_live")).downstream.adminUsageQuotaUnits, 1, "合并了渠道 2 以后，渠道 1 的数还在");
});

test("R1 管理员自用扣没扣逐行判断：每天都扣了 / 有扣有没扣 / 一天都没扣，走 queryRules 都带 adminUsageDays，金额只加扣过的天（总指挥 10-25）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 开始统计 10-07 0 点；昨天 10-08
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  f.state.testLogs.push(usage(1, 30));
  const day = (from, to) => ({ startMs: Date.parse(from), endMs: Date.parse(to) });
  const twoDays = day("2026-10-06T16:00:00Z", "2026-10-08T16:00:00Z"), yesterday = day("2026-10-07T16:00:00Z", "2026-10-08T16:00:00Z");
  const view = async (window) => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", ...window }, { mode: "evaluate", origin: "page", force: true })).results[0].downstream;
  await manualYesterday(f);
  // 10-08 是 R1 以后固定的（扣过），10-07 现读（扣了）：每天都扣
  const all = await view(twoDays);
  assert.deepEqual([all.adminUsageDays, all.adminUsageAmountUsd], [{ deducted: 2, undeducted: 0 }, 0.3]);
  // 把 10-08 那一行改成 R1 以前的样子（没有管理员自用这个数）：有扣有没扣，金额只加 10-07 现读的（0）
  const stored = f.repository.tables.ledger.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  const detail = JSON.parse(stored.detail);
  delete detail.result.downstream.adminUsageQuotaUnits; delete detail.result.downstream.adminUsageAmountUsd; delete detail.result.downstream.adminUsageDays;
  for (const channel of detail.result.downstream.channels || []) { delete channel.adminUsageQuotaUnits; delete channel.adminUsageAmountUsd; }
  stored.detail = JSON.stringify(detail);
  f.module.invalidateSources(); // 结果缓存清掉，下一次从账本读
  const mixed = await view(twoDays);
  assert.deepEqual([mixed.adminUsageDays, mixed.adminUsageAmountUsd], [{ deducted: 1, undeducted: 1 }, 0]);
  // 只看 10-08 一天：账本那一行没有这个数 = 没扣
  const none = await view(yesterday);
  assert.equal(none.adminUsageAmountUsd, undefined);
});

test("R1「今天」读用户列表或管理员日志短暂失败：10 分钟内沿用上一份、不报读不到，超过 10 分钟才读不到（总指挥 10-25）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  f.state.testLogs.push({ id: 1, channel: 1, quota: 40, created_at: todayStart + 60, token_name: "root-key", username: "root" });
  const prev = globalThis.fetch;
  let broken = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (broken && url.host === "own.test" && (url.pathname === "/api/user/" || ownSourceRead(url))) return { status: 500, text: async () => "{}" };
    return prev(input, init);
  });
  const today = async () => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  const first = await today();
  assert.equal(first.downstream.quotaUnits, 210);
  broken = true;
  now += 5 * 60000;
  f.module.invalidateSources();
  const stale = await today();
  assert.equal(stale.downstream.quotaUnits, 210, "失败：5 分钟内沿用上一份的扣减，照样出数");
  assert.equal(stale.health.code, "READY");
  now += 6 * 60000; // 离上一次读到已经 11 分钟
  const late = await today();
  assert.notEqual(late.downstream.state, "complete", "超过 10 分钟才读不到");
});

test("R1 轮询：新消费来了、管理员日志读失败、之后一直没有新消费——沿用的结果不进缓存，第 10 分钟必须读不到（审核第四轮：撤掉「不进缓存」这条用例要失败）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  f.state.testLogs.push({ id: 1, channel: 1, quota: 40, created_at: todayStart + 60, token_name: "root-key", username: "root" });
  f.state.latestLogProbe = true; // 轮询要读最新一条消费日志，才知道站点安不安静（安静时直接沿用记下的收入）
  const prev = globalThis.fetch;
  let broken = false, brokenReads = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (broken && url.host === "own.test" && ownSourceRead(url)) { brokenReads += 1; return { status: 500, text: async () => "{}" }; }
    return prev(input, init);
  });
  const poll = async () => { await f.module.refreshDue(now); return (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", origin: "poll" })).results[0]; };
  assert.equal((await poll()).downstream.state, "complete");
  // 一分钟后来了新消费（站点不再「安静」），这时管理员日志读失败：沿用上一份，出数
  now += 60000;
  f.state.testLogs.push({ id: 2, channel: 1, quota: 10, created_at: Math.floor(now / 1000) - 5, token_name: "root-key", username: "root" });
  broken = true;
  assert.equal((await poll()).downstream.state, "complete", "10 分钟内沿用");
  // 之后一直没有新消费：沿用的那份不能被当成「没有新消费、结果不变」一直用下去（站点「安静」时轮询会直接沿用记下的收入）
  now += 5 * 60000;
  await f.module.refreshDue(now);
  now += 6 * 60000; // 离上一次读成功已经 11 分钟
  const reads = brokenReads;
  await f.module.refreshDue(now);
  assert.ok(brokenReads > reads, "沿用的结果没进缓存：这一轮要重新去读管理员日志（读不到，今天这一格才会说读不到），不是直接用缓存");
  assert.notEqual((await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0].downstream.state, "complete", "超过 10 分钟读不到");
});

test("R1「今天」读用户列表碰到 401（令牌坏了）不沿用上一份：马上读不到，不当短暂失败（审核 R1 第三轮低-1）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const prev = globalThis.fetch;
  let broken = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (broken && url.host === "own.test" && url.pathname === "/api/user/") return { status: 401, text: async () => JSON.stringify({ success: false, message: "unauthorized" }) };
    return prev(input, init);
  });
  const today = async () => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  assert.equal((await today()).downstream.state, "complete");
  broken = true;
  now += 5 * 60000;
  f.module.invalidateSources();
  f.rt._ownUsersCache = null; // 用户列表的 10 分钟缓存也清掉，下一次一定要重新读
  assert.notEqual((await today()).downstream.state, "complete", "401 不沿用上一份");
});

test("R1 同一轮几条绑定「今天」的终点差几秒：后定终点的先记下以后，先定终点的那条也能接着用更早的一份，不整段重读（审核 R1 中-4）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  const todayStart = Date.parse("2026-10-08T16:00:00Z") / 1000;
  for (let id = 1; id <= 250; id += 1) f.state.testLogs.push({ id, channel: id % 2 ? 1 : 2, quota: id <= 2 ? 1 : 0, created_at: todayStart + 60 + id, token_name: "root-key", username: "root" });
  const today = async (ruleId) => (await f.module.queryRules({ ruleIds: [ruleId], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  await today("rr_live"); // 第一轮：整段读（3 页），记下终点 E0
  now += 60000;
  await today("rr_live"); // 第二轮里终点晚的先到：E1 = E0 + 60 秒
  const before = sourceReads(f);
  now -= 5000; // 终点早 5 秒的另一条绑定后到：终点 E1 − 5 秒，还是晚于 E0
  await today("rr_two");
  assert.ok(sourceReads(f) - before <= 1, `接着用 E0 那份，只读新来的一页：${sourceReads(f) - before}`);
});

test("R1 渠道测试名字兜底来源：测试日志全在管理员名下，不翻一页，每个窗口只用 1 + 管理员数 个 stat；有不在管理员名下的才翻页，扣的数对（审核 CI：三个接口超时）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  const tokenPages = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/" && /token_name=/.test(request.query)).length;
  const tokenStats = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat" && /token_name=/.test(request.query)).length;
  // 渠道测试全记在管理员 root 名下（很多页）
  for (let id = 1; id <= 250; id += 1) f.state.testLogs.push(usage(id, id <= 2 ? 1 : 0, { token_name: "模型测试", token_id: 0 }));
  const first = (await manualYesterday(f)).results[0];
  assert.equal(first.downstream.adminUsageQuotaUnits, 2, "管理员 root 名下的测试扣了 2");
  assert.equal(tokenPages(), 0, "兜底来源一页都不翻");
  assert.ok(tokenStats() <= 4, `两个测试名字，各 1 + 1 个管理员 = 4 个 stat：${tokenStats()}`);
  // 10-07（没固定，每次现读）：有一条测试日志记在普通用户 alice 名下（不在管理员名下）：这个来源才翻页，兜底扣它
  const dayBefore = ydayStart - 86400;
  f.state.testLogs.push(usage(1001, 1, { created_at: dayBefore + 100, token_name: "模型测试", token_id: 0 }), usage(1002, 5, { created_at: dayBefore + 101, username: "alice", token_name: "模型测试", token_id: 0 }));
  const before = tokenPages();
  const second = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs - 86400000, endMs: COMPLETED_YESTERDAY.startMs }, { mode: "evaluate", origin: "page", force: true })).results[0];
  assert.ok(tokenPages() > before, "有不在管理员名下的：翻页");
  assert.equal(second.downstream.adminUsageQuotaUnits, 1 + 5, "root 名下的 1，加兜底扣掉不在管理员名下的 5");
});

// ---- 应付成本 V1-a：整站日志增量读挂在结账轮询里 ----
test("V1-a 轮询每轮给自营站点读几页整站日志（落后时最多 15 页、追平后 6 页），进度和桶落库；开关关掉不读；默认夹具不开整站读时一个不带筛选的请求都不发", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const yesterdayStart = Date.parse("2026-10-07T16:00:00Z") / 1000;
  resetOwnRequestBudget(); // 额度和断路是进程里一份，前面的用例让 own.test 回过 500，断路器可能还开着
  const ownLogStore = new MemoryOwnLogStore();
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000, ownLogStore, ownLogIngest: true } });
  f.state.fullLogList = true;
  for (let id = 1; id <= 300; id += 1) f.state.testLogs.push({ id, channel: 1, quota: 1, created_at: yesterdayStart + id * 60, token_name: "k", username: "alice", model_name: "m" });
  // 不带筛选、也不是「最新一条」探测（page_size=1，P1a 判站点安不安静用的）的 /api/log/ 才是整站读
  const isIngest = (request) => request.host === "own.test" && request.path === "/api/log/" && !request.sourceRead && !/page_size=1(&|$)/.test(request.query || "");
  const fullReads = () => f.state.requests.filter(isIngest).length;
  // 没设置过（settings 里没有 expectedCost）：V1-a 默认关，一个整站读请求都不发
  await f.module.refreshDue(now);
  assert.equal(fullReads(), 0, "没设置过不读");
  f.rt.store.settings = { expectedCost: true };
  now += 60000; resetOwnRequestBudget();
  await f.module.refreshDue(now);
  const first = fullReads();
  assert.ok(first > 0 && first <= 15, `落后 35 小时：这一轮最多 15 页，读了 ${first} 页`);
  const cursor = await ownLogStore.getCursor("own");
  assert.equal(cursor.coveredFromMs, yesterdayStart * 1000, "从昨天 0 点起");
  assert.ok(cursor.coveredToMs > cursor.coveredFromMs);
  assert.ok((await f.module.ownLogBuckets("own", 0, Number.MAX_SAFE_INTEGER)).length > 0, "桶落库");
  now += 60000;
  resetOwnRequestBudget();
  await f.module.refreshDue(now);
  assert.ok(fullReads() - first <= 15, "下一轮接着读，还是最多 15 页（追到 1 小时内才回到 6 页，server/own-log-ingest.test.js 有验）");
  // 「算应付成本」关着（settings.expectedCost=false，每轮读一次）：一个整站读请求都不发
  const beforeOff = fullReads();
  f.rt.store.settings = { expectedCost: false };
  now += 60000; resetOwnRequestBudget();
  await f.module.refreshDue(now);
  assert.equal(fullReads(), beforeOff, "关掉以后不读");
  f.rt.store.settings = { expectedCost: true };
  now += 60000; resetOwnRequestBudget();
  await f.module.refreshDue(now);
  assert.ok(fullReads() > beforeOff, "打开又接着读");
  // 默认不开：一个不带筛选的 /api/log/ 都不发
  const g = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  g.state.fullLogList = true;
  await g.module.refreshDue(now);
  assert.equal(g.state.requests.filter(isIngest).length, 0);
});

// ---- R2 自营站点关了收费记录（own-revenue-plan 第二节）----
const optionReads = (f) => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/option/").length;
const todayView = (f) => f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" }).then((response) => response.results[0]);

test("R2 读到关着：记下一段还关着的时间（从最后能证明开着的时刻起），今天碰到它：收入读不到、利润先不算，OWN_CONSUME_LOG_OFF；开回来以后段关上，原因变 GAP", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const own = () => f.rt.store.get("own"), periods = () => own().consumeLogOffPeriods ?? [];
  const first = await todayView(f);
  assert.deepEqual([first.health.code, periods()], ["READY", []], "开着：没有段，照常算");
  assert.equal(first.downstream.state, "complete");
  f.state.consumeLog = "false";
  now += 60000;
  const off = await todayView(f);
  assert.deepEqual(periods(), [{ fromMs: Date.parse("2026-10-09T03:00:00Z"), toMs: null }], "起点是上一次读到开着的时刻");
  assert.deepEqual([off.health.code, off.calculation.profitUsd], ["OWN_CONSUME_LOG_OFF", null]);
  assert.notEqual(off.downstream.state, "complete", "关着的时候读出来的收入不当真，更不写 0");
  assert.equal(off.displayStatus.state, "action");
  assert.deepEqual([off.displayStatus.title, off.displayStatus.action.label], ["自营站点不记收费记录了", "重新检查"]);
  // 关着期间每 30 秒以上才再读，段不重复写
  now += 60000;
  await todayView(f);
  assert.equal(periods().length, 1, "还关着：不新开一段");
  // 开回来：段关上；今天碰到的是已经开回来的那段
  f.state.consumeLog = "true";
  now += 60000;
  const on = await todayView(f);
  assert.deepEqual(periods(), [{ fromMs: Date.parse("2026-10-09T03:00:00Z"), toMs: now }]);
  assert.equal(on.health.code, "OWN_CONSUME_LOG_GAP");
  assert.deepEqual([on.displayStatus.state, on.displayStatus.title, on.displayStatus.action.label], ["action", "这一天自营站点有一段没记收费记录，那段的收入补不回来", ""]);
});

test("R2 昨天碰到过关着的那一段：不固定、不自动重试、手动重新读取也不固定；没碰到的那天照常固定（永远不按读到的数固定）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  // 10-08 上海时间 10:00–11:00 关过（已经开回来）：这一天碰到，10-07 没碰到
  await f.rt.store.update("own", { consumeLogOffPeriods: [{ fromMs: Date.parse("2026-10-08T02:00:00Z"), toMs: Date.parse("2026-10-08T03:00:00Z") }] });
  await f.module.refreshDue(now);
  const days = () => f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date).sort();
  assert.deepEqual(days(), ["2026-10-07"], "没碰到的那天固定了，碰到的 10-08 没固定");
  const row = f.repository.tables.settlementState.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.equal(row.manual_reason, "OWN_CONSUME_LOG_GAP", "不会自己消失：记下原因");
  const stats = () => f.state.statCalls.filter((call) => call.start === Date.parse("2026-10-07T16:00:00Z") / 1000).length;
  const before = stats();
  now += 3 * 3600000;
  await f.module.refreshDue(now);
  assert.equal(stats() - before, 0, "不再自动试，不取 10-08 的账单");
  const manual = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") }, { mode: "observe", force: true, origin: "manual" })).results[0];
  assert.equal(manual.health.code, "OWN_CONSUME_LOG_GAP");
  assert.deepEqual(days(), ["2026-10-07"], "手动重新读取也不固定");
});

test("R2 读不到设置（令牌少了 option:read、账号不是超级管理员、读取失败）：每天的状态不变、照常固定，没权限的状态记下给设置页说一句", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  f.state.optionReply = [403, { success: false, code: "ACCESS_TOKEN_SCOPE_DENIED", message: "The access token lacks the required permission: option:read" }];
  await f.module.refreshDue(now);
  assert.deepEqual(f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date).sort(), ["2026-10-07", "2026-10-08"], "照常固定");
  assert.deepEqual(f.module.consumeLogStatus("own"), { state: "denied", reason: "scope" });
  assert.deepEqual(f.rt.store.get("own").consumeLogOffPeriods ?? [], [], "没读到就不记段");
  f.state.optionReply = [200, { success: false, message: "无权进行此操作，权限不足" }];
  now += 60000;
  await f.module.recheckConsumeLog(f.rt.store.get("own"));
  assert.deepEqual(f.module.consumeLogStatus("own"), { state: "denied", reason: "not_root" });
  f.state.optionReply = [502, { success: false }];
  now += 60000;
  await f.module.recheckConsumeLog(f.rt.store.get("own"));
  assert.equal(f.module.consumeLogStatus("own").state, "unavailable");
  f.state.optionReply = null;
  now += 60000;
  assert.deepEqual(await f.module.recheckConsumeLog(f.rt.store.get("own")), { state: "on" });
});

test("R2 站点一层的事项（运营总览、侧栏的需处理列表里）：现在还关着一条「重新检查」，令牌读不到设置一条「更新登录信息」；开回来、没权限以外的都没有；总览里按去处去重只留一条", async (t) => {
  const { buildOverviewActions } = await import("../lib/overview-actions.js");
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const everything = async () => f.module.queryRules({ preset: "today" }, { mode: "observe", force: true, origin: "manual" });
  const siteActions = (response) => response.actions.filter((action) => ["recheck_consume_log", "update_authorization"].includes(action.kind));
  assert.deepEqual(siteActions(await everything()), [], "开着、读得到设置：没有");
  f.state.consumeLog = "false";
  now += 60000;
  const off = await everything();
  const [recheck] = siteActions(off);
  assert.deepEqual([recheck.kind, recheck.label, recheck.title], ["recheck_consume_log", "重新检查", "自营站点不记收费记录了"]);
  assert.equal(recheck.href, "/reconciliation", "没有「去哪处理」：点按钮才再读；地址只给列表去重用，不带参数（带参数打开页面会自动触发写操作）");
  assert.equal(siteActions(off).filter((action) => action.kind === "recheck_consume_log").length >= 1, true);
  // 三条绑定每条也有一条同去处的，总览里只剩一条
  const overview = buildOverviewActions([], { workflowActions: off.actions });
  assert.equal(overview.all.filter((row) => row.kind === "recheck_consume_log").length, 1, "总览里一个站点一条");
  // 开回来：不再有（关过的那几天写在各天自己身上，不进清单）
  f.state.consumeLog = "true";
  now += 60000;
  assert.deepEqual(siteActions(await everything()), []);
  // 令牌读不到设置：一条「更新登录信息」，不是超级管理员时只写后半句
  f.state.optionReply = [403, { success: false, code: "ACCESS_TOKEN_SCOPE_DENIED", message: "The access token lacks the required permission: option:read" }];
  now += 60000;
  const denied = siteActions(await everything()).find((action) => action.code === "OWN_OPTION_READ_DENIED");
  assert.deepEqual([denied.kind, denied.label, denied.title, denied.stationId], ["update_authorization", "更新登录信息", "自营站点的令牌读不到设置", "own"]);
  assert.match(denied.detail, /给令牌补上「读设置」的权限，或者换超级管理员的访问令牌。$/);
  f.state.optionReply = [200, { success: false, message: "无权进行此操作，权限不足" }];
  now += 60000;
  const notRoot = siteActions(await everything()).find((action) => action.code === "OWN_OPTION_READ_DENIED");
  assert.equal(notRoot.detail, "发现不了自营站点不记收费记录了。换超级管理员的访问令牌。");
});

test("R2「重新检查」按钮每次都真读（用户刚去后台打开、30 秒内回来点，不能回旧结果）；站点开关变了运营总览的缓存也清掉（设计验收必改 1、小改 4）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const { ownCache } = await import("./own-helpers.js");
  const own = () => f.rt.store.get("own");
  f.state.consumeLog = "false";
  assert.deepEqual(await f.module.recheckConsumeLog(own()), { state: "off" });
  ownCache(f.rt).set("analytics", { at: now }); // 运营总览自营分析的缓存（120 秒）
  // 用户到后台打开了，5 秒后回来点「重新检查」：要读到开着
  f.state.consumeLog = "true";
  now += 5000;
  assert.deepEqual(await f.module.recheckConsumeLog(own()), { state: "on" }, "30 秒内也真读");
  assert.equal(ownCache(f.rt).size, 0, "开关变了，运营总览的缓存跟着清");
  // 同一时刻连点：合成一次（读完 2 秒内回上一次的结果）
  const reads = optionReads(f);
  await Promise.all([f.module.recheckConsumeLog(own()), f.module.recheckConsumeLog(own())]);
  assert.ok(optionReads(f) - reads <= 1, "并发的合成一次");
});

test("R2 关着的段从哪起算：重启以后（内存里没有读到开着的时刻）取最新一条日志往前 120 秒；站点的钟快时只用上一次读到开着的时刻，不取晚（审核第一轮 中-6、低-5）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  f.state.latestLogProbe = true;
  const own = () => f.rt.store.get("own"), periods = () => own().consumeLogOffPeriods ?? [];
  const sec = (ms) => Math.floor(ms / 1000);
  // 重启以后第一次就读到关着：最新一条消费日志在 1 小时前，起点 = 它往前 120 秒
  const lastLogMs = now - 3600000;
  f.state.testLogs.push({ id: 1, channel: 1, quota: 1, created_at: sec(lastLogMs), token_name: "k", username: "root" });
  f.state.consumeLog = "false";
  await f.module.refreshDue(now);
  assert.equal(periods()[0].fromMs, sec(lastLogMs) * 1000 - 120000, "起点取最新一条日志往前 120 秒");
  // 站点的钟快 10 分钟：先开着读一轮（记下读到开着的时刻），一分钟后关了，最新一条日志的时刻比本机晚 10 分钟——起点不能取到它
  f.rt.store.update("own", { consumeLogOffPeriods: [] });
  f.state.consumeLog = "true";
  now += 5 * 60000;
  await f.module.recheckConsumeLog(own());
  const onAt = now;
  f.state.testLogs.push({ id: 2, channel: 1, quota: 1, created_at: sec(now + 600000), token_name: "k", username: "root" }); // 站点钟快 10 分钟
  f.state.consumeLog = "false";
  now += 60000;
  await f.module.refreshDue(now);
  await f.module.recheckConsumeLog(own());
  assert.equal(periods().at(-1).fromMs, onAt, "钟快：起点是上一次读到开着的时刻，不是最新日志的时刻");
});

test("R2 停机很久以后第一次读到关着、内存里没有任何证据：单独读一次最新的一条消费日志（不限 2 小时）当起点，只多 1 个请求（审核第一轮 中-2，总指挥 10-26 定）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const sec = (ms) => Math.floor(ms / 1000);
  const lastLogMs = now - 20 * 3600000; // 20 小时前：停机期间关的，日志停在那
  f.state.testLogs.push({ id: 1, channel: 1, quota: 1, created_at: sec(lastLogMs), token_name: "k", username: "root" });
  f.state.latestLogProbe = true;
  const prev = globalThis.fetch;
  const latestReads = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/" && !ownSourceRead(url) && url.searchParams.get("page_size") === "1") latestReads.push(url.searchParams.get("start_timestamp"));
    return prev(input, init);
  });
  f.state.consumeLog = "false";
  await f.module.recheckConsumeLog(f.rt.store.get("own"));
  assert.equal(f.rt.store.get("own").consumeLogOffPeriods[0].fromMs, sec(lastLogMs) * 1000 - 120000, "起点是最新一条日志往前 120 秒，不是现在");
  assert.ok(latestReads.includes("0"), "单独读了一次，不带起点限制");
});

test("R2 结账那一轮读不到站点设置（5xx）：这一天这一轮不固定，按退避再试，读到开着才固定；没权限照常固定（总指挥 10-26 定 B）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const days = () => f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date).sort();
  f.state.optionReply = [502, { success: false }];
  await f.module.refreshDue(now);
  assert.deepEqual(days(), [], "读不到设置：不固定");
  const row = f.repository.tables.settlementState.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.equal(row?.retry_reason, "OWN_OPTION_UNREADABLE", "读取类，按退避再试；码说的是「设置读不到」，不借用「收费记录读不到」（审核第二轮 中-1）");
  f.state.optionReply = null; // 恢复
  now += 11 * 60000;
  await f.module.refreshDue(now);
  assert.ok(days().includes("2026-10-08"), "读到开着以后固定");
  // 设置连续读不到超过 24 小时（收费记录本身读得到）：照常固定，账本明细记一句，站点这一层进需处理「自营站点的设置一直读不到」
  const h = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const r of h.rows) r.enabled = r.id === "rr_live" ? 1 : 0;
  h.state.optionReply = [502, { success: false }];
  await h.module.refreshDue(now);
  assert.deepEqual(h.state.ledger.filter((r) => r.rule_id === "rr_live").map((r) => r.bill_date), [], "头 24 小时先等");
  assert.ok(!h.module.ownSiteActions?.length);
  now += 25 * 3600000;
  await h.module.refreshDue(now);
  const settledRows = h.state.ledger.filter((r) => r.rule_id === "rr_live").map((r) => r.bill_date).sort();
  assert.ok(settledRows.includes("2026-10-08") && settledRows.includes("2026-10-09"), `超过 24 小时：照常固定（${settledRows}）`);
  const detail = h.state.ledger.find((r) => r.rule_id === "rr_live" && r.bill_date === "2026-10-09").detail;
  assert.deepEqual([detail.settlement.consumeLogSetting.state, detail.settlement.consumeLogSetting.reason], ["unreadable", "too_long"], "明细照实记一句");
  const page = await h.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "evaluate", origin: "page" });
  const siteAction = page.actions.find((action) => action.code === "OWN_OPTION_UNREADABLE");
  assert.deepEqual([siteAction?.kind, siteAction?.label, siteAction?.title, siteAction?.stationId], ["recheck_consume_log", "重新检查", "自营站点的设置一直读不到", "own"], "站点这一层进需处理，按钮「重新检查」");
  assert.ok(!page.actions.some((action) => action.code === "OWN_BILLING_UNAVAILABLE"));
  // 没权限照常固定
  const g = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const r of g.rows) r.enabled = r.id === "rr_live" ? 1 : 0;
  g.state.optionReply = [403, { success: false, message: "forbidden" }];
  await g.module.refreshDue(now);
  assert.ok(g.state.ledger.some((r) => r.rule_id === "rr_live" && r.bill_date === "2026-10-08"), "没权限照常固定");
});

test("R2 近 7 天碰到关过的一天：那一天不算，其余天照算，行上有一句说明；整段都碰到才整段需处理（总指挥 10-26 定 A）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 上海 10-09 11:00；开始统计 10-07 0 点
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const week = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "7d" }, { mode: "evaluate", origin: "page", force: true }).then((r) => r.results[0]);
  const whole = await week();
  assert.equal(whole.calculation.profitUsd !== null, true);
  // 10-08（昨天）上海 10:00–11:00 关过，已经开回来
  await f.rt.store.update("own", { consumeLogOffPeriods: [{ fromMs: Date.parse("2026-10-08T02:00:00Z"), toMs: Date.parse("2026-10-08T03:00:00Z") }] });
  const partial = await week();
  assert.notEqual(partial.health.code, "OWN_CONSUME_LOG_GAP", "不整段挡住");
  assert.notEqual(partial.calculation.profitUsd, null, "其余天照算");
  assert.ok(partial.health.issues.some((issue) => issue.code === "OWN_CONSUME_LOG_GAP_PARTIAL"), "加了一句说明");
  // 切成几块读的同一个真分段合回一项：页面的「倍率变化」表只有真分段，金额等于合计（审核第二轮 中-2、低-3）
  assert.deepEqual(partial.segments.map((segment) => segment.id), whole.segments.map((segment) => segment.id), "段号不带「~序号」、段数不变");
  assert.equal(partial.segments.length, 1);
  assert.deepEqual([partial.segments[0].downstream.amountUsd, partial.segments[0].upstream.amountUsd, partial.segments[0].pieces], [partial.downstream.amountUsd, partial.upstream.amountUsd, 2], "两块合成一段，收入、成本之和等于合计");
  assert.ok(partial.segments[0].downstream.channels.every((channel) => channel.billingState === "complete"));
  const dayStart = Date.parse("2026-10-07T16:00:00Z") / 1000, dayEnd = Date.parse("2026-10-08T16:00:00Z") / 1000; // 10-08 整天（上海）
  f.state.statCalls.length = 0;
  await week();
  assert.ok(f.state.statCalls.length > 0 && f.state.statCalls.every((call) => call.end < dayStart || call.start >= dayEnd), "没有任何一次读取覆盖到被碰到的那一天（10-08），其余天分段读");
  // 整段窗口都碰到（关过的段盖住了从开始统计起的全部）：整段需处理
  await f.rt.store.update("own", { consumeLogOffPeriods: [{ fromMs: Date.parse("2026-10-01T00:00:00Z"), toMs: Date.parse("2026-10-09T02:00:00Z") }] });
  const all = await week();
  assert.equal(all.health.code, "OWN_CONSUME_LOG_GAP");
});

test("copySegment：复制一份分段改 id，普通字段是自己的（不借原型链）、不可枚举的 keys 也带过去（总指挥 10-26 定，#114 中-G 改法）", () => {
  const original = { id: "s1", ruleId: "r1", group: "g1", ratio: 0.8, window: { startMs: 1, endMs: 2 } };
  Object.defineProperty(original, "keys", { value: [{ tokenId: 9 }], enumerable: false, configurable: true, writable: true });
  const copy = copySegment(original, { id: "s1~1" });
  assert.equal(copy.id, "s1~1", "overrides 生效");
  assert.deepEqual({ ...copy, id: original.id }, original, "除了 id，别的字段和原段一样（都是拷贝自己的，不是原型链上的）");
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(original).sort(), "Object.keys 和原段一样（id 还在）");
  assert.equal(JSON.stringify(copy), JSON.stringify({ ...original, id: "s1~1" }), "JSON.stringify 除了 id 和原段一样");
  assert.deepEqual(copy.keys, [{ tokenId: 9 }], "keys 带过去了");
  assert.equal(Object.getOwnPropertyDescriptor(copy, "keys").enumerable, false, "keys 还是不可枚举，不会被 JSON.stringify / Object.keys 带出来");
});

test("R2 × K1c 中-G：一段里挂两把 Key 时碰到关过的一天，按天切开不能把 Key 列表丢掉（审核 #114 中-G，总指挥 10-26 定）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const live = f.rows.find((row) => row.id === "rr_live");
  // 这条绑定的分段上挂两把 Key（K1c：一把在目录里、一把已删按名字取），上游成本是各取一次再相加
  const segment = f.repository.tables.segments.find((row) => row.rule_id === "rr_live" && row.effective_to_ms == null);
  f.repository.tables.segmentKeys.push(
    { segment_id: segment.id, upstream_station_id: live.upstream_station_id, token_id: live.token_id, token_name: live.token_name, key_mask: null, match_source: "initial", active_token_key: null },
    { segment_id: segment.id, upstream_station_id: live.upstream_station_id, token_id: 77, token_name: "gone-key", key_mask: null, match_source: "fingerprint", active_token_key: null });
  const week = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "7d" }, { mode: "evaluate", origin: "page", force: true }).then((r) => r.results[0]);
  const whole = await week();
  assert.equal(whole.upstream.amountUsd, 2, "没碰到关着的段：两把 Key 各取一次相加，额度 100÷100=1，合计 2");
  // 10-08 关过一天：按天切开，两截各自都要带着两把 Key，不能只剩绑定自己那把
  await f.rt.store.update("own", { consumeLogOffPeriods: [{ fromMs: Date.parse("2026-10-08T02:00:00Z"), toMs: Date.parse("2026-10-08T03:00:00Z") }] });
  const partial = await week();
  assert.ok(partial.health.issues.some((issue) => issue.code === "OWN_CONSUME_LOG_GAP_PARTIAL"), "加了一句说明");
  assert.equal(partial.upstream.amountUsd, 4, "两截各带两把 Key、各取一次：2 截 × 2 把 = 4 次取数，各 1 相加 = 4（丢了 Key 列表只会取到 2，少算一半）");
});

test("R2 关过的那天过了 33 天：状态行清掉了也不回到「实时」、手动重新读取也固定不了（总指挥 10-26 定 C）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.rt.store.update("own", { consumeLogOffPeriods: [{ fromMs: Date.parse("2026-10-08T02:00:00Z"), toMs: Date.parse("2026-10-08T03:00:00Z") }] });
  now += 33 * 86400000; // 33 天以后：状态行早被清了，段还在
  f.repository.tables.settlementState.length = 0;
  const yesterday = { startMs: Date.parse("2026-10-07T16:00:00Z"), endMs: Date.parse("2026-10-08T16:00:00Z") };
  const manual = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", ...yesterday }, { mode: "observe", force: true, origin: "manual" })).results[0];
  assert.equal(manual.health.code, "OWN_CONSUME_LOG_GAP", "段还在：那天仍说关过");
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").length, 0, "手动重新读取也没固定");
});

test("R2 还没开始统计的日子不被标成需处理（审核第一轮 中-7）：整天在开始统计之前，关着也不碰", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  await f.rt.store.update("own", { consumeLogOffPeriods: [{ fromMs: Date.parse("2026-10-05T00:00:00Z"), toMs: null }] });
  const rule = f.rows.find((row) => row.id === "rr_live");
  rule.billing_effective_from_ms = Date.parse("2026-10-08T16:00:00Z"); // 从今天 0 点起算
  rule.created_at = new Date("2026-10-08T16:00:00Z");
  const yesterday = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", ...COMPLETED_YESTERDAY }, { mode: "evaluate", origin: "page", force: true })).results[0];
  assert.ok(!["OWN_CONSUME_LOG_OFF", "OWN_CONSUME_LOG_GAP"].includes(yesterday.health.code), `昨天在开始统计之前，不说关着：${yesterday.health.code}`);
});

test("R2 每 5 分钟读一次设置（轮询不强制）：5 分钟内几轮、几条绑定只读一次；设置里别的东西不进任何结果", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  await f.module.refreshDue(now);
  const reads = optionReads(f);
  assert.equal(reads, 1, "几条绑定同一轮只读一次");
  now += 2 * 60000;
  await f.module.refreshDue(now);
  assert.equal(optionReads(f), reads, "2 分钟后不再读");
  now += 4 * 60000;
  await f.module.refreshDue(now);
  assert.equal(optionReads(f), reads + 1, "过了 5 分钟再读一次");
  assert.ok(!JSON.stringify(f.module.consumeLogStatus("own")).includes("secret"));
});

test("R1 读不到用户列表或管理员日志：这一天算不出收入、不固定，下次重试；不拿没减的数固定进账本", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  const prev = globalThis.fetch;
  let broken = "users";
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && ((broken === "users" && url.pathname === "/api/user/") || (broken === "logs" && ownSourceRead(url)))) return { status: 500, text: async () => "{}" };
    return prev(input, init);
  });
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 0, "读不到用户列表：没固定");
  broken = "logs";
  now += 10 * 60000;
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 0, "读不到管理员日志：没固定");
  assert.ok(f.repository.tables.settlementState.some((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08"), "留了状态行，会重试");
  broken = null;
  now += 30 * 60000;
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 1, "读得到了，下一次固定");
});

// ---- 令牌作废、少了权限（own-revenue-plan 第三节、用语规范 §5.2）：马上进需处理，自营站点、上游各一条，不当成读取类等 7 天 ----
const tokenReply = (status, code, message) => ({ status, text: async () => JSON.stringify({ success: false, message, code }) });

test("令牌作废：自营站点一侧马上进需处理（不是 OWN_BILLING_UNAVAILABLE 等 7 天），说明里列新令牌要勾的权限；结账不固定、状态表记要人处理", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !url.searchParams.get("token_name")) {
      return tokenReply(401, "ACCESS_TOKEN_LEGACY_RETIRED", "Legacy access tokens have been retired. Create a new access token in security settings");
    }
    return prev(input, init);
  });
  const manual = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
  const result = (await manual()).results[0];
  assert.equal(result.health.code, "ACCESS_TOKEN_LEGACY_RETIRED", "不是读取类的 OWN_BILLING_UNAVAILABLE");
  const status = result.displayStatus;
  assert.equal(status.state, "action", "马上进需处理，不等 7 天");
  assert.equal(status.title, "自营站点的访问令牌已经作废了");
  assert.equal(status.detail, "New API 升级以后旧式的访问令牌不能用了，要换一个新令牌（nap_ 开头），并勾上这些权限：profile:read、channel:read、log:read、user:read、usage:read、option:read");
  assert.equal(status.action.kind, "update_authorization");
  // 结账：不固定；状态表记成要人处理（reasonKindOf 读 contract 的 kind，不用特判）
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 0);
  const row = f.repository.tables.settlementState.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.deepEqual([row.manual_reason, row.retry_reason], ["ACCESS_TOKEN_LEGACY_RETIRED", null]);
});

// 真实环境里令牌一作废，自营站点除了不用登录的 /api/status 每条路都回 401（少权限都回 403），身份、用户列表、渠道收费统计全读不了：
// 要出的还是「自营站点的令牌作废/少了权限」，不是「上游账号或自营站点有变化」，也不是读取类的 OWN_BILLING_UNAVAILABLE 等 7 天（审核 #107 中-1）
for (const [name, status, code, message, title, detailStart] of [
  ["作废", 401, "ACCESS_TOKEN_LEGACY_RETIRED", "Legacy access tokens have been retired", "自营站点的访问令牌已经作废了", "New API 升级以后旧式的访问令牌不能用了"],
  ["少权限", 403, "ACCESS_TOKEN_SCOPE_DENIED", "The access token lacks the required permission: log:read", "自营站点的令牌少了「log:read」的权限", "「log:read」是 New API 说少了的那一项"],
]) {
  for (const allowSelf of [false, true]) test(`自营站点每条路都${name}${allowSelf ? "（只放过 /api/user/self：身份读得到，用户列表、渠道统计读不到）" : "：身份读不到也说令牌的事"}，主语是自营站点；结账不固定，状态表记要人处理`, async (t) => {
    let now = Date.parse("2026-10-09T03:00:00Z");
    const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
    const prev = globalThis.fetch;
    let broken = false;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(String(input));
      if (broken && url.host === "own.test" && url.pathname !== "/api/status" && !(allowSelf && url.pathname === "/api/user/self")) return tokenReply(status, code, message);
      return prev(input, init);
    });
    await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" }); // 令牌还好的时候先观测今天（锚定），不结昨天
    broken = true;
    f.module.invalidateSources(); // 身份、目录缓存清掉，下一次一定要重新读
    now += 60 * 60000;
    const manual = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
    const result = (await manual()).results[0];
    assert.equal(result.health.code, code, "不是 SOURCE_BINDING_UNCONFIRMED，也不是 OWN_BILLING_UNAVAILABLE");
    assert.equal(result.displayStatus.state, "action");
    assert.equal(result.displayStatus.title, title);
    assert.ok(result.displayStatus.detail.startsWith(detailStart), result.displayStatus.detail);
    assert.equal(result.displayStatus.action.kind, "update_authorization");
    assert.equal(result.displayStatus.action.stationId, "own", "自营站点的令牌坏了，「更新登录信息」去自营站点，不是这条绑定的上游（审核 #107 中-2）");
    assert.match(result.displayStatus.action.href, /stationId=own/);
    await f.module.refreshDue(now);
    assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 0, "不固定");
    const row = f.repository.tables.settlementState.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
    assert.equal(row?.manual_reason, code, "状态表记要人处理");
  });
}

test("自营站点的令牌少了 channel:read：渠道目录读不到说令牌的事，进需处理，不吞成「渠道状态暂时读不到」（审核 #107 低-5）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "own.test" && url.pathname === "/api/channel/") return tokenReply(403, "ACCESS_TOKEN_SCOPE_DENIED", "The access token lacks the required permission: channel:read");
    return prev(input, init);
  });
  const view = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  assert.equal(view.health.code, "ACCESS_TOKEN_SCOPE_DENIED");
  assert.equal(view.displayStatus.title, "自营站点的令牌少了「channel:read」的权限");
});

test("整站令牌作废、身份缓存是冷的（先升级 New API 再部署这一版，一启动就是这样）：推送也要出，3 轮只推 1 条（审核 #107 中-1）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = 1; // 三条绑定都在，同一个自营站点
  f.rt.store.channels = [{ id: "c", type: "webhook", name: "运维群", enabled: true, config: { url: "https://hooks.example.com/x" } }];
  const sent = [], prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "hooks.example.com") { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (url.host === "own.test" && url.pathname !== "/api/status") return tokenReply(401, "ACCESS_TOKEN_LEGACY_RETIRED", "Legacy access tokens have been retired");
    return prev(input, init);
  });
  for (let round = 0; round < 3; round += 1) {
    f.module.invalidateSources(); // 身份、目录缓存是冷的
    await f.module.refreshDue(now);
    now += 60000;
  }
  assert.equal(sent.length, 1, "整站 401，三轮只推 1 条");
  assert.equal(sent[0].title, "【炬元告警】自营站点 本站 访问令牌已经作废了");
});

test("令牌少了权限：上游一侧说是哪个上游、New API 说少的哪一项；不再说「上游拒绝读取这把 Key」；没带码的 403 还是原来的说法", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  const prev = globalThis.fetch;
  let mode = "scope";
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/log/self/stat") {
      return mode === "scope" ? tokenReply(403, "ACCESS_TOKEN_SCOPE_DENIED", "The access token lacks the required permission: usage:read")
        : { status: 403, text: async () => JSON.stringify({ success: false, message: "无权进行此操作" }) };
    }
    return prev(input, init);
  });
  const query = () => f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
  let result = (await query()).results[0];
  assert.equal(result.health.code, "ACCESS_TOKEN_SCOPE_DENIED");
  assert.equal(result.displayStatus.state, "action");
  assert.equal(result.displayStatus.title, "上游「上游」的令牌少了「usage:read」的权限");
  assert.equal(result.displayStatus.detail, "「usage:read」是 New API 说少了的那一项。给令牌补上这项权限，或者换一个带这项权限的令牌");
  assert.equal(result.displayStatus.action.kind, "update_authorization");
  // 没带这个码的 403：照旧是「上游拒绝读取这把 Key」
  mode = "plain";
  result = (await query()).results[0];
  assert.equal(result.health.code, "KEY_INVALID_OR_DENIED");
});

test("R1 转售 Key 所属用户在用户列表里不是管理员：忽略这条标记，什么都不扣不加，照常固定（总指挥 10-25）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  f.stations.find((station) => station.id === "own").resoldAdminKeys = [{ username: "alice", tokenName: "alice-key" }];
  const settled = (await manualYesterday(f)).results[0];
  assert.notEqual(settled.calculation.profitUsd, null, "没有「读不到」，能固定");
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 1);
  assert.equal(settled.downstream.quotaUnits, 250, "收入就是渠道收费，没有额外的扣或加");
});

test("R1 多天范围按天拼：已经固定的天用账本里存的（扣过管理员自用的）净额，只有没固定的天现读；多天收入是几天每一行加起来", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 开始统计 10-07 0 点；昨天 10-08 先固定，10-07 没固定
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  f.state.testLogs.push(usage(1, 30)); // 10-08 里管理员花了 30
  const settled = (await manualYesterday(f)).results[0];
  assert.equal(settled.downstream.quotaUnits, 220, "10-08 固定的是减过管理员自用的净额");
  const twoDays = { startMs: Date.parse("2026-10-06T16:00:00Z"), endMs: COMPLETED_YESTERDAY.endMs };
  const channelStats = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/log/stat" && !request.sourceRead).length;
  const before = { stats: channelStats(), sources: sourceReads(f) };
  const range = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", ...twoDays }, { mode: "evaluate", origin: "page" })).results[0];
  // 10-07 现读：渠道统计 250、管理员没花（日志都在 10-08）；10-08 用账本里的 220
  assert.equal(range.downstream.quotaUnits, 250 + 220, "两天每一行加起来：10-07 现读 250 + 10-08 账本 220");
  assert.equal(channelStats() - before.stats, 1, "渠道收费统计只现读了没固定的 10-07 一天，10-08 没再读");
  assert.equal(range.downstream.adminUsageAmountUsd, 0.3, "管理员自用也是两天加起来：10-08 账本里的 0.3 加 10-07 的 0");
  assert.equal(range.downstream.state, "complete");
});

test("R1 从同一天起点查更长的范围，不能拿刚读的一天的结果：缓存只在终点相差不到 30 秒时沿用（审核 R1 实测少减了 49430 额度）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  f.state.testLogs.push(usage(1, 30), { id: 2, channel: 1, quota: 20, created_at: COMPLETED_YESTERDAY.endMs / 1000 + 100, token_name: "root-key", username: "root" });
  // 先查昨天（读了一遍，记下「从昨天 0 点到昨天结束」）；30 秒内再查从昨天 0 点到今天早上的范围
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "evaluate", origin: "page", force: true });
  const longer = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs + 6 * 3600000 }, { mode: "evaluate", origin: "page", force: true })).results[0];
  assert.equal(longer.downstream.adminUsageAmountUsd, 0.5, "两段里管理员花的 30 和 20 都减了；拿昨天那一份只减 30");
});

test("R1 结账翻到一半失败（限流、网络）：下一轮从下一页接着翻，不从头；这一天这一轮不固定", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  // 要算 3 个渠道、root 一天 250 条（3 页）：翻页（3 次）不比按渠道 stat（3 次）多，走翻页
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1, 2, 3], rr_two: [2], rr_three: [3] }, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  for (let id = 1; id <= 250; id += 1) f.state.testLogs.push(usage(id, 1)); // 都在渠道 1
  const prev = globalThis.fetch, pages = [];
  let failPageTwo = true;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    // 只看昨天那段窗口的（今天的观测也会读 root，不是这里要看的）
    if (url.host === "own.test" && url.pathname === "/api/log/" && url.searchParams.get("username") === "root" && url.searchParams.get("start_timestamp") === String(ydayStart)) {
      pages.push(Number(url.searchParams.get("p")));
      if (failPageTwo && url.searchParams.get("p") === "2") return { status: 500, text: async () => "{}" };
    }
    return prev(input, init);
  });
  await f.module.refreshDue(now);
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 0, "翻到一半失败，没固定");
  assert.deepEqual(pages, [1, 2]);
  failPageTwo = false; pages.length = 0;
  now += 10 * 60000;
  await f.module.refreshDue(now);
  assert.deepEqual(pages, [2, 3], "从第 2 页接着翻，第 1 页不再读");
  const row = f.state.ledger.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.equal(row.detail.result.downstream.quotaUnits, 3 * 250 - 250, "三个渠道各 250，减掉 root 的 250");
});

test("R1 取数选法：整段读管理员日志，翻页要的页数比按渠道 stat 的次数多时改按渠道 stat（第一页读了就停，不再翻）；少时翻页；结果一样", async (t) => {
  const run = async (rows) => {
    let now = Date.parse("2026-10-09T03:00:00Z");
    const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
    for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
    for (let id = 1; id <= rows; id += 1) f.state.testLogs.push(usage(id, 1));
    const seen = [];
    const prev = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "own.test" && url.searchParams.get("username") === "root" && url.searchParams.get("start_timestamp") === String(ydayStart)) seen.push(`${url.pathname}?p=${url.searchParams.get("p")}&channel=${url.searchParams.get("channel")}`);
      return prev(input, init);
    });
    const settled = (await manualYesterday(f)).results[0];
    return { settled, seen };
  };
  // 120 行：2 页，要算 1 个渠道 → 按渠道 stat 1 次 < 2 页：读了第一页就停，改查 stat
  const heavy = await run(120);
  assert.equal(heavy.settled.downstream.quotaUnits, 250 - 120, "两种办法数一样");
  assert.deepEqual(heavy.seen.filter((item) => item.startsWith("/api/log/?")), ["/api/log/?p=1&channel=null"], "只读了第一页，没翻第二页");
  assert.ok(heavy.seen.some((item) => item.startsWith("/api/log/stat?") && item.endsWith("channel=1")), "按渠道查了 stat");
  // 50 行：1 页，stat 1 次不比 1 页少 → 翻页
  const light = await run(50);
  assert.equal(light.settled.downstream.quotaUnits, 250 - 50);
  assert.ok(!light.seen.some((item) => item.includes("channel=1")), "没有按渠道查 stat");
});

test("R1 按渠道 stat 读的只覆盖当时要算的渠道：同一个站点同一天别的绑定要算别的渠道时，合起来重读，不拿没覆盖的当 0", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, channelsByRule: { rr_live: [1], rr_two: [2], rr_three: [3] }, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  for (let id = 1; id <= 120; id += 1) f.state.testLogs.push(usage(id, 1, { channel: id % 2 === 0 ? 1 : 2 })); // root 在渠道 1、2 上各 60
  const manual = (ruleId) => f.module.queryRules({ ruleIds: [ruleId], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" });
  const first = (await manual("rr_live")).results[0];
  assert.equal(first.downstream.quotaUnits, 250 - 60, "渠道 1：250 − root 的 60");
  const second = (await manual("rr_two")).results[0];
  assert.equal(second.downstream.quotaUnits, 250 - 60, "渠道 2 也要减 root 的 60，不是 0（第一份只覆盖渠道 1）");
});

test("C2a 结账（settle）只写账本和状态行：不写观测快照、渠道状态、分段，不发告警", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  let ratio = 1;
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 },
    metadataGroups: () => ({ g1: { ratio }, g2: { ratio: 2 } }) });
  // 先观测一轮今天，把渠道状态、分段、告警这些写好
  await f.module.queryRules({ preset: "today" }, { mode: "observe", force: true, origin: "manual" });
  // 过 11 分钟、分组倍率也变了：这时候观测会重写渠道状态的观测时刻、记一段新倍率；结账一样都不能写
  now += 11 * 60000;
  ratio = 1.5;
  const counts = async () => ({ snapshots: f.repository.log.snapshotWrites.length, channels: f.state.channelStateWrites.length, ratios: f.state.ratioWrites.length,
    segments: (await f.repository.listSegments("rr_live")).length, alerts: f.state.alertQueries });
  const before = await counts();
  const result = (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "yesterday" }, { mode: "observe", force: true, origin: "manual" })).results[0];
  assert.ok(result.settledAt);
  assert.deepEqual(await counts(), before, "结账不写快照、渠道状态、分段，也不碰告警");
  await f.module.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", force: true, origin: "manual" });
  const observed = await counts();
  assert.ok(observed.channels > before.channels && observed.segments > before.segments, "对照：同样的情况下观测今天会写渠道状态、记新的一段");
  assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live").length, 1);
});

test("C2a 固定成功时删状态行只靠记账的同一个事务，不再单独多发一条删除的 SQL（安全审核 C2a 低-1）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  let failUpstream = true;
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (failUpstream && url.host === "upstream.test" && url.pathname === "/api/log/self/stat") {
      return { status: 403, text: async () => JSON.stringify({ success: false, message: "无权进行此操作" }) };
    }
    return prev(input, init);
  });
  const state = () => f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  await f.module.refreshDue(now);
  assert.ok(state(), "第一次结不成，留一行状态");
  failUpstream = false;
  // 盯着这个方法：固定成功这条路径不该再单独调它了——状态行跟着账本在同一个事务里删，见 saveSnapshotsForScope 的 settlement 选项
  const originalDelete = f.repository.deleteSettlementState.bind(f.repository);
  let deleteCalled = false;
  f.repository.deleteSettlementState = async (...args) => { deleteCalled = true; return originalDelete(...args); };
  try {
    now += 10 * 60000;
    await f.module.refreshDue(now); // 到点本地重判：目录里看不出问题，记 cleared，这一轮还不去结
    now += 60000;
    await f.module.refreshDue(now); // 下一轮才真的去结
    assert.equal(state(), undefined, "状态行已经被删掉——靠的是记账事务里那次");
    assert.equal(f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08").length, 1, "账本照常写了");
    assert.equal(deleteCalled, false, "没有再单独调一次删除（以前这里会多发一条 SQL，现在去掉了）");
  } finally {
    f.repository.deleteSettlementState = originalDelete;
  }
});

test("C2a 轮询和手动同时固定同一天：账本只有一版，两边都返回账本里那一版", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  let hold = null;
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 },
    onRequest: async (request) => { if (hold && request.path === "/api/log/self/stat") { const wait = hold; hold = null; await wait.hold(); } } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  const window = { ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs };
  // 手动那次在取上游账单时停住，期间轮询先把昨天结掉
  hold = holdPoint();
  const point = hold;
  const manual = f.module.queryRules(window, { mode: "observe", force: true, origin: "manual" });
  await point.reached;
  await f.module.refreshDue(now);
  f.state.upstreamQuota = 120; // 轮询结完以后上游又补了一点：手动那次接着取到的是 120，算出来的数和账本不同
  point.release();
  const manualResult = (await manual).results[0];
  const rows = f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  assert.equal(rows.length, 1, "只有一版");
  assert.equal(manualResult.calculation.profitUsd, Number(rows[0].revenue_usd) - Number(rows[0].cost_usd), "手动那边也按账本那一版返回");
  assert.equal(manualResult.upstream.amountUsd, Number(rows[0].cost_usd), "成本也是账本里那一版，不是手动自己取到的 120");
});

test("C2a 要人处理的日子到点只在本地重判：还挡着就不取账单、不强制重读、不计次数、原因没变就不写状态行；原因没了下一轮才去结", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  let keyStatus = 2;
  const f = await completedDayFixture(t, { clock: () => now });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0; // 只看这一条：别的绑定的昨天照常结，不混进账单次数
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/token/") {
      f.state.requests.push({ host: url.host, path: url.pathname });
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 3, items: [
        { id: 9, user_id: 7, name: "stable", status: keyStatus, group: "g1", cross_group_retry: false },
        { id: 10, user_id: 7, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
        { id: 11, user_id: 7, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } }) };
    }
    return prev(input, init);
  });
  const yesterdayStart = COMPLETED_YESTERDAY.startMs / 1000;
  const yesterdayReads = () => f.state.statCalls.filter((call) => call.start === yesterdayStart).length;
  const catalogueReads = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/token/").length;
  const statusReads = () => f.state.requests.filter((request) => request.host === "upstream.test" && request.path === "/api/status").length;
  const state = () => f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");

  await f.module.refreshDue(now);
  const firstRecheckAt = now + 10 * 60000;
  assert.deepEqual([state().manual_reason, state().attempts, state().next_attempt_at_ms], ["KEY_INVALID_OR_DENIED", 0, firstRecheckAt], "Key 停用了：要人处理");
  assert.equal(yesterdayReads(), 0, "第一次试也先在本地判断：挡着的不取这天的账单");
  const writes = [], recordState = f.repository.recordSettlementState.bind(f.repository);
  t.mock.method(f.repository, "recordSettlementState", async (...args) => { writes.push(args); return recordState(...args); });

  // 满 10 分钟：在本地重判，Key 还是停用的——不取这天的账单，也不为它强制重读 Key 目录（目录 5 分钟到期照常读）
  now += 10 * 60000;
  let reads = yesterdayReads(), catalogues = catalogueReads(), statuses = statusReads();
  await f.module.refreshDue(now);
  assert.equal(yesterdayReads() - reads, 0, "不取这天的账单");
  assert.equal(catalogueReads() - catalogues, 1, "Key 目录只按 5 分钟到期读一次");
  assert.equal(statusReads() - statuses, 0, "不为它强制重读：身份和 /api/status 30 分钟才到期，这一轮不读");
  // 原因没变：状态行一个字都不写（原来每 10 分钟写一次），下次重判的时刻单独记在进程里
  assert.equal(writes.length, 0, "原因没变，不写状态行");
  assert.deepEqual([state().manual_reason, state().attempts, state().next_attempt_at_ms], ["KEY_INVALID_OR_DENIED", 0, firstRecheckAt]);
  assert.equal(f.rt._reconciliationRecheckAt.get("rr_live|2026-10-08"), now + 10 * 60000, "下次重判是 10 分钟以后");
  for (let minute = 1; minute < 10; minute += 1) {
    now += 60000;
    catalogues = catalogueReads();
    await f.module.refreshDue(now);
    assert.equal(writes.length, 0);
  }
  assert.equal(f.rt._reconciliationRecheckAt.get("rr_live|2026-10-08"), now - 9 * 60000 + 10 * 60000, "中间的轮次不再重判，时刻不动");

  // 上游把 Key 启用了：下一次重判发现原因没了，记下来；再下一轮先重读这个上游，再去结
  keyStatus = 1;
  now += 60000;
  reads = yesterdayReads();
  await f.module.refreshDue(now);
  assert.equal(yesterdayReads() - reads, 0, "重判这一轮还不取账单");
  assert.equal(state().last_detail.cleared, true, "原因没了：这才写状态行");
  assert.equal(writes.length, 1);
  now += 60000;
  await f.module.refreshDue(now);
  assert.ok(yesterdayReads() > reads, "下一轮去结");
  assert.equal(state(), undefined, "结成了，状态行删掉");
  assert.deepEqual(f.state.ledger.filter((row) => row.rule_id === "rr_live").map((row) => row.bill_date), ["2026-10-08"]);
});

test("C2a 结账照样核验并记下 Sub2API 的账单能力：只有昨天有消费、今天一直没有，昨天也能结", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-settle-capability.test", costs: { "2026-10-10": 2 } });
  await f.module.refreshDue(now);
  assert.ok(f.sub2.controls >= 1, "结昨天时核验了账单能力");
  assert.deepEqual(f.state.ledger.map((row) => row.bill_date), ["2026-10-10"], "昨天结进账本");
  assert.equal(f.repository.tables.settlementState.length, 0);
});

test("C2a 本地重判看不出来的原因（取账单时才被上游拒绝）：重判说没了、去结还是要人处理，以后到点直接去结、按退避表计次", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    // 目录里这把 Key 好好的，取它的用量时上游却拒绝
    if (url.host === "upstream.test" && url.pathname === "/api/log/self/stat" && url.searchParams.get("token_name") === "stable") {
      f.state.statCalls.push({ side: "upstream", start: Number(url.searchParams.get("start_timestamp")), end: Number(url.searchParams.get("end_timestamp")) });
      return { status: 403, text: async () => JSON.stringify({ success: false, message: "无权进行此操作" }) };
    }
    return prev(input, init);
  });
  const yesterdayStart = COMPLETED_YESTERDAY.startMs / 1000;
  const yesterdayReads = () => f.state.statCalls.filter((call) => call.start === yesterdayStart).length;
  const state = () => f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  const minute = async (n = 1) => { for (let i = 0; i < n; i += 1) { now += 60000; await f.module.refreshDue(now); } };

  await f.module.refreshDue(now);
  assert.deepEqual([state().manual_reason, state().attempts], ["KEY_INVALID_OR_DENIED", 0]);
  await minute(10); // 到点本地重判：目录里看不出问题，记 cleared
  assert.equal(state().last_detail.cleared, true);
  let reads = yesterdayReads();
  await minute(); // 下一轮去结：还是被拒绝，记成本地看不出来，开始计次
  assert.ok(yesterdayReads() > reads);
  assert.deepEqual([state().manual_reason, state().attempts, state().last_detail.probeBlind, state().next_attempt_at_ms], ["KEY_INVALID_OR_DENIED", 1, true, now + 30 * 60000], "这天变成要人处理已经 11 分钟：退避按从第一次失败起过了多久选档，落在 30 分钟档");
  reads = yesterdayReads();
  await minute(29);
  assert.equal(yesterdayReads(), reads, "按退避表等 30 分钟，中间不本地重判、不取账单");
  await minute();
  assert.ok(yesterdayReads() > reads, "到点直接去结");
  assert.deepEqual([state().attempts, state().last_detail.probeBlind, state().next_attempt_at_ms], [2, true, now + 2 * 60 * 60000], "第二次没成，已经过了 40 分钟以上，落在最高一档 2 小时");
});

test("C2a 本地重判自己出错：按原因还在，10 分钟后再判，不每轮重来", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now });
  const prev = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "upstream.test" && url.pathname === "/api/token/") {
      return { status: 200, text: async () => JSON.stringify({ success: true, data: { total: 3, items: [
        { id: 9, user_id: 7, name: "stable", status: 2, group: "g1", cross_group_retry: false },
        { id: 10, user_id: 7, name: "stable-rr_two", status: 1, group: "g1", cross_group_retry: false },
        { id: 11, user_id: 7, name: "stable-rr_three", status: 1, group: "g1", cross_group_retry: false }] } }) };
    }
    return prev(input, init);
  });
  const state = () => f.repository.tables.settlementState.find((row) => row.rule_id === "rr_live" && row.bill_date === "2026-10-08");
  await f.module.refreshDue(now);
  assert.equal(state().manual_reason, "KEY_INVALID_OR_DENIED");
  // 本地重判一开头读绑定时库出错
  const getRule = f.repository.getRule.bind(f.repository);
  t.mock.method(f.repository, "getRule", async (ruleId) => {
    if (ruleId === "rr_live") throw Object.assign(new Error("数据库连不上"), { code: "PERSISTENCE_FAILED" });
    return getRule(ruleId);
  });
  t.mock.method(console, "error", () => {});
  const firstRecheckAt = state().next_attempt_at_ms;
  now += 10 * 60000;
  await f.module.refreshDue(now);
  // 没判出来按原因还在：状态行不写，下次重判推到 10 分钟以后（记在进程里），不计次数
  assert.deepEqual([state().manual_reason, state().next_attempt_at_ms, state().attempts], ["KEY_INVALID_OR_DENIED", firstRecheckAt, 0]);
  assert.equal(f.rt._reconciliationRecheckAt.get("rr_live|2026-10-08"), now + 10 * 60000, "推后 10 分钟");
  assert.notEqual(state().last_detail?.cleared, true, "没判出来，不当成原因没了");
});

test("C2a 每小时清一批状态表：31 天前、没有重结请求（或请求早已放弃）的行；一小时内不重复清", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0 } });
  const old = (day, extra = {}) => ({ rule_id: "rr_live", bill_date: day, retry_reason: "PENDING", manual_reason: null, manual_since_ms: null, attempts: 3,
    next_attempt_at_ms: null, first_failed_at_ms: null, last_attempt_at_ms: null, resettle_requested_at_ms: null, resettle_reason: null, source_version: null,
    last_detail: null, updated_at_ms: 0, ...extra });
  // 09-02 的日子很早，但重结请求才提了两天，还要结；09-04 的请求是 31 天以前提的（早已放弃），一起清
  f.repository.tables.settlementState.push(old("2026-09-01"), old("2026-09-02", { resettle_requested_at_ms: now - 2 * 86400000 }),
    old("2026-09-04", { resettle_requested_at_ms: 1 }), old("2026-09-20"));
  await f.module.refreshDue(now);
  assert.deepEqual(f.repository.tables.settlementState.map((row) => row.bill_date).filter((day) => day < "2026-10-01").sort(), ["2026-09-02", "2026-09-20"],
    "只删 31 天前、没有请求或请求早已放弃的");
  f.repository.tables.settlementState.push(old("2026-09-03"));
  now += 30 * 60000;
  await f.module.refreshDue(now);
  assert.ok(f.repository.tables.settlementState.some((row) => row.bill_date === "2026-09-03"), "一小时内不再清");
  now += 31 * 60000;
  await f.module.refreshDue(now);
  assert.equal(f.repository.tables.settlementState.some((row) => row.bill_date === "2026-09-03"), false);
});

test("R1 多天窗口（近 7 天）：已固定的天用账本、不读管理员日志；没固定的过去整天和今天分开读——过去的那块按渠道 stat，只有今天那一块翻页（审核 CI：开了定时测试的站 60 秒超时）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z"); // 上海 10-09 11:00；开始统计 10-07 0 点
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  // root 名下 10-07、10-08 各 3000 条测试记录（各 30 页），今天 50 条（1 页）
  const dayStart = Date.parse("2026-10-06T16:00:00Z") / 1000;
  let id = 1;
  for (let day = 0; day < 3; day += 1) for (let i = 0; i < (day < 2 ? 3000 : 50); i += 1) f.state.testLogs.push(usage(id++, 0, { channel: 1 + (i % 2), created_at: dayStart + day * 86400 + 10 + i * 20 }));
  const rootReads = () => f.state.requests.filter((request) => request.host === "own.test" && /^\/api\/log\//.test(request.path) && /username=root/.test(request.query));
  const rootPages = () => rootReads().filter((request) => request.path === "/api/log/").length;
  const week = (ruleId) => f.module.queryRules({ ruleIds: [ruleId], preset: "7d" }, { mode: "evaluate", origin: "page", force: true }).then((r) => r.results[0]);
  // 两天都没固定：过去两天并成一块、按渠道 stat（第一页读一次就知道 6000 行翻不过 2 个 stat），今天那一块翻 1 页
  const before = rootPages();
  const first = await week("rr_live");
  assert.equal(first.health.code, "READY");
  assert.ok(first.calculation.profitUsd != null);
  assert.ok(rootPages() - before <= 3, `没固定的两天不整段翻页（只翻了 ${rootPages() - before} 页，改动前是 61 页）`);
  assert.ok(rootReads().some((request) => request.path === "/api/log/stat" && /channel=/.test(request.query)), "过去的那块走了按渠道 stat");
  // 结账 10-07、10-08 以后：已固定的天用账本，一页都不翻
  await f.module.refreshDue(now);
  assert.deepEqual(f.state.ledger.filter((r) => r.rule_id === "rr_live").map((r) => r.bill_date).sort(), ["2026-10-07", "2026-10-08"]);
  now += 60000;
  const mid = rootPages();
  const second = await week("rr_live");
  assert.ok(second.calculation.profitUsd != null);
  assert.ok(rootPages() - mid <= 1, `已固定的天不读管理员日志：${rootPages() - mid} 页`);
});

test("R1 沿用要看管理员名单：bob 结第一条绑定时是管理员、之后被降成普通用户，第二条绑定不能沿用「全在管理员名下」那份，他名下的测试记录照兜底扣（审核 #127 中-1）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 60 * 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_three" ? 0 : 1;
  const bob = { id: 3, username: "bob", display_name: "", role: 100, status: 1 };
  f.state.ownUsers = [...OWN_USERS, bob];
  // bob-key 那条挪到第一次结账之前（和另两条模型测试放一起）：这条本来就在，不是降级以后新来的，照样要按当时的名单判（审核 #127 M1 改坏检验）
  f.state.testLogs.push(usage(1, 30, { token_name: "模型测试", token_id: 0, username: "bob", channel: 1 }), usage(2, 40, { token_name: "模型测试", token_id: 0, username: "bob", channel: 2 }),
    usage(3, 50, { token_name: "bob-key", token_id: 9, username: "bob", channel: 2 })); // bob 自己的 Key：降级后算收入；整份沿用的话会多扣成 160
  const settle = (ruleId) => f.module.queryRules({ ruleIds: [ruleId], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "observe", force: true, origin: "manual" }).then((r) => r.results[0]);
  const first = await settle("rr_live");
  assert.equal(first.downstream.quotaUnits, 250 - 30, "bob 是管理员：他的测试记录按管理员扣");
  f.state.ownUsers = [...OWN_USERS, { ...bob, role: 1 }]; // 降成普通用户
  now += 1000; // 时钟要走：结账读「这一轮开始以后」的名单，不动时钟会拿到缓存里的旧名单
  const second = await settle("rr_two");
  assert.equal(second.downstream.quotaUnits, 250 - 40, "名单变了不沿用：bob 名下的测试记录按兜底扣、他自己 Key 的照算收入（整份沿用是 160，沿用「全在管理员名下」那份是 250）");
});

test("R1 结账一轮里几条绑定共用一份管理员名单：用户列表每轮只读一遍，不是每条绑定各读一遍（审核 #127 增量 中-2）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  // 时钟每次走 1 毫秒：去掉 freshSince（每条绑定都重读）时，这一轮里的几次读都会落在不同的「现在」，读到 7 遍（审核 #127 改坏检验）
  const f = await completedDayFixture(t, { clock: () => (now += 1), moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  f.state.testLogs.push(usage(1, 30, { token_name: "模型测试", token_id: 0, channel: 1 }));
  const userReads = () => f.state.requests.filter((request) => request.host === "own.test" && request.path === "/api/user/").length;
  await f.module.refreshDue(now); // 三条绑定、两天（10-07、10-08）都在这一轮结
  assert.ok(f.state.ledger.filter((row) => row.bill_date === "2026-10-08").length === 3, "三条都结了");
  assert.equal(userReads(), 1, `这一轮用户列表要正好读 1 遍，读了 ${userReads()} 遍`);
});

test("R2 设置读不到的 24 小时按状态行里第一次读不到的时刻算：中途重启（新建模块）也不清零，到时照常固定，站点那一层进需处理（审核增量 中-B）", async (t) => {
  let now = Date.parse("2026-10-09T03:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  f.state.optionReply = [502, { success: false }];
  await f.module.refreshDue(now);
  const row = f.repository.tables.settlementState.find((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-08");
  assert.equal(row?.retry_reason, "OWN_OPTION_UNREADABLE");
  // 12 小时后重启：新模块，进程里什么都不记得
  now += 12 * 3600000;
  const restarted = createReconciliationModule(f.rt, { repository: f.repository, ownLogIngest: false });
  await restarted.refreshDue(now);
  assert.deepEqual(f.state.ledger.filter((r) => r.rule_id === "rr_live").map((r) => r.bill_date), [], "重启后 12 小时：还没到 24 小时，接着等");
  // 再 13 小时又重启一次：状态行记的第一次读不到已经过了 24 小时 → 照常固定，推一条
  now += 13 * 3600000;
  f.rt.store.channels = [{ id: "c", type: "webhook", name: "运维群", enabled: true, config: { url: "https://hooks.example.com/x" } }];
  const again = createReconciliationModule(f.rt, { repository: f.repository, ownLogIngest: false });
  await again.refreshDue(now);
  const settled = f.state.ledger.filter((r) => r.rule_id === "rr_live").map((r) => r.bill_date).sort();
  assert.ok(settled.includes("2026-10-08"), `过了 24 小时（跨两次重启）照常固定：${settled}`);
  const detail = f.state.ledger.find((r) => r.rule_id === "rr_live" && r.bill_date === "2026-10-08").detail;
  assert.deepEqual([detail.settlement.consumeLogSetting.state, detail.settlement.consumeLogSetting.reason], ["unreadable", "too_long"]);
  assert.equal(detail.settlement.consumeLogSetting.sinceMs, Date.parse("2026-10-09T03:00:00Z"), "从状态行里拿的第一次读不到的时刻");
  const page = await again.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "evaluate", origin: "page" });
  assert.ok(page.actions.some((action) => action.code === "OWN_OPTION_UNREADABLE"), "重启后站点那一层也知道读不到太久了");
  assert.ok(page.results[0].ledger.consumeLogSetting, "已固定那天的 ledgerReference 带着那一句的依据（计算明细显示）");
  // 那几天都固定了、状态行删了以后又重启：需处理那一条还在（从告警状态表里那一条的首次出现时刻拿，审核增量 中-C）；从账本读回的 ledgerReference 也带那一句的依据（低-G）
  now += 6 * 3600000;
  const third = createReconciliationModule(f.rt, { repository: f.repository, ownLogIngest: false });
  f.rt._reconciliationResultCache.clear();
  const afterRestart = await third.queryRules({ ruleIds: ["rr_live"], preset: "custom", startMs: COMPLETED_YESTERDAY.startMs, endMs: COMPLETED_YESTERDAY.endMs }, { mode: "evaluate", origin: "page" });
  assert.ok(afterRestart.actions.some((action) => action.code === "OWN_OPTION_UNREADABLE"), "固定以后再重启，需处理那条还在");
  assert.equal(f.state.requests.filter((request) => request.host === "hooks.example.com").length, 1, "超过 24 小时推了一条、只推一条（记在告警状态表 opt:own 上，之后只刷新最近看到的时刻）");
  assert.deepEqual([afterRestart.results[0].ledger.consumeLogSetting.state, afterRestart.results[0].ledger.consumeLogSetting.reason], ["unreadable", "too_long"], "从账本读回的也带");
  // 设置读得到了：需处理那条去掉
  f.state.optionReply = null;
  now += 60000;
  const back = await third.queryRules({ ruleIds: ["rr_live"], preset: "today" }, { mode: "observe", origin: "manual", force: true });
  assert.ok(!back.actions.some((action) => action.code === "OWN_OPTION_UNREADABLE"));
});

test("R2 「这天结束以后读到过开着」才算证据：22:00 读到开着、之后设置读不到，这一天不能凭它固定（审核增量 低-A）；过了零点读到过开着再读不到才能", async (t) => {
  // 上海 10-08 22:00 读到开着（今天的轮询），10-09 11:00 起设置读不到
  let now = Date.parse("2026-10-08T14:00:00Z");
  const f = await completedDayFixture(t, { clock: () => now, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of f.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  await f.module.refreshDue(now); // 读到开着
  now = Date.parse("2026-10-09T03:00:00Z");
  f.state.optionReply = [502, { success: false }];
  await f.module.refreshDue(now);
  assert.ok(!f.state.ledger.some((r) => r.rule_id === "rr_live" && r.bill_date === "2026-10-08"), "22:00 那次开着在这天结束以前，不算证据：先等");
  // 另一条：10-09 01:00 读到开着（这天已经结束，上游那一轮读不到没结成），11:00 设置读不到 → 凭读到过开着照常固定
  let now2 = Date.parse("2026-10-08T17:00:00Z");
  const g = await completedDayFixture(t, { clock: () => now2, moduleOptions: { lookbackDelayMs: 0, lookbackBudget: 10, lookbackTimeMs: 60000 } });
  for (const row of g.rows) row.enabled = row.id === "rr_live" ? 1 : 0;
  g.state.upstreamQuota = null; // 上游读不到：这一轮结不成，但设置读到了开着
  await g.module.refreshDue(now2);
  assert.deepEqual(g.state.ledger.filter((r) => r.rule_id === "rr_live").map((r) => r.bill_date), []);
  g.state.upstreamQuota = 100; g.state.optionReply = [502, { success: false }];
  now2 = Date.parse("2026-10-09T03:00:00Z");
  await g.module.refreshDue(now2);
  const settled = g.state.ledger.find((r) => r.rule_id === "rr_live" && r.bill_date === "2026-10-08");
  assert.ok(settled, "这天结束以后读到过开着：照常固定");
  assert.equal(settled.detail.settlement.consumeLogSetting.reason, "proven_on");
});

// 审核 #114 中-F 用例草稿（放进 server/reconciliation.test.js 末尾即可；用到同文件里的 sub2ReconciliationFixture、canonicalBillingKey、ownSourceRead）。
// Sub2API 绑定当天换绑（accounting_floor 在那天中间），之后有一天关过收费记录：近几天的多天窗口里那一天两边都不算，
// 上游仍按整天读（换绑那天从 0 点起），合计等于没跳过那几天之和。中-F 改回去（头一截上游起点被裁成换绑时刻）就会失败。
//
// 夹具要点（作者卡在 PENDING 的原因）：
//  1. 页面只读查询（mode: "evaluate"）在这条绑定被观测过之前一律回 PENDING（「还没观测过就没有可靠口径」，inspectRule 里 pendingResult）。
//     先跑一次带观测的：refreshDue(now) 或 queryRules(today, { force: true })（默认 mode 是 observe），绑定才锚定。
//  2. Sub2API 的账单能力要用「已结束那天有正消费」来核验：refreshDue 会去结昨天，昨天要有消费（costs 里给昨天一个正数）。
//     没核验过时多天窗口回 UPSTREAM_CAPABILITY_UNVERIFIED（上游 partial，成本空）。
//  3. sub2ReconciliationFixture 的假账单只按 start_date 给一天的数；多天窗口一次读一个 start_date~end_date 的范围，
//     要按范围把每天加起来才对得上真值，下面在夹具外面再包一层 fetch。
test("R2 × C3 Sub2API 当天换绑以后有一天关过收费记录：多天窗口跳过那一天，上游按整天读、合计等于其余几天（审核 #114 中-F）", async (t) => {
  const tz = "Asia/Shanghai";
  const at = (iso) => Date.parse(`${iso}+08:00`);
  const floor = at("2026-10-06T14:30:00"); // 上海 10-06 14:30 从 New API 换绑到这条 Sub2API 绑定
  let now = at("2026-10-10T11:00:00");
  t.mock.method(Date, "now", () => now);
  const costs = { "2026-10-06": 6, "2026-10-07": 7, "2026-10-08": 8, "2026-10-09": 9, "2026-10-10": 1 };
  const f = sub2ReconciliationFixture(t, { baseUrl: "https://sub2-midf.test", costs, moduleOptions: { lookbackDelayMs: 24 * 3600000 } });
  Object.assign(f.rule, { billing_effective_from_ms: floor + 60000, accounting_floor_ms: floor, provider: "sub2api" });
  f.rule.canonical_key = canonicalBillingKey(f.stations[0], { platform: "sub2api", accountId: 7 }, f.rule.token_id);
  // 自营站点的渠道收费：每分钟 1 额度（quota_per_unit 100 → 每分钟 0.01 美元），按请求的起止现算；上游 Sub2API 按日期范围把每天加起来
  const ownQuota = (start, end) => Math.max(0, Math.floor(Math.min(end, Math.floor(now / 1000)) / 60) - Math.ceil(start / 60) + 1);
  const inner = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    const json = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
    if (url.host === "own.test" && url.pathname === "/api/log/stat" && !ownSourceRead(url)) {
      return json({ success: true, data: { quota: ownQuota(Number(url.searchParams.get("start_timestamp")), Number(url.searchParams.get("end_timestamp"))) } });
    }
    if (url.host === "sub2-midf.test" && !url.pathname.startsWith("/api/v1/auth") && !url.pathname.startsWith("/api/v1/keys")) {
      f.sub2.stats.push(Object.fromEntries(url.searchParams));
      let cost = 0;
      if (url.searchParams.get("api_key_id") === "9") for (const [day, value] of Object.entries(costs)) if (day >= url.searchParams.get("start_date") && day <= url.searchParams.get("end_date")) cost += value;
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { total_actual_cost: cost } }) };
    }
    return inner(input, init);
  });
  // 先观测一轮（锚定绑定 + 用昨天 10-09 的正消费核验 Sub2API 账单能力），不然页面只读查询一直是 PENDING / 能力未核验
  await f.module.refreshDue(now);
  await f.module.queryRules(f.today, { force: true });

  const window = { ruleIds: [f.rule.id], preset: "custom", timezone: tz, startMs: at("2026-10-06T00:00:00"), endMs: at("2026-10-10T00:00:00") };
  const read = async () => (await f.module.queryRules(window, { mode: "evaluate", origin: "page", force: true })).results[0];
  const whole = await read();
  assert.equal(whole.health.code, "READY", "一直开着：照常算");
  assert.deepEqual([whole.upstream.amountUsd, whole.downstream.amountUsd], [6 + 7 + 8 + 9, ownQuota(floor / 1000, at("2026-10-10T00:00:00") / 1000 - 1) / 100]);

  // 10-08 上海 10:00–11:00 关过收费记录（已经开回来）：10-08 两边都不算，其余天照算
  f.stations[1].consumeLogOffPeriods = [{ fromMs: at("2026-10-08T10:00:00"), toMs: at("2026-10-08T11:00:00") }];
  const before = f.sub2.stats.length;
  const partial = await read();
  assert.ok(partial.health.issues.some((issue) => issue.code === "OWN_CONSUME_LOG_GAP_PARTIAL"), "行上有那一句说明");
  assert.equal(partial.upstream.state, "complete", `上游读得到：${partial.health.code}`);
  assert.equal(partial.upstream.amountUsd, 6 + 7 + 9, "上游 = 10-06（换绑那天整天）+ 10-07 + 10-09，不含 10-08");
  const ownExpected = (ownQuota(floor / 1000, at("2026-10-08T00:00:00") / 1000 - 1) + ownQuota(at("2026-10-09T00:00:00") / 1000, at("2026-10-10T00:00:00") / 1000 - 1)) / 100;
  assert.equal(partial.downstream.amountUsd, ownExpected, "收入 = 换绑那一刻到 10-08 0 点 + 10-09 整天");
  const asked = f.sub2.stats.slice(before).filter((stat) => stat.api_key_id === "9").map((stat) => `${stat.start_date}~${stat.end_date}`).sort();
  assert.deepEqual(asked, ["2026-10-06~2026-10-07", "2026-10-09~2026-10-09"], "上游按整天读两截，换绑那天从 0 点起，10-08 不读");
});


// 读取服务一断，库里已经记着的需处理事项继续挡（不能只看这一轮内存里算出来的）
test("K2b：CHANNEL_KEY_UNMATCHED 记着的日子，读取服务随后断了也不会被固定——事项只有读得到、重新判断以后才清", async (t) => {
  const { f, agent, round, state, booked } = await readerOutageFixture(t);
  const keyNine = agent.key;
  await round("2026-10-11T06:00:00Z"); // R0：正常
  agent.key = "sk-" + "Unkn".repeat(10);
  await round("2026-10-11T10:00:00Z"); // R1：认出渠道换成了哪都没有的 Key（b = 10:00Z，10-11 这天跨过了 b）
  assert.equal((await f.repository.getRule("rr_live")).keyIssue.sinceMs, Date.parse("2026-10-11T10:00:00Z"));
  await round("2026-10-11T16:05:00Z"); // R2：10-11 刚结束（上海 24:00 = 16:00Z），还没到结账的点；读取服务读得到（最后一次读到在 10-11 结束以后）
  agent.down = true;
  await round("2026-10-11T16:30:00Z"); // R3：读不到。最后一次读到在 10-11 结束以后，例外三不挡 10-11——只剩库里记着的事项挡得住
  assert.equal(booked("2026-10-11"), 0, "读取服务断了，b 以后的 10-11 也不能被固定");
  assert.equal((await state("2026-10-11"))?.manualReason, "CHANNEL_KEY_UNMATCHED", "状态行还说原来的事项");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue?.sinceMs, Date.parse("2026-10-11T10:00:00Z"), "读不到的轮次不清记号、不改 b");

  agent.down = false;
  agent.key = keyNine; // 连上了，渠道又是原来那把：事项解开
  await round("2026-10-11T17:00:00Z");
  await round("2026-10-11T17:15:00Z");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null, "读得到、重新判断以后才清");
  assert.equal(booked("2026-10-11"), 1, "事项解开以后照常固定");
});

// 高-3：同一条绑定换了一种事项，b 沿用最早的那个，不重置成现在
test("K2b：同一条绑定的事项换了码（CHANNEL_KEY_UNMATCHED → KEY_GROUP_CHANGED），b 沿用最早的，之前被挡的日子不会被放行", async (t) => {
  const clock = { now: Date.parse("2026-10-10T12:00:00Z") };
  t.mock.method(Date, "now", () => clock.now);
  const keyNine = "sk-" + "Nine".repeat(10), keyTen = "sk-" + "TenT".repeat(10), unknown = "sk-" + "Unkn".repeat(10);
  const agent = { secret: KEY_AGENT_SECRET, keys: { 1: keyNine, 2: keyNine } };
  const f = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_b"], // 让上游目录列出 token 10
    channelsByRule: { rr_live: [1, 2], rr_b: [3] },
    tokenKeyOf: (tokenId) => (tokenId === 9 ? keyNine : keyTen),
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [1, 2].map((id) => ({ id, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(agent.keys[id]), f: `unused-${id}` }] })) },
  });
  const round = async (isoTime) => { clock.now = Date.parse(isoTime); f.rt._keyAgentIdentifyCache = null; await f.module.refreshDue(clock.now); };
  const booked = (billDate) => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === billDate).length;
  await round("2026-10-10T12:00:00Z"); // 正常：两个渠道都是 token 9
  agent.keys = { 1: unknown, 2: unknown }; // 两个渠道都换成了哪都没有的 Key
  await round("2026-10-10T15:00:00Z"); // 事项一：CHANNEL_KEY_UNMATCHED，b = 15:00Z（上海 10-10 在 16:00Z 结束，跨过了 b）
  const first = (await f.repository.getRule("rr_live")).keyIssue;
  assert.deepEqual([first.code, first.sinceMs], ["CHANNEL_KEY_UNMATCHED", Date.parse("2026-10-10T15:00:00Z")]);
  agent.keys = { 1: keyNine, 2: keyTen }; // 渠道 1 回到原来那把、渠道 2 认出是 token 10：组散了
  await round("2026-10-10T16:30:00Z"); // 事项二：KEY_GROUP_CHANGED。b 不能重置成 16:30Z——不然 10-10（16:00Z 结束）又被放行
  const second = (await f.repository.getRule("rr_live")).keyIssue;
  assert.equal(second.code, "KEY_GROUP_CHANGED");
  assert.equal(second.sinceMs, Date.parse("2026-10-10T15:00:00Z"), "b 沿用最早的事项的");
  assert.equal(booked("2026-10-10"), 0, "10-10 一直被挡着，没有因为换了码就被固定");

  agent.keys = { 1: keyNine, 2: keyNine }; // 回到正常
  await round("2026-10-10T17:00:00Z");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null, "事项全部解除才清");
});

// 互相牵连的绑定一组一个事务；一组撞了约束只回滚这一组，别的组照常换段
test("K2b：同一轮里一条绑定撞了唯一约束、另外两条正常换 Key——正常的两条段写进去了，撞的那条回滚并记 KEY_GROUP_CHANGED；下一轮冲突解开后它也能换", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 10: "sk-" + "TenT".repeat(10), 11: "sk-" + "Elev".repeat(10), 20: "sk-" + "Twen".repeat(10), 21: "sk-" + "Tw1n".repeat(10), 22: "sk-" + "Tw2n".repeat(10) };
  const channelKey = { 1: keys[9], 3: keys[10], 4: keys[11] };
  let conflictFor = null; // 哪条绑定的事务在提交时撞唯一键（模拟 detectGroupMerges 没预检查到的边界）
  const f = liveReconciliationFixture(t, {
    segments: [{ id: "s1", group: "g1", from: 0 }],
    extraRuleIds: ["rr_b", "rr_c"],
    channelsByRule: { rr_live: [1], rr_b: [3], rr_c: [4] },
    tokenKeyOf: (tokenId) => keys[tokenId],
    extraTokens: [{ tokenId: 20, name: "new-a" }, { tokenId: 21, name: "new-b" }, { tokenId: 22, name: "new-c" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => Object.entries(channelKey).map(([id, key]) => ({ id: Number(id), baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(key), f: "unused" }] })) },
    onRepositoryCommit: (record) => { if (conflictFor && record.keyChangeRuleIds?.includes(conflictFor)) throw Object.assign(new Error("duplicate key"), { code: "ER_DUP_ENTRY", errno: 1062 }); },
  });
  await f.module.refreshDue(now); // 第一轮：三条都锚定、没有变化
  const tokenOf = async (id) => (await f.repository.getRule(id)).tokenId;
  assert.deepEqual([await tokenOf("rr_live"), await tokenOf("rr_b"), await tokenOf("rr_c")], [9, 10, 11]);

  Object.assign(channelKey, { 1: keys[20], 3: keys[21], 4: keys[22] }); // 三条绑定各自的渠道都换了 Key（互不牵连）
  conflictFor = "rr_c";
  now = Date.parse("2026-10-12T01:00:00Z");
  await f.module.refreshDue(now);
  assert.deepEqual([await tokenOf("rr_live"), await tokenOf("rr_b")], [20, 21], "没撞的两条照常换了段");
  assert.equal((await f.repository.listSegments("rr_live")).length, 3);
  assert.equal(await tokenOf("rr_c"), 11, "撞的那条整组回滚，逐字不变");
  assert.equal((await f.repository.listSegments("rr_c")).length, 1, "没有残留的段");
  assert.equal((await f.repository.getRule("rr_c")).keyIssue?.code, "KEY_GROUP_CHANGED", "撞的那条记会自己好的分组冲突");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null, "别的组不连坐");
  assert.equal((await f.repository.getRule("rr_b")).keyIssue, null);
  assert.equal(f.stations[1].keyAgentLastSuccessAtMs, Date.parse("2026-10-11T01:00:00Z"), "撞了的组这一轮没处理完：站点的成功时刻不往前推");

  conflictFor = null; // 冲突解开
  now = Date.parse("2026-10-12T01:10:00Z");
  f.rt._keyAgentIdentifyCache = null;
  await f.module.refreshDue(now);
  assert.equal(await tokenOf("rr_c"), 22, "下一轮冲突解开以后撞的那条也换了段");
  assert.equal((await f.repository.getRule("rr_c")).keyIssue, null);
  assert.equal(await tokenOf("rr_live"), 20, "已经换好的不再动");
});

test("K2b 例外三：这个站点从来没读成功过（内存和持久化都没有「最后一次读到」），读不到就一律先不算——从开着那段的起点起挡，不用「现在」把从没核对过 Key 的日子放行", async (t) => {
  const { f, agent, round, state, booked } = await readerOutageFixture(t);
  agent.down = true; // 第一轮就读不到，没有任何一次读到过
  await round("2026-10-11T16:30:00Z"); // 10-11 刚结束（16:00Z）：以前会因为 sinceMs = 现在 而被固定
  assert.equal(booked("2026-10-11"), 0, "从来没核对过 Key，读不到时哪天都不固定");
  assert.equal((await state("2026-10-11"))?.retryReason, "KEY_AGENT_UNAVAILABLE");
  assert.equal(f.stations[1].keyAgentLastSuccessAtMs ?? null, null);
  agent.down = false; // 连上了，Key 没变：照常固定
  await round("2026-10-11T17:00:00Z");
  await round("2026-10-11T17:15:00Z");
  assert.equal(booked("2026-10-11"), 1, "读到以后照常算");
});

// K2c 重新分组（k-plan 3.3）：K2b 认出分组/合组以后，能分就分——旧绑定在 b 归档（分组的在 [a, b) 开一段放两把 Key），新绑定从 b 起算
function regroupFixture(t, { rules, channelsByRule, tokens, keysOf }) {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 10: "sk-" + "TenT".repeat(10), 11: "sk-" + "Elev".repeat(10), 20: "sk-" + "Twen".repeat(10), 21: "sk-" + "Tw1n".repeat(10) };
  const channelKey = { ...keysOf }; // 渠道 -> 现在填的 Key（测试里随时改）
  const f = liveReconciliationFixture(t, {
    policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: rules, channelsByRule,
    tokenKeyOf: (tokenId) => keys[tokenId],
    extraTokens: tokens,
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => Object.entries(channelKey).map(([id, tokenId]) => ({ id: Number(id), baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[tokenId]), f: "unused" }] })) },
  });
  f.stations[0].accountUse = "only_mine"; // 上游答了「只给我的渠道用」：新组不用再回答
  const revisions = () => Object.fromEntries(Object.keys(channelKey).map((id) => [id, `rev-${id}`]));
  const setCatalogue = (namespaceKey) => { f.rt.onboardingSource = { ...f.rt.onboardingSource, getSourceCatalogue: () => ({ ownSource: { namespaceKey }, stale: false,
    channels: Object.keys(channelKey).map((id) => ({ id: Number(id), name: `渠道 ${id}`, revision: revisions()[id], missing: false })) }) }; };
  return { f, channelKey, setCatalogue, setNow(value) { now = value; } };
}

test("K2c：分组——一条绑定两个渠道原来共用一把 Key，其中一个换了 Key：旧绑定在 b 归档、[a,b) 放两把 Key，新绑定一渠道一条从 b 起算，KEY_GROUP_CHANGED 不再留着", async (t) => {
  const g = regroupFixture(t, { rules: [], channelsByRule: { rr_live: [1, 2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "twen" }], keysOf: { 1: 9, 2: 9 } });
  const { f } = g;
  await f.module.refreshDue(Date.parse("2026-10-11T01:00:00Z")); // R0：正常，锚定
  const anchored = await f.repository.getRule("rr_live");
  g.setCatalogue(anchored.ownSource.namespaceKey);
  g.channelKey[2] = 20; // 渠道 2 换成了 token 20：组散了
  g.setNow(Date.parse("2026-10-12T01:00:00Z"));
  g.f.rt._keyAgentIdentifyCache = null;
  await f.module.refreshDue(g.f.rt && Date.parse("2026-10-12T01:00:00Z")); // R1：认出来，直接重新分组
  const a = Date.parse("2026-10-11T01:00:00Z"), b = Date.parse("2026-10-12T01:00:00Z");
  const old = await f.repository.getRule("rr_live", { includeArchived: true });
  assert.deepEqual([old.enabled, old.archivedAtMs], [false, b], "旧绑定在 b 归档");
  const segments = await f.repository.listSegments("rr_live");
  assert.deepEqual(segments.map((segment) => [segment.effectiveFrom, segment.effectiveTo, segment.timingSource]).slice(-2), [[0, a, "operator_confirmed"], [a, b, "key_change_window"]]);
  assert.deepEqual(segments.at(-1).keys.map((key) => key.tokenId).sort((x, y) => x - y), [9, 20], "[a,b) 两把 Key 都放着");
  const rules = (await f.repository.listRules()).filter((rule) => rule.enabled);
  assert.deepEqual(rules.map((rule) => [rule.tokenId, rule.channels.map((channel) => channel.channelId), rule.accountingFloorMs, rule.keyIssue]).sort((x, y) => x[0] - y[0]),
    [[9, [1], b, null], [20, [2], b, null]], "新绑定一渠道一条，从 b 起算，没有事项");
  assert.equal(rules.every((rule) => rule.canonicalKey && rule.ownSource?.namespaceKey === anchored.ownSource.namespaceKey), true);
  // 新绑定的账：从 b 起——查 b 所在的那天，上游成本只取 b 起（核算起点下限），不取 b 以前（那是旧绑定的）
  const before = f.state.requests.length;
  g.setNow(Date.parse("2026-10-12T02:00:00Z"));
  const day = await f.module.queryRules({ ruleIds: [rules.find((rule) => rule.tokenId === 20).id], preset: "custom", timezone: "Asia/Shanghai",
    startMs: Date.parse("2026-10-11T16:00:00Z"), endMs: Date.parse("2026-10-12T02:00:00Z") }, { force: true });
  const stats = f.state.requests.slice(before).filter((request) => request.host === "upstream.test" && request.path === "/api/log/self/stat").map((request) => new URLSearchParams(request.query));
  assert.ok(stats.length > 0 && stats.every((q) => q.get("token_name") === "twen" && Number(q.get("start_timestamp")) === b / 1000), "新绑定 b 以前的钱不取（旧绑定的）");
  assert.ok(day.results[0].health.issues.every((issue) => issue.code !== "KEY_GROUP_CHANGED"));
});

test("K2c：合组——两条绑定的渠道现在用同一把 Key：旧的两条各自在 b 归档（不开过渡段），新绑定放全部渠道从 b 起算", async (t) => {
  const g = regroupFixture(t, { rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }], keysOf: { 1: 9, 2: 10 } });
  const { f } = g;
  await f.module.refreshDue(Date.parse("2026-10-11T01:00:00Z"));
  g.setCatalogue((await f.repository.getRule("rr_live")).ownSource.namespaceKey);
  g.channelKey[2] = 9; // 渠道 2 也换成了 token 9：和渠道 1 同一把
  g.setNow(Date.parse("2026-10-12T01:00:00Z"));
  g.f.rt._keyAgentIdentifyCache = null;
  await f.module.refreshDue(Date.parse("2026-10-12T01:00:00Z"));
  const b = Date.parse("2026-10-12T01:00:00Z");
  for (const id of ["rr_live", "rr_b"]) {
    const old = await f.repository.getRule(id, { includeArchived: true });
    assert.deepEqual([old.enabled, old.archivedAtMs], [false, b]);
    assert.equal((await f.repository.listSegments(id)).length, 1, "合组：旧绑定不开过渡段");
  }
  const rules = (await f.repository.listRules()).filter((rule) => rule.enabled);
  assert.equal(rules.length, 1);
  assert.deepEqual([rules[0].tokenId, rules[0].channels.map((channel) => channel.channelId).sort(), rules[0].accountingFloorMs], [9, [1, 2], b]);
});

test("K2c：渠道目录没确认就不分，原样留着 KEY_GROUP_CHANGED、不结账；别处也在用的上游新组的 Key 没人答过（K2c-4）：照分，新组建一条还没回答的绑定，旧的 Key 沿用原来的回答", async (t) => {
  const g = regroupFixture(t, { rules: [], channelsByRule: { rr_live: [1, 2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "twen" }], keysOf: { 1: 9, 2: 9 } });
  const { f } = g;
  await f.module.refreshDue(Date.parse("2026-10-11T01:00:00Z"));
  const namespaceKey = (await f.repository.getRule("rr_live")).ownSource.namespaceKey;
  g.channelKey[2] = 20;
  const next = async (iso) => { g.setNow(Date.parse(iso)); g.f.rt._keyAgentIdentifyCache = null; await f.module.refreshDue(Date.parse(iso)); };
  await next("2026-10-12T01:00:00Z"); // 渠道目录还没确认（没有 getSourceCatalogue）：不分
  assert.equal((await f.repository.getRule("rr_live")).keyIssue?.code, "KEY_GROUP_CHANGED");
  assert.equal((await f.repository.getRule("rr_live")).enabled, true);
  g.setCatalogue(namespaceKey);
  f.stations[0].accountUse = "elsewhere"; // 别处也在用：新组的 Key（token 20）没人答过
  await next("2026-10-12T01:10:00Z");
  const old = await f.repository.getRule("rr_live", { includeArchived: true });
  assert.deepEqual([old.enabled, old.archivedAtMs], [false, Date.parse("2026-10-12T01:00:00Z")], "照分：b = 第一次认出来的时刻（不是分的这一轮）");
  const rules = (await f.repository.listRules()).filter((rule) => rule.enabled);
  const answered = rules.find((rule) => rule.tokenId === 9), fresh = rules.find((rule) => rule.tokenId === 20);
  assert.deepEqual([coverageNeedsAnswer(answered, "usage"), answered.coverageDeclaration?.answer], [false, "none"], "原来就在用的 Key 沿用原来的回答");
  assert.deepEqual([coverageNeedsAnswer(fresh, "usage"), fresh.coverageDeclaration?.answer ?? null, fresh.costCoverage], [true, "unknown", "unknown"], "新 Key 没人答过：建一条还没回答的绑定，需处理「这把 Key 还给别处用吗？」");
  assert.deepEqual(fresh.channels.map((channel) => channel.channelId), [2]);
});

test("K2c：牵连的绑定在 b 以后已经有固定过的日子，不分（旧、新两边都会算那几天）——原样留着 KEY_GROUP_CHANGED", async (t) => {
  const g = regroupFixture(t, { rules: [], channelsByRule: { rr_live: [1, 2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "twen" }], keysOf: { 1: 9, 2: 9 } });
  const { f } = g;
  await f.module.refreshDue(Date.parse("2026-10-11T01:00:00Z"));
  g.setCatalogue((await f.repository.getRule("rr_live")).ownSource.namespaceKey);
  g.channelKey[2] = 20;
  g.setNow(Date.parse("2026-10-12T01:00:00Z"));
  g.f.rt._keyAgentIdentifyCache = null;
  f.repository.tables.ledger.push({ rule_id: "rr_live", bill_date: "2026-10-13", revision: 1 }); // b（10-12）以后已经有一天固定了
  await f.module.refreshDue(Date.parse("2026-10-12T01:00:00Z"));
  assert.equal((await f.repository.getRule("rr_live")).enabled, true, "不分");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue?.code, "KEY_GROUP_CHANGED");
  assert.equal((await f.repository.listRules()).length, 1);
});

test("K2b：页面只读查询（evaluate）也看库里持久化的事项——UNMATCHED 记着的那天显示需处理的原因，不是「实时 / READY」；b 以前的日子不受影响；事项解开后观测一轮就没了", async (t) => {
  const { f, agent, round } = await readerOutageFixture(t);
  const keyNine = agent.key;
  await round("2026-10-11T06:00:00Z");
  agent.key = "sk-" + "Unkn".repeat(10);
  await round("2026-10-11T10:00:00Z"); // 认出渠道换成了哪都没有的 Key，b = 10:00Z，记进库里
  await round("2026-10-11T16:05:00Z"); // 10-11 结束了（还没到结账的点），事项还在
  const evaluate = async (startIso, endIso) => (await f.module.queryRules({ ruleIds: ["rr_live"], preset: "custom", timezone: "Asia/Shanghai",
    startMs: Date.parse(startIso), endMs: Date.parse(endIso) }, { mode: "evaluate" })).results[0];
  const day = await evaluate("2026-10-10T16:00:00Z", "2026-10-11T16:00:00Z"); // 10-11 整天，跨过 b
  assert.equal(day.health.code, "CHANNEL_KEY_UNMATCHED", "只读查询看持久化的事项，不是 READY");
  const before = await evaluate("2026-10-09T16:00:00Z", "2026-10-10T16:00:00Z"); // 10-10，整天在 b 以前
  assert.notEqual(before.health.code, "CHANNEL_KEY_UNMATCHED", "b 以前的日子不受影响");
  agent.key = keyNine; // 解开
  await round("2026-10-11T16:10:00Z");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue, null);
  assert.notEqual((await evaluate("2026-10-10T16:00:00Z", "2026-10-11T16:00:00Z")).health.code, "CHANNEL_KEY_UNMATCHED");
});

test("K2b（驱动层 304）：渠道换成了不在已加上游里的 Key，读取服务内容不变（304）——把上游加上以后，过了重对间隔下一轮就认出来、清掉事项并换段，不是一直卡在 CHANNEL_KEY_UNMATCHED", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 77: "sk-" + "Sev7".repeat(10) };
  const extraTokens = [{ tokenId: 9, name: "stable" }];
  let channelKey = keys[9];
  const f = liveReconciliationFixture(t, { segments: [{ id: "s1", group: "g1", from: 0 }], tokenKeyOf: (tokenId) => keys[tokenId], extraTokens,
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(channelKey), f: "unused" }] }] } });
  const round = async (iso) => { now = Date.parse(iso); await f.module.refreshDue(now); }; // 不清识别缓存：靠 4 分钟到期 + etag（304）
  await round("2026-10-11T01:00:00Z");
  assert.ok((await f.repository.getRule("rr_live")).canonicalKey, "锚定");
  channelKey = keys[77]; // 渠道换成了一把不在已加上游里的 Key
  await round("2026-10-11T01:10:00Z");
  assert.equal((await f.repository.getRule("rr_live")).keyIssue?.code, "CHANNEL_KEY_UNMATCHED");
  extraTokens.push({ tokenId: 77, name: "added-later" }); // 用户把这把 Key 所在的上游加上了（目录里有了）
  await round("2026-10-11T01:20:00Z"); // 读取服务内容没变（304），但距上一次对上游目录不到 15 分钟：先不重对
  assert.equal((await f.repository.getRule("rr_live")).keyIssue?.code, "CHANNEL_KEY_UNMATCHED", "间隔没到，不重读上游目录");
  await round("2026-10-11T01:30:00Z"); // 过了 15 分钟：304 也重新对一遍上游目录
  const rule = await f.repository.getRule("rr_live");
  assert.equal(rule.keyIssue, null, "认出来了，事项清掉");
  assert.equal(rule.tokenId, 77, "换段");
});

// K2c 重新分组的钱：[a, b) 这段里每把 Key 恰好算一次（总指挥 10-27）。按 Key 名字、按时间回用量（每秒 1 美元），重新分组以后把所有绑定（包括已经归档的旧绑定）
// 当天的上游成本加起来，必须等于各把 Key 当天用量之和——算两遍会多，漏了会少。a = 10-11 01:00Z（上一次读成功），渠道在 t = 10-11 20:00Z 换了 Key，b = 10-12 01:00Z 才认出来
const REGROUP_A = Date.parse("2026-10-11T01:00:00Z"), REGROUP_T = Date.parse("2026-10-11T20:00:00Z"), REGROUP_B = Date.parse("2026-10-12T01:00:00Z");
async function regroupMoneyScenario(t, policy, { rules, channelsByRule, tokens, before, after, usage, sub2 = false, expectRegroup = true, lateAfter = null }) {
  let now = REGROUP_A;
  t.mock.method(Date, "now", () => now);
  const keys = Object.fromEntries([9, 10, 11, 20, 21].map((id) => [id, "sk-" + String(id).padStart(2, "0") + "Kx9z".repeat(9)]));
  const channelToken = { ...before };
  const usageWindows = Object.fromEntries(Object.entries(usage).map(([name, [from, to]]) => [name, [from / 1000, (to ?? Infinity) / 1000]]));
  // Sub2API 上游：按 Key、按天回用量的假上游（server/test-support/fake-sub2api.js）；识别还不认 Sub2API 的 Key 目录（#142），直接塞识别结果
  const tokenIdOfName = Object.fromEntries([{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }, ...tokens].map((item) => [item.name, item.tokenId]));
  const fakeSub2 = sub2 ? createFakeSub2Api({ keys: [...new Map([{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }, ...tokens].map((item) => [item.tokenId, { id: item.tokenId, name: item.name }])).values()],
    dayUsageUsd: (keyId, day) => { const name = Object.keys(tokenIdOfName).find((key) => tokenIdOfName[key] === keyId); return usageWindows[name] ? secondsInDay([usageWindows[name][0] * 1000, usageWindows[name][1] * 1000], day) : 0; } }) : null;
  const f = liveReconciliationFixture(t, { policy, segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: rules, channelsByRule, tokenKeyOf: (tokenId) => keys[tokenId], extraTokens: tokens, sub2api: fakeSub2,
    usageOf: (name, startSec, endSec) => { const w = usageWindows[name]; return w ? 100 * Math.max(0, Math.min(endSec + 1, w[1]) - Math.max(startSec, w[0])) : 0; },
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => Object.entries(channelToken).map(([id, tokenId]) => ({ id: Number(id), baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[tokenId]), f: "unused" }] })) } });
  f.stations[0].accountUse = "only_mine";
  if (sub2) Object.assign(f.stations[0], { type: "sub2api", accessToken: "jwt" });
  const inject = () => {
    if (!sub2) { f.rt._keyAgentIdentifyCache = null; return; }
    f.rt._keyAgentIdentifyCache = { at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, revealIssues: [],
      channels: Object.entries(channelToken).map(([id, tokenId]) => ({ channelId: Number(id), keyless: false, slots: [{ index: 0, state: "identified",
        matches: [{ stationId: "upstream", tokenId, tokenName: Object.keys(tokenIdOfName).find((name) => tokenIdOfName[name] === tokenId), via: "fingerprint" }] }] })) } };
  };
  inject();
  await f.module.refreshDue(now); // 锚定
  const namespaceKey = (await f.repository.getRule("rr_live")).ownSource.namespaceKey;
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }), getSourceCatalogue: () => ({ ownSource: { namespaceKey }, stale: false,
    channels: Object.keys(channelToken).map((id) => ({ id: Number(id), name: `渠道 ${id}`, revision: `rev-${id}`, missing: false })) }) };
  Object.assign(channelToken, after);
  now = REGROUP_B; inject();
  await f.module.refreshDue(now); // 认出来、重新分组
  const archived = (await f.repository.listRules({ includeArchived: true })).filter((rule) => rule.archivedAt);
  if (expectRegroup) assert.ok(archived.length > 0, "旧绑定在 b 归档了（重新分组发生了）");
  if (lateAfter) Object.assign(channelToken, lateAfter); // b 这一轮之后读取服务认出的又变了（比如新渠道这时才用上那把旧 Key）
  for (const iso of ["2026-10-13T01:00:00Z", "2026-10-14T01:00:00Z", "2026-10-15T01:00:00Z"]) { now = Date.parse(iso); inject(); await f.module.refreshDue(now); }
  const costOn = (billDate) => {
    const latest = new Map();
    for (const row of f.state.ledger.filter((item) => item.bill_date === billDate)) if (!latest.has(row.rule_id) || Number(row.revision) > Number(latest.get(row.rule_id).revision)) latest.set(row.rule_id, row);
    return [...latest.values()].reduce((total, row) => total + Number(row.cost_usd), 0);
  };
  const truthOn = (billDate) => {
    if (sub2) return Object.values(usageWindows).reduce((total, [from, to]) => total + secondsInDay([from * 1000, to * 1000], billDate), 0);
    const startSec = Date.parse(`${billDate}T00:00:00+08:00`) / 1000, endSec = startSec + 86400;
    return Object.values(usageWindows).reduce((total, [from, to]) => total + Math.max(0, Math.min(endSec, to) - Math.max(startSec, from)), 0);
  };
  return { f, costOn, truthOn, archived };
}
// immediate（生产的绑定）三天都量；legacy-v3 的旧绑定归档以后系统不补结它 b 以前的日子（C3 只补 scoped 的，已有行为），只量新绑定（一律 immediate）的那天
const checkMoney = (scenario, policy) => { for (const day of policy === "immediate" ? ["2026-10-11", "2026-10-12", "2026-10-13"] : ["2026-10-13"]) assert.equal(scenario.costOn(day), scenario.truthOn(day), `${day}：所有绑定的上游成本加起来 = 各把 Key 当天用量之和（没有一把 Key 算两遍、也没漏）`); };

for (const policy of POLICIES) {
  test(`K2c 钱：分组到全新的 Key——[a,b) 里换走的新 Key 放进旧绑定的过渡段恰好一次，所有绑定当天上游成本之和 = 各 Key 用量之和 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { rules: [], channelsByRule: { rr_live: [1, 2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "k20" }],
      before: { 1: 9, 2: 9 }, after: { 1: 9, 2: 20 }, usage: { stable: [0, null], k20: [REGROUP_T, null] } });
    checkMoney(s, policy);
  });

  test(`K2c 钱：分组到另一组正在用的 Key——那把 Key 由原来握着它的绑定算，换走的绑定的过渡段不放它（不算两遍）[${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { rules: ["rr_b"], channelsByRule: { rr_live: [1, 2], rr_b: [3] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }],
      before: { 1: 9, 2: 9, 3: 10 }, after: { 1: 9, 2: 10, 3: 10 }, usage: { stable: [0, null], "stable-rr_b": [0, null] } });
    assert.equal(s.archived.length, 2, "牵连的两条绑定都在 b 归档（唯一约束：要建新绑定得先让握着那把 Key 的归档）");
    checkMoney(s, policy);
  });

  test(`K2c 钱：合组到其中一条原来的 Key——不开过渡段，另一条原来的 Key 到 b 为止由它自己算 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }],
      before: { 1: 9, 2: 10 }, after: { 1: 9, 2: 9 }, usage: { stable: [0, null], "stable-rr_b": [0, REGROUP_T] } });
    for (const rule of s.archived) assert.equal((await s.f.repository.listSegments(rule.id)).length, 1, "没有过渡段");
    checkMoney(s, policy);
  });

  test(`K2c 钱：合组到全新的 Key（两个渠道在 [a,b) 里不同时刻换过去）——新 Key 在 [t,b) 的用量放进恰好一条旧绑定的过渡段，不漏、不算两遍 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }, { tokenId: 20, name: "k20" }],
      before: { 1: 9, 2: 10 }, after: { 1: 20, 2: 20 }, usage: { stable: [0, REGROUP_T], "stable-rr_b": [0, REGROUP_T + 3600000], k20: [REGROUP_T, null] } });
    const withWindow = (await Promise.all(s.archived.map(async (rule) => (await s.f.repository.listSegments(rule.id)).filter((segment) => segment.timingSource === "key_change_window").length))).reduce((a, b) => a + b, 0);
    assert.equal(withWindow, 1, "全新的 Key 只放进一条旧绑定的过渡段");
    checkMoney(s, policy);
  });
}

// Sub2API 上游（用户在用）：按天读账单，切不开中途。K2b 换 Key 当天整窗各把 Key 取全天再相加；K2c-2 分组、合组那天旧绑定整天不算、新绑定整天算
// 只跑 immediate：生产的绑定都是 immediate；legacy-v3 的按段取在 Sub2API 整天读下不是支持的组合
for (const policy of ["immediate"]) {
  test(`K2b + Sub2API：同一条绑定换 Key——换 Key 那天整窗各把 Key 取全天再相加，所有行当天上游成本之和 = 各 Key 当天用量之和 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { sub2: true, expectRegroup: false, rules: [], channelsByRule: { rr_live: [1] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "k20" }],
      before: { 1: 9 }, after: { 1: 20 }, usage: { stable: [0, REGROUP_T], k20: [REGROUP_T, null] } });
    assert.equal((await s.f.repository.getRule("rr_live")).tokenId, 20, "换了 Key");
    assert.equal(s.f.state.ledger.filter((row) => row.bill_date === "2026-10-12").length > 0, true, "b 当天结出了账");
    checkMoney(s, policy);
  });

  test(`K2c-2 + Sub2API：分组到全新的 Key——旧绑定归档当天整天不算、新绑定整天算，窗口里每把 Key 每天只取一次，所有行当天上游成本之和 = 各 Key 当天用量之和 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { sub2: true, rules: [], channelsByRule: { rr_live: [1, 2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "k20" }],
      before: { 1: 9, 2: 9 }, after: { 1: 9, 2: 20 }, usage: { stable: [0, null], k20: [REGROUP_T, null] } });
    checkMoney(s, policy);
  });

  test(`K2c-2 + Sub2API：分组到别组正在用的 Key——那把 Key 由原来握着它的绑定算，两条都在 b 归档、新组整天算 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { sub2: true, rules: ["rr_b"], channelsByRule: { rr_live: [1, 2], rr_b: [3] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }],
      before: { 1: 9, 2: 9, 3: 10 }, after: { 1: 9, 2: 10, 3: 10 }, usage: { stable: [0, null], "stable-rr_b": [0, null] } });
    assert.equal(s.archived.length, 2);
    checkMoney(s, policy);
  });

  test(`K2c-2 + Sub2API：合组到其中一条原来的 Key [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { sub2: true, rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }],
      before: { 1: 9, 2: 10 }, after: { 1: 9, 2: 9 }, usage: { stable: [0, null], "stable-rr_b": [0, REGROUP_T] } });
    checkMoney(s, policy);
  });

  test(`K2c-2 + Sub2API：合组到全新的 Key（两个渠道在 [a,b) 里不同时刻换过去）——新 Key 放进恰好一条旧绑定的窗口，每天只取一次 [${policy}]`, async (t) => {
    const s = await regroupMoneyScenario(t, policy, { sub2: true, rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }, { tokenId: 20, name: "k20" }],
      before: { 1: 9, 2: 10 }, after: { 1: 20, 2: 20 }, usage: { stable: [0, REGROUP_T], "stable-rr_b": [0, REGROUP_T + 3600000], k20: [REGROUP_T, null] } });
    checkMoney(s, policy);
  });
}

// 挪过的那天（Sub2API 一把 Key 在两条绑定之间换）：切不开整天，记会自己好的 PENDING，这两条绑定从 b 起不结账；b 以前的日子照常结，总和 = 用量
test("K2b + Sub2API：两条绑定互换 Key（挪过）——b 当天及以后这两条都不入账（PENDING），b 以前那天照常结账、上游成本之和 = 各 Key 当天用量之和", async (t) => {
  const s = await regroupMoneyScenario(t, "immediate", { sub2: true, expectRegroup: false, rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }],
    before: { 1: 9, 2: 10 }, after: { 1: 10, 2: 9 }, usage: { stable: [0, null], "stable-rr_b": [0, null] } });
  assert.deepEqual([(await s.f.repository.getRule("rr_live")).tokenId, (await s.f.repository.getRule("rr_b")).tokenId], [9, 10], "没动绑定");
  for (const ruleId of ["rr_live", "rr_b"]) {
    assert.equal((await s.f.repository.getRule(ruleId)).keyIssue?.code, "PENDING");
    assert.deepEqual(s.f.state.ledger.filter((row) => row.rule_id === ruleId && row.bill_date >= "2026-10-12"), [], "b 当天及以后不入账");
  }
  assert.equal(s.costOn("2026-10-11"), s.truthOn("2026-10-11"), "b 以前那天照常结账");
});

// 临时的挡（逐条拆分合了以后去掉）：Sub2API 换掉的旧 Key 后来被别的渠道用着，整天读会把那个渠道的用量算进这条绑定——换 Key 那天不结账，只挡这一天。
// 钱：A 换 Key 那天（10-12）没有行；前一天 = 旧 Key 整天用量，以后的天 = 新 Key 整天用量（别的渠道用的旧 Key 不算进 A）
const sub2MoveUsage = { stable: [0, null], k20: [REGROUP_T, null] };
const SUB2_MOVE_TOKENS = [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "k20" }, { tokenId: 11, name: "k11" }];
// blocked：不入账的日子。换 Key 那一轮认出的，从过渡段起点（a，上一次确认旧 Key 的那一刻）所在的日子挡到 b 那天——新渠道最早可能从 a 以后任何时刻起用旧 Key，
// 切不开这几天；结账时才认出的，只挡结账时过渡段还碰到的日子
const expectSub2MoveDayBlocked = async (s, blocked = ["2026-10-11", "2026-10-12"]) => {
  for (const day of blocked) assert.deepEqual(s.f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === day), [], `${day} 不入账`);
  if (!blocked.includes("2026-10-11")) assert.equal(s.costOn("2026-10-11"), 86400, "前一天照常：旧 Key 整天");
  assert.equal(s.costOn("2026-10-13"), 86400, "以后的天只有新 Key 整天，别的渠道用的旧 Key 不算进来");
  assert.equal(s.costOn("2026-10-14"), 86400);
};
test("K2b + Sub2API 旧 Key 换掉以后被别的渠道用着（1）：那个渠道在算、旧 Key 是从这条绑定挪过去的——整对不结账（原有的挡）", async (t) => {
  const s = await regroupMoneyScenario(t, "immediate", { sub2: true, expectRegroup: false, rules: ["rr_b"], channelsByRule: { rr_live: [1], rr_b: [2] }, tokens: SUB2_MOVE_TOKENS,
    before: { 1: 9, 2: 10 }, after: { 1: 20, 2: 9 }, usage: { stable: [0, null], k20: [REGROUP_T, null], "stable-rr_b": [0, REGROUP_T] } });
  assert.deepEqual(s.f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date >= "2026-10-12"), [], "换 Key 当天及以后都不入账");
  assert.equal(s.costOn("2026-10-11"), 172800, "前一天：A 的旧 Key 整天 + B 的旧 Key 整天");
});

test("K2b + Sub2API 旧 Key 换掉以后被别的渠道用着（2）：那个渠道没在算、读取服务认出来了——换 Key 那天不结账，别的天照常", async (t) => {
  const s = await regroupMoneyScenario(t, "immediate", { sub2: true, expectRegroup: false, rules: [], channelsByRule: { rr_live: [1] }, tokens: SUB2_MOVE_TOKENS,
    before: { 1: 9, 2: 11 }, after: { 1: 20, 2: 9 }, usage: sub2MoveUsage });
  assert.equal((await s.f.repository.getRule("rr_live")).tokenId, 20, "A 照常换了 Key（段是对的）");
  assert.equal((await s.f.repository.getRule("rr_live")).keyIssue, null, "不是需处理，是只挡这一天");
  await expectSub2MoveDayBlocked(s);
});

test("K2b + Sub2API 旧 Key 换掉以后被别的渠道用着（3）：换 Key 那一轮还没认出，到结账时才认出——结账那一刻再查一遍，那天不结账", async (t) => {
  const s = await regroupMoneyScenario(t, "immediate", { sub2: true, expectRegroup: false, rules: [], channelsByRule: { rr_live: [1] }, tokens: SUB2_MOVE_TOKENS,
    before: { 1: 9 }, after: { 1: 20 }, lateAfter: { 2: 9 }, usage: sub2MoveUsage });
  await expectSub2MoveDayBlocked(s, ["2026-10-12"]);
});

test("K2b + Sub2API 旧 Key 换掉以后被别的渠道用着（4）：换 Key 那一轮认出了、结账时那个渠道又换走了——换 Key 那一轮记下的那天仍然不结账", async (t) => {
  const s = await regroupMoneyScenario(t, "immediate", { sub2: true, expectRegroup: false, rules: [], channelsByRule: { rr_live: [1] }, tokens: SUB2_MOVE_TOKENS,
    before: { 1: 9, 2: 11 }, after: { 1: 20, 2: 9 }, lateAfter: { 2: 11 }, usage: sub2MoveUsage });
  await expectSub2MoveDayBlocked(s);
});

test("K2b + Sub2API 旧 Key 没有被别的渠道用着：换 Key 那天照常结账（不误挡）", async (t) => {
  const s = await regroupMoneyScenario(t, "immediate", { sub2: true, expectRegroup: false, rules: [], channelsByRule: { rr_live: [1] }, tokens: SUB2_MOVE_TOKENS,
    before: { 1: 9 }, after: { 1: 20 }, usage: sub2MoveUsage });
  assert.equal(s.costOn("2026-10-12"), s.truthOn("2026-10-12"), "10-12：旧 Key 到 b 为止 + 新 Key 之后，没人挡");
});

// Sub2API 上游（用户在用）：按天读账单，切不开中途。换 Key 那天整窗各把 Key 取全天再相加。
// 识别还不认 Sub2API 的 Key 目录（#142 另合），这里直接塞识别结果。所有行（这条绑定每一天）上游成本之和 = 各 Key 当天用量之和
test("K2b + Sub2API：同一条绑定换 Key——换 Key 那天整窗各把 Key 取全天再相加，每天上游成本 = 各 Key 当天用量之和（以前整窗只取最新那把，旧 Key 的用量漏了）", async (t) => {
  const A = Date.parse("2026-10-11T01:00:00Z"), SWITCH = Date.parse("2026-10-11T20:00:00Z"), B = Date.parse("2026-10-12T01:00:00Z");
  let now = A;
  t.mock.method(Date, "now", () => now);
  const windows = { 9: [0, SWITCH], 20: [SWITCH, null] }; // 旧 Key 用到 SWITCH，新 Key 从 SWITCH 起（每秒 1 美元）
  const fake = createFakeSub2Api({ keys: [{ id: 9, name: "stable" }, { id: 20, name: "k20" }], dayUsageUsd: (keyId, day) => secondsInDay(windows[keyId], day), now: () => Date.now() });
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], sub2api: fake,
    usageOf: () => 0, tokenKeyOf: () => "sk-unused", extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "k20" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [] } });
  Object.assign(f.stations[0], { type: "sub2api", accessToken: "jwt" });
  const channelToken = { 1: 9 };
  const inject = () => { f.rt._keyAgentIdentifyCache = { at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, revealIssues: [],
    channels: Object.entries(channelToken).map(([id, tokenId]) => ({ channelId: Number(id), keyless: false, slots: [{ index: 0, state: "identified",
      matches: [{ stationId: "upstream", tokenId, tokenName: tokenId === 9 ? "stable" : "k20", via: "fingerprint" }] }] })) } }; };
  inject();
  await f.module.refreshDue(now);
  channelToken[1] = 20; now = B; inject();
  await f.module.refreshDue(now); // 认出换了 Key：[a, b) 过渡段两把 Key 都放着
  assert.equal((await f.repository.getRule("rr_live")).tokenId, 20);
  for (const iso of ["2026-10-13T01:00:00Z", "2026-10-14T01:00:00Z"]) { now = Date.parse(iso); inject(); await f.module.refreshDue(now); }
  const cost = (day) => f.state.ledger.filter((row) => row.rule_id === "rr_live" && row.bill_date === day).reduce((total, row) => total + Number(row.cost_usd), 0);
  const truth = (day) => Object.values(windows).reduce((total, window) => total + secondsInDay(window, day), 0);
  for (const day of ["2026-10-11", "2026-10-12", "2026-10-13"]) assert.equal(cost(day), truth(day), `${day}：各 Key 当天用量之和`);
});

// K2c 自动开始：上游答了「只给我的渠道用」，读取服务认出一个新渠道（渠道 2）用了它的 Key（K20），轮询的这一轮就自动开始——和用户点「开始算利润」一样，从今天 0 点起算
// （点以前今天已经产生的用量也算进来）。接入向导用桩（真接入向导的预览+确认在 channel-onboarding.test.js 的端到端里测过），这里量钱：
// 每天所有行的上游成本之和 = 各 Key 当天用量之和——自动开始以前的日子 K20 没人算（渠道还没开始），开始那天起整天算
async function autoStartScenario(t, { sub2, optout = false, removeUpstreamFirst = false, move = false }) {
  let now = REGROUP_A;
  t.mock.method(Date, "now", () => now);
  const keys = Object.fromEntries([9, 20].map((id) => [id, "sk-" + String(id).padStart(2, "0") + "Kx9z".repeat(9)]));
  const names = { 9: "stable", 20: "k20" };
  const windows = { stable: [0, null], k20: move ? [REGROUP_T, null] : [0, null] };
  const channelToken = { 1: 9 };
  const fake = sub2 ? createFakeSub2Api({ keys: [{ id: 9, name: "stable" }, { id: 20, name: "k20" }], dayUsageUsd: (keyId, day) => secondsInDay(windows[names[keyId]], day) }) : null;
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], channelsByRule: { rr_live: [1] }, tokenKeyOf: (id) => keys[id], extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 20, name: "k20" }], sub2api: fake,
    usageOf: (name, startSec, endSec) => { const w = windows[name]; return w ? 100 * Math.max(0, endSec + 1 - Math.max(startSec, 0)) : 0; },
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => Object.entries(channelToken).map(([id, tokenId]) => ({ id: Number(id), baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[tokenId]), f: "unused" }] })) } });
  f.stations[0].accountUse = "only_mine";
  if (sub2) Object.assign(f.stations[0], { type: "sub2api", accessToken: "jwt" });
  const inject = () => {
    if (!sub2) { f.rt._keyAgentIdentifyCache = null; return; }
    f.rt._keyAgentIdentifyCache = { at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, revealIssues: [],
      channels: Object.entries(channelToken).map(([id, tokenId]) => ({ channelId: Number(id), keyless: false, slots: [{ index: 0, state: "identified", matches: [{ stationId: "upstream", tokenId, tokenName: names[tokenId], via: "fingerprint" }] }] })) } };
  };
  inject();
  await f.module.refreshDue(now);
  const anchored = await f.repository.getRule("rr_live");
  f.rt.reconciliation = f.module;
  const created = [];
  // Sub2API：识别还不认 Sub2API 的 Key 目录（#142 另合），自动开始用的识别也直接给注入的结果（fresh 也一样）
  if (sub2) f.rt.channelProfit = createChannelProfitModule(f.rt, { identify: async () => f.rt._keyAgentIdentifyCache.result });
  f.rt.channelOnboarding = {
    getSourceCatalogue: () => ({ ownSource: { namespaceKey: anchored.ownSource.namespaceKey }, stale: false, channels: [1, 2].map((id) => ({ id, name: `渠道 ${id}`, revision: `rev-${id}`, missing: false })) }),
    inspectSource: () => ({ version: "r1", status: "confirmed" }),
    probeBatch: async (input) => ({ previewId: "preview", groups: input.groups.map((group) => ({ groupId: group.groupId, status: "ready" })) }),
    connectBatch: async (input) => ({ complete: true, groups: await Promise.all(input.groups.map(async (group) => {
      const station = f.stations[0], tokenId = group.reconciliation.tokenId;
      const rule = await f.repository.createRule({ upstreamStationId: station.id, ownStationId: "own", tokenId, tokenName: names[tokenId], fixedGroup: sub2 ? "" : "g1", timezone: "Asia/Shanghai", enabled: true,
        provider: sub2 ? "sub2api" : "newapi", canonicalKey: canonicalBillingKey(station, { platform: sub2 ? "sub2api" : "newapi", accountId: sub2 ? "42" : "7" }, tokenId), billingPolicy: "immediate", ownSource: anchored.ownSource,
        costCoverage: "complete", coverageDeclaration: group.reconciliation.coverageDeclaration, sourceBinding: Object.fromEntries(group.channels.map((channel) => [channel.channelId, channel.channelRevision])),
        initialRatio: sub2 ? null : 1, channels: group.channels.map((channel) => ({ channelId: channel.channelId, name: `渠道 ${channel.channelId}` })) });
      created.push(rule.id);
      return { groupId: group.groupId, requestedGroupIds: [group.groupId], reconciliation: { status: "configured", ruleId: rule.id } };
    })) }),
  };
  if (optout) await f.repository.addChannelOptouts("own", [2], now);
  if (removeUpstreamFirst) await f.module.stopUpstreamChannels("upstream"); // 用户删了这个上游，又把它加回来（上游站点记录没动，只看绑定和 optout）
  // 渠道 2 在 b 这一轮才出现（用着 K20）
  // move：渠道 1 换成新 Key K20，旧 Key K9 同一轮被渠道 2 用上（Sub2API 当天挪 Key 给新渠道，新渠道被自动开始）
  if (move) channelToken[1] = 20;
  channelToken[2] = move ? 9 : 20; now = REGROUP_B; inject();
  await f.module.refreshDue(now);
  for (const iso of ["2026-10-13T01:00:00Z", "2026-10-14T01:00:00Z", "2026-10-15T01:00:00Z"]) { now = Date.parse(iso); inject(); await f.module.refreshDue(now); }
  const costOn = (billDate) => {
    const latest = new Map();
    for (const row of f.state.ledger.filter((item) => item.bill_date === billDate)) if (!latest.has(row.rule_id) || Number(row.revision) > Number(latest.get(row.rule_id).revision)) latest.set(row.rule_id, row);
    return [...latest.values()].reduce((total, row) => total + Number(row.cost_usd), 0);
  };
  const daySeconds = (name, billDate) => secondsInDay([windows[name][0], windows[name][1]], billDate);
  const truthOn = (billDate) => daySeconds("stable", billDate) + (billDate >= "2026-10-12" ? daySeconds("k20", billDate) : 0);
  return { f, created, costOn, truthOn };
}

// 决定 C：Sub2API 当天把 Key 挪给新渠道、新渠道被自动开始——换 Key 的那条绑定换 Key 那几天不结账，新渠道从第二天 0 点起整天算
test("K2c 自动开始（Sub2API）：当天旧 Key 挪给新渠道 B——A 换 Key 的那几天不结账、B 当天不算，B 从第二天 0 点起整天算，之后每天所有行成本之和 = 各 Key 当天用量之和", async (t) => {
  const s = await autoStartScenario(t, { sub2: true, move: true });
  assert.equal(s.created.length, 1, "B 自动开始了");
  const rule = await s.f.repository.getRule(s.created[0]);
  assert.deepEqual([rule.startSource, rule.channels.map((channel) => channel.channelId), rule.tokenId], ["auto", [2], 9]);
  const ledgerOf = (ruleId, day) => s.f.state.ledger.filter((row) => row.rule_id === ruleId && row.bill_date === day);
  for (const day of ["2026-10-11", "2026-10-12"]) assert.deepEqual(ledgerOf("rr_live", day), [], `A ${day}：换 Key 的几天不入账`);
  assert.deepEqual(ledgerOf(s.created[0], "2026-10-12"), [], "B 当天不算");
  for (const day of ["2026-10-13", "2026-10-14"]) assert.equal(s.costOn(day), 2 * 86400, `${day}：A 的新 Key 整天 + B 的旧 Key 整天`);
});

for (const sub2 of [false, true]) {
  test(`K2c 自动开始（${sub2 ? "Sub2API" : "New API"} 上游）：新渠道自动开始，来源记 auto，从开始那天 0 点起整天算；每天所有行的上游成本之和 = 各 Key 当天用量之和`, async (t) => {
    const s = await autoStartScenario(t, { sub2 });
    assert.equal(s.created.length, 1, "自动开始建了一条绑定");
    const rule = await s.f.repository.getRule(s.created[0]);
    assert.deepEqual([rule.startSource, rule.channels.map((channel) => channel.channelId), rule.coverageDeclaration.answer], ["auto", [2], "none"]);
    for (const day of ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]) assert.equal(s.costOn(day), s.truthOn(day), `${day}`);
  });
}

test("K2c 自动开始：用户停过的渠道不自动开始（只有用户点「开始算利润」才开始）；停过的渠道不被轮询再建出来", async (t) => {
  const s = await autoStartScenario(t, { sub2: false, optout: true });
  assert.deepEqual(s.created, [], "停过的渠道没有自动建");
});

test("K2c 删上游停渠道：stopUpstreamChannels 把这个上游下在算的绑定整条归档（来源 upstream_removed，不进 optout），别的上游下的不动；返回停了几条绑定、几个渠道；再调一次什么也不停", async (t) => {
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_b", "rr_c"], channelsByRule: { rr_live: [1, 2], rr_b: [3], rr_c: [4] } });
  f.repository.tables.rules.find((row) => row.id === "rr_c").upstream_station_id = "other-upstream";
  assert.deepEqual(await f.module.countUpstreamChannels("upstream"), { ruleCount: 2, channelCount: 3 }, "确认框数的是渠道数");
  assert.deepEqual(await f.module.stopUpstreamChannels("upstream"), { ruleCount: 2, channelCount: 3 });
  const archived = (await f.repository.listRules({ includeArchived: true })).filter((rule) => rule.archivedAt).map((rule) => rule.id).sort();
  assert.deepEqual(archived, ["rr_b", "rr_live"]);
  assert.deepEqual(await f.repository.listChannelOptouts("own"), [], "删上游不是在说「这几个渠道别算」：不记成用户停的（optout 表里没有它们）");
  assert.deepEqual((await f.repository.listRules({ includeArchived: true })).filter((rule) => rule.archivedAt).map((rule) => rule.stopReason), ["upstream_removed", "upstream_removed"], "停的来源单独记一种");
  assert.equal((await f.repository.getRule("rr_c")).enabled, true, "别的上游下的不动");
  assert.deepEqual(await f.module.stopUpstreamChannels("upstream"), { ruleCount: 0, channelCount: 0 }, "幂等");
});

test("K2c 删上游以后把上游加回来（只给我的渠道用）：停下的渠道不在 optout 里，下一轮自动开始；用户自己点「停止算利润」的照旧不会自动开始", async (t) => {
  const s = await autoStartScenario(t, { sub2: false, removeUpstreamFirst: true });
  assert.deepEqual(await s.f.repository.listChannelOptouts("own"), [], "删上游没有记用户停的");
  const rules = (await s.f.repository.listRules({ includeArchived: true }));
  assert.equal(rules.find((rule) => rule.id === "rr_live").stopReason, "upstream_removed");
  assert.equal(s.created.length, 2, "渠道 1（原来在算、被删上游停掉的）和渠道 2（新出现的）都自动开始了");
  const started = await Promise.all(s.created.map((id) => s.f.repository.getRule(id)));
  assert.deepEqual(started.map((rule) => [rule.startSource, rule.channels.map((channel) => channel.channelId)]).sort((x, y) => x[1][0] - y[1][0]), [["auto", [1]], ["auto", [2]]]);
  // 钱：自动开始那天起（10-12 0 点）每天所有行的成本之和 = 各 Key 当天用量之和（停下的那一天、开始以前的空档没人算，不在这里量）
  for (const day of ["2026-10-12", "2026-10-13", "2026-10-14"]) assert.equal(s.costOn(day), s.truthOn(day), `${day}：上游加回来以后每天都算全`);
});

// ---- 换 Key 的钱：每把 Key 恰好算一次 ----
// 每把 Key 的用量按 Key 名字、按时间段设定（每秒 1 美元，quota_per_unit 100）；每天所有绑定（含已归档的）账本行的上游成本之和 = 各把 Key 当天用量之和
const usageWindowsOf = (windows) => (name, startSec, endSec) => { const w = windows[name]; return w ? 100 * Math.max(0, Math.min(endSec + 1, w[1]) - Math.max(startSec, w[0])) : 0; };
const secOf = (iso) => Date.parse(iso) / 1000;
const latestLedgerCostOn = (f, billDate) => {
  const latest = new Map();
  for (const row of f.state.ledger.filter((item) => item.bill_date === billDate)) if (!latest.has(row.rule_id) || Number(row.revision) > Number(latest.get(row.rule_id).revision)) latest.set(row.rule_id, row);
  return [...latest.values()].reduce((total, row) => total + Number(row.cost_usd), 0);
};

test("K2b 钱：站点里有一条永远处理不完的绑定（几把 Key 的渠道），a 一直冻着——一把 Key 跨两轮从 A 挪给 B，也只算一次（B 的窗口里这把 Key 从 A 的段结束起算）", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 10: "sk-" + "TenT".repeat(10), 11: "sk-" + "Elev".repeat(10), 12: "sk-" + "Twel".repeat(10) };
  const held = { 1: 9, 2: 10 }; // 渠道 1（A）、渠道 2（B）现在用的 Key；渠道 3 是几把 Key 的渠道（C）
  const t1 = secOf("2026-10-11T04:00:00Z"), t2 = secOf("2026-10-11T08:00:00Z"); // A 换成 K12、B 换成 K9 的真正时刻
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], extraRuleIds: ["rr_b", "rr_c"], channelsByRule: { rr_live: [1], rr_b: [2], rr_c: [3] },
    tokenKeyOf: (id) => keys[id], extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "stable-rr_b" }, { tokenId: 12, name: "oai-12" }],
    usageOf: usageWindowsOf({ stable: [0, Infinity], "stable-rr_b": [0, t2], "stable-rr_c": [0, Infinity], "oai-12": [t1, Infinity] }),
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [
      { id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[held[1]]), f: "unused" }] }, { id: 2, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[held[2]]), f: "unused" }] },
      { id: 3, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[11]), f: "unused" }, { i: 1, m: maskKey("sk-" + "Othr".repeat(10)), f: "unused" }] }] } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const round = async (iso) => { now = Date.parse(iso); f.rt._keyAgentIdentifyCache = null; await f.module.refreshDue(now); };
  await round("2026-10-11T01:00:00Z"); // 锚定
  held[1] = 12; await round("2026-10-11T05:00:00Z"); // 第 1 轮：A 换走 K9
  held[2] = 9; await round("2026-10-11T09:00:00Z"); // 第 2 轮：B 接 K9（C 一直没处理完，站点的成功时刻一直冻着）
  await round("2026-10-11T17:00:00Z"); // 10-11（上海）结束，结账
  const day = Date.parse("2026-10-10T16:00:00Z") / 1000;
  const truth = 86400 /* K9 */ + (t2 - day) /* K10，B 换走以前 */ + 86400 /* K11 */ + (day + 86400 - t1) /* K12，A 换上以后 */;
  assert.equal(latestLedgerCostOn(f, "2026-10-11"), truth, "A、B、C 三条绑定当天上游成本之和 = 各把 Key 当天用量之和（K9 不重复）");
  const windows = (await f.repository.listSegments("rr_b")).filter((segment) => segment.timingSource === "key_change_window");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].effectiveFrom >= Date.parse("2026-10-11T05:00:00Z") || windows[0].effectiveFrom === 0, true, "B 的窗口不早于 A 放开 K9 的那一刻（或者 B 的新 Key 那一段从那一刻起）");
});

test("K2b 钱：读取服务自己缓存最多 4 分钟——换 Key 的 a 用快照自己读库的时刻，b 用新一份快照读库的时刻，[真正换 Key, 控制台拿到快照) 那几分钟的新 Key 用量不漏", async (t) => {
  let now = Date.parse("2026-10-11T11:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 10: "sk-" + "TenT".repeat(10) };
  const agent = { secret: KEY_AGENT_SECRET, held: 9, readLagMs: 0, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[agent.held]), f: "unused" }] }] };
  const tSwitch = secOf("2026-10-11T11:58:00Z"); // 真正换 Key 的时刻
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], tokenKeyOf: (id) => keys[id], extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }],
    usageOf: usageWindowsOf({ stable: [0, tSwitch], "oai-2": [tSwitch, Infinity] }), keyAgent: agent });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const round = async (iso) => { now = Date.parse(iso); f.rt._keyAgentIdentifyCache = null; await f.module.refreshDue(now); };
  await round("2026-10-11T11:00:00Z");
  agent.readLagMs = 4 * 60 * 1000; await round("2026-10-11T12:00:00Z"); // 控制台 12:00 拿到的快照，读取服务 11:56 读的库（旧 Key，换 Key 在 11:58）
  agent.held = 10; agent.readLagMs = 0; await round("2026-10-11T12:05:00Z"); // 12:05 的快照已经是新 Key
  await round("2026-10-11T17:00:00Z");
  assert.equal(latestLedgerCostOn(f, "2026-10-11"), 86400, "整天每秒 1 美元（旧 Key 到 11:58，新 Key 从 11:58 起），一秒不漏");
  const window = (await f.repository.listSegments("rr_live")).find((segment) => segment.timingSource === "key_change_window");
  assert.deepEqual([window.effectiveFrom, window.effectiveTo], [Date.parse("2026-10-11T11:56:00Z"), Date.parse("2026-10-11T12:05:00Z")], "a = 最后一份还是旧 Key 的快照读库的时刻，b = 第一份是新 Key 的快照读库的时刻");
});

test("K2b：一条绑定两个渠道，一个认出换了 Key、另一个这一轮认不出——整条绑定这一轮不换；分组冲突中渠道变认不出，冲突记号不清、冲突期间的日子不固定", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 10: "sk-" + "TenT".repeat(10) };
  const state = { ch1: 9, ch2: 9, ch2Missing: false };
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], channelsByRule: { rr_live: [1, 2] }, tokenKeyOf: (id) => keys[id], extraTokens: [{ tokenId: 10, name: "oai-2" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[state.ch1]), f: "unused" }] },
      ...(state.ch2Missing ? [] : [{ id: 2, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[state.ch2]), f: "unused" }] }])] } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  const round = async (iso) => { now = Date.parse(iso); f.rt._keyAgentIdentifyCache = null; await f.module.refreshDue(now); };
  await round("2026-10-11T01:00:00Z"); // 锚定
  state.ch1 = 10; state.ch2Missing = true; await round("2026-10-11T05:00:00Z"); // 渠道 1 认出换成 K10，渠道 2 这一轮认不出
  let rule = await f.repository.getRule("rr_live");
  assert.deepEqual([rule.tokenId, (await f.repository.listSegments("rr_live")).length, rule.keyIssue], [9, 1, null], "不拿认出来的那个渠道当整条绑定换了 Key（渠道 2 的 Key 用量以后没人算），这一轮不换");
  state.ch2Missing = false; state.ch2 = 9; await round("2026-10-11T06:00:00Z"); // 渠道 2 认出来了、还是 K9：渠道 1 换了、渠道 2 没换，分组冲突
  rule = await f.repository.getRule("rr_live");
  assert.deepEqual([rule.keyIssue.code, rule.keyIssue.sinceMs], ["KEY_GROUP_CHANGED", Date.parse("2026-10-11T06:00:00Z")]);
  state.ch2Missing = true; await round("2026-10-11T07:00:00Z"); // 冲突中渠道 2 变认不出：不是「冲突解开」，记号不清
  rule = await f.repository.getRule("rr_live");
  assert.deepEqual([rule.keyIssue?.code, rule.keyIssue?.sinceMs], ["KEY_GROUP_CHANGED", Date.parse("2026-10-11T06:00:00Z")], "记号沿用，不清");
  await round("2026-10-11T17:00:00Z"); // 10-11 结束
  assert.deepEqual(f.state.ledger.filter((row) => row.bill_date === "2026-10-11"), [], "冲突期间的 10-11 不固定");
});

test("K2b：渠道换成了别的上游站点的 Key——不悄悄照旧结账，记事项 KEY_GROUP_CHANGED，从认出来的那一刻起先不算", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const key = "sk-" + "Nine".repeat(10);
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], tokenKeyOf: () => key,
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(key), f: "unused" }] }] } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  await f.module.refreshDue(now); // 锚定
  now = Date.parse("2026-10-11T05:00:00Z");
  // 识别认出这个渠道现在用的是另一个上游站点的 Key（识别结果直接注入，这个夹具只有一个上游）
  f.rt._keyAgentIdentifyCache = { at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, readAtMs: now, confirmedAtMs: now, revealIssues: [],
    channels: [{ channelId: 1, keyless: false, slots: [{ index: 0, state: "identified", matches: [{ stationId: "another-upstream", tokenId: 30, tokenName: "other", via: "fingerprint" }] }] }] } };
  await f.module.refreshDue(now);
  const rule = await f.repository.getRule("rr_live");
  assert.deepEqual([rule.tokenId, rule.keyIssue?.code, rule.keyIssue?.sinceMs], [9, "KEY_GROUP_CHANGED", now], "没有悄悄不处理");
  now = Date.parse("2026-10-11T17:00:00Z"); f.rt._keyAgentIdentifyCache = null;
  f.rt._keyAgentIdentifyCache = { at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, readAtMs: now, confirmedAtMs: now, revealIssues: [],
    channels: [{ channelId: 1, keyless: false, slots: [{ index: 0, state: "identified", matches: [{ stationId: "another-upstream", tokenId: 30, tokenName: "other", via: "fingerprint" }] }] }] } };
  await f.module.refreshDue(now);
  assert.deepEqual(f.state.ledger.filter((row) => row.bill_date === "2026-10-11"), [], "认出来以后的 10-11 不固定");
});

test("K2b：没锚定过的绑定（还没开始算）识别到不一样的 Key 不换段", async (t) => {
  let now = Date.parse("2026-10-11T01:00:00Z");
  t.mock.method(Date, "now", () => now);
  const keys = { 9: "sk-" + "Nine".repeat(10), 10: "sk-" + "TenT".repeat(10) };
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], tokenKeyOf: (id) => keys[id], extraTokens: [{ tokenId: 9, name: "stable" }, { tokenId: 10, name: "oai-2" }],
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: "https://upstream.test", keys: [{ i: 0, m: maskKey(keys[10]), f: "unused" }] }] } });
  f.rt.onboardingSource = { inspectSource: () => ({ version: "r1", status: "confirmed" }) };
  assert.equal((await f.repository.getRule("rr_live")).canonicalKey, null, "夹具里的绑定还没锚定");
  await f.module.refreshDue(now); // 第一轮：渠道已经是 K10，但这条绑定还没锚定（这一轮才锚定）：不换段
  assert.equal((await f.repository.listSegments("rr_live")).length, 1, "没锚定过的绑定不换段");
});

// K2c-3b 换到另一个上游的 Key：渠道 1 原来用旧上游的 K9，在 t 换成新上游的 Key（a < t < b）。旧绑定的 [a,b) 过渡段放旧 Key + 新上游的新 Key（跨上游读），
// b 归档；新上游答了「只给我的渠道用」，重新分组里直接在新上游下建的那条从 b 起算，不和过渡段重叠。每天所有行（含已归档的）的上游成本之和 = 各 Key 当天用量之和。
// 旧上游是 Sub2API（只能整天读，归档那天整天不算）：新绑定从 b 那天 0 点整天算，第一段带着旧 Key（整天读）
async function crossUpstreamScenario(t, { from = "newapi", to, rates = null, targetAccountUse = "only_mine" }) {
  let now = REGROUP_A;
  t.mock.method(Date, "now", () => now);
  const oldSub2 = from === "sub2api", sub2 = to === "sub2api", injectIdentity = oldSub2 || sub2;
  const keys = { 9: "sk-09" + "Kx9z".repeat(9), 30: "sk-30" + "Kx9z".repeat(9) };
  const windows = { stable: [0, REGROUP_T], newkey: [REGROUP_T, null] }; // 每秒 1 美元
  const secs = (name, startSec, endSec) => { const [from, to] = [windows[name][0] / 1000, (windows[name][1] ?? Infinity) / 1000]; return Math.max(0, Math.min(endSec + 1, to) - Math.max(startSec, from)); };
  const newName = "newkey", newId = sub2 ? 40 : 30;
  const second = sub2
    ? createFakeSub2Api({ keys: [{ id: 40, name: newName }], dayUsageUsd: (_id, day) => secondsInDay(windows[newName], day) })
    : createFakeNewApi({ keys: [{ id: 30, name: newName, masked: maskKey(keys[30]) }], usageQuota: (name, startSec, endSec) => 100 * secs(name, startSec, endSec) });
  const first = oldSub2 ? createFakeSub2Api({ keys: [{ id: 9, name: "stable" }], dayUsageUsd: (_id, day) => secondsInDay(windows.stable, day) }) : null;
  const channel = { baseUrl: "https://upstream.test", token: 9 };
  const f = liveReconciliationFixture(t, { policy: "immediate", segments: [{ id: "s1", group: "g1", from: 0 }], channelsByRule: { rr_live: [1] }, extraTokens: [{ tokenId: 9, name: "stable" }],
    ...(oldSub2 ? { sub2api: first, tokenKeyOf: () => "sk-x" } : { tokenKeyOf: (id) => keys[id], usageOf: (name, startSec, endSec) => (name === "stable" ? 100 * secs("stable", startSec, endSec) : 0) }),
    extraStations: [{ id: "upstream2", name: "上游2", type: sub2 ? "sub2api" : "newapi", baseUrl: "https://upstream2.test", accessToken: sub2 ? "jwt" : "pat2", authVersion: 1, accountUse: targetAccountUse, ...(rates ? { cnyPerUsd: rates.second } : {}) }],
    extraHosts: { "upstream2.test": second },
    keyAgent: { secret: KEY_AGENT_SECRET, channels: () => [{ id: 1, baseUrl: channel.baseUrl, keys: [{ i: 0, m: maskKey(channel.token === 9 ? keys[9] : keys[30]), f: "unused" }] }] } });
  f.stations[0].accountUse = "only_mine";
  if (oldSub2) Object.assign(f.stations[0], { type: "sub2api", accessToken: "jwt" });
  if (rates) f.stations[0].cnyPerUsd = rates.first;
  const injected = () => ({ at: now, stationId: "own", etag: null, result: { ok: true, status: 200, stale: false, fetchedAtMs: now, revealIssues: [],
    channels: [{ channelId: 1, keyless: false, slots: [{ index: 0, state: "identified", matches: [channel.token === 9 ? { stationId: "upstream", tokenId: 9, tokenName: "stable", via: "fingerprint" } : { stationId: "upstream2", tokenId: newId, tokenName: newName, via: "fingerprint" }] }] }] } });
  const inject = () => { f.rt._keyAgentIdentifyCache = injectIdentity ? injected() : null; };
  inject();
  await f.module.refreshDue(now);
  const anchored = await f.repository.getRule("rr_live");
  f.rt.reconciliation = f.module;
  if (injectIdentity) f.rt.channelProfit = createChannelProfitModule(f.rt, { identify: async () => f.rt._keyAgentIdentifyCache.result });
  f.rt.channelOnboarding = {
    getSourceCatalogue: () => ({ ownSource: { namespaceKey: anchored.ownSource.namespaceKey }, stale: false, channels: [{ id: 1, name: "渠道 1", revision: "rev-1", missing: false }] }),
    inspectSource: () => ({ version: "r1", status: "confirmed" }),
  };
  f.rt.onboardingSource = f.rt.channelOnboarding; // 生产里是同一个对象
  Object.assign(channel, { baseUrl: "https://upstream2.test", token: 30 }); // 渠道换成了新上游的 Key
  now = REGROUP_B; inject();
  await f.module.refreshDue(now); // 认出来：旧绑定归档（过渡段跨上游读），新上游下建新绑定
  for (const iso of ["2026-10-13T01:00:00Z", "2026-10-14T01:00:00Z", "2026-10-15T01:00:00Z"]) { now = Date.parse(iso); inject(); await f.module.refreshDue(now); }
  const created = (await f.repository.listRules()).filter((rule) => rule.upstreamStationId === "upstream2").map((rule) => rule.id);
  const costOn = (billDate) => {
    const latest = new Map();
    for (const row of f.state.ledger.filter((item) => item.bill_date === billDate)) if (!latest.has(row.rule_id) || Number(row.revision) > Number(latest.get(row.rule_id).revision)) latest.set(row.rule_id, row);
    return [...latest.values()].reduce((total, row) => total + Number(row.cost_usd), 0);
  };
  const truthOn = (billDate) => Object.values(windows).reduce((total, window) => total + secondsInDay(window, billDate), 0);
  const more = async (isos) => { for (const iso of isos) { now = Date.parse(iso); inject(); await f.module.refreshDue(now); } };
  return { f, created, costOn, truthOn, windows, more };
}

for (const [from, to] of [["newapi", "newapi"], ["newapi", "sub2api"], ["sub2api", "newapi"], ["sub2api", "sub2api"]]) {
  const label = (type) => (type === "newapi" ? "New API" : "Sub2API");
  test(`K2c 换到另一个上游（${label(from)} → ${label(to)}）：旧绑定在 b 归档，新上游下的新绑定接着算；每天所有行的上游成本之和 = 各 Key 当天用量之和`, async (t) => {
    const s = await crossUpstreamScenario(t, { from, to });
    const old = await s.f.repository.getRule("rr_live", { includeArchived: true });
    assert.deepEqual([old.enabled, old.archivedAtMs], [false, REGROUP_B], "旧绑定在 b 归档");
    assert.equal(s.created.length, 1, "新上游下建了一条");
    const started = await s.f.repository.getRule(s.created[0]);
    assert.deepEqual([started.upstreamStationId, started.channels.map((channel) => channel.channelId)], ["upstream2", [1]]);
    const oldSegments = await s.f.repository.listSegments("rr_live");
    const windowSegment = oldSegments.find((segment) => segment.timingSource === "key_change_window");
    const bDayStart = Date.parse("2026-10-11T16:00:00Z"); // b（10-12 09:00 上海）那天 0 点
    if (from === "sub2api" || to === "sub2api") {
      // 旧上游或新上游是 Sub2API（整天读）：过渡段只到 b 那天 0 点，之后到 b 只放旧 Key（b 当天整天由新绑定取，不读两遍）；过渡段起点（a 在 b 那天）不早于 0 点时没有过渡段
      if (windowSegment) assert.equal(windowSegment.effectiveTo, bDayStart);
    } else {
      assert.deepEqual(windowSegment.keys.map((key) => key.upstreamStationId).sort(), ["upstream", "upstream2"], "过渡段里放着旧上游的旧 Key 和新上游的新 Key");
      assert.equal(windowSegment.effectiveTo, REGROUP_B);
    }
    const newSegments = await s.f.repository.listSegments(started.id);
    if (from === "sub2api") {
      assert.equal(started.accountingFloorMs, null, "旧绑定是 Sub2API：归档那天整天不算，新绑定从 b 那天 0 点整天算，不设下限");
      assert.deepEqual([newSegments[0].effectiveTo, newSegments[0].keys.map((key) => `${key.upstreamStationId}:${key.tokenId}`).sort()], [Date.parse("2026-10-12T16:00:00Z"), ["upstream:9", `upstream2:${to === "sub2api" ? 40 : 30}`].sort()], "第一段只到下一个业务日 0 点，带着旧 Key（整天读）");
    } else {
      assert.equal(started.accountingFloorMs, REGROUP_B, "旧绑定是 New API：算到 b 为止，新绑定从 b 起算");
    }
    for (const day of ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]) assert.equal(s.costOn(day), s.truthOn(day), day);
  });
}

// 过渡段里两个上游的钱：账本一行只存一个汇率。美元各自折成人民币再相加，cost_rate = 人民币合计 ÷ 美元合计；有一个上游没设置汇率就按没设置（null），不当 1:1
test("K2c 换到另一个上游：过渡段里两个上游汇率不一样时，成本折人民币 = 各自折完再相加（账本 cost_rate 是混合汇率）", async (t) => {
  const s = await crossUpstreamScenario(t, { from: "newapi", to: "newapi", rates: { first: 7, second: 6 } });
  const row = s.f.state.ledger.filter((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-12").sort((x, y) => Number(y.revision) - Number(x.revision))[0];
  const oldKey = 4 * 3600, newKey = 5 * 3600; // 0 点到换 Key 的 4 小时是旧 Key（上游 7），到 b 的 5 小时是新 Key（上游 6），每秒 1 美元
  assert.equal(Number(row.cost_usd), oldKey + newKey);
  assert.ok(Math.abs(Number(row.cost_rate) - (oldKey * 7 + newKey * 6) / (oldKey + newKey)) < 1e-6, `混合汇率 ${row.cost_rate}`);
  assert.ok(Math.abs(Number(row.cost_usd) * Number(row.cost_rate) - (oldKey * 7 + newKey * 6)) < 0.05, "折人民币 = 7×旧 + 6×新");
  const own = s.f.state.ledger.filter((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-11")[0];
  assert.equal(Number(own.cost_rate), 7, "没有过渡段里的新 Key 用量的日子，仍是旧上游自己的汇率");
});

test("K2c 换到另一个上游：过渡段里有一个上游没设置汇率时，混合汇率按「没设置」记（null），不当成 1:1", async (t) => {
  const s = await crossUpstreamScenario(t, { from: "newapi", to: "newapi", rates: { first: 7, second: null } });
  const row = s.f.state.ledger.filter((item) => item.rule_id === "rr_live" && item.bill_date === "2026-10-12")[0];
  assert.equal(Number(row.cost_usd), 9 * 3600);
  assert.equal(row.cost_rate, null);
});

// K2c-4：新上游别处也在用（或没回答），渠道换到这把新 Key：照常分，新上游下建一条还没回答的绑定，b 起先不算，等回答
for (const [from, to] of [["newapi", "newapi"], ["sub2api", "newapi"], ["sub2api", "sub2api"]]) {
  test(`K2c-4 换到另一个上游（${from === "newapi" ? "New API" : "Sub2API"} → ${to === "newapi" ? "New API" : "Sub2API"}），新上游没答「只给我的渠道用」：新绑定从 b 起先不算利润；答「只给这些渠道用」以后 b 起那几天跟着补结，每天所有行的成本之和 = 各 Key 当天用量之和；答「别处也在用」利润照旧不算`, async (t) => {
    const s = await crossUpstreamScenario(t, { from, to, targetAccountUse: "unknown" });
    const old = await s.f.repository.getRule("rr_live", { includeArchived: true });
    assert.deepEqual([old.enabled, old.archivedAtMs], [false, REGROUP_B], "旧绑定照常在 b 归档");
    assert.equal(s.created.length, 1);
    const fresh = await s.f.repository.getRule(s.created[0]);
    assert.deepEqual([coverageNeedsAnswer(fresh, "usage"), fresh.coverageDeclaration?.answer ?? null], [true, "unknown"], "新绑定还没回答");
    const bookedOf = (id) => s.f.state.ledger.filter((row) => row.rule_id === id).map((row) => row.bill_date);
    assert.deepEqual(bookedOf(fresh.id), [], "回答以前 b 起一天都不算");
    // 答「别处也在用」：利润照旧不算
    const answerWith = (coverageDeclaration, costCoverage) => s.f.repository.updateRule(fresh.id, { upstreamStationId: "upstream2", ownStationId: "own", tokenId: fresh.tokenId, tokenName: fresh.tokenName, fixedGroup: fresh.fixedGroup,
      provider: fresh.provider, canonicalKey: fresh.canonicalKey, ownSource: fresh.ownSource, sourceBinding: fresh.sourceBinding, channels: fresh.channels, timezone: fresh.timezone, enabled: true,
      billingPolicy: fresh.billingPolicy, costCoverage, coverageDeclaration });
    await answerWith({ answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] }, "unknown");
    await s.more(["2026-10-15T02:00:00Z", "2026-10-15T03:00:00Z", "2026-10-15T04:00:00Z", "2026-10-15T05:00:00Z"]);
    assert.deepEqual(bookedOf(fresh.id), [], "答了别处也在用：利润照旧不算");
    // 答「只给这些渠道用」：b 起那几天跟着补结
    await answerWith({ answer: "none" }, "complete");
    await s.more(["2026-10-15T06:00:00Z", "2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z", "2026-10-15T09:00:00Z", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z"]);
    assert.ok(["2026-10-12", "2026-10-13", "2026-10-14"].every((day) => bookedOf(fresh.id).includes(day)), `补结 ${bookedOf(fresh.id)}`);
    for (const day of ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]) assert.equal(s.costOn(day), s.truthOn(day), day);
  });
}
