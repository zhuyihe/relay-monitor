import { withAuth, json } from "../../../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../../../server/reconciliation.js";

export const PUT = withAuth(async (request, rt, params) => {
  const body = await request.json().catch(() => ({}));
  const effectiveAt = Number(body?.effectiveAt);
  if (!Number.isFinite(effectiveAt)) throw new Error("切换时间无效");
  const segments = await (rt.reconciliation ||= createReconciliationModule(rt)).correctTransition(params.id, params.segmentId, effectiveAt);
  return json({ segments });
});
