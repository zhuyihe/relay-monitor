// 每日利润页用到的几个按钮名和链接：按钮名（§3.5）都从 lib/workflow-actions.js 取。不含 JSX。
// 对账表自己的写法在 profit-format.ts。
import { workflowAction, workflowActionMeta } from "../../../lib/workflow-actions";

const actionLabel = (kind: string) => workflowActionMeta(kind)!.label;
export const RECON_BUTTONS = Object.freeze({ refresh: actionLabel("refresh"), retry: actionLabel("retry_bill"), setup: actionLabel("setup_own_station") });
// 「去设置」去哪：和需处理里的那个按钮同一个地址
export const SETUP_HREF = workflowAction("setup_own_station").href!;
