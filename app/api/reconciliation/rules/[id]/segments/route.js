import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (_request, rt, params) => {
  try { return json({ segments: await (rt.reconciliation ||= createReconciliationModule(rt)).listSegments(params.id) }); }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
