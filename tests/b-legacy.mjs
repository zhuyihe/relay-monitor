// B 对拍用的旧实现：B1 合掉的那几份原样留在这里，只给对拍用（tests/b-parity.test.mjs、scripts/b-parity-sweep.mjs），
// 不要在别处引用。计划 7c 删掉。
// 每段都是从 main 8a437f0 原样抄来的，只改了名字（同名的加上出处前缀）和互相引用；出处写在每段前面。
import { isLiveReconciliationPreset } from "../lib/reconciliation-contract.js";
import { costBasisOf, rateSnapshotOf } from "../lib/profit.js";

const DAY_MS = 86400000;

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// ---- lib/reconciliation-scope-policy.js:6-78（B：某天 0 点迭代 4 次）----

function spParts(ms, timezone) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const read = (key) => Number(values.find((part) => part.type === key)?.value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

function startOfDate(date, timezone) {
  const wall = Date.UTC(date.year, date.month - 1, date.day);
  let candidate = wall;
  for (let i = 0; i < 4; i += 1) {
    const actual = spParts(candidate, timezone);
    const next = wall - (Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) - candidate);
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

export function nextBillingEffectiveFrom(timezone = "Asia/Shanghai", now = Date.now()) {
  const today = spParts(now, timezone);
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return startOfDate({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() }, timezone);
}

export function completedBillingDayWindow(timezone = "Asia/Shanghai", now = Date.now()) {
  const today = spParts(now, timezone);
  const yesterday = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  return { startMs: startOfDate({ year: yesterday.getUTCFullYear(), month: yesterday.getUTCMonth() + 1, day: yesterday.getUTCDate() }, timezone),
    endMs: startOfDate(today, timezone), timezone };
}

export function startOfBillingDay(ms, timezone = "Asia/Shanghai") {
  return startOfDate(spParts(ms, timezone), timezone);
}

export function isCompletedBillingWindow(window, now = Date.now()) {
  if (!window || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs <= window.startMs) return false;
  const midnight = (ms) => startOfDate(spParts(ms, window.timezone), window.timezone);
  return window.startMs === midnight(window.startMs) && window.endMs === midnight(window.endMs) && window.endMs <= midnight(now);
}

export function billingDayOf(window) {
  if (!window || typeof window.timezone !== "string" || !window.timezone
    || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) return null;
  try {
    if (startOfBillingDay(window.startMs, window.timezone) !== window.startMs
      || nextBillingEffectiveFrom(window.timezone, window.startMs) !== window.endMs) return null;
    const day = spParts(window.startMs, window.timezone);
    return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

// ---- server/reconciliation.js:98-188（C：某天 0 点迭代 3 次；时区校验、规范写法、窗口）----

export function validateTimezone(input) {
  const timezone = String(input || "Asia/Shanghai");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch {
    throw codedError("TIMEZONE_INVALID", "时区不对");
  }
  return timezone;
}

export const canonicalTimezone = (input) => new Intl.DateTimeFormat("en-US", { timeZone: validateTimezone(input) }).resolvedOptions().timeZone;
export const sameAbsoluteWindow = (a, b) => !!a && !!b && a.startMs === b.startMs && a.endMs === b.endMs;

export function zonedParts(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function shiftedCalendarDate(part, days) {
  const date = new Date(Date.UTC(part.year, part.month - 1, part.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function calendarMidnight(part, timezone) {
  const wallTime = Date.UTC(part.year, part.month - 1, part.day);
  let candidate = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(candidate, timezone);
    const observedWallTime = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const next = wallTime - (observedWallTime - candidate);
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

export function midnight(ms, timezone, days = 0) {
  return calendarMidnight(shiftedCalendarDate(zonedParts(ms, timezone), days), timezone);
}

export function localDate(ms, timezone) {
  const part = zonedParts(ms, timezone);
  return `${part.year}-${String(part.month).padStart(2, "0")}-${String(part.day).padStart(2, "0")}`;
}

const RECONCILIATION_PRESETS = Object.freeze(["today", "yesterday", "7d", "month", "custom"]);

export function resolveReconciliationWindow(input = {}, now = Date.now()) {
  const timezone = validateTimezone(input.timezone);
  const preset = RECONCILIATION_PRESETS.includes(input.preset) ? input.preset : "yesterday";
  let startMs;
  let endMs;
  if (preset === "custom") {
    startMs = finite(input.startMs);
    endMs = finite(input.endMs);
    if (startMs == null || endMs == null || startMs >= endMs) throw codedError("TIME_RANGE_INVALID", "时间范围不对");
    if (endMs > now) throw codedError("TIME_RANGE_FUTURE", "不能选以后的时间");
    if (endMs - startMs > 31 * DAY_MS) throw codedError("TIME_RANGE_TOO_LONG", "一次最多查 31 天");
  } else {
    const dayStart = midnight(now, timezone);
    if (preset === "yesterday") {
      startMs = midnight(now, timezone, -1);
      endMs = dayStart;
    } else if (preset === "7d") {
      startMs = midnight(now, timezone, -6);
      endMs = now;
    } else if (preset === "month") {
      const today = zonedParts(now, timezone);
      startMs = calendarMidnight({ year: today.year, month: today.month, day: 1 }, timezone);
      endMs = now;
    } else {
      startMs = dayStart;
      endMs = now;
    }
  }
  return { preset, timezone, startMs: Math.floor(startMs), endMs: Math.floor(endMs) };
}

// server/reconciliation.js:1857 账号级未核算：窗口两端是不是整天
export const dayAligned = (window) => midnight(window.startMs, window.timezone) === window.startMs && midnight(window.endMs, window.timezone) === window.endMs;

// ---- lib/reconciliation-snapshot.js:4-10 ----

export function snapshotLocalDate(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---- lib/providers.js:351-373、:969-972、:1182-1196（D：某天 0 点只取一次偏移）----

export function dateStrInTz(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
}

function providersTzOffsetMs(tz, at) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (k) => Number(p.find((x) => x.type === k).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

export function parseDateLabel(s, tz) {
  if (!s) return null;
  const utc = Date.parse(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : "Z"));
  if (Number.isNaN(utc)) return null;
  return utc - providersTzOffsetMs(tz, utc);
}

export function reconciliationTimezone(timezone) {
  try { return new Intl.DateTimeFormat("en", { timeZone: timezone || "Asia/Shanghai" }).resolvedOptions().timeZone; }
  catch { throw codedError("UPSTREAM_WINDOW_UNSUPPORTED", "账单时区无效，请重新确认"); }
}

// queryKeyReconciliationStat 里 Sub2API 那段「是不是整天」，原样抠出来；observedAt 由调用方给，便于对拍
const SUB2_LIVE_END_SKEW_MS = 5 * 60000;
export function sub2NaturalDayWindow(startMs, endMs, zone, observedAt) {
  let startDate, endDate, live;
  try {
    startDate = dateStrInTz(startMs, zone);
    endDate = dateStrInTz(endMs - 1, zone);
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
        startMs % 1000 !== 0 || clock.format(startMs) !== "00:00:00") {
      throw new Error("not a natural-day window");
    }
    live = endMs % 1000 !== 0 || clock.format(endMs) !== "00:00:00";
    if (live && (endMs > observedAt || observedAt - endMs > SUB2_LIVE_END_SKEW_MS)) throw new Error("stale live window");
  } catch {
    throw codedError("UPSTREAM_WINDOW_UNSUPPORTED", "Sub2API 账单仅支持完整自然日或截至当前的今日区间");
  }
  return { startDate, endDate, live };
}

// ---- server/channel-onboarding.js:1017-1018 ----

export const onboardingTimezone = (requested, existing) =>
  new Intl.DateTimeFormat("en", { timeZone: requested || existing || "Asia/Shanghai" }).resolvedOptions().timeZone;

// ---- lib/client.ts:174、app/api/usage/route.js:15-17（时区名校验）----

export const clientTimezoneValid = (timezone) => {
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(); return true; } catch { return false; }
};

export function usageRouteTimezone(raw) {
  let tz = String(raw || "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = ""; }
  if (!tz) tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz;
}

// ---- lib/business-time.js:47-61（偏移、星期几和钟点，改成共用 zonedParts 之前）----

const formats = new Map();
function format(tz, kind) {
  const key = `${tz}|${kind}`;
  let f = formats.get(key);
  if (!f) {
    f = kind === "day"
      ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      : new Intl.DateTimeFormat("en-US", {
          timeZone: tz, hourCycle: "h23",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
    formats.set(key, f);
  }
  return f;
}

export function tzOffsetMs(tz, at) {
  const parts = format(tz, "full").formatToParts(new Date(at));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

export function weekdayHourInTz(ms, tz = "Asia/Shanghai") {
  const parts = format(tz, "full").formatToParts(new Date(Number(ms)));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const weekday = (new Date(Date.UTC(get("year"), get("month") - 1, get("day"))).getUTCDay() + 6) % 7;
  return { weekday, hour: get("hour") % 24 };
}

// ---- server/report.js:31-40、app/api/own/analytics/route.js:94-95（钟点）----

export function reportClock(nowMs, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nowMs));
  const value = (type) => parts.find((p) => p.type === type)?.value || "00";
  return { today: format(tz, "day").format(new Date(Number(nowMs))), hhmm: `${value("hour")}:${value("minute")}` };
}

export function ownAnalyticsHourOf(ms, tz) {
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
  return Number(hourFmt.format(new Date(ms))) % 24;
}

// ---- 窗口比较：lib/reconciliation-view.js:51-54、:101-106；页面 recon-format.ts:92-99；仓库 :704-705、:811；内存仓库 :438-439、:534 ----

export function viewSameReconciliationWindow(a, b) {
  if (!a || !b || a.startMs !== b.startMs) return false;
  return isLiveReconciliationPreset(a.preset) || isLiveReconciliationPreset(b.preset) ? a.preset === b.preset : a.endMs === b.endMs;
}

export function windowsMatch(a, b) {
  if (a?.startMs !== b?.startMs || a?.endMs !== b?.endMs) return false;
  if (a?.timezone === b?.timezone) return true;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: a.timezone }).resolvedOptions().timeZone
    === new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }).resolvedOptions().timeZone; } catch { return false; }
}

export function pageSameWindow(a, b) {
  return a?.startMs === b?.startMs && a?.endMs === b?.endMs && a?.timezone === b?.timezone;
}

export function pageSameRequestedWindow(a, b) {
  return pageSameWindow(a, b) || a?.timezone === b?.timezone && viewSameReconciliationWindow(a, b);
}

// 账本该不该写新版里的「窗口相同」（MySQL 仓库和内存仓库逐字相同）；top 是库里最新一版的行
export const ledgerRowSameWindow = (top, entry) => top && top.timezone === entry.timezone
  && Number(top.window_start_ms) === entry.startMs && Number(top.window_end_ms) === entry.endMs;

// latestLedgerEntry 读出的那一版和要的窗口是否相同（两个仓库相同）
export const ledgerEntrySameWindow = (entry, window) => entry && entry.timezone === window.timezone && entry.startMs === window.startMs && entry.endMs === window.endMs;

// ---- 汇率：lib/reconciliation-view.js:32、:500；server/reconciliation.js:1097、:1682、:1743-1745、:1771-1775；lib/profit.js:141-145 ----

export const viewConfigured = (rate) => rate?.source === "configured" && Number(rate.cnyPerUsd) > 0;
export const configuredRate = (rate) => rate.source === "configured" ? rate.cnyPerUsd : null;
export const financialSnapshotOf = (own, upstream) => ({ costBasis: costBasisOf(upstream), income: rateSnapshotOf(own), cost: rateSnapshotOf(upstream) });

// factsFor 里那段：upstreamStation 按 id 取现在的站点（删掉的取不到）
export function factsRates(result, ledger, upstreamStation) {
  const upstream = upstreamStation(result.rule.upstreamStationId);
  const rateOf = (stationId, saved) => ({ stationId, ...(saved != null ? { cnyPerUsd: saved, source: "configured" } : rateSnapshotOf(upstreamStation(stationId))) });
  return { income: rateOf(result.rule.ownStationId, ledger?.rates?.income), cost: rateOf(result.rule.upstreamStationId, ledger?.rates?.cost),
    costBasis: ledger?.costBasis || result.costBasis || (upstream ? costBasisOf(upstream) : "usage") };
}

// readResponse 里整页币种收集的两种条目
export const rowRateConfigured = (rate) => rate.source === "configured";
export const stationRateConfigured = (station) => rateSnapshotOf(station).source === "configured";

export function toCny(usd, rate) {
  const n = Number(usd);
  const r = typeof rate === "number" ? rate : rate?.cnyPerUsd ?? 1;
  return Number.isFinite(n) ? Math.round(n * r * 100) / 100 : 0;
}
