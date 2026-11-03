// 上游每天花了多少：从上游自己那边读、存进库、推给 db/history.js 的 predict 用（算法在 lib/upstream-spend.js，只此一份）。
// 什么时候读：
//   - 新上游第一次读余额成功以后，一次性读过去 30 个整天（业务时区）；
//   - 上线时库里还没有的已有上游也补这一次：一个补完再补下一个，之间隔开（UPSTREAM_SPEND.BACKFILL_GAP_MS）；
//   - 之后每天业务时区过了零点（再等一小会儿，对方的数据看板是定时写的），读一次昨天，每个上游 1 个请求；中间错过的几天一起补；
//   - 对方不给读（接口关了、没权限）：记下「不给读」，隔一周最多再问一次，期间这个上游照余额快照的老办法算；
//   - 读失败（连不上、超时、对方繁忙）：隔一会儿再读，每次翻倍，最长 6 小时。
// 只读上游，不读用户的站；每个请求都走 lib/providers.js 的 request()，它会把请求记进 lib/own-request-budget.js 的额度和断路：
// 这个上游断路了、或最近 180 秒请求已经多得快到限流，这轮就不读。
import { businessTimeZone, dayKeyInTz, dayStartInTz, shiftDayLabel } from "../lib/business-time.js";
import { queryUpstreamDailySpend, SPEND_DENIED_CODES } from "../lib/providers.js";
import { INGEST_RESERVE, OWN_RATE_LIMIT, ownRequestState } from "../lib/own-request-budget.js";
import { UPSTREAM_SPEND, spendReadable } from "../lib/upstream-spend.js";
import { UpstreamSpendStore } from "./upstream-spend-store.js";

const defaultSleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

export function createUpstreamSpend(rt, {
  store = (rt._upstreamSpendStore ||= new UpstreamSpendStore(rt.pool)),
  read = queryUpstreamDailySpend, now = () => Date.now(), sleep = defaultSleep, log = () => {},
} = {}) {
  const states = new Map(); // 站点 id → 库里那一行（status、source、readThrough、checkedAt）
  const retry = new Map(); // 站点 id → { fails, until }：读失败后什么时候再试（只放内存，重启就重新试）
  let running = false;
  const inflight = new Set(); // 正在读的站点：定时看一遍和「重新读取」不会同时读同一个
  let timer = null, kickTimer = null;

  const keepFrom = (today) => shiftDayLabel(today, -UPSTREAM_SPEND.KEEP_DAYS);

  // 库里这些站点的天数推给 history.predict 用
  async function publish(stationIds) {
    const today = dayKeyInTz(now(), businessTimeZone());
    const rows = await store.listDays(stationIds, keepFrom(today), today);
    for (const id of stationIds) {
      const mine = rows.filter((row) => row.stationId === id).map(({ day, usd }) => ({ day, usd }));
      rt.history.setDailySpend(id, mine, { denied: states.get(id)?.status === "denied", failed: retry.has(id) });
    }
  }

  // 这个上游这轮要读哪几天：{ from, through }（业务时区日期，含两头）；不用读返回 null
  // force：页面上点「重新读取」：不等退避、不等「不给读」的一周，余额读没读成也读
  function plan(station, at, { force = false } = {}) {
    if (!spendReadable(station) || station.archivedAt || station.monitorEnabled === false) return null;
    if (!force && !station.balance?.ok) return null; // 第一次读余额成功以后才读
    if (!force && (retry.get(station.id)?.until ?? 0) > at) return null;
    const tz = businessTimeZone();
    const today = dayKeyInTz(at, tz);
    // 昨天最后一个小时对方的看板还没写全就先别读：过了零点一会儿才算昨天读得到
    const through = at >= dayStartInTz(today, tz) + UPSTREAM_SPEND.DAILY_READ_DELAY_MS ? shiftDayLabel(today, -1) : shiftDayLabel(today, -2);
    const state = states.get(station.id);
    let from;
    if (!state) from = shiftDayLabel(today, -UPSTREAM_SPEND.BACKFILL_DAYS);
    else if (state.status === "denied") {
      if (!force && at - state.checkedAt < UPSTREAM_SPEND.DENIED_RETRY_MS) return null;
      from = shiftDayLabel(today, -UPSTREAM_SPEND.BACKFILL_DAYS);
    } else from = shiftDayLabel(state.readThrough, 1);
    const earliest = shiftDayLabel(today, -UPSTREAM_SPEND.BACKFILL_DAYS);
    if (from < earliest) from = earliest;
    return from > through ? null : { from, through };
  }

  function failed(station, error, at) {
    const fails = (retry.get(station.id)?.fails ?? 0) + 1;
    retry.set(station.id, { fails, until: at + Math.min(UPSTREAM_SPEND.RETRY_BASE_MS * 2 ** (fails - 1), UPSTREAM_SPEND.RETRY_MAX_MS) });
    log("upstream-spend read failed", station.id, error?.code || "", fails);
  }

  // 读一个上游。返回 "read" / "denied" / "failed" / "skipped"
  async function readOne(station, { from, through }) {
    const at = now();
    const budget = ownRequestState(station.baseUrl, at);
    if (budget.broken || budget.used > OWN_RATE_LIMIT - INGEST_RESERVE) return "skipped";
    const tz = businessTimeZone();
    const before = states.get(station.id);
    try {
      const result = await read(station, {
        startMs: dayStartInTz(from, tz), endMs: dayStartInTz(shiftDayLabel(through, 1), tz), timezone: tz,
        sleep, gapMs: UPSTREAM_SPEND.STAT_GAP_MS, shouldPause: () => ownRequestState(station.baseUrl, now()).broken,
      });
      if (station.type.startsWith("sub2api")) await rt.store.save().catch(() => {}); // 密码模式读的时候可能换了令牌
      const checkedAt = now();
      await store.putDays(station.id, result.days);
      const state = { status: "ok", source: result.source, readThrough: through, deniedCode: null, checkedAt };
      await store.saveState(station.id, state);
      states.set(station.id, { stationId: station.id, ...state });
      retry.delete(station.id);
      await store.prune(keepFrom(dayKeyInTz(checkedAt, tz)));
      await publish([station.id]);
      return "read";
    } catch (error) {
      if (station.type.startsWith("sub2api")) await rt.store.save().catch(() => {});
      const checkedAt = now();
      // 第一次就不给读：记下来，不反复试。已经读成功过的上游偶尔读不了（多半是临时的）只退避重试，不改成「不给读」
      if (!before?.readThrough && SPEND_DENIED_CODES.includes(error?.code)) {
        const state = { status: "denied", source: null, readThrough: null, deniedCode: error.code, checkedAt };
        await store.saveState(station.id, state).catch(() => {});
        states.set(station.id, { stationId: station.id, ...state });
        retry.delete(station.id);
        await publish([station.id]).catch(() => {});
        return "denied";
      }
      failed(station, error, checkedAt);
      await publish([station.id]).catch(() => {}); // 页面上「读不到」（state: failed）
      return "failed";
    }
  }

  async function run(station, todo) {
    inflight.add(station.id);
    try { return await readOne(station, todo); } finally { inflight.delete(station.id); }
  }

  // 页面上点「重新读取」：马上读这一个上游，不等退避、不等一周；返回 { outcome }：read / denied / failed / skipped（上游断路或额度快到限流）/
  // busy（正在读）/ none（这种上游没有这个数、或已经读到昨天了没有要读的）
  async function refresh(stationId) {
    const station = rt.store.get(stationId);
    if (!station) return { outcome: "none" };
    if (inflight.has(stationId)) return { outcome: "busy" };
    retry.delete(stationId);
    const todo = plan(station, now(), { force: true });
    if (!todo) { await publish([stationId]).catch(() => {}); return { outcome: "none" }; }
    return { outcome: await run(station, todo) };
  }

  // 看一遍有没有要读的；没有就不发任何请求。一个上游读完再读下一个，之间隔开
  async function tick() {
    if (running) return [];
    running = true;
    const done = [];
    try {
      let first = true;
      for (const station of rt.store.list({ includeArchived: false })) {
        const todo = plan(station, now());
        if (!todo) continue;
        if (inflight.has(station.id)) continue;
        if (!first) await sleep(UPSTREAM_SPEND.BACKFILL_GAP_MS);
        first = false;
        done.push({ id: station.id, outcome: await run(rt.store.get(station.id) || station, todo), ...todo });
      }
    } finally {
      running = false;
    }
    return done;
  }

  async function load() {
    for (const [id, state] of await store.listStates()) states.set(id, state);
    const ids = rt.store.list({ includeArchived: true }).map((station) => station.id);
    await publish(ids);
  }

  function kick(delayMs = 2000) {
    if (kickTimer || running) return;
    kickTimer = setTimeout(() => { kickTimer = null; tick().catch(() => {}); }, delayMs);
    kickTimer.unref?.();
  }

  return {
    tick, load, kick, refresh,
    // 刷新余额成功时问一声：这个上游还没读过，就尽快读（第一次读余额成功以后读过去 30 天）
    noteBalanceOk(station) { if (spendReadable(station) && !states.has(station.id)) kick(); },
    stateOf: (stationId) => states.get(stationId) ?? null,
    forget(stationId) { states.delete(stationId); retry.delete(stationId); },
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, UPSTREAM_SPEND.TICK_MS);
      timer.unref?.();
      kick(60000); // 开机一分钟以后先看一遍：给已有的上游补 30 天，别和开机时的第一轮余额刷新挤在一起
    },
    stop() { if (timer) clearInterval(timer); if (kickTimer) clearTimeout(kickTimer); timer = kickTimer = null; },
  };
}

// 运行时挂载：连库里读过的状态和天数，启动后台
export async function startUpstreamSpend(rt) {
  const spend = createUpstreamSpend(rt);
  await spend.load();
  rt.upstreamSpend = spend;
  spend.start();
  return spend;
}

// 站点彻底删除、或上游换了地址（同一个 id 读另一个站，旧的天数不能留）时一起删
export async function forgetUpstreamSpend(rt, stationId) {
  if (!rt?.pool) return;
  await (rt._upstreamSpendStore ||= new UpstreamSpendStore(rt.pool)).deleteStation(stationId);
  rt.upstreamSpend?.forget(stationId);
  rt.history.setDailySpend(stationId, []);
}
