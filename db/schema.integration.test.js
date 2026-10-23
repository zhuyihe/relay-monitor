import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureSchema, rehashBillingCapabilities } from "./pool.js";
import { billingCapabilityAliases, createBillingCapabilityStorage, wrappedBillingIdentity } from "../lib/billing-capability-storage.js";
import { ChannelOnboardingRepository } from "../server/channel-onboarding-repository.js";
import { ReconciliationRepository, reconciliationOwnerRuleState } from "../server/reconciliation-repository.js";
import { reconciliationScopeFingerprint } from "../lib/reconciliation-snapshot.js";
import { RECONCILIATION_LEDGER_COLUMNS, ledgerInsertValues } from "../lib/reconciliation-ledger.js";
import { defineReconciliationRepositoryContract } from "../server/test-support/reconciliation-repository-contract.js";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { isCiphertext, secretKeyOf } from "./secrets.js";

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
// 第 4 阶段之前写下的单日结账（上海 2026-10-09）：升级时搬进账本。多日窗口留在快照表里不搬。
const LEDGER_DAY = Date.UTC(2026, 9, 8, 16);
const legacySettlement = (window, generatedAt, profitUsd) => ({ recordType: "confirmed", billingSource: "channel-log-stat", calculationVersion: 3,
  scopeFingerprint: "legacy-scope", window, resultGeneratedAt: generatedAt,
  result: { window, requestedWindow: window, lastSuccessfulWindow: window, generatedAt,
    upstream: { state: "complete", amountUsd: 6.5 }, downstream: { state: "complete", amountUsd: 10.25 },
    calculation: { differenceUsd: profitUsd, profitUsd, riskDifferenceUsd: null, marginRate: 0.4 }, health: { code: "READY", issues: [] } } });
const legacyDayWindow = { preset: "yesterday", timezone: "Asia/Shanghai", startMs: LEDGER_DAY, endMs: LEDGER_DAY + 86400000 };
const legacyLedgerRows = [
  ["r3:c:legacyday000000000000000:0000000000000001", legacyDayWindow, "2026-10-09T16:20:00.000Z", 3.75],
  ["r3:c:legacyweek00000000000000:0000000000000001", { ...legacyDayWindow, preset: "custom", startMs: LEDGER_DAY - 6 * 86400000 }, "2026-10-09T16:20:00.000Z", 20],
];

async function seedLegacySchema(pool) {
  const tables = ["channel_monitor_links", "reconciliation_ledger", "reconciliation_billing_capabilities", "reconciliation_alert_state", "reconciliation_snapshots",
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
  for (const [key, window, generatedAt, profitUsd] of legacyLedgerRows) {
    await pool.query(`INSERT INTO reconciliation_snapshots
      (rule_id, snapshot_key, window_kind, window_start_ms, window_end_ms, health_code, source)
      VALUES ('legacy_rule', ?, ?, ?, ?, 'READY', ?)`, [key, window.preset, window.startMs, window.endMs, JSON.stringify(legacySettlement(window, generatedAt, profitUsd))]);
  }
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
    const { reconciliation_ledger_backfill_v1: backfill, ...rest } = Object.fromEntries(meta.map((row) => [row.k, row.v]));
    assert.deepEqual(rest, { auth: { enabled: true }, settings: legacySettings, unrelated: { keep: "unchanged" } });
    assert.equal(backfill.migrated, 1);
    assert.ok(Number.isFinite(Date.parse(backfill.completedAt)));
    const [[snapshot]] = await pool.query("SELECT * FROM reconciliation_snapshots WHERE snapshot_key = 'legacy-confirmed'");
    assert.deepEqual(snapshot.source, legacySource);
    assert.equal(snapshot.upstream_usd, 6);
    assert.equal(snapshot.downstream_usd, 10);
    assert.equal(snapshot.difference_usd, 4);
    assert.equal(snapshot.segment_id, segments[0].id);
  });

  await t.test("ledger backfill moves single-day settlements once and is skipped after its marker is written", async () => {
    const count = async () => Number((await pool.query("SELECT COUNT(*) AS n FROM reconciliation_ledger WHERE rule_id = 'legacy_rule'"))[0][0].n);
    assert.equal(await count(), 1);
    const entry = await reconciliation.latestLedgerEntry("legacy_rule", legacyDayWindow);
    assert.deepEqual({ ...entry, detail: undefined }, { ruleId: "legacy_rule", billDate: "2026-10-09", revision: 1, versionId: null,
      timezone: "Asia/Shanghai", startMs: LEDGER_DAY, endMs: LEDGER_DAY + 86400000, revenueUsd: 10.25, costUsd: 6.5, revenueRate: null,
      costRate: null, costBasis: null, source: "migrated", detail: undefined, settledAt: "2026-10-09T16:20:00.000Z" });
    assert.equal(entry.detail.result.calculation.profitUsd, 3.75);
    const { records } = await reconciliation.listLedgerHistory("legacy_rule", { startMs: LEDGER_DAY - 86400000, endMs: LEDGER_DAY + 86400000 });
    assert.deepEqual(records.map((record) => [record.billDate, record.settlementSource, record.calculation.profitUsd]), [["2026-10-09", "migrated", 3.75]]);
    // 多日窗口没有搬，旧快照原样保留。
    const [[week]] = await pool.query("SELECT COUNT(*) AS n FROM reconciliation_snapshots WHERE snapshot_key = ?", [legacyLedgerRows[1][0]]);
    assert.equal(Number(week.n), 1);

    // 有完成标记就不再搬：删掉账本行后重跑迁移不会补回来；标记没了才会重搬，且不重复。
    await pool.query("DELETE FROM reconciliation_ledger WHERE rule_id = 'legacy_rule'");
    await ensureSchema(pool);
    assert.equal(await count(), 0);
    await pool.query("DELETE FROM meta WHERE k = 'reconciliation_ledger_backfill_v1'");
    await ensureSchema(pool);
    await ensureSchema(pool);
    assert.equal(await count(), 1);
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

  await t.test("monitor replacement/removal uses real locked source and link CAS, rolls back and serializes empty-channel append", async () => {
    const priorCatalogue = await onboarding.getCatalogue(), ownStationId = "workflow-own";
    const catalogue = { ownStationId, sourceVersion: "workflow-source", ownSource: { namespaceKey: "workflow-ns" },
      channels: [7001, 7002, 7003].map((id) => ({ id, revision: "rev2", missing: false })) };
    const a = { ownStationId, channelId: 7001, stationId: "old-a", channelRevision: "rev1", confirmedAt: 1 };
    const b = { ...a, stationId: "keep-b" }, other = { ...a, channelId: 7002 };
    const c = { ...a, stationId: "new-c", channelRevision: "rev2", confirmedAt: 2 };
    const expectedSource = { ownStationId, sourceVersion: "workflow-source", namespaceKey: "workflow-ns",
      channels: [{ channelId: 7001, channelRevision: "rev2" }] };
    try {
      await onboarding.saveCatalogue(catalogue); await onboarding.saveLinks([a, b, other]);
      const original = await onboarding.listLinks({ ownStationId });
      let checks = 0;
      await assert.rejects(onboarding.saveLinks([c], { removals: [a], expectedLinks: original, expectedSource,
        guard: () => { if (++checks === 2) throw new Error("cancel after delete and insert"); } }), /cancel after/);
      assert.deepEqual(await onboarding.listLinks({ ownStationId }), original);
      await onboarding.saveLinks([c], { removals: [a], expectedLinks: original, expectedSource });
      const after = await onboarding.listLinks({ ownStationId });
      assert.deepEqual(after.filter((link) => link.channelId === 7001).map((link) => link.stationId), ["keep-b", "new-c"]);
      assert.deepEqual(after.find((link) => link.channelId === 7002), other);
      await assert.rejects(onboarding.saveLinks([], { removals: [b], expectedLinks: original, expectedSource }), (error) => error.code === "PREVIEW_BASIS_CHANGED");
      await onboarding.saveCatalogue({ ...catalogue, sourceVersion: "changed-source" });
      await assert.rejects(onboarding.saveLinks([], { removals: [b], expectedLinks: after, expectedSource }), (error) => error.code === "PREVIEW_BASIS_CHANGED");
      assert.deepEqual(await onboarding.listLinks({ ownStationId }), after);
      await onboarding.saveCatalogue(catalogue);
      const concurrent = await Promise.allSettled([
        onboarding.saveLinks([], { removals: [b], expectedLinks: after, expectedSource }),
        onboarding.saveLinks([], { removals: [c], expectedLinks: after, expectedSource }),
      ]);
      assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrent.find((result) => result.status === "rejected").reason.code, "PREVIEW_BASIS_CHANGED");
      const empty = { ...a, channelId: 7003, channelRevision: "rev2" };
      await Promise.all([onboarding.saveLinks([empty]), onboarding.saveLinks([{ ...empty, stationId: "second" }])]);
      assert.deepEqual((await onboarding.listLinks({ ownStationId })).filter((link) => link.channelId === 7003).map((link) => link.stationId), ["old-a", "second"]);
    } finally { await onboarding.saveCatalogue(priorCatalogue); }
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
    assert.equal(rule.billingPolicy, "immediate");
    assert.equal(rule.scopeVersion, 3);
    assert.equal(rule.provider, "newapi");
    assert.equal(rule.canonicalKey, "fixture-canonical-key");
    assert.equal(rule.costCoverage, "complete");
    assert.deepEqual(rule.sourceBinding, { 1: "r1", 2: "r2", 3: "r3" });
    assert.ok(rule.billingEffectiveFrom <= Date.now());
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
        if (++updateChecks === 2) throw Object.assign(new Error("fixture changed preview"), { code: "PREVIEW_BASIS_CHANGED" });
      } }), (error) => error.code === "PREVIEW_BASIS_CHANGED");
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

  async function ledgerRow(rule, billDate, revision, source, { profit = 4, startMs = billStart, endMs = billEnd, settledAt = "2026-10-09T00:20:00.000Z",
    revenueRate = null, costRate = null, costBasis = null } = {}) {
    const detail = savedBill({ profit, generation: settledAt });
    await pool.query(`INSERT INTO reconciliation_ledger (${RECONCILIATION_LEDGER_COLUMNS.join(", ")}) VALUES (?)`,
      [ledgerInsertValues({ ruleId: rule.id, billDate, revision, versionId: null, timezone: "UTC", startMs, endMs, revenueUsd: 10.25, costUsd: 6,
        revenueRate, costRate, costBasis, source, detail, settledAt })]);
  }

  const originalHistoryRule = await historyRule(201);
  await t.test("ledger history lists the newest revision per day with saved facts and no secrets", async () => {
    await ledgerRow(originalHistoryRule, "2026-10-08", 1, "settle", { profit: 4 });
    await ledgerRow(originalHistoryRule, "2026-10-08", 2, "resettle", { profit: -2, settledAt: "2026-10-09T03:00:00.000Z", revenueRate: 7.123456, costBasis: "usage" });
    await ledgerRow(originalHistoryRule, "2026-10-07", 1, "migrated", { profit: 0, startMs: billStart - 86400000, endMs: billStart });
    const result = await reconciliation.listLedgerHistory(originalHistoryRule.id, { startMs: billStart - 86400000, endMs: billEnd });
    assert.equal(result.nextCursor, null);
    assert.deepEqual(result.records.map((record) => [record.billDate, record.revision, record.settlementSource, record.calculation.profitUsd, record.confirmedAt]), [
      ["2026-10-08", 2, "resettle", -2, "2026-10-09T03:00:00.000Z"], ["2026-10-07", 1, "migrated", 0, "2026-10-09T00:20:00.000Z"]]);
    assert.deepEqual([result.records[0].settledRates, result.records[0].costBasis], [{ income: 7.123456, cost: null }, "usage"]);
    for (const record of result.records) {
      assert.deepEqual(record.channels.map((channel) => channel.channelId), [11, 12]);
      assert.equal(record.sourceCompleteness, "complete");
      assert.equal(record.upstreamSource.tokenName, "Original Key");
    }
    assert.deepEqual(result.records[0].window, { preset: "yesterday", startMs: billStart, endMs: billEnd, timezone: "UTC" });
    assert.equal(JSON.stringify(result).includes("fixture-history-secret"), false);
    assert.deepEqual((await reconciliation.listLedgerHistory(originalHistoryRule.id, { startMs: billStart, endMs: billEnd })).records.map((record) => record.billDate),
      ["2026-10-08"]);
  });

  await t.test("ledger history keeps original facts after member change and archive", async () => {
    const [before] = await pool.query("SELECT * FROM reconciliation_ledger WHERE rule_id = ? ORDER BY bill_date, revision", [originalHistoryRule.id]);
    await reconciliation.appendChannels(originalHistoryRule.id, [{ channelId: 204, name: "Added later" }], { costCoverage: "complete" });
    await reconciliation.archiveRule(originalHistoryRule.id);
    const result = await reconciliation.listLedgerHistory(originalHistoryRule.id, { startMs: billStart - 86400000, endMs: billEnd });
    assert.equal(result.records.length, 2);
    assert.equal(result.records.some((record) => record.channels.some((channel) => channel.channelId === 204)), false);
    assert.deepEqual(result.records[0].ownSource, historySource);
    assert.equal(result.records[0].upstreamSource.baseUrl, "https://original-upstream.fixture.invalid");
    const [after] = await pool.query("SELECT * FROM reconciliation_ledger WHERE rule_id = ? ORDER BY bill_date, revision", [originalHistoryRule.id]);
    assert.deepEqual(after, before);
    assert.equal((await reconciliation.listRules({ includeArchived: true })).some((rule) => rule.id === originalHistoryRule.id), true);
    assert.equal((await reconciliation.listRules()).some((rule) => rule.id === originalHistoryRule.id), false);
  });

  await t.test("ledger history pages a full 31-day range by day without repeats", async () => {
    const rule = await historyRule(202);
    const first = Date.UTC(2026, 8, 8);
    for (let i = 0; i < 31; i += 1) {
      const startMs = first + i * 86400000;
      await ledgerRow(rule, new Date(startMs).toISOString().slice(0, 10), 1, "settle", { profit: i, startMs, endMs: startMs + 86400000 });
    }
    const range = { startMs: first, endMs: first + 31 * 86400000 };
    const all = await reconciliation.listLedgerHistory(rule.id, { ...range, limit: 100 });
    assert.equal(all.records.length, 31); assert.equal(all.nextCursor, null);
    assert.equal(all.records[0].billDate, "2026-10-08"); assert.equal(all.records.at(-1).billDate, "2026-09-08");
    const seen = [];
    let cursor = null;
    do {
      const page = await reconciliation.listLedgerHistory(rule.id, { ...range, limit: 10, ...(cursor ? { cursor } : {}) });
      seen.push(...page.records.map((record) => record.billDate));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, all.records.map((record) => record.billDate));
    assert.equal(new Set(seen).size, 31);
  });
});

// 登录信息加密保存（db/secrets.js）走一遍真库：mysql2 把 JSON 列里的字符串标量（会话密钥）解析成不带引号的字符串，
// 密文、明文混着读，和单测里的假库不一样的地方都在这里核对。只动 stations 和 meta 里这几行，跑完删掉
test("登录信息加密保存：明文库配上密钥启动后只剩密文，重启照常读，换错密钥或没配密钥都中止且不写库，reset 后能启动", { timeout: 60000 }, async (t) => {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, charset: "utf8mb4_unicode_ci", supportBigNumbers: true });
  const META_KEYS = ["settings", "auth", "notifications", "session_secret", "billing_identity_key"];
  const clear = async () => { await pool.query("DELETE FROM stations"); await pool.query("DELETE FROM meta WHERE k IN (?)", [META_KEYS]); };
  t.after(async () => { await clear(); await pool.end(); });
  await ensureSchema(pool);
  await clear();
  const station = { id: "secret_fixture", name: "加密用例", type: "sub2api-password", baseUrl: "https://fixture.invalid", accessToken: "", apiKey: "",
    email: "fixture-mail@example.invalid", password: "fixture-password-secret", s2Tokens: { accessToken: "fixture-jwt-secret", expiresAt: 1 } };
  const notifications = { channels: [{ id: "ch_fixture", type: "telegram", name: "用例群", enabled: true, config: { botToken: "1:fixture-bot-secret", chatId: "42", apiBase: "" } }], rules: {} };
  await pool.query("INSERT INTO stations (id, pos, doc) VALUES (?, 0, ?)", [station.id, JSON.stringify(station)]);
  await pool.query("INSERT INTO meta (k, v) VALUES ?", [[["auth", JSON.stringify({ username: "admin", salt: "s", hash: "h" })],
    ["notifications", JSON.stringify(notifications)], ["session_secret", JSON.stringify("fixture-plain-session")]]]);
  const SECRETS = /fixture-mail|fixture-password-secret|fixture-jwt-secret|fixture-bot-secret|fixture-plain-session/;
  const dump = async () => JSON.stringify([(await pool.query("SELECT id, doc FROM stations"))[0],
    (await pool.query("SELECT k, v FROM meta WHERE k IN (?) ORDER BY k", [META_KEYS]))[0]]);
  const KEY_A = Buffer.alloc(32, 3).toString("base64"), KEY_B = Buffer.alloc(32, 5).toString("base64");
  const keyA = secretKeyOf(KEY_A), keyB = secretKeyOf(KEY_B);
  // 恢复脚本按部署说明那样从命令行跑；工作目录换到临时目录，免得读到仓库里的 .env
  const resetCli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("./reset-secrets.js", import.meta.url)), ...args],
    { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, RELAY_SECRET_KEY: KEY_B, RELAY_SECRET_KEY_FILE: "" } });

  // 没配密钥：照旧明文，会话密钥原样沿用；账单身份密钥生成一个，明文存着
  const plain = await new Store(pool).load();
  assert.equal(plain.sessionSecret, "fixture-plain-session");
  assert.match(await dump(), /fixture-password-secret/);
  assert.match(await dump(), new RegExp(plain.billingIdentityKey));

  const first = await new Store(pool, { secretKey: keyA }).load();
  assert.deepEqual(first.secretReport, { encrypted: true, keyId: keyA.id, converted: 4, rotated: ["session_secret"] });
  const sealed = await dump();
  assert.doesNotMatch(sealed, SECRETS);
  // 账单身份密钥第一次加密时不换新（换了库里存的账单能力就对不上了），库里只剩密文
  assert.equal(first.billingIdentityKey, plain.billingIdentityKey);
  assert.doesNotMatch(sealed, new RegExp(plain.billingIdentityKey));
  const [[row]] = await pool.query("SELECT doc FROM stations WHERE id = ?", [station.id]);
  assert.ok(isCiphertext(row.doc.password) && isCiphertext(row.doc.email) && isCiphertext(row.doc.s2Tokens));
  const [[session]] = await pool.query("SELECT v FROM meta WHERE k = 'session_secret'");
  assert.ok(isCiphertext(session.v));

  const second = await new Store(pool, { secretKey: keyA }).load();
  assert.deepEqual([second.get(station.id).password, second.get(station.id).email, second.get(station.id).s2Tokens, second.channels[0].config.botToken],
    [station.password, station.email, station.s2Tokens, "1:fixture-bot-secret"]);
  assert.equal(second.sessionSecret, first.sessionSecret);
  assert.equal(await dump(), sealed, "内容没变时沿用原来的密文");

  await assert.rejects(new Store(pool, { secretKey: keyB }).load(), (err) => err.code === "SECRET_KEY_MISMATCH");
  await assert.rejects(new Store(pool).load(), (err) => err.code === "SECRET_KEY_MISSING");
  assert.equal(await dump(), sealed, "启动中止时不写库");

  const preview = resetCli();
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /上游「加密用例」：登录密码、登录邮箱、自动登录拿到的令牌/);
  assert.match(preview.stdout, new RegExp(`编号 ${keyA.id} 的密钥加密的，现在配置的密钥编号是 ${keyB.id}`));
  assert.equal(await dump(), sealed, "不加 --yes 不改库");
  const cleared = resetCli("--yes");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /已清空下面这些解不开的登录信息/);
  const third = await new Store(pool, { secretKey: keyB }).load();
  assert.deepEqual([third.get(station.id).password, third.get(station.id).s2Tokens, third.channels[0].config.botToken, third.channels[0].config.chatId], ["", null, "", "42"]);
  assert.notEqual(third.sessionSecret, first.sessionSecret);
  const [[renewed]] = await pool.query("SELECT v FROM meta WHERE k = 'session_secret'");
  assert.ok(isCiphertext(renewed.v));
  // 账单身份密钥也是新生成、加密保存的
  const [[billingKey]] = await pool.query("SELECT v FROM meta WHERE k = 'billing_identity_key'");
  assert.ok(isCiphertext(billingKey.v));
  assert.notEqual(third.billingIdentityKey, second.billingIdentityKey);
});

test("账单能力身份版本：混合旧格式、回滚再升级、碰撞合并和事务回滚", { timeout: 60000 }, async (t) => {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, charset: "utf8mb4_unicode_ci", supportBigNumbers: true });
  const MARKER = "billing_identity_hmac_v1", key = "integration-billing-key";
  const clear = async () => { await pool.query("DELETE FROM reconciliation_billing_capabilities"); await pool.query("DELETE FROM meta WHERE k = ?", [MARKER]); };
  t.after(async () => { await clear(); await pool.end(); });
  await ensureSchema(pool);
  await clear();
  const [columns] = await pool.query("SHOW COLUMNS FROM reconciliation_billing_capabilities LIKE 'identity_scheme'");
  assert.equal(columns[0].Default, "legacy", "旧二进制不带新列的 INSERT 仍能运行并被下次启动识别");
  const digests = ["a1", "b2", "c3"].map((seed) => createHash("sha256").update(seed).digest("hex"));
  const cap = (verifiedAt) => ({ state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason: "RUNTIME_FILTERS_VERIFIED" });
  const oldHmac = createHmac("sha256", key).update(digests[1]).digest("hex");
  const wrap = (digest) => wrappedBillingIdentity(key, digest);
  const insertLegacy = (identity, at) => pool.query("INSERT INTO reconciliation_billing_capabilities (identity, capability, verified_at) VALUES (?, ?, ?)",
    [identity, JSON.stringify(cap(at)), at]);
  await insertLegacy(digests[0], 1000);
  await insertLegacy(oldHmac, 2000);
  const repository = new ReconciliationRepository(pool);
  await repository.saveBillingCapability(wrap(digests[2]), cap(2500));
  assert.deepEqual(await rehashBillingCapabilities(pool, key), { migrated: 2, skipped: false, invalid: 0 });
  const storage = createBillingCapabilityStorage(repository, { key });
  assert.deepEqual(await storage.get(digests[0]), cap(1000));
  assert.deepEqual(await storage.get(digests[1]), cap(2000));
  assert.deepEqual(await storage.get(digests[2]), cap(2500));
  const rows = async () => (await pool.query("SELECT identity, capability, verified_at AS verifiedAt, identity_scheme FROM reconciliation_billing_capabilities ORDER BY identity"))[0]
    .map((r) => [r.identity, r.capability, Number(r.verifiedAt), r.identity_scheme]);
  assert.ok((await rows()).every((r) => r[3] === "wrapped-v2"));
  assert.ok(!(await rows()).some((r) => [digests[0], oldHmac].includes(r[0])));
  assert.equal((await pool.query("SELECT k FROM meta WHERE k = ?", [MARKER]))[0].length, 1, "即使只有新包装行也必须写旧迁移栅栏");
  const once = await rows();
  assert.deepEqual(await rehashBillingCapabilities(pool, key), { migrated: 0, skipped: true, invalid: 0 });
  assert.deepEqual(await rows(), once, "不二次包装");
  // 已有全局 marker，旧二进制又按默认 legacy 写回 SHA；再次升级必须扫描并合并，保留较新的整组值。
  await insertLegacy(digests[0], 3000);
  assert.deepEqual(await rehashBillingCapabilities(pool, key), { migrated: 1, skipped: false, invalid: 0 });
  assert.deepEqual(await storage.get(digests[0]), cap(3000));
  await insertLegacy(digests[0], 500);
  await rehashBillingCapabilities(pool, key);
  assert.deepEqual(await storage.get(digests[0]), cap(3000), "较旧 legacy 不覆盖新核验结果");
  const [[kept]] = await pool.query("SELECT verified_at AS verifiedAt FROM reconciliation_billing_capabilities WHERE identity = ?", [wrap(digests[0])]);
  assert.equal(Number(kept.verifiedAt), 3000, "核验时间那一列也没被改成较旧的");
  // 两个历史别名都存在时删除必须一次移除，不能从另一个别名复活。
  await repository.saveBillingCapability(billingCapabilityAliases(key, digests[1])[0], cap(4000));
  await storage.delete(digests[1]);
  assert.equal(await storage.get(digests[1]), null);
  // 首行已 upsert 后发生异常也不能留下半次迁移。
  await insertLegacy(digests[0], 5000);
  const before = await rows();
  const broken = { async getConnection() {
    const conn = await pool.getConnection();
    return { beginTransaction: () => conn.beginTransaction(), commit: () => conn.commit(), rollback: () => conn.rollback(), release: () => conn.release(),
      query: (sql, params) => {
        if (sql.startsWith("DELETE FROM reconciliation_billing_capabilities")) throw new Error("synthetic migration interruption");
        return conn.query(sql, params);
      } };
  } };
  await assert.rejects(rehashBillingCapabilities(broken, key), /synthetic/);
  assert.deepEqual(await rows(), before);
  await rehashBillingCapabilities(pool, key);
  assert.deepEqual(await storage.get(digests[0]), cap(5000));
});

test("账单能力身份版本：S3 的三列旧表带数据升级；格式不对的行跳过、不挡启动；回滚期间旧程序删不到新格式的行，换回后下一次作废一起删掉", { timeout: 60000 }, async (t) => {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, charset: "utf8mb4_unicode_ci", supportBigNumbers: true });
  const MARKER = "billing_identity_hmac_v1", key = "integration-billing-key-s3-table";
  const clear = async () => { await pool.query("DELETE FROM reconciliation_billing_capabilities"); await pool.query("DELETE FROM meta WHERE k = ?", [MARKER]); };
  // 中途失败也把列加回来，后面的契约用例要用
  t.after(async () => { await ensureSchema(pool); await clear(); await pool.end(); });
  await ensureSchema(pool);
  await clear();
  const cap = (verifiedAt) => ({ state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason: "RUNTIME_FILTERS_VERIFIED" });
  const [d1, d2] = ["s3-era", "rollback"].map((seed) => createHash("sha256").update(seed).digest("hex"));
  const s3Identity = (digest) => createHmac("sha256", key).update(digest).digest("hex");
  // S3 的表只有三列；S3 程序写的是 HMAC(key, D)，再放一行格式不对的
  await pool.query("ALTER TABLE reconciliation_billing_capabilities DROP COLUMN identity_scheme");
  const insertOld = (identity, at) => pool.query("INSERT INTO reconciliation_billing_capabilities (identity, capability, verified_at) VALUES (?, ?, ?)",
    [identity, JSON.stringify(cap(at)), at]);
  await insertOld(s3Identity(d1), 1000);
  await insertOld("not-a-digest", 900);
  // 能力那一列被手改成 JSON 字符串：驱动读出来是字符串，原样写回会报 ER_INVALID_JSON_TEXT
  await pool.query("INSERT INTO reconciliation_billing_capabilities (identity, capability, verified_at) VALUES (?, JSON_QUOTE('x'), 950)",
    [createHash("sha256").update("json-string").digest("hex")]);
  await ensureSchema(pool);
  assert.deepEqual(await rehashBillingCapabilities(pool, key), { migrated: 1, skipped: false, invalid: 2 });
  const repository = new ReconciliationRepository(pool), storage = createBillingCapabilityStorage(repository, { key });
  assert.deepEqual(await storage.get(d1), cap(1000), "S3 存的能力升级后照常读到");
  const [[bad]] = await pool.query("SELECT identity_scheme FROM reconciliation_billing_capabilities WHERE identity = 'not-a-digest'");
  assert.equal(bad.identity_scheme, "legacy", "格式不对的行留在原处");
  // 新程序写过 W(D2)；回滚到 S3：旧程序按 HMAC(key, D2) 读写，核验通过写一行，之后作废也只删得到它自己那行
  await storage.set(d2, cap(2000));
  await insertOld(s3Identity(d2), 3000);
  await pool.query("DELETE FROM reconciliation_billing_capabilities WHERE identity = ?", [s3Identity(d2)]);
  // 换回新程序：没有要包装的行，W(D2) 又读得到（deploy/README.md 写明的限制）……
  assert.deepEqual(await rehashBillingCapabilities(pool, key), { migrated: 0, skipped: true, invalid: 2 });
  assert.deepEqual(await storage.get(d2), cap(2000));
  // ……直到下一次作废，两种存法一起删
  await storage.delete(d2);
  assert.equal(await storage.get(d2), null);
  assert.deepEqual(await storage.get(d1), cap(1000));
});

// 与 server/reconciliation-repository.contract.test.js 同一组用例：内存实现和 MySQL 必须表现一致。
// 放在迁移用例之后定义，node:test 按顺序执行，届时表结构已是最新版。
const contractPool = mysql.createPool({ host: process.env.DB_HOST, port,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  connectionLimit: 4, charset: "utf8mb4_unicode_ci", supportBigNumbers: true });
let contractSchemaReady = null;
defineReconciliationRepositoryContract({
  name: "MySQL 8",
  create: async () => {
    contractSchemaReady ||= ensureSchema(contractPool);
    await contractSchemaReady;
    return new ReconciliationRepository(contractPool);
  },
  cleanup: async ({ ruleIds, capabilityIdentities }) => {
    if (capabilityIdentities.length) {
      await contractPool.query("DELETE FROM reconciliation_billing_capabilities WHERE identity IN (?)", [capabilityIdentities]);
    }
    if (!ruleIds.length) return;
    for (const table of ["reconciliation_alert_state", "reconciliation_snapshots", "reconciliation_ledger", "reconciliation_rule_segments",
      "reconciliation_rule_channels"]) await contractPool.query(`DELETE FROM ${table} WHERE rule_id IN (?)`, [ruleIds]);
    await contractPool.query("DELETE FROM reconciliation_rules WHERE id IN (?)", [ruleIds]);
  },
  inspectSnapshot: async ({ ruleId, snapshotKey }) => {
    const [[row]] = await contractPool.query(`SELECT segment_id AS segmentId, window_kind AS windowKind, window_start_ms AS windowStartMs,
      window_end_ms AS windowEndMs, upstream_usd AS upstreamUsd, health_code AS healthCode, health_detail AS healthDetail
      FROM reconciliation_snapshots WHERE rule_id = ? AND snapshot_key = ?`, [ruleId, snapshotKey]);
    return row ? { ...row, windowStartMs: Number(row.windowStartMs), windowEndMs: Number(row.windowEndMs) } : null;
  },
  teardown: () => contractPool.end(),
});
