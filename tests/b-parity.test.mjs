// B1、B2 新旧对拍（常驻，只取一小组代表）：合并以后的写法和 tests/b-legacy.mjs 里原来那几份逐一对比（比较本身在 b-parity-cases.mjs），
// 结论必须相同。允许不同的只有：
// - B-T1：午夜切夏令时的那几天，原来 B（scope-policy）、C（reconciliation.js）两套「某天 0 点」各算各的，现在按 lib/business-time.js；
// - D：用量页把上游给的日期换成时间点，原来只取一次时区偏移，切夏令时那天会差，现在也按 lib/business-time.js。
// - B-S1：仓库挑旧确认记录，结束后不满 15 分钟生成的不再认；
// - B-L1：重结出来的账和最新一版内容相同时不写新版。
// 全部时区、2025–2027 每一天的全量对拍是 scripts/b-parity-sweep.mjs（只跑一次，结果写在 PR 里）。计划 7c 和 b-legacy.mjs 一起删。
import test from "node:test";
import assert from "node:assert/strict";
import { dayStartInTz, shiftDayLabel, tzOffsetMs, wallTimeInTz } from "../lib/business-time.js";
import { dayDiffs, dayStartDiffers, decimalDiffs, instantDiffs, ledgerDiffs, rateDiffs, settlementDiffs, timeZoneNameDiffs, windowPairDiffs, windowSet } from "./b-parity-cases.mjs";
import { ledgerInsertValues, RECONCILIATION_LEDGER_COLUMNS } from "../lib/reconciliation-ledger.js";

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

// ---- B2 ----

const MINUTE = 60000, DELAY = 15 * MINUTE;

test("对拍：这天该不该结——轮询、读已固定的账、取数后、重试、旧记录、迁移、页面的整天，只在 B-S1 那种旧记录上不同", () => {
  let bs1 = 0;
  // 午夜切夏令时那几天，再加上海、洛杉矶的几个日子（洛杉矶含切夏令时的前后）
  const days = DAYS.filter(({ tz, label }) => MIDNIGHT_DST.includes(`${tz} ${label}`) || (tz === "Asia/Shanghai" && ["2026-01-15", "2026-12-31"].includes(label))
    || (tz === "America/Los_Angeles" && ["2026-03-07", "2026-03-08", "2026-11-01", "2026-06-15"].includes(label)));
  assert.equal(days.length, 11);
  for (const { tz, label } of days) {
    const start = dayStartInTz(label, tz), end = dayStartInTz(shiftDayLabel(label, 1), tz), after = dayStartInTz(shiftDayLabel(label, 2), tz);
    // 整天、两天、不从 0 点开始、没写时区
    for (const window of [{ startMs: start, endMs: end, timezone: tz }, { startMs: start, endMs: after, timezone: tz },
      { startMs: start + HOUR, endMs: end, timezone: tz }, { startMs: start, endMs: end }]) {
      // 开始统计在这天之前、正好在这天结束、在这天里；旧规则按建绑定的时刻；建绑定的时刻读不出
      const rules = [{ billingPolicy: "immediate", createdAt: new Date(start - DAY_MS).toISOString() }, { billingPolicy: "immediate", createdAt: new Date(window.endMs).toISOString() },
        { billingPolicy: "immediate", createdAt: new Date(start - DAY_MS).toISOString(), billingEffectiveFrom: window.endMs - 1 }, { createdAt: new Date(window.endMs + HOUR).toISOString() }, { createdAt: "x" }];
      const generatedAts = [null, "x", ...[window.endMs - 1, window.endMs, window.endMs + DELAY - 1, window.endMs + DELAY, window.endMs + HOUR].map((at) => new Date(at).toISOString())];
      for (const now of [window.endMs - 1, window.endMs, window.endMs + DELAY - 1, window.endMs + DELAY, window.endMs + DAY_MS]) {
        // 上次没结过、已结、没到重试时刻、正好到重试时刻
        const attempts = [null, { settled: true, retryAt: null }, { settled: false, retryAt: now + 1 }, { settled: false, retryAt: now }];
        const diffs = settlementDiffs({ window, now, rules, attempts, generatedAts });
        assert.deepEqual(diffs.filter((diff) => diff.family !== "B-S1"), [], `${tz} ${label} ${now}`);
        bs1 += diffs.length;
      }
    }
  }
  assert.ok(bs1 > 0, "B-S1 那种旧记录原来确实认");
});

const DAY_MS = 86400000;

// 库里读出来的最新一版：按两个仓库写入的那份值拼成行，DECIMAL 列按 MySQL 存进去的样子读回定点字符串
function ledgerRow(entry, revision = 1, source = "settle") {
  const values = ledgerInsertValues({ ...entry, revision, source });
  const row = Object.fromEntries(RECONCILIATION_LEDGER_COLUMNS.map((column, index) => [column, values[index]]));
  for (const [column, scale] of [["revenue_usd", 8], ["cost_usd", 8], ["revenue_rate", 6], ["cost_rate", 6]]) row[column] = row[column] == null ? null : Number(row[column]).toFixed(scale);
  return row;
}

test("对拍：账本写不写、写第几版，只在 B-L1（重结、内容相同）上不同", () => {
  const start = Date.UTC(2026, 9, 8, 16), base = { ruleId: "rr_1", billDate: "2026-10-09", versionId: null, timezone: "Asia/Shanghai", startMs: start, endMs: start + DAY_MS,
    revenueUsd: 2.25, costUsd: 1, revenueRate: null, costRate: null, costBasis: "usage", detail: { a: 1 }, settledAt: "2026-10-09T16:20:00.000Z" };
  const variants = [{}, { revenueUsd: 2.26 }, { revenueUsd: 2.250000004 }, { costUsd: null }, { costUsd: 0.999999996 }, { revenueRate: 7.2 }, { costRate: 7.2000004 },
    { costBasis: "fixed" }, { costBasis: null }, { timezone: "Etc/UTC" }, { startMs: start - HOUR, endMs: start + DAY_MS - HOUR }, { detail: { b: 2 }, settledAt: "2026-10-09T17:00:00.000Z" }];
  const tops = [null, ledgerRow(base), ledgerRow({ ...base, revenueRate: 7.2 }, 3, "resettle"), ledgerRow({ ...base, costBasis: null, revenueRate: null }, 1, "migrated")];
  const allowed = [];
  for (const top of tops) {
    for (const variant of variants) {
      for (const resettle of [false, true]) {
        const diffs = ledgerDiffs(top, { ...base, ...variant, revision: null, source: "settle" }, resettle);
        assert.deepEqual(diffs.filter((diff) => diff.family !== "B-L1"), [], JSON.stringify([top, variant, resettle]));
        allowed.push(...diffs.map((diff) => JSON.stringify([top?.revision ?? null, variant])));
      }
    }
  }
  // 内容相同的：同一份、只差明细和结账时刻、金额舍入以后相同；最新一版有汇率、这次也是同一个汇率；迁移的旧账（计法、汇率都空）这次也都空
  assert.deepEqual(allowed, ["[1,{}]", "[1,{\"revenueUsd\":2.250000004}]", "[1,{\"costUsd\":0.999999996}]", "[1,{\"detail\":{\"b\":2},\"settledAt\":\"2026-10-09T17:00:00.000Z\"}]",
    "[3,{\"revenueRate\":7.2}]", "[1,{\"costBasis\":null}]"]);
});

test("对拍：内存仓库模拟 DECIMAL，只在正好落在舍入中点的值上不同（现在和 MySQL 一样）", () => {
  assert.deepEqual(decimalDiffs([0, 1, 2.25, 7.2, 1e-9, -0, 123456.123456789, 0.1 + 0.2, null]), []);
  assert.deepEqual(decimalDiffs([1.0000000050000001, 0.123456785]).map(({ value, scale, now }) => [value, scale, now]),
    [[0.123456785, 8, "0.12345679"]]);
});
