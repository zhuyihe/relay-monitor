import test from "node:test";
import assert from "node:assert/strict";
import { recordRetryFailure, retryBlocked, RETRY_BACKOFF_MIN_MS, RETRY_BACKOFF_MAX_MS } from "./retry-backoff.js";

test("退避：第一次 10 分钟，之后每次翻倍，最多 1 小时；没到时刻就是还在退避，到了就放行", () => {
  const backoff = new Map();
  assert.equal(retryBlocked(backoff, "a", 0), false, "没失败过：不挡");
  const waits = [];
  let at = 1000;
  for (let i = 0; i < 6; i += 1) { waits.push(recordRetryFailure(backoff, "a", at)); at += waits.at(-1); }
  assert.deepEqual(waits, [10, 20, 40, 60, 60, 60].map((minutes) => minutes * 60000));
  assert.equal(RETRY_BACKOFF_MIN_MS, 600000);
  assert.equal(RETRY_BACKOFF_MAX_MS, 3600000);
  const last = backoff.get("a");
  assert.equal(retryBlocked(backoff, "a", last.nextAt - 1), true);
  assert.equal(retryBlocked(backoff, "a", last.nextAt), false);
  assert.equal(retryBlocked(backoff, "b", 0), false, "别的 key 不受影响");
});
