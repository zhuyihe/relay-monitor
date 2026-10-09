"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer } from "@ant-design/pro-components";
import {
  Alert, App, Button, Collapse, DatePicker, Drawer, Dropdown, Empty, Form, Grid, Input,
  Pagination, Popconfirm, Segmented, Select, Space, Table, Tag, Typography,
} from "antd";
import { DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import { api } from "../../../lib/client";
import type { BatchInput, BatchProbe, ConfirmedHistoryRecord, ConfirmedHistoryResponse, CoverageDeclaration, KnownChannelCoverage, ReconciliationWindowGroup, ReconciliationSummary, RuleEditPreview } from "../../../lib/client";
import {
  formatReconciliationMoney as money,
  hasReconciliationHistory,
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  filterReconciliationResults,
  reconciliationBillingBasis,
  reconciliationCalculationValues as calculationValues,
  reconciliationRowFlags,
  summarizeReconciliationFreshness,
} from "../../../lib/reconciliation-view";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_BILLING_SOURCE_LABEL,
  reconciliationHealthMeta,
} from "../../../lib/reconciliation-contract";
import AppState from "../../components/app-state";
import ChannelOnboarding from "../../components/channel-onboarding";

const { Text } = Typography;
const { RangePicker } = DatePicker;

const PRESETS = [
  { label: "今天", value: "today" },
  { label: "昨天", value: "yesterday" },
  { label: "近 7 天", value: "7d" },
  { label: "自定义", value: "custom" },
];

const channelStateLabel: Record<string, string> = {
  enabled: "启用", manual_disabled: "手动禁用", auto_disabled: "自动禁用", missing: "已缺失", unknown: "状态未知",
};

function percent(value: any) {
  if (value == null) return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "—";
}

function billingStateLabel(state: any) {
  return state === "complete" ? "完整" : state === "partial" ? "部分" : state === "pending" ? "待获取" : "不可用";
}

function billingAmountText(billing: any, rate: any) {
  if (!["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return "— · 旧版待刷新";
  const state = billing.state;
  const amount = state === "complete" ? billing?.amountUsd : billing?.knownAmountUsd;
  if (amount == null || !Number.isFinite(Number(amount))) return `— · ${billingStateLabel(state)}`;
  return state === "complete" ? money(amount, rate) : `${money(amount, rate)} · ${billingStateLabel(state)}`;
}

function billingCoverageText(billing: any) {
  if (!["complete", "partial", "unavailable", "pending"].includes(billing?.state)) return "旧版待刷新";
  const successful = Number(billing?.successfulCount);
  const expected = Number(billing?.expectedCount);
  return Number.isInteger(successful) && successful >= 0 && Number.isInteger(expected) && expected >= 0
    ? `已获取 ${successful}/${expected}` : billingStateLabel(billing?.state);
}

function sameWindow(a: any, b: any) {
  return a?.startMs === b?.startMs && a?.endMs === b?.endMs && a?.timezone === b?.timezone;
}

function formatWindow(window: any) {
  if (window?.startMs == null || window?.endMs == null) return "—";
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: window.timezone || "Asia/Shanghai", hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  };
  return `${new Intl.DateTimeFormat("zh-CN", opts).format(new Date(window.startMs))} — ${new Intl.DateTimeFormat("zh-CN", opts).format(new Date(window.endMs))}`;
}

function statusTag(item: any) {
  const { status, secondaryStatuses } = reconciliationRowFlags(item);
  return <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
    {[status, ...secondaryStatuses].map((badge) => <span key={badge.label} className={`reconciliation-status reconciliation-status--${badge.tone}`}>{badge.label}</span>)}
  </span>;
}

function upstreamName(rule: any, upstreams: any) {
  if (!Array.isArray(upstreams)) return "上游账号目录暂不可用";
  const station = upstreams.find((item) => String(item.id) === String(rule?.upstreamStationId));
  return station?.name || `已删除的上游账号（${rule?.upstreamStationId || "未知站点"}）`;
}

function ratioLabel(value: any) {
  return value == null ? "倍率未知" : `${value}×`;
}

function formatTime(value: any, timezone?: string) {
  if (value == null) return "暂未成功";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "暂未成功";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone || "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatRecentTime(value: any, timezone?: string, includeSeconds = false, includeYear = false) {
  if (value == null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone || "Asia/Shanghai", hour12: false, ...(includeYear ? { year: "numeric" } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" } : {}) }).format(date);
}

function ChannelBreakdown({ item, rate }: { item: any; rate: any }) {
  const channels = mergeReconciliationChannels(item?.rule?.channels, item?.downstream?.channels);
  if (!channels.length) return <Text type="secondary">该规则没有关联销售渠道。</Text>;
  return (
    <div className="reconciliation-channel-list">
      {channels.map((channel: any) => (
        <div key={channel.channelId || channel.id || channel.name} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--jy-border)" }}>
          <div style={{ minWidth: 0 }}>
            <Text strong style={{ overflowWrap: "anywhere" }}>{channel.name || `渠道 ${channel.channelId || channel.id}`}</Text>
            <div style={{ marginTop: 2, color: "var(--jy-text-secondary)", fontSize: 12 }}>
              渠道 ID：{channel.channelId || channel.id || "—"} · 收费占比 {percent(channel.share)}
            </div>
          </div>
          <Space direction="vertical" size={2} align="end">
            <Text strong style={{ fontVariantNumeric: "tabular-nums" }}>{billingAmountText({ state: channel.billingState, amountUsd: channel.amountUsd, knownAmountUsd: channel.knownAmountUsd }, rate)}</Text>
            <Tag color={channel.state === "enabled" ? "success" : channel.state === "missing" ? "error" : "warning"}>{channelStateLabel[channel.state] || "状态未知"}</Tag>
          </Space>
        </div>
      ))}
    </div>
  );
}

function segmentPeriod(segment: any, timezone?: string) {
  return `${formatRecentTime(segment.effectiveFrom, timezone, false, true)} — ${segment.effectiveTo == null ? "至今" : formatRecentTime(segment.effectiveTo, timezone, false, true)}`;
}

function segmentTimingLabel(segment: any) {
  return segment.timingSource === "detected" ? "切换时间待确认"
    : segment.timingSource === "operator_confirmed" ? "已人工确认" : "初始分段";
}

function SegmentHistory({ item, rate, compact, onDetail }: { item: any; rate: any; compact: boolean; onDetail: () => void }) {
  const timezone = item.window?.timezone || item.rule?.timezone;
  const segments = mergeReconciliationSegments(item.transitionSegments, item.segments).slice().reverse();
  const rows = segments.map((segment: any) => ({ ...segment, values: calculationValues(segment.calculation, segment.health, segment) }));
  const columns: any[] = [
    { title: "生效区间", key: "period", width: 225, render: (_: any, row: any) => <span className="reconciliation-history-period"><strong>{segmentPeriod(row, timezone)}</strong><small>{row.window ? `本次核算 ${formatWindow(row.window)}` : "查询窗口外 · 无本次金额"}</small></span> },
    { title: "上游分组 / 倍率", key: "group", width: 185, render: (_: any, row: any) => <span className="reconciliation-history-group"><strong>{row.group || "分组未知"}</strong><small>{ratioLabel(row.ratio)}{row.ratioSource === "group_catalog" ? " · 目录观察值" : ""}</small></span> },
    { title: "本站收费", key: "income", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{row.window ? billingAmountText(row.downstream, rate) : "—"}</span> },
    { title: "上游成本", key: "cost", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{row.window ? billingAmountText(row.upstream, rate) : "—"}</span> },
    { title: "利润 / 风险差额", key: "profit", width: 145, align: "right", render: (_: any, row: any) => <span className="reconciliation-history-result"><strong className={row.values.confirmed && Number(row.values.profitUsd) < 0 ? "reconciliation-amount--danger" : ""}>{row.window ? row.values.confirmed ? money(row.values.profitUsd, rate) : money(row.values.riskDifferenceUsd, rate) : "—"}</strong><small>{row.window ? row.values.confirmed ? "确认利润" : "风险差额" : "本次窗口外"}</small></span> },
    { title: "实际毛利率", key: "margin", width: 110, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{row.window ? percent(row.values.marginRate) : "—"}</span> },
    { title: "时间依据", key: "timing", width: 135, render: (_: any, row: any) => row.timingSource === "detected" ? <Button type="link" size="small" onClick={onDetail}>待确认 · 去修正</Button> : segmentTimingLabel(row) },
  ];

  return <section className="reconciliation-history" aria-label={`${item.rule?.tokenName || "上游 Key"} 的分组变更历史`}>
    <div className="reconciliation-history__intro"><strong>分组与倍率历史 · {rows.length} 段</strong><span>金额仅对应顶部查询窗口；窗口外的历史分段不计入本次金额。</span></div>
    {compact ? <div className="reconciliation-history-mobile">
      {rows.map((row: any) => <div key={row.id} className="reconciliation-history-mobile__row">
        <div className="reconciliation-history-mobile__heading"><strong>{row.group || "分组未知"} · {ratioLabel(row.ratio)}</strong><span>{segmentTimingLabel(row)}</span></div>
        <div className="reconciliation-history-mobile__period">{segmentPeriod(row, timezone)}{row.window ? ` · 本次核算 ${formatWindow(row.window)}` : " · 查询窗口外"}</div>
        <div className="reconciliation-history-mobile__figures"><span>收费 <strong>{row.window ? billingAmountText(row.downstream, rate) : "—"}</strong></span><span>成本 <strong>{row.window ? billingAmountText(row.upstream, rate) : "—"}</strong></span><span>{row.values.confirmed ? "利润" : "风险差额"} <strong>{row.window ? money(row.values.confirmed ? row.values.profitUsd : row.values.riskDifferenceUsd, rate) : "—"}</strong></span><span>毛利率 <strong>{row.window ? percent(row.values.marginRate) : "—"}</strong></span></div>
        {row.timingSource === "detected" ? <Button type="link" size="small" onClick={onDetail}>修正切换时间</Button> : null}
      </div>)}
    </div> : <Table className="reconciliation-history-table" size="small" rowKey={(row: any) => row.id} columns={columns} dataSource={rows} scroll={{ x: 1040 }} pagination={rows.length > 6 ? { pageSize: 6, size: "small", showSizeChanger: false } : false} />}
  </section>;
}

function currentGroup(item: any) {
  return item?.currentSegment?.group || item?.upstream?.group || item?.rule?.fixedGroup || "未返回";
}

function currentRatio(item: any) {
  if (Object.prototype.hasOwnProperty.call(item?.upstream || {}, "ratio")) return item.upstream.ratio;
  return item?.currentSegment?.ratio;
}

function currentRatioLabel(item: any) {
  const ratio = currentRatio(item);
  if (ratio != null) return ratioLabel(ratio);
  const reference = item?.currentSegment?.ratio;
  if (reference == null) return "倍率未知";
  const observedAt = item?.currentSegment?.ratioObservedAt || item?.currentSegment?.observedAt;
  return `倍率未知 · 参考 ${reference}×${observedAt ? `（${formatRecentTime(observedAt, item?.window?.timezone)}）` : "（历史参考）"}`;
}

function ruleHistory(item: any) {
  return mergeReconciliationSegments(item?.transitionSegments, item?.segments);
}

function channelStateSummary(channels: any[]) {
  const enabled = channels.filter((channel) => channel.state === "enabled").length;
  const disabled = channels.filter((channel) => channel.state === "manual_disabled" || channel.state === "auto_disabled").length;
  const missing = channels.filter((channel) => channel.state === "missing").length;
  const unknown = channels.length - enabled - disabled - missing;
  return `启用 ${enabled} · 禁用 ${disabled} · 缺失 ${missing}${unknown ? ` · 未知 ${unknown}` : ""}`;
}

function channelLabel(channel: any) {
  const id = channel.channelId ?? channel.id;
  return `${channel.name || `渠道 ${id ?? "—"}`} · ID ${id ?? "—"}`;
}

function SummaryMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="reconciliation-summary-metric">
    <span className="reconciliation-summary-metric__label">{label}</span>
    <strong className={tone ? `reconciliation-summary-metric__value reconciliation-amount--${tone}` : "reconciliation-summary-metric__value"}>{value}</strong>
  </div>;
}

function RuleMobileItem({ item, rate, upstreams, onDetail, onRetry, retrying, retryError, expanded, onExpand }: { item: any; rate: any; upstreams: any; onDetail: () => void; onRetry: () => void; retrying: boolean; retryError?: string; expanded: boolean; onExpand: () => void }) {
  const rule = item.rule || {};
  const channels = mergeReconciliationChannels(rule.channels, item.downstream?.channels);
  const calculation = calculationValues(item.calculation, item.health, item);
  const profit = calculation.profitUsd == null ? null : Number(calculation.profitUsd);
  const tone = profit == null || !Number.isFinite(profit) ? "" : profit < 0 ? "danger" : "success";
  const history = ruleHistory(item);
  const hasHistory = hasReconciliationHistory(history);
  return <div className="reconciliation-mobile-item"><button type="button" className="reconciliation-mobile-row" onClick={onDetail}>
    <span className="reconciliation-mobile-row__top">
      <span className="reconciliation-mobile-row__identity">
        <strong>{upstreamName(rule, upstreams)}</strong>
        <span>Key：{rule.tokenName || "未命名 Key"}</span>
        <span>现用分组 / 上游倍率：{currentGroup(item)} · {currentRatioLabel(item)}</span>
      </span>
      <span className="reconciliation-mobile-row__finance">
        {statusTag(item)}
        <strong className={tone ? `reconciliation-amount--${tone}` : ""}>{calculation.confirmed ? money(calculation.profitUsd, rate) : "待核算"}</strong>
        <span className={tone ? `reconciliation-amount--${tone}` : ""}>{calculation.confirmed ? percent(calculation.marginRate) : "—"}</span>
      </span>
      <RightOutlined className="reconciliation-mobile-row__chevron" aria-hidden="true" />
    </span>
    <span className="reconciliation-mobile-row__bottom">收费 {billingAmountText(item.downstream, rate)} <span aria-hidden="true">·</span> 成本 {billingAmountText(item.upstream, rate)} <span aria-hidden="true">·</span> {channels.length} 个渠道</span>
    {channels.length ? <span className="reconciliation-mobile-row__channels">{channels.map(channelLabel).join("、")} · {channelStateSummary(channels)}</span> : null}
  </button>
    <Button type="link" className="reconciliation-mobile-history-toggle" loading={retrying} onClick={onRetry}>重试当前规则</Button>
    {retryError ? <Alert type="error" showIcon message={retryError} action={<Button size="small" onClick={onRetry}>重试</Button>} className="reconciliation-inline-alert" /> : null}
    {hasHistory ? <Button type="text" className="reconciliation-mobile-history-toggle" onClick={onExpand} aria-expanded={expanded}>{expanded ? "收起" : "查看"}分组历史 · {history.length} 段</Button> : null}
    {hasHistory && expanded ? <SegmentHistory item={item} rate={rate} compact onDetail={onDetail} /> : null}
  </div>;
}

export default function ReconciliationPage() {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const [config, setConfig] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState("yesterday");
  const [activeWindow, setActiveWindow] = useState<any>({ preset: "yesterday" });
  const [range, setRange] = useState<any>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const upstreamId = Form.useWatch("upstreamStationId", form);
  const [keyData, setKeyData] = useState<any>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [channelsRefreshing, setChannelsRefreshing] = useState(false);
  const [channelsError, setChannelsError] = useState("");
  const configRequestId = useRef(0);
  const channelRefreshRequestId = useRef(0);
  const channelDiscoveryInFlight = useRef(false);
  const keyRequestId = useRef(0);
  const windowRequestId = useRef(0);
  const windowRequestInFlight = useRef(false);
  const ruleRetryRequestId = useRef(new Map<string, number>());
  const resultEpoch = useRef(0);
  const rowResultEpoch = useRef(new Map<string, { epoch: number; window: any }>());
  const summaryRequestId = useRef(0);
  const [summaryStale, setSummaryStale] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [saving, setSaving] = useState(false);
  const [rulePreview, setRulePreview] = useState<RuleEditPreview | null>(null);
  const [ruleBatch, setRuleBatch] = useState<BatchInput | null>(null);
  const [previewingRule, setPreviewingRule] = useState(false);
  const [ruleFormError, setRuleFormError] = useState("");
  const rulePreviewEpoch = useRef(0);
  const coverageAnswer = Form.useWatch("coverageAnswer", form);
  const otherUse = Form.useWatch("otherUse", form);
  const [transitionAt, setTransitionAt] = useState<any>(null);
  const [transitionSegmentId, setTransitionSegmentId] = useState<string | null>(null);
  const [transitionSegments, setTransitionSegments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [retryingRuleIds, setRetryingRuleIds] = useState<Set<string>>(new Set());
  const [ruleRetryErrors, setRuleRetryErrors] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDirectory, setHistoryDirectory] = useState<any[] | null>(null);
  const [historyDirectoryBusy, setHistoryDirectoryBusy] = useState(false);
  const [historyDirectoryError, setHistoryDirectoryError] = useState("");
  const [historyRuleId, setHistoryRuleId] = useState<string | null>(null);
  const [historyRange, setHistoryRange] = useState<any>(null);
  const [historyRangeChanged, setHistoryRangeChanged] = useState(false);
  const [confirmedHistory, setConfirmedHistory] = useState<ConfirmedHistoryResponse | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const historyRequestId = useRef(0);
  const historyRequest = useRef<{ ruleId: string; range: { startMs: number; endMs: number } | null; cursor: string | null } | null>(null);

  const rate = config?.ownStation?.cnyPerUsd ?? null;
  const results = data?.results || [];
  const windowGroups: ReconciliationWindowGroup[] = data?.windowGroups || [];
  const commonSummary: ReconciliationSummary | null = data?.commonSummary || null;
  const coverage: KnownChannelCoverage | null = data?.coverage || null;
  const latestSuccessful = results.filter((item: any) => item.lastSuccessfulAt).reduce((latest: any, item: any) => !latest || Date.parse(item.lastSuccessfulAt) > Date.parse(latest.lastSuccessfulAt) ? item : latest, null);
  const freshness = summarizeReconciliationFreshness(results);
  const requestedWindows = results.map((item: any) => item.requestedWindow || item.window).filter(Boolean);
  const sharedWindow = requestedWindows[0] && requestedWindows.every((window: any) => window.startMs === requestedWindows[0].startMs && window.endMs === requestedWindows[0].endMs && window.timezone === requestedWindows[0].timezone)
    ? requestedWindows[0]
    : null;
  const displayTimezone = sharedWindow?.timezone || "Asia/Shanghai";
  const summaryReference = Boolean(data && (error || querying || summaryStale || retryingRuleIds.size));
  const filteredResults = useMemo(() => filterReconciliationResults(results, config?.upstreams, search, statusFilter), [results, config?.upstreams, search, statusFilter]);
  const windowMetrics = (totals: ReconciliationWindowGroup["totals"]) => <div className="reconciliation-summary__metrics">
    <SummaryMetric label="本站已获取收费（USD）" value={money(totals.knownIncomeUsd, null)} />
    <SummaryMetric label="已计入上游成本（USD）" value={money(totals.knownCostUsd, null)} />
    <SummaryMetric label="已确认范围账面毛利" value={money(totals.confirmedProfitUsd, null)} tone={totals.confirmedProfitUsd == null ? "" : totals.confirmedProfitUsd < 0 ? "danger" : "success"} />
    <SummaryMetric label="已确认范围毛利率" value={percent(totals.confirmedMarginRate)} />
  </div>;
  const filterCounts = useMemo(() => results.reduce((counts: any, item: any) => {
    const flags = reconciliationRowFlags(item);
    counts.all += 1;
    if (flags.attention || flags.negative) counts.attention += 1;
    if (flags.negative) counts.negative += 1;
    if (flags.pending) counts.pending += 1;
    return counts;
  }, { all: 0, attention: 0, negative: 0, pending: 0 }), [results]);
  const pageSize = compact ? 4 : 10;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredResults.length / pageSize)));

  const loadConfiguration = async (refreshChannels = false) => {
    const requestId = ++configRequestId.current;
    const next = await api(`/api/reconciliation/configuration${refreshChannels ? "?refreshChannels=true" : ""}`);
    if (requestId !== configRequestId.current) return null;
    setConfig((previous: any) => refreshChannels && next.channelsError && previous
      ? { ...next, channels: previous.channels }
      : next);
    return next;
  };

  const loadHistoryDirectory = async () => {
    setHistoryDirectoryBusy(true); setHistoryDirectoryError("");
    try { const next = await api("/api/reconciliation/configuration?includeArchived=true"); setHistoryDirectory(next.rules || []); }
    catch (err: any) { setHistoryDirectoryError(err.message || "历史规则目录读取失败"); }
    finally { setHistoryDirectoryBusy(false); }
  };
  const loadConfirmedHistory = async (ruleId: string, range: { startMs: number; endMs: number } | null = null, cursor: string | null = null) => {
    const requestId = ++historyRequestId.current; historyRequest.current = { ruleId, range, cursor }; setHistoryBusy(true); setHistoryError("");
    const params = new URLSearchParams({ limit: "20" });
    if (range) { params.set("startMs", String(range.startMs)); params.set("endMs", String(range.endMs)); }
    if (cursor) params.set("cursor", cursor);
    try {
      const next: ConfirmedHistoryResponse = await api(`/api/reconciliation/rules/${encodeURIComponent(ruleId)}/confirmed?${params}`);
      if (requestId !== historyRequestId.current) return;
      setHistoryRangeChanged(false);
      setConfirmedHistory((previous) => { const records = cursor ? [...(previous?.records || []), ...next.records] : next.records; return { ...next, records: records.filter((record, index) => records.findIndex((item) => item.historyId === record.historyId) === index) }; });
    } catch (err: any) { if (requestId === historyRequestId.current) setHistoryError(err.message || "确认账单历史读取失败"); }
    finally { if (requestId === historyRequestId.current) setHistoryBusy(false); }
  };
  const selectedHistoryRange = () => historyRange?.[0] && historyRange?.[1] ? { startMs: historyRange[0].valueOf(), endMs: historyRange[1].valueOf() } : null;
  const chooseHistoryRule = (id: string) => {
    setHistoryRuleId(id); setConfirmedHistory(null); setExpandedHistoryId(null); setHistoryRangeChanged(false); void loadConfirmedHistory(id, selectedHistoryRange());
  };
  const openConfirmedHistory = (id?: string) => {
    setDetail(null); setHistoryOpen(true);
    if (!historyDirectory && !historyDirectoryBusy) void loadHistoryDirectory();
    if (id && id !== historyRuleId) { setHistoryRange(null); setHistoryRangeChanged(false); setHistoryRuleId(id); setConfirmedHistory(null); setExpandedHistoryId(null); void loadConfirmedHistory(id); }
  };
  const historyWindowLabel = (record: ConfirmedHistoryRecord) => record.window.timezone
    ? `${formatWindow(record.window)}（${record.window.timezone}）`
    : `${new Date(record.window.startMs).toISOString()} — ${new Date(record.window.endMs).toISOString()} · 原时区未保存`;
  const historyDetails = (record: ConfirmedHistoryRecord) => <div style={{ display: "grid", gap: 12, width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
    {record.sourceCompleteness === "legacy_partial" ? <Alert type="warning" showIcon message="旧记录信息不完整" description="仅显示原存储区间与已保存金额；缺失的原来源、时区或范围未知，不能据此认定完整自然日。" /> : null}
    <Detail label="原账单窗口" value={historyWindowLabel(record)} />
    <Detail label="原本站来源" value={record.ownSource ? `${record.ownSource.provider} · ${record.ownSource.baseUrl} · 账号 ${record.ownSource.accountId} · ${record.ownSource.stationId} · ${record.ownSource.namespaceKey}` : "原本站来源未保存"} />
    <Detail label="原上游来源" value={`${record.upstreamSource.provider || "原平台未保存"} · ${record.upstreamSource.baseUrl || "原地址未保存"} · 账号 ${record.upstreamSource.accountId ?? "未保存"}`} />
    <Detail label="原 Key / 范围" value={`${record.upstreamSource.tokenName ?? "原 Key 名称未保存"} · #${record.upstreamSource.tokenId ?? "未保存"} · 范围版本 ${record.scopeVersion ?? "未保存"}`} />
    <Detail label="原关联渠道" value={record.channels.map(channelLabel).join("、") || "原关联渠道未保存"} />
    <Detail label="原生效边界" value={record.billingEffectiveFromMs == null ? "原生效边界未保存" : new Date(record.billingEffectiveFromMs).toISOString()} />
    <Detail label="原收费 / 成本 / 账面毛利" value={`${billingAmountText(record.downstream, null)} / ${billingAmountText(record.upstream, null)} / ${money(record.calculation.profitUsd, null)}`} />
    <Detail label="原毛利率" value={percent(record.calculation.marginRate)} />
    <Detail label="原账单计量" value={`${record.amountBasis.currency} · ${record.amountBasis.billingSource} · 计算版本 ${record.amountBasis.calculationVersion} · ${record.amountBasis.conversion === "quota_per_unit" ? "配额 ÷ 单位" : record.amountBasis.conversion === "provider_cost_usd" ? "上游美元账单" : "原换算依据未保存"}`} />
    <Detail label="原收费计量 / 成本计量" value={`${reconciliationBillingBasis(record.downstream)} / ${reconciliationBillingBasis(record.upstream)}`} />
    <Detail label="确认保存时间" value={record.confirmedAt} />
  </div>;

  const refreshChannelOptions = async () => {
    if (channelDiscoveryInFlight.current) return;
    channelDiscoveryInFlight.current = true;
    const requestId = ++channelRefreshRequestId.current;
    setChannelsRefreshing(true);
    setChannelsError("");
    try {
      const next = await loadConfiguration(true);
      if (requestId === channelRefreshRequestId.current && next?.channelsError) setChannelsError(next.channelsError);
    } catch {
      if (requestId === channelRefreshRequestId.current) setChannelsError("本站渠道刷新失败，请稍后重试");
    } finally {
      channelDiscoveryInFlight.current = false;
      if (requestId === channelRefreshRequestId.current) setChannelsRefreshing(false);
    }
  };

  const readWindow = (window: any) => {
    const params = new URLSearchParams({ preset: window.preset });
    if (window.startMs != null) params.set("startMs", String(window.startMs));
    if (window.endMs != null) params.set("endMs", String(window.endMs));
    return api(`/api/reconciliation?${params}`);
  };

  const refreshSummary = async (window = activeWindow, windowEpoch = windowRequestId.current) => {
    const requestId = ++summaryRequestId.current;
    const responseEpoch = ++resultEpoch.current;
    setSummaryStale(true); setSummaryError("");
    try {
      const next = await readWindow(window);
      if (requestId !== summaryRequestId.current || windowEpoch !== windowRequestId.current) return;
      const newerRows = new Set((next.results || []).filter((row: any) => {
        const current = rowResultEpoch.current.get(String(row.rule?.id));
        return current?.epoch! > responseEpoch && sameWindow(current?.window, row.window);
      }).map((row: any) => String(row.rule?.id)));
      setData((previous: any) => ({ ...next, results: (next.results || []).map((row: any) => {
        const id = String(row.rule?.id), current = previous?.results?.find((item: any) => String(item.rule?.id) === id);
        if (newerRows.has(id) && sameWindow(current?.window, row.window)) return current;
        rowResultEpoch.current.set(id, { epoch: responseEpoch, window: row.window }); return row;
      }) }));
      if (newerRows.size) void refreshSummary(window, windowEpoch);
      else setSummaryStale(false);
    } catch (err: any) {
      if (requestId === summaryRequestId.current && windowEpoch === windowRequestId.current) setSummaryError(err?.message || "全量汇总读取失败");
    }
  };

  const loadWindow = async (window = activeWindow, force = false) => {
    if (!force && windowRequestInFlight.current) return null;
    const requestId = ++windowRequestId.current;
    summaryRequestId.current += 1;
    const responseEpoch = ++resultEpoch.current;
    windowRequestInFlight.current = true;
    setQuerying(true);
    try {
      const next = force ? await api("/api/reconciliation/query", { method: "POST", body: window }) : await readWindow(window);
      if (requestId === windowRequestId.current) {
        setData((previous: any) => {
          const previousRows = new Map((previous?.results || []).map((item: any) => [String(item?.rule?.id), item]));
          const rows = (next?.results || []).map((item: any) => {
            const id = String(item?.rule?.id || "");
            const previousRow: any = previousRows.get(id);
            const previousWindow = previousRow?.window;
            const nextWindow = item?.window;
            if (id && rowResultEpoch.current.get(id)?.epoch! > responseEpoch && sameWindow(previousWindow, nextWindow)) return previousRow || item;
            if (id) rowResultEpoch.current.set(id, { epoch: responseEpoch, window: item.window });
            return item;
          });
          return { ...next, results: rows };
        });
        setSummaryError("");
        const hasNewerRows = (next.results || []).some((item: any) => {
          const current = rowResultEpoch.current.get(String(item.rule?.id));
          return current?.epoch! > responseEpoch && sameWindow(current?.window, item.window);
        });
        setSummaryStale(hasNewerRows);
        if (hasNewerRows) void refreshSummary(window, requestId);
        setError("");
        return next;
      }
      return null;
    } catch (err: any) {
      if (requestId === windowRequestId.current) setError(err?.message || "对账数据加载失败");
      return null;
    } finally {
      if (requestId === windowRequestId.current) {
        windowRequestInFlight.current = false;
        setQuerying(false);
        setLoading(false);
      }
    }
  };

  const retryRule = async (item: any) => {
    const id = String(item?.rule?.id || "");
    const window = item?.requestedWindow || item?.window;
    if (!id || !window?.startMs || !window?.endMs) return;
    const requestId = (ruleRetryRequestId.current.get(id) || 0) + 1;
    ruleRetryRequestId.current.set(id, requestId);
    const requestWindowEpoch = windowRequestId.current;
    const responseEpoch = ++resultEpoch.current;
    setRetryingRuleIds((previous) => new Set(previous).add(id));
    setRuleRetryErrors((previous) => ({ ...previous, [id]: "" }));
    try {
      const next = await api("/api/reconciliation/query", { method: "POST", body: { preset: "custom", startMs: window.startMs, endMs: window.endMs, ruleIds: [id] } });
      const replacement = (next?.results || []).find((candidate: any) => String(candidate?.rule?.id) === id);
      const replacementWindow = replacement?.requestedWindow || replacement?.window;
      if (requestId !== ruleRetryRequestId.current.get(id) || requestWindowEpoch !== windowRequestId.current || !replacement || !sameWindow(window, replacementWindow)) return;
      setData((previous: any) => {
        const current = (previous?.results || []).find((candidate: any) => String(candidate?.rule?.id) === id);
        const currentWindow = current?.requestedWindow || current?.window;
        if (!current || !sameWindow(window, currentWindow)) return previous;
        rowResultEpoch.current.set(id, { epoch: responseEpoch, window: replacement.window });
        return { ...previous, results: previous.results.map((candidate: any) => String(candidate?.rule?.id) === id ? replacement : candidate) };
      });
      setDetail((current: any) => String(current?.rule?.id) === id ? replacement : current);
      void refreshSummary(activeWindow, requestWindowEpoch);
    } catch (err: any) {
      if (requestId === ruleRetryRequestId.current.get(id) && requestWindowEpoch === windowRequestId.current) setRuleRetryErrors((previous) => ({ ...previous, [id]: err?.message || "重试失败，请稍后再试" }));
    } finally {
      if (requestId === ruleRetryRequestId.current.get(id)) setRetryingRuleIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await loadConfiguration(true);
        await loadWindow({ preset: "yesterday" });
      } catch (err: any) {
        setError(err?.message || "初始化失败");
        setLoading(false);
      }
    })();
  // 仅首屏初始化；后续查询由按钮和定时器驱动。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeWindow.preset !== "today" || !config) return;
    const timer = setInterval(() => loadWindow(activeWindow), 30000);
    const onVisible = () => { if (!document.hidden) loadWindow(activeWindow); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow.preset, config]);

  const query = async (force = true) => {
    if (preset === "custom") {
      if (!range?.[0] || !range?.[1]) return message.warning("请先选择开始与结束时间");
      const next = { preset: "custom", startMs: range[0].valueOf(), endMs: range[1].valueOf() };
      setActiveWindow(next);
      await loadWindow(next, true);
      return;
    }
    const next = { preset };
    setActiveWindow(next);
    await loadWindow(next, force);
  };

  const fetchKeys = async (id: string, force = false) => {
    const requestId = ++keyRequestId.current;
    setKeyLoading(true);
    try {
      const next = await api(`/api/reconciliation/upstreams/${encodeURIComponent(id)}/keys${force ? "?force=true" : ""}`);
      if (keyRequestId.current === requestId) setKeyData(next);
      return next;
    } catch (err: any) {
      if (keyRequestId.current === requestId) {
        setKeyData(null);
        message.error(err?.message || "读取上游 Key 失败");
      }
      return null;
    } finally {
      if (keyRequestId.current === requestId) setKeyLoading(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    keyRequestId.current += 1;
    setKeyData(null);
    setKeyLoading(false);
    form.resetFields();
    form.setFieldsValue({ timezone: "Asia/Shanghai", coverageAnswer: "unknown" });
    rulePreviewEpoch.current += 1;
    setRulePreview(null); setRuleBatch(null); setRuleFormError("");
    setDrawerOpen(true);
    void refreshChannelOptions();
  };

  const openEdit = (rule: any) => {
    setEditing(rule);
    setKeyData({
      tokens: [{ id: Number(rule.tokenId), name: rule.tokenName, group: rule.fixedGroup, status: 1, crossGroupRetry: false }],
      groups: {},
    });
    form.setFieldsValue({
      upstreamStationId: rule.upstreamStationId,
      tokenId: rule.tokenId,
      salesChannelIds: (rule.channels || []).map((channel: any) => Number(channel.channelId)),
      timezone: rule.timezone || "Asia/Shanghai",
      coverageAnswer: "unknown", otherUse: "unspecified", uncoveredOwnChannelIds: [],
    });
    rulePreviewEpoch.current += 1;
    setRulePreview(null); setRuleBatch(null); setRuleFormError("");
    setDrawerOpen(true);
    void refreshChannelOptions();
  };

  const ruleInput = (values: any) => ({
    upstreamStationId: values.upstreamStationId, tokenId: Number(values.tokenId),
    salesChannelIds: values.salesChannelIds.map(Number), timezone: values.timezone,
    coverageDeclaration: { answer: values.coverageAnswer || "unknown", otherUse: values.coverageAnswer === "other_use" ? values.otherUse || "unspecified" : null, uncoveredOwnChannelIds: values.coverageAnswer === "other_use" && values.otherUse === "own_channels" ? values.uncoveredOwnChannelIds || [] : [] } as CoverageDeclaration,
  });
  const previewRule = async () => {
    setRuleFormError("");
    try {
      const values = await form.validateFields(), body = ruleInput(values), current = ++rulePreviewEpoch.current;
      setPreviewingRule(true);
      if (editing) {
        const next: RuleEditPreview = await api(`/api/reconciliation/rules/${encodeURIComponent(editing.id)}/preview`, { body });
        if (current === rulePreviewEpoch.current) setRulePreview(next);
      } else {
        const catalogue = await api("/api/channel-onboarding");
        if (catalogue.stale || !catalogue.ownStation) throw new Error("渠道目录待刷新，请发现新渠道后重新预览");
        const input: BatchInput = { requestId: crypto.randomUUID(), ownStationId: catalogue.ownStation.id,
          selections: [{ selectionId: "rule-account", stationId: body.upstreamStationId, monitor: false }],
          groups: [{ groupId: "rule-key", selectionId: "rule-account", channels: body.salesChannelIds.map((id: number) => {
            const channel = catalogue.channels.find((entry: any) => entry.id === id);
            if (!channel?.revision) throw new Error(`渠道 #${id} 目录待刷新`);
            return { channelId: id, channelRevision: channel.revision };
          }), reconciliation: { tokenId: body.tokenId, timezone: body.timezone, coverageDeclaration: body.coverageDeclaration } }] };
        const next: BatchProbe = await api("/api/channel-onboarding/batch/probe", { body: input });
        const group = next.groups[0];
        if (group.status !== "ready") throw new Error(group.reason || "账单能力待验证，请在渠道接入中补齐授权");
        if (current === rulePreviewEpoch.current) { setRuleBatch(input); setRulePreview({ previewId: next.previewId, groupId: group.groupId, expiresAtMs: next.expiresAtMs, basis: group.basis, preview: group.preview }); }
      }
    } catch (err: any) { if (!err.errorFields) setRuleFormError(err.message || "预览失败，请重试"); setRulePreview(null); }
    finally { setPreviewingRule(false); }
  };
  const saveRule = async (values: any) => {
    if (!rulePreview || Date.now() >= rulePreview.expiresAtMs) { setRulePreview(null); return setRuleFormError("预览已失效，请重新预览修改"); }
    setSaving(true); setRuleFormError("");
    try {
      if (editing) await api(`/api/reconciliation/rules/${encodeURIComponent(editing.id)}`, { method: "PUT", body: { ...ruleInput(values), previewId: rulePreview.previewId, groupId: rulePreview.groupId } });
      else {
        const next = await api("/api/channel-onboarding/batch", { body: { ...ruleBatch, previewId: rulePreview.previewId } });
        if (!next.complete) throw new Error(next.groups?.find((group: any) => !group.complete)?.reason || "账单关联尚未完成，请重新预览后重试");
      }
      message.success(editing ? "对账规则已更新" : "对账规则已创建");
      setDrawerOpen(false);
      await Promise.all([loadConfiguration(), loadWindow(activeWindow, true)]);
    } catch (err: any) {
      setRuleFormError(err?.message || "保存规则失败，请重新预览"); setRulePreview(null);
    } finally { setSaving(false); }
  };

  const stopRule = async (id: string) => {
    try {
      const { release } = await api(`/api/reconciliation/rules/${id}`, { method: "DELETE" });
      message.success(`已停止对账规则，已释放 Key ${release.tokenName}（${release.fixedGroup}）及 ${release.releasedChannelCount} 个销售渠道`);
      await Promise.all([loadConfiguration(), loadWindow(activeWindow, true)]);
      return true;
    } catch (err: any) { message.error(err?.message || "停止规则失败"); return false; }
  };

  const correctTransition = async () => {
    const segment = transitionSegments.find((item: any) => item.id === transitionSegmentId);
    if (!detail?.rule?.id || !segment?.id || !transitionAt) return message.warning("请选择实际切换时间");
    try {
      await api(`/api/reconciliation/rules/${detail.rule.id}/transitions/${segment.id}`, { method: "PUT", body: { effectiveAt: transitionAt.valueOf() } });
      message.success("切换时间已修正，正在重新核算");
      setTransitionAt(null);
      const next = await loadWindow(activeWindow, true);
      const refreshed = next?.results?.find((item: any) => item.rule?.id === detail.rule.id);
      if (refreshed) setDetail(refreshed);
      const history = await api(`/api/reconciliation/rules/${detail.rule.id}/segments`);
      const unconfirmed = (history.segments || []).filter((item: any) => item.timingSource === "detected");
      setTransitionSegments(history.segments || []);
      setTransitionSegmentId(unconfirmed[0]?.id || null);
    } catch (err: any) { message.error(err?.message || "修正切换时间失败"); }
  };

  const openDetail = async (item: any) => {
    setDetail(item);
    setTransitionAt(null);
    const fallback = item.transitionSegments || item.segments || [];
    setTransitionSegments(fallback);
    setTransitionSegmentId(fallback.find((segment: any) => segment.timingSource === "detected")?.id || null);
    try {
      const history = await api(`/api/reconciliation/rules/${item.rule.id}/segments`);
      const all = history.segments || [];
      setTransitionSegments(all);
      setTransitionSegmentId(all.find((segment: any) => segment.timingSource === "detected")?.id || null);
    } catch (err: any) {
      message.warning(err?.message || "未能读取完整分段历史");
    }
  };

  const unavailableChannels = useMemo(() => {
    const map = new Map<number, string>();
    for (const rule of config?.rules || []) {
      if (!rule.enabled || rule.id === editing?.id) continue;
      for (const channel of rule.channels || []) map.set(Number(channel.channelId), rule.tokenName || rule.id);
    }
    return map;
  }, [config, editing]);

  const columns: any[] = [
    { title: "状态", key: "status", width: 112, render: (_: any, item: any) => statusTag(item) },
    { title: "上游 / Key", key: "upstream", width: 180, sorter: (a: any, b: any) => upstreamName(a.rule, config?.upstreams).localeCompare(upstreamName(b.rule, config?.upstreams)), render: (_: any, item: any) => <span className="reconciliation-table-identity"><strong>{upstreamName(item.rule, config?.upstreams)}</strong><small>{item.rule?.tokenName || "未命名 Key"}</small></span> },
    { title: "当前分组 / 上游倍率", key: "group", width: 185, sorter: (a: any, b: any) => currentGroup(a).localeCompare(currentGroup(b)), render: (_: any, item: any) => { const history = ruleHistory(item); return <span className="reconciliation-table-group">{currentGroup(item)} · {currentRatioLabel(item)}{hasReconciliationHistory(history) ? <small>变更历史 · {history.length} 段</small> : null}</span>; } },
    { title: "关联渠道", key: "channels", width: 190, sorter: (a: any, b: any) => (a.rule?.channels?.length || 0) - (b.rule?.channels?.length || 0), render: (_: any, item: any) => { const channels = mergeReconciliationChannels(item.rule?.channels, item.downstream?.channels); return <span className="reconciliation-table-channels">{channels.map(channelLabel).join("、") || "—"}{channels.length ? <small>{channelStateSummary(channels)}</small> : null}</span>; } },
    { title: "本站收费", key: "income", width: 128, align: "right", sorter: (a: any, b: any) => Number(a.downstream?.knownAmountUsd ?? a.downstream?.amountUsd ?? 0) - Number(b.downstream?.knownAmountUsd ?? b.downstream?.amountUsd ?? 0), render: (_: any, item: any) => <span className="reconciliation-table-amount">{billingAmountText(item.downstream, rate)}{item.downstream?.state !== "complete" ? <small>{billingCoverageText(item.downstream)}</small> : null}</span> },
    { title: "上游成本", key: "cost", width: 128, align: "right", sorter: (a: any, b: any) => Number(a.upstream?.knownAmountUsd ?? a.upstream?.amountUsd ?? 0) - Number(b.upstream?.knownAmountUsd ?? b.upstream?.amountUsd ?? 0), render: (_: any, item: any) => <span className="reconciliation-table-amount">{billingAmountText(item.upstream, rate)}{item.upstream?.state !== "complete" ? <small>{billingCoverageText(item.upstream)}</small> : null}</span> },
    { title: "确认利润", key: "profit", width: 128, align: "right", sorter: (a: any, b: any) => Number(calculationValues(a.calculation, a.health, a).profitUsd || 0) - Number(calculationValues(b.calculation, b.health, b).profitUsd || 0), render: (_: any, item: any) => { const profit = calculationValues(item.calculation, item.health, item).profitUsd; return <strong className={`reconciliation-table-amount ${profit == null ? "" : Number(profit) < 0 ? "reconciliation-amount--danger" : "reconciliation-amount--success"}`}>{profit == null ? "待核算" : money(profit, rate)}</strong>; } },
    { title: "毛利率", key: "margin", width: 94, align: "right", sorter: (a: any, b: any) => Number(calculationValues(a.calculation, a.health, a).marginRate || 0) - Number(calculationValues(b.calculation, b.health, b).marginRate || 0), render: (_: any, item: any) => { const margin = calculationValues(item.calculation, item.health, item).marginRate; return <span className={`reconciliation-table-amount ${margin == null ? "" : Number(margin) < 0 ? "reconciliation-amount--danger" : ""}`}>{percent(margin)}</span>; } },
    { title: "最近成功", key: "recent", width: 120, align: "right", sorter: (a: any, b: any) => Number(new Date(a.lastSuccessfulAt || 0)) - Number(new Date(b.lastSuccessfulAt || 0)), render: (_: any, item: any) => <span className="reconciliation-table-amount">{formatRecentTime(item.lastSuccessfulAt, item.window?.timezone)}</span> },
    { title: "操作", key: "actions", width: 116, align: "center", render: (_: any, item: any) => <Space direction="vertical" size={0} onClick={(event) => event.stopPropagation()}>
      <Space size={0}><Button type="link" size="small" aria-label={`查看 ${item.rule?.tokenName || "Key"} 的对账详情`} onClick={() => openDetail(item)}>详情</Button><Button type="link" size="small" loading={retryingRuleIds.has(item.rule?.id)} aria-label={`重试 ${item.rule?.tokenName || "Key"} 的当前账单`} onClick={() => retryRule(item)}>重试</Button><Dropdown trigger={["click"]} menu={{ items: [{ key: "edit", label: "编辑规则" }, { key: "stop", label: "停止并释放", danger: true }], onClick: ({ key, domEvent }: any) => { domEvent.stopPropagation(); if (key === "edit") openEdit(item.rule); else modal.confirm({ title: "停止并释放此对账规则？", content: "停止后会释放此 Key 和关联销售渠道；历史快照会保留。", okText: "停止并释放", okButtonProps: { danger: true }, cancelText: "取消", onOk: () => stopRule(item.rule.id) }); } }}><Button type="text" icon={<MoreOutlined />} aria-label={`操作 ${item.rule?.tokenName || "Key"} 的规则`} /></Dropdown></Space>
      {ruleRetryErrors[item.rule?.id] ? <Text type="danger" style={{ fontSize: 12 }}>{ruleRetryErrors[item.rule.id]}</Text> : null}
    </Space> },
  ];

  if (loading) return <AppState kind="loading" title="正在读取渠道对账" description="正在汇总上游实际消费与本站渠道收费。" />;

  if (!config && error) {
    return <AppState kind="error" title="无法加载渠道对账" description={error} actions={<Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>} />;
  }

  if (!config?.ownStation && !results.length && !historyOpen) {
    return <AppState kind="empty" title="还不能开始对账" description="请先在上游资源中标记一个自己的 NewAPI 管理员站点，用于读取本站渠道收费。" actions={<Space wrap><Button type="primary" onClick={() => window.location.assign("/stations")}>前往上游资源</Button><Button onClick={() => openConfirmedHistory()}>查看已确认账单历史</Button></Space>} />;
  }

  if (!data && error) {
    return <AppState kind="error" title="无法读取对账数据" description={error} actions={<Button type="primary" loading={querying} onClick={() => loadWindow(activeWindow, true)}>重新查询</Button>} />;
  }

  return (
    <PageContainer
      className="responsive-page reconciliation-page"
      title="上游渠道对账"
      subTitle="核对上游成本与本站收费，监控利润情况"
      extra={<div className="page-toolbar"><Button className="reconciliation-primary-action" type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!config?.ownStation} aria-label="添加对账规则"><span>添加规则</span></Button></div>}
    >
      <ChannelOnboarding compact={compact}
        onComplete={async () => { await loadConfiguration(); await loadWindow(activeWindow, true); }} />
      <div className="reconciliation-controls">
        <div className="reconciliation-controls__date">
          {preset === "custom"
            ? <RangePicker showTime value={range} onChange={(value) => setRange(value)} aria-label="自定义对账时间" />
            : <span>{sharedWindow ? formatWindow(sharedWindow) : results.length ? "按各规则时区计算，具体时间见详情" : "选择时间范围后查询"}</span>}
          {sharedWindow ? <small>（{sharedWindow.timezone}）</small> : null}
        </div>
        <div className="reconciliation-controls__presets mobile-scroll">
          <Segmented options={PRESETS} value={preset} onChange={(value) => setPreset(String(value))} />
        </div>
        <div className="reconciliation-controls__actions">
          <Button type="primary" className="reconciliation-query-action" loading={querying} onClick={() => query(true)}>查询</Button>
          <Button className="reconciliation-query-action" icon={<ReloadOutlined />} loading={querying} onClick={() => loadWindow(activeWindow, true)} aria-label="刷新当前对账窗口">刷新</Button>
        </div>
      </div>

      <Button style={{ minHeight: 44, marginBottom: 12 }} onClick={() => openConfirmedHistory()}>查看已确认账单历史</Button>
      {data ? <div className="reconciliation-freshness"><Text type="secondary">{summaryReference ? "参考结果生成" : "显示结果生成"}：{formatRecentTime(data.generatedAt, displayTimezone, true)}（{displayTimezone}）</Text>{results.length ? <Text type="secondary">{summaryReference ? `上次成功窗口：${sharedWindow ? formatWindow(sharedWindow) : "见各规则详情"}（仅供参考）` : freshness.staleCount ? `${freshness.staleCount} 条规则数据已过期${sharedWindow && freshness.coverageEndMs != null ? ` · 最早金额覆盖至 ${formatTime(freshness.coverageEndMs, sharedWindow.timezone)}` : ""}` : latestSuccessful ? `最近成功：${formatRecentTime(latestSuccessful.lastSuccessfulAt, latestSuccessful.window?.timezone)}（${latestSuccessful.window?.timezone || "Asia/Shanghai"}）` : "暂未成功（当前读取失败）"}</Text> : null}</div> : null}
      {error ? <Alert type="error" showIcon message="对账数据加载失败 · 当前显示上次结果" description={`${error}。下方窗口与金额属于上次查询，非本次查询结果。`} action={<Button size="small" onClick={() => loadWindow(activeWindow, true)}>重试</Button>} className="reconciliation-inline-alert" /> : null}
      {!config?.ownStation && results.length ? <Alert type="warning" showIcon message="本站管理员站点未配置" description="本站收费当前不可获取；已保存规则仍显示可用的上游成本与历史参考。请先配置本站管理员站点后再添加或更新规则。" action={<Button size="small" onClick={() => window.location.assign("/stations")}>前往配置</Button>} className="reconciliation-inline-alert" /> : null}
      {config?.channelsError ? <Alert type="warning" showIcon message={config.channelsError} className="reconciliation-inline-alert" /> : null}
      {summaryError ? <Alert type="warning" showIcon message="全量汇总读取失败 · 摘要仅供参考" description={summaryError} action={<Button onClick={() => void refreshSummary()}>重读全量汇总</Button>} className="reconciliation-inline-alert" /> : null}

      <section className="reconciliation-summary" aria-label="对账汇总">
        {summaryReference ? <Alert type="info" showIcon message="全量摘要仅供参考，正在核对当前窗口" description="规则列表保留已读金额；全量读取完成后再显示当前汇总。" /> : commonSummary ? windowMetrics(commonSummary.totals) : <Text strong>暂无共同整日汇总</Text>}
        <p className="reconciliation-summary__note">{commonSummary?.totals.profitComplete ? "已知渠道范围的完整账单。" : "仅已确认范围的金额，不代表全站完整利润。"} 金额按 USD 汇总；本站收费来源：{RECONCILIATION_BILLING_SOURCE_LABEL}。今天与未完成日的金额仅供参考。</p>
      </section>
      {windowGroups.length ? <Collapse style={{ marginBottom: 16 }} items={windowGroups.map((group) => ({ key: group.groupKey, label: <span>账单窗口 · {formatWindow({ ...group.window, timezone: group.timezones[0] })} · {group.timezones.join(" / ")}{summaryReference ? " · 参考" : ""}</span>, children: <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <Detail label="绝对窗口" value={`${new Date(group.window.startMs).toISOString()} — ${new Date(group.window.endMs).toISOString()}`} />
        <Detail label="本站来源" value={group.ownSource ? `${group.ownSource.provider} · ${group.ownSource.baseUrl} · 账号 ${group.ownSource.accountId} · ${group.ownSource.namespaceKey}` : "来源待核对"} />
        <Detail label="金额口径" value={`${group.amountBasis.currency} · ${group.amountBasis.billingSource} · 计算版本 ${group.amountBasis.calculationVersion} · ${group.amountBasis.conversion || "换算依据待核验"}`} />
        <Detail label="规则范围" value={group.ruleIds.join("、")} />
        {windowMetrics(group.totals)}
        <Text type="secondary">{summaryReference ? "本组金额仅供参考。" : group.totals.profitComplete ? "已知范围完整账单。" : "已确认范围小计，完整性待确认。"} 已核算 {group.coverage.accountedChannelCount}/{group.coverage.knownChannelCount} 个已知渠道。{group.totals.notCountedCostRuleIds.length ? `未计入成本的规则：${group.totals.notCountedCostRuleIds.join("、")}。` : ""}</Text>
      </div> }))} /> : null}
      {coverage ? <section aria-label="已知渠道覆盖" style={{ marginBottom: 16, minWidth: 0 }}>
        <Alert type={coverage.state === "complete_known" ? "success" : "warning"} showIcon message={`${summaryReference ? "参考 · " : ""}已知渠道覆盖：已核算 ${coverage.accountedChannelCount}/${coverage.knownChannelCount}`} description={`${coverage.catalogueState === "verified" ? "当前目录已核验" : "当前目录覆盖未知"}；全站历史渠道全集未核验。搜索、筛选和分页不改变此覆盖统计。`} />
        <Collapse style={{ marginTop: 8 }} items={[{ key: "known-coverage", label: "查看全部已知渠道与未核算原因", children: <div style={{ display: "grid", gap: 12, minWidth: 0, overflowWrap: "anywhere" }}>{coverage.channels.map((channel, index) => <div key={`${channel.ownSource?.namespaceKey || channel.ownStationId}:${channel.channelId}:${index}`}>
          <Text strong>{channel.name} · ID {channel.channelId}</Text> <Tag color={channel.status === "accounted" ? "success" : "warning"}>{({ accounted: "已核算", unlinked: "未关联", not_effective: "范围未生效", source_unverified: "来源待核验", billing_missing: "账单未齐", coverage_unknown: "Key 用途待确认", duplicate: "重复归属" })[channel.status]}</Tag>
          <div>{channelStateLabel[channel.operatingState] || "状态未知"} · 本站 {channel.ownStationId} · 规则 {channel.ruleIds.join("、") || "无"}</div>
          {channel.issues.length ? <div>{channel.issues.map((issue) => issue === "CHANNEL_UNLINKED" ? "尚未关联账单规则" : issue === "BILLING_EVIDENCE_NOT_QUERIED" ? "该窗口账单证据尚未读取" : HEALTH_LABEL(issue)).join("；")}</div> : null}
          {channel.actions.length ? <Text type="secondary">待处理：{channel.actions.map((action) => action.label).join("；")}</Text> : null}
        </div>)}</div> }]} />
      </section> : null}

      <div className="reconciliation-list-tools">
        <Input className="reconciliation-search" prefix={<SearchOutlined />} allowClear value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); setExpandedRuleId(null); }} placeholder="搜索上游、Key、渠道名称或 ID" aria-label="搜索上游、Key、渠道名称或 ID" />
        <div className="reconciliation-status-filter mobile-scroll">
          <Segmented value={statusFilter} onChange={(value) => { setStatusFilter(String(value)); setPage(1); setExpandedRuleId(null); }} options={[
            { label: `全部 ${filterCounts.all}`, value: "all" },
            { label: `需处理 ${filterCounts.attention}`, value: "attention" },
            { label: `负毛利 ${filterCounts.negative}`, value: "negative" },
            { label: `切换待确认 ${filterCounts.pending}`, value: "pending" },
          ]} />
        </div>
      </div>

      {!error && results.length > 0 && filterCounts.attention === 0 ? <Alert type="success" showIcon message={`全部 ${results.length} 条规则暂无需处理事项`} className="reconciliation-inline-alert" /> : null}

      {!results.length ? <div className="reconciliation-empty"><Empty description="还没有启用的对账规则" image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" disabled={!config?.ownStation} onClick={openCreate}>创建第一条规则</Button></Empty></div>
        : !filteredResults.length ? <div className="reconciliation-empty"><Empty description={statusFilter === "attention" && !search ? "当前无需处理事项" : "没有匹配的对账规则"} image={Empty.PRESENTED_IMAGE_SIMPLE}><Button onClick={() => { setSearch(""); setStatusFilter("all"); setPage(1); }}>查看全部规则</Button></Empty></div>
        : compact ? <>
          <div className="reconciliation-mobile-list">
            {filteredResults.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((item: any) => <RuleMobileItem key={item.rule?.id} item={item} rate={rate} upstreams={config?.upstreams} onDetail={() => openDetail(item)} onRetry={() => retryRule(item)} retrying={retryingRuleIds.has(item.rule?.id)} retryError={ruleRetryErrors[item.rule?.id]} expanded={expandedRuleId === item.rule?.id} onExpand={() => setExpandedRuleId(expandedRuleId === item.rule?.id ? null : item.rule?.id)} />)}
          </div>
          <div className="reconciliation-mobile-pagination">
            <span>显示 {Math.min(filteredResults.length, currentPage * pageSize)} / {filteredResults.length} 条规则</span>
            <Space size={6}><Button disabled={currentPage <= 1} onClick={() => { setPage(currentPage - 1); setExpandedRuleId(null); }}>上一页</Button><Button disabled={currentPage * pageSize >= filteredResults.length} onClick={() => { setPage(currentPage + 1); setExpandedRuleId(null); }}>下一页 <RightOutlined /></Button></Space>
          </div>
        </> : <Table
          className="reconciliation-table"
          size="small"
          dataSource={filteredResults}
          columns={columns}
          rowKey={(item: any) => item.rule?.id}
          rowClassName={(item: any) => hasReconciliationHistory(ruleHistory(item)) ? "reconciliation-row--expandable" : ""}
          scroll={{ x: 1300 }}
          expandable={{
            expandedRowKeys: expandedRuleId ? [expandedRuleId] : [],
            rowExpandable: (item: any) => hasReconciliationHistory(ruleHistory(item)),
            expandedRowRender: (item: any) => <SegmentHistory item={item} rate={rate} compact={false} onDetail={() => openDetail(item)} />,
            onExpand: (expanded: boolean, item: any) => setExpandedRuleId(expanded ? item.rule?.id : null),
            expandRowByClick: true,
          }}
          pagination={{ current: currentPage, pageSize, showSizeChanger: false, total: filteredResults.length, showTotal: (total, range) => `显示 ${range[0]}–${range[1]} / ${total} 条规则` }}
          onChange={(pagination) => { setPage(pagination.current || 1); setExpandedRuleId(null); }}
          onRow={(item: any) => ({ tabIndex: hasReconciliationHistory(ruleHistory(item)) ? 0 : undefined, onKeyDown: (event: any) => { if (hasReconciliationHistory(ruleHistory(item)) && event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setExpandedRuleId(expandedRuleId === item.rule?.id ? null : item.rule?.id); } } })}
        />}

      <Drawer className="reconciliation-detail-drawer" title={historyOpen ? "已确认账单历史" : detail?.rule?.tokenName ? `${detail.rule.tokenName} · 对账详情` : "对账详情"} open={historyOpen || !!detail} onClose={() => { setDetail(null); setHistoryOpen(false); historyRequestId.current += 1; setHistoryBusy(false); }} width={compact ? "100%" : 520} aria-label={historyOpen ? "已确认账单历史抽屉" : "对账详情抽屉"} extra={detail && !historyOpen ? <Space size={4}><Button type="text" icon={<EditOutlined />} aria-label={`编辑 ${detail.rule?.tokenName || "Key"} 的规则`} onClick={() => { openEdit(detail.rule); setDetail(null); }} /><Popconfirm title="停止并释放此对账规则？" description="停止后会释放 Key 和关联渠道，历史快照保留。" okText="停止并释放" cancelText="取消" onConfirm={async () => { if (await stopRule(detail.rule.id)) setDetail(null); }}><Button danger type="text" icon={<DeleteOutlined />} aria-label={`停止并释放 ${detail.rule?.tokenName || "Key"} 的规则`} /></Popconfirm></Space> : null}>
        {historyOpen ? <div style={{ display: "grid", gap: 16, width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
          <Alert type="info" showIcon message="只读原确认账单，不计入当前汇总" description="保留原窗口、来源、Key 和成员；规则目录当前名称仅用于定位，不填补旧记录。默认读取最近 31 天，每页 20 条，日期范围最多 31 天。" />
          {historyDirectoryError ? <Alert type="warning" showIcon message="历史规则目录读取失败" description={historyDirectoryError} action={<Button aria-label="重试历史规则目录" onClick={() => void loadHistoryDirectory()}>重试</Button>} /> : null}
          <div style={{ width: "100%", minWidth: 0 }}><Text>历史账单规则（含已停止规则）</Text><Select aria-label="历史账单规则" showSearch optionFilterProp="label" loading={historyDirectoryBusy} value={historyRuleId} style={{ width: "100%", minWidth: 0, marginTop: 6 }} placeholder="选择当前或已停止的规则" options={(historyDirectory || config?.rules || []).map((rule: any) => ({ value: rule.id, label: `${rule.tokenName || `Key ${rule.tokenId ?? "未命名"}`} · ${rule.archivedAt || !rule.enabled ? "已停止 / 归档" : "当前规则"} · ${rule.id}` }))} onChange={chooseHistoryRule} /></div>
          <div style={{ width: "100%", minWidth: 0 }}><RangePicker aria-label="已确认账单历史日期" showTime value={historyRange} style={{ width: "100%", minWidth: 0 }} onChange={(value) => { historyRequestId.current += 1; setHistoryBusy(false); setHistoryRange(value); setHistoryRangeChanged(true); setHistoryError(""); setExpandedHistoryId(null); }} /></div>
          {historyRangeChanged && confirmedHistory ? <Alert type="info" showIcon message="日期已修改，下方保留上次读取记录" description="请查询所选日期；读取成功后替换为该范围的原账单。" /> : null}
          <Button style={{ minHeight: 44 }} disabled={!historyRuleId} loading={historyBusy} onClick={() => historyRuleId && void loadConfirmedHistory(historyRuleId, selectedHistoryRange())}>查询已确认历史</Button>
          {historyError ? <Alert type="error" showIcon message="确认账单历史读取失败" description={`${historyError}。已读记录继续保留。`} action={<Button aria-label="重试确认账单历史" onClick={() => { const request = historyRequest.current; if (request) void loadConfirmedHistory(request.ruleId, request.range, request.cursor); }}>重试</Button>} /> : null}
          {confirmedHistory?.records.length ? compact ? <div style={{ width: "100%", minWidth: 0 }}>{confirmedHistory.records.map((record) => <Collapse key={record.historyId} ghost style={{ marginBottom: 8 }} items={[{ key: record.historyId, label: <div><strong>{record.upstreamSource.tokenName ?? "原 Key 名称未保存"} · 原范围 {record.scopeVersion ?? "未保存"}</strong><div>{historyWindowLabel(record)}</div><div>原记录毛利 {money(record.calculation.profitUsd, null)}</div>{record.sourceCompleteness === "legacy_partial" ? <Tag color="warning">旧记录信息不完整</Tag> : null}</div>, children: <div data-history-id={record.historyId}>{historyDetails(record)}</div> }]} />)}</div> : <Table className="reconciliation-history-table" size="small" rowKey="historyId" dataSource={confirmedHistory.records} pagination={false} scroll={{ x: 880 }} columns={[
            { title: "原窗口 / 范围", width: 250, render: (_: any, record: ConfirmedHistoryRecord) => <div>{historyWindowLabel(record)}<div>原范围版本 {record.scopeVersion ?? "未保存"}</div>{record.sourceCompleteness === "legacy_partial" ? <Tag color="warning">旧记录信息不完整</Tag> : null}</div> },
            { title: "原 Key / 渠道", width: 220, render: (_: any, record: ConfirmedHistoryRecord) => <div>{record.upstreamSource.tokenName ?? "原 Key 名称未保存"}<div>{record.channels.map(channelLabel).join("、") || "原渠道未保存"}</div></div> },
            { title: "原收费", width: 110, render: (_: any, record: ConfirmedHistoryRecord) => billingAmountText(record.downstream, null) },
            { title: "原成本", width: 110, render: (_: any, record: ConfirmedHistoryRecord) => billingAmountText(record.upstream, null) },
            { title: "原记录毛利", width: 110, render: (_: any, record: ConfirmedHistoryRecord) => money(record.calculation.profitUsd, null) },
          ]} expandable={{ expandedRowKeys: expandedHistoryId ? [expandedHistoryId] : [], onExpand: (expanded, record) => setExpandedHistoryId(expanded ? record.historyId : null), expandedRowRender: (record) => <div data-history-id={record.historyId}>{historyDetails(record)}</div> }} onRow={(record) => ({ tabIndex: 0, onKeyDown: (event) => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); setExpandedHistoryId(expandedHistoryId === record.historyId ? null : record.historyId); } } })} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={historyBusy ? "正在读取原确认账单" : historyError ? "历史读取失败，请重试" : confirmedHistory ? "所选范围没有已保存的确认账单" : historyRuleId ? "请选择日期并查询原确认账单" : "请选择历史账单规则"} />}
          {confirmedHistory ? <Text type="secondary">已读取 {confirmedHistory.records.length} 条原确认记录 · 仅 USD 原账，不使用当前汇率换算。</Text> : null}
          {confirmedHistory?.nextCursor ? <Button style={{ minHeight: 44 }} disabled={historyRangeChanged} loading={historyBusy} onClick={() => historyRuleId && void loadConfirmedHistory(historyRuleId, historyRequest.current?.range || null, confirmedHistory.nextCursor)}>读取更多原确认账单</Button> : null}
        </div> : detail ? <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Button style={{ minHeight: 44 }} onClick={() => openConfirmedHistory(detail.rule.id)}>查看已确认账单历史</Button>
          <Alert type={reconciliationHealthMeta(detail.health?.code).tone === "error" || reconciliationRowFlags(detail).negative ? "error" : detail.health?.code === "READY" ? "success" : "warning"} showIcon message={reconciliationHealthMeta(detail.health?.code).tone === "error" ? detail.health?.label || reconciliationHealthMeta(detail.health?.code).label : reconciliationRowFlags(detail).negative ? "该规则确认利润为负" : detail.health?.label} description={detail.health?.detail || "数据来源正常"} />
          <Detail label="请求窗口" value={`${formatWindow(detail.requestedWindow || detail.window)}（${(detail.requestedWindow || detail.window)?.timezone}）`} />
          <Detail label="返回账单实际窗口" value={`${formatWindow(detail.window)}（${detail.window?.timezone}）`} />
          {detail.upstream?.window && !sameWindow(detail.upstream.window, detail.window) ? <Detail label="上游原账单窗口" value={`${formatWindow(detail.upstream.window)}（${detail.upstream.window.timezone}）`} /> : null}
          {detail.downstream?.window && !sameWindow(detail.downstream.window, detail.window) ? <Detail label="本站原账单窗口" value={`${formatWindow(detail.downstream.window)}（${detail.downstream.window.timezone}）`} /> : null}
          {detail.health?.stale ? <Detail label="成功金额覆盖窗口" value={`${formatWindow(detail.lastSuccessfulWindow || detail.window)}（${(detail.lastSuccessfulWindow || detail.window)?.timezone}）`} /> : null}
          <Detail label="上游账号" value={upstreamName(detail.rule, config?.upstreams)} />
          <Detail label="上游 Key / 分组" value={`${detail.rule?.tokenName || "—"} · ${detail.upstream?.group || detail.currentSegment?.group || detail.rule?.fixedGroup || "—"}`} />
          <Detail label="关联销售渠道" value={(detail.rule?.channels?.length ? detail.rule.channels : detail.downstream?.channels || []).map(channelLabel).join("、") || "未配置渠道"} />
          {detail.scope ? <><Detail label="当前核算范围版本" value={String(detail.scope.scopeVersion ?? "未知")} /><Detail label="当前范围完整日生效" value={detail.scope.billingEffectiveFromMs == null ? "未知" : new Date(detail.scope.billingEffectiveFromMs).toISOString()} /><Detail label="首个完整账单可查询" value={detail.scope.firstQueryableAtMs == null ? "未知" : new Date(detail.scope.firstQueryableAtMs).toISOString()} /></> : null}
          {detail.billingTimezone ? <Detail label="账单时区能力" value={`${detail.billingTimezone.timezone} · ${detail.billingTimezone.state === "verified" ? "已核验" : "待核验，原金额仅供参考"}${detail.billingTimezone.reason ? ` · ${detail.billingTimezone.reason}` : ""}`} /> : null}
          <Detail label="当前倍率" value={currentRatioLabel(detail)} />
          <Detail label="本站收费" value={`${billingAmountText(detail.downstream, rate)} · ${billingCoverageText(detail.downstream)}`} />
          <Detail label="上游成本" value={`${billingAmountText(detail.upstream, rate)} · ${billingCoverageText(detail.upstream)}`} />
          <Detail label={calculationValues(detail.calculation, detail.health, detail).confirmed ? "确认利润" : "风险差额（未计入确认利润）"} value={money(calculationValues(detail.calculation, detail.health, detail).confirmed ? calculationValues(detail.calculation, detail.health, detail).profitUsd : calculationValues(detail.calculation, detail.health, detail).riskDifferenceUsd, rate)} />
          <Detail label="毛利率" value={percent(calculationValues(detail.calculation, detail.health, detail).marginRate)} />
          <Collapse size="small" ghost items={[{ key: "billing-basis", label: "查看原始账单与计算依据", children: <Space direction="vertical" size={10}>
            <Detail label="本站收费（美元原值）" value={reconciliationBillingBasis(detail.segments?.length === 1 ? detail.downstream : { state: detail.downstream?.state, amountUsd: detail.downstream?.amountUsd, knownAmountUsd: detail.downstream?.knownAmountUsd })} />
            <Detail label="上游成本（美元原值）" value={reconciliationBillingBasis(detail.segments?.length === 1 ? detail.upstream : { state: detail.upstream?.state, amountUsd: detail.upstream?.amountUsd, knownAmountUsd: detail.upstream?.knownAmountUsd })} />
            <Detail label={calculationValues(detail.calculation, detail.health, detail).confirmed ? "确认利润（美元原值）" : "风险差额（美元原值）"} value={reconciliationBillingBasis({ state: "complete", amountUsd: calculationValues(detail.calculation, detail.health, detail).confirmed ? calculationValues(detail.calculation, detail.health, detail).profitUsd : calculationValues(detail.calculation, detail.health, detail).riskDifferenceUsd })} />
            <Text type="secondary" style={{ fontSize: 12 }}>利润 = 本站收费 − 上游成本；毛利率 = 利润 ÷ 本站收费。计算使用未舍入金额，跨分段时先分别核算再汇总。</Text>
          </Space> }]} />
          <Detail label="本站收费来源" value={detail.downstream?.knownAmountUsd == null && detail.downstream?.amountUsd == null ? "未取得" : detail.downstream.billingSource === RECONCILIATION_BILLING_SOURCE ? RECONCILIATION_BILLING_SOURCE_LABEL : "旧版来源（待重新核算）"} />
          <Detail label="渠道账单覆盖" value={billingCoverageText(detail.downstream)} />
          {detail.lastConfirmed ? <><Detail label="最近完整账单（仅参考）" value={`${formatRecentTime(detail.lastConfirmed.generatedAt, detail.lastConfirmed.window?.timezone, true)} · ${formatWindow(detail.lastConfirmed.window)}`} /><Detail label="参考收费 / 成本" value={`${money(detail.lastConfirmed.downstream?.amountUsd, rate)} / ${money(detail.lastConfirmed.upstream?.amountUsd, rate)}（不计入当前汇总）`} /></> : null}
          {(detail.health?.issues || []).map((issue: any, index: number) => <Alert key={`${issue.code}-${index}`} type={reconciliationHealthMeta(issue.code).tone === "error" ? "error" : "warning"} showIcon message={HEALTH_LABEL(issue.code)} description={issue.detail} />)}
          {transitionSegments.some((segment: any) => segment.timingSource === "detected") ? <Space wrap>
            <Select value={transitionSegmentId} onChange={setTransitionSegmentId} placeholder="选择待确认的切换分段" style={{ minWidth: compact ? "100%" : 230 }} options={transitionSegments.filter((segment: any) => segment.timingSource === "detected").map((segment: any) => ({ value: segment.id, label: `${segment.group} · ${formatWindow(segment.window || { startMs: segment.effectiveFrom, endMs: segment.effectiveTo ?? Date.now(), timezone: detail.window?.timezone || detail.rule?.timezone })}` }))} />
            <DatePicker showTime value={transitionAt} onChange={(value) => setTransitionAt(value)} placeholder="实际切换时间" />
            <Button onClick={correctTransition}>修正切换时间</Button>
          </Space> : null}
          <ChannelBreakdown item={detail} rate={rate} />
        </Space> : null}
      </Drawer>

      <Drawer title={editing ? "编辑对账规则" : "添加对账规则"} open={drawerOpen} onClose={() => { rulePreviewEpoch.current += 1; setDrawerOpen(false); }} width={compact ? "100%" : 520} aria-label={editing ? "编辑对账规则抽屉" : "添加对账规则抽屉"} closable={!saving && !previewingRule} maskClosable={!saving && !previewingRule} keyboard={!saving && !previewingRule} extra={<Button className="reconciliation-primary-action" type="primary" loading={saving} disabled={!rulePreview || previewingRule} htmlType="submit" form="reconciliation-rule-form" aria-label="保存对账规则">{editing ? "确认修改" : "确认关联"}</Button>}>
        <Form id="reconciliation-rule-form" form={form} layout="vertical" requiredMark={false} disabled={saving || previewingRule} onFinish={saveRule} onValuesChange={() => { rulePreviewEpoch.current += 1; setRulePreview(null); setRuleFormError(""); }}>
          {editing ? <Alert type="info" showIcon message="规则身份不可修改" description="上游账号或 Key 需要更换时，请停止当前规则后创建新规则；当前历史账单会继续保留。" style={{ marginBottom: 16 }} /> : null}
          <Form.Item label="上游账号" name="upstreamStationId" extra={editing ? "已锁定，避免新账号重算当前规则的历史账单。" : "复用该站点已有 PAT，不需要再次填写。"} rules={[{ required: true, message: "请选择上游账号" }]}>
            <Select showSearch optionFilterProp="label" disabled={!!editing} placeholder="选择已配置的 NewAPI 上游站点" options={(config?.upstreams || []).map((station: any) => ({ value: station.id, label: station.name }))} onChange={(value) => { form.setFieldValue("tokenId", undefined); setKeyData(null); fetchKeys(value, true); }} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          <Form.Item label="固定分组 Key" name="tokenId" extra={editing ? "已锁定；同一 Key 的分组或倍率变化由系统自动记录为新分段。" : "仅显示固定分组、未启用跨组重试且当前可用的 Key。"} rules={[{ required: true, message: "请选择固定分组 Key" }]}>
            <Select showSearch optionFilterProp="label" loading={keyLoading} disabled={!!editing || !upstreamId || keyLoading} placeholder={upstreamId ? "选择上游 Key" : "请先选择上游账号"} options={(keyData?.tokens || []).map((item: any) => ({ value: item.id, disabled: item.status !== 1 || item.group === "auto" || item.crossGroupRetry, label: `${item.name} · ${item.group || "无分组"}${keyData?.groups?.[item.group]?.ratio != null ? ` · ${keyData.groups[item.group].ratio}×` : ""}` }))} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          <Form.Item label="本站销售渠道" name="salesChannelIds" extra={<span>一个渠道同一时刻只能归属一条启用规则。<Button type="link" size="small" loading={channelsRefreshing} onClick={() => void refreshChannelOptions()}>刷新渠道</Button></span>} rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个本站渠道" }]}>
            <Select showSearch optionFilterProp="label" mode="multiple" loading={channelsRefreshing} disabled={channelsRefreshing || !!channelsError} placeholder={channelsRefreshing ? "正在刷新本站渠道" : "选择一个或多个渠道"} options={(config?.channels || []).map((channel: any) => {
              const occupiedBy = unavailableChannels.get(Number(channel.id));
              return { value: Number(channel.id), disabled: !!occupiedBy, label: `${channelLabel(channel)}${occupiedBy ? `（已用于 ${occupiedBy}）` : ""}` };
            })} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          {channelsError ? <Alert type="error" showIcon message={channelsError} style={{ marginBottom: 16 }} /> : null}
          <Form.Item label="对账时区" name="timezone" extra="真实范围变更从下一共同完整自然日生效。">
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Form.Item label="除以上渠道外，这把 Key 是否还用于本站其他渠道或站外调用？" name="coverageAnswer">
            <Select aria-label="规则 Key 消费范围" options={[{ value: "none", label: "没有" }, { value: "other_use", label: "有" }, { value: "unknown", label: "不确定" }]} />
          </Form.Item>
          {coverageAnswer === "other_use" ? <><Form.Item label="其他用途" name="otherUse"><Select options={[{ value: "own_channels", label: "本站其他渠道" }, { value: "external", label: "站外调用" }, { value: "unspecified", label: "尚未明确" }]} /></Form.Item>{otherUse === "own_channels" ? <Form.Item label="尚未纳入的本站渠道" name="uncoveredOwnChannelIds"><Select mode="multiple" options={(config?.channels || []).map((channel: any) => ({ value: channel.id, label: channelLabel(channel) }))} /></Form.Item> : null}</> : null}
          {coverageAnswer !== "none" ? <Text type="secondary">保留收费与成本参考，账面毛利待确认。{otherUse === "external" ? "请隔离调用 Key 后重新关联。" : "移除渠道后仍使用这把 Key 的渠道也需在完整用途中说明。"}</Text> : null}
          <Alert type="info" showIcon message="核算口径" description="该规则汇总完整上游成本与全部所选渠道收费。渠道子项只展示收费占比，不分摊成本。" />
          {ruleFormError ? <Alert type="error" showIcon message={ruleFormError} style={{ marginTop: 16 }} /> : null}
          <Button style={{ minHeight: 44, marginTop: 16 }} loading={previewingRule} disabled={saving} onClick={() => void previewRule()} aria-label="预览对账规则">{editing ? "预览修改" : "验证并预览关联"}</Button>
          {rulePreview ? <Alert type="info" showIcon style={{ marginTop: 16 }} message={editing ? "规则修改预览，尚未保存" : "Key 完整范围预览，尚未保存"} description={<Space direction="vertical"><Text>原渠道：{rulePreview.basis.existingChannelIds.map((id) => `#${id}`).join("、") || "无"}</Text><Text>最终渠道：{rulePreview.basis.proposedChannelIds.map((id) => `#${id}`).join("、")}</Text>{editing ? <Text>释放渠道：{rulePreview.basis.existingChannelIds.filter((id) => !rulePreview.basis.proposedChannelIds.includes(id)).map((id) => `#${id}`).join("、") || "无"}；原账单保留。</Text> : null}<Text>完整日生效：{formatRecentTime(rulePreview.preview.billingEffectiveFromMs, rulePreview.basis.timezone, false, true)}（{rulePreview.basis.timezone}）</Text><Text>首个完整账单可查询：{formatRecentTime(rulePreview.preview.firstQueryableAtMs, rulePreview.basis.timezone, false, true)}</Text><Text>{rulePreview.preview.costCoverage === "complete" ? "已声明这把 Key 没有其他用途" : "Key 用途待确认，金额作为参考"}</Text></Space>} /> : null}
        </Form>
      </Drawer>
    </PageContainer>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><Text type="secondary" style={{ display: "block", fontSize: 12 }}>{label}</Text><Text strong style={{ fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{value}</Text></div>;
}

function HEALTH_LABEL(code: string) {
  if (code === "GROUP_DATA_UNAVAILABLE") return "当前上游分组目录不可用";
  if (code === "PERSISTENCE_FAILED") return "对账结果保存失败";
  return reconciliationHealthMeta(code).label || code;
}
