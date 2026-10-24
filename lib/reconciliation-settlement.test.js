import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECONCILIATION_SETTLE_DELAY_MS, SETTLE_RETRY_STEPS_MS, isSettleableWindow, isSettledAt, settleRetryDelayMs, settlementOutcome,
  settlementPrecheck } from "./reconciliation-settlement.js";

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

test("取数前：读已固定的账只看时间和是不是重结；轮询还要看开始统计和上次结果", () => {
  const rule = { billingPolicy: "immediate", createdAt: iso(START - DAY) };
  const now = DAY_WINDOW.endMs + DELAY;
  assert.deepEqual(settlementPrecheck({ rule, window: DAY_WINDOW, now }), { settleable: true, readSettled: true, due: true });
  assert.deepEqual(settlementPrecheck({ window: DAY_WINDOW, now, resettle: true }), { settleable: true, readSettled: false, due: true });
  assert.deepEqual(settlementPrecheck({ rule, window: DAY_WINDOW, now: now - 1 }), { settleable: false, readSettled: false, due: false });
  // 开始统计在这天结束或以后：不结；在这天里：结
  assert.equal(settlementPrecheck({ rule: { ...rule, createdAt: iso(DAY_WINDOW.endMs) }, window: DAY_WINDOW, now }).due, false);
  assert.equal(settlementPrecheck({ rule: { ...rule, billingEffectiveFrom: DAY_WINDOW.endMs - 1 }, window: DAY_WINDOW, now }).due, true);
  // 旧规则没有开始统计的时刻，按建绑定的时刻
  assert.equal(settlementPrecheck({ rule: { createdAt: iso(DAY_WINDOW.endMs + HOUR) }, window: DAY_WINDOW, now }).due, false);
  assert.equal(settlementPrecheck({ rule: { createdAt: iso(START) }, window: DAY_WINDOW, now }).due, true);
  // 上次结成了、还没到重试时刻：不结；到了：结
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now, attempt: { settled: true, retryAt: null } }).due, false);
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now, attempt: { settled: false, retryAt: now + 1 } }).due, false);
  assert.equal(settlementPrecheck({ rule, window: DAY_WINDOW, now, attempt: { settled: false, retryAt: now } }).due, true);
});

test("取数后：毛利算出来、不是开始统计之前、时间上能结才结；单日记账本，多日写确认快照", () => {
  const result = (window, profitUsd = 1.5, scope = {}) => ({ window, calculation: { profitUsd }, scope });
  const now = TWO_DAYS.endMs + DELAY;
  assert.deepEqual(settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW), now }), { settled: true, ledger: true, confirmedSnapshot: false });
  assert.deepEqual(settlementOutcome({ window: TWO_DAYS, result: result(TWO_DAYS), now }), { settled: true, ledger: false, confirmedSnapshot: true });
  assert.deepEqual(settlementOutcome({ window: DAY_WINDOW, result: result(DAY_WINDOW, 0), now }).settled, true);
  for (const [window, item, at] of [[DAY_WINDOW, result(DAY_WINDOW, null), now], [DAY_WINDOW, result(DAY_WINDOW, 1, { notEffective: true }), now],
    [TWO_DAYS, result(TWO_DAYS), TWO_DAYS.endMs + DELAY - 1], [DAY_WINDOW, null, now]]) {
    assert.deepEqual(settlementOutcome({ window, result: item, now: at }), { settled: false, ledger: false, confirmedSnapshot: false });
  }
});

test("重试间隔：现在只有一档 10 分钟，第几次没成都一样", () => {
  assert.deepEqual(SETTLE_RETRY_STEPS_MS, [10 * 60000]);
  for (const failures of [undefined, 0, 1, 2, 9]) assert.equal(settleRetryDelayMs(failures), 10 * 60000);
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
