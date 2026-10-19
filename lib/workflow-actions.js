// 按钮只在这里定义：按钮名、完成提示、去哪处理（design/ui-copy-spec.md §3.5）。
// 每日利润、上游账单和运营总览的事项都用 workflowAction 生成；标题和说明按问题码取 §5.2–§5.4 的文案，
// 不是由某个问题引出的事项（例如渠道还没绑定）用这里的默认标题。报错的下一步按钮（§8.2）也从这里取按钮名。
//
// order：进运营总览「需要处理」时的先后，越小越靠前；没有 order 的不进总览。urgent：按紧急显示。
import { fillIssueCopy, reconciliationIssue } from "./reconciliation-contract.js";

// 换 Key、解除绑定、改绑定之后都会说的一句：以前算好的每日记录不会动
export const HISTORY_KEPT = "以前的每日记录还在";

const ACTIONS = Object.freeze({
  update_authorization: { label: "更新登录信息", done: "已更新登录信息", order: 0, urgent: true,
    title: "登录信息不对或过期了", detail: "更新之后才能接着读取余额和账单" },
  review_conflict: { label: "处理重复", done: "已处理", order: 0, urgent: true, code: "CANONICAL_KEY_CONFLICT" },
  review_source: { label: "去确认", done: "已确认", order: 0, urgent: true, code: "SOURCE_BINDING_UNCONFIRMED" },
  verify_identity: { label: "测试读取", order: 1, code: "COST_OWNER_UNVERIFIED" },
  verify_capability: { label: "测试读取", order: 1, code: "UPSTREAM_CAPABILITY_UNVERIFIED" },
  confirm_coverage: { label: "去回答", done: "已保存", order: 2, code: "COST_COVERAGE_UNKNOWN" },
  retry_bill: { label: "重新读取", done: "已重新读取", order: 2, code: "WAITING_FOR_BILL" },
  edit_binding: { label: "改绑定", done: "已保存", order: 2, code: "UPSTREAM_EMPTY_WITH_SALES" },
  connect_channels: { label: "去绑定", done: "已绑定，从现在开始算利润", order: 3,
    title: "有 {count} 个渠道还没绑定", plain: "有渠道还没绑定", detail: "绑定之后才能算这些渠道的利润" },
  inspect_balance: { label: "查看余额" },
  pause_monitor: { label: "暂停监控", done: "已暂停监控，绑定照常算利润" },
  resume_monitor: { label: "恢复监控", done: "已恢复监控" },
  correct_timing: { label: "改时间", done: "已修改，受影响的日子已重算" },
  refresh: { label: "刷新", done: "已刷新" },
  swap_key: { label: "换 Key", done: `已换成新 Key，旧 Key ${HISTORY_KEPT}` },
  unbind: { label: "解除绑定", done: `已解除绑定，${HISTORY_KEPT}` },
  delete_upstream: { label: "删除上游", done: "已删除" },
  view_detail: { label: "查看详细原因" },
  setup_own_station: { label: "去设置" },
  open_history: { label: "以前的每日记录" },
});

// 「测试读取」的结果一句（§3.5）：能读到余额写金额，确认了账单写「能读到账单」，只确认连得上（没重新读余额）写「能读到这个上游」，
// 读不到写归类后的原因（§8.2）。
/** @param {{ ok?: boolean, balance?: string, bill?: boolean, reason?: string }} [input] */
export function testReadText({ ok, balance = "", bill = true, reason = "" } = {}) {
  if (!ok) return `读不到：${reason || "操作没完成，请稍后再试"}`;
  return balance ? `能读到余额 ${balance}` : bill ? "能读到账单" : "能读到这个上游";
}

// 从待办点进来时，那一条已经变了或不在了（§8.1）
export const DESTINATION_CHANGED = "这条已经变了，刷新后再看。";

// 跳转地址：页面和页面上认得的 action 参数（lib/client.ts readWorkflowDestination）。没有地址的动作在当前页面上完成。
// 缺了要用的参数时不生成打不开的地址：处理重复、改绑定没有 ruleId 就打开这个上游，重新读取没有日期就只打开每日利润页。
const byRule = (action, v) => v.ruleId ? { action, ruleId: v.ruleId } : { stationId: v.stationId };
const ROUTES = {
  update_authorization: (v) => ["/stations", { action: "authorization", ...(v.accountKey ? { accountKey: v.accountKey } : { stationId: v.stationId }) }],
  review_conflict: (v) => ["/stations", byRule("conflict", v)],
  review_source: (v) => ["/stations", { action: "source", ownStationId: v.ownStationId }],
  verify_identity: (v) => ["/stations", { action: "verify", stationId: v.stationId }],
  verify_capability: (v) => ["/stations", { action: "verify-billing", stationId: v.stationId }],
  confirm_coverage: (v) => ["/stations", { action: "coverage", ruleId: v.ruleId }],
  retry_bill: (v) => ["/reconciliation", v.window ? { action: "retry", ruleId: v.ruleId, startMs: v.window.startMs, endMs: v.window.endMs, timezone: v.window.timezone } : {}],
  edit_binding: (v) => ["/stations", byRule("scope", v)],
  connect_channels: (v) => ["/stations", { action: "connect", ownStationId: v.ownStationId, channelIds: v.channelIds.join(",") }],
  inspect_balance: (v) => ["/stations", v.stationId ? { stationId: v.stationId } : { accountKey: v.accountKey }],
  setup_own_station: () => ["/stations", {}],
};

export const WORKFLOW_ACTION_KINDS = Object.freeze(Object.keys(ACTIONS));

// 只认表里自己的键：constructor、toString 这类原型链上的名字不算动作
const actionOf = (kind) => Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind] : null;

export function workflowActionMeta(kind) {
  return actionOf(kind);
}

// 进运营总览「需要处理」的动作，和它们的先后、是否紧急。
export function workflowTodo(kind) {
  const entry = actionOf(kind);
  return entry && Number.isInteger(entry.order) ? { order: entry.order, urgent: entry.urgent === true } : null;
}

// 空的参数不写进地址：「ruleId=」这样的地址打开就是页面已过期
function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null && value !== "") search.set(key, String(value));
  return search;
}

// 一个事项：kind 决定按钮和去处，target 指向要处理的上游、绑定或渠道；code 是引出它的问题码，用来取标题和说明。
export function workflowAction(kind, target = {}, { code = null, params = {} } = {}) {
  const entry = actionOf(kind);
  if (!entry) throw new TypeError(`unknown workflow action: ${kind}`);
  const value = { accountKey: null, stationId: null, ruleId: null, ownStationId: null, channelIds: [], window: null, ...target };
  const channelIds = [...new Set((value.channelIds || []).map(Number))].sort((a, b) => a - b);
  const window = value.window ? { startMs: value.window.startMs, endMs: value.window.endMs, timezone: value.window.timezone } : null;
  const issue = reconciliationIssue(code || entry.code || "");
  const copy = !(code || entry.code) ? entry : issue.kind === "hint" ? { title: issue.hint, plain: issue.plain }
    : { title: issue.title, plain: issue.plain, detail: issue.detail };
  // 没有渠道时不写「有 0 个渠道」，用不带数字的那一句
  const fill = { ...(channelIds.length ? { count: channelIds.length } : {}), ...params };
  const route = ROUTES[kind]?.({ ...value, channelIds, window });
  const id = [kind, value.accountKey, value.stationId, value.ruleId, value.ownStationId, channelIds.join(","),
    window ? `${window.startMs}-${window.endMs}` : ""].map((part) => part ?? "").join(":");
  const search = route ? query(route[1]).toString() : "";
  return { id, kind, label: entry.label, title: fillIssueCopy(copy.title, copy.plain, fill), detail: copy.detail || "",
    accountKey: value.accountKey, stationId: value.stationId, ruleId: value.ruleId, ownStationId: value.ownStationId,
    channelIds, window, ...(code ? { code } : {}), href: route ? `${route[0]}${search ? `?${search}` : ""}` : null };
}
