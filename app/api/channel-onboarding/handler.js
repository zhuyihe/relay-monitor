import { describeConnectionFailure } from "../../../lib/connection-test.js";

// Auth is provided by the route wrapper; this seam keeps request/result tests isolated.
export async function handleChannelOnboardingRequest(request, rt, operation) {
  const module = rt.channelOnboarding;
  if (!module) return Response.json({ error: "渠道接入模块尚未就绪，请稍后重试" }, { status: 503 });
  let body;
  if (operation === "connect" || operation === "probe") {
    try { body = await request.json(); } catch {
      return Response.json({ error: "请求格式无效", code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "请求格式无效", code: "INVALID_REQUEST" }, { status: 400 });
    }
  }
  try {
    const result = await module[operation](body);
    return Response.json(result);
  } catch (error) {
    let reason = error?.message || "接入失败，请重新确认";
    for (const connection of [body?.newStation, body?.reconciliation?.newAuthorization]) {
      reason = describeConnectionFailure(reason, connection).diagnostic;
    }
    return Response.json({ error: reason, code: error?.code || "ONBOARDING_FAILED" }, { status: 400 });
  }
}
