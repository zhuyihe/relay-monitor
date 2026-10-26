// 应付成本（V1-a 纯函数，公式照 expected-cost-memo.md 第 2 节）：按桶（lib/own-log-bucket.js）和上游价目表算「上游应该收多少」。
//   按量计费：(未缓存输入 + 缓存读 × cache_ratio + 缓存写 × create_cache_ratio + 输出 × completion_ratio) × model_ratio × 上游分组倍率 ÷ quota_per_unit
//   按次计费：请求数 × model_price × 上游分组倍率
// 做过模型映射的按上游模型名找价格；openai 口径的 prompt_tokens 含缓存读，要先减掉；anthropic 口径的不含。
// 哪个模型上游没给价格的，整段算不出（missingPriceModels 列出来），不拿一半的数当应付成本。不引 node: 模块。
export const EXPECTED_COST_QUOTA_PER_UNIT = 500000;

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const finite = (value) => value != null && Number.isFinite(Number(value));

/** 上游 /api/pricing 的一项 → 这里用的价格：{ quotaType 0 按量 / 1 按次, modelRatio, modelPrice, completionRatio, cacheRatio, createCacheRatio } */
export function priceOf(pricing, model) {
  const item = pricing?.models?.get?.(model) ?? pricing?.models?.[model] ?? null;
  if (!item) return null;
  return { quotaType: Number(item.quota_type ?? item.quotaType ?? 0), modelRatio: num(item.model_ratio ?? item.modelRatio), modelPrice: num(item.model_price ?? item.modelPrice),
    completionRatio: finite(item.completion_ratio ?? item.completionRatio) ? Number(item.completion_ratio ?? item.completionRatio) : 1,
    cacheRatio: finite(item.cache_ratio ?? item.cacheRatio) ? Number(item.cache_ratio ?? item.cacheRatio) : 1,
    createCacheRatio: finite(item.create_cache_ratio ?? item.createCacheRatio) ? Number(item.create_cache_ratio ?? item.createCacheRatio) : 1 };
}

/**
 * buckets：一天（或一段）的桶；pricing：{ models: Map(模型 → 价目项), groupRatio: Map(分组 → 倍率) }；
 * groupRatio：这段用的上游分组倍率（段里记的，优先于价目表里的）；quotaPerUnit：上游的额度换算。
 * 返回 { usd, byModel: [{ model, upstreamModel, requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, quotaType, usd }], missingPriceModels: [{ model, requests, inputTokens, outputTokens }] }
 * usd 在有模型没价格时是 null。
 */
export function expectedCostOf(buckets, pricing, { groupRatio = 1, quotaPerUnit = EXPECTED_COST_QUOTA_PER_UNIT } = {}) {
  const byModel = new Map(), missing = new Map();
  for (const bucket of buckets || []) {
    const model = bucket.upstreamModel || bucket.model;
    const inputTokens = Math.max(0, bucket.semantic === "anthropic" ? num(bucket.promptTokens) : num(bucket.promptTokens) - num(bucket.cacheReadTokens));
    const price = priceOf(pricing, model);
    const key = `${bucket.model}\u0000${model}`;
    if (!price) {
      const row = missing.get(key) || { model: bucket.model, upstreamModel: model === bucket.model ? "" : model, requests: 0, inputTokens: 0, outputTokens: 0 };
      row.requests += num(bucket.requests); row.inputTokens += inputTokens; row.outputTokens += num(bucket.completionTokens);
      missing.set(key, row);
      continue;
    }
    const row = byModel.get(key) || { model: bucket.model, upstreamModel: model === bucket.model ? "" : model, quotaType: price.quotaType, requests: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
    const cacheRead = num(bucket.cacheReadTokens), cacheWrite = num(bucket.cacheWriteTokens), output = num(bucket.completionTokens), requests = num(bucket.requests);
    const usd = price.quotaType === 1
      ? requests * price.modelPrice * groupRatio
      : (inputTokens + cacheRead * price.cacheRatio + cacheWrite * price.createCacheRatio + output * price.completionRatio) * price.modelRatio * groupRatio / quotaPerUnit;
    row.requests += requests; row.inputTokens += inputTokens; row.outputTokens += output; row.cacheReadTokens += cacheRead; row.cacheWriteTokens += cacheWrite; row.usd += usd;
    byModel.set(key, row);
  }
  const rows = [...byModel.values()].sort((a, b) => b.usd - a.usd), missingRows = [...missing.values()].sort((a, b) => b.requests - a.requests);
  return { usd: missingRows.length ? null : rows.reduce((sum, row) => sum + row.usd, 0), byModel: rows, missingPriceModels: missingRows };
}

// 上游 /api/pricing 的返回（data 是数组、group_ratio 是对象）→ 查价用的形状
export function pricingTableOf(body) {
  const models = new Map();
  for (const item of Array.isArray(body?.data) ? body.data : []) if (item?.model_name) models.set(String(item.model_name), item);
  const groupRatio = new Map(Object.entries(body?.group_ratio && typeof body.group_ratio === "object" ? body.group_ratio : {}).map(([group, ratio]) => [group, num(ratio)]));
  return { models, groupRatio, readAt: Date.now() };
}
