import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_SPEC } from "./own-log-store.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { channelUpstreamMap, dedupeChannels, estimateFinalFailures, queryErrorSupply, queryRejectedUsers, wallHourOf } from "./own-error-supply.js";

const H = 3600000, DAY = 24 * H;
const errorBucket = (slotMs, extra = {}) => ({ table: "channel", slotMs, channelId: 1, model: "gpt-4o", group: "g", reason: "rate_limit", status: 429, attempt: 1, retryable: 1, count: 1, sampled: 0, ...extra });
const userBucket = (slotMs, extra = {}) => ({ table: "user", slotMs, userId: 7, model: "gpt-4o", reason: "rate_limit", count: 1, firstCount: 1, sampled: 0, ...extra });
const consumeBucket = (slotMs, extra = {}) => ({ slotMs, channelId: 1, model: "gpt-4o", upstreamModel: "", group: "g", semantic: "openai", requests: 10, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, quota: 0, adminQuota: 0, testQuota: 0, ...extra });
const attempts = (retryable = {}, nonRetryable = {}) => ({ retryable: Array.from({ length: 10 }, (_, i) => retryable[i + 1] || 0), nonRetryable: Array.from({ length: 10 }, (_, i) => nonRetryable[i + 1] || 0) });
const rejected = (parts = {}) => { const base = { rate_limit: 0, upstream: 0, auth_quota: 0, other: 0, ...parts }; return { ...base, total: base.rate_limit + base.upstream + base.auth_quota + base.other }; };

async function seeded() {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  await errors.startCursor("own", 0, 0); await consume.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 50 * H, buckets: [
    errorBucket(10 * H, { count: 4 }),                                              // gpt-4o 渠道 1：429 第 1 次 4 条
    errorBucket(10 * H, { attempt: 2, count: 3 }),                                  // 重试后又被拒 3 次（第 2 次）
    errorBucket(10 * H, { reason: "upstream", status: 503, count: 2, sampled: 1 }),  // 503 第 1 次 2 条（这个桶里有一个窗口是按样本估的）
    errorBucket(10 * H, { channelId: 2, attempt: 3, count: 1, reason: "upstream", status: 503 }), // 渠道 2 上第 3 次尝试被拒 1 条
    errorBucket(11 * H, { channelId: 2, model: "claude", reason: "auth_quota", status: 402, count: 5 }),
    errorBucket(11 * H, { channelId: 9, model: "claude", reason: "upstream", status: 529, count: 1 }), // 渠道 9 没有绑定
    errorBucket(11 * H, { channelId: 2, model: "claude", reason: "upstream", status: 504, retryable: 0, count: 2 }), // 504 不能重试：第 1 次就是最终失败
    errorBucket(11 * H, { channelId: 2, model: "claude", reason: "bad_request", status: 400, retryable: 0, count: 2 }), // 400 是用户自己的请求写错了：不算被拒
    errorBucket(30 * H, { count: 100 }),                                            // 范围之外
    userBucket(10 * H, { count: 7, firstCount: 4, sampled: 1 }), userBucket(10 * H, { userId: 8, count: 2, firstCount: 2 }), userBucket(11 * H, { model: "claude", reason: "auth_quota", count: 5, firstCount: 5 }),
    userBucket(10 * H, { userId: 9, model: "other", count: 50, firstCount: 50 }), userBucket(30 * H, { count: 999, firstCount: 999 }),
    userBucket(11 * H, { userId: 10, model: "claude", reason: "bad_request", count: 30, firstCount: 30 }), // 只有请求问题的用户：不算被挡的用户
  ] });
  await consume.applyWindow("own", { fromMs: 0, toMs: 50 * H, buckets: [
    consumeBucket(10 * H, { requests: 40 }), consumeBucket(10 * H, { requests: 5, group: "vip" }),   // 同一渠道同一模型两个分组：加起来
    consumeBucket(11 * H, { channelId: 2, model: "claude", requests: 7 }), consumeBucket(11 * H, { channelId: 9, model: "claude", requests: 2 }),
    consumeBucket(10 * H, { channelId: 2, requests: 3 }),
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
  { id: "r6", enabled: true, ownStationId: "own", upstreamStationId: "up-b", archivedAt: null, channels: [{ channelId: 7 }] }, // 同一个上游账号 up-b，另一把 Key
];

test("渠道 → 现有绑定：只算这个自营站点的、启用的、没解除的绑定", () => {
  const map = channelUpstreamMap(rules, "own");
  assert.deepEqual([...map].map(([channelId, value]) => [channelId, value.upstreamStationId, value.ruleId]), [[1, "up-a", "r1"], [2, "up-b", "r2"], [3, "up-b", "r2"], [7, "up-b", "r6"]]);
  assert.equal(channelUpstreamMap([], "own").size, 0);
  assert.equal(channelUpstreamMap(null, "own").size, 0);
});

test("渠道去重：同一把 Key（同一条绑定）下的渠道只留一个代表；同一个上游账号下的也能去重；没有绑定的渠道各算各的", () => {
  const map = channelUpstreamMap(rules, "own");
  assert.deepEqual(dedupeChannels([3, 2, 1, 9, 9, 7], map, "key"), [{ id: 1, members: [1] }, { id: 2, members: [2, 3] }, { id: 7, members: [7] }, { id: 9, members: [9] }], "2、3 共用一把 Key；7 是 up-b 的另一把 Key");
  assert.deepEqual(dedupeChannels([3, 2, 1, 9, 7], map, "upstream"), [{ id: 1, members: [1] }, { id: 2, members: [2, 3, 7] }, { id: 9, members: [9] }], "2、3、7 都是 up-b 这一个上游账号");
  assert.deepEqual(dedupeChannels([], map), []);
});

test("最终没买到的请求 F：有重试次数 R（读到的或推出来的）时 = 不能重试的失败 + 第 R+1 档的能重试的失败；没有 R 时只剩不能重试的；逐档相减的原始数另给", () => {
  // R = 2：一共最多试 3 次。第 1 档 20 条失败（能重试），第 2 档 8 条，第 3 档 3 条（试满了，最终失败）；另有 2 条不能重试
  const a = attempts({ 1: 20, 2: 8, 3: 3 }, { 1: 2 });
  assert.deepEqual(estimateFinalFailures(a, 2), { finalFailures: 5, method: "retry-times", retriedOrStopped: (20 - (8 + 0)) + (8 - 3) + 3 });
  assert.deepEqual(estimateFinalFailures(a, null), { finalFailures: 2, method: "none", retriedOrStopped: 20 }, "没有 R：只数不能重试的，不再用「这个小时见到的最大档」猜");
  // R 比见到的最大档大（站点重试 5 次，这个小时只有一条请求试到第 3 次）：第 6 档是 0，F 只剩不能重试的——重试成功的、还在试的不算
  assert.equal(estimateFinalFailures(a, 5).finalFailures, 2);
  assert.equal(estimateFinalFailures(attempts({ 1: 5 }), 0).finalFailures, 5, "R = 0 不重试：第 1 档的就是最终失败");
  assert.equal(estimateFinalFailures(attempts({ 1: 5, 2: 5 }), 0).finalFailures, 5, "R = 0 时第 2 档不该有（口径变过的历史）：只认第 1 档");
  assert.equal(estimateFinalFailures(attempts(), null).finalFailures, 0);
  assert.equal(estimateFinalFailures(attempts({ 10: 4 }), 40).finalFailures, 4, "超过 10 档按 10 档");
  // 不能重试的失败第几档都算最终失败
  assert.equal(estimateFinalFailures(attempts({}, { 1: 3, 4: 1 }), 3).finalFailures, 4);
});

test("渠道 × 模型 × 小时拼起来：成交、被拒（四类，请求问题另记）、被拒过的请求数、分第几次尝试和能不能重试；范围之外的不算", async () => {
  const { errors, consume } = await seeded();
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H + 600000, toMs: 12 * H - 1, channelUpstream: channelUpstreamMap(rules, "own"), tz: "UTC" });
  assert.deepEqual([result.fromSlotMs, result.toSlotMs], [10 * H, 12 * H], "from 向下、to 向上取整点");
  const cell = (slotMs, channelId, model) => result.cells.find((item) => item.slotMs === slotMs && item.channelId === channelId && item.model === model);
  assert.deepEqual(cell(10 * H, 1, "gpt-4o"), { slotMs: 10 * H, channelId: 1, model: "gpt-4o", rejected: rejected({ rate_limit: 7, upstream: 2 }), rejectedRequests: 6, badRequest: 0, success: 45, sampled: 1, attempts: attempts({ 1: 6, 2: 3 }) });
  assert.deepEqual(cell(10 * H, 2, "gpt-4o"), { slotMs: 10 * H, channelId: 2, model: "gpt-4o", rejected: rejected({ upstream: 1 }), rejectedRequests: 0, badRequest: 0, success: 3, sampled: 0, attempts: attempts({ 3: 1 }) });
  assert.deepEqual(cell(11 * H, 2, "claude"), { slotMs: 11 * H, channelId: 2, model: "claude", rejected: rejected({ auth_quota: 5, upstream: 2 }), rejectedRequests: 7, badRequest: 2, success: 7, sampled: 0, attempts: attempts({ 1: 5 }, { 1: 2 }) }, "400 另记 badRequest，不进被拒、不进尝试数；504 不能重试另记");
  assert.equal(cell(30 * H, 1, "gpt-4o"), undefined, "范围之外");
  assert.deepEqual(result.cells.map((item) => [item.slotMs, item.channelId, item.model]), [[10 * H, 1, "gpt-4o"], [10 * H, 2, "gpt-4o"], [11 * H, 2, "claude"], [11 * H, 9, "claude"]], "有数的格子才有，按小时、渠道、模型排");
});

test("汇总：按模型、按上游、按渠道（所有模型加起来、按小时）、按小时；F 读得到重试次数时用它，读不到用近 7 天见到的最大档推", async () => {
  const { errors, consume } = await seeded();
  const base = { errors, consume, stationId: "own", fromMs: 10 * H, toMs: 12 * H, channelUpstream: channelUpstreamMap(rules, "own"), tz: "UTC" };
  const known = await queryErrorSupply({ ...base, retry: { retryTimes: 2 } }), unknown = await queryErrorSupply(base);
  assert.deepEqual(known.retry, { retryTimes: 2, method: "retry-times", approximate: false });
  assert.deepEqual(unknown.retry, { retryTimes: 2, method: "inferred", approximate: true }, "站点没读到：整个站点见到的最大档是第 3 档 → R = 2；错误日志只读了 50 小时，不到 7 天：约");
  assert.deepEqual(known.total.rejected, rejected({ rate_limit: 7, upstream: 6, auth_quota: 5 }), "被拒 18 次（重试后又被拒的也算次数；400 不算）");
  assert.deepEqual([known.total.rejectedRequests, known.total.badRequest, known.total.success], [6 + 0 + 7 + 1, 2, 40 + 5 + 3 + 7 + 2], "被拒过的请求只数第 1 次的条数；成功 = 消费桶的请求数");
  // gpt-4o 10 点：第 1 档 6、第 2 档 3、第 3 档 1（都能重试）；R=2 时 F = 第 3 档 1
  const gpt = (result) => result.byModel.find((item) => item.model === "gpt-4o");
  const claude = (result) => result.byModel.find((item) => item.model === "claude");
  assert.deepEqual([gpt(known).finalFailures, gpt(unknown).finalFailures], [1, 1]);
  assert.deepEqual([gpt(known).rejected.total, gpt(known).rejectedRequests, gpt(known).success, gpt(known).sampled, claude(known).sampled], [10, 6, 48, 1, 0], "有一个窗口是按样本估的：页面该写「约」");
  // claude 11 点：402 第 1 档 5（能重试）、529 第 1 档 1、504 不能重试 2、400 不进 F；R=2：F = 不能重试 2 + 第 3 档 0 = 2
  assert.deepEqual([claude(known).finalFailures, claude(unknown).finalFailures], [2, 2]);
  assert.equal(known.total.finalFailures, 3);
  assert.deepEqual(known.byModelHour.map((item) => [item.slotMs, item.model, item.finalFailures, item.retriedOrStopped]), [[10 * H, "gpt-4o", 1, (6 - 3) + (3 - 1) + 1], [11 * H, "claude", 2, 6]]);
  assert.deepEqual(known.byModel.map((item) => item.model), ["gpt-4o", "claude"], "被拒多的在前");
  assert.deepEqual(known.byUpstream.map((item) => [item.upstreamStationId, item.channelIds, item.rejected.total, item.rejectedRequests, item.success]),
    [["up-a", [1], 9, 6, 45], ["up-b", [2], 8, 7, 10], [null, [9], 1, 1, 2]], "渠道 9 没有绑定：归到「没对上上游」（null）");
  // 按渠道：这个渠道所有模型加起来，每个小时一条
  const channel = known.byChannel.find((item) => item.channelId === 2);
  assert.deepEqual([channel.ruleId, channel.upstreamStationId, channel.success, channel.rejected.total, channel.hours.map((hour) => [hour.slotMs, hour.success, hour.rejected.total])], ["r2", "up-b", 10, 8, [[10 * H, 3, 1], [11 * H, 7, 7]]]);
  assert.deepEqual(known.byChannel.map((item) => item.channelId), [1, 2, 9]);
  assert.deepEqual(known.byChannel.find((item) => item.channelId === 9), { channelId: 9, ruleId: null, upstreamStationId: null, rejected: rejected({ upstream: 1 }), rejectedRequests: 1, badRequest: 0, success: 2, sampled: 0, hours: [{ slotMs: 11 * H, rejected: rejected({ upstream: 1 }), rejectedRequests: 1, badRequest: 0, success: 2, sampled: 0 }] });
  assert.deepEqual(known.byHour.map((item) => [item.slotMs, item.rejected.total, item.rejectedRequests, item.success, item.finalFailures]), [[10 * H, 10, 6, 48, 1], [11 * H, 8, 8, 9, 2]], "每个小时都有");
});

test("请求问题（400 之类）不算被拒：10 个 400 加 3 个 429，被拒总数、被拒过的请求数、F 都只数 429；其他（404）进被拒总数和被拒过的请求数，不进 F；用户桶同样", async () => {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  await errors.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 10 * DAY, buckets: [
    errorBucket(10 * H, { count: 3 }),
    errorBucket(10 * H, { reason: "bad_request", status: 400, retryable: 0, count: 10 }),
    errorBucket(10 * H, { reason: "other", status: 404, count: 4 }),
    userBucket(10 * H, { count: 3, firstCount: 3 }), userBucket(10 * H, { userId: 8, reason: "bad_request", count: 10, firstCount: 10 }), userBucket(10 * H, { userId: 9, reason: "other", count: 4, firstCount: 4 }),
  ] });
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H, toMs: 11 * H, retry: { retryTimes: 0 }, tz: "UTC" });
  assert.deepEqual(result.total.rejected, rejected({ rate_limit: 3, other: 4 }));
  assert.deepEqual([result.total.rejectedRequests, result.total.badRequest, result.total.finalFailures], [7, 10, 3], "被拒过的请求 3 + 4；F 只数 429 的 3 条（400 和 404 都不进 F）");
  const users = await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 11 * H });
  assert.deepEqual(users.map((user) => [user.userId, user.rejected.total, user.rejectedRequests]), [[9, 4, 4], [7, 3, 3]], "只有 400 的用户不出现");
  // 推重试次数时 400 也不算：只有 400 的站点推不出 R
  const only400 = new MemoryOwnLogStore(ERROR_SPEC);
  await only400.startCursor("own", 0, 0);
  await only400.applyWindow("own", { fromMs: 0, toMs: DAY, buckets: [errorBucket(10 * H, { reason: "bad_request", status: 400, retryable: 0, attempt: 4, count: 9 })] });
  const none = await queryErrorSupply({ errors: only400, consume, stationId: "own", fromMs: 10 * H, toMs: 11 * H, tz: "UTC" });
  assert.deepEqual([none.retry.method, none.retry.retryTimes, none.total.finalFailures, none.total.rejected.total], ["none", null, 0, 0]);
});

test("读不到站点的重试次数：用近 7 天整个站点见到的最大档推 R（最大档 = R + 1），别的小时的数也算；不够 7 天写「约」；不会把这个小时只见到的第 2 档当成最后一档", async () => {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  // 站点实际重试 3 次（最多 4 档）。10 点只见到第 1、2 档；20 点有请求一路失败到第 4 档
  await errors.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 10 * DAY, buckets: [
    errorBucket(10 * H, { count: 20 }), errorBucket(10 * H, { attempt: 2, count: 8 }),
    errorBucket(20 * H, { count: 10 }), errorBucket(20 * H, { attempt: 2, count: 4 }), errorBucket(20 * H, { attempt: 3, count: 2 }), errorBucket(20 * H, { attempt: 4, count: 1 }),
    errorBucket(DAY * 9, { attempt: 7, count: 5 }), // 这个查询范围的终点以后：不算
  ] });
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H, toMs: 21 * H, tz: "UTC" });
  assert.deepEqual(result.retry, { retryTimes: 3, method: "inferred", approximate: false }, "错误日志读了 10 天 ≥ 7 天：不写约");
  assert.deepEqual(result.byModelHour.map((item) => [item.slotMs, item.finalFailures]), [[10 * H, 0], [20 * H, 1]], "10 点只见到第 2 档：R = 3 时那一档不是最后一档，不算丢单（原来的「这个小时的最大档」会多算 8 条）");
  // 范围往前推 7 天：只算 [终点 − 7 天, 终点) 里见到的
  const narrow = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H, toMs: 11 * H, tz: "UTC" });
  assert.deepEqual([narrow.retry.retryTimes, narrow.retry.method], [1, "inferred"], "终点 11 点：往前 7 天里只见到第 2 档（20 点的还没发生）");
  // 读到的 R 优先，不去推
  assert.deepEqual((await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H, toMs: 21 * H, retry: { retryTimes: 1 }, tz: "UTC" })).retry, { retryTimes: 1, method: "retry-times", approximate: false });
  // 错误日志读了不到 7 天：约
  const young = new MemoryOwnLogStore(ERROR_SPEC);
  await young.startCursor("own", 0, 0);
  await young.applyWindow("own", { fromMs: 0, toMs: 3 * DAY, buckets: [errorBucket(10 * H, { attempt: 2, count: 3 })] });
  assert.deepEqual((await queryErrorSupply({ errors: young, consume, stationId: "own", fromMs: 10 * H, toMs: 11 * H, tz: "UTC" })).retry, { retryTimes: 1, method: "inferred", approximate: true });
});

test("没有数据：每个小时都在、全是 0；错误日志没读过时 cursor 是 null；没打开错误日志（只有成功）时被拒是 0、成功照给", async () => {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  const empty = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 0, toMs: 3 * H, tz: "UTC" });
  assert.equal(empty.cursor, null);
  assert.deepEqual([empty.byModel, empty.byUpstream, empty.byChannel, empty.cells, empty.byModelHour, empty.byHour.length, empty.total.rejected.total, empty.total.success, empty.total.finalFailures], [[], [], [], [], [], 3, 0, 0, 0]);
  await consume.startCursor("own", 0, 0);
  await consume.applyWindow("own", { fromMs: 0, toMs: 5 * H, buckets: [consumeBucket(H, { requests: 12 })] });
  await errors.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 5 * H, buckets: [] });
  const noErrors = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 0, toMs: 3 * H, tz: "UTC" });
  assert.deepEqual(noErrors.cursor, { coveredFromMs: 0, coveredToMs: 5 * H });
  assert.deepEqual([noErrors.total.rejected.total, noErrors.total.rejectedRequests, noErrors.total.success, noErrors.byModel.map((item) => [item.model, item.rejected.total, item.success, item.finalFailures])], [0, 0, 12, [["gpt-4o", 0, 12, 0]]]);
  assert.deepEqual(await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 5 * H, toMs: 5 * H }).then((r) => r.byHour), [], "空范围");
});

test("别的自营站点的数不混进来", async () => {
  const { errors, consume } = await seeded();
  await errors.startCursor("other", 0, 0);
  await errors.applyWindow("other", { fromMs: 0, toMs: 50 * H, buckets: [errorBucket(10 * H, { count: 77 }), userBucket(10 * H, { count: 77 })] });
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H, toMs: 12 * H, tz: "UTC" });
  assert.equal(result.total.rejected.total, 18);
  assert.equal((await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H })).reduce((sum, user) => sum + user.rejected.total, 0), 64);
});

test("墙上时钟：每个小时标是哪一天的几点（业务时区）；夏令时那两天一天 23 / 25 个小时，重复的那个钟点第二个标 repeated；半点时区算开始的那个钟点", async () => {
  const la = "America/Los_Angeles";
  // 2026-03-08 春天跳过 2 点（洛杉矶），2026-11-01 秋天 1 点重复
  const slot = (iso) => Date.parse(iso);
  assert.deepEqual(wallHourOf(slot("2026-03-08T09:00:00Z"), la), { dayKey: "2026-03-08", hour: 1, repeated: false }, "1 点");
  assert.deepEqual(wallHourOf(slot("2026-03-08T10:00:00Z"), la), { dayKey: "2026-03-08", hour: 3, repeated: false }, "2 点不存在：1 点的下一个小时是 3 点");
  assert.deepEqual([wallHourOf(slot("2026-11-01T08:00:00Z"), la), wallHourOf(slot("2026-11-01T09:00:00Z"), la), wallHourOf(slot("2026-11-01T10:00:00Z"), la)],
    [{ dayKey: "2026-11-01", hour: 1, repeated: false }, { dayKey: "2026-11-01", hour: 1, repeated: true }, { dayKey: "2026-11-01", hour: 2, repeated: false }], "1 点出现两次：第二个 repeated");
  assert.deepEqual(wallHourOf(slot("2026-11-01T00:00:00Z"), "Asia/Shanghai"), { dayKey: "2026-11-01", hour: 8, repeated: false });
  // 一整天的小时数
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  const day = async (from, to) => (await queryErrorSupply({ errors, consume, stationId: "own", fromMs: slot(from), toMs: slot(to), tz: la })).byHour;
  const spring = await day("2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"), fall = await day("2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z");
  assert.deepEqual([spring.length, fall.length], [23, 25], "春天 23 小时、秋天 25 小时（按墙上时钟的一天，不是按经过的小时数）");
  assert.deepEqual([...new Set(spring.map((hour) => hour.dayKey))], ["2026-03-08"]);
  assert.deepEqual(spring.map((hour) => hour.hour), [0, 1, ...Array.from({ length: 21 }, (_, i) => i + 3)]);
  assert.deepEqual([...new Set(fall.map((hour) => hour.dayKey))], ["2026-11-01"]);
  assert.deepEqual(fall.map((hour) => hour.hour), [0, 1, 1, ...Array.from({ length: 22 }, (_, i) => i + 2)]);
  assert.deepEqual(fall.filter((hour) => hour.repeated).map((hour) => hour.hour), [1]);
});

test("谁被拒了：按用户 ID，被拒次数、被拒过的请求数（第 1 次尝试）、按模型；只看指定模型；只留前几位；不出现用户名；只有请求问题的用户不出现", async () => {
  const { errors } = await seeded();
  const all = await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H });
  assert.deepEqual(all.map((user) => [user.userId, user.rejected.total, user.rejectedRequests]), [[9, 50, 50], [7, 12, 9], [8, 2, 2]], "被拒多的在前；用户 10 只有请求问题，不算");
  assert.deepEqual(all.find((user) => user.userId === 7).byModel, [
    { model: "gpt-4o", rejected: rejected({ rate_limit: 7 }), rejectedRequests: 4, sampled: 1 },
    { model: "claude", rejected: rejected({ auth_quota: 5 }), rejectedRequests: 5, sampled: 0 },
  ]);
  const claudeOnly = await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H, models: ["claude"] });
  assert.deepEqual(claudeOnly.map((user) => [user.userId, user.rejected.total]), [[7, 5]]);
  assert.equal((await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H, top: 1 })).length, 1);
  assert.deepEqual(await queryRejectedUsers({ errors, stationId: "nobody", fromMs: 0, toMs: 99 * H }), []);
  assert.ok(!JSON.stringify(all).match(/username|email|name"/), "只有用户 ID");
});

test("汇总分批读（每批 24 个小时）：结果和一次读一样；没有错误的格子共用同一份冻住的空对象，第一次加错误才复制；桶行数超过 maxRows 抛 TOO_MANY_BUCKETS", async () => {
  const { errors, consume } = await seeded();
  const calls = [];
  const spy = (store, name) => new Proxy(store, { get: (target, key) => (key === "listBuckets" ? async (station, from, to, options) => { calls.push([name, (to - from) / H]); return target.listBuckets(station, from, to, options); } : target[key].bind ? target[key].bind(target) : target[key]) });
  const wide = await queryErrorSupply({ errors: spy(errors, "e"), consume: spy(consume, "c"), stationId: "own", fromMs: 0, toMs: 60 * H, channelUpstream: channelUpstreamMap(rules, "own"), tz: "UTC", retry: { retryTimes: 2 } });
  assert.deepEqual(calls.map(([name, hours]) => hours), [24, 24, 24, 24, 12, 12], "60 个小时分 3 批 × 2 个存取");
  const once = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 0, toMs: 60 * H, channelUpstream: channelUpstreamMap(rules, "own"), tz: "UTC", retry: { retryTimes: 2 } });
  assert.deepEqual(wide, once, "分批读和整段读结果一样");
  // 只有成交没有错误的格子：共用冻住的空对象
  const store = new MemoryOwnLogStore(ERROR_SPEC), sales = new MemoryOwnLogStore();
  await store.startCursor("own", 0, 0); await sales.startCursor("own", 0, 0);
  await sales.applyWindow("own", { fromMs: 0, toMs: 5 * H, buckets: [consumeBucket(H, { channelId: 1 }), consumeBucket(H, { channelId: 2 })] });
  await store.applyWindow("own", { fromMs: 0, toMs: 5 * H, buckets: [errorBucket(H, { channelId: 2, count: 3 })] });
  const result = await queryErrorSupply({ errors: store, consume: sales, stationId: "own", fromMs: 0, toMs: 2 * H, tz: "UTC", retry: { retryTimes: 1 } });
  const [clean, bad] = [result.cells.find((c) => c.channelId === 1), result.cells.find((c) => c.channelId === 2)];
  assert.ok(Object.isFrozen(clean.rejected) && Object.isFrozen(clean.attempts), "没有错误的格子共用冻住的空对象");
  assert.ok(!Object.isFrozen(bad.rejected) && bad.rejected.rate_limit === 3, "有错误的格子自己有一份");
  assert.deepEqual(clean.rejected, { rate_limit: 0, upstream: 0, auth_quota: 0, other: 0, total: 0 });
  // 桶行数封顶
  await assert.rejects(queryErrorSupply({ errors: store, consume: sales, stationId: "own", fromMs: 0, toMs: 2 * H, tz: "UTC", maxRows: 2 }), (error) => error.code === "TOO_MANY_BUCKETS");
  assert.ok(await queryErrorSupply({ errors: store, consume: sales, stationId: "own", fromMs: 0, toMs: 2 * H, tz: "UTC", maxRows: 3 }), "正好 3 行：不封");
});
