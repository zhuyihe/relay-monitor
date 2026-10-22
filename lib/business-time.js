// 业务时区：利润、日汇总、日报里的「今天」「昨天」「近 7 天」统一按这个时区划日，
// 与进程时区、浏览器时区都无关。默认 Asia/Shanghai，可用环境变量 BUSINESS_TIME_ZONE 覆盖
// （兼容旧的 REPORT_TIME_ZONE）。纯 Intl 实现，前后端都能 import；单测见 lib/business-time.test.js。

export const DEFAULT_BUSINESS_TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 86400000;

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 服务端读环境变量；浏览器里没有 process，直接用默认值（前端应以接口返回的 tz 为准）。
// 依次取第一个合法的：BUSINESS_TIME_ZONE 写错了也不会挡住仍然有效的旧 REPORT_TIME_ZONE。
export function businessTimeZone(env = typeof process !== "undefined" ? process.env : {}) {
  return [env?.BUSINESS_TIME_ZONE, env?.REPORT_TIME_ZONE].find(isValidTimeZone) || DEFAULT_BUSINESS_TIME_ZONE;
}

const formats = new Map();
function format(tz, kind) {
  const key = `${tz}|${kind}`;
  let f = formats.get(key);
  if (!f) {
    f = kind === "day"
      // en-CA 的日期格式正好是 YYYY-MM-DD
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

// 某时刻在 tz 下的日期 YYYY-MM-DD
export function dayKeyInTz(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  return format(tz, "day").format(new Date(Number(ms)));
}

// 某时刻 tz 相对 UTC 的偏移毫秒（东八区为 +8h）
export function tzOffsetMs(tz, at) {
  const parts = format(tz, "full").formatToParts(new Date(at));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

// 某时刻在 tz 下是星期几（0 = 周一）、几点（0–23），热力图按业务时区分桶用
export function weekdayHourInTz(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const parts = format(tz, "full").formatToParts(new Date(Number(ms)));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const weekday = (new Date(Date.UTC(get("year"), get("month") - 1, get("day"))).getUTCDay() + 6) % 7;
  return { weekday, hour: get("hour") % 24 };
}

const LABEL = /^(\d{4})-(\d{2})-(\d{2})$/;

// 日期标签 ± n 天（纯日历运算，不受夏令时影响）
export function shiftDayLabel(label, days) {
  const m = LABEL.exec(String(label || ""));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

// tz 下某日 hour 点整的时间戳；标签不合法返回 null。
// 先按当天正午的偏移估算，再用估算点的偏移校正一次，夏令时切换日也落在正确的钟点。
export function wallTimeInTz(label, hour, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const m = LABEL.exec(String(label || ""));
  if (!m) return null;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wall = day + hour * (DAY_MS / 24);
  const guess = wall - tzOffsetMs(tz, day + DAY_MS / 2);
  return wall - tzOffsetMs(tz, guess);
}

// tz 下某日 00:00 的时间戳；标签不合法返回 null
export function dayStartInTz(label, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  return wallTimeInTz(label, 0, tz);
}

// 这个时刻是不是 tz 下某一天的 0 点
export function isDayStartInTz(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  return dayStartInTz(dayKeyInTz(ms, tz), tz) === ms;
}

// 某时刻所在 tz 自然日的 [开始, 结束)
export function dayBoundsInTz(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const label = dayKeyInTz(ms, tz);
  return { label, startMs: dayStartInTz(label, tz), endMs: dayStartInTz(shiftDayLabel(label, 1), tz) };
}

// [startLabel, endLabel] 闭区间内的每一天：[{ date, startMs, endMs }]
export function dayRangeInTz(startLabel, endLabel, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const out = [];
  for (let label = startLabel; label && label <= endLabel; label = shiftDayLabel(label, 1)) {
    out.push({ date: label, startMs: dayStartInTz(label, tz), endMs: dayStartInTz(shiftDayLabel(label, 1), tz) });
  }
  return out;
}

/**
 * 利润展示窗口：today / 7d / 30d 按 tz 自然日切，截至 now。
 * 上一等长窗口整窗左移 spanDays 天：今天 → 昨天同一时刻为止；7/30 天 → 前一个 7/30 天。
 */
export function resolveBusinessWindow(range, now = Date.now(), tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const r = ["today", "7d", "30d"].includes(range) ? range : "7d";
  const days = r === "30d" ? 29 : r === "7d" ? 6 : 0;
  const spanDays = days + 1;
  const todayLabel = dayKeyInTz(now, tz);
  const midnight = dayStartInTz(todayLabel, tz);
  const startMs = dayStartInTz(shiftDayLabel(todayLabel, -days), tz);
  const prevStart = dayStartInTz(shiftDayLabel(todayLabel, -days - spanDays), tz);
  return {
    range: r, tz, now, todayLabel, midnight, days, startMs, spanDays,
    prevStart, prevEnd: prevStart + (now - startMs),
  };
}
