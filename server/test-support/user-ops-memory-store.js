// UserOpsStore 的内存实现（单测用），接口和 server/user-ops-store.js 一样，跑同一组契约用例
const PROGRESS_FIELDS = ["backfillCursorMs", "backfillTargetMs", "backfillStartedMs", "usageSyncedMs", "balanceSyncedMs"];

export class MemoryUserOpsStore {
  constructor() { this.usage = new Map(); this.points = new Map(); this.progress = new Map(); this.alerts = new Map(); this.calls = { upsertUsageHours: 0, addBalancePoints: 0, listUsageHours: 0 }; }

  async upsertUsageHours(stationId, rows) {
    this.calls.upsertUsageHours += 1;
    for (const row of rows) this.usage.set(`${stationId}|${row.username}|${Math.round(row.hourMs)}`, { stationId, username: String(row.username), hourMs: Math.round(row.hourMs), quota: Math.round(row.quota) || 0, requests: Math.round(row.requests) || 0 });
    return rows.length;
  }

  async listUsageHours(stationId, fromMs, toMs = Number.MAX_SAFE_INTEGER) {
    this.calls.listUsageHours += 1;
    return [...this.usage.values()].filter((row) => row.stationId === stationId && row.hourMs >= fromMs && row.hourMs < toMs).map(({ username, hourMs, quota }) => ({ username, hourMs, quota }));
  }

  async addBalancePoints(stationId, rows) {
    this.calls.addBalancePoints += 1;
    for (const row of rows) { const key = `${stationId}|${Number(row.userId)}|${Math.round(row.t)}`; if (!this.points.has(key)) this.points.set(key, { stationId, userId: Number(row.userId), t: Math.round(row.t), balanceUsd: row.balanceUsd }); }
  }

  async lastBalancePoints(stationId) {
    const out = new Map();
    for (const row of this.points.values()) if (row.stationId === stationId && (!out.has(row.userId) || out.get(row.userId).t < row.t)) out.set(row.userId, { t: row.t, balanceUsd: row.balanceUsd });
    return out;
  }

  async listBalancePoints(stationId, sinceMs) {
    const out = new Map();
    for (const row of [...this.points.values()].filter((item) => item.stationId === stationId && item.t >= sinceMs).sort((a, b) => a.userId - b.userId || a.t - b.t)) {
      if (!out.has(row.userId)) out.set(row.userId, []);
      out.get(row.userId).push([row.t, row.balanceUsd]);
    }
    return out;
  }

  async getProgress(stationId) { return this.progress.has(stationId) ? { stationId, ...this.progress.get(stationId) } : null; }

  async saveProgress(stationId, patch) {
    const current = this.progress.get(stationId) || Object.fromEntries(PROGRESS_FIELDS.map((field) => [field, null]));
    for (const field of PROGRESS_FIELDS) if (field in patch) current[field] = patch[field] == null ? null : Number(patch[field]);
    this.progress.set(stationId, current);
    return this.getProgress(stationId);
  }

  async getAlertStates(stationId) {
    const out = new Map();
    for (const [key, state] of this.alerts) { const [station, user] = key.split("|"); if (station === stationId) out.set(Number(user), { ...state }); }
    return out;
  }

  async saveAlertState(stationId, userId, state) {
    this.alerts.set(`${stationId}|${Number(userId)}`, { level: state.level, notifiedAt: state.notifiedAt ?? null, lastBalanceUsd: state.lastBalanceUsd ?? null });
  }

  async prune(stationId, { usageBeforeMs, balanceBeforeMs }, limit = 5000) {
    let usage = 0, balance = 0;
    for (const [key, row] of this.usage) if (usage < limit && row.stationId === stationId && row.hourMs < usageBeforeMs) { this.usage.delete(key); usage += 1; }
    for (const [key, row] of this.points) if (balance < limit && row.stationId === stationId && row.t < balanceBeforeMs) { this.points.delete(key); balance += 1; }
    return { usage, balance };
  }

  async deleteStation(stationId) {
    for (const map of [this.usage, this.points]) for (const [key, row] of map) if (row.stationId === stationId) map.delete(key);
    this.progress.delete(stationId);
    for (const key of [...this.alerts.keys()]) if (key.startsWith(`${stationId}|`)) this.alerts.delete(key);
  }
}
