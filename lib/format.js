// 展示层的数字格式：金额、百分比、天数、坐标轴。
// 规则来自 design/ui-design-spec.md：真减号 −、估算加 "≈ "、千分位、两位小数、不用科学计数法。
// 纯函数，服务端和客户端都能用；单测见 lib/format.test.js。
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, dayStartInTz } from "./business-time.js";

export const MINUS = "−";
export const EMPTY = "—";

const nf = (dp) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const NF = [nf(0), nf(1), nf(2), nf(3), nf(4)];
const fixed = (v, dp) => (NF[dp] || nf(dp)).format(v);

const isNum = (v) => v != null && v !== "" && Number.isFinite(Number(v));

/**
 * 人民币金额。null / NaN 显示 "—"。
 * @param {number | null | undefined} v
 * @param {{ approx?: boolean, dp?: number, sign?: boolean, symbol?: string }} [opts]
 */
export function formatMoney(v, { approx = false, dp = 2, sign = false, symbol = "¥" } = {}) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  // 四舍五入后为 0 时不带符号，避免出现 "−¥0.00"
  const zero = Number(fixed(Math.abs(n), dp).replace(/,/g, "")) === 0;
  const lead = zero ? "" : n < 0 ? MINUS : sign && n > 0 ? "+" : "";
  return `${approx ? "≈ " : ""}${lead}${symbol}${fixed(Math.abs(n), dp)}`;
}

export const formatCny = (v, opts) => formatMoney(v, opts);
export const formatUsd = (v, opts) => formatMoney(v, { ...opts, symbol: "$" });

// 小额单价（¥/M token 等）：至少两位，最多四位小数
export function formatUnitPrice(v, { symbol = "¥" } = {}) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return `${n < 0 ? MINUS : ""}${symbol}${body}`;
}

// 坐标轴金额：千以上用 k（1.5k、12k）；其余按刻度间距 step 取刚好够用的小数位，
// 避免 ¥0.25 / ¥0.5 都显示成 ¥0、¥2.5 显示成 ¥3
export function axisMoney(v, step = 1) {
  const a = Math.abs(v);
  let dp = 0;
  while (dp < 2 && Math.abs(step * 10 ** dp - Math.round(step * 10 ** dp)) > 1e-6) dp++;
  const s = a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : fixed(a, dp);
  return `${v < 0 && a > 0 ? MINUS : ""}¥${s}`;
}

// 比例 → 百分比文本；ratio 为 0.123 表示 12.3%
export function formatPct(ratio, dp = 1) {
  if (!isNum(ratio)) return EMPTY;
  const n = Number(ratio) * 100;
  return `${n < 0 ? MINUS : ""}${Math.abs(n).toFixed(dp)}%`;
}

// 环比等带符号的百分比
export function formatDeltaPct(ratio, dp = 1) {
  if (!isNum(ratio)) return EMPTY;
  const n = Number(ratio) * 100;
  const body = Math.abs(n).toFixed(dp);
  if (Number(body) === 0) return `${body}%`;
  return `${n < 0 ? MINUS : "+"}${body}%`;
}

// 可用天数：不足一天按小时说
export function formatDays(d) {
  if (!isNum(d)) return "无法计算";
  const n = Number(d);
  if (n < 1) return `约 ${Math.max(1, Math.round(n * 24))} 小时`;
  return `${fixed(n, 1)} 天`;
}

export function formatInt(v) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  return `${n < 0 ? MINUS : ""}${fixed(Math.abs(n), 0)}`;
}

// 汇率（design/ui-copy-spec.md §3.2、§7）：「1 美元 = 7.20 元」，最多四位小数；没设置写 RATE_UNSET_* 里对应页面的那句
export const RATE_UNSET_USD = "没设置汇率，按美元显示";
export const RATE_UNSET_PARITY = "没设置汇率，暂按 1 美元 = 1 元算";
// 还没设置自营站点（§8.1）：页面和服务端提示都用这一句，按钮写「去设置」
export const OWN_STATION_UNSET_TITLE = "还没设置自营站点";
export const OWN_STATION_UNSET_HINT = "在上游资源里编辑你的 New API 站点，打开「这是我的自营站点」。";
export const OWN_STATION_UNSET = `${OWN_STATION_UNSET_TITLE}：${OWN_STATION_UNSET_HINT}`;
// 「需要处理」列表空的时候（§8.1），后面可以跟「数据截至 14:32。」
export const NOTHING_TO_HANDLE = "没有需要处理的事。";
// 包月、按天平摊的上游：上游成本那一栏写这句，不按用量算（§9）
export const FIXED_COST_TEXT = "计入固定成本";
export function formatRate(cnyPerUsd) {
  const n = Number(cnyPerUsd);
  if (cnyPerUsd == null || !Number.isFinite(n) || n <= 0) return "";
  return `1 美元 = ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false })} 元`;
}

// Token 等大数：K / M / B，最多一位小数
export function formatCompact(v) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  const a = Math.abs(n);
  const unit = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : null;
  const body = unit ? `${+(a / unit[0]).toFixed(1)}${unit[1]}` : fixed(a, 0);
  return `${n < 0 ? MINUS : ""}${body}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

export function formatHhmm(ts) {
  if (ts == null) return EMPTY;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 按指定时区显示时刻，不用浏览器时区；缺省业务时区的默认值。
// 用 hourCycle h23 而不是 hour12:false，避免部分环境把零点显示成 24:00。
const DEFAULT_TIMEZONE = DEFAULT_BUSINESS_TIME_ZONE;
const clockFormats = new Map();
function clockFormat(timezone) {
  const zone = timezone || DEFAULT_TIMEZONE;
  let format = clockFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hourCycle: "h23", hour: "numeric", minute: "2-digit" });
    clockFormats.set(zone, format);
  }
  return format;
}
const validDate = (value) => {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// 下面几个按 design/ui-copy-spec.md §6 写日期和时刻：24 小时制、不写秒、不写时区。
// timezone 传业务时区（接口返回的 tz）；now 只用来判断「今年」「今天」，测试里可以传固定时刻。
function zonedDateText(ms, timezone, now) {
  const [year, month, day] = dayKeyInTz(ms, timezone).split("-").map(Number);
  const thisYear = Number(dayKeyInTz(now, timezone).slice(0, 4));
  return `${year !== thisYear ? `${year}年` : ""}${month}月${day}日`;
}

// 14:30、0:05
export function formatZonedTime(value, timezone) {
  const d = validDate(value);
  return d ? clockFormat(timezone).format(d) : EMPTY;
}

// 今年「10月9日」，往年「2025年10月9日」
export function formatZonedDate(value, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const d = validDate(value);
  return d ? zonedDateText(d.getTime(), timezone || DEFAULT_TIMEZONE, now) : EMPTY;
}

// 10月9日 14:30
export function formatZonedDateTime(value, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const d = validDate(value);
  return d ? `${zonedDateText(d.getTime(), timezone || DEFAULT_TIMEZONE, now)} ${formatZonedTime(d, timezone)}` : EMPTY;
}

// 当天「数据截至 14:30」，不是当天「数据截至 10月9日 14:30」
export function formatAsOf(value, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const d = validDate(value);
  if (!d) return EMPTY;
  const zone = timezone || DEFAULT_TIMEZONE;
  return dayKeyInTz(d.getTime(), zone) === dayKeyInTz(now, zone) ? `数据截至 ${formatZonedTime(d, zone)}` : `数据截至 ${formatZonedDateTime(d, zone, now)}`;
}

// 刷新失败、还在显示上次读到的数据时（design/ui-copy-spec.md §8.1）：「刷新失败，数据截至 14:30。」；从来没读到过只写「刷新失败」
export function refreshFailedText(asOf, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  return validDate(asOf) ? `刷新失败，${formatAsOf(asOf, timezone, now)}。` : "刷新失败";
}

// 一段时间 [startMs, endMs)：整天只写日期「10月9日」，几整天写「10月1日–10月7日」；
// 不是整天的写到时刻「10月9日 0:00–14:30」「10月8日 12:00–10月9日 14:30」，结束在零点的写成当天 24:00。
export function formatZonedRange(startMs, endMs, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const start = Number(startMs), end = Number(endMs);
  if (startMs == null || endMs == null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return EMPTY;
  const zone = timezone || DEFAULT_TIMEZONE;
  const date = (ms) => zonedDateText(ms, zone, now), time = (ms) => formatZonedTime(ms, zone);
  const midnight = (ms) => dayStartInTz(dayKeyInTz(ms, zone), zone) === ms;
  const lastDay = dayKeyInTz(end - 1, zone);
  if (midnight(start) && midnight(end)) return dayKeyInTz(start, zone) === lastDay ? date(start) : `${date(start)}–${date(end - 1)}`;
  const endText = midnight(end) ? "24:00" : time(end);
  return dayKeyInTz(start, zone) === lastDay ? `${date(start)} ${time(start)}–${endText}` : `${date(start)} ${time(start)}–${date(end - 1)} ${endText}`;
}

// 和业务时区不同的一天怎么说（§6）：「按 UTC 时间算一天」「按日本标准时间算一天」；时区相同不写。
export function formatDayZone(timezone, businessTimezone = DEFAULT_TIMEZONE) {
  if (!timezone || timezone === (businessTimezone || DEFAULT_TIMEZONE)) return "";
  if (/^(Etc\/)?(UTC|UCT|GMT|Zulu|Universal)$/.test(timezone)) return "按 UTC 时间算一天";
  let name = "";
  try {
    name = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, timeZoneName: "longGeneric" }).formatToParts(0)
      .find((part) => part.type === "timeZoneName")?.value || "";
  } catch { name = ""; }
  return name && !/^GMT/.test(name) ? `按${name}算一天` : "按上游的时区算一天";
}

// 绑定的一天或一段 { startMs, endMs, timezone }
export function formatZonedWindow(window, now = Date.now()) {
  return formatZonedRange(window?.startMs, window?.endMs, window?.timezone, now);
}

// 9月24日
export function formatMonthDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getMonth() + 1}月${x.getDate()}日`;
}

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// "YYYY-MM-DD" 按本地时区解析（new Date("2026-09-24") 会按 UTC）
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isoDay(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 按比例拆分总数，最后一项取余数，保证分项之和与总数一致
export function splitTotal(total, shares) {
  const round2 = (v) => Math.round(v * 100) / 100;
  let left = round2(total);
  return shares.map((s, i) => {
    const value = i === shares.length - 1 ? round2(left) : round2(total * s);
    left -= value;
    return value;
  });
}
