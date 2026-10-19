import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  try {
    const previewGuard = body.previewId && body.groupId ? rt.onboardingSource?.getPreviewGuard(body.previewId, body.groupId) : null;
    const rule = await (rt.reconciliation ||= createReconciliationModule(rt)).createRule(body, { previewGuard });
    return json({ rule }, 201);
  }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
