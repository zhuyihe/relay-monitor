import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureSchema } from "./pool.js";
import { ChannelOnboardingRepository } from "../server/channel-onboarding-repository.js";
import { ReconciliationRepository, reconciliationOwnerRuleState } from "../server/reconciliation-repository.js";
import { reconciliationScopeFingerprint } from "../lib/reconciliation-snapshot.js";

// Opt-in only: this fixture replaces tables in this one disposable local schema.
// Never load .env or fall back to the application's connection defaults.
const port = Number(process.env.DB_PORT);
if (process.env.ONBOARDING_SCHEMA_TEST !== "1"
  || !["127.0.0.1", "localhost"].includes(process.env.DB_HOST)
  || process.env.DB_NAME !== "relay_monitor_test"
  || process.env.DB_USER !== "relay_monitor_test"
  || !process.env.DB_PASSWORD
  || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Refusing SQL integration test: explicit ONBOARDING_SCHEMA_TEST=1, localhost, port, test credentials and relay_monitor_test schema are required");
}

const legacyStation = { id: "upstream", name: "Legacy monitor", type: "newapi", baseUrl: "https://fixture.invalid",
  accessToken: "fixture-not-a-real-pat", includeInProfit: true };
const legacySettings = { refreshIntervalSec: 60, dailyReport: { enabled: false, lastSent: "2026-10-08" } };
const legacySource = { recordType: "confirmed", billingSource: "channel-log-stat", calculationVersion: 3,
  scopeFingerprint: "legacy-scope", result: { calculation: { profitUsd: 4, marginRate: 0.4 } } };

async function seedLegacySchema(pool) {
  const tables = ["channel_monitor_links", "reconciliation_alert_state", "reconciliation_snapshots",
    "reconciliation_rule_segments", "reconciliation_rule_channels", "reconciliation_rules",
    "station_daily_usage", "history_points", "meta", "stations"];
  for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await pool.query(`CREATE TABLE stations (
    id VARCHAR(32) PRIMARY KEY, pos INT NOT NULL DEFAULT 0, doc JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE meta (
    k VARCHAR(64) PRIMARY KEY, v JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE reconciliation_rules (
    id VARCHAR(32) PRIMARY KEY, upstream_station_id VARCHAR(32) NOT NULL, own_station_id VARCHAR(32) NOT NULL,
    token_id BIGINT NOT NULL, token_name VARCHAR(160) NOT NULL, fixed_group VARCHAR(160) NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai', enabled TINYINT NOT NULL DEFAULT 1,
    active_token_key VARCHAR(255) NULL, archived_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_reconciliation_upstream (upstream_station_id, token_id),
    INDEX idx_reconciliation_enabled (enabled, archived_at),
    UNIQUE KEY uq_reconciliation_active_token (active_token_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE reconciliation_rule_channels (
    rule_id VARCHAR(32) NOT NULL, channel_id BIGINT NOT NULL, channel_name VARCHAR(160) NOT NULL,
    active_channel_key VARCHAR(96) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (rule_id, channel_id), INDEX idx_reconciliation_channel (channel_id),
    UNIQUE KEY uq_reconciliation_active_channel (active_channel_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE reconciliation_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, rule_id VARCHAR(32) NOT NULL, snapshot_key VARCHAR(128) NOT NULL,
    window_kind VARCHAR(24) NOT NULL, window_start_ms BIGINT NOT NULL, window_end_ms BIGINT NOT NULL, local_date DATE NULL,
    upstream_quota DOUBLE NULL, upstream_quota_per_unit DOUBLE NULL, upstream_usd DOUBLE NULL,
    downstream_quota DOUBLE NULL, downstream_quota_per_unit DOUBLE NULL, downstream_usd DOUBLE NULL,
    difference_usd DOUBLE NULL, margin_rate DOUBLE NULL, coverage DOUBLE NULL,
    health_code VARCHAR(64) NOT NULL, health_detail VARCHAR(300) NULL, source JSON NULL,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_reconciliation_snapshot (rule_id, snapshot_key),
    INDEX idx_reconciliation_snapshot_window (window_start_ms, window_end_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query("INSERT INTO stations (id, doc) VALUES (?, ?)", [legacyStation.id, JSON.stringify(legacyStation)]);
  for (const [key, value] of Object.entries({ settings: legacySettings, auth: { enabled: true }, unrelated: { keep: "unchanged" } })) {
    await pool.query("INSERT INTO meta (k, v) VALUES (?, ?)", [key, JSON.stringify(value)]);
  }
  await pool.query(`INSERT INTO reconciliation_rules
    (id, upstream_station_id, own_station_id, token_id, token_name, fixed_group, active_token_key)
    VALUES ('legacy_rule', 'upstream', 'own', 7, 'Legacy Key', 'g', 'upstream:7')`);
  await pool.query(`INSERT INTO reconciliation_rule_channels
    (rule_id, channel_id, channel_name, active_channel_key) VALUES ('legacy_rule', 1, 'Legacy channel', 'own:1')`);
  await pool.query(`INSERT INTO reconciliation_snapshots
    (rule_id, snapshot_key, window_kind, window_start_ms, window_end_ms, upstream_usd, downstream_usd,
     difference_usd, margin_rate, health_code, source)
    VALUES ('legacy_rule', 'legacy-confirmed', 'custom', 1000, 2000, 6, 10, 4, 0.4, 'READY', ?)`, [JSON.stringify(legacySource)]);
}

test("MySQL 8 migration and onboarding transactions", { timeout: 60000 }, async (t) => {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, charset: "utf8mb4_unicode_ci", supportBigNumbers: true });
  t.after(() => pool.end());
  const [[database]] = await pool.query("SELECT DATABASE() AS name, VERSION() AS version, @@sql_mode AS sqlMode");
  assert.equal(database.name, "relay_monitor_test");
  assert.match(database.version, /^8\./);
  assert.match(database.sqlMode, /STRICT_TRANS_TABLES|STRICT_ALL_TABLES/);
  await seedLegacySchema(pool);
  const reconciliation = new ReconciliationRepository(pool);
  const onboarding = new ChannelOnboardingRepository(pool);

  await t.test("repeat migration retains legacy policy, monitor, settings and confirmed bill", async () => {
    await ensureSchema(pool);
    await ensureSchema(pool);
    const rule = await reconciliation.getRule("legacy_rule");
    assert.equal(rule.billingPolicy, "legacy-v3");
    assert.equal(rule.scopeVersion, 1);
    assert.equal(rule.billingEffectiveFrom, null);
    assert.equal(rule.costCoverage, "unknown");
    assert.equal(rule.sourceBinding, null);
    assert.deepEqual(rule.channels.map((channel) => channel.channelId), [1]);
    const segments = await reconciliation.listSegments(rule.id);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].timingSource, "legacy");
    const [[station]] = await pool.query("SELECT doc FROM stations WHERE id = ?", [legacyStation.id]);
    assert.deepEqual(station.doc, legacyStation);
    const [meta] = await pool.query("SELECT k, v FROM meta ORDER BY k");
    assert.deepEqual(Object.fromEntries(meta.map((row) => [row.k, row.v])),
      { auth: { enabled: true }, settings: legacySettings, unrelated: { keep: "unchanged" } });
    const [[snapshot]] = await pool.query("SELECT * FROM reconciliation_snapshots WHERE snapshot_key = 'legacy-confirmed'");
    assert.deepEqual(snapshot.source, legacySource);
    assert.equal(snapshot.upstream_usd, 6);
    assert.equal(snapshot.downstream_usd, 10);
    assert.equal(snapshot.difference_usd, 4);
    assert.equal(snapshot.segment_id, segments[0].id);
  });

  await t.test("link revision retries are idempotent and catalogue has an independent meta key", async () => {
    const link = { ownStationId: "own", channelId: 1, stationId: "upstream", channelRevision: "revision-a", confirmedAt: 1000 };
    await onboarding.saveLinks([link]);
    assert.equal((await onboarding.saveLinks([{ ...link, confirmedAt: 2000 }]))[0].confirmedAt, 1000);
    const revised = await onboarding.saveLinks([{ ...link, channelRevision: "revision-b", confirmedAt: 3000 }]);
    assert.equal(revised[0].confirmedAt, 3000);
    assert.equal((await onboarding.listLinks({ ownStationId: "own" })).length, 1);
    assert.equal((await onboarding.listLinks({ stationId: "upstream" }))[0].channelRevision, "revision-b");
    const catalogue = { ownStationId: "own", sourceVersion: "source-1", totalValidated: true,
      channels: [{ id: 1, groups: ["sales"], revision: "revision-b" }] };
    await onboarding.saveCatalogue(catalogue);
    assert.deepEqual(await onboarding.getCatalogue(), catalogue);
    const [[settings]] = await pool.query("SELECT v FROM meta WHERE k = 'settings'");
    assert.deepEqual(settings.v, legacySettings);
  });

  await t.test("real concurrent appends preserve the union, scope fields and retry effective date", async () => {
    await Promise.all([
      reconciliation.appendChannels("legacy_rule", [{ channelId: 2, name: "Second channel" }],
        { costCoverage: "complete", provider: "newapi", canonicalKey: "fixture-canonical-key", sourceBinding: { 1: "r1", 2: "r2" } }),
      reconciliation.appendChannels("legacy_rule", [{ channelId: 3, name: "Third channel" }],
        { costCoverage: "complete", provider: "newapi", canonicalKey: "fixture-canonical-key", sourceBinding: { 1: "r1", 3: "r3" } }),
    ]);
    const rule = await reconciliation.getRule("legacy_rule");
    assert.deepEqual(rule.channels.map((channel) => channel.channelId).sort(), [1, 2, 3]);
    assert.equal(rule.billingPolicy, "next-complete-day");
    assert.equal(rule.scopeVersion, 3);
    assert.equal(rule.provider, "newapi");
    assert.equal(rule.canonicalKey, "fixture-canonical-key");
    assert.equal(rule.costCoverage, "complete");
    assert.deepEqual(rule.sourceBinding, { 1: "r1", 2: "r2", 3: "r3" });
    assert.ok(rule.billingEffectiveFrom > Date.now());
    const retried = await reconciliation.appendChannels(rule.id, [{ channelId: 2, name: "Second channel" }],
      { costCoverage: "complete", sourceBinding: { 2: "r2" } });
    assert.equal(retried.scopeVersion, rule.scopeVersion);
    assert.equal(retried.billingEffectiveFrom, rule.billingEffectiveFrom);
  });

  await t.test("SQL uniqueness failure rolls back the scope update and deleted channel set", async () => {
    await reconciliation.createRule({ upstreamStationId: "other-upstream", ownStationId: "own", tokenId: 8,
      tokenName: "Other Key", fixedGroup: "g", timezone: "Asia/Shanghai", channels: [{ channelId: 9, name: "Taken channel" }] });
    const before = await reconciliation.getRule("legacy_rule");
    await assert.rejects(reconciliation.appendChannels(before.id, [{ channelId: 9, name: "Duplicate channel" }],
      { costCoverage: "unknown", sourceBinding: { 9: "r9" } }), (error) => error.code === "ER_DUP_ENTRY");
    const after = await reconciliation.getRule(before.id);
    assert.deepEqual(after, before);
    const [[legacySnapshot]] = await pool.query("SELECT source FROM reconciliation_snapshots WHERE snapshot_key = 'legacy-confirmed'");
    assert.deepEqual(legacySnapshot.source, legacySource);
  });

  const ownSource = { stationId: "anchor-own", provider: "newapi", baseUrl: "https://own.fixture.invalid",
    accountId: "1", namespaceKey: "fixture-own-namespace" };
  async function unanchoredRule(tokenId, sourceBinding = null, source = null) {
    return reconciliation.createRule({ upstreamStationId: `anchor-up-${tokenId}`, ownStationId: "anchor-own", tokenId,
      tokenName: `Anchor Key ${tokenId}`, fixedGroup: "g", timezone: "Asia/Shanghai", billingPolicy: "legacy-v3",
      scopeVersion: 7, billingEffectiveFrom: 1000, sourceBinding, ownSource: source,
      channels: [{ channelId: tokenId, name: `Anchor channel ${tokenId}` }] });
  }
  async function fingerprint(rule) {
    return reconciliationScopeFingerprint(rule, await reconciliation.listSegments(rule.id));
  }
  const anchor = (tokenId) => ({ provider: "newapi", canonicalKey: `fixture-anchor-${tokenId}`, ownSource });
  async function originalSnapshot(rule, source) {
    await pool.query(`INSERT INTO reconciliation_snapshots
      (rule_id, snapshot_key, window_kind, window_start_ms, window_end_ms, health_code, source)
      VALUES (?, ?, 'custom', 1000, 2000, 'READY', ?)`, [rule.id, `anchor-history-${rule.tokenId}`, JSON.stringify(source)]);
  }

  await t.test("safe identity anchoring round trips null, legacy map and V2 without changing scope or members", async () => {
    for (const [tokenId, binding, initialSource] of [[101, null, null], [102, { 102: "r102" }, null], [103, { 103: "r103" }, ownSource]]) {
      const before = await unanchoredRule(tokenId, binding, initialSource);
      if (tokenId === 102) {
        await pool.query("UPDATE reconciliation_rules SET source_binding = ? WHERE id = ?", [JSON.stringify(binding), before.id]);
      }
      const segments = await reconciliation.listSegments(before.id);
      const current = await reconciliation.getRule(before.id);
      assert.deepEqual(current.sourceBinding, binding);
      const saved = await reconciliation.anchorRuleIdentity(before.id, anchor(tokenId),
        { expectedScopeFingerprint: await fingerprint(current), allowInitialAnchoring: true });
      assert.equal(saved.provider, "newapi");
      assert.equal(saved.canonicalKey, anchor(tokenId).canonicalKey);
      assert.deepEqual(saved.ownSource, ownSource);
      assert.deepEqual(saved.sourceBinding, binding || {});
      for (const field of ["billingPolicy", "scopeVersion", "billingEffectiveFrom", "costCoverage", "enabled", "timezone"]) {
        assert.deepEqual(saved[field], before[field], field);
      }
      assert.deepEqual(saved.channels, before.channels);
      assert.deepEqual(await reconciliation.listSegments(saved.id), segments);
      const [[raw]] = await pool.query("SELECT source_binding FROM reconciliation_rules WHERE id = ?", [saved.id]);
      assert.equal(raw.source_binding.version, 2);
      assert.deepEqual(raw.source_binding.ownSource, ownSource);
    }
  });

  await t.test("unproven historical identity or prior status observation rejects initial proof with no write", async () => {
    for (const tokenId of [104, 105, 106]) {
      const rule = await unanchoredRule(tokenId);
      if (tokenId === 104) await originalSnapshot(rule, { recordType: "confirmed" });
      if (tokenId === 105) await originalSnapshot(rule, { ruleEvidence: { canonicalKey: anchor(tokenId).canonicalKey,
        ownSource: { ...ownSource, namespaceKey: "different-original-source" } } });
      if (tokenId === 106) await pool.query(
        "UPDATE reconciliation_rule_channels SET status_observed_at_ms = 1500, channel_status = 'enabled' WHERE rule_id = ?", [rule.id]);
      const before = await reconciliation.getRule(rule.id);
      const segments = await reconciliation.listSegments(rule.id);
      await assert.rejects(reconciliation.anchorRuleIdentity(rule.id, anchor(tokenId),
        { expectedScopeFingerprint: await fingerprint(before), allowInitialAnchoring: true }),
      (error) => error.code === "LEGACY_IDENTITY_UNVERIFIED");
      assert.deepEqual(await reconciliation.getRule(rule.id), before);
      assert.deepEqual(await reconciliation.listSegments(rule.id), segments);
    }
  });

  await t.test("matching original facts anchor without initial proof while changed fingerprint or archived row cannot write", async () => {
    const rule = await unanchoredRule(107);
    await originalSnapshot(rule, { ruleEvidence: anchor(107) });
    const before = await reconciliation.getRule(rule.id);
    const originalFingerprint = await fingerprint(before);
    assert.equal(await reconciliation.anchorRuleIdentity(rule.id, anchor(107), { expectedScopeFingerprint: "obsolete" }), null);
    assert.deepEqual(await reconciliation.getRule(rule.id), before);
    const saved = await reconciliation.anchorRuleIdentity(rule.id, anchor(107), { expectedScopeFingerprint: originalFingerprint });
    assert.equal(saved.canonicalKey, anchor(107).canonicalKey);
    assert.deepEqual(saved.ownSource, ownSource);
    await reconciliation.archiveRule(rule.id);
    const archived = await reconciliation.getRule(rule.id, { includeArchived: true });
    assert.equal(await reconciliation.anchorRuleIdentity(rule.id, anchor(107), { expectedScopeFingerprint: await fingerprint(archived) }), null);
    assert.deepEqual(await reconciliation.getRule(rule.id, { includeArchived: true }), archived);
    const [[history]] = await pool.query("SELECT source FROM reconciliation_snapshots WHERE snapshot_key = ?", ["anchor-history-107"]);
    assert.deepEqual(history.source, { ruleEvidence: anchor(107) });
  });

  await t.test("rule create and member update final guards roll back every financial write", async () => {
    async function rowCounts() {
      const counts = [];
      for (const table of ["reconciliation_rules", "reconciliation_rule_channels", "reconciliation_rule_segments"]) {
        const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
        counts.push(row.count);
      }
      return counts;
    }
    const beforeCounts = await rowCounts();
    let createChecks = 0;
    await assert.rejects(reconciliation.createRule({ upstreamStationId: "guard-upstream", ownStationId: "guard-own", tokenId: 109,
      tokenName: "Guard Key", fixedGroup: "g", timezone: "Asia/Shanghai", billingPolicy: "next-complete-day",
      channels: [{ channelId: 109, name: "Guard channel" }], costCoverage: "complete" },
    { guard: (lockedRule, lockedChannels, policy) => {
      assert.equal(lockedRule, null);
      assert.deepEqual(lockedChannels, []);
      assert.deepEqual(policy.channels.map((channel) => channel.channelId), [109]);
      if (++createChecks === 2) throw Object.assign(new Error("fixture changed preview"), { code: "PREVIEW_BASIS_CHANGED" });
    } }), (error) => error.code === "PREVIEW_BASIS_CHANGED");
    assert.equal(createChecks, 2);
    assert.deepEqual(await rowCounts(), beforeCounts);

    const beforeRule = await reconciliation.getRule("legacy_rule");
    const beforeSegments = await reconciliation.listSegments(beforeRule.id);
    let updateChecks = 0;
    await assert.rejects(reconciliation.appendChannels(beforeRule.id, [{ channelId: 109, name: "Added channel" }],
      { costCoverage: "complete", sourceBinding: { 109: "r109" } },
      { guard: (lockedRule, lockedChannels, policy) => {
        assert.equal(lockedRule.id, beforeRule.id);
        assert.deepEqual(lockedChannels.map((channel) => channel.channelId).sort((a, b) => a - b), [1, 2, 3]);
        assert.deepEqual(policy.channels.map((channel) => channel.channelId).sort((a, b) => a - b), [1, 2, 3, 109]);
        if (++updateChecks === 2) throw Object.assign(new Error("fixture changed day"), { code: "EFFECTIVE_PREVIEW_CHANGED" });
      } }), (error) => error.code === "EFFECTIVE_PREVIEW_CHANGED");
    assert.equal(updateChecks, 2);
    assert.deepEqual(await reconciliation.getRule(beforeRule.id), beforeRule);
    assert.deepEqual(await reconciliation.listSegments(beforeRule.id), beforeSegments);
    assert.deepEqual(await rowCounts(), beforeCounts);
  });

  await t.test("owner generation and final guard prevent obsolete snapshot SQL commits", async () => {
    const rule = await reconciliation.getRule("legacy_rule");
    const segments = await reconciliation.listSegments(rule.id);
    const expectedScope = reconciliationScopeFingerprint(rule, segments);
    const expectedOwnerState = reconciliationOwnerRuleState(await reconciliation.listRules());
    const snapshot = { ruleId: rule.id, segmentId: segments[0].id, snapshotKey: "owner-obsolete", windowKind: "custom",
      startMs: 5000, endMs: 6000, localDate: null, upstreamUsd: 2, downstreamUsd: 3, differenceUsd: 1,
      marginRate: 1 / 3, healthCode: "READY", source: { recordType: "confirmed", scopeFingerprint: expectedScope } };
    await reconciliation.createRule({ upstreamStationId: "owner-extra-upstream", ownStationId: "owner-extra-own", tokenId: 108,
      tokenName: "New owner", fixedGroup: "g", timezone: "Asia/Shanghai", channels: [{ channelId: 108, name: "Owner channel" }] });
    let guardCalls = 0;
    assert.equal(await reconciliation.saveSnapshotsForScope(rule.id, expectedScope, [snapshot],
      { expectedOwnerState, guard: () => { guardCalls += 1; return true; } }), false);
    assert.equal(guardCalls, 0);
    const currentOwners = reconciliationOwnerRuleState(await reconciliation.listRules());
    assert.equal(await reconciliation.saveSnapshotsForScope(rule.id, expectedScope,
      [{ ...snapshot, snapshotKey: "owner-final-guard" }],
      { expectedOwnerState: currentOwners, guard: () => ++guardCalls === 1 }), false);
    assert.equal(guardCalls, 2);
    const [[rows]] = await pool.query("SELECT COUNT(*) AS count FROM reconciliation_snapshots WHERE snapshot_key IN ('owner-obsolete', 'owner-final-guard')");
    assert.equal(rows.count, 0);
    const [[original]] = await pool.query("SELECT source FROM reconciliation_snapshots WHERE snapshot_key = 'legacy-confirmed'");
    assert.deepEqual(original.source, legacySource);
  });

  await t.test("snapshot batch SQL failure rolls back every preceding insert", async () => {
    const rule = await reconciliation.getRule("legacy_rule");
    const segments = await reconciliation.listSegments(rule.id);
    const fingerprint = reconciliationScopeFingerprint(rule, segments);
    const snapshot = { ruleId: rule.id, segmentId: segments[0].id, snapshotKey: "integration-good", windowKind: "custom",
      startMs: 3000, endMs: 4000, localDate: null, upstreamQuota: null, upstreamQuotaPerUnit: null, upstreamUsd: 2,
      downstreamQuota: null, downstreamQuotaPerUnit: null, downstreamUsd: 3, differenceUsd: 1, marginRate: 1 / 3,
      coverage: null, healthCode: "READY", healthDetail: null, source: { recordType: "confirmed", scopeFingerprint: fingerprint } };
    await assert.rejects(reconciliation.saveSnapshotsForScope(rule.id, fingerprint,
      [snapshot, { ...snapshot, snapshotKey: "integration-invalid", healthCode: null }]), (error) => error.code === "ER_BAD_NULL_ERROR");
    const [[rows]] = await pool.query("SELECT COUNT(*) AS count FROM reconciliation_snapshots WHERE snapshot_key IN ('integration-good', 'integration-invalid')");
    assert.equal(rows.count, 0);
  });

  const billStart = Date.parse("2026-10-08T00:00:00Z"), billEnd = Date.parse("2026-10-09T00:00:00Z");
  const historySource = { stationId: "history-own", provider: "newapi", baseUrl: "https://original-own.fixture.invalid",
    accountId: "21", namespaceKey: "original-history-namespace" };
  async function historyRule(tokenId) {
    return reconciliation.createRule({ upstreamStationId: "history-upstream", ownStationId: "history-own", tokenId,
      tokenName: `Current Key ${tokenId}`, fixedGroup: "current", timezone: "Asia/Shanghai", billingPolicy: "legacy-v3",
      ownSource: historySource, channels: [{ channelId: tokenId, name: "Current member" }] });
  }
  function savedBill({ scope = "original-scope", generation = "2026-10-09T00:00:00Z", profit = 4 } = {}) {
    const channels = [{ channelId: 11, name: "Original first" }, { channelId: 12, name: "Original second" }];
    return { recordType: "confirmed", billingSource: "channel-log-stat", calculationVersion: 3,
      scopeFingerprint: scope, resultGeneratedAt: generation,
      window: { preset: "yesterday", startMs: billStart, endMs: billEnd, timezone: "UTC" },
      scopePolicy: { billingEffectiveFrom: billStart, scopeVersion: 3 },
      ruleEvidence: { ownSource: historySource, upstreamIdentity: { provider: "newapi",
        baseUrl: "https://original-upstream.fixture.invalid", accountId: "42" }, canonicalKey: "original-history-key",
        tokenId: 7, tokenName: "Original Key", channels, scopeVersion: 3 },
      result: { upstream: { state: "complete", amountUsd: 6, knownAmountUsd: 6, quotaPerUnit: 500000,
        raw: { accessToken: "fixture-history-secret" } },
      downstream: { state: "complete", amountUsd: 10, knownAmountUsd: 10,
        channels: channels.map((channel) => ({ ...channel, billingState: "complete", amountUsd: 5, knownAmountUsd: 5 })) },
      calculation: { profitUsd: profit, differenceUsd: profit, marginRate: profit == null ? null : profit / 10 } },
      diagnostic: "fixture-history-secret" };
  }
  async function savedHistoryRow(rule, key, source, startMs = billStart, endMs = billEnd) {
    await pool.query(`INSERT INTO reconciliation_snapshots
      (rule_id, snapshot_key, window_kind, window_start_ms, window_end_ms, health_code, source, generated_at)
      VALUES (?, ?, 'custom', ?, ?, 'READY', ?, '2026-10-09 12:00:00')`,
    [rule.id, key, startMs, endMs, JSON.stringify(source)]);
  }

  const originalHistoryRule = await historyRule(201);
  await t.test("confirmed history collapses original segments and excludes observation, v2 and unknown profit", async () => {
    const middle = (billStart + billEnd) / 2;
    await savedHistoryRow(originalHistoryRule, "original-a", savedBill(), billStart, middle);
    await savedHistoryRow(originalHistoryRule, "original-z", savedBill(), middle, billEnd);
    await savedHistoryRow(originalHistoryRule, "zero", savedBill({ generation: "2026-10-09T01:00:00Z", profit: 0 }));
    await savedHistoryRow(originalHistoryRule, "negative", savedBill({ scope: "second-scope", profit: -2 }));
    await savedHistoryRow(originalHistoryRule, "observation", { ...savedBill(), recordType: "observation" });
    await savedHistoryRow(originalHistoryRule, "v2", { ...savedBill(), calculationVersion: 2 });
    await savedHistoryRow(originalHistoryRule, "unknown", savedBill({ profit: null }));
    const result = await reconciliation.listConfirmedHistory(originalHistoryRule.id, { startMs: billStart, endMs: billEnd });
    assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map((record) => record.calculation.profitUsd).sort((a, b) => a - b), [-2, 0, 4]);
    for (const record of result.records) {
      assert.deepEqual(record.window, { preset: "yesterday", startMs: billStart, endMs: billEnd, timezone: "UTC" });
      assert.deepEqual(record.channels.map((channel) => channel.channelId), [11, 12]);
      assert.equal(record.sourceCompleteness, "complete");
      assert.equal(record.upstreamSource.tokenName, "Original Key");
    }
    assert.equal(JSON.stringify(result).includes("fixture-history-secret"), false);
  });

  await t.test("equal storage timestamps paginate logical bills without repeating earlier segment rows", async () => {
    const ids = [], profits = [];
    let cursor = null;
    for (let page = 0; page < 4; page += 1) {
      const result = await reconciliation.listConfirmedHistory(originalHistoryRule.id,
        { startMs: billStart, endMs: billEnd, limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(result.records.length, 1);
      ids.push(result.records[0].historyId); profits.push(result.records[0].calculation.profitUsd);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(profits.sort((a, b) => a - b), [-2, 0, 4]);
  });

  await t.test("history range uses saved whole window and retains original facts after member change and archive", async () => {
    const tail = await reconciliation.listConfirmedHistory(originalHistoryRule.id,
      { startMs: (billStart + billEnd) / 2, endMs: billEnd });
    assert.deepEqual(tail.records, []);
    const [before] = await pool.query("SELECT snapshot_key, source FROM reconciliation_snapshots WHERE rule_id = ? ORDER BY snapshot_key", [originalHistoryRule.id]);
    await reconciliation.appendChannels(originalHistoryRule.id, [{ channelId: 204, name: "Added later" }], { costCoverage: "complete" });
    await reconciliation.archiveRule(originalHistoryRule.id);
    const result = await reconciliation.listConfirmedHistory(originalHistoryRule.id, { startMs: billStart, endMs: billEnd });
    assert.equal(result.records.length, 3);
    assert.equal(result.records.some((record) => record.channels.some((channel) => channel.channelId === 204)), false);
    assert.deepEqual(result.records[0].ownSource, historySource);
    assert.equal(result.records[0].upstreamSource.baseUrl, "https://original-upstream.fixture.invalid");
    const [after] = await pool.query("SELECT snapshot_key, source FROM reconciliation_snapshots WHERE rule_id = ? ORDER BY snapshot_key", [originalHistoryRule.id]);
    assert.deepEqual(after, before);
    assert.equal((await reconciliation.listRules({ includeArchived: true })).some((rule) => rule.id === originalHistoryRule.id), true);
    assert.equal((await reconciliation.listRules()).some((rule) => rule.id === originalHistoryRule.id), false);
  });

  await t.test("history limit caps at fifty and final page exposes no duplicate or extra cursor", async () => {
    const rule = await historyRule(202);
    for (let i = 0; i < 52; i += 1) await savedHistoryRow(rule, `page-${String(i).padStart(3, "0")}`,
      savedBill({ scope: `page-scope-${i}` }));
    const first = await reconciliation.listConfirmedHistory(rule.id, { startMs: billStart, endMs: billEnd, limit: 100 });
    assert.equal(first.records.length, 50); assert.ok(first.nextCursor);
    const last = await reconciliation.listConfirmedHistory(rule.id,
      { startMs: billStart, endMs: billEnd, limit: 100, cursor: first.nextCursor });
    assert.equal(last.records.length, 2); assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.records, ...last.records].map((record) => record.historyId)).size, 52);
  });

  await t.test("legacy missing logical scope stays separate with original physical facts and no current identity", async () => {
    const rule = await historyRule(203);
    const source = { recordType: "confirmed", billingSource: "channel-log-stat", calculationVersion: 3,
      result: { calculation: { profitUsd: 0 }, downstream: { channels: [{ channelId: 11, name: "Original legacy member" }] } } };
    await savedHistoryRow(rule, "legacy-first", source, 1000, 2000);
    await savedHistoryRow(rule, "legacy-second", source, 1000, 2000);
    const result = await reconciliation.listConfirmedHistory(rule.id, { startMs: 1000, endMs: 2000 });
    assert.equal(result.records.length, 2);
    assert.equal(new Set(result.records.map((record) => record.historyId)).size, 2);
    for (const record of result.records) {
      assert.equal(record.sourceCompleteness, "legacy_partial");
      assert.equal(record.window.startMs, 1000); assert.equal(record.window.endMs, 2000);
      assert.equal(record.window.timezone, null); assert.equal(record.ownSource, null);
      assert.equal(record.upstreamSource.accountId, null); assert.equal(record.upstreamSource.tokenName, null);
      assert.deepEqual(record.channels, [{ channelId: 11, name: "Original legacy member" }]);
    }
    const logicalNullFacts = { ...source, window: { preset: "yesterday", startMs: billStart, endMs: billEnd, timezone: "UTC" },
      scopeFingerprint: null, resultGeneratedAt: null };
    await savedHistoryRow(rule, "legacy-logical-first", logicalNullFacts);
    await savedHistoryRow(rule, "legacy-logical-second", logicalNullFacts);
    const logical = await reconciliation.listConfirmedHistory(rule.id, { startMs: billStart, endMs: billEnd });
    assert.equal(logical.records.length, 2);
    assert.equal(new Set(logical.records.map((record) => record.historyId)).size, 2);
    assert.equal(logical.records.every((record) => record.sourceCompleteness === "legacy_partial"), true);
  });
});
