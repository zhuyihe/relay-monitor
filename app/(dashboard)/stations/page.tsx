"use client";
// 上游资源页：资源列表 + 添加/编辑弹窗 + 单项刷新/删除 + 余额趋势详情弹窗
// 功能对照 v1 app.js：renderStations/stationRow（553-586、193-288）、站点表单弹窗（1487-1614）、
// 趋势弹窗 openTrend/drawChart（1675-1822）——文案与数字口径逐条对齐，布局用 Pro 风格重排
import { useCallback, useEffect, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import {
  Alert,
  App,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  Select,
  Space,
  theme,
} from "antd";
import {
  PlusOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import TrendModal from "../trend-modal";
import LastRefreshed from "../last-refreshed";
import AppState from "../../components/app-state";
import dayjs from "dayjs";
import { api, cny, usd, rateOf, fmtTokens, fmtEta, statusOf } from "../../../lib/client";
import { describeConnectionFailure } from "../../../lib/connection-test";

// ---- 展示工具（v1 app.js 同名函数平移）--------------------------------------
function relTime(iso: any) {
  if (!iso) return "从未";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.floor(d))} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  return `${Math.floor(d / 3600)} 小时前`;
}
function fmtClock(ts: any) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 耗尽预测文案：≈ ¥x/天（依据）· 预计 N 天后耗尽；阈值内标红、7 天内标黄（同 v1 etaText）
function etaText(p: any, rate: number, etaDaysRule: number): { text: string; cls: "" | "warn" | "danger" } | null {
  if (!p) return null;
  if (p.burnPerDay === 0) return { text: `${p.basis || "近期"}无消耗`, cls: "" };
  if (p.etaDays == null) return null;
  const cls = p.etaDays <= etaDaysRule ? "danger" : p.etaDays <= 7 ? "warn" : "";
  return { text: `≈ ${cny(p.burnPerDay * rate)}/天（${p.basis || "估算"}）· 预计 ${fmtEta(p.etaDays)}后耗尽`, cls };
}
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

function mobileAmountFontSize(value: string): number {
  const length = Array.from(value).length;
  if (length > 15) return 14;
  if (length > 12) return 15;
  return 17;
}

const CONNECTION_FIELDS = new Set(["type", "baseUrl", "accessToken", "apiKey", "userId", "email", "password"]);
const CONNECTION_INPUT_FIELDS = ["baseUrl", "accessToken", "apiKey", "userId", "email", "password"] as const;

type ConnectionGuidance = {
  title: string;
  credentials: string;
  address: string;
  lifecycle: string;
  test: string;
};

const CONNECTION_GUIDANCE: Record<string, ConnectionGuidance> = {
  newapi: {
    title: "New API · 系统访问令牌",
    credentials: "需要系统访问令牌和用户 ID。令牌通常在 New API 后台的「个人设置」中获取，用户 ID 可在同页查看。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写 /api/user/self、管理后台或具体接口路径。",
    lifecycle: "令牌由上游站点管理；过期、撤销或权限变化后，需要手动更新后重新验证。",
    test: "测试只读取当前账户额度，不会保存凭证、刷新资源或触发告警。",
  },
  "newapi-key": {
    title: "New API · sk 密钥",
    credentials: "需要一个可用的 sk- API 密钥，通常从站点的令牌/密钥管理页创建。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写 /v1 或 /dashboard/billing 等路径。",
    lifecycle: "密钥的有效期和权限由上游站点控制；失效或被撤销后需替换为新的密钥。",
    test: "测试通过 OpenAI 兼容计费接口读取额度，不会写入资源或触发告警。",
  },
  sub2api: {
    title: "Sub2API · 登录令牌",
    credentials: "需要登录后的访问令牌（JWT），通常在浏览器已登录状态下，从站点账户接口请求的 Authorization 头中获取。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写 /api/v1/auth/me 等具体接口路径。",
    lifecycle: "JWT 过期、退出登录或被吊销后需手动更换。若希望自动续期，请选择账号密码模式。",
    test: "测试会验证 JWT 是否能读取账户余额，不会保存令牌或触发刷新、告警。",
  },
  "sub2api-password": {
    title: "Sub2API · 账号密码自动续期",
    credentials: "需要可登录的邮箱和密码。保存后，平台会在访问令牌临近过期时自动刷新，无法刷新时再重新登录。",
    address: "填写站点根地址，例如 https://relay.example.com；不要填写登录接口或管理后台路径。",
    lifecycle: "测试只临时验证邮箱和密码，不保存测试期间产生的令牌；保存资源后才会启用自动续期。开启两步验证的账号无法自动登录。",
    test: "测试会完成一次临时登录并读取余额，不写入数据库、不刷新资源，也不触发告警。",
  },
  fixed: {
    title: "固定成本 · 不访问接口",
    credentials: "不需要令牌、密钥、邮箱或密码。",
    address: "不需要填写站点地址；成本通过下方的付费记录按天摊销。",
    lifecycle: "没有令牌续期行为；到期后添加新的付费记录即可继续计入成本。",
    test: "固定成本不测试连接，也不会访问任何外部接口。",
  },
};

type ConnectionIssue = {
  code?: string;
  category: string;
  message: string;
  action: string;
  diagnostic?: string;
};

type ConnectionTestResult = ConnectionIssue & {
  ok: boolean;
  latencyMs?: number;
  account?: string | null;
  remaining?: number;
  currency?: string | null;
};

function resultIssue(result: Partial<ConnectionIssue> | null | undefined, fallback: unknown, station: any = {}): ConnectionIssue {
  const described = describeConnectionFailure(fallback, station);
  return {
    code: result?.code || described.code,
    category: result?.category || described.category,
    message: result?.message || described.message,
    action: result?.action || described.action,
    diagnostic: result?.diagnostic || described.diagnostic,
  };
}

function testBalanceText(result: ConnectionTestResult) {
  if (!Number.isFinite(Number(result.remaining))) return null;
  const amount = Number(result.remaining);
  return result.currency === "USD"
    ? `余额 ${usd(amount)}`
    : `余额 ${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${result.currency ? ` ${result.currency}` : ""}`;
}

const hintStyle = (token: ReturnType<typeof theme.useToken>["token"]): React.CSSProperties => ({
  fontSize: 12,
  color: token.colorTextSecondary,
  marginTop: 4,
  lineHeight: 1.6,
});

function ConnectionProblem({
  checkedAt,
  issue,
  onRetest,
  testing,
}: {
  checkedAt?: string | null;
  issue: ConnectionIssue;
  onRetest: () => void;
  testing: boolean;
}) {
  const { token } = theme.useToken();
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 10,
        marginTop: 10,
        padding: "10px 12px",
        borderInlineStart: `2px solid ${token.colorError}`,
        background: token.colorErrorBg,
      }}
    >
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ color: token.colorError, fontSize: 14, fontWeight: 600 }}>
          {issue.category}：{issue.message}
        </div>
        <div style={{ ...hintStyle(token), marginTop: 2 }}>{issue.action}</div>
        <div style={{ ...hintStyle(token), marginTop: 2 }}>最近检查：{relTime(checkedAt)}</div>
        {issue.diagnostic ? (
          <details style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>
            <summary style={{ display: "flex", alignItems: "center", minHeight: 40, cursor: "pointer" }}>查看脱敏诊断</summary>
            <span>{issue.diagnostic}</span>
          </details>
        ) : null}
      </div>
      <Button
        type="default"
        loading={testing}
        onClick={(event) => {
          event.stopPropagation();
          onRetest();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        style={{ minHeight: 44 }}
      >
        重新测试连接
      </Button>
    </div>
  );
}

// ---- 迷你余额走势（近 48 小时，与总览卡片使用相同坐标口径）--------------------
function Spark({ pts, fluid = false }: { pts: [number, number][]; fluid?: boolean }) {
  const { token } = theme.useToken();
  if (!pts || pts.length < 2) return null;

  const W = 170, H = 30, P = 3;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let min = Infinity, max = -Infinity;
  for (const [, v] of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - min) / (max - min)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${H - P}L${x(t0).toFixed(1)},${H - P}Z`;
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={fluid ? "100%" : 170} height={30} aria-hidden="true" style={{ display: "block", maxWidth: "100%" }}>
      <path d={area} fill={token.colorPrimaryBg} />
      <path d={line} fill="none" stroke={token.colorPrimary} strokeWidth={1.5} />
      <circle cx={x(last[0]).toFixed(1)} cy={y(last[1]).toFixed(1)} r={2.5} fill={token.colorPrimary} />
    </svg>
  );
}

// ---- 单行站点（v1 stationRow 平移）-------------------------------------------
function StationRow(props: {
  s: any;
  settings: any;
  types: any[];
  etaDaysRule: number;
  compact: boolean;
  refreshing: boolean;
  retesting: boolean;
  connectionCheck?: { issue: ConnectionIssue; checkedAt: string };
  onTrend: (s: any) => void;
  onRefresh: (s: any) => void;
  onRetest: (s: any) => void;
  onEdit: (s: any) => void;
  onDelete: (s: any) => void;
}) {
  const {
    s, settings, types, etaDaysRule, compact, refreshing, retesting, connectionCheck,
    onTrend, onRefresh, onRetest, onEdit, onDelete,
  } = props;
  const { token } = theme.useToken();
  const typeLabel = (v: string) => types.find((t) => t.value === v)?.label || v;
  const rowStyle: React.CSSProperties = {
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
  };
  const mutedStyle: React.CSSProperties = { color: token.colorTextSecondary };
  const sep = <span style={{ margin: "0 6px", ...mutedStyle }}>·</span>;

  // 固定成本渠道：不访问接口，展示当前生效各笔的摊销汇总
  if (s.type === "fixed") {
    const ps = Array.isArray(s.fixedPurchases) ? s.fixedPurchases : [];
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
        <span key="n" style={remain <= 3 ? { color: token.colorWarning } : undefined}>
          最近一笔 {fmtClock(nextEnd).split(" ")[0]} 到期（剩 {remain} 天）
        </span>
      );
    }
    if (expiredAll) pieces.push(<span key="e" style={{ color: token.colorError }}>已全部到期，续费请追加付费记录</span>);
    const nextEndRemain = nextEnd == null ? null : Math.ceil((nextEnd - nowMs) / 86400000);
    if (compact) {
      const fixedAmount = cny(daily);
      return (
        <article className="mobile-station-card mobile-station-card--fixed" style={rowStyle}>
          <div className="mobile-station-card__header">
            <div className="mobile-station-card__identity">
              <div className="mobile-station-card__name" title={s.name}>{s.name}</div>
              <div className="mobile-station-card__meta" title={s.baseUrl || "不访问接口，仅计入利润成本"}>
                {s.baseUrl ? `${s.baseUrl} · ` : ""}不访问接口 · 仅计入利润成本
              </div>
            </div>
            <div className="mobile-station-card__summary">
              <span className={`resource-status resource-status--${expiredAll ? "danger" : "pending"}`}>
                <span className="resource-status__dot" aria-hidden="true" />
                {expiredAll ? "已到期" : "固定成本"}
              </span>
              <strong
                aria-label={`日均摊销 ${fixedAmount}`}
                style={{ color: expiredAll ? token.colorError : undefined, fontSize: mobileAmountFontSize(fixedAmount) }}
              >
                {fixedAmount}
              </strong>
            </div>
          </div>
          <div className="mobile-station-card__metrics">
            <div className="mobile-station-card__metric">
              <span>生效记录</span>
              <strong>{active}/{ps.length} 笔</strong>
              <small>{pendingStart ? `另有 ${pendingStart} 笔待生效` : "当前日均摊销"}</small>
            </div>
            <div className="mobile-station-card__metric">
              <span>最近到期</span>
              <strong style={nextEndRemain != null && nextEndRemain <= 3 ? { color: token.colorWarning } : undefined}>
                {nextEnd == null ? "—" : fmtClock(nextEnd).split(" ")[0]}
              </strong>
              <small>{nextEndRemain == null ? (expiredAll ? "已全部到期" : "暂无到期日") : `剩 ${nextEndRemain} 天`}</small>
            </div>
          </div>
          {expiredAll ? <div className="mobile-station-card__notice">已全部到期，续费请追加付费记录</div> : null}
        </article>
      );
    }
    return (
      <div className="station-row desktop-station-row resource-list-row" style={rowStyle}>
        <div className="station-row__main">
          <div className="station-row__name resource-list-row__name" style={{ fontWeight: 600 }}>
            {s.name}<span className="resource-flag">固定成本</span>
          </div>
          <div className="station-row__meta" style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>
            {s.baseUrl ? `${s.baseUrl} · ` : ""}不访问接口 · 仅计入利润成本
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            {pieces.map((p, i) => (<span key={i}>{i ? sep : null}{p}</span>))}
          </div>
        </div>
        <div className="station-row__amount" style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: expiredAll ? token.colorError : undefined }}>{cny(daily)}</div>
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{expiredAll ? "已到期" : "每天"}</div>
        </div>
        <Space className="station-row__actions" size={2}>
          <Button type="text" icon={<EditOutlined />} title="编辑" aria-label={`编辑 ${s.name}`} onClick={() => onEdit(s)} />
          <Button type="text" danger icon={<DeleteOutlined />} title="删除" aria-label={`删除 ${s.name}`} onClick={() => onDelete(s)} />
        </Space>
      </div>
    );
  }

  const st = statusOf(s, settings);
  const b = s.balance;
  const connectionIssue = connectionCheck?.issue || (b && !b.ok ? resultIssue(null, b.error) : null);
  const checkedAt = connectionCheck?.checkedAt || b?.checkedAt;
  const rate = rateOf(s);
  const effectiveStatus = connectionIssue ? "error" : st;
  const amtColor = effectiveStatus === "danger" || effectiveStatus === "error" ? token.colorError : effectiveStatus === "warn" ? token.colorWarning : undefined;
  const amount = b && b.ok ? cny(b.remaining * rate) : "—";
  // 副标题行：类型 · 账号 · 令牌续期 · 上次查询 · 延迟（同 v1 meta 拼接顺序）
  let meta: React.ReactNode;
  if (connectionIssue) {
    meta = (<>{typeLabel(s.type)} · <span style={{ color: token.colorError }}>{connectionIssue.message}</span> · {relTime(checkedAt)}</>);
  } else if (b && b.ok) {
    const bits: string[] = [typeLabel(s.type)];
    if (b.account) bits.push(b.account);
    if (s.type === "sub2api-password" && s.tokenInfo?.expiresAt) {
      bits.push(`令牌自动续期（有效至 ${fmtClock(s.tokenInfo.expiresAt)}）`);
    }
    bits.push(relTime(b.checkedAt));
    if (b.latencyMs != null) bits.push(b.latencyMs + "ms");
    meta = bits.join(" · ");
  } else {
    meta = `${typeLabel(s.type)} · 尚未查询`;
  }
  const eta = etaText(s.prediction, rate, etaDaysRule);
  let mobileMeta: React.ReactNode;
  const hasMobileError = !!connectionIssue;
  if (connectionIssue) {
    mobileMeta = `${typeLabel(s.type)} · ${connectionIssue.message} · ${relTime(checkedAt)}`;
  } else if (b && b.ok) {
    const bits: string[] = [typeLabel(s.type)];
    if (b.account) bits.push(b.account);
    bits.push(relTime(b.checkedAt));
    if (b.latencyMs != null) bits.push(b.latencyMs + "ms");
    mobileMeta = bits.join(" · ");
  } else {
    mobileMeta = `${typeLabel(s.type)} · 尚未查询`;
  }
  const etaValue = s.prediction?.burnPerDay === 0
    ? "近期无消耗"
    : s.prediction?.etaDays != null
      ? fmtEta(s.prediction.etaDays)
      : "—";
  const etaColor = eta?.cls === "danger" ? token.colorError : eta?.cls === "warn" ? token.colorWarning : undefined;
  const pieces: React.ReactNode[] = [];
  if (b && b.ok && s.todayUsed != null) {
    pieces.push(<span key="t">今日消耗 {s.todayIsEstimate ? "≈" : ""}{cny(s.todayUsed * rate)}</span>);
    if (s.todayTokens != null) pieces.push(<span key="k">{fmtTokens(s.todayTokens)} tokens</span>);
  }
  if (eta) {
    pieces.push(
      <span key="e" style={eta.cls ? { color: eta.cls === "danger" ? token.colorError : token.colorWarning } : undefined}>
        {eta.text}
      </span>
    );
  }

  if (compact) {
    return (
      <article className="mobile-station-card" style={rowStyle}>
        <div className="mobile-station-card__header">
          <div className="mobile-station-card__identity">
            <div className="mobile-station-card__name" title={s.name}>{s.name}</div>
            <div
              className={`mobile-station-card__meta${hasMobileError ? " mobile-station-card__meta--expandable" : ""}`}
              title={typeof mobileMeta === "string" ? mobileMeta : undefined}
            >
              {mobileMeta}
            </div>
          </div>
          <div className="mobile-station-card__summary">
            <StatusText st={effectiveStatus} />
            <strong aria-label={`人民币余额 ${amount}`} style={{ color: amtColor, fontSize: mobileAmountFontSize(amount) }}>{amount}</strong>
          </div>
        </div>
        {connectionIssue ? <ConnectionProblem checkedAt={checkedAt} issue={connectionIssue} onRetest={() => onRetest(s)} testing={retesting} /> : null}
        <div className="mobile-station-card__metrics">
          <div className="mobile-station-card__metric">
            <span>今日消耗</span>
            <strong>{b && b.ok && s.todayUsed != null ? `${s.todayIsEstimate ? "≈" : ""}${cny(s.todayUsed * rate)}` : "—"}</strong>
            <small>{s.todayTokens != null ? `${fmtTokens(s.todayTokens)} tokens` : s.todayIsEstimate ? "历史数据推算" : "暂无用量"}</small>
          </div>
          <div className="mobile-station-card__metric">
            <span>预计可用</span>
            <strong style={{ color: etaColor }}>{etaValue}</strong>
            <small>{s.prediction?.burnPerDay > 0 ? `${cny(s.prediction.burnPerDay * rate)}/天 · ${s.prediction.basis || "估算"}` : (s.prediction?.basis || "暂无预测")}</small>
          </div>
        </div>
        {b && b.ok && s.spark && s.spark.length > 1 ? (
          <div className="mobile-station-card__chart" title="近 48 小时余额走势">
            <span>近 48h 余额</span>
            <Spark pts={s.spark} fluid />
          </div>
        ) : null}
        <div className="mobile-station-card__footer">
          <Button type="text" aria-label={`查看 ${s.name} 的余额趋势`} onClick={() => onTrend(s)}>查看趋势</Button>
          <Button type="text" aria-label={`刷新 ${s.name}`} icon={<ReloadOutlined />} loading={refreshing} onClick={() => onRefresh(s)}>刷新</Button>
        </div>
      </article>
    );
  }

  return (
    <div className="station-row desktop-station-row resource-list-row" style={rowStyle}>
      <div
        className="station-row__main"
        style={{ cursor: "pointer" }}
        title="查看余额趋势"
        role="button"
        tabIndex={0}
        aria-label={`查看 ${s.name} 的余额趋势`}
        onClick={() => onTrend(s)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTrend(s);
          }
        }}
      >
        <div className="station-row__name resource-list-row__name" style={{ fontWeight: 600 }}>
          {s.name}
          {s.isOwn ? <span className="resource-flag">自营</span> : null}
          {s.includeInProfit === false ? <span className="resource-flag">不计利润成本</span> : null}
          {s.noRenewal ? <span className="resource-flag resource-flag--warning">不再续费</span> : null}
          {s.demo ? <span className="resource-flag">演示</span> : null}
          <StatusText st={effectiveStatus} />
        </div>
        <div className="station-row__meta" style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{meta}</div>
        {connectionIssue ? <ConnectionProblem checkedAt={checkedAt} issue={connectionIssue} onRetest={() => onRetest(s)} testing={retesting} /> : null}
        {b && b.ok && s.spark && s.spark.length > 1 ? (
          <div className="station-row__spark" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }} title="近 48 小时余额走势">
            <Spark pts={s.spark} />
            <span style={{ fontSize: 12, color: token.colorTextSecondary, whiteSpace: "nowrap", flexShrink: 0 }}>近 48h 余额</span>
          </div>
        ) : null}
        {pieces.length ? (
          <div style={{ fontSize: 12, marginTop: 4 }}>
            {pieces.map((p, i) => (<span key={i}>{i ? sep : null}{p}</span>))}
          </div>
        ) : null}
      </div>
      <div className="station-row__amount" style={{ textAlign: "right" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: amtColor }}>{amount}</div>
        <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
          {b && b.ok && rate !== 1 ? `站点余额 ${usd(b.remaining)}` : "剩余余额"}
        </div>
      </div>
      <Space className="station-row__actions" size={2}>
        <Button type="text" icon={<ReloadOutlined />} title="刷新" aria-label={`刷新 ${s.name}`} loading={refreshing} onClick={() => onRefresh(s)} />
        <Button type="text" icon={<EditOutlined />} title="编辑" aria-label={`编辑 ${s.name}`} onClick={() => onEdit(s)} />
        <Button type="text" danger icon={<DeleteOutlined />} title="删除" aria-label={`删除 ${s.name}`} onClick={() => onDelete(s)} />
      </Space>
    </div>
  );
}

// ---- 页面 --------------------------------------------------------------------
export default function StationsPage() {
  const { message, modal } = App.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = screens.md === false;
  const hint = hintStyle(token);
  const [form] = Form.useForm();

  const [stations, setStations] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [types, setTypes] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [retestingIds, setRetestingIds] = useState<Record<string, boolean>>({});
  const [stationChecks, setStationChecks] = useState<Record<string, { issue: ConnectionIssue; checkedAt: string }>>({});
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  // 添加/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null); // null = 新增
  const [saving, setSaving] = useState(false);
  const [purchases, setPurchases] = useState<any[]>([]); // 固定成本付费记录行
  const formType = Form.useWatch("type", form);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const [formFingerprint, setFormFingerprint] = useState("");
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);

  // 趋势详情弹窗（数据拉取与范围切换在共享组件 TrendModal 内）
  const [trendStation, setTrendStation] = useState<any>(null);

  // 列表加载（GET /api/stations 同时带回全局设置，同 v1 reload）
  const reload = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await api("/api/stations");
      setStations(r.stations);
      setSettings(r.settings);
      setLoaded(true);
      setLoadError(null);
      setRefreshedAt(Date.now());
    } catch (e: any) {
      setLoadError(e.message || "上游资源加载失败");
      throw e;
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadMeta = useCallback(async () => {
    setLoadingMeta(true);
    try {
      const m = await api("/api/meta");
      setTypes(m.types);
      setRules(m.rules);
      setMetaError(null);
    } catch (e: any) {
      setMetaError(e.message || "资源配置加载失败");
      throw e;
    } finally {
      setLoadingMeta(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => {});
    loadMeta().catch(() => {});
  }, [loadMeta, reload]);

  // 自动刷新：跟随全局设置的刷新间隔（同 v1 startAuto，下限 10 秒）
  useEffect(() => {
    const sec = Math.max(10, Number(settings.refreshIntervalSec) || 60);
    const t = setInterval(() => { reload().catch(() => {}); }, sec * 1000);
    return () => clearInterval(t);
  }, [settings.refreshIntervalSec, reload]);

  // 手动全量刷新（v1 doRefreshAll）
  const onRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      const r = await api("/api/refresh", { method: "POST", body: {} });
      setStations(r.stations);
      message.success("已刷新全部");
    } catch {
      message.error("刷新失败");
    } finally {
      setRefreshingAll(false);
    }
  };

  // 单站刷新（v1 data-act="refresh"）
  const onRefreshOne = async (s: any) => {
    setRefreshingIds((m) => ({ ...m, [s.id]: true }));
    try {
      const r = await api(`/api/stations/${s.id}/refresh`, { method: "POST", body: {} });
      setStations((list) => list.map((x) => (x.id === s.id ? { ...x, ...(r.station || {}), balance: r.balance } : x)));
      if (!r.balance.ok) message.error(`${s.name}：${resultIssue(null, r.balance.error).message}`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRefreshingIds((m) => ({ ...m, [s.id]: false }));
    }
  };

  // 删除（v1 data-act="delete"：confirm 文案一致）
  const onDelete = (s: any) => {
    modal.confirm({
      title: `确定删除「${s.name}」？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api(`/api/stations/${s.id}`, { method: "DELETE" });
          message.success("已删除");
          await reload();
        } catch (e: any) {
          message.error(e.message);
        }
      },
    });
  };

  // ---- 添加/编辑弹窗（v1 openModal/modalSave 平移）---------------------------
  const openModal = (station: any) => {
    if (!types.length) {
      message.warning("资源类型暂未加载，请先重试资源配置加载。");
      return;
    }
    setEditing(station || null);
    const values = {
      name: station?.name || "",
      type: station?.type || types[0]?.value,
      baseUrl: station?.baseUrl || "",
      accessToken: "",
      userId: station?.userId || "",
      apiKey: "",
      email: station?.email || "",
      password: "",
      lowBalanceUsd: station?.lowBalanceUsd ?? "",
      cnyPerUsd: station?.cnyPerUsd ?? "",
      costAliasesText: Array.isArray(station?.costAliases) ? station.costAliases.join("\n") : "",
      includeInProfit: station?.includeInProfit !== false,
      isOwn: !!station?.isOwn,
      noRenewal: !!station?.noRenewal,
    };
    form.setFieldsValue(values);
    setFormFingerprint(connectionFingerprint(values, station?.id));
    setConnectionTest(null);
    setTestedFingerprint(null);
    // 付费记录：无记录时默认给一行、起始日期今天（同 v1 seedPurchaseRows）
    const list = station?.fixedPurchases;
    setPurchases(list && list.length ? list.map((p: any) => ({ ...p })) : [{ startDate: dayjs().format("YYYY-MM-DD") }]);
    setModalOpen(true);
  };

  const connectionFieldsFor = (type: string) => types.find((item) => item.value === type)?.needs || [];

  function connectionFingerprint(values: any, stationId = editing?.id) {
    const type = String(values.type || "").trim();
    const fields = connectionFieldsFor(type);
    const fingerprint: Record<string, string | null> = {
      stationId: stationId || null,
      type,
    };
    if (type !== "fixed") fingerprint.baseUrl = String(values.baseUrl || "").trim();
    for (const field of fields) {
      fingerprint[field] = field === "password"
        ? String(values[field] || "")
        : String(values[field] || "").trim();
    }
    return JSON.stringify(fingerprint);
  }

  const onFormValuesChange = (changed: any, values: any) => {
    if (!Object.keys(changed).some((field) => CONNECTION_FIELDS.has(field))) return;
    const fingerprint = connectionFingerprint(values);
    setFormFingerprint(fingerprint);
    if (testedFingerprint !== fingerprint) {
      setConnectionTest(null);
      setTestedFingerprint(null);
    }
  };

  const onTestConnection = async () => {
    const values = form.getFieldsValue();
    const type = String(values.type || "").trim();
    const fields = connectionFieldsFor(type);
    const fingerprint = connectionFingerprint(values);
    setTestingConnection(true);
    setConnectionTest(null);
    setTestedFingerprint(null);
    try {
      const payload: Record<string, unknown> = { stationId: editing?.id, type };
      if (type !== "fixed") payload.baseUrl = String(values.baseUrl || "").trim();
      for (const field of fields) payload[field] = values[field] ?? "";
      const result = await api("/api/stations/test", {
        body: payload,
      });
      setConnectionTest(result.ok
        ? result
        : { ok: false, ...resultIssue(result, result.message, values) });
      setTestedFingerprint(fingerprint);
    } catch (e: any) {
      const issue = resultIssue(null, e.message || "请求失败", values);
      setConnectionTest({
        ok: false,
        ...issue,
      });
      setTestedFingerprint(fingerprint);
    } finally {
      setTestingConnection(false);
    }
  };

  const onRetestSavedConnection = async (station: any) => {
    setRetestingIds((ids) => ({ ...ids, [station.id]: true }));
    setStationChecks((checks) => {
      const { [station.id]: _ignored, ...rest } = checks;
      return rest;
    });
    try {
      // 只传资源 ID 与类型；测试接口从已保存资源的内存副本读取凭证，不写库、不刷新、不告警。
      const result = await api("/api/stations/test", {
        body: { stationId: station.id, type: station.type },
      });
      if (!result.ok) {
        const issue = resultIssue(result, result.message);
        setStationChecks((checks) => ({
          ...checks,
          [station.id]: { issue, checkedAt: new Date().toISOString() },
        }));
        return;
      }

      const checkedAt = new Date().toISOString();
      setStations((list) => list.map((item) => item.id === station.id ? {
        ...item,
        balance: {
          ...(item.balance && item.balance.ok ? item.balance : {}),
          ok: true,
          checkedAt,
          latencyMs: result.latencyMs,
          account: result.account || null,
          remaining: result.remaining,
          currency: result.currency || null,
        },
      } : item));
      message.success(`${station.name} 已验证连接，当前展示已更新`);
    } catch (e: any) {
      const issue = resultIssue(null, e.message || "请求失败");
      setStationChecks((checks) => ({
        ...checks,
        [station.id]: { issue, checkedAt: new Date().toISOString() },
      }));
    } finally {
      setRetestingIds((ids) => ({ ...ids, [station.id]: false }));
    }
  };

  // 编辑时密钥不回显：placeholder 提示「已配置，留空保持不变」（同 v1）
  const credPlaceholder = (configured: boolean, fallback: string) =>
    editing ? (configured ? "已配置，留空保持不变" : fallback) : fallback;

  const onSave = async () => {
    const v = form.getFieldsValue();
    const type = String(v.type || "").trim();
    const connectionFields = connectionFieldsFor(type);
    const payload: any = {
      name: String(v.name || "").trim(),
      type,
      lowBalanceUsd: String(v.lowBalanceUsd ?? "").trim(),
      cnyPerUsd: String(v.cnyPerUsd ?? "").trim(),
      costAliases: String(v.costAliasesText || "")
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean),
      includeInProfit: !!v.includeInProfit,
      // 金额/天数保持字符串提交（同 v1 collectPurchases），全空行剔除
      fixedPurchases: purchases
        .map((p) => ({
          amount: String(p.amount ?? "").trim(),
          days: String(p.days ?? "").trim(),
          startDate: p.startDate || "",
        }))
        .filter((p) => p.amount !== "" || p.days !== ""),
      isOwn: v.type === "newapi" && !!v.isOwn,
      noRenewal: v.type !== "fixed" && !!v.noRenewal,
    };
    if (type !== "fixed") {
      payload.baseUrl = String(v.baseUrl || "").trim();
      for (const field of connectionFields) {
        const value = field === "password" ? String(v[field] || "") : String(v[field] ?? "").trim();
        // 编辑时敏感凭证留空表示保持已保存的值；其他当前类型字段按表单值提交。
        if (["accessToken", "apiKey", "password"].includes(field)) {
          if (value) payload[field] = value;
        } else {
          payload[field] = value;
        }
      }
    }
    // 切换接入类型时，删除不再适用的旧凭证和地址；同类型编辑仍允许敏感字段留空以保持原值。
    const applicableConnectionFields = new Set(type === "fixed" ? [] : ["baseUrl", ...connectionFields]);
    for (const field of CONNECTION_INPUT_FIELDS) {
      if (!applicableConnectionFields.has(field)) payload[field] = "";
    }
    if (payload.type === "fixed") {
      const bad = payload.fixedPurchases.find((p: any) => !(Number(p.amount) > 0) || !(Number(p.days) > 0));
      if (bad) return message.error("每笔付费需填写金额与天数（均大于 0）");
      if (!payload.fixedPurchases.length) return message.error("请至少填写一笔付费记录");
    } else if (!payload.baseUrl) {
      return message.error("请填写站点地址");
    }
    if (payload.type !== "fixed" && (!connectionTest?.ok || testedFingerprint !== formFingerprint)) {
      return message.warning("请先测试连接，确认成功后再保存");
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/stations/${editing.id}`, { method: "PUT", body: payload });
        message.success("已更新");
      } else {
        await api("/api/stations", { method: "POST", body: payload });
        message.success("已添加，正在查询余额…");
      }
      setModalOpen(false);
      setTimeout(() => reload().catch(() => {}), 800); // 新增后台正在首查，稍后再拉一次拿到余额
      await reload();
    } catch (e: any) {
      message.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // ---- 趋势详情弹窗（v1 openTrend 平移，实现见共享组件 TrendModal）-----------
  const openTrend = (s: any) => setTrendStation(s);
  // 弹窗内 KPI 用列表里的最新站点数据（轮询会更新）
  const trendCur = trendStation ? stations.find((x) => x.id === trendStation.id) || trendStation : null;

  // 表单当前类型的凭证需求与可见性（v1 syncCredFields）
  const curType = types.find((t) => t.value === formType);
  const needs: string[] = curType?.needs || [];
  const isFixed = formType === "fixed";
  const canSave = isFixed || (!!connectionTest?.ok && testedFingerprint === formFingerprint);
  const guidance = CONNECTION_GUIDANCE[formType] || null;
  const testState = isFixed
    ? { label: "无需测试", tone: "pending" }
    : testingConnection
      ? { label: "测试中", tone: "pending" }
      : connectionTest?.ok && testedFingerprint === formFingerprint
        ? { label: "已验证", tone: "ok" }
        : connectionTest
          ? { label: "需要修复", tone: "error" }
          : { label: "尚未测试", tone: "pending" };
  const retryInitialLoad = () => {
    reload().catch(() => {});
    loadMeta().catch(() => {});
  };

  if (!loaded && (loadError || metaError)) {
    return (
      <PageContainer
        className="responsive-page resources-page"
        title="上游资源"
        subTitle="统一管理供应连接、资金余额与消耗风险"
      >
        <AppState
          kind="error"
          title="上游资源暂时无法加载"
          description={loadError || metaError || "请稍后重试"}
          actions={<Button type="primary" onClick={retryInitialLoad}>重新加载</Button>}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      className="responsive-page resources-page"
      title="上游资源"
      subTitle={compact ? "查看余额、消耗与风险" : "统一管理供应连接、资金余额与消耗风险"}
      extra={
        <div className="page-toolbar">
          <LastRefreshed at={refreshedAt} />
          <Button className="touch-icon-button" icon={<ReloadOutlined />} loading={refreshingAll} onClick={onRefreshAll}>刷新</Button>
          {!compact ? <Button className="touch-icon-button desktop-station-action" type="primary" icon={<PlusOutlined />} disabled={!types.length || loadingMeta} onClick={() => openModal(null)}>添加资源</Button> : null}
        </div>
      }
    >
      {loadError ? (
        <Alert
          type="warning"
          showIcon
          message="资源数据刷新失败，正在显示上次成功加载的数据"
          description={loadError}
          action={<Button size="small" onClick={() => { reload().catch(() => {}); }}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {metaError ? (
        <Alert
          type="warning"
          showIcon
          message={types.length ? "资源配置刷新失败，正在使用上次成功加载的配置" : "资源配置暂时无法加载，暂不能添加或编辑资源"}
          description={metaError}
          action={<Button size="small" loading={loadingMeta} onClick={() => { loadMeta().catch(() => {}); }}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <ProCard className="station-list-card resource-list-card" loading={loadingList && !loaded}>
        {stations.length ? (
          <div>
            {stations.map((s) => (
              <StationRow
                key={s.id}
                s={s}
                settings={settings}
                types={types}
                etaDaysRule={rules.etaDays ?? 3}
                compact={compact}
                refreshing={!!refreshingIds[s.id]}
                retesting={!!retestingIds[s.id]}
                connectionCheck={stationChecks[s.id]}
                onTrend={openTrend}
                onRefresh={onRefreshOne}
                onRetest={onRetestSavedConnection}
                onEdit={openModal}
                onDelete={onDelete}
              />
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有上游资源</div>
                <div style={{ color: token.colorTextSecondary }}>
                  {compact ? "请在电脑端添加资源，移动端用于查看与刷新数据。" : "点击右上角「添加资源」，配置连接地址与凭证后即可监控余额。"}
                </div>
              </div>
            }
            style={{ padding: "40px 0" }}
          />
        )}
      </ProCard>

      {/* ---- 添加/编辑弹窗 ---- */}
      <Modal
        className="responsive-modal"
        title={editing ? "编辑上游资源" : "添加上游资源"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={onSave}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        okButtonProps={{ disabled: !canSave }}
        destroyOnHidden={false}
        width={520}
      >
        <div style={{ ...hint, marginBottom: 12 }}>凭证仅保存在本机，用于连接该上游并查询余额。</div>
        <Form form={form} layout="vertical" size="middle" onValuesChange={onFormValuesChange}>
          <Form.Item label="名称" name="name" style={{ marginBottom: 12 }}>
            <Input placeholder="例如：主力资源" />
          </Form.Item>
          <Form.Item label="类型" name="type" style={{ marginBottom: 12 }} extra="选择类型后会显示对应的凭证、续期与测试说明。">
            <Select options={types.map((t) => ({ value: t.value, label: t.label }))} />
          </Form.Item>
          {guidance ? (
            <Alert
              type="info"
              showIcon
              message={guidance.title}
              description={
                <div style={{ fontSize: 12, lineHeight: 1.65 }}>
                  <div><strong>所需凭证：</strong>{guidance.credentials}</div>
                  <div><strong>地址规则：</strong>{guidance.address}</div>
                  <div><strong>续期说明：</strong>{guidance.lifecycle}</div>
                  <div><strong>测试行为：</strong>{guidance.test}</div>
                </div>
              }
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {!isFixed && (
            <Form.Item label="站点地址" name="baseUrl" style={{ marginBottom: 12 }}>
              <Input placeholder="https://your-relay.com" />
            </Form.Item>
          )}
          {needs.includes("accessToken") && (
            <Form.Item
              label={String(formType || "").startsWith("sub2api") ? "登录令牌（JWT）" : "访问令牌"}
              name="accessToken"
              style={{ marginBottom: 12 }}
            >
              <Input placeholder={credPlaceholder(!!editing?.hasAccessToken, "令牌 / JWT")} />
            </Form.Item>
          )}
          {needs.includes("userId") && (
            <Form.Item label="用户 ID（New-Api-User）" name="userId" style={{ marginBottom: 12 }}>
              <Input placeholder="例如 1" />
            </Form.Item>
          )}
          {needs.includes("apiKey") && (
            <Form.Item label="API 密钥" name="apiKey" style={{ marginBottom: 12 }}>
              <Input placeholder={credPlaceholder(!!editing?.hasApiKey, "sk-...")} />
            </Form.Item>
          )}
          {needs.includes("email") && (
            <Form.Item label="登录邮箱" name="email" style={{ marginBottom: 12 }}>
              <Input placeholder="you@example.com" />
            </Form.Item>
          )}
          {needs.includes("password") && (
            <Form.Item label="登录密码" name="password" style={{ marginBottom: 12 }}>
              <Input.Password placeholder={credPlaceholder(!!editing?.hasPassword, "站点的登录密码")} />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item label="连接验证" style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                <div className={`resource-status resource-status--${testState.tone}`} aria-live="polite">
                  <span className="resource-status__dot" aria-hidden="true" />
                  {testState.label}
                </div>
                <Button type="dashed" style={{ minHeight: 44 }} loading={testingConnection} onClick={onTestConnection}>
                  {connectionTest ? "重新测试连接" : "测试连接"}
                </Button>
                {connectionTest ? (
                  <Alert
                    type={connectionTest.ok ? "success" : "error"}
                    showIcon
                    message={connectionTest.ok
                      ? `${connectionTest.message}${connectionTest.latencyMs != null ? `（${connectionTest.latencyMs}ms）` : ""}`
                      : `${connectionTest.category}：${connectionTest.message}`}
                    description={connectionTest.ok ? (
                      <div>
                        <div>连接信息尚未写入；点击保存后才会创建或更新资源。</div>
                        {connectionTest.account || testBalanceText(connectionTest) ? (
                          <div style={{ marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                            {[connectionTest.account ? `账户 ${connectionTest.account}` : null, testBalanceText(connectionTest)].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div>
                        <div>{connectionTest.action}</div>
                        {connectionTest.diagnostic ? <details style={{ marginTop: 6, overflowWrap: "anywhere" }}><summary style={{ display: "flex", alignItems: "center", minHeight: 40, cursor: "pointer" }}>查看脱敏诊断</summary><span>{connectionTest.diagnostic}</span></details> : null}
                      </div>
                    )}
                  />
                ) : (
                  <span style={hint}>请先测试连接；测试成功后才可保存资源。</span>
                )}
              </div>
            </Form.Item>
          )}
          {isFixed ? (
            <Alert
              type="info"
              showIcon
              message="固定成本无需测试连接"
              description="保存后仅按付费记录计算日均摊销，不会访问上游接口、刷新余额或触发连接类告警。"
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {!isFixed && (
            <Form.Item label="低余额告警阈值（按站点余额 $ 计，可留空）" name="lowBalanceUsd" style={{ marginBottom: 12 }}>
              <Input placeholder="留空则用全局阈值" />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item
              label="充值折算汇率（站点 $1 折合人民币 ¥）"
              name="cnyPerUsd"
              style={{ marginBottom: 12 }}
              extra="面板金额将按此汇率折算成人民币展示；余额告警仍按站点余额判断。"
            >
              <Input placeholder="如 2 表示 $1 = ¥2，留空按 1:1" />
            </Form.Item>
          )}
          <Form.Item
            name="includeInProfit"
            valuePropName="checked"
            style={{ marginBottom: 12 }}
            extra={isFixed
              ? "固定付费默认按天摊销计入利润成本；纯观察或不属于当前业务时关闭。"
              : "默认计入：即使本站不出现在 New API 渠道列表、只存在于外层 Sub2API 的内部负载均衡中，也会按用量或余额下降计入成本。仅纯观察节点或会造成重复汇总时关闭。"}
          >
            <Checkbox>计入利润成本</Checkbox>
          </Form.Item>
          {!isFixed && (
            <Form.Item
              label="成本渠道匹配别名"
              name="costAliasesText"
              style={{ marginBottom: 12 }}
              extra="当自有站渠道使用容器域名、内网 IP 或代理地址时，每行填写一个渠道地址；利润计算会将它们归属到此上游。"
            >
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder={"例如：sub2api-internal\n10.0.0.8:8080"} />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item
              name="noRenewal"
              valuePropName="checked"
              style={{ marginBottom: formType === "newapi" ? 12 : 0 }}
              extra="余额首次低于阈值时提醒一次；之后不再发送持续低余额、余额耗尽或预计耗尽提醒。查询失败告警不受影响。"
            >
              <Checkbox>不再续费此资源</Checkbox>
            </Form.Item>
          )}
          {isFixed && (
            <Form.Item label="固定成本付费记录（可叠加多笔）" style={{ marginBottom: 12 }}>
              {purchases.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <Input
                    placeholder="金额（¥）"
                    value={p.amount ?? ""}
                    onChange={(e) => setPurchases((l) => l.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                  <Input
                    placeholder="天数"
                    style={{ width: 90 }}
                    value={p.days ?? ""}
                    onChange={(e) => setPurchases((l) => l.map((x, j) => (j === i ? { ...x, days: e.target.value } : x)))}
                  />
                  <DatePicker
                    style={{ width: 150 }}
                    value={p.startDate ? dayjs(p.startDate) : null}
                    onChange={(d) =>
                      setPurchases((l) => l.map((x, j) => (j === i ? { ...x, startDate: d ? d.format("YYYY-MM-DD") : "" } : x)))
                    }
                  />
                  <Button
                    type="text"
                    icon={<CloseOutlined />}
                    title="删除这笔"
                    aria-label={`删除第 ${i + 1} 笔固定成本`}
                    onClick={() => setPurchases((l) => l.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => setPurchases((l) => [...l, { startDate: dayjs().format("YYYY-MM-DD") }])}
              >
                追加一笔
              </Button>
              <div style={hint}>
                每笔 = 金额 ÷ 天数 按天摊销，从购买日起生效、到期归零；多笔重叠期间成本叠加
                （在现有套餐上加购/续费就追加一笔）。不访问任何接口；站点地址可留空，
                填主机（不带端口）可匹配该主机所有端口的渠道。
              </div>
            </Form.Item>
          )}
          {formType === "newapi" && (
            <Form.Item
              name="isOwn"
              valuePropName="checked"
              style={{ marginBottom: 0 }}
              extra="启用「自营业务」下游分析（分用户/分模型用量与消费预测）。需要管理员（root）账号的系统访问令牌与用户 ID。转售给他人的管理员 Key 可在「自营业务」页的「管理员转售 Key」中勾选，其消费计入转售收入。"
            >
              <Checkbox>这是我的自营资源</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ---- 趋势详情弹窗（共享组件，运营总览同款） ---- */}
      <TrendModal station={trendCur} onClose={() => setTrendStation(null)} etaDaysRule={rules.etaDays ?? 3} />
    </PageContainer>
  );
}
