import test from "node:test";
import assert from "node:assert/strict";
import { HEADROOM, buildHeadroom, gridOf, growthOf, hoursUntilHour, measureLimit, needOf, peakOf, percentile } from "./models-headroom.js";
import { failWindow } from "./models-lost.js";

const H = 3600000, DAY = 24 * H;
const NOW = Date.parse("2026-10-20T15:30:00Z"); // 业务时区 UTC：今天是 10-20，近 7 个整天是 10-13 到 10-19
const END = Math.floor(NOW / H) * H;
const TZ = "UTC";
const N = HEADROOM.WINDOW_DAYS * 24;
const slotAt = (k) => END - k * H; // k = 1 是刚过完的那个小时
const hourOf = (slot) => new Date(slot).getUTCHours();

// ---- 造数据 ----
const rejected = (rl = 0, up = 0, auth = 0, other = 0) => ({ rate_limit: rl, upstream: up, auth_quota: auth, other, total: rl + up + auth + other });
// lost：这个格子的最终失败数按原因（queryErrorSupply 按格子分档尝试数算的），不给就是 0
const cell = (slotMs, channelId, model, success, { rl = 0, up = 0, auth = 0, lost = null } = {}) => ({ slotMs, channelId, model, success, rejected: rejected(rl, up, auth), rejectedRequests: rl + up + auth, sampled: 0, finalFailuresByReason: lost ?? { rate_limit: 0, upstream: 0, auth_quota: 0 } });
const mh = (model, t, requests, cost = requests * 0.01) => ({ model, t, requests, cost });
// byReason：这 f 个缺货失败按原因怎么分（不给就都算限流）
const fRow = (slotMs, model, f, { rl = 0, up = 0, auth = 0, q = f, byReason = null } = {}) => ({ slotMs, model, finalFailures: f, finalFailuresByReason: byReason ?? { rate_limit: f, upstream: 0, auth_quota: 0 }, rejected: rejected(rl, up, auth), rejectedRequests: q });
const runway = (days) => ({ days, noSpend: false, fixed: false });
const upstreamsOf = (list) => new Map(list.map(([id, name, days = 30]) => [id, { id, name, runway: runway(days) }]));
const channel = (channelId, extra = {}) => ({ channelId, name: `渠道${channelId}`, state: "on", models: ["m1"], upstreamId: "u1", ruleId: `r${channelId}`, ...extra });
const usable = { switchOn: true, cursor: { coveredFromMs: NOW - 14 * DAY, coveredToMs: NOW }, hasRecords: true };
const consumeOn = { on: true, cursor: { coveredFromMs: NOW - 14 * DAY, coveredToMs: NOW } };

// 一个渠道、一个模型：高峰 20–22 点每小时成交 peakSuccess（被限流 rl 次），别的小时 offSuccess
function steady({ model = "m1", channelId = 1, peakSuccess = 900, offSuccess = 100, rl = 120, f = 0, upPeak = 0, days = 14 } = {}) {
  const modelHours = [], cells = [], byModelHour = [];
  for (let k = 1; k <= days * 24; k += 1) {
    const slot = slotAt(k), hour = hourOf(slot), peak = hour >= 20 && hour <= 22;
    const success = peak ? peakSuccess : offSuccess;
    modelHours.push(mh(model, slot, success));
    cells.push(cell(slot, channelId, model, success, peak ? { rl, up: upPeak, lost: f > 0 ? { rate_limit: f, upstream: 0, auth_quota: 0 } : null } : {}));
    if (peak && f > 0) byModelHour.push(fRow(slot, model, f, { rl: rl, q: f }));
  }
  return { modelHours, cells, byModelHour };
}
const build = (extra = {}) => {
  const base = steady();
  return buildHeadroom({
    now: NOW, tz: TZ, errorLog: usable, consume: consumeOn, ...base, rejectedUsers: [], channels: [channel(1)], upstreams: upstreamsOf([["u1", "上游一"]]),
    weekUsd: new Map([["m1", 100]]), small: new Set(), ...extra,
  });
};
const near = (actual, expected, eps = 0.01) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≠ ${expected}`);
const rowOf = (result, name = "m1") => result.page.rows.find((row) => row.name === name);

test("分位数：最近秩法，p=0.75 取排第 ⌈0.75n⌉ 的那个；空是 null", () => {
  assert.equal(percentile([], 0.75), null);
  assert.equal(percentile([5], 0.75), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.75), 3);
  assert.equal(percentile([4, 1, 3, 2, 5], 0.75), 4, "5 个数排第 4 个");
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80], 0.75), 60);
});

test("时间格子：最近 14 天已经过完的小时，近 7 个整天不含今天，今天单独；夏令时那天 23 / 25 个小时按墙上时钟", () => {
  const grid = gridOf(NOW, TZ);
  assert.equal(grid.n, 336);
  assert.equal(grid.slots[grid.n - 1], END - H);
  assert.deepEqual(grid.days.map((day) => day.key), ["2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"]);
  assert.ok(grid.days.every((day) => day.idx.length === 24 && day.idx.every((i, k) => k === 0 || i > day.idx[k - 1])));
  assert.equal(grid.last7.size, 168);
  assert.equal(grid.last24.length, 24);
  // 洛杉矶：2026-11-01 秋天 25 个小时（1 点重复），2026-03-08 春天 23 个小时
  const la = gridOf(Date.parse("2026-11-03T12:00:00Z"), "America/Los_Angeles");
  const fall = la.days.find((day) => day.key === "2026-11-01");
  assert.equal(fall.idx.length, 25);
  assert.deepEqual(fall.idx.map((i) => la.wall[i].hour).slice(0, 4), [0, 1, 1, 2]);
  const spring = gridOf(Date.parse("2026-03-10T12:00:00Z"), "America/Los_Angeles").days.find((day) => day.key === "2026-03-08");
  assert.equal(spring.idx.length, 23);
});

test("今晚高峰结束还有几小时：下一次出现那个钟点整；高峰已经过了算明晚", () => {
  assert.equal(hoursUntilHour(NOW, TZ, 23), 7.5, "现在 15:30，23 点整还有 7.5 小时");
  assert.equal(hoursUntilHour(NOW, TZ, 15), 23.5, "15 点已经过了：明天 15 点");
  assert.equal(hoursUntilHour(NOW, TZ, 24), 8.5, "24 点 = 0 点");
});

test("高峰时段：近 7 天按钟点平均成交最高的连续 3 小时；两头太低（低于最高那个小时的 70%）就去掉，最短 2 小时；跨午夜", () => {
  const grid = gridOf(NOW, TZ);
  const series = (fn) => { const s = new Array(grid.n).fill(0); for (let i = 0; i < grid.n; i += 1) s[i] = fn(grid.wall[i].hour); return s; };
  assert.deepEqual(peakOf(grid, series((h) => (h >= 20 && h <= 22 ? 100 : 10))), { hours: [20, 21, 22] });
  assert.deepEqual(peakOf(grid, series((h) => ({ 20: 30, 21: 100, 22: 100 })[h] ?? 10)), { hours: [21, 22] }, "20 点只有 30%：去掉");
  assert.deepEqual(peakOf(grid, series((h) => ({ 20: 70, 21: 100, 22: 100 })[h] ?? 10)), { hours: [20, 21, 22] }, "正好 70%：留着（低于才去）");
  assert.deepEqual(peakOf(grid, series((h) => ({ 20: 69.9, 21: 100, 22: 100 })[h] ?? 10)), { hours: [21, 22] });
  assert.deepEqual(peakOf(grid, series((h) => ({ 23: 100, 0: 100, 1: 100 })[h] ?? 10)), { hours: [23, 0, 1] }, "跨午夜");
  assert.deepEqual(peakOf(grid, series((h) => ({ 21: 100, 22: 30, 20: 30 })[h] ?? 10)).hours.length >= 2, true, "最短 2 小时");
  assert.equal(peakOf(grid, new Array(grid.n).fill(0)), null, "近 7 天一单都没有");
  // 只看近 7 天：更早的高峰不算
  const old = new Array(grid.n).fill(0); for (let i = 0; i < 24; i += 1) old[i] = 999;
  assert.equal(peakOf(grid, old), null);
});

// 一个渠道窗口内每小时：success、rl、up、rej
const lim = (rows) => { const n = rows.length, s = { success: new Float64Array(N), rl: new Float64Array(N), up: new Float64Array(N), rej: new Float64Array(N) }; void n; rows.forEach(([i, success, rl = 0, up = 0, rej = rl + up]) => { s.success[N - i] = success; s.rl[N - i] = rl; s.up[N - i] = up; s.rej[N - i] = rej; }); return s; };

test("上限：明显限流小时的门槛——尝试 ≥ 50、成交 ≥ 最高小时的 50%、429 ≥ 5% 且比 5xx 多；取这些小时成交的 P75；各门槛的边界", () => {
  const grid = gridOf(NOW, TZ);
  // 最高小时成交 1000（不限流）；其余 4 个小时 600、700、800、900 都被限流（尝试 ≥ 50、429 占 10%）
  const base = [[100, 1000], [1, 600, 70], [2, 700, 80], [3, 800, 90], [4, 900, 100]];
  assert.deepEqual([measureLimit(lim(base), grid).kind, measureLimit(lim(base), grid).value], ["measured", 800], "P75：4 个数排第 3 个 = 800");
  // 尝试数 49 不算、50 算（成交 + 被拒）
  assert.equal(measureLimit(lim([[100, 1000], [1, 44, 5]]), grid).kind, "atLeast", "尝试 49：成交 44 < 最高小时一半也不算，这里只测尝试数");
  const small = (att) => lim([[1, att - 5, 5, 0, 5]]); // 这个渠道最高小时就是它自己，成交 ≥ 50% 满足
  assert.equal(measureLimit(small(49), grid).kind, "atLeast", "尝试 49 次");
  assert.deepEqual(measureLimit(small(50), grid).kind, "measured", "尝试 50 次，429 占 10%");
  // 成交 ≥ 最高小时的 50%：500 算，499 不算
  const withMax = (success) => lim([[100, 1000], [1, success, 100]]);
  assert.equal(measureLimit(withMax(500), grid).kind, "measured");
  assert.equal(measureLimit(withMax(499), grid).kind, "atLeast");
  // 429 占尝试的 5%：1000 次尝试里 50 个算、49 个不算
  assert.equal(measureLimit(lim([[1, 950, 50]]), grid).kind, "measured", "50/1000 = 5%");
  assert.equal(measureLimit(lim([[1, 951, 49]]), grid).kind, "atLeast");
  // 429 要比 5xx 多：相等不算
  assert.equal(measureLimit(lim([[1, 900, 60, 40]]), grid).kind, "measured");
  assert.equal(measureLimit(lim([[1, 900, 50, 50]]), grid).kind, "atLeast", "429 和 5xx 一样多：不算");
  assert.equal(measureLimit(lim([[1, 900, 40, 60]]), grid).kind, "atLeast", "5xx 更多是上游故障，不是限流");
  // 最近 7 天里要有限流小时：只有 8 天前的限流不算，写「至少」最高成交
  const oldThrottle = measureLimit(lim([[9 * 24, 900, 100], [1, 500]]), grid);
  assert.deepEqual([oldThrottle.kind, oldThrottle.value], ["atLeast", 900]);
  // 没有任何数据
  assert.deepEqual(measureLimit(lim([]), grid), { kind: "atLeast", value: 0, throttled: [] });
});

test("今晚要多少：有上周同一天（错误日志也有数）用上周同一天，否则取近 7 天第二高的那天；× 涨幅（近 3 天 ÷ 前 4 天，限在 0.8–1.25）；成交有数的整天不到 3 个不估", () => {
  const grid = gridOf(NOW, TZ);
  const peak = { hours: [20, 21, 22] };
  const make = (dayDemand) => { // dayDemand[0] 是昨天，[6] 是上周同一天；每天高峰每小时成交这么多，别的小时 10
    const S = new Float64Array(grid.n), F = new Float64Array(grid.n);
    grid.days.forEach((day, d) => day.idx.forEach((i) => { S[i] = dayDemand[d] === 0 ? 0 : peak.hours.includes(grid.wall[i].hour) ? dayDemand[d] : 10; }));
    return { S, F };
  };
  const call = (dayDemand, extra = {}) => { const { S, F } = make(dayDemand); return needOf({ grid, S, F, peak, covered: () => true, haveErrors: true, ...extra }); };
  // 上周同一天（第 7 天）= 700，别的天更高：用它
  const flat = call([1000, 1000, 1000, 1000, 1000, 1000, 700]);
  assert.equal(flat.basis, "lastWeek"); near(flat.value, 700 * flat.growth);
  // 上周同一天的错误日志没有数：取第二高的那天
  const second = call([500, 900, 800, 600, 700, 400, 300], { covered: (i) => i >= grid.days[5].idx[0] });
  assert.equal(second.basis, "second");
  near(second.value, 800 * second.growth, 0.01);
  // 涨幅：近 3 天日均（每天总量差不多是 demand×3 + 21×10）÷ 前 4 天，限幅
  const up = call([2000, 2000, 2000, 1000, 1000, 1000, 1000]);
  assert.equal(up.growth, HEADROOM.GROWTH_MAX, "涨得多：限在 1.25");
  const down = call([100, 100, 100, 1000, 1000, 1000, 1000]);
  assert.equal(down.growth, HEADROOM.GROWTH_MIN, "跌得多：限在 0.8");
  const mild = call([1090, 1090, 1090, 1000, 1000, 1000, 1000]);
  assert.ok(mild.growth > 1.07 && mild.growth < 1.09, `涨幅 ≈ +8%：${mild.growth}`);
  // 前 4 天没有成交：涨幅按 1
  assert.equal(call([1000, 1000, 1000, 0, 0, 0, 0]).growth, 1);
  // 成交有数的整天不到 3 个：不估；没有高峰：不估
  assert.equal(call([1000, 1000, 0, 0, 0, 0, 0]), null);
  assert.equal(needOf({ grid, S: new Float64Array(grid.n), F: new Float64Array(grid.n), peak: null, covered: () => true, haveErrors: true }), null);
  // 没开错误日志：没买到当 0，不用管错误日志有没有数，仍用上周同一天
  assert.equal(call([1000, 1000, 1000, 1000, 1000, 1000, 700], { covered: () => false, haveErrors: false }).basis, "lastWeek");
  // 需求里有没买到：成交 + 没买到
  const { S, F } = make([1000, 1000, 1000, 1000, 1000, 1000, 700]);
  for (const i of grid.days[6].idx) if (peak.hours.includes(grid.wall[i].hour)) F[i] = 50;
  const withF = needOf({ grid, S, F, peak, covered: () => true, haveErrors: true });
  near(withF.value / withF.growth, 750, 0.1);
});

test("能给多少 = 上限 × 这个模型在高峰占这个渠道成交的份额；余量 = 能给 − 今晚要；测到上限且余量为负是缺，建议加 Key：⌈缺口 ÷ 一把 Key 的上限⌉", () => {
  // 渠道 1：高峰每小时成交 900、429 = 120，测到上限 900；高峰没买到 150（每小时）→ 今晚要 1050，缺 150
  const base = steady({ f: 150 });
  const result = build(base);
  const row = rowOf(result);
  assert.equal(result.page.state, "ok");
  assert.deepEqual(row.peak, { hours: [20, 21, 22] });
  assert.deepEqual(row.supply, { kind: "measured", value: 900 });
  assert.deepEqual([row.need.basis, row.need.growth], ["lastWeek", 1]);
  assert.equal(row.need.value, 1050);
  assert.deepEqual(row.margin, { value: -150, status: "short", kind: "measured" }, "缺口的 kind 跟着能给：测到的上限算出来的缺口写「约」");
  assert.equal(row.group, "short");
  assert.deepEqual(row.reco, { kind: "addKeys", n: 1, upstreamId: "u1", name: "上游一", perKey: 900 });
  assert.ok(row.gapUsdPerHour > 0);
  assert.equal(result.page.kpis.willShort.count, 1);
  assert.deepEqual(result.page.kpis.willShort.worst, { name: "m1", gap: 150, peak: { hours: [20, 21, 22] } });
  // 缺口大：N 取整向上（缺 1800、一把 900 → 2 把；缺 1801 → 3 把）
  const big = rowOf(build(steady({ f: 600 })));
  assert.deepEqual([big.margin.value, big.reco.n], [-600, 1]);
  const bigger = rowOf(build({ ...steady({ f: 1000 }) }));
  assert.deepEqual([bigger.margin.value, bigger.reco.n], [-1000, 2]);
});

test("能给：模型占渠道的份额——渠道上两个模型，m1 在高峰占 3/4，能给 = 上限 × 3/4；渠道上限按渠道总成交测，不按模型", () => {
  const a = steady({ model: "m1", peakSuccess: 600, offSuccess: 60, rl: 0 }), b = steady({ model: "m2", peakSuccess: 200, offSuccess: 20, rl: 0 });
  // 渠道总成交高峰 800、429 = 100（尝试 900，11%）：测到上限 800；cells 里每个模型一个格子，429 记在 m1 的格子上
  for (const c of a.cells) if (hourOf(c.slotMs) >= 20 && hourOf(c.slotMs) <= 22) { c.rejected = rejected(100); c.rejectedRequests = 100; }
  const result = build({ modelHours: [...a.modelHours, ...b.modelHours], cells: [...a.cells, ...b.cells], byModelHour: [], channels: [channel(1, { models: ["m1", "m2"] })], weekUsd: new Map([["m1", 60], ["m2", 20]]) });
  assert.deepEqual(rowOf(result, "m1").supply, { kind: "measured", value: 600 }, "800 × 600/800");
  assert.deepEqual(rowOf(result, "m2").supply, { kind: "measured", value: 200 }, "800 × 200/800");
  assert.equal(result.detailOf("m1").channels[0].limit.value, 800);
});

test("没碰到过上限：能给写「至少」（最高小时的成交），余量比要的少时不说缺，是 unknown、建议「上限还没测到」", () => {
  const result = build(steady({ rl: 0, f: 100 }));
  const row = rowOf(result);
  assert.deepEqual(row.supply, { kind: "atLeast", value: 900 });
  assert.deepEqual(row.margin, { value: -100, status: "unknown", kind: "atLeast" }, "能给只是至少：这个差是「最多缺」，不说缺");
  assert.equal(row.group, "unknown");
  assert.deepEqual(row.reco, { kind: "unmeasured" });
  // 要的比下限少：写余，不用测到
  const ok = rowOf(build(steady({ rl: 0 })));
  assert.deepEqual([ok.margin.value, ok.margin.status, ok.group], [0, "thin", "thin"], "能给至少 900、要 900：余 0，薄");
});

test("余量薄（< THIN_MARGIN）和余量够：状态、分组和排法（缺的在前按缺口折钱排，薄的和余的按余量从薄到厚）", () => {
  const specs = [["short-big", 1, 400], ["short-small", 2, 50], ["thin", 3, 0], ["ok", 4, -1]];
  const modelHours = [], cells = [], byModelHour = [], channels = [];
  for (const [name, id, f] of specs) {
    const part = steady({ model: name, channelId: id, peakSuccess: 900, rl: 120, f: f > 0 ? f : 0 });
    modelHours.push(...part.modelHours); cells.push(...part.cells); byModelHour.push(...part.byModelHour);
    channels.push(channel(id, { models: [name], ruleId: `r${id}`, upstreamId: `u${id}` }));
  }
  // thin：能给 900、要 900（余 0）；ok：能给 1500，要 900（余 600 ≥ 500）
  for (const c of cells) if (c.model === "ok") { c.success = 1500; } // 成交 1500 + 429 120：测到上限 1500，需求（成交）也是 1500 → 改成需求低一点见下
  for (const row of modelHours) if (row.model === "ok") row.requests = 900; // 看板上成交 900（需求 900），渠道上 1500（上限 1500）
  const result = build({ modelHours, cells, byModelHour, channels, upstreams: upstreamsOf(specs.map(([, id]) => [`u${id}`, `上游${id}`])), weekUsd: new Map(specs.map(([name], i) => [name, 10 - i])) });
  const order = result.page.rows.map((r) => [r.name, r.group]);
  assert.deepEqual(order, [["short-big", "short"], ["short-small", "short"], ["thin", "thin"], ["ok", "ok"]]);
  assert.equal(rowOf(result, "ok").margin.status, "ok");
  assert.equal(rowOf(result, "ok").margin.value, 600);
  assert.equal(rowOf(result, "thin").margin.value, 0);
});

test("量很小的模型不判（group small，排最后），不进「今晚会缺」", () => {
  const part = steady({ f: 300 });
  const result = build({ ...part, small: new Set(["m1"]) });
  assert.equal(rowOf(result).group, "small");
  assert.equal(result.page.kpis.willShort.count, 0);
});

test("一把 Key 的渠道算一个（去重）：同一条绑定下两个渠道的成交相加测上限；能给不重复加", () => {
  const a = steady({ channelId: 1, peakSuccess: 500, rl: 0 }), b = steady({ channelId: 2, peakSuccess: 400, rl: 0 });
  for (const c of [...a.cells, ...b.cells]) if (hourOf(c.slotMs) >= 20 && hourOf(c.slotMs) <= 22) { c.rejected = rejected(c.channelId === 1 ? 100 : 0); }
  const same = build({ modelHours: a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests })), cells: [...a.cells, ...b.cells], byModelHour: [],
    channels: [channel(1, { ruleId: "r-shared" }), channel(2, { ruleId: "r-shared" })] });
  assert.equal(same.page.upstreams[0].limit.value, 900, "一把 Key：500 + 400 一起测，上限 900，不是 500 + 400 各测各的加起来");
  assert.equal(rowOf(same).supply.value, 900);
});

test("按账号限：同一家上游的两把 Key 在同一批小时一起被限流 → 合成一个，整家一个上限；缺时建议「换一家，或找它提额度」", () => {
  const a = steady({ channelId: 1, peakSuccess: 500, rl: 70, f: 200 }), b = steady({ channelId: 2, peakSuccess: 400, rl: 60 });
  const result = build({
    modelHours: a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests })), cells: [...a.cells, ...b.cells], byModelHour: a.byModelHour,
    channels: [channel(1), channel(2)], upstreams: upstreamsOf([["u1", "上游一"]]),
  });
  const card = result.page.upstreams[0];
  assert.equal(card.accountLimited, true);
  assert.deepEqual(card.limit, { kind: "measured", value: 900 }, "两把 Key 一起：整家 900（不是 500 + 400 分别测的和）");
  const row = rowOf(result);
  assert.deepEqual(row.reco, { kind: "switch", upstreamId: "u1", name: "上游一", keys: 2 });
  assert.equal(row.margin.status, "short");
  // 两把 Key 在不同的小时被限流：各算各的，不是按账号限
  const c = steady({ channelId: 1, peakSuccess: 500, rl: 70 }), d = steady({ channelId: 2, peakSuccess: 400, rl: 0 });
  for (const cellItem of d.cells) { const hour = hourOf(cellItem.slotMs); if (hour === 3) { cellItem.success = 400; cellItem.rejected = rejected(60); } }
  const split = build({ modelHours: c.modelHours.map((row2, i) => ({ ...row2, requests: row2.requests + d.modelHours[i].requests })), cells: [...c.cells, ...d.cells], byModelHour: [], channels: [channel(1), channel(2)] });
  assert.equal(split.page.upstreams[0].accountLimited, false);
});

test("按账号限的边界：共同被限的小时 ≥ 2、占两把各自被限小时的 80% 以上、「一把被限另一把干净」的小时不超过两把被限小时并集的 10%，三条都满足才合成一个", () => {
  // 每把 Key 每小时成交 500：被限的小时 429 = 60（占尝试 10.7%），「中间」的小时 429 = 10（占 2%，既不算被限也不算干净），别的小时干净（0）
  const twoKeys = (a, b, { midA = [], midB = [] } = {}) => {
    const modelHours = [], cells = [];
    for (let k = 1; k <= 336; k += 1) {
      const slot = slotAt(k), rl = (limited, mid) => (limited.has(k) ? 60 : mid.has(k) ? 10 : 0);
      modelHours.push(mh("m1", slot, 1000));
      cells.push(cell(slot, 1, "m1", 500, { rl: rl(a, new Set(midA)) }), cell(slot, 2, "m1", 500, { rl: rl(b, new Set(midB)) }));
    }
    return build({ modelHours, cells, byModelHour: [], channels: [channel(1), channel(2)] }).page.upstreams[0].accountLimited;
  };
  const set = (...values) => new Set(values);
  const range = (from, to) => set(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
  assert.equal(twoKeys(set(1, 2), set(1, 2)), true, "同时被限 2 个小时，没有反证");
  assert.equal(twoKeys(set(1, 50), set(1, 51), { midA: [51], midB: [50] }), false, "只同时 1 个小时");
  // 80%：A 被限 1–5、B 被限 1–4 和 6；共同 4 个 = 各自的 80%（边界算）。非共同的小时对方是「中间」，没有反证
  assert.equal(twoKeys(range(1, 5), set(1, 2, 3, 4, 6), { midA: [6], midB: [5] }), true, "共同的占各自的 80%：算");
  assert.equal(twoKeys(range(1, 5), set(1, 2, 3, 6, 7), { midA: [6, 7], midB: [4, 5] }), false, "共同 3 个只占 60%");
  // 反证 ≤ 10%：共同 10 个小时，A 另外有 1 个小时被限而 B 干净 → 1 / 11 = 9.1%：算；A、B 各另外 1 个 → 2 / 12 = 16.7%：不算
  assert.equal(twoKeys(range(1, 11), range(1, 10)), true, "反证 1/11");
  assert.equal(twoKeys(range(1, 11), set(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12)), false, "反证 2/12");
});

test("两把 Key 各自独立限额（100 和 150）：高峰大家一起被限，但肩部小时一把被限另一把干净，不是按账号限；缺时建议加 Key，不是换一家", () => {
  const modelHours = [], cells = [], byModelHour = [];
  const demand = (hour) => ({ 18: 120, 19: 140, 20: 400, 21: 400, 22: 400, 23: 140 })[hour] ?? 50; // 每把 Key 收到的请求（次/小时）
  for (let k = 1; k <= 336; k += 1) {
    const slot = slotAt(k), hour = hourOf(slot), d = demand(hour);
    const a = Math.min(d, 100), b = Math.min(d, 150);
    modelHours.push(mh("m1", slot, a + b));
    cells.push(cell(slot, 1, "m1", a, { rl: d - a }), cell(slot, 2, "m1", b, { rl: d - b }));
    if (hour >= 20 && hour <= 22) byModelHour.push(fRow(slot, "m1", 150, { rl: d - a + d - b }));
  }
  const result = build({ modelHours, cells, byModelHour, channels: [channel(1), channel(2)] });
  assert.equal(result.page.upstreams[0].accountLimited, false, "不是按账号限");
  assert.deepEqual(result.page.upstreams[0].limit, { kind: "measured", value: 250 }, "两把各测各的：100 + 150");
  const row = rowOf(result);
  assert.equal(row.margin.status, "short");
  assert.equal(row.reco.kind, "addKeys", "建议加 Key，不是换一家");
  assert.deepEqual([row.reco.n, row.reco.perKey], [2, 125], "缺口 150 ÷ 一把 Key 的上限中位数 125 → 2 把");
});

test("余量薄：测到上限、余量在 0 到 500 之间，建议「余量很薄，留意」，分组 thin；余量够的没有建议", () => {
  const thin = rowOf(build(steady()));
  assert.deepEqual([thin.margin.status, thin.group, thin.reco], ["thin", "thin", { kind: "thin" }]);
  const modelHours = [], cells = [];
  for (let k = 1; k <= 336; k += 1) { const slot = slotAt(k), peak = hourOf(slot) >= 20 && hourOf(slot) <= 22; modelHours.push(mh("m1", slot, peak ? 400 : 100)); cells.push(cell(slot, 1, "m1", peak ? 900 : 100, peak ? { rl: 120 } : {})); }
  const roomy = rowOf(build({ modelHours, cells, byModelHour: [] }));
  assert.deepEqual([roomy.margin.value, roomy.margin.status, roomy.group, roomy.reco], [500, "ok", "ok", { kind: "none" }], "余量正好 500：够（少于 500 才算薄）");
});

test("先充值：这个模型的货主要来自的上游余额撑不到今晚高峰结束（现在 15:30、高峰 20–22 点、结束 23 点还有 7.5 小时），排在别的建议前面", () => {
  const part = steady({ f: 150 });
  const result = build({ ...part, upstreams: upstreamsOf([["u1", "上游一", 5 / 24]]) }); // 还能撑 5 小时
  assert.deepEqual(rowOf(result).reco, { kind: "topup", upstreamId: "u1", name: "上游一", hoursLeft: 5 });
  assert.deepEqual(result.page.kpis.topup, { count: 1, first: { upstreamId: "u1", name: "上游一", hoursLeft: 5 } });
  assert.deepEqual(result.page.upstreams[0].actions.includes("topup"), true);
  // 刚好撑到结束（7.5 小时）：不算撑不到
  const enough = build({ ...part, upstreams: upstreamsOf([["u1", "上游一", 7.5 / 24]]) });
  assert.notEqual(rowOf(enough).reco.kind, "topup");
  assert.equal(enough.page.kpis.topup.count, 0);
  // 没有花费、固定成本、读不到：不判
  const none = build({ ...part, upstreams: new Map([["u1", { id: "u1", name: "上游一", runway: { days: null, noSpend: true, fixed: false } }]]) });
  assert.notEqual(rowOf(none).reco.kind, "topup");
});

test("上游卡片：上限（各 Key 相加）、高峰用了、空多少、满了；动作：加 Key、调权重；被挡按原因", () => {
  const u1 = steady({ channelId: 1, peakSuccess: 900, rl: 120 }), u2 = steady({ model: "m2", channelId: 2, peakSuccess: 600, rl: 0, offSuccess: 30 });
  for (const c of u2.cells) if (hourOf(c.slotMs) === 21) { c.success = 900; c.rejected = rejected(120); }
  for (const row of u2.modelHours) if (hourOf(row.t) === 21) row.requests = 900;
  const u3 = steady({ model: "m3", channelId: 3, peakSuccess: 300, rl: 0, offSuccess: 30 });
  const result = build({
    modelHours: [...u1.modelHours, ...u2.modelHours, ...u3.modelHours], cells: [...u1.cells, ...u2.cells, ...u3.cells], byModelHour: [],
    channels: [channel(1), channel(2, { upstreamId: "u2", ruleId: "r2", models: ["m2"] }), channel(3, { upstreamId: "u3", ruleId: "r3", models: ["m3"] })], upstreams: upstreamsOf([["u1", "上游一"], ["u2", "上游二"], ["u3", "上游三"]]),
    weekUsd: new Map([["m1", 100], ["m2", 10], ["m3", 5]]),
  });
  const card1 = result.page.upstreams.find((c) => c.upstreamId === "u1"), card2 = result.page.upstreams.find((c) => c.upstreamId === "u2"), card3 = result.page.upstreams.find((c) => c.upstreamId === "u3");
  assert.deepEqual(card1.limit, { kind: "measured", value: 900 });
  assert.equal(card1.peakUsed, 900);
  assert.equal(card1.full, true, "高峰用了 900 ≥ 上限 900");
  assert.deepEqual(card1.actions, ["addKey", "weights"], "满了：加 Key；别家有空：调权重");
  assert.deepEqual(card2.limit, { kind: "measured", value: 900 }, "只有 21 点被限流：测到 900");
  assert.deepEqual([card2.peakUsed, card2.room, card2.full], [700, 200, false], "高峰平均用了 (600 + 900 + 600) / 3 = 700，空 200");
  assert.deepEqual(card3.limit, { kind: "atLeast", value: 300 }, "从没被限流：至少");
  assert.equal(card3.room, 0, "至少 300、高峰用了 300：空 0（下限）");
  assert.deepEqual(card1.blocked24, { rate_limit: 360, upstream: 0, auth_quota: 0, other: 0 }, "近 24 小时：20–22 点三个小时各 120 次限流");
  assert.deepEqual(card1.models, { count: 1, names: ["m1"] });
  assert.equal(result.page.upstreams[0].upstreamId, "u1", "满了的排前面");
});

test("没开错误日志：能给 unavailable、余量 none、没买到 null、建议只给充值（撑得到就是上限还没测到）；今晚要多少照常（只看成交）", () => {
  const part = steady({ f: 0 });
  const off = build({ ...part, errorLog: { switchOn: false, cursor: null, hasRecords: false } });
  assert.deepEqual([off.page.state, off.page.noErrorLogReason], ["noErrorLog", "switchOff"]);
  const row = rowOf(off);
  assert.deepEqual(row.supply, { kind: "unavailable", value: null });
  assert.deepEqual(row.margin, { value: null, status: "none", kind: "unavailable" });
  assert.equal(row.notBought, null);
  assert.equal(row.need.basis, "lastWeek");
  assert.deepEqual(row.reco, { kind: "unmeasured" });
  assert.equal(off.page.kpis.willShort, null);
  assert.equal(off.page.kpis.notBought, null);
  assert.equal(off.page.upstreams[0].blocked24, null);
  assert.equal(off.page.upstreams[0].limit.kind, "unavailable");
  // 开着，读了 3 天一条错误都没有：noRecords
  const quiet = build({ ...part, errorLog: { switchOn: true, cursor: { coveredFromMs: NOW - 3 * DAY, coveredToMs: NOW }, hasRecords: false } });
  assert.deepEqual([quiet.page.state, quiet.page.noErrorLogReason], ["noErrorLog", "noRecords"]);
  // 开着但一条错误都没有：能给照样写「至少 X」（最高成交量是真的），余量、没买到、被挡写「—」（分不清是没开还是真没有）
  const quietRow = rowOf(quiet);
  assert.deepEqual(quietRow.supply, { kind: "atLeast", value: 900 });
  assert.deepEqual(quietRow.margin, { value: null, status: "none", kind: "atLeast" });
  assert.equal(quietRow.notBought, null);
  assert.equal(quiet.page.kpis.notBought, null);
  assert.equal(quiet.page.kpis.willShort, null);
  assert.equal(quiet.page.upstreams[0].blocked24, null);
  assert.deepEqual(quiet.page.upstreams[0].limit, { kind: "atLeast", value: 900 });
  assert.equal(quietRow.group, "unknown");
  assert.equal(quiet.detailOf("m1").limitLine.kind, "atLeast");
  // 刚开不到 1 天：还在积累，不当成没开
  const fresh = build({ ...part, errorLog: { switchOn: true, cursor: { coveredFromMs: NOW - 3 * H, coveredToMs: NOW }, hasRecords: false } });
  assert.equal(fresh.page.state, "accumulating");
  // 撑不到今晚：照样给充值
  const pay = build({ ...part, errorLog: { switchOn: false, cursor: null, hasRecords: false }, upstreams: upstreamsOf([["u1", "上游一", 1 / 24]]) });
  assert.equal(rowOf(pay).reco.kind, "topup");
});

test("数据积累中：错误日志读了不到 7 天，能给 accumulating、余量 none、还差几天；没买到、被挡照常；没开整站消费日志：能给 unavailable", () => {
  const part = steady({ f: 100 });
  const accum = build({ ...part, errorLog: { switchOn: true, cursor: { coveredFromMs: NOW - 3 * DAY, coveredToMs: NOW }, hasRecords: true } });
  assert.equal(accum.page.state, "accumulating");
  assert.deepEqual(accum.page.errorLog, { coveredDays: 3, needDays: 7, daysLeft: 4 });
  const row = rowOf(accum);
  assert.deepEqual(row.supply, { kind: "accumulating", value: null });
  assert.equal(row.margin.status, "none");
  assert.ok(row.notBought.f24 > 0);
  assert.equal(accum.page.upstreams[0].limit.kind, "accumulating");
  assert.equal(accum.page.kpis.willShort, null);
  // 整站消费日志没开：每个渠道每小时成交没有，能给 unavailable；今晚要、没买到照常
  const noConsume = build({ ...part, consume: { on: false, cursor: null } });
  assert.equal(noConsume.page.consumeLog, false);
  assert.deepEqual(rowOf(noConsume).supply, { kind: "unavailable", value: null });
  assert.ok(rowOf(noConsume).need);
  assert.equal(noConsume.page.kpis.willShort, null);
  // 错误日志和整站消费日志都要满 7 天：取少的那个
  const lag = build({ ...part, consume: { on: true, cursor: { coveredFromMs: NOW - 2 * DAY, coveredToMs: NOW } } });
  assert.deepEqual([lag.page.state, lag.page.errorLog.coveredDays], ["accumulating", 2]);
});

test("没买到：近 24 小时 F 加总（至少）；被挡过后靠重试买到 = 被挡过的请求 − F，不小于 0；至少少收 = F × 同模型同一小时的平均每次收入", () => {
  const modelHours = [], cells = [], byModelHour = [];
  for (let k = 1; k <= 14 * 24; k += 1) {
    const slot = slotAt(k);
    modelHours.push(mh("m1", slot, 100, k === 1 ? 5 : 1)); // 最近这个小时成交 100，收入 $5（每次 $0.05），别的小时每次 $0.01
    cells.push(cell(slot, 1, "m1", 100));
    if (k === 1) byModelHour.push(fRow(slot, "m1", 10, { rl: 40, q: 30 })); // 被挡过的请求 30、没买到 10
    if (k === 2) byModelHour.push(fRow(slot, "m1", 4, { rl: 3, q: 2 })); // 被挡过的请求 2 < F 4：靠重试买到的按 0 算
  }
  const result = build({ modelHours, cells, byModelHour });
  const nb = rowOf(result).notBought;
  assert.equal(nb.f24, 14);
  assert.ok(Math.abs(nb.lostUsd - (10 * 0.05 + 4 * 0.01)) < 1e-9, `${nb.lostUsd}`);
  assert.equal(nb.blockedRetried, 30 + 2 - 14, "32 个被挡过的请求，14 个最终没买到：18 个重试买到了");
  assert.deepEqual(result.page.kpis.notBought, { f24: 14, lostUsd: nb.lostUsd, blockedRetried: 18, keyUsers: 0 });
});

test("受影响的重点用户：近 24 小时被挡过的重点用户（点名字、按被挡次数）；抽屉里受影响最多的前 5 个，其余合成「其他 N 个人」", () => {
  const rejectedUsers = Array.from({ length: 8 }, (_, i) => ({ userId: i + 1, rejected: rejected(10 - i), rejectedRequests: 1, byModel: [{ model: "m1", rejected: rejected(10 - i), rejectedRequests: 1 }] }));
  rejectedUsers.push({ userId: 99, rejected: rejected(5), rejectedRequests: 1, byModel: [{ model: "other", rejected: rejected(5), rejectedRequests: 1 }] });
  const usersById = new Map([[2, { name: "小王", key: true }], [7, { name: "老李", key: true }], [1, { name: "普通用户", key: false }], [99, { name: "别的模型的重点", key: true }]]);
  const result = build({ ...steady(), rejectedUsers, usersById });
  const row = rowOf(result);
  assert.deepEqual(row.keyUsers, { count: 2, top: [{ userId: 2, name: "小王", blocked: 9, blockedRequests: 1 }, { userId: 7, name: "老李", blocked: 4, blockedRequests: 1 }] }, "只算这个模型的重点用户，先按被挡过的请求数、再按被挡次数");
  assert.equal(result.page.kpis.notBought.keyUsers, 3, "全站被挡过的重点用户 3 个（含别的模型的）");
  const detail = result.detailOf("m1");
  assert.deepEqual(detail.users.top.map((u) => [u.userId, u.name, u.blocked, u.key]), [[1, "普通用户", 10, false], [2, "小王", 9, true], [3, "#3", 8, false], [4, "#4", 7, false], [5, "#5", 6, false]]);
  assert.deepEqual(detail.users.others, { count: 3, blocked: 5 + 4 + 3, blockedRequests: 3 });
  assert.ok(detail.users.top.every((u) => u.blockedRequests === 1), "被挡过的请求数（firstCount）单独一个字段 blockedRequests，页面写「受影响 N 次」用它");
});

test("抽屉：近 24 小时每小时成交和按原因分的被挡、近 7 天按钟点平均、上限线、结论的事实、各渠道的上限和高峰空多少、找货的高峰空约", () => {
  const part = steady({ f: 150 });
  for (const row of part.byModelHour) row.rejected = rejected(100, 20, 10);
  const result = build({ ...part, channels: [channel(1), channel(2, { upstreamId: "u2", ruleId: "r2", models: ["m1"], state: "auto" })], upstreams: upstreamsOf([["u1", "上游一"], ["u2", "上游二"]]) });
  const d = result.detailOf("m1");
  assert.equal(d.hourly.last24.length, 24);
  assert.deepEqual(d.hourly.last24.map((p) => p.hour).slice(0, 3), [15, 16, 17], "最近 24 个小时：昨天 15 点起");
  const peakPoint = d.hourly.last24.find((p) => p.hour === 21);
  assert.deepEqual([peakPoint.success, peakPoint.blocked, peakPoint.notBought], [900, { rate_limit: 100, upstream: 20, auth_quota: 10, other: 0 }, 150]);
  assert.equal(d.hourly.clock7d.length, 24);
  assert.deepEqual(d.hourly.clock7d[21], { hour: 21, success: 900, blocked: { rate_limit: 100, upstream: 20, auth_quota: 10, other: 0 }, lost: { rate_limit: 150, upstream: 0, auth_quota: 0 } }, "近 7 天每天 21 点没买到 150，全是限流");
  assert.deepEqual(peakPoint.lost, { rate_limit: 150, upstream: 0, auth_quota: 0 });
  assert.deepEqual(d.limitLine, { kind: "measured", value: 900 });
  assert.deepEqual(d.facts.overLimitHours, [20, 21, 22], "需求 1050 > 上限 900 的钟点");
  assert.equal(d.facts.topReason, "rate_limit");
  assert.equal(d.facts.notBought24, 450, "近 24 小时：20–22 点三个小时各 150");
  assert.ok(d.facts.typicalRoom > 700, `平时的余量 ≈ 900 − 100：${d.facts.typicalRoom}`);
  assert.deepEqual(d.channels.map((c) => [c.channelId, c.status]), [[1, "full"], [2, "auto"]]);
  assert.deepEqual(d.channels[0].limit, { kind: "measured", value: 900 });
  assert.equal(d.channels[0].peakUsed, 900);
  assert.deepEqual(Object.keys(d.finderRoom).sort(), ["u1"], "找货帮手：有渠道的上游给高峰空多少");
  assert.equal(d.finderRoom.u1, 0);
});

test("夏令时：洛杉矶秋天那天 25 个小时、重复的 1 点；高峰、今晚要、上限按墙上时钟的钟点算", () => {
  const tz = "America/Los_Angeles", now = Date.parse("2026-11-03T20:00:00Z"); // 洛杉矶 11-03 12:00
  const end = Math.floor(now / H) * H;
  const modelHours = [], cells = [];
  for (let k = 1; k <= 14 * 24; k += 1) {
    const slot = end - k * H, hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(slot));
    const peak = hour >= 20 && hour <= 22, success = peak ? 900 : 100;
    modelHours.push(mh("m1", slot, success)); cells.push(cell(slot, 1, "m1", success, peak ? { rl: 120 } : {}));
  }
  const result = buildHeadroom({ now, tz, errorLog: { switchOn: true, cursor: { coveredFromMs: now - 14 * DAY, coveredToMs: now }, hasRecords: true }, consume: { on: true, cursor: { coveredFromMs: now - 14 * DAY, coveredToMs: now } },
    modelHours, cells, byModelHour: [], rejectedUsers: [], channels: [channel(1)], upstreams: upstreamsOf([["u1", "上游一"]]), weekUsd: new Map([["m1", 1]]) });
  const row = rowOf(result);
  assert.deepEqual(row.peak, { hours: [20, 21, 22] });
  near(row.need.value, 900, 9); // 11-01 那天 25 个小时，日总量多一小时，涨幅比 1 略大（<1%）
  assert.deepEqual(row.supply, { kind: "measured", value: 900 });
  const clock = result.detailOf("m1").hourly.clock7d;
  assert.equal(clock[1].success, 100, "1 点（重复的那个钟点，两个小时的平均）");
  assert.equal(clock[21].success, 900);
});

test("规则的数都在 HEADROOM 一处，页面读 numbers", () => {
  const result = build();
  assert.deepEqual(result.page.numbers, { needDays: 7, minAttempts: 50, minSuccessShare: 0.5, minRateLimitShare: 0.05, limitPercentile: 0.75, windowDays: 14, growthMin: 0.8, growthMax: 1.25, thinMargin: 500 });
  assert.ok(Object.isFrozen(HEADROOM));
});

// ================= v5：近 24 小时缺货失败 =================
const lostWorld = (specs, { channels, upstreams, errorLog, consume } = {}) => {
  // specs：[{ model, channelId, upstreamId, f: 每个高峰小时没买到, byReason, success, rl }]，每个模型一个渠道（各自一家上游）
  const modelHours = [], cells = [], byModelHour = [];
  for (const spec of specs) {
    const part = steady({ model: spec.model, channelId: spec.channelId, peakSuccess: spec.success ?? 900, rl: spec.rl ?? 120, f: spec.f ?? 0 });
    modelHours.push(...part.modelHours); cells.push(...part.cells.map((c) => (spec.byReason && c.finalFailuresByReason.rate_limit > 0 ? { ...c, finalFailuresByReason: spec.byReason } : c)));
    for (const row of part.byModelHour) byModelHour.push(spec.byReason ? { ...row, finalFailuresByReason: spec.byReason, rejected: spec.rejected ?? row.rejected } : row);
  }
  return buildHeadroom({
    now: NOW, tz: TZ, errorLog: errorLog ?? usable, consume: consume ?? consumeOn, modelHours, cells, byModelHour, rejectedUsers: [],
    channels: channels ?? specs.map((spec) => channel(spec.channelId, { models: [spec.model], upstreamId: spec.upstreamId ?? `u${spec.channelId}`, ruleId: `r${spec.channelId}` })),
    upstreams: upstreams ?? upstreamsOf(specs.map((spec) => [spec.upstreamId ?? `u${spec.channelId}`, `上游${spec.channelId}`])),
    weekUsd: new Map(specs.map((spec, i) => [spec.model, 100 - i])), small: new Set(),
  });
};
const round1 = (value) => Math.round(value * 10) / 10;
const lostOf = (result, name) => result.page.lost.rows.find((row) => row.name === name);

test("缺货失败主表：只列近 24 小时有缺货失败的模型，少收的钱从多到少排；没有失败的数进 quietCount；顶上的数是各行加起来", () => {
  const result = lostWorld([{ model: "a", channelId: 1, f: 50 }, { model: "b", channelId: 2, f: 200 }, { model: "c", channelId: 3, f: 0 }, { model: "d", channelId: 4, f: 0 }]);
  const lost = result.page.lost;
  assert.equal(lost.status, "ok");
  assert.deepEqual(lost.rows.map((row) => [row.name, row.lost24]), [["b", 600], ["a", 150]], "近 24 小时 20–22 点各一次：b 每小时 200 × 3，a 50 × 3；少收多的在前");
  assert.ok(lost.rows[0].lostMoney24 > lost.rows[1].lostMoney24);
  assert.equal(lost.quietCount, 2);
  assert.deepEqual(lost.kpis.last24, { lost: 750, lostUsd: lost.rows[0].lostMoney24 + lost.rows[1].lostMoney24, keyUsers: 0, outOfStockCount: 0 });
  assert.equal(lost.rows[0].weekUsd, 99);
});

test("缺货失败：主要原因按缺货失败的原因拆，一样多时 没钱 > 限流 > 故障；没有开着的渠道是「没渠道」（不管有没有失败原因）", () => {
  const by = (rate_limit, upstream, auth_quota) => ({ rate_limit, upstream, auth_quota });
  const result = lostWorld([
    { model: "limit", channelId: 1, f: 60, byReason: by(40, 15, 5) }, { model: "fault", channelId: 2, f: 60, byReason: by(5, 40, 15) },
    { model: "money", channelId: 3, f: 60, byReason: by(5, 15, 40) }, { model: "tie", channelId: 4, f: 60, byReason: by(20, 20, 20) },
    { model: "tie2", channelId: 5, f: 60, byReason: by(30, 30, 0) },
  ]);
  const cause = (name) => lostOf(result, name).mainCause;
  assert.deepEqual(["limit", "fault", "money", "tie", "tie2"].map(cause), ["rate_limit", "upstream", "auth_quota", "auth_quota", "rate_limit"]);
  // 没渠道：这个模型的渠道全停了
  const none = lostWorld([{ model: "gone", channelId: 1, f: 60, byReason: by(60, 0, 0) }], { channels: [channel(1, { models: ["gone"], state: "off" })] });
  assert.equal(lostOf(none, "gone").mainCause, "no_channel");
  assert.deepEqual(lostOf(none, "gone").reco, { kind: "openChannel" });
});

test("缺货失败的拆分和 F 对得上：各原因的缺货失败加起来就是 lost24", () => {
  const result = lostWorld([{ model: "m1", channelId: 1, f: 90, byReason: { rate_limit: 30, upstream: 40, auth_quota: 20 } }]);
  const d = result.detailOf("m1");
  assert.equal(lostOf(result, "m1").lost24, 270);
  const sumReasons = d.hourly.last24.reduce((total, point) => total + point.lost.rate_limit + point.lost.upstream + point.lost.auth_quota, 0);
  assert.equal(sumReasons, 270, "抽屉每小时按原因分的加起来 = lost24");
  assert.deepEqual(d.hourly.last24.find((point) => point.hour === 21).lost, { rate_limit: 30, upstream: 40, auth_quota: 20 });
  assert.equal(d.lost.lost24, 270);
  assert.equal(lostWorld([{ model: "m1", channelId: 1, f: 0 }]).detailOf("m1").lost, null, "没有失败：抽屉里 lost 是 null");
});

test("缺货失败：失败最多的那家上游 = 主要原因的被拒次数最多的上游；渠道没绑上游就没有", () => {
  const a = steady({ channelId: 1, peakSuccess: 500, rl: 60, f: 100 }), b = steady({ channelId: 2, peakSuccess: 500, rl: 20, f: 0 });
  const modelHours = a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests }));
  const cells = [...a.cells, ...b.cells], byModelHour = a.byModelHour;
  const build2 = (channels) => buildHeadroom({ now: NOW, tz: TZ, errorLog: usable, consume: consumeOn, modelHours, cells, byModelHour, rejectedUsers: [], channels, upstreams: upstreamsOf([["u1", "甲"], ["u2", "乙"]]), weekUsd: new Map([["m1", 1]]), small: new Set() });
  const row = lostOf(build2([channel(1, { upstreamId: "u1" }), channel(2, { upstreamId: "u2" })]), "m1");
  assert.deepEqual(row.mainUpstream, { upstreamId: "u1", name: "甲" }, "渠道 1 被限流 60 次/小时，渠道 2 只有 20 次");
  assert.equal(lostOf(build2([channel(1, { upstreamId: null, ruleId: null }), channel(2, { upstreamId: "u2" })]), "m1").mainUpstream, null, "最多的是没绑上游的渠道：没有");
});

test("缺货失败：失败最多的时段是连续最多 3 小时、两头太低的去掉、可以跨午夜；没有失败是 null", () => {
  const hoursOf = (map) => Array.from({ length: 24 }, (_, i) => ({ hour: (15 + i) % 24, f: map[(15 + i) % 24] ?? 0 }));
  assert.deepEqual(failWindow(hoursOf({ 20: 10, 21: 10, 22: 10 })), { hours: [20, 21, 22] });
  assert.deepEqual(failWindow(hoursOf({ 20: 3, 21: 10, 22: 10 })), { hours: [21, 22] }, "20 点只有 30%：去掉");
  assert.deepEqual(failWindow(hoursOf({ 20: 7, 21: 10, 22: 10 })), { hours: [20, 21, 22] }, "正好 70%：留着");
  assert.deepEqual(failWindow(hoursOf({ 23: 10, 0: 10, 1: 10 })), { hours: [23, 0, 1] }, "跨午夜");
  assert.deepEqual(failWindow(hoursOf({ 21: 10 })), { hours: [21] }, "只有一个小时");
  assert.equal(failWindow(hoursOf({})), null);
  const result = lostWorld([{ model: "m1", channelId: 1, f: 50 }]);
  assert.deepEqual(lostOf(result, "m1").peakFailHours, { hours: [20, 21, 22] });
});

test("明天预计 = 近 24 小时缺货失败 × 涨幅（近 3 天 ÷ 前 4 天，限在 0.8–1.25）；涨幅算不出按 1", () => {
  assert.equal(growthOf([100, 100, 100, 100, 100, 100, 100]), 1);
  assert.equal(growthOf([200, 200, 200, 100, 100, 100, 100]), 1.25, "涨得多：限在 1.25");
  assert.equal(growthOf([50, 50, 50, 100, 100, 100, 100]), 0.8, "跌得多：限在 0.8");
  assert.equal(growthOf([109, 109, 109, 100, 100, 100, 100]), 1.09);
  assert.equal(growthOf([100, 100, 100]), 1, "前 4 天没有量");
  assert.equal(growthOf([]), 1);
  // 整条链：近 3 个整天（10-19、18、17）成交 109，更早 100，近 24 小时缺货失败 450 → 明天约 490.5
  const modelHours = [], cells = [], byModelHour = [];
  for (let k = 1; k <= 336; k += 1) {
    const slot = slotAt(k), success = slot >= Date.parse("2026-10-17T00:00:00Z") ? 109 : 100;
    modelHours.push(mh("m1", slot, success)); cells.push(cell(slot, 1, "m1", success, { rl: 20 }));
    if (k <= 24 && hourOf(slot) >= 20 && hourOf(slot) <= 22) byModelHour.push(fRow(slot, "m1", 150));
  }
  const result = build({ modelHours, cells, byModelHour });
  const row = lostOf(result, "m1");
  assert.equal(row.lost24, 450);
  // 涨幅里的日总量是成交 + 没买到：昨天多了 450 个没买到，近 3 天日均 (3 × 2616 + 450) ÷ 3 = 2766，前 4 天 2400 → 1.1525
  assert.equal(row.tomorrowLost, round1(450 * growthOf([2616 + 450, 2616, 2616, 2400, 2400, 2400, 2400])));
  assert.equal(result.page.lost.kpis.tomorrow.count, 1);
  assert.equal(result.page.lost.kpis.tomorrow.lost, row.tomorrowLost);
});

test("按原因给建议：没钱 → 充值（失败最多的那家，带还能撑几小时）；限流 → 加 Key 或挪量，测到上限且有缺口才给几把；故障 → 挪量", () => {
  const by = (rate_limit, upstream, auth_quota) => ({ rate_limit, upstream, auth_quota });
  // 渠道 1（甲）：限流、测到上限 900、缺口 150；渠道 2（乙）：同一个模型也在供，近 7 天被挡 1 次/小时；渠道 3（丙）被挡 5 次/小时（都比甲少，失败最多的还是甲）
  const a = steady({ channelId: 1, peakSuccess: 900, rl: 120, f: 150 });
  const extra = [];
  for (let k = 1; k <= 168; k += 1) { extra.push(cell(slotAt(k), 2, "m1", 0, { rl: 1 })); extra.push(cell(slotAt(k), 3, "m1", 0, { rl: 5 })); }
  const channels = [channel(1, { upstreamId: "u1", ruleId: "r1" }), channel(2, { upstreamId: "u2", ruleId: "r2" }), channel(3, { upstreamId: "u3", ruleId: "r3" })];
  const world = ({ part = a, cellsOf = part.cells, byModelHour = part.byModelHour, upstreams = upstreamsOf([["u1", "甲"], ["u2", "乙"], ["u3", "丙"]]), chs = channels } = {}) =>
    buildHeadroom({ now: NOW, tz: TZ, errorLog: usable, consume: consumeOn, modelHours: part.modelHours, cells: [...cellsOf, ...extra], byModelHour, rejectedUsers: [], channels: chs, upstreams, weekUsd: new Map([["m1", 1]]), small: new Set() });
  const limit = lostOf(world(), "m1");
  assert.equal(limit.mainCause, "rate_limit");
  assert.deepEqual(limit.reco, { kind: "rateLimit", upstreamId: "u1", name: "甲", accountLimited: false, addKeys: { n: 1, perKey: 900 }, moveTo: { upstreamId: "u2", name: "乙" } }, "测到上限 900、缺口 150 → 1 把；挪到被挡最少的乙（丙被挡更多）");
  // 没测到上限：不给几把
  const unmeasured = lostOf(world({ part: steady({ channelId: 1, peakSuccess: 900, rl: 0, f: 150 }) }), "m1");
  assert.deepEqual([unmeasured.reco.kind, unmeasured.reco.addKeys], ["rateLimit", null]);
  assert.equal(lostOf(world({ chs: [channels[0]] }), "m1").reco.moveTo, null, "没有别的上游在供：没有可挪的");
  // 故障 → 挪量；没钱 → 充值
  const base = steady({ channelId: 1, peakSuccess: 900, rl: 0, f: 150 });
  const withReason = (cause) => ({
    byModelHour: base.byModelHour.map((row) => ({ ...row, finalFailuresByReason: cause === "up" ? by(0, 150, 0) : by(0, 0, 150), rejected: cause === "up" ? rejected(0, 150, 0) : rejected(0, 0, 150) })),
    cellsOf: base.cells.map((c) => (hourOf(c.slotMs) >= 20 && hourOf(c.slotMs) <= 22 ? { ...c, rejected: cause === "up" ? rejected(0, 150, 0) : rejected(0, 0, 150), finalFailuresByReason: cause === "up" ? by(0, 150, 0) : by(0, 0, 150) } : c)),
  });
  const fault = lostOf(world({ part: base, ...withReason("up") }), "m1");
  assert.deepEqual([fault.mainCause, fault.reco], ["upstream", { kind: "fault", upstreamId: "u1", name: "甲", moveTo: { upstreamId: "u2", name: "乙" } }]);
  const money = lostOf(world({ part: base, ...withReason("auth"), upstreams: upstreamsOf([["u1", "甲", 2 / 24], ["u2", "乙"], ["u3", "丙"]]) }), "m1");
  assert.deepEqual([money.mainCause, money.reco], ["auth_quota", { kind: "topup", upstreamId: "u1", name: "甲", hoursLeft: 2 }]);
});

test("限流但失败最多的那家是按账号限的：不给加 Key（accountLimited），页面写找它提额度", () => {
  const a = steady({ channelId: 1, peakSuccess: 500, rl: 70, f: 200 }), b = steady({ channelId: 2, peakSuccess: 400, rl: 60 });
  const result = build({ modelHours: a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests })), cells: [...a.cells, ...b.cells], byModelHour: a.byModelHour, channels: [channel(1), channel(2)] });
  const row = lostOf(result, "m1");
  assert.deepEqual([row.reco.kind, row.reco.accountLimited, row.reco.addKeys], ["rateLimit", true, null]);
});

test("缺货失败的两种没数据状态：没开错误日志（关着读取 / 开着但站点没开）只给状态码，没有行、顶上的数是 null；近 24 小时没有失败是 noFailures；不等 7 天", () => {
  const off = lostWorld([{ model: "m1", channelId: 1, f: 50 }], { errorLog: { switchOn: false, cursor: null, hasRecords: false } });
  assert.deepEqual([off.page.lost.status, off.page.lost.noErrorLogReason, off.page.lost.rows, off.page.lost.kpis.tomorrow, off.page.lost.kpis.last24, off.page.lost.quietCount], ["noErrorLog", "switchOff", [], null, null, 0]);
  const quiet = lostWorld([{ model: "m1", channelId: 1, f: 0 }], { errorLog: { switchOn: true, cursor: { coveredFromMs: NOW - 3 * DAY, coveredToMs: NOW }, hasRecords: false } });
  assert.deepEqual([quiet.page.lost.status, quiet.page.lost.noErrorLogReason], ["noErrorLog", "noRecords"]);
  const none = lostWorld([{ model: "m1", channelId: 1, f: 0 }]);
  assert.deepEqual([none.page.lost.status, none.page.lost.rows, none.page.lost.quietCount], ["noFailures", [], 1]);
  assert.deepEqual(none.page.lost.kpis.last24, { lost: 0, lostUsd: 0, keyUsers: 0, outOfStockCount: 0 });
  const young = lostWorld([{ model: "m1", channelId: 1, f: 50 }], { errorLog: { switchOn: true, cursor: { coveredFromMs: NOW - 2 * DAY, coveredToMs: NOW }, hasRecords: true } });
  assert.equal(young.page.lost.status, "ok");
  assert.equal(young.page.lost.rows[0].lost24, 150);
  const noConsume = lostWorld([{ model: "m1", channelId: 1, f: 50 }], { consume: { on: false, cursor: null } });
  assert.equal(noConsume.page.lost.rows[0].lost24, 150, "没开「算应付成本」：缺货失败照常");
});

test("受影响的重点用户：缺货失败那一行带近 24 小时被挡过的重点用户；顶上的重点用户数是全站的", () => {
  const rejectedUsers = [{ userId: 5, rejected: rejected(9), rejectedRequests: 1, byModel: [{ model: "m1", rejected: rejected(9), rejectedRequests: 1 }] }, { userId: 6, rejected: rejected(3), rejectedRequests: 1, byModel: [{ model: "m1", rejected: rejected(3), rejectedRequests: 1 }] }];
  const part = steady({ f: 50 });
  const result = build({ ...part, rejectedUsers, usersById: new Map([[5, { name: "小王", key: true }], [6, { name: "普通", key: false }]]) });
  assert.deepEqual(lostOf(result, "m1").keyUsers, { count: 1, top: [{ userId: 5, name: "小王", blocked: 9, blockedRequests: 1 }] });
  assert.equal(result.page.lost.kpis.last24.keyUsers, 1);
});

// ---- v5 补充：摊到上游和渠道、断货的行、三种状态、quiet 列表、顶上第一格 ----
test("缺货失败出在哪个渠道、哪家上游用格子的精确数（不按被拒次数摊）：渠道 A 被限流被拒很多、重试到 B 基本成功，死在 B 上的才算 B 的 → 上游卡片 lost24、抽屉渠道 lost24、mainCause、mainUpstream、upstreamCount 都是 A = 0、B = 全部", () => {
  // 渠道 1（甲）限流 60 次/小时、没有一个请求死在它上面；渠道 2（乙）限流 20 次/小时，每个高峰小时 100 个请求死在它上面（重试用完）
  const a = steady({ channelId: 1, peakSuccess: 500, rl: 60, f: 0 }), b = steady({ channelId: 2, peakSuccess: 500, rl: 20, f: 100 });
  const result = build({ modelHours: a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests })), cells: [...a.cells, ...b.cells], byModelHour: b.byModelHour,
    channels: [channel(1, { upstreamId: "u1" }), channel(2, { upstreamId: "u2" })], upstreams: upstreamsOf([["u1", "甲"], ["u2", "乙"]]) });
  const card = (id) => result.page.upstreams.find((c) => c.upstreamId === id);
  assert.deepEqual(card("u1").lost24, { rate_limit: 0, upstream: 0, auth_quota: 0 }, "甲被拒最多，但没有一个死在甲上");
  assert.deepEqual(card("u2").lost24, { rate_limit: 300, upstream: 0, auth_quota: 0 });
  assert.equal(card("u1").lost24.rate_limit + card("u2").lost24.rate_limit, lostOf(result, "m1").lost24, "加起来就是 lost24");
  const d = result.detailOf("m1");
  assert.deepEqual(d.channels.map((c) => [c.channelId, c.lost24, c.mainCause]), [[1, 0, null], [2, 300, "rate_limit"]]);
  assert.deepEqual(lostOf(result, "m1").mainUpstream, { upstreamId: "u2", name: "乙" }, "失败最多的上游是乙，不是被拒最多的甲");
  assert.equal(lostOf(result, "m1").upstreamCount, 1, "失败只涉及乙一家");
  assert.equal(lostOf(result, "m1").reco.upstreamId, "u2", "建议也指向乙");
  // 两家都有：各算各的
  const both = build({ modelHours: a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests })), cells: [...steady({ channelId: 1, peakSuccess: 500, rl: 60, f: 30 }).cells, ...b.cells], byModelHour: b.byModelHour.map((row) => ({ ...row, finalFailures: 130, finalFailuresByReason: { rate_limit: 130, upstream: 0, auth_quota: 0 } })),
    channels: [channel(1, { upstreamId: "u1" }), channel(2, { upstreamId: "u2" })], upstreams: upstreamsOf([["u1", "甲"], ["u2", "乙"]]) });
  assert.equal(lostOf(both, "m1").upstreamCount, 2);
  // 没开错误日志：卡片和渠道的 lost24 是 null
  const off = lostWorld([{ model: "m1", channelId: 1, f: 50 }], { errorLog: { switchOn: false, cursor: null, hasRecords: false } });
  assert.equal(off.page.upstreams[0].lost24, null);
  assert.equal(off.detailOf("m1").channels[0].lost24, null);
});

test("三种状态：控制台关了读取 → switchOff；开着读取但从来没读到过一条（不管读了几小时）→ noRecords；以前读到过、近 24 小时没有缺货失败 → noFailures", () => {
  const status = (errorLog) => { const lost = lostWorld([{ model: "m1", channelId: 1, f: 0 }], { errorLog }).page.lost; return [lost.status, lost.noErrorLogReason]; };
  assert.deepEqual(status({ switchOn: false, cursor: null, hasRecords: false }), ["noErrorLog", "switchOff"]);
  assert.deepEqual(status({ switchOn: false, cursor: { coveredFromMs: NOW - 3 * DAY, coveredToMs: NOW }, hasRecords: true }), ["noErrorLog", "switchOff"], "关了读取，以前有记录也是 switchOff");
  assert.deepEqual(status({ switchOn: true, cursor: { coveredFromMs: NOW - 3 * H, coveredToMs: NOW }, hasRecords: false }), ["noErrorLog", "noRecords"], "刚开 3 小时、一条没读到：也是 noRecords");
  assert.deepEqual(status({ switchOn: true, cursor: null, hasRecords: false }), ["noErrorLog", "noRecords"], "还没读过");
  assert.deepEqual(status({ switchOn: true, cursor: { coveredFromMs: NOW - 14 * DAY, coveredToMs: NOW }, hasRecords: true }), ["noFailures", null]);
});

test("没渠道（断货）的模型列进主表：lost24 是 null，少收和明天预计是断货前 7 天的日均估计，estimated: true；顶上第一格模型数算上它、预计失败次数不算；少收总额算上它；quiet 不含它", () => {
  const part = steady({ model: "alive", channelId: 1, f: 100 });
  const outModels = new Map([["gone", { costPerDay: 12.5, requestsPerDay: 800, outSince: "2026-10-18" }], ["alsoGone", { costPerDay: 3, requestsPerDay: 100, outSince: null }]]);
  const gone = steady({ model: "gone", channelId: 2, peakSuccess: 300, rl: 0 });
  const result = build({ modelHours: [...part.modelHours, ...gone.modelHours], cells: [...part.cells, ...gone.cells], byModelHour: part.byModelHour,
    channels: [channel(1, { models: ["alive"] }), channel(2, { models: ["gone"], state: "off" })], upstreams: upstreamsOf([["u1", "上游一"]]), weekUsd: new Map([["alive", 50], ["gone", 20], ["alsoGone", 0]]), outModels });
  const lost = result.page.lost;
  assert.deepEqual(lost.rows.map((row) => row.name), ["gone", "alive", "alsoGone"].sort((x, y) => (lost.rows.find((r) => r.name === y)?.lostMoney24 ?? 0) - (lost.rows.find((r) => r.name === x)?.lostMoney24 ?? 0)), "和别的行一起按少收的钱排");
  const g = lostOf(result, "gone");
  assert.deepEqual([g.lost24, g.lostMoney24, g.estimated, g.outSince, g.mainCause, g.mainUpstream, g.peakFailHours, g.tomorrowLost, g.reco, g.upstreamCount], [null, 12.5, true, "2026-10-18", "no_channel", null, null, 800, { kind: "openChannel" }, 0]);
  assert.equal(lostOf(result, "alsoGone").outSince, null);
  assert.equal(lostOf(result, "alive").estimated, false);
  const alive = lostOf(result, "alive");
  assert.deepEqual(lost.kpis.tomorrow, { count: 3, lost: alive.tomorrowLost, outOfStockCount: 2, top: { name: "alive", lost: alive.tomorrowLost } }, "模型数 3 个（含 2 个断货的），预计失败次数只算 alive");
  assert.deepEqual(lost.kpis.last24, { lost: alive.lost24, lostUsd: Math.round((alive.lostMoney24 + 12.5 + 3) * 1e4) / 1e4, keyUsers: 0, outOfStockCount: 2 }, "失败次数不算断货的，少收算上估计值");
  assert.equal(lost.quietCount, 0);
  // 抽屉：断货的模型每小时失败给 null（有成交的断货模型），近 14 天没有成交的断货模型也有抽屉（只有这一行和渠道列表）
  assert.equal(result.detailOf("gone").hourly, null);
  assert.equal(result.detailOf("gone").lost.estimated, true);
  const bare = result.detailOf("alsoGone");
  assert.deepEqual([bare.hourly, bare.lost.name, bare.channels, bare.supply.kind], [null, "alsoGone", [], "unavailable"]);
  // 这个模型其实有开着的渠道：不当断货
  assert.equal(lostOf(build({ ...steady({ f: 50 }), outModels: new Map([["m1", { costPerDay: 5, requestsPerDay: 5, outSince: null }]]) }), "m1").estimated, false);
});

test("「另外 N 个模型近 24 小时没有缺货失败」：quiet 列出这些模型（近 7 天消费从高到低、最多 QUIET_SHOWN 个），quietCount 是总数；没有错误日志时都是空", () => {
  const specs = [{ model: "a", channelId: 1, f: 50 }, ...Array.from({ length: 5 }, (_, i) => ({ model: `q${i}`, channelId: 10 + i, f: 0 }))];
  const result = lostWorld(specs);
  const lost = result.page.lost;
  assert.equal(lost.quietCount, 5);
  assert.deepEqual(lost.quiet.map((item) => item.name), ["q0", "q1", "q2", "q3", "q4"].sort((x, y) => (result.page.rows.find((r) => r.name === y).weekUsd) - (result.page.rows.find((r) => r.name === x).weekUsd)), "近 7 天消费从高到低");
  assert.ok(lost.quiet.every((item) => typeof item.weekUsd === "number"));
  assert.deepEqual(lostWorld(specs, { errorLog: { switchOn: false, cursor: null, hasRecords: false } }).page.lost.quiet, []);
  assert.equal(HEADROOM.QUIET_SHOWN, 200);
});

test("按账号限流：给「提额度或挪量」——accountLimited 为 true、不给加几把，moveTo 带可以挪去的上游", () => {
  const a = steady({ channelId: 1, peakSuccess: 500, rl: 70, f: 200 }), b = steady({ channelId: 2, peakSuccess: 400, rl: 60 });
  const extra = [];
  for (let k = 1; k <= 168; k += 1) extra.push(cell(slotAt(k), 3, "m1", 0, { rl: 1 }));
  const result = build({ modelHours: a.modelHours.map((row, i) => ({ ...row, requests: row.requests + b.modelHours[i].requests })), cells: [...a.cells, ...b.cells, ...extra], byModelHour: a.byModelHour,
    channels: [channel(1), channel(2), channel(3, { upstreamId: "u3", ruleId: "r3" })], upstreams: upstreamsOf([["u1", "上游一"], ["u3", "上游三"]]) });
  assert.deepEqual(lostOf(result, "m1").reco, { kind: "rateLimit", upstreamId: "u1", name: "上游一", accountLimited: true, addKeys: null, moveTo: { upstreamId: "u3", name: "上游三" } });
});

test("挪去哪家的过滤：余额撑不到今晚高峰结束的不选（读不到余额的不排除）；上游卡片标了 full（高峰已经用满上限）的不选；都滤掉了是 null", () => {
  // 渠道 1（甲）：限流，失败最多；渠道 2（乙）、渠道 3（丙）也在供 m1，被挡很少（乙更少）
  const a = steady({ channelId: 1, peakSuccess: 900, rl: 120, f: 150 });
  const extra = [];
  for (let k = 1; k <= 168; k += 1) { extra.push(cell(slotAt(k), 2, "m1", 0, { rl: 1 })); extra.push(cell(slotAt(k), 3, "m1", 0, { rl: 5 })); }
  const other = steady({ model: "m2", channelId: 2, peakSuccess: 900, rl: 120 }); // 乙在高峰也在供 m2，用满了上限（测到 900、用了 900）
  const channels = [channel(1, { upstreamId: "u1", ruleId: "r1" }), channel(2, { upstreamId: "u2", ruleId: "r2", models: ["m1", "m2"] }), channel(3, { upstreamId: "u3", ruleId: "r3" })];
  const up = (days2, days3) => new Map([["u1", { id: "u1", name: "甲", runway: runway(30) }], ["u2", { id: "u2", name: "乙", runway: days2 }], ["u3", { id: "u3", name: "丙", runway: days3 }]]);
  const ok = runway(30), low = runway(2 / 24), unknown = { days: null, noSpend: false, fixed: false };
  const world = ({ withFull = false, u2 = ok, u3 = ok } = {}) => buildHeadroom({ now: NOW, tz: TZ, errorLog: usable, consume: consumeOn,
    modelHours: [...a.modelHours, ...(withFull ? other.modelHours : [])], cells: [...a.cells, ...extra, ...(withFull ? other.cells : [])], byModelHour: a.byModelHour, rejectedUsers: [], channels, upstreams: up(u2, u3), weekUsd: new Map([["m1", 1], ["m2", 1]]), small: new Set() });
  const moveTo = (result) => lostOf(result, "m1").reco.moveTo;
  assert.deepEqual(moveTo(world()), { upstreamId: "u2", name: "乙" }, "都合格：被挡最少的乙");
  assert.deepEqual(moveTo(world({ u2: low })), { upstreamId: "u3", name: "丙" }, "乙的余额只够 2 小时、撑不到今晚高峰结束（还有 7.5 小时）：不选");
  assert.deepEqual(moveTo(world({ u2: runway(7.5 / 24) })), { upstreamId: "u2", name: "乙" }, "正好撑到结束：选");
  assert.deepEqual(moveTo(world({ u2: unknown })), { upstreamId: "u2", name: "乙" }, "读不到余额的不排除");
  assert.deepEqual(moveTo(world({ u2: low, u3: low })), null, "都撑不到：null，页面只给另外那半句");
  const full = world({ withFull: true });
  assert.equal(full.page.upstreams.find((c) => c.upstreamId === "u2").full, true, "乙在高峰用满了上限");
  assert.deepEqual(moveTo(full), { upstreamId: "u3", name: "丙" }, "上游卡片标了 full 的乙不选");
  assert.equal(moveTo(world({ withFull: true, u3: low })), null, "乙 full、丙没钱：null");
  // 故障的建议也一样过滤
  const faultRows = a.byModelHour.map((row) => ({ ...row, finalFailuresByReason: { rate_limit: 0, upstream: 150, auth_quota: 0 }, rejected: rejected(0, 150, 0) }));
  const faultCells = a.cells.map((c) => (hourOf(c.slotMs) >= 20 && hourOf(c.slotMs) <= 22 ? { ...c, rejected: rejected(0, 150, 0), finalFailuresByReason: { rate_limit: 0, upstream: 150, auth_quota: 0 } } : c));
  const fault = buildHeadroom({ now: NOW, tz: TZ, errorLog: usable, consume: consumeOn, modelHours: a.modelHours, cells: [...faultCells, ...extra], byModelHour: faultRows, rejectedUsers: [], channels, upstreams: up(low, ok), weekUsd: new Map([["m1", 1]]), small: new Set() });
  assert.deepEqual(lostOf(fault, "m1").reco, { kind: "fault", upstreamId: "u1", name: "甲", moveTo: { upstreamId: "u3", name: "丙" } });
});

test("量很小的模型不列进主表（和断货行同一个门槛，small）：有缺货失败也不列，数进 smallCount，不进 quiet 和顶上的数", () => {
  const big = steady({ model: "big", channelId: 1, f: 50 }), tiny = steady({ model: "tiny", channelId: 2, f: 50 });
  const result = buildHeadroom({ now: NOW, tz: TZ, errorLog: usable, consume: consumeOn, modelHours: [...big.modelHours, ...tiny.modelHours], cells: [...big.cells, ...tiny.cells], byModelHour: [...big.byModelHour, ...tiny.byModelHour],
    rejectedUsers: [], channels: [channel(1, { models: ["big"], upstreamId: "u1" }), channel(2, { models: ["tiny"], upstreamId: "u2", ruleId: "r2" })], upstreams: upstreamsOf([["u1", "甲"], ["u2", "乙"]]), weekUsd: new Map([["big", 10], ["tiny", 0.001]]), small: new Set(["tiny"]) });
  const lost = result.page.lost;
  assert.deepEqual(lost.rows.map((row) => row.name), ["big"]);
  assert.equal(lost.smallCount, 1);
  assert.equal(lost.quietCount, 0);
  assert.deepEqual(lost.kpis.last24.lost, 150, "顶上的数只算列出来的行");
  assert.equal(result.detailOf("tiny").lost, null, "抽屉里这一行也没有");
  // 只有量很小的模型有失败：主表是空的，状态还是 ok（有失败，只是都不列）
  const onlyTiny = buildHeadroom({ now: NOW, tz: TZ, errorLog: usable, consume: consumeOn, modelHours: tiny.modelHours, cells: tiny.cells, byModelHour: tiny.byModelHour, rejectedUsers: [], channels: [channel(2, { models: ["tiny"] })], upstreams: upstreamsOf([["u1", "甲"]]), weekUsd: new Map([["tiny", 0.001]]), small: new Set(["tiny"]) });
  assert.deepEqual([onlyTiny.page.lost.status, onlyTiny.page.lost.rows, onlyTiny.page.lost.smallCount], ["ok", [], 1]);
  // 没开错误日志：smallCount 是 0
  assert.equal(lostWorld([{ model: "m1", channelId: 1, f: 50 }], { errorLog: { switchOn: false, cursor: null, hasRecords: false } }).page.lost.smallCount, 0);
});
