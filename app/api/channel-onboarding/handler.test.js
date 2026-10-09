import test from "node:test";
import assert from "node:assert/strict";
import { handleChannelOnboardingRequest } from "./handler.js";

const request = (body = {}) => new Request("http://localhost/api/channel-onboarding", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("HTTP边界保留partial状态与公开重试ID，不能把200当作完成", async () => {
  const result = { complete: false, monitor: { status: "linked", stationIds: ["monitor"] },
    reconciliation: { status: "unverified", reason: "DEPLOYMENT_NOT_VERIFIED" },
    saved: { stationIds: ["monitor"], authorizationStationId: "grant" }, retryInput: { stationId: "monitor" } };
  const response = await handleChannelOnboardingRequest(request(), { channelOnboarding: { connect: async () => result } }, "connect");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
});

test("HTTP边界保留来源变化码且隐藏错误回显凭证", async () => {
  const rt = { channelOnboarding: { probe: async () => {
    throw Object.assign(new Error("token private-secret changed"), { code: "CHANNEL_SOURCE_CHANGED" });
  } } };
  const response = await handleChannelOnboardingRequest(request({ newStation: { accessToken: "private-secret" } }), rt, "probe");
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "CHANNEL_SOURCE_CHANGED");
  assert.equal(body.error.includes("private-secret"), false);
});

test("HTTP拒绝坏JSON，不回显包含密码的解析错误", async () => {
  const bad = new Request("http://localhost/api/channel-onboarding", { method: "POST", body: "private-password is not JSON" });
  const response = await handleChannelOnboardingRequest(bad, { channelOnboarding: {} }, "connect");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "请求格式无效", code: "INVALID_REQUEST" });
});

test("HTTP目录查询/即时同步调用公开模块，未初始化明确503", async () => {
  const rt = { channelOnboarding: { list: async () => ({ channels: [], stale: true }),
    sync: async () => ({ channels: [{ id: 1 }], stale: false }) } };
  assert.deepEqual(await (await handleChannelOnboardingRequest(request(), rt, "list")).json(), { channels: [], stale: true });
  assert.deepEqual(await (await handleChannelOnboardingRequest(request(), rt, "sync")).json(), { channels: [{ id: 1 }], stale: false });
  assert.equal((await handleChannelOnboardingRequest(request(), {}, "list")).status, 503);
});
