import test from "node:test";
import assert from "node:assert/strict";
import { presetTimeRange } from "./time-range.js";
import { resolveBusinessWindow } from "./business-time.js";

test("共用日期预览与自营业务的自然日范围相同；24 小时保留滚动窗口", () => {
  const now = Date.parse("2026-11-22T10:00:00Z"), tz = "Asia/Shanghai";
  for (const preset of ["today", "7d", "30d"]) {
    const actual = presetTimeRange(preset, { now, tz }), query = resolveBusinessWindow(preset, now, tz);
    assert.deepEqual(actual, { startMs: query.startMs, endMs: query.now });
  }
  assert.deepEqual(presetTimeRange("24h", { now, tz }), { startMs: now - 86400000, endMs: now });
  assert.equal(new Date(presetTimeRange("month", { now, tz }).startMs).toISOString(), "2026-10-31T16:00:00.000Z");
});

test("昨日按业务时区处理夏令时；开始算以来保留核算起点", () => {
  const now = Date.parse("2026-03-09T16:00:00Z"), tz = "America/New_York";
  const yesterday = presetTimeRange("yesterday", { now, tz });
  assert.deepEqual(yesterday, { startMs: Date.parse("2026-03-08T05:00:00Z"), endMs: Date.parse("2026-03-09T04:00:00Z") });
  const sinceMs = Date.parse("2025-10-01T00:00:00Z");
  assert.deepEqual(presetTimeRange("since", { now, tz, sinceMs }), { startMs: sinceMs, endMs: now });
});
