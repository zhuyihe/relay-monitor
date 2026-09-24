"use client";
// 收入与用量成本趋势（同一纵轴）+ 每日毛利柱（共用横轴），一个面板，可切换成表格。
// 今天未满一天用虚线；缺数据的日子画斜纹带、断线，不补零。
// 悬停或用左右方向键逐日查看，十字线同时贯穿两张图。
import { useId, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { WEEKDAYS, axisMoney, formatHhmm, formatMoney, formatMonthDay, parseDay } from "../../lib/format";
import { barPath, clamp, linePath, niceTicks, runs, spreadLabels, xTickIdx } from "../../lib/chart-math";
import { ChartTip, TipBody } from "./float-tip";
import type { TipRow } from "./float-tip";
import { Panel } from "./panel";
import { Seg } from "./seg";
import { StatusText } from "./status";
import { svgId, useElementWidth } from "./use-width";

export type TrendRow = {
  // YYYY-MM-DD（本地日期）
  date: string;
  rev: number | null;
  cost: number | null;
  fixed: number;
  // 今天，还没过完
  today?: boolean;
  // 当天用量成本不全（按已有数据估算）
  partial?: boolean;
  // 当天用量成本缺失
  missing?: boolean;
};

type Row = TrendRow & { d: Date; profit: number | null };

const round2 = (v: number) => Math.round(v * 100) / 100;
const dayTitle = (r: Row, asOf?: number | null) =>
  `${formatMonthDay(r.d)} ${WEEKDAYS[r.d.getDay()]}${r.today && asOf ? `，截至 ${formatHhmm(asOf)}` : ""}`;
const dayLabel = (r: Row) => (r.today ? "今天" : formatMonthDay(r.d));

function Hatch({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="2" height="6" style={{ fill: "var(--jy-ink-dis)", opacity: 0.45 }} />
    </pattern>
  );
}

export function TrendPanel({
  rows: input,
  showRev = true,
  asOf,
  fixedNote,
  title,
  caption = "按天，同一纵轴",
}: {
  rows: TrendRow[];
  showRev?: boolean;
  asOf?: number | null;
  // 图例右侧的说明，如"固定成本每天 ¥40.00，只计入毛利"
  fixedNote?: ReactNode;
  title?: ReactNode;
  caption?: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const rows: Row[] = useMemo(
    () =>
      input.map((r) => {
        const cost = r.missing ? null : r.cost;
        const rev = showRev ? r.rev : null;
        return {
          ...r,
          rev,
          cost,
          d: parseDay(r.date) || new Date(),
          profit: rev != null && cost != null ? round2(rev - cost - (r.fixed || 0)) : null,
        };
      }),
    [input, showRev],
  );

  return (
    <Panel
      title={title ?? (showRev ? "收入与用量成本" : "用量成本")}
      caption={caption}
      extra={
        <Seg<"chart" | "table">
          size="sm"
          label="显示方式"
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: "图表" },
            { value: "table", label: "表格" },
          ]}
        />
      }
    >
      {view === "chart" ? (
        <TrendChart rows={rows} showRev={showRev} asOf={asOf} fixedNote={fixedNote} />
      ) : (
        <TrendTable rows={rows} showRev={showRev} asOf={asOf} />
      )}
    </Panel>
  );
}

function TrendChart({
  rows,
  showRev,
  asOf,
  fixedNote,
}: {
  rows: Row[];
  showRev: boolean;
  asOf?: number | null;
  fixedNote?: ReactNode;
}) {
  const [stackRef, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const uid = svgId(useId());
  const n = rows.length;
  const hasMissing = rows.some((r) => r.missing);
  const hasToday = !!rows[n - 1]?.today;

  const T = 12;
  const L = w < 480 ? 46 : 52;
  const R = w < 480 ? 60 : 72;
  const pw = Math.max(1, w - L - R);
  const step = pw / Math.max(1, n);
  const cx = (i: number) => L + step * (i + 0.5);

  // 上图：收入与用量成本
  const HL = 208;
  const BL = showRev ? 8 : 28;
  const vals = rows.flatMap((r) => [r.rev, r.cost]).filter((v): v is number => v != null);
  const yt = niceTicks(0, Math.max(0, ...vals), 4);
  const y = (v: number) => T + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (HL - T - BL);
  const bands = runs(rows.map((r) => !!r.missing));
  const series = [
    ...(showRev ? [{ name: "收入", color: "var(--jy-s1)", vals: rows.map((r) => r.rev) }] : []),
    { name: "用量成本", color: "var(--jy-s2)", vals: rows.map((r) => r.cost) },
  ];
  const lastSolid = hasToday ? n - 2 : n - 1;
  const ends = spreadLabels(series.map((s) => ({ name: s.name, y: y(s.vals[n - 1] ?? s.vals[n - 2] ?? 0) + 4 })));
  const xIdx = n ? xTickIdx(n, pw) : [];
  const xLabels = (h: number) =>
    xIdx.map((i) => (
      <text key={i} className="tick-label" x={cx(i)} y={h - 8} textAnchor="middle">
        {dayLabel(rows[i])}
      </text>
    ));

  // 下图：每日毛利
  const HB = 148;
  const BB = 28;
  const pv = rows.map((r) => r.profit).filter((v): v is number => v != null);
  const bt = niceTicks(Math.min(0, ...pv), Math.max(0, ...pv), 3);
  const yb = (v: number) => T + (1 - (v - bt.lo) / (bt.hi - bt.lo)) * (HB - T - BB);
  const bw = Math.max(1, Math.min(22, step - 2));

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (px < L - 4 || px > w - R + 4) return setHover(null);
    setHover(clamp(Math.floor((px - L) / step), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    const k = e.key;
    if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      const d = k === "ArrowLeft" ? -1 : 1;
      setHover((h) => (h == null ? n - 1 : clamp(h + d, 0, n - 1)));
    } else if (k === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (k === "End") {
      e.preventDefault();
      setHover(n - 1);
    } else if (k === "Escape") setHover(null);
  };

  const hr = hover != null ? rows[hover] : null;
  let tipRows: TipRow[] = [];
  let spoken = "";
  if (hr) {
    const cost = hr.cost == null ? "数据缺失" : formatMoney(hr.cost, { approx: hr.partial });
    const profit = hr.profit == null ? "无法计算" : formatMoney(hr.profit, { approx: hr.partial });
    if (showRev) tipRows.push(["收入", formatMoney(hr.rev), "var(--jy-s1)"]);
    tipRows.push(["用量成本", cost, "var(--jy-s2)"]);
    tipRows.push(["固定成本", formatMoney(hr.fixed)]);
    if (showRev)
      tipRows.push([
        "毛利",
        hr.profit != null && hr.profit < 0 ? (
          <>
            <StatusText level="crit">亏损</StatusText> {profit}
          </>
        ) : (
          profit
        ),
      ]);
    spoken = `${dayTitle(hr, asOf)}：${showRev ? `收入 ${formatMoney(hr.rev)}，` : ""}用量成本 ${cost}，固定成本 ${formatMoney(hr.fixed)}${showRev ? `，毛利 ${hr.profit != null && hr.profit < 0 ? "亏损 " : ""}${profit}` : ""}`;
  }

  const ready = w > 0 && n > 0;
  const x = hover != null ? cx(hover) : 0;

  return (
    <>
      <div className="jy-legend">
        {showRev && (
          <span>
            <i className="line-key" style={{ background: "var(--jy-s1)" }} />
            收入
          </span>
        )}
        <span>
          <i className="line-key" style={{ background: "var(--jy-s2)" }} />
          用量成本
        </span>
        {hasToday && (
          <span>
            <i className="line-key line-key--dash" />
            今天（未满一天）
          </span>
        )}
        {hasMissing && (
          <span>
            <i className="jy-swatch hatch-swatch" />
            数据缺失
          </span>
        )}
        {fixedNote != null && <span className="legend-note">{fixedNote}</span>}
      </div>
      <div
        ref={stackRef}
        className="jy-chart-stack"
        tabIndex={0}
        role="img"
        aria-label={`${showRev ? "每日收入与用量成本折线图，以及每日毛利柱状图" : "每日用量成本折线图"}，可用左右方向键逐日查看`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        <div className="jy-chart" style={{ height: HL }}>
          {ready && (
            <svg viewBox={`0 0 ${w} ${HL}`} height={HL} aria-hidden="true">
              <defs>
                <Hatch id={`${uid}l`} />
              </defs>
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
              {bands.map(([a, b]) => {
                const x0 = cx(a) - step / 2;
                const bwid = (b - a + 1) * step;
                return (
                  <g key={a}>
                    <rect x={x0} y={T} width={bwid} height={HL - BL - T} fill={`url(#${uid}l)`} />
                    {bwid >= 44 && (
                      <text className="tick-label" x={x0 + bwid / 2} y={T + 14} textAnchor="middle">
                        缺失
                      </text>
                    )}
                  </g>
                );
              })}
              {series.map((s) => (
                <g key={s.name}>
                  <path className="series" style={{ stroke: s.color }} d={linePath(s.vals, cx, y, 0, lastSolid)} />
                  {hasToday && n > 1 && (
                    <path className="series" style={{ stroke: s.color }} strokeDasharray="3 4" d={linePath(s.vals, cx, y, n - 2, n - 1)} />
                  )}
                </g>
              ))}
              {ends.map((e) => (
                <text key={e.name} className="end-label" x={cx(n - 1) + 10} y={e.y}>
                  {e.name}
                </text>
              ))}
              {!showRev && xLabels(HL)}
              {hover != null && (
                <>
                  <line className="cross" x1={x} x2={x} y1={T} y2={HL - BL} />
                  {series.map((s) =>
                    s.vals[hover] == null ? null : (
                      <circle key={s.name} className="hover-dot" r={4.5} cx={x} cy={y(s.vals[hover] as number)} style={{ fill: s.color }} />
                    ),
                  )}
                </>
              )}
            </svg>
          )}
        </div>
        {showRev && (
          <>
            <div className="jy-chart-sub">
              <h3>每日毛利</h3>
              <div className="jy-legend" style={{ margin: 0 }}>
                <span>
                  <i className="jy-swatch" style={{ background: "var(--jy-s1)" }} />
                  盈利
                </span>
                <span>
                  <i className="jy-swatch" style={{ background: "var(--jy-loss)" }} />
                  亏损
                </span>
              </div>
            </div>
            <div className="jy-chart" style={{ height: HB }}>
              {ready && (
                <svg viewBox={`0 0 ${w} ${HB}`} height={HB} aria-hidden="true">
                  <defs>
                    <Hatch id={`${uid}b`} />
                  </defs>
                  <g className="grid">
                    {bt.ticks
                      .filter((t) => t !== 0)
                      .map((t) => (
                        <line key={t} x1={L} x2={w - R} y1={yb(t)} y2={yb(t)} />
                      ))}
                  </g>
                  {bt.ticks.map((t) => (
                    <text key={t} className="tick-label" x={L - 8} y={yb(t) + 4} textAnchor="end">
                      {axisMoney(t)}
                    </text>
                  ))}
                  {bands.map(([a, b]) => (
                    <rect key={a} x={cx(a) - step / 2} y={T} width={(b - a + 1) * step} height={HB - T - BB} fill={`url(#${uid}b)`} />
                  ))}
                  {rows.map((r, i) => {
                    if (r.profit == null) return null;
                    const pos = r.profit >= 0;
                    const top = pos ? yb(r.profit) : yb(0);
                    const bottom = pos ? yb(0) : yb(r.profit);
                    return (
                      <path
                        key={r.date}
                        d={barPath(cx(i) - bw / 2, top, Math.max(bottom, top + 1), bw, 4, pos)}
                        style={{ fill: pos ? "var(--jy-s1)" : "var(--jy-loss)" }}
                        fillOpacity={r.today || r.partial ? 0.4 : undefined}
                      />
                    );
                  })}
                  <line className="zero" x1={L} x2={w - R} y1={yb(0)} y2={yb(0)} />
                  {xLabels(HB)}
                  {hover != null && <line className="cross" x1={x} x2={x} y1={T} y2={HB - BB} />}
                </svg>
              )}
            </div>
          </>
        )}
        {hr && (
          <ChartTip x={x} width={w}>
            <TipBody title={dayTitle(hr, asOf)} rows={tipRows} />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
    </>
  );
}

function TrendTable({ rows, showRev, asOf }: { rows: Row[]; showRev: boolean; asOf?: number | null }) {
  const approx = rows.some((r) => r.missing || r.partial);
  const sum = (f: (r: Row) => number | null) => round2(rows.reduce((a, r) => a + (f(r) || 0), 0));
  const rev = showRev ? sum((r) => r.rev) : null;
  const cost = sum((r) => r.cost);
  const fixed = sum((r) => r.fixed);
  const profit = rev == null ? null : round2(rev - cost - fixed);
  return (
    <div className="jy-table-scroll">
      <table className="jy-data jy-data--compact jy-num">
        <thead>
          <tr>
            <th scope="col">日期</th>
            {showRev && <th scope="col" className="r">收入</th>}
            <th scope="col" className="r">用量成本</th>
            <th scope="col" className="r">固定成本</th>
            {showRev && <th scope="col" className="r">毛利</th>}
          </tr>
        </thead>
        <tbody>
          {rows
            .slice()
            .reverse()
            .map((r) => (
              <tr key={r.date}>
                <td>{dayTitle(r, asOf)}</td>
                {showRev && <td className="r">{formatMoney(r.rev)}</td>}
                <td className="r">{r.cost == null ? <span className="jy-muted">数据缺失</span> : formatMoney(r.cost, { approx: r.partial })}</td>
                <td className="r">{formatMoney(r.fixed)}</td>
                {showRev && (
                  <td className="r">
                    {r.profit == null ? <span className="jy-muted">无法计算</span> : formatMoney(r.profit, { approx: r.partial })}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">合计 {rows.length} 天</th>
            {showRev && <td className="r">{formatMoney(rev)}</td>}
            <td className="r">{formatMoney(cost, { approx })}</td>
            <td className="r">{formatMoney(fixed)}</td>
            {showRev && <td className="r">{formatMoney(profit, { approx })}</td>}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
