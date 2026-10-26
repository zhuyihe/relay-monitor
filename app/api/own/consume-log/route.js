// ---- 自营站点记不记收费记录（own-revenue-plan 第二节）-------------------------------
// GET 给最近一次读到的结果（不发请求）和关着的时间段；POST 是「重新检查」：马上再读一次站点设置再返回。
// 只返回状态和时间段：设置里别的东西读完就扔，不进返回值。
import { withAuth, json } from "../../../../lib/api.js";
import { OWN_STATION_UNSET } from "../../../../lib/format.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

const ownStation = (rt) => rt.store.list().find((s) => s.isOwn && s.type === "newapi") || null;
const view = (own, status) => ({ stationId: own.id, status, offPeriods: own.consumeLogOffPeriods || [] });

export const GET = withAuth(async (request, rt) => {
  const own = ownStation(rt);
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  return json(view(own, (rt.reconciliation ||= createReconciliationModule(rt)).consumeLogStatus(own.id)));
});

export const POST = withAuth(async (request, rt) => {
  const own = ownStation(rt);
  if (!own) return json({ error: OWN_STATION_UNSET, code: "OWN_STATION_UNSET" }, 400);
  const status = await (rt.reconciliation ||= createReconciliationModule(rt)).recheckConsumeLog(own);
  return json(view(rt.store.get(own.id) || own, status));
});
