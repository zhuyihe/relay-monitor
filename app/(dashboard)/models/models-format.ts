// 模型供需页的类型和把接口的数拼成页面上的字（字在 copy.ts；判断和算数在 lib/models-headroom.js，页面不重算，只拼字）。钱都按自营站点的汇率换成显示的币种。
import { EMPTY, formatDays, formatMoney, formatPct } from "../../../lib/format.js";
import type { Level } from "../../components/status";
import { COPY } from "./copy";
import type { ChannelState } from "./copy";
import type { BlockedByReason, HeadroomDetail, HeadroomPage, HeadroomRow, Margin, Peak, Quantity, Reco, UpstreamHeadroom } from "./headroom-types";

export type { BlockedByReason, HeadroomDetail, HeadroomPage, HeadroomRow, Margin, Peak, Quantity, Reco, UpstreamHeadroom };
export type { ChannelState };

export type Runway = { days: number | null; noSpend: boolean; level: Level; text: string; failed: boolean; fixed?: boolean };
// 带 ↗ 的动作链接要的地址（到你的站、上游网站）：接口给，没有就不放链接
export type SiteLinks = { own: string | null; upstreams: Record<string, { baseUrl: string; type: string } | null> };
export type ModelsPage = { asOf: number; tz: string; rate: number; critDays: number; headroom: HeadroomPage & { links?: SiteLinks | null } };
// 抽屉里这几样还是第 0 步的读法：渠道的停用原因（stopReason、stopTime）、找货帮手（价格、在不在供）
export type DetailChannel = { channelId: number; name: string; state: ChannelState; stopReason?: string | null; stopTime?: number | null };
export type Price = { kind: "ratio" | "perCall"; value: number };
export type FinderRow = {
  upstreamId: string; name: string | null; price: Price | null; readable: boolean; supplying: boolean; runway: Runway | null; bindable: boolean;
  main: boolean; compare: { kind: "same" | "cheaper" | "pricier"; pct: number } | null;
};
export type ModelDetail = {
  name: string; rate: number; tz: string; asOf: number; critDays: number;
  headroom: HeadroomDetail;
  channels: DetailChannel[];
  finder: FinderRow[];
};

export const money = (usd: number | null | undefined, rate: number, opts?: Parameters<typeof formatMoney>[1]) => (usd == null || !Number.isFinite(usd) ? EMPTY : formatMoney(usd * rate, opts));

// 次数：千位逗号。带「约」「至少」的量是估出来的，不写到个位：1,000 以上取到百，100 以上取到十
export const count = (n: number) => Math.round(n).toLocaleString("en-US");
export const approx = (n: number) => {
  const step = n >= 1000 ? 100 : n >= 100 ? 10 : 1;
  return count(Math.round(n / step) * step);
};

// 「21–23 点」：高峰的第一个钟点到最后一个钟点加 1（跨午夜时 [23, 0] 写「23–1 点」）
export const peakText = (peak: Peak | null | undefined) => {
  const hours = peak?.hours;
  if (!hours?.length) return null;
  return `${hours[0]}–${(hours[hours.length - 1] + 1) % 24} 点`;
};
// 抽屉结论里的钟点：[21, 22, 23] → 「21–24 点」，不连着的「9 点、21–23 点」
export const hoursText = (hours: number[]) => {
  const list = [...new Set(hours)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j += 1;
    parts.push(i === j ? `${list[i]} 点` : `${list[i]}–${list[j] + 1} 点`);
    i = j + 1;
  }
  return parts.join("、");
};

// 一个量写成字：测到的「约 X」、没碰到过上限的「至少 X」、数据积累中、拿不到「—」
export function quantityText(q: Quantity | null | undefined): string {
  if (!q) return COPY.dash;
  if (q.kind === "accumulating") return COPY.accumulating;
  if (q.kind === "unavailable" || q.value == null) return COPY.dash;
  return q.kind === "atLeast" ? COPY.atLeast(approx(q.value)) : COPY.approx(approx(q.value));
}

// 涨幅「+9%」「−5%」；growth 是倍数
export const growthText = (growth: number | null | undefined) => {
  if (growth == null || !Number.isFinite(growth)) return COPY.growthNone;
  const pct = Math.round((growth - 1) * 100);
  return COPY.growth(`${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`);
};

// 余量或缺口那一格：short 红菱形加「至少缺」，thin 墨色「余」，ok 灰色「余」，上限没测到、数据积累中、要开错误日志各写各的
export type MarginView = { tone: "short" | "thin" | "ok" | "muted"; text: string };
export function marginView(row: Pick<HeadroomRow, "margin" | "supply">, state: HeadroomPage["state"]): MarginView {
  const { margin, supply } = row;
  if (state === "noErrorLog") return { tone: "muted", text: COPY.margin.needLog };
  if (supply.kind === "accumulating") return { tone: "muted", text: COPY.accumulating };
  if (margin.status === "unknown") return { tone: "muted", text: COPY.margin.unknown };
  if (margin.status === "none" || margin.value == null) return { tone: "muted", text: COPY.dash };
  if (margin.status === "short") return { tone: "short", text: COPY.margin.short(approx(Math.abs(margin.value))) };
  const text = supply.kind === "atLeast" ? COPY.margin.roomAtLeast(approx(margin.value)) : COPY.margin.room(approx(margin.value));
  return { tone: margin.status === "thin" ? "thin" : "ok", text };
}

// 上游撑不到的小时数写成字，和上游列表同一种说法（formatDays）
export const hoursLeftText = (hours: number | null | undefined) => (hours == null ? EMPTY : formatDays(hours / 24));

// 建议：一句动作加一行理由。没开错误日志、数据积累中时只给钱的（撑不到今晚的先充值），别的写「上限还没测到」
export type RecoView = { title: string; why: string; kind: Reco["kind"] };
export function recoView(row: Pick<HeadroomRow, "reco" | "supply" | "margin">, state: HeadroomPage["state"]): RecoView {
  const reco = row.reco;
  const R = COPY.reco;
  const name = (value: string | null) => value ?? R.thatUpstream;
  if (reco.kind === "topup") return { kind: "topup", title: R.topup(name(reco.name)), why: R.topupWhy(hoursLeftText(reco.hoursLeft)) };
  const unmeasured = (): RecoView => ({
    kind: "unmeasured", title: R.unmeasured,
    why: state === "noErrorLog" ? R.unmeasuredNeedLog
      : row.supply.kind === "atLeast" && row.supply.value != null ? R.unmeasuredAtLeast(approx(row.supply.value)) : R.unmeasuredAccumulating,
  });
  if (state !== "ok") return unmeasured();
  switch (reco.kind) {
    case "switch": return { kind: "switch", title: R.switch(name(reco.name)), why: R.switchWhy(reco.keys) };
    case "addKeys": return { kind: "addKeys", title: R.addKeys(reco.n, name(reco.name)), why: R.addKeysWhy(approx(reco.perKey)) };
    case "thin": return { kind: "thin", title: R.thin, why: row.margin.value != null ? R.thinWhy(approx(row.margin.value)) : "" };
    case "unmeasured": return unmeasured();
    default: return { kind: "none", title: COPY.dash, why: "" };
  }
}

// 顶上三个数
export type Kpi = { key: "willShort" | "notBought" | "topup"; title: string; value: string; sub: string; lead?: { kind: "model" | "upstream"; id: string; name: string } | null; subAfter?: string; extra?: string; more?: string | null };
export function kpisOf(page: ModelsPage): Kpi[] {
  const { headroom } = page, { kpis } = headroom, rate = page.rate;
  const willShort: Kpi = !kpis.willShort
    ? { key: "willShort", title: COPY.kpi.willShort, value: COPY.kpi.dash, sub: COPY.kpi.needLog }
    : kpis.willShort.worst && kpis.willShort.count > 0
      ? { key: "willShort", title: COPY.kpi.willShort, value: COPY.kpi.models(kpis.willShort.count), sub: "", lead: { kind: "model", id: kpis.willShort.worst.name, name: kpis.willShort.worst.name }, subAfter: COPY.kpi.willShortWorst(approx(kpis.willShort.worst.gap), peakText(kpis.willShort.worst.peak)) }
      : { key: "willShort", title: COPY.kpi.willShort, value: COPY.kpi.models(0), sub: COPY.kpi.willShortNone };
  const nb = kpis.notBought;
  const notBought: Kpi = !nb
    ? { key: "notBought", title: COPY.kpi.notBought, value: COPY.kpi.dash, sub: COPY.kpi.needLog }
    : {
      key: "notBought", title: COPY.kpi.notBought, value: COPY.kpi.notBoughtValue(nb.f24),
      sub: nb.f24 > 0 || nb.blockedRetried > 0
        ? [nb.f24 > 0 ? COPY.kpi.notBoughtLost(money(nb.lostUsd, rate)) : null, nb.blockedRetried > 0 ? COPY.kpi.notBoughtRetried(nb.blockedRetried) : null].filter(Boolean).join("；")
        : COPY.kpi.notBoughtNone,
      extra: nb.keyUsers > 0 ? COPY.kpi.notBoughtUsers(nb.keyUsers) : undefined,
    };
  const topup = kpis.topup;
  const upstream: Kpi = topup.count > 0 && topup.first
    ? { key: "topup", title: COPY.kpi.topup, value: COPY.kpi.upstreams(topup.count), sub: "", lead: { kind: "upstream", id: topup.first.upstreamId, name: topup.first.name ?? COPY.reco.thatUpstream }, subAfter: COPY.kpi.topupFirst(hoursLeftText(topup.first.hoursLeft)), more: topup.count > 1 ? COPY.kpi.more(topup.count) : null }
    : { key: "topup", title: COPY.kpi.topup, value: COPY.kpi.upstreams(0), sub: COPY.kpi.topupNone };
  return [willShort, notBought, upstream];
}

// 余量条要的几个数：轨道最长 = 要和能给里大的那个再放宽一点；竖线 = 能给；灰色填充 = 要；超出竖线的那截 = 缺口
export type BarShape = { track: number; line: number | null; fill: number; over: number; dashed: boolean };
export function barShape(need: number | null, supply: Quantity | null | undefined): BarShape | null {
  if (need == null || !supply || supply.value == null || (supply.kind !== "measured" && supply.kind !== "atLeast")) return null;
  const top = Math.max(need, supply.value, 1) * 1.12;
  const line = supply.value / top, fill = Math.min(need, supply.value) / top;
  return { track: 1, line, fill, over: need > supply.value ? (need - supply.value) / top : 0, dashed: supply.kind === "atLeast" };
}

// 上游卡片
export function upstreamLimitText(item: UpstreamHeadroom, state: HeadroomPage["state"]): string {
  const U = COPY.upstream;
  if (state === "noErrorLog") return U.limitNeedLog;
  if (item.limit.kind === "accumulating") return U.limitAccumulating;
  if (item.limit.kind === "unavailable" || item.limit.value == null) return U.limitDash;
  return item.limit.kind === "atLeast" ? U.limitAtLeast(approx(item.limit.value)) : U.limit(approx(item.limit.value));
}
export const upstreamRunway = (hours: number | null, critDays: number) => (hours == null ? null : { days: hours / 24, level: (hours / 24 <= critDays ? "crit" : "good") as Level, text: hoursLeftText(hours) });

// 带 ↗ 的动作链接：到你的站或上游网站去，控制台不替用户改任何东西。地址由接口给（links）
export function actionHref(action: "topup" | "addKey" | "weights", upstreamId: string | null, links: SiteLinks | null | undefined): string | null {
  if (!links) return null;
  if (action === "weights") return links.own ? `${links.own}/console/channel` : null;
  const site = upstreamId ? links.upstreams[upstreamId] : null;
  if (!site?.baseUrl) return null;
  if (site.type !== "newapi") return site.baseUrl;
  return `${site.baseUrl}${action === "topup" ? "/console/topup" : "/console/token"}`;
}

// 抽屉里图下面一句结论（从 facts 拼）：每晚 21–23 点超过上限，被挡的多是上游限流，其中至少 186 个最后没买到；平时有约 3,000 次/小时的余量。
export function conclusionText(facts: HeadroomDetail["facts"]): string {
  const C = COPY.drawer.conclusion;
  let text = facts.overLimitHours.length ? C.over(hoursText(facts.overLimitHours)) : C.overNone;
  if (facts.topReason) text += C.reason(C.reasons[facts.topReason]);
  if (facts.notBought24 > 0) text += C.lost(facts.notBought24);
  if (facts.typicalRoom != null && facts.typicalRoom > 0) text += C.room(approx(facts.typicalRoom));
  return text + C.end;
}

// 渠道状态那一格：满了 / 空约 / 上限没测到 / 被自动停用，不算 / 已停用，不算
export function channelStatusText(item: HeadroomDetail["channels"][number]): { text: string; full: boolean } {
  const S = COPY.drawer.channelStatus;
  if (item.status === "full") return { text: S.full, full: true };
  if (item.status === "room") return { text: item.room == null ? S.unmeasured : item.limit.kind === "atLeast" ? S.roomAtLeast(approx(item.room)) : S.room(approx(item.room)), full: false };
  if (item.status === "auto") return { text: S.auto, full: false };
  if (item.status === "off") return { text: S.off, full: false };
  return { text: S.unmeasured, full: false };
}

// 找货帮手一行的「价格」「和现在用的比」
export const priceText = (price: Price | null, rate: number) => (!price ? COPY.drawer.unreadablePrice : price.kind === "ratio" ? COPY.drawer.ratio(price.value) : COPY.drawer.perCall(money(price.value, rate, { dp: 4 })));
export const compareText = (row: FinderRow) => (row.main ? COPY.drawer.mainNow : !row.compare ? EMPTY
  : row.compare.kind === "same" ? COPY.drawer.same : row.compare.kind === "cheaper" ? COPY.drawer.cheaper(formatPct(row.compare.pct, 0)) : COPY.drawer.pricier(formatPct(row.compare.pct, 0)));
export const finderRoomText = (room: number | null | undefined) => (room == null ? EMPTY : COPY.drawer.finderRoom(approx(room)));

// 去上游资源里那个上游的「绑定渠道」小窗口
export const bindLink = (upstreamId: string) => `/stations?action=channels&stationId=${encodeURIComponent(upstreamId)}&bind=1`;
// 用户运营页里那个用户的抽屉
export const userLink = (userId: number) => `/users?user=${userId}`;
