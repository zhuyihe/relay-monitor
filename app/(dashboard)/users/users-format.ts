// 用户运营页的纯函数（概览那句话、四个数、用户表的筛选和排序、文字）：不依赖 React，单测直接跑（users-format.test.js）。
// 钱从接口来都是美元，页面按自营站点的汇率（rate）换算；「近 7 天」是最近 7 个整天，不含今天。
import { EMPTY, formatDays, formatDayKey, formatDeltaPct, formatMoney, formatPct, formatZonedTime } from "../../../lib/format.js";
import { dayKeyInTz } from "../../../lib/business-time.js";
import { COPY } from "./copy";
import type { UserStatus, UsersTab } from "./copy";

export type UsersRow = {
  id: number; username: string; big: boolean; disabled: boolean; createdAtMs: number | null; isNew: boolean;
  week: number; prevWeek: number; today: number; balanceUsd: number | null;
  runwayState: string; days: number | null; burnPerDay: number | null; level: number;
  status: UserStatus | null; lastUsed: { ms: number; precise: boolean } | null; spark: number[];
};
export type TrendDay = { day: string; available: boolean; cost: number; users: number; newUsers: number; top: { username: string; cost: number }[] };
export type UsersPage = {
  starting?: boolean; unset?: boolean; asOf: number; syncedMs: number; tz: string; today: string; rate: number; ownStationId: string; level1Days?: number;
  ready: { backfillDone?: boolean; week?: boolean; compare?: boolean; inactive?: boolean; down?: boolean; balance?: boolean; prepaidCompare?: boolean };
  availableDays: number; fresh: boolean;
  backfill: { done: boolean; days: number; total: number };
  big: { ready: boolean; ids: number[]; count: number };
  summary: { todayCost: number; yesterdaySameTime: number; weekCost: number; prevWeekCost: number; weekUsers: number; prevWeekUsers: number; prepaid: number; prepaidAgo: number | null } | null;
  trend: TrendDay[]; prevNewUsers: number[]; users: UsersRow[];
};
export type DetailModels = { models: { model: string; cost: number; share: number }[] | null; others?: { count: number; cost: number; share: number } | null; total?: number; error: string | null };
export type UserDetail = {
  id: number; username: string; dayBars: { day: string; cost: number }[]; hourBars: { hourMs: number; cost: number }[];
  balance: { t: number; usd: number }[]; recharges: { t: number; usd: number }[];
  user: UsersRow | null; rate: number; ready: UsersPage["ready"]; backfill: UsersPage["backfill"]; models: DetailModels;
};

export const TABS: readonly UsersTab[] = ["overview", "users", "churn", "demand"];
export const OPEN_TABS: readonly UsersTab[] = ["overview", "users"];
export const FILTERS = ["all", "low", "down", "new", "idle"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_LABEL: Record<Filter, string> = { all: COPY.users.filterAll, low: COPY.status.soon, down: COPY.status.down, new: COPY.status.new, idle: COPY.status.inactive };

export const money = (usd: number | null | undefined, rate: number, opts?: Parameters<typeof formatMoney>[1]) => (usd == null || !Number.isFinite(usd) ? EMPTY : formatMoney(usd * rate, opts));

// 带正负号的百分比；前 7 天是 0、这 7 天才有的写「新」；两边都是 0 写「—」
export const deltaText = (cur: number, prev: number): string => (prev > 0 ? formatDeltaPct((cur - prev) / prev) : cur > 0 ? COPY.users.newLabel : EMPTY);
export const pctText = (ratio: number) => formatPct(Math.abs(ratio));

// 补数据的预计时间：每 10 分钟补 3 天
export function backfillEta(days: number, total: number): string {
  const minutes = Math.max(1, Math.ceil((total - days) / 3)) * 10;
  return minutes < 60 ? COPY.etaMinutes(minutes) : COPY.etaHours(Math.max(1, Math.round(minutes / 60)));
}
export const backfillLine = (page: UsersPage, withTrend: boolean) => (page.backfill.done ? null : COPY.backfill(page.backfill.days, page.backfill.total, backfillEta(page.backfill.days, page.backfill.total), withTrend));
// 补数据补完了、余额还没记满 24 小时
export const balanceWarmLine = (page: UsersPage) => (page.backfill.done && page.ready.balance === false ? COPY.balanceWarm : null);

// 「重点」小标签的提示：这位占近 7 天消费的百分之几，全部重点用户合起来占百分之几（两个数都取整，用页上近 7 天的消费算）；
// 近 7 天消费还没补到、或全站是 0 时只写「重点用户」
export function bigTipText(row: UsersRow, page: UsersPage): string {
  const total = page.summary?.weekCost ?? 0;
  if (!page.ready.week || !(total > 0)) return COPY.bigTipPlain;
  const bigRows = page.users.filter((user) => user.big);
  const group = bigRows.reduce((sum, user) => sum + user.week, 0);
  return COPY.bigTip(Math.round((row.week / total) * 100), bigRows.length, Math.round((group / total) * 100));
}

// 筛选：重点用户 + 状态。快用完那一类含余额用完
const lowOf = (row: UsersRow) => row.status === "soon" || row.status === "empty";
export const matchesFilter = (row: UsersRow, only: Filter) => (only === "all" ? true : only === "low" ? lowOf(row) : only === "down" ? row.status === "down" : only === "new" ? row.isNew : row.status === "inactive");
export function filterRows(rows: UsersRow[], { big, only, q }: { big: boolean; only: Filter; q: string }): UsersRow[] {
  const key = q.trim().toLowerCase();
  return rows.filter((row) => (!big || row.big) && matchesFilter(row, only) && (!key || row.username.toLowerCase().includes(key)));
}
// 每个状态的人数（跟着「只看重点用户」算，搜索不影响）；还判不了的类（在下滑要补满 17 天，快用完要余额记满 24 小时）是 null，写「—」
export function filterCounts(page: UsersPage, big: boolean): Record<Filter, number | null> {
  const rows = big ? page.users.filter((row) => row.big) : page.users;
  return {
    all: rows.length,
    low: page.ready.balance ? rows.filter(lowOf).length : null,
    down: page.ready.down ? rows.filter((row) => row.status === "down").length : null,
    new: rows.filter((row) => row.isNew).length,
    idle: page.ready.inactive ? rows.filter((row) => row.status === "inactive").length : null,
  };
}
export const bigLabel = (page: UsersPage) => COPY.users.onlyBig(page.big.ready ? String(page.big.count) : EMPTY);

// 排序（点表头）：每一列取什么
export type SortKey = "user" | "week" | "vs" | "today" | "balance" | "days" | "status" | "last";
export const STATUS_ORDER: Record<string, number> = { empty: 0, soon: 1, down: 2, inactive: 3, new: 4 };
export function sortValue(row: UsersRow, key: SortKey, compare: boolean): number | string | null {
  switch (key) {
    case "user": return row.username;
    case "week": return row.week;
    case "vs": return compare && row.prevWeek > 0 ? (row.week - row.prevWeek) / row.prevWeek : compare && row.week > 0 ? Infinity : null;
    case "today": return row.today;
    case "balance": return row.balanceUsd;
    case "days": return row.runwayState === "soon" || row.runwayState === "ok" ? row.days : null;
    case "status": return row.status ? STATUS_ORDER[row.status] : null;
    case "last": return row.lastUsed?.ms ?? null;
  }
}
// 默认排法：近 7 天消费从高到低，一样多按今天，再按名字。表自己（DataTable）按列排，同值保持这个先后
export const defaultOrder = (rows: UsersRow[]): UsersRow[] => [...rows].sort((a, b) => b.week - a.week || b.today - a.today || a.username.localeCompare(b.username, "zh-CN"));

// 小趋势线的 14 个点：补数据还没补到的天是 null（不画成 0）；补到的天数从昨天往前数
export const sparkValues = (row: UsersRow, availableDays: number): (number | null)[] => row.spark.map((value, index) => (index >= row.spark.length - availableDays ? value : null));

// 最近使用：今天 / 昨天 / 10月20日；最近两天有消费的那一小时是准的，抽屉里再带时间（用量按小时记，写那一小时的起点「今天 14:00」）
export function lastUsedText(row: UsersRow, page: Pick<UsersPage, "asOf" | "tz" | "today">, withTime = false): string {
  if (!row.lastUsed) return row.isNew ? COPY.users.notUsed : EMPTY;
  // 准的那一刻是消费那一小时的结束，减 1 毫秒才落在消费的那一小时里
  const key = dayKeyInTz(row.lastUsed.ms - (row.lastUsed.precise ? 1 : 0), page.tz);
  const day = key === page.today ? COPY.users.today : key === dayKeyInTz(page.asOf - 24 * 3600000, page.tz) ? COPY.users.yesterday : formatDayKey(key, page.tz, page.asOf);
  return withTime && row.lastUsed.precise ? `${day} ${formatZonedTime(row.lastUsed.ms - 3600000, page.tz)}` : day;
}

// 可用天数那一格的字：快用完、够用写「约 13 天」，余额用完写「—」，近期没有消费、还算不出写原话
export function runwayText(row: UsersRow): string {
  if (row.runwayState === "soon" || row.runwayState === "ok") return formatDays(row.days);
  if (row.runwayState === "none") return COPY.users.noSpend;
  return EMPTY;
}

// ---- 概览那一句 ----
export type SentencePart = { kind: "text"; text: string } | { kind: "user"; id: number; name: string } | { kind: "soon"; text: string };
export function overviewSentence(page: UsersPage): SentencePart[] {
  const text = (value: string): SentencePart => ({ kind: "text", text: value });
  const s = page.summary, rate = page.rate;
  if (!s || !page.ready.week) return [text(COPY.overview.sentenceWait)];
  const parts: SentencePart[] = [text(COPY.overview.weekLead(money(s.weekCost, rate)))];
  if (!page.ready.compare) return [...parts, text(`。${COPY.overview.afterFill}`)];
  if (s.prevWeekCost > 0) {
    const change = (s.weekCost - s.prevWeekCost) / s.prevWeekCost;
    parts.push(text(`，${Math.abs(change) < 0.0005 ? COPY.overview.same : change > 0 ? COPY.overview.more(pctText(change)) : COPY.overview.less(pctText(change))}`));
  } else parts.push(text(`，${COPY.overview.prevNone}`));
  // 涨得最多（近 7 天比前 7 天多得最多的那位）、在下滑的
  const riser = [...page.users].filter((row) => row.week - row.prevWeek > 0).sort((a, b) => (b.week - b.prevWeek) - (a.week - a.prevWeek) || a.username.localeCompare(b.username))[0];
  if (riser) parts.push(text("；"), { kind: "user", id: riser.id, name: riser.username }, text(COPY.overview.riser(money(riser.week - riser.prevWeek, rate, { sign: true }))));
  const down = page.users.filter((row) => row.status === "down").sort((a, b) => (b.prevWeek - b.week) - (a.prevWeek - a.week) || a.username.localeCompare(b.username));
  if (down.length) {
    parts.push(text(riser ? "，" : "；"));
    if (down.length <= 2) down.forEach((row, index) => parts.push(...(index ? [text("、")] : []), { kind: "user", id: row.id, name: row.username } as SentencePart));
    else parts.push(text(COPY.overview.downMany(down.length)));
    if (down.length <= 2) parts.push(text(` ${COPY.overview.down}`));
  }
  // 快用完只说重点用户；重点用户名单、余额记满 24 小时之前不提
  if (page.big.ready && page.ready.balance) {
    const soon = page.users.filter((row) => row.big && (row.status === "soon" || row.status === "empty")).length;
    parts.push(text("；"), soon > 0 ? { kind: "soon", text: COPY.overview.soon(soon) } : text(COPY.overview.soonNone));
  }
  parts.push(text("。"));
  return parts;
}
export const SOON_LINK = "/users?tab=users&big=1&only=low";

// ---- 四个数 ----
export type Kpi = { key: string; title: string; value: string; sub: string; titleHint?: string };
export function overviewKpis(page: UsersPage): Kpi[] {
  const s = page.summary, rate = page.rate, c = page.ready;
  if (!s) return [];
  const vs = (label: string, cur: number, prev: number) => `${label} ${deltaText(cur, prev)}`;
  return [
    { key: "today", title: COPY.overview.kpiToday, value: money(s.todayCost, rate), sub: vs(COPY.overview.vsYesterday, s.todayCost, s.yesterdaySameTime) },
    { key: "week", title: COPY.overview.kpiWeek, value: c.week ? money(s.weekCost, rate) : EMPTY, sub: c.compare ? vs(COPY.overview.vsPrevWeek, s.weekCost, s.prevWeekCost) : COPY.overview.afterFillCompare },
    { key: "users", title: COPY.overview.kpiUsers, value: c.week ? COPY.overview.usersCount(s.weekUsers) : EMPTY, sub: c.compare ? `${COPY.overview.vsPrevWeek} ${COPY.overview.usersDelta(s.weekUsers - s.prevWeekUsers)}` : COPY.overview.afterFillCompare },
    { key: "prepaid", title: COPY.overview.kpiPrepaid, titleHint: COPY.overview.prepaidTitle, value: money(s.prepaid, rate), sub: c.prepaidCompare && s.prepaidAgo != null ? vs(COPY.overview.vsWeekAgo, s.prepaid, s.prepaidAgo) : COPY.overview.afterWeekCompare },
  ];
}

// ---- 解析地址栏 ----
export const parseTab = (raw: string | null): UsersTab => (raw === "users" ? "users" : "overview");
export const parseOnly = (raw: string | null): Filter => ((FILTERS as readonly string[]).includes(raw ?? "") ? (raw as Filter) : "all");

// 图的数 → 坐标轴上要几个整齐刻度由 lib/chart-math 的 niceTicks 给
// 新用户看注册时间，不用等补数据，没补到的天也有数
export const seriesOf = (trend: TrendDay[], metric: "cost" | "users" | "fresh"): (number | null)[] => trend.map((day) => (metric === "fresh" ? day.newUsers : !day.available ? null : metric === "cost" ? day.cost : day.users));
