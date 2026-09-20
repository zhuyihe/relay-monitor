import { withAuth, json } from "../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../server/reconciliation.js";

export const PUT = withAuth(async (request, rt, params) => {
  const body = await request.json().catch(() => ({}));
  const rule = await (rt.reconciliation ||= createReconciliationModule(rt)).updateRule(params.id, body);
  return json({ rule });
});

export const DELETE = withAuth(async (_request, rt, params) => {
  await (rt.reconciliation ||= createReconciliationModule(rt)).archiveRule(params.id);
  return json({ ok: true });
});
