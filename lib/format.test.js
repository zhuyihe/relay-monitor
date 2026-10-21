import test from "node:test";
import assert from "node:assert/strict";
import {
  BALANCE_STATE_TEXT,
  COST_MODE_TEXT,
  EMPTY,
  MINUS,
  RANGE_TEXT,
  SELL_PRICE_UNSET,
  axisMoney,
  basisText,
  formatCompact,
  formatDayKey,
  formatDays,
  formatSinceToday,
  soonText,
  formatDeltaPct,
  formatMoney,
  formatPct,
  formatRate,
  formatSellPrice,
  formatUnitPrice,
  formatUsd,
  formatAsOf,
  formatAsOfTime,
  NO_SPEND_TEXT,
  formatDayZone,
  formatZonedDate,
  formatZonedDateTime,
  formatZonedRange,
  formatZonedTime,
  formatZonedWindow,
  parseDay,
  refreshFailedText,
  splitTotal,
  weekdayOfDayKey,
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

test("soonText: 快用完那一句带上可用天数", () => {
  assert.equal(soonText(2.6), "快用完，可用约 3 天");
  assert.equal(soonText(0.2), "快用完，可用约 5 小时");
});

test("formatDays: 1 天以上四舍五入到整天，不到 1 天按小时，不到 1 小时、算不出各有写法", () => {
  assert.equal(formatDays(4.6), "约 5 天");
  assert.equal(formatDays(4.4), "约 4 天");
  assert.equal(formatDays(1), "约 1 天");
  assert.equal(formatDays(1234.4), "约 1,234 天");
  assert.equal(formatDays(0.42), "约 10 小时");
  assert.equal(formatDays(0.99), "约 1 天");
  assert.equal(formatDays(1 / 24), "约 1 小时");
  assert.equal(formatDays(0.01), "不到 1 小时");
  assert.equal(formatDays(0), "不到 1 小时");
  assert.equal(formatDays(-2), "不到 1 小时");
  assert.equal(formatDays(null), "—");
  assert.equal(formatDays(undefined), "—");
  assert.equal(formatDays("abc"), "—");
  // 近期没有花费（可用天数是 Infinity）
  assert.equal(formatDays(Infinity), NO_SPEND_TEXT);
  assert.equal(NO_SPEND_TEXT, "近期没有花费");
  assert.equal(formatDays(-Infinity), "—");
});

test("formatCompact: 一万以上用万、亿，最多一位小数", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(9999), "9,999");
  assert.equal(formatCompact(9999.6), "1 万");
  assert.equal(formatCompact(12_345), "1.2 万");
  assert.equal(formatCompact(2_000_000), "200 万");
  assert.equal(formatCompact(99_950_000), "9,995 万");
  assert.equal(formatCompact(99_999_600), "1 亿");
  assert.equal(formatCompact(3.25e9), "32.5 亿");
  assert.equal(formatCompact(1.2e12), "12,000 亿");
  assert.equal(formatCompact(-15_000), "−1.5 万");
  assert.equal(formatCompact(-0.2), "0");
  assert.equal(formatCompact(null), "—");
});

test("BALANCE_STATE_TEXT / COST_MODE_TEXT / RANGE_TEXT: 规范里的叫法", () => {
  assert.deepEqual({ ...BALANCE_STATE_TEXT }, { empty: "余额用完", low: "余额偏低", soon: "快用完", pending: "还没读取", unreadable: "读不到余额" });
  assert.deepEqual({ ...COST_MODE_TEXT }, { usage: "按用量算", history: "按余额变化估算", fixed: "固定成本" });
  assert.deepEqual({ ...RANGE_TEXT }, { today: "今天", "7d": "近 7 天", "30d": "近 30 天", "90d": "近 90 天" });
});

test("basisText: 近 N 小时按小时写，其余写按近期花费走势估算", () => {
  assert.equal(basisText("近3小时"), "按近 3 小时的花费估算");
  assert.equal(basisText("近12小时"), "按近 12 小时的花费估算");
  assert.equal(basisText("回归"), "按近期花费走势估算");
  assert.equal(basisText(""), "按近期花费走势估算");
  assert.equal(basisText(undefined), "按近期花费走势估算");
});

test("formatSellPrice: 和汇率同一种数字写法，说的是 1 美元额度", () => {
  assert.equal(formatSellPrice(7.5), "1 美元额度 = 7.50 元");
  assert.equal(formatSellPrice("7.1234"), "1 美元额度 = 7.1234 元");
  assert.equal(formatSellPrice(null), "");
  assert.equal(formatSellPrice(0), "");
  assert.equal(SELL_PRICE_UNSET, "没设置售价，暂按 1 美元额度 = 1 元算");
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
  // 表格列名已经叫「数据截至」时，格子里只放后面那段
  assert.equal(formatAsOfTime(now, "Asia/Shanghai", now), "14:30");
  assert.equal(formatAsOfTime(now - 86_400_000, "Asia/Shanghai", now), "10月15日 14:30");
  assert.equal(formatAsOfTime(null, "Asia/Shanghai", now), "—");
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

test("formatDayKey: 接口按天给的日期今年写「10月9日」，往年带年份，不按时区再换算；认不出的写「—」", () => {
  const now = Date.parse("2026-10-21T02:00:00Z");
  assert.equal(formatDayKey("2026-10-09", "Asia/Shanghai", now), "10月9日");
  assert.equal(formatDayKey("2025-10-09", "Asia/Shanghai", now), "2025年10月9日");
  // 没传时区按业务时区判断「今年」
  assert.equal(formatDayKey("2026-01-01", undefined, now), "1月1日");
  for (const bad of [null, undefined, "", "2026-1-9", "2026-10-09T00:00:00Z", 20261009]) assert.equal(formatDayKey(bad, "Asia/Shanghai", now), EMPTY);
  // 「今年」按传进来的时区算：UTC 12月31日 20:00 在上海已经是 2027 年
  const newYear = Date.parse("2026-12-31T20:00:00Z");
  assert.equal(formatDayKey("2026-12-31", "Asia/Shanghai", newYear), "2026年12月31日");
  assert.equal(formatDayKey("2026-12-31", "UTC", newYear), "12月31日");
});

test("weekdayOfDayKey: 日历日是周几，与浏览器时区无关（含夏令时切换那天）", () => {
  assert.equal(weekdayOfDayKey("2026-10-09"), "周五");
  assert.equal(weekdayOfDayKey("2026-10-12"), "周一");
  assert.equal(weekdayOfDayKey("2026-03-08"), "周日");
  assert.equal(weekdayOfDayKey(""), "");
  assert.equal(weekdayOfDayKey(null), "");
});

test("formatSinceToday: 从今天 0 点起写「0:00–现在」，更早写「某天–今天」，按业务时区判断今天", () => {
  const now = Date.parse("2026-10-21T06:30:00Z"); // 上海 14:30
  assert.equal(formatSinceToday(Date.parse("2026-10-20T16:00:00Z"), "Asia/Shanghai", now), "0:00–14:30");
  assert.equal(formatSinceToday(Date.parse("2026-10-13T16:00:00Z"), "Asia/Shanghai", now), "10月14日–今天");
  assert.equal(formatSinceToday(Date.parse("2025-11-30T16:00:00Z"), "Asia/Shanghai", now), "2025年12月1日–今天");
  // 同一刻在 UTC 还是 10月20日：上海的今天 0 点在 UTC 是「昨天」
  assert.equal(formatSinceToday(Date.parse("2026-10-20T16:00:00Z"), "UTC", now), "10月20日–今天");
  assert.equal(formatSinceToday(null, "Asia/Shanghai", now), EMPTY);
  assert.equal(formatSinceToday("bad", "Asia/Shanghai", now), EMPTY);
});
