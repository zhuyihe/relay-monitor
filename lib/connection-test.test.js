import assert from "node:assert/strict";
import test from "node:test";
import { describeConnectionFailure } from "./connection-test.js";
import { redact } from "../server/stations.js";

test("连接失败会归类为可执行提示，并隐藏临时凭证", () => {
  const authFailure = describeConnectionFailure("401 Unauthorized: expired-token", { accessToken: "expired-token" });
  assert.equal(authFailure.code, "AUTHENTICATION_FAILED");
  assert.equal(authFailure.category, "凭证或权限问题");
  assert.match(authFailure.action, /重新生成/);
  assert.doesNotMatch(authFailure.diagnostic, /expired-token/);

  const networkFailure = describeConnectionFailure("fetch failed: ECONNREFUSED", {});
  assert.equal(networkFailure.code, "NETWORK_UNREACHABLE");
  assert.match(networkFailure.action, /防火墙/);

  const endpointFailure = describeConnectionFailure("响应中没有额度数据（quota）", {});
  assert.equal(endpointFailure.code, "ENDPOINT_MISMATCH");
});

test("诊断信息会隐藏上游回显的常见凭证格式", () => {
  const failure = describeConnectionFailure(
    "401 authorization: Bearer server-secret access_token=refresh-secret password=plain-text",
    {}
  );
  assert.doesNotMatch(failure.diagnostic, /server-secret|refresh-secret|plain-text/);
  assert.match(failure.diagnostic, /\[已隐藏\]/);
});

test("资源列表响应会脱敏保存的余额查询错误", () => {
  const station = {
    id: "st_demo",
    accessToken: "saved-token",
    apiKey: "saved-key",
    password: "saved-password",
    balance: {
      ok: false,
      checkedAt: "2026-09-18T08:00:00.000Z",
      latencyMs: 123,
      error: "401 authorization: Bearer saved-token api_key=saved-key password=saved-password",
    },
  };
  const rt = {
    history: {
      predict: () => null,
      sparkline: () => [],
      usedSince: () => 0,
    },
  };

  const result = redact(rt, station);
  assert.equal(result.balance.checkedAt, station.balance.checkedAt);
  assert.doesNotMatch(result.balance.error, /saved-token|saved-key|saved-password/);
  assert.equal("accessToken" in result, false);
  assert.equal("apiKey" in result, false);
  assert.equal("password" in result, false);
});
