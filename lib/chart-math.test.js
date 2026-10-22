import test from "node:test";
import assert from "node:assert/strict";
import { niceTicks, timeAxisTicks } from "./chart-math.js";

test("刻度整齐且不重复：金额只有几分钱时步长至少 0.01", () => {
  assert.deepEqual(niceTicks(0, 100, 4).ticks, [0, 25, 50, 75, 100]);
  const tiny = niceTicks(0, 0.02, 4);
  assert.deepEqual(tiny.ticks, [0, 0.01, 0.02]);
  assert.equal(new Set(tiny.ticks).size, tiny.ticks.length);
  assert.deepEqual(niceTicks(0, 0, 4).ticks, [0, 0.25, 0.5, 0.75, 1]);
});

test("时间横轴刻度按业务时区落点：按小时的落在整除间隔的钟点上（每天都有 0 点），和运行环境的时区无关", () => {
  const at = (iso) => Date.parse(iso);
  // 加尔各答（UTC+5:30），3 天、最多 6 个刻度 → 12 小时一格，落在当地 0 点和 12 点
  const kolkata = timeAxisTicks(at("2026-10-09T10:37:00Z"), at("2026-10-12T10:37:00Z"), 6, "Asia/Kolkata");
  assert.equal(kolkata.daily, false);
  assert.deepEqual(kolkata.ticks, ["2026-10-09T18:30", "2026-10-10T06:30", "2026-10-10T18:30", "2026-10-11T06:30", "2026-10-11T18:30", "2026-10-12T06:30"]
    .map((iso) => at(`${iso}:00Z`)));
  // 洛杉矶夏令时开始那天按小时：拨快跳过的 2 点不重复
  const spring = timeAxisTicks(at("2026-03-08T08:00:00Z"), at("2026-03-08T12:00:00Z"), 6, "America/Los_Angeles");
  assert.deepEqual(spring.ticks, ["08", "09", "10", "11", "12"].map((h) => at(`2026-03-08T${h}:00:00Z`)));
});

test("时间横轴刻度按天、按周：落在业务时区每天的 0 点（跨夏令时也对），从起点之后的第一个 0 点数起", () => {
  const at = (iso) => Date.parse(iso);
  // 洛杉矶 11月1日夏令时结束：0 点前后差 7、8 小时
  const fall = timeAxisTicks(at("2026-10-30T15:00:00Z"), at("2026-11-04T15:00:00Z"), 5, "America/Los_Angeles");
  assert.equal(fall.daily, true);
  assert.deepEqual(fall.ticks, ["2026-10-31T07", "2026-11-01T07", "2026-11-02T08", "2026-11-03T08", "2026-11-04T08"].map((iso) => at(`${iso}:00:00Z`)));
  // 起点正好是 0 点就从它开始
  const start = at("2026-10-09T16:00:00Z");
  assert.deepEqual(timeAxisTicks(start, start + 2 * 86400000, 2, "Asia/Shanghai").ticks, [start, start + 86400000, start + 2 * 86400000]);
  // 60 天、最多 2 个刻度：按整周加大到 35 天一格，第一个刻度是起点之后的第一个 0 点
  const weekly = timeAxisTicks(at("2026-09-01T03:00:00Z"), at("2026-10-31T03:00:00Z"), 2, "Asia/Shanghai");
  assert.deepEqual(weekly.ticks, [at("2026-09-01T16:00:00Z"), at("2026-10-06T16:00:00Z")]);
});

test("重复午夜的日刻度保留首次零点，跳过午夜的小时刻度严格递增", () => {
  const at = Date.parse;
  const fall = timeAxisTicks(at("2026-10-31T12:00:00Z"), at("2026-11-03T12:00:00Z"), 3, "America/Havana");
  assert.equal(fall.daily, true);
  assert.deepEqual(fall.ticks, ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", "2026-11-03T05:00:00Z"].map(at));
  const spring = timeAxisTicks(at("2026-03-08T04:00:00Z"), at("2026-03-08T08:00:00Z"), 6, "America/Havana");
  assert.deepEqual(spring.ticks, ["04", "05", "06", "07", "08"].map((hour) => at(`2026-03-08T${hour}:00:00Z`)));
  assert.ok(spring.ticks.every((tick, i) => i === 0 || tick > spring.ticks[i - 1]));
});
