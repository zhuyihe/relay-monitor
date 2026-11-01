// GET /api/users —— 用户运营页（概览、用户两个页签）要的数：后台采集存下来的余额快照和按小时用量算出来的，不读自营站点。
// 后台还没读到过数时 starting: true（页面写「数据补全中」）；没设置自营站点是 400 OWN_STATION_UNSET（页面走设置引导）。
import { withAuth, json } from "../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../lib/format.js";
import { userOpsOf } from "../../../server/user-ops.js";
import { usersPage } from "../../../server/user-ops-page.js";

export const GET = withAuth(async (request, rt) => {
  const { ops, store } = userOpsOf(rt);
  // 没有数据库（store 空）时后台一轮都没跑过，usersPage 在读库前就返回 starting
  const page = await usersPage(rt, ops, store);
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(page);
});
