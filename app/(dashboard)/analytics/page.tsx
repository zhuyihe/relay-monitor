"use client";
// 成本估算：利润等式 + 收入与上游成本趋势 + 成本构成 + 花费时段 + 可用天数 + 累计成本 + 没算进去的数据。
// 成本来自 /api/analytics（按上游汇总、按各上游的汇率换算），收入来自 /api/own/analytics（只能取近 7 / 30 天）。
// 日期都按业务时区（默认 Asia/Shanghai）划分，与服务端一致，不跟随浏览器时区。
// 时间范围和"包含已归档"写进地址栏；切换时保留上一份数据并变淡，避免整页闪成骨架。
// 只在本页出现的话都在同目录的 copy.ts 里；时间范围名、没设置售价、可用天数的说明、利润等式的说法从共用的地方取（design/ui-copy-spec.md §12）
import "../../styles/pages/analytics.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button, Checkbox } from "antd";
import { NAV_LABELS, STATION_TABS } from "../../../lib/brand";
import { api } from "../../../lib/client";
import { describeError } from "../../../lib/error-copy";
import { BALANCE_STATE_TEXT, basisText, EMPTY, formatDays, formatMoney, NO_UPSTREAM_TEXT, RANGE_TEXT, SELL_PRICE_UNSET } from "../../../lib/format";
import { etaWindowDays, runwayLevel, stationDisplayName, WATCH_DAYS } from "../../../lib/overview-actions";
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz } from "../../../lib/business-time";
import { UPSTREAM_FORM_TEXT } from "../../../lib/channel-onboarding";
import { workflowActionMeta } from "../../../lib/workflow-actions";
import { EmptyState, ErrorState, PanelSkeleton, RefreshFailedBanner, Skeleton } from "../../components/data-state";
import type { TipRow } from "../../components/float-tip";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Heatmap } from "../../components/heatmap";
import { Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { EQ_TEXT, ProfitEquation, incomeUnreadProps } from "../../components/profit-equation";
import type { EqTerm } from "../../components/profit-equation";
import { RangePicker } from "../../components/range-picker";
import { Runway, RunwayRulesNote, RUNWAY_TEXT } from "../../components/runway";
import type { RunwayItem } from "../../components/runway";
import { useShellPage } from "../../components/shell-context";
import { TREND_PANEL_TITLE, TrendPanel } from "../../components/trend-panel";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import { CumulativePanel } from "./cumulative-chart";
import { addDays, dayDiff, derive, deriveHeat, gapSummary, md, r2, runsText, validDay } from "./derive";
import type { Derived, OwnStatus } from "./derive";

type Heat = ReturnType<typeof deriveHeat>;
// 所选范围的花费时段画不出来时退回的近 7 天；heat 为 null 表示退回也失败了
// archived：取数时的归档条件，不一致的不拿来展示；hour：最近一次去取（成功或失败）时的整点，过了整点再取一次
type HeatFallback = { archived: boolean; hour: number; heat: Heat | null };

const PRESET_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
// 自营收入只能取近 7 / 30 天；更长的范围不取，不能拿 30 天收入与更长的成本一起算利润
const ownRangeOf = (d: number) => (d <= 7 ? "7d" : d <= 30 ? "30d" : null);
const fetchOwn = (range: string | null) => (range ? api(`/api/own/analytics?range=${range}`) : Promise.resolve(null));
const RANGE_OPTIONS = (["7d", "30d", "90d"] as const).map((value) => ({ value, label: RANGE_TEXT[value] }));
// 接口 days 上限 365：自定义开始日期最早到 364 天前
const MAX_DAYS = 365;
const POLL_MS = 30000;
const COVERAGE_ID = "analytics-coverage";
const REFRESH = workflowActionMeta("refresh")!.label;


type Snapshot = {
  data: any;
  own: any;
  ownStatus: OwnStatus;
  ownError: Error | null;
  // 这份数据对应的查询条件；与当前选择不一致时说明正在切换
  query: string;
  // 服务端按业务时区算出的天数
  days: number;
  includeArchived: boolean;
};

const coverageLink = (
  <a href={`#${COVERAGE_ID}`} className="jy-link">
    {COPY.coverageLink}
  </a>
);

export default function AnalyticsPage() {
  const [sp, setUrl] = useUrlParams();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  // 「今天」与日期选择器的可选范围要和服务端按同一个业务时区取：加载后用接口返回的 tz
  const tz: string = snap?.data?.tz || DEFAULT_BUSINESS_TIME_ZONE;
  const today = dayKeyInTz(Date.now(), tz);
  const minDate = addDays(today, -(MAX_DAYS - 1));
  const rawRange = sp.get("range") || "";
  const rawStart = sp.get("start");
  // 拿到业务时区之前按上海估算「今天」，可能与服务端差一天：开始日期前后各放宽一天，超出的由服务端收窄
  const customOk =
    rawRange === "custom" && validDay(rawStart) && rawStart >= addDays(minDate, -1) && rawStart <= addDays(today, 1);
  const rangeValue = customOk ? "custom" : PRESET_DAYS[rawRange] ? rawRange : "30d";
  // 请求条件：预设范围传天数，自定义范围传开始日期、天数由服务端按业务时区算；
  // 业务时区到达后本地「今天」变了，也还是同一个请求，不会多拉一次
  const query = customOk ? `start=${rawStart}` : `days=${PRESET_DAYS[rangeValue]}`;
  // 本地估算的天数，只用来预先挑自营收入的 7/30 天档；页面显示一律用服务端返回的 days
  const days = customOk ? Math.max(1, dayDiff(rawStart, today) + 1) : PRESET_DAYS[rangeValue];
  const guessRef = useRef(days);
  guessRef.current = days;
  const includeArchived = sp.get("archived") === "1";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  // 提醒天数和告警中心的提醒规则同一个（etaWindowDays，读不到时按 3 天）
  const [rules, setRules] = useState<any>(null);
  const critDays = etaWindowDays(rules);
  const [metaFailed, setMetaFailed] = useState(false);
  // 只采用最后一次发出的请求结果，避免快速切换范围时旧响应覆盖新范围
  const seq = useRef(0);

  // 返回这次加载的报错（成功或已被更新的请求取代时返回 null），顶栏刷新按钮原样往外抛，由外壳按码归类
  const load = useCallback(
    async (query: string): Promise<Error | null> => {
      const my = ++seq.current;
      const params = new URLSearchParams(query);
      if (includeArchived) params.set("includeArchived", "true");
      // 两个请求并行，自营收入的天数档先按本地估算的天数挑
      const guess = ownRangeOf(guessRef.current);
      let [a, o] = await Promise.allSettled([api(`/api/analytics?${params}`), fetchOwn(guess)]);
      if (my !== seq.current) return null;
      const d = a.status === "fulfilled" ? Number(a.value?.days) || guessRef.current : guessRef.current;
      // 服务端算出的天数跨了 7/30 天档（本地与业务时区差一天时）：按服务端天数补取一次自营收入
      if (a.status === "fulfilled" && ownRangeOf(d) !== guess) {
        [o] = await Promise.allSettled([fetchOwn(ownRangeOf(d))]);
        if (my !== seq.current) return null;
      }
      let error: Error | null = null;
      if (a.status === "rejected") {
        // 保留上一次成功的数据，页面顶部提示刷新失败
        error = a.reason;
        setLoadError(a.reason);
      } else {
        let ownStatus: OwnStatus = "not-applicable";
        let own: any = null;
        let ownError: Error | null = null;
        if (d <= 30) {
          if (o.status === "fulfilled") {
            own = o.value;
            ownStatus = "available";
          } else {
            // 没设置自营站点（接口带 OWN_STATION_UNSET）不算出错
            if (describeError(o.reason).category === "unset") ownStatus = "missing";
            else {
              ownStatus = "error";
              ownError = o.reason;
            }
          }
        }
        setSnap({ data: a.value, own, ownStatus, ownError, query, days: d, includeArchived });
        setAsOf(Date.now());
        setLoadError(null);
      }
      setLoading(false);
      return error;
    },
    [includeArchived],
  );

  // 首次 + 每 30 秒重新读一次；切换范围或归档开关立即重拉
  useEffect(() => {
    setLoading(true);
    load(query);
    const timer = setInterval(() => load(query), POLL_MS);
    return () => clearInterval(timer);
  }, [query, load]);

  useEffect(() => {
    api("/api/meta")
      .then((m) => setRules(m?.rules ?? null))
      .catch(() => setMetaFailed(true));
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    return load(query);
  }, [load, query]);

  const range = useMemo(
    () => (
      <RangePicker
        value={rangeValue}
        options={RANGE_OPTIONS}
        onChange={(v) => setUrl({ range: v === "30d" ? null : v, start: null })}
        custom={{
          // 数据回来后显示服务端实际采用的开始日期（超出范围的已被收窄）
          startDate: customOk ? (snap?.query === query && snap.data?.start) || rawStart : null,
          minDate,
          maxDate: today,
          onApply: (start) => setUrl({ range: "custom", start }),
        }}
      />
    ),
    [rangeValue, customOk, rawStart, snap, query, minDate, today, setUrl],
  );

  useShellPage({
    onRefresh: async () => {
      const error = await load(query);
      if (error) throw error;
    },
    asOf,
    range,
    tz: snap?.data?.tz,
  });

  const dv = useMemo(() => (snap ? derive(snap.data, snap.own) : null), [snap]);

  // 花费时段要求所选范围内每个上游每小时的余额记录都齐全；缺了某几天时退回近 7 天，
  // 不让整块空着。按小时取一次就够（热力图本身就是小时粒度）。
  const needHeat7 = !!dv && !dv.heat.available && dv.heat.reason === "incomplete-raw-history" && (snap?.days ?? 0) > 7;
  const hourKey = asOf ? Math.floor(asOf / 3600000) : 0;
  const [heat7, setHeat7] = useState<HeatFallback | null>(null);
  const heat7Fresh = heat7?.archived === includeArchived && heat7.hour === hourKey;
  useEffect(() => {
    // 同一条件、同一小时内已经取过就直接复用（来回切换范围不再重复请求）
    if (!needHeat7 || heat7Fresh) return;
    let alive = true;
    const archived = includeArchived;
    const hour = hourKey;
    const params = new URLSearchParams({ days: "7" });
    if (archived) params.set("includeArchived", "true");
    api(`/api/analytics?${params}`)
      .then((d) => alive && setHeat7({ archived, hour, heat: deriveHeat(d) }))
      // 整点刷新失败时保留同一归档条件的上一份（与主数据刷新失败时一致），下个整点再取
      .catch(() => alive && setHeat7((prev) => (prev?.archived === archived && prev.heat ? { ...prev, hour } : { archived, hour, heat: null })));
    return () => {
      alive = false;
    };
  }, [needHeat7, heat7Fresh, includeArchived, hourKey]);
  // 只是过了整点：新数据回来前继续显示上一份，不闪加载；归档条件变了才显示加载中，不拿另一种条件的数据顶替
  const heatFallback = needHeat7 && heat7?.archived === includeArchived ? heat7 : null;

  const archivedCount = Number(snap?.data?.selection?.archivedStationCount) || 0;
  const archiveToggle = (
    <Checkbox checked={includeArchived} onChange={(e) => setUrl({ archived: e.target.checked ? "1" : null })}>
      {COPY.archiveToggle}
      {includeArchived && snap?.includeArchived && archivedCount > 0 ? COPY.archivedCount(archivedCount) : ""}
    </Checkbox>
  );

  // 本页是估出来的数，按上游账单算的利润在每日利润页
  const sourceNote = (
    <div className="jy-banner jy-banner--info jy-analytics-source">
      <Sym kind="info" />
      <div className="jy-analytics-source-body">
        <b>{COPY.sourceTitle}</b>
        <p>{COPY.sourceBody}</p>
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
        <ProfitEquation title={COPY.eqTitle} extra={archiveToggle} loading revenue={{ value: null }} upstream={{ value: null }} fixed={{ value: null }} />
        <PanelSkeleton title={TREND_PANEL_TITLE.withRevenue} height={400} />
        <div className="jy-grid-2 jy-grid-even">
          <PanelSkeleton title={COPY.panel.mix} lines={5} />
          <PanelSkeleton title={COPY.panel.heat} height={180} />
        </div>
        <div className="jy-grid-2">
          <PanelSkeleton title={COPY.panel.runway} lines={4} />
          <PanelSkeleton title={COPY.panel.summary} lines={4} />
        </div>
      </div>
    );
  }

  // 没有任何数据，或刚切换的范围加载失败（旧数据对应别的范围，不能冒充）
  const stale = !!snap && (snap.query !== query || snap.includeArchived !== includeArchived);
  if (!snap || !dv || (stale && loadError && !loading)) {
    return (
      <div className="jy-page">
        <Panel title={COPY.eqTitle} extra={archiveToggle}>
          <ErrorState what={COPY.readFailed} error={loadError} onRetry={retry} center />
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
        <Panel title={COPY.eqTitle} extra={archiveToggle}>
          <EmptyState
            title={NO_UPSTREAM_TEXT}
            desc={includeArchived ? COPY.emptyDesc : `${COPY.emptyDesc}${COPY.emptyArchived}`}
            action={
              <Link href="/stations?edit=new" className="jy-link">
                {UPSTREAM_FORM_TEXT.create}
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const windowCaption = COPY.window(md(data.start, tz), data.end === today ? RANGE_TEXT.today : md(data.end, tz), data.days);
  const href30 = includeArchived ? "/analytics?archived=1" : "/analytics";

  return (
    <div className={`jy-page${loading && stale ? " jy-analytics-switching" : ""}`} aria-busy={(loading && stale) || undefined}>
      {loadError && <RefreshFailedBanner asOf={asOf} tz={tz} error={loadError} onRetry={retry} />}

      {sourceNote}

      <Equation dv={dv} snap={snap} caption={windowCaption} extra={archiveToggle} href30={href30} onRetry={retry} />

      <TrendPanel rows={dv.rows} showRev={dv.hasIncome} asOf={asOf} tz={tz} />

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

      <CumulativePanel rows={dv.rows} asOf={asOf} tz={tz} />

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
  if (past.length) out.push(COPY.gapPast(runsText(past, dv.tz), past.length));
  if (todayMissing) out.push(COPY.gapToday);
  if (dv.partialDates.length) out.push(COPY.gapPartial(out.length > 0, dv.partialDates.length, gapSummary(dv.upstreamGaps)));
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
  const upstream: EqTerm = {
    value: dv.usage,
    approx: dv.usageApprox,
    // 不完整时由 ProfitEquation 写「数据不完整」
    note: dv.usageApprox ? undefined : dv.monitoredCount ? EQ_TEXT.upstreamCount(dv.monitoredCount) : COPY.noUsageUpstream,
    href: "/stations",
  };
  const fixed: EqTerm = { value: dv.fixed, note: dv.fixedCount ? EQ_TEXT.fixedCount(dv.fixedCount) : EQ_TEXT.noFixed };
  const reasons = coverageReasons(dv);
  const ownName: string = snap.own?.station?.name || COPY.ownStation;

  if (dv.hasIncome) {
    // 没设置售价或兼容旧接口的逐日分配时，明确展示估算原因。
    const revReasons: string[] = [];
    if (dv.ownNoRate) revReasons.push(COPY.ownNoRate(ownName));
    if (dv.incomeEstimated) revReasons.push(COPY.revenueEstimated);
    if (dv.revenueSplit) revReasons.push(COPY.revenueSplit(dv.ownDays, dv.rows.length));
    const revNote = dv.ownNoRate ? SELL_PRICE_UNSET : dv.incomeEstimated ? COPY.revenueEstimatedNote : ownName;
    // 缺的是成本时利润一定偏高；只是收入估算时方向不定
    const tail = reasons.length ? (
      <>
        {COPY.costLowTail}
        {coverageLink}
      </>
    ) : (
      COPY.revenueEstTail
    );
    return (
      <ProfitEquation
        title={COPY.eqTitle}
        caption={caption}
        extra={extra}
        revenue={{ value: dv.revenue, approx: dv.revenueApprox, note: revNote, href: "/my" }}
        upstream={upstream}
        fixed={fixed}
        reasons={[...revReasons, ...reasons]}
        partialTail={
          revReasons.length ? (
            tail
          ) : (
            <>
              {EQ_TEXT.profitLowTail}
              {coverageLink}
            </>
          )
        }
      />
    );
  }

  // 收入算不出来：说明原因和下一步，成本照常算。没设置自营站点时用 ProfitEquation 默认的说法
  let revenueEmpty: string | undefined;
  let revenueNote: ReactNode;
  let profitNote: ReactNode;
  let notice: ReactNode;
  const retryBtn = (
    <Button size="small" onClick={onRetry} className="jy-eq-inline-btn">
      {REFRESH}
    </Button>
  );
  if (snap.ownStatus === "not-applicable") {
    revenueEmpty = COPY.longRangeEmpty;
    revenueNote = COPY.longRangeNote;
    profitNote = COPY.longRangeProfit;
    notice = (
      <>
        {COPY.longRangeNotice}
        <Link href={href30} className="jy-link" scroll={false}>
          {COPY.switchTo(RANGE_TEXT["30d"])}
        </Link>
      </>
    );
  } else if (snap.ownStatus === "error" || dv.incomeError) {
    // 读不到自营站点，或连上了但算收入时报错（接口给 { error, errorCode }）：和运营总览、自营业务同一个说法
    const unread = incomeUnreadProps(snap.ownStatus === "error" ? snap.ownError : dv.incomeError, onRetry);
    revenueEmpty = unread.revenueEmpty;
    revenueNote = ownName;
    profitNote = unread.profitNote;
    notice = unread.notice;
  } else if (snap.ownStatus !== "missing") {
    // 自营站点读到了，但收入没法按天分：原因由 derive 给（incomeIssue 是整句）
    revenueEmpty = COPY.incomeUnsplitEmpty;
    revenueNote = ownName;
    profitNote = COPY.incomeUnsplitProfit;
    notice = (
      <>
        {`${COPY.incomeUnsplit}：${dv.incomeIssue || COPY.incomeUnknown}`}
        {retryBtn}
      </>
    );
  }

  return (
    <ProfitEquation
      title={COPY.eqTitle}
      caption={caption}
      extra={extra}
      unconfigured
      revenue={{ value: null, note: revenueNote, href: "/my" }}
      revenueEmpty={revenueEmpty}
      upstream={upstream}
      fixed={fixed}
      profitNote={profitNote}
      notice={notice}
      reasons={reasons}
      partialTail={
        <>
          {EQ_TEXT.costPartialTail}
          {coverageLink}
        </>
      }
    />
  );
}

// ---- 成本构成 ------------------------------------------------------------------

function MixPanel({ dv }: { dv: Derived }) {
  const items: HBarItem[] = dv.mix.map((m) => {
    const name = m.archived ? `${m.name}${COPY.archivedSuffix}` : m.name;
    if (m.unknown) {
      // 所选时间内一条用量记录都没有：画斜纹空条，不当作 0
      return { key: m.id, name, value: null, note: m.fixed > 0 ? COPY.noRecordFixed(formatMoney(m.fixed)) : COPY.noRecord };
    }
    const tip: [ReactNode, ReactNode][] = [
      ["上游成本", formatMoney(m.usage, { approx: m.missingDays > 0 })],
      ["固定成本", formatMoney(m.fixed)],
    ];
    if (m.missingDays > 0) tip.push([COPY.usageRecord, COPY.missingDays(m.missingDays)]);
    return { key: m.id, name, value: r2(m.usage + m.fixed), tipExtra: tip };
  });
  return (
    <Panel title={COPY.panel.mix} caption={COPY.mixCaption}>
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName={COPY.mixUnit}
        total={items.length ? { label: COPY.total, value: formatMoney(r2(dv.usage + dv.fixed), { approx: dv.usageApprox }) } : undefined}
        empty={
          <>
            {COPY.mixEmpty}
            <Link href="/stations" className="jy-link">
              {STATION_TABS.list}
            </Link>
          </>
        }
      />
    </Panel>
  );
}

// ---- 花费时段 ------------------------------------------------------------------

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
  const week = RANGE_TEXT["7d"];
  const keepLink = (
    <Link href="/settings" className="jy-link">
      {COPY.keepSetting}
    </Link>
  );
  let caption = COPY.heatCaption("");
  let body: ReactNode;
  if (heat.available && !heat.empty) {
    body = <Heatmap grid={heat.grid} valueLabel={COPY.heatValue} peakNote={COPY.heatPeak(days)} />;
  } else if (heat.available) {
    body = <EmptyState title={COPY.heatEmptyTitle("这段时间")} desc={COPY.heatEmptyDesc} />;
  } else if (heat.reason === "range-not-supported") {
    body = (
      <EmptyState
        title={COPY.heatLongTitle}
        desc={COPY.heatLongDesc}
        action={
          <Link href={href30} className="jy-link" scroll={false}>
            {COPY.switchTo(RANGE_TEXT["30d"])}
          </Link>
        }
      />
    );
  } else if (heat.reason === "no-cost-stations") {
    body = (
      <EmptyState
        title={COPY.heatNoCostTitle}
        desc={COPY.heatNoCostDesc}
        action={
          <Link href="/stations" className="jy-link">
            {STATION_TABS.list}
          </Link>
        }
      />
    );
  } else if (fallbackLoading) {
    body = <Skeleton height={180} />;
  } else if (fb) {
    // 退回近 7 天：说明为什么不是所选范围，缺记录的上游点名
    caption = COPY.heatCaption(week);
    body = (
      <>
        <p className="jy-caption jy-analytics-heat-note">
          {COPY.heatFallback(days, gapSummary(heat.gaps), week)}
          {keepLink}
        </p>
        {fb.empty ? (
          <EmptyState title={COPY.heatEmptyTitle(week)} desc={COPY.heatEmptyDesc} />
        ) : (
          <Heatmap grid={fb.grid} valueLabel={COPY.heatValue} peakNote={COPY.heatPeakRange(week)} />
        )}
      </>
    );
  } else {
    body = (
      <EmptyState
        title={COPY.heatShortTitle}
        desc={COPY.heatShortDesc(gapSummary(heat.gaps))}
        action={
          <>
            {/* 近 7 天也画不出来时不再引导切换 */}
            {days > 7 && !fallback?.heat && <Button onClick={onShorter}>{COPY.switchTo(week)}</Button>}
            {keepLink}
          </>
        }
      />
    );
  }
  return (
    <Panel title={COPY.panel.heat} caption={caption}>
      {body}
    </Panel>
  );
}

// ---- 可用天数 ------------------------------------------------------------------

function RunwayPanel({ dv, critDays, metaFailed }: { dv: Derived; critDays: number; metaFailed: boolean }) {
  const items: RunwayItem[] = dv.runway.map((s) => {
    // 分档和上游列表、运营总览同一套（runwayLevel）
    const level = runwayLevel(s.days, { etaDays: critDays }) ?? "muted";
    const state = level === "crit" || level === "warn" ? BALANCE_STATE_TEXT.soon : undefined;
    const suffix = s.archived ? COPY.archivedSuffix : "";
    const burn = Number.isFinite(s.burnCny) ? formatMoney(s.burnCny) : EMPTY;
    const tip: TipRow[] = [
      [RUNWAY_TEXT.tip.burn, burn],
      [RUNWAY_TEXT.tip.days, formatDays(s.days)],
    ];
    // 和运营总览一样：算得出天数时才说怎么估的
    if (s.basis && Number.isFinite(s.days) && s.days > 0) tip.push([RUNWAY_TEXT.tip.basis, basisText(s.basis)]);
    return { key: s.id, name: `${s.name}${suffix}`, sub: RUNWAY_TEXT.burn(burn), days: s.days, level, state, tip };
  });
  const foot = items.length ? (
    <>
      {metaFailed && RUNWAY_TEXT.rulesUnread(critDays)}
      <RunwayRulesNote critDays={critDays} warnDays={WATCH_DAYS} />
    </>
  ) : undefined;
  return (
    <Panel title={COPY.panel.runway} caption={COPY.runwayCaption} foot={foot} body={items.length ? false : true}>
      {items.length ? (
        <div className="jy-analytics-runway">
          <Runway items={items} critDays={critDays} warnDays={WATCH_DAYS} />
        </div>
      ) : (
        <EmptyState
          title={COPY.runwayEmptyTitle}
          desc={COPY.runwayEmptyDesc}
          action={
            <Link href="/stations" className="jy-link">
              {STATION_TABS.list}
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
    <Panel title={COPY.panel.summary} caption={COPY.summaryCaption}>
      <dl className="jy-kv jy-num">
        <dt>{COPY.totalCost}</dt>
        <dd>
          {formatMoney(kpi.total, { approx })}
          {kpi.coveredDays < days && <div className="jy-caption">{COPY.coveredOnly(kpi.coveredDays)}</div>}
        </dd>
        <dt>{COPY.avgCost}</dt>
        <dd>
          {none ? EMPTY : formatMoney(kpi.avg, { approx: dv.partialDates.length > 0 })}
          <div className="jy-caption">{none ? COPY.noRecord : COPY.avgBasis(kpi.coveredDays)}</div>
        </dd>
        <dt>{COPY.peakDay}</dt>
        <dd>
          {kpi.peak ? (
            <>
              {formatMoney(kpi.peak.cost)}
              <div className="jy-caption">{kpi.peak.today ? RANGE_TEXT.today : md(kpi.peak.date, dv.tz)}</div>
            </>
          ) : (
            EMPTY
          )}
        </dd>
        <dt>{COPY.monthly}</dt>
        <dd>
          {none ? EMPTY : formatMoney(kpi.monthly, { approx: dv.partialDates.length > 0 })}
          {!none && <div className="jy-caption">{COPY.monthlyBasis(kpi.coveredDays)}</div>}
        </dd>
      </dl>
    </Panel>
  );
}

// ---- 没算进去的数据 ------------------------------------------------------------

function CoveragePanel({ dv, data, stations }: { dv: Derived; data: any; stations: any[] }) {
  const days = dv.rows.length;
  const nMissing = dv.missingDates.length;
  const nPartial = dv.partialDates.length;
  const earliest: string | null = dv.coverage?.earliestDate || null;
  const byId = new Map(stations.map((s) => [s.id, s]));
  const tz = dv.tz;

  let lead: string;
  if (dv.monitoredCount === 0) {
    lead = COPY.leadNoUsage;
  } else if (!nMissing && !nPartial) {
    lead = COPY.leadFull(days, dv.monitoredCount);
  } else {
    const parts = [COPY.leadFullDays(days - nMissing - nPartial)];
    if (nPartial) parts.push(COPY.leadPartialDays(nPartial));
    if (nMissing) parts.push(COPY.leadMissingDays(nMissing));
    lead = COPY.leadParts(days, parts.join("，"));
  }
  if (earliest && earliest > data.start) lead += COPY.leadEarliest(md(earliest, tz));

  return (
    <div id={COVERAGE_ID} className="jy-analytics-anchor">
      <Panel title={COPY.panel.coverage} caption={COPY.coverageCaption}>
        <p className="jy-analytics-lead">{lead}</p>
        <dl className="jy-kv">
          <dt>{COPY.kvRange}</dt>
          <dd>{COPY.window(md(data.start, tz), md(data.end, tz), days)}</dd>
          <dt>{COPY.kvEarliest}</dt>
          <dd>{earliest ? md(earliest, tz) : COPY.notYet}</dd>
          <dt>{COPY.kvMissing}</dt>
          <dd>{nMissing ? COPY.daysOf(runsText(dv.missingDates, tz, 6), nMissing) : COPY.none}</dd>
          <dt>{COPY.kvPartial}</dt>
          <dd>{nPartial ? COPY.daysOf(runsText(dv.partialDates, tz, 6), nPartial) : COPY.none}</dd>
        </dl>
        {dv.allGaps.length > 0 && (
          <div className="jy-table-scroll jy-analytics-gaps">
            <table className="jy-data jy-data--compact jy-num">
              <caption className="sr-only">{COPY.gapTable}</caption>
              <thead>
                <tr>
                  <th scope="col">{COPY.colStation}</th>
                  <th scope="col" className="r">
                    {COPY.colHave}
                  </th>
                  <th scope="col" className="r">
                    {COPY.colMissing}
                  </th>
                  <th scope="col">{COPY.colEarliest}</th>
                </tr>
              </thead>
              <tbody>
                {dv.allGaps.map((g) => {
                  const s = byId.get(g.stationId);
                  const tags = [
                    s?.isOwn
                      ? COPY.tagOwn
                      : s?.includeInProfit === false
                        ? COPY.tagNoProfit
                        : s?.costBasis === "fixed"
                          ? COPY.tagFixed
                          : "",
                    g.archivedAt || s?.archivedAt ? COPY.tagArchived : "",
                  ].filter(Boolean);
                  return (
                    <tr key={g.stationId}>
                      <td>
                        {stationDisplayName({ name: g.stationName || s?.name })}
                        {tags.length > 0 && <span className="jy-caption">（{tags.join("，")}）</span>}
                      </td>
                      <td className="r">{COPY.dayCount(Number(g.availableDays) || 0)}</td>
                      <td className="r">{COPY.dayCount(Number(g.missingDays) || 0)}</td>
                      <td>{g.earliestDate ? md(g.earliestDate, tz) : COPY.notYet}</td>
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
