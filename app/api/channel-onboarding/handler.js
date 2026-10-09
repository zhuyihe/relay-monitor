import { describeConnectionFailure } from "../../../lib/connection-test.js";

// Auth is provided by the route wrapper; this seam keeps request/result tests isolated.
export async function handleChannelOnboardingRequest(request, rt, operation, params = {}) {
  const module = rt.channelOnboarding;
  if (!module) return Response.json({ error: "渠道接入模块尚未就绪，请稍后重试" }, { status: 503 });
  let body;
  const accountAuthorization = ["probeAccountAuthorization", "updateAccountAuthorization", "recoverAccountAuthorization"].includes(operation);
  if (accountAuthorization || ["connect", "probe", "connectBatch", "probeBatch", "recoverBatch"].includes(operation)) {
    try { body = await request.json(); } catch {
      return Response.json({ error: "请求格式无效", code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "请求格式无效", code: "INVALID_REQUEST" }, { status: 400 });
    }
  }
  try {
    const result = accountAuthorization ? await module[operation](params.accountKey, body) : await module[operation](body, params);
    return Response.json(result);
  } catch (error) {
    const connections = [body?.newStation, body?.reconciliation?.newAuthorization, body?.authorization,
      rt.store?.get?.(body?.stationId), rt.store?.get?.(body?.reconciliation?.upstreamStationId),
      rt.store?.get?.(body?.ownStationId || body?.source?.ownStationId),
      ...(operation === "listAccounts" ? rt.store?.list?.({ includeUnmonitored: true, includeArchived: true }) || [] : []),
      ...(accountAuthorization ? rt.store?.list?.({ includeUnmonitored: true, includeArchived: true }) || [] : []),
      ...(Array.isArray(body?.selections) ? body.selections.flatMap((selection) => [selection?.newStation,
        selection?.reconciliationAuthorization?.newAuthorization, rt.store?.get?.(selection?.stationId),
        rt.store?.get?.(selection?.authorizationStationId), rt.store?.get?.(selection?.reconciliationAuthorization?.stationId)]) : [])];
    const reason = describeConnectionFailure(error?.message || "接入失败，请重新确认", connections).diagnostic;
    return Response.json({ error: reason, code: error?.code || "ONBOARDING_FAILED" }, { status: 400 });
  }
}
