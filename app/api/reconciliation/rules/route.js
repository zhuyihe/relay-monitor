import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  try {
    const previewGuard = body.previewId && body.groupId ? rt.onboardingSource?.getPreviewGuard(body.previewId, body.groupId) : null;
    const rule = await (rt.reconciliation ||= createReconciliationModule(rt)).createRule(body, { previewGuard });
    return json({ rule }, 201);
  } catch (error) {
    if (!["PREVIEW_REQUIRED", "PREVIEW_BASIS_CHANGED", "EFFECTIVE_PREVIEW_CHANGED"].includes(error.code)) throw error;
    return json({ error: error.message, code: error.code, ...(error.nextPreview ? { nextPreview: error.nextPreview } : {}) }, 409);
  }
});
