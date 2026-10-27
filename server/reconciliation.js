// 对账深模块：把窗口、上游取数、本站收费、快照和告警收敛在一个 Interface 后。
import { createHash } from "node:crypto";
import { isAccessTokenError } from "../lib/access-token-scopes.js";
import { stationDisplayName } from "../lib/overview-actions.js";
import {
  queryReconciliationMetadata,
  queryNewApiStatus,
  queryKeyReconciliationStat,
  queryOwnChannelRevenue,
  queryOwnLogSource,
  queryOwnLogSourceTotal,
  queryOwnUserChannelStat,
  OWN_CHANNEL_TEST_TOKEN_NAMES,
  queryOwnChannels,
  queryOwnLatestLog,
  queryOwnConsumeLog,
  queryAccountIdentity,
  unixSecondWindow,
} from "../lib/providers.js";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_CALCULATION_VERSION,
  RECONCILIATION_SETTLE_DELAY_MS,
  reconciliationIssueLabel,
  reconciliationIssue,
  fillIssueCopy,
  COVERAGE_QUESTION,
  COVERAGE_REQUIRED,
  INCOMPLETE_DAY_TEXT,
  RECONCILIATION_ISSUE_PRIORITY,
  isLiveReconciliationPreset,
  sameReconciliationWindow,
} from "../lib/reconciliation-contract.js";
import { OWN_STATION_UNSET, UPSTREAM_GONE } from "../lib/format.js";
import { CONSUME_LOG_LOOKBACK_MS, applyConsumeLogReading, consumeLogOffOverlap, consumeLogStillOff } from "../lib/consume-log.js";
import { errorText, ownStationErrorCode } from "../lib/error-copy.js";
import { ReconciliationRepository, copySegment, reconciliationOwnerRuleState, reconciliationOwnerScope, normalizeConfirmedHistoryOptions } from "./reconciliation-repository.js";
import { workflowAction } from "../lib/workflow-actions.js";
import { markOptionUnreadableSeen, notifyOptionUnreadable, notifyReconciliationHealth, optionAlertKey } from "./reconciliation-notify.js";
import { OwnLogStore } from "./own-log-store.js";
import { createOwnLogIngest } from "./own-log-ingest.js";
import { createUpstreamPricing } from "./upstream-pricing.js";
import { reconciliationScopeFingerprint, reconciliationSnapshotRecordIdentity, reconciliationRuleEvidence } from "../lib/reconciliation-snapshot.js";
import { connectionDiagnostic } from "../lib/connection-test.js";
import { applyScopePolicy, billingProviderOf, canonicalBillingKey, completedBillingDayWindow, scopePolicyIssues, reconciliationBillingSchedule, isCompletedBillingWindow,
  isScopedBillingPolicy, reconciliationAccountingStart, startOfBillingDay, scopeRecalculatedInWindow } from "../lib/reconciliation-scope-policy.js";
import { ledgerDecimal, ledgerEntryForSettlement, ledgerReference, ledgerSettlement } from "../lib/reconciliation-ledger.js";
import { splitWindowByDays, stitchChannelRevenue } from "../lib/reconciliation-stitch.js";
import { SETTLE_LOOKBACK_MAX_PER_ROUND, SETTLE_LOOKBACK_MS, SETTLE_MAX_AUTO_ATTEMPTS, RESETTLE_KEPT_REASONS, isSettleableWindow, resettleShrunkInfo, sameShrunkAfter, isSettledAt, reasonKindOf, settleRetryDelayMs, settlementOutcome, settlementPrecheck, settlementRecheck } from "../lib/reconciliation-settlement.js";
import { stationBusinessVersion } from "../db/store.js";
import { keyPiecesOf, segmentKeyTokens, sumKeyStats } from "../lib/reconciliation-keys.js";
import { onboardingBaseUrl, normalizeCoverageDeclaration, ACCOUNT_TYPE_VALUES } from "../lib/channel-onboarding.js";
import { deriveKnownChannelCoverage, summarizeReconciliationWindowGroups, reconciliationResultActions, reconciliationDisplayStatus,
  summarizeUnaccountedUpstream, attributeAuthorizationRules, reconciliationDisplayCurrency, fixedOffProfitStations } from "../lib/reconciliation-view.js";
import { costBasisOf, isConfiguredRate, rateSnapshotOf, ratesFor } from "../lib/profit.js";
import { billDayOf, businessTimeZone, canonicalTimeZone, checkTimeZone, dayKeyInTz, dayStartInTz, isDayStartInTz, sameTimeZone, shiftDayLabel, shiftedDayStartInTz } from "../lib/business-time.js";
import { ownCache, readOwnAdminDirectory, resoldAdminKeysOf, selectCostUpstreams, stationUsageCost as defaultStationUsageCost } from "./own-helpers.js";
import { createBillingCapabilityStorage } from "../lib/billing-capability-storage.js";
import { keyAgentConfigOf } from "./key-agent.js";
import { identifyChannelsCached, keyAgentReachability } from "./key-agent-identify.js";
import { detectGroupSplit, detectGroupMerges, planSegmentChanges, safeLastSeenAt, keyAgentExceptionIssueOf } from "./key-agent-resegment.js";

export { reconciliationScopeFingerprint } from "../lib/reconciliation-snapshot.js";

const DAY_MS = 86400000;
// 回看几天：昨天往前到结束满 7 天为止（lib/reconciliation-settlement.js 的 SETTLE_LOOKBACK_MS）
const SETTLE_LOOKBACK_DAYS = Math.round(SETTLE_LOOKBACK_MS / DAY_MS);
const MAX_CONCURRENT_RULES = 6;
// 回看时碰到这一类才不再给同一上游取别的日子（方案 6.4：限流 429、5xx、超时、连不上）：读账单时上游报的原始码，
// 限流和 5xx 是 UPSTREAM_REQUEST_FAILED，连不上、超时是 NETWORK_UNREACHABLE，这是上游这一刻整体读不到的信号。
// 原始码在出错的地方（读账单）记进上游一侧的问题 issue.cause，到判断这一层也看得到（C2a 里只剩被统一收成的 UPSTREAM_DATA_UNAVAILABLE，
// 「这条规则没配出完整分段」之类和限流无关的也会被算进去）；别的原因（WAITING_FOR_BILL 这天的账单还没读全、要人处理、
// 改绑定之前还没固定、没有分段……）只挡这一天，不连累同一上游别的绑定（审核 C2a 低-4）
const UPSTREAM_LOOKBACK_SKIP_CAUSES = new Set(["UPSTREAM_REQUEST_FAILED", "NETWORK_UNREACHABLE"]);
const upstreamUnavailable = (result) => (result?.health?.issues || []).some((issue) => issue?.side === "upstream" && UPSTREAM_LOOKBACK_SKIP_CAUSES.has(issue?.cause));

// 本地重判后原因没变（还是同一个要人处理的原因、同一代配置、同一个变成需处理的时刻）：状态行不用写
function recheckUnchanged(state, next) {
  if (!state || next?.op !== "manual" || state.manualReason == null || next.reason !== state.manualReason) return false;
  return (next.sourceVersion ?? null) === (state.sourceVersion ?? null) && (Number(next.attempts) || 0) === (Number(state.attempts) || 0)
    && (next.manualSince ?? null) === (state.manualSince ?? null) && JSON.stringify(next.detail ?? null) === JSON.stringify(state.detail ?? null);
}

// 绑定按哪个时区算一天：新建时用传入的，没传用业务时区（BUSINESS_TIME_ZONE，缺省上海）；建好以后不能改——
// 没传沿用原值，传了别的时区报 TIMEZONE_IMMUTABLE（别名算同一个，存的还是原来的写法）。不合法的报 TIMEZONE_INVALID。
// 建、改、追加渠道、预览、渠道绑定都经这里定时区，不各自缺省成上海。
export function ruleTimezoneFor(existing, requested) {
  if (!existing?.timezone) return checkTimeZone(requested, businessTimeZone());
  if (requested == null || requested === "") return existing.timezone;
  if (!sameTimeZone(checkTimeZone(requested), existing.timezone)) {
    throw codedError("TIMEZONE_IMMUTABLE", "绑定建好以后，按哪个时区算一天不能改；要换的话，解除绑定后重新绑定");
  }
  return existing.timezone;
}

// timezone 是要改的那条绑定现在的时区（新建时不传）
export function normalizeReconciliationScopeIntent(kind, targetRuleId, input, { timezone, enabled } = {}) {
  if (!input?.coverageDeclaration) throw codedError("INVALID_REQUEST", COVERAGE_REQUIRED);
  let coverageDeclaration;
  try { coverageDeclaration = normalizeCoverageDeclaration(input.coverageDeclaration); }
  catch { throw codedError("INVALID_REQUEST", COVERAGE_REQUIRED); }
  let zone;
  try { zone = ruleTimezoneFor(timezone ? { timezone } : null, input?.timezone); }
  catch (error) { throw error.code === "TIMEZONE_IMMUTABLE" ? error : codedError("INVALID_REQUEST", "时区不对"); }
  const semantic = { tokenId: finite(input?.tokenId),
    salesChannelIds: [...new Set((Array.isArray(input?.salesChannelIds) ? input.salesChannelIds : []).map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b),
    timezone: zone, enabled: input?.enabled == null ? enabled ?? true : input.enabled !== false,
    coverageDeclaration };
  if (!Number.isSafeInteger(semantic.tokenId) || semantic.tokenId <= 0 || !semantic.salesChannelIds.length
    || input.salesChannelIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
    || input.enabled != null && typeof input.enabled !== "boolean" || kind === "replace" && !input.upstreamStationId) {
    throw codedError("INVALID_REQUEST", "要改的绑定内容不对");
  }
  return { kind, targetRuleId: targetRuleId || null, existingEnabled: targetRuleId ? enabled ?? true : null,
    ...(kind === "replace" ? { normalizedPutIntent: { upstreamStationId: String(input?.upstreamStationId || ""), ...semantic } }
      : { normalizedAppendIntent: semantic }) };
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
const TODAY_TTL_MS = 60000;
const QUERY_TTL_MS = 60000;
const MAX_RESULT_CACHE_ENTRIES = 200;
// 账号级上游用量：已结束窗口不会再变，缓存久一些；页面最多等这么久，取不到先返回「读取中」。
const ACCOUNT_USAGE_TTL_MS = 10 * 60000;
const ACCOUNT_USAGE_WAIT_MS = 3000;
const ACCOUNT_USAGE_PENDING_MAX_MS = 2 * 60000;
const MAX_ACCOUNT_USAGE_ENTRIES = 200;
const STALE_SCOPE = Symbol("STALE_SCOPE");
const MAX_SCOPE_ATTEMPTS = 3;
// 轮询里没变的东西多久才重写一次：渠道状态的观测时刻、「今天」观测快照（计划 P1a）
const UNCHANGED_REWRITE_MS = 10 * 60000;
// 判断自营站点有没有新的消费（计划 P1a，审核第二轮）：查的起点不每轮挪，落后「最新一条 − 120 秒」超过 10 分钟才挪一次，
// 这样每次数条数的范围最多约 14 分钟（往前 720 秒再加一轮间隔）；晚写进去、时刻不早于起点的日志都数得到。还没读到过日志的从第一次查的时候往前 2 小时起
const OWN_LOG_LOOKBACK_SEC = 120;
const OWN_LOG_ANCHOR_LAG_SEC = 10 * 60;
const OWN_LOG_FIRST_LOOKBACK_SEC = 2 * 3600;
// 上游的分组和 Key 目录、账号身份和 /api/status 多久重读一次（计划 P1b，用户 10-25 选的 B）。
// 轮询按这个读；出了异常的上游下一轮马上全部重读（staleMetadata）；页面「刷新」照旧强制重读
const CATALOGUE_TTL_MS = 5 * 60000;
const IDENTITY_TTL_MS = 30 * 60000;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function commonBillingTimezone(window, sides) {
  const timezone = canonicalTimeZone(window.timezone);
  // 没有任何账单需要取（窗口整段在核算起点之前），也就没有待证明的日界线。
  const verified = sides.every((side) => side?.billingTimezone?.state === "verified"
    && side.billingTimezone.timezone === timezone && sameReconciliationWindow(side.window, side.requestedWindow || window, { timezone: false }));
  return { state: verified ? "verified" : "unverified", timezone,
    ...(verified ? {} : { reason: "BILLING_TIMEZONE_UNVERIFIED" }) };
}

export const RECONCILIATION_PRESETS = Object.freeze(["today", "yesterday", "7d", "month", "custom"]);

export function resolveReconciliationWindow(input = {}, now = Date.now()) {
  const timezone = checkTimeZone(input.timezone);
  const preset = RECONCILIATION_PRESETS.includes(input.preset) ? input.preset : "yesterday";
  let startMs;
  let endMs;
  // 所有窗口都是规则时区下的半开区间 [startMs, endMs)，结束点不晚于当前时刻。两侧都按秒级日志统计取数，
  // 把窗口延伸到未来取不到更多账单，只会把未来时刻写进快照和界面；晚落库的日志由下一轮刷新补齐。
  if (preset === "custom") {
    startMs = finite(input.startMs);
    endMs = finite(input.endMs);
    if (startMs == null || endMs == null || startMs >= endMs) throw codedError("TIME_RANGE_INVALID", "时间范围不对");
    if (endMs > now) throw codedError("TIME_RANGE_FUTURE", "不能选以后的时间");
    if (endMs - startMs > 31 * DAY_MS) throw codedError("TIME_RANGE_TOO_LONG", "一次最多查 31 天");
  } else {
    const dayStart = shiftedDayStartInTz(now, 0, timezone);
    if (preset === "yesterday") {
      startMs = shiftedDayStartInTz(now, -1, timezone);
      endMs = dayStart;
    } else if (preset === "7d") {
      startMs = shiftedDayStartInTz(now, -6, timezone);
      endMs = now;
    } else if (preset === "month") {
      // 本月从当地 1 日零点起；夏令时切换的月份可能比 31 天多一小时，所以 31 天上限只管自定义。
      startMs = dayStartInTz(`${dayKeyInTz(now, timezone).slice(0, 8)}01`, timezone);
      endMs = now;
    } else {
      startMs = dayStart;
      endMs = now;
    }
  }
  return { preset, timezone, startMs: Math.floor(startMs), endMs: Math.floor(endMs) };
}

function publicStation(station) {
  return station ? { id: station.id, name: station.name, type: station.type, monitorEnabled: station.monitorEnabled !== false,
    cnyPerUsd: station.cnyPerUsd ?? null, costBasis: costBasisOf(station) } : null;
}

function publicMetadata(metadata) {
  return {
    quotaPerUnit: metadata.quotaPerUnit,
    version: metadata.version,
    groups: metadata.groups,
    platform: metadata.platform,
    capability: metadata.capability,
    billingTimezone: metadata.billingTimezone,
    tokens: metadata.tokens.map((token) => ({
      id: token.id,
      name: token.name,
      status: token.status,
      group: token.group,
      crossGroupRetry: token.crossGroupRetry,
    })),
  };
}

// extra：随这条问题带出去的事实（页面写文案要用），比如 K2b 的 sinceMs（从哪一刻起算不出，文案里的 {time}）
function health(code, detail = "", extra = {}) {
  return { code, label: reconciliationIssueLabel(code), detail, stale: code === "STALE", ...extra };
}

// 报错原文和 health.detail 用 §5 的问题文案（lib/reconciliation-contract.js），不另写一套；界面按 code 取标题和说明。
function issueText(code, params = {}) {
  const issue = reconciliationIssue(code);
  return fillIssueCopy(issue.kind === "action" ? issue.title : issue.hint, "", params) || reconciliationIssueLabel(code);
}

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function ruleNotFound() {
  return codedError("RULE_NOT_FOUND", "这条绑定已解除");
}

function staleScope() {
  return codedError("STALE_SCOPE", "这条已经变了，刷新后再看");
}

// 绑定时 Key 不能用的几种情况：报错和这条绑定的问题说明共用 lib/error-copy.js 里的那一句。
const KEY_DISABLED_TEXT = errorText({ code: "KEY_DISABLED" });
const KEY_NAME_AMBIGUOUS_TEXT = errorText({ code: "TOKEN_NAME_AMBIGUOUS" });
const KEY_GROUP_TEXT = errorText({ code: "KEY_GROUP_UNSUPPORTED" });

// 渠道同时绑了两把 Key：说出渠道名（取不到名字时说渠道编号），冲突明细留在 error.conflicts。
function channelConflict(conflicts, channels = []) {
  const names = [...new Set(conflicts.map((item) => channels.find((channel) => Number(channel.id) === Number(item.channelId))?.name
    || `渠道 #${item.channelId}`))];
  return codedError("CHANNEL_CONFLICT", issueText("DUPLICATE_CHANNEL_ASSIGNMENT", { channel: names.join("」「") }), { conflicts });
}

// 对账接口的报错：表里的码按 { error: 原文, code } 和对应状态返回，界面按 code 归类（lib/error-copy.js）。
// 表外的（没有 code，或数据库、网络这类底层错误码）返回 null，交给 withAuth 记日志、按 500 返回。
const ERROR_STATUS = Object.freeze(Object.fromEntries([
  [400, ["INVALID_REQUEST", "TIMEZONE_INVALID", "TIMEZONE_IMMUTABLE", "TIME_RANGE_INVALID", "TIME_RANGE_FUTURE", "TIME_RANGE_TOO_LONG", "OWN_STATION_UNSET", "KEY_REQUIRED",
    "CHANNEL_REQUIRED", "TRANSITION_TIME_OUT_OF_RANGE", "KEY_DISABLED", "KEY_GROUP_UNSUPPORTED", "KEY_INVALID_OR_DENIED", "TOKEN_NAME_AMBIGUOUS", "RULE_IDENTITY_IMMUTABLE", "RESOURCE_CHANGED"]],
  [404, ["RULE_NOT_FOUND", "UPSTREAM_NOT_FOUND"]],
  [409, ["PREVIEW_BASIS_CHANGED", "PREVIEW_REQUIRED", "EFFECTIVE_PREVIEW_CHANGED", "CHANNEL_CONFLICT", "CANONICAL_KEY_CONFLICT", "SOURCE_BINDING_UNCONFIRMED",
    "LEGACY_IDENTITY_UNVERIFIED", "BILLING_CAPABILITY_UNVERIFIED", "COST_OWNER_UNVERIFIED", "RULE_OWN_STATION_CONFLICT", "RULE_DISABLED", "STALE_SCOPE",
    "AUTHORIZATION_CHANGED", "CHANNEL_SOURCE_CHANGED"]],
  [503, ["HISTORY_UNAVAILABLE", "KEY_METADATA_UNAVAILABLE", "KEY_PROBE_UNAVAILABLE", "PERSISTENCE_FAILED", "OWN_BILLING_UNAVAILABLE"]],
].flatMap(([status, codes]) => codes.map((code) => [code, status]))));
export function reconciliationErrorResponse(error) {
  const status = ERROR_STATUS[error?.code];
  if (!status) return null;
  return { status, body: { error: error.message, code: error.code, ...(status === 503 ? { retryable: true } : {}),
    ...(error.nextPreview ? { nextPreview: error.nextPreview } : {}) } };
}

// 站点编辑会原地改写 station 对象：缓存带上凭据指纹，换了地址、令牌或用户后不再复用旧凭据读到的数据。
function credentialFingerprint(station) {
  const passwordMode = station.type === "sub2api-password" || station.authMode === "password";
  const fields = [String(station.baseUrl || ""), passwordMode ? "" : String(station.accessToken || ""), String(station.userId || "")];
  fields.push(stationBusinessVersion(station));
  if (station.type?.startsWith("sub2api")) fields.push(station.type, station.authMode || "", station.authVersion ?? null,
    passwordMode ? "" : String(station.apiKey || ""),
    passwordMode ? String(station.email || "") : "", passwordMode ? String(station.password || "") : "");
  return createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");
}

function sourceCredentialFingerprint(upstream, own) {
  const stationSource = (station) => station ? [station.id, station.type, !!station.isOwn, credentialFingerprint(station)] : null;
  return createHash("sha256")
    .update(JSON.stringify([stationSource(upstream), stationSource(own)]))
    .digest("hex");
}

function sourceScopeFingerprint(ruleScopeFingerprint, sourceCredential) {
  // 保留旧快照作为证据；站点地址、PAT 或身份变化后不能拿旧账单兜底新来源。
  return createHash("sha256").update(`${ruleScopeFingerprint}:${sourceCredential}`).digest("hex").slice(0, 24);
}

function ownSourceFor(station, identity) {
  const baseUrl = onboardingBaseUrl(identity.baseUrl);
  return { stationId: station.id, provider: "newapi", baseUrl, accountId: String(identity.accountId),
    namespaceKey: createHash("sha256").update(JSON.stringify(["newapi", baseUrl, String(identity.accountId)])).digest("hex") };
}

// 本轮还不能核算、也不代表任何异常的结果：不写快照、不告警、不缓存，下一轮刷新再取。
function pendingResult(rule, window, detail, { currentSegment = null, transitionSegments = [], issues = [] } = {}) {
  return {
    rule,
    window,
    requestedWindow: window,
    lastSuccessfulWindow: null,
    currentSegment,
    segments: [],
    transitionSegments,
    upstream: null,
    downstream: null,
    calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
    health: { ...health("PENDING", detail), issues },
    generatedAt: new Date().toISOString(),
  };
}

function intersectSegment(window, segment) {
  const startMs = Math.max(window.startMs, segment.effectiveFrom);
  const endMs = Math.min(window.endMs, segment.effectiveTo ?? window.endMs);
  return startMs < endMs ? { ...window, startMs, endMs } : null;
}

// 按 Key 整体取数的关联从核算起点开始计账。起点是开始那天的 0 点（New API、Sub2API 一样，见 reconciliationAccountingStart）。
// 已解除的绑定补结解除前的日子（C3）：New API 解除当天金额只算到解除那一刻；Sub2API 只能按整天读，解除当天不算（C③）
export function accountingWindow(rule, window, platform = null) {
  const start = reconciliationAccountingStart(rule);
  const archivedAt = rule.archivedAtMs == null ? NaN : Number(rule.archivedAtMs);
  if (start == null && !Number.isFinite(archivedAt)) return window;
  const clipStart = Math.max(window.startMs, start ?? window.startMs);
  const clipEnd = Number.isFinite(archivedAt)
    ? Math.min(window.endMs, (rule.provider ?? platform) === "sub2api" ? startOfBillingDay(archivedAt, window.timezone) : archivedAt) : window.endMs;
  return clipStart < clipEnd ? { ...window, startMs: clipStart, endMs: clipEnd } : null;
}

// 上游一侧的窗口：Sub2API 只能按整天读账单，所以从起点那天的 0 点起（当天换绑的下限只管本站收入，收入按秒切得开）；
// 这样当天从 New API 换绑到 Sub2API 时，收入从旧绑定解除那一刻起算只算一次，上游成本是新 Key 全天的（绑上以前一般没有用量）。其余和 accountingWindow 一样
export function accountingUpstreamWindow(rule, window, platform = null) {
  const down = accountingWindow(rule, window, platform);
  if (!down || (rule.provider ?? platform) !== "sub2api") return down;
  const start = reconciliationAccountingStart(rule);
  const wholeDay = start == null ? down.startMs : startOfBillingDay(start, window.timezone);
  const startMs = Math.max(window.startMs, wholeDay);
  return startMs < down.endMs ? { ...down, startMs } : down;
}

// 已解除的绑定只有锚定过、按整体取数的才补结（解除前这把 Key 只有它在用）；旧版（legacy）规则和没锚定的不回看
const archivedSettleable = (rule) => !!rule.archivedAt && !!rule.canonicalKey && isScopedBillingPolicy(rule.billingPolicy);

function channelState(status) {
  if (Number(status) === 1) return "enabled";
  if (Number(status) === 2) return "manual_disabled";
  if (Number(status) === 3) return "auto_disabled";
  return "unknown";
}

// 多天窗口按天跳过关着的日子以后，同一个真分段被切成几块（id「段号~序号」）：取完数合回一项——金额、额度相加，窗口取首尾，问题合并；
// 快照按真分段写、页面的「倍率变化」表也只有真分段（审核 R2 第二轮 中-2）。没切过的原样返回
function foldSplitSegments(pieces, costBasis) {
  const groups = new Map();
  for (const piece of pieces) { const base = String(piece.id).split("~")[0]; if (!groups.has(base)) groups.set(base, []); groups.get(base).push(piece); }
  if ([...groups.values()].every((list) => list.length === 1)) return pieces;
  const sumOrNull = (list, pick) => (list.some((item) => pick(item) == null) ? null : list.reduce((total, item) => total + pick(item), 0));
  const sumKnown = (list, pick) => (list.every((item) => pick(item) == null) ? null : list.reduce((total, item) => total + (pick(item) ?? 0), 0));
  const span = (first, last, window) => ({ ...first, startMs: first?.startMs ?? window.startMs, endMs: last?.endMs ?? window.endMs });
  const foldSide = (list, name) => {
    const sides = list.map((item) => item[name]), first = sides[0], last = sides.at(-1);
    const complete = sides.every((side) => side.state === "complete");
    return { ...first,
      state: complete ? "complete" : sides.some((side) => side.knownAmountUsd != null) ? "partial" : sides.some((side) => side.state === "pending") ? "pending" : "unavailable",
      quotaUnits: sumOrNull(sides, (side) => side.quotaUnits), amountUsd: complete ? sumOrNull(sides, (side) => side.amountUsd) : null, knownAmountUsd: sumKnown(sides, (side) => side.knownAmountUsd),
      successfulCount: sides.reduce((total, side) => total + (side.successfulCount ?? 0), 0), expectedCount: sides.reduce((total, side) => total + (side.expectedCount ?? 0), 0),
      observedAt: Math.max(...sides.map((side) => Number(side.observedAt) || 0)),
      window: span(first.window, last.window, list[0].window), requestedWindow: span(first.requestedWindow, last.requestedWindow, list[0].window) };
  };
  return [...groups.entries()].map(([base, list]) => {
    if (list.length === 1) return list[0];
    const first = list[0], last = list.at(-1);
    const upstream = foldSide(list, "upstream"), downstream = foldSide(list, "downstream");
    const channelIds = [...new Set(list.flatMap((item) => (item.downstream.channels || []).map((channel) => channel.channelId)))];
    downstream.channels = channelIds.map((channelId) => {
      const rows = list.map((item) => (item.downstream.channels || []).find((channel) => channel.channelId === channelId)).filter(Boolean);
      const complete = rows.length === list.length && rows.every((row) => row.billingState === "complete");
      return { ...rows[0], billingState: complete ? "complete" : rows.some((row) => row.knownAmountUsd != null || row.amountUsd != null) ? "partial" : rows[0].billingState,
        quotaUnits: sumOrNull(rows, (row) => row.quotaUnits), amountUsd: complete ? sumOrNull(rows, (row) => row.amountUsd) : null, knownAmountUsd: sumKnown(rows, (row) => row.knownAmountUsd ?? row.amountUsd) };
    });
    downstream.adminUsageQuotaUnits = list.reduce((total, item) => total + (item.downstream.adminUsageQuotaUnits ?? 0), 0);
    downstream.adminUsageAmountUsd = list.some((item) => item.downstream.adminUsageAmountUsd == null) ? null : list.reduce((total, item) => total + item.downstream.adminUsageAmountUsd, 0);
    downstream.adminUsageDays = list.reduce((acc, item) => ({ deducted: acc.deducted + (item.downstream.adminUsageDays?.deducted ?? 1), undeducted: acc.undeducted + (item.downstream.adminUsageDays?.undeducted ?? 0) }), { deducted: 0, undeducted: 0 });
    const issues = [...new Map(list.flatMap((item) => item.health?.issues || []).map((issue) => [`${issue.code}|${issue.channelId ?? ""}`, issue])).values()];
    const upstreamUsd = upstream.state === "complete" ? upstream.amountUsd : null, downstreamUsd = downstream.state === "complete" ? downstream.amountUsd : null;
    return { ...first, id: base, window: { ...first.window, startMs: first.window.startMs, endMs: last.window.endMs }, upstream, downstream,
      calculation: calculationFromAmounts(costBasis === "fixed" ? 0 : upstreamUsd, downstreamUsd, issues), health: healthWithIssues(issues), pieces: list.length };
  });
}

function healthWithIssues(issues) {
  const first = RECONCILIATION_ISSUE_PRIORITY.find((code) => issues.some((issue) => !issue.reference && issue.code === code));
  const base = first ? health(first, issues.find((issue) => !issue.reference && issue.code === first)?.detail || "") : health("READY");
  return { ...base, issues };
}

function storageFailedResult(rule, window, code) {
  const observedAt = Date.now();
  const channels = rule.channels.map((channel) => ({ ...channel, billingState: "unavailable", quotaUnits: null, amountUsd: null, knownAmountUsd: null }));
  const issue = { code, scope: code === "HISTORY_UNAVAILABLE" ? "history" : code === "PERSISTENCE_FAILED" ? "persistence" : "upstream", detail: issueText(code), observedAt };
  return {
    rule, window, requestedWindow: window, lastSuccessfulWindow: null, currentSegment: null, segments: [], transitionSegments: [],
    upstream: { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: 1, observedAt, window },
    downstream: { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: rule.channels.length, billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION, observedAt, window, channels },
    calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
    health: { ...health(code, issue.detail), issues: [issue] }, generatedAt: new Date().toISOString(),
  };
}

function snapshotReference(record) {
  return {
    generatedAt: record.generatedAt,
    window: record.result.lastSuccessfulWindow || record.result.window,
    upstream: record.result.upstream,
    downstream: record.result.downstream,
    calculation: record.result.calculation,
    health: record.result.health,
  };
}

// station：读的是哪个上游，令牌作废、少了权限时说明里要写上游名（用语规范 §5.2）；missingScope 是 New API 说少了的那一项
function toErrorHealth(err, own = false, station = null) {
  const code = String(err?.code || "");
  // 令牌作废、少了权限：要人换令牌，不是「上游拒绝读取这把 Key」，也不是等 7 天的读取类（own-revenue-plan 第三节）
  if (!own && isAccessTokenError(code)) {
    return { ...health(code, issueText(code)), side: "upstream", stationName: station ? stationDisplayName(station) : "", ...(err?.scope ? { missingScope: err.scope } : {}) };
  }
  const issue = own ? "OWN_BILLING_UNAVAILABLE" : code === "UPSTREAM_AUTH_DENIED" ? "KEY_INVALID_OR_DENIED"
    : code === "UPSTREAM_FEATURE_UNSUPPORTED" ? "UPSTREAM_FEATURE_UNSUPPORTED" : "UPSTREAM_DATA_UNAVAILABLE";
  return health(issue, issueText(issue));
}

// 轮询沿用了不久前的身份（这一轮没现读）时上游拒绝（New API），或者读账单时核对出账号换了（Sub2API）：
// 不能马上说「上游拒绝读取这把 Key」「上游这天的用量记录一直读不到」并推送。这一轮先当成还在读取，
// 上游已记进 staleMetadata，下一轮全部重读身份以后再定。连不上、超时这类不在此列，照常报
const REUSED_IDENTITY_SUSPECT = new Set(["UPSTREAM_AUTH_DENIED", "UPSTREAM_IDENTITY_CHANGED"]);
function upstreamErrorHealth(err, resource) {
  return REUSED_IDENTITY_SUSPECT.has(String(err?.code || "")) && resource?.identityReused ? health("PENDING", issueText("PENDING")) : toErrorHealth(err, false, resource?.station);
}

const CALCULATION_BLOCKERS = new Set([
  "ACCESS_TOKEN_LEGACY_RETIRED",
  "ACCESS_TOKEN_SCOPE_DENIED",
  "OWN_CONSUME_LOG_OFF",
  "OWN_CONSUME_LOG_GAP",
  "UPSTREAM_FEATURE_UNSUPPORTED",
  "KEY_INVALID_OR_DENIED",
  "UPSTREAM_DATA_UNAVAILABLE",
  "OWN_BILLING_UNAVAILABLE",
  "OWN_OPTION_UNREADABLE",
  "OWN_FLOW_INCOMPLETE",
  "UPSTREAM_EMPTY_WITH_SALES",
  "SOURCE_BINDING_UNCONFIRMED",
  "LEGACY_IDENTITY_UNVERIFIED",
  "CANONICAL_KEY_CONFLICT",
  "COST_OWNER_UNVERIFIED",
  "COST_COVERAGE_UNKNOWN",
  "BILLING_TIMEZONE_UNVERIFIED",
  "BILLING_WINDOW_MISMATCH",
  "DUPLICATE_CHANNEL_ASSIGNMENT",
  "WAITING_FOR_BILL",
  "UPSTREAM_CAPABILITY_UNVERIFIED",
]);

// reference 问题只作参考（如固定采购上游的 Key 账单不全），不挡毛利。
// 快照内容的指纹：去掉每轮都会变的各种时刻和窗口终点（「今天」的窗口终点就是现在），只看金额、问题、分段这些
const SNAPSHOT_VOLATILE_KEYS = new Set(["generatedAt", "resultGeneratedAt", "observedAt", "stateObservedAt", "latestLogAtMs", "endMs"]);
function snapshotContentFingerprint(rows) {
  return createHash("sha256").update(JSON.stringify(rows, (key, value) => SNAPSHOT_VOLATILE_KEYS.has(key) ? undefined : value)).digest("hex");
}

function calculationFromAmounts(upstreamUsd, downstreamUsd, issues = []) {
  const differenceUsd = upstreamUsd == null || downstreamUsd == null ? null : downstreamUsd - upstreamUsd;
  const confirmed = differenceUsd != null && !issues.some((issue) => !issue.reference && CALCULATION_BLOCKERS.has(issue.code));
  return {
    differenceUsd,
    profitUsd: confirmed ? differenceUsd : null,
    riskDifferenceUsd: confirmed ? null : differenceUsd,
    marginRate: confirmed && downstreamUsd > 0 ? differenceUsd / downstreamUsd : null,
  };
}

function sourceSnapshot(token, metadata, upstream, downstream) {
  return {
    calculationVersion: RECONCILIATION_CALCULATION_VERSION,
    billingSource: RECONCILIATION_BILLING_SOURCE,
    upstream: {
      tokenId: token.id,
      tokenName: token.name,
      group: token.group,
      ratio: metadata.groups?.[token.group]?.ratio ?? null,
      status: token.status,
      latestLogAtMs: upstream?.latestLogAtMs ?? null,
    },
    downstream: {
      calculationVersion: RECONCILIATION_CALCULATION_VERSION,
      billingSource: RECONCILIATION_BILLING_SOURCE,
      billingCoverage: downstream?.billingCoverage ?? downstream?.coverage ?? null,
      coverage: downstream?.coverage ?? null,
      channels: downstream?.channels?.map((channel) => ({
        channelId: channel.channelId,
        quotaUnits: channel.quotaUnits,
        amountUsd: channel.amountUsd,
      })) || [],
    },
  };
}

// repository 可注入：测试用内存实现替代 MySQL，生产默认走 rt.pool。stationUsageCost 是账号级上游用量取数，测试可替换。
// 回看（计划 C2a 2.2）的几个参数，测试里注入：
//   lookbackBudget：每轮最多回看几天（昨天不占），缺省 max(1, ⌈在用绑定数 ÷ 2⌉），再和 SETTLE_LOOKBACK_MAX_PER_ROUND（15）取小的；
//   lookbackTimeMs：每轮回看最多花多久，缺省 min(20 秒, 刷新间隔的三分之一)，已经发出去的那一天照常做完；
//   lookbackDelayMs：启动后等多久才开始回看（今天、昨天照常），缺省随机 1–5 分钟，几个进程同时重启时不会一起打上游。
export function createReconciliationModule(rt, { repository = new ReconciliationRepository(rt.pool), stationUsageCost = defaultStationUsageCost,
  lookbackBudget = null, lookbackTimeMs = null, lookbackDelayMs = 60000 + Math.floor(Math.random() * 4 * 60000),
  // 自营站点整站日志的小时桶（应付成本 V1-a）：测试传内存实现；ownLogIngest: false 关掉整站读（只在测试里）
  ownLogStore = null, ownLogIngest = true } = {}) {
  const ownLog = createOwnLogIngest(rt, { store: ownLogStore || (rt._ownLogStore ||= new OwnLogStore(rt.pool)), log: (...args) => console.debug(...args) });
  const upstreamPricing = (rt._upstreamPricing ||= createUpstreamPricing(rt));
  const resultCache = (rt._reconciliationResultCache ||= new Map());
  const inflight = (rt._reconciliationInflight ||= new Map());
  const metadataCache = (rt._reconciliationMetadataCache ||= new Map());
  const identityCache = (rt._reconciliationIdentityCache ||= new Map());
  const ownChannelsCache = (rt._reconciliationOwnChannelsCache ||= new Map());
  const ownChannelsRequests = (rt._reconciliationOwnChannelsRequests ||= new Map());
  const ruleGenerations = (rt._reconciliationRuleGenerations ||= new Map());
  // 回看从什么时候起可以开始（启动后等一会儿）；上一次清理结账状态表的时刻
  const lookbackFrom = (rt._reconciliationLookbackFrom ??= Date.now() + lookbackDelayMs);
  // 要人处理的日子本地重判过、原因没变时不写状态行：下次重判的时刻单独记在这里（key：绑定|日期），重启以后最多多判一次（计划 C2b，审核 C2a 低-2 后一半）
  const recheckAt = (rt._reconciliationRecheckAt ||= new Map());
  // 改过切换时间的重结请求不放在内存里：按天存在结账状态表（resettle_requested_at_ms），和改时间在同一个事务里写，重启也不丢（计划 C2b）
  // 轮询省请求和写入（计划 P1a）：
  //   ownActivity：每个自营站点上一轮查「全站有没有新的消费」的时刻，和从什么时候起一直没有新的消费（quietFrom）
  //   ownRevenueCache：今天每段窗口最近一次读全的渠道收费（读到哪一刻为止），全站没有新的消费时直接沿用
  //   observationWrites：每条绑定最近一次写下的「今天」观测快照的内容指纹和写入时刻
  const ownActivity = (rt._reconciliationOwnActivity ||= new Map());
  const ownRevenueCache = (rt._reconciliationOwnRevenue ||= new Map());
  // ownExclusion：各自营站点每段窗口里管理员自用、渠道测试日志的累计（每个来源：按渠道的额度、翻到的最大编号），「今天」接着翻、结账用它对账
  const ownExclusionCache = (rt._reconciliationOwnExclusion ||= new Map());
  const observationWrites = (rt._reconciliationObservationWrites ||= new Map());
  // 出了异常、下一轮要把分组、Key 目录和身份全部重读的上游：Key 账单报错、渠道有收入而 Key 用量为 0、目录里找不到绑定的 Key
  const staleMetadata = (rt._reconciliationStaleMetadata ||= new Set());
  const verifiedRuleCredentials = new WeakMap();
  const previewReadFacts = new WeakMap();
  const ownIdentities = new Map();
  const accountUsageCache = new Map();
  // Sub2API 账单过滤能力的核验结果存进库里，重启后不必重新核验。能力变了就丢掉 Key 目录缓存，
  // 目录里带的能力状态和据此算出的成本归属版本随下一次查询更新，不必等 5 分钟缓存过期。
  // 存储适配器隐藏版本兼容：provider 只产生进程内摘要，数据库只接收 wrapped-v2 的 HMAC。
  const billingCapabilityStore = createBillingCapabilityStorage(repository, {
    key: () => rt.store.billingIdentityKey,
    onChange: () => metadataCache.clear(),
  });
  // 观测时锚定身份失败的原因：只读计算不锚定，沿用最近一次观测的结论。
  const identityIssues = new Map();
  const billingStation = (station) => station && ACCOUNT_TYPE_VALUES.includes(station.type) && !station.isOwn;
  const billingPanel = (station) => station && JSON.stringify([station.type.startsWith("sub2api") ? "sub2api" : "newapi", onboardingBaseUrl(station.baseUrl)]);
  function createPreviewReadContext() {
    const context = {};
    previewReadFacts.set(context, new Map());
    return context;
  }

  async function previewRead(context, station, kind, query) {
    const observations = previewReadFacts.get(context);
    if (!observations) return query();
    const version = stationBusinessVersion(station), key = JSON.stringify([station.id, version, kind]);
    if (!observations.has(key)) observations.set(key, Promise.resolve().then(query));
    const value = await observations.get(key);
    if (stationBusinessVersion(rt.store.get(station.id)) !== version) {
      throw codedError("PREVIEW_BASIS_CHANGED", "测试读取期间上游改过，请重新预览");
    }
    return structuredClone(value);
  }
  const billingSourceState = () => {
    const stations = rt.store.list({ includeUnmonitored: true, includeArchived: true })
      .filter((station) => ACCOUNT_TYPE_VALUES.includes(station.type))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { stationIds: stations.map((station) => station.id),
      // 财务配置同样决定缓存、在途结果和结账口径；编辑固定采购或汇率后必须重新核算未固定窗口。
      version: createHash("sha256").update(JSON.stringify([rt._reconciliationBillingGeneration || 0,
        stations.map((station) => [station.id, !!station.isOwn, station.archivedAt || null, credentialFingerprint(station),
          costBasisOf(station), rateSnapshotOf(station)])])).digest("hex") };
  };
  const sourceState = (rule) => {
    if (!Object.keys(rule.sourceBinding || {}).length && isScopedBillingPolicy(rule.billingPolicy)) return { version: "missing-confirmation", status: "unavailable" };
    if (!Object.keys(rule.sourceBinding || {}).length && !rule.ownSource) return { version: "legacy", status: "confirmed" };
    if (rt.onboardingSource?.inspectSource) return rt.onboardingSource.inspectSource(rule);
    const current = ownIdentities.get(rule.ownStationId);
    if (!Object.keys(rule.sourceBinding || {}).length && current?.resourceVersion === stationBusinessVersion(rt.store.get(rule.ownStationId))) {
      return { version: current.ownSource.namespaceKey, status: current.ownSource.namespaceKey === rule.ownSource?.namespaceKey ? "confirmed" : "review_required" };
    }
    return { version: "unavailable", status: "unavailable" };
  };
  const withSourceLock = (rule, write) => rt.onboardingSource?.withSourceLock ? rt.onboardingSource.withSourceLock(rule, write) : write();
  function serializeWrite(write) {
    const pending = (rt._reconciliationWriteChain || Promise.resolve()).then(write);
    rt._reconciliationWriteChain = pending.catch(() => {});
    return pending;
  }
  // 今天、近 7 天、本月截至取数时刻，endMs 每次都不同；缓存键只认起点，否则实时窗口的轮询永远命中不了缓存。
  const resultKey = (rule, window) => isLiveReconciliationPreset(window.preset)
    ? `${rule.id}:${window.preset}:${window.startMs}:${window.timezone}`
    : `${rule.id}:${window.preset}:${window.startMs}:${window.endMs}:${window.timezone}`;
  const resultTtl = (window) => isLiveReconciliationPreset(window.preset) ? TODAY_TTL_MS : QUERY_TTL_MS;

  // 一条绑定往前第 back 天（1 = 昨天）的窗口，按绑定自己的时区。昨天用 yesterday 预设，和页面、日报的「昨天」是同一个缓存键
  function completedDayWindow(rule, back, now) {
    if (back === 1) return resolveReconciliationWindow({ preset: "yesterday", timezone: rule.timezone }, now);
    return { preset: "custom", startMs: shiftedDayStartInTz(now, -back, rule.timezone), endMs: shiftedDayStartInTz(now, -back + 1, rule.timezone), timezone: rule.timezone };
  }

  // 结一天（计划 C2a）：轮询回看和手动「重新读取」共用。取数走 inspectRule(settle)；结成了状态行在记账的事务里删掉，
  // 结不成按 settlementOutcome 记进状态表。返回 inspectRule 的结果（取数出错时是一份读不到的结果）。
  async function settleDay(rule, window, { origin, ownerRegistry, state = null, trigger = null, confirmed = false, confirmedAfter = null }) {
    const billDate = billDayOf(window);
    let result;
    try {
      // 这一天有重结请求（改了切换时间）：不先读已固定的账，重取；请求时刻带进去，写账本的事务里按值比对才消费这条请求
      // confirmShrink：重算的数比已固定的少很多也照写，只有一种情况：这天的状态行就是 RESETTLE_SHRUNK、而且调用方明说确认了
      // （页面上的确认框，C3、E 做；在那之前没有人传，手动「重新读取」读出来少了一半多也先挡着）。
      // 其他日子（普通请求日、RESETTLE_TOO_OLD 的日子）手动读取也照样判，读出来少了一半多先挡下、记 RESETTLE_SHRUNK
      const confirmShrink = origin === "manual" && confirmed === true && state?.manualReason === "RESETTLE_SHRUNK";
      result = await inspectRule(rule.id, window, { mode: "settle", origin, ownerRegistry, resettleRequestedAt: state?.resettleRequestedAt ?? null, confirmShrink, confirmedAfter, trigger, priorState: state });
    } catch (err) {
      if (err?.code === "RULE_NOT_FOUND") throw err;
      const known = ["PERSISTENCE_FAILED", "HISTORY_UNAVAILABLE"].includes(err?.code);
      if (!known) {
        // 认不出的异常（程序出错、数据库错）：记日志；手动的照旧抛给页面，轮询的按读不到退避再试
        console.error("结账出错:", err?.message || String(err));
        if (origin === "manual") throw err;
      }
      result = storageFailedResult(rule, window, known ? err.code : "UPSTREAM_DATA_UNAVAILABLE");
    }
    if (result === STALE_SCOPE || !billDate) return result;
    // 重结的数比已固定的少很多：没写新版，记成「要人处理、不自动再试」的状态行（RESETTLE_SHRUNK），请求保留在行里
    const outcome = settlementOutcome({ window, result: result.resettleBlocked ? { health: { code: result.resettleBlocked, issues: [{ code: result.resettleBlocked, side: null, shrunk: result.resettleShrunk ?? null }] } } : result, now: Date.now(), state, origin, sourceVersion: ownerRegistry.billingSource.version });
    // 结成了（op: "delete"）：状态行已经在 inspectRule 写账本的同一个事务里删掉了（settlement 选项，见 saveSnapshotsForScope），
    // 这里不用再单独删一次——单独删一次是多发的一条 SQL（审核 C2a 低-1）
    try {
      // requestedAt：这一行取数前读到的重结请求时刻；行里的和它不一样（取数期间又来了新请求）就不盖
      // RESETTLE_TOO_OLD 的日子：手动读取没结成（上游出错、来源没确认……）不覆盖这一行，不然「太早、不自动重算」的标记丢了，
      // 轮询在请求提出 7 天内就会自动去重结 31 天以前的日子；读出来少了一半多（RESETTLE_SHRUNK）才换成那一条
      // 碰上这天关过收费记录（GAP，永远不固定）时不留 TOO_OLD 那一行：留着的话需处理里「要按新的时间算，就重新读取」永远去不掉（审核 R2 第二轮 低-1）
      const keepTooOld = state?.manualReason === "RESETTLE_TOO_OLD" && !result.resettleBlocked && result.health?.code !== "OWN_CONSUME_LOG_GAP";
      if (outcome.state && outcome.state.op !== "delete" && !keepTooOld) await repository.recordSettlementState(rule.id, billDate, outcome.state, Date.now(), { requestedAt: state?.resettleRequestedAt ?? null });
    } catch (err) { console.error("记结账状态失败:", err?.message || String(err)); }
    return result;
  }

  function clearRuleResults(ruleId) {
    ruleGenerations.set(ruleId, (ruleGenerations.get(ruleId) || 0) + 1);
    const prefix = `${ruleId}:`;
    for (const key of resultCache.keys()) {
      if (key.startsWith(prefix)) resultCache.delete(key);
    }
    for (const key of inflight.keys()) if (key.startsWith(prefix)) inflight.delete(key);
  }

  // 启用规则集合决定同一实际 Key 的成本归属；一条规则变更也会影响其它规则。
  function clearBillingResults(ruleId) {
    rt._reconciliationBillingGeneration = (rt._reconciliationBillingGeneration || 0) + 1;
    const ids = new Set(ruleGenerations.keys());
    if (ruleId) ids.add(ruleId);
    for (const key of [...resultCache.keys(), ...inflight.keys()]) ids.add(key.split(":")[0]);
    for (const id of ids) clearRuleResults(id);
  }

  // observed 标记结果是否来自观测：观测轮询只认观测写下的缓存，只读计算的结果不能让轮询跳过写库。
  function cacheResult(key, value, sourceCredential, billingCredential, observed = true) {
    const now = Date.now();
    const cached = resultCache.get(key);
    const previous = cached?.sourceCredential === sourceCredential && cached?.billingCredential === billingCredential ? cached.value : null;
    const previousEnd = Number(previous?.requestedWindow?.endMs ?? previous?.window?.endMs);
    const nextEnd = Number(value?.requestedWindow?.endMs ?? value?.window?.endMs);
    const newer = previous && (previousEnd > nextEnd || (previousEnd === nextEnd && String(previous.generatedAt) > String(value.generatedAt)));
    // 观测结果不让位给截止点更晚的只读结果：否则下一轮轮询找不到观测缓存，会重复取数。
    if (newer && !(observed && !cached.observed)) return;
    for (const [cachedKey, cached] of resultCache) if (cachedKey !== key && now - cached.at >= QUERY_TTL_MS) resultCache.delete(cachedKey);
    resultCache.set(key, { at: now, value, sourceCredential, billingCredential, observed });
    while (resultCache.size > MAX_RESULT_CACHE_ENTRIES) resultCache.delete(resultCache.keys().next().value);
  }

  // archived：这条绑定已经解除（补结解除前的日子，C3），按解除的那一条核对，不然都会判成「口径变了」
  async function hasCurrentScope(ruleId, scopeFingerprint, generation, archived = false) {
    if ((ruleGenerations.get(ruleId) || 0) !== generation) return false;
    const [currentRule, segments] = await Promise.all([repository.getRule(ruleId, { includeArchived: archived }), repository.listSegments(ruleId)]);
    return !!currentRule && reconciliationScopeFingerprint(currentRule, segments) === scopeFingerprint;
  }

  const ownStation = () => rt.store.list().find((station) => station.isOwn && station.type === "newapi") || null;
  const upstreamStation = (id) => rt.store.get(id) || null;
  const observationCredential = (rule, upstream, own) => {
    const source = sourceState(rule);
    if (source.version === "legacy" || !isScopedBillingPolicy(rule.billingPolicy) && !Object.keys(rule.sourceBinding || {}).length) return sourceCredentialFingerprint(upstream, own);
    return createHash("sha256").update(JSON.stringify([sourceCredentialFingerprint(upstream, own), source.version, source.status])).digest("hex");
  };
  const currentSourceCredential = (rule) => observationCredential(rule, upstreamStation(rule.upstreamStationId), upstreamStation(rule.ownStationId));
  const withObservationSourceLock = async (rule, sourceCredential, write, billingSource = null) => {
    const verifyAndWrite = async () => currentSourceCredential(rule) === sourceCredential
      && (!billingSource || billingSourceState().version === billingSource.version) ? write() : STALE_SCOPE;
    // Store is the single runtime's source-of-truth boundary.  Older narrow
    // test doubles do not expose it, but production Store always does.
    return withSourceLock(rule, () => typeof rt.store.withStationLocks !== "function" ? verifyAndWrite()
      : rt.store.withStationLocks([rule.upstreamStationId, rule.ownStationId, ...(billingSource?.stationIds || [])], verifyAndWrite));
  };

  // 凭据指纹必须在发请求前取：请求读的是发起时的凭据，等待期间站点可能已被原地改写。
  // 分组和 Key 目录 5 分钟内用缓存；过了重读。reuseIdentity（轮询）时，身份和 /api/status 不满 30 分钟沿用上次读到的，只读分组和 Key 目录；
  // 满 30 分钟就全部重读，不等目录到期。readMetadata 另外告诉调用方这次用的身份是不是沿用的（identityReused）
  async function readMetadata(station, { force = false, timezone = "Asia/Shanghai", reuseIdentity = false } = {}) {
    const credential = credentialFingerprint(station);
    const zone = canonicalTimeZone(timezone), cacheKey = `${station.id}:${zone}`;
    const cached = metadataCache.get(cacheKey), now = Date.now();
    const same = cached?.credential === credential;
    const identityCurrent = same && now - cached.identityAt < IDENTITY_TTL_MS;
    if (!force && same && now - cached.at < CATALOGUE_TTL_MS && (!reuseIdentity || identityCurrent)) return { value: cached.value, identityReused: true };
    const known = !force && reuseIdentity && identityCurrent ? { accountId: cached.value.accountId,
      status: cached.value.platform === "newapi" ? { quotaPerUnit: cached.value.quotaPerUnit, version: cached.value.version } : null } : null;
    const value = await queryReconciliationMetadata({ ...station }, { timezone: zone, capabilityStore: billingCapabilityStore, known });
    // 只缓存读全了的：分组没读到（groupsAvailable 为 false）的这份不留，下一轮照常重读（读失败的本来就不缓存）
    if (value?.groupsAvailable === false) metadataCache.delete(cacheKey);
    else metadataCache.set(cacheKey, { at: now, identityAt: known ? cached.identityAt : now, credential, value });
    return { value, identityReused: !!known };
  }

  async function metadataFor(station, options) {
    return (await readMetadata(station, options)).value;
  }

  async function identityFor(station, { force = false, maxAgeMs = CATALOGUE_TTL_MS } = {}) {
    const credential = credentialFingerprint(station);
    const cached = identityCache.get(station.id);
    if (!force && cached?.credential === credential && Date.now() - cached.at < maxAgeMs) return cached.value;
    const value = await queryAccountIdentity(station);
    identityCache.set(station.id, { at: Date.now(), credential, value });
    return value;
  }

  // K2b：渠道这一轮认出的 Key 和绑定自己记的不一样时，接进结账流程要做的两件事（k-plan §3.3/§3.4，
  // 总指挥 10-26 定：检测和正常换 Key 都不能等 K2c）：
  //   1. 分组、合组：只检测、不碰 reconciliation_rule_channels、不开新段。检测到的绑定由调用方
  //      （inspectRule 的早退）当未结处理，从第一次认出冲突的那一刻（b）起不结账，交给 K2c 重新分组。
  //   2. 没有冲突、真的换了 Key 的绑定：算好计划（server/key-agent-resegment.js），同一个事务开新段、
  //      改 rules 那几列（server/reconciliation-repository.js 的 applyKeyChangePlans），数据库的两道
  //      唯一约束兜底——检测没拦住的边界情况，撞了就回滚、改记分组冲突，不会把钱算给错的那一条。
  // 多把 Key 的渠道、这一轮没认出来（ambiguous/not_found）的渠道都不参与（分组合组判断、换 Key 都不算），留给下一轮。
  // 只给已经锚定过身份（rule.canonicalKey 不是 null）、这一轮上游身份读得到的绑定换 Key：没锚定的绑定走自己的
  // 锚定流程，不归 K2b 管；上游这一轮读不到就留给下一轮，不拿读不到的身份算 canonicalKey。
  //
  // 过渡段 [a, b) 的 a（丢了只能往前退、不能退到 b，否则 [t, b) 那段新 Key 的花费漏掉）：
  //   - a 取这一轮读取服务读之前存的「上一次读成功」的时刻，不是这一轮的；这一轮新的成功时刻要等这一轮的换段落库
  //     提交以后再写（identifyChannelsCached 自己不写）。读完先写会让 a 变成 b；写完还没落库就重启，重启后 a 还是 b。
  //   - 这一轮只要这个站点下还有没处理完的（撞了约束回滚、分组合组、上游身份读不到、有绑定这一轮认不出来……），
  //     站点的成功时刻就不往前推：「上一次读成功」是整个站点一个值，对没处理完的绑定来说，它不能越过它们最后一次确认旧 Key 的时刻。
  //   - 带着没处理完的事的绑定（rules.key_issue_code 有值），a 一律用开着那段的起点；所有绑定的 a 都不能早于
  //     开着那段的起点（段不能在自己起点以前结束）。
  //
  // 这条绑定的 Key 现在有没处理的事（keyIssues，ruleId -> { code, sinceMs, channelId? }）：
  //   KEY_GROUP_CHANGED（分组、合组）、CHANNEL_KEY_UNMATCHED（渠道换成了不在已加上游里的 Key，流程稿例外一）、
  //   KEY_REVEAL_DENIED（打码撞了、上游令牌没有读完整 Key 的权限）。都是从第一次认出来的那一刻 b 起不结账；
  //   早退只挡 window.endMs >= b 的窗口（总指挥 10-26 定：b 以前已经结过、或者还没轮到结的日子，和这件事无关，不能
  //   因为今天出了事就连累）。b 第一次认出时持久化到 rules.key_issue_code / key_issue_since_ms（重启不丢），
  //   后面几轮同一件事沿用同一个 b；事情解开了清掉。
  // 返回 { keyIssues, keyAgentDown, rules }：
  // rules 是换段落库以后重新读的绑定（没有换 Key 时原样返回），调用方要用它重算成本主人和写账本的版本指纹。
  async function keyAgentRoundFor(rules, resources) {
    const keyIssues = new Map(); // ruleId -> { code, sinceMs, channelId? }
    // b（sinceMs）：一条绑定只要一直有事项（不管事项的码怎么变，比如 CHANNEL_KEY_UNMATCHED 变成 KEY_GROUP_CHANGED）就沿用最早的那个，
    // 事项全部解除（这一轮没有）才清、下次重新记。换码就重置成现在，会把之前被挡的日子放行
    const issueFor = (rule, code, extra = {}) => ({ code, sinceMs: keyIssues.get(rule.id)?.sinceMs ?? rule.keyIssue?.sinceMs ?? now, ...extra });
    const keyAgentDown = new Map(); // ruleId -> { code, sinceMs }：读取服务读不到，从 sinceMs 起先不算
    const now = Date.now();
    const enabled = rules.filter((rule) => rule.enabled);
    const byOwnStation = new Map(); // 只给参与了本轮识别的 own 站点下的绑定判断分组/合组；没装读取服务的站点不受影响，也不清它们的记号
    let applied = false;
    for (const ownStationId of new Set(enabled.map((rule) => rule.ownStationId))) {
      const ownStation = upstreamStation(ownStationId);
      if (!ownStation || !keyAgentConfigOf(ownStation)) continue;
      // 这一轮读之前「读取服务上一次读成功的时刻」：先存住旧值，落库以后才把这一轮的写进去
      const stationLastSuccessAtMs = ownStation.keyAgentLastSuccessAtMs ?? null;
      const identified = await identifyChannelsCached(rt, ownStation).catch(() => null);
      // 读不到（连不上、401/503、格式不对），或者带 X-Agent-Stale（读取服务自己读库失败、给的是上一份旧结果）：都算拿不到新结果。
      // 不拿旧结果去判换没换 Key；这个站点下各绑定记「读不到」，从最后一次读到的时刻起先不算
      if (!identified?.ok || identified.stale === true || !identified.channels) {
        // 库里已经记着的事项（rules.key_issue_code / key_issue_since_ms）这一轮没法重新判断：继续挡，不能因为读取服务断了就放行
        // （CHANNEL_KEY_UNMATCHED 从 b 起挡着的那天，读取服务一断就被固定）。事项只有读得到、重新判断以后才清
        for (const rule of enabled.filter((item) => item.ownStationId === ownStationId && item.keyIssue)) {
          keyIssues.set(rule.id, { code: rule.keyIssue.code, sinceMs: rule.keyIssue.sinceMs });
        }
        const reach = keyAgentReachability(rt, ownStationId);
        const code = keyAgentExceptionIssueOf(reach);
        if (code) {
          // 从最后一次读到的时刻起先不算。内存里的最后一次读到、持久化的都没有（这个站点从来没读成功过，或者每一轮都有没处理完的绑定
          // 所以持久化值一直没推进、又恰好重启）：退回这条绑定开着那段的起点，不用「现在」——用现在会把从来没核对过 Key 的日子放行
          const known = reach.lastSuccessAtMs ?? stationLastSuccessAtMs;
          for (const rule of enabled.filter((item) => item.ownStationId === ownStationId)) {
            const openFrom = known == null ? (await repository.listSegments(rule.id).catch(() => [])).find((segment) => segment.effectiveTo == null)?.effectiveFrom : null;
            keyAgentDown.set(rule.id, { code, sinceMs: known ?? openFrom ?? reach.unreachableSinceMs ?? now });
          }
        }
        continue;
      }
      byOwnStation.set(ownStationId, true);
      const snapshotByChannelId = new Map(identified.channels.map((channel) => [Number(channel.channelId), channel]));
      // 全部上游都读到了、哪里都没有这把（not_found）：渠道换成了不在已加上游里的 Key；打码撞了又没有 api_key:reveal 权限：
      // 分不清是哪把（revealIssues，K2a 按上游汇总）。多把 Key 的渠道不参与
      const unmatchedChannelIds = new Set(identified.channels.filter((channel) => !channel.keyless && channel.slots?.length === 1 && channel.slots[0].state === "not_found").map((channel) => Number(channel.channelId)));
      const revealDeniedChannelIds = new Set((identified.revealIssues || []).flatMap((item) => item.channelIds || []).map(Number));
      // 缺 api_key:reveal 权限的是哪个上游：「更新登录信息」要去那个上游（打码撞了时它不一定是绑定自己的上游）
      const revealUpstreamByChannel = new Map((identified.revealIssues || []).flatMap((item) => (item.channelIds || []).map((id) => [Number(id), item.upstreamStationId])));
      const refByChannelId = new Map();
      for (const channel of identified.channels) {
        if (channel.keyless || channel.slots?.length !== 1) continue;
        const slot = channel.slots[0];
        if (slot.state !== "identified" || slot.matches?.length !== 1) continue;
        refByChannelId.set(Number(channel.channelId),
          { upstreamStationId: slot.matches[0].stationId, tokenId: Number(slot.matches[0].tokenId), tokenName: slot.matches[0].tokenName ?? null });
      }
      let pending = false; // 这个站点下这一轮有没有没处理完的——有就不推进「上一次读成功」
      const currentRefsByBinding = [], changeCandidates = [];
      for (const rule of enabled.filter((item) => item.ownStationId === ownStationId)) {
        const channelRefs = rule.channels.map((channel) => refByChannelId.get(Number(channel.channelId)) ?? null);
        const deniedChannel = rule.channels.find((channel) => revealDeniedChannelIds.has(Number(channel.channelId)));
        // 没锚定过的绑定还没开始算，不进需处理（流程稿附录 4：没开始算过的渠道只在原处写一句）
        const unmatchedChannel = rule.canonicalKey != null ? rule.channels.find((channel) => unmatchedChannelIds.has(Number(channel.channelId))) : null;
        if (channelRefs.every((ref) => ref == null)) {
          // 这一轮一把都没认出来，不参与换 Key 判断；但除非它的渠道全是不认 Key 的（keyless），这条绑定这一轮没被确认过，
          // 站点的成功时刻不能越过它最后一次确认旧 Key 的时刻
          if (rule.channels.some((channel) => !snapshotByChannelId.get(Number(channel.channelId))?.keyless)) pending = true;
          if (deniedChannel) keyIssues.set(rule.id, issueFor(rule, "KEY_REVEAL_DENIED", { channelId: deniedChannel.channelId, upstreamStationId: revealUpstreamByChannel.get(Number(deniedChannel.channelId)) }));
          else if (unmatchedChannel) keyIssues.set(rule.id, issueFor(rule, "CHANNEL_KEY_UNMATCHED", { channelId: unmatchedChannel.channelId }));
          continue;
        }
        if (detectGroupSplit(channelRefs)) { keyIssues.set(rule.id, issueFor(rule, "KEY_GROUP_CHANGED")); pending = true; continue; }
        if (deniedChannel || unmatchedChannel) { // 组里有的渠道认出来了、有的没有：这条绑定这一轮没处理完
          keyIssues.set(rule.id, deniedChannel ? issueFor(rule, "KEY_REVEAL_DENIED", { channelId: deniedChannel.channelId, upstreamStationId: revealUpstreamByChannel.get(Number(deniedChannel.channelId)) })
            : issueFor(rule, "CHANNEL_KEY_UNMATCHED", { channelId: unmatchedChannel.channelId }));
          pending = true;
          continue;
        }
        const ref = channelRefs.find(Boolean);
        if (ref) currentRefsByBinding.push({ bindingId: rule.id, ref });
        const differs = ref && (ref.upstreamStationId !== rule.upstreamStationId || Number(ref.tokenId) !== Number(rule.tokenId));
        // 渠道换到了别的上游站点的 Key（不是同一个上游站点内换了 token）：不是 K2b 的事（流程稿例外一，加上游 /
        // 改上游的 Key），这一版不当「换 Key」处理，留给现有机制
        if (differs && rule.canonicalKey != null && ref.upstreamStationId === rule.upstreamStationId) {
          changeCandidates.push({ rule, before: { upstreamStationId: rule.upstreamStationId, tokenId: rule.tokenId }, after: ref });
        } else if (differs) pending = true;
      }
      for (const group of detectGroupMerges(currentRefsByBinding)) for (const bindingId of group) {
        const rule = enabled.find((item) => item.id === bindingId);
        keyIssues.set(bindingId, issueFor(rule, "KEY_GROUP_CHANGED"));
        pending = true;
      }
      const toApply = changeCandidates.filter((item) => !keyIssues.has(item.rule.id));
      if (toApply.length) {
        const result = await applyKeyAgentChangesFor(toApply, { observedAt: identified.fetchedAtMs ?? now, stationLastSuccessAtMs, resources, keyIssues, issueFor });
        applied ||= result.applied;
        if (!result.allApplied) pending = true;
      }
      // 换段已经落库提交（或这一轮没有要换的）、而且没有没处理完的：这一轮读取服务读成功的时刻才可以记下来
      if (!pending && identified.fetchedAtMs != null) await rt.store.setKeyAgentLastSuccessAt?.(ownStationId, identified.fetchedAtMs)?.catch?.(() => {});
    }
    await Promise.all(enabled.filter((rule) => byOwnStation.has(rule.ownStationId)).map(async (rule) => {
      const issue = keyIssues.get(rule.id) ?? null;
      if ((issue?.code ?? null) !== (rule.keyIssue?.code ?? null) || (issue?.sinceMs ?? null) !== (rule.keyIssue?.sinceMs ?? null)) {
        await repository.markKeyIssue(rule.id, issue ? { code: issue.code, sinceMs: issue.sinceMs } : null).catch(() => {});
      }
    }));
    return { keyIssues, keyAgentDown, rules: applied ? await repository.listRules().catch(() => rules) : rules };
  }

  // changeCandidates：这一个 own 站点下真的换了 Key、没有冲突的绑定，{ rule, before, after }。
  // 算每条的 a（safeLastSeenAt）、batch 一次 planSegmentChanges（算不算「挪过」要几条一起看），再一次
  // applyKeyChangePlans 落库；canonicalKey 按新 tokenId 重新算，和 token_id 一起改，不然下一次结账会被
  // SOURCE_BINDING_UNCONFIRMED 挡住（锚定时记的 canonicalKey 对不上了）。
  // 互换、轮换的绑定一组一个事务，别的组各自一个事务；撞了数据库唯一约束（没被 detectGroupMerges 预检查到的边界情况）只回滚、只记这一组的分组冲突，不写段。
  // 返回 { applied: 有没有哪一组真的写进库, allApplied: 这一批是不是全部落库了 }
  async function applyKeyAgentChangesFor(changeCandidates, { observedAt, stationLastSuccessAtMs, resources, keyIssues, issueFor }) {
    const lastSeenAtByBinding = {};
    for (const { rule } of changeCandidates) {
      const segments = await repository.listSegments(rule.id).catch(() => []);
      const open = segments.find((segment) => segment.effectiveTo == null);
      if (!open) return { applied: false, allApplied: false }; // 读不到开着的段，这一轮不换
      lastSeenAtByBinding[rule.id] = safeLastSeenAt({ keyAgentLastSuccessAtMs: rule.keyIssue != null ? null : stationLastSuccessAtMs,
        segmentEffectiveFrom: open.effectiveFrom });
    }
    const plans = planSegmentChanges({
      bindings: changeCandidates.map(({ rule, before, after }) => ({ id: rule.id, before, after })),
      observedAt, lastSeenAt: observedAt, lastSeenAtByBinding,
    });
    const byRuleId = new Map(changeCandidates.map((item) => [item.rule.id, item]));
    // Sub2API 只能按整天读账单：一把 Key 在两条绑定之间挪（互换、转手）时，b 那一刻切不开这一天的钱——两条绑定各取这把 Key 全天，
    // 同一笔钱会算两遍。这一版先不处理：这两条绑定这几天先不结账，记一个会自己好的「读取中」，
    // 等后面的小 PR 按逐条用量拆开（design/ux/binding-flow.md §3 最后一段）；宁可先不算，也不算错。
    // 现在识别只认 New API 上游的 Key（Sub2API 的目录不给 Key 材料），这里是为以后认得出 Sub2API 时守住的
    const isSub2 = (ruleId) => /^sub2api/.test(upstreamStation(byRuleId.get(ruleId)?.rule.upstreamStationId)?.type || "");
    const deferred = new Set(plans.filter((plan) => plan.kind === "moved" && isSub2(plan.bindingId)).flatMap((plan) => [plan.bindingId, plan.movedFromBindingId]).filter(Boolean));
    for (const ruleId of deferred) if (byRuleId.has(ruleId)) keyIssues.set(ruleId, issueFor(byRuleId.get(ruleId).rule, "PENDING"));
    const applyPlans = plans.filter((plan) => !deferred.has(plan.bindingId)).map((plan) => {
      const { rule } = byRuleId.get(plan.bindingId);
      const identity = resources.get(rule.upstreamStationId)?.identity;
      const upstream = upstreamStation(rule.upstreamStationId);
      // 上游这一轮身份读不到：不拿读不到的身份算 canonicalKey，这一条整条跳过，等下一轮一起换
      if (!identity || !upstream) return null;
      // 新 Key 在上游目录里的分组和倍率：新段按它开（不然下一次观测发现分组变了，换 Key 之后又切一段）；目录里找不到就不给，沿用旧段的
      const metadata = resources.get(rule.upstreamStationId)?.metadata;
      const newToken = metadata?.tokens?.find((item) => Number(item.id) === Number(plan.after[0].tokenId));
      const groupFields = newToken ? { group: newToken.group, ratio: metadata.groupsAvailable ? metadata.groups?.[newToken.group]?.ratio ?? null : null } : {};
      return { ruleId: plan.bindingId, plan: { ...plan, ...groupFields, canonicalKey: canonicalBillingKey(upstream, identity, plan.after[0].tokenId) } };
    }).filter(Boolean);
    // 互换、轮换（挪过）的几条绑定必须同生同死：按 movedFromBindingId 把互相牵连的归成一组，每组一个事务；
    // 别的组各自一个事务。一组撞了约束只回滚这一组、只给这一组记 KEY_GROUP_CHANGED（会自己好的那类），别的组照常换段——
    // 一条有问题的绑定不能挡住同一个站点上别的绑定换 Key（见 PR 说明）。
    // 挪过来的 Key 在另一头的那条绑定这一轮没算出计划（上游身份读不到被跳过）：这一条也先留着，不然会和还握着这把 Key 的另一头撞车
    const skipped = new Set(plans.map((plan) => plan.bindingId).filter((id) => !applyPlans.some((item) => item.ruleId === id)));
    const held = applyPlans.filter(({ plan }) => plan.kind === "moved" && skipped.has(plan.movedFromBindingId));
    const ready = applyPlans.filter((item) => !held.includes(item));
    if (!ready.length) return { applied: false, allApplied: false };
    const parent = new Map(ready.map(({ ruleId }) => [ruleId, ruleId]));
    const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
    for (const { ruleId, plan } of ready) if (plan.movedFromBindingId != null && parent.has(plan.movedFromBindingId)) parent.set(find(ruleId), find(plan.movedFromBindingId));
    const grouped = new Map();
    for (const item of ready) grouped.set(find(item.ruleId), [...(grouped.get(find(item.ruleId)) || []), item]);
    const groups = [...grouped.values()];
    let applied = false, allApplied = !held.length && ready.length === changeCandidates.length && !deferred.size;
    for (const group of groups) {
      // 写库失败（不是撞唯一约束，比如连接断了）：这一组这一轮没换成，不是分组合组，不记冲突，下一轮接着换；
      // stale：计划落库时已经不成立（别的写入先换过了、倍率变化先开了新段），什么也没写，下一轮重新算
      const result = await repository.applyKeyChangePlans(group, { detectedAt: observedAt }).catch(() => null);
      if (!result || result.stale) { allApplied = false; continue; }
      if (result.conflict) {
        // 数据库唯一约束拦住了（没被 detectGroupMerges 预检查到的边界情况）：这一组牵连的绑定都改记分组冲突，不写段
        for (const { ruleId } of group) keyIssues.set(ruleId, issueFor(byRuleId.get(ruleId).rule, "KEY_GROUP_CHANGED"));
        allApplied = false;
        continue;
      }
      applied = true;
    }
    return { applied, allApplied };
  }

  // 页面「刷新」（观测）强制重读 Key 目录和账号身份；只读查询用 5 分钟缓存。
  // 轮询（poll）按时间重读：分组和 Key 目录 5 分钟、身份和 /api/status 30 分钟（自营站点的身份也是 30 分钟）；
  // 记在 staleMetadata 里的上游这一轮强制全部重读：出了异常的、这一轮要结账的（refreshDue 放进来），读成功才清掉记号。
  async function ownerRegistryFor(rules, selected, { observe = true, poll = false } = {}) {
    // expectedOwnerState 是全部绑定的指纹，只用来作结果缓存的版本；写快照时核对、加锁只看这条绑定同一把 Key 的那一组（ownerScopeFor）
    const billingSource = { ...billingSourceState(), expectedOwnerState: reconciliationOwnerRuleState(rules), ownerRules: rules };
    const selectedIds = new Set(selected.map((rule) => rule.id));
    // 已解除的绑定（补结解除前的日子，C3）只出现在 selected 里：读它们上游的元数据和身份，但不当别的绑定的成本主人
    let participants = [...rules.filter((rule) => rule.enabled || selectedIds.has(rule.id)), ...selected.filter((rule) => rule.archivedAt)];
    const stationIds = [...new Set(participants.flatMap((rule) => [rule.upstreamStationId, rule.ownStationId]))].sort();
    const resources = new Map(await mapWithConcurrency(stationIds, 4, async (id) => {
      const configured = upstreamStation(id);
      const station = configured && { ...configured };
      const resourceVersion = stationBusinessVersion(station);
      let reused = false;
      try {
        if (!station) throw codedError("COST_OWNER_UNVERIFIED", issueText("COST_OWNER_UNVERIFIED"));
        const timezone = selected.find((rule) => rule.upstreamStationId === id)?.timezone
          || participants.find((rule) => rule.upstreamStationId === id)?.timezone || "Asia/Shanghai";
        const force = observe && (!poll || staleMetadata.has(id));
        reused = poll && !force;
        const read = billingStation(station) ? await readMetadata(station, { force, timezone, reuseIdentity: poll }) : null;
        const metadata = read?.value ?? null;
        const identity = metadata ? { provider: metadata.platform, baseUrl: onboardingBaseUrl(station.baseUrl), accountId: String(metadata.accountId ?? metadata.userId) }
          : await identityFor(station, { force, maxAgeMs: poll ? IDENTITY_TTL_MS : CATALOGUE_TTL_MS });
        if (force) staleMetadata.delete(id);
        return [id, Object.freeze({ station, resourceVersion, metadata, identity: Object.freeze(identity), identityReused: poll && !!read?.identityReused, error: null })];
      } catch (error) {
        // 轮询拿沿用的身份读失败（比如账号换了、目录归属对不上）：下一轮全部重读，不要每轮拿旧身份再失败
        if (reused) staleMetadata.add(id);
        return [id, Object.freeze({ station, resourceVersion, metadata: null, identity: null, identityReused: reused, error })];
      }
    }));
    // 只读查询（页面只读、evaluate）不检测：identifyChannelsCached 本身有 4 分钟缓存，但这里额外按 observe 收一道，
    // 不让纯读页面的请求触发检测逻辑；真正会出问题的场景已经有定期的观测/轮询在跑，不差这一次。
    // 放在算成本主人、写账本的版本指纹之前：这一轮真的换了 Key（rules.token_id、canonical_key 变了）就重新读绑定，
    // 后面用的都是换完以后的，不会这一轮拿着旧的 token_id 判重复、核对版本
    let keyIssues = new Map(), keyAgentDown = new Map();
    if (observe) {
      const round = await keyAgentRoundFor(rules, resources);
      keyIssues = round.keyIssues;
      keyAgentDown = round.keyAgentDown;
      if (round.rules !== rules) {
        rules = round.rules;
        billingSource.expectedOwnerState = reconciliationOwnerRuleState(rules);
        billingSource.ownerRules = rules;
        participants = [...rules.filter((rule) => rule.enabled || selectedIds.has(rule.id)), ...selected.filter((rule) => rule.archivedAt)];
      }
    }
    billingSource.ownerVersion = createHash("sha256").update(JSON.stringify([billingSource.version, billingSource.expectedOwnerState,
      stationIds.map((id) => {
        const { identity, metadata } = resources.get(id);
        return [id, identity, metadata?.quotaPerUnit ?? null, metadata?.groupsAvailable ?? null,
          Object.entries(metadata?.groups || {}).sort(([a], [b]) => a.localeCompare(b)).map(([group, value]) => [group, value.ratio]),
          (metadata?.tokens || []).map((token) => [token.id, token.name, token.group, token.status, !!token.crossGroupRetry]).sort((a, b) => a[0] - b[0]),
          metadata?.capability?.state || null];
      })])).digest("hex");
    const assignments = new Map(), duplicateSales = new Map();
    for (const rule of rules.filter((rule) => rule.enabled)) {
      const resource = resources.get(rule.ownStationId);
      // 未锚定旧成员不能据此取得历史来源；当前身份只阻止潜在重复收入确认。
      const source = rule.ownSource || (resource?.identity && resource.station ? ownSourceFor(resource.station, resource.identity) : null);
      if (source) for (const channel of rule.channels) {
        const key = `${source.namespaceKey}:${channel.channelId}`;
        assignments.set(key, [...(assignments.get(key) || []), rule.id]);
      }
    }
    for (const ids of assignments.values()) if (ids.length > 1) for (const id of ids) {
      duplicateSales.set(id, [...new Set([...(duplicateSales.get(id) || []), ...ids])].sort());
    }
    return { startedAt: Date.now(), rules: Object.freeze(participants.map((rule) => Object.freeze({ ...rule }))), resources, duplicateSales, billingSource: Object.freeze(billingSource),
      keyIssues, keyAgentDown, keyAgentObserved: observe,
      // 这一轮（或这一次查询）里共用的：自营站点的 /api/status；哪些自营站点从什么时候起没有新的消费（只有轮询会填）
      ownStatus: new Map(), ownQuietFrom: new Map() };
  }

  // 自营站点的 /api/status（quotaPerUnit）同一个 registry 里只读一次，各绑定共用；读失败不留。
  // 等着别的绑定发起的那一次、而那一次失败了的，自己再读一次（同时等着的几条共用这一次），不跟着一起失败
  function ownStatusFor(registry, own) {
    const key = `${own.id}:${credentialFingerprint(own)}`;
    const load = () => {
      const pending = queryNewApiStatus(own);
      registry.ownStatus.set(key, pending);
      pending.catch(() => { if (registry.ownStatus.get(key) === pending) registry.ownStatus.delete(key); });
      return pending;
    };
    const shared = registry.ownStatus.get(key);
    return shared ? shared.catch(() => registry.ownStatus.get(key) || load()) : load();
  }

  // 每轮轮询开始时，每个自营站点读一次「从起点以后的消费日志」：最新那一条的编号、时刻，和一共几条（同一个响应）。
  // 起点和上一轮相同、这三样都没变：上一轮以后没有新的消费日志，今天的渠道收费读到 quietFrom 以后的，这一轮直接沿用（见 ownRevenue）。
  // 用日志自己的时刻和条数，不用控制台的钟：站点的钟偏慢、日志晚写进去（时刻更早、排不到第一），条数都会变（审核第一、二轮，总指挥 10-25 定）。
  // 起点从上一次读到的最新一条（站点的时刻）往前 120 秒起，落后超过 10 分钟才往前挪，挪的那一轮照常读；没读到过日志的从第一次查往前 2 小时起，之后不挪。
  // 有新的消费、读失败、换了凭据、第一轮、起点挪了、接口不给条数（老版本）：这一轮照旧逐个渠道读。
  // 自营站点记不记收费记录（own-revenue-plan 第二节）：每个自营站点每 5 分钟读一次设置（轮询、页面看都走这里，结账和「刷新」强制读，
  // 离上次不到 30 秒的不重复读）；只在开、关变化时往站点记录上写关着的时间段（走 store.update，带站点锁），重启不丢。
  // 起点是最后一次能证明开着的时刻：内存里最近读到开着的时刻、自营站点最新一条消费日志的时刻（往前留 120 秒，站点的钟）取最晚的；
  // 都没有就从读到关着那一刻起算。两次读取之间关了几分钟又开了的，读不到，那几分钟的收入会算少（规范里写了，界面不出现）。
  // 读不到设置（网络、没权限、令牌作废）不改段，也不报错：没权限的状态给设置页说一句（consumeLogStatusOf），其余的原因各自的读取会说。
  const CONSUME_LOG_READ_MS = 5 * 60000, CONSUME_LOG_FORCE_MS = 30000, CONSUME_LOG_BUTTON_MS = 2000;
  // 设置一直读不到（5xx、超时、限流这类会自己好的）超过这么久：不再挡结账，照常固定，站点这一层进需处理「自营站点的设置读不到」（审核 R2 第二轮 中-1，总指挥 10-26 定）
  const OPTION_UNREADABLE_MAX_MS = 24 * 3600000;
  const optionRetryable = (status) => status?.state === "unavailable" && ["NETWORK_UNREACHABLE", "UPSTREAM_REQUEST_FAILED", ""].includes(String(status.code ?? ""));
  const consumeLogReads = new Map(); // 站点 id → { credential, checkedAt, status, lastOnAt, unavailableSince（连续读不到从什么时候起，读到了清空）}
  const consumeLogInflight = new Map();
  function consumeLogStatusOf(stationId) {
    return consumeLogReads.get(stationId)?.status ?? null;
  }
  // always：「重新检查」按钮——用户刚到后台打开，回来点，这一次一定要真读（不受 30 秒限制；同一时刻并发的合并成一次，连点只隔 2 秒）
  async function refreshConsumeLog(own, { force = false, always = false } = {}) {
    if (!own?.isOwn || own.type !== "newapi") return null;
    const credential = credentialFingerprint(own);
    const known = consumeLogReads.get(own.id);
    const ageLimit = always ? CONSUME_LOG_BUTTON_MS : force ? CONSUME_LOG_FORCE_MS : CONSUME_LOG_READ_MS;
    if (known && known.credential === credential && Date.now() - known.checkedAt < ageLimit) return known.status;
    const inflightKey = `${own.id}:${credential}`;
    if (consumeLogInflight.has(inflightKey)) return consumeLogInflight.get(inflightKey);
    const task = (async () => {
      let status;
      try { status = await queryOwnConsumeLog(own); } catch (err) { status = { state: "unavailable", code: String(err?.code || "") }; }
      const at = Date.now(), previous = known && known.credential === credential ? known : null;
      const next = { credential, checkedAt: at, status, lastOnAt: status.state === "on" ? at : previous?.lastOnAt ?? null,
        unavailableSince: optionRetryable(status) ? previous?.unavailableSince ?? at : null,
        // 状态行里记的「这天第一次读不到的时刻」（结账时看到的，见 consumeLogSettingNote）：重启不丢；读到了就清
        firstFailedFromState: optionRetryable(status) ? previous?.firstFailedFromState ?? null : null };
      consumeLogReads.set(own.id, next);
      // 设置从「会自己好的读不到」变成读得到了（开、关、没权限都算）：清掉「设置一直读不到」的告警记录（推送按站点只推一条，下次再读不到才再推）。
      // 重启后第一次读（previous 为空）那种情况交给 syncOptionUnreadableSince 在 observe 轮里补清（这里只看内存里的上一轮，
      // 免得纯读页面也触发写库——1b 接口零写入的规矩，审核 R2 第二轮 中-E）
      if (previous && optionRetryable(previous.status) && !optionRetryable(status)) repository.clearActiveAlerts(optionAlertKey(own.id), at).catch(() => {});
      if (status.state === "on" || status.state === "off") {
        let latestLogMs = ownActivity.get(own.id)?.latest?.createdAtSec != null ? ownActivity.get(own.id).latest.createdAtSec * 1000 - CONSUME_LOG_LOOKBACK_MS : null;
        // 上一次读到开着就在一个读取间隔以内：起点只用它（站点的钟快，最新一条日志的时刻会比它晚，取晚了会漏标前面几分钟）；
        // 没有、或者太旧（重启、停机以后）才看最新一条日志的时刻往前 120 秒，取较晚的
        const recentOn = previous?.lastOnAt != null && at - previous.lastOnAt <= 2 * CONSUME_LOG_READ_MS;
        // 读到关着、又没有证据（重启后第一次、停机很久、凭据换过）：单独读一次站点最新的一条消费日志，不限 2 小时（审核第一轮 中-2，总指挥 10-26 定）；
        // 只在没有证据时多 1 个请求。读不到就退回「现在」
        const hasPeriodOpen = (upstreamStation(own.id)?.consumeLogOffPeriods ?? own.consumeLogOffPeriods ?? []).some((period) => period.toMs == null);
        if (status.state === "off" && !hasPeriodOpen && !recentOn && previous?.lastOnAt == null && latestLogMs == null) {
          try { const page = await queryOwnLatestLog(own, { sinceSec: 0 }); if (page.latest) latestLogMs = page.latest.createdAtSec * 1000 - CONSUME_LOG_LOOKBACK_MS; } catch { /* 退回现在 */ }
        }
        const offFromMs = recentOn ? previous.lastOnAt : Math.max(previous?.lastOnAt ?? -Infinity, latestLogMs ?? -Infinity);
        const periods = applyConsumeLogReading(upstreamStation(own.id)?.consumeLogOffPeriods ?? own.consumeLogOffPeriods, { state: status.state, at },
          { offFromMs: Number.isFinite(offFromMs) ? offFromMs : null });
        if (periods) {
          await rt.store.update(own.id, { consumeLogOffPeriods: periods });
          clearBillingResults(); // 哪些天碰到了关着的段变了，缓存里的结果作废
          ownCache(rt).clear(); // 运营总览的等式（自营分析缓存 120 秒）也跟着变，不然需处理已经说不记了、等式还照常显示收入
        }
      }
      return status;
    })().finally(() => consumeLogInflight.delete(inflightKey));
    consumeLogInflight.set(inflightKey, task);
    return task;
  }
  function ownSiteActions(ruleList) {
    const out = [];
    for (const id of new Set(ruleList.filter((rule) => rule.enabled && !rule.archivedAt).map((rule) => rule.ownStationId))) {
      const own = upstreamStation(id);
      if (!own?.isOwn || own.type !== "newapi") continue;
      if (consumeLogStillOff(upstreamStation(id)?.consumeLogOffPeriods ?? own.consumeLogOffPeriods)) {
        out.push(workflowAction("recheck_consume_log", { ownStationId: id, stationId: id }, { code: "OWN_CONSUME_LOG_OFF" }));
      }
      const read = consumeLogReads.get(id);
      // 设置连续读不到超过 24 小时：结账已经照常固定了，这里说一声是设置读不到（不借用「收费记录读不到」的话）
      if (optionRetryable(read?.status) && optionUnreadableSince(read) != null && Date.now() - optionUnreadableSince(read) >= OPTION_UNREADABLE_MAX_MS) {
        out.push(workflowAction("recheck_consume_log", { ownStationId: id, stationId: id }, { code: "OWN_OPTION_UNREADABLE" }));
      }
      const status = consumeLogStatusOf(id);
      if (status?.state === "denied") {
        const action = workflowAction("update_authorization", { stationId: id }, { code: "OWN_OPTION_READ_DENIED" });
        // 不是超级管理员时只写后半句：说明用不带「补权限」的那一句
        out.push(status.reason === "not_root" ? { ...action, detail: reconciliationIssue("OWN_OPTION_READ_DENIED").detailPlain } : action);
      }
    }
    return out;
  }
  // 这条绑定的这段窗口碰没碰到关着的段：碰到还关着的是 OFF（按钮「重新检查」），只碰到已经开回来的是 GAP（这一天永远不固定）
  async function consumeLogIssueFor(own, rule, window, { force = false, settle = false, priorState = null } = {}) {
    await refreshConsumeLog(own, { force }).catch(() => null);
    const accountingStart = reconciliationAccountingStart(rule) ?? Date.parse(rule.createdAt);
    const clipped = { startMs: Math.max(window.startMs, Number.isFinite(accountingStart) ? accountingStart : -Infinity), endMs: window.endMs };
    const overlap = consumeLogOffOverlap(upstreamStation(own.id)?.consumeLogOffPeriods ?? own.consumeLogOffPeriods, clipped);
    const code = overlap.open ? "OWN_CONSUME_LOG_OFF" : overlap.closed ? "OWN_CONSUME_LOG_GAP" : null;
    // 结账那一轮读不到站点设置（网络错、5xx、超时这类会自己好的）：这一天这一轮不固定，按 C2a 退避再试；没权限、令牌作废照常固定
    // （审核第一轮 中-3，总指挥 10-26 定）。要固定的才这样，页面上看（settle 为假）不挡
    // 审核 R2 第二轮 中-1：挡的码说的是「设置读不到」，不是收费记录；这天结束以后读到过一次开着、或者连续读不到超过 24 小时，就不挡了（照常固定，明细里记一句，站点这一层进需处理）
    if (!code && settle && consumeLogSettingNote(own, window, priorState)?.blocked) {
      return { code: "OWN_OPTION_UNREADABLE", scope: "downstream", detail: issueText("OWN_OPTION_UNREADABLE"), observedAt: Date.now() };
    }
    return code ? { code, scope: "downstream", detail: issueText(code), observedAt: Date.now() } : null;
  }
  // 结账这一刻设置读不读得到（只看会自己好的那类读不到）：provenOn 这天结束以后读到过开着；tooLong 连续读不到超过 24 小时；两样都没有才挡（blocked）。
  // 不挡而固定的，返回的这一份写进账本明细（settlement.consumeLogSetting）
  // 连续读不到从什么时候起：进程里记的那份，和这天状态行里记的「第一次读不到」取早的（控制台 24 小时内重启过也不会清零，审核 R2 增量 中-B）
  const optionUnreadableSince = (read) => [read?.unavailableSince, read?.firstFailedFromState].filter((value) => value != null).reduce((min, value) => Math.min(min, value), Infinity) === Infinity ? null
    : Math.min(...[read?.unavailableSince, read?.firstFailedFromState].filter((value) => value != null));
  // 站点那一层「连续读不到从什么时候起」也从库里拿（审核 R2 增量 中-C）：先取这个站点各绑定状态行里原因是 OWN_OPTION_UNREADABLE 的最早
  // first_failed_at_ms；这样的行都没了（那几天已经固定、行删了）就用告警状态表里这个站点那一条（推送记的）的首次出现时刻。不用新加存储；重启后第一次用到就补上
  // observe：只有结账 / 轮询这类带观测的调用才写库（一检测到读不到就记一行 active）；纯读页面只读不写，零写入的规矩不破
  // （1b 接口；审核 R2 第二轮 中-E）。清掉残留的 active 行仍然靠 refreshConsumeLog 里「上一次读不到、这一次读得到」那个内存判断——
  // 重启后那一刻如果内存刚好是空的，要等真的再读不到一次、又好了才会清；没有再独立补一条「重启后主动查一遍再清」的路径，
  // 因为那样在正常情况（从没出过问题）也会给每个自营站点多一次告警表查询，和多条「零写入/零告警查询」的用例冲突，取舍报总指挥
  async function syncOptionUnreadableSince(ruleList, { observe = false } = {}) {
    const byOwn = new Map();
    for (const rule of ruleList) if (rule.enabled && !rule.archivedAt) { if (!byOwn.has(rule.ownStationId)) byOwn.set(rule.ownStationId, []); byOwn.get(rule.ownStationId).push(rule.id); }
    for (const [id, ruleIds] of byOwn) {
      // 重启后这一轮还没读过设置（看的全是已固定的日子，不经过结账那条路）：先读一次（5 分钟内有的不重读），不然不知道现在读不读得到
      if (!consumeLogReads.has(id)) await refreshConsumeLog(upstreamStation(id)).catch(() => null);
      const read = consumeLogReads.get(id);
      if (!optionRetryable(read?.status)) continue;
      // 状态行和告警行里早的那个（审核 R2 第二轮 中-E：告警行现在一检测到就写，比按天粒度的状态行准，不能只在没有状态行时才看它）
      let since = null;
      try {
        for (const state of await repository.listSettlementStates(ruleIds)) {
          if (state.retryReason === "OWN_OPTION_UNREADABLE" && state.firstFailedAt != null && (since == null || state.firstFailedAt < since)) since = state.firstFailedAt;
        }
        const alert = await repository.getAlertState(optionAlertKey(id), "OWN_OPTION_UNREADABLE");
        if (alert?.active && Number(alert.first_seen_at) > 0 && (since == null || Number(alert.first_seen_at) < since)) since = Number(alert.first_seen_at);
      } catch { continue; }
      if (since != null && (read.firstFailedFromState == null || since < read.firstFailedFromState)) read.firstFailedFromState = since;
      // 读不到：立刻记一行 active（不等满 24 小时才推的那一刻），first_seen_at 尽量准、不会因为按天粒度的账本状态行往后漂（中-E，只在 observe 轮）
      if (observe) markOptionUnreadableSeen(repository, id, Date.now()).catch(() => {});
      // 连续读不到超过 24 小时：推一条（按站点只推一条，记在告警状态表 opt:站点 上，重启后站点那一层也从这条拿时刻；设置读得到那一刻清）
      const total = optionUnreadableSince(read);
      if (total != null && Date.now() - total >= OPTION_UNREADABLE_MAX_MS) {
        try { await notifyOptionUnreadable(rt, repository, id); } catch (err) { console.error("自营站点设置读不到的推送失败:", err?.message || String(err)); }
      }
    }
  }
  function consumeLogSettingNote(own, window, state = null) {
    const read = consumeLogReads.get(own.id);
    if (!optionRetryable(read?.status)) return null;
    const now = Date.now();
    // 这天的状态行是因为设置读不到挡的：它记的第一次读不到的时刻比内存早就用它；自动试满（退避用完）也算太久了
    if (state?.retryReason === "OWN_OPTION_UNREADABLE" && state.firstFailedAt != null && (read.firstFailedFromState == null || state.firstFailedAt < read.firstFailedFromState)) read.firstFailedFromState = state.firstFailedAt;
    const since = optionUnreadableSince(read);
    const provenOn = read.lastOnAt != null && read.lastOnAt >= window.endMs;
    const tooLong = since != null && now - since >= OPTION_UNREADABLE_MAX_MS; // 「自动试满也算」实际碰不到（7 天回看里试不到 130 次），不另判（审核增量 低-E）
    return { state: "unreadable", sinceMs: since, lastOnAt: read.lastOnAt ?? null, provenOn, tooLong, blocked: !provenOn && !tooLong };
  }

  async function markQuietOwnStations(rules, registry, now = Date.now()) {
    const ownIds = [...new Set(rules.map((rule) => rule.ownStationId))];
    await Promise.all(ownIds.map(async (id) => {
      const own = upstreamStation(id);
      if (!own?.isOwn || own.type !== "newapi") return;
      const credential = credentialFingerprint(own), previous = ownActivity.get(id);
      // 换了凭据就不算安静，和 ownRevenue 键里的凭据指纹互为备份
      const known = previous?.credential === credential && previous.read ? previous : null;
      const anchor = known?.latest ? known.latest.createdAtSec - OWN_LOG_LOOKBACK_SEC : null;
      let sinceSec = !known ? Math.floor(now / 1000) - OWN_LOG_FIRST_LOOKBACK_SEC
        : anchor != null && anchor - known.sinceSec > OWN_LOG_ANCHOR_LAG_SEC ? anchor : known.sinceSec;
      let page = null, read = false;
      try { page = await queryOwnLatestLog(own, { sinceSec }); read = true; } catch { read = false; }
      // 第一次（或读失败、换凭据以后）是从 2 小时前数起的：读到了最新一条，就马上按它重新定起点再读一次，下一轮起就只数十来分钟的日志
      if (read && !known && page.latest && page.latest.createdAtSec - OWN_LOG_LOOKBACK_SEC - sinceSec > OWN_LOG_ANCHOR_LAG_SEC) {
        sinceSec = page.latest.createdAtSec - OWN_LOG_LOOKBACK_SEC;
        try { page = await queryOwnLatestLog(own, { sinceSec }); } catch { read = false; }
      }
      const latest = page?.latest ?? null, total = page?.total ?? null;
      const unchanged = read && !!known && sinceSec === known.sinceSec && total != null && total === known.total
        && (latest?.id ?? null) === (known.latest?.id ?? null) && (latest?.createdAtSec ?? null) === (known.latest?.createdAtSec ?? null);
      const quietFrom = unchanged ? known.quietFrom ?? known.checkedAt : null;
      ownActivity.set(id, { credential, checkedAt: now, read, latest, total, sinceSec, quietFrom });
      // coveredFromMs：读到的窗口终点要到这一刻，才包住最新那条日志所在的那一秒（渠道收费按秒、终点那一秒不含，见 unixSecondWindow）
      if (quietFrom != null) registry.ownQuietFrom.set(id, { from: quietFrom, coveredFromMs: latest ? (latest.createdAtSec + 1) * 1000 : null });
    }));
  }

  // 一段窗口里各渠道不算收入的额度，从渠道收入里减掉（own-revenue-plan 第一节，用户 10-25 定：和运营总览、自营业务同一个规矩）：
  // 管理员账号（用户列表里 role ≥ 10，判断在 server/own-helpers.js，和那两处共用）自己花的钱；标成转售的管理员 Key 照样算收入，不减；
  // 兜底再减渠道测试记录（type 2、token_id 0、「模型测试」/「Model test」）里不在管理员名下的，管理员名下的已经在上一条里，不减两次。
  // 取数：每个管理员、每个测试名字各是一个「来源」，读管理端日志列表按渠道本地加（stat 不能按渠道分组）。
  // 日志是整个站点的，和哪条绑定无关，同一个站点、同一个窗口起点的各条绑定共用一份累计。
  // - 轮询（今天）：按各来源上次翻到的最大编号接着翻，每个来源平时 1 个请求；30 秒内刚读过的直接沿用（几条绑定同一轮来，
  //   晚到的那几秒下一轮补上，只影响今天的实时数）；
  // - 结账（settle）：先要一份现在读的管理员名单；每个来源先查全站这段窗口的总额度（/api/log/stat），是 0 就没有，不翻列表；
  //   不是 0 就翻到窗口终点，累计的行额度合计和总额度相等才用，不等整段重翻。累计只在内存里，重启以后那天整段重翻；
  // - 窗口比记下的短（终点更早）：不能接着用，整段读一次，不记。
  // 读失败（用户列表、任何一个来源）直接抛，queryOwnChannelRevenue 把这一段所有渠道当读不到，不拿没减的数当收入；
  // 只有「今天」碰到短暂失败（网络错、5xx、429）时 10 分钟内沿用上一份，沿用的不写进「今天」的收入缓存。管理员名单、转售 Key 变了：键里带转售 Key，名单变了按来源重新算，不沿用旧来源的累计。
  const OWN_EXCLUSION_REUSE_MS = 30000;
  const OWN_EXCLUSION_STALE_OK_MS = 10 * 60000;
  // 同一个窗口起点留 15 分钟内读到的状态（最多 120 份，按终点排）：一轮里几十条绑定读到这里的先后和各自终点的先后不一样，
  // 只留最近 4 份会被终点晚的挤掉，终点早的那条找不到可以接着用的，整段重读（审核 CI：每轮 474 页）
  const OWN_EXCLUSION_STATE_KEEP_MS = 15 * 60000, OWN_EXCLUSION_STATE_MAX = 120;
  // 只沿用短暂失败：网络错、5xx、429（读取这一层的码是 NETWORK_UNREACHABLE、UPSTREAM_REQUEST_FAILED）；令牌作废/少权限（401、403）、
  // 程序算出负数这类不会自己好的不沿用。用户列表那层外面包着 OWN_INCOME_UNCONFIRMED，要看包在里面的原因
  const isTransientOwnReadFailure = (error) => [error, error?.cause].some((item) => ["NETWORK_UNREACHABLE", "UPSTREAM_REQUEST_FAILED"].includes(item?.code))
    && ![error, error?.cause].some((item) => ["AUTHENTICATION_FAILED", "UPSTREAM_AUTH_DENIED"].includes(item?.code) || String(item?.code || "").startsWith("ACCESS_TOKEN_"));
  const OWN_EXCLUSION_VERIFIED_REUSE_MS = 10 * 60000;
  const OWN_EXCLUSION_FALLBACK_REUSE_MS = 10 * 60000;
  // freshSince：这一轮结账开始的时刻（ownerRegistry.startedAt）——结账要新的管理员名单，但同一轮里各条绑定共用这一份，不每条各读一遍用户列表（审核 #127 增量 中-2）
  function ownExclusion(own, window, { settle = false, channelIds = [], freshSince = null } = {}) {
    const wantedChannels = [...new Set(channelIds.map(Number))];
    // 沿用的结果要覆盖这次要算的渠道：翻页读的是全站所有渠道（"all"），按渠道 stat 读的只有当时要算的那几个
    const covers = (coverage) => coverage === "all" || wantedChannels.every((id) => coverage.has(id));
    const resold = resoldAdminKeysOf(own).map((key) => `${key.username}\u0000${key.tokenName}`).sort();
    const key = JSON.stringify([own.id, credentialFingerprint(own), window.startMs, window.timezone, resold]);
    let entry = ownExclusionCache.get(key);
    if (!entry) {
      entry = { startMs: window.startMs, tail: Promise.resolve(), states: [], pending: new Map() };
      ownExclusionCache.set(key, entry);
      // 按真实时间清（比「本月」最长的范围还早的才删）；按本次窗口起点清的话，多天范围里别的块的进度会被删掉（审核 R1 低-2）
      for (const [oldKey, old] of ownExclusionCache) if (old.startMs < Date.now() - 35 * DAY_MS) ownExclusionCache.delete(oldKey);
    }
    const task = entry.tail.then(async () => {
      // 同一个窗口起点留最近几份读到的状态（按终点排）：同一轮里几条绑定的「今天」终点差几秒，后定终点的先记下以后，先定终点的那条也能接着用
      // 终点不晚于自己的那一份，不用整段重读（审核 R1 中-4）
      const prior = [...entry.states].reverse().find((state) => state.endMs <= window.endMs) ?? null;
      // 窗口终点比记下的晚得多（从同一天起点查多天范围）不能直接用，要接着翻到新的终点（审核 R1：少减过 49430 额度）
      if (!settle && prior && Date.now() - prior.readAt < OWN_EXCLUSION_REUSE_MS && window.endMs - prior.endMs < OWN_EXCLUSION_REUSE_MS && covers(prior.result.coverage)) return prior.result;
      // 结账先读管理员名单（fresh）：沿用的那份是按当时的名单算的，名单变了（有人被降成普通用户、新加了管理员）就不能沿用（审核 #127 中-1）
      const { adminSet } = await readOwnAdminDirectory(rt, own, settle ? (freshSince != null ? { freshSince } : { fresh: true }) : {});
      const adminKey = [...adminSet].sort().join("\u0000");
      const sameAdmins = prior?.adminKey === adminKey;
      // 同一个站点同一天，别的绑定刚对过账：结的是同一段窗口、名单一样，直接用，不再每条绑定各查一遍（每个站每天每个来源一个 stat）
      if (settle && prior?.verifiedEndMs === window.endMs && sameAdmins && Date.now() - prior.readAt < OWN_EXCLUSION_VERIFIED_REUSE_MS && covers(prior.result.coverage)) return prior.result;
      const sources = [...[...adminSet].sort().map((name) => ({ kind: "user", name })), ...OWN_CHANNEL_TEST_TOKEN_NAMES.map((name) => ({ kind: "token", name }))];
      const partKey = (source) => `${source.kind}:${source.name}`;
      const parts = new Map();
      // 一个来源接一个来源读（不并发）：每段窗口的自营一侧同一时刻只多一个请求，几段并行时总数不会翻倍
      await mapWithConcurrency(sources, 1, async (source) => {
        const id = partKey(source);
        const before = prior?.parts.get(id) ?? null;
        const base = { kind: source.kind, name: source.name, startMs: window.startMs, endMs: window.endMs };
        // 窗口已经在过去的整段读：翻到一半失败（限流、网络）把进度记下，下一轮从下一页接着翻，不从头（审核 R1：一天约 432 页，限流 360 个/180 秒）
        const closed = window.endMs <= Date.now() - RECONCILIATION_SETTLE_DELAY_MS;
        // 今天的窗口终点每轮往后挪：进度记在「今天」一份上，接着翻时仍用当时的终点（用新终点，页码会被新写进来的行挤歪、前面几页的新行漏掉），
        // 翻完再按编号增量补一次到现在（审核 R1 中-2：一个来源一天超过约 360 页，限流下每轮从第 1 页重来永远翻不完）
        const pendingKey = JSON.stringify(closed ? [id, window.endMs] : [id, "open"]);
        const read = async (from, shouldContinue = null) => {
          const resume = !from ? entry.pending.get(pendingKey) ?? null : null;
          const readEndMs = resume?.endMs ?? window.endMs;
          let usedEndMs = readEndMs; // 补页那一次失败，进度记的是补页用的终点，不是前面翻的那个（审核 R1 中-2：不然补到一半的页下一轮漏掉）
          try {
            let part = await queryOwnLogSource(own, { ...base, endMs: readEndMs, previous: from, resume, shouldContinue });
            entry.pending.delete(pendingKey);
            if (part && readEndMs < window.endMs) {
              usedEndMs = window.endMs;
              part = await queryOwnLogSource(own, { ...base, previous: part });
            }
            return part;
          } catch (err) {
            if (!from && err?.resume) entry.pending.set(pendingKey, { ...err.resume, endMs: usedEndMs });
            throw err;
          }
        };
        // 窗口已经在过去的、整段读用户来源：翻页和按渠道查 stat 挑请求少的（总指挥、审核 10-25）。翻页要 ⌈行数 ÷ 100⌉ 页（行数先用 page_size=1 的
        // total 拿，老版本不给 total 就只能翻页）；按渠道 stat 是「要算的渠道数 × （1 + 这个用户名下转售的 Key 数）」次，和日志条数无关。
        // 按渠道 stat 读的只覆盖当时要算的渠道，后面别的绑定要算别的渠道时合起来重读。结果和选法打进日志（debug），方便量。
        const listBefore = before && before.coverage === undefined ? before : null;
        // 按渠道 stat 读（只覆盖 channels 这几个渠道）
        // into：已经按渠道 stat 读过的那一份，只补查它没覆盖的渠道，合进去（不重查已经查过的，审核 R1 中-3）
        const statRead = async (channels, tokens, total, rows = null, into = null) => {
          const out = into
            ? { ...into, byChannel: new Map(into.byChannel), byToken: new Map([...into.byToken].map(([key, value]) => [key, new Map(value)])), coverage: new Set([...into.coverage, ...channels]) }
            : { byChannel: new Map(), byToken: new Map(), byUser: new Map(), seen: total ?? await queryOwnLogSourceTotal(own, base), maxId: null, coverage: new Set(channels), rows };
          for (const channel of channels) {
            const quota = await queryOwnUserChannelStat(own, { name: source.name, channel, startMs: window.startMs, endMs: window.endMs });
            if (quota) out.byChannel.set(channel, quota);
            for (const token of tokens) {
              const tokenQuota = await queryOwnUserChannelStat(own, { name: source.name, channel, tokenName: token, startMs: window.startMs, endMs: window.endMs });
              if (tokenQuota) { if (!out.byToken.has(token)) out.byToken.set(token, new Map()); out.byToken.get(token).set(channel, tokenQuota); }
            }
          }
          return out;
        };
        // 整段读这个来源：翻页读第一页就知道行数（total）；这时觉得翻页比按渠道 stat 贵，就停下改按渠道 stat（第一页已经读了，没有额外请求）
        const readSmart = async (total) => {
          if (source.kind !== "user" || !closed || listBefore || !wantedChannels.length) return read(listBefore);
          const tokens = resoldAdminKeysOf(own).filter((key) => key.username === source.name).map((key) => String(key.tokenName));
          // 已经按渠道 stat 读过：覆盖了要算的渠道就沿用（结账时全站总额度没变才沿用，变了说明有晚到的日志，重读）；
          // 没覆盖的只补查缺的渠道，不是一条绑定换一次并集就整个重查（K 条单渠道绑定会是 1+2+…+K 次）
          if (before?.coverage instanceof Set && sameEnd) {
            const missing = wantedChannels.filter((channel) => !before.coverage.has(channel));
            if (!missing.length && (total == null || before.seen === total)) return before;
            const cost = missing.length * (1 + tokens.length);
            if (before.seen === (total ?? before.seen) && (before.rows == null ? true : cost < Math.ceil(before.rows / 100))) return statRead(missing, tokens, total ?? before.seen, before.rows, before);
          }
          const channels = [...new Set(wantedChannels)].sort((x, y) => x - y);
          const statCost = channels.length * (1 + tokens.length);
          let choice = null;
          const part = await read(null, ({ total: rows }) => {
            const pagesCost = rows == null ? Infinity : Math.ceil(rows / 100);
            choice = { rows, pagesCost, statCost, useStat: statCost < pagesCost };
            // 选法变了才打一行（不带用户名和站点地址）
            const line = `${choice.useStat ? "按渠道 stat" : "翻页"}`;
            if (entry.lastChoice?.get(id) !== line) {
              (entry.lastChoice ||= new Map()).set(id, line);
              console.debug(`自营收入：管理员日志整段读 来源 ${source.kind}#${[...adminSet].sort().indexOf(source.name)} 行数 ${rows ?? "未知"} 翻页约 ${pagesCost} 次 按渠道 stat ${statCost} 次 → ${line}`);
            }
            return !choice.useStat;
          });
          return part ?? statRead(channels, tokens, total, choice?.rows ?? null);
        };
        // 渠道测试名字这个来源只是兜底：测试日志大多都记在管理员名下，管理员那一条已经扣了，兜底来源一条都不用扣，翻几百页是白翻（审核 CI：三个接口超时）。
        // 先用 stat 比一下：这个测试名字在窗口里的总额度 T，和各管理员名下的合计 S（每个管理员一次 stat）；T == S 说明全在管理员名下，
        // 这个来源不翻页、扣 0；T > S（有不在管理员名下的）才去翻。一共 1 + 管理员数 个 stat，代替几百页
        const emptyPart = (seen) => ({ byChannel: new Map(), byToken: new Map(), byUser: new Map(), seen, maxId: null });
        const tokenOnlyInAdmins = async (known) => {
          const total = known ?? await queryOwnLogSourceTotal(own, base);
          if (total === 0) return emptyPart(0);
          let inAdmins = 0;
          for (const name of adminSet) inAdmins += await queryOwnLogSourceTotal(own, { ...base, username: name });
          return inAdmins === total ? emptyPart(total) : null;
        };
        let part;
        // 今天（轮询）：渠道测试名字这两个来源只是兜底（测试大多记在管理员名下，管理员那一条已经扣了），10 分钟内读过的不再读，
        // 每轮平时只读管理员那几个来源；结账（settle）一定按总额度对账，那时的数是准的
        // 过去的窗口（整段在等待期以后才读的）不会再有新日志：读过就一直沿用，只在按渠道 stat 读的那份没覆盖要算的渠道时补查缺的
        const sameEnd = prior?.endMs === window.endMs; // 沿用的那份读的是同一个终点才能用
        const doneBefore = before && sameEnd && closed && before.readAt >= window.endMs + RECONCILIATION_SETTLE_DELAY_MS
          && (!(before.coverage instanceof Set) || wantedChannels.every((channel) => before.coverage.has(channel)));
        if (!settle) part = doneBefore || (source.kind === "token" && before && Date.now() - before.readAt < OWN_EXCLUSION_FALLBACK_REUSE_MS && (!closed || sameEnd)) ? before
          : { ...((source.kind === "token" && await tokenOnlyInAdmins(null)) || await readSmart(null)), readAt: Date.now() };
        else {
          const total = await queryOwnLogSourceTotal(own, base);
          // 同一天别的绑定刚结过（10 分钟内）、这个来源的总额度没变：渠道测试名字这个来源的那份直接沿用，不再每条绑定各查一遍
          // 「1 + 管理员数」个 stat（审核 CI：开了定时测试的站，每天结 80 条绑定从 1.2 秒变成 7–14 秒）
          const recent = before && sameEnd && sameAdmins && Date.now() - before.readAt < OWN_EXCLUSION_VERIFIED_REUSE_MS && before.seen === total;
          if (total === 0) part = emptyPart(0);
          else if (source.kind === "token" && recent) part = before;
          else if (source.kind === "token" && (part = await tokenOnlyInAdmins(total))) { /* 全在管理员名下：不翻页 */ }
          else {
            part = await readSmart(total);
            // 累计和总额度对不上：只重翻这一个来源；本来就是整段翻的（没有上一份累计）再翻一遍也一样，不重翻
            if (part.seen !== total && listBefore) part = await read(null);
          }
        }
        parts.set(id, part.readAt == null ? { ...part, readAt: Date.now() } : part);
      });
      const byChannel = new Map();
      const add = (channel, quota) => byChannel.set(channel, (byChannel.get(channel) ?? 0) + quota);
      for (const source of sources) {
        const part = parts.get(partKey(source));
        for (const [channel, quota] of part.byChannel) add(channel, quota);
        if (source.kind === "user") {
          // 转售的管理员 Key 照样算收入：它名下的行不减
          for (const key of resoldAdminKeysOf(own)) {
            if (key.username !== source.name) continue;
            // 接口按名字筛是不分大小写的（MySQL 默认排序规则），这里也不分，和按渠道 stat、运营总览一致（审核 R1 低-5）
            for (const [token, channels] of part.byToken) if (token.toLowerCase() === String(key.tokenName).toLowerCase()) for (const [channel, quota] of channels) add(channel, -quota);
          }
        } else {
          // 管理员名下的测试记录已经在管理员那一条里减过了，不减两次
          for (const [user, channels] of part.byUser) if (adminSet.has(user)) for (const [channel, quota] of channels) add(channel, -quota);
        }
      }
      for (const [channel, quota] of byChannel) if (quota < 0) throw new Error("不算收入的额度算出负数");
      // 这份结果覆盖哪些渠道：全是翻页读的就是所有渠道；有按渠道 stat 读的，只覆盖那几个渠道的交集
      let coverage = "all";
      for (const part of parts.values()) if (part.coverage instanceof Set) coverage = coverage === "all" ? part.coverage : new Set([...coverage].filter((id) => part.coverage.has(id)));
      const result = { byChannel, coverage };
      entry.states = [...entry.states.filter((state) => state.endMs !== window.endMs), { parts, result, adminKey, endMs: window.endMs, readAt: Date.now(), ...(settle ? { verifiedEndMs: window.endMs } : {}) }]
        .filter((state, index, list) => Date.now() - state.readAt < OWN_EXCLUSION_STATE_KEEP_MS || index >= list.length - 1)
        .sort((a, b) => a.endMs - b.endMs).slice(-OWN_EXCLUSION_STATE_MAX);
      return result;
    }).catch((error) => {
      // 「今天」读用户列表或管理员日志短暂失败：10 分钟内沿用上一份（只影响今天那一格，不推送），超过才读不到（总指挥 10-25）。令牌作废、少权限照原样抛
      const live = window.endMs > Date.now() - RECONCILIATION_SETTLE_DELAY_MS;
      const lastGood = [...entry.states].sort((a, b) => b.readAt - a.readAt)[0];
      if (!settle && live && lastGood && isTransientOwnReadFailure(error) && Date.now() - lastGood.readAt < OWN_EXCLUSION_STALE_OK_MS && covers(lastGood.result.coverage)) return { ...lastGood.result, stale: true };
      throw error;
    });
    entry.tail = task.catch(() => {});
    return task;
  }

  // 一段窗口的渠道收费。reuse 时（只有轮询观测今天）读全了就记下（读到哪一刻为止）；记下的那份读到的时刻
  // 不早于这个自营站点没有新消费的起点，就沿用它，窗口终点换成这次的——这段时间里没有新的消费日志，每个渠道的合计都不会变。
  // 沿用前照样读一次 /api/status（同一轮共用）：额度换算变了、或者读不到，就照旧逐个读，不拿旧的换算算钱。
  // 这一轮里「查过全站以后、轮到这条绑定之前」那几秒的新消费，下一轮查全站时会发现，再照旧逐个读。
  async function ownRevenueWindow(own, rule, segmentWindow, { loadStatus, registry, reuse, settle = false }) {
    const channelIds = rule.channels.map((channel) => channel.channelId);
    // 键里带凭据指纹，和 markQuietOwnStations 里「换了凭据就不算安静」互为备份：换了自营站点的凭据，任一道都能挡住沿用旧的
    const key = JSON.stringify([own.id, credentialFingerprint(own), [...channelIds].sort((a, b) => a - b), segmentWindow.startMs, segmentWindow.timezone,
      resoldAdminKeysOf(own).map((item) => `${item.username}\u0000${item.tokenName}`).sort()]); // 转售 Key 改了马上换键（审核 R1 低-6）
    const cached = ownRevenueCache.get(key), quiet = registry?.ownQuietFrom?.get(own.id);
    // 最新那条日志的时刻（站点的钟）也要在记下的那份里：站点时钟偏快时，记下那份读到的时刻还没包住它，照旧现读
    if (reuse && cached && quiet && cached.endMs >= quiet.from && cached.endMs <= segmentWindow.endMs
      && (quiet.coveredFromMs == null || quiet.coveredFromMs <= cached.endMs)) {
      const status = await loadStatus().catch(() => null);
      if (status && status.quotaPerUnit === cached.result.quotaPerUnit) return { ...cached.result, window: { ...cached.result.window, endMs: segmentWindow.endMs } };
    }
    let reusedStale = false; // 管理员自用那一份是读失败后沿用的：这一次的结果不进缓存，不然站点一直没有新消费时超过 10 分钟也不换
    const result = await queryOwnChannelRevenue(own, { channelIds, startMs: segmentWindow.startMs, endMs: segmentWindow.endMs, timezone: segmentWindow.timezone, loadStatus,
      exclusion: async () => { const read = await ownExclusion(own, segmentWindow, { settle, channelIds, freshSince: registry?.startedAt ?? null }); if (read.stale) reusedStale = true; return read; } });
    // 只有轮询观测今天会沿用，别的窗口（昨天、结账、自定义、近 7 天、本月）不记
    if (reuse && result.state === "complete" && !result.emptySecondWindow && !reusedStale) {
      ownRevenueCache.set(key, { endMs: segmentWindow.endMs, result });
      // 只留今天的：键里有窗口起点，过了零点的旧键不会再用到
      for (const [cachedKey, entry] of ownRevenueCache) if (entry.endMs < segmentWindow.endMs - 2 * DAY_MS) ownRevenueCache.delete(cachedKey);
    }
    return result;
  }

  // 一段窗口的渠道收入，多天的按天拼（总指挥 10-25 定）：整天的块先看账本，已经固定的用账本里存的按渠道额度（R1 以后存的是扣过管理员自用的净额，
  // R1 以前固定的日子里是没扣的，不回头改），只有没固定的块现读；连着的没固定的块合成一段读，不一天一天读。这样近 7 天、本月不用把整段日志翻一遍
  // （撞页数上限、限流）。一天以内（今天、昨天、结账）就是一块，不拼。拼的代码在 lib/reconciliation-stitch.js，以后 F、G 也用。
  async function ownRevenue(own, rule, segmentWindow, options) {
    const pieces = splitWindowByDays(segmentWindow);
    if (pieces.length < 2) return ownRevenueWindow(own, rule, segmentWindow, options);
    const wanted = rule.channels.map((channel) => channel.channelId);
    const fixed = await mapWithConcurrency(pieces, 4, async (piece) => {
      if (!piece.wholeDay) return null;
      try {
        const entry = await repository.latestLedgerEntry(rule.id, piece);
        const downstream = entry && ledgerSettlement(entry)?.result?.downstream;
        // 账本那一天的渠道要覆盖现在要算的每个渠道（后来加过渠道的话，那一天缺的渠道不能当 0），而且都是读全了的
        if (!downstream || downstream.state !== "complete" || !wanted.every((id) => downstream.channels?.some((row) => row.channelId === id && row.billingState === "complete" && row.amountUsd != null))) return null;
        return { ...downstream, startMs: piece.startMs };
      } catch { return null; }
    });
    // 没固定的天连着的并成一块读；但「已经过去的整天」和「今天（还在变）」不并在一起：过去的那块是已结束的窗口，管理员日志按
    // 「翻页还是按渠道 stat」挑便宜的（几十万行也就每个渠道 1 个 stat）；并进今天那一块就成了还在变的窗口，只能从头翻页，
    // 开了定时渠道测试的站一天四万多行、几天就是几千页（审核 CI：近 7 天、本月 60 秒超时）
    const closedBefore = Date.now() - RECONCILIATION_SETTLE_DELAY_MS;
    const groups = [];
    pieces.forEach((piece, index) => {
      if (fixed[index]) return;
      const closed = piece.endMs <= closedBefore;
      const last = groups.at(-1);
      if (last && last.endMs === piece.startMs && last.closed === closed) last.endMs = piece.endMs;
      else groups.push({ startMs: piece.startMs, endMs: piece.endMs, index, closed });
    });
    const live = await Promise.all(groups.map((group) => ownRevenueWindow(own, rule, { ...segmentWindow, startMs: group.startMs, endMs: group.endMs }, { ...options, reuse: false })));
    // 不满一秒的头尾块读不出东西（emptySecondWindow）：不算一块；整段都是这样的就照原样返回
    const readable = live.map((result, index) => ({ ...result, startMs: groups[index].startMs })).filter((result) => !result.emptySecondWindow);
    if (!readable.length && !fixed.some(Boolean)) return live[0];
    const merged = stitchChannelRevenue([...fixed.filter(Boolean), ...readable], wanted);
    const first = [...readable, ...fixed.filter(Boolean)].find((result) => result.billingTimezone) ?? {};
    return { ...merged,
      billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION,
      window: segmentWindow, billingTimezone: first.billingTimezone ?? null };
  }

  function costOwnerFor(rule, canonicalKey, registry) {
    // 已解除、锚定过的：解除前这把 Key 只有它在用（active_token_key 唯一键保证），算唯一；账号换了人（身份对不上）就算不出
    if (rule.archivedAt) return rule.canonicalKey && canonicalKey === rule.canonicalKey
      ? { state: "unique", ownerId: rule.id, ruleIds: [rule.id] } : { state: "unknown", ownerId: null, ruleIds: [rule.id] };
    const current = registry.resources.get(rule.upstreamStationId)?.station;
    const matching = [];
    const unknown = [];
    for (const candidate of registry.rules.filter((item) => item.enabled && item.tokenId === rule.tokenId)) {
      const resource = registry.resources.get(candidate.upstreamStationId);
      if (!resource?.identity) {
        if (!resource?.station || billingPanel(resource.station) === billingPanel(current)) unknown.push(candidate.id);
        continue;
      }
      const key = canonicalBillingKey(resource.station, resource.identity, candidate.tokenId);
      if (key === canonicalKey && (!candidate.canonicalKey || candidate.canonicalKey === key)) matching.push(candidate.id);
    }
    if (unknown.length || !rule.enabled) return { state: "unknown", ownerId: null, ruleIds: unknown.length ? unknown.sort() : [rule.id] };
    matching.sort();
    return { state: matching.length > 1 ? "duplicate" : "unique", ownerId: matching[0] || rule.id, ruleIds: matching };
  }

  // 已解除的绑定补结某一天（C3）：这天里别的绑定（启用的，或最近也解除了、那段时间还占着的）也占着同一个渠道、或同一把 Key 时，
  // 和启用时一样挡住（DUPLICATE_CHANNEL_ASSIGNMENT、CANONICAL_KEY_CONFLICT），不然同一个渠道的收入、同一把 Key 的成本会在账本里算两遍（审核 C3 中-1）
  function archivedClash(rule, window, registry) {
    // 这条绑定这天自己的区间：从它的核算起点（含当天换绑的下限）到解除的时刻，不是整天
    const start = Math.max(window.startMs, reconciliationAccountingStart(rule) ?? window.startMs);
    const end = Math.min(window.endMs, Number(rule.archivedAtMs));
    const sharing = { channel: [], key: [] };
    for (const other of registry.rules) {
      if (other.id === rule.id) continue;
      const otherStart = reconciliationAccountingStart(other) ?? Date.parse(other.createdAt);
      const otherEnd = other.archivedAtMs == null ? Infinity : Number(other.archivedAtMs);
      if (!(otherStart < end && otherEnd > start)) continue;
      if (other.ownStationId === rule.ownStationId && other.channels.some((channel) => rule.channels.some((mine) => mine.channelId === channel.channelId))) sharing.channel.push(other.id);
      if (rule.canonicalKey && other.canonicalKey === rule.canonicalKey) sharing.key.push(other.id);
    }
    return sharing;
  }

  async function ownChannelsFor(station, { force = false } = {}) {
    const credential = credentialFingerprint(station);
    const cached = ownChannelsCache.get(station.id);
    if (!force && cached?.credential === credential && Date.now() - cached.at < 10 * 60000) return cached.value;
    const request = Symbol();
    ownChannelsRequests.set(station.id, request);
    const value = await queryOwnChannels(station);
    if (ownChannelsRequests.get(station.id) === request) ownChannelsCache.set(station.id, { at: Date.now(), credential, value });
    return value;
  }

  // 只读查询不核验、不改写账单能力；观测（轮询、刷新）才会核验并保存。
  async function upstreamWindowFor(upstream, metadata, token, window, { readOnly }) {
    return queryKeyReconciliationStat(upstream, {
      token, metadata, timezone: window.timezone, capabilityStore: billingCapabilityStore, readOnly,
      startMs: window.startMs,
      endMs: window.endMs,
      // 元数据已用同一 PAT 读到身份和 /api/status（与 Key 校验同一份观察），各分段直接复用，不再逐段探测。
      userId: metadata.userId,
      status: { quotaPerUnit: metadata.quotaPerUnit, version: metadata.version },
    });
  }

  // 一段的上游成本（K1c）：这一段里每把 Key 各取一次再相加（lib/reconciliation-keys.js）。每段只有绑定自己那把（或分段没带 Key）时，
  // 就是原来的单次取数，结果逐字不变；多把 Key、已删 Key 给 K2b 开段以后用。Key 在别的上游里（K2b 的事）这一版读不了，当 Key 身份对不上
  async function upstreamWindowForSegment(upstream, metadata, token, segment, window, { readOnly, upstreamStationId }) {
    let wanted = segmentKeyTokens({ segmentKeys: segment?.keys, ruleToken: token, metadata, upstreamStationId });
    // Sub2API 已删 Key 按「总量减别的 Key」算（querySub2DeletedKeyStat）：传进来的 metadata 可能是这一轮缓存的（5 分钟内），
    // 「别的 Key」目录里刚建的、已经有用量的新 Key 还没进来，减法会把新 Key 的钱算进已删 Key。观测/结账（非只读）时强制重读一次
    // Key 目录再判一遍：这一轮内同一个上游重读过就沿用缓存，不会每段都重读（K2b 落地前必须解决，审核 #129 M2）。
    // New API 的已删 Key 按名字直接取（queryNewApiTokenStat），不走这个减法，不用重读
    const isSub2 = upstream.type === "sub2api" || upstream.type === "sub2api-password";
    if (!readOnly && isSub2 && wanted.some((item) => item.deleted)) {
      metadata = await metadataFor(upstream, { force: true, timezone: window.timezone });
      wanted = segmentKeyTokens({ segmentKeys: segment?.keys, ruleToken: token, metadata, upstreamStationId });
    }
    if (wanted.length === 1 && (wanted[0].own || wanted[0].token?.id === token?.id)) return upstreamWindowFor(upstream, metadata, token, window, { readOnly });
    if (wanted.some((item) => item.foreign)) throw codedError("UPSTREAM_KEY_UNVERIFIED", "分段里有别的上游的 Key，这一版读不了");
    return sumKeyStats(await Promise.all(wanted.map((item) => upstreamWindowFor(upstream, metadata, item.token, window, { readOnly }))));
  }

  // 按 Key 整体取数的规则（scoped，生产的绑定都是）整窗口只带最新那一段（currentSegment），换过 Key 的窗口里旧 Key 换之前的用量
  // 和过渡段 [a, b) 里旧 Key 那份都取不到（上游成本少算）。窗口里各段用的 Key 不一样时，按段 ∩ 窗口切成几截、各取各的 Key 再相加
  // （lib/reconciliation-keys.js 的 keyPiecesOf；各段 Key 一样、没换过 Key 的返回 null，走原来的整窗单次取数，结果逐字不变）。
  // 结果的窗口还是整窗（和请求对得上，不触发 BILLING_WINDOW_MISMATCH）。
  // Sub2API 只能按整天读账单，切不开中途的窗口：整窗每把用过的 Key 各取一次全天再相加（专用账号下旧 Key 换掉以后没有用量、
  // 新 Key 换上以前没有用量，不会重复，k-plan 3.5）；一把 Key 在两个绑定之间挪过的情况这一版先不结账（见 applyKeyAgentChangesFor）
  async function upstreamWindowForScopedSegments(upstream, metadata, token, segments, currentSegment, window, options) {
    const pieces = keyPiecesOf(segments, window, token?.id);
    if (!pieces) return upstreamWindowForSegment(upstream, metadata, token, currentSegment, window, options);
    const isSub2 = upstream.type === "sub2api" || upstream.type === "sub2api-password";
    let sources = pieces;
    if (isSub2) {
      // copySegment 的 overrides 不管 keys（keys 是不可枚举属性，照原段拷），所以 keys 要拷完再换
      const merged = copySegment(currentSegment);
      merged.keys = [...new Map(pieces.flatMap(({ segment }) => segment.keys?.length ? segment.keys : [{ upstreamStationId: upstreamStation(options.upstreamStationId)?.id, tokenId: token?.id, tokenName: token?.name }])
        .map((key) => [`${key.upstreamStationId ?? ""}:${key.tokenId}`, key])).values()];
      sources = [{ segment: merged, window }];
    }
    const results = await Promise.all(sources.map((piece) => upstreamWindowForSegment(upstream, metadata, token, piece.segment, piece.window, options)));
    const summed = sumKeyStats(results);
    return { ...summed, window: { ...summed.window, startMs: window.startMs, endMs: window.endMs } };
  }

  function tokenNameIsUnique(metadata, token) {
    return metadata.platform === "sub2api" || metadata.tokens.filter((item) => item.name === token.name).length === 1;
  }

  async function canonicalRules(canonicalKey, tokenId, { excludeRuleId = null } = {}) {
    const rules = (await repository.listRules()).filter((rule) => rule.enabled && rule.id !== excludeRuleId && rule.tokenId === tokenId);
    const identities = new Map();
    return (await mapWithConcurrency(rules, 4, async (rule) => {
      const configured = upstreamStation(rule.upstreamStationId);
      const station = configured && { ...configured };
      if (!billingStation(station)) return null;
      if (!identities.has(station.id)) identities.set(station.id, metadataFor(station).catch(() => null));
      const metadata = await identities.get(station.id);
      if (credentialFingerprint(upstreamStation(station.id) || {}) !== credentialFingerprint(station)) {
        throw codedError("AUTHORIZATION_CHANGED", "上游的登录信息在这期间改过，请刷新后再试");
      }
      if (!metadata || canonicalBillingKey(station, metadata, tokenId) !== canonicalKey) return null;
      if (rule.canonicalKey && rule.canonicalKey !== canonicalKey) {
        throw codedError("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED"));
      }
      verifiedRuleCredentials.set(rule, credentialFingerprint(station));
      return rule;
    })).filter(Boolean);
  }

  async function validateInput(input, { excludeRuleId = null, authorization = null, existingRule = null, readContext = null } = {}) {
    const configuredUpstream = authorization?.station || upstreamStation(String(input?.upstreamStationId || ""));
    const upstream = configuredUpstream && { ...configuredUpstream };
    if (!billingStation(upstream)) throw codedError("UPSTREAM_NOT_FOUND", "找不到这个上游");
    const configuredOwn = existingRule ? upstreamStation(existingRule.ownStationId) : ownStation();
    const own = configuredOwn && { ...configuredOwn };
    if (!own || !own.isOwn || own.type !== "newapi") throw codedError("OWN_STATION_UNSET", OWN_STATION_UNSET);
    const tokenId = finite(input?.tokenId);
    if (tokenId == null || tokenId <= 0) throw codedError("KEY_REQUIRED", "请选择 Key");
    const channelIds = [...new Set((Array.isArray(input?.salesChannelIds) ? input.salesChannelIds : [])
      .map(Number).filter((id) => Number.isFinite(id) && id > 0))];
    if (!channelIds.length) throw codedError("CHANNEL_REQUIRED", "请至少选一个渠道");
    const [metadata, channels, ownIdentity] = await Promise.all([
      authorization?.metadata || metadataFor(upstream, { force: true, timezone: input?.timezone }),
      previewRead(readContext, own, "channels", () => ownChannelsFor(own, { force: true })),
      previewRead(readContext, own, "identity", () => queryAccountIdentity(own)),
    ]);
    const canonicalKey = canonicalBillingKey(upstream, metadata, tokenId);
    if (!canonicalKey) throw codedError("COST_OWNER_UNVERIFIED", issueText("COST_OWNER_UNVERIFIED"));
    const candidates = (await repository.listRules()).filter((rule) => {
      if (rule.id === excludeRuleId || rule.tokenId !== tokenId || !(rule.enabled || rule.upstreamStationId === upstream.id)) return false;
      const configured = upstreamStation(rule.upstreamStationId);
      return !configured || billingPanel(configured) === billingPanel(upstream);
    });
    const identities = new Map([[upstream.id, Promise.resolve(metadata)]]);
    const matches = (await mapWithConcurrency(candidates, 4, async (rule) => {
      const configured = upstreamStation(rule.upstreamStationId);
      if (!billingStation(configured)) throw codedError("COST_OWNER_UNVERIFIED", issueText("COST_OWNER_UNVERIFIED"));
      if (!identities.has(configured.id)) identities.set(configured.id,
        previewRead(readContext, { ...configured }, "identity", () => queryAccountIdentity({ ...configured })));
      const identity = await identities.get(configured.id);
      if (canonicalBillingKey(configured, identity, tokenId) !== canonicalKey) return rule.upstreamStationId === upstream.id ? rule : null;
      if (rule.canonicalKey && rule.canonicalKey !== canonicalKey && rule.upstreamStationId !== upstream.id) {
        throw codedError("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED"));
      }
      verifiedRuleCredentials.set(rule, credentialFingerprint(configured));
      return rule;
    })).filter(Boolean);
    if (existingRule && !matches.some((rule) => rule.id === existingRule.id)) matches.push(existingRule);
    const enabledMatches = matches.filter((rule) => rule.enabled);
    if (!existingRule && enabledMatches.length) matches.splice(0, matches.length, ...enabledMatches);
    if (matches.length > 1) {
      throw codedError("CANONICAL_KEY_CONFLICT", issueText("CANONICAL_KEY_CONFLICT"));
    }
    if (matches[0] && matches[0].ownStationId !== own.id) {
      throw codedError("RULE_OWN_STATION_CONFLICT", issueText("SOURCE_BINDING_UNCONFIRMED"));
    }
    const conflicts = await repository.findChannelConflicts(channelIds, { excludeRuleId: matches[0]?.id || excludeRuleId });
    if (conflicts.length) throw channelConflict(conflicts, channels);
    const token = metadata.tokens.find((item) => item.id === tokenId);
    if (!token) throw codedError("KEY_INVALID_OR_DENIED", issueText("KEY_INVALID_OR_DENIED"));
    if (!tokenNameIsUnique(metadata, token)) throw codedError("TOKEN_NAME_AMBIGUOUS", KEY_NAME_AMBIGUOUS_TEXT);
    if (token.status !== 1) throw codedError("KEY_DISABLED", KEY_DISABLED_TEXT);
    if ((metadata.platform !== "sub2api" && !token.group) || token.group === "auto" || token.crossGroupRetry) {
      throw codedError("KEY_GROUP_UNSUPPORTED", KEY_GROUP_TEXT);
    }
    const byId = new Map(channels.map((channel) => [Number(channel.id), channel]));
    const missing = channelIds.filter((id) => !byId.has(id));
    if (missing.length) throw codedError("CHANNEL_SOURCE_CHANGED", "选的渠道在自营站点里找不到了，请刷新渠道列表后重新预览");
    const actualOwnSource = ownSourceFor(own, ownIdentity);
    if (input?.ownSource && input.ownSource.namespaceKey !== actualOwnSource.namespaceKey) {
      throw codedError("PREVIEW_BASIS_CHANGED", "自营站点有变化，请重新预览");
    }
    return {
      upstream,
      own,
      token,
      metadata,
      timezone: ruleTimezoneFor(existingRule || matches[0] || null, input?.timezone),
      canonicalKey,
      ownSource: actualOwnSource,
      existingRule: existingRule || matches[0] || null,
      validationCredential: sourceCredentialFingerprint(upstream, own),
      channels: channelIds.map((id) => ({ channelId: id, name: String(byId.get(id).name || `渠道 #${id}`) })),
    };
  }

  async function validateMutableRuleInput(existing, input) {
    const own = upstreamStation(existing.ownStationId);
    if (!own || !own.isOwn || own.type !== "newapi") throw codedError("OWN_STATION_UNSET", OWN_STATION_UNSET);
    const channelIds = [...new Set((Array.isArray(input?.salesChannelIds) ? input.salesChannelIds : [])
      .map(Number).filter((channelId) => Number.isFinite(channelId) && channelId > 0))];
    if (!channelIds.length) throw codedError("CHANNEL_REQUIRED", "请至少选一个渠道");
    const timezone = ruleTimezoneFor(existing, input?.timezone);
    const [channels, conflicts] = await Promise.all([
      ownChannelsFor(own, { force: true }),
      repository.findChannelConflicts(channelIds, { excludeRuleId: existing.id }),
    ]);
    if (conflicts.length) throw channelConflict(conflicts, channels);
    const byId = new Map(channels.map((channel) => [Number(channel.id), channel]));
    const missing = channelIds.filter((channelId) => !byId.has(channelId));
    if (missing.length) throw codedError("CHANNEL_SOURCE_CHANGED", "选的渠道在自营站点里找不到了，请刷新渠道列表后重新预览");
    return {
      timezone,
      channels: channelIds.map((channelId) => ({ channelId, name: String(byId.get(channelId).name || `渠道 #${channelId}`) })),
    };
  }

  function financialFields(valid, input) {
    return { upstreamStationId: valid.upstream.id || null, ownStationId: valid.own.id, tokenId: valid.token.id,
      tokenName: valid.token.name, fixedGroup: valid.token.group, initialRatio: valid.metadata.groups?.[valid.token.group]?.ratio ?? null,
      timezone: valid.timezone, enabled: input?.enabled == null ? valid.existingRule?.enabled ?? true : input.enabled !== false, provider: valid.metadata.platform,
      canonicalKey: valid.canonicalKey, billingPolicy: "immediate", ownSource: valid.ownSource,
      costCoverage: input?.costCoverage ?? valid.existingRule?.costCoverage ?? "unknown", coverageDeclaration: input?.coverageDeclaration ?? valid.existingRule?.coverageDeclaration,
      sourceBinding: input?.sourceBinding || null, channels: valid.channels, previewEffectiveFromMs: null };
  }

  function financialContext(valid, existing, policy, previewGuard = null) {
    const catalogue = rt.onboardingSource?.getSourceCatalogue?.();
    if (!catalogue?.ownSource || catalogue.stale || catalogue.ownSource.stationId !== valid.own.id
      || catalogue.ownSource.namespaceKey !== valid.ownSource.namespaceKey) {
      throw codedError("PREVIEW_BASIS_CHANGED", "自营站点有变化或还没确认，请重新预览");
    }
    const proposedChannelIds = policy.channels.map((channel) => channel.channelId).sort((a, b) => a - b);
    const byId = new Map(catalogue.channels.map((channel) => [channel.id, channel]));
    const channelRevisions = {};
    for (const id of proposedChannelIds) {
      const channel = byId.get(id);
      if (!channel || channel.missing) throw codedError("PREVIEW_BASIS_CHANGED", "选的渠道在自营站点里改过，请重新预览");
      channelRevisions[id] = channel.revision;
    }
    const ids = new Set([valid.own.id, valid.upstream.id, existing?.upstreamStationId,
      ...Object.keys(previewGuard?.basis?.resourceVersions || {}), ...Object.keys(previewGuard?.postSaveResourceVersions || {})].filter(Boolean));
    const resourceVersions = Object.fromEntries([...ids].sort().map((id) => {
      const station = upstreamStation(id);
      return [id, { authVersion: station?.authVersion || 1, resourceVersion: stationBusinessVersion(station) }];
    }));
    const capability = valid.metadata.capability || {};
    const keyVersion = createHash("sha256").update(JSON.stringify([valid.token.id, valid.token.name, valid.token.group, valid.token.status,
      !!valid.token.crossGroupRetry, valid.metadata.quotaPerUnit ?? null, valid.metadata.groups?.[valid.token.group]?.ratio ?? null,
      capability.state || null, capability.currency || null, capability.window || null, capability.reason || null,
      valid.metadata.billingTimezone?.state || null, valid.metadata.billingTimezone?.timezone || null])).digest("hex");
    return { basis: { ownSource: catalogue.ownSource, sourceVersion: catalogue.sourceVersion, channelRevisions, resourceVersions,
      accountIdentity: { provider: valid.metadata.platform, baseUrl: onboardingBaseUrl(valid.upstream.baseUrl), accountId: String(valid.metadata.accountId ?? valid.metadata.userId) },
      canonicalKey: valid.canonicalKey, tokenId: valid.token.id, keyVersion, existingRuleId: existing?.id || null,
      existingScopeVersion: existing?.scopeVersion || null, existingChannelIds: (existing?.channels || []).map((channel) => channel.channelId).sort((a, b) => a - b),
      proposedChannelIds, timezone: policy.timezone, billingEffectiveFromMs: existing?.billingEffectiveFrom ?? null,
      coverageDeclaration: policy.coverageDeclaration },
      // 范围有变化时确认那一刻才生效，生效时间不进预览摘要（预览和确认的时刻不同）。
      preview: { costCoverage: policy.costCoverage, billingEffectiveFromMs: policy.scopeChanged ? null : policy.billingEffectiveFrom,
        firstQueryableAtMs: policy.scopeChanged ? null : reconciliationBillingSchedule(policy).firstQueryableAtMs, scopeChanged: policy.scopeChanged },
      ...(previewGuard ? { postSaveResourceVersions: previewGuard.postSaveResourceVersions } : {}) };
  }

  function previewRequired() {
    return codedError("PREVIEW_REQUIRED", "改绑定要先预览，请重新预览后再确认");
  }

  function financialGuard(valid, previewGuard, kind = "append") {
    return (lockedRule, _channels, policy) => {
      if (previewGuard && lockedRule && !lockedRule.enabled && kind !== "replace") {
        throw codedError("PREVIEW_BASIS_CHANGED", "这条绑定已解除，请重新预览");
      }
      if (!policy.scopeChanged && !previewGuard) return;
      if (!previewGuard || typeof rt.onboardingSource?.assertPreviewGuard !== "function") throw previewRequired();
      const context = financialContext(valid, lockedRule, policy, previewGuard);
      rt.onboardingSource.assertPreviewGuard(previewGuard, context);
      const intent = normalizeReconciliationScopeIntent(kind, lockedRule?.id, { upstreamStationId: policy.upstreamStationId,
        tokenId: policy.tokenId, salesChannelIds: valid.channels.map((channel) => channel.channelId),
        timezone: policy.timezone, enabled: policy.enabled, coverageDeclaration: policy.coverageDeclaration }, lockedRule || {});
      if (JSON.stringify(intent) !== JSON.stringify(previewGuard.scopeIntent)) {
        throw codedError("PREVIEW_BASIS_CHANGED", "这次要改的和预览时不一样，请重新预览");
      }
      if (JSON.stringify(policy.sourceBinding || {}) !== JSON.stringify(context.basis.channelRevisions)) {
        throw codedError("PREVIEW_BASIS_CHANGED", "渠道和预览时不一样，请重新预览");
      }
    };
  }

  function assertRuleIdentity(existing, input) {
    if (String(input?.upstreamStationId || "") !== String(existing.upstreamStationId) || finite(input?.tokenId) !== Number(existing.tokenId)) {
      throw codedError("RULE_IDENTITY_IMMUTABLE", "上游账号和 Key 不在这里改；要换一把 Key，用「换 Key」");
    }
  }

  async function previewKeyScope(input, { authorization = null, replaceRuleId = null, readContext = null } = {}) {
    let target = null;
    if (replaceRuleId) {
      target = await repository.getRule(replaceRuleId);
      if (!target) throw ruleNotFound();
      assertRuleIdentity(target, input);
      input = normalizeReconciliationScopeIntent("replace", target.id, input, target).normalizedPutIntent;
    }
    const valid = await validateInput(input, { authorization, readContext, ...(target ? { excludeRuleId: target.id, existingRule: target } : {}) });
    if (valid.metadata.capability?.state !== "supported") {
      throw codedError("BILLING_CAPABILITY_UNVERIFIED", issueText("UPSTREAM_CAPABILITY_UNVERIFIED"));
    }
    const existingRule = valid.existingRule;
    if (!replaceRuleId && existingRule && !existingRule.enabled) {
      throw codedError("RULE_DISABLED", "这条绑定已解除");
    }
    const fields = financialFields(valid, input);
    const append = !replaceRuleId && !!existingRule;
    const preliminary = applyScopePolicy(existingRule, fields, Date.now(), { append });
    const context = financialContext(valid, existingRule, preliminary);
    fields.sourceBinding = context.basis.channelRevisions;
    const policy = applyScopePolicy(existingRule, fields, Date.now(), { append });
    const { basis, preview } = financialContext(valid, existingRule, policy);
    return { existingRule, basis, preview };
  }

  function participatingSource(previewGuard) {
    const source = billingSourceState();
    return { ...source, stationIds: [...new Set([...source.stationIds,
      ...Object.keys(previewGuard?.basis?.resourceVersions || {}), ...Object.keys(previewGuard?.postSaveResourceVersions || {})])] };
  }

  async function saveRule(input, { previewGuard = null } = {}) {
    return serializeWrite(async () => {
      const billingSource = participatingSource(previewGuard);
      const valid = await validateInput(input);
      const fields = financialFields(valid, input);
      fields.sourceBinding = input?.sourceBinding ?? previewGuard?.basis?.channelRevisions ?? null;
      const sourceRule = valid.existingRule || fields;
      const capturedCredential = currentSourceCredential(sourceRule);
      const saved = await withObservationSourceLock(sourceRule, capturedCredential, async () => {
        if (sourceCredentialFingerprint(upstreamStation(valid.upstream.id), upstreamStation(valid.own.id)) !== valid.validationCredential) return STALE_SCOPE;
        if (valid.existingRule) {
          if (credentialFingerprint(upstreamStation(valid.existingRule.upstreamStationId) || {}) !== verifiedRuleCredentials.get(valid.existingRule)) return STALE_SCOPE;
          // 复用原授权资源和 Key 身份，不因为另一份同账号资源出现而新建成本规则。
          const appended = await repository.appendChannels(valid.existingRule.id, valid.channels, {
            costCoverage: fields.costCoverage, sourceBinding: fields.sourceBinding,
            provider: fields.provider, canonicalKey: fields.canonicalKey,
            ownSource: fields.ownSource, coverageDeclaration: fields.coverageDeclaration, timezone: fields.timezone,
          }, { guard: financialGuard(valid, previewGuard) });
          clearBillingResults(appended.id);
          return appended;
        }
        const created = await repository.createRule(fields, { guard: financialGuard(valid, previewGuard) });
        clearBillingResults(created.id);
        return created;
      }, billingSource);
      if (saved === STALE_SCOPE) throw staleScope();
      return saved;
    });
  }

  async function updateRule(id, input, { previewGuard = null } = {}) {
    return serializeWrite(async () => {
      const existing = await repository.getRule(id);
      if (!existing) throw ruleNotFound();
      assertRuleIdentity(existing, input);
      const capturedCredential = currentSourceCredential(existing);
      const billingSource = participatingSource(previewGuard);
      let valid;
      if (previewGuard) valid = await validateInput(input, { excludeRuleId: id, existingRule: existing });
      else {
        const [mutable, identity, ownIdentity] = await Promise.all([validateMutableRuleInput(existing, input),
          queryAccountIdentity({ ...upstreamStation(existing.upstreamStationId) }), queryAccountIdentity({ ...upstreamStation(existing.ownStationId) })]);
        if ((existing.canonicalKey && canonicalBillingKey(upstreamStation(existing.upstreamStationId), identity, existing.tokenId) !== existing.canonicalKey)
          || (existing.ownSource && ownSourceFor(upstreamStation(existing.ownStationId), ownIdentity).namespaceKey !== existing.ownSource.namespaceKey)) {
          throw codedError("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED"));
        }
        valid = mutable;
      }
      const changedMembers = JSON.stringify(valid.channels.map((channel) => channel.channelId).sort((a, b) => a - b))
        !== JSON.stringify(existing.channels.map((channel) => channel.channelId).sort((a, b) => a - b));
      const fields = previewGuard ? financialFields(valid, input) : {
        upstreamStationId: existing.upstreamStationId, ownStationId: existing.ownStationId, tokenId: existing.tokenId,
        tokenName: existing.tokenName, fixedGroup: existing.fixedGroup, provider: existing.provider,
        canonicalKey: existing.canonicalKey, ownSource: existing.ownSource, channels: valid.channels, timezone: valid.timezone,
        enabled: input?.enabled == null ? existing.enabled : input.enabled !== false, costCoverage: input?.costCoverage ?? (changedMembers ? "unknown" : existing.costCoverage),
        coverageDeclaration: input?.coverageDeclaration ?? (input?.costCoverage != null && input.costCoverage !== existing.costCoverage
          ? { answer: input.costCoverage === "complete" ? "none" : "unknown" } : changedMembers ? { answer: "unknown" } : existing.coverageDeclaration),
        sourceBinding: input?.sourceBinding ?? existing.sourceBinding,
      };
      if (previewGuard) fields.sourceBinding = input?.sourceBinding ?? previewGuard.basis.channelRevisions;
      const candidate = applyScopePolicy(existing, fields);
      const completedValid = !candidate.scopeChanged && fields.enabled === existing.enabled && existing.canonicalKey && existing.ownSource
        && Object.keys(existing.sourceBinding || {}).length ? previewGuard ? valid
          : await validateInput(input, { excludeRuleId: id, existingRule: existing }) : null;
      const updated = await withObservationSourceLock(existing, capturedCredential, async () => {
        if (completedValid) {
          const completeFields = financialFields(completedValid, input);
          let policy = applyScopePolicy(existing, { ...completeFields, sourceBinding: existing.sourceBinding });
          completeFields.sourceBinding = financialContext(completedValid, existing, policy).basis.channelRevisions;
          policy = applyScopePolicy(existing, completeFields);
          if (policy.scopeChanged || completedValid.token.name !== existing.tokenName || completedValid.token.group !== existing.fixedGroup) throw previewRequired();
          if (previewGuard) {
            const intent = normalizeReconciliationScopeIntent("replace", id, { ...input, coverageDeclaration: policy.coverageDeclaration }, existing);
            if (previewGuard.scopeIntent?.kind !== "replace" || previewGuard.scopeIntent.targetRuleId !== id
              || JSON.stringify(previewGuard.scopeIntent.normalizedPutIntent) !== JSON.stringify(intent.normalizedPutIntent)) {
              throw codedError("PREVIEW_BASIS_CHANGED", "这次要改的和预览时不一样，请重新预览");
            }
            const context = financialContext(completedValid, existing, policy, previewGuard);
            // A completed retry is a read. Keep the original row proof only for
            // issuer/ref validation; source, Key and all resources stay current.
            rt.onboardingSource.assertPreviewGuard(previewGuard, { ...context, basis: { ...context.basis,
              existingScopeVersion: previewGuard.basis.existingScopeVersion, existingChannelIds: previewGuard.basis.existingChannelIds,
              billingEffectiveFromMs: previewGuard.basis.billingEffectiveFromMs }, preview: previewGuard.preview });
          }
          return existing;
        }
        const saved = await repository.updateRule(id, fields, { guard: financialGuard(valid, previewGuard, "replace") });
        clearBillingResults(id);
        return saved;
      }, billingSource);
      if (updated === STALE_SCOPE) throw staleScope();
      return updated;
    });
  }

  async function appendChannels(id, channelIds, confirmation = {}, { previewGuard = null } = {}) {
    return serializeWrite(async () => {
      const existing = await repository.getRule(id);
      if (!existing) throw ruleNotFound();
      const sourceCredential = currentSourceCredential(existing);
      const billingSource = participatingSource(previewGuard);
      const valid = await validateInput({ ...confirmation, upstreamStationId: existing.upstreamStationId, tokenId: existing.tokenId,
        salesChannelIds: channelIds, timezone: confirmation.timezone }, { excludeRuleId: id, existingRule: existing });
      const fields = financialFields(valid, { ...confirmation, costCoverage: confirmation.costCoverage ?? existing.costCoverage,
        coverageDeclaration: confirmation.coverageDeclaration ?? existing.coverageDeclaration });
      fields.sourceBinding = confirmation.sourceBinding ?? previewGuard?.basis.channelRevisions ?? existing.sourceBinding;
      const saved = await withObservationSourceLock(existing, sourceCredential, async () => {
        const appended = await repository.appendChannels(id, valid.channels, fields, { guard: financialGuard(valid, previewGuard) });
        clearBillingResults(id);
        return appended;
      }, billingSource);
      if (saved === STALE_SCOPE) throw staleScope();
      return saved;
    });
  }

  // 已结账窗口直接读结账结果，不再向上游取数。不看当前关联口径：结账后改关联、换 Key、换凭据，
  // 已结账的日子都不跟着重算；目前修正切换时间后，仅在轮询时重新结账昨天（账本写下一版）。
  // 单个自然日读账本；多日窗口仍读旧版结账记录。
  async function settledResult(rule, window) {
    try {
      if (billDayOf(window)) {
        const entry = await repository.latestLedgerEntry(rule.id, window);
        if (!entry) return null;
        const settlement = ledgerSettlement(entry);
        if (!settlement) throw new Error("Invalid settlement record");
        return settledFrom(rule, settlement);
      }
      // 结束不满等待期写下的确认记录不算结账（那时上游还在入账）：1a 之前窗口一结束就会写这种记录；现在也写得出来，
      // 比如多日窗口在等待期满前一刻开始取数、满了以后才保存。B2 起这种记录一律不认
      const record = await repository.latestSettlement(rule.id, window);
      return record && isSettledAt(window, record.generatedAt) ? settledFrom(rule, record) : null;
    } catch {
      // 读取失败不能当成没有固定账，否则会用上游后来补记的金额替代原账。
      throw codedError("HISTORY_UNAVAILABLE", issueText("HISTORY_UNAVAILABLE"));
    }
  }

  // 结账（settle）结成单日以后，整个结果按账本里最新那一版返回（金额、版本、固定时刻）：同一天两处一起固定、
  // 或者重结内容相同（B-L1）没写新版时，这一处不拿自己算出来的数（计划 C2a 2.5）。没结成、多日窗口照旧返回算出来的结果
  async function bookedResult(rule, result) {
    if (!billDayOf(result.window) || !settlementOutcome({ window: result.window, result, now: Date.now() }).ledger) return result;
    // persistResult 已经确认这次是真的写了新版（result.ledger 已经按账本的版本、来源、固定时刻补好），result 自己
    // 就是账本里最新那一版，不用再读一次（安全审核 C2a 低-3）；B-L1 那种内容相同没写新版的，result.ledger 没补，照旧读一次
    // 从账本读出来的结果（settledFrom）带最近确认的那份和成功时刻，这里补上，和读出来的一致（审核 C2a 第二轮低-3）
    if (result.ledger) return Object.assign(result, { lastSuccessfulAt: result.settledAt, lastConfirmed: snapshotReference({ generatedAt: result.settledAt, result }) });
    return await settledResult(rule, result.window) ?? result;
  }

  // 结账没写新版（重结的数比已固定的少很多）时，结果仍是账本里那一版，但要把原因带给 settleDay
  const withResettleBlocker = (booked, result) => (result.resettleBlocked ? Object.assign(booked, { resettleBlocked: result.resettleBlocked, resettleShrunk: result.resettleShrunk ?? null }) : booked);

  // 上一次成功的结果：单个自然日读账本最新一版，其余窗口读同一口径的确认记录。
  async function previousSuccess(rule, window, billingFingerprint) {
    if (!billDayOf(window)) return repository.latestSuccessfulResult(rule.id, window, billingFingerprint);
    const entry = await repository.latestLedgerEntry(rule.id, window);
    return entry ? ledgerSettlement(entry) : null;
  }

  function settledFrom(rule, record) {
    return { ...record.result, rule: { ...rule, ownSource: record.result.ownSource ?? null,
      fixedGroup: record.result.currentSegment?.group ?? rule.fixedGroup },
      lastSuccessfulAt: record.generatedAt, lastConfirmed: snapshotReference(record), settledAt: record.generatedAt,
      ...(record.ledger ? { ledger: record.ledger } : {}) };
  }

  // observe：锚定身份、记录分段切换和渠道状态、写快照、发通知，只由轮询、「刷新」和接入后的首次观测调用。
  // evaluate：只读已持久化的分段和锚定状态来计算，不写库、不通知；页面查询都走这条。
  // settle：结一个已经结束的日子（轮询回看和手动「重新读取」都走这条，计划 C2a）。强制重取，用已存的分段；
  //   不写分段、渠道状态、观测快照，不发告警；只按 settlementOutcome 写账本（多日写确认快照），结成了在同一个事务里删掉状态表那一行。
  // probe（只配 settle）：要人处理的日子到了重判的时刻，只走一遍取数前的判断，不取账单、不写库，返回 { probe: true, blocker }（计划 C2a 2.3）
  async function inspectRule(ruleId, window, { force = false, origin = "manual", ownerRegistry, mode = "observe", resettle: resettleOption = false, resettleRequestedAt = null, confirmShrink = false, confirmedAfter = null, trigger = null, probe = false, priorState = null } = {}) {
    const settle = mode === "settle";
    // 轮询回看带的是状态行里的请求时刻；resettle: true 是调用方（测试、手动）直接要求重结，没有请求时刻可比
    const resettle = resettleOption || resettleRequestedAt != null;
    const observe = mode !== "evaluate";
    if (settle) force = true;
    if (!ruleGenerations.has(ruleId)) ruleGenerations.set(ruleId, 0);
    // 结账（settle）才读已解除的绑定：补结解除前的日子（C3）；别的查询看不到已解除的
    const firstRule = await repository.getRule(ruleId, { includeArchived: settle });
    if (!firstRule || (firstRule.archivedAt && !archivedSettleable(firstRule))) throw ruleNotFound();
    const cacheKey = resultKey(firstRule, window);
    const requestCredential = currentSourceCredential(firstRule);
    const requestBilling = ownerRegistry.billingSource;
    const evaluateKey = isLiveReconciliationPreset(window.preset) ? `${cacheKey}:${window.endMs}:${requestCredential}:${requestBilling.ownerVersion}` : `${cacheKey}:${requestCredential}:${requestBilling.ownerVersion}`;
    const inflightKey = observe ? `${evaluateKey}:${settle ? (probe ? "probe" : "settle") : "observe"}${resettle ? `:resettle${resettleRequestedAt}` : ""}` : evaluateKey;
    const ttl = resultTtl(window);
    const cached = resultCache.get(cacheKey);
    if (!force && (!observe || cached?.observed) && cached?.sourceCredential === requestCredential
      && cached?.billingCredential === requestBilling.ownerVersion && Date.now() - cached.at < ttl
      // 观测写下的分段切换不会清缓存，用分段口径挡住切换前算出的结果。
      && reconciliationScopeFingerprint(firstRule, await repository.listSegments(ruleId)) === reconciliationScopeFingerprint(firstRule, cached.value.transitionSegments || [])) {
      return cached.value;
    }
    // 只读计算可以等同一窗口正在进行的观测；观测不能借只读计算的结果跳过写库。
    if (inflight.has(inflightKey)) return inflight.get(inflightKey);
    if (!observe && inflight.has(`${evaluateKey}:observe`)) return inflight.get(`${evaluateKey}:observe`);
    // 轮询正在结这一天时，只读计算也等它（结出来的就是账本里那一版）
    if (!observe && inflight.has(`${evaluateKey}:settle`)) return inflight.get(`${evaluateKey}:settle`);

    const inspectScope = async (rule, generation, billingSource, request) => {
      if (billingSourceState().version !== billingSource.version) return STALE_SCOPE;
      const currentUpstream = upstreamStation(rule.upstreamStationId);
      const currentOwn = upstreamStation(rule.ownStationId);
      const upstream = currentUpstream && { ...currentUpstream };
      const own = currentOwn && { ...currentOwn };
      // 成本计法和两侧汇率来自同一份配置；保存前由 billingSource 的财务版本再次核对。
      // 重结（改了切换时间）只该改分段影响到的金额：汇率和成本计法沿用账本里这天最新一版记下的，不用现在的设置
      // （不然只改了汇率、读数没变，重结也会写出新的一版，已固定的人民币利润跟着变；和 G「改上游设置，已固定的不变」同一个规矩）。
      // 账本里记的汇率是空的（当时没设置）就还是按没设置算，不因为现在设了汇率就算「内容变了」
      let savedLedger = null;
      if (settle && resettle && !probe) {
        try { const prior = await repository.latestLedgerEntry(rule.id, window); savedLedger = prior ? ledgerReference(prior) : null; } catch { throw codedError("HISTORY_UNAVAILABLE", issueText("HISTORY_UNAVAILABLE")); }
      }
      const financialSnapshot = ratesFor({ own, upstream, saved: savedLedger });
      if (savedLedger) {
        const unset = { cnyPerUsd: 1, source: "default" };
        if (savedLedger.rates?.income == null) financialSnapshot.income = unset;
        if (savedLedger.rates?.cost == null) financialSnapshot.cost = unset;
      }
      let sourceCredential = observationCredential(rule, upstream, own);
      request.sourceCredential = sourceCredential;
      if (!probe && settlementPrecheck({ window, now: Date.now(), resettle }).readSettled) {
        const settled = await settledResult(rule, window);
        if (settled) return settled;
      }
      const ownAvailable = !!own && own.isOwn && own.type === "newapi";
      const downstreamEvidence = async () => {
        if (!own || !own.isOwn || own.type !== "newapi") return null;
        const persistedSegments = await repository.listSegments(rule.id).catch(() => []);
        const scopedWindow = isScopedBillingPolicy(rule.billingPolicy) ? accountingWindow(rule, window) : null;
        const applicable = isScopedBillingPolicy(rule.billingPolicy)
          ? persistedSegments.length && scopedWindow ? [{ segment: persistedSegments[persistedSegments.length - 1], window: scopedWindow }] : []
          : persistedSegments
          .map((segment) => ({ segment, window: intersectSegment(window, segment) }))
          .filter((item) => item.window);
        if (!applicable.length) return null;
        try {
          const [catalogue, results] = await Promise.all([
            ownChannelsFor(own, { force: force && !settle }).catch(() => null),
            // 多天的范围也按天拼、带「其中管理员自用」，和别处同一条路（审核 R1 低-3）
            mapWithConcurrency(applicable, 6, ({ window: segmentWindow }) => ownRevenue(own, rule, segmentWindow, { loadStatus: () => ownStatusFor(ownerRegistry, own), registry: ownerRegistry, reuse: false, settle })
              .catch(() => null)),
          ]);
          const channelById = new Map((catalogue || []).map((channel) => [Number(channel.id), channel]));
          const channelsFor = (result) => rule.channels.map((channel) => {
            const billed = result?.channels?.find((item) => item.channelId === channel.channelId);
            const observed = channelById.get(channel.channelId);
            return {
              ...channel,
              state: catalogue ? (observed ? channelState(observed.status) : "missing") : "unknown",
              stateObservedAt: Date.now(),
              billingState: billed?.billingState || "unavailable",
              quotaUnits: billed?.quotaUnits ?? null,
              amountUsd: billed?.amountUsd ?? null,
              knownAmountUsd: billed?.amountUsd ?? null,
            };
          });
          const downstreamFor = (result, segmentWindow) => result ? {
            ...result, observedAt: Date.now(), window: result.window || segmentWindow, channels: channelsFor(result),
          } : {
            state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null,
            successfulCount: 0, expectedCount: rule.channels.length,
            billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION,
            observedAt: Date.now(), window: segmentWindow, channels: channelsFor(null),
          };
          const channels = rule.channels.map((channel) => {
            const rows = results.map((result) => result?.channels?.find((item) => item.channelId === channel.channelId)).filter(Boolean);
            const complete = rows.length === applicable.length && rows.every((item) => item.billingState === "complete" && item.amountUsd != null);
            const known = rows.some((item) => item.amountUsd != null);
            const observed = channelById.get(channel.channelId);
            return {
              ...channel,
              state: catalogue ? (observed ? channelState(observed.status) : "missing") : "unknown",
              stateObservedAt: Date.now(),
              billingState: complete ? "complete" : known ? "partial" : "unavailable",
              quotaUnits: complete ? rows.reduce((sum, item) => sum + item.quotaUnits, 0) : null,
              amountUsd: complete ? rows.reduce((sum, item) => sum + item.amountUsd, 0) : null,
              knownAmountUsd: known ? rows.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : null,
            };
          });
          const successfulCount = results.reduce((sum, result) => sum + (result?.successfulCount ?? 0), 0);
          const expectedCount = applicable.length * rule.channels.length;
          const complete = results.length === applicable.length && results.every((result) => result?.state === "complete");
          const known = results.some((result) => result?.knownAmountUsd != null);
          return {
            state: complete ? "complete" : known ? "partial" : "unavailable",
            window: results.length === 1 ? results[0]?.window || window : window,
            billingTimezone: commonBillingTimezone(window, results.map((result, index) => ({ ...result, requestedWindow: applicable[index].window }))),
            quotaUnits: complete ? results.reduce((sum, result) => sum + result.quotaUnits, 0) : null,
            quotaPerUnit: complete ? results[0]?.quotaPerUnit ?? null : null,
            amountUsd: complete ? results.reduce((sum, result) => sum + result.amountUsd, 0) : null,
            knownAmountUsd: known ? results.reduce((sum, result) => sum + (result?.knownAmountUsd ?? 0), 0) : null,
            successfulCount, expectedCount,
            billingSource: RECONCILIATION_BILLING_SOURCE,
            calculationVersion: RECONCILIATION_CALCULATION_VERSION,
            channels,
            segments: applicable.map(({ segment, window: segmentWindow }, index) => ({
              ...segment,
              window: segmentWindow,
              downstream: downstreamFor(results[index], segmentWindow),
            })),
          };
        } catch { return null; }
      };
      const unavailable = async (resultHealth, evidence = {}, save = true) => probe ? { probe: true, blocker: resultHealth.code } : persistUnavailable(rule, window, resultHealth, origin, {
        ...evidence,
        downstream: evidence.downstream ?? await downstreamEvidence(),
      }, generation, sourceCredential, billingSource, { save: save && observe && !settle });
      // 成本计法在下面这些提前返回之前就定：固定成本的毛利不看上游，上游一侧读不到（读不到账单、Key 用不了、
      // 目录或身份读不到、上游身份变了）时不挡，记成上游侧的参考问题，跳过上游、只取本站接着算。
      // 本站一侧（来源没确认、渠道重复、本站读不到、没分段）照旧挡；没锚定过的也照旧挡，免得以后锚到别人的 Key 上。
      const costBasis = financialSnapshot.costBasis;
      const anchored = !!rule.canonicalKey && !!rule.ownSource;
      const upstreamOptional = costBasis === "fixed" && !!upstream && anchored;
      let upstreamProblem = null;
      if (!billingStation(upstream)) {
        const problem = health("UPSTREAM_DATA_UNAVAILABLE", "找不到这个上游，或这个上游读不到账单");
        if (!upstreamOptional) return unavailable(problem, {}, anchored);
        upstreamProblem = problem;
      }

      const upstreamResource = ownerRegistry.resources.get(rule.upstreamStationId);
      const metadata = upstreamResource?.metadata;
      const metadataError = upstreamResource?.error;
      if (metadata) {
        const key = metadata.tokens.find((item) => item.id === rule.tokenId);
        // 目录里找不到绑定的 Key：下一轮把这个上游的目录和身份全部重读（P1b 的异常之一）
        if (!key) staleMetadata.add(rule.upstreamStationId);
        const detail = !key ? issueText("KEY_INVALID_OR_DENIED") : key.status !== 1 ? KEY_DISABLED_TEXT
          : key.name !== rule.tokenName ? "上游里这把 Key 改名了，去确认"
            : !tokenNameIsUnique(metadata, key) ? KEY_NAME_AMBIGUOUS_TEXT
              : key.group === "auto" || key.crossGroupRetry ? KEY_GROUP_TEXT : null;
        if (detail && !upstreamOptional) return unavailable(health("KEY_INVALID_OR_DENIED", detail), { metadata, token: key }, false);
        if (detail) upstreamProblem ||= health("KEY_INVALID_OR_DENIED", detail);
      }
      let identity, ownSource;
      identity = upstreamResource?.identity;
      const salesIdentity = ownerRegistry.resources.get(rule.ownStationId)?.identity;
      if (ownAvailable && salesIdentity) ownSource = ownSourceFor(own, salesIdentity);
      if (!identity) {
        const problem = metadataError ? upstreamErrorHealth(metadataError, upstreamResource) : health("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED"));
        if (!upstreamOptional) return unavailable(problem, {}, false);
        upstreamProblem ||= problem;
      }
      const actualKey = identity ? canonicalBillingKey(upstream, identity, rule.tokenId) : rule.canonicalKey;
      // 本站一侧对不上始终挡；上游身份变了是上游一侧的问题，固定成本时只作参考
      const upstreamChanged = !!rule.canonicalKey && rule.canonicalKey !== actualKey;
      if (upstreamChanged && upstreamOptional) upstreamProblem ||= health("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED"));
      // 自营站点的令牌作废、少了权限：站点上每条路都回 401/403，身份也读不到——这时说的是令牌，不是「上游账号或自营站点有变化」（审核 #107 中-1）
      const ownTokenError = !ownSource && ownAvailable && isAccessTokenError(ownerRegistry.resources.get(rule.ownStationId)?.error?.code)
        ? ownerRegistry.resources.get(rule.ownStationId).error : null;
      let identityIssue = ownTokenError
        ? { ...health(ownTokenError.code, issueText(ownTokenError.code)), side: "own", ...(ownTokenError.scope ? { missingScope: ownTokenError.scope } : {}) }
        : !ownSource || (upstreamChanged && !upstreamOptional) || (rule.ownSource && rule.ownSource.namespaceKey !== ownSource.namespaceKey)
        ? health("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED")) : null;
      // 结账（settle）和只读计算一样不锚定：锚定是今天的观测做的事，结账只写账本和状态行（计划 C2a 2.5）
      if (!identityIssue && !anchored && (!observe || settle)) {
        // 还没观测过就没有可靠口径，取上下游账单也只是白跑一趟。
        if (!identityIssues.has(rule.id)) return pendingResult(rule, window, issueText("PENDING"));
        identityIssue = identityIssues.get(rule.id);
      } else if (!identityIssue && !anchored) {
        try {
          const segments = await repository.listSegments(rule.id);
          const anchored = await withObservationSourceLock(rule, sourceCredential, () => repository.anchorRuleIdentity(rule.id,
            { provider: identity.provider, canonicalKey: actualKey, ownSource }, { expectedScopeFingerprint: reconciliationScopeFingerprint(rule, segments),
              allowInitialAnchoring: (upstream.authVersion || 1) === 1 && (own.authVersion || 1) === 1 }), billingSource);
          if (!anchored || anchored === STALE_SCOPE) return STALE_SCOPE;
          Object.assign(rule, anchored);
          identityIssues.delete(rule.id);
        } catch (err) {
          if (!["LEGACY_IDENTITY_UNVERIFIED", "SOURCE_BINDING_UNCONFIRMED"].includes(err?.code)) throw err;
          identityIssue = health(err.code, err.message);
          identityIssues.set(rule.id, identityIssue);
        }
      }
      if (!identityIssue && ownSource) {
        ownIdentities.set(own.id, { ownSource, resourceVersion: stationBusinessVersion(own) });
        sourceCredential = observationCredential(rule, upstream, own);
        request.sourceCredential = sourceCredential;
      }

      if (metadataError && (identityIssue || !upstreamOptional)) return unavailable(identityIssue || upstreamErrorHealth(metadataError, upstreamResource), {}, !identityIssue);
      if (metadataError) upstreamProblem ||= upstreamErrorHealth(metadataError, upstreamResource);
      const token = metadata?.tokens.find((item) => item.id === rule.tokenId);
      // 上游一侧读不到（只有固定成本、锚定过的会走到这里）：读到的目录和 Key 不当证据、也不拿来显示，也不拿它去读上游用量——上游账号可能已经换了人，
      // id 相同的 Key 是别人的。Key 名用绑定上存的；面板类型按绑定存的，旧绑定没存就按上游站点的类型
      const evidenceMetadata = upstreamProblem ? null : metadata, evidenceToken = upstreamProblem ? null : token;
      if (identityIssue) {
        const upstreamEvidence = !probe && evidenceToken && (!rule.canonicalKey || rule.canonicalKey === actualKey)
          ? await upstreamWindowFor(upstream, evidenceMetadata, evidenceToken, window, { readOnly: !observe || settle }).catch(() => null) : null;
        return unavailable(identityIssue, { metadata: evidenceMetadata, token: evidenceToken, upstream: upstreamEvidence }, false);
      }
      const canonicalKey = upstreamProblem ? rule.canonicalKey : canonicalBillingKey(upstream, metadata, token.id);
      if (!upstreamProblem && (canonicalKey !== actualKey || canonicalKey !== rule.canonicalKey)) {
        return unavailable(health("SOURCE_BINDING_UNCONFIRMED", issueText("SOURCE_BINDING_UNCONFIRMED")), { metadata, token }, false);
      }
      // K2b：这条绑定分组了或合组了（keyAgentRoundFor，k-plan §3.3），交给 K2c 重新分组；换成不在已加上游里的 Key（CHANNEL_KEY_UNMATCHED）、读不了完整 Key（KEY_REVEAL_DENIED）也走这里；从第一次认出冲突的那一刻
      // （b）起不结账、不开新段——宁可先不算，也不把钱算给错的那一条。只挡 b 及以后的窗口：b 以前已经结过、或者还没
      // 轮到结的日子，和这件事无关，不能因为今天冲突了就连累昨天（总指挥 10-26 定）
      // 只读查询（页面 evaluate）不判断，用库里持久化的事项（rule.keyIssue）：页面和需处理清单看到的是同一件事，
      // 不会在观测之前显示「实时」而这几天其实不会固定；观测的轮次用这一轮重新判断的结果（解开了就是没有）
      const keyIssue = ownerRegistry.keyIssues?.get(rule.id) ?? (ownerRegistry.keyAgentObserved === false ? rule.keyIssue : null);
      if (keyIssue && window.endMs >= keyIssue.sinceMs) {
        return unavailable(health(keyIssue.code, issueText(keyIssue.code), { sinceMs: keyIssue.sinceMs, ...(keyIssue.channelId != null ? { channelId: keyIssue.channelId } : {}), ...(keyIssue.upstreamStationId != null ? { upstreamStationId: keyIssue.upstreamStationId } : {}) }), { metadata, token }, false);
      }
      // K2b 例外三（binding-flow.md §2）：读取服务读不到新结果时，从最后一次读到的时刻起，这个站点下各渠道的数先不算
      // （实时·还在读取，过了零点也不固定）；连续 3 次才升成需处理 KEY_READER_UNREACHABLE（keyAgentExceptionIssueOf）。
      // 最后一次读到以前的日子不受影响；读到了、Key 没变就照常算，换了就是 [a, b) 过渡段（上面 keyAgentRoundFor）
      const readerDown = ownerRegistry.keyAgentDown?.get(rule.id);
      if (readerDown && window.endMs > readerDown.sinceMs) {
        return unavailable(health(readerDown.code, issueText(readerDown.code), { sinceMs: readerDown.sinceMs }), { metadata, token }, false);
      }
      const platform = evidenceMetadata?.platform ?? rule.provider ?? billingProviderOf(upstream);
      const persistedSegments = await repository.listSegments(rule.id);
      if (!persistedSegments.length) return unavailable(health("UPSTREAM_DATA_UNAVAILABLE", INCOMPLETE_DAY_TEXT), { metadata: evidenceMetadata, token: evidenceToken });
      const catalogueObserved = !upstreamProblem && metadata.groupsAvailable && metadata.groups[token.group]?.ratio != null;
      const currentRatio = catalogueObserved ? metadata.groups[token.group].ratio : null;
      const ratioObservedAt = Date.now();
      // 只读计算沿用已记录的分段；分组或倍率的切换由下一次观测记录。上游读不到时也沿用，不按读不到的目录改分段。
      const reconciliation = !observe || settle || upstreamProblem ? { segments: persistedSegments, currentSegment: persistedSegments[persistedSegments.length - 1], transitioned: false }
        : await withObservationSourceLock(rule, sourceCredential, () => repository.observeSource(rule.id, {
          groups: metadata.groupsAvailable ? metadata.groups : {},
          group: token.group,
          ratio: currentRatio,
          tokenName: token.name,
          detectedAt: ratioObservedAt,
        }), billingSource);
      if (reconciliation === STALE_SCOPE) return STALE_SCOPE;
      let segments = reconciliation.segments;
      let currentSegment = reconciliation.currentSegment;
      // 固定采购的上游用量不计成本（采购费作为固定成本），毛利 = 收入：上游 Key 账单取不全、成本归属未核验、
      // Key 还有没有其他用途、上游分组目录取不到，都只作参考，不挡结账。
      const upstreamSide = (issue) => ({ ...issue, side: "upstream", ...(costBasis === "fixed" ? { reference: true } : {}) });
      const issues = scopePolicyIssues(rule, window).map((issue) => costBasis === "fixed"
        ? upstreamSide({ ...issue, detail: COVERAGE_QUESTION }) : issue);
      if (ownerRegistry.duplicateSales.has(rule.id)) issues.push({ code: "DUPLICATE_CHANNEL_ASSIGNMENT", scope: "rule",
        detail: issueText("DUPLICATE_CHANNEL_ASSIGNMENT"), ruleIds: ownerRegistry.duplicateSales.get(rule.id), observedAt: Date.now() });
      const observedSource = sourceState(rule);
      if (observedSource.status !== "confirmed") issues.push({ code: "SOURCE_BINDING_UNCONFIRMED", scope: "source", detail: issueText("SOURCE_BINDING_UNCONFIRMED"), observedAt: Date.now() });
      if (rule.archivedAt) {
        const clash = archivedClash(rule, window, ownerRegistry);
        if (clash.channel.length) issues.push({ code: "DUPLICATE_CHANNEL_ASSIGNMENT", scope: "rule", detail: issueText("DUPLICATE_CHANNEL_ASSIGNMENT"), ruleIds: [rule.id, ...clash.channel].sort(), observedAt: Date.now() });
        if (clash.key.length) issues.push(upstreamSide({ code: "CANONICAL_KEY_CONFLICT", scope: "rule", detail: issueText("CANONICAL_KEY_CONFLICT"), ruleIds: [rule.id, ...clash.key].sort(), observedAt: Date.now() }));
      }
      const costOwner = costOwnerFor(rule, canonicalKey, ownerRegistry);
      if (costOwner.state === "unknown") issues.push(upstreamSide({ code: "COST_OWNER_UNVERIFIED", scope: "rule", detail: issueText("COST_OWNER_UNVERIFIED"), ruleIds: costOwner.ruleIds, observedAt: Date.now() }));
      if (costOwner.state === "duplicate") issues.push(upstreamSide({ code: "CANONICAL_KEY_CONFLICT", scope: "rule", detail: issueText("CANONICAL_KEY_CONFLICT"), ruleIds: costOwner.ruleIds, observedAt: Date.now() }));
      if (!ownAvailable) issues.push({ code: "OWN_BILLING_UNAVAILABLE", scope: "downstream", detail: issueText("OWN_BILLING_UNAVAILABLE"), observedAt: Date.now() });
      // 自营站点关过收费记录：碰到那一段的窗口，收入读不到、利润先不算（probe 也要看到，不取账单就能判）
      let consumeLogIssue = ownAvailable ? await consumeLogIssueFor(own, rule, window, { force: force || settle, settle, priorState }) : null;
      // 结账时设置读不到却照常固定的（读到过开着 / 读不到太久）：记下来，写进账本明细
      const settingNote = ownAvailable && settle && !consumeLogIssue ? consumeLogSettingNote(own, window, priorState) : null;
      const consumeLogSetting = settingNote && !settingNote.blocked ? { state: settingNote.state, sinceMs: settingNote.sinceMs, lastOnAt: settingNote.lastOnAt, reason: settingNote.provenOn ? "proven_on" : "too_long" } : null;
      // 近 7 天、本月这类多天窗口碰到「已经开回来的」关着的那一段：碰到的那几天不算，其余天照算，行上加一句说明（总指挥 10-26 定 A）；
      // 整个窗口都碰到了、或者这是要固定的窗口（结账、手动重新读取的整天）时照旧挡住。applicable 在下面按天拆开后再定要不要真的挡
      const partialGapCandidate = consumeLogIssue?.code === "OWN_CONSUME_LOG_GAP" && !billDayOf(window) && !settle;
      if (consumeLogIssue && !partialGapCandidate) issues.push(consumeLogIssue);
      if (upstreamProblem) issues.push(upstreamSide({ code: upstreamProblem.code, scope: "upstream", detail: upstreamProblem.detail, observedAt: Date.now(),
        // 令牌作废、少了权限要说是哪个上游、少的哪一项（审核 #107 低-4：固定成本的上游走这里，原来这两样丢了）
        ...(upstreamProblem.stationName != null ? { stationName: upstreamProblem.stationName } : {}), ...(upstreamProblem.missingScope ? { missingScope: upstreamProblem.missingScope } : {}) }));
      else if (!catalogueObserved && platform !== "sub2api") {
        issues.push(upstreamSide({
          code: "GROUP_DATA_UNAVAILABLE", scope: "upstream", observedAt: Date.now(),
          detail: `分组「${token.group}」的倍率暂时读不到`,
        }));
      }
      if (reconciliation.transitioned) {
        issues.push({ code: "ROUTE_TRANSITION_DETECTED", scope: "rule", detail: issueText("ROUTE_TRANSITION_DETECTED"), observedAt: Date.now() });
      }
      // 换 Key 那天的一句提示（§5.4）：这个窗口里有换 Key 开的段（timing_source key_change）就有；
      // 换 Key 开的段不是估的倍率变化，下面「倍率变化的时间是系统估的」只看 detected 的段，不会带上它
      if (segments.some((segment) => segment.timingSource === "key_change" && segment.effectiveFrom >= window.startMs && segment.effectiveFrom < window.endMs)) {
        issues.push({ code: "KEY_CHANGED", scope: "rule", detail: issueText("KEY_CHANGED"), observedAt: Date.now() });
      }
      const unconfirmedSegments = segments.filter((segment) => segment.timingSource === "detected");
      if (unconfirmedSegments.length) {
        issues.push({
          code: "SEGMENT_TIMING_UNCONFIRMED",
          scope: "segment",
          detail: issueText("SEGMENT_TIMING_UNCONFIRMED"),
          observedAt: Date.now(),
        });
      }
      // today / 近 7 天结束于当前时刻：刚建规则、刚切段或刚过零点时，最新一段还不满一个完整秒，秒级统计无法无重叠地核算。
      // 这段尾巴会随时间变长，本轮整条规则待获取，不能只核算旧分段却把整窗标为已确认；切段通知若因此没发出，下一轮会以分段切换时间待确认补报。
      // 窗口与规则任何分段都不相交（如查规则创建之前的时段）时照常核算为 0，不算待获取：那种情况不会随时间自行恢复。
      const intersecting = segments
        .map((segment) => ({ segment, segmentWindow: intersectSegment(window, segment) }))
        .filter(({ segmentWindow }) => segmentWindow);
      // 按 Key 整体取数的关联确认即生效：窗口裁到核算起点（Sub2API 起点当天按全天），整个窗口都在起点之前时金额为 0。
      // 修改关联后的过渡期，修改之前的未结账时段也按当前配置计算，结果带 scope.recalculated 标记。
      const clipped = isScopedBillingPolicy(rule.billingPolicy) ? accountingWindow(rule, window, platform) : window;
      const clippedUpstream = isScopedBillingPolicy(rule.billingPolicy) ? accountingUpstreamWindow(rule, window, platform) : window;
      let applicable = isScopedBillingPolicy(rule.billingPolicy) ? (clipped ? [{ segment: currentSegment, segmentWindow: clipped, upstreamWindow: clippedUpstream }] : []) : intersecting;
      if (partialGapCandidate) {
        // 把每段窗口按天切开，去掉碰到关着那一段的天，剩下连着的天并成一段（同一段的几个部分用「段号~序号」区分，快照键不撞）
        const stationPeriods = upstreamStation(own.id)?.consumeLogOffPeriods ?? own.consumeLogOffPeriods;
        const kept = applicable.flatMap(({ segment, segmentWindow, upstreamWindow }) => {
          const days = splitWindowByDays(segmentWindow).filter((piece) => !consumeLogOffOverlap(stationPeriods, piece).closed);
          const runs = [];
          for (const piece of days) {
            const last = runs.at(-1);
            if (last && last.endMs === piece.startMs) last.endMs = piece.endMs; else runs.push({ startMs: piece.startMs, endMs: piece.endMs, timezone: piece.timezone });
          }
          // upstreamWindow 按这一截自己的起止裁一遍：原来是整段的（Sub2API 当天换绑那天会比 segmentWindow 宽），按天切开以后
          // 中间被切开的地方只留和它重叠的那部分，不能整段照抄——不然碰到关着那天会被跳过的日子又从上游这一侧读回来（审核改坏检验抓到）。
          // 头尾两截（挨着 segmentWindow 本来的起止）要保留 C3 放宽的那部分，不能也裁掉：Sub2API 换绑那天只能按整天读账单，
          // 裁到换绑时刻会把上游起点读错（审核 #114 中-F：换绑那天以后有一天关过，整行变成读不到上游）。
          // 段上挂的 Key 列表（segment.keys）是不可枚举属性（server/reconciliation-repository.js），`{...segment}` 展开会把它丢掉，
          // 按天切出新的那几截就会只认绑定自己那把 Key、少算别的 Key 的上游成本——用 copySegment 显式复制，普通字段和 keys 都是
          // 这份拷贝自己的，不借用原型链（审核 #114 中-G；总指挥 10-26 定改法：Object.create 会让除 id 外的字段都读不出来，
          // JSON.stringify / Object.keys / 深比较都不对，K2b 以后复制分段统一用这个函数）
          return runs.map((run, index) => ({ segment: index ? copySegment(segment, { id: `${String(segment.id).slice(0, 28)}~${index}` }) : segment, segmentWindow: { ...segmentWindow, ...run },
            upstreamWindow: upstreamWindow ? { ...upstreamWindow,
              startMs: run.startMs === segmentWindow.startMs ? upstreamWindow.startMs : run.startMs,
              endMs: run.endMs === segmentWindow.endMs ? upstreamWindow.endMs : run.endMs } : upstreamWindow }));
        });
        if (kept.length) {
          applicable = kept;
          issues.push({ code: "OWN_CONSUME_LOG_GAP_PARTIAL", scope: "downstream", detail: issueText("OWN_CONSUME_LOG_GAP_PARTIAL"), observedAt: Date.now() });
          consumeLogIssue = null;
        } else issues.push(consumeLogIssue);
      }
      // probe 到这里为止：取数前能判断的都判断完了，还挡着的要人处理的原因交回去，不读渠道、不取账单
      if (probe) return { probe: true, blocker: issues.find((issue) => CALCULATION_BLOCKERS.has(issue.code) && !issue.reference && reasonKindOf(issue.code) !== "retry")?.code ?? null };
      let catalogue = null;
      // 结账（settle）虽然强制重取账单，渠道目录只用来写渠道状态，不挡结果：用 10 分钟内的缓存，不每结一天就重读一遍（安全审核 C2a 低-3）
      try { if (ownAvailable) catalogue = await ownChannelsFor(own, { force: force && !settle }); } catch (error) {
        // 自营站点的令牌少了 channel:read（或作废）：渠道目录读不到要说令牌的事，不吞成「渠道状态暂时读不到」（审核 #107 低-5）
        issues.push(isAccessTokenError(error?.code)
          ? { code: error.code, scope: "channels", side: "own", detail: issueText(error.code), observedAt: Date.now(), ...(error.scope ? { missingScope: error.scope } : {}) }
          : { code: "SALES_CHANNEL_STATE_UNKNOWN", scope: "channels", detail: "渠道状态暂时读不到", observedAt: Date.now() });
      }
      const channelById = new Map((catalogue || []).map((channel) => [Number(channel.id), channel]));
      const states = rule.channels.map((channel) => {
        const found = channelById.get(channel.channelId);
        const state = catalogue ? (found ? channelState(found.status) : "missing") : "unknown";
        return { ...channel, state, stateObservedAt: Date.now() };
      });
      // 只写状态变了的渠道；状态没变的，观测时刻最多每 10 分钟刷新一次（读这一列的只有锚定判断，只看有没有）
      const storedChannels = new Map(rule.channels.map((channel) => [channel.channelId, channel]));
      const changedStates = states.filter((channel) => {
        const stored = storedChannels.get(channel.channelId);
        return channel.state !== stored?.state || !(Number(stored?.stateObservedAt) > Date.now() - UNCHANGED_REWRITE_MS);
      });
      let channelStatesUpdated;
      if (observe && !settle && changedStates.length) try {
        channelStatesUpdated = await withObservationSourceLock(rule, sourceCredential,
          () => repository.updateChannelStates(rule.id, changedStates), billingSource);
      } catch { channelStatesUpdated = null; }
      if (channelStatesUpdated === STALE_SCOPE) return STALE_SCOPE;
      for (const channel of states) {
        if (channel.state === "manual_disabled" || channel.state === "auto_disabled") issues.push({ code: "SALES_CHANNEL_DISABLED", scope: "channel", channelId: channel.channelId, detail: `渠道「${channel.name}」已停用`, observedAt: Date.now() });
        if (channel.state === "missing") issues.push({ code: "SALES_CHANNEL_MISSING", scope: "channel", channelId: channel.channelId, detail: issueText("SALES_CHANNEL_MISSING", { channel: channel.name }), observedAt: Date.now() });
      }
      // 本站 /api/status 同一轮各绑定、各分段共用一次（ownStatusFor）；读取失败时每个分段照常按本站账单不可用处理。
      const loadOwnStatus = () => ownStatusFor(ownerRegistry, own);
      const reuseOwnRevenue = observe && origin === "poll" && isLiveReconciliationPreset(window.preset);
      const segmentResults = foldSplitSegments(await mapWithConcurrency(applicable, 6, async ({ segment, segmentWindow, upstreamWindow: upstreamOwnWindow }) => {
        // 上游一侧自己的窗口（Sub2API 当天换绑的那天比本站一侧长，见 accountingUpstreamWindow）
        const upstreamWindow = upstreamOwnWindow || segmentWindow;
        const [upstreamResult, downstreamResult] = await Promise.all([
          // 上游读不到（只有固定成本会走到这里）：不取上游，问题已经在上面记了一次
          upstreamProblem ? Promise.resolve({ error: upstreamProblem, skipped: true })
            // 结账照样可以记下上游的账单能力（Sub2API 用已结束那天的正消费核验，能力按上游账号记，不是按天写的东西）
            : (isScopedBillingPolicy(rule.billingPolicy)
              ? upstreamWindowForScopedSegments(upstream, metadata, token, segments, segment, upstreamWindow, { readOnly: !observe, upstreamStationId: rule.upstreamStationId })
              : upstreamWindowForSegment(upstream, metadata, token, segment, upstreamWindow, { readOnly: !observe, upstreamStationId: rule.upstreamStationId })).catch((error) => ({ error })),
          (ownAvailable && consumeLogIssue ? Promise.resolve({ error: codedError(consumeLogIssue.code, consumeLogIssue.detail), consumeLog: true })
            : ownAvailable
            ? ownRevenue(own, rule, segmentWindow, { loadStatus: loadOwnStatus, registry: ownerRegistry, reuse: reuseOwnRevenue, settle })
            : Promise.resolve({ error: codedError("OWN_BILLING_UNAVAILABLE", issueText("OWN_BILLING_UNAVAILABLE")) }))
            .catch((error) => ({ error })),
        ]);
        const segmentIssues = issues.filter((issue) => CALCULATION_BLOCKERS.has(issue.code));
        const sides = [upstreamResult, downstreamResult].filter((side) => !side.error);
        // 只有上游一侧的窗口或时区对不上时算上游侧问题；本站一侧对不上始终阻断。
        const downstreamSide = downstreamResult.error ? [] : [downstreamResult];
        const windowMismatch = (side) => !sameReconciliationWindow(side.window, side === upstreamResult ? upstreamWindow : segmentWindow, { timezone: false });
        if (sides.some(windowMismatch)) {
          const issue = { code: "BILLING_WINDOW_MISMATCH", scope: "segment", detail: issueText("BILLING_WINDOW_MISMATCH"), observedAt: Date.now() };
          segmentIssues.push(downstreamSide.some(windowMismatch) ? issue : upstreamSide(issue));
        }
        // 某一侧取数失败时由它自己的错误说明原因，不能再提示去核验时区或能力。
        if (sides.length === 2 && commonBillingTimezone(segmentWindow, sides.map((side) => ({ ...side, requestedWindow: side === upstreamResult ? upstreamWindow : segmentWindow }))).state !== "verified") {
          const issue = { code: "BILLING_TIMEZONE_UNVERIFIED", scope: "segment", detail: issueText("BILLING_TIMEZONE_UNVERIFIED"), observedAt: Date.now() };
          segmentIssues.push(commonBillingTimezone(segmentWindow, downstreamSide).state !== "verified" ? issue : upstreamSide(issue));
        }
        if (upstreamResult.error && !upstreamResult.skipped) {
          const billHealth = upstreamErrorHealth(upstreamResult.error, upstreamResource);
          // cause：读账单时上游报的原始码（限流、5xx 是 UPSTREAM_REQUEST_FAILED，连不上、超时是 NETWORK_UNREACHABLE），回看靠它分辨「这个上游这一刻整体读不到」
          segmentIssues.push(upstreamSide({ code: billHealth.code, scope: "segment", detail: billHealth.detail, observedAt: Date.now(),
            ...(upstreamResult.error?.code ? { cause: String(upstreamResult.error.code) } : {}),
            ...(billHealth.stationName != null ? { stationName: billHealth.stationName } : {}), ...(billHealth.missingScope ? { missingScope: billHealth.missingScope } : {}) }));
          // Key 账单报错：可能换了 Key 或身份变了，下一轮全部重读（P1b 的异常之一）
          staleMetadata.add(rule.upstreamStationId);
        }
        if (upstreamResult.emptySecondWindow || downstreamResult.emptySecondWindow) {
          const issue = { code: "PENDING", scope: "segment", detail: issueText("PENDING"), observedAt: Date.now() };
          segmentIssues.push(downstreamResult.emptySecondWindow ? issue : upstreamSide(issue));
        }
        if (downstreamResult.error || (downstreamResult.state !== "complete" && downstreamResult.state !== "pending")) {
          // 自营站点的令牌作废、少了权限：要人换令牌，马上进需处理，不再当成读取类（OWN_BILLING_UNAVAILABLE）等 7 天（own-revenue-plan 第三节）
          const ownToken = isAccessTokenError(downstreamResult.error?.code) ? downstreamResult.error : null;
          // 关过收费记录的那一段：问题已经在上面记了一次（OFF / GAP），不再多说「读不到」
          if (!downstreamResult.consumeLog) segmentIssues.push(ownToken
            ? { code: ownToken.code, scope: "segment", side: "own", detail: issueText(ownToken.code), observedAt: Date.now(), ...(ownToken.scope ? { missingScope: ownToken.scope } : {}) }
            : { code: "OWN_BILLING_UNAVAILABLE", scope: "segment", detail: issueText("OWN_BILLING_UNAVAILABLE"), observedAt: Date.now() });
        }
        const upstreamUnavailable = upstreamResult.error || upstreamResult.emptySecondWindow || upstreamResult.state !== "complete";
        const downstreamUnavailable = downstreamResult.error || downstreamResult.emptySecondWindow || downstreamResult.state !== "complete";
        const upstreamUsd = upstreamUnavailable ? null : upstreamResult.amountUsd;
        if (!upstreamResult.error && upstreamResult.state !== "complete" && !upstreamResult.emptySecondWindow) {
          segmentIssues.push(upstreamSide({ code: "UPSTREAM_CAPABILITY_UNVERIFIED", scope: "upstream", detail: issueText("UPSTREAM_CAPABILITY_UNVERIFIED"), observedAt: Date.now() }));
        }
        const downstreamUsd = downstreamUnavailable ? null : downstreamResult.quotaUnits / downstreamResult.quotaPerUnit;
        if (!upstreamUnavailable && !downstreamUnavailable && upstreamUsd <= 0 && downstreamUsd > 0) {
          segmentIssues.push(upstreamSide({ code: "UPSTREAM_EMPTY_WITH_SALES", scope: "segment", detail: issueText("UPSTREAM_EMPTY_WITH_SALES"), observedAt: Date.now() }));
          // 渠道有收入而 Key 用量为 0：多半是换了 Key，下一轮全部重读（P1b 的异常之一）
          staleMetadata.add(rule.upstreamStationId);
        }
        if (isCompletedBillingWindow(window) && !downstreamUnavailable && downstreamUsd > 0 && (upstreamUnavailable || upstreamUsd === 0)) {
          segmentIssues.push(upstreamSide({ code: "WAITING_FOR_BILL", scope: "upstream", detail: issueText("WAITING_FOR_BILL"), observedAt: Date.now() }));
        }
        const segmentHealth = healthWithIssues(segmentIssues);
        return {
          ...segment,
          window: segmentWindow,
          upstream: upstreamUnavailable ? {
            state: upstreamResult.emptySecondWindow ? "pending" : upstreamResult.state || "unavailable",
            quotaUnits: upstreamResult.quotaUnits ?? null, quotaPerUnit: upstreamResult.quotaPerUnit ?? null, amountUsd: null, knownAmountUsd: upstreamResult.knownAmountUsd ?? null,
            successfulCount: upstreamResult.knownAmountUsd != null ? 1 : 0, expectedCount: 1, observedAt: Date.now(),
            window: upstreamResult.window || upstreamWindow, requestedWindow: upstreamWindow, billingTimezone: upstreamResult.billingTimezone,
          } : {
            state: "complete", quotaUnits: upstreamResult.quotaUnits, quotaPerUnit: upstreamResult.quotaPerUnit,
            amountUsd: upstreamUsd, knownAmountUsd: upstreamUsd, successfulCount: 1, expectedCount: 1,
            observedAt: upstreamResult.latestLogAtMs || Date.now(), window: upstreamResult.window || upstreamWindow,
            requestedWindow: upstreamWindow, billingTimezone: upstreamResult.billingTimezone,
          },
          downstream: downstreamResult.error ? {
            state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null,
            successfulCount: 0, expectedCount: rule.channels.length,
            billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION,
            observedAt: Date.now(), window: segmentWindow, requestedWindow: segmentWindow, billingTimezone: null,
            channels: rule.channels.map((channel) => ({ ...channel, billingState: "unavailable", quotaUnits: null, amountUsd: null, knownAmountUsd: null })),
          } : {
            quotaUnits: downstreamResult.quotaUnits,
            quotaPerUnit: downstreamResult.quotaPerUnit,
            amountUsd: downstreamUnavailable ? null : downstreamUsd,
            knownAmountUsd: downstreamResult.knownAmountUsd,
            // 这段收入里减掉的管理员自用（own-revenue-plan 第一节），计算明细「其中管理员自用 $x，不算收入」用；没有时是 0
            adminUsageQuotaUnits: downstreamResult.adminUsageQuotaUnits ?? 0, adminUsageAmountUsd: downstreamResult.adminUsageAmountUsd ?? null,
            // 这段里几天扣了管理员自用、几天没扣（R1 以前固定的账没扣）：页面据此写「已扣除…（部分日子没扣）」；现读的一段都是扣了的
            adminUsageDays: downstreamResult.adminUsageDays ?? { deducted: 1, undeducted: 0 },
            state: downstreamResult.state,
            successfulCount: downstreamResult.successfulCount,
            expectedCount: downstreamResult.expectedCount,
            billingSource: downstreamResult.billingSource,
            calculationVersion: downstreamResult.calculationVersion,
            observedAt: Date.now(), window: downstreamResult.window || segmentWindow, requestedWindow: segmentWindow, billingTimezone: downstreamResult.billingTimezone,
            channels: downstreamResult.channels,
          },
          calculation: calculationFromAmounts(costBasis === "fixed" ? 0 : upstreamUsd, downstreamUsd, segmentIssues),
          health: segmentHealth,
        };
      }), costBasis);
      for (const segment of segmentResults) issues.push(...segment.health.issues);
      const countedCost = costOwner.state !== "unknown" && costOwner.ownerId === rule.id;
      for (const segment of segmentResults) {
        segment.upstream.countedAmountUsd = countedCost ? segment.upstream.knownAmountUsd : null;
        segment.upstream.ownershipState = costOwner.state;
        segment.upstream.duplicateOfRuleId = costOwner.state === "duplicate" && costOwner.ownerId !== rule.id ? costOwner.ownerId : null;
      }
      const completeUpstream = segmentResults.every((segment) => segment.upstream.state === "complete");
      const completeDownstream = segmentResults.every((segment) => segment.downstream.state === "complete");
      const upstreamUsd = completeUpstream ? segmentResults.reduce((sum, segment) => sum + segment.upstream.amountUsd, 0) : null;
      const downstreamUsd = completeDownstream ? segmentResults.reduce((sum, segment) => sum + segment.downstream.amountUsd, 0) : null;
      const upstreamUnits = completeUpstream ? segmentResults.reduce((sum, segment) => sum + segment.upstream.quotaUnits, 0) : null;
      const downstreamUnits = completeDownstream ? segmentResults.reduce((sum, segment) => sum + segment.downstream.quotaUnits, 0) : null;
      const successfulUpstream = segmentResults.filter((segment) => segment.upstream.state === "complete");
      // 窗口整段在核算起点之前时没有分段：这条关联在该窗口的收入和成本都确定为 0。
      const knownUpstreamUsd = !segmentResults.length ? 0 : segmentResults.some((segment) => segment.upstream.knownAmountUsd != null)
        ? segmentResults.reduce((sum, segment) => sum + (segment.upstream.knownAmountUsd ?? 0), 0) : null;
      const allChannels = states.map((channel) => {
        const billingRows = segmentResults.map((segment) => segment.downstream.channels?.find((item) => item.channelId === channel.channelId)).filter(Boolean);
        const complete = billingRows.length === segmentResults.length && billingRows.every((item) => item.billingState === "complete" && item.amountUsd != null);
        const quotaUnits = billingRows.reduce((sum, item) => sum + (item.quotaUnits ?? 0), 0);
        return {
          ...channel,
          billingState: complete ? "complete" : billingRows.some((item) => item.billingState === "complete") ? "partial" : "unavailable",
          quotaUnits: complete ? quotaUnits : null,
          amountUsd: complete ? billingRows.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : null,
          knownAmountUsd: complete ? billingRows.reduce((sum, item) => sum + item.amountUsd, 0) : billingRows.some((item) => item.amountUsd != null)
            ? billingRows.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : null,
          share: completeDownstream && complete ? (downstreamUnits > 0 ? quotaUnits / downstreamUnits : 0) : null,
        };
      });
      const resultHealth = healthWithIssues(issues);
      // 按 Key 整体取数的关联在核算起点之前没有成本和收入：裁切后的取数窗口如实覆盖了整个请求窗口。
      const sideWindow = (side) => {
        if (segmentResults.length !== 1) return window;
        const [segment] = segmentResults;
        return isScopedBillingPolicy(rule.billingPolicy) && sameReconciliationWindow(segment[side].window, segment.window, { timezone: false }) ? window : segment[side].window;
      };
      const result = {
        rule: { ...rule, tokenName: evidenceToken?.name ?? rule.tokenName, fixedGroup: currentSegment.group }, window,
        ownSource, scope: { ...reconciliationBillingSchedule(rule), recalculated: scopeRecalculatedInWindow(rule, window),
          accountedFromMs: clipped && clipped.startMs > window.startMs ? clipped.startMs : null,
          // 解除当天只算到解除那一刻（New API）；C④ 在计算明细写「统计到」
          accountedToMs: clipped && clipped.endMs < window.endMs ? clipped.endMs : null,
          // 上游一侧比本站一侧长（Sub2API 当天换绑）：明细写「这个上游只能按整天读账单，上游成本是这把 Key 全天的」
          upstreamWholeDay: !!(clipped && clippedUpstream && clippedUpstream.startMs < clipped.startMs), notEffective: !applicable.length && isScopedBillingPolicy(rule.billingPolicy) },
        amountBasis: { id: "channel-billing-usd-v3", currency: "USD", billingSource: RECONCILIATION_BILLING_SOURCE,
          calculationVersion: RECONCILIATION_CALCULATION_VERSION, conversion: platform === "sub2api" ? "provider_cost_usd" : "quota_per_unit" },
        // 固定采购的成本不取自上游账单，只要本站一侧证明了时区和日界线。
        billingTimezone: commonBillingTimezone(window, segmentResults.flatMap((segment) => costBasis === "fixed" ? [segment.downstream] : [segment.upstream, segment.downstream])),
        requestedWindow: window,
        lastSuccessfulWindow: null,
        currentSegment,
        segments: segmentResults,
        transitionSegments: segments,
        ...(consumeLogSetting ? { consumeLogSetting } : {}),
        upstream: {
          state: completeUpstream ? "complete" : knownUpstreamUsd != null ? "partial" : segmentResults.some((segment) => segment.upstream.state === "pending") ? "pending" : "unavailable",
          duplicateOfRuleId: costOwner.state === "duplicate" && costOwner.ownerId !== rule.id ? costOwner.ownerId : null,
          ownershipState: costOwner.state,
          unverifiedOwnerRuleIds: costOwner.state === "unknown" ? costOwner.ruleIds : [],
          quotaUnits: upstreamUnits,
          quotaPerUnit: segmentResults[0]?.upstream?.quotaPerUnit ?? null,
          amountUsd: upstreamUsd,
          knownAmountUsd: knownUpstreamUsd,
          countedAmountUsd: countedCost ? knownUpstreamUsd : null,
          successfulCount: successfulUpstream.length,
          expectedCount: segmentResults.length,
          observedAt: Date.now(), window: sideWindow("upstream"),
          billingTimezone: commonBillingTimezone(window, segmentResults.map((segment) => segment.upstream)),
          status: evidenceToken?.status ?? null, group: currentSegment.group, ratio: currentRatio,
        },
        downstream: {
          state: completeDownstream ? "complete" : segmentResults.some((segment) => segment.downstream.knownAmountUsd != null) ? "partial" : segmentResults.some((segment) => segment.downstream.state === "pending") ? "pending" : "unavailable",
          quotaUnits: downstreamUnits,
          quotaPerUnit: segmentResults[0]?.downstream?.quotaPerUnit ?? null,
          amountUsd: downstreamUsd,
          knownAmountUsd: completeDownstream ? downstreamUsd : segmentResults.reduce((sum, segment) => sum + (segment.downstream.knownAmountUsd ?? 0), 0) || (segmentResults.some((segment) => segment.downstream.knownAmountUsd != null) ? 0 : null),
          successfulCount: segmentResults.reduce((sum, segment) => sum + segment.downstream.successfulCount, 0),
          expectedCount: segmentResults.reduce((sum, segment) => sum + segment.downstream.expectedCount, 0),
          // 各段减掉的管理员自用合起来（own-revenue-plan 第一节）：计算明细「其中管理员自用」；有一段换算读不到时整个读不到
          adminUsageQuotaUnits: segmentResults.reduce((sum, segment) => sum + (segment.downstream.adminUsageQuotaUnits ?? 0), 0),
          adminUsageAmountUsd: segmentResults.some((segment) => segment.downstream.adminUsageAmountUsd == null) ? null : segmentResults.reduce((sum, segment) => sum + segment.downstream.adminUsageAmountUsd, 0),
          adminUsageDays: segmentResults.reduce((sum, segment) => ({ deducted: sum.deducted + (segment.downstream.adminUsageDays?.deducted ?? 1), undeducted: sum.undeducted + (segment.downstream.adminUsageDays?.undeducted ?? 0) }), { deducted: 0, undeducted: 0 }),
          billingSource: RECONCILIATION_BILLING_SOURCE,
          calculationVersion: RECONCILIATION_CALCULATION_VERSION,
          observedAt: Date.now(), window: sideWindow("downstream"),
          billingTimezone: commonBillingTimezone(window, segmentResults.map((segment) => segment.downstream)),
          channels: allChannels,
        },
        calculation: calculationFromAmounts(costBasis === "fixed" ? 0 : upstreamUsd, downstreamUsd, issues),
        costBasis,
        health: resultHealth, generatedAt: new Date().toISOString(),
      };
      const scopeFingerprint = reconciliationScopeFingerprint(rule, segments);
      if (!await hasCurrentScope(rule.id, scopeFingerprint, generation, !!rule.archivedAt)) return STALE_SCOPE;
      if (currentSourceCredential(rule) !== sourceCredential) return STALE_SCOPE;
      const billingFingerprint = sourceScopeFingerprint(scopeFingerprint, sourceCredential);
      if (result.calculation.profitUsd != null) {
        result.lastSuccessfulAt = result.generatedAt;
        result.lastSuccessfulWindow = window;
      }
      let previous;
      try { previous = await previousSuccess(rule, window, billingFingerprint); } catch {}
      if (previous) {
        result.lastConfirmed = snapshotReference(previous);
      }
      if (!observe) return result;
      return (await persistResult(rule, result, origin, evidenceMetadata, evidenceToken, {
        scopeFingerprint, billingFingerprint, sourceCredential, generation, billingSource, financialSnapshot, resettle, resettleRequestedAt, confirmShrink, confirmedAfter, settle, trigger,
      })) ? (settle ? withResettleBlocker(await bookedResult(rule, result), result) : result) : STALE_SCOPE;
    };
    // 口径在查询期间变化时，在共享的 in-flight 任务内重跑，加入等待的调用方也只会拿到最新口径的结果。
    // 编辑会注销本任务的 in-flight 登记：期间已有调用方按新口径另起任务时直接等它，不再重复取数和写快照；
    // 否则重新登记，让重跑期间到达的调用方加入本任务。
    let task;
    const run = async () => {
      let rule = firstRule;
      for (let attempt = 1; ; attempt += 1) {
        const generation = ruleGenerations.get(ruleId) || 0;
        const request = { sourceCredential: currentSourceCredential(rule) };
        const billingSource = ownerRegistry.billingSource;
        const value = await inspectScope(rule, generation, billingSource, request).catch((error) => {
          if (billingSourceState().version !== billingSource.version) return STALE_SCOPE;
          throw error;
        });
        if (value?.probe) return value;
        if (value !== STALE_SCOPE && (ruleGenerations.get(ruleId) || 0) === generation
          && currentSourceCredential(rule) === request.sourceCredential && billingSourceState().version === billingSource.version) {
          if (value.health.code !== "PENDING") cacheResult(cacheKey, value, request.sourceCredential, billingSource.ownerVersion, observe);
          return value;
        }
        if (billingSourceState().version !== billingSource.version) return STALE_SCOPE;
        const newer = inflight.get(inflightKey);
        if (newer && newer !== task) return newer;
        // 口径被连续改动时不再重跑：只让这条规则本轮待获取，不能让整个多规则查询失败。
        if (attempt >= MAX_SCOPE_ATTEMPTS) return pendingResult(rule, window, issueText("PENDING"));
        inflight.set(inflightKey, task);
        rule = await repository.getRule(ruleId, { includeArchived: settle });
        if (!rule || (rule.archivedAt && !archivedSettleable(rule))) throw ruleNotFound();
      }
    };
    task = run();
    inflight.set(inflightKey, task);
    try { return await task; } finally {
      if (inflight.get(inflightKey) === task) inflight.delete(inflightKey);
    }
  }

  async function persistUnavailable(rule, window, resultHealth, origin, evidence = {}, generation = 0, sourceCredential = currentSourceCredential(rule), billingSource = null, { save = true } = {}) {
    const persistedSegments = await repository.listSegments(rule.id).catch(() => []);
    const currentSegment = persistedSegments[persistedSegments.length - 1] || null;
    const scopeFingerprint = reconciliationScopeFingerprint(rule, persistedSegments);
    const currentRule = await repository.getRule(rule.id, { includeArchived: !!rule.archivedAt }).catch(() => null);
    if (!currentRule || reconciliationScopeFingerprint(currentRule, persistedSegments) !== scopeFingerprint || (ruleGenerations.get(rule.id) || 0) !== generation) return STALE_SCOPE;
    if (currentSourceCredential(rule) !== sourceCredential) return STALE_SCOPE;
    const billingFingerprint = sourceScopeFingerprint(scopeFingerprint, sourceCredential);
      const unavailable = {
      rule,
      window,
      requestedWindow: window,
      lastSuccessfulWindow: null,
      currentSegment,
      transitionSegments: persistedSegments,
      upstream: evidence.upstream ? {
        state: evidence.upstream.state || "complete",
        quotaUnits: evidence.upstream.quotaUnits,
        quotaPerUnit: evidence.upstream.quotaPerUnit,
        amountUsd: evidence.upstream.amountUsd ?? null,
        knownAmountUsd: evidence.upstream.knownAmountUsd ?? evidence.upstream.amountUsd ?? null,
        countedAmountUsd: null,
        ownershipState: "unknown",
        successfulCount: evidence.upstream.knownAmountUsd != null || evidence.upstream.amountUsd != null ? 1 : 0,
        expectedCount: 1, window: evidence.upstream.window || window, billingTimezone: evidence.upstream.billingTimezone,
        observedAt: evidence.upstream.latestLogAtMs || Date.now(),
        status: evidence.token?.status ?? null,
        group: evidence.token?.group ?? null,
        ratio: evidence.metadata?.groups?.[evidence.token?.group]?.ratio ?? null,
      } : { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: 1, observedAt: Date.now(), window },
      downstream: evidence.downstream ? {
        state: evidence.downstream.state || "unavailable",
        quotaUnits: evidence.downstream.quotaUnits,
        quotaPerUnit: evidence.downstream.quotaPerUnit,
        amountUsd: evidence.downstream.state === "complete" && Number.isFinite(evidence.downstream.quotaUnits) && Number.isFinite(evidence.downstream.quotaPerUnit) && evidence.downstream.quotaPerUnit > 0
          ? evidence.downstream.quotaUnits / evidence.downstream.quotaPerUnit : null,
        knownAmountUsd: evidence.downstream.knownAmountUsd ?? null,
        successfulCount: evidence.downstream.successfulCount ?? 0,
        expectedCount: evidence.downstream.expectedCount ?? rule.channels.length,
        billingSource: evidence.downstream.billingSource || RECONCILIATION_BILLING_SOURCE,
        calculationVersion: evidence.downstream.calculationVersion || RECONCILIATION_CALCULATION_VERSION,
        observedAt: Date.now(), window: evidence.downstream.window || window, billingTimezone: evidence.downstream.billingTimezone,
        channels: evidence.downstream.channels || [],
      } : { state: "unavailable", quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null, successfulCount: 0, expectedCount: rule.channels.length, observedAt: Date.now(), window, channels: rule.channels.map((channel) => ({ ...channel, billingState: "unavailable", quotaUnits: null, amountUsd: null, knownAmountUsd: null })) },
      calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
      health: resultHealth,
      generatedAt: new Date().toISOString(),
    };
    unavailable.segments = (evidence.downstream?.segments || []).map((segment) => ({
      ...segment,
      upstream: {
        state: resultHealth.code === "PENDING" ? "pending" : "unavailable",
        quotaUnits: null, quotaPerUnit: null, amountUsd: null, knownAmountUsd: null,
        successfulCount: 0, expectedCount: 1, observedAt: Date.now(), window: segment.window,
      },
      downstream: segment.downstream,
      calculation: { differenceUsd: null, profitUsd: null, riskDifferenceUsd: null, marginRate: null },
      health: resultHealth,
    }));
    let previous;
    try { previous = await previousSuccess(rule, window, billingFingerprint); } catch {}
    if (previous) {
      unavailable.lastConfirmed = snapshotReference(previous);
    }
    if (!save) {
      // 不写库的路上（身份读不到、冷启动时整站令牌作废）也要推：令牌坏了的推送只靠这一处，只推、不清记录（审核 #107 中-1：
      // 用户先升级 New API 再部署，一启动身份缓存就是冷的，要是这里不推，永远不推）
      if (isAccessTokenError(resultHealth.code) && !isSettleableWindow(window, Date.now())) {
        try { await notifyReconciliationHealth(rt, repository, rule, unavailable); } catch (err) { console.error("渠道对账通知失败:", err?.message || String(err)); }
      }
      return unavailable;
    }
    return (await persistResult(rule, unavailable, origin, evidence.metadata, evidence.token, { scopeFingerprint, billingFingerprint, sourceCredential, generation, billingSource })) ? unavailable : STALE_SCOPE;
  }

  async function persistResult(rule, result, origin, metadata = null, token = null, { saveSnapshots = true, scopeFingerprint = null, billingFingerprint = null, sourceCredential = null, generation = 0, billingSource = null, financialSnapshot = null, resettle = false, resettleRequestedAt = null, confirmShrink = false, confirmedAfter = null, settle = false, trigger = null } = {}) {
    const wholeWindow = { id: result.currentSegment?.id || null, window: result.window, upstream: result.upstream, downstream: result.downstream, calculation: result.calculation, health: result.health };
    const segmentSnapshots = result.segments?.length ? result.segments : [wholeWindow];
    // 只有结束满 15 分钟的自然日窗口才结账：今天、近 7 天和刚结束的昨天还在变化，只记观测。
    // 关联生效前的日子没有账可结，不结账。单个自然日记进账本，多日窗口仍写确认快照。
    const { settled, ledger: ledgerDay, confirmedSnapshot } = settlementOutcome({ window: result.window, result, now: Date.now() });
    // 结账（settle）不写观测快照，只写账本或确认快照
    const snapshots = [...(settle ? [] : ["observation"]), ...(confirmedSnapshot ? ["confirmed"] : [])]
      .flatMap((recordType) => segmentSnapshots.map((segment) => ({ ...segment, recordType })));
    // 数据库事务核验规则/分段口径；快照键和失败兜底另用包含两侧站点来源的口径。
    const guard = () => (ruleGenerations.get(rule.id) || 0) === generation && currentSourceCredential(rule) === sourceCredential
      && (!billingSource || billingSourceState().version === billingSource.version);
    const sourceFor = (segment) => {
      const source = metadata && token ? sourceSnapshot(token, metadata, segment.upstream, segment.downstream) : {
        calculationVersion: RECONCILIATION_CALCULATION_VERSION,
        billingSource: RECONCILIATION_BILLING_SOURCE,
        upstream: segment.upstream ? { group: segment.upstream.group, ratio: segment.upstream.ratio, status: segment.upstream.status } : null,
        downstream: {
          calculationVersion: RECONCILIATION_CALCULATION_VERSION,
          billingSource: RECONCILIATION_BILLING_SOURCE,
          billingCoverage: segment.downstream?.billingCoverage ?? segment.downstream?.coverage ?? null,
          coverage: segment.downstream?.coverage ?? null,
          channels: segment.downstream?.channels?.map((channel) => ({
            channelId: channel.channelId,
            quotaUnits: channel.quotaUnits,
            amountUsd: channel.amountUsd,
          })) || [],
        },
      };
      return {
        ...source,
        ruleEvidence: reconciliationRuleEvidence(rule, metadata ? { provider: metadata.platform,
          baseUrl: metadata.baseUrl || upstreamStation(rule.upstreamStationId)?.baseUrl,
          accountId: metadata.accountId ?? metadata.userId } : null),
        scopePolicy: { billingPolicy: rule.billingPolicy, scopeVersion: rule.scopeVersion, billingEffectiveFrom: rule.billingEffectiveFrom,
          costCoverage: rule.costCoverage, sourceBinding: rule.sourceBinding, ownSource: rule.ownSource, coverageDeclaration: rule.coverageDeclaration,
          canonicalKey: rule.canonicalKey, sourceState: sourceState(rule) },
        recordType: segment.recordType,
        scopeFingerprint: billingFingerprint,
        segment: (() => {
          const evidence = segment.group != null ? segment : result.currentSegment;
          return evidence ? {
            group: evidence.group,
            ratio: evidence.ratio,
            ratioObservedAt: evidence.ratioObservedAt ?? null,
            ratioSource: evidence.ratioSource ?? null,
            timingSource: evidence.timingSource,
          } : null;
        })(),
        origin,
        window: result.window,
        resultGeneratedAt: result.generatedAt,
        result: {
          ownSource: result.ownSource, billingTimezone: result.billingTimezone, amountBasis: result.amountBasis, scope: result.scope,
          costBasis: result.costBasis,
          window: result.window,
          requestedWindow: result.requestedWindow,
          lastSuccessfulWindow: result.lastSuccessfulWindow,
          currentSegment: result.currentSegment,
          transitionSegments: result.transitionSegments,
          segments: result.segments,
          upstream: result.upstream,
          downstream: result.downstream,
          calculation: result.calculation,
          health: result.health,
          generatedAt: result.generatedAt,
        },
      };
    };
    // 账本记下结账时的成本计法和汇率：汇率只在当时配置过时才记，没记的读取时按当前配置。
    const configuredRate = (rate) => isConfiguredRate(rate) ? rate.cnyPerUsd : null;
    const ledgerRate = (rate) => { const value = ledgerDecimal(configuredRate(rate), 6); return value == null ? null : Number(value); };
    // 账本明细里记下这次是怎么结的（计划 C2a 2.6）：poll 轮询结昨天、late 回看更早的日子、manual 手动重新读取、transition 改了切换时间的重结
    const settlement = { trigger: trigger || (resettle ? "transition" : origin === "manual" ? "manual" : "poll"),
      // 固定这天时自营站点的设置读不到、但照常固定了（R2 审核第二轮中-1）：照实记一句，页面计算明细写出来
      ...(result.consumeLogSetting ? { consumeLogSetting: result.consumeLogSetting } : {}) };
    const ledgerEntry = ledgerDay ? ledgerEntryForSettlement(rule.id, result, { ...sourceFor({ ...wholeWindow, recordType: "confirmed" }), settlement }, {
      revenueRate: configuredRate(financialSnapshot.income), costRate: configuredRate(financialSnapshot.cost),
      costBasis: financialSnapshot.costBasis }) : null;
    // 重结读出来的收入或上游成本比账本最新一版少一半以上（日志过了保留期之类）：不写新版，等人确认（手动「重新读取」才覆盖）。
    // 记 RESETTLE_SHRUNK 的状态行由 settleDay 写；页面上这天还是已固定的旧数
    // 确认了（confirmShrink）：确认框里写的「重算」数（confirmedAfter）和这次再读到的不一样、或者根本没带，照旧挡下、把新的数记下来再让人看一眼（直接调接口也绕不过），
    // 不让人没看到的数把已固定的钱换掉（审核 C3 要总指挥定 2）
    if (settle && resettle && (!confirmShrink || !confirmedAfter || !sameShrunkAfter(confirmedAfter, ledgerEntry)) && ledgerEntry) {
      let prior;
      try { prior = await repository.latestLedgerEntry(rule.id, result.window); } catch { throw codedError("PERSISTENCE_FAILED", issueText("PERSISTENCE_FAILED")); }
      const shrunk = prior ? resettleShrunkInfo(prior, ledgerEntry, { always: confirmShrink }) : null;
      if (shrunk) { result.resettleBlocked = "RESETTLE_SHRUNK"; result.resettleShrunk = shrunk; return true; }
    }
    // 记账的结论（ledgerOption.booked）由仓库在提交以后填上
    const ledgerOption = ledgerEntry ? { entry: ledgerEntry, resettle } : null;
    const rows = snapshots.map((segment) => ({
        ruleId: rule.id,
        segmentId: segment.id,
        snapshotKey: reconciliationSnapshotRecordIdentity(result.window, billingFingerprint, segment.recordType, segment.id),
        windowKind: result.window.preset,
        startMs: segment.window.startMs,
        endMs: segment.window.endMs,
        localDate: result.window.preset === "today" ? dayKeyInTz(result.window.startMs, result.window.timezone) : null,
        upstreamQuota: segment.upstream?.quotaUnits ?? null,
        upstreamQuotaPerUnit: segment.upstream?.quotaPerUnit ?? null,
        upstreamUsd: segment.upstream?.amountUsd ?? null,
        downstreamQuota: segment.downstream?.quotaUnits ?? null,
        downstreamQuotaPerUnit: segment.downstream?.quotaPerUnit ?? null,
        downstreamUsd: segment.downstream?.amountUsd ?? null,
        differenceUsd: segment.calculation?.differenceUsd ?? null,
        marginRate: segment.calculation?.marginRate ?? null,
        coverage: segment.downstream?.coverage ?? null,
        healthCode: segment.health?.code || result.health.code,
        healthDetail: segment.health?.detail || result.health.detail || null,
        source: sourceFor(segment),
    }));
    // 「今天」这类只写观测快照的：内容（去掉各种时刻和窗口终点）和上次写的一样、上次写入不到 10 分钟，就不写（计划 P1a）。
    // 进程活着时页面读结果缓存，不受影响；重启以后读到的「今天」最多是 10 分钟前写的，金额一样。
    const observationOnly = !ledgerOption && !confirmedSnapshot && isLiveReconciliationPreset(result.window.preset);
    const observationKey = `${rule.id}:${scopeFingerprint}:${billingFingerprint}`;
    const observationFingerprint = observationOnly ? snapshotContentFingerprint(rows) : null;
    const unchangedObservation = observationOnly && observationWrites.get(observationKey)?.fingerprint === observationFingerprint
      && Date.now() - observationWrites.get(observationKey).at < UNCHANGED_REWRITE_MS;
    const save = async () => {
      // 没变不写，但守卫照样过一遍（口径、凭据代次没变才算写过）
      if (unchangedObservation) return guard();
      // 结账没成：没有要写的快照也不记账，不开事务、不加锁，只过守卫（状态行由 settleDay 另写）
      if (settle && !rows.length && !ledgerOption) return guard();
      const saved = await repository.saveSnapshotsForScope(rule.id, scopeFingerprint, rows, {
        // 已解除的不核对同一把 Key 的绑定组：解除前这把 Key 只有它在用
        expectedOwnerState: billingSource?.ownerRules && !rule.archivedAt ? reconciliationOwnerScope(billingSource.ownerRules, rule.tokenId) : null, guard, ledger: ledgerOption,
        archived: !!rule.archivedAt,
        // 这天结成了：同一个事务里删掉结账状态表那一行
        settlement: settled && ledgerDay ? { billDate: billDayOf(result.window), resettleRequestedAt } : null });
      if (saved === true && observationOnly) {
        // 一条绑定只留最新的一份（口径、凭据变了以后旧键不会再用到）；已删除、停用的绑定在 refreshDue 里清
        for (const key of observationWrites.keys()) if (key.startsWith(`${rule.id}:`) && key !== observationKey) observationWrites.delete(key);
        observationWrites.set(observationKey, { fingerprint: observationFingerprint, at: Date.now() });
      }
      return saved;
    };
    // 调用方已核对过口径；写快照的事务会在规则行锁内再按库里的口径核对一次，这里只需挡住已作废的代次。
    if (currentSourceCredential(rule) !== sourceCredential) return false;
    if (saveSnapshots) {
      let saved;
      try {
        saved = await withObservationSourceLock(rule, sourceCredential, async () => {
          if ((ruleGenerations.get(rule.id) || 0) !== generation) return false;
          return save();
        }, billingSource);
      } catch {
        throw codedError("PERSISTENCE_FAILED", issueText("PERSISTENCE_FAILED"));
      }
      if (saved !== true) return false;
      // 单日记进账本时，固定时刻以账本里最新那一版为准（仓库在记账的事务里带回来）：重结内容相同（B-L1）不写新版，页面仍是原来那个时刻
      if (settled) {
        result.settledAt = ledgerOption?.booked?.settledAt ?? result.generatedAt;
        // 这次是真的写了新版（不是 B-L1 内容相同跳过）：result 自己就是刚写进账本的那一版，补上账本的版本号、来源、
        // 固定时刻和汇率，bookedResult 就不用再读一次账本行（安全审核 C2a 低-3）。B-L1 那种情况账本里的版本、来源
        // 可能和这次算出来的不一样（上一版可能是别的触发方式写的），这里判断不了，留给 bookedResult 照旧读一次
        if (ledgerOption?.booked?.write === true) {
          result.ledger = { billDate: billDayOf(result.window), revision: ledgerOption.booked.revision, source: ledgerOption.booked.source,
            // 汇率按账本的精度（6 位小数）取整，和从账本行读出来的逐字一致（审核 C2a 第二轮低-3）
            settledAt: ledgerOption.booked.settledAt, rates: { income: ledgerRate(financialSnapshot.income), cost: ledgerRate(financialSnapshot.cost) },
            costBasis: financialSnapshot.costBasis, ...(result.consumeLogSetting ? { consumeLogSetting: result.consumeLogSetting } : {}) }; // 和 ledgerReference 同一个形状
        }
      }
    }
    if (!await hasCurrentScope(rule.id, scopeFingerprint, generation, !!rule.archivedAt)) return false;
    if (currentSourceCredential(rule) !== sourceCredential) return false;
    // 告警跟随今天的观测；结账已结束的自然日不动告警，否则昨天结账 READY 会清掉今天的告警，下一轮又重复推送。
    if (result.health.code !== "PENDING" && !isSettleableWindow(result.window, Date.now())) {
      try { await notifyReconciliationHealth(rt, repository, rule, result); } catch (err) {
        console.error("渠道对账通知失败:", err?.message || String(err));
      }
    }
    return true;
  }

  // 改了切换时间的这天太早没自动重算、重算的数比原来少了一半多没换掉（RESETTLE_TOO_OLD、RESETTLE_SHRUNK，C2b）：
  // 页面上这天还是已固定的旧数，要告诉人「需处理」。这两件事只记在状态行里，所以单日、已结束的结果多读一次状态表（一条查询，
  // 这张表正常时接近空）；结果是缓存的，不能改原对象，带上这条问题的是一份新的
  async function withSettlementNotices(rows, now) {
    const days = rows.filter((row) => row && row !== STALE_SCOPE && row.rule && row.window && billDayOf(row.window) && isSettleableWindow(row.window, now));
    if (!days.length) return rows;
    let states;
    // 只读选的这几天的行：TOO_OLD、SHRUNK 的行不随清理删，一直读全部会越读越多（审核 C3 低-3）
    try { states = await repository.listSettlementStates([...new Set(days.map((row) => row.rule.id))], { billDates: [...new Set(days.map((row) => billDayOf(row.window)))] }); } catch { return rows; }
    // 要人处理的两种（行里的原因栏）；改了时间的重算请求 7 天还没成、系统已经放弃的（R6，由请求时刻推出来）；
    // 过去的日子读取类的原因（行里有重试记录）一直没读成、过了 7 天系统不再自动读（C①，由这天结束的时刻推出来）
    const codeOf = (state, window) => RESETTLE_KEPT_REASONS.includes(state.manualReason) ? state.manualReason
      : state.resettleRequestedAt != null && now - Number(state.resettleRequestedAt) >= SETTLE_LOOKBACK_MS ? "RESETTLE_NOT_DONE"
        : state.retryReason != null && state.manualReason == null && now - window.endMs >= SETTLE_LOOKBACK_MS ? "SETTLE_LOOKBACK_EXPIRED" : null;
    const byDay = new Map(states.map((state) => [`${state.ruleId}|${state.billDate}`, state]));
    return rows.map((row) => {
      const state = days.includes(row) ? byDay.get(`${row.rule.id}|${billDayOf(row.window)}`) : null;
      const code = state ? codeOf(state, row.window) : null;
      if (!code) return row;
      const issue = { code, scope: "history", detail: issueText(code), observedAt: state.manualSince ?? undefined,
        ...(state.detail?.shrunk ? { shrunk: state.detail.shrunk } : {}) };
      return { ...row, health: { ...row.health, issues: [...(row.health?.issues || []), issue] } };
    });
  }

  function readResponse(knownRules, rules, results, registry, input, now) {
    const factsFor = (result) => {
      const resource = registry.resources.get(result.rule.ownStationId);
      // 固定账属于保存时的来源；旧账缺来源时也不能借当前账号补成已核验的财务事实。
      const source = result.settledAt ? result.ownSource ?? null
        : result.rule.ownSource && resource?.identity && resource.station ? ownSourceFor(resource.station, resource.identity) : null;
      const provider = registry.resources.get(result.rule.upstreamStationId)?.metadata?.platform || result.rule.provider;
      // 汇率按当前配置（没设置的 source 为 default，页面按 USD 原值显示）；固定采购的上游成本记为 0。
      // 已结账的日子用账本记下的汇率和成本计法，账本没记的（当时没配置、迁移的旧账）按当前配置。
      const upstream = upstreamStation(result.rule.upstreamStationId), ledger = result.ledger;
      const { income, cost, costBasis } = ratesFor({ own: upstreamStation(result.rule.ownStationId), upstream, saved: ledger, costBasis: result.costBasis });
      const rates = { income: { stationId: result.rule.ownStationId, ...income }, cost: { stationId: result.rule.upstreamStationId, ...cost }, costBasis };
      const enriched = Object.assign(result, { rates, ownSource: source, scope: result.scope || reconciliationBillingSchedule(result.rule),
        billingTimezone: result.billingTimezone || commonBillingTimezone(result.window, [result.upstream, result.downstream]),
        amountBasis: result.amountBasis || { id: "channel-billing-usd-v3", currency: "USD", billingSource: RECONCILIATION_BILLING_SOURCE,
          calculationVersion: RECONCILIATION_CALCULATION_VERSION, conversion: provider === "sub2api" ? "provider_cost_usd" : provider === "newapi" ? "quota_per_unit" : null } });
      // 界面状态只在这里算一次（实时 / 已固定 / 需处理），按钮从它推出来。
      enriched.displayStatus = reconciliationDisplayStatus(enriched, { now });
      enriched.actions = reconciliationResultActions(enriched, { now, displayStatus: enriched.displayStatus });
      return enriched;
    };
    const selected = results.map(factsFor), coverageFacts = [...selected];
    knownRules = knownRules.map((rule) => selected.find((row) => row.rule.id === rule.id)?.rule || rule);
    for (const rule of rules.filter((rule) => rule.enabled && !selected.some((row) => row.rule.id === rule.id))) {
      const window = resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now), cached = resultCache.get(resultKey(rule, window));
      const resource = registry.resources.get(rule.upstreamStationId), key = resource?.metadata?.tokens.find((token) => token.id === rule.tokenId);
      if (!cached || cached.sourceCredential !== currentSourceCredential(rule) || cached.billingCredential !== registry.billingSource.ownerVersion
        || now - cached.at >= resultTtl(window) || !sameReconciliationWindow(cached.value.window, window, { asRequested: true, timezone: false })
        || !key || key.status !== 1 || key.name !== cached.value.rule.tokenName || key.group !== cached.value.rule.fixedGroup
        || reconciliationScopeFingerprint(rule, cached.value.transitionSegments || []) !== reconciliationScopeFingerprint(cached.value.rule, cached.value.transitionSegments || [])) continue;
      coverageFacts.push(factsFor(cached.value));
    }
    const catalogue = rt.onboardingSource?.getSourceCatalogue?.() || null;
    const coverage = deriveKnownChannelCoverage(catalogue, knownRules, coverageFacts);
    // 金额默认按系统原值（USD）显示；本站、各关联上游和账号级对比涉及的上游都设置了汇率时，整页按人民币显示。
    const upstreams = usageUpstreams();
    const rateStations = new Map([
      ...selected.flatMap((row) => [row.rates.income, row.rates.costBasis === "fixed" ? null : row.rates.cost]).filter(Boolean)
        .map((rate) => [rate.stationId, isConfiguredRate(rate)]),
      ...[upstreams?.own, ...(upstreams?.usage || [])].filter(Boolean).map((station) => [station.id, isConfiguredRate(rateSnapshotOf(station))]),
    ]);
    const displayCurrency = [...rateStations.values()].every(Boolean) ? reconciliationDisplayCurrency(selected) : "USD";
    // 已经设置了部分汇率时才提示还缺哪些；一个都没设置就是按 USD 看，不打扰。
    const unconfiguredRateStations = [...rateStations.values()].some(Boolean)
      ? [...rateStations].filter(([, configured]) => !configured).map(([id]) => ({ id, name: upstreamStation(id)?.name || `${UPSTREAM_GONE}（${id}）` })) : [];
    // 我的站点只摊销开了监控、计入成本、没归档的固定采购站点；关联建在其他固定采购站点上时点名，核算页说明净利也不含它们的采购费。
    const offProfit = upstreams ? fixedOffProfitStations(selected, { amortizedIds: upstreams.fixed.map((station) => station.id), stationOf: upstreamStation }) : [];
    const grouped = summarizeReconciliationWindowGroups(selected, { currency: displayCurrency, coverageFor: (window, source) => {
      const sameSource = (value) => source?.namespaceKey ? value?.namespaceKey === source.namespaceKey : !value;
      return deriveKnownChannelCoverage(catalogue && sameSource(catalogue.ownSource) ? catalogue : null,
        knownRules.filter((rule) => sameSource(rule.ownSource)), coverageFacts.filter((result) => sameSource(result.ownSource)), { window });
    } });
    // 自营站点一层的事项（用户 10-25 定，不等 E）：现在还关着收费记录的站点一条「重新检查」；令牌读不到设置的站点一条「更新登录信息」。
    // 各天的原因已经在每条绑定里，这两条是按站点出的，和每条绑定的那条同一个去处（总览里按去处去重，只留一条）
    const siteActions = ownSiteActions(rules);
    const actions = [...new Map([...selected.flatMap((row) => row.actions), ...siteActions, ...coverage.channels.flatMap((channel) => channel.actions)]
      .map((action) => [action.id, action])).values()];
    // tz：业务时区。绑定按别的时区算一天时，页面才说明「按 UTC 时间算一天」（design/ui-copy-spec.md §6）。
    return { results: selected, generatedAt: new Date(now).toISOString(), tz: businessTimeZone(), ...grouped, coverage, actions, displayCurrency, unconfiguredRateStations, fixedOffProfitStations: offProfit };
  }

  // 账号级上游用量：和我的站点同一取数（用量接口，返回 0 或失败时按余额历史推算）。实时窗口缓存键只认起点，
  // 失败的结果只缓存一分钟；force（页面「刷新」）只复用正在进行的取数，上游慢时进行中的取数最多复用两分钟。
  function accountUsageFor(station, window, { force = false } = {}) {
    const live = isLiveReconciliationPreset(window.preset), now = Date.now();
    const key = JSON.stringify([station.id, window.startMs, live ? window.preset : window.endMs, canonicalTimeZone(window.timezone), credentialFingerprint(station)]);
    const cached = accountUsageCache.get(key);
    if (cached && (cached.pending ? now - cached.at < ACCOUNT_USAGE_PENDING_MAX_MS : !force && now - cached.at < cached.ttl)) return cached;
    for (const [cachedKey, entry] of accountUsageCache) if (!entry.pending && now - entry.at >= entry.ttl) accountUsageCache.delete(cachedKey);
    const entry = { at: now, ttl: live ? TODAY_TTL_MS : ACCOUNT_USAGE_TTL_MS, pending: true, value: null };
    entry.promise = Promise.resolve()
      .then(() => stationUsageCost(rt, station, { startMs: window.startMs, endMs: window.endMs, tz: window.timezone, today: window.preset === "today" }))
      .catch(() => ({ usd: null, mode: "unavailable", note: issueText("UPSTREAM_DATA_UNAVAILABLE") }))
      .then((value) => {
        // 上游错误原文可能回显令牌：只保留固定提示；errorCode 是 own-helpers 给自营页用的，这里不往外带。
        let { error, errorCode, ...usage } = value;
        // 按余额历史推算但历史没覆盖整个时段（新加的站点、sk 密钥站点）：推出来的消耗只是下限，推不出消耗就算读不到。
        if (usage.mode === "history" && !rt.history?.covers?.(station.id, window.startMs, window.endMs)) {
          usage = Number(usage.usd) > 0 ? { ...usage, lowerBound: true, note: `${usage.note}；历史数据不够，金额偏低` }
            : { usd: null, mode: "unavailable", note: issueText("UPSTREAM_DATA_UNAVAILABLE") };
        }
        Object.assign(entry, { pending: false, at: Date.now(), value: { ...usage, endMs: window.endMs },
          ttl: error || usage.usd == null ? Math.min(entry.ttl, TODAY_TTL_MS) : entry.ttl });
        return entry;
      });
    accountUsageCache.set(key, entry);
    while (accountUsageCache.size > MAX_ACCOUNT_USAGE_ENTRIES) accountUsageCache.delete(accountUsageCache.keys().next().value);
    return entry;
  }

  function usageUpstreams() {
    const own = ownStation();
    if (!own) return null;
    // store.list() 默认已不含归档站点（我的站点的利润也靠这个默认行为排除归档站点）；这里再过滤一次，不依赖 list 的默认参数
    const { included, excluded } = selectCostUpstreams(rt.store.list().filter((station) => !station.archivedAt), own.id);
    return { own, usage: included.filter((station) => costBasisOf(station) === "usage"), fixed: included.filter((station) => costBasisOf(station) === "fixed"), excluded };
  }

  // 和规则取数同时开始读账号用量，读页面时多半已经取到。各关联时区解析出同一个窗口时才会有共同汇总和账号级对比，
  // 所以只在这种情况下取数，并和 unaccountedUpstreamFor 一样用排序后的第一个时区。
  function warmAccountUsage(rules, input, now, force) {
    const upstreams = usageUpstreams();
    if (!upstreams) return;
    const windows = [];
    for (const timezone of [...new Set(rules.map((rule) => rule.timezone))].sort()) {
      try { windows.push(resolveReconciliationWindow({ ...input, timezone }, now)); } catch { return; }
    }
    if (!windows.length || windows.some((window) => !sameReconciliationWindow(window, windows[0], { timezone: false }))) return;
    for (const station of upstreams.usage) accountUsageFor(station, windows[0], { force });
  }

  // 未纳入核算的上游消费只对共同汇总给出：一个窗口、一个本站来源，账号级扣费才能和核算成本相减。
  async function unaccountedUpstreamFor(response, input, now) {
    const summary = response.commonSummary;
    const group = summary && response.windowGroups.find((item) => item.groupKey === summary.groupKey);
    const upstreams = usageUpstreams();
    if (!group || !upstreams) return null;
    let window;
    try { window = resolveReconciliationWindow({ ...input, timezone: group.timezones[0] }, now); } catch { return null; }
    if (window.startMs !== group.window.startMs) return null;
    const entries = upstreams.usage.map((station) => accountUsageFor(station, window));
    let timer;
    await Promise.race([Promise.all(entries.map((entry) => entry.promise)),
      new Promise((resolve) => { timer = setTimeout(resolve, ACCOUNT_USAGE_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    const dayAligned = isDayStartInTz(window.startMs, window.timezone) && isDayStartInTz(window.endMs, window.timezone);
    const attributed = attributeAuthorizationRules({ usageStations: upstreams.usage, rows: response.results, stationOf: (id) => rt.store.get(id),
      monitorLinks: rt.onboardingSource?.getMonitorLinks?.() || [] });
    const summarized = summarizeUnaccountedUpstream(upstreams.usage.map((station, index) => ({
      station: { id: station.id, name: station.name }, rate: rateSnapshotOf(station),
      usage: entries[index].pending ? null : entries[index].value,
      approximate: station.type.startsWith("sub2api") && !dayAligned && !isLiveReconciliationPreset(window.preset),
      ...attributed.get(String(station.id)),
    })), response.results, { currency: response.displayCurrency });
    const named = (stations) => stations.map((station) => ({ id: station.id, name: station.name }));
    // 设为不计入成本的固定采购上游也不按用量计成本，列在固定采购里；不计入成本里只列按用量计费的（建在上面的关联仍计 Key 成本）。
    const excludedFixed = upstreams.excluded.filter((station) => costBasisOf(station) === "fixed");
    return { ...summarized, window: { startMs: group.window.startMs, endMs: group.window.endMs, timezone: window.timezone, preset: window.preset },
      fixedStations: named([...upstreams.fixed, ...excludedFixed]), excludedStations: named(upstreams.excluded.filter((station) => costBasisOf(station) !== "fixed")) };
  }

  // 一轮结账（计划 C2a 2.2）：先定要结哪些天（planSettlement），再观测今天（refreshDue 里），再结昨天，再回看更早的日子。
  // 批量读状态表和账本近 8 天有哪些日子（两条查询，不按绑定逐条查）；逐天 precheck 只看状态、不发请求；
  // 昨天不占预算；回看最多 K 天、最多 T 毫秒，同一个上游同时最多 1 天，某个上游这一轮回看没成就不再给它取别的日子。
  // upstreams 是这一轮会结账的上游，refreshDue 在读 Key 目录和身份之前把它们记进 staleMetadata 全部重读（计划 P1b）；
  // 回看只给这些上游结：昨天要结的上游，加上按顺序排在预算以内的那几天的上游，没重读过的上游留到下一轮
  async function planSettlement(rules, now) {
    const plan = { yesterday: [], older: [], recheck: [], upstreams: new Set() };
    if (!rules.length) return plan;
    const ruleIds = rules.map((rule) => rule.id);
    let states, ledgerDays;
    try {
      [states, ledgerDays] = await Promise.all([repository.listSettlementStates(ruleIds),
        repository.listLedgerDays(ruleIds, dayKeyInTz(now - (SETTLE_LOOKBACK_DAYS + 2) * DAY_MS, "UTC"))]);
    } catch (err) { console.error("读结账状态失败:", err?.message || String(err)); return plan; }
    const stateOf = new Map(states.map((state) => [`${state.ruleId}|${state.billDate}`, state]));
    const booked = new Set(ledgerDays.map((day) => `${day.ruleId}|${day.billDate}`));
    const sourceVersion = billingSourceState().version;
    for (const [key, at] of recheckAt) if (at <= now) recheckAt.delete(key);
    const visit = (rule, window, back) => {
      const billDate = billDayOf(window), key = `${rule.id}|${billDate}`, state = stateOf.get(key) || null;
      const scopeEditedAt = Number.isFinite(rule.billingEffectiveFrom) ? rule.billingEffectiveFrom : null;
      // 重结请求就在状态行里（state.resettleRequestedAt），precheck 自己看
      const { action } = settlementPrecheck({ rule, window, now, state, ledgerHasDay: booked.has(key), sourceVersion, scopeEditedAt, recheckNotBefore: recheckAt.get(key) ?? null });
      if (action === "settled" && state) repository.deleteSettlementState(rule.id, billDate).catch(() => {});
      // 要人处理、到了重判的时刻：不进 upstreams（不为它强制重读），settleDue 拿这一轮的目录和身份在本地重判
      if (action === "recheck") plan.recheck.push({ rule, window, state });
      if (action !== "due") return;
      // 有重结请求的日子 trigger 传 null：账本明细里记 transition（persistResult 按 resettle 给），不被 late 盖掉
      const requested = state?.resettleRequestedAt != null;
      (back === 1 ? plan.yesterday : plan.older).push({ rule, window, state, requested, trigger: back === 1 || requested ? null : "late" });
    };
    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
    const seen = new Set();
    for (const rule of rules) {
      for (let back = 1; back <= SETTLE_LOOKBACK_DAYS + 1; back += 1) {
        let window;
        try { window = completedDayWindow(rule, back, now); } catch { break; }
        seen.add(`${rule.id}|${billDayOf(window)}`);
        visit(rule, window, back);
      }
    }
    // 有重结请求的日子不受回看天数限制（改的时间可能在很久以前）：回看范围以外的，按状态行的日期补进候选
    for (const state of states) {
      if (state.resettleRequestedAt == null || seen.has(`${state.ruleId}|${state.billDate}`)) continue;
      const rule = ruleById.get(state.ruleId);
      if (!rule) continue;
      let window;
      try { window = { preset: "custom", startMs: dayStartInTz(state.billDate, rule.timezone), endMs: dayStartInTz(shiftDayLabel(state.billDate, 1), rule.timezone), timezone: rule.timezone }; } catch { continue; }
      visit(rule, window, null);
    }
    for (const { rule } of plan.yesterday) plan.upstreams.add(rule.upstreamStationId);
    if (Date.now() < lookbackFrom) plan.older = [];
    // 有重结请求的日子排在更早的日子前面；同样先结离今天近的
    plan.older.sort((a, b) => Number(b.requested) - Number(a.requested) || b.window.startMs - a.window.startMs);
    plan.budget = Math.min(lookbackBudget ?? Math.max(1, Math.ceil(rules.length / 2)), SETTLE_LOOKBACK_MAX_PER_ROUND);
    for (const { rule } of plan.older.slice(0, plan.budget)) plan.upstreams.add(rule.upstreamStationId);
    plan.older = plan.older.filter((item) => plan.upstreams.has(item.rule.upstreamStationId));
    return plan;
  }

  async function settleDue({ yesterday, older, recheck = [], budget }, ownerRegistry) {
    const sourceVersion = ownerRegistry.billingSource.version;
    // 取数前的判断（inspectRule 的 probe）：还挡着的要人处理的原因码；判不出来（出错、还没锚定、口径正在改）时是 undefined
    const probe = async (rule, window) => {
      try {
        const probed = await inspectRule(rule.id, window, { mode: "settle", probe: true, origin: "poll", ownerRegistry });
        return probed?.probe ? probed.blocker : undefined;
      } catch (err) {
        if (err?.code !== "RULE_NOT_FOUND") console.error("重判结账状态失败:", err?.message || String(err));
        return undefined;
      }
    };
    // 同一条绑定这一轮只判一次：挡着的原因是绑定这一刻的配置和元数据决定的，和具体哪一天无关，不用一天判一次
    // （方案 6.3「不多查库」，安全审核 C2a 低-2：50 条绑定都卡 7 天时，原来一条绑定要判 7 次）
    const recheckByRule = new Map();
    for (const item of recheck) {
      const list = recheckByRule.get(item.rule.id);
      if (list) list.push(item); else recheckByRule.set(item.rule.id, [item]);
    }
    await mapWithConcurrency([...recheckByRule.values()], MAX_CONCURRENT_RULES, async (items) => {
      const { rule, window } = items[0];
      const probed = await probe(rule, window);
      for (const item of items) {
        // 没判出来：照原因还在处理，10 分钟后再判，不每轮重来
        const blocker = probed === undefined ? item.state.manualReason : probed;
        const next = settlementRecheck({ window: item.window, state: item.state, blocker, now: Date.now(), sourceVersion });
        const billDate = billDayOf(item.window);
        // 原因没变：不写状态行，只把下次重判的时刻记在进程里（每 10 分钟写一次状态行没有意义）；原因变了、没了才写
        if (recheckUnchanged(item.state, next)) { recheckAt.set(`${rule.id}|${billDate}`, Number(next.nextAttemptAt)); continue; }
        recheckAt.delete(`${rule.id}|${billDate}`);
        // requestedAt：这一行里的重结请求时刻（有请求的日子才写得进去，见 recordSettlementState）
        try { await repository.recordSettlementState(rule.id, billDate, next, Date.now(), { requestedAt: item.state.resettleRequestedAt ?? null }); } catch (err) { console.error("记结账状态失败:", err?.message || String(err)); }
      }
    });
    const settle = async ({ rule, window, state, trigger }) => {
      // 第一次试的日子（没有状态行）先在本地判断：取数前就能看出要人处理的（没回答「这把 Key 还给别处用吗？」、来源没确认……）
      // 直接记下，不取账单。刚上线时回看 7 天的那一批就不会为挡着的绑定白取一遍
      if (!state) {
        const blocker = await probe(rule, window);
        if (blocker && reasonKindOf(blocker) !== "retry") {
          const next = settlementOutcome({ window, result: { health: { code: blocker } }, now: Date.now(), sourceVersion }).state;
          try { if (next) await repository.recordSettlementState(rule.id, billDayOf(window), next); } catch (err) { console.error("记结账状态失败:", err?.message || String(err)); }
          return { blocked: true };
        }
      }
      // 重结请求在写账本的事务里按值消费（saveSnapshotsForScope）：结成了这条请求就办完了，取数期间才提的新请求留着；
      // 没结成按 settlementOutcome 记进状态行，退避由状态行管（请求本身保留，7 天不成就放弃）
      return settleDay(rule, window, { origin: "poll", ownerRegistry, state, trigger }).catch(() => null);
    };
    await mapWithConcurrency(yesterday, MAX_CONCURRENT_RULES, settle);
    if (!older.length) return;
    const interval = Math.max(60, Number(rt.store?.settings?.refreshIntervalSec) || 60) * 1000;
    const deadline = Date.now() + (lookbackTimeMs ?? Math.min(20000, Math.floor(interval / 3)));
    const busy = new Set(), skipped = new Set();
    let taken = 0;
    const next = () => {
      if (taken >= budget || Date.now() >= deadline) return null;
      const index = older.findIndex((item) => !busy.has(item.rule.upstreamStationId) && !skipped.has(item.rule.upstreamStationId));
      if (index < 0) return null;
      taken += 1;
      return older.splice(index, 1)[0];
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT_RULES }, async () => {
      for (let item = next(); item; item = next()) {
        busy.add(item.rule.upstreamStationId);
        const result = await settle(item);
        busy.delete(item.rule.upstreamStationId);
        // 本地就判出来挡着的：没取账单，不占预算，也不算这个上游没成
        if (result?.blocked) taken -= 1;
        // 方案 6.4：只有碰到限流（429/5xx，UPSTREAM_REQUEST_FAILED）或超时、连不上（NETWORK_UNREACHABLE）才不再给这个
        // 上游取别的回看日——这两类是这个上游这一刻整体的问题，再取别的日子大概率还是一样。别的没结成的原因（某一天
        // 自己的问题，比如要人处理、改绑定之前还没固定）只挡这一天，不该连累同一上游别的绑定（安全审核 C2a 低-4）
        else if (upstreamUnavailable(result)) skipped.add(item.rule.upstreamStationId);
      }
    }));
  }

  // 每小时清一批结账状态表：31 天前的、没有重结请求的行（挂在轮询里，不另起定时器）
  async function pruneSettlementStates(now) {
    if (now - (rt._reconciliationLastPrune || 0) < 3600000) return;
    rt._reconciliationLastPrune = now;
    try { await repository.pruneSettlementStates(dayKeyInTz(now - 31 * DAY_MS, "UTC"), 500, now - 31 * DAY_MS); } catch { /* 下一小时再清 */ }
  }

  const api = {
    async getConfiguration({ forceChannels = false, includeArchived = false } = {}) {
      const own = ownStation();
      const rules = await repository.listRules({ includeArchived });
      const upstreams = rt.store.list({ includeUnmonitored: true }).filter((station) => billingStation(station) && !station.archivedAt).map(publicStation);
      let channels = [];
      let channelsError = null, channelsErrorCode = null;
      if (own) {
        try { channels = await ownChannelsFor(own, { force: forceChannels }); } catch (err) {
          // 上游错误原文可能回显令牌：只返回脱敏后的原文（进「查看详细原因」）和 code（界面按 code 归类，§8.2）。
          // 码由 ownStationErrorCode 给（lib/error-copy.js，§8.2），和别处读自营站点没成时一样：
          // 通用的繁忙、连不上和认不出的说「自营站点暂时读不到」，有自己那句话的码照旧。
          channelsError = connectionDiagnostic(err, own);
          console.error("本站渠道目录读取失败:", channelsError);
          channelsErrorCode = ownStationErrorCode(err);
        }
      }
      return { ownStation: publicStation(own), upstreams, channels, channelsError, channelsErrorCode, rules };
    },

    async getUpstreamKeys(stationId, { force = false, timezone, tokenId } = {}) {
      let zone;
      try {
        if (timezone != null && (typeof timezone !== "string" || !timezone.trim())) throw new Error();
        zone = canonicalTimeZone(timezone);
      } catch { throw codedError("INVALID_REQUEST", "时区不对"); }
      const selectedId = tokenId == null ? null : Number(tokenId);
      if (tokenId != null && (typeof tokenId !== "number" && (typeof tokenId !== "string" || !/^\d+$/.test(tokenId))
        || !Number.isSafeInteger(selectedId) || selectedId <= 0)) {
        throw codedError("INVALID_REQUEST", "Key ID 不对");
      }
      const station = upstreamStation(stationId);
      if (!billingStation(station)) throw codedError("UPSTREAM_NOT_FOUND", "找不到这个上游");
      const connection = structuredClone(station), resourceVersion = stationBusinessVersion(connection);
      if (!force && selectedId == null) return { ...publicMetadata(await metadataFor(connection, { timezone: zone })), identity: null, resourceVersion, probe: null };
      const credential = credentialFingerprint(connection);
      const assertCurrent = () => {
        if (stationBusinessVersion(upstreamStation(stationId)) !== resourceVersion
          || credentialFingerprint(upstreamStation(stationId) || {}) !== credential) {
          throw codedError("RESOURCE_CHANGED", "上游在这期间改过，请刷新后再试");
        }
      };
      let identity, metadata;
      try { identity = await queryAccountIdentity(connection); }
      catch { assertCurrent(); throw codedError("KEY_PROBE_UNAVAILABLE", "上游暂时读不到，请稍后再试"); }
      assertCurrent();
      identity = { provider: identity.provider, baseUrl: identity.baseUrl, accountId: String(identity.accountId) };
      try { metadata = await metadataFor(connection, { force: true, timezone: zone }); }
      catch (error) {
        assertCurrent();
        if (error.code === "UPSTREAM_IDENTITY_CHANGED") throw codedError("RESOURCE_CHANGED", "上游在这期间改过，请刷新后再试");
        if (selectedId != null) throw codedError("KEY_METADATA_UNAVAILABLE", "读不到这个上游的 Key 列表");
        return { quotaPerUnit: null, version: "", groups: {}, tokens: [], platform: identity.provider,
          capability: { state: "unverified", currency: "USD", window: identity.provider === "newapi" ? "second" : "natural-day", reason: "KEY_METADATA_UNAVAILABLE" },
          billingTimezone: { state: "unverified", timezone: zone, reason: "KEY_METADATA_UNAVAILABLE" }, identity, resourceVersion, probe: null };
      }
      assertCurrent();
      if (metadata.platform !== identity.provider || onboardingBaseUrl(metadata.baseUrl) !== identity.baseUrl
        || String(metadata.accountId ?? metadata.userId) !== identity.accountId) {
        throw codedError("RESOURCE_CHANGED", "上游在这期间改过，请刷新后再试");
      }
      let probe = null;
      if (selectedId != null) {
        const token = metadata.tokens.find((item) => item.id === selectedId);
        if (!token || token.status !== 1 || !tokenNameIsUnique(metadata, token)) {
          throw codedError("INVALID_REQUEST", "请选一把名字不重复的 Key");
        }
        let stat;
        // 选定 Key 是用户显式发起的核验，核验结果写入账单能力表，重启后仍有效。
        try { stat = await queryKeyReconciliationStat(connection, { token, metadata, capabilityStore: billingCapabilityStore, ...completedBillingDayWindow(zone) }); }
        catch { assertCurrent(); throw codedError("KEY_PROBE_UNAVAILABLE", "上游暂时读不到，请稍后再试"); }
        assertCurrent();
        const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
        const capability = stat.capability || metadata.capability;
        probe = { tokenId: selectedId, state: stat.state, complete: stat.complete === true,
          window: { startMs: number(stat.window?.startMs), endMs: number(stat.window?.endMs), timezone: stat.window?.timezone ?? null },
          currency: stat.currency || capability?.currency || "USD", amountUsd: number(stat.amountUsd), knownAmountUsd: number(stat.knownAmountUsd),
          actualCostUsd: number(stat.actualCostUsd), quotaUnits: number(stat.quotaUnits), quotaPerUnit: number(stat.quotaPerUnit),
          capability: capability ? Object.fromEntries(["state", "currency", "window", "reason", "message"].filter((key) => capability[key] != null).map((key) => [key, capability[key]])) : null,
          billingTimezone: stat.billingTimezone ? Object.fromEntries(["state", "timezone", "reason"].filter((key) => stat.billingTimezone[key] != null).map((key) => [key, stat.billingTimezone[key]])) : null };
      }
      return { ...publicMetadata(metadata), identity, resourceVersion, probe };
    },

    createRule: saveRule,
    updateRule,
    appendChannels,
    previewKeyScope,
    createPreviewReadContext,
    listRules: (options = {}) => repository.listRules(options),
    async getConfirmedHistory(id, input = {}) {
      const options = normalizeConfirmedHistoryOptions(input);
      try {
        if (!await repository.getRule(id, { includeArchived: true })) throw ruleNotFound();
        return { ruleId: id, readOnly: true, ...await repository.listLedgerHistory(id, options) };
      } catch (error) {
        if (error.code === "RULE_NOT_FOUND" || error.code === "INVALID_REQUEST") throw error;
        throw codedError("HISTORY_UNAVAILABLE", "系统还没准备好，请稍后刷新");
      }
    },
    async findRuleForKey(stationId, tokenId) {
      const station = upstreamStation(stationId);
      if (!billingStation(station)) throw codedError("UPSTREAM_NOT_FOUND", "找不到这个上游");
      const metadata = await metadataFor(station);
      const key = canonicalBillingKey(station, metadata, tokenId);
      if (!key) throw codedError("COST_OWNER_UNVERIFIED", issueText("COST_OWNER_UNVERIFIED"));
      const matches = await canonicalRules(key, Number(tokenId));
      if (matches.length > 1) throw codedError("CANONICAL_KEY_CONFLICT", issueText("CANONICAL_KEY_CONFLICT"));
      return matches[0] || null;
    },
    async archiveRule(id) {
      return serializeWrite(async () => {
        const rule = await repository.getRule(id);
        if (!rule) throw ruleNotFound();
        const billingSource = billingSourceState();
        const ok = await withObservationSourceLock(rule, currentSourceCredential(rule), async () => {
          const archived = await repository.archiveRule(id);
          if (archived) clearBillingResults(id);
          return archived;
        }, billingSource);
        if (ok === STALE_SCOPE) throw staleScope();
        if (!ok) throw ruleNotFound();
        return { ruleId: rule.id, tokenName: rule.tokenName, fixedGroup: rule.fixedGroup, releasedChannelCount: rule.channels.length };
      });
    },
    async listSegments(id) {
      const rule = await repository.getRule(id, { includeArchived: true });
      if (!rule) throw ruleNotFound();
      return repository.listSegments(id);
    },
    async correctTransition(ruleId, segmentId, effectiveAt) {
      return serializeWrite(async () => {
        const rule = await repository.getRule(ruleId, { includeArchived: true });
        if (!rule) throw ruleNotFound();
        const billingSource = billingSourceState();
        let plan = null;
        const segments = await withObservationSourceLock(rule, currentSourceCredential(rule), async () => {
          // 分段和重结请求（改到的每个已结束的业务日各一条）在仓库的同一个事务里写
          const corrected = await repository.correctTransition(ruleId, segmentId, effectiveAt, { now: Date.now(), onPlan: (value) => { plan = value; } });
          clearBillingResults(ruleId);
          return corrected;
        }, billingSource);
        if (segments === STALE_SCOPE) throw staleScope();
        // resettle：改到的已结束的日子里，会自动重算的有几天（recent），太早没自动重算的是哪几天（tooOld，日期从早到晚）
        return { segments, resettle: { recent: plan?.recent.length ?? 0, tooOld: plan?.tooOld ?? [] } };
      });
    },
    async queryRules({ ruleIds = null, ...input } = {}, options = {}) {
      for (let attempt = 1; ; attempt += 1) {
        const knownRules = await repository.listRules({ includeArchived: true });
        const rules = knownRules.filter((rule) => !rule.archivedAt);
        const selected = (Array.isArray(ruleIds) && ruleIds.length)
          ? rules.filter((rule) => rule.enabled && ruleIds.includes(rule.id))
          : rules.filter((rule) => rule.enabled);
        const ownerRegistry = await ownerRegistryFor(rules, selected, { observe: options.mode !== "evaluate" });
        const billingSource = ownerRegistry.billingSource;
        const now = Date.now();
        // 页面全量读取才附带账号级对比（true 复用缓存，"refresh" 是页面「刷新」，重新读上游用量）；按关联重试和后台观测不需要。
        const accountUsage = [true, "refresh"].includes(options.accountUsage) && !(Array.isArray(ruleIds) && ruleIds.length);
        if (accountUsage && attempt === 1 && selected.length) warmAccountUsage(selected, input, now, options.accountUsage === "refresh");
        const respond = async (rows) => {
          await syncOptionUnreadableSince(rules, { observe: options.mode !== "evaluate" });
          const response = readResponse(knownRules, rules, await withSettlementNotices(rows, now), ownerRegistry, input, now);
          if (!accountUsage) return response;
          let unaccountedUpstream = null;
          try { unaccountedUpstream = await unaccountedUpstreamFor(response, input, now); } catch { /* 账号级对比只是参考，不能拖垮核算结果 */ }
          return { ...response, unaccountedUpstream };
        };
        // 手动重新读取已经结束的整天时，这几条绑定的状态行一次读出来（不按绑定逐条查）
        let manualStatesRead = null;
        const manualStates = () => (manualStatesRead ||= repository.listSettlementStates(selected.map((rule) => rule.id)).catch(() => []));
        const results = await mapWithConcurrency(selected, MAX_CONCURRENT_RULES, (rule) => {
          // 今天、近 7 天、本月截至取数时刻：规则排队轮到时才定截止点（同 refreshDue），排队久了 Sub2API 实时区间也不会过旧。
          const live = isLiveReconciliationPreset(input.preset);
          const window = resolveReconciliationWindow({ ...input, timezone: rule.timezone }, live ? Math.max(now, Date.now()) : now);
          // 手动「重新读取」一个已经结束的整天：走结账（settle），和轮询回看同一条路；结不成只更新原因，不推后自动的退避（计划 C2a 2.5）
          const manualSettle = options.mode === "observe" && billDayOf(window) && isSettleableWindow(window, Date.now());
          if (manualSettle) {
            return manualStates()
              .then((states) => settleDay(rule, window, { origin: "manual", ownerRegistry, confirmed: options.confirmShrink === true, confirmedAfter: options.confirmedAfter ?? null,
                state: states.find((item) => item.ruleId === rule.id && item.billDate === billDayOf(window)) || null }))
              .catch((err) => { if (err?.code === "RULE_NOT_FOUND") return null; throw err; });
          }
          return inspectRule(rule.id, window, { ...(attempt === 1 ? options : { ...options, force: false }), ownerRegistry }).catch((err) => {
            // 列出规则后才被停止的规则从本轮结果中去掉，不能让整个多规则查询失败。
            if (err?.code === "RULE_NOT_FOUND") return null;
            if (["PERSISTENCE_FAILED", "HISTORY_UNAVAILABLE"].includes(err?.code)) return storageFailedResult(rule, window, err.code);
            throw err;
          });
        });
        if (billingSourceState().version === billingSource.version && !results.includes(STALE_SCOPE)) return respond(results.filter(Boolean));
        if (attempt >= MAX_SCOPE_ATTEMPTS) return respond(selected.map((rule) => pendingResult(rule,
          resolveReconciliationWindow({ ...input, timezone: rule.timezone }, now), issueText("PENDING"))));
      }
    },
    // 每轮观测今天；每条规则按自己的时区，在昨天结束 15 分钟后结账昨天，直到算出毛利为止。
    async refreshDue(now = Date.now()) {
      const startedAt = Date.now();
      const allRules = await repository.listRules();
      const rules = allRules.filter((rule) => rule.enabled);
      // 停用、删除了的绑定不会再写「今天」快照，它们的指纹不留
      const live = new Set(rules.map((rule) => rule.id));
      for (const key of observationWrites.keys()) if (!live.has(key.slice(0, key.indexOf(":")))) observationWrites.delete(key);
      // 先定这一轮要结哪些天（只读状态表和账本），要结的上游先全部重读一遍：写进账本的数一固定就不再变，quota_per_unit 这些不能用 30 分钟前的旧值
      // 最近解除的绑定也要结解除前的日子（回看 7 天内；解除得更早的没有可结的了）。只结账，不观测今天
      const archivedRules = (await repository.listRecentlyArchivedRules(now - (SETTLE_LOOKBACK_DAYS + 2) * DAY_MS).catch(() => [])).filter(archivedSettleable);
      const plan = await planSettlement([...rules, ...archivedRules], now);
      for (const id of plan.upstreams) staleMetadata.add(id);
      // 已解除的绑定只有这一轮真有要结、要重判的日子才进（读它们上游的元数据和身份、判重复占用）；没有就不多读（审核 C3 低-4）
      const archivedIds = new Set(archivedRules.map((rule) => rule.id));
      const archivedUsed = [...plan.yesterday, ...plan.older, ...plan.recheck].some((item) => archivedIds.has(item.rule.id));
      const ownerRegistry = await ownerRegistryFor(allRules, [...rules, ...(archivedUsed ? archivedRules : [])], { observe: true, poll: true });
      await markQuietOwnStations(rules, ownerRegistry);
      await mapWithConcurrency(rules, MAX_CONCURRENT_RULES, async (rule) => {
        // 规则排队轮到时才定今天的截止点：实时窗口截至取数时刻，不能用整轮开始时的旧时刻。
        const at = now + Math.max(0, Date.now() - startedAt);
        await inspectRule(rule.id, resolveReconciliationWindow({ preset: "today", timezone: rule.timezone }, at), { mode: "observe", origin: "poll", ownerRegistry })
          .catch(() => null);
      });
      await syncOptionUnreadableSince(rules, { observe: true }); // 设置读不到的时刻从库里对一遍（重启后内存里是空的），结账和需处理都用它
      await settleDue(plan, ownerRegistry);
      await pruneSettlementStates(now);
      // 自营站点整站日志增量读（应付成本 V1-a）：每轮每个自营站点读几页，额度和断路在 lib/own-request-budget.js；读失败不影响这一轮别的事
      // 「算应付成本」开着（settings.expectedCost === true）才读；没设置过、关着都一个整站读请求都不发（每轮读一次，不用重启；用语规范 §8.3）
      if (ownLogIngest && rt.store?.settings?.expectedCost === true) {
        for (const id of new Set(rules.map((rule) => rule.ownStationId))) {
          const own = upstreamStation(id);
          if (own?.isOwn && own.type === "newapi") await ownLog.ingestOnce(own).catch((error) => console.error("自营站点整站日志读取失败:", error?.message || String(error)));
        }
        await ownLog.pruneIfDue();
      }
    },
    // 应付成本 V1-a：整站日志读取和上游价目表，给 V1-b 的结账和只读试算用
    ingestOwnLog: (own) => ownLog.ingestOnce(own),
    ownLogBuckets: (stationId, fromSlotMs, toSlotMs) => (ownLogStore || rt._ownLogStore).listBuckets(stationId, fromSlotMs, toSlotMs),
    upstreamPricing: (station) => upstreamPricing.pricingFor(station),
    // 自营站点记不记收费记录的最近一次读取结果（{ state: on | off | denied | unavailable, reason? }），没读过是 null；设置页用
    consumeLogStatus: consumeLogStatusOf,
    // 马上再读一次站点设置（「重新检查」、设置页）；读完返回结果
    recheckConsumeLog: (own) => refreshConsumeLog(own, { force: true, always: true }),
    // 接入关联后立即在后台观测今天一次，不必等下一轮轮询。没有启动后台轮询（测试、脚本）时不观测。
    observeSoon(ruleIds) {
      if (!rt._reconciliationPollTimer || !ruleIds?.length) return null;
      return api.queryRules({ preset: "today", ruleIds }, { mode: "observe", origin: "onboarding" }).catch(() => null);
    },
    // 本站授权或渠道目录同步后，Key 目录、账号身份和结果缓存都要重新取；正在算的旧结果也作废。
    invalidateSources() {
      metadataCache.clear();
      identityCache.clear();
      // P1a 的两张表也清：渠道收费的沿用和「今天」快照的跳写都要从现读重新开始
      ownRevenueCache.clear();
      observationWrites.clear();
      clearBillingResults();
    },
    // 接入向导核验 Sub2API Key 时共用同一份能力存储：确认保存时按同一身份读到预览时的核验结果。
    billingCapabilityStore,
  };
  return api;
}

// 每轮结束后按当前设置排下一轮：改了刷新间隔不用重启，慢的一轮也不会和下一轮重叠。
export function startReconciliationPolling(rt) {
  const module = (rt.reconciliation ||= createReconciliationModule(rt));
  if (rt._reconciliationPollTimer) return module;
  const schedule = (delayMs) => {
    rt._reconciliationPollTimer = setTimeout(tick, delayMs);
    rt._reconciliationPollTimer.unref?.();
  };
  const tick = async () => {
    try { await module.refreshDue(); } catch { /* 下一轮重试 */ }
    schedule(Math.max(60, Number(rt.store.settings?.refreshIntervalSec) || 60) * 1000);
  };
  schedule(0);
  return module;
}
