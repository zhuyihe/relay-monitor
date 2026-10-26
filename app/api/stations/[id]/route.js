// PUT /api/stations/:id（编辑）+ DELETE /api/stations/:id（删除）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../../lib/api.js";
import { STATION_TYPES } from "../../../../lib/providers.js";
import { errorText } from "../../../../lib/error-copy.js";
import { redact } from "../../../../server/stations.js";
import { refreshStation } from "../../../../server/refresh.js";
import { purgeStation } from "./purge.js";
import { forgetOwnLog } from "../../../../server/own-log-store.js";

async function updateStation(request, rt, params) {
  const b = (await request.json().catch(() => null)) || {};
  const options = { expectedAuthVersion: b.expectedAuthVersion, expectedResourceVersion: b.expectedResourceVersion };
  if ("type" in b && !STATION_TYPES.some((t) => t.value === b.type))
    return json({ error: "请选上游类型", code: "UNSUPPORTED_UPSTREAM_TYPE" }, 400);
  const before = rt.store.get(params.id);
  let s;
  try {
    s = await rt.store.update(params.id, b, options);
  } catch (error) {
    if (["AUTHORIZATION_CHANGED", "RESOURCE_CHANGED"].includes(error.code)) return json({ error: error.message, code: error.code }, 400);
    // 换了地址却没重新填密钥（db/store.js updateLocked）
    if (error.code === "ENDPOINT_CHANGED_SECRET_REQUIRED") return json({ error: errorText(error), code: error.code }, 400);
    throw error;
  }
  if (!s) return json({ error: "找不到这个上游", code: "UPSTREAM_NOT_FOUND" }, 404);
  // 自营站点换了地址：整站日志的进度和桶是旧站的，清掉从头读（应付成本 V1）
  if (before?.isOwn && s.isOwn && before.baseUrl !== s.baseUrl) await forgetOwnLog(rt, s.id);
  rt._ownCache?.clear();
  delete rt._ownChannelsCache;
  delete rt._ownUsersCache;
  refreshStation(rt, s).catch(() => {});
  return json({ station: redact(rt, s) });
}

export const PUT = withAuth(updateStation);

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
