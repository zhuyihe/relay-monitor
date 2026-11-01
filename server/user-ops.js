// 用户运营（第一步：数据和后台）。「用户」是自营站点（用户自己的 New API）上的用户。
// 每 10 分钟（挂在对账轮询的每一轮后面，自己限频）：
//   1. 读用户列表（server/own-helpers.js 的 getOwnUsers，10 分钟缓存），给每个非管理员用户记一条余额快照（变了才写，没变每天补一条）；
//   2. 读 /api/data/users 最近 3 小时，按小时覆盖写进 user_usage_hours；
//   3. 第一次往回补 30 天：每轮最多 3 个请求，一天一个，从最近的天往前；补完才算「回补完成」；
//   4. 算每个用户还能用几天（lib/user-balance.js）和重点用户（日均消费占全站八成），结果放在 rt._userOpsView 里（以后页面读）；
//   5. 站长提醒：规则「重点用户余额用完」「重点用户快用完」（rules.onUserExhaust / onUserEta，告警中心「用户」一组）开着、数据新鲜、回补完成时，只推送重点用户，几位一起推一条。
// 页面开着的时候（页面来取数就续 90 秒「有人在看」，做法同每日利润页）加一档「实时」：每分钟读一次用户列表和最近 3 小时的用量（回补没完也接着补），
// 这一档不写余额快照、不重算还能用几天和重点用户、不推送（这些仍是每 10 分钟一次），页面上的余额、今天的消费、最近使用是每分钟的。没人看就只有 10 分钟那一档。
// 对用户自己 New API 的读取：每轮 1 个用户列表（每页 100 个）+ 1 个 data/users，回补期间再加最多 3 个；每个请求之前先问 lib/own-request-budget.js：
// 断路、或者最近 180 秒已经发了太多就整轮不读。总开关：settings.userOpsEnabled（默认开），关了一个请求都不发。
import { QUOTA_PER_UNIT, queryOwnData } from "../lib/providers.js";
import { channelsForEvent } from "../lib/alerts.js";
import { broadcast } from "../lib/notify.js";
import { businessTimeZone, dayKeyInTz, dayStartInTz, shiftDayLabel } from "../lib/business-time.js";
import { formatZonedDateTime } from "../lib/format.js";
import { OWN_RATE_LIMIT, ownRequestState } from "../lib/own-request-budget.js";
import { USER_BALANCE, bigUsersOf, dailyAverages, decideUserAlert, userBalanceMessage, userRunway } from "../lib/user-balance.js";
import { getOwnUsers } from "./own-helpers.js";
import { UserOpsStore } from "./user-ops-store.js";

const HOUR_MS = 3600000, DAY_MS = 86400000;

export const USER_OPS = Object.freeze({
  INTERVAL_MS: 10 * 60000,
  USERS_MAX_AGE_MS: 9 * 60000, // 用户列表缓存超过这么久就重读，保证每轮的快照是新的
  SNAPSHOT_REFRESH_MS: DAY_MS, // 余额没变的用户每天补一条
  USAGE_LOOKBACK_HOURS: 3,
  BACKFILL_DAYS: 30,
  BACKFILL_PER_RUN: 3,
  USAGE_KEEP_MS: 35 * DAY_MS, // 30 天曲线 + 在下滑要比前 14 天
  BALANCE_KEEP_MS: 14 * DAY_MS, // 7 天窗口 + 余量
  EVAL_LOOKBACK_MS: 8 * DAY_MS,
  // 最近 180 秒这个站点已经发了这么多请求（共 360 个额度）就整轮不读：比整站日志读取的份额更保守，别的读取（运营总览、对账）优先
  BUDGET_MAX_USED: Math.floor(OWN_RATE_LIMIT * 0.6),
  PRUNE_EVERY_MS: 6 * HOUR_MS,
  LIVE_INTERVAL_MS: 55000, // 有人在看：每分钟一次（留 5 秒的抖动余地）
  VIEW_HOLD_MS: 90000, // 页面来取一次数，「有人在看」续这么久（两次页面刷新的时间）
  LIVE_USERS_MAX_AGE_MS: 50000, // 实时一档读用户列表，缓存超过这么久就重读
});

const ownStationOf = (rt) => rt.store?.list?.().find((station) => station.isOwn && station.type === "newapi" && !station.archivedAt) || null;
const toUsd = (quota) => quota / QUOTA_PER_UNIT;

// 站点彻底删除、或者自营站点换了地址（同一个 id 读另一个站）：快照、用量、进度、提醒状态全清，从头来。
// 先把「代数」加一：正在跑的那一轮每次 await 回来都比一下代数，变了就不再写（不然迟到的写会把进度行写回来，回补目标是空的，一路往 1970 年读；
// 删除站点以后用户名和用量又被写回去，永远留在库里）；下一轮开头发现代数变了，把内存里的快照缓存和用户列表也清掉
export async function forgetUserOps(rt, stationId) {
  if (!rt?.pool) return;
  rt._userOpsGen = (rt._userOpsGen || 0) + 1;
  rt._userOpsView = null;
  rt._userOpsPageCache = null; rt._userOpsDayCache = null; rt._userOpsModels = null;
  await (rt._userOpsStore ||= new UserOpsStore(rt.pool)).deleteStation(stationId);
}

// 接口用：同一个运行时共用的后台和存储（轮询里建的就是它）
export function userOpsOf(rt) {
  return { ops: (rt.userOps ||= createUserOps(rt)), store: rt.pool ? (rt._userOpsStore ||= new UserOpsStore(rt.pool)) : null };
}

const STALE = "USER_OPS_STALE";
// 包一层存储：每次调用前后都比一下代数，变了抛 STALE（读到的是删除以前的数，写了会写回脏数据，都不要）
function guardedStore(ops, alive) {
  return new Proxy(ops, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== "function") return fn;
      return async (...args) => {
        alive();
        const out = await fn.apply(target, args);
        alive();
        return out;
      };
    },
  });
}

export function createUserOps(rt, { store = null, now = () => Date.now(), send = broadcast } = {}) {
  const opsStore = () => store || (rt.pool ? (rt._userOpsStore ||= new UserOpsStore(rt.pool)) : null);
  const lastPoints = new Map(); // 站点 id → Map(用户 id → { t, balanceUsd })，第一次从库里读，之后在内存里跟着写
  const state = { lastRunAt: 0, lastLiveAt: 0, liveAt: 0, viewedAt: null, lastPruneAt: 0, inflight: null, lastUsers: null, gen: 0 };
  let alive = () => {}; // 这一轮的「站点没被删、没换地址」检查，run 开头换成这一轮自己的（同一时间只跑一轮）

  const budgetOk = (own, needed = 1) => {
    const at = now();
    const request = ownRequestState(String(own.baseUrl || "").replace(/\/+$/, ""), at);
    return !request.broken && request.used + needed <= USER_OPS.BUDGET_MAX_USED;
  };

  // live：实时一档，只刷新内存里的用户列表（页面上的余额），不写快照
  async function snapshotBalances(ops, own, at, { live = false } = {}) {
    const list = await getOwnUsers(rt, own, { since: at - (live ? USER_OPS.LIVE_USERS_MAX_AGE_MS : USER_OPS.USERS_MAX_AGE_MS) });
    alive();
    state.lastUsers = list;
    if (live) { await ops.saveProgress(own.id, { balanceSyncedMs: at }, at); return 0; }
    let known = lastPoints.get(own.id);
    if (!known) lastPoints.set(own.id, known = await ops.lastBalancePoints(own.id));
    const rows = [];
    for (const user of list) {
      if (user.role >= 10) continue; // 管理员不记
      const id = Number(user.id), last = known.get(id);
      if (last && Math.abs(last.balanceUsd - user.quotaUsd) <= 1e-9 && at - last.t < USER_OPS.SNAPSHOT_REFRESH_MS) continue;
      rows.push({ userId: id, t: at, balanceUsd: user.quotaUsd });
    }
    if (rows.length) await ops.addBalancePoints(own.id, rows);
    for (const row of rows) known.set(row.userId, { t: row.t, balanceUsd: row.balanceUsd });
    await ops.saveProgress(own.id, { balanceSyncedMs: at }, at);
    return rows.length;
  }

  const usageRows = (rows) => rows.map((row) => ({ username: row.key, hourMs: row.t, quota: row.quotaUnits, requests: row.requests }));

  async function syncUsage(ops, own, at) {
    const start = Math.floor(at / HOUR_MS) * HOUR_MS - (USER_OPS.USAGE_LOOKBACK_HOURS - 1) * HOUR_MS;
    const rows = await queryOwnData(own, start, at, "user", { includeQuotaUnits: true });
    await ops.upsertUsageHours(own.id, usageRows(rows));
    await ops.saveProgress(own.id, { usageSyncedMs: at }, at);
    return rows.length;
  }

  const backfillView = (backfillState) => ({ done: backfillState.done, days: Math.min(USER_OPS.BACKFILL_DAYS, Math.ceil((backfillState.startedMs - backfillState.cursor) / DAY_MS)), total: USER_OPS.BACKFILL_DAYS, cursorMs: backfillState.cursor });

  // 回补：从「现在」往前一天一个请求，补到 30 天前的 0 点；每轮最多 BACKFILL_PER_RUN 个，每个之前问额度
  async function backfill(ops, own, at) {
    const tz = businessTimeZone();
    let progress = await ops.getProgress(own.id);
    // 进度行没有、或者只有半截（别的字段先写进去、回补目标是空的）：重新初始化，不然目标是空就一路往 1970 年读
    if (progress?.backfillCursorMs == null || progress.backfillTargetMs == null) {
      progress = await ops.saveProgress(own.id, { backfillCursorMs: at, backfillStartedMs: at, backfillTargetMs: dayStartInTz(shiftDayLabel(dayKeyInTz(at, tz), -(USER_OPS.BACKFILL_DAYS - 1)), tz) }, at);
    }
    let cursor = progress.backfillCursorMs, steps = 0;
    while (cursor > progress.backfillTargetMs && steps < USER_OPS.BACKFILL_PER_RUN && budgetOk(own)) {
      const from = Math.max(progress.backfillTargetMs, dayStartInTz(dayKeyInTz(cursor - 1, tz), tz));
      let rows;
      try { rows = await queryOwnData(own, from, cursor, "user", { includeQuotaUnits: true }); } catch { break; }
      await ops.upsertUsageHours(own.id, usageRows(rows));
      cursor = from;
      steps += 1;
      await ops.saveProgress(own.id, { backfillCursorMs: cursor }, at);
    }
    return { steps, done: cursor <= progress.backfillTargetMs, cursor, target: progress.backfillTargetMs, startedMs: progress.backfillStartedMs };
  }

  async function evaluate(ops, own, at, { backfillState, fresh }) {
    const tz = businessTimeZone();
    const since = at - USER_OPS.EVAL_LOOKBACK_MS;
    const [pointsByUser, hourRows, progress] = await Promise.all([ops.listBalancePoints(own.id, since), ops.listUsageHours(own.id, since), ops.getProgress(own.id)]);
    // 重点用户按「近 7 天」算：最近 7 个整天，不含今天（和页面上的近 7 天同一个口径）
    const todayKey = dayKeyInTz(at, tz);
    const weekStart = dayStartInTz(shiftDayLabel(todayKey, -7), tz), weekEnd = dayStartInTz(todayKey, tz);
    const rules = rt.store?.rules || {};
    const level1Days = Number(rules.etaDays) > 0 ? Number(rules.etaDays) : USER_BALANCE.LEVEL1_DAYS;
    const hoursByName = new Map();
    const weekRows = [];
    for (const row of hourRows) {
      let hours = hoursByName.get(row.username);
      if (!hours) hoursByName.set(row.username, hours = new Map());
      const usd = toUsd(row.quota);
      hours.set(row.hourMs, usd);
      if (row.hourMs >= weekStart && row.hourMs < weekEnd) weekRows.push({ username: row.username, hourMs: row.hourMs, usd });
    }
    const averages = dailyAverages(weekRows, tz);
    const eligible = (state.lastUsers || []).filter((user) => user.role < 10 && user.status === 1);
    const bigIds = bigUsersOf(eligible.map((user) => ({ id: Number(user.id), dailyAvg: averages.get(user.username) || 0 })));
    const bigSet = new Set(bigIds);
    const users = new Map();
    for (const user of eligible) {
      const id = Number(user.id), points = pointsByUser.get(id);
      const runway = points?.length ? userRunway({ points, hours: hoursByName.get(user.username), now: at, syncedMs: progress?.usageSyncedMs ?? at, level1Days }) : { state: "warming", level: 0, days: null, burnPerDay: null, balanceUsd: user.quotaUsd, hasConsumption: false };
      users.set(id, { id, username: user.username, big: bigSet.has(id), dailyAvg: averages.get(user.username) || 0, ...runway });
    }
    const pushAllowed = fresh && backfillState.done;
    // 页面要的两个数顺手在这里算（这一轮已经读了 8 天的快照）：快照最早一条的时刻（余额记满 24 小时才判可用天数）、7 天前的预收（客户余额合计）。页面不再自己读快照
    let pointsFirstMs = null, prepaidAgo = null;
    const weekAgo = at - 7 * DAY_MS;
    for (const list of pointsByUser.values()) if (list.length && (pointsFirstMs == null || list[0][0] < pointsFirstMs)) pointsFirstMs = list[0][0];
    if (pointsFirstMs != null && pointsFirstMs <= weekAgo) {
      prepaidAgo = 0;
      for (const list of pointsByUser.values()) { let last = null; for (const [t, usd] of list) if (t <= weekAgo) last = usd; prepaidAgo += last ?? 0; }
    }
    rt._userOpsView = { at, stationId: own.id, users, bigIds, level1Days, pointsFirstMs, prepaidAgo, backfill: backfillView(backfillState), fresh, pushAllowed };
    return rt._userOpsView;
  }

  // 站长提醒：只推送重点用户；状态先写再推，一条都没送到就退回原状态，下一轮再试
  async function alerts(ops, own, at, view) {
    const rules = rt.store?.rules || {};
    // 规则「重点用户余额用完」「重点用户快用完」（告警中心「用户」一组）：两个都关就不推
    if (!(rules.onUserExhaust === true || rules.onUserEta === true) || !view.pushAllowed) return { pushed: 0 };
    const prevStates = await ops.getAlertStates(own.id);
    const due = [], changed = [];
    for (const id of view.bigIds) {
      const user = view.users.get(id);
      if (!user || user.state === "warming") continue;
      const prev = prevStates.get(id) || null;
      // 只算开着的那几种：余额用完只看「余额用完」规则，快用完（可用天数到线）只看「快用完」规则；都没开的这位当没事
      const level = user.state === "empty" ? (rules.onUserExhaust === true ? 2 : 0) : user.state === "soon" && rules.onUserEta === true ? user.level : 0;
      const decision = decideUserAlert({ prev, runway: { ...user, level }, now: at, repushHours: Number(rules.renotifyHours) || 0, level1Days: view.level1Days });
      if (decision.push) due.push({ user, decision, prev });
      else if (!prev || prev.level !== decision.state.level || prev.lastBalanceUsd !== decision.state.lastBalanceUsd) changed.push({ id, state: decision.state });
    }
    for (const item of changed) await ops.saveAlertState(own.id, item.id, item.state, at);
    if (!due.length) return { pushed: 0 };
    for (const item of due) await ops.saveAlertState(own.id, item.user.id, item.decision.state, at);
    alive();
    // 余额用完、快用完各有各的「发到」：分两组，各推一条（一组里几位一起推）；哪一组一条都没送到，就把这一组的状态退回去，下一轮再试
    const time = formatZonedDateTime(at, businessTimeZone());
    let pushed = 0, failed = 0;
    for (const [eventKey, group] of [["userExhaust", due.filter(({ user }) => user.state === "empty")], ["userEta", due.filter(({ user }) => user.state !== "empty")]]) {
      if (!group.length) continue;
      const channels = channelsForEvent(rt.store?.channels, rules, eventKey);
      const { title, body } = userBalanceMessage(group.map(({ user }) => user), time);
      let sent = [];
      try { sent = await send(channels, title, body); } catch { sent = []; }
      if (sent.some((result) => result.ok)) { pushed += group.length; continue; }
      for (const item of group) await ops.saveAlertState(own.id, item.user.id, item.prev || { level: 0, notifiedAt: null, lastBalanceUsd: item.prev?.lastBalanceUsd ?? null }, at);
      failed += group.length;
    }
    return failed ? { pushed, failed } : { pushed };
  }

  async function pruneIfDue(ops, own, at) {
    if (at - state.lastPruneAt < USER_OPS.PRUNE_EVERY_MS) return;
    state.lastPruneAt = at;
    for (let i = 0; i < 20; i += 1) {
      const deleted = await ops.prune(own.id, { usageBeforeMs: at - USER_OPS.USAGE_KEEP_MS, balanceBeforeMs: at - USER_OPS.BALANCE_KEEP_MS });
      if (deleted.usage + deleted.balance < 5000) break;
    }
  }

  async function run({ force = false } = {}) {
    if (rt.store?.settings?.userOpsEnabled === false) return { skipped: "off" };
    const own = ownStationOf(rt), rawOps = opsStore();
    if (!own || !rawOps) return { skipped: "no-own" };
    const at = now();
    // 到点的是 10 分钟那一整轮，还是有人在看时每分钟的实时一档（整轮到点就做整轮，整轮里也读了这些）
    const viewing = state.viewedAt != null && at - state.viewedAt < USER_OPS.VIEW_HOLD_MS;
    const fullDue = force || at - state.lastRunAt >= USER_OPS.INTERVAL_MS;
    if (!fullDue && !(viewing && at - state.lastLiveAt >= USER_OPS.LIVE_INTERVAL_MS)) return { skipped: "interval" };
    const live = !fullDue;
    if (fullDue) state.lastRunAt = at;
    state.lastLiveAt = at;
    if (!budgetOk(own, 2)) return { skipped: "budget" };
    // 站点被删、换了地址（forgetUserOps 把代数加一）：内存里的快照缓存、用户列表是旧站的，清掉；这一轮从头记住自己的代数
    const gen = rt._userOpsGen || 0;
    if (state.gen !== gen) { lastPoints.clear(); state.lastUsers = null; state.gen = gen; }
    alive = () => { if ((rt._userOpsGen || 0) !== gen) throw Object.assign(new Error("stale"), { code: STALE }); };
    const ops = guardedStore(rawOps, alive);
    // STALE 不记成错误，一路抛到最外面结束这一轮
    const note = (out, tag, error) => { if (error?.code === STALE) throw error; out.errors.push(`${tag}:${error?.code || "ERROR"}`); };
    const out = { snapshots: 0, usageRows: 0, errors: [] };
    try {
      try { out.snapshots = await snapshotBalances(ops, own, at, { live }); state.liveAt = at; } catch (error) { note(out, "users", error); }
      alive();
      if (budgetOk(own)) { try { out.usageRows = await syncUsage(ops, own, at); } catch (error) { note(out, "usage", error); } }
      alive();
      let backfillState = { done: false, steps: 0, cursor: at, target: at, startedMs: at };
      try { backfillState = await backfill(ops, own, at); } catch (error) { note(out, "backfill", error); }
      if (live) {
        // 实时一档到这里为止：回补有进展时把页面上的补全进度跟着更新，别的（还能用几天、重点用户、提醒）等下一个整轮
        if (backfillState.steps && rt._userOpsView) rt._userOpsView = { ...rt._userOpsView, backfill: backfillView(backfillState) };
        out.live = true;
        out.backfill = backfillState;
        return out;
      }
      try {
        const progress = await ops.getProgress(own.id);
        const fresh = progress?.balanceSyncedMs != null && progress?.usageSyncedMs != null && at - progress.balanceSyncedMs <= USER_BALANCE.FRESH_MS && at - progress.usageSyncedMs <= USER_BALANCE.FRESH_MS;
        const view = await evaluate(ops, own, at, { backfillState, fresh });
        alive();
        out.alerts = await alerts(ops, own, at, view);
        await pruneIfDue(ops, own, at);
      } catch (error) { note(out, "evaluate", error); }
      out.backfill = backfillState;
      return out;
    } catch (error) {
      if (error?.code === STALE) return { skipped: "changed" };
      throw error;
    }
  }

  return {
    // 同一时间只跑一轮；调用方不用等（轮询里不阻塞）
    runOnce(options) { return state.inflight ||= run(options).finally(() => { state.inflight = null; }); },
    getView: () => rt._userOpsView || null,
    // 页面来取数：续「有人在看」90 秒（页面每分钟来一次，就一直是每分钟一次的实时一档）
    markViewing() { state.viewedAt = now(); },
    // 页面上数字最后更新的时刻：整轮或实时一档读完用户列表的那一刻
    getLiveAt: () => Math.max(rt._userOpsView?.at || 0, state.liveAt || 0),
    // 最近一次读到的用户列表（用户运营页用）；还没读到过是 null
    getUsers: () => state.lastUsers,
    _state: state,
  };
}
