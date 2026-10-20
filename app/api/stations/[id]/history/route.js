// GET /api/stations/:id/history?hours=（趋势图用历史数据）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../../../lib/api.js";

export const GET = withAuth(async (request, rt, params) => {
  const s = rt.store.get(params.id);
  if (!s) return json({ error: "找不到这个上游", code: "UPSTREAM_NOT_FOUND" }, 404);
  const searchParams = new URL(request.url).searchParams;
  const hours = Math.min(24 * 30, Math.max(1, Number(searchParams.get("hours")) || 72));
  return json({
    points: rt.history.points(s.id, hours),
    prediction: rt.history.predict(s.id),
  });
});
