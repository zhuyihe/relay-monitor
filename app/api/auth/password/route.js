// POST /api/auth/password —— 修改用户名/密码：先校验原密码，新密码至少 6 位。
// 失败时带码（WRONG_PASSWORD、PASSWORD_TOO_SHORT），说法取 lib/error-copy.js，系统设置按码把报错放到对应的输入框，状态码不变
import { withAuth, json, requestIsSecure } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";
import { errorText } from "../../../../lib/error-copy.js";

const fail = (code) => json({ error: errorText({ code }), code }, 400);

export const POST = withAuth(async (request, rt) => {
  const { oldPassword, newPassword, username } = await request.json().catch(() => ({}));
  if (!verifyPassword(oldPassword || "", rt.store.auth.salt, rt.store.auth.hash)) {
    return fail("WRONG_PASSWORD");
  }
  if (!newPassword || String(newPassword).length < 6) {
    return fail("PASSWORD_TOO_SHORT");
  }
  await rt.store.setPassword(username ? String(username).trim() : undefined, String(newPassword));
  // 会话版本绑定凭证哈希；改密后旧 Cookie 均不再可用。
  const res = json({ ok: true, reauthenticate: true });
  res.headers.set("Set-Cookie", rt.sessions.clearCookieHeader(requestIsSecure(request)));
  return res;
});
