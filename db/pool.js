// MySQL 连接池（mysql2/promise）。连接参数来自环境变量，见 .env.example
import mysql from "mysql2/promise";
import { RECONCILIATION_LEDGER_COLUMNS, ledgerInsertValues, migratedLedgerEntries } from "../lib/reconciliation-ledger.js";
import { SEGMENT_KEYS_TABLE_SQL, refreshSegmentKeysSql } from "./segment-keys.js";
import { BILLING_CAPABILITY_IDENTITY_SCHEME, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME, wrapLegacyBillingIdentity } from "../lib/billing-capability-storage.js";

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
  // 合并重复上游（K1a）：一次合并改了什么、旧值是什么，一行一件事；回滚（db/k-unmerge.js）照这张表改回
  await pool.query(`CREATE TABLE IF NOT EXISTS upstream_merge_log (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    merge_id VARCHAR(32) NOT NULL,
    merged_at_ms BIGINT NOT NULL,
    retained_id VARCHAR(32) NOT NULL,
    merged_id VARCHAR(32) NULL,
    kind VARCHAR(24) NOT NULL,
    detail JSON NOT NULL,
    undone_at_ms BIGINT NULL,
    INDEX idx_upstream_merge_log_merge (merge_id, id)
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
  // 解除时刻（毫秒，由进程写）。archived_at 是 NOW() 写的 DATETIME，进程和 MySQL 时区不同时会偏（计划 C3 4.2）；旧行按 archived_at 回填一次
  await addColumnIfMissing(pool, "reconciliation_rules", "archived_at_ms", "BIGINT NULL");
  // 核算起点的下限（毫秒）：同一天里更早解除了一条占着同一个渠道（或同一把 Key）的 New API 绑定时，新绑定从那一刻起算，不从 0 点，免得重叠算两遍（C3）
  await addColumnIfMissing(pool, "reconciliation_rules", "accounting_floor_ms", "BIGINT NULL");
  await pool.query("UPDATE reconciliation_rules SET archived_at_ms = UNIX_TIMESTAMP(archived_at) * 1000 WHERE archived_at IS NOT NULL AND archived_at_ms IS NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "cost_coverage", "VARCHAR(24) NOT NULL DEFAULT 'unknown'");
  await addColumnIfMissing(pool, "reconciliation_rules", "provider", "VARCHAR(24) NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "canonical_key", "VARCHAR(255) NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "source_binding", "JSON NULL");
  // K2b：这条绑定的 Key 现在有没处理的事——分组/合组（KEY_GROUP_CHANGED）、渠道换成了不在已加上游里的 Key
  // （CHANNEL_KEY_UNMATCHED）、打码撞了又没有读完整 Key 的权限（KEY_REVEAL_DENIED）——第一次认出来的时刻（毫秒），
  // 跨轮记下来，重启不丢。早退只挡从这一刻起的窗口，这一刻以前已经结过（或者还没结到）的日子不受影响；
  // 事情解开（比如又换回来）清成 NULL
  await addColumnIfMissing(pool, "reconciliation_rules", "key_issue_code", "VARCHAR(40) NULL");
  await addColumnIfMissing(pool, "reconciliation_rules", "key_issue_since_ms", "BIGINT NULL");
  // 事项解开了（渠道回到原来的 Key），没有靠换段、重新分组处理：冲突期间 [since, until) 里另一把 Key 的用量没人算，这一段的日子不能固定、永远不固定。
  // 一条绑定可以有好几段（解开以后又出新事项、又解开），存成 JSON 数组 [{ code, sinceMs, untilMs }]；NULL 是没有
  await addColumnIfMissing(pool, "reconciliation_rules", "key_blocks", "JSON NULL");
  await addIndexIfMissing(pool, "reconciliation_snapshots", "idx_reconciliation_snapshot_segment", "(segment_id)");
  // 写快照前「先读出同一把 Key 的那一组绑定」（计划 P1c）走这个索引；解除的绑定也留着，表会越来越大
  await addIndexIfMissing(pool, "reconciliation_rules", "idx_reconciliation_rule_token", "(token_id, archived_at)");
  // Legacy rules get exactly one open segment. The deterministic 32-byte ID
  // fits this table even if a historic rule ID used its full column width.
  // We deliberately do not invent old transitions or ratios that facts cannot prove.
  await pool.query(`INSERT INTO reconciliation_rule_segments
    (id, rule_id, group_name, group_ratio, effective_from_ms, effective_to_ms, detected_at_ms, timing_source)
    SELECT CONCAT('ls_', LEFT(MD5(r.id), 29)), r.id, r.fixed_group, NULL, 0, NULL,
      UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000, 'legacy'
    FROM reconciliation_rules r
    WHERE NOT EXISTS (SELECT 1 FROM reconciliation_rule_segments s WHERE s.rule_id = r.id)`);
  // 分段记 Key（K1c）：每段一把 Key，已有的绑定每一段补一行（填 rules 上现在的那把）；重复跑只补缺的，不改账本、不触发重结
  await pool.query(SEGMENT_KEYS_TABLE_SQL);
  for (const { sql, params } of refreshSegmentKeysSql()) await pool.query(sql, params);
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
  // 默认 legacy 兼容旧二进制的 INSERT；每次启动包装新增的旧格式行，不能靠全局完成标记跳过。
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_billing_capabilities (
    identity CHAR(64) NOT NULL PRIMARY KEY,
    capability JSON NOT NULL,
    verified_at BIGINT NOT NULL,
    identity_scheme VARCHAR(24) NOT NULL DEFAULT '${LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME}'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await addColumnIfMissing(pool, "reconciliation_billing_capabilities", "identity_scheme",
    `VARCHAR(24) NOT NULL DEFAULT '${LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME}'`);
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
    expected_cost_usd DECIMAL(20,8) NULL,
    gap_reason VARCHAR(40) NULL,
    tokens BIGINT NULL,
    PRIMARY KEY (rule_id, bill_date, revision)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 应付成本（V1-b）：账本多三列，旧账是 null
  await addColumnIfMissing(pool, "reconciliation_ledger", "expected_cost_usd", "DECIMAL(20,8) NULL");
  await addColumnIfMissing(pool, "reconciliation_ledger", "gap_reason", "VARCHAR(40) NULL");
  await addColumnIfMissing(pool, "reconciliation_ledger", "tokens", "BIGINT NULL");
  // 结账状态（计划 C2a）：每条绑定每个还没固定的日子一行，固定成了就在同一个事务里删掉。只放没办完的日子，正常时接近空。
  // retry_reason 会自己好的原因（按退避表再试）；manual_reason 要人处理的原因；source_version 记下时的配置代次（变了马上重判）。
  // resettle_* 是重结请求（C2b 才写）。不加外键；清理按 bill_date 每小时删一批 31 天前、没有请求的行。
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliation_settlement_state (
    rule_id VARCHAR(32) NOT NULL,
    bill_date DATE NOT NULL,
    retry_reason VARCHAR(64) NULL,
    manual_reason VARCHAR(64) NULL,
    manual_since_ms BIGINT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at_ms BIGINT NULL,
    first_failed_at_ms BIGINT NULL,
    last_attempt_at_ms BIGINT NULL,
    resettle_requested_at_ms BIGINT NULL,
    resettle_reason VARCHAR(24) NULL,
    source_version VARCHAR(64) NULL,
    last_detail JSON NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (rule_id, bill_date),
    INDEX idx_settlement_state_bill_date (bill_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 自营站点整站消费日志的读取进度和小时桶（应付成本 V1-a）：cursor 每个自营站点一行；buckets 按（站点、小时、渠道、模型、上游模型、分组、缓存口径）加起来的数，
  // 不加外键，每小时清一批 35 天前的桶（按 slot_ms 索引）
  await pool.query(`CREATE TABLE IF NOT EXISTS own_log_cursor (
    station_id VARCHAR(32) NOT NULL PRIMARY KEY,
    covered_from_ms BIGINT NOT NULL,
    covered_to_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 「算应付成本」关→开跳过的那段缺口（总指挥 10-26 定第三轮）：covered_to_ms 直接挪到昨天 0 点，中间跳过的这段记在这两列，
  // 结账时这段范围里的日子给 EXPECTED_COST_DISABLED（不是 NOT_STARTED/EXPECTED_COST_NOT_RECORDED，那两个留给「还没开始统计」）
  await addColumnIfMissing(pool, "own_log_cursor", "disabled_from_ms", "BIGINT NULL");
  await addColumnIfMissing(pool, "own_log_cursor", "disabled_to_ms", "BIGINT NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS own_log_buckets (
    station_id VARCHAR(32) NOT NULL,
    slot_ms BIGINT NOT NULL,
    channel_id INT NOT NULL,
    model VARCHAR(128) NOT NULL,
    upstream_model VARCHAR(128) NOT NULL,
    grp VARCHAR(64) NOT NULL,
    semantic VARCHAR(12) NOT NULL,
    requests INT NOT NULL DEFAULT 0,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0,
    quota BIGINT NOT NULL DEFAULT 0,
    admin_quota BIGINT NOT NULL DEFAULT 0,
    test_quota BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, slot_ms, channel_id, model, upstream_model, grp, semantic),
    INDEX idx_own_log_buckets_slot (slot_ms)
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

const BILLING_IDENTITY_META_KEY = "billing_identity_hmac_v1";

// 库里的能力：驱动把 JSON 列读成对象；有的库（或手改过的行）读出来是字符串，解得开、是对象才算数
function capabilityObject(value) {
  let parsed = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return null; } }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

// SHA / 旧 S3 HMAC 都无法仅靠摘要区分：把每个 legacy 身份包成 W(x)，显式标为 wrapped-v2。
// 全局旧标记仅作为旧 S3 程序的迁移栅栏；新程序每次都扫描 legacy，处理回滚期间旧程序新写的行。
// 能力、核验时间和栅栏同一事务提交；失败整体回滚并挡住启动，不触碰账本或快照。
// key 是账单身份密钥，包装用 lib/billing-capability-storage.js 的 wrapLegacyBillingIdentity。身份或能力格式不对的行
// 留在原处、计进 invalid，不挡启动（它本来就对不上任何上游）；密钥没就绪照旧中止。返回 { migrated, skipped, invalid }
export async function rehashBillingCapabilities(pool, key) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [markers] = await conn.query("SELECT k FROM meta WHERE k = ? FOR UPDATE", [BILLING_IDENTITY_META_KEY]);
    const [rows] = await conn.query(
      "SELECT identity, capability, verified_at FROM reconciliation_billing_capabilities WHERE identity_scheme = ? FOR UPDATE",
      [LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME]
    );
    let migrated = 0, invalid = 0;
    for (const { identity, capability, verified_at: verifiedAt } of rows) {
      const wrapped = wrapLegacyBillingIdentity(key, identity), value = capabilityObject(capability);
      if (!wrapped || !value) { invalid += 1; continue; }
      await conn.query(
        `INSERT INTO reconciliation_billing_capabilities (identity, capability, verified_at, identity_scheme) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           capability = IF(identity_scheme <> ? OR VALUES(verified_at) > verified_at, VALUES(capability), capability),
           verified_at = IF(identity_scheme <> ? OR VALUES(verified_at) > verified_at, VALUES(verified_at), verified_at),
           identity_scheme = VALUES(identity_scheme)`,
        [wrapped, JSON.stringify(value), verifiedAt, BILLING_CAPABILITY_IDENTITY_SCHEME,
          BILLING_CAPABILITY_IDENTITY_SCHEME, BILLING_CAPABILITY_IDENTITY_SCHEME]
      );
      migrated += 1;
      await conn.query("DELETE FROM reconciliation_billing_capabilities WHERE identity = ? AND identity_scheme = ?",
        [identity, LEGACY_BILLING_CAPABILITY_IDENTITY_SCHEME]);
    }
    if (!markers.length) await conn.query("INSERT INTO meta (k, v) VALUES (?, ?)",
      [BILLING_IDENTITY_META_KEY, JSON.stringify({ completedAt: new Date().toISOString(), migrated })]);
    await conn.commit();
    return { migrated, skipped: migrated === 0 && markers.length > 0, invalid };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
