"use client";
// 「重新检查」按钮（用语规范 §3.5）：自营站点不记收费记录时，点了才马上再读一次自营站点的设置（POST /api/own/consume-log），
// 按钮转圈，结果就地提示：「已经在记收费记录了」或「还是没在记：到自营站点后台打开」。每日利润那几天、需处理列表、利润等式下面三处都用这一个。
// 读完刷新需处理列表（侧栏、运营总览共用的那一份），并发出事件让当前页面重读自己的数据；页面自己重读的传 onDone。
import { useState } from "react";
import { App, Button } from "antd";
import type { ButtonProps } from "antd";
import { api } from "../../lib/client";
import { failureSentence, failureText, ownStationErrorCode } from "../../lib/error-copy";
import { reconciliationIssue } from "../../lib/reconciliation-contract";
import { workflowActionMeta } from "../../lib/workflow-actions";
import { loadWorkflowActions } from "./use-workflow-actions";

export const OWN_CONSUME_LOG_CHECKED = "jy:own-consume-log-checked";
export const RECHECK_TEXT = Object.freeze({ on: "已经在记收费记录了", off: "还是没在记：到自营站点后台打开", failed: "重新检查没成" });

export function RecheckConsumeLogButton({ onDone, ...button }: { onDone?: () => void } & Omit<ButtonProps, "onClick" | "loading" | "href">) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setLoading(true);
    try {
      const result = await api("/api/own/consume-log", { method: "POST" });
      if (result?.status?.state === "on") message.success(RECHECK_TEXT.on);
      else if (result?.status?.state === "off") message.warning(RECHECK_TEXT.off);
      // 令牌读不到设置：不会自己好，说成需处理里那一条同一份说法；读不到：自营站点暂时读不到（不说上游）
      else if (result?.status?.state === "denied") message.warning(failureSentence(RECHECK_TEXT.failed, reconciliationIssue("OWN_OPTION_READ_DENIED").title));
      else message.warning(failureText(RECHECK_TEXT.failed, { code: ownStationErrorCode({ code: result?.status?.code }) }));
    } catch (error) {
      message.error(failureText(RECHECK_TEXT.failed, error));
    } finally {
      setLoading(false);
      void loadWorkflowActions(true);
      window.dispatchEvent(new Event(OWN_CONSUME_LOG_CHECKED));
      onDone?.();
    }
  };
  return <Button size="small" {...button} loading={loading} onClick={() => void run()}>{workflowActionMeta("recheck_consume_log")!.label}</Button>;
}
