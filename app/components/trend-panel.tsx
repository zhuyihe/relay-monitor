"use client";
// 收入、上游成本与固定成本趋势（同一纵轴）+ 每日净利柱（共用横轴），一个面板，可切换成表格。
// 净利 = 收入 − 上游成本 − 固定成本，与利润等式第二行同一口径；表格里另列毛利（收入 − 上游成本）。
// 没有固定成本时不画固定成本线。
// showCost=false 时只画收入（自营业务：这一页回答「钱从哪来」，上游成本在每日利润、成本估算里看）：不画成本线、不画每日净利柱，表格只有日期和收入。
// revApprox：收入是估算（没设置售价），收入的数值都带「≈」；说明由调用方接上原因。
// 今天未满一天用虚线；缺数据的日子画斜纹带、断线，不补零。
// 悬停或用左右方向键逐日查看，十字线同时贯穿两张图。
import { useId, useMemo, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { axisMoney, EMPTY, formatDayKey, formatMoney, formatMonthDay, formatZonedTime, parseDay, weekdayOfDayKey } from "../../lib/format";
import { barPath, clamp, linePath, niceTicks, runs, spreadLabels, xTickIdx } from "../../lib/chart-math";
import { ChartTip, TipBody } from "./float-tip";
import type { TipRow } from "./float-tip";
import { Panel } from "./panel";
import { Seg } from "./seg";
import { StatusText } from "./status";
import { svgId, useElementWidth } from "./use-width";

export type TrendRow = {
  // YYYY-MM-DD（业务时区的日期）
  date: string;
  rev: number | null;
  cost: number | null;
  fixed: number;
  // 今天，还没过完
  today?: boolean;
  // 当天上游成本不全（按已有数据估算）
  partial?: boolean;
  // 当天上游成本缺失
  missing?: boolean;
};

// gross：毛利；profit：净利；dayText：悬停和表格里的日期「10月9日 周五」，往年带年份
type Row = TrendRow & { d: Date; dayText: string; gross: number | null; profit: number | null };

const round2 = (v: number) => Math.round(v * 100) / 100;
// asOfText：「截至几点」，按业务时区显示（和日期划分同一时区），不用浏览器时区
const dayTitle = (r: Row, asOfText?: string | null) =>
  `${r.dayText}${r.today && asOfText ? `，截至 ${asOfText}` : ""}`;
const dayLabel = (r: Row) => (r.today ? "今天" : formatMonthDay(r.d));

function Hatch({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="2" height="6" style={{ fill: "var(--jy-ink-dis)", opacity: 0.45 }} />
    </pattern>
  );
}

// 面板标题：有收入时写「收入与上游成本」；成本估算页的加载骨架也用这一份
export const TREND_PANEL_TITLE = Object.freeze({ withRevenue: "收入与上游成本", costOnly: "上游成本" });

export function TrendPanel({
  rows: input,
  showRev = true,
  showCost = true,
  revApprox = false,
  asOf,
  tz,
  title,
  caption = "按天，同一纵轴",
}: {
  rows: TrendRow[];
  showRev?: boolean;
  showCost?: boolean;
  /** 收入是估算（没设置售价），收入的数值带「≈」 */
  revApprox?: boolean;
  asOf?: number | null;
  /** 业务时区（接口返回的 tz），缺省 Asia/Shanghai */
  tz?: string;
  title?: ReactNode;
  caption?: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const asOfText = asOf ? formatZonedTime(asOf, tz) : null;
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
          dayText: `${formatDayKey(r.date, tz)} ${weekdayOfDayKey(r.date)}`,
          gross: rev != null && cost != null ? round2(rev - cost) : null,
          profit: rev != null && cost != null ? round2(rev - cost - (r.fixed || 0)) : null,
        };
      }),
    [input, showRev, tz],
  );

  return (
    <Panel
      title={title ?? (showRev ? TREND_PANEL_TITLE.withRevenue : TREND_PANEL_TITLE.costOnly)}
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
        <TrendChart rows={rows} showRev={showRev} showCost={showCost} revApprox={revApprox} asOfText={asOfText} />
      ) : (
        <TrendTable rows={rows} showRev={showRev} showCost={showCost} revApprox={revApprox} asOfText={asOfText} />
      )}
    </Panel>
  );
}

function TrendChart({
  rows,
  showRev,
  showCost,
  revApprox,
  asOfText,
}: {
  rows: Row[];
  showRev: boolean;
  showCost: boolean;
  revApprox: boolean;
  asOfText?: string | null;
}) {
  const [stackRef, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const uid = svgId(useId());
  const n = rows.length;
  // 缺的是成本数据：只画收入时不画缺失带
  const hasMissing = showCost && rows.some((r) => r.missing);
  const hasToday = !!rows[n - 1]?.today;
  const hasFixed = showCost && rows.some((r) => r.fixed > 0);
  // 下面的每日净利柱：有收入又有成本时才画
  const showProfit = showRev && showCost;

  const T = 12;
  const L = w < 480 ? 46 : 52;
  const R = w < 480 ? 60 : 72;
  const pw = Math.max(1, w - L - R);
  const step = pw / Math.max(1, n);
  const cx = (i: number) => L + step * (i + 0.5);

  // 上图：收入、上游成本与固定成本
  const HL = 208;
  const BL = showProfit ? 8 : 28;
  const vals = rows.flatMap((r) => [r.rev, r.cost, hasFixed ? r.fixed : null]).filter((v): v is number => v != null);
  const yt = niceTicks(0, Math.max(0, ...vals), 4);
  const y = (v: number) => T + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (HL - T - BL);
  // 缺的是成本数据：只画收入时没有缺失带（图例里也没有「数据缺失」）
  const bands = showCost ? runs(rows.map((r) => !!r.missing)) : [];
  const series = [
    ...(showRev ? [{ name: "收入", color: "var(--jy-s1)", vals: rows.map((r) => r.rev) }] : []),
    ...(showCost ? [{ name: "上游成本", color: "var(--jy-s2)", vals: rows.map((r) => r.cost) }] : []),
    ...(hasFixed ? [{ name: "固定成本", color: "var(--jy-s3)", vals: rows.map((r): number | null => r.fixed) }] : []),
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

  // 下图：每日净利
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
    // 算不出（上游成本缺了）写「—」，原因在上一行「数据缺失」（§7）
    const profit = hr.profit == null ? EMPTY : formatMoney(hr.profit, { approx: hr.partial || revApprox });
    const rev = formatMoney(hr.rev, { approx: revApprox });
    if (showRev) tipRows.push(["收入", rev, "var(--jy-s1)"]);
    if (showCost) tipRows.push(["上游成本", cost, "var(--jy-s2)"]);
    if (showCost) tipRows.push(["固定成本", formatMoney(hr.fixed), hasFixed ? "var(--jy-s3)" : undefined]);
    if (showProfit)
      tipRows.push([
        "净利",
        hr.profit != null && hr.profit < 0 ? (
          <>
            <StatusText level="crit">亏损</StatusText> {profit}
          </>
        ) : (
          profit
        ),
      ]);
    spoken = showCost
      ? `${dayTitle(hr, asOfText)}：${showRev ? `收入 ${rev}，` : ""}上游成本 ${cost}，固定成本 ${formatMoney(hr.fixed)}${showRev ? `，净利 ${hr.profit != null && hr.profit < 0 ? "亏损 " : ""}${profit}` : ""}`
      : `${dayTitle(hr, asOfText)}：收入 ${rev}`;
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
        {showCost && (
          <span>
            <i className="line-key" style={{ background: "var(--jy-s2)" }} />
            上游成本
          </span>
        )}
        {hasFixed && (
          <span>
            <i className="line-key" style={{ background: "var(--jy-s3)" }} />
            固定成本
          </span>
        )}
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
      </div>
      <div
        ref={stackRef}
        className="jy-chart-stack"
        tabIndex={0}
        role="img"
        aria-label={`${!showCost ? "每日收入" : showRev ? "每日收入与上游成本" : "每日上游成本"}${hasFixed ? "、固定成本" : ""}折线图${showProfit ? "，以及每日净利柱状图" : ""}，可用左右方向键逐日查看`}
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
                  {axisMoney(t, yt.step)}
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
              {!showProfit && xLabels(HL)}
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
        {showProfit && (
          <>
            <div className="jy-chart-sub">
              <h3>每日净利</h3>
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
                      {axisMoney(t, bt.step)}
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
            <TipBody title={dayTitle(hr, asOfText)} rows={tipRows} />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {spoken}
      </div>
    </>
  );
}

// showCost=false：只有日期和收入两列，也不写合计行（收入合计在同页的利润等式里，同一个数一页只出现一次）
function TrendTable({
  rows,
  showRev,
  showCost,
  revApprox,
  asOfText,
}: {
  rows: Row[];
  showRev: boolean;
  showCost: boolean;
  revApprox: boolean;
  asOfText?: string | null;
}) {
  const approx = rows.some((r) => r.missing || r.partial);
  const revAll = approx || revApprox;
  const sum = (f: (r: Row) => number | null) => round2(rows.reduce((a, r) => a + (f(r) || 0), 0));
  const rev = showRev ? sum((r) => r.rev) : null;
  const cost = sum((r) => r.cost);
  const fixed = sum((r) => r.fixed);
  const gross = rev == null ? null : round2(rev - cost);
  const profit = gross == null ? null : round2(gross - fixed);
  const maybe = (v: number | null, partial?: boolean) =>
    v == null ? <span className="jy-muted">{EMPTY}</span> : formatMoney(v, { approx: partial });
  return (
    <div className="jy-table-scroll">
      <table className="jy-data jy-data--compact jy-num">
        <thead>
          <tr>
            <th scope="col">日期</th>
            {showRev && <th scope="col" className="r">收入</th>}
            {showCost && (
              <>
                <th scope="col" className="r">上游成本</th>
                {showRev && <th scope="col" className="r">毛利</th>}
                <th scope="col" className="r">固定成本</th>
                {showRev && <th scope="col" className="r">净利</th>}
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows
            .slice()
            .reverse()
            .map((r) => (
              <tr key={r.date}>
                <td>{dayTitle(r, asOfText)}</td>
                {showRev && <td className="r">{formatMoney(r.rev, { approx: revApprox })}</td>}
                {showCost && (
                  <>
                    <td className="r">{r.cost == null ? <span className="jy-muted">数据缺失</span> : formatMoney(r.cost, { approx: r.partial })}</td>
                    {showRev && <td className="r">{maybe(r.gross, r.partial || revApprox)}</td>}
                    <td className="r">{formatMoney(r.fixed)}</td>
                    {showRev && <td className="r">{maybe(r.profit, r.partial || revApprox)}</td>}
                  </>
                )}
              </tr>
            ))}
        </tbody>
        {showCost && (
          <tfoot>
            <tr>
              <th scope="row">合计 {rows.length} 天</th>
              {showRev && <td className="r">{formatMoney(rev, { approx: revApprox })}</td>}
              <td className="r">{formatMoney(cost, { approx })}</td>
              {showRev && <td className="r">{formatMoney(gross, { approx: revAll })}</td>}
              <td className="r">{formatMoney(fixed)}</td>
              {showRev && <td className="r">{formatMoney(profit, { approx: revAll })}</td>}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
