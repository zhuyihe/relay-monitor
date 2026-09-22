import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (_request, rt, params) => {
  const segments = await (rt.reconciliation ||= createReconciliationModule(rt)).listSegments(params.id);
  return json({ segments });
});
