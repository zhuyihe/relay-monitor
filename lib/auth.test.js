import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_COOKIE_NAME, LOGIN_SITE_FAILURE_LIMIT, LOGIN_SITE_WINDOW_MS, hashPassword, isDefaultPasswordRouteAllowed, SessionManager, shouldMarkCookieSecure, verifyPassword } from "./auth.js";

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

test("hashPassword / verifyPassword：异步 scrypt，不堵事件循环也能校验对错（登录再防一层，10-25）", async () => {
  const { salt, hash } = await hashPassword("right-password");
  assert.equal(await verifyPassword("right-password", salt, hash), true);
  assert.equal(await verifyPassword("wrong-password", salt, hash), false);
  // 校验密码时不堵事件循环：并发跑好几次，定时器照样能按时触发
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  await Promise.all(Array.from({ length: 5 }, () => verifyPassword("right-password", salt, hash)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticked, true, "scrypt 校验在跑的时候，0ms 的定时器也按时触发了");
  clearTimeout(timer);
});

test("设备 Cookie：和会话 Cookie 同一套签名，180 天有效期，HttpOnly/SameSite=Lax、按 secure 带 Secure", () => {
  const manager = sessions();
  const token = manager.issueDevice();
  const payload = manager.verify(token);
  assert.ok(payload, "能验过");
  assert.ok(payload.exp > Date.now() + 170 * 24 * 3600 * 1000, "有效期约 180 天");
  const header = manager.deviceCookieHeader(token, false);
  assert.match(header, new RegExp(`^${DEVICE_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=\\d+$`));
  assert.doesNotMatch(header, /; Secure/);
  assert.match(manager.deviceCookieHeader(token, true), /; Secure/);
  // 伪造的（没有合法签名）验不过
  assert.equal(manager.verify("forged.payload"), null);
  // 换了签名密钥（相当于重启进程、换了 session_secret）：旧设备 Cookie 也验不过了，和会话 Cookie 一样
  manager.secret = "a-different-secret";
  assert.equal(manager.verify(token), null);
});

test("全站登录失败上限：固定窗口内到了阈值就顶住，窗口过了自动恢复；不满阈值不受影响", () => {
  const manager = sessions();
  const t0 = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(manager.isSiteLimited(t0), false, "没有失败记录时不顶住");
  for (let i = 0; i < LOGIN_SITE_FAILURE_LIMIT - 1; i += 1) manager.recordSiteFailure(t0 + i);
  assert.equal(manager.isSiteLimited(t0 + LOGIN_SITE_FAILURE_LIMIT), false, "还差一次没到阈值");
  manager.recordSiteFailure(t0 + LOGIN_SITE_FAILURE_LIMIT);
  assert.equal(manager.isSiteLimited(t0 + LOGIN_SITE_FAILURE_LIMIT + 1), true, "到了阈值就顶住");
  assert.equal(manager.isSiteLimited(t0 + LOGIN_SITE_WINDOW_MS - 1), true, "窗口还没过");
  assert.equal(manager.isSiteLimited(t0 + LOGIN_SITE_WINDOW_MS + 1), false, "窗口过了自动恢复（固定窗口，不是精确的滑动窗口）");
  // 窗口过后再失败，是全新的一轮，不会一来就顶住
  manager.recordSiteFailure(t0 + LOGIN_SITE_WINDOW_MS + 2);
  assert.equal(manager.isSiteLimited(t0 + LOGIN_SITE_WINDOW_MS + 3), false);
});

test("recordFailure 顺手记一次全站失败（单来源的锁和全站的上限是同一次失败动作）", () => {
  const manager = sessions();
  const t0 = Date.parse("2026-10-25T00:00:00Z");
  for (let i = 0; i < LOGIN_SITE_FAILURE_LIMIT; i += 1) manager.recordFailure(`198.51.100.${i}`, t0 + i);
  assert.equal(manager.isSiteLimited(t0 + LOGIN_SITE_FAILURE_LIMIT + 1), true, "很多个来源各失败一次，合起来顶住全站上限");
});
