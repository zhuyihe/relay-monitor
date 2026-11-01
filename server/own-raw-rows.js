// 自营站点数据看板的原始行，一个带缓存的读法（自营业务页和用户运营页共用，不各读各的）：
//   model：GET /api/data/        行按（模型、小时）
//   user ：GET /api/data/users   行按（用户名、小时）
//   flow ：GET /api/data/flow    窗口内按（用户、分组、模型、渠道）聚合，没有时间维度
// 缓存按「读的类型 + 站点 + 窗口」放在运行时里，缓存多久由调用方说（自营业务 2 分钟，用户运营 10 分钟）：
// 年龄不到调用方要的就直接用，所以两个页面在同一个时间窗里都打开，只读一次。同一份同时来几个请求，只发一个；读失败的不缓存。
// 结束时刻是「现在」的窗口（每次调用都不一样）按「现在这一份」算同一个窗口，不然每次都是新窗口、缓存永远用不上。
import { queryOwnData, queryOwnFlow } from "../lib/providers.js";

const KEEP_MS = 10 * 60000; // 最长的调用方也只要 10 分钟，放久了没用，还占内存（一个月的用户行上千用户时有十几 MB）
const MAX_ENTRIES = 12;
const OPEN_WINDOW_MS = 60000; // 结束时刻离现在不到这么久的，算「到现在为止」

export const OWN_ROW_READERS = Object.freeze({
  model: (own, startMs, endMs) => queryOwnData(own, startMs, endMs, "model"),
  user: (own, startMs, endMs) => queryOwnData(own, startMs, endMs, "user"),
  flow: (own, startMs, endMs) => queryOwnFlow(own, startMs, endMs),
});

// kind：model | user | flow；返回读到的行（调用方不要改它：同一份会给几个调用方）
// beforeRead：真的要发请求之前问一下（额度紧、断路时抛错就不发，这种不算「读失败」，不记）；命中缓存、跟着别人那一次读的不问
// failTtlMs：读失败了，这个窗口在这么久之内不再重试，直接给同一个错（默认 0，失败不缓存、下一次照读）。404、权限不够这种一直会失败的，
// 流失页签每分钟来取一次也不该每分钟都去用户的站上跑一次 30 天的汇总；只有传了它的调用方受影响，别的调用方（自营业务）行为不变
export async function readOwnRows(rt, own, kind, startMs, endMs, { ttlMs = 120000, now = Date.now(), readers = OWN_ROW_READERS, beforeRead = null, failTtlMs = 0 } = {}) {
  const read = readers[kind];
  if (!read) throw new Error(`unknown own rows kind: ${kind}`);
  const cache = (rt._ownRawRows ||= new Map());
  // 站点地址、令牌、用户 ID 一变就是另一份（换了站点不能用旧站点的数）；不把令牌本身放进键里，用配置版本号
  const key = [kind, own.id, own.baseUrl, own.userId || "", own.authVersion ?? "", startMs, endMs >= now - OPEN_WINDOW_MS ? "open" : endMs].join("|");
  const hit = cache.get(key);
  if (hit?.rows && now - hit.at < ttlMs) return hit.rows;
  if (hit?.error && failTtlMs > 0 && now - hit.at < failTtlMs) throw hit.error;
  if (hit?.promise) return hit.promise;
  const startedAt = now;
  let skipped = false; // beforeRead 拦下的，没发请求
  const promise = (async () => {
    if (beforeRead) { try { beforeRead(); } catch (error) { skipped = true; throw error; } }
    return read(own, startMs, endMs);
  })().then((rows) => {
    if (cache.get(key)?.promise === promise) {
      const entry = { at: startedAt, rows };
      cache.set(key, entry);
      // 到期就放掉（没人再来取也不一直占着）；不拦进程退出
      setTimeout(() => { if (cache.get(key) === entry) cache.delete(key); }, KEEP_MS).unref?.();
    }
    return rows;
  }, (error) => {
    if (cache.get(key)?.promise === promise) {
      if (failTtlMs > 0 && !skipped) {
        const entry = { at: startedAt, error };
        cache.set(key, entry);
        setTimeout(() => { if (cache.get(key) === entry) cache.delete(key); }, failTtlMs).unref?.();
      } else cache.delete(key);
    }
    throw error;
  });
  cache.set(key, { promise, at: startedAt });
  // 太老的、太多的清掉
  for (const [oldKey, entry] of cache) if (entry.rows && now - entry.at > KEEP_MS) cache.delete(oldKey);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return promise;
}
