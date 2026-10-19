import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt) => {
  const search = new URL(request.url).searchParams;
  const forceChannels = search.get("refreshChannels") === "true";
  const includeArchived = search.get("includeArchived") === "true";
  try { return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getConfiguration({ forceChannels, includeArchived })); }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
