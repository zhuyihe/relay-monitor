import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule } from "../../../../server/reconciliation.js";

// 跳过缓存重新计算；只有页面「刷新」带 observe: true，才会观测并写库。
export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  const payload = await (rt.reconciliation ||= createReconciliationModule(rt)).queryRules({
    ruleIds: Array.isArray(body?.ruleIds) ? body.ruleIds.map(String) : null,
    preset: body?.preset,
    startMs: body?.startMs,
    endMs: body?.endMs,
  }, { mode: body?.observe === true ? "observe" : "evaluate", force: true, origin: "manual" });
  return json(payload);
});
