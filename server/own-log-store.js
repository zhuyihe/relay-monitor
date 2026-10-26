// 自营站点整站消费日志的小时桶和读取进度（应付成本 V1-a，计划 v1-plan 第 3 节）。
// own_log_cursor：每个自营站点一行，covered_to_ms 之前（从 covered_from_ms 起）的日志都已经读进桶里；
// own_log_buckets：按（站点、小时、渠道、模型、上游模型、分组、缓存口径）加起来的数。
// 读一个窗口 = 一个事务：核对进度正好停在这个窗口的起点，数加进桶，进度挪到窗口终点；进度对不上（别的进程先写了）就不写，返回 false。
// 这样重启接着读、两个进程同时读都不会把同一段日志加两次。
export const OWN_LOG_BUCKET_COLUMNS = Object.freeze(["requests", "prompt_tokens", "completion_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_1h_tokens", "quota", "admin_quota", "test_quota"]);
const FIELD_OF_COLUMN = Object.freeze({ requests: "requests", prompt_tokens: "promptTokens", completion_tokens: "completionTokens", cache_read_tokens: "cacheReadTokens",
  cache_write_tokens: "cacheWriteTokens", cache_write_1h_tokens: "cacheWrite1hTokens", quota: "quota", admin_quota: "adminQuota", test_quota: "testQuota" });
const clip = (text, length) => String(text ?? "").slice(0, length);
// 模型名、分组名放进主键，截到列宽；两个名字只有 128 个字以后才不一样的模型会并成一个桶（实际不会有）
export const bucketRowOf = (stationId, bucket) => ({ station_id: stationId, slot_ms: bucket.slotMs, channel_id: bucket.channelId, model: clip(bucket.model, 128),
  upstream_model: clip(bucket.upstreamModel, 128), grp: clip(bucket.group, 64), semantic: clip(bucket.semantic, 12),
  ...Object.fromEntries(OWN_LOG_BUCKET_COLUMNS.map((column) => [column, Math.round(Number(bucket[FIELD_OF_COLUMN[column]]) || 0)])) });
export const bucketFromRow = (row) => ({ slotMs: Number(row.slot_ms), channelId: Number(row.channel_id), model: row.model, upstreamModel: row.upstream_model, group: row.grp, semantic: row.semantic,
  ...Object.fromEntries(OWN_LOG_BUCKET_COLUMNS.map((column) => [FIELD_OF_COLUMN[column], Number(row[column])])) });

const cursorFromRow = (row) => row ? { stationId: row.station_id, coveredFromMs: Number(row.covered_from_ms), coveredToMs: Number(row.covered_to_ms), updatedAtMs: Number(row.updated_at_ms),
  disabledFromMs: row.disabled_from_ms == null ? null : Number(row.disabled_from_ms), disabledToMs: row.disabled_to_ms == null ? null : Number(row.disabled_to_ms) } : null;

// 站点彻底删除、或者自营站点换了地址（同一个 id 读另一个站）时：进度和桶一起清掉，不然会从旧进度接着读新站点、两个站的数混在一个桶里
export async function forgetOwnLog(rt, stationId) {
  if (!rt?.pool) return;
  await (rt._ownLogStore ||= new OwnLogStore(rt.pool)).deleteStation(stationId);
}

export class OwnLogStore {
  constructor(pool) { this.pool = pool; }

  async getCursor(stationId) {
    const [rows] = await this.pool.query("SELECT station_id, covered_from_ms, covered_to_ms, updated_at_ms, disabled_from_ms, disabled_to_ms FROM own_log_cursor WHERE station_id = ?", [stationId]);
    return cursorFromRow(rows[0]);
  }

  // 第一次：从 fromMs 起读（已经有进度的不动）
  async startCursor(stationId, fromMs, now = Date.now()) {
    await this.pool.query("INSERT IGNORE INTO own_log_cursor (station_id, covered_from_ms, covered_to_ms, updated_at_ms) VALUES (?, ?, ?, ?)", [stationId, fromMs, fromMs, now]);
    return this.getCursor(stationId);
  }

  // 「算应付成本」关→开，进度比昨天 0 点还旧：把进度挪到 toMs，中间这段（原来的 covered_to_ms 到 toMs）记成跳过的缺口，
  // 不删桶（已经读进来的留着，补算用得上；总指挥 10-26 定第三轮）
  async skipCursor(stationId, toMs, now = Date.now()) {
    await this.pool.query(
      "UPDATE own_log_cursor SET disabled_from_ms = covered_to_ms, disabled_to_ms = ?, covered_to_ms = ?, updated_at_ms = ? WHERE station_id = ?",
      [toMs, toMs, now, stationId]);
    return this.getCursor(stationId);
  }

  // 读完一个窗口 [fromMs, toMs)：进度正好在 fromMs 才写。返回 true / false（进度不对没写）
  async applyWindow(stationId, { fromMs, toMs, buckets }, now = Date.now()) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query("SELECT covered_to_ms FROM own_log_cursor WHERE station_id = ? FOR UPDATE", [stationId]);
      if (!row || Number(row.covered_to_ms) !== fromMs) { await conn.rollback(); return false; }
      const rows = [...buckets].map((bucket) => bucketRowOf(stationId, bucket));
      // 一条语句最多 200 个桶；加起来写（ON DUPLICATE KEY UPDATE col = col + VALUES(col)）
      for (let at = 0; at < rows.length; at += 200) {
        const part = rows.slice(at, at + 200);
        const columns = ["station_id", "slot_ms", "channel_id", "model", "upstream_model", "grp", "semantic", ...OWN_LOG_BUCKET_COLUMNS];
        await conn.query(
          `INSERT INTO own_log_buckets (${columns.join(", ")}) VALUES ${part.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ")}
           ON DUPLICATE KEY UPDATE ${OWN_LOG_BUCKET_COLUMNS.map((column) => `${column} = ${column} + VALUES(${column})`).join(", ")}`,
          part.flatMap((item) => columns.map((column) => item[column])));
      }
      await conn.query("UPDATE own_log_cursor SET covered_to_ms = ?, updated_at_ms = ? WHERE station_id = ?", [toMs, now, stationId]);
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
  }

  // [fromSlotMs, toSlotMs) 的桶，V1-b 结账和对账用
  async listBuckets(stationId, fromSlotMs, toSlotMs) {
    const [rows] = await this.pool.query("SELECT * FROM own_log_buckets WHERE station_id = ? AND slot_ms >= ? AND slot_ms < ?", [stationId, fromSlotMs, toSlotMs]);
    return rows.map(bucketFromRow);
  }

  // 每小时清一批：beforeSlotMs 以前的桶，一次最多 limit 行
  async pruneBuckets(beforeSlotMs, limit = 2000) {
    const [result] = await this.pool.query("DELETE FROM own_log_buckets WHERE slot_ms < ? LIMIT ?", [beforeSlotMs, limit]);
    return Number(result?.affectedRows) || 0;
  }

  async deleteStation(stationId) {
    await this.pool.query("DELETE FROM own_log_buckets WHERE station_id = ?", [stationId]);
    await this.pool.query("DELETE FROM own_log_cursor WHERE station_id = ?", [stationId]);
  }
}
