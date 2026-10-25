// 结账判定：一条绑定的某段窗口「这天该不该结」，只在这里判断。纯函数，服务端、页面都能用（不引 node 专用模块）。
// - 等待期：上游账单在自然日结束后还会陆续入账，结束满 RECONCILIATION_SETTLE_DELAY_MS（15 分钟）才算可结账。
// - 取数前（precheck）：只看窗口、绑定和状态表那一行，不发请求——要不要先读已固定的账、轮询要不要去结、为什么不结。
// - 取数后（outcome）：拿到结果后决定写账本（单日）、写确认快照（多日），还是只记观测；状态表那一行删掉、记重试还是记要人处理。
// - 重试间隔（settleRetryDelayMs）：结账没成，隔多久再试。
// - 回看：自动结账只回看结束 7 天以内的日子（SETTLE_LOOKBACK_MS），页面上「过了 7 天还没读到」也按这一个算（计划 C2a）。
// 「整天」「哪天的账」用 lib/business-time.js 的 billDayOf，「过完没有」用同一处的 isCompletedBillingWindow。
// 整条导入链里不能有 node: 模块（有守护测试）。
import { RECONCILIATION_SETTLE_DELAY_MS, reconciliationAccountingStart, reconciliationIssue } from "./reconciliation-contract.js";
import { billDayOf, isCompletedBillingWindow } from "./business-time.js";

export { RECONCILIATION_SETTLE_DELAY_MS };

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// 自动结账回看多久：结束满 7 天还没结成就不再自动试，只能手动；页面上读取类的问题过了这么久也变成需处理（§4）
export const SETTLE_LOOKBACK_MS = 7 * DAY;
// 结账没成时隔多久再试，按第几次没成排，超出的用最后一档
export const SETTLE_RETRY_STEPS_MS = Object.freeze([10 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR]);
// 昨天例外：结束后的头 6 小时里每 10 分钟试一次，日报和「昨天」最常被看，不能因为退避变慢
export const SETTLE_FAST_RETRY_WINDOW_MS = 6 * HOUR;
export const SETTLE_FAST_RETRY_MS = 10 * MINUTE;
// 要人处理的日子不发请求，每隔这么久在本地重判一次（配置变了马上重判）
export const SETTLE_MANUAL_RECHECK_MS = 10 * MINUTE;
// 保险值：自动试满这么多次就停，防程序出错。7 天里昨天正常约 66 次、更早的日子约 31 次
export const SETTLE_MAX_AUTO_ATTEMPTS = 80;

// 结账没成，下次什么时候再试：结束后头 6 小时每 10 分钟；之后按第几次没成走退避表
export function settleRetryDelayMs(failures = 1, { window = null, now = Date.now() } = {}) {
  if (Number.isFinite(window?.endMs) && now - window.endMs < SETTLE_FAST_RETRY_WINDOW_MS) return SETTLE_FAST_RETRY_MS;
  return SETTLE_RETRY_STEPS_MS[Math.min(Math.max(failures, 1), SETTLE_RETRY_STEPS_MS.length) - 1];
}

// 时间上能不能结：两端都是 0 点，而且结束满等待期（单日、多日都一样）
export function isSettleableWindow(window, now = Date.now()) {
  return isCompletedBillingWindow(window, now - RECONCILIATION_SETTLE_DELAY_MS);
}

// 还在自动回看的范围里：结束不满 7 天
export function isWithinAutoRetry(window, now = Date.now()) {
  return Number.isFinite(window?.endMs) && now - window.endMs < SETTLE_LOOKBACK_MS;
}

// 一条旧的确认记录算不算结账：生成在这段窗口结束满等待期以后。窗口一结束就写下的记录，那时上游还在入账，不算
// （读侧 settledResult、仓库挑旧记录、迁移旧账都按这一个）。没有生成时刻的按 fallbackAt 算
export function isSettledAt(window, generatedAt, fallbackAt = null) {
  const parsed = Date.parse(generatedAt), at = Number.isFinite(parsed) ? parsed : fallbackAt;
  return Number.isFinite(at) && isSettleableWindow(window, at);
}

// 结账没成的原因归哪一类，只看 contract 里这个码的 kind（§4），不另写一张表：
//   retry   读取类，会自己好，按退避表再试；
//   manual  要人处理的、认不出的码：不发请求，配置变了或每 10 分钟在本地重判一次；
//   sticky  过去的事实、不会自己消失（contract 里 persists: true，比如那段时间自营站点关着消费日志）：不自动重试，也不重判。
export function reasonKindOf(code) {
  const issue = reconciliationIssue(code);
  if (issue.persists === true) return "sticky";
  return issue.known && issue.kind === "reading" ? "retry" : "manual";
}

// 取数前，只看窗口、绑定和状态表那一行（state），不发请求：
//   readSettled：先读已固定的账，读到就直接用（不是重结、而且时间上能结）
//   due：要不要去结这段窗口；action 是为什么（结账轮询、页面三态、E 的清单都按它）：
//     due 该结了；not_settleable 还没过完（含等待期）；not_effective 整天在开始统计之前；settled 账本里已经有这天；
//     beyond_lookback 结束满 7 天、自动不再试；backoff 没到下次重试的时刻；manual 要人处理、还没到重判的时刻；
//     recheck 要人处理、到了重判的时刻：不发请求，拿这一轮读到的目录和身份在本地重判（settleDue），原因没了才记 cleared、下一轮去结；
//     sticky 不会自己消失的原因；exhausted 自动试满保险值
//   有重结请求（state.resettleRequestedAt）时不看「已固定」，照样去结；请求后 7 天还不成就放弃（beyond_lookback）。
//   手动（origin: "manual"）只看时间和开始统计：用户点了就去结，不看退避、要人处理和 7 天。
//   ledgerHasDay：账本里有没有这天的任一版（单日窗口才有意义）；sourceVersion：现在的配置代次，和 state 里记的不同就马上去结
//   （要人处理的、读取类的都一样：改好了凭据不用等退避）。
//   scopeEditedAt：留给 D（配置改了以后的日子），C 里恒为空。
export function settlementPrecheck({ rule = null, window, now = Date.now(), resettle = false, state = null, origin = "auto",
  ledgerHasDay = false, sourceVersion = null, scopeEditedAt = null } = {}) {
  void scopeEditedAt;
  const settleable = isSettleableWindow(window, now);
  // 旧规则没有开始统计的时刻时，按建绑定的时刻算
  const start = rule ? reconciliationAccountingStart(rule) ?? Date.parse(rule.createdAt) : NaN;
  const beforeStart = Number.isFinite(start) && start >= window.endMs;
  const requested = resettle || state?.resettleRequestedAt != null;
  const decide = (action) => ({ settleable, readSettled: !requested && settleable, due: action === "due", action });
  if (!settleable) return decide("not_settleable");
  if (beforeStart) return decide("not_effective");
  if (origin === "manual") return decide("due");
  if (ledgerHasDay && !requested) return decide("settled");
  const sinceMs = requested ? Number(state?.resettleRequestedAt ?? now) : window.endMs;
  if (now - sinceMs >= SETTLE_LOOKBACK_MS) return decide("beyond_lookback");
  if (!state) return decide("due");
  const changed = sourceVersion != null && state.sourceVersion != null && state.sourceVersion !== sourceVersion;
  if (state.manualReason != null) {
    if (reasonKindOf(state.manualReason) === "sticky") return decide("sticky");
    if (changed || state.detail?.cleared === true) return decide("due");
    if (now < Number(state.nextAttemptAt)) return decide("manual");
    // 本地重判看不出来的原因（重判说没了、去结还是这个原因）：到点直接去结，按退避表计次，试满保险值就停
    if (state.detail?.probeBlind === true) return decide(Number(state.attempts) >= SETTLE_MAX_AUTO_ATTEMPTS ? "exhausted" : "due");
    return decide("recheck");
  }
  if (Number(state.attempts) >= SETTLE_MAX_AUTO_ATTEMPTS) return decide("exhausted");
  if (changed) return decide("due");
  return decide(Number.isFinite(Number(state.nextAttemptAt)) && now < Number(state.nextAttemptAt) ? "backoff" : "due");
}

// 取数后：毛利算出来了、不是开始统计之前、时间上能结，才结。单个自然日记进账本，多日窗口写确认快照；其余只记观测。
// state 是状态表这一行接下来怎么办（只对单日窗口）：
//   delete  结成了，删掉这一行（和账本同一个事务）；
//   retry   读取类：attempts + 1（只数自动的），下次按退避表；
//   manual  要人处理的：记下原因和变成需处理的时刻，10 分钟后本地重判；
//   sticky  不会自己消失的：记下原因，不再自动试。
// 手动（origin: "manual"）结不成时只更新原因，不推后自动的退避，也不计入 attempts。
export function settlementOutcome({ window, result, now = Date.now(), state = null, origin = "auto", sourceVersion = null }) {
  const settled = result?.calculation?.profitUsd != null && !result.scope?.notEffective && isSettleableWindow(window, now);
  const ledger = settled && !!billDayOf(window);
  const base = { settled, ledger, confirmedSnapshot: settled && !ledger };
  if (!billDayOf(window) || !isSettleableWindow(window, now) || result?.scope?.notEffective) return { ...base, state: null };
  if (settled) return { ...base, state: { op: "delete" } };
  const reason = String(result?.health?.code || "") || "UNKNOWN";
  const kind = reasonKindOf(reason);
  const manual = origin === "manual";
  const attempts = Number(state?.attempts) || 0;
  const common = { reason, sourceVersion, lastAttemptAt: now, firstFailedAt: state?.firstFailedAt ?? now,
    detail: { code: reason, side: result?.health?.issues?.find((issue) => issue.code === reason)?.side ?? null } };
  if (kind === "retry") {
    return { ...base, state: { op: "retry", ...common, attempts: manual ? attempts : attempts + 1,
      // 手动的不推后自动的：原来有下次重试的时刻就照旧，没有（这天还没自动试过）就是现在，轮询马上会试
      nextAttemptAt: manual ? Number(state?.nextAttemptAt ?? now) : now + settleRetryDelayMs(attempts + 1, { window, now }) } };
  }
  const since = state?.manualReason != null && state.manualSince != null ? Number(state.manualSince) : now;
  // 本地重判说原因没了（cleared），去结却还是这个原因：本地重判看不出它（比如取账单时才知道的），以后到点直接去结、按退避表计次
  const blind = kind === "manual" && !manual && state?.manualReason === reason && (state.detail?.cleared === true || state.detail?.probeBlind === true);
  if (blind) {
    return { ...base, state: { op: kind, ...common, detail: { ...common.detail, probeBlind: true }, attempts: attempts + 1, manualSince: since,
      nextAttemptAt: now + settleRetryDelayMs(attempts + 1, { window, now }) } };
  }
  return { ...base, state: { op: kind, ...common, attempts, manualSince: since,
    nextAttemptAt: kind === "sticky" ? null : now + SETTLE_MANUAL_RECHECK_MS } };
}

// 要人处理的日子到了重判的时刻（precheck 给 recheck）：不取账单，拿这一轮读到的目录和身份走一遍取数前的判断（inspectRule 的 probe），
// blocker 是还挡着的原因码（没有就是 null）。返回状态表这一行接下来怎么写：
//   还是要人处理（或者不会自己消失）的原因：照 settlementOutcome 记下（10 分钟后再重判，不计次数）；
//   原因没了，或者只剩读取类的：记 cleared，下一轮 precheck 给 due，先重读这个上游再去结（结的那一轮和平常一样）。
export function settlementRecheck({ window, state, blocker = null, now = Date.now(), sourceVersion = null }) {
  if (blocker && reasonKindOf(blocker) !== "retry") {
    return settlementOutcome({ window, result: { health: { code: blocker } }, now, state, sourceVersion }).state;
  }
  return { op: "manual", reason: state.manualReason, sourceVersion: state.sourceVersion ?? sourceVersion, attempts: Number(state.attempts) || 0,
    manualSince: state.manualSince ?? now, firstFailedAt: state.firstFailedAt ?? now, lastAttemptAt: state.lastAttemptAt ?? null,
    nextAttemptAt: now, detail: { ...(state.detail || {}), cleared: true } };
}
