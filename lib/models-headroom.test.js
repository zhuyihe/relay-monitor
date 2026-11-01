import test from "node:test";
import assert from "node:assert/strict";
import { HEADROOM, buildHeadroom, gridOf, hoursUntilHour, measureLimit, needOf, peakOf, percentile } from "./models-headroom.js";

const H = 3600000, DAY = 24 * H;
const NOW = Date.parse("2026-10-20T15:30:00Z"); // 业务时区 UTC：今天是 10-20，近 7 个整天是 10-13 到 10-19
const END = Math.floor(NOW / H) * H;
const TZ = "UTC";
const N = HEADROOM.WINDOW_DAYS * 24;
const slotAt = (k) => END - k * H; // k = 1 是刚过完的那个小时
const hourOf = (slot) => new Date(slot).getUTCHours();

// ---- 造数据 ----
const rejected = (rl = 0, up = 0, auth = 0, other = 0) => ({ rate_limit: rl, upstream: up, auth_quota: auth, other, total: rl + up + auth + other });
const cell = (slotMs, channelId, model, success, { rl = 0, up = 0, auth = 0 } = {}) => ({ slotMs, channelId, model, success, rejected: rejected(rl, up, auth), rejectedRequests: rl + up + auth, sampled: 0 });
const mh = (model, t, requests, cost = requests * 0.01) => ({ model, t, requests, cost });
const fRow = (slotMs, model, f, { rl = 0, up = 0, auth = 0, q = f } = {}) => ({ slotMs, model, finalFailures: f, rejected: rejected(rl, up, auth), rejectedRequests: q });
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
    cells.push(cell(slot, channelId, model, success, peak ? { rl, up: upPeak } : {}));
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
  assert.deepEqual(row.margin, { value: -150, status: "short" });
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
  assert.deepEqual(row.margin, { value: -100, status: "unknown" });
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

test("按账号限的边界：两把 Key 同时被限流的小时至少 2 个，并且占较少那把被限流小时的一半以上才合成一个", () => {
  const twoKeys = (a, b) => {
    const modelHours = [], cells = [];
    for (let k = 1; k <= 336; k += 1) {
      const slot = slotAt(k);
      modelHours.push(mh("m1", slot, 1000));
      cells.push(cell(slot, 1, "m1", 500, a.has(k) ? { rl: 60 } : {}), cell(slot, 2, "m1", 500, b.has(k) ? { rl: 60 } : {}));
    }
    return build({ modelHours, cells, byModelHour: [], channels: [channel(1), channel(2)] }).page.upstreams[0].accountLimited;
  };
  const set = (...values) => new Set(values);
  assert.equal(twoKeys(set(1, 2, 3), set(2, 3, 4)), true, "同时 2 个小时，占较少那把（3 个）的 67%");
  assert.equal(twoKeys(set(1, 2, 3, 4, 5), set(1, 2)), true, "同时 2 个小时，占较少那把（2 个）的 100%");
  assert.equal(twoKeys(set(1, 2), set(2, 50)), false, "只同时 1 个小时");
  assert.equal(twoKeys(set(1, 2, 3, 4, 5, 6), set(1, 2, 7, 8, 9)), false, "同时 2 个小时，只占较少那把（5 个）的 40%");
  assert.equal(twoKeys(set(1, 2, 3, 4), set(1, 2, 7, 8)), true, "正好 50%：算");
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
  assert.deepEqual(row.margin, { value: null, status: "none" });
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
  assert.deepEqual(quietRow.margin, { value: null, status: "none" });
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
  assert.deepEqual(row.keyUsers, { count: 2, top: [{ userId: 2, name: "小王", blocked: 9 }, { userId: 7, name: "老李", blocked: 4 }] }, "只算这个模型的重点用户，按被挡次数");
  assert.equal(result.page.kpis.notBought.keyUsers, 3, "全站被挡过的重点用户 3 个（含别的模型的）");
  const detail = result.detailOf("m1");
  assert.deepEqual(detail.users.top.map((u) => [u.userId, u.name, u.blocked, u.key]), [[1, "普通用户", 10, false], [2, "小王", 9, true], [3, "#3", 8, false], [4, "#4", 7, false], [5, "#5", 6, false]]);
  assert.deepEqual(detail.users.others, { count: 3, blocked: 5 + 4 + 3 });
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
  assert.deepEqual(d.hourly.clock7d[21], { hour: 21, success: 900, blocked: { rate_limit: 100, upstream: 20, auth_quota: 10, other: 0 } });
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
