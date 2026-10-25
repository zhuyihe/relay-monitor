import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECONCILIATION_SETTLE_DELAY_MS, SETTLE_LOOKBACK_MS, SETTLE_MANUAL_RECHECK_MS, SETTLE_MAX_AUTO_ATTEMPTS, SETTLE_RETRY_STEPS_MS,
  isSettleableWindow, isSettledAt, isWithinAutoRetry, reasonKindOf, settleRetryDelayMs, settlementOutcome, settlementPrecheck } from "./reconciliation-settlement.js";
import { RECONCILIATION_ISSUE_CODES, reconciliationIssue } from "./reconciliation-contract.js";
import { RECONCILIATION_READING_GRACE_MS } from "./reconciliation-view.js";

const DAY = 86400000, HOUR = 3600000, DELAY = RECONCILIATION_SETTLE_DELAY_MS;
const START = Date.UTC(2026, 9, 8, 16); // 上海 2026-10-09 00:00
const DAY_WINDOW = { startMs: START, endMs: START + DAY, timezone: "Asia/Shanghai" };
const TWO_DAYS = { ...DAY_WINDOW, endMs: START + 2 * DAY };
const iso = (ms) => new Date(ms).toISOString();

test("时间上能不能结：两端都是 0 点、结束满 15 分钟；单日、多日一样", () => {
  assert.equal(DELAY, 15 * 60000);
  for (const window of [DAY_WINDOW, TWO_DAYS]) {
    assert.equal(isSettleableWindow(window, window.endMs + DELAY - 1), false);
    assert.equal(isSettleableWindow(window, window.endMs + DELAY), true);
  }
  assert.equal(isSettleableWindow({ ...DAY_WINDOW, startMs: START + HOUR }, START + 2 * DAY), false);
  assert.equal(isSettleableWindow({ startMs: START, endMs: START + DAY }, START + 2 * DAY), false, "没写时区不算");
});

test("旧确认记录算不算结账：生成在结束满等待期以后；没有生成时刻时按传进来的时刻，再没有就不算", () => {
  for (const window of [DAY_WINDOW, TWO_DAYS]) {
    assert.equal(isSettledAt(window, iso(window.endMs + DELAY - 1)), false);
    assert.equal(isSettledAt(window, iso(window.endMs + DELAY)), true);
    assert.equal(isSettledAt(window, null), false);
    assert.equal(isSettledAt(window, "x", window.endMs + DELAY), true);
    assert.equal(isSettledAt(window, undefined, window.endMs), false);
  }
});

test("取数前：读已固定的账只看时间和是不是重结；轮询还要看开始统计", () => {
  const rule = { billingPolicy: "immediate", createdAt: iso(START - DAY) };
  const now = DAY_WINDOW.endMs + DELAY;
  assert.deepEqual(settlementPrecheck({ rule, window: DAY_WINDOW, now }), { settleable: true, readSettled: true, due: true, action: "due" });
  assert.deepEqual(settlementPrecheck({ window: DAY_WINDOW, now, resettle: true }), { settleable: true, readSettled: false, due: true, action: "due" });
  assert.deepEqual(settlementPrecheck({ rule, window: DAY_WINDOW, now: now - 1 }), { settleable: false, readSettled: false, due: false, action: "not_settleable" });
  // 开始统计在这天结束或以后：不结；在这天里：结
  assert.equal(settlementPrecheck({ rule: { ...rule, createdAt: iso(DAY_WINDOW.endMs) }, window: DAY_WINDOW, now }).action, "not_effective");
  assert.equal(settlementPrecheck({ rule: { ...rule, billingEffectiveFrom: DAY_WINDOW.endMs - 1 }, window: DAY_WINDOW, now }).due, true);
  // 旧规则没有开始统计的时刻，按建绑定的时刻
  assert.equal(settlementPrecheck({ rule: { createdAt: iso(DAY_WINDOW.endMs + HOUR) }, window: DAY_WINDOW, now }).due, false);
  assert.equal(settlementPrecheck({ rule: { createdAt: iso(START) }, window: DAY_WINDOW, now }).due, true);
});

test("取数前：状态表那一行——账本有这天、退避、要人处理、7 天、保险值、重结请求；手动只看时间和开始统计", () => {
  const rule = { billingPolicy: "immediate", createdAt: iso(START - DAY) };
  const now = DAY_WINDOW.endMs + DELAY;
  const check = (extra) => settlementPrecheck({ rule, window: DAY_WINDOW, now, ...extra }).action;
  assert.equal(check({ ledgerHasDay: true }), "settled", "账本里已经有这天");
  assert.equal(check({ ledgerHasDay: true, state: { resettleRequestedAt: now - HOUR } }), "due", "有重结请求照样去结");
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now, state: { resettleRequestedAt: now } }).readSettled, false, "有请求时不读已固定的账");
  assert.equal(check({ state: { retryReason: "PENDING", attempts: 1, nextAttemptAt: now + 1 } }), "backoff");
  assert.equal(check({ state: { retryReason: "PENDING", attempts: 1, nextAttemptAt: now } }), "due");
  assert.equal(check({ state: { retryReason: "PENDING", attempts: SETTLE_MAX_AUTO_ATTEMPTS, nextAttemptAt: now } }), "exhausted");
  const manual = { manualReason: "KEY_INVALID_OR_DENIED", manualSince: now - HOUR, nextAttemptAt: now + 1, sourceVersion: "v1" };
  assert.equal(check({ state: manual, sourceVersion: "v1" }), "manual", "要人处理、没到重判的时刻：不发请求");
  assert.equal(check({ state: manual, sourceVersion: "v2" }), "due", "配置变了马上重判");
  assert.equal(check({ state: { ...manual, nextAttemptAt: now } }), "due", "满 10 分钟重判");
  // 7 天：结束满 7 天自动不再试；重结请求按请求的时刻算 7 天
  const late = DAY_WINDOW.endMs + SETTLE_LOOKBACK_MS;
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now: late - 1 }).action, "due");
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now: late }).action, "beyond_lookback");
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now: late, state: { resettleRequestedAt: late - DAY } }).action, "due");
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now: late, state: { resettleRequestedAt: late - SETTLE_LOOKBACK_MS } }).action, "beyond_lookback");
  // 手动：不看退避、要人处理、7 天、账本
  for (const state of [{ retryReason: "PENDING", attempts: 1, nextAttemptAt: late + DAY }, manual, { retryReason: "PENDING", attempts: SETTLE_MAX_AUTO_ATTEMPTS }]) {
    assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now: late, state, origin: "manual", ledgerHasDay: true }).action, "due");
  }
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now: now - 1, origin: "manual" }).action, "not_settleable");
  assert.equal(isWithinAutoRetry(DAY_WINDOW, late - 1), true);
  assert.equal(isWithinAutoRetry(DAY_WINDOW, late), false);
});

test("页面「过了 7 天还没读到」和自动回看是同一个数，只定义一次", () => {
  assert.equal(RECONCILIATION_READING_GRACE_MS, SETTLE_LOOKBACK_MS);
  assert.equal(SETTLE_LOOKBACK_MS, 7 * DAY);
});

test("原因归类只看 contract 的 kind：读取类会自己好，要人处理的、认不出的码不自动试；现在还没有不会自己消失的码", () => {
  for (const code of RECONCILIATION_ISSUE_CODES) {
    const issue = reconciliationIssue(code);
    assert.equal(reasonKindOf(code), issue.persists === true ? "sticky" : issue.kind === "reading" ? "retry" : "manual", code);
  }
  assert.equal(reasonKindOf("PENDING"), "retry");
  assert.equal(reasonKindOf("UPSTREAM_DATA_UNAVAILABLE"), "retry");
  assert.equal(reasonKindOf("KEY_INVALID_OR_DENIED"), "manual");
  assert.equal(reasonKindOf("NO_SUCH_CODE"), "manual", "认不出的码按要人处理");
  assert.equal(reasonKindOf("toString"), "manual");
  assert.deepEqual(RECONCILIATION_ISSUE_CODES.filter((code) => reasonKindOf(code) === "sticky"), [], "R2 才加第一个");
});

test("取数后：毛利算出来、不是开始统计之前、时间上能结才结；单日记账本，多日写确认快照；状态表那一行跟着走", () => {
  const result = (window, profitUsd = 1.5, scope = {}, code = "READY") => ({ window, calculation: { profitUsd }, scope, health: { code, issues: [{ code, side: "upstream" }] } });
  const now = TWO_DAYS.endMs + DELAY;
  assert.deepEqual(settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW), now }), { settled: true, ledger: true, confirmedSnapshot: false, state: { op: "delete" } });
  assert.deepEqual(settlementOutcome({ window: TWO_DAYS, result: result(TWO_DAYS), now }), { settled: true, ledger: false, confirmedSnapshot: true, state: null });
  assert.equal(settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, 0), now }).settled, true);
  for (const [window, item, at] of [[DAY_WINDOW, result(DAY_WINDOW, 1, { notEffective: true }), now],
    [TWO_DAYS, result(TWO_DAYS), TWO_DAYS.endMs + DELAY - 1], [TWO_DAYS, result(TWO_DAYS, null, {}, "PENDING"), now]]) {
    assert.deepEqual(settlementOutcome({ window, result: item, now: at }), { settled: false, ledger: false, confirmedSnapshot: false, state: null });
  }
  // 读取类：attempts + 1，下次按退避表（这天结束已经超过 6 小时）
  const retry = settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, null, {}, "PENDING"), now, sourceVersion: "v1" }).state;
  assert.deepEqual(retry, { op: "retry", reason: "PENDING", sourceVersion: "v1", lastAttemptAt: now, firstFailedAt: now,
    detail: { code: "PENDING", side: "upstream" }, attempts: 1, nextAttemptAt: now + SETTLE_RETRY_STEPS_MS[0] });
  const second = settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, null, {}, "PENDING"), now, state: { ...retry, firstFailedAt: now - HOUR } }).state;
  assert.deepEqual([second.attempts, second.nextAttemptAt - now, second.firstFailedAt], [2, SETTLE_RETRY_STEPS_MS[1], now - HOUR]);
  // 手动结不成：只更新原因，不推后自动的退避，也不计入 attempts
  const manualTry = settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, null, {}, "PENDING"), now, state: second, origin: "manual" }).state;
  assert.deepEqual([manualTry.attempts, manualTry.nextAttemptAt], [2, second.nextAttemptAt]);
  // 要人处理：记下变成需处理的时刻，10 分钟后本地重判；已经是需处理的，时刻不变
  const manual = settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, null, {}, "KEY_INVALID_OR_DENIED"), now }).state;
  assert.deepEqual([manual.op, manual.reason, manual.manualSince, manual.nextAttemptAt], ["manual", "KEY_INVALID_OR_DENIED", now, now + SETTLE_MANUAL_RECHECK_MS]);
  const again = settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, null, {}, "KEY_INVALID_OR_DENIED"), now: now + HOUR,
    state: { ...manual, manualReason: "KEY_INVALID_OR_DENIED" } }).state;
  assert.equal(again.manualSince, now);
  // 没有 health 的坏结果按认不出的码，要人处理
  assert.equal(settlementOutcome({ window: DAY_WINDOW, result: { calculation: { profitUsd: null } }, now }).state.op, "manual");
});

test("重试间隔：结束后头 6 小时每 10 分钟；之后按 10 分、30 分、2 时、6 时，超出的按 6 时", () => {
  assert.deepEqual(SETTLE_RETRY_STEPS_MS, [10 * 60000, 30 * 60000, 2 * HOUR, 6 * HOUR]);
  const window = DAY_WINDOW;
  for (const failures of [1, 2, 5, 9]) assert.equal(settleRetryDelayMs(failures, { window, now: window.endMs + 6 * HOUR - 1 }), 10 * 60000, "头 6 小时");
  const later = window.endMs + 6 * HOUR;
  assert.deepEqual([undefined, 0, 1, 2, 3, 4, 9].map((failures) => settleRetryDelayMs(failures, { window, now: later })),
    [10 * 60000, 10 * 60000, 10 * 60000, 30 * 60000, 2 * HOUR, 6 * HOUR, 6 * HOUR]);
  // 7 天里自动试的次数（按退避表推）：昨天约 66 次；上线时积压、第一次试就已经过了一天的日子约 27 次，都在保险值以内
  const count = (from) => { let at = from, failures = 0; while (at - window.endMs < SETTLE_LOOKBACK_MS) { failures += 1; at += settleRetryDelayMs(failures, { window, now: at }); } return failures; };
  const yesterday = count(window.endMs + DELAY), older = count(window.endMs + DAY);
  assert.ok(yesterday >= 60 && yesterday <= 70 && yesterday < SETTLE_MAX_AUTO_ATTEMPTS, String(yesterday));
  assert.ok(older >= 24 && older <= 32, String(older));
});

test("结算模块页面也能引用：整条导入链里没有 node: 模块", () => {
  const here = dirname(fileURLToPath(import.meta.url)), seen = new Set(), builtins = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // from "x"、from 'x'、只引不取的 import "x"、动态 import("x") 都认
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      if (spec.startsWith(".")) visit(join(dirname(file), spec));
      else builtins.push(`${file.slice(here.length + 1)} → ${spec}`);
    }
  };
  visit(join(here, "reconciliation-settlement.js"));
  assert.ok(seen.size >= 3, [...seen].join("\n"));
  assert.deepEqual(builtins, [], "结算模块的导入链只能引 lib 里的文件");
});
