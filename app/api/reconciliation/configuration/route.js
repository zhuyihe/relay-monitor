import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

export const GET = withAuth(async (_request, rt) => {
  return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getConfiguration());
});
