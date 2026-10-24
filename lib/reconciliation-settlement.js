// 结账判定：一条绑定的某段窗口「这天该不该结」，只在这里判断。纯函数，服务端、页面都能用（不引 node 专用模块）。
// - 等待期：上游账单在自然日结束后还会陆续入账，结束满 RECONCILIATION_SETTLE_DELAY_MS（15 分钟）才算可结账。
// - 取数前（precheck）：只看窗口和绑定，不发请求——要不要先读已固定的账、轮询要不要去结。
// - 取数后（outcome）：拿到结果后决定写账本（单日）、写确认快照（多日），还是只记观测。
// - 重试间隔（SETTLE_RETRY_STEPS_MS）：结账没成，隔多久再试。
// 「整天」「哪天的账」用 lib/business-time.js 的 billDayOf，「过完没有」用同一处的 isCompletedBillingWindow。
// 整条导入链里不能有 node: 模块（有守护测试）。
import { RECONCILIATION_SETTLE_DELAY_MS, reconciliationAccountingStart } from "./reconciliation-contract.js";
import { billDayOf, isCompletedBillingWindow } from "./business-time.js";

export { RECONCILIATION_SETTLE_DELAY_MS };

// 结账没成时隔多久再试，按第几次没成排，超出的用最后一档。现在只有一档（10 分钟）；C 改成 10 分、30 分、2 时、6 时
export const SETTLE_RETRY_STEPS_MS = Object.freeze([10 * 60000]);

export function settleRetryDelayMs(failures = 1) {
  return SETTLE_RETRY_STEPS_MS[Math.min(Math.max(failures, 1), SETTLE_RETRY_STEPS_MS.length) - 1];
}

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

// 取数前，只看窗口和绑定，不发请求：
//   readSettled：先读已固定的账，读到就直接用（不是重结、而且时间上能结）
//   due：轮询要不要去结这段窗口——时间上能结、整天不在开始统计之前、上次没结成而且到了重试时刻（attempt 是进程里记下的上次结果）
//   单日的写账本、多日的写确认快照，见 outcome
export function settlementPrecheck({ rule = null, window, now = Date.now(), resettle = false, attempt = null }) {
  const settleable = isSettleableWindow(window, now);
  // 旧规则没有开始统计的时刻时，按建绑定的时刻算
  const start = rule ? reconciliationAccountingStart(rule) ?? Date.parse(rule.createdAt) : NaN;
  const beforeStart = Number.isFinite(start) && start >= window.endMs;
  const waiting = !!attempt && (attempt.settled || now < attempt.retryAt);
  return { settleable, readSettled: !resettle && settleable, due: settleable && !beforeStart && !waiting };
}

// 取数后：毛利算出来了、不是开始统计之前、时间上能结，才结。单个自然日记进账本，多日窗口写确认快照；其余只记观测
export function settlementOutcome({ window, result, now = Date.now() }) {
  const settled = result?.calculation?.profitUsd != null && !result.scope?.notEffective && isSettleableWindow(window, now);
  const ledger = settled && !!billDayOf(window);
  return { settled, ledger, confirmedSnapshot: settled && !ledger };
}
