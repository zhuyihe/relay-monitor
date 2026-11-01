// 模型供需页的类型和把接口的数拼成页面上的字（字在 copy.ts；算数在 lib/models-lost.js、lib/models-headroom.js，页面不重算，只拼字）。钱都按自营站点的汇率换成显示的币种。
// 页面只读 headroom.lost（近 24 小时缺货失败）和 headroom.upstreams；老的 state / kpis / rows 不读。
import { EMPTY, formatDayKey, formatDays, formatMoney, formatPct } from "../../../lib/format.js";
import type { Level } from "../../components/status";
import { COPY } from "./copy";
import type { ChannelState } from "./copy";
import type { DetailChannelHeadroom, HeadroomDetail, HeadroomPage, LostByReason, LostCause, LostReco, LostRow, LostView, Peak, UpstreamHeadroom } from "./headroom-types";

export type { ChannelState, LostCause, LostReco, LostRow };

// 断货的模型（一个开着的渠道都没有，断货前每天还在卖）：lost24 是 null，少收、明天预计是估计值，outSince 是断货起点那一天（YYYY-MM-DD，不知道是 null）
export type LostRowView = LostRow;
export const isOut = (row: { lost24: number | null }) => row.lost24 === null;
export type LostViewData = LostView;
export type UpstreamView = UpstreamHeadroom;
export type ChannelView = DetailChannelHeadroom;

export type Runway = { days: number | null; noSpend: boolean; level: Level; text: string; failed: boolean; fixed?: boolean };
// headroom 是 null：这一次没算出来（数据量太大、没有数据库、读库出错），页面写一句话
export type ModelsPage = { asOf: number; tz: string; rate: number; critDays: number; headroom: (Omit<HeadroomPage, "lost" | "upstreams"> & { lost: LostViewData; upstreams: UpstreamView[] }) | null };
export type SiteLinks = HeadroomPage["links"];
// 页面里 headroom 一定有（没有就写一句话，不画下面这些）
export type LoadedPage = ModelsPage & { headroom: NonNullable<ModelsPage["headroom"]> };
// 抽屉里这几样还是第 0 步的读法：渠道的停用原因（stopReason、stopTime）、找货帮手（价格、在不在供）
export type DetailChannel = { channelId: number; name: string; state: ChannelState; stopReason?: string | null; stopTime?: number | null };
export type Price = { kind: "ratio" | "perCall"; value: number };
export type FinderRow = {
  upstreamId: string; name: string | null; price: Price | null; readable: boolean; supplying: boolean; runway: Runway | null; bindable: boolean;
  main: boolean; compare: { kind: "same" | "cheaper" | "pricier"; pct: number } | null;
};
export type DetailHeadroom = Omit<HeadroomDetail, "channels" | "lost"> & { channels: ChannelView[]; lost: LostRowView | null };
export type ModelDetail = {
  name: string; rate: number; tz: string; asOf: number; critDays: number;
  headroom: DetailHeadroom | null;
  channels: DetailChannel[];
  finder: FinderRow[];
};

// 钱：整数元，「约」由调用的字加（一个数前面最多一个「约」）
export const money = (usd: number | null | undefined, rate: number, opts?: Parameters<typeof formatMoney>[1]) => (usd == null || !Number.isFinite(usd) ? EMPTY : formatMoney(usd * rate, opts));
export const yuan = (usd: number | null | undefined, rate: number) => money(usd, rate, { dp: 0 });

// 次数：千位逗号。预计的数（明天预计、每小时最多接）是估的，不写到个位：1,000 以上取到百，100 以上取到十
export const count = (n: number) => Math.round(n).toLocaleString("en-US");
export const approx = (n: number) => {
  const step = n >= 1000 ? 100 : n >= 100 ? 10 : 1;
  return count(Math.round(n / step) * step);
};

// 钟点写成「21–24 点」：一段连着的钟点，第一个到最后一个加 1（24 点就写 24，跨午夜 [23, 0] 写「23–1 点」）；不连着的几段用「、」隔开。
export const hoursText = (hours: number[]) => {
  const set = new Set(hours.map((h) => ((h % 24) + 24) % 24));
  // 每一段从「前一个钟点不在里面」的那个钟点开始（23 和 0 算连着）；全天都在时从 0 点起
  const starts = [...set].filter((h) => !set.has((h + 23) % 24)).sort((a, b) => a - b);
  if (!starts.length) return set.size ? "0–24 点" : "";
  return starts.map((start) => {
    let last = start;
    while (set.has((last + 1) % 24) && (last + 1) % 24 !== start) last = (last + 1) % 24;
    return `${start}–${last + 1} 点`;
  }).join("、");
};
export const peakText = (peak: Peak | null | undefined) => (peak?.hours?.length ? hoursText(peak.hours) : null);

// 上游撑不到的小时数写成字，和上游列表同一种说法（formatDays）
export const hoursLeftText = (hours: number | null | undefined) => (hours == null ? EMPTY : formatDays(hours / 24));

export const causeText = (cause: LostCause | null | undefined) => (cause ? COPY.causes[cause] : EMPTY);
export const upstreamName = (ref: { name: string | null } | null | undefined) => ref?.name ?? COPY.thatUpstream;

// 出在哪家上游：「上游甲」，涉及两家以上「上游甲 等 2 家」；没有写「—」
export function upstreamCell(row: LostRowView): string {
  if (!row.mainUpstream) return EMPTY;
  const name = upstreamName(row.mainUpstream);
  return (row.upstreamCount ?? 1) > 1 ? COPY.upstreamMany(name, row.upstreamCount!) : name;
}
// 明天预计：「约 200 次」；不到 1 次写「不缺」；断货的写「仍断货」
export const tomorrowText = (n: number, out = false) => (out ? COPY.outTomorrow : n < 0.5 ? COPY.tomorrowNone : COPY.tomorrowTimes(approx(n)));
// 断货从哪天起：「10月30日起」；接口只给到哪一天（YYYY-MM-DD），不知道不写
export const outSinceText = (day: string | null | undefined, tz: string, now: number): string | null => (day ? `${formatDayKey(day, tz, now)}起` : null);

// 建议：一句话，不加理由行。X 是出问题的上游，Y 是能把量挪过去的上游
export function recoText(reco: LostReco): string {
  const R = COPY.reco;
  const x = upstreamName(reco as { name: string | null });
  switch (reco.kind) {
    case "topup": return R.topup(x);
    case "rateLimit": {
      const y = reco.moveTo ? upstreamName(reco.moveTo) : null;
      if (reco.accountLimited) return y ? R.quota(x, y) : R.quotaOnly(x);
      if (reco.addKeys && reco.addKeys.n >= 1) return y ? R.addKeysN(x, reco.addKeys.n, y) : R.addKeysNOnly(x, reco.addKeys.n);
      return y ? R.addKeys(x, y) : R.addKeysOnly(x);
    }
    case "fault": return reco.moveTo ? R.fault(x, upstreamName(reco.moveTo)) : R.faultOnly(x);
    case "openChannel": return R.openChannel;
    default: return EMPTY;
  }
}

// 顶上三个数
export type Kpi = {
  key: "tomorrow" | "last24" | "topup"; title: string; value: string; sub: string;
  // 下一行里可点的部分：最缺的模型、重点用户、快没钱的上游
  lead?: { kind: "model" | "upstream"; id: string; name: string } | null; before?: string; after?: string; users?: number | null; tail?: string;
};
export function kpisOf(page: LoadedPage): Kpi[] {
  const { lost } = page.headroom, K = COPY.kpi, rate = page.rate;
  const off = lost.status === "noErrorLog";
  const t = lost.kpis.tomorrow, l = lost.kpis.last24;
  // 最缺的、断货的个数都由接口给（最缺的不算断货的）
  const worst = t?.top ?? null;
  const tomorrow: Kpi = off || !t
    ? { key: "tomorrow", title: K.tomorrow, value: K.dash, sub: "" }
    : t.count > 0 && worst
      ? { key: "tomorrow", title: K.tomorrow, value: K.models(t.count), sub: "", before: K.tomorrowBefore(approx(t.lost)), lead: { kind: "model", id: worst.name, name: worst.name } }
      : t.count > 0 && t.outOfStockCount > 0
        ? { key: "tomorrow", title: K.tomorrow, value: K.models(t.count), sub: K.tomorrowAllOut(t.outOfStockCount) }
        : { key: "tomorrow", title: K.tomorrow, value: K.models(0), sub: K.tomorrowNone };
  const last24: Kpi = off || !l
    ? { key: "last24", title: K.last24, value: K.dash, sub: "" }
    : l.lost > 0 || l.outOfStockCount > 0
      ? { key: "last24", title: K.last24, value: K.times(l.lost), sub: K.last24Lost(yuan(l.lostUsd, rate)), users: l.keyUsers > 0 ? l.keyUsers : null, tail: l.outOfStockCount > 0 ? K.outModels(l.outOfStockCount) : undefined }
      : { key: "last24", title: K.last24, value: K.times(0), sub: K.last24None };
  const u = lost.kpis.topup;
  const topup: Kpi = u.count > 0 && u.first
    ? { key: "topup", title: K.topup, value: K.upstreams(u.count), sub: "", lead: u.first.upstreamId ? { kind: "upstream", id: u.first.upstreamId, name: upstreamName(u.first) } : null, before: u.first.upstreamId ? "" : upstreamName(u.first), after: u.count > 1 ? K.topupMany(u.count, noAbout(hoursLeftText(u.first.hoursLeft))) : K.topupOne(noAbout(hoursLeftText(u.first.hoursLeft))) }
    : { key: "topup", title: K.topup, value: K.upstreams(0), sub: K.topupNone };
  return [tomorrow, last24, topup];
}
// 「约 5 小时」去掉前面的「约」：这一句里数字前不叠「约」
const noAbout = (text: string) => text.replace(/^约 /, "");

// 上游卡片：近 24 小时限流、故障、没钱各几次
export const upstreamRunway = (hours: number | null, critDays: number) => (hours == null ? null : { days: hours / 24, level: (hours / 24 <= critDays ? "crit" : "good") as Level, text: hoursLeftText(hours) });
export const lostTotal = (lost: LostByReason | null | undefined) => (lost ? lost.rate_limit + lost.upstream + lost.auth_quota : 0);

// 带 ↗ 的动作链接：到你的站或上游网站去，控制台不替用户改任何东西。地址由接口给（links）
export function actionHref(action: "topup" | "addKey" | "weights", upstreamId: string | null, links: SiteLinks | null | undefined): string | null {
  if (!links) return null;
  if (action === "weights") return links.own ? `${links.own}/console/channel` : null;
  const site = upstreamId ? links.upstreams[upstreamId] : null;
  // 只有 New API 的上游路径是确定的；Sub2API 等别的上游不给链接（写灰字）。地址里不带查询串
  if (!site?.baseUrl || site.type !== "newapi") return null;
  return `${site.baseUrl}${action === "topup" ? "/console/topup" : "/console/token"}`;
}

// 抽屉图下面一句：失败多在 21–24 点，主要是上游甲限流。
export function conclusionText(lost: LostRowView | null): string {
  const C = COPY.drawer.conclusion;
  if (!lost || lost.lost24 === null || lost.lost24 <= 0) return C.none;
  const when = lost.peakFailHours?.hours.length ? C.when(hoursText(lost.peakFailHours.hours)) : "";
  const who = lost.mainUpstream ? upstreamName(lost.mainUpstream) : "";
  const tail = lost.mainCause === "no_channel" ? C.noChannel : lost.mainCause ? C.mainly(`${who}${causeText(lost.mainCause)}`) : "";
  return `${[when, tail].filter(Boolean).join("，")}。`;
}

// 抽屉渠道表的「每小时最多接约 X 次」：只在测到上限时写
export const limitLine = (channel: ChannelView) => (channel.limit.kind === "measured" && channel.limit.value != null ? COPY.drawer.channelLimit(approx(channel.limit.value)) : null);

// 找货帮手一行的「价格」「和现在用的比」
export const priceText = (price: Price | null, rate: number) => (!price ? COPY.drawer.unreadablePrice : price.kind === "ratio" ? COPY.drawer.ratio(price.value) : COPY.drawer.perCall(money(price.value, rate, { dp: 4 })));
export const compareText = (row: FinderRow) => (row.main ? COPY.drawer.mainNow : !row.compare ? EMPTY
  : row.compare.kind === "same" ? COPY.drawer.same : row.compare.kind === "cheaper" ? COPY.drawer.cheaper(formatPct(row.compare.pct, 0)) : COPY.drawer.pricier(formatPct(row.compare.pct, 0)));

// 去上游资源里那个上游的「绑定渠道」小窗口
export const bindLink = (upstreamId: string) => `/stations?action=channels&stationId=${encodeURIComponent(upstreamId)}&bind=1`;
// 用户运营页里那个用户的抽屉
export const userLink = (userId: number) => `/users?user=${userId}`;
// 用户运营页（顶上第二格「影响 N 个重点用户」点了去那里）
export const USERS_LINK = "/users";
