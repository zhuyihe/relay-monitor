"use client";
// 模型供需抽屉里「每小时成交和被挡」的图（design 模型供需 v4 §5）：一个钟点一根柱子，下面钴蓝是成交，上面叠被挡过的，按原因分色（橙：限流，紫：上游故障，粉：没钱或 Key 失效）；
// 一条横线是上限：测到的实线、没测到（只知道至少）的虚线；高峰那几个钟点用虚线框一下写「高峰」。成交和被挡是同一个量（请求数），叠在一张图上，上限是同一单位的参考线，不用双纵轴。
// 自己画的 SVG（坐标算法在 lib/chart-math）；柱宽不超过 24px、顶上 4px 圆角、层间留缝；数在悬停里。
import { useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { barPath, clamp, niceTicks } from "../../../lib/chart-math";
import { ChartTip, TipBody } from "../../components/float-tip";
import { useElementWidth } from "../../components/use-width";
import { COPY, REASON_ORDER } from "./copy";
import { approx, count } from "./models-format";
import type { BlockedByReason, Quantity } from "./models-format";

export const REASON_COLOR = Object.freeze({ rate_limit: "#EB6834", upstream: "#8A3FB8", auth_quota: "#E87BA4", other: "var(--jy-ink-3)" } as Record<keyof BlockedByReason, string>);
const SUCCESS_COLOR = "var(--jy-s1)";

export type HourBar = { hour: number; success: number; blocked: BlockedByReason; notBought?: number };

const L = 44, R = 12, T = 18, B = 26;

export function HourlyChart({ bars, limit, peakHours, height = 200, label }: { bars: HourBar[]; limit: Quantity; peakHours: number[]; height?: number; label: string }) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = bars.length;
  const blockedSum = (bar: HourBar) => REASON_ORDER.reduce((total, reason) => total + bar.blocked[reason], 0);
  const limitValue = limit.value != null && (limit.kind === "measured" || limit.kind === "atLeast") ? limit.value : null;
  const top = Math.max(1, ...bars.map((bar) => bar.success + blockedSum(bar)), limitValue ?? 0);
  const yt = niceTicks(0, top * 1.05, 4);
  const pw = Math.max(1, w - L - R), slot = pw / Math.max(1, n), bw = Math.min(24, Math.max(2, slot - 4));
  const y = (v: number) => T + (1 - v / yt.hi) * (height - T - B);
  const x = (i: number) => L + slot * i + (slot - bw) / 2;
  // 高峰的钟点连着的几根框成一个框（跨午夜时两段各框一个）
  const peakRuns: [number, number][] = [];
  bars.forEach((bar, i) => {
    if (!peakHours.includes(bar.hour)) return;
    const last = peakRuns[peakRuns.length - 1];
    if (last && last[1] === i - 1) last[1] = i; else peakRuns.push([i, i]);
  });
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    setHover(clamp(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - L) / slot), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const d = e.key === "ArrowLeft" ? -1 : 1; setHover((h) => (h == null ? (d < 0 ? n - 1 : 0) : clamp(h + d, 0, n - 1))); }
    else if (e.key === "Escape") setHover(null);
  };
  const tipRows = (bar: HourBar): [ReactNode, ReactNode, string?][] => {
    const rows: [ReactNode, ReactNode, string?][] = [[COPY.drawer.legendSuccess, count(bar.success), SUCCESS_COLOR]];
    for (const reason of REASON_ORDER) if (bar.blocked[reason] > 0) rows.push([COPY.drawer.reasons[reason], count(bar.blocked[reason]), REASON_COLOR[reason]]);
    if (bar.notBought) rows.push([COPY.drawer.notBoughtLabel, count(bar.notBought)]);
    return rows;
  };
  const hx = hover != null ? L + slot * hover + slot / 2 : 0;
  const hb = hover != null ? bars[hover] : null;
  const limitText = limitValue == null ? "" : limit.kind === "atLeast" ? COPY.drawer.limitAtLeast(approx(limitValue)) : COPY.drawer.limitMeasured(approx(limitValue));
  return (
    <>
      <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown} onBlur={() => setHover(null)}>
        <div className="jy-chart" style={{ height }}>
          {w > 0 && n > 0 && (
            <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
              <g className="grid">{yt.ticks.map((t) => <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} />)}</g>
              {yt.ticks.map((t) => <text key={t} className="tick-label" x={L - 6} y={y(t) + 4} textAnchor="end">{count(t)}</text>)}
              {peakRuns.map(([a, b]) => (
                <g key={a}>
                  <rect className="jy-hpeak" x={L + slot * a + 1} y={T - 6} width={slot * (b - a + 1) - 2} height={height - T - B + 6} rx={3} />
                  <text className="jy-hpeak-label" x={L + slot * a + 4} y={T + 4}>{COPY.drawer.peakBox}</text>
                </g>
              ))}
              {bars.map((bar, i) => {
                const parts: [string, number][] = [[SUCCESS_COLOR, bar.success], ...REASON_ORDER.map((reason): [string, number] => [REASON_COLOR[reason], bar.blocked[reason]])];
                const layers = parts.filter(([, value]) => value > 0);
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
              {limitValue != null && (
                <>
                  <line className={`jy-hlimit${limit.kind === "atLeast" ? " is-dashed" : ""}`} x1={L} x2={w - R} y1={y(limitValue)} y2={y(limitValue)} />
                  <text className="jy-hlimit-label" x={w - R - 2} y={y(limitValue) - 4} textAnchor="end">{limitText}</text>
                </>
              )}
              {bars.map((bar, i) => (i % 3 === 0 ? <text key={i} className="tick-label" x={L + slot * i + slot / 2} y={height - 8} textAnchor="middle">{bar.hour}</text> : null))}
              {hover != null && <line className="cross" x1={hx} x2={hx} y1={T} y2={height - B} />}
            </svg>
          )}
        </div>
        {hb != null && (
          <ChartTip x={hx} width={w}>
            <TipBody title={COPY.drawer.hour(hb.hour)} rows={tipRows(hb)} />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">{hb ? `${COPY.drawer.hour(hb.hour)}：${tipRows(hb).map(([k, v]) => `${k} ${v}`).join("，")}` : ""}</div>
    </>
  );
}

// 图例：成交、各种被挡的原因（有的才列），上限两种画法都列（实线：测到的，虚线：没测到、只知道至少）
export function ChartLegend({ bars }: { bars: HourBar[] }) {
  const seen = REASON_ORDER.filter((reason) => bars.some((bar) => bar.blocked[reason] > 0));
  const line = (dashed: boolean) => <svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" className={`jy-hlimit${dashed ? " is-dashed" : ""}`} /></svg>;
  return (
    <ul className="jy-hlegend">
      <li><i style={{ background: SUCCESS_COLOR }} />{COPY.drawer.legendSuccess}</li>
      {seen.map((reason) => <li key={reason}><i style={{ background: REASON_COLOR[reason] }} />{COPY.drawer.reasons[reason]}</li>)}
      <li>{line(false)}{COPY.drawer.legendMeasured}</li>
      <li>{line(true)}{COPY.drawer.legendAtLeast}</li>
    </ul>
  );
}
