"use client";
// 柱状图：自己画的 SVG（坐标算法在 lib/chart-math），一种颜色，数在悬停里。
import { useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { barPath, clamp, niceTicks } from "../../lib/chart-math";
import { ChartTip, TipBody } from "./float-tip";
import { useElementWidth } from "./use-width";

// 柱状图（用户运营抽屉的每天、每小时；上游「余额趋势」弹窗的每天花了多少共用这一份）。一种颜色，柱宽不超过 24px，顶上 4px 圆角、底部平，柱间 2px；最后一根（今天、这个小时）浅色
export function Bars({
  items, valueLabel, tipTitle, tipValue, tickLabel, axis, height = 140, light, label, marker,
}: {
  items: { key: string; cost: number }[];
  // 悬停提示里那一行的名字（「消费」）
  valueLabel: string;
  tipTitle: (key: string, index: number) => string;
  tipValue: (cost: number) => string;
  // 横轴只标头、中、最后一根
  tickLabel: (key: string, index: number) => string;
  axis: (v: number, step: number) => string;
  height?: number;
  // 最后一根浅色
  light?: boolean;
  label: string;
  // 某一根柱子前面画一条灰色竖虚线，顶上写字（「10月20日 加进来」）；在头尾两根上不画
  marker?: { index: number; text: string };
}) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = items.length;
  const values = items.map((item) => item.cost);
  const yt = niceTicks(0, Math.max(0, ...values), 3);
  const Lp = 44, Rp = 8, Tp = 8, Bp = 24;
  const pw = Math.max(1, w - Lp - Rp), slot = pw / Math.max(1, n), bw = Math.min(24, Math.max(2, slot - 2));
  const y = (v: number) => Tp + (1 - v / yt.hi) * (height - Tp - Bp);
  const idx = n ? [...new Set([0, Math.floor((n - 1) / 2), n - 1])] : [];
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    setHover(clamp(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - Lp) / slot), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const d = e.key === "ArrowLeft" ? -1 : 1; setHover((h) => (h == null ? n - 1 : clamp(h + d, 0, n - 1))); }
    else if (e.key === "Escape") setHover(null);
  };
  const hx = hover != null ? Lp + slot * (hover + 0.5) : 0;
  return (
    <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown} onBlur={() => setHover(null)}>
      <div className="jy-chart" style={{ height }}>
        {w > 0 && n > 0 && (
          <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
            <g className="grid">{yt.ticks.map((t) => <line key={t} x1={Lp} x2={w - Rp} y1={y(t)} y2={y(t)} />)}</g>
            {yt.ticks.map((t) => <text key={t} className="tick-label" x={Lp - 6} y={y(t) + 4} textAnchor="end">{axis(t, yt.step)}</text>)}
            {items.map((item, i) => {
              const v = values[i];
              const cx = Lp + slot * (i + 0.5) - bw / 2;
              const topY = y(v);
              return v > 0 ? <path key={item.key} className={`jy-chart-bar${light && i === n - 1 ? " is-light" : ""}${hover === i ? " is-hover" : ""}`} d={barPath(cx, Math.min(topY, y(0) - 1), y(0), bw, 4, true)} /> : null;
            })}
            {marker && marker.index > 0 && marker.index < n - 1 && (
              <g>
                <line className="day-rule" x1={Lp + slot * marker.index} x2={Lp + slot * marker.index} y1={Tp} y2={height - Bp} />
                <text className="tick-label" x={clamp(Lp + slot * marker.index + 4, Lp, w - Rp - 70)} y={Tp + 10}>{marker.text}</text>
              </g>
            )}
            {idx.map((i) => <text key={i} className="tick-label" x={clamp(Lp + slot * (i + 0.5), Lp, w - Rp)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{tickLabel(items[i].key, i)}</text>)}
          </svg>
        )}
      </div>
      {hover != null && (
        <ChartTip x={hx} width={w}>
          <TipBody title={tipTitle(items[hover].key, hover)} rows={[[valueLabel, tipValue(items[hover].cost), "var(--jy-s1)"]]} />
        </ChartTip>
      )}
    </div>
  );
}

