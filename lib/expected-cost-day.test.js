import test from "node:test";
import assert from "node:assert/strict";
import { GAP_THRESHOLD, expectedCostForDay, gapOf } from "./expected-cost-day.js";
import { pricingTableOf } from "./expected-cost.js";
import { OWN_LOG_SLOT_MS } from "./own-log-bucket.js";

const DAY = Date.parse("2026-10-07T16:00:00Z"); // 上海 10-08 0 点
const window = { startMs: DAY, endMs: DAY + 86400000, timezone: "Asia/Shanghai" };
const pricing = pricingTableOf({ data: [{ model_name: "gpt", quota_type: 0, model_ratio: 2, completion_ratio: 1 }, { model_name: "img", quota_type: 1, model_price: 0.1 }], group_ratio: {} });
const bucket = (hour, extra = {}) => ({ slotMs: DAY + hour * OWN_LOG_SLOT_MS, channelId: 1, model: "gpt", upstreamModel: "", group: "g", semantic: "anthropic", requests: 1, promptTokens: 500000, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra });
const base = { window, channelIds: [1], segments: [{ startMs: DAY, endMs: DAY + 86400000, ratio: 1, group: "g" }], pricing, quotaPerUnit: 500000, flags: { platform: "newapi", coveredFromMs: DAY, coveredToMs: DAY + 86400000 } };

test("一天的应付成本：按渠道筛桶、按倍率分段各算再加；Token 合计；渠道级应付；别的渠道、别的天的桶不算", () => {
  const result = expectedCostForDay({ ...base, segments: [{ startMs: DAY, endMs: DAY + 12 * OWN_LOG_SLOT_MS, ratio: 1 }, { startMs: DAY + 12 * OWN_LOG_SLOT_MS, endMs: DAY + 86400000, ratio: 0.5 }],
    channelIds: [1, 2], buckets: [bucket(1), bucket(13), bucket(13, { channelId: 2 }), bucket(2, { channelId: 9 }), bucket(30)] });
  // 每桶 500000 token × model_ratio 2 ÷ 500000 = 2 美元 × 倍率：第一段 1 桶 ×1 = 2；第二段 2 桶 ×0.5 = 2
  assert.equal(result.usd, 4);
  assert.equal(result.reason, null);
  assert.deepEqual(result.segments.map((s) => s.usd), [2, 2]);
  assert.deepEqual(result.byChannel, [{ channelId: 1, usd: 3 }, { channelId: 2, usd: 1 }]);
  assert.equal(result.tokens, 1500000);
  assert.deepEqual([result.byModel.length, result.byModel[0].requests], [1, 3]);
});

test("算不出的原因，按先后一个：开关关着、不是 New API、没分段、Key 别处也用、auto 分组、天界线不是整点、整站日志没读完、价目表读不到、模型缺价格、缓存字段对不上", () => {
  const at = (overrides) => expectedCostForDay({ ...base, buckets: [bucket(1)], ...overrides }).reason;
  assert.equal(at({ flags: { ...base.flags, off: true, platform: "sub2api" } }), "EXPECTED_COST_DISABLED", "关着排最前");
  assert.equal(at({ flags: { ...base.flags, platform: "sub2api" } }), "UPSTREAM_PRICE_UNSUPPORTED");
  assert.equal(at({ segments: [] }), "NOT_STARTED");
  assert.equal(at({ flags: { ...base.flags, keyShared: true } }), "KEY_SHARED");
  assert.equal(at({ segments: [{ ...base.segments[0], group: "auto" }] }), "GROUP_AUTO");
  assert.equal(at({ window: { startMs: DAY + 1800000, endMs: DAY + 1800000 + 86400000, timezone: "Asia/Kolkata" } }), "DAY_BOUNDARY_UNSUPPORTED");
  // 当天换绑：段起点 14:23 不在整点上（总指挥 10-26 定，决定 C）
  assert.equal(at({ segments: [{ startMs: DAY + 14.3833 * OWN_LOG_SLOT_MS, endMs: DAY + 86400000, ratio: 1 }] }), "PARTIAL_HOUR_UNSUPPORTED", "起点不在整点");
  // 停止算利润：段终点 14:23 不在整点上
  assert.equal(at({ segments: [{ startMs: DAY, endMs: DAY + 14.3833 * OWN_LOG_SLOT_MS, ratio: 1 }] }), "PARTIAL_HOUR_UNSUPPORTED", "终点不在整点");
  // 段起止正好等于这天的起止（没有换绑、解除）：不算半点
  assert.equal(at({ segments: [{ startMs: DAY, endMs: DAY + 86400000, ratio: 1 }] }), null, "整天一段，不是半点");
  // 进度起点晚于这天开始（审核 R2 #125 中-1）：不是读得慢，是还没开始读，和「还没开始统计」同一类
  assert.equal(at({ flags: { ...base.flags, coveredFromMs: DAY + 1 } }), "NOT_STARTED", "进度起点比这天晚：永远补不上");
  assert.equal(at({ flags: { ...base.flags, coveredToMs: DAY + 86400000 - 1 } }), "EXPECTED_COST_LAGGING");
  assert.equal(at({ pricing: null, pricingError: { code: "MODEL_PRICE_UNREADABLE" } }), "MODEL_PRICE_UNREADABLE");
  assert.equal(at({ pricing: null, pricingError: { code: "UPSTREAM_REQUEST_FAILED" } }), "MODEL_PRICE_UNREADABLE", "网络错也归成读不到");
  const missing = expectedCostForDay({ ...base, buckets: [bucket(1), bucket(2, { model: "o3" })] });
  assert.deepEqual([missing.reason, missing.usd, missing.missingPriceModels[0].model, missing.byModel.length], ["MODEL_PRICE_MISSING", null, "o3", 1]);
  // 按分档计价（billing_mode: tiered_expr）的模型：公式套不上，不猜（审核 R2 #125 中-3）
  const tieredPricing = pricingTableOf({ data: [{ model_name: "gpt", quota_type: 0, model_ratio: 2, completion_ratio: 1, billing_mode: "tiered_expr" }], group_ratio: {} });
  const tiered = expectedCostForDay({ ...base, pricing: tieredPricing, buckets: [bucket(1)] });
  assert.deepEqual([tiered.reason, tiered.usd, tiered.missingPriceModels[0].model], ["MODEL_PRICE_TIERED_UNSUPPORTED", null, "gpt"]);
  assert.equal(at({ buckets: [bucket(1, { semantic: "openai", promptTokens: 10, cacheReadTokens: 50 })] }), "CACHE_FIELDS_UNKNOWN");
  assert.equal(expectedCostForDay({ ...base, buckets: [] }).usd, 0, "这天没用量：应付 0");
});

test("tokens 只有这天真的整段读完才写，算不出、读不全时是 null（审核 R2 #125 中-4）", () => {
  // LAGGING（进度没到这天结束）：不写 tokens
  const lagging = expectedCostForDay({ ...base, buckets: [bucket(1)], flags: { ...base.flags, coveredToMs: DAY + 86400000 - 1 } });
  assert.deepEqual([lagging.reason, lagging.tokens], ["EXPECTED_COST_LAGGING", null]);
  // 进度起点比这天晚（NOT_STARTED）：也不写
  const notStarted = expectedCostForDay({ ...base, buckets: [bucket(1)], flags: { ...base.flags, coveredFromMs: DAY + 1 } });
  assert.deepEqual([notStarted.reason, notStarted.tokens], ["NOT_STARTED", null]);
  // Sub2API（UPSTREAM_PRICE_UNSUPPORTED）：这天本身整站日志读全了，tokens 照写（和应付成本算不算得出是两回事）
  const sub2api = expectedCostForDay({ ...base, buckets: [bucket(1)], flags: { ...base.flags, platform: "sub2api" } });
  assert.deepEqual([sub2api.reason, sub2api.tokens], ["UPSTREAM_PRICE_UNSUPPORTED", 500000]);
  // 正常算出来：tokens 照写
  assert.equal(expectedCostForDay({ ...base, buckets: [bucket(1)] }).tokens, 500000);
});

test("差额读的时候现算：实付 − 应付；同时超过 $0.05 和 2% 才「对不上」；任一边没有是 null", () => {
  assert.deepEqual(GAP_THRESHOLD, { usd: 0.05, rate: 0.02 });
  const over = gapOf(9.2, 8);
  assert.deepEqual([over.usd.toFixed(6), over.rate.toFixed(6), over.state], ["1.200000", "0.150000", "over"]);
  assert.deepEqual(gapOf(7.5, 8), { usd: -0.5, rate: -0.0625, state: "under" });
  assert.equal(gapOf(8.04, 8).state, "within", "只超过 $0.05 不超过 2%");
  assert.equal(gapOf(1.03, 1).state, "within", "差 $0.03：不超过 $0.05");
  assert.equal(gapOf(0.1, 0).state, "over", "应付 0 实付不是 0：只看 $0.05");
  assert.equal(gapOf(null, 8), null);
  assert.equal(gapOf(8, undefined), null);
});
