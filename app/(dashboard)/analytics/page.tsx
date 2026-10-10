"use client";
// 监控估算：利润等式 + 收入与用量成本趋势 + 成本构成 + 消耗时段 + 可用天数 + 累计成本 + 覆盖说明。
// 成本来自 /api/analytics（按上游汇总、按站点汇率折算），收入来自 /api/own/analytics（只支持 7/30 天）。
// 时间范围和"包含已归档"写进地址栏；切换时保留上一份数据并变淡，避免整页闪成骨架。
import "../../styles/pages/analytics.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button, Checkbox } from "antd";
import { NAV_LABELS } from "../../../lib/brand";
import { api } from "../../../lib/client";
import { formatDays, formatMoney, isoDay } from "../../../lib/format";
import { EmptyState, ErrorState, PanelSkeleton, Skeleton } from "../../components/data-state";
import type { TipRow } from "../../components/float-tip";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Heatmap } from "../../components/heatmap";
import { Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { ProfitEquation } from "../../components/profit-equation";
import type { EqTerm } from "../../components/profit-equation";
import { RangePicker } from "../../components/range-picker";
import { Runway } from "../../components/runway";
import type { RunwayItem } from "../../components/runway";
import { useShellPage } from "../../components/shell-context";
import { TrendPanel } from "../../components/trend-panel";
import { useUrlParams } from "../../components/use-url-state";
import { CumulativePanel } from "./cumulative-chart";
import { addDays, dayDiff, derive, deriveHeat, gapSummary, md, r2, runsText, validDay } from "./derive";
import type { Derived, OwnStatus } from "./derive";

type Heat = ReturnType<typeof deriveHeat>;
// 所选范围的消耗时段画不出来时退回的近 7 天；heat 为 null 表示退回也失败了
// key：归档条件 + 整点，只有两者都和当前一致才拿来展示
type HeatFallback = { key: string; heat: Heat | null };

const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
const RANGE_OPTIONS = [
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
];
// 接口 days 上限 365：自定义开始日期最早到 364 天前
const MAX_DAYS = 365;
const WARN_DAYS = 7;
const POLL_MS = 30000;
const EQ_TITLE = "期内成本与利润";
const COVERAGE_ID = "analytics-coverage";

type Snapshot = {
  data: any;
  own: any;
  ownStatus: OwnStatus;
  ownError: string | null;
  // 这份数据对应的查询条件；与当前选择不一致时说明正在切换
  days: number;
  includeArchived: boolean;
};

const coverageLink = (
  <a href={`#${COVERAGE_ID}`} className="jy-link">
    查看覆盖说明
  </a>
);

export default function AnalyticsPage() {
  const [sp, setUrl] = useUrlParams();
  const today = isoDay(new Date());
  const minDate = addDays(today, -(MAX_DAYS - 1));
  const rawRange = sp.get("range") || "";
  const rawStart = sp.get("start");
  const customOk = rawRange === "custom" && validDay(rawStart) && rawStart >= minDate && rawStart <= today;
  const rangeValue = customOk ? "custom" : PRESET_DAYS[rawRange] ? rawRange : "30d";
  const days = customOk ? dayDiff(rawStart, today) + 1 : PRESET_DAYS[rangeValue];
  const includeArchived = sp.get("archived") === "1";

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [critDays, setCritDays] = useState(3);
  const [metaFailed, setMetaFailed] = useState(false);
  // 只采用最后一次发出的请求结果，避免快速切换范围时旧响应覆盖新范围
  const seq = useRef(0);

  // 返回这次加载的错误信息（成功或已被更新的请求取代时返回 null），供顶栏刷新按钮提示
  const load = useCallback(
    async (d: number): Promise<string | null> => {
      const my = ++seq.current;
      const params = new URLSearchParams({ days: String(d) });
      if (includeArchived) params.set("includeArchived", "true");
      // 两个请求并行；自营收入只有 7/30 天口径，长周期不能拿 30 天收入与更长的成本混算利润
      const [a, o] = await Promise.allSettled([
        api(`/api/analytics?${params}`),
        d <= 30 ? api(`/api/own/analytics?range=${d <= 7 ? "7d" : "30d"}`) : Promise.resolve(null),
      ]);
      if (my !== seq.current) return null;
      let error: string | null = null;
      if (a.status === "rejected") {
        // 保留上一次成功的数据，页面顶部提示刷新失败
        error = a.reason?.message || "成本分析加载失败";
        setLoadError(error);
      } else {
        let ownStatus: OwnStatus = "not-applicable";
        let own: any = null;
        let ownError: string | null = null;
        if (d <= 30) {
          if (o.status === "fulfilled") {
            own = o.value;
            ownStatus = "available";
          } else {
            const message = String(o.reason?.message || "自营收入分析加载失败");
            if (message.startsWith("还没有标记「我的中转站」")) ownStatus = "missing";
            else {
              ownStatus = "error";
              ownError = message;
            }
          }
        }
        setSnap({ data: a.value, own, ownStatus, ownError, days: d, includeArchived });
        setAsOf(Date.now());
        setLoadError(null);
      }
      setLoading(false);
      return error;
    },
    [includeArchived],
  );

  // 首次 + 每 30 秒轮询；切换范围或归档开关立即重拉
  useEffect(() => {
    setLoading(true);
    load(days);
    const timer = setInterval(() => load(days), POLL_MS);
    return () => clearInterval(timer);
  }, [days, load]);

  // 紧急阈值与告警规则一致（可用天数 ≤ rules.etaDays 时告警）
  useEffect(() => {
    api("/api/meta")
      .then((m) => {
        const v = Number(m?.rules?.etaDays);
        if (Number.isFinite(v) && v > 0) setCritDays(v);
      })
      .catch(() => setMetaFailed(true));
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    return load(days);
  }, [load, days]);

  const range = useMemo(
    () => (
      <RangePicker
        value={rangeValue}
        options={RANGE_OPTIONS}
        onChange={(v) => setUrl({ range: v === "30d" ? null : v, start: null })}
        custom={{
          startDate: customOk ? rawStart : null,
          minDate,
          maxDate: today,
          onApply: (start) => setUrl({ range: "custom", start }),
        }}
      />
    ),
    [rangeValue, customOk, rawStart, minDate, today, setUrl],
  );

  useShellPage({
    onRefresh: async () => {
      const error = await load(days);
      if (error) throw new Error(`成本分析刷新失败：${error}`);
    },
    asOf,
    range,
  });

  const dv = useMemo(() => (snap ? derive(snap.data, snap.own) : null), [snap]);

  // 消耗时段要求所选范围内每个上游的原始快照都齐全；缺了某几天时退回近 7 天，
  // 不让整块空着。按小时取一次就够（热力图本身就是小时粒度）。
  const needHeat7 = !!dv && !dv.heat.available && dv.heat.reason === "incomplete-raw-history" && (snap?.days ?? 0) > 7;
  const hourKey = asOf ? Math.floor(asOf / 3600000) : 0;
  const heat7Key = `${includeArchived ? 1 : 0}:${hourKey}`;
  const [heat7, setHeat7] = useState<HeatFallback | null>(null);
  const heat7Ready = heat7?.key === heat7Key;
  useEffect(() => {
    // 同一条件、同一小时内已经取过就直接复用（来回切换范围不再重复请求）
    if (!needHeat7 || heat7Ready) return;
    let alive = true;
    const params = new URLSearchParams({ days: "7" });
    if (includeArchived) params.set("includeArchived", "true");
    api(`/api/analytics?${params}`)
      .then((d) => alive && setHeat7({ key: heat7Key, heat: deriveHeat(d) }))
      .catch(() => alive && setHeat7({ key: heat7Key, heat: null }));
    return () => {
      alive = false;
    };
  }, [needHeat7, heat7Key, heat7Ready]); // eslint-disable-line react-hooks/exhaustive-deps
  // 条件或整点变了、新数据还没回来时显示加载中，不拿上一份顶替
  const heatFallback = needHeat7 && heat7Ready ? heat7 : null;

  const archivedCount = Number(snap?.data?.selection?.archivedStationCount) || 0;
  const archiveToggle = (
    <Checkbox checked={includeArchived} onChange={(e) => setUrl({ archived: e.target.checked ? "1" : null })}>
      包含已归档{includeArchived && snap?.includeArchived && archivedCount > 0 ? `（${archivedCount} 个）` : ""}
    </Checkbox>
  );

  // 本页是监控口径的估算，实际 Key 账单在账单核算页
  const sourceNote = (
    <div className="jy-banner jy-banner--info jy-analytics-source">
      <Sym kind="info" />
      <div className="jy-analytics-source-body">
        <b>监控估算来源</b>
        <p>
          成本来自余额变化与固定摊销，余额跑道来自历史预测；按资源汇率折算为人民币。此处估算不代表实际 Key
          账单成本或现金付款，账单核算请查看对应来源与完整日窗口。
        </p>
      </div>
      <div className="page-toolbar">
        <Button size="small" href="/reconciliation">
          {NAV_LABELS.reconciliation}
        </Button>
      </div>
    </div>
  );

  // 首次加载：骨架与真实布局一致
  if (!snap && loading) {
    return (
      <div className="jy-page" aria-busy="true">
        <ProfitEquation title={EQ_TITLE} extra={archiveToggle} loading revenue={{ value: null }} usage={{ value: null }} fixed={{ value: null }} />
        <PanelSkeleton title="收入与用量成本" height={400} />
        <div className="jy-grid-2 jy-grid-even">
          <PanelSkeleton title="成本构成" lines={5} />
          <PanelSkeleton title="消耗时段" height={180} />
        </div>
        <div className="jy-grid-2">
          <PanelSkeleton title="可用天数" lines={4} />
          <PanelSkeleton title="成本概况" lines={4} />
        </div>
      </div>
    );
  }

  // 没有任何数据，或刚切换的范围加载失败（旧数据对应别的范围，不能冒充）
  const stale = !!snap && (snap.days !== days || snap.includeArchived !== includeArchived);
  if (!snap || !dv || (stale && loadError && !loading)) {
    return (
      <div className="jy-page">
        <Panel title={EQ_TITLE} extra={archiveToggle}>
          <ErrorState title="成本分析暂时无法加载" error={loadError} onRetry={retry} center />
        </Panel>
      </div>
    );
  }

  const data = snap.data;
  const stations: any[] = Array.isArray(data.stations) ? data.stations : [];
  if (stations.length === 0) {
    return (
      <div className={`jy-page${loading && stale ? " jy-analytics-switching" : ""}`} aria-busy={(loading && stale) || undefined}>
        {sourceNote}
        <Panel title={EQ_TITLE} extra={archiveToggle}>
          <EmptyState
            title="还没有上游资源"
            desc={includeArchived ? "添加上游资源并开始采集后，这里会统计成本与利润。" : "添加上游资源并开始采集后，这里会统计成本与利润。已归档的资源勾选“包含已归档”后可以查看。"}
            action={
              <Link href="/stations" className="jy-link">
                添加上游资源
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const windowCaption = `${md(data.start)} 至 ${data.end === today ? "今天" : md(data.end)}，共 ${data.days} 天`;
  const href30 = includeArchived ? "/analytics?archived=1" : "/analytics";

  return (
    <div className={`jy-page${loading && stale ? " jy-analytics-switching" : ""}`} aria-busy={(loading && stale) || undefined}>
      {loadError && (
        <div className="jy-banner" role="alert">
          <Sym kind="warn" />
          <div className="jy-analytics-banner-body">
            <span>成本分析刷新失败，正在显示上次成功加载的数据。{loadError}</span>
            <Button size="small" onClick={retry}>
              重试
            </Button>
          </div>
        </div>
      )}

      {sourceNote}

      <Equation dv={dv} snap={snap} caption={windowCaption} extra={archiveToggle} href30={href30} onRetry={retry} />

      <TrendPanel rows={dv.rows} showRev={dv.hasIncome} asOf={asOf} />

      <div className="jy-grid-2 jy-grid-even">
        <MixPanel dv={dv} />
        <HeatPanel
          dv={dv}
          days={data.days}
          href30={href30}
          fallback={heatFallback}
          fallbackLoading={needHeat7 && !heatFallback}
          onShorter={() => setUrl({ range: "7d", start: null })}
        />
      </div>

      {/* 可用天数的进度条在半宽卡片里太窄，窄屏和总览一样先换成单列 */}
      <div className="jy-grid-2">
        <RunwayPanel dv={dv} critDays={critDays} metaFailed={metaFailed} />
        <SummaryPanel dv={dv} days={data.days} />
      </div>

      <CumulativePanel rows={dv.rows} asOf={asOf} />

      <CoveragePanel dv={dv} data={data} stations={stations} />
    </div>
  );
}

// ---- 利润等式 ------------------------------------------------------------------

// 缺数据的原因：每条一句，句号结尾
function coverageReasons(dv: Derived): ReactNode[] {
  const out: ReactNode[] = [];
  const todayMissing = dv.rows.some((r) => r.today && r.missing);
  const past = dv.missingDates.filter((d) => !dv.rows.find((r) => r.date === d)?.today);
  if (past.length) out.push(`${runsText(past)}上游用量记录缺失，这 ${past.length} 天的用量成本未计入。`);
  if (todayMissing) out.push("今天还没有采集到上游用量，今天的用量成本未计入。");
  if (dv.partialDates.length) {
    const who = gapSummary(dv.upstreamGaps);
    out.push(
      `${out.length ? "另有" : ""} ${dv.partialDates.length} 天只有部分上游有记录${who ? `（${who}）` : ""}，缺记录的上游在这些天的用量成本未计入。`.trim(),
    );
  }
  return out;
}

function Equation({
  dv,
  snap,
  caption,
  extra,
  href30,
  onRetry,
}: {
  dv: Derived;
  snap: Snapshot;
  caption: string;
  extra: ReactNode;
  href30: string;
  onRetry: () => void;
}) {
  const usage: EqTerm = {
    value: dv.usage,
    approx: dv.usageApprox,
    note: dv.usageApprox ? "部分数据缺失" : dv.monitoredCount ? `${dv.monitoredCount} 个上游` : "没有按量计费的上游",
    href: "/stations",
  };
  const fixed: EqTerm = { value: dv.fixed, note: dv.fixed > 0 ? "按付费周期摊到每天" : "没有固定成本" };
  const reasons = coverageReasons(dv);
  const ownName = snap.own?.station?.name || "自营站点";

  if (dv.hasIncome) {
    // 收入是估算的两种情况：自营站点没设汇率（按 1:1 折算）、所选天数和自营收入口径（7 / 30 天）不一致
    const revReasons: string[] = [];
    if (dv.ownNoRate) revReasons.push(`${ownName} 没有设置售价汇率，收入按 1 美元 = 1 元折算。`);
    if (dv.revenueSplit)
      revReasons.push(`自营收入只按近 7 天、近 30 天统计，这里的收入是把近 ${dv.ownDays} 天的收入按每天下游消费占比摊开后取了所选的 ${dv.rows.length} 天。`);
    const revNote = dv.ownNoRate ? "未设汇率，按 1:1 估算" : dv.revenueSplit ? `由近 ${dv.ownDays} 天收入摊分` : ownName;
    // 缺的是成本时毛利一定偏高；只是收入估算时方向不定
    const tail = reasons.length ? (
      <>
        缺失的用量成本会让毛利偏高。{coverageLink}
      </>
    ) : (
      "毛利随收入一起是估算值。"
    );
    return (
      <ProfitEquation
        title={EQ_TITLE}
        caption={caption}
        extra={extra}
        revenue={{ value: dv.revenue, approx: dv.revenueApprox, note: revNote, href: "/my" }}
        usage={usage}
        fixed={fixed}
        reasons={[...revReasons, ...reasons]}
        partialTail={revReasons.length ? tail : <>实际毛利会比这里低。{coverageLink}</>}
      />
    );
  }

  // 收入算不出来：说明原因和下一步，成本照常统计
  let revenueEmpty = "无法计算";
  let revenueNote: ReactNode = ownName;
  let profitNote: ReactNode = "收入无法计算";
  let notice: ReactNode;
  const retryBtn = (
    <Button size="small" onClick={onRetry} className="jy-analytics-inline-btn">
      重试
    </Button>
  );
  if (snap.ownStatus === "not-applicable") {
    revenueEmpty = "不适用";
    revenueNote = "只支持 30 天以内";
    profitNote = "收入不适用";
    notice = (
      <>
        自营收入目前只支持 30 天以内。超过 30 天时只统计成本，不把 30 天的收入和更长时间的成本混在一起算毛利。
        <Link href={href30} className="jy-link" scroll={false}>
          切换到近 30 天
        </Link>
      </>
    );
  } else if (snap.ownStatus === "missing") {
    revenueEmpty = "未设置";
    revenueNote = "没有自营站点";
    profitNote = "设置自营站点后计算";
    notice = (
      <>
        还没有设置自营站点，所以收入和毛利暂时无法计算；用量成本和固定成本照常统计。把自己的 New API 资源标记为自营后即可显示收入。
        <Link href="/my" className="jy-link">
          设置自营站点
        </Link>
      </>
    );
  } else if (snap.ownStatus === "error") {
    revenueEmpty = "读取失败";
    revenueNote = "自营收入";
    profitNote = "收入读取失败";
    notice = (
      <>
        自营收入暂时无法读取，当前只统计成本。{snap.ownError}
        {retryBtn}
      </>
    );
  } else {
    notice = (
      <>
        自营收入无法按天计算：{dv.incomeIssue || "自营站点没有返回可用的收入数据。"}
        {retryBtn}
      </>
    );
  }

  return (
    <ProfitEquation
      title={EQ_TITLE}
      caption={caption}
      extra={extra}
      unconfigured
      revenue={{ value: null, note: revenueNote, href: "/my" }}
      revenueEmpty={revenueEmpty}
      usage={usage}
      fixed={fixed}
      profitNote={profitNote}
      notice={notice}
      reasons={reasons}
      partialTail={<>实际成本会比这里高。{coverageLink}</>}
    />
  );
}

// ---- 成本构成 ------------------------------------------------------------------

function MixPanel({ dv }: { dv: Derived }) {
  const items: HBarItem[] = dv.mix.map((m) => {
    const name = m.archived ? `${m.name}（已归档）` : m.name;
    if (m.unknown) {
      // 期内一条用量记录都没有：画斜纹空条，不当作 0
      return { key: m.id, name, value: null, note: m.fixed > 0 ? `数据缺失，固定成本 ${formatMoney(m.fixed)}` : "数据缺失" };
    }
    const tip: [ReactNode, ReactNode][] = [
      ["用量成本", formatMoney(m.usage, { approx: m.missingDays > 0 })],
      ["固定成本", formatMoney(m.fixed)],
    ];
    if (m.missingDays > 0) tip.push(["用量记录", `缺 ${m.missingDays} 天，未计入`]);
    return { key: m.id, name, value: r2(m.usage + m.fixed), tipExtra: tip };
  });
  return (
    <Panel title="成本构成" caption="按上游资源，期内合计（用量成本 + 固定成本）">
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName="成本"
        total={items.length ? { label: "合计", value: formatMoney(r2(dv.usage + dv.fixed), { approx: dv.usageApprox }) } : undefined}
        empty={
          <>
            期内没有上游成本。
            <Link href="/stations" className="jy-link">
              管理上游资源
            </Link>
          </>
        }
      />
    </Panel>
  );
}

// ---- 消耗时段 ------------------------------------------------------------------

function HeatPanel({
  dv,
  days,
  href30,
  fallback,
  fallbackLoading,
  onShorter,
}: {
  dv: Derived;
  days: number;
  href30: string;
  fallback: HeatFallback | null;
  fallbackLoading: boolean;
  onShorter: () => void;
}) {
  const { heat } = dv;
  const fb = fallback?.heat?.available ? fallback.heat : null;
  let caption = "期内每个时段的用量成本合计，按星期和小时";
  let body: ReactNode;
  if (heat.available && !heat.empty) {
    body = <Heatmap grid={heat.grid} valueLabel="用量成本合计" peakNote={`期内 ${days} 天合计`} />;
  } else if (heat.available) {
    body = <EmptyState title="这段时间上游没有用量消耗" desc="有消耗后，这里会按星期和小时显示用量成本。" />;
  } else if (heat.reason === "range-not-supported") {
    body = (
      <EmptyState
        title="超过 30 天不提供消耗时段"
        desc="时段统计需要小时级的原始监测快照，只在 30 天以内提供；长周期按日汇总，不加载小时级快照。"
        action={
          <Link href={href30} className="jy-link" scroll={false}>
            切换到近 30 天
          </Link>
        }
      />
    );
  } else if (heat.reason === "no-cost-stations") {
    body = (
      <EmptyState
        title="没有可统计时段的上游"
        desc="消耗时段只统计按量计费、计入利润的上游；当前范围内没有这样的上游。"
        action={
          <Link href="/stations" className="jy-link">
            管理上游资源
          </Link>
        }
      />
    );
  } else if (fallbackLoading) {
    body = <Skeleton height={180} />;
  } else if (fb) {
    // 退回近 7 天：说明为什么不是所选范围，缺快照的上游点名
    const who = gapSummary(heat.gaps);
    caption = "近 7 天每个时段的用量成本合计，按星期和小时";
    body = (
      <>
        <p className="jy-caption jy-analytics-heat-note">
          所选 {days} 天里有上游缺少原始监测快照{who ? `：${who}` : ""}。这里改为显示近 7 天。
          <Link href="/settings" className="jy-link">
            调整数据留存
          </Link>
        </p>
        {fb.empty ? (
          <EmptyState title="近 7 天上游没有用量消耗" desc="有消耗后，这里会按星期和小时显示用量成本。" />
        ) : (
          <Heatmap grid={fb.grid} valueLabel="用量成本合计" peakNote="近 7 天合计" />
        )}
      </>
    );
  } else {
    const who = gapSummary(heat.gaps);
    body = (
      <EmptyState
        title="近期原始快照不足"
        desc={`热力图需要近期原始监测快照。当前留存期限或采集覆盖不足，缺失时段不会补成零消耗。${who ? `缺快照的上游：${who}。` : ""}`}
        action={
          <>
            {/* 近 7 天也画不出来时不再引导切换 */}
            {days > 7 && !fallback?.heat && <Button onClick={onShorter}>切换到近 7 天</Button>}
            <Link href="/settings" className="jy-link">
              调整数据留存
            </Link>
          </>
        }
      />
    );
  }
  return (
    <Panel title="消耗时段" caption={caption}>
      {body}
    </Panel>
  );
}

// ---- 可用天数 ------------------------------------------------------------------

function RunwayPanel({ dv, critDays, metaFailed }: { dv: Derived; critDays: number; metaFailed: boolean }) {
  const items: RunwayItem[] = dv.runway.map((s) => {
    const level = s.days <= critDays ? "crit" : s.days < WARN_DAYS ? "warn" : "good";
    const suffix = s.archived ? "（已归档）" : "";
    const burn = Number.isFinite(s.burnCny) ? formatMoney(s.burnCny) : "—";
    const tip: TipRow[] = [
      ["日均消耗", burn],
      ["可用", formatDays(s.days)],
    ];
    if (s.basis) tip.push(["推算依据", s.basis]);
    return { key: s.id, name: `${s.name}${suffix}`, sub: `日均消耗 ${burn}`, days: s.days, level, tip };
  });
  const caption = metaFailed
    ? `告警规则读取失败，按 ${critDays} 天内为紧急`
    : `按近期消耗推算，${critDays} 天内为紧急，${WARN_DAYS} 天内需注意`;
  return (
    <Panel title="可用天数" caption={caption} body={items.length ? false : true}>
      {items.length ? (
        <div className="jy-analytics-runway">
          <Runway items={items} critDays={critDays} warnDays={WARN_DAYS} />
        </div>
      ) : (
        <EmptyState
          title="暂时没有可推算的上游"
          desc="需要有余额记录和近期消耗才能推算可用天数。"
          action={
            <Link href="/stations" className="jy-link">
              查看上游资源
            </Link>
          }
        />
      )}
    </Panel>
  );
}

// ---- 成本概况 ------------------------------------------------------------------

function SummaryPanel({ dv, days }: { dv: Derived; days: number }) {
  const { kpi } = dv;
  const approx = dv.usageApprox;
  const none = kpi.coveredDays === 0;
  return (
    <Panel title="成本概况" caption="用量成本 + 固定成本">
      <dl className="jy-kv jy-num">
        <dt>期内总成本</dt>
        <dd>
          {formatMoney(kpi.total, { approx })}
          {kpi.coveredDays < days && <div className="jy-caption">数据当前覆盖 {kpi.coveredDays} 天，将随运行自动补全</div>}
        </dd>
        <dt>日均成本</dt>
        <dd>
          {none ? "—" : formatMoney(kpi.avg, { approx: dv.partialDates.length > 0 })}
          <div className="jy-caption">{none ? "没有可用的记录" : `按有记录的 ${kpi.coveredDays} 天平均`}</div>
        </dd>
        <dt>峰值日</dt>
        <dd>
          {kpi.peak ? (
            <>
              {formatMoney(kpi.peak.cost)}
              <div className="jy-caption">{kpi.peak.today ? "今天" : md(kpi.peak.date)}</div>
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>预计月化成本</dt>
        <dd>
          {none ? "—" : formatMoney(kpi.monthly, { approx: dv.partialDates.length > 0 })}
          {!none && <div className="jy-caption">按已覆盖 {kpi.coveredDays} 天日均 × 30</div>}
        </dd>
      </dl>
    </Panel>
  );
}

// ---- 覆盖说明 ------------------------------------------------------------------

function CoveragePanel({ dv, data, stations }: { dv: Derived; data: any; stations: any[] }) {
  const days = dv.rows.length;
  const nMissing = dv.missingDates.length;
  const nPartial = dv.partialDates.length;
  const earliest: string | null = dv.coverage?.earliestDate || null;
  const byId = new Map(stations.map((s) => [s.id, s]));

  let lead: string;
  if (dv.monitoredCount === 0) {
    lead = "所选范围内没有按量计费的上游用量记录，只统计固定成本。";
  } else if (!nMissing && !nPartial) {
    lead = `所选 ${days} 天每天都有全部 ${dv.monitoredCount} 个上游的用量记录。`;
  } else {
    const parts = [`${days - nMissing - nPartial} 天记录完整`];
    if (nPartial) parts.push(`${nPartial} 天只有部分上游有记录`);
    if (nMissing) parts.push(`${nMissing} 天没有任何上游用量记录`);
    lead = `所选 ${days} 天中，${parts.join("，")}。缺记录的日子不会补成零，用量成本只按已有记录计算。`;
  }
  if (earliest && earliest > data.start) lead += `历史数据还在积累：最早的用量记录是 ${md(earliest)}，之后会随运行自动补全。`;

  return (
    <div id={COVERAGE_ID} className="jy-analytics-anchor">
      <Panel title="覆盖说明" caption="上游用量记录是否齐全">
        <p className="jy-analytics-lead">{lead}</p>
        <dl className="jy-kv">
          <dt>所选范围</dt>
          <dd>
            {md(data.start)} 至 {md(data.end)}，共 {days} 天
          </dd>
          <dt>最早的用量记录</dt>
          <dd>{earliest ? md(earliest) : "暂无"}</dd>
          <dt>缺失日期</dt>
          <dd>{nMissing ? `${runsText(dv.missingDates, 6)}，共 ${nMissing} 天` : "无"}</dd>
          <dt>部分缺失日期</dt>
          <dd>{nPartial ? `${runsText(dv.partialDates, 6)}，共 ${nPartial} 天` : "无"}</dd>
        </dl>
        {dv.allGaps.length > 0 && (
          <div className="jy-table-scroll jy-analytics-gaps">
            <table className="jy-data jy-data--compact jy-num">
              <caption className="sr-only">记录不全的资源</caption>
              <thead>
                <tr>
                  <th scope="col">资源</th>
                  <th scope="col" className="r">
                    有记录
                  </th>
                  <th scope="col" className="r">
                    缺
                  </th>
                  <th scope="col">最早记录</th>
                </tr>
              </thead>
              <tbody>
                {dv.allGaps.map((g) => {
                  const s = byId.get(g.stationId);
                  const tags = [
                    s?.isOwn ? "自营，不计入成本" : s?.includeInProfit === false ? "不计入利润" : "",
                    g.archivedAt || s?.archivedAt ? "已归档" : "",
                  ].filter(Boolean);
                  return (
                    <tr key={g.stationId}>
                      <td>
                        {g.stationName || s?.name || g.stationId}
                        {tags.length > 0 && <span className="jy-caption">（{tags.join("，")}）</span>}
                      </td>
                      <td className="r">{Number(g.availableDays) || 0} 天</td>
                      <td className="r">{Number(g.missingDays) || 0} 天</td>
                      <td>{g.earliestDate ? md(g.earliestDate) : "暂无"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
