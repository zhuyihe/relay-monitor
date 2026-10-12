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
  assert.deepEqual(actions.all.map((action) => action.id), ["monitor:low:balance-danger", "auth", "coverage-original", "retry"]);
  assert.equal(actions.all[0].href, "/stations?stationId=low");
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
  // 同为“注意”时余额问题排在账号待办前面，账号待办留在 others 里
  assert.deepEqual(all.map((action) => action.kind), ["query-failed", "query-failed", "balance-low", "balance-low", "balance-low"]);
  assert.deepEqual(all.map((action) => action.others.map((other) => other.kind)), Array(5).fill(["verify_capability"]));
  assert.ok(all.every((action) => action.anchored));
});

test("urgent balance and ETA lead their resource row instead of hiding behind account todos", () => {
  const workflow = (stationId, kind) => ({ id: `${kind}:${stationId}`, kind, label: "核验账号", stationId, channelIds: [],
    href: `/stations?action=verify&stationId=${stationId}` });
  const { all } = buildOverviewActions([
    { id: "drain", name: "快耗尽", balance: { ok: true, remaining: 30 }, prediction: { etaDays: 1.5, burnPerDay: 20 } },
    { id: "low", name: "偏低", balance: { ok: true, remaining: 3 }, status: "warn", prediction: { etaDays: 2, burnPerDay: 1.5 } },
    { id: "week", name: "一周内", balance: { ok: true, remaining: 60 }, prediction: { etaDays: 5, burnPerDay: 12 } },
    { id: "calm", name: "充足", balance: { ok: true, remaining: 900 }, prediction: { etaDays: 40, burnPerDay: 20 } },
  ], { now: NOW, rules: { etaDays: 3 }, statusOf, workflowActions: [
    workflow("drain", "verify_identity"), workflow("low", "verify_capability"), workflow("calm", "verify_identity"),
  ] });
  assert.deepEqual(all.map((action) => [action.stationId, action.kind, action.level]), [
    ["low", "balance-low", "crit"],
    ["drain", "eta-soon", "crit"],
    ["week", "eta-soon", "warn"],
    ["calm", "verify_identity", "warn"],
  ]);
  assert.deepEqual(all[1].others.map((other) => other.kind), ["verify_identity"]);
  assert.equal(all[3].stationName, "充足");
});

test("account and bill todos carry their own level and sort after urgent resources", () => {
  const { all } = buildOverviewActions([{ id: "st", name: "资源", balance: { ok: true, remaining: 1 }, status: "warn" }], {
    statusOf, workflowActions: [
      { id: "conflict", kind: "review_conflict", label: "冲突", stationId: null, channelIds: [], href: "/reconciliation?action=conflict&ruleId=r" },
      { id: "wait", kind: "wait_effective", label: "等待", stationId: null, channelIds: [], href: "/stations?action=wait&ruleId=r" },
    ],
  });
  assert.deepEqual(all.map((action) => [action.id, action.level]), [
    ["conflict", "crit"],
    ["monitor:st:balance-low", "warn"],
    ["wait", "warn"],
  ]);
  assert.equal(all[0].anchored, undefined);
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
