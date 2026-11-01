// 模型供需的接口（server/models-page.js）：假的自营站点（渠道列表、按小时用量、模型 × 渠道流量、性能统计），假的上游和价目表。
// 判断规则本身在 lib/models-view.test.js 测；这里测读什么、读几次、缓存、读不到时怎么降级、抽屉要的几样。
import test from "node:test";
import assert from "node:assert/strict";
import { businessTimeZone } from "../lib/business-time.js";
import { MODELS_VIEW } from "../lib/models-view.js";
import { dayGrid } from "../lib/user-ops-view.js";
import { noteOwnRequest, resetOwnRequestBudget } from "../lib/own-request-budget.js";
import { modelDetail, modelsPage, MODELS_FAIL_TTL_MS, MODELS_TTL_MS } from "./models-page.js";

const H = 3600000;
const NOW = Date.parse("2026-11-01T08:00:00Z");
const QUOTA = 500000;
const own = { id: "own1", name: "我的站点", isOwn: true, type: "newapi", baseUrl: "https://own.test", accessToken: "tok", userId: "1" };
const up = (id, name, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.test`, accessToken: "x", balance: { ok: true, remaining: 100 }, ...extra });
const grid = dayGrid(NOW, businessTimeZone(), MODELS_VIEW.DAYS);
const N = grid.days;

// 一个模型每天消费（美元）：近 7 天每天 week/7，前 7 天每天 prev/7，今天 8 点 today；hour 10 点
function usageRows(model, { week = 0, prev = 0, today = 0, success = 0 } = {}) {
  const row = (idx, usd, hour, count) => ({ model_name: model, created_at: Math.floor((grid.starts[idx] + hour * H) / 1000), token_used: 100, quota: Math.round(usd * QUOTA), count });
  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    if (week) rows.push(row(N - 8 + i, week / 7, 10, 20));
    if (prev) rows.push(row(N - 15 + i, prev / 7, 10, 20));
  }
  if (today || success) rows.push(row(N - 1, today, 8, success));
  return rows;
}

function makeRt(t, { channels, rows, flow, perf, series, upstreams, rules, pricing, failures = {}, userOps = null } = {}) {
  resetOwnRequestBudget();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    if (url.host !== "own.test") return { status: 404, text: async () => "{}" };
    requests.push(`${url.pathname}${url.search ? "?" + url.searchParams.toString().replace(/start_timestamp=\d+&end_timestamp=\d+&?/, "") : ""}`);
    const key = url.pathname;
    if (failures[key]) return { status: failures[key], text: async () => "{}" };
    const reply = (data) => ({ status: 200, text: async () => JSON.stringify({ success: true, data }) });
    if (key === "/api/channel/") return reply({ total: channels.length, items: channels.map((c) => ({ id: c.id, name: c.name, type: 1, status: c.status ?? 1, base_url: "https://x.test", group: "default", models: c.models.join(","), priority: c.priority ?? 0, other_info: c.otherInfo ?? "", weight: c.weight ?? 0, key: "secret" })) });
    if (key === "/api/data/") return reply(rows);
    if (key === "/api/data/flow") return reply(flow.map((f) => ({ username: f.user, use_group: "default", model_name: f.model, channel_id: f.channelId, channel_name: "x", token_name: "t", token_used: 1, quota: Math.round(f.usd * QUOTA), count: 1 })));
    if (key === "/api/perf-metrics/summary") return reply({ models: perf.map(([model, rate]) => ({ model_name: model, success_rate: rate, avg_latency_ms: 100, avg_tps: 1 })) });
    if (key === "/api/perf-metrics") {
      const model = url.searchParams.get("model");
      return reply({ model_name: model, series_schema: "x", groups: (series[model] || []).map((g) => ({ group: g.group, series: g.points.map(([ts, rate]) => ({ ts, success_rate: rate, avg_latency_ms: 1 })) })) });
    }
    return { status: 404, text: async () => "{}" };
  });
  const stations = [own, ...upstreams];
  const rt = {
    store: { list: () => stations, get: (id) => stations.find((s) => s.id === id), settings: { lowBalanceUsd: 5 }, rules: { etaDays: 3 } },
    history: { predict: (id) => ({ up1: { burnPerDay: 10, etaDays: 10 }, up2: { burnPerDay: 50, etaDays: 2 }, up3: { burnPerDay: 5, etaDays: 30 } })[id] ?? null },
    reconciliation: { listRules: async () => rules, upstreamTokens: async () => [{ id: 11, name: "k", group: "vip" }] },
    _upstreamPricing: { pricingFor: async (station) => { const table = pricing[station.id]; if (!table) throw Object.assign(new Error("x"), { code: "MODEL_PRICE_UNREADABLE" }); return table; } },
    userOps,
  };
  return { rt, requests };
}

const rule = (upstreamStationId, channelIds, tokenId = 11) => ({ id: `r${channelIds.join("")}`, ownStationId: "own1", upstreamStationId, tokenId, channels: channelIds.map((channelId) => ({ channelId })), enabled: true });
const table = (item, groups = { default: 1, vip: 0.5 }) => ({ models: new Map([[item.model_name, item]]), groupRatio: new Map(Object.entries(groups)) });
const world = () => ({
  channels: [
    { id: 1, name: "渠道 1", models: ["gpt-5"], priority: 10 }, { id: 2, name: "渠道 2", models: ["gpt-5"] }, { id: 3, name: "渠道 3", models: ["glm"], status: 2 },
    { id: 4, name: "渠道 4", models: ["claude-x"] }, { id: 5, name: "渠道 5", models: ["deepseek-ai/DeepSeek-V3"], status: 3, otherInfo: JSON.stringify({ status_reason: "status code 401: Invalid token", status_time: 1793520000, secret: "keep-out" }) }, { id: 6, name: "渠道 6", models: ["gpt-5"], status: 2 },
  ],
  rows: [...usageRows("gpt-5", { week: 140, prev: 140, success: 90 }), ...usageRows("claude-x", { week: 140, prev: 28 }), ...usageRows("glm", { week: 70, prev: 70 }), ...usageRows("deepseek-ai/DeepSeek-V3", { week: 35, prev: 35 })],
  flow: [{ user: "alice", model: "gpt-5", channelId: 1, usd: 7 }, { user: "bob", model: "gpt-5", channelId: 2, usd: 3 }, { user: "alice", model: "claude-x", channelId: 4, usd: 5 }, { user: "root", model: "gpt-5", channelId: 1, usd: 1 }],
  perf: [["gpt-5", 80], ["claude-x", 99]],
  upstreams: [up("up1", "上游甲"), up("up2", "上游乙"), up("up3", "上游丙", { type: "sub2api" }), up("up4", "上游丁"), up("up5", "上游戊")],
  rules: [rule("up1", [1]), rule("up2", [2]), rule("up2", [4], 12), rule("up3", [6])],
  pricing: {
    up1: table({ model_name: "gpt-5", quota_type: 0, model_ratio: 2 }), up2: table({ model_name: "gpt-5", quota_type: 0, model_ratio: 1.6 }),
    up4: table({ model_name: "other-model", quota_type: 0, model_ratio: 1 }), up5: table({ model_name: "gpt-5", quota_type: 0, model_ratio: 1.2 }, { default: 1 }),
  },
  series: { "gpt-5": [{ group: "default", points: [[Math.floor((grid.starts[N - 3] + 2 * H) / 1000), 90], [Math.floor((grid.starts[N - 3] + 3 * H) / 1000), 100]] }] },
  userOps: { getUsers: () => [{ id: 7, username: "alice", role: 1 }, { id: 8, username: "root", role: 100 }] },
});
const pathsOf = (requests) => requests.map((r) => r.split("?")[0]);

test("整页：打开一次读渠道、按小时用量、模型 × 渠道流量、性能统计各一次（共 4 个请求），10 分钟内再开不重读，过了 10 分钟才再读", async (t) => {
  const { rt, requests } = makeRt(t, world());
  const page = await modelsPage(rt, { now: NOW });
  assert.deepEqual(pathsOf(requests).sort(), ["/api/channel/", "/api/data/", "/api/data/flow", "/api/perf-metrics/summary"]);
  assert.equal(requests.find((r) => r.startsWith("/api/perf-metrics/summary")), "/api/perf-metrics/summary?hours=24");
  const by = Object.fromEntries(page.rows.map((row) => [row.name, row]));
  // 有缺口的在前：按近 7 天消费 gpt-5(140) 和 claude-x(140) 一样按名字，再 glm(70)、deepseek(35)
  assert.deepEqual(page.rows.map((row) => row.name), ["claude-x", "gpt-5", "glm", "deepseek-ai/DeepSeek-V3"]);
  assert.deepEqual(by["gpt-5"].tags, ["fail"], "成功率 80%，成功 90 次估出 112 次：卖不出去；有两个上游、主要上游甲余额够");
  assert.deepEqual(by["claude-x"].tags, ["soon", "single", "rising"], "主要上游乙只够 2 天、只有这一家、近 7 天是前 7 天的 5 倍");
  assert.deepEqual(by.glm.tags, ["out"]);
  assert.equal(Object.hasOwn(by.glm, "flags") || Object.hasOwn(by.glm, "lost"), false, "页面不用的判断中间量不进响应");
  assert.deepEqual(by["deepseek-ai/DeepSeek-V3"].tags, ["out"], "被自动停用的渠道不算开着");
  assert.deepEqual([by["gpt-5"].supply, by.glm.supply], [{ upstreams: 2, open: 2, stopped: 1 }, { upstreams: 0, open: 0, stopped: 1 }]);
  // 货源还能撑：开着的渠道对应的上游里撑得最久的；gpt-5 有甲（10 天）和乙（2 天）：甲；claude-x 只有乙
  assert.deepEqual([by["gpt-5"].longest.name, by["gpt-5"].longest.runway.days, by["claude-x"].longest.name, by["claude-x"].longest.runway.days], ["上游甲", 10, "上游乙", 2]);
  assert.equal(Object.hasOwn(by["gpt-5"], "main"), false, "主要上游只留在抽屉里找货帮手用");
  assert.equal(page.perfEmpty, false);
  await modelsPage(rt, { now: NOW + 5 * 60000 });
  assert.equal(requests.length, 4, "10 分钟内不重读");
  await modelsPage(rt, { now: NOW + MODELS_TTL_MS + 1000 });
  // 按小时用量、流量、成功率重读；渠道列表和利润共用自己那份 10 分钟缓存（按真时钟），这里没过期，不再读
  assert.deepEqual(pathsOf(requests.slice(4)).sort(), ["/api/data/", "/api/data/flow", "/api/perf-metrics/summary"]);
});

test("同时来几个请求只读一次；渠道的 models、优先级随渠道列表读到，不带渠道的调用密钥", async (t) => {
  const { rt, requests } = makeRt(t, world());
  const [a, b] = await Promise.all([modelsPage(rt, { now: NOW }), modelsPage(rt, { now: NOW })]);
  assert.equal(requests.length, 4);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a).includes("secret"), false);
  const channels = rt._ownChannelsCache.list;
  assert.deepEqual([channels[0].models, channels[0].priority], [["gpt-5"], 10]);
});

test("读不到时降级：性能统计读不到 → 成功率写「读不到」、不判卖不出去；流量占比读不到 → 没有主要上游、不判快断货；其余照常", async (t) => {
  const { rt } = makeRt(t, { ...world(), failures: { "/api/perf-metrics/summary": 500, "/api/data/flow": 500 } });
  const page = await modelsPage(rt, { now: NOW });
  assert.deepEqual([page.perfReadable, page.flowReadable], [false, false]);
  const by = Object.fromEntries(page.rows.map((row) => [row.name, row]));
  assert.deepEqual([by["gpt-5"].success.state, by["gpt-5"].tags, by["gpt-5"].longest.name], ["unread", [], "上游甲"]);
  assert.deepEqual(by["claude-x"].tags, ["soon", "single", "rising"], "快断货只看渠道绑的上游，流量占比读不到也照判");
  assert.deepEqual(by.glm.tags, ["out"], "断货不靠这两样");
});

test("渠道列表读不到、或按小时用量读不到：整页读不到（抛错）", async (t) => {
  const { rt } = makeRt(t, { ...world(), failures: { "/api/channel/": 500 } });
  await assert.rejects(modelsPage(rt, { now: NOW }));
  const second = makeRt(t, { ...world(), failures: { "/api/data/": 500 } });
  await assert.rejects(modelsPage(second.rt, { now: NOW }));
  // 站点读不到时 10 分钟内不再去读（同一个错直接给），不是每次打开页面都重读
  const reads = () => second.requests.filter((r) => r.startsWith("/api/data/") && !r.startsWith("/api/data/flow")).length;
  const first = reads();
  await assert.rejects(modelsPage(second.rt, { now: NOW + 60000 }));
  assert.equal(reads(), first, "按小时用量读失败后 10 分钟内不再读");
});

test("整页读失败：2 分钟内再开不重读（直接给同一个错），过了 2 分钟才再试；渠道列表读失败也一样", async (t) => {
  const { rt, requests } = makeRt(t, { ...world(), failures: { "/api/channel/": 500 } });
  const base = Date.now(); // 读失败会让断路开 1 分钟（按真时钟记），用真时钟做起点才看得出「过了 2 分钟」
  await assert.rejects(modelsPage(rt, { now: base }));
  const first = requests.length;
  for (const minute of [1, 1.5]) await assert.rejects(modelsPage(rt, { now: base + minute * 60000 }));
  assert.equal(requests.length, first, "2 分钟里每分钟刷新也不再发请求");
  await assert.rejects(modelsPage(rt, { now: base + MODELS_FAIL_TTL_MS + 1000 }));
  assert.ok(requests.length > first, "过了 2 分钟再试一次");
});

test("额度和断路：断路开着时打开页面和抽屉一个请求都不发，也不记成读失败；额度快满时同样", async (t) => {
  const { rt, requests } = makeRt(t, world());
  noteOwnRequest("https://own.test/x", { status: 503, now: NOW });
  await assert.rejects(modelsPage(rt, { now: NOW + 1000 }), (error) => error.code === "BUSY");
  assert.deepEqual(requests, [], "断路开着：一个请求都不发");
  assert.equal(rt._modelsPage ?? null, null, "被拦下的不记");
  // 断路过了（最短 1 分钟）、额度够：马上就能读，不用等失败的那 2 分钟
  const page = await modelsPage(rt, { now: NOW + 2 * 60000 });
  assert.equal(page.rows.length, 4);
  assert.ok(requests.length >= 4);
  // 额度快满：300 个请求（限额 360 的 60% 之内要留出一个）
  const full = makeRt(t, world());
  for (let i = 0; i < 300; i += 1) noteOwnRequest("https://own.test/x", { status: 200, now: NOW });
  await assert.rejects(modelsPage(full.rt, { now: NOW + 1000 }), (error) => error.code === "BUSY");
  assert.deepEqual(full.requests, []);
});

test("额度和断路：抽屉的成功率序列也不发，成功率线写读不到、不缓存；额度回来再开就读", async (t) => {
  const { rt, requests } = makeRt(t, world());
  await modelsPage(rt, { now: NOW });
  const before = requests.length;
  noteOwnRequest("https://own.test/x", { status: 429, now: NOW });
  const blocked = await modelDetail(rt, "gpt-5", { now: NOW + 1000 });
  assert.equal(blocked.successLine, null);
  assert.equal(requests.length, before, "断路开着：序列不发");
  const later = await modelDetail(rt, "gpt-5", { now: NOW + 3 * 60000 });
  assert.ok(later.successLine, "不缓存被拦下的");
  assert.equal(requests.length, before + 1);
});

test("没设置自营站点：unset", async (t) => {
  const { rt } = makeRt(t, world());
  rt.store.list = () => [];
  assert.deepEqual(await modelsPage(rt, { now: NOW }), { unset: true });
  assert.deepEqual(await modelDetail(rt, "gpt-5", { now: NOW }), { unset: true });
});

test("抽屉：多读成功率时间序列一个请求（模型名里的「/」照常编码），渠道和上游、谁在用、找货帮手都在；30 天线按小时加权", async (t) => {
  const { rt, requests } = makeRt(t, world());
  await modelsPage(rt, { now: NOW });
  const before = requests.length;
  const detail = await modelDetail(rt, "gpt-5", { now: NOW });
  assert.deepEqual(pathsOf(requests.slice(before)), ["/api/perf-metrics"], "抽屉只多读自营站点 1 个请求");
  assert.equal(requests.at(-1), "/api/perf-metrics?model=gpt-5&hours=720");
  assert.equal(detail.successLine.points.length, 30);
  assert.equal(detail.successLine.points[N - 3].rate, 95, "一天里有数据的两个小时（90、100）等权平均");
  assert.deepEqual(detail.channels.map((c) => [c.channelId, c.state, c.upstream?.id ?? null]), [[1, "on", "up1"], [2, "on", "up2"], [6, "off", "up3"]]);
  assert.deepEqual(detail.users.top.map((u) => [u.user, u.userId]), [["alice", 7], ["bob", null], ["root", null]], "管理员用户运营不认得，没有链接");
  await modelDetail(rt, "gpt-5", { now: NOW + 60000 });
  assert.equal(requests.filter((r) => r.startsWith("/api/perf-metrics?")).length, 1, "成功率序列缓存 10 分钟");
  const slash = await modelDetail(rt, "deepseek-ai/DeepSeek-V3", { now: NOW });
  assert.equal(requests.at(-1), "/api/perf-metrics?model=deepseek-ai%2FDeepSeek-V3&hours=720");
  assert.equal(slash.name, "deepseek-ai/DeepSeek-V3");
  // 被自动停用的渠道：停用原因和时间（只这两个字段）；启用着的、手动停用的渠道不带
  assert.deepEqual([slash.channels[0].state, slash.channels[0].stopReason, slash.channels[0].stopTime], ["auto", "status code 401: Invalid token", 1793520000000]);
  assert.equal(JSON.stringify(slash).includes("keep-out"), false);
  assert.deepEqual(detail.channels.map((c) => "stopReason" in c), [false, false, false]);
  assert.equal(slash.successLine.points.every((p) => p.rate == null), true, "没有点就是 null，不画 0");
});

test("找货帮手：价格按「倍率 × 你在那边的分组倍率」从低到高；新上游没有分组时按 default；Sub2API 在供写读不到价格；价目表里没有这个模型又没渠道的不列", async (t) => {
  const { rt } = makeRt(t, world());
  await modelsPage(rt, { now: NOW });
  const { finder } = await modelDetail(rt, "gpt-5", { now: NOW });
  assert.deepEqual(finder.map((row) => row.upstreamId), ["up2", "up1", "up5", "up3"]);
  const by = Object.fromEntries(finder.map((row) => [row.upstreamId, row]));
  // 上游甲 2 × vip 0.5 = 1（现在主要用的）；乙 1.6 × 0.5 = 0.8（便宜 20%）；戊没有绑定、没有 vip 用 default 1：1.2 × 1 = 1.2（贵 20%）；排序按价格：乙 0.8、甲 1、戊 1.2
  assert.deepEqual(finder.map((row) => row.price?.value ?? null), [0.8, 1, 1.2, null]);
  assert.deepEqual([by.up1.main, by.up1.compare, by.up2.compare?.kind, by.up5.compare?.kind, by.up3.readable], [true, null, "cheaper", "pricier", false]);
  assert.deepEqual([by.up1.supplying, by.up2.supplying, by.up5.supplying, by.up3.supplying], [true, true, false, false], "上游丙只有被停用的渠道：还没在供");
  assert.equal(by.up3.price, null);
  assert.equal(finder.some((row) => row.upstreamId === "up4"), false);
});

test("抽屉：模型近 30 天没有消费（不在整页里）是 notFound", async (t) => {
  const { rt } = makeRt(t, world());
  assert.deepEqual(await modelDetail(rt, "never-sold", { now: NOW }), { notFound: true });
});
