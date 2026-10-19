import { describeConnectionFailure } from "../../../lib/connection-test.js";

// Auth is provided by the route wrapper; this seam keeps request/result tests isolated.
export async function handleChannelOnboardingRequest(request, rt, operation, params = {}) {
  const module = rt.channelOnboarding;
  if (!module) return Response.json({ error: "系统还没准备好，请稍后刷新", code: "NOT_READY" }, { status: 503 });
  let body;
  const accountAuthorization = ["probeAccountAuthorization", "updateAccountAuthorization", "recoverAccountAuthorization"].includes(operation);
  const resourceIdentity = operation === "confirmResourceIdentity";
  if (resourceIdentity || accountAuthorization || ["connect", "probe", "connectBatch", "probeBatch", "recoverBatch"].includes(operation)) {
    try { body = await request.json(); } catch {
      return Response.json({ error: "页面已过期，请刷新后重新打开", code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "页面已过期，请刷新后重新打开", code: "INVALID_REQUEST" }, { status: 400 });
    }
  }
  try {
    const result = resourceIdentity ? await module[operation](params.stationId, body)
      : accountAuthorization ? await module[operation](params.accountKey, body) : await module[operation](body, params);
    return Response.json(result);
  } catch (error) {
    const connections = [body?.newStation, body?.reconciliation?.newAuthorization, body?.authorization,
      rt.store?.get?.(params.stationId), rt.store?.get?.(body?.stationId), rt.store?.get?.(body?.reconciliation?.upstreamStationId),
      rt.store?.get?.(body?.ownStationId || body?.source?.ownStationId),
      ...(operation === "listAccounts" ? rt.store?.list?.({ includeUnmonitored: true, includeArchived: true }) || [] : []),
      ...(accountAuthorization ? rt.store?.list?.({ includeUnmonitored: true, includeArchived: true }) || [] : []),
      ...(Array.isArray(body?.selections) ? body.selections.flatMap((selection) => [selection?.newStation,
        selection?.reconciliationAuthorization?.newAuthorization, rt.store?.get?.(selection?.stationId),
        rt.store?.get?.(selection?.authorizationStationId), rt.store?.get?.(selection?.reconciliationAuthorization?.stationId)]) : [])];
    const reason = describeConnectionFailure(error?.message || "操作没完成，请稍后再试", connections).diagnostic;
    return Response.json({ error: reason, code: error?.code || "ONBOARDING_FAILED" }, { status: 400 });
  }
}
