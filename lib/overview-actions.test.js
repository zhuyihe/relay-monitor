import assert from "node:assert/strict";
import test from "node:test";
import { balanceDaysText, balanceStateOf, balanceViewOf, buildOverviewActions, etaWindowDays, lowLineOf, runwayLevel, stationDisplayName } from "./overview-actions.js";
import { fixedCostNowOf } from "./profit.js";

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

test("固定成本快到期按业务时区算：开始日期是业务时区的 0:00，和运行环境的时区无关（和上游列表同一个算法）", () => {
  // 9月17日起 3 天：上海时间 9月20日 0:00（UTC 9月19日 16:00）到期
  const station = { id: "fixed", name: "固定", type: "fixed", fixedPurchases: [{ amount: 100, days: 3, startDate: "2026-09-17" }] };
  const actionsAt = (now, tz) => buildOverviewActions([station], { now, tz, rules: { etaDays: 3 }, statusOf }).all;
  const before = actionsAt(Date.parse("2026-09-19T15:30:00Z"), "Asia/Shanghai");
  assert.deepEqual(before.map((a) => [a.kind, a.endAt, a.daysRemaining]), [["fixed-expiring", Date.parse("2026-09-19T16:00:00Z"), 1]]);
  // 上海已经过了 9月20日 0:00：到期了，不再提醒（原来按运行环境的时区算，UTC、洛杉矶下还会提醒）
  assert.deepEqual(actionsAt(Date.parse("2026-09-19T17:00:00Z"), "Asia/Shanghai"), []);
  // 业务时区换成洛杉矶，同一时刻还没到期
  assert.deepEqual(actionsAt(Date.parse("2026-09-19T17:00:00Z"), "America/Los_Angeles").map((a) => a.endAt), [Date.parse("2026-09-20T07:00:00Z")]);
  // 不传按默认业务时区（上海）
  assert.deepEqual(buildOverviewActions([station], { now: Date.parse("2026-09-19T17:00:00Z"), rules: { etaDays: 3 }, statusOf }).all, []);
  // 和上游列表「N 天后到期」同一个算法
  assert.equal(before[0].endAt, fixedCostNowOf(station.fixedPurchases, { now: Date.parse("2026-09-19T15:30:00Z"), tz: "Asia/Shanghai" }).nextEnd);
  // 金额不对的付费记录（负数、不是数字）不算，和上游列表一致（原来照样提醒快到期）
  for (const amount of [-1, "abc"]) {
    const bad = { ...station, fixedPurchases: [{ amount, days: 3, startDate: "2026-09-17" }] };
    assert.deepEqual(buildOverviewActions([bad], { now: Date.parse("2026-09-19T15:30:00Z"), tz: "Asia/Shanghai", rules: { etaDays: 3 }, statusOf }).all, []);
  }
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
    label: "测试读取", stationId: station.id, ruleId: `legacy:${station.id}`, channelIds: [],
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
  const workflow = (stationId, kind) => ({ id: `${kind}:${stationId}`, kind, label: "测试读取", stationId, channelIds: [],
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
      { id: "conflict", kind: "review_conflict", label: "冲突", stationId: null, channelIds: [], href: "/stations?action=conflict&ruleId=r" },
      { id: "wait", kind: "connect_channels", label: "去绑定", stationId: null, channelIds: [1], href: "/stations?action=connect&ownStationId=own&channelIds=1" },
      { id: "refresh", kind: "refresh", label: "刷新", stationId: null, channelIds: [], href: null },
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

test("balanceStateOf: 没读到、读不到、用完、低于提醒线、正常；上游自己的提醒线优先", () => {
  const settings = { lowBalanceUsd: 5 };
  assert.equal(balanceStateOf({}, settings), "pending");
  assert.equal(balanceStateOf({ balance: { ok: false } }, settings), "error");
  assert.equal(balanceStateOf({ balance: { ok: true, remaining: 0 } }, settings), "danger");
  assert.equal(balanceStateOf({ balance: { ok: true, remaining: 4.99 } }, settings), "warn");
  assert.equal(balanceStateOf({ balance: { ok: true, remaining: 5 } }, settings), "ok");
  assert.equal(balanceStateOf({ lowBalanceUsd: 20, balance: { ok: true, remaining: 10 } }, settings), "warn");
  assert.equal(balanceStateOf({ lowBalanceUsd: "", balance: { ok: true, remaining: 10 } }, settings), "ok");
  // 不传设置时按 5 美元
  assert.equal(balanceStateOf({ balance: { ok: true, remaining: 4 } }), "warn");
  assert.equal(lowLineOf({}), 5);
  assert.equal(lowLineOf({ lowBalanceUsd: 0 }, settings), 0);
});

test("buildOverviewActions 不传 statusOf 时按 balanceStateOf 判档", () => {
  const { all } = buildOverviewActions([
    { id: "empty", name: "用完", balance: { ok: true, remaining: 0 } },
    { id: "low", name: "偏低", lowBalanceUsd: 10, balance: { ok: true, remaining: 8 } },
    { id: "fine", name: "正常", balance: { ok: true, remaining: 100 } },
  ], { now: NOW, settings: { lowBalanceUsd: 5 } });
  assert.deepEqual(all.map((action) => [action.stationId, action.kind]), [["empty", "balance-danger"], ["low", "balance-low"]]);
  assert.throws(() => buildOverviewActions([], { statusOf: "ok" }), TypeError);
});

test("runwayLevel: 提醒天数以内红、7 天以内黄，两条线含端点", () => {
  const rules = { etaDays: 3 };
  assert.equal(runwayLevel(0, rules), "crit");
  assert.equal(runwayLevel(3, rules), "crit");
  assert.equal(runwayLevel(3.01, rules), "warn");
  assert.equal(runwayLevel(7, rules), "warn");
  assert.equal(runwayLevel(7.01, rules), "good");
  // 提醒天数比 7 天长时，黄档并进红档
  assert.equal(runwayLevel(8, { etaDays: 10 }), "crit");
  assert.equal(runwayLevel(11, { etaDays: 10 }), "good");
  // 算不出天数的不分档，不能当成 0 天标红
  for (const days of [null, undefined, "", "2", NaN, Infinity]) assert.equal(runwayLevel(days, rules), null);
  assert.equal(etaWindowDays({}), 3);
  assert.equal(etaWindowDays({ etaDays: "0" }), 3);
  assert.equal(etaWindowDays({ etaDays: 0.5 }), 0.5);
});

test("stationDisplayName: 没有名字写未命名上游", () => {
  assert.equal(stationDisplayName({ name: "  A 站 " }), "A 站");
  assert.equal(stationDisplayName({ name: "" }), "未命名上游");
  assert.equal(stationDisplayName(null), "未命名上游");
});

test("balanceViewOf: 状态、颜色和可用天数，分档和 runwayLevel 一致", () => {
  const opts = { settings: { lowBalanceUsd: 5 }, rules: { etaDays: 3 } };
  const view = (balance, prediction, extra = {}) => balanceViewOf({ balance, prediction, ...extra }, opts);
  const ok = (remaining) => ({ ok: true, remaining });
  assert.deepEqual(balanceViewOf({}, opts), { state: "pending", level: "muted", days: null });
  assert.deepEqual(view({ ok: false }), { state: "unreadable", level: "crit", days: null });
  assert.deepEqual(view(ok(0), { burnPerDay: 2, etaDays: 0 }), { state: "empty", level: "crit", days: 0 });
  // 低于提醒线：可用天数进了提醒天数就是红，否则黄
  assert.deepEqual(view(ok(4), { burnPerDay: 1, etaDays: 4 }), { state: "low", level: "warn", days: 4 });
  assert.deepEqual(view(ok(4), { burnPerDay: 2, etaDays: 2 }), { state: "low", level: "crit", days: 2 });
  assert.deepEqual(view(ok(4)), { state: "low", level: "warn", days: null });
  // 余额还够、但花得快
  assert.deepEqual(view(ok(100), { burnPerDay: 50, etaDays: 2 }), { state: "soon", level: "crit", days: 2 });
  assert.deepEqual(view(ok(100), { burnPerDay: 20, etaDays: 5 }), { state: "soon", level: "warn", days: 5 });
  assert.deepEqual(view(ok(100), { burnPerDay: 10, etaDays: 10 }), { state: null, level: "good", days: 10 });
  assert.deepEqual(view(ok(100), { burnPerDay: 10, etaDays: -1 }), { state: "soon", level: "crit", days: 0 });
  // 近期没有花费是 Infinity，不分档；没有预测时算不出
  assert.deepEqual(view(ok(100), { burnPerDay: 0, etaDays: null }), { state: null, level: "good", days: Infinity });
  assert.deepEqual(view(ok(100)), { state: null, level: "muted", days: null });
  // 不再续费的、自营站点照样标状态，但不上颜色
  assert.deepEqual(view(ok(100), { burnPerDay: 50, etaDays: 2 }, { noRenewal: true }), { state: "soon", level: "muted", days: 2 });
  assert.deepEqual(view(ok(0), { burnPerDay: 2, etaDays: 0 }, { isOwn: true }), { state: "empty", level: "muted", days: 0 });
  assert.deepEqual(view(ok(100), { burnPerDay: 10, etaDays: 10 }, { isOwn: true }), { state: null, level: "good", days: 10 });
});

test("balanceDaysText: 余额用完写「—」，其余和 formatDays 一致", () => {
  const opts = { settings: { lowBalanceUsd: 5 }, rules: { etaDays: 3 } };
  const text = (balance, prediction) => balanceDaysText(balanceViewOf({ balance, prediction }, opts));
  assert.equal(text({ ok: true, remaining: 0 }, { burnPerDay: 2, etaDays: 0 }), "—");
  assert.equal(text({ ok: true, remaining: 20 }, { burnPerDay: 2, etaDays: 10 }), "约 10 天");
  assert.equal(text({ ok: true, remaining: 20 }, { burnPerDay: 0, etaDays: null }), "近期没有花费");
  assert.equal(text({ ok: true, remaining: 20 }, null), "—");
  assert.equal(text({ ok: false, error: "x" }, null), "—");
  assert.equal(text(undefined, null), "—");
  assert.equal(balanceDaysText(null), "—");
});
