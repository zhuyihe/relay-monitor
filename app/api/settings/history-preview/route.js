// GET /api/settings/history-preview?days= —— 留存缩短前的不可逆删除预览。
import { withAuth, json } from "../../../../lib/api.js";

export const GET = withAuth(async (request, rt) => {
  const days = Number(new URL(request.url).searchParams.get("days"));
  if (!Number.isSafeInteger(days) || days <= 0)
    return json({ error: "历史留存天数必须是正整数" }, 400);
  return json({ preview: await rt.history.previewCleanup(days) });
});
