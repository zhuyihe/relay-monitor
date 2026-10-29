"use client";
// 报错原文（design/ui-copy-spec.md §8.2）：默认收起，「查看详细原因」展开后是原文和「复制」，标题写「发给技术同事看」。
// 界面上只有这里放原文；原文里的密钥、令牌由服务端打码。
import { useState } from "react";
import { Button } from "antd";
import { describeError } from "../../lib/error-copy.js";

// 界面上的一条报错：text 是归类后的那一句，raw 是原文，只进「查看详细原因」；notice 表示是页面自己的提示，不是接口报错
export type ErrorNote = { text: string; raw?: unknown; notice?: boolean; category?: string };
// 页面自己的提示也用 throw 传出去：带 notice 的原样显示，不再归类
export const notice = (text: string) => Object.assign(new Error(text), { notice: true });
export const noteOf = (err: any): ErrorNote => {
  if (err?.notice) return { text: err.message, notice: true };
  const { text, raw, category } = describeError(err);
  // 原文和归类后的那句一样时（服务端已给出界面上的话），不再放「查看详细原因」
  return { text, raw: raw && raw !== text ? raw : undefined, category };
};

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
