import { RECONCILIATION_CALCULATION_VERSION, fillIssueCopy, isScopedBillingPolicy, reconciliationAccountingStart, isLiveReconciliationPreset, reconciliationIssue,
  sameReconciliationWindow, coverageNeedsAnswer, resettleShrunkWhat, reconciliationChannelStatus } from "./reconciliation-contract.js";
import { onboardingBaseUrl } from "./channel-onboarding.js";
import { billDayOf, dayKeyInTz, isDayStartInTz } from "./business-time.js";
import { SETTLE_LOOKBACK_MS } from "./reconciliation-settlement.js";
import { isConfiguredRate } from "./profit.js";
import { MINUS, formatAsOf, formatUsd, formatZonedDate, formatZonedDateTime, formatZonedTime } from "./format.js";
import { workflowAction } from "./workflow-actions.js";
import { accessTokenScopeText, isAccessTokenError } from "./access-token-scopes.js";

export function formatReconciliationMoney(amount, rate) {
  if (amount == null) return "—";
  const raw = Number(amount);
  const cnyRate = Number(rate);
  const useCny = Number.isFinite(cnyRate) && cnyRate > 0;
  const value = raw * (useCny ? cnyRate : 1);
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const prefix = `${value < 0 ? MINUS : ""}${useCny ? "¥" : "$"}`;
  // 小到 8 位小数也显示成 0 的金额：照写有效数字，不显示成零，也不用科学计数法
  if (absolute > 0 && absolute < 0.000000005) return `${prefix}${absolute.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
  return `${prefix}${absolute.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: absolute > 0 && absolute < 0.005 ? 8 : 2,
  })}`;
}

// 按币种显示已经折算好的金额：人民币直接显示，美元原样显示。
export function formatReconciliationAmount(amount, currency) {
  return formatReconciliationMoney(amount, currency === "CNY" ? 1 : null);
}

// 金额默认按系统原值（USD）显示；本站和按用量计成本的上游都设置了汇率时，这条关联才能按人民币显示：
// 收入按本站汇率、成本按该上游自己的汇率折算，和「我的站点」一致。
export function reconciliationRowCurrency(rates) {
  return isConfiguredRate(rates?.income) && (rates.costBasis === "fixed" || isConfiguredRate(rates?.cost)) ? "CNY" : "USD";
}

// 一页只用一种币种：每条关联都能按人民币显示才用人民币，否则全部按 USD，免得同一列混着两种币种。
export function reconciliationDisplayCurrency(rows = []) {
  return rows.length && rows.every((row) => reconciliationRowCurrency(row?.rates) === "CNY") ? "CNY" : "USD";
}

// 收入、成本各自乘的系数。固定采购的上游用量不计成本（采购费作为固定成本摊销），成本系数为 0，与币种无关。
// 要求人民币但这条关联缺汇率时返回 null。
export function reconciliationRateFactors(rates, currency = "USD") {
  const fixedCost = rates?.costBasis === "fixed";
  if (currency !== "CNY") return { currency: "USD", income: 1, cost: fixedCost ? 0 : 1, fixedCost };
  if (reconciliationRowCurrency(rates) !== "CNY") return null;
  return { currency: "CNY", income: Number(rates.income.cnyPerUsd), cost: fixedCost ? 0 : Number(rates.cost.cnyPerUsd), fixedCost };
}

// 收入或上游成本一格的写法（§3.6、§5.5）：读全了只写金额；读到一部分写「$1.20（没读全）」；
// 一点没读到写「读取中」或「读不到」；旧数据写「这天的数据不完整」。rate 是人民币汇率，按美元显示时为 null。
const BILLING_MISSING_TEXT = { partial: "没读全", pending: "读取中", unavailable: "读不到" };

export function reconciliationBillingText(billing, rate = null) {
  if (!["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return reconciliationIssue("STALE").title;
  const value = billing.state === "complete" ? billing.amountUsd : billing.knownAmountUsd ?? billing.amountUsd;
  const known = value != null && Number.isFinite(Number(value));
  if (billing.state === "complete") return known ? formatReconciliationMoney(value, rate) : "—";
  return known ? `${formatReconciliationMoney(value, rate)}（没读全）` : BILLING_MISSING_TEXT[billing.state];
}

// *Usd / marginRate 是账单原币（USD）原始口径；profit / riskDifference / margin 是页面显示口径：
// 按 currency 折算（缺汇率时退回 USD），固定采购上游的成本记为 0，两侧分别折算后相减。
export function reconciliationCalculationValues(calculation, health, item = null, currency = "USD") {
  const confirmed = calculation?.profitUsd != null && hasTrustworthyProfit(item);
  const profitUsd = confirmed ? calculation?.profitUsd : null;
  const riskDifferenceUsd = confirmed ? null : calculation?.riskDifferenceUsd ?? null;
  const marginRate = confirmed ? calculation?.marginRate ?? null : null;
  const usd = { confirmed, profitUsd, riskDifferenceUsd, marginRate };
  const factors = reconciliationRateFactors(item?.rates, currency) || reconciliationRateFactors(item?.rates);
  // 固定采购的成本不取自上游账单：上游金额取不到时也按 0 计。
  const income = finiteMoney(item?.downstream?.amountUsd), cost = factors.fixedCost ? 0 : finiteMoney(item?.upstream?.amountUsd);
  const identity = factors.income === 1 && factors.cost === 1;
  // 缺两侧金额（旧快照）时没法分别折算，按原始 USD 口径显示。
  if (identity || income == null || cost == null) {
    return { ...usd, currency: identity ? factors.currency : "USD", profit: profitUsd, riskDifference: riskDifferenceUsd, margin: marginRate };
  }
  const difference = income * factors.income - cost * factors.cost;
  return { ...usd, currency: factors.currency,
    profit: profitUsd == null ? null : difference,
    riskDifference: riskDifferenceUsd == null ? null : difference,
    margin: profitUsd == null || !(income > 0) ? null : difference / (income * factors.income) };
}

function finiteMoney(value) {
  const amount = Number(value);
  return value != null && Number.isFinite(amount) ? amount : null;
}

function billingState(billing) {
  if (["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return billing.state;
  return "unavailable";
}

// 上游回填的账单窗口时区是规范写法，请求的窗口用绑定上存的写法：别名算同一个
const windowsMatch = (a, b) => sameReconciliationWindow(a, b, { timezone: "canonical" });

function hasCurrentCalculationVersion(item) {
  return Number(item?.calculationVersion ?? item?.downstream?.calculationVersion) === RECONCILIATION_CALCULATION_VERSION;
}

function hasCurrentBillingSide(item, billing) {
  if (item?.health?.stale || !hasCurrentCalculationVersion(item)) return false;
  const window = item?.requestedWindow ?? item?.window;
  return !!billing?.window && (!window || windowsMatch(window, billing.window));
}

function hasCurrentBillingPair(item) {
  return hasCurrentBillingSide(item, item?.downstream)
    && hasCurrentBillingSide(item, item?.upstream)
    && windowsMatch(item?.downstream?.window, item?.upstream?.window);
}

// 固定采购的上游用量不计成本：毛利只看本站一侧，上游账单和成本归属的问题由服务端标为 reference，只作参考。
function hasFixedCost(item) {
  return item?.rates?.costBasis === "fixed";
}

function blockingIssues(item) {
  return (item?.health?.issues || []).filter((issue) => !issue?.reference);
}

// 毛利由服务端判定；历史快照里可能有旧版 DTO，视图再挡一次服务端同样会拦下的情况。不看窗口是否结束：今天也给实时毛利。
function hasTrustworthyProfit(item) {
  const fixed = hasFixedCost(item);
  return (fixed ? hasCurrentBillingSide(item, item?.downstream) : hasCurrentBillingPair(item))
    && (!item?.billingTimezone || item.billingTimezone.state === "verified")
    && !blockingIssues(item).some((issue) => ["DUPLICATE_CHANNEL_ASSIGNMENT", "BILLING_WINDOW_MISMATCH", "BILLING_TIMEZONE_UNVERIFIED"].includes(issue.code))
    && billingState(item?.downstream) === "complete"
    && finiteMoney(item?.downstream?.amountUsd) != null
    && (fixed || ((!item?.upstream?.ownershipState || item.upstream.ownershipState === "unique")
      && billingState(item?.upstream) === "complete"
      && finiteMoney(item?.upstream?.amountUsd) != null));
}

// 读取类的问题：系统会自己重读，过了这么久还没读到才变成需处理（design/ui-copy-spec.md §4）。
// 和自动结账回看的天数是同一个数，只在 lib/reconciliation-settlement.js 定义一次（计划 C2a）
export const RECONCILIATION_READING_GRACE_MS = SETTLE_LOOKBACK_MS;

// 这条绑定这天的所有问题：去重后按优先级排，每条带上界面文案（§5）和服务端给的原始问题。
// 服务端每条结果都带 health.code（没问题时是 READY）；旧数据或坏数据没有时按认不出的码处理（§5.5），不显示成实时。
function displayIssues(item) {
  const issues = new Map();
  // health 本身带着上游名、少了哪项权限（令牌作废、少了权限时 toErrorHealth 给的）：没有 issues 列表的结果（读不到上游时）也要能写出是哪一侧
  const { side, stationName, missingScope, sinceMs, channelId, upstreamStationId, variant, accountName, accountId, channelCount, channelNames } = item?.health || {};
  for (const source of [...blockingIssues(item), ...(item?.health?.code ? [{ code: item.health.code, ...(side ? { side } : {}), ...(stationName != null ? { stationName } : {}), ...(missingScope ? { missingScope } : {}), ...(sinceMs != null ? { sinceMs } : {}), ...(channelId != null ? { channelId } : {}), ...(upstreamStationId != null ? { upstreamStationId } : {}),
    ...(variant ? { variant } : {}), ...(accountName != null ? { accountName } : {}), ...(accountId != null ? { accountId } : {}), ...(channelCount != null ? { channelCount } : {}), ...(channelNames ? { channelNames } : {}) }] : [])]) {
    // 账号对不上、上游删了：事项上带 side / variant，按哪一侧、哪种情况说（lib/reconciliation-contract.js 的 variants）
    if (source?.code && !issues.has(source.code)) issues.set(source.code, { ...reconciliationIssue(source.code, source.variant ?? source.side), source });
  }
  // 固定成本的上游换了账号：服务端标成 reference（不挡、不进需处理），那几天上写一句提示
  if ((item?.health?.issues || []).some((issue) => issue?.reference && issue.code === "SOURCE_BINDING_UNCONFIRMED" && issue.side === "upstream")) {
    issues.set("SOURCE_BINDING_UNCONFIRMED:fixed", { ...reconciliationIssue("SOURCE_BINDING_UNCONFIRMED", "fixedUpstream"), source: { code: "SOURCE_BINDING_UNCONFIRMED" } });
  }
  if (!item?.health?.code && !issues.size) issues.set("", { ...reconciliationIssue(""), source: {} });
  return [...issues.values()].sort((a, b) => a.priority - b.priority);
}


// 文案里的 {channel} {start} {time}：渠道名、开始统计的时刻、这天倍率变化的时刻。
function issueParams(item, issue, timezone, now) {
  const params = {};
  const channelId = issue.source?.channelId;
  if (channelId != null) {
    const channel = mergeReconciliationChannels(item?.rule?.channels, item?.downstream?.channels)
      .find((entry) => Number(entry?.channelId ?? entry?.id) === Number(channelId));
    if (channel?.name) params.channel = channel.name;
  }
  // 令牌作废、少了权限（§5.2）：说是自营站点还是哪个上游、新令牌要勾哪些权限、New API 说少了哪一项
  if (isAccessTokenError(issue.code)) {
    const source = issue.source || issue, side = source.side === "upstream" ? "upstream" : "own";
    params.subject = side === "upstream" ? (source.stationName ? `上游「${source.stationName}」` : "") : "自营站点";
    params.side = side; // issueAction 用：自营站点的令牌坏了，「更新登录信息」要去自营站点，不是上游
    params.scopes = accessTokenScopeText(side);
    if (source.missingScope) params.scope = source.missingScope;
    params.lost = source.missingScope ? `「${source.missingScope}」的权限` : "权限";
  }
  const start = reconciliationAccountingStartText(item?.rule, timezone, now);
  if (start) params.start = start;
  const change = reconciliationRatioChange(item, timezone, now);
  if (change) params.time = change.time;
  // K2b：读不到渠道 Key（例外三）、换了 Key 系统还没重新分组：「从 {time} 起……」，时刻是服务端带来的 sinceMs（最后一次读到、第一次认出冲突）；
  // 和这天的窗口同一天只写钟点，不同天带日期（和倍率变化的 time 一个写法）
  const sinceMs = Number(issue.source?.sinceMs);
  if (Number.isFinite(sinceMs) && Number.isFinite(item?.window?.startMs) && timezone) {
    params.time = dayKeyInTz(sinceMs, timezone) === dayKeyInTz(item.window.startMs, timezone) ? formatZonedTime(sinceMs, timezone) : formatZonedDateTime(sinceMs, timezone, now);
  }
  if (issue.source?.upstreamStationId != null) params.upstreamStationId = issue.source.upstreamStationId; // KEY_REVEAL_DENIED：缺权限的上游（tokenStationOf 用）
  // 账号对不上（§5.2）：哪一侧、上游名、读到的账号名（拿不到写「账号 #1024」）、这个上游下几个渠道
  if (issue.code === "SOURCE_BINDING_UNCONFIRMED" && issue.source?.side) {
    const source = issue.source;
    params.side = source.side;
    if (source.side === "upstream") {
      if (source.stationName) params.upstream = source.stationName;
      const account = source.accountName || (source.accountId ? `账号 #${source.accountId}` : "");
      if (account) params.account = account;
      if (Number.isFinite(Number(source.channelCount)) && Number(source.channelCount) > 0) params.count = Number(source.channelCount);
    }
  }
  // 上游删了（§5.2）：算利润用的上游已经删了的渠道名（两个以内全写，三个以上写第一个加「等 N 个渠道」）
  if (issue.code === "COST_OWNER_UNVERIFIED" && issue.source?.variant === "deleted") {
    params.variant = "deleted";
    const names = (issue.source.channelNames || []).filter(Boolean);
    if (names.length) params.channels = names.length <= 2 ? names.map((name) => `「${name}」`).join("") : `「${names[0]}」等 ${names.length} 个渠道`;
  }
  if (issue.code === "KEY_CHANGED") params.keyChange = reconciliationKeyChange(item, timezone, now) || "";
  // 「这天重算的数比原来少了一半多」的说明里，少的是收入还是上游成本（状态行记的 shrunk.side）
  if (issue.code === "RESETTLE_SHRUNK") params.what = resettleShrunkWhat(issue.source?.shrunk?.side);
  return params;
}

// 确认以后再读到的数和确认框里写的不一样：不固定，提示这一句（warning，用语规范 §5.2）
export const RESETTLE_SHRUNK_CHANGED = "重算的数又变了，先没换掉。再点「重新读取」看看新的数。";

// 「这天重算的数比原来少了一半多」点「重新读取」先弹的确认框（design/ui-copy-spec.md §5.3）：这一下会把已固定的钱换掉，
// 要让人看见换成多少。数是挡下来那一刻存的（status.shrunk），没变的那一项也写；固定成本的绑定上游成本没有数，不写那一行。
// 不是这种日子（没有 shrunk）返回 null，页面照常直接读。
export function resettleShrunkConfirm(item, { now = Date.now() } = {}) {
  const shrunk = (item?.displayStatus || (item ? reconciliationDisplayStatus(item, { now }) : null))?.shrunk;
  if (!shrunk) return null;
  const date = formatZonedDate(item?.window?.startMs, item?.window?.timezone, now);
  const hasCost = shrunk.before?.costUsd != null || shrunk.after?.costUsd != null;
  return { title: `按重算的数固定 ${date}？`,
    lines: [`收入：原来 ${formatUsd(shrunk.before?.revenueUsd)}，重算 ${formatUsd(shrunk.after?.revenueUsd)}`,
      ...(hasCost ? [`上游成本：原来 ${formatUsd(shrunk.before?.costUsd)}，重算 ${formatUsd(shrunk.after?.costUsd)}`] : [])],
    hint: "会再读一次记录，按读到的数固定；原来的数不再留着。", okText: "重新读取", cancelText: "取消", after: shrunk.after };
}

// 开始统计的时刻（§9）：0:00 开始的只写日期「10月9日」，否则「10月9日 14:30」。提示和计算明细共用。
export function reconciliationAccountingStartText(rule, timezone, now = Date.now()) {
  const start = reconciliationAccountingStart(rule);
  return start == null ? "" : accountingStartTextAt(start, timezone, now);
}
// 某一时刻写成「开始统计」的样子：0 点只写日期，否则写到分钟（C3 以前固定的绑上那天记的是 14:30，照当时记的写）
export function accountingStartTextAt(ms, timezone, now = Date.now()) {
  return isDayStartInTz(ms, timezone) ? formatZonedDate(ms, timezone, now) : formatZonedDateTime(ms, timezone, now);
}

// 所选日期里最后一次倍率变化：time 同一天只写「14:30」，跨天写「10月9日 14:30」；from、to 是前后倍率，读不到为 null。
// 提示「倍率在 14:30 变了」和计算明细的上游成本一行共用。
export function reconciliationRatioChange(item, timezone = item?.window?.timezone, now = Date.now()) {
  const window = item?.window;
  if (!Number.isFinite(window?.startMs) || !Number.isFinite(window?.endMs)) return null;
  const segments = mergeReconciliationSegments(item?.transitionSegments, item?.segments)
    .filter((segment) => Number.isFinite(Number(segment?.effectiveFrom)))
    .sort((a, b) => Number(a.effectiveFrom) - Number(b.effectiveFrom));
  // 换 Key 开的段（K2b）不是倍率变化：这一刻不算在「倍率在 14:30 变了」里（换 Key 那天另有一句，见 reconciliationKeyChange）
  const index = segments.findLastIndex((segment) => !isKeyChangeSegment(segment) && Number(segment.effectiveFrom) > window.startMs && Number(segment.effectiveFrom) < window.endMs);
  if (index < 0) return null;
  const at = Number(segments[index].effectiveFrom);
  const time = dayKeyInTz(at, timezone) === dayKeyInTz(window.startMs, timezone) ? formatZonedTime(at, timezone) : formatZonedDateTime(at, timezone, now);
  return { at, time, from: index > 0 ? segments[index - 1].ratio ?? null : null, to: segments[index].ratio ?? null };
}

// K2b 换 Key 开的段：timing_source 是 key_change（新段，或精确切点、挪过）和 key_change_window（[a, b) 过渡段，两把 Key 都算）
const isKeyChangeSegment = (segment) => segment?.timingSource === "key_change" || segment?.timingSource === "key_change_window";
const KEY_CHANGE_EXACT_GAP_MS = 2 * 60 * 1000; // a 到 b 不超过两次轮询：写「b 起」；更长写「a–b 之间换了 Key」（流程梳理稿第 3 节）
const ratioText = (ratio) => Number.isInteger(Number(ratio)) ? Number(ratio).toFixed(1) : String(Number(ratio));

// 所选日期里最后一次换 Key 的一句话（design/ui-copy-spec.md §5.4「换了 Key 的那天」）：今天写「今天 14:30 换了 Key」，过去的日子写「14:30 换了 Key」；
// 新 Key 的倍率和旧的不一样，合成一句「14:30 换了 Key（倍率从 1.0 变成 1.2）」；换的时刻定不出（过渡段超过两次轮询）写「15:19–16:05 之间换了 Key，按 16:05 切开」。
// 没有换 Key 返回 null。
export function reconciliationKeyChange(item, timezone = item?.window?.timezone, now = Date.now()) {
  const window = item?.window;
  if (!Number.isFinite(window?.startMs) || !Number.isFinite(window?.endMs)) return null;
  const segments = mergeReconciliationSegments(item?.transitionSegments, item?.segments)
    .filter((segment) => Number.isFinite(Number(segment?.effectiveFrom)))
    .sort((a, b) => Number(a.effectiveFrom) - Number(b.effectiveFrom));
  const index = segments.findLastIndex((segment) => segment.timingSource === "key_change" && Number(segment.effectiveFrom) >= window.startMs && Number(segment.effectiveFrom) < window.endMs);
  if (index < 0) return null;
  const clock = (at) => dayKeyInTz(at, timezone) === dayKeyInTz(window.startMs, timezone) ? formatZonedTime(at, timezone) : formatZonedDateTime(at, timezone, now);
  const b = Number(segments[index].effectiveFrom);
  const window_ = index > 0 && segments[index - 1].timingSource === "key_change_window" ? segments[index - 1] : null;
  const before = window_ ?? segments[index - 1], from = before?.ratio ?? null, to = segments[index].ratio ?? null;
  const ratioNote = from != null && to != null && Number(from) !== Number(to) ? `（倍率从 ${ratioText(from)} 变成 ${ratioText(to)}）` : "";
  if (window_ && b - Number(window_.effectiveFrom) > KEY_CHANGE_EXACT_GAP_MS) return `${clock(Number(window_.effectiveFrom))}–${clock(b)} 之间换了 Key，按 ${clock(b)} 切开${ratioNote}`;
  // 「今天」：取数时刻和这一天在同一个业务日。实时的今天窗口 endMs 就是取数时刻（≤ now），不能用 now < window.endMs
  const today = Number.isFinite(now) && now >= window.startMs && dayKeyInTz(now, timezone) === dayKeyInTz(window.startMs, timezone);
  return `${today ? "今天 " : ""}${clock(b)} 换了 Key${ratioNote}`;
}

// 令牌作废、少了权限在自营站点一侧时，按钮要去自营站点（stationId 填自营站点），不是这条绑定的上游（审核 #107 中-2）
// 读取服务连不上（KEY_READER_UNREACHABLE / KEY_AGENT_UNAVAILABLE）：「检查连接」去自营站点的抽屉（读取服务令牌那一栏），不是这条绑定的上游；
// 上游的令牌少了读完整 Key 的权限（KEY_REVEAL_DENIED）：去缺权限的那个上游（打码撞了时可能不是绑定自己的上游），服务端带了就用它
const tokenStationOf = (code, params, upstreamId, ownId) => (isAccessTokenError(code) && params?.side === "own" || code === "SOURCE_BINDING_UNCONFIRMED" && params?.side === "own" || code === "KEY_READER_UNREACHABLE" || code === "KEY_AGENT_UNAVAILABLE" ? ownId
  : code === "KEY_REVEAL_DENIED" && params?.upstreamStationId ? params.upstreamStationId : upstreamId) ?? null;

function issueAction(item, kind, code, params) {
  const rule = item?.rule || {};
  return workflowAction(kind, { stationId: tokenStationOf(code, params, rule.upstreamStationId, rule.ownStationId), ruleId: rule.id ?? null, ownStationId: rule.ownStationId ?? null,
    channelIds: (rule.channels || []).map((channel) => channel.channelId), window: item?.requestedWindow || item?.window || null }, { code, params });
}

// 这条绑定这天在界面上的状态（§4）：只有 需处理 / 已固定 / 实时 三种，需处理优先。
//   action   需处理：title 一句原因、detail 说明、action 唯一的按钮，moreCount 是还有几个问题；码不认识时带上 code，只写进控制台。
//   settled  已固定：note 是悬停时的「10月10日 0:05 固定」，revised 表示固定之后又改过。
//   live     实时：asOf「数据截至 14:30」；过去的日子还没固定时 note 是「还在读取」。
// hints 是不改变状态的提示（§5.4），可能带一个按钮。读取类的问题过了 7 天还没读到才算需处理。
// 服务端算一次放进 displayStatus，页面直接用；timezone 是这天按哪个时区算。
// 整天在开始统计之前的日子（C②）：这条绑定在这一天不算状态，不算进汇总、也不算需处理。服务端算得出的（scope.notEffective）直接用，
// 旧数据没有这个标记时按开始统计的时刻和这天的终点比（只有按整体取数的绑定有开始统计的时刻，旧版规则不判）
export function reconciliationNotStarted(item) {
  if (item?.scope?.notEffective === true) return true;
  const end = item?.window?.endMs;
  if (!Number.isFinite(end) || !item?.rule) return false;
  const start = reconciliationAccountingStart(item.rule);
  return Number.isFinite(start) && start >= end;
}

export function reconciliationDisplayStatus(item, { now = Date.now(), timezone = item?.window?.timezone } = {}) {
  const window = item?.window || null;
  if (reconciliationNotStarted(item)) {
    const start = reconciliationAccountingStartText(item?.rule, timezone, now);
    return { state: "not_started", label: reconciliationChannelStatus("not_effective").label, note: start ? `从 ${start} 开始统计` : "", hints: [], actions: [] };
  }
  const ended = Number.isFinite(window?.endMs) && window.endMs <= now;
  // 不知道是哪一天时算不出过了几天，读取类问题直接按需处理，免得一直显示成实时
  const late = !Number.isFinite(window?.endMs) || window.endMs <= now - RECONCILIATION_READING_GRACE_MS;
  const issues = displayIssues(item);
  // 要人动手的排在前面，过了 7 天还没读到的读取类排在后面（§4）。
  const problems = [...issues.filter((issue) => issue.kind === "action"), ...(late ? issues.filter((issue) => issue.kind === "reading") : [])];
  const reading = issues.find((issue) => issue.kind === "reading");
  const hints = [...(reading && !late ? [reading] : []), ...issues.filter((issue) => issue.kind === "hint" && issue.display !== false && issue.hint)]
    .map((issue) => {
      const params = issueParams(item, issue, timezone, now);
      const text = fillIssueCopy(issue.hint, issue.plain, params);
      return text ? { code: issue.code, text, action: issue.kind === "hint" && issue.action ? issueAction(item, issue.action, issue.code, params) : null } : null;
    }).filter(Boolean);
  if (problems.length) {
    const [issue] = problems, params = issueParams(item, issue, timezone, now);
    const action = issueAction(item, issue.action, issue.code, params);
    return { state: "action", label: "需处理", title: action.title, detail: action.detail, moreCount: problems.length - 1, action, hints,
      // 这天重算的数比原来少了一半多、没换掉：原来和重算的收入、上游成本各多少，「重新读取」的确认框直接读（C3）
      ...(issue.code === "RESETTLE_SHRUNK" && issue.source?.shrunk ? { shrunk: issue.source.shrunk } : {}),
      // 同一个按钮对应几个问题时，标题取最靠前的那个问题
      actions: problems.reduce((list, entry) => {
        const value = entry === issue ? action : issueAction(item, entry.action, entry.code, issueParams(item, entry, timezone, now));
        return list.some((added) => added.id === value.id) ? list : [...list, value];
      }, []),
      ...(issue.known ? {} : { code: issue.code }) };
  }
  if (item?.settledAt) {
    return { state: "settled", label: "已固定", settledAt: item.settledAt, note: `${formatZonedDateTime(item.settledAt, timezone, now)} 固定`,
      revised: Number(item?.ledger?.revision) > 1, hints, actions: [] };
  }
  return { state: "live", label: "实时", asOf: item?.generatedAt ? formatAsOf(item.generatedAt, timezone, now) : "",
    // 过完了（不等等待期，还在读取）、恰好一整天（billDayOf，和账本同一个判断）才写「还在读取」
    note: ended && billDayOf(window) ? "还在读取" : "", hints, actions: [] };
}

// 这条绑定要处理的事项：需处理的每个问题一个，运营总览「需要处理」也从这里取。
export function reconciliationResultActions(item, { now = Date.now(), displayStatus = reconciliationDisplayStatus(item, { now }) } = {}) {
  return displayStatus.actions;
}

const COVERAGE_CODES = ["COST_COVERAGE_UNKNOWN", "BILLING_TIMEZONE_UNVERIFIED", "CANONICAL_KEY_CONFLICT", "COST_OWNER_UNVERIFIED"];
// 定渠道状态的码（下面 status 那一串按它们判）
const CHANNEL_STATUS_CODES = new Set(["DUPLICATE_CHANNEL_ASSIGNMENT", "SOURCE_BINDING_UNCONFIRMED", "BILLING_SCOPE_NOT_EFFECTIVE", "BILLING_MISSING", ...COVERAGE_CODES]);
// 渠道自己能说出需处理原因的码（重复、来源、Key 用途、时区、归属）；还没开始统计的不算需处理
const ATTENTION_CHANNEL_CODES = new Set(["DUPLICATE_CHANNEL_ASSIGNMENT", "SOURCE_BINDING_UNCONFIRMED", "BILLING_SCOPE_NOT_EFFECTIVE", ...COVERAGE_CODES]);

export function deriveKnownChannelCoverage(catalogue, rules, results, { window = null } = {}) {
  const source = catalogue?.ownSource || null, entries = new Map();
  const current = !!source?.namespaceKey && !catalogue?.stale && catalogue?.totalValidated === true && Number.isInteger(catalogue.catalogueTotal);
  const add = (ownSource, ownStationId, channel, rule = null) => {
    const key = `${ownSource?.namespaceKey || `unknown:${ownStationId}:${rule?.id || "catalogue"}`}:${channel.channelId ?? channel.id}`;
    const previous = entries.get(key), id = Number(channel.channelId ?? channel.id);
    const entry = previous || { ownSource, ownStationId, channelId: id, name: reconciliationChannelName({ ...channel, channelId: id }),
      operatingState: channelOperatingState(channel), rules: [] };
    if (rule) entry.rules.push(rule);
    entries.set(key, entry);
  };
  for (const channel of catalogue?.channels || []) add(source, source?.stationId || "", channel);
  for (const rule of rules) for (const channel of rule.channels || []) add(rule.ownSource || null, rule.ownStationId, channel, rule);
  let missingQueryEvidence = false;
  const channels = [...entries.values()].map((entry) => {
    const active = entry.rules.filter((rule) => rule.enabled && !rule.archivedAt);
    const issues = [], kinds = new Map(), params = { channel: entry.name };
    const need = (code, kind = null) => { issues.push(code); if (kind && !kinds.has(kind)) kinds.set(kind, code); };
    if (active.length > 1) need("DUPLICATE_CHANNEL_ASSIGNMENT", "review_conflict");
    if (!current || !entry.ownSource || entry.ownSource.namespaceKey !== source?.namespaceKey) need("SOURCE_BINDING_UNCONFIRMED", "review_source");
    if (!active.length) { issues.push("CHANNEL_UNLINKED"); kinds.set("connect_channels", null); }
    const rule = active[0], result = rule && results.find((item) => item.rule.id === rule.id && (!window || sameReconciliationWindow(item.window, window, { asRequested: true, timezone: false })));
    if (rule) {
      const range = window || result?.window;
      const accountingStart = isScopedBillingPolicy(rule.billingPolicy) ? reconciliationAccountingStart(rule) : null;
      // 还没到开始统计的时刻：只是提示（§5.4），不用处理。
      if (range && accountingStart != null && range.endMs <= accountingStart) issues.push("BILLING_SCOPE_NOT_EFFECTIVE");
      const billed = result?.downstream?.channels?.find((channel) => channel.channelId === entry.channelId);
      if (!result) { missingQueryEvidence = true; issues.push("BILLING_EVIDENCE_NOT_QUERIED"); }
      const fixed = hasFixedCost(result);
      if (!result || billed?.billingState !== "complete" || finiteMoney(billed.amountUsd) == null
        || (fixed ? !hasCurrentBillingSide(result, result.downstream) : result.upstream?.state !== "complete" || !hasCurrentBillingPair(result))
        || blockingIssues(result).some((issue) => ["WAITING_FOR_BILL", "BILLING_WINDOW_MISMATCH"].includes(issue.code))) {
        // 账单还没读全时系统会自己重读，渠道只显示「还在读取」，不另外列事项。
        issues.push("BILLING_MISSING");
      }
      // 成本能不能算进利润，分开说是哪一个原因（§5.2）：Key 还给别处用吗、上游按哪个时区算一天、这把 Key 是否绑了两次、属于哪个账号。
      // Key 还有没有其他用途只关系成本；固定采购的上游成本记 0，不用确认；已固定的那天按固定时的结论，不看现在的回答。
      // 没有读取结果时先不判断后三项。
      if (!result?.settledAt && coverageNeedsAnswer(rule, fixed ? "fixed" : "usage")) need("COST_COVERAGE_UNKNOWN", "confirm_coverage");
      if (result && result.billingTimezone?.state !== "verified") need("BILLING_TIMEZONE_UNVERIFIED", "verify_capability");
      if (result && !fixed && result.upstream?.ownershipState === "duplicate") need("CANONICAL_KEY_CONFLICT", "review_conflict");
      if (result && !fixed && result.upstream?.ownershipState === "unknown") need("COST_OWNER_UNVERIFIED", "verify_identity");
      // 汇总没加的（毛利没算出来、或者需处理），渠道也不算已算进利润，和汇总同一个判断；别的原因都没说到时按「还在读取」
      if (result && !countsInSummary(result) && !issues.some((code) => CHANNEL_STATUS_CODES.has(code))) issues.push("BILLING_MISSING");
      if (result && (!result.ownSource || result.ownSource.namespaceKey !== entry.ownSource?.namespaceKey
        || result.health?.code === "SOURCE_BINDING_UNCONFIRMED" || result.health?.code === "LEGACY_IDENTITY_UNVERIFIED"
        || result.health?.issues?.some((issue) => ["SOURCE_BINDING_UNCONFIRMED", "LEGACY_IDENTITY_UNVERIFIED"].includes(issue.code)))) issues.push("SOURCE_BINDING_UNCONFIRMED");
    }
    // 这一行是需处理、渠道自己又说不出需处理的原因（只有「还在读取」或没有码）：渠道也写需处理，原因和按钮取这一行的状态，
    // 和那一行、汇总旁边那句说法一致（例如读取失败超过 7 天、上游拒绝读取这把 Key）
    const rowStatus = result && rule && needsAttention(result) && !issues.some((code) => ATTENTION_CHANNEL_CODES.has(code))
      ? result.displayStatus || reconciliationDisplayStatus(result) : null;
    const status = issues.includes("DUPLICATE_CHANNEL_ASSIGNMENT") ? "duplicate" : issues.includes("SOURCE_BINDING_UNCONFIRMED") ? "source_unverified"
      : !active.length ? "unlinked" : issues.includes("BILLING_SCOPE_NOT_EFFECTIVE") ? "not_effective" : rowStatus ? "row_attention"
        : issues.includes("BILLING_MISSING") ? "billing_missing" : COVERAGE_CODES.some((code) => issues.includes(code)) ? "coverage_unknown" : "accounted";
    const actions = [...kinds].map(([kind, code]) => workflowAction(kind, { stationId: tokenStationOf(code, params, rule?.upstreamStationId, entry.ownStationId ?? rule?.ownStationId), ruleId: rule?.id ?? null,
      ownStationId: entry.ownStationId, channelIds: [entry.channelId], window: window || result?.window || null }, { code, params }));
    return { ownSource: entry.ownSource, ownStationId: entry.ownStationId, channelId: entry.channelId, name: entry.name,
      operatingState: entry.operatingState, ruleIds: entry.rules.map((item) => item.id).sort(), status, issues: [...new Set(issues)],
      ...(status === "row_attention" ? { reason: rowStatus.title } : {}),
      // 按 id 去重，和 reconciliationDisplayStatus 里一样：以后渠道和那一行给出同一个按钮时只留一个
      actions: status === "row_attention" ? [...new Map([...actions, ...rowStatus.actions].map((action) => [action.id, action])).values()] : actions };
  }).sort((a, b) => (a.ownSource?.namespaceKey || a.ownStationId).localeCompare(b.ownSource?.namespaceKey || b.ownStationId) || a.channelId - b.channelId);
  const accountedChannelCount = channels.filter((channel) => channel.status === "accounted").length;
  return { label: "known-channel-coverage", state: !current || missingQueryEvidence ? "unknown" : accountedChannelCount === channels.length ? "complete_known" : "partial",
    catalogueState: current ? "verified" : "unknown", wholeSiteState: "unverified", knownChannelCount: channels.length, accountedChannelCount, channels };
}

// 页面显示口径的小计：按 currency 折算（任何一行折算不了就整组按 USD），固定采购上游的成本记为 0。
function displayTotals(rows, currency, eligible) {
  const factorsOf = (row) => reconciliationRateFactors(row.rates, currency);
  if (currency === "CNY" && !rows.every(factorsOf)) return displayTotals(rows, "USD", eligible);
  const sales = new Map();
  let cost = 0, costSampled = false, profit = 0, profitSampled = false, confirmedIncome = 0;
  for (const row of rows) {
    const side = row.downstream, factors = factorsOf(row);
    if (hasCurrentBillingSide(row, side)) for (const channel of side.channels || []) {
      const amount = finiteMoney(channel.knownAmountUsd ?? channel.amountUsd);
      if (amount == null) continue;
      const id = `${row.ownSource?.namespaceKey || `unknown:${row.rule.id}`}:${channel.channelId}`;
      const sample = { amount: amount * factors.income, at: Number(side.observedAt) || Date.parse(row.generatedAt) || 0, generatedAt: Date.parse(row.generatedAt) || 0 };
      const previous = sales.get(id);
      if (!previous || previous.at < sample.at || previous.at === sample.at && previous.generatedAt < sample.generatedAt) sales.set(id, sample);
    }
    const amount = Object.hasOwn(row.upstream || {}, "countedAmountUsd") ? row.upstream.countedAmountUsd : row.upstream?.knownAmountUsd ?? row.upstream?.amountUsd;
    // 固定采购的成本确定为 0，不依赖上游账单是否取到。
    if (factors.fixedCost) costSampled = true;
    else if (hasCurrentBillingSide(row, row.upstream) && finiteMoney(amount) != null) { cost += finiteMoney(amount) * factors.cost; costSampled = true; }
    if (eligible(row)) {
      const values = reconciliationCalculationValues(row.calculation, row.health, row, currency);
      if (values.currency !== currency) return displayTotals(rows, "USD", eligible);
      profit += values.profit; profitSampled = true; confirmedIncome += row.downstream.amountUsd * factors.income;
    }
  }
  return { currency, knownIncome: sales.size ? [...sales.values()].reduce((sum, sample) => sum + sample.amount, 0) : null,
    knownCost: costSampled ? cost : null, confirmedProfit: profitSampled ? profit : null,
    confirmedMarginRate: profitSampled && confirmedIncome > 0 ? profit / confirmedIncome : null };
}

// 毛利算出来了：Key 的用途答过（固定成本不用答）、按哪个时区算一天核实过、两侧账单对得上。今天和不完整窗口同样算实时毛利
// 已固定的日子按固定那天的结论，不看现在 Key 用途怎么答（之后改了回答，那天照样已固定、照加，F §2.1）
function hasComputedProfit(row) {
  return (!!row.settledAt || !coverageNeedsAnswer(row.rule, hasFixedCost(row) ? "fixed" : "usage"))
    && row.billingTimezone?.state === "verified" && hasTrustworthyProfit(row) && finiteMoney(row.calculation?.profitUsd) != null;
}

// 这条绑定这天要不要人处理（§4 的「需处理」）；服务端算好的 displayStatus 优先
function needsAttention(row) {
  return (row.displayStatus || reconciliationDisplayStatus(row)).state === "action";
}

// 这天账本里已经有固定的数，只是重算的事要人处理（RESETTLE_SHRUNK、RESETTLE_TOO_OLD、RESETTLE_NOT_DONE，且没有别的问题）：
// 页面上显示的、汇总里算的都还是原来固定的数（说明里就这么写），所以照算，只多一句提示；不能单日不算、多天又算（审核 C3 中-2）
const HELD_OLD_NUMBER_CODES = new Set(["RESETTLE_SHRUNK", "RESETTLE_TOO_OLD", "RESETTLE_NOT_DONE"]);
export function heldOldNumber(row) {
  const status = row.displayStatus || reconciliationDisplayStatus(row);
  return status.state === "action" && !!row.settledAt && !(status.moreCount > 0) && HELD_OLD_NUMBER_CODES.has(status.action?.code);
}

// 算不算进利润（§4）：毛利算出来了、又不是需处理（已固定、只是重算的事要处理的照算）。汇总的收入、上游成本、毛利，和「没算进利润的上游成本」里的已算进利润，都按这一个判断
export function countsInSummary(row) {
  return hasComputedProfit(row) && (!needsAttention(row) || heldOldNumber(row)) && !isNotStarted(row);
}
function isNotStarted(row) {
  return (row.displayStatus || reconciliationDisplayStatus(row)).state === "not_started";
}

// totals 的 *Usd 字段是账单原币原始口径；display 是页面显示口径（currency 默认按这批结果能否全部按人民币显示决定）。
// 收入、上游成本、毛利只加算进利润的绑定（countsInSummary）：三个数同一个范围，收入 − 上游成本 = 毛利；需处理的不加，
// 记进 attentionRuleIds，金额留在它自己那一行。还在读取、毛利没算出来的也不加，渠道那一句「N 个渠道里 M 个已算进利润」会说到它。
export function summarizeReconciliationWindowGroups(results, { coverageFor, currency = reconciliationDisplayCurrency(results) } = {}) {
  const eligible = hasComputedProfit, counted = countsInSummary;
  const groups = new Map();
  for (const result of results) {
    const window = result.window, basis = result.amountBasis;
    // 实时窗口每条关联截止点不同，按预设分组；组内截止点取最早的一条，所有行都至少覆盖到这里。
    const key = JSON.stringify([result.ownSource?.namespaceKey || `unknown:${result.rule.id}`, window.startMs,
      isLiveReconciliationPreset(window.preset) ? `live:${window.preset}` : window.endMs,
      basis?.id, basis?.currency, basis?.billingSource, basis?.calculationVersion, basis?.conversion,
      result.billingTimezone?.state === "verified" ? null : window.timezone]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  const windowGroups = [...groups].map(([groupKey, rows]) => {
    const first = rows[0], sales = new Map();
    let cost = 0, costSampled = false, profit = 0, profitSampled = false, confirmedIncome = 0;
    for (const row of rows.filter(counted)) {
      const side = row.downstream;
      if (hasCurrentBillingSide(row, side)) for (const channel of side.channels || []) {
        const amount = finiteMoney(channel.knownAmountUsd ?? channel.amountUsd);
        if (amount == null) continue;
        const id = `${row.ownSource?.namespaceKey || `unknown:${row.rule.id}`}:${channel.channelId}`;
        const sample = { amount, at: Number(side.observedAt) || Date.parse(row.generatedAt) || 0, generatedAt: Date.parse(row.generatedAt) || 0 };
        const previous = sales.get(id);
        if (!previous || previous.at < sample.at || previous.at === sample.at && previous.generatedAt < sample.generatedAt) sales.set(id, sample);
      }
      const amount = Object.hasOwn(row.upstream || {}, "countedAmountUsd") ? row.upstream.countedAmountUsd : row.upstream?.knownAmountUsd ?? row.upstream?.amountUsd;
      // 固定成本的上游成本记 0（采购费按天平摊进净利），和 display 那份一样；Key 用量只在那一行里看
      if (hasFixedCost(row)) costSampled = true;
      else if (hasCurrentBillingSide(row, row.upstream) && finiteMoney(amount) != null) { cost += finiteMoney(amount); costSampled = true; }
      profit += row.calculation.profitUsd; profitSampled = true; confirmedIncome += row.downstream.amountUsd;
    }
    const coverage = coverageFor(first.window, first.ownSource);
    const endMs = Math.min(...rows.map((row) => row.window.endMs));
    return { groupKey, ownSource: first.ownSource,
      window: { startMs: first.window.startMs, endMs, ...(isLiveReconciliationPreset(first.window.preset) ? { preset: first.window.preset } : {}) },
      timezones: [...new Set(rows.map((row) => row.window.timezone))].sort(), amountBasis: first.amountBasis, ruleIds: rows.map((row) => row.rule.id),
      totals: { knownIncomeUsd: sales.size ? [...sales.values()].reduce((sum, sample) => sum + sample.amount, 0) : null,
        knownCostUsd: costSampled ? cost : null, confirmedProfitUsd: profitSampled ? profit : null,
        confirmedMarginRate: profitSampled && confirmedIncome > 0 ? profit / confirmedIncome : null,
        profitComplete: coverage.state === "complete_known" && rows.every(eligible),
        attentionRuleIds: rows.filter((row) => needsAttention(row) && !heldOldNumber(row)).map((row) => row.rule.id),
        // 已固定、重算的事要处理的：照算进汇总，旁边只加一句提示
        heldRuleIds: rows.filter(heldOldNumber).map((row) => row.rule.id),
        // 还没开始统计的不算进汇总，也不算还在读取，旁边那句不提它（C②）
        notStartedRuleIds: rows.filter(isNotStarted).map((row) => row.rule.id),
        readingRuleIds: rows.filter((row) => !counted(row) && !needsAttention(row) && !isNotStarted(row)).map((row) => row.rule.id), display: displayTotals(rows.filter(counted), currency, eligible) }, coverage, actions: [...new Map(rows.flatMap((row) => row.actions || []).map((action) => [action.id, action])).values()] };
  });
  const compatible = windowGroups.length === 1 && results.every((row) => row.ownSource?.namespaceKey && row.amountBasis?.conversion
    && row.billingTimezone?.state === "verified"
    && !blockingIssues(row).some((issue) => ["SOURCE_BINDING_UNCONFIRMED", "LEGACY_IDENTITY_UNVERIFIED", "BILLING_WINDOW_MISMATCH"].includes(issue.code)));
  return { windowGroups, commonSummary: compatible ? { groupKey: windowGroups[0].groupKey, totals: windowGroups[0].totals, coverage: windowGroups[0].coverage } : null };
}

// 核算关联建在没开监控的站点上时（独立 Key 监控 + 专用账号授权），按用量对比的账号找不到自己的关联，
// 已核算会少算、未纳入会多算。能确认是同一账号（核验过的账号身份相同），或关联的销售渠道接到了这个监控站点时，
// 把关联归到这个账号，不论两个站点地址是否相同；有多个候选或无法确认时不归属，只在同地址、身份不冲突的候选账号上标出来。
// 地址相同本身不能确认成本身份。固定采购的关联成本记 0（我的站点按账号扣费计成本），不归属，差额留在未纳入里；
// 重复归属的非归属方成本记在归属关联上，不归属时也不标。
// monitorLinks: 当前有效的监控关联 [{ ownStationId, channelId, stationId }]。
// 返回 Map<监控账号 stationId, { borrowed: [{ ruleId, stationId, stationName }], uncertain: [...] }>
export function attributeAuthorizationRules({ usageStations = [], rows = [], stationOf = () => null, monitorLinks = [] } = {}) {
  const result = new Map();
  const add = (stationId, kind, entry) => {
    const key = String(stationId);
    if (!result.has(key)) result.set(key, { borrowed: [], uncertain: [] });
    result.get(key)[kind].push(entry);
  };
  const accountOf = (station) => {
    const identity = station?.verifiedIdentity, accountId = String(identity?.accountId || "").trim();
    return accountId ? [identity.provider, onboardingBaseUrl(identity.baseUrl), accountId].join("|") : null;
  };
  const usageIds = new Set(usageStations.map((station) => String(station.id)));
  for (const row of rows) {
    const hostId = row.rule?.upstreamStationId;
    if (hostId == null || usageIds.has(String(hostId))) continue;
    const host = stationOf(hostId);
    if (!host || host.monitorEnabled !== false || row.rates?.costBasis === "fixed") continue;
    const site = onboardingBaseUrl(host.baseUrl), hostAccount = accountOf(host);
    // 身份都核验过且不同，就不是同一个账号
    const compatible = usageStations.filter((station) => { const account = accountOf(station); return !account || !hostAccount || account === hostAccount; });
    const channelIds = new Set((row.rule.channels || []).map((channel) => Number(channel.channelId)));
    const linked = (station) => monitorLinks.some((link) => String(link.stationId) === String(station.id)
      && String(link.ownStationId) === String(row.rule.ownStationId) && channelIds.has(Number(link.channelId)));
    const confirmed = compatible.filter((station) => (hostAccount && accountOf(station) === hostAccount) || linked(station));
    const entry = { ruleId: row.rule.id, stationId: host.id, stationName: host.name };
    if (confirmed.length === 1) { add(confirmed[0].id, "borrowed", entry); continue; }
    if (row.upstream?.duplicateOfRuleId != null) continue;
    const candidates = confirmed.length ? confirmed : site ? compatible.filter((station) => onboardingBaseUrl(station.baseUrl) === site) : [];
    for (const station of candidates) add(station.id, "uncertain", entry);
  }
  return result;
}

// 已算进利润的多于上游扣费时，差额是怎么来的（design/ui-copy-spec.md §3.2）
const OVER_ACCOUNTED_NOTE = {
  timing: "已算进利润的多于上游扣费：上游的扣费可能还没记全",
  rate: "已算进利润的多于上游扣费：两边汇率不同",
  mixed: "已算进利润的多于上游扣费：上游的扣费可能还没记全，两边汇率也不同",
};
// 浮点相加减留下的极小差额按 0 计，免得显示「已核算高于账号扣费」；误差随金额变大，阈值按相减两边的量级放大。
// 1e-12 远大于累加误差（几百条约 1e-14 量级），又不吞真实的零头（$2 万的账号上一个 $0.000002 额度单位照样保留）
const nearZero = (value, ...scales) => Math.abs(value) < 1e-12 * Math.max(1, ...scales.map(Math.abs)) ? 0 : value;

// 固定采购关联的成本记 0，采购费由我的站点摊销；关联所在站点不在摊销范围（amortizedIds）时点名，每个站点一次。
// 已删除的站点不会按固定采购计成本，不在此列。
export function fixedOffProfitStations(rows = [], { amortizedIds = [], stationOf = () => null } = {}) {
  const amortized = new Set([...amortizedIds].map(String));
  const named = new Map();
  for (const row of rows) {
    if (row.rates?.costBasis !== "fixed") continue;
    const station = stationOf(row.rule?.upstreamStationId);
    if (station && !amortized.has(String(station.id))) named.set(String(station.id), { id: station.id, name: station.name });
  }
  return [...named.values()];
}

function groupByStation(entries) {
  const grouped = new Map();
  for (const { ruleId, stationId, stationName } of entries) {
    const key = String(stationId);
    if (!grouped.has(key)) grouped.set(key, { name: stationName || key, ids: [] });
    grouped.get(key).ids.push(ruleId);
  }
  return [...grouped.values()].map(({ name, ids }) => [name, ids]);
}

// 未纳入核算的上游消费 = 各按用量计费上游的账号级扣费 − 本窗口已计入核算的 Key 成本。
// 账号级扣费和「我的站点」的上游成本同一取数，所以核算已计入成本加上本项就是我的站点的上游成本。
// 设为不计入成本的上游不做账号级对比（我的站点不计它的成本），但建在按用量计费的这类上游上的核算关联仍按 Key 用量计成本
// （固定采购上的关联成本记 0）。
// currency 为 CNY 且每个上游都设置了汇率时按各自汇率折算人民币，否则按 USD 原值。*Usd 字段始终是 USD。
// 已核算按明细行上的汇率折算：归属来的关联用它自己上游的汇率，已结账的日子用结账时记下的汇率；未纳入 = 账号扣费按本账号当前汇率折算 − 已核算。
// 汇率不同时人民币的未纳入和美元的正负可能不同，「已核算高于账号扣费」按显示的金额判断，汇率差单独说明；
// overAccounted 给出原因：timing 取数时刻不同（或上游扣费尚未入账）、rate 汇率不同、mixed 两者都有。浮点误差内的差额按 0 计。
// accounts: [{ station: { id, name }, rate: { cnyPerUsd, source }, usage: { usd, mode, note, endMs, lowerBound } | null（读取中）, approximate,
//   borrowed, uncertain }]，borrowed / uncertain 来自 attributeAuthorizationRules。
// lowerBound：余额历史没覆盖整个时段，账号扣费只是下限。负的未纳入（已核算高于账号扣费）在明细里保留，合计按 0 计。
export function summarizeUnaccountedUpstream(accounts = [], rows = [], { currency = "USD" } = {}) {
  const cny = currency === "CNY" && accounts.every(({ rate }) => isConfiguredRate(rate));
  const items = accounts.map(({ station, rate, usage, approximate = false, borrowed = [], uncertain = [] }) => {
    const borrowedIds = new Set(borrowed.map((entry) => String(entry.ruleId)));
    const ruleRows = rows.filter((row) => String(row.rule?.upstreamStationId) === String(station.id) || borrowedIds.has(String(row.rule?.id)));
    const factor = cny ? Number(rate.cnyPerUsd) : 1;
    // rateGap：行上折算成本的汇率和这个账号当前的汇率不同时，人民币已核算按行上的金额算。
    // 固定采购的行成本记 0，这里比的是 Key 用量，按账号汇率折算。
    let accountedUsd = 0, rateGap = 0, settledRateGap = false;
    const rateGapEntries = [];
    // 已算进利润只加算进利润的绑定（和汇总同一个判断）；需处理、还在读取的那几条的成本留在「没算进利润」里
    for (const row of ruleRows.filter(countsInSummary)) {
      const current = hasCurrentBillingSide(row, row.upstream);
      const counted = current ? finiteMoney(row.upstream?.countedAmountUsd) : null;
      if (counted != null) {
        accountedUsd += counted;
        const id = String(row.rule?.id);
        const rowFactor = cny && row.rates?.costBasis !== "fixed" ? (reconciliationRateFactors(row.rates, "CNY")?.cost ?? factor) : factor;
        if (counted && rowFactor !== factor) {
          rateGap += counted * (rowFactor - factor);
          const entry = borrowedIds.has(id) ? borrowed.find((item) => String(item.ruleId) === id) : null;
          if (entry) rateGapEntries.push(entry);
          else settledRateGap = true;
        }
      }
    }
    const accountUsd = usage ? finiteMoney(usage.usd) : null;
    const accounted = accountedUsd * factor + rateGap;
    const unaccountedUsd = accountUsd == null ? null : nearZero(accountUsd - accountedUsd, accountUsd, accountedUsd);
    const unaccounted = unaccountedUsd == null ? null : nearZero(unaccountedUsd * factor - rateGap, accountUsd * factor, accounted);
    const overAccounted = unaccounted == null || unaccounted >= 0 ? null : unaccountedUsd >= 0 ? "rate" : rateGap > 0 ? "mixed" : "timing";
    const notes = [];
    if (usage?.note) notes.push(usage.note);
    if (approximate) notes.push("这个上游按整天给用量，自选时间按整天算");
    for (const [name] of groupByStation(borrowed)) notes.push(`已算进利润的部分含暂停监控的上游「${name}」上的绑定`);
    for (const [name] of groupByStation(uncertain)) notes.push(`暂停监控的上游「${name}」上的绑定还没确认属于哪个上游账号，没算进利润的上游成本可能偏高；到「渠道绑定」里把渠道对上这个上游后就能确认`);
    for (const [name] of groupByStation(rateGapEntries)) notes.push(`上游「${name}」的汇率和这个上游账号不一样，差额里有汇率差；两边的汇率设成一样就没有了`);
    if (settledRateGap) notes.push("已固定的日子按固定时记下的汇率换算，差额里有汇率差");
    if (overAccounted) notes.push(OVER_ACCOUNTED_NOTE[overAccounted]);
    const state = !usage ? "pending" : accountUsd == null ? "unavailable" : usage.lowerBound || uncertain.length ? "partial"
      : approximate || usage.mode === "history" ? "estimated" : "complete";
    return { stationId: station.id, name: station.name, rate: cny ? factor : null,
      mode: usage?.mode ?? null, endMs: usage?.endMs ?? null, state, notes, ruleIds: ruleRows.map((row) => row.rule.id),
      accountUsd, accountedUsd, unaccountedUsd,
      account: accountUsd == null ? null : accountUsd * factor, accounted,
      unaccounted, overAccounted };
  });
  const has = (state) => items.some((item) => item.state === state);
  const state = has("pending") ? "pending" : has("unavailable") || has("partial") ? "partial" : has("estimated") ? "estimated" : "complete";
  return { state, currency: cny ? "CNY" : "USD",
    total: state === "pending" ? null : items.reduce((sum, item) => sum + Math.max(0, item.unaccounted ?? 0), 0), accounts: items };
}

export function mergeReconciliationSegments(historySegments = [], calculatedSegments = [], refreshedHistorySegments = []) {
  const history = Array.isArray(historySegments) ? historySegments : [];
  const calculated = Array.isArray(calculatedSegments) ? calculatedSegments : [];
  const refreshed = Array.isArray(refreshedHistorySegments) ? refreshedHistorySegments : [];
  const calculatedById = new Map(calculated.map((segment) => [segment?.id, segment]));
  const refreshedById = new Map(refreshed.map((segment) => [segment?.id, segment]));
  const merged = history.map((segment) => ({
    ...segment,
    ...(calculatedById.get(segment?.id) || {}),
    ...(refreshedById.get(segment?.id) || {}),
  }));
  const mergedIds = new Set(history.map((segment) => segment?.id));
  for (const segment of calculated) {
    if (!mergedIds.has(segment?.id)) {
      merged.push({ ...segment, ...(refreshedById.get(segment?.id) || {}) });
      mergedIds.add(segment?.id);
    }
  }
  for (const segment of refreshed) {
    if (!mergedIds.has(segment?.id)) {
      merged.push(segment);
      mergedIds.add(segment?.id);
    }
  }
  return merged;
}

export function hasReconciliationHistory(segments = []) {
  return segments.slice(1).some((segment, index) => {
    const previous = segments[index];
    if ((segment.group || "") !== (previous.group || "")) return true;
    if (previous.ratio == null || segment.ratio == null) return false;
    const before = Number(previous.ratio);
    const after = Number(segment.ratio);
    return Number.isFinite(before) && Number.isFinite(after) && before !== after;
  });
}

export function mergeReconciliationChannels(ruleChannels = [], observedChannels = []) {
  const configured = Array.isArray(ruleChannels) ? ruleChannels : [];
  const observed = Array.isArray(observedChannels) ? observedChannels : [];
  if (!configured.length) return observed;
  const observedById = new Map(observed.map((channel) => [Number(channel?.channelId ?? channel?.id), channel]));
  return configured.map((channel) => ({
    ...channel,
    ...(observedById.get(Number(channel?.channelId ?? channel?.id)) || {}),
  }));
}

// 渠道和 Key 在界面上的名字（§3.1）：没有名字时写「渠道 #12」「Key #34」，各页都用这两个。
export function reconciliationChannelName(channel) {
  const id = channel?.channelId ?? channel?.id;
  return channel?.name || (id == null ? "渠道" : `渠道 #${id}`);
}

// siblings 是同一个列表里的其他 Key（{ tokenName, tokenId }）：有同名的就在名字后面加「（Key #34）」，免得选错
export function reconciliationKeyName(rule, siblings) {
  if (!rule?.tokenName) return rule?.tokenId == null ? "Key" : `Key #${rule.tokenId}`;
  const clash = rule.tokenId != null && siblings?.some((other) => other?.tokenName === rule.tokenName && other?.tokenId != null && String(other.tokenId) !== String(rule.tokenId));
  return clash ? `${rule.tokenName}（Key #${rule.tokenId}）` : rule.tokenName;
}

// 一个页面或列表里所有 Key 共用的取名：传入这里出现的全部绑定（或 Key），同名的都加上编号
export const reconciliationKeyNamer = (siblings) => (rule) => reconciliationKeyName(rule, siblings);

// 读到了上游成本、但没加进汇总的绑定（例如和别的绑定共用一把 Key）；汇总和分组小计都用这一句点名
// 汇总和每组小计旁边那句（§4、F2）：哪几条绑定没算进来——需处理的、还在读取（毛利还没算出来）的；
// 这段时间只有一天（今天，或过去某个整天）时点名是哪天。totals 是汇总的 totals（attentionRuleIds、readingRuleIds），
// window 要带时区（每组的窗口没带时区，传 { ...group.window, timezone: group.timezones[0] }）
export function reconciliationNotCountedText(totals, window, now = Date.now()) {
  const attention = new Set(totals?.attentionRuleIds || []).size, reading = new Set(totals?.readingRuleIds || []).size;
  if (!attention && !reading) return "";
  const parts = [attention ? `${attention} 条绑定需处理` : "", reading ? `${reading} 条${attention ? "" : "绑定"}还在读取` : ""].filter(Boolean).join("、");
  const oneDay = window?.timezone && (window.preset === "today" || billDayOf(window)) ? formatZonedDate(window.startMs, window.timezone, now) : "";
  return oneDay ? `其中 ${oneDay} 有 ${parts}，没算进来。` : `其中 ${parts}，没算进来。`;
}

// 已固定、重算的事要处理的绑定（totals.heldRuleIds）照算进了汇总，旁边说一句，免得人以为那天的数是新算的（审核 C3 中-2，用语规范 §4）。
// 少了一半多、太早、没重算成对用户是同一件事（还没重算、用的是旧数），这里不分开说，具体原因在那一行的需处理里；和「没算进来」那句都有时分成两句、这句在后
export function reconciliationHeldText(totals, window, now = Date.now()) {
  const held = new Set(totals?.heldRuleIds || []).size;
  if (!held) return "";
  const oneDay = window?.timezone && (window.preset === "today" || billDayOf(window)) ? formatZonedDate(window.startMs, window.timezone, now) : "";
  return oneDay ? `其中 ${oneDay} 有 ${held} 条绑定还没重算，先按原来固定的数算。` : `其中 ${held} 条绑定有几天还没重算，先按原来固定的数算。`;
}

// 选的这段时间所有绑定都还没开始统计（C②，§8.1）：汇总那里写一句，点名最早的绑定从哪天开始。不是全部都没开始就返回空串
export function reconciliationNotStartedText(results, window, now = Date.now()) {
  const rows = (results || []).filter(Boolean);
  if (!rows.length || !rows.every(reconciliationNotStarted)) return "";
  const earliest = rows.reduce((best, row) => (reconciliationAccountingStart(row.rule) < reconciliationAccountingStart(best.rule) ? row : best), rows[0]);
  const start = reconciliationAccountingStartText(earliest.rule, earliest.window?.timezone, now);
  const oneDay = window?.timezone && (window.preset === "today" || billDayOf(window));
  return `${oneDay ? "这天" : "这几天"}还没开始统计。${start ? `最早的绑定从 ${start} 开始统计。` : ""}`;
}

// 渠道现在的状态。三处来的渠道写法不同：绑定里的渠道有 missing / state，渠道列表的有 operatingState，
// 自营站点渠道目录的只有 status 数字（1 启用、2 手动停用、3 自动停用）
const CHANNEL_STATE_BY_STATUS = { 1: "enabled", 2: "manual_disabled", 3: "auto_disabled" };
function channelOperatingState(channel) {
  if (channel?.missing) return "missing";
  return channel?.operatingState || channel?.state || CHANNEL_STATE_BY_STATUS[Number(channel?.status)] || "unknown";
}

// 渠道名旁的小标签（§4）：已停用、已删除。
export function reconciliationChannelTag(channel) {
  const state = channelOperatingState(channel);
  if (state === "missing") return reconciliationIssue("SALES_CHANNEL_MISSING").tag;
  if (state === "manual_disabled" || state === "auto_disabled") return reconciliationIssue("SALES_CHANNEL_DISABLED").tag;
  return null;
}

// 列表里一行的状态和标签。displayStatus 由服务端算好；旧数据没有时在这里补算。
// severity 用来排序：需处理在前，其次亏损，再是实时、已固定。
export function reconciliationRowFlags(item = {}, currency = "USD", { now = Date.now() } = {}) {
  const displayStatus = item?.displayStatus || reconciliationDisplayStatus(item, { now });
  // values 是这一行显示的毛利、毛利率：需处理时写「—」，不标亏损（§4）。
  // 亏损按显示口径判断：固定采购上游的成本记为 0，账单原币差额为负也不算亏损。
  const calculated = reconciliationCalculationValues(item?.calculation, item?.health, item, currency);
  const values = (displayStatus.state === "action" && !heldOldNumber({ ...item, displayStatus })) || displayStatus.state === "not_started" ? { ...calculated, profit: null, margin: null } : calculated;
  const negative = values.profit != null && Number.isFinite(Number(values.profit)) && Number(values.profit) < 0;
  const tags = [...(displayStatus.revised ? ["改过"] : []), ...(negative ? ["亏损"] : [])];
  const severity = displayStatus.state === "action" ? 0 : negative ? 1 : displayStatus.state === "live" ? 2 : displayStatus.state === "not_started" ? 4 : 3;
  return { displayStatus, values, negative, attention: displayStatus.state === "action", tags, severity };
}

export function filterReconciliationResults(results = [], upstreams = [], search = "", filter = "all", currency = "USD", now = Date.now()) {
  const needle = String(search).trim().toLocaleLowerCase();
  const stations = new Map((Array.isArray(upstreams) ? upstreams : []).map((station) => [String(station.id), station.name]));
  // 每行的状态只算一次，筛选和排序用同一个时刻
  const flagsOf = new Map(results.map((item) => [item, reconciliationRowFlags(item, currency, { now })]));
  const keyName = reconciliationKeyNamer(results.map((item) => item?.rule));
  return results.filter((item) => {
    const flags = flagsOf.get(item);
    if (filter === "attention" && !flags.attention) return false;
    if (filter === "negative" && !flags.negative) return false;
    if (!needle) return true;
    const rule = item?.rule || {};
    const channelNames = mergeReconciliationChannels(rule.channels, item?.downstream?.channels)
      .flatMap((channel) => [reconciliationChannelName(channel), `ID ${channel.channelId ?? channel.id ?? ""}`]);
    const fields = [stations.get(String(rule.upstreamStationId)), keyName(rule),
      item?.currentSegment?.group, item?.upstream?.group, rule.fixedGroup, ...channelNames];
    return fields.some((field) => String(field || "").toLocaleLowerCase().includes(needle));
  }).sort((a, b) => flagsOf.get(a).severity - flagsOf.get(b).severity);
}
