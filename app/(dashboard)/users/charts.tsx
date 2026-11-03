"use client";
// 用户运营页的几张图（design 用户运营 v5 §2、§4）：概览的每天用户消费折线、用户表里的小趋势线、抽屉里的每天柱、每小时柱、余额线。
// 都是自己画的 SVG（坐标算法在 lib/chart-math）；一张图一个色，数在悬停和表里，不在点上标。
import { useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { axisMoney, formatDayKey, formatZonedDate, formatZonedDateTime, formatZonedTime, weekdayOfDayKey } from "../../../lib/format";
import { barPath, clamp, linePath, niceTicks, runs, xTickIdx } from "../../../lib/chart-math";
import { ChartTip, TipBody } from "../../components/float-tip";
import { useElementWidth } from "../../components/use-width";
import { COPY } from "./copy";
import type { TrendDay } from "./users-format";

const L = 48, R = 16, T = 12, B = 28;
export type Metric = "cost" | "users" | "fresh";

// 刻度：金额写 ¥，人数取整
const axisText = (metric: Metric, v: number, step: number) => (metric === "cost" ? axisMoney(v, step) : String(Math.round(v)));

// 概览：每天的用户消费、每天的活跃用户（近 30 天实线，今天只到现在画成点线；补数据还没补到的天空着写字，不画 0；前 30 天虚线对比）
export function TrendChart({
  days, metric, values, prev, money, tz, asOf, height, hoverOn, label,
}: {
  days: TrendDay[]; metric: Metric;
  // 每天的数（没补到的天是 null），已经换成显示的币种
  values: (number | null)[];
  // 前 30 天同一位置的数；没有就不画虚线、不出图例
  prev: (number | null)[] | null;
  money: (usd: number) => string;
  tz: string; asOf: number; height: number; hoverOn: boolean; label: string;
}) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = days.length;
  const pw = Math.max(1, w - L - R), step = n > 1 ? pw / (n - 1) : pw;
  const x = (i: number) => L + step * i;
  const top = Math.max(0, ...values.map((v) => v ?? 0), ...(prev || []).map((v) => v ?? 0));
  const yt = niceTicks(0, metric === "cost" ? top : Math.max(top, 3), 4);
  const y = (v: number) => T + (1 - v / yt.hi) * (height - T - B);
  const gaps = runs(values.map((v, i) => v == null && i < n - 1));
  const last = n - 1;
  // 今天只到现在：昨天到今天那一段画点线，今天的点单独标出来
  const solid = linePath(values, x, y, 0, Math.max(0, last - 1));
  const lastV = values[last], prevV = values[last - 1];
  const todayLine = lastV != null && prevV != null ? `M${x(last - 1).toFixed(1)},${y(prevV).toFixed(1)}L${x(last).toFixed(1)},${y(lastV).toFixed(1)}` : "";
  const area = (() => {
    const idx = values.slice(0, last).map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
    if (idx.length < 2) return "";
    // 面积只铺在连续的一段上（遇到空着的天断开）
    let d = "", from = idx[0], prevI = idx[0];
    const close = () => { if (prevI > from) d += `M${x(from).toFixed(1)},${y(0)}${idx.filter((i) => i >= from && i <= prevI).map((i) => `L${x(i).toFixed(1)},${y(values[i] as number).toFixed(1)}`).join("")}L${x(prevI).toFixed(1)},${y(0)}Z`; };
    for (const i of idx.slice(1)) { if (i !== prevI + 1) { close(); from = i; } prevI = i; }
    close();
    return d;
  })();
  const prevLine = prev ? linePath(prev, x, y) : "";
  const ticks = xTickIdx(n, pw);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n || !hoverOn) return;
    setHover(clamp(Math.round((e.clientX - e.currentTarget.getBoundingClientRect().left - L) / step), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n || !hoverOn) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const d = e.key === "ArrowLeft" ? -1 : 1; setHover((h) => (h == null ? n - 1 : clamp(h + d, 0, n - 1))); }
    else if (e.key === "Home") { e.preventDefault(); setHover(0); }
    else if (e.key === "End") { e.preventDefault(); setHover(n - 1); }
    else if (e.key === "Escape") setHover(null);
  };
  const fmt = (v: number) => (metric === "cost" ? money(v) : COPY.overview.tipUsers(v));
  const hp = hover != null ? days[hover] : null;
  const hv = hover != null ? values[hover] : null;
  const showTip = hp != null && hv != null;
  const hx = hover != null ? x(hover) : 0;
  const tipTitle = hp ? `${formatDayKey(hp.day, tz, asOf)} ${weekdayOfDayKey(hp.day)}${hover === last ? `（${COPY.overview.todayAsOf(formatZonedTime(asOf, tz))}）` : ""}` : "";
  const tipRows: [ReactNode, ReactNode, string?][] = [];
  if (hp && hv != null) tipRows.push([COPY.overview.metrics[metric], fmt(hv), "var(--jy-s1)"]);
  if (hover != null && prev && prev[hover] != null) tipRows.push([COPY.overview.tipPrev, fmt(prev[hover]), "var(--jy-ink-3)"]);
  const topList = hp && hp.top.length ? hp.top : [];

  return (
    <>
      <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown} onBlur={() => setHover(null)}>
        <div className="jy-chart" style={{ height }}>
          {w > 0 && n > 0 && (
            <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
              <g className="grid">{yt.ticks.map((t) => <line key={t} x1={L} x2={w - R} y1={y(t)} y2={y(t)} />)}</g>
              {yt.ticks.map((t) => <text key={t} className="tick-label" x={L - 8} y={y(t) + 4} textAnchor="end">{axisText(metric, t, yt.step)}</text>)}
              {gaps.map(([a, b]) => (
                <g key={a}>
                  <rect className="jy-users-gap" x={x(a) - step / 2 + (a === 0 ? step / 2 : 0)} y={T} width={Math.max(0, x(b) - x(a) + step - (a === 0 ? step / 2 : 0))} height={height - T - B} />
                  {x(b) - x(a) + step > 90 && <text className="tick-label" x={(x(a) + x(b)) / 2} y={T + (height - T - B) / 2} textAnchor="middle">{COPY.overview.fillingChart}</text>}
                </g>
              ))}
              {prevLine && <path className="series jy-users-prev" d={prevLine} />}
              {area && <path d={area} style={{ fill: "var(--jy-s1)", opacity: 0.08 }} />}
              <path className="series" style={{ stroke: "var(--jy-s1)" }} d={solid} />
              {todayLine && <path className="series jy-users-today" style={{ stroke: "var(--jy-s1)" }} d={todayLine} />}
              {lastV != null && <circle className="hover-dot" r={4} cx={x(last)} cy={y(lastV)} style={{ fill: "var(--jy-s1)" }} />}
              {ticks.map((i) => <text key={i} className="tick-label" x={clamp(x(i), L, w - R)} y={height - 8} textAnchor={i === n - 1 ? "end" : "middle"}>{formatDayKey(days[i].day, tz, asOf).replace(/^\d+年/, "")}</text>)}
              {hp && (
                <>
                  <line className="cross" x1={hx} x2={hx} y1={T} y2={height - B} />
                  {hv != null && <circle className="hover-dot" r={4.5} cx={hx} cy={y(hv)} style={{ fill: "var(--jy-s1)" }} />}
                </>
              )}
            </svg>
          )}
        </div>
        {showTip && (
          <ChartTip x={hx} width={w}>
            <TipBody title={tipTitle} rows={tipRows} />
            {topList.length > 0 && (
              <div className="jy-users-tip-top">
                <div className="t-sub">{COPY.overview.tipTop}</div>
                {topList.map((item) => <div className="t-row" key={item.username}><span>{item.username}</span><b>{money(item.cost)}</b></div>)}
              </div>
            )}
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">{showTip ? `${tipTitle}：${tipRows.map(([k, v]) => `${k} ${v}`).join("，")}` : ""}</div>
    </>
  );
}

// 概览：每天的新消费用户（一天就 0、1、2 个，画成线是一排尖刺，所以用柱子）。一天一根，宽不超过 24px，顶上 4px 圆角；纵轴整数；
// 今天那根浅色；补数据还没补到的天不画。悬停那一天：几个第一次花钱、是谁、这天花了多少
export function FreshBars({
  days, tz, asOf, money, height, label, onOpenUser,
}: {
  days: TrendDay[]; money: (usd: number) => string; tz: string; asOf: number; height: number; label: string;
  onOpenUser?: (username: string) => void;
}) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = days.length;
  const counts = days.map((day) => (day.available ? day.newUsers : null));
  const top = Math.max(0, ...counts.map((v) => v ?? 0));
  const yt = niceTicks(0, Math.max(top, 3), 3);
  const ticks = yt.ticks.filter((t) => Number.isInteger(t));
  const Lp = 40, Rp = 12, Tp = 10, Bp = 28;
  const pw = Math.max(1, w - Lp - Rp), slot = pw / Math.max(1, n), bw = Math.min(24, Math.max(2, slot - 2));
  const y = (v: number) => Tp + (1 - v / yt.hi) * (height - Tp - Bp);
  const idx = n ? xTickIdx(n, pw) : [];
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    setHover(clamp(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - Lp) / slot), 0, n - 1));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const d = e.key === "ArrowLeft" ? -1 : 1; setHover((h) => (h == null ? n - 1 : clamp(h + d, 0, n - 1))); }
    else if (e.key === "Home") { e.preventDefault(); setHover(0); }
    else if (e.key === "End") { e.preventDefault(); setHover(n - 1); }
    else if (e.key === "Escape") setHover(null);
  };
  const hp = hover != null ? days[hover] : null;
  const hx = hover != null ? Lp + slot * (hover + 0.5) : 0;
  const last = n - 1;
  const tipTitle = hp ? `${formatDayKey(hp.day, tz, asOf)} ${weekdayOfDayKey(hp.day)}${hover === last ? `（${COPY.overview.todayAsOf(formatZonedTime(asOf, tz))}）` : ""}` : "";
  const showTip = hp != null && hp.available;
  return (
    <>
      <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown} onBlur={() => setHover(null)}>
        <div className="jy-chart" style={{ height }}>
          {w > 0 && n > 0 && (
            <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
              <g className="grid">{ticks.map((t) => <line key={t} x1={Lp} x2={w - Rp} y1={y(t)} y2={y(t)} />)}</g>
              {ticks.map((t) => <text key={t} className="tick-label" x={Lp - 6} y={y(t) + 4} textAnchor="end">{t}</text>)}
              {counts.map((v, i) => (v != null && v > 0 ? (
                <path key={days[i].day} className={`jy-chart-bar${i === last ? " is-light" : ""}${hover === i ? " is-hover" : ""}`} d={barPath(Lp + slot * (i + 0.5) - bw / 2, Math.min(y(v), y(0) - 1), y(0), bw, 4, true)} />
              ) : null))}
              {idx.map((i) => <text key={i} className="tick-label" x={clamp(Lp + slot * (i + 0.5), Lp, w - Rp)} y={height - 8} textAnchor={i === n - 1 ? "end" : "middle"}>{formatDayKey(days[i].day, tz, asOf).replace(/^\d+年/, "")}</text>)}
            </svg>
          )}
        </div>
        {showTip && hp && (
          <ChartTip x={hx} width={w}>
            <TipBody title={tipTitle} rows={[[COPY.overview.metrics.fresh, COPY.overview.tipFresh(hp.newUsers), "var(--jy-s1)"]]} />
            {hp.newTop.length > 0 && (
              <div className="jy-users-tip-top">
                <div className="t-sub">{COPY.overview.tipFreshList}</div>
                {hp.newTop.map((item) => <div className="t-row" key={item.username}><span>{item.username}</span><b>{money(item.cost)}</b></div>)}
              </div>
            )}
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">{showTip && hp ? `${tipTitle}：${COPY.overview.tipFresh(hp.newUsers)}${hp.newTop.length ? `，${hp.newTop.map((item) => `${item.username} ${money(item.cost)}`).join("，")}` : ""}` : ""}</div>
    </>
  );
}

// 用户表里的小趋势线：96 × 24，一天一个点，最后一个点画圆；没有坐标轴；在下滑、已流失的灰线
export function SparkLine({ values, gray, label, width = 96, height = 24 }: { values: (number | null)[]; gray?: boolean; label: string; width?: number; height?: number }) {
  const pad = 2, n = values.length;
  const nums = values.filter((v): v is number => v != null);
  if (n < 2 || !nums.length) return null;
  const max = Math.max(...nums), hi = max > 0 ? max : 1;
  const x = (i: number) => pad + (i / (n - 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - v / hi) * (height - 2 * pad);
  let end = n - 1;
  while (end > 0 && values[end] == null) end -= 1;
  return (
    <svg className={`jy-users-spark${gray ? " is-gray" : ""}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}>
      <path className="line" d={linePath(values, x, y)} />
      {values[end] != null && <circle className="dot" cx={x(end)} cy={y(values[end] as number)} r={2.5} />}
    </svg>
  );
}

// 抽屉：余额变化的线，往上跳的那一下是充值，标一个点；悬停写那一刻的余额
export function BalanceLine({
  points, recharges, tz, money, rate, height = 160, label,
}: {
  points: { t: number; usd: number }[]; recharges: { t: number; usd: number }[];
  // money 收美元；rate 是自营站点的汇率：刻度和线都要换成显示的币种，和悬停里的数一个单位
  tz: string; money: (usd: number) => string; rate: number; height?: number; label: string;
}) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const t0 = points[0]?.t ?? 0, t1 = points[n - 1]?.t ?? 1;
  const yt = niceTicks(0, Math.max(0, ...points.map((p) => p.usd * rate)), 3);
  const Lp = 48, Rp = 12, Tp = 10, Bp = 24;
  const pw = Math.max(1, w - Lp - Rp);
  const x = (t: number) => Lp + ((t - t0) / (t1 - t0 || 1)) * pw;
  const y = (v: number) => Tp + (1 - v / yt.hi) * (height - Tp - Bp);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.usd * rate).toFixed(1)}`).join("");
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w || !n) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0, gap = Infinity;
    points.forEach((p, i) => { const d = Math.abs(x(p.t) - px); if (d < gap) { gap = d; best = i; } });
    setHover(best);
  };
  const hp = hover != null ? points[hover] : null;
  return (
    <div ref={ref} className="jy-chart-stack" tabIndex={0} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} onKeyDown={(e) => { if (e.key === "Escape") setHover(null); }}>
      <div className="jy-chart" style={{ height }}>
        {w > 0 && n > 1 && (
          <svg viewBox={`0 0 ${w} ${height}`} height={height} aria-hidden="true">
            <g className="grid">{yt.ticks.map((t) => <line key={t} x1={Lp} x2={w - Rp} y1={y(t)} y2={y(t)} />)}</g>
            {yt.ticks.map((t) => <text key={t} className="tick-label" x={Lp - 6} y={y(t) + 4} textAnchor="end">{axisMoney(t, yt.step)}</text>)}
            <path className="series" style={{ stroke: "var(--jy-s1)" }} d={line} />
            {recharges.map((r) => {
              const at = points.find((p) => p.t === r.t);
              if (!at) return null;
              // 充值那一下标点和字；手机上只写「充值 ¥1,000.00」，贴边的靠里写
              const text = w < 440 ? COPY.drawer.rechargeShort(money(r.usd)) : COPY.drawer.recharge(formatZonedDate(r.t, tz, t1), money(r.usd));
              const px = x(r.t), anchor = px > w - 150 ? "end" : "start";
              return (
                <g key={r.t}>
                  <circle className="hover-dot" r={4.5} cx={px} cy={y(at.usd * rate)} style={{ fill: "var(--jy-s1)" }} />
                  <text className="end-label" x={anchor === "end" ? px - 8 : px + 8} y={Math.max(Tp + 10, y(at.usd * rate) - 8)} textAnchor={anchor}>{text}</text>
                </g>
              );
            })}
            <text className="tick-label" x={Lp} y={height - 6} textAnchor="start">{formatZonedDate(t0, tz, t1)}</text>
            <text className="tick-label" x={w - Rp} y={height - 6} textAnchor="end">{formatZonedDate(t1, tz, t1)}</text>
            {hp && (
              <>
                <line className="cross" x1={x(hp.t)} x2={x(hp.t)} y1={Tp} y2={height - Bp} />
                <circle className="hover-dot" r={4} cx={x(hp.t)} cy={y(hp.usd * rate)} style={{ fill: "var(--jy-s1)" }} />
              </>
            )}
          </svg>
        )}
      </div>
      {hp && (
        <ChartTip x={x(hp.t)} width={w}>
          <TipBody title={formatZonedDateTime(hp.t, tz, t1)} rows={[[COPY.drawer.kpiBalance, money(hp.usd), "var(--jy-s1)"], ...recharges.filter((r) => r.t === hp.t).map((r): [ReactNode, ReactNode] => [COPY.drawer.rechargeShort(money(r.usd)), ""])]} />
        </ChartTip>
      )}
    </div>
  );
}
