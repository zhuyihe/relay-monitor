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
  const plain = expectedCostOf([bucket({ model: "noratio", cacheReadTokens: 100, cacheWriteTokens: 10 })], pricing);
  assert.equal(plain.usd, (900 + 100 + 10 + 100) * 1 / EXPECTED_COST_QUOTA_PER_UNIT, "缺的倍率按 1");
});

test("有模型上游没给价格：整段算不出（usd 是 null），没算进的模型列出来；同一模型几个桶合成一行", () => {
  const result = expectedCostOf([bucket(), bucket({ completionTokens: 50 }), bucket({ model: "o3-pro", requests: 2 }), bucket({ model: "o3-pro" })], pricing);
  assert.equal(result.usd, null);
  assert.deepEqual(result.missingPriceModels, [{ model: "o3-pro", upstreamModel: "", requests: 3, inputTokens: 2000, outputTokens: 200 }]);
  assert.deepEqual([result.byModel.length, result.byModel[0].requests, result.byModel[0].outputTokens], [1, 2, 150]);
  assert.deepEqual(expectedCostOf([], pricing), { usd: 0, byModel: [], missingPriceModels: [] });
});

test("priceOf / pricingTableOf：按模型名查；group_ratio 进 Map；坏的返回体当空表", () => {
  assert.deepEqual(priceOf(pricing, "gpt"), { quotaType: 0, modelRatio: 2, modelPrice: 0, completionRatio: 4, cacheRatio: 0.5, createCacheRatio: 1.25 });
  assert.equal(priceOf(pricing, "nope"), null);
  assert.equal(pricing.groupRatio.get("vip"), 0.8);
  assert.deepEqual([pricingTableOf(null).models.size, pricingTableOf({ data: "x" }).groupRatio.size], [0, 0]);
});
