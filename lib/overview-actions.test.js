import assert from "node:assert/strict";
import test from "node:test";
import { buildOverviewActions } from "./overview-actions.js";

const NOW = Date.parse("2026-09-18T12:00:00");
const statusOf = (station) => station.status || "ok";

test("overview actions prioritize failures and keep only one action per resource", () => {
  const { all } = buildOverviewActions([
    { id: "low", name: "余额偏低", balance: { ok: true, remaining: 2 }, status: "warn", prediction: { etaDays: 1, burnPerDay: 1 } },
    { id: "broken", name: "查询失败", balance: { ok: false, error: "Bearer should-not-be-rendered" } },
    { id: "eta", name: "即将耗尽", balance: { ok: true, remaining: 50 }, prediction: { etaDays: 2, burnPerDay: 10 } },
  ], { now: NOW, rules: { etaDays: 3 }, statusOf });

  assert.deepEqual(all.map((action) => [action.stationId, action.kind]), [
    ["broken", "query-failed"],
    ["low", "balance-low"],
    ["eta", "eta-soon"],
  ]);
});

test("overview actions honor no-renewal and only flag active fixed purchases nearing expiry", () => {
  const { all } = buildOverviewActions([
    { id: "paused", name: "无需续费", noRenewal: true, balance: { ok: true, remaining: 1 }, status: "warn", prediction: { etaDays: 1, burnPerDay: 1 } },
    { id: "paused-error", name: "无需续费但查询失败", noRenewal: true, balance: { ok: false } },
    { id: "fixed-soon", name: "固定成本即将到期", type: "fixed", fixedPurchases: [{ amount: 100, days: 3, startDate: "2026-09-17" }] },
    { id: "fixed-later", name: "固定成本尚早", type: "fixed", fixedPurchases: [{ amount: 100, days: 10, startDate: "2026-09-17" }] },
    { id: "fixed-future", name: "未开始固定成本", type: "fixed", fixedPurchases: [{ amount: 100, days: 1, startDate: "2026-09-20" }] },
  ], { now: NOW, rules: { etaDays: 3 }, statusOf });

  assert.deepEqual(all.map((action) => [action.stationId, action.kind]), [
    ["paused-error", "query-failed"],
    ["fixed-soon", "fixed-expiring"],
  ]);
});

test("overview actions cap the visible list without changing total action count", () => {
  const stations = Array.from({ length: 6 }, (_, index) => ({
    id: `failure-${index}`,
    name: `失败资源 ${index}`,
    balance: { ok: false },
  }));
  const actions = buildOverviewActions(stations, { now: NOW, statusOf, limit: 5 });

  assert.equal(actions.all.length, 6);
  assert.equal(actions.visible.length, 5);
});

test("overview merges stable workflow actions, deduplicates equivalent destinations and retains resource severity", () => {
  const workflow = (id, kind, href) => ({ id, kind, href, label: kind, stationId: null, ruleId: "rule-1", channelIds: [] });
  const actions = buildOverviewActions([{ id: "low", balance: { ok: true, remaining: 1 }, status: "danger" }], {
    statusOf, workflowActions: [
      workflow("coverage-original", "confirm_coverage", "/stations?action=coverage&ruleId=rule-1"),
      workflow("coverage-repeated", "confirm_coverage", "/stations?ruleId=rule-1&action=coverage"),
      workflow("retry", "retry_bill", "/reconciliation?action=retry&ruleId=rule-1&startMs=1&endMs=2&timezone=UTC"),
      workflow("auth", "update_authorization", "/stations?action=authorization&accountKey=account-1"),
      workflow("inspect", "inspect_balance", "/stations?stationId=healthy"),
      workflow("external", "retry_bill", "https://elsewhere.test"),
    ],
  });
  assert.deepEqual(actions.all.map((action) => action.id), ["auth", "monitor:low:balance-danger", "coverage-original", "retry"]);
  assert.equal(actions.all[1].href, "/stations?stationId=low");
  assert.equal(actions.all.filter((action) => action.kind === "confirm_coverage").length, 1);
});

test("merged resource actions select one severity winner before taking the five visible slots", () => {
  const stations = Array.from({ length: 5 }, (_, index) => ({ id: `st-${index}`, name: `资源 ${index}`,
    balance: { ok: index > 1, remaining: 5 }, status: "warn" }));
  const workflowActions = stations.map((station) => ({ id: `verify:${station.id}`, kind: "verify_capability",
    label: "核验账单能力", stationId: station.id, ruleId: `legacy:${station.id}`, channelIds: [],
    href: `/stations?action=verify-billing&stationId=${station.id}` }));
  const { all, visible } = buildOverviewActions(stations, { statusOf, workflowActions });
  assert.equal(all.length, 5);
  assert.deepEqual(new Set(visible.map((action) => action.stationId)), new Set(stations.map((station) => station.id)));
  assert.deepEqual(all.map((action) => action.kind), ["query-failed", "query-failed", "verify_capability", "verify_capability", "verify_capability"]);
});

test("resource winners keep independently addressed account, rule and channel actions", () => {
  const target = { stationId: "st", label: "处理", channelIds: [] };
  const { all } = buildOverviewActions([{ id: "st", balance: { ok: false } }], { statusOf, workflowActions: [
    { ...target, id: "verify", kind: "verify_identity", href: "/stations?action=verify&stationId=st" },
    { ...target, id: "account", kind: "update_authorization", href: "/stations?action=authorization&accountKey=account" },
    { ...target, id: "rule", kind: "confirm_coverage", href: "/stations?action=coverage&ruleId=rule&stationId=st" },
    { ...target, id: "channels", kind: "connect_channels", href: "/stations?action=connect&ownStationId=own&channelIds=1&stationId=st" },
  ] });
  assert.deepEqual(new Set(all.map((action) => action.id)), new Set(["monitor:st:query-failed", "account", "rule", "channels"]));
});
