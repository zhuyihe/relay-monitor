import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, rehashBillingCapabilities } from "./pool.js";
import { billingCapabilityAliases, wrappedBillingIdentity } from "../lib/billing-capability-storage.js";
import { createHash, createHmac } from "node:crypto";

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
    "ALTER TABLE reconciliation_rules ADD COLUMN archived_at_ms BIGINT NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN accounting_floor_ms BIGINT NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN bound_at_ms BIGINT NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN cost_coverage VARCHAR(24) NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE reconciliation_rules ADD COLUMN provider VARCHAR(24) NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN canonical_key VARCHAR(255) NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN source_binding JSON NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN key_issue_code VARCHAR(40) NULL",
    "ALTER TABLE reconciliation_rules ADD COLUMN key_issue_since_ms BIGINT NULL",
    "ALTER TABLE reconciliation_snapshots ADD INDEX idx_reconciliation_snapshot_segment (segment_id)",
    "ALTER TABLE reconciliation_rules ADD INDEX idx_reconciliation_rule_token (token_id, archived_at)",
    "ALTER TABLE reconciliation_rule_day_keys ADD COLUMN yielded TINYINT NOT NULL DEFAULT 0",
    "ALTER TABLE reconciliation_billing_capabilities ADD COLUMN identity_scheme VARCHAR(24) NOT NULL DEFAULT 'legacy'",
    "ALTER TABLE reconciliation_ledger ADD COLUMN expected_cost_usd DECIMAL(20,8) NULL",
    "ALTER TABLE reconciliation_ledger ADD COLUMN gap_reason VARCHAR(40) NULL",
    "ALTER TABLE reconciliation_ledger ADD COLUMN tokens BIGINT NULL",
    "ALTER TABLE reconciliation_fixed_cost_days ADD COLUMN basis VARCHAR(16) NOT NULL DEFAULT 'fixed'",
    "ALTER TABLE reconciliation_fixed_cost_days ADD INDEX idx_fixed_cost_days_date (bill_date)",
    "ALTER TABLE own_log_cursor ADD COLUMN disabled_from_ms BIGINT NULL",
    "ALTER TABLE own_log_cursor ADD COLUMN disabled_to_ms BIGINT NULL",
  ]);
  assert.equal(alters.some((sql) => sql.includes("IF NOT EXISTS")), false);
});

test("对账 schema 已具备列和索引时不重复执行 ALTER", async () => {
  const pool = schemaPool({
    columns: ["channel_status", "status_observed_at_ms", "status_changed_at_ms", "segment_id", "ratio_observed_at_ms", "ratio_source",
      "billing_policy", "scope_version", "billing_effective_from_ms", "archived_at_ms", "accounting_floor_ms", "bound_at_ms", "cost_coverage", "provider", "canonical_key", "source_binding",
      "key_issue_code", "key_issue_since_ms", "identity_scheme", "expected_cost_usd", "gap_reason", "tokens", "basis", "yielded", "disabled_from_ms", "disabled_to_ms"],
    indexes: ["idx_reconciliation_snapshot_segment", "idx_reconciliation_rule_token", "idx_fixed_cost_days_date"],
  });
  await ensureSchema(pool);
  assert.equal(pool.calls.some((call) => call.sql.startsWith("ALTER TABLE")), false);
});

test("分段记 Key（K1c）：建表一次，启动时只补缺的 Key 行（一条 INSERT … WHERE NOT EXISTS），不重写已有的行", async () => {
  const pool = schemaPool();
  await ensureSchema(pool);
  const sqls = pool.calls.map((call) => call.sql);
  assert.equal(sqls.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS reconciliation_segment_keys")).length, 1);
  const fills = sqls.filter((sql) => /INSERT INTO reconciliation_segment_keys/.test(sql));
  assert.equal(fills.length, 1);
  assert.match(fills[0], /WHERE NOT EXISTS \(SELECT 1 FROM reconciliation_segment_keys k WHERE k\.segment_id = s\.id\)/);
  assert.equal(sqls.some((sql) => /UPDATE reconciliation_segment_keys/.test(sql)), false);
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
  assert.equal(pool.calls.some((call) => /UPDATE reconciliation_rules SET billing/.test(call.sql)), false);
  // 解除时刻回填：只补 archived_at_ms 为空的已解除行，不动别的列
  const backfill = pool.calls.filter((call) => /UPDATE reconciliation_rules/.test(call.sql));
  assert.equal(backfill.length, 2);
  assert.ok(backfill.every((call) => /SET archived_at_ms = UNIX_TIMESTAMP\(archived_at\) \* 1000 WHERE archived_at IS NOT NULL AND archived_at_ms IS NULL/.test(call.sql)));
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

// 启动迁移的事务假库：写入草稿，只有 COMMIT 成功才改变已提交行。
function capabilityPool({ rows = [], marker = false, failOn = null, failAfter = 0 } = {}) {
  const db = { rows: structuredClone(rows), marker }, calls = [];
  let draft, matches = 0;
  const record = (sql) => {
    calls.push(sql);
    if (failOn && sql.startsWith(failOn) && matches++ >= failAfter) throw Object.assign(new Error("synthetic"), { code: "ER_LOCK_DEADLOCK" });
  };
  const conn = {
    beginTransaction: async () => { draft = structuredClone(db); },
    async query(sql, params = []) {
      record(sql);
      if (sql.startsWith("SELECT k FROM meta")) return [draft.marker ? [{ k: params[0] }] : []];
      if (sql.startsWith("SELECT identity")) return [structuredClone(draft.rows.filter((r) => (r.identity_scheme || "legacy") === params[0]))];
      if (sql.startsWith("INSERT INTO reconciliation_billing_capabilities")) {
        // 参数顺序和 SQL 一致：新行四列，再加 ON DUPLICATE KEY UPDATE 里两个 IF 各自比的版本名。
        // 两个赋值看到的都是旧行（verified_at 在它自己那个赋值之前没改）
        const [identity, capability, verified_at, identity_scheme, capabilityKeep, verifiedKeep] = params;
        const incoming = { identity, capability: JSON.parse(capability), verified_at, identity_scheme };
        const index = draft.rows.findIndex((r) => r.identity.toLowerCase() === identity.toLowerCase());
        if (index < 0) draft.rows.push(incoming);
        else {
          const old = draft.rows[index], newer = Number(verified_at) > Number(old.verified_at);
          draft.rows[index] = { identity: old.identity,
            capability: old.identity_scheme !== capabilityKeep || newer ? incoming.capability : old.capability,
            verified_at: old.identity_scheme !== verifiedKeep || newer ? verified_at : old.verified_at, identity_scheme };
        }
      }
      if (sql.startsWith("DELETE FROM reconciliation_billing_capabilities")) draft.rows = draft.rows.filter((r) => !(r.identity.toLowerCase() === params[0].toLowerCase() && (r.identity_scheme || "legacy") === params[1]));
      if (sql.startsWith("INSERT INTO meta")) draft.marker = true;
      return [[]];
    },
    commit: async () => { record("COMMIT"); Object.assign(db, draft); },
    rollback: async () => { calls.push("ROLLBACK"); },
    release: () => {},
  };
  return { db, calls, getConnection: async () => conn };
}

const billingKey = "migration-fixture-key";
const digestOf = (s) => createHash("sha256").update(s).digest("hex");
const wrap = (digest) => wrappedBillingIdentity(billingKey, digest);
const capability = (verifiedAt, reason = "RUNTIME_FILTERS_VERIFIED") => ({ state: "supported", currency: "USD", window: "natural-day", verifiedAt, reason });
const capabilityRow = (identity, at, scheme = "legacy", reason) => ({ identity, capability: capability(at, reason), verified_at: at, identity_scheme: scheme });

test("账单身份迁移：混合 SHA/HMAC 包装后保留能力和时间，已经包装的行不再改", async () => {
  const digest = digestOf("sha"), oldHmac = createHmac("sha256", billingKey).update(digestOf("hmac")).digest("hex");
  const oldWrapped = capabilityRow(wrap(digestOf("done")), 500, "wrapped-v2");
  const pool = capabilityPool({ rows: [capabilityRow(digest, 1000), capabilityRow(oldHmac, 2000), oldWrapped] });
  assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 2, skipped: false, invalid: 0 });
  assert.deepEqual(pool.db.rows, [oldWrapped, capabilityRow(wrap(digest), 1000, "wrapped-v2"), capabilityRow(wrap(oldHmac), 2000, "wrapped-v2")]);
  assert.equal(pool.db.marker, true);
  const saved = structuredClone(pool.db);
  pool.calls.length = 0;
  assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 0, skipped: true, invalid: 0 });
  assert.deepEqual(pool.db, saved);
  assert.equal(pool.calls.some((sql) => sql.startsWith("INSERT") || sql.startsWith("DELETE") || sql.startsWith("UPDATE")), false);
  assert.ok(pool.calls.every((sql) => !/ledger|snapshots/.test(sql)));
});

test("旧 marker 不阻止扫描：回滚插入裸 SHA 后重新升级仍包装，避免裸摘要留库", async () => {
  const digest = digestOf("returned-old-program"), pool = capabilityPool({ marker: true });
  pool.db.rows.push(capabilityRow(digest, 3000));
  assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 1, skipped: false, invalid: 0 });
  assert.deepEqual(pool.db.rows, [capabilityRow(wrap(digest), 3000, "wrapped-v2")]);
  assert.equal(pool.db.rows.some((r) => r.identity === digest), false);
});

test("新旧同身份合并总是保留 verified_at 较新的一组能力和时间", async () => {
  const digest = digestOf("same-account"), [identity] = billingCapabilityAliases(billingKey, digest);
  for (const legacyAt of [1000, 3000]) {
    const pool = capabilityPool({ marker: true, rows: [capabilityRow(digest, legacyAt, "legacy", "legacy-row"), capabilityRow(identity, 2000, "wrapped-v2", "new-row")] });
    await rehashBillingCapabilities(pool, billingKey);
    assert.deepEqual(pool.db.rows, [capabilityRow(identity, Math.max(legacyAt, 2000), "wrapped-v2", legacyAt > 2000 ? "legacy-row" : "new-row")]);
  }
});

test("空表或只有 wrapped-v2 的库也写旧兼容栅栏，防止旧 S3 再次包装新身份", async () => {
  for (const rows of [[], [capabilityRow(wrap(digestOf("wrapped-only")), 1000, "wrapped-v2")]]) {
    const pool = capabilityPool({ rows });
    assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 0, skipped: false, invalid: 0 });
    assert.equal(pool.db.marker, true);
    assert.deepEqual(pool.db.rows, rows);
  }
});

test("格式不对的旧身份跳过并计数，不挡启动；别的行照常包装，下次启动照样跳过", async () => {
  const digest = digestOf("ok"), broken = capabilityRow("not-a-digest", 1000), notHex = capabilityRow("z".repeat(64), 1500);
  const pool = capabilityPool({ rows: [broken, capabilityRow(digest, 2000), notHex] });
  assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 1, skipped: false, invalid: 2 });
  assert.deepEqual(pool.db.rows, [broken, notHex, capabilityRow(wrap(digest), 2000, "wrapped-v2")]);
  assert.equal(pool.db.marker, true);
  assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 0, skipped: true, invalid: 2 });
  assert.deepEqual(pool.db.rows, [broken, notHex, capabilityRow(wrap(digest), 2000, "wrapped-v2")]);
});

test("能力那一列读出来不是对象（手改成字符串、解不开）也按格式不对跳过，不挡启动", async () => {
  const digest = digestOf("text-capability");
  const textRow = { identity: digestOf("bad-json"), capability: "not json", verified_at: 1000, identity_scheme: "legacy" };
  const arrayRow = { identity: digestOf("array"), capability: "[1,2]", verified_at: 1000, identity_scheme: "legacy" };
  // 有的库把 JSON 列读成字符串：解得开、是对象就照常包装
  const stringRow = { identity: digest, capability: JSON.stringify(capability(2000)), verified_at: 2000, identity_scheme: "legacy" };
  const pool = capabilityPool({ rows: [textRow, arrayRow, stringRow] });
  assert.deepEqual(await rehashBillingCapabilities(pool, billingKey), { migrated: 1, skipped: false, invalid: 2 });
  assert.deepEqual(pool.db.rows, [textRow, arrayRow, capabilityRow(wrap(digest), 2000, "wrapped-v2")]);
});

test("账单身份密钥没就绪时照旧中止启动、整体回滚，不当成格式不对跳过", async () => {
  const rows = [capabilityRow(digestOf("a"), 1000)];
  const pool = capabilityPool({ rows });
  await assert.rejects(rehashBillingCapabilities(pool, null), /账单身份密钥未就绪/);
  assert.deepEqual(pool.db, { rows, marker: false });
  assert.equal(pool.calls.at(-1), "ROLLBACK");
});

for (const failOn of ["INSERT INTO reconciliation_billing_capabilities", "DELETE FROM reconciliation_billing_capabilities", "INSERT INTO meta", "COMMIT"]) {
  test(`账单身份迁移中断整体回滚：${failOn}`, async () => {
    const rows = [capabilityRow(digestOf("a"), 1000), capabilityRow(digestOf("b"), 2000)];
    const pool = capabilityPool({ rows, failOn, failAfter: failOn.includes("billing_capabilities") ? 1 : 0 });
    await assert.rejects(rehashBillingCapabilities(pool, billingKey), { code: "ER_LOCK_DEADLOCK" });
    assert.deepEqual(pool.db, { rows, marker: false });
    assert.equal(pool.calls.at(-1), "ROLLBACK");
  });
}
