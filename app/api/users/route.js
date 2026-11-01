// GET /api/users —— 用户运营页（概览、用户两个页签）要的数：后台采集存下来的余额快照和按小时用量算出来的，不读自营站点。
// 用户表在服务端筛选、排序、分页（每页 50 个，参数见 usersResponse）；概览的数不随筛选变。
// 后台还没读到过数时 starting: true（页面写「数据补全中」）；没设置自营站点是 400 OWN_STATION_UNSET（页面走设置引导）。
import { withAuth, json } from "../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../lib/format.js";
import { userOpsOf } from "../../../server/user-ops.js";
import { usersPage, usersResponse } from "../../../server/user-ops-page.js";

export const GET = withAuth(async (request, rt) => {
  const { ops, store } = userOpsOf(rt);
  // 页面来取数 = 有人在看：续 90 秒，后台每 5 分钟读一次用户列表和最近的用量（不等它读完，页面拿现有的；读完下一次来取就是新的）
  ops.markViewing();
  ops.runOnce().catch(() => {});
  // 没有数据库（store 空）时后台一轮都没跑过，usersPage 在读库前就返回 starting
  const page = await usersPage(rt, ops, store);
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(usersResponse(page, new URL(request.url).searchParams));
});
