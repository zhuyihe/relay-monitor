import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, dayStartInTz, shiftedDayStartInTz } from "./business-time.js";

// 日期筛选的预览与现有查询一致：近 7/30 天包含今天，近 24 小时按小时回退。
/** @param {string} preset @param {{tz?: string, now?: number, sinceMs?: number}} [options] */
export function presetTimeRange(preset, { tz = DEFAULT_BUSINESS_TIME_ZONE, now = Date.now(), sinceMs } = {}) {
  const today = shiftedDayStartInTz(now, 0, tz);
  const startMs = preset === "24h" ? now - 24 * 3600000
    : preset === "yesterday" ? shiftedDayStartInTz(now, -1, tz)
    : preset === "7d" ? shiftedDayStartInTz(now, -6, tz)
    : preset === "30d" ? shiftedDayStartInTz(now, -29, tz)
    : preset === "month" ? dayStartInTz(`${dayKeyInTz(now, tz).slice(0, 8)}01`, tz)
    : preset === "since" ? sinceMs ?? today : today;
  return { startMs, endMs: preset === "yesterday" ? today : now };
}
