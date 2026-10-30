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
  scopeVersion: number | null; scopeFingerprint: string | null; billingEffectiveFromMs: number | null; accountingStartMs: number | null; accountedToMs: number | null; channels: { channelId: number; name: string | null }[];
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
// 金额默认按系统原值（USD）显示；自营站点和各上游都设置了汇率时整页按人民币显示。*Usd 字段始终是账单原币原始口径。
export type ReconciliationCurrency = "USD" | "CNY";
// ---- 每日利润页（POST /api/reconciliation/profit、GET …/profit/detail；字段名照设计稿 daily-profit-a.md §9）----
// 一行一天的小格：fixed 已固定 / reading 还在读取 / today 今天 / attention 需处理 / notStarted 还没开始算 / future 还没到
export type ProfitDayCell = { day: string; state: "fixed" | "reading" | "today" | "attention" | "notStarted" | "future"; gapUsd: number | null; gapState: "over" | "under" | "within" | null; reason: string | null; tokens: number | null;
  // 这天的收入、上游成本、毛利（美元原币）：已固定的取账本，今天取这一行整段的数，其余是 null
  incomeUsd: number | null; actualCostUsd: number | null; grossUsd: number | null };
// 差额的状态：over / under 对不上（多扣 / 少扣）、within 门槛以内、today 明天出、reading 还在读取、uncomputable 算不了（reason 给原因）、attention 需处理、notStarted 还没开始算
export type ProfitGapState = "over" | "under" | "within" | "today" | "reading" | "none";
// 一行（一个渠道）范围里用过的每把 Key（用户 10-30 定）：收入是读的时候分的（只有一把全归它；几把按原价用量比例；读不到倍率按成本比例），不存
export type ProfitKeyRow = {
  tokenId: number; name: string;
  upstream: { stationId: string; name: string | null; provider: "newapi" | "sub2api" | null };
  // active 在绑的渠道现在用的那把；unbound 已解绑的渠道最后用的那把（不标标签）；swapped 已换掉的
  state: "active" | "swapped" | "unbound"; firstDay: string; lastDay: string; days: number;
  // 倍率：New API 是分组倍率，Sub2API 是 实际扣除 ÷ 标准计费；读不到是 null。rawUsd 原价用量
  ratio: number | null; ratioKind: "group" | "actual_over_standard";
  costUsd: number | null; rawUsd: number | null; incomeUsd: number | null; incomeBasis: "single" | "raw" | "cost" | null;
  grossProfitUsd: number | null; grossMarginRate: number | null;
  // 范围里有几天这把 Key 的收入份额没分（这天还没固定、只有一边固定）：数不进 incomeUsd，成本照进 costUsd
  pendingDays: number;
};
export type ProfitRow = {
  rowKey: string; ruleIds: string[]; channels: { channelId: number; name: string | null }[];
  upstream: { stationId: string; name: string | null; provider: string | null };
  key: { name: string; groupName: string | null; groupRatio: number | null; upstreamKeyUrl: string | null };
  // 页面换算用的汇率：收入按自营站点、成本按这个上游；没设置是 null（按美元显示）
  rates: { income: number | null; cost: number | null; costBasis: "usage" | "fixed" | null };
  startedOn: string | null; startedAt: number | null; counted: boolean;
  // 一个渠道一行（rowKey `ch:<自营站点>:<渠道>`）；bound 在绑着的，unboundOn 已解绑的那天（整天算，之后不算）；毛利率 = 毛利 ÷ 收入，没收入是 null（页面 PR 接了就去掉 ?）
  bound?: boolean; unboundOn?: string | null; grossMarginRate?: number | null;
  keys?: ProfitKeyRow[];
  incomeUsd: number | null; actualCostUsd: number | null; grossProfitUsd: number | null; uncountedIncomeUsd: number | null; expectedCostUsd: number | null;
  gap: { usd: number | null; rate: number | null; state: ProfitGapState; mismatchedDays: { day: string; usd: number; state: "over" | "under" }[]; days: number; reason: string | null; missingPriceModels: string[] };
  // 提示类的感叹号（今天提醒换 Key）：这一行照读到的数算、进合计，不是需处理
  notice: { code: string; text: string; detail: string | null; action: WorkflowAction | null } | null;
  attention: { code: string | null; title: string | null; detail: string | null; action: WorkflowAction | null; fromDay: string | null; moreCount: number;
    // 这天重算的数比原来少了一半多、没换掉（RESETTLE_SHRUNK）：点「重新读取」先弹确认框用这几个数，没有就是 null（C3，resettleShrunkConfirm）
    shrunk: { side: "revenue" | "cost" | "both"; before: { revenueUsd: number | null; costUsd: number | null }; after: { revenueUsd: number | null; costUsd: number | null } } | null } | null;
  excludedDays: number; daily: ProfitDayCell[];
  latestSettledGap: { day: string; usd: number | null; state: "over" | "under" | "within" | null; reason: string | null } | null;
};
export type ProfitPageResponse = {
  range: { preset: string | null; startMs: number; endMs: number; timezone: string }; today: string;
  dayCounts: { fixed: number; reading: number; today: number };
  pageTotals: { incomeUsd: number | null; actualCostUsd: number | null; grossProfitUsd: number | null; grossMarginRate: number | null };
  gap: { days: { first: string | null; last: string | null; count: number; contiguous: boolean }; expectedCostUsd: number | null; actualCostUsd: number | null; usd: number | null; overUsd: number; underUsd: number; withinUsd: number; rowCount: number };
  latestSettledGap: { day: string; usd: number | null; mismatchedRowCount: number } | null;
  counts: { channels: number; countedChannels: number; mismatchedChannels: number; attentionChannels: number; uncomputable: Record<string, number>; mismatchedDays: { over: number; under: number } };
  gapThreshold: { usd: number; rate: number }; rows: ProfitRow[];
  asOf: string; tz: string; displayCurrency: ReconciliationCurrency; fixedCostUsd: number | null; fixedCostCny?: number | null; netProfitUsd: number | null;
  ownIncomeUnavailable: { code: string } | null; unaccountedUpstreamCostUsd: number | null; unlinkedChannelCount: number; notCountedDays?: { count: number }; unsupportedChannels?: { channelId: number; name: string; reason: string; upstreamNames: string[] }[];
  rateUnset: { id: string; name: string }[]; fixedOffProfitStations: { id: string; name: string }[];
  // 每天的实付成本合计（成本估算「每天的上游成本」用）：美元原值和按各行汇率折的人民币
  dailyCost?: { day: string; actualCostUsd: number; actualCostCny?: number }[];
};
export type ProfitDetailModel = { model: string; upstreamModel?: string | null; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; pricesPerMillion?: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } | null; beforeRatioUsd: number; usd: number };
export type ProfitDetailResponse = {
  day: string; settled: boolean;
  income: { usd: number | null; adminUsage: { usd: number | null; deducted: "all" | "some" | "none" }; byChannel: { channelId: number; usd: number | null }[] };
  // backfilledAt：这天固定时收费记录还没读完、后来补算的时刻；没补算是 null
  expected: { usd: number | null; reason: string | null; keyChange?: { atMs: number | null; between: [number, number] | null } | null; backfilledAt?: string | null; groupName: string | null; groupRatio: number | null; segments: { startMs: number; endMs: number; ratio: number | null; group?: string | null; usd?: number | null; ruleId: string | null }[];
    byModel: ProfitDetailModel[]; missingPriceModels: { model: string; inputTokens: number; outputTokens: number; requests: number }[]; byChannel: { channelId: number; usd: number | null }[]; tokens: number | null };
  actual: { usd: number | null; keyName: string | null };
  // 这天没算出来的原因（换 Key 冲突期、还在读取、需处理…），算出来的是 null：实付、毛利写「—」加这个原因，不写 0
  unavailable?: { code: string | null; title: string | null; detail: string | null } | null;
  gap: { usd: number | null; rate: number | null; state: "over" | "under" | "within" | null } | null;
  grossProfitUsd: number | null; fixedAt: string | null; revisions: number | null;
  // 固定这天时自营站点的设置一直读不到（R2）
  settingUnreadable?: boolean;
  // 这一天按 Key 分开的数；split 是收入怎么分的（pending：这天还没固定或没法分），swappedUpstream 这天用了不同上游的 Key，keyChangeRatioDiffers 这天几把 Key 倍率不一样
  keys?: (Omit<ProfitKeyRow, "state" | "firstDay" | "lastDay" | "days" | "pendingDays">)[];
  split?: { basis: "single" | "raw" | "cost" | "pending"; shares: { tokenId: number; percent: number }[] };
  swappedUpstream?: boolean; keyChangeRatioDiffers?: boolean;
};
export type WorkflowAction = {
  // 种类和按钮文字只在 lib/workflow-actions.js 定义（ACTIONS）
  id: string; kind: "verify_identity" | "update_authorization" | "verify_capability" | "connect_channels" | "confirm_coverage" | "review_source" | "inspect_balance" | "retry_bill" | "review_conflict"
    | "edit_binding" | "correct_timing" | "refresh" | "swap_key" | "unbind" | "delete_upstream" | "view_detail" | "setup_own_station" | "check_connection" | "fix_agent_url" | "fix_agent_token" | "go_swap_key" | "add_upstream" | "recheck_consume_log";
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
  const allowed = page === "stations" ? ["connect", "verify", "authorization", "verify-billing", "coverage", "source", "channels", "swap-key", "inspect", "scope", "conflict"] : ["retry", "conflict", "scope"];
  if (!allowed.includes(action)) result.error = DESTINATION_EXPIRED;
  else if (page === "stations" && ["scope", "conflict"].includes(action) && !result.ruleId) result.error = DESTINATION_EXPIRED;
  const channelId = params.get("channelId");
  if (channelId != null) { if (!/^\d+$/.test(channelId) || !Number.isSafeInteger(Number(channelId)) || Number(channelId) < 1) result.error = DESTINATION_EXPIRED; else result.channelIds = [Number(channelId)]; }
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
// 渠道 Key 读取服务认出的「现在用的 Key」（K2a，只认只显示）；keyless 没有 slots，页面暂不画这个字段。
// stale/staleReason：读取服务自己读库失败、给的是上一份旧结果（K1b 定的协议），这一版页面还没画，先把
// 形状定好（审核 #131 M2）。via：这一把是指纹认出的、打码认出的、还是 reveal 取完整 Key 以后认出的（k-plan §3.2）
export type IdentifiedChannelKey = {
  channelId: number; keyless?: true; stale?: boolean; staleReason?: string | null;
  slots?: { index: number; state: "identified" | "ambiguous" | "not_found" | "unresolved";
    matches?: { stationId: string; tokenId: number; tokenName: string; via?: "fingerprint" | "mask" | "revealed" }[] }[];
};
export type PublicCatalogueChannel = {
  id: number; name: string; type: number; status: number; baseUrl: string; groups: string[]; revision: string; missing: boolean;
  monitor: { status: "linked" | "unlinked" | "review_required"; stationIds: string[] };
  reconciliation: { status: "configured" | "unconfigured" | "review_required"; ruleIds: string[] };
  identifiedKey: IdentifiedChannelKey | null;
};
// 一条核算关联：一把 Key 在某个本站下归属的渠道范围（停止后保留为历史）
export type AccountAssociation = {
  ruleId: string; status: "active" | "stopped"; upstreamStationId: string; ownStationId: string; timezone: string;
  channels: { channelId: number; name: string }[]; costCoverage: string; needsCoverageAnswer: boolean; coverageDeclaration: CoverageDeclaration;
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

// GET /api/stations：上游列表。generatedAt 是服务端此刻，上游列表拿它判断「数据旧了」（design/ui-design-spec.md §5.2）
export type StationListResponse = { stations: any[]; settings: Record<string, any>; tz?: string; generatedAt?: string; merge?: { mergeable: number; blocked: number; accounts: number; upstreams: number; records?: number } | null };
