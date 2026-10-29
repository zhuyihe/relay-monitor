"use client";
// 名字后面的感叹号：问题收进一个小图标，行高不变；悬停一句，点开小气泡（点空白处关）。
// 上游列表（读不到余额，红色）和每日利润（需处理的渠道，橙色）共用这一个：气泡里放什么由调用方给（IssuePop 是现成的版式：标题、说明、更多内容、按钮）。
// 手机上气泡占满屏宽，箭头对着感叹号（样式在 jy.css）。open / onOpenChange 不给时自己管；给了由调用方管（上游列表要据此在气泡开着时不重排）。
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Popover, Tooltip } from "antd";

export type IssueTone = "crit" | "warn";

export function IssuePop({ tone = "crit", title, note, children, actions }: { tone?: IssueTone; title: string; note?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`jy-issue-pop is-${tone}`}>
      <b>{title}</b>
      {note ? <span className="jy-issue-pop-asof">{note}</span> : null}
      {children}
      {actions ? <div className="jy-issue-pop-actions">{actions}</div> : null}
    </div>
  );
}

export function IssueBang({ tone = "crit", tip, label, open, onOpenChange, children }: {
  tone?: IssueTone; tip: string; label?: string; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [bangX, setBangX] = useState(0); // 感叹号的横向中心：手机上气泡占满屏宽，箭头要对着它
  const shown = open ?? innerOpen;
  const change = (next: boolean) => { setInnerOpen(next); onOpenChange?.(next); };
  return (
    <Tooltip title={tip} {...(shown ? { open: false } : {})}>
      <Popover
        trigger="click" placement="bottomLeft" rootClassName="jy-issue-popover" arrow content={children} open={shown} onOpenChange={change}
        styles={{ root: { "--jy-bang-x": `${Math.max(12, bangX - 12 - 6)}px` } as CSSProperties }}
      >
        <button
          type="button" className={`jy-issue-bang is-${tone}`} aria-label={label ?? tip}
          onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setBangX(rect.left + rect.width / 2); }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor" /><rect x="7.1" y="3.6" width="1.8" height="5.8" rx=".9" fill="#fff" /><circle cx="8" cy="11.8" r="1.05" fill="#fff" /></svg>
        </button>
      </Popover>
    </Tooltip>
  );
}
