// OwnLogStore 的内存实现（测试用）：和 MySQL 版同一组契约用例（server/test-support/own-log-store-contract.js）
import { bucketFromRow, bucketRowOf, OWN_LOG_BUCKET_COLUMNS } from "../own-log-store.js";
import { bucketKeyOf } from "../../lib/own-log-bucket.js";

export class MemoryOwnLogStore {
  constructor() { this.cursors = new Map(); this.buckets = new Map(); this.writes = 0; this.failNextApply = false; }
  async getCursor(stationId) { const c = this.cursors.get(stationId); return c ? { stationId, ...c } : null; }
  async startCursor(stationId, fromMs, now = Date.now()) {
    if (!this.cursors.has(stationId)) this.cursors.set(stationId, { coveredFromMs: fromMs, coveredToMs: fromMs, updatedAtMs: now, disabledFromMs: null, disabledToMs: null });
    return this.getCursor(stationId);
  }
  async skipCursor(stationId, toMs, now = Date.now()) {
    const cursor = this.cursors.get(stationId);
    if (!cursor) return null;
    cursor.disabledFromMs = cursor.disabledFromMs ?? cursor.coveredToMs; cursor.disabledToMs = toMs; cursor.coveredToMs = toMs; cursor.updatedAtMs = now;
    return this.getCursor(stationId);
  }
  async applyWindow(stationId, { fromMs, toMs, buckets }, now = Date.now()) {
    const cursor = this.cursors.get(stationId);
    if (!cursor || cursor.coveredToMs !== fromMs) return false;
    if (this.failNextApply) { this.failNextApply = false; throw new Error("simulated write failure"); }
    for (const bucket of buckets) {
      const row = bucketRowOf(stationId, bucket), key = `${stationId}|${bucketKeyOf(bucketFromRow(row))}`;
      const existing = this.buckets.get(key);
      if (existing) for (const column of OWN_LOG_BUCKET_COLUMNS) existing[column] += row[column];
      else this.buckets.set(key, { ...row });
    }
    cursor.coveredToMs = toMs; cursor.updatedAtMs = now; this.writes += 1;
    return true;
  }
  async listBuckets(stationId, fromSlotMs, toSlotMs) {
    return [...this.buckets.values()].filter((row) => row.station_id === stationId && row.slot_ms >= fromSlotMs && row.slot_ms < toSlotMs).map(bucketFromRow);
  }
  async pruneBuckets(beforeSlotMs, limit = 2000) {
    let n = 0;
    for (const [key, row] of this.buckets) if (row.slot_ms < beforeSlotMs && n < limit) { this.buckets.delete(key); n += 1; }
    return n;
  }
  async deleteStation(stationId) {
    this.cursors.delete(stationId);
    for (const [key, row] of this.buckets) if (row.station_id === stationId) this.buckets.delete(key);
  }
}
