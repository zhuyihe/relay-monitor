// GET /api/stations（列表）+ POST /api/stations（新增）——对应 v1 server.js 同名路由
import { withAuth, json } from "../../../lib/api.js";
import { businessTimeZone } from "../../../lib/business-time.js";
import { STATION_TYPES } from "../../../lib/providers.js";
import { redact } from "../../../server/stations.js";
import { refreshStation } from "../../../server/refresh.js";
import { cachedMergeCounts } from "../../../server/upstream-merge.js";

export const GET = withAuth(async (request, rt) => {
  const search = new URL(request.url).searchParams;
  const includeArchived = search.get("includeArchived") === "true";
  const includeUnmonitored = search.get("includeUnmonitored") === "true";
  return json({
    stations: rt.store.list({ includeArchived, includeUnmonitored }).map((s) => redact(rt, s)),
    settings: rt.store.settings,
    // 有几组上游是同一个账号、能不能合：上游列表顶上的提示用（读不到是 null）
    merge: await cachedMergeCounts(rt),
    // 业务时区：页面上的「数据截至」和固定成本的到期日按它写（design/ui-copy-spec.md §6）
    tz: businessTimeZone(),
    // 服务端此刻：上游列表拿它和每个上游的读取时刻比，判断「数据旧了」（ui-design-spec §5.2），不用浏览器的时钟
    generatedAt: new Date().toISOString(),
  });
});

export const POST = withAuth(async (request, rt) => {
  const b = (await request.json().catch(() => null)) || {};
  if (!b.type || !STATION_TYPES.some((t) => t.value === b.type))
    return json({ error: "请选上游类型", code: "UNSUPPORTED_UPSTREAM_TYPE" }, 400);
  if (!b.baseUrl && b.type !== "fixed") return json({ error: "请填写站点地址" }, 400);
  let s;
  try {
    s = await rt.store.add(b);
  } catch (error) {
    if (["SECRET_TOO_SHORT", "SECRET_TOO_WEAK"].includes(error.code)) return json({ error: error.message, code: error.code }, 400);
    throw error;
  }
  rt._ownCache?.clear();
  delete rt._ownChannelsCache;
  delete rt._ownUsersCache;
  refreshStation(rt, s).catch(() => {});
  return json({ station: redact(rt, s) });
});
