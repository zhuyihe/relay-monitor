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
  formatRate,
  formatUnitPrice,
  formatUsd,
  formatAsOf,
  formatDayZone,
  formatZonedDate,
  formatZonedDateTime,
  formatZonedRange,
  formatZonedTime,
  formatZonedWindow,
  parseDay,
  refreshFailedText,
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

test("formatRate: 1 美元 = X 元，没设置返回空", () => {
  assert.equal(formatRate(7.2), "1 美元 = 7.20 元");
  assert.equal(formatRate("7.1234"), "1 美元 = 7.1234 元");
  assert.equal(formatRate(1250), "1 美元 = 1250.00 元");
  assert.equal(formatRate(null), "");
  assert.equal(formatRate(0), "");
  assert.equal(formatRate("abc"), "");
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

test("formatZonedTime / formatZonedDate / formatZonedDateTime: 按业务时区写日期和时刻，不补零、不写秒、零点不写 24:00", () => {
  const midnightShanghai = Date.UTC(2026, 9, 6, 16, 0, 0); // 上海 10月7日 0:00
  const now = Date.UTC(2026, 9, 16, 6, 30, 0); // 上海 10月16日 14:30
  assert.equal(formatZonedTime(midnightShanghai), "0:00");
  assert.equal(formatZonedTime(midnightShanghai + 5 * 60_000 + 5_000), "0:05");
  assert.equal(formatZonedTime(now, "Asia/Shanghai"), "14:30");
  assert.equal(formatZonedTime(midnightShanghai, "America/New_York"), "12:00");
  assert.equal(formatZonedDate(midnightShanghai, "Asia/Shanghai", now), "10月7日");
  assert.equal(formatZonedDate(Date.UTC(2025, 9, 9, 4), "Asia/Shanghai", now), "2025年10月9日");
  assert.equal(formatZonedDateTime(midnightShanghai, "Asia/Shanghai", now), "10月7日 0:00");
  assert.equal(formatZonedDateTime(midnightShanghai, "UTC", now), "10月6日 16:00");
  assert.equal(formatZonedDateTime(new Date(midnightShanghai).toISOString(), null, now), "10月7日 0:00");
  for (const bad of [null, undefined, "", "bad"]) {
    assert.equal(formatZonedTime(bad), "—");
    assert.equal(formatZonedDate(bad), "—");
    assert.equal(formatZonedDateTime(bad), "—");
    assert.equal(formatAsOf(bad), "—");
  }
});

test("formatAsOf: 当天只写时刻，不是当天带上日期", () => {
  const now = Date.UTC(2026, 9, 16, 6, 30, 0); // 上海 10月16日 14:30
  assert.equal(formatAsOf(now, "Asia/Shanghai", now), "数据截至 14:30");
  assert.equal(formatAsOf(now - 86_400_000, "Asia/Shanghai", now), "数据截至 10月15日 14:30");
  assert.equal(formatAsOf(Date.UTC(2025, 9, 9, 6, 30), "Asia/Shanghai", now), "数据截至 2025年10月9日 14:30");
});

test("refreshFailedText: 读到过写「刷新失败，数据截至」，从来没读到只写「刷新失败」", () => {
  const now = Date.UTC(2026, 9, 16, 6, 30, 0);
  assert.equal(refreshFailedText(now, "Asia/Shanghai", now), "刷新失败，数据截至 14:30。");
  assert.equal(refreshFailedText(now, "America/New_York", now), "刷新失败，数据截至 2:30。");
  for (const never of [null, undefined, "", "not-a-date"]) assert.equal(refreshFailedText(never), "刷新失败");
});

test("formatZonedRange / formatZonedWindow: 整天只写日期，跨年写年份，不是整天写到时刻", () => {
  const zone = "Asia/Shanghai", now = Date.UTC(2026, 9, 16, 6, 30, 0);
  const day = (y, m, d) => Date.UTC(y, m - 1, d) - 8 * 3_600_000; // 上海当天零点
  assert.equal(formatZonedRange(day(2026, 10, 9), day(2026, 10, 10), zone, now), "10月9日");
  assert.equal(formatZonedRange(day(2026, 10, 1), day(2026, 10, 8), zone, now), "10月1日–10月7日");
  assert.equal(formatZonedRange(day(2026, 10, 16), now, zone, now), "10月16日 0:00–14:30");
  assert.equal(formatZonedRange(day(2026, 10, 8) + 12 * 3_600_000, day(2026, 10, 9), zone, now), "10月8日 12:00–24:00");
  assert.equal(formatZonedRange(day(2026, 10, 8) + 12 * 3_600_000, now, zone, now), "10月8日 12:00–10月16日 14:30");
  assert.equal(formatZonedRange(day(2025, 12, 31), day(2026, 1, 2), zone, now), "2025年12月31日–1月1日");
  assert.equal(formatZonedWindow({ startMs: day(2026, 10, 9), endMs: day(2026, 10, 10), timezone: zone }, now), "10月9日");
  assert.equal(formatZonedWindow({ startMs: day(2026, 10, 9) }), "—");
  assert.equal(formatZonedWindow(null), "—");
  assert.equal(formatZonedRange(day(2026, 10, 10), day(2026, 10, 9), zone, now), "—");
});

test("formatDayZone: 和业务时区相同不写，不同时用白话说按哪里的 0 点算一天，不露时区代码", () => {
  assert.equal(formatDayZone("Asia/Shanghai", "Asia/Shanghai"), "");
  assert.equal(formatDayZone(undefined, "Asia/Shanghai"), "");
  assert.equal(formatDayZone("UTC", "Asia/Shanghai"), "按 UTC 时间算一天");
  assert.equal(formatDayZone("Etc/UTC", "Asia/Shanghai"), "按 UTC 时间算一天");
  assert.equal(formatDayZone("Asia/Shanghai", "UTC"), "按中国标准时间算一天");
  const other = formatDayZone("America/Los_Angeles", "Asia/Shanghai");
  assert.match(other, /^按.+算一天$/);
  assert.doesNotMatch(other, /America|Los_Angeles|\//);
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
