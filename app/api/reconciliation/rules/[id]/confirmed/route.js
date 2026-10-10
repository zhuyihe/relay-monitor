import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt, params) => {
  const search = new URL(request.url).searchParams;
  const options = Object.fromEntries(["startMs", "endMs", "limit", "cursor"].filter((key) => search.has(key)).map((key) => [key, search.get(key)]));
  try { return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getConfirmedHistory(params.id, options)); }
  catch (error) {
    if (!["INVALID_REQUEST", "RULE_NOT_FOUND", "HISTORY_UNAVAILABLE"].includes(error.code)) throw error;
    return json({ error: error.message, code: error.code, ...(error.code === "HISTORY_UNAVAILABLE" ? { retryable: true } : {}) },
      error.code === "INVALID_REQUEST" ? 400 : error.code === "RULE_NOT_FOUND" ? 404 : 503);
  }
});
