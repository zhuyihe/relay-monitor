import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "./pool.js";

function schemaPool({ columns = [], indexes = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("information_schema.COLUMNS")) {
        return [columns.includes(params[1]) ? [{}] : []];
      }
      if (sql.includes("information_schema.STATISTICS")) {
        return [indexes.includes(params[1]) ? [{}] : []];
      }
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
    "ALTER TABLE reconciliation_snapshots ADD INDEX idx_reconciliation_snapshot_segment (segment_id)",
  ]);
  assert.equal(alters.some((sql) => sql.includes("IF NOT EXISTS")), false);
});

test("对账 schema 已具备列和索引时不重复执行 ALTER", async () => {
  const pool = schemaPool({
    columns: ["channel_status", "status_observed_at_ms", "status_changed_at_ms", "segment_id", "ratio_observed_at_ms", "ratio_source"],
    indexes: ["idx_reconciliation_snapshot_segment"],
  });
  await ensureSchema(pool);
  assert.equal(pool.calls.some((call) => call.sql.startsWith("ALTER TABLE")), false);
});
