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

test("成功率状态：没有开着的渠道、读不到、接口里没有这个模型（nodata）、请求太少（有成功率但不到 50 次）、够了；门槛是 50 次，估法是成功数 ÷ 成功率", () => {
  assert.equal(successOf({ openChannels: 0, perfReadable: true, rate: 90, successes: 900 }).state, "none");
  assert.equal(successOf({ openChannels: 2, perfReadable: false, rate: 90, successes: 900 }).state, "unread");
  // 读到了、但里面没有这个模型：和「请求太少」分开，不判
  assert.deepEqual(successOf({ openChannels: 2, perfReadable: true, rate: null, successes: 0 }), { state: "nodata", rate: null, requests: null });
  assert.equal(successOf({ openChannels: 2, perfReadable: true, rate: null, successes: 5000 }).state, "nodata", "卖得再多，接口里没有就是没有数据，不是请求太少");
  // 49.99 次不够，50 次够：成功 45 次、成功率 90% → 总共 50 次
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 90, successes: 45 }).state, "ok");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 90, successes: 44 }).state, "few");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 100, successes: 49 }).state, "few");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 100, successes: 50 }).state, "ok");
  // 成功率 0（全部失败）：成功数是 0 估不出总请求数，改用近 7 天日均成功的请求数当这 24 小时的请求数
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 0, successes: 0, weekDailyRequests: 300 }).state, "ok");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 0, successes: 0, weekDailyRequests: 49.9 }).state, "few");
  assert.equal(successOf({ openChannels: 1, perfReadable: true, rate: 0, successes: 0 }).state, "few", "没有近 7 天的数就不判");
});

test("卖不出去：成功率低于 95% 才标，95.00% 不标；请求太少不标", () => {
  const run = (rate, successes) => {
    const result = view({ modelRows: [...sold("m", { week: 70, prev: 70 }), rowAt("m", N - 1, 1, successes, 12)], channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up1" }), perf: new Map([["m", rate]]) });
    return rowOf(result, "m");
  };
  assert.deepEqual([run(94.99, 100).flags.fail, run(95, 100).flags.fail, run(94, 100).flags.fail], [true, false, true]);
  assert.equal(run(80, 30).flags.fail, false, "成功 30 次、成功率 80% 估出 37.5 次，不到 50 次不判");
});

test("卖不出去：成功率是 0（全部失败）时用近 7 天日均成功的请求数判——以前每天几百次的要判，以前一天只有几次的不判", () => {
  const withDailyRequests = (requests) => view({
    modelRows: Array.from({ length: 7 }, (_, i) => rowAt("m", N - 8 + i, 10, requests)).concat(Array.from({ length: 7 }, (_, i) => rowAt("m", N - 15 + i, 10, requests))),
    channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up1" }), perf: new Map([["m", 0]]),
  });
  const busy = rowOf(withDailyRequests(300), "m"), quiet = rowOf(withDailyRequests(3), "m");
  assert.deepEqual([busy.success.state, busy.flags.fail, busy.tags.includes("fail")], ["ok", true, true]);
  assert.deepEqual([quiet.success.state, quiet.flags.fail], ["few", false]);
  // 少收：平时一天卖的钱（近 7 天日均 10）× 失败的比例 100% = 10，不会是无穷大
  assert.equal(busy.lost, 10);
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

test("主要上游：近 7 天流量占比最大的（抽屉里找货帮手拿它当现在用的）；占比读不到或最大的是没绑上游的渠道就没有", () => {
  const modelRows = sold("m", { week: 70 });
  const flowRows = [{ user: "u1", model: "m", channelId: 1, cost: 30 }, { user: "u2", model: "m", channelId: 2, cost: 70 }];
  const channels = [channel(1, ["m"]), channel(2, ["m"])];
  const a = view({ modelRows, flowRows, channels, ruleOf: ruleOf({ 1: "up1", 2: "up2" }) });
  assert.equal(a.details.get("m").mainUpstreamId, "up2");
  const b = view({ modelRows, flowRows, channels, ruleOf: ruleOf({ 1: "up1" }) });
  assert.equal(b.details.get("m").mainUpstreamId, null, "占比最大的渠道没绑上游：不知道主要上游");
  const c = view({ modelRows, flowRows: null, channels, ruleOf: ruleOf({ 1: "up1", 2: "up2" }) });
  assert.deepEqual([c.details.get("m").mainUpstreamId, c.flowReadable], [null, false]);
});

test("货源还能撑和快断货：开着的渠道对应的上游里撑得最久的那家；它不到 3 天才标快断货，刚好 3 天不标，2.99 天标；和流量占比读不读得到没关系", () => {
  const modelRows = sold("m", { week: 70 });
  const ups = (days) => new Map(Object.entries(days).map(([id, runwayOf]) => [id, { id, name: `上游${id}`, type: "newapi", runway: runwayOf }]));
  const run = (channels, rules, runways, flowRows = null) => rowOf(view({ modelRows, flowRows, channels, ruleOf: ruleOf(rules), upstreams: ups(runways) }), "m");
  const one = [channel(1, ["m"])], two = [channel(1, ["m"]), channel(2, ["m"])];
  // 一家：就是它
  const solo = run(one, { 1: "a" }, { a: runway(2) });
  assert.deepEqual([solo.longest.upstreamId, solo.longest.runway.days, solo.flags.soon], ["a", 2, true]);
  // 两家：看撑得最久的，不是流量最大的那家
  const split = run(two, { 1: "a", 2: "b" }, { a: runway(2), b: runway(10) }, [{ user: "u", model: "m", channelId: 1, cost: 99 }, { user: "u", model: "m", channelId: 2, cost: 1 }]);
  assert.deepEqual([split.longest.upstreamId, split.flags.soon], ["b", false], "流量大的甲只剩 2 天，但乙还有 10 天");
  const both = run(two, { 1: "a", 2: "b" }, { a: runway(2), b: runway(2.5) });
  assert.deepEqual([both.longest.upstreamId, both.flags.soon], ["b", true], "两家都不到 3 天：看最久的 2.5 天");
  // 边界
  const at = (n) => run(one, { 1: "a" }, { a: runway(n) }).flags.soon;
  assert.deepEqual([at(3), at(2.99)], [false, true]);
  // 不判的三种：有开着的渠道没绑上游；某家可用天数读不到；某家是固定成本或没有花费（撑无限久）
  const unbound = run(two, { 1: "a" }, { a: runway(1) });
  assert.deepEqual([unbound.flags.soon, unbound.longest.upstreamId], [false, "a"], "渠道 2 没绑上游，它的货从哪来不知道");
  const unread = run(two, { 1: "a", 2: "b" }, { a: runway(1), b: runway(null, { failed: true }) });
  assert.deepEqual([unread.flags.soon, unread.longest.upstreamId], [false, "a"], "乙的天数读不到");
  const fixed = run(two, { 1: "a", 2: "b" }, { a: runway(1), b: runway(null, { fixed: true }) });
  assert.deepEqual([fixed.flags.soon, fixed.longest.upstreamId], [false, "a"], "乙是固定成本");
  const noSpend = run(two, { 1: "a", 2: "b" }, { a: runway(1), b: runway(null, { noSpend: true }) });
  assert.deepEqual([noSpend.flags.soon, noSpend.longest.upstreamId], [false, "b"], "乙没有花费，撑无限久，它就是最久的");
  // 上游已经不在了（删了、归档了）：当读不到
  assert.equal(run(one, { 1: "gone" }, { a: runway(1) }).flags.soon, false);
  assert.equal(run(one, { 1: "gone" }, { a: runway(1) }).longest, null);
  // 没有开着的渠道是断货，不是快断货
  const stopped = rowOf(view({ modelRows, channels: [channel(1, ["m"], { status: 2 })], ruleOf: ruleOf({ 1: "a" }), upstreams: ups({ a: runway(1) }) }), "m");
  assert.deepEqual([stopped.flags.out, stopped.flags.soon, stopped.longest], [true, false, null]);
});

test("成功率读到了但没有这个模型是 nodata，不是请求太少；接口整个是空的单独标出来；读不到不标", () => {
  const modelRows = sold("m", { week: 70 }).concat(sold("n", { week: 70 }), [rowAt("n", N - 1, 1, 3, 12)]);
  const channels = [channel(1, ["m", "n"])];
  const some = view({ modelRows, channels, ruleOf: ruleOf({ 1: "up1" }), perf: new Map([["n", 99]]) });
  assert.deepEqual([rowOf(some, "m").success.state, rowOf(some, "n").success.state, some.perfEmpty, some.perfReadable], ["nodata", "few", false, true]);
  const empty = view({ modelRows, channels, ruleOf: ruleOf({ 1: "up1" }), perf: new Map() });
  assert.deepEqual([rowOf(empty, "m").success.state, empty.perfEmpty, empty.perfReadable], ["nodata", true, true]);
  const unread = view({ modelRows, channels, ruleOf: ruleOf({ 1: "up1" }), perf: null });
  assert.deepEqual([rowOf(unread, "m").success.state, unread.perfEmpty, unread.perfReadable], ["unread", false, false]);
  // 两种都不判卖不出去
  assert.deepEqual([rowOf(some, "m").flags.fail, rowOf(some, "n").flags.fail, rowOf(empty, "m").flags.fail], [false, false, false]);
});

test("量很小的不判缺口：每天卖的钱不到全站每天的千分之一，不标任何标签、不进顶上的几个数；刚好千分之一还判；断货的按断货前 7 天的日均算", () => {
  assert.equal(MODELS_VIEW.MIN_SHARE, 0.001);
  // 大模型近 7 天 6993、小模型 7：合起来 7000，千分之一是每天 1；小模型每天正好 1，不算「不到」
  const run = (tiny, extra = []) => view({
    modelRows: sold("big", { week: 6993 }).concat(sold("tiny", { week: tiny, prev: 70 }), extra),
    channels: [channel(1, ["big"]), channel(2, ["tiny"], { status: 2 })], ruleOf: ruleOf({ 1: "up1", 2: "up1" }),
  });
  const edge = run(7), under = run(6.9);
  assert.deepEqual([rowOf(edge, "tiny").flags.out, rowOf(edge, "tiny").gap, rowOf(edge, "tiny").tags], [true, true, ["out"]], "刚好千分之一：不算不到，照判");
  assert.deepEqual([rowOf(under, "tiny").flags.out, rowOf(under, "tiny").gap, rowOf(under, "tiny").tags, rowOf(under, "tiny").lost], [false, false, [], 0], "不到千分之一：什么标签都不标");
  assert.equal(edge.summary.missing.count, 1);
  assert.deepEqual([under.summary.missing.count, under.summary.missing.lostPerDay, under.summary.single.count], [0, 0, 1], "不进顶上的几个数（只有一家那格里只有 big，tiny 不算）");
  assert.equal(rowOf(under, "tiny").week, 6.9, "表里还在（收在「其余」里），只是不判");
  // 在猛涨、卖不出去、只有一家这些也一样不标
  const hot = view({
    modelRows: sold("big", { week: 100000 }).concat(sold("hot", { week: 20, prev: 5 }), [rowAt("hot", N - 1, 1, 90, 12)]),
    channels: [channel(1, ["big"]), channel(2, ["hot"])], ruleOf: ruleOf({ 1: "up1", 2: "up2" }), perf: new Map([["hot", 50]]),
  });
  assert.deepEqual([rowOf(hot, "hot").tags, hot.summary.rising.count], [[], 0]);
  // 断货的按断货前 7 天的日均算：停卖超过 7 天，近 7 天是 0，但断货前每天 70，不是小模型
  const gone = view({
    modelRows: sold("big", { week: 700 }).concat(Array.from({ length: 7 }, (_, i) => rowAt("gone", 5 + i, 70))),
    channels: [channel(1, ["big"])], ruleOf: ruleOf({ 1: "up1" }),
  });
  assert.deepEqual([rowOf(gone, "gone").week, rowOf(gone, "gone").flags.out, rowOf(gone, "gone").lost], [0, true, 70]);
  assert.equal(gone.summary.missing.count, 1);
  // 同样停卖超过 7 天、但没断货（还开着渠道）的，近 7 天日均是 0，是小模型，不判
  const quiet = view({
    modelRows: sold("big", { week: 700 }).concat(Array.from({ length: 7 }, (_, i) => rowAt("quiet", 5 + i, 70))),
    channels: [channel(1, ["big", "quiet"])], ruleOf: ruleOf({ 1: "up1" }), perf: new Map([["quiet", 10]]),
  });
  assert.deepEqual([rowOf(quiet, "quiet").gap, rowOf(quiet, "quiet").tags], [false, []]);
  // 全站一分钱没卖：没有分母，不判小模型
  const none = view({ modelRows: Array.from({ length: 7 }, (_, i) => rowAt("old", 5 + i, 70)), channels: [] });
  assert.deepEqual([rowOf(none, "old").flags.out, none.summary.missing.count], [true, 1]);
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
  assert.deepEqual(Object.entries(row.flags).filter(([, on]) => on).map(([tag]) => tag), ["out", "rising"], "没有开着的渠道是断货，不再同时算快断货");
  const many = view({ modelRows, flowRows, channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up2" }), perf: new Map([["m", 50]]) });
  assert.deepEqual(rowOf(many, "m").tags, ["soon", "fail", "single"], "快断货、卖不出去、只有一家、在猛涨四个，只留前三个");
  assert.equal(rowOf(many, "m").gap, true);
});

test("少收多少：卖不出去按近 7 天日均 ×（1 ÷ 成功率 − 1）；断货按最后一天有消费的那天往前 7 天的日均；两样都占只算断货", () => {
  const success = { state: "ok", rate: 80, requests: 100 };
  assert.ok(Math.abs(lostPerDayOf({ out: false, fail: true, week: 70, success, dayCost: [] }) - 2) < 1e-9, "日均 10 × (1 − 0.8) = 2");
  assert.equal(lostPerDayOf({ out: false, fail: true, week: 70, success: { state: "ok", rate: 10, requests: 100 }, dayCost: [] }), 9, "成功率 10%：最多等于平时一天卖的钱的 90%，不会算成好几天的钱");
  assert.equal(lostPerDayOf({ out: false, fail: true, week: 70, success: { state: "ok", rate: 0, requests: 100 }, dayCost: [] }), 10, "成功率 0：等于平时一天卖的钱，不是无穷大");
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
  // out：最后一天有消费的是昨天（idx N-2），往前 7 天都是 10 → 日均 10；fail：近 7 天日均 20 × (1 − 0.5) = 10
  assert.ok(Math.abs(s.missing.lostPerDay - 20) < 1e-9);
  assert.deepEqual([s.single.count, s.single.share], [2, (210 + 280) / (70 + 140 + 210 + 280 + 700)], "solo 和 hot 都只有一家");
  assert.deepEqual([s.soon.count, s.soon.first?.name, s.soon.first?.days], [1, "solo", 2]);
  assert.deepEqual([s.rising.count, s.rising.first?.name, s.rising.first?.ratio], [1, "hot", 4]);
});

test("读不到：成功率读不到那一列不判卖不出去；流量占比读不到不影响货源还能撑和快断货（只看渠道绑的上游）", () => {
  const modelRows = [...sold("m", { week: 70 }), rowAt("m", N - 1, 1, 80, 12)];
  const result = view({ modelRows, flowRows: null, channels: [channel(1, ["m"])], ruleOf: ruleOf({ 1: "up2" }), perf: null });
  const row = rowOf(result, "m");
  assert.deepEqual([row.success.state, row.flags.fail, row.longest.upstreamId, row.flags.soon, result.perfReadable, result.flowReadable], ["unread", false, "up2", true, false, false]);
  assert.equal(result.details.get("m").mainUpstreamId, null);
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

test("抽屉的谁在用：流向读到了、只是这个模型近 7 天没人用（比如断货了 10 天）给空的，不是读不到；流向整体读不到才是 null", () => {
  const modelRows = sold("quiet", { prev: 70 }); // 近 7 天没有消费、前 7 天有
  const withFlow = view({ modelRows, flowRows: [{ user: "a", model: "other", channelId: 1, cost: 5 }], channels: [channel(1, ["quiet"], { status: 2 })], ruleOf: ruleOf({ 1: "up1" }) });
  assert.deepEqual(withFlow.details.get("quiet").users, { top: [], others: null, total: 0 });
  const noFlow = view({ modelRows, flowRows: null, channels: [channel(1, ["quiet"], { status: 2 })], ruleOf: ruleOf({ 1: "up1" }) });
  assert.equal(noFlow.details.get("quiet").users, null);
});

test("成功率线：同一个小时各分组等权平均，一天里有数据的小时等权平均（不按请求数加权，一整小时全失败也算一个小时），没有点的天是 null，最低的一天单独给", () => {
  const day = N - 3;
  const h = (hour) => grid.starts[day] + hour * HOUR;
  const groups = [
    { group: "default", points: [{ t: h(2), successRate: 100 }, { t: h(3), successRate: 90 }] },
    { group: "vip", points: [{ t: h(2), successRate: 80 }] },
  ];
  const { points, low } = dailySuccessLine({ now: NOW, tz: TZ, groups });
  assert.equal(points.length, 30);
  // 第 2 小时两个分组平均 90，第 3 小时 90 → 90
  assert.equal(points[day].rate, 90);
  assert.equal(points[day - 1].rate, null);
  assert.deepEqual(low, { day: grid.keys[day], rate: 90 });
  // 半天 100%、半天全挂：按小时等权是 50%，故障看得见（按请求数加权会得到 100%）
  const outage = dailySuccessLine({ now: NOW, tz: TZ, groups: [{ group: "g", points: [...Array.from({ length: 12 }, (_, i) => ({ t: h(i), successRate: 100 })), ...Array.from({ length: 12 }, (_, i) => ({ t: h(12 + i), successRate: 0 }))] }] });
  assert.equal(outage.points[day].rate, 50);
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
