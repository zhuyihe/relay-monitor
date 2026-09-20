import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const rule = await (rt.reconciliation ||= createReconciliationModule(rt)).createRule(body);
  return json({ rule }, 201);
});
