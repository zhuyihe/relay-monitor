export const RECONCILIATION_BILLING_SOURCE = "channel-log-stat";
export const RECONCILIATION_CALCULATION_VERSION = 3;

// 截至查询时刻的窗口（今天、近 7 天、本月）：起点固定、终点随查询时刻后移，同一起点的记录算同一窗口。
// 放在这里而不是 reconciliation-snapshot.js：那个模块引用了 node:crypto，客户端（核算页轮询）不能引入。
const LIVE_RECONCILIATION_PRESETS = Object.freeze(["today", "7d", "month"]);
// 上游账单在自然日结束后还会陆续入账，结束满这么久才结账；没满之前这天还算实时。
export const RECONCILIATION_SETTLE_DELAY_MS = 15 * 60000;
export function isLiveReconciliationPreset(preset) {
  return LIVE_RECONCILIATION_PRESETS.includes(preset);
}

// 每个系统码在界面上怎么说：唯一来源是 design/ui-copy-spec.md §5，码本身不上界面。
// kind 决定这天显示成哪种状态（§4）：
//   action  需处理：不处理就算不准。title 是标题，detail 是说明。
//   reading 读取类：系统会自己重读。今天和过去 7 天内显示「实时」加 hint；过了 7 天还没读到，才按 title 变成需处理。
//   hint    提示类：不改变状态。hint 是一句提示，tag 是渠道名旁的小标签，ratio 写在倍率格里；display: false 不显示。
// 文案里的 {time} {start} {channel} 由调用方填，填不上时用 plain 那一句。
// action 是按钮对应的动作，见 lib/workflow-actions.js。
// push 表示会推送提醒：A3 统一推送规则之前，仍只推送原来这几种。
// 「去回答」问的那一句，问题标题和填写处的问题共用（§5.2）。
export const COVERAGE_QUESTION = "这把 Key 还给别处用吗？";
// 旧码和以前的每日记录里没读全的一天，都说这一句（§5.5）。
export const INCOMPLETE_DAY_TEXT = "这天的数据不完整";
const UNFINISHED = Object.freeze({ kind: "reading", hint: INCOMPLETE_DAY_TEXT, title: INCOMPLETE_DAY_TEXT, action: "retry_bill" });
const OWNER_UNVERIFIED = Object.freeze({ kind: "action", title: "还没确认这把 Key 属于哪个上游账号", detail: "测试读取一次就好", action: "verify_identity" });
const ISSUES = Object.freeze({
  KEY_INVALID_OR_DENIED: { kind: "action", title: "上游拒绝读取这把 Key", detail: "Key 可能已被删除，或上游的登录信息过期了", action: "update_authorization", push: true },
  SOURCE_BINDING_UNCONFIRMED: { kind: "action", title: "上游账号或自营站点有变化", detail: "确认这条绑定还对应原来的账号和渠道，利润才会接着算", action: "review_source" },
  COST_OWNER_UNVERIFIED: OWNER_UNVERIFIED,
  LEGACY_IDENTITY_UNVERIFIED: OWNER_UNVERIFIED,
  UPSTREAM_CAPABILITY_UNVERIFIED: { kind: "action", title: "还没确认能读到这个上游的完整账单", detail: "测试读取一次就好", action: "verify_capability" },
  BILLING_TIMEZONE_UNVERIFIED: { kind: "action", title: "还没确认这个上游按哪个时区算一天", detail: "测试读取一次就好", action: "verify_capability" },
  CANONICAL_KEY_CONFLICT: { kind: "action", title: "这把 Key 绑了两次", detail: "同一把 Key 的上游成本只能算一次，去掉多余的那条", action: "review_conflict" },
  DUPLICATE_CHANNEL_ASSIGNMENT: { kind: "action", title: "渠道「{channel}」同时绑了两把 Key", plain: "有渠道同时绑了两把 Key", detail: "同一个渠道的收入只能算一次，去掉多余的那条", action: "review_conflict" },
  COST_COVERAGE_UNKNOWN: { kind: "action", title: COVERAGE_QUESTION, detail: "别处也在用的话，上游成本会算多；回答之前，利润先不算", action: "confirm_coverage" },

  PENDING: { kind: "reading", hint: "读取中", title: "这天的账单一直没读到", action: "retry_bill" },
  WAITING_FOR_BILL: { kind: "reading", hint: "这天的账单还没读全", title: "这天的账单一直没读全", action: "retry_bill" },
  UPSTREAM_DATA_UNAVAILABLE: { kind: "reading", hint: "上游暂时读不到，系统会自动再读", title: "上游这天的用量记录一直读不到", action: "retry_bill", push: true },
  OWN_BILLING_UNAVAILABLE: { kind: "reading", hint: "自营站点暂时读不到，系统会自动再读", title: "自营站点这天的收费记录一直读不到", action: "retry_bill", push: true },
  // 上游、自营站点哪一侧都可能对不上，不写「上游」
  BILLING_WINDOW_MISMATCH: { kind: "reading", hint: "读到的日期和这天对不上，系统会再读", title: "读到的日期一直和这天对不上", action: "retry_bill" },
  UPSTREAM_EMPTY_WITH_SALES: { kind: "reading", hint: "有收入，但上游的用量还没到", title: "有收入，但上游一直没有用量记录", detail: "可能绑错了 Key", action: "edit_binding" },
  PERSISTENCE_FAILED: { kind: "reading", hint: "这次结果没存上，系统会再存", title: "这天的结果一直没存上", action: "retry_bill", push: true },
  // 现在不会再产生的旧码（§5.5）：以前的数据里还带着时，统一说这天的数据不完整。
  STALE: UNFINISHED,
  GROUP_OR_RATIO_CHANGED: UNFINISHED,
  BILLING_WINDOW_UNCONFIRMED: UNFINISHED,
  OWN_FLOW_INCOMPLETE: UNFINISHED,

  READY: { kind: "hint", display: false },
  ROUTE_TRANSITION_DETECTED: { kind: "hint", hint: "倍率在 {time} 变了，这天分两段算", plain: "倍率变了，这天分两段算" },
  SEGMENT_TIMING_UNCONFIRMED: { kind: "hint", hint: "倍率变化的时间是系统估的", action: "correct_timing" },
  BILLING_SCOPE_NOT_EFFECTIVE: { kind: "hint", hint: "从 {start} 开始统计", plain: "还没开始统计" },
  SALES_CHANNEL_MISSING: { kind: "hint", tag: "已删除", hint: "渠道「{channel}」在自营站点里已删除，不用了就从绑定里去掉", plain: "有渠道在自营站点里已删除，不用了就从绑定里去掉", action: "edit_binding", push: true },
  SALES_CHANNEL_DISABLED: { kind: "hint", tag: "已停用" },
  SALES_CHANNEL_STATE_UNKNOWN: { kind: "hint", display: false },
  GROUP_DATA_UNAVAILABLE: { kind: "hint", ratio: "暂时读不到" },
});

// 同一条绑定有多个问题时，只露出最靠前的一条；服务端的 health.code 也按这个顺序取。
// 先排要人动手的（§5.2），再排读取类（§5.3），最后排提示类（§5.4），和页面上「需处理优先」一致（§4）。
// 现在不会再产生的旧码排在读取类末尾，以前的数据里还带着时照样能排上。
export const RECONCILIATION_ISSUE_PRIORITY = Object.freeze([
  "KEY_INVALID_OR_DENIED", "LEGACY_IDENTITY_UNVERIFIED", "SOURCE_BINDING_UNCONFIRMED", "COST_OWNER_UNVERIFIED", "CANONICAL_KEY_CONFLICT",
  "DUPLICATE_CHANNEL_ASSIGNMENT", "BILLING_TIMEZONE_UNVERIFIED", "UPSTREAM_CAPABILITY_UNVERIFIED", "COST_COVERAGE_UNKNOWN",
  "BILLING_WINDOW_MISMATCH", "WAITING_FOR_BILL", "UPSTREAM_DATA_UNAVAILABLE", "OWN_BILLING_UNAVAILABLE", "PERSISTENCE_FAILED",
  "UPSTREAM_EMPTY_WITH_SALES", "PENDING", "STALE", "GROUP_OR_RATIO_CHANGED", "BILLING_WINDOW_UNCONFIRMED", "OWN_FLOW_INCOMPLETE",
  "SALES_CHANNEL_MISSING", "SALES_CHANNEL_DISABLED", "SALES_CHANNEL_STATE_UNKNOWN", "GROUP_DATA_UNAVAILABLE",
  "ROUTE_TRANSITION_DETECTED", "SEGMENT_TIMING_UNCONFIRMED", "BILLING_SCOPE_NOT_EFFECTIVE", "READY",
]);
// 表里没有的码（§5.5 兜底）：按需处理显示「这条暂时算不出利润」和「刷新」；码只写进浏览器控制台。
const UNKNOWN_ISSUE = Object.freeze({ kind: "action", title: "这条暂时算不出利润", action: "refresh", known: false });

export const RECONCILIATION_ISSUE_CODES = Object.freeze(Object.keys(ISSUES));

export function reconciliationIssue(code) {
  // 只认表里自己的键：constructor、toString 这类原型链上的名字按不认识的码处理
  const entry = Object.hasOwn(ISSUES, code) ? ISSUES[code] : null;
  const priority = RECONCILIATION_ISSUE_PRIORITY.indexOf(code);
  return { ...(entry || UNKNOWN_ISSUE), code: String(code || ""), known: !!entry, priority: priority < 0 ? Infinity : priority, push: entry?.push === true };
}

// 填文案里的 {time} {start} {channel}；有一个填不上就用 plain，plain 也没有就不显示（返回空串）。
export function fillIssueCopy(text, plain, params = {}) {
  if (!text) return "";
  let missing = false;
  const filled = text.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    if (value == null || value === "") { missing = true; return ""; }
    return String(value);
  });
  return missing ? plain || "" : filled;
}

// 服务端 health.label：只是一句给人看的话，界面不再读它，推送在 A3 改用同一张表之前沿用。
export function reconciliationIssueLabel(code) {
  const issue = reconciliationIssue(code);
  if (issue.kind === "reading") return issue.hint;
  if (issue.kind === "hint") return issue.display === false ? "" : issue.plain || fillIssueCopy(issue.hint, "", {}) || issue.tag || issue.ratio || "";
  return issue.plain || issue.title;
}

// 渠道列表里的状态（§5.6）。键是 deriveKnownChannelCoverage 给出的 status。
const CHANNEL_STATUS = Object.freeze({
  accounted: { label: "已算进利润", counted: true },
  unlinked: { label: "没绑定", action: "connect_channels" },
  not_effective: { label: "从 {start} 开始统计", plain: "还没开始统计" },
  duplicate: { label: "需处理", needsAction: true },
  source_unverified: { label: "需处理", needsAction: true },
  coverage_unknown: { label: "需处理", needsAction: true },
  billing_missing: { label: "还在读取" },
  monitor_only: { label: "只看余额" },
  unsupported: { label: "读不到账单" },
});

// issues 是渠道上的问题码：「需处理」时 reason 取最要紧的一条要处理的问题（§5.2），其余状态为空串。
export function reconciliationChannelStatus(status, params = {}, issues = []) {
  const entry = CHANNEL_STATUS[status] || { label: "需处理", needsAction: true };
  const issue = entry.needsAction ? issues.map(reconciliationIssue).filter((item) => item.kind === "action").sort((a, b) => a.priority - b.priority)[0] : null;
  return { ...entry, label: fillIssueCopy(entry.label, entry.plain, params) || entry.label, reason: issue ? fillIssueCopy(issue.title, issue.plain, params) : "" };
}

// 渠道汇总一句（§5.6）：「5 个渠道里 4 个已算进利润」，都算进了写「5 个渠道都已算进利润」；没有渠道时为空。
export function reconciliationCoverageText(coverage) {
  const known = Number(coverage?.knownChannelCount), accounted = Number(coverage?.accountedChannelCount);
  if (!Number.isFinite(known) || known <= 0 || !Number.isFinite(accounted)) return "";
  return accounted >= known ? `${known} 个渠道都已算进利润` : `${known} 个渠道里 ${accounted} 个已算进利润`;
}

// 「这把 Key 还给别处用吗？」的回答（§5.2「去回答」）：上游账单的改绑定、渠道绑定和接口校验共用这一张表。
// value 对应 CoverageDeclaration 的 answer 和 otherUse；只有 none 算「只给这些渠道用」，别的回答都先不算利润。
export const COVERAGE_ANSWERS = Object.freeze([
  { value: "none", answer: "none", otherUse: null, label: "只给这些渠道用" },
  { value: "own_channels", answer: "other_use", otherUse: "own_channels", label: "自营站点的其他渠道也在用" },
  { value: "external", answer: "other_use", otherUse: "external", label: "站外也在用（测试、自用、给别人）" },
  { value: "unspecified", answer: "other_use", otherUse: "unspecified", label: "别处也在用，说不清是哪" },
  { value: "unknown", answer: "unknown", otherUse: null, label: "不确定" },
]);

// 一份回答在表里的那一项；answer 为 other_use 时按 otherUse 找，没有 otherUse 的按「说不清是哪」。
export function coverageAnswerOption(declaration) {
  const answer = declaration?.answer;
  if (answer === "other_use") return COVERAGE_ANSWERS.find((item) => item.otherUse === (declaration.otherUse || "unspecified")) || null;
  return COVERAGE_ANSWERS.find((item) => item.answer === answer && item.otherUse === null) || null;
}

// 选中的一项 → 要保存的回答；「自营站点的其他渠道也在用」时带上是哪几个渠道。
export function coverageDeclarationOf(value, uncoveredOwnChannelIds = []) {
  const option = COVERAGE_ANSWERS.find((item) => item.value === value);
  if (!option) return null;
  return { answer: option.answer, otherUse: option.otherUse,
    uncoveredOwnChannelIds: option.otherUse === "own_channels" ? [...new Set(uncoveredOwnChannelIds.map(Number))] : [] };
}

export function isCurrentReconciliationBillingContract(source) {
  const billingSource = source?.billingSource ?? source?.downstream?.billingSource;
  const calculationVersion = Number(source?.calculationVersion ?? source?.downstream?.calculationVersion);
  return billingSource === RECONCILIATION_BILLING_SOURCE
    && calculationVersion === RECONCILIATION_CALCULATION_VERSION;
}

// 早期的成功记录只存了 differenceUsd：健康为 READY 时它就是毛利，否则只是参考差额。
export function normalizeSuccessfulResult(result, healthCode) {
  const calculation = result?.calculation;
  if (!calculation || calculation.profitUsd !== undefined || calculation.riskDifferenceUsd !== undefined) return result;
  const differenceUsd = calculation.differenceUsd ?? null;
  const confirmed = (result.health?.code || healthCode) === "READY" && differenceUsd != null;
  return {
    ...result,
    calculation: {
      ...calculation,
      profitUsd: confirmed ? differenceUsd : null,
      riskDifferenceUsd: confirmed ? null : differenceUsd,
      marginRate: confirmed ? calculation.marginRate ?? null : null,
    },
  };
}

// next-complete-day 是旧版"次日零点生效"的规则；immediate 是确认即生效的新规则。两者都按 Key 整体取数、带完整来源声明。
export function isScopedBillingPolicy(policy) {
  return policy === "next-complete-day" || policy === "immediate";
}

// 核算起点：关联最早开始计账的时刻。修改关联不会推迟起点（过渡期按新配置重算修改之前的时段），
// 旧版次日生效规则也从创建时刻起算。
export function reconciliationAccountingStart(rule) {
  if (!isScopedBillingPolicy(rule?.billingPolicy)) return null;
  const candidates = [rule.billingEffectiveFrom, Date.parse(rule.createdAt)].filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : null;
}
