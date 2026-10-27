// POST /api/reconciliation/profit —— 每日利润页 A（设计稿 #118 §9）整页一次读：body 同 /api/reconciliation/query（preset、startMs、endMs）。
// 只读：evaluate 不写库；「刷新」和单行「重新读取」照旧走 /query 带 observe。
import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).profitPage({ preset: body?.preset, startMs: body?.startMs, endMs: body?.endMs }));
  } catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
