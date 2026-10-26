// 一条绑定一天的应付成本（V1-b，纯函数；公式在 lib/expected-cost.js）：把这一天的小时桶按这条绑定的渠道、按倍率分段切开，各段各算，加起来。
// 算不出的情况给原因码（用语规范 §5.7 / #118 §3.1），一天只给一个原因（按下面的先后）：
//   EXPECTED_COST_DISABLED           系统设置「算应付成本」关着（§8.3；关着那几天固定的，以后打开也不补算）
//   UPSTREAM_PRICE_UNSUPPORTED  上游不是 New API（Sub2API 没有价目表）
//   NOT_STARTED                 这天在开始统计之前、没有分段，或者这天在整站日志进度起点之前（进度从昨天 0 点起，更早的日子永远补不上，
//                                                        和「还没开始统计」是同一回事，不是「读得慢」；审核 R2 #125 中-1）
//   KEY_SHARED                  这把 Key 别处也在用（上游扣的钱分不出来）
//   GROUP_AUTO                  分组是 auto、或请求在几个分组之间重试过
//   DAY_BOUNDARY_UNSUPPORTED    这条绑定的时区的一天不是从整点开始，小时桶拼不出这一天
//   PARTIAL_HOUR_UNSUPPORTED    这天实际记账的时段不从整点开始、或不在整点结束（当天换绑、停止算利润的那天），收费记录按整点记，切不开
//                                                        （总指挥 10-26 定，决定 C；V1 不按分钟切）
//   EXPECTED_COST_LAGGING          整站日志还没读完这一天（进度没过这天结束）
//   MODEL_PRICE_UNREADABLE      上游价目表读不到
//   MODEL_PRICE_MISSING         有模型上游没给价格（列出来）
//   MODEL_PRICE_TIERED_UNSUPPORTED  有模型按分档计价（billing_mode: tiered_expr），这里的公式套不上，不猜（列出来；审核 R2 #125 中-3，
//                                                        码和页面上的字还要设计定，先用这个占位）
//   CACHE_FIELDS_UNKNOWN        自营站点的记录看不出缓存用了多少（openai 口径下缓存读比输入还多，说明字段对不上）
// tokens：只有这天整站日志真的整段读完（覆盖范围盖住这一天）才写，不然是 null——算不出、读不全时不能照半截的桶数写「这天用了多少 Token」
// （审核 R2 #125 中-4）。不引 node: 模块。
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
 * quotaPerUnit：上游的额度换算；
 * flags：{ off（「算应付成本」关着）, platform, keyShared, groupAuto, coveredFromMs（整站日志进度从哪天起）, coveredToMs（读到哪） }
 * 返回 { usd, reason, tokens, byModel, missingPriceModels, segments: [{ startMs, endMs, ratio, usd }], byChannel: [{ channelId, usd }] }
 */
export function expectedCostForDay({ window, buckets = [], channelIds = [], segments = [], pricing = null, pricingError = null, quotaPerUnit = null, flags = {} }) {
  const wanted = new Set((channelIds || []).map(Number));
  const mine = (buckets || []).filter((bucket) => wanted.has(Number(bucket.channelId)) && bucket.slotMs >= window.startMs && bucket.slotMs < window.endMs);
  // 这天真的整段读完（进度起点不晚于这天开始、终点不早于这天结束）才算得出、也才写 tokens；没读全的话半截的桶数不能当真（中-1、中-4）
  const covered = flags.coveredFromMs != null && flags.coveredFromMs <= window.startMs && flags.coveredToMs >= window.endMs;
  const tokens = covered ? mine.reduce((sum, bucket) => sum + num(bucket.promptTokens) + num(bucket.completionTokens) + num(bucket.cacheWriteTokens), 0) : null;
  const none = (reason, extra = {}) => ({ usd: null, reason, tokens, byModel: [], missingPriceModels: [], segments: [], byChannel: [], ...extra });
  if (flags.off) return none("EXPECTED_COST_DISABLED");
  if (flags.platform && flags.platform !== "newapi") return none("UPSTREAM_PRICE_UNSUPPORTED");
  if (!segments.length) return none("NOT_STARTED");
  if (flags.keyShared) return none("KEY_SHARED");
  if (flags.groupAuto || segments.some((segment) => segment.group === "auto")) return none("GROUP_AUTO");
  if (window.startMs % OWN_LOG_SLOT_MS !== 0 || window.endMs % OWN_LOG_SLOT_MS !== 0) return none("DAY_BOUNDARY_UNSUPPORTED");
  // 当天换绑、停止算利润：这一段实际记账的起止不在整点上，小时桶按整点归属，拼不出这一天（总指挥 10-26 定，决定 C）
  const misaligned = (ms) => ms % OWN_LOG_SLOT_MS !== 0;
  if (segments.some((segment) => (segment.startMs > window.startMs && misaligned(segment.startMs)) || (segment.endMs < window.endMs && misaligned(segment.endMs))))
    return none("PARTIAL_HOUR_UNSUPPORTED");
  // 进度还没到这天开始：不是「读得慢」，是这天在整站日志开始读之前，永远补不上，和「还没开始统计」同一类（中-1）
  if (flags.coveredFromMs != null && flags.coveredFromMs > window.startMs) return none("NOT_STARTED");
  if (!(flags.coveredToMs >= window.endMs)) return none("EXPECTED_COST_LAGGING");
  // pricingError 的码不直接透传（低-3，审核 R2 #125）：读价目表失败的原因很多（没开模型广场、网络错、令牌没权限……），
  // 这里只认「上游不是 New API」那一种单独的码（UPSTREAM_PRICE_UNSUPPORTED，走上面 flags.platform 那条，不会到这里），
  // 别的一律归 MODEL_PRICE_UNREADABLE，不把 UPSTREAM_AUTH_DENIED 这类用语规范没有的码写进 gap_reason
  if (!pricing) return none("MODEL_PRICE_UNREADABLE");
  if (mine.some((bucket) => bucket.semantic !== "anthropic" && num(bucket.cacheReadTokens) > num(bucket.promptTokens))) return none("CACHE_FIELDS_UNKNOWN");
  const unit = quotaPerUnit > 0 ? quotaPerUnit : undefined;
  const parts = splitBySegments(mine, segments).map(({ segment, buckets: part }) => ({ segment, buckets: part, result: expectedCostOf(part, pricing, { groupRatio: num(segment.ratio) || 1, ...(unit ? { quotaPerUnit: unit } : {}) }) }));
  const missing = new Map();
  for (const { result } of parts) for (const row of result.missingPriceModels) {
    const key = `${row.model}\u0000${row.upstreamModel}`, acc = missing.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0 };
    acc.requests += row.requests; acc.inputTokens += row.inputTokens; acc.outputTokens += row.outputTokens; missing.set(key, acc);
  }
  // 计价方式这里不支持（tiered_expr）的模型：和「没给价格」分开列，原因码也分开给（中-3）
  const unsupported = new Map();
  for (const { result } of parts) for (const row of result.unsupportedPriceModels || []) {
    const key = `${row.model}\u0000${row.upstreamModel}`, acc = unsupported.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0 };
    acc.requests += row.requests; acc.inputTokens += row.inputTokens; acc.outputTokens += row.outputTokens; unsupported.set(key, acc);
  }
  const byModelMap = new Map();
  for (const { result } of parts) for (const row of result.byModel) {
    const key = `${row.model}\u0000${row.upstreamModel}`, acc = byModelMap.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
    for (const field of ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "usd"]) acc[field] += row[field];
    byModelMap.set(key, acc);
  }
  const segmentRows = parts.map(({ segment, result }) => ({ startMs: segment.startMs, endMs: segment.endMs, ratio: num(segment.ratio) || 1, group: segment.group ?? null, usd: result.usd }));
  const byModel = [...byModelMap.values()].sort((a, b) => b.usd - a.usd), missingPriceModels = [...missing.values()].sort((a, b) => b.requests - a.requests),
    unsupportedPriceModels = [...unsupported.values()].sort((a, b) => b.requests - a.requests);
  if (missingPriceModels.length) return { usd: null, reason: "MODEL_PRICE_MISSING", tokens, byModel, missingPriceModels, segments: segmentRows, byChannel: [] };
  // 按分档计价（tiered_expr）的模型：这里的公式套不上，不硬算——不猜、给原因（码和字交设计定，审核 R2 #125 中-3）
  if (unsupportedPriceModels.length) return { usd: null, reason: "MODEL_PRICE_TIERED_UNSUPPORTED", tokens, byModel, missingPriceModels: unsupportedPriceModels, segments: segmentRows, byChannel: [] };
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
