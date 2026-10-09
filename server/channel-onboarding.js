import { queryNewApiReconciliationMetadata } from "../lib/providers.js";
import { describeConnectionFailure } from "../lib/connection-test.js";
import { onboardingBaseUrl } from "../lib/channel-onboarding.js";

// 验证后才保存。重试和同进程并发接入按上游地址 + 账号身份复用，避免重复监控同一余额。
export async function connectNewApiUpstream(rt, input, queryMetadata = queryNewApiReconciliationMetadata) {
  const baseUrl = onboardingBaseUrl(input?.baseUrl);
  const accessToken = String(input?.accessToken || "").trim();
  if (!baseUrl) throw new Error("请填写有效的上游站点根地址");
  if (!accessToken) throw new Error("请填写上游账号的系统访问令牌");
  const connection = { type: "newapi", baseUrl, accessToken, userId: String(input?.userId || "").trim() };
  let metadata;
  try { metadata = await queryMetadata(connection); } catch (err) {
    throw new Error(describeConnectionFailure(err?.message || String(err), connection).diagnostic);
  }
  const userId = String(metadata.userId || "").trim();
  if (!userId) throw new Error("无法确认上游账号身份，请填写用户 ID 后重试");

  const pending = (rt._newApiOnboardingChain || Promise.resolve()).then(async () => {
    const existing = rt.store.list().find((station) => station.type === "newapi" && !station.isOwn && !station.archivedAt
      && onboardingBaseUrl(station.baseUrl) === baseUrl
      && (String(station.userId || "").trim() === userId
        || (!station.userId && String(station.accessToken || "").replace(/^Bearer\s+/i, "").trim() === accessToken.replace(/^Bearer\s+/i, ""))));
    if (existing) return { station: { id: existing.id, name: existing.name, type: existing.type, baseUrl: existing.baseUrl }, created: false };
    const station = await rt.store.add({ ...connection, userId, name: String(input?.name || "").trim() || "上游账号" });
    return { station: { id: station.id, name: station.name, type: station.type, baseUrl: station.baseUrl }, created: true };
  });
  rt._newApiOnboardingChain = pending.catch(() => {});
  return pending;
}
