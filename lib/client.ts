// 前端 API 客户端与展示工具函数（从 v1 app.js 平移，行为逐字对齐）

// ---- API（401 自动跳登录）---------------------------------------------------
// 同源 fetch + JSON；未登录（401）时跳转登录页（登录接口本身的 401 是密码错误，不跳转）
export async function api(path: string, opts: { method?: string; body?: any } = {}): Promise<any> {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    method: opts.method || (opts.body ? "POST" : "GET"),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    window.location.href = "/login";
    throw new Error("未登录");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export type AccountIdentity = { provider: "newapi" | "sub2api"; baseUrl: string; accountId: string };
export type OwnSource = AccountIdentity & { stationId: string; namespaceKey: string };
export type CoverageDeclaration = { answer: "none" | "other_use" | "unknown"; otherUse: "own_channels" | "external" | "unspecified" | null; uncoveredOwnChannelIds: number[] };
export type ConnectionInput = { type: "newapi" | "newapi-key" | "sub2api" | "sub2api-password"; baseUrl: string; name?: string; accessToken?: string; userId?: string; apiKey?: string; email?: string; password?: string };
export type PublicResource = {
  id: string | null; name: string; type: ConnectionInput["type"]; baseUrl: string; monitorEnabled: boolean;
  archivedAt: string | null; authVersion: number; resourceVersion: string | null; identity: AccountIdentity | null;
  verification: "verified" | "unverified"; purposes: { monitor: boolean; billingRuleIds: string[] };
  balance: any; lowBalanceUsd: number | null; cnyPerUsd: number | null; includeInProfit: boolean; noRenewal: boolean;
  hasAccessToken: boolean; hasApiKey: boolean; hasPassword: boolean;
};
export type SafeToken = { id: number; name: string; status: number; group?: string; crossGroupRetry?: boolean; maskedKey?: string };
export type GroupBasis = {
  ownSource: OwnSource; sourceVersion: string; channelRevisions: Record<string, string>;
  resourceVersions: Record<string, { authVersion: number; resourceVersion: string }>;
  accountIdentity: AccountIdentity | null; canonicalKey: string | null; tokenId: number | null; keyVersion: string | null;
  existingRuleId: string | null; existingScopeVersion: number | null; existingChannelIds: number[]; proposedChannelIds: number[];
  timezone: string; billingEffectiveFromMs: number | null; coverageDeclaration: CoverageDeclaration;
};
export type GroupPreview = { costCoverage: "complete" | "unknown"; billingEffectiveFromMs: number | null; firstQueryableAtMs: number | null; scopeChanged: boolean };
export type BatchInput = {
  requestId: string; ownStationId: string;
  selections: { selectionId: string; stationId?: string; newStation?: ConnectionInput; monitor: boolean; additionalMonitorStationIds?: string[]; updateCredentials?: boolean; reconciliationAuthorization?: { stationId?: string; newAuthorization?: ConnectionInput } }[];
  groups: { groupId: string; selectionId: string; channels: { channelId: number; channelRevision: string }[]; reconciliation: null | { tokenId?: number; timezone?: string; coverageDeclaration: CoverageDeclaration } }[];
  previewId?: string;
};
export type BatchRecoveryIntent = {
  requestId: string; source: { ownStationId: string; ownSource: OwnSource; sourceVersion: string };
  selections: { selectionId: string; stationId: string | null; type: ConnectionInput["type"]; baseUrl: string; monitor: boolean; additionalMonitorStationIds: string[]; accountIdentity: AccountIdentity | null; authorizationStationId: string | null; authorizationIdentity: AccountIdentity | null; credentialUpdateRequested: boolean }[];
  groups: { groupId: string; requestedGroupIds: string[]; selectionIds: string[]; channels: { channelId: number; channelRevision: string }[]; reconciliationRequested: boolean; reconciliation: null | { canonicalKey: string; tokenId: number; timezone: string; coverageDeclaration: CoverageDeclaration; previewEffectiveFromMs: number | null } }[];
};
export type BatchProbe = {
  requestId: string; previewId: string; expiresAtMs: number; source: { ownSource: OwnSource; sourceVersion: string; resourceVersion: string };
  selections: { selectionId: string; station: PublicResource | null; monitor: { status: "verified" | "unavailable"; reason?: string }; authorizationStationId: string | null; accountIdentity: AccountIdentity | null; tokens: SafeToken[]; credentialUpdateRequired: boolean }[];
  groups: { groupId: string; requestedGroupIds: string[]; selectionIds: string[]; requestedChannelIds: number[]; status: "ready" | "monitor_only" | "unverified" | "unsupported" | "unavailable"; reason?: string; code?: string; basis: GroupBasis; preview: GroupPreview }[];
  retryInput: BatchRecoveryIntent;
};
export type BatchResult = {
  requestId: string; complete: boolean;
  groups: {
    groupId: string; requestedGroupIds: string[]; canonicalKey: string | null; complete: boolean; code?: string; reason?: string;
    nextPreview?: { billingEffectiveFromMs: number; timezone: string; proposedChannelIds: number[]; coverageDeclaration: CoverageDeclaration };
    monitor: { status: "linked" | "not_requested" | "pending" | "unavailable"; stationIds: string[] };
    reconciliation: { status: "configured" | "not_requested" | "unverified" | "unsupported" | "unavailable" | "pending"; ruleId?: string; scopeVersion?: number; billingEffectiveFromMs?: number; reason?: string };
    channels: { channelId: number; channelRevision: string; complete: boolean; stationIds: string[]; ruleId: string | null; code?: string; reason?: string; remainingActions: string[] }[];
    saved: { stationIds: string[]; authorizationStationId: string | null; links: { ownStationId: string; channelId: number; stationId: string; channelRevision: string; confirmedAt?: string }[]; ruleId: string | null; scopeVersion: number | null; billingEffectiveFromMs: number | null };
    remainingActions: string[];
  }[];
  retryInput: BatchRecoveryIntent;
};
export type RuleEditPreview = { previewId: string; groupId: string; expiresAtMs: number; existingRule?: any; basis: GroupBasis; preview: GroupPreview };
export type WorkflowAction = {
  id: string; kind: "verify_identity" | "update_authorization" | "verify_capability" | "connect_channels" | "confirm_coverage" | "wait_effective" | "review_source" | "inspect_balance";
  label: string; accountKey: string | null; stationId: string | null; ruleId: string | null; ownStationId: string | null;
  channelIds: number[]; window: { startMs: number; endMs: number; timezone: string } | null; href: string;
};
export type PublicCatalogueChannel = {
  id: number; name: string; type: number; status: number; baseUrl: string; groups: string[]; revision: string; missing: boolean;
  monitor: { status: "linked" | "unlinked" | "review_required"; stationIds: string[] };
  reconciliation: { status: "configured" | "unconfigured" | "review_required"; ruleIds: string[] };
};
export type AccountKeyScope = {
  canonicalKey: string; tokenId: number; tokenName: string; ruleIds: string[]; activeRuleIds: string[]; scopeAmbiguous: boolean;
  channels: { ownSource: OwnSource | null; ownStationId: string; channelId: number; name: string }[];
  costCoverage: string; coverageDeclaration: CoverageDeclaration; scopeVersion: number | null;
  billingEffectiveFromMs: number | null; firstQueryableAtMs: number | null;
};
export type AccountRecord = { accountKey: string; siteKey: string; identity: AccountIdentity; resources: PublicResource[]; keys: AccountKeyScope[]; actions: WorkflowAction[] };
export type AccountReadModel = { accounts: AccountRecord[]; unverifiedResources: PublicResource[]; channels: PublicCatalogueChannel[]; actions: WorkflowAction[]; generatedAt: string };

// ---- 工具（与 v1 app.js 完全一致）-------------------------------------------
export const usd = (n: any) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cny = (n: any) => "¥" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cny4 = (n: any) => "¥" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

// 充值折算汇率：站点 $1 折合人民币；未配置按 1:1
export const rateOf = (s: any) => (s && s.cnyPerUsd != null && s.cnyPerUsd > 0 ? s.cnyPerUsd : 1);

export const fmtTokens = (n: any) => {
  n = Number(n) || 0;
  if (n >= 1e9) return +(n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + "K";
  return String(n);
};

// v1 的 fmtEtaText：预计耗尽时间的人话表达
export function fmtEta(days: number): string {
  return days >= 1 ? `${days} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
}

// 站点低余额阈值：站点自身配置优先，否则用全局设置
// （v1 从全局 state.settings 取，这里改为调用方传入 settings，默认值与 v1 初始 state 一致）
export function threshold(s: any, settings: any = { lowBalanceUsd: 5 }): number {
  return s.lowBalanceUsd != null && s.lowBalanceUsd !== "" ? Number(s.lowBalanceUsd) : Number(settings.lowBalanceUsd);
}

export function statusOf(s: any, settings?: any): "pending" | "error" | "danger" | "warn" | "ok" {
  const b = s.balance;
  if (!b) return "pending";
  if (!b.ok) return "error";
  if (b.remaining <= 0) return "danger";
  if (b.remaining < threshold(s, settings)) return "warn";
  return "ok";
}
