"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Input, List, Select, Space, Tag, Typography } from "antd";
import { api } from "../../lib/client";
import type { BatchInput, BatchProbe, BatchRecoveryIntent, BatchResult, ConnectionInput, CoverageDeclaration, WorkflowDestination, SourceCatalogueProjection } from "../../lib/client";

const { Text } = Typography;
const TYPES = [{ value: "newapi", label: "New API · 账号余额" }, { value: "newapi-key", label: "New API · Key 额度" }, { value: "sub2api", label: "Sub2API · 登录令牌" }, { value: "sub2api-password", label: "Sub2API · 账号密码" }];
const CREDENTIALS: Record<string, string[]> = { newapi: ["accessToken", "userId"], "newapi-key": ["apiKey"], sub2api: ["accessToken"], "sub2api-password": ["email", "password"] };
const STATES: Record<string, string> = { unlinked: "未关联", linked: "已关联", unconfigured: "未配置", configured: "已配置", review_required: "待重新确认", unverified: "账单能力待验证", unsupported: "账单能力不支持", unavailable: "暂不可用", pending: "待完成", not_requested: "未请求", ready: "可配置对账", monitor_only: "仅监控" };
const RECOVERY_KEY = "channel-onboarding-recovery-v05";
const unknownCoverage = (): CoverageDeclaration => ({ answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] });
async function request(path: string, body?: any) {
  const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.location.href = "/login";
  if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), result);
  return result;
}
function connection(values: any): ConnectionInput {
  const type = values.type || "newapi";
  return Object.fromEntries(["name", "baseUrl", "type", ...(CREDENTIALS[type] || [])].map((key) => [key, values[key] ?? ""])) as ConnectionInput;
}
function stationLabel(station: any) {
  return `${station.name} · ${TYPES.find((type) => type.value === station.type)?.label || station.type}${station.identity?.accountId ? ` · 账号 ${station.identity.accountId}` : ""}${station.monitorEnabled === false ? " · 监控暂停 / 未启用" : ""}`;
}
function CredentialFields({ type }: { type: string }) {
  return <>
    {type === "newapi" || type === "sub2api" ? <Form.Item name="accessToken" label={type === "newapi" ? "上游系统访问令牌" : "上游登录令牌"} rules={[{ required: true, message: "请输入令牌" }]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "newapi" ? <Form.Item name="userId" label="上游用户 ID" extra="上游要求 New-Api-User 时填写。"><Input /></Form.Item> : null}
    {type === "newapi-key" ? <Form.Item name="apiKey" label="上游 API Key" rules={[{ required: true, message: "请输入 API Key" }]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "sub2api-password" ? <><Form.Item name="email" label="上游登录邮箱" rules={[{ required: true, message: "请输入登录邮箱" }]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label="上游登录密码" rules={[{ required: true, message: "请输入登录密码" }]}><Input.Password autoComplete="current-password" /></Form.Item></> : null}
  </>;
}
const time = (value: number | null, timezone: string) => value == null ? "待验证" : new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(value));

export default function ChannelOnboarding({ compact, onComplete, destination }: { compact: boolean; onComplete: () => Promise<void>; destination?: WorkflowDestination | null }) {
  const { message, modal } = App.useApp();
  const [catalogue, setCatalogue] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [workflowError, setWorkflowError] = useState("");
  const destinationResolved = useRef(false);
  const [coverageRule, setCoverageRule] = useState<any>(null);
  const [keyTimezones, setKeyTimezones] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [openIds, setOpenIds] = useState<number[]>([]);
  const [creating, setCreating] = useState(false);
  const [stationId, setStationId] = useState<string>();
  const [monitor, setMonitor] = useState(true);
  const [additionalIds, setAdditionalIds] = useState<string[]>([]);
  const [billing, setBilling] = useState(false);
  const [authorizationId, setAuthorizationId] = useState("self");
  const [tokenId, setTokenId] = useState<number>();
  const [splitKeys, setSplitKeys] = useState(false);
  const [channelKeys, setChannelKeys] = useState<Record<number, number | undefined>>({});
  const [coverage, setCoverage] = useState<Record<string, CoverageDeclaration>>({});
  const [updateCredentials, setUpdateCredentials] = useState(false);
  const [probe, setProbe] = useState<BatchProbe | null>(null);
  const [approved, setApproved] = useState(false);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [retryInput, setRetryInput] = useState<BatchRecoveryIntent | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<BatchRecoveryIntent | null>(null);
  const [requestId, setRequestId] = useState("");
  const [form] = Form.useForm();
  const [authorizationForm] = Form.useForm();
  const formType = Form.useWatch("type", form) || "newapi";
  const authorizationType = Form.useWatch("type", authorizationForm) || "newapi";
  const generation = useRef(0);
  const discoveryInFlight = useRef(false);
  const busy = probing || saving || recovering;
  const stale = !catalogue || catalogue.stale || !!directoryError;
  const upstreams: any[] = catalogue?.upstreams || [];
  const main = upstreams.find((item) => item.id === stationId);
  const requiresAuthorization = (creating ? formType : main?.type) === "newapi-key";
  const channels: any[] = catalogue?.channels || [];
  const source: SourceCatalogueProjection["ownSource"] = catalogue?.ownSource || null;
  const coverageSourceChanged = !!(coverageRule?.ownSource && source && coverageRule.ownSource.namespaceKey !== source.namespaceKey);
  const names = (ids: number[]) => ids.map((id) => channels.find((entry) => entry.id === id)?.name || `#${id}`).join("、") || "无";
  const keys = probe?.selections.flatMap((selection) => selection.tokens) || [];
  const keyOptions = [...new Map(keys.map((key) => [key.id, key])).values()].map((key) => ({ value: key.id, disabled: key.status !== 1 || key.crossGroupRetry || key.group === "auto", label: `${key.name} · 上游分组 ${key.group || "未提供"}` }));
  const groups = new Map<string, number[]>();
  for (const id of openIds) { const key = billing ? String((splitKeys ? channelKeys[id] : tokenId) || "pending") : "monitor"; groups.set(key, [...(groups.get(key) || []), id]); }
  const filtered = channels.filter((entry) => (status === "all" || status === "attention" && (entry.monitor?.status !== "linked" || entry.reconciliation?.status !== "configured") || status === "unlinked" && entry.monitor?.status !== "linked" || status === "configured" && entry.reconciliation?.status === "configured") && `${entry.name} ${entry.id} ${entry.baseUrl} ${(entry.groups || []).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const invalidate = (credentials = false) => {
    generation.current += 1; setApproved(false); setFailure("");
    if (credentials) { setProbe(null); setTokenId(coverageRule?.tokenId); setChannelKeys({}); setUpdateCredentials(false); }
  };
  const remember = (intent: BatchRecoveryIntent | null) => {
    setRetryInput(intent); setPendingRecovery(intent);
    try { if (intent) sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(intent)); else sessionStorage.removeItem(RECOVERY_KEY); } catch { /* 当前抽屉仍可恢复。 */ }
  };
  const load = async (sync = true) => {
    if (discoveryInFlight.current) return;
    discoveryInFlight.current = true; setRefreshing(true);
    try {
      const next = await request(`/api/channel-onboarding${sync ? "/sync" : ""}`, sync ? {} : undefined);
      setCatalogue((previous: any) => next.stale && !next.channels?.length && previous?.channels?.length ? { ...next, channels: previous.channels } : next); setDirectoryError(next.error || "");
      if (openIds.length && (next.sourceVersion !== catalogue?.sourceVersion || next.ownStation?.id !== catalogue?.ownStation?.id || openIds.some((id) => next.channels?.find((entry: any) => entry.id === id)?.revision !== channels.find((entry) => entry.id === id)?.revision))) invalidate(true);
      if (coverageRule?.ownSource && next.ownSource && coverageRule.ownSource.namespaceKey !== next.ownSource.namespaceKey) { generation.current += 1; setApproved(false); setProbe(null); setFailure("本站来源已变化，请关闭此处并核对当前来源后重新打开。"); }
      return next;
    } catch (err: any) { setDirectoryError(err.message || "渠道目录暂不可用"); setApproved(false); }
    finally { discoveryInFlight.current = false; setRefreshing(false); }
  };
  useEffect(() => {
    try { const saved = sessionStorage.getItem(RECOVERY_KEY); if (saved) setPendingRecovery(JSON.parse(saved)); } catch { /* 不阻断目录。 */ }
    void (async () => { await load(false); await load(true); })();
    return () => { generation.current += 1; };
  // 目录由后台同步；这里只在进入页面时立即发现。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = (ids: number[]) => {
    invalidate(true); setTokenId(undefined); setOpenIds(ids); setResult(null); setRetryInput(null); setRequestId(crypto.randomUUID()); setAdditionalIds([]); setBilling(false); setCoverage({}); setCoverageRule(null); setKeyTimezones({}); setSplitKeys(false); setAuthorizationId("self");
    const entries = ids.map((id) => channels.find((entry) => entry.id === id)).filter(Boolean);
    const candidates = entries.map((entry) => entry.monitor?.stationIds?.[0] || (entry.candidates?.length === 1 ? entry.candidates[0]?.id || entry.candidates[0] : undefined));
    const linked = candidates.map((id) => upstreams.find((item) => item.id === id));
    const sameAccount = linked[0]?.identity && linked.every((item) => item?.type !== "newapi-key" && item?.identity?.provider === linked[0].identity.provider && String(item?.identity?.accountId) === String(linked[0].identity.accountId) && item?.baseUrl === linked[0].baseUrl && item?.monitorEnabled === linked[0].monitorEnabled);
    const existing = upstreams.find((item) => candidates[0] && candidates.every((id) => id === candidates[0]) && item.id === candidates[0]) || (sameAccount ? linked[0] : undefined);
    setStationId(existing?.id); setCreating(!existing); setMonitor(existing?.monitorEnabled !== false);
    form.resetFields(); form.setFieldsValue({ name: entries[0]?.name || "上游账号", baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
    authorizationForm.resetFields(); authorizationForm.setFieldsValue({ name: `${entries[0]?.name || "上游"}账单授权`, baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
  };
  useEffect(() => {
    if (destination?.action === "source" && catalogue && !refreshing && !destinationResolved.current) {
      destinationResolved.current = true;
      if (destination.error || !destination.ownStationId || destination.ownStationId !== catalogue.ownStation?.id) setWorkflowError(destination.error || "本站配置已变化，请刷新后从当前来源事项重新打开。");
      return;
    }
    if (!destination || !["connect", "coverage"].includes(destination.action) || destinationResolved.current || !catalogue || refreshing || stale) return;
    destinationResolved.current = true;
    const rule = destination.action === "coverage" ? (catalogue.rules || []).find((rule: any) => rule.id === destination.ruleId && rule.enabled && !rule.archivedAt) : null;
    const ownId = rule?.ownStationId || destination.ownStationId;
    const ids: number[] = rule ? [...new Set<number>([...(rule.channels || []).map((channel: any) => Number(channel.channelId)), ...(rule.coverageDeclaration?.otherUse === "own_channels" ? rule.coverageDeclaration.uncoveredOwnChannelIds || [] : [])])] : destination.channelIds;
    if (destination.error || !ownId || ownId !== catalogue.ownStation?.id || destination.action === "coverage" && !rule || !ids.length || ids.some((id) => !channels.find((channel) => channel.id === id && channel.revision && !channel.missing))) {
      setWorkflowError(destination.error || "目标来源、规则或渠道已变化，请刷新目录后从当前事项重新打开。"); return;
    }
    if (rule && (!upstreams.some((station) => station.id === rule.upstreamStationId) || !Number.isSafeInteger(rule.tokenId) || rule.tokenId < 1)) { setWorkflowError("原账单授权或 Key 已不可用，请核对原规则与当前授权后重新打开。"); return; }
    if (rule?.ownSource && source && rule.ownSource.namespaceKey !== source.namespaceKey) { setWorkflowError("原规则的本站来源与当前核验来源不同，请先核对本站来源；原历史账单不会改归新来源。"); return; }
    open(ids);
    if (rule) {
      setCoverageRule(rule); setCreating(false); setStationId(rule.upstreamStationId); setMonitor(upstreams.find((station) => station.id === rule.upstreamStationId)?.monitorEnabled !== false); setBilling(true); setTokenId(rule.tokenId); setKeyTimezones({ [rule.tokenId]: rule.timezone || "Asia/Shanghai" });
    }
  // 只用本次最新目录定位一次；取消或提交后不重复打开。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, catalogue, refreshing, stale]);
  const useSaved = (next: BatchResult, intent = next.retryInput) => {
    setResult(next); remember(intent); setApproved(false);
    const savedId = next.groups.flatMap((group) => group.saved.stationIds)[0];
    const authId = next.groups.find((group) => group.saved.authorizationStationId)?.saved.authorizationStationId;
    if (savedId || authId && intent.selections[0]?.monitor === false) { setStationId(savedId || authId!); if (!intent.selections[0]?.credentialUpdateRequested) setCreating(false); }
    if (authId && intent.selections[0]?.type === "newapi-key") setAuthorizationId(authId);
  };
  const recover = async (intent: BatchRecoveryIntent, restore = false) => {
    setRecovering(true); setFailure("");
    try {
      const next: BatchResult = await request("/api/channel-onboarding/batch/recover", intent);
      if (restore) {
        const selection = intent.selections[0]; setOpenIds(intent.groups.flatMap((group) => group.channels.map((entry) => entry.channelId))); setRequestId(intent.requestId); setStationId(selection.stationId || undefined); setCreating(!selection.stationId || selection.credentialUpdateRequested); setMonitor(selection.monitor); setAdditionalIds(selection.additionalMonitorStationIds); setBilling(intent.groups.some((group) => group.reconciliationRequested)); setAuthorizationId(selection.authorizationStationId || "self"); setUpdateCredentials(false);
        form.resetFields(); form.setFieldsValue({ type: selection.type, baseUrl: selection.baseUrl, name: "上游账号" });
        const byChannel: Record<number, number> = {}, declarations: Record<string, CoverageDeclaration> = {};
        const timezones: Record<string, string> = {};
        for (const group of intent.groups) if (group.reconciliation) { group.channels.forEach((entry) => { byChannel[entry.channelId] = group.reconciliation!.tokenId; }); declarations[group.reconciliation.tokenId] = group.reconciliation.coverageDeclaration; timezones[group.reconciliation.tokenId] = group.reconciliation.timezone; }
        setKeyTimezones(timezones);
        const ids = [...new Set(Object.values(byChannel))]; setSplitKeys(ids.length > 1); setTokenId(ids[0]); setChannelKeys(byChannel); setCoverage(declarations); setProbe(null);
      }
      useSaved(next, intent);
      if (next.complete) message.success("已核对，全部请求步骤已保存");
    } catch (err: any) { setFailure(err.message || "恢复失败，请重试"); }
    finally { setRecovering(false); }
  };
  const buildInput = async (): Promise<BatchInput> => {
    const selection: BatchInput["selections"][number] = { selectionId: "primary", monitor, additionalMonitorStationIds: additionalIds, updateCredentials };
    if (creating) selection.newStation = connection(await form.validateFields()); else selection.stationId = stationId;
    if (billing && authorizationId !== "self") selection.reconciliationAuthorization = authorizationId === "new" ? { newAuthorization: connection(await authorizationForm.validateFields()) } : { stationId: authorizationId };
    return { requestId, ownStationId: catalogue.ownStation.id, selections: [selection], groups: [...groups].map(([key, ids]) => ({ groupId: `key-${key}`, selectionId: "primary", channels: ids.map((id) => ({ channelId: id, channelRevision: channels.find((entry) => entry.id === id)?.revision || retryInput?.groups.flatMap((group) => group.channels).find((entry) => entry.channelId === id)?.channelRevision || "" })), reconciliation: billing ? { ...(key !== "pending" ? { tokenId: Number(key) } : {}), ...(keyTimezones[key] ? { timezone: keyTimezones[key] } : {}), coverageDeclaration: coverage[key] || unknownCoverage() } : null })), ...(approved && probe ? { previewId: probe.previewId } : {}) };
  };
  const verify = async () => {
    setFailure("");
    try {
      const input = await buildInput(), current = ++generation.current; setProbing(true);
      const next: BatchProbe = await request("/api/channel-onboarding/batch/probe", input);
      if (current !== generation.current) return;
      setProbe(next); remember(next.retryInput); setApproved(next.selections.every((selection) => selection.monitor.status === "verified") && (!next.selections.some((selection) => selection.credentialUpdateRequired) || updateCredentials));
    } catch (err: any) { if (!err.errorFields) setFailure(err.message || "验证失败，请重试"); setApproved(false); }
    finally { setProbing(false); }
  };
  const save = async () => {
    setSaving(true); setFailure("");
    try {
      const next: BatchResult = await request("/api/channel-onboarding/batch", await buildInput());
      if (next.complete === true && next.groups.every((group) => group.complete && group.channels.every((entry) => entry.complete))) {
        setOpenIds([]); setSelectedIds([]); remember(null); message.success(billing ? "监控关联与对账配置已保存，账单按完整窗口获取" : "监控关联已保存"); await load(false); await onComplete().catch(() => message.warning("配置已保存，页面刷新失败，请刷新页面"));
      } else { useSaved(next); await load(false); await onComplete().catch(() => {}); }
    } catch (err: any) {
      setApproved(false); setFailure(err.message || "保存结果未取得，请核对已保存结果后重新预览");
      if (retryInput) { try { const recovered: BatchResult = await request("/api/channel-onboarding/batch/recover", retryInput); useSaved(recovered); if (recovered.complete) setFailure(""); } catch { /* 保留原意图，允许显式恢复。 */ } }
    } finally { setSaving(false); }
  };
  const changeForm = (changed: any, target: any) => {
    if (changed.type) {
      const allowed = CREDENTIALS[changed.type] || []; target.setFieldsValue(Object.fromEntries(["accessToken", "userId", "apiKey", "email", "password"].filter((key) => !allowed.includes(key)).map((key) => [key, ""])));
      if (target === form) { setMonitor(true); if (billing) setAuthorizationId(changed.type === "newapi-key" ? "new" : "self"); }
    }
    if (Object.keys(changed).some((key) => key !== "name")) invalidate(true);
  };
  const stopForNewKey = (rule: any) => modal.confirm({
    title: "停止旧 Key 核算后重新关联？", okText: "停止旧规则并选择新 Key", cancelText: "取消", okButtonProps: { danger: true },
    content: `请先在上游将站外或脚本调用与本站销售隔离到不同 Key。将停止规则 ${rule.id}，涉及渠道 ${names((rule.channels || []).map((channel: any) => channel.channelId))}；原账、旧范围与监控资源保留。新 Key 仍需实际验证、预览和确认。`,
    onOk: async () => {
      await api(`/api/reconciliation/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      const ids = [...openIds], resourceId = stationId, monitorEnabled = monitor;
      await load(false); open(ids); setStationId(resourceId); setCreating(false); setMonitor(monitorEnabled); setBilling(true);
      await onComplete().catch(() => {});
    },
  });
  const canSave = approved && !stale && !coverageSourceChanged && !busy && !!(creating || stationId) && !!probe && Date.now() < probe.expiresAtMs && !(billing && groups.has("pending") && keys.length > 0);
  return <>
    {workflowError ? <Alert type="warning" showIcon message={workflowError} action={<Space wrap><Button onClick={() => window.location.reload()}>刷新处理目标</Button><Button href="/stations">返回当前资源</Button></Space>} style={{ marginBottom: 16 }} /> : null}
    {destination?.action === "source" && !workflowError ? <section aria-label="核对本站来源" style={{ marginBottom: 16, overflowWrap: "anywhere" }}><Alert type={stale ? "warning" : "info"} showIcon message={stale ? "目录已过期，以下为最后核验来源" : "当前已核验本站来源"} description={<div>{source ? <><div>{source.provider} · {source.baseUrl} · 实际账号 {source.accountId}</div><div>本站资源：{source.stationId} · namespace：{source.namespaceKey}</div></> : <div>尚无核验来源，请读取最新本站渠道。</div>}<div>配置版本：{catalogue?.sourceVersion || "未知"} · 目录核验时间：{catalogue?.syncedAt ? new Date(catalogue.syncedAt).toISOString() : "尚未核验"}</div><div>此目录的已知渠道：{names(channels.map((channel) => channel.id))}</div><Text type="secondary">过期目录不能证明当前远端账号。同步仅更新渠道目录；实际关联仍需按当前来源验证、预览和确认。</Text></div>} action={<Button loading={refreshing} disabled={busy} onClick={() => void load(true)}>读取最新本站渠道</Button>} /></section> : null}
    <Collapse style={{ marginBottom: 16 }} defaultActiveKey={["connections"]} items={[{ key: "connections", label: `渠道接入 · ${channels.length}`, extra: <Button aria-label="发现新渠道" style={{ minHeight: 40 }} size="small" loading={refreshing} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void load(true); }}>发现新渠道</Button>, children: <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Text type="secondary">本站 New API 的渠道和分组自动带入，后台每 5 分钟发现。选择同账号渠道，按实际 Key 集中预览并确认。</Text>
      {stale && catalogue ? <Alert type="warning" showIcon message="渠道目录读取失败，正在显示上次发现的渠道" description={directoryError || catalogue.error || "目录待刷新，暂不能新增关联。"} /> : directoryError ? <Alert type="error" showIcon message="渠道目录暂不可用" description={directoryError} /> : null}
      {catalogue?.syncedAt ? <Text type="secondary">上次成功发现：{new Date(catalogue.syncedAt).toLocaleString("zh-CN")}{stale ? "（已过期）" : ""}</Text> : null}
      <div className="page-toolbar" style={{ width: "100%" }}><Input aria-label="搜索接入渠道" placeholder="搜索渠道、地址或本站分组" allowClear value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: "1 1 200px", minWidth: 0 }} /><Select aria-label="渠道接入状态" value={status} onChange={setStatus} style={{ minWidth: 130 }} options={[{ value: "all", label: "全部渠道" }, { value: "attention", label: "需处理" }, { value: "unlinked", label: "未关联监控" }, { value: "configured", label: "已配置对账" }]} /><Button disabled={busy || refreshing || stale || !selectedIds.length} style={{ minHeight: 44 }} onClick={() => open(selectedIds)} aria-label="批量接入所选渠道">接入所选 {selectedIds.length} 个渠道</Button>{pendingRecovery ? <Button style={{ minHeight: 44 }} loading={recovering} disabled={!catalogue || busy} onClick={() => void recover(pendingRecovery, true)}>恢复上次接入</Button> : null}</div>
      {filtered.length ? <Checkbox checked={filtered.every((entry) => selectedIds.includes(entry.id))} indeterminate={filtered.some((entry) => selectedIds.includes(entry.id)) && !filtered.every((entry) => selectedIds.includes(entry.id))} disabled={stale || busy} onChange={(event) => setSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...filtered.map((entry) => entry.id)])].slice(0, 100) : selectedIds.filter((id) => !filtered.some((entry) => entry.id === id)))}>选择当前筛选渠道（最多 100 个）</Checkbox> : null}
      <List loading={refreshing && !catalogue} dataSource={filtered} locale={{ emptyText: stale ? "渠道目录暂不可用，请重试发现" : channels.length ? "没有匹配的渠道" : catalogue?.ownStation ? "暂无渠道，请在本站 New API 添加后发现" : "请先配置我的中转站，以读取渠道目录" }} pagination={filtered.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false} renderItem={(entry: any) => <List.Item style={{ display: "flex", flexWrap: "wrap", gap: 12 }}><Checkbox aria-label={`选择渠道 ${entry.name || entry.id}`} disabled={stale || busy} checked={selectedIds.includes(entry.id)} onChange={(event) => setSelectedIds(event.target.checked ? [...selectedIds, entry.id].slice(0, 100) : selectedIds.filter((id) => id !== entry.id))} /><div style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}><Space wrap><Text strong>{entry.name || `渠道 #${entry.id}`}</Text><Tag>{Number(entry.status) === 1 ? "启用" : Number(entry.status) === 2 ? "手动停用" : Number(entry.status) === 3 ? "自动停用" : "状态未知"}</Tag></Space><div><Text type="secondary">本站分组：{entry.groups?.join("、") || "未提供"}</Text></div><div><Text type="secondary">{entry.baseUrl || "渠道未提供上游地址，接入时补充"}</Text></div><Space wrap><Text>监控：{STATES[entry.monitor?.status] || "未关联"}</Text><Text>对账：{STATES[entry.reconciliation?.status] || "未配置"}</Text></Space></div><Button style={{ minHeight: 44 }} disabled={refreshing || stale || busy} onClick={() => open([entry.id])} aria-label={`接入渠道 ${entry.name || entry.id}`}>{entry.monitor?.status === "linked" ? "管理关联" : "接入监控与对账"}</Button></List.Item>} />
    </Space> }]} />
    <Drawer title="接入监控与对账" aria-label="接入监控与对账" open={openIds.length > 0} width={compact ? "100%" : 600} closable={!busy} maskClosable={!busy} keyboard={!busy} onClose={() => { generation.current += 1; setOpenIds([]); }} extra={<Button aria-label={result ? "重试未完成步骤" : "确认关联"} style={{ minHeight: 44 }} type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>{result ? "重试未完成步骤" : "确认关联"}</Button>}>
      <Space direction="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
        <Alert type="info" showIcon message={`本次选择 ${openIds.length} 个渠道`} description={<Space direction="vertical"><Text>{names(openIds)}</Text><Text>本站名称、地址、分组与启停状态已带入，无需再次填写。</Text>{openIds.map((id) => <Text key={id}>{names([id])} · 本站分组 {channels.find((entry) => entry.id === id)?.groups?.join("、") || "未提供"}</Text>)}</Space>} />
        {stale ? <Alert type="warning" showIcon message="目录已过期，请重新发现后验证" /> : null}{failure ? <Alert type="error" showIcon message={failure} /> : null}
        {result ? <Alert type={result.complete ? "success" : "warning"} showIcon message={result.complete ? "全部请求步骤已保存" : "接入尚有待完成步骤，已保存部分会继续复用"} description={<Space direction="vertical">{result.groups.map((group) => <div key={group.groupId}><Text strong>{names(group.channels.map((entry) => entry.channelId))} · {group.complete ? "已完成" : "待完成"}</Text><div>监控：{STATES[group.monitor.status]}；对账：{STATES[group.reconciliation.status]}</div><div>{group.reason || group.reconciliation.reason}</div><div>已保存资源：{group.saved.stationIds.join("、") || "无"}{group.saved.authorizationStationId ? `；账单授权：${group.saved.authorizationStationId}` : ""}{group.saved.ruleId ? `；规则：${group.saved.ruleId}` : ""}</div>{group.channels.filter((entry) => !entry.complete).map((entry) => <div key={entry.channelId}>{names([entry.channelId])}：{entry.reason || "请重新预览并补齐剩余步骤"}</div>)}{group.remainingActions.length ? <Text type="secondary">下一步：{group.remainingActions.includes("supply_credentials") ? "补充尚未保存的授权，然后重新预览" : group.remainingActions.includes("select_key") ? "选择实际 Key 后重新预览" : "重新预览后重试未完成步骤"}</Text> : null}</div>)}{retryInput ? <Button disabled={busy} onClick={() => void recover(retryInput)}>核对已保存结果</Button> : null}</Space>} /> : null}
        {coverageRule ? <Alert type="info" showIcon message="核对既有 Key 的完整用途" description={<div>原规则 {coverageRule.id} · 上游 Key {coverageRule.tokenId} · 原成员 {names((coverageRule.channels || []).map((channel: any) => channel.channelId))}。本次范围已包含已知漏接渠道，请核对完整用途后重新预览。<Space wrap><Button href={`/reconciliation?action=scope&ruleId=${encodeURIComponent(coverageRule.id)}`}>查看原范围与历史</Button><Button disabled={busy} onClick={() => stopForNewKey(coverageRule)}>隔离站外调用后关联新 Key</Button></Space></div>} /> : null}
        <Checkbox checked={creating} disabled={busy || !!coverageRule} onChange={(event) => { setCreating(event.target.checked); invalidate(true); }}>填写或更新上游授权</Checkbox>
        {creating ? <Form form={form} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, form)}><Form.Item name="type" label="监控方式"><Select options={TYPES} /></Form.Item><Form.Item name="name" label="上游资源名称" rules={[{ required: true, message: "请输入资源名称" }]}><Input /></Form.Item><Form.Item name="baseUrl" label="上游站点地址" rules={[{ required: true, message: "请输入站点地址" }]}><Input placeholder="https://upstream.example.com" /></Form.Item><CredentialFields type={formType} /></Form> : <div><Text strong>上游账号或 Key 资源</Text><Select aria-label="接入上游资源" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={stationId} disabled={busy || !!coverageRule} placeholder="复用已有账号或 Key，无需重填凭证" options={upstreams.map((item) => ({ value: item.id, label: stationLabel(item) }))} onChange={(id) => { setStationId(id); setAuthorizationId("self"); setMonitor(upstreams.find((item) => item.id === id)?.monitorEnabled !== false); invalidate(true); }} /></div>}
        <Checkbox checked={monitor} disabled={busy || !creating && main?.monitorEnabled === false || (creating ? formType : main?.type) === "newapi-key"} onChange={(event) => { setMonitor(event.target.checked); invalidate(); }}>关联余额监控</Checkbox>{!monitor ? <Text type="secondary">仅使用账号账单授权；已有资源的监控用途保持原设置。</Text> : null}
        <Collapse size="small" items={[{ key: "extra", label: "同时关联其他已有监控资源（可选）", children: <Select aria-label="其他监控资源" mode="multiple" style={{ width: "100%" }} value={additionalIds} disabled={busy} options={upstreams.filter((item) => item.monitorEnabled !== false && item.id !== stationId).map((item) => ({ value: item.id, label: item.name }))} onChange={(ids) => { setAdditionalIds(ids); invalidate(); }} /> }]} />
        {additionalIds.length ? <Alert type="warning" showIcon message="核对整体监控成本" description="账号余额与 Key 额度可能覆盖同一消费。将沿用各资源的整体成本纳入设置，请核对是否重复计入；Key 对账的成本只算一次，整体监控成本设置需要另行核对。" /> : null}
        <Checkbox checked={billing} disabled={busy} onChange={(event) => { setBilling(event.target.checked); if (requiresAuthorization) setAuthorizationId(upstreams.find((item) => item.type !== "newapi-key")?.id || "new"); invalidate(true); }}>同时配置 Key 对账</Checkbox>
        {billing ? <>
          {requiresAuthorization ? <div><Text strong>账号账单授权</Text><Select aria-label="接入账单授权" style={{ width: "100%", marginTop: 8 }} value={authorizationId} disabled={busy} options={[...upstreams.filter((item) => item.type !== "newapi-key").map((item) => ({ value: item.id, label: stationLabel(item) })), { value: "new", label: "补充账号账单授权" }]} onChange={(id) => { setAuthorizationId(id); invalidate(true); }} /></div> : <Text type="secondary">复用所选账号授权读取账单与 Key；首次权限不足时可在原处补充或更新授权。</Text>}
          {authorizationId === "new" ? <><Alert type="info" showIcon message="账单授权只补一次" description="专用授权用于查账，不增加余额监控、告警或整体成本。" /><Form form={authorizationForm} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, authorizationForm)}><Form.Item name="type" label="账单授权方式"><Select options={TYPES.filter((type) => type.value !== "newapi-key")} /></Form.Item><Form.Item name="name" label="账单授权名称" rules={[{ required: true, message: "请输入授权名称" }]}><Input /></Form.Item><Form.Item name="baseUrl" label="账单站点地址" rules={[{ required: true, message: "请输入站点地址" }]}><Input /></Form.Item><CredentialFields type={authorizationType} /></Form></> : null}
          <div><Text strong>这些渠道实际使用的上游 Key</Text><Select aria-label="接入上游 Key" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={tokenId} disabled={busy || !keys.length || splitKeys || !!coverageRule} placeholder="验证后选择实际 Key，同 Key 只选一次" options={keyOptions} onChange={(id) => { setTokenId(id); invalidate(); }} /></div>
          {openIds.length > 1 ? <Checkbox checked={splitKeys} disabled={busy || !!coverageRule} onChange={(event) => { setSplitKeys(event.target.checked); setChannelKeys(Object.fromEntries(openIds.map((id) => [id, tokenId]))); invalidate(); }}>这些渠道使用不同 Key，分别指定</Checkbox> : null}
          {splitKeys ? openIds.map((id) => <div key={id}><Text>{names([id])}</Text><Select aria-label={`渠道 ${id} 的上游 Key`} style={{ width: "100%", marginTop: 4 }} value={channelKeys[id]} disabled={busy || !keys.length} options={keyOptions} placeholder="明确选择实际 Key" onChange={(value) => { setChannelKeys((previous) => ({ ...previous, [id]: value })); invalidate(); }} /></div>) : null}
          {[...groups].map(([key]) => {
            const verified = probe?.groups.find((group) => group.basis.tokenId === Number(key));
            if (!verified) return <Text key={key} type="secondary">{key === "pending" ? "验证后选择实际 Key。" : "已选择 Key，请验证并预览原成员与本次成员的完整范围。"}</Text>;
            const union = verified.basis.proposedChannelIds;
            const declaration = coverage[key] || unknownCoverage();
            return <div key={key}><Text strong>{keys.find((item) => item.id === Number(key))?.name || "待选择 Key"} · 完整关联范围</Text><div><Text>以上渠道：{names(union)}</Text></div><Text>除以上渠道外，这把 Key 是否还用于本站其他渠道或站外调用？</Text><Select aria-label={groups.size === 1 ? "Key 消费范围" : `Key ${key} 消费范围`} style={{ width: "100%", marginTop: 8 }} value={declaration.answer} disabled={busy} options={[{ value: "none", label: "没有" }, { value: "other_use", label: "有" }, { value: "unknown", label: "不确定" }]} onChange={(answer) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, answer, otherUse: answer === "other_use" ? "unspecified" : null } })); invalidate(); }} />{declaration.answer === "other_use" ? <><Select aria-label={`Key ${key} 的其他用途`} style={{ width: "100%", marginTop: 8 }} value={declaration.otherUse || "unspecified"} disabled={busy} options={[{ value: "own_channels", label: "本站其他渠道" }, { value: "external", label: "站外调用" }, { value: "unspecified", label: "尚未明确" }]} onChange={(otherUse) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, otherUse } })); invalidate(); }} />{declaration.otherUse === "own_channels" ? <Select aria-label={`Key ${key} 的漏接渠道`} mode="multiple" style={{ width: "100%", marginTop: 8 }} value={declaration.uncoveredOwnChannelIds} disabled={busy} options={channels.filter((entry) => !union.includes(entry.id)).map((entry) => ({ value: entry.id, label: entry.name || `#${entry.id}` }))} onChange={(ids) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, uncoveredOwnChannelIds: ids } })); invalidate(); }} /> : null}</> : null}{declaration.answer !== "none" ? <Text type="secondary">保留成本与收入参考，账面毛利待确认。{declaration.otherUse === "external" ? "请隔离调用 Key 后重新关联。" : "补齐这把 Key 的完整用途后重新预览。"}</Text> : null}</div>;
          })}
        </> : <Text type="secondary">仅关联资源监控，无需选择 Key 或补账号账单权限。</Text>}
        <Button aria-label="验证并预览" style={{ minHeight: 44 }} loading={probing} disabled={saving || recovering || stale || coverageSourceChanged || (!creating && !stationId)} onClick={() => void verify()}>验证并预览</Button>
        {probe ? <><Alert type={probe.selections.every((selection) => selection.monitor.status === "verified") ? "success" : "warning"} showIcon message={probe.selections.every((selection) => selection.monitor.status === "verified") ? "监控连接已验证，尚未保存" : "监控连接待完成"} description={probe.selections.map((selection) => selection.monitor.reason).filter(Boolean).join("；") || "确认关联后才保存；取消不会创建资源或触发告警。"} />{probe.selections.some((selection) => selection.credentialUpdateRequired) ? <Checkbox checked={updateCredentials} disabled={busy} onChange={(event) => { setUpdateCredentials(event.target.checked); invalidate(); }}>已发现相同账号，确认用本次授权更新已有凭证</Checkbox> : null}{probe.groups.map((group) => <Alert key={group.groupId} type="info" showIcon message={group.basis.existingRuleId ? "加入已有对账规则" : STATES[group.status] || "接入预览"} description={<Space direction="vertical"><Text>{group.reason}</Text><Text>实际本站来源：{group.basis.ownSource.provider} · {group.basis.ownSource.baseUrl} · 账号 {group.basis.ownSource.accountId} · {group.basis.ownSource.namespaceKey}</Text><Text>实际账单账号：{group.basis.accountIdentity ? `${group.basis.accountIdentity.provider} · ${group.basis.accountIdentity.baseUrl} · 账号 ${group.basis.accountIdentity.accountId}` : "待核验"}</Text><Text>已有渠道：{names(group.basis.existingChannelIds)}；本次加入：{names(group.requestedChannelIds)}</Text><Text>完整范围：{names(group.basis.proposedChannelIds)}</Text>{billing ? <><Text>完整日生效：{time(group.preview.billingEffectiveFromMs, group.basis.timezone)}（{group.basis.timezone}）。该日结束且两侧账单完整后确认利润。</Text><Text>首个完整账单可查询：{time(group.preview.firstQueryableAtMs, group.basis.timezone)}</Text><Text>同一 Key 成本只算一次；消费范围待确认时不确认精确利润。</Text></> : null}</Space>} />)}{!approved ? <Text type="warning">选择或连接信息已变化，请重新验证并预览。</Text> : null}</> : null}
      </Space>
    </Drawer>
  </>;
}
