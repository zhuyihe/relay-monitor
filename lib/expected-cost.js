// 应付成本（V1-a 纯函数，公式照 expected-cost-memo.md 第 2 节，缓存那几项按 New API 源码对齐，审核 R2 #125 中-3、第二轮 中-A）：
// 按桶（lib/own-log-bucket.js）和上游价目表算「上游应该收多少」。
//   按量计费：(未缓存输入 + 缓存读 × cache_ratio + 普通缓存写 × create_cache_ratio + 1 小时缓存写 × create_cache_ratio × 6/3.75
//             + 输出 × completion_ratio) × model_ratio × 上游分组倍率 ÷ quota_per_unit
//   按次计费：请求数 × model_price × 上游分组倍率
// 做过模型映射的按上游模型名找价格；openai 口径的 prompt_tokens 同时含缓存读和缓存写，要先都减掉再当「未缓存输入」
// （New API service/text_quota.go 的配额计算：prompt_tokens 减 cache_tokens 和 cache_creation_tokens 两项才是未缓存输入）；
// anthropic 口径的 prompt_tokens 本来就不含缓存读写，不用减。
// 缓存写的两个字段：cacheWriteTokens 是缓存写的**合计**（New API 日志里的 cache_creation_tokens，5 分钟 + 1 小时都在里面），
// cacheWrite1hTokens 是合计里面 1 小时那一部分，不是另一个独立的数（own-log-bucket.js 的累计口径、New API claude 适配器和
// text_quota.go 都这么写）——审核第二轮中-A：之前当成两个独立的数，1 小时那部分多收了一遍。
// create_cache_ratio 没配置时按 New API 默认值 1.25（不是 1）：GetCreateCacheRatio 没找到单独配置时回落到这个全局默认。
// anthropic 1 小时缓存写：New API 按 createCacheRatio × 6/3.75 收（1 小时缓存比 5 分钟缓存贵，helper/price.go 的写法）。
// openai 口径的日志极少见地带了 1 小时缓存写（New API legacyClaudeDerived，不是走 claude 适配器转出来的用量）：这时按 anthropic
// 的算法，prompt_tokens 不减缓存（减了就把这部分缓存多减一次）。
// billing_mode 是 tiered_expr（按用量分档计价）的模型，公式套不上 model_ratio 这条直线，不按普通公式硬算——当成「这个模型上游没按
// 这种算法给价格」，归进 tieredPriceModels（和 missingPriceModels 分开列，原因码在 expected-cost-day.js 单独给）。
// 哪个模型上游没给价格、或者是不支持的计价方式的，整段算不出，不拿一半的数当应付成本。不引 node: 模块。
export const EXPECTED_COST_QUOTA_PER_UNIT = 500000;
// Claude 1 小时缓存写比 5 分钟缓存写贵这么多倍（New API helper/price.go：1 小时缓存写价格 = 普通缓存写价格 × 6/3.75）
export const CACHE_WRITE_1H_MULTIPLIER = 6 / 3.75;
// create_cache_ratio 没单独配置时 New API 的默认值（GetCreateCacheRatio 的全局默认，不是 1）
const DEFAULT_CREATE_CACHE_RATIO = 1.25;

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const finite = (value) => value != null && Number.isFinite(Number(value));

/** 上游 /api/pricing 的一项 → 这里用的价格：{ quotaType 0 按量 / 1 按次, modelRatio, modelPrice, completionRatio, cacheRatio, createCacheRatio }；
 * billing_mode 是 tiered_expr（套不上这条公式）时返回 { unsupported: true }，调用方按「这个模型的计价方式这里不支持」处理，不当真算 */
export function priceOf(pricing, model) {
  const item = pricing?.models?.get?.(model) ?? pricing?.models?.[model] ?? null;
  if (!item) return null;
  if ((item.billing_mode ?? item.billingMode) === "tiered_expr") return { unsupported: true };
  return { quotaType: Number(item.quota_type ?? item.quotaType ?? 0), modelRatio: num(item.model_ratio ?? item.modelRatio), modelPrice: num(item.model_price ?? item.modelPrice),
    completionRatio: finite(item.completion_ratio ?? item.completionRatio) ? Number(item.completion_ratio ?? item.completionRatio) : 1,
    cacheRatio: finite(item.cache_ratio ?? item.cacheRatio) ? Number(item.cache_ratio ?? item.cacheRatio) : 1,
    createCacheRatio: finite(item.create_cache_ratio ?? item.createCacheRatio) ? Number(item.create_cache_ratio ?? item.createCacheRatio) : DEFAULT_CREATE_CACHE_RATIO };
}

/**
 * buckets：一天（或一段）的桶；pricing：{ models: Map(模型 → 价目项), groupRatio: Map(分组 → 倍率) }；
 * groupRatio：这段用的上游分组倍率（段里记的，优先于价目表里的）；quotaPerUnit：上游的额度换算。
 * 返回 { usd, byModel: [{ model, upstreamModel, requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, quotaType, usd, beforeRatioUsd,
 *   pricesPerMillion: { input, output, cacheRead, cacheWrite }（按量：每百万 Token 多少美元，倍率以前；按次：null）, perCallUsd（按次：每次多少美元；按量：null） }],
 *   missingPriceModels: [{ model, requests, inputTokens, outputTokens }], tieredPriceModels: [{ model, requests, inputTokens, outputTokens }] }
 * usd 在有模型没价格、或者有模型计价方式不支持（tiered_expr）时是 null。cacheWriteTokens 显示用的是普通缓存写 + 1 小时缓存写的合计
 * （两项分开定价，合计只是给人看一共写了多少缓存）。pricesPerMillion、beforeRatioUsd 给每日利润的计算明细（#118 §9.3）；
 * 一次结账的明细随账本固定，所以在这里算好存起来。
 */
export function expectedCostOf(buckets, pricing, { groupRatio = 1, quotaPerUnit = EXPECTED_COST_QUOTA_PER_UNIT } = {}) {
  const byModel = new Map(), missing = new Map(), unsupported = new Map();
  for (const bucket of buckets || []) {
    const model = bucket.upstreamModel || bucket.model;
    // cacheWriteTokens 是合计，cacheWrite1h 是合计里面 1 小时那一部分（不是另一个独立的数，见上面的注释）
    const cacheWriteTotal = num(bucket.cacheWriteTokens), cacheWrite1h = Math.min(num(bucket.cacheWrite1hTokens), cacheWriteTotal), cacheWrite5m = cacheWriteTotal - cacheWrite1h;
    // openai 口径：prompt_tokens 里同时含缓存读和缓存写（合计，已经含 1 小时那部分，不再多减一次），要都减掉才是「未缓存输入」
    // （New API text_quota.go）；openai 口径但带了 1 小时缓存写（少见）按 anthropic 算，prompt_tokens 不减（中-A）
    const isAnthropicLike = bucket.semantic === "anthropic" || cacheWrite1h > 0;
    const inputTokens = isAnthropicLike ? num(bucket.promptTokens) : Math.max(0, num(bucket.promptTokens) - num(bucket.cacheReadTokens) - cacheWriteTotal);
    const price = priceOf(pricing, model);
    const key = `${bucket.model}\u0000${model}`;
    if (!price) {
      const row = missing.get(key) || { model: bucket.model, upstreamModel: model === bucket.model ? "" : model, requests: 0, inputTokens: 0, outputTokens: 0 };
      row.requests += num(bucket.requests); row.inputTokens += inputTokens; row.outputTokens += num(bucket.completionTokens);
      missing.set(key, row);
      continue;
    }
    if (price.unsupported) {
      const row = unsupported.get(key) || { model: bucket.model, upstreamModel: model === bucket.model ? "" : model, requests: 0, inputTokens: 0, outputTokens: 0 };
      row.requests += num(bucket.requests); row.inputTokens += inputTokens; row.outputTokens += num(bucket.completionTokens);
      unsupported.set(key, row);
      continue;
    }
    const perMillion = price.quotaType === 1 ? null : price.modelRatio * 1e6 / quotaPerUnit;
    const row = byModel.get(key) || { model: bucket.model, upstreamModel: model === bucket.model ? "" : model, quotaType: price.quotaType, requests: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, beforeRatioUsd: 0,
      pricesPerMillion: perMillion == null ? null : { input: perMillion, output: perMillion * price.completionRatio, cacheRead: perMillion * price.cacheRatio, cacheWrite: perMillion * price.createCacheRatio },
      perCallUsd: price.quotaType === 1 ? price.modelPrice : null };
    const cacheRead = num(bucket.cacheReadTokens), output = num(bucket.completionTokens), requests = num(bucket.requests);
    const usd = price.quotaType === 1
      ? requests * price.modelPrice * groupRatio
      : (inputTokens + cacheRead * price.cacheRatio + cacheWrite5m * price.createCacheRatio + cacheWrite1h * price.createCacheRatio * CACHE_WRITE_1H_MULTIPLIER + output * price.completionRatio)
        * price.modelRatio * groupRatio / quotaPerUnit;
    row.requests += requests; row.inputTokens += inputTokens; row.outputTokens += output; row.cacheReadTokens += cacheRead; row.cacheWriteTokens += cacheWriteTotal; row.usd += usd;
    row.beforeRatioUsd += groupRatio ? usd / groupRatio : usd;
    byModel.set(key, row);
  }
  const rows = [...byModel.values()].sort((a, b) => b.usd - a.usd), missingRows = [...missing.values()].sort((a, b) => b.requests - a.requests),
    unsupportedRows = [...unsupported.values()].sort((a, b) => b.requests - a.requests);
  return { usd: missingRows.length || unsupportedRows.length ? null : rows.reduce((sum, row) => sum + row.usd, 0), byModel: rows, missingPriceModels: missingRows, tieredPriceModels: unsupportedRows };
}

// 上游 /api/pricing 的返回（data 是数组、group_ratio 是对象）→ 查价用的形状
export function pricingTableOf(body) {
  const models = new Map();
  for (const item of Array.isArray(body?.data) ? body.data : []) if (item?.model_name) models.set(String(item.model_name), item);
  const groupRatio = new Map(Object.entries(body?.group_ratio && typeof body.group_ratio === "object" ? body.group_ratio : {}).map(([group, ratio]) => [group, num(ratio)]));
  return { models, groupRatio, readAt: Date.now() };
}
