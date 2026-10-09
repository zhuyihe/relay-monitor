"use client";

import { useMemo, useRef, useState } from "react";
import { Alert, App, Button, Collapse, Drawer, Form, Input, List, Select, Space, Tag, Typography } from "antd";
import { api } from "../../lib/client";
import { channelConnectionRule, onboardingBaseUrl, pendingChannelConnections } from "../../lib/channel-onboarding";

const { Text } = Typography;

export default function ChannelOnboarding({ config, compact, refreshing, error, onRefresh, onComplete }: {
  config: any; compact: boolean; refreshing: boolean; error: string;
  onRefresh: () => Promise<void>; onComplete: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const entries = useMemo(() => pendingChannelConnections(config || {}), [config]);
  const [channel, setChannel] = useState<any>(null);
  const [source, setSource] = useState<any>(null);
  const [upstreamId, setUpstreamId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [keys, setKeys] = useState<any>(null);
  const [tokenId, setTokenId] = useState<number | undefined>();
  const [keyLoading, setKeyLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [connected, setConnected] = useState<any>(null);
  const keyRequest = useRef(0);
  const busy = connecting || saving;
  const existingRule = channelConnectionRule(config?.rules || [], source?.id, upstreamId, tokenId);
  const upstreams = connected && !(config?.upstreams || []).some((station: any) => station.id === connected.id)
    ? [...(config?.upstreams || []), connected] : config?.upstreams || [];

  const loadKeys = async (id: string) => {
    const requestId = ++keyRequest.current;
    setUpstreamId(id);
    setKeys(null);
    setTokenId(undefined);
    setFailure("");
    setKeyLoading(true);
    try {
      const next = await api(`/api/reconciliation/upstreams/${encodeURIComponent(id)}/keys?force=true`);
      if (requestId === keyRequest.current) setKeys(next);
    } catch (err: any) {
      if (requestId === keyRequest.current) setFailure(err?.message || "读取上游 Key 失败，请重试");
    } finally {
      if (requestId === keyRequest.current) setKeyLoading(false);
    }
  };

  const open = (entry: any) => {
    keyRequest.current += 1;
    setChannel(entry);
    setSource(config.ownStation);
    setKeys(null);
    setTokenId(undefined);
    setKeyLoading(false);
    setFailure("");
    setConnected(null);
    const candidate = entry.candidates.length === 1 ? entry.candidates[0] : null;
    setCreating(!entry.candidates.length);
    setUpstreamId(candidate?.id);
    if (candidate) void loadKeys(candidate.id);
  };

  const connect = async (values: any) => {
    setConnecting(true);
    setFailure("");
    try {
      const result = await api("/api/reconciliation/upstreams", { method: "POST", body: values });
      // 账号已持久化，即使后续 Key 读取失败，也能在同一入口重试并复用。
      setConnected(result.station);
      setCreating(false);
      setUpstreamId(result.station.id);
      await onRefresh();
      await loadKeys(result.station.id);
    } catch (err: any) {
      setFailure(err?.message || "接入账号失败，请稍后重试");
    } finally { setConnecting(false); }
  };

  const save = async () => {
    if (!upstreamId || !tokenId || !channel) return;
    setSaving(true);
    setFailure("");
    try {
      const latest = await api("/api/reconciliation/configuration?refreshChannels=true");
      if (latest.channelsError) throw new Error(latest.channelsError);
      if (latest.ownStation?.id !== source?.id || latest.ownStation?.baseUrl !== source?.baseUrl) {
        throw new Error("本站来源已变化，请关闭后重新选择渠道");
      }
      const rule = channelConnectionRule(latest.rules || [], source.id, upstreamId, tokenId);
      const salesChannelIds = [...new Set([...(rule?.channels || []).map((item: any) => Number(item.channelId)), Number(channel.id)])];
      await api(rule ? `/api/reconciliation/rules/${encodeURIComponent(rule.id)}` : "/api/reconciliation/rules", {
        method: rule ? "PUT" : "POST",
        body: { upstreamStationId: upstreamId, tokenId, salesChannelIds, timezone: rule?.timezone || "Asia/Shanghai" },
      });
      setChannel(null);
      message.success("渠道已接入，上游账号用于资源监控，销售渠道用于对账");
      await onComplete().catch(() => message.warning("关联已保存，列表刷新失败，请重新发现渠道"));
    } catch (err: any) {
      setFailure(err?.message || "关联失败，请稍后重试");
    } finally { setSaving(false); }
  };

  return <>
    <Collapse style={{ marginBottom: 16 }} defaultActiveKey={["connections"]} items={[{
      key: "connections",
      label: `待接入渠道 · ${entries.length}`,
      extra: <Button size="small" loading={refreshing} onClick={(event) => { event.stopPropagation(); void onRefresh(); }}>发现新渠道</Button>,
      children: <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Text type="secondary">渠道信息从本站 New API 自动读取，每分钟发现一次。选择上游账号和 Key 后，同步用于资源监控与渠道对账。</Text>
        {error || config?.channelsError ? <Alert type="warning" showIcon message="渠道目录读取失败，正在显示上次发现的渠道" description={error || config.channelsError} /> : null}
        <List dataSource={entries} locale={{ emptyText: error || config?.channelsError ? "渠道目录暂不可用，请重试发现" : "暂无待接入渠道，无需重复配置" }} pagination={entries.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false}
          renderItem={(entry: any) => <List.Item style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <div style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>
              <Space wrap><Text strong>{entry.name || `渠道 #${entry.id}`}</Text><Tag>{Number(entry.status) === 1 ? "启用" : Number(entry.status) === 2 ? "手动停用" : Number(entry.status) === 3 ? "自动停用" : "状态未知"}</Tag></Space>
              <div><Text type="secondary">本站分组：{entry.groups?.join("、") || "未提供"}</Text></div>
              <div><Text type="secondary">{entry.baseUrl || "渠道未提供上游地址，接入时补充"}</Text></div>
              <div><Text type="secondary">{entry.candidates.length === 1 ? `可复用账号：${entry.candidates[0].name}` : entry.candidates.length > 1 ? "该地址有多个账号，接入时选择" : "首次接入时补充上游账号授权"}</Text></div>
            </div>
            <Button style={{ minHeight: 44 }} disabled={refreshing || !!error || !!config?.channelsError} onClick={() => open(entry)} aria-label={`接入渠道 ${entry.name || entry.id}`}>接入监控与对账</Button>
          </List.Item>} />
      </Space>,
    }]} />
    <Drawer title="接入监控与对账" aria-label="接入监控与对账" open={!!channel} width={compact ? "100%" : 520} closable={!busy} maskClosable={!busy} keyboard={!busy}
      onClose={() => { keyRequest.current += 1; setChannel(null); }}
      extra={<Button type="primary" loading={saving} disabled={creating || !tokenId || keyLoading || connecting || !!error || !!config?.channelsError} onClick={() => void save()}>确认关联</Button>}>
      {channel ? <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert type="info" showIcon message={channel.name || `渠道 #${channel.id}`} description={`本站销售分组：${channel.groups?.join("、") || "未提供"}。这些信息来自 New API，无需再次填写。`} />
        {connected ? <Alert type="success" showIcon message="账号已接入资源监控" description="继续选择 Key 完成对账关联。关闭后账号也会保留，下次可直接复用。" /> : null}
        {failure ? <Alert type="error" showIcon message={failure} /> : null}
        {creating ? <Form layout="vertical" requiredMark={false} onFinish={connect} disabled={busy} initialValues={{ name: channel.name, baseUrl: onboardingBaseUrl(channel.baseUrl) }}>
          <Alert type="info" showIcon message="首次接入上游账号" description="填写上游 New API 账号的系统访问令牌，只需一次；用于读取余额和 Key 目录。本站渠道的调用密钥不能替代账号访问令牌。" style={{ marginBottom: 16 }} />
          <Form.Item name="name" label="上游账号名称" rules={[{ required: true, message: "请输入账号名称" }]}><Input /></Form.Item>
          <Form.Item name="baseUrl" label="上游站点地址" rules={[{ required: true, message: "请输入上游地址" }]}><Input placeholder="https://upstream.example.com" /></Form.Item>
          <Form.Item name="accessToken" label="上游系统访问令牌" rules={[{ required: true, message: "请输入访问令牌" }]}><Input.Password autoComplete="off" /></Form.Item>
          <Form.Item name="userId" label="上游用户 ID" extra="可自动识别的站点无需填写；上游要求 New-Api-User 时填写。"><Input /></Form.Item>
          <Space wrap><Button type="primary" htmlType="submit" loading={connecting}>验证并接入账号</Button><Button disabled={busy} onClick={() => { setCreating(false); setFailure(""); }}>选择已有账号</Button></Space>
        </Form> : <>
          <div><Text strong>上游账号</Text><Select aria-label="接入上游账号" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={upstreamId} disabled={busy} placeholder="选择已接入的 New API 账号" options={upstreams.map((station: any) => ({ value: station.id, label: station.name }))} onChange={(id) => { setConnected(null); void loadKeys(id); }} />
            <Button type="link" disabled={busy} onClick={() => { keyRequest.current += 1; setCreating(true); setKeys(null); setTokenId(undefined); setKeyLoading(false); setFailure(""); }}>接入另一个上游账号</Button>
          </div>
          <div><Text strong>渠道实际使用的上游 Key</Text><Select aria-label="接入上游 Key" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={tokenId} loading={keyLoading} disabled={!upstreamId || keyLoading || busy} placeholder="确认该渠道使用的 Key" options={(keys?.tokens || []).map((item: any) => ({ value: Number(item.id), disabled: item.status !== 1 || !item.group || item.group === "auto" || item.crossGroupRetry, label: `${item.name} · 上游分组 ${item.group || "未提供"}` }))} onChange={setTokenId} />
            <Button type="link" disabled={!upstreamId || busy} loading={keyLoading} onClick={() => upstreamId && void loadKeys(upstreamId)}>重新读取 Key</Button>
          </div>
          <Alert type="info" showIcon message={existingRule ? "加入已有对账规则" : "确认 Key 后创建对账关联"} description={existingRule ? `将保留已有 ${existingRule.channels?.length || 0} 个销售渠道，并加入本渠道；共用这把 Key 的上游成本。` : "本站销售分组和上游 Key 分组可以不同，请选择渠道实际使用的 Key。仅支持固定分组且未启用跨组重试的 Key。"} />
        </>}
      </Space> : null}
    </Drawer>
  </>;
}
