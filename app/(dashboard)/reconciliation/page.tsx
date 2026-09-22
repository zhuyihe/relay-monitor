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
import AppState from "../../components/app-state";

const { Text } = Typography;
const { RangePicker } = DatePicker;

const PRESETS = [
  { label: "今天", value: "today" },
  { label: "昨天", value: "yesterday" },
  { label: "近 7 天", value: "7d" },
  { label: "自定义", value: "custom" },
];

const statusColor: Record<string, string> = {
  READY: "success",
  GROUP_OR_RATIO_CHANGED: "warning",
  KEY_INVALID_OR_DENIED: "error",
  UPSTREAM_DATA_UNAVAILABLE: "error",
  OWN_FLOW_INCOMPLETE: "warning",
  UPSTREAM_EMPTY_WITH_SALES: "warning",
  STALE: "default",
  SALES_CHANNEL_DISABLED: "warning",
  SALES_CHANNEL_MISSING: "error",
  ROUTE_TRANSITION_DETECTED: "warning",
};

const channelStateLabel: Record<string, string> = {
  enabled: "启用", manual_disabled: "手动禁用", auto_disabled: "自动禁用", missing: "已缺失", unknown: "状态未知",
};

function money(amount: any, rate: any) {
  const value = Number(amount);
  const cnyRate = Number(rate);
  if (!Number.isFinite(value)) return "—";
  return Number.isFinite(cnyRate) && cnyRate > 0 ? cny(value * cnyRate) : usd(value);
}

function percent(value: any) {
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
  const current = item?.health || {};
  return <Tag color={statusColor[current.code] || "default"}>{current.label || "数据待获取"}</Tag>;
}

function upstreamName(rule: any, upstreams: any) {
  if (!Array.isArray(upstreams)) return "上游账号目录暂不可用";
  const station = upstreams.find((item) => String(item.id) === String(rule?.upstreamStationId));
  return station?.name || `已删除的上游账号（${rule?.upstreamStationId || "未知站点"}）`;
}

function linkedChannelNames(rule: any, item: any) {
  const configured = rule?.channels || [];
  const observed = item?.downstream?.channels || [];
  const channels = configured.length ? configured : observed;
  return channels.map((channel: any) => channel.name || `渠道 ${channel.channelId || channel.id}`).join("、") || "未配置渠道";
}

function RuleChildren({ item, rate }: { item: any; rate: any }) {
  const channels = item?.downstream?.channels || [];
  if (!channels.length) return <Text type="secondary">该窗口没有可展示的渠道收费。</Text>;
  return (
    <List
      size="small"
      dataSource={channels}
      renderItem={(channel: any) => (
        <List.Item>
          <Space direction="vertical" size={0} style={{ minWidth: 0, flex: 1 }}>
            <Text strong style={{ overflowWrap: "anywhere" }}>{channel.name}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>渠道 ID：{channel.channelId} · 收费占比 {percent(channel.share)} · <Tag color={channel.state === "enabled" ? "success" : channel.state === "missing" ? "error" : "warning"}>{channelStateLabel[channel.state] || "状态未知"}</Tag></Text>
          </Space>
          <Text strong style={{ fontVariantNumeric: "tabular-nums" }}>{money(channel.amountUsd, rate)}</Text>
        </List.Item>
      )}
    />
  );
}

function SegmentTimeline({ item, rate }: { item: any; rate: any }) {
  const segments = item?.segments || [];
  if (!segments.length) return null;
  return <List
    size="small"
    header="分组与倍率时间线"
    dataSource={segments.slice().reverse()}
    renderItem={(segment: any) => <List.Item>
      <Space direction="vertical" size={2} style={{ width: "100%" }}>
        <Text strong>{formatWindow(segment.window)} · {segment.group} · {segment.ratio == null ? "倍率未知" : `${segment.ratio}×`}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{segment.timingSource === "operator_confirmed" ? "已人工确认" : segment.timingSource === "detected" ? "暂按检测时间生效" : "历史初始分段"}</Text>
        <Space wrap size="middle" style={{ fontVariantNumeric: "tabular-nums" }}>
          <Text>收费 {money(segment.downstream?.amountUsd, rate)}</Text><Text>成本 {money(segment.upstream?.amountUsd, rate)}</Text><Text>差额 {money(segment.calculation?.differenceUsd, rate)}</Text><Text>毛利率 {percent(segment.calculation?.marginRate)}</Text>
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
  const channelNames = linkedChannelNames(rule, item);
  const content = (
    <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "minmax(210px, 1.35fr) repeat(4, minmax(110px, .8fr)) auto", gap: compact ? 10 : 18, alignItems: "center", minWidth: 0 }}>
      <div style={{ minWidth: 0 }}>
        <Space wrap size={[6, 4]} style={{ minWidth: 0, maxWidth: "100%" }}>
          <Text strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{accountName}</Text>
          {statusTag(item)}
        </Space>
        <div style={{ marginTop: 4, color: token.colorTextSecondary, fontSize: 12, overflowWrap: "anywhere" }}>
          Key：{rule.tokenName || "未命名 Key"} · 固定分组：{rule.fixedGroup || "未设置"}
        </div>
        <div style={{ marginTop: 2, color: token.colorTextSecondary, fontSize: 12, overflowWrap: "anywhere" }}>
          销售渠道：{channelNames}
        </div>
        <div style={{ marginTop: 2, color: token.colorTextSecondary, fontSize: 12 }}>
          {(item.downstream?.channels || []).length} 个渠道 · 启用 {(item.downstream?.channels || []).filter((channel: any) => channel.state === "enabled").length} · 禁用 {(item.downstream?.channels || []).filter((channel: any) => ["manual_disabled", "auto_disabled"].includes(channel.state)).length} · 缺失 {(item.downstream?.channels || []).filter((channel: any) => channel.state === "missing").length}
        </div>
      </div>
      <Metric compact={compact} label="本站收费" value={money(item.downstream?.amountUsd, rate)} />
      <Metric compact={compact} label="上游成本" value={money(item.upstream?.amountUsd, rate)} />
      <Metric compact={compact} label="差额" value={money(item.calculation?.differenceUsd, rate)} color={warning ? token.colorText : (Number(item.calculation?.differenceUsd) >= 0 ? token.colorSuccess : token.colorError)} />
      <Metric compact={compact} label="毛利率" value={percent(item.calculation?.marginRate)} />
      <Space size={2}>
        <Button type="text" size="small" onClick={(event) => { event.stopPropagation(); onDetail(); }} aria-label={`查看 ${rule.tokenName || "Key"} 的对账详情`}>详情</Button>
        <Button type="text" size="small" icon={<EditOutlined />} onClick={(event) => { event.stopPropagation(); onEdit(); }} aria-label={`编辑 ${rule.tokenName || "Key"} 的规则`} />
        <Popconfirm title="停止并释放此对账规则？" description="停止后会释放此 Key 和关联销售渠道；历史快照会保留，后台将不再自动刷新。" okText="停止并释放" cancelText="取消" onConfirm={onDelete}>
          <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={(event) => event.stopPropagation()} aria-label={`停止并释放 ${rule.tokenName || "Key"} 的规则`} />
        </Popconfirm>
      </Space>
    </div>
  );
  if (compact) {
    return (
      <Card style={{ marginBottom: 12 }} styles={{ body: { padding: 16 } }}>
        {content}
        <Collapse ghost size="small" style={{ marginTop: 8 }} items={[{ key: "channels", label: "查看分段与渠道收费组成", children: <><SegmentTimeline item={item} rate={rate} /><RuleChildren item={item} rate={rate} /></> }]} />
      </Card>
    );
  }
  return (
    <Collapse
      style={{ marginBottom: 8 }}
      items={[{ key: rule.id || "rule", label: content, children: <><SegmentTimeline item={item} rate={rate} /><RuleChildren item={item} rate={rate} /></> }]}
    />
  );
}

function Metric({ label, value, compact, color }: { label: string; value: string; compact?: boolean; color?: string }) {
  return (
    <div style={{ minWidth: 0, textAlign: compact ? "left" : "right" }}>
      <div style={{ fontSize: 12, color: "var(--jy-text-secondary)" }}>{label}</div>
      <div style={{ fontWeight: 650, color, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</div>
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
  const totals = useMemo(() => results.reduce((acc: any, item: any) => {
    acc.income += Number(item?.downstream?.amountUsd) || 0;
    acc.cost += Number(item?.upstream?.amountUsd) || 0;
    return acc;
  }, { income: 0, cost: 0 }), [results]);
  const totalDifference = totals.income - totals.cost;
  const totalMargin = totals.income > 0 ? totalDifference / totals.income : null;

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

  const openEdit = async (rule: any) => {
    setEditing(rule);
    setKeyData(null);
    form.setFieldsValue({
      upstreamStationId: rule.upstreamStationId,
      tokenId: rule.tokenId,
      salesChannelIds: (rule.channels || []).map((channel: any) => Number(channel.channelId)),
      timezone: rule.timezone || "Asia/Shanghai",
    });
    setDrawerOpen(true);
    await fetchKeys(rule.upstreamStationId);
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
    const fallback = item.segments || [];
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
      className="responsive-page"
      title="上游渠道对账"
      subTitle="按同一时间窗核算上游实际消费与本站渠道收费"
      extra={<div className="page-toolbar"><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加规则</Button></div>}
    >
      <div className="mobile-filterbar" style={{ marginBottom: 16 }}>
        <Segmented options={PRESETS} value={preset} onChange={(value) => setPreset(String(value))} />
        {preset === "custom" ? <RangePicker showTime value={range} onChange={(value) => setRange(value)} style={{ minWidth: compact ? "100%" : 330 }} /> : null}
        <Button type="primary" loading={querying} onClick={() => query(true)}>查询</Button>
        <Button icon={<ReloadOutlined />} loading={querying} onClick={() => loadWindow(activeWindow, true)} aria-label="刷新当前对账窗口">刷新</Button>
      </div>

      {data?.results?.[0]?.window ? <Text type="secondary" style={{ display: "block", marginBottom: 16 }}>当前窗口：{formatWindow(data.results[0].window)}（{data.results[0].window.timezone}）</Text> : null}
      {error ? <Alert type="error" showIcon message="对账数据加载失败" description={error} action={<Button size="small" onClick={() => loadWindow(activeWindow, true)}>重试</Button>} style={{ marginBottom: 16 }} /> : null}
      {config?.channelsError ? <Alert type="warning" showIcon message="本站渠道目录读取失败" description={config.channelsError} style={{ marginBottom: 16 }} /> : null}

      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: compact ? 16 : "18px 24px" } }}>
        <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "1.2fr 1fr 1.1fr .8fr", gap: 20 }}>
          <Statistic title="本站收费" value={money(totals.income, rate)} valueStyle={{ fontVariantNumeric: "tabular-nums" }} />
          <Statistic title="上游成本" value={money(totals.cost, rate)} valueStyle={{ fontVariantNumeric: "tabular-nums" }} />
          <Statistic title="差额" value={money(totalDifference, rate)} valueStyle={{ color: totalDifference >= 0 ? "var(--jy-success)" : "var(--jy-danger)", fontVariantNumeric: "tabular-nums" }} />
          <Statistic title="毛利率" value={percent(totalMargin)} valueStyle={{ fontVariantNumeric: "tabular-nums" }} />
        </div>
        <Text type="secondary" style={{ display: "block", marginTop: 14, fontSize: 12 }}>上游完整成本仅在父规则统计；子渠道只展示本站收费与占比。</Text>
      </Card>

      {!results.length ? (
        <Card><Empty description="还没有启用的对账规则" image={Empty.PRESENTED_IMAGE_SIMPLE}><Button type="primary" onClick={openCreate}>创建第一条规则</Button></Empty></Card>
      ) : results.map((item: any) => (
        <RuleRow key={item.rule?.id} item={item} rate={rate} compact={compact} upstreams={config?.upstreams} onEdit={() => openEdit(item.rule)} onDelete={() => stopRule(item.rule.id)} onDetail={() => openDetail(item)} />
      ))}

      <Drawer title={detail?.rule?.tokenName ? `${detail.rule.tokenName} · 对账详情` : "对账详情"} open={!!detail} onClose={() => setDetail(null)} width={compact ? "100%" : 520}>
        {detail ? <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert type={detail.health?.code === "READY" ? "success" : "warning"} showIcon message={detail.health?.label} description={detail.health?.detail || "数据来源正常"} />
          <Detail label="查询窗口" value={`${formatWindow(detail.window)}（${detail.window?.timezone}）`} />
          <Detail label="上游账号" value={upstreamName(detail.rule, config?.upstreams)} />
          <Detail label="上游 Key / 分组" value={`${detail.rule?.tokenName || "—"} · ${detail.upstream?.group || detail.rule?.fixedGroup || "—"}`} />
          <Detail label="关联销售渠道" value={linkedChannelNames(detail.rule, detail)} />
          <Detail label="当前倍率" value={detail.upstream?.ratio == null ? "未返回" : `${detail.upstream.ratio}×`} />
          <Detail label="本站收费" value={money(detail.downstream?.amountUsd, rate)} />
          <Detail label="上游成本" value={money(detail.upstream?.amountUsd, rate)} />
          <Detail label="数据覆盖" value={percent(detail.downstream?.coverage)} />
          {(detail.health?.issues || []).map((issue: any, index: number) => <Alert key={`${issue.code}-${index}`} type={issue.code.includes("MISSING") || issue.code.includes("UNAVAILABLE") ? "error" : "warning"} showIcon message={HEALTH_LABEL(issue.code)} description={issue.detail} />)}
          {transitionSegments.some((segment: any) => segment.timingSource === "detected") ? <Space wrap>
            <Select value={transitionSegmentId} onChange={setTransitionSegmentId} placeholder="选择待确认的切换分段" style={{ minWidth: compact ? "100%" : 230 }} options={transitionSegments.filter((segment: any) => segment.timingSource === "detected").map((segment: any) => ({ value: segment.id, label: `${segment.group} · ${formatWindow(segment.window || { startMs: segment.effectiveFrom, endMs: segment.effectiveTo ?? Date.now(), timezone: detail.window?.timezone })}` }))} />
            <DatePicker showTime value={transitionAt} onChange={(value) => setTransitionAt(value)} placeholder="实际切换时间" />
            <Button onClick={correctTransition}>修正切换时间</Button>
          </Space> : null}
          <SegmentTimeline item={detail} rate={rate} />
          <RuleChildren item={detail} rate={rate} />
        </Space> : null}
      </Drawer>

      <Drawer title={editing ? "编辑对账规则" : "添加对账规则"} open={drawerOpen} onClose={() => setDrawerOpen(false)} width={compact ? "100%" : 520} extra={<Button type="primary" loading={saving} htmlType="submit" form="reconciliation-rule-form">保存规则</Button>}>
        <Form id="reconciliation-rule-form" form={form} layout="vertical" requiredMark={false} onFinish={saveRule}>
          <Form.Item label="上游账号" name="upstreamStationId" extra="复用该站点已有 PAT，不需要再次填写。" rules={[{ required: true, message: "请选择上游账号" }]}>
            <Select showSearch optionFilterProp="label" placeholder="选择已配置的 NewAPI 上游站点" options={(config?.upstreams || []).map((station: any) => ({ value: station.id, label: station.name }))} onChange={(value) => { form.setFieldValue("tokenId", undefined); setKeyData(null); fetchKeys(value, true); }} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          <Form.Item label="固定分组 Key" name="tokenId" extra="仅显示固定分组、未启用跨组重试且当前可用的 Key。" rules={[{ required: true, message: "请选择固定分组 Key" }]}>
            <Select showSearch optionFilterProp="label" loading={keyLoading} disabled={!upstreamId || keyLoading} placeholder={upstreamId ? "选择上游 Key" : "请先选择上游账号"} options={(keyData?.tokens || []).map((item: any) => ({ value: item.id, disabled: item.status !== 1 || item.group === "auto" || item.crossGroupRetry, label: `${item.name} · ${item.group || "无分组"}${keyData?.groups?.[item.group]?.ratio != null ? ` · ${keyData.groups[item.group].ratio}×` : ""}` }))} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
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
  return ({ SALES_CHANNEL_DISABLED: "本站销售渠道已禁用", SALES_CHANNEL_MISSING: "本站销售渠道已缺失", ROUTE_TRANSITION_DETECTED: "已检测到上游分组或倍率变化", SEGMENT_TIMING_UNCONFIRMED: "分段切换时间待确认" } as Record<string, string>)[code] || code;
}
