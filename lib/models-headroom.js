// 模型供需「高峰余量」的算法（模型供需第 1 步，设计 models-v4）：纯函数，输入是已经读好的数（server/models-page.js 读给它），输出是接口的 headroom（形状见 app/(dashboard)/models/headroom-types.ts）。
// 门槛常数都在 HEADROOM 一处，页面上「怎么算的」那段字也读这一处，不另写一遍。只用库里已有的小时计数和自营站点数据看板的按模型小时成交，不碰用户站。
//
// 口径（规格 v2，审核 2 核过）：
//   - 没买到 F = 最终没买到的请求（server/own-error-supply.js，下限）；被挡过 = 被上游拒过的请求（rejectedRequests），只作提醒；被拒不含请求问题。
//   - 上限（按渠道测）：「明显限流小时」= 尝试 ≥ MIN_ATTEMPTS 次、成交 ≥ 这个渠道窗口内最高那个小时的 MIN_SUCCESS_SHARE、429 占这一小时尝试的 MIN_RATE_LIMIT_SHARE 以上并且比 5xx 多；
//     取这些小时成交量的 P75（窗口 WINDOW_DAYS 天），最近 NEED_DAYS × 24 个小时（含今天已过的）里要有这样的小时；没有的写「至少 X」，X 是窗口里最高的那个小时；错误日志读了不到 NEED_DAYS 天写「数据积累中」。
//     渠道的单位是「一把 Key」（同一条绑定下的渠道算一个）；同一家上游的几把 Key 在同一批小时一起被限流，是按账号限的：这几把合成一个，整家算一个上限。
//   - 模型能给多少 = Σ（上限 × 这个模型在它高峰时段占这个渠道成交的份额），只算开着的渠道。
//   - 高峰时段：近 NEED_DAYS 个整天（不含今天）按墙上时钟、按小时平均成交，最高的连续 2–3 小时。
//   - 今晚高峰要多少 = 近 7 天同一时段每小时的（成交 + 没买到），上周同一天的有数就用上周同一天，否则取第二高的那天；× 涨幅（近 3 天日均 ÷ 前 4 天日均，限在 GROWTH_MIN–GROWTH_MAX）。
//   - 余量 = 能给 − 今晚要；负的是缺口。建议按顺序判：先充值、按账号限的换一家、加 Key、上限没测到、余量薄。
import { dayKeyInTz, wallHourOfSlot, zonedParts } from "./business-time.js";

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
  ACCOUNT_MIN_SHARED_HOURS: 2, // 按账号限：两把 Key 至少有这么多个小时同时被明显限流
  ACCOUNT_SHARED_SHARE: 0.5, // 按账号限：同时被限流的小时占较少那把被限流小时的这个比例以上
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
  const { now, tz, errorLog, consume, modelHours, cells, byModelHour, rejectedUsers, usersById = new Map(), channels, upstreams, weekUsd = new Map(), small = new Set() } = input;
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
    let e = errByModel.get(row.model); if (!e) errByModel.set(row.model, e = { f: zeros(n), q: zeros(n), rl: zeros(n), up: zeros(n), auth: zeros(n), other: zeros(n) });
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
  for (const cell of cells || []) {
    const i = grid.indexOf(cell.slotMs);
    if (i < 0) continue;
    const s = seriesFor(cell.channelId);
    s.success[i] += cell.success; s.rl[i] += cell.rejected.rate_limit; s.up[i] += cell.rejected.upstream; s.auth[i] += cell.rejected.auth_quota; s.other[i] += cell.rejected.other; s.rej[i] += cell.rejected.total;
    if (cell.success > 0) { const key = `${cell.channelId}|${cell.model}`; let list = chModel.get(key); if (!list) chModel.set(key, list = []); list.push({ i, success: cell.success }); }
  }
  // Key 单元：同一条绑定的渠道算一个；没绑的各算各的
  const units = new Map();
  for (const c of channels) {
    const key = c.ruleId != null ? `rule:${c.ruleId}` : `ch:${c.channelId}`;
    let u = units.get(key); if (!u) units.set(key, u = { id: key, upstreamId: c.upstreamId ?? null, channels: [], series: seriesOf(n), keys: 1, merged: false });
    u.channels.push(c);
  }
  for (const u of units.values()) for (const c of u.channels) { const s = chSeries.get(c.channelId); if (s) addSeries(u.series, s); }
  for (const u of units.values()) { u.measure = measureLimit(u.series, grid); }
  // 按账号限：同一家上游的几把 Key 一起被限流 → 合成一个
  const byUp = new Map();
  for (const u of units.values()) if (u.upstreamId != null) { let list = byUp.get(u.upstreamId); if (!list) byUp.set(u.upstreamId, list = []); list.push(u); }
  const accountLimited = new Set();
  for (const [upstreamId, list] of byUp) {
    if (list.length < 2) continue;
    const merge = new Set();
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) {
      const A = new Set(list[a].measure.throttled);
      const shared = list[b].measure.throttled.filter((i) => A.has(i)).length;
      const smaller = Math.min(list[a].measure.throttled.length, list[b].measure.throttled.length);
      if (shared >= HEADROOM.ACCOUNT_MIN_SHARED_HOURS && smaller > 0 && shared >= HEADROOM.ACCOUNT_SHARED_SHARE * smaller) { merge.add(list[a]); merge.add(list[b]); }
    }
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
    let margin = { value: null, status: "none" };
    if (need && supply.value != null && state !== "noErrorLog") {
      const value = round(supply.value - need.value, 2);
      let status = "ok";
      if (value < 0) status = supply.kind === "measured" ? "short" : "unknown";
      else if (value < HEADROOM.THIN_MARGIN) status = "thin";
      margin = { value, status };
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
    list.push({ userId: user.userId, blocked: m.rejected.total });
  }
  const userInfo = (userId) => usersById.get(userId) || { name: `#${userId}`, key: false };

  // ----- 行 -----
  const rows = [];
  for (const m of models.values()) {
    m.reco = recoOf(m);
    const keyList = (usersByModel.get(m.name) || []).filter((u) => userInfo(u.userId).key).sort((a, b) => b.blocked - a.blocked || a.userId - b.userId);
    const isSmall = small.has(m.name);
    let group = "ok";
    if (isSmall) group = "small";
    else if (m.margin.status === "short") group = "short";
    else if (m.margin.status === "thin") group = "thin";
    else if (m.margin.status === "unknown" || m.margin.status === "none" || m.reco.kind === "topup") group = "unknown";
    const gapUsdPerHour = m.margin.status === "short" ? round(-m.margin.value * m.revenuePerRequest, 4) : null;
    rows.push({
      name: m.name, weekUsd: weekUsd.get(m.name) ?? 0, group,
      peak: m.peak, need: m.need, supply: m.supply, margin: m.margin,
      keyUsers: haveErrors ? { count: keyList.length, top: keyList.slice(0, HEADROOM.KEY_USERS_SHOWN).map((u) => ({ userId: u.userId, name: userInfo(u.userId).name, blocked: u.blocked })) } : { count: 0, top: [] },
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
  const topupOrder = (c) => (c.actions.includes("topup") ? 0 : c.full ? 1 : 2);
  cards.sort((a, b) => topupOrder(a) - topupOrder(b) || (a.room ?? Infinity) - (b.room ?? Infinity) || String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN"));

  // ----- 顶上三个数 -----
  const short = rows.filter((r) => r.group === "short");
  const worst = short.slice().sort((a, b) => a.margin.value - b.margin.value)[0] || null;
  const topupCards = cards.filter((c) => c.actions.includes("topup")).sort((a, b) => a.hoursLeft - b.hoursLeft);
  const withNb = rows.filter((r) => r.notBought);
  const keyUserIds = new Set();
  for (const user of rejectedUsers || []) if (userInfo(user.userId).key) keyUserIds.add(user.userId);
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
  };

  // ----- 抽屉 -----
  function detailOf(name) {
    const m = models.get(name);
    if (!m) return null;
    const err = m.err;
    const reasons = (i) => ({ rate_limit: err ? err.rl[i] : 0, upstream: err ? err.up[i] : 0, auth_quota: err ? err.auth[i] : 0, other: err ? err.other[i] : 0 });
    const last24 = grid.last24.map((i) => ({ slotMs: grid.slots[i], hour: grid.wall[i].hour, success: m.S[i], blocked: reasons(i), notBought: err ? err.f[i] : 0 }));
    const clock = Array.from({ length: 24 }, (_, hour) => {
      const idx = [...grid.last7].filter((i) => grid.wall[i].hour === hour);
      const avg = (get) => (idx.length ? sum(idx.map(get)) / idx.length : 0);
      return { hour, success: round(avg((i) => m.S[i]), 2), blocked: { rate_limit: round(avg((i) => reasons(i).rate_limit), 2), upstream: round(avg((i) => reasons(i).upstream), 2), auth_quota: round(avg((i) => reasons(i).auth_quota), 2), other: round(avg((i) => reasons(i).other), 2) }, demand: avg((i) => m.S[i] + (err ? err.f[i] : 0)) };
    });
    // 图下面那句结论要的事实
    const overLimitHours = m.supply.value == null ? [] : clock.filter((c) => c.demand > m.supply.value).map((c) => c.hour);
    const reasonTotals = Object.fromEntries(BLOCKED_REASONS.map((r) => [r, sum(grid.last24.map((i) => reasons(i)[r]))]));
    const topReason = BLOCKED_REASONS.reduce((best, r) => (reasonTotals[r] > (best ? reasonTotals[best] : 0) ? r : best), null);
    const offPeak = clock.filter((c) => !(m.peak?.hours || []).includes(c.hour));
    const typicalRoom = m.supply.value == null || !offPeak.length ? null : round(m.supply.value - mean(offPeak.map((c) => c.demand)), 2);
    // 受影响最多的用户
    const list = (usersByModel.get(name) || []).slice().sort((a, b) => b.blocked - a.blocked || a.userId - b.userId);
    const top = list.slice(0, HEADROOM.USERS_SHOWN).map((u) => ({ userId: u.userId, name: userInfo(u.userId).name, blocked: u.blocked, key: userInfo(u.userId).key }));
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
      channelRows.push({ channelId: c.channelId, name: c.name, upstream: c.upstreamId == null ? null : { id: String(c.upstreamId), name: upstreamName(c.upstreamId) }, state: c.state, limit, peakUsed: used, room, status });
    }
    const finderRoom = {};
    for (const card of cards) if (card.upstreamId != null) finderRoom[card.upstreamId] = card.room;
    return {
      name, peak: m.peak, need: m.need, supply: m.supply, margin: m.margin, reco: m.reco, notBought: m.notBought,
      hourly: { last24, clock7d: clock.map(({ demand, ...rest2 }) => rest2) }, limitLine: m.supply,
      facts: { overLimitHours, topReason, notBought24: m.notBought ? m.notBought.f24 : 0, typicalRoom },
      users: { top, others: rest.length ? { count: rest.length, blocked: sum(rest.map((u) => u.blocked)) } : null },
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
  // 涨幅：近 3 天日均 ÷ 前 4 天日均（日均是一整天的成交 + 没买到）
  const recent = perDay.slice(0, HEADROOM.GROWTH_RECENT_DAYS), before = perDay.slice(HEADROOM.GROWTH_RECENT_DAYS, HEADROOM.GROWTH_RECENT_DAYS + HEADROOM.GROWTH_BASE_DAYS);
  const beforeMean = mean(before.map((d) => d.total));
  const growth = beforeMean > 0 ? clamp(mean(recent.map((d) => d.total)) / beforeMean, HEADROOM.GROWTH_MIN, HEADROOM.GROWTH_MAX) : 1;
  const g = round(growth, 4);
  return { value: round(base * g, 2), growth: g, basis };
}

// 「怎么算的」里的数（页面读这里，不另写一遍）
export function numbersOf() {
  return { needDays: HEADROOM.NEED_DAYS, minAttempts: HEADROOM.MIN_ATTEMPTS, minSuccessShare: HEADROOM.MIN_SUCCESS_SHARE, minRateLimitShare: HEADROOM.MIN_RATE_LIMIT_SHARE,
    limitPercentile: HEADROOM.LIMIT_PERCENTILE, windowDays: HEADROOM.WINDOW_DAYS, growthMin: HEADROOM.GROWTH_MIN, growthMax: HEADROOM.GROWTH_MAX, thinMargin: HEADROOM.THIN_MARGIN };
}
