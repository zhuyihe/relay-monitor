// 上游价目表（应付成本 V1-a）：每个 New API 上游每小时读一次 GET /api/pricing（内存缓存），读不到的 10 分钟后再试，
// 期间返回上次读到的（有的话）或者带码的错（MODEL_PRICE_UNREADABLE 等），调用方给「—」加原因。
// 价目表只给 New API 上游：Sub2API 没有通用价目（UPSTREAM_PRICE_UNSUPPORTED），V1 不做。
import { pricingTableOf } from "../lib/expected-cost.js";
import { queryUpstreamPricing } from "../lib/providers.js";

export const PRICING_TTL_MS = 3600000;
export const PRICING_RETRY_MS = 10 * 60000;

export function createUpstreamPricing(rt, { now = () => Date.now(), read = queryUpstreamPricing } = {}) {
  const cache = new Map(); // 站点 id → { table, readAt, error, failedAt, inflight }
  async function pricingFor(station) {
    if (!station || station.isOwn) throw Object.assign(new Error("不是上游"), { code: "UPSTREAM_PRICE_UNSUPPORTED" });
    if (station.type !== "newapi") throw Object.assign(new Error("这种上游没有价目表"), { code: "UPSTREAM_PRICE_UNSUPPORTED" });
    const at = now();
    const entry = cache.get(station.id) || {};
    if (entry.table && at - entry.readAt < PRICING_TTL_MS) return entry.table;
    if (entry.error && at - entry.failedAt < PRICING_RETRY_MS) { if (entry.table) return entry.table; throw entry.error; }
    if (entry.inflight) return entry.inflight;
    const inflight = (async () => {
      try {
        const table = pricingTableOf(await read(station));
        cache.set(station.id, { table, readAt: now(), error: null, failedAt: 0 });
        return table;
      } catch (error) {
        const code = error?.code && error.code !== "UPSTREAM_REQUEST_FAILED" ? error.code : "MODEL_PRICE_UNREADABLE";
        const failure = Object.assign(new Error(error?.message || "读取上游价目表失败"), { code, cause: error });
        cache.set(station.id, { table: entry.table ?? null, readAt: entry.readAt ?? 0, error: failure, failedAt: now() });
        if (entry.table) return entry.table;
        throw failure;
      } finally { const current = cache.get(station.id); if (current) current.inflight = null; }
    })();
    cache.set(station.id, { ...entry, inflight });
    return inflight;
  }
  return { pricingFor, invalidate: (stationId) => (stationId ? cache.delete(stationId) : cache.clear()) };
}
