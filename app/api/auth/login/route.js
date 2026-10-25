// POST /api/auth/login —— 登录（无需会话），行为与 v1 基本一致：
// 按来源限流，全站失败太多时也会顶住（防分布式乱试，已登录过的浏览器不受这条约束），验证用户名+密码，成功后签发会话 Cookie。
// 失败时带码（LOGIN_RATE_LIMITED、LOGIN_FAILED），说法取 lib/error-copy.js，登录页按码处理，状态码不变
import { withRuntime, json, clientIp, cookieToken, requestIsSecure } from "../../../../lib/api.js";
import { DEVICE_COOKIE_NAME, scryptOverloaded, verifyPassword } from "../../../../lib/auth.js";
import { errorText } from "../../../../lib/error-copy.js";

const fail = (code, status) => json({ error: errorText({ code }), code }, status);

export const POST = withRuntime(async (request, rt) => {
  const ip = clientIp(request);
  const auth = rt.store.auth;
  const version = rt.sessions.sessionVersion(auth);
  // 已经登录成功过的这台浏览器不受全站上限约束，但密码还是要对、单来源的锁照常算；设备 Cookie 的版本要对得上
  // 当前凭证（sessionVersion），改密码、改用户名以后旧的设备 Cookie 版本对不上，就不再豁免（安全审核 10-25 低-1）
  const devicePayload = rt.sessions.verify(cookieToken(request, DEVICE_COOKIE_NAME), { device: true });
  const trustedDevice = !!devicePayload && devicePayload.v === version;
  // scrypt 在跑的已经排满：系统在超负荷，不占用线程池再跑一个，这里不算一次登录失败
  if (scryptOverloaded()) return fail("LOGIN_RATE_LIMITED", 429);
  // 判断「锁没锁、顶没顶」和占一个名额必须在同一次同步调用里做完，不然并发请求会在占位之前就都通过判断（见 reserveLoginAttempt 注释）
  const release = rt.sessions.reserveLoginAttempt(ip, { exemptSiteLimit: trustedDevice });
  if (!release) return fail("LOGIN_RATE_LIMITED", 429);
  const { username, password } = await request.json().catch(() => ({}));
  const userOk = String(username || "") === auth.username;
  const passOk = await verifyPassword(password || "", auth.salt, auth.hash);
  if (!userOk || !passOk) {
    // 失败不用再记一次：占位（reserveLoginAttempt）已经是这次尝试最终的失败记录
    return fail("LOGIN_FAILED", 401);
  }
  release(); // 登录成功，退回占位，不计入失败次数
  const token = rt.sessions.issue(auth.username, version);
  const res = json({ ok: true, username: auth.username, isDefaultPassword: !!auth.isDefault });
  const secure = requestIsSecure(request);
  res.headers.append("Set-Cookie", rt.sessions.cookieHeader(token, secure));
  // 每次登录成功都刷新这台浏览器的豁免期，带上当前凭证版本；退出登录不清掉它（见 logout 路由），断网、关浏览器再回来也还在
  res.headers.append("Set-Cookie", rt.sessions.deviceCookieHeader(rt.sessions.issueDevice(version), secure));
  return res;
});
