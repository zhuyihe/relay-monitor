import assert from "node:assert/strict";
import test from "node:test";
import { handleChannelProfitRequest } from "./handler.js";

// 模块和接入向导都假装已经起好（rt 上有），只测请求格式、参数传递和错误码
function runtime(overrides = {}) {
  const calls = [];
  const rt = { store: { get: () => ({ id: "own", baseUrl: "https://own.test", accessToken: "secret-pat" }) }, reconciliation: {}, channelOnboarding: {},
    channelProfit: {
      status: async (id) => { calls.push(["status", id]); return { ok: true, channels: [], groups: [] }; },
      overview: async (id) => { calls.push(["overview", id]); return { ok: true, cards: [], upstreams: [], unmatched: [] }; },
      start: async (input) => { calls.push(["start", input]); return { started: [], alreadyRunning: [], blocked: [], failed: [] }; },
      stop: async (input) => { calls.push(["stop", input]); return { stopped: [], optedOut: [] }; },
      ...overrides } };
  return { rt, calls };
}
const post = (body) => new Request("https://console.test/api/reconciliation/channels/start", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("channels 接口：status 读 ?ownStationId=；start / stop 读 body，参数原样交给模块", async () => {
  const { rt, calls } = runtime();
  const status = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels?ownStationId=own"), rt, "status");
  assert.deepEqual([status.status, (await status.json()).ok], [200, true]);
  await handleChannelProfitRequest(post({ ownStationId: "own", channelIds: [1, 2], coverage: { "up:1": { answer: "none" } } }), rt, "start");
  await handleChannelProfitRequest(post({ ownStationId: "own", channelIds: [3] }), rt, "stop");
  assert.deepEqual(calls, [["status", "own"], ["start", { ownStationId: "own", channelIds: [1, 2], coverage: { "up:1": { answer: "none" } } }], ["stop", { ownStationId: "own", channelIds: [3] }]]);
});

test("channels 接口：请求不对给 400 和码；模块抛的带码的错原样给码，原文里的令牌被脱敏", async () => {
  const { rt } = runtime({ start: async () => { throw Object.assign(new Error("读取失败 Bearer secret-pat"), { code: "KEY_AGENT_NOT_CONFIGURED" }); } });
  const badJson = await handleChannelProfitRequest(post("{not json"), rt, "start");
  assert.deepEqual([badJson.status, (await badJson.json()).code], [400, "INVALID_REQUEST"]);
  const array = await handleChannelProfitRequest(post([1]), rt, "start");
  assert.equal(array.status, 400);
  const noOwn = await handleChannelProfitRequest(post({ channelIds: [1] }), rt, "start");
  assert.deepEqual([noOwn.status, (await noOwn.json()).code], [400, "OWN_STATION_UNSET"]);
  const failed = await handleChannelProfitRequest(post({ ownStationId: "own", channelIds: [1] }), rt, "start");
  const body = await failed.json();
  assert.deepEqual([failed.status, body.code], [400, "KEY_AGENT_NOT_CONFIGURED"]);
  assert.doesNotMatch(body.error, /secret-pat/, "原文里的令牌不能原样给出去");
});

test("channels 接口：overview 读 ?ownStationId=（GET），没有自营站点给 400", async () => {
  const { rt, calls } = runtime();
  const ok = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/overview?ownStationId=own"), rt, "overview");
  assert.deepEqual([ok.status, (await ok.json()).ok, calls], [200, true, [["overview", "own"]]]);
  const none = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/overview"), rt, "overview");
  assert.deepEqual([none.status, (await none.json()).code], [400, "OWN_STATION_UNSET"]);
});

test("channels 接口：account-use 读 body 的上游编号和回答，原样交给模块（回答「这个上游账号只给你自己的渠道用吗？」）", async () => {
  const { rt, calls } = runtime({ answerAccountUse: async (input) => { calls.push(["account-use", input]); return { accountUse: input.accountUse, previous: null, changedRules: [], failed: [] }; } });
  const ok = await handleChannelProfitRequest(post({ ownStationId: "own", upstreamStationId: "up1", accountUse: "only_mine" }), rt, "account-use");
  assert.deepEqual([ok.status, (await ok.json()).accountUse, calls], [200, "only_mine", [["account-use", { ownStationId: "own", upstreamStationId: "up1", accountUse: "only_mine" }]]]);
  const bad = await handleChannelProfitRequest(post({ upstreamStationId: "up1", accountUse: "only_mine" }), rt, "account-use");
  assert.deepEqual([bad.status, (await bad.json()).code], [400, "OWN_STATION_UNSET"]);
});

test("channels 接口：upstream-count 读 ?upstreamStationId=（GET，不用自营站点），数这个上游下在算的渠道（删上游确认框「这个上游下 N 个渠道也会停止算利润」）", async () => {
  const counted = [];
  const rt = { store: { get: () => null }, reconciliation: { countUpstreamChannels: async (id) => { counted.push(id); return { ruleCount: 2, channelCount: 3 }; } }, channelOnboarding: {}, channelProfit: {} };
  const ok = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/upstream-count?upstreamStationId=up1"), rt, "upstream-count");
  assert.deepEqual([ok.status, await ok.json(), counted], [200, { ruleCount: 2, channelCount: 3 }, ["up1"]]);
  const none = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/upstream-count"), rt, "upstream-count");
  assert.deepEqual([none.status, (await none.json()).code], [400, "INVALID_REQUEST"]);
});
