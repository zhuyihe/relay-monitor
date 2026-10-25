// 结账判定：一条绑定的某段窗口「这天该不该结」，只在这里判断。纯函数，服务端、页面都能用（不引 node 专用模块）。
// - 等待期：上游账单在自然日结束后还会陆续入账，结束满 RECONCILIATION_SETTLE_DELAY_MS（15 分钟）才算可结账。
// - 取数前（precheck）：只看窗口、绑定和状态表那一行，不发请求——要不要先读已固定的账、轮询要不要去结、为什么不结。
// - 取数后（outcome）：拿到结果后决定写账本（单日）、写确认快照（多日），还是只记观测；状态表那一行删掉、记重试还是记要人处理。
// - 重试间隔（settleRetryDelayMs）：结账没成，隔多久再试。
// - 回看：自动结账只回看结束 7 天以内的日子（SETTLE_LOOKBACK_MS），页面上「过了 7 天还没读到」也按这一个算（计划 C2a）。
// 「整天」「哪天的账」用 lib/business-time.js 的 billDayOf，「过完没有」用同一处的 isCompletedBillingWindow。
// 整条导入链里不能有 node: 模块（有守护测试）。
import { RECONCILIATION_SETTLE_DELAY_MS, reconciliationAccountingStart, reconciliationIssue } from "./reconciliation-contract.js";
import { billDayOf, dayKeyInTz, dayStartInTz, isCompletedBillingWindow, shiftDayLabel } from "./business-time.js";

export { RECONCILIATION_SETTLE_DELAY_MS };

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// 自动结账回看多久：结束满 7 天还没结成就不再自动试，只能手动；页面上读取类的问题过了这么久也变成需处理（§4）
export const SETTLE_LOOKBACK_MS = 7 * DAY;
// 结账没成时隔多久再试，按「从开始退避起过了多久」排：先 10 分钟，10 分钟以后 30 分钟，再往后一直 2 小时（总指挥 10-25 定，最高一档 2 小时）
export const SETTLE_RETRY_STEPS_MS = Object.freeze([10 * MINUTE, 30 * MINUTE, 2 * HOUR]);
// 昨天例外：结束后的头 6 小时里每 10 分钟试一次，日报和「昨天」最常被看，不能因为退避变慢
export const SETTLE_FAST_RETRY_WINDOW_MS = 6 * HOUR;
export const SETTLE_FAST_RETRY_MS = 10 * MINUTE;
// 回看每轮最多补几个「绑定×天」（昨天不算，全部绑定合起来算，不按上游分开）：和每轮最多 K = ⌈绑定数 ÷ 2⌉、20 秒时间上限取最小的那个。
// 积压很多时（比如 80 条绑定都挂了 3 天）不一轮打完，新的日子先补，剩下的下一轮接着补（审核 C2a 积压场景：不设上限时第 1 轮对外请求 +171%）
export const SETTLE_LOOKBACK_MAX_PER_ROUND = 15;
// 保险值：自动试满这么多次就停，防程序出错。按「10 分、30 分、之后每 2 小时」算，7 天里昨天最多约 118 次
// （头 6 小时每 10 分钟 36 次，之后 2 次短的，再到第 7 天结束约 80 次 2 小时的）；上线时积压、第一次试就已经过了一天的日子约 70 次；
// 保险值 130 比最多的还多一点，只在程序出错时才会碰到
export const SETTLE_MAX_AUTO_ATTEMPTS = 130;

// 结账没成，下次什么时候再试：结束后头 6 小时每 10 分钟；之后按「退避开始后过了多久」选档，不按失败次数
// （审核 C2a 第二轮低-1：头 6 小时里失败次数不满 36 次时，按次数会过了 6 小时还一直按 10 分钟试）。
// 退避从 max(结束后满 6 小时, 这天第一次失败的时刻) 起算：昨天是头 6 小时过完那一刻，回看发现得晚的日子是发现那一刻。
// 第一个参数（失败次数）不再用，留着是调用的人不用改
export function settleRetryDelayMs(failures = 1, { window = null, now = Date.now(), firstFailedAt = null } = {}) {
  const endMs = window?.endMs;
  if (Number.isFinite(endMs) && now - endMs < SETTLE_FAST_RETRY_WINDOW_MS) return SETTLE_FAST_RETRY_MS;
  const from = Math.max(Number.isFinite(endMs) ? endMs + SETTLE_FAST_RETRY_WINDOW_MS : -Infinity, Number.isFinite(firstFailedAt) ? firstFailedAt : now);
  const since = now - from;
  let threshold = 0;
  for (const step of SETTLE_RETRY_STEPS_MS.slice(0, -1)) {
    threshold += step;
    if (since < threshold) return step;
  }
  return SETTLE_RETRY_STEPS_MS.at(-1);
}

// 要人处理的日子不发请求，每隔这么久在本地重判一次（配置变了马上重判）
export const SETTLE_MANUAL_RECHECK_MS = 10 * MINUTE;
// 时间上能不能结：两端都是 0 点，而且结束满等待期（单日、多日都一样）
export function isSettleableWindow(window, now = Date.now()) {
  return isCompletedBillingWindow(window, now - RECONCILIATION_SETTLE_DELAY_MS);
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
//   现在没有任何码标了 persists，R2（你站关了消费日志那几天一直是需处理、不固定）会加第一个——留着这个分支，不等 R2 再加回来
export function reasonKindOf(code) {
  const issue = reconciliationIssue(code);
  if (issue.persists === true) return "sticky";
  return issue.known && issue.kind === "reading" ? "retry" : "manual";
}

// 取数前，只看窗口、绑定和状态表那一行（state），不发请求：
//   readSettled：先读已固定的账，读到就直接用（不是重结、而且时间上能结）
//   due：要不要去结这段窗口；action 是为什么（结账轮询、页面三态、E 的清单都按它）：
//     due 该结了；not_settleable 还没过完（含等待期）；not_effective 整天在开始统计之前；settled 账本里已经有这天；
//     blocked 回看遇到改绑定之前还没固定的日子，D3 做好以前先不自动结（见下面 scopeEditedAt）；
//     beyond_lookback 结束满 7 天、自动不再试；backoff 没到下次重试的时刻；manual 要人处理、还没到重判的时刻；
//     recheck 要人处理、到了重判的时刻：不发请求，拿这一轮读到的目录和身份在本地重判（settleDue），原因没了才记 cleared、下一轮去结；
//     sticky 不会自己消失的原因；exhausted 自动试满保险值
//   有重结请求（state.resettleRequestedAt）时不看「已固定」，照样去结；请求后 7 天还不成就放弃（beyond_lookback）。
//   手动（origin: "manual"）只看时间和开始统计：用户点了就去结，不看退避、要人处理和 7 天。
//   ledgerHasDay：账本里有没有这天的任一版（单日窗口才有意义）；sourceVersion：现在的配置代次，和 state 里记的不同就马上去结
//   （要人处理的、读取类的都一样：改好了凭据不用等退避）。
//   （状态行原因是要人处理类的日子不算 blocked，见下面）
//   recheckNotBefore：要人处理的日子本地重判过、原因没变时不写状态行（原来每 10 分钟写一次），下次重判的时刻单独存（进程里，重启以后
//   最多多判一次），取它和 nextAttemptAt 里晚的那个
//   scopeEditedAt：这条绑定现在这版配置生效的时刻（rule.billingEffectiveFrom，没有就是 null）。回看（不是昨天、不是手动、
//   没有重结请求）遇到还没固定、窗口整个在这个时刻以前的日子，先不自动结（action: "blocked"）：D3 做好「保存时按原设置
//   先固定」之前，回看会直接用改后的配置把这天写进账本，相当于让新设置偷偷改写了旧日子（安全审核 C2a 中-2，总指挥 10-25
//   定）。昨天（window.preset === "yesterday"）、手动「重新读取」、带重结请求的，都不受这条约束
export function settlementPrecheck({ rule = null, window, now = Date.now(), resettle = false, state = null, origin = "auto",
  ledgerHasDay = false, sourceVersion = null, scopeEditedAt = null, recheckNotBefore = null } = {}) {
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
  // 状态行原因是要人处理类的（比如这把 Key 还给别处用吗？没回答）：原来的设置算不出来，回答以后（配置换了代次）放行，按新回答结，
  // 不被挡着（总指挥 10-25，D 设计稿 §3.1 第 2 种）；原来的设置算得出来的日子照旧挡
  const manualBlocked = state?.manualReason != null && reasonKindOf(state.manualReason) === "manual";
  if (!requested && !manualBlocked && window.preset !== "yesterday" && Number.isFinite(scopeEditedAt) && window.endMs <= scopeEditedAt) {
    return decide("blocked");
  }
  const sinceMs = requested ? Number(state?.resettleRequestedAt ?? now) : window.endMs;
  if (now - sinceMs >= SETTLE_LOOKBACK_MS) return decide("beyond_lookback");
  if (!state) return decide("due");
  const changed = sourceVersion != null && state.sourceVersion != null && state.sourceVersion !== sourceVersion;
  if (state.manualReason != null) {
    if (reasonKindOf(state.manualReason) === "sticky") return decide("sticky");
    if (changed || state.detail?.cleared === true) return decide("due");
    // recheckNotBefore：上一次本地重判、原因没变时没写状态行，下次重判的时刻单独记在进程里（planSettlement），和行里的 nextAttemptAt 取晚的
    if (now < Math.max(Number(state.nextAttemptAt), Number(recheckNotBefore) || 0)) return decide("manual");
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
      nextAttemptAt: manual ? Number(state?.nextAttemptAt ?? now) : now + settleRetryDelayMs(attempts + 1, { window, now, firstFailedAt: common.firstFailedAt }) } };
  }
  const since = state?.manualReason != null && state.manualSince != null ? Number(state.manualSince) : now;
  // 本地重判说没有挡路的（cleared），去结却还是要人处理类的原因（不管是不是原来那个）：本地重判看不出它（比如取账单时才知道的），
  // 以后到点直接去结、按退避表计次；已经是这样的行，原因没变也一样
  const blind = kind === "manual" && (state?.detail?.cleared === true || (state?.detail?.probeBlind === true && state.manualReason === reason));
  // 手动结不成、还是这个原因：不动自动的那一套（看不出来的标记、下次时刻、次数都照旧）
  if (blind && manual) {
    return { ...base, state: { op: kind, ...common, detail: { ...common.detail, probeBlind: true }, attempts, manualSince: since,
      nextAttemptAt: state.nextAttemptAt ?? now } };
  }
  if (blind) {
    return { ...base, state: { op: kind, ...common, detail: { ...common.detail, probeBlind: true }, attempts: attempts + 1, manualSince: since,
      nextAttemptAt: now + settleRetryDelayMs(attempts + 1, { window, now, firstFailedAt: common.firstFailedAt }) } };
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

// 重结请求（计划 C2b）：改了一段倍率变化的时间以后，[旧时间, 新时间) 落到的每个「已经结束的业务日」都要按新分段重新结，各写一条请求。
// 按绑定自己的时区、按日历天算（纽约切夏令时那天是 23 小时）；还没结束的天不写（以后正常结时已经是新分段）；
// 整天在这条绑定开始统计之前的不写（precheck 会说 not_effective，永远结不了）。返回要写请求的日子（YYYY-MM-DD）。
export const RESETTLE_REASON_TRANSITION = "transition";
export function resettleBillDates(rule, fromMs, toMs, now = Date.now()) {
  const low = Math.min(fromMs, toMs), high = Math.max(fromMs, toMs);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low || !rule?.timezone) return [];
  const start = reconciliationAccountingStart(rule) ?? Date.parse(rule.createdAt);
  const dates = [];
  const last = dayKeyInTz(high - 1, rule.timezone);
  for (let label = dayKeyInTz(low, rule.timezone), guard = 0; label <= last && guard < 4000; label = shiftDayLabel(label, 1), guard += 1) {
    const endMs = dayStartInTz(shiftDayLabel(label, 1), rule.timezone);
    if (endMs > now) continue;
    if (Number.isFinite(start) && start >= endMs) continue;
    dates.push(label);
  }
  return dates;
}
