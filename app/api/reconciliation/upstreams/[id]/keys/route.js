import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt, params) => {
  const sp = new URL(request.url).searchParams;
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getUpstreamKeys(params.id,
      { force: sp.get("force") === "true", ...(sp.has("timezone") ? { timezone: sp.get("timezone") } : {}),
        ...(sp.has("tokenId") ? { tokenId: sp.get("tokenId") } : {}) }));
  } catch (error) {
    if (!["INVALID_REQUEST", "RESOURCE_CHANGED", "KEY_METADATA_UNAVAILABLE", "KEY_PROBE_UNAVAILABLE"].includes(error.code)) throw error;
    const retryable = ["KEY_METADATA_UNAVAILABLE", "KEY_PROBE_UNAVAILABLE"].includes(error.code);
    return json({ error: error.message, code: error.code, ...(retryable ? { retryable: true } : {}) }, retryable ? 503 : 400);
  }
});
