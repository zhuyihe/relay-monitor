// 对账深模块：把窗口、上游取数、本站收费、快照和告警收敛在一个 Interface 后。
import { createHash } from "node:crypto";
import {
  queryReconciliationMetadata,
  queryNewApiStatus,
  queryKeyReconciliationStat,
  queryOwnChannelRevenue,
  queryOwnChannels,
  queryOwnLatestLog,
  queryAccountIdentity,
  unixSecondWindow,
} from "../lib/providers.js";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_CALCULATION_VERSION,
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
import { errorText, ownStationErrorCode } from "../lib/error-copy.js";
import { ReconciliationRepository, reconciliationOwnerRuleState, reconciliationOwnerScope, normalizeConfirmedHistoryOptions } from "./reconciliation-repository.js";
import { notifyReconciliationHealth } from "./reconciliation-notify.js";
import { reconciliationScopeFingerprint, reconciliationSnapshotRecordIdentity, reconciliationRuleEvidence } from "../lib/reconciliation-snapshot.js";
import { connectionDiagnostic } from "../lib/connection-test.js";
import { applyScopePolicy, billingProviderOf, canonicalBillingKey, completedBillingDayWindow, scopePolicyIssues, reconciliationBillingSchedule, isCompletedBillingWindow,
  isScopedBillingPolicy, reconciliationAccountingStart, startOfBillingDay, scopeRecalculatedInWindow } from "../lib/reconciliation-scope-policy.js";
import { ledgerEntryForSettlement, ledgerSettlement } from "../lib/reconciliation-ledger.js";
import { SETTLE_LOOKBACK_MS, isSettleableWindow, isSettledAt, reasonKindOf, settleRetryDelayMs, settlementOutcome, settlementPrecheck, settlementRecheck } from "../lib/reconciliation-settlement.js";
import { stationBusinessVersion } from "../db/store.js";
import { onboardingBaseUrl, normalizeCoverageDeclaration, ACCOUNT_TYPE_VALUES } from "../lib/channel-onboarding.js";
import { deriveKnownChannelCoverage, summarizeReconciliationWindowGroups, reconciliationResultActions, reconciliationDisplayStatus,
  summarizeUnaccountedUpstream, attributeAuthorizationRules, reconciliationDisplayCurrency, fixedOffProfitStations } from "../lib/reconciliation-view.js";
import { costBasisOf, isConfiguredRate, rateSnapshotOf, ratesFor } from "../lib/profit.js";
import { billDayOf, businessTimeZone, canonicalTimeZone, checkTimeZone, dayKeyInTz, dayStartInTz, isDayStartInTz, sameTimeZone, shiftedDayStartInTz } from "../lib/business-time.js";
import { selectCostUpstreams, stationUsageCost as defaultStationUsageCost } from "./own-helpers.js";
import { createBillingCapabilityStorage } from "../lib/billing-capability-storage.js";

export { reconciliationScopeFingerprint } from "../lib/reconciliation-snapshot.js";

const DAY_MS = 86400000;
// 回看几天：昨天往前到结束满 7 天为止（lib/reconciliation-settlement.js 的 SETTLE_LOOKBACK_MS）
const SETTLE_LOOKBACK_DAYS = Math.round(SETTLE_LOOKBACK_MS / DAY_MS);
const MAX_CONCURRENT_RULES = 6;

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

function health(code, detail = "") {
  return { code, label: reconciliationIssueLabel(code), detail, stale: code === "STALE" };
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

// 按 Key 整体取数的关联从核算起点开始计账。Sub2API 只能按天取数，起点所在的那天按全天算。
function accountingWindow(rule, window, platform = rule.provider) {
  const start = reconciliationAccountingStart(rule);
  if (start == null) return window;
  const clipStart = Math.max(window.startMs, platform === "sub2api" ? startOfBillingDay(start, window.timezone) : start);
  return clipStart < window.endMs ? { ...window, startMs: clipStart } : null;
}

function channelState(status) {
  if (Number(status) === 1) return "enabled";
  if (Number(status) === 2) return "manual_disabled";
  if (Number(status) === 3) return "auto_disabled";
  return "unknown";
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

function toErrorHealth(err, own = false) {
  const code = String(err?.code || "");
  const issue = own ? "OWN_BILLING_UNAVAILABLE" : code === "UPSTREAM_AUTH_DENIED" ? "KEY_INVALID_OR_DENIED"
    : code === "UPSTREAM_FEATURE_UNSUPPORTED" ? "UPSTREAM_FEATURE_UNSUPPORTED" : "UPSTREAM_DATA_UNAVAILABLE";
  return health(issue, issueText(issue));
}

// 轮询沿用了不久前的身份（这一轮没现读）时上游拒绝（New API），或者读账单时核对出账号换了（Sub2API）：
// 不能马上说「上游拒绝读取这把 Key」「上游这天的用量记录一直读不到」并推送。这一轮先当成还在读取，
// 上游已记进 staleMetadata，下一轮全部重读身份以后再定。连不上、超时这类不在此列，照常报
const REUSED_IDENTITY_SUSPECT = new Set(["UPSTREAM_AUTH_DENIED", "UPSTREAM_IDENTITY_CHANGED"]);
function upstreamErrorHealth(err, resource) {
  return REUSED_IDENTITY_SUSPECT.has(String(err?.code || "")) && resource?.identityReused ? health("PENDING", issueText("PENDING")) : toErrorHealth(err);
}

const CALCULATION_BLOCKERS = new Set([
  "UPSTREAM_FEATURE_UNSUPPORTED",
  "KEY_INVALID_OR_DENIED",
  "UPSTREAM_DATA_UNAVAILABLE",
  "OWN_BILLING_UNAVAILABLE",
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
//   lookbackBudget：每轮最多回看几天（昨天不占），缺省 max(1, ⌈在用绑定数 ÷ 2⌉）；
//   lookbackTimeMs：每轮回看最多花多久，缺省 min(20 秒, 刷新间隔的三分之一)，已经发出去的那一天照常做完；
//   lookbackDelayMs：启动后等多久才开始回看（今天、昨天照常），缺省随机 1–5 分钟，几个进程同时重启时不会一起打上游。
export function createReconciliationModule(rt, { repository = new ReconciliationRepository(rt.pool), stationUsageCost = defaultStationUsageCost,
  lookbackBudget = null, lookbackTimeMs = null, lookbackDelayMs = 60000 + Math.floor(Math.random() * 4 * 60000) } = {}) {
  const resultCache = (rt._reconciliationResultCache ||= new Map());
  const inflight = (rt._reconciliationInflight ||= new Map());
  const metadataCache = (rt._reconciliationMetadataCache ||= new Map());
  const identityCache = (rt._reconciliationIdentityCache ||= new Map());
  const ownChannelsCache = (rt._reconciliationOwnChannelsCache ||= new Map());
  const ownChannelsRequests = (rt._reconciliationOwnChannelsRequests ||= new Map());
  const ruleGenerations = (rt._reconciliationRuleGenerations ||= new Map());
  // 回看从什么时候起可以开始（启动后等一会儿）；上一次清理结账状态表的时刻
  const lookbackFrom = (rt._reconciliationLookbackFrom ??= Date.now() + lookbackDelayMs);
  // 修正过切换时间的规则：下一次结账昨天时重新取数，写一份新的结账记录。
  const resettles = (rt._reconciliationResettles ||= new Set());
  // 重结昨天没成时，下次什么时候再试（账本里已有这天，状态表不记；C2b 把重结请求挪进状态表以后删掉）
  const resettleRetryAt = (rt._reconciliationResettleRetryAt ||= new Map());
  // 轮询省请求和写入（计划 P1a）：
  //   ownActivity：每个自营站点上一轮查「全站有没有新的消费」的时刻，和从什么时候起一直没有新的消费（quietFrom）
  //   ownRevenueCache：今天每段窗口最近一次读全的渠道收费（读到哪一刻为止），全站没有新的消费时直接沿用
  //   observationWrites：每条绑定最近一次写下的「今天」观测快照的内容指纹和写入时刻
  const ownActivity = (rt._reconciliationOwnActivity ||= new Map());
  const ownRevenueCache = (rt._reconciliationOwnRevenue ||= new Map());
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
  async function settleDay(rule, window, { origin, ownerRegistry, state = null, resettle = false, trigger = null }) {
    const billDate = billDayOf(window);
    let result;
    try {
      result = await inspectRule(rule.id, window, { mode: "settle", origin, ownerRegistry, resettle: resettle || state?.resettleRequestedAt != null, trigger });
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
    const outcome = settlementOutcome({ window, result, now: Date.now(), state, origin, sourceVersion: ownerRegistry.billingSource.version });
    try {
      if (outcome.state?.op === "delete") { if (state) await repository.deleteSettlementState(rule.id, billDate); }
      else if (outcome.state) await repository.recordSettlementState(rule.id, billDate, outcome.state);
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

  async function hasCurrentScope(ruleId, scopeFingerprint, generation) {
    if ((ruleGenerations.get(ruleId) || 0) !== generation) return false;
    const [currentRule, segments] = await Promise.all([repository.getRule(ruleId), repository.listSegments(ruleId)]);
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

  // 页面「刷新」（观测）强制重读 Key 目录和账号身份；只读查询用 5 分钟缓存。
  // 轮询（poll）按时间重读：分组和 Key 目录 5 分钟、身份和 /api/status 30 分钟（自营站点的身份也是 30 分钟）；
  // 记在 staleMetadata 里的上游这一轮强制全部重读：出了异常的、这一轮要结账的（refreshDue 放进来），读成功才清掉记号。
  async function ownerRegistryFor(rules, selected, { observe = true, poll = false } = {}) {
    // expectedOwnerState 是全部绑定的指纹，只用来作结果缓存的版本；写快照时核对、加锁只看这条绑定同一把 Key 的那一组（ownerScopeFor）
    const billingSource = { ...billingSourceState(), expectedOwnerState: reconciliationOwnerRuleState(rules), ownerRules: rules };
    const selectedIds = new Set(selected.map((rule) => rule.id));
    const participants = rules.filter((rule) => rule.enabled || selectedIds.has(rule.id));
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
    return { rules: Object.freeze(participants.map((rule) => Object.freeze({ ...rule }))), resources, duplicateSales, billingSource: Object.freeze(billingSource),
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

  // 一段窗口的渠道收费。reuse 时（只有轮询观测今天）读全了就记下（读到哪一刻为止）；记下的那份读到的时刻
  // 不早于这个自营站点没有新消费的起点，就沿用它，窗口终点换成这次的——这段时间里没有新的消费日志，每个渠道的合计都不会变。
  // 沿用前照样读一次 /api/status（同一轮共用）：额度换算变了、或者读不到，就照旧逐个读，不拿旧的换算算钱。
  // 这一轮里「查过全站以后、轮到这条绑定之前」那几秒的新消费，下一轮查全站时会发现，再照旧逐个读。
  async function ownRevenue(own, rule, segmentWindow, { loadStatus, registry, reuse }) {
    const channelIds = rule.channels.map((channel) => channel.channelId);
    // 键里带凭据指纹，和 markQuietOwnStations 里「换了凭据就不算安静」互为备份：换了自营站点的凭据，任一道都能挡住沿用旧的
    const key = JSON.stringify([own.id, credentialFingerprint(own), [...channelIds].sort((a, b) => a - b), segmentWindow.startMs, segmentWindow.timezone]);
    const cached = ownRevenueCache.get(key), quiet = registry?.ownQuietFrom?.get(own.id);
    // 最新那条日志的时刻（站点的钟）也要在记下的那份里：站点时钟偏快时，记下那份读到的时刻还没包住它，照旧现读
    if (reuse && cached && quiet && cached.endMs >= quiet.from && cached.endMs <= segmentWindow.endMs
      && (quiet.coveredFromMs == null || quiet.coveredFromMs <= cached.endMs)) {
      const status = await loadStatus().catch(() => null);
      if (status && status.quotaPerUnit === cached.result.quotaPerUnit) return { ...cached.result, window: { ...cached.result.window, endMs: segmentWindow.endMs } };
    }
    const result = await queryOwnChannelRevenue(own, { channelIds, startMs: segmentWindow.startMs, endMs: segmentWindow.endMs, timezone: segmentWindow.timezone, loadStatus });
    // 只有轮询观测今天会沿用，别的窗口（昨天、结账、自定义、近 7 天、本月）不记
    if (reuse && result.state === "complete" && !result.emptySecondWindow) {
      ownRevenueCache.set(key, { endMs: segmentWindow.endMs, result });
      // 只留今天的：键里有窗口起点，过了零点的旧键不会再用到
      for (const [cachedKey, entry] of ownRevenueCache) if (entry.endMs < segmentWindow.endMs - 2 * DAY_MS) ownRevenueCache.delete(cachedKey);
    }
    return result;
  }

  function costOwnerFor(rule, canonicalKey, registry) {
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
    return await settledResult(rule, result.window) ?? result;
  }

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
  async function inspectRule(ruleId, window, { force = false, origin = "manual", ownerRegistry, mode = "observe", resettle = false, trigger = null, probe = false } = {}) {
    const settle = mode === "settle";
    const observe = mode !== "evaluate";
    if (settle) force = true;
    if (!ruleGenerations.has(ruleId)) ruleGenerations.set(ruleId, 0);
    const firstRule = await repository.getRule(ruleId);
    if (!firstRule) throw ruleNotFound();
    const cacheKey = resultKey(firstRule, window);
    const requestCredential = currentSourceCredential(firstRule);
    const requestBilling = ownerRegistry.billingSource;
    const evaluateKey = isLiveReconciliationPreset(window.preset) ? `${cacheKey}:${window.endMs}:${requestCredential}:${requestBilling.ownerVersion}` : `${cacheKey}:${requestCredential}:${requestBilling.ownerVersion}`;
    const inflightKey = observe ? `${evaluateKey}:${settle ? (probe ? "probe" : "settle") : "observe"}${resettle ? ":resettle" : ""}` : evaluateKey;
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
      const financialSnapshot = ratesFor({ own, upstream });
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
            ownChannelsFor(own, { force }).catch(() => null),
            mapWithConcurrency(applicable, 6, ({ window: segmentWindow }) => queryOwnChannelRevenue(own, {
              channelIds: rule.channels.map((channel) => channel.channelId), startMs: segmentWindow.startMs, endMs: segmentWindow.endMs, timezone: segmentWindow.timezone,
              loadStatus: () => ownStatusFor(ownerRegistry, own),
            }).catch(() => null)),
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
      let identityIssue = !ownSource || (upstreamChanged && !upstreamOptional) || (rule.ownSource && rule.ownSource.namespaceKey !== ownSource.namespaceKey)
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
      const costOwner = costOwnerFor(rule, canonicalKey, ownerRegistry);
      if (costOwner.state === "unknown") issues.push(upstreamSide({ code: "COST_OWNER_UNVERIFIED", scope: "rule", detail: issueText("COST_OWNER_UNVERIFIED"), ruleIds: costOwner.ruleIds, observedAt: Date.now() }));
      if (costOwner.state === "duplicate") issues.push(upstreamSide({ code: "CANONICAL_KEY_CONFLICT", scope: "rule", detail: issueText("CANONICAL_KEY_CONFLICT"), ruleIds: costOwner.ruleIds, observedAt: Date.now() }));
      if (!ownAvailable) issues.push({ code: "OWN_BILLING_UNAVAILABLE", scope: "downstream", detail: issueText("OWN_BILLING_UNAVAILABLE"), observedAt: Date.now() });
      if (upstreamProblem) issues.push(upstreamSide({ code: upstreamProblem.code, scope: "upstream", detail: upstreamProblem.detail, observedAt: Date.now() }));
      else if (!catalogueObserved && platform !== "sub2api") {
        issues.push(upstreamSide({
          code: "GROUP_DATA_UNAVAILABLE", scope: "upstream", observedAt: Date.now(),
          detail: `分组「${token.group}」的倍率暂时读不到`,
        }));
      }
      if (reconciliation.transitioned) {
        issues.push({ code: "ROUTE_TRANSITION_DETECTED", scope: "rule", detail: issueText("ROUTE_TRANSITION_DETECTED"), observedAt: Date.now() });
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
      const applicable = isScopedBillingPolicy(rule.billingPolicy) ? (clipped ? [{ segment: currentSegment, segmentWindow: clipped }] : []) : intersecting;
      // probe 到这里为止：取数前能判断的都判断完了，还挡着的要人处理的原因交回去，不读渠道、不取账单
      if (probe) return { probe: true, blocker: issues.find((issue) => CALCULATION_BLOCKERS.has(issue.code) && !issue.reference && reasonKindOf(issue.code) !== "retry")?.code ?? null };
      let catalogue = null;
      try { if (ownAvailable) catalogue = await ownChannelsFor(own, { force }); } catch {
        issues.push({ code: "SALES_CHANNEL_STATE_UNKNOWN", scope: "channels", detail: "渠道状态暂时读不到", observedAt: Date.now() });
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
      const segmentResults = await mapWithConcurrency(applicable, 6, async ({ segment, segmentWindow }) => {
        const [upstreamResult, downstreamResult] = await Promise.all([
          // 上游读不到（只有固定成本会走到这里）：不取上游，问题已经在上面记了一次
          upstreamProblem ? Promise.resolve({ error: upstreamProblem, skipped: true })
            : upstreamWindowFor(upstream, metadata, token, segmentWindow, { readOnly: !observe || settle }).catch((error) => ({ error })),
          (ownAvailable
            ? ownRevenue(own, rule, segmentWindow, { loadStatus: loadOwnStatus, registry: ownerRegistry, reuse: reuseOwnRevenue })
            : Promise.resolve({ error: codedError("OWN_BILLING_UNAVAILABLE", issueText("OWN_BILLING_UNAVAILABLE")) }))
            .catch((error) => ({ error })),
        ]);
        const segmentIssues = issues.filter((issue) => CALCULATION_BLOCKERS.has(issue.code));
        const sides = [upstreamResult, downstreamResult].filter((side) => !side.error);
        // 只有上游一侧的窗口或时区对不上时算上游侧问题；本站一侧对不上始终阻断。
        const downstreamSide = downstreamResult.error ? [] : [downstreamResult];
        const windowMismatch = (side) => !sameReconciliationWindow(side.window, segmentWindow, { timezone: false });
        if (sides.some(windowMismatch)) {
          const issue = { code: "BILLING_WINDOW_MISMATCH", scope: "segment", detail: issueText("BILLING_WINDOW_MISMATCH"), observedAt: Date.now() };
          segmentIssues.push(downstreamSide.some(windowMismatch) ? issue : upstreamSide(issue));
        }
        // 某一侧取数失败时由它自己的错误说明原因，不能再提示去核验时区或能力。
        if (sides.length === 2 && commonBillingTimezone(segmentWindow, sides).state !== "verified") {
          const issue = { code: "BILLING_TIMEZONE_UNVERIFIED", scope: "segment", detail: issueText("BILLING_TIMEZONE_UNVERIFIED"), observedAt: Date.now() };
          segmentIssues.push(commonBillingTimezone(segmentWindow, downstreamSide).state !== "verified" ? issue : upstreamSide(issue));
        }
        if (upstreamResult.error && !upstreamResult.skipped) {
          const billHealth = upstreamErrorHealth(upstreamResult.error, upstreamResource);
          segmentIssues.push(upstreamSide({ code: billHealth.code, scope: "segment", detail: billHealth.detail, observedAt: Date.now() }));
          // Key 账单报错：可能换了 Key 或身份变了，下一轮全部重读（P1b 的异常之一）
          staleMetadata.add(rule.upstreamStationId);
        }
        if (upstreamResult.emptySecondWindow || downstreamResult.emptySecondWindow) {
          const issue = { code: "PENDING", scope: "segment", detail: issueText("PENDING"), observedAt: Date.now() };
          segmentIssues.push(downstreamResult.emptySecondWindow ? issue : upstreamSide(issue));
        }
        if (downstreamResult.error || (downstreamResult.state !== "complete" && downstreamResult.state !== "pending")) {
          segmentIssues.push({ code: "OWN_BILLING_UNAVAILABLE", scope: "segment", detail: issueText("OWN_BILLING_UNAVAILABLE"), observedAt: Date.now() });
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
            window: upstreamResult.window || segmentWindow, requestedWindow: segmentWindow, billingTimezone: upstreamResult.billingTimezone,
          } : {
            state: "complete", quotaUnits: upstreamResult.quotaUnits, quotaPerUnit: upstreamResult.quotaPerUnit,
            amountUsd: upstreamUsd, knownAmountUsd: upstreamUsd, successfulCount: 1, expectedCount: 1,
            observedAt: upstreamResult.latestLogAtMs || Date.now(), window: upstreamResult.window || segmentWindow,
            requestedWindow: segmentWindow, billingTimezone: upstreamResult.billingTimezone,
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
      });
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
          accountedFromMs: clipped && clipped.startMs > window.startMs ? clipped.startMs : null, notEffective: !applicable.length && isScopedBillingPolicy(rule.billingPolicy) },
        amountBasis: { id: "channel-billing-usd-v3", currency: "USD", billingSource: RECONCILIATION_BILLING_SOURCE,
          calculationVersion: RECONCILIATION_CALCULATION_VERSION, conversion: platform === "sub2api" ? "provider_cost_usd" : "quota_per_unit" },
        // 固定采购的成本不取自上游账单，只要本站一侧证明了时区和日界线。
        billingTimezone: commonBillingTimezone(window, segmentResults.flatMap((segment) => costBasis === "fixed" ? [segment.downstream] : [segment.upstream, segment.downstream])),
        requestedWindow: window,
        lastSuccessfulWindow: null,
        currentSegment,
        segments: segmentResults,
        transitionSegments: segments,
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
      if (!await hasCurrentScope(rule.id, scopeFingerprint, generation)) return STALE_SCOPE;
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
        scopeFingerprint, billingFingerprint, sourceCredential, generation, billingSource, financialSnapshot, resettle, settle, trigger,
      })) ? (settle ? await bookedResult(rule, result) : result) : STALE_SCOPE;
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
        rule = await repository.getRule(ruleId);
        if (!rule) throw ruleNotFound();
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
    const currentRule = await repository.getRule(rule.id).catch(() => null);
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
    if (!save) return unavailable;
    return (await persistResult(rule, unavailable, origin, evidence.metadata, evidence.token, { scopeFingerprint, billingFingerprint, sourceCredential, generation, billingSource })) ? unavailable : STALE_SCOPE;
  }

  async function persistResult(rule, result, origin, metadata = null, token = null, { saveSnapshots = true, scopeFingerprint = null, billingFingerprint = null, sourceCredential = null, generation = 0, billingSource = null, financialSnapshot = null, resettle = false, settle = false, trigger = null } = {}) {
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
    // 账本明细里记下这次是怎么结的（计划 C2a 2.6）：poll 轮询结昨天、late 回看更早的日子、manual 手动重新读取、transition 改了切换时间的重结
    const settlement = { trigger: trigger || (resettle ? "transition" : origin === "manual" ? "manual" : "poll") };
    const ledgerEntry = ledgerDay ? ledgerEntryForSettlement(rule.id, result, { ...sourceFor({ ...wholeWindow, recordType: "confirmed" }), settlement }, {
      revenueRate: configuredRate(financialSnapshot.income), costRate: configuredRate(financialSnapshot.cost),
      costBasis: financialSnapshot.costBasis }) : null;
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
        expectedOwnerState: billingSource?.ownerRules ? reconciliationOwnerScope(billingSource.ownerRules, rule.tokenId) : null, guard, ledger: ledgerOption,
        // 这天结成了：同一个事务里删掉结账状态表那一行
        settlement: settled && ledgerDay ? { billDate: billDayOf(result.window) } : null });
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
      if (settled) result.settledAt = ledgerOption?.booked?.settledAt ?? result.generatedAt;
    }
    if (!await hasCurrentScope(rule.id, scopeFingerprint, generation)) return false;
    if (currentSourceCredential(rule) !== sourceCredential) return false;
    // 告警跟随今天的观测；结账已结束的自然日不动告警，否则昨天结账 READY 会清掉今天的告警，下一轮又重复推送。
    if (result.health.code !== "PENDING" && !isSettleableWindow(result.window, Date.now())) {
      try { await notifyReconciliationHealth(rt, repository, rule, result); } catch (err) {
        console.error("渠道对账通知失败:", err?.message || String(err));
      }
    }
    return true;
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
    const actions = [...new Map([...selected.flatMap((row) => row.actions), ...coverage.channels.flatMap((channel) => channel.actions)]
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
    for (const rule of rules) {
      for (let back = 1; back <= SETTLE_LOOKBACK_DAYS + 1; back += 1) {
        let window;
        try { window = completedDayWindow(rule, back, now); } catch { break; }
        const billDate = billDayOf(window), key = `${rule.id}|${billDate}`, state = stateOf.get(key) || null;
        const resettle = back === 1 && resettles.has(rule.id) && !(resettleRetryAt.get(rule.id) > now);
        const { action } = settlementPrecheck({ rule, window, now, state, resettle, ledgerHasDay: booked.has(key), sourceVersion });
        if (action === "settled" && state) repository.deleteSettlementState(rule.id, billDate).catch(() => {});
        // 要人处理、到了重判的时刻：不进 upstreams（不为它强制重读），settleDue 拿这一轮的目录和身份在本地重判
        if (action === "recheck") plan.recheck.push({ rule, window, state });
        if (action !== "due") continue;
        (back === 1 ? plan.yesterday : plan.older).push({ rule, window, state, resettle, requested: state?.resettleRequestedAt != null, trigger: back === 1 ? null : "late" });
      }
    }
    for (const { rule } of plan.yesterday) plan.upstreams.add(rule.upstreamStationId);
    if (Date.now() < lookbackFrom) plan.older = [];
    // 有重结请求的日子排在更早的日子前面；同样先结离今天近的
    plan.older.sort((a, b) => Number(b.requested) - Number(a.requested) || b.window.startMs - a.window.startMs);
    plan.budget = lookbackBudget ?? Math.max(1, Math.ceil(rules.length / 2));
    for (const { rule } of plan.older.slice(0, plan.budget)) plan.upstreams.add(rule.upstreamStationId);
    plan.older = plan.older.filter((item) => plan.upstreams.has(item.rule.upstreamStationId));
    return plan;
  }

  async function settleDue({ yesterday, older, recheck = [], budget }, ownerRegistry) {
    const sourceVersion = ownerRegistry.billingSource.version;
    await mapWithConcurrency(recheck, MAX_CONCURRENT_RULES, async ({ rule, window, state }) => {
      let probed;
      try { probed = await inspectRule(rule.id, window, { mode: "settle", probe: true, origin: "poll", ownerRegistry }); } catch (err) {
        if (err?.code !== "RULE_NOT_FOUND") console.error("重判结账状态失败:", err?.message || String(err));
        return;
      }
      if (!probed?.probe) return;
      const next = settlementRecheck({ window, state, blocker: probed.blocker, now: Date.now(), sourceVersion });
      try { await repository.recordSettlementState(rule.id, billDayOf(window), next); } catch (err) { console.error("记结账状态失败:", err?.message || String(err)); }
    });
    const settle = async ({ rule, window, state, resettle, trigger }) => {
      const result = await settleDay(rule, window, { origin: "poll", ownerRegistry, state, resettle, trigger }).catch(() => null);
      if (resettle) {
        if (result?.calculation?.profitUsd != null) { resettles.delete(rule.id); resettleRetryAt.delete(rule.id); }
        else resettleRetryAt.set(rule.id, Date.now() + settleRetryDelayMs(1, { window, now: Date.now() }));
      }
      return result;
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
        if (result?.calculation?.profitUsd == null) skipped.add(item.rule.upstreamStationId);
      }
    }));
  }

  // 每小时清一批结账状态表：31 天前的、没有重结请求的行（挂在轮询里，不另起定时器）
  async function pruneSettlementStates(now) {
    if (now - (rt._reconciliationLastPrune || 0) < 3600000) return;
    rt._reconciliationLastPrune = now;
    try { await repository.pruneSettlementStates(dayKeyInTz(now - 31 * DAY_MS, "UTC")); } catch { /* 下一小时再清 */ }
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
        const segments = await withObservationSourceLock(rule, currentSourceCredential(rule), async () => {
          const corrected = await repository.correctTransition(ruleId, segmentId, effectiveAt);
          clearBillingResults(ruleId);
          // 分段变了，已结账的昨天要按新分段重新结账（C2b 改成按天存进状态表的重结请求）
          resettles.add(ruleId);
          return corrected;
        }, billingSource);
        if (segments === STALE_SCOPE) throw staleScope();
        return segments;
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
          const response = readResponse(knownRules, rules, rows, ownerRegistry, input, now);
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
              .then((states) => settleDay(rule, window, { origin: "manual", ownerRegistry,
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
      const plan = await planSettlement(rules, now);
      for (const id of plan.upstreams) staleMetadata.add(id);
      const ownerRegistry = await ownerRegistryFor(allRules, rules, { observe: true, poll: true });
      await markQuietOwnStations(rules, ownerRegistry);
      await mapWithConcurrency(rules, MAX_CONCURRENT_RULES, async (rule) => {
        // 规则排队轮到时才定今天的截止点：实时窗口截至取数时刻，不能用整轮开始时的旧时刻。
        const at = now + Math.max(0, Date.now() - startedAt);
        await inspectRule(rule.id, resolveReconciliationWindow({ preset: "today", timezone: rule.timezone }, at), { mode: "observe", origin: "poll", ownerRegistry })
          .catch(() => null);
      });
      await settleDue(plan, ownerRegistry);
      await pruneSettlementStates(now);
    },
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
