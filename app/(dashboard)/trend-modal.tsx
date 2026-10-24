"use client";
// 余额趋势弹窗（共享组件）：运营总览和上游列表点「余额趋势」时打开。
// 上方四个读数，下方是余额折线：实线是读到的余额，虚线按日均花费往后估到用完（最多估一个查看范围）。
// 数据：GET /api/stations/:id/history?hours=；图和花费按上游设置的汇率折成 ¥，没设置时按 1 美元 = 1 元；当前余额和上游列表同一种写法（balanceMoneyOf）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Modal } from "antd";
import { api } from "../../lib/client";
import { balanceMoneyOf, rateSnapshotOf } from "../../lib/profit";
import {
  axisMoney, BALANCE_STATE_TEXT, basisText, EMPTY, formatCompact, formatMoney, formatZonedDate, formatZonedDateTime, formatZonedTime, RANGE_TEXT, RATE_UNSET,
} from "../../lib/format";
import { isDayStartInTz } from "../../lib/business-time";
import { balanceDaysText, balanceViewOf, burnCellText, isSpending, stationDisplayName } from "../../lib/overview-actions";
import { clamp, niceTicks, timeAxisTicks } from "../../lib/chart-math";
import { ErrorState } from "../components/data-state";
import { ChartTip, TipBody } from "../components/float-tip";
import { useElementWidth } from "../components/use-width";
import { Seg } from "../components/seg";
import { Sym } from "../components/icons";

// 时间选项的名字和其他页同一份（RANGE_TEXT）
const RANGES = [
  { label: RANGE_TEXT["24h"], value: "24" },
  { label: RANGE_TEXT["3d"], value: "72" },
  { label: RANGE_TEXT["7d"], value: "168" },
  { label: RANGE_TEXT["30d"], value: "720" },
] as const;
type Range = (typeof RANGES)[number]["value"];

// 弹窗的名字：运营总览和上游列表的按钮、弹窗标题都用这一份
export const TREND_TEXT = Object.freeze({
  title: "余额趋势",
  of: (name: string) => `${name} 的余额趋势`,
});

// 只在这个弹窗出现的说法（design/ui-copy-spec.md §3.3）
const COPY = Object.freeze({
  balance: "余额",
  estimated: "估算余额",
  now: "现在",
  about: (time: string) => `约 ${time}`,
  emptyAt: (time: string) => `约 ${time} 用完`,
  current: "当前余额",
  today: "今天花费",
  todayTokens: (tokens: string) => `${tokens} Token`,
  todayRequests: (count: string) => `${count} 次请求`,
  burn: "日均花费",
  notEnough: "读到的余额还太少，暂时估不出",
  days: "可用天数",
  range: "查看范围",
  readFailed: "读不到余额趋势",
  loading: "正在读取余额记录…",
  tooFew: (range: string) => `${range}还画不出余额趋势`,
  tooFewDesc: "至少读到两次余额，这里才会画出余额的变化。",
  chart: (name: string, range: string, emptyAt: string) => `${name} ${range}的余额趋势${emptyAt ? `，${emptyAt}` : ""}`,
});

const L = 52;
const R = 16;
const T = 16;
const B = 28;
const H = 240;
const HOUR = 3_600_000;

// 时间都按业务时区写（design/ui-copy-spec.md §6），和浏览器所在时区无关：「10月9日 14:30」
const at = (ms: number, tz: string) => formatZonedDateTime(ms, tz);

// 横轴刻度（lib/chart-math.js 的 timeAxisTicks，按业务时区落点），保证每个标签至少有 72px。
// 0 点写日期「10月10日」，其余写时刻「3:00」
function timeTicks(t0: number, t1: number, plotW: number, tz: string) {
  const { ticks, daily } = timeAxisTicks(t0, t1, plotW / 72, tz);
  const label = (t: number) => (daily || isDayStartInTz(t, tz) ? formatZonedDate(t, tz) : formatZonedTime(t, tz));
  return { ticks, label };
}

type Proj = { t: number; v: number; hitsZero: boolean };

function BalanceChart({ points, proj, label, tz }: { points: [number, number][]; proj: Proj | null; label: string; tz: string }) {
  const [ref, w] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const t0 = points[0][0];
  const last = points[n - 1];
  const t1 = proj ? proj.t : last[0];
  const pw = Math.max(1, w - L - R);
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * pw;
  const yt = niceTicks(0, Math.max(0, ...points.map((p) => p[1])), 4);
  const y = (v: number) => T + (1 - v / yt.hi) * (H - T - B);
  const xt = timeTicks(t0, t1, pw, tz);

  const line = useMemo(
    () => (w ? points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("") : ""),
    [points, w, t1, yt.hi],
  );

  // 可悬停的点：全部历史点，外加估算的终点
  const count = n + (proj ? 1 : 0);
  const pointAt = (i: number): [number, number] => (i < n ? points[i] : [proj!.t, proj!.v]);
  const nearest = (t: number) => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pointAt(mid)[0] < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && t - pointAt(lo - 1)[0] < pointAt(lo)[0] - t) lo--;
    return lo;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!w) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setHover(nearest(t0 + ((clamp(px, L, w - R) - L) / pw) * (t1 - t0)));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => (h == null ? count - 1 : clamp(h + d, 0, count - 1)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(count - 1);
    } else if (e.key === "Escape") setHover(null);
  };

  const hp = hover != null ? pointAt(hover) : null;
  const isProj = hover != null && hover >= n;
  const hx = hp ? x(hp[0]) : 0;
  const tipTitle = hp ? (isProj ? COPY.about(at(hp[0], tz)) : at(hp[0], tz)) : "";
  const tipRows: [string, string, string?][] = hp
    ? isProj
      ? [[proj!.hitsZero ? BALANCE_STATE_TEXT.empty : COPY.estimated, formatMoney(hp[1]), "var(--jy-ink-3)"]]
      : [[COPY.balance, formatMoney(hp[1]), "var(--jy-s1)"]]
    : [];
  // 用完的时间写在图例里：写在点旁边会压到斜着落下来的估算线
  const zx = proj?.hitsZero ? x(proj.t) : 0;

  return (
    <>
      {proj && (
        <div className="jy-legend">
          <span>
            <i className="line-key" style={{ background: "var(--jy-s1)" }} />
            {COPY.balance}
          </span>
          <span>
            <i className="line-key line-key--dash" />
            {COPY.estimated}
          </span>
          {proj.hitsZero && (
            <span>
              <Sym kind="crit" className="jy-status--crit" />
              {COPY.emptyAt(at(proj.t, tz))}
            </span>
          )}
        </div>
      )}
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
          {w > 0 && (
            <svg viewBox={`0 0 ${w} ${H}`} height={H} aria-hidden="true">
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
              {xt.ticks.map((t) => (
                <text key={t} className="tick-label" data-axis="x" x={x(t)} y={H - 8} textAnchor="middle">
                  {xt.label(t)}
                </text>
              ))}
              {proj && (
                <>
                  <line className="day-rule" x1={x(last[0])} x2={x(last[0])} y1={T} y2={H - B} />
                  {/* 预测段很短时「现在」贴着右边缘，改放到竖线左侧 */}
                  <text
                    className="tick-label"
                    x={x(last[0]) + 36 > w ? x(last[0]) - 6 : x(last[0]) + 6}
                    y={T + 12}
                    textAnchor={x(last[0]) + 36 > w ? "end" : "start"}
                  >
                    {COPY.now}
                  </text>
                  <path
                    className="series"
                    style={{ stroke: "var(--jy-ink-3)", strokeDasharray: "5 4" }}
                    d={`M${x(last[0]).toFixed(1)},${y(last[1]).toFixed(1)}L${x(proj.t).toFixed(1)},${y(proj.v).toFixed(1)}`}
                  />
                </>
              )}
              <path className="series" style={{ stroke: "var(--jy-s1)" }} d={line} />
              {proj?.hitsZero && (
                <path
                  className="hover-dot"
                  d={`M${zx},${y(0) - 6}L${zx + 6},${y(0)}L${zx},${y(0) + 6}L${zx - 6},${y(0)}Z`}
                  style={{ fill: "var(--jy-crit)" }}
                />
              )}
              {hp && (
                <>
                  <line className="cross" x1={hx} x2={hx} y1={T} y2={H - B} />
                  <circle
                    className="hover-dot"
                    r={4.5}
                    cx={hx}
                    cy={y(hp[1])}
                    style={{ fill: isProj ? "var(--jy-ink-3)" : "var(--jy-s1)" }}
                  />
                </>
              )}
            </svg>
          )}
        </div>
        {hp && (
          <ChartTip x={hx} width={w}>
            <TipBody title={tipTitle} rows={tipRows} />
          </ChartTip>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {hp ? `${tipTitle}：${tipRows[0][0]} ${tipRows[0][1]}` : ""}
      </div>
    </>
  );
}

// station 为 null 时不渲染（弹窗关闭）；传入列表里的最新上游对象，读数随轮询更新。etaDaysRule 是提醒天数，可用天数在它以内标红
export default function TrendModal({
  station,
  onClose,
  settings,
  rules,
  tz,
}: {
  station: any | null;
  onClose: () => void;
  // 余额提醒线和提醒天数，和打开它的页面用同一份
  settings?: any;
  rules?: any;
  // 业务时区（接口返回的 tz）：图上的时刻、横轴刻度、预计用完的时间都按它写。必填，免得调用方漏传就退回默认时区
  tz: string;
}) {
  const [range, setRange] = useState<Range>("72");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const seq = useRef(0); // 丢弃过期响应：快速切换上游或范围时，慢的那次不能覆盖后打开的图
  const stationId = station?.id ?? null;
  const hours = Number(range);

  // 打开（或换上游）时重置范围与数据
  useEffect(() => {
    if (!stationId) return;
    setRange("72");
    setData(null);
    setErr(null);
  }, [stationId]);

  useEffect(() => {
    if (!stationId) return;
    const s = ++seq.current;
    setLoading(true);
    setErr(null);
    api(`/api/stations/${stationId}/history?hours=${hours}`)
      .then((r) => {
        if (s === seq.current) setData(r);
      })
      .catch((e) => {
        if (s !== seq.current) return;
        setData(null);
        setErr(e);
      })
      .finally(() => {
        if (s === seq.current) setLoading(false);
      });
  }, [stationId, hours, retry]);

  const rate = rateSnapshotOf(station).cnyPerUsd;
  const pred = data?.prediction;
  const burn = isSpending(pred) ? pred.burnPerDay * rate : 0;
  const points: [number, number][] = useMemo(
    () => (data?.points || []).map((p: any) => [Number(p[0]), p[1] * rate] as [number, number]),
    [data, rate],
  );

  // 估算段最多延伸一个查看范围的长度，避免把读到的那段压扁
  const proj: Proj | null = useMemo(() => {
    if (points.length < 2 || !(burn > 0) || pred?.etaDays == null) return null;
    const t0 = points[0][0];
    const [lastT, lastV] = points[points.length - 1];
    const etaMs = new Date(pred.etaAt).getTime();
    const cap = lastT + Math.max(lastT - t0, HOUR);
    if (etaMs <= cap) return { t: etaMs, v: 0, hitsZero: true };
    return { t: cap, v: Math.max(lastV - burn * ((cap - lastT) / (24 * HOUR)), 0), hitsZero: false };
  }, [points, burn, pred]);

  const b = station?.balance;
  const money = b?.ok ? balanceMoneyOf(station, b.remaining) : null;
  // 档位、颜色、可用天数和上游列表、运营总览同一个判断（balanceViewOf），估算用弹窗刚读到的那份；
  // 不再续费的和自营站点不上颜色，也不标档位
  const view = station ? balanceViewOf(pred ? { ...station, prediction: pred } : station, { settings, rules }) : null;
  const empty = view?.state === "empty";
  const level = view?.level === "crit" || view?.level === "warn" ? view.level : null;
  const stateText = level && (view?.state === "empty" || view?.state === "low" || view?.state === "soon") ? BALANCE_STATE_TEXT[view.state] : null;
  const today = [
    station?.todayTokens != null ? COPY.todayTokens(formatCompact(station.todayTokens)) : null,
    station?.todayRequests != null ? COPY.todayRequests(station.todayRequests.toLocaleString("en-US")) : null,
  ].filter(Boolean);
  const rangeLabel = RANGES.find((r) => r.value === range)?.label;

  return (
    <Modal
      className="responsive-modal trend-modal"
      title={station ? TREND_TEXT.of(stationDisplayName(station)) : ""}
      open={!!station}
      onCancel={() => {
        seq.current++;
        onClose();
      }}
      footer={null}
      width={760}
      centered
    >
      {station && (
        <div className="jy-trend">
          <dl className="jy-trend-figs">
            <div>
              <dt>{COPY.current}</dt>
              <dd className="fig">{money ? money.text : EMPTY}</dd>
              {money
                ? <dd title={money.note}>{money.cny || RATE_UNSET}</dd>
                : <dd>{b ? BALANCE_STATE_TEXT.unreadable : BALANCE_STATE_TEXT.pending}</dd>}
            </div>
            <div>
              <dt>{COPY.today}</dt>
              <dd className="fig">
                {station.todayUsed != null ? formatMoney(station.todayUsed * rate, { approx: !!station.todayIsEstimate }) : EMPTY}
              </dd>
              {today.length ? <dd>{today.join("，")}</dd> : null}
            </div>
            <div>
              <dt>{COPY.burn}</dt>
              <dd className="fig">{burnCellText(station, pred)}</dd>
              <dd>{pred ? basisText(pred.basis) : COPY.notEnough}</dd>
            </div>
            <div>
              <dt>{COPY.days}</dt>
              <dd className="fig">{balanceDaysText(view)}</dd>
              {!empty && burn > 0 && pred?.etaAt ? <dd>{COPY.emptyAt(at(new Date(pred.etaAt).getTime(), tz))}</dd> : null}
              {stateText ? (
                <dd>
                  <span className={`jy-status jy-status--${level}`}>
                    <Sym kind={level!} />
                    {stateText}
                  </span>
                </dd>
              ) : null}
            </div>
          </dl>

          <div className="jy-trend-bar">
            <Seg<Range> options={[...RANGES]} value={range} onChange={setRange} label={COPY.range} size="sm" />
          </div>

          <div className="jy-trend-body" aria-busy={loading}>
            {err !== null ? (
              <ErrorState center what={COPY.readFailed} error={err} onRetry={() => setRetry((n) => n + 1)} retrying={loading} />
            ) : !data ? (
              <div className="jy-state jy-state--center">
                <p>{COPY.loading}</p>
              </div>
            ) : points.length < 2 ? (
              <div className="jy-state jy-state--center">
                <h3>{COPY.tooFew(rangeLabel || "")}</h3>
                <p>{COPY.tooFewDesc}</p>
              </div>
            ) : (
              <BalanceChart
                points={points}
                proj={proj}
                label={COPY.chart(stationDisplayName(station), rangeLabel || "", proj?.hitsZero ? COPY.emptyAt(at(proj.t, tz)) : "")}
                tz={tz}
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
