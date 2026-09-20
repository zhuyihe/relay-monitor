import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const payload = await (rt.reconciliation ||= createReconciliationModule(rt)).queryRules({
    ruleIds: Array.isArray(body?.ruleIds) ? body.ruleIds.map(String) : null,
    preset: body?.preset,
    startMs: body?.startMs,
    endMs: body?.endMs,
  }, { force: true, origin: "manual" });
  return json(payload);
});
