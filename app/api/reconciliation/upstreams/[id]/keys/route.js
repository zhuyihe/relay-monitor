import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt, params) => {
  const sp = new URL(request.url).searchParams;
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getUpstreamKeys(params.id,
      { force: sp.get("force") === "true", ...(sp.has("timezone") ? { timezone: sp.get("timezone") } : {}),
        ...(sp.has("tokenId") ? { tokenId: sp.get("tokenId") } : {}) }));
  }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
