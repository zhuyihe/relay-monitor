// POST /api/notifications/channels —— 新增通知方式；类型认不出时 400 带 NOTIFY_TYPE_UNSUPPORTED
import { withAuth, json } from "../../../../lib/api.js";
import { errorText } from "../../../../lib/error-copy.js";
import { CHANNEL_TYPES, publicChannel } from "../../../../lib/notify.js";

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  if (!CHANNEL_TYPES.some((t) => t.value === b.type))
    return json({ error: errorText({ code: "NOTIFY_TYPE_UNSUPPORTED" }), code: "NOTIFY_TYPE_UNSUPPORTED" }, 400);
  const ch = await rt.store.addChannel(b);
  return json({ channel: publicChannel(ch) });
});
