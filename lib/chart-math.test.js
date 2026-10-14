import test from "node:test";
import assert from "node:assert/strict";
import { niceTicks } from "./chart-math.js";

test("刻度整齐且不重复：金额只有几分钱时步长至少 0.01", () => {
  assert.deepEqual(niceTicks(0, 100, 4).ticks, [0, 25, 50, 75, 100]);
  const tiny = niceTicks(0, 0.02, 4);
  assert.deepEqual(tiny.ticks, [0, 0.01, 0.02]);
  assert.equal(new Set(tiny.ticks).size, tiny.ticks.length);
  assert.deepEqual(niceTicks(0, 0, 4).ticks, [0, 0.25, 0.5, 0.75, 1]);
});
