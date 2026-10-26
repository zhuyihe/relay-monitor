// 自营站点整站消费日志的增量读（应付成本 V1-a，计划 v1-plan 第 3 节；总指挥 10-26：对你站零压力）。
// 每轮（跟着结账轮询）每个自营站点：
//   - 先问额度和断路（lib/own-request-budget.js）：断路期间不读；最近 180 秒剩余不到「留给别人的」不读；这轮最多用额度的一份；
//   - 从进度（own_log_cursor.covered_to_ms）起，一个小窗口一个小窗口往前读到「现在 − 120 秒」为止（最新的日志还在陆续入账，留 120 秒）；
//     窗口的两头都对齐到整秒（站点的 start/end 按秒、两头包含；不对齐的话边界那一秒两边都不读，审核 #123 中-1）；
//   - 窗口大小自适应：第一页就知道这个窗口有多少条，超过 PAGES_PER_WINDOW 页就对半切（/api/log/ 每页都要 COUNT 一次，窗口小 COUNT 才便宜，翻页也不深）；
//     很稀的窗口翻倍，上限 1 小时；下限 5 秒（每秒几十条的站点也能一个窗口一个窗口往前走，审核 #123 中-2）；
//   - 每轮最多 MAX_PAGES_PER_ROUND 页、MAX_ROUND_MS 毫秒；落后超过 BEHIND_MS 时每轮放宽到 MAX_PAGES_BEHIND 页（180 秒 45 个、限流的 12.5%），追平回到 6 页；
//     每发一个请求之前都看一眼时间和断路器，到了就停，这个窗口不写，下一轮从窗口起点重来（审核 #123 中-3）；
//   - 第一次跑只从昨天 0 点（业务时区）起，不往前补更早的；
//   - 停机、站点读不到、令牌失效造成的掉队，不管多久都照常按保底慢慢追，不跳、不清桶（总指挥 10-26 定第三轮）；
//     只在「算应付成本」关→开这一下，进度比昨天 0 点还旧时，才挪到昨天 0 点（关着的日子本来就不读，不补那段缺口），
//     跳过的缺口记在 own_log_cursor 的 disabled_from_ms/disabled_to_ms，结账时那几天给 EXPECTED_COST_DISABLED；
//   - 每个窗口读完才写库（桶加进去、进度挪到窗口终点，一个事务），读到一半出错整个窗口不写；
//   - 落后超过 LAG_WARN_MS 每小时打一行日志（V1-a 没页面，先不进需处理）。
// 桶里顺手记下管理员自用额度、不在管理员名下的渠道测试额度（和 R1 同一个规矩，server/own-helpers.js 的管理员名单），V1 只用来和 R1 对账打日志。
// 开关：系统设置「算应付成本」settings.expectedCost（db/store.js，每轮读一次）——只有明确开着才读；默认开，系统设置页上能关（server/reconciliation.js）。
// 关→开判断：server/reconciliation.js 轮询时记 settings.expectedCostWasOff（settings 里的内部标记，不进设置页），只在关变开那一轮把
// justTurnedOn 传给 ingestOnce。
import { OWN_LOG_SLOT_MS, accumulateBuckets } from "../lib/own-log-bucket.js";
import { ingestAllowance, noteIngestUsage, ownRequestState } from "../lib/own-request-budget.js";
import { queryOwnLogWindow } from "../lib/providers.js";
import { businessTimeZone, dayStartInTz, dayKeyInTz, shiftedDayStartInTz } from "../lib/business-time.js";
import { readOwnAdminDirectory, resoldAdminKeysOf } from "./own-helpers.js";

export const INGEST = Object.freeze({
  LAG_MS: 120000,
  MAX_PAGES_PER_ROUND: 6,
  MAX_PAGES_BEHIND: 15, // 落后超过 BEHIND_MS 时每轮的页数上限
  BEHIND_MS: 3600000,
  MAX_ROUND_MS: 20000,
  PAGES_PER_WINDOW: 3, // 一个窗口超过这么多页就对半切
  WINDOW_MIN_MS: 5000,
  WINDOW_START_MS: 10 * 60000,
  WINDOW_MAX_MS: 3600000,
  PAGE_SIZE: 100,
  KEEP_DAYS: 35, // 桶留 35 天（比「本月」最长的范围多几天）
  LAG_WARN_MS: 6 * 3600000,
  PRUNE_BATCH: 2000,
  PRUNE_MAX_BATCHES: 20,
});

const ownBase = (own) => String(own?.baseUrl || "").replace(/\/+$/, "");
const wholeSecond = (ms) => Math.floor(ms / 1000) * 1000;

export function createOwnLogIngest(rt, { store, now = () => Date.now(), log = () => {} } = {}) {
  const windowSizes = new Map(); // 站点 id → 现在用的窗口大小（自适应，进程内）
  const lagWarnedAt = new Map(); // 站点 id → 上次打「落后太多」日志的时刻
  let lastPruneAt = 0;

  // 第一次：从昨天 0 点（业务时区）起读
  const firstFromMs = (at) => shiftedDayStartInTz(dayStartInTz(dayKeyInTz(at, businessTimeZone()), businessTimeZone()), -1, businessTimeZone());

  async function ingestOnce(own, { justTurnedOn = false } = {}) {
    if (!own?.isOwn || own.type !== "newapi") return { skipped: "not-own" };
    const at = now();
    const base = ownBase(own);
    const allowance = ingestAllowance(base, { now: at });
    // 这几处检查没走到跳不跳那一步：skipChecked 不给 true，调用方据此不清「上一次是关着的」标记，下一轮还会再试
    // （只要这一轮没真的判断过，标记就不能清——不然某个站点一直被额度、断路、管理员名单挡住，关着的那几天就永远跳不过去了；
    // 审核 R2 #125 第三轮 中-C）
    if (!allowance.allowed) return { skipped: allowance.reason, pages: 0 };
    // 管理员名单读不到这轮不读（进度也不建）：桶里「管理员自用」会算错，而且错了就留在桶里
    let adminSet, resoldKeys;
    try { ({ adminSet } = await readOwnAdminDirectory(rt, own)); resoldKeys = resoldAdminKeysOf(own); }
    catch (error) { return { skipped: "admins", pages: 0, error: error?.code || error?.message }; }
    let cursor = await store.getCursor(own.id);
    // 只在「算应付成本」关→开这一下才跳：关着那几天本来就不读，不补那段缺口，直接挪到昨天 0 点（总指挥 10-26 定第三轮，决定 C）。
    // 停机、站点读不到、令牌失效造成的掉队，不管多久都不跳，照常按保底慢慢追——那几天的开关本来是开着的，补得上就该补上。
    // 跳过的缺口记在 cursor 的 disabledFromMs/disabledToMs（结账时这段范围给 EXPECTED_COST_DISABLED），不清桶（已经读进来的留着）。
    // 这一行跑到了（不管后面读不读得到日志），就算真的判断过了：skipChecked 给 true
    if (justTurnedOn && cursor && cursor.coveredToMs < firstFromMs(at)) {
      cursor = await store.skipCursor(own.id, firstFromMs(at), at);
      log("own-log-ingest", own.id, "off->on, skipped stale progress to yesterday");
    }
    cursor ??= await store.startCursor(own.id, firstFromMs(at), at);
    const horizon = wholeSecond(at - INGEST.LAG_MS);
    if (cursor.coveredToMs >= horizon) return { skipped: "caught-up", pages: 0, coveredToMs: cursor.coveredToMs, skipChecked: true };
    const behind = horizon - cursor.coveredToMs;
    if (behind > INGEST.LAG_WARN_MS && at - (lagWarnedAt.get(own.id) || 0) >= 3600000) {
      lagWarnedAt.set(own.id, at);
      log("own-log-ingest", own.id, `behind ${Math.round(behind / 3600000)}h`);
    }
    const maxPages = behind > INGEST.BEHIND_MS ? INGEST.MAX_PAGES_BEHIND : INGEST.MAX_PAGES_PER_ROUND;
    let budget = Math.min(allowance.allowed, maxPages), pages = 0, windows = 0;
    const deadline = at + INGEST.MAX_ROUND_MS;
    // 每个请求之前：时间到了、或者别的读取把断路器打开了，就停（这个窗口不写）
    const mayRequest = () => budget > 0 && now() < deadline && !ownRequestState(base, now()).broken;
    let coveredTo = cursor.coveredToMs;
    let windowMs = windowSizes.get(own.id) ?? INGEST.WINDOW_START_MS;
    while (coveredTo < horizon && mayRequest()) {
      const fromMs = coveredTo, toMs = Math.max(fromMs + 1000, wholeSecond(Math.min(fromMs + windowMs, horizon)));
      let first;
      try { first = await queryOwnLogWindow(own, { startMs: fromMs, endMs: toMs, page: 1 }); }
      catch (error) { log("own-log-ingest", own.id, "read failed", error?.code || error?.message); return { pages, windows, coveredToMs: coveredTo, error: error?.code || "read", skipChecked: true }; }
      budget -= 1; pages += 1;
      const total = first.total ?? (first.items.length < INGEST.PAGE_SIZE ? first.items.length : null);
      const needPages = total == null ? INGEST.PAGES_PER_WINDOW + 1 : Math.ceil(total / INGEST.PAGE_SIZE);
      // 窗口太满：对半切（整秒），这一页白读了但下一个窗口小一半（最小 5 秒，到了下限只能硬读）
      if (needPages > INGEST.PAGES_PER_WINDOW && toMs - fromMs > INGEST.WINDOW_MIN_MS) {
        windowMs = Math.max(INGEST.WINDOW_MIN_MS, wholeSecond((toMs - fromMs) / 2));
        windowSizes.set(own.id, windowMs);
        continue;
      }
      // 剩的额度翻不完这个窗口：保底时额度很小（可能一直是 2），原地切半窗口接着试，不然会卡在「下一轮从头读」原地打转（总指挥 10-26 定）；
      // 到了最小窗口还翻不完就只能等下一轮（硬读会超预算）
      if (needPages - 1 > budget) {
        if (toMs - fromMs > INGEST.WINDOW_MIN_MS) { windowMs = Math.max(INGEST.WINDOW_MIN_MS, wholeSecond((toMs - fromMs) / 2)); windowSizes.set(own.id, windowMs); continue; }
        windowSizes.set(own.id, windowMs); break;
      }
      const seen = new Set(), rows = [];
      const take = (items) => { for (const row of items) { const id = Number(row?.id); if (Number.isFinite(id)) { if (seen.has(id)) continue; seen.add(id); } rows.push(row); } };
      take(first.items);
      let page = 2, more = first.items.length >= INGEST.PAGE_SIZE && (total == null || rows.length < total);
      let failed = null;
      while (more && mayRequest()) {
        let next;
        try { next = await queryOwnLogWindow(own, { startMs: fromMs, endMs: toMs, page }); } catch (error) { failed = error; break; }
        budget -= 1; pages += 1; page += 1;
        take(next.items);
        more = next.items.length >= INGEST.PAGE_SIZE && (total == null ? page <= INGEST.PAGES_PER_WINDOW + 1 : rows.length < total);
      }
      if (failed) { log("own-log-ingest", own.id, "read failed", failed?.code || failed?.message); return { pages, windows, coveredToMs: coveredTo, error: failed?.code || "read", skipChecked: true }; }
      if (more) { windowSizes.set(own.id, windowMs); break; } // 额度、时间用完或断路了还没翻完：这个窗口不写，下一轮从头读
      const buckets = accumulateBuckets(rows, { adminSet, resoldKeys });
      const applied = await store.applyWindow(own.id, { fromMs, toMs, buckets: buckets.values() }, now());
      if (!applied) return { pages, windows, coveredToMs: coveredTo, error: "cursor-moved", skipChecked: true }; // 别的进程先写了：下一轮按库里的进度来
      coveredTo = toMs; windows += 1;
      // 很稀：窗口翻倍（上限 1 小时）
      if (rows.length < INGEST.PAGE_SIZE / 2 && toMs - fromMs >= windowMs) windowMs = Math.min(INGEST.WINDOW_MAX_MS, windowMs * 2);
      windowSizes.set(own.id, windowMs);
    }
    noteIngestUsage(base, pages, now());
    return { pages, windows, coveredToMs: coveredTo, skipChecked: true };
  }

  // 每小时清 35 天前的桶：一批 2000 行，删到不满一批为止（最多 20 批，表再大也不会一直涨）
  async function pruneIfDue() {
    const at = now();
    if (at - lastPruneAt < 3600000) return 0;
    lastPruneAt = at;
    const beforeSlot = Math.floor((at - INGEST.KEEP_DAYS * 86400000) / OWN_LOG_SLOT_MS) * OWN_LOG_SLOT_MS;
    let deleted = 0;
    try {
      for (let batch = 0; batch < INGEST.PRUNE_MAX_BATCHES; batch += 1) {
        const n = await store.pruneBuckets(beforeSlot, INGEST.PRUNE_BATCH);
        deleted += n;
        if (n < INGEST.PRUNE_BATCH) break;
      }
    } catch { /* 下个小时再清 */ }
    return deleted;
  }

  return { ingestOnce, pruneIfDue, windowSizes };
}
