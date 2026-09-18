import assert from "node:assert/strict";
import test from "node:test";
import { isDefaultPasswordRouteAllowed, SessionManager, shouldMarkCookieSecure } from "./auth.js";

function sessions() {
  const manager = new SessionManager(null);
  manager.secret = "test-session-secret";
  return manager;
}

test("会话 Cookie 只在 HTTPS 或显式受信任代理下标记 Secure", () => {
  const manager = sessions();
  assert.equal(shouldMarkCookieSecure({ protocol: "http:", forwardedProto: "https", trustProxy: false }), false);
  assert.doesNotMatch(manager.cookieHeader("token", false), /; Secure/);
  assert.equal(shouldMarkCookieSecure({ protocol: "https:" }), true);
  assert.match(manager.cookieHeader("token", true), /; Secure/);
  assert.equal(shouldMarkCookieSecure({ protocol: "http:", forwardedProto: "https", trustProxy: true }), true);
});

test("默认密码只允许改密相关 API，凭证变化会使旧会话失效", () => {
  const manager = sessions();
  const auth = { username: "admin", hash: "hash-a", isDefault: true };
  const token = manager.issue(auth.username, manager.sessionVersion(auth));
  assert.equal(isDefaultPasswordRouteAllowed("/api/auth/me"), true);
  assert.equal(isDefaultPasswordRouteAllowed("/api/auth/password"), true);
  assert.equal(isDefaultPasswordRouteAllowed("/api/auth/logout"), true);
  assert.equal(isDefaultPasswordRouteAllowed("/api/stations"), false);
  assert.equal(manager.verify(token)?.v, manager.sessionVersion(auth));
  auth.hash = "hash-b";
  assert.notEqual(manager.verify(token)?.v, manager.sessionVersion(auth));
});
