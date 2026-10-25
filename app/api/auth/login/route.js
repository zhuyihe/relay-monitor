// POST /api/auth/login —— 登录（无需会话），行为与 v1 基本一致：
// 按来源限流，全站失败太多时也会顶住（防分布式乱试，已登录过的浏览器不受这条约束），验证用户名+密码，成功后签发会话 Cookie。
// 失败时带码（LOGIN_RATE_LIMITED、LOGIN_FAILED），说法取 lib/error-copy.js，登录页按码处理，状态码不变
import { withRuntime, json, clientIp, cookieToken, requestIsSecure } from "../../../../lib/api.js";
import { DEVICE_COOKIE_NAME, verifyPassword } from "../../../../lib/auth.js";
import { errorText } from "../../../../lib/error-copy.js";

const fail = (code, status) => json({ error: errorText({ code }), code }, status);

export const POST = withRuntime(async (request, rt) => {
  const ip = clientIp(request);
  if (rt.sessions.isLocked(ip)) {
    return fail("LOGIN_RATE_LIMITED", 429);
  }
  // 全站上限要在跑 scrypt 之前判断，不然攻击者还是在烧 CPU；已经登录成功过的这台浏览器不受它约束，但密码还是要对、单来源的锁照常算
  const trustedDevice = !!rt.sessions.verify(cookieToken(request, DEVICE_COOKIE_NAME));
  if (!trustedDevice && rt.sessions.isSiteLimited()) {
    return fail("LOGIN_RATE_LIMITED", 429);
  }
  const { username, password } = await request.json().catch(() => ({}));
  const auth = rt.store.auth;
  const userOk = String(username || "") === auth.username;
  const passOk = await verifyPassword(password || "", auth.salt, auth.hash);
  if (!userOk || !passOk) {
    rt.sessions.recordFailure(ip);
    return fail("LOGIN_FAILED", 401);
  }
  rt.sessions.recordSuccess(ip);
  const token = rt.sessions.issue(auth.username, rt.sessions.sessionVersion(auth));
  const res = json({ ok: true, username: auth.username, isDefaultPassword: !!auth.isDefault });
  const secure = requestIsSecure(request);
  res.headers.append("Set-Cookie", rt.sessions.cookieHeader(token, secure));
  // 每次登录成功都刷新这台浏览器的豁免期；退出登录不清掉它（见 logout 路由），断网、关浏览器再回来也还在
  res.headers.append("Set-Cookie", rt.sessions.deviceCookieHeader(rt.sessions.issueDevice(), secure));
  return res;
});
