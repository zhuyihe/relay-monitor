// PUT/DELETE /api/notifications/channels/:id —— 更新 / 删除通知方式
// 返回时密钥不回传（lib/notify.js publicChannel）；换了地址却没重新填密钥时 400 带 ENDPOINT_CHANGED_SECRET_REQUIRED；
// 已经删了时 404 带 NOTIFY_NOT_FOUND
import { withAuth, json } from "../../../../../lib/api.js";
import { errorText } from "../../../../../lib/error-copy.js";
import { publicChannel } from "../../../../../lib/notify.js";

export const PUT = withAuth(async (request, rt, params) => {
  const body = (await request.json().catch(() => null)) || {};
  let ch;
  try {
    ch = await rt.store.updateChannel(params.id, body);
  } catch (error) {
    if (error?.code === "ENDPOINT_CHANGED_SECRET_REQUIRED") return json({ error: errorText(error), code: error.code }, 400);
    throw error;
  }
  if (!ch) return json({ error: errorText({ code: "NOTIFY_NOT_FOUND" }), code: "NOTIFY_NOT_FOUND" }, 404);
  return json({ channel: publicChannel(ch) });
});

export const DELETE = withAuth(async (request, rt, params) => {
  return json({ ok: await rt.store.removeChannel(params.id) });
});
