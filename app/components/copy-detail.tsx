"use client";
// 「复制详细原因」按钮（用语规范 §3.5）：把给技术同事看的原文（事项带来的 copyText，开头带站点名和日期）复制到剪贴板，提示「已复制」。
// 复制不成（浏览器不让写剪贴板）就把原文放进提示里，让人自己选中复制，不吞掉。
import { App, Button } from "antd";
import type { ButtonProps } from "antd";
import type { WorkflowAction } from "../../lib/client";
import { workflowActionMeta } from "../../lib/workflow-actions";

export const COPY_DETAIL_TEXT = Object.freeze({ done: workflowActionMeta("copy_detail")!.done as string });

export function CopyDetailButton({ action, ...button }: { action: Pick<WorkflowAction, "label" | "copyText"> } & Omit<ButtonProps, "onClick" | "href">) {
  const { message } = App.useApp();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(action.copyText || "");
      message.success(COPY_DETAIL_TEXT.done);
    } catch {
      message.info(action.copyText || "");
    }
  };
  return <Button size="small" {...button} onClick={() => void copy()}>{action.label}</Button>;
}
