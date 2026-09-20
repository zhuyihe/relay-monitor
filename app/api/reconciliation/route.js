import { withAuth, json } from "../../../lib/api.js";
import { createReconciliationModule } from "../../../server/reconciliation.js";

function moduleFor(rt) {
  return rt.reconciliation ||= createReconciliationModule(rt);
}

// 默认概览：今天窗口由各规则自己的时区解析，前端轮询不会强制绕过服务端缓存。
export const GET = withAuth(async (request, rt) => {
  const sp = new URL(request.url).searchParams;
  const ruleIds = String(sp.get("ruleIds") || "").split(",").map((id) => id.trim()).filter(Boolean);
  const preset = ["today", "yesterday", "7d", "custom"].includes(sp.get("preset")) ? sp.get("preset") : "today";
  const payload = await moduleFor(rt).queryRules({
    ruleIds: ruleIds.length ? ruleIds : null,
    preset,
    startMs: sp.get("startMs"),
    endMs: sp.get("endMs"),
  }, { force: sp.get("force") === "true", origin: "page" });
  return json(payload);
});
