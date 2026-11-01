"use client";
// 模型供需抽屉里「每小时缺货失败」的图（design 模型供需 v5 §5）：一个钟点一根柱子，按原因叠色（限流、没钱、故障），没有成交柱、上限线、高峰框。
// 自己画的 SVG（坐标算法在 lib/chart-math）；柱宽不超过 24px、顶上 4px 圆角、层间留缝；数在悬停里。
import { useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { barPath, clamp, niceTicks } from "../../../lib/chart-math";
import { ChartTip, TipBody } from "../../components/float-tip";
import { useElementWidth } from "../../components/use-width";
import { COPY, REASON_ORDER } from "./copy";
import { count } from "./models-format";
import type { LostByReason, LostCause } from "./headroom-types";

// 四种原因的颜色：柱子、图例、上游卡片里同一套（没渠道不是按小时发生的，只出现在表里，不在柱子上）
export const REASON_COLOR = Object.freeze({ rate_limit: "#EB6834", auth_quota: "#E87BA4", upstream: "#8A3FB8", no_channel: "var(--jy-ink-3)" } as Record<LostCause, string>);

export type HourBar = { hour: number; lost: LostByReason };

const L = 44, R = 12, T = 12, B = 26;
const total = (lost: LostByReason) => REASON_ORDER.reduce((sum, reason) => sum + lost[reason], 0);

export function HourlyChart({ bars, height = 200, label }: { bars: HourBar[]; height?: number; label: string }) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = bars.length;
  const top = Math.max(3, ...bars.map((bar) => total(bar.lost)));
  const yt = niceTicks(0, top * 1.05, 4);
  const pw = Math.max(1, w - L - R), slot = pw / Math.max(1, n), bw = Math.min(24, Math.max(2, slot - 4));
  const y = (v: number) => T + (1 - v / yt.hi) * (height - T - B);
  const x = (i: number) => L + slot * i + (slot - bw) / 2;
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    setHover(clamp(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - L) / slot), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const d = e.key === "ArrowLeft" ? -1 : 1; setHover((h) => (h == null ? (d < 0 ? n - 1 : 0) : clamp(h + d, 0, n - 1))); }
    else if (e.key === "Escape") setHover(null);
  };
  const tipRows = (bar: HourBar): [ReactNode, ReactNode, string?][] => REASON_ORDER.filter((reason) => bar.lost[reason] > 0).map((reason) => [COPY.causes[reason], count(bar.lost[reason]), REASON_COLOR[reason]]);
  const hx = hover != null ? L + slot * hover + slot / 2 : 0;
  const hb = hover != null ? bars[hover] : null;
  return (
    <>
      <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown} onBlur={() => setHover(null)}>
        <div className="jy-chart" style={{ height }}>
          {w > 0 && n > 0 && (
            <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
              <g className="grid">{yt.ticks.map((t) => <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} />)}</g>
              {yt.ticks.map((t) => <text key={t} className="tick-label" x={L - 6} y={y(t) + 4} textAnchor="end">{count(t)}</text>)}
              {bars.map((bar, i) => {
                const layers = REASON_ORDER.map((reason): [string, number] => [REASON_COLOR[reason], bar.lost[reason]]).filter(([, value]) => value > 0);
                let acc = 0;
                return (
                  <g key={i} className="jy-hbar-col">
                    {layers.map(([color, value], k) => {
                      const bottom = y(acc) - (k > 0 ? 1 : 0), topY = y(acc + value);
                      acc += value;
                      if (bottom - topY < 0.5) return null;
                      return <path key={k} d={barPath(x(i), topY, bottom, bw, 4, k === layers.length - 1)} style={{ fill: color }} />;
                    })}
                  </g>
                );
              })}
              {bars.map((bar, i) => (i % 3 === 0 ? <text key={i} className="tick-label" x={L + slot * i + slot / 2} y={height - 8} textAnchor="middle">{bar.hour}</text> : null))}
              {hover != null && <line className="cross" x1={hx} x2={hx} y1={T} y2={height - B} />}
            </svg>
          )}
        </div>
        {hb != null && tipRows(hb).length > 0 && (
          <ChartTip x={hx} width={w}>
            <TipBody title={COPY.drawer.hour(hb.hour)} rows={tipRows(hb)} />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">{hb ? `${COPY.drawer.hour(hb.hour)}：${tipRows(hb).map(([k, v]) => `${k} ${v}`).join("，") || "0"}` : ""}</div>
    </>
  );
}

// 图例：有的原因才列
export function ChartLegend({ bars }: { bars: HourBar[] }) {
  const seen = REASON_ORDER.filter((reason) => bars.some((bar) => bar.lost[reason] > 0));
  return (
    <ul className="jy-hlegend">
      {seen.map((reason) => <li key={reason}><i style={{ background: REASON_COLOR[reason] }} />{COPY.causes[reason]}</li>)}
    </ul>
  );
}
