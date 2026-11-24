// POST /api/reconciliation/profit —— 每日利润页 A（设计稿 #118 §9）整页一次读：body 同 /api/reconciliation/query（preset、startMs、endMs）。
// 首屏只读缓存；refreshToday 只重读所选范围里的今天，共用一分钟缓存。forceToday 用于顶部手动刷新；历史账本不在这里重结。
import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).profitPage({ preset: body?.preset, startMs: body?.startMs, endMs: body?.endMs }, {
      cacheOnly: true, refreshToday: body?.refreshToday === true, forceToday: body?.forceToday === true,
    }));
  } catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
