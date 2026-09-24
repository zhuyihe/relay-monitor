"use client";
// 未来 24 小时每小时消费预测：中线 + 历史波动阴影带，跨零点处画一条虚线并标"明天"。
import { useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { axisMoney, formatMoney } from "../../lib/format";
import { clamp, niceTicks } from "../../lib/chart-math";
import { ChartTip, TipBody } from "./float-tip";
import { useElementWidth } from "./use-width";

export type ForecastPoint = { t: number; cost: number; lo: number; hi: number };

const L = 44;
const R = 16;
const T = 12;
const B = 28;
const H = 196;

export function ForecastChart({
  points,
  format = formatMoney,
  label = "未来 24 小时每小时消费预测，阴影为历史波动范围",
}: {
  points: ForecastPoint[];
  format?: (v: number, opts?: { dp?: number }) => string;
  label?: string;
}) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pts = points.map((p) => ({ ...p, h: new Date(p.t).getHours() }));
  const n = pts.length;
  const pw = Math.max(1, w - L - R);
  const step = pw / Math.max(1, n);
  const cx = (i: number) => L + step * (i + 0.5);
  const yt = niceTicks(0, Math.max(0, ...pts.map((p) => p.hi)), 3);
  const y = (v: number) => T + (1 - v / yt.hi) * (H - T - B);
  const mid = pts.findIndex((p) => p.h === 0);
  const tomorrow = (i: number) => mid > 0 && i >= mid;

  const band = n
    ? `M${pts.map((p, i) => `${cx(i).toFixed(1)},${y(p.hi).toFixed(1)}`).join("L")}L${pts
        .map((p, i) => `${cx(i).toFixed(1)},${y(p.lo).toFixed(1)}`)
        .reverse()
        .join("L")}Z`
    : "";
  const line = n ? `M${pts.map((p, i) => `${cx(i).toFixed(1)},${y(p.cost).toFixed(1)}`).join("L")}` : "";

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setHover(clamp(Math.floor((px - L) / step), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => (h == null ? 0 : clamp(h + d, 0, n - 1)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(n - 1);
    } else if (e.key === "Escape") setHover(null);
  };

  const hp = hover != null ? pts[hover] : null;
  const title = hp ? `${tomorrow(hover as number) ? "明天 " : ""}${hp.h}:00 至 ${hp.h + 1}:00` : "";
  const range = hp ? `${format(hp.lo, { dp: 0 })} 至 ${format(hp.hi, { dp: 0 })}` : "";
  const x = hover != null ? cx(hover) : 0;

  return (
    <>
      <div
        ref={ref}
        className="jy-chart-stack"
        tabIndex={0}
        role="img"
        aria-label={label}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        <div className="jy-chart" style={{ height: H }}>
          {w > 0 && n > 0 && (
            <svg viewBox={`0 0 ${w} ${H}`} height={H} aria-hidden="true">
              <g className="grid">
                {yt.ticks.map((t) => (
                  <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} />
                ))}
              </g>
              {yt.ticks.map((t) => (
                <text key={t} className="tick-label" x={L - 8} y={y(t) + 4} textAnchor="end">
                  {axisMoney(t)}
                </text>
              ))}
              {mid > 0 && (
                <>
                  <line className="day-rule" x1={cx(mid) - step / 2} x2={cx(mid) - step / 2} y1={T} y2={H - B} />
                  <text className="tick-label" x={cx(mid) - step / 2 + 6} y={T + 12}>
                    明天
                  </text>
                </>
              )}
              <path d={band} style={{ fill: "var(--jy-s1)", opacity: 0.14 }} />
              <path className="series" style={{ stroke: "var(--jy-s1)" }} d={line} />
              {pts.map((p, i) =>
                p.h % 3 === 0 ? (
                  <text key={p.t} className="tick-label" x={cx(i)} y={H - 8} textAnchor="middle">
                    {p.h}:00
                  </text>
                ) : null,
              )}
              {hp && (
                <>
                  <line className="cross" x1={x} x2={x} y1={T} y2={H - B} />
                  <circle className="hover-dot" r={4.5} cx={x} cy={y(hp.cost)} style={{ fill: "var(--jy-s1)" }} />
                </>
              )}
            </svg>
          )}
        </div>
        {hp && (
          <ChartTip x={x} width={w}>
            <TipBody
              title={title}
              rows={[
                ["预计消费", format(hp.cost), "var(--jy-s1)"],
                ["历史波动", range],
              ]}
            />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {hp ? `${title}：预计消费 ${format(hp.cost)}，历史波动 ${range}` : ""}
      </div>
    </>
  );
}
