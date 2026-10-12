import test from "node:test";
import assert from "node:assert/strict";
import {
  MINUS,
  axisMoney,
  formatCompact,
  formatDays,
  formatDeltaPct,
  formatMoney,
  formatPct,
  formatUnitPrice,
  formatUsd,
  parseDay,
  splitTotal,
} from "./format.js";
import { barPath, linePath, niceTicks, runs, spreadLabels, xTickIdx } from "./chart-math.js";

test("formatMoney: 千分位、两位小数、真减号", () => {
  assert.equal(formatMoney(1248.6), "¥1,248.60");
  assert.equal(formatMoney(-203.4), `${MINUS}¥203.40`);
  assert.equal(formatMoney(0), "¥0.00");
  assert.equal(formatMoney(1234567.891), "¥1,234,567.89");
});

test("formatMoney: 估算、符号、精度", () => {
  assert.equal(formatMoney(378.39, { approx: true }), "≈ ¥378.39");
  assert.equal(formatMoney(-5, { approx: true }), `≈ ${MINUS}¥5.00`);
  assert.equal(formatMoney(12.5, { sign: true }), "+¥12.50");
  assert.equal(formatMoney(-12.5, { sign: true }), `${MINUS}¥12.50`);
  assert.equal(formatMoney(2262.4, { dp: 0 }), "¥2,262");
});

test("formatMoney: 空值和四舍五入为零", () => {
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney(undefined), "—");
  assert.equal(formatMoney(Number.NaN), "—");
  assert.equal(formatMoney(-0.001), "¥0.00");
  assert.equal(formatMoney(0.001, { sign: true }), "¥0.00");
});

test("formatMoney: 不用科学计数法", () => {
  assert.equal(formatMoney(1e21, { dp: 0 }).includes("e"), false);
  assert.equal(formatMoney(1e-7), "¥0.00");
});

test("formatUsd / formatUnitPrice", () => {
  assert.equal(formatUsd(1141.1), "$1,141.10");
  assert.equal(formatUnitPrice(0.1234567), "¥0.1235");
  assert.equal(formatUnitPrice(2), "¥2.00");
});

test("axisMoney: 整数与 k", () => {
  assert.equal(axisMoney(0), "¥0");
  assert.equal(axisMoney(800), "¥800");
  assert.equal(axisMoney(1500), "¥1.5k");
  assert.equal(axisMoney(2000), "¥2k");
  assert.equal(axisMoney(12000), "¥12k");
  assert.equal(axisMoney(-500), `${MINUS}¥500`);
});

test("formatPct / formatDeltaPct", () => {
  assert.equal(formatPct(0.3042), "30.4%");
  assert.equal(formatPct(-0.05), `${MINUS}5.0%`);
  assert.equal(formatPct(null), "—");
  assert.equal(formatDeltaPct(0.125), "+12.5%");
  assert.equal(formatDeltaPct(-0.125), `${MINUS}12.5%`);
  assert.equal(formatDeltaPct(0), "0.0%");
});

test("formatDays: 小时与天", () => {
  assert.equal(formatDays(0.42), "约 10 小时");
  assert.equal(formatDays(0.01), "约 1 小时");
  assert.equal(formatDays(4.6), "4.6 天");
  assert.equal(formatDays(null), "无法计算");
});

test("formatCompact", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1500), "1.5K");
  assert.equal(formatCompact(2_000_000), "2M");
  assert.equal(formatCompact(3.25e9), "3.3B");
});

test("parseDay 按本地时区", () => {
  const d = parseDay("2026-09-24");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 24);
  assert.equal(parseDay("bad"), null);
});

test("splitTotal: 分项之和等于总数", () => {
  const parts = splitTotal(100, [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(parts, [33.33, 33.33, 33.34]);
  const sum = splitTotal(830.21, [0.38, 0.262, 0.19, 0.115, 0.053]).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, 830.21);
});

test("niceTicks: 覆盖区间且步长整齐", () => {
  const t = niceTicks(0, 1780, 4);
  assert.equal(t.lo, 0);
  assert.ok(t.hi >= 1780);
  assert.deepEqual(t.ticks, [0, 500, 1000, 1500, 2000]);
  const neg = niceTicks(-120, 600, 3);
  assert.ok(neg.lo <= -120 && neg.ticks.includes(0));
  assert.deepEqual(niceTicks(5, 5, 3).ticks.length > 1, true);
});

test("linePath: 空值断线", () => {
  const d = linePath([1, 2, null, 4], (i) => i * 10, (v) => v);
  assert.equal(d, "M0.0,1.0L10.0,2.0M30.0,4.0");
});

test("barPath: 高度为 0 时圆角收为 0", () => {
  assert.equal(barPath(0, 10, 10, 8, 4, true), "M0,10V10A0,0 0 0 1 0,10H8A0,0 0 0 1 8,10V10Z");
});

test("xTickIdx: 超过两周按整周取", () => {
  const idx = xTickIdx(30, 400);
  assert.equal(idx[0], 29);
  assert.equal((idx[0] - idx[1]) % 7, 0);
  assert.deepEqual(xTickIdx(7, 800), [6, 5, 4, 3, 2, 1, 0]);
});

test("runs / spreadLabels", () => {
  assert.deepEqual(runs([false, true, true, false, true]), [[1, 2], [4, 4]]);
  const out = spreadLabels([{ name: "a", y: 100 }, { name: "b", y: 105 }]);
  assert.equal(out[1].y, 115);
});

test("axisMoney: 刻度间距小于 1 时保留小数", () => {
  assert.equal(axisMoney(0.5, 0.25), "¥0.50");
  assert.equal(axisMoney(0.75, 0.25), "¥0.75");
  assert.equal(axisMoney(0.4, 0.2), "¥0.4");
  assert.equal(axisMoney(7.5, 2.5), "¥7.5");
  assert.equal(axisMoney(20, 10), "¥20");
});
