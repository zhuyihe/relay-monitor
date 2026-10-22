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
    sent.push({ url: String(url), body: JSON.parse(init.body) });
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

test("单次余额提醒全部失败不消耗资格，手动刷新遵守退避，恢复后可送达", async (t) => {
  let now = Date.UTC(2026, 9, 22), status = 503;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => status), s = station();
  const once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, undefined);
  assert.equal(s.alertState.pendingDelivery.kind, "noRenewalLow");
  assert.equal(s.alertState.pendingDelivery.retryAt, now + 60000);
  now += 59999;
  assert.equal(await evaluateStation(s, null, once, [chA], 5), null);
  assert.equal(sent.length, 1);
  now += 1;
  status = 200;
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  assert.equal(sent.length, 2);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, now);
  assert.equal(s.alertState.pendingDelivery, undefined);
  now += 86400000;
  assert.equal(await evaluateStation(s, null, once, [chA], 5), null);
  assert.equal(sent.length, 2);
});

test("空渠道或全部停用不算通知成功，配置可用渠道后仍能收到单次提醒", async (t) => {
  for (const empty of [[], [{ ...chA, enabled: false }]]) await t.test(empty.length ? "全部停用" : "没有渠道", async (t) => {
    const sent = deliveries(t), s = station();
    s.alertState = await evaluateStation(s, null, rules, empty, 5);
    assert.equal(sent.length, 0);
    assert.equal(s.alertState.noRenewalLowNotifiedAt, undefined);
    assert.equal(s.alertState.pendingDelivery.deliveredKeys.length, 0);
    s.alertState = await evaluateStation(s, null, rules, [chA], 5);
    assert.equal(sent.length, 1);
    assert.ok(s.alertState.noRenewalLowNotifiedAt);
    assert.equal(s.alertState.pendingDelivery, undefined);
  });
});

test("部分成功只补失败渠道：单次和关闭重复提醒都不会重发已成功渠道", async (t) => {
  for (const noRenewal of [true, false]) await t.test(noRenewal ? "单次提醒" : "renotifyHours=0", async (t) => {
    let now = Date.UTC(2026, 9, 22), failB = true;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => failB && url.includes("alerts-b") ? 503 : 200);
    const s = station({ noRenewal }), once = { ...rules, renotifyHours: 0 };
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    const firstSuccess = noRenewal ? s.alertState.noRenewalLowNotifiedAt : s.alertState.notifiedAt;
    assert.equal(firstSuccess, now);
    assert.deepEqual(s.alertState.pendingDelivery.remainingKeys, [JSON.stringify([chB.id, chB.type, 1])]);
    now += 60000;
    failB = false;
    // 新进程只需读回普通 JSON 状态，仍能只补失败渠道。
    s.alertState = JSON.parse(JSON.stringify(s.alertState));
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    assert.equal(sent.filter((item) => item.url.includes("alerts-a")).length, 1);
    assert.equal(sent.filter((item) => item.url.includes("alerts-b")).length, 2);
    assert.equal(noRenewal ? s.alertState.noRenewalLowNotifiedAt : s.alertState.notifiedAt, firstSuccess);
    assert.equal(s.alertState.pendingDelivery, undefined);
    now += 86400000;
    assert.equal(await evaluateStation(s, null, once, [chA, chB], 5), null);
  });
});

test("普通和预计耗尽提醒部分失败不会饿死成功渠道：周期到期重发，周期内只补失败渠道", async (t) => {
  for (const eta of [false, true]) await t.test(eta ? "预计耗尽" : "低余额", async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
    const s = station({ noRenewal: false, ...(eta ? { balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } } : {}) });
    const prediction = eta ? { etaDays: 2 } : null, timestamp = eta ? "etaNotifiedAt" : "notifiedAt";
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(s.alertState[timestamp], now);
    now += 2 * 3600000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sent.filter((item) => item.url.includes("alerts-a")).length, 2);
    assert.equal(sent.filter((item) => item.url.includes("alerts-b")).length, 2);
    assert.equal(s.alertState[timestamp], now);
    assert.equal(s.alertState.pendingDelivery.attempts, 1, "到期新周期按当前目标重新投递");
    now += 60000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sent.filter((item) => item.url.includes("alerts-a")).length, 2);
    assert.equal(sent.filter((item) => item.url.includes("alerts-b")).length, 3);
    assert.equal(s.alertState.pendingDelivery.attempts, 2, "周期内继续补 B，不重复 A");
    now += 60000;
    assert.equal(await evaluateStation(s, prediction, rules, [chA, chB], 5), null);
    assert.equal(sent.length, 5, "B 的下次失败退避是两分钟，不能手动刷新猛发");
    now += 2 * 3600000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sent.filter((item) => item.url.includes("alerts-a")).length, 3);
    assert.equal(s.alertState[timestamp], now);
    assert.equal(s.alertState.pendingDelivery.attempts, 1);
  });
});

test("普通周期提醒全部未送达时不以空成功时间重建任务，仍遵守失败退避", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = station({ noRenewal: false });
  s.alertState = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(s.alertState.notifiedAt || 0, 0);
  now += 1000;
  assert.equal(await evaluateStation(s, null, rules, [chA], 5), null);
  assert.equal(sent.length, 1);
  now += 59000;
  s.alertState = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(s.alertState.pendingDelivery.attempts, 2);
  assert.equal(s.alertState.pendingDelivery.retryAt, now + 120000);
  now += 2 * 3600000;
  s.alertState = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(s.alertState.pendingDelivery.attempts, 3, "没有任何成功起点时不是新提醒周期");
  assert.equal(s.alertState.notifiedAt || 0, 0);
});

test("普通异常、预计耗尽和恢复提醒未送达时不受关闭重复提醒影响", async (t) => {
  const cases = [
    ["low", station({ noRenewal: false }), null, "notifiedAt"],
    ["error", station({ noRenewal: false, balance: { ok: false, error: "offline" } }), null, "notifiedAt"],
    ["eta", station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" } }), { etaDays: 2 }, "etaNotifiedAt"],
    ["recover", station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "error" } }), null, "notifiedAt"],
  ];
  for (const [event, s, prediction, field] of cases) await t.test(event, async (t) => {
    let now = Date.UTC(2026, 9, 22), status = 503;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, () => status), once = { ...rules, renotifyHours: 0 };
    s.alertState = await evaluateStation(s, prediction, once, [chA], 5);
    assert.equal(s.alertState[field] || 0, 0);
    assert.equal(s.alertState.pendingDelivery.eventKey, event);
    now += 60000;
    status = 200;
    s.alertState = await evaluateStation(s, prediction, once, [chA], 5);
    assert.equal(sent.length, 2);
    assert.equal(s.alertState[field], now);
    assert.equal(s.alertState.pendingDelivery, undefined);
  });
});

test("发送失败退避从一分钟递增并以一小时封顶，冷却期间不重复发请求", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = station();
  for (const [index, minutes] of [1, 2, 4, 8, 16, 32, 60, 60].entries()) {
    s.alertState = await evaluateStation(s, null, rules, [chA], 5);
    assert.equal(s.alertState.pendingDelivery.attempts, index + 1);
    assert.equal(s.alertState.pendingDelivery.retryAt, now + minutes * 60000);
    assert.equal(sent.length, index + 1);
    now = s.alertState.pendingDelivery.retryAt - 1;
    assert.equal(await evaluateStation(s, null, rules, [chA], 5), null);
    assert.equal(sent.length, index + 1);
    now += 1;
  }
  assert.doesNotMatch(JSON.stringify(s.alertState.pendingDelivery), /https:|alerts-a|config|password/);
});

test("余额恢复或提醒关闭会取消失败任务，之后不能重放过期提醒", async (t) => {
  for (const change of ["balance", "rule"]) await t.test(change, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, () => 503), s = station();
    s.alertState = await evaluateStation(s, null, rules, [chA], 5);
    if (change === "balance") s.balance.remaining = 20;
    const activeRules = change === "rule" ? { ...rules, onLow: false } : rules;
    s.alertState = await evaluateStation(s, null, activeRules, [chA], 5);
    assert.equal(s.alertState.pendingDelivery, undefined);
    now += 3600000;
    const next = await evaluateStation(s, null, activeRules, [chA], 5);
    assert.equal(next, null);
    assert.equal(sent.length, 1);
  });
});

test("部分送达后改变目标集合或同ID配置版本会取消旧任务，不发送给新目标", async (t) => {
  for (const change of ["targets", "version"]) await t.test(change, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200), s = station();
    s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
    const changed = change === "targets" ? [chA] : [chA, { ...chB, deliveryVersion: 2, config: { url: "https://new-recipient.test/push" } }];
    now += 60000;
    s.alertState = await evaluateStation(s, null, rules, changed, 5);
    assert.equal(s.alertState.pendingDelivery, undefined);
    assert.equal(sent.length, 2);
    now += 3600000;
    assert.equal(await evaluateStation(s, null, rules, [chA, chB], 5), null, "旧目标恢复也不复活已取消任务");
    assert.equal(sent.length, 2);
  });
});

test("已失败的余额提醒优先补发，不被新产生的预计耗尽提醒替换", async (t) => {
  let now = Date.UTC(2026, 9, 22), status = 503;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => status), s = station({ noRenewal: false }), once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  now += 60000;
  status = 200;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, once, [chA], 5);
  assert.match(sent[1].body.title, /余额偏低/);
  assert.equal(s.alertState.notifiedAt, now);
  assert.equal(s.alertState.etaNotifiedAt || 0, 0);
  assert.equal(s.alertState.pendingDelivery, undefined);
});

test("余额读取失败未达到错误阈值时也不能重发旧余额提醒", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = station({ noRenewal: false });
  const threshold = { ...rules, errorThreshold: 3 };
  s.alertState = await evaluateStation(s, null, threshold, [chA], 5);
  assert.equal(s.alertState.pendingDelivery.eventKey, "low");
  now += 60000;
  s.balance = { ok: false, error: "temporary failure" };
  const pending = structuredClone(s.alertState.pendingDelivery);
  s.alertState = await evaluateStation(s, null, threshold, [chA], 5);
  assert.deepEqual(s.alertState.pendingDelivery, pending, "暂时读不到余额只暂停补发，不抹去未送达任务");
  assert.equal(s.alertState.errorCount, 1);
  assert.equal(sent.length, 1, "既不提前发查询失败告警，也不使用旧 warn 状态重发余额提醒");
});

test("发送失败后暂时读不到余额：关闭重复提醒仍保留任务，重新确认仍低余额才续传", async (t) => {
  for (const noRenewal of [false, true]) for (const partial of [false, true]) {
    await t.test(`${noRenewal ? "单次" : "普通"}·${partial ? "部分成功" : "全部失败"}`, async (t) => {
      let now = Date.UTC(2026, 9, 22), recovered = false;
      t.mock.method(Date, "now", () => now);
      const sent = deliveries(t, (url) => recovered || partial && url.includes("alerts-a") ? 200 : 503);
      const s = station({ noRenewal }), once = { ...rules, renotifyHours: 0, errorThreshold: 3 };
      s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
      const pending = structuredClone(s.alertState.pendingDelivery);
      for (let failures = 1; failures < 3; failures++) {
        now += 60000;
        s.balance = { ok: false, error: "temporary read failure" };
        s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
        assert.deepEqual(s.alertState.pendingDelivery, pending);
        assert.equal(s.alertState.errorCount, failures);
        assert.equal(sent.length, 2, "暂停期间不能补发先前的余额提醒");
      }
      now += 60000;
      recovered = true;
      s.balance = { ok: true, remaining: 4, used: 6, total: 10 };
      s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
      assert.equal(sent.filter((item) => item.url.includes("alerts-a")).length, partial ? 1 : 2);
      assert.equal(sent.filter((item) => item.url.includes("alerts-b")).length, 2);
      assert.equal(s.alertState.pendingDelivery, undefined);
      assert.ok(noRenewal ? s.alertState.noRenewalLowNotifiedAt : s.alertState.notifiedAt);
    });
  }
});

test("发送在途改变续费计划不会把旧单次标记或失败队列写回", async (t) => {
  let release, reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    reached();
    await new Promise((resolve) => { release = resolve; });
    return new Response("{}", { status: 503 });
  });
  const s = station();
  const sending = evaluateStation(s, null, rules, [chA], 5);
  await waiting;
  s.noRenewal = false;
  s.alertState = { state: "warn", notifiedAt: 0 };
  release();
  assert.equal(await sending, null);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, undefined);
  assert.equal(s.alertState.pendingDelivery, undefined);
});
