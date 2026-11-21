// POST /api/refresh —— 手动全量刷新所有站点，返回脱敏后的站点列表
import { withAuth, json } from "../../../lib/api.js";
import { refreshAll } from "../../../server/refresh.js";
import { redact } from "../../../server/stations.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const scope = body?.scope ?? "all";
  if (!["all", "upstreams"].includes(scope)) return json({ error: "刷新范围无效" }, 400);
  await refreshAll(rt, { scope });
  return json({
    stations: rt.store.list().filter((s) => scope !== "upstreams" || !s.isOwn).map((s) => redact(rt, s)),
    refreshedAt: new Date().toISOString(),
  });
});
