import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureSchema } from "./pool.js";
import { ChannelOnboardingRepository } from "../server/channel-onboarding-repository.js";
import { ReconciliationRepository } from "../server/reconciliation-repository.js";
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
});
