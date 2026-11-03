import assert from "node:assert/strict";
import test from "node:test";
import { handleChannelProfitRequest } from "./handler.js";

// 模块和接入向导都假装已经起好（rt 上有），只测请求格式、参数传递和错误码
function runtime(overrides = {}) {
  const calls = [];
  const rt = { store: { get: () => ({ id: "own", baseUrl: "https://own.test", accessToken: "secret-pat" }) }, reconciliation: {}, channelOnboarding: {},
    channelProfit: {
      options: async (id) => { calls.push(["options", id]); return { ok: true, channels: [], upstreams: [] }; },
      selectKey: async (input) => { calls.push(["select-key", input]); return { changed: true }; },
      stop: async (input) => { calls.push(["stop", input]); return { stopped: [], optedOut: [] }; },
      ...overrides } };
  return { rt, calls };
}
const post = (body) => new Request("https://console.test/api/reconciliation/channels/stop", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("channels 接口：options 读 ?ownStationId=；select-key / stop 读 body，参数原样交给模块", async () => {
  const { rt, calls } = runtime();
  const options = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/options?ownStationId=own"), rt, "options");
  assert.deepEqual([options.status, (await options.json()).ok], [200, true]);
  await handleChannelProfitRequest(post({ ownStationId: "own", channelId: 1, upstreamStationId: "up", tokenId: 7 }), rt, "select-key");
  await handleChannelProfitRequest(post({ ownStationId: "own", channelIds: [3] }), rt, "stop");
  assert.deepEqual(calls, [["options", "own"], ["select-key", { ownStationId: "own", channelId: 1, upstreamStationId: "up", tokenId: 7 }], ["stop", { ownStationId: "own", channelIds: [3] }]]);
});

test("channels 接口：请求不对给 400 和码；模块抛的带码的错原样给码，原文里的令牌被脱敏", async () => {
  const { rt } = runtime({ stop: async () => { throw Object.assign(new Error("读取失败 Bearer secret-pat"), { code: "KEY_AGENT_NOT_CONFIGURED" }); } });
  const badJson = await handleChannelProfitRequest(post("{not json"), rt, "stop");
  assert.deepEqual([badJson.status, (await badJson.json()).code], [400, "INVALID_REQUEST"]);
  const array = await handleChannelProfitRequest(post([1]), rt, "stop");
  assert.equal(array.status, 400);
  const noOwn = await handleChannelProfitRequest(post({ channelIds: [1] }), rt, "stop");
  assert.deepEqual([noOwn.status, (await noOwn.json()).code], [400, "OWN_STATION_UNSET"]);
  const failed = await handleChannelProfitRequest(post({ ownStationId: "own", channelIds: [1] }), rt, "stop");
  const body = await failed.json();
  assert.deepEqual([failed.status, body.code], [400, "KEY_AGENT_NOT_CONFIGURED"]);
  assert.doesNotMatch(body.error, /secret-pat/, "原文里的令牌不能原样给出去");
});

test("channels 接口：key-usage 是只读的 GET，读 ?ownStationId=&channelId=&upstreamStationId=&tokenId=，原样交给对账模块；没有自营站点是 400", async () => {
  const calls = [];
  const rt = { store: { get: () => ({ id: "own" }) }, channelOnboarding: {}, channelProfit: {}, reconciliation: { checkKeyUsage: async (input) => { calls.push(input); return { checked: true, idle: true }; } } };
  const ok = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/key-usage?ownStationId=own&channelId=3&upstreamStationId=up&tokenId=9"), rt, "key-usage");
  assert.deepEqual([ok.status, await ok.json()], [200, { checked: true, idle: true }]);
  assert.deepEqual(calls, [{ ownStationId: "own", channelId: "3", upstreamStationId: "up", tokenId: "9" }]);
  const unset = await handleChannelProfitRequest(new Request("https://console.test/api/reconciliation/channels/key-usage?channelId=3"), rt, "key-usage");
  assert.deepEqual([unset.status, (await unset.json()).code], [400, "OWN_STATION_UNSET"]);
});
