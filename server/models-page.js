// 模型供需页的接口（整页和点开一个模型的抽屉）：只在有人打开页面时读，读完整页的结果缓存 10 分钟，不加后台采集、不加表。
// 整页读自营站点：渠道列表（带 models、优先级，和利润共用 10 分钟缓存）、/api/data/ 按模型（30 天，和自营业务、用户运营共用 server/own-raw-rows.js）、
// /api/data/flow（近 7 个整天的模型 × 渠道，同一个读法）、/api/perf-metrics/summary（成功率）。渠道绑在哪个上游用现在的绑定（channelProfit 那一份对应），
// 上游还能撑几天用上游监控现成的（余额预测 + balanceViewOf），不另读上游。流量占比、成功率读不到时那几列写「—」「读不到」，其余照常。
// 抽屉再多读：这个模型的成功率时间序列（自营站点 1 个请求，缓存 10 分钟）、各上游的价目表（上游自己的 /api/pricing，缓存 1 小时，不读自营站点）。
import { businessTimeZone } from "../lib/business-time.js";
import { rateSnapshotOf } from "../lib/profit.js";
import { queryOwnPerfSeries, queryOwnPerfSummary } from "../lib/providers.js";
import { balanceDaysText, balanceViewOf, etaWindowDays, stationDisplayName } from "../lib/overview-actions.js";
import { MODELS_VIEW, arrangeFinder, buildModelsView, comparePrice, dailySuccessLine, priceInUpstream } from "../lib/models-view.js";
import { dayGrid } from "../lib/user-ops-view.js";
import { createReconciliationModule } from "./reconciliation.js";
import { createChannelProfitModule } from "./channel-profit.js";
import { createUpstreamPricing } from "./upstream-pricing.js";
import { readOwnRows } from "./own-raw-rows.js";
import { ownChannelList } from "./own-helpers.js";

export const MODELS_TTL_MS = 10 * 60000;
const SERIES_KEEP = 24; // 最多留几个模型的成功率序列（抽屉点过的）

const ownOf = (rt) => rt.store?.list?.().find((station) => station.isOwn && station.type === "newapi" && !station.archivedAt) || null;

// 一个上游余额还能撑几天（上游监控现成的：余额预测 + balanceViewOf，和上游列表、日报同一套）。
// days：有限数字是可用天数，null 是算不出；noSpend：近期没有花费（可用天数无限）；固定成本的上游没有余额，不写（days: null）
export function runwayOf(rt, station) {
  if (station.type === "fixed") return { days: null, noSpend: false, level: "muted", text: "—", failed: false, fixed: true };
  const balance = station.balance;
  const prediction = balance?.ok ? rt.history?.predict?.(station.id) ?? null : null;
  const view = balanceViewOf({ ...station, prediction }, { settings: rt.store.settings, rules: rt.store.rules });
  return { days: Number.isFinite(view.days) ? view.days : null, noSpend: view.days === Infinity, level: view.level, text: balanceDaysText(view), failed: view.state === "unreadable", fixed: false };
}

// 上游运行时的样子（页面和抽屉都用）：Map(id → { id, name, type, runway })
function upstreamsOf(rt) {
  return new Map(rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && !station.archivedAt)
    .map((station) => [String(station.id), { id: String(station.id), name: stationDisplayName(station), type: station.type, runway: runwayOf(rt, station) }]));
}

// 用户运营页认得的用户（用户名 → id），「谁在用」点名字能打开那边的用户抽屉；那边没有数据时没有链接
function userIdsOf(rt) {
  const users = rt.userOps?.getUsers?.() || [];
  return new Map(users.filter((user) => user.role < 10).map((user) => [user.username, user.id]));
}

async function read(rt, own, now, tz, rate) {
  const grid = dayGrid(now, tz, MODELS_VIEW.DAYS);
  const N = grid.days;
  const flowFrom = grid.starts[N - 1 - MODELS_VIEW.WEEK], flowTo = grid.starts[N - 1];
  rt.reconciliation ||= createReconciliationModule(rt);
  const channelProfit = (rt.channelProfit ||= createChannelProfitModule(rt));
  const [rows, channels, flow, perf, rules] = await Promise.allSettled([
    readOwnRows(rt, own, "model", grid.starts[0], now, { ttlMs: MODELS_TTL_MS, failTtlMs: MODELS_TTL_MS, now }),
    ownChannelList(rt, own),
    readOwnRows(rt, own, "flow", flowFrom, flowTo, { ttlMs: MODELS_TTL_MS, failTtlMs: MODELS_TTL_MS, now }),
    queryOwnPerfSummary(own, MODELS_VIEW.SUCCESS_HOURS),
    channelProfit.channelRules(own.id),
  ]);
  // 没有每天卖多少、没有渠道，这一页就没有意思：整页读不到
  if (rows.status === "rejected") throw rows.reason;
  if (channels.status === "rejected") throw channels.reason;
  const upstreams = upstreamsOf(rt);
  const ruleOf = rules.status === "fulfilled" ? rules.value.ruleOf : new Map();
  const view = buildModelsView({
    now, tz, modelRows: rows.value, flowRows: flow.status === "fulfilled" ? flow.value : null, channels: channels.value, ruleOf, upstreams,
    perf: perf.status === "fulfilled" ? new Map(perf.value.models.map((item) => [item.model, item.successRate])) : null, userIds: userIdsOf(rt),
  });
  // 页面不用的判断中间量（flags、lost）不放进响应：一百个模型能少 1/4 的字节
  const payload = { asOf: now, tz, rate, critDays: etaWindowDays(rt.store.rules), rows: view.rows.map(({ flags, lost, ...row }) => row), summary: view.summary, flowReadable: view.flowReadable, perfReadable: view.perfReadable };
  return { payload, details: view.details, upstreams, rules: rules.status === "fulfilled" ? rules.value.rules : [], modelRows: rows.value, grid: view.grid, at: now };
}

// 整页（带抽屉要的）：10 分钟内不重读；同一时间来几个请求只读一次；读失败的不缓存
async function context(rt, { now = Date.now() } = {}) {
  const own = ownOf(rt);
  if (!own) return { unset: true };
  const tz = businessTimeZone();
  const rate = rateSnapshotOf(own).cnyPerUsd;
  const key = [own.id, own.baseUrl, own.userId || "", own.authVersion ?? "", tz, rate].join("|");
  const hit = rt._modelsPage;
  if (hit?.key === key && hit.value && now - hit.at < MODELS_TTL_MS) return { own, ...hit.value };
  if (hit?.key === key && hit.promise) return { own, ...(await hit.promise) };
  const promise = read(rt, own, now, tz, rate);
  rt._modelsPage = { key, promise, at: now };
  try {
    const value = await promise;
    if (rt._modelsPage?.promise === promise) rt._modelsPage = { key, value, at: now };
    return { own, ...value };
  } catch (error) {
    if (rt._modelsPage?.promise === promise) rt._modelsPage = null;
    throw error;
  }
}

export async function modelsPage(rt, options) {
  const ctx = await context(rt, options);
  return ctx.unset ? { unset: true } : ctx.payload;
}

// 一个模型的成功率时间序列（近 30 天，缓存 10 分钟）；读不到返回 null
async function seriesOf(rt, own, model, now) {
  const cache = (rt._modelsSeries ||= new Map());
  const hit = cache.get(model);
  if (hit && now - hit.at < MODELS_TTL_MS) return hit.value;
  if (hit?.promise) return hit.promise;
  const promise = queryOwnPerfSeries(own, model, MODELS_VIEW.DAYS * 24).then((value) => value, () => null).then((value) => {
    if (cache.get(model)?.promise === promise) {
      cache.set(model, { at: now, value });
      while (cache.size > SERIES_KEEP) cache.delete(cache.keys().next().value);
    }
    return value;
  });
  cache.set(model, { promise, at: now });
  return promise;
}

// 你在那个上游用的分组：优先是供这个模型的那条绑定的 Key 的分组，没有就是这个上游任一条绑定的 Key 的分组；一条绑定都没有的上游不知道，
// 价目表里有「default」分组就按它、没有按 1 倍（页面上的说明里写了「你在那边的分组」）
async function groupOf(rt, ctx, upstreamId, modelChannelIds) {
  const rules = ctx.rules.filter((rule) => String(rule.upstreamStationId) === upstreamId);
  if (!rules.length) return null;
  const preferred = rules.find((rule) => (rule.channels || []).some((channel) => modelChannelIds.has(Number(channel.channelId)))) || rules[0];
  const tokens = await rt.reconciliation?.upstreamTokens?.(upstreamId).catch(() => null);
  return tokens?.find((token) => Number(token.id) === Number(preferred.tokenId))?.group ?? null;
}

// 找货帮手：已经加了的上游里，谁也卖这个模型。价格读各上游自己公开的价目表（1 小时内不重读）：只有 New API 上游读得到，
// 别的上游（Sub2API 等）只在它已经有这个模型的渠道时列出来，价格写「读不到价格」；没加进来的上游不在这里
async function finderOf(rt, ctx, model, detail) {
  const pricing = (rt._upstreamPricing ||= createUpstreamPricing(rt));
  const supplying = new Set(detail.channels.filter((channel) => channel.state === "on" && channel.upstream).map((channel) => String(channel.upstream.id)));
  const known = new Set(detail.channels.filter((channel) => channel.upstream).map((channel) => String(channel.upstream.id)));
  const modelChannelIds = new Set(detail.channels.map((channel) => channel.channelId));
  const stations = rt.store.list({ includeUnmonitored: true }).filter((station) => !station.isOwn && !station.archivedAt && ctx.upstreams.has(String(station.id)));
  const rows = (await Promise.all(stations.map(async (station) => {
    const id = String(station.id), upstream = ctx.upstreams.get(id);
    let table = null;
    if (station.type === "newapi") table = await pricing.pricingFor(station).catch(() => null);
    const sells = table ? table.models.has(model) : false;
    // 价目表读到了但没有这个模型、也没有这个模型的渠道的上游：不列
    if (!sells && !known.has(id)) return null;
    let price = null;
    if (table && sells) {
      const group = await groupOf(rt, ctx, id, modelChannelIds);
      price = priceInUpstream(table, model, group ?? (table.groupRatio.has("default") ? "default" : null));
    }
    return { upstreamId: id, name: upstream.name, price, readable: price != null, supplying: supplying.has(id), runway: upstream.runway, bindable: station.type !== "fixed" };
  }))).filter(Boolean);
  const mainPrice = rows.find((row) => row.upstreamId === detail.mainUpstreamId)?.price ?? null;
  return arrangeFinder(rows.map((row) => ({ ...row, main: row.upstreamId === detail.mainUpstreamId, compare: row.upstreamId === detail.mainUpstreamId ? null : comparePrice(row.price, mainPrice) })));
}

// 抽屉：一个模型的详情。模型不在整页里（近 30 天没有消费）是 notFound
export async function modelDetail(rt, name, options = {}) {
  const now = options.now ?? Date.now();
  const ctx = await context(rt, options);
  if (ctx.unset) return { unset: true };
  const row = ctx.payload.rows.find((item) => item.name === name);
  const detail = ctx.details.get(name);
  if (!row || !detail) return { notFound: true };
  const [series, finder] = await Promise.all([seriesOf(rt, ctx.own, name, now), finderOf(rt, ctx, name, detail)]);
  const grid = dayGrid(now, ctx.payload.tz, MODELS_VIEW.DAYS);
  return {
    name, row, rate: ctx.payload.rate, tz: ctx.payload.tz, asOf: ctx.payload.asOf, critDays: ctx.payload.critDays,
    dayBars: grid.keys.map((day, i) => ({ day, cost: detail.dayCost[i] })),
    successLine: series ? dailySuccessLine({ now, tz: ctx.payload.tz, groups: series.groups }) : null,
    channels: detail.channels, users: detail.users, finder,
    flowReadable: ctx.payload.flowReadable,
  };
}

