"use client";
// 模型供需抽屉里的成功率线（design 模型供需 v1 §5）：近 30 天每天一个点，纵轴从 90% 起（只看高位的变化，低了往下延），95% 一条红色虚线写明判断线，
// 最低的那天标一个点和数；一天一个点都没有的天线断开，不画 0。自己画的 SVG（坐标算法在 lib/chart-math），一张图一个色，数在悬停和最低那一天的标注里。
// 每天卖多少的柱子用用户运营那一张（../users/charts 的 Bars），不和这条线合成双纵轴的图。
import { useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { formatDayKey, formatPct, weekdayOfDayKey } from "../../../lib/format";
import { clamp, linePath, xTickIdx } from "../../../lib/chart-math";
import { MODELS_VIEW } from "../../../lib/models-view.js";
import { ChartTip, TipBody } from "../../components/float-tip";
import { useElementWidth } from "../../components/use-width";
import { COPY } from "./copy";

const L = 44, R = 12, T = 12, B = 26;

export function RateLine({ points, low, tz, asOf, height = 150, label }: {
  points: { day: string; rate: number | null }[]; low: { day: string; rate: number } | null; tz: string; asOf: number; height?: number; label: string;
}) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const values = points.map((point) => point.rate);
  const min = Math.min(...values.filter((v): v is number => v != null), 100);
  // 纵轴 90%–100%，有更低的往下延（按 10 个点一档），刻度 3 个：下限、95%、100%
  const lo = min >= 90 ? 90 : Math.max(0, Math.floor(min / 10) * 10), hi = 100, line = MODELS_VIEW.FAIL_BELOW_PCT;
  const pw = Math.max(1, w - L - R), step = n > 1 ? pw / (n - 1) : pw;
  const x = (i: number) => L + step * i;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (height - T - B);
  const ticks = [...new Set([lo, line, hi])];
  const idx = n ? [...new Set([0, Math.floor((n - 1) / 2), n - 1])] : [];
  const lowIndex = low ? points.findIndex((point) => point.day === low.day) : -1;
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    setHover(clamp(Math.round((e.clientX - e.currentTarget.getBoundingClientRect().left - L) / step), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const d = e.key === "ArrowLeft" ? -1 : 1; setHover((h) => (h == null ? n - 1 : clamp(h + d, 0, n - 1))); }
    else if (e.key === "Escape") setHover(null);
  };
  const hx = hover != null ? x(hover) : 0, hv = hover != null ? values[hover] : null;
  const rateText = (v: number) => formatPct(v / 100);
  return (
    <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown} onBlur={() => setHover(null)}>
      <div className="jy-chart" style={{ height }}>
        {w > 0 && n > 0 && (
          <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
            <g className="grid">{ticks.map((t) => <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} />)}</g>
            {ticks.map((t) => <text key={t} className="tick-label" x={L - 6} y={y(t) + 4} textAnchor="end">{t}%</text>)}
            <line className="jy-models-limit" x1={L} x2={w - R} y1={y(line)} y2={y(line)} />
            <text className="jy-models-limit-label" x={L + 4} y={y(line) + 14}>{COPY.drawer.successLimit(line)}</text>
            <path className="series" style={{ stroke: "var(--jy-s1)" }} d={linePath(values, x, y)} />
            {points.map((point, i) => point.rate != null && (values[i - 1] == null && values[i + 1] == null) ? <circle key={point.day} r={2.5} cx={x(i)} cy={y(point.rate)} style={{ fill: "var(--jy-s1)" }} /> : null)}
            {low && lowIndex >= 0 && (
              <>
                <circle className="hover-dot" r={4} cx={x(lowIndex)} cy={y(low.rate)} style={{ fill: "var(--jy-s1)" }} />
                <text className="tick-label" x={clamp(x(lowIndex), L + 40, w - R - 40)} y={y(low.rate) + 16} textAnchor="middle">{COPY.drawer.successLow(formatDayKey(low.day, tz, asOf), rateText(low.rate))}</text>
              </>
            )}
            {idx.map((i) => <text key={i} className="tick-label" x={clamp(x(i), L, w - R)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{i === n - 1 ? COPY.drawer.today : formatDayKey(points[i].day, tz, asOf).replace(/^\d+年/, "")}</text>)}
            {hover != null && (
              <>
                <line className="cross" x1={hx} x2={hx} y1={T} y2={height - B} />
                {hv != null && <circle className="hover-dot" r={4.5} cx={hx} cy={y(hv)} style={{ fill: "var(--jy-s1)" }} />}
              </>
            )}
          </svg>
        )}
      </div>
      {hover != null && hv != null && (
        <ChartTip x={hx} width={w}>
          <TipBody title={`${formatDayKey(points[hover].day, tz, asOf)} ${weekdayOfDayKey(points[hover].day)}`} rows={[[COPY.drawer.successTitle, rateText(hv), "var(--jy-s1)"]]} />
        </ChartTip>
      )}
    </div>
  );
}
