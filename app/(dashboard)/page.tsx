"use client";
// 运营总览：核心经营指标 + 健康摘要 + 余额趋势 + 上游资源摘要
// 功能与口径逐条对照 v1 app.js：renderDashboard / drawTotalChart / drawBurnBars / stationRow
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import LastRefreshed from "./last-refreshed";
import { Alert, App, Button, Col, Empty, Grid, Row, Segmented, Typography, theme } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { Line, Bar } from "@ant-design/plots";
import { api, cny, usd, rateOf, fmtTokens, fmtEta, statusOf } from "../../lib/client";
import ChartBox from "./chart-box";
import TrendModal from "./trend-modal";
import { useThemeMode } from "../providers";
import AppState from "../components/app-state";
import { buildOverviewActions } from "../../lib/overview-actions";
import { describeConnectionFailure } from "../../lib/connection-test";

const { Text } = Typography;

// 图表本体统一固定高度（全站规范：同排卡片等高）
const CHART_H = 300;

// 图表卡统一两行头：标题一行 + 副标题换行放下方（全站规范，解决标题副标题拥挤）
function CardTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", whiteSpace: "normal" }}>{sub}</Text>
    </div>
  );
}

// ---- v1 工具函数平移（app.js 同名实现，行为逐字对齐）------------------------

// 相对时间（app.js relTime）
function relTime(iso: string | null | undefined): string {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}

// 月/日 时:分（app.js fmtClock）
function fmtClock(ts: number | string | Date): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 预测文案（app.js etaText）：≈¥/天 + 预计耗尽；阈值内标红/橙
function etaText(p: any, rate: number, rules: any): { text: string; cls: string } | null {
  if (!p) return null;
  if (p.burnPerDay === 0) return { text: `${p.basis || "近期"}无消耗`, cls: "" };
  if (p.etaDays == null) return null;
  const cls = p.etaDays <= (rules?.etaDays ?? 3) ? "danger" : p.etaDays <= 7 ? "warn" : "";
  return { text: `≈ ${cny(p.burnPerDay * rate)}/天（${p.basis || "估算"}）· 预计 ${fmtEta(p.etaDays)}后耗尽`, cls };
}

// CJK 按 2 个单位计宽的标签截断（app.js truncateLabel）
function truncateLabel(s: any, units = 14): string {
  let u = 0, out = "";
  for (const ch of String(s)) {
    u += /[⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1;
    if (u > units) return out + "…";
    out += ch;
  }
  return String(s);
}

// 状态同时使用色点与文字表达，避免只依赖颜色。
function StatusText({ st }: { st: string }) {
  const labels: Record<string, string> = {
    ok: "正常", warn: "余额偏低", danger: "已耗尽", error: "查询失败", pending: "待刷新",
  };
  const status = labels[st] ? st : "pending";
  return (
    <span className={`resource-status resource-status--${status}`}>
      <span className="resource-status__dot" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}

// 站点卡片里的迷你余额走势（app.js sparkSvg 平移为 JSX）：陡降 = 消耗快，平线 = 闲置，跳升 = 充值
function SparkSvg({ pts }: { pts: [number, number][] | null }) {
  const { token } = theme.useToken();
  if (!pts || pts.length < 2) return null;
  const W = 170, H = 30, P = 3;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let min = Infinity, max = -Infinity;
  for (const [, v] of pts) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 1e-9) { min -= 1; max += 1; } // 余额没变化时画一条居中的平线
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - min) / (max - min)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${H - P}L${x(t0).toFixed(1)},${H - P}Z`;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={170} height={30} aria-hidden="true" style={{ display: "block", maxWidth: "100%" }}>
      <path d={area} fill={token.colorPrimaryBg} />
      <path d={line} fill="none" stroke={token.colorPrimary} strokeWidth={1.5} />
      <circle cx={x(last[0]).toFixed(1)} cy={y(last[1]).toFixed(1)} r={2.5} fill={token.colorPrimary} />
    </svg>
  );
}

function PrimaryMetric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <article className="overview-primary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub || "\u00a0"}</small>
    </article>
  );
}

function HealthItem({ label, value, tone = "default", detail }: { label: string; value: React.ReactNode; tone?: "default" | "warning" | "danger"; detail: string }) {
  return (
    <div className={`overview-health-item overview-health-item--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

// 图表占位（对应 v1 .chart-empty）
function ChartEmpty({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ height: CHART_H, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextSecondary, fontSize: 13 }}>
      {text}
    </div>
  );
}

// 趋势图范围选项（app.js RANGES）
const RANGES = [
  { label: "24 小时", value: 24 },
  { label: "3 天", value: 72 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

export default function OverviewPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const { dark } = useThemeMode();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [stations, setStations] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [types, setTypes] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [loadingStations, setLoadingStations] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [trendHours, setTrendHours] = useState(24);
  // 总览趋势数据缓存 {hours, series}（对应 v1 state.overview）
  const [overview, setOverview] = useState<{ hours: number; series: any[] } | null>(null);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  // 趋势详情弹窗（共享组件 TrendModal，与上游资源页点击行为一致）
  const [trendStation, setTrendStation] = useState<any>(null);
  const hoursRef = useRef(trendHours);
  hoursRef.current = trendHours;

  const typeLabel = useCallback((v: string) => types.find((t) => t.value === v)?.label || v, [types]);

  // 拉站点列表（对应 v1 reload）
  const reload = useCallback(async () => {
    setLoadingStations(true);
    try {
      const r = await api("/api/stations");
      setStations(r.stations);
      setSettings(r.settings);
      setLoaded(true);
      setLoadError(null);
      setRefreshedAt(Date.now());
    } catch (e: any) {
      setLoadError(e.message || "运营总览加载失败");
      throw e;
    } finally {
      setLoadingStations(false);
    }
  }, []);

  // 拉总览趋势（对应 v1 mountOverviewChart 的数据部分）
  const loadOverview = useCallback(async (hours: number) => {
    try {
      const r = await api(`/api/history/overview?hours=${hours}`);
      // 范围已被用户切走则丢弃过期响应
      if (hoursRef.current === hours) {
        setOverview({ hours, series: r.series });
        setOverviewErr(null);
      }
    } catch (e: any) {
      if (hoursRef.current === hours) setOverviewErr(e.message || "加载失败");
    }
  }, []);

  // 首次加载元信息（类型标签 + 通知规则阈值，供 etaText 用）
  useEffect(() => {
    api("/api/meta")
      .then((m) => { setTypes(m.types); setRules(m.rules); setSettings(m.settings); })
      .catch(() => {});
  }, []);

  // 30s 轮询列表 + 趋势；切回标签页立即刷新一次（同 v1 visibilitychange）
  useEffect(() => {
    const tick = () => {
      reload().catch(() => {});
      loadOverview(hoursRef.current);
    };
    tick();
    const timer = setInterval(tick, 30000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [reload, loadOverview]);

  // 切换范围立即重新拉取（缓存范围一致时先展示旧图，避免闪“加载中”）
  useEffect(() => { loadOverview(trendHours); }, [trendHours, loadOverview]);

  // 单站刷新（对应 stationRow 的刷新按钮）
  const refreshOne = async (id: string) => {
    setRefreshingId(id);
    try {
      await api(`/api/stations/${id}/refresh`, { method: "POST", body: {} });
      await reload();
    } catch (e: any) {
      message.error(e.message || "刷新失败");
    } finally {
      setRefreshingId(null);
    }
  };

  // ---- 聚合统计（renderDashboard 逐行平移）---------------------------------
  // 聚合统计只算上游：标记为自营的余额是自家 root 账号额度，混进来会污染数字
  const ups = useMemo(() => stations.filter((s) => !s.isOwn), [stations]);
  const agg = useMemo(() => {
    const okList = ups.filter((s) => s.balance?.ok);
    const anyRate = ups.some((s) => rateOf(s) !== 1);
    const totalRemaining = okList.reduce((a, s) => a + s.balance.remaining, 0);
    const totalRemainingCny = okList.reduce((a, s) => a + s.balance.remaining * rateOf(s), 0);
    const totalUsedCny = okList.reduce((a, s) => a + s.balance.used * rateOf(s), 0);
    const totalBurnCny = ups.reduce((a, s) => a + (s.prediction?.burnPerDay || 0) * rateOf(s), 0);
    const todayTotalCny = ups.reduce((a, s) => a + (s.todayUsed || 0) * rateOf(s), 0);
    // 任一站点的今日消耗是历史推算值时，合计也只能算约数
    const todayApprox = ups.some((s) => (s.todayUsed || 0) > 0 && s.todayIsEstimate);
    const lowCount = ups.filter((s) => ["warn", "danger"].includes(statusOf(s, settings))).length;
    const errCount = ups.filter((s) => statusOf(s, settings) === "error").length;
    const earliest = ups
      .filter((s) => s.prediction?.etaDays != null)
      .map((s) => ({ name: s.name, days: Number(s.prediction.etaDays) }))
      .sort((a, b) => a.days - b.days)[0] || null;
    // 今日 tokens / 请求数：只有 sub2api 站点能提供，有数据才显示
    const tokList = ups.filter((s) => s.todayTokens != null);
    const reqList = ups.filter((s) => s.todayRequests != null);
    const subBits: string[] = [];
    if (tokList.length) subBits.push(`${fmtTokens(tokList.reduce((a, s) => a + s.todayTokens, 0))} tokens`);
    if (reqList.length) subBits.push(`${reqList.reduce((a, s) => a + s.todayRequests, 0).toLocaleString("en-US")} 次请求`);
    return { anyRate, totalRemaining, totalRemainingCny, totalUsedCny, totalBurnCny, todayTotalCny, todayApprox, lowCount, errCount, earliest, subBits };
  }, [ups, settings]);

  const actionSummary = useMemo(
    () => buildOverviewActions(stations, { rules, settings, statusOf }),
    [stations, rules, settings],
  );

  function actionDetail(action: any): string {
    const station = action.station;
    if (action.kind === "query-failed") {
      const issue = describeConnectionFailure(station.balance?.error, station);
      const checkedAt = station.balance?.checkedAt;
      return `${issue.message}${checkedAt ? ` · 最近查询 ${relTime(checkedAt)}` : ""}`;
    }
    if (action.kind === "balance-danger" || action.kind === "balance-low") {
      const etaDays = Number(station.prediction?.etaDays);
      const eta = Number.isFinite(etaDays) ? ` · 预计 ${fmtEta(etaDays)}后耗尽` : "";
      return `当前余额 ${cny(Number(station.balance?.remaining || 0) * rateOf(station))}${eta}`;
    }
    if (action.kind === "eta-soon") {
      return `预计 ${fmtEta(action.etaDays)}后耗尽 · 近期日均消耗 ${cny(Number(station.prediction?.burnPerDay || 0) * rateOf(station))}`;
    }
    return `最近一笔将在 ${fmtClock(action.endAt)} 到期 · 剩 ${action.daysRemaining} 天`;
  }

  function actionTitle(kind: string): string {
    const titles: Record<string, string> = {
      "query-failed": "查询失败",
      "balance-danger": "余额已耗尽",
      "balance-low": "余额偏低",
      "eta-soon": "预计即将耗尽",
      "fixed-expiring": "固定成本即将到期",
    };
    return titles[kind] || "需要处理";
  }

  function actionTone(kind: string): "danger" | "warning" {
    return kind === "query-failed" || kind === "balance-danger" ? "danger" : "warning";
  }

  // ---- 总余额趋势数据（drawTotalChart 的聚合部分平移）------------------------
  // 聚合上游资源：时间并集 + 各站前向填充求和（按充值汇率折算成 ¥，不含自营资源）
  const trend = useMemo(() => {
    if (!overview) return null;
    const rateMap = new Map(stations.map((s) => [s.id, rateOf(s)]));
    const ownIds = new Set(stations.filter((s) => s.isOwn).map((s) => s.id));
    const seriesList = overview.series
      .filter((s) => s.points && s.points.length && !ownIds.has(s.id))
      .map((s) => ({ ...s, rate: rateMap.get(s.id) ?? 1 }));
    const times: number[] = [];
    for (const s of seriesList) for (const p of s.points) times.push(p[0]);
    times.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (const t of times) if (!uniq.length || t - uniq[uniq.length - 1] > 30000) uniq.push(t);
    if (uniq.length < 2) return { data: [], breakdown: new Map() };
    const idx = seriesList.map(() => -1);
    const data: { tms: number; date: Date; v: number }[] = [];
    const breakdown = new Map<number, [string, number][]>();
    for (const t of uniq) {
      let sum = 0;
      const bd: [string, number][] = [];
      seriesList.forEach((s, i) => {
        while (idx[i] + 1 < s.points.length && s.points[idx[i] + 1][0] <= t) idx[i]++;
        if (idx[i] >= 0) {
          const v = s.points[idx[i]][1] * s.rate;
          sum += v;
          bd.push([s.name, v]);
        }
      });
      data.push({ tms: t, date: new Date(t), v: Math.round(sum * 100) / 100 });
      breakdown.set(t, bd);
    }
    return { data, breakdown };
  }, [overview, stations]);

  // ---- 今日消耗对比数据（drawBurnBars 的数据部分平移）------------------------
  // 数值取当日实际扣费 todayUsed（真实数据），非预测——todayIsEstimate 为历史推算，tooltip 标 ≈
  const burnItems = useMemo(() => {
    let items = ups
      .map((s) => ({
        name: s.name,
        burn: (s.todayUsed || 0) * rateOf(s),
        est: !!s.todayIsEstimate,
        eta: s.prediction?.etaDays ?? null,
      }))
      .filter((x) => x.burn > 0)
      .sort((a, b) => b.burn - a.burn);
    if (items.length > 8) {
      const rest = items.slice(7);
      items = items.slice(0, 7);
      items.push({
        name: `其他 ${rest.length} 个`,
        burn: Math.round(rest.reduce((a, x) => a + x.burn, 0) * 100) / 100,
        est: rest.some((x) => x.est),
        eta: null,
      });
    }
    return items;
  }, [ups]);

  // ---- 单站行（stationRow 平移）--------------------------------------------
  const rowStyle: React.CSSProperties = { borderBottom: `1px solid ${token.colorBorderSecondary}` };
  function renderStationRow(s: any) {
    // 固定成本渠道：不访问接口，展示当前生效各笔的摊销汇总
    if (s.type === "fixed") {
      const ps: any[] = Array.isArray(s.fixedPurchases) ? s.fixedPurchases : [];
      const nowMs = Date.now();
      let daily = 0, active = 0, pendingStart = 0, nextEnd: number | null = null;
      for (const p of ps) {
        const d = p.amount > 0 && p.days > 0 ? p.amount / p.days : 0;
        if (!p.startDate) { daily += d; active++; continue; }
        const st = Date.parse(p.startDate + "T00:00:00");
        const end = st + p.days * 86400000;
        if (st > nowMs) { pendingStart++; continue; }
        if (end > nowMs) {
          daily += d; active++;
          if (nextEnd == null || end < nextEnd) nextEnd = end;
        }
      }
      const expiredAll = ps.length > 0 && active === 0 && pendingStart === 0;
      const pieces: React.ReactNode[] = [
        <span key="d">日均摊销 {cny(daily)}</span>,
        <span key="a">生效 {active}/{ps.length} 笔</span>,
      ];
      if (pendingStart) pieces.push(<span key="p">待生效 {pendingStart} 笔</span>);
      if (nextEnd != null) {
        const remain = Math.ceil((nextEnd - nowMs) / 86400000);
        pieces.push(
          <span key="n" style={{ color: remain <= 3 ? token.colorWarning : undefined }}>
            最近一笔 {fmtClock(nextEnd).split(" ")[0]} 到期（剩 {remain} 天）
          </span>
        );
      }
      if (expiredAll) pieces.push(<span key="e" style={{ color: token.colorError }}>已全部到期，续费请追加付费记录</span>);
      return (
        <div key={s.id} className="station-row overview-resource-row" style={rowStyle}>
          <div className="station-row__main">
            <div className="station-row__name overview-resource-row__name" style={{ fontWeight: 600 }}>
              {s.name}
              <span className="resource-flag">固定成本</span>
            </div>
            <div className="station-row__meta" style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>
              {s.baseUrl ? `${s.baseUrl} · ` : ""}不访问接口 · 仅计入利润成本
            </div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "0 6px" }}>
              {pieces.reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`sep${i}`}>·</span>, el] : [el]), [])}
            </div>
          </div>
          <div className="station-row__amount" style={{ textAlign: "right" }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: expiredAll ? token.colorError : undefined }}>{cny(daily)}</div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{expiredAll ? "已到期" : "每天"}</div>
          </div>
        </div>
      );
    }

    const st = statusOf(s, settings);
    const b = s.balance;
    const rate = rateOf(s);
    const amtColor = st === "danger" || st === "error" ? token.colorError : st === "warn" ? token.colorWarning : undefined;
    const amount = b && b.ok ? cny(b.remaining * rate) : "—";
    // 副信息行：类型 · 账号 · 令牌续期 · 查询时间 · 延迟；失败时红字错误
    let meta: React.ReactNode;
    if (b && b.ok) {
      const bits = [typeLabel(s.type)];
      if (b.account) bits.push(b.account);
      if (s.type === "sub2api-password" && s.tokenInfo?.expiresAt) {
        bits.push(`令牌自动续期（有效至 ${fmtClock(s.tokenInfo.expiresAt)}）`);
      }
      bits.push(relTime(b.checkedAt));
      if (b.latencyMs != null) bits.push(b.latencyMs + "ms");
      meta = bits.join(" · ");
    } else if (b && !b.ok) {
      meta = (
        <>
          {typeLabel(s.type)} · <span style={{ color: token.colorError }}>{b.error || "查询失败"}</span>
        </>
      );
    } else {
      meta = `${typeLabel(s.type)} · 尚未查询`;
    }
    const eta = etaText(s.prediction, rate, rules);
    const pieces: React.ReactNode[] = [];
    if (b && b.ok && s.todayUsed != null) {
      pieces.push(<span key="t">今日消耗 {s.todayIsEstimate ? "≈" : ""}{cny(s.todayUsed * rate)}</span>);
      if (s.todayTokens != null) pieces.push(<span key="k">{fmtTokens(s.todayTokens)} tokens</span>);
    }
    if (eta) pieces.push(<span key="e" style={{ color: eta.cls === "danger" ? token.colorError : eta.cls === "warn" ? token.colorWarning : undefined }}>{eta.text}</span>);
    if (pieces.length) pieces.push(<span key="c" style={{ color: token.colorTextSecondary }}>点击查看趋势</span>);
    return (
      // 主信息区可点开余额趋势弹窗，刷新按钮保持独立交互目标
      <div
        key={s.id}
        className="station-row overview-resource-row"
        style={rowStyle}
      >
        <div
          className="station-row__main"
          style={{ cursor: "pointer" }}
          title="查看余额趋势"
          role="button"
          tabIndex={0}
          aria-label={`查看 ${s.name} 的余额趋势`}
          onClick={() => setTrendStation(s)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setTrendStation(s);
            }
          }}
        >
          <div className="station-row__name overview-resource-row__name" style={{ fontWeight: 600, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
            {s.name}
            {s.isOwn ? <span className="resource-flag">自营</span> : null}
            {s.noRenewal ? <span className="resource-flag resource-flag--warning">不再续费</span> : null}
            {s.demo ? <span className="resource-flag">演示</span> : null}
            <StatusText st={st} />
          </div>
          <div className="station-row__meta" style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{meta}</div>
          {b && b.ok && s.spark && s.spark.length >= 2 ? (
            <div className="station-row__spark" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <SparkSvg pts={s.spark} />
              <span style={{ fontSize: 12, color: token.colorTextSecondary }}>近 48h 余额</span>
            </div>
          ) : null}
          {pieces.length ? (
            <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "0 6px" }}>
              {pieces.reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, <span key={`sep${i}`}>·</span>, el] : [el]), [])}
            </div>
          ) : null}
        </div>
        <div className="station-row__amount" style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: amtColor }}>{amount}</div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {b && b.ok && rate !== 1 ? `站点余额 ${usd(b.remaining)}` : "剩余余额"}
          </div>
        </div>
        <div className="station-row__actions">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            loading={refreshingId === s.id}
            // 行本身可点开趋势弹窗，刷新按钮要拦住冒泡避免误开
            onClick={(e) => { e.stopPropagation(); refreshOne(s.id); }}
            title="刷新"
            aria-label={`刷新 ${s.name}`}
          />
        </div>
      </div>
    );
  }

  // ---- 图表 ------------------------------------------------------------------
  // 总余额趋势：折线 + 自定义 tooltip（时间点各站分解，前 5 名 + 其他合并，同 v1）
  const lineConfig = trend && trend.data.length >= 2 ? {
    data: trend.data,
    xField: "date",
    yField: "v",
    height: CHART_H,
    theme: dark ? "classicDark" : "classic",
    style: { stroke: token.colorPrimary, lineWidth: 2 },
    axis: {
      x: {
        labelFormatter: (d: Date) => {
          const full = fmtClock(d);
          if (!isMobile) return full;
          const [date, time] = full.split(" ");
          return trendHours <= 24 ? time : date;
        },
        grid: false,
      },
      y: { labelFormatter: (v: number) => `¥${v >= 100 ? Math.round(v).toLocaleString("en-US") : v}` },
    },
    scale: { y: { nice: true, domainMin: 0 } },
    tooltip: {
      title: (d: any) => String(d.tms),
      items: [{ channel: "y" }],
    },
    interaction: {
      tooltip: {
        render: (_e: any, { title }: any) => {
          const tms = Number(title);
          const bd = [...(trend.breakdown.get(tms) || [])].sort((a, b) => b[1] - a[1]);
          const total = bd.reduce((a, x) => a + x[1], 0);
          const shown = bd.slice(0, 5);
          const rest = bd.slice(5);
          let rows = shown
            .map(([n, v]) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${truncateLabel(n, 14)}</span><b>${cny(v)}</b></div>`)
            .join("");
          if (rest.length) {
            rows += `<div style="display:flex;justify-content:space-between;gap:16px"><span>其他 ${rest.length} 个</span><b>${cny(rest.reduce((a, x) => a + x[1], 0))}</b></div>`;
          }
          return `<div style="padding:4px 2px;font-size:12px"><div style="color:${token.colorTextSecondary}">${fmtClock(tms)}</div><div style="font-weight:600;margin:2px 0">合计 ${cny(Math.round(total * 100) / 100)}</div>${rows}</div>`;
        },
      },
    },
    animate: false,
  } : null;

  // 今日消耗对比：横向条形（plots Bar，对齐 v1 drawBurnBars），条端标数值，tooltip 含历史推算标记与预计耗尽天数
  const barConfig = burnItems.length ? {
    data: burnItems,
    xField: "name",
    yField: "burn",
    // 与总余额趋势同高，保证同排两卡等高；站点少时条形由 G2 自适应带宽，图仍占满高度
    height: CHART_H,
    theme: dark ? "classicDark" : "classic",
    // 单一色相：对比的是数值不是身份（同 v1 drawBurnBars 注释）
    style: { fill: token.colorPrimary, radiusTopRight: 4, radiusBottomRight: 4 },
    label: isMobile ? false : {
      // 条端金额标注；历史推算站加 ≈ 前缀（同 v1）
      text: (d: any) => `${d.est ? "≈ " : ""}${cny(d.burn)}`,
      position: "right" as const,
      dx: 4,
      style: { fontSize: 11, fill: token.colorTextSecondary },
    },
    axis: {
      x: { labelFormatter: (n: string) => truncateLabel(n, isMobile ? 8 : 12), title: false },
      y: false as const,
    },
    legend: false as const,
    tooltip: {
      title: (d: any) => d.name,
      items: [{ channel: "y" }],
    },
    interaction: {
      tooltip: {
        render: (_e: any, { title }: any) => {
          const it = burnItems.find((x) => x.name === title);
          if (!it) return "";
          const etaLine = it.eta != null ? `<div style="color:${token.colorTextSecondary}">预计 ${it.eta} 天后耗尽</div>` : "";
          return `<div style="padding:4px 2px;font-size:12px"><div style="color:${token.colorTextSecondary}">${it.name}${it.est ? " · 历史推算" : ""}</div><div style="font-weight:600;margin:2px 0">${it.est ? "≈ " : ""}${cny(it.burn)}</div>${etaLine}</div>`;
        },
      },
    },
    animate: false,
  } : null;

  if (!loaded && loadError) {
    return (
      <PageContainer className="responsive-page overview-page" title="运营总览" subTitle="掌握上游资金、消耗与风险变化">
        <AppState
          kind="error"
          title="运营总览暂时无法加载"
          description={loadError}
          actions={<Button type="primary" loading={loadingStations} onClick={() => { reload().catch(() => {}); loadOverview(hoursRef.current); }}>重新加载</Button>}
        />
      </PageContainer>
    );
  }

  if (!loaded) {
    return (
      <PageContainer className="responsive-page overview-page" title="运营总览" subTitle="掌握上游资金、消耗与风险变化">
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}><ProCard loading style={{ height: "100%" }} /></Col>
          <Col xs={24} lg={10}><ProCard loading style={{ height: "100%" }} /></Col>
        </Row>
        <ProCard loading style={{ marginTop: 16 }} />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      className="responsive-page overview-page"
      title="运营总览"
      subTitle="掌握上游资金、消耗与风险变化"
      extra={<div className="page-toolbar"><LastRefreshed at={refreshedAt} /></div>}
    >
      {loadError ? (
        <Alert
          type="warning"
          showIcon
          message="总览刷新失败，正在显示上次成功加载的数据"
          description={loadError}
          action={<Button size="small" loading={loadingStations} onClick={() => { reload().catch(() => {}); }}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <section className="overview-command" aria-label="核心经营指标">
        <div className="overview-primary-grid">
          <PrimaryMetric
            label="总余额"
            value={cny(agg.totalRemainingCny)}
            sub={agg.anyRate ? `原始站点余额合计 ${usd(agg.totalRemaining)}` : "全部上游资源折算后余额"}
          />
          <PrimaryMetric
            label="今日消耗"
            value={`${agg.todayApprox ? "≈ " : ""}${cny(agg.todayTotalCny)}`}
            sub={agg.subBits.length ? agg.subBits.join(" · ") : "今日 0 点至今"}
          />
        </div>
        <aside className="overview-health" aria-label="资源健康摘要">
          <div className="overview-health__heading">
            <span>资源健康</span>
            <small>{ups.length} 个上游资源</small>
          </div>
          <div className="overview-health__grid">
            <HealthItem
              label="低余额 / 耗尽"
              value={`${agg.lowCount} 个`}
              tone={agg.lowCount ? "warning" : "default"}
              detail={agg.lowCount ? "需要关注" : "当前无风险"}
            />
            <HealthItem
              label="查询异常"
              value={`${agg.errCount} 个`}
              tone={agg.errCount ? "danger" : "default"}
              detail={agg.errCount ? "数据可能滞后" : "查询均正常"}
            />
            <HealthItem
              label="日均消耗"
              value={agg.totalBurnCny > 0 ? cny(agg.totalBurnCny) : "—"}
              detail="按近期趋势估算"
            />
            <HealthItem
              label="最早预计耗尽"
              value={agg.earliest ? fmtEta(agg.earliest.days) : "—"}
              tone={agg.earliest && agg.earliest.days <= (rules?.etaDays ?? 3) ? "danger" : agg.earliest && agg.earliest.days <= 7 ? "warning" : "default"}
              detail={agg.earliest ? agg.earliest.name : "暂无有效预测"}
            />
          </div>
        </aside>
      </section>

      <section aria-labelledby="overview-actions-heading" style={{ marginTop: 16 }}>
        <ProCard
          className="overview-panel"
          title={
            <div>
              <div id="overview-actions-heading" style={{ fontWeight: 600 }}>需要处理</div>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", whiteSpace: "normal" }}>
                {actionSummary.all.length
                  ? `共 ${actionSummary.all.length} 个运营事项，按优先级展示前 ${actionSummary.visible.length} 项`
                  : "当前上游资源与固定成本没有需要立即处理的事项"}
              </Text>
            </div>
          }
        >
          {actionSummary.visible.length ? (
            <div
              role="list"
              aria-label="需要处理的运营事项"
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))",
                gap: 12,
              }}
            >
              {actionSummary.visible.map((action: any) => {
                const tone = actionTone(action.kind);
                const isRetry = action.kind === "query-failed";
                const toneColor = tone === "danger" ? token.colorError : token.colorWarning;
                const toneBg = tone === "danger" ? token.colorErrorBg : token.colorWarningBg;
                return (
                  <article
                    key={`${action.stationId}-${action.kind}`}
                    role="listitem"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                      gap: 12,
                      minWidth: 0,
                      padding: 16,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderInlineStart: `3px solid ${toneColor}`,
                      borderRadius: 8,
                      background: toneBg,
                    }}
                  >
                    <div style={{ flex: "1 1 190px", minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px" }}>
                        <span style={{ color: toneColor, fontSize: 12, fontWeight: 650 }}>{actionTitle(action.kind)}</span>
                        <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>资源：{action.stationName}</span>
                      </div>
                      <div style={{ marginTop: 6, color: token.colorText, fontSize: 14, lineHeight: 1.6, overflowWrap: "anywhere" }}>
                        {actionDetail(action)}
                      </div>
                    </div>
                    {isRetry ? (
                      <Button
                        type="primary"
                        danger
                        icon={<ReloadOutlined />}
                        loading={refreshingId === action.stationId}
                        onClick={() => refreshOne(action.stationId)}
                        aria-label={`重新查询 ${action.stationName}`}
                        style={{ minHeight: 44 }}
                      >
                        重新查询
                      </Button>
                    ) : (
                      <Button
                        href="/stations"
                        aria-label={`查看 ${action.stationName} 资源`}
                        style={{ minHeight: 44 }}
                      >
                        查看资源
                      </Button>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                minHeight: 72,
                padding: "14px 16px",
                borderRadius: 8,
                background: token.colorSuccessBg,
              }}
            >
              <div>
                <div style={{ color: token.colorSuccess, fontSize: 14, fontWeight: 650 }}>状态健康</div>
                <div style={{ marginTop: 3, color: token.colorTextSecondary, fontSize: 12 }}>当前没有查询失败、低余额、即将耗尽或固定成本到期事项。</div>
              </div>
              <Button href="/stations" aria-label="查看上游资源" style={{ minHeight: 44 }}>查看资源</Button>
            </div>
          )}
        </ProCard>
      </section>

      {/* 图表区：仅有站点时展示（同 v1 charts 条件）；窄屏降为单列（xs=24 lg 分栏） */}
      {stations.length ? (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} lg={14}>
            <ProCard
              className="overview-panel overview-panel--primary"
              style={{ height: "100%" }}
              // 两行头：副标题换行放标题下方（全站规范 1），范围切换保持在 extra
              title={<CardTitle title="总余额趋势" sub="上游资源剩余余额合计（按充值汇率折算 ¥，不含自营资源）" />}
              // 初次加载骨架屏（全站规范 3）；已有数据后切范围不闪骨架
              loading={!overview && !overviewErr}
              extra={
                <div className="mobile-scroll">
                  <Segmented
                    size="small"
                    value={trendHours}
                    options={RANGES}
                    onChange={(v) => setTrendHours(v as number)}
                  />
                </div>
              }
            >
              {overviewErr && !overview ? (
                <ChartEmpty text={overviewErr} />
              ) : lineConfig ? (
                <ChartBox h={CHART_H}><Line {...(lineConfig as any)} /></ChartBox>
              ) : (
                <ChartEmpty text="数据积累中（需要至少两次成功查询）" />
              )}
            </ProCard>
          </Col>
          <Col xs={24} lg={10}>
            <ProCard
              className="overview-panel"
              style={{ height: "100%" }}
              title={<CardTitle title="今日消耗对比" sub="各站当日 0 点至今实际扣费（¥）" />}
            >
              {barConfig ? <ChartBox h={CHART_H}><Bar {...(barConfig as any)} /></ChartBox> : <ChartEmpty text="今日暂无消耗" />}
            </ProCard>
          </Col>
        </Row>
      ) : null}

      {/* 上游资源摘要（stationRow 全字段） */}
      {stations.length ? (
        <ProCard
          className="overview-panel overview-resource-panel"
          title={<CardTitle title="上游资源" sub={`共 ${stations.length} 个 · 累计已用 ${cny(agg.totalUsedCny)}`} />}
          style={{ marginTop: 16 }}
        >
          <div>{stations.map(renderStationRow)}</div>
        </ProCard>
      ) : (
        <ProCard className="overview-panel" style={{ marginTop: 16 }}>
          <Empty
            description={
              <>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有上游资源</div>
                <div style={{ color: token.colorTextSecondary }}>前往「上游资源」添加连接，配置地址与凭证后即可监控余额。</div>
              </>
            }
          />
        </ProCard>
      )}

      {/* 余额趋势详情弹窗（共享组件，上游资源页同款）；指标用列表里的最新数据（轮询会更新） */}
      <TrendModal
        station={trendStation ? stations.find((x) => x.id === trendStation.id) || trendStation : null}
        onClose={() => setTrendStation(null)}
        etaDaysRule={rules?.etaDays ?? 3}
      />
    </PageContainer>
  );
}
