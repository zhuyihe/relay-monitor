// 合并重复的上游：先算出清单和合并前后的成本估算（只读，不改任何数据），用户确认后才合。
// 清单页面在 K2d（「渠道」页签的合并确认）；这里是它背后的两个动作：previewUpstreamMerges、applyUpstreamMerge。
// 上游文档（Store）和绑定、关联（对账仓库的表）在同一个事务里一起改，见 db/store.js 的 mergeUpstreams。
import { mergedStationPatches, planUpstreamMerges } from "../lib/upstream-merge.js";
import { businessTimeZone, dayKeyInTz, shiftDayLabel } from "../lib/business-time.js";
import { rateSnapshotOf } from "../lib/profit.js";
import { dailyUsageRows } from "./station-usage.js";
import { aliasesAfterUndo, applyMergeRows, countMerges, listMerges, MERGE_LOG_KIND, mergeError, newMergeId, readMergeBasis, undoMergeRows } from "../db/upstream-merge-repository.js";

const ESTIMATE_DAYS = [7, 30];

// 清单上要看的站（和上游列表一样不含已归档、已被合并的）
const listedStations = (rt) => rt.store.list({ includeUnmonitored: true, includeArchived: true });

export async function planNow(rt) {
  const basis = await readMergeBasis(rt.pool);
  return planUpstreamMerges({ stations: listedStations(rt), ...basis });
}

const round2 = (value) => Math.round(value * 100) / 100;

// 合并前后近 7 天、近 30 天的成本估算：读成本估算页同一份数（每站每日消耗 × 上游自己的汇率，逐日四舍五入再加，和页面的总成本一样），
// 所以合并以后成本估算页的数就等于这里写的「后」。合并前是这个账号下每个上游各算一遍再加起来，合并后只算留下的那个。
// 一次读 30 天，7 天从里面取；某天一条记录都没有时这个窗口标 approx（页面带「≈」，和成本估算页同一个判断思路）；读不到时 estimate 是 null，页面写「—」，不挡合并。
export async function estimateGroups(rt, groups, { now }) {
  const tz = businessTimeZone();
  const end = dayKeyInTz(now, tz);
  const start = shiftDayLabel(end, -(Math.max(...ESTIMATE_DAYS) - 1));
  const ids = [...new Set(groups.flatMap((group) => [group.retained.id, ...group.merged.map((station) => station.id)]))];
  let rows;
  try {
    rows = await dailyUsageRows(rt.pool, ids, start, end);
  } catch {
    return groups.map(() => null);
  }
  const cnyOf = (stationId, usd) => round2(Number(usd) * rateSnapshotOf(rt.store.get(stationId)).cnyPerUsd);
  return groups.map((group) => ({ windows: ESTIMATE_DAYS.map((days) => {
    const from = shiftDayLabel(end, -(days - 1));
    const sums = new Map([group.retained, ...group.merged].map((station) => [station.id, 0]));
    for (const row of rows) if (row.date >= from && sums.has(row.stationId)) sums.set(row.stationId, sums.get(row.stationId) + cnyOf(row.stationId, row.usd));
    const upstreams = [...sums].map(([stationId, cny]) => ({ stationId, cny: round2(cny) }));
    // 这段时间里有哪一天这个账号下的上游一条记录都没有：和成本估算页一样，数是估算的，带「≈」
    const covered = new Set(rows.filter((row) => row.date >= from && sums.has(row.stationId)).map((row) => row.date));
    return { days, approx: covered.size < days, before: { cny: round2(upstreams.reduce((sum, item) => sum + item.cny, 0)), upstreams },
      after: { cny: upstreams[0].cny, upstreams: [upstreams[0]] } };
  }) }));
}

// 清单：{ groups, counts, records, generatedAt }。estimate: false 只出清单不估算
export async function previewUpstreamMerges(rt, { estimate = true, now = Date.now() } = {}) {
  const plan = await planNow(rt);
  const { groups } = plan;
  const records = await listMergeRecords(rt);
  const counts = mergeCounts(plan);
  if (!estimate) return { groups, counts, records, generatedAt: now };
  const estimates = await estimateGroups(rt, groups, { now });
  return { groups: groups.map((group, i) => ({ ...group, estimate: estimates[i] })), counts, records, generatedAt: now };
}

// 合并一组：请求里带的是清单上看到的「留下的、被合掉的」，这里按现在的数据重新算一遍，对不上就不合
export async function applyUpstreamMerge(rt, { retainedId, mergedIds }, { now = Date.now() } = {}) {
  const requested = [...new Set((mergedIds || []).map(String))].sort();
  if (!retainedId || !requested.length) throw mergeError("UPSTREAM_MERGE_INVALID", "要合并的上游不完整");
  const { groups } = await planNow(rt);
  const group = groups.find((item) => item.retained.id === retainedId);
  if (!group || JSON.stringify(group.merged.map((station) => station.id).sort()) !== JSON.stringify(requested)) {
    throw mergeError("UPSTREAM_MERGE_STALE", "清单变了，请重新看一遍");
  }
  if (!group.canMerge) throw mergeError("UPSTREAM_MERGE_BLOCKED", "这一组现在不能合并");
  const mergeId = newMergeId();
  const oldAliases = [...(rt.store.get(retainedId).costAliases || [])];
  const patches = mergedStationPatches(group, { nowIso: new Date(now).toISOString() });
  let rows;
  await rt.store.mergeUpstreams({
    retainedId, mergedIds: requested, patches,
    within: async (conn) => { rows = await applyMergeRows(conn, group, { mergeId, nowMs: now, oldRetainedAliases: oldAliases }); },
  });
  rt._mergeCountsCache = null;
  return { mergeId, retainedId, mergedIds: requested, ...rows };
}

// 清单上有几组能合、几组合不了：上游列表顶上那条提示和成本估算那一行只要这两个数
// accounts、upstreams：成本估算页那一行「其中 1 个账号加成了 2 个上游」要的两个数（合并前这些账号一共有几个上游）
export function mergeCounts(plan) {
  return { mergeable: plan.groups.filter((group) => group.canMerge).length, blocked: plan.groups.filter((group) => !group.canMerge).length,
    accounts: plan.groups.length, upstreams: plan.groups.reduce((sum, group) => sum + 1 + group.merged.length, 0) };
}

const COUNTS_TTL_MS = 60 * 1000;

// 上游列表顶上的提示和成本估算那一行要的几个数：跟着这两页本来就有的读法带回去，不另起轮询。算一次要读绑定、关联各一条查询，缓存 1 分钟；
// 合并、退回以后马上作废。读不到时是 null，页面就不出那条提示
export async function cachedMergeCounts(rt, { now = Date.now() } = {}) {
  const hit = rt._mergeCountsCache;
  if (hit && now - hit.at < COUNTS_TTL_MS) return hit.counts;
  let counts = null;
  try { counts = { ...mergeCounts(await planNow(rt)), records: await countMerges(rt.pool) }; } catch { /* 读不到就先不提示 */ }
  rt._mergeCountsCache = { at: now, counts };
  return counts;
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
      const gone = [retained, ...merged].find((station) => !rt.store.get(station.id));
      if (gone) undoBlocked = { code: "UPSTREAM_DELETED", detail: `「${gone.name}」已经删了，退回不了`, stationId: gone.id };
      else if (merged.some((station) => rt.store.get(station.id).mergedInto !== merge.retainedId)) {
        undoBlocked = { code: "UPSTREAM_CHANGED", detail: "这次合并之后上游又变过，退回不了" };
      }
    }
    return { mergeId: merge.mergeId, mergedAtMs: merge.mergedAtMs, undoneAtMs: merge.undoneAtMs, retained, merged, undoable: merge.undoneAtMs == null && !undoBlocked, undoBlocked };
  });
}

// 退回一次合并：和 db/k-unmerge.js --apply 同一段代码（undoMergeRows）；服务在跑，所以上游文档由 Store 在同一个事务里改
export async function undoUpstreamMerge(rt, { mergeId }, { now = Date.now() } = {}) {
  const [merge] = await listMerges(rt.pool, { mergeId });
  if (!merge) throw mergeError("UPSTREAM_MERGE_STALE", "这次合并已经退回了，请刷新后再看");
  const record = (await listMergeRecords(rt)).find((item) => item.mergeId === mergeId);
  if (record?.undoBlocked) throw mergeError("UPSTREAM_MERGE_BLOCKED", record.undoBlocked.detail);
  const detail = merge.rows.find((row) => row.kind === MERGE_LOG_KIND.STATION_RETAINED).detail;
  await rt.store.unmergeUpstreams({
    retainedId: merge.retainedId, mergedIds: merge.mergedIds,
    costAliasesOf: (current) => aliasesAfterUndo(current, detail) || [],
    within: (conn) => undoMergeRows(conn, merge, { nowMs: now, stations: false }),
  });
  rt._mergeCountsCache = null;
  return { mergeId, retainedId: merge.retainedId, mergedIds: merge.mergedIds };
}
