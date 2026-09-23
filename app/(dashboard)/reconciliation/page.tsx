"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer } from "@ant-design/pro-components";
import {
  Alert, App, Button, Collapse, DatePicker, Drawer, Dropdown, Empty, Form, Grid, Input, List,
  Pagination, Popconfirm, Segmented, Select, Space, Table, Tag, Typography,
} from "antd";
import { DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import { api } from "../../../lib/client";
import {
  formatReconciliationMoney as money,
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  filterReconciliationResults,
  reconciliationBillingBasis,
  reconciliationCalculationValues as calculationValues,
  reconciliationRowFlags,
  summarizeReconciliationTotals,
  summarizeReconciliationFreshness,
} from "../../../lib/reconciliation-view";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_BILLING_SOURCE_LABEL,
  reconciliationHealthMeta,
} from "../../../lib/reconciliation-contract";
import AppState from "../../components/app-state";

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

function formatRecentTime(value: any, timezone?: string, includeSeconds = false) {
  if (value == null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone || "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" } : {}) }).format(date);
}

function hasSegmentChanges(segments: any[] = []) {
  return segments.slice(1).some((segment, index) => {
    const previous = segments[index];
    if (segment.group !== previous.group) return true;
    if (previous.ratio == null || segment.ratio == null) return false;
    const previousRatio = Number(previous.ratio);
    const nextRatio = Number(segment.ratio);
    return Number.isFinite(previousRatio) && Number.isFinite(nextRatio) && previousRatio !== nextRatio;
  });
}

function segmentWindow(segment: any, timezone?: string) {
  return segment?.window || {
    startMs: segment?.effectiveFrom,
    endMs: segment?.effectiveTo ?? Date.now(),
    timezone: segment?.timezone || timezone,
  };
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
            <Text strong style={{ fontVariantNumeric: "tabular-nums" }}>{money(channel.amountUsd, rate)}</Text>
            <Tag color={channel.state === "enabled" ? "success" : channel.state === "missing" ? "error" : "warning"}>{channelStateLabel[channel.state] || "状态未知"}</Tag>
          </Space>
        </div>
      ))}
    </div>
  );
}

function SegmentTimeline({ segments, rate, timezone }: { segments: any[]; rate: any; timezone?: string }) {
  if (!segments.length) return null;
  return <List
    size="small"
    header="变更历史"
    dataSource={segments.slice().reverse()}
    renderItem={(segment: any) => <List.Item>
      <Space direction="vertical" size={2} style={{ width: "100%" }}>
        <Text strong>{formatWindow(segmentWindow(segment, timezone))} · {segment.group || "分组未知"} · {ratioLabel(segment.ratio)}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{segment.timingSource === "operator_confirmed" ? "已人工确认" : segment.timingSource === "detected" ? "暂按检测时间生效" : "历史初始分段"}</Text>
        {segment.ratioSource === "group_catalog" ? <Text type="secondary" style={{ fontSize: 12 }}>倍率由上游分组目录观察补录{segment.ratioObservedAt ? `（${formatTime(segment.ratioObservedAt, timezone)}）` : ""}，不代表历史切换时刻</Text> : null}
        <Space wrap size="middle" style={{ fontVariantNumeric: "tabular-nums" }}>
          {(() => { const values = calculationValues(segment.calculation, segment.health); return <><Text>收费 {money(segment.downstream?.amountUsd, rate)}</Text><Text>成本 {money(segment.upstream?.amountUsd, rate)}</Text><Text>{values.confirmed ? "利润" : "风险差额"} {money(values.confirmed ? values.profitUsd : values.riskDifferenceUsd, rate)}</Text><Text>毛利率 {percent(values.marginRate)}</Text></>; })()}
        </Space>
      </Space>
    </List.Item>}
  />;
}

function currentGroup(item: any) {
  return item?.currentSegment?.group || item?.upstream?.group || item?.rule?.fixedGroup || "未返回";
}

function currentRatio(item: any) {
  return item?.currentSegment?.ratio ?? item?.upstream?.ratio;
}

function channelStateSummary(channels: any[]) {
  const enabled = channels.filter((channel) => channel.state === "enabled").length;
  const disabled = channels.filter((channel) => channel.state === "manual_disabled" || channel.state === "auto_disabled").length;
  const missing = channels.filter((channel) => channel.state === "missing").length;
  const unknown = channels.length - enabled - disabled - missing;
  return `启用 ${enabled} · 禁用 ${disabled} · 缺失 ${missing}${unknown ? ` · 未知 ${unknown}` : ""}`;
}

function SummaryMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="reconciliation-summary-metric">
    <span className="reconciliation-summary-metric__label">{label}</span>
    <strong className={tone ? `reconciliation-summary-metric__value reconciliation-amount--${tone}` : "reconciliation-summary-metric__value"}>{value}</strong>
  </div>;
}

function RuleMobileItem({ item, rate, upstreams, onDetail }: { item: any; rate: any; upstreams: any; onDetail: () => void }) {
  const rule = item.rule || {};
  const channels = mergeReconciliationChannels(rule.channels, item.downstream?.channels);
  const calculation = calculationValues(item.calculation, item.health);
  const profit = calculation.profitUsd == null ? null : Number(calculation.profitUsd);
  const tone = profit == null || !Number.isFinite(profit) ? "" : profit < 0 ? "danger" : "success";
  return <button type="button" className="reconciliation-mobile-row" onClick={onDetail}>
    <span className="reconciliation-mobile-row__top">
      <span className="reconciliation-mobile-row__identity">
        <strong>{upstreamName(rule, upstreams)}</strong>
        <span>Key：{rule.tokenName || "未命名 Key"}</span>
        <span>现用分组：{currentGroup(item)} · {ratioLabel(currentRatio(item))}</span>
      </span>
      <span className="reconciliation-mobile-row__finance">
        {statusTag(item)}
        <strong className={tone ? `reconciliation-amount--${tone}` : ""}>{money(calculation.profitUsd, rate)}</strong>
        <span className={tone ? `reconciliation-amount--${tone}` : ""}>{percent(calculation.marginRate)}</span>
      </span>
      <RightOutlined className="reconciliation-mobile-row__chevron" aria-hidden="true" />
    </span>
    <span className="reconciliation-mobile-row__bottom">收费 {money(item.downstream?.amountUsd, rate)} <span aria-hidden="true">·</span> 成本 {money(item.upstream?.amountUsd, rate)} <span aria-hidden="true">·</span> {channels.length} 个渠道</span>
    {channels.length ? <span className="reconciliation-mobile-row__channels">{channels.map((channel: any) => channel.name || `渠道 ${channel.channelId || channel.id}`).join("、")} · {channelStateSummary(channels)}</span> : null}
  </button>;
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
  const [preset, setPreset] = useState("today");
  const [activeWindow, setActiveWindow] = useState<any>({ preset: "today" });
  const [range, setRange] = useState<any>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();
  const upstreamId = Form.useWatch("upstreamStationId", form);
  const [keyData, setKeyData] = useState<any>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const keyRequestId = useRef(0);
  const windowRequestId = useRef(0);
  const windowRequestInFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [transitionAt, setTransitionAt] = useState<any>(null);
  const [transitionSegmentId, setTransitionSegmentId] = useState<string | null>(null);
  const [transitionSegments, setTransitionSegments] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  const rate = config?.ownStation?.cnyPerUsd ?? null;
  const results = data?.results || [];
  const detailTimelineSegments = mergeReconciliationSegments(detail?.transitionSegments, detail?.segments, transitionSegments);
  const totals = useMemo(() => summarizeReconciliationTotals(results), [results]);
  const totalDifference = totals.profitComplete ? totals.profit : null;
  const totalMargin = totals.profitComplete && totals.incomeComplete && totals.income > 0 ? totalDifference / totals.income : null;
  const riskItems = useMemo(() => results.flatMap((item: any) => {
    const issues = item?.health?.issues?.length ? item.health.issues : item?.health?.code !== "READY" ? [{ code: item?.health?.code, detail: item?.health?.detail }] : [];
    return issues.map((issue: any) => ({ ...issue, rule: item.rule }));
  }), [results]);
  const latestSuccessful = results.filter((item: any) => item.lastSuccessfulAt).reduce((latest: any, item: any) => !latest || Date.parse(item.lastSuccessfulAt) > Date.parse(latest.lastSuccessfulAt) ? item : latest, null);
  const freshness = summarizeReconciliationFreshness(results);
  const requestedWindows = results.map((item: any) => item.requestedWindow || item.window).filter(Boolean);
  const sharedWindow = requestedWindows[0] && requestedWindows.every((window: any) => window.startMs === requestedWindows[0].startMs && window.endMs === requestedWindows[0].endMs && window.timezone === requestedWindows[0].timezone)
    ? requestedWindows[0]
    : null;
  const displayTimezone = sharedWindow?.timezone || "Asia/Shanghai";
  const filteredResults = useMemo(() => filterReconciliationResults(results, config?.upstreams, search, statusFilter), [results, config?.upstreams, search, statusFilter]);
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

  const loadConfiguration = async () => {
    const next = await api("/api/reconciliation/configuration");
    setConfig(next);
    return next;
  };

  const loadWindow = async (window = activeWindow, force = false) => {
    if (!force && windowRequestInFlight.current) return null;
    const requestId = ++windowRequestId.current;
    windowRequestInFlight.current = true;
    setQuerying(true);
    try {
      let next;
      if (window.preset === "today" && !force) {
        next = await api("/api/reconciliation?preset=today");
      } else {
        next = await api("/api/reconciliation/query", { method: "POST", body: window });
      }
      if (requestId === windowRequestId.current) {
        setData(next);
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

  useEffect(() => {
    (async () => {
      try {
        await loadConfiguration();
        await loadWindow({ preset: "today" });
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
    form.setFieldsValue({ timezone: "Asia/Shanghai" });
    setDrawerOpen(true);
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
    });
    setDrawerOpen(true);
  };

  const saveRule = async (values: any) => {
    setSaving(true);
    try {
      const body = {
        upstreamStationId: values.upstreamStationId,
        tokenId: Number(values.tokenId),
        salesChannelIds: values.salesChannelIds.map(Number),
        timezone: values.timezone,
      };
      const path = editing ? `/api/reconciliation/rules/${editing.id}` : "/api/reconciliation/rules";
      await api(path, { method: editing ? "PUT" : "POST", body });
      message.success(editing ? "对账规则已更新" : "对账规则已创建");
      setDrawerOpen(false);
      await Promise.all([loadConfiguration(), loadWindow({ preset: "today" }, true)]);
    } catch (err: any) {
      message.error(err?.message || "保存规则失败");
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
    { title: "当前分组", key: "group", width: 175, sorter: (a: any, b: any) => currentGroup(a).localeCompare(currentGroup(b)), render: (_: any, item: any) => <span className="reconciliation-table-group">{currentGroup(item)} · {ratioLabel(currentRatio(item))}</span> },
    { title: "关联渠道", key: "channels", width: 190, sorter: (a: any, b: any) => (a.rule?.channels?.length || 0) - (b.rule?.channels?.length || 0), render: (_: any, item: any) => { const channels = mergeReconciliationChannels(item.rule?.channels, item.downstream?.channels); return <span className="reconciliation-table-channels">{channels.map((channel: any) => channel.name || `渠道 ${channel.channelId || channel.id}`).join("、") || "—"}{channels.length ? <small>{channelStateSummary(channels)}</small> : null}</span>; } },
    { title: "本站收费", key: "income", width: 128, align: "right", sorter: (a: any, b: any) => Number(a.downstream?.amountUsd || 0) - Number(b.downstream?.amountUsd || 0), render: (_: any, item: any) => <span className="reconciliation-table-amount">{money(item.downstream?.amountUsd, rate)}</span> },
    { title: "上游成本", key: "cost", width: 128, align: "right", sorter: (a: any, b: any) => Number(a.upstream?.amountUsd || 0) - Number(b.upstream?.amountUsd || 0), render: (_: any, item: any) => <span className="reconciliation-table-amount">{money(item.upstream?.amountUsd, rate)}</span> },
    { title: "确认利润", key: "profit", width: 128, align: "right", sorter: (a: any, b: any) => Number(calculationValues(a.calculation, a.health).profitUsd || 0) - Number(calculationValues(b.calculation, b.health).profitUsd || 0), render: (_: any, item: any) => { const profit = calculationValues(item.calculation, item.health).profitUsd; return <strong className={`reconciliation-table-amount ${profit == null ? "" : Number(profit) < 0 ? "reconciliation-amount--danger" : "reconciliation-amount--success"}`}>{money(profit, rate)}</strong>; } },
    { title: "毛利率", key: "margin", width: 94, align: "right", sorter: (a: any, b: any) => Number(calculationValues(a.calculation, a.health).marginRate || 0) - Number(calculationValues(b.calculation, b.health).marginRate || 0), render: (_: any, item: any) => { const margin = calculationValues(item.calculation, item.health).marginRate; return <span className={`reconciliation-table-amount ${margin == null ? "" : Number(margin) < 0 ? "reconciliation-amount--danger" : ""}`}>{percent(margin)}</span>; } },
    { title: "最近成功", key: "recent", width: 120, align: "right", sorter: (a: any, b: any) => Number(new Date(a.lastSuccessfulAt || 0)) - Number(new Date(b.lastSuccessfulAt || 0)), render: (_: any, item: any) => <span className="reconciliation-table-amount">{formatRecentTime(item.lastSuccessfulAt, item.window?.timezone)}</span> },
    { title: "", key: "actions", width: 48, align: "center", render: (_: any, item: any) => <Dropdown trigger={["click"]} menu={{ items: [{ key: "detail", label: "查看详情" }, { key: "edit", label: "编辑规则" }, { key: "stop", label: "停止并释放", danger: true }], onClick: ({ key, domEvent }: any) => { domEvent.stopPropagation(); if (key === "detail") openDetail(item); else if (key === "edit") openEdit(item.rule); else modal.confirm({ title: "停止并释放此对账规则？", content: "停止后会释放此 Key 和关联销售渠道；历史快照会保留。", okText: "停止并释放", okButtonProps: { danger: true }, cancelText: "取消", onOk: () => stopRule(item.rule.id) }); } }}><Button type="text" icon={<MoreOutlined />} aria-label={`操作 ${item.rule?.tokenName || "Key"} 的规则`} onClick={(event) => event.stopPropagation()} /></Dropdown> },
  ];

  if (loading) return <AppState kind="loading" title="正在读取渠道对账" description="正在汇总上游实际消费与本站渠道收费。" />;

  if (!config && error) {
    return <AppState kind="error" title="无法加载渠道对账" description={error} actions={<Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>} />;
  }

  if (!config?.ownStation) {
    return <AppState kind="empty" title="还不能开始对账" description="请先在上游资源中标记一个自己的 NewAPI 管理员站点，用于读取本站渠道收费。" actions={<Button type="primary" onClick={() => window.location.assign("/stations")}>前往上游资源</Button>} />;
  }

  if (!data && error) {
    return <AppState kind="error" title="无法读取对账数据" description={error} actions={<Button type="primary" loading={querying} onClick={() => loadWindow(activeWindow, true)}>重新查询</Button>} />;
  }

  return (
    <PageContainer
      className="responsive-page reconciliation-page"
      title="上游渠道对账"
      subTitle="核对上游成本与本站收费，监控利润情况"
      extra={<div className="page-toolbar"><Button className="reconciliation-primary-action" type="primary" icon={<PlusOutlined />} onClick={openCreate} aria-label="添加对账规则"><span>添加规则</span></Button></div>}
    >
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

      {data ? <div className="reconciliation-freshness"><Text type="secondary">显示结果生成：{formatRecentTime(data.generatedAt, displayTimezone, true)}（{displayTimezone}）</Text>{results.length ? <Text type="secondary">{freshness.staleCount ? `${freshness.staleCount} 条规则数据已过期${sharedWindow && freshness.coverageEndMs != null ? ` · 最早金额覆盖至 ${formatTime(freshness.coverageEndMs, sharedWindow.timezone)}` : ""}` : latestSuccessful ? `最近成功：${formatRecentTime(latestSuccessful.lastSuccessfulAt, latestSuccessful.window?.timezone)}（${latestSuccessful.window?.timezone || "Asia/Shanghai"}）` : "暂未成功（当前读取失败）"}</Text> : null}</div> : null}
      {error ? <Alert type="error" showIcon message="对账数据加载失败 · 当前显示上次结果" description={`${error}。下方窗口与金额属于上次查询，非本次查询结果。`} action={<Button size="small" onClick={() => loadWindow(activeWindow, true)}>重试</Button>} className="reconciliation-inline-alert" /> : null}
      {config?.channelsError ? <Alert type="warning" showIcon message="本站渠道目录读取失败" description={config.channelsError} className="reconciliation-inline-alert" /> : null}

      <section className="reconciliation-summary" aria-label="对账汇总">
        <div className="reconciliation-summary__metrics">
          <SummaryMetric label="本站收费" value={money(totals.incomeComplete ? totals.income : null, rate)} />
          <SummaryMetric label="上游成本" value={money(totals.costComplete ? totals.cost : null, rate)} />
          <SummaryMetric label="确认利润" value={money(totalDifference, rate)} tone={totalDifference == null ? "" : totalDifference < 0 ? "danger" : "success"} />
          <SummaryMetric label="毛利率" value={percent(totalMargin)} />
        </div>
        <p className="reconciliation-summary__note">本站收费来源：{RECONCILIATION_BILLING_SOURCE_LABEL}；上游完整成本仅在规则汇总，子渠道只展示本站收费与占比。{totals.profitComplete ? "" : ` 存在未确认规则，风险差额 ${money(totals.riskDifference, rate)} 未计入确认利润。`}{riskItems.length ? ` 当前 ${riskItems.length} 个异常。` : ""}</p>
      </section>

      <div className="reconciliation-list-tools">
        <Input className="reconciliation-search" prefix={<SearchOutlined />} allowClear value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索上游、Key 或渠道" aria-label="搜索上游、Key 或渠道" />
        <div className="reconciliation-status-filter mobile-scroll">
          <Segmented value={statusFilter} onChange={(value) => { setStatusFilter(String(value)); setPage(1); }} options={[
            { label: `全部 ${filterCounts.all}`, value: "all" },
            { label: `需处理 ${filterCounts.attention}`, value: "attention" },
            { label: `负毛利 ${filterCounts.negative}`, value: "negative" },
            { label: `切换待确认 ${filterCounts.pending}`, value: "pending" },
          ]} />
        </div>
      </div>

      {!error && results.length > 0 && filterCounts.attention === 0 ? <Alert type="success" showIcon message={`全部 ${results.length} 条规则暂无需处理事项`} className="reconciliation-inline-alert" /> : null}

      {!results.length ? <div className="reconciliation-empty"><Empty description="还没有启用的对账规则" image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" onClick={openCreate}>创建第一条规则</Button></Empty></div>
        : !filteredResults.length ? <div className="reconciliation-empty"><Empty description={statusFilter === "attention" && !search ? "当前无需处理事项" : "没有匹配的对账规则"} image={Empty.PRESENTED_IMAGE_SIMPLE}><Button onClick={() => { setSearch(""); setStatusFilter("all"); setPage(1); }}>查看全部规则</Button></Empty></div>
        : compact ? <>
          <div className="reconciliation-mobile-list">
            {filteredResults.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((item: any) => <RuleMobileItem key={item.rule?.id} item={item} rate={rate} upstreams={config?.upstreams} onDetail={() => openDetail(item)} />)}
          </div>
          <div className="reconciliation-mobile-pagination">
            <span>显示 {Math.min(filteredResults.length, currentPage * pageSize)} / {filteredResults.length} 条规则</span>
            <Space size={6}><Button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button disabled={currentPage * pageSize >= filteredResults.length} onClick={() => setPage(currentPage + 1)}>下一页 <RightOutlined /></Button></Space>
          </div>
        </> : <Table
          className="reconciliation-table"
          size="small"
          dataSource={filteredResults}
          columns={columns}
          rowKey={(item: any) => item.rule?.id}
          scroll={{ x: 1250 }}
          pagination={{ current: currentPage, pageSize, showSizeChanger: false, total: filteredResults.length, showTotal: (total, range) => `显示 ${range[0]}–${range[1]} / ${total} 条规则` }}
          onChange={(pagination) => setPage(pagination.current || 1)}
          onRow={(item: any) => ({ tabIndex: 0, onClick: () => openDetail(item), onKeyDown: (event: any) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openDetail(item); } } })}
        />}

      <Drawer className="reconciliation-detail-drawer" title={detail?.rule?.tokenName ? `${detail.rule.tokenName} · 对账详情` : "对账详情"} open={!!detail} onClose={() => setDetail(null)} width={compact ? "100%" : 520} aria-label="对账详情抽屉" extra={detail ? <Space size={4}><Button type="text" icon={<EditOutlined />} aria-label={`编辑 ${detail.rule?.tokenName || "Key"} 的规则`} onClick={() => { openEdit(detail.rule); setDetail(null); }} /><Popconfirm title="停止并释放此对账规则？" description="停止后会释放 Key 和关联渠道，历史快照保留。" okText="停止并释放" cancelText="取消" onConfirm={async () => { if (await stopRule(detail.rule.id)) setDetail(null); }}><Button danger type="text" icon={<DeleteOutlined />} aria-label={`停止并释放 ${detail.rule?.tokenName || "Key"} 的规则`} /></Popconfirm></Space> : null}>
        {detail ? <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert type={reconciliationHealthMeta(detail.health?.code).tone === "error" || reconciliationRowFlags(detail).negative ? "error" : detail.health?.code === "READY" ? "success" : "warning"} showIcon message={reconciliationHealthMeta(detail.health?.code).tone === "error" ? detail.health?.label || reconciliationHealthMeta(detail.health?.code).label : reconciliationRowFlags(detail).negative ? "该规则确认利润为负" : detail.health?.label} description={detail.health?.detail || "数据来源正常"} />
          <Detail label="请求窗口" value={`${formatWindow(detail.requestedWindow || detail.window)}（${(detail.requestedWindow || detail.window)?.timezone}）`} />
          {detail.health?.stale ? <Detail label="成功金额覆盖窗口" value={`${formatWindow(detail.lastSuccessfulWindow || detail.window)}（${(detail.lastSuccessfulWindow || detail.window)?.timezone}）`} /> : null}
          <Detail label="上游账号" value={upstreamName(detail.rule, config?.upstreams)} />
          <Detail label="上游 Key / 分组" value={`${detail.rule?.tokenName || "—"} · ${detail.upstream?.group || detail.currentSegment?.group || detail.rule?.fixedGroup || "—"}`} />
          <Detail label="关联销售渠道" value={(detail.rule?.channels?.length ? detail.rule.channels : detail.downstream?.channels || []).map((channel: any) => channel.name || `渠道 ${channel.channelId || channel.id}`).join("、") || "未配置渠道"} />
          <Detail label="当前倍率" value={(detail.upstream?.ratio ?? detail.currentSegment?.ratio) == null ? "未返回" : `${detail.upstream?.ratio ?? detail.currentSegment?.ratio}×`} />
          <Detail label="本站收费" value={money(detail.downstream?.amountUsd, rate)} />
          <Detail label="上游成本" value={money(detail.upstream?.amountUsd, rate)} />
          <Detail label={calculationValues(detail.calculation, detail.health).confirmed ? "确认利润" : "风险差额（未计入确认利润）"} value={money(calculationValues(detail.calculation, detail.health).confirmed ? calculationValues(detail.calculation, detail.health).profitUsd : calculationValues(detail.calculation, detail.health).riskDifferenceUsd, rate)} />
          <Detail label="毛利率" value={percent(calculationValues(detail.calculation, detail.health).marginRate)} />
          <Collapse size="small" ghost items={[{ key: "billing-basis", label: "查看原始账单与计算依据", children: <Space direction="vertical" size={10}>
            <Detail label="本站收费（美元原值）" value={reconciliationBillingBasis(detail.segments?.length === 1 ? detail.downstream : { amountUsd: detail.downstream?.amountUsd })} />
            <Detail label="上游成本（美元原值）" value={reconciliationBillingBasis(detail.segments?.length === 1 ? detail.upstream : { amountUsd: detail.upstream?.amountUsd })} />
            <Detail label={calculationValues(detail.calculation, detail.health).confirmed ? "确认利润（美元原值）" : "风险差额（美元原值）"} value={reconciliationBillingBasis({ amountUsd: calculationValues(detail.calculation, detail.health).confirmed ? calculationValues(detail.calculation, detail.health).profitUsd : calculationValues(detail.calculation, detail.health).riskDifferenceUsd })} />
            <Text type="secondary" style={{ fontSize: 12 }}>利润 = 本站收费 − 上游成本；毛利率 = 利润 ÷ 本站收费。计算使用未舍入金额，跨分段时先分别核算再汇总。</Text>
          </Space> }]} />
          <Detail label="本站收费来源" value={detail.downstream?.amountUsd == null ? "未取得" : detail.downstream.billingSource === RECONCILIATION_BILLING_SOURCE ? RECONCILIATION_BILLING_SOURCE_LABEL : "旧版来源（待重新核算）"} />
          <Detail label="渠道账单覆盖" value={percent(detail.downstream?.billingCoverage ?? detail.downstream?.coverage)} />
          {(detail.health?.issues || []).map((issue: any, index: number) => <Alert key={`${issue.code}-${index}`} type={reconciliationHealthMeta(issue.code).tone === "error" ? "error" : "warning"} showIcon message={HEALTH_LABEL(issue.code)} description={issue.detail} />)}
          {transitionSegments.some((segment: any) => segment.timingSource === "detected") ? <Space wrap>
            <Select value={transitionSegmentId} onChange={setTransitionSegmentId} placeholder="选择待确认的切换分段" style={{ minWidth: compact ? "100%" : 230 }} options={transitionSegments.filter((segment: any) => segment.timingSource === "detected").map((segment: any) => ({ value: segment.id, label: `${segment.group} · ${formatWindow(segment.window || { startMs: segment.effectiveFrom, endMs: segment.effectiveTo ?? Date.now(), timezone: detail.window?.timezone || detail.rule?.timezone })}` }))} />
            <DatePicker showTime value={transitionAt} onChange={(value) => setTransitionAt(value)} placeholder="实际切换时间" />
            <Button onClick={correctTransition}>修正切换时间</Button>
          </Space> : null}
          {hasSegmentChanges(detailTimelineSegments) ? <SegmentTimeline segments={detailTimelineSegments} rate={rate} timezone={detail.window?.timezone || detail.rule?.timezone} /> : null}
          <ChannelBreakdown item={detail} rate={rate} />
        </Space> : null}
      </Drawer>

      <Drawer title={editing ? "编辑对账规则" : "添加对账规则"} open={drawerOpen} onClose={() => setDrawerOpen(false)} width={compact ? "100%" : 520} aria-label={editing ? "编辑对账规则抽屉" : "添加对账规则抽屉"} extra={<Button className="reconciliation-primary-action" type="primary" loading={saving} htmlType="submit" form="reconciliation-rule-form" aria-label="保存对账规则">保存规则</Button>}>
        <Form id="reconciliation-rule-form" form={form} layout="vertical" requiredMark={false} onFinish={saveRule}>
          {editing ? <Alert type="info" showIcon message="规则身份不可修改" description="上游账号或 Key 需要更换时，请停止当前规则后创建新规则；当前历史账单会继续保留。" style={{ marginBottom: 16 }} /> : null}
          <Form.Item label="上游账号" name="upstreamStationId" extra={editing ? "已锁定，避免新账号重算当前规则的历史账单。" : "复用该站点已有 PAT，不需要再次填写。"} rules={[{ required: true, message: "请选择上游账号" }]}>
            <Select showSearch optionFilterProp="label" disabled={!!editing} placeholder="选择已配置的 NewAPI 上游站点" options={(config?.upstreams || []).map((station: any) => ({ value: station.id, label: station.name }))} onChange={(value) => { form.setFieldValue("tokenId", undefined); setKeyData(null); fetchKeys(value, true); }} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          <Form.Item label="固定分组 Key" name="tokenId" extra={editing ? "已锁定；同一 Key 的分组或倍率变化由系统自动记录为新分段。" : "仅显示固定分组、未启用跨组重试且当前可用的 Key。"} rules={[{ required: true, message: "请选择固定分组 Key" }]}>
            <Select showSearch optionFilterProp="label" loading={keyLoading} disabled={!!editing || !upstreamId || keyLoading} placeholder={upstreamId ? "选择上游 Key" : "请先选择上游账号"} options={(keyData?.tokens || []).map((item: any) => ({ value: item.id, disabled: item.status !== 1 || item.group === "auto" || item.crossGroupRetry, label: `${item.name} · ${item.group || "无分组"}${keyData?.groups?.[item.group]?.ratio != null ? ` · ${keyData.groups[item.group].ratio}×` : ""}` }))} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          <Form.Item label="本站销售渠道" name="salesChannelIds" extra="一个渠道同一时刻只能归属一条启用规则。" rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个本站渠道" }]}>
            <Select showSearch optionFilterProp="label" mode="multiple" placeholder="选择一个或多个渠道" options={(config?.channels || []).map((channel: any) => {
              const occupiedBy = unavailableChannels.get(Number(channel.id));
              return { value: Number(channel.id), disabled: !!occupiedBy, label: `${channel.name || `渠道 ${channel.id}`}${occupiedBy ? `（已用于 ${occupiedBy}）` : ""}` };
            })} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          <Form.Item label="对账时区" name="timezone" extra="“今天”从该时区的 00:00 计算到当前时刻。">
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Alert type="info" showIcon message="核算口径" description="该规则汇总完整上游成本与全部所选渠道收费。渠道子项只展示收费占比，不分摊成本。" />
        </Form>
      </Drawer>
    </PageContainer>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><Text type="secondary" style={{ display: "block", fontSize: 12 }}>{label}</Text><Text strong style={{ fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{value}</Text></div>;
}

function HEALTH_LABEL(code: string) {
  return reconciliationHealthMeta(code).label || code;
}
