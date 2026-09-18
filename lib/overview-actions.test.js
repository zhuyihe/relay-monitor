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
