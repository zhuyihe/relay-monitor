// 合并重复的上游：先算出清单和合并前后的成本估算（只读，不改任何数据），用户确认后才合，合错了能退回。
// 页面是上游列表顶上的提示和「合并重复的上游」抽屉（app/components/merge-upstreams.tsx）；这里是它背后的动作：
// previewUpstreamMerges（清单）、applyUpstreamMerge（合并一组）、undoUpstreamMerge（退回一次）。
// 上游文档（Store）和绑定、关联（对账仓库的表）、合并日志在同一个事务里一起改，见 db/store.js 的 mergeUpstreams：
// 加锁顺序是先 stations 再 rules、links，对账仓库的事务从来不碰 stations 表，不会有锁顺序相反的环。
import { mergedStationPatches, planUpstreamMerges } from "../lib/upstream-merge.js";
import { businessTimeZone, dayKeyInTz, shiftDayLabel } from "../lib/business-time.js";
import { costBasisOf, countsInProfit, rateSnapshotOf } from "../lib/profit.js";
import { stationBusinessVersion } from "../db/store.js";
import { dailyUsageRows } from "./station-usage.js";
import { aliasesAfterUndo, applyMergeRows, countMerges, listMerges, MERGE_LOG_KIND, mergeError, newMergeId, readMergeBasis, undoMergeRows } from "../db/upstream-merge-repository.js";

const ESTIMATE_DAYS = [7, 30];
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const invalid = (message) => mergeError("UPSTREAM_MERGE_INVALID", message);

// 清单上要看的站（和上游列表一样不含已归档、已被合并的）
const listedStations = (rt) => rt.store.list({ includeUnmonitored: true, includeArchived: true });

export async function planNow(rt) {
  const basis = await readMergeBasis(rt.pool);
  return planUpstreamMerges({ stations: listedStations(rt), ...basis });
}

const round2 = (value) => Math.round(value * 100) / 100;

// 合并前后近 7 天、近 30 天的成本估算：读成本估算页同一份数（每站每日消耗 × 上游自己的汇率，逐日四舍五入再加，和页面的总成本一样），
// 所以合并以后成本估算页的数就等于这里写的「后」。页面的总成本只算「按用量计费、算进利润」的上游，这里也一样：
// 记了固定成本的（成本按摊销算、用量不算）、不算进利润的上游不进这两个数。合并前是这个账号下每个上游各算一遍再加起来，合并后只算留下的那个。
// 一次读 30 天，7 天从里面取；某天一条记录都没有时这个窗口标 approx（页面带「≈」，和成本估算页同一个判断思路）；
// 读不到、或者这一组被「留下的没设汇率」挡着（前后的汇率不一样，加起来没有意义）时 estimate 是 null，页面写「—」，不挡合并。
export async function estimateGroups(rt, groups, { now }) {
  const tz = businessTimeZone();
  const end = dayKeyInTz(now, tz);
  const start = shiftDayLabel(end, -(Math.max(...ESTIMATE_DAYS) - 1));
  const counted = (id) => { const station = rt.store.getWithMerged(id); return !!station && costBasisOf(station) === "usage" && countsInProfit(station); };
  const ids = [...new Set(groups.flatMap((group) => [group.retained.id, ...group.merged.map((station) => station.id)]))].filter(counted);
  let rows;
  try {
    rows = await dailyUsageRows(rt.pool, ids, start, end);
  } catch {
    return groups.map(() => null);
  }
  const cnyOf = (stationId, usd) => round2(Number(usd) * rateSnapshotOf(rt.store.getWithMerged(stationId)).cnyPerUsd);
  return groups.map((group) => {
    if (group.blockers.some((blocker) => blocker.code === "RATE_UNSET_ON_RETAINED")) return null;
    const members = [group.retained, ...group.merged].map((station) => station.id);
    return { windows: ESTIMATE_DAYS.map((days) => {
      const from = shiftDayLabel(end, -(days - 1));
      const sums = new Map(members.map((id) => [id, 0]));
      const covered = new Set();
      for (const row of rows) {
        if (row.date < from || !sums.has(row.stationId)) continue;
        sums.set(row.stationId, sums.get(row.stationId) + cnyOf(row.stationId, row.usd));
        covered.add(row.date);
      }
      const upstreams = members.map((stationId) => ({ stationId, cny: round2(sums.get(stationId)), counted: counted(stationId) }));
      // 这段时间里有哪一天算进成本的上游一条记录都没有：和成本估算页一样，数是估算的，带「≈」
      const anyCounted = upstreams.some((item) => item.counted);
      return { days, approx: anyCounted && covered.size < days, before: { cny: round2(upstreams.reduce((sum, item) => sum + item.cny, 0)), upstreams },
        after: { cny: upstreams[0].cny, upstreams: [upstreams[0]] } };
    }) };
  });
}

// 清单：{ groups, counts, records, generatedAt, versions }。estimate: false 只出清单不估算。
// versions：每组每个成员现在的版本号，页面上「恢复监控」带着它去改，那个上游在这期间变过就不会照旧写回去
export async function previewUpstreamMerges(rt, { estimate = true, now = Date.now() } = {}) {
  const plan = await planNow(rt);
  const records = await listMergeRecords(rt);
  const counts = mergeCounts(plan);
  const estimates = estimate ? await estimateGroups(rt, plan.groups, { now }) : [];
  const versionOf = (id) => { const station = rt.store.getWithMerged(id); return station ? { authVersion: station.authVersion || 1, resourceVersion: stationBusinessVersion(station) } : { authVersion: 1, resourceVersion: "" }; };
  const groups = plan.groups.map((group, i) => ({ ...group, ...(estimate ? { estimate: estimates[i] } : {}),
    versions: Object.fromEntries([group.retained, ...group.merged].map((station) => [station.id, versionOf(station.id)])) }));
  return { groups, counts, records, generatedAt: now };
}

// 合并一组：请求里带的是清单上看到的「留下的、被合掉的」，这里按现在的数据重新算一遍，对不上就不合；
// 拿到上游的锁以后（Store.mergeUpstreams 的 patchesFor）再按那一刻内存里的上游文档重判一次挡着的事，计划算完到拿锁之间被改过的不会被绕过去
export async function applyUpstreamMerge(rt, { retainedId, mergedIds }, { now = Date.now() } = {}) {
  if (!nonEmptyString(retainedId) || !Array.isArray(mergedIds) || !mergedIds.length || !mergedIds.every(nonEmptyString)) throw invalid("要合并的上游不完整");
  const requested = [...new Set(mergedIds)].sort();
  const { groups } = await planNow(rt);
  const group = groups.find((item) => item.retained.id === retainedId);
  if (!group || JSON.stringify(group.merged.map((station) => station.id).sort()) !== JSON.stringify(requested)) {
    throw mergeError("UPSTREAM_MERGE_STALE", "清单变了，请重新看一遍");
  }
  if (!group.canMerge) throw mergeError("UPSTREAM_MERGE_BLOCKED", "这一组现在不能合并");
  const mergeId = newMergeId();
  let effective = group, oldAliases = [];
  let rows;
  await rt.store.mergeUpstreams({
    retainedId, mergedIds: requested,
    patchesFor: (retained, merged) => {
      const locked = planUpstreamMerges({ stations: [retained, ...merged] }).groups.find((item) => item.retained.id === retainedId);
      if (!locked || locked.blockers.length || JSON.stringify(locked.merged.map((station) => station.id).sort()) !== JSON.stringify(requested)) {
        throw mergeError("UPSTREAM_MERGE_STALE", "上游在这期间变了，请重新看一遍清单");
      }
      effective = { ...group, costAliasesAfter: locked.costAliasesAfter };
      oldAliases = [...(retained.costAliases || [])];
      return mergedStationPatches(locked, { nowIso: new Date(now).toISOString() });
    },
    within: async (conn) => { rows = await applyMergeRows(conn, effective, { mergeId, nowMs: now, oldRetainedAliases: oldAliases }); },
  });
  invalidateMergeCounts(rt);
  return { mergeId, retainedId, mergedIds: requested, ...rows };
}

// 清单上有几组能合、几组合不了：上游列表顶上那条提示和成本估算那一行只要这几个数
// accounts、upstreams：成本估算页那一行「其中 1 个账号加成了 2 个上游」要的两个数（合并前这些账号一共有几个上游）
export function mergeCounts(plan) {
  return { mergeable: plan.groups.filter((group) => group.canMerge).length, blocked: plan.groups.filter((group) => !group.canMerge).length,
    accounts: plan.groups.length, upstreams: plan.groups.reduce((sum, group) => sum + 1 + group.merged.length, 0) };
}

const COUNTS_TTL_MS = 60 * 1000;

// 合并、退回以后马上作废：代次加一，在途的那一次读完也不再写回缓存（不然旧值会再挂 1 分钟）
export function invalidateMergeCounts(rt) {
  const state = (rt._mergeCounts ||= { gen: 0, at: 0, counts: null, inflight: null });
  state.gen += 1;
  state.at = 0;
  state.inflight = null;
}

// 上游列表顶上的提示和成本估算那一行要的几个数：跟着这两页本来就有的读法带回去，不另起轮询。算一次要读绑定、关联各一条查询，缓存 1 分钟；
// 同一时刻只有一次在读，别的调用共用它的结果。读不到时是 null，页面就不出那条提示
export async function cachedMergeCounts(rt, { now = Date.now() } = {}) {
  const state = (rt._mergeCounts ||= { gen: 0, at: 0, counts: null, inflight: null });
  if (state.at && now - state.at < COUNTS_TTL_MS) return state.counts;
  if (state.inflight) return state.inflight;
  const gen = state.gen;
  const run = (async () => {
    let counts = null;
    try { counts = { ...mergeCounts(await planNow(rt)), records: await countMerges(rt.pool) }; } catch { /* 读不到就先不提示 */ }
    if (state.gen === gen) { state.counts = counts; state.at = now; }
    return counts;
  })();
  state.inflight = run;
  run.finally(() => { if (state.inflight === run) state.inflight = null; });
  return run;
}

// 合并记录：每次合并一条，带名字（上游后来删了名字也在日志里）、有没有退回、现在还退不退得回、退不回的原因
export async function listMergeRecords(rt) {
  const merges = await listMerges(rt.pool, { includeUndone: true });
  return merges.map((merge) => {
    const nameOf = (kind, id) => merge.rows.find((row) => row.kind === kind && (kind === MERGE_LOG_KIND.STATION_RETAINED || row.mergedId === id))?.detail.name ?? id;
    const retained = { id: merge.retainedId, name: nameOf(MERGE_LOG_KIND.STATION_RETAINED) };
    const merged = merge.mergedIds.map((id) => ({ id, name: nameOf(MERGE_LOG_KIND.STATION_MERGED, id) }));
    let undoBlocked = null;
    if (merge.undoneAtMs == null) {
      const gone = [retained, ...merged].find((station) => !rt.store.getWithMerged(station.id));
      if (gone) undoBlocked = { code: "UPSTREAM_DELETED", detail: `「${gone.name}」已经删了，退回不了`, stationId: gone.id };
      else if (merged.some((station) => rt.store.getWithMerged(station.id).mergedInto !== merge.retainedId)) {
        undoBlocked = { code: "UPSTREAM_CHANGED", detail: "这次合并之后上游又变过，退回不了" };
      }
    }
    return { mergeId: merge.mergeId, mergedAtMs: merge.mergedAtMs, undoneAtMs: merge.undoneAtMs, retained, merged, undoable: merge.undoneAtMs == null && !undoBlocked, undoBlocked };
  });
}

// 退回一次合并：和 db/k-unmerge.js --apply 同一段代码（undoMergeRows）；服务在跑，所以上游文档由 Store 在同一个事务里改
export async function undoUpstreamMerge(rt, { mergeId }, { now = Date.now() } = {}) {
  // 不带编号时不能当成「退回最近一次」：先在入口拦下
  if (!nonEmptyString(mergeId)) throw invalid("要退回的合并不完整");
  const merge = (await listMerges(rt.pool, { mergeId })).find((item) => item.mergeId === mergeId);
  if (!merge) throw mergeError("UPSTREAM_MERGE_STALE", "这次合并已经退回了，请刷新后再看");
  const record = (await listMergeRecords(rt)).find((item) => item.mergeId === mergeId);
  if (record?.undoBlocked) throw mergeError("UPSTREAM_MERGE_BLOCKED", record.undoBlocked.detail);
  const detail = merge.rows.find((row) => row.kind === MERGE_LOG_KIND.STATION_RETAINED).detail;
  await rt.store.unmergeUpstreams({
    retainedId: merge.retainedId, mergedIds: merge.mergedIds,
    costAliasesOf: (current) => aliasesAfterUndo(current, detail) || [],
    within: (conn) => undoMergeRows(conn, merge, { nowMs: now, stations: false }),
  });
  invalidateMergeCounts(rt);
  return { mergeId, retainedId: merge.retainedId, mergedIds: merge.mergedIds };
}
