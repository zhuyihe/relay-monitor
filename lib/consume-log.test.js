import test from "node:test";
import assert from "node:assert/strict";
import { CONSUME_LOG_KEEP_MS, applyConsumeLogReading, consumeLogOffOverlap, normalizeOffPeriods, parseConsumeLogValue } from "./consume-log.js";

const T = Date.parse("2026-10-20T00:00:00Z");

test("读到关着：没有还关着的段就开一段（从传进来的起点算，不晚于现在）；已经有就不动", () => {
  assert.deepEqual(applyConsumeLogReading([], { state: "off", at: T }, { offFromMs: T - 600000 }), [{ fromMs: T - 600000, toMs: null }]);
  assert.deepEqual(applyConsumeLogReading([], { state: "off", at: T }), [{ fromMs: T, toMs: null }], "没有起点就从读到那一刻");
  assert.deepEqual(applyConsumeLogReading([], { state: "off", at: T }, { offFromMs: T + 5000 }), [{ fromMs: T, toMs: null }], "起点不会晚于现在");
  assert.equal(applyConsumeLogReading([{ fromMs: T - 1000, toMs: null }], { state: "off", at: T + 300000 }, { offFromMs: T }), null, "已经开着一段：不变，不写库");
});

test("读到开着：还关着的那段关上（终点是读到那一刻）；没有就不变", () => {
  assert.deepEqual(applyConsumeLogReading([{ fromMs: T - 1000, toMs: null }], { state: "on", at: T }), [{ fromMs: T - 1000, toMs: T }]);
  assert.equal(applyConsumeLogReading([{ fromMs: T - 9000, toMs: T - 1000 }], { state: "on", at: T }), null);
  assert.equal(applyConsumeLogReading([], { state: "on", at: T }), null);
});

test("只留最近 31 天：终点早于 31 天前的段删掉（顺手在下一次变化时写）", () => {
  const old = { fromMs: T - CONSUME_LOG_KEEP_MS - 9000, toMs: T - CONSUME_LOG_KEEP_MS - 1000 };
  const recent = { fromMs: T - 5000, toMs: T - 1000 };
  assert.deepEqual(applyConsumeLogReading([old, recent], { state: "off", at: T }, { offFromMs: T }), [recent, { fromMs: T, toMs: null }]);
  assert.deepEqual(applyConsumeLogReading([old, recent], { state: "on", at: T }), [recent], "只有旧段要删也算变化");
});

test("窗口碰没碰到关着的段：还关着的算一直关到现在；两端是开区间边界（只挨着不算碰到）", () => {
  const periods = [{ fromMs: 1000, toMs: 2000 }, { fromMs: 5000, toMs: null }];
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 0, endMs: 1000 }), { open: false, closed: false });
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 1999, endMs: 3000 }), { open: false, closed: true });
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 2000, endMs: 5000 }), { open: false, closed: false });
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 4000, endMs: 5001 }), { open: true, closed: false });
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 900000, endMs: 900100 }), { open: true, closed: false }, "还关着：以后的窗口也碰到");
  assert.deepEqual(consumeLogOffOverlap(null, { startMs: 0, endMs: 10 }), { open: false, closed: false });
  // 起点不早于终点（整天都在开始统计之前，裁剪以后是空的）：没有碰到什么，哪怕还关着
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 6000, endMs: 6000 }), { open: false, closed: false });
  assert.deepEqual(consumeLogOffOverlap(periods, { startMs: 9000, endMs: 6000 }), { open: false, closed: false });
});

test("存下来的段：坏的丢掉、排好序；有两段都没结束（数据坏了）前面那段当作在下一段开始时就关了", () => {
  assert.deepEqual(normalizeOffPeriods([{ fromMs: 5, toMs: null }, { fromMs: "x" }, { fromMs: 9, toMs: 3 }, { fromMs: 1, toMs: 2 }, { fromMs: 3, toMs: null }]),
    [{ fromMs: 1, toMs: 2 }, { fromMs: 3, toMs: 5 }, { fromMs: 5, toMs: null }]);
  assert.deepEqual(normalizeOffPeriods("x"), []);
});

test("设置项的值：跟 New API 一样，字符串里只有 \"true\" 算开，其余字符串算关；布尔照字面；缺了是 null", () => {
  assert.deepEqual(["true", true, "false", false, "", "TRUE", "1"].map(parseConsumeLogValue), [true, true, false, false, false, false, false]);
  assert.deepEqual([undefined, null, 1].map(parseConsumeLogValue), [null, null, null]);
});
