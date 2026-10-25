// 第 3 步（服务停着）：把夹具「搬回」90 天前开始运行的状态，再按真实写入密度补历史。
//   1. 上游、绑定、倍率时段、看余额的渠道绑定的创建时间改到夹具起点（像 90 多天前就接入了）；
//   2. 1/7 左右的 New API 绑定在 40 天前换过倍率：用应用自己的 ReconciliationRepository.reconcileCurrentSegment 记一次倍率变化；
//   3. 余额历史 history_points：51 个站点 × PERF_HISTORY_DAYS 天（默认 90）× 每 60 秒一点（默认刷新间隔），数值来自假站点同一份余额模型；
//   4. 日汇总 station_daily_usage：用应用自己的 dailyUsageRows（db/history.js）按业务时区算，写回填标记。
import { APP_DIR, progress } from "../lib/env.mjs";
import { loadConfig, makeAggregates, makeBalanceModel, accountCostQuota, UPSTREAMS, QPU, HOUR, TZ, dayStartSec, dateKeyOf, upstreamGroupRatio, RULES } from "../lib/model.mjs";

const config = loadConfig();
const epoch0 = config.epoch0Sec;
const { getPool } = await import(`${APP_DIR}/db/pool.js`);
const { ReconciliationRepository } = await import(`${APP_DIR}/server/reconciliation-repository.js`);
const { dailyUsageRows } = await import(`${APP_DIR}/db/history.js`);
const pool = getPool();
// 灌 660 万点不进 binlog（夹具库没有从库），免得白占几百 MB 磁盘
pool.pool.on("connection", (conn) => conn.query("SET SESSION sql_log_bin = 0"));
const repo = new ReconciliationRepository(pool);
const nowSec = Math.floor(Date.now() / 1000);
const t0 = Date.now();

// ---- 1. 创建时间搬回起点 ----
const bornSec = epoch0 + 2 * 3600;
const bornIso = new Date(bornSec * 1000).toISOString();
// 核算起点：今天往前 91 天的上海零点（账本覆盖最近 90 个完整自然日）
const todayKey = dateKeyOf(nowSec, TZ);
const effectiveFromMs = dayStartSec(new Date(Date.parse(todayKey + "T00:00:00Z") - 91 * 86400000).toISOString().slice(0, 10), TZ) * 1000;
await pool.query("UPDATE stations SET created_at = FROM_UNIXTIME(?), doc = JSON_SET(doc, '$.createdAt', ?)", [bornSec, bornIso]);
await pool.query("UPDATE reconciliation_rules SET created_at = FROM_UNIXTIME(?), billing_effective_from_ms = ? WHERE billing_effective_from_ms IS NOT NULL", [bornSec, effectiveFromMs]);
await pool.query("UPDATE reconciliation_rules SET created_at = FROM_UNIXTIME(?)", [bornSec]);
await pool.query("UPDATE reconciliation_rule_segments SET effective_from_ms = LEAST(effective_from_ms, ?), detected_at_ms = ?, created_at = FROM_UNIXTIME(?)", [effectiveFromMs, bornSec * 1000, bornSec]);
await pool.query("UPDATE reconciliation_rule_channels SET created_at = FROM_UNIXTIME(?)", [bornSec]);
await pool.query("UPDATE channel_monitor_links SET confirmed_at_ms = ?", [bornSec * 1000]);
const [[segInfo]] = await pool.query("SELECT COUNT(*) n, MIN(effective_from_ms) mn, MAX(effective_from_ms) mx FROM reconciliation_rule_segments");
progress(`种子 3a：创建时间搬到 ${bornIso}，核算起点 ${new Date(effectiveFromMs).toISOString()}，时段 ${JSON.stringify(segInfo)}`);

// ---- 2. 倍率变化 ----
const rules = await repo.listRules();
const stationRows = (await pool.query("SELECT id, doc FROM stations"))[0].map((r) => (typeof r.doc === "string" ? JSON.parse(r.doc) : r.doc));
const upByStation = new Map(stationRows.filter((s) => !s.isOwn).map((s) => [s.id, UPSTREAMS.find((up) => up.baseUrl === s.baseUrl)]));
let transitions = 0;
for (const rule of rules) {
  const up = upByStation.get(rule.upstreamStationId);
  if (!up || !(config.ratioChanges || []).some((x) => x.upstream === up.i && x.group === rule.fixedGroup)) continue;
  await repo.reconcileCurrentSegment(rule.id, { group: rule.fixedGroup, ratio: upstreamGroupRatio(config, up, rule.fixedGroup, "current"),
    detectedAt: config.ratioChangeAtMs });
  transitions += 1;
}
progress(`种子 3b：${transitions} 条绑定记了一次倍率变化（${new Date(config.ratioChangeAtMs).toISOString()}）`);

// ---- 3. 余额历史 ----
const agg = makeAggregates(epoch0);
agg.ensureHours(Math.floor((nowSec - epoch0) / HOUR));
const balances = makeBalanceModel(agg, config);
// PERF_HISTORY_DAYS 缩短余额历史（CI 上嫌灌得慢时用）；只影响读余额历史的接口（经营分析 30/90 天、余额曲线 30 天等），结账不读它
const historyDays = Math.min(90, Math.max(1, Number(process.env.PERF_HISTORY_DAYS || 90)));
const fromSec = nowSec - historyDays * 86400, toSec = nowSec - 120;
const H0 = Math.floor((fromSec - epoch0) / HOUR), H1 = Math.floor((toSec - epoch0) / HOUR) + 1;
await pool.query("DELETE FROM history_points");
let points = 0;
const insertRows = async (rows) => {
  for (let i = 0; i < rows.length; i += 10000) {
    await pool.query("INSERT IGNORE INTO history_points (station_id, t, remaining, used) VALUES ?", [rows.slice(i, i + 10000)]);
  }
};
const dailyRows = [];
for (const [index, station] of stationRows.entries()) {
  const up = upByStation.get(station.id);
  const jitter = (index * 731) % 60000;
  // 每小时的累计花费（额度），小时内线性插值
  let cum = null, before = 0;
  if (up) {
    cum = new Float64Array(H1 - H0 + 1);
    before = accountCostQuota(agg, up, epoch0, epoch0 + H0 * HOUR - 1);
    let acc = before;
    for (let H = H0; H < H1; H++) { cum[H - H0] = acc; acc += accountCostQuota(agg, up, epoch0 + H * HOUR, epoch0 + (H + 1) * HOUR - 1); }
    cum[H1 - H0] = acc;
  }
  const rows = [];
  for (let tMs = fromSec * 1000 + jitter; tMs <= toSec * 1000; tMs += 60000) {
    const t = tMs / 1000;
    let remaining, used;
    if (!up) { remaining = 198000; used = 2400; }
    else {
      const x = (t - epoch0) / HOUR - H0, i = Math.min(H1 - H0 - 1, Math.max(0, Math.floor(x))), f = x - i;
      const usedQ = cum[i] + (cum[i + 1] - cum[i]) * f;
      const st = balances.state(up, Math.floor(t), usedQ);
      if (up.kind === "newapi-key") { remaining = Math.round((st.granted - st.used) / QPU * 100) / 100; used = Math.round(st.used / QPU * 100) / 100; }
      else { remaining = Math.round(st.remaining / QPU * 100) / 100; used = Math.round(st.used / QPU * 100) / 100; }
    }
    rows.push([station.id, Math.round(tMs), Math.max(0, remaining), used]);
  }
  await insertRows(rows);
  points += rows.length;
  dailyRows.push(...dailyUsageRows(rows.map(([station_id, t, remaining]) => ({ station_id, t, remaining })), fromSec * 1000, toSec * 1000 + 1, TZ));
  if (index % 10 === 9) progress(`种子 3c：余额历史 ${index + 1}/${stationRows.length} 个站点，${points} 点，${Math.round((Date.now() - t0) / 1000)} 秒`);
}
await pool.query("DELETE FROM station_daily_usage");
for (let i = 0; i < dailyRows.length; i += 5000) {
  await pool.query("INSERT INTO station_daily_usage (station_id, date, used_usd) VALUES ?", [dailyRows.slice(i, i + 5000).map((r) => [r.stationId, r.date, r.usd])]);
}
await pool.query("INSERT INTO meta (k, v) VALUES ('history_daily_usage_v1', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify({ completedAt: new Date().toISOString() })]);
progress(`种子 3d：余额历史 ${points} 点、日汇总 ${dailyRows.length} 行，共 ${Math.round((Date.now() - t0) / 1000)} 秒`);
await pool.end();
