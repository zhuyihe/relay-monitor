// UpstreamSpendStore 的内存实现（单测用），接口和 server/upstream-spend-store.js 一样，跑同一组契约用例
export class MemoryUpstreamSpendStore {
  constructor() { this.days = new Map(); this.states = new Map(); this.calls = { putDays: 0, saveState: 0, prune: 0, listDays: 0 }; }

  async listDays(stationIds, fromDay, toDay) {
    this.calls.listDays += 1;
    const ids = new Set((stationIds || []).map(String));
    return [...this.days.values()].filter((row) => ids.has(row.stationId) && row.day >= fromDay && row.day <= toDay)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.stationId < b.stationId ? -1 : 1)).map((row) => ({ ...row }));
  }

  async putDays(stationId, rows) {
    this.calls.putDays += 1;
    for (const row of rows) this.days.set(`${stationId}|${row.day}`, { stationId: String(stationId), day: row.day, usd: Math.max(0, Number(row.usd) || 0) });
    return rows.length;
  }

  async listStates() { return new Map([...this.states].map(([id, state]) => [id, { ...state }])); }

  async saveState(stationId, state) {
    this.calls.saveState += 1;
    this.states.set(String(stationId), { stationId: String(stationId), status: state.status, source: state.source ?? null, readThrough: state.readThrough ?? null, deniedCode: state.deniedCode ?? null, checkedAt: Math.round(state.checkedAt) });
  }

  async prune(beforeDay) {
    this.calls.prune += 1;
    let deleted = 0;
    for (const [key, row] of [...this.days]) if (row.day < beforeDay) { this.days.delete(key); deleted += 1; }
    return deleted;
  }

  async deleteStation(stationId) {
    for (const [key, row] of [...this.days]) if (row.stationId === String(stationId)) this.days.delete(key);
    this.states.delete(String(stationId));
  }
}
