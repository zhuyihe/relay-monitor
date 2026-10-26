import { withAuth, json } from "../../../../lib/api.js";
import { createReconciliationModule, reconciliationErrorResponse } from "../../../../server/reconciliation.js";

// 跳过缓存重新计算；只有页面「刷新」带 observe: true，才会观测并写库，也才重新读账号级上游用量。
export const POST = withAuth(async (request, rt) => {
  const body = await request.json().catch(() => ({}));
  try {
    return json(await (rt.reconciliation ||= createReconciliationModule(rt)).queryRules({
      ruleIds: Array.isArray(body?.ruleIds) ? body.ruleIds.map(String) : null,
      preset: body?.preset,
      startMs: body?.startMs,
      endMs: body?.endMs,
    }, { mode: body?.observe === true ? "observe" : "evaluate", force: true, origin: "manual",
      // 「这天重算的数比原来少了一半多」的确认框点了「重新读取」：这一次读到什么就固定什么（只对状态行是 RESETTLE_SHRUNK 的那天有用）
      confirmShrink: body?.confirmShrink === true,
      // 确认框里写的「重算」的收入、上游成本：再读到的数和它不一样就再挡一次
      confirmedAfter: body?.confirmedAfter && typeof body.confirmedAfter === "object" ? { revenueUsd: body.confirmedAfter.revenueUsd ?? null, costUsd: body.confirmedAfter.costUsd ?? null } : null,
      accountUsage: body?.observe === true ? "refresh" : true }));
  }
  catch (error) {
    const failure = reconciliationErrorResponse(error);
    if (!failure) throw error;
    return json(failure.body, failure.status);
  }
});
