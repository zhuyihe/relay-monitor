// POST /api/auth/login —— 登录（无需会话），行为与 v1 完全一致：
// 按 IP 限流，验证用户名+密码，成功后签发会话 Cookie。
// 失败时带码（LOGIN_RATE_LIMITED、LOGIN_FAILED），说法取 lib/error-copy.js，登录页按码处理，状态码不变
import { withRuntime, json, clientIp, requestIsSecure } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";
import { errorText } from "../../../../lib/error-copy.js";

const fail = (code, status) => json({ error: errorText({ code }), code }, status);

export const POST = withRuntime(async (request, rt) => {
  const ip = clientIp(request);
  if (rt.sessions.isLocked(ip)) {
    return fail("LOGIN_RATE_LIMITED", 429);
  }
  const { username, password } = await request.json().catch(() => ({}));
  const auth = rt.store.auth;
  const userOk = String(username || "") === auth.username;
  const passOk = verifyPassword(password || "", auth.salt, auth.hash);
  if (!userOk || !passOk) {
    rt.sessions.recordFailure(ip);
    return fail("LOGIN_FAILED", 401);
  }
  rt.sessions.recordSuccess(ip);
  const token = rt.sessions.issue(auth.username, rt.sessions.sessionVersion(auth));
  const res = json({ ok: true, username: auth.username, isDefaultPassword: !!auth.isDefault });
  res.headers.set("Set-Cookie", rt.sessions.cookieHeader(token, requestIsSecure(request)));
  return res;
});
