import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../../../server/reconciliation.js";
import { startChannelOnboarding } from "../../../../../../server/channel-onboarding.js";

export const POST = withAuth(async (request, rt, params) => {
  let body;
  try { body = await request.json(); } catch { return json({ error: "页面已过期，请刷新后重新打开", code: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "页面已过期，请刷新后重新打开", code: "INVALID_REQUEST" }, 400);
  rt.reconciliation ||= createReconciliationModule(rt);
  const module = rt.onboardingSource || await startChannelOnboarding(rt);
  try { return json(await module.probeRuleEdit(params.id, body)); }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
