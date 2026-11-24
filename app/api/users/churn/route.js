// GET 取流失名单的本地数据；POST 按需读取「主要用的模型」。
// 参数：only=todayLow|down|churned|returned、big=1、q=搜索、page=。后台还没读到过数时 starting: true；没设置自营站点是 400 OWN_STATION_UNSET。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { userOpsOf } from "../../../../server/user-ops.js";
import { churnResponse } from "../../../../server/user-ops-churn.js";

const respond = withAuth(async (request, rt) => {
  const { ops, store } = userOpsOf(rt);
  const readModels = request.method === "POST";
  if (readModels && rt.store.settings?.userOpsEnabled === false) return json({ code: "USER_DATA_DISABLED" }, 403);
  const page = await churnResponse(rt, ops, store, new URL(request.url).searchParams, { readModels });
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(page);
});
export const GET = respond;
export const POST = respond;
