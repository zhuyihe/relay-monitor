// 用户运营页的接口（概览、用户两个页签和抽屉）：读后台采集存下来的东西（server/user-ops.js），不发请求给自营站点——
// 唯一的例外是抽屉里的「按模型分」：点开一个用户才读 /api/data/?username=，按用户名缓存 10 分钟，同一时间只读一个，额度紧就不读。
// 余额按站点刷新间隔更新，消费统计每 10 分钟更新，页面只取后台算好的结果。
// 按天的消费：整天（已经结束、而且回补读到了的）算一次就记在内存里，每次只重读最近两天的按小时用量。
import { businessTimeZone, dayKeyInTz, dayStartInTz, shiftDayLabel } from "../lib/business-time.js";
import { rateSnapshotOf } from "../lib/profit.js";
import { QUOTA_PER_UNIT, queryOwnData } from "../lib/providers.js";
import { ownRequestState } from "../lib/own-request-budget.js";
import { USER_BALANCE } from "../lib/user-balance.js";
import { USERS_VIEW, buildUserDetail, buildUsersView, dayGrid, filledFromOf, queryUsers, weekReadyOf } from "../lib/user-ops-view.js";
import { USER_OPS, ownStationOf } from "./user-ops.js";

const HOUR_MS = 3600000, DAY_MS = 86400000;
const MODELS_TTL_MS = 10 * 60000;
const MODELS_SHOWN = 4; // 最多列 4 个，剩下的合成「其他 N 个模型」
const toUsd = (quota) => quota / QUOTA_PER_UNIT;

// 只替换今天，昨天及更早的已计算结果继续复用。
function withToday(daily, recentHours, snapshot, tz) {
  const start = dayStartInTz(snapshot.day, tz);
  const hours = new Map([...recentHours].map(([name, values]) => [name, new Map([...values].filter(([hour]) => hour < start))]));
  for (const row of snapshot.rows) {
    if (!hours.has(row.username)) hours.set(row.username, new Map());
    hours.get(row.username).set(row.hourMs, toUsd(row.quota));
  }
  const days = new Map();
  for (const name of new Set([...daily.keys(), ...hours.keys()])) {
    const series = [...(daily.get(name) || new Array(USERS_VIEW.DAYS).fill(0))];
    series[series.length - 1] = [...(hours.get(name) || [])].reduce((total, [hour, usd]) => total + (hour >= start ? usd : 0), 0);
    days.set(name, series);
  }
  return { daily: days, recentHours: hours };
}

const emptyHint = (own, rate, now) => ({ starting: true, asOf: now, syncedMs: null, tz: businessTimeZone(), rate, ownStationId: own.id, backfill: { done: false, days: 0, total: USER_OPS.BACKFILL_DAYS }, users: [], trend: [], big: { ready: false, ids: [], count: 0 }, summary: null, ready: {} });

async function directoryOf(rt, store, stationId) {
  if (rt._userOpsDirectory?.stationId === stationId) return rt._userOpsDirectory;
  const saved = await store?.getDirectory(stationId);
  return rt._userOpsDirectory?.stationId === stationId ? rt._userOpsDirectory : saved;
}

// 首屏不读小时用量。重启后先用库里的名单，消费和趋势等后台算完再显示。
export async function localUsersPage(rt, ops, store, { now = Date.now() } = {}) {
  const own = ownStationOf(rt);
  if (!own) return { unset: true };
  const rate = rateSnapshotOf(own).cnyPerUsd;
  const paused = rt.store.settings?.userOpsEnabled === false;
  const last = rt._userOpsPageCache?.payload;
  if (last?.ownStationId === own.id && dayKeyInTz(now, last.tz) === last.today) {
    return { ...last, rate, paused, syncErrors: rt._userOpsSyncErrors || [], balanceSyncedMs: last.balanceSyncedMs ?? last.syncedMs, refreshIntervalMs: (rt.store.settings?.refreshIntervalSec || 60) * 1000, fresh: last.fresh && now - last.syncedMs <= USER_BALANCE.FRESH_MS };
  }
  const directory = await directoryOf(rt, store, own.id);
  if (!directory) return { ...emptyHint(own, rate, now), paused, refreshIntervalMs: (rt.store.settings?.refreshIntervalSec || 60) * 1000, directoryError: paused ? null : ops.getDirectoryError() };
  rt._userOpsDirectory = directory;
  const hint = emptyHint(own, rate, now);
  const today = rt._userOpsToday?.stationId === own.id && rt._userOpsToday.day === dayKeyInTz(now, hint.tz) ? rt._userOpsToday : null;
  const usage = today ? withToday(new Map(), new Map(), today, hint.tz) : { daily: new Map(), recentHours: new Map() };
  return {
    ...buildUsersView({ now, tz: hint.tz, users: directory.users, ...usage, runways: new Map(), backfill: hint.backfill, syncedMs: today?.at ?? null }),
    basicOnly: true, paused, rate, ownStationId: own.id, todaySyncedMs: today?.at ?? null, balanceSyncedMs: directory.at, syncErrors: rt._userOpsSyncErrors || [], refreshIntervalMs: (rt.store.settings?.refreshIntervalSec || 60) * 1000,
  };
}

// 接口给页面的：概览要的数照旧，全部用户的行换成筛、排、切片以后的一页（一页 50 个）和个数、合计。
// 地址栏的写法：scope=all、big=1、only=soon|down|new|churned、group=vip（可以多个，逗号分开）、q=搜索、sort=user|week|today|balance|days|last、dir=asc|desc、page=2
export function usersResponse(page, params) {
  const { users, ...rest } = page;
  const query = {
    scope: page.basicOnly ? "all" : params.get("scope"),
    big: !page.basicOnly && params.get("big") === "1",
    only: page.basicOnly ? null : params.get("only"), q: params.get("q"),
    groups: params.getAll("group").flatMap((value) => value.split(",")).map((value) => value.trim()),
    sort: params.get("sort"), dir: params.get("dir"), page: params.get("page"),
  };
  return { ...rest, list: queryUsers(users || [], query, page.ready || {}) };
}

// 整页的数（概览 + 用户表）。ops 是 createUserOps 的返回；没读到过数时 starting: true（页面写补全中）
export async function usersPage(rt, ops, store, { now = Date.now() } = {}) {
  const own = ownStationOf(rt);
  if (!own) return { unset: true };
  const rate = rateSnapshotOf(own).cnyPerUsd;
  const view = ops.getView(), users = ops.getUsers();
  if (!view || !users) return emptyHint(own, rate, now);
  const tz = businessTimeZone();
  const liveAt = ops.getLiveAt();
  const today = rt._userOpsToday?.stationId === own.id && rt._userOpsToday.day === dayKeyInTz(now, tz) && rt._userOpsToday.at >= liveAt ? rt._userOpsToday : null;
  const key = `${liveAt}|${view.balanceAt ?? liveAt}|${today?.at ?? 0}|${tz}|${own.id}|${rate}`;
  if (rt._userOpsPageCache?.key === key) return rt._userOpsPageCache.payload;

  const previous = rt._userOpsPageCache;
  let daily, recentHours;
  if (previous?.usageAt === liveAt && previous.payload.ownStationId === own.id && previous.payload.tz === tz && previous.payload.today === dayKeyInTz(now, tz)) {
    // 本轮只更新余额：消费和趋势复用整轮算好的数据，不重读小时表。
    ({ daily, recentHours } = previous);
  } else {
    const grid = dayGrid(now, tz);
    const N = grid.days;
    const filledFrom = filledFromOf(view.backfill, now);
    // 整天的消费：结束 6 小时以后、而且回补读到了的才记（最近 3 小时的数还会改，没补到的天以后会补上）
    const cache = rt._userOpsDayCache?.key === `${own.id}|${tz}` ? rt._userOpsDayCache : (rt._userOpsDayCache = { key: `${own.id}|${tz}`, days: new Map() });
    const cacheable = (i) => i < N - 1 && grid.starts[i + 1] <= now - 6 * HOUR_MS && grid.starts[i] >= filledFrom;
    let firstUncached = N;
    for (let i = N - 1; i >= 0; i -= 1) if (!(cacheable(i) && cache.days.has(grid.keys[i]))) firstUncached = i;
    const readFrom = Math.min(grid.starts[firstUncached] ?? grid.starts[N - 1], grid.starts[N - 2]);
    const rows = await store.listUsageHours(own.id, readFrom, now + HOUR_MS);
    const fresh = new Map(); // 这次读到的按天：dayKey → Map(用户名 → 美元)
    recentHours = new Map();
    for (const row of rows) {
      const i = grid.indexOf(row.hourMs);
      if (i < 0) continue;
      const usd = toUsd(row.quota);
      let byUser = fresh.get(i);
      if (!byUser) fresh.set(i, byUser = new Map());
      byUser.set(row.username, (byUser.get(row.username) || 0) + usd);
      if (row.hourMs >= grid.starts[N - 2]) {
        let hours = recentHours.get(row.username);
        if (!hours) recentHours.set(row.username, hours = new Map());
        hours.set(row.hourMs, usd);
      }
    }
    daily = new Map();
    for (let i = 0; i < N; i += 1) {
      const day = grid.keys[i];
      // 整天、读全了的天，没有一条用量也记一份空的（比如 30 天回补之前更早的天），不然每次都往前重读
      const byUser = cache.days.get(day) && cacheable(i) ? cache.days.get(day) : fresh.get(i) || (cacheable(i) ? new Map() : null);
      if (!byUser) continue;
      if (cacheable(i) && !cache.days.has(day) && i >= firstUncached) cache.days.set(day, byUser);
      for (const [username, usd] of byUser) {
        let series = daily.get(username);
        if (!series) daily.set(username, series = new Array(N).fill(0));
        series[i] = usd;
      }
    }
    // 太老的天不留
    for (const day of cache.days.keys()) if (day < grid.keys[0]) cache.days.delete(day);
  }

  if (today) ({ daily, recentHours } = withToday(daily, recentHours, today, tz));
  // 历史统计、今日消费、余额各自保留真实同步时间。
  const payload = { ...buildUsersView({ now, tz, users, daily, recentHours, runways: view.users, backfill: view.backfill, pointsFirstMs: view.pointsFirstMs, prepaidAgo: view.prepaidAgo, syncedMs: today?.at ?? liveAt, fresh: view.fresh }), rate, ownStationId: own.id, level1Days: view.level1Days, statsSyncedMs: liveAt, todaySyncedMs: today?.at ?? liveAt, balanceSyncedMs: view.balanceAt ?? liveAt };
  rt._userOpsPageCache = { key, payload, daily, recentHours, usageAt: liveAt };
  return payload;
}

// 抽屉里「按模型分」：近 7 天这个用户的模型占比。按用户名缓存 10 分钟；同一用户同时点几次只读一次；额度紧、断路不读
export async function userModels(rt, own, username, { now = Date.now() } = {}) {
  const cache = (rt._userOpsModels ||= new Map());
  const hit = cache.get(username);
  if (hit && now - hit.at < MODELS_TTL_MS) return hit.value;
  const inflight = (rt._userOpsModelsInflight ||= new Map());
  if (inflight.has(username)) return inflight.get(username);
  const request = ownRequestState(String(own.baseUrl || "").replace(/\/+$/, ""), now);
  if (request.broken || request.used + 1 > USER_OPS.BUDGET_MAX_USED) return { models: null, error: "BUSY" };
  const promise = (async () => {
    try {
      const rows = await queryOwnData(own, dayStartInTz(shiftDayLabel(dayKeyInTz(now, businessTimeZone()), -6), businessTimeZone()), now, "model", { username });
      const byModel = new Map();
      for (const row of rows) byModel.set(row.key, (byModel.get(row.key) || 0) + row.cost);
      const sorted = [...byModel].map(([model, cost]) => ({ model, cost })).filter((item) => item.cost > 0).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
      const total = sorted.reduce((sum, item) => sum + item.cost, 0);
      const top = sorted.slice(0, MODELS_SHOWN).map((item) => ({ ...item, share: total > 0 ? item.cost / total : 0 }));
      const rest = sorted.slice(MODELS_SHOWN);
      const restCost = rest.reduce((sum, item) => sum + item.cost, 0);
      const value = { models: top, others: rest.length ? { count: rest.length, cost: restCost, share: total > 0 ? restCost / total : 0 } : null, total, error: null };
      cache.set(username, { at: now, value });
      return value;
    } catch (error) {
      return { models: null, error: error?.code || "ERROR" };
    } finally { inflight.delete(username); }
  })();
  inflight.set(username, promise);
  return promise;
}

// 抽屉：一个用户的详情（近 30 天每天、今天每小时、余额变化和充值、按模型分）；用户在整页的数里（状态、四个数）一并给
export async function userDetail(rt, ops, store, id, { now = Date.now() } = {}) {
  const own = ownStationOf(rt);
  if (!own) return { unset: true };
  const page = await localUsersPage(rt, ops, store, { now });
  const row = page.users?.find((item) => item.id === Number(id));
  const list = (await directoryOf(rt, store, own.id))?.users || [];
  const user = list.find((item) => Number(item.id) === Number(id));
  if (!user || user.role >= 10) return { notFound: true };
  if (page.basicOnly) return { id: Number(id), username: user.username, user: row, rate: page.rate, ready: page.ready, backfill: page.backfill };
  const tz = businessTimeZone();
  const grid = dayGrid(now, tz);
  const hours = await store.listUserUsageHours(own.id, user.username, grid.starts[0], now + HOUR_MS);
  const series = new Array(grid.days).fill(0), hourMap = new Map();
  for (const item of hours) {
    const i = grid.indexOf(item.hourMs);
    if (i >= 0) series[i] += toUsd(item.quota);
    hourMap.set(item.hourMs, toUsd(item.quota));
  }
  const points = await store.listUserBalancePoints(own.id, user.id, now - 14 * DAY_MS);
  const detail = buildUserDetail({ now, tz, user, series, hours: hourMap, points });
  const models = page.paused ? { models: null, error: "USER_DATA_DISABLED" } : await userModels(rt, own, user.username, { now });
  return { ...detail, user: row || null, rate: page.rate, ready: page.ready, backfill: page.backfill, models };
}

// 告警中心「用户」一组里「现在是 N 个：……」那一句要的数：重点用户名单，按每天花得多的排；近 7 天还没补到时 ready 是 false、名单空。
// 只读后台算好的（不读库、不读自营站点）
export function bigUsersSummary(rt, ops, { now = Date.now() } = {}) {
  const own = ownStationOf(rt);
  if (!own) return { unset: true };
  const view = ops.getView();
  if (!view) return { ready: false, big: [] };
  const ready = weekReadyOf(dayGrid(now, businessTimeZone()), view.backfill, now);
  const big = ready ? [...view.users.values()].filter((user) => user.big).sort((a, b) => (b.dailyAvg || 0) - (a.dailyAvg || 0) || a.id - b.id).map((user) => ({ id: user.id, username: user.username })) : [];
  return { ready, big };
}

export { HOUR_MS, USERS_VIEW };
