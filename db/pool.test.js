import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "./pool.js";

const DAY = 86400000;
const START = Date.UTC(2026, 9, 8, 16);

function schemaPool({ columns = [], indexes = [], meta = [], snapshots = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT k FROM meta")) return [meta.includes(params[0]) ? [{ k: params[0] }] : []];
      if (sql.includes("FROM reconciliation_snapshots")) return [snapshots];
      if (sql.startsWith("INSERT INTO meta")) meta.push(params[0]);
      if (sql.includes("information_schema.COLUMNS")) {
        return [columns.includes(params[1]) ? [{}] : []];
      }
      if (sql.includes("information_schema.STATISTICS")) {
        return [indexes.includes(params[1]) ? [{}] : []];
      }
      if (sql.startsWith("ALTER TABLE") && sql.includes(" ADD COLUMN ")) columns.push(sql.split(" ")[5]);
      if (sql.startsWith("ALTER TABLE") && sql.includes(" ADD INDEX ")) indexes.push(sql.split(" ")[5]);
      return [[]];
    },
  };
}

test("对账 schema 缺列或索引时使用 MySQL 8 兼容的普通 ALTER", async () => {
  const pool = schemaPool();
  await ensureSchema(pool);
  const alters = pool.calls.map((call) => call.sql).filter((sql) => sql.startsWith("ALTER TABLE"));
  assert.deepEqual(alters, [
    "ALTER TABLE reconciliation_rule_channels ADD COLUMN channel_status VARCHAR(24) NULL",
    "ALTER TABLE reconciliation_rule_channels ADD COLUMN status_observed_at_ms BIGINT NULL",
    "ALTER TABLE reconciliation_rule_channels ADD COLUMN status_changed_at_ms BIGINT NULL",
    "ALTER TABLE reconciliation_snapshots ADD COLUMN segment_id VARCHAR(32) NULL",
    "ALTER TABLE reconciliation_rule_segments ADD COLUMN ratio_observed_at_ms BIGINT NULL",
    "ALTER TABLE reconciliation_rule_segments ADD COLUMN ratio_source VARCHAR(24) NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN billing_policy VARCHAR(32) NOT NULL DEFAULT 'legacy-v3'",
    "ALTER TABLE reconciliation_rules ADD COLUMN scope_version BIGINT NOT NULL DEFAULT 1",
    "ALTER TABLE reconciliation_rules ADD COLUMN billing_effective_from_ms BIGINT NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN cost_coverage VARCHAR(24) NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE reconciliation_rules ADD COLUMN provider VARCHAR(24) NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN canonical_key VARCHAR(255) NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN source_binding JSON NULL",
    "ALTER TABLE reconciliation_snapshots ADD INDEX idx_reconciliation_snapshot_segment (segment_id)",
  ]);
  assert.equal(alters.some((sql) => sql.includes("IF NOT EXISTS")), false);
});

test("对账 schema 已具备列和索引时不重复执行 ALTER", async () => {
  const pool = schemaPool({
    columns: ["channel_status", "status_observed_at_ms", "status_changed_at_ms", "segment_id", "ratio_observed_at_ms", "ratio_source",
      "billing_policy", "scope_version", "billing_effective_from_ms", "cost_coverage", "provider", "canonical_key", "source_binding"],
    indexes: ["idx_reconciliation_snapshot_segment"],
  });
  await ensureSchema(pool);
  assert.equal(pool.calls.some((call) => call.sql.startsWith("ALTER TABLE")), false);
});

test("新关联迁移可重跑且旧规则不切换自然日策略", async () => {
  const pool = schemaPool();
  await ensureSchema(pool);
  const firstAlters = pool.calls.filter((call) => call.sql.startsWith("ALTER TABLE")).length;
  await ensureSchema(pool);
  assert.equal(pool.calls.filter((call) => call.sql.startsWith("ALTER TABLE")).length, firstAlters);
  const links = pool.calls.find((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS channel_monitor_links"));
  assert.ok(links.sql.includes("PRIMARY KEY (own_station_id, channel_id, station_id)"));
  assert.equal(links.sql.includes("token"), false);
  assert.equal(pool.calls.some((call) => /UPDATE reconciliation_rules/.test(call.sql)), false);
});

function confirmedRow(ruleId, { startMs = START, generatedAt = new Date(START + DAY + 20 * 60000).toISOString() } = {}) {
  const window = { preset: "yesterday", timezone: "Asia/Shanghai", startMs, endMs: startMs + DAY };
  return { rule_id: ruleId, health_code: "READY", source: JSON.stringify({ calculationVersion: 3, billingSource: "channel-log-stat",
    recordType: "confirmed", window, resultGeneratedAt: generatedAt,
    result: { window, generatedAt, upstream: { amountUsd: 7 }, downstream: { amountUsd: 10 },
      calculation: { differenceUsd: 3, profitUsd: 3, marginRate: 0.3 }, health: { code: "READY" } } }) };
}

test("结账账本首次升级时搬入旧的单日结账记录并写完成标记，之后不再重搬", async () => {
  const pool = schemaPool({ snapshots: [confirmedRow("r1"), confirmedRow("r1", { generatedAt: new Date(START + DAY + 60000).toISOString() }),
    confirmedRow("r2", { startMs: START - DAY })] });
  await ensureSchema(pool);
  const select = pool.calls.find((call) => call.sql.includes("FROM reconciliation_snapshots"));
  assert.match(select.sql, /snapshot_key LIKE 'r3:c:%'/);
  const inserts = pool.calls.filter((call) => call.sql.startsWith("INSERT IGNORE INTO reconciliation_ledger"));
  assert.deepEqual(inserts.map((call) => call.params.slice(0, 3)), [["r1", "2026-10-09", 1], ["r2", "2026-10-08", 1]]);
  assert.ok(inserts.every((call) => call.params[12] === "migrated"));
  const marker = pool.calls.find((call) => call.sql.startsWith("INSERT INTO meta"));
  assert.equal(marker.params[0], "reconciliation_ledger_backfill_v1");
  assert.equal(JSON.parse(marker.params[1]).migrated, 2);
  assert.ok(pool.calls.indexOf(marker) > pool.calls.indexOf(inserts.at(-1)));

  const before = pool.calls.length;
  await ensureSchema(pool);
  const rerun = pool.calls.slice(before);
  assert.equal(rerun.some((call) => call.sql.includes("FROM reconciliation_snapshots") || call.sql.includes("INTO reconciliation_ledger")), false);
});

test("结账账本表以 (关联, 日期, 版本) 为主键", async () => {
  const pool = schemaPool();
  await ensureSchema(pool);
  const ledger = pool.calls.find((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS reconciliation_ledger"));
  assert.ok(ledger.sql.includes("PRIMARY KEY (rule_id, bill_date, revision)"));
  assert.ok(pool.calls.indexOf(ledger) < pool.calls.findIndex((call) => call.sql.startsWith("SELECT k FROM meta")));
});
