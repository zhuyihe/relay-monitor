// B1 新旧对拍（常驻，只取一小组代表）：合并以后的写法和 tests/b-legacy.mjs 里原来那几份逐一对比（比较本身在 b-parity-cases.mjs），
// 结论必须相同。允许不同的只有：
// - B-T1：午夜切夏令时的那几天，原来 B（scope-policy）、C（reconciliation.js）两套「某天 0 点」各算各的，现在按 lib/business-time.js；
// - D：用量页把上游给的日期换成时间点，原来只取一次时区偏移，切夏令时那天会差，现在也按 lib/business-time.js。
// 全部时区、2025–2027 每一天的全量对拍是 scripts/b-parity-sweep.mjs（只跑一次，结果写在 PR 里）。计划 7c 和 b-legacy.mjs 一起删。
import test from "node:test";
import assert from "node:assert/strict";
import { dayStartInTz, shiftDayLabel, tzOffsetMs, wallTimeInTz } from "../lib/business-time.js";
import { dayDiffs, dayStartDiffers, instantDiffs, rateDiffs, timeZoneNameDiffs, windowPairDiffs, windowSet } from "./b-parity-cases.mjs";

const HOUR = 3600000;
// 上海、UTC、纽约、洛杉矶、半点时区、夏令时只拨半小时、+12:45，再加午夜切夏令时的 5 个
const ZONES = ["Asia/Shanghai", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Chatham",
  "America/Havana", "America/Santiago", "Atlantic/Azores", "Asia/Beirut", "Africa/Cairo"];
const MIDNIGHT_DST = ["America/Havana 2026-03-08", "America/Santiago 2026-09-06", "Atlantic/Azores 2026-03-29", "Asia/Beirut 2026-03-29", "Africa/Cairo 2026-04-24"];
// D 在上面这些时区 2026 年会差的日子（全量扫出来的，见 PR）
const PARSE_DATE_LABEL = ["Africa/Cairo 2026-04-24", "America/Santiago 2026-04-05", "Asia/Beirut 2026-03-29", "Australia/Lord_Howe 2026-04-05",
  "Australia/Lord_Howe 2026-10-04", "Pacific/Chatham 2026-04-05", "Pacific/Chatham 2026-09-27"];
const NORMAL_DAYS = ["2026-01-15", "2026-02-28", "2026-03-01", "2026-06-15", "2026-10-24", "2026-12-31", "2027-01-01"];

// 每个时区取：2026 年每次切夏令时前后（两天 0 点的偏移不同：切在当天里，或者正好切在午夜），再加几个普通日子（含月底、年底）
function sampleDays(tz) {
  const days = new Set(NORMAL_DAYS);
  for (let label = "2026-01-01"; label <= "2026-12-31"; label = shiftDayLabel(label, 1)) {
    if (tzOffsetMs(tz, dayStartInTz(label, tz)) !== tzOffsetMs(tz, dayStartInTz(shiftDayLabel(label, 1), tz))) {
      for (const offset of [-1, 0, 1, 2]) days.add(shiftDayLabel(label, offset));
    }
  }
  return [...days].sort();
}

const DAYS = ZONES.flatMap((tz) => sampleDays(tz).map((label) => ({ tz, label })));

test("对拍：某刻属于哪天、时区偏移、星期几和钟点，哪个时区都一样", () => {
  for (const { tz, label } of DAYS) {
    const start = dayStartInTz(label, tz), end = dayStartInTz(shiftDayLabel(label, 1), tz);
    for (const ms of [start - 1, start, start + HOUR / 2, wallTimeInTz(label, 12, tz), end - 1]) assert.deepEqual(instantDiffs(tz, ms), [], `${tz} ${ms}`);
  }
});

test("对拍：某天 0 点、窗口、是哪天的账、过完没有、Sub2API 整天，只在午夜切夏令时那几天不同；用量页的日期只在 D 那几天不同", () => {
  const midnightDst = new Set(MIDNIGHT_DST), parseDateLabel = new Set(PARSE_DATE_LABEL), seen = new Set(), seenD = new Set();
  for (const { tz, label } of DAYS) {
    for (const diff of dayDiffs(tz, label)) {
      if (diff.family === "parseDateLabel") {
        assert.ok(parseDateLabel.has(`${tz} ${label}`), `D：${tz} ${label}`);
        seenD.add(`${tz} ${label}`);
        continue;
      }
      const hit = diff.involved.find((day) => midnightDst.has(`${tz} ${day}`));
      assert.ok(hit, `${diff.family}：${tz} ${label} ${JSON.stringify(diff.now)} ≠ ${JSON.stringify(diff.before)}`);
      seen.add(`${tz} ${hit}`);
    }
  }
  assert.deepEqual([...seen].sort(), [...MIDNIGHT_DST].sort(), "午夜切夏令时那几天原来确实算错");
  assert.deepEqual([...seenD].sort(), [...PARSE_DATE_LABEL].sort());
  for (const day of MIDNIGHT_DST) assert.ok(dayStartDiffers(...day.split(" ")), day);
  assert.equal(dayStartDiffers("Asia/Shanghai", "2026-10-24"), false);
});

test("对拍：时区名的校验和规范写法", () => {
  for (const name of [...ZONES, "asia/shanghai", "utc", "Etc/UTC", "US/Eastern", "Asia/Calcutta", "+08:00", "Mars/Base", " UTC", "", undefined, null, 5]) {
    assert.deepEqual(timeZoneNameDiffs(name), [], String(name));
  }
});

test("对拍：两段窗口是不是同一段，每个调用方传的选项和原来那份结论相同", () => {
  const windows = [...windowSet({ presets: ["today", "7d", "yesterday", "custom", undefined], ends: [0, -1] }), null, undefined];
  for (const a of windows) for (const b of windows) assert.deepEqual(windowPairDiffs(a, b), [], `${JSON.stringify(a)} ${JSON.stringify(b)}`);
});

test("对拍：设没设汇率、一条绑定的汇率、折人民币", () => {
  assert.deepEqual(rateDiffs(), []);
});
