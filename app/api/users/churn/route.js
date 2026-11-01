// GET /api/users/churn —— 用户运营「流失」页签：四个数（在下滑、本周新流失、月留存、回流）和主表（谁在少花钱、一天少收多少）。
// 用户的消费、状态来自用户页那一份（后台采集存下来的）；今天和过去 7 天同一时段读库里的按小时用量；每位用户主要用的模型要读自营站点的
// /api/data/flow 一个请求，打开页签才读、缓存 10 分钟，额度紧或读不到时那一列写「—」（modelsError 说原因），别的照常。
// 参数：only=todayLow|down|churned|returned、big=1、q=搜索、page=。后台还没读到过数时 starting: true；没设置自营站点是 400 OWN_STATION_UNSET。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { userOpsOf } from "../../../../server/user-ops.js";
import { churnResponse } from "../../../../server/user-ops-churn.js";

export const GET = withAuth(async (request, rt) => {
  const { ops, store } = userOpsOf(rt);
  // 和用户页同一个「有人在看」：页面来取数续 90 秒，后台每 5 分钟读一次用户列表和最近的用量
  ops.markViewing();
  ops.runOnce().catch(() => {});
  const page = await churnResponse(rt, ops, store, new URL(request.url).searchParams);
  if (page.unset) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(page);
});
