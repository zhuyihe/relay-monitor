// POST /api/stations/detect —— 只给地址和令牌，认出上游类型和名字并试读一次；不写库、不触发告警。
import { withAuth, json } from "../../../../lib/api.js";
import { describeError } from "../../../../lib/error-copy.js";
import { detectUpstream } from "../../../../lib/detect-upstream.js";

export const POST = withAuth(async (request) => {
  const body = (await request.json().catch(() => null)) || {};
  if (!String(body.baseUrl || "").trim()) return json({ error: "请填写站点地址", code: "INVALID_REQUEST" }, 400);
  if (!String(body.token || "").trim()) return json({ error: "请填写令牌", code: "INVALID_REQUEST" }, 400);
  const found = await detectUpstream({ baseUrl: body.baseUrl, token: body.token, userId: body.userId });
  if (found.ok) {
    const { result } = found;
    return json({ ok: true, type: found.type, name: found.name, account: found.account, remaining: result.remaining, currency: result.currency || null, latencyMs: result.latencyMs });
  }
  if (found.needsUserId) return json({ ok: false, needsUserId: true, type: found.type });
  const { category, text, action } = describeError({ code: found.code, message: found.error });
  return json({ ok: false, type: found.type, code: found.code, category, message: text, action, diagnostic: found.error });
});
