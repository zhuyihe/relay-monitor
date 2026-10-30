import test from "node:test";
import assert from "node:assert/strict";
import { keepOrder } from "./keep-order.js";

test("先别动：hold 时沿用上次顺序，新出现的放最后，没了的去掉；不 hold 用新顺序", () => {
  assert.deepEqual(keepOrder(["a", "b", "c"], ["c", "x", "a", "b"], true), ["a", "b", "c", "x"]);
  assert.deepEqual(keepOrder(["a", "b", "c"], ["c", "a"], true), ["a", "c"]);
  assert.deepEqual(keepOrder(["a", "b", "c"], ["c", "a", "b"], false), ["c", "a", "b"]);
  assert.deepEqual(keepOrder([], ["z", "y"], true), ["z", "y"]);
});
