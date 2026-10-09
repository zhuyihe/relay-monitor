"use client";
// 上游资源页：资源列表 + 添加/编辑弹窗 + 单项刷新/归档 + 余额趋势详情弹窗
// 功能对照 v1 app.js：renderStations/stationRow（553-586、193-288）、站点表单弹窗（1487-1614）、
// 趋势弹窗 openTrend/drawChart（1675-1822）——文案与数字口径逐条对齐，布局用 Pro 风格重排
import { useCallback, useEffect, useRef, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  theme,
} from "antd";
import {
  PlusOutlined,
  ReloadOutlined,
  EditOutlined,
  InboxOutlined,
  DeleteOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import TrendModal from "../trend-modal";
import LastRefreshed from "../last-refreshed";
import AppState from "../../components/app-state";
import ChannelOnboarding from "../../components/channel-onboarding";
import dayjs from "dayjs";
import { api, cny, usd, rateOf, fmtTokens, fmtEta, statusOf, readWorkflowDestination } from "../../../lib/client";
import type { AccountReadModel, AccountRecord, AccountKeyScope, PublicResource, AccountAuthorizationInput, AccountAuthorizationProbe, AccountAuthorizationResult, AccountAuthorizationRecoveryIntent, WorkflowDestination, UpstreamKeyRead } from "../../../lib/client";
import { describeConnectionFailure } from "../../../lib/connection-test";

const { Text } = Typography;
const AUTHORIZATION_RECOVERY_KEY = "account-authorization-recovery-v05";

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
  onArchive: (s: any) => void;
  onPurge: (s: any) => void;
}) {
  const {
    s, settings, types, etaDaysRule, compact, refreshing, retesting, connectionCheck,
    onTrend, onRefresh, onRetest, onEdit, onArchive, onPurge,
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
          <div className="mobile-station-card__footer">
            <Button type="text" aria-label={`编辑 ${s.name}`} onClick={() => onEdit(s)}>编辑</Button>
            {s.archivedAt ? (
              <Button type="text" danger aria-label={`彻底删除 ${s.name}`} onClick={() => onPurge(s)}>彻底删除</Button>
            ) : (
              <Button type="text" aria-label={`归档 ${s.name}`} onClick={() => onArchive(s)}>归档</Button>
            )}
          </div>
        </article>
      );
    }
    return (
      <div className="station-row desktop-station-row resource-list-row" style={rowStyle}>
        <div className="station-row__main">
          <div className="station-row__name resource-list-row__name" style={{ fontWeight: 600 }}>
            {s.name}<span className="resource-flag">固定成本</span>{s.archivedAt ? <span className="resource-flag">已归档</span> : null}
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
          {s.archivedAt ? (
            <Button type="text" danger icon={<DeleteOutlined />} title="彻底删除" aria-label={`彻底删除 ${s.name}`} onClick={() => onPurge(s)} />
          ) : (
            <Button type="text" icon={<InboxOutlined />} title="归档" aria-label={`归档 ${s.name}`} onClick={() => onArchive(s)} />
          )}
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
              {s.archivedAt ? <span className="resource-flag">已归档</span> : null}
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
          {!s.archivedAt ? <Button type="text" aria-label={`刷新 ${s.name}`} icon={<ReloadOutlined />} loading={refreshing} onClick={() => onRefresh(s)}>刷新</Button> : null}
          {s.archivedAt ? (
            <Button type="text" danger aria-label={`彻底删除 ${s.name}`} onClick={() => onPurge(s)}>彻底删除</Button>
          ) : (
            <Button type="text" aria-label={`归档 ${s.name}`} onClick={() => onArchive(s)}>归档</Button>
          )}
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
          {s.archivedAt ? <span className="resource-flag">已归档</span> : null}
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
        {!s.archivedAt ? <Button type="text" icon={<ReloadOutlined />} title="刷新" aria-label={`刷新 ${s.name}`} loading={refreshing} onClick={() => onRefresh(s)} /> : null}
        <Button type="text" icon={<EditOutlined />} title="编辑" aria-label={`编辑 ${s.name}`} onClick={() => onEdit(s)} />
        {s.archivedAt ? (
          <Button type="text" danger icon={<DeleteOutlined />} title="彻底删除" aria-label={`彻底删除 ${s.name}`} onClick={() => onPurge(s)} />
        ) : (
          <Button type="text" icon={<InboxOutlined />} title="归档" aria-label={`归档 ${s.name}`} onClick={() => onArchive(s)} />
        )}
      </Space>
    </div>
  );
}

// ---- 页面 --------------------------------------------------------------------
export default function StationsPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = screens.md === false;
  const hint = hintStyle(token);
  const [form] = Form.useForm();

  const [stations, setStations] = useState<any[]>([]);
  const [showArchived, setShowArchived] = useState(false);
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
  const [accountModel, setAccountModel] = useState<AccountReadModel | null>(null);
  const [accountError, setAccountError] = useState("");
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [expandedAccounts, setExpandedAccounts] = useState<string[]>([]);
  const destinationResolved = useRef(false);
  const [verificationStation, setVerificationStation] = useState<any>(null);
  const [verification, setVerification] = useState<UpstreamKeyRead | null>(null);
  const [verificationTimezone, setVerificationTimezone] = useState("Asia/Shanghai");
  const [verificationTokenId, setVerificationTokenId] = useState<number>();
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const verificationEpoch = useRef(0);
  const accountReadEpoch = useRef(0);
  const [authorizationAccount, setAuthorizationAccount] = useState<AccountRecord | null>(null);
  const [authorizationTargets, setAuthorizationTargets] = useState<string[]>([]);
  const [authorizationRequestId, setAuthorizationRequestId] = useState("");
  const [authorizationProbe, setAuthorizationProbe] = useState<AccountAuthorizationProbe | null>(null);
  const [authorizationResult, setAuthorizationResult] = useState<AccountAuthorizationResult | null>(null);
  const [authorizationError, setAuthorizationError] = useState("");
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [reuseAuthorization, setReuseAuthorization] = useState(false);
  const [previouslyUpdatedIds, setPreviouslyUpdatedIds] = useState<string[]>([]);
  const [authorizationRecovery, setAuthorizationRecovery] = useState<{ accountKey: string; retryInput: AccountAuthorizationRecoveryIntent } | null>(null);
  const [authorizationForm] = Form.useForm();
  const authorizationType = Form.useWatch("type", authorizationForm) || "newapi";
  const authorizationEpoch = useRef(0);
  const [purposeTarget, setPurposeTarget] = useState<{ resource?: PublicResource; monitorEnabled?: boolean; key?: AccountKeyScope; ruleId?: string } | null>(null);
  const [purposeBusy, setPurposeBusy] = useState(false);
  const [purposeError, setPurposeError] = useState("");

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
  // 资源生命周期：默认归档保留历史；物理删除必须在独立危险流程中输入确认词。
  const [archiveTarget, setArchiveTarget] = useState<any>(null);
  const [purgeTarget, setPurgeTarget] = useState<any>(null);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [purging, setPurging] = useState(false);

  const loadAccounts = useCallback(async () => {
    const current = ++accountReadEpoch.current;
    setLoadingAccounts(true);
    try {
      const next: AccountReadModel = await api("/api/channel-onboarding/accounts");
      if (current === accountReadEpoch.current) { setAccountModel(next); setAccountError(""); }
    } catch (err: any) {
      if (current === accountReadEpoch.current) setAccountError(err.message || "账号关系暂不可用");
    } finally {
      if (current === accountReadEpoch.current) setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    setDestination(readWorkflowDestination(window.location.search, "stations"));
    try {
      const stored = JSON.parse(sessionStorage.getItem(AUTHORIZATION_RECOVERY_KEY) || "null");
      if (/^[a-f0-9]{64}$/.test(stored?.accountKey || "") && typeof stored.retryInput?.requestId === "string" && Array.isArray(stored.retryInput.targetStationIds) && stored.retryInput.targetStationIds.every((id: any) => typeof id === "string")) {
        setAuthorizationRecovery({ accountKey: stored.accountKey, retryInput: { requestId: stored.retryInput.requestId, targetStationIds: [...stored.retryInput.targetStationIds] } });
      }
    } catch { /* 不阻断资源读取。 */ }
    return () => { authorizationEpoch.current += 1; };
  }, []);

  useEffect(() => {
    if (!destination || destinationResolved.current || !loaded || !accountModel || loadingAccounts || loadingList || accountError || loadError) return;
    if (["connect", "coverage", "source"].includes(destination.action) && !destination.error) return;
    destinationResolved.current = true;
    if (destination.error) { setWorkflowError(destination.error); return; }
    const account = accountModel.accounts.find((account) => account.accountKey === destination.accountKey || account.resources.some((resource) => resource.id === destination.stationId));
    if (["verify", "verify-billing"].includes(destination.action)) {
      const original = stations.find((station) => station.id === destination.stationId && !station.archivedAt);
      if (!original) { setWorkflowError("此资源已删除或归档，请刷新当前事项后重新打开。"); return; }
      if (!["newapi", "newapi-key", "sub2api", "sub2api-password"].includes(original.type)) { setWorkflowError("此资源不支持账号与 Key 账单核验，请返回原资源设置。"); return; }
      openVerification(original);
    } else if (destination.action === "authorization") {
      if (!account || account.accountKey !== destination.accountKey || !authorizationEligible(account).length) { setWorkflowError("此账号或可更新目标已变化，请刷新当前账号关系后重新打开。"); return; }
      openAuthorization(account);
    } else {
      const original = stations.find((station) => station.id === destination.stationId);
      if (!account && !original) { setWorkflowError("此资源已删除、归档或不在当前目录中，请刷新当前事项后重新打开。"); return; }
    }
    setAccountSearch(account?.accountKey || destination.stationId || "");
    if (account) setExpandedAccounts([account.accountKey]);
  // 只在当前资源与账号读取均成功后定位，自动刷新不重复打开授权流程。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, loaded, accountModel, loadingAccounts, loadingList, accountError, loadError]);

  const openVerification = (station: any) => {
    verificationEpoch.current += 1; setVerificationStation(station); setVerification(null); setVerificationTokenId(undefined); setVerificationTimezone("Asia/Shanghai"); setVerificationError("");
  };
  const verifyUpstream = async (selected: number | null = verificationTokenId ?? null) => {
    if (!verificationStation || verificationStation.isOwn || verificationStation.type === "newapi-key") return;
    const epoch = ++verificationEpoch.current; setVerificationBusy(true); setVerificationError("");
    try {
      const params = new URLSearchParams({ force: "true", timezone: verificationTimezone });
      if (selected != null) params.set("tokenId", String(selected));
      const next: UpstreamKeyRead = await api(`/api/reconciliation/upstreams/${encodeURIComponent(verificationStation.id)}/keys?${params}`);
      if (epoch === verificationEpoch.current) setVerification(next);
    } catch (err: any) { if (epoch === verificationEpoch.current) { setVerification(null); setVerificationError(err.message || "实际核验暂不可用，请检查授权或稍后重试"); } }
    finally { if (epoch === verificationEpoch.current) setVerificationBusy(false); }
  };
  useEffect(() => {
    if (!verificationStation) return;
    const current = stations.find((station) => station.id === verificationStation.id);
    if (!current || current.archivedAt || current.type !== verificationStation.type || current.authVersion !== verificationStation.authVersion || current.resourceVersion !== verificationStation.resourceVersion) {
      verificationEpoch.current += 1; setVerification(null); setVerificationBusy(false); setVerificationError("资源配置已变化，请关闭此处并刷新处理目标后重新核验。");
    }
  }, [stations, verificationStation]);

  const rememberAuthorization = (accountKey: string, intent: AccountAuthorizationRecoveryIntent | null) => {
    const safe = intent ? { accountKey, retryInput: { requestId: intent.requestId, targetStationIds: [...intent.targetStationIds] } } : null;
    setAuthorizationRecovery(safe);
    try { if (safe) sessionStorage.setItem(AUTHORIZATION_RECOVERY_KEY, JSON.stringify(safe)); else sessionStorage.removeItem(AUTHORIZATION_RECOVERY_KEY); } catch { /* 当前抽屉仍可核对。 */ }
  };
  const authorizationName = (id: string) => accountModel?.accounts.flatMap((account) => account.resources).find((resource) => resource.id === id)?.name || accountModel?.unverifiedResources.find((resource) => resource.id === id)?.name || stations.find((station) => station.id === id)?.name || id;
  const authorizationEligible = (account: AccountRecord) => account.resources.filter((resource) => !resource.archivedAt && resource.type !== "newapi-key" && !stations.some((station) => station.id === resource.id && station.isOwn));
  const initializeAuthorizationForm = (account: AccountRecord) => {
    authorizationForm.resetFields();
    authorizationForm.setFieldsValue({ type: account.identity.provider === "newapi" ? "newapi" : authorizationEligible(account)[0]?.type || "sub2api" });
  };
  const openAuthorization = (account: AccountRecord) => {
    authorizationEpoch.current += 1; setAuthorizationAccount(account); setAuthorizationTargets(authorizationEligible(account).map((resource) => resource.id!)); setAuthorizationRequestId(crypto.randomUUID()); setAuthorizationProbe(null); setAuthorizationResult(null); setAuthorizationError(""); setReuseAuthorization(false); setPreviouslyUpdatedIds([]); initializeAuthorizationForm(account);
  };
  const freshAuthorization = () => {
    if (!authorizationAccount) return;
    const saved = authorizationResult?.targets.filter((target) => ["updated", "already_updated"].includes(target.status)).map((target) => target.stationId) || [];
    const remaining = authorizationResult?.targets.filter((target) => !saved.includes(target.stationId) && !authorizationResult.excluded.some((item) => item.stationId === target.stationId)).map((target) => target.stationId);
    setPreviouslyUpdatedIds([...new Set([...previouslyUpdatedIds, ...saved])]); if (remaining) setAuthorizationTargets(remaining);
    authorizationEpoch.current += 1; setAuthorizationRequestId(crypto.randomUUID()); setAuthorizationProbe(null); setAuthorizationResult(null); setReuseAuthorization(false); initializeAuthorizationForm(authorizationAccount);
  };
  const authorizationInput = async (reuse = reuseAuthorization): Promise<AccountAuthorizationInput> => {
    if (!authorizationAccount || !authorizationTargets.length) throw new Error("请选择明确的更新目标");
    const intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    if (reuse) return { ...intent, reuseSavedAuthorization: true };
    const values = await authorizationForm.validateFields();
    return { ...intent, authorization: { type: values.type, baseUrl: authorizationAccount.identity.baseUrl,
      ...(values.type === "sub2api-password" ? { email: values.email, password: values.password } : { accessToken: values.accessToken }),
      ...(values.type === "newapi" ? { userId: authorizationAccount.identity.accountId } : {}) } };
  };
  const probeAuthorization = async (reuse = reuseAuthorization) => {
    const current = ++authorizationEpoch.current; setAuthorizationError(""); setAuthorizationBusy(true);
    try {
      const input = await authorizationInput(reuse);
      if (current !== authorizationEpoch.current) return;
      const next: AccountAuthorizationProbe = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(authorizationAccount!.accountKey)}/authorization/probe`, { body: input });
      if (current !== authorizationEpoch.current) return;
      setAuthorizationProbe(next); setReuseAuthorization(reuse); rememberAuthorization(next.accountKey, next.retryInput);
      if (reuse) authorizationForm.resetFields();
    } catch (err: any) {
      if (current !== authorizationEpoch.current) return;
      setAuthorizationProbe(null);
      if (!err.errorFields) {
        if (reuse) { freshAuthorization(); setAuthorizationError(`${err.message}。请重新输入授权，已开始新的更新操作。`); }
        else setAuthorizationError(err.message || "授权预览失败，请重试");
      }
    } finally { setAuthorizationBusy(false); }
  };
  const acceptAuthorizationResult = (next: AccountAuthorizationResult) => {
    setAuthorizationResult(next); setAuthorizationProbe(null); setReuseAuthorization(true); authorizationForm.resetFields();
    rememberAuthorization(next.accountKey, next.complete ? null : next.retryInput);
    if (next.complete) message.success("本次所选目标的授权已更新，原设置与历史保留");
  };
  const recoverAuthorization = async (saved = authorizationRecovery, restore = false) => {
    if (!saved) return;
    const account = accountModel?.accounts.find((item) => item.accountKey === saved.accountKey);
    if (restore && !account) { setAccountError("原账号暂不在当前关系中，请刷新并核验资源后恢复"); return; }
    if (restore && account) { openAuthorization(account); setAuthorizationRequestId(saved.retryInput.requestId); setAuthorizationTargets(saved.retryInput.targetStationIds); }
    setAuthorizationBusy(true); setAuthorizationError("");
    try { acceptAuthorizationResult(await api(`/api/channel-onboarding/accounts/${encodeURIComponent(saved.accountKey)}/authorization/recover`, { body: saved.retryInput })); }
    catch (err: any) { setAuthorizationError(err.message || "结果核对失败，请重试"); }
    finally { setAuthorizationBusy(false); }
  };
  const confirmAuthorization = async () => {
    if (!authorizationProbe || Date.now() >= authorizationProbe.expiresAtMs) { setAuthorizationProbe(null); setAuthorizationError("预览已失效，请重新验证"); return; }
    setAuthorizationBusy(true); setAuthorizationError("");
    const accountKey = authorizationAccount!.accountKey, intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    try { acceptAuthorizationResult(await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization`, { body: { ...await authorizationInput(), previewId: authorizationProbe.previewId } })); await reload(); }
    catch (err: any) {
      setAuthorizationProbe(null); setAuthorizationError(err.message || "保存结果未取得，请核对结果");
      try { const recovered: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization/recover`, { body: intent }); acceptAuthorizationResult(recovered); if (recovered.complete) setAuthorizationError(""); }
      catch { rememberAuthorization(accountKey, intent); }
    } finally { setAuthorizationBusy(false); }
  };
  const confirmPurpose = async () => {
    if (!purposeTarget) return;
    setPurposeBusy(true); setPurposeError("");
    try {
      if (purposeTarget.resource) {
        const resource = purposeTarget.resource;
        if (stations.some((station) => station.id === resource.id && station.isOwn)) throw new Error("本站来源不参与此操作");
        await api(`/api/stations/${encodeURIComponent(resource.id!)}`, { method: "PUT", body: { monitorEnabled: purposeTarget.monitorEnabled === true, expectedAuthVersion: resource.authVersion, expectedResourceVersion: resource.resourceVersion } });
        message.success(purposeTarget.monitorEnabled ? "该资源监控已启用，保持现有成本设置" : "该资源监控已暂停，账单关联与历史保留");
      } else {
        if (!purposeTarget.ruleId) throw new Error("请选择明确的核算规则");
        await api(`/api/reconciliation/rules/${encodeURIComponent(purposeTarget.ruleId)}`, { method: "DELETE" }); message.success("所选规则已停止核算，历史保留");
      }
      setPurposeTarget(null); await reload();
    } catch (err: any) { setPurposeError(`${err.message || "操作失败"}；请刷新关系并重新打开影响预览。`); }
    finally { setPurposeBusy(false); }
  };

  // 列表加载（GET /api/stations 同时带回全局设置，同 v1 reload）
  const reload = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await api(`/api/stations?includeUnmonitored=true${showArchived ? "&includeArchived=true" : ""}`);
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
      void loadAccounts();
    }
  }, [showArchived, loadAccounts]);

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
    return () => { accountReadEpoch.current += 1; };
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
      await api("/api/refresh", { method: "POST", body: {} });
      await reload();
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
      void loadAccounts();
      if (!r.balance.ok) message.error(`${s.name}：${resultIssue(null, r.balance.error).message}`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRefreshingIds((m) => ({ ...m, [s.id]: false }));
    }
  };

  const onArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      const result = await api(`/api/stations/${archiveTarget.id}`, { method: "DELETE" });
      if (!result.ok) throw new Error(result.error || "资源不存在或已归档");
      message.success(`已归档「${archiveTarget.name}」，监测历史会继续保留用于分析`);
      setArchiveTarget(null);
      await reload();
    } catch (e: any) {
      message.error(e.message || "归档失败");
    } finally {
      setArchiving(false);
    }
  };

  const onPurge = async () => {
    if (!purgeTarget || purgeConfirm !== "DELETE") return;
    setPurging(true);
    try {
      const result = await api(`/api/stations/${purgeTarget.id}?purge=true`, { method: "DELETE", body: { confirm: "DELETE" } });
      if (!result.ok) throw new Error(result.error || "资源不存在或已删除");
      message.success(`已彻底删除「${purgeTarget.name}」及其监测历史`);
      setPurgeTarget(null);
      setPurgeConfirm("");
      await reload();
    } catch (e: any) {
      message.error(e.message || "彻底删除失败");
    } finally {
      setPurging(false);
    }
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

  const monitoredStations = stations.filter((station) => station.monitorEnabled !== false);
  const accountQuery = accountSearch.trim().toLowerCase();
  const matchesAccountQuery = (values: unknown[]) => values.join(" ").toLowerCase().includes(accountQuery);
  const filteredAccounts = (accountModel?.accounts || []).filter((account) =>
    (accountFilter !== "attention" || account.actions.some((action) => action.kind !== "inspect_balance")) &&
    matchesAccountQuery([account.accountKey, account.identity.provider, account.identity.baseUrl, account.identity.accountId,
      ...account.resources.flatMap((resource) => [resource.id, resource.name, resource.type]),
      ...account.keys.flatMap((key) => [key.tokenId, key.tokenName, ...key.channels.flatMap((channel) => [channel.channelId, channel.name])])])
  );
  const accountSites = new Map<string, AccountRecord[]>();
  for (const account of filteredAccounts) accountSites.set(account.siteKey, [...(accountSites.get(account.siteKey) || []), account]);
  const unverifiedResources = (accountModel?.unverifiedResources || []).filter((resource) =>
    (showArchived || !resource.archivedAt) && matchesAccountQuery([resource.id, resource.name, resource.type, resource.baseUrl])
  );
  const renderAccountResource = (resource: PublicResource) => {
    const original = stations.find((station) => station.id === resource.id);
    return <div key={resource.id} data-resource-id={resource.id} style={{ paddingBlock: 10, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <Space wrap><Text strong>{resource.name}</Text><Tag>{resource.purposes.monitor ? "余额监控" : "监控暂停 / 未启用"}</Tag>{resource.archivedAt ? <Tag>已归档</Tag> : null}{resource.purposes.billingRuleIds.length ? <Tag>关联账单规则 {resource.purposes.billingRuleIds.length}</Tag> : null}</Space>
      <div><Text type="secondary">原资源 ID：{resource.id} · {resource.type} · {resource.baseUrl}</Text></div>
      <div><Text type="secondary">提醒阈值：{resource.lowBalanceUsd == null ? "沿用全局" : usd(resource.lowBalanceUsd)}；折算汇率：{resource.cnyPerUsd == null ? "沿用默认" : `${resource.cnyPerUsd} RMB/USD`}；成本设置：{resource.includeInProfit ? "纳入" : "不纳入"}{resource.noRenewal ? "；不再续费" : ""}</Text></div>
      {resource.purposes.billingRuleIds.length ? <div><Text type="secondary">账单关系（含历史）：{resource.purposes.billingRuleIds.join("、")}</Text></div> : null}
      {!resource.purposes.monitor ? <div><Text type="secondary">监控暂停/未启用，现有账单关系继续保留。</Text></div> : null}
      {original && !compact ? <Button disabled={loadingMeta || !types.length} style={{ minHeight: 40, marginTop: 8 }} aria-label={`查看原资源设置 ${resource.name}`} onClick={() => openModal(original)}>资源设置</Button> : <Text type="secondary">原资源设置使用完整资源记录；余额与趋势见下方监控资源。</Text>}
      {!resource.archivedAt && !original?.isOwn ? <Button style={{ minHeight: 44, marginTop: 8 }} disabled={loadingAccounts || !!accountError || authorizationBusy} aria-label={`${resource.monitorEnabled ? "暂停" : "启用"}监控 ${resource.name}`} onClick={() => { setPurposeError(""); setPurposeTarget({ resource, monitorEnabled: !resource.monitorEnabled }); }}>{resource.monitorEnabled ? "暂停监控" : "启用监控"}</Button> : null}
    </div>;
  };
  const accountBoundary = (value: number | null) => value == null ? "待核验" : `${new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC")}`;

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
          <Button
            aria-pressed={showArchived}
            onClick={() => setShowArchived((current) => !current)}
          >
            {showArchived ? "隐藏归档资源" : "查看归档资源"}
          </Button>
          <Button className="touch-icon-button" icon={<ReloadOutlined />} loading={refreshingAll} onClick={onRefreshAll}>刷新</Button>
          {!compact ? <Button className="touch-icon-button desktop-station-action" type="primary" icon={<PlusOutlined />} disabled={!types.length || loadingMeta} onClick={() => openModal(null)}>添加资源</Button> : null}
        </div>
      }
    >
      <ChannelOnboarding compact={compact} onComplete={reload} destination={destination} />
      {workflowError ? <Alert type="warning" showIcon message={workflowError} action={<Space wrap><Button onClick={() => window.location.reload()}>刷新处理目标</Button><Button href="/stations">返回当前资源</Button></Space>} style={{ marginBottom: 16 }} /> : null}
      {destination?.action === "inspect" && !workflowError ? <section aria-label="定位原资源余额与监控" style={{ marginBottom: 16 }}><Alert type="info" showIcon message="按原资源查看余额与监控" description="同账号资源可能覆盖同一余额，下方分别显示原记录，不相加。" />{stations.filter((station) => destination.stationId ? station.id === destination.stationId : accountModel?.accounts.find((account) => account.accountKey === destination.accountKey)?.resources.some((resource) => resource.id === station.id)).map((station) => <div key={station.id} style={{ paddingBlock: 8, overflowWrap: "anywhere" }}><Text strong>{station.name}</Text><div>原资源 ID：{station.id} · {station.monitorEnabled === false ? "监控暂停 / 未启用" : "监控启用"} · {station.balance?.ok ? `余额 ${usd(station.balance.remaining)}` : "余额暂不可用"}</div><Space wrap><Button disabled={!types.length} onClick={() => openModal(station)}>原资源设置</Button>{station.monitorEnabled !== false && !station.archivedAt ? <Button onClick={() => openTrend(station)}>查看余额与监控趋势</Button> : null}</Space></div>)}</section> : null}
      <section aria-label="账号关系中心" style={{ minWidth: 0, marginBottom: 16, overflowWrap: "anywhere" }}>
        <ProCard title="账号关系" extra={<Button style={{ minHeight: 40 }} loading={loadingAccounts} onClick={() => void loadAccounts()}>刷新账号关系</Button>} loading={loadingAccounts && !accountModel}>
          <Space direction="vertical" style={{ width: "100%", minWidth: 0 }} size={12}>
            <Text type="secondary">按已核验的上游账号查看资源、Key 与本站渠道。各资源可能覆盖同一余额，继续按原资源查看，不合计账号余额。</Text>
            <div className="page-toolbar" style={{ width: "100%" }}><Input aria-label="搜索账号关系" allowClear placeholder="搜索站点、账号、资源、Key 或渠道" value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} style={{ flex: "1 1 200px", minWidth: 0, fontSize: compact ? 16 : undefined }} /><Select aria-label="账号关系状态" value={accountFilter} onChange={setAccountFilter} style={{ minWidth: 130 }} options={[{ value: "all", label: "全部账号" }, { value: "attention", label: "需处理" }]} />{authorizationRecovery ? <Button style={{ minHeight: 44 }} disabled={loadingAccounts || authorizationBusy} onClick={() => void recoverAuthorization(authorizationRecovery, true)}>恢复上次授权更新</Button> : null}</div>
            {accountError ? <Alert type="warning" showIcon message={accountModel ? "账号关系刷新失败，正在显示上次结果" : "账号关系暂不可用"} description={accountError} action={<Button aria-label="重试账号关系" onClick={() => void loadAccounts()}>重试</Button>} /> : null}
            {accountModel ? <Text type="secondary">显示 {filteredAccounts.length}/{accountModel.accounts.length} 个已核验账号；待核验资源 {unverifiedResources.length}/{accountModel.unverifiedResources.length} · 关系读取：{new Date(accountModel.generatedAt).toLocaleString("zh-CN")}</Text> : null}
            <Space wrap>{accountModel?.actions.filter((action) => action.kind === "review_source").map((action) => <Button key={action.id} href={action.href}>{action.label}</Button>)}</Space>
            {[...accountSites].map(([siteKey, accounts]) => <div key={siteKey} data-site-key={siteKey} style={{ width: "100%", minWidth: 0 }}>
              <Text strong>{accounts[0].identity.provider === "newapi" ? "New API" : "Sub2API"} · {accounts[0].identity.baseUrl}</Text>
              <Collapse ghost activeKey={expandedAccounts} onChange={(keys) => setExpandedAccounts(Array.isArray(keys) ? keys.map(String) : [String(keys)])} items={accounts.map((account) => ({ key: account.accountKey,
                label: <Space wrap><Text strong>账号 {account.identity.accountId}</Text><Text type="secondary">{account.resources.filter((resource) => showArchived || !resource.archivedAt).length} 个资源 · {account.keys.length} 把 Key</Text>{account.actions.some((action) => action.kind !== "inspect_balance") ? <Tag color="warning">需处理</Tag> : null}</Space>,
                children: <div data-account-key={account.accountKey} style={{ minWidth: 0 }}>
                  <Text type="secondary">已核验账号 ID：{account.identity.accountId} · {account.identity.baseUrl}</Text>
                  <div><Text type="secondary">待处理：{[...new Set(account.actions.filter((action) => action.kind !== "inspect_balance").map((action) => action.label))].join("；") || "暂无待处理事项"}</Text></div>
                  <Space wrap>{account.actions.map((action) => <Button key={action.id} href={action.href}>{action.label}</Button>)}</Space>
                  <Button style={{ minHeight: 44, marginTop: 8 }} disabled={loadingAccounts || !!accountError || authorizationBusy || !authorizationEligible(account).length} aria-label={`更新账号授权 ${account.identity.provider} ${account.identity.accountId}`} onClick={() => openAuthorization(account)}>更新此账号授权</Button>
                  {account.resources.filter((resource) => showArchived || !resource.archivedAt).map(renderAccountResource)}
                  {account.resources.some((resource) => resource.archivedAt) && !showArchived ? <Text type="secondary">另有归档资源，使用页面上方「查看归档资源」展开。</Text> : null}
                  {account.keys.length ? <Collapse ghost items={account.keys.map((key) => ({ key: key.canonicalKey,
                    label: <Space wrap><Text strong>{key.tokenName || `Key ${key.tokenId}`} · #{key.tokenId}</Text><Tag color={key.scopeAmbiguous ? "error" : key.activeRuleIds.length ? "processing" : "default"}>{key.scopeAmbiguous ? "有效规则范围冲突" : key.activeRuleIds.length ? "正在核算" : "已停止核算 / 历史范围"}</Tag></Space>,
                    children: <div data-canonical-key={key.canonicalKey} style={{ minWidth: 0 }}>
                      <div><Text>规则（含历史）：{key.ruleIds.join("、")}</Text></div>
                      <div><Text>有效规则：{key.activeRuleIds.join("、") || "无"}</Text></div>
                      {key.activeRuleIds.length ? <Button style={{ minHeight: 44, marginBlock: 8 }} disabled={loadingAccounts || !!accountError || authorizationBusy} aria-label={`停止 Key ${key.tokenId} 的账单核算`} onClick={() => { setPurposeError(""); setPurposeTarget({ key, ruleId: key.activeRuleIds.length === 1 ? key.activeRuleIds[0] : undefined }); }}>停止此 Key 的账单核算</Button> : null}
                      {key.scopeAmbiguous ? <Alert type="warning" showIcon message="存在多个有效规则，范围待核对" description="当前覆盖、生效时间与范围版本尚未统一确认。" /> : <><div><Text>{key.activeRuleIds.length ? "当前" : "历史"}范围版本：{key.scopeVersion ?? "待核验"} · {key.costCoverage === "complete" ? "用途范围已确认" : "用途范围待确认"}</Text></div><div><Text>{key.activeRuleIds.length ? "生效边界" : "历史生效边界"}：{accountBoundary(key.billingEffectiveFromMs)}</Text></div><div><Text>首个完整账单查询边界：{accountBoundary(key.firstQueryableAtMs)}</Text></div></>}
                      {key.coverageDeclaration.answer === "other_use" ? <div><Text type="secondary">其他用途：{key.coverageDeclaration.otherUse === "own_channels" ? `本站其他渠道 ${key.coverageDeclaration.uncoveredOwnChannelIds.map((id) => `#${id}`).join("、") || "待补充"}` : key.coverageDeclaration.otherUse === "external" ? "站外调用" : "尚未明确"}</Text></div> : null}
                      <div style={{ marginTop: 8 }}><Text strong>关联渠道（含历史）</Text>{key.channels.map((channel) => <div key={`${channel.ownSource?.namespaceKey || channel.ownStationId}:${channel.channelId}`}><Text>{channel.name || `渠道 ${channel.channelId}`} · #{channel.channelId}</Text><div><Text type="secondary">{channel.ownSource ? `本站账号 ${channel.ownSource.accountId} · ${channel.ownStationId}` : `来源待核验 · ${channel.ownStationId}`}</Text></div></div>)}</div>
                    </div>,
                  }))} /> : <Text type="secondary">尚无已核验的 Key 账单关系。</Text>}
                </div>,
              }))} />
            </div>)}
            {!filteredAccounts.length && accountModel ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={accountModel.accounts.length ? "没有匹配的已核验账号" : "暂无已核验账号"} /> : null}
            <div style={{ width: "100%", minWidth: 0 }}><Text strong>独立 Key 与待核验资源</Text><Text type="secondary"> · 保留原记录，渠道关联不能证明所属账号。</Text>{unverifiedResources.map((resource) => <div key={resource.id} data-unverified-resource-id={resource.id} style={{ marginTop: 12 }}>
              <Tag color="warning">{resource.type === "newapi-key" ? "独立 Key · 所属账号未核验" : "账号身份待核验"}</Tag>
              {renderAccountResource(resource)}
              <div><Text type="secondary">关联本站渠道：{accountModel?.channels.filter((channel) => channel.monitor.stationIds.includes(resource.id!)).map((channel) => `${channel.name} #${channel.id}`).join("、") || "尚无关联"}</Text></div>
              <div><Text type="secondary">待处理：{accountModel?.actions.filter((action) => action.stationId === resource.id).map((action) => action.label).join("；") || "核验授权和关联"}</Text></div>
              <Space wrap>{accountModel?.actions.filter((action) => action.stationId === resource.id).map((action) => <Button key={action.id} href={action.href}>{action.label}</Button>)}</Space>
            </div>)}{!unverifiedResources.length && accountModel ? <Text type="secondary"> · 当前没有匹配的待核验资源。</Text> : null}</div>
          </Space>
        </ProCard>
      </section>
      <Drawer title={`核验账号与账单能力${verificationStation ? ` · ${verificationStation.name}` : ""}`} open={!!verificationStation} width={compact ? "100%" : 600} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); setVerificationBusy(false); } }} onClose={() => { verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); setVerificationBusy(false); }}>
        {verificationStation ? <Space direction="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
          <Text>原资源 ID：{verificationStation.id} · {verificationStation.type} · {verificationStation.baseUrl}</Text>
          <Alert type="info" showIcon message="只读核验，不保存身份或更改核算范围" description="使用服务端已保存授权读取实际账号、Key 目录与所选 Key 的已结束日统计。实际 Key 统计能力、请求时区和用途覆盖仍需分别核对。" />
          {verificationError ? <Alert type="warning" showIcon message={verificationError} action={<Button onClick={() => window.location.reload()}>刷新处理目标</Button>} /> : null}
          {verificationStation.isOwn || verificationStation.type === "newapi-key" ? <Alert type="warning" showIcon message={verificationStation.isOwn ? "本站资源请核对本站来源与渠道目录" : "纯 Key 保持独立，不能推断所属账号"} description="需要账号权限时，在原资源设置中补充账号授权后重新核验；也可选择真实本站渠道，在接入流程中补专用账单授权。" action={<Space wrap><Button disabled={!types.length} onClick={() => { const original = stations.find((station) => station.id === verificationStation.id); if (!original) return; verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); openModal(original); }}>补充原资源授权</Button><Button href="/stations">选择真实渠道并补账单授权</Button></Space>} /> : <>
            <div><Text strong>请求账单时区</Text><Input aria-label="核验账单时区" value={verificationTimezone} disabled={verificationBusy} onChange={(event) => { verificationEpoch.current += 1; setVerificationTimezone(event.target.value); setVerification(null); setVerificationTokenId(undefined); setVerificationError(""); }} /></div>
            <Button style={{ minHeight: 44 }} loading={verificationBusy} onClick={() => void verifyUpstream(null)}>实际核验账号与 Key 目录</Button>
            {verification ? <>
              <Alert type={verification.identity ? "success" : "warning"} showIcon message={verification.identity ? `本次实际账号已核验：${verification.identity.accountId}` : "实际账号尚未核验"} description={`${verification.identity?.provider || verification.platform} · ${verification.identity?.baseUrl || verificationStation.baseUrl} · 资源版本 ${verification.resourceVersion}。该结果未回填已保存账号关系。`} />
              {verification.capability?.reason === "KEY_METADATA_UNAVAILABLE" ? <Alert type="warning" showIcon message="Key 目录无法读取，请检查目录权限或稍后重试" description="账号身份核验成功；空目录不表示该账号没有 Key，也没有所选 Key 的账单证明。" /> : <><Select aria-label="核验实际 Key" style={{ width: "100%" }} value={verificationTokenId} disabled={verificationBusy} placeholder="从实际目录选择 Key" options={verification.tokens.map((key) => ({ value: key.id, label: `${key.name} · #${key.id} · ${key.group || "无分组"}`, disabled: key.status !== 1 }))} onChange={(tokenId) => { verificationEpoch.current += 1; setVerificationTokenId(tokenId); setVerification((previous) => previous ? { ...previous, probe: null } : null); setVerificationError(""); }} /><Button style={{ minHeight: 44 }} disabled={verificationTokenId == null || verificationBusy} loading={verificationBusy} onClick={() => void verifyUpstream()}>核验所选 Key 账单</Button>{!verification.tokens.length ? <Text type="secondary">当前已读取目录未返回 Key，可重试目录核验。</Text> : null}</>}
              <Text>本次 Key / 日期能力：{(verification.probe?.capability || verification.capability)?.state === "supported" ? "已支持" : (verification.probe?.capability || verification.capability)?.state === "unsupported" ? "不支持" : "待核验"} · {(verification.probe?.capability || verification.capability)?.window} · {(verification.probe?.capability || verification.capability)?.reason || ""}</Text>
              <Text>请求时区能力：{(verification.probe?.billingTimezone || verification.billingTimezone)?.timezone} · {(verification.probe?.billingTimezone || verification.billingTimezone)?.state === "verified" ? "已核验" : "未核验，原金额仅供参考"}</Text>
              {verification.probe ? <Alert type={verification.probe.complete && verification.probe.billingTimezone?.state === "verified" ? "info" : "warning"} showIcon message={verification.platform === "sub2api" ? "所选 Key 扣费参考" : "所选 Key 原统计"} description={<div><div>Key #{verification.probe.tokenId} · {verification.probe.window.startMs == null || verification.probe.window.endMs == null ? "返回窗口未知" : `${new Date(verification.probe.window.startMs).toISOString()} — ${new Date(verification.probe.window.endMs).toISOString()}（${verification.probe.window.timezone || "时区未知"}）`}</div><div>原金额：{verification.probe.amountUsd == null ? "未知" : usd(verification.probe.amountUsd)} · 已获取金额：{verification.probe.knownAmountUsd == null ? "未知" : usd(verification.probe.knownAmountUsd)} · 实际扣费：{verification.probe.actualCostUsd == null ? "未知" : usd(verification.probe.actualCostUsd)}</div><div>原 quota：{verification.probe.quotaUnits ?? "未知"} · quota / USD：{verification.probe.quotaPerUnit ?? "未知"} · {verification.probe.currency}</div><div>{verification.probe.complete ? "本次 Key / 日期统计完整" : "本次 Key / 日期统计不完整"}；请求时区与完整用途范围另行核对，此处不确认利润。</div></div>} /> : null}
            </> : null}
            <Button disabled={!types.length || verificationBusy} onClick={() => { const original = stations.find((station) => station.id === verificationStation.id); if (!original) return; verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); openModal(original); }}>补充原资源授权</Button>
          </>}
        </Space> : null}
      </Drawer>
      <Drawer title={`更新账号授权${authorizationAccount ? ` · ${authorizationAccount.identity.accountId}` : ""}`} open={!!authorizationAccount} width={compact ? "100%" : 600} closable={!authorizationBusy} maskClosable={!authorizationBusy} keyboard={!authorizationBusy} onClose={() => { authorizationEpoch.current += 1; setAuthorizationAccount(null); setAuthorizationProbe(null); authorizationForm.resetFields(); }} extra={<Button type="primary" style={{ minHeight: 44 }} aria-label="确认更新所选授权" loading={authorizationBusy} disabled={!authorizationProbe || !authorizationProbe.targets.length || authorizationResult?.complete || Date.now() >= (authorizationProbe?.expiresAtMs || 0)} onClick={() => void confirmAuthorization()}>确认更新</Button>}>
        {authorizationAccount ? <Space direction="vertical" size={16} style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
          <Text strong>{authorizationAccount.identity.provider} · {authorizationAccount.identity.baseUrl} · 账号 {authorizationAccount.identity.accountId}</Text>
          <Alert type="info" showIcon message="授权只输入一次，明确选择更新目标" description="保留每条原资源 ID、监控用途、提醒、成本设置、关联与历史。本站、纯 Key、其他账号和已归档资源不跟随更新。" />
          {authorizationError ? <Alert type="error" showIcon message={authorizationError} /> : null}
          {previouslyUpdatedIds.length ? <Text type="secondary">已确认更新，本次不再改写：{previouslyUpdatedIds.map(authorizationName).join("、")}</Text> : null}
          {!reuseAuthorization && !authorizationResult?.complete ? <Form form={authorizationForm} layout="vertical" disabled={authorizationBusy} onValuesChange={(changed) => {
            if (changed.type) authorizationForm.setFieldsValue(changed.type === "sub2api-password" ? { accessToken: "" } : { email: "", password: "" });
            authorizationEpoch.current += 1; setAuthorizationProbe(null); setAuthorizationRequestId(crypto.randomUUID()); setAuthorizationError("");
          }}>
            <Form.Item name="type" label="更新授权方式"><Select options={authorizationAccount.identity.provider === "newapi" ? [{ value: "newapi", label: "New API 访问令牌" }] : [{ value: "sub2api", label: "Sub2API 登录令牌" }, { value: "sub2api-password", label: "Sub2API 邮箱与密码" }]} /></Form.Item>
            {authorizationType === "sub2api-password" ? <><Form.Item name="email" label="更新登录邮箱" rules={[{ required: true, message: "请输入邮箱" }]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label="更新登录密码" rules={[{ required: true, message: "请输入密码" }]}><Input.Password autoComplete="off" /></Form.Item></> : <Form.Item name="accessToken" label="更新访问令牌" rules={[{ required: true, message: "请输入令牌" }]}><Input.Password autoComplete="off" /></Form.Item>}
          </Form> : !authorizationResult?.complete ? <Text>复用服务端已保存授权重新核验，无需再次输入凭据。</Text> : null}
          <div><Text strong>明确的更新目标</Text>{[...authorizationEligible(authorizationAccount), ...(accountModel?.unverifiedResources || []).filter((resource) => resource.type !== "newapi-key" && !resource.archivedAt && resource.baseUrl === authorizationAccount.identity.baseUrl && resource.type.startsWith("sub2api") === (authorizationAccount.identity.provider === "sub2api"))].map((resource) => <div key={resource.id}><Checkbox aria-label={`更新目标 ${resource.name}`} checked={authorizationTargets.includes(resource.id!)} disabled={authorizationBusy || authorizationResult?.complete} onChange={(event) => { setAuthorizationTargets(event.target.checked ? [...authorizationTargets, resource.id!] : authorizationTargets.filter((id) => id !== resource.id)); authorizationEpoch.current += 1; setAuthorizationProbe(null); }}><Text>{resource.name} · {resource.id} · {resource.purposes.monitor ? "监控" : "监控未启用"}{resource.verification !== "verified" ? " · 身份待核验，预览后才可加入" : ""}</Text></Checkbox></div>)}</div>
          <Text type="secondary">排除记录：{[...authorizationAccount.resources.filter((resource) => resource.archivedAt).map((resource) => `${resource.name}（已归档）`), ...(accountModel?.accounts || []).filter((account) => account.accountKey !== authorizationAccount.accountKey && account.identity.baseUrl === authorizationAccount.identity.baseUrl).flatMap((account) => account.resources.map((resource) => `${resource.name}（其他账号/平台）`)), ...(accountModel?.unverifiedResources || []).filter((resource) => resource.type === "newapi-key").map((resource) => `${resource.name}（纯 Key）`), ...stations.filter((station) => station.isOwn).map((station) => `${station.name}（本站）`)].join("、") || "无"}</Text>
          {!authorizationResult?.complete ? <Button style={{ minHeight: 44 }} aria-label={reuseAuthorization ? "重新验证并补未完成" : "预览授权更新"} loading={authorizationBusy} onClick={() => void probeAuthorization()}>{reuseAuthorization ? "重新验证并补未完成" : "验证并预览更新"}</Button> : null}
          {authorizationProbe ? <Alert type="info" showIcon message="授权更新预览，尚未保存" description={<Space direction="vertical">{authorizationProbe.targets.map((target) => <Text key={target.stationId}>{authorizationName(target.stationId)} · 授权版本 {target.authVersion} · {target.currentType} → {target.newType} · 监控渠道 {target.monitorChannelIds.join("、") || "无"} · 账单规则 {target.billingRuleIds.join("、") || "无"} · 账单渠道 {target.billingChannelIds.join("、") || "无"}</Text>)}{authorizationProbe.excluded.map((target) => <Text type="warning" key={target.stationId}>排除 {authorizationName(target.stationId)}：{target.reason}</Text>)}<Text>影响监控资源：{authorizationProbe.impact.monitorStationIds.map(authorizationName).join("、") || "无"}</Text><Text>影响账单规则：{authorizationProbe.impact.billingRuleIds.join("、") || "无"}</Text><Text>关联渠道：{authorizationProbe.impact.channels.map((channel) => `${channel.name} #${channel.channelId}（${channel.ownStationId}）`).join("、") || "无"}</Text></Space>} /> : null}
          {authorizationResult ? <Alert type={authorizationResult.complete ? "success" : "warning"} showIcon message={authorizationResult.complete ? "本次所选目标已完成授权更新" : "部分目标尚未更新，已保存目标保留"} description={<Space direction="vertical">{authorizationResult.targets.map((target) => <div key={target.stationId} data-authorization-target={target.stationId}><Text strong>{authorizationName(target.stationId)}：{{ updated: "已更新", already_updated: "已保存，无需重复更新", failed: "更新失败", repreview_required: "需重新预览" }[target.status]}</Text><div><Text>{target.reason}{target.savedAuthVersion != null ? ` · 已保存授权版本 ${target.savedAuthVersion}` : ""}</Text></div></div>)}{authorizationResult.excluded.map((target) => <Text type="warning" key={target.stationId}>排除 {authorizationName(target.stationId)}：{target.reason}</Text>)}{!authorizationResult.complete ? <><Button style={{ minHeight: 44 }} disabled={authorizationBusy} onClick={() => void recoverAuthorization({ accountKey: authorizationResult.accountKey, retryInput: authorizationResult.retryInput })}>只读核对保存结果</Button><Button style={{ minHeight: 44 }} disabled={authorizationBusy} onClick={() => { freshAuthorization(); setAuthorizationError(""); }}>重新输入授权，开始新的更新</Button></> : null}</Space>} /> : null}
        </Space> : null}
      </Drawer>
      <Modal title={purposeTarget?.resource ? `${purposeTarget.monitorEnabled ? "启用" : "暂停"}「${purposeTarget.resource.name}」监控？` : "停止此 Key 的账单核算？"} open={!!purposeTarget} onCancel={() => { if (!purposeBusy) setPurposeTarget(null); }} closable={!purposeBusy} maskClosable={!purposeBusy} keyboard={!purposeBusy} confirmLoading={purposeBusy} onOk={() => void confirmPurpose()} okButtonProps={{ disabled: !!purposeTarget?.key && !purposeTarget.ruleId, "aria-label": "确认用途操作" }} okText="确认操作">
        {purposeError ? <Alert type="error" showIcon message={purposeError} /> : null}
        {purposeTarget?.resource ? <><Text>{purposeTarget.monitorEnabled ? "启用该资源的监控与监控估算，保持现有成本设置" : "仅停止该资源的监控估算"}；Key 账单核算继续，原资源 ID、设置与历史保留。</Text><div>现有成本设置：{purposeTarget.resource.includeInProfit ? "纳入" : "不纳入"}</div><div>关联监控渠道：{accountModel?.channels.filter((channel) => channel.monitor.stationIds.includes(purposeTarget.resource!.id!)).map((channel) => `${channel.name} #${channel.id}`).join("、") || "无"}</div><div>继续保留账单关系：{purposeTarget.resource.purposes.billingRuleIds.join("、") || "无"}</div></> : purposeTarget?.key ? <><Text>停止所选账单规则，释放它的当前归属范围并保留历史；其他监控资源继续运行。</Text>{purposeTarget.key.activeRuleIds.length > 1 ? <Select aria-label="要停止的核算规则" style={{ width: "100%", marginBlock: 12 }} value={purposeTarget.ruleId} options={purposeTarget.key.activeRuleIds.map((id) => ({ value: id, label: id }))} onChange={(ruleId) => setPurposeTarget({ ...purposeTarget, ruleId })} /> : null}<div>所选规则：{purposeTarget.ruleId || "请选择"}</div><div>Key 关联范围（含历史）：{purposeTarget.key.channels.map((channel) => `${channel.name} #${channel.channelId}（${channel.ownStationId}）`).join("、")}</div>{purposeTarget.key.activeRuleIds.length > 1 ? <Text type="warning">其它有效规则继续保留；本次只停止明确选择的一条。</Text> : null}</> : null}
      </Modal>
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
        {monitoredStations.length ? (
          <div>
            {monitoredStations.map((s) => (
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
                onArchive={(station) => setArchiveTarget(station)}
                onPurge={(station) => {
                  setPurgeTarget(station);
                  setPurgeConfirm("");
                }}
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

      <Modal
        className="responsive-modal"
        title={archiveTarget ? `归档「${archiveTarget.name}」？` : "归档资源"}
        open={!!archiveTarget}
        onCancel={() => setArchiveTarget(null)}
        onOk={onArchive}
        okText="归档资源"
        cancelText="取消"
        confirmLoading={archiving}
        width={480}
      >
        <Alert
          type="info"
          showIcon
          message="归档会停止刷新与告警，但不会删除监测历史。"
          description="归档后的资源默认不出现在实时总览，历史成本仍可用于长期分析。"
        />
        <Button
          type="link"
          danger
          style={{ paddingInline: 0, marginTop: 12 }}
          onClick={() => {
            setPurgeTarget(archiveTarget);
            setPurgeConfirm("");
            setArchiveTarget(null);
          }}
        >
          改为彻底删除资源及其监测历史…
        </Button>
      </Modal>

      <Modal
        className="responsive-modal"
        title={purgeTarget ? `彻底删除「${purgeTarget.name}」？` : "彻底删除资源"}
        open={!!purgeTarget}
        onCancel={() => { setPurgeTarget(null); setPurgeConfirm(""); }}
        onOk={onPurge}
        okText="永久删除"
        cancelText="取消"
        confirmLoading={purging}
        okButtonProps={{ danger: true, disabled: purgeConfirm !== "DELETE" }}
        width={480}
      >
        <Alert
          type="error"
          showIcon
          message="此操作不可恢复"
          description="资源配置、原始监测快照与用于长期分析的历史都会被永久删除。"
        />
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>请输入 <Text code>DELETE</Text> 以确认：</div>
          <Input
            autoFocus
            aria-label="输入 DELETE 确认彻底删除资源"
            value={purgeConfirm}
            onChange={(event) => setPurgeConfirm(event.target.value)}
            placeholder="DELETE"
          />
        </div>
      </Modal>

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
