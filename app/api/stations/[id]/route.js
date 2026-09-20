// PUT /api/stations/:id（编辑）+ DELETE /api/stations/:id（删除）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../../lib/api.js";
import { STATION_TYPES } from "../../../../lib/providers.js";
import { redact } from "../../../../server/stations.js";
import { refreshStation } from "../../../../server/refresh.js";
import { purgeStation } from "./purge.js";

export const PUT = withAuth(async (request, rt, params) => {
  const b = (await request.json().catch(() => null)) || {};
  if ("type" in b && !STATION_TYPES.some((t) => t.value === b.type))
    return json({ error: "无效的中转站类型" }, 400);
  let s;
  if (b.archived === false) {
    await rt.store.restore(params.id);
    const { archived, ...patch } = b;
    s = Object.keys(patch).length ? await rt.store.update(params.id, patch) : rt.store.get(params.id);
  } else {
    s = await rt.store.update(params.id, b);
  }
  if (!s) return json({ error: "未找到该中转站" }, 404);
  rt._ownCache?.clear();
  delete rt._ownChannelsCache;
  delete rt._ownUsersCache;
  refreshStation(rt, s).catch(() => {});
  return json({ station: redact(rt, s) });
});

export const DELETE = withAuth(async (request, rt, params) => {
  const search = new URL(request.url).searchParams;
  const purge = search.get("purge") === "true";
  const body = await request.json().catch(() => ({}));
  if (purge && body?.confirm !== "DELETE")
    return json({ error: "彻底删除资源及历史需要确认" }, 400);

  if (purge) {
    const result = await purgeStation(rt, params.id);
    if (result.ok) {
      rt._ownCache?.clear();
      delete rt._ownChannelsCache;
      delete rt._ownUsersCache;
    }
    return json({ ok: result.ok, purged: result.ok, alreadyPurged: result.alreadyPurged });
  }

  const station = await rt.store.archive(params.id);
  const ok = !!station;
  rt._ownCache?.clear();
  delete rt._ownChannelsCache;
  delete rt._ownUsersCache;
  return json({ ok, archived: ok, station: station ? redact(rt, station) : null });
});
