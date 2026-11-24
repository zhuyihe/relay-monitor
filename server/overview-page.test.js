import test from "node:test";
import assert from "node:assert/strict";
import { readOverviewIncome, overviewPage } from "./overview-page.js";

const startMs = Date.parse("2026-11-21T16:00:00Z"), endMs = startMs + 86400000;
const fixture = (patch = {}) => {
  const reads = [];
  const store = { getCursor: async () => ({ coveredFromMs: startMs, coveredToMs: endMs, disabledFromMs: null, disabledToMs: null, ...patch }),
    listBuckets: async (...args) => { reads.push(args); return [{ channelId: 1, quota: 5000000, adminQuota: 500000, testQuota: 50000 }, { channelId: 2, quota: 2000000, adminQuota: 0, testQuota: 0 }]; } };
  return { store, reads };
};

test("首页全站消费复用已归类日志，扣管理员与测试，保留其余转售消费", async () => {
  const f = fixture();
  const result = await readOverviewIncome(f.store, { id: "own" }, { startMs, endMs, closed: true }, 500000);
  assert.equal(result.amount, 12.9);
  assert.deepEqual(result.channels, [{ channelId: 1, amount: 8.9 }, { channelId: 2, amount: 4 }]);
  assert.equal(result.asOf, endMs);
  assert.deepEqual(f.reads, [["own", startMs, endMs]]);
});

test("今日金额只标记日志实际覆盖到的时间，不把当前时刻写成采集时刻", async () => {
  const cutoff = startMs + 1234000;
  const f = fixture({ coveredToMs: cutoff });
  const result = await readOverviewIncome(f.store, { id: "own" }, { startMs, endMs: startMs + 3600000, closed: false }, 500000);
  assert.equal(result.asOf, cutoff);
  assert.equal(result.amount, 12.9);
});

test("昨天必须覆盖完整一天；缺开头、关闭缺口或缺换算时不伪造0与财务收入", async () => {
  for (const patch of [{ coveredFromMs: startMs + 1000 }, { coveredToMs: endMs - 1000 }, { disabledFromMs: startMs + 3600000, disabledToMs: startMs + 7200000 }]) {
    const f = fixture(patch);
    assert.equal((await readOverviewIncome(f.store, { id: "own" }, { startMs, endMs, closed: true }, 500000)).amount, null);
    assert.equal(f.reads.length, 0);
  }
  const f = fixture();
  assert.equal((await readOverviewIncome(f.store, { id: "own" }, { startMs, endMs, closed: true }, null)).amount, null);
  assert.equal(f.reads.length, 0);
});

test("覆盖完整但没有消费的账单保留真实零值", async () => {
  const f = fixture(); f.store.listBuckets = async () => [];
  const result = await readOverviewIncome(f.store, { id: "own" }, { startMs, endMs, closed: true }, 500000);
  assert.equal(result.amount, 0);
  assert.deepEqual(result.channels, []);
});

function runtime() {
  const now = Date.parse("2026-11-22T04:00:00Z"), calls = [];
  const own = { id: "own", isOwn: true, type: "newapi", name: "主站" };
  const rt = {
    store: { list: () => [own], settings: { refreshIntervalSec: 60 }, rules: {} }, userOps: {},
    _userOpsPageCache: { payload: { ownStationId: "own", today: "2026-11-22", tz: "Asia/Shanghai", syncedMs: now, todaySyncedMs: now, balanceSyncedMs: now,
      fresh: true, ready: { balance: true }, users: [{ id: 1, username: "customer-a", today: 100, days: .5, runwayState: "soon" }],
      summary: { todayCost: 100 }, trend: [{ day: "2026-11-21", available: true, cost: 60, users: 2, top: [{ username: "customer-b", cost: 50 }] }, { day: "2026-11-22", available: true, cost: 100, users: 1, top: [] }] } },
    _ownLogStore: { getCursor: async () => ({ coveredFromMs: startMs - 86400000, coveredToMs: now - 300000 }), listBuckets: async () => [{ channelId: 1, quota: 5000000, adminQuota: 500000, testQuota: 0 }, { channelId: 2, quota: 1000000, adminQuota: 0, testQuota: 0 }] },
    reconciliation: { cachedOwnStatus: () => ({ quotaPerUnit: 500000 }), profitPage: async (input, options) => { calls.push({ input, options }); return { coverage: { catalogueState: "verified", knownChannelCount: 2, accountedChannelCount: 1, channels: [{ ownStationId: "own", channelId: 1, name: "渠道1", status: "accounted", window: { startMs: startMs - 86400000, endMs: startMs } }, { ownStationId: "own", channelId: 2, name: "渠道2", status: "unlinked" }] }, accountingTotals: { gross: 3 } }; } },
  };
  return { rt, now, calls };
}

test("首页客户消费共用用户运营快照，财务收入和覆盖金额仍只读日志及cacheOnly账单", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw Error("首页不得发上游请求"); });
  const f = runtime();
  const result = await overviewPage(f.rt, { now: f.now });
  assert.equal(result.financial.amount, 11);
  assert.deepEqual(result.users.consumption, { amount: 100, asOf: f.now });
  assert.notEqual(result.financial.amount, result.users.consumption.amount);
  assert.equal(result.financial.asOf, f.now - 300000);
  assert.deepEqual([result.coverage.covered, result.coverage.missing], [9, 2]);
  assert.equal(result.coverage.ratio, 9 / 11);
  assert.deepEqual(f.calls, [{ input: { preset: "today" }, options: { cacheOnly: true, passive: true } }, { input: { preset: "yesterday" }, options: { cacheOnly: true, passive: true } }]);
  assert.equal(result.users.activity.count, 1);
  assert.equal(result.users.reminderCount, 1);
});

test("昨天汇总只读完整历史日志，客户余额和提醒仍是当前；换算未缓存则财务金额为空", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw Error("昨日不得触发取数或回补"); });
  const f = runtime();
  const result = await overviewPage(f.rt, { preset: "yesterday", now: f.now });
  assert.deepEqual(f.calls, [{ input: { preset: "yesterday" }, options: { cacheOnly: true, passive: true } }]);
  assert.equal(result.users.activity.count, 2);
  assert.deepEqual(result.users.consumption, { amount: 60, asOf: f.now });
  assert.equal(result.users.balanceAt, f.now);
  assert.equal(result.users.customers[0].today, 100);
  f.rt.reconciliation.cachedOwnStatus = () => null;
  const unknown = await overviewPage(f.rt, { now: f.now });
  assert.equal(unknown.financial.amount, null);
  assert.deepEqual(unknown.users.consumption, { amount: 100, asOf: f.now });
  assert.equal(unknown.coverage.missing, null);
  assert.equal(unknown.users.activity.count, 1);
});

test("用户刷新后首页金额和时间同步更新，未更新的财务账单与毛利保持原值", async () => {
  const f = runtime();
  const before = await overviewPage(f.rt, { now: f.now });
  const payload = f.rt._userOpsPageCache.payload;
  payload.syncedMs = payload.todaySyncedMs = payload.balanceSyncedMs = f.now + 60000;
  payload.summary.todayCost = payload.users[0].today = 123.45;
  const after = await overviewPage(f.rt, { now: f.now + 60000 });
  assert.deepEqual(after.users.consumption, { amount: 123.45, asOf: payload.todaySyncedMs });
  assert.equal(after.users.consumption.amount, after.users.customers.reduce((sum, user) => sum + user.today, 0));
  assert.deepEqual(after.financial, before.financial);
  assert.deepEqual(after.profit, before.profit);
  assert.deepEqual(after.coverage, before.coverage);
});

test("客户消费保留真实零和同步时间；未同步不借财务金额，历史缺天不伪造零", async () => {
  const f = runtime(), payload = f.rt._userOpsPageCache.payload;
  payload.summary.todayCost = payload.users[0].today = 0;
  const zero = await overviewPage(f.rt, { now: f.now + 60000 });
  assert.deepEqual(zero.users.consumption, { amount: 0, asOf: f.now });
  assert.equal(zero.financial.amount, 11);
  payload.todaySyncedMs = payload.syncedMs = null;
  payload.trend[0].available = false;
  const unread = await overviewPage(f.rt, { now: f.now });
  assert.deepEqual(unread.users.consumption, { amount: null, asOf: null });
  assert.equal(unread.financial.amount, 11);
  const yesterday = await overviewPage(f.rt, { preset: "yesterday", now: f.now });
  assert.deepEqual(yesterday.users.consumption, { amount: null, asOf: null });
});

test("渠道目录未知时不宣称全站已对账，也不把所有有消费渠道误报成未绑定", async () => {
  const f = runtime();
  f.rt.reconciliation.profitPage = async () => ({ coverage: { catalogueState: "unknown", channels: [] } });
  const result = await overviewPage(f.rt, { now: f.now });
  assert.equal(result.financial.amount, 11);
  assert.equal(result.coverage.missing, null);
  assert.equal(result.coverage.covered, null);
  assert.deepEqual(result.coverage.missingChannels, []);
});

test("主站昨天关闭过收费记录，即使采集游标完整也不发布缺失金额；当前仍关闭同样留空", async () => {
  const f = fixture();
  for (const toMs of [null, startMs + 2 * 3600000]) {
    const own = { id: "own", consumeLogOffPeriods: [{ fromMs: startMs + 3600000, toMs }] };
    const result = await readOverviewIncome(f.store, own, { startMs, endMs, closed: true }, 500000);
    assert.equal(result.amount, null);
    assert.equal(result.asOf, null);
    assert.equal(f.reads.length, 0);
    assert.match(result.reason, /收费记录/);
  }
  const earlierOnly = { id: "own", consumeLogOffPeriods: [{ fromMs: startMs - 3600000, toMs: startMs }] };
  assert.equal((await readOverviewIncome(f.store, earlierOnly, { startMs, endMs, closed: true }, 500000)).amount, 12.9);
});

test("已计入渠道必须证明与主站昨天同起止，跨时区或没有时窗时不比较金额", async () => {
  for (const window of [undefined, { startMs: startMs - 86400000 + 3600000, endMs: startMs + 3600000 }]) {
    const f = runtime(), original = f.rt.reconciliation.profitPage;
    f.rt.reconciliation.profitPage = async (...args) => {
      const profit = await original(...args);
      profit.coverage.channels[0].window = window;
      return profit;
    };
    const result = await overviewPage(f.rt, { now: f.now });
    assert.equal(result.coverage.timeWindowState, window ? "different" : "unknown");
    assert.equal(result.coverage.covered, null);
    assert.equal(result.coverage.missing, null);
    assert.equal(result.coverage.ratio, null);
    assert.deepEqual(result.coverage.missingChannels, []);
  }
});

test("已绑定但账单未读到仍保留状态，不能误引导再次接入", async () => {
  const f = runtime(), original = f.rt.reconciliation.profitPage;
  f.rt.reconciliation.profitPage = async (...args) => {
    const profit = await original(...args);
    profit.coverage.channels[1].status = "billing_missing";
    return profit;
  };
  const result = await overviewPage(f.rt, { now: f.now });
  assert.equal(result.coverage.missingChannels[0].status, "billing_missing");
  assert.equal(result.coverage.missingChannels[0].amount, 2);
});
