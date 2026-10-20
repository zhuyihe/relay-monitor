import assert from "node:assert/strict";
import test from "node:test";
import { connectionDiagnostic } from "./connection-test.js";
import { redact } from "../server/stations.js";

test("详细原因里隐藏这次用到的凭证，Error 和原文都收", () => {
  assert.equal(connectionDiagnostic("401 Unauthorized: expired-token", { accessToken: "expired-token" }), "401 Unauthorized: [已隐藏]");
  assert.equal(connectionDiagnostic(new Error("fetch failed"), {}), "fetch failed");
  assert.equal(connectionDiagnostic(null), "");
  // 访问令牌带 Bearer 前缀时，回显的裸令牌也要藏
  assert.doesNotMatch(connectionDiagnostic("bad pat-secret", { accessToken: "Bearer pat-secret" }), /pat-secret/);
});

test("诊断信息会隐藏上游回显的常见凭证格式", () => {
  const diagnostic = connectionDiagnostic(
    "401 authorization: Bearer server-secret access_token=refresh-secret password=plain-text",
    {}
  );
  assert.doesNotMatch(diagnostic, /server-secret|refresh-secret|plain-text/);
  assert.match(diagnostic, /\[已隐藏\]/);
});

test("诊断独立净化旧/临时/当前缓存中的裸access和refresh，截断前先隐藏完整值", () => {
  const old = { accessToken: "Bearer old-pat", s2Tokens: { accessToken: "old-jwt", refreshToken: "old-refresh" } };
  const current = { s2Tokens: { accessToken: "new-jwt", refreshToken: "new-refresh" } };
  const longSecret = "x".repeat(600);
  const error = `old-pat old-jwt old-refresh new-jwt new-refresh ${longSecret}`;
  const diagnostic = connectionDiagnostic(error, [old, current, { password: longSecret }]);
  assert.doesNotMatch(diagnostic, /old-pat|old-jwt|old-refresh|new-jwt|new-refresh|x{20}/);
  assert.match(diagnostic, /已隐藏/);
  assert.ok(connectionDiagnostic("y".repeat(900)).length <= 500);
});

test("资源列表响应会脱敏保存的余额查询错误", () => {
  const station = {
    id: "st_demo",
    accessToken: "saved-token",
    apiKey: "saved-key",
    password: "saved-password",
    s2Tokens: { accessToken: "cached-jwt", refreshToken: "cached-refresh" },
    onboardingOrigin: { requestId: "internal-origin" },
    authorizationUpdateRef: { requestId: "internal-rotation" },
    balance: {
      ok: false,
      checkedAt: "2026-09-18T08:00:00.000Z",
      latencyMs: 123,
      error: "401 authorization: Bearer saved-token api_key=saved-key password=saved-password",
      code: "AUTHENTICATION_FAILED",
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
  assert.equal(result.balance.code, "AUTHENTICATION_FAILED");
  assert.doesNotMatch(result.balance.error, /saved-token|saved-key|saved-password/);
  assert.equal("accessToken" in result, false);
  assert.equal("apiKey" in result, false);
  assert.equal("password" in result, false);
  assert.equal("onboardingOrigin" in result, false);
  assert.equal("authorizationUpdateRef" in result, false);
});
