// GET /api/users/:id —— 用户运营的抽屉：一个用户近 30 天每天的消费、今天每小时、余额变化和充值、近 7 天按模型分。
// 按模型分是点开才读的（/api/data/?username=），按用户名缓存 10 分钟，额度紧时 models 是 null、error 是 BUSY，页面写「稍后再看」。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { userOpsOf } from "../../../../server/user-ops.js";
import { userDetail } from "../../../../server/user-ops-page.js";

export const GET = withAuth(async (request, rt, { id }) => {
  const { ops, store } = userOpsOf(rt);
  const detail = await userDetail(rt, ops, store, id);
  if (detail.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  if (detail.notFound) return json({ error: "找不到这个用户", code: "USER_NOT_FOUND" }, 404);
  return json(detail);
});
