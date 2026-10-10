// 展示层的数字格式：金额、百分比、天数、坐标轴。
// 规则来自 design/ui-design-spec.md：真减号 −、估算加 "≈ "、千分位、两位小数、不用科学计数法。
// 纯函数，服务端和客户端都能用；单测见 lib/format.test.js。

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
