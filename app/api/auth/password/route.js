// POST /api/auth/password —— 修改用户名/密码：先校验原密码，新密码至少 MIN_PASSWORD_LENGTH 位。
// 失败时带码（WRONG_PASSWORD、PASSWORD_TOO_SHORT），说法取 lib/error-copy.js，系统设置按码把报错放到对应的输入框，状态码不变
import { withAuth, json, requestIsSecure } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";
import { MIN_PASSWORD_LENGTH, errorText } from "../../../../lib/error-copy.js";

const fail = (code) => json({ error: errorText({ code }), code }, 400);

export const POST = withAuth(async (request, rt) => {
  const { oldPassword, newPassword, username } = await request.json().catch(() => ({}));
  if (!(await verifyPassword(oldPassword || "", rt.store.auth.salt, rt.store.auth.hash))) {
    return fail("WRONG_PASSWORD");
  }
  if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
    return fail("PASSWORD_TOO_SHORT");
  }
  await rt.store.setPassword(username ? String(username).trim() : undefined, String(newPassword));
  // 会话版本绑定凭证哈希；改密后旧会话 Cookie 均不再可用，要重新登录。
  // 设备 Cookie 的版本也绑同一个凭证，这台浏览器刚验证过原密码，给它发一张按新凭证签的设备 Cookie：
  // 重新登录时这台浏览器还认得（不用再打一次全站上限），换一台没登录过的设备照样认不出旧的（安全审核 10-25 低-1）
  const secure = requestIsSecure(request);
  const res = json({ ok: true, reauthenticate: true });
  res.headers.append("Set-Cookie", rt.sessions.clearCookieHeader(secure));
  res.headers.append("Set-Cookie", rt.sessions.deviceCookieHeader(rt.sessions.issueDevice(rt.sessions.sessionVersion(rt.store.auth)), secure));
  return res;
});
