import test from "node:test";
import assert from "node:assert/strict";
import {
  billDayOf, businessTimeZone, canonicalTimeZone, checkTimeZone, dayBoundsInTz, dayKeyInTz, dayRangeInTz, dayStartInTz, isDayStartInTz,
  resolveBusinessWindow, sameTimeZone, shiftDayLabel, shiftedDayStartInTz, tzOffsetMs, wallTimeInTz, weekdayHourInTz, zonedParts,
} from "./business-time.js";

const SH = "Asia/Shanghai";

test("业务时区默认 Asia/Shanghai，环境变量可覆盖，非法值退回默认", () => {
  assert.equal(businessTimeZone({}), SH);
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "UTC" }), "UTC");
  // 兼容旧的日报时区变量；新变量优先
  assert.equal(businessTimeZone({ REPORT_TIME_ZONE: "Asia/Tokyo" }), "Asia/Tokyo");
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "UTC", REPORT_TIME_ZONE: "Asia/Tokyo" }), "UTC");
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "Nowhere/Nope" }), SH);
  // 新变量写错时不挡住仍然有效的旧变量
  assert.equal(businessTimeZone({ BUSINESS_TIME_ZONE: "Nowhere/Nope", REPORT_TIME_ZONE: "Asia/Tokyo" }), "Asia/Tokyo");
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

test("wallTimeInTz / isDayStartInTz：半小时时区的钟点、夏令时切换日的 0 点", () => {
  assert.equal(wallTimeInTz("2026-10-10", 3, "Asia/Kolkata"), Date.parse("2026-10-09T21:30:00Z"));
  assert.equal(wallTimeInTz("2026-10-10", 0, "Asia/Shanghai"), dayStartInTz("2026-10-10", "Asia/Shanghai"));
  assert.equal(wallTimeInTz("bad", 3, "Asia/Shanghai"), null);
  // 洛杉矶 11月1日夏令时结束：当天 0 点还是 PDT
  const lastPdtMidnight = dayStartInTz("2026-11-01", "America/Los_Angeles");
  assert.equal(lastPdtMidnight, Date.parse("2026-11-01T07:00:00Z"));
  assert.equal(isDayStartInTz(lastPdtMidnight, "America/Los_Angeles"), true);
  assert.equal(isDayStartInTz(lastPdtMidnight + 3_600_000, "America/Los_Angeles"), false);
  assert.equal(isDayStartInTz(Date.parse("2026-11-02T08:00:00Z"), "America/Los_Angeles"), true);
});

test("午夜重复时取第一次 00:00，两次 00:30 都属于同一个 25 小时自然日", () => {
  const tz = "America/Havana";
  const start = Date.parse("2026-11-01T04:00:00Z");
  const end = Date.parse("2026-11-02T05:00:00Z");
  assert.equal(dayStartInTz("2026-11-01", tz), start);
  assert.equal(end - start, 25 * 3600000);
  for (const at of [start, Date.parse("2026-11-01T04:30:00Z"), Date.parse("2026-11-01T05:30:00Z"), end - 1]) {
    const bounds = dayBoundsInTz(at, tz);
    assert.deepEqual(bounds, { label: "2026-11-01", startMs: start, endMs: end });
    assert.ok(bounds.startMs <= at && at < bounds.endMs);
    const window = resolveBusinessWindow("today", at, tz);
    assert.equal(window.startMs, start);
    assert.ok(window.startMs <= window.now);
  }
  assert.equal(isDayStartInTz(start, tz), true);
  assert.equal(isDayStartInTz(Date.parse("2026-11-01T05:00:00Z"), tz), false);
  const days = dayRangeInTz("2026-10-31", "2026-11-02", tz);
  assert.equal(days[0].endMs, days[1].startMs);
  assert.equal(days[1].endMs, days[2].startMs);
  assert.equal(days[1].endMs - days[1].startMs, 25 * 3600000);
});

test("午夜不存在时取当天第一个有效时刻，23 小时日窗仍包含当天所有时刻", () => {
  for (const [tz, label, startIso, endIso] of [
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00Z", "2026-09-07T03:00:00Z"],
  ]) {
    const start = Date.parse(startIso), end = Date.parse(endIso);
    assert.equal(dayStartInTz(label, tz), start);
    assert.equal(dayKeyInTz(start, tz), label);
    assert.notEqual(dayKeyInTz(start - 1, tz), label);
    assert.equal(weekdayHourInTz(start, tz).hour, 1);
    assert.equal(end - start, 23 * 3600000);
    for (const at of [start, start + 30 * 60000, end - 1]) {
      const bounds = dayBoundsInTz(at, tz);
      assert.deepEqual(bounds, { label, startMs: start, endMs: end });
      assert.ok(bounds.startMs <= at && at < bounds.endMs);
    }
  }
});

test("非午夜的重复钟点取早、半小时缺口取跳变边界", () => {
  assert.equal(wallTimeInTz("2026-11-01", 1, "America/New_York"), Date.parse("2026-11-01T05:00:00Z"));
  assert.equal(wallTimeInTz("2026-10-04", 2, "Australia/Lord_Howe"), Date.parse("2026-10-03T15:30:00Z"));
});

test("账本日期只认恰好一个自然日的窗口：按窗口时区取日期，DST 的 23h/25h 日也算一天", () => {
  const sh = { startMs: Date.parse("2026-10-08T16:00:00Z"), endMs: Date.parse("2026-10-09T16:00:00Z"), timezone: "Asia/Shanghai" };
  assert.equal(billDayOf(sh), "2026-10-09");
  assert.equal(billDayOf({ ...sh, timezone: "UTC" }), null);
  assert.equal(billDayOf({ ...sh, endMs: sh.endMs + 86400000 }), null, "两天的窗口不是单日");
  assert.equal(billDayOf({ ...sh, endMs: sh.endMs - 1 }), null, "不完整的一天");
  assert.equal(billDayOf({ ...sh, startMs: sh.startMs + 1 }), null, "不从零点开始");
  assert.equal(billDayOf({ startMs: Date.parse("2026-03-08T05:00:00Z"), endMs: Date.parse("2026-03-09T04:00:00Z"), timezone: "America/New_York" }), "2026-03-08");
  assert.equal(billDayOf({ startMs: Date.parse("2026-11-01T04:00:00Z"), endMs: Date.parse("2026-11-02T05:00:00Z"), timezone: "America/New_York" }), "2026-11-01");
  assert.equal(billDayOf({ startMs: sh.startMs, endMs: sh.endMs }), null, "没有时区");
  assert.equal(billDayOf({ ...sh, timezone: "Not/AZone" }), null, "无效时区");
  assert.equal(billDayOf(null), null);
});

test("账本日期：午夜切夏令时的那天从第一个有效时刻算起，也是一整天（B-T1）", () => {
  // 哈瓦那 03-08 0:00 跳到 1:00；贝鲁特 03-29 0:00 跳到 1:00（东半球）；亚速尔 10-25 1:00 拨回 0:00，这天从第一次 0:00 算
  assert.equal(billDayOf({ startMs: Date.parse("2026-03-08T05:00:00Z"), endMs: Date.parse("2026-03-09T04:00:00Z"), timezone: "America/Havana" }), "2026-03-08");
  assert.equal(billDayOf({ startMs: Date.parse("2026-03-28T22:00:00Z"), endMs: Date.parse("2026-03-29T21:00:00Z"), timezone: "Asia/Beirut" }), "2026-03-29");
  assert.equal(billDayOf({ startMs: Date.parse("2026-10-25T00:00:00Z"), endMs: Date.parse("2026-10-26T01:00:00Z"), timezone: "Atlantic/Azores" }), "2026-10-25");
  assert.equal(billDayOf({ startMs: Date.parse("2026-10-25T01:00:00Z"), endMs: Date.parse("2026-10-26T01:00:00Z"), timezone: "Atlantic/Azores" }), null, "第二次 0:00 不是这天的开始");
  // 前一天也跟着变成整天：哈瓦那 03-07 到 03-08 01:00 为止
  assert.equal(billDayOf({ startMs: Date.parse("2026-03-07T05:00:00Z"), endMs: Date.parse("2026-03-08T05:00:00Z"), timezone: "America/Havana" }), "2026-03-07");
});

test("时区名：没给用缺省，不合法报 TIMEZONE_INVALID；规范写法按运行环境的 Intl 统一大小写和别名", () => {
  assert.equal(checkTimeZone(undefined), "Asia/Shanghai");
  assert.equal(checkTimeZone(""), "Asia/Shanghai");
  assert.equal(checkTimeZone(null, "UTC"), "UTC");
  assert.equal(checkTimeZone("asia/shanghai"), "asia/shanghai", "合法的原样返回，不改写法");
  for (const bad of ["Mars/Base", 5, " Asia/Shanghai"]) {
    assert.throws(() => checkTimeZone(bad), (error) => error.code === "TIMEZONE_INVALID" && error.message === "时区不对");
  }
  assert.equal(canonicalTimeZone("asia/shanghai"), "Asia/Shanghai");
  assert.equal(canonicalTimeZone("utc"), "UTC");
  assert.equal(canonicalTimeZone(undefined), "Asia/Shanghai");
  assert.throws(() => canonicalTimeZone("Mars/Base"), (error) => error.code === "TIMEZONE_INVALID");
  assert.equal(sameTimeZone("asia/shanghai", "Asia/Shanghai"), true);
  assert.equal(sameTimeZone("Asia/Shanghai", "UTC"), false);
  assert.equal(sameTimeZone("Mars/Base", "Mars/Base"), true, "名字相同就是同一个");
  assert.equal(sameTimeZone("Mars/Base", "Asia/Shanghai"), false);
  assert.equal(sameTimeZone(undefined, "Asia/Shanghai"), false, "没给的不当成缺省时区");
});

test("某天往前往后数几天的 0 点、某刻的年月日时分秒都按 tz 的日历算", () => {
  const tz = "America/New_York", at = Date.parse("2026-03-09T15:00:00Z"); // 纽约 03-09 11:00，前一天切夏令时
  assert.equal(shiftedDayStartInTz(at, 0, tz), Date.parse("2026-03-09T04:00:00Z"));
  assert.equal(shiftedDayStartInTz(at, -1, tz), Date.parse("2026-03-08T05:00:00Z"));
  assert.equal(shiftedDayStartInTz(at, 1, tz), Date.parse("2026-03-10T04:00:00Z"));
  assert.equal(shiftedDayStartInTz(at, -6, tz), Date.parse("2026-03-03T05:00:00Z"));
  assert.deepEqual(zonedParts(at, tz), { year: 2026, month: 3, day: 9, hour: 11, minute: 0, second: 0 });
  assert.deepEqual(zonedParts(Date.parse("2026-10-23T16:00:00Z")), { year: 2026, month: 10, day: 24, hour: 0, minute: 0, second: 0 }, "缺省上海，0 点是 0 不是 24");
  assert.equal(tzOffsetMs(tz, at), -4 * 3600000);
  assert.equal(tzOffsetMs("Asia/Kolkata", at), 5.5 * 3600000);
});

test("dayStartInTz 按日期和时区缓存（计划 C2a）：缓存满了清空，结果和不缓存时一样", () => {
  for (const tz of ["Asia/Shanghai", "America/Los_Angeles", "America/Sao_Paulo"]) {
    for (let i = 0; i < 2100; i += 1) {
      const label = shiftDayLabel("2026-01-01", i % 900);
      assert.equal(dayStartInTz(label, tz), wallTimeInTz(label, 0, tz), `${tz} ${label}`);
    }
  }
});
