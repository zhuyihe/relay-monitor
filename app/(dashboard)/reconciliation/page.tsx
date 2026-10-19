"use client";
// 每日利润：只读查看每条绑定在所选日期里的收入、上游成本和毛利。
// 页面查询不写库、不产生提醒；「刷新」和单行「重新读取」才让服务端读取并保存。去绑定、改绑定、解除绑定都到上游账单。
// 用语按 design/ui-copy-spec.md；报错原文只放进「查看详细原因」（§8.2）。
import "../../styles/pages/reconciliation.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Drawer, Grid } from "antd";
import { readWorkflowDestination } from "../../../lib/client";
import { BINDING_COPY } from "../../../lib/channel-onboarding.js";
import { DESTINATION_CHANGED } from "../../../lib/workflow-actions";
import type { KnownChannelCoverage, ReconciliationCurrency, ReconciliationSummary, ReconciliationWindowGroup, UnaccountedUpstream, WorkflowDestination } from "../../../lib/client";
import { reconciliationKeyNamer, reconciliationRowFlags } from "../../../lib/reconciliation-view";
import { NAV_LABELS, STATION_TABS } from "../../../lib/brand";
import { OWN_STATION_UNSET, OWN_STATION_UNSET_HINT, OWN_STATION_UNSET_TITLE, RATE_UNSET_USD, formatAsOf, formatDayZone, refreshFailedText } from "../../../lib/format";
import AppState from "../../components/app-state";
import { ErrorState, PanelSkeleton } from "../../components/data-state";
import { describeError, failureText } from "../../../lib/error-copy";
import { ErrorDetail } from "../../components/error-detail";
import { Seg } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useDrawerEscape } from "../../components/drawer-escape";
import { PRESETS, RECON_BUTTONS, SETUP_HREF, formatWindow, isFixedCost, sameRequestedWindow, sameWindow } from "./recon-format";
import type { ReconWindow } from "./recon-format";
import { useReconWindow } from "./use-recon-window";
import { useReconDetail } from "./use-recon-detail";
import { useReconResults } from "./use-recon-results";
import { useConfirmedHistory } from "./use-confirmed-history";
import { ReconCoverage, ReconSummary, ReconWindowGroups } from "./recon-summary";
import type { SummaryStale } from "./recon-summary";
import { ReconList } from "./recon-list";
import { ReconDetail } from "./recon-detail";
import { ReconHistory } from "./recon-history";

const { RangePicker } = DatePicker;

// 从提醒或上游账单的链接进来时，链接指的那条绑定对不上（§8.1、§8.2）
const REMOVED = describeError({ code: "RULE_NOT_FOUND" }).text;

// 所有绑定请求的是同一段时间（时区相同；今天、近 7 天、本月同一起点，各自截止到取数时刻）时才有共同的日期可显示，
// 截至现在的取最早的截止点
function commonWindow(results: any[]) {
  const windows = results.map((item: any) => item.requestedWindow || item.window).filter(Boolean);
  const first = windows[0];
  if (!first || !windows.every((window: any) => sameRequestedWindow(window, first))) return null;
  return { ...first, endMs: Math.min(...windows.map((window: any) => window.endMs)) };
}

// 页面选的日期范围是否就是 data 读的那个
const sameRange = (a: ReconWindow | null, b: ReconWindow) => !!a && a.preset === b.preset && a.startMs === b.startMs && a.endMs === b.endMs;

export default function ReconciliationPage() {
  const { message } = App.useApp();
  const compact = !Grid.useBreakpoint().md;
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [destinationClosed, setDestinationClosed] = useState(false);
  const destinationResolved = useRef(false);

  const detailState = useReconDetail();
  const recon = useReconWindow({ onRowReplaced: detailState.replace });
  const { config, data, loading, querying, error, preset, activeWindow, loadedWindow, range, summaryStale, summaryError, usageRereading, retryingRuleIds, ruleRetryErrors } = recon;
  const results: any[] = useMemo(() => data?.results || [], [data]);
  // 列表、抽屉和链接提示里同一把 Key 同一个名字：同名的都加上编号（§3.1）
  const keyName = useMemo(() => reconciliationKeyNamer(results.map((item) => item.rule)), [results]);
  // 金额默认按系统原值（USD）显示；自营站点和涉及的上游都设置了汇率时，服务端才让整页按人民币显示
  const currency: ReconciliationCurrency = data?.displayCurrency === "CNY" ? "CNY" : "USD";
  const unconfiguredRateStations: { id: string; name: string }[] = data?.unconfiguredRateStations || [];
  // 包月上游暂停监控、不算进利润或已归档时，自营业务页也不算它们的固定成本（服务端点名）
  const fixedOffProfit: string[] = (data?.fixedOffProfitStations || []).map((station: { name: string }) => station.name);
  const list = useReconResults({ results, upstreams: config?.upstreams, compact, currency });
  const history = useConfirmedHistory();
  const { detail } = detailState;

  const workflowRow = results.find((item: any) => item.rule?.id === destination?.ruleId);
  const workflowRule = (config?.rules || []).find((rule: any) => rule.id === destination?.ruleId);
  const windowGroups: ReconciliationWindowGroup[] = data?.windowGroups || [];
  const commonSummary: ReconciliationSummary | null = data?.commonSummary || null;
  const coverage: KnownChannelCoverage | null = data?.coverage || null;
  const unaccounted: UnaccountedUpstream | null = data?.unaccountedUpstream || null;
  const sharedWindow = commonWindow(results);
  const businessTimezone: string | undefined = data?.tz;
  const asOf = data?.generatedAt ? Date.parse(data.generatedAt) : NaN;
  const asOfText = Number.isFinite(asOf) ? formatAsOf(asOf, businessTimezone) : "";
  // 换了日期范围、新数据还没回来：旧数字属于别的日期，汇总不显示，列表变淡
  const switching = Boolean(data && querying && !sameRange(loadedWindow, activeWindow));
  // 读的不是现在选的日期（还没点「查询」，或换范围没读到）：日期前写「当前显示」
  const elsewhere = Boolean(loadedWindow && (loadedWindow.preset !== preset || !sameRange(loadedWindow, activeWindow)));
  const summaryState: SummaryStale = switching ? { kind: "switching" }
    : error ? null
      : summaryError ? { kind: "failed", asOf: Number.isFinite(asOf) ? asOf : null, timezone: businessTimezone, raw: summaryError }
        : summaryStale ? { kind: "reading" } : null;

  const openDetail = (item: any) => { history.close(); void detailState.open(item); };
  const openHistory = (id?: string) => { detailState.clear(); history.show(id); };
  const closeDrawer = () => { detailState.clear(); history.close(); };
  const drawerOpen = history.open || !!detail;
  useDrawerEscape(drawerOpen, closeDrawer);

  // 首屏：读链接里要处理的那条（来自提醒或上游账单），按它决定初始日期
  useEffect(() => {
    const target = readWorkflowDestination(window.location.search, "reconciliation");
    setDestination(target);
    void recon.initialize((current: any): ReconWindow => {
      const rule = current?.rules?.find((item: any) => item.id === target?.ruleId);
      if (target?.error) setWorkflowError(target.error);
      else if (target && (!rule || !rule.enabled || rule.archivedAt)) setWorkflowError(REMOVED);
      return target?.action === "retry" && target.window && !target.error && rule?.enabled && !rule.archivedAt
        ? { preset: "custom", startMs: target.window.startMs, endMs: target.window.endMs }
        : { preset: "yesterday" };
    });
  // 仅首屏初始化；后续查询由时间范围、刷新和定时器驱动。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 第一次读到数据后定位到那条，打开计算明细；之后的单行重新读取不再重复打开
  useEffect(() => {
    if (!destination || destinationResolved.current || !data || !config || workflowError) return;
    destinationResolved.current = true;
    if (destination.action === "retry" && !sameWindow(destination.window, workflowRow?.requestedWindow || workflowRow?.window)) {
      setWorkflowError(DESTINATION_CHANGED);
      return;
    }
    if (workflowRow) { list.setExpandedRuleId(workflowRow.rule.id); openDetail(workflowRow); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, data, config, workflowError]);

  const rangeControl = useMemo(
    () => <div className="jy-range"><Seg label="时间范围" options={PRESETS} value={preset} onChange={recon.selectPreset} /></div>,
    // selectPreset 每次渲染新建，但只依赖 preset
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset],
  );
  // 首屏读完配置、定下初始日期之前不放出时间范围和刷新，免得早点的预设被初始化覆盖、和显示的数据错位
  const ready = !loading && !!config;
  useShellPage({
    onRefresh: ready ? () => recon.loadWindow(activeWindow, true, true) : undefined,
    asOf: Number.isFinite(asOf) ? asOf : null,
    range: ready ? rangeControl : undefined,
    autoRefreshMs: recon.pollMs,
    tz: businessTimezone,
  });

  const queryCustom = async () => {
    if (!(await recon.queryCustom())) message.warning("请选开始和结束日期");
  };

  if (loading) {
    return <div className="jy-page reconciliation-page">
      <PanelSkeleton title="汇总" lines={3} />
      <PanelSkeleton title="绑定列表" lines={6} />
    </div>;
  }

  // 整块读不到（§8.1）：「读不到每日利润：原因。」原因按报错归类，原文收进「查看详细原因」
  const blockError = (onRefresh: () => void) => <div className="jy-page reconciliation-page">
    <ErrorState center title={failureText(`读不到${NAV_LABELS.reconciliation}`, error)} extra={<>
      <Button type="primary" loading={querying} onClick={onRefresh}>{RECON_BUTTONS.refresh}</Button>
      <ErrorDetail raw={error} />
    </>} />
  </div>;
  if (!config && error) return blockError(() => window.location.reload());

  const drawer = <Drawer
    className="jy-drawer reconciliation-drawer"
    placement="right"
    size={compact ? "100%" : 520}
    open={drawerOpen}
    onClose={closeDrawer}
    keyboard={false}
    destroyOnHidden
    title={history.open ? RECON_BUTTONS.history : detail?.rule ? `${keyName(detail.rule)} · 计算明细` : "计算明细"}
  >
    {history.open
      ? <ReconHistory history={history} compact={compact} rules={config?.rules || []} upstreams={config?.upstreams} businessTimezone={businessTimezone} />
      : detail ? <ReconDetail
        detail={detail} state={detailState} currency={currency} upstreams={config?.upstreams} businessTimezone={businessTimezone} compact={compact}
        results={results} keyName={keyName}
        retrying={retryingRuleIds.has(detail.rule.id)} retryError={ruleRetryErrors[detail.rule.id]}
        onOpenHistory={openHistory} onRetry={(item) => void recon.retryRule(item)} onOpen={openDetail}
        onCorrect={() => void detailState.correctTransition(() => recon.loadWindow(activeWindow, true))}
      /> : null}
  </Drawer>;

  if (!config?.ownStation && !results.length && !history.open) {
    return <>
      <AppState
        kind="empty" title={OWN_STATION_UNSET_TITLE} description={OWN_STATION_UNSET_HINT}
        actions={<>
          <Button type="primary" href={SETUP_HREF}>{RECON_BUTTONS.setup}</Button>
          <Button onClick={() => openHistory()}>{RECON_BUTTONS.history}</Button>
        </>}
      />
      {drawer}
    </>;
  }

  if (!data && error) return blockError(() => void recon.loadWindow(activeWindow, true));

  const windowCaption = sharedWindow ? formatWindow(sharedWindow) : "";
  const dayZone = sharedWindow ? formatDayZone(sharedWindow.timezone, businessTimezone) : "";
  const shownCaption = switching ? "读取中" : elsewhere && windowCaption ? `当前显示：${windowCaption}` : windowCaption;

  // 链接指的那条：要重新读取的写这天和它的问题；对不上的写一句话（§8.1）；处理重复、开始统计的旧链接只打开计算明细
  const retryStatus = workflowRow ? reconciliationRowFlags(workflowRow, currency).displayStatus : null;
  // 换了日期范围以后列表里这条已经不是链接那天，不再放「重新读取」
  const retryHere = Boolean(workflowRow && destination?.action === "retry" && sameWindow(destination.window, workflowRow.requestedWindow || workflowRow.window));
  const destinationAlert = destination && !destinationClosed && (workflowError || (destination.action === "retry" && workflowRow)) ? <Alert
    type={workflowError ? "warning" : "info"} showIcon closable={{ "aria-label": "关闭" }} onClose={() => setDestinationClosed(true)}
    title={workflowError || `${keyName(workflowRow.rule)} · ${formatWindow(destination.window)}`}
    description={!workflowError && retryStatus?.state === "action" ? retryStatus.title : undefined}
    action={<div className="reconciliation-button-row">
      {!workflowError && retryHere ? <Button size="small" loading={retryingRuleIds.has(workflowRow.rule.id)} onClick={() => void recon.retryRule(workflowRow)}>{RECON_BUTTONS.retry}</Button> : null}
      {workflowError && workflowError !== REMOVED ? <Button size="small" href="/reconciliation">{RECON_BUTTONS.refresh}</Button> : null}
      {workflowRule ? <Button size="small" onClick={() => openHistory(workflowRule.id)}>{RECON_BUTTONS.history}</Button> : null}
    </div>}
  /> : null;

  const alerts = <>
    {destinationAlert}
    {error ? <Alert
      type="warning" showIcon title={refreshFailedText(Number.isFinite(asOf) ? asOf : null, businessTimezone)} description={<ErrorDetail raw={error} />}
      action={<Button size="small" loading={querying} onClick={() => void recon.loadWindow(activeWindow, true)}>{RECON_BUTTONS.refresh}</Button>}
    /> : null}
    {!config?.ownStation && results.length ? <Alert type="warning" showIcon title={OWN_STATION_UNSET} action={<Button size="small" href={SETUP_HREF}>{RECON_BUTTONS.setup}</Button>} /> : null}
    {/* 和渠道绑定里同一句「读不到自营站点的渠道：原因。」（§8.1） */}
    {config?.channelsError ? <Alert type="warning" showIcon title={failureText(BINDING_COPY.channelsUnreadable, { code: config.channelsErrorCode, error: config.channelsError })}
      description={<ErrorDetail raw={config.channelsError} />} /> : null}
    {unconfiguredRateStations.length ? <Alert
      type="info" showIcon title={RATE_UNSET_USD}
      description={`没设置汇率的：${unconfiguredRateStations.map((station) => station.name).join("、")}`}
      action={<Button size="small" href={SETUP_HREF}>{RECON_BUTTONS.setup}</Button>}
    /> : null}
  </>;
  const hasAlerts = Boolean(destinationAlert || error || (!config?.ownStation && results.length) || config?.channelsError || unconfiguredRateStations.length);

  return <div className="jy-page reconciliation-page">
    <div className="reconciliation-head">
      <div className="jy-toolbar">
        {preset === "custom"
          ? <div className="reconciliation-custom">
            <RangePicker showTime value={range} onChange={(value) => recon.setRange(value)} aria-label="自定义时间范围" />
            <Button type="primary" className="reconciliation-query-action" loading={querying} onClick={() => void queryCustom()}>查询</Button>
            {switching || (elsewhere && windowCaption) ? <span className="jy-caption">{shownCaption}</span> : null}
          </div>
          : shownCaption ? <span className="reconciliation-window">{shownCaption}</span> : null}
        {dayZone && !switching ? <span className="jy-caption">{dayZone}</span> : null}
        <div className="reconciliation-head__actions">
          <Button onClick={() => openHistory()}>{RECON_BUTTONS.history}</Button>
          <Button href="/analytics">{NAV_LABELS.analytics}</Button>
          <Button type="primary" href="/stations?view=bills">去{STATION_TABS.bills}</Button>
        </div>
      </div>
      <p className="jy-caption">每天的收入、上游成本和毛利。去绑定、改绑定、解除绑定请到{STATION_TABS.bills}。</p>
    </div>

    {hasAlerts ? <div className="reconciliation-alerts">{alerts}</div> : null}

    <div className="reconciliation-overview">
      <ReconSummary
        summary={commonSummary} results={results} coverage={coverage} currency={currency} grouped={!commonSummary && windowGroups.length > 0}
        unaccounted={unaccounted} usageRereading={usageRereading} stale={summaryState} onRefresh={() => void recon.refreshSummary()}
        fixedCost={results.some(isFixedCost)} fixedOffProfit={fixedOffProfit} preset={activeWindow.preset}
      />
      {!commonSummary && !switching ? <ReconWindowGroups groups={windowGroups} results={results} businessTimezone={businessTimezone} stale={Boolean(error || summaryStale || summaryError)} /> : null}
      {switching ? null : <ReconCoverage coverage={coverage} />}
    </div>

    <div className={switching ? "reconciliation-switching" : undefined} aria-busy={switching || undefined}>
      <ReconList
        results={results} keyName={keyName} list={list} currency={currency} upstreams={config?.upstreams} compact={compact} error={error} ownStation={!!config?.ownStation} asOf={asOfText}
        retryingRuleIds={retryingRuleIds} ruleRetryErrors={ruleRetryErrors} onDetail={openDetail} onRetry={(item) => void recon.retryRule(item)}
      />
    </div>

    {drawer}
  </div>;
}
