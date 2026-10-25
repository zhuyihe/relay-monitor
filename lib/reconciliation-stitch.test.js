import test from "node:test";
import assert from "node:assert/strict";
import { splitWindowByDays, stitchChannelRevenue } from "./reconciliation-stitch.js";

const TZ = "Asia/Shanghai";
const DAY = 86400000;
const day0 = Date.parse("2026-10-06T16:00:00Z"); // 上海 10-07 0 点

test("多天窗口按自然日切块：整天一块，头尾不满一天的各一块", () => {
  const pieces = splitWindowByDays({ startMs: day0, endMs: day0 + 3 * DAY, timezone: TZ });
  assert.deepEqual(pieces.map((p) => [p.startMs, p.endMs, p.wholeDay]), [[day0, day0 + DAY, true], [day0 + DAY, day0 + 2 * DAY, true], [day0 + 2 * DAY, day0 + 3 * DAY, true]]);
  const edges = splitWindowByDays({ startMs: day0 + 6 * 3600000, endMs: day0 + 2 * DAY + 3600000, timezone: TZ });
  assert.deepEqual(edges.map((p) => [p.startMs - day0, p.endMs - day0, p.wholeDay]), [[6 * 3600000, DAY, false], [DAY, 2 * DAY, true], [2 * DAY, 2 * DAY + 3600000, false]]);
  assert.equal(splitWindowByDays({ startMs: day0, endMs: day0 + 1000, timezone: TZ }).length, 1, "一天以内就一块");
  assert.deepEqual(splitWindowByDays({ startMs: day0, endMs: day0, timezone: TZ }), []);
  assert.deepEqual(splitWindowByDays({ startMs: day0, endMs: day0 + DAY }), [], "没写时区不切");
});

test("夏令时那天是 25 小时：照自然日切，不按 24 小时", () => {
  const la = "America/Los_Angeles";
  const start = Date.parse("2026-11-01T07:00:00Z"); // 洛杉矶 11-01 0 点（夏令时结束那天，当天 25 小时）
  const pieces = splitWindowByDays({ startMs: start, endMs: start + 25 * 3600000 + DAY, timezone: la });
  assert.deepEqual(pieces.map((p) => (p.endMs - p.startMs) / 3600000), [25, 24]);
  assert.ok(pieces.every((p) => p.wholeDay));
});

const row = (channelId, quotaUnits, amountUsd, extra = {}) => ({ channelId, billingState: "complete", quotaUnits, amountUsd, adminUsageQuotaUnits: 0, adminUsageAmountUsd: 0, ...extra });

test("几块的收入逐渠道相加，管理员自用也加起来", () => {
  const merged = stitchChannelRevenue([
    { quotaPerUnit: 100, channels: [row(1, 100, 1, { adminUsageQuotaUnits: 10, adminUsageAmountUsd: 0.1 }), row(2, 50, 0.5)], adminUsageQuotaUnits: 10, adminUsageAmountUsd: 0.1 },
    { quotaPerUnit: 200, channels: [row(1, 400, 2), row(2, 0, 0)], adminUsageQuotaUnits: 0, adminUsageAmountUsd: 0 },
  ], [1, 2]);
  assert.deepEqual(merged.channels.map((c) => [c.channelId, c.quotaUnits, c.amountUsd, c.adminUsageAmountUsd]), [[1, 500, 3, 0.1], [2, 50, 0.5, 0]]);
  assert.deepEqual([merged.quotaUnits, merged.amountUsd, merged.state, merged.successfulCount, merged.expectedCount, merged.adminUsageAmountUsd, merged.quotaPerUnit], [550, 3.5, "complete", 2, 2, 0.1, 100],
    "每块的金额按它自己的换算已经是美元，直接加；换算不同也不重算");
});

test("有一块这个渠道没读全：这个渠道就是没读全，不拿读到的几块当整段；R1 以前固定的日子没有管理员自用，当 0", () => {
  const merged = stitchChannelRevenue([
    { quotaPerUnit: 100, channels: [row(1, 100, 1), row(2, 50, 0.5)] },
    { quotaPerUnit: 100, channels: [row(1, 100, 1), { channelId: 2, billingState: "unavailable", quotaUnits: null, amountUsd: null }] },
  ], [1, 2]);
  assert.deepEqual(merged.channels.map((c) => [c.channelId, c.billingState, c.amountUsd]), [[1, "complete", 2], [2, "partial", null]]);
  assert.deepEqual([merged.state, merged.amountUsd, merged.knownAmountUsd, merged.quotaUnits], ["partial", null, 2, 200]);
  assert.equal(merged.adminUsageAmountUsd, 0, "两块都没写管理员自用（undefined）：当 0");
  // 现读时换算读不到（null）：整个读不到，不当 0
  const unknown = stitchChannelRevenue([{ quotaPerUnit: 100, channels: [row(1, 1, 0.01)], adminUsageAmountUsd: null }], [1]);
  assert.equal(unknown.adminUsageAmountUsd, null);
  // 渠道一块都没有
  assert.deepEqual(stitchChannelRevenue([{ quotaPerUnit: 100, channels: [] }], [1]).channels.map((c) => c.billingState), ["unavailable"]);
  assert.equal(stitchChannelRevenue([], [1]).state, "unavailable");
});

test("管理员自用扣没扣：有 R1 以前固定的块（undefined）标 undeducted，adminUsageFromMs 是第一块扣过的开始时刻；都扣了没有 undeducted；都没扣 FromMs 是 null", () => {
  const deducted = (startMs, extra = {}) => ({ startMs, quotaPerUnit: 500000, channels: [row(1, 100, 1)], adminUsageQuotaUnits: 0, adminUsageAmountUsd: 0, ...extra });
  const old = (startMs) => ({ startMs, quotaPerUnit: 500000, channels: [{ ...row(1, 100, 1), adminUsageQuotaUnits: undefined, adminUsageAmountUsd: undefined }] });
  const mixed = stitchChannelRevenue([old(day0), old(day0 + DAY), deducted(day0 + 2 * DAY)], [1]);
  assert.deepEqual([mixed.adminUsageUndeducted, mixed.adminUsageFromMs], [true, day0 + 2 * DAY]);
  const all = stitchChannelRevenue([deducted(day0), deducted(day0 + DAY)], [1]);
  assert.deepEqual([all.adminUsageUndeducted, all.adminUsageFromMs], [false, day0]);
  const none = stitchChannelRevenue([old(day0), old(day0 + DAY)], [1]);
  assert.deepEqual([none.adminUsageUndeducted, none.adminUsageFromMs], [true, null]);
});
