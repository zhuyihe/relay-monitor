"use client";
// 报错原文（design/ui-copy-spec.md §8.2）：默认收起，「查看详细原因」展开后是原文和「复制」，标题写「发给技术同事看」。
// 界面上只有这里放原文；原文里的密钥、令牌由服务端打码。
import { useState } from "react";
import { Button } from "antd";

export function ErrorDetail({ raw }: { raw?: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  };
  return <details className="jy-error-detail">
    <summary>查看详细原因</summary>
    <div className="jy-error-detail__body">
      <strong>发给技术同事看</strong>
      <pre>{text}</pre>
      <Button size="small" onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button>
    </div>
  </details>;
}
