import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_COST_QUOTA_PER_UNIT, expectedCostOf, priceOf, pricingTableOf } from "./expected-cost.js";

const pricing = pricingTableOf({ success: true, data: [
  { model_name: "gpt", quota_type: 0, model_ratio: 2, completion_ratio: 4, cache_ratio: 0.5, create_cache_ratio: 1.25 },
  { model_name: "claude", quota_type: 0, model_ratio: 3, completion_ratio: 5, cache_ratio: 0.1, create_cache_ratio: 1.25 },
  { model_name: "dalle", quota_type: 1, model_price: 0.04 },
  { model_name: "noratio", quota_type: 0, model_ratio: 1 },
], group_ratio: { default: 1, vip: 0.8 } });
const bucket = (extra = {}) => ({ model: "gpt", upstreamModel: "", group: "default", semantic: "openai", requests: 1, promptTokens: 1000, completionTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra });

test("按量计费：(未缓存输入 + 缓存读×cache_ratio + 缓存写×create_cache_ratio + 输出×completion_ratio) × model_ratio × 分组倍率 ÷ quota_per_unit；openai 口径的 prompt 含缓存读要减掉，anthropic 口径不含", () => {
  // openai：prompt 1000 里 200 是缓存读 → 未缓存 800；缓存读 200×0.5=100；缓存写 0；输出 100×4=400 → 1300 × 2 × 1 / 500000
  const openai = expectedCostOf([bucket({ cacheReadTokens: 200 })], pricing, { groupRatio: 1 });
  assert.equal(openai.usd, 1300 * 2 / EXPECTED_COST_QUOTA_PER_UNIT);
  assert.deepEqual([openai.byModel[0].inputTokens, openai.byModel[0].cacheReadTokens, openai.byModel[0].quotaType], [800, 200, 0]);
  // 计算明细要的单价（每百万 Token 多少美元，倍率以前）和倍率以前的钱：model_ratio 1 = 每百万 $2（quota_per_unit 500000）
  const priced = openai.byModel[0];
  assert.deepEqual([priced.pricesPerMillion, priced.perCallUsd], [{ input: 4, output: 16, cacheRead: 2, cacheWrite: 5 }, null], "gpt：model_ratio 2 → 每百万输入 $4，输出 ×4，缓存读 ×0.5，缓存写 ×1.25");
  assert.equal(priced.beforeRatioUsd, priced.usd, "倍率 1：倍率以前的钱就是 usd");
  const vip = expectedCostOf([bucket({ cacheReadTokens: 200 })], pricing, { groupRatio: 0.8 });
  assert.ok(Math.abs(vip.byModel[0].beforeRatioUsd - openai.usd) < 1e-12 && Math.abs(vip.usd - openai.usd * 0.8) < 1e-12, "倍率 0.8：usd 打八折，beforeRatioUsd 不变");
  // anthropic：prompt 1000 不含缓存；缓存读 200×0.1=20；缓存写 50×1.25=62.5；输出 100×5=500 → 1582.5 × 3 × 0.8（vip）
  const claude = expectedCostOf([bucket({ model: "claude", semantic: "anthropic", cacheReadTokens: 200, cacheWriteTokens: 50 })], pricing, { groupRatio: 0.8 });
  assert.equal(claude.usd, 1582.5 * 3 * 0.8 / EXPECTED_COST_QUOTA_PER_UNIT);
  assert.equal(claude.byModel[0].inputTokens, 1000);
});

test("按次计费：请求数 × model_price × 分组倍率；做过模型映射按上游模型名找价格；没有 cache_ratio 之类的按 1", () => {
  const perCall = expectedCostOf([bucket({ model: "dalle-local", upstreamModel: "dalle", requests: 3 })], pricing, { groupRatio: 0.5 });
  assert.equal(perCall.usd, 3 * 0.04 * 0.5);
  assert.deepEqual([perCall.byModel[0].model, perCall.byModel[0].upstreamModel, perCall.byModel[0].quotaType, perCall.byModel[0].pricesPerMillion], ["dalle-local", "dalle", 1, null]);
  assert.ok(perCall.byModel[0].perCallUsd > 0);
  // 缺的 cache_ratio 按 1；缺的 create_cache_ratio 按 New API 默认 1.25（不是 1，审核 R2 #125 中-3）；
  // openai 未缓存输入要把缓存写也减掉：1000 − 100（缓存读）− 10（缓存写）= 890
  const plain = expectedCostOf([bucket({ model: "noratio", cacheReadTokens: 100, cacheWriteTokens: 10 })], pricing);
  assert.equal(plain.usd, (890 + 100 * 1 + 10 * 1.25 + 100) * 1 / EXPECTED_COST_QUOTA_PER_UNIT, "cache_ratio 缺的按 1，create_cache_ratio 缺的按 1.25");
});

test("有模型上游没给价格：整段算不出（usd 是 null），没算进的模型列出来；同一模型几个桶合成一行", () => {
  const result = expectedCostOf([bucket(), bucket({ completionTokens: 50 }), bucket({ model: "o3-pro", requests: 2 }), bucket({ model: "o3-pro" })], pricing);
  assert.equal(result.usd, null);
  assert.deepEqual(result.missingPriceModels, [{ model: "o3-pro", upstreamModel: "", requests: 3, inputTokens: 2000, outputTokens: 200 }]);
  assert.deepEqual([result.byModel.length, result.byModel[0].requests, result.byModel[0].outputTokens], [1, 2, 150]);
  assert.deepEqual(expectedCostOf([], pricing), { usd: 0, byModel: [], missingPriceModels: [], tieredPriceModels: [] });
});

// 审核 R2 #125 中-3：和 New API 源码对齐缓存写的口径（openai 缓存写算两遍、create_cache_ratio 默认值、anthropic 1 小时缓存写、
// tiered_expr 不硬算），两个例子按审核给的数固定成金额断言
test("openai 缓存写不再算两遍：prompt_tokens 要同时减掉缓存读和缓存写才是未缓存输入（New API service/text_quota.go）", () => {
  // prompt 100 万（已经含缓存写 40 万），model_ratio 1、create_cache_ratio 没配（按默认 1.25）、cache_ratio 没配（按默认 1）、
  // quota_per_unit 50 万：未缓存输入 = 100万 − 0（缓存读）− 40万（缓存写）= 60 万；缓存写项 40万×1.25=50万
  // → (60万 + 50万) × 1 / 50万 = $2.2（改之前：未缓存输入按 100 万算，缓存写被当输入又算了一遍，得 $2.8，缓存写算了两遍）
  const pricing = pricingTableOf({ data: [{ model_name: "m", quota_type: 0, model_ratio: 1 }], group_ratio: {} });
  const bucket = { model: "m", upstreamModel: "", group: "g", semantic: "openai", requests: 1, promptTokens: 1000000, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 400000 };
  const result = expectedCostOf([bucket], pricing, { groupRatio: 1, quotaPerUnit: 500000 });
  assert.equal(result.usd, 2.2);
  // 改坏检验（审核原例）：未缓存输入只减缓存读、不减缓存写，create_cache_ratio 缺省按旧的 1（不是 1.25），会多算成 $2.8
  const broken = Math.max(0, bucket.promptTokens - bucket.cacheReadTokens);
  assert.equal((broken + bucket.cacheWriteTokens * 1) * 1 / 500000, 2.8, "只减缓存读、create_cache_ratio 缺省按旧的 1：把缓存写算两遍，多算成 $2.8");
});

test("anthropic 1 小时缓存写按 createCacheRatio × 6/3.75 收（New API helper/price.go），不能当普通缓存写、更不能不算", () => {
  // 100 万全是 1 小时缓存写：cacheWriteTokens 是合计（这里全是 1 小时，合计也是 100 万），cacheWrite1hTokens 是合计里面的 1 小时部分；
  // create_cache_ratio 默认 1.25 → 100万 × 1.25 × 6/3.75 = 100万 × 2 / 50万 = $4
  const pricing = pricingTableOf({ data: [{ model_name: "claude", quota_type: 0, model_ratio: 1 }], group_ratio: {} });
  const bucket = { model: "claude", upstreamModel: "", group: "g", semantic: "anthropic", requests: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1000000, cacheWrite1hTokens: 1000000 };
  const result = expectedCostOf([bucket], pricing, { groupRatio: 1, quotaPerUnit: 500000 });
  assert.equal(result.usd, 4);
  // 改坏检验：cacheWrite1hTokens 不用 6/3.75 这个倍率（当普通缓存写收）只有 100万×1.25/50万=2.5，不是 $4；完全不算是 $0
  assert.equal((1000000 * 1.25) / 500000, 2.5, "当普通缓存写收会少算成 $2.5");
});

// 审核第二轮 中-A：cacheWriteTokens 是缓存写的合计（New API 日志 cache_creation_tokens），cacheWrite1hTokens 是合计里面 1 小时那一部分，
// 不是另一个独立的数——6e29b69 当成两个独立的数算，1 小时那部分多收了一遍
test("缓存写合计里既有 5 分钟又有 1 小时：1 小时那部分不能从合计里再多算一遍", () => {
  // 合计 30 万（5 分钟 10 万 + 1 小时 20 万）；create_cache_ratio 默认 1.25
  // → 10万×1.25 + 20万×1.25×6/3.75 = 12.5万 + 40万 = 52.5万 → /50万 = $1.05
  const pricing = pricingTableOf({ data: [{ model_name: "claude", quota_type: 0, model_ratio: 1 }], group_ratio: {} });
  const bucket = { model: "claude", upstreamModel: "", group: "g", semantic: "anthropic", requests: 1, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 300000, cacheWrite1hTokens: 200000 };
  const result = expectedCostOf([bucket], pricing, { groupRatio: 1, quotaPerUnit: 500000 });
  assert.equal(result.usd, 1.05);
  // 改坏检验：把合计（30 万）当成 5 分钟那部分，不扣掉已经算在合计里的 1 小时部分，会把 1 小时那 20 万多收一遍，算成 $1.55
  assert.equal((300000 * 1.25 + 200000 * 1.25 * (6 / 3.75)) / 500000, 1.55, "1 小时多算一遍会多算成 $1.55");
});

test("按分档计价（billing_mode: tiered_expr）的模型：这里的公式套不上，不硬算，归进 tieredPriceModels（审核 R2 #125 中-3）", () => {
  const pricing = pricingTableOf({ data: [{ model_name: "tiered", quota_type: 0, model_ratio: 1, billing_mode: "tiered_expr" }], group_ratio: {} });
  const bucket = { model: "tiered", upstreamModel: "", group: "g", semantic: "openai", requests: 1, promptTokens: 1000, completionTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const result = expectedCostOf([bucket], pricing);
  assert.equal(result.usd, null);
  assert.deepEqual(result.missingPriceModels, []);
  assert.deepEqual(result.tieredPriceModels, [{ model: "tiered", upstreamModel: "", requests: 1, inputTokens: 1000, outputTokens: 100 }]);
  assert.equal(priceOf(pricing, "tiered").unsupported, true);
});

test("priceOf / pricingTableOf：按模型名查；group_ratio 进 Map；坏的返回体当空表", () => {
  assert.deepEqual(priceOf(pricing, "gpt"), { quotaType: 0, modelRatio: 2, modelPrice: 0, completionRatio: 4, cacheRatio: 0.5, createCacheRatio: 1.25 });
  assert.equal(priceOf(pricing, "nope"), null);
  assert.equal(pricing.groupRatio.get("vip"), 0.8);
  assert.deepEqual([pricingTableOf(null).models.size, pricingTableOf({ data: "x" }).groupRatio.size], [0, 0]);
});
