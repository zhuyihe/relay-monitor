"use client";
// 每日利润（一张对账表，设计稿 design/ux/daily-profit-a.md）：页顶一句 + 四个数一行 + 一张表；点开一行看每天的差额，再点看计算明细。
// 数据只来自 POST /api/reconciliation/profit 和 GET …/profit/detail（只读）；「刷新」和需处理那一行的「重新读取」才让服务端读取并保存。
// 默认打开今天，每 30 秒重读一次。这一页只看结果，不改设置。用语按 design/ui-copy-spec.md；报错原文只放进「查看详细原因」（§8.2）。
import "../../styles/pages/reconciliation.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { OWN_CONSUME_LOG_CHECKED } from "../../components/recheck-consume-log";
import { Alert, App, Button, DatePicker, Drawer, Grid } from "antd";
import { api, readWorkflowDestination } from "../../../lib/client";
import type { ProfitPageResponse, ProfitRow, WorkflowDestination } from "../../../lib/client";
import { DESTINATION_CHANGED, workflowActionMeta } from "../../../lib/workflow-actions";
import { sameReconciliationWindow } from "../../../lib/reconciliation-contract";
import { INCOME_UNREAD, OWN_STATION_UNSET, formatZonedWindow } from "../../../lib/format";
import { describeError, failureSentence } from "../../../lib/error-copy";
import { ErrorState, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { Seg } from "../../components/seg";
import { Sym } from "../../components/icons";
import { useShellPage } from "../../components/shell-context";
import { useDrawerEscape } from "../../components/drawer-escape";
import { loadWorkflowActions } from "../../components/use-workflow-actions";
import { RECON_BUTTONS, SETUP_HREF } from "./recon-format";
import { COPY } from "./copy";
import { useProfitPage } from "./use-profit-page";
import type { ProfitPreset, ProfitWindow } from "./use-profit-page";
import { useConfirmedHistory } from "./use-confirmed-history";
import { ReconHistory } from "./recon-history";
import { ProfitSummary } from "./profit-summary";
import { ProfitTable } from "./profit-table";
import { ProfitDetail, detailTitle } from "./profit-detail";
import { footerNotes, isMismatched, rangeCaption, rowName } from "./profit-format";
import type { Ctx, ProfitFilter } from "./profit-format";
import { dayKeyInTz, dayStartInTz, shiftDayLabel, shiftedDayStartInTz } from "../../../lib/business-time";

const { RangePicker } = DatePicker;
// 从提醒或上游账单的链接进来时，链接指的那条绑定对不上（§8.1、§8.2）
const REMOVED = describeError({ code: "RULE_NOT_FOUND" }).text;
const PRESETS = (["today", "yesterday", "7d", "month", "custom"] as ProfitPreset[]).map((value) => ({ value, label: COPY.presets[value] }));
const UPSTREAMS_HREF = "/stations";
const START_HREF = `/stations?view=accounts`;
const SETTINGS_HREF = "/settings";

export default function ReconciliationPage() {
  const { message } = App.useApp();
  const compact = !Grid.useBreakpoint().md;
  const state = useProfitPage();
  const { config, data, loading, querying, error, preset, activeWindow, switching, retryingKeys, retryErrors, detail } = state;
  const history = useConfirmedHistory();
  const [filter, setFilter] = useState<ProfitFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [workflowError, setWorkflowError] = useState("");
  const [destinationClosed, setDestinationClosed] = useState(false);
  const destinationResolved = useRef(false);
  const autoExpanded = useRef<string | null>(null);

  const tz = data?.tz || data?.range?.timezone;
  // 这一行上游算一天的时区：从绑定配置里取（只给「这个上游按 UTC+5:30 算一天」那一句用）
  const rules: any[] = config?.rules || [];
  const ctx: Ctx = useMemo(() => ({ currency: data?.displayCurrency === "CNY" ? "CNY" : "USD", tz: tz || "",
    zoneOf: (row: ProfitRow) => rules.find((rule) => row.ruleIds.includes(rule.id))?.timezone || tz }), [data?.displayCurrency, tz, rules]);
  // 自营站点的收费记录读到哪儿了（表下面那一行）：页面加载时顺带读一次 /api/settings
  const [ownLog, setOwnLog] = useState<{ coveredToMs?: number | null; behindMs?: number | null } | null>(null);
  // 「重新检查」按钮（app/components/recheck-consume-log.tsx）点完以后，重读自己这一页的数据（按钮点了才读，不是打开页面就读；R2）
  useEffect(() => {
    const onChecked = () => { void state.load(activeWindow); };
    window.addEventListener(OWN_CONSUME_LOG_CHECKED, onChecked);
    return () => window.removeEventListener(OWN_CONSUME_LOG_CHECKED, onChecked);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow]);
  useEffect(() => { api("/api/settings").then((settings) => setOwnLog(settings?.ownLog ?? null)).catch(() => setOwnLog(null)); }, []);
  const asOf = data?.asOf ? Date.parse(data.asOf) : NaN;

  // 首屏：读链接里要处理的那条（来自提醒或上游账单），按它决定初始日期；没有就是今天
  useEffect(() => {
    const target = readWorkflowDestination(window.location.search, "reconciliation");
    setDestination(target);
    void state.initialize((current: any): ProfitWindow => {
      const rule = current?.rules?.find((item: any) => item.id === target?.ruleId);
      if (target?.error) setWorkflowError(target.error);
      else if (target && (!rule || !rule.enabled || rule.archivedAt)) setWorkflowError(REMOVED);
      return target?.action === "retry" && target.window && !target.error && rule?.enabled && !rule.archivedAt
        ? { preset: "custom", startMs: target.window.startMs, endMs: target.window.endMs }
        : { preset: "today" };
    });
  // 仅首屏初始化；后续查询由时间范围、刷新和定时器驱动
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 桌面上对不上的行默认展开（设计稿 §4）；手机卡片一律默认收起（设计验收 10-26）；换了范围重新算一次
  const rangeKey = data ? `${data.range.startMs}-${data.range.endMs}` : "";
  useEffect(() => {
    if (!data || autoExpanded.current === rangeKey) return;
    autoExpanded.current = rangeKey;
    setExpanded(new Set(compact ? [] : data.rows.filter((row) => isMismatched(row, data)).map((row) => row.rowKey)));
  }, [data, rangeKey, compact]);

  // 第一次读到数据后定位到链接指的那一行：日期还是链接那天就展开它、打开那天的计算明细；不是了写「这条已经变了」
  const workflowRow = data?.rows.find((row) => destination?.ruleId && row.ruleIds.includes(destination.ruleId)) || null;
  useEffect(() => {
    if (!destination || destinationResolved.current || !data || workflowError) return;
    destinationResolved.current = true;
    if (destination.action === "retry" && !sameReconciliationWindow(destination.window, { startMs: data.range.startMs, endMs: data.range.endMs, timezone: data.range.timezone })) {
      setWorkflowError(DESTINATION_CHANGED);
      return;
    }
    if (!workflowRow) return;
    setExpanded((previous) => new Set(previous).add(workflowRow.rowKey));
    requestAnimationFrame(() => document.querySelector(`[data-row-key="${CSS.escape(workflowRow.rowKey)}"]`)?.scrollIntoView({ block: "center" }));
    if (destination.action === "retry") void state.openDetail(workflowRow, dayKeyInTz(data.range.startMs, data.range.timezone));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, data, workflowError]);

  const toggleRow = (rowKey: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey); return next; });
  // 「看昨天」这类链接：跳到那一天（按业务时区的整天）
  const selectDay = (day: string) => {
    if (!tz) return;
    if (data && day === shiftDayLabel(data.today, -1)) state.selectPreset("yesterday");
    else { const start = dayStartInTz(day, tz); state.selectDay(start, shiftedDayStartInTz(start, 1, tz)); }
  };
  const refresh = async () => { await state.refresh(); void loadWorkflowActions(true, ["bills"]); };
  const retryRow = async (row: ProfitRow) => { await state.retryRow(row); void loadWorkflowActions(true, ["bills"]); };

  const closeDrawer = () => { state.closeDetail(); history.close(); };
  const drawerOpen = history.open || !!detail;
  useDrawerEscape(drawerOpen, closeDrawer);

  const rangeControl = useMemo(
    () => <div className="jy-range"><Seg label={COPY.rangeLabel} options={PRESETS} value={preset} onChange={state.selectPreset} /></div>,
    // selectPreset 每次渲染新建，但只依赖 preset
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset],
  );
  const ready = !loading && !!config;
  useShellPage({ onRefresh: ready ? refresh : undefined, asOf: Number.isFinite(asOf) ? asOf : null, range: ready ? rangeControl : undefined, autoRefreshMs: state.pollMs, tz });

  if (loading) {
    return <div className="jy-page jy-profit-page">
      <PanelSkeleton title={COPY.metric.gross} lines={2} />
      <PanelSkeleton title={COPY.table.title} lines={6} />
    </div>;
  }
  if (!data && error) {
    return <div className="jy-page jy-profit-page">
      <ErrorState center what={COPY.notice.readFailed} error={error} onRetry={() => void state.load(activeWindow)} retrying={querying} />
    </div>;
  }

  const drawer = <Drawer
    className="jy-drawer jy-profit-drawer" placement="right" size={compact ? "100%" : 560} open={drawerOpen} onClose={closeDrawer} keyboard={false} destroyOnHidden
    title={history.open ? RECON_BUTTONS.history : detail ? detailTitle(detail.row, detail.day, ctx) : COPY.detail.expected}
  >
    {history.open
      ? <ReconHistory history={history} compact={compact} rules={config?.rules || []} upstreams={config?.upstreams} businessTimezone={tz} />
      : detail && data ? <ProfitDetail detail={detail} page={data} ctx={ctx} onRetry={() => void state.openDetail(detail.row, detail.day)} /> : null}
  </Drawer>;

  if (!data) return <>{drawer}</>;
  const page: ProfitPageResponse = data;
  const ownIncome = page.ownIncomeUnavailable;
  const retryHere = Boolean(workflowRow && destination?.action === "retry" && !workflowError);
  const destinationAlert = destination && !destinationClosed && (workflowError || (destination.action === "retry" && workflowRow)) ? <Alert
    type={workflowError ? "warning" : "info"} showIcon closable={{ "aria-label": "关闭" }} onClose={() => setDestinationClosed(true)}
    title={workflowError || `${rowName(workflowRow!)} · ${formatZonedWindow(destination.window)}`}
    description={!workflowError && workflowRow?.attention ? workflowRow.attention.title : undefined}
    action={<div className="jy-profit-buttons">
      {retryHere ? <Button size="small" loading={retryingKeys.has(workflowRow!.rowKey)} onClick={() => void retryRow(workflowRow!)}>{RECON_BUTTONS.retry}</Button> : null}
      {workflowError && workflowError !== REMOVED ? <Button size="small" href="/reconciliation">{RECON_BUTTONS.refresh}</Button> : null}
    </div>}
  /> : null;

  const notes = footerNotes(page, ctx, { upstreams: UPSTREAMS_HREF, start: START_HREF, settings: SETTINGS_HREF }, ownLog);
  const emptyAction = config?.ownStation ? { href: START_HREF, label: COPY.table.startCounting } : { href: SETUP_HREF, label: COPY.table.setupOwnStation };

  return <div className="jy-page jy-profit-page">
    <div className="jy-profit-head">
      {preset === "custom"
        ? <div className="jy-profit-custom">
          <RangePicker showTime value={state.range} onChange={(value) => state.setRange(value)} aria-label={COPY.customRangeLabel} />
          <Button type="primary" loading={querying} onClick={() => void state.queryCustom().then((ok) => { if (!ok) message.warning(COPY.pickRange); })}>{COPY.query}</Button>
        </div>
        : null}
      <span className="jy-profit-caption">{switching ? "" : rangeCaption(page, ctx)}</span>
      <Button className="jy-profit-head__history" onClick={() => { state.closeDetail(); history.show(); }}>{RECON_BUTTONS.history}</Button>
    </div>

    {destinationAlert}
    {error ? <RefreshFailedBanner asOf={Number.isFinite(asOf) ? asOf : null} tz={tz} error={error} onRetry={() => void state.load(activeWindow)} retrying={querying} /> : null}
    {ownIncome ? <div className="jy-banner" role="alert">
      <Sym kind="warn" />
      <div className="jy-banner__body"><b>{failureSentence(INCOME_UNREAD.title, describeError({ code: ownIncome.code }).text)}</b><p className="jy-caption">{INCOME_UNREAD.costOnly}</p></div>
      <Button size="small" loading={querying} onClick={() => void refresh()}>{workflowActionMeta("refresh")!.label}</Button>
    </div> : null}
    {!config?.ownStation && page.rows.length ? <Alert type="warning" showIcon title={OWN_STATION_UNSET} action={<Button size="small" href={SETUP_HREF}>{RECON_BUTTONS.setup}</Button>} /> : null}

    {page.rows.length ? <div className={switching ? "jy-profit-switching" : undefined}><ProfitSummary page={page} ctx={ctx} compact={compact} onSelectDay={selectDay} /></div> : null}

    <ProfitTable
      page={page} ctx={ctx} compact={compact} switching={switching} filter={filter} onFilter={setFilter} expanded={expanded} onToggle={toggleRow}
      onOpenDetail={(row, day) => { history.close(); void state.openDetail(row, day); }} onRetry={(row) => void retryRow(row)} onRefresh={() => void refresh()}
      retryingKeys={retryingKeys} retryErrors={retryErrors} empty={emptyAction}
    />

    {notes.length && page.rows.length ? <p className="jy-caption jy-profit-notes">
      {notes.map((note) => <span key={note.key}>{note.text}{note.link ? <> <a className="jy-link" href={note.link.href}>{note.link.text}</a></> : null}</span>)}
    </p> : null}

    {drawer}
  </div>;
}

