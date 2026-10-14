import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFlow, computeProfit, joinPrev, mapCostChannels, matchCostStation, normalizeCostUrl,
  reconcileUsageCost, resolveOwnWindow, selectCostUpstreams,
} from "./own-helpers.js";
import { History } from "../db/history.js";
import { dayStartInTz } from "../lib/business-time.js";

test("成本渠道支持主地址、api 后缀和显式别名匹配", () => {
  const publicStation = { id: "public", baseUrl: "https://relay.example.com/" };
  const internalStation = {
    id: "internal",
    baseUrl: "https://public.example.com",
    costAliases: ["sub2api-internal", "http://10.0.0.8:8080/api/"],
  };

  assert.equal(normalizeCostUrl(" HTTPS://Relay.Example.com/ "), "relay.example.com");
  assert.equal(matchCostStation([publicStation], "https://relay.example.com/api"), publicStation);
  assert.equal(matchCostStation([internalStation], "http://sub2api-internal/v1"), internalStation);
  assert.equal(matchCostStation([internalStation], "http://10.0.0.8:8080"), internalStation);
  assert.equal(matchCostStation([publicStation], "https://other.example.com"), null);
});

test("用量接口返回零但余额下降时改用历史成本", () => {
  assert.deepEqual(reconcileUsageCost(0, 34.24), {
    usd: 34.24,
    mode: "history",
    note: "用量接口返回 0，已按余额历史推算",
  });
});

test("未出现在 New API 渠道中的监控上游仍计入成本", () => {
  const own = { id: "own", isOwn: true };
  const visible = { id: "visible", baseUrl: "https://visible.example.com" };
  const behindSub2Api = { id: "hidden", baseUrl: "https://hidden.example.com" };
  const excluded = { id: "observe", baseUrl: "https://observe.example.com", includeInProfit: false };
  const channels = [{ name: "Sub2API 统一入口", baseUrl: "http://sub2api-internal", status: 1, type: 1 }];

  const selected = selectCostUpstreams([own, visible, behindSub2Api, excluded], own.id);
  assert.deepEqual(selected.included.map((s) => s.id), [visible.id, behindSub2Api.id]);
  assert.deepEqual(selected.excluded.map((s) => s.id), [excluded.id]);

  const attribution = mapCostChannels(selected.included, channels);
  assert.equal(attribution.matched.size, 0);
  assert.equal(attribution.unmatched.size, 1);
});

test("账单专用授权硬排除成本，不能被 includeInProfit 覆盖", () => {
  const own = { id: "own", isOwn: true };
  const grant = { id: "grant", monitorEnabled: false, includeInProfit: true };
  const monitored = { id: "monitored", includeInProfit: true };
  const result = selectCostUpstreams([own, grant, monitored], own.id);
  assert.deepEqual(result.included, [monitored]);
  assert.deepEqual(result.excluded, []);
});

test("用量接口有有效成本时保持接口口径", () => {
  assert.deepEqual(reconcileUsageCost(4.1675, 4.16), {
    usd: 4.1675,
    mode: "usage",
    note: null,
  });
});

test("流向数据按维度聚合并与上一等长窗口对比", () => {
  const cur = [
    { user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol", tokens: 100, cost: 152, requests: 596 },
    { user: "b", group: "default", model: "gpt-4o", channelId: 1, channelName: "luna", tokens: 900, cost: 20, requests: 30 },
  ];
  const prev = [
    { user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol", tokens: 90, cost: 11, requests: 49 },
  ];
  const byGroup = joinPrev(
    aggregateFlow(cur, (r) => r.group, "group"),
    aggregateFlow(prev, (r) => r.group, "group"),
    "group"
  );
  assert.deepEqual(byGroup.map((r) => [r.group, r.cost, r.prevCost, r.deltaPct, r.isNew]), [
    ["grok", 152, 11, 1281.8, false],
    ["default", 20, 0, null, true],
  ]);

  // 空维度值（没有分组的行）不参与聚合，否则会多出一行「」
  assert.equal(aggregateFlow([{ group: "", tokens: 1, cost: 1, requests: 1 }], (r) => r.group, "group").length, 0);
});

test("展示窗口的上一窗与当窗等长且左移整窗", () => {
  const sp = new URLSearchParams({ range: "7d", tz: "Asia/Shanghai" });
  const w = resolveOwnWindow(sp);
  assert.equal(w.range, "7d");
  assert.equal(w.spanDays, 7);
  assert.equal(w.startMs - w.prevStart, 7 * 86400000);
  assert.equal(w.now - w.startMs, w.prevEnd - w.prevStart);

  const today = resolveOwnWindow(new URLSearchParams({ range: "today", tz: "Asia/Shanghai" }));
  assert.equal(today.startMs - today.prevStart, 86400000); // 今天 → 昨天同一时刻为止
});

test("展示窗口统一按业务时区划日，不跟随浏览器传来的 tz", () => {
  const now = Date.UTC(2026, 9, 14, 2, 30); // 北京时间 10 月 14 日 10:30，洛杉矶仍是 13 日
  const fromBrowser = resolveOwnWindow(new URLSearchParams({ range: "today", tz: "America/Los_Angeles" }), now);
  const plain = resolveOwnWindow(new URLSearchParams({ range: "today" }), now);
  assert.equal(fromBrowser.tz, "Asia/Shanghai");
  assert.equal(fromBrowser.startMs, Date.UTC(2026, 9, 13, 16));
  assert.deepEqual(fromBrowser, plain);
  assert.equal(resolveOwnWindow(new URLSearchParams({ range: "nope" }), now).range, "7d");
});

test("利润拆成毛利与净利：固定付费上游只按摊销计，余额推算截止到窗口终点", async () => {
  const SH = "Asia/Shanghai";
  const startMs = dayStartInTz("2026-10-13", SH);
  const now = startMs + 86400000; // 日报口径：算完整的 10 月 13 日
  const own = { id: "own", name: "自营", isOwn: true, type: "newapi", cnyPerUsd: 2 };
  // newapi-key 没有用量明细接口，会直接退回余额历史，不发网络请求
  const usage = { id: "u", name: "按量上游", type: "newapi-key", cnyPerUsd: 7 };
  const fixed = {
    id: "f", name: "包月上游", type: "newapi-key", cnyPerUsd: 7,
    fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }],
  };
  const history = new History({ query: async () => [[]] });
  history.data.u = [[startMs - 1000, 10], [startMs + 3600000, 9], [now - 1000, 8], [now + 3600000, 5]];
  // 包月上游的余额下降不能再算一遍成本
  history.data.f = [[startMs - 1000, 10], [startMs + 3600000, 4]];
  const rt = {
    store: { list: () => [own, usage, fixed] },
    history,
    _ownChannelsCache: { at: Date.now(), stationId: "own", list: [] },
  };
  const p = await computeProfit(rt, own, 50, 0, { startMs, now, tz: SH, range: "7d", resold: null });
  assert.equal(p.error, undefined);
  assert.equal(p.incomeCny, 100);
  // 只计到 now 为止：10 → 8，今天的 8 → 5 不算
  assert.equal(p.upstreamCostCny, 14);
  assert.equal(p.fixedCostCny, 10);
  assert.equal(p.grossProfitCny, 86);
  assert.equal(p.netProfitCny, 76);
  assert.equal(p.grossMarginPct, 86);
  assert.equal(p.netMarginPct, 76);
  // 旧字段保持兼容：利润即净利
  assert.equal(p.totalCostCny, 24);
  assert.equal(p.profitCny, 76);
  assert.equal(p.marginPct, 76);
  assert.deepEqual(p.costs.map((c) => [c.stationId, c.mode]), [["u", "history"], ["f", "fixed"]]);
});
