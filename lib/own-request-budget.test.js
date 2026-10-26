import test from "node:test";
import assert from "node:assert/strict";
import { INGEST_BUDGET_SHARE, INGEST_RESERVE, OWN_RATE_LIMIT, OWN_RATE_WINDOW_MS, SLOW_MS, SLOW_STREAK_TO_TRIP, ingestAllowance, noteOwnRequest, ownRequestState, resetOwnRequestBudget } from "./own-request-budget.js";

const SITE = "https://own.test/api/log/?p=1";
const T = Date.parse("2026-10-26T00:00:00Z");

test("额度：最近 180 秒这个站点发了多少都记着，整站读只用一份，剩给别人的不到 INGEST_RESERVE 就不读；过了 180 秒的不算", () => {
  resetOwnRequestBudget();
  assert.deepEqual(ingestAllowance(SITE, { now: T }), { allowed: Math.floor(OWN_RATE_LIMIT * INGEST_BUDGET_SHARE), reason: null, used: 0 });
  for (let i = 0; i < OWN_RATE_LIMIT - INGEST_RESERVE - 3; i += 1) noteOwnRequest(SITE, { status: 200, elapsedMs: 50, now: T + i });
  assert.deepEqual(ingestAllowance(SITE, { now: T + 1000 }).allowed, 3, "只剩 3 个给整站读");
  for (let i = 0; i < 3; i += 1) noteOwnRequest(SITE, { status: 200, elapsedMs: 50, now: T + 2000 });
  assert.deepEqual(ingestAllowance(SITE, { now: T + 3000 }), { allowed: 0, reason: "budget", used: OWN_RATE_LIMIT - INGEST_RESERVE });
  assert.equal(ingestAllowance(SITE, { now: T + OWN_RATE_WINDOW_MS + 3000 }).allowed, Math.floor(OWN_RATE_LIMIT * INGEST_BUDGET_SHARE), "180 秒后额度回来");
  assert.equal(ingestAllowance("https://other.test/x", { now: T + 3000 }).allowed, Math.floor(OWN_RATE_LIMIT * INGEST_BUDGET_SHARE), "别的站点各算各的");
});

test("断路：429、5xx、连不上（status 0）立刻断开，断开时间指数增长（1、2、4、8、16 分钟），期间整站读一个都不发；正常响应慢慢降级", () => {
  resetOwnRequestBudget();
  noteOwnRequest(SITE, { status: 429, elapsedMs: 10, now: T });
  assert.deepEqual([ingestAllowance(SITE, { now: T + 1000 }).reason, ownRequestState(SITE, T + 1000).breakUntil], ["break", T + 60000]);
  assert.equal(ingestAllowance(SITE, { now: T + 61000 }).reason, null, "1 分钟后恢复");
  noteOwnRequest(SITE, { status: 503, elapsedMs: 10, now: T + 61000 });
  assert.equal(ownRequestState(SITE, T + 61000).breakUntil, T + 61000 + 120000, "第二次断 2 分钟");
  noteOwnRequest(SITE, { status: 0, elapsedMs: 25000, now: T + 200000 });
  assert.equal(ownRequestState(SITE, T + 200000).breakUntil, T + 200000 + 240000, "第三次断 4 分钟");
  for (let i = 0; i < 2; i += 1) noteOwnRequest(SITE, { status: 500, elapsedMs: 10, now: T + 500000 + i });
  assert.equal(ownRequestState(SITE, T + 500001).breakUntil, T + 500001 + 960000, "最长 16 分钟");
});

test("慢响应：连着 3 次超过 2 秒才断路，中间来一次快的就重数", () => {
  resetOwnRequestBudget();
  noteOwnRequest(SITE, { status: 200, elapsedMs: SLOW_MS + 1, now: T });
  noteOwnRequest(SITE, { status: 200, elapsedMs: SLOW_MS + 1, now: T + 1 });
  noteOwnRequest(SITE, { status: 200, elapsedMs: 100, now: T + 2 });
  noteOwnRequest(SITE, { status: 200, elapsedMs: SLOW_MS + 1, now: T + 3 });
  assert.equal(ownRequestState(SITE, T + 4).broken, false);
  for (let i = 0; i < SLOW_STREAK_TO_TRIP - 1; i += 1) noteOwnRequest(SITE, { status: 200, elapsedMs: SLOW_MS, now: T + 10 + i });
  assert.equal(ownRequestState(SITE, T + 20).broken, true, "连着 3 次慢就断");
});
