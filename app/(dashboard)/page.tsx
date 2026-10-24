"use client";
// 运营总览：利润等式 + 需处理 + 上游余量 + 收入 / 上游成本排行。
// 利润口径与「自营业务」一致（/api/own/analytics 的 profit：毛利 = 收入 − 上游成本，净利 = 毛利 − 固定成本）；
// 没设置自营站点时，成本退回 /api/analytics 统计。时间范围按接口返回的业务时区显示。
// 需处理、上游余量来自 /api/stations：需处理和侧栏的计数共用 buildOverviewActions，余量的档位和上游列表共用 balanceViewOf。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Grid } from "antd";
import { api } from "../../lib/client";
import { STATION_TABS } from "../../lib/brand";
import type { WorkflowAction } from "../../lib/client";
import { attentionStationIds, balanceDaysText, balanceViewOf, buildOverviewActions, burnCellText, burnText, etaWindowDays, isSpending, lowLineOf, stationDisplayName } from "../../lib/overview-actions";
import { balanceMoneyOf, countsInProfit, profitApproxOf, rateSnapshotOf, splitProfitWarnings } from "../../lib/profit";
import { workflowActionMeta } from "../../lib/workflow-actions";
import { asSentence, describeError, errorText, failureText, refreshAllText, refreshOneText } from "../../lib/error-copy";
import { BALANCE_STATE_TEXT, basisText, COST_MODE_TEXT, EMPTY, formatAsOf, formatDays, formatMoney, formatSinceToday, formatZonedDate, INCOME_UNREAD, OWN_STATION_UNSET_HINT, OWN_STATION_UNSET_TITLE, RANGE_TEXT, refreshFailedText, SELL_PRICE_UNSET, soonText } from "../../lib/format";
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, dayStartInTz, shiftDayLabel } from "../../lib/business-time";
import { UPSTREAM_FORM_TEXT } from "../../lib/channel-onboarding";
import { AttentionList } from "../components/attention-list";
import { Sym } from "../components/icons";
import { More } from "../components/more";
import type { AttentionItem } from "../components/attention-list";
import { EmptyState, ErrorState, PanelSkeleton } from "../components/data-state";
import type { TipRow } from "../components/float-tip";
import { HBars } from "../components/hbars";
import type { HBarItem } from "../components/hbars";
import { CountBadge, Panel } from "../components/panel";
import { EQ_TEXT, ProfitEquation, incomeUnreadProps } from "../components/profit-equation";
import type { EqTerm } from "../components/profit-equation";
import { RangePicker } from "../components/range-picker";
import { compareRunwayItems, Runway, RUNWAY_TEXT, RunwayRulesNote } from "../components/runway";
import type { RunwayItem } from "../components/runway";
import { useShellPage } from "../components/shell-context";
import { useUrlState } from "../components/use-url-state";
import { useWorkflowActions } from "../components/use-workflow-actions";
import { actionPhrase, workflowDetail, workflowOwner, workflowProblem } from "../components/workflow-copy";
import TrendModal, { TREND_TEXT } from "./trend-modal";
import "../styles/pages/overview.css";

const RANGES = ["today", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: RANGE_TEXT[value] }));
const RANGE_DAYS: Record<Range, number> = { today: 1, "7d": 7, "30d": 30 };

const RUNWAY_LIMIT = 8;
// 「收入和上游成本」那块每小段列前 3，多的并成「其他 N 位用户」「其他 N 个上游」一行（ui-design-spec §5.1）
const TOP_N = 3;
// 需处理露几条按利润等式那块的高度定（ui-design-spec §1.4 第 3 条、§5.1）：1440 宽时等式旁边放得下 2 条，
// 其余收进「还有 N 件」。G 把「≈」说明收成一行、等式变矮以后，按同一条规矩再调
const ATTENTION_SHOWN = 2;
const REFRESH = workflowActionMeta("refresh")!.label;

// 运营总览独有的话，只在这一处写；用语按 design/ui-copy-spec.md
const COPY = Object.freeze({
  business: EQ_TEXT.business,
  // 「今天收入和上游成本」一块，上下两小段（ui-copy-spec §11、ui-design-spec §5.1）
  money: (range: string) => `${range}收入和上游成本`,
  moneyMore: "按用户、按上游看",
  readBusinessFailed: "读不到经营数据",
  profitFailed: EQ_TEXT.profitFailed,
  costFailed: "成本暂时算不出",
  readFailed: (what: string) => `读不到${what}`,
  upstreamCount: EQ_TEXT.upstreamCount,
  fixedCount: EQ_TEXT.fixedCount,
  noFixed: EQ_TEXT.noFixed,
  gapReason: (name: string, days: number) => `${name} 缺 ${days} 天的花费记录。`,
  gapTip: (days: number) => `${days} 天没有花费记录`,
  costPartialTail: EQ_TEXT.costPartialTail,
  profitPartialTail: EQ_TEXT.profitPartialTail,
  fromUsers: (n: number) => `来自 ${n} 位用户`,
  workflowUnreadable: "读不到上游账单和每日利润里需处理的事。",
  attention: "需处理",
  attentionOrder: "最要紧的在前",
  refreshAttention: `${REFRESH}需处理的事`,
  refreshOne: (name: string) => `${REFRESH} ${name}`,
  refreshFailed: `${REFRESH}失败`,
  edit: "编辑",
  editOne: (name: string) => `编辑 ${name}`,
  trend: TREND_TEXT.title,
  trendOf: TREND_TEXT.of,
  others: (n: number) => `另有 ${n} 项：`,
  moreItems: (n: number) => `还有 ${n} 件`,
  healthy: (n: number) => `其余 ${n} 个上游没有要处理的事`,
  balance: (text: string) => `余额 ${text}`,
  lowLine: (text: string) => `余额提醒线 ${text}`,
  available: (days: string) => `可用${days}`,
  burnSentence: (balance: string, burn: string, basis: string) => `余额 ${balance}，日均花费 ${burn}，${basis}。`,
  expiresIn: (n: number) => `${n} 天后到期`,
  fixedSentence: (date: string) => `最近一笔 ${date}到期。要续上，再记一笔固定成本；不再续费可以在编辑里标记。`,
  runway: "上游余量",
  runwayEmptyTitle: "还没有按余额计费的上游",
  runwayEmptyDesc: "加上上游后，这里显示每个上游还能用多少天。",
  balanceTotal: "余额合计",
  excludesUnreadable: (n: number) => `，不含 ${n} 个读不到余额的上游`,
  runwayLimit: (n: number) => `这里只列最要紧的 ${n} 个。`,
  noRenewal: "不再续费",
  tip: Object.freeze({ ...RUNWAY_TEXT.tip, requests: "请求数", how: "怎么算的", note: "说明" }),
  byUser: "按用户",
  byUpstream: "按上游",
  unnamedUser: "未命名用户",
  otherUsers: (n: number) => `其他 ${n} 位用户`,
  otherUpstreams: (n: number) => `其他 ${n} 个上游`,
  resold: "转售 Key",
  total: "合计",
  incomeUnit: "收入",
  costUnit: "上游成本",
  noIncome: "这段时间还没有用户产生收入。",
  noCost: "这段时间按用量计费的上游没有产生成本。",
});

const r2 = (v: number) => Math.round(v * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// 余额的写法和上游列表同一处（balanceMoneyOf）：设了汇率写「$12.30（约 ¥88.56）」，没设按 1:1 写「¥12.30（没设置汇率）」
const balanceText = (s: any, v: number) => balanceMoneyOf(s, v).text;
const balanceWithCny = (s: any, v: number) => balanceMoneyOf(s, v).full;

// 利润等式标题下的时间说明（§6）：今天写「0:00–14:30」，近 7 天写「10月14日–今天」。
// 按业务时区（接口返回的 tz）划日，与浏览器所在时区无关
function rangeCaption(range: Range, data: any): string {
  const tz = data?.tz || DEFAULT_BUSINESS_TIME_ZONE;
  // 写到数据自己的结束时间：刷新失败时数字停在上次读到的那一刻，这里也停在那一刻；接口没给时按现在
  const now = Number(data?.endMs) || Date.parse(data?.generatedAt ?? "") || Date.now();
  const startLabel = data?.start || shiftDayLabel(dayKeyInTz(now, tz), -(RANGE_DAYS[range] - 1));
  return formatSinceToday(data?.startMs ?? dayStartInTz(startLabel, tz), tz, now);
}

type Money =
  | { range: Range; unconfigured: false; own: any; fallback: null }
  | { range: Range; unconfigured: true; own: null; fallback: any };

export default function OverviewPage() {
  // 手机上需处理放在利润等式前面（ui-design-spec §5.1）：按 DOM 先后排，读屏和键盘也先到需处理
  const compact = Grid.useBreakpoint().md === false;
  const { message } = App.useApp();
  const router = useRouter();
  const [range, setRange] = useUrlState<Range>("range", "today", RANGES);

  const [rules, setRules] = useState<any>({});
  const [settings, setSettings] = useState<any>({ refreshIntervalSec: 60, lowBalanceUsd: 5 });
  const [stations, setStations] = useState<any[] | null>(null);
  const [stationsErr, setStationsErr] = useState<Error | null>(null);
  const [stationsAt, setStationsAt] = useState<number | null>(null);
  const [stationsTz, setStationsTz] = useState<string | null>(null);
  const [money, setMoney] = useState<Money | null>(null);
  const [moneyErr, setMoneyErr] = useState<Error | null>(null);
  const [moneyAt, setMoneyAt] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [trendStation, setTrendStation] = useState<any>(null);
  // 上游账单与每日利润产生的需处理事项：与侧栏计数、上游资源页共用一份
  const { actions: workflowActions, failed: workflowFailed, staleAsOf: workflowAsOf, loading: workflowLoading, reload: reloadWorkflowActions } = useWorkflowActions();
  const rangeRef = useRef(range);
  rangeRef.current = range;

  // 两个加载函数都返回报错（成功返回 null），顶栏刷新据此提示
  const loadStations = useCallback(async (): Promise<Error | null> => {
    try {
      const r = await api("/api/stations");
      setStations(Array.isArray(r?.stations) ? r.stations : []);
      if (r?.settings) setSettings(r.settings);
      if (r?.tz) setStationsTz(r.tz);
      setStationsErr(null);
      setStationsAt(Date.now());
      return null;
    } catch (e: any) {
      setStationsErr(e);
      return e;
    }
  }, []);

  // 经营数据：优先自营站点口径；没标记自营站点时只统计成本
  const loadMoney = useCallback(async (r: Range): Promise<Error | null> => {
    try {
      // 窗口按服务端的业务时区划日，不传浏览器时区
      const own = await api(`/api/own/analytics?range=${r}`);
      if (rangeRef.current !== r) return null;
      setMoney({ range: r, unconfigured: false, own, fallback: null });
      setMoneyErr(null);
      setMoneyAt(Date.now());
      return null;
    } catch (e: any) {
      if (rangeRef.current !== r) return null;
      // 没设置自营站点（接口带 OWN_STATION_UNSET）时只统计成本
      if (describeError(e).category !== "unset") {
        setMoneyErr(e);
        return e;
      }
      try {
        const fallback = await api(`/api/analytics?days=${RANGE_DAYS[r]}&includeArchived=true`);
        if (rangeRef.current !== r) return null;
        setMoney({ range: r, unconfigured: true, own: null, fallback });
        setMoneyErr(null);
        setMoneyAt(Date.now());
        return null;
      } catch (e2: any) {
        if (rangeRef.current !== r) return null;
        setMoneyErr(e2);
        return e2;
      }
    }
  }, []);

  useEffect(() => {
    api("/api/meta")
      .then((m) => {
        setRules(m?.rules || {});
        if (m?.settings) setSettings(m.settings);
      })
      .catch(() => {});
  }, []);

  // 切换时间范围：清掉上一个范围的错误，立即重新拉取
  useEffect(() => {
    setMoneyErr(null);
    loadMoney(range);
  }, [range, loadMoney]);

  // 按系统设置的刷新间隔轮询（最短 30 秒）；标签页在后台时不拉，切回来立即拉一次
  const intervalSec = Math.max(30, Number(settings?.refreshIntervalSec) || 60);
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      loadStations();
      loadMoney(rangeRef.current);
    };
    loadStations();
    const timer = setInterval(tick, intervalSec * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalSec, loadStations, loadMoney]);

  // 刷新全部上游后重新加载本页；重新加载失败时抛错由顶栏提示，有上游读不到余额时如实说明
  const onRefresh = async () => {
    const r = await api("/api/refresh", { method: "POST", body: {} });
    const [stationsLoadErr, moneyLoadErr] = await Promise.all([loadStations(), loadMoney(rangeRef.current), reloadWorkflowActions()]);
    const err = stationsLoadErr || moneyLoadErr;
    if (err) throw err;
    const done = refreshAllText(r?.stations);
    if (done.failed) message.warning(done.text);
    else message.success(done.text);
  };

  const refreshOne = async (s: any) => {
    setSyncingId(s.id);
    try {
      const r = await api(`/api/stations/${s.id}/refresh`, { method: "POST", body: {} });
      await loadStations();
      const done = refreshOneText(stationDisplayName(s), r?.balance);
      if (done.ok) message.success(done.text);
      else message.warning(done.text);
    } catch (e: any) {
      message.error(failureText(COPY.refreshFailed, e));
    } finally {
      setSyncingId(null);
    }
  };

  const rangePicker = useMemo(
    () => <RangePicker value={range} options={RANGE_OPTIONS} onChange={(v) => setRange(v as Range)} />,
    [range, setRange],
  );
  const asOfs = [stationsAt, moneyAt].filter((t): t is number => t != null);
  useShellPage({
    onRefresh,
    asOf: asOfs.length ? Math.min(...asOfs) : null,
    range: rangePicker,
    tz: money?.own?.tz || money?.fallback?.tz || stationsTz || undefined,
  });

  const businessTz = money?.own?.tz || money?.fallback?.tz || stationsTz || DEFAULT_BUSINESS_TIME_ZONE;
  const workflowError = !workflowFailed
    ? ""
    : workflowAsOf
      ? refreshFailedText(workflowAsOf, businessTz)
      : COPY.workflowUnreadable;
  const current = money && money.range === range ? money : null;
  const rangeName = RANGE_TEXT[range];

  const attention = (
    <AttentionPanel
      stations={stations}
      error={stationsErr}
      rules={rules}
      settings={settings}
      workflowActions={workflowActions}
      workflowError={workflowError}
      workflowLoading={workflowLoading}
      onReloadWorkflow={() => void reloadWorkflowActions()}
      tz={businessTz}
      asOf={stationsAt}
      syncingId={syncingId}
      onRetry={loadStations}
      onSync={refreshOne}
      onEdit={(s) => router.push(`/stations?edit=${encodeURIComponent(s.id)}`)}
      onTrend={setTrendStation}
    />
  );

  return (
    <div className="jy-page">
      {/* 两行都是 8 + 4（ui-design-spec §5.1）：利润等式 + 需处理；上游余量 + 收入和上游成本。手机上需处理在最前 */}
      {compact ? attention : null}
      <div className="jy-grid-8-4">
        <Equation range={range} money={current} error={moneyErr} onRetry={() => loadMoney(range)} />
        {compact ? null : attention}
      </div>

      <div className="jy-grid-8-4">
        <RunwayPanel
          stations={stations}
          error={stationsErr}
          settings={settings}
          rules={rules}
          onRetry={loadStations}
          onTrend={setTrendStation}
        />
        <MoneyPanel title={COPY.money(rangeName)} money={current} error={moneyErr} onRetry={() => loadMoney(range)} compact={compact} />
      </div>

      <TrendModal station={trendStation} onClose={() => setTrendStation(null)} settings={settings} rules={rules} tz={businessTz} />
    </div>
  );
}

// ---- 利润等式 ---------------------------------------------------------------

function Equation({ range, money, error, onRetry }: { range: Range; money: Money | null; error: Error | null; onRetry: () => void }) {
  const title = COPY.business(RANGE_TEXT[range]);
  if (error && !money) {
    return (
      <Panel title={title}>
        <ErrorState what={COPY.readBusinessFailed} error={error} onRetry={onRetry} />
      </Panel>
    );
  }
  const caption = rangeCaption(range, money?.own || money?.fallback);
  if (!money) {
    const blank: EqTerm = { value: null };
    return <ProfitEquation title={title} caption={caption} revenue={blank} upstream={blank} fixed={blank} loading />;
  }

  if (money.unconfigured) {
    const fb = money.fallback || {};
    // 算进利润的上游和成本估算同一个判断（countsInProfit：不含自营站点）
    const list: any[] = (fb.stations || []).filter(countsInProfit);
    // 和利润的算法一致：记了固定成本的上游只按天平摊（costBasis = fixed），余额下降不算上游成本
    const usageList = list.filter((s) => s.costBasis !== "fixed");
    const fixedList = list.filter((s) => s.fixedCny > 0);
    const usageIds = new Set(usageList.map((s) => s.id));
    const gaps: any[] = (fb.coverage?.stationGaps || []).filter((g: any) => usageIds.has(g.stationId) && Number(g.missingDays) > 0);
    return (
      <ProfitEquation
        title={title}
        caption={caption}
        unconfigured
        revenue={{ value: null }}
        upstream={{
          value: r2(sum(usageList.map((s) => Number(s.totalCny) || 0))),
          approx: gaps.length > 0,
          note: COPY.upstreamCount(usageList.length),
          href: "/analytics",
        }}
        fixed={{
          value: r2(sum(fixedList.map((s) => Number(s.fixedCny) || 0))),
          note: fixedList.length ? COPY.fixedCount(fixedList.length) : COPY.noFixed,
          href: "/stations",
        }}
        reasons={gaps.map((g) => COPY.gapReason(g.stationName, g.missingDays))}
        partialTail={COPY.costPartialTail}
      />
    );
  }

  const own = money.own || {};
  const profit = own.profit || {};
  if (profit.error) {
    return (
      <Panel title={title} caption={caption}>
        <ErrorState what={COPY.profitFailed} error={profit} onRetry={onRetry} />
      </Panel>
    );
  }
  const costs: any[] = profit.costs || [];
  const usageCosts = costs.filter((c) => c.mode !== "fixed");
  const fixedCosts = costs.filter((c) => c.mode === "fixed");
  // 哪几项是估算的（加「≈」），和自营业务、日报同一个判断（lib/profit.js）
  const approx = profitApproxOf(profit, own.station);
  const users = (own.byUser || []).filter((u: any) => !u.isAdmin).length;
  // 只有估算和没设置汇率 / 售价会让数字不准；其余提示放到成本面板底部
  const { reasons } = splitProfitWarnings(profit);
  // 收入确认不了：收入、毛利、净利留空并说原因，两项成本照常（design/ui-copy-spec.md §8.1）
  const unread = profit.incomeUnconfirmed ? incomeUnreadProps(profit.incomeUnconfirmed, onRetry) : null;
  return (
    <ProfitEquation
      title={title}
      caption={caption}
      {...(unread || {})}
      revenue={{
        value: profit.incomeCny ?? null,
        approx: approx.income,
        note: unread ? own.station?.name : approx.income ? SELL_PRICE_UNSET : COPY.fromUsers(users),
        // 带上同一个时间范围，自营业务默认是近 7 天
        href: range === "7d" ? "/my" : `/my?range=${range}`,
      }}
      upstream={{
        value: profit.upstreamCostCny ?? r2(sum(usageCosts.map((c) => Number(c.cny) || 0))),
        approx: approx.upstream,
        note: COPY.upstreamCount(usageCosts.length),
        href: "/analytics",
      }}
      fixed={{
        value: profit.fixedCostCny ?? r2(sum(fixedCosts.map((c) => Number(c.cny) || 0))),
        note: fixedCosts.length ? COPY.fixedCount(fixedCosts.length) : COPY.noFixed,
        href: "/stations",
      }}
      gross={profit.grossProfitCny}
      net={profit.netProfitCny ?? profit.profitCny}
      reasons={reasons}
      partialTail={COPY.profitPartialTail}
    />
  );
}

// ---- 需处理 -----------------------------------------------------------------

function AttentionPanel({
  stations,
  error,
  rules,
  settings,
  workflowActions,
  workflowError,
  workflowLoading,
  onReloadWorkflow,
  tz,
  asOf,
  syncingId,
  onRetry,
  onSync,
  onEdit,
  onTrend,
}: {
  stations: any[] | null;
  error: Error | null;
  rules: any;
  settings: any;
  workflowActions: WorkflowAction[];
  workflowError: string;
  workflowLoading: boolean;
  onReloadWorkflow: () => void;
  tz: string;
  asOf: number | null;
  syncingId: string | null;
  onRetry: () => void;
  onSync: (s: any) => void;
  onEdit: (s: any) => void;
  onTrend: (s: any) => void;
}) {
  const actions = useMemo(
    () =>
      buildOverviewActions(stations || [], {
        tz,
        rules,
        settings,
        workflowActions,
        limit: ATTENTION_SHOWN,
      }),
    [stations, tz, rules, settings, workflowActions],
  );
  const router = useRouter();
  const extra = (
    <>
      <span className="jy-caption">{COPY.attentionOrder}</span>
      <Button size="small" loading={workflowLoading} onClick={onReloadWorkflow} aria-label={COPY.refreshAttention}>
        {REFRESH}
      </Button>
    </>
  );
  if (!stations) {
    if (error) {
      return (
        <Panel title={COPY.attention}>
          <ErrorState what={COPY.readFailed(STATION_TABS.list)} error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={COPY.attention} lines={4} />;
  }

  // 每条的第一个操作是带边框的按钮，其余是链接样式（与设计稿一致）
  const btn = (label: string, onClick: () => void, extra: { loading?: boolean; primary?: boolean; aria: string }) => (
    <Button size="small" type={extra.primary ? "default" : "link"} loading={extra.loading} onClick={onClick} aria-label={extra.aria}>
      {label}
    </Button>
  );
  const names = new Map(stations.filter(Boolean).map((s) => [String(s.id), stationDisplayName(s)]));
  const nameOf = (id: string) => names.get(id);
  // 账号与账单待办是真实链接（可复制、可在新标签打开），普通点击在本站内跳转（不整页刷新），按钮名就是要做的动作
  const open = (a: any, primary = true) => (
    <Button
      size="small"
      type={primary ? "default" : "link"}
      href={a.href}
      aria-label={`${a.label}（${workflowOwner(a, nameOf)}）`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        router.push(a.href);
      }}
    >
      {a.label}
    </Button>
  );
  // 合并进同一行的其余事项：账号待办可以直接点开
  const noteOf = (a: any): ReactNode => {
    if (!a.others?.length) return undefined;
    return (
      <>
        {COPY.others(a.others.length)}
        {a.others.map((o: any, i: number) => (
          <Fragment key={o.id}>
            {i > 0 ? "、" : ""}
            {o.workflow ? (
              <Link href={o.href} className="jy-caption-link">
                {actionPhrase(o)}
              </Link>
            ) : (
              actionPhrase(o)
            )}
          </Fragment>
        ))}
      </>
    );
  };

  // 一条事项变成列表里的一行；收进「还有 N 件」的那些只在点开时才拼（RestAttention），需处理上百条时不白做
  const toItem = (a: any): AttentionItem => {
    if (a.workflow) {
      return {
        key: a.id,
        level: a.level,
        who: workflowOwner(a, nameOf),
        what: workflowProblem(a),
        desc: workflowDetail(a),
        note: noteOf(a),
        actions: open(a),
      };
    }
    const s = a.station;
    const name = a.stationName;
    const bal = Number(s.balance?.remaining) || 0;
    const eta = s.prediction?.etaDays;
    const sync = btn(REFRESH, () => onSync(s), { loading: syncingId === s.id, primary: true, aria: COPY.refreshOne(name) });
    const edit = (primary = false) => btn(COPY.edit, () => onEdit(s), { primary, aria: COPY.editOne(name) });
    const trend = btn(COPY.trend, () => onTrend(s), { primary: true, aria: COPY.trendOf(name) });
    let what: ReactNode;
    let desc: ReactNode;
    let buttons: ReactNode;
    switch (a.kind) {
      case "query-failed": {
        what = BALANCE_STATE_TEXT.unreadable;
        desc = asSentence(errorText(s.balance));
        buttons = (
          <>
            {sync}
            {edit()}
          </>
        );
        break;
      }
      case "balance-danger":
      case "balance-low": {
        const low = a.kind === "balance-low";
        what = low ? BALANCE_STATE_TEXT.low : BALANCE_STATE_TEXT.empty;
        const parts = [COPY.balance(balanceWithCny(s, bal))];
        if (low) parts.push(COPY.lowLine(balanceText(s, lowLineOf(s, settings))));
        if (low && eta != null && isSpending(s.prediction)) parts.push(COPY.available(formatDays(eta)));
        desc = `${parts.join("，")}。`;
        buttons = (
          <>
            {trend}
            {edit()}
          </>
        );
        break;
      }
      case "eta-soon": {
        what = soonText(a.etaDays);
        desc = COPY.burnSentence(balanceWithCny(s, bal), burnText(s, s.prediction) ?? EMPTY, basisText(s.prediction?.basis));
        buttons = (
          <>
            {trend}
            {edit()}
          </>
        );
        break;
      }
      default: {
        what = COPY.expiresIn(a.daysRemaining);
        desc = COPY.fixedSentence(formatZonedDate(a.endAt, tz));
        buttons = edit(true);
      }
    }
    return { key: a.id, level: a.level, who: name, what, desc, note: noteOf(a), actions: buttons };
  };

  const hidden = actions.all.length - actions.visible.length;
  // 每个资源最多一行待处理，剩下的就是状态正常的，用一句话交代其余资源
  const busy = attentionStationIds(actions.all);
  const healthy = stations.filter((s) => s && !s.isOwn && !busy.has(String(s.id || stationDisplayName(s)))).length;
  const healthyNote = healthy > 0 ? <span className="jy-caption">{COPY.healthy(healthy)}</span> : null;
  return (
    <Panel title={COPY.attention} badge={<CountBadge count={actions.all.length} />} extra={extra} body={false}>
      {workflowError ? (
        <div className="jy-banner jy-ov-banner" role="status">
          <Sym kind="warn" />
          <span className="jy-ov-banner-text">{workflowError}</span>
          <Button size="small" onClick={onReloadWorkflow}>
            {REFRESH}
          </Button>
        </div>
      ) : null}
      {/* 露最要紧的 3 条，其余收进「还有 N 件」（收起区 More，ui-design-spec §4.11、§5.1），点开在原地接着列 */}
      <AttentionList
        items={actions.visible.map(toItem)}
        emptyDesc={asOf ? `${formatAsOf(asOf, tz)}。` : undefined}
        more={
          hidden > 0 ? (
            <More label={COPY.moreItems(hidden)} className="jy-attention-rest">
              <RestAttention actions={actions.all.slice(actions.visible.length)} toItem={toItem} more={healthyNote ?? undefined} />
            </More>
          ) : (
            healthyNote ?? undefined
          )
        }
      />
    </Panel>
  );
}

// 「还有 N 件」点开以后的那几条：收起区只在点开时渲染它，拼列表项的活也到这时才做
function RestAttention({ actions, toItem, more }: { actions: any[]; toItem: (a: any) => AttentionItem; more?: ReactNode }) {
  return <AttentionList items={actions.map(toItem)} more={more} />;
}

// ---- 上游余量 ---------------------------------------------------------------

function RunwayPanel({
  stations,
  error,
  settings,
  rules,
  onRetry,
  onTrend,
}: {
  stations: any[] | null;
  error: Error | null;
  settings: any;
  rules: any;
  onRetry: () => void;
  onTrend: (s: any) => void;
}) {
  const router = useRouter();
  const critDays = etaWindowDays(rules);
  const allLink = (
    <Link className="jy-caption-link" href="/stations">
      {STATION_TABS.list}
    </Link>
  );
  const rows = useMemo(() => {
    const list = (stations || []).filter((s) => !s.isOwn && s.type !== "fixed" && !s.archivedAt);
    return list.map((s) => {
      // 档位、颜色、可用天数和上游列表同一个判断（balanceViewOf）
      const view = balanceViewOf(s, { settings, rules });
      const failed = view.state === "unreadable";
      const rate = rateSnapshotOf(s).cnyPerUsd;
      const p = s.prediction;
      const bal = s.balance?.ok ? Number(s.balance.remaining) : null;
      const name = stationDisplayName(s);
      const state = view.state ? BALANCE_STATE_TEXT[view.state] : undefined;

      let tip: TipRow[];
      if (failed) {
        tip = [[COPY.tip.reason, errorText(s.balance)]];
      } else {
        tip = [
          [COPY.tip.balance, bal == null ? BALANCE_STATE_TEXT.pending : balanceWithCny(s, bal)],
          [COPY.tip.burn, burnCellText(s, p)],
          [COPY.tip.days, balanceDaysText(view)],
        ];
        if (view.days != null && view.days !== Infinity && view.days > 0) tip.push([COPY.tip.basis, basisText(p?.basis)]);
      }
      if (s.noRenewal) tip.push([COPY.tip.renewal, COPY.noRenewal]);

      const item: RunwayItem = {
        key: String(s.id),
        name: (
          <button type="button" className="jy-ov-name" onClick={() => onTrend(s)} aria-label={COPY.trendOf(name)}>
            {name}
          </button>
        ),
        tipTitle: name,
        sub: bal == null ? undefined : `${balanceText(s, bal)}${s.noRenewal ? `，${COPY.noRenewal}` : ""}`,
        days: view.days,
        failed,
        level: view.level,
        state,
        // 余额用完时天数写「—」，只看档位名（和上游列表、余额趋势同一个写法）
        daysLabel: balanceDaysText(view),
        tip,
      };
      return { item, cny: bal == null || failed ? null : bal * rate };
    });
  }, [stations, settings, rules, onTrend]);

  if (!stations) {
    if (error) {
      return (
        <Panel title={COPY.runway} extra={allLink}>
          <ErrorState what={COPY.readFailed(STATION_TABS.list)} error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={COPY.runway} lines={5} />;
  }
  if (!rows.length) {
    return (
      <Panel title={COPY.runway} extra={allLink}>
        <EmptyState
          title={COPY.runwayEmptyTitle}
          desc={COPY.runwayEmptyDesc}
          action={
            <Button size="small" onClick={() => router.push("/stations?edit=new")}>
              {UPSTREAM_FORM_TEXT.create}
            </Button>
          }
        />
      </Panel>
    );
  }

  const sorted = [...rows].sort((a, b) => compareRunwayItems(a.item, b.item));
  const shown = sorted.slice(0, RUNWAY_LIMIT);
  const failedN = rows.filter((r) => r.item.failed).length;
  const total = sum(rows.map((r) => r.cny ?? 0));
  const sub = (
    <>
      {COPY.balanceTotal} <b className="jy-num">{formatMoney(total)}</b>
      {failedN > 0 && <span className="jy-caption">{COPY.excludesUnreadable(failedN)}</span>}
    </>
  );
  const foot = (
    <RunwayRulesNote critDays={critDays}>
      {rows.length > RUNWAY_LIMIT && COPY.runwayLimit(RUNWAY_LIMIT)}
    </RunwayRulesNote>
  );
  return (
    <Panel title={COPY.runway} extra={allLink} sub={sub} foot={foot} body={false}>
      <Runway items={shown.map((r) => r.item)} critDays={critDays} />
    </Panel>
  );
}

// ---- 收入 / 上游成本排行 ------------------------------------------------------

function MoneyPanelShell({
  title,
  caption,
  money,
  error,
  onRetry,
  children,
  foot,
}: {
  title: string;
  caption?: string;
  money: Money | null;
  error: Error | null;
  onRetry: () => void;
  children?: ReactNode;
  foot?: ReactNode;
}) {
  if (!money) {
    if (error) {
      return (
        <Panel title={title} caption={caption}>
          <ErrorState what={COPY.readFailed(title)} error={error} onRetry={onRetry} />
        </Panel>
      );
    }
    return <PanelSkeleton title={title} lines={5} />;
  }
  return (
    <Panel title={title} caption={caption} foot={foot}>
      {children}
    </Panel>
  );
}

// 收入那一小段：合计和按用户的条。收入没读到（读取失败、收入确认不了）时不拿用户消费去拼收入，说原因（§8.1）
function useRevenueView(money: Money | null, onRetry: () => void): { total: string | null; body: ReactNode } | null {
  const router = useRouter();
  return useMemo(() => {
    if (!money) return null;
    if (money.unconfigured) {
      return {
        total: null,
        body: (
          <div className="jy-empty-inline">
            <p style={{ margin: 0 }}>
              <strong>{OWN_STATION_UNSET_TITLE}</strong>：{OWN_STATION_UNSET_HINT}
            </p>
            <Button size="small" onClick={() => router.push("/stations")}>
              {workflowActionMeta("setup_own_station")!.label}
            </Button>
          </div>
        ),
      };
    }
    const own = money.own || {};
    const profit = own.profit || {};
    if (profit.error || profit.incomeUnconfirmed) {
      return { total: null, body: <ErrorState what={INCOME_UNREAD.title} error={profit.incomeUnconfirmed || profit} onRetry={onRetry} /> };
    }
    // 没设置汇率时按 1:1 折算，合计前加「约」（和别处同一个判断：rateSnapshotOf）
    const ownRateNow = rateSnapshotOf(own.station);
    const ownRate = ownRateNow.cnyPerUsd;
    const users = (own.byUser || [])
      .filter((u: any) => !u.isAdmin)
      .map((u: any) => ({ name: String(u.user || COPY.unnamedUser), value: r2((Number(u.cost) || 0) * ownRate), requests: u.requests }))
      .filter((u: any) => u.value > 0)
      .sort((a: any, b: any) => b.value - a.value);
    const items: HBarItem[] = users.slice(0, TOP_N).map((u: any) => ({
      key: `u-${u.name}`,
      name: u.name,
      value: u.value,
      tipExtra: u.requests != null ? [[COPY.tip.requests, Number(u.requests).toLocaleString("en-US")]] : undefined,
    }));
    const rest = users.slice(TOP_N);
    if (rest.length) items.push({ key: "rest", name: COPY.otherUsers(rest.length), value: r2(sum(rest.map((u: any) => u.value))) });
    if (Number(profit.resoldCny) > 0) items.push({ key: "resold", name: COPY.resold, value: Number(profit.resoldCny) });
    const income = profit.incomeCny ?? r2(sum(items.map((i) => i.value ?? 0)));
    return {
      total: items.length ? formatMoney(income, { approx: ownRateNow.source !== "configured" }) : null,
      body: <HBars items={items} color="var(--jy-s1)" unitName={COPY.incomeUnit} empty={COPY.noIncome} />,
    };
  }, [money, router, onRetry]);
}

// 上游成本那一小段：合计、按上游的条，和要交代的几句（放在块底）
function useCostView(money: Money | null): { total: string | null; body: ReactNode; notes: string[] } | null {
  return useMemo(() => {
    if (!money) return null;
    let items: HBarItem[];
    let approx: boolean;
    let notes: string[] = [];
    if (money.unconfigured) {
      const fb = money.fallback || {};
      const gaps = new Map<string, number>(
        (fb.coverage?.stationGaps || [])
          .filter((g: any) => Number(g.missingDays) > 0)
          .map((g: any) => [g.stationId, Number(g.missingDays)]),
      );
      const list = (fb.stations || []).filter(
        (s: any) => s.includeInProfit && !s.isOwn && s.costBasis !== "fixed" && (s.totalCny > 0 || gaps.has(s.id)),
      );
      items = list.map((s: any) => ({
        key: String(s.id),
        name: s.name,
        value: Number(s.totalCny) || 0,
        tipExtra: gaps.has(s.id) ? [[COPY.tip.note, COPY.gapTip(gaps.get(s.id)!)]] : undefined,
      }));
      approx = list.some((s: any) => gaps.has(s.id));
    } else {
      const profit = money.own?.profit || {};
      if (profit.error) return { total: null, body: <ErrorState what={COPY.costFailed} error={profit} />, notes };
      items = (profit.costs || [])
        .filter((c: any) => c.mode !== "fixed")
        .map((c: any) => ({
          key: String(c.stationId),
          name: c.name,
          value: Number(c.cny) || 0,
          tipExtra: c.note ? [[COPY.tip.how, c.note]] : COST_MODE_TEXT[c.mode as keyof typeof COST_MODE_TEXT] ? [[COPY.tip.how, COST_MODE_TEXT[c.mode as keyof typeof COST_MODE_TEXT]]] : undefined,
        }));
      notes = splitProfitWarnings(profit).notes;
      // 合计带不带「≈」和同页利润等式的上游成本同一个判断（lib/profit.js）
      approx = profitApproxOf(profit, money.own?.station).upstream;
    }
    items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const total = sum(items.map((i) => i.value ?? 0));
    const rest = items.slice(TOP_N);
    const shown = items.slice(0, TOP_N);
    if (rest.length) shown.push({ key: "rest", name: COPY.otherUpstreams(rest.length), value: r2(sum(rest.map((i) => i.value ?? 0))) });
    return {
      total: items.length ? formatMoney(total, { approx }) : null,
      body: <HBars items={shown} color="var(--jy-s2)" unitName={COPY.costUnit} empty={COPY.noCost} />,
      notes,
    };
  }, [money]);
}

// 「今天收入和上游成本」一块，上下两小段：小段标题带合计，各列前 3（ui-design-spec §5.1）。
// 手机上只露两个小段标题，条收进「按用户、按上游看」
function MoneyPanel({ title, money, error, onRetry, compact }: { title: string; money: Money | null; error: Error | null; onRetry: () => void; compact: boolean }) {
  const revenue = useRevenueView(money, onRetry);
  const cost = useCostView(money);
  const head = (what: string, total: string | null, by: string) => (
    <h3 className="jy-ov-money-head">
      {what}
      {total ? <b>{total}</b> : null}
      {compact ? null : <span className="jy-caption">· {by}</span>}
    </h3>
  );
  return (
    <MoneyPanelShell title={title} money={money} error={error} onRetry={onRetry} foot={cost?.notes.length ? cost.notes.join("") : undefined}>
      {revenue && cost ? (
        compact ? (
          <div className="jy-ov-money is-compact">
            {head(COPY.incomeUnit, revenue.total, COPY.byUser)}
            {head(COPY.costUnit, cost.total, COPY.byUpstream)}
            <More label={COPY.moneyMore}>
              <p className="jy-caption">{COPY.byUser}</p>
              {revenue.body}
              <p className="jy-caption">{COPY.byUpstream}</p>
              {cost.body}
            </More>
          </div>
        ) : (
          <div className="jy-ov-money">
            <section aria-label={COPY.incomeUnit}>
              {head(COPY.incomeUnit, revenue.total, COPY.byUser)}
              {revenue.body}
            </section>
            <section aria-label={COPY.costUnit}>
              {head(COPY.costUnit, cost.total, COPY.byUpstream)}
              {cost.body}
            </section>
          </div>
        )
      ) : null}
    </MoneyPanelShell>
  );
}
