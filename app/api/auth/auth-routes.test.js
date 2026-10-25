// 登录、改密路由：失败时状态码不变，带上码和 lib/error-copy.js 里的那句（design/ui-copy-spec.md §8.2）
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { MIN_PASSWORD_LENGTH, errorText } from "../../../lib/error-copy.js";

// 只换掉鉴权、取 IP 和比对密码这几层，跑的是实际的处理函数；密码「right」算对。
// lib/auth.js 这个虚拟模块一旦被 import 过就会被 Node 的模块缓存按 URL 缓存住（后面的 hook 不会再生效），
// scryptOverloaded 要能在不同测试里切换，就不能把值烤进生成的源码字符串里，得每次调用时读一个全局变量
async function route(path) {
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true, source: [
      "export const withAuth = (handler) => handler; export const withRuntime = (handler) => handler;",
      "export const json = (value, status = 200) => Response.json(value, { status });",
      "export const clientIp = () => \"1.2.3.4\"; export const requestIsSecure = () => false;",
      "export const cookieToken = () => null;", // 够不够「已登录过的浏览器」由 sessions.verify() 的桩决定，这里不用真的解析 Cookie
    ].join("\n") };
    if (url.endsWith("/lib/auth.js")) return { format: "module", shortCircuit: true, source: [
      "export const verifyPassword = (password) => password === \"right\";",
      "export const DEVICE_COOKIE_NAME = \"rm_device\";",
      "export const scryptOverloaded = () => globalThis.__authTestOverloaded === true;",
    ].join("\n") };
    return nextLoad(url, context);
  } });
  try { return await import(path); } finally { hook.deregister(); }
}

const post = (path, body) => new Request(`https://local.test${path}`, { method: "POST", body: JSON.stringify(body) });
// reserveLoginAttempt 的桩和真实 SessionManager 同一套规则：先判断锁没锁、全站顶没顶（可豁免），再占位；
// 只有占住位的那次调用才「跑密码校验」，调用方登录成功时调 release() 退回——calls 只记 reserve/release，不记被拒绝的。
// sessionVersion 固定是 1；staleDevice 模拟改密码/改用户名以后旧设备 Cookie 版本对不上当前凭证的情况（安全审核 10-25 低-1）
const sessions = (locked = false, { siteLimited = false, trustedDevice = false, staleDevice = false } = {}) => {
  const calls = [];
  return {
    calls,
    verify: (token, { device = false } = {}) => {
      if (!device || !trustedDevice) return null;
      return { t: "device", v: staleDevice ? "old-version" : 1, exp: Infinity };
    },
    reserveLoginAttempt: (ip, { exemptSiteLimit = false } = {}) => {
      if (locked) return null;
      if (!exemptSiteLimit && siteLimited) return null;
      calls.push(["reserve", ip]);
      return () => calls.push(["release", ip]);
    },
    issue: () => "token", issueDevice: () => "device-token", sessionVersion: () => 1,
    cookieHeader: () => "sid=token", deviceCookieHeader: () => "dev=device-token", clearCookieHeader: () => "sid=",
  };
};
const store = (extra = {}) => ({ auth: { username: "admin", salt: "s", hash: "h", isDefault: false }, ...extra });

test("登录：用户名或密码不对时 401 带 LOGIN_FAILED，试太多次时 429 带 LOGIN_RATE_LIMITED", async () => {
  const { POST } = await route("./login/route.js");
  const rt = { store: store(), sessions: sessions() };
  const wrong = await POST(post("/api/auth/login", { username: "admin", password: "nope" }), rt);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: errorText({ code: "LOGIN_FAILED" }), code: "LOGIN_FAILED" });
  // 占了位但密码不对，没有 release：这次尝试就是最终的失败记录，不用再记一次
  assert.deepEqual(rt.sessions.calls, [["reserve", "1.2.3.4"]]);

  // 锁定时连密码都不比对，占位都不会发生
  const lockedRt = { store: store(), sessions: sessions(true) };
  const locked = await POST(post("/api/auth/login", { username: "admin", password: "right" }), lockedRt);
  assert.equal(locked.status, 429);
  assert.deepEqual(await locked.json(), { error: errorText({ code: "LOGIN_RATE_LIMITED" }), code: "LOGIN_RATE_LIMITED" });
  assert.deepEqual(lockedRt.sessions.calls, []);

  const okRt = { store: store(), sessions: sessions() };
  const ok = await POST(post("/api/auth/login", { username: "admin", password: "right" }), okRt);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, username: "admin", isDefaultPassword: false });
  assert.deepEqual(okRt.sessions.calls, [["reserve", "1.2.3.4"], ["release", "1.2.3.4"]]);
  assert.equal(errorText({ code: "LOGIN_FAILED" }), "用户名或密码不对");
  assert.equal(errorText({ code: "LOGIN_RATE_LIMITED" }), "试了太多次，请 5 分钟后再试");
});

test("登录：scrypt 排满时 429 带 LOGIN_RATE_LIMITED，连判断锁、占位都不做——不占用这次名额（安全审核 10-25 中-1）", async () => {
  const { POST } = await route("./login/route.js");
  globalThis.__authTestOverloaded = true;
  try {
    const rt = { store: store(), sessions: sessions() };
    const res = await POST(post("/api/auth/login", { username: "admin", password: "right" }), rt);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: errorText({ code: "LOGIN_RATE_LIMITED" }), code: "LOGIN_RATE_LIMITED" });
    assert.deepEqual(rt.sessions.calls, [], "没有占位，不计入任何失败次数");
  } finally {
    globalThis.__authTestOverloaded = false;
  }
});

test("登录：全站上限顶住时也是 429 带 LOGIN_RATE_LIMITED，不跑密码校验；已经登录过的浏览器（设备 Cookie）不受这条约束，单来源的锁仍然约束它", async () => {
  const { POST } = await route("./login/route.js");

  // 全站顶住、没有设备 Cookie：连密码都不比对，不占位（和单来源锁一样不占这次失败）
  const limitedRt = { store: store(), sessions: sessions(false, { siteLimited: true }) };
  const limited = await POST(post("/api/auth/login", { username: "admin", password: "right" }), limitedRt);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: errorText({ code: "LOGIN_RATE_LIMITED" }), code: "LOGIN_RATE_LIMITED" });
  assert.deepEqual(limitedRt.sessions.calls, []);

  // 全站顶住、带着设备 Cookie：豁免这一步，密码校验、占位/退回都照常
  const trustedRt = { store: store(), sessions: sessions(false, { siteLimited: true, trustedDevice: true }) };
  const trusted = await POST(post("/api/auth/login", { username: "admin", password: "right" }), trustedRt);
  assert.equal(trusted.status, 200);
  assert.deepEqual(trustedRt.sessions.calls, [["reserve", "1.2.3.4"], ["release", "1.2.3.4"]]);

  const trustedWrongRt = { store: store(), sessions: sessions(false, { siteLimited: true, trustedDevice: true }) };
  const trustedWrong = await POST(post("/api/auth/login", { username: "admin", password: "nope" }), trustedWrongRt);
  assert.equal(trustedWrong.status, 401);
  assert.deepEqual(trustedWrongRt.sessions.calls, [["reserve", "1.2.3.4"]]);

  // 带着设备 Cookie 但单来源已经锁住：设备 Cookie 只豁免全站上限，豁免不了单来源的锁
  const trustedLockedRt = { store: store(), sessions: sessions(true, { siteLimited: true, trustedDevice: true }) };
  const trustedLocked = await POST(post("/api/auth/login", { username: "admin", password: "right" }), trustedLockedRt);
  assert.equal(trustedLocked.status, 429);
  assert.deepEqual(trustedLockedRt.sessions.calls, []);
});

test("登录：设备 Cookie 的版本和当前凭证对不上（改过密码或用户名）时不再豁免全站上限（安全审核 10-25 低-1）", async () => {
  const { POST } = await route("./login/route.js");
  const staleRt = { store: store(), sessions: sessions(false, { siteLimited: true, trustedDevice: true, staleDevice: true }) };
  const res = await POST(post("/api/auth/login", { username: "admin", password: "right" }), staleRt);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: errorText({ code: "LOGIN_RATE_LIMITED" }), code: "LOGIN_RATE_LIMITED" });
  assert.deepEqual(staleRt.sessions.calls, [], "版本对不上，当作没有设备 Cookie 处理");
});

test("登录成功：会话 Cookie 和设备 Cookie 各发一条，不是合并成一条", async () => {
  const { POST } = await route("./login/route.js");
  const rt = { store: store(), sessions: sessions() };
  const res = await POST(post("/api/auth/login", { username: "admin", password: "right" }), rt);
  assert.deepEqual(res.headers.getSetCookie(), ["sid=token", "dev=device-token"]);
});

test("退出登录：只清会话 Cookie，不碰设备 Cookie——这台浏览器退出以后还能豁免全站登录上限", async () => {
  const { POST } = await route("./logout/route.js");
  const rt = { sessions: sessions() };
  const res = await POST(null, rt);
  assert.deepEqual(res.headers.getSetCookie(), ["sid="]);
});

test("改密码：原密码不对带 WRONG_PASSWORD，新密码太短带 PASSWORD_TOO_SHORT，都是 400，不改密码；边界按常量 MIN_PASSWORD_LENGTH 算，少一位拒绝、正好够位数能过", async () => {
  const { POST } = await route("./password/route.js");
  const changes = [];
  const rt = { store: store({ setPassword: async (...args) => changes.push(args) }), sessions: sessions() };
  const enough = "x".repeat(MIN_PASSWORD_LENGTH);
  const wrong = await POST(post("/api/auth/password", { oldPassword: "nope", newPassword: enough }), rt);
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: errorText({ code: "WRONG_PASSWORD" }), code: "WRONG_PASSWORD" });
  // 少一位：拒绝
  const short = await POST(post("/api/auth/password", { oldPassword: "right", newPassword: enough.slice(1) }), rt);
  assert.equal(short.status, 400);
  assert.deepEqual(await short.json(), { error: errorText({ code: "PASSWORD_TOO_SHORT" }), code: "PASSWORD_TOO_SHORT" });
  assert.deepEqual(changes, []);

  // 正好够位数：能过
  const ok = await POST(post("/api/auth/password", { oldPassword: "right", newPassword: enough, username: " boss " }), rt);
  assert.equal(ok.status, 200);
  assert.deepEqual(changes, [["boss", enough]]);
  assert.equal(errorText({ code: "WRONG_PASSWORD" }), "原密码不对");
  assert.equal(errorText({ code: "PASSWORD_TOO_SHORT" }), `新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
});

test("改密码成功：响应里连同清会话 Cookie 一起，给当前浏览器发一张按新凭证签的设备 Cookie（安全审核 10-25 低-1）", async () => {
  const { POST } = await route("./password/route.js");
  const rt = { store: store({ setPassword: async () => {} }), sessions: sessions() };
  const res = await POST(post("/api/auth/password", { oldPassword: "right", newPassword: "x".repeat(MIN_PASSWORD_LENGTH) }), rt);
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), ["sid=", "dev=device-token"]);
});
