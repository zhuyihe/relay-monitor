// POST /api/auth/password —— 修改用户名/密码：先校验原密码，新密码至少 6 位
import { withAuth, json, requestIsSecure } from "../../../../lib/api.js";
import { verifyPassword } from "../../../../lib/auth.js";

export const POST = withAuth(async (request, rt) => {
  const { oldPassword, newPassword, username } = await request.json().catch(() => ({}));
  if (!verifyPassword(oldPassword || "", rt.store.auth.salt, rt.store.auth.hash)) {
    return json({ error: "原密码错误" }, 400);
  }
  if (!newPassword || String(newPassword).length < 6) {
    return json({ error: "新密码至少 6 位" }, 400);
  }
  await rt.store.setPassword(username ? String(username).trim() : undefined, String(newPassword));
  // 会话版本绑定凭证哈希；改密后旧 Cookie 均不再可用。
  const res = json({ ok: true, reauthenticate: true });
  res.headers.set("Set-Cookie", rt.sessions.clearCookieHeader(requestIsSecure(request)));
  return res;
});
