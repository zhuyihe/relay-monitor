import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

export const GET = withAuth(async (request, rt) => {
  const forceChannels = new URL(request.url).searchParams.get("refreshChannels") === "true";
  return json(await (rt.reconciliation ||= createReconciliationModule(rt)).getConfiguration({ forceChannels }));
});
