// 自营站点整站消费日志的增量读（应付成本 V1-a，计划 v1-plan 第 3 节；总指挥 10-26：对你站零压力）。
// 每轮（跟着结账轮询）每个自营站点：
//   - 先问额度和断路（lib/own-request-budget.js）：断路期间不读；最近 180 秒剩余不到「留给别人的」不读；这轮最多用额度的一份；
//   - 从进度（own_log_cursor.covered_to_ms）起，一个小窗口一个小窗口往前读到「现在 − 120 秒」为止（最新的日志还在陆续入账，留 120 秒）；
//   - 窗口大小自适应：第一页就知道这个窗口有多少条，超过 PAGES_PER_WINDOW 页就对半切（/api/log/ 每页都要 COUNT 一次，窗口小 COUNT 才便宜，翻页也不深）；
//     很稀的窗口翻倍，上限 1 小时；下限 1 分钟（1 分钟里超过 300 条的站点，每页照样 100 条，只是 COUNT 的范围已经最小）；
//   - 每轮最多 MAX_PAGES_PER_ROUND 页、MAX_ROUND_MS 毫秒，到了就停，下一轮接着（补数据也是这么慢慢补，不一口气翻完一整天）；
//   - 第一次跑只从昨天 0 点（业务时区）起，不往前补更早的；
//   - 每个窗口读完才写库（桶加进去、进度挪到窗口终点，一个事务），读到一半出错整个窗口不写，下一轮从窗口起点重来；
//   - 任何一次 429、5xx、超时、连不上：request() 已经让断路器断开，这里停下这轮。
// 桶里顺手记下管理员自用额度、不在管理员名下的渠道测试额度（和 R1 同一个规矩，server/own-helpers.js 的管理员名单），V1 只用来和 R1 对账打日志。
import { OWN_LOG_SLOT_MS, accumulateBuckets } from "../lib/own-log-bucket.js";
import { ingestAllowance } from "../lib/own-request-budget.js";
import { queryOwnLogWindow } from "../lib/providers.js";
import { businessTimeZone, dayStartInTz, dayKeyInTz, shiftedDayStartInTz } from "../lib/business-time.js";
import { readOwnAdminDirectory, resoldAdminKeysOf } from "./own-helpers.js";

export const INGEST = Object.freeze({
  LAG_MS: 120000,
  MAX_PAGES_PER_ROUND: 6,
  MAX_ROUND_MS: 20000,
  PAGES_PER_WINDOW: 3, // 一个窗口超过这么多页就对半切
  WINDOW_MIN_MS: 60000,
  WINDOW_START_MS: 10 * 60000,
  WINDOW_MAX_MS: 3600000,
  PAGE_SIZE: 100,
  KEEP_DAYS: 35, // 桶留 35 天（比「本月」最长的范围多几天）
});

const ownBase = (own) => String(own?.baseUrl || "").replace(/\/+$/, "");

export function createOwnLogIngest(rt, { store, now = () => Date.now(), log = () => {} } = {}) {
  const windowSizes = new Map(); // 站点 id → 现在用的窗口大小（自适应，进程内）
  let lastPruneAt = 0;

  // 第一次：从昨天 0 点（业务时区）起读
  const firstFromMs = (at) => shiftedDayStartInTz(dayStartInTz(dayKeyInTz(at, businessTimeZone()), businessTimeZone()), -1, businessTimeZone());

  async function ingestOnce(own) {
    if (!own?.isOwn || own.type !== "newapi") return { skipped: "not-own" };
    const at = now();
    const allowance = ingestAllowance(ownBase(own), { now: at });
    if (!allowance.allowed) return { skipped: allowance.reason, pages: 0 };
    // 管理员名单读不到这轮不读（进度也不建）：桶里「管理员自用」会算错，而且错了就留在桶里
    let adminSet, resoldKeys;
    try { ({ adminSet } = await readOwnAdminDirectory(rt, own)); resoldKeys = resoldAdminKeysOf(own); }
    catch (error) { return { skipped: "admins", pages: 0, error: error?.code || error?.message }; }
    const cursor = (await store.getCursor(own.id)) ?? (await store.startCursor(own.id, firstFromMs(at), at));
    const horizon = at - INGEST.LAG_MS;
    if (cursor.coveredToMs >= horizon) return { skipped: "caught-up", pages: 0, coveredToMs: cursor.coveredToMs };
    let budget = Math.min(allowance.allowed, INGEST.MAX_PAGES_PER_ROUND), pages = 0, windows = 0;
    const deadline = at + INGEST.MAX_ROUND_MS;
    let coveredTo = cursor.coveredToMs;
    let windowMs = windowSizes.get(own.id) ?? INGEST.WINDOW_START_MS;
    while (budget > 0 && coveredTo < horizon && now() < deadline) {
      const fromMs = coveredTo, toMs = Math.min(fromMs + windowMs, horizon);
      let first;
      try { first = await queryOwnLogWindow(own, { startMs: fromMs, endMs: toMs, page: 1 }); }
      catch (error) { log("own-log-ingest", own.id, "read failed", error?.code || error?.message); return { pages, windows, coveredToMs: coveredTo, error: error?.code || "read" }; }
      budget -= 1; pages += 1;
      const total = first.total ?? (first.items.length < INGEST.PAGE_SIZE ? first.items.length : null);
      const needPages = total == null ? INGEST.PAGES_PER_WINDOW + 1 : Math.ceil(total / INGEST.PAGE_SIZE);
      // 窗口太满：对半切，这一页白读了但下一个窗口小一半（最小 1 分钟，到了下限只能硬读）
      if (needPages > INGEST.PAGES_PER_WINDOW && toMs - fromMs > INGEST.WINDOW_MIN_MS) {
        windowMs = Math.max(INGEST.WINDOW_MIN_MS, Math.floor((toMs - fromMs) / 2));
        windowSizes.set(own.id, windowMs);
        continue;
      }
      if (needPages - 1 > budget) { windowSizes.set(own.id, windowMs); break; } // 这轮剩的额度翻不完这个窗口：下一轮从头读它
      const seen = new Set(), rows = [];
      const take = (items) => { for (const row of items) { const id = Number(row?.id); if (Number.isFinite(id)) { if (seen.has(id)) continue; seen.add(id); } rows.push(row); } };
      take(first.items);
      let page = 2, more = first.items.length >= INGEST.PAGE_SIZE && (total == null || rows.length < total);
      let failed = null;
      while (more && budget > 0) {
        let next;
        try { next = await queryOwnLogWindow(own, { startMs: fromMs, endMs: toMs, page }); } catch (error) { failed = error; break; }
        budget -= 1; pages += 1; page += 1;
        take(next.items);
        more = next.items.length >= INGEST.PAGE_SIZE && (total == null ? page <= INGEST.PAGES_PER_WINDOW + 1 : rows.length < total);
      }
      if (failed) { log("own-log-ingest", own.id, "read failed", failed?.code || failed?.message); return { pages, windows, coveredToMs: coveredTo, error: failed?.code || "read" }; }
      if (more) { windowSizes.set(own.id, windowMs); break; } // 额度用完还没翻完：这个窗口不写，下一轮从头读
      const buckets = accumulateBuckets(rows, { adminSet, resoldKeys });
      const applied = await store.applyWindow(own.id, { fromMs, toMs, buckets: buckets.values() }, now());
      if (!applied) return { pages, windows, coveredToMs: coveredTo, error: "cursor-moved" }; // 别的进程先写了：下一轮按库里的进度来
      coveredTo = toMs; windows += 1;
      // 很稀：窗口翻倍（上限 1 小时）
      if (rows.length < INGEST.PAGE_SIZE / 2 && toMs - fromMs >= windowMs) windowMs = Math.min(INGEST.WINDOW_MAX_MS, windowMs * 2);
      windowSizes.set(own.id, windowMs);
    }
    return { pages, windows, coveredToMs: coveredTo };
  }

  // 每小时清一批 35 天前的桶
  async function pruneIfDue() {
    const at = now();
    if (at - lastPruneAt < 3600000) return 0;
    lastPruneAt = at;
    const beforeSlot = Math.floor((at - INGEST.KEEP_DAYS * 86400000) / OWN_LOG_SLOT_MS) * OWN_LOG_SLOT_MS;
    try { return await store.pruneBuckets(beforeSlot); } catch { return 0; }
  }

  return { ingestOnce, pruneIfDue, windowSizes };
}
