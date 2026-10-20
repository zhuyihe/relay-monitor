// 运营总览「需要处理」一行的文字。标题、说明、按钮名都由服务端按 lib/workflow-actions.js 生成好，这里只负责拼起来。
import { NAV_LABELS, STATION_TABS } from "../../lib/brand";
import { BALANCE_STATE_TEXT, formatZonedWindow, soonText } from "../../lib/format";

export function workflowProblem(action: any): string {
  return action?.title || action?.label || "";
}

// 说明后面跟上是哪天（按业务时区，整天只写日期）。
export function workflowDetail(action: any): string {
  const span = action?.window ? formatZonedWindow(action.window) : "";
  return [action?.detail || "", span ? `${span}。` : ""].filter(Boolean).join(action?.detail?.endsWith("。") ? "" : "。");
}

// 事项落在谁身上：上游名优先；按绑定或账号归类的事项用页面名
export function workflowOwner(action: any, nameOf: (id: string) => string | undefined): string {
  if (action.stationId && nameOf(String(action.stationId))) return nameOf(String(action.stationId))!;
  if (action.ownStationId && nameOf(String(action.ownStationId))) return nameOf(String(action.ownStationId))!;
  if (action.accountKey) return "上游账号";
  if (action.href?.startsWith("/reconciliation")) return NAV_LABELS.reconciliation;
  return STATION_TABS.bills;
}

// 合并到同一行里的其余事项，用一句短语交代
export function actionPhrase(action: any): string {
  if (action.workflow) return action.title || action.label;
  switch (action.kind) {
    // 余额这几种用 §3.3 的档位名，和总览的余额行同一份
    case "query-failed":
      return BALANCE_STATE_TEXT.unreadable;
    case "balance-danger":
      return BALANCE_STATE_TEXT.empty;
    case "balance-low":
      return BALANCE_STATE_TEXT.low;
    case "eta-soon":
      return soonText(action.etaDays);
    case "fixed-expiring":
      return `${action.daysRemaining} 天后到期`;
    default:
      return action.label || "";
  }
}
