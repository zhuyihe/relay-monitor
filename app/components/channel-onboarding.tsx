"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Input, List, Select, Space, Tag, Typography } from "antd";

const { Text } = Typography;
const TYPES = [
  { value: "newapi", label: "New API · 账号余额" },
  { value: "newapi-key", label: "New API · Key 额度" },
  { value: "sub2api", label: "Sub2API · 登录令牌" },
  { value: "sub2api-password", label: "Sub2API · 账号密码" },
];
const CREDENTIALS: Record<string, string[]> = {
  newapi: ["accessToken", "userId"], "newapi-key": ["apiKey"],
  sub2api: ["accessToken"], "sub2api-password": ["email", "password"],
};
const STATES: Record<string, string> = {
  unlinked: "未关联", linked: "已关联", unconfigured: "未配置", configured: "已配置",
  review_required: "待重新确认", unverified: "账单能力待验证", unsupported: "账单能力不支持",
  unavailable: "暂不可用", pending: "待完成", not_requested: "仅监控", ready: "可配置对账",
};

// 接入错误保留步骤和预览，供同一抽屉补齐或重新确认。
async function request(path: string, body?: any) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET", credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.location.href = "/login";
  if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), result);
  return result;
}

function connection(values: any) {
  const type = values.type || "newapi";
  return Object.fromEntries(["name", "baseUrl", "type", ...(CREDENTIALS[type] || [])].map((key) => [key, values[key] ?? ""]));
}

function stationLabel(station: any) {
  return `${station.name} · ${TYPES.find((type) => type.value === station.type)?.label || station.type}${station.identity?.accountId ? ` · 账号 ${station.identity.accountId}` : ""}`;
}

function CredentialFields({ type }: { type: string }) {
  return <>
    {type === "newapi" || type === "sub2api" ? <Form.Item name="accessToken" label={type === "newapi" ? "上游系统访问令牌" : "上游登录令牌"} rules={[{ required: true, message: "请输入令牌" }]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "newapi" ? <Form.Item name="userId" label="上游用户 ID" extra="上游要求 New-Api-User 时填写。"><Input /></Form.Item> : null}
    {type === "newapi-key" ? <Form.Item name="apiKey" label="上游 API Key" rules={[{ required: true, message: "请输入 API Key" }]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "sub2api-password" ? <><Form.Item name="email" label="上游登录邮箱" rules={[{ required: true, message: "请输入登录邮箱" }]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label="上游登录密码" rules={[{ required: true, message: "请输入登录密码" }]}><Input.Password autoComplete="current-password" /></Form.Item></> : null}
  </>;
}

export default function ChannelOnboarding({ compact, onComplete }: {
  compact: boolean; onComplete: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [catalogue, setCatalogue] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [channel, setChannel] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [stationId, setStationId] = useState<string>();
  const [additionalIds, setAdditionalIds] = useState<string[]>([]);
  const [billing, setBilling] = useState(false);
  const [authorizationId, setAuthorizationId] = useState("self");
  const [tokenId, setTokenId] = useState<number>();
  const [coverage, setCoverage] = useState("unknown");
  const [updateCredentials, setUpdateCredentials] = useState(false);
  const [probe, setProbe] = useState<any>(null);
  const [approved, setApproved] = useState(false);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<any>(null);
  const [retryInput, setRetryInput] = useState<any>(null);
  const [form] = Form.useForm();
  const [authorizationForm] = Form.useForm();
  const formType = Form.useWatch("type", form) || "newapi";
  const authorizationType = Form.useWatch("type", authorizationForm) || "newapi";
  const generation = useRef(0);
  const discoveryInFlight = useRef(false);
  const busy = probing || saving;
  const stale = !catalogue || catalogue.stale || !!directoryError;
  const upstreams = catalogue?.upstreams || [];
  const monitors = upstreams.filter((item: any) => item.monitorEnabled !== false);
  const main = upstreams.find((item: any) => item.id === stationId);
  const requiresAuthorization = (creating ? formType : main?.type) === "newapi-key";

  const invalidate = (credentials = false) => {
    generation.current += 1;
    setApproved(false);
    setFailure("");
    if (credentials) { setProbe(null); setTokenId(undefined); setUpdateCredentials(false); }
  };

  const changeMonitor = (clearBilling = authorizationId === "self") => {
    setRetryInput((previous: any) => previous ? { ...previous, stationId: undefined,
      reconciliation: clearBilling ? { ...previous.reconciliation, upstreamStationId: undefined } : previous.reconciliation } : null);
    invalidate(true);
  };

  const changeAuthorization = (id: string) => {
    setAuthorizationId(id);
    setRetryInput((previous: any) => previous ? { ...previous, reconciliation: { ...previous.reconciliation, upstreamStationId: undefined } } : null);
    invalidate(true);
  };

  const load = async (sync = true, refreshOpen = true) => {
    if (discoveryInFlight.current) return;
    discoveryInFlight.current = true;
    setRefreshing(true);
    try {
      const next = await request(`/api/channel-onboarding${sync ? "/sync" : ""}`, sync ? {} : undefined);
      setCatalogue((previous: any) => next.stale && !next.channels?.length && previous?.channels?.length ? { ...next, channels: previous.channels } : next);
      setDirectoryError(next.error || "");
      if (channel && refreshOpen) {
        const current = next.channels?.find((item: any) => item.id === channel.id);
        if (!current || current.revision !== channel.revision || next.ownStation?.id !== catalogue?.ownStation?.id) invalidate(true);
        if (current) setChannel(current);
      }
      return next;
    } catch (err: any) {
      setDirectoryError(err.message || "渠道目录暂不可用");
      setApproved(false);
    } finally { discoveryInFlight.current = false; setRefreshing(false); }
  };

  useEffect(() => {
    void (async () => { await load(false); await load(true); })();
    return () => { generation.current += 1; };
  // 目录由后台同步；这里只在进入页面时立即发现。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (entry: any) => {
    invalidate(true);
    setChannel(entry);
    setResult(null);
    setRetryInput(null);
    setAdditionalIds(entry.monitor?.stationIds?.slice(1) || []);
    setBilling(false);
    setCoverage("unknown");
    setAuthorizationId("self");
    const selected = entry.monitor?.stationIds?.[0] || (entry.candidates?.length === 1 ? (entry.candidates[0]?.id || entry.candidates[0]) : undefined);
    const existing = monitors.find((item: any) => item.id === selected);
    setStationId(existing?.id);
    setCreating(!existing);
    form.resetFields();
    form.setFieldsValue({ name: entry.name, baseUrl: entry.baseUrl || "", type: "newapi" });
    authorizationForm.resetFields();
    authorizationForm.setFieldsValue({ name: `${entry.name || "上游"}账单授权`, baseUrl: entry.baseUrl || "", type: "newapi" });
  };

  const buildInput = async () => {
    const input: any = { ownStationId: catalogue.ownStation.id, channelId: channel.id, channelRevision: channel.revision, additionalMonitorStationIds: additionalIds, updateCredentials };
    if (creating && !retryInput?.stationId) input.newStation = connection(await form.validateFields());
    else input.stationId = retryInput?.stationId || stationId;
    if (billing) {
      input.reconciliation = { tokenId, costCoverage: coverage, timezone: probe?.preview?.timezone || "Asia/Shanghai" };
      if (authorizationId === "new" && !retryInput?.reconciliation?.upstreamStationId) input.reconciliation.newAuthorization = connection(await authorizationForm.validateFields());
      else if (authorizationId !== "self") input.reconciliation.upstreamStationId = retryInput?.reconciliation?.upstreamStationId || authorizationId;
      if (probe?.preview?.billingEffectiveFromMs != null) input.reconciliation.previewEffectiveFromMs = probe.preview.billingEffectiveFromMs;
    }
    if (retryInput) {
      // 未落库的授权继续留在表单；已落库的只传公开 ID。
      Object.assign(input, retryInput, { reconciliation: billing ? { ...retryInput.reconciliation, ...input.reconciliation } : undefined });
      input.ownStationId = catalogue.ownStation.id;
      input.channelRevision = channel.revision;
      input.additionalMonitorStationIds = additionalIds;
      input.updateCredentials = updateCredentials;
      if (input.stationId) delete input.newStation;
      if (input.reconciliation?.upstreamStationId) delete input.reconciliation.newAuthorization;
    }
    return input;
  };

  const verify = async () => {
    setFailure("");
    try {
      const input = await buildInput();
      const current = ++generation.current;
      setProbing(true);
      const next = await request("/api/channel-onboarding/probe", input);
      if (current !== generation.current) return;
      setProbe(next);
      setApproved(next.monitor?.status === "verified");
      if (next.channelRevision && next.channelRevision !== channel.revision) setChannel({ ...channel, revision: next.channelRevision });
    } catch (err: any) {
      if (!err.errorFields) setFailure(err.message || "验证失败，请重试");
      setApproved(false);
    } finally { setProbing(false); }
  };

  const save = async () => {
    setSaving(true);
    setFailure("");
    try {
      const next = await request("/api/channel-onboarding", await buildInput());
      setResult(next);
      const completed = next.complete === true && next.monitor?.status === "linked" && (!billing || next.reconciliation?.status === "configured");
      if (completed) {
        setChannel(null);
        message.success(billing ? "监控关联与对账配置已保存，账单按完整窗口获取" : "监控关联已保存");
        await load(false, false);
        await onComplete().catch(() => message.warning("配置已保存，页面刷新失败，请刷新页面"));
        return;
      }
      setRetryInput(next.retryInput || { stationId: next.saved?.stationIds?.[0], ...(next.saved?.authorizationStationId ? { reconciliation: { upstreamStationId: next.saved.authorizationStationId } } : {}) });
      if (next.saved?.stationIds?.[0]) { setStationId(next.saved.stationIds[0]); setCreating(false); }
      if (next.saved?.authorizationStationId) setAuthorizationId(next.saved.authorizationStationId);
      if (next.code === "EFFECTIVE_PREVIEW_CHANGED") { setProbe((previous: any) => ({ ...previous, preview: next.preview })); setApproved(false); }
      if (["CHANNEL_SOURCE_CHANGED", "CHANNEL_CATALOGUE_STALE"].includes(next.code)) { setApproved(false); await load(true); }
      else await load(false);
      await onComplete().catch(() => {});
    } catch (err: any) {
      setFailure(err.message || "保存失败，请原地重试");
      if (err.code === "EFFECTIVE_PREVIEW_CHANGED") { setProbe((previous: any) => ({ ...previous, preview: err.preview })); setApproved(false); }
      if (["CHANNEL_SOURCE_CHANGED", "CHANNEL_CATALOGUE_STALE"].includes(err.code)) { setApproved(false); await load(true); }
    } finally { setSaving(false); }
  };

  const changeForm = (changed: any, target: any) => {
    if (changed.type) {
      const allowed = CREDENTIALS[changed.type] || [];
      target.setFieldsValue(Object.fromEntries(["accessToken", "userId", "apiKey", "email", "password"].filter((key) => !allowed.includes(key)).map((key) => [key, ""])));
      if (target === form && billing) changeAuthorization(changed.type === "newapi-key" ? "new" : "self");
    }
    if (Object.keys(changed).some((key) => key !== "name")) invalidate(true);
  };
  const keys = probe?.reconciliation?.tokens || [];
  const needsKey = billing && ["ready", "supported"].includes(probe?.reconciliation?.status) && !tokenId;
  const canSave = approved && !stale && !busy && !needsKey && (!probe?.credentialUpdateRequired || updateCredentials) && !!(creating || stationId);
  const existingIds = probe?.reconciliation?.existingChannelIds || [];
  const date = probe?.preview?.billingEffectiveFromMs;
  const effective = date == null ? "待验证" : new Intl.DateTimeFormat("zh-CN", { timeZone: probe.preview.timezone || "Asia/Shanghai", dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(date));

  return <>
    <Collapse style={{ marginBottom: 16 }} defaultActiveKey={["connections"]} items={[{
      key: "connections", label: `渠道接入 · ${catalogue?.channels?.length || 0}`,
      extra: <Button aria-label="发现新渠道" style={{ minHeight: 40 }} size="small" loading={refreshing} onClick={(event) => { event.stopPropagation(); void load(true); }}>发现新渠道</Button>,
      children: <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <Text type="secondary">本站 New API 的渠道和分组自动带入，后台每 5 分钟发现。首次关联上游后，资源监控与对账共用。</Text>
        {stale && catalogue ? <Alert type="warning" showIcon message="渠道目录读取失败，正在显示上次发现的渠道" description={directoryError || catalogue.error || "目录待刷新，暂不能新增关联。"} /> : directoryError ? <Alert type="error" showIcon message="渠道目录暂不可用" description={directoryError} /> : null}
        {catalogue?.syncedAt ? <Text type="secondary">上次成功发现：{new Date(catalogue.syncedAt).toLocaleString("zh-CN")}{stale ? "（已过期）" : ""}</Text> : null}
        <List loading={refreshing && !catalogue} dataSource={catalogue?.channels || []} locale={{ emptyText: stale ? "渠道目录暂不可用，请重试发现" : catalogue?.ownStation ? "暂无渠道，请在本站 New API 添加后发现" : "请先配置我的中转站，以读取渠道目录" }} pagination={(catalogue?.channels?.length || 0) > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false}
          renderItem={(entry: any) => <List.Item style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <div style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>
              <Space wrap><Text strong>{entry.name || `渠道 #${entry.id}`}</Text><Tag>{Number(entry.status) === 1 ? "启用" : Number(entry.status) === 2 ? "手动停用" : Number(entry.status) === 3 ? "自动停用" : "状态未知"}</Tag></Space>
              <div><Text type="secondary">本站分组：{entry.groups?.join("、") || "未提供"}</Text></div>
              <div><Text type="secondary">{entry.baseUrl || "渠道未提供上游地址，接入时补充"}</Text></div>
              <Space wrap><Text>监控：{STATES[entry.monitor?.status] || "未关联"}</Text><Text>对账：{STATES[entry.reconciliation?.status] || "未配置"}</Text></Space>
            </div>
            <Button style={{ minHeight: 44 }} disabled={refreshing || stale} onClick={() => open(entry)} aria-label={`接入渠道 ${entry.name || entry.id}`}>{entry.monitor?.status === "linked" ? "管理关联" : "接入监控与对账"}</Button>
          </List.Item>} />
      </Space>,
    }]} />
    <Drawer title="接入监控与对账" aria-label="接入监控与对账" open={!!channel} width={compact ? "100%" : 560} closable={!busy} maskClosable={!busy} keyboard={!busy}
      onClose={() => { generation.current += 1; setChannel(null); }} extra={<Button aria-label={result ? "重试未完成步骤" : "确认关联"} style={{ minHeight: 44 }} type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>{result ? "重试未完成步骤" : "确认关联"}</Button>}>
      {channel ? <Space direction="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
        <Alert type="info" showIcon message={channel.name || `渠道 #${channel.id}`} description={`本站销售分组：${channel.groups?.join("、") || "未提供"}。渠道信息来自 New API，无需再次填写。`} />
        {stale ? <Alert type="warning" showIcon message="目录已过期，请重新发现后验证" /> : null}
        {failure ? <Alert type="error" showIcon message={failure} /> : null}
        {result ? <Alert type="warning" showIcon message="接入尚有待完成步骤，已保存部分会继续复用" description={<Space direction="vertical"><Text>监控：{STATES[result.monitor?.status] || result.monitor?.status} {result.monitor?.reason}</Text><Text>对账：{STATES[result.reconciliation?.status] || result.reconciliation?.status} {result.reconciliation?.reason}</Text><Text>已保存资源：{result.saved?.stationIds?.join("、") || "无"}{result.saved?.authorizationStationId ? `；账单授权：${result.saved.authorizationStationId}` : ""}{result.saved?.ruleId ? `；规则：${result.saved.ruleId}` : ""}</Text>{result.code === "EFFECTIVE_PREVIEW_CHANGED" ? <Text>完整日边界已变化，请重新验证并确认新的生效时间。</Text> : null}</Space>} /> : null}
        <Checkbox checked={creating} disabled={busy} onChange={(event) => { setCreating(event.target.checked); changeMonitor(); }}>填写或更新上游授权</Checkbox>
        {creating ? <Form form={form} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, form)}>
          <Form.Item name="type" label="监控方式"><Select options={TYPES} /></Form.Item>
          <Form.Item name="name" label="上游资源名称" rules={[{ required: true, message: "请输入资源名称" }]}><Input /></Form.Item>
          <Form.Item name="baseUrl" label="上游站点地址" rules={[{ required: true, message: "请输入站点地址" }]}><Input placeholder="https://upstream.example.com" /></Form.Item>
          <CredentialFields type={formType} />
        </Form> : <div><Text strong>上游监控资源</Text><Select aria-label="接入上游资源" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={stationId} disabled={busy} placeholder="复用已有账号或 Key，无需重填凭证" options={monitors.map((item: any) => ({ value: item.id, label: stationLabel(item) }))} onChange={(id) => { setStationId(id); setAuthorizationId("self"); changeMonitor(true); }} /></div>}
        <div><Text>同时关联其他已有监控资源（可选）</Text><Select aria-label="其他监控资源" mode="multiple" style={{ width: "100%", marginTop: 8 }} value={additionalIds} disabled={busy} options={monitors.filter((item: any) => item.id !== stationId).map((item: any) => ({ value: item.id, label: item.name }))} onChange={(ids) => { setAdditionalIds(ids); invalidate(); }} /></div>
        {additionalIds.length ? <Alert type="warning" showIcon message="核对整体监控成本" description="账号余额与 Key 额度可能覆盖同一消费。将沿用各资源的整体成本纳入设置，请核对是否重复计入；Key 对账的成本只算一次，整体监控成本设置需要另行核对。" /> : null}
        <Checkbox checked={billing} disabled={busy || !!result?.saved?.ruleId} onChange={(event) => { setBilling(event.target.checked); if (requiresAuthorization) setAuthorizationId(upstreams.find((item: any) => item.type !== "newapi-key")?.id || "new"); invalidate(true); }}>同时配置 Key 对账</Checkbox>
        {billing ? <>
          <div><Text strong>账号账单授权</Text><Select aria-label="接入账单授权" style={{ width: "100%", marginTop: 8 }} value={authorizationId} disabled={busy} options={[...(!requiresAuthorization ? [{ value: "self", label: "复用所选资源的账号授权" }] : []), ...upstreams.filter((item: any) => item.type !== "newapi-key").map((item: any) => ({ value: item.id, label: `${item.name}${item.monitorEnabled === false ? " · 账单专用" : ""}` })), { value: "new", label: "补充或更新账号账单授权" }]} onChange={changeAuthorization} /></div>
          {authorizationId === "new" ? <><Alert type="info" showIcon message="账单授权只补一次" description="专用授权用于查账，不增加余额监控、告警或整体成本。" /><Form form={authorizationForm} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, authorizationForm)}>
            <Form.Item name="type" label="账单授权方式"><Select options={TYPES.filter((type) => type.value !== "newapi-key")} /></Form.Item>
            <Form.Item name="name" label="账单授权名称" rules={[{ required: true, message: "请输入授权名称" }]}><Input /></Form.Item>
            <Form.Item name="baseUrl" label="账单站点地址" rules={[{ required: true, message: "请输入站点地址" }]}><Input /></Form.Item><CredentialFields type={authorizationType} />
          </Form></> : null}
          <div><Text strong>渠道实际使用的上游 Key</Text><Select aria-label="接入上游 Key" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={tokenId} disabled={busy || !keys.length} placeholder="验证后选择实际 Key" options={keys.map((item: any) => ({ value: Number(item.id), disabled: item.status !== 1 || item.crossGroupRetry || item.group === "auto", label: `${item.name} · 上游分组 ${item.group || "未提供"}` }))} onChange={(id) => { setTokenId(id); invalidate(); }} /></div>
          <div><Text strong>Key 消费范围</Text><Select aria-label="Key 消费范围" style={{ width: "100%", marginTop: 8 }} value={coverage} disabled={busy} options={[{ value: "unknown", label: "范围待确认，只展示金额参考" }, { value: "complete", label: "该 Key 仅供已关联及本次加入的渠道使用" }]} onChange={(value) => { setCoverage(value); invalidate(); }} /></div>
        </> : <Text type="secondary">仅关联资源监控，无需选择 Key 或补账号账单权限。</Text>}
        <Button aria-label="验证并预览" style={{ minHeight: 44 }} loading={probing} disabled={saving || stale || (!creating && !stationId)} onClick={() => void verify()}>验证并预览</Button>
        {probe ? <>
          <Alert type={probe.monitor?.status === "verified" ? "success" : "warning"} showIcon message={probe.monitor?.status === "verified" ? "监控连接已验证，尚未保存" : "监控连接待完成"} description={probe.monitor?.reason || "确认关联后才保存；取消不会创建资源或触发告警。"} />
          {probe.credentialUpdateRequired ? <><Text type="secondary">已识别监控资源：{probe.station?.name || "上游账号"}{probe.station?.identity?.accountId ? ` · 账号 ${probe.station.identity.accountId}` : ""}{probe.reconciliation?.upstreamStationId ? `；账单授权：${upstreams.find((item: any) => item.id === probe.reconciliation.upstreamStationId)?.name || probe.reconciliation.upstreamStationId}` : ""}</Text><Checkbox checked={updateCredentials} disabled={busy} onChange={(event) => setUpdateCredentials(event.target.checked)}>已发现相同账号，确认用本次授权更新已有凭证</Checkbox></> : null}
          {billing ? <Alert type="info" showIcon message={probe.reconciliation?.existingRuleId ? "加入已有对账规则" : STATES[probe.reconciliation?.status] || "对账预览"} description={<Space direction="vertical"><Text>{probe.reconciliation?.reason}</Text><Text>已有渠道：{existingIds.length ? existingIds.map((id: number) => catalogue.channels.find((item: any) => item.id === id)?.name || `#${id}`).join("、") : "无"}；本次加入：{channel.name || channel.id}</Text><Text>完整日生效：{effective}（{probe.preview?.timezone || "Asia/Shanghai"}）。该日结束且两侧账单完整后确认利润，关联当天保留金额参考。</Text><Text>同一 Key 成本只算一次；消费范围待确认时不确认精确利润。</Text></Space>} /> : null}
          {!approved ? <Text type="warning">选择或连接信息已变化，请重新验证并预览。</Text> : null}
        </> : null}
      </Space> : null}
    </Drawer>
  </>;
}
