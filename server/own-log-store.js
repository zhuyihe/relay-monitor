// 自营站点整站消费日志的小时桶和读取进度（应付成本 V1-a，计划 v1-plan 第 3 节）。
// own_log_cursor：每个自营站点一行，covered_to_ms 之前（从 covered_from_ms 起）的日志都已经读进桶里；
// own_log_buckets：按（站点、小时、渠道、模型、上游模型、分组、缓存口径）加起来的数。
// 读一个窗口 = 一个事务：核对进度正好停在这个窗口的起点，数加进桶，进度挪到窗口终点；进度对不上（别的进程先写了）就不写，返回 false。
// 这样重启接着读、两个进程同时读都不会把同一段日志加两次。
// 同一个存取类服务两条读日志的流水线（server/own-log-ingest.js）：消费日志（type 2，上面这三张表）和错误日志（type 5，own_error_cursor /
// own_error_pending / own_error_buckets，只存次数，模型供需用）；两条的差别只在表名和桶的列，写成一份 spec 传进来（CONSUME_SPEC / ERROR_SPEC），
// 进度、暂存、事务、清理的逻辑是同一份。
import { randomUUID } from "node:crypto";
import { errorBucketKeyOf } from "../lib/own-error-bucket.js";
import { bucketKeyOf } from "../lib/own-log-bucket.js";
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


// 错误日志的桶（own_error_buckets）：主键是（站点、小时、渠道、模型、分组、原因、状态码、第几次尝试），只有一个计数 count
export const OWN_ERROR_BUCKET_COLUMNS = Object.freeze(["count"]);
export const errorBucketRowOf = (stationId, bucket) => ({ station_id: stationId, slot_ms: bucket.slotMs, channel_id: Math.max(0, Math.trunc(Number(bucket.channelId)) || 0), model: clip(bucket.model, 128),
  grp: clip(bucket.group, 64), reason: clip(bucket.reason, 12), status_code: Math.max(0, Math.trunc(Number(bucket.status)) || 0), attempt: Math.min(3, Math.max(1, Math.trunc(Number(bucket.attempt)) || 1)),
  count: Math.round(Number(bucket.count) || 0) });
export const errorBucketFromRow = (row) => ({ slotMs: Number(row.slot_ms), channelId: Number(row.channel_id), model: row.model, group: row.grp, reason: row.reason, status: Number(row.status_code), attempt: Number(row.attempt), count: Number(row.count) });

export const CONSUME_SPEC = Object.freeze({
  name: "consume", cursor: "own_log_cursor", pending: "own_log_pending", buckets: "own_log_buckets",
  keyColumns: Object.freeze(["station_id", "slot_ms", "channel_id", "model", "upstream_model", "grp", "semantic"]), counterColumns: OWN_LOG_BUCKET_COLUMNS,
  rowOf: bucketRowOf, fromRow: bucketFromRow, keyOf: bucketKeyOf,
});
export const ERROR_SPEC = Object.freeze({
  name: "error", cursor: "own_error_cursor", pending: "own_error_pending", buckets: "own_error_buckets",
  keyColumns: Object.freeze(["station_id", "slot_ms", "channel_id", "model", "grp", "reason", "status_code", "attempt"]), counterColumns: OWN_ERROR_BUCKET_COLUMNS,
  rowOf: errorBucketRowOf, fromRow: errorBucketFromRow, keyOf: errorBucketKeyOf,
});

const cursorFromRow = (row) => row ? { stationId: row.station_id, coveredFromMs: Number(row.covered_from_ms), coveredToMs: Number(row.covered_to_ms), updatedAtMs: Number(row.updated_at_ms),
  disabledFromMs: row.disabled_from_ms == null ? null : Number(row.disabled_from_ms), disabledToMs: row.disabled_to_ms == null ? null : Number(row.disabled_to_ms) } : null;

const pendingFromRow = (row) => {
  if (!row) return null;
  const state = typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json;
  return { ...state, fromMs: Number(row.from_ms), toMs: Number(row.to_ms), nextPage: Number(row.next_page), revision: row.revision };
};

// 站点彻底删除、或者自营站点换了地址（同一个 id 读另一个站）时：进度和桶一起清掉，不然会从旧进度接着读新站点、两个站的数混在一个桶里
export async function forgetOwnLog(rt, stationId) {
  if (!rt?.pool) return;
  await (rt._ownLogStore ||= new OwnLogStore(rt.pool)).deleteStation(stationId);
  await (rt._ownErrorStore ||= new OwnLogStore(rt.pool, ERROR_SPEC)).deleteStation(stationId);
}

export class OwnLogStore {
  constructor(pool, spec = CONSUME_SPEC) { this.pool = pool; this.spec = spec; }

  async getCursor(stationId) {
    const [rows] = await this.pool.query(`SELECT station_id, covered_from_ms, covered_to_ms, updated_at_ms, disabled_from_ms, disabled_to_ms FROM ${this.spec.cursor} WHERE station_id = ?`, [stationId]);
    return cursorFromRow(rows[0]);
  }

  // 第一次：从 fromMs 起读（已经有进度的不动）
  async startCursor(stationId, fromMs, now = Date.now()) {
    await this.pool.query(`INSERT IGNORE INTO ${this.spec.cursor} (station_id, covered_from_ms, covered_to_ms, updated_at_ms) VALUES (?, ?, ?, ?)`, [stationId, fromMs, fromMs, now]);
    return this.getCursor(stationId);
  }

  // 暂存只含日志 id 和已归类的桶；尚未读完整的窗口不影响报表覆盖范围。
  async getPending(stationId) {
    const [[row]] = await this.pool.query(`SELECT from_ms, to_ms, next_page, revision, state_json FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
    return pendingFromRow(row);
  }

  // 锁住同一条 cursor，让保存暂存、提交窗口、跳过和删除相互串行。
  // 独立随机 revision 防止旧 worker 覆盖新状态（包括清除后又创建同一窗口的 ABA）。
  async savePending(stationId, pending, { expectedRevision = null } = {}, now = Date.now()) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[cursor]] = await conn.query(`SELECT covered_to_ms FROM ${this.spec.cursor} WHERE station_id = ? FOR UPDATE`, [stationId]);
      const [[prior]] = await conn.query(`SELECT from_ms, to_ms, next_page, revision, state_json FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
      if (!cursor || Number(cursor.covered_to_ms) !== pending.fromMs
        || (prior?.revision ?? null) !== expectedRevision
        || (prior && (Number(prior.from_ms) !== pending.fromMs || Number(prior.to_ms) !== pending.toMs))) {
        await conn.rollback(); return false;
      }
      const saved = { ...pending, revision: randomUUID() };
      const stateJson = JSON.stringify(saved);
      await conn.query(`INSERT INTO ${this.spec.pending} (station_id, from_ms, to_ms, next_page, revision, state_json, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE from_ms = VALUES(from_ms), to_ms = VALUES(to_ms),
        next_page = VALUES(next_page), revision = VALUES(revision), state_json = VALUES(state_json), updated_at_ms = VALUES(updated_at_ms)`,
      [stationId, saved.fromMs, saved.toMs, saved.nextPage, saved.revision, stateJson, now]);
      await conn.commit();
      return JSON.parse(stateJson);
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
  }

  // 来源总数或归类口径改变时只废弃未提交窗口，下一轮从同一覆盖起点重读。
  // 仍按 revision 做 CAS，不能让旧 worker 删掉别人刚读到的新一页。
  async discardPending(stationId, { expectedRevision, fromMs, expectedCoveredToMs = fromMs }) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[cursor]] = await conn.query(`SELECT covered_to_ms FROM ${this.spec.cursor} WHERE station_id = ? FOR UPDATE`, [stationId]);
      const [[pending]] = await conn.query(`SELECT from_ms, revision FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
      if (!cursor || Number(cursor.covered_to_ms) !== expectedCoveredToMs || !pending
        || Number(pending.from_ms) !== fromMs || pending.revision !== expectedRevision) {
        await conn.rollback(); return false;
      }
      await conn.query(`DELETE FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
  }

  // 「算应付成本」关→开，进度比昨天 0 点还旧：把进度挪到 toMs，中间这段（原来的 covered_to_ms 到 toMs）记成跳过的缺口，
  // 不删桶（已经读进来的留着，补算用得上；总指挥 10-26 定第三轮）。已经有一段没补上的缺口（第二次关→开，中间那段「开着」的
  // 日子还没来得及补算）：两段缺口并成一段记（偏保守——中间那段原本读全了的日子也会被算成缺口，但不会漏；只记一段，
  // 不改表结构记多段；审核 R2 #125 第三轮 中-E）
  async skipCursor(stationId, toMs, now = Date.now()) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`SELECT covered_to_ms FROM ${this.spec.cursor} WHERE station_id = ? FOR UPDATE`, [stationId]);
      await conn.query(
        `UPDATE ${this.spec.cursor} SET disabled_from_ms = COALESCE(disabled_from_ms, covered_to_ms), disabled_to_ms = ?, covered_to_ms = ?, updated_at_ms = ? WHERE station_id = ?`,
        [toMs, toMs, now, stationId]);
      await conn.query(`DELETE FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
    return this.getCursor(stationId);
  }

  // 读完一个窗口 [fromMs, toMs)：进度正好在 fromMs 才写。返回 true / false（进度不对没写）
  async applyWindow(stationId, { fromMs, toMs, buckets, pendingRevision }, now = Date.now()) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]] = await conn.query(`SELECT covered_to_ms FROM ${this.spec.cursor} WHERE station_id = ? FOR UPDATE`, [stationId]);
      if (!row || Number(row.covered_to_ms) !== fromMs) { await conn.rollback(); return false; }
      if (pendingRevision !== undefined) {
        const [[pendingRow]] = await conn.query(`SELECT from_ms, to_ms, next_page, revision, state_json FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
        const pending = pendingFromRow(pendingRow);
        if (!pending || pending.revision !== pendingRevision || pending.fromMs !== fromMs || pending.toMs !== toMs || pending.complete !== true) {
          await conn.rollback(); return false;
        }
      }
      const rows = [...buckets].map((bucket) => this.spec.rowOf(stationId, bucket));
      // 一条语句最多 200 个桶；加起来写（ON DUPLICATE KEY UPDATE col = col + VALUES(col)）
      for (let at = 0; at < rows.length; at += 200) {
        const part = rows.slice(at, at + 200);
        const columns = [...this.spec.keyColumns, ...this.spec.counterColumns];
        await conn.query(
          `INSERT INTO ${this.spec.buckets} (${columns.join(", ")}) VALUES ${part.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ")}
           ON DUPLICATE KEY UPDATE ${this.spec.counterColumns.map((column) => `${column} = ${column} + VALUES(${column})`).join(", ")}`,
          part.flatMap((item) => columns.map((column) => item[column])));
      }
      await conn.query(`UPDATE ${this.spec.cursor} SET covered_to_ms = ?, updated_at_ms = ? WHERE station_id = ?`, [toMs, now, stationId]);
      await conn.query(`DELETE FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
  }

  // [fromSlotMs, toSlotMs) 的桶，V1-b 结账和对账用
  async listBuckets(stationId, fromSlotMs, toSlotMs) {
    const [rows] = await this.pool.query(`SELECT * FROM ${this.spec.buckets} WHERE station_id = ? AND slot_ms >= ? AND slot_ms < ?`, [stationId, fromSlotMs, toSlotMs]);
    return rows.map(this.spec.fromRow);
  }

  // 每小时清一批：beforeSlotMs 以前的桶，一次最多 limit 行
  async pruneBuckets(beforeSlotMs, limit = 2000) {
    const [result] = await this.pool.query(`DELETE FROM ${this.spec.buckets} WHERE slot_ms < ? LIMIT ?`, [beforeSlotMs, limit]);
    return Number(result?.affectedRows) || 0;
  }

  async deleteStation(stationId) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`SELECT covered_to_ms FROM ${this.spec.cursor} WHERE station_id = ? FOR UPDATE`, [stationId]);
      await conn.query(`DELETE FROM ${this.spec.pending} WHERE station_id = ?`, [stationId]);
      await conn.query(`DELETE FROM ${this.spec.buckets} WHERE station_id = ?`, [stationId]);
      await conn.query(`DELETE FROM ${this.spec.cursor} WHERE station_id = ?`, [stationId]);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
  }
}
