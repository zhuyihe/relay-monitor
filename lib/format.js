// 展示层的数字格式：金额、百分比、天数、坐标轴。
// 规则来自 design/ui-design-spec.md：真减号 −、估算加 "≈ "、千分位、两位小数、不用科学计数法。
// 纯函数，服务端和客户端都能用；单测见 lib/format.test.js。
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, isDayStartInTz } from "./business-time.js";

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

// 小额单价（¥/M token 等）：至少两位，最多四位小数；舍入后是 0 的不带负号（同 formatMoney）
export function formatUnitPrice(v, { symbol = "¥" } = {}) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const zero = Number(body.replace(/,/g, "")) === 0;
  return `${n < 0 && !zero ? MINUS : ""}${symbol}${body}`;
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

// 可用天数（design/ui-copy-spec.md §3.3）：1 天以上四舍五入写「约 3 天」，不到 1 天写「约 5 小时」，
// 不到 1 小时写「不到 1 小时」，近期没有花费（Infinity）写「近期没有花费」，算不出写「—」。
// 句子里写「可用约 3 天」，由调用方在前面加「可用」；近期没有花费时不要加。
export const NO_SPEND_TEXT = "近期没有花费";
export function formatDays(d) {
  if (d === Infinity) return NO_SPEND_TEXT;
  if (!isNum(d)) return EMPTY;
  const n = Math.max(0, Number(d));
  if (n >= 1) return `约 ${fixed(Math.round(n), 0)} 天`;
  if (n * 24 < 1) return "不到 1 小时";
  const hours = Math.round(n * 24);
  return hours >= 24 ? "约 1 天" : `约 ${hours} 小时`;
}

// 余额的档位名（§3.3）：只有余额用完、余额偏低、快用完三档，另有还没读到、读不到两种情况。
// 判定在 lib/overview-actions.js 的 balanceStateOf，这里只管叫法。
export const BALANCE_STATE_TEXT = Object.freeze({
  empty: "余额用完",
  low: "余额偏低",
  soon: "快用完",
  pending: "还没读取",
  unreadable: "读不到余额",
});
// 快用完的那一句：「快用完，可用约 3 天」，运营总览的余额行和「需要处理」的合并行共用
export const soonText = (etaDays) => `${BALANCE_STATE_TEXT.soon}，可用${formatDays(etaDays)}`;

// 一个上游的成本是怎么来的（§3.3）；键和成本明细里的 mode 一致
export const COST_MODE_TEXT = Object.freeze({
  usage: "按用量算",
  history: "按余额变化估算",
  fixed: "固定成本",
});

// 日均花费、可用天数按哪段花费估出来（§3.3）。basis 是 db/history.js 给的「近3小时」「近12小时」，
// 其余（按走势拟合的、没给的）都写「按近期花费走势估算」。
export function basisText(basis) {
  const hours = /^近\s*(\d+)\s*小时$/.exec(String(basis || "").trim());
  return hours ? `按近 ${hours[1]} 小时的花费估算` : "按近期花费走势估算";
}

export function formatInt(v) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  return `${n < 0 ? MINUS : ""}${fixed(Math.abs(n), 0)}`;
}

// 汇率（design/ui-copy-spec.md §3.2、§7）：「1 美元 = 7.20 元」，最多四位小数；没设置写 RATE_UNSET_* 里对应页面的那句
// RATE_UNSET 是表格里放不下整句时的短写法，悬停里再写整句
export const RATE_UNSET = "没设置汇率";
export const RATE_UNSET_USD = `${RATE_UNSET}，按美元显示`;
export const RATE_UNSET_PARITY = `${RATE_UNSET}，暂按 1 美元 = 1 元算`;
// 还没设置自营站点（§8.1）：页面和服务端提示都用这一句，按钮写「去设置」
export const OWN_STATION_UNSET_TITLE = "还没设置自营站点";
// 怎么设置：自营业务引导页的第一步写成标题 + 说明，其余地方连成一句（OWN_STATION_UNSET_HINT）
export const OWN_STATION_UNSET_STEP = Object.freeze({ title: "在上游资源里编辑你的 New API 站点", desc: "打开「这是我的自营站点」。" });
export const OWN_STATION_UNSET_HINT = `${OWN_STATION_UNSET_STEP.title}，${OWN_STATION_UNSET_STEP.desc}`;
export const OWN_STATION_UNSET = `${OWN_STATION_UNSET_TITLE}：${OWN_STATION_UNSET_HINT}`;
// 自营站点这一栏的名字（§3.1）：上游列表的标记、渠道绑定、成本估算、日报共用；自营站点没起名字时也写它
export const OWN_STATION_LABEL = "自营站点";
// 「需要处理」列表空的时候（§8.1），后面可以跟「数据截至 14:32。」
export const NOTHING_TO_HANDLE = "没有需要处理的事。";
// 一个上游都没有时（§11）
export const NO_UPSTREAM_TEXT = "还没有上游";
// 加载中只给读屏的那句（§8.1：首次加载不写字）：面板骨架、上游列表、整页加载共用
export const LOADING_TEXT = "正在加载";
// Token 数的说明（§3.4）：看板和用量接口的 Token 只算输入和输出，不含缓存
export const TOKEN_NOTE = "Token（不含缓存）：只算输入和输出";
// 时间范围名（§6）：同一个范围全站一个名字，各页挑自己用的几项（近 24 小时：用量分析、余额趋势；近 3 天：余额趋势）
export const RANGE_TEXT = Object.freeze({ today: "今天", "24h": "近 24 小时", "3d": "近 3 天", "7d": "近 7 天", "30d": "近 30 天", "90d": "近 90 天" });
// 包月、按天平摊的上游：上游成本那一栏写这句，不按用量算（§9）
export const FIXED_COST_TEXT = "计入固定成本";
// 上游已经删掉、只剩编号时，名字写这句（§3.1）
export const UPSTREAM_GONE = "已删除的上游";
const rateNumber = (cnyPerUsd) => {
  const n = Number(cnyPerUsd);
  if (cnyPerUsd == null || !Number.isFinite(n) || n <= 0) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false });
};
export function formatRate(cnyPerUsd) {
  const n = rateNumber(cnyPerUsd);
  return n ? `1 美元 = ${n} 元` : "";
}
// 自营站点的售价（§3.2、§7）：存的也是 cnyPerUsd，但说的是给用户充 1 美元额度收多少元，和上游的汇率分开说
export const SELL_PRICE_UNSET = "没设置售价，暂按 1 美元额度 = 1 元算";

// 「利润怎么算」（§11）：自营业务的面板名和按钮、日报里利润说明那一行共用
export const BASIS_TITLE = "利润怎么算";

// 预计花费下面的说法（§3.4）：「按过去 34 天估算」「过去 2 周平均差 ±8%」，自营业务的预计花费和日报共用。
// 页面把天数和百分比加粗，所以拆成几段
export const FORECAST_TEXT = Object.freeze({
  sampleLead: "按过去",
  sampleDays: (n) => `${n} 天`,
  sampleTail: "估算",
  accuracy: "过去 2 周平均差",
  accuracyPct: (pct) => `±${pct}%`,
});

// 用户列表读不到时，消费排行里标不出谁是管理员：日报和自营业务的用户块同一句（design/ui-copy-spec.md §8.1、§10）
export const ADMIN_UNMARKED = "用户身份没读到，管理员没标出";

// 读不到自营站点的收入时（读取失败、收入确认不了）利润等式和收入块的说法：运营总览、自营业务、成本估算共用（design/ui-copy-spec.md §8.1）。
// 收入那一格写 empty，毛利、净利下面写 profit；说明写「title：原因。」再接 costOnly
export const INCOME_UNREAD = Object.freeze({
  empty: "读不到",
  profit: "读不到收入",
  title: "读不到自营站点的收入",
  costOnly: "这里只算成本。",
});
export function formatSellPrice(cnyPerUsd) {
  const n = rateNumber(cnyPerUsd);
  return n ? `1 美元额度 = ${n} 元` : "";
}

// Token、请求数等大数（§7）：一万以上写「1.2 万」「3.4 亿」，最多一位小数；一万以下写整数
const compactNf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
export function formatCompact(v) {
  if (!isNum(v)) return EMPTY;
  const n = Number(v);
  const a = Math.abs(n);
  // 按舍入后的值选单位：9999.6 写「1 万」，9999.96 万写「1 亿」，不出现「10,000」「10,000 万」
  const wan = Math.round(a / 1e3) / 10;
  const body = Math.round(a) < 1e4 ? fixed(a, 0)
    : wan < 1e4 ? `${compactNf.format(wan)} 万`
    : `${compactNf.format(Math.round(a / 1e7) / 10)} 亿`;
  return `${n < 0 && body !== "0" ? MINUS : ""}${body}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

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
  return formatDayKey(dayKeyInTz(ms, timezone), timezone, now);
}

// 日历日「2026-10-09」拆成 [年, 月, 日]；格式不对，或日历上没有这一天（2 月 30 日、13 月）时返回 null
function dayKeyParts(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

// 业务时区的一天「2026-10-09」（接口按天给的 date / t）：今年「10月9日」，往年「2025年10月9日」。
// 已经是日历日，不再按哪个时区换算；timezone 只用来判断「今年」
export function formatDayKey(key, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const parts = dayKeyParts(key);
  if (!parts) return EMPTY;
  const thisYear = Number(dayKeyInTz(now, timezone || DEFAULT_TIMEZONE).slice(0, 4));
  return `${parts[0] !== thisYear ? `${parts[0]}年` : ""}${parts[1]}月${parts[2]}日`;
}

// 业务时区的一天是周几：「周五」。按日历算，和浏览器时区无关；认不出的日期返回空串
export function weekdayOfDayKey(key) {
  const parts = dayKeyParts(key);
  return parts ? WEEKDAYS[new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()] : "";
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

// 「数据截至」后面那段：当天只写「14:30」，不是当天写「10月9日 14:30」。表格里列名叫「数据截至」时格子里只放这段
export function formatAsOfTime(value, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const d = validDate(value);
  if (!d) return EMPTY;
  const zone = timezone || DEFAULT_TIMEZONE;
  return dayKeyInTz(d.getTime(), zone) === dayKeyInTz(now, zone) ? formatZonedTime(d, zone) : formatZonedDateTime(d, zone, now);
}

// 当天「数据截至 14:30」，不是当天「数据截至 10月9日 14:30」
export function formatAsOf(value, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  return validDate(value) ? `数据截至 ${formatAsOfTime(value, timezone, now)}` : EMPTY;
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
  const midnight = (ms) => isDayStartInTz(ms, zone);
  const lastDay = dayKeyInTz(end - 1, zone);
  if (midnight(start) && midnight(end)) return dayKeyInTz(start, zone) === lastDay ? date(start) : `${date(start)}–${date(end - 1)}`;
  const endText = midnight(end) ? "24:00" : time(end);
  return dayKeyInTz(start, zone) === lastDay ? `${date(start)} ${time(start)}–${endText}` : `${date(start)} ${time(start)}–${date(end - 1)} ${endText}`;
}

// 利润等式标题下「从哪天到现在」（§6）：从今天 0 点起写「0:00–14:30」，更早写「10月14日–今天」。
// 运营总览和自营业务共用；startMs 是这段时间的开始（业务时区某天的 0 点）
export function formatSinceToday(startMs, timezone = DEFAULT_TIMEZONE, now = Date.now()) {
  const start = validDate(startMs);
  if (!start) return EMPTY;
  const zone = timezone || DEFAULT_TIMEZONE;
  // 开始在今天（或晚于现在，按今天写）：从 0 点写到现在
  return dayKeyInTz(start.getTime(), zone) >= dayKeyInTz(now, zone)
    ? `0:00–${formatZonedTime(now, zone)}`
    : `${zonedDateText(start.getTime(), zone, now)}–今天`;
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
