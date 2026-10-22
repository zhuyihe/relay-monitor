// 「我的站点」分析共用辅助：用户/渠道缓存、转售 Key 消费重归、利润计算。
// 供 /api/own/analytics、/api/own/admin-keys 与每日日报共用。
// 约定：不在顶层 import lib/runtime.js；跨请求状态（缓存）一律挂在 rt 字段上。
import {
  queryStationUsage, queryOwnUsers, queryOwnChannels, queryLogStat, queryOwnFlow,
} from "../lib/providers.js";
import { businessTimeZone, dayKeyInTz, dayRangeInTz, resolveBusinessWindow } from "../lib/business-time.js";
import { amortizeFixedCost, costBasisOf, purchasesOf, rateSnapshotOf, summarizeProfit, toCny } from "../lib/profit.js";
import { COST_MODE_TEXT, RATE_UNSET_PARITY, SELL_PRICE_UNSET } from "../lib/format.js";
import { errorCodeOf } from "../lib/error-copy.js";

// 上游在自营站点的渠道里找不到对应地址时，成本明细「渠道」一栏的写法（成本来源另有一栏）
const NO_MATCHED_CHANNEL = "没有对上的渠道";

// 分析结果缓存（admin-keys PUT 改利润口径时要清掉，挂 rt 上跨路由共享）
export function ownCache(rt) {
  return (rt._ownCache ||= new Map());
}

// 用户列表拉取开销不小，缓存 10 分钟
export async function getOwnUsers(rt, own) {
  const c = rt._ownUsersCache;
  if (!c?.list || c.stationId !== own.id || Date.now() - c.at > 600000) {
    rt._ownUsersCache = { at: Date.now(), stationId: own.id, list: await queryOwnUsers(own) };
  }
  return rt._ownUsersCache.list;
}

export function normalizeCostUrl(url) {
  return String(url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function costMatchScore(stUrl, chUrl) {
  if (!stUrl || !chUrl) return 0;
  if (stUrl === chUrl) return 3;
  if (stUrl === chUrl + "/api" || chUrl === stUrl + "/api") return 2;
  const hostOf = (u) => u.split("/")[0].split(":")[0];
  const isBareHost = (u) => !!u && !u.includes("/") && !u.includes(":");
  return isBareHost(stUrl) && hostOf(chUrl) === stUrl ? 1 : 0;
}

// 返回与渠道地址最匹配的监控站；显式别名与站点主地址采用相同打分规则。
export function matchCostStation(upstreams, channelUrl) {
  const chUrl = normalizeCostUrl(channelUrl);
  let station = null, best = 0;
  for (const s of upstreams) {
    const urls = [s.baseUrl, ...(Array.isArray(s.costAliases) ? s.costAliases : [])];
    for (const url of urls) {
      const score = costMatchScore(normalizeCostUrl(url), chUrl);
      if (score > best) { best = score; station = s; }
    }
  }
  return station;
}

export function mapCostChannels(upstreams, channels) {
  const matched = new Map();
  const unmatched = new Map();
  for (const ch of channels) {
    const cu = normalizeCostUrl(ch.baseUrl);
    const station = matchCostStation(upstreams, cu);
    if (station) {
      const entry = matched.get(station.id) || { station, channels: [] };
      entry.channels.push(ch.name);
      matched.set(station.id, entry);
    } else {
      // 没填地址的是直连模型厂商的官方渠道，不分类型合成一行
      const label = cu || "官方渠道";
      const entry = unmatched.get(label) || { label, names: [], enabled: 0, total: 0 };
      entry.names.push(ch.name);
      entry.total++;
      if (ch.status === 1) entry.enabled++;
      unmatched.set(label, entry);
    }
  }
  return { matched, unmatched };
}

// 成本纳入与 New API 渠道匹配解耦：列表中的监控上游默认全部计入。
export function selectCostUpstreams(stations, ownId) {
  const candidates = stations.filter((s) => s.id !== ownId && s.monitorEnabled !== false);
  return {
    included: candidates.filter((s) => s.includeInProfit !== false),
    excluded: candidates.filter((s) => s.includeInProfit === false),
  };
}

// 部分 New API 部署会对 /api/data/self 返回成功空数组。余额明确下降时不能按零成本处理。
export function reconcileUsageCost(apiUsd, historyUsd) {
  const api = Number.isFinite(Number(apiUsd)) ? Math.max(0, Number(apiUsd)) : 0;
  const history = Number.isFinite(Number(historyUsd)) ? Math.max(0, Number(historyUsd)) : 0;
  if (api <= 0 && history > 0) {
    return { usd: history, mode: "history", note: `用量是 0，改${COST_MODE_TEXT.history}` };
  }
  return { usd: api, mode: "usage", note: null };
}

// 一个按用量计费的上游在 [startMs, endMs) 的实际扣费（美元）。用量接口返回 0 或失败时退回余额下降推算。
// 我的站点的利润和账单核算的「未纳入核算的上游消费」共用，两处的账号级成本才对得上。
export async function stationUsageCost(rt, station, { startMs, endMs, tz, today = false }) {
  const historyUsd = () => rt.history?.usedBetween(station.id, startMs, endMs) ?? 0;
  try {
    const u = await queryStationUsage(station, { startMs, endMs, granularity: "day", tz, wantToday: today });
    const apiUsd = today && u.summary ? u.summary.cost : u.models.reduce((a, m) => a + m.cost, 0);
    return reconcileUsageCost(apiUsd, historyUsd());
  } catch (err) {
    return { usd: historyUsd(), mode: "history", note: `读不到用量，改${COST_MODE_TEXT.history}`, error: err?.message || String(err), errorCode: errorCodeOf(err) };
  }
}

/**
 * 转售的管理员/root Key 消费重归：从「管理员消耗（成本）」移入「下游收入」。
 * 对每个 (username, tokenName) 用日志统计接口取窗内消费额度（美元）后汇总。
 * 单个 Key 查询失败记为 0 并附带错误，不影响其余；返回调整后的两个口径 + 明细。
 */
export async function computeResold(own, incomeUsd, adminUsageUsd, startMs, endMs) {
  const keys = Array.isArray(own.resoldAdminKeys) ? own.resoldAdminKeys : [];
  if (!keys.length) return { incomeUsd, adminUsageUsd, resoldUsd: 0, breakdown: [] };
  const breakdown = [];
  let resoldUsd = 0;
  // 同一天的 Key 顺序读取；readOwnIncome 最多同时读四天，因此整个窗口最多四个 stat 请求。
  for (const k of keys) {
    try {
      const usd = await queryLogStat(own, { username: k.username, tokenName: k.tokenName, startMs, endMs });
      resoldUsd += usd;
      breakdown.push({ username: k.username, tokenName: k.tokenName, usd });
    } catch (err) {
      breakdown.push({ username: k.username, tokenName: k.tokenName, usd: 0, error: err?.message || String(err), errorCode: errorCodeOf(err) });
    }
  }
  return {
    incomeUsd: incomeUsd + resoldUsd,
    // 转售消费本在管理员桶里，移走它；跨接口口径微差时钳到 0，避免负数
    adminUsageUsd: Math.max(0, adminUsageUsd - resoldUsd),
    resoldUsd,
    breakdown: breakdown.sort((a, b) => b.usd - a.usd),
  };
}

function incomeUnconfirmed(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "OWN_INCOME_UNCONFIRMED" });
}

/**
 * 按真实用户消费确认收入；角色目录不完整时不能把未知用户当付费客户。
 * 用户行保留时间维度，管理员自用留在发生的那一天；转售 Key 也按当天的精确窗口读取。
 * 分日金额按实际金额累计舍入到分，逐日之和与 computeProfit 的收入一致。
 * 任一必要的角色/转售读取没成即报不可确认，页面和日报不能继续发布看似完整的利润。
 */
export async function readOwnIncome(rt, own, userRows, { startMs, endMs, tz }) {
  let users;
  try { users = await getOwnUsers(rt, own); }
  catch (cause) { throw incomeUnconfirmed("用户身份没读全，收入和利润暂时算不出", cause); }
  const roles = new Map(users.map((u) => [u.username, u.role]));
  const adminSet = new Set(users.filter((u) => u.role >= 10).map((u) => u.username));
  const days = endMs > startMs
    ? dayRangeInTz(dayKeyInTz(startMs, tz), dayKeyInTz(endMs - 1, tz), tz).map((d) => ({
        ...d, startMs: Math.max(startMs, d.startMs), endMs: Math.min(endMs, d.endMs), incomeUsd: 0, adminUsageUsd: 0,
      }))
    : [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const row of userRows) {
    if (row.t < startMs || row.t >= endMs) continue;
    if (!roles.has(row.key) && row.cost !== 0) throw incomeUnconfirmed(`用户「${row.key}」的身份没读到，收入和利润暂时算不出`);
    const day = byDate.get(dayKeyInTz(row.t, tz));
    if (!day) throw incomeUnconfirmed("用户消费的日期没对上，收入和利润暂时算不出");
    if (adminSet.has(row.key)) day.adminUsageUsd += row.cost;
    else day.incomeUsd += row.cost;
  }
  for (const key of own.resoldAdminKeys || []) {
    if (!adminSet.has(key.username)) throw incomeUnconfirmed(`转售 Key 所属用户「${key.username}」的管理员身份没确认`);
  }
  // 同时最多读四天，避免 30 天窗口把上游日志接口瞬间打满。
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, days.length) }, async () => {
    while (cursor < days.length) {
      const day = days[cursor++];
      day.resold = await computeResold(own, day.incomeUsd, day.adminUsageUsd, day.startMs, day.endMs);
      const failed = day.resold.breakdown.find((k) => k.error);
      if (failed) throw incomeUnconfirmed("转售记录没读全，收入和利润暂时算不出", new Error(failed.error));
      day.incomeUsd = day.resold.incomeUsd;
      day.adminUsageUsd = day.resold.adminUsageUsd;
    }
  }));
  const incomeUsd = days.reduce((a, d) => a + d.incomeUsd, 0);
  const adminUsageUsd = days.reduce((a, d) => a + d.adminUsageUsd, 0);
  const rate = rateSnapshotOf(own).cnyPerUsd;
  // 对实际金额累计舍入，也保留可能的负向调整；不能用只接受正权重的比例分摊丢掉退款。
  let cumulativeUsd = 0, previousCents = 0;
  const incomeDaily = days.map((day) => {
    cumulativeUsd += day.incomeUsd;
    const cents = Math.round(cumulativeUsd * rate * 100);
    const incomeCny = (cents - previousCents) / 100;
    previousCents = cents;
    return { date: day.date, incomeCny };
  });
  const keys = new Map();
  for (const day of days) for (const key of day.resold.breakdown) {
    const id = JSON.stringify([key.username, key.tokenName]);
    const acc = keys.get(id) || { username: key.username, tokenName: key.tokenName, usd: 0 };
    acc.usd += key.usd; keys.set(id, acc);
  }
  return {
    users, adminSet, incomeUsd, adminUsageUsd,
    incomeDaily,
    resold: {
      incomeUsd, adminUsageUsd,
      resoldUsd: days.reduce((a, d) => a + d.resold.resoldUsd, 0),
      breakdown: [...keys.values()].sort((a, b) => b.usd - a.usd),
    },
  };
}

/**
 * 利润口径（lib/profit.js）：毛利 = 收入 − 上游成本；净利 = 毛利 − 固定成本。
 * 收入 = 下游消费 × 自有站售价汇率。成本纳入不依赖 New API 渠道列表：
 * 配置了固定付费的上游只按摊销计（固定成本）；其余按上游实际扣费 × 充值汇率（上游成本），
 * 用量接口返回 0 或不可用时退回余额下降推算。渠道 URL 匹配仅用于展示流量归属。
 * 窗口为 [startMs, now]：余额推算同样截止到 now，日报算昨天时不会混入今天的消耗。
 */
export async function computeProfit(rt, own, incomeUsd, adminUsageUsd, { startMs, now, tz, range, resold }) {
  const { store } = rt;
  const r2 = (v) => Math.round(v * 100) / 100;
  try {
    // 渠道列表拉取开销不小，缓存 10 分钟
    const cc = rt._ownChannelsCache;
    if (!cc?.list || cc.stationId !== own.id || Date.now() - cc.at > 600000) {
      rt._ownChannelsCache = { at: Date.now(), stationId: own.id, list: await queryOwnChannels(own) };
    }
    const channels = rt._ownChannelsCache.list;
    const { included: upstreams, excluded: excludedUpstreams } = selectCostUpstreams(store.list(), own.id);
    const { matched, unmatched } = mapCostChannels(upstreams, channels);

    const windowDays = (now - startMs) / 86400000;

    // 固定成本：无论是否匹配到渠道都计入（服务器租金这类可以完全不填地址）。
    // 每笔付费按生效区间与展示窗口的重叠毫秒数摊销，多笔叠加求和；没填日期的按全窗口摊销。
    const costs = [];
    for (const s of upstreams) {
      const purchases = purchasesOf(s);
      if (!purchases.length) continue;
      const fixed = amortizeFixedCost(purchases, { startMs, endMs: now, tz });
      // 笔数随项返回，页面按笔数判断是否到期，不认 note 的文字
      costs.push({
        stationId: s.id, name: s.name, mode: "fixed", note: fixed.note,
        active: fixed.active, expired: fixed.expired, upcoming: fixed.upcoming, total: fixed.total,
        channels: matched.get(s.id)?.channels || [NO_MATCHED_CHANNEL],
        cny: fixed.cny,
      });
    }
    // 上游成本：所有纳入成本、且按用量计费的监控上游。
    // 是否出现在 New API 渠道列表只影响归属说明，不影响成本纳入。
    const usageCosts = await Promise.all(
      upstreams
        .filter((station) => costBasisOf(station) === "usage")
        .map(async (station) => {
          const chNames = matched.get(station.id)?.channels || [NO_MATCHED_CHANNEL];
          const item = { stationId: station.id, name: station.name, channels: chNames };
          const selected = await stationUsageCost(rt, station, { startMs, endMs: now, tz, today: range === "today" });
          return { ...item, ...selected, cny: toCny(selected.usd, rateSnapshotOf(station)) };
        })
    );
    costs.push(...usageCosts);

    const ownRate = rateSnapshotOf(own).cnyPerUsd;
    const incomeCny = r2(incomeUsd * ownRate);
    const upstreamCostCny = r2(costs.filter((c) => c.mode !== "fixed").reduce((a, c) => a + c.cny, 0));
    const fixedCostCny = r2(costs.filter((c) => c.mode === "fixed").reduce((a, c) => a + c.cny, 0));
    const summary = summarizeProfit({ incomeCny, upstreamCostCny, fixedCostCny });
    const unmatchedList = [...unmatched.values()].sort((a, b) => b.enabled - a.enabled || b.total - a.total);
    const unmatchedEnabled = unmatchedList.reduce((a, x) => a + x.enabled, 0);
    const estimatedCosts = costs.filter((c) => c.mode === "history").length;
    // 自营站点没设置售价影响收入，按用量算的上游没设置汇率影响上游成本，两件事分开说
    const ownPriceUnset = rateSnapshotOf(own).source === "default";
    const rateUnsetStations = upstreams
      .filter((s) => rateSnapshotOf(s).source === "default" && costs.some((c) => c.mode !== "fixed" && c.stationId === s.id))
      .map((s) => ({ id: s.id, name: s.name }));
    // warnings 是给人看的句子，warningCodes 和它一一对应，页面按码分类，不认文字
    const warnings = [], warningCodes = [];
    const warn = (code, text) => { warningCodes.push(code); warnings.push(text); };
    if (unmatchedEnabled) warn("unmatched_channels", `${unmatchedEnabled} 个在用的渠道没对上上游；已添加的上游照常算成本`);
    if (estimatedCosts) warn("estimated_cost", `${estimatedCosts} 个上游${COST_MODE_TEXT.history}`);
    if (ownPriceUnset) warn("sell_price_unset", `${own.name} ${SELL_PRICE_UNSET}`);
    if (rateUnsetStations.length) warn("rate_unset", `${rateUnsetStations.map((s) => s.name).join("、")} ${RATE_UNSET_PARITY}`);
    if (excludedUpstreams.length) warn("excluded_upstreams", `${excludedUpstreams.map((s) => s.name).join("、")} 不算进利润`);
    return {
      incomeCny,
      upstreamCostCny,
      fixedCostCny,
      ...summary,
      // 旧字段：总成本 = 上游成本 + 固定成本；profitCny / marginPct 即净利 / 净利率
      totalCostCny: r2(upstreamCostCny + fixedCostCny),
      profitCny: summary.netProfitCny,
      marginPct: summary.netMarginPct,
      adminUsageCny: r2((adminUsageUsd || 0) * ownRate),
      // 转售管理员 Key 计入收入的部分（× 售价汇率），供前端拆分展示
      resoldCny: resold ? r2((resold.resoldUsd || 0) * ownRate) : 0,
      resoldKeys: resold ? resold.breakdown.map((b) => ({ ...b, cny: r2(b.usd * ownRate) })) : [],
      costs: costs.sort((a, b) => b.cny - a.cny),
      unmatched: unmatchedList,
      complete: !ownPriceUnset && rateUnsetStations.length === 0,
      estimated: estimatedCosts > 0,
      excludedStationIds: excludedUpstreams.map((s) => s.id),
      rateUnsetStations,
      warnings,
      warningCodes,
      windowDays: Math.round(windowDays * 10) / 10,
    };
  } catch (err) {
    // error 是原文，只给「查看详细原因」；归类看 errorCode（lib/error-copy.js）
    return { error: err?.message || String(err), errorCode: errorCodeOf(err) };
  }
}

// ---- 展示窗口解析（analytics 与 audit 共用）--------------------------------
/**
 * 解析 range 查询参数 → 按业务时区自然日切出的展示窗口与上一等长窗口。
 * 统一用业务时区（lib/business-time.js），不再跟随浏览器传来的 tz：
 * 同一时刻不同时区的浏览器看到的「今天」必须是同一个窗口，才能和日报、成本页对得上。
 */
export function resolveOwnWindow(sp, now = Date.now()) {
  return resolveBusinessWindow(sp.get("range"), now, businessTimeZone());
}

// ---- 分组 / 渠道口径（/api/data/flow）与环比 --------------------------------
// 看板只有模型维度，消费突变（分组倍率、换上游渠道）在模型行里看不出来；
// 流向数据补上这两个维度，并与上一等长窗口对比出跳变。

export function aggregateFlow(rows, keyOf, field) {
  const m = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const acc = m.get(key) || { [field]: key, tokens: 0, cost: 0, requests: 0 };
    acc.tokens += r.tokens; acc.cost += r.cost; acc.requests += r.requests;
    m.set(key, acc);
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * 与上一等长窗口对齐：给每行补 prevCost / prevTokens / deltaPct。
 * 上窗为 0 的行算不出百分比（记 null），用 isNew 标注「本窗新出现」。
 */
export function joinPrev(cur, prev, field) {
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const pm = new Map(prev.map((r) => [r[field], r]));
  return cur.map((r) => {
    const p = pm.get(r[field]);
    const prevCost = p ? r4(p.cost) : 0;
    return {
      ...r,
      cost: r4(r.cost),
      prevCost,
      prevTokens: p ? p.tokens : 0,
      deltaPct: prevCost > 0 ? Math.round(((r.cost - prevCost) / prevCost) * 1000) / 10 : null,
      isNew: !p && r.cost > 0,
    };
  });
}

/**
 * 拉两个窗口的流向数据，产出分组 / 渠道 / (用户×分组) 三张带环比的表。
 * totalCostUsd 传窗内模型口径合计，用来算覆盖率：new-api 的 flow 查询带
 * use_group <> '' 过滤，没有分组字段的历史行不在内，合计会偏小。
 */
export async function computeFlowBreakdown(own, { startMs, endMs, prevStartMs, prevEndMs, totalCostUsd }) {
  try {
    const [cur, prev] = await Promise.all([
      queryOwnFlow(own, startMs, endMs),
      queryOwnFlow(own, prevStartMs, prevEndMs).catch(() => []),
    ]);
    const chKey = (r) => r.channelName || (r.channelId ? `渠道 ${r.channelId}` : "");
    const ugKey = (r) => (r.user && r.group ? `${r.user} · ${r.group}` : "");
    const coveredUsd = cur.reduce((a, r) => a + r.cost, 0);
    return {
      byGroup: joinPrev(aggregateFlow(cur, (r) => r.group, "group"), aggregateFlow(prev, (r) => r.group, "group"), "group"),
      byChannel: joinPrev(aggregateFlow(cur, chKey, "channel"), aggregateFlow(prev, chKey, "channel"), "channel"),
      byUserGroup: joinPrev(aggregateFlow(cur, ugKey, "key"), aggregateFlow(prev, ugKey, "key"), "key").slice(0, 15),
      coveredUsd: Math.round(coveredUsd * 10000) / 10000,
      coveragePct: totalCostUsd > 0 ? Math.round((coveredUsd / totalCostUsd) * 1000) / 10 : null,
      prevWindow: { startMs: prevStartMs, endMs: prevEndMs },
    };
  } catch (err) {
    // error 是原文，只给「查看详细原因」；归类看 errorCode（lib/error-copy.js）
    return { error: err?.message || String(err), errorCode: errorCodeOf(err) };
  }
}
