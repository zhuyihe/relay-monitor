import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETRY_RANGES, ERROR_REASONS, MAX_ATTEMPT, OWN_ERROR_SLOT_MS, accumulateErrorBuckets, attemptOf, classifyError, errorBucketKeyOf, isRetryable, parseStatusRanges } from "./own-error-bucket.js";

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

test("第几次尝试 = use_channel 的长度，存确切的 1–10（超过 10 记 10）；读不到当 1", () => {
  const other = (n) => ({ admin_info: { use_channel: Array.from({ length: n }, (_, i) => String(i + 1)) } });
  assert.deepEqual([1, 2, 3, 4, 5, 9, 10, 11, 40].map((n) => attemptOf(other(n))), [1, 2, 3, 4, 5, 9, 10, 10, 10]);
  assert.equal(MAX_ATTEMPT, 10);
  assert.deepEqual([attemptOf({}), attemptOf(null), attemptOf({ admin_info: {} }), attemptOf(other(0)), attemptOf({ admin_info: { use_channel: "1,2" } }), attemptOf({ admin_info: { use_channel: null } })], [1, 1, 1, 1, 1, 1]);
});

test("解析自动重试状态码范围：「100-199,300-399,401,429」；全角逗号、空格能认；空字符串是没有任何范围；写不出来的片段丢掉；不是字符串是 null（当没读到）", () => {
  assert.deepEqual(parseStatusRanges("100-199,300-399,401-407,409-499,500-503,505-523,525-599"), DEFAULT_RETRY_RANGES.map((range) => [...range]));
  assert.deepEqual(parseStatusRanges("429，500 - 599 , 401"), [[401, 401], [429, 429], [500, 599]]);
  assert.deepEqual(parseStatusRanges(""), []);
  assert.deepEqual(parseStatusRanges("abc,99,600-700x,200-100,404"), [[404, 404]], "不是三位数、倒过来的、带多余字符的都丢掉");
  assert.deepEqual([parseStatusRanges(null), parseStatusRanges(undefined), parseStatusRanges(429)], [null, null, null]);
});

test("能不能重试（照 rc.30 的 shouldRetry）：默认范围下 429、401、403、5xx（除 504、524）能重试，400、408、504、524 不能；没有状态码的重试；channel: 开头的错误码一直重试；不重试的错误码不重试", () => {
  const retry = (status, code = "", ranges = null) => isRetryable(status, code, ranges);
  assert.deepEqual([429, 500, 502, 503, 529, 401, 402, 403, 404, 413, 422, 599, 100, 301].map((status) => retry(status)), Array(14).fill(true));
  assert.deepEqual([400, 408, 504, 524, 200, 204].map((status) => retry(status)), Array(6).fill(false));
  assert.deepEqual([retry(0), retry(undefined), retry(600), retry(99)], [true, true, true, true], "没有状态码（超时、读不到响应）：重试");
  assert.equal(retry(400, "channel:invalid_key"), true, "渠道的 Key 不可用这类错一直重试（直到次数用完）");
  assert.equal(retry(0, "channel:response_time_exceeded"), true);
  assert.deepEqual([retry(429, "bad_response_body"), retry(500, "read_request_body_failed"), retry(403, "pre_consume_token_quota_failed"), retry(403, "insufficient_user_quota")], [false, false, false, false]);
  // 站点自己改过范围：只重试 429 和 5xx，别的状态码不重试；范围是空的什么状态码都不重试（没有状态码的还是重试）
  const custom = parseStatusRanges("429,500-599");
  assert.deepEqual([retry(429, "", custom), retry(503, "", custom), retry(401, "", custom), retry(409, "", custom), retry(504, "", custom)], [true, true, false, false, false]);
  assert.deepEqual([retry(429, "", []), retry(0, "", [])], [false, true]);
});

const H = OWN_ERROR_SLOT_MS;
const at = 10 * H + 5 * 60000; // 第 10 个小时里
const errorRow = (id, extra = {}, other = {}) => ({ id, type: 5, user_id: 7, created_at: Math.floor(at / 1000), channel: 3, model_name: "gpt-4o", group: "vip", username: "alice", token_name: "tok", content: "用户说了点什么 sk-abc",
  other: JSON.stringify({ status_code: 429, error_code: "bad_response_status_code", channel_id: 3, admin_info: { use_channel: ["3"] }, ...other }), ...extra });
const channels = (buckets) => [...buckets.values()].filter((bucket) => bucket.table === "channel");
const users = (buckets) => [...buckets.values()].filter((bucket) => bucket.table === "user");

test("渠道桶：同一小时、渠道、模型、分组、原因、状态码、第几次尝试、能不能重试的加起来；换任何一项是另一个桶；other 是对象或坏 JSON 也不崩", () => {
  const rows = [errorRow(1), errorRow(2), errorRow(3, {}, { status_code: 503 }), errorRow(4, { channel: 4 }), errorRow(5, { model_name: "claude" }), errorRow(6, { group: "default" }),
    errorRow(7, {}, { admin_info: { use_channel: ["3", "5"] } }), errorRow(8, { created_at: Math.floor((at + H) / 1000) }), errorRow(9, { other: { status_code: 429, admin_info: { use_channel: ["3"] } } }), errorRow(10, { other: "{坏" }),
    errorRow(11, {}, { status_code: 400, error_code: "bad_response_status_code" }), errorRow(12, {}, { admin_info: { use_channel: ["1", "2", "3", "4", "5", "6"] } })];
  const buckets = channels(accumulateErrorBuckets(rows));
  const find = (match) => buckets.find((bucket) => Object.entries(match).every(([key, value]) => bucket[key] === value));
  assert.equal(find({ slotMs: 10 * H, channelId: 3, model: "gpt-4o", group: "vip", status: 429, attempt: 1, reason: "rate_limit", retryable: 1 }).count, 3, "1、2、9（other 是对象）加起来");
  assert.equal(find({ status: 503, reason: "upstream" }).count, 1);
  assert.equal(find({ channelId: 4 }).count, 1);
  assert.equal(find({ model: "claude" }).count, 1);
  assert.equal(find({ group: "default" }).count, 1);
  assert.equal(find({ attempt: 2 }).count, 1);
  assert.equal(find({ attempt: 6 }).count, 1, "第几次尝试存确切的值，不并成「3 次及以上」");
  assert.equal(find({ slotMs: 11 * H }).count, 1, "下一个小时");
  assert.equal(find({ status: 0, reason: "other", attempt: 1, retryable: 1 }).count, 1, "坏 JSON：状态码 0、其他、第 1 次、没有状态码按能重试");
  assert.deepEqual([find({ status: 400, reason: "bad_request" }).retryable, find({ status: 503 }).retryable], [0, 1], "400 不能重试（这一次就是这个请求最后一次失败）");
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), rows.length, "每条进且只进一个渠道桶");
});

test("能不能重试跟着站点的重试范围走：范围读不到按默认；站点改成只重试 429 时 503 变成不能重试", () => {
  const rows = [errorRow(1, {}, { status_code: 503 }), errorRow(2)];
  const standard = channels(accumulateErrorBuckets(rows, {}));
  const custom = channels(accumulateErrorBuckets(rows, { retryRanges: parseStatusRanges("429") }));
  assert.deepEqual(standard.map((bucket) => [bucket.status, bucket.retryable]).sort(), [[429, 1], [503, 1]]);
  assert.deepEqual(custom.map((bucket) => [bucket.status, bucket.retryable]).sort(), [[429, 1], [503, 0]]);
});

test("用户桶：小时 × 用户 ID × 模型 × 原因 → 次数；firstCount 只数第 1 次尝试；只存用户 ID，不存用户名", () => {
  const rows = [errorRow(1), errorRow(2, {}, { admin_info: { use_channel: ["3", "5"] } }), errorRow(3, {}, { admin_info: { use_channel: ["3", "5", "6"] } }), errorRow(4, { user_id: 8 }), errorRow(5, {}, { status_code: 503 }), errorRow(6, { model_name: "claude" }), errorRow(7, { user_id: undefined })];
  const buckets = users(accumulateErrorBuckets(rows));
  const find = (match) => buckets.find((bucket) => Object.entries(match).every(([key, value]) => bucket[key] === value));
  assert.deepEqual(find({ userId: 7, model: "gpt-4o", reason: "rate_limit" }), { table: "user", slotMs: 10 * H, userId: 7, model: "gpt-4o", reason: "rate_limit", count: 3, firstCount: 1 }, "3 次失败，其中只有 1 次是第 1 次尝试：被拒过的请求 1 个");
  assert.deepEqual([find({ userId: 8 }).count, find({ reason: "upstream" }).count, find({ model: "claude" }).count, find({ userId: 0 }).count], [1, 1, 1, 1], "没有 user_id 记 0");
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), rows.length, "每条进且只进一个用户桶");
  assert.deepEqual(Object.keys(buckets[0]).sort(), ["count", "firstCount", "model", "reason", "slotMs", "table", "userId"]);
});

test("只存次数：桶里没有错误原文、用户名、令牌名、请求号；不是 type 5 的、没有时间的行不算；渠道取 channel 或 channel_id 或 other.channel_id", () => {
  const rows = [errorRow(1, { request_id: "req-123" }), { ...errorRow(2), type: 2 }, { ...errorRow(3), created_at: 0 }, errorRow(4, { channel: undefined, channel_id: 8 }), errorRow(5, { channel: undefined }, { channel_id: 9 }), errorRow(6, { channel: undefined }, { channel_id: undefined })];
  const buckets = accumulateErrorBuckets(rows);
  const text = JSON.stringify([...buckets.values()]);
  for (const secret of ["alice", "tok", "sk-abc", "用户说了点什么", "req-123"]) assert.ok(!text.includes(secret), `桶里不能有 ${secret}`);
  assert.deepEqual(channels(buckets).map((bucket) => [bucket.channelId, bucket.count]).sort(), [[0, 1], [3, 1], [8, 1], [9, 1]]);
  assert.deepEqual(Object.keys(channels(buckets)[0]).sort(), ["attempt", "channelId", "count", "group", "model", "reason", "retryable", "slotMs", "status", "table"]);
});

test("可以往已有的 Map 里接着加（暂存续采用）；桶的键不随字段顺序变，用户桶和渠道桶的键不会撞", () => {
  const into = accumulateErrorBuckets([errorRow(1)]);
  accumulateErrorBuckets([errorRow(2), errorRow(3, {}, { status_code: 500 })], {}, into);
  assert.deepEqual(channels(into).map((bucket) => bucket.count).sort(), [1, 2]);
  assert.deepEqual(users(into).map((bucket) => [bucket.reason, bucket.count]).sort(), [["rate_limit", 2], ["upstream", 1]]);
  const bucket = channels(into)[0];
  assert.equal(errorBucketKeyOf(bucket), errorBucketKeyOf({ count: 9, retryable: bucket.retryable, attempt: bucket.attempt, status: bucket.status, reason: bucket.reason, group: bucket.group, model: bucket.model, channelId: bucket.channelId, slotMs: bucket.slotMs, table: "channel" }));
  assert.equal(new Set([...into.keys()]).size, into.size);
});
