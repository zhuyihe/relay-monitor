// 合并重复的上游：先算出清单和合并前后的成本估算（只读，不改任何数据），用户确认后才合。
// 清单页面在 K2d（「渠道」页签的合并确认）；这里是它背后的两个动作：previewUpstreamMerges、applyUpstreamMerge。
// 上游文档（Store）和绑定、关联（对账仓库的表）在同一个事务里一起改，见 db/store.js 的 mergeUpstreams。
import { mergedStationPatches, planUpstreamMerges } from "../lib/upstream-merge.js";
import { businessTimeZone } from "../lib/business-time.js";
import { rateSnapshotOf, toCny } from "../lib/profit.js";
import { stationUsageCost } from "./own-helpers.js";
import { applyMergeRows, mergeError, newMergeId, readMergeBasis } from "../db/upstream-merge-repository.js";

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
  const { groups } = await planNow(rt);
  if (!estimate) return { groups, generatedAt: now };
  const cache = (rt._upstreamMergeEstimates ||= new Map());
  const withEstimate = [];
  for (const group of groups) {
    const key = JSON.stringify([group.retained.id, group.merged.map((station) => station.id)]);
    const hit = cache.get(key);
    if (!hit || now - hit.at > ESTIMATE_TTL_MS) cache.set(key, { at: now, windows: await estimateGroup(rt, group, { now }) });
    withEstimate.push({ ...group, estimate: cache.get(key).windows });
  }
  return { groups: withEstimate, generatedAt: now };
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
