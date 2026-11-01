// 模型供需用的查询：自营站点被上游拒绝的次数（错误日志的小时计数，server/own-log-ingest.js 的错误日志那条流水线存的）和对应的成功请求数
// （消费日志的小时桶 own_log_buckets 的请求数），按渠道 × 模型 × 小时拼在一起，再汇总成按模型、按上游、按渠道、按小时。只读已经存好的计数，不碰自营站点。
// 「被拒」是上游或渠道给的错：429、5xx、529、超时、Key 失效、余额不够……（分五类，见 lib/own-error-bucket.js）；分发阶段「无可用渠道」、你站对用户的限流、用户没钱不进错误日志。
// 其中「请求问题」（bad_request：400、413、422、内容审核，是用户自己的请求写错了，不是货源的问题）不算被拒：不进 rejected（含 total）、不进「被拒过的请求数」、不进 F 的尝试数（推重试次数时也不算），
// 另给 badRequest 计数，页面不用。「没钱或 Key 失效」留着（Key 失效、没钱是货源的问题）；「其他」（404 之类）进被拒的总数和被拒过的请求数，不进 F。
// 「被拒过的请求数」= 第 1 次尝试的条数：每个碰到过失败的请求只有一条第 1 次（后面重试的失败是第 2、3…次），所以它数的是请求，不是失败的次数。
// 成功请求数是消费日志的请求数（重试成功的请求只记一条成功）。
//
// 「最终没买到的请求」F（已经丢的单）：一个请求一路失败下去，最后一次失败就是它的终点。这一次失败要么是「站点不会再试」（状态码不在自动重试范围、不重试的错误码），
// 要么是重试次数用完了（第 RetryTimes + 1 次尝试）。所以：
//   - 读得到站点的重试次数 R：F ≈ 不能重试的失败条数 + 第 R + 1 档的能重试的失败条数（R + 1 超过 10 按 10 档）。method: "retry-times"；
//   - 读不到 R：用近 7 天整个站点见到的最大档推 R（最大档 = R + 1，一场失败到底的请求会走到第 R + 1 档），再走上面「读得到 R」的公式。method: "inferred"；
//     错误日志读了不到 7 天，retry.approximate 是 true（页面写「约」）；近 7 天一条错误都没有就推不出来（method: "none"，没有错误也就没有 F）。
//     这个 F 可能偏高或偏低：推出来的 R 偏小（这 7 天没有请求一路失败到底）时会把中间那一档当成最后一档，多算；偏大时少算。
//     不用「这个小时见到的最大档」：R = 3 而这个小时只见到第 2 档时，会把第 2 档当成最后一档，多算。
//     不用「逐档相减」当估计：第 k 档比第 k + 1 档多出来的，既有「就此停了」的，也有「重试成功了」的，分不开，直接减会把重试成功的算成丢的单。
//     逐档相减的原始数（retriedOrStopped）一并给出，要不要用由页面和审核定。
// 站点没有选到渠道就停了的、用户自己重试、客户端放弃都看不到。按「模型 × 小时」算（一个请求的各次尝试都在同一个小时、同一个模型里，跨渠道），再往上加。
import { ERROR_REASONS, MAX_ATTEMPT, OWN_ERROR_SLOT_MS } from "../lib/own-error-bucket.js";
import { DEFAULT_BUSINESS_TIME_ZONE, wallHourOfSlot } from "../lib/business-time.js";

// 算「被拒」的原因：请求问题（bad_request）是用户自己的请求写错了，不算
export const REJECTED_REASONS = Object.freeze(ERROR_REASONS.filter((reason) => reason !== "bad_request"));
const DAY_MS = 86400000;
export const RETRY_INFER_DAYS = 7;
const emptyRejected = () => ({ ...Object.fromEntries(REJECTED_REASONS.map((reason) => [reason, 0])), total: 0 });
// 大多数格子（渠道 × 模型 × 小时）没有错误：共用一份冻住的空对象，第一次加错误时才复制（写时复制），省下几十万个小对象
const SHARED_REJECTED = Object.freeze(emptyRejected());
const SHARED_ATTEMPTS = Object.freeze({ retryable: Object.freeze(new Array(MAX_ATTEMPT).fill(0)), nonRetryable: Object.freeze(new Array(MAX_ATTEMPT).fill(0)) });
export const SUPPLY_CHUNK_SLOTS = 24; // 读桶一次读多少个小时（分批读，不一次读成两个大数组）
// sampled：这里面有几个窗口的被拒数是按样本估的（错误太多的窗口只读 300 条，按窗口总条数摊；0 = 都是实数）
const emptyAgg = () => ({ rejected: emptyRejected(), rejectedRequests: 0, badRequest: 0, success: 0, sampled: 0 });
const lazyAgg = () => ({ rejected: SHARED_REJECTED, rejectedRequests: 0, badRequest: 0, success: 0, sampled: 0 });
const emptyAttempts = () => ({ retryable: new Array(MAX_ATTEMPT).fill(0), nonRetryable: new Array(MAX_ATTEMPT).fill(0) });
function addError(agg, bucket) {
  if (bucket.reason === "bad_request") { agg.badRequest += bucket.count; return; }
  if (agg.rejected === SHARED_REJECTED) agg.rejected = emptyRejected();
  agg.rejected[bucket.reason] = (agg.rejected[bucket.reason] || 0) + bucket.count;
  agg.rejected.total += bucket.count;
  if (bucket.attempt === 1) agg.rejectedRequests += bucket.count;
  agg.sampled += bucket.sampled || 0;
}
// 请求问题、其他（404 之类）不进 F 的尝试数
const NOT_IN_F = new Set(["bad_request", "other"]);
const addAttempts = (owner, bucket) => {
  if (NOT_IN_F.has(bucket.reason)) return;
  if (owner.attempts === SHARED_ATTEMPTS) owner.attempts = emptyAttempts();
  owner.attempts[bucket.retryable ? "retryable" : "nonRetryable"][Math.min(MAX_ATTEMPT, Math.max(1, bucket.attempt)) - 1] += bucket.count;
};

// 渠道 → 现有绑定：rules 是 repository.listRules() 的结果；只算这个自营站点的、启用的、没解除的绑定。
// 返回 Map(渠道 id → { upstreamStationId, ruleId })。一条绑定 = 一把 Key，所以同一个 ruleId 下的渠道共用一把 Key 的限额；同一个 upstreamStationId 是同一个上游账号
export function channelUpstreamMap(rules, ownStationId) {
  const map = new Map();
  for (const rule of rules || []) {
    if (rule.enabled === false || rule.archivedAt || rule.ownStationId !== ownStationId) continue;
    for (const channel of rule.channels || []) if (!map.has(channel.channelId)) map.set(channel.channelId, { upstreamStationId: rule.upstreamStationId, ruleId: rule.id });
  }
  return map;
}

// 渠道去重：同一把 Key（by: "key"）或同一个上游账号（by: "upstream"）下的渠道只留一个代表（编号最小的）；没有绑定的渠道各算各的。返回 [{ id, members: [...] }]
export function dedupeChannels(channelIds, channelUpstream, by = "key") {
  const groups = new Map();
  for (const id of [...new Set(channelIds)].sort((a, b) => a - b)) {
    const info = channelUpstream.get(id);
    const key = by === "upstream" ? (info?.upstreamStationId != null ? `up:${info.upstreamStationId}` : `ch:${id}`) : (info?.ruleId != null ? `rule:${info.ruleId}` : `ch:${id}`);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { id, members: [] });
    group.members.push(id);
  }
  return [...groups.values()];
}

// 一个「模型 × 小时」里最终没买到的请求数（见文件头）；attempts：{ retryable: [1–10 档], nonRetryable: [1–10 档] }；retryTimes：站点的重试次数（读到的或推出来的），没有是 null
export function estimateFinalFailures(attempts, retryTimes = null) {
  const sum = (list) => list.reduce((total, n) => total + n, 0);
  const nonRetryable = sum(attempts.nonRetryable);
  const all = (tier) => attempts.retryable[tier - 1] + attempts.nonRetryable[tier - 1];
  // 逐档相减的原始数：第 k 档能重试的失败比第 k + 1 档的失败多出来的（就此停了的 + 重试成功的，分不开）
  let retriedOrStopped = 0;
  for (let tier = 1; tier <= MAX_ATTEMPT; tier += 1) retriedOrStopped += Math.max(0, attempts.retryable[tier - 1] - (tier < MAX_ATTEMPT ? all(tier + 1) : 0));
  if (Number.isInteger(retryTimes) && retryTimes >= 0) {
    const top = Math.min(MAX_ATTEMPT, retryTimes + 1);
    return { finalFailures: nonRetryable + attempts.retryable[top - 1], method: "retry-times", retriedOrStopped };
  }
  return { finalFailures: nonRetryable, method: "none", retriedOrStopped };
}

// 业务时区的墙上时钟（每个小时是哪一天的几点、夏令时那两天一天 23 / 25 个小时、重复的钟点第二个 repeated）：算法在 lib/business-time.js
export const wallHourOf = (slotMs, tz = DEFAULT_BUSINESS_TIME_ZONE) => wallHourOfSlot(slotMs, tz, OWN_ERROR_SLOT_MS);

/**
 * errors、consume：两个桶存取（OwnLogStore，错误日志 spec 和消费日志 spec 各一个）；stationId：自营站点；fromMs、toMs：时间范围（按小时对齐：from 向下、to 向上取整点）；
 * channelUpstream：channelUpstreamMap 的结果；渠道不在里面的归到「没对上上游」（upstreamStationId 是 null）；
 * tz：业务时区（算每个小时是哪一天的几点）；retry：站点的重试设置 { retryTimes }（读不到是 null，F 用近 7 天整个站点见到的最大档推 R，见文件头）。
 * 被拒的数里有按样本估的（sampled > 0）：错误太多的窗口只读最晚的 300 条，按窗口总条数摊上去，页面该写「约」。
 * 返回 {
 *   fromSlotMs, toSlotMs, tz, cursor（错误日志读到哪儿了，没读过是 null）, retry: { retryTimes（读到的或推出来的，没有是 null）, method: "retry-times" | "inferred" | "none", approximate（推出来的，错误日志读了不到 7 天） },
 *   total, byModel, byUpstream, byChannel, byHour, byModelHour, cells
 * }；agg = { rejected: { rate_limit, upstream, auth_quota, other, total }, rejectedRequests, badRequest（请求问题的条数，不算被拒，页面不用）, success, sampled }（byModel / byHour / byModelHour / total 另有 finalFailures）：
 *   byModel: [{ model, ...agg, finalFailures }]（被拒多的在前）；byUpstream: [{ upstreamStationId, channelIds, ...agg }]；
 *   byChannel: [{ channelId, ruleId, upstreamStationId, ...agg, hours: [{ slotMs, ...agg }] }]——这个渠道所有模型加起来的成交和被拒，按小时，测上限用；
 *   byHour: [{ slotMs, dayKey, hour, repeated, ...agg, finalFailures }]（每个小时都有，没有的是 0）；
 *   byModelHour: [{ slotMs, model, ...agg, finalFailures, retriedOrStopped }]；
 *   cells: [{ slotMs, channelId, model, success, rejected, rejectedRequests, attempts: { retryable: [1–10 档], nonRetryable: [1–10 档] } }]（渠道 × 模型 × 小时，有数的才有）
 * }
 */
export async function queryErrorSupply({ errors, consume, stationId, fromMs, toMs, channelUpstream = new Map(), tz = DEFAULT_BUSINESS_TIME_ZONE, retry = null, maxRows = Infinity }) {
  const fromSlotMs = Math.floor(fromMs / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS, toSlotMs = Math.max(fromSlotMs, Math.ceil(toMs / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS);
  const cursor = await errors.getCursor(stationId);
  let retryTimes = Number.isInteger(retry?.retryTimes) && retry.retryTimes >= 0 ? retry.retryTimes : null;
  let method = retryTimes != null ? "retry-times" : "none", approximate = false;
  if (retryTimes == null) {
    // 读不到站点的重试次数：用近 7 天整个站点见到的最大档推（最大档 = R + 1）
    const top = await errors.maxAttempt(stationId, Math.min(fromSlotMs, toSlotMs - RETRY_INFER_DAYS * DAY_MS), toSlotMs);
    if (top > 0) { retryTimes = top - 1; method = "inferred"; approximate = !cursor || cursor.coveredToMs - cursor.coveredFromMs < RETRY_INFER_DAYS * DAY_MS; }
  }
  const cells = new Map(), modelHours = new Map();
  const cellOf = (slotMs, channelId, model) => {
    const key = `${slotMs}|${channelId}|${model}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = { slotMs, channelId, model, ...lazyAgg(), attempts: SHARED_ATTEMPTS });
    return cell;
  };
  const modelHourOf = (slotMs, model) => {
    const key = `${slotMs}|${model}`;
    let entry = modelHours.get(key);
    if (!entry) modelHours.set(key, entry = { slotMs, model, ...lazyAgg(), attempts: SHARED_ATTEMPTS });
    return entry;
  };
  // 分批读（每批 SUPPLY_CHUNK_SLOTS 个小时），一批一批往格子里加，不把整段时间的桶一次读成两个大数组；
  // 读到的桶行数（错误日志 + 整站消费日志）超过 maxRows 就停，抛 TOO_MANY_BUCKETS（调用方当「这次不算」）
  let rows = 0;
  for (let from = fromSlotMs; from < toSlotMs; from += SUPPLY_CHUNK_SLOTS * OWN_ERROR_SLOT_MS) {
    const to = Math.min(toSlotMs, from + SUPPLY_CHUNK_SLOTS * OWN_ERROR_SLOT_MS);
    const [errorBuckets, consumeBuckets] = await Promise.all([errors.listBuckets(stationId, from, to), consume.listBuckets(stationId, from, to)]);
    rows += errorBuckets.length + consumeBuckets.length;
    if (rows > maxRows) throw Object.assign(new Error("too many buckets"), { code: "TOO_MANY_BUCKETS" });
    for (const bucket of errorBuckets) {
      const cell = cellOf(bucket.slotMs, bucket.channelId, bucket.model), modelHour = modelHourOf(bucket.slotMs, bucket.model);
      addError(cell, bucket); addAttempts(cell, bucket);
      addError(modelHour, bucket); addAttempts(modelHour, bucket);
    }
    for (const bucket of consumeBuckets) {
      cellOf(bucket.slotMs, bucket.channelId, bucket.model).success += bucket.requests;
      modelHourOf(bucket.slotMs, bucket.model).success += bucket.requests;
    }
  }
  // 汇总：从渠道 × 模型 × 小时的格子往上加
  const total = { ...emptyAgg(), finalFailures: 0 };
  const models = new Map(), upstreams = new Map(), channels = new Map(), hours = new Map();
  for (let slotMs = fromSlotMs; slotMs < toSlotMs; slotMs += OWN_ERROR_SLOT_MS) hours.set(slotMs, { slotMs, ...wallHourOf(slotMs, tz), ...emptyAgg(), finalFailures: 0 });
  const merge = (target, source) => {
    for (const reason of [...REJECTED_REASONS, "total"]) target.rejected[reason] += source.rejected[reason];
    target.rejectedRequests += source.rejectedRequests; target.badRequest += source.badRequest; target.success += source.success; target.sampled += source.sampled;
  };
  const infoOf = (channelId) => channelUpstream.get(channelId) || null;
  for (const cell of cells.values()) {
    const info = infoOf(cell.channelId);
    merge(total, cell);
    let model = models.get(cell.model); if (!model) models.set(cell.model, model = { model: cell.model, ...emptyAgg(), finalFailures: 0 }); merge(model, cell);
    const upstreamKey = info?.upstreamStationId ?? null;
    let upstream = upstreams.get(upstreamKey); if (!upstream) upstreams.set(upstreamKey, upstream = { upstreamStationId: upstreamKey, channelIds: new Set(), ...emptyAgg() }); merge(upstream, cell); upstream.channelIds.add(cell.channelId);
    let channel = channels.get(cell.channelId);
    if (!channel) channels.set(cell.channelId, channel = { channelId: cell.channelId, ruleId: info?.ruleId ?? null, upstreamStationId: upstreamKey, ...emptyAgg(), hourMap: new Map() });
    merge(channel, cell);
    let hourAgg = channel.hourMap.get(cell.slotMs); if (!hourAgg) channel.hourMap.set(cell.slotMs, hourAgg = { slotMs: cell.slotMs, ...emptyAgg() }); merge(hourAgg, cell);
    const hour = hours.get(cell.slotMs); if (hour) merge(hour, cell);
  }
  // F 按「模型 × 小时」算，再往上加
  const byModelHour = [];
  for (const entry of modelHours.values()) {
    const { finalFailures, retriedOrStopped } = estimateFinalFailures(entry.attempts, retryTimes);
    const { attempts, ...rest } = entry;
    byModelHour.push({ ...rest, finalFailures, retriedOrStopped });
    total.finalFailures += finalFailures;
    models.get(entry.model).finalFailures += finalFailures;
    const hour = hours.get(entry.slotMs); if (hour) hour.finalFailures += finalFailures;
  }
  const byRejected = (a, b) => b.rejected.total - a.rejected.total || b.success - a.success;
  return {
    fromSlotMs, toSlotMs, tz,
    cursor: cursor ? { coveredFromMs: cursor.coveredFromMs, coveredToMs: cursor.coveredToMs } : null,
    retry: { retryTimes, method, approximate },
    total,
    byModel: [...models.values()].sort((a, b) => byRejected(a, b) || a.model.localeCompare(b.model)),
    byUpstream: [...upstreams.values()].map((agg) => ({ ...agg, channelIds: [...agg.channelIds].sort((a, b) => a - b) })).sort((a, b) => byRejected(a, b) || String(a.upstreamStationId).localeCompare(String(b.upstreamStationId))),
    byChannel: [...channels.values()].map(({ hourMap, ...channel }) => ({ ...channel, hours: [...hourMap.values()].sort((a, b) => a.slotMs - b.slotMs) })).sort((a, b) => a.channelId - b.channelId),
    byHour: [...hours.values()],
    byModelHour: byModelHour.sort((a, b) => a.slotMs - b.slotMs || a.model.localeCompare(b.model)),
    cells: [...cells.values()].sort((a, b) => a.slotMs - b.slotMs || a.channelId - b.channelId || a.model.localeCompare(b.model)),
  };
}

// 谁被拒了：按用户 ID（日志里的 user_id，不存用户名、不出现邮箱；页面上的用户名由用户运营那边已有的 ID ↔ 用户名对应来换）。
// 返回 [{ userId, rejected: { 四类（不含请求问题）, total }, rejectedRequests（第 1 次尝试的条数 = 被拒过的请求数）, byModel: [{ model, rejected, rejectedRequests }] }]，被拒多的在前；
// models 给了只看这几个模型；top 只留前几位（不给全留）
export async function queryRejectedUsers({ errors, stationId, fromMs, toMs, models = null, top = null }) {
  const fromSlotMs = Math.floor(fromMs / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS, toSlotMs = Math.max(fromSlotMs, Math.ceil(toMs / OWN_ERROR_SLOT_MS) * OWN_ERROR_SLOT_MS);
  const wanted = models ? new Set(models) : null;
  const users = new Map();
  for (const bucket of await errors.listBuckets(stationId, fromSlotMs, toSlotMs, { table: "user" })) {
    if ((wanted && !wanted.has(bucket.model)) || bucket.reason === "bad_request") continue; // 请求问题是用户自己的请求写错了，不算被挡的用户
    let user = users.get(bucket.userId);
    if (!user) users.set(bucket.userId, user = { userId: bucket.userId, rejected: emptyRejected(), rejectedRequests: 0, sampled: 0, models: new Map() });
    let model = user.models.get(bucket.model);
    if (!model) user.models.set(bucket.model, model = { model: bucket.model, rejected: emptyRejected(), rejectedRequests: 0, sampled: 0 });
    for (const target of [user, model]) { target.rejected[bucket.reason] = (target.rejected[bucket.reason] || 0) + bucket.count; target.rejected.total += bucket.count; target.rejectedRequests += bucket.firstCount; target.sampled += bucket.sampled || 0; }
  }
  const sorted = [...users.values()].map(({ models: byModel, ...user }) => ({ ...user, byModel: [...byModel.values()].sort((a, b) => b.rejected.total - a.rejected.total || a.model.localeCompare(b.model)) }))
    .sort((a, b) => b.rejected.total - a.rejected.total || a.userId - b.userId);
  return top != null ? sorted.slice(0, top) : sorted;
}
