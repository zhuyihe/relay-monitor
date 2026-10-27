// GET /api/reconciliation/profit/detail?ruleIds=a,b&day=2026-10-25 —— 一行（同一把 Key 的几条绑定）一天的计算明细（设计稿 #118 §9.3）。
// 已固定的日子从账本行读；没固定的（今天）现算一次、不写库。
import { withAuth, json } from "../../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt) => {
  const search = new URL(request.url).searchParams;
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).profitDetail({ ruleIds: String(search.get("ruleIds") || "").split(",").filter(Boolean), day: search.get("day") }));
  } catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
