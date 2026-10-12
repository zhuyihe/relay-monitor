// 账号与账单待办的展示文案：标题说问题、按钮说动作（动作名沿用服务端给的 label），说明里只出现资源名和本地时间。
import { formatDays, formatHhmm, formatMonthDay } from "../../lib/format";

const PROBLEM: Record<string, [string, string]> = {
  verify_identity: ["账号身份未核验", "核验后这个资源的成本才能计入账单核算。"],
  update_authorization: ["账号授权已失效", "更新登录凭据后才能继续读取余额与账单。"],
  verify_capability: ["账单读取能力未核验", "确认这把 Key 能读到用量明细，账单才能按渠道核算。"],
  connect_channels: ["本站渠道尚未接入核算", "接入后这些渠道的消耗会计入成本。"],
  confirm_coverage: ["Key 的用途未确认", "确认这把 Key 只服务已登记的渠道，成本才不会算多。"],
  wait_effective: ["核算规则尚未生效", "生效后会自动开始核算，到时无需操作。"],
  review_source: ["本站来源待核对", "核对本站的收入来源，避免收入记错站点。"],
  retry_bill: ["账单未读取成功", "可以重查该时段的账单。"],
  review_conflict: ["渠道重复归属", "同一渠道归到了多条核算规则，成本会被重复计算。"],
};

export function workflowProblem(kind: string): string {
  return PROBLEM[kind]?.[0] || "有待办事项";
}

// 账单时段：10月9日 00:00 – 10月10日 00:00（按本机时区显示）
export function workflowWindow(window: { startMs: number; endMs: number } | null | undefined): string {
  if (!window) return "";
  const at = (ms: number) => `${formatMonthDay(ms)} ${formatHhmm(ms)}`;
  return `${at(window.startMs)} – ${at(window.endMs)}`;
}

export function workflowDetail(action: any): string {
  const parts = [PROBLEM[action.kind]?.[1] || ""];
  if (action.kind === "connect_channels" && action.channelIds?.length) parts.unshift(`共 ${action.channelIds.length} 个渠道。`);
  const span = workflowWindow(action.window);
  if (span) parts.push(`时段：${span}。`);
  return parts.filter(Boolean).join("");
}

// 待办落在谁身上：资源名优先；按规则或账号归类的待办用通俗的归属名
export function workflowOwner(action: any, nameOf: (id: string) => string | undefined): string {
  if (action.stationId && nameOf(String(action.stationId))) return nameOf(String(action.stationId))!;
  if (action.ownStationId && nameOf(String(action.ownStationId))) return nameOf(String(action.ownStationId))!;
  if (action.accountKey) return "上游账号";
  if (action.href?.startsWith("/reconciliation")) return "账单核算";
  return "账号关系";
}

// 合并到同一行里的其余事项，用一句短语交代
export function actionPhrase(action: any): string {
  if (action.workflow) return action.label;
  switch (action.kind) {
    case "query-failed":
      return "余额查询失败";
    case "balance-danger":
      return "余额已用完";
    case "balance-low":
      return "余额低于提醒线";
    case "eta-soon":
      return `预计 ${formatDays(action.etaDays)}后用完`;
    case "fixed-expiring":
      return `${action.daysRemaining} 天后到期`;
    default:
      return action.label || "";
  }
}
