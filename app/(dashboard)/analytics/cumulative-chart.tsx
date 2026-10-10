"use client";
// 累计成本：期内逐日累加的用量成本、固定成本与总成本三条折线（直线连接，不做平滑）。
// 旧页面的"固定 vs 用量"堆叠图和累计成本折线合并到这里；共享的 TrendPanel 不画固定成本线，
// 这张图补上固定成本的走势。缺记录的日子画斜纹带，累计值在那之后带 ≈（按已有数据累加）。
import { useId, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { WEEKDAYS, axisMoney, formatHhmm, formatMoney, formatMonthDay, parseDay } from "../../../lib/format";
import { clamp, linePath, niceTicks, runs, spreadLabels, xTickIdx } from "../../../lib/chart-math";
import { ChartTip, TipBody } from "../../components/float-tip";
import type { TipRow } from "../../components/float-tip";
import { Panel } from "../../components/panel";
import type { TrendRow } from "../../components/trend-panel";
import { svgId, useElementWidth } from "../../components/use-width";

const r2 = (v: number) => Math.round(v * 100) / 100;

type Point = {
  date: string;
  d: Date;
  today: boolean;
  missing: boolean;
  // 截至当天是否已有缺记录或部分缺失的日子
  approx: boolean;
  usage: number;
  fixed: number;
  total: number;
  dayCost: number | null;
  dayFixed: number;
};

const SERIES = [
  { key: "total", name: "总成本", color: "var(--jy-ink-2)" },
  { key: "usage", name: "用量成本", color: "var(--jy-s2)" },
  { key: "fixed", name: "固定成本", color: "var(--jy-s3)" },
] as const;

export function CumulativePanel({ rows, asOf }: { rows: TrendRow[]; asOf?: number | null }) {
  const pts: Point[] = useMemo(() => {
    let usage = 0;
    let fixed = 0;
    let approx = false;
    return rows.map((r) => {
      usage += r.cost || 0;
      fixed += r.fixed || 0;
      approx = approx || !!r.missing || !!r.partial;
      return {
        date: r.date,
        d: parseDay(r.date) || new Date(),
        today: !!r.today,
        missing: !!r.missing,
        approx,
        usage: r2(usage),
        fixed: r2(fixed),
        total: r2(usage + fixed),
        dayCost: r.missing ? null : r.cost,
        dayFixed: r.fixed || 0,
      };
    });
  }, [rows]);

  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const uid = svgId(useId());
  const n = pts.length;
  const hasMissing = pts.some((p) => p.missing);
  const hasToday = !!pts[n - 1]?.today;

  const H = 220;
  const T = 12;
  const B = 28;
  const L = w < 480 ? 46 : 52;
  const R = w < 480 ? 64 : 76;
  const pw = Math.max(1, w - L - R);
  const step = pw / Math.max(1, n);
  const cx = (i: number) => L + step * (i + 0.5);
  const yt = niceTicks(0, Math.max(0, ...pts.map((p) => p.total)), 4);
  const y = (v: number) => T + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (H - T - B);
  const bands = runs(pts.map((p) => p.missing));
  const lastSolid = hasToday ? n - 2 : n - 1;
  const vals = (k: (typeof SERIES)[number]["key"]) => pts.map((p) => p[k]);
  const ends = spreadLabels(SERIES.map((s) => ({ name: s.name, y: y(pts[n - 1]?.[s.key] ?? 0) + 4 })));
  const xIdx = n ? xTickIdx(n, pw) : [];

  const title = (p: Point) => `${formatMonthDay(p.d)} ${WEEKDAYS[p.d.getDay()]}${p.today && asOf ? `，截至 ${formatHhmm(asOf)}` : ""}`;

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (px < L - 4 || px > w - R + 4) return setHover(null);
    setHover(clamp(Math.floor((px - L) / step), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => (h == null ? n - 1 : clamp(h + d, 0, n - 1)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(n - 1);
    } else if (e.key === "Escape") setHover(null);
  };

  const hp = hover != null ? pts[hover] : null;
  let tipRows: TipRow[] = [];
  let spoken = "";
  if (hp) {
    const total = formatMoney(hp.total, { approx: hp.approx });
    const usage = formatMoney(hp.usage, { approx: hp.approx });
    const fixed = formatMoney(hp.fixed);
    const day = hp.dayCost == null ? "用量记录缺失" : formatMoney(r2(hp.dayCost + hp.dayFixed));
    tipRows = [
      ["累计总成本", total, "var(--jy-ink-2)"],
      ["累计用量成本", usage, "var(--jy-s2)"],
      ["累计固定成本", fixed, "var(--jy-s3)"],
      ["当天成本", day],
    ];
    spoken = `${title(hp)}：累计总成本 ${total}，累计用量成本 ${usage}，累计固定成本 ${fixed}，当天成本 ${day}`;
  }
  const ready = w > 0 && n > 0;
  const x = hover != null ? cx(hover) : 0;
  const last = pts[n - 1];

  return (
    <Panel title="累计成本" caption="期内逐日累加">
      <div className="jy-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i className="line-key" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {hasToday && (
          <span>
            <i className="line-key line-key--dash" />
            今天（未满一天）
          </span>
        )}
        {hasMissing && (
          <span>
            <i className="jy-swatch hatch-swatch" />
            数据缺失，未计入
          </span>
        )}
      </div>
      <div
        ref={ref}
        className="jy-chart-stack"
        tabIndex={0}
        role="img"
        aria-label={`累计成本折线图，期末累计总成本 ${last ? formatMoney(last.total, { approx: last.approx }) : "—"}，可用左右方向键逐日查看`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        <div className="jy-chart" style={{ height: H }}>
          {ready && (
            <svg viewBox={`0 0 ${w} ${H}`} height={H} aria-hidden="true">
              <defs>
                <pattern id={`${uid}h`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="2" height="6" style={{ fill: "var(--jy-ink-dis)", opacity: 0.45 }} />
                </pattern>
              </defs>
              <g className="grid">
                {yt.ticks.map((t) => (
                  <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} />
                ))}
              </g>
              {yt.ticks.map((t) => (
                <text key={t} className="tick-label" x={L - 8} y={y(t) + 4} textAnchor="end">
                  {axisMoney(t, yt.step)}
                </text>
              ))}
              {bands.map(([a, b]) => (
                <rect key={a} x={cx(a) - step / 2} y={T} width={(b - a + 1) * step} height={H - B - T} fill={`url(#${uid}h)`} />
              ))}
              {SERIES.map((s) => (
                <g key={s.key}>
                  <path className="series" style={{ stroke: s.color }} d={linePath(vals(s.key), cx, y, 0, lastSolid)} />
                  {hasToday && n > 1 && (
                    <path className="series" style={{ stroke: s.color }} strokeDasharray="3 4" d={linePath(vals(s.key), cx, y, n - 2, n - 1)} />
                  )}
                </g>
              ))}
              {ends.map((e) => (
                <text key={e.name} className="end-label" x={cx(n - 1) + 10} y={e.y}>
                  {e.name}
                </text>
              ))}
              {xIdx.map((i) => (
                <text key={i} className="tick-label" x={cx(i)} y={H - 8} textAnchor="middle">
                  {pts[i].today ? "今天" : formatMonthDay(pts[i].d)}
                </text>
              ))}
              {hover != null && (
                <>
                  <line className="cross" x1={x} x2={x} y1={T} y2={H - B} />
                  {SERIES.map((s) => (
                    <circle key={s.key} className="hover-dot" r={4.5} cx={x} cy={y(pts[hover][s.key])} style={{ fill: s.color }} />
                  ))}
                </>
              )}
            </svg>
          )}
        </div>
        {hp && (
          <ChartTip x={x} width={w}>
            <TipBody title={title(hp)} rows={tipRows} />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
    </Panel>
  );
}
