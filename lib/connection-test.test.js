import assert from "node:assert/strict";
import test from "node:test";
import { describeConnectionFailure } from "./connection-test.js";

test("连接失败会归类为可执行提示，并隐藏临时凭证", () => {
  const authFailure = describeConnectionFailure("401 Unauthorized: expired-token", { accessToken: "expired-token" });
  assert.equal(authFailure.code, "AUTHENTICATION_FAILED");
  assert.match(authFailure.action, /重新生成/);
  assert.doesNotMatch(authFailure.diagnostic, /expired-token/);

  const networkFailure = describeConnectionFailure("fetch failed: ECONNREFUSED", {});
  assert.equal(networkFailure.code, "NETWORK_UNREACHABLE");
  assert.match(networkFailure.action, /防火墙/);

  const endpointFailure = describeConnectionFailure("响应中没有额度数据（quota）", {});
  assert.equal(endpointFailure.code, "ENDPOINT_MISMATCH");
});
