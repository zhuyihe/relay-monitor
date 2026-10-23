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

// ---- 补发（每件事一份记录：第一次发出的那条没送到才补，最多 24 小时；离开不到 24 小时算同一件事） ----------
const incidentsOf = (s) => s.alertState?.incidents || {};
const sentTo = (sent, host) => sent.filter((item) => item.url.includes(host));
const plainStation = (overrides = {}) => station({ noRenewal: false, ...overrides });
const fastStation = (overrides = {}) => station({ noRenewal: false, balance: { ok: true, remaining: 10 }, alertState: { state: "ok" }, ...overrides });

test("单次提醒全部失败：资格在第一次发出时就用掉，按退避补发，补到了就停", async (t) => {
  let now = Date.UTC(2026, 9, 22), status = 503;
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => status), s = station();
  const once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, t0);
  assert.deepEqual(incidentsOf(s).noRenewalLow, { kind: "noRenewalLow", state: "warn", eventKey: "low", firstAttemptAt: t0, remaining: ["ch-a"], attempts: 1, retryAt: t0 + 60000, leftAt: null });
  now += 59999;
  assert.equal(await evaluateStation(s, null, once, [chA], 5), null, "退避期间手动刷新也不发");
  assert.equal(sent.length, 1);
  now += 1;
  status = 200;
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  assert.equal(sent.length, 2);
  assert.equal(s.alertState.noRenewalLowNotifiedAt, t0, "补发不改第一次发出的时间");
  assert.deepEqual(incidentsOf(s).noRenewalLow.remaining, []);
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
    assert.equal(once.alertState.incidents, undefined, "谁都没发到，不算这件事发过");
    assert.equal(await evaluateStation(once, null, rules, [chA], 5), null);
    // 普通上游：加上通知方式后不立刻补发，到了重复提醒的时间才发
    const plain = plainStation();
    plain.alertState = await evaluateStation(plain, null, rules, empty, 5);
    assert.equal(plain.alertState.incidents, undefined);
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
    const key = noRenewal ? "noRenewalLow" : "low", field = noRenewal ? "noRenewalLowNotifiedAt" : "notifiedAt";
    assert.equal(s.alertState[field], t0);
    assert.deepEqual(incidentsOf(s)[key].remaining, ["ch-b"]);
    assert.doesNotMatch(JSON.stringify(s.alertState), /https:|alerts-b|config|password/, "记录里只存通知方式的 id");
    now += 60000;
    failB = false;
    // 新进程只需读回普通 JSON 状态，仍能只补没收到的
    s.alertState = JSON.parse(JSON.stringify(s.alertState));
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-a").length, 1);
    assert.equal(sentTo(sent, "alerts-b").length, 2);
    assert.equal(s.alertState[field], t0);
    assert.deepEqual(incidentsOf(s)[key].remaining, []);
    now += 86400000;
    assert.equal(await evaluateStation(s, null, once, [chA, chB], 5), null);
  });
});

test("同一件事的重复提醒发给所有通知方式一次，不另开补发：收到的不再补第一条，没收到的这次也算补过一次", async (t) => {
  for (const eta of [false, true]) await t.test(eta ? "快用完" : "余额偏低", async (t) => {
    let now = Date.UTC(2026, 9, 22);
    const t0 = now;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
    const s = eta ? fastStation() : plainStation();
    const prediction = eta ? { etaDays: 2 } : null, field = eta ? "etaNotifiedAt" : "notifiedAt", key = eta ? "eta" : "low";
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    const firstTitle = sentTo(sent, "alerts-b")[0].body.title;
    assert.equal(s.alertState[field], t0);
    assert.equal(incidentsOf(s)[key].attempts, 1);
    // 重复提醒到点：发给 A 和 B 各一次；B 没收到，算补过一次，接着第一次的 24 小时
    now += 2 * 3600000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-a").length, 2);
    assert.equal(sentTo(sent, "alerts-b").length, 2);
    assert.equal(s.alertState[field], now);
    assert.deepEqual([incidentsOf(s)[key].attempts, incidentsOf(s)[key].firstAttemptAt, incidentsOf(s)[key].retryAt], [2, t0, now + 2 * 60000]);
    now += 60000;
    assert.equal(await evaluateStation(s, prediction, rules, [chA, chB], 5), null, "B 刚试过，下次要等两分钟");
    now += 60000;
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-b").length, 3, "到点接着补 B 第一条");
    assert.equal(sentTo(sent, "alerts-a").length, 2, "两次之间不重复发给 A");
    assert.equal(sent.at(-1).body.title, firstTitle, "补的是第一条");
  });
});

test("重复提醒送到了没收到第一条的通知方式，就不再补第一条", async (t) => {
  let now = Date.UTC(2026, 9, 22), failB = true;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => failB && url.includes("alerts-b") ? 503 : 200);
  const s = plainStation();
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.deepEqual(incidentsOf(s).low.remaining, ["ch-b"]);
  failB = false;
  now += 2 * 3600000;
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.match(sent.at(-1).body.title, /持续告警/);
  assert.deepEqual(incidentsOf(s).low.remaining, []);
  now += 10 * 60000;
  assert.equal(await evaluateStation(s, null, rules, [chA, chB], 5), null);
  assert.equal(sentTo(sent, "alerts-b").length, 2);
});

test("一个通知方式一直坏着：第一条补满 24 小时，第 2 天起每天只跟着重复提醒试（间隔 1、24、0 小时分别是 24、1、0 次）", async (t) => {
  for (const [hours, perDay] of [[1, 24], [24, 1], [0, 0]]) await t.test(`renotifyHours=${hours}`, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    const t0 = now;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, () => 503), s = plainStation();
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

test("补发间隔 1、2、4…分钟，封顶 1 小时；从第一次发出起最多补 24 小时（共 29 次），之后回到重复提醒的节奏", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = plainStation();
  const slow = { ...rules, renotifyHours: 48 };
  for (const [index, minutes] of [1, 2, 4, 8, 16, 32, 60, 60].entries()) {
    s.alertState = await evaluateStation(s, null, slow, [chA], 5);
    assert.equal(incidentsOf(s).low.attempts, index + 1);
    assert.equal(incidentsOf(s).low.retryAt, now + minutes * 60000);
    assert.equal(sent.length, index + 1);
    now = incidentsOf(s).low.retryAt - 1;
    assert.equal(await evaluateStation(s, null, slow, [chA], 5), null);
    assert.equal(sent.length, index + 1);
    now += 1;
  }
  // 一直补到 24 小时为止：第一次 + 0:01、0:03、0:07、0:15、0:31、1:03，之后每小时一次，最后一次在 23:03
  while (incidentsOf(s).low.remaining.length) {
    now = incidentsOf(s).low.retryAt;
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
  // 还是同一件事：这条重复提醒没送到也不再补
  assert.deepEqual([incidentsOf(s).low.firstAttemptAt, incidentsOf(s).low.remaining], [t0, []]);
});

test("停机超过 24 小时：回来以后不再补第一条", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => 503), s = plainStation();
  const slow = { ...rules, renotifyHours: 48 };
  s.alertState = await evaluateStation(s, null, slow, [chA], 5);
  now += 25 * 3600000;
  assert.equal(await evaluateStation(s, null, slow, [chA], 5), null);
  assert.equal(sent.length, 1);
});

test("那件事不在了就不补：余额恢复、关掉这种提醒、提醒天数改小、余额用完、改成不再续费", async (t) => {
  const cases = [
    // [名字, 上游, 估算, 改了什么, 这件事的键]
    ["单次提醒·余额恢复", () => station(), null, (s) => { s.balance.remaining = 20; return [rules, null]; }, "noRenewalLow"],
    ["单次提醒·关掉偏低", () => station(), null, () => [{ ...rules, onLow: false }, null], "noRenewalLow"],
    ["偏低·余额恢复", () => plainStation(), null, (s) => { s.balance.remaining = 20; return [rules, null]; }, "low"],
    ["偏低·余额恢复且关着恢复提醒", () => plainStation(), null, (s) => { s.balance.remaining = 20; return [{ ...rules, onRecover: false }, null]; }, "low"],
    ["偏低·余额用完且关着用完提醒", () => plainStation(), null, (s) => { s.balance.remaining = 0; return [{ ...rules, onExhaust: false }, null]; }, "low"],
    ["偏低·关掉偏低", () => plainStation(), null, () => [{ ...rules, onLow: false }, null], "low"],
    ["偏低·改成不再续费", () => plainStation(), null, (s) => { s.noRenewal = true; return [rules, null]; }, "low"],
    ["快用完·关掉快用完", () => fastStation(), { etaDays: 2 }, () => [{ ...rules, onEta: false }, { etaDays: 2 }], "eta"],
    ["快用完·提醒天数改小", () => fastStation(), { etaDays: 2 }, () => [{ ...rules, etaDays: 1 }, { etaDays: 2 }], "eta"],
    ["快用完·余额用完", () => fastStation(), { etaDays: 2 }, (s) => { s.balance.remaining = 0; return [rules, { etaDays: 0 }]; }, "eta"],
  ];
  for (const [name, make, prediction, change, key] of cases) await t.test(name, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200), s = make();
    s.alertState = await evaluateStation(s, prediction, rules, [chA, chB], 5);
    assert.deepEqual(incidentsOf(s)[key].remaining, ["ch-b"]);
    const firstToB = sentTo(sent, "alerts-b")[0].body;
    const [activeRules, nextPrediction] = change(s);
    now += 60000;
    s.alertState = (await evaluateStation(s, nextPrediction, activeRules, [chA, chB], 5)) || s.alertState;
    assert.equal(incidentsOf(s)[key].leftAt, now, "记下离开的时间，记录先留着");
    now += 3600000;
    s.alertState = (await evaluateStation(s, nextPrediction, activeRules, [chA, chB], 5)) || s.alertState;
    const replays = sentTo(sent, "alerts-b").filter((item) => item.body.title === firstToB.title && item.body.body.includes("续费") === firstToB.body.includes("续费"));
    assert.equal(replays.length, 1, "B 只在第一次收到过那条，离开以后不补");
  });
});

test("离开不到 24 小时又回来算同一件事：接着原来的补发记录，不从 1 分钟重来；离开满 24 小时再来是新的一件事", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const s = plainStation();
  const slow = { ...rules, renotifyHours: 48 };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  // 偏低 →（读不到余额，默认第一次就算）→ 偏低
  now = t0 + 30 * 60000;
  s.balance = { ok: false, error: "temporary failure" };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  assert.match(sent.at(-1).body.title, /查询失败/);
  assert.equal(incidentsOf(s).low.leftAt, null, "读不到余额的那几轮不算离开");
  now = t0 + 40 * 60000;
  s.balance = { ok: true, remaining: 4 };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  assert.match(sentTo(sent, "alerts-a").at(-1).body.title, /余额偏低/, "A 照旧收到回到偏低的那条");
  assert.equal(incidentsOf(s).low.firstAttemptAt, t0, "还是同一件事");
  assert.ok(incidentsOf(s).low.attempts > 1, "这条也算补过一次，接着原来的退避");
  // 充了值离开偏低 23 小时又回来：同一件事，原来的 24 小时已经用完，不补
  now = t0 + 2 * 3600000;
  s.balance = { ok: true, remaining: 20 };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  now = t0 + 25 * 3600000;
  s.balance = { ok: true, remaining: 4 };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  assert.equal(incidentsOf(s).low.firstAttemptAt, t0);
  now += 60000;
  const before = sent.length;
  assert.equal(await evaluateStation(s, null, slow, [chA, chB], 5), null, "24 小时用完了，不再补");
  assert.equal(sent.length, before);
  // 再离开满 24 小时：下一次偏低是新的一件事，第一条没送到又补
  now += 60000;
  s.balance = { ok: true, remaining: 20 };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  now += 24 * 3600000;
  s.alertState = (await evaluateStation(s, null, slow, [chA, chB], 5)) || s.alertState;
  assert.equal(incidentsOf(s).low, undefined, "离开满 24 小时，这件事结束");
  s.balance = { ok: true, remaining: 4 };
  s.alertState = await evaluateStation(s, null, slow, [chA, chB], 5);
  assert.deepEqual([incidentsOf(s).low.firstAttemptAt, incidentsOf(s).low.attempts], [now, 1]);
});

test("快用完白天花、夜里不花：夜里估不出来不算新的一件事，第 2 天起 B 收到的次数和 A 一样（只跟着重复提醒）", async (t) => {
  let now = Date.UTC(2026, 9, 22, 0); // 上海 8 点
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const s = fastStation();
  const cadence = { ...rules, renotifyHours: 6 };
  for (let minutes = 0; minutes < 4 * 24 * 60; minutes += 10) {
    now = t0 + minutes * 60000;
    const hour = (8 + Math.floor(minutes / 60)) % 24;
    // 白天 9–22 点在花，估得出快用完；夜里近 3 小时没花费，估不出来
    const prediction = hour >= 9 && hour < 22 ? { burnPerDay: 2, etaDays: 2 } : null;
    s.alertState = (await evaluateStation(s, prediction, cadence, [chA, chB], 5)) || s.alertState;
  }
  const count = (host, index) => sentTo(sent, host).filter((item) => item.at >= t0 + index * 86400000 && item.at < t0 + (index + 1) * 86400000).length;
  for (const index of [1, 2, 3]) assert.equal(count("alerts-b", index), count("alerts-a", index), `第 ${index + 1} 天`);
  assert.ok(count("alerts-b", 0) > count("alerts-a", 0), "第一天补第一条");
});

test("快用完关掉再打开、改提醒天数，不到 24 小时都算同一件事", async (t) => {
  for (const change of ["toggle", "etaDays"]) await t.test(change, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    const t0 = now;
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
    const s = fastStation();
    const daily = { ...rules, renotifyHours: 24 };
    const off = change === "toggle" ? { ...daily, onEta: false } : { ...daily, etaDays: 1 };
    s.alertState = await evaluateStation(s, { etaDays: 2 }, daily, [chA, chB], 5);
    now = t0 + 25 * 3600000;
    s.alertState = (await evaluateStation(s, { etaDays: 2 }, off, [chA, chB], 5)) || s.alertState;
    now += 10 * 60000;
    s.alertState = (await evaluateStation(s, { etaDays: 2 }, daily, [chA, chB], 5)) || s.alertState;
    assert.equal(incidentsOf(s).eta.firstAttemptAt, t0, "还是第一天那件事");
    const before = sent.length;
    now += 60 * 60000;
    assert.equal(await evaluateStation(s, { etaDays: 2 }, daily, [chA, chB], 5), null, "第一天的 24 小时用完了，不再补");
    assert.equal(sent.length, before);
  });
});

test("一件事第一次发出的正好是持续告警时，没送到也补", async (t) => {
  const cases = [
    // 不再续费的上游还在偏低时改回普通：下一条是持续告警
    ["改回普通", () => station({ alertState: { state: "warn", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0, noRenewalLowNotifiedAt: 1 } }), (s) => { s.noRenewal = false; return rules; }],
    // 已经偏低了才打开「余额偏低」提醒
    ["打开偏低提醒", () => plainStation({ alertState: { state: "warn", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 } }), () => rules],
  ];
  for (const [name, make, change] of cases) await t.test(name, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
    const s = make();
    if (name === "打开偏低提醒") assert.equal(await evaluateStation(s, null, { ...rules, onLow: false }, [chA, chB], 5), null);
    const activeRules = change(s);
    s.alertState = await evaluateStation(s, null, activeRules, [chA, chB], 5);
    assert.match(sent.at(-1).body.title, /持续告警/);
    assert.deepEqual(incidentsOf(s).low.remaining, ["ch-b"]);
    now += 60000;
    s.alertState = await evaluateStation(s, null, activeRules, [chA, chB], 5);
    assert.equal(sentTo(sent, "alerts-b").length, 2, "补给 B");
    assert.match(sentTo(sent, "alerts-b").at(-1).body.title, /持续告警/, "补的是那条持续告警");
  });
});

test("「读不到余额」一直读不到时照样补；恢复通知没送到也补", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const s = plainStation({ balance: { ok: false, error: "offline" } });
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.deepEqual(incidentsOf(s).error.remaining, ["ch-b"]);
  now += 60000;
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.equal(sentTo(sent, "alerts-b").length, 2, "读不到余额本身不停着");
  s.balance = { ok: true, remaining: 20 };
  now += 60000;
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.match(sent.at(-1).body.title, /恢复通知/);
  assert.deepEqual(incidentsOf(s).recover.remaining, ["ch-b"]);
  now += 60000;
  s.alertState = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.equal(sentTo(sent, "alerts-b").filter((item) => /恢复通知/.test(item.body.title)).length, 2, "恢复通知补给 B");
});

test("不再续费的上游从正常直接跳到用完，也发那一次单次提醒", async (t) => {
  const sent = deliveries(t);
  const s = station({ balance: { ok: true, remaining: 20 }, alertState: { state: "ok", notifiedAt: 0, etaNotifiedAt: 0, errorCount: 0 } });
  assert.equal(await evaluateStation(s, null, rules, [chA], 5), null);
  s.balance = { ok: true, remaining: 0 };
  s.alertState = await evaluateStation(s, null, rules, [chA], 5);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.title, /低余额提醒/);
});

test("只补给这种提醒现在还会发给它的：改了配置的照样补，去掉的、停用的、后来加的不补", async (t) => {
  const chC = { id: "ch-c", name: "C", type: "webhook", enabled: true, config: { url: "https://alerts-c.test/push" } };
  for (const change of ["reconfigured", "removed", "added"]) await t.test(change, async (t) => {
    let now = Date.UTC(2026, 9, 22);
    t.mock.method(Date, "now", () => now);
    const sent = deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200), s = plainStation();
    const once = { ...rules, renotifyHours: 0 };
    s.alertState = await evaluateStation(s, null, once, [chA, chB], 5);
    const fixedB = { ...chB, config: { url: "https://fixed-b.test/push" } };
    const channels = { reconfigured: [chA, fixedB], removed: [chA], added: [chA, chB, chC] }[change];
    now += 60000;
    s.alertState = await evaluateStation(s, null, once, channels, 5);
    if (change === "reconfigured") {
      assert.equal(sentTo(sent, "fixed-b").length, 1, "修好的通知方式收到补发");
      assert.deepEqual(incidentsOf(s).low.remaining, []);
    } else if (change === "removed") {
      assert.equal(sent.length, 2);
      assert.deepEqual(incidentsOf(s).low.remaining, [], "不再发给它了就划掉");
      now += 3600000;
      assert.equal(await evaluateStation(s, null, once, [chA, chB], 5), null, "加回来也不补");
    } else {
      assert.equal(sentTo(sent, "alerts-c").length, 0, "后来加的不补旧提醒");
      assert.equal(sentTo(sent, "alerts-b").length, 2);
    }
    assert.equal(sentTo(sent, "alerts-a").length, 1);
  });
});

test("停用的通知方式每一轮都划掉：没轮到补发时停用一下再启用，也不再补", async (t) => {
  const chC = { id: "ch-c", name: "C", type: "webhook", enabled: true, config: { url: "https://alerts-c.test/push" } };
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, (url) => url.includes("alerts-a") ? 200 : 503), s = plainStation();
  const once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA, chB, chC], 5);
  assert.deepEqual(incidentsOf(s).low.remaining, ["ch-b", "ch-c"]);
  // 第 30 秒（还没到补发）停用 C
  now += 30000;
  s.alertState = (await evaluateStation(s, null, once, [chA, chB, { ...chC, enabled: false }], 5)) || s.alertState;
  assert.deepEqual(incidentsOf(s).low.remaining, ["ch-b"]);
  now += 30000;
  s.alertState = await evaluateStation(s, null, once, [chA, chB, chC], 5);
  assert.equal(sentTo(sent, "alerts-c").length, 1, "C 重新启用也不补");
  assert.equal(sentTo(sent, "alerts-b").length, 2);
});

test("没送到的余额提醒和新的快用完各发各的", async (t) => {
  let now = Date.UTC(2026, 9, 22), status = 503;
  const t0 = now;
  t.mock.method(Date, "now", () => now);
  const sent = deliveries(t, () => status), s = plainStation(), once = { ...rules, renotifyHours: 0 };
  s.alertState = await evaluateStation(s, null, once, [chA], 5);
  now += 60000;
  status = 200;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, once, [chA], 5);
  assert.deepEqual(sent.slice(1).map((item) => item.body.title).map((title) => /余额偏低/.test(title) ? "low" : /耗尽预警/.test(title) ? "eta" : title).sort(), ["eta", "low"]);
  assert.equal(s.alertState.notifiedAt, t0);
  assert.equal(s.alertState.etaNotifiedAt, now);
  assert.deepEqual([incidentsOf(s).low.remaining, incidentsOf(s).eta.remaining], [[], []]);
  assert.deepEqual(s.alertState.lastResults.map((x) => x.ok), [true, true], "这一轮两次发送的结果都记下");
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
    const fast = fastStation({ id: "station-2" });
    fast.alertState = await evaluateStation(fast, { etaDays: 2 }, cadence, [chA, chB], 5);
    const pending = [structuredClone(incidentsOf(once).noRenewalLow), structuredClone(incidentsOf(fast).eta)];
    now += 10 * 60000;
    for (const s of [once, fast]) {
      s.balance = { ok: false, error: "temporary failure" };
      s.alertState = (await evaluateStation(s, { etaDays: 2 }, cadence, [chA, chB], 5)) || s.alertState;
    }
    assert.deepEqual([incidentsOf(once).noRenewalLow, incidentsOf(fast).eta], pending, "读不到余额只停着，不删、不算离开");
    now += 10 * 60000;
    fixedB = true;
    once.balance = { ok: true, remaining: 4 };
    fast.balance = { ok: true, remaining: 10 };
    once.alertState = await evaluateStation(once, null, cadence, [chA, chB], 5);
    fast.alertState = await evaluateStation(fast, { etaDays: 2 }, cadence, [chA, chB], 5);
    const toB = sentTo(sent, "alerts-b").map((item) => item.body.title);
    assert.ok(toB.filter((title) => /低余额提醒/.test(title)).length >= 2, "B 修好后收到单次提醒");
    assert.ok(toB.filter((title) => /耗尽预警/.test(title)).length >= 2, "B 修好后收到快用完");
    assert.deepEqual([incidentsOf(once).noRenewalLow.remaining, incidentsOf(fast).eta.remaining], [[], []]);
  });
});

test("只是记下离开的时间也要写回（不然下一次回来会被当成新的一件事）", async (t) => {
  let now = Date.UTC(2026, 9, 22);
  t.mock.method(Date, "now", () => now);
  deliveries(t, (url) => url.includes("alerts-b") ? 503 : 200);
  const s = fastStation();
  s.alertState = await evaluateStation(s, { etaDays: 2 }, rules, [chA, chB], 5);
  now += 60000;
  const next = await evaluateStation(s, { etaDays: 10 }, rules, [chA, chB], 5);
  assert.ok(next, "这一轮只有离开的时间变了，也返回要写回的状态");
  assert.equal(next.incidents.eta.leftAt, now);
});

test("发送期间改了「不再续费」：照 store 的做法清掉单次提醒的记录，不写回旧的", async (t) => {
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
    assert.equal(next.incidents?.noRenewalLow, undefined);
    assert.equal(next.state, "warn");
    if (!from) {
      // 改成不再续费以后：旧的偏低不再补，下一轮发那一次单次提醒
      const sent = deliveries(t);
      s.alertState = next;
      s.alertState = await evaluateStation(s, null, rules, [chA], 5);
      assert.deepEqual(sent.map((item) => item.body.title.includes("低余额提醒")), [true]);
      assert.ok(Number.isFinite(incidentsOf(s).low.leftAt), "偏低那件事离开了");
    }
  });
});

test("#42 存的旧格式补发任务升级后丢掉，不再补发", async (t) => {
  const sent = deliveries(t);
  const legacy = { kind: "state", eventKey: "low", targetKeys: [JSON.stringify(["ch-a", "webhook", 1]), JSON.stringify(["ch-b", "webhook", 1])],
    remainingKeys: [JSON.stringify(["ch-b", "webhook", 1])], deliveredKeys: [JSON.stringify(["ch-a", "webhook", 1])], attempts: 40, retryAt: 0 };
  const s = plainStation({ alertState: { state: "warn", notifiedAt: Date.now(), etaNotifiedAt: 0, errorCount: 0, pendingDelivery: legacy } });
  const next = await evaluateStation(s, null, rules, [chA, chB], 5);
  assert.equal(sent.length, 0);
  assert.equal("pendingDelivery" in next, false);
  assert.equal(next.incidents, undefined);
});

test("存着的记录格式不对的不要", async (t) => {
  const valid = { kind: "state", state: "warn", eventKey: "low", firstAttemptAt: Date.now() - 60000, remaining: ["ch-a"], attempts: 1, retryAt: 0, leftAt: null };
  // 每一例单独放：去掉校验时都会补发给 A
  const broken = {
    "remaining 不是数组": { low: { ...valid, remaining: "ch-a" } },
    "remaining 里有不是字符串的": { low: { ...valid, remaining: ["ch-a", 1] } },
    "时间不是数": { low: { ...valid, firstAttemptAt: "x" } },
    "leftAt 不是数": { low: { ...valid, leftAt: "x" } },
    "认不出的键": { bogus: { ...valid } },
  };
  for (const [name, incidents] of Object.entries(broken)) await t.test(name, async (t) => {
    const sent = deliveries(t);
    const s = plainStation({ alertState: { state: "warn", notifiedAt: Date.now(), etaNotifiedAt: 0, errorCount: 0, incidents } });
    const next = await evaluateStation(s, null, rules, [chA], 5);
    assert.equal(sent.length, 0);
    assert.equal(next.incidents, undefined);
  });
  // 对照：格式对的照常补
  const sent = deliveries(t);
  const ok = plainStation({ alertState: { state: "warn", notifiedAt: Date.now(), etaNotifiedAt: 0, errorCount: 0, incidents: { low: valid } } });
  await evaluateStation(ok, null, rules, [chA], 5);
  assert.equal(sent.length, 1);
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
  const s = plainStation();
  s.alertState = await evaluateStation(s, null, bound, [chA, chB], 5);
  first = false;
  most = 0;
  now += 60000;
  s.alertState = await evaluateStation(s, { etaDays: 2 }, bound, [chA, chB], 5);
  assert.equal(most, 2, "两次发送同时在路上");
  assert.deepEqual(incidentsOf(s).low.remaining, []);
});

test("余额已经用完时不再推快用完；还剩一点钱时照推", async (t) => {
  const sent = deliveries(t);
  const s = plainStation({ balance: { ok: true, remaining: 0 } });
  s.alertState = await evaluateStation(s, { burnPerDay: 2, etaDays: 0 }, rules, [chA], 5);
  assert.match(sent.at(-1).body.title, /余额耗尽/);
  assert.equal(await evaluateStation(s, { burnPerDay: 2, etaDays: 0 }, rules, [chA], 5), null, "原来这一轮会补推快用完");
  s.balance = { ok: true, remaining: -1 };
  assert.equal(await evaluateStation(s, { burnPerDay: 2, etaDays: -0.5 }, rules, [chA], 5), null, "透支了也不推");
  assert.equal(sent.length, 1);
  const low = plainStation({ balance: { ok: true, remaining: 0.01 } });
  low.alertState = await evaluateStation(low, { burnPerDay: 2, etaDays: 0.005 }, rules, [chA], 5);
  low.alertState = await evaluateStation(low, { burnPerDay: 2, etaDays: 0.005 }, rules, [chA], 5);
  assert.match(sent.at(-1).body.title, /耗尽预警/);
});

test("上游自己的提醒线是空串（旧数据）时用全局的，和页面一样", async (t) => {
  const sent = deliveries(t);
  await evaluateStation(plainStation({ lowBalanceUsd: "" }), null, rules, [chA], 5);
  assert.match(sent.at(-1).body.title, /余额偏低/);
});
