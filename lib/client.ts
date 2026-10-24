// 前端 API 客户端与展示工具函数（从 v1 app.js 平移，行为逐字对齐）
import { ERROR_CATEGORIES } from "./error-copy.js";
import { isValidTimeZone } from "./business-time.js";

// ---- API（401 自动跳登录）---------------------------------------------------
// 同源 fetch + JSON；未登录（401）时跳转登录页（登录接口本身的 401 是密码错误，不跳转）
// 接口出错时抛出的 Error 带上接口给的 code 和 HTTP 状态，界面用 lib/error-copy.js 的 describeError 归类后显示（§8.2）；
// message 是接口原文，只放进「查看详细原因」。
export type ApiError = Error & { code?: string; status?: number; retryable?: boolean; nextPreview?: any };

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
  if (!res.ok) {
    const error: ApiError = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    if (data.code) error.code = data.code;
    if (data.retryable != null) error.retryable = data.retryable;
    if (data.nextPreview != null) error.nextPreview = data.nextPreview;
    throw error;
  }
  return data;
}

export type AccountIdentity = { provider: "newapi" | "sub2api"; baseUrl: string; accountId: string };
export type ResourceIdentityConfirmation = { stationId: string; identity: AccountIdentity; accountKey: string; resourceVersion: string };
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
export type MonitorChange = { channelId: number; previousStationIds: string[]; addedStationIds: string[]; removedStationIds: string[]; proposedStationIds: string[] };
export type OnboardingChannelIntent = { channelId: number; channelRevision: string; removeMonitorStationIds?: string[]; selectionId?: string };
export type BatchInput = {
  requestId: string; ownStationId: string;
  selections: { selectionId: string; stationId?: string; newStation?: ConnectionInput; monitor: boolean; additionalMonitorStationIds?: string[]; updateCredentials?: boolean; reconciliationAuthorization?: { stationId?: string; newAuthorization?: ConnectionInput } }[];
  groups: { groupId: string; selectionId: string; channels: OnboardingChannelIntent[]; reconciliation: null | { tokenId?: number; timezone?: string; coverageDeclaration: CoverageDeclaration } }[];
  previewId?: string;
};
export type BatchRecoveryIntent = {
  requestId: string; source: { ownStationId: string; ownSource: OwnSource; sourceVersion: string };
  selections: { selectionId: string; stationId: string | null; type: ConnectionInput["type"] | null; baseUrl: string | null; linkOnly?: boolean; monitor: boolean; additionalMonitorStationIds: string[]; accountIdentity: AccountIdentity | null; authorizationStationId: string | null; authorizationIdentity: AccountIdentity | null; credentialUpdateRequested: boolean }[];
  groups: { groupId: string; requestedGroupIds: string[]; selectionIds: string[]; channels: OnboardingChannelIntent[]; reconciliationRequested: boolean; reconciliation: null | { canonicalKey: string; tokenId: number; timezone: string; coverageDeclaration: CoverageDeclaration; previewEffectiveFromMs: number | null } }[];
};
export type BatchProbe = {
  requestId: string; previewId: string; expiresAtMs: number; source: { ownSource: OwnSource; sourceVersion: string; resourceVersion: string };
  selections: { selectionId: string; station: PublicResource | null; monitor: { status: "verified" | "unavailable"; reason?: string }; authorizationStationId: string | null; accountIdentity: AccountIdentity | null; tokens: SafeToken[]; credentialUpdates: { role: "primary" | "authorization"; stationId: string }[]; credentialUpdateRequired: boolean }[];
  groups: { groupId: string; requestedGroupIds: string[]; selectionIds: string[]; requestedChannelIds: number[]; status: "ready" | "monitor_only" | "unverified" | "unsupported" | "unavailable"; reason?: string; code?: string; basis: GroupBasis; preview: GroupPreview; monitorChanges?: MonitorChange[] }[];
  retryInput: BatchRecoveryIntent;
};
export type BatchResult = {
  requestId: string; complete: boolean;
  groups: {
    groupId: string; requestedGroupIds: string[]; canonicalKey: string | null; complete: boolean; code?: string; reason?: string;
    monitor: { status: "linked" | "unlinked" | "not_requested" | "pending" | "unavailable"; stationIds: string[] };
    monitorChanges?: MonitorChange[];
    reconciliation: { status: "configured" | "not_requested" | "unverified" | "unsupported" | "unavailable" | "pending"; ruleId?: string; scopeVersion?: number; billingEffectiveFromMs?: number; reason?: string };
    channels: { channelId: number; channelRevision: string; complete: boolean; stationIds: string[]; ruleId: string | null; code?: string; reason?: string; remainingActions: string[] }[];
    saved: { stationIds: string[]; authorizationStationId: string | null; links: { ownStationId: string; channelId: number; stationId: string; channelRevision: string; confirmedAt?: string }[]; ruleId: string | null; scopeVersion: number | null; billingEffectiveFromMs: number | null };
    remainingActions: string[];
  }[];
  retryInput: BatchRecoveryIntent;
};
export type RuleEditPreview = { previewId: string; groupId: string; expiresAtMs: number; existingRule?: any; basis: GroupBasis; preview: GroupPreview };
export type ConfirmedHistoryWindow = { preset: string; startMs: number; endMs: number; timezone: string | null };
export type ConfirmedHistoryBilling = {
  state: "complete" | "partial" | "unavailable" | "pending" | null; quotaUnits: number | null; quotaPerUnit: number | null;
  amountUsd: number | null; knownAmountUsd: number | null; countedAmountUsd: number | null;
  successfulCount: number | null; expectedCount: number | null; observedAt: number | null; window: ConfirmedHistoryWindow;
};
export type ConfirmedHistoryRecord = {
  historyId: string; confirmedAt: string; window: ConfirmedHistoryWindow; ownSource: OwnSource | null;
  upstreamSource: { provider: string | null; baseUrl: string | null; accountId: string | null; tokenId: number | null; tokenName: string | null };
  scopeVersion: number | null; scopeFingerprint: string | null; billingEffectiveFromMs: number | null; channels: { channelId: number; name: string | null }[];
  amountBasis: { id: string; currency: "USD"; billingSource: string; calculationVersion: number; conversion: "quota_per_unit" | "provider_cost_usd" | null };
  upstream: ConfirmedHistoryBilling; downstream: ConfirmedHistoryBilling & { channels: { channelId: number; name: string | null; billingState: string | null; quotaUnits: number | null; amountUsd: number | null; knownAmountUsd: number | null }[] };
  calculation: { differenceUsd: number | null; profitUsd: number | null; riskDifferenceUsd: number | null; marginRate: number | null };
  sourceCompleteness: "complete" | "legacy_partial";
  // 结账账本：自然日、版本（重新结账 +1）、来源、结账时配置的汇率（没配置为 null）和成本计法。
  // 迁移的旧账成本计法为 null：历史里按原记录（Key 用量）显示，当前核算按现在的配置算，与第 3b 阶段一致。
  billDate?: string; revision?: number; settlementSource?: "settle" | "resettle" | "migrated";
  settledRates?: { income: number | null; cost: number | null }; costBasis?: "usage" | "fixed" | null;
};
export type ConfirmedHistoryResponse = { ruleId: string; readOnly: true; records: ConfirmedHistoryRecord[]; nextCursor: string | null };
export type ReconciliationAmountBasis = { id: string; currency: "USD"; billingSource: string; calculationVersion: number; conversion: "quota_per_unit" | "provider_cost_usd" | null };
export type KnownChannelCoverage = {
  label: "known-channel-coverage"; state: "complete_known" | "partial" | "unknown"; catalogueState: "verified" | "unknown"; wholeSiteState: "unverified";
  knownChannelCount: number; accountedChannelCount: number;
  channels: { ownSource: OwnSource | null; ownStationId: string; channelId: number; name: string; operatingState: string; ruleIds: string[];
    status: "accounted" | "unlinked" | "not_effective" | "source_unverified" | "billing_missing" | "coverage_unknown" | "duplicate" | "monitor_only" | "unsupported"; issues: string[]; actions: WorkflowAction[] }[];
};
// 金额默认按系统原值（USD）显示；本站和各上游都设置了汇率时整页按人民币显示。*Usd 字段始终是账单原币原始口径。
export type ReconciliationCurrency = "USD" | "CNY";
export type ReconciliationDisplayTotals = { currency: ReconciliationCurrency; knownIncome: number | null; knownCost: number | null; confirmedProfit: number | null; confirmedMarginRate: number | null };
export type ReconciliationWindowTotals = { knownIncomeUsd: number | null; knownCostUsd: number | null; confirmedProfitUsd: number | null; confirmedMarginRate: number | null; profitComplete: boolean; notCountedCostRuleIds: string[]; display?: ReconciliationDisplayTotals };
// 未纳入核算的上游消费 = 各按用量计费上游的账号级扣费 − 已计入核算的 Key 成本；只对共同汇总给出。
export type UnaccountedUpstreamState = "pending" | "partial" | "estimated" | "complete";
export type UnaccountedUpstream = {
  state: UnaccountedUpstreamState; currency: ReconciliationCurrency; total: number | null;
  accounts: { stationId: string; name: string; rate: number | null; mode: string | null; endMs: number | null; state: UnaccountedUpstreamState | "unavailable"; notes: string[]; ruleIds: string[];
    accountUsd: number | null; accountedUsd: number; unaccountedUsd: number | null; account: number | null; accounted: number; unaccounted: number | null;
    // 已核算多于账号扣费（unaccounted < 0）时的原因：取数时刻不同、汇率不同或两者都有
    overAccounted?: "timing" | "rate" | "mixed" | null }[];
  window: { startMs: number; endMs: number; timezone: string; preset: string };
  fixedStations: { id: string; name: string }[]; excludedStations: { id: string; name: string }[];
};
export type ReconciliationWindowGroup = { groupKey: string; ownSource: OwnSource | null; window: { startMs: number; endMs: number; preset?: string }; timezones: string[]; amountBasis: ReconciliationAmountBasis; ruleIds: string[]; totals: ReconciliationWindowTotals; coverage: KnownChannelCoverage; actions: WorkflowAction[] };
// live 实时（窗口未结束）/ settled 已结账 / ended 已结束（非整日窗口，不结账）/ pending 待结账 / unavailable 不可用；由服务端给出，前端只渲染。
export type ReconciliationSettlement = "live" | "settled" | "ended" | "pending" | "unavailable";
export type ReconciliationSummary = { groupKey: string; totals: ReconciliationWindowTotals; coverage: KnownChannelCoverage };
export type WorkflowAction = {
  // 种类和按钮文字只在 lib/workflow-actions.js 定义（ACTIONS）
  id: string; kind: "verify_identity" | "update_authorization" | "verify_capability" | "connect_channels" | "confirm_coverage" | "review_source" | "inspect_balance" | "retry_bill" | "review_conflict"
    | "edit_binding" | "correct_timing" | "refresh" | "swap_key" | "unbind" | "delete_upstream" | "view_detail" | "setup_own_station";
  label: string; title?: string; detail?: string; code?: string; accountKey: string | null; stationId: string | null; ruleId: string | null; ownStationId: string | null;
  channelIds: number[]; window: { startMs: number; endMs: number; timezone: string } | null; href: string | null;
};
export type WorkflowDestination = {
  action: string; ruleId: string | null; stationId: string | null; accountKey: string | null; ownStationId: string | null;
  channelIds: number[]; window: WorkflowAction["window"]; error: string;
};
export type SourceCatalogueProjection = { ownSource: OwnSource | null; sourceVersion: string | null };
export type BillingCapability = { state: "supported" | "unsupported" | "unverified"; currency: string; window: string; reason?: string; message?: string };
export type BillingTimezone = { state: "verified" | "unverified"; timezone: string; reason?: string };
export type UpstreamKeyRead = {
  quotaPerUnit: number | null; version: string; groups: Record<string, { ratio: number; description?: string }>;
  platform: string; capability: BillingCapability; billingTimezone: BillingTimezone; tokens: SafeToken[];
  identity: AccountIdentity | null; resourceVersion: string;
  probe: null | { tokenId: number; state: string; complete: boolean; window: { startMs: number | null; endMs: number | null; timezone: string | null };
    currency: string; amountUsd: number | null; knownAmountUsd: number | null; actualCostUsd: number | null; quotaUnits: number | null; quotaPerUnit: number | null;
    capability: BillingCapability | null; billingTimezone: BillingTimezone | null };
};
// 链接里的参数不对（旧链接、手改过）时只写一句「页面已过期」（design/ui-copy-spec.md §8.2），不说是哪个参数
const DESTINATION_EXPIRED = `${ERROR_CATEGORIES.expired.text}。`;
export function readWorkflowDestination(search: string, page: "stations" | "reconciliation"): WorkflowDestination | null {
  const params = new URLSearchParams(search), action = params.get("action") || "inspect";
  if (!params.has("action") && !params.has("stationId") && !params.has("accountKey")) return null;
  const result: WorkflowDestination = { action, ruleId: params.get("ruleId"), stationId: params.get("stationId"), accountKey: params.get("accountKey"), ownStationId: params.get("ownStationId"), channelIds: [], window: null, error: "" };
  const allowed = page === "stations" ? ["connect", "verify", "authorization", "verify-billing", "coverage", "source", "inspect", "scope", "conflict"] : ["retry", "conflict", "scope"];
  if (!allowed.includes(action)) result.error = DESTINATION_EXPIRED;
  else if (page === "stations" && ["scope", "conflict"].includes(action) && !result.ruleId) result.error = DESTINATION_EXPIRED;
  const channelIds = params.get("channelIds");
  if (channelIds != null) {
    const values = channelIds.split(",");
    if (values.some((value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) result.error = DESTINATION_EXPIRED;
    else { result.channelIds = [...new Set(values.map(Number))]; if (result.channelIds.length > 100) result.error = DESTINATION_EXPIRED; }
  }
  if (action === "retry") {
    const start = params.get("startMs"), end = params.get("endMs"), timezone = params.get("timezone");
    if (!start || !end || !/^\d+$/.test(start) || !/^\d+$/.test(end) || !Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end)) || !Number.isFinite(new Date(Number(start)).valueOf()) || !Number.isFinite(new Date(Number(end)).valueOf()) || Number(end) <= Number(start) || !timezone) result.error = DESTINATION_EXPIRED;
    else if (isValidTimeZone(timezone)) result.window = { startMs: Number(start), endMs: Number(end), timezone };
    else result.error = DESTINATION_EXPIRED;
  }
  return result;
}
export type PublicCatalogueChannel = {
  id: number; name: string; type: number; status: number; baseUrl: string; groups: string[]; revision: string; missing: boolean;
  monitor: { status: "linked" | "unlinked" | "review_required"; stationIds: string[] };
  reconciliation: { status: "configured" | "unconfigured" | "review_required"; ruleIds: string[] };
};
// 一条核算关联：一把 Key 在某个本站下归属的渠道范围（停止后保留为历史）
export type AccountAssociation = {
  ruleId: string; status: "active" | "stopped"; upstreamStationId: string; ownStationId: string; timezone: string;
  channels: { channelId: number; name: string }[]; costCoverage: string; coverageDeclaration: CoverageDeclaration;
  scopeVersion: number; billingEffectiveFromMs: number | null; accountingStartMs: number | null;
  // 有效关联之间的重复归属：同一实际 Key 或同一渠道被多条有效关联认领
  conflict: boolean; conflictRuleIds: string[]; stoppedAt: string | null;
  // 拆开的重复归属：同一实际 Key 的（只能停掉一条）、同占渠道的（也可编辑渠道移除 duplicateChannelIds）
  keyConflictRuleIds?: string[]; channelConflictRuleIds?: string[]; duplicateChannelIds?: number[];
};
// 归不到已核验 Key 下、但仍在核算的有效关联
export type UnmatchedAssociation = AccountAssociation & {
  reason: "unverified_resource" | "unanchored" | "key_changed" | "missing_resource"; tokenId: number; tokenName: string;
};
export type AccountKeyScope = {
  canonicalKey: string; tokenId: number; tokenName: string; ruleIds: string[]; activeRuleIds: string[]; scopeAmbiguous: boolean;
  associations: AccountAssociation[];
  channels: { ownSource: OwnSource | null; ownStationId: string; channelId: number; name: string }[];
  costCoverage: string; coverageDeclaration: CoverageDeclaration; scopeVersion: number | null;
  billingEffectiveFromMs: number | null; firstQueryableAtMs: number | null;
};
export type AccountRecord = { accountKey: string; siteKey: string; identity: AccountIdentity; resources: PublicResource[]; keys: AccountKeyScope[]; actions: WorkflowAction[] };
export type AccountReadModel = { accounts: AccountRecord[]; unverifiedResources: PublicResource[]; unmatchedAssociations?: UnmatchedAssociation[]; channels: PublicCatalogueChannel[]; actions: WorkflowAction[]; generatedAt: string; tz?: string };
export type AccountAuthorizationRecoveryIntent = { requestId: string; targetStationIds: string[] };
export type AccountAuthorizationInput = AccountAuthorizationRecoveryIntent & { authorization?: { type: "newapi" | "sub2api" | "sub2api-password"; baseUrl: string; accessToken?: string; userId?: string; email?: string; password?: string }; reuseSavedAuthorization?: boolean; previewId?: string };
export type AccountAuthorizationImpact = { monitorStationIds: string[]; billingRuleIds: string[]; channels: { ownStationId: string; channelId: number; name: string }[] };
export type AccountAuthorizationProbe = {
  requestId: string; previewId: string; expiresAtMs: number; accountKey: string; identity: AccountIdentity;
  targets: { stationId: string; authVersion: number; resourceVersion: string; currentType: string; newType: string; purposes: PublicResource["purposes"]; monitorChannelIds: number[]; billingRuleIds: string[]; billingChannelIds: number[] }[];
  excluded: { stationId: string; code?: string; reason: string }[]; impact: AccountAuthorizationImpact; retryInput: AccountAuthorizationRecoveryIntent;
};
export type AccountAuthorizationResult = { requestId: string; accountKey: string; complete: boolean; targets: { stationId: string; status: "updated" | "already_updated" | "failed" | "repreview_required"; savedAuthVersion: number | null; code?: string; exclusionCode?: string; reason?: string; remainingActions: string[] }[]; excluded: { stationId: string; code?: string; reason: string }[]; impact: AccountAuthorizationImpact; retryInput: AccountAuthorizationRecoveryIntent };
