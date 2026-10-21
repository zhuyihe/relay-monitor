// 登录、改密路由：失败时状态码不变，带上码和 lib/error-copy.js 里的那句（design/ui-copy-spec.md §8.2）
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { errorText } from "../../../lib/error-copy.js";

// 只换掉鉴权、取 IP 和比对密码这几层，跑的是实际的处理函数；密码「right」算对
async function route(path) {
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true, source: [
      "export const withAuth = (handler) => handler; export const withRuntime = (handler) => handler;",
      "export const json = (value, status = 200) => Response.json(value, { status });",
      "export const clientIp = () => \"1.2.3.4\"; export const requestIsSecure = () => false;",
    ].join("\n") };
    if (url.endsWith("/lib/auth.js")) return { format: "module", shortCircuit: true,
      source: "export const verifyPassword = (password) => password === \"right\";" };
    return nextLoad(url, context);
  } });
  try { return await import(path); } finally { hook.deregister(); }
}

const post = (path, body) => new Request(`https://local.test${path}`, { method: "POST", body: JSON.stringify(body) });
const sessions = (locked = false) => {
  const calls = [];
  return { calls, isLocked: () => locked, recordFailure: (ip) => calls.push(["failure", ip]), recordSuccess: (ip) => calls.push(["success", ip]),
    issue: () => "token", sessionVersion: () => 1, cookieHeader: () => "sid=token", clearCookieHeader: () => "sid=" };
};
const store = (extra = {}) => ({ auth: { username: "admin", salt: "s", hash: "h", isDefault: false }, ...extra });

test("登录：用户名或密码不对时 401 带 LOGIN_FAILED，试太多次时 429 带 LOGIN_RATE_LIMITED", async () => {
  const { POST } = await route("./login/route.js");
  const rt = { store: store(), sessions: sessions() };
  const wrong = await POST(post("/api/auth/login", { username: "admin", password: "nope" }), rt);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: errorText({ code: "LOGIN_FAILED" }), code: "LOGIN_FAILED" });
  assert.deepEqual(rt.sessions.calls, [["failure", "1.2.3.4"]]);

  const locked = await POST(post("/api/auth/login", { username: "admin", password: "right" }), { store: store(), sessions: sessions(true) });
  assert.equal(locked.status, 429);
  assert.deepEqual(await locked.json(), { error: errorText({ code: "LOGIN_RATE_LIMITED" }), code: "LOGIN_RATE_LIMITED" });

  const ok = await POST(post("/api/auth/login", { username: "admin", password: "right" }), { store: store(), sessions: sessions() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, username: "admin", isDefaultPassword: false });
  assert.equal(errorText({ code: "LOGIN_FAILED" }), "用户名或密码不对");
  assert.equal(errorText({ code: "LOGIN_RATE_LIMITED" }), "试了太多次，请 5 分钟后再试");
});

test("改密码：原密码不对带 WRONG_PASSWORD，新密码太短带 PASSWORD_TOO_SHORT，都是 400，不改密码", async () => {
  const { POST } = await route("./password/route.js");
  const changes = [];
  const rt = { store: store({ setPassword: async (...args) => changes.push(args) }), sessions: sessions() };
  const wrong = await POST(post("/api/auth/password", { oldPassword: "nope", newPassword: "long-enough" }), rt);
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: errorText({ code: "WRONG_PASSWORD" }), code: "WRONG_PASSWORD" });
  const short = await POST(post("/api/auth/password", { oldPassword: "right", newPassword: "12345" }), rt);
  assert.equal(short.status, 400);
  assert.deepEqual(await short.json(), { error: errorText({ code: "PASSWORD_TOO_SHORT" }), code: "PASSWORD_TOO_SHORT" });
  assert.deepEqual(changes, []);

  const ok = await POST(post("/api/auth/password", { oldPassword: "right", newPassword: "123456", username: " boss " }), rt);
  assert.equal(ok.status, 200);
  assert.deepEqual(changes, [["boss", "123456"]]);
  assert.equal(errorText({ code: "WRONG_PASSWORD" }), "原密码不对");
  assert.equal(errorText({ code: "PASSWORD_TOO_SHORT" }), "新密码至少 6 位");
});
