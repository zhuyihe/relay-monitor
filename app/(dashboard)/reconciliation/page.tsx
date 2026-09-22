"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer } from "@ant-design/pro-components";
import {
  Alert, App, Button, Card, Collapse, DatePicker, Drawer, Empty, Form, Grid, Input, List,
  Popconfirm, Segmented, Select, Space, Statistic, Tag, Typography, theme,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api, cny, usd } from "../../../lib/client";
import {
  mergeReconciliationChannels,
  mergeReconciliationSegments,
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

function money(amount: any, rate: any) {
  if (amount == null) return "—";
  const value = Number(amount);
  const cnyRate = Number(rate);
  if (!Number.isFinite(value)) return "—";
  return Number.isFinite(cnyRate) && cnyRate > 0 ? cny(value * cnyRate) : usd(value);
}

function percent(value: any) {
  if (value == null) return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "—";
}

function calculationValues(calculation: any, health: any) {
  const legacy = calculation?.profitUsd === undefined && calculation?.riskDifferenceUsd === undefined;
  const confirmed = calculation?.profitUsd != null || (legacy && health?.code === "READY" && calculation?.differenceUsd != null);
  return {
    confirmed,
    profitUsd: confirmed ? calculation?.profitUsd ?? calculation?.differenceUsd : null,
    riskDifferenceUsd: confirmed ? null : calculation?.riskDifferenceUsd ?? calculation?.differenceUsd ?? null,
    marginRate: confirmed ? calculation?.marginRate ?? null : null,
  };
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
  const current = item?.health || {};
  const meta = reconciliationHealthMeta(current.code);
  return <Tag color={current.stale ? "default" : meta.tone}>{current.stale ? reconciliationHealthMeta("STALE").label : current.label || meta.label || "数据待获取"}</Tag>;
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

function RuleRow({ item, rate, compact, upstreams, onEdit, onDelete, onDetail }: any) {
  const { token } = theme.useToken();
  const rule = item.rule || {};
  const warning = item.health?.code !== "READY";
  const accountName = upstreamName(rule, upstreams);
  const channels = mergeReconciliationChannels(rule.channels, item.downstream?.channels);
  const currentSegment = item.currentSegment || {};
  const currentGroup = currentSegment.group || item.upstream?.group || rule.fixedGroup || "未返回";
  const currentRatio = currentSegment.ratio ?? item.upstream?.ratio;
  const timezone = item.window?.timezone || rule.timezone;
  const calculation = calculationValues(item.calculation, item.health);
  const confirmedProfit = calculation.profitUsd;
  const riskDifference = calculation.riskDifferenceUsd;
  const differenceValue = confirmedProfit == null ? riskDifference : confirmedProfit;
  const difference = differenceValue == null ? null : Number(differenceValue);
  const timelineSegments = mergeReconciliationSegments(item.transitionSegments, item.segments);
  const hasChanges = hasSegmentChanges(timelineSegments);
  const latestTransitionIndex = timelineSegments.length - 1;
  const latestTransition = hasChanges ? timelineSegments[latestTransitionIndex] : null;
  const previousTransition = latestTransition ? timelineSegments[latestTransitionIndex - 1] : null;
  const transitionPending = latestTransition?.timingSource === "detected";
  return (
    <Card style={{ marginBottom: 12 }} styles={{ body: { padding: compact ? 16 : 20 } }}>
      <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "minmax(0, 1fr) auto", gap: 12, alignItems: "start" }}>
        <div role="button" tabIndex={0} aria-label={`查看 ${rule.tokenName || "Key"} 的对账详情`} onClick={onDetail} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onDetail(); } }} style={{ minWidth: 0, cursor: "pointer" }}>
          <Space wrap size={[6, 4]}>
            <Text strong style={{ fontSize: 16, overflowWrap: "anywhere" }}>{accountName}</Text>
            {statusTag(item)}
          </Space>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: "4px 14px", color: token.colorTextSecondary, fontSize: 12 }}>
            <span>上游 Key：{rule.tokenName || "未命名 Key"}</span>
            <span>当前分组：<Text strong>{currentGroup}</Text></span>
            <span>当前倍率：<Text strong>{ratioLabel(currentRatio)}</Text></span>
          </div>
        </div>
        <Space size={2} wrap={compact} className="reconciliation-rule-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Button type="link" size="small" onClick={onDetail} aria-label={`查看 ${rule.tokenName || "Key"} 的对账详情`}>详情</Button>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label={`编辑 ${rule.tokenName || "Key"} 的规则`} />
          <Popconfirm title="停止并释放此对账规则？" description="停止后会释放此 Key 和关联销售渠道；历史快照会保留，后台将不再自动刷新。" okText="停止并释放" cancelText="取消" onConfirm={onDelete}>
            <Button danger type="text" size="small" icon={<DeleteOutlined />} aria-label={`停止并释放 ${rule.tokenName || "Key"} 的规则`} />
          </Popconfirm>
        </Space>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 18, padding: 14, background: token.colorFillAlter, borderRadius: token.borderRadiusLG }}>
        <Metric compact={compact} label="本站收费" value={money(item.downstream?.amountUsd, rate)} />
        <Metric compact={compact} label="上游成本" value={money(item.upstream?.amountUsd, rate)} />
        <Metric compact={compact} label={confirmedProfit == null ? "风险差额" : "利润"} value={money(differenceValue, rate)} color={difference == null || !Number.isFinite(difference) || warning ? token.colorText : difference >= 0 ? token.colorSuccess : token.colorError} />
        <Metric compact={compact} label="毛利率" value={percent(calculation.marginRate)} />
      </div>

      <Text type="secondary" className="reconciliation-updated">
        请求窗口 {formatWindow(item.requestedWindow || item.window)} · {item.health?.stale ? `数据已过期 · 最近成功 ${formatTime(item.lastSuccessfulAt, timezone)} · 金额覆盖至 ${formatTime(item.lastSuccessfulWindow?.endMs || item.window?.endMs, timezone)}` : item.lastSuccessfulAt ? `最近成功 ${formatTime(item.lastSuccessfulAt, timezone)}` : "暂未成功（当前读取失败）"}
      </Text>

      {latestTransition && previousTransition ? <Alert className="reconciliation-transition" type="warning" showIcon message={reconciliationHealthMeta("ROUTE_TRANSITION_DETECTED").label} description={<span>{previousTransition.group || "分组未知"} · {ratioLabel(previousTransition.ratio)} → {latestTransition.group || "分组未知"} · {ratioLabel(latestTransition.ratio)} · {transitionPending ? `暂按 ${formatTime(latestTransition.detectedAt, timezone)} 生效` : `切换时间已于 ${formatTime(latestTransition.effectiveFrom, timezone)} 确认`}</span>} action={transitionPending ? <Button size="small" className="reconciliation-transition__action" onClick={onDetail} aria-label={`修正 ${rule.tokenName || "Key"} 的切换时间`}>修正切换时间</Button> : null} /> : null}

      <section aria-label={`${rule.tokenName || "该规则"}的渠道状态与收费`} style={{ marginTop: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
          <Text strong>关联渠道</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{channels.length} 个 · 启用 {channels.filter((channel: any) => channel.state === "enabled").length} · 不可用 {channels.filter((channel: any) => channel.state !== "enabled").length}</Text>
        </div>
        <ChannelBreakdown item={item} rate={rate} />
      </section>

      {hasChanges ? <div onClick={(event) => event.stopPropagation()}><Collapse ghost size="small" style={{ marginTop: 12 }} items={[{ key: "history", label: "查看分组与倍率变更历史", children: <SegmentTimeline segments={timelineSegments} rate={rate} timezone={timezone} /> }]} /></div> : null}
    </Card>
  );
}

function Metric({ label, value, compact, color }: { label: string; value: string; compact?: boolean; color?: string }) {
  return (
    <div style={{ minWidth: 0, textAlign: compact ? "left" : "right" }}>
      <div style={{ fontSize: 12, color: "var(--jy-text-secondary)" }}>{label}</div>
      <div className="reconciliation-metric__value" style={{ marginTop: 2, fontSize: compact ? 16 : 18, fontWeight: 650, color, fontVariantNumeric: "tabular-nums", whiteSpace: compact ? "normal" : "nowrap", overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

export default function ReconciliationPage() {
  const { message } = App.useApp();
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
  const [saving, setSaving] = useState(false);
  const [transitionAt, setTransitionAt] = useState<any>(null);
  const [transitionSegmentId, setTransitionSegmentId] = useState<string | null>(null);
  const [transitionSegments, setTransitionSegments] = useState<any[]>([]);

  const rate = config?.ownStation?.cnyPerUsd ?? null;
  const results = data?.results || [];
  const detailTimelineSegments = mergeReconciliationSegments(detail?.transitionSegments, detail?.segments, transitionSegments);
  const totals = useMemo(() => results.reduce((acc: any, item: any) => {
    const incomeValue = item?.downstream?.amountUsd;
    const costValue = item?.upstream?.amountUsd;
    const income = Number(incomeValue);
    const cost = Number(costValue);
    if (incomeValue != null && Number.isFinite(income)) acc.income += income;
    else acc.incomeComplete = false;
    if (costValue != null && Number.isFinite(cost)) acc.cost += cost;
    else acc.costComplete = false;
    const calculation = calculationValues(item?.calculation, item?.health);
    const profit = Number(calculation.profitUsd);
    if (calculation.confirmed && Number.isFinite(profit)) acc.profit += profit;
    else acc.profitComplete = false;
    const riskDifference = Number(calculation.riskDifferenceUsd);
    if (calculation.riskDifferenceUsd != null && Number.isFinite(riskDifference)) acc.riskDifference += riskDifference;
    return acc;
  }, { income: 0, cost: 0, profit: 0, riskDifference: 0, incomeComplete: true, costComplete: true, profitComplete: true }), [results]);
  const totalDifference = totals.profitComplete ? totals.profit : null;
  const totalMargin = totals.profitComplete && totals.incomeComplete && totals.income > 0 ? totalDifference / totals.income : null;
  const riskItems = useMemo(() => results.flatMap((item: any) => {
    const issues = item?.health?.issues?.length ? item.health.issues : item?.health?.code !== "READY" ? [{ code: item?.health?.code, detail: item?.health?.detail }] : [];
    return issues.map((issue: any) => ({ ...issue, rule: item.rule }));
  }), [results]);
  const latestSuccessful = results.find((item: any) => item.lastSuccessfulAt);
  const freshness = summarizeReconciliationFreshness(results);
  const requestedWindows = results.map((item: any) => item.requestedWindow || item.window).filter(Boolean);
  const sharedWindow = requestedWindows[0] && requestedWindows.every((window: any) => window.startMs === requestedWindows[0].startMs && window.endMs === requestedWindows[0].endMs && window.timezone === requestedWindows[0].timezone)
    ? requestedWindows[0]
    : null;

  const loadConfiguration = async () => {
    const next = await api("/api/reconciliation/configuration");
    setConfig(next);
    return next;
  };

  const loadWindow = async (window = activeWindow, force = false) => {
    setQuerying(true);
    try {
      let next;
      if (window.preset === "today" && !force) {
        next = await api("/api/reconciliation?preset=today");
      } else {
        next = await api("/api/reconciliation/query", { method: "POST", body: window });
      }
      setData(next);
      setError("");
      return next;
    } catch (err: any) {
      setError(err?.message || "对账数据加载失败");
      return null;
    } finally {
      setQuerying(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadConfiguration(), loadWindow({ preset: "today" })]);
      } catch (err: any) {
        setError(err?.message || "初始化失败");
        setLoading(false);
      }
    })();
  // 仅首屏初始化；后续查询由按钮和定时器驱动。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeWindow.preset !== "today") return;
    const timer = setInterval(() => loadWindow(activeWindow), 30000);
    const onVisible = () => { if (!document.hidden) loadWindow(activeWindow); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindow.preset]);

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
    } catch (err: any) { message.error(err?.message || "停止规则失败"); }
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

  if (loading) return <AppState kind="loading" title="正在读取渠道对账" description="正在汇总上游实际消费与本站渠道收费。" />;

  if (!config && error) {
    return <AppState kind="error" title="无法加载渠道对账" description={error} actions={<Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>} />;
  }

  if (!config?.ownStation) {
    return <AppState kind="empty" title="还不能开始对账" description="请先在上游资源中标记一个自己的 NewAPI 管理员站点，用于读取本站渠道收费。" actions={<Button type="primary" onClick={() => window.location.assign("/stations")}>前往上游资源</Button>} />;
  }

  return (
    <PageContainer
      className="responsive-page reconciliation-page"
      title="上游渠道对账"
      subTitle="按同一时间窗核算上游实际消费与本站渠道收费"
      extra={<div className="page-toolbar"><Button className="reconciliation-primary-action" type="primary" icon={<PlusOutlined />} onClick={openCreate} aria-label="添加对账规则">添加规则</Button></div>}
    >
      <div className="mobile-filterbar" style={{ marginBottom: 16 }}>
        <Segmented options={PRESETS} value={preset} onChange={(value) => setPreset(String(value))} />
        {preset === "custom" ? <RangePicker showTime value={range} onChange={(value) => setRange(value)} style={{ minWidth: compact ? "100%" : 330 }} /> : null}
        <Button type="primary" className="reconciliation-query-action" loading={querying} onClick={() => query(true)}>查询</Button>
        <Button className="reconciliation-query-action" icon={<ReloadOutlined />} loading={querying} onClick={() => loadWindow(activeWindow, true)} aria-label="刷新当前对账窗口">刷新</Button>
      </div>

      {results.length ? <div className="reconciliation-freshness"><Text type="secondary">{sharedWindow ? `请求窗口：${formatWindow(sharedWindow)}（${sharedWindow.timezone}）` : "请求窗口：按各规则时区计算，具体时间见规则卡"}</Text><Text type="secondary">{freshness.staleCount ? `${freshness.staleCount} 条规则数据已过期${sharedWindow && freshness.coverageEndMs != null ? ` · 最早金额覆盖至 ${formatTime(freshness.coverageEndMs, sharedWindow.timezone)}` : "，具体覆盖时间见规则卡"}` : latestSuccessful ? `最近成功：${formatTime(latestSuccessful.lastSuccessfulAt, latestSuccessful.window?.timezone)}` : "暂未成功（当前读取失败）"}</Text></div> : null}
      {error ? <Alert type="error" showIcon message="对账数据加载失败" description={error} action={<Button size="small" onClick={() => loadWindow(activeWindow, true)}>重试</Button>} style={{ marginBottom: 16 }} /> : null}
      {config?.channelsError ? <Alert type="warning" showIcon message="本站渠道目录读取失败" description={config.channelsError} style={{ marginBottom: 16 }} /> : null}

      <Card className="reconciliation-summary" style={{ marginBottom: 16 }} styles={{ body: { padding: compact ? 16 : "18px 24px" } }}>
        <div className="reconciliation-summary__metrics" style={{ gridTemplateColumns: compact ? "1fr 1fr" : "1.2fr 1fr 1.1fr .8fr" }}>
          <Statistic title="本站收费" value={money(totals.incomeComplete ? totals.income : null, rate)} valueStyle={{ fontVariantNumeric: "tabular-nums" }} />
          <Statistic title="上游成本" value={money(totals.costComplete ? totals.cost : null, rate)} valueStyle={{ fontVariantNumeric: "tabular-nums" }} />
          <Statistic title="确认利润" value={money(totalDifference, rate)} valueStyle={{ color: totalDifference == null ? "var(--jy-text)" : totalDifference >= 0 ? "var(--jy-success)" : "var(--jy-danger)", fontVariantNumeric: "tabular-nums" }} />
          <Statistic title="毛利率" value={percent(totalMargin)} valueStyle={{ fontVariantNumeric: "tabular-nums" }} />
        </div>
        <Text type="secondary" style={{ display: "block", marginTop: 14, fontSize: 12 }}>本站收费来源：{RECONCILIATION_BILLING_SOURCE_LABEL}；上游完整成本仅在父规则统计，子渠道只展示本站收费与占比。{totals.profitComplete ? "" : ` 存在未确认规则，风险差额 ${money(totals.riskDifference, rate)} 未计入确认利润。`}{riskItems.length ? ` 当前 ${riskItems.length} 个异常。` : ""}</Text>
      </Card>

      {riskItems.length ? <Card className="reconciliation-risks" size="small" title={`风险事件（${riskItems.length}）`} style={{ marginBottom: 16 }}>
        <List size="small" dataSource={riskItems} renderItem={(issue: any, index: number) => <List.Item key={`${issue.rule?.id || "rule"}-${issue.code}-${index}`}><Text strong>{issue.rule?.tokenName || "规则"}</Text><Text type="secondary">{HEALTH_LABEL(issue.code)}：{issue.detail || "请查看规则详情"}</Text></List.Item>} />
      </Card> : null}

      {!results.length ? (
        <Card><Empty description="还没有启用的对账规则" image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" onClick={openCreate}>创建第一条规则</Button></Empty></Card>
      ) : results.map((item: any) => (
        <RuleRow key={item.rule?.id} item={item} rate={rate} compact={compact} upstreams={config?.upstreams} onEdit={() => openEdit(item.rule)} onDelete={() => stopRule(item.rule.id)} onDetail={() => openDetail(item)} />
      ))}

      <Drawer title={detail?.rule?.tokenName ? `${detail.rule.tokenName} · 对账详情` : "对账详情"} open={!!detail} onClose={() => setDetail(null)} width={compact ? "100%" : 520} aria-label="对账详情抽屉">
        {detail ? <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert type={detail.health?.code === "READY" ? "success" : "warning"} showIcon message={detail.health?.label} description={detail.health?.detail || "数据来源正常"} />
          <Detail label="请求窗口" value={`${formatWindow(detail.requestedWindow || detail.window)}（${(detail.requestedWindow || detail.window)?.timezone}）`} />
          {detail.health?.stale ? <Detail label="成功金额覆盖窗口" value={`${formatWindow(detail.lastSuccessfulWindow || detail.window)}（${(detail.lastSuccessfulWindow || detail.window)?.timezone}）`} /> : null}
          <Detail label="上游账号" value={upstreamName(detail.rule, config?.upstreams)} />
          <Detail label="上游 Key / 分组" value={`${detail.rule?.tokenName || "—"} · ${detail.upstream?.group || detail.currentSegment?.group || detail.rule?.fixedGroup || "—"}`} />
          <Detail label="关联销售渠道" value={(detail.rule?.channels?.length ? detail.rule.channels : detail.downstream?.channels || []).map((channel: any) => channel.name || `渠道 ${channel.channelId || channel.id}`).join("、") || "未配置渠道"} />
          <Detail label="当前倍率" value={(detail.upstream?.ratio ?? detail.currentSegment?.ratio) == null ? "未返回" : `${detail.upstream?.ratio ?? detail.currentSegment?.ratio}×`} />
          <Detail label="本站收费" value={money(detail.downstream?.amountUsd, rate)} />
          <Detail label="上游成本" value={money(detail.upstream?.amountUsd, rate)} />
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
