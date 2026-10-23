import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStation } from "./alerts.js";

const rules = {
  onLow: true,
  onExhaust: true,
  onError: true,
  onRecover: true,
  onEta: true,
  etaDays: 3,
  renotifyHours: 1,
};

function station(overrides = {}) {
  return {
    id: "station-1",
    name: "测试站点",
    type: "newapi",
    noRenewal: true,
    balance: { ok: true, remaining: 4, used: 6, total: 10 },
    ...overrides,
  };
}

const chA = { id: "ch-a", name: "A", type: "webhook", enabled: true, config: { url: "https://alerts-a.test/push" } };
const chB = { id: "ch-b", name: "B", type: "webhook", enabled: true, config: { url: "https://alerts-b.test/push" } };

function deliveries(t, status = () => 200) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    // at 用 Date.now()：测试里换掉的是它，webhook 载荷里的 timestamp 用的是真实时间
    sent.push({ url: String(url), body: JSON.parse(init.body), at: Date.now() });
    return new Response("{}", { status: status(String(url)) });
  });
  return sent;
}

test("账单专用授权即使低余额或查询失败也不产生告警", async () => {
  for (const balance of [{ ok: true, remaining: 0 }, { ok: false, error: "expired" }]) {
    const s = station({ monitorEnabled: false, balance });
    assert.equal(await evaluateStation(s, { etaDays: 0.1 }, rules, [], 5), null);
    assert.equal(s.alertState, undefined);
  }
});

test("不再续费站点只发送一次低余额提醒", async (t) => {
  const sent = deliveries(t);
  const s = station();
  const first = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(first.state, "warn");
  assert.ok(first.noRenewalLowNotifiedAt > 0);

  s.alertState = first;
  assert.equal(await evaluateStation(s, null, rules, [chA], 5), null);

  s.balance.remaining = 0;
  const exhausted = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(exhausted.state, "danger");
  assert.equal(exhausted.noRenewalLowNotifiedAt, first.noRenewalLowNotifiedAt);
  assert.equal(exhausted.notifiedAt, first.notifiedAt);
  assert.equal(sent.length, 1);
});

test("不再续费站点不发送预计耗尽提醒", async () => {
  const s = station({
    balance: { ok: true, remaining: 10, used: 0, total: 10 },
    alertState: { state: "ok", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 },
  });
  const prediction = { burnPerDay: 5, etaDays: 2 };
  assert.equal(await evaluateStation(s, prediction, rules, [], 5), null);
});

test("不再续费站点仍发送查询失败告警", async (t) => {
  deliveries(t);
  const s = station({
    balance: { ok: false, error: "连接超时" },
    alertState: {
      state: "warn",
      notifiedAt: 0,
      etaNotifiedAt: 0,
      noRenewalLowNotifiedAt: 1,
      errorCount: 0,
    },
  });
  const next = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(next.state, "error");
  assert.ok(next.notifiedAt > 0);
});

test("普通站点仍按全局间隔重复提醒", async (t) => {
  deliveries(t);
  const s = station({
    noRenewal: false,
    alertState: { state: "warn", notifiedAt: 1, etaNotifiedAt: 0, errorCount: 0 },
  });
  const next = await evaluateStation(s, null, rules, [chA], 5);
  assert.ok(next.notifiedAt > 1);
});

test("按告警类型绑定渠道：低余额只发到绑定的渠道", async (t) => {
  deliveries(t);
  const s = station({ noRenewal: false });
  const bound = { ...rules, channelsFor: { low: ["ch-b"], exhaust: [], error: [], recover: [], eta: [] } };
  const next = await evaluateStation(s, null, bound, [chA, chB], 5);
  assert.equal(next.state, "warn");
  assert.deepEqual(next.lastResults.map((x) => x.name), ["B"]);
});

test("未绑定渠道时发送到所有启用渠道", async (t) => {
  deliveries(t);
  const s = station({ noRenewal: false });
  const next = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.deepEqual(next.lastResults.map((x) => x.name).sort(), ["A", "B"]);
});

test("耗尽预警走 eta 绑定，且忽略停用渠道", async (t) => {
  deliveries(t);
  const s = station({
    noRenewal: false,
    balance: { ok: true, remaining: 10, used: 0, total: 10 },
    alertState: { state: "ok", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 },
  });
  const bound = { ...rules, channelsFor: { low: [], exhaust: [], error: [], recover: [], eta: ["ch-a", "ch-b"] } };
  const disabledB = { ...chB, enabled: false };
  const next = await evaluateStation(s, { burnPerDay: 5, etaDays: 2 }, bound, [chA, disabledB], 5);
  assert.ok(next.etaNotifiedAt > 0);
  assert.deepEqual(next.lastResults.map((x) => x.name), ["A"]);
});

// ---- 补发（每种提醒各一份任务，最多补 24 小时；没有通知方式时不攒） -------------------------------
const tasksOf = (s) => s.alertState?.pendingDeliveries || {};
const sentTo = (sent, host) => sent.filter((item) => item.url.includes(host));

test("单次提醒全部失败：资格在第一次发出时就用掉，按退避补发，补到了就停", async (t) => {
  let now = Date.UTC(2026, 9, 22), status = 503;
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => status), s = station();
  const once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, t0);
  assert.deepEqual(tasksOf(s).noRenewalLow, { kind: "noRenewalLow", state: "warn", eventKey: "low", remaining: ["ch-a"], firstAttemptAt: t0, attempts: 1, retryAt: t0 + 60000 });
  now += 59999;
  assert.equal(await evaluateStation(s, null, once, [chA], 5), null, "退避期间手动刷新也不发");
  assert.equal(sent.length, 1);
  now += 1;
  status = 200;
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  assert.equal(sent.length, 2);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, t0, "补发不改第一次发出的时间");
  assert.equal(s.alertState.pendingDeliveries, undefined);
  now += 86400000;
  assert.equal(await evaluateStation(s, null, once, [chA], 5), null);
  assert.equal(sent.length, 2);
});

test("没有可用的通知方式时不攒提醒：加上通知方式后也不补发旧的，等重复提醒的节奏", async (t) => {
  for (const empty of [[], [{ ...chA, enabled: false }]]) await t.test(empty.length ? "全部停用" : "没有通知方式", async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t);
    // 不再续费的单次提醒：资格用掉，之后也不补
    const once = station();
    once.alertState = await evaluateStation(once, null, rules, empty, 5);
    assert.equal(once.alertState.noRenewalLowNotifiedAt, now);
    assert.equal(once.alertState.pendingDeliveries, undefined);
    assert.equal(await evaluateStation(once, null, rules, [chA], 5), null);
    // 普通上游：加上通知方式后不立刻补发，到了重复提醒的时间才发
    const plain = station({ noRenewal: false });
    plain.alertState = await evaluateStation(plain, null, rules, empty, 5);
    assert.equal(plain.alertState.pendingDeliveries, undefined);
    now += 60000;
    assert.equal(await evaluateStation(plain, null, rules, [chA], 5), null);
    assert.equal(sent.length, 0);
    now += 3600000;
    plain.alertState = await evaluateStation(plain, null, rules, [chA], 5);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.title, /持续告警/);
  });
});

test("部分送到只补没收到的：单次和关闭重复提醒都不会重发已经收到的", async (t) => {
  for (const noRenewal of [true, false]) await t.test(noRenewal ? "单次提醒" : "renotifyHours=0", async (t) => {
    let now = Date.UTC(2026, 9, 22), failB = true;
    const t0 = now;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => failB && url.includes("alerts-b") ? 503 : 200);
    const s = station({ noRenewal }), once = { ...rules, renotifyHours: 0 };
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    const slot = noRenewal ? "noRenewalLow" : "state", field = noRenewal ? "noRenewalLowNotifiedAt" : "notifiedAt";
    assert.equal(s.alertState[field], t0);
    assert.deepEqual(tasksOf(s)[slot].remaining, ["ch-b"]);
    assert.doesNotMatch(JSON.stringify(s.alertState), /https:|alerts-b|config|password/, "任务里只存通知方式的 id");
    now += 60000;
    failB = false;
    // 新进程只需读回普通 JSON 状态，仍能只补没收到的
    s.alertState = JSON.parse(JSON.stringify(s.alertState));
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-a").length, 1);
    assert.equal(sentTo(sent, "alerts-b").length, 2);
    assert.equal(s.alertState[field], t0);
    assert.equal(s.alertState.pendingDeliveries, undefined);
    now += 86400000;
    assert.equal(await evaluateStation(s, null, once, [chA, chB], 5), null);
  });
});

test("重复提醒到点发给所有通知方式一次，不另开补发：收到的不再补旧的，没收到的这次也算补过一次", async (t) => {
  for (const eta of [false, true]) await t.test(eta ? "快用完" : "余额偏低", async (t) => {
    let now = Date.UTC(2026, 9, 22);
    const t0 = now;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
    const s = station({ noRenewal: false, ...(eta ? { balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } } : {}) });
    const prediction = eta ? { etaDays: 2 } : null, field = eta ? "etaNotifiedAt" : "notifiedAt", slot = eta ? "eta" : "state";
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(s.alertState[field], t0);
    assert.equal(tasksOf(s)[slot].attempts, 1);
    // 重复提醒到点：发给 A 和 B 各一次；B 没收到，算补过一次，任务接着第一次的 24 小时
    now += 2 * 3600000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-a").length, 2);
    assert.equal(sentTo(sent, "alerts-b").length, 2);
    assert.equal(s.alertState[field], now);
    assert.deepEqual([tasksOf(s)[slot].attempts, tasksOf(s)[slot].firstAttemptAt, tasksOf(s)[slot].retryAt], [2, t0, now + 2 * 60000]);
    now += 60000;
    assert.equal(await evaluateStation(s, prediction, rules, [chA, chB], 5), null, "B 刚试过，下次要等两分钟");
    now += 60000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-b").length, 3, "到点接着补 B 第一条");
    assert.equal(sentTo(sent, "alerts-a").length, 2, "两次之间不重复发给 A");
    assert.doesNotMatch(sent.at(-1).body.title, /持续告警/, "补的是第一条，不是重复提醒");
  });
});

test("重复提醒送到了没收到第一条的通知方式，就不再补第一条", async (t) => {
  let now = Date.UTC(2026, 9, 22), failB = true;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => failB && url.includes("alerts-b") ? 503 : 200);
  const s = station({ noRenewal: false });
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.deepEqual(tasksOf(s).state.remaining, ["ch-b"]);
  failB = false;
  now += 2 * 3600000;
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.match(sent.at(-1).body.title, /持续告警/);
  assert.equal(s.alertState.pendingDeliveries, undefined);
  now += 10 * 60000;
  assert.equal(await evaluateStation(s, null, rules, [chA, chB], 5), null);
  assert.equal(sentTo(sent, "alerts-b").length, 2);
});

test("一个通知方式一直坏着：第一条补满 24 小时，第 2 天起每天只跟着重复提醒试（间隔 1、24、0 小时分别是 24、1、0 次）", async (t) => {
  for (const [hours, perDay] of [[1, 24], [24, 1], [0, 0]]) await t.test(`renotifyHours=${hours}`, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    const t0 = now;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, () => 503), s = station({ noRenewal: false });
    const cadence = { ...rules, renotifyHours: hours };
    // 每隔 1 小时零 1 毫秒刷新一次，跑 3 天
    for (let round = 0; round < 72; round++) {
      now = t0 + round * 3600001;
      s.alertState = (await evaluateStation(s, null, cadence, [chA], 5)) || s.alertState;
    }
    const day = (index) => sent.filter((item) => item.at >= t0 + index * 86400000 && item.at < t0 + (index + 1) * 86400000).length;
    assert.equal(day(0), 24, "第一天每轮都补");
    assert.equal(day(1), perDay);
    assert.equal(day(2), perDay);
  });
});

test("一个通知方式一直发不出去，快用完照样送到别的通知方式（补发不挡新提醒）", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const daily = { ...rules, renotifyHours: 24 };
  const s = station({ noRenewal: false });
  // 先是余额偏低：A 收到，B 没收到，留下补发任务
  s.alertState = await evaluateStation(s, null, daily, [chA, chB], 5);
  assert.deepEqual(tasksOf(s).state.remaining, ["ch-b"]);
  // 之后估出来快用完了：照样发给 A 和 B，同时接着补 B 的余额偏低
  for (let minutes = 1; minutes <= 48 * 60; minutes += 10) {
    now = t0 + minutes * 60000;
    s.alertState = (await evaluateStation(s, { burnPerDay: 2, etaDays: 2 }, daily, [chA, chB], 5)) || s.alertState;
  }
  const etaToA = sentTo(sent, "alerts-a").filter((item) => /耗尽预警/.test(item.body.title));
  assert.equal(etaToA.length, 2, "48 小时里 A 收到两次快用完（第一次和 24 小时后的重复提醒）");
  // B 的补发：每种各补 24 小时就停
  const toB = sentTo(sent, "alerts-b");
  // 第一次的余额偏低最多补 24 小时；24 小时后的是重复提醒（持续告警），另开一轮
  const lowRetries = toB.filter((item) => /余额偏低/.test(item.body.title) && !/持续告警/.test(item.body.title)).map((item) => item.at);
  assert.ok(lowRetries.length > 1 && Math.max(...lowRetries) - t0 < 24 * 3600000, "余额偏低最多补 24 小时");
  assert.ok(toB.some((item) => /持续告警/.test(item.body.title)), "24 小时后照重复提醒的节奏再发");
});

test("补发间隔 1、2、4…分钟，封顶 1 小时；从第一次发出起最多补 24 小时（共 29 次），之后回到重复提醒的节奏", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = station({ noRenewal: false });
  const slow = { ...rules, renotifyHours: 48 };
  for (const [index, minutes] of [1, 2, 4, 8, 16, 32, 60, 60].entries()) {
    s.alertState = await evaluateStation(s, null, slow, [chA], 5);
    assert.equal(tasksOf(s).state.attempts, index + 1);
    assert.equal(tasksOf(s).state.retryAt, now + minutes * 60000);
    assert.equal(sent.length, index + 1);
    now = tasksOf(s).state.retryAt - 1;
    assert.equal(await evaluateStation(s, null, slow, [chA], 5), null);
    assert.equal(sent.length, index + 1);
    now += 1;
  }
  // 一直补到 24 小时为止：第一次 + 0:01、0:03、0:07、0:15、0:31、1:03，之后每小时一次，最后一次在 23:03
  while (s.alertState.pendingDeliveries) {
    now = tasksOf(s).state.retryAt;
    s.alertState = await evaluateStation(s, null, slow, [chA], 5);
  }
  assert.equal(sent.length, 29);
  assert.equal(sent.at(-1).at - t0, (23 * 60 + 3) * 60000);
  assert.equal(s.alertState.notifiedAt, t0);
  // 补满后不再发，直到重复提醒的时间（从第一次发出起 48 小时）
  now = t0 + 47 * 3600000;
  assert.equal(await evaluateStation(s, null, slow, [chA], 5), null);
  assert.equal(sent.length, 29);
  now = t0 + 48 * 3600000 + 1;
  s.alertState = await evaluateStation(s, null, slow, [chA], 5);
  assert.equal(sent.length, 30);
  assert.match(sent.at(-1).body.title, /持续告警/);
  assert.equal(s.alertState.pendingDeliveries, undefined, "重复提醒没送到也不另开补发");
});

test("停机超过 24 小时：回来以后不再补第一条", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = station({ noRenewal: false });
  const slow = { ...rules, renotifyHours: 48 };
  s.alertState = await evaluateStation(s, null, slow, [chA], 5);
  now += 25 * 3600000;
  s.alertState = await evaluateStation(s, null, slow, [chA], 5);
  assert.equal(sent.length, 1);
  assert.equal(s.alertState.pendingDeliveries, undefined);
});

test("那件事不在了就不补：余额恢复、关掉这种提醒、提醒天数改小、余额用完、改成不再续费", async (t) => {
  const cases = [
    // [名字, 上游, 估算, 改了什么]
    ["单次提醒·余额恢复", () => station(), null, (s) => { s.balance.remaining = 20; return [rules, null]; }],
    ["单次提醒·关掉偏低", () => station(), null, () => [{ ...rules, onLow: false }, null]],
    ["偏低·余额恢复后发恢复通知", () => station({ noRenewal: false }), null, (s) => { s.balance.remaining = 20; return [rules, null]; }],
    ["偏低·关掉偏低", () => station({ noRenewal: false }), null, () => [{ ...rules, onLow: false }, null]],
    ["偏低·改成不再续费", () => station({ noRenewal: false }), null, (s) => { s.noRenewal = true; return [rules, null]; }],
    ["快用完·关掉快用完", () => station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } }), { etaDays: 2 }, () => [{ ...rules, onEta: false }, { etaDays: 2 }]],
    ["快用完·提醒天数改小", () => station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } }), { etaDays: 2 }, () => [{ ...rules, etaDays: 1 }, { etaDays: 2 }]],
    ["快用完·余额用完", () => station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } }), { etaDays: 2 }, (s) => { s.balance.remaining = 0; return [rules, { etaDays: 0 }]; }],
  ];
  for (const [name, make, prediction, change] of cases) await t.test(name, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200), s = make();
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    const [slot] = Object.keys(tasksOf(s));
    const kindBefore = tasksOf(s)[slot].kind;
    const [activeRules, nextPrediction] = change(s);
    now += 60000;
    s.alertState = (await evaluateStation(s, nextPrediction, activeRules, [chA, chB], 5)) || s.alertState;
    // 旧任务没了（这一轮可能发了新的一件事，比如恢复通知、单次提醒、余额用完，它们没送到会另开一份）
    assert.notEqual(tasksOf(s)[slot]?.kind, kindBefore);
    now += 3600000;
    await evaluateStation(s, nextPrediction, activeRules, [chA, chB], 5);
    const replays = sent.filter((item) => item.url.includes("alerts-b") && item.body.title === sent[1].body.title);
    assert.equal(replays.length, 1, "B 只在第一次收到过那条，之后没有补");
  });
});

test("只补发给第一次就在目标里、还没收到的：改了配置的照样补，去掉的和后来加的不补", async (t) => {
  const chC = { id: "ch-c", name: "C", type: "webhook", enabled: true, config: { url: "https://alerts-c.test/push" } };
  for (const change of ["reconfigured", "removed", "added"]) await t.test(change, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200), s = station({ noRenewal: false });
    const once = { ...rules, renotifyHours: 0 };
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    const fixedB = { ...chB, config: { url: "https://fixed-b.test/push" } };
    const channels = { reconfigured: [chA, fixedB], removed: [chA], added: [chA, chB, chC] }[change];
    now += 60000;
    s.alertState = await evaluateStation(s, null, once, channels, 5);
    if (change === "reconfigured") {
      assert.equal(sentTo(sent, "fixed-b").length, 1, "修好的通知方式收到补发");
      assert.equal(s.alertState.pendingDeliveries, undefined);
    } else if (change === "removed") {
      assert.equal(sent.length, 2);
      assert.equal(s.alertState.pendingDeliveries, undefined, "目标里没有了就不补");
      now += 3600000;
      assert.equal(await evaluateStation(s, null, once, [chA, chB], 5), null, "加回来也不复活");
    } else {
      assert.equal(sentTo(sent, "alerts-c").length, 0, "后来加的不补旧提醒");
      assert.equal(sentTo(sent, "alerts-b").length, 2);
    }
    assert.equal(sentTo(sent, "alerts-a").length, 1);
  });
});

test("没送到的余额提醒和新的快用完各发各的", async (t) => {
  let now = Date.UTC(2026, 9, 22), status = 503;
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => status), s = station({ noRenewal: false }), once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  now += 60000;
  status = 200;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, once, [chA], 5);
  assert.deepEqual(sent.slice(1).map((item) => item.body.title).map((title) => /余额偏低/.test(title) ? "low" : /耗尽预警/.test(title) ? "eta" : title).sort(), ["eta", "low"]);
  assert.equal(s.alertState.notifiedAt, t0);
  assert.equal(s.alertState.etaNotifiedAt, now);
  assert.equal(s.alertState.pendingDeliveries, undefined);
  assert.deepEqual(s.alertState.lastResults.map((x) => x.ok), [true, true], "这一轮两次发送的结果都记下");
});

test("持续告警没送到不另开补发；补发第一条时标题照旧", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const s = station({ noRenewal: false, alertState: { state: "warn", notifiedAt: now - 2 * 3600000, etaNotifiedAt: 0, errorCount: 0 } });
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.match(sent.at(-1).body.title, /持续告警/);
  assert.equal(s.alertState.pendingDeliveries, undefined);
  // 新的一件事（余额用完）没送到：补发时标题还是余额用完那一条
  s.balance = { ok: true, remaining: 0 };
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  const title = sent.at(-1).body.title;
  assert.match(title, /余额耗尽/);
  now += 60000;
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.equal(sent.at(-1).body.title, title);
});

test("这一轮读不到余额：补发先停着，不管到没到连续失败次数，读回余额接着补", async (t) => {
  for (const errorThreshold of [1, 3]) await t.test(`errorThreshold=${errorThreshold}`, async (t) => {
    let now = Date.UTC(2026, 9, 22), fixedB = false;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => !fixedB && url.includes("alerts-b") ? 503 : 200);
    const cadence = { ...rules, errorThreshold };
    // 不再续费的单次提醒、快用完各留一份
    const once = station();
    once.alertState = await evaluateStation(once, null, cadence, [chA, chB], 5);
    const fast = station({ id: "station-2", noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } });
    fast.alertState = await evaluateStation(fast, { etaDays: 2 }, cadence, [chA, chB], 5);
    const pending = [structuredClone(once.alertState.pendingDeliveries.noRenewalLow), structuredClone(fast.alertState.pendingDeliveries.eta)];
    now += 10 * 60000;
    for (const s of [once, fast]) {
      s.balance = { ok: false, error: "temporary failure" };
      s.alertState = (await evaluateStation(s, { etaDays: 2 }, cadence, [chA, chB], 5)) || s.alertState;
    }
    assert.deepEqual([once.alertState.pendingDeliveries?.noRenewalLow, fast.alertState.pendingDeliveries?.eta], pending, "读不到余额只停着，不删");
    now += 10 * 60000;
    fixedB = true;
    once.balance = { ok: true, remaining: 4 };
    fast.balance = { ok: true, remaining: 10 };
    once.alertState = await evaluateStation(once, null, cadence, [chA, chB], 5);
    fast.alertState = await evaluateStation(fast, { etaDays: 2 }, cadence, [chA, chB], 5);
    const toB = sentTo(sent, "alerts-b").map((item) => item.body.title);
    assert.ok(toB.filter((title) => /低余额提醒/.test(title)).length >= 2, "B 修好后收到单次提醒");
    assert.ok(toB.filter((title) => /耗尽预警/.test(title)).length >= 2, "B 修好后收到快用完");
    assert.equal(once.alertState.pendingDeliveries?.noRenewalLow, undefined);
    assert.equal(fast.alertState.pendingDeliveries?.eta, undefined);
  });
});

test("发送失败后暂时读不到余额：关闭重复提醒仍保留任务，重新确认仍偏低才接着补", async (t) => {
  for (const noRenewal of [false, true]) for (const partial of [false, true]) {
    await t.test(`${noRenewal ? "单次" : "普通"}·${partial ? "部分送到" : "全部失败"}`, async (t) => {
      let now = Date.UTC(2026, 9, 22), recovered = false;
      t.mock.method(Date, "now", () => now);
      const sent = deliveries(t, (url) => recovered || partial && url.includes("alerts-a") ? 200 : 503);
      const s = station({ noRenewal }), once = { ...rules, renotifyHours: 0, errorThreshold: 3 };
      s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
      const pending = structuredClone(s.alertState.pendingDeliveries);
      for (let failures = 1; failures < 3; failures++) {
        now += 60000;
        s.balance = { ok: false, error: "temporary read failure" };
        s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
        assert.deepEqual(s.alertState.pendingDeliveries, pending);
        assert.equal(s.alertState.errorCount, failures);
        assert.equal(sent.length, 2, "停着的时候不补发先前的余额提醒");
      }
      now += 60000;
      recovered = true;
      s.balance = { ok: true, remaining: 4, used: 6, total: 10 };
      s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
      assert.equal(sentTo(sent, "alerts-a").length, partial ? 1 : 2);
      assert.equal(sentTo(sent, "alerts-b").length, 2);
      assert.equal(s.alertState.pendingDeliveries, undefined);
      assert.ok(noRenewal ? s.alertState.noRenewalLowNotifiedAt : s.alertState.notifiedAt);
    });
  }
});

test("发送期间改了「不再续费」：照 store 的做法清掉单次提醒的记录和补发，不写回旧的", async (t) => {
  for (const from of [true, false]) await t.test(from ? "是 → 否" : "否 → 是", async (t) => {
    let release, reached;
    const waiting = new Promise((resolve) => { reached = resolve; });
    t.mock.method(globalThis, "fetch", async () => {
      reached();
      await new Promise((resolve) => { release = resolve; });
      return new Response("{}", { status: 503 });
    });
    const s = station({ noRenewal: from });
    const sending = evaluateStation(s, null, rules, [chA], 5);
    await waiting;
    s.noRenewal = !from;
    release();
    const next = await sending;
    assert.equal(next.noRenewalLowNotifiedAt, undefined);
    assert.equal(next.pendingDeliveries?.noRenewalLow, undefined);
    assert.equal(next.state, "warn");
    if (!from) {
      // 改成不再续费以后：旧的偏低不再补，下一轮发那一次单次提醒
      const sent = deliveries(t);
      s.alertState = next;
      s.alertState = await evaluateStation(s, null, rules, [chA], 5);
      assert.deepEqual(sent.map((item) => item.body.title.includes("低余额提醒")), [true]);
      assert.equal(s.alertState.pendingDeliveries, undefined);
    }
  });
});

test("#42 存的旧格式补发任务升级后丢掉，不再补发", async (t) => {
  const sent = deliveries(t);
  const legacy = { kind: "state", eventKey: "low", targetKeys: [JSON.stringify(["ch-a", "webhook", 1]), JSON.stringify(["ch-b", "webhook", 1])],
    remainingKeys: [JSON.stringify(["ch-b", "webhook", 1])], deliveredKeys: [JSON.stringify(["ch-a", "webhook", 1])], attempts: 40, retryAt: 0 };
  const s = station({ noRenewal: false, alertState: { state: "warn", notifiedAt: Date.now(), etaNotifiedAt: 0, errorCount: 0, pendingDelivery: legacy } });
  const next = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.equal(sent.length, 0);
  assert.equal("pendingDelivery" in next, false);
  assert.equal(next.pendingDeliveries, undefined);
});

test("余额已经用完时不再推快用完；还剩一点钱时照推", async (t) => {
  const sent = deliveries(t);
  const s = station({ noRenewal: false, balance: { ok: true, remaining: 0 } });
  s.alertState = await evaluateStation(s, { burnPerDay: 2, etaDays: 0 }, rules, [chA], 5);
  assert.match(sent.at(-1).body.title, /余额耗尽/);
  assert.equal(await evaluateStation(s, { burnPerDay: 2, etaDays: 0 }, rules, [chA], 5), null, "原来这一轮会补推快用完");
  s.balance = { ok: true, remaining: -1 };
  assert.equal(await evaluateStation(s, { burnPerDay: 2, etaDays: -0.5 }, rules, [chA], 5), null, "透支了也不推");
  assert.equal(sent.length, 1);
  const low = station({ noRenewal: false, balance: { ok: true, remaining: 0.01 } });
  low.alertState = await evaluateStation(low, { burnPerDay: 2, etaDays: 0.005 }, rules, [chA], 5);
  low.alertState = await evaluateStation(low, { burnPerDay: 2, etaDays: 0.005 }, rules, [chA], 5);
  assert.match(sent.at(-1).body.title, /耗尽预警/);
});

test("上游自己的提醒线是空串（旧数据）时用全局的，和页面一样", async (t) => {
  const sent = deliveries(t);
  await evaluateStation(station({ noRenewal: false, lowBalanceUsd: "" }), null, rules, [chA], 5);
  assert.match(sent.at(-1).body.title, /余额偏低/);
});

test("停用的、从目标里去掉的通知方式，之后重新启用也不再补", async (t) => {
  const chC = { id: "ch-c", name: "C", type: "webhook", enabled: true, config: { url: "https://alerts-c.test/push" } };
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-a") ? 200 : 503), s = station({ noRenewal: false });
  const once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA, chB, chC], 5);
  assert.deepEqual(tasksOf(s).state.remaining, ["ch-b", "ch-c"]);
  now += 60000;
  s.alertState = await evaluateStation(s, null, once, [chA, chB, { ...chC, enabled: false }], 5);
  assert.deepEqual(tasksOf(s).state.remaining, ["ch-b"], "C 停用了，从补发里去掉");
  now += 2 * 60000;
  s.alertState = await evaluateStation(s, null, once, [chA, chB, chC], 5);
  assert.equal(sentTo(sent, "alerts-c").length, 1, "C 重新启用也不补");
  assert.equal(sentTo(sent, "alerts-b").length, 3);
});

test("快用完：这一段里第一条没送到才补，同一段的重复提醒不补；这一段结束再开始算新的一件事", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const s = station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } });
  const once = { ...rules, renotifyHours: 1 };
  s.alertState = await evaluateStation(s, { etaDays: 2 }, once, [chA, chB], 5);
  assert.equal(s.alertState.etaSince, t0);
  assert.equal(tasksOf(s).eta.attempts, 1);
  // 充了钱，这一段结束：补发停，etaSince 清掉
  now += 30 * 60000;
  s.alertState = await evaluateStation(s, { etaDays: 10 }, once, [chA, chB], 5);
  assert.equal(s.alertState.etaSince, undefined);
  assert.equal(s.alertState.pendingDeliveries, undefined);
  // 又快用完了：新的一件事，第一条没送到照样补
  now += 2 * 3600000;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, once, [chA, chB], 5);
  assert.equal(s.alertState.etaSince, now);
  assert.deepEqual([tasksOf(s).eta.attempts, tasksOf(s).eta.firstAttemptAt], [1, now]);
  // 同一段里到点的重复提醒：发一次，不另开补发（任务接着第一条的）
  const start = now;
  now += 2 * 3600000;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, once, [chA, chB], 5);
  assert.equal(tasksOf(s).eta.firstAttemptAt, start);
  assert.equal(tasksOf(s).eta.attempts, 2);
});

test("补发和新提醒一起发：一个通知方式连不上，不拖后别的提醒", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  let inflight = 0, most = 0, first = true;
  t.mock.method(globalThis, "fetch", async (url) => {
    inflight++;
    most = Math.max(most, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight--;
    // 第一轮 B 没收到，留下补发
    const ok = !(first && String(url).includes("alerts-b"));
    return new Response("{}", { status: ok ? 200 : 503 });
  });
  // 偏低只发 B，快用完只发 A：补发 B 和新的快用完是两次发送
  const bound = { ...rules, channelsFor: { low: ["ch-b"], exhaust: [], error: [], recover: [], eta: ["ch-a"] } };
  const s = station({ noRenewal: false });
  s.alertState = await evaluateStation(s, null, bound, [chA, chB], 5);
  first = false;
  most = 0;
  now += 60000;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, bound, [chA, chB], 5);
  assert.equal(most, 2, "两次发送同时在路上");
  assert.equal(s.alertState.pendingDeliveries, undefined);
});

test("存着的补发任务格式不对的不要", async (t) => {
  const sent = deliveries(t);
  const broken = {
    state: { kind: "state", state: "warn", eventKey: "low", remaining: "ch-a", firstAttemptAt: 1, attempts: 1, retryAt: 0 },
    eta: { kind: "eta", eventKey: "eta", remaining: [1], firstAttemptAt: 1, attempts: 1, retryAt: 0 },
    noRenewalLow: { kind: "noRenewalLow", eventKey: "low", remaining: ["ch-a"], firstAttemptAt: "x", attempts: 1, retryAt: 0 },
    bogus: { kind: "state", eventKey: "low", remaining: ["ch-a"], firstAttemptAt: 1, attempts: 1, retryAt: 0 },
  };
  const s = station({ noRenewal: false, alertState: { state: "warn", notifiedAt: Date.now(), etaNotifiedAt: 0, errorCount: 0, pendingDeliveries: broken } });
  const next = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(sent.length, 0);
  assert.equal(next.pendingDeliveries, undefined);
});
