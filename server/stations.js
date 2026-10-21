// 站点响应拼装助手（v1 server.js redact 的平移版，改为显式接收 rt）。
// 隐藏敏感凭证，仅返回是否已配置；告警的去重状态（alertState，里面有通知发送失败的原文）前端用不到，不返回
import { businessTimeZone, dayBoundsInTz } from "../lib/business-time.js";
import { connectionDiagnostic } from "../lib/connection-test.js";

export function redact(rt, s) {
  const { accessToken, apiKey, password, s2Tokens, onboardingOrigin, authorizationUpdateRef, alertState, ...rest } = s;
  const balance = s.balance && !s.balance.ok
    ? { ...s.balance, error: connectionDiagnostic(s.balance.error, s) }
    : s.balance;
  // 今日消耗：sub2api 直接用站点仪表盘接口的值；拿不到就按余额历史从业务时区零点推算（前端标 ≈）
  const midnight = dayBoundsInTz(Date.now(), businessTimeZone()).startMs;
  const fromSite = s.balance?.todayUsed;
  return {
    ...rest,
    balance,
    hasAccessToken: !!accessToken,
    hasApiKey: !!apiKey,
    hasPassword: !!password,
    tokenInfo: s2Tokens
      ? { expiresAt: s2Tokens.expiresAt || null, lastLoginAt: s2Tokens.lastLoginAt || null }
      : null,
    prediction: rt.history.predict(s.id),
    spark: rt.history.sparkline(s.id, 48),
    todayUsed: fromSite ?? rt.history.usedSince(s.id, midnight),
    todayIsEstimate: fromSite == null,
    todayTokens: s.balance?.todayTokens ?? null,
    todayRequests: s.balance?.todayRequests ?? null,
  };
}
