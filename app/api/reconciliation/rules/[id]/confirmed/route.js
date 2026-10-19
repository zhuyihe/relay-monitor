import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt, params) => {
  const search = new URL(request.url).searchParams;
  const options = Object.fromEntries(["startMs", "endMs", "limit", "cursor"].filter((key) => search.has(key)).map((key) => [key, search.get(key)]));
  try { return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getConfirmedHistory(params.id, options)); }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
