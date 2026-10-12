// 状态标记：形状 + 颜色 + 文字，三者同时出现，不单靠颜色区分。
import type { ReactNode } from "react";
import { Sym } from "./icons";
import type { SymKind } from "./icons";

export type Level = "crit" | "warn" | "good" | "muted" | "info";

const SYM: Record<Level, SymKind> = { crit: "crit", warn: "warn", good: "good", muted: "unknown", info: "info" };

export const LEVEL_LABEL: Record<Level, string> = {
  crit: "紧急",
  warn: "注意",
  good: "正常",
  muted: "未知",
  info: "提示",
};

// 列表排序：紧急 → 注意 → 正常 → 未知
export const LEVEL_ORDER: Record<Level, number> = { crit: 0, warn: 1, info: 2, good: 3, muted: 4 };

export function StatusText({ level, children, className = "" }: { level: Level; children?: ReactNode; className?: string }) {
  return (
    <span className={`jy-status jy-status--${level} ${className}`.trim()}>
      <Sym kind={SYM[level]} />
      {children ?? LEVEL_LABEL[level]}
    </span>
  );
}

export function StatusTag({ level, children }: { level: Level; children?: ReactNode }) {
  return (
    <span className={`jy-tag jy-tag--${level}`}>
      <Sym kind={SYM[level]} />
      {children ?? LEVEL_LABEL[level]}
    </span>
  );
}

export function StatusSym({ level }: { level: Level }) {
  return <Sym kind={SYM[level]} className={`jy-status--${level}`} />;
}

// lib/client.ts 的 statusOf（pending / error / danger / warn / ok）→ 展示等级
export function levelOfStatus(status: string): Level {
  if (status === "error" || status === "danger") return "crit";
  if (status === "warn") return "warn";
  if (status === "ok") return "good";
  return "muted";
}
