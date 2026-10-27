// 「以前的每日记录」抽屉和页面共用的几句和几个小函数：按钮名、日期写法、汇率一行、上游名。不含 JSX。
// 用语按 design/ui-copy-spec.md；时间一律按这条绑定算一天的时区显示（lib/format 的 zoned 系列），不用浏览器时区。
// 对账表自己的写法在 profit-format.ts。
import { EMPTY, UPSTREAM_GONE, formatRate, formatZonedWindow } from "../../../lib/format";
import { ERROR_CATEGORIES } from "../../../lib/error-copy";
import { workflowAction, workflowActionMeta } from "../../../lib/workflow-actions";

// 本页的按钮名（§3.5），都从 lib/workflow-actions.js 取
const actionLabel = (kind: string) => workflowActionMeta(kind)!.label;
export const RECON_BUTTONS = Object.freeze({
  refresh: actionLabel("refresh"), retry: actionLabel("retry_bill"), setup: actionLabel("setup_own_station"), history: actionLabel("open_history"),
});

// 以前的每日记录里共用的几句
export const RECON_COPY = Object.freeze({
  incomeSource: (count: number) => `来自自营站点 ${count} 个渠道的收费记录`,
});
// 「去设置」去哪：和需处理里的那个按钮同一个地址
export const SETUP_HREF = workflowAction("setup_own_station").href!;

// 读取失败时存下报错本身（带 code、status），页面再按 lib/error-copy.js 归类；抛出来的是空值时也要算出错
export const caughtError = (err: unknown) => err || new Error(ERROR_CATEGORIES.other.text);

// 汇率一行的正文（§9）：两边一样写一次，不一样分开写；计入固定成本的只看收入；没有的写「—」
export function rateLine(income: any, cost: any, fixedCost = false) {
  const a = formatRate(income), b = formatRate(cost);
  return fixedCost || a === b ? a || EMPTY : `收入按 ${a || EMPTY}，上游成本按 ${b || EMPTY}`;
}

// 一整天「10月9日」，几天「10月1日–10月7日」，今天「10月16日 0:00–14:30」（§6）
export const formatWindow = (window: any) => formatZonedWindow(window);

export function upstreamName(rule: any, upstreams: any) {
  if (!Array.isArray(upstreams)) return "上游账号暂时读不到";
  const station = upstreams.find((item) => String(item.id) === String(rule?.upstreamStationId));
  return station?.name || UPSTREAM_GONE;
}
