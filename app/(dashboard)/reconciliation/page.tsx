"use client";
// 账单核算：只读查看每条核算关联在所选窗口的本站收费、上游成本和毛利。
// 页面查询不写库、不产生告警；「刷新」和单行「重试」才让服务端观测并保存。接入、编辑、停止都到上游账单处理。
import "../../styles/pages/reconciliation.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, DatePicker, Drawer, Grid } from "antd";
import { readWorkflowDestination } from "../../../lib/client";
import type { KnownChannelCoverage, ReconciliationSummary, ReconciliationWindowGroup, WorkflowDestination } from "../../../lib/client";
import { summarizeReconciliationFreshness } from "../../../lib/reconciliation-view";
import { NAV_LABELS } from "../../../lib/brand";
import AppState from "../../components/app-state";
import { Seg } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useDrawerEscape } from "../../components/drawer-escape";
import { PRESETS, formatRecentTime, formatTime, formatWindow, iso, sameWindow, upstreamBillsHref } from "./recon-format";
import type { ReconWindow } from "./recon-format";
import { useReconWindow } from "./use-recon-window";
import { useReconDetail } from "./use-recon-detail";
import { useReconResults } from "./use-recon-results";
import { useConfirmedHistory } from "./use-confirmed-history";
import { ReconCoverage, ReconSummary, ReconWindowGroups } from "./recon-summary";
import { ReconList } from "./recon-list";
import { ConflictRules, ReconDetail } from "./recon-detail";
import { ReconHistory } from "./recon-history";

const { RangePicker } = DatePicker;

const DESTINATION_TITLE: Record<string, string> = { retry: "重查原账单窗口", conflict: "处理重复销售归属" };

// 所有关联请求的是同一个窗口（起止和时区都相同）时才有共同窗口可显示
function commonWindow(results: any[]) {
  const windows = results.map((item: any) => item.requestedWindow || item.window).filter(Boolean);
  const first = windows[0];
  return first && windows.every((window: any) => window.startMs === first.startMs && window.endMs === first.endMs && window.timezone === first.timezone) ? first : null;
}

export default function ReconciliationPage() {
  const { message } = App.useApp();
  const compact = !Grid.useBreakpoint().md;
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const destinationResolved = useRef(false);

  const detailState = useReconDetail();
  const recon = useReconWindow({ onRowReplaced: detailState.replace });
  const { config, data, loading, querying, error, preset, activeWindow, range, summaryStale, summaryError, retryingRuleIds, ruleRetryErrors } = recon;
  const results: any[] = useMemo(() => data?.results || [], [data]);
  const list = useReconResults({ results, upstreams: config?.upstreams, compact });
  const history = useConfirmedHistory();
  const { detail } = detailState;

  const rate = config?.ownStation?.cnyPerUsd ?? null;
  const workflowRow = results.find((item: any) => item.rule?.id === destination?.ruleId);
  const workflowRule = (config?.rules || []).find((rule: any) => rule.id === destination?.ruleId);
  const conflictIds: string[] = destination?.action === "conflict"
    ? [...new Set<string>((workflowRow?.health?.issues || []).flatMap((issue: any) => issue.ruleIds || []).concat(destination.ruleId || []))]
    : [];
  const windowGroups: ReconciliationWindowGroup[] = data?.windowGroups || [];
  const commonSummary: ReconciliationSummary | null = data?.commonSummary || null;
  const coverage: KnownChannelCoverage | null = data?.coverage || null;
  const latestSuccessful = results.filter((item: any) => item.lastSuccessfulAt)
    .reduce((latest: any, item: any) => !latest || Date.parse(item.lastSuccessfulAt) > Date.parse(latest.lastSuccessfulAt) ? item : latest, null);
  const freshness = summarizeReconciliationFreshness(results);
  const sharedWindow = commonWindow(results);
  const displayTimezone = sharedWindow?.timezone || "Asia/Shanghai";
  const reference = Boolean(data && (error || querying || summaryStale || retryingRuleIds.size));

  const openDetail = (item: any) => { history.close(); void detailState.open(item); };
  const openHistory = (id?: string) => { detailState.clear(); history.show(id); };
  const closeDrawer = () => { detailState.clear(); history.close(); };
  const drawerOpen = history.open || !!detail;
  useDrawerEscape(drawerOpen, closeDrawer);

  // 首屏：读处理目标（来自告警或上游账单的深链），按目标决定初始窗口
  useEffect(() => {
    const target = readWorkflowDestination(window.location.search, "reconciliation");
    setDestination(target);
    void recon.initialize((current: any): ReconWindow => {
      const rule = current?.rules?.find((item: any) => item.id === target?.ruleId);
      if (target?.error) setWorkflowError(target.error);
      else if (target && !rule) setWorkflowError("此核算关联已删除或不在当前目录中，请刷新事项后重新打开；已保存的历史账单仍可从历史入口查看。");
      else if (target?.action === "retry" && (!rule.enabled || rule.archivedAt)) setWorkflowError("此核算关联已停止核算，不能重查新账单；可读取原确认历史。");
      return target?.action === "retry" && target.window && !target.error && rule?.enabled && !rule.archivedAt
        ? { preset: "custom", startMs: target.window.startMs, endMs: target.window.endMs }
        : { preset: "yesterday" };
    });
  // 仅首屏初始化；后续查询由时间范围、刷新和定时器驱动。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!destination || destinationResolved.current || !data || !config || workflowError) return;
    destinationResolved.current = true;
    if (destination.action === "retry" && !sameWindow(destination.window, workflowRow?.requestedWindow || workflowRow?.window)) {
      setWorkflowError("当前关联的请求窗口或时区已变化，请刷新事项后从当前账单重新打开。");
      return;
    }
    if (workflowRow) { list.setExpandedRuleId(workflowRow.rule.id); openDetail(workflowRow); }
  // 目标只在首个当前公共响应完成后定位，后续行重试不重复打开抽屉。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, data, config, workflowError]);

  const rangeControl = useMemo(
    () => <div className="jy-range"><Seg label="核算时间范围" options={PRESETS} value={preset} onChange={recon.selectPreset} /></div>,
    // selectPreset 每次渲染新建，但只依赖 preset
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset],
  );
  const asOf = data?.generatedAt ? Date.parse(data.generatedAt) : NaN;
  // 首屏读完配置、定下初始窗口之前不放出时间范围和刷新，免得早点的预设被初始化覆盖、和显示的数据错位
  const ready = !loading && !!config;
  useShellPage({
    onRefresh: ready ? () => recon.loadWindow(activeWindow, true, true) : undefined,
    asOf: Number.isFinite(asOf) ? asOf : null,
    range: ready ? rangeControl : undefined,
    autoRefreshMs: recon.pollMs,
  });

  const queryCustom = async () => {
    if (!(await recon.queryCustom())) message.warning("请先选择开始与结束时间");
  };

  if (loading) return <AppState kind="loading" title="正在读取账单核算" description="正在汇总上游实际消费与本站渠道收费。" />;

  if (!config && error) {
    return <AppState kind="error" title="无法加载账单核算" description={error} actions={<Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>} />;
  }

  const drawer = <Drawer
    className="jy-drawer reconciliation-drawer"
    placement="right"
    size={compact ? "100%" : 520}
    open={drawerOpen}
    onClose={closeDrawer}
    keyboard={false}
    destroyOnHidden
    title={history.open ? "已确认账单历史" : detail?.rule?.tokenName ? `${detail.rule.tokenName} · 核算详情` : "核算详情"}
  >
    {history.open
      ? <ReconHistory history={history} compact={compact} rules={config?.rules || []} />
      : detail ? <ReconDetail
        detail={detail} state={detailState} rate={rate} upstreams={config?.upstreams} compact={compact}
        conflictIds={conflictIds} results={results}
        retrying={retryingRuleIds.has(detail.rule.id)} retryError={ruleRetryErrors[detail.rule.id]}
        onOpenHistory={openHistory} onRetry={(item) => void recon.retryRule(item)} onOpen={openDetail}
        onCorrect={() => void detailState.correctTransition(() => recon.loadWindow(activeWindow, true))}
      /> : null}
  </Drawer>;

  if (!config?.ownStation && !results.length && !history.open) {
    return <>
      <AppState
        kind="empty" title="还不能开始核算" description="请先在上游资源中标记一个自己的 NewAPI 管理员站点，用于读取本站渠道收费。"
        actions={<>
          <Button type="primary" href="/stations">前往上游资源</Button>
          <Button onClick={() => openHistory()}>查看已确认账单历史</Button>
        </>}
      />
      {drawer}
    </>;
  }

  if (!data && error) {
    return <AppState kind="error" title="无法读取核算数据" description={error} actions={<Button type="primary" loading={querying} onClick={() => recon.loadWindow(activeWindow, true)}>重新查询</Button>} />;
  }

  const windowCaption = sharedWindow ? formatWindow(sharedWindow) : results.length ? "按各关联时区计算，具体时间见详情" : "选择时间范围后查询";
  const freshnessText = !results.length ? null
    : reference ? `上次成功窗口：${sharedWindow ? formatWindow(sharedWindow) : "见各关联详情"}（仅供参考）`
      : freshness.staleCount ? `${freshness.staleCount} 条关联数据已过期${sharedWindow && freshness.coverageEndMs != null ? ` · 最早金额覆盖至 ${formatTime(freshness.coverageEndMs, sharedWindow.timezone)}` : ""}`
        : latestSuccessful ? `最近成功：${formatRecentTime(latestSuccessful.lastSuccessfulAt, latestSuccessful.window?.timezone)}（${latestSuccessful.window?.timezone || "Asia/Shanghai"}）`
          : "暂未成功（当前读取失败）";

  const destinationAlert = destination ? <Alert
    type={workflowError ? "warning" : "info"} showIcon
    title={workflowError || DESTINATION_TITLE[destination.action] || "查看当前范围生效时间"}
    description={workflowError ? undefined : <div className="reconciliation-destination">
      核算关联 {destination.ruleId}{destination.window ? ` · ${iso(destination.window.startMs)} — ${iso(destination.window.endMs)}（${destination.window.timezone}）` : ""}
      {destination.action === "conflict" ? <div>
        涉及关联：{conflictIds.join("、") || "当前未发现冲突"}。逐条核对后到上游账单停止其中一条；只是渠道重复时，也可以编辑渠道移除重复的渠道。历史账单保留。
        <ConflictRules ids={conflictIds} results={results} onOpen={openDetail} />
      </div> : null}
    </div>}
    action={<div className="reconciliation-button-row">
      {!workflowError && destination.action === "retry" && workflowRow && sameWindow(destination.window, workflowRow.requestedWindow || workflowRow.window)
        ? <Button loading={retryingRuleIds.has(workflowRow.rule.id)} onClick={() => void recon.retryRule(workflowRow)}>重查该窗口账单</Button>
        : null}
      {!workflowError && destination.action !== "retry" && workflowRule ? <Button href={upstreamBillsHref(workflowRule.id, destination.action === "conflict")}>去上游账单处理</Button> : null}
      {workflowRule ? <Button onClick={() => openHistory(workflowRule.id)}>原确认历史</Button> : null}
      <Button onClick={() => window.location.reload()}>刷新处理目标</Button>
      <Button href="/reconciliation">返回当前账单</Button>
    </div>}
  /> : null;

  return <div className="jy-page reconciliation-page">
    <div className="reconciliation-head">
      <div className="jy-toolbar">
        {preset === "custom"
          ? <div className="reconciliation-custom">
            <RangePicker showTime value={range} onChange={(value) => recon.setRange(value)} aria-label="自定义核算时间" />
            <Button type="primary" className="reconciliation-query-action" loading={querying} onClick={() => void queryCustom()}>查询</Button>
            {activeWindow.preset !== "custom" && results.length ? <span className="jy-caption">当前显示：{windowCaption}</span> : null}
          </div>
          : <span className="reconciliation-window">{windowCaption}</span>}
        {sharedWindow ? <span className="jy-caption">{sharedWindow.timezone}</span> : null}
        <div className="reconciliation-head__actions">
          <Button onClick={() => openHistory()}>查看已确认账单历史</Button>
          <Button href="/analytics">{NAV_LABELS.analytics}</Button>
          <Button type="primary" href="/stations?view=bills">去上游账单</Button>
        </div>
      </div>
      <p className="jy-caption">实际 Key 账单与本站渠道收费，按原来源和绝对窗口核算；接入、编辑或停止核算关联请到上游账单</p>
      {data ? <p className="reconciliation-freshness jy-caption">
        <span>{reference ? "参考结果生成" : "显示结果生成"}：{formatRecentTime(data.generatedAt, displayTimezone, true)}（{displayTimezone}）</span>
        {freshnessText ? <span>{freshnessText}</span> : null}
      </p> : null}
    </div>

    {destinationAlert || error || (!config?.ownStation && results.length) || config?.channelsError || summaryError ? <div className="reconciliation-alerts">
      {destinationAlert}
      {error ? <Alert
        type="error" showIcon title="核算数据加载失败 · 当前显示上次结果" description={`${error}。下方窗口与金额属于上次查询，非本次查询结果。`}
        action={<Button size="small" onClick={() => recon.loadWindow(activeWindow, true)}>重试</Button>}
      /> : null}
      {!config?.ownStation && results.length ? <Alert
        type="warning" showIcon title="本站管理员站点未配置"
        description="本站收费当前不可获取；已保存的核算关联仍显示可用的上游成本与历史参考。请先配置本站管理员站点后再接入或编辑核算关联。"
        action={<Button size="small" href="/stations">前往配置</Button>}
      /> : null}
      {config?.channelsError ? <Alert type="warning" showIcon title={config.channelsError} /> : null}
      {summaryError ? <Alert
        type="warning" showIcon title="全量汇总读取失败 · 摘要仅供参考" description={summaryError}
        action={<Button size="small" onClick={() => void recon.refreshSummary()}>重读全量汇总</Button>}
      /> : null}
    </div> : null}

    <div className="reconciliation-overview">
      <ReconSummary summary={commonSummary} reference={reference} />
      <ReconWindowGroups groups={windowGroups} reference={reference} />
      <ReconCoverage coverage={coverage} reference={reference} />
    </div>

    <ReconList
      results={results} list={list} rate={rate} upstreams={config?.upstreams} compact={compact} error={error} ownStation={!!config?.ownStation}
      retryingRuleIds={retryingRuleIds} ruleRetryErrors={ruleRetryErrors} onDetail={openDetail} onRetry={(item) => void recon.retryRule(item)}
    />

    {drawer}
  </div>;
}
