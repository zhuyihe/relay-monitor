// 用户运营的存储（第一步：数据和后台）。四张表，都按站点分开，不加外键：
//   user_balance_points：每个用户的余额快照（站点、用户 id、时刻、美元）。变了才写，没变每天补一条；留 14 天（7 天窗口 + 余量）
//   user_usage_hours：每个用户按小时的用量（站点、用户名、小时起点、quota、请求数）。每 10 分钟读最近 3 小时、按小时覆盖写；回补 60 天；留 65 天
//   user_ops_progress：每个站点一行：回补读到哪儿了、快照和用量最近一次读成的时刻
//   user_ops_alert：每个用户提醒到哪一级了、什么时候提醒的、上次的余额（重启以后不会重复推送）
// 内存实现（server/test-support/user-ops-memory-store.js）和这个跑同一组契约用例。
const PROGRESS_FIELDS = Object.freeze({
  backfillCursorMs: "backfill_cursor_ms", backfillTargetMs: "backfill_target_ms", backfillStartedMs: "backfill_started_ms",
  usageSyncedMs: "usage_synced_ms", balanceSyncedMs: "balance_synced_ms",
});
const num = (value) => (value == null ? null : Number(value));
const progressFromRow = (row) => (row ? Object.fromEntries([["stationId", row.station_id], ...Object.entries(PROGRESS_FIELDS).map(([field, column]) => [field, num(row[column])])]) : null);
const CHUNK = 2000;

export class UserOpsStore {
  constructor(pool) { this.pool = pool; }

  async upsertUsageHours(stationId, rows) {
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      if (!chunk.length) continue;
      await this.pool.query(
        "INSERT INTO user_usage_hours (station_id, username, hour_ms, quota, requests) VALUES ? ON DUPLICATE KEY UPDATE quota = VALUES(quota), requests = VALUES(requests)",
        [chunk.map((row) => [stationId, String(row.username).slice(0, 128), Math.round(row.hourMs), Math.round(row.quota) || 0, Math.round(row.requests) || 0])]);
      written += chunk.length;
    }
    return written;
  }

  // [fromMs, toMs) 里每个用户每小时的用量（只取算法要的三列）
  async listUsageHours(stationId, fromMs, toMs = Number.MAX_SAFE_INTEGER) {
    const [rows] = await this.pool.query("SELECT username, hour_ms, quota FROM user_usage_hours WHERE station_id = ? AND hour_ms >= ? AND hour_ms < ?", [stationId, fromMs, toMs]);
    return rows.map((row) => ({ username: row.username, hourMs: Number(row.hour_ms), quota: Number(row.quota) }));
  }

  async addBalancePoints(stationId, rows) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      if (!chunk.length) continue;
      await this.pool.query("INSERT IGNORE INTO user_balance_points (station_id, user_id, t, balance_usd) VALUES ?", [chunk.map((row) => [stationId, Number(row.userId), Math.round(row.t), row.balanceUsd])]);
    }
  }

  // 每个用户最新的一条快照：Map(用户 id → { t, balanceUsd })
  async lastBalancePoints(stationId) {
    const [rows] = await this.pool.query(
      `SELECT p.user_id, p.t, p.balance_usd FROM user_balance_points p
         JOIN (SELECT user_id, MAX(t) AS t FROM user_balance_points WHERE station_id = ? GROUP BY user_id) m ON m.user_id = p.user_id AND m.t = p.t
        WHERE p.station_id = ?`, [stationId, stationId]);
    return new Map(rows.map((row) => [Number(row.user_id), { t: Number(row.t), balanceUsd: Number(row.balance_usd) }]));
  }

  // sinceMs 以后的快照：Map(用户 id → [[t, 美元], …] 升序)
  async listBalancePoints(stationId, sinceMs) {
    const [rows] = await this.pool.query("SELECT user_id, t, balance_usd FROM user_balance_points WHERE station_id = ? AND t >= ? ORDER BY user_id, t", [stationId, sinceMs]);
    const out = new Map();
    for (const row of rows) {
      const id = Number(row.user_id);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push([Number(row.t), Number(row.balance_usd)]);
    }
    return out;
  }

  async getProgress(stationId) {
    const [rows] = await this.pool.query("SELECT * FROM user_ops_progress WHERE station_id = ?", [stationId]);
    return progressFromRow(rows[0]);
  }

  // 只更新给到的字段
  async saveProgress(stationId, patch, now = Date.now()) {
    const fields = Object.keys(PROGRESS_FIELDS).filter((field) => field in patch);
    const columns = fields.map((field) => PROGRESS_FIELDS[field]);
    const values = fields.map((field) => num(patch[field]));
    await this.pool.query(
      `INSERT INTO user_ops_progress (station_id, ${[...columns, "updated_at_ms"].join(", ")}) VALUES (?${", ?".repeat(columns.length + 1)})
       ON DUPLICATE KEY UPDATE ${[...columns, "updated_at_ms"].map((column) => `${column} = VALUES(${column})`).join(", ")}`,
      [stationId, ...values, now]);
    return this.getProgress(stationId);
  }

  async getAlertStates(stationId) {
    const [rows] = await this.pool.query("SELECT user_id, level, notified_at_ms, last_balance_usd FROM user_ops_alert WHERE station_id = ?", [stationId]);
    return new Map(rows.map((row) => [Number(row.user_id), { level: Number(row.level), notifiedAt: num(row.notified_at_ms), lastBalanceUsd: num(row.last_balance_usd) }]));
  }

  async saveAlertState(stationId, userId, state, now = Date.now()) {
    await this.pool.query(
      `INSERT INTO user_ops_alert (station_id, user_id, level, notified_at_ms, last_balance_usd, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE level = VALUES(level), notified_at_ms = VALUES(notified_at_ms), last_balance_usd = VALUES(last_balance_usd), updated_at_ms = VALUES(updated_at_ms)`,
      [stationId, Number(userId), state.level, num(state.notifiedAt), num(state.lastBalanceUsd), now]);
  }

  // 清早的数据，一批一批删；返回删了多少行
  async prune(stationId, { usageBeforeMs, balanceBeforeMs }, limit = 5000) {
    const [usage] = await this.pool.query("DELETE FROM user_usage_hours WHERE station_id = ? AND hour_ms < ? LIMIT ?", [stationId, usageBeforeMs, limit]);
    const [balance] = await this.pool.query("DELETE FROM user_balance_points WHERE station_id = ? AND t < ? LIMIT ?", [stationId, balanceBeforeMs, limit]);
    return { usage: usage.affectedRows ?? 0, balance: balance.affectedRows ?? 0 };
  }

  // 站点彻底删除、或者自营站点换了地址（同一个 id 读另一个站）：全清
  async deleteStation(stationId) {
    for (const table of ["user_balance_points", "user_usage_hours", "user_ops_progress", "user_ops_alert"]) {
      await this.pool.query(`DELETE FROM ${table} WHERE station_id = ?`, [stationId]);
    }
  }
}
