// 利润问题的推送（E 里整个删掉）：发送层不再加前缀以后，靠正文最后一行的落款带上关键词「炬元」
import test from "node:test";
import assert from "node:assert/strict";
import { NOTIFY_KEYWORD } from "../lib/brand.js";
import { notifyReconciliationHealth } from "./reconciliation-notify.js";

test("利润问题的推送：正文最后一行是落款，带着推荐给机器人设的关键词", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); });
  const calls = [];
  const repo = {
    getAlertState: async () => null,
    setAlertState: async (...args) => { calls.push(args); },
    clearActiveAlerts: async () => {},
  };
  const rt = { store: { channels: [{ id: "c", type: "webhook", name: "运维群", enabled: true, config: { url: "https://hooks.example.com/x" } }] } };
  const rule = { id: "r1", tokenName: "prod-key", fixedGroup: "default", channels: [{ name: "渠道 A" }] };
  await notifyReconciliationHealth(rt, repo, rule, { health: { code: "KEY_INVALID_OR_DENIED", label: "上游拒绝读取这把 Key" }, window: {} });
  assert.equal(sent.length, 1);
  const lines = sent[0].body.split("\n");
  assert.equal(lines.at(-1), "炬元告警中心");
  assert.ok(`${sent[0].title}\n${sent[0].body}`.includes(NOTIFY_KEYWORD));
  assert.equal(calls.length, 1);
});

// 令牌作废、少了权限（用语规范 §10「令牌坏了的推送」，过渡期，随 E 去掉）：按站点只推一条，写清是哪个站点、几个渠道的利润先不算；
// 没标 push 的利润类问题（比如「这把 Key 还给别处用吗？」）照旧只记状态
function tokenFixture(t, { stations, rules }) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); });
  const states = new Map(), cleared = [];
  const repo = {
    getAlertState: async (key, code) => states.get(`${key}|${code}`) ?? null,
    setAlertState: async (key, code, value) => { states.set(`${key}|${code}`, { active: value.active ? 1 : 0, ...value, first_seen_at: value.firstSeenAt, last_notified_at: value.lastNotifiedAt }); },
    clearActiveAlerts: async (key) => { cleared.push(key); for (const k of [...states.keys()]) if (k.startsWith(`${key}|`)) states.delete(k); },
    listRules: async () => rules,
  };
  const rt = { store: { channels: [{ id: "c", type: "webhook", name: "运维群", enabled: true, config: { url: "https://hooks.example.com/x" } }], get: (id) => stations[id] || null } };
  return { sent, states, cleared, repo, rt };
}
const ruleOf = (id, extra = {}) => ({ id, enabled: true, upstreamStationId: "up", ownStationId: "own", tokenName: `key-${id}`, fixedGroup: "default", channels: [{ name: `渠道 ${id}` }, { name: `渠道 ${id}b` }], ...extra });
const tokenResult = (code, side, extra = {}) => ({ health: { code, label: "x", issues: [{ code, side, ...extra }] }, window: {} });

test("令牌坏了的推送：同一个上游下 3 条在算的，只推 1 条；标题和正文写清是哪个上游、几个渠道的利润先不算（§10）", async (t) => {
  const rules = [ruleOf("r1"), ruleOf("r2"), ruleOf("r3")];
  const f = tokenFixture(t, { stations: { up: { id: "up", name: "Foo" }, own: { id: "own", name: "My Site" } }, rules });
  for (const rule of rules) await notifyReconciliationHealth(f.rt, f.repo, rule, tokenResult("ACCESS_TOKEN_LEGACY_RETIRED", "upstream", { stationName: "Foo" }));
  assert.equal(f.sent.length, 1, "3 条绑定、1 个上游，只推 1 条");
  const [message] = f.sent;
  assert.equal(message.title, "【炬元告警】Foo 访问令牌已经作废了");
  const lines = message.body.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["上游：Foo", "状态：访问令牌已经作废了", "影响：这个上游下 6 个渠道的利润先不算"]);
  assert.match(lines[3], /^说明：New API 升级以后旧式的访问令牌不能用了，要换一个新令牌（nap_ 开头），并勾上这些权限：profile:read、api_key:read、usage:read$/);
  assert.match(lines[4], /^时间：\d+月\d+日 \d+:\d{2}$/);
  assert.equal(lines.at(-1), "炬元告警中心");
  // 换好令牌以后（这个站点下有一条读通了）去掉记录，不推恢复；以后再坏又推一条
  await notifyReconciliationHealth(f.rt, f.repo, rules[0], { health: { code: "READY" }, window: {} });
  assert.equal(f.sent.length, 1, "不推恢复");
  await notifyReconciliationHealth(f.rt, f.repo, rules[1], tokenResult("ACCESS_TOKEN_LEGACY_RETIRED", "upstream", { stationName: "Foo" }));
  assert.equal(f.sent.length, 2);
});

test("令牌坏了的推送：自营站点的令牌坏了，只推 1 条，标题不写「上游」；少了权限写少的那一项，没说就让人照清单勾", async (t) => {
  const rules = [ruleOf("r1"), ruleOf("r2"), ruleOf("r3", { upstreamStationId: "up2" })];
  const f = tokenFixture(t, { stations: { up: { id: "up", name: "Foo" }, up2: { id: "up2", name: "Bar" }, own: { id: "own", name: "My Site" } }, rules });
  for (const rule of rules) await notifyReconciliationHealth(f.rt, f.repo, rule, tokenResult("ACCESS_TOKEN_SCOPE_DENIED", "own", { missingScope: "log:read" }));
  assert.equal(f.sent.length, 1, "自营站点只有一个，不管几条绑定");
  assert.equal(f.sent[0].title, "【炬元告警】自营站点 My Site 令牌少了权限");
  assert.ok(!f.sent[0].title.includes("上游"));
  const lines = f.sent[0].body.split("\n");
  assert.deepEqual(lines.slice(0, 4), ["自营站点：My Site", "状态：令牌少了「log:read」的权限", "影响：各渠道的利润先不算", "说明：给令牌补上这项权限，或者换一个带这项权限的令牌"]);
  // 不知道少的是哪一项
  const g = tokenFixture(t, { stations: { up: { id: "up" }, own: { id: "own" } }, rules: [ruleOf("r1")] });
  await notifyReconciliationHealth(g.rt, g.repo, ruleOf("r1"), tokenResult("ACCESS_TOKEN_SCOPE_DENIED", "upstream"));
  assert.equal(g.sent[0].title, "【炬元告警】未命名上游 令牌少了权限");
  const unknown = g.sent[0].body.split("\n");
  assert.deepEqual(unknown.slice(0, 2), ["上游：未命名上游", "状态：令牌少了权限"]);
  assert.match(unknown[3], /^说明：New API 没说少的是哪一项。给令牌勾上这些权限：profile:read、api_key:read、usage:read，或者换一个带这些权限的令牌$/);
});

test("令牌坏了的推送：同一个上游 3 条绑定并发跑（轮询就是几条一起跑），只推 1 条（审核 #107 中-1）", async (t) => {
  const rules = [ruleOf("r1"), ruleOf("r2"), ruleOf("r3")];
  const f = tokenFixture(t, { stations: { up: { id: "up", name: "Foo" } }, rules });
  // 读、写告警状态都是异步的（真实库），检查「推过没有」和写下「推过了」之间别的绑定会插进来
  const slow = f.repo.getAlertState;
  f.repo.getAlertState = async (...args) => { const value = await slow(...args); await new Promise((resolve) => setTimeout(resolve, 5)); return value; }; // 先读，再等一会才交回来：几条同时读到「没推过」
  await Promise.all(rules.map((rule) => notifyReconciliationHealth(f.rt, f.repo, rule, tokenResult("ACCESS_TOKEN_LEGACY_RETIRED", "upstream", { stationName: "Foo" }))));
  assert.equal(f.sent.length, 1, "并发也只推 1 条");
});

test("令牌坏了的推送：同一个上游一条固定成本（上游读不到只当参考、照样 READY）一条按用量（令牌坏了），连跑 3 轮只推 1 条；固定成本那条不清站点上的记录（审核 #107 中-2）", async (t) => {
  const fixedRule = ruleOf("fixed"), usageRule = ruleOf("usage");
  const f = tokenFixture(t, { stations: { up: { id: "up", name: "Foo" } }, rules: [fixedRule, usageRule] });
  // 固定成本那条：上游令牌坏了只当参考，毛利照算，health 是 READY，但问题里带着上游的令牌码（reference）
  const fixedResult = { health: { code: "READY", issues: [{ code: "ACCESS_TOKEN_LEGACY_RETIRED", side: "upstream", reference: true }] }, window: {} };
  for (let round = 0; round < 3; round += 1) {
    await notifyReconciliationHealth(f.rt, f.repo, fixedRule, fixedResult);
    await notifyReconciliationHealth(f.rt, f.repo, usageRule, tokenResult("ACCESS_TOKEN_LEGACY_RETIRED", "upstream", { stationName: "Foo" }));
  }
  assert.equal(f.sent.length, 1, "3 轮只推 1 条");
  // 两条都读通了（问题里没有令牌码）才去掉记录
  await notifyReconciliationHealth(f.rt, f.repo, fixedRule, { health: { code: "READY", issues: [] }, window: {} });
  await notifyReconciliationHealth(f.rt, f.repo, usageRule, tokenResult("ACCESS_TOKEN_LEGACY_RETIRED", "upstream", { stationName: "Foo" }));
  assert.equal(f.sent.length, 2, "读通了才清，之后再坏又推一条");
});

test("没标 push 的利润类问题只记状态不推；标了 push 的（Key 被拒）照推", async (t) => {
  const f = tokenFixture(t, { stations: {}, rules: [] });
  await notifyReconciliationHealth(f.rt, f.repo, ruleOf("r1"), { health: { code: "COST_COVERAGE_UNKNOWN", label: "x" }, window: {} });
  assert.equal(f.sent.length, 0);
  await notifyReconciliationHealth(f.rt, f.repo, ruleOf("r1"), { health: { code: "KEY_INVALID_OR_DENIED", label: "x" }, window: {} });
  assert.equal(f.sent.length, 1);
});
