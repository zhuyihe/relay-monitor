// GET /api/users/big —— 告警中心「用户」一组里「现在是 N 个重点用户：……」要的名单：后台算好的，不读库、不读自营站点。
// ready 是 false（近 7 天还没补到）时名单是空的，页面写「数据补全中」。没设置自营站点是 400 OWN_STATION_UNSET。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { userOpsOf } from "../../../../server/user-ops.js";
import { bigUsersSummary } from "../../../../server/user-ops-page.js";

export const GET = withAuth(async (request, rt) => {
  const { ops } = userOpsOf(rt);
  const summary = ops ? bigUsersSummary(rt, ops) : { ready: false, big: [] };
  if (summary.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(summary);
});
