"use client";
// 成本与利润页（v2 新增，无 v1 对应）：从经营视角看成本/收入/利润与余额跑道。
// 数据源：GET /api/analytics?days=N（history_points SQL 聚合 + 固定摊销 + 跑道预测）；
// 收入系列客户端合并自 GET /api/own/analytics（无自营业务时自动隐藏收入与毛利）。
// 口径与 /api/own/analytics 的利润计算一致：成本只算上游站（isOwn 排除），¥ 按站点汇率折算。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import { Alert, Button, Col, Empty, Grid, Row, Segmented, Statistic, Typography, theme } from "antd";
import { Bar, Column, DualAxes, Heatmap, Line, Pie } from "@ant-design/plots";
import { api, cny } from "../../../lib/client";
import ChartBox from "../chart-box";
import LastRefreshed from "../last-refreshed";
import { useThemeMode } from "../../providers";
import AppState from "../../components/app-state";

const { Text } = Typography;

// 与后端 WEEKDAY() 对齐：0=周一 … 6=周日
const r2 = (v: number) => Math.round(v * 100) / 100;
// 图表统一高度：同排两图高度一致，卡片 height:100% 后同排等高
const CHART_H = 300;

// 卡片内空态（数据窗口内没有任何消耗快照时）
function Blank() {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" style={{ padding: "48px 0" }} />;
}

// 图表卡统一两行头：标题一行 + 副标题说明换行放下方（允许折行，不与标题同行挤）
function CardHeader({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {sub ? (
        <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", whiteSpace: "normal" }}>
          {sub}
        </Text>
      ) : null}
    </div>
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return "暂无历史记录";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isMissingOwnConfiguration(message: string) {
  return message.startsWith("还没有标记「我的中转站」");
}

function stationCoverageGaps(coverage: any) {
  const candidates = [
    coverage?.stationGaps,
    coverage?.gaps,
    coverage?.stationCoverage,
    coverage?.stations,
  ];
  const rows = candidates.find(Array.isArray) || [];
  return rows.filter((row: any) =>
    row?.isComplete === false ||
    row?.hasGap === true ||
    Number(row?.missingDays) > 0 ||
    (Array.isArray(row?.missingDates) && row.missingDates.length > 0)
  );
}

function stationGapText(gaps: any[]) {
  if (!gaps.length) return null;
  const labels = gaps.slice(0, 2).map((gap) => {
    const name = gap.stationName || gap.name || gap.stationId || gap.id || "资源";
    const missingDays = Number(gap.missingDays);
    return Number.isFinite(missingDays) && missingDays > 0 ? `${name} 缺 ${missingDays} 天` : `${name} 有采集缺口`;
  });
  const rest = gaps.length - labels.length;
  return `${labels.join("；")}${rest > 0 ? `；另有 ${rest} 个资源` : ""}`;
}

export default function AnalyticsPage() {
  const { dark } = useThemeMode();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  // plots 图表不随 ConfigProvider 算法切换，需显式跟随暗色主题
  const chartTheme = dark ? "classicDark" : "classic";
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<any>(null);
  const [own, setOwn] = useState<any>(null); // /api/own/analytics 响应（无自有站/拉取失败为 null）
  const [ownStatus, setOwnStatus] = useState<"available" | "missing" | "error" | "not-applicable">("not-applicable");
  const [ownError, setOwnError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const load = useCallback(async (d: number) => {
    try {
      const params = new URLSearchParams({ days: String(d) });
      if (includeArchived) params.set("includeArchived", "true");
      const resp = await api(`/api/analytics?${params}`);
      setData(resp);
      setRefreshedAt(Date.now());
      setLoadError(null);
      if (d <= 30) {
        try {
          // 自营收入当前只有 7/30 天数据，长周期不能拿 30 天收入与全年成本混算利润。
          const o = await api(`/api/own/analytics?range=${d <= 7 ? "7d" : "30d"}`);
          setOwn(o);
          setOwnStatus("available");
          setOwnError(null);
        } catch (e: any) {
          const message = e.message || "自营收入分析加载失败";
          setOwn(null);
          if (isMissingOwnConfiguration(message)) {
            setOwnStatus("missing");
            setOwnError(null);
          } else {
            setOwnStatus("error");
            setOwnError(message);
          }
        }
      } else {
        setOwn(null);
        setOwnStatus("not-applicable");
        setOwnError(null);
      }
    } catch (e: any) {
      setLoadError(e.message || "成本分析加载失败");
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  // 首次 + 每 30 秒轮询（与面板其它页面的自动刷新节奏一致），切换范围立即重拉
  useEffect(() => {
    setLoading(true);
    setData(null);
    setOwn(null);
    setOwnStatus("not-applicable");
    setOwnError(null);
    setLoadError(null);
    load(days);
    const timer = setInterval(() => load(days), 30000);
    return () => clearInterval(timer);
  }, [days, includeArchived, load]);

  // ---- 派生数据 ---------------------------------------------------------------
  const derived = useMemo(() => {
    if (!data) return null;
    const upstream = data.stations.filter((s: any) => !s.isOwn && s.includeInProfit !== false);
    const upstreamIds = new Set(upstream.map((s: any) => s.id));

    // 请求窗口日期序列。历史不足时不在最早可用日期之前补 0，避免伪造完整周期。
    const requestedDates: string[] = [];
    {
      const [y, m, d] = String(data.start).split("-").map(Number);
      const cur = new Date(y, m - 1, d);
      for (let i = 0; i < data.days; i++) {
        requestedDates.push(
          `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`
        );
        cur.setDate(cur.getDate() + 1);
      }
    }
    const coverage = data.coverage || null;

    // 每日用量成本 / 固定摊销（¥，仅上游站）
    const usageBy = new Map<string, number>();
    const usageDates = new Set<string>();
    for (const r of data.daily) {
      if (!upstreamIds.has(r.stationId)) continue;
      usageBy.set(r.date, (usageBy.get(r.date) || 0) + r.cny);
      usageDates.add(r.date);
    }
    const fixedBy = new Map<string, number>();
    const fixedDates = new Set<string>();
    for (const r of data.fixedDaily) {
      if (!upstreamIds.has(r.stationId)) continue;
      fixedBy.set(r.date, (fixedBy.get(r.date) || 0) + r.cny);
      fixedDates.add(r.date);
    }
    // 每日汇总会显式保存零消耗日；若某天完全没有汇总记录，说明监测尚未覆盖，不能当作零成本补齐。
    // 没有按量上游时，固定成本记录本身就是该日可用的成本依据。
    const hasUsageStations = upstream.some((s: any) => s.type !== "fixed");
    const dates = requestedDates.filter((date) => hasUsageStations ? usageDates.has(date) : fixedDates.has(date));
    const costSeries = dates.map((date) => {
      const usage = r2(usageBy.get(date) || 0);
      const fixed = r2(fixedBy.get(date) || 0);
      return { date, usage, fixed, cost: r2(usage + fixed) };
    });

    // KPI：窗口总成本 / 日均 / 峰值日 / 预计月化（日均 × 30）
    const totalCost = r2(costSeries.reduce((a, d) => a + d.cost, 0));
    const averageDays = dates.length;
    const avgCost = r2(totalCost / Math.max(1, averageDays));
    const peak = costSeries.reduce((a, d) => (d.cost > a.cost ? d : a), costSeries[0]);
    const monthly = r2(avgCost * 30);

    // 日收入：own 分析只给窗口总收入（含转售 Key 重归），按每日下游消费占比摊到天。
    // 比例分摊保证收入合计与利润口径严格一致，逐日形状随消费波动。
    let incomeBy: Map<string, number> | null = null;
    if (own && own.profit && !own.profit.error && Array.isArray(own.trend)) {
      const rate = own.station?.cnyPerUsd > 0 ? own.station.cnyPerUsd : 1;
      const trendTotal = own.trend.reduce((a: number, t: any) => a + t.cost, 0);
      if (trendTotal > 0) {
        const ratio = own.profit.incomeCny / (trendTotal * rate);
        incomeBy = new Map();
        for (const t of own.trend) {
          const dt = new Date(t.t);
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
          incomeBy.set(key, r2((incomeBy.get(key) || 0) + t.cost * rate * ratio));
        }
      }
    }

    // 图 1：收支柱（长表）+ 毛利线
    const cashCols: any[] = [];
    const profitLine: any[] = [];
    for (const d of costSeries) {
      cashCols.push({ date: d.date, type: "成本", cny: d.cost });
      if (incomeBy) {
        const inc = incomeBy.get(d.date) || 0;
        cashCols.push({ date: d.date, type: "收入", cny: inc });
        profitLine.push({ date: d.date, type: "毛利", cny: r2(inc - d.cost) });
      }
    }

    // 时段热力图只适用于短周期原始快照；长周期不传输小时级数据。
    const heat = data.days <= 30 && data.heatmapAvailable !== false
      ? (data.heatmap || []).map((h: any) => ({
          weekday: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][Number(h.weekday)] || String(h.weekday),
          hour: String(h.hour).padStart(2, "0"),
          cny: Number(h.cny),
        }))
      : [];

    // 图 3：站点成本占比（用量 + 固定摊销，仅有成本的站）
    const pie = upstream
      .map((s: any) => ({ name: s.name, cny: r2(s.totalCny + s.fixedCny) }))
      .filter((x: any) => x.cny > 0)
      .sort((a: any, b: any) => b.cny - a.cny);

    // 图 4：余额跑道（全部站点，剩余天数升序，最紧急在最上面）
    const runway = data.stations
      .filter((s: any) => s.runway && s.runway.etaDays != null)
      .map((s: any) => ({ name: s.name, etaDays: s.runway.etaDays, burnPerDay: s.runway.burnPerDay }))
      .sort((a: any, b: any) => a.etaDays - b.etaDays);

    // 图 5：固定 vs 用量堆叠（长表）
    const stacked: any[] = [];
    for (const d of costSeries) {
      stacked.push({ date: d.date, type: "用量成本", cny: d.usage });
      stacked.push({ date: d.date, type: "固定摊销", cny: d.fixed });
    }

    // 图 6：累计消耗
    let acc = 0;
    const cumulative = costSeries.map((d) => ({ date: d.date, cny: (acc = r2(acc + d.cost)) }));

    // 只统计确有日报记录的天数；缺失日不会被成本图表伪装成零消耗。
    const coveredDays = dates.length;
    const hasData = data.daily.length > 0 || data.fixedDaily.length > 0;
    return {
      costSeries, totalCost, avgCost, peak, monthly, cashCols, profitLine, heat, pie, runway, stacked, cumulative,
      hasIncome: !!incomeBy, hasData, coveredDays, averageDays, coverage,
    };
  }, [data, own]);

  const yAxisCny = { y: { labelFormatter: (v: number) => `¥${v}` } };
  const tooltipCny = { items: [{ channel: "y", valueFormatter: (v: number) => cny(v) }] };
  const coverage = derived?.coverage || data?.coverage || null;
  const coveredDays = coverage ? Number(coverage.availableDays || 0) : (derived?.coveredDays ?? 0);
  const coverageGaps = stationCoverageGaps(coverage);
  const coverageGapSummary = stationGapText(coverageGaps);
  const coverageIsComplete = !!coverage?.isComplete && coveredDays >= days && coverageGaps.length === 0;
  const coverageStart = derived?.costSeries[0]?.date || coverage?.earliestDate;
  const coverageText = coverage
    ? coverageIsComplete
      ? `已完整覆盖 ${coveredDays} 天（${formatDate(coverageStart)} 至 ${formatDate(coverage.latestDate)}）`
      : `请求过去 ${coverage.requestedDays || days} 天，当前可用于成本分析 ${coveredDays} 天（自 ${formatDate(coverageStart)} 起）${coverageGapSummary ? `；${coverageGapSummary}` : ""}`
    : null;

  if (!data && loadError && !loading) {
    return (
      <PageContainer className="responsive-page" title="成本与利润" subTitle="跟踪上游成本、下游收入、利润与余额跑道">
        <AppState
          kind="error"
          title="成本分析暂时无法加载"
          description={loadError}
          actions={<Button type="primary" onClick={() => { setLoading(true); void load(days); }}>重试</Button>}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      className="responsive-page"
      title="成本与利润"
      subTitle="跟踪上游成本、下游收入、利润与余额跑道"
      extra={
        <div className="page-toolbar">
          <LastRefreshed at={refreshedAt} />
          <div className="mobile-scroll">
            <Segmented
              value={days}
              onChange={(v) => setDays(Number(v))}
              options={[
                { label: "7 天", value: 7 },
                { label: "30 天", value: 30 },
                { label: "90 天", value: 90 },
                { label: "365 天", value: 365 },
              ]}
            />
          </div>
          <Button
            aria-pressed={includeArchived}
            onClick={() => setIncludeArchived((current) => !current)}
          >
            {includeArchived ? "已包含归档资源" : "包含归档资源"}
          </Button>
        </div>
      }
    >
      {coverageText ? (
        <Alert
          type={coverageIsComplete ? "info" : "warning"}
          showIcon
          message={coverageIsComplete ? "历史数据覆盖完整" : "历史数据仍在积累"}
          description={coverageText}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {loadError && data ? (
        <Alert
          type="warning"
          showIcon
          message="成本分析刷新失败，正在显示上次成功加载的数据"
          description={loadError}
          action={<Button size="small" onClick={() => { setLoading(true); void load(days); }}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {days <= 30 && ownStatus === "missing" ? (
        <Alert
          type="info"
          showIcon
          message="尚未配置自营业务资源"
          description="当前仅展示上游成本。添加或编辑 New API 资源并标记为自营后，才能显示收入与毛利。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {days <= 30 && ownError ? (
        <Alert
          type="warning"
          showIcon
          message="自营收入暂时无法读取，当前仅展示成本"
          description={ownError}
          action={<Button size="small" onClick={() => { setLoading(true); void load(days); }}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {days > 30 ? (
        <Alert
          type="info"
          showIcon
          message="长周期按日汇总展示"
          description="90/365 天报告不会加载小时级快照或时段热力图；自营收入目前只支持 7/30 天，因此长周期仅展示成本。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {/* KPI 行：总成本 / 日均 / 峰值日 / 预计月化 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <ProCard style={{ height: "100%" }} loading={loading && !data}>
            <Statistic title={`${days} 天总成本`} value={derived ? cny(derived.totalCost) : "-"} />
            {/* 副行统一占位：无内容也保留 minHeight，四卡等高 */}
            <div style={{ minHeight: 20 }}>
              {derived && coveredDays < days ? (
                <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  数据当前覆盖 {coveredDays} 天，将随运行自动补全
                </Text>
              ) : null}
            </div>
          </ProCard>
        </Col>
        <Col xs={12} md={6}>
          <ProCard style={{ height: "100%" }} loading={loading && !data}>
            <Statistic title="日均成本" value={derived ? cny(derived.avgCost) : "-"} />
            <div style={{ minHeight: 20 }}>{null}</div>
          </ProCard>
        </Col>
        <Col xs={12} md={6}>
          <ProCard style={{ height: "100%" }} loading={loading && !data}>
            <Statistic title="峰值日" value={derived ? cny(derived.peak?.cost ?? 0) : "-"} />
            <div style={{ minHeight: 20 }}>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>{derived?.peak?.date || ""}</Text>
            </div>
          </ProCard>
        </Col>
        <Col xs={12} md={6}>
          <ProCard style={{ height: "100%" }} loading={loading && !data}>
            <Statistic title="预计月化成本" value={derived ? cny(derived.monthly) : "-"} />
            <div style={{ minHeight: 20 }}>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>按已覆盖 {derived ? derived.averageDays : days} 天日均 × 30</Text>
            </div>
          </ProCard>
        </Col>
      </Row>

      {/* 图 1：收支利润趋势（无自有站时退化为成本柱） */}
      <ProCard
        title={
          <CardHeader
            title={derived?.hasIncome ? "收支利润趋势" : "成本趋势"}
            sub={derived?.hasIncome ? "日成本 = 上游消耗 × 汇率 + 固定摊销；日收入按下游消费占比分摊；毛利 = 收入 − 成本" : "日成本 = 上游消耗 × 汇率 + 固定摊销"}
          />
        }
        style={{ marginTop: 16 }}
        loading={loading && !data}
      >
        {derived && derived.hasData ? (
          <>
            {/* G2 内置图例会把三个系列折叠成分页器（成本 ◀1/3▶），此处关闭内置图例，
                自绘一行 antd 图例，色块与系列 scale.color 保持一致，保证三项永远完整可见 */}
            <div style={{ display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
              {[
                { label: "成本", color: token.colorPrimary },
                ...(derived.hasIncome
                  ? [
                      { label: "收入", color: token.colorTextSecondary },
                      { label: "毛利", color: token.colorText },
                    ]
                  : []),
              ].map((it) => (
                <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: "inline-block" }} />
                  <Text style={{ fontSize: 12 }}>{it.label}</Text>
                </span>
              ))}
            </div>
            <ChartBox h={CHART_H}>
            <DualAxes
              height={CHART_H}
              theme={chartTheme}
              xField="date"
              legend={false}
              /* color scale 必须放顶层：DualAxes 会合并子图的 color 通道，
                 子图各写各的 range 会互相覆盖（毛利的橙色曾把成本柱也染橙，与图例不符） */
              scale={{
                color: {
                  domain: derived.hasIncome ? ["成本", "收入", "毛利"] : ["成本"],
                  range: derived.hasIncome
                    ? [token.colorPrimary, token.colorTextSecondary, token.colorText]
                    : [token.colorPrimary],
                },
              }}
              children={[
              {
                data: derived.cashCols,
                type: "interval",
                yField: "cny",
                colorField: "type",
                group: true,
                axis: yAxisCny,
                tooltip: tooltipCny,
              },
              ...(derived.hasIncome
                ? [{
                    data: derived.profitLine,
                    type: "line",
                    yField: "cny",
                    colorField: "type",
                    style: { lineWidth: 2 },
                    axis: { y: { position: "right", labelFormatter: (v: number) => `¥${v}` } },
                    scale: { y: { independent: true } },
                    tooltip: tooltipCny,
                  }]
                : []),
              ]}
            />
            </ChartBox>
          </>
        ) : (
          <Blank />
        )}
      </ProCard>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* 图 2：时段热力图仅适用于短周期原始快照 */}
        {days <= 30 ? <Col xs={24} lg={14}>
          <ProCard
            title={<CardHeader title="消耗时段热力图" sub="星期 × 小时的消耗强度（¥），颜色越深消耗越大" />}
            style={{ height: "100%" }}
            loading={loading && !data}
          >
            {data?.heatmapAvailable === false ? (
              <Alert
                type="info"
                showIcon
                message="时段热力图暂不可用"
                description="热力图需要近期原始监测快照。当前留存期限或采集覆盖不足，缺失时段不会补成零消耗。"
              />
            ) : derived?.heat.length ? (
              <ChartBox h={CHART_H}>
              <Heatmap
                height={CHART_H}
                theme={chartTheme}
                data={derived.heat}
                xField="hour"
                yField="weekday"
                colorField="cny"
                mark="cell"
                // 显式色带：0 值 = 容器底色（浅色白 / 深色深灰），避免 G2 默认桃色系把无消耗格子染成肤色
                scale={{ color: { range: [token.colorBgContainer, token.colorPrimary] } }}
                style={{ inset: 0.5, stroke: token.colorBorderSecondary }}
                axis={{
                  x: {
                    title: "时",
                    labelFormatter: (v: any) => (!isMobile || Number(v) % 4 === 0 ? v : ""),
                  },
                  y: { title: null },
                }}
                legend={{ color: { position: "bottom" } }}
                tooltip={{ items: [{ channel: "color", valueFormatter: (v: number) => cny(v) }] }}
              />
              </ChartBox>
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col> : null}
        {/* 图 3：站点成本占比 */}
        <Col xs={24} lg={days <= 30 ? 10 : 24}>
          <ProCard
            title={<CardHeader title={`站点成本占比（近 ${days} 天）`} sub="用量成本 + 固定摊销，¥ 口径" />}
            style={{ height: "100%" }}
            loading={loading && !data}
          >
            {derived && derived.pie.length ? (
              <ChartBox h={CHART_H}>
              <Pie
                height={CHART_H}
                theme={chartTheme}
                data={derived.pie}
                angleField="cny"
                colorField="name"
                innerRadius={0.6}
                label={isMobile ? false : { text: "name", position: "outside" }}
                legend={{ color: { position: "bottom" } }}
                tooltip={{ items: [{ channel: "y", valueFormatter: (v: number) => cny(v) }] }}
              />
              </ChartBox>
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* 图 4：余额跑道 */}
        <Col xs={24} lg={10}>
          <ProCard
            title={<CardHeader title="余额跑道（预计可用天数）" sub="按实时消耗速率预测的耗尽天数：红 <3 天、黄 <7 天、绿 ≥7 天" />}
            style={{ height: "100%" }}
            loading={loading && !data}
          >
            {derived && derived.runway.length ? (
              <ChartBox h={CHART_H}>
              <Bar
                height={CHART_H}
                theme={chartTheme}
                data={derived.runway}
                xField="name"
                yField="etaDays"
                style={{
                  fill: (d: any) =>
                    d.etaDays < 3 ? token.colorError : d.etaDays < 7 ? token.colorWarning : token.colorSuccess,
                  maxWidth: 24,
                }}
                label={isMobile ? false : { text: (d: any) => `${d.etaDays} 天`, position: "right", dx: 4 }}
                axis={{
                  y: { title: "天" },
                  x: {
                    title: null,
                    labelFormatter: (v: any) => {
                      const s = String(v ?? "");
                      return isMobile && s.length > 8 ? `${s.slice(0, 7)}…` : s;
                    },
                  },
                }}
                tooltip={{ items: [{ channel: "y", valueFormatter: (v: number) => `${v} 天` }] }}
              />
              </ChartBox>
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
        {/* 图 5：固定成本 vs 用量成本 */}
        <Col xs={24} lg={14}>
          <ProCard
            title={<CardHeader title="固定成本 vs 用量成本" sub="固定摊销 = 每笔付费按 金额÷天数 摊到生效日" />}
            style={{ height: "100%" }}
            loading={loading && !data}
          >
            {derived && derived.hasData ? (
              <ChartBox h={CHART_H}>
              <Column
                height={CHART_H}
                theme={chartTheme}
                data={derived.stacked}
                xField="date"
                yField="cny"
                colorField="type"
                stack
                scale={{
                  color: {
                    domain: ["用量成本", "固定摊销"],
                    range: [token.colorPrimary, token.colorTextSecondary],
                  },
                }}
                axis={yAxisCny}
                legend={{ color: { position: isMobile ? "bottom" : "top" } }}
                tooltip={tooltipCny}
              />
              </ChartBox>
            ) : (
              <Blank />
            )}
          </ProCard>
        </Col>
      </Row>

      {/* 图 6：累计消耗 */}
      <ProCard
        title={<CardHeader title={`累计消耗（近 ${days} 天）`} sub={`窗口内日成本逐日累加（用量 + 固定摊销，¥ 口径）`} />}
        style={{ marginTop: 16 }}
        loading={loading && !data}
      >
        {derived && derived.hasData ? (
          <ChartBox h={CHART_H}>
          <Line
            height={CHART_H}
            theme={chartTheme}
            data={derived.cumulative}
            xField="date"
            yField="cny"
            shapeField="smooth"
            style={{ lineWidth: 2, stroke: token.colorPrimary }}
            axis={yAxisCny}
            tooltip={tooltipCny}
          />
          </ChartBox>
        ) : (
          <Blank />
        )}
      </ProCard>
    </PageContainer>
  );
}
