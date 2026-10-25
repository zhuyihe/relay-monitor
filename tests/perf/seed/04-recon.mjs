// 第 4 步（服务和假站点在跑）：让应用自己把最近 90 个自然日结账。
//   每天发一次页面「刷新」同款请求 POST /api/reconciliation/query {observe: true, preset: "custom", 那一天}：
//   80 条绑定逐条读上游 Key 账单和自营渠道收入，写观测快照 + 账本（source=settle），和每天 00:15 后台结账写的是同一种行。
// 然后补两样只有「真的跑过 90 天」才会有的行（照着应用刚写的行改，形状一致）：
//   · 每天每条绑定一行「今天」观测快照（后台每轮轮询写的那一行，键按应用的 reconciliationSnapshotRecordIdentity 算）；
//   · 约 8% 的日子重结过一次、2% 重结过两次（账本 revision 2/3，source=resettle）。
import { login, progress, APP_DIR } from "../lib/env.mjs";
import { loadConfig, TZ, dayStartSec, dateKeyOf, BASE, h32 } from "../lib/model.mjs";

const config = loadConfig();
const days = Number(process.argv[2] || 90);
const api = await login();
await fetch(`${BASE}/__ctl?delay=5`);
const nowSec = Math.floor(Date.now() / 1000);
const todayKey = dateKeyOf(nowSec, TZ);
const keyOf = (offset) => new Date(Date.parse(todayKey + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
const t0 = Date.now();
let ok = 0, bad = 0;
for (let d = days; d >= 1; d--) {
  const startMs = dayStartSec(keyOf(-d), TZ) * 1000, endMs = dayStartSec(keyOf(-d + 1), TZ) * 1000;
  const t1 = Date.now();
  const res = await api("/api/reconciliation/query", { method: "POST", body: { preset: "custom", startMs, endMs, observe: true } });
  const settled = (res.results || []).filter((row) => row.calculation?.profitUsd != null).length;
  ok += settled; bad += (res.results || []).length - settled;
  if (d % 10 === 0 || d === 1) progress(`种子 4a：结账 ${keyOf(-d)}（${settled}/${(res.results || []).length} 条算出毛利，${Date.now() - t1} ms），累计 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}
await fetch(`${BASE}/__ctl?delay=50`);

const { getPool } = await import(`${APP_DIR}/db/pool.js`);
const { reconciliationSnapshotRecordIdentity } = await import(`${APP_DIR}/lib/reconciliation-snapshot.js`);
const { ledgerInsertValues, ledgerEntryFromRow, RECONCILIATION_LEDGER_COLUMNS } = await import(`${APP_DIR}/lib/reconciliation-ledger.js`);
const pool = getPool();

// 「今天」观测快照：每条 custom 观测行复制一份，窗口改成那天的 today 预设（截至那天 23:5x）
const [obs] = await pool.query("SELECT * FROM reconciliation_snapshots WHERE window_kind = 'custom' AND snapshot_key LIKE 'r3:o:%'");
let todayRows = 0;
for (let i = 0; i < obs.length; i += 200) {
  const values = [];
  for (const row of obs.slice(i, i + 200)) {
    const source = typeof row.source === "string" ? JSON.parse(row.source) : row.source;
    const endMs = Number(row.window_end_ms) - (5 + (h32(Number(row.window_start_ms) / 1000) % 50)) * 60000;
    const window = { ...source.window, preset: "today", endMs };
    source.window = window;
    if (source.result) { source.result.window = window; source.result.requestedWindow = window; }
    source.origin = "poll";
    const key = reconciliationSnapshotRecordIdentity(window, source.scopeFingerprint, "observation", row.segment_id);
    values.push([row.rule_id, row.segment_id, key, "today", Number(row.window_start_ms), endMs, dateKeyOf(Number(row.window_start_ms) / 1000, TZ),
      row.upstream_quota, row.upstream_quota_per_unit, row.upstream_usd, row.downstream_quota, row.downstream_quota_per_unit, row.downstream_usd,
      row.difference_usd, row.margin_rate, row.coverage, row.health_code, row.health_detail, JSON.stringify(source), new Date(endMs)]);
  }
  const [r] = await pool.query(`INSERT IGNORE INTO reconciliation_snapshots (rule_id, segment_id, snapshot_key, window_kind, window_start_ms, window_end_ms, local_date,
    upstream_quota, upstream_quota_per_unit, upstream_usd, downstream_quota, downstream_quota_per_unit, downstream_usd, difference_usd, margin_rate, coverage,
    health_code, health_detail, source, generated_at) VALUES ?`, [values]);
  todayRows += r.affectedRows;
}

// 重结账：revision 2（约 8%）和 3（约 2%）
const cols = RECONCILIATION_LEDGER_COLUMNS.join(", ");
const [ledger] = await pool.query(`SELECT ${cols.replace("bill_date", "DATE_FORMAT(bill_date, '%Y-%m-%d') AS bill_date").replace("settled_at", "DATE_FORMAT(settled_at, '%Y-%m-%d %H:%i:%s.%f') AS settled_at")} FROM reconciliation_ledger WHERE revision = 1`);
let revisions = 0;
for (const row of ledger) {
  const entry = ledgerEntryFromRow(row);
  const roll = h32(Number(entry.startMs) / 1000 + entry.ruleId.length * 7919 + entry.ruleId.charCodeAt(entry.ruleId.length - 1)) % 100;
  const extra = roll < 2 ? 2 : roll < 10 ? 1 : 0;
  for (let n = 1; n <= extra; n++) {
    const factor = 1 + ((roll % 5) - 2) / 100 * n;
    const next = { ...entry, revision: entry.revision + n, source: "resettle", revenueUsd: Math.round(entry.revenueUsd * factor * 1e8) / 1e8,
      costUsd: entry.costUsd == null ? null : Math.round(entry.costUsd * (2 - factor) * 1e8) / 1e8,
      settledAt: new Date(Date.parse(entry.settledAt) + n * 6 * 3600000).toISOString() };
    await pool.query(`INSERT IGNORE INTO reconciliation_ledger (${cols}) VALUES (?)`, [ledgerInsertValues(next)]);
    revisions += 1;
  }
}
progress(`种子 4b：账本 ${ledger.length} 行第一版、补重结 ${revisions} 行；补「今天」观测快照 ${todayRows} 行；算出毛利 ${ok}、没算出 ${bad}，共 ${Math.round((Date.now() - t0) / 1000)} 秒`);
await pool.end();
