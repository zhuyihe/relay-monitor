// OwnLogStore 的内存实现（测试用）：和 MySQL 版同一组契约用例（server/test-support/own-log-store-contract.js）
import { CONSUME_SPEC } from "../own-log-store.js";
import { randomUUID } from "node:crypto";

export class MemoryOwnLogStore {
  constructor(spec = CONSUME_SPEC) { this.spec = spec; this.cursors = new Map(); this.buckets = new Map(); this.pending = new Map(); this.writes = 0; this.failNextApply = false; }
  async getCursor(stationId) { const c = this.cursors.get(stationId); return c ? { stationId, ...c } : null; }
  async startCursor(stationId, fromMs, now = Date.now()) {
    if (!this.cursors.has(stationId)) this.cursors.set(stationId, { coveredFromMs: fromMs, coveredToMs: fromMs, updatedAtMs: now, disabledFromMs: null, disabledToMs: null });
    return this.getCursor(stationId);
  }
  async getPending(stationId) { return structuredClone(this.pending.get(stationId) ?? null); }
  async savePending(stationId, pending, { expectedRevision = null } = {}, now = Date.now()) {
    const cursor = this.cursors.get(stationId), prior = this.pending.get(stationId);
    if (!cursor || cursor.coveredToMs !== pending.fromMs || (prior?.revision ?? null) !== expectedRevision
      || (prior && (prior.fromMs !== pending.fromMs || prior.toMs !== pending.toMs))) return false;
    const saved = structuredClone({ ...pending, revision: randomUUID() });
    this.pending.set(stationId, saved);
    return structuredClone(saved);
  }
  async discardPending(stationId, { expectedRevision, fromMs, expectedCoveredToMs = fromMs }) {
    const cursor = this.cursors.get(stationId), pending = this.pending.get(stationId);
    if (!cursor || cursor.coveredToMs !== expectedCoveredToMs || !pending || pending.fromMs !== fromMs || pending.revision !== expectedRevision) return false;
    this.pending.delete(stationId);
    return true;
  }
  async skipCursor(stationId, toMs, now = Date.now()) {
    const cursor = this.cursors.get(stationId);
    if (!cursor) return null;
    cursor.disabledFromMs = cursor.disabledFromMs ?? cursor.coveredToMs; cursor.disabledToMs = toMs; cursor.coveredToMs = toMs; cursor.updatedAtMs = now;
    this.pending.delete(stationId);
    return this.getCursor(stationId);
  }
  async applyWindow(stationId, { fromMs, toMs, buckets, pendingRevision }, now = Date.now()) {
    const cursor = this.cursors.get(stationId);
    if (!cursor || cursor.coveredToMs !== fromMs) return false;
    if (pendingRevision !== undefined) {
      const pending = this.pending.get(stationId);
      if (!pending || pending.revision !== pendingRevision || pending.fromMs !== fromMs || pending.toMs !== toMs || pending.complete !== true) return false;
    }
    if (this.failNextApply) { this.failNextApply = false; throw new Error("simulated write failure"); }
    for (const bucket of buckets) {
      const row = this.spec.rowOf(stationId, bucket), key = `${stationId}|${this.spec.keyOf(this.spec.fromRow(row))}`;
      const existing = this.buckets.get(key);
      if (existing) for (const column of this.spec.counterColumns) existing[column] += row[column];
      else this.buckets.set(key, { ...row });
    }
    cursor.coveredToMs = toMs; cursor.updatedAtMs = now; this.writes += 1;
    this.pending.delete(stationId);
    return true;
  }
  async listBuckets(stationId, fromSlotMs, toSlotMs) {
    return [...this.buckets.values()].filter((row) => row.station_id === stationId && row.slot_ms >= fromSlotMs && row.slot_ms < toSlotMs).map(this.spec.fromRow);
  }
  async pruneBuckets(beforeSlotMs, limit = 2000) {
    let n = 0;
    for (const [key, row] of this.buckets) if (row.slot_ms < beforeSlotMs && n < limit) { this.buckets.delete(key); n += 1; }
    return n;
  }
  async deleteStation(stationId) {
    this.cursors.delete(stationId);
    this.pending.delete(stationId);
    for (const [key, row] of this.buckets) if (row.station_id === stationId) this.buckets.delete(key);
  }
}
