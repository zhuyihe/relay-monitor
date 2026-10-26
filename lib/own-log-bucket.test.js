import test from "node:test";
import assert from "node:assert/strict";
import { OWN_LOG_SLOT_MS, accumulateBuckets, bucketKeyOf } from "./own-log-bucket.js";

const base = Date.parse("2026-10-09T03:00:00Z") / 1000;
const row = (extra = {}) => ({ type: 2, created_at: base + 10, channel: 1, model_name: "m1", group: "g", username: "alice", token_name: "k", token_id: 5, quota: 100, prompt_tokens: 10, completion_tokens: 5, other: "{}", ...extra });

test("同一小时、渠道、模型、分组、缓存口径的行进一个桶，各数加起来；不同的分开", () => {
  const buckets = accumulateBuckets([row(), row({ quota: 50, prompt_tokens: 4 }), row({ model_name: "m2" }), row({ created_at: base + 3700 }), row({ channel: 2 })]);
  assert.equal(buckets.size, 4);
  const first = [...buckets.values()].find((b) => b.model === "m1" && b.channelId === 1 && b.slotMs === Math.floor(base * 1000 / OWN_LOG_SLOT_MS) * OWN_LOG_SLOT_MS);
  assert.deepEqual([first.requests, first.quota, first.promptTokens, first.completionTokens], [2, 150, 14, 10]);
});

test("缓存字段和上游模型名从 other 里取；usage_semantic 分口径；不是消费日志（type≠2）、没有渠道的不进", () => {
  const other = JSON.stringify({ cache_tokens: 7, cache_creation_tokens: 3, cache_creation_tokens_1h: 1, usage_semantic: "anthropic", is_model_mapped: true, upstream_model_name: "real-m" });
  const [bucket] = [...accumulateBuckets([row({ other }), row({ type: 5 }), row({ channel: 0 }), row({ created_at: 0 })]).values()];
  assert.deepEqual([bucket.cacheReadTokens, bucket.cacheWriteTokens, bucket.cacheWrite1hTokens, bucket.semantic, bucket.upstreamModel, bucket.requests], [7, 3, 1, "anthropic", "real-m", 1]);
  assert.equal(accumulateBuckets([row({ other: "不是 JSON" })]).size, 1, "other 坏了当没有");
});

test("管理员自用额度、不在管理员名下的渠道测试额度，和 R1 同一个规矩：转售的管理员 Key 不算管理员自用，管理员名下的测试不算两次，名字不分大小写", () => {
  const adminSet = new Set(["root"]), resoldKeys = [{ username: "Root", tokenName: "SALE" }];
  const [bucket] = [...accumulateBuckets([
    row({ username: "root", quota: 30, token_name: "own" }),
    row({ username: "root", quota: 100, token_name: "sale" }),
    row({ username: "root", quota: 7, token_name: "模型测试", token_id: 0 }),
    row({ username: "alice", quota: 5, token_name: "模型测试", token_id: 0 }),
    row({ username: "alice", quota: 9, token_name: "模型测试", token_id: 3 }),
  ], { adminSet, resoldKeys }).values()];
  assert.deepEqual([bucket.quota, bucket.adminQuota, bucket.testQuota], [151, 37, 5], "管理员自用 30+7，转售 100 不算；测试只算 alice 那条 token_id 为 0 的 5");
});

test("bucketKeyOf 对同一个桶稳定", () => {
  const a = { slotMs: 1, channelId: 2, model: "m", upstreamModel: "", group: "g", semantic: "openai" };
  assert.equal(bucketKeyOf(a), bucketKeyOf({ ...a }));
});
