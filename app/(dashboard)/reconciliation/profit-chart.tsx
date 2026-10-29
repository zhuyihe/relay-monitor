"use client";
// 每天的毛利：选了好几天时出的一张小柱状图，一天一根；没固定的天和今天用浅色，悬停看那天的四个数。
// 照项目里别的图的做法（自己画 SVG、按容器宽度画、悬停用 useFloatTip），不引新的图表库。
import type { SVGProps } from "react";
import type { ProfitPageResponse } from "../../../lib/client";
import { formatDayKey } from "../../../lib/format";
import { useElementWidth } from "../../components/use-width";
import { TipBody, useFloatTip } from "../../components/float-tip";
import { Panel } from "../../components/panel";
import { COPY } from "./copy";
import { chartDays, fmtMoney } from "./profit-format";
import type { Ctx } from "./profit-format";

// 纵轴刻度取 1、2、5 × 10 的几次方
function niceStep(range: number) {
  const raw = range / 2, pow = 10 ** Math.floor(Math.log10(raw || 1)), unit = raw / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}

export function ProfitChart({ page, ctx, compact }: { page: ProfitPageResponse; ctx: Ctx; compact: boolean }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const { bind, node } = useFloatTip();
  const days = chartDays(page, ctx);
  if (days.length < 2) return null;
  const symbol = ctx.currency === "CNY" ? "¥" : "$";
  const height = compact ? 120 : 150, padL = compact ? 44 : 56, top = 8, labelH = 24;
  const gross = days.map((day) => day.gross), step = niceStep(Math.max(1e-9, Math.max(0, ...gross) - Math.min(0, ...gross)));
  const max = Math.max(step * 2, Math.ceil(Math.max(0, ...gross) / step) * step), min = Math.min(0, Math.floor(Math.min(0, ...gross) / step) * step);
  const ticks: number[] = []; for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const w = Math.max(width, 240), inner = w - padL - 4, slot = inner / days.length, bar = Math.min(slot * 0.56, 72);
  const y = (value: number) => top + ((max - value) / (max - min)) * height;
  const axis = (value: number) => `${value < 0 ? "−" : ""}${symbol}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return <Panel title={COPY.chart.title} extra={<span className="jy-caption">{COPY.chart.legend}</span>} className="jy-profit-chart">
    <div ref={ref} className="jy-profit-chart__body" role="img" aria-label={COPY.chart.label}>
      {width ? <svg width={w} height={top + height + labelH} viewBox={`0 0 ${w} ${top + height + labelH}`}>
        {ticks.map((value) => <g key={value}>
          <line x1={padL} x2={w} y1={y(value)} y2={y(value)} className={value === 0 ? "jy-profit-chart__zero" : "jy-profit-chart__grid"} />
          <text x={padL - 8} y={y(value) + 4} textAnchor="end" className="jy-profit-chart__axis">{axis(value)}</text>
        </g>)}
        {days.map((day, index) => {
          const x = padL + index * slot + (slot - bar) / 2, top0 = y(Math.max(day.gross, 0)), h = Math.max(1, Math.abs(y(day.gross) - y(0)));
          return <g key={day.day} data-day={day.day} data-light={day.light ? "1" : "0"} tabIndex={0} aria-label={`${day.day} ${fmtMoney(day.gross, ctx.currency)}`}
            {...(bind(() => <TipBody title={COPY.chart.tip(formatDayKey(day.day, ctx.tz, ctx.now), day.weekday, day.stateText)}
              rows={[[COPY.summary.income, fmtMoney(day.income, ctx.currency)], [COPY.summary.actual, fmtMoney(day.actual, ctx.currency)], [COPY.summary.gross, fmtMoney(day.gross, ctx.currency)], [COPY.summary.margin, day.margin]]} />) as unknown as SVGProps<SVGGElement>)}>
            <rect x={padL + index * slot} y={top} width={slot} height={height} fill="transparent" />
            <rect x={x} y={top0} width={bar} height={h} rx={3} className={`jy-profit-chart__bar${day.light ? " is-light" : ""}${day.gross < 0 ? " is-loss" : ""}`} />
            <text x={x + bar / 2} y={top + height + 18} textAnchor="middle" className="jy-profit-chart__axis">{day.label}</text>
          </g>;
        })}
      </svg> : null}
    </div>
    {node}
  </Panel>;
}
