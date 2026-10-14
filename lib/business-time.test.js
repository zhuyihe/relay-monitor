import test from "node:test";
import assert from "node:assert/strict";
import {
  businessTimeZone, dayBoundsInTz, dayKeyInTz, dayRangeInTz, dayStartInTz, resolveBusinessWindow, shiftDayLabel,
  weekdayHourInTz,
} from "./business-time.js";

const SH = "Asia/Shanghai";

test("业务时区默认 Asia/Shanghai，环境变量可覆盖，非法值退回默认", () => {
  assert.equal(businessTimeZone({}), SH);
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "UTC" }), "UTC");
  // 兼容旧的日报时区变量；新变量优先
  assert.equal(businessTimeZone({ REPORT_TIME_ZONE: "Asia/Tokyo" }), "Asia/Tokyo");
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "UTC", REPORT_TIME_ZONE: "Asia/Tokyo" }), "UTC");
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "Nowhere/Nope" }), SH);
});

test("按业务时区取日期与零点，与进程时区无关", () => {
  const start = Date.UTC(2026, 9, 13, 16); // 北京时间 10 月 14 日 00:00
  assert.equal(dayStartInTz("2026-10-14", SH), start);
  assert.equal(dayKeyInTz(start, SH), "2026-10-14");
  assert.equal(dayKeyInTz(start - 1, SH), "2026-10-13");
  assert.equal(dayKeyInTz(start, "UTC"), "2026-10-13");
  assert.deepEqual(dayBoundsInTz(start + 5 * 3600000, SH), { label: "2026-10-14", startMs: start, endMs: start + 86400000 });
  assert.equal(dayStartInTz("2026-02-31", SH) == null, false); // 日历滚动由 Date.UTC 处理
  assert.equal(dayStartInTz("bad", SH), null);
});

test("夏令时切换日的零点和日长正确", () => {
  const ny = "America/New_York";
  // 2026-03-08 凌晨 2 点进入夏令时：当天只有 23 小时
  const mar8 = dayStartInTz("2026-03-08", ny);
  assert.equal(mar8, Date.UTC(2026, 2, 8, 5));
  assert.equal(dayStartInTz("2026-03-09", ny) - mar8, 23 * 3600000);
  // 2026-11-01 退出夏令时：当天 25 小时
  const nov1 = dayStartInTz("2026-11-01", ny);
  assert.equal(nov1, Date.UTC(2026, 10, 1, 4));
  assert.equal(dayStartInTz("2026-11-02", ny) - nov1, 25 * 3600000);
});

test("日期标签加减与区间展开", () => {
  assert.equal(shiftDayLabel("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDayLabel("2026-12-31", 1), "2027-01-01");
  const days = dayRangeInTz("2026-10-12", "2026-10-14", SH);
  assert.deepEqual(days.map((d) => d.date), ["2026-10-12", "2026-10-13", "2026-10-14"]);
  assert.equal(days[0].endMs, days[1].startMs);
});

test("利润窗口按业务时区自然日切，上一窗口整窗左移", () => {
  const now = Date.UTC(2026, 9, 14, 2, 30); // 北京时间 10 月 14 日 10:30
  const midnight = Date.UTC(2026, 9, 13, 16);
  const today = resolveBusinessWindow("today", now, SH);
  assert.equal(today.midnight, midnight);
  assert.equal(today.startMs, midnight);
  assert.equal(today.todayLabel, "2026-10-14");
  assert.equal(today.prevStart, midnight - 86400000);
  assert.equal(today.prevEnd, now - 86400000);
  const week = resolveBusinessWindow("7d", now, SH);
  assert.equal(week.spanDays, 7);
  assert.equal(week.startMs, midnight - 6 * 86400000);
  assert.equal(week.prevStart, week.startMs - 7 * 86400000);
  assert.equal(week.prevEnd - week.prevStart, now - week.startMs);
  assert.equal(resolveBusinessWindow("bogus", now, SH).range, "7d");
  assert.equal(resolveBusinessWindow("30d", now, SH).startMs, midnight - 29 * 86400000);
});

test("星期与小时按业务时区取，半点时区也落在正确的小时", () => {
  // 2026-10-14 是周三；UTC 16:30 = 上海 10/15 周四 00:30
  assert.deepEqual(weekdayHourInTz(Date.UTC(2026, 9, 14, 16, 30), SH), { weekday: 3, hour: 0 });
  assert.deepEqual(weekdayHourInTz(Date.UTC(2026, 9, 14, 16, 30), "UTC"), { weekday: 2, hour: 16 });
  // 印度 +5:30：UTC 18:45 = 10/15 00:15
  assert.deepEqual(weekdayHourInTz(Date.UTC(2026, 9, 14, 18, 45), "Asia/Kolkata"), { weekday: 3, hour: 0 });
});
