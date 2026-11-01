// 自营站点整站消费日志的增量读（应付成本 V1-a，计划 v1-plan 第 3 节；总指挥 10-26：对你站零压力）。
// 每轮（跟着结账轮询）每个自营站点：
//   - 先问额度和断路（lib/own-request-budget.js）：断路期间不读；最近 180 秒剩余不到「留给别人的」不读；这轮最多用额度的一份；
//   - 从进度（own_log_cursor.covered_to_ms）起，一个小窗口一个小窗口往前读到「现在 − 120 秒」为止（最新的日志还在陆续入账，留 120 秒）；
//     窗口的两头都对齐到整秒（站点的 start/end 按秒、两头包含；不对齐的话边界那一秒两边都不读，审核 #123 中-1）；
//   - 窗口大小自适应：第一页就知道这个窗口有多少条，超过 PAGES_PER_WINDOW 页就对半切（/api/log/ 每页都要 COUNT 一次，窗口小 COUNT 才便宜，翻页也不深）；
//     很稀的窗口翻倍，上限 1 小时；下限 5 秒（每秒几十条的站点也能一个窗口一个窗口往前走，审核 #123 中-2）；
//   - 每轮最多 MAX_PAGES_PER_ROUND 页、MAX_ROUND_MS 毫秒；落后超过 BEHIND_MS 时每轮放宽到 MAX_PAGES_BEHIND 页（180 秒 45 个、限流的 12.5%），追平回到 6 页；
//     每发一个请求之前都看一眼时间和断路器，到了就停；每页暂存去重编号和桶，下轮从下一页继续（审核 #123 中-3）；
//   - 第一次跑只从昨天 0 点（业务时区）起，不往前补更早的；
//   - 停机、站点读不到、令牌失效造成的掉队，不管多久都照常按保底慢慢追，不跳、不清桶（总指挥 10-26 定第三轮）；
//     只在「算应付成本」关→开这一下，进度比昨天 0 点还旧时，才挪到昨天 0 点（关着的日子本来就不读，不补那段缺口），
//     跳过的缺口记在 own_log_cursor 的 disabled_from_ms/disabled_to_ms，结账时那几天给 EXPECTED_COST_DISABLED；
//   - 每个窗口读完才正式入桶（桶、进度、删除暂存同一个事务）；中途出错不发布半个窗口，下轮接着读；
//   - 落后超过 LAG_WARN_MS 每小时打一行日志（V1-a 没页面，先不进需处理）。
// 桶里顺手记下管理员自用额度、不在管理员名下的渠道测试额度（和 R1 同一个规矩，server/own-helpers.js 的管理员名单），V1 只用来和 R1 对账打日志。
// 开关：系统设置「算应付成本」settings.expectedCost（db/store.js，每轮读一次）——只有明确开着才读；默认开，系统设置页上能关（server/reconciliation.js）。
// 关→开判断：server/reconciliation.js 轮询时记 settings.expectedCostWasOff（settings 里的内部标记，不进设置页），只在关变开那一轮把
// justTurnedOn 传给 ingestOnce。
// 同一条流水线读两样日志（kind）：消费日志 CONSUME_KIND（type 2，上面说的都是它）和错误日志 ERROR_KIND（type 5，只存次数，模型供需用，设置里「读取错误日志」开关）。
// 两条各有各的进度、暂存、桶（server/own-log-store.js 的 CONSUME_SPEC / ERROR_SPEC），请求额度和断路是同一个（lib/own-request-budget.js）：错误日志排在消费日志后面读，
// 额度紧、断路时宁可落后也不多读；而且更省：每轮页数更少、窗口更小（窗口里 COUNT 要扫这段时间的全部日志，错误日志稀，不能用大窗口）、
// 落后不到 minAdvanceMs（5 分钟）不读（没有新窗口、也没有没读完的窗口就不发请求）。
import { OWN_LOAD } from "../lib/own-load.js";
import { createHash } from "node:crypto";
import { OWN_LOG_SLOT_MS, accumulateBuckets, bucketKeyOf } from "../lib/own-log-bucket.js";
import { OWN_ERROR_SLOT_MS, accumulateErrorBuckets, errorBucketKeyOf, scaleErrorBuckets } from "../lib/own-error-bucket.js";
import { ingestAllowance, noteIngestUsage, ownRequestState } from "../lib/own-request-budget.js";
import { queryOwnLogWindow, queryOwnRetrySettings } from "../lib/providers.js";
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

// 站点的重试设置（RetryTimes、自动重试状态码范围）：错误日志判断「这次失败站点会不会再试」要用。读 GET /api/option/（站点里只读内存里的设置表，不查库），
// 每个站点 1 小时最多读一次；读不到（没权限、版本太老、网络、额度紧、断路）退回按 rc.30 的默认范围，下一轮再试：没权限缓存 1 小时，别的读不到缓存 10 分钟；
// 额度紧或断路时不发请求，沿用上一次读到的。返回 { retryTimes, retryRanges }（读不到的字段是 null）或 null（从没读到过）
export const RETRY_SETTINGS_TTL_MS = 3600000, RETRY_SETTINGS_FAIL_TTL_MS = 600000;
export async function readRetrySettings(rt, own, { now = Date.now(), query = queryOwnRetrySettings } = {}) {
  const cache = (rt._ownRetrySettings ||= new Map());
  const key = `${own.id}|${ownBase(own)}|${own.userId || ""}|${own.authVersion ?? ""}`;
  const hit = cache.get(own.id);
  const known = hit?.key === key ? hit : null;
  if (known && now - known.at < (known.failed ? known.ttl : RETRY_SETTINGS_TTL_MS)) return known.value;
  // 重试设置不是必须的（读不到就按默认）：断路、额度只剩保底（别的读取已经占了大半）时不发
  const allowance = ingestAllowance(ownBase(own), { now });
  if (ownRequestState(ownBase(own), now).broken || allowance.allowed <= 0 || allowance.floor) return known?.value ?? null;
  let entry;
  try {
    const result = await query(own);
    entry = result.state === "ok"
      ? { key, at: now, value: { retryTimes: result.retryTimes, retryRanges: result.retryRanges } }
      : { key, at: now, failed: true, ttl: RETRY_SETTINGS_TTL_MS, value: known?.value ?? null };
  } catch { entry = { key, at: now, failed: true, ttl: RETRY_SETTINGS_FAIL_TTL_MS, value: known?.value ?? null }; }
  cache.set(own.id, entry);
  return entry.value;
}
// 已经读到的（不发请求）：查询函数要「站点的重试次数」时用；没读到过是 null
export const cachedRetrySettings = (rt, own) => rt._ownRetrySettings?.get(own.id)?.value ?? null;

// 一条流水线读哪种日志：type、桶怎么加、桶的键、要不要管理员名单、每轮页数和窗口的上限（不写就用 INGEST 里的）；
// prepare：每轮读之前问一下额外的上下文（错误日志要站点的重试设置），返回 { 给 accumulate 的字段, key（进暂存的口径指纹，变了就丢掉没读完的暂存重读） }
export const CONSUME_KIND = Object.freeze({
  name: "consume", type: 2, tag: "own-log-ingest", slotMs: OWN_LOG_SLOT_MS, accumulate: accumulateBuckets, keyOf: bucketKeyOf, needsAdmins: true,
  // 追平以后每 5 分钟才读一次（落后不到 5 分钟又没有读到一半的窗口，这一轮不发请求）：给用户站减负，桶只用于结账、应付成本和今天的汇总，不需要分钟级
  limits: Object.freeze({ minAdvanceMs: OWN_LOAD.CONSUME_LOG_MS }),
});
export const ERROR_KIND = Object.freeze({
  name: "error", type: 5, tag: "own-error-ingest", slotMs: OWN_ERROR_SLOT_MS, accumulate: accumulateErrorBuckets, keyOf: errorBucketKeyOf, needsAdmins: false,
  // 第一次只从现在往后读（不补历史：冷数据随机回表不划算）；窗口不跨小时；一个窗口最多读 3 页（300 条）当样本，总条数用每个请求自带的 total（站点的 COUNT）摊，
  // 所以不管错误多少，每个窗口最多 3 页，游标不会落后
  firstFromMs: (at) => Math.floor((at - INGEST.LAG_MS) / 1000) * 1000, alignToSlot: true, samplePages: INGEST.PAGES_PER_WINDOW, finalize: scaleErrorBuckets,
  prepare: async ({ rt, own, now }) => { const settings = await readRetrySettings(rt, own, { now }); return { retryRanges: settings?.retryRanges ?? null, key: JSON.stringify(settings?.retryRanges ?? null) }; },
  limits: Object.freeze({ pagesPerRound: 3, pagesBehind: 6, windowStartMs: 5 * 60000, windowMaxMs: 5 * 60000, minAdvanceMs: 5 * 60000 }),
});

// 采样挑哪几页：窗口不超过 maxPages 页就全读；超过就在 total 分出的页里均匀挑 maxPages 页（第 1 页、中间、最后一页，页码只由 total 算，不多发请求）。
// 页是按 created_at 倒序切的，只取最新几页会把窗口前半段的小渠道漏成 0；分层取，窗口的头、中、尾都有样本
export function samplePlan(total, maxPages) {
  const pages = Math.ceil(total / INGEST.PAGE_SIZE);
  if (pages <= maxPages) return Array.from({ length: pages }, (_, i) => i + 1);
  return Array.from({ length: maxPages }, (_, i) => 1 + Math.round((i * (pages - 1)) / (maxPages - 1)));
}

const ownBase = (own) => String(own?.baseUrl || "").replace(/\/+$/, "");
const wholeSecond = (ms) => Math.floor(ms / 1000) * 1000;

export function createOwnLogIngest(rt, { store, kind = CONSUME_KIND, now = () => Date.now(), log = () => {} } = {}) {
  const limit = { pagesPerRound: INGEST.MAX_PAGES_PER_ROUND, pagesBehind: INGEST.MAX_PAGES_BEHIND, windowStartMs: INGEST.WINDOW_START_MS, windowMaxMs: INGEST.WINDOW_MAX_MS, minAdvanceMs: 0, ...kind.limits };
  const windowSizes = new Map(); // 站点 id → 现在用的窗口大小（自适应，进程内）
  const lagWarnedAt = new Map(); // 站点 id → 上次打「落后太多」日志的时刻
  let lastPruneAt = 0;

  // 第一次：从昨天 0 点（业务时区）起读
  const firstFromMs = (at) => (kind.firstFromMs ? kind.firstFromMs(at) : shiftedDayStartInTz(dayStartInTz(dayKeyInTz(at, businessTimeZone()), businessTimeZone()), -1, businessTimeZone()));

  async function ingestOnce(own, { justTurnedOn = false } = {}) {
    if (!own?.isOwn || own.type !== "newapi") return { skipped: "not-own" };
    const at = now();
    const base = ownBase(own);
    const allowance = ingestAllowance(base, { now: at });
    // 这几处检查没走到跳不跳那一步：skipChecked 不给 true，调用方据此不清「上一次是关着的」标记，下一轮还会再试
    // （只要这一轮没真的判断过，标记就不能清——不然某个站点一直被额度、断路、管理员名单挡住，关着的那几天就永远跳不过去了；
    // 审核 R2 #125 第三轮 中-C）
    if (!allowance.allowed) return { skipped: allowance.reason, pages: 0 };
    // 管理员名单读不到这轮不读（进度也不建）：桶里「管理员自用」会算错，而且错了就留在桶里（错误日志不分管理员，不要名单）
    let adminSet = new Set(), resoldKeys = [];
    if (kind.needsAdmins) {
      try { ({ adminSet } = await readOwnAdminDirectory(rt, own)); resoldKeys = resoldAdminKeysOf(own); }
      catch (error) { return { skipped: "admins", pages: 0, error: error?.code || error?.message }; }
    }
    let cursor = await store.getCursor(own.id);
    // 只在「算应付成本」关→开这一下才跳：关着那几天本来就不读，不补那段缺口，直接挪到昨天 0 点（总指挥 10-26 定第三轮，决定 C）。
    // 停机、站点读不到、令牌失效造成的掉队，不管多久都不跳，照常按保底慢慢追——那几天的开关本来是开着的，补得上就该补上。
    // 跳过的缺口记在 cursor 的 disabledFromMs/disabledToMs（结账时这段范围给 EXPECTED_COST_DISABLED），不清桶（已经读进来的留着）。
    // 这一行跑到了（不管后面读不读得到日志），就算真的判断过了：skipChecked 给 true
    if (justTurnedOn && cursor && cursor.coveredToMs < firstFromMs(at)) {
      cursor = await store.skipCursor(own.id, firstFromMs(at), at);
      log(kind.tag, own.id, "off->on, skipped stale progress");
    }
    cursor ??= await store.startCursor(own.id, firstFromMs(at), at);
    const horizon = wholeSecond(at - INGEST.LAG_MS);
    // 落后不到 minAdvanceMs 而且没有没读完的窗口：这轮不读（消费日志 minAdvanceMs 是 0，就是「追平了」）
    const gap = horizon - cursor.coveredToMs;
    if (gap <= 0 || (gap < limit.minAdvanceMs && !(await store.getPending(own.id)))) return { skipped: "caught-up", pages: 0, coveredToMs: cursor.coveredToMs, skipChecked: true };
    const behind = horizon - cursor.coveredToMs;
    if (behind > INGEST.LAG_WARN_MS && at - (lagWarnedAt.get(own.id) || 0) >= 3600000) {
      lagWarnedAt.set(own.id, at);
      log(kind.tag, own.id, `behind ${Math.round(behind / 3600000)}h`);
    }
    const maxPages = behind > INGEST.BEHIND_MS ? limit.pagesBehind : limit.pagesPerRound;
    let budget = Math.min(allowance.allowed, maxPages), pages = 0, windows = 0;
    const deadline = at + INGEST.MAX_ROUND_MS;
    const mayRequest = () => budget > 0 && now() < deadline && !ownRequestState(base, now()).broken;
    let coveredTo = cursor.coveredToMs;
    let windowMs = windowSizes.get(own.id) ?? limit.windowStartMs;
    const context = kind.prepare ? await kind.prepare({ rt, own, now: at }) : {};
    // 暂存只含编号和聚合值，不留用户名、Key 名、请求内容。管理员/转售归类改变时拒绝混用两种口径。
    const classificationKey = createHash("sha256").update(JSON.stringify({
      kind: kind.name, extra: context.key ?? null, admins: [...adminSet].sort(), resold: resoldKeys.map((key) => [key.username, key.tokenName]).sort(),
    })).digest("hex");
    const result = (extra = {}) => ({ pages, windows, coveredToMs: coveredTo, skipChecked: true, ...extra });
    const invalid = (code) => Object.assign(new Error(code), { code });
    try {
      let pending = await store.getPending(own.id);
      while (coveredTo < horizon) {
        if (pending && pending.fromMs !== coveredTo) {
          // 回滚到旧版本时它可能推进 cursor，却不认识暂存表。只清旧暂存，不退回/跳过正式进度。
          await store.discardPending(own.id, { fromMs: pending.fromMs, expectedCoveredToMs: coveredTo, expectedRevision: pending.revision });
          return result({ error: "pending-window-mismatch" });
        }
        if (pending && pending.toMs > horizon) return result({ error: "pending-window-mismatch" });
        if (pending && pending.classificationKey !== classificationKey) {
          await store.discardPending(own.id, { fromMs: coveredTo, expectedRevision: pending.revision });
          return result({ error: "pending-classification-changed" });
        }
        // 最后一页已经落暂存、正式入桶前进程退出：直接提交，不必重读接口。
        if (pending?.complete) {
          const applied = await store.applyWindow(own.id, { fromMs: pending.fromMs, toMs: pending.toMs,
            buckets: pending.buckets, pendingRevision: pending.revision }, now());
          if (!applied) return result({ error: "cursor-moved" });
          coveredTo = pending.toMs; windows += 1;
          if (pending.seenIds.length < INGEST.PAGE_SIZE / 2 && pending.toMs - pending.fromMs >= windowMs)
            windowMs = Math.min(limit.windowMaxMs, windowMs * 2);
          windowSizes.set(own.id, windowMs);
          pending = null;
          continue;
        }
        if (!mayRequest()) break;
        const fromMs = pending?.fromMs ?? coveredTo;
        // alignToSlot：窗口不跨小时（桶按小时，摊样本时一个窗口的数要落在同一个小时里）
        const slotEnd = kind.alignToSlot ? (Math.floor(fromMs / kind.slotMs) + 1) * kind.slotMs : Infinity;
        const toMs = pending?.toMs ?? Math.max(fromMs + 1000, wholeSecond(Math.min(fromMs + windowMs, horizon, slotEnd)));
        const page = pending?.nextPage ?? 1;
        let response;
        // 失败的请求也占额度；finally 保证提前返回和数据库写失败时同样记账。
        budget -= 1; pages += 1;
        try { response = await queryOwnLogWindow(own, { startMs: fromMs, endMs: toMs, page, type: kind.type }); }
        catch (error) { log(kind.tag, own.id, "read failed", error?.code || "read"); return result({ error: error?.code || "read" }); }
        const { items } = response;
        const total = response.total;
        const needPages = total == null ? (items.length < INGEST.PAGE_SIZE ? 1 : INGEST.PAGES_PER_WINDOW + 1) : Math.ceil(total / INGEST.PAGE_SIZE);
        // 只在窗口尚未暂存时缩小；接受第一页后窗口固定，页数再多也分轮读完。
        // 采样的流水线（错误日志）不切窗口：一个窗口最多读 samplePages 页当样本，总条数用请求自带的 total 摊
        if (!pending && !kind.samplePages && needPages > INGEST.PAGES_PER_WINDOW && toMs - fromMs > INGEST.WINDOW_MIN_MS) {
          windowMs = Math.max(INGEST.WINDOW_MIN_MS, wholeSecond((toMs - fromMs) / 2));
          windowSizes.set(own.id, windowMs);
          continue;
        }
        if (pending && total !== pending.total) {
          // 历史窗口有迟到/删除的日志，offset 已可能移动。只丢未发布的暂存，下轮原地重读，绝不跳过历史。
          await store.discardPending(own.id, { fromMs: coveredTo, expectedRevision: pending.revision });
          return result({ error: "pending-total-changed" });
        }
        const seen = new Set(pending?.seenIds || []);
        const fresh = [];
        for (const row of items) {
          const id = Number(row?.id), second = Number(row?.created_at);
          if (!Number.isSafeInteger(id) || id <= 0 || Number(row?.type) !== kind.type || !Number.isSafeInteger(second)
            || second < Math.ceil(fromMs / 1000) || second >= Math.floor(toMs / 1000)) throw invalid("invalid-log-row");
          if (seen.has(id)) throw invalid("pending-page-overlap");
          seen.add(id); fresh.push(row);
        }
        if (items.length && !fresh.length) throw invalid("pending-page-not-advancing");
        // 采样的流水线（错误日志）：窗口超过 samplePages 页就只读分层挑的几页（见 samplePlan），每页的条数照 total 算得出来，对不上就是窗口里的日志在读的时候变了
        const plan = kind.samplePages && total != null ? samplePlan(total, kind.samplePages) : null;
        if (plan) {
          if (items.length !== (total === 0 ? 0 : Math.min(INGEST.PAGE_SIZE, total - INGEST.PAGE_SIZE * (page - 1))) || (total > 0 && !plan.includes(page))) throw invalid("pending-count-mismatch");
        } else if (total != null && (seen.size > total || (items.length < INGEST.PAGE_SIZE && seen.size !== total)))
          throw invalid("pending-count-mismatch");
        const nextPage = plan ? plan[plan.indexOf(page) + 1] : undefined;
        const complete = plan ? nextPage === undefined : total == null ? items.length < INGEST.PAGE_SIZE : seen.size === total;
        // 已翻完 total 指定的页数还缺编号，不能靠空页把漏掉的记录当作已采完。
        if (!plan && total != null && !complete && page >= Math.ceil(total / INGEST.PAGE_SIZE)) throw invalid("pending-count-mismatch");
        const buckets = new Map((pending?.buckets || []).map((bucket) => [kind.keyOf(bucket), bucket]));
        kind.accumulate(fresh, { adminSet, resoldKeys, ...context }, buckets);
        // 只读了样本（窗口里的条数比读到的多）：窗口读完时把样本里的比例摊到 total 上，桶标成估算；不满 samplePages 页读完的是实数
        const finalBuckets = complete && plan && seen.size < total ? kind.finalize(buckets, { total, sample: seen.size }) : buckets;
        const saved = await store.savePending(own.id, { fromMs, toMs, nextPage: nextPage ?? page + 1, total,
          seenIds: [...seen], buckets: [...finalBuckets.values()], complete, classificationKey },
          { expectedRevision: pending?.revision ?? null }, now());
        if (!saved) return result({ error: "cursor-moved" });
        pending = saved;
      }
      return result();
    } catch (error) {
      if (["pending-total-changed", "invalid-log-row", "pending-page-not-advancing", "pending-page-overlap", "pending-count-mismatch"].includes(error?.code)) {
        log(kind.tag, own.id, "validation failed", error.code);
        return result({ error: error.code });
      }
      throw error;
    } finally {
      noteIngestUsage(base, pages, now());
    }
  }

  // 每小时清 35 天前的桶：一批 2000 行，删到不满一批为止（最多 20 批，表再大也不会一直涨）
  async function pruneIfDue() {
    const at = now();
    if (at - lastPruneAt < 3600000) return 0;
    lastPruneAt = at;
    const beforeSlot = Math.floor((at - INGEST.KEEP_DAYS * 86400000) / kind.slotMs) * kind.slotMs;
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

// 错误日志「连续 24 小时一条都没读到」：设置里「读取错误日志」下面写一句提示（可能你的站没开 ERROR_LOG_ENABLED）。不放慢读取——放大窗口反而更贵、拉长间隔会漏数。
// 判断：读了至少 24 小时（进度的两头相隔），而且最近一个有数的小时是 24 小时以前（一个都没有就从开始读那一刻算）；没有进度是 false
export const ERROR_QUIET_MS = 24 * 3600000;
export async function errorLogQuiet(store, stationId) {
  const cursor = await store.getCursor(stationId);
  if (!cursor) return false;
  const latest = await store.latestSlot(stationId);
  const lastSignal = Math.max(cursor.coveredFromMs, latest == null ? -Infinity : latest + OWN_ERROR_SLOT_MS);
  return cursor.coveredToMs - lastSignal >= ERROR_QUIET_MS;
}
