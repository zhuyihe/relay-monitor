// 一条绑定一天的应付成本（V1-b，纯函数；公式在 lib/expected-cost.js）：把这一天的小时桶按这条绑定的渠道、按倍率分段切开，各段各算，加起来。
// 算不出的情况给原因码（用语规范 §5.7 / #118 §3.1），一天只给一个原因（按下面的先后）：
//   EXPECTED_COST_DISABLED           系统设置「算应付成本」关着（§8.3；关着那几天固定的，以后打开也不补算）
//   UPSTREAM_PRICE_UNSUPPORTED  上游不是 New API（Sub2API 没有价目表）
//   NOT_STARTED                 这天在开始统计之前，或者没有分段
//   KEY_SHARED                  这把 Key 别处也在用（上游扣的钱分不出来）
//   GROUP_AUTO                  分组是 auto、或请求在几个分组之间重试过
//   DAY_BOUNDARY_UNSUPPORTED    这条绑定的时区的一天不是从整点开始，小时桶拼不出这一天
//   EXPECTED_COST_LAGGING          整站日志还没读完这一天（进度没过这天结束）
//   MODEL_PRICE_UNREADABLE      上游价目表读不到
//   MODEL_PRICE_MISSING         有模型上游没给价格（列出来）
//   CACHE_FIELDS_UNKNOWN        自营站点的记录看不出缓存用了多少（openai 口径下缓存读比输入还多，说明字段对不上）
// 不引 node: 模块。
import { OWN_LOG_SLOT_MS } from "./own-log-bucket.js";
import { expectedCostOf } from "./expected-cost.js";

export const GAP_THRESHOLD = Object.freeze({ usd: 0.05, rate: 0.02 }); // 「对不上」门槛：差额同时超过这两个才算；跑一两周按真实差额再调

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

// 这一天的桶（按渠道筛过）按倍率分段：segments [{ startMs, endMs, ratio }]（按时间排好、不重叠）；桶按小时，落在哪一段按小时起点算
function splitBySegments(buckets, segments) {
  return segments.map((segment) => ({ segment, buckets: buckets.filter((bucket) => bucket.slotMs >= segment.startMs && bucket.slotMs < segment.endMs) }));
}

/**
 * window：这一天 { startMs, endMs, timezone }；buckets：这个站点这一天范围里的小时桶（调用方按 slot 范围读，这里再按渠道筛）；
 * channelIds：这条绑定的渠道；segments：这一天里各段的上游分组倍率 [{ startMs, endMs, ratio, group }]；
 * pricing：价目表（lib/expected-cost.js pricingTableOf 的形状）或 null；pricingError：读不到时的错（带码）；
 * quotaPerUnit：上游的额度换算；flags：{ off（「算应付成本」关着）, platform, keyShared, groupAuto, coveredToMs（整站日志读到哪） }
 * 返回 { usd, reason, tokens, byModel, missingPriceModels, segments: [{ startMs, endMs, ratio, usd }], byChannel: [{ channelId, usd }] }
 */
export function expectedCostForDay({ window, buckets = [], channelIds = [], segments = [], pricing = null, pricingError = null, quotaPerUnit = null, flags = {} }) {
  const wanted = new Set((channelIds || []).map(Number));
  const mine = (buckets || []).filter((bucket) => wanted.has(Number(bucket.channelId)) && bucket.slotMs >= window.startMs && bucket.slotMs < window.endMs);
  const tokens = mine.reduce((sum, bucket) => sum + num(bucket.promptTokens) + num(bucket.completionTokens) + num(bucket.cacheWriteTokens), 0);
  const none = (reason, extra = {}) => ({ usd: null, reason, tokens, byModel: [], missingPriceModels: [], segments: [], byChannel: [], ...extra });
  if (flags.off) return none("EXPECTED_COST_DISABLED");
  if (flags.platform && flags.platform !== "newapi") return none("UPSTREAM_PRICE_UNSUPPORTED");
  if (!segments.length) return none("NOT_STARTED");
  if (flags.keyShared) return none("KEY_SHARED");
  if (flags.groupAuto || segments.some((segment) => segment.group === "auto")) return none("GROUP_AUTO");
  if (window.startMs % OWN_LOG_SLOT_MS !== 0 || window.endMs % OWN_LOG_SLOT_MS !== 0) return none("DAY_BOUNDARY_UNSUPPORTED");
  if (!(flags.coveredToMs >= window.endMs)) return none("EXPECTED_COST_LAGGING");
  if (!pricing) return none(pricingError?.code && pricingError.code !== "UPSTREAM_REQUEST_FAILED" ? pricingError.code : "MODEL_PRICE_UNREADABLE");
  if (mine.some((bucket) => bucket.semantic !== "anthropic" && num(bucket.cacheReadTokens) > num(bucket.promptTokens))) return none("CACHE_FIELDS_UNKNOWN");
  const unit = quotaPerUnit > 0 ? quotaPerUnit : undefined;
  const parts = splitBySegments(mine, segments).map(({ segment, buckets: part }) => ({ segment, buckets: part, result: expectedCostOf(part, pricing, { groupRatio: num(segment.ratio) || 1, ...(unit ? { quotaPerUnit: unit } : {}) }) }));
  const missing = new Map();
  for (const { result } of parts) for (const row of result.missingPriceModels) {
    const key = `${row.model}\u0000${row.upstreamModel}`, acc = missing.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0 };
    acc.requests += row.requests; acc.inputTokens += row.inputTokens; acc.outputTokens += row.outputTokens; missing.set(key, acc);
  }
  const byModelMap = new Map();
  for (const { result } of parts) for (const row of result.byModel) {
    const key = `${row.model}\u0000${row.upstreamModel}`, acc = byModelMap.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
    for (const field of ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "usd"]) acc[field] += row[field];
    byModelMap.set(key, acc);
  }
  const segmentRows = parts.map(({ segment, result }) => ({ startMs: segment.startMs, endMs: segment.endMs, ratio: num(segment.ratio) || 1, group: segment.group ?? null, usd: result.usd }));
  const byModel = [...byModelMap.values()].sort((a, b) => b.usd - a.usd), missingPriceModels = [...missing.values()].sort((a, b) => b.requests - a.requests);
  if (missingPriceModels.length) return { usd: null, reason: "MODEL_PRICE_MISSING", tokens, byModel, missingPriceModels, segments: segmentRows, byChannel: [] };
  // 渠道级的应付成本（计算明细里看；实付只到 Key，不按渠道分）
  const byChannel = [...wanted].map((channelId) => ({ channelId, usd: parts.reduce((sum, { segment, buckets: part }) =>
    sum + (expectedCostOf(part.filter((bucket) => Number(bucket.channelId) === channelId), pricing, { groupRatio: num(segment.ratio) || 1, ...(unit ? { quotaPerUnit: unit } : {}) }).usd ?? 0), 0) }));
  return { usd: segmentRows.reduce((sum, row) => sum + (row.usd ?? 0), 0), reason: null, tokens, byModel, missingPriceModels, segments: segmentRows, byChannel };
}

// 差额（读的时候现算，不存）：实付 − 应付；超过门槛（两个都超）才「对不上」。任一边没有就 null
export function gapOf(actualCostUsd, expectedCostUsd, threshold = GAP_THRESHOLD) {
  if (!(Number.isFinite(Number(actualCostUsd)) && actualCostUsd != null) || !(Number.isFinite(Number(expectedCostUsd)) && expectedCostUsd != null)) return null;
  const usd = Number(actualCostUsd) - Number(expectedCostUsd);
  const rate = Number(expectedCostUsd) > 0 ? usd / Number(expectedCostUsd) : (usd === 0 ? 0 : null);
  const mismatched = Math.abs(usd) > threshold.usd && (rate == null || Math.abs(rate) > threshold.rate);
  return { usd, rate, state: mismatched ? (usd > 0 ? "over" : "under") : "within" };
}
