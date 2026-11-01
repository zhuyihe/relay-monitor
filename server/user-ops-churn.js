// 用户运营「流失」页签的接口：谁在少花钱、一天少收多少。算数在 lib/user-ops-churn.js；这里管读数据：
//   - 每位用户的消费、状态：用户页那一份（server/user-ops-page.js 的整页缓存，不再读一遍）；
//   - 今天到现在、过去 7 天同一时段的小时用量：读库里的按小时用量；过去 7 个整天的小时数按天记在内存里（结束 6 小时以后、回补读到了的才记），之后每次只读今天的；
//   - 每位用户近 30 天主要用的模型：读自营站点的 /api/data/flow 一个请求（和自营业务共用 server/own-raw-rows.js 的缓存读法），打开页签才读，缓存 10 分钟；
//     额度紧、断路、读失败都不拦页面，「主要用的模型」写「—」，接口里 modelsError 说原因。
import { businessTimeZone, dayStartInTz, shiftDayLabel } from "../lib/business-time.js";
import { QUOTA_PER_UNIT } from "../lib/providers.js";
import { ownRequestState } from "../lib/own-request-budget.js";
import { buildChurnView, queryChurn } from "../lib/user-ops-churn.js";
import { dayGrid, filledFromOf } from "../lib/user-ops-view.js";
import { readOwnRows } from "./own-raw-rows.js";
import { USER_OPS } from "./user-ops.js";
import { usersPage } from "./user-ops-page.js";

const HOUR_MS = 3600000;
const SAME_LAG_MS = 10 * 60000; // 最近这一小时的数据看板还没落齐：今天只算到「现在 − 10 分钟」之前的整点
const SAME_DAYS = 7;
const MODELS_TTL_MS = 10 * 60000;
const MODELS_DAYS = 30;
const toUsd = (quota) => quota / QUOTA_PER_UNIT;

// 今天到现在，对比过去 7 天同一时段：每位用户 { today, usual（过去 7 天同一时段的平均）, usualDay（过去 7 天整天的平均）}；
// 还算不了（过去 7 个整天没补全、刚过 0 点没满 1 小时、用户数据超过 30 分钟没读到）是 null；upTo 是「今天到几点」（上一个整点，毫秒），页面写「平时到 14:00 → 今天到 14:00」
export async function sameTimeUsage(rt, store, own, { now, tz, grid, filledFrom, fresh = true }) {
  // 用户数据超过 30 分钟没读到（页面上已经有「超过 30 分钟没读到」的提示）：今天的用量不全，拿它比「平时」会把所有人都标成少了，这一类先不判
  if (!fresh) return null;
  const N = grid.days, todayStart = grid.starts[N - 1];
  const whole = Math.floor((now - SAME_LAG_MS - todayStart) / HOUR_MS);
  if (whole < 1) return null;
  const upTo = todayStart + whole * HOUR_MS;
  const days = [];
  for (let i = N - 1 - SAME_DAYS; i <= N - 2; i += 1) {
    if (!(grid.starts[i] >= filledFrom)) return null; // 这天还没补到
    days.push(i);
  }
  // 过去几天每天每位用户的小时数：下标是这天的第几个小时。结束 6 小时以后的整天记在内存里；刚结束的昨天（最后几个小时的数还会改）每次重读
  const cacheKey = `${own.id}|${tz}`;
  const cache = rt._userOpsHourCache?.key === cacheKey ? rt._userOpsHourCache : (rt._userOpsHourCache = { key: cacheKey, days: new Map() });
  const dayOf = (rows, i) => {
    const byUser = new Map();
    for (const row of rows) {
      if (grid.indexOf(row.hourMs) !== i) continue;
      const hour = Math.min(24, Math.floor((row.hourMs - grid.starts[i]) / HOUR_MS));
      let list = byUser.get(row.username);
      if (!list) byUser.set(row.username, list = new Array(25).fill(0));
      list[hour] += toUsd(row.quota);
    }
    return byUser;
  };
  const settled = (i) => grid.starts[i + 1] <= now - 6 * HOUR_MS;
  const byDay = new Map();
  const missing = days.filter((i) => !(settled(i) && cache.days.has(grid.keys[i])));
  if (missing.length) {
    const rows = await store.listUsageHours(own.id, grid.starts[missing[0]], grid.starts[missing[missing.length - 1] + 1]);
    for (const i of missing) {
      const map = dayOf(rows, i);
      byDay.set(i, map);
      if (settled(i)) cache.days.set(grid.keys[i], map);
    }
  }
  for (const i of days) if (!byDay.has(i)) byDay.set(i, cache.days.get(grid.keys[i]));
  for (const key of cache.days.keys()) if (key < grid.keys[N - 1 - SAME_DAYS]) cache.days.delete(key);
  const todayRows = await store.listUsageHours(own.id, todayStart, upTo);
  const out = new Map();
  const entry = (name) => { let value = out.get(name); if (!value) out.set(name, value = { today: 0, usual: 0, usualDay: 0 }); return value; };
  for (const row of todayRows) entry(row.username).today += toUsd(row.quota);
  for (const i of days) {
    for (const [name, hours] of byDay.get(i)) {
      const value = entry(name);
      value.usual += hours.slice(0, whole).reduce((total, usd) => total + usd, 0) / SAME_DAYS;
      value.usualDay += hours.reduce((total, usd) => total + usd, 0) / SAME_DAYS;
    }
  }
  return { users: out, upTo };
}

// 每位用户近 30 天花得最多的模型；返回 { models: Map | null, error }
async function mainModels(rt, own, { now, tz }) {
  const base = String(own.baseUrl || "").replace(/\/+$/, "");
  const grid = dayGrid(now, tz);
  const startMs = dayStartInTz(shiftDayLabel(grid.today, -MODELS_DAYS), tz);
  // 命中缓存不用问额度；要发请求时额度紧或断路就不发
  const beforeRead = () => {
    const request = ownRequestState(base, now);
    if (request.broken || request.used + 1 > USER_OPS.BUDGET_MAX_USED) throw Object.assign(new Error("busy"), { code: "BUSY" });
  };
  try {
    // 读失败也挡 10 分钟：404、权限不够这种一直会失败的，不能每分钟都去用户的站上再跑一次 30 天的汇总
    const rows = await readOwnRows(rt, own, "flow", startMs, now, { ttlMs: MODELS_TTL_MS, failTtlMs: MODELS_TTL_MS, now, beforeRead });
    const byUser = new Map();
    for (const row of rows) {
      if (!row.user || !(row.cost > 0)) continue;
      let models = byUser.get(row.user);
      if (!models) byUser.set(row.user, models = new Map());
      models.set(row.model, (models.get(row.model) || 0) + row.cost);
    }
    const out = new Map();
    for (const [user, models] of byUser) {
      const top = [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (top) out.set(user, top[0]);
    }
    return { models: out, error: null };
  } catch (error) {
    return { models: null, error: error?.code || "ERROR" };
  }
}

// 地址栏的写法：only=todayLow|down|churned|returned、big=1、q=、page=
export async function churnResponse(rt, ops, store, params, { now = Date.now() } = {}) {
  const page = await usersPage(rt, ops, store, { now });
  if (page.unset || page.starting) return page;
  const own = rt.store.list().find((station) => station.isOwn && station.type === "newapi" && !station.archivedAt);
  const tz = businessTimeZone();
  const cache = rt._userOpsPageCache;
  const grid = dayGrid(now, tz);
  const filledFrom = filledFromOf(page.backfill, now);
  const [sameTime, models] = await Promise.all([
    sameTimeUsage(rt, store, own, { now, tz, grid, filledFrom, fresh: page.fresh !== false }),
    mainModels(rt, own, { now, tz }),
  ]);
  const view = buildChurnView({ now, tz, rows: page.users, daily: cache.daily, sameTime: sameTime?.users ?? null, models: models.models, ready: page.ready, backfill: page.backfill });
  const query = { only: params.get("only"), big: params.get("big") === "1", q: params.get("q"), page: params.get("page") };
  return {
    asOf: page.asOf, syncedMs: page.syncedMs, tz, rate: page.rate, ownStationId: page.ownStationId, fresh: page.fresh,
    backfill: page.backfill, ready: view.ready, sameUntilMs: sameTime?.upTo ?? null, summary: view.summary, modelsError: models.error,
    list: queryChurn(view, query),
  };
}
