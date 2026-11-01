// 模型供需用的查询：自营站点被上游拒绝的次数（错误日志的小时计数，server/own-log-ingest.js 的错误日志那条流水线存的）和对应的成功请求数
// （消费日志的小时桶 own_log_buckets 的请求数），按模型、按上游（渠道 → 现有绑定）、按小时汇总。只读已经存好的计数，不碰自营站点。
// 「被拒」是上游或渠道给的错：429、5xx、529、超时、Key 失效、余额不够……（分五类，见 lib/own-error-bucket.js）；分发阶段「无可用渠道」、你站对用户的限流、用户没钱不进错误日志。
// 「被拒过的请求数」= 第 1 次尝试的条数：每个碰到过失败的请求只有一条第 1 次（后面重试的失败是第 2、3 次），所以它数的是请求，不是失败的次数。
// 成功请求数是消费日志的请求数（重试成功的请求只记一条成功）。
import { ERROR_REASONS, OWN_ERROR_SLOT_MS } from "../lib/own-error-bucket.js";

const emptyAgg = () => ({ rejected: { ...Object.fromEntries(ERROR_REASONS.map((reason) => [reason, 0])), total: 0 }, rejectedRequests: 0, success: 0 });
function addError(agg, bucket) {
  agg.rejected[bucket.reason] = (agg.rejected[bucket.reason] || 0) + bucket.count;
  agg.rejected.total += bucket.count;
  if (bucket.attempt === 1) agg.rejectedRequests += bucket.count;
}
const addSuccess = (agg, bucket) => { agg.success += bucket.requests; };

// 渠道 → 现有绑定：rules 是 repository.listRules() 的结果；只算启用的、属于这个自营站点的绑定。返回 Map(渠道 id → { upstreamStationId, ruleId })
export function channelUpstreamMap(rules, ownStationId) {
  const map = new Map();
  for (const rule of rules || []) {
    if (rule.enabled === false || rule.archivedAt || rule.ownStationId !== ownStationId) continue;
    for (const channel of rule.channels || []) if (!map.has(channel.channelId)) map.set(channel.channelId, { upstreamStationId: rule.upstreamStationId, ruleId: rule.id });
  }
  return map;
}

/**
 * errors、consume：两个桶存取（OwnLogStore，错误日志 spec 和消费日志 spec 各一个）；stationId：自营站点；fromMs、toMs：时间范围（按小时对齐：from 向下、to 向上取整点）；
 * channelUpstream：channelUpstreamMap 的结果；渠道不在里面的归到「没对上上游」（upstreamStationId 是 null）。
 * 返回 {
 *   fromSlotMs, toSlotMs, cursor（错误日志读到哪儿了，没读过是 null）,
 *   total, byModel: [{ model, ...agg }]（被拒多的在前）, byUpstream: [{ upstreamStationId, channelIds, ...agg }], byHour: [{ slotMs, ...agg }]（每个小时都有，没有的是 0）
 * }；agg = { rejected: { rate_limit, upstream, auth_quota, bad_request, other, total }, rejectedRequests, success }
 */
export async function queryErrorSupply({ errors, consume, stationId, fromMs, toMs, channelUpstream = new Map() }) {
  const fromSlotMs = Math.floor(fromMs / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS, toSlotMs = Math.max(fromSlotMs, Math.ceil(toMs / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS);
  const [errorBuckets, consumeBuckets, cursor] = await Promise.all([
    errors.listBuckets(stationId, fromSlotMs, toSlotMs), consume.listBuckets(stationId, fromSlotMs, toSlotMs), errors.getCursor(stationId),
  ]);
  const total = emptyAgg();
  const models = new Map(), upstreams = new Map(), hours = new Map();
  for (let slotMs = fromSlotMs; slotMs < toSlotMs; slotMs += OWN_ERROR_SLOT_MS) hours.set(slotMs, { slotMs, ...emptyAgg() });
  const modelOf = (model) => { let agg = models.get(model); if (!agg) models.set(model, agg = { model, ...emptyAgg() }); return agg; };
  const upstreamOf = (channelId) => {
    const upstreamStationId = channelUpstream.get(channelId)?.upstreamStationId ?? null;
    let agg = upstreams.get(upstreamStationId);
    if (!agg) upstreams.set(upstreamStationId, agg = { upstreamStationId, channelIds: new Set(), ...emptyAgg() });
    agg.channelIds.add(channelId);
    return agg;
  };
  for (const bucket of errorBuckets) {
    for (const agg of [total, modelOf(bucket.model), upstreamOf(bucket.channelId), hours.get(bucket.slotMs)]) if (agg) addError(agg, bucket);
  }
  for (const bucket of consumeBuckets) {
    for (const agg of [total, modelOf(bucket.model), upstreamOf(bucket.channelId), hours.get(bucket.slotMs)]) if (agg) addSuccess(agg, bucket);
  }
  const byRejected = (a, b) => b.rejected.total - a.rejected.total || b.success - a.success;
  return {
    fromSlotMs, toSlotMs,
    cursor: cursor ? { coveredFromMs: cursor.coveredFromMs, coveredToMs: cursor.coveredToMs } : null,
    total,
    byModel: [...models.values()].sort((a, b) => byRejected(a, b) || a.model.localeCompare(b.model)),
    byUpstream: [...upstreams.values()].map((agg) => ({ ...agg, channelIds: [...agg.channelIds].sort((a, b) => a - b) })).sort((a, b) => byRejected(a, b) || String(a.upstreamStationId).localeCompare(String(b.upstreamStationId))),
    byHour: [...hours.values()],
  };
}
