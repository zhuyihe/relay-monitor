import { withAuth, json } from "../../../../../../lib/api.js";
import { createReconciliationModule } from "../../../../../../server/reconciliation.js";
import { startChannelOnboarding } from "../../../../../../server/channel-onboarding.js";

export const POST = withAuth(async (request, rt, params) => {
  let body;
  try { body = await request.json(); } catch { return json({ error: "请求格式无效", code: "INVALID_REQUEST" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "请求格式无效", code: "INVALID_REQUEST" }, 400);
  rt.reconciliation ||= createReconciliationModule(rt);
  const module = rt.onboardingSource || await startChannelOnboarding(rt);
  try { return json(await module.probeRuleEdit(params.id, body)); }
  catch (error) {
    if (!["INVALID_REQUEST", "RULE_NOT_FOUND", "RULE_IDENTITY_IMMUTABLE", "PREVIEW_BASIS_CHANGED", "PREVIEW_REQUIRED", "EFFECTIVE_PREVIEW_CHANGED",
      "CHANNEL_CONFLICT", "CANONICAL_KEY_CONFLICT", "SOURCE_BINDING_UNCONFIRMED", "BILLING_CAPABILITY_UNVERIFIED", "COST_OWNER_UNVERIFIED"].includes(error.code)) throw error;
    return json({ error: error.message, code: error.code }, error.code === "RULE_NOT_FOUND" ? 404 : error.code === "INVALID_REQUEST" || error.code === "RULE_IDENTITY_IMMUTABLE" ? 400 : 409);
  }
});
