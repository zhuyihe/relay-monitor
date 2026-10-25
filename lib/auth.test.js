import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_COOKIE_NAME, LOGIN_FAILURE_LIMIT, LOGIN_SITE_FAILURE_LIMIT, LOGIN_SITE_WINDOW_MS, SCRYPT_CONCURRENCY, SCRYPT_QUEUE_LIMIT, hashPassword, isDefaultPasswordRouteAllowed, scryptOverloaded, SessionManager, shouldMarkCookieSecure, verifyPassword } from "./auth.js";

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
  const payload = manager.verify(token, { device: true });
  assert.ok(payload, "能验过");
  assert.ok(payload.exp > Date.now() + 170 * 24 * 3600 * 1000, "有效期约 180 天");
  const header = manager.deviceCookieHeader(token, false);
  assert.match(header, new RegExp(`^${DEVICE_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=\\d+$`));
  assert.doesNotMatch(header, /; Secure/);
  assert.match(manager.deviceCookieHeader(token, true), /; Secure/);
  // 伪造的（没有合法签名）验不过
  assert.equal(manager.verify("forged.payload", { device: true }), null);
  // 换了签名密钥（相当于重启进程、换了 session_secret）：旧设备 Cookie 也验不过了，和会话 Cookie 一样
  manager.secret = "a-different-secret";
  assert.equal(manager.verify(token, { device: true }), null);
});

test("会话 Cookie 和设备 Cookie 互相拒绝对方：真实签发、真实验证，不是桩（安全审核 10-25 低-2）", () => {
  const manager = sessions();
  const sessionToken = manager.issue("admin", "v1");
  const deviceToken = manager.issueDevice();
  // 会话位置不认设备 Cookie，设备位置不认会话 Cookie，即使签名都是真的
  assert.equal(manager.verify(deviceToken), null, "设备 Cookie 放进会话校验（默认 device:false）应该被拒绝");
  assert.equal(manager.verify(sessionToken, { device: true }), null, "会话 Cookie 放进设备校验应该被拒绝");
  // 各自在自己的位置上照常验过
  assert.ok(manager.verify(sessionToken));
  assert.ok(manager.verify(deviceToken, { device: true }));
  // 手改签名的一截（破坏签名而非仅凭 payload 猜测）：真实伪造的 token 也验不过
  const forgedDevice = deviceToken.slice(0, -1) + (deviceToken.endsWith("A") ? "B" : "A");
  assert.equal(manager.verify(forgedDevice, { device: true }), null);
});

test("reserveLoginAttempt：判断和占位在一次同步调用里做完，并发涌入时 scrypt 实际只会被调用到上限次数（安全审核 10-25 高-1）", async () => {
  const manager = sessions();
  const ip = "203.0.113.9";
  let scryptCalls = 0;
  // 模拟路由的形状：reserveLoginAttempt 在任何 await 之前同步做完判断和占位，之后才「跑 scrypt」（这里用延时代替）
  async function attempt() {
    const release = manager.reserveLoginAttempt(ip);
    if (!release) return "rejected";
    scryptCalls += 1;
    await new Promise((resolve) => setImmediate(resolve)); // 模拟 verifyPassword 的 await，密码总是错的
    return "checked";
  }
  const results = await Promise.all(Array.from({ length: 500 }, attempt));
  const checked = results.filter((r) => r === "checked").length;
  assert.equal(checked, LOGIN_FAILURE_LIMIT, "500 个「并发」请求，实际跑 scrypt 的次数卡在单来源上限，不会全部放过去");
  assert.equal(scryptCalls, LOGIN_FAILURE_LIMIT);
  assert.equal(manager.isLocked(ip), true, "占满以后这个来源已经被锁住");
});

test("reserveLoginAttempt：单来源的锁谁都不能豁免，即使带着 exemptSiteLimit（已登录过的设备 Cookie）", () => {
  const manager = sessions();
  const ip = "203.0.113.10";
  const t0 = Date.parse("2026-10-25T00:00:00Z");
  for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) manager.recordFailure(ip, t0 + i);
  assert.equal(manager.isLocked(ip, t0 + LOGIN_FAILURE_LIMIT), true, "锁住了");
  // 全站上限可以豁免，单来源的锁不行
  assert.equal(manager.reserveLoginAttempt(ip, { exemptSiteLimit: true, now: t0 + LOGIN_FAILURE_LIMIT + 1 }), null);
  assert.equal(manager.reserveLoginAttempt(ip, { exemptSiteLimit: false, now: t0 + LOGIN_FAILURE_LIMIT + 1 }), null);
});

test("scrypt 并发上限：排满（在跑的 + 排队的都到上限）时 scryptOverloaded() 变 true，不会无限排队占满线程池（安全审核 10-25 中-1）", async () => {
  assert.equal(scryptOverloaded(), false, "没人在用时不该是排满状态");
  const inFlight = Array.from({ length: SCRYPT_CONCURRENCY + SCRYPT_QUEUE_LIMIT }, () => hashPassword("x"));
  // 多给排队的任务一点时间真正进入排队（promisify 的 scrypt 是下一个 tick 才开始跑）
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scryptOverloaded(), true, `${SCRYPT_CONCURRENCY} 个在跑 + ${SCRYPT_QUEUE_LIMIT} 个排队，已经到上限`);
  await Promise.all(inFlight);
  assert.equal(scryptOverloaded(), false, "都跑完了，不再是排满状态");
});

test("hashPassword / verifyPassword：固定向量（防止 scrypt 参数被不小心改动，旧密码校验不出来还浑然不知）", async () => {
  const password = "golden-vector-password";
  const salt = "golden-vector-salt";
  const hash = "4b00f290319640ec0e7b945c6dc0f0cc7807bee143942590d4c4ab203d96d6cc";
  assert.equal(await verifyPassword(password, salt, hash), true);
  assert.equal(await verifyPassword("golden-vector-password-x", salt, hash), false);
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
