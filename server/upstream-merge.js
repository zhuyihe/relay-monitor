// 合并重复的上游：先算出清单和合并前后的成本估算（只读，不改任何数据），用户确认后才合。
// 清单页面在 K2d（「渠道」页签的合并确认）；这里是它背后的两个动作：previewUpstreamMerges、applyUpstreamMerge。
// 上游文档（Store）和绑定、关联（对账仓库的表）在同一个事务里一起改，见 db/store.js 的 mergeUpstreams。
import { mergedStationPatches, planUpstreamMerges } from "../lib/upstream-merge.js";
import { businessTimeZone } from "../lib/business-time.js";
import { rateSnapshotOf, toCny } from "../lib/profit.js";
import { stationUsageCost } from "./own-helpers.js";
import { aliasesAfterUndo, applyMergeRows, listMerges, MERGE_LOG_KIND, mergeError, newMergeId, readMergeBasis, undoMergeRows } from "../db/upstream-merge-repository.js";

const DAY = 86400000;
const ESTIMATE_DAYS = [7, 30];
const ESTIMATE_TTL_MS = 5 * 60 * 1000;

// 清单上要看的站（和上游列表一样不含已归档、已被合并的）
const listedStations = (rt) => rt.store.list({ includeUnmonitored: true, includeArchived: true });

export async function planNow(rt) {
  const basis = await readMergeBasis(rt.pool);
  return planUpstreamMerges({ stations: listedStations(rt), ...basis });
}

// 一个上游近 N 天的上游成本：和每日利润页的「成本估算」同一个函数（stationUsageCost），按上游自己的汇率折人民币
async function stationCost(rt, station, { startMs, endMs, tz }) {
  const selected = await stationUsageCost(rt, station, { startMs, endMs, tz });
  return { stationId: station.id, name: station.name, usd: selected.usd, cny: toCny(selected.usd, rateSnapshotOf(station)), mode: selected.mode };
}

const round2 = (value) => Math.round(value * 100) / 100;

// 合并前：这个账号下每个上游各算一遍，加起来（同一个账号被几个上游各读一遍，用量重复算了）；合并后：只留下的那个算
export async function estimateGroup(rt, group, { now }) {
  const tz = businessTimeZone();
  const stations = [group.retained, ...group.merged].map((brief) => rt.store.get(brief.id));
  const windows = [];
  for (const days of ESTIMATE_DAYS) {
    const costs = await Promise.all(stations.map((station) => stationCost(rt, station, { startMs: now - days * DAY, endMs: now, tz })));
    windows.push({ days, before: { cny: round2(costs.reduce((sum, item) => sum + item.cny, 0)), upstreams: costs },
      after: { cny: round2(costs[0].cny), upstreams: [costs[0]] } });
  }
  return windows;
}

// 清单：{ groups, generatedAt }。估算要读上游的用量（每个上游两个窗口各一次），所以按上游合成的组缓存 5 分钟；
// estimate: false 只出清单不估算
export async function previewUpstreamMerges(rt, { estimate = true, now = Date.now() } = {}) {
  const plan = await planNow(rt);
  const { groups } = plan;
  const records = await listMergeRecords(rt);
  if (!estimate) return { groups, counts: mergeCounts(plan), records, generatedAt: now };
  const cache = (rt._upstreamMergeEstimates ||= new Map());
  const withEstimate = [];
  for (const group of groups) {
    const key = JSON.stringify([group.retained.id, group.merged.map((station) => station.id)]);
    const hit = cache.get(key);
    if (!hit || now - hit.at > ESTIMATE_TTL_MS) cache.set(key, { at: now, windows: await estimateGroup(rt, group, { now }) });
    withEstimate.push({ ...group, estimate: cache.get(key).windows });
  }
  return { groups: withEstimate, counts: mergeCounts(plan), records, generatedAt: now };
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
  rt._upstreamMergeEstimates?.clear();
  return { mergeId, retainedId, mergedIds: requested, ...rows };
}

// 清单上有几组能合、几组合不了：上游列表顶上那条提示和成本估算那一行只要这两个数
export function mergeCounts(plan) {
  return { mergeable: plan.groups.filter((group) => group.canMerge).length, blocked: plan.groups.filter((group) => !group.canMerge).length };
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
  rt._upstreamMergeEstimates?.clear();
  return { mergeId, retainedId: merge.retainedId, mergedIds: merge.mergedIds };
}
