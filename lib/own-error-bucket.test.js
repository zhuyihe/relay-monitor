import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_REASONS, OWN_ERROR_SLOT_MS, accumulateErrorBuckets, attemptOf, classifyError, errorBucketKeyOf } from "./own-error-bucket.js";

test("原因分五类：限流（429）、上游故障（5xx、529、超时）、没钱或 Key 失效（401/402/403、余额额度类错误码）、请求问题（400/413/422、内容审核）、其他", () => {
  const cases = [
    [429, "bad_response_status_code", "rate_limit"], [429, "rate_limit_exceeded", "rate_limit"], [0, "rate_limit_exceeded", "rate_limit"],
    [500, "do_request_failed", "upstream"], [502, "bad_response_status_code", "upstream"], [503, "bad_response_status_code", "upstream"], [504, "", "upstream"], [529, "overloaded_error", "upstream"],
    [408, "", "upstream"], [0, "channel:response_time_exceeded", "upstream"], [500, "channel:response_time_exceeded", "upstream"], [0, "do_request_failed", "upstream"], [0, "empty_response", "upstream"],
    [401, "bad_response_status_code", "auth_quota"], [402, "", "auth_quota"], [403, "bad_response_status_code", "auth_quota"],
    [429, "insufficient_quota", "auth_quota"], [200, "insufficient_user_quota", "auth_quota"], [500, "channel:invalid_key", "auth_quota"], [503, "channel:no_available_key", "auth_quota"],
    [400, "invalid_api_key", "auth_quota"], [403, "billing_hard_limit_reached", "auth_quota"], [401, "account_deactivated", "auth_quota"],
    [400, "bad_response_status_code", "bad_request"], [413, "", "bad_request"], [422, "", "bad_request"], [400, "sensitive_words_detected", "bad_request"], [0, "prompt_blocked", "bad_request"],
    [400, "context_length_exceeded", "bad_request"], [0, "convert_request_failed", "bad_request"],
    [404, "bad_response_status_code", "other"], [404, "model_not_found", "other"], [0, "", "other"], [418, "weird", "other"], [undefined, undefined, "other"],
  ];
  for (const [status, code, reason] of cases) assert.equal(classifyError(status, code), reason, `${status} ${code}`);
  assert.deepEqual([...ERROR_REASONS], ["rate_limit", "upstream", "auth_quota", "bad_request", "other"]);
  assert.ok(cases.every(([, , reason]) => ERROR_REASONS.includes(reason)));
  // 状态码是字符串或带小数也认
  assert.equal(classifyError("429", ""), "rate_limit");
  assert.equal(classifyError(503.0, null), "upstream");
});

test("第几次尝试 = use_channel 的长度，存成 1、2、3（3 表示 3 次及以上）；读不到当 1", () => {
  const other = (use) => ({ admin_info: { use_channel: use } });
  assert.deepEqual([attemptOf(other(["1"])), attemptOf(other(["1", "2"])), attemptOf(other(["1", "2", "3"])), attemptOf(other(["1", "2", "3", "4", "5"]))], [1, 2, 3, 3]);
  assert.deepEqual([attemptOf({}), attemptOf(null), attemptOf({ admin_info: {} }), attemptOf(other([])), attemptOf(other("1,2")), attemptOf(other(null))], [1, 1, 1, 1, 1, 1]);
});

const H = OWN_ERROR_SLOT_MS;
const at = 10 * H + 5 * 60000; // 第 10 个小时里
const errorRow = (id, extra = {}, other = {}) => ({ id, type: 5, created_at: Math.floor(at / 1000), channel: 3, model_name: "gpt-4o", group: "vip", username: "alice", token_name: "tok", content: "用户说了点什么 sk-abc",
  other: JSON.stringify({ status_code: 429, error_code: "bad_response_status_code", channel_id: 3, admin_info: { use_channel: ["3"] }, ...other }), ...extra });

test("累计：同一小时、渠道、模型、分组、原因、状态码、第几次尝试的加起来；换任何一项是另一个桶；other 是对象或坏 JSON 也不崩", () => {
  const rows = [errorRow(1), errorRow(2), errorRow(3, {}, { status_code: 503 }), errorRow(4, { channel: 4 }), errorRow(5, { model_name: "claude" }), errorRow(6, { group: "default" }),
    errorRow(7, {}, { admin_info: { use_channel: ["3", "5"] } }), errorRow(8, { created_at: Math.floor((at + H) / 1000) }), errorRow(9, { other: { status_code: 429, admin_info: { use_channel: ["3"] } } }), errorRow(10, { other: "{坏" })];
  const buckets = [...accumulateErrorBuckets(rows).values()];
  const find = (match) => buckets.find((bucket) => Object.entries(match).every(([key, value]) => bucket[key] === value));
  assert.equal(find({ slotMs: 10 * H, channelId: 3, model: "gpt-4o", group: "vip", status: 429, attempt: 1, reason: "rate_limit" }).count, 3, "1、2、9（other 是对象）加起来");
  assert.equal(find({ status: 503, reason: "upstream" }).count, 1);
  assert.equal(find({ channelId: 4 }).count, 1);
  assert.equal(find({ model: "claude" }).count, 1);
  assert.equal(find({ group: "default" }).count, 1);
  assert.equal(find({ attempt: 2 }).count, 1);
  assert.equal(find({ slotMs: 11 * H }).count, 1, "下一个小时");
  assert.equal(find({ status: 0, reason: "other", attempt: 1 }).count, 1, "坏 JSON：状态码 0、其他、第 1 次");
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), rows.length, "每条进且只进一个桶");
});

test("只存次数：桶里没有错误原文、用户名、令牌名、请求号；不是 type 5 的、没有时间的行不算；渠道取 channel 或 channel_id 或 other.channel_id", () => {
  const rows = [errorRow(1, { request_id: "req-123" }), { ...errorRow(2), type: 2 }, { ...errorRow(3), created_at: 0 }, errorRow(4, { channel: undefined, channel_id: 8 }), errorRow(5, { channel: undefined }, { channel_id: 9 }), errorRow(6, { channel: undefined }, { channel_id: undefined })];
  const buckets = accumulateErrorBuckets(rows);
  const text = JSON.stringify([...buckets.values()]);
  for (const secret of ["alice", "tok", "sk-abc", "用户说了点什么", "req-123"]) assert.ok(!text.includes(secret), `桶里不能有 ${secret}`);
  assert.deepEqual([...buckets.values()].map((bucket) => [bucket.channelId, bucket.count]).sort(), [[0, 1], [3, 1], [8, 1], [9, 1]]);
  assert.deepEqual(Object.keys([...buckets.values()][0]).sort(), ["attempt", "channelId", "count", "group", "model", "reason", "slotMs", "status"]);
});

test("可以往已有的 Map 里接着加（暂存续采用）；桶的键不随字段顺序变", () => {
  const into = accumulateErrorBuckets([errorRow(1)]);
  accumulateErrorBuckets([errorRow(2), errorRow(3, {}, { status_code: 500 })], {}, into);
  assert.deepEqual([...into.values()].map((bucket) => bucket.count).sort(), [1, 2]);
  const bucket = [...into.values()][0];
  assert.equal(errorBucketKeyOf(bucket), errorBucketKeyOf({ count: 9, attempt: bucket.attempt, status: bucket.status, reason: bucket.reason, group: bucket.group, model: bucket.model, channelId: bucket.channelId, slotMs: bucket.slotMs }));
});
