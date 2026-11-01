import test from "node:test";
import assert from "node:assert/strict";
import { MODELS_VIEW, arrangeFinder, arrangeModels, buildModelsView, comparePrice, dailySuccessLine, gapTagsOf, isRising, lostPerDayOf, priceInUpstream, successOf } from "./models-view.js";
import { dayGrid } from "./user-ops-view.js";

const TZ = "Asia/Shanghai";
const NOW = Date.parse("2026-10-26T06:30:00Z"); // 上海 14:30
const grid = dayGrid(NOW, TZ, MODELS_VIEW.DAYS);
const N = grid.days;
const HOUR = 3600000;
// 一天里的消费放在这一天 10 点那一行；idx 是第几天（N-1 是今天）
const rowAt = (key, idx, cost, requests = 10, hour = 10) => ({ key, t: grid.starts[idx] + hour * HOUR, cost, requests });
// 近 7 天每天 cost，前 7 天每天 prevCost
const sold = (key, { week = 0, prev = 0, older = 0, today = 0 } = {}) => [
  ...Array.from({ length: 7 }, (_, i) => rowAt(key, N - 8 + i, week / 7)),
  ...Array.from({ length: 7 }, (_, i) => rowAt(key, N - 15 + i, prev / 7)),
  ...(older ? [rowAt(key, 2, older)] : []),
  ...(today ? [rowAt(key, N - 1, today, 10, 8)] : []),
].filter((row) => row.cost > 0);
const channel = (id, models, { status = 1, priority = 0 } = {}) => ({ id, name: `渠道 ${id}`, status, models, priority, weight: 0 });
const runway = (days, extra = {}) => ({ days, noSpend: false, level: "good", text: days == null ? "—" : `约 ${days} 天`, failed: false, ...extra });
const upstreams = new Map([["up1", { id: "up1", name: "上游甲", type: "newapi", runway: runway(10) }], ["up2", { id: "up2", name: "上游乙", type: "newapi", runway: runway(2) }]]);
const view = (over = {}) => buildModelsView({ now: NOW, tz: TZ, modelRows: [], flowRows: [], channels: [], ruleOf: new Map(), upstreams, perf: new Map(), ...over });
const ruleOf = (pairs) => new Map(Object.entries(pairs).map(([channelId, upstreamStationId]) => [Number(channelId), { upstreamStationId }]));
const rowOf = (result, name) => result.rows.find((row) => row.name === name);

test("成功率状态：没有开着的渠道、读不到、请求太少（含一次都没有）、够了；门槛是 50 次，估法是成功数 ÷ 成功率", () => {
  assert.equal(successOf({ openChannels: 0, perfReadable: true, rate: 90, successes: 900 }).state, "none");
  assert.equal(successOf({ openChannels: 2, perfReadable: false, rate: 90, successes: 900 }).state, "unread");
  assert.equal(successOf({ openChannels: 2, perfReadable: true, rate: null, successes: 0 }).state, "few");
  // 49.99 次不够，50 次够：成功 45 次、成功率 90% → 总共 50 次
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 90, successes: 45 }).state, "ok");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 90, successes: 44 }).state, "few");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 100, successes: 49 }).state, "few");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 100, successes: 50 }).state, "ok");
  // 成功率 0：总请求数算不出，不判
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 0, successes: 0 }).state, "few");
});

test("卖不出去：成功率低于 95% 才标，95.00% 不标；请求太少不标", () => {
  const run = (rate, successes) => {
    const result = view({ modelRows: [...sold("m", { week: 70, prev: 70 }), rowAt("m", N - 1, 1, successes, 12)], channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up1" }), perf: new Map([["m", rate]]) });
    return rowOf(result, "m");
  };
  assert.deepEqual([run(94.99, 100).flags.fail, run(95, 100).flags.fail, run(94, 100).flags.fail], [true, false, true]);
  assert.equal(run(80, 30).flags.fail, false, "成功 30 次、成功率 80% 估出 37.5 次，不到 50 次不判");
});

test("断货：开着的渠道里没有一个列了这个模型；只有停用、被自动停用的渠道也算断货；没配在任何渠道上也算", () => {
  const modelRows = sold("a", { week: 70 }).concat(sold("b", { week: 70 }), sold("c", { week: 70 }), sold("d", { week: 70 }));
  const result = view({ modelRows, channels: [channel(1, ["a"]), channel(2, ["b"], { status: 2 }), channel(3, ["c"], { status: 3 })], ruleOf: ruleOf({ 1: "up1", 2: "up1", 3: "up2" }) });
  assert.deepEqual(["a", "b", "c", "d"].map((name) => rowOf(result, name).flags.out), [false, true, true, true]);
  const stopped = rowOf(result, "b");
  assert.deepEqual([stopped.supply.open, stopped.supply.stopped], [0, 1]);
  assert.equal(stopped.success.state, "none");
  // 被自动停用和手动停用在抽屉的渠道表里分开
  assert.deepEqual(result.details.get("c").channels.map((item) => item.state), ["auto"]);
  assert.deepEqual(result.details.get("b").channels.map((item) => item.state), ["off"]);
});

test("只有一家：开着的渠道全绑了上游且是同一个；有开着的渠道没绑上游就不标；两个上游不标", () => {
  const modelRows = ["s", "u", "t"].flatMap((name) => sold(name, { week: 70 }));
  const result = view({
    modelRows, channels: [channel(1, ["s"]), channel(2, ["s"]), channel(3, ["u"]), channel(4, ["u"]), channel(5, ["t"]), channel(6, ["t"])],
    ruleOf: ruleOf({ 1: "up1", 2: "up1", 3: "up1" /* 4 没绑 */, 5: "up1", 6: "up2" }),
  });
  assert.deepEqual(["s", "u", "t"].map((name) => rowOf(result, name).flags.single), [true, false, false]);
  assert.deepEqual([rowOf(result, "s").supply.upstreams, rowOf(result, "t").supply.upstreams], [1, 2]);
  // 停用的渠道不算「开着的」：另一个渠道停用了、还有一个开着绑了同一个上游，照样是只有一家
  const stopped = view({ modelRows: sold("s", { week: 70 }), channels: [channel(1, ["s"]), channel(2, ["s"], { status: 2 })], ruleOf: ruleOf({ 1: "up1", 2: "up2" }) });
  assert.equal(rowOf(stopped, "s").flags.single, true);
});

test("主要上游：近 7 天流量占比最大的；占比读不到或最大的是没绑上游的渠道就没有；快断货按它的可用天数，不到 3 天才标", () => {
  const modelRows = sold("m", { week: 70 });
  const flowRows = [{ user: "u1", model: "m", channelId: 1, cost: 30 }, { user: "u2", model: "m", channelId: 2, cost: 70 }];
  const channels = [channel(1, ["m"]), channel(2, ["m"])];
  const a = view({ modelRows, flowRows, channels, ruleOf: ruleOf({ 1: "up1", 2: "up2" }) });
  assert.equal(rowOf(a, "m").main.upstreamId, "up2");
  assert.deepEqual([rowOf(a, "m").main.share, rowOf(a, "m").flags.soon], [0.7, true], "上游乙还能撑 2 天，不到 3 天");
  const b = view({ modelRows, flowRows, channels, ruleOf: ruleOf({ 1: "up1" }) });
  assert.equal(rowOf(b, "m").main, null, "占比最大的渠道没绑上游：不知道主要上游");
  assert.equal(rowOf(b, "m").flags.soon, false);
  const c = view({ modelRows, flowRows: null, channels, ruleOf: ruleOf({ 1: "up1", 2: "up2" }) });
  assert.deepEqual([rowOf(c, "m").main, c.flowReadable], [null, false]);
  // 边界：刚好 3 天不标，2.99 天标；可用天数算不出的不标
  const days = (n) => rowOf(view({ modelRows, flowRows, channels, ruleOf: ruleOf({ 1: "up1", 2: "up2" }), upstreams: new Map([["up1", upstreams.get("up1")], ["up2", { ...upstreams.get("up2"), runway: runway(n) }]]) }), "m").flags.soon;
  assert.deepEqual([days(3), days(2.99), days(null)], [false, true, false]);
});

test("在猛涨：近 7 天是前 7 天的 2 倍以上才标（正好 2 倍标），前 7 天至少花了门槛那么多才判", () => {
  const min = MODELS_VIEW.RISING_MIN_PREV_USD;
  assert.deepEqual([isRising(2 * min, min), isRising(2 * min - 0.01, min), isRising(20, 1), isRising(2 * min, min - 0.01), isRising(0, 0)], [true, false, false, false, false]);
  const run = (week, prev) => rowOf(view({ modelRows: sold("m", { week, prev }), channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up1" }) }), "m").flags.rising;
  assert.deepEqual([run(70, 28), run(55, 28), run(70, 1.4)], [true, false, false], "整页里用同一个判断（用 7 的倍数避开小数误差）");
});

test("近 30 天有消费的才列；只配在渠道上、没卖过的不列；近 7 天才有消费的标「新」", () => {
  const modelRows = [...sold("old", { week: 70, prev: 70 }), ...sold("fresh", { week: 70 }), rowAt("longago", 3, 5)];
  const result = view({ modelRows, channels: [channel(1, ["old", "fresh", "never", "longago"])], ruleOf: ruleOf({ 1: "up1" }) });
  assert.deepEqual(result.rows.map((row) => row.name).sort(), ["fresh", "longago", "old"]);
  assert.deepEqual([rowOf(result, "old").isNew, rowOf(result, "fresh").isNew, rowOf(result, "longago").isNew], [false, true, false]);
  assert.deepEqual([rowOf(result, "fresh").week, rowOf(result, "fresh").prev], [70, 0]);
});

test("标签：先后是 断货、快断货、卖不出去、只有一家、在猛涨；一行最多 3 个，有缺口按全部标签算", () => {
  assert.deepEqual(gapTagsOf({ rising: true, single: true, fail: true, soon: true, out: true }), ["out", "soon", "fail", "single", "rising"]);
  const modelRows = [...sold("m", { week: 140, prev: 20 }), rowAt("m", N - 1, 1, 90, 12)];
  const flowRows = [{ user: "u", model: "m", channelId: 1, cost: 10 }];
  const result = view({ modelRows, flowRows, channels: [channel(1, ["m"], { status: 2 })], ruleOf: ruleOf({ 1: "up2" }), perf: new Map([["m", 50]]) });
  const row = rowOf(result, "m");
  assert.deepEqual(Object.entries(row.flags).filter(([, on]) => on).map(([tag]) => tag), ["out", "soon", "rising"]);
  const many = view({ modelRows, flowRows, channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up2" }), perf: new Map([["m", 50]]) });
  assert.deepEqual(rowOf(many, "m").tags, ["soon", "fail", "single"], "快断货、卖不出去、只有一家、在猛涨四个，只留前三个");
  assert.equal(rowOf(many, "m").gap, true);
});

test("少收多少：卖不出去按近 7 天日均 ×（1 ÷ 成功率 − 1）；断货按最后一天有消费的那天往前 7 天的日均；两样都占只算断货", () => {
  const success = { state: "ok", rate: 80, requests: 100 };
  assert.ok(Math.abs(lostPerDayOf({ out: false, fail: true, week: 70, success, dayCost: [] }) - 2.5) < 1e-9, "日均 10 × (1/0.8 − 1) = 2.5");
  const dayCost = new Array(30).fill(0);
  for (let i = 10; i <= 20; i += 1) dayCost[i] = 7; // 第 20 天是最后一天有消费的；往前 7 天是 14..20，都是 7
  assert.equal(lostPerDayOf({ out: true, fail: false, week: 0, success, dayCost }), 7);
  dayCost[19] = 0; dayCost[20] = 14; // 14..20：6×7 − 7 + 14 = ...
  assert.equal(lostPerDayOf({ out: true, fail: false, week: 0, success, dayCost }), (7 * 5 + 0 + 14) / 7);
  assert.equal(lostPerDayOf({ out: true, fail: true, week: 70, success, dayCost: new Array(30).fill(0) }), 0, "一天消费都没有");
  assert.equal(lostPerDayOf({ out: true, fail: true, week: 70, success, dayCost }), (7 * 5 + 14) / 7, "断货的不再按成功率估");
  assert.equal(lostPerDayOf({ out: false, fail: false, week: 70, success, dayCost }), 0);
});

test("排法：有缺口的在前、没缺口的在后，两段里都按近 7 天消费从高到低，一样的按名字", () => {
  const rows = [{ name: "b", week: 10, gap: false }, { name: "c", week: 5, gap: true }, { name: "a", week: 10, gap: true }, { name: "d", week: 50, gap: false }, { name: "e", week: 10, gap: true }];
  assert.deepEqual(arrangeModels(rows).map((row) => row.name), ["a", "e", "c", "d", "b"]);
});

test("四个数：缺货的模型 = 断货 + 卖不出去、少收加起来；只有一家占的消费；快断货、猛涨点名消费最多的那个", () => {
  const modelRows = [...sold("out", { week: 70 }), ...sold("fail", { week: 140 }), rowAt("fail", N - 1, 1, 80, 12), ...sold("solo", { week: 210 }), ...sold("hot", { week: 280, prev: 70 }), ...sold("fine", { week: 700 })];
  const flowRows = [{ user: "u", model: "solo", channelId: 4, cost: 5 }, { user: "u", model: "hot", channelId: 5, cost: 5 }];
  const channels = [channel(2, ["fail"]), channel(3, ["fail"]), channel(4, ["solo"]), channel(5, ["hot"]), channel(6, ["fine"]), channel(7, ["fine"])];
  const result = view({ modelRows, flowRows, channels, ruleOf: ruleOf({ 2: "up1", 3: "up2", 4: "up2", 5: "up1", 6: "up1", 7: "up2" }), perf: new Map([["fail", 50], ["fine", 99], ["solo", 99], ["hot", 99]]) });
  const s = result.summary;
  assert.equal(s.missing.count, 2);
  // out：最后一天有消费的是昨天（idx N-2），往前 7 天都是 10 → 日均 10；fail：近 7 天日均 20 × (1/0.5 − 1) = 20
  assert.ok(Math.abs(s.missing.lostPerDay - 30) < 1e-9);
  assert.deepEqual([s.single.count, s.single.share], [2, (210 + 280) / (70 + 140 + 210 + 280 + 700)], "solo 和 hot 都只有一家");
  assert.deepEqual([s.soon.count, s.soon.first?.name, s.soon.first?.days], [1, "solo", 2]);
  assert.deepEqual([s.rising.count, s.rising.first?.name, s.rising.first?.ratio], [1, "hot", 4]);
});

test("读不到：成功率读不到那一列不判卖不出去；流量占比读不到没有主要上游也不判快断货", () => {
  const modelRows = [...sold("m", { week: 70 }), rowAt("m", N - 1, 1, 80, 12)];
  const result = view({ modelRows, flowRows: null, channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up2" }), perf: null });
  const row = rowOf(result, "m");
  assert.deepEqual([row.success.state, row.flags.fail, row.main, row.flags.soon, result.perfReadable, result.flowReadable], ["unread", false, null, false, false, false]);
  assert.equal(result.details.get("m").channels[0].share, null);
  assert.equal(result.details.get("m").users, null);
});

test("抽屉的渠道和谁在用：渠道占比、被停用的也列、前 4 个用户加其他；用户运营认得的带 id", () => {
  const flowRows = ["a", "b", "c", "d", "e", "f"].map((user, i) => ({ user, model: "m", channelId: i % 2 ? 2 : 1, cost: 10 - i }));
  const result = view({ modelRows: sold("m", { week: 70 }), flowRows, channels: [channel(1, ["m"], { priority: 10 }), channel(2, ["m"], { status: 3 })], ruleOf: ruleOf({ 1: "up1", 2: "up2" }), userIds: new Map([["a", 7]]) });
  const detail = result.details.get("m");
  assert.deepEqual(detail.channels.map((item) => [item.channelId, item.state, item.upstream.id, Math.round(item.share * 100)]), [[1, "on", "up1", 53], [2, "auto", "up2", 47]]);
  assert.deepEqual(detail.users.top.map((item) => [item.user, item.userId]), [["a", 7], ["b", null], ["c", null], ["d", null]]);
  assert.deepEqual([detail.users.others.count, detail.users.others.cost], [2, 6 + 5]);
});

test("成功率线：同一小时各分组取平均，一天里各小时按成功请求数加权，没有点的天是 null，最低的一天单独给", () => {
  const day = N - 3;
  const h1 = grid.starts[day] + 2 * HOUR, h2 = grid.starts[day] + 3 * HOUR;
  const groups = [
    { group: "default", points: [{ t: h1, successRate: 100 }, { t: h2, successRate: 90 }] },
    { group: "vip", points: [{ t: h1, successRate: 80 }] },
  ];
  const { points, low } = dailySuccessLine({ now: NOW, tz: TZ, groups, hourSuccesses: new Map([[h1, 1], [h2, 3]]) });
  assert.equal(points.length, 30);
  // h1：(100+80)/2 = 90；h2：90；加权后 90
  assert.equal(points[day].rate, 90);
  assert.equal(points[day - 1].rate, null);
  assert.deepEqual(low, { day: grid.keys[day], rate: 90 });
  const weighted = dailySuccessLine({ now: NOW, tz: TZ, groups: [{ group: "g", points: [{ t: h1, successRate: 100 }, { t: h2, successRate: 80 }] }], hourSuccesses: new Map([[h1, 1], [h2, 3]]) });
  assert.equal(weighted.points[day].rate, (100 * 1 + 80 * 3) / 4);
});

test("找货帮手的价格：倍率 × 你在那边的分组倍率；按次计费的是每次的价格；比现在用的便宜 / 贵多少，计价方式不同不比", () => {
  const table = (item, groups = { default: 1, vip: 0.5 }) => ({ models: new Map([["m", item]]), groupRatio: new Map(Object.entries(groups)) });
  const perToken = table({ model_name: "m", quota_type: 0, model_ratio: 2 });
  assert.deepEqual(priceInUpstream(perToken, "m", "vip"), { kind: "ratio", value: 1 });
  assert.deepEqual(priceInUpstream(perToken, "m", "unknown"), { kind: "ratio", value: 2 }, "没有这个分组按 1 倍");
  assert.deepEqual(priceInUpstream(table({ model_name: "m", quota_type: 1, model_price: 0.02 }), "m", "vip"), { kind: "perCall", value: 0.01 });
  assert.equal(priceInUpstream(perToken, "other", "vip"), null);
  assert.equal(priceInUpstream(table({ model_name: "m", billing_mode: "tiered_expr" }), "m", "vip"), null);
  const main = { kind: "ratio", value: 1 };
  assert.deepEqual(comparePrice({ kind: "ratio", value: 0.8 }, main), { kind: "cheaper", pct: 0.19999999999999996 });
  assert.equal(comparePrice({ kind: "ratio", value: 1.2 }, main).kind, "pricier");
  assert.equal(comparePrice({ kind: "ratio", value: 1.004 }, main).kind, "same");
  assert.equal(comparePrice({ kind: "perCall", value: 0.01 }, main), null);
  assert.equal(comparePrice(null, main), null);
  assert.deepEqual(arrangeFinder([{ name: "读不到", price: null }, { name: "贵", price: { kind: "ratio", value: 1.2 } }, { name: "便宜", price: { kind: "ratio", value: 0.8 } }, { name: "按次", price: { kind: "perCall", value: 0.01 } }]).map((row) => row.name),
    ["便宜", "贵", "按次", "读不到"]);
});
