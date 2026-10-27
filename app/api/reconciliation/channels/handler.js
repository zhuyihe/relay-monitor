import { createReconciliationModule } from "../../../../server/reconciliation.js";
import { startChannelOnboarding } from "../../../../server/channel-onboarding.js";
import { createChannelProfitModule } from "../../../../server/channel-profit.js";
import { connectionDiagnostic } from "../../../../lib/connection-test.js";

// 按渠道开始/停止算利润（K2c）。登录由路由那一层包好；这一层只管请求格式、错误码和模块的接线，方便单独测
// operation：status、overview（GET，?ownStationId=）/ start / stop / answer（POST）。overview 是「渠道」页签要的整份数据（上游 → 渠道 → 用过的 Key）
export async function handleChannelProfitRequest(request, rt, operation) {
  let body = {};
  const search = new URL(request.url).searchParams;
  if (operation !== "status" && operation !== "overview") {
    try { body = await request.json(); } catch { return Response.json({ error: "页面已过期，请刷新后重新打开", code: "INVALID_REQUEST" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "页面已过期，请刷新后重新打开", code: "INVALID_REQUEST" }, { status: 400 });
  }
  const ownStationId = String((operation === "status" || operation === "overview" ? search.get("ownStationId") : body.ownStationId) || "");
  if (!ownStationId) return Response.json({ error: "请先设置自营站点", code: "OWN_STATION_UNSET" }, { status: 400 });
  try {
    // 接入向导和对账模块没起来时先起（和别的接口一样按需起）
    rt.reconciliation ||= createReconciliationModule(rt);
    if (!rt.channelOnboarding) await startChannelOnboarding(rt);
    const module = rt.channelProfit ||= createChannelProfitModule(rt);
    const result = operation === "status" ? await module.status(ownStationId)
      : operation === "overview" ? await module.overview(ownStationId)
      : operation === "start" ? await module.start({ ownStationId, channelIds: body.channelIds, coverage: body.coverage })
        : operation === "answer" ? await module.answerCoverage({ ownStationId, ruleId: body.ruleId, coverage: body.coverage })
        : await module.stop({ ownStationId, channelIds: body.channelIds });
    return Response.json(result);
  } catch (error) {
    // 原文可能回显令牌：脱敏以后再给（和接入向导的接口一个做法）
    const reason = connectionDiagnostic(error?.message || "操作没完成，请稍后再试", [rt.store?.get?.(ownStationId)]);
    return Response.json({ error: reason, code: error?.code || "CHANNEL_PROFIT_FAILED" }, { status: 400 });
  }
}
