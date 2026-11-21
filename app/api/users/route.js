// GET /api/users —— 用户运营页（概览、用户两个页签）要的数：后台采集存下来的余额快照和按小时用量算出来的，不读自营站点。
// 用户表在服务端筛选、排序、分页（每页 50 个，参数见 usersResponse）；概览的数不随筛选变。
// GET 读取本地快照。POST 首次同步名单和余额。
import { withAuth, json } from "../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../lib/format.js";
import { userOpsOf } from "../../../server/user-ops.js";
import { localUsersPage, usersResponse } from "../../../server/user-ops-page.js";

export const GET = withAuth(async (request, rt) => {
  const { ops, store } = userOpsOf(rt);
  const page = await localUsersPage(rt, ops, store);
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(usersResponse(page, new URL(request.url).searchParams));
});

export const POST = withAuth(async (request, rt) => {
  const { ops, store } = userOpsOf(rt);
  let page = await localUsersPage(rt, ops, store);
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  if (page.paused) return json({ code: "USER_DATA_DISABLED" }, 403);
  if (page.starting) {
    const result = await ops.syncDirectory();
    if (result.code) return json({ code: result.code }, result.status);
    page = await localUsersPage(rt, ops, store);
  }
  return json(usersResponse(page, new URL(request.url).searchParams));
});
