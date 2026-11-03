// 上游每天花费的存储（lib/upstream-spend.js 的数据）。两张表，都按站点分开，不加外键：
//   upstream_daily_spend：（站点、业务时区的日期 YYYY-MM-DD）→ 当天花了多少美元，和余额同一个单位
//   upstream_spend_state：每个站点一行：status（ok 读得到 / denied 对方不给读）、source（dashboard / stat / trend）、读到哪天了、上次试的时刻
// 内存实现（server/test-support/upstream-spend-memory-store.js）和这个跑同一组契约用例。
const stateFromRow = (row) => ({
  stationId: String(row.station_id), status: row.status, source: row.source ?? null,
  readThrough: row.read_through ?? null, deniedCode: row.denied_code ?? null, checkedAt: Number(row.checked_at),
});

export class UpstreamSpendStore {
  constructor(pool) { this.pool = pool; }

  // [fromDay, toDay]（含两头，业务时区日期）里这些站点每天的花费，按日期升序
  async listDays(stationIds, fromDay, toDay) {
    const ids = [...new Set((stationIds || []).map(String))];
    if (!ids.length) return [];
    const [rows] = await this.pool.query(
      "SELECT station_id, spend_day, spent_usd FROM upstream_daily_spend WHERE station_id IN (?) AND spend_day >= ? AND spend_day <= ? ORDER BY spend_day, station_id",
      [ids, fromDay, toDay]);
    return rows.map((row) => ({ stationId: String(row.station_id), day: String(row.spend_day), usd: Number(row.spent_usd) }));
  }

  // 一个站点一批整天的花费：一条语句写进去，同一天重读就覆盖
  async putDays(stationId, rows) {
    if (!rows.length) return 0;
    await this.pool.query(
      "INSERT INTO upstream_daily_spend (station_id, spend_day, spent_usd) VALUES ? ON DUPLICATE KEY UPDATE spent_usd = VALUES(spent_usd)",
      [rows.map((row) => [String(stationId), row.day, Math.max(0, Number(row.usd) || 0)])]);
    return rows.length;
  }

  // 每个站点的读取状态：Map(站点 id → { status, source, readThrough, deniedCode, checkedAt })
  async listStates() {
    const [rows] = await this.pool.query("SELECT station_id, status, source, read_through, denied_code, checked_at FROM upstream_spend_state");
    return new Map(rows.map((row) => [String(row.station_id), stateFromRow(row)]));
  }

  async saveState(stationId, state) {
    await this.pool.query(
      `INSERT INTO upstream_spend_state (station_id, status, source, read_through, denied_code, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), source = VALUES(source), read_through = VALUES(read_through), denied_code = VALUES(denied_code), checked_at = VALUES(checked_at)`,
      [String(stationId), state.status, state.source ?? null, state.readThrough ?? null, state.deniedCode ?? null, Math.round(state.checkedAt)]);
  }

  // 留 KEEP_DAYS 天：删掉 beforeDay（不含）以前的
  async prune(beforeDay) {
    const [result] = await this.pool.query("DELETE FROM upstream_daily_spend WHERE spend_day < ?", [beforeDay]);
    return Number(result?.affectedRows) || 0;
  }

  // 站点彻底删除时一起删
  async deleteStation(stationId) {
    await this.pool.query("DELETE FROM upstream_daily_spend WHERE station_id = ?", [String(stationId)]);
    await this.pool.query("DELETE FROM upstream_spend_state WHERE station_id = ?", [String(stationId)]);
  }
}
