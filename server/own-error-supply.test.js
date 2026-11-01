import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_SPEC } from "./own-log-store.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { channelUpstreamMap, queryErrorSupply } from "./own-error-supply.js";

const H = 3600000;
const errorBucket = (slotMs, extra = {}) => ({ slotMs, channelId: 1, model: "gpt-4o", group: "g", reason: "rate_limit", status: 429, attempt: 1, count: 1, ...extra });
const consumeBucket = (slotMs, extra = {}) => ({ slotMs, channelId: 1, model: "gpt-4o", upstreamModel: "", group: "g", semantic: "openai", requests: 10, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, quota: 0, adminQuota: 0, testQuota: 0, ...extra });

async function seeded() {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  await errors.startCursor("own", 0, 0); await consume.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 50 * H, buckets: [
    errorBucket(10 * H, { count: 4 }),                                              // gpt-4o 渠道 1：429 第 1 次 4 条
    errorBucket(10 * H, { attempt: 2, count: 3 }),                                  // 同一批请求重试后又被拒 3 次（第 2 次）
    errorBucket(10 * H, { reason: "upstream", status: 503, count: 2 }),             // 503 第 1 次 2 条
    errorBucket(11 * H, { channelId: 2, model: "claude", reason: "auth_quota", status: 402, count: 5 }),
    errorBucket(11 * H, { channelId: 9, model: "claude", reason: "upstream", status: 529, count: 1 }), // 渠道 9 没有绑定
    errorBucket(30 * H, { count: 100 }),                                            // 范围之外
  ] });
  await consume.applyWindow("own", { fromMs: 0, toMs: 50 * H, buckets: [
    consumeBucket(10 * H, { requests: 40 }), consumeBucket(10 * H, { requests: 5, group: "vip" }),   // 同一渠道同一模型两个分组：加起来
    consumeBucket(11 * H, { channelId: 2, model: "claude", requests: 7 }), consumeBucket(11 * H, { channelId: 9, model: "claude", requests: 2 }),
    consumeBucket(30 * H, { requests: 999 }),
  ] });
  return { errors, consume };
}
const rules = [
  { id: "r1", enabled: true, ownStationId: "own", upstreamStationId: "up-a", archivedAt: null, channels: [{ channelId: 1 }] },
  { id: "r2", enabled: true, ownStationId: "own", upstreamStationId: "up-b", archivedAt: null, channels: [{ channelId: 2 }, { channelId: 3 }] },
  { id: "r3", enabled: false, ownStationId: "own", upstreamStationId: "up-c", archivedAt: null, channels: [{ channelId: 4 }] },
  { id: "r4", enabled: true, ownStationId: "other-own", upstreamStationId: "up-d", archivedAt: null, channels: [{ channelId: 5 }] },
  { id: "r5", enabled: true, ownStationId: "own", upstreamStationId: "up-e", archivedAt: "2026-01-01", channels: [{ channelId: 6 }] },
];

test("渠道 → 现有绑定：只算这个自营站点的、启用的、没解除的绑定", () => {
  const map = channelUpstreamMap(rules, "own");
  assert.deepEqual([...map].map(([channelId, value]) => [channelId, value.upstreamStationId, value.ruleId]), [[1, "up-a", "r1"], [2, "up-b", "r2"], [3, "up-b", "r2"]]);
  assert.equal(channelUpstreamMap([], "own").size, 0);
  assert.equal(channelUpstreamMap(null, "own").size, 0);
});

test("按模型、按上游、按小时：被拒次数（分原因）、被拒过的请求数（第 1 次的条数）、对应的成功请求数；范围之外的不算", async () => {
  const { errors, consume } = await seeded();
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H + 600000, toMs: 12 * H - 1, channelUpstream: channelUpstreamMap(rules, "own") });
  assert.deepEqual([result.fromSlotMs, result.toSlotMs], [10 * H, 12 * H], "from 向下、to 向上取整点");
  assert.deepEqual(result.total, { rejected: { rate_limit: 7, upstream: 3, auth_quota: 5, bad_request: 0, other: 0, total: 15 }, rejectedRequests: 12, success: 54 }, "被拒 15 次（第 2 次的 3 条也算被拒的次数），被拒过的请求 12 个（只数第 1 次），成功 40+5+7+2");
  const gpt = result.byModel.find((item) => item.model === "gpt-4o"), claude = result.byModel.find((item) => item.model === "claude");
  assert.deepEqual(gpt, { model: "gpt-4o", rejected: { rate_limit: 7, upstream: 2, auth_quota: 0, bad_request: 0, other: 0, total: 9 }, rejectedRequests: 6, success: 45 });
  assert.deepEqual(claude, { model: "claude", rejected: { rate_limit: 0, upstream: 1, auth_quota: 5, bad_request: 0, other: 0, total: 6 }, rejectedRequests: 6, success: 9 });
  assert.deepEqual(result.byModel.map((item) => item.model), ["gpt-4o", "claude"], "被拒多的在前");
  assert.deepEqual(result.byUpstream.map((item) => [item.upstreamStationId, item.channelIds, item.rejected.total, item.rejectedRequests, item.success]),
    [["up-a", [1], 9, 6, 45], ["up-b", [2], 5, 5, 7], [null, [9], 1, 1, 2]], "渠道 9 没有绑定：归到「没对上上游」（null）");
  assert.deepEqual(result.byHour.map((item) => [item.slotMs, item.rejected.total, item.rejectedRequests, item.success]), [[10 * H, 9, 6, 45], [11 * H, 6, 6, 9]], "每个小时都有");
});

test("没有数据：每个小时都在、全是 0；错误日志没读过时 cursor 是 null；没打开错误日志（只有成功）时被拒是 0、成功照给", async () => {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  const empty = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 0, toMs: 3 * H });
  assert.equal(empty.cursor, null);
  assert.deepEqual([empty.byModel, empty.byUpstream, empty.byHour.length, empty.total.rejected.total, empty.total.success], [[], [], 3, 0, 0]);
  await consume.startCursor("own", 0, 0);
  await consume.applyWindow("own", { fromMs: 0, toMs: 5 * H, buckets: [consumeBucket(H, { requests: 12 })] });
  await errors.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 5 * H, buckets: [] });
  const noErrors = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 0, toMs: 3 * H });
  assert.deepEqual(noErrors.cursor, { coveredFromMs: 0, coveredToMs: 5 * H });
  assert.deepEqual([noErrors.total.rejected.total, noErrors.total.rejectedRequests, noErrors.total.success, noErrors.byModel.map((item) => [item.model, item.rejected.total, item.success])], [0, 0, 12, [["gpt-4o", 0, 12]]]);
  assert.deepEqual(await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 5 * H, toMs: 5 * H }).then((r) => r.byHour), [], "空范围");
});

test("别的自营站点的数不混进来", async () => {
  const { errors, consume } = await seeded();
  await errors.startCursor("other", 0, 0);
  await errors.applyWindow("other", { fromMs: 0, toMs: 50 * H, buckets: [errorBucket(10 * H, { count: 77 })] });
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H, toMs: 12 * H });
  assert.equal(result.total.rejected.total, 15);
});
