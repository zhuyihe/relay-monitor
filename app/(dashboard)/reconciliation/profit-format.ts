// 每日利润页的纯函数：差额那一格怎么写、原因码翻成字、筛选和数法、每天小格的状态、页顶一句、四个数、合计行、表下面那一行。
// 不含 JSX，页面组件和单元测试（profit-format.test.js，node 直接跑）共用；导入带 .js 后缀。
// 钱：接口给美元原币，整页按 displayCurrency 换算——收入按自营站点的汇率、成本和差额按这个上游的汇率（行上的 rates）；
// 按美元显示时不换算。金额不上色、不写 0（今天、算不出的写「明天出」「—」），写法按 design/ui-copy-spec.md §5.7、§6、§7。
import type { ProfitDayCell, ProfitDetailResponse, ProfitPageResponse, ProfitRow, ReconciliationCurrency } from "../../../lib/client";
import { formatReconciliationMoney } from "../../../lib/reconciliation-view.js";
import { EMPTY, MINUS, RATE_UNSET_USD, UPSTREAM_GONE, formatAsOfTime, formatCompact, formatDayKey, formatPct, formatUnitPrice, formatZonedTime, weekdayOfDayKey } from "../../../lib/format.js";
import { dayKeyInTz, dayStartInTz, shiftDayLabel, tzOffsetMs } from "../../../lib/business-time.js";
import { COPY } from "./copy"; // 同目录的 .ts 不带后缀（Turbopack 不认 "./copy.js"；node 跑测试时 profit-format.test.js 的 resolve 钩子补 .ts）

export type ProfitFilter = "all" | "mismatched" | "attention";
export type RowTone = "over" | "attention" | "under" | null;
// zoneOf：这一行上游算一天的时区（从绑定配置里取），只给 DAY_BOUNDARY_UNSUPPORTED 那一句写时差用
export type Ctx = { currency: ReconciliationCurrency; tz: string; now?: number; zoneOf?: (row: ProfitRow) => string | null | undefined };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

// ---- 钱 ----
// 美元原币 → 显示币种的数；按美元显示时原样，人民币按这一侧的汇率乘
export const toDisplay = (usd: number | null | undefined, rate: number | null | undefined, currency: ReconciliationCurrency) =>
  usd == null || !finite(usd) ? null : currency === "CNY" && finite(rate) && rate > 0 ? usd * rate : usd;
// 已经是显示币种的数写成「$1.20」「¥8.64」；null 写「—」
export const fmtMoney = (value: number | null | undefined, currency: ReconciliationCurrency) => formatReconciliationMoney(value, currency === "CNY" ? 1 : null);
// 带正负号的差额「+$0.01」「−$0.50」（门槛以内照常写数）；0 写「$0.00」
export function signedMoney(value: number | null | undefined, currency: ReconciliationCurrency) {
  if (value == null || !finite(value)) return EMPTY;
  const text = fmtMoney(Math.abs(value), currency);
  return value > 0 ? `+${text}` : value < 0 ? `${MINUS}${text}` : text;
}
// 「多扣 $1.20」「少扣 $0.50」；正的是多扣（实付 − 应付）
export const overUnderText = (value: number, currency: ReconciliationCurrency) =>
  value < 0 ? COPY.gap.under(fmtMoney(Math.abs(value), currency)) : COPY.gap.over(fmtMoney(value, currency));
// 「比应付多 15%」「比应付少 3.6%」：整数不带小数，否则一位
const pctText = (rate: number) => { const pct = Math.abs(rate) * 100; return `${Number.isInteger(Math.round(pct * 10) / 10) ? Math.round(pct) : (Math.round(pct * 10) / 10).toFixed(1)}%`; };
export const rateText = (rate: number) => rate < 0 ? COPY.gap.underRate(pctText(rate)) : COPY.gap.overRate(pctText(rate));

// 一行各项在显示币种下的数：收入按自营站点的汇率，成本、应付、差额按这个上游的汇率；毛利 = 收入 − 实付（两边各自换算后再减）
export function rowMoney(row: ProfitRow, currency: ReconciliationCurrency) {
  const income = toDisplay(row.incomeUsd, row.rates?.income, currency), actual = toDisplay(row.actualCostUsd, row.rates?.cost, currency);
  return {
    income, actual,
    uncountedIncome: toDisplay(row.uncountedIncomeUsd, row.rates?.income, currency),
    expected: toDisplay(row.expectedCostUsd, row.rates?.cost, currency),
    gap: toDisplay(row.gap?.usd, row.rates?.cost, currency),
    latestGap: toDisplay(row.latestSettledGap?.usd, row.rates?.cost, currency),
    gross: currency === "CNY" ? (income != null && actual != null ? income - actual : null) : toDisplay(row.grossProfitUsd, null, currency),
  };
}

// 整页的数在显示币种下：按美元直接用接口的 pageTotals / gap；按人民币时各行按各自的汇率换算再加（接口只给美元）
export function pageMoney(page: ProfitPageResponse, currency: ReconciliationCurrency) {
  const counted = page.rows.filter((row) => row.counted);
  if (currency !== "CNY") {
    const latest = page.latestSettledGap;
    return { income: page.pageTotals.incomeUsd, actual: page.pageTotals.actualCostUsd, gross: page.pageTotals.grossProfitUsd, fixedCost: page.fixedCostUsd, fixedExact: true, net: page.netProfitUsd,
      gap: page.gap.usd, over: page.gap.overUsd, under: page.gap.underUsd, within: page.gap.withinUsd, latestGap: latest?.usd ?? null, unaccounted: page.unaccountedUpstreamCostUsd, approx: false };
  }
  const moneys = counted.map((row) => rowMoney(row, currency));
  const income = counted.length ? sum(moneys.map((item) => item.income ?? 0)) : null, actual = counted.length ? sum(moneys.map((item) => item.actual ?? 0)) : null;
  const gross = income != null && actual != null ? income - actual : null;
  const judged = page.rows.filter((row) => row.gap?.usd != null);
  const dayGap = (row: ProfitRow, state: "over" | "under") => sum(row.gap.mismatchedDays.filter((item) => item.state === state).map((item) => toDisplay(item.usd, row.rates?.cost, currency) ?? 0));
  const gap = judged.length ? sum(judged.map((row) => toDisplay(row.gap.usd, row.rates?.cost, currency) ?? 0)) : null;
  const over = sum(judged.map((row) => dayGap(row, "over"))), under = -sum(judged.map((row) => dayGap(row, "under")));
  // 固定成本接口只给美元（各上游按自己的汇率换过来的），这里按自营站点的汇率换回去只能是近似；没有汇率时不写
  const ownRate = page.rows.find((row) => finite(row.rates?.income))?.rates.income ?? null;
  // 显示人民币：直接用接口给的人民币原值；显示美元：用各上游自己的汇率折好的美元数（不经自营站点的汇率）
  const fixedCost = currency === "CNY" && page.fixedCostCny !== undefined ? page.fixedCostCny : toDisplay(page.fixedCostUsd, ownRate, currency);
  const latestRows = page.latestSettledGap ? page.rows.filter((row) => row.latestSettledGap?.day === page.latestSettledGap!.day && row.latestSettledGap?.usd != null) : [];
  return { income, actual, gross, fixedCost, fixedExact: currency === "CNY" && page.fixedCostCny !== undefined, net: gross != null && fixedCost != null ? gross - fixedCost : null,
    gap, over, under, within: gap == null ? 0 : gap - over + under,
    latestGap: latestRows.length ? sum(latestRows.map((row) => toDisplay(row.latestSettledGap!.usd, row.rates?.cost, currency) ?? 0)) : null,
    // 固定成本、没算进利润的上游成本是按自营站点的汇率换回来的，写的时候带「≈」（用语规范 §7）
    unaccounted: toDisplay(page.unaccountedUpstreamCostUsd, ownRate, currency), approx: true };
}

// ---- 范围 ----
export const dayCount = (page: ProfitPageResponse) => page.dayCounts.fixed + page.dayCounts.reading + page.dayCounts.today;
// 看今天：范围里只有今天
export const isTodayView = (page: ProfitPageResponse) => page.dayCounts.today > 0 && page.dayCounts.fixed === 0 && page.dayCounts.reading === 0;
// 范围里的日子全都固定了（昨天，或者全在过去、也全固定了的范围）：出应付成本那一列
export const isAllFixed = (page: ProfitPageResponse) => page.dayCounts.fixed > 0 && page.dayCounts.reading === 0 && page.dayCounts.today === 0;
export const isSingleDay = (page: ProfitPageResponse) => dayCount(page) === 1;
export const yesterdayOf = (page: ProfitPageResponse) => shiftDayLabel(page.today, -1);
// 范围的第一天和最后一天（标签）
export function rangeDays(page: ProfitPageResponse) {
  const first = dayKeyInTz(page.range.startMs, page.range.timezone);
  const last = page.dayCounts.today > 0 ? page.today : dayKeyInTz(page.range.endMs - 1, page.range.timezone);
  return { first, last: last < first ? first : last };
}
// 「10月20日–10月26日」，一天只写一天（§6）
export function rangeText(page: ProfitPageResponse, ctx: Ctx) {
  const { first, last } = rangeDays(page);
  const day = (label: string) => formatDayKey(label, ctx.tz, ctx.now);
  return first === last ? day(first) : `${day(first)}–${day(last)}`;
}
// 页顶一句（设计稿 §2）
export function rangeCaption(page: ProfitPageResponse, ctx: Ctx) {
  const asOf = Date.parse(page.asOf);
  if (isTodayView(page)) return `${formatDayKey(page.today, ctx.tz, ctx.now)} 0:00–${formatZonedTime(Number.isFinite(asOf) ? asOf : ctx.now ?? Date.now(), ctx.tz)} · ${COPY.todayCaption}`;
  const text = rangeText(page, ctx);
  if (page.range?.preset === "since") return `${text} · ${COPY.presets.since}`; // 「10月20日–今天 · 开始算以来」
  if (isSingleDay(page)) return `${text} ${weekdayOfDayKey(rangeDays(page).first)} · ${page.dayCounts.fixed ? COPY.fixed : COPY.gap.reading}`;
  if (isAllFixed(page)) return `${text} · ${COPY.fixed}`;
  const parts = [page.dayCounts.fixed ? COPY.daysFixed(page.dayCounts.fixed) : "", page.dayCounts.reading ? COPY.daysReading(page.dayCounts.reading) : "", page.dayCounts.today ? COPY.todayLive : ""].filter(Boolean);
  return `${text} · ${parts.join("，")}`;
}

// ---- 轮询 ----
// 范围里含今天才轮询（不带 observe）：「今天」和终点晚于今天 0 点的自定义范围 30 秒一次；「近 7 天」「本月」也含今天，和旧页面一样 5 分钟一次
// （不比旧页面多发请求）；昨天、不含今天的自定义范围的日子都已固定，不轮询（审核 #128）。
// 例外：不管选的哪个范围，当前结果里还有「还在读取」的日子（零点以后正在结账的那几个小时）就 5 分钟重读一次，没有了就停（审核 2 #128）。tz 是接口给的业务时区，没读到页面数据时用默认
export const LIVE_POLL_MS = 30000;
export const LIVE_POLL_LONG_MS = 300000;
export function livePollMs(window: { preset: string; startMs?: number; endMs?: number }, now: number, tz?: string | null, reading = false): number | null {
  const base = livePollBase(window, now, tz);
  return base ?? (reading ? LIVE_POLL_LONG_MS : null);
}
function livePollBase(window: { preset: string; startMs?: number; endMs?: number }, now: number, tz?: string | null): number | null {
  if (window.preset === "today") return LIVE_POLL_MS;
  if (window.preset === "7d" || window.preset === "month" || window.preset === "since") return LIVE_POLL_LONG_MS;
  if (window.preset === "custom" && Number.isFinite(window.endMs)) return (window.endMs as number) > dayStartInTz(dayKeyInTz(now, tz || undefined), tz || undefined) ? LIVE_POLL_MS : null;
  return null;
}

// ---- 原因码 → 字（§5.7）----
// 「UTC+5:30」「UTC+5:45」「UTC−3」：这个时区此刻和 UTC 差多少
export function utcOffsetText(zone: string, at = Date.now()) {
  let offset = 0;
  try { offset = tzOffsetMs(zone, at); } catch { return "UTC"; }
  const minutes = Math.round(offset / 60000), abs = Math.abs(minutes);
  if (!minutes) return "UTC";
  return `UTC${minutes < 0 ? MINUS : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}
// settled：这天固定了没有（「算应付成本」关着的两种写法）；zone：这一行上游算一天的时区（一天不从整点开始那一句）
export function gapReasonText(reason: string | null | undefined, missingModels: string[] = [], { settled = true, zone = null as string | null | undefined, tieredModels = [] as string[], keyChangeWhen = null as string | null } = {}) {
  if (!reason) return "";
  if (reason === "KEY_CHANGE_RATIO_DIFFERS" && keyChangeWhen) return COPY.gap.keyChangeRatio(keyChangeWhen);
  if (reason === "MODEL_PRICE_MISSING") {
    const names = (missingModels || []).filter(Boolean);
    return !names.length ? COPY.gap.missingPriceUnnamed : names.length === 1 ? COPY.gap.missingPrice(names[0]) : COPY.gap.missingPrices(names[0], names.length);
  }
  if (reason === "MODEL_PRICE_TIERED") {
    const names = (tieredModels || []).filter(Boolean);
    return !names.length ? COPY.gap.tieredPriceUnnamed : names.length === 1 ? COPY.gap.tieredPrice(names[0]) : COPY.gap.tieredPrices(names[0], names.length);
  }
  if (reason === "EXPECTED_COST_DISABLED" && !settled) return COPY.gap.disabledNow;
  if (reason === "DAY_BOUNDARY_UNSUPPORTED") return COPY.gap.dayBoundary(utcOffsetText(zone || "UTC"));
  return (COPY.gap.reason as Record<string, string>)[reason] || COPY.gap.unknown;
}

// ---- 一行 ----
export const channelCount = (rows: ProfitRow[]) => sum(rows.map((row) => row.channels?.length || 0));
export const rowName = (row: ProfitRow) => row.channels.map((channel) => channel.name || `渠道 ${channel.channelId}`).join("、") || EMPTY;
const isMismatchState = (state: unknown) => state === "over" || state === "under";
// 这一行算不算对不上：看今天时按最近一个已固定日子（最后一列写的就是它），其余按范围里已固定的日子
export const isMismatched = (row: ProfitRow, page: ProfitPageResponse) => isTodayView(page) ? isMismatchState(row.latestSettledGap?.state) : isMismatchState(row.gap?.state);
// 底色和左边那道线（设计稿 §3.2）：对不上多扣红、需处理橙、对不上少扣蓝
export function rowTone(row: ProfitRow, page: ProfitPageResponse): RowTone {
  const state = isTodayView(page) ? row.latestSettledGap?.state : row.gap?.state;
  if (state === "over") return "over";
  if (row.attention) return "attention";
  if (state === "under") return "under";
  return null;
}
export function filterRows(rows: ProfitRow[], filter: ProfitFilter, page: ProfitPageResponse) {
  if (filter === "mismatched") return rows.filter((row) => isMismatched(row, page));
  if (filter === "attention") return rows.filter((row) => !!row.attention);
  return rows;
}
// 全部 N / 对不上 N / 需处理 N，都按渠道数（同一把 Key 的两个渠道算 2 个，用语规范 §4）
export const filterCounts = (page: ProfitPageResponse) => ({
  all: channelCount(page.rows), mismatched: channelCount(filterRows(page.rows, "mismatched", page)), attention: channelCount(filterRows(page.rows, "attention", page)),
});

// 倍率「×0.8」「×1.0」
export function ratioText(ratio: number | null | undefined) {
  if (!finite(ratio)) return "";
  const text = String(Math.round(ratio * 100) / 100);
  return text.includes(".") ? text : `${text}.0`;
}
// 分组和倍率「vip 分组 ×0.8」；分组读不到不写
export const groupText = (groupName: string | null | undefined, ratio: number | null | undefined) =>
  groupName ? COPY.table.group(groupName, ratioText(ratio) || EMPTY) : "";
// 名字下面那行小字（设计稿 §3.1）：上游名 · Key 名 · 分组和倍率 · 什么时候开始算（只有范围中间开始的写）
export function rowSubtitle(row: ProfitRow, page: ProfitPageResponse, ctx: Ctx) {
  const { first } = rangeDays(page);
  const parts = [row.upstream?.name || UPSTREAM_GONE, row.channels.length > 1 ? COPY.table.sharedKey(row.channels.length, row.key.name) : COPY.table.keyName(row.key.name), groupText(row.key.groupName, row.key.groupRatio)];
  if (row.startedOn && (row.startedOn > first || row.startedOn === page.today)) {
    parts.push(row.startedOn === page.today ? (row.startedAt ? COPY.table.startedToday(formatZonedTime(row.startedAt, ctx.tz)) : COPY.table.startedTodayShort) : COPY.table.startedOn(formatDayKey(row.startedOn, ctx.tz, ctx.now)));
  }
  return parts.filter(Boolean).join(" · ");
}

// 差额那一格（§5.7、设计稿 §6）：main 是第一行，sub 是下面的灰字；tag 标「对不上」；muted 是门槛以内的灰字
export type GapCell = { main: string; sub: string; tag: boolean; tone: "over" | "under" | null; muted: boolean };
const dash = (sub = ""): GapCell => ({ main: EMPTY, sub, tag: false, tone: null, muted: false });
export function gapCell(row: ProfitRow, page: ProfitPageResponse, ctx: Ctx): GapCell {
  const money = rowMoney(row, ctx.currency);
  if (isTodayView(page)) {
    const latest = row.latestSettledGap, pageDay = page.latestSettledGap?.day ?? yesterdayOf(page);
    if (!latest || latest.day !== pageDay) {
      if (row.attention && !latest) return dash();
      const notStarted = row.startedOn != null && row.startedOn > pageDay;
      return dash(notStarted || !latest ? (pageDay === yesterdayOf(page) ? COPY.gap.yesterdayNotStarted : COPY.gap.dayNotStarted(formatDayKey(pageDay, ctx.tz, ctx.now))) : COPY.gap.reading);
    }
    // latestSettledGap 本身也可能带 reason: NOT_STARTED（字段表 §9.2 允许）：照「还没开始算」那一套写，不进 reason 表（设计验收 10-26）
    if (latest.usd == null && latest.reason === "NOT_STARTED") return dash(latest.day === yesterdayOf(page) ? COPY.gap.yesterdayNotStarted : COPY.gap.dayNotStarted(formatDayKey(latest.day, ctx.tz, ctx.now)));
    if (latest.usd == null) return dash(gapReasonText(latest.reason, row.gap?.missingPriceModels, { zone: ctx.zoneOf?.(row) }));
    if (isMismatchState(latest.state)) return { main: overUnderText(money.latestGap!, ctx.currency), sub: "", tag: true, tone: latest.state as "over" | "under", muted: false };
    return { main: signedMoney(money.latestGap, ctx.currency), sub: "", tag: false, tone: null, muted: true };
  }
  const gap = row.gap;
  switch (gap?.state) {
    case "over": case "under": {
      const sub = isSingleDay(page) || gap.days === 1 ? (finite(gap.rate) ? rateText(gap.rate) : "") : COPY.gap.mismatchedDaysIn(gap.mismatchedDays.length);
      return { main: overUnderText(money.gap!, ctx.currency), sub, tag: true, tone: gap.state, muted: false };
    }
    case "within": return { main: signedMoney(money.gap, ctx.currency), sub: row.attention ? judgedRangeText(row, ctx) : "", tag: false, tone: null, muted: true };
    case "today": return { main: COPY.gap.tomorrow, sub: "", tag: false, tone: null, muted: false };
    case "reading": return dash(COPY.gap.reading);
    // none：算不出（NOT_STARTED、固定成本的上游 FIXED_COST_UPSTREAM 等，原因在 reason 里）或只是需处理、没有别的原因（reason 为空，不写字，需处理那一行自己有附注）（A1 #126 H1/M7：gap.state 收窄，不再有 notStarted/uncomputable/attention 这几个值）
    default: return dash(gapReasonText(gap?.reason, gap?.missingPriceModels, { zone: ctx.zoneOf?.(row) }));
  }
}
// 需处理的行只有前几天算进来时，差额下面写那几天「10月1日–10月16日」（从小格里算得出差额的日子取）
function judgedRangeText(row: ProfitRow, ctx: Ctx) {
  const days = (row.daily || []).filter((cell) => cell.gapUsd != null).map((cell) => cell.day);
  if (!days.length) return "";
  const first = formatDayKey(days[0], ctx.tz, ctx.now), last = formatDayKey(days[days.length - 1], ctx.tz, ctx.now);
  return days.length === 1 ? first : `${first}–${last}`;
}

// 需处理那一行下面的附注（§5.1、设计稿 §3.4）：「10月17日 起没算进利润」，多天时接「这 7 天都不在合计里」
export function attentionNote(row: ProfitRow, page: ProfitPageResponse, ctx: Ctx) {
  const from = row.attention?.fromDay || row.startedOn;
  if (!from) return "";
  const day = formatDayKey(from, ctx.tz, ctx.now);
  return row.excludedDays > 1 ? COPY.attention.sinceRange(day, row.excludedDays) : COPY.attention.since(day);
}

// ---- 每天的小格（设计稿 §4）----
export type DayCellView = { day: string; label: string; text: string; tone: "over" | "under" | null; today: boolean; disabled: boolean; clickable: boolean; title: string };
export function dayCellView(cell: ProfitDayCell, page: ProfitPageResponse, ctx: Ctx, costRate: number | null) {
  const label = cell.day === page.today ? COPY.expanded.today : `${Number(cell.day.slice(-2))}日`;
  const base = { day: cell.day, label, title: COPY.expanded.dayCell(formatDayKey(cell.day, ctx.tz, ctx.now)) };
  if (cell.state === "today") return { ...base, text: COPY.gap.tomorrow, tone: null, today: true, disabled: false, clickable: true };
  if (cell.state === "notStarted" || cell.state === "future") return { ...base, text: EMPTY, tone: null, today: false, disabled: true, clickable: false };
  if (cell.state === "fixed" && cell.gapUsd != null) {
    const mismatched = isMismatchState(cell.gapState);
    const value = toDisplay(cell.gapUsd, costRate, ctx.currency) ?? 0;
    return { ...base, text: mismatched ? `${value > 0 ? "+" : MINUS}${Math.abs(value).toFixed(2)}` : COPY.expanded.dot, tone: mismatched ? (cell.gapState as "over" | "under") : null, today: false, disabled: false, clickable: true };
  }
  return { ...base, text: EMPTY, tone: null, today: false, disabled: false, clickable: cell.state === "fixed" };
}

// 「差在哪」那一句（设计稿 §4）
export function whereGapText(row: ProfitRow, page: ProfitPageResponse, ctx: Ctx) {
  const money = rowMoney(row, ctx.currency), gap = row.gap;
  const day = (label: string) => formatDayKey(label, ctx.tz, ctx.now);
  if (isTodayView(page)) {
    // 写最近一个已固定的日子：Token 在那天的小格里，差额用 latestSettledGap；后面接「今天的明天出。」
    const latest = row.latestSettledGap;
    if (!latest) return COPY.expanded.tomorrowOnly;
    const label = latest.day === yesterdayOf(page) ? COPY.presets.yesterday : day(latest.day);
    const cell = row.daily.find((item) => item.day === latest.day);
    const first = latest.usd == null ? COPY.expanded.latestDayNone(label, gapReasonText(latest.reason, row.gap?.missingPriceModels, { zone: ctx.zoneOf?.(row) }) || COPY.gap.unknown)
      : cell?.tokens != null ? COPY.expanded.latestDay(label, formatCompact(cell.tokens), isMismatchState(latest.state) ? overUnderText(money.latestGap!, ctx.currency) : signedMoney(money.latestGap, ctx.currency))
      : COPY.expanded.latestDayNoTokens(label, isMismatchState(latest.state) ? overUnderText(money.latestGap!, ctx.currency) : signedMoney(money.latestGap, ctx.currency));
    return `${first}${COPY.expanded.todayTomorrow}`;
  }
  if (gap?.state === "today") return COPY.expanded.tomorrowOnly;
  if (gap == null || gap.usd == null) return COPY.expanded.noGap;
  if (isSingleDay(page)) {
    const viewed = rangeDays(page).first, cell = row.daily.find((item) => item.day === viewed);
    const expected = money.expected ?? (money.actual != null && money.gap != null ? money.actual - money.gap : null);
    const group = groupText(row.key.groupName, row.key.groupRatio) || COPY.table.group(EMPTY, ratioText(row.key.groupRatio) || EMPTY);
    const main = cell?.tokens != null
      ? COPY.expanded.single(formatCompact(cell.tokens), group, fmtMoney(expected, ctx.currency), fmtMoney(money.actual, ctx.currency))
      : COPY.expanded.singleNoTokens(group, fmtMoney(expected, ctx.currency), fmtMoney(money.actual, ctx.currency));
    const others = row.daily.filter((item) => item.day !== viewed && isMismatchState(item.gapState) && item.gapUsd != null).slice(-2)
      .map((item) => COPY.expanded.alsoDay(day(item.day), overUnderText(toDisplay(item.gapUsd, row.rates?.cost, ctx.currency)!, ctx.currency)));
    return [main, ...others].join("");
  }
  const mismatched = gap.mismatchedDays.map((item) => COPY.expanded.dayGap(day(item.day), overUnderText(toDisplay(item.usd, row.rates?.cost, ctx.currency)!, ctx.currency)));
  if (!mismatched.length) return `${COPY.expanded.allMatched}${COPY.expanded.clickDay}`;
  const rest = gap.days - mismatched.length;
  return `${mismatched.join("，")}${rest > 0 ? `，${COPY.expanded.restMatched(rest)}` : ""}。${COPY.expanded.clickDay}`;
}

// ---- 表头、合计行 ----
export const showExpectedColumn = (page: ProfitPageResponse) => isAllFixed(page);
// 差额那一列的表头：看今天写「昨天的差额」「10月24日的差额」；全固定写「差额」；有没固定的日子写「差额 已固定的 6 天（10月20日–10月25日）」
export function gapHeader(page: ProfitPageResponse, ctx: Ctx): { title: string; sub: string } {
  if (isTodayView(page)) {
    const day = page.latestSettledGap?.day;
    return { title: !day || day === yesterdayOf(page) ? COPY.table.yesterdayGap : COPY.table.latestGap(formatDayKey(day, ctx.tz, ctx.now)), sub: "" };
  }
  if (isAllFixed(page)) return { title: COPY.table.col.gap, sub: COPY.table.col.gapSub };
  const days = page.gap.days;
  if (!days.count) return { title: COPY.table.col.gap, sub: "" };
  const range = `${formatDayKey(days.first!, ctx.tz, ctx.now)}–${formatDayKey(days.last!, ctx.tz, ctx.now)}`;
  return { title: COPY.table.col.gap, sub: days.contiguous && days.count > 1 ? COPY.table.gapFixedDaysRange(days.count, range) : COPY.table.gapFixedDays(days.count) };
}
// 已固定、又因为重算的事需处理、照算进了合计的行（设计 10-26 定）：合计括号里补一句，免得财务以为合计里的数都是新算的
const HELD_RESETTLE_CODES = new Set(["RESETTLE_SHRUNK", "RESETTLE_TOO_OLD", "RESETTLE_NOT_DONE"]);
const heldChannels = (page: ProfitPageResponse) => channelCount(page.rows.filter((row) => row.counted && row.attention && HELD_RESETTLE_CODES.has(row.attention.code || "")));
// 手机顶上卡片最后一行用：和合计括号里同一句，但不带「合计」（设计 10-26 定）；没有就是空字符串
export const heldNote = (page: ProfitPageResponse) => { const held = heldChannels(page); return held ? COPY.table.heldNote(held) : ""; };
// 毛利率 = 毛利 ÷ 收入；收入是 0 或毛利算不出就不写
export function marginText(gross: number | null | undefined, income: number | null | undefined): string {
  return gross != null && income != null && income > 0 ? formatPct(gross / income) : EMPTY;
}

export function totalsRow(page: ProfitPageResponse, ctx: Ctx) {
  const money = pageMoney(page, ctx.currency);
  const countedRows = page.rows.filter((row) => row.counted).length;
  const partial = page.gap.rowCount > 0 && page.gap.rowCount < countedRows;
  const held = heldChannels(page);
  return {
    label: held ? COPY.table.totalsHeld(page.counts.countedChannels, held) : COPY.table.totals(page.counts.countedChannels),
    income: fmtMoney(money.income, ctx.currency), actual: fmtMoney(money.actual, ctx.currency), gross: fmtMoney(money.gross, ctx.currency),
    expected: isAllFixed(page) && page.gap.rowCount ? fmtMoney(expectedDisplay(page, ctx.currency), ctx.currency) : EMPTY,
    expectedSub: isAllFixed(page) && partial ? COPY.table.onlyRows(page.gap.rowCount) : "",
    gap: isTodayView(page) ? signedMoney(money.latestGap, ctx.currency) : page.gap.rowCount ? signedMoney(money.gap, ctx.currency) : EMPTY,
    gapSub: !isTodayView(page) && partial ? (isAllFixed(page) ? COPY.table.sameRows(page.gap.rowCount) : COPY.table.onlyRows(page.gap.rowCount)) : "",
  };
}
function expectedDisplay(page: ProfitPageResponse, currency: ReconciliationCurrency) {
  if (currency !== "CNY") return page.gap.expectedCostUsd;
  return sum(page.rows.filter((row) => row.expectedCostUsd != null).map((row) => toDisplay(row.expectedCostUsd, row.rates?.cost, currency) ?? 0));
}

// ---- 四个数（设计稿 §2）----
export type Metric = { key: string; title: string; value: string; lines: string[]; crit?: boolean; link?: { text: string; day: string } | null };
export function metrics(page: ProfitPageResponse, ctx: Ctx): Metric[] {
  const money = pageMoney(page, ctx.currency), fmt = (value: number | null) => fmtMoney(value, ctx.currency);
  const today = isTodayView(page), allFixed = isAllFixed(page), single = isSingleDay(page);
  const presetName = (COPY.presets as Record<string, string>)[page.range.preset || ""];
  // 1. 毛利，下面收入 − 上游成本、毛利率、净利
  const grossLines = [COPY.metric.equation(fmt(money.income), fmt(money.actual))];
  if (money.income != null && money.income > 0 && money.gross != null) grossLines.push(COPY.metric.margin(formatPct(money.gross / money.income)));
  const approx = (value: number | null) => (money.approx ? COPY.metric.approx(fmt(value)) : fmt(value));
  if (money.gross != null) grossLines.push(money.fixedCost == null ? COPY.metric.netUnknown : today ? COPY.metric.netToday(money.fixedExact ? fmt(money.fixedCost) : approx(money.fixedCost), approx(money.net)) : COPY.metric.net(money.fixedExact ? fmt(money.fixedCost) : approx(money.fixedCost), approx(money.net)));
  const gross: Metric = { key: "gross", title: today ? COPY.metric.grossToday : allFixed || single ? COPY.metric.gross : COPY.metric.grossRange(presetName && page.range.preset !== "custom" ? presetName : rangeText(page, ctx)), value: fmt(money.gross), lines: grossLines };
  // 2. 差额：今天「明天出」；其余比预期少赚 / 多赚，下面多扣、少扣、门槛以内三项
  let gap: Metric;
  if (today) gap = { key: "gap", title: COPY.metric.gapToday, value: COPY.metric.tomorrow, lines: [COPY.metric.gapTodayHint] };
  else if (!page.gap.rowCount || money.gap == null) gap = { key: "gap", title: COPY.metric.gapNone, value: EMPTY, lines: [COPY.metric.gapNoneHint] };
  else {
    const less = money.gap >= 0;
    const title = allFixed ? (less ? COPY.metric.lessThanExpected : COPY.metric.moreThanExpected) : (less ? COPY.metric.lessThanExpectedFixed(page.dayCounts.fixed) : COPY.metric.moreThanExpectedFixed(page.dayCounts.fixed));
    const lines = [COPY.metric.gapBreakdown(fmt(money.over), fmt(money.under), signedMoney(money.within, ctx.currency))];
    if (allFixed) lines.push(COPY.metric.gapRows(page.gap.rowCount));
    gap = { key: "gap", title, value: fmt(Math.abs(money.gap)), lines, crit: page.counts.mismatchedChannels > 0 && less };
  }
  // 3. 对不上：今天写最近一个已固定日子的差额和几个渠道对不上
  let mismatched: Metric;
  if (today) {
    const latest = page.latestSettledGap, yesterday = yesterdayOf(page);
    const dayLabel = !latest || latest.day === yesterday ? COPY.presets.yesterday : formatDayKey(latest.day, ctx.tz, ctx.now);
    const rows = latest ? page.rows.filter((row) => row.latestSettledGap?.day === latest.day && isMismatchState(row.latestSettledGap?.state)) : [];
    const count = channelCount(rows), less = (money.latestGap ?? 0) >= 0;
    mismatched = { key: "latest", title: less ? COPY.metric.lessThanExpectedDay(dayLabel === COPY.presets.yesterday ? dayLabel : `${dayLabel} `) : COPY.metric.moreThanExpectedDay(dayLabel === COPY.presets.yesterday ? dayLabel : `${dayLabel} `),
      value: money.latestGap == null ? EMPTY : fmt(Math.abs(money.latestGap)), lines: [COPY.metric.mismatchedChannelsLink(count)], crit: count > 0 && less, link: latest ? { text: COPY.metric.seeDay(dayLabel), day: latest.day } : null };
  } else {
    const count = page.counts.mismatchedChannels;
    const line = single ? COPY.metric.threshold(formatReconciliationMoney(page.gapThreshold.usd, null), formatPct(page.gapThreshold.rate, 0)) : COPY.metric.mismatchedRangeHint(page.dayCounts.fixed);
    // 这一格不上色：浅红底只给「比预期少赚」那一格（设计验收 10-26）
    mismatched = { key: "mismatched", title: COPY.metric.mismatched, value: COPY.metric.channels(count), lines: [line], crit: false };
  }
  // 4. 没算进来 / 算不了差额
  let uncounted: Metric;
  const uncountedRows = page.rows.filter((row) => !row.counted);
  const uncountedLines = uncountedRows.slice(0, 3).map((row) => row.attention?.title ? COPY.metric.attentionWhy(rowName(row), row.attention.title) : row.startedOn ? COPY.metric.attentionSince(rowName(row), formatDayKey(row.startedOn, ctx.tz, ctx.now)) : rowName(row));
  if (allFixed) {
    const entries = Object.entries(page.counts.uncomputable || {});
    // 小字短一点：第一行按原因数「Sub2API 上游 1 个 · 有模型没价格 1 个」，第二行「另有 1 个需处理，没算进来」
    const short = (reason: string) => (COPY.metric.uncomputableShort as Record<string, string>)[reason] || COPY.metric.uncomputableOther;
    const lines = entries.length ? [entries.map(([reason, n]) => `${short(reason)} ${COPY.metric.count(n)}`).join(" · ")] : [];
    if (page.counts.attentionChannels) lines.push(COPY.metric.attentionCount(page.counts.attentionChannels));
    uncounted = { key: "uncomputable", title: COPY.metric.uncomputable, value: COPY.metric.channels(sum(entries.map(([, n]) => n))), lines };
  } else {
    const count = channelCount(uncountedRows);
    uncounted = { key: "uncounted", title: COPY.metric.uncounted, value: count ? COPY.metric.channels(count) : COPY.metric.allCounted, lines: uncountedLines };
  }
  return [gross, gap, mismatched, uncounted];
}

// ---- 表下面那一行（设计稿 §2、用语规范 §5.4、§7）----
export type FooterNote = { key: string; text: string; link?: { text: string; href: string } };
// 收费记录读得慢那一句只在落后 1 小时以上才写（用语规范 §5.4）
export const OWN_LOG_LAG_MS = 3600000;
// ownLog：GET /api/settings 的 ownLog（{ coveredToMs, behindMs? }），没有自营站点、没有进度时是 null
export function footerNotes(page: ProfitPageResponse, ctx: Ctx, hrefs: { upstreams: string; start: string; settings: string }, ownLog: { coveredToMs?: number | null; behindMs?: number | null } | null = null): FooterNote[] {
  const money = pageMoney(page, ctx.currency), notes: FooterNote[] = [];
  if (money.unaccounted != null && money.unaccounted > 0) notes.push({ key: "unaccounted", text: COPY.notice.unaccounted(money.approx ? COPY.metric.approx(fmtMoney(money.unaccounted, ctx.currency)) : fmtMoney(money.unaccounted, ctx.currency)), link: { text: COPY.notice.seeUpstreams, href: hrefs.upstreams } });
  if (page.unlinkedChannelCount > 0) notes.push({ key: "unlinked", text: COPY.notice.unlinked(page.unlinkedChannelCount), link: { text: COPY.table.startCounting, href: hrefs.start } });
  if (page.notCountedDays?.count) notes.push({ key: "notCounted", text: COPY.notice.notCounted(page.notCountedDays.count) });
  const unsupported = (page.unsupportedChannels || []).filter((channel) => channel.reason === "KEY_IN_OTHER_UPSTREAM" && channel.upstreamNames.length)
    .map((channel) => COPY.notice.unsupportedKeyInUpstreams(channel.name, channel.upstreamNames));
  if (unsupported.length) notes.push({ key: "unsupported", text: COPY.notice.unsupported(unsupported.slice(0, 3), unsupported.length) });
  if (ctx.currency !== "CNY" && page.rateUnset?.length) notes.push({ key: "rate", text: RATE_UNSET_USD });
  if (ownLog && finite(ownLog.coveredToMs)) {
    const behind = finite(ownLog.behindMs) ? ownLog.behindMs : (ctx.now ?? Date.now()) - ownLog.coveredToMs;
    if (behind >= OWN_LOG_LAG_MS) notes.push({ key: "lagging", text: COPY.notice.logLagging(formatAsOfTime(ownLog.coveredToMs, ctx.tz, ctx.now)), link: { text: COPY.notice.goSettings, href: hrefs.settings } });
  }
  return notes;
}

// ---- 计算明细（设计稿 §5、用语规范 §9）----
export const tokensText = (tokens: number | null | undefined) => (tokens == null ? EMPTY : formatCompact(tokens));
export function modelUsageText(model: ProfitDetailResponse["expected"]["byModel"][number]) {
  const cache = (model.cacheReadTokens || 0) + (model.cacheWriteTokens || 0);
  return cache > 0 ? COPY.detail.usageCache(formatCompact(model.inputTokens), formatCompact(model.outputTokens), formatCompact(cache)) : COPY.detail.usage(formatCompact(model.inputTokens), formatCompact(model.outputTokens));
}
// 「每百万 Token $3 / $15」（输入 / 输出，单价最多 4 位小数，§7）
export function unitPriceText(prices: { input?: number | null; output?: number | null } | null | undefined) {
  if (!prices || (prices.input == null && prices.output == null)) return "";
  // 整数写「$3」，其余至少两位、最多四位小数「$2.50」「$0.0375」
  const one = (value: number | null | undefined) => (value == null ? EMPTY : Number.isInteger(value) ? `$${value}` : formatUnitPrice(value, { symbol: "$" }));
  return COPY.detail.unitPrice(one(prices.input), one(prices.output));
}
// 管理员自用那一句（用语规范 §9，照账本每一行扣没扣）
export function adminUsageText(adminUsage: ProfitDetailResponse["income"]["adminUsage"] | null | undefined, format: (usd: number) => string) {
  if (!adminUsage) return "";
  const usd = adminUsage.usd ?? 0;
  if (adminUsage.deducted === "all") return usd > 0 ? COPY.detail.adminAll(format(usd)) : "";
  if (adminUsage.deducted === "some") return usd > 0 ? COPY.detail.adminSome(format(usd)) : COPY.detail.adminNone;
  return COPY.detail.adminNone;
}
// 倍率那一行：没变过写「vip 分组 ×0.8，这天没变过」；变过写从几变成几
export function ratioLine(detail: ProfitDetailResponse, tz: string) {
  const group = groupText(detail.expected.groupName, detail.expected.groupRatio) || (detail.expected.groupRatio != null ? `×${ratioText(detail.expected.groupRatio)}` : EMPTY);
  const segments = detail.expected.segments || [];
  if (segments.length <= 1) return COPY.detail.ratioSame(group);
  if (segments.length === 2) return COPY.detail.ratioChanged(formatZonedTime(segments[1].startMs, tz), ratioText(segments[0].ratio) || EMPTY, ratioText(segments[1].ratio) || EMPTY);
  return COPY.detail.ratioChangedMany(segments.length - 1);
}
