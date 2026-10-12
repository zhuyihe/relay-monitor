"use client";
// 浮动提示：跟随指针，靠近视口边缘时翻到另一侧；键盘聚焦时贴在元素下方。
// 图表内的十字线提示用 ChartTip（相对图表定位），列表和热力图用 useFloatTip。
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, PointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

export type TipRow = [label: ReactNode, value: ReactNode, color?: string];

export function TipBody({ title, rows }: { title: ReactNode; rows: TipRow[] }) {
  return (
    <>
      <div className="t-title">{title}</div>
      {rows.map(([k, v, c], i) => (
        <div className="t-row" key={i}>
          {c && <i className="jy-swatch" style={{ background: c }} />}
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
    </>
  );
}

type TipState = { content: ReactNode; x: number; y: number } | null;

function FloatTip({ content, x, y }: { content: ReactNode; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  });
  return createPortal(
    <div ref={ref} className="jy-tip jy-tip--float" role="tooltip" style={{ left: x + 14, top: y + 14 }}>
      {content}
    </div>,
    document.body,
  );
}

export function useFloatTip() {
  const [tip, setTip] = useState<TipState>(null);
  const hide = useCallback(() => setTip(null), []);
  const bind = useCallback(
    (content: () => ReactNode) => ({
      onPointerMove: (e: PointerEvent) => setTip({ content: content(), x: e.clientX, y: e.clientY }),
      onPointerLeave: hide,
      onFocus: (e: FocusEvent<HTMLElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ content: content(), x: r.left + r.width / 2, y: r.bottom - 6 });
      },
      onBlur: hide,
    }),
    [hide],
  );
  const node = tip ? <FloatTip {...tip} /> : null;
  return { bind, node, hide };
}

// 图表内提示：定位在图表容器内，放不下时翻到十字线左侧
export function ChartTip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tw = el.offsetWidth;
    let left = x + 14;
    if (left + tw > width - 4) left = x - tw - 14;
    el.style.left = `${Math.max(0, left)}px`;
  });
  return (
    <div ref={ref} className="jy-tip" style={{ left: x + 14, top: 8 }} aria-hidden="true">
      {children}
    </div>
  );
}
