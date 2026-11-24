import test from "node:test";
import assert from "node:assert/strict";
import { buildUserGroupPage, resolveUserGroupsWindow, userGroupsPage } from "./user-groups.js";
import { resetOwnRequestBudget } from "../lib/own-request-budget.js";

const now = Date.parse("2026-11-24T08:00:00Z"), startMs = Date.parse("2026-11-23T16:00:00Z");
const directory = [{ id: 1, username: "alice", role: 1, status: 1, quotaUsd: 88, group: "vip" }, { id: 2, username: "bob", role: 1, status: 1, quotaUsd: 9, group: "standard" }, { id: 3, username: "root", role: 100, status: 1, quotaUsd: 999 }];
const input = (patch = {}) => ({ directory, ready: true, live: false, startMs, endMs: now, asOf: now, balanceAt: now, rate: 1, intervalMs: 60000, tz: "Asia/Shanghai", preset: "today",
  usage: [{ key: "alice", quotaUnits: 5000000, requests: 10 }, { key: "bob", quotaUnits: 500000, requests: 1 }, { key: "root", quotaUnits: 50000000, requests: 100 }],
  flow: [{ user: "alice", group: "AWSB全模型-不带F-Coding", model: "model-a", channelId: 1, quotaUnits: 2000000, requests: 4 }, { user: "alice", group: "AWSB全模型-不带F-Coding", model: "model-b", channelId: 2, quotaUnits: 1500000, requests: 3 }, { user: "alice", group: "A社官转不带F", model: "model-a", channelId: 1, quotaUnits: 1000000, requests: 2 }, { user: "bob", group: "A社官转不带F", quotaUnits: 500000, requests: 1 }], ...patch });

test("按用户的实际渠道分组合并模型和渠道，管理员不计入，不重新乘倍率", () => {
  const page = buildUserGroupPage(input());
  assert.equal(page.list.total, 2); assert.equal(page.summary.amount, 11);
  const alice = page.list.rows[0];
  assert.equal(alice.total, 10);
  assert.deepEqual(alice.groups.map(group => [group.name, group.amount, group.share]), [["AWSB全模型-不带F-Coding", 7, .7], ["A社官转不带F", 2, .2], [null, 1, .1]]);
  assert.equal(alice.groups.reduce((sum, group) => sum + group.amount, 0), alice.total);
  assert.equal(alice.balanceUsd, 88);
});

test("当前倍率优先匹配客户的账户分组，专属零倍率有效，历史金额不随当前倍率重算", () => {
  const ratios = { base: { "AWSB全模型-不带F-Coding": 3.8, "A社官转不带F": 4 }, overrides: { vip: { "AWSB全模型-不带F-Coding": 2.8, "A社官转不带F": 0 }, alice: { "AWSB全模型-不带F-Coding": 99 } } };
  const page = buildUserGroupPage(input({ ratios, ratiosAt: now }));
  const alice = page.list.rows.find(row => row.id === 1), bob = page.list.rows.find(row => row.id === 2);
  assert.deepEqual(alice.groups.map(group => [group.ratio, group.ratioSource]), [[2.8, "user"], [0, "user"], [null, null]]);
  assert.equal(bob.groups[0].ratio, 4); assert.equal(bob.groups[0].ratioSource, "group");
  assert.equal(page.ratiosAt, now); assert.equal(page.summary.amount, 11); assert.equal(alice.total, 10);
  assert.deepEqual(alice.groups.map(group => group.amount), [7, 2, 1]);
  const missing = buildUserGroupPage(input({ ratios: { base: {}, overrides: {} } }));
  assert.equal(missing.list.rows[0].groups[0].ratio, null, "未读到配置时不假定为1倍");
});

test("分组筛选保留用户全部消费和原分母，搜索大小写、余额排序、真实零与缺失值分开", () => {
  const filtered = buildUserGroupPage(input(), { channelGroup: "A社官转不带F", q: "ALICE", user: "1" });
  assert.equal(filtered.list.rows[0].shownAmount, 2); assert.equal(filtered.list.rows[0].total, 10);
  assert.equal(filtered.list.rows[0].shownGroups[0].share, .2);
  assert.equal(filtered.selectedUser.groups.length, 3);
  const zero = buildUserGroupPage(input({ usage: [], flow: [] }), { active: "false", sort: "balance", dir: "asc" });
  assert.equal(zero.list.rows[0].username, "bob"); assert.equal(zero.list.rows[0].total, 0);
  const missing = buildUserGroupPage(input({ ready: false, usage: [], flow: [] }));
  assert.equal(missing.summary.amount, null); assert.equal(missing.list.rows[0].total, null); assert.equal(missing.list.rows[0].groups, null);
});

test("实时差额只能称明细待补齐，超过总额的明细不发布虚假的占比，用户总消费仍保留", () => {
  const live = buildUserGroupPage(input({ live: true }));
  const alice = live.list.rows.find(row => row.id === 1);
  assert.equal(alice.pending, true); assert.equal(alice.groups.at(-1).pending, true); assert.equal(live.hasUnclassified, false);
  const ahead = buildUserGroupPage(input({ live: true, flow: [{ user: "alice", group: "A社官转不带F", quotaUnits: 6000000, requests: 12 }] }));
  assert.equal(ahead.list.rows[0].total, 10); assert.equal(ahead.list.rows[0].shownAmount, 10); assert.equal(ahead.list.rows[0].groups, null);
  assert.equal(ahead.summary.amount, 11);
});

test("完整列表超过15组合仍保留，分页、合计和用户抽屉跨页正确", () => {
  const users = Array.from({ length: 61 }, (_, id) => ({ id: id + 1, username: `customer-${id}`, role: 1, status: 1, quotaUsd: id }));
  const usage = users.map(user => ({ key: user.username, quotaUnits: 500000, requests: 1 }));
  const flow = users.map(user => ({ user: user.username, group: "AWSB全模型-不带F-Coding", quotaUnits: 500000, requests: 1 }));
  const page = buildUserGroupPage(input({ directory: users, usage, flow }), { page: 2, user: 1 });
  assert.equal(page.list.total, 61); assert.equal(page.list.rows.length, 11); assert.equal(page.summary.amount, 61); assert.equal(page.selectedUser.id, 1);
});

test("近7天含今天、昨天为完整自然日；自定义拒绝伪秒级历史和无限历史范围", () => {
  assert.equal(resolveUserGroupsWindow({ preset: "7d" }, now).startMs, Date.parse("2026-11-17T16:00:00Z"));
  assert.equal(resolveUserGroupsWindow({ preset: "yesterday" }, now).endMs, startMs);
  for (const request of [{ preset: "bad" }, { preset: "custom", startMs, endMs: now + 1000 }, { preset: "custom", startMs: startMs + 1000, endMs: now }, { preset: "custom", startMs: startMs - 32 * 86400000, endMs: now }]) assert.throws(() => resolveUserGroupsWindow(request, now), { code: "USER_GROUPS_RANGE_INVALID" });
});

function runtime() {
  resetOwnRequestBudget();
  const own = { id: "own", baseUrl: "https://own.test", userId: 1, accessToken: "test", authVersion: 1 };
  const rt = { store: { settings: { refreshIntervalSec: 60 } }, _userOpsDirectory: { stationId: "own", users: directory, at: now }, _userOpsPageCache: { payload: { users: [] } } };
  const calls = { live: 0, user: 0, flow: 0, ratios: 0 };
  let fail = false;
  const ops = { async refreshLive() { calls.live++; rt._userOpsToday = { stationId: "own", day: "2026-11-24", at: now, rows: [{ username: "alice", hourMs: startMs, quota: 500000, requests: 1 }] }; return {}; } };
  const readers = { ratios: async () => { calls.ratios++; return { base: { "AWSB全模型-不带F-Coding": 3.8 }, overrides: { vip: { "AWSB全模型-不带F-Coding": 2.8 } } }; }, user: async () => { calls.user++; return [{ key: "alice", quotaUnits: 1000000, requests: 2 }]; }, flow: async () => { calls.flow++; if (fail) throw Object.assign(new Error("private provider text"), { code: "UPSTREAM_REQUEST_FAILED" }); return [{ user: "alice", group: "AWSB全模型-不带F-Coding", quotaUnits: 500000, requests: 1 }]; } };
  const page = { rate: 1, paused: false, users: [], balanceSyncedMs: now };
  const read = (input = {}, patch = {}) => userGroupsPage(rt, { own, page, directory: rt._userOpsDirectory, ops, readers, now, input, ...patch });
  return { rt, own, page, calls, read, setFail: value => { fail = value; } };
}

test("同一今天窗口所有筛选和并发请求共用一轮读取，余额时间独立更新", async () => {
  const f = runtime();
  const [first, filtered] = await Promise.all([f.read(), f.read({ q: "alice" })]);
  assert.deepEqual(f.calls, { live: 1, user: 0, flow: 1, ratios: 1 }); assert.equal(first.asOf, now); assert.equal(filtered.list.total, 1);
  f.rt._userOpsDirectory = { stationId: "own", users: directory.map(user => ({ ...user, quotaUsd: 77 })), at: now + 15000 };
  const newerBalance = await f.read({}, { now: now + 15000 });
  assert.equal(newerBalance.asOf, now); assert.equal(newerBalance.balanceAt, now + 15000); assert.equal(newerBalance.list.rows[0].balanceUsd, 77);
  assert.equal(f.calls.flow, 1);
  assert.equal(f.calls.ratios, 1); assert.equal(first.list.rows[0].groups[0].ratio, 2.8);
});

test("倍率读取失败不影响消费与余额，不把旧倍率冒充为当前设置", async () => {
  const f = runtime(); const before = await f.read();
  const failed = await f.read({}, { refresh: true, readers: {
    user: async () => [], flow: async () => [{ user: "alice", group: "AWSB全模型-不带F-Coding", quotaUnits: 500000, requests: 1 }],
    ratios: async () => { throw new Error("private setting"); },
  } });
  assert.equal(failed.summary.amount, before.summary.amount); assert.equal(failed.list.rows[0].balanceUsd, 88);
  assert.equal(failed.error, null); assert.equal(failed.ratiosError, "OWN_GROUP_RATIOS_UNAVAILABLE");
  assert.equal(failed.ratiosAt, null); assert.equal(failed.list.rows[0].groups[0].ratio, null);
  assert.ok(!JSON.stringify(failed).includes("private setting"));
});

test("近7天把历史与今天分开缓存，重复筛选不重拉历史，手动刷新只重读所选汇总", async () => {
  const f = runtime();
  await f.read({ preset: "7d" });
  assert.deepEqual(f.calls, { live: 1, user: 1, flow: 2, ratios: 1 });
  await f.read({ preset: "7d", channelGroup: "AWSB全模型-不带F-Coding" });
  assert.deepEqual(f.calls, { live: 1, user: 1, flow: 2, ratios: 1 });
  await f.read({ preset: "7d" }, { refresh: true });
  assert.deepEqual(f.calls, { live: 2, user: 2, flow: 4, ratios: 2 });
});

test("失败保留整份旧消费，不拼新总额和旧分组；从未读到时保留余额与缺失值", async () => {
  const f = runtime(); const before = await f.read();
  f.setFail(true);
  const failed = await f.read({}, { refresh: true });
  assert.equal(failed.asOf, before.asOf); assert.equal(failed.summary.amount, before.summary.amount); assert.equal(failed.error, "UPSTREAM_REQUEST_FAILED");
  assert.ok(!JSON.stringify(failed).includes("private provider text"));
  const empty = runtime(); empty.setFail(true); const missing = await empty.read();
  assert.equal(missing.asOf, null); assert.equal(missing.summary.amount, null); assert.equal(missing.list.rows[0].balanceUsd, 88);
  await empty.read({}, { now: now + 15000 }); assert.equal(empty.calls.flow, 1, "失败不会每次页面轮询都重试");
});

test("暂停同步不发任何源站请求，更换账号不会复用旧账号数据", async () => {
  const f = runtime(); f.page.paused = true;
  const paused = await f.read(); assert.equal(paused.paused, true); assert.deepEqual(f.calls, { live: 0, user: 0, flow: 0, ratios: 0 });
  f.page.paused = false; await f.read(); f.own.accessToken = "another-account"; await f.read();
  assert.equal(f.calls.flow, 2);
});
