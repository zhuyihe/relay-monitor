// 模型供需页的类型和把接口的数拼成页面上的字（字在 copy.ts；判断规则的数字在 lib/models-view.js，页面不重算）。钱都按自营站点的汇率换成显示的币种。
import { EMPTY, formatDays, formatDeltaPct, formatMoney, formatPct } from "../../../lib/format.js";
import { MODELS_VIEW } from "../../../lib/models-view.js";
import type { Level } from "../../components/status";
import { COPY } from "./copy";
import type { ChannelState, GapTag } from "./copy";

export type Runway = { days: number | null; noSpend: boolean; level: Level; text: string; failed: boolean; fixed?: boolean };
export type Success = { state: "none" | "unread" | "few" | "ok"; rate: number | null; requests: number | null };
export type MainUpstream = { upstreamId: string; name: string | null; share: number; runway: Runway | null };
export type ModelRow = {
  name: string; week: number; prev: number; isNew: boolean; success: Success;
  supply: { upstreams: number; open: number; stopped: number };
  main: MainUpstream | null; tags: GapTag[]; gap: boolean;
};
export type ModelsPage = {
  asOf: number; tz: string; rate: number; critDays: number; rows: ModelRow[];
  summary: {
    missing: { count: number; lostPerDay: number };
    single: { count: number; share: number | null };
    soon: { count: number; first: { name: string; days: number } | null };
    rising: { count: number; first: { name: string; ratio: number } | null };
  };
  flowReadable: boolean; perfReadable: boolean;
};
export type DetailChannel = { channelId: number; name: string; state: ChannelState; priority: number; share: number | null; upstream: { id: string; name: string | null; runway: Runway | null } | null };
export type Price = { kind: "ratio" | "perCall"; value: number };
export type FinderRow = {
  upstreamId: string; name: string | null; price: Price | null; readable: boolean; supplying: boolean; runway: Runway | null; bindable: boolean;
  main: boolean; compare: { kind: "same" | "cheaper" | "pricier"; pct: number } | null;
};
export type ModelDetail = {
  name: string; row: ModelRow; rate: number; tz: string; asOf: number; critDays: number;
  dayBars: { day: string; cost: number }[];
  successLine: { points: { day: string; rate: number | null }[]; low: { day: string; rate: number } | null } | null;
  channels: DetailChannel[];
  users: { top: { user: string; cost: number; userId: number | null }[]; others: { count: number; cost: number } | null; total: number } | null;
  finder: FinderRow[]; flowReadable: boolean;
};

export const money = (usd: number | null | undefined, rate: number, opts?: Parameters<typeof formatMoney>[1]) => (usd == null || !Number.isFinite(usd) ? EMPTY : formatMoney(usd * rate, opts));
// 「约 ¥20」：门槛的钱数取整好读（十几块取整、几十块取 5 的倍数）
export const roughMoney = (usd: number, rate: number) => {
  const value = usd * rate;
  return formatMoney(value >= 10 ? Math.round(value / 5) * 5 : Math.round(value), { dp: 0 });
};

export const deltaText = (week: number, prev: number) => (prev > 0 ? COPY.vsPrev(formatDeltaPct((week - prev) / prev)) : COPY.vsNone);
export const successText = (success: Success) => (success.state === "none" ? COPY.successNone : success.state === "unread" ? COPY.successUnread
  : success.state === "few" ? COPY.successFew : formatPct((success.rate ?? 0) / 100));
export const supplyText = (row: ModelRow) => COPY.supply(row.supply.upstreams, row.supply.open);

// 四个数
export type Kpi = { key: "missing" | "single" | "soon" | "rising"; title: string; value: string; sub: string; model: string | null; more: string | null };
export function kpisOf(page: ModelsPage): Kpi[] {
  const { missing, single, soon, rising } = page.summary, rate = page.rate;
  const more = (count: number) => (count > 1 ? COPY.kpi.more(count - 1) : null);
  return [
    { key: "missing", title: COPY.kpi.missing, value: COPY.kpi.count(missing.count), sub: missing.count ? COPY.kpi.missingSub(money(missing.lostPerDay, rate)) : COPY.kpi.missingNone, model: null, more: null },
    { key: "single", title: COPY.kpi.single, value: COPY.kpi.count(single.count), sub: single.count && single.share != null ? COPY.kpi.singleSub(formatPct(single.share, 0)) : COPY.kpi.singleNone, model: null, more: null },
    { key: "soon", title: COPY.kpi.soon, value: COPY.kpi.count(soon.count), sub: soon.first ? COPY.kpi.soonSub(daysText(soon.first.days)) : COPY.kpi.soonNone, model: soon.first?.name ?? null, more: more(soon.count) },
    { key: "rising", title: COPY.kpi.rising, value: COPY.kpi.count(rising.count), sub: rising.first ? COPY.kpi.risingSub(rising.first.ratio.toFixed(1)) : COPY.kpi.risingNone, model: rising.first?.name ?? null, more: more(rising.count) },
  ];
}
// 可用天数的写法和上游列表一样（lib/format.js formatDays）：不到 1 天写小时
export const daysText = (days: number) => formatDays(days);

// 「怎么判断的」里的数：读 MODELS_VIEW 同一份
export const howNumbers = (rate: number) => ({
  minRequests: MODELS_VIEW.MIN_REQUESTS, failPct: MODELS_VIEW.FAIL_BELOW_PCT, soonDays: MODELS_VIEW.SOON_DAYS, ratio: MODELS_VIEW.RISING_RATIO, minPrev: roughMoney(MODELS_VIEW.RISING_MIN_PREV_USD, rate),
});

// 表头点一下按那一列排；null 是默认排法（分两段）
export type SortKey = "model" | "week" | "success" | "supply" | "main" | "gap";
export type Sort = { key: SortKey; dir: "asc" | "desc" } | null;
const SORT_VALUE: Record<SortKey, (row: ModelRow) => number | string | null> = {
  model: (row) => row.name,
  week: (row) => row.week,
  success: (row) => (row.success.state === "ok" || row.success.state === "few" ? row.success.rate : null),
  supply: (row) => row.supply.open,
  main: (row) => (row.main?.runway ? (row.main.runway.noSpend ? Infinity : row.main.runway.days) : null),
  gap: (row) => row.tags.length,
};
export const SORT_KEYS = Object.keys(SORT_VALUE) as SortKey[];
export function sortRows(rows: ModelRow[], sort: Sort): ModelRow[] {
  if (!sort) return rows;
  const pick = SORT_VALUE[sort.key], k = sort.dir === "asc" ? 1 : -1;
  return rows.map((row, i) => ({ row, i, v: pick(row) })).sort((a, b) => {
    // 空的永远排最后，不随方向翻转
    if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
    const c = typeof a.v === "string" || typeof b.v === "string" ? String(a.v).localeCompare(String(b.v), "zh-CN") : a.v === b.v ? 0 : a.v < b.v ? -1 : 1;
    return c === 0 ? a.i - b.i : c * k;
  }).map((item) => item.row);
}
export const nextSort = (current: Sort, key: SortKey): Sort => (current && current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "model" ? "asc" : "desc" });
export const parseSort = (key: string | null, dir: string | null): Sort => (SORT_KEYS.includes(key as SortKey) ? { key: key as SortKey, dir: dir === "asc" ? "asc" : "desc" } : null);

// 找货帮手一行的「价格」「和现在用的比」
export const priceText = (price: Price | null, rate: number) => (!price ? COPY.drawer.unreadablePrice : price.kind === "ratio" ? COPY.drawer.ratio(price.value) : COPY.drawer.perCall(money(price.value, rate, { dp: 4 })));
export const compareText = (row: FinderRow) => (row.main ? COPY.drawer.mainNow : !row.compare ? EMPTY
  : row.compare.kind === "same" ? COPY.drawer.same : row.compare.kind === "cheaper" ? COPY.drawer.cheaper(formatPct(row.compare.pct, 0)) : COPY.drawer.pricier(formatPct(row.compare.pct, 0)));

// 去上游资源里那个上游的「绑定渠道」小窗口
export const bindLink = (upstreamId: string) => `/stations?action=channels&stationId=${encodeURIComponent(upstreamId)}&bind=1`;
// 用户运营页里那个用户的抽屉
export const userLink = (userId: number) => `/users?user=${userId}`;
export const MY_LINK = "/my?tab=models";
