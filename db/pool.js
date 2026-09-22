// MySQL 连接池（mysql2/promise）。连接参数来自环境变量，见 .env.example
import mysql from "mysql2/promise";

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
}
