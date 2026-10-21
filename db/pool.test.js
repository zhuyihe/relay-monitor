import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, rehashBillingCapabilities } from "./pool.js";

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

test("搬旧账失败不挡启动：单行失败照搬其余行、不写完成标记，下次启动重试；读旧记录失败同样只记日志", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const pool = schemaPool({ snapshots: [confirmedRow("r1"), confirmedRow("r2")] });
  const query = pool.query;
  let failR1 = true;
  pool.query = async (sql, params) => {
    if (failR1 && sql.startsWith("INSERT IGNORE INTO reconciliation_ledger") && params[0] === "r1") {
      pool.calls.push({ sql, params });
      throw new Error("Out of range value for column 'revenue_usd'");
    }
    return query(sql, params);
  };
  await ensureSchema(pool);
  const inserted = () => pool.calls.filter((call) => call.sql.startsWith("INSERT IGNORE INTO reconciliation_ledger")).map((call) => call.params[0]);
  assert.deepEqual(inserted(), ["r1", "r2"]);
  assert.equal(pool.calls.some((call) => call.sql.startsWith("INSERT INTO meta")), false);
  assert.ok(logged.some((line) => line.includes("r1") && line.includes("Out of range")));

  failR1 = false;
  await ensureSchema(pool);
  assert.deepEqual(inserted(), ["r1", "r2", "r1", "r2"]);
  assert.equal(JSON.parse(pool.calls.find((call) => call.sql.startsWith("INSERT INTO meta")).params[1]).migrated, 2);

  const broken = schemaPool();
  const brokenQuery = broken.query;
  broken.query = async (sql, params) => {
    if (sql.includes("FROM reconciliation_snapshots")) throw new Error("Lock wait timeout exceeded");
    return brokenQuery(sql, params);
  };
  await ensureSchema(broken);
  assert.equal(broken.calls.some((call) => call.sql.startsWith("INSERT INTO meta")), false);
  assert.ok(logged.some((line) => line.includes("Lock wait timeout")));
});

test("结账账本表以 (关联, 日期, 版本) 为主键", async () => {
  const pool = schemaPool();
  await ensureSchema(pool);
  const ledger = pool.calls.find((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS reconciliation_ledger"));
  assert.ok(ledger.sql.includes("PRIMARY KEY (rule_id, bill_date, revision)"));
  assert.ok(pool.calls.indexOf(ledger) < pool.calls.findIndex((call) => call.sql.startsWith("SELECT k FROM meta")));
});

// 账单能力表身份改 HMAC 的一次性迁移：事务里的读写都走 conn；commit 才落下
function capabilityPool({ identities = [], marker = false, failOn = null } = {}) {
  const db = { identities: [...identities], marker }, calls = [];
  let draft;
  const conn = {
    beginTransaction: async () => { draft = { identities: [...db.identities], marker: db.marker }; },
    async query(sql, params = []) {
      calls.push(sql);
      if (failOn && sql.startsWith(failOn)) throw Object.assign(new Error("synthetic"), { code: "ER_LOCK_DEADLOCK" });
      if (sql.startsWith("SELECT k FROM meta")) return [draft.marker ? [{ k: params[0] }] : []];
      if (sql.startsWith("SELECT identity FROM reconciliation_billing_capabilities")) return [draft.identities.map((identity) => ({ identity }))];
      if (sql.startsWith("UPDATE reconciliation_billing_capabilities")) draft.identities = draft.identities.map((id) => (id === params[1] ? params[0] : id));
      if (sql.startsWith("INSERT INTO meta")) draft.marker = true;
      return [[]];
    },
    commit: async () => { db.identities = draft.identities; db.marker = draft.marker; calls.push("COMMIT"); },
    rollback: async () => { calls.push("ROLLBACK"); },
    release: () => {},
  };
  return { db, calls, getConnection: async () => conn };
}

test("账单能力表的身份改 HMAC：每一行原地改一次，和完成标记一起提交；有标记就不再改", async () => {
  const pool = capabilityPool({ identities: ["a".repeat(64), "b".repeat(64)] });
  const rehash = (digest) => `h(${digest.slice(0, 1)})`;
  assert.deepEqual(await rehashBillingCapabilities(pool, rehash), { migrated: 2, skipped: false });
  assert.deepEqual(pool.db.identities, ["h(a)", "h(b)"]);
  assert.equal(pool.db.marker, true);
  assert.equal(pool.calls.at(-1), "COMMIT");
  pool.calls.length = 0;
  assert.deepEqual(await rehashBillingCapabilities(pool, rehash), { migrated: 0, skipped: true });
  assert.deepEqual(pool.db.identities, ["h(a)", "h(b)"]);
  assert.equal(pool.calls.some((sql) => sql.startsWith("UPDATE")), false);
  // 空表也写标记，以后 S3 之前的版本回滚期间写下的行不再改
  const empty = capabilityPool();
  assert.deepEqual(await rehashBillingCapabilities(empty, rehash), { migrated: 0, skipped: false });
  assert.equal(empty.db.marker, true);
});

test("账单能力表的身份改 HMAC：中途出错整体回滚、不写标记、抛错挡住启动，下次启动从头再来", async () => {
  const pool = capabilityPool({ identities: ["a".repeat(64), "b".repeat(64)], failOn: "INSERT INTO meta" });
  await assert.rejects(rehashBillingCapabilities(pool, (digest) => `h(${digest.slice(0, 1)})`), { code: "ER_LOCK_DEADLOCK" });
  assert.deepEqual(pool.db, { identities: ["a".repeat(64), "b".repeat(64)], marker: false });
  assert.equal(pool.calls.at(-1), "ROLLBACK");
});
