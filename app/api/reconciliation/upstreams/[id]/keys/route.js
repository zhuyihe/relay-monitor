import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt, params) => {
  const sp = new URL(request.url).searchParams;
  return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getUpstreamKeys(
    params.id,
    { force: sp.get("force") === "true" }
  ));
});
