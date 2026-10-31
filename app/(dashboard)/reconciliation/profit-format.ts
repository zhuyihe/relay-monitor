// 每日利润页的纯函数：钱的换算、页顶一句、四个数、渠道表的排法和每天一行、柱状图的数、合计行、表下面那一行、计算明细里的几句。
// 不含 JSX，页面组件和单元测试（profit-format.test.js，node 直接跑）共用；导入带 .js 后缀。
// 钱：接口给美元原币，整页按 displayCurrency 换算——收入按自营站点的汇率、成本按这个上游的汇率（行上的 rates）；
// 按美元显示时不换算。金额不写 0（算不出的写「—」），写法按 design/ui-copy-spec.md §5.7、§6、§7。
import type { ProfitDetailResponse, ProfitKeyRow, ProfitPageResponse, ProfitRow, ReconciliationCurrency } from "../../../lib/client";
import { formatReconciliationMoney } from "../../../lib/reconciliation-view.js";
import { EMPTY, MINUS, RATE_UNSET_USD, UPSTREAM_GONE, formatAsOfTime, formatCompact, formatDayKey, formatPct, formatUnitPrice, formatZonedTime, weekdayOfDayKey } from "../../../lib/format.js";
import { dayKeyInTz, dayStartInTz, shiftDayLabel, tzOffsetMs } from "../../../lib/business-time.js";
import { keepOrder } from "../../../lib/keep-order.js";
import { COPY } from "./copy"; // 同目录的 .ts 不带后缀（Turbopack 不认 "./copy.js"；node 跑测试时 profit-format.test.js 的 resolve 钩子补 .ts）

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

// 一行各项在显示币种下的数：收入按自营站点的汇率，成本按这个上游的汇率；毛利 = 收入 − 实付（两边各自换算后再减）
export function rowMoney(row: ProfitRow, currency: ReconciliationCurrency) {
  // 人民币：接口按天换好的数（每天按那天结账时记下的汇率）优先；没给的退回按这一行现在的汇率
  const exact = currency === "CNY" && finite(row.incomeCny) && finite(row.actualCostCny);
  const income = exact ? row.incomeCny! : toDisplay(row.incomeUsd, row.rates?.income, currency), actual = exact ? row.actualCostCny! : toDisplay(row.actualCostUsd, row.rates?.cost, currency);
  return {
    income, actual,
    uncountedIncome: toDisplay(row.uncountedIncomeUsd, row.rates?.income, currency),
    gross: currency === "CNY" ? (income != null && actual != null ? income - actual : null) : toDisplay(row.grossProfitUsd, null, currency),
  };
}

// 整页的数在显示币种下：按美元直接用接口的 pageTotals；按人民币时各行按各自的汇率换算再加（接口只给美元）
export function pageMoney(page: ProfitPageResponse, currency: ReconciliationCurrency) {
  const counted = page.rows.filter((row) => row.counted);
  if (currency !== "CNY") return { income: page.pageTotals.incomeUsd, actual: page.pageTotals.actualCostUsd, gross: page.pageTotals.grossProfitUsd, fixedCost: page.fixedCostUsd, fixedExact: true, net: page.netProfitUsd, unaccounted: page.unaccountedUpstreamCostUsd, approx: false };
  const moneys = counted.map((row) => rowMoney(row, currency));
  const income = counted.length ? sum(moneys.map((item) => item.income ?? 0)) : null, actual = counted.length ? sum(moneys.map((item) => item.actual ?? 0)) : null;
  const gross = income != null && actual != null ? income - actual : null;
  // 固定成本接口只给美元（各上游按自己的汇率换过来的），这里按自营站点的汇率换回去只能是近似；没有汇率时不写
  const ownRate = page.rows.find((row) => finite(row.rates?.income))?.rates.income ?? null;
  // 显示人民币：直接用接口给的人民币原值；显示美元：用各上游自己的汇率折好的美元数（不经自营站点的汇率）
  const fixedCost = page.fixedCostCny !== undefined ? page.fixedCostCny : toDisplay(page.fixedCostUsd, ownRate, currency);
  // 固定成本、没算进利润的上游成本是按自营站点的汇率换回来的，写的时候带「≈」（用语规范 §7）
  return { income, actual, gross, fixedCost, fixedExact: page.fixedCostCny !== undefined, net: gross != null && fixedCost != null ? gross - fixedCost : null, unaccounted: toDisplay(page.unaccountedUpstreamCostUsd, ownRate, currency), approx: true };
}

// ---- 范围 ----
export const dayCount = (page: ProfitPageResponse) => page.dayCounts.fixed + page.dayCounts.reading + page.dayCounts.today;
// 看今天：范围里只有今天
export const isTodayView = (page: ProfitPageResponse) => page.dayCounts.today > 0 && page.dayCounts.fixed === 0 && page.dayCounts.reading === 0;
// 范围里的日子全都固定了（昨天，或者全在过去、也全固定了的范围）
export const isAllFixed = (page: ProfitPageResponse) => page.dayCounts.fixed > 0 && page.dayCounts.reading === 0 && page.dayCounts.today === 0;
export const isSingleDay = (page: ProfitPageResponse) => dayCount(page) === 1;
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
export const channelCount = (rows: ProfitRow[]) => sum(rows.map((row) => row.channels?.length || 0));
// 感叹号气泡里「查看详细原因」的原文：有需处理就只用需处理自己的（需处理可能在提示之后才设到这一行上，不能显示别的问题的原话），没有才用提示的
export const bubbleDiagnostic = (row: ProfitRow): string | undefined => (row.attention ? row.attention.diagnostic : row.notice?.diagnostic) || undefined;
// 这一行今天的数还没读到（后台还没轮到）、整行没算进来：格子写「还在读取」，不写「—」；多天范围里已固定的日子有数的行照常显示数
export const readingText = (row: ProfitRow): string | null => (row.reading && !row.counted ? COPY.gap.reading : null);
// 页顶一句后面接的：有需处理的渠道（这几天没算进来）有几个，多天时写没算进来的天数加起来（一个渠道「有 M 天」，几个渠道「共 M 天」）；有提示类的（照常算进来、只是成本可能少算了）再接一句，中间用「 · 」隔开；都没有是空字符串（用语规范 §4）
export function attentionSuffix(page: ProfitPageResponse) {
  const out = page.rows.filter((row) => row.attention && (!row.counted || row.excludedDays > 0)), noticed = page.rows.filter((row) => row.notice && !out.includes(row));
  // 今天上游成本读不到的行整行没算进合计，单独一句；别的提示（成本可能少算了，照常算进来）一句
  const unread = noticed.filter((row) => row.notice?.code === "UPSTREAM_COST_UNREAD_TODAY"), notices = noticed.filter((row) => row.notice?.code !== "UPSTREAM_COST_UNREAD_TODAY");
  const parts: string[] = [];
  // 顺序：需处理（要人动手，最要紧）→ 还在读取（一会儿就没了）→ 读不到 → 成本可能少算了；还在读取的行没有提示、没有需处理，不会和别的几句重复
  const reading = page.rows.filter((row) => row.reading);
  if (out.length) parts.push(isSingleDay(page) ? COPY.caption.attention(channelCount(out)) : COPY.caption.attentionDays(channelCount(out), Math.max(1, sum(out.map((row) => row.excludedDays || 0)))));
  if (reading.length) parts.push(COPY.caption.reading(channelCount(reading)));
  if (unread.length) parts.push(COPY.caption.unread(channelCount(unread)));
  if (notices.length) parts.push(COPY.caption.notice(channelCount(notices)));
  return parts.join(" · ");
}
// 页顶一句（设计稿 §2）
export function rangeCaption(page: ProfitPageResponse, ctx: Ctx) {
  const asOf = Date.parse(page.asOf);
  const suffix = attentionSuffix(page);
  const base = (() => {
    if (isTodayView(page)) return `${formatDayKey(page.today, ctx.tz, ctx.now)} 0:00–${formatZonedTime(Number.isFinite(asOf) ? asOf : ctx.now ?? Date.now(), ctx.tz)} · ${COPY.todayCaption}`;
    const text = rangeText(page, ctx);
    if (page.range?.preset === "since") return `${text} · ${COPY.presets.since}`; // 「10月20日–今天 · 开始算以来」
    // 看一天：固定了写「已固定」；没固定、又有渠道在读取时，页顶后面那句「其中 N 个渠道还在读取」已经说了，这里不再单独写「还在读取」（不连着出现两次）
    if (isSingleDay(page)) return `${text} ${weekdayOfDayKey(rangeDays(page).first)}${page.dayCounts.fixed ? ` · ${COPY.fixed}` : page.rows.some((row) => row.reading) ? "" : ` · ${COPY.gap.reading}`}`;
    if (isAllFixed(page)) return `${text} · ${COPY.fixed}`;
    const parts = [page.dayCounts.fixed ? COPY.daysFixed(page.dayCounts.fixed) : "", page.dayCounts.reading ? COPY.daysReading(page.dayCounts.reading) : "", page.dayCounts.today ? COPY.todayLive : ""].filter(Boolean);
    return `${text} · ${parts.join("，")}`;
  })();
  return suffix ? `${base} · ${suffix}` : base;
}

// ---- 轮询 ----
// 范围里含今天才轮询（不带 observe）：「今天」和终点晚于今天 0 点的自定义范围 30 秒一次；「近 7 天」「本月」也含今天，和旧页面一样 5 分钟一次
// （不比旧页面多发请求）；昨天、不含今天的自定义范围的日子都已固定，不轮询（审核 #128）。
// 例外：不管选的哪个范围，当前结果里还有「还在读取」的日子（零点以后正在结账的那几个小时）就 5 分钟重读一次，没有了就停（审核 2 #128）。tz 是接口给的业务时区，没读到页面数据时用默认
export const LIVE_POLL_MS = 30000;
export const LIVE_POLL_LONG_MS = 300000;
// 有渠道今天的数还没读到：10 秒再要一次整页（服务端只读缓存、不发外面的请求，后台轮询读到就补上），都读到了回到上面的节奏
export const ROWS_READING_POLL_MS = 10000;
export function livePollMs(window: { preset: string; startMs?: number; endMs?: number }, now: number, tz?: string | null, reading = false, rowsReading = false): number | null {
  const base = livePollBase(window, now, tz);
  if (rowsReading) return base == null ? ROWS_READING_POLL_MS : Math.min(base, ROWS_READING_POLL_MS);
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
export const rowName = (row: ProfitRow) => row.channels.map((channel) => channel.name || `渠道 ${channel.channelId}`).join("、") || EMPTY;
export const isUnbound = (row: ProfitRow) => row.bound === false;
// 这段时间用过两把以上 Key：下面一直挂着 Key 行；只有一把（或接口没给 keys）：名字下面小字写「上游 · Key ×倍率」；两把以上只写上游名
export const hasKeyRows = (row: ProfitRow) => (row.keys?.length ?? 0) >= 2;
const ratioPart = (ratio: number | null | undefined) => (finite(ratio) ? ` ×${ratioText(ratio)}` : "");
export function rowUpstream(row: ProfitRow): string {
  // 两把以上：只写上游名——在用那把 Key 的上游（换过上游也对）；没有在用的（已解绑）写行上的上游
  if (hasKeyRows(row)) return row.keys!.find((key) => key.state === "active")?.upstream?.name ?? row.upstream?.name ?? UPSTREAM_GONE;
  const key = row.keys?.[0];
  const upstream = key?.upstream?.name ?? row.upstream?.name ?? UPSTREAM_GONE;
  return `${upstream} · ${key?.name ?? row.key?.name ?? EMPTY}${ratioPart(key ? key.ratio : row.key?.groupRatio)}`;
}
// Key 行的名字「oai-16 ×0.5」；这段时间换过上游，前面加上游名「云帆 · oai-16 ×0.5」
export const swappedUpstream = (row: ProfitRow) => new Set((row.keys || []).map((key) => key.upstream?.stationId)).size > 1;
export const keyLabel = (key: { name: string; ratio: number | null; upstream: { name: string | null } }, withUpstream: boolean) =>
  `${withUpstream ? `${key.upstream?.name ?? UPSTREAM_GONE} · ` : ""}${key.name}${ratioPart(key.ratio)}`;
// Key 行的数：和渠道行同一套换算（收入按自营站点汇率、成本按这个上游的汇率）；读不到的写「—」
export function keyCells(key: Pick<ProfitKeyRow, "incomeUsd" | "costUsd"> & { incomeCny?: number | null; costCny?: number | null }, row: ProfitRow, ctx: Ctx) {
  const exact = ctx.currency === "CNY" && finite(key.costCny) && (key.incomeUsd == null || finite(key.incomeCny));
  const income = exact && key.incomeUsd != null ? key.incomeCny! : toDisplay(key.incomeUsd, row.rates?.income, ctx.currency), actual = exact ? key.costCny! : toDisplay(key.costUsd, row.rates?.cost, ctx.currency);
  const gross = income != null && actual != null ? income - actual : null;
  return { income, actual, gross, margin: gross != null && income != null && income > 0 ? gross / income : null };
}
// Key 行后面的标签：看多天写「在用 · 27日起」「已换掉 · 用了 23日–27日」（跨月写全）；看一天只写「在用」「已换掉」；已解绑渠道的最后一把不标
export function keyTag(key: { state: ProfitKeyRow["state"]; firstDay: string; lastDay: string }, singleDay: boolean, rangeFirst: string, tz: string, now: number): string | null {
  if (key.state === "unbound") return null;
  if (singleDay) return key.state === "active" ? COPY.table.keyActive : COPY.table.keySwapped;
  const first = key.firstDay < rangeFirst ? rangeFirst : key.firstDay;
  const day = (value: string) => Number(value.slice(8, 10)) + "日";
  const full = (value: string) => formatDayKey(value, tz, now);
  if (key.state === "active") return COPY.table.keyActiveSince(first.slice(0, 7) === dayKeyInTz(now, tz).slice(0, 7) ? day(first) : full(first));
  return COPY.table.keySwappedRange(first.slice(0, 7) === key.lastDay.slice(0, 7) ? `${day(first)}–${day(key.lastDay)}` : `${full(first)}–${full(key.lastDay)}`);
}
// 毛利率 = 毛利 ÷ 收入；收入是 0 或毛利算不出就不写
export function marginText(gross: number | null | undefined, income: number | null | undefined): string {
  return gross != null && income != null && income > 0 ? formatPct(gross / income) : EMPTY;
}

// 渠道表的排法：默认按毛利从高到低；点表头换列、再点换方向。没算进利润的行（毛利写「—」）、读不到的数排最后；一样的按名字
export type SortKey = "name" | "income" | "actual" | "gross" | "margin";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };
export const DEFAULT_SORT: Sort = { key: "gross", dir: "desc" };
// 点一列表头：已经按这一列排着就换方向，否则按这一列排（名字从小到大，数从大到小）
export const nextSort = (current: Sort | null, key: SortKey): Sort =>
  current?.key === key ? { key, dir: current.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" ? "asc" : "desc" };
export function rowCells(row: ProfitRow, ctx: Ctx) {
  const money = rowMoney(row, ctx.currency);
  return {
    income: money.income ?? money.uncountedIncome, actual: row.counted ? money.actual : null, gross: row.counted ? money.gross : null,
    margin: row.counted && money.gross != null && money.income != null && money.income > 0 ? money.gross / money.income : null,
  };
}
export function sortRows(rows: ProfitRow[], sort: Sort, ctx: Ctx): ProfitRow[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  const byName = (a: ProfitRow, b: ProfitRow) => rowName(a).localeCompare(rowName(b), "zh-CN");
  return [...rows].sort((a, b) => {
    if (sort.key === "name") return sign * byName(a, b);
    const x = rowCells(a, ctx)[sort.key], y = rowCells(b, ctx)[sort.key];
    if (x == null || y == null) return x == null && y == null ? byName(a, b) : x == null ? 1 : -1;
    return x === y ? byName(a, b) : sign * (x - y);
  });
}

// 渠道表怎么分组、怎么排（表格和手机卡片共用）：
//   只在看「今天」时分三组：最近 1 小时有收入（activeNow）/ 没收入（包括今天一直没卖的、停用的）/ 已解绑（unbound），每组里按毛利从高到低、一样的按名字；
//   看别的范围：绑着的渠道按毛利从高到低排成一张表，已解绑的放最后（前面一行「已解绑 · N」）；
//   点了表头（sort 不是 null）：按那一列排，不分组、没有小标题。
export type RowGroupKey = "active" | "idle" | "bound" | "unbound" | "flat";
export type RowGroup = { key: RowGroupKey; title: string | null; rows: ProfitRow[] };
const GROUP_ORDER: RowGroupKey[] = ["active", "idle", "bound", "unbound", "flat"];
export function groupKeyOf(row: ProfitRow, today: boolean, sorted: boolean): RowGroupKey {
  if (sorted) return "flat";
  return isUnbound(row) ? "unbound" : today ? (row.activeNow ? "active" : "idle") : "bound";
}
const groupTitle = (key: RowGroupKey, rows: ProfitRow[]) => (key === "active" ? COPY.table.groupActive(channelCount(rows)) : key === "idle" ? COPY.table.groupIdle(channelCount(rows)) : key === "unbound" ? COPY.table.groupUnbound(channelCount(rows)) : null);
export type RowLayout = { ids: string[]; groups: Record<string, RowGroupKey> };
// prev + hold：开着计算明细或感叹号气泡时先别动——沿用上次的顺序和分组，新出现的行放在自己那组最后，没了的去掉（keepOrder，和上游列表同一个函数）；hold 为假就按新的排
export function arrangeRows(rows: ProfitRow[], { today, sort }: { today: boolean; sort: Sort | null }, ctx: Ctx, prev: RowLayout | null = null, hold = false): { groups: RowGroup[]; layout: RowLayout } {
  const sorted = !!sort;
  const nextGroup: Record<string, RowGroupKey> = Object.fromEntries(rows.map((row) => [row.rowKey, groupKeyOf(row, today, sorted)]));
  const byRowKey = new Map(rows.map((row) => [row.rowKey, row]));
  const ordered: string[] = sorted ? sortRows(rows, sort!, ctx).map((row) => row.rowKey)
    : GROUP_ORDER.flatMap((key) => sortRows(rows.filter((row) => nextGroup[row.rowKey] === key), DEFAULT_SORT, ctx).map((row) => row.rowKey));
  const ids = prev && hold ? keepOrder(prev.ids, ordered, true) : ordered;
  const groups: Record<string, RowGroupKey> = Object.fromEntries(ids.map((id) => [id, (prev && hold ? prev.groups[id] : undefined) ?? nextGroup[id]]));
  const out: RowGroup[] = [];
  for (const key of GROUP_ORDER) {
    const list = ids.filter((id) => groups[id] === key).map((id) => byRowKey.get(id)!);
    if (list.length) out.push({ key, title: groupTitle(key, list), rows: list });
  }
  return { groups: out, layout: { ids, groups } };
}

// ---- 每天的毛利（小柱状图，多天才有）----
export type ChartDay = { day: string; label: string; weekday: string; income: number; actual: number; gross: number; margin: string; light: boolean; stateText: string };
// 一天的数 = 算进利润的各个渠道这天的数相加；没固定的天和今天用浅色（有一个算进来的渠道这天不是已固定就算没固定）；一个数都没有的天不画
export function chartDays(page: ProfitPageResponse, ctx: Ctx): ChartDay[] {
  const { first, last } = rangeDays(page);
  const days: string[] = [];
  for (let day = first; day <= last && days.length < 400; day = shiftDayLabel(day, 1)) days.push(day);
  if (days.length < 2) return [];
  const counted = page.rows.filter((row) => row.counted);
  return days.slice(-31).flatMap((day) => {
    let income = 0, actual = 0, any = false, fixed = true;
    for (const row of counted) {
      const cell = row.daily.find((item) => item.day === day);
      if (!cell || cell.state === "notStarted" || cell.state === "future") continue;
      if (cell.state !== "fixed") fixed = false;
      const exact = ctx.currency === "CNY" && finite(cell.incomeCny) && finite(cell.actualCostCny);
      const i = exact ? cell.incomeCny! : toDisplay(cell.incomeUsd, row.rates?.income, ctx.currency), c = exact ? cell.actualCostCny! : toDisplay(cell.actualCostUsd, row.rates?.cost, ctx.currency);
      if (i == null || c == null) continue;
      income += i; actual += c; any = true;
    }
    if (!any) return [];
    const light = day === page.today || !fixed;
    return [{ day, label: day === page.today ? COPY.table.day.today : `${Number(day.slice(-2))}日`, weekday: weekdayOfDayKey(day), income, actual, gross: income - actual, margin: marginText(income - actual, income), light,
      stateText: light ? COPY.table.day.live : COPY.table.day.fixed }];
  });
}

// ---- 四个数、合计行 ----
export type Metric = { key: "income" | "actual" | "gross" | "margin"; title: string; value: string };
export function metrics(page: ProfitPageResponse, ctx: Ctx): Metric[] {
  const money = pageMoney(page, ctx.currency);
  return [
    { key: "income", title: COPY.summary.income, value: fmtMoney(money.income, ctx.currency) },
    { key: "actual", title: COPY.summary.actual, value: fmtMoney(money.actual, ctx.currency) },
    { key: "gross", title: COPY.summary.gross, value: fmtMoney(money.gross, ctx.currency) },
    { key: "margin", title: COPY.summary.margin, value: marginText(money.gross, money.income) },
  ];
}
// 运营总览的利润卡片用：毛利一格（大数、收入 − 上游成本、毛利率、净利）。每日利润页本身不再放净利，这一格只给总览
export type GrossMetric = { key: "gross"; title: string; value: string; lines: string[] };
export function grossMetric(page: ProfitPageResponse, ctx: Ctx): GrossMetric {
  const money = pageMoney(page, ctx.currency), fmt = (value: number | null) => fmtMoney(value, ctx.currency);
  const today = isTodayView(page), allFixed = isAllFixed(page), single = isSingleDay(page);
  const presetName = (COPY.presets as Record<string, string>)[page.range.preset || ""];
  const lines = [COPY.metric.equation(fmt(money.income), fmt(money.actual))];
  if (money.income != null && money.income > 0 && money.gross != null) lines.push(COPY.metric.margin(formatPct(money.gross / money.income)));
  const approx = (value: number | null) => (money.approx ? COPY.metric.approx(fmt(value)) : fmt(value));
  if (money.gross != null) lines.push(money.fixedCost == null ? COPY.metric.netUnknown : today ? COPY.metric.netToday(money.fixedExact ? fmt(money.fixedCost) : approx(money.fixedCost), approx(money.net)) : COPY.metric.net(money.fixedExact ? fmt(money.fixedCost) : approx(money.fixedCost), approx(money.net)));
  return { key: "gross", title: today ? COPY.metric.grossToday : allFixed || single ? COPY.metric.gross : COPY.metric.grossRange(presetName && page.range.preset !== "custom" ? presetName : rangeText(page, ctx)), value: fmt(money.gross), lines };
}
// 已固定、又因为重算的事需处理、照算进了合计的行（设计 10-26 定）：合计括号里补一句，免得财务以为合计里的数都是新算的
const HELD_RESETTLE_CODES = new Set(["RESETTLE_SHRUNK", "RESETTLE_TOO_OLD", "RESETTLE_NOT_DONE"]);
const heldChannels = (page: ProfitPageResponse) => channelCount(page.rows.filter((row) => row.counted && row.attention && HELD_RESETTLE_CODES.has(row.attention.code || "")));
export function totalsRow(page: ProfitPageResponse, ctx: Ctx) {
  const money = pageMoney(page, ctx.currency), held = heldChannels(page);
  return {
    label: held ? COPY.table.totalsHeld(page.counts.countedChannels, held) : COPY.table.totals(page.counts.countedChannels),
    income: fmtMoney(money.income, ctx.currency), actual: fmtMoney(money.actual, ctx.currency), gross: fmtMoney(money.gross, ctx.currency), margin: marginText(money.gross, money.income),
  };
}

// ---- 表下面那一行（设计稿 §2、用语规范 §5.4、§7）----
export type FooterNote = { key: string; text: string; link?: { text: string; href: string } };
// 收费记录读得慢那一句只在落后 1 小时以上才写（用语规范 §5.4）
export const OWN_LOG_LAG_MS = 3600000;
// ownLog：GET /api/settings 的 ownLog（{ coveredToMs, behindMs? }），没有自营站点、没有进度时是 null
export function footerNotes(page: ProfitPageResponse, ctx: Ctx, hrefs: { upstreams: string; settings: string }, ownLog: { coveredToMs?: number | null; behindMs?: number | null } | null = null): FooterNote[] {
  const money = pageMoney(page, ctx.currency), notes: FooterNote[] = [];
  if (money.unaccounted != null && money.unaccounted > 0) notes.push({ key: "unaccounted", text: COPY.notice.unaccounted(money.approx ? COPY.metric.approx(fmtMoney(money.unaccounted, ctx.currency)) : fmtMoney(money.unaccounted, ctx.currency)), link: { text: COPY.notice.seeUpstreams, href: hrefs.upstreams } });
  if (page.unlinkedChannelCount > 0) notes.push({ key: "unlinked", text: COPY.notice.unlinked(page.unlinkedChannelCount), link: { text: COPY.table.goUpstreams, href: hrefs.upstreams } });
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
// 倍率「×0.8」「×1.0」
export function ratioText(ratio: number | null | undefined) {
  if (!finite(ratio)) return "";
  const text = String(Math.round(ratio * 100) / 100);
  return text.includes(".") ? text : `${text}.0`;
}
// 分组和倍率「vip 分组 ×0.8」；分组读不到不写
export const groupText = (groupName: string | null | undefined, ratio: number | null | undefined) =>
  groupName ? COPY.detail.group(groupName, ratioText(ratio) || EMPTY) : "";
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
// 「核对上游扣费」一节收起时右边的一句结论；对不上的那天默认展开（open）
export function verifyView(detail: ProfitDetailResponse, page: ProfitPageResponse, ctx: Ctx, costRate: number | null, keyChangeWhen: string | null = null): { text: string; open: boolean; tone: "crit" | null } {
  if (detail.day === page.today) return { text: COPY.gap.tomorrow, open: false, tone: null };
  const gap = detail.gap;
  if (gap?.usd != null && (gap.state === "over" || gap.state === "under")) {
    const value = toDisplay(gap.usd, costRate, ctx.currency)!;
    return { text: COPY.detail.verify.mismatch(overUnderText(value, ctx.currency)), open: true, tone: "crit" };
  }
  if (gap?.usd != null) return { text: COPY.detail.verify.match, open: false, tone: null };
  if (detail.expected.reason === "KEY_CHANGE_RATIO_DIFFERS") return { text: COPY.detail.verify.keyChange, open: false, tone: null };
  const reason = gapReasonText(detail.expected.reason, (detail.expected.missingPriceModels || []).map((model) => model.model), { settled: detail.settled, keyChangeWhen });
  return { text: reason || EMPTY, open: false, tone: null };
}
