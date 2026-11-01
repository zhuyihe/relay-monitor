// 用户运营页的纯函数（概览那句话、五个数、用户表的地址栏和文字）：不依赖 React，单测直接跑（users-format.test.js）。
// 用户表的筛选、排序、分页在服务端（lib/user-ops-view.js 的 queryUsers），这里只管怎么摆。
// 钱从接口来都是美元，页面按自营站点的汇率（rate）换算；「近 7 天」是最近 7 个整天，不含今天。
import { EMPTY, formatDays, formatDayKey, formatDeltaPct, formatMoney, formatPct, formatZonedTime } from "../../../lib/format.js";
import { dayKeyInTz } from "../../../lib/business-time.js";
import { COPY } from "./copy";
import type { UserStatus, UsersTab } from "./copy";

export type UsersRow = {
  id: number; username: string; big: boolean; disabled: boolean; group: string; createdAtMs: number | null; usedUsd: number | null; isNew: boolean;
  week: number; prevWeek: number; today: number; balanceUsd: number | null;
  runwayState: string; days: number | null; burnPerDay: number | null; level: number;
  status: UserStatus | null; lastUsed: { ms: number; precise: boolean } | null; spark: number[];
};
export type TrendDay = { day: string; available: boolean; cost: number; users: number; newUsers: number; newTop: { username: string; cost: number }[]; top: { username: string; cost: number }[] };
export type Only = "all" | "soon" | "down" | "new" | "churned";
export type Scope = "active30" | "all";
export type SortKey = "user" | "week" | "today" | "balance" | "last";
export type UsersList = {
  rows: UsersRow[]; total: number; page: number; pages: number; pageSize: number;
  totals: { count: number; week: number; prevWeek: number; today: number; balance: number };
  counts: { scope: { active30: number; all: number }; big: number; only: Record<Only, number | null> };
  groups: string[];
};
export type UsersPage = {
  starting?: boolean; unset?: boolean; asOf: number; syncedMs: number; tz: string; today: string; rate: number; ownStationId: string; level1Days?: number;
  ready: { backfillDone?: boolean; week?: boolean; compare?: boolean; churn?: boolean; down?: boolean; balance?: boolean; prepaidCompare?: boolean };
  availableDays: number; fresh: boolean;
  backfill: { done: boolean; core?: boolean; days: number; total: number };
  big: { ready: boolean; ids: number[]; count: number };
  summary: {
    todayCost: number; yesterdaySameTime: number; weekCost: number; prevWeekCost: number; weekUsers: number; prevWeekUsers: number;
    weekNewUsers: number; prevWeekNewUsers: number; newUsers30: number; prevNewUsers30: number; prepaid: number; prepaidAgo: number | null; bigWeek: number;
  } | null;
  facts?: { riser: { id: number; username: string; delta: number } | null; down: { id: number; username: string }[]; soonBig: number };
  trend: TrendDay[]; prevTrend: { day: string; available: boolean; cost: number; users: number; newUsers: number }[];
  list: UsersList;
};
export type DetailModels = { models: { model: string; cost: number; share: number }[] | null; others?: { count: number; cost: number; share: number } | null; total?: number; error: string | null };
export type UserDetail = {
  id: number; username: string; dayBars: { day: string; cost: number }[]; hourBars: { hourMs: number; cost: number }[];
  balance: { t: number; usd: number }[]; recharges: { t: number; usd: number }[];
  user: UsersRow | null; rate: number; ready: UsersPage["ready"]; backfill: UsersPage["backfill"]; models: DetailModels;
};

export const TABS: readonly UsersTab[] = ["overview", "users", "churn", "demand"];
export const OPEN_TABS: readonly UsersTab[] = ["overview", "users", "churn"];
export const ONLY_VALUES = ["all", "soon", "down", "new", "churned"] as const;
export const ONLY_LABEL: Record<Only, string> = { all: COPY.users.filterAll, soon: COPY.status.soon, down: COPY.status.down, new: COPY.status.new, churned: COPY.status.churned };

export const money = (usd: number | null | undefined, rate: number, opts?: Parameters<typeof formatMoney>[1]) => (usd == null || !Number.isFinite(usd) ? EMPTY : formatMoney(usd * rate, opts));

// 带正负号的百分比；前 7 天是 0、这 7 天才有的写「新」；两边都是 0 写「—」
export const deltaText = (cur: number, prev: number): string => (prev > 0 ? formatDeltaPct((cur - prev) / prev) : cur > 0 ? COPY.users.newLabel : EMPTY);
export const pctText = (ratio: number) => formatPct(Math.abs(ratio));

// 补数据的预计时间：每 10 分钟补 3 天
export function backfillEta(days: number, total: number): string {
  const minutes = Math.max(1, Math.ceil((total - days) / 3)) * 10;
  return minutes < 60 ? COPY.etaMinutes(minutes) : COPY.etaHours(Math.max(1, Math.round(minutes / 60)));
}
// 补数据那一行：前 60 天补到了（提醒、比前 7 天这些都能算了）、后面再往前补的 30 天（月留存要）写另一句，不说「补满再算」
export const backfillLine = (page: UsersPage, withTrend: boolean) => {
  if (page.backfill.done) return null;
  const eta = backfillEta(page.backfill.days, page.backfill.total);
  return page.backfill.core ? COPY.backfillMore(page.backfill.days, page.backfill.total, eta) : COPY.backfill(page.backfill.days, page.backfill.total, eta, withTrend);
};
// 补数据补完了、余额还没记满 24 小时
export const balanceWarmLine = (page: UsersPage) => (page.backfill.done && page.ready.balance === false ? COPY.balanceWarm : null);

// 「重点」小标签的提示：这位占近 7 天消费的百分之几，全部重点用户合起来占百分之几（两个数都取整，用页上近 7 天的消费算）；
// 近 7 天消费还没补到、或全站是 0 时只写「重点用户」
export function bigTipText(row: UsersRow, page: UsersPage): string {
  const total = page.summary?.weekCost ?? 0;
  if (!page.ready.week || !(total > 0) || !page.summary) return COPY.bigTipPlain;
  return COPY.bigTip(Math.round((row.week / total) * 100), page.big.count, Math.round((page.summary.bigWeek / total) * 100));
}
// 个数跟着前面的筛选（范围）算：count 是当前范围里的重点用户数
export const bigLabel = (page: UsersPage, count: number = page.big.count) => COPY.users.onlyBig(page.big.ready ? String(count) : EMPTY);

// 小趋势线的 14 个点：补数据还没补到的天是 null（不画成 0）；补到的天数从昨天往前数
export const sparkValues = (row: UsersRow, availableDays: number): (number | null)[] => row.spark.map((value, index) => (index >= row.spark.length - availableDays ? value : null));

// 最近使用：今天 / 昨天 / 10月20日；最近两天有消费的那一小时是准的，抽屉里再带时间（用量按小时记，写那一小时的起点「今天 14:00」）
export function lastUsedText(row: Pick<UsersRow, "lastUsed"> & { isNew?: boolean }, page: Pick<UsersPage, "asOf" | "tz" | "today">, withTime = false): string {
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
export type SentencePart = { kind: "text"; text: string } | { kind: "user"; id: number; name: string } | { kind: "soon"; text: string } | { kind: "big"; text: string };
export function overviewSentence(page: UsersPage): SentencePart[] {
  const text = (value: string): SentencePart => ({ kind: "text", text: value });
  const s = page.summary, rate = page.rate, facts = page.facts;
  if (!s || !page.ready.week) return [text(COPY.overview.sentenceWait)];
  const parts: SentencePart[] = [text(COPY.overview.weekLead(money(s.weekCost, rate)))];
  if (!page.ready.compare) return [...parts, text(`。${COPY.overview.afterFill}`)];
  if (s.prevWeekCost > 0) {
    const change = (s.weekCost - s.prevWeekCost) / s.prevWeekCost;
    parts.push(text(`，${Math.abs(change) < 0.0005 ? COPY.overview.same : change > 0 ? COPY.overview.more(pctText(change)) : COPY.overview.less(pctText(change))}`));
  } else parts.push(text(`，${COPY.overview.prevNone}`));
  // 集中度：几个重点用户占近 7 天消费的百分之几（「5 个重点用户」是链接，到用户页签勾上「只看重点用户」）
  if (page.big.ready && page.big.count > 0 && s.weekCost > 0) {
    parts.push(text("，"), { kind: "big", text: COPY.overview.bigCount(page.big.count) }, text(COPY.overview.bigShare(Math.round((s.bigWeek / s.weekCost) * 100))));
  }
  // 涨得最多（近 7 天比前 7 天多得最多的那位）、在下滑的
  const riser = facts?.riser;
  if (riser) parts.push(text("；"), { kind: "user", id: riser.id, name: riser.username }, text(COPY.overview.riser(money(riser.delta, rate, { sign: true }))));
  const down = facts?.down || [];
  if (down.length) {
    parts.push(text(riser ? "，" : "；"));
    if (down.length <= 2) down.forEach((row, index) => parts.push(...(index ? [text("、")] : []), { kind: "user", id: row.id, name: row.username } as SentencePart));
    else parts.push(text(COPY.overview.downMany(down.length)));
    if (down.length <= 2) parts.push(text(` ${COPY.overview.down}`));
  }
  // 快用完只说重点用户；重点用户名单、余额记满 24 小时之前不提
  if (page.big.ready && page.ready.balance) {
    const soon = facts?.soonBig ?? 0;
    parts.push(text("；"), soon > 0 ? { kind: "soon", text: COPY.overview.soon(soon) } : text(COPY.overview.soonNone));
  }
  parts.push(text("。"));
  return parts;
}
export const SOON_LINK = "/users?tab=users&big=1&only=soon";
export const BIG_LINK = "/users?tab=users&big=1";

// ---- 五个数 ----
export type Kpi = { key: string; title: string; value: string; sub: string; titleHint?: string };
export function overviewKpis(page: UsersPage): Kpi[] {
  const s = page.summary, rate = page.rate, c = page.ready;
  if (!s) return [];
  const vs = (label: string, cur: number, prev: number) => `${label} ${deltaText(cur, prev)}`;
  // 人数的对比写「多 / 少几个」，一样多写「和前 7 天一样多」，不写「+0」
  const peopleVs = (cur: number, prev: number) => (cur === prev ? COPY.overview.usersSame : `${COPY.overview.vsPrevWeek} ${COPY.overview.usersDelta(cur - prev)}`);
  return [
    { key: "today", title: COPY.overview.kpiToday, value: money(s.todayCost, rate), sub: vs(COPY.overview.vsYesterday, s.todayCost, s.yesterdaySameTime) },
    { key: "week", title: COPY.overview.kpiWeek, value: c.week ? money(s.weekCost, rate) : EMPTY, sub: c.compare ? vs(COPY.overview.vsPrevWeek, s.weekCost, s.prevWeekCost) : COPY.overview.afterFillCompare },
    { key: "users", title: COPY.overview.kpiUsers, titleHint: COPY.overview.kpiUsersHint, value: c.week ? COPY.overview.usersCount(s.weekUsers) : EMPTY, sub: c.compare ? peopleVs(s.weekUsers, s.prevWeekUsers) : COPY.overview.afterFillCompare },
    { key: "fresh", title: COPY.overview.kpiNew, titleHint: COPY.overview.kpiNewHint, value: c.week ? COPY.overview.usersCount(s.weekNewUsers) : EMPTY, sub: c.compare ? peopleVs(s.weekNewUsers, s.prevWeekNewUsers) : COPY.overview.afterFillCompare },
    { key: "prepaid", title: COPY.overview.kpiPrepaid, titleHint: COPY.overview.prepaidTitle, value: money(s.prepaid, rate), sub: c.prepaidCompare && s.prepaidAgo != null ? vs(COPY.overview.vsWeekAgo, s.prepaid, s.prepaidAgo) : COPY.overview.afterWeekCompare },
  ];
}

// ---- 地址栏 ----
export const parseTab = (raw: string | null): UsersTab => (raw === "users" || raw === "churn" ? raw : "overview");
export const parseOnly = (raw: string | null): Only => ((ONLY_VALUES as readonly string[]).includes(raw ?? "") ? (raw as Only) : "all");
export const parseScope = (raw: string | null): Scope => (raw === "all" ? "all" : "active30");
export const SORT_KEYS: readonly SortKey[] = ["user", "week", "today", "balance", "last"];
export const parseSort = (raw: string | null, dir: string | null): { key: SortKey; dir: "asc" | "desc" } =>
  ((SORT_KEYS as readonly string[]).includes(raw ?? "") ? { key: raw as SortKey, dir: dir === "asc" ? "asc" : "desc" } : { key: "week", dir: "desc" });
export const parseGroups = (raw: string | null): string[] => (raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : []);
export const parsePageNo = (raw: string | null): number => (/^\d+$/.test(raw || "") && Number(raw) >= 1 ? Number(raw) : 1);

// 用户表这一屏要的筛选 → 接口的查询串（和地址栏同一套写法；默认值不写）
export type ListQuery = { scope: Scope; big: boolean; only: Only; groups: string[]; sort: SortKey; dir: "asc" | "desc"; page: number; q: string };
export function listQueryString(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.scope === "all") params.set("scope", "all");
  if (query.big) params.set("big", "1");
  if (query.only !== "all") params.set("only", query.only);
  if (query.groups.length) params.set("group", query.groups.join(","));
  if (query.sort !== "week" || query.dir !== "desc") { params.set("sort", query.sort); params.set("dir", query.dir); }
  if (query.page > 1) params.set("page", String(query.page));
  if (query.q.trim()) params.set("q", query.q.trim());
  return params.toString();
}

// 图的数 → 坐标轴上要几个整齐刻度由 lib/chart-math 的 niceTicks 给
// 前 30 天（图上的虚线），和近 30 天一一对应：消费、活跃用户要前 30 天也补到了才画（补数据中不画虚线，也不出图例）；新消费用户是柱子，不叠虚线
export function prevSeriesOf(page: UsersPage, metric: "cost" | "users" | "fresh"): (number | null)[] | null {
  if (metric === "fresh") return null;
  if (!page.backfill.done || !page.prevTrend?.length) return null;
  return page.prevTrend.map((day) => (!day.available ? null : metric === "cost" ? day.cost : day.users));
}
export const seriesOf = (trend: TrendDay[], metric: "cost" | "users" | "fresh"): (number | null)[] => trend.map((day) => (!day.available ? null : metric === "fresh" ? day.newUsers : metric === "cost" ? day.cost : day.users));

// 新消费用户图标题旁那一行：「近 30 天共 6 个，前 30 天 5 个」；前 30 天没补全时只写近 30 天
export function freshNote(page: UsersPage): string | null {
  const s = page.summary;
  if (!s || !page.trend.length || !page.trend.every((day) => day.available)) return null;
  const prevFilled = page.prevTrend.length > 0 && page.prevTrend.every((day) => day.available);
  return prevFilled ? COPY.overview.freshNote(s.newUsers30, s.prevNewUsers30) : COPY.overview.freshNoteNow(s.newUsers30);
}

// ---- 流失页签 ----
export type ChurnStatus = "todayLow" | "down" | "churned" | "returned";
export type ChurnOnly = "all" | ChurnStatus;
export type ChurnRow = {
  id: number; username: string; big: boolean; disabled: boolean; group: string; lastUsed: { ms: number; precise: boolean } | null; balanceUsd: number | null; model: string | null;
  status: ChurnStatus; before: number | null; after: number | null; loss: number | null; daysAgo?: number; spend?: number;
};
export type ChurnPage = {
  starting?: boolean; asOf: number; syncedMs: number; tz: string; rate: number; ownStationId: string; fresh: boolean;
  backfill: UsersPage["backfill"];
  ready: { down: boolean; churn: boolean; today: boolean; retention: boolean; retentionPrev: boolean; available: number };
  summary: {
    down: { count: number; loss: number };
    newChurn: { count: number; monthly: number };
    retention: { cohort: number; kept: number; rate: number | null; prev: { cohort: number; kept: number; rate: number | null } | null } | null;
    returned: { count: number; top: { id: number; username: string; spend: number }[] };
  };
  modelsError: string | null;
  list: {
    rows: ChurnRow[]; total: number; page: number; pages: number; pageSize: number; totals: { count: number; loss: number };
    counts: { big: number; only: Record<ChurnOnly, number | null> };
  };
};
export const CHURN_ONLY_VALUES = ["all", "todayLow", "down", "churned", "returned"] as const;
// 筛选条上常驻的四个；「回流」只在点了回流那一格的链接过来时出现
export const CHURN_FILTERS = ["all", "todayLow", "down", "churned"] as const;
export const parseChurnOnly = (raw: string | null): ChurnOnly => ((CHURN_ONLY_VALUES as readonly string[]).includes(raw ?? "") ? (raw as ChurnOnly) : "all");
export type ChurnQuery = { only: ChurnOnly; big: boolean; page: number; q: string };
export function churnQueryString(query: ChurnQuery): string {
  const params = new URLSearchParams();
  if (query.only !== "all") params.set("only", query.only);
  if (query.big) params.set("big", "1");
  if (query.page > 1) params.set("page", String(query.page));
  if (query.q.trim()) params.set("q", query.q.trim());
  return params.toString();
}
// 「¥53.68 → ¥25.12（−53.2%）」；回流的人没有这一格
export function changeText(row: ChurnRow, rate: number): string {
  if (row.before == null || row.after == null) return EMPTY;
  const pct = row.before > 0 ? deltaText(row.after, row.before) : EMPTY;
  return COPY.churn.change(money(row.before, rate), money(row.after, rate), pct);
}
export const lossText = (row: ChurnRow, rate: number): string => (row.loss == null ? EMPTY : COPY.churn.lossPerDay(money(row.loss, rate)));

// 月留存写整数百分比（86%），一两个人的差别不用写到小数
const wholePct = (ratio: number) => `${Math.round(ratio * 100)}%`;

// 四个数；补数据没补到的写「—」「补满后再算」
export function churnKpis(page: ChurnPage): Kpi[] {
  const s = page.summary, r = page.ready, rate = page.rate, C = COPY.churn;
  const out: Kpi[] = [];
  out.push({
    key: "down", title: C.kpiDown, titleHint: C.kpiDownHint,
    value: r.down ? C.count(s.down.count) : EMPTY, sub: !r.down ? C.afterFill : s.down.count > 0 ? C.downSub(money(s.down.loss, rate)) : C.downNone,
  });
  out.push({
    key: "newChurn", title: C.kpiNewChurn, titleHint: C.kpiNewChurnHint,
    value: r.churn ? C.count(s.newChurn.count) : EMPTY, sub: !r.churn ? C.afterFill : s.newChurn.count > 0 ? C.newChurnSub(money(s.newChurn.monthly, rate)) : C.newChurnNone,
  });
  const ret = s.retention;
  let retValue: string = EMPTY, retSub: string = C.afterFill;
  if (ret) {
    retValue = ret.rate == null ? EMPTY : wholePct(ret.rate);
    if (ret.rate == null) retSub = C.retentionNone;
    else if (ret.prev && ret.prev.rate != null) retSub = C.retentionPrev(wholePct(ret.prev.rate), Math.round(ret.prev.rate * 100) - Math.round(ret.rate * 100));
    else retSub = C.retentionFirst(ret.cohort, ret.kept);
  }
  out.push({ key: "retention", title: C.kpiRetention, titleHint: C.kpiRetentionHint, value: retValue, sub: retSub });
  out.push({
    key: "returned", title: C.kpiReturned, titleHint: C.kpiReturnedHint,
    value: r.churn ? C.count(s.returned.count) : EMPTY, sub: !r.churn ? C.afterFill : s.returned.count > 0 ? "" : C.returnedNone,
  });
  return out;
}
// 回流那一格下面的一句：名字（链接）+ 近 7 天花了多少；超过 3 个写「nova 等 4 个」，点了在表里列出来
export type ReturnedPart = { kind: "text"; text: string } | { kind: "user"; id: number; name: string } | { kind: "list"; text: string };
export function returnedParts(page: ChurnPage): ReturnedPart[] {
  const { count, top } = page.summary.returned, rate = page.rate, C = COPY.churn;
  if (!page.ready.churn || count === 0) return [];
  if (count > top.length) return [{ kind: "list", text: C.returnedMore(top[0].username, count) }];
  const spend = money(top.reduce((total, item) => total + item.spend, 0), rate);
  const names: ReturnedPart[] = top.flatMap((item, index) => [...(index ? [{ kind: "text", text: "、" } as ReturnedPart] : []), { kind: "user", id: item.id, name: item.username } as ReturnedPart]);
  return [...names, { kind: "text", text: ` ${top.length > 1 ? C.returnedSpendMany(spend) : C.returnedSpend(spend)}` }];
}
