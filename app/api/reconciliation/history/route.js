// 只登记所选范围缺失的历史账，页面读取仍走只读接口。
import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).requestHistory({
      preset: body?.preset, startMs: body?.startMs, endMs: body?.endMs,
    }));
  } catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
