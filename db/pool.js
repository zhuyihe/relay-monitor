// MySQL 连接池（mysql2/promise）。连接参数来自环境变量，见 .env.example
import mysql from "mysql2/promise";
import { RECONCILIATION_LEDGER_COLUMNS, ledgerInsertValues, migratedLedgerEntries } from "../lib/reconciliation-ledger.js";

let _pool = null;

async function hasColumn(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasIndex(db, table, index) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(db, table, column, definition) {
  if (await hasColumn(db, table, column)) return;
  try {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (err?.code !== "ER_DUP_FIELDNAME" || !(await hasColumn(db, table, column))) throw err;
  }
}

async function addIndexIfMissing(db, table, index, definition) {
  if (await hasIndex(db, table, index)) return;
  try {
    await db.query(`ALTER TABLE ${table} ADD INDEX ${index} ${definition}`);
  } catch (err) {
    if (err?.code !== "ER_DUP_KEYNAME" || !(await hasIndex(db, table, index))) throw err;
  }
}

export function getPool() {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "relay",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "relay_monitor",
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4_unicode_ci",
    // JSON 列自动解析；BIGINT 时间戳按 Number 返回（2^53 内安全）
    supportBigNumbers: true,
  });
  return _pool;
}

// 建表（幂等）。JSON 文档列保持与 v1 数据形状 1:1，回归风险最低；
// history_points 落成关系行，供经营分析 SQL 聚合。
export async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS stations (
    id VARCHAR(32) PRIMARY KEY,
    pos INT NOT NULL DEFAULT 0,
    doc JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS meta (
    k VARCHAR(64) PRIMARY KEY,
    v JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_monitor_links (
    own_station_id VARCHAR(32) NOT NULL,
    channel_id BIGINT NOT NULL,
    station_id VARCHAR(32) NOT NULL,
    channel_revision VARCHAR(128) NOT NULL,
    confirmed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (own_station_id, channel_id, station_id),
    INDEX idx_channel_monitor_station (station_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS history_points (
    station_id VARCHAR(32) NOT NULL,
    t BIGINT NOT NULL,
    remaining DOUBLE NOT NULL,
    used DOUBLE NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, t),
    INDEX idx_t (t)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 原始快照是长期事实来源；日汇总只用于成本分析查询加速。
  // 保留 DATE 类型，查询时统一 DATE_FORMAT 为 YYYY-MM-DD，避免时区隐式转换。
  await pool.query(`CREATE TABLE IF NOT EXISTS station_daily_usage (
    station_id VARCHAR(32) NOT NULL,
    date DATE NOT NULL,
    used_usd DOUBLE NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (station_id, date),
    INDEX idx_date (date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 上游渠道对账：规则、规则下的本站渠道、聚合快照与独立告警状态。
  // 凭据继续只保存在既有 stations.doc；此处不复制 PAT 或 API Key。
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_rules (
    id VARCHAR(32) PRIMARY KEY,
    upstream_station_id VARCHAR(32) NOT NULL,
    own_station_id VARCHAR(32) NOT NULL,
    token_id BIGINT NOT NULL,
    token_name VARCHAR(160) NOT NULL,
    fixed_group VARCHAR(160) NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    enabled TINYINT NOT NULL DEFAULT 1,
    active_token_key VARCHAR(255) NULL,
    archived_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_reconciliation_upstream (upstream_station_id, token_id),
    INDEX idx_reconciliation_enabled (enabled, archived_at),
    UNIQUE KEY uq_reconciliation_active_token (active_token_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_rule_channels (
    rule_id VARCHAR(32) NOT NULL,
    channel_id BIGINT NOT NULL,
    channel_name VARCHAR(160) NOT NULL,
    active_channel_key VARCHAR(96) NULL,
    channel_status VARCHAR(24) NULL,
    status_observed_at_ms BIGINT NULL,
    status_changed_at_ms BIGINT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (rule_id, channel_id),
    INDEX idx_reconciliation_channel (channel_id),
    UNIQUE KEY uq_reconciliation_active_channel (active_channel_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_rule_segments (
    id VARCHAR(32) PRIMARY KEY,
    rule_id VARCHAR(32) NOT NULL,
    group_name VARCHAR(160) NOT NULL,
    group_ratio DOUBLE NULL,
    ratio_observed_at_ms BIGINT NULL,
    ratio_source VARCHAR(24) NULL,
    effective_from_ms BIGINT NOT NULL,
    effective_to_ms BIGINT NULL,
    detected_at_ms BIGINT NOT NULL,
    timing_source VARCHAR(24) NOT NULL DEFAULT 'detected',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_reconciliation_segment_rule (rule_id, effective_from_ms),
    INDEX idx_reconciliation_segment_open (rule_id, effective_to_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    rule_id VARCHAR(32) NOT NULL,
    snapshot_key VARCHAR(128) NOT NULL,
    window_kind VARCHAR(24) NOT NULL,
    window_start_ms BIGINT NOT NULL,
    window_end_ms BIGINT NOT NULL,
    local_date DATE NULL,
    upstream_quota DOUBLE NULL,
    upstream_quota_per_unit DOUBLE NULL,
    upstream_usd DOUBLE NULL,
    downstream_quota DOUBLE NULL,
    downstream_quota_per_unit DOUBLE NULL,
    downstream_usd DOUBLE NULL,
    difference_usd DOUBLE NULL,
    margin_rate DOUBLE NULL,
    coverage DOUBLE NULL,
    health_code VARCHAR(64) NOT NULL,
    health_detail VARCHAR(300) NULL,
    source JSON NULL,
    segment_id VARCHAR(32) NULL,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_reconciliation_snapshot (rule_id, snapshot_key),
    INDEX idx_reconciliation_snapshot_window (window_start_ms, window_end_ms)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // MySQL 8 has no ALTER TABLE ... ADD ... IF NOT EXISTS. Probe schema facts
  // first, then use ordinary ALTER syntax so repeated startup is safe.
  await addColumnIfMissing(pool, "reconciliation_rule_channels", "channel_status", "VARCHAR(24) NULL");
  await addColumnIfMissing(pool, "reconciliation_rule_channels", "status_observed_at_ms", "BIGINT NULL");
  await addColumnIfMissing(pool, "reconciliation_rule_channels", "status_changed_at_ms", "BIGINT NULL");
  await addColumnIfMissing(pool, "reconciliation_snapshots", "segment_id", "VARCHAR(32) NULL");
  await addColumnIfMissing(pool, "reconciliation_rule_segments", "ratio_observed_at_ms", "BIGINT NULL");
  await addColumnIfMissing(pool, "reconciliation_rule_segments", "ratio_source", "VARCHAR(24) NULL");
  // Existing rules retain their original billing policy until a real scope edit.
  await addColumnIfMissing(pool, "reconciliation_rules", "billing_policy", "VARCHAR(32) NOT NULL DEFAULT 'legacy-v3'");
  await addColumnIfMissing(pool, "reconciliation_rules", "scope_version", "BIGINT NOT NULL DEFAULT 1");
  await addColumnIfMissing(pool, "reconciliation_rules", "billing_effective_from_ms", "BIGINT NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "cost_coverage", "VARCHAR(24) NOT NULL DEFAULT 'unknown'");
  await addColumnIfMissing(pool, "reconciliation_rules", "provider", "VARCHAR(24) NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "canonical_key", "VARCHAR(255) NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "source_binding", "JSON NULL");
  await addIndexIfMissing(pool, "reconciliation_snapshots", "idx_reconciliation_snapshot_segment", "(segment_id)");
  // Legacy rules get exactly one open segment. The deterministic 32-byte ID
  // fits this table even if a historic rule ID used its full column width.
  // We deliberately do not invent old transitions or ratios that facts cannot prove.
  await pool.query(`INSERT INTO reconciliation_rule_segments
    (id, rule_id, group_name, group_ratio, effective_from_ms, effective_to_ms, detected_at_ms, timing_source)
    SELECT CONCAT('ls_', LEFT(MD5(r.id), 29)), r.id, r.fixed_group, NULL, 0, NULL,
      UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, 'legacy'
    FROM reconciliation_rules r
    WHERE NOT EXISTS (SELECT 1 FROM reconciliation_rule_segments s WHERE s.rule_id = r.id)`);
  await pool.query(`UPDATE reconciliation_snapshots s
    JOIN reconciliation_rule_segments g ON g.rule_id = s.rule_id
    SET s.segment_id = g.id
    WHERE s.segment_id IS NULL AND g.timing_source = 'legacy'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_alert_state (
    rule_id VARCHAR(32) NOT NULL,
    event_code VARCHAR(64) NOT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    first_seen_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    last_notified_at BIGINT NULL,
    recovered_at BIGINT NULL,
    PRIMARY KEY (rule_id, event_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Sub2API 账单过滤能力核验结果；identity 是上游连接身份的 sha256，不含可还原的凭据。
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_billing_capabilities (
    identity CHAR(64) NOT NULL PRIMARY KEY,
    capability JSON NOT NULL,
    verified_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 结账账本：每条核算关联、每个已结束的自然日一行，只插入不更新；重新结账写 revision + 1。
  // 金额是系统原值（美元）；汇率和成本计法为空表示结账时没有记录，读取时按当前配置。version_id 留给第 6 阶段的关联版本。
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_ledger (
    rule_id VARCHAR(32) NOT NULL,
    bill_date DATE NOT NULL,
    revision INT NOT NULL,
    version_id VARCHAR(32) NULL,
    timezone VARCHAR(64) NOT NULL,
    window_start_ms BIGINT NOT NULL,
    window_end_ms BIGINT NOT NULL,
    revenue_usd DECIMAL(20,8) NOT NULL,
    cost_usd DECIMAL(20,8) NULL,
    revenue_rate DECIMAL(12,6) NULL,
    cost_rate DECIMAL(12,6) NULL,
    cost_basis VARCHAR(16) NULL,
    source VARCHAR(24) NOT NULL,
    detail JSON NULL,
    settled_at DATETIME(3) NOT NULL,
    PRIMARY KEY (rule_id, bill_date, revision)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 搬旧账失败不挡启动：记日志、不写完成标记，下次启动重试。
  try { await backfillReconciliationLedger(pool); } catch (err) { console.error("  结账账本迁移旧账失败，下次启动重试:", err?.message); }
}

const LEDGER_BACKFILL_META_KEY = "reconciliation_ledger_backfill_v1";

// 只在首次升级时把旧的单日结账记录搬进账本一次（revision 1、source=migrated）；
// 有行没搬成就不写标记，下次启动重跑，INSERT IGNORE 跳过已搬的行。单行失败不挡其余行。
async function backfillReconciliationLedger(pool) {
  const [markers] = await pool.query("SELECT k FROM meta WHERE k = ?", [LEDGER_BACKFILL_META_KEY]);
  if (markers.length) return;
  const [rows] = await pool.query(
    "SELECT rule_id, health_code, source FROM reconciliation_snapshots WHERE snapshot_key LIKE 'r3:c:%' AND window_kind NOT IN ('today', '7d', 'month')"
  );
  const entries = migratedLedgerEntries(rows);
  let failed = 0;
  for (const entry of entries) {
    try {
      await pool.query(
        `INSERT IGNORE INTO reconciliation_ledger (${RECONCILIATION_LEDGER_COLUMNS.join(", ")}) VALUES (${RECONCILIATION_LEDGER_COLUMNS.map(() => "?").join(", ")})`,
        ledgerInsertValues(entry)
      );
    } catch (err) {
      failed += 1;
      console.error(`  结账账本迁移旧账失败（关联 ${entry.ruleId} · ${entry.billDate}），下次启动重试:`, err?.message);
    }
  }
  if (failed) return;
  await pool.query(
    "INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
    [LEDGER_BACKFILL_META_KEY, JSON.stringify({ completedAt: new Date().toISOString(), migrated: entries.length })]
  );
}
