"use client";
// 余额趋势详情弹窗（共享组件）：运营总览与上游资源页点击余额走势时打开。
// 上方四个读数，下方是余额折线：实线为历史，虚线按当前消耗速度往后推到用完（最多推一个查看窗口）。
// 数据：GET /api/stations/:id/history?hours=；金额按资源的充值汇率折算成 ¥。
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Button, Modal } from "antd";
import { api, rateOf, fmtTokens } from "../../lib/client";
import { axisMoney, formatDays, formatHhmm, formatMoney, formatMonthDay, formatUsd } from "../../lib/format";
import { clamp, niceTicks } from "../../lib/chart-math";
import { ChartTip, TipBody } from "../components/float-tip";
import { useElementWidth } from "../components/use-width";
import { Seg } from "../components/seg";
import { Sym } from "../components/icons";

// 文案与其他页的时间选项统一用「近 N 小时 / 近 N 天」
const RANGES = [
  { label: "近 24 小时", value: "24" },
  { label: "近 3 天", value: "72" },
  { label: "近 7 天", value: "168" },
  { label: "近 30 天", value: "720" },
] as const;
type Range = (typeof RANGES)[number]["value"];

const L = 52;
const R = 16;
const T = 16;
const B = 28;
const H = 240;
const HOUR = 3_600_000;

const at = (ms: number) => `${formatMonthDay(ms)} ${formatHhmm(ms)}`;

// 服务端给的估算依据：近3小时 / 近12小时 / 回归
function basisText(basis: string | undefined) {
  if (!basis || basis === "回归") return "按近期走势估算";
  return `按${basis.replace(/(\d+)/, " $1 ")}的消耗估算`;
}

// 横轴刻度：按跨度选 1 小时到 7 天的整点间隔，保证每个标签至少有 72px
function timeTicks(t0: number, t1: number, plotW: number) {
  const span = Math.max(HOUR, t1 - t0);
  const maxTicks = Math.max(2, Math.floor(plotW / 72));
  const steps = [1, 2, 3, 6, 12, 24, 48, 72, 168].map((h) => h * HOUR);
  const step = steps.find((s) => span / s <= maxTicks) ?? steps[steps.length - 1];
  const start = new Date(t0);
  if (step >= 24 * HOUR) start.setHours(0, 0, 0, 0);
  else start.setMinutes(0, 0, 0);
  const ticks: number[] = [];
  for (let t = start.getTime(); t <= t1; t += step) {
    // 跨夏令时等情况下按本地整点重新对齐
    const d = new Date(t);
    if (step >= 24 * HOUR) d.setHours(0, 0, 0, 0);
    if (d.getTime() >= t0) ticks.push(d.getTime());
  }
  const daily = step >= 24 * HOUR;
  const label = (t: number) => {
    const d = new Date(t);
    return daily || (d.getHours() === 0 && d.getMinutes() === 0) ? formatMonthDay(d) : formatHhmm(d);
  };
  return { ticks, label };
}

type Proj = { t: number; v: number; hitsZero: boolean };

function BalanceChart({ points, proj, label }: { points: [number, number][]; proj: Proj | null; label: string }) {
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
  const xt = timeTicks(t0, t1, pw);

  const line = useMemo(
    () => (w ? points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("") : ""),
    [points, w, t1, yt.hi],
  );

  // 可悬停的点：全部历史点，外加推算终点
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
  const tipTitle = hp ? (isProj ? `约 ${at(hp[0])}` : at(hp[0])) : "";
  const tipRows: [string, string, string?][] = hp
    ? isProj
      ? [[proj!.hitsZero ? "预计余额用完" : "推算余额", formatMoney(hp[1]), "var(--jy-ink-3)"]]
      : [["余额", formatMoney(hp[1]), "var(--jy-s1)"]]
    : [];
  // 用完的时间写在图例里：写在点旁边会压到斜着落下来的推算线
  const zx = proj?.hitsZero ? x(proj.t) : 0;

  return (
    <>
      {proj && (
        <div className="jy-legend">
          <span>
            <i className="line-key" style={{ background: "var(--jy-s1)" }} />
            余额
          </span>
          <span>
            <i className="line-key line-key--dash" />
            按当前消耗速度推算
          </span>
          {proj.hitsZero && (
            <span>
              <Sym kind="crit" className="jy-status--crit" />约 {at(proj.t)} 用完
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
                <text key={t} className="tick-label" x={x(t)} y={H - 8} textAnchor="middle">
                  {xt.label(t)}
                </text>
              ))}
              {proj && (
                <>
                  <line className="day-rule" x1={x(last[0])} x2={x(last[0])} y1={T} y2={H - B} />
                  <text className="tick-label" x={x(last[0]) + 6} y={T + 12}>
                    现在
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

// station 为 null 时不渲染（弹窗关闭）；传入列表里的最新资源对象，读数随轮询更新
export default function TrendModal({
  station,
  onClose,
  etaDaysRule = 3,
}: {
  station: any | null;
  onClose: () => void;
  etaDaysRule?: number;
}) {
  const [range, setRange] = useState<Range>("72");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const seq = useRef(0); // 丢弃过期响应：快速切换资源或范围时，慢的那次不能覆盖后打开的图
  const stationId = station?.id ?? null;
  const hours = Number(range);

  // 打开（或换资源）时重置范围与数据
  useEffect(() => {
    if (!stationId) return;
    setRange("72");
    setData(null);
    setErr("");
  }, [stationId]);

  useEffect(() => {
    if (!stationId) return;
    const s = ++seq.current;
    setLoading(true);
    setErr("");
    api(`/api/stations/${stationId}/history?hours=${hours}`)
      .then((r) => {
        if (s === seq.current) setData(r);
      })
      .catch((e) => {
        if (s !== seq.current) return;
        setData(null);
        setErr(e.message);
      })
      .finally(() => {
        if (s === seq.current) setLoading(false);
      });
  }, [stationId, hours, retry]);

  const rate = station ? rateOf(station) : 1;
  const pred = data?.prediction;
  const burn = pred?.burnPerDay > 0 ? pred.burnPerDay * rate : 0;
  const points: [number, number][] = useMemo(
    () => (data?.points || []).map((p: any) => [Number(p[0]), p[1] * rate] as [number, number]),
    [data, rate],
  );

  // 推算段最多延伸一个历史窗口的长度，避免把历史压扁
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
  const empty = b?.ok && b.remaining <= 0;
  const etaDays = pred?.etaDays;
  const level = etaDays == null || !(burn > 0) ? null : etaDays <= etaDaysRule ? "crit" : etaDays <= 7 ? "warn" : null;
  const today = [
    station?.todayTokens != null ? `${fmtTokens(station.todayTokens)} tokens` : null,
    station?.todayRequests != null ? `${station.todayRequests.toLocaleString("en-US")} 次请求` : null,
  ].filter(Boolean);
  const rangeLabel = RANGES.find((r) => r.value === range)?.label;

  return (
    <Modal
      className="responsive-modal trend-modal"
      title={station ? `${station.name} 的余额趋势` : ""}
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
              <dt>当前余额</dt>
              <dd className="fig">{b?.ok ? formatMoney(b.remaining * rate) : "—"}</dd>
              {b && !b.ok ? <dd>最近一次查询失败</dd> : null}
              {b?.ok && rate !== 1 ? <dd>站点余额 {formatUsd(b.remaining)}</dd> : null}
            </div>
            <div>
              <dt>今日消耗</dt>
              <dd className="fig">
                {station.todayUsed != null ? formatMoney(station.todayUsed * rate, { approx: !!station.todayIsEstimate }) : "—"}
              </dd>
              {today.length ? <dd>{today.join("，")}</dd> : null}
            </div>
            <div>
              <dt>日均消耗</dt>
              <dd className="fig">{burn > 0 ? formatMoney(burn) : pred ? formatMoney(0) : "—"}</dd>
              <dd>{pred ? basisText(pred.basis) : "查询次数不足，暂无法估算"}</dd>
            </div>
            <div>
              <dt>预计可用</dt>
              <dd className="fig">{empty ? "已用完" : burn > 0 && etaDays != null ? formatDays(etaDays) : "—"}</dd>
              {!empty && burn > 0 && pred?.etaAt ? <dd>约 {at(new Date(pred.etaAt).getTime())} 用完</dd> : null}
              {!empty && pred && !(burn > 0) ? <dd>近期没有消耗</dd> : null}
              {!empty && level ? (
                <dd>
                  <span className={`jy-status jy-status--${level}`}>
                    <Sym kind={level} />
                    {level === "crit" ? `${etaDaysRule} 天内用完` : "7 天内用完"}
                  </span>
                </dd>
              ) : null}
            </div>
          </dl>

          <div className="jy-trend-bar">
            <Seg<Range> options={[...RANGES]} value={range} onChange={setRange} label="查看范围" size="sm" />
          </div>

          <div className="jy-trend-body" aria-busy={loading}>
            {err ? (
              <div className="jy-state jy-state--center">
                <h3>
                  <Sym kind="crit" className="jy-status--crit" />
                  趋势没有读取成功
                </h3>
                <p>{err}</p>
                <Button size="small" onClick={() => setRetry((n) => n + 1)}>
                  重新读取
                </Button>
              </div>
            ) : !data ? (
              <div className="jy-state jy-state--center">
                <p>正在读取余额记录…</p>
              </div>
            ) : points.length < 2 ? (
              <div className="jy-state jy-state--center">
                <h3>近 {rangeLabel}还没有形成走势</h3>
                <p>完成至少两次成功的余额查询后，这里会显示余额变化。</p>
              </div>
            ) : (
              <BalanceChart
                points={points}
                proj={proj}
                label={`${station.name} ${rangeLabel}的余额走势${proj?.hitsZero ? `，按当前速度约 ${at(proj.t)} 用完` : ""}`}
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
