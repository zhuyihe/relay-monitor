// 模型供需页要的数：纯函数，输入是读到的自营站点数据（server/models-page.js 读出来给），输出是接口的响应。钱都是美元，页面按自营站点的汇率换算。
// 判断规则的数字都放在 MODELS_VIEW 一处，页面上「怎么判断的」那一段也读这一份（app/(dashboard)/models/copy.ts），不另写一遍。
// 口径（design 模型供需 v1）：
//   - 列哪些模型：近 30 天有消费的；只配在渠道上、没卖过的不列；
//   - 近 7 天是最近 7 个整天，不含今天；前 7 天是再往前 7 个整天；今天单独（图里浅色）；
//   - 断货：开着的渠道（状态 1）里一个都没有列这个模型；
//   - 卖不出去：近 24 小时成功率低于 95%，并且请求有 50 次以上。接口只给成功率不给请求数，请求数用「近 24 小时成功的请求数 ÷ 成功率」估；
//     成功率是 0（全部失败）时成功数也是 0，估不出来，改用近 7 天日均成功的请求数当这 24 小时的请求数；
//   - 只有一家：开着的渠道全部绑了上游、而且是同一个上游；有开着的渠道没绑上游就不标（不知道它的货从哪来）；
//   - 主要上游：近 7 天这个模型流量占比最大的上游，没有（占比读不到、最大的是没绑上游的渠道）就没有；
//   - 快断货：主要上游的可用天数不到 3 天；
//   - 在猛涨：近 7 天是前 7 天的 2 倍以上，而且前 7 天至少花了 RISING_MIN_PREV_USD；
//   - 少收多少（估计）：卖不出去的按 近 7 天日均 ×（1 − 成功率），也就是平时一天卖的钱乘以失败的比例；断货的按最后一天有消费的那天往前 7 天的日均。
import { dayGrid } from "./user-ops-view.js";
import { priceOf } from "./expected-cost.js";

export const MODELS_VIEW = Object.freeze({
  DAYS: 30, // 抽屉里「每天卖多少」和「成功率」的天数；也是「列哪些模型」的范围
  WEEK: 7,
  SUCCESS_HOURS: 24, // 成功率看近 24 小时
  FAIL_BELOW_PCT: 95, // 成功率低于它标「卖不出去」
  MIN_REQUESTS: 50, // 近 24 小时请求不到这么多次不判
  SOON_DAYS: 3, // 主要上游可用天数不到它标「快断货」
  RISING_RATIO: 2, // 近 7 天是前 7 天的几倍以上标「在猛涨」
  RISING_MIN_PREV_USD: 2.9, // 前 7 天至少花了这么多才判（约 ¥20，美元存、页面按汇率换算，和用户运营的 DOWN_MIN_DAILY_USD 一个做法）
  MAX_TAGS: 3, // 一行最多标几个
  USERS_SHOWN: 4, // 「主要是谁在用」列前几个，其余合成「其他 N 个人」
  PRICE_SAME_PCT: 0.005, // 价格差在这以内算「和现在用的一样」
});

// 缺口标签的先后（也是一行最多标 3 个时留谁的次序）
export const GAP_ORDER = Object.freeze(["out", "soon", "fail", "single", "rising"]);
// 渠道状态：1 启用、2 手动停用、3 被自动停用（New API）
export const CHANNEL_STATE = Object.freeze({ 1: "on", 2: "off", 3: "auto" });

const sum = (list) => list.reduce((total, value) => total + value, 0);
const byNameThenKey = (a, b) => String(a).localeCompare(String(b), "zh-CN");

// 单个模型成功率的状态：none 没有开着的渠道、unread 读不到、few 请求太少（含近 24 小时一次请求都没有）、ok 有数
// successes：近 24 小时成功的请求数；rate：接口给的成功率（百分数），null 是这个模型近 24 小时没有记录
export function successOf({ openChannels, perfReadable, rate, successes, weekDailyRequests = 0 }) {
  if (!openChannels) return { state: "none", rate: null, requests: null };
  if (!perfReadable) return { state: "unread", rate: null, requests: null };
  if (rate == null) return { state: "few", rate: null, requests: 0 };
  // 成功率是 0（全部失败）时成功数也是 0，总请求数算不出来：用近 7 天日均成功的请求数当这 24 小时的请求数
  const requests = rate > 0 ? successes / (rate / 100) : weekDailyRequests;
  if (requests < MODELS_VIEW.MIN_REQUESTS) return { state: "few", rate, requests };
  return { state: "ok", rate, requests };
}

// 一个模型的缺口标签，按 GAP_ORDER 的先后
export function gapTagsOf({ out, soon, fail, single, rising }) {
  const flags = { out, soon, fail, single, rising };
  return GAP_ORDER.filter((tag) => flags[tag]);
}

export const isRising = (week, prev) => prev >= MODELS_VIEW.RISING_MIN_PREV_USD && week >= prev * MODELS_VIEW.RISING_RATIO;
export const isFailing = (success) => success.state === "ok" && success.rate < MODELS_VIEW.FAIL_BELOW_PCT;

// 少收多少（美元/天，估计）：断货的按最后一天有消费的那天往前 7 天的日均；卖不出去的按近 7 天日均 ×（1 − 成功率）；两样都占的只算断货
export function lostPerDayOf({ out, fail, week, success, dayCost }) {
  if (out) {
    let last = -1;
    for (let i = dayCost.length - 1; i >= 0; i -= 1) if (dayCost[i] > 0) { last = i; break; }
    if (last < 0) return 0;
    let total = 0;
    for (let i = Math.max(0, last - MODELS_VIEW.WEEK + 1); i <= last; i += 1) total += dayCost[i];
    return total / MODELS_VIEW.WEEK;
  }
  if (fail) return (week / MODELS_VIEW.WEEK) * (1 - success.rate / 100);
  return 0;
}

// 表的默认排法：有缺口的在前、没缺口的在后，两段里都按近 7 天日均消费从高到低（一样的按名字）
export function arrangeModels(rows) {
  const order = (a, b) => b.week - a.week || byNameThenKey(a.name, b.name);
  return [...rows.filter((row) => row.gap).sort(order), ...rows.filter((row) => !row.gap).sort(order)];
}

/**
 * 整页的数。
 * modelRows：[{ key（模型）, t（这一小时的起点，毫秒）, cost（美元）, requests（成功的请求数）}]（近 30 天，按小时）
 * flowRows：近 7 个整天按（用户、模型、渠道）合计的行 [{ user, model, channelId, cost }]，读不到传 null
 * channels：[{ id, name, status, models: string[], priority, weight }]
 * ruleOf：Map(渠道 id → { upstreamStationId })，渠道现在绑的上游
 * upstreams：Map(上游 id → { id, name, type, runway })，runway 见 server/models-page.js 的 runwayOf
 * perf：null（读不到）或 Map(模型 → 成功率百分数)
 * userIds：Map(用户名 → 用户 id)，用户运营页认得的用户
 */
export function buildModelsView({ now, tz, modelRows, flowRows, channels, ruleOf, upstreams, perf, userIds = new Map() }) {
  const grid = dayGrid(now, tz, MODELS_VIEW.DAYS);
  const N = grid.days, W = MODELS_VIEW.WEEK;
  const weekFrom = N - 1 - W, prevFrom = weekFrom - W; // 近 7 天 = [weekFrom, N-1)，前 7 天 = [prevFrom, weekFrom)，今天 = N-1
  const successFrom = now - MODELS_VIEW.SUCCESS_HOURS * 3600000;

  const demand = new Map(); // 模型 → { dayCost[], successes }
  for (const row of modelRows) {
    const i = grid.indexOf(row.t);
    if (i < 0 || !(row.cost > 0 || row.requests > 0)) continue;
    let item = demand.get(row.key);
    if (!item) demand.set(row.key, item = { dayCost: new Array(N).fill(0), dayRequests: new Array(N).fill(0), successes: 0 });
    item.dayCost[i] += row.cost;
    item.dayRequests[i] += row.requests || 0;
    if (row.t >= successFrom) item.successes += row.requests;
  }

  const supply = new Map(); // 模型 → 列了它的渠道
  for (const channel of channels) {
    const upstreamId = ruleOf.get(Number(channel.id))?.upstreamStationId ?? null;
    for (const model of channel.models || []) {
      let list = supply.get(model);
      if (!list) supply.set(model, list = []);
      list.push({ channelId: Number(channel.id), name: channel.name, state: CHANNEL_STATE[channel.status] || "off", priority: channel.priority ?? 0, weight: channel.weight ?? 0, upstreamId });
    }
  }

  const flow = new Map(); // 模型 → { total, byChannel: Map, byUser: Map }
  if (flowRows) {
    for (const row of flowRows) {
      if (!(row.cost > 0)) continue;
      let item = flow.get(row.model);
      if (!item) flow.set(row.model, item = { total: 0, byChannel: new Map(), byUser: new Map() });
      item.total += row.cost;
      item.byChannel.set(row.channelId, (item.byChannel.get(row.channelId) || 0) + row.cost);
      item.byUser.set(row.user, (item.byUser.get(row.user) || 0) + row.cost);
    }
  }

  const rows = [], details = new Map();
  for (const [name, item] of demand) {
    const total = sum(item.dayCost);
    if (!(total > 0)) continue;
    const week = sum(item.dayCost.slice(weekFrom, N - 1)), prev = sum(item.dayCost.slice(prevFrom, weekFrom));
    const older = sum(item.dayCost.slice(0, prevFrom));
    const channelsOf = (supply.get(name) || []).slice().sort((a, b) => Number(b.state === "on") - Number(a.state === "on") || b.priority - a.priority || a.channelId - b.channelId);
    const open = channelsOf.filter((channel) => channel.state === "on");
    const stopped = channelsOf.length - open.length;
    const openUpstreams = new Set(open.map((channel) => channel.upstreamId).filter((id) => id != null));
    const unbound = open.filter((channel) => channel.upstreamId == null).length;

    // 主要上游：近 7 天流量占比最大的（没绑上游的渠道合成一个「不知道」，它最大就没有主要上游）
    const fl = flow.get(name) || null;
    const shareByUpstream = new Map();
    if (fl && fl.total > 0) {
      for (const [channelId, cost] of fl.byChannel) {
        const id = ruleOf.get(Number(channelId))?.upstreamStationId ?? null;
        shareByUpstream.set(id, (shareByUpstream.get(id) || 0) + cost / fl.total);
      }
    }
    const top = [...shareByUpstream].sort((a, b) => b[1] - a[1] || byNameThenKey(a[0] ?? "", b[0] ?? ""))[0] || null;
    const mainId = top && top[0] != null ? top[0] : null;
    const main = mainId != null ? { upstreamId: mainId, name: upstreams.get(mainId)?.name ?? null, share: top[1], runway: upstreams.get(mainId)?.runway ?? null } : null;

    const success = successOf({ openChannels: open.length, perfReadable: perf != null, rate: perf?.get(name) ?? null, successes: item.successes, weekDailyRequests: sum(item.dayRequests.slice(weekFrom, N - 1)) / W });
    const out = open.length === 0;
    const flags = {
      out,
      soon: !!main && !!main.runway && Number.isFinite(main.runway.days) && main.runway.days < MODELS_VIEW.SOON_DAYS,
      fail: isFailing(success),
      single: open.length > 0 && unbound === 0 && openUpstreams.size === 1,
      rising: isRising(week, prev),
    };
    const tags = gapTagsOf(flags);
    rows.push({
      name, week, prev, isNew: week > 0 && prev + older === 0,
      success, supply: { upstreams: openUpstreams.size, open: open.length, stopped },
      main, tags: tags.slice(0, MODELS_VIEW.MAX_TAGS), gap: tags.length > 0, flags,
      lost: lostPerDayOf({ out, fail: flags.fail, week, success, dayCost: item.dayCost }),
    });

    // 抽屉要的（不在整页的响应里，点开时才给）
    // 流向整体读到了、只是这个模型近 7 天没有人用：给空的（页面写「近 7 天没有人用这个模型」）；整体读不到才是 null（写「读不到」）
    const users = !flowRows ? null : fl ? [...fl.byUser].map(([user, cost]) => ({ user, cost, userId: userIds.get(user) ?? null })).sort((a, b) => b.cost - a.cost || byNameThenKey(a.user, b.user)) : [];
    details.set(name, {
      dayCost: item.dayCost, successes24: item.successes,
      channels: channelsOf.map((channel) => ({
        channelId: channel.channelId, name: channel.name, state: channel.state, priority: channel.priority,
        share: fl && fl.total > 0 ? (fl.byChannel.get(channel.channelId) || 0) / fl.total : null,
        upstream: channel.upstreamId != null ? { id: channel.upstreamId, name: upstreams.get(channel.upstreamId)?.name ?? null, runway: upstreams.get(channel.upstreamId)?.runway ?? null } : null,
      })),
      users: users == null ? null : {
        top: users.slice(0, MODELS_VIEW.USERS_SHOWN),
        others: users.length > MODELS_VIEW.USERS_SHOWN ? { count: users.length - MODELS_VIEW.USERS_SHOWN, cost: sum(users.slice(MODELS_VIEW.USERS_SHOWN).map((item) => item.cost)) } : null,
        total: fl?.total ?? 0,
      },
      mainUpstreamId: mainId,
    });
  }

  const listed = arrangeModels(rows);
  const totalWeek = sum(rows.map((row) => row.week));
  const out = rows.filter((row) => row.flags.out || row.flags.fail);
  const single = rows.filter((row) => row.flags.single);
  const soon = rows.filter((row) => row.flags.soon).sort((a, b) => b.week - a.week || byNameThenKey(a.name, b.name));
  const rising = rows.filter((row) => row.flags.rising).sort((a, b) => b.week - a.week || byNameThenKey(a.name, b.name));
  const summary = {
    missing: { count: out.length, lostPerDay: sum(out.map((row) => row.lost)) },
    single: { count: single.length, share: totalWeek > 0 ? sum(single.map((row) => row.week)) / totalWeek : null },
    soon: { count: soon.length, first: soon[0] ? { name: soon[0].name, days: soon[0].main.runway.days } : null },
    rising: { count: rising.length, first: rising[0] ? { name: rising[0].name, ratio: rising[0].week / rising[0].prev } : null },
  };
  return { rows: listed, details, summary, flowReadable: flowRows != null, perfReadable: perf != null, grid: { keys: grid.keys, today: grid.today } };
}

// 抽屉里成功率那条线：近 30 天每天一个点。series 是 queryOwnPerfSeries 的 groups（按小时一个点，各分组分开；接口不能把桶设成一天，点里也没有请求数）；
// 同一个小时各分组等权平均，一天里有数据的小时等权平均——不按请求数加权：一整小时全失败时成功数是 0，加权就把这次故障抹掉了。
// 一天一个点都没有的是 null（线断开，不画 0）。返回 [{ day, rate }]（和 grid.keys 一一对应）和最低的那一天
export function dailySuccessLine({ now, tz, groups }) {
  const grid = dayGrid(now, tz, MODELS_VIEW.DAYS);
  const perHour = new Map(); // 小时起点 → 各分组的成功率
  for (const group of groups || []) for (const point of group.points) {
    const hour = Math.floor(point.t / 3600000) * 3600000;
    let list = perHour.get(hour);
    if (!list) perHour.set(hour, list = []);
    list.push(point.successRate);
  }
  const total = new Array(grid.days).fill(0), hours = new Array(grid.days).fill(0);
  for (const [hour, rates] of perHour) {
    const i = grid.indexOf(hour);
    if (i < 0) continue;
    total[i] += sum(rates) / rates.length;
    hours[i] += 1;
  }
  const points = grid.keys.map((day, i) => ({ day, rate: hours[i] > 0 ? total[i] / hours[i] : null }));
  let low = null;
  for (const point of points) if (point.rate != null && (low == null || point.rate < low.rate)) low = point;
  return { points, low };
}

// 找货帮手的一行价格：这个模型在那个上游的倍率 × 你在那边的分组倍率（按量计费），按次计费的是每次的价格 × 分组倍率。
// pricing：上游价目表（lib/expected-cost.js 的 pricingTableOf）；group：你在那边用的分组；返回 null 是价目表里没有这个模型
export function priceInUpstream(pricing, model, group) {
  const price = priceOf(pricing, model);
  if (!price || price.unsupported) return null;
  const ratio = pricing.groupRatio?.get?.(group);
  const groupRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return price.quotaType === 1
    ? { kind: "perCall", value: price.modelPrice * groupRatio }
    : { kind: "ratio", value: price.modelRatio * groupRatio };
}

// 和现在主要用的那个上游比：便宜 / 贵多少；两边计价方式不同（一个按次一个按量）或没有可比的写 null
export function comparePrice(price, mainPrice) {
  if (!price || !mainPrice || price.kind !== mainPrice.kind || !(mainPrice.value > 0)) return null;
  const pct = price.value / mainPrice.value - 1;
  if (Math.abs(pct) < MODELS_VIEW.PRICE_SAME_PCT) return { kind: "same", pct: 0 };
  return pct < 0 ? { kind: "cheaper", pct: -pct } : { kind: "pricier", pct };
}

// 找货帮手：价格从低到高，读不到价格的排最后（再按名字）；价格是「倍」或「每次」两种，分开排（先按量、后按次）
export function arrangeFinder(rows) {
  const rank = (row) => (row.price ? (row.price.kind === "ratio" ? 0 : 1) : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.price && b.price ? a.price.value - b.price.value : 0) || byNameThenKey(a.name, b.name));
}
