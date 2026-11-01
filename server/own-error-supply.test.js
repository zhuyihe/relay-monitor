import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_SPEC } from "./own-log-store.js";
import { MemoryOwnLogStore } from "./test-support/own-log-memory-store.js";
import { channelUpstreamMap, dedupeChannels, estimateFinalFailures, queryErrorSupply, queryRejectedUsers, wallHourOf } from "./own-error-supply.js";

const H = 3600000;
const errorBucket = (slotMs, extra = {}) => ({ table: "channel", slotMs, channelId: 1, model: "gpt-4o", group: "g", reason: "rate_limit", status: 429, attempt: 1, retryable: 1, count: 1, ...extra });
const userBucket = (slotMs, extra = {}) => ({ table: "user", slotMs, userId: 7, model: "gpt-4o", reason: "rate_limit", count: 1, firstCount: 1, ...extra });
const consumeBucket = (slotMs, extra = {}) => ({ slotMs, channelId: 1, model: "gpt-4o", upstreamModel: "", group: "g", semantic: "openai", requests: 10, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, quota: 0, adminQuota: 0, testQuota: 0, ...extra });
const attempts = (retryable = {}, nonRetryable = {}) => ({ retryable: Array.from({ length: 10 }, (_, i) => retryable[i + 1] || 0), nonRetryable: Array.from({ length: 10 }, (_, i) => nonRetryable[i + 1] || 0) });

async function seeded() {
  const errors = new MemoryOwnLogStore(ERROR_SPEC), consume = new MemoryOwnLogStore();
  await errors.startCursor("own", 0, 0); await consume.startCursor("own", 0, 0);
  await errors.applyWindow("own", { fromMs: 0, toMs: 50 * H, buckets: [
    errorBucket(10 * H, { count: 4 }),                                              // gpt-4o 渠道 1：429 第 1 次 4 条
    errorBucket(10 * H, { attempt: 2, count: 3 }),                                  // 重试后又被拒 3 次（第 2 次）
    errorBucket(10 * H, { reason: "upstream", status: 503, count: 2 }),             // 503 第 1 次 2 条
    errorBucket(10 * H, { channelId: 2, attempt: 3, count: 1, reason: "upstream", status: 503 }), // 渠道 2 上第 3 次尝试被拒 1 条
    errorBucket(11 * H, { channelId: 2, model: "claude", reason: "auth_quota", status: 402, count: 5 }),
    errorBucket(11 * H, { channelId: 9, model: "claude", reason: "upstream", status: 529, count: 1 }), // 渠道 9 没有绑定
    errorBucket(11 * H, { channelId: 2, model: "claude", reason: "bad_request", status: 400, retryable: 0, count: 2 }), // 400 不能重试：第 1 次就是最终失败
    errorBucket(30 * H, { count: 100 }),                                            // 范围之外
    userBucket(10 * H, { count: 7, firstCount: 4 }), userBucket(10 * H, { userId: 8, count: 2, firstCount: 2 }), userBucket(11 * H, { model: "claude", reason: "auth_quota", count: 5, firstCount: 5 }),
    userBucket(10 * H, { userId: 9, model: "other", count: 50, firstCount: 50 }), userBucket(30 * H, { count: 999, firstCount: 999 }),
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

test("最终没买到的请求 F：读得到重试次数 R 时 = 不能重试的失败 + 第 R+1 档的能重试的失败；读不到时用这个小时见到的最大档；逐档相减的原始数另给", () => {
  // R = 2：一共最多试 3 次。第 1 档 20 条失败（能重试），第 2 档 8 条，第 3 档 3 条（试满了，最终失败）；另有 2 条 400 不能重试
  const a = attempts({ 1: 20, 2: 8, 3: 3 }, { 1: 2 });
  assert.deepEqual(estimateFinalFailures(a, 2), { finalFailures: 5, method: "retry-times", retriedOrStopped: (20 - (8 + 0)) + (8 - 3) + 3 });
  // 读不到 R：见到的最大档是 3，F 取第 3 档 + 不能重试的 = 5（和 R=2 一样）
  assert.deepEqual(estimateFinalFailures(a, null), { finalFailures: 5, method: "max-tier", retriedOrStopped: 20 });
  // R 比见到的最大档大（站点重试 5 次，这个小时只有一条请求试到第 3 次）：读得到 R 时第 6 档是 0，F 只剩不能重试的——重试成功的、还在试的不算；读不到 R 时取最大档（第 3 档的 3 条）会多算
  assert.equal(estimateFinalFailures(a, 5).finalFailures, 2);
  assert.equal(estimateFinalFailures(attempts({ 1: 5 }), 0).finalFailures, 5, "R = 0 不重试：第 1 档的就是最终失败");
  assert.equal(estimateFinalFailures(attempts({ 1: 5, 2: 5 }), 0).finalFailures, 5, "R = 0 时第 2 档不该有（口径变过的历史）：只认第 1 档");
  assert.equal(estimateFinalFailures(attempts(), null).finalFailures, 0);
  assert.equal(estimateFinalFailures(attempts({ 10: 4 }), 40).finalFailures, 4, "超过 10 档按 10 档");
  // 不能重试的失败第几档都算最终失败
  assert.equal(estimateFinalFailures(attempts({}, { 1: 3, 4: 1 }), 3).finalFailures, 4);
});

test("渠道 × 模型 × 小时拼起来：成交、被拒（五类）、被拒过的请求数、分第几次尝试和能不能重试；范围之外的不算", async () => {
  const { errors, consume } = await seeded();
  const result = await queryErrorSupply({ errors, consume, stationId: "own", fromMs: 10 * H + 600000, toMs: 12 * H - 1, channelUpstream: channelUpstreamMap(rules, "own"), tz: "UTC" });
  assert.deepEqual([result.fromSlotMs, result.toSlotMs], [10 * H, 12 * H], "from 向下、to 向上取整点");
  const cell = (slotMs, channelId, model) => result.cells.find((item) => item.slotMs === slotMs && item.channelId === channelId && item.model === model);
  assert.deepEqual(cell(10 * H, 1, "gpt-4o"), { slotMs: 10 * H, channelId: 1, model: "gpt-4o", rejected: { rate_limit: 7, upstream: 2, auth_quota: 0, bad_request: 0, other: 0, total: 9 }, rejectedRequests: 6, success: 45, attempts: attempts({ 1: 6, 2: 3 }) });
  assert.deepEqual(cell(10 * H, 2, "gpt-4o"), { slotMs: 10 * H, channelId: 2, model: "gpt-4o", rejected: { rate_limit: 0, upstream: 1, auth_quota: 0, bad_request: 0, other: 0, total: 1 }, rejectedRequests: 0, success: 3, attempts: attempts({ 3: 1 }) }, "渠道 2 上只有第 3 次尝试被拒：前两次在别的渠道");
  assert.deepEqual(cell(11 * H, 2, "claude").attempts, attempts({ 1: 5 }, { 1: 2 }), "400 不能重试，另记");
  assert.equal(cell(30 * H, 1, "gpt-4o"), undefined, "范围之外");
  assert.deepEqual(result.cells.map((item) => [item.slotMs, item.channelId, item.model]), [[10 * H, 1, "gpt-4o"], [10 * H, 2, "gpt-4o"], [11 * H, 2, "claude"], [11 * H, 9, "claude"]], "有数的格子才有，按小时、渠道、模型排");
});

test("汇总：按模型、按上游、按渠道（所有模型加起来、按小时）、按小时；F 读得到重试次数时用它，读不到用最大档", async () => {
  const { errors, consume } = await seeded();
  const base = { errors, consume, stationId: "own", fromMs: 10 * H, toMs: 12 * H, channelUpstream: channelUpstreamMap(rules, "own"), tz: "UTC" };
  const known = await queryErrorSupply({ ...base, retry: { retryTimes: 2 } }), unknown = await queryErrorSupply(base);
  assert.deepEqual(known.retry, { retryTimes: 2, method: "retry-times" });
  assert.deepEqual(unknown.retry, { retryTimes: null, method: "max-tier" });
  assert.deepEqual(known.total.rejected, { rate_limit: 7, upstream: 4, auth_quota: 5, bad_request: 2, other: 0, total: 18 }, "被拒 18 次（重试后又被拒的也算次数）");
  assert.deepEqual([known.total.rejectedRequests, known.total.success], [6 + 5 + 1 + 2 + 0, 40 + 5 + 3 + 7 + 2], "被拒过的请求只数第 1 次的条数；成功 = 消费桶的请求数");
  // gpt-4o 10 点：第 1 档 6、第 2 档 3、第 3 档 1（都能重试）；R=2 时 F = 第 3 档 1；最大档法也是第 3 档 1
  const gpt = (result) => result.byModel.find((item) => item.model === "gpt-4o");
  assert.deepEqual([gpt(known).finalFailures, gpt(unknown).finalFailures], [1, 1]);
  assert.deepEqual([gpt(known).rejected.total, gpt(known).rejectedRequests, gpt(known).success], [10, 6, 48]);
  // claude 11 点：402 第 1 档 5（能重试：402 在默认范围里）、529 第 1 档 1、400 不能重试 2；R=2：F = 不能重试 2 + 第 3 档 0 = 2；最大档法：2 + 第 1 档能重试 6 = 8
  const claude = (result) => result.byModel.find((item) => item.model === "claude");
  assert.deepEqual([claude(known).finalFailures, claude(unknown).finalFailures], [2, 8], "读不到 R 时取最大档：这个小时只见到第 1 档，当成 R = 0，第 1 档的都算最终失败（下限的另一头：R 实际更大时会多算）");
  assert.equal(known.total.finalFailures, 3);
  assert.deepEqual(known.byModelHour.map((item) => [item.slotMs, item.model, item.finalFailures, item.retriedOrStopped]), [[10 * H, "gpt-4o", 1, (6 - 3) + (3 - 1) + 1], [11 * H, "claude", 2, 6]]);
  assert.deepEqual(known.byModel.map((item) => item.model), ["gpt-4o", "claude"], "被拒多的在前");
  assert.deepEqual(known.byUpstream.map((item) => [item.upstreamStationId, item.channelIds, item.rejected.total, item.rejectedRequests, item.success]),
    [["up-a", [1], 9, 6, 45], ["up-b", [2], 8, 7, 10], [null, [9], 1, 1, 2]], "渠道 9 没有绑定：归到「没对上上游」（null）");
  // 按渠道：这个渠道所有模型加起来，每个小时一条
  const channel = known.byChannel.find((item) => item.channelId === 2);
  assert.deepEqual([channel.ruleId, channel.upstreamStationId, channel.success, channel.rejected.total, channel.hours.map((hour) => [hour.slotMs, hour.success, hour.rejected.total])], ["r2", "up-b", 10, 8, [[10 * H, 3, 1], [11 * H, 7, 7]]]);
  assert.deepEqual(known.byChannel.map((item) => item.channelId), [1, 2, 9]);
  assert.deepEqual(known.byChannel.find((item) => item.channelId === 9), { channelId: 9, ruleId: null, upstreamStationId: null, rejected: { rate_limit: 0, upstream: 1, auth_quota: 0, bad_request: 0, other: 0, total: 1 }, rejectedRequests: 1, success: 2, hours: [{ slotMs: 11 * H, rejected: { rate_limit: 0, upstream: 1, auth_quota: 0, bad_request: 0, other: 0, total: 1 }, rejectedRequests: 1, success: 2 }] });
  assert.deepEqual(known.byHour.map((item) => [item.slotMs, item.rejected.total, item.rejectedRequests, item.success, item.finalFailures]), [[10 * H, 10, 6, 48, 1], [11 * H, 8, 8, 9, 2]], "每个小时都有");
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

test("谁被拒了：按用户 ID，被拒次数、被拒过的请求数（第 1 次尝试）、按模型；只看指定模型；只留前几位；不出现用户名", async () => {
  const { errors } = await seeded();
  const all = await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H });
  assert.deepEqual(all.map((user) => [user.userId, user.rejected.total, user.rejectedRequests]), [[9, 50, 50], [7, 12, 9], [8, 2, 2]], "被拒多的在前");
  assert.deepEqual(all.find((user) => user.userId === 7).byModel, [
    { model: "gpt-4o", rejected: { rate_limit: 7, upstream: 0, auth_quota: 0, bad_request: 0, other: 0, total: 7 }, rejectedRequests: 4 },
    { model: "claude", rejected: { rate_limit: 0, upstream: 0, auth_quota: 5, bad_request: 0, other: 0, total: 5 }, rejectedRequests: 5 },
  ]);
  const claudeOnly = await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H, models: ["claude"] });
  assert.deepEqual(claudeOnly.map((user) => [user.userId, user.rejected.total]), [[7, 5]]);
  assert.equal((await queryRejectedUsers({ errors, stationId: "own", fromMs: 10 * H, toMs: 12 * H, top: 1 })).length, 1);
  assert.deepEqual(await queryRejectedUsers({ errors, stationId: "nobody", fromMs: 0, toMs: 99 * H }), []);
  assert.ok(!JSON.stringify(all).match(/username|email|name"/), "只有用户 ID");
});
