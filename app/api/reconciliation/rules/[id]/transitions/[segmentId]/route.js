import { withAuth, json } from "../../../../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../../../../server/reconciliation.js";

export const PUT = withAuth(async (request, rt, params) => {
  const body = await request.json().catch(() => ({}));
  const effectiveAt = Number(body?.effectiveAt);
  if (!Number.isFinite(effectiveAt)) return json({ error: "倍率变化的时间不对", code: "INVALID_TRANSITION_TIME" }, 400);
  try { return json(await (rt.reconciliation ||= createReconciliationModule(rt)).correctTransition(params.id, params.segmentId, effectiveAt)); }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
