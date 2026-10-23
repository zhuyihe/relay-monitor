// ---- 「我的站点」下游分析（分时段 / 分模型 / 分用户 + 消费预测）------------------
import { withAuth, json } from "../../../../lib/api.js";
import { errorCodeOf } from "../../../../lib/error-copy.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { queryOwnData } from "../../../../lib/providers.js";
import { dayKeyInTz, dayStartInTz, shiftDayLabel } from "../../../../lib/business-time.js";
import { forecastDaily, forecastHourly } from "../../../../lib/forecast.js";
import {
  ownCache, readOwnIncomeOrUnconfirmed, unconfirmedIncomeProfit, computeProfit, computeFlowBreakdown, joinPrev, resolveOwnWindow,
} from "../../../../server/own-helpers.js";

// 只在当前请求内比较，不写入缓存键、数据库或响应。
const ownFinancialVersion = (station) => station ? JSON.stringify([
  station.id, station.type, station.baseUrl, station.accessToken, station.userId, station.authVersion,
  station.cnyPerUsd, station.verifiedIdentity, station.resoldAdminKeys || [],
]) : null;

export const GET = withAuth(async (request, rt) => {
  const { store } = rt;
  const configuredOwn = store.list().find((s) => s.isOwn && s.type === "newapi");
  // 一次响应里的分日收入、利润和售价说明共用配置快照，不混入异步读取期间的编辑。
  const own = configuredOwn ? { ...configuredOwn, resoldAdminKeys: (configuredOwn.resoldAdminKeys || []).map((key) => ({ ...key })) } : null;
  if (!own) {
    return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  }
  const ownVersion = ownFinancialVersion(own);
  const sp = new URL(request.url).searchParams;
  // 展示窗口 + 上一等长窗口（环比用来抓「昨天 $11、今天 $152」这类跳变）
  const { range, tz, now, todayLabel, midnight, startMs, spanDays, prevStart, prevEnd } = resolveOwnWindow(sp);
  // 日期一律按业务时区的日历天推算，不假定一天 24 小时（夏令时切换日也对得上）
  const dayStartOf = (ms) => dayStartInTz(dayKeyInTz(ms, tz), tz);
  const wideStart = dayStartInTz(shiftDayLabel(todayLabel, -34), tz); // 预测需要更长的历史

  const cache = ownCache(rt);
  const cacheKey = `${range}|${tz}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 120000) return json(hit.payload);

  try {
    // 模型行一次拉 35 天（窗口展示 + 日消费预测共用）；用户行只拉展示窗口。
    // 上窗用户行单独拉一次；上窗模型行落在 35 天内时直接从 modelRows 切，不多发请求。
    const prevCovered = prevStart >= wideStart;
    const [modelRows, userRows, prevUserRows, prevModelFetched] = await Promise.all([
      queryOwnData(own, wideStart, now, "model"),
      queryOwnData(own, startMs, now, "user"),
      queryOwnData(own, prevStart, prevEnd, "user").catch(() => null),
      prevCovered ? null : queryOwnData(own, prevStart, prevEnd, "model").catch(() => null),
    ]);

    const winModel = modelRows.filter((r) => r.t >= startMs);
    const aggBy = (rows, field) => {
      const m = new Map();
      for (const r of rows) {
        const acc = m.get(r.key) || { [field]: r.key, tokens: 0, cost: 0, requests: 0 };
        acc.tokens += r.tokens; acc.cost += r.cost; acc.requests += r.requests;
        m.set(r.key, acc);
      }
      return [...m.values()].sort((a, b) => b.cost - a.cost);
    };

    // 时段趋势：今天按小时，7/30 天按 tz 自然日。
    // 小时桶按 UTC 整点切：New API 的 quota_data 本身就是 UTC 整点粒度，半点时区也无法再细分。
    const hourly = range === "today";
    const tmap = new Map();
    for (const r of winModel) {
      const key = hourly ? Math.floor(r.t / 3600000) * 3600000 : dayStartOf(r.t);
      const acc = tmap.get(key) || { t: key, tokens: 0, cost: 0, requests: 0 };
      acc.tokens += r.tokens; acc.cost += r.cost; acc.requests += r.requests;
      tmap.set(key, acc);
    }

    // 预测底料：35 天完整日消费（缺日补 0，不含今天的不完整数据）
    const dmap = new Map();
    for (const r of modelRows) {
      if (r.t >= midnight) continue;
      const dt = dayStartOf(r.t);
      dmap.set(dt, (dmap.get(dt) || 0) + r.cost);
    }
    const daily = [];
    if (dmap.size) {
      const firstDay = Math.min(...dmap.keys());
      for (let label = dayKeyInTz(firstDay, tz), t = firstDay; t < midnight; label = shiftDayLabel(label, 1), t = dayStartInTz(label, tz)) {
        daily.push({ t, cost: Math.round((dmap.get(t) || 0) * 10000) / 10000 });
      }
    }
    // 收入确认不了时不整页报错（§8.1）：收入、毛利、净利是 null，profit.incomeUnconfirmed 说原因，成本、消费、用户照常；
    // 用户列表也读不到时 usersUnavailable 说原因，没有预收、管理员标不出
    const { users: ownUsers, adminSet, incomeUsd, adminUsageUsd, resold, incomeDaily, unconfirmed, usersUnavailable } = await readOwnIncomeOrUnconfirmed(
      rt, own, userRows, { startMs, endMs: now, tz }
    );

    // 小时级序列（近 28 天，缺时补 0，不含当前未完小时）→ 未来 24 小时预测
    // modelRows 本就拉了 35 天：更长的序列让画像与 conformal 校准都有足够原点
    const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
    const hodOf = (ms) => Number(hourFmt.format(new Date(ms))) % 24;
    const hmap = new Map();
    for (const r of modelRows) {
      const hk = Math.floor(r.t / 3600000) * 3600000;
      hmap.set(hk, (hmap.get(hk) || 0) + r.cost);
    }
    const lastFullHour = Math.floor(now / 3600000) * 3600000 - 3600000;
    const hourlyStart = Math.max(lastFullHour - 28 * 86400000, hmap.size ? Math.min(...hmap.keys()) : lastFullHour);
    const hourlySeries = [];
    for (let t = hourlyStart; t <= lastFullHour; t += 3600000) {
      hourlySeries.push({ t, cost: Math.round((hmap.get(t) || 0) * 10000) / 10000 });
    }
    const hf = forecastHourly(hourlySeries, hodOf, 24);
    let hourlyForecast = null;
    if (hf) {
      const todaySoFar = modelRows.filter((r) => r.t >= midnight).reduce((a, r) => a + r.cost, 0);
      // 今天预计全天 = 已发生 + 预测里落在今天的剩余小时
      const dayEndMs = dayStartInTz(shiftDayLabel(todayLabel, 1), tz);
      const restToday = hf.points.filter((p) => p.t < dayEndMs).reduce((a, p) => a + p.cost, 0);
      hourlyForecast = {
        past: hourlySeries.slice(-24),
        next: hf.points,
        next24Total: hf.next24Total,
        backtestWapePct: hf.backtestWapePct,
        todaySoFar: Math.round(todaySoFar * 100) / 100,
        todayEst: Math.round((todaySoFar + restToday) * 100) / 100,
      };
    }

    const byUser = aggBy(userRows, "user").map((u) => ({ ...u, isAdmin: adminSet.has(u.user) }));
    // 上窗模型行：落在 35 天缓存里就地切，否则用单独拉的那份
    const prevModelRows = prevCovered
      ? modelRows.filter((r) => r.t >= prevStart && r.t < prevEnd)
      : (prevModelFetched || []);
    const [profit, flow] = await Promise.all([
      unconfirmed
        ? unconfirmedIncomeProfit(rt, own, unconfirmed, { startMs, now, tz, range })
        : computeProfit(rt, own, incomeUsd, adminUsageUsd, { startMs, now, tz, range, resold }),
      // 分组 / 渠道口径：模型行里看不出「哪个分组涨了」「换到了哪个上游渠道」
      computeFlowBreakdown(own, {
        startMs, endMs: now, prevStartMs: prevStart, prevEndMs: prevEnd,
        totalCostUsd: winModel.reduce((a, r) => a + r.cost, 0),
      }),
    ]);

    const payload = {
      range, tz, startMs, endMs: now,
      prevWindow: { startMs: prevStart, endMs: prevEnd, spanDays },
      station: { id: own.id, name: own.name, cnyPerUsd: own.cnyPerUsd ?? null },
      // token 口径提示：new-api 的 quota_data.token_used 只写 prompt+completion，
      // 缓存读写与倍率都不在里面（前端据此标注，精算见 /api/own/audit）
      tokenScope: "billed",
      byModel: joinPrev(aggBy(winModel, "model"), aggBy(prevModelRows, "model"), "model"),
      byUser: joinPrev(byUser, aggBy(prevUserRows || [], "user"), "user"),
      prevUserAvailable: prevUserRows != null,
      flow,
      ...(usersUnavailable ? { usersUnavailable } : {}),
      userBalances: ownUsers
        ? ownUsers
            .filter((u) => u.role < 10)
            .map((u) => ({ user: u.username, balanceUsd: Math.round(u.quotaUsd * 10000) / 10000, usedUsd: Math.round(u.usedUsd * 100) / 100, status: u.status }))
            .sort((a, b) => b.balanceUsd - a.balanceUsd)
        : null,
      trend: [...tmap.values()].sort((a, b) => a.t - b.t),
      daily: daily.slice(-14),
      forecast: forecastDaily(daily, 7),
      hourly: hourlyForecast,
      // 按实际用户身份和转售消费分日，客户端不再用含管理员自用的模型消费猜收入形状。
      incomeDaily,
      incomeDailyApprox: false,
      profit,
      generatedAt: new Date().toISOString(),
    };
    // 编辑配置会清缓存；较早开始的请求可以返回自己的快照，但不能把旧口径重新填回缓存。
    // 收入确认不了的那份不缓存：用户点「刷新」时要真的重新读
    if (!unconfirmed && ownFinancialVersion(store.list().find((s) => s.isOwn && s.type === "newapi")) === ownVersion) {
      cache.set(cacheKey, { at: Date.now(), payload });
    }
    return json(payload);
  } catch (err) {
    // 读自营站点没成：带上游给的码，没有就按「自营站点暂时读不到」说（lib/error-copy.js §8.2）
    return json({ error: err?.message || String(err), code: errorCodeOf(err, "OWN_STATION_UNAVAILABLE") }, 502);
  }
});
