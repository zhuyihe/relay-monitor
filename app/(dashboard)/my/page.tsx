"use client";
// 我的站点页：自有中转站的下游用量分析 + 利润分析 + 消费预测
// 对照 v1 app.js renderOwn/renderOwnBody/drawHourlyChart/renderResoldManager/drawOwnUsers/drawForecast，
// 功能与文案逐条平移；图表改用 @ant-design/plots，布局用 ProCard 重排
import { useEffect, useRef, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Grid,
  Input,
  Result,
  Row,
  Segmented,
  Statistic,
  Table,
  Tag,
  Typography,
  theme,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Bar, Column, Line } from "@ant-design/plots";
import ChartBox from "../chart-box";
import LastRefreshed from "../last-refreshed";
import { api, cny, cny4, fmtTokens, rateOf } from "../../../lib/client";
import { useThemeMode } from "../../providers";

const { Text, Title } = Typography;

// 范围选项与 v1 OWN_RANGES 一致（默认看今天）
const OWN_RANGES = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

// 日志精算的扫描条数档位（new-api 每页上限 100 条，条数越大请求越多越慢）
const AUDIT_ROWS = [
  { value: 2000, label: "2 千条" },
  { value: 4000, label: "4 千条" },
  { value: 10000, label: "1 万条" },
  { value: 20000, label: "2 万条" },
];

// 成本口径标签（同 v1 MODE_LABEL）
const MODE_LABEL: Record<string, string> = { usage: "按用量", fixed: "固定摊销", history: "余额推算 ≈" };
// 角色标签（同 v1 renderResoldManager 的 ROLE）
const ROLE_LABEL: Record<number, string> = { 10: "管理员", 100: "root" };

const num = (n: any) => Number(n ?? 0).toLocaleString("en-US");
// 有效单价：¥ / 百万「计费 token」。看板的 token 只有 prompt+completion，不含缓存读写，
// 倍率也不体现，所以这一列高得离谱的行通常是缓存写入 / 长上下文 / 高倍率在计价
const perM = (costCny: number, tokens: number) =>
  tokens > 0 ? `¥${(costCny / (tokens / 1e6)).toFixed(3)}` : "—";
const TOKEN_NOTE = "看板口径：prompt + completion，不含缓存读写（缓存与倍率见「日志精算」）";
const hourLabel = (t: any) => `${String(new Date(Number(t)).getHours()).padStart(2, "0")}:00`;
const fmtDay = (v: any) => {
  const dd = new Date(v);
  return `${dd.getMonth() + 1}/${dd.getDate()}`;
};
// y 轴金额刻度：≥100 取整（同 v1 各图 "¥" 轴标签）
const yuanTick = (v: any) => `¥${Number(v) >= 100 ? Math.round(Number(v)) : Number(v)}`;
// 图表长名截断（v1 truncateLabel 的简化版）
const trunc = (s: any, n: number) => {
  const a = [...String(s ?? "")];
  return a.length > n ? a.slice(0, n - 1).join("") + "…" : String(s ?? "");
};

// 超过 10 项时聚合为「其他 N 个」（同 v1 drawUsageModels / drawOwnUsers）
function top10<T extends Record<string, any>>(list: T[], nameField: string): T[] {
  if (list.length <= 10) return list;
  const rest = list.slice(9);
  return [
    ...list.slice(0, 9),
    {
      [nameField]: `其他 ${rest.length} 个`,
      tokens: rest.reduce((a, x) => a + (x.tokens || 0), 0),
      cost: rest.reduce((a, x) => a + (x.cost || 0), 0),
      requests: rest.reduce((a, x) => a + (x.requests || 0), 0),
    } as any,
  ];
}

// 区块标题行（v1 .section-head：标题 + 灰色说明 + 右侧按钮）
// 标题不收缩不换行，窄屏下说明文字整体折到下一行而不是把标题挤成竖排
function SectionHead({ title, sub, extra }: { title: string; sub?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="section-head" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, margin: "20px 0 12px" }}>
      <Title level={5} style={{ margin: 0, whiteSpace: "nowrap", flexShrink: 0 }}>{title}</Title>
      {sub ? <Text type="secondary" style={{ fontSize: 12, minWidth: 0 }}>{sub}</Text> : null}
      {extra ? <span style={{ marginLeft: "auto" }}>{extra}</span> : null}
    </div>
  );
}

// 环比：与上一等长窗口对比。上窗为 0 记「新增」；涨跌 50% 以上标黄，方便一眼扫到跳变
function Delta({ pct, isNew }: { pct: number | null | undefined; isNew?: boolean }) {
  const { token } = theme.useToken();
  if (isNew) return <Tag color="orange">新增</Tag>;
  if (pct == null) return <Text type="secondary">—</Text>;
  const big = Math.abs(pct) >= 50;
  return (
    <Text style={{ color: big ? token.colorWarningText : undefined, fontWeight: big ? 600 : undefined }}>
      {pct >= 0 ? "↑" : "↓"}
      {Math.abs(pct)}%
    </Text>
  );
}

// 图表本体统一固定高度，同排两图高度一致（全站规范）
const CHART_H = 300;

// 图表卡统一两行头（全站规范）：标题一行，副标题换行放标题下方，允许自动换行
function ChartHead({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {sub ? (
        <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", whiteSpace: "normal", wordBreak: "break-word" }}>
          {sub}
        </Text>
      ) : null}
    </div>
  );
}

// KPI 统计卡（全站规范 2）：每张卡都渲染副行占位，避免有无副行导致同排高低不齐；卡片撑满列高
function KpiCard({ sub, children }: { sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <ProCard style={{ height: "100%" }}>
      {children}
      <div style={{ minHeight: 20 }}>{sub || null}</div>
    </ProCard>
  );
}

// 名称/说明在左、金额在右的一行（v1 .st-row.profit-row）
function ProfitRow({ name, meta, amt, sub }: { name: React.ReactNode; meta?: React.ReactNode; amt?: React.ReactNode; sub?: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{name}</div>
        {meta ? <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{meta}</div> : null}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {amt ? <div style={{ fontWeight: 600 }}>{amt}</div> : null}
        {sub ? <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{sub}</div> : null}
      </div>
    </div>
  );
}

// 图表空态占位（v1 .chart-empty）
function ChartEmpty({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div style={{ height: CHART_H, display: "flex", alignItems: "center", justifyContent: "center", color: token.colorTextTertiary, fontSize: 13 }}>
      {text}
    </div>
  );
}

// 转售管理器里的账号 Key 数据形状（GET /api/own/admin-keys 的 accounts）
type AdminToken = { name: string; status?: number; usedUsd: number | null; flagged: boolean };
type AdminAccount = { username: string; role: number; enumerable: boolean; error?: string; tokens: AdminToken[] };

export default function MyStationPage() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const { dark } = useThemeMode();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  // @ant-design/plots 不随 ConfigProvider 算法切换，需显式指定主题
  const plotTheme = dark ? "classicDark" : "classic";
  const [range, setRange] = useState<string>("today");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  // 日志精算状态（开销大，只在用户点按钮时才翻日志）
  const [audit, setAudit] = useState<any>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState(4000);

  // 转售 Key 管理器状态
  const [mgrOpen, setMgrOpen] = useState(false);
  const [mgrLoading, setMgrLoading] = useState(false);
  const [mgrError, setMgrError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // 客户端缓存：同范围 60 秒内直接复用（同 v1 loadOwn 的 cached 判断）
  const cacheRef = useRef<Record<string, { at: number; data: any }>>({});
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = async (force: boolean, r: string = rangeRef.current) => {
    const cached = cacheRef.current[r];
    if (!force && cached && Date.now() - cached.at < 60000) {
      setData(cached.data);
      setError(null);
      setRefreshedAt(cached.at);
      return;
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await api(`/api/own/analytics?range=${r}&tz=${encodeURIComponent(tz)}`);
      cacheRef.current[r] = { at: Date.now(), data: res };
      // 响应回来时范围已切走则丢弃（同 v1 state.ownRange === range 判断）
      if (rangeRef.current !== r) return;
      setData(res);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (e: any) {
      if (rangeRef.current !== r) return;
      setError(e.message || String(e));
    }
  };

  // 范围变化立即拉取；自动刷新约 30 秒一次（对照 v1 的自动刷新节奏），切回标签页立即刷一次
  useEffect(() => {
    load(false, range);
    const timer = setInterval(() => load(true), 30000);
    const onVis = () => {
      if (!document.hidden) load(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  const runAudit = async () => {
    setAuditing(true);
    setAuditError(null);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await api(
        `/api/own/audit?range=${rangeRef.current}&tz=${encodeURIComponent(tz)}&maxRows=${auditRows}`
      );
      setAudit(r);
    } catch (e: any) {
      setAuditError(e.message || String(e));
      setAudit(null);
    } finally {
      setAuditing(false);
    }
  };

  // 范围一换，上一次的精算结果就不是这个窗口的了
  useEffect(() => {
    setAudit(null);
    setAuditError(null);
  }, [range]);

  // ---- 转售 Key 管理器（v1 #manageResold / renderResoldManager / #resoldSave）----
  const toggleManager = async () => {
    if (mgrOpen) {
      setMgrOpen(false);
      setAccounts(null);
      setMgrError(null);
      return;
    }
    setMgrOpen(true);
    setMgrLoading(true);
    setMgrError(null);
    try {
      const r = await api("/api/own/admin-keys");
      setAccounts(r.accounts);
    } catch (e: any) {
      setMgrError(e.message || String(e));
    } finally {
      setMgrLoading(false);
    }
  };

  const toggleKey = (username: string, tokenName: string, checked: boolean) => {
    setAccounts((prev) =>
      (prev || []).map((a) =>
        a.username !== username
          ? a
          : { ...a, tokens: a.tokens.map((t) => (t.name === tokenName ? { ...t, flagged: checked } : t)) }
      )
    );
  };

  // 不可枚举账号手动补 Key 名（同 v1 [data-resold-add]，重名不重复添加）
  const addManualKey = (username: string) => {
    const name = (addInputs[username] || "").trim();
    if (!name) return;
    setAccounts((prev) =>
      (prev || []).map((a) => {
        if (a.username !== username) return a;
        if (a.tokens.some((t) => t.name === name)) return a;
        return { ...a, tokens: [...a.tokens, { name, flagged: true, usedUsd: null }] };
      })
    );
    setAddInputs((m) => ({ ...m, [username]: "" }));
  };

  const saveResold = async () => {
    const keys = (accounts || []).flatMap((a) =>
      a.tokens.filter((t) => t.flagged).map((t) => ({ username: a.username, tokenName: t.name }))
    );
    setSaving(true);
    try {
      await api("/api/own/admin-keys", { method: "PUT", body: { keys } });
      message.success(`已保存 ${keys.length} 个转售 Key，正在重算利润…`);
      setMgrOpen(false);
      setAccounts(null);
      await load(true);
    } catch (e: any) {
      message.error(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- 页面头部：范围切换 + 手动刷新（v1 #ownRange / #ownRefresh）----
  const headerExtra = (
    <div className="page-toolbar">
      <LastRefreshed at={refreshedAt} />
      <div className="mobile-scroll">
        <Segmented options={OWN_RANGES} value={range} onChange={(v) => setRange(String(v))} />
      </div>
      <Button className="touch-icon-button" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
        刷新
      </Button>
    </div>
  );

  if (error) {
    return (
      <PageContainer className="responsive-page" title="我的站点" subTitle="自有中转站的下游用量分析与消费预测" extra={headerExtra}>
        <Result status="warning" title="无法加载下游数据" subTitle={error} />
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer className="responsive-page" title="我的站点" subTitle="自有中转站的下游用量分析与消费预测" extra={headerExtra}>
        {/* 初次加载统一 ProCard 骨架屏（全站规范 3），形状对齐真实布局：4 KPI + 两图 */}
        <Row gutter={[12, 12]}>
          {[0, 1, 2, 3].map((i) => (
            <Col key={i} xs={12} md={6}>
              <ProCard loading style={{ height: "100%" }} />
            </Col>
          ))}
        </Row>
        <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
          <Col xs={24} lg={14}>
            <ProCard loading style={{ height: "100%", minHeight: CHART_H }} />
          </Col>
          <Col xs={24} lg={10}>
            <ProCard loading style={{ height: "100%", minHeight: CHART_H }} />
          </Col>
        </Row>
      </PageContainer>
    );
  }

  // ---- 数据整形（严格对照 v1 renderOwnBody 的口径：全部金额 × 售价汇率）----
  const d = data;
  const rate = rateOf(d.station);
  const totCost = d.byModel.reduce((a: number, m: any) => a + m.cost, 0) * rate;
  const totTokens = d.byModel.reduce((a: number, m: any) => a + m.tokens, 0);
  const totReqs = d.byModel.reduce((a: number, m: any) => a + m.requests, 0);
  const hourly = d.range === "today";

  const buckets = d.trend.map((p: any) => {
    const dt = new Date(p.t);
    return {
      ...p,
      cost: p.cost * rate,
      label: hourly ? `${String(dt.getHours()).padStart(2, "0")}:00` : `${dt.getMonth() + 1}/${dt.getDate()}`,
    };
  });
  const models = d.byModel.map((m: any) => ({ ...m, cost: m.cost * rate }));
  const users = d.byUser.map((u: any) => ({ ...u, cost: u.cost * rate }));

  const fc = d.forecast;
  const fcLo = fc ? (fc.nextLo ?? fc.points.reduce((a: number, p: any) => a + p.lo, 0)) : 0;
  const fcHi = fc ? (fc.nextHi ?? fc.points.reduce((a: number, p: any) => a + p.hi, 0)) : 0;
  const fcSub = fc
    ? `未来 7 天预计 ${cny(fc.nextTotal * rate)}（区间 ${cny(fcLo * rate)} ~ ${cny(fcHi * rate)}）· ${fc.method} · 基于 ${fc.sampleDays} 天${
        fc.backtestWapePct != null ? ` · 近 2 周回测日均偏差 ±${fc.backtestWapePct}%` : ""
      }`
    : "历史数据不足 3 天，暂无法预测";

  // 未来 24 小时：过去实际 + 预测（同 v1 drawHourlyChart 的输入）
  const hourlyAll = d.hourly
    ? [
        ...d.hourly.past.map((p: any) => ({ t: p.t, cost: p.cost * rate, kind: "实际" })),
        ...d.hourly.next.map((p: any) => ({ t: p.t, cost: p.cost * rate, lo: p.lo * rate, hi: p.hi * rate, kind: "预测" })),
      ]
    : [];

  // 日消费历史 + 预测：预测线从最后一个历史点接出（同 v1 drawForecast）
  const dailyHist = d.daily.map((x: any) => ({ t: x.t, cost: x.cost * rate }));
  const fcPts = fc ? fc.points.map((p: any) => ({ t: p.t, cost: p.cost * rate, lo: p.lo * rate, hi: p.hi * rate })) : [];
  const lastHist = dailyHist[dailyHist.length - 1];
  const fcLineData = fc ? [...(lastHist ? [{ t: lastHist.t, cost: lastHist.cost }] : []), ...fcPts] : [];
  const forecastLineData = [
    ...dailyHist.map((p: any) => ({ ...p, kind: "历史日消费" })),
    ...fcLineData.map((p: any) => ({ ...p, kind: "预测" })),
  ].map((p: any) => ({ ...p, date: new Date(p.t) }));
  const bandData = fc
    ? [...(lastHist ? [{ t: lastHist.t, lo: lastHist.cost, hi: lastHist.cost }] : []), ...fcPts].map((p: any) => ({
        ...p,
        date: new Date(p.t),
      }))
    : [];

  const p = d.profit;
  const profitColor = p && !p.error ? (p.profitCny >= 0 ? "#3f8600" : "#cf1322") : undefined;
  const incomeSub = p && !p.error
    ? [
        (p.resoldCny || 0) > 0 ? `含转售管理员 Key ${cny(p.resoldCny)}` : "",
        p.adminUsageCny > 0 ? `管理员自用 ${cny(p.adminUsageCny)}（计成本不计收入）` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // 用户余额（不含管理员/root）：非零余额排序展示，零余额只报数量
  const balances = d.userBalances as any[] | null;
  const nonZeroBal = balances ? balances.filter((u) => u.balanceUsd > 0.0001) : [];
  const zeroBalCount = balances ? balances.length - nonZeroBal.length : 0;
  const totalBalCny = balances ? balances.reduce((a, u) => a + u.balanceUsd, 0) * rate : 0;

  const pctCol = (cost: number) => (totCost > 0 ? ((cost / totCost) * 100).toFixed(1) + "%" : "—");
  // 消费占比远高于 token 占比的行：钱花在缓存写入 / 长上下文 / 高倍率上，
  // 看它的 token 栏会得出完全错误的结论，所以显式标出来
  const cacheHeavy = (r: any) => {
    if (!(totCost > 0) || !(totTokens > 0)) return false;
    const cs = (r.cost || 0) / totCost;
    const ts = (r.tokens || 0) / totTokens;
    return cs > 0.02 && (ts === 0 || cs / ts >= 3);
  };
  const heavyTag = (r: any) =>
    cacheHeavy(r) ? (
      <Tag color="gold" style={{ marginLeft: 6 }} title="消费占比远高于 token 占比：缓存写入 / 长上下文 / 高倍率计价">
        倍率/缓存计价
      </Tag>
    ) : null;
  const prevLabel = d.prevWindow
    ? `上一等长窗口（${new Date(d.prevWindow.startMs).toLocaleString("zh-CN", { hour12: false })} 起 ${d.prevWindow.spanDays} 天窗）`
    : "上一等长窗口";
  const flow = d.flow;
  const flowRows = (list: any[]) => (list || []).map((r: any) => ({ ...r, cost: r.cost * rate, prevCost: r.prevCost * rate }));

  // byModel 按消费(cost)降序（v1 口径，模型明细表沿用）；本图纵轴是 tokens，
  // 必须按 tokens 重排——否则巨量 token 的便宜模型排在中间、长尾全是隐形细条，
  // top10 折叠也会按错误顺序吞掉高 token 模型
  const modelItems = top10([...models].sort((a, b) => (b.tokens || 0) - (a.tokens || 0)), "model");
  const userItems = top10(users, "user");

  return (
    <PageContainer className="responsive-page" title="我的站点" subTitle="自有中转站的下游用量分析与消费预测" extra={headerExtra}>
      {/* KPI：期内消费 / Tokens / 请求数 / 活跃用户 */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <KpiCard><Statistic title="期内消费" value={cny4(totCost)} /></KpiCard>
        </Col>
        <Col xs={12} md={6}>
          <KpiCard sub={<Text type="secondary" style={{ fontSize: 12 }}>不含缓存读写</Text>}>
            <Statistic
              title="计费 Token"
              value={fmtTokens(totTokens)}
              valueRender={(node) => <span title={`${num(totTokens)} · ${TOKEN_NOTE}`}>{node}</span>}
            />
          </KpiCard>
        </Col>
        <Col xs={12} md={6}>
          <KpiCard><Statistic title="请求数" value={num(totReqs)} /></KpiCard>
        </Col>
        <Col xs={12} md={6}>
          <KpiCard><Statistic title="活跃用户" value={users.length} suffix="个" /></KpiCard>
        </Col>
      </Row>

      {/* ---- 利润分析（v1 profitSection）---- */}
      {p && p.error ? (
        <Alert style={{ marginTop: 14 }} type="warning" showIcon message={`利润分析不可用：${p.error}`} />
      ) : null}
      {p && !p.error ? (
        <>
          {p.warnings?.length ? (
            <Alert
              style={{ marginTop: 14 }}
              type={p.complete ? "info" : "warning"}
              showIcon
              message={!p.complete ? "利润数据尚不完整" : p.estimated ? "成本中包含估算值" : "利润口径提示"}
              description={p.warnings.join("；")}
            />
          ) : null}
          <SectionHead
            title="利润分析"
            sub={`收入 = 普通用户消费 × 售价汇率（不含管理员/root，除非该 Key 已标为转售）· 成本按各上游口径（窗口 ${p.windowDays} 天）`}
          />
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}>
              <KpiCard sub={incomeSub ? <Text type="secondary" style={{ fontSize: 12 }}>{incomeSub}</Text> : null}>
                <Statistic title="期内收入" value={cny(p.incomeCny)} />
              </KpiCard>
            </Col>
            <Col xs={12} md={6}>
              <KpiCard><Statistic title="期内成本" value={cny(p.totalCostCny)} /></KpiCard>
            </Col>
            <Col xs={12} md={6}>
              <KpiCard><Statistic title="利润" value={cny(p.profitCny)} valueStyle={{ color: profitColor }} /></KpiCard>
            </Col>
            <Col xs={12} md={6}>
              <KpiCard>
                <Statistic title="利润率" value={p.marginPct != null ? p.marginPct + "%" : "—"} valueStyle={{ color: profitColor }} />
              </KpiCard>
            </Col>
          </Row>

          {/* 管理员转售 Key（v1 resoldSection + renderResoldManager） */}
          <SectionHead
            title="管理员转售 Key"
            extra={<Button onClick={toggleManager}>{mgrOpen ? "收起" : "管理转售 Key"}</Button>}
          />
          {(p.resoldKeys || []).length ? (
            <ProCard>
              {p.resoldKeys.map((k: any) => (
                <ProfitRow
                  key={`${k.username}/${k.tokenName}`}
                  name={
                    <>
                      <Text code>{k.username} / {k.tokenName}</Text>
                      {k.error ? <Tag color="warning" style={{ marginLeft: 6 }}>查询失败</Tag> : null}
                    </>
                  }
                  meta={k.error ? k.error : "转售给下游 · 计入收入"}
                  amt={cny(k.cny || 0)}
                  sub="期内收入"
                />
              ))}
            </ProCard>
          ) : (
            <Alert
              type="info"
              showIcon
              message="还没有标记转售 Key。若某个管理员/root 账号的 API Key 实际给了下游，点「管理转售 Key」勾选它，其消费即计入收入。"
            />
          )}
          {mgrOpen ? (
            <ProCard style={{ marginTop: 12 }}>
              {mgrLoading ? (
                <div style={{ padding: 20, textAlign: "center", color: token.colorTextSecondary }}>正在拉取管理员账号的 Key…</div>
              ) : mgrError ? (
                <Alert type="warning" showIcon message={`拉取失败：${mgrError}`} />
              ) : !accounts || !accounts.length ? (
                <Alert type="warning" showIcon message="没有找到管理员/root 账号（role ≥ 10）。" />
              ) : (
                <>
                  <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 10 }}>
                    勾选实际转售给下游的 Key，其期内消费将从「管理员自用（成本）」改计入「收入 × 售价汇率」。Key
                    名可能跨账号重名，故按「账号 + Key 名」定位。
                  </Text>
                  {accounts.map((a) => (
                    <div key={a.username} style={{ marginBottom: 14 }}>
                      <div style={{ marginBottom: 8, fontWeight: 500 }}>
                        {a.username} <Tag>{ROLE_LABEL[a.role] || `role ${a.role}`}</Tag>
                      </div>
                      {a.enumerable ? (
                        a.tokens.length ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {a.tokens.map((t) => (
                              <Checkbox
                                key={t.name}
                                checked={t.flagged}
                                onChange={(e) => toggleKey(a.username, t.name, e.target.checked)}
                              >
                                {t.name || "（未命名）"}
                                {t.usedUsd != null ? (
                                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                                    累计用 {cny(t.usedUsd * rate)}
                                  </Text>
                                ) : null}
                              </Checkbox>
                            ))}
                          </div>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12 }}>该账号没有 API Key</Text>
                        )
                      ) : (
                        <>
                          <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                            此账号无法自动列出 Key（{a.error || "接口限制"}）。若它有转售 Key，请手动填 Key 名：
                          </Text>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                            {a.tokens.map((t) => (
                              <Checkbox
                                key={t.name}
                                checked={t.flagged}
                                onChange={(e) => toggleKey(a.username, t.name, e.target.checked)}
                              >
                                {t.name || "（未命名）"}
                              </Checkbox>
                            ))}
                          </div>
                          <div style={{ display: "flex", gap: 8, maxWidth: 360 }}>
                            <Input
                              size="small"
                              placeholder="Key 名（token_name）"
                              value={addInputs[a.username] || ""}
                              onChange={(e) => setAddInputs((m) => ({ ...m, [a.username]: e.target.value }))}
                              onPressEnter={() => addManualKey(a.username)}
                            />
                            <Button size="small" icon={<PlusOutlined />} onClick={() => addManualKey(a.username)}>
                              添加
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  <Button type="primary" loading={saving} onClick={saveResold}>
                    保存并重算
                  </Button>
                </>
              )}
            </ProCard>
          ) : null}

          {/* 成本明细：所有启用计入成本的监控上游，不依赖渠道 URL 是否匹配 */}
          {p.costs.length ? (
            <>
              <SectionHead title="成本明细" sub={`共 ${p.costs.length} 个纳入成本的上游 · 按各上游口径计入期内成本`} />
              <ProCard>
                {p.costs.map((c: any) => (
                  <ProfitRow
                    key={c.name}
                    name={
                      <>
                        {c.name} <Tag>{MODE_LABEL[c.mode] || c.mode}</Tag>
                        {c.note ? <Tag color={c.mode === "history" || c.note === "已到期" ? "warning" : undefined}>{c.note}</Tag> : null}
                      </>
                    }
                    meta={`渠道：${c.channels.join("、")}`}
                    amt={cny(c.cny)}
                    sub="期内成本"
                  />
                ))}
              </ProCard>
            </>
          ) : (
            <Alert
              style={{ marginTop: 14 }}
              type="warning"
              showIcon
              message="没有启用计入利润成本的上游，成本暂计 ¥0"
            />
          )}

          {/* 未直接关联监控站的渠道，仅用于检查是否还有未监控成本 */}
          {p.unmatched.length ? (
            <>
              <SectionHead
                title="未直接关联监控站的渠道"
                sub={`共 ${p.unmatched.length} 个渠道地址（按 URL 合并）· 监控列表中的上游成本已独立计入，此处仅用于检查是否还有未添加的外部上游`}
              />
              <ProCard>
                {p.unmatched.map((u: any) => (
                  <ProfitRow key={u.label} name={u.label} meta={u.names.join("、")} sub={`${u.enabled}/${u.total} 个渠道启用`} />
                ))}
              </ProCard>
            </>
          ) : null}
          <SectionHead title="用量分析" />
        </>
      ) : null}

      {/* ---- 用量趋势 + 分模型 Token ---- */}
      <Row gutter={[12, 12]} style={{ marginTop: p && !p.error ? 0 : 14 }}>
        <Col xs={24} lg={14}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="用量趋势" sub={`${hourly ? "按小时" : "按天"}汇总（tokens）`} />}>
            {!buckets.length || buckets.every((b: any) => !b.tokens) ? (
              <ChartEmpty text="该范围内暂无用量数据" />
            ) : (
              <ChartBox h={CHART_H}>
              <Column
                theme={plotTheme}
                height={CHART_H}
                data={buckets}
                xField="label"
                yField="tokens"
                axis={{
                  x: { labelFormatter: (v: any) => (isMobile ? trunc(v, 8) : v) },
                  y: { labelFormatter: (v: any) => fmtTokens(v) },
                }}
                tooltip={{
                  title: (b: any) => b.label,
                  items: [
                    (b: any) => ({ name: "Tokens", value: num(b.tokens) }),
                    (b: any) => ({ name: "消耗", value: cny4(b.cost) }),
                    (b: any) => ({ name: "请求", value: num(b.requests) }),
                  ],
                }}
              />
              </ChartBox>
            )}
          </ProCard>
        </Col>
        <Col xs={24} lg={10}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="分模型 Token" sub="按用量降序，最多 10 项" />}>
            {!modelItems.length ? (
              <ChartEmpty text="该范围内暂无用量数据" />
            ) : (
              <ChartBox h={CHART_H}>
              <Bar
                theme={plotTheme}
                height={CHART_H}
                data={modelItems}
                xField="model"
                yField="tokens"
                axis={{ x: { labelFormatter: (v: any) => trunc(v, isMobile ? 12 : 20) }, y: { labelFormatter: (v: any) => fmtTokens(v) } }}
                label={isMobile ? false : { text: (m: any) => fmtTokens(m.tokens), position: "right", dx: 4 }}
                tooltip={{
                  title: (m: any) => m.model,
                  items: [
                    (m: any) => ({ name: "Tokens", value: num(m.tokens) }),
                    (m: any) => ({ name: "消耗", value: cny4(m.cost) }),
                    (m: any) => ({ name: "请求", value: num(m.requests) }),
                  ],
                }}
              />
              </ChartBox>
            )}
          </ProCard>
        </Col>
      </Row>

      {/* ---- 未来 24 小时预测（仅今天范围有 hourly）---- */}
      {d.hourly ? (
        <ProCard
          style={{ marginTop: 12 }}
          title={
            <ChartHead
              title="未来 24 小时预测"
              sub={`今天已消费 ${cny(d.hourly.todaySoFar * rate)} · 全天预计 ≈${cny(d.hourly.todayEst * rate)} · 未来 24h 合计 ≈${cny(
                d.hourly.next24Total * rate
              )}${d.hourly.backtestWapePct != null ? ` · 24h 总量回测偏差 ±${d.hourly.backtestWapePct}%` : ""}`}
            />
          }
        >
          {hourlyAll.length < 4 ? (
            <ChartEmpty text="小时数据不足" />
          ) : (
            <ChartBox h={CHART_H}>
            <Column
              theme={plotTheme}
              height={CHART_H}
              data={hourlyAll}
              xField="t"
              yField="cost"
              colorField="kind"
              scale={{ color: { domain: ["实际", "预测"], range: ["#1677ff", "rgba(22,119,255,0.35)"] } }}
              axis={{
                x: {
                  labelFormatter: (v: any) => (!isMobile || new Date(Number(v)).getHours() % 4 === 0 ? hourLabel(v) : ""),
                },
                y: { labelFormatter: yuanTick },
              }}
              annotations={
                d.hourly.next.length
                  ? [{ type: "lineX", data: [d.hourly.next[0].t], style: { stroke: token.colorTextTertiary, lineDash: [4, 4] } }]
                  : []
              }
              tooltip={{
                title: (x: any) => `${hourLabel(x.t)}（${x.kind}）`,
                items: [
                  (x: any) => ({ name: "消费", value: cny4(x.cost) }),
                  (x: any) => ({ name: "区间", value: x.kind === "预测" ? `${cny(x.lo)} ~ ${cny(x.hi)}` : "—" }),
                ],
              }}
            />
            </ChartBox>
          )}
        </ProCard>
      ) : null}

      {/* ---- 消费预测 + 分用户消费 ---- */}
      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} lg={14}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="消费预测" sub={fcSub} />}>
            {!dailyHist.length && !fcPts.length ? (
              <ChartEmpty text="历史数据不足，暂无法预测" />
            ) : (
              <>
                <ChartBox h={CHART_H}>
                <Line
                  theme={plotTheme}
                  height={CHART_H}
                  data={forecastLineData}
                  xField="date"
                  yField="cost"
                  colorField="kind"
                  legend={false}
                  scale={{ color: { domain: ["历史日消费", "预测"], range: ["#1677ff", "#1677ff"] } }}
                  style={{
                    lineWidth: 2,
                    lineDash: (items: any) => {
                      const one = Array.isArray(items) ? items[0] : items;
                      return one?.kind === "预测" ? [5, 4] : null;
                    },
                  }}
                  axis={{ x: { labelFormatter: (v: any) => fmtDay(v) }, y: { labelFormatter: yuanTick } }}
                  annotations={
                    bandData.length
                      ? [
                          {
                            type: "area",
                            data: bandData,
                            encode: { x: "date", y: "lo", y1: "hi" },
                            style: { fill: "#1677ff", fillOpacity: 0.12 },
                            tooltip: false,
                          },
                        ]
                      : []
                  }
                  tooltip={{
                    title: (x: any) => `${fmtDay(x.date)}${x.kind === "预测" ? "（预测）" : ""}`,
                    items: [
                      (x: any) => ({ name: "消费", value: cny(x.cost) }),
                      (x: any) => ({ name: "区间", value: x.kind === "预测" && x.lo != null ? `${cny(x.lo)} ~ ${cny(x.hi)}` : "—" }),
                    ],
                  }}
                />
                </ChartBox>
                {/* 图例（对照 v1 .fc-legend） */}
                <div style={{ display: "flex", flexWrap: "wrap", minWidth: 0, gap: 16, marginTop: 8, fontSize: 12, color: token.colorTextSecondary }}>
                  <span><span style={{ display: "inline-block", width: 18, borderTop: "2px solid #1677ff", verticalAlign: "middle", marginRight: 4 }} />历史日消费</span>
                  <span><span style={{ display: "inline-block", width: 18, borderTop: "2px dashed #1677ff", verticalAlign: "middle", marginRight: 4 }} />预测</span>
                  <span><span style={{ display: "inline-block", width: 18, height: 10, background: "rgba(22,119,255,0.12)", verticalAlign: "middle", marginRight: 4 }} />80% 置信区间</span>
                </div>
              </>
            )}
          </ProCard>
        </Col>
        <Col xs={24} lg={10}>
          <ProCard style={{ height: "100%" }} title={<ChartHead title="分用户消费" sub="期内消费降序，最多 10 项（¥）" />}>
            {!userItems.length ? (
              <ChartEmpty text="该范围内暂无数据" />
            ) : (
              <ChartBox h={CHART_H}>
              <Bar
                theme={plotTheme}
                height={CHART_H}
                data={userItems}
                xField="user"
                yField="cost"
                axis={{ x: { labelFormatter: (v: any) => trunc(v, isMobile ? 10 : 14) }, y: { labelFormatter: yuanTick } }}
                label={isMobile ? false : { text: (u: any) => cny(u.cost), position: "right", dx: 4 }}
                tooltip={{
                  title: (u: any) => u.user,
                  items: [
                    (u: any) => ({ name: "消费", value: cny4(u.cost) }),
                    (u: any) => ({ name: "Tokens", value: fmtTokens(u.tokens) }),
                    (u: any) => ({ name: "请求", value: num(u.requests) }),
                  ],
                }}
              />
              </ChartBox>
            )}
          </ProCard>
        </Col>
      </Row>

      {/* ---- 用户明细 ---- */}
      <SectionHead title="用户明细" sub={`共 ${users.length} 个用户`} />
      <ProCard>
        <Table
          size="small"
          rowKey="user"
          pagination={false}
          scroll={{ x: "max-content" }}
          dataSource={users}
          locale={{ emptyText: "该范围内暂无数据" }}
          columns={[
            {
              title: "用户",
              dataIndex: "user",
              render: (v: string, r: any) => (
                <>
                  <Text code>{v}</Text>
                  {r.isAdmin ? <Tag color="warning" style={{ marginLeft: 6 }}>管理员</Tag> : null}
                </>
              ),
            },
            { title: "请求数", dataIndex: "requests", render: (v: number) => num(v) },
            { title: <span title={TOKEN_NOTE}>计费 Token</span>, dataIndex: "tokens", render: (v: number) => num(v) },
            { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v) },
            { title: "占比", dataIndex: "cost", key: "pct", render: (v: number) => pctCol(v) },
            {
              title: <span title="¥ / 百万计费 token">¥/M</span>,
              key: "perM",
              render: (_: any, r: any) => perM(r.cost, r.tokens),
            },
            {
              title: <span title={prevLabel}>环比</span>,
              key: "delta",
              render: (_: any, r: any) =>
                d.prevUserAvailable === false ? <Text type="secondary">—</Text> : <Delta pct={r.deltaPct} isNew={r.isNew} />,
            },
          ]}
        />
      </ProCard>

      {/* ---- 用户余额（不含管理员/root）---- */}
      {balances ? (
        <>
          <SectionHead title="用户余额" sub={`不含管理员 · 共 ${balances.length} 个用户 · 余额合计 ${cny(totalBalCny)}`} />
          <ProCard>
            <Table
              size="small"
              rowKey="user"
              pagination={false}
              scroll={{ x: "max-content" }}
              dataSource={nonZeroBal}
              locale={{ emptyText: "没有余额大于 0 的用户" }}
              footer={zeroBalCount > 0 ? () => <Text type="secondary">另有 {zeroBalCount} 个用户余额为 0</Text> : undefined}
              columns={[
                { title: "用户", dataIndex: "user", render: (v: string) => <Text code>{v}</Text> },
                { title: "余额", dataIndex: "balanceUsd", render: (v: number) => cny4(v * rate) },
                { title: "累计已用", dataIndex: "usedUsd", render: (v: number) => cny(v * rate) },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (v: number) => (v === 1 ? "正常" : <Text type="secondary">已禁用</Text>),
                },
              ]}
            />
          </ProCard>
        </>
      ) : null}

      {/* ---- 模型明细 ---- */}
      <SectionHead title="模型明细" sub={`共 ${models.length} 个模型`} />
      <ProCard>
        <Table
          size="small"
          rowKey="model"
          pagination={false}
          scroll={{ x: "max-content" }}
          dataSource={models}
          locale={{ emptyText: "该范围内暂无数据" }}
          columns={[
            {
              title: "模型",
              dataIndex: "model",
              render: (v: string, r: any) => (
                <>
                  <Text code>{v}</Text>
                  {heavyTag(r)}
                </>
              ),
            },
            { title: "请求数", dataIndex: "requests", render: (v: number) => num(v) },
            { title: <span title={TOKEN_NOTE}>计费 Token</span>, dataIndex: "tokens", render: (v: number) => num(v) },
            { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v) },
            { title: "占比", dataIndex: "cost", key: "pct", render: (v: number) => pctCol(v) },
            {
              title: <span title="¥ / 百万计费 token">¥/M</span>,
              key: "perM",
              render: (_: any, r: any) => perM(r.cost, r.tokens),
            },
            {
              title: <span title={prevLabel}>环比</span>,
              key: "delta",
              render: (_: any, r: any) => <Delta pct={r.deltaPct} isNew={r.isNew} />,
            },
          ]}
        />
      </ProCard>

      {/* ---- 分组 / 渠道口径（/api/data/flow）：模型行看不出分组倍率与上游切换 ---- */}
      <SectionHead
        title="分组与渠道"
        sub={`按分组、上游渠道拆分消费，并与${prevLabel}对比${
          flow && !flow.error && flow.coveragePct != null ? ` · 覆盖模型口径消费的 ${flow.coveragePct}%` : ""
        }`}
      />
      {flow?.error ? (
        <Alert type="warning" showIcon message={`分组/渠道口径不可用：${flow.error}`} style={{ marginBottom: 12 }} />
      ) : null}
      {flow && !flow.error && flow.coveragePct != null && flow.coveragePct < 95 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`分组口径只覆盖 ${flow.coveragePct}% 的消费：new-api 的流向查询会跳过没有分组字段的历史记录`}
        />
      ) : null}
      {flow && !flow.error ? (
        <>
          <Row gutter={[12, 12]}>
            {[
              { key: "group", title: "分组", rows: flowRows(flow.byGroup), field: "group" },
              { key: "channel", title: "上游渠道", rows: flowRows(flow.byChannel), field: "channel" },
            ].map((t) => (
              <Col key={t.key} xs={24} lg={12}>
                <ProCard style={{ height: "100%" }} title={<ChartHead title={t.title} sub={`共 ${t.rows.length} 项 · 按消费降序`} />}>
                  <Table
                    size="small"
                    rowKey={t.field}
                    pagination={false}
                    scroll={{ x: "max-content" }}
                    dataSource={t.rows}
                    locale={{ emptyText: "该范围内暂无数据" }}
                    columns={[
                      { title: t.title, dataIndex: t.field, render: (v: string) => <Text code>{v || "—"}</Text> },
                      { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v) },
                      { title: "上窗", dataIndex: "prevCost", render: (v: number) => cny4(v) },
                      {
                        title: <span title={prevLabel}>环比</span>,
                        key: "delta",
                        render: (_: any, r: any) => <Delta pct={r.deltaPct} isNew={r.isNew} />,
                      },
                      { title: <span title={TOKEN_NOTE}>计费 Token</span>, dataIndex: "tokens", render: (v: number) => fmtTokens(v) },
                      { title: <span title="¥ / 百万计费 token">¥/M</span>, key: "perM", render: (_: any, r: any) => perM(r.cost, r.tokens) },
                    ]}
                  />
                </ProCard>
              </Col>
            ))}
          </Row>
          {flow.byUserGroup?.length ? (
            <ProCard style={{ marginTop: 12 }} title={<ChartHead title="用户 × 分组" sub="按消费降序，最多 15 项（定位「谁在哪个分组涨了」）" />}>
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                scroll={{ x: "max-content" }}
                dataSource={flowRows(flow.byUserGroup)}
                locale={{ emptyText: "该范围内暂无数据" }}
                columns={[
                  { title: "用户 · 分组", dataIndex: "key", render: (v: string) => <Text code>{v}</Text> },
                  { title: "请求数", dataIndex: "requests", render: (v: number) => num(v) },
                  { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v) },
                  { title: "上窗", dataIndex: "prevCost", render: (v: number) => cny4(v) },
                  {
                    title: <span title={prevLabel}>环比</span>,
                    key: "delta",
                    render: (_: any, r: any) => <Delta pct={r.deltaPct} isNew={r.isNew} />,
                  },
                  { title: <span title="¥ / 百万计费 token">¥/M</span>, key: "perM", render: (_: any, r: any) => perM(r.cost, r.tokens) },
                ]}
              />
            </ProCard>
          ) : null}
        </>
      ) : null}

      {/* ---- 日志精算：把看板漏计的缓存读写与长上下文算出来 ---- */}
      <SectionHead
        title="日志精算"
        sub="翻消费日志明细，补上看板漏计的缓存读 / 缓存写与长上下文请求"
        extra={
          <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Segmented
              size="small"
              options={AUDIT_ROWS}
              value={auditRows}
              onChange={(v) => setAuditRows(Number(v))}
            />
            <Button size="small" type="primary" loading={auditing} onClick={runAudit}>
              {audit ? "重新精算" : "开始精算"}
            </Button>
          </span>
        }
      />
      <ProCard>
        {auditError ? <Alert type="error" showIcon message={`精算失败：${auditError}`} style={{ marginBottom: 12 }} /> : null}
        {!audit ? (
          <Text type="secondary">
            看板的 token 只有 prompt + completion；Claude 这类缓存占九成的模型会显示成「token 近零、消费很大」。
            点「开始精算」按当前范围翻最近 {num(auditRows)} 条消费日志，算出真实 token、缓存读写与长上下文占比。
          </Text>
        ) : (
          <>
            <Row gutter={[12, 12]}>
              <Col xs={12} md={6}>
                <KpiCard sub={<Text type="secondary" style={{ fontSize: 12 }}>看板口径</Text>}>
                  <Statistic title="计费 Token" value={fmtTokens(audit.totals?.billedTokens || 0)} />
                </KpiCard>
              </Col>
              <Col xs={12} md={6}>
                <KpiCard sub={<Text type="secondary" style={{ fontSize: 12 }}>含缓存读写</Text>}>
                  <Statistic title="真实 Token" value={fmtTokens(audit.totals?.trueTokens || 0)} />
                </KpiCard>
              </Col>
              <Col xs={12} md={6}>
                <KpiCard sub={<Text type="secondary" style={{ fontSize: 12 }}>缓存写 {fmtTokens(audit.totals?.cacheWriteTokens || 0)}</Text>}>
                  <Statistic title="缓存读 Token" value={fmtTokens(audit.totals?.cacheReadTokens || 0)} />
                </KpiCard>
              </Col>
              <Col xs={12} md={6}>
                <KpiCard sub={<Text type="secondary" style={{ fontSize: 12 }}>{cny(audit.totals?.longCost * rate || 0)}</Text>}>
                  <Statistic
                    title={`长上下文（≥${fmtTokens(audit.longContextTokens)}）`}
                    value={num(audit.totals?.longRequests || 0)}
                    suffix="次"
                  />
                </KpiCard>
              </Col>
            </Row>
            <Text type="secondary" style={{ display: "block", margin: "10px 0" }}>
              已扫描 {num(audit.scanned)}
              {audit.total != null ? ` / ${num(audit.total)}` : ""} 条日志
              {audit.fromMs
                ? ` · 覆盖 ${new Date(audit.fromMs).toLocaleString("zh-CN", { hour12: false })} ~ ${new Date(
                    audit.toMs
                  ).toLocaleString("zh-CN", { hour12: false })}`
                : ""}
              {audit.truncated ? " · 已按条数上限截断，只统计最近的这部分" : ""}
            </Text>
            <Table
              size="small"
              rowKey="model"
              pagination={false}
              scroll={{ x: "max-content" }}
              dataSource={audit.byModel || []}
              locale={{ emptyText: "该范围内暂无日志" }}
              columns={[
                {
                  title: "模型",
                  dataIndex: "model",
                  render: (v: string, r: any) => (
                    <>
                      <Text code>{v}</Text>
                      {r.anthropicPct >= 50 ? (
                        <Tag color="gold" style={{ marginLeft: 6 }} title="Claude 语义：缓存读写在 prompt_tokens 之外额外计费">
                          缓存额外计费
                        </Tag>
                      ) : null}
                    </>
                  ),
                },
                { title: "请求数", dataIndex: "requests", render: (v: number) => num(v) },
                { title: <span title={TOKEN_NOTE}>计费 Token</span>, dataIndex: "billedTokens", render: (v: number) => fmtTokens(v) },
                { title: "真实 Token", dataIndex: "trueTokens", render: (v: number) => fmtTokens(v) },
                { title: "缓存读", dataIndex: "cacheReadTokens", render: (v: number) => fmtTokens(v) },
                { title: "缓存写", dataIndex: "cacheWriteTokens", render: (v: number) => fmtTokens(v) },
                {
                  title: `长上下文（≥${fmtTokens(audit.longContextTokens)}）`,
                  key: "long",
                  render: (_: any, r: any) =>
                    r.longRequests ? `${num(r.longRequests)} 次 · ${cny(r.longCost * rate)}` : <Text type="secondary">—</Text>,
                },
                { title: "消费", dataIndex: "cost", render: (v: number) => cny4(v * rate) },
                {
                  title: <span title="¥ / 百万真实 token（含缓存）">¥/M 真实</span>,
                  key: "perMTrue",
                  render: (_: any, r: any) => perM(r.cost * rate, r.trueTokens),
                },
                {
                  title: "计价倍率",
                  key: "ratio",
                  render: (_: any, r: any) => (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {r.avgModelRatio != null ? `模型×${r.avgModelRatio}` : "—"}
                      {r.avgGroupRatio != null ? ` 分组×${r.avgGroupRatio}` : ""}
                      {r.avgCompletionRatio != null ? ` 输出×${r.avgCompletionRatio}` : ""}
                      {r.tiers?.length ? ` · ${r.tiers.map((t: any) => `${t.name}×${t.requests}`).join(" ")}` : ""}
                    </Text>
                  ),
                },
              ]}
            />
          </>
        )}
      </ProCard>
    </PageContainer>
  );
}
