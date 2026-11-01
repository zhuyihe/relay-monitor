// 模型供需「高峰余量」的算法（模型供需第 1 步，设计 models-v4）：纯函数，输入是已经读好的数（server/models-page.js 读给它），输出是接口的 headroom（形状见 app/(dashboard)/models/headroom-types.ts）。
// 门槛常数都在 HEADROOM 一处，页面上「怎么算的」那段字也读这一处，不另写一遍。只用库里已有的小时计数和自营站点数据看板的按模型小时成交，不碰用户站。
//
// 口径（规格 v2，审核 2 核过）：
//   - 没买到 F = 最终没买到的请求（server/own-error-supply.js，下限）；被挡过 = 被上游拒过的请求（rejectedRequests），只作提醒；被拒不含请求问题。
//   - 上限（按渠道测）：「明显限流小时」= 尝试 ≥ MIN_ATTEMPTS 次、成交 ≥ 这个渠道窗口内最高那个小时的 MIN_SUCCESS_SHARE、429 占这一小时尝试的 MIN_RATE_LIMIT_SHARE 以上并且比 5xx 多；
//     取这些小时成交量的 P75（窗口 WINDOW_DAYS 天），最近 NEED_DAYS × 24 个小时（含今天已过的）里要有这样的小时；没有的写「至少 X」，X 是窗口里最高的那个小时；错误日志读了不到 NEED_DAYS 天写「数据积累中」。
//     渠道的单位是「一把 Key」（同一条绑定下的渠道算一个）；同一家上游的几把 Key 在同一批小时一起被限流、而且没有「一把被限另一把干净」的反证，是按账号限的：这几把合成一个，整家算一个上限。
//   - 模型能给多少 = Σ（上限 × 这个模型在它高峰时段占这个渠道成交的份额），只算开着的渠道。
//   - 高峰时段：近 NEED_DAYS 个整天（不含今天）按墙上时钟、按小时平均成交，最高的连续 2–3 小时。
//   - 今晚高峰要多少 = 近 7 天同一时段每小时的（成交 + 没买到），上周同一天的有数就用上周同一天，否则取第二高的那天；× 涨幅（近 3 天日均 ÷ 前 4 天日均，限在 GROWTH_MIN–GROWTH_MAX）。
//   - 余量 = 能给 − 今晚要；负的是缺口。建议按顺序判：先充值、按账号限的换一家、加 Key、上限没测到、余量薄。
import { dayKeyInTz, wallHourOfSlot, zonedParts } from "./business-time.js";
import { causeOf, failWindow, lostRecoOf } from "./models-lost.js";

const HOUR = 3600000, DAY = 86400000;
const BLOCKED_REASONS = Object.freeze(["rate_limit", "upstream", "auth_quota", "other"]);

export const HEADROOM = Object.freeze({
  WINDOW_DAYS: 14, // 测上限看多少天
  NEED_DAYS: 7, // 错误日志要读满几天才测上限；高峰时段、今晚要多少都看最近这几个整天
  MIN_ATTEMPTS: 50, // 明显限流小时：这一小时的尝试至少这么多次
  MIN_SUCCESS_SHARE: 0.5, // 明显限流小时：成交至少是这个渠道窗口内最高那个小时的这个比例
  MIN_RATE_LIMIT_SHARE: 0.05, // 明显限流小时：429 至少占这一小时尝试的这个比例，并且比 5xx 多
  LIMIT_PERCENTILE: 0.75, // 上限取明显限流小时成交量的这个分位
  PEAK_MAX_HOURS: 3, // 高峰时段最长连续几小时
  PEAK_MIN_HOURS: 2,
  PEAK_TRIM_BELOW: 0.7, // 高峰窗口两头的小时低于窗口里最高那个小时的这个比例，就去掉（最短 PEAK_MIN_HOURS）
  GROWTH_MIN: 0.8, // 涨幅的范围
  GROWTH_MAX: 1.25,
  GROWTH_RECENT_DAYS: 3, // 涨幅 = 近 3 天日均 ÷ 前 4 天日均
  GROWTH_BASE_DAYS: 4,
  NEED_MIN_DAYS: 3, // 今晚要多少：成交至少有这么多个整天有数才估
  THIN_MARGIN: 500, // 余量少于这个（次/小时）算薄
  // 按账号限（同一家上游的两把 Key 一起被限）要同时满足三条；独立限额的两把 Key 高峰也会一起被限，所以要有反证：一把被限的小时另一把是干净的
  ACCOUNT_MIN_SHARED_HOURS: 2, // 共同被明显限流（尝试 ≥ MIN_ATTEMPTS、429 ≥ MIN_RATE_LIMIT_SHARE）的小时至少这么多个
  ACCOUNT_SHARED_SHARE: 0.8, // 共同被限的小时占两把各自被限小时的这个比例以上
  ACCOUNT_CLEAN_RATE_LIMIT_SHARE: 0.01, // 「干净」：尝试 ≥ MIN_ATTEMPTS 而且 429 不到尝试的这个比例
  ACCOUNT_DIVERGENT_MAX: 0.1, // 「一把被限、另一把干净」的小时占（两把被限小时的并集）的比例不超过它
  MAX_BUCKET_ROWS: 600000, // 渠道 × 模型 × 小时的桶（整站消费日志 + 错误日志）超过这么多行就不算高峰余量（headroom 是 null），防止撑爆内存
  QUIET_SHOWN: 200, // 「另外 N 个模型近 24 小时没有缺货失败」点开最多列几个
  USERS_SHOWN: 5, // 抽屉里「受影响最多的用户」前几个
  KEY_USERS_SHOWN: 3, // 主表一行里「受影响的重点用户」点几个名字
  MODELS_SHOWN: 4, // 上游卡片里「供 N 个模型」点几个名字
});

const sum = (list) => list.reduce((total, value) => total + value, 0);
const mean = (list) => (list.length ? sum(list) / list.length : 0);
const round = (value, dp = 4) => { const m = 10 ** dp; return Math.round(value * m) / m; };
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// 分位数（最近秩法）：p = 0.75，n 个数里排第 ⌈0.75n⌉ 的那个
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------- 时间格子：最近 WINDOW_DAYS 天已经过完的小时，按业务时区的墙上时钟标记 ----------
export function gridOf(now, tz, windowDays = HEADROOM.WINDOW_DAYS, needDays = HEADROOM.NEED_DAYS) {
  const end = Math.floor(now / HOUR) * HOUR, n = windowDays * 24;
  const slots = Array.from({ length: n }, (_, i) => end - (n - i) * HOUR);
  const wall = slots.map((slot) => wallHourOfSlot(slot, tz));
  const today = dayKeyInTz(now, tz);
  const days = []; // 最近的整天（不含今天），最近的在前：{ key, idx: [格子序号] }
  const byKey = new Map();
  for (let i = n - 1; i >= 0; i -= 1) {
    const key = wall[i].dayKey;
    if (key === today) continue;
    let day = byKey.get(key);
    if (!day) { day = { key, idx: [] }; byKey.set(key, day); if (days.length < needDays) days.push(day); else continue; }
    day.idx.push(i);
  }
  for (const day of days) day.idx.reverse();
  const last7 = new Set(days.flatMap((day) => day.idx));
  return { now, tz, n, slots, wall, today, days, last7, last24: Array.from({ length: Math.min(24, n) }, (_, i) => n - Math.min(24, n) + i), indexOf: (t) => { const i = Math.floor((t - slots[0]) / HOUR); return i >= 0 && i < n ? i : -1; } };
}

// 从现在起到下一次 endHour 点整还有几小时（今晚高峰结束；高峰已经过了就算明晚的）
export function hoursUntilHour(now, tz, endHour) {
  const first = Math.ceil(now / HOUR) * HOUR;
  for (let k = 0; k < 50; k += 1) {
    const t = first + k * HOUR;
    if (zonedParts(t, tz).hour === endHour % 24) return round((t - now) / HOUR, 2);
  }
  return null;
}

// ---------- 高峰时段 ----------
// series：和格子一一对应的成交；返回 { hours: [钟点] }（连续 2–3 个，按先后）或 null（近 7 天一单都没有）
export function peakOf(grid, series) {
  const total = new Array(24).fill(0), count = new Array(24).fill(0);
  for (const i of grid.last7) { const h = grid.wall[i].hour; total[h] += series[i] || 0; count[h] += 1; }
  const avg = total.map((value, h) => (count[h] ? value / count[h] : 0));
  const L = HEADROOM.PEAK_MAX_HOURS;
  let best = -1, bestSum = 0;
  for (let h = 0; h < 24; h += 1) {
    const s = sum(Array.from({ length: L }, (_, k) => avg[(h + k) % 24]));
    if (s > bestSum) { bestSum = s; best = h; }
  }
  if (best < 0) return null;
  let hours = Array.from({ length: L }, (_, k) => (best + k) % 24);
  const top = Math.max(...hours.map((h) => avg[h]));
  // 窗口两头的小时太低就去掉（高峰不一定有 3 小时）；两头都低先去掉低的那头
  while (hours.length > HEADROOM.PEAK_MIN_HOURS) {
    const head = avg[hours[0]], tail = avg[hours[hours.length - 1]];
    const weak = Math.min(head, tail);
    if (weak >= HEADROOM.PEAK_TRIM_BELOW * top) break;
    if (head <= tail) hours = hours.slice(1); else hours = hours.slice(0, -1);
  }
  return { hours };
}
const peakIdx = (grid, peak) => (peak ? [...grid.last7].filter((i) => peak.hours.includes(grid.wall[i].hour)).sort((a, b) => a - b) : []);

// ---------- 上限 ----------
// s：{ success, rl（429）, up（5xx 等上游故障）, rej（所有被拒） } 都是和格子一一对应的数组。
// 返回 { kind: "measured" | "atLeast", value, throttled: [格子序号] }：最近 NEED_DAYS 天里有明显限流小时才是 measured
export function measureLimit(s, grid) {
  const max = Math.max(0, ...s.success);
  const throttled = [];
  for (let i = 0; i < grid.n; i += 1) {
    const attempts = s.success[i] + s.rej[i];
    if (attempts >= HEADROOM.MIN_ATTEMPTS && s.success[i] >= HEADROOM.MIN_SUCCESS_SHARE * max
      && s.rl[i] >= HEADROOM.MIN_RATE_LIMIT_SHARE * attempts && s.rl[i] > s.up[i]) throttled.push(i);
  }
  if (throttled.some((i) => i >= grid.n - HEADROOM.NEED_DAYS * 24)) return { kind: "measured", value: percentile(throttled.map((i) => s.success[i]), HEADROOM.LIMIT_PERCENTILE), throttled };
  return { kind: "atLeast", value: max, throttled };
}

// 两把 Key 是不是被同一个账号限着：共同被限的小时够多、占各自被限小时的大部分，并且「一把被限、另一把干净」的小时很少
export function sameAccount(a, b) {
  const union = new Set([...a.limited, ...b.limited]);
  let shared = 0, divergent = 0;
  for (const i of union) {
    const inA = a.limited.has(i), inB = b.limited.has(i);
    if (inA && inB) shared += 1;
    else if ((inA && b.clean.has(i)) || (inB && a.clean.has(i))) divergent += 1;
  }
  return shared >= HEADROOM.ACCOUNT_MIN_SHARED_HOURS && shared >= HEADROOM.ACCOUNT_SHARED_SHARE * a.limited.size && shared >= HEADROOM.ACCOUNT_SHARED_SHARE * b.limited.size
    && divergent <= HEADROOM.ACCOUNT_DIVERGENT_MAX * union.size;
}

const zeros = (n) => new Float64Array(n);
const addInto = (target, source) => { for (let i = 0; i < target.length; i += 1) target[i] += source[i]; };
const seriesOf = (n) => ({ success: zeros(n), rl: zeros(n), up: zeros(n), auth: zeros(n), other: zeros(n), rej: zeros(n) });
const addSeries = (target, source) => { for (const key of Object.keys(target)) addInto(target[key], source[key]); };

/**
 * 整页和每个模型的抽屉。输入：
 *   now、tz
 *   errorLog：{ switchOn（控制台里开着）, cursor（{ coveredFromMs, coveredToMs } 或 null）, hasRecords（库里有没有过错误） }
 *   consume：{ on（整站消费日志在读）, cursor }
 *   modelHours：[{ model, t（小时起点）, requests, cost（美元）}]（数据看板按模型的小时，近 30 天）
 *   cells：queryErrorSupply 的 cells（渠道 × 模型 × 小时：success、rejected、rejectedRequests…）
 *   byModelHour：queryErrorSupply 的 byModelHour（模型 × 小时：finalFailures、rejected、rejectedRequests）
 *   rejectedUsers：queryRejectedUsers（近 24 小时，不限模型）的结果
 *   usersById：Map(用户 id → { name, key })，key：重点用户
 *   channels：[{ channelId, name, state（on|off|auto）, models: [模型名], upstreamId（没绑是 null）, ruleId（一把 Key 一条绑定，没绑是 null）}]
 *   upstreams：Map(上游 id → { id, name, runway })，runway 同 server/models-page.js 的 runwayOf
 *   weekUsd：Map(模型 → 近 7 天消费美元)；small：Set(量很小不判的模型)
 * 返回 { page, detailOf(模型名) }。
 */
export function buildHeadroom(input) {
  const { now, tz, errorLog, consume, modelHours, cells, byModelHour, rejectedUsers, usersById = new Map(), channels, upstreams, weekUsd = new Map(), small = new Set(), outModels = new Map() } = input;
  const grid = gridOf(now, tz), n = grid.n;
  const DAYS_NEED = HEADROOM.NEED_DAYS;

  // ----- 状态 -----
  const errorDays = errorLog.cursor ? Math.max(0, (errorLog.cursor.coveredToMs - errorLog.cursor.coveredFromMs) / DAY) : null;
  const consumeDays = consume.on && consume.cursor ? Math.max(0, (consume.cursor.coveredToMs - consume.cursor.coveredFromMs) / DAY) : null;
  const coveredDays = errorDays == null ? (errorLog.switchOn ? 0 : null) : consumeDays == null ? errorDays : Math.min(errorDays, consumeDays);
  let state = "ok", noErrorLogReason = null;
  if (!errorLog.switchOn) { state = "noErrorLog"; noErrorLogReason = "switchOff"; }
  else if (errorDays != null && errorDays >= 1 && !errorLog.hasRecords) { state = "noErrorLog"; noErrorLogReason = "noRecords"; }
  else if (coveredDays == null || coveredDays < DAYS_NEED) state = "accumulating";
  const haveErrors = state !== "noErrorLog";
  // 能给、上限拿不到：没开整站消费日志，或控制台里把「读取错误日志」关了；开着但一条错误都没有（noRecords）时最高成交量照样是真的，写「至少 X」，
  // 但没买到、被挡过、余量分不清是没开还是真没有，写「—」（margin none、notBought null）
  const limitsUnavailable = !consume.on || (state === "noErrorLog" && noErrorLogReason === "switchOff");
  const errorFrom = errorLog.cursor ? Math.ceil(errorLog.cursor.coveredFromMs / HOUR) * HOUR : Infinity; // 这个小时起错误日志有数
  const covered = (i) => grid.slots[i] >= errorFrom;

  // ----- 成交（按模型，数据看板）、没买到、被挡 -----
  const succByModel = new Map(), costByModel = new Map();
  for (const row of modelHours || []) {
    const i = grid.indexOf(row.t);
    if (i < 0) continue;
    let s = succByModel.get(row.model); if (!s) { succByModel.set(row.model, s = zeros(n)); costByModel.set(row.model, zeros(n)); }
    s[i] += row.requests || 0; costByModel.get(row.model)[i] += row.cost || 0;
  }
  const errByModel = new Map(); // 模型 → { f, q, rl, up, auth, other }
  for (const row of byModelHour || []) {
    const i = grid.indexOf(row.slotMs);
    if (i < 0) continue;
    let e = errByModel.get(row.model); if (!e) errByModel.set(row.model, e = { f: zeros(n), q: zeros(n), rl: zeros(n), up: zeros(n), auth: zeros(n), other: zeros(n), fRl: zeros(n), fUp: zeros(n), fAuth: zeros(n) });
    const byReason = row.finalFailuresByReason || {};
    e.fRl[i] += byReason.rate_limit || 0; e.fUp[i] += byReason.upstream || 0; e.fAuth[i] += byReason.auth_quota || 0; // 没买到按原因分（加起来是 f）
    e.f[i] += row.finalFailures || 0; e.q[i] += row.rejectedRequests || 0;
    e.rl[i] += row.rejected.rate_limit; e.up[i] += row.rejected.upstream; e.auth[i] += row.rejected.auth_quota; e.other[i] += row.rejected.other;
  }
  const zero = zeros(n);
  const succOf = (m) => succByModel.get(m) || zero;
  const errOf = (m) => errByModel.get(m) || null;

  // ----- 渠道、Key、上游 -----
  const chById = new Map(channels.map((c) => [c.channelId, c]));
  const chSeries = new Map(), chModel = new Map(); // 渠道 → 序列；`渠道|模型` → [{ i, success }]
  const seriesFor = (id) => { let s = chSeries.get(id); if (!s) chSeries.set(id, s = seriesOf(n)); return s; };
  const lastLost = []; // 近 24 小时有缺货失败的格子（渠道 × 模型 × 小时）：缺货失败直接用格子自己的数（queryErrorSupply 按格子的分档尝试数算的），出在哪个渠道、哪家上游一清二楚
  for (const cell of cells || []) {
    const i = grid.indexOf(cell.slotMs);
    if (i < 0) continue;
    const f = cell.finalFailuresByReason;
    if (i >= n - 24 && f && f.rate_limit + f.upstream + f.auth_quota > 0) lastLost.push({ model: cell.model, channelId: cell.channelId, upstream: chById.get(cell.channelId)?.upstreamId ?? "", f });
    const s = seriesFor(cell.channelId);
    s.success[i] += cell.success; s.rl[i] += cell.rejected.rate_limit; s.up[i] += cell.rejected.upstream; s.auth[i] += cell.rejected.auth_quota; s.other[i] += cell.rejected.other; s.rej[i] += cell.rejected.total;
    if (cell.success > 0) { const key = `${cell.channelId}|${cell.model}`; let list = chModel.get(key); if (!list) chModel.set(key, list = []); list.push({ i, success: cell.success }); }
  }
  const zeroBy = () => ({ rate_limit: 0, upstream: 0, auth_quota: 0 });
  const upLost = new Map(), chLost = new Map(), upLostAll = new Map(); // `模型|上游` / `模型#渠道` / 上游 → 按原因的缺货失败
  const addLost = (map, key, part) => { const x = map.get(key) || zeroBy(); x.rate_limit += part.rate_limit; x.upstream += part.upstream; x.auth_quota += part.auth_quota; map.set(key, x); };
  for (const e of lastLost) { addLost(upLost, `${e.model}|${e.upstream}`, e.f); addLost(chLost, `${e.model}#${e.channelId}`, e.f); addLost(upLostAll, String(e.upstream), e.f); }
  // Key 单元：同一条绑定的渠道算一个；没绑的各算各的
  const units = new Map();
  for (const c of channels) {
    const key = c.ruleId != null ? `rule:${c.ruleId}` : `ch:${c.channelId}`;
    let u = units.get(key); if (!u) units.set(key, u = { id: key, upstreamId: c.upstreamId ?? null, channels: [], series: seriesOf(n), keys: 1, merged: false });
    u.channels.push(c);
  }
  for (const u of units.values()) for (const c of u.channels) { const s = chSeries.get(c.channelId); if (s) addSeries(u.series, s); }
  for (const u of units.values()) {
    u.measure = measureLimit(u.series, grid);
    // 按账号限的证据：哪些小时被明显限流（limited），哪些小时干净（clean）
    u.limited = new Set(); u.clean = new Set();
    for (let i = 0; i < n; i += 1) {
      const attempts = u.series.success[i] + u.series.rej[i];
      if (attempts < HEADROOM.MIN_ATTEMPTS) continue;
      if (u.series.rl[i] >= HEADROOM.MIN_RATE_LIMIT_SHARE * attempts) u.limited.add(i);
      else if (u.series.rl[i] < HEADROOM.ACCOUNT_CLEAN_RATE_LIMIT_SHARE * attempts) u.clean.add(i);
    }
  }
  // 按账号限：同一家上游的几把 Key 一起被限流 → 合成一个
  const byUp = new Map();
  for (const u of units.values()) if (u.upstreamId != null) { let list = byUp.get(u.upstreamId); if (!list) byUp.set(u.upstreamId, list = []); list.push(u); }
  const accountLimited = new Set();
  for (const [upstreamId, list] of byUp) {
    if (list.length < 2) continue;
    const merge = new Set();
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) if (sameAccount(list[a], list[b])) { merge.add(list[a]); merge.add(list[b]); }
    if (merge.size < 2) continue;
    accountLimited.add(upstreamId);
    const merged = { id: `account:${upstreamId}`, upstreamId, channels: [], series: seriesOf(n), keys: merge.size, merged: true };
    for (const u of merge) { merged.channels.push(...u.channels); addSeries(merged.series, u.series); units.delete(u.id); }
    merged.measure = measureLimit(merged.series, grid);
    units.set(merged.id, merged);
  }
  const unitOfChannel = new Map();
  for (const u of units.values()) for (const c of u.channels) unitOfChannel.set(c.channelId, u);
  const isOpen = (u, model) => u.channels.some((c) => c.state === "on" && (model == null || (c.models || []).includes(model)));

  // 上限在页面上的样子：没开错误日志或没开整站消费日志拿不到、不够 7 天在积累、其余按测到没有
  const limitQuantity = (measure) => {
    if (limitsUnavailable) return { kind: "unavailable", value: null };
    if (state === "accumulating") return { kind: "accumulating", value: null };
    return { kind: state === "noErrorLog" ? "atLeast" : measure.kind, value: round(measure.value, 2) };
  };

  // ----- 全站高峰、上游余额 -----
  const siteSeries = zeros(n);
  for (const s of succByModel.values()) addInto(siteSeries, s);
  const sitePeak = peakOf(grid, siteSeries);
  const hoursLeftOf = (upstreamId) => {
    const runway = upstreams.get(upstreamId)?.runway;
    return runway && !runway.fixed && !runway.noSpend && Number.isFinite(runway.days) ? round(runway.days * 24, 1) : null;
  };
  const upstreamName = (id) => upstreams.get(id)?.name ?? null;

  // ----- 每个模型 -----
  const models = new Map(), allModels = new Set([...succByModel.keys()]);
  const modelRows = [];
  for (const name of allModels) {
    const S = succOf(name), err = errOf(name);
    if (!(sum(S) > 0)) continue;
    const peak = peakOf(grid, S);
    const pIdx = peakIdx(grid, peak);
    // 今晚要多少
    const need = needOf({ grid, S, F: err?.f || zero, peak, covered, haveErrors: haveErrors && errorLog.switchOn });
    // 能给多少：Σ 单元的上限 × 这个模型在高峰占这个单元成交的份额
    const contributors = [];
    for (const u of units.values()) {
      if (!isOpen(u, name)) continue;
      let num = 0;
      for (const c of u.channels) for (const e of chModel.get(`${c.channelId}|${name}`) || []) if (pIdx.includes(e.i)) num += e.success;
      let den = 0; for (const i of pIdx) den += u.series.success[i];
      const share = den > 0 ? num / den : 0;
      contributors.push({ unit: u, share, contribution: u.measure.value * share });
    }
    const real = contributors.filter((c) => c.share > 0);
    let supply;
    if (limitsUnavailable) supply = { kind: "unavailable", value: null };
    else if (state === "accumulating") supply = { kind: "accumulating", value: null };
    else if (!contributors.length) supply = { kind: "measured", value: 0 };
    else if (!real.length) supply = { kind: "atLeast", value: 0 };
    else supply = { kind: state === "noErrorLog" || real.some((c) => c.unit.measure.kind === "atLeast") ? "atLeast" : "measured", value: round(sum(real.map((c) => c.contribution)), 2) };
    // 余量
    let margin = { value: null, status: "none", kind: supply.kind };
    if (need && supply.value != null && state !== "noErrorLog") {
      const value = round(supply.value - need.value, 2);
      let status = "ok";
      if (value < 0) status = supply.kind === "measured" ? "short" : "unknown";
      else if (value < HEADROOM.THIN_MARGIN) status = "thin";
      margin = { value, status, kind: supply.kind };
    }
    // 近 24 小时没买到
    const f24 = err ? sum(grid.last24.map((i) => err.f[i])) : 0, q24 = err ? sum(grid.last24.map((i) => err.q[i])) : 0;
    const cost = costByModel.get(name), weekCost = sum([...grid.last7].map((i) => cost[i])), weekReq = sum([...grid.last7].map((i) => S[i]));
    const avgRevenue = (i) => (S[i] > 0 && cost[i] > 0 ? cost[i] / S[i] : weekReq > 0 ? weekCost / weekReq : 0);
    const notBought = haveErrors ? { f24: round(f24, 1), lostUsd: round(err ? sum(grid.last24.map((i) => err.f[i] * avgRevenue(i))) : 0, 4), blockedRetried: round(Math.max(0, q24 - f24), 1) } : null;
    // 每次卖多少（高峰时段的平均，缺口折钱排序用）
    const peakReq = sum(pIdx.map((i) => S[i])), revenuePerRequest = peakReq > 0 ? sum(pIdx.map((i) => cost[i])) / peakReq : weekReq > 0 ? weekCost / weekReq : 0;
    models.set(name, { name, S, err, peak, pIdx, need, supply, margin, contributors, notBought, revenuePerRequest });
    modelRows.push(name);
  }

  // ----- 建议 -----
  const peakEndHours = (peak) => (peak ? hoursUntilHour(now, tz, peak.hours[peak.hours.length - 1] + 1) : null);
  function recoOf(m) {
    const untilEnd = peakEndHours(m.peak);
    // 先充值：这个模型的货主要来自的上游里，撑不到今晚高峰结束的（贡献大的在前）
    const sharesByUpstream = new Map();
    for (const c of m.contributors) if (c.unit.upstreamId != null) sharesByUpstream.set(c.unit.upstreamId, (sharesByUpstream.get(c.unit.upstreamId) || 0) + c.share);
    const failing = untilEnd == null ? [] : [...sharesByUpstream].map(([id, share]) => ({ id, share, hours: hoursLeftOf(id) })).filter((x) => x.hours != null && x.hours < untilEnd).sort((a, b) => b.share - a.share || a.hours - b.hours);
    if (failing.length) return { kind: "topup", upstreamId: failing[0].id, name: upstreamName(failing[0].id), hoursLeft: failing[0].hours };
    if (state !== "ok" || !consume.on) return { kind: "unmeasured" };
    if (m.margin.status === "short") {
      // 按账号限：这个模型的货里有整家一起被限流的上游，加 Key 没用
      const acct = m.contributors.filter((c) => c.unit.merged && c.share > 0).sort((a, b) => b.contribution - a.contribution)[0];
      if (acct) return { kind: "switch", upstreamId: acct.unit.upstreamId, name: upstreamName(acct.unit.upstreamId), keys: acct.unit.keys };
      // 加 Key：供这个模型的上游里被挡最少的那家，一把 Key 的上限用它测到的中位数
      const candidates = new Map();
      for (const c of m.contributors) {
        const id = c.unit.upstreamId;
        if (id == null || c.unit.merged) continue;
        let entry = candidates.get(id); if (!entry) candidates.set(id, entry = { id, limits: [], blocked: 0 });
        if (c.unit.measure.kind === "measured") entry.limits.push(c.unit.measure.value);
      }
      for (const entry of candidates.values()) entry.blocked = blockedByUpstream(m.name, entry.id);
      const usable = [...candidates.values()].filter((x) => x.limits.length).sort((a, b) => a.blocked - b.blocked || median(b.limits) - median(a.limits));
      if (!usable.length) return { kind: "unmeasured" };
      const perKey = median(usable[0].limits);
      if (!(perKey > 0)) return { kind: "unmeasured" };
      return { kind: "addKeys", n: Math.ceil(-m.margin.value / perKey), upstreamId: usable[0].id, name: upstreamName(usable[0].id), perKey: round(perKey, 2) };
    }
    if (m.margin.status === "unknown") return { kind: "unmeasured" };
    if (m.margin.status === "thin") return { kind: "thin" };
    return state === "ok" ? { kind: "none" } : { kind: "unmeasured" };
  }
  // 一个模型在一家上游上近 7 天被挡的次数（加 Key 选「被挡最少」的那家用）
  const cellsByModelChannel = new Map();
  for (const cell of cells || []) { const i = grid.indexOf(cell.slotMs); if (i < 0 || !grid.last7.has(i)) continue; const key = `${cell.model}|${cell.channelId}`; cellsByModelChannel.set(key, (cellsByModelChannel.get(key) || 0) + cell.rejected.total); }
  function blockedByUpstream(model, upstreamId) {
    let total = 0;
    for (const c of channels) if ((c.upstreamId ?? null) === upstreamId) total += cellsByModelChannel.get(`${model}|${c.channelId}`) || 0;
    return total;
  }

  // ----- 用户 -----
  const usersByModel = new Map(); // 模型 → [{ userId, blocked }]
  for (const user of rejectedUsers || []) for (const m of user.byModel) {
    let list = usersByModel.get(m.model); if (!list) usersByModel.set(m.model, list = []);
    list.push({ userId: user.userId, blocked: m.rejected.total, requests: m.rejectedRequests });
  }
  const userInfo = (userId) => usersById.get(userId) || { name: `#${userId}`, key: false };

  // ----- v5：近 24 小时缺货失败（主表只列有失败的模型）-----
  const openModels = new Set();
  for (const c of channels) if (c.state === "on") for (const model of c.models || []) openModels.add(model);
  // 这个模型换到哪家上游：还有开着的渠道在供它、不是失败最多的那家、近 7 天被挡最少的（一样多的按名字）；没有可挪的是 null
  // 过滤：余额撑不到今晚高峰结束的不选（读不到余额的不排除）；上游卡片标了 full（高峰已经用满上限）的不选；都滤掉了是 null，页面只给另外那半句
  let fullUpstreams = new Set(); // 卡片建好以后填
  const moveToOf = (name, mainId, untilEnd) => {
    const ids = new Set();
    for (const c of channels) if (c.state === "on" && (c.models || []).includes(name) && c.upstreamId != null && c.upstreamId !== mainId) ids.add(c.upstreamId);
    for (const id of [...ids]) {
      const hoursLeft = hoursLeftOf(id);
      if ((hoursLeft != null && untilEnd != null && hoursLeft < untilEnd) || fullUpstreams.has(String(id))) ids.delete(id);
    }
    const best = [...ids].map((id) => ({ id, blocked: blockedByUpstream(name, id) })).sort((a, b) => a.blocked - b.blocked || String(upstreamName(a.id) ?? a.id).localeCompare(String(upstreamName(b.id) ?? b.id), "zh-CN"))[0];
    return best ? { upstreamId: String(best.id), name: upstreamName(best.id) } : null;
  };
    // 返回 null：这个模型近 24 小时没有缺货失败（或没开错误日志）
  function lostRowOf(m, keyList) {
    if (!haveErrors || !m.notBought || !(m.notBought.f24 > 0)) return null;
    const err = m.err, last24Sum = (arr) => sum(grid.last24.map((i) => arr[i]));
    const byReason = { rate_limit: last24Sum(err.fRl), upstream: last24Sum(err.fUp), auth_quota: last24Sum(err.fAuth) };
    const cause = causeOf({ noOpenChannel: !openModels.has(m.name), byReason });
    // 失败最多的那家上游：这个原因的缺货失败（摊到上游）最多的（渠道没绑上游的算一家「没绑」，它最多就没有）；upstreamCount：失败涉及几家上游
    let main = null, upstreamCount = 0;
    if (cause && cause !== "no_channel") {
      let top = null;
      for (const [key, e] of upLost) {
        if (!key.startsWith(`${m.name}|`)) continue;
        const id = key.slice(m.name.length + 1);
        if (id !== "" && e.rate_limit + e.upstream + e.auth_quota > 0.5) upstreamCount += 1;
        const count = e[cause];
        if (count > 0 && (top == null || count > top.count)) top = { id, count };
      }
      if (top && top.id !== "") main = { upstreamId: String(top.id), name: upstreamName(top.id) };
    }
    const mainId = main?.upstreamId ?? null;
    const growth = growthOf(grid.days.map((day) => sum(day.idx.map((i) => m.S[i] + err.f[i]))));
    // 加几把 Key：只在测到上限、算出缺口时给（一把 Key 的上限取这家上游测到的中位数）
    let addKeys = null;
    if (cause === "rate_limit" && main && m.margin.status === "short") {
      const limits = m.contributors.filter((c) => String(c.unit.upstreamId) === main.upstreamId && !c.unit.merged && c.unit.measure.kind === "measured").map((c) => c.unit.measure.value);
      const perKey = median(limits);
      if (perKey > 0) addKeys = { n: Math.ceil(-m.margin.value / perKey), perKey: round(perKey, 2) };
    }
    const reco = lostRecoOf({ cause, main, hoursLeft: mainId != null ? hoursLeftOf(mainId) : null, moveTo: cause === "upstream" || cause === "rate_limit" ? moveToOf(m.name, mainId, peakEndHours(m.peak) ?? siteUntil) : null,
      addKeys, accountLimited: mainId != null && accountLimited.has(mainId) });
    return {
      name: m.name, weekUsd: weekUsd.get(m.name) ?? 0, lost24: m.notBought.f24, lostMoney24: m.notBought.lostUsd, estimated: false, outSince: null, mainCause: cause, mainUpstream: main, upstreamCount,
      peakFailHours: failWindow(grid.last24.map((i) => ({ hour: grid.wall[i].hour, f: err.f[i] }))), tomorrowLost: round(m.notBought.f24 * growth, 1), reco,
      keyUsers: { count: keyList.length, top: keyList.slice(0, HEADROOM.KEY_USERS_SHOWN).map((u) => ({ userId: u.userId, name: userInfo(u.userId).name, blocked: u.blocked, blockedRequests: u.requests })) },
    };
  }
  const chLostTotal = (model, channelId) => { const x = chLost.get(`${model}#${channelId}`); return x ? x.rate_limit + x.upstream + x.auth_quota : 0; };
  const lostRows = [];
  const quietList = [];

  // ----- 行 -----
  const rows = [];
  for (const m of models.values()) {
    m.reco = recoOf(m);
    const keyList = (usersByModel.get(m.name) || []).filter((u) => userInfo(u.userId).key).sort((a, b) => b.requests - a.requests || b.blocked - a.blocked || a.userId - b.userId);
    const isSmall = small.has(m.name);
    let group = "ok";
    if (isSmall) group = "small";
    else if (m.margin.status === "short") group = "short";
    else if (m.margin.status === "thin") group = "thin";
    else if (m.margin.status === "unknown" || m.margin.status === "none" || m.reco.kind === "topup") group = "unknown";
    m.keyList = keyList;
    const gapUsdPerHour = m.margin.status === "short" ? round(-m.margin.value * m.revenuePerRequest, 4) : null;
    rows.push({
      name: m.name, weekUsd: weekUsd.get(m.name) ?? 0, group,
      peak: m.peak, need: m.need, supply: m.supply, margin: m.margin,
      keyUsers: haveErrors ? { count: keyList.length, top: keyList.slice(0, HEADROOM.KEY_USERS_SHOWN).map((u) => ({ userId: u.userId, name: userInfo(u.userId).name, blocked: u.blocked, blockedRequests: u.requests })) } : { count: 0, top: [] },
      reco: m.reco, notBought: m.notBought, gapUsdPerHour,
    });
  }
  const rank = { short: 0, thin: 1, unknown: 2, ok: 3, small: 4 };
  rows.sort((a, b) => rank[a.group] - rank[b.group]
    || (a.group === "short" ? (b.gapUsdPerHour - a.gapUsdPerHour || a.margin.value - b.margin.value)
      : a.group === "thin" || a.group === "ok" ? (a.margin.value ?? 0) - (b.margin.value ?? 0) : 0)
    || b.weekUsd - a.weekUsd || String(a.name).localeCompare(String(b.name), "zh-CN"));

  // ----- 上游卡片 -----
  const siteIdx = peakIdx(grid, sitePeak);
  const siteUntil = peakEndHours(sitePeak);
  const upstreamIds = new Set([...units.values()].map((u) => u.upstreamId));
  const cards = [];
  for (const id of upstreamIds) {
    const us = [...units.values()].filter((u) => u.upstreamId === id && isOpen(u, null));
    if (!us.length) continue;
    const limits = us.map((u) => u.measure);
    const limit = limitQuantity({ kind: limits.some((l) => l.kind === "atLeast") ? "atLeast" : "measured", value: sum(limits.map((l) => l.value)) });
    const used = siteIdx.length ? mean(siteIdx.map((i) => sum(us.map((u) => u.series.success[i])))) : null;
    const peakUsed = used == null ? null : round(used, 2);
    const full = limit.kind === "measured" && peakUsed != null && peakUsed >= limit.value;
    const room = limit.value != null && peakUsed != null ? round(Math.max(0, limit.value - peakUsed), 2) : null;
    const reason = (key) => round(sum(grid.last24.map((i) => sum(us.map((u) => u.series[key][i])))), 1);
    const served = new Map();
    for (const u of us) for (const c of u.channels) if (c.state === "on") for (const model of c.models || []) served.set(model, weekUsd.get(model) ?? 0);
    const names = [...served].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh-CN")).map(([model]) => model);
    const hoursLeft = id == null ? null : hoursLeftOf(id);
    cards.push({
      upstreamId: id == null ? null : String(id), name: id == null ? null : upstreamName(id), hoursLeft, limit, peakUsed, room, full,
      accountLimited: id != null && accountLimited.has(id),
      lost24: haveErrors ? ((x) => ({ rate_limit: round(x.rate_limit, 1), upstream: round(x.upstream, 1), auth_quota: round(x.auth_quota, 1) }))(upLostAll.get(String(id)) ?? zeroBy()) : null,
      blocked24: haveErrors ? { rate_limit: reason("rl"), upstream: reason("up"), auth_quota: reason("auth"), other: reason("other") } : null,
      models: { count: names.length, names: names.slice(0, HEADROOM.MODELS_SHOWN) },
      actions: [],
    });
  }
  const roomExists = (skip) => cards.some((c) => c !== skip && c.upstreamId != null && c.room != null && c.room > 0);
  for (const c of cards) {
    if (c.hoursLeft != null && siteUntil != null && c.hoursLeft < siteUntil) c.actions.push("topup");
    if (c.full && !c.accountLimited) c.actions.push("addKey");
    if (c.full && roomExists(c)) c.actions.push("weights");
  }
  fullUpstreams = new Set(cards.filter((c) => c.full).map((c) => c.upstreamId));
  const topupOrder = (c) => (c.actions.includes("topup") ? 0 : c.full ? 1 : 2);
  cards.sort((a, b) => topupOrder(a) - topupOrder(b) || (a.room ?? Infinity) - (b.room ?? Infinity) || String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN"));

  // ----- v5：缺货失败的行（要用上游卡片的 full，所以在卡片之后建）-----
  // 量很小（和断货行同一个门槛：近 7 天日均消费 ≥ 全站日均的千分之一，lib/models-view.js 判的 small，这里不重判）的不进主表，数进 smallCount
  let smallCount = 0;
  for (const m of models.values()) {
    const isOut = outModels.has(m.name) && !openModels.has(m.name);
    const lostRow = isOut ? null : lostRowOf(m, m.keyList);
    m.lost = lostRow;
    if (isOut) { /* 断货的：下面单独列进主表（没渠道），不算「没有缺货失败」 */ }
    else if (lostRow && small.has(m.name)) { smallCount += 1; m.lost = null; }
    else if (lostRow) lostRows.push(lostRow);
    else if (haveErrors) quietList.push({ name: m.name, weekUsd: weekUsd.get(m.name) ?? 0 });
  }
  // 断货的模型（当前一个开着的渠道都没有，断货前那 7 天的日均消费不算「量很小」——lib/models-view.js 判的，这里不重判）：列进主表，
  // lost24 是 null（分发阶段的拒绝不进错误日志，数不出来），少收和明天预计都是估计值（断货前 7 天的日均钱 / 日均请求数），estimated: true
  const outRows = [];
  for (const [name, o] of outModels) {
    if (openModels.has(name)) continue;
    const row = { name, weekUsd: weekUsd.get(name) ?? 0, lost24: null, lostMoney24: round(o.costPerDay, 4), estimated: true, outSince: o.outSince ?? null, mainCause: "no_channel", mainUpstream: null, upstreamCount: 0,
      peakFailHours: null, tomorrowLost: round(o.requestsPerDay, 1), reco: { kind: "openChannel" }, keyUsers: { count: 0, top: [] } };
    outRows.push(row);
    const m = models.get(name); if (m) m.lost = row;
  }
  lostRows.push(...outRows);
  lostRows.sort((a, b) => b.lostMoney24 - a.lostMoney24 || (b.lost24 ?? 0) - (a.lost24 ?? 0) || b.weekUsd - a.weekUsd || String(a.name).localeCompare(String(b.name), "zh-CN"));
  // ----- 顶上三个数 -----
  const short = rows.filter((r) => r.group === "short");
  const worst = short.slice().sort((a, b) => a.margin.value - b.margin.value)[0] || null;
  const topupCards = cards.filter((c) => c.actions.includes("topup")).sort((a, b) => a.hoursLeft - b.hoursLeft);
  const withNb = rows.filter((r) => r.notBought);
  const keyUserIds = new Set();
  for (const user of rejectedUsers || []) if (userInfo(user.userId).key) keyUserIds.add(user.userId);
  const lostOk = errorLog.switchOn && errorLog.hasRecords; // 有错误日志可看（读取开着、读到过记录）
  const failRows = lostRows.filter((r) => !r.estimated); // 真有缺货失败的行（不含断货的估计行）
  const topFail = failRows.reduce((best, r) => (!best || r.tomorrowLost > best.tomorrowLost ? r : best), null);
  const page = {
    state, noErrorLogReason,
    errorLog: { coveredDays: coveredDays == null ? null : round(coveredDays, 1), needDays: DAYS_NEED, daysLeft: coveredDays == null ? null : round(Math.max(0, DAYS_NEED - coveredDays), 1) },
    consumeLog: !!consume.on, peak: sitePeak,
    kpis: {
      willShort: haveErrors && state === "ok" && consume.on ? { count: short.length, worst: worst ? { name: worst.name, gap: -worst.margin.value, peak: worst.peak } : null } : null,
      notBought: haveErrors ? { f24: round(sum(withNb.map((r) => r.notBought.f24)), 1), lostUsd: round(sum(withNb.map((r) => r.notBought.lostUsd)), 4), blockedRetried: round(sum(withNb.map((r) => r.notBought.blockedRetried)), 1), keyUsers: keyUserIds.size } : null,
      topup: { count: topupCards.length, first: topupCards[0] ? { upstreamId: topupCards[0].upstreamId, name: topupCards[0].name, hoursLeft: topupCards[0].hoursLeft } : null },
    },
    rows, upstreams: cards, numbers: numbersOf(),
    lost: {
      // 三种：noErrorLog/switchOff 控制台里关了「读取错误日志」；noErrorLog/noRecords 开着读取但从来没读到过一条（用户站还没开错误日志）；noFailures 以前读到过、近 24 小时没有缺货失败；其余 ok。
      // 断货的行（没渠道）不靠错误日志，没开错误日志时也在 rows 里（只有它们）
      status: !errorLog.switchOn || !errorLog.hasRecords ? "noErrorLog" : lostRows.length || smallCount ? "ok" : "noFailures",
      noErrorLogReason: !errorLog.switchOn ? "switchOff" : !errorLog.hasRecords ? "noRecords" : null,
      kpis: {
        // 明天预计会缺：模型数算上断货的，预计失败次数不算断货的（outOfStockCount 另给）；top：预计失败最多的那个模型（不算断货的）
        tomorrow: lostOk ? { count: lostRows.filter((r) => r.estimated || r.tomorrowLost >= 1).length, lost: round(sum(failRows.map((r) => r.tomorrowLost)), 1), outOfStockCount: outRows.length,
          top: topFail ? { name: topFail.name, lost: topFail.tomorrowLost } : null } : null,
        // 近 24 小时：失败次数不算断货的，少收算上断货行的估计值
        last24: lostOk ? { lost: round(sum(failRows.map((r) => r.lost24)), 1), lostUsd: round(sum(lostRows.map((r) => r.lostMoney24)), 4), keyUsers: keyUserIds.size, outOfStockCount: outRows.length } : null,
        topup: { count: topupCards.length, first: topupCards[0] ? { upstreamId: topupCards[0].upstreamId, name: topupCards[0].name, hoursLeft: topupCards[0].hoursLeft } : null },
      },
      rows: lostRows, quietCount: lostOk ? quietList.length : 0, smallCount: lostOk ? smallCount : 0,
      quiet: lostOk ? quietList.sort((x, y) => y.weekUsd - x.weekUsd || String(x.name).localeCompare(String(y.name), "zh-CN")).slice(0, HEADROOM.QUIET_SHOWN) : [],
    },
  };

  // ----- 抽屉 -----
  function detailOf(name) {
    const m = models.get(name);
    const outRow = outRows.find((row) => row.name === name);
    if (!m && outRow) {
      // 断货的模型近 14 天没有成交（不在 models 里）：只有「没渠道」那一行、渠道列表，别的没有
      const chRows = channels.filter((c) => (c.models || []).includes(name)).map((c) => ({ channelId: c.channelId, name: c.name, upstream: c.upstreamId == null ? null : { id: String(c.upstreamId), name: upstreamName(c.upstreamId) },
        state: c.state, limit: { kind: "unavailable", value: null }, peakUsed: null, room: null, status: c.state === "auto" ? "auto" : "off", lost24: null, mainCause: null }));
      return { name, peak: null, need: null, supply: { kind: "unavailable", value: null }, margin: { value: null, status: "none", kind: "unavailable" }, reco: { kind: "none" }, notBought: null, lost: outRow,
        hourly: null, limitLine: { kind: "unavailable", value: null }, facts: { overLimitHours: [], topReason: null, notBought24: 0, typicalRoom: null }, users: { top: [], others: null }, channels: chRows, finderRoom: {} };
    }
    if (!m) return null;
    const err = m.err;
    const reasons = (i) => ({ rate_limit: err ? err.rl[i] : 0, upstream: err ? err.up[i] : 0, auth_quota: err ? err.auth[i] : 0, other: err ? err.other[i] : 0 });
    const lostAt = (i) => ({ rate_limit: err ? err.fRl[i] : 0, upstream: err ? err.fUp[i] : 0, auth_quota: err ? err.fAuth[i] : 0 }); // 没买到按原因分
    const last24 = grid.last24.map((i) => ({ slotMs: grid.slots[i], hour: grid.wall[i].hour, success: m.S[i], blocked: reasons(i), notBought: err ? err.f[i] : 0, lost: lostAt(i) }));
    const clock = Array.from({ length: 24 }, (_, hour) => {
      const idx = [...grid.last7].filter((i) => grid.wall[i].hour === hour);
      const avg = (get) => (idx.length ? sum(idx.map(get)) / idx.length : 0);
      return { hour, success: round(avg((i) => m.S[i]), 2), blocked: { rate_limit: round(avg((i) => reasons(i).rate_limit), 2), upstream: round(avg((i) => reasons(i).upstream), 2), auth_quota: round(avg((i) => reasons(i).auth_quota), 2), other: round(avg((i) => reasons(i).other), 2) }, lost: { rate_limit: round(avg((i) => lostAt(i).rate_limit), 2), upstream: round(avg((i) => lostAt(i).upstream), 2), auth_quota: round(avg((i) => lostAt(i).auth_quota), 2) }, demand: avg((i) => m.S[i] + (err ? err.f[i] : 0)) };
    });
    // 图下面那句结论要的事实
    const overLimitHours = m.supply.value == null ? [] : clock.filter((c) => c.demand > m.supply.value).map((c) => c.hour);
    const reasonTotals = Object.fromEntries(BLOCKED_REASONS.map((r) => [r, sum(grid.last24.map((i) => reasons(i)[r]))]));
    const topReason = BLOCKED_REASONS.reduce((best, r) => (reasonTotals[r] > (best ? reasonTotals[best] : 0) ? r : best), null);
    const offPeak = clock.filter((c) => !(m.peak?.hours || []).includes(c.hour));
    const typicalRoom = m.supply.value == null || !offPeak.length ? null : round(m.supply.value - mean(offPeak.map((c) => c.demand)), 2);
    // 受影响最多的用户
    const list = (usersByModel.get(name) || []).slice().sort((a, b) => b.requests - a.requests || b.blocked - a.blocked || a.userId - b.userId);
    const top = list.slice(0, HEADROOM.USERS_SHOWN).map((u) => ({ userId: u.userId, name: userInfo(u.userId).name, blocked: u.blocked, blockedRequests: u.requests, key: userInfo(u.userId).key }));
    const rest = list.slice(HEADROOM.USERS_SHOWN);
    // 各渠道的上限和高峰用了多少
    const pIdx = m.pIdx;
    const channelRows = [];
    const seen = new Set();
    for (const c of channels) {
      if (!(c.models || []).includes(name) || seen.has(c.channelId)) continue;
      seen.add(c.channelId);
      const u = unitOfChannel.get(c.channelId);
      const limit = limitQuantity(u.measure);
      const used = pIdx.length ? round(mean(pIdx.map((i) => u.series.success[i])), 2) : null;
      const room = limit.value != null && used != null ? round(Math.max(0, limit.value - used), 2) : null;
      let status = "unmeasured";
      if (c.state === "auto") status = "auto"; else if (c.state === "off") status = "off";
      else if (limit.kind === "measured") status = used != null && used >= limit.value ? "full" : "room";
      channelRows.push({ channelId: c.channelId, name: c.name, upstream: c.upstreamId == null ? null : { id: String(c.upstreamId), name: upstreamName(c.upstreamId) }, state: c.state, limit, peakUsed: used, room, status, lost24: haveErrors ? round(chLostTotal(name, c.channelId), 1) : null, mainCause: haveErrors ? causeOf({ noOpenChannel: false, byReason: chLost.get(`${name}#${c.channelId}`) ?? {} }) : null });
    }
    const finderRoom = {};
    for (const card of cards) if (card.upstreamId != null) finderRoom[card.upstreamId] = card.room;
    return {
      name, peak: m.peak, need: m.need, supply: m.supply, margin: m.margin, reco: m.reco, notBought: m.notBought, lost: m.lost ?? null,
      hourly: m.lost?.estimated ? null : { last24, clock7d: clock.map(({ demand, ...rest2 }) => rest2) }, limitLine: m.supply,
      facts: { overLimitHours, topReason, notBought24: m.notBought ? m.notBought.f24 : 0, typicalRoom },
      users: { top, others: rest.length ? { count: rest.length, blocked: sum(rest.map((u) => u.blocked)), blockedRequests: sum(rest.map((u) => u.requests)) } : null },
      channels: channelRows, finderRoom,
    };
  }
  return { page, detailOf };
}

// 今晚要多少。S：这个模型每小时成交；F：每小时没买到；peak：高峰时段；covered(i)：这个小时错误日志有数；haveErrors：错误日志在读（没开时没买到当 0）
// 返回 { value, growth, basis: "lastWeek" | "second" } 或 null（成交有数的整天不到 NEED_MIN_DAYS 个、没有高峰）
export function needOf({ grid, S, F, peak, covered, haveErrors }) {
  if (!peak) return null;
  const perDay = grid.days.map((day) => {
    const idx = day.idx.filter((i) => peak.hours.includes(grid.wall[i].hour));
    const total = sum(day.idx.map((i) => S[i] + F[i]));
    const hasData = day.idx.some((i) => S[i] > 0);
    const fCovered = !haveErrors || day.idx.every(covered);
    return { key: day.key, demand: idx.length ? mean(idx.map((i) => S[i] + F[i])) : 0, total, hasData, fCovered };
  });
  const usable = perDay.filter((d) => d.hasData);
  if (usable.length < HEADROOM.NEED_MIN_DAYS) return null;
  const lastWeek = perDay[perDay.length - 1]; // 最远的那个整天 = 上周同一天（今天往前数第 7 天）
  let base, basis;
  if (perDay.length === HEADROOM.NEED_DAYS && lastWeek.hasData && lastWeek.fCovered) { base = lastWeek.demand; basis = "lastWeek"; }
  else {
    const ranked = usable.filter((d) => d.fCovered || !haveErrors).map((d) => d.demand).sort((a, b) => b - a);
    const pool = ranked.length >= 2 ? ranked : usable.map((d) => d.demand).sort((a, b) => b - a);
    base = pool.length >= 2 ? pool[1] : pool[0]; basis = "second";
  }
  const g = growthOf(perDay.map((d) => d.total));
  return { value: round(base * g, 2), growth: g, basis };
}

// 涨幅：近 3 天日均 ÷ 前 4 天日均（日均是一整天的成交 + 没买到），限在 GROWTH_MIN–GROWTH_MAX；dayTotals 最近的天在前；前 4 天没有量按 1
export function growthOf(dayTotals) {
  const recent = dayTotals.slice(0, HEADROOM.GROWTH_RECENT_DAYS), before = dayTotals.slice(HEADROOM.GROWTH_RECENT_DAYS, HEADROOM.GROWTH_RECENT_DAYS + HEADROOM.GROWTH_BASE_DAYS);
  const beforeMean = mean(before);
  return round(beforeMean > 0 ? clamp(mean(recent) / beforeMean, HEADROOM.GROWTH_MIN, HEADROOM.GROWTH_MAX) : 1, 4);
}

// 「怎么算的」里的数（页面读这里，不另写一遍）
export function numbersOf() {
  return { needDays: HEADROOM.NEED_DAYS, minAttempts: HEADROOM.MIN_ATTEMPTS, minSuccessShare: HEADROOM.MIN_SUCCESS_SHARE, minRateLimitShare: HEADROOM.MIN_RATE_LIMIT_SHARE,
    limitPercentile: HEADROOM.LIMIT_PERCENTILE, windowDays: HEADROOM.WINDOW_DAYS, growthMin: HEADROOM.GROWTH_MIN, growthMax: HEADROOM.GROWTH_MAX, thinMargin: HEADROOM.THIN_MARGIN };
}
