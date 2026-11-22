"use client";
import { useEffect, useState } from "react";
import { niceTicks } from "../../lib/chart-math";
import { formatUsd } from "../../lib/format";
import { useElementWidth } from "../components/use-width";
import type { TrendDay } from "./users/users-format";

export function OverviewChart({ days, metric, today }: { days: TrendDay[]; metric: "cost" | "users"; today: string }) {
  const [ref, measuredWidth] = useElementWidth();
  const [lastWidth, setLastWidth] = useState(280);
  useEffect(() => { if (measuredWidth > 0) setLastWidth(measuredWidth); }, [measuredWidth]);
  const width = Math.max(280, measuredWidth || lastWidth);
  const [selected, setSelected] = useState<number | null>(null);
  const height = 165, left = 40, right = 0, top = 7, bottom = 26;
  const values = days.map((day) => day.available ? day[metric] : null);
  const ticks = niceTicks(0, Math.max(metric === "users" ? 3 : 1, ...values.map((value) => value ?? 0)), 3);
  const span = Math.max(1, width - left - right), step = span / Math.max(1, days.length), bw = Math.max(2, step * .62);
  const y = (value: number) => top + (1 - value / ticks.hi) * (height - top - bottom);
  const point = selected == null ? null : days[selected];
  const text = (value: number) => metric === "cost" ? formatUsd(value) : `${value} 位`;
  return <div ref={ref} className="jy-ov-chart">
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`最近7天普通客户${metric === "cost" ? "消费用量" : "消费人数"}，今天仅到读取时刻`}>
      <title>普通客户用量汇总，未同步的日期留空，不作为全站消费账单。</title>
      {ticks.ticks.filter((value) => metric !== "users" || Number.isInteger(value)).map((value) => <g key={value}>
        <line x1={left} x2={Math.max(left, width - right)} y1={y(value)} y2={y(value)} className="jy-ov-chart-grid" />
        <text x={left - 8} y={y(value) + 4} textAnchor="end" className="jy-ov-chart-axis">{metric === "cost" && value >= 10000 ? `${value / 10000}万` : value.toLocaleString("en-US")}</text>
      </g>)}
      {days.map((day, index) => <g key={day.day} tabIndex={0} role="button"
        aria-label={`${day.day}，${day.available ? text(day[metric]) : "未同步"}${day.day === today ? "，今天进行中" : ""}`}
        onFocus={() => setSelected(index)} onMouseEnter={() => setSelected(index)} onClick={() => setSelected(index)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(index); } }}>
        <rect x={left + index * step} width={step} y={top} height={height - top} fill="transparent" />
        {day.available ? <rect x={left + (index + .5) * step - bw / 2} y={y(day[metric])} width={bw} height={Math.max(0, y(0) - y(day[metric]))}
          shapeRendering="crispEdges" className={`jy-ov-chart-bar${index === days.length - 1 ? " is-latest" : ""}${day.day === today ? " is-today" : ""}`} />
          : <text x={left + (index + .5) * step} y={y(0) - 8} textAnchor="middle" className="jy-ov-chart-axis">—</text>}
        {(step >= 44 || index % 2 === 0 || index === days.length - 1) && <text x={left + (index + .5) * step} y={height - 8} textAnchor="middle" className="jy-ov-chart-axis">{day.day === today ? "今天" : `${Number(day.day.slice(5, 7))}/${Number(day.day.slice(8))}`}</text>}
      </g>)}
    </svg>
    <p className={`jy-caption jy-ov-chart-readout${point ? " is-visible" : ""}`} aria-live="polite">{point ? `${point.day} · ${point.available ? text(point[metric]) : "未同步"}${point.day === today ? " · 今天进行中" : ""}` : "普通客户用量统计，与全站消费账单分别读取；缺失日期留空。"}</p>
  </div>;
}
