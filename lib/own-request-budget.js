// 对自营站点（你站线上的 New API）的请求额度和断路（应付成本 V1-a，总指挥 10-26：对你站零压力）。
// New API 默认全站限流：同一个来源 180 秒最多 360 个请求。控制台所有读你站的地方（运营总览、R1 管理员日志、渠道收费、整站日志）
// 都走 lib/providers.js 的 request()，request() 把每个请求按站点地址记进这里，整站日志读取（server/own-log-ingest.js）每轮读之前先问：
//   - 额度：最近 180 秒这个站点已经发了多少；整站读只用没人用的那一部分，剩余不到「留给别人的」就这轮不读；
//   - 断路：碰到 429、5xx、超时、连不上，或者响应慢，就断开一段时间（指数退避，最长 16 分钟），期间整站读不发请求。
// 纯函数式的状态（一个 Map），不引 node: 模块。
export const OWN_RATE_WINDOW_MS = 180000;
export const OWN_RATE_LIMIT = 360;
// 整站日志读取最多用掉额度的这个比例；剩给别的读取（运营总览、R1、渠道收费）的至少这么多
export const INGEST_BUDGET_SHARE = 0.25;
export const INGEST_RESERVE = 120;
// 响应比这个慢算「慢」：连着几次慢就断路（线上站点忙着，别再添乱）
export const SLOW_MS = 2000;
export const SLOW_STREAK_TO_TRIP = 3;
const BREAK_STEPS_MS = Object.freeze([60000, 120000, 240000, 480000, 960000]);

const entries = new Map(); // host → { hits: number[]（时刻）, breakUntil, breakLevel, slowStreak }
const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url); } };
const entryOf = (host) => { let e = entries.get(host); if (!e) { e = { hits: [], breakUntil: 0, breakLevel: 0, slowStreak: 0 }; entries.set(host, e); } return e; };
const trim = (e, now) => { while (e.hits.length && now - e.hits[0] >= OWN_RATE_WINDOW_MS) e.hits.shift(); };

// request() 每发一个请求记一次：status（0 表示没连上/超时）、耗时
export function noteOwnRequest(url, { status = 0, elapsedMs = 0, now = Date.now() } = {}) {
  const e = entryOf(hostOf(url));
  e.hits.push(now); trim(e, now);
  const broken = status === 429 || status >= 500 || status === 0;
  if (broken) trip(e, now);
  else if (elapsedMs >= SLOW_MS) { e.slowStreak += 1; if (e.slowStreak >= SLOW_STREAK_TO_TRIP) { trip(e, now); e.slowStreak = 0; } }
  else { e.slowStreak = 0; if (now >= e.breakUntil && e.breakLevel > 0 && e.hits.length > 0) e.breakLevel = Math.max(0, e.breakLevel - 0.1); }
}
function trip(e, now) {
  const level = Math.min(Math.floor(e.breakLevel), BREAK_STEPS_MS.length - 1);
  e.breakUntil = now + BREAK_STEPS_MS[level];
  e.breakLevel = Math.min(BREAK_STEPS_MS.length - 1, Math.floor(e.breakLevel) + 1);
}

// 保底：只要没断路，不管别的读占了多少额度，每分钟至少能发这么多个（总指挥 10-26 定：线上别的读接近上限时，额度份额会一直是 0，
// 整站读永远发不出去）。按时间算、不按轮数算：不足一分钟内只发过 0 个时给满这个数，发过了按比例折算剩下能发几个，避免一分钟内连发超过保底
export const INGEST_FLOOR_PER_MIN = 2;

const floorHits = new Map(); // host → 最近一分钟内，保底用掉的次数时刻

// 整站日志读取这轮能发几个请求：断路期间 0；否则 max(保底, min(额度份额, 剩余 − 留给别人的))
export function ingestAllowance(baseUrl, { now = Date.now(), limit = OWN_RATE_LIMIT } = {}) {
  const e = entryOf(hostOf(baseUrl)); trim(e, now);
  if (now < e.breakUntil) return { allowed: 0, reason: "break", until: e.breakUntil, used: e.hits.length };
  const used = e.hits.length;
  const budget = Math.max(0, Math.min(Math.floor(limit * INGEST_BUDGET_SHARE), limit - INGEST_RESERVE - used));
  const host = hostOf(baseUrl);
  let floor = floorHits.get(host);
  if (!floor) { floor = []; floorHits.set(host, floor); }
  while (floor.length && now - floor[0] >= 60000) floor.shift();
  const floorLeft = Math.max(0, INGEST_FLOOR_PER_MIN - floor.length);
  const allowed = Math.max(budget, floorLeft);
  return { allowed, reason: allowed ? (allowed > budget ? "floor" : null) : "budget", used, floor: allowed > budget };
}

// 整站读发了几个请求：保底用了多少要记一笔，不然每次都当没用过、保底形同虚设
export function noteIngestUsage(baseUrl, count, now = Date.now()) {
  if (count <= 0) return;
  const host = hostOf(baseUrl);
  let floor = floorHits.get(host);
  if (!floor) { floor = []; floorHits.set(host, floor); }
  while (floor.length && now - floor[0] >= 60000) floor.shift();
  for (let i = 0; i < count; i += 1) floor.push(now);
}

export function ownRequestState(baseUrl, now = Date.now()) {
  const e = entryOf(hostOf(baseUrl)); trim(e, now);
  return { used: e.hits.length, breakUntil: e.breakUntil, broken: now < e.breakUntil };
}

export function resetOwnRequestBudget() { entries.clear(); floorHits.clear(); }
