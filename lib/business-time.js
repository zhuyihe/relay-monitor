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

// 时区名：没给就用 fallback，不合法就抛 code 为 TIMEZONE_INVALID 的错，合法的原样返回（不改写法）。
// 对账绑定现在都缺省为上海；改成业务时区是以后的事，由调用方传 fallback。
export function checkTimeZone(input, fallback = DEFAULT_BUSINESS_TIME_ZONE) {
  const tz = String(input || fallback);
  if (!isValidTimeZone(tz)) throw Object.assign(new Error("时区不对"), { code: "TIMEZONE_INVALID" });
  return tz;
}

// 时区名的规范写法（Intl 给的写法：统一大小写，别名换成它认的那个名字，如 asia/shanghai → Asia/Shanghai）；没给、不合法同 checkTimeZone
export function canonicalTimeZone(input, fallback = DEFAULT_BUSINESS_TIME_ZONE) {
  return format(checkTimeZone(input, fallback), "day").resolvedOptions().timeZone;
}

// 两个时区名是不是同一个时区（别名算同一个）；名字相同就是，否则两个都合法、规范写法也相同才是
export function sameTimeZone(a, b) {
  return a === b || isValidTimeZone(a) && isValidTimeZone(b) && canonicalTimeZone(a) === canonicalTimeZone(b);
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

// 某时刻在 tz 下的年、月、日、时（0–23）、分、秒
export function zonedParts(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const parts = format(tz, "full").formatToParts(new Date(Number(ms)));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

// 某时刻 tz 相对 UTC 的偏移毫秒（东八区为 +8h）
export function tzOffsetMs(tz, at) {
  const p = zonedParts(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

// 某时刻在 tz 下是星期几（0 = 周一）、几点（0–23），热力图按业务时区分桶用
export function weekdayHourInTz(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const p = zonedParts(ms, tz);
  return { weekday: (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7, hour: p.hour };
}

const LABEL = /^(\d{4})-(\d{2})-(\d{2})$/;

// 日期标签 ± n 天（纯日历运算，不受夏令时影响）
export function shiftDayLabel(label, days) {
  const m = LABEL.exec(String(label || ""));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

// tz 下某日 hour 点整的时间戳；标签不合法返回 null。
// 同一钟点出现两次时取较早的一次；钟点被跳过时取跳变后的第一个有效时刻。
// 不能用正午的偏移猜零点：回拨发生在午夜时，那样会漏掉第一次 00:00。
export function wallTimeInTz(label, hour, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  const m = LABEL.exec(String(label || ""));
  if (!m) return null;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wall = day + hour * (DAY_MS / 24);
  // 收集目标附近的偏移，逐个生成候选，再反向验证实际的本地钟点。
  // 前后两天同时覆盖跨午夜的切换，以及跨日期变更线造成的整日跳过。
  const offsets = new Set([-2, -1, 0, 1, 2].map((days) => tzOffsetMs(tz, wall + days * DAY_MS)));
  const candidates = [...offsets].map((offset) => wall - offset).sort((a, b) => a - b);
  const localTime = (at) => at + tzOffsetMs(tz, at);
  const exact = candidates.find((at) => localTime(at) === wall);
  if (exact != null) return exact;

  // 不存在的钟点位于向前跳变的缺口内。候选分处缺口两边，二分找出
  // 第一个到达目标本地钟点之后的真实时刻；午夜缺失时即当天的起点。
  for (let i = 1; i < candidates.length; i++) {
    let before = candidates[i - 1], after = candidates[i];
    if (localTime(before) >= wall || localTime(after) <= wall) continue;
    while (after - before > 1) {
      const middle = Math.floor((before + after) / 2);
      if (localTime(middle) < wall) before = middle;
      else after = middle;
    }
    return after;
  }
  return null;
}

// tz 下某日最早的有效时刻（通常为 00:00）；标签不合法返回 null
export function dayStartInTz(label, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  return wallTimeInTz(label, 0, tz);
}

// ms 在 tz 下那一天往后（负数往前）数 days 天，那一天最早的有效时刻；days 为 0 就是当天 0 点
export function shiftedDayStartInTz(ms, days, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  return dayStartInTz(shiftDayLabel(dayKeyInTz(ms, tz), days), tz);
}

// 这个时刻是不是 tz 下某一天的 0 点
export function isDayStartInTz(ms, tz = DEFAULT_BUSINESS_TIME_ZONE) {
  return dayStartInTz(dayKeyInTz(ms, tz), tz) === ms;
}

// 窗口恰好是它自己时区下的一整天时给出那天（YYYY-MM-DD），否则 null。账本按这个日期记账；没写时区的窗口不算
export function billDayOf(window) {
  if (!window || typeof window.timezone !== "string" || !window.timezone
    || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) return null;
  try {
    const label = dayKeyInTz(window.startMs, window.timezone);
    return dayStartInTz(label, window.timezone) === window.startMs
      && dayStartInTz(shiftDayLabel(label, 1), window.timezone) === window.endMs ? label : null;
  } catch {
    return null;
  }
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
