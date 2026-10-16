"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Input, List, Radio, Select, Space, Tag, Typography } from "antd";
import { api } from "../../lib/client";
import { createRequestId } from "../../lib/request-id.js";
import { groupOnboardingResources } from "../../lib/channel-onboarding.js";
import { onboardingMonitorIds, onboardingKeyContext, retainOnboardingRequest } from "../../lib/onboarding-workflow.js";
import type { AccountReadModel, UpstreamKeyRead, BatchInput, BatchProbe, BatchRecoveryIntent, BatchResult, ConnectionInput, CoverageDeclaration, WorkflowDestination, SourceCatalogueProjection } from "../../lib/client";
import { useAccountAuthorization } from "./account-authorization";
import { useDrawerEscape } from "./drawer-escape";

const { Text } = Typography;
const TYPES = [{ value: "newapi", label: "New API · 账号余额" }, { value: "newapi-key", label: "New API · Key 额度" }, { value: "sub2api", label: "Sub2API · 登录令牌" }, { value: "sub2api-password", label: "Sub2API · 账号密码" }];
const CREDENTIALS: Record<string, string[]> = { newapi: ["accessToken", "userId"], "newapi-key": ["apiKey"], sub2api: ["accessToken"], "sub2api-password": ["email", "password"] };
const STATES: Record<string, string> = { unlinked: "未关联", linked: "已关联", unconfigured: "未配置", configured: "已配置", review_required: "待重新确认", unverified: "账单能力待验证", unsupported: "账单能力不支持", unavailable: "暂不可用", pending: "待完成", not_requested: "保持现有", ready: "可配置对账", monitor_only: "仅监控" };
const RECOVERY_KEY = "channel-onboarding-recovery-v05";
const PENDING_KEY = "channel-onboarding-pending-v06";
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
  const [monitorMode, setMonitorMode] = useState<"keep" | "add" | "replace" | "remove">("add");
  const [removals, setRemovals] = useState<Record<number, string[]>>({});
  const [additionalIds, setAdditionalIds] = useState<string[]>([]);
  const [billing, setBilling] = useState(false);
  const [authorizationId, setAuthorizationId] = useState("self");
  const [tokenId, setTokenId] = useState<number>();
  const [splitKeys, setSplitKeys] = useState(false);
  const [channelKeys, setChannelKeys] = useState<Record<number, number | undefined>>({});
  const [coverage, setCoverage] = useState<Record<string, CoverageDeclaration>>({});
  const [probe, setProbe] = useState<BatchProbe | null>(null);
  const [approved, setApproved] = useState(false);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [retryInput, setRetryInput] = useState<BatchRecoveryIntent | null>(null);
  const [pendingRequests, setPendingRequests] = useState<BatchRecoveryIntent[]>([]);
  const [accountModel, setAccountModel] = useState<AccountReadModel | null>(null);
  const [accountsError, setAccountsError] = useState("");
  const [keyRead, setKeyRead] = useState<UpstreamKeyRead | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [keyReadVersion, setKeyReadVersion] = useState(0);
  const [openingAuthorization, setOpeningAuthorization] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [form] = Form.useForm();
  const [authorizationForm] = Form.useForm();
  const formType = Form.useWatch("type", form) || "newapi";
  const authorizationType = Form.useWatch("type", authorizationForm) || "newapi";
  const generation = useRef(0);
  const keyGeneration = useRef(0);
  const accountGeneration = useRef(0);
  const authorizationOrigin = useRef<{ id: string; creating: boolean } | null>(null);
  const discoveryInFlight = useRef(false);
  const stale = !catalogue || catalogue.stale || !!directoryError;
  const upstreams: any[] = catalogue?.upstreams || [];
  const main = upstreams.find((item) => item.id === stationId);
  const requiresAuthorization = (creating ? formType : main?.type) === "newapi-key";
  const channels: any[] = catalogue?.channels || [];
  const selectedChannels = channels.filter((channel) => openIds.includes(channel.id));
  const hasMonitorLinks = selectedChannels.some((channel) => onboardingMonitorIds(channel).length);
  const hasSavedBilling = selectedChannels.some((channel) => channel.reconciliation?.ruleIds?.length);
  const currentResourceIds = [...new Set<string>(selectedChannels.flatMap((channel) => [...onboardingMonitorIds(channel), ...(channel.reconciliation?.ruleIds || []).flatMap((id: string) => { const rule = catalogue.rules.find((entry: any) => entry.id === id); return rule ? [rule.upstreamStationId] : []; })]))];
  const billingResourceId = requiresAuthorization ? authorizationId && authorizationId !== "new" && authorizationId !== "self" ? authorizationId : undefined : !creating ? stationId : undefined;
  const resourceGroups = useMemo(() => {
    const selected = new Set(openIds);
    return groupOnboardingResources(upstreams, channels.filter((channel) => selected.has(channel.id)));
  }, [upstreams, channels, openIds]);
  const resourceOption = (station: any) => ({ value: station.id, label: stationLabel(station), baseUrl: station.baseUrl,
    searchText: `${stationLabel(station)} ${station.baseUrl}` });
  const resourceOptions = [
    { label: `已有渠道关联或地址匹配（${resourceGroups.matched.length}）`, options: resourceGroups.matched.map(resourceOption) },
    { label: `其他已保存资源（${resourceGroups.others.length}）`, options: resourceGroups.others.map(resourceOption) },
  ].filter((group) => group.options.length);
  const billingCandidates = groupOnboardingResources(upstreams.filter((item) => item.type !== "newapi-key"), [{ baseUrl: creating ? form.getFieldValue("baseUrl") : main?.baseUrl }]);
  const source: SourceCatalogueProjection["ownSource"] = catalogue?.ownSource || null;
  const coverageSourceChanged = !!(coverageRule?.ownSource && source && coverageRule.ownSource.namespaceKey !== source.namespaceKey);
  const names = (ids: number[]) => ids.map((id) => channels.find((entry) => entry.id === id)?.name || `#${id}`).join("、") || "无";
  const resourceNames = (ids: string[]) => ids.map((id) => upstreams.find((resource) => resource.id === id)?.name || `已移除资源 ${id}`).join("、") || "无";
  const keys = keyRead?.tokens || probe?.selections.flatMap((selection) => selection.tokens) || [];
  const keyOptions = [...new Map(keys.map((key) => [key.id, key])).values()].map((key) => ({ value: key.id, disabled: key.status !== 1 || key.crossGroupRetry || key.group === "auto", label: `${key.name} · Key #${key.id} · 上游分组 ${key.group || "未提供"}${key.status !== 1 ? " · 已停用" : key.crossGroupRetry || key.group === "auto" ? " · 不支持跨组核算" : ""}` }));
  const groups = new Map<string, number[]>();
  for (const id of openIds) { const key = billing ? String((splitKeys ? channelKeys[id] : tokenId) || "pending") : "monitor"; groups.set(key, [...(groups.get(key) || []), id]); }
  const filtered = channels.filter((entry) => (status === "all" || status === "attention" && (entry.monitor?.status !== "linked" || entry.reconciliation?.status !== "configured") || status === "unlinked" && entry.monitor?.status !== "linked" || status === "configured" && entry.reconciliation?.status === "configured") && `${entry.name} ${entry.id} ${entry.baseUrl} ${(entry.groups || []).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const invalidate = (credentials = false) => {
    generation.current += 1; setApproved(false); setFailure("");
    if (credentials) { keyGeneration.current += 1; setKeyRead(null); setKeyError(""); setKeyLoading(false); setProbe(null); setTokenId(coverageRule?.tokenId); setChannelKeys({}); setCoverage(coverageRule ? { [coverageRule.tokenId]: coverageRule.coverageDeclaration || unknownCoverage() } : {}); setKeyTimezones(coverageRule ? { [coverageRule.tokenId]: coverageRule.timezone } : {}); }
  };
  const persistPending = (next: BatchRecoveryIntent[]) => {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(next)); sessionStorage.removeItem(RECOVERY_KEY); } catch { /* 当前页面仍可继续。 */ }
    return next;
  };
  const remember = (intent: BatchRecoveryIntent | null, pending = false) => {
    setRetryInput(intent);
    if (pending && intent) setPendingRequests((previous) => persistPending(retainOnboardingRequest(previous, intent)));
  };
  const forget = (id: string) => setPendingRequests((previous) => persistPending(previous.filter((entry) => entry.requestId !== id)));
  const loadAccounts = async () => {
    const current = ++accountGeneration.current;
    try { const next: AccountReadModel = await request("/api/channel-onboarding/accounts"); if (current !== accountGeneration.current) return null; setAccountModel(next); setAccountsError(""); return next; }
    catch (err: any) { if (current === accountGeneration.current) setAccountsError(err.message || "账号信息读取失败"); return null; }
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
  const authorization = useAccountAuthorization({ compact, accountModel, stations: [...upstreams, ...(catalogue?.ownStation ? [{ ...catalogue.ownStation, isOwn: true }] : [])],
    disabled: openingAuthorization, onRecoveryError: setFailure,
    onComplete: async (next) => {
      generation.current += 1; keyGeneration.current += 1; setApproved(false); setProbe(null); setKeyRead(null);
      const origin = authorizationOrigin.current;
      if (origin && next.targets.some((target) => target.stationId === origin.id && ["updated", "already_updated"].includes(target.status)) && origin.creating) {
        setStationId(origin.id); setCreating(false); form.resetFields();
      }
      setKeyReadVersion((version) => version + 1); await Promise.all([load(false), loadAccounts()]); await onComplete().catch(() => {});
    },
  });
  const busy = probing || saving || recovering || openingAuthorization || authorization.authorizationBusy;
  const updateAuthorization = async (id: string, initialAuthorization?: any) => {
    setOpeningAuthorization(true); setFailure("");
    try {
      const model = await loadAccounts();
      if (!model) return;
      const account = model.accounts.find((entry) => entry.resources.some((resource) => resource.id === id));
      if (!account) { setFailure("此资源的账号身份尚未确认，请先在上游账单核验账号身份。"); return; }
      authorizationOrigin.current = { id, creating };
      authorization.openAuthorization(account, { defaultTargetIds: [id], initialAuthorization });
    } finally { setOpeningAuthorization(false); }
  };
  useEffect(() => {
    if (!openIds.length || !billing || !billingResourceId) return;
    const current = ++keyGeneration.current;
    setKeyRead(null); setKeyLoading(true); setKeyError("");
    void request(`/api/reconciliation/upstreams/${encodeURIComponent(billingResourceId)}/keys?force=true`).then((next: UpstreamKeyRead) => {
      if (current !== keyGeneration.current) return;
      if (next.capability?.reason === "KEY_METADATA_UNAVAILABLE") { setKeyError("Key 目录暂不可读，请检查账号授权后重试。"); return; }
      setKeyRead(next);
    }).catch((err: any) => { if (current === keyGeneration.current) setKeyError(err.message || "Key 目录读取失败"); })
      .finally(() => { if (current === keyGeneration.current) setKeyLoading(false); });
    return () => { keyGeneration.current += 1; };
  }, [openIds.length, billing, billingResourceId, keyReadVersion]);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(PENDING_KEY), legacy = sessionStorage.getItem(RECOVERY_KEY);
      const intents = saved ? JSON.parse(saved) : legacy ? [JSON.parse(legacy)] : [];
      if (Array.isArray(intents)) setPendingRequests(intents.filter((intent) => typeof intent?.requestId === "string" && Array.isArray(intent.groups) && Array.isArray(intent.selections)));
    } catch { /* 不阻断目录。 */ }
    void loadAccounts();
    void (async () => { await load(false); await load(true); })();
    return () => { generation.current += 1; keyGeneration.current += 1; accountGeneration.current += 1; };
  // 目录由后台同步；这里只在进入页面时立即发现。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = (ids: number[]) => {
    let nextRequestId: string;
    try { nextRequestId = createRequestId(); } catch (err: any) { message.error(err.message); return; }
    invalidate(true); setTokenId(undefined); setOpenIds(ids); setResult(null); setRetryInput(null); setRequestId(nextRequestId); setAdditionalIds([]); setBilling(false); setCoverage({}); setCoverageRule(null); setKeyTimezones({}); setSplitKeys(false); setAuthorizationId("self"); setRemovals({});
    const entries = ids.map((id) => channels.find((entry) => entry.id === id)).filter(Boolean);
    const candidates = entries.map((entry) => entry.monitor?.stationIds?.[0] || (entry.candidates?.length === 1 ? entry.candidates[0]?.id || entry.candidates[0] : undefined));
    const linked = candidates.map((id) => upstreams.find((item) => item.id === id));
    const sameAccount = linked[0]?.identity && linked.every((item) => item?.type !== "newapi-key" && item?.identity?.provider === linked[0].identity.provider && String(item?.identity?.accountId) === String(linked[0].identity.accountId) && item?.baseUrl === linked[0].baseUrl && item?.monitorEnabled === linked[0].monitorEnabled);
    const existing = upstreams.find((item) => candidates[0] && candidates.every((id) => id === candidates[0]) && item.id === candidates[0]) || (sameAccount ? linked[0] : undefined);
    const configured = entries.some((entry) => onboardingMonitorIds(entry).length || entry.reconciliation?.ruleIds?.length);
    setStationId(existing?.id); setCreating(!upstreams.length); setMonitorMode(configured ? "keep" : "add"); setMonitor(!configured && existing?.monitorEnabled !== false);
    form.resetFields(); form.setFieldsValue({ name: entries[0]?.name || "上游账号", baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
    authorizationForm.resetFields(); authorizationForm.setFieldsValue({ name: `${entries[0]?.name || "上游"}账单授权`, baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
  };
  const savedKeyContext = (key: number) => onboardingKeyContext(accountModel, billingResourceId,
    keyRead?.identity || probe?.selections[0]?.accountIdentity, key, source, catalogue?.rules);
  const chooseKey = (id: number) => {
    const existing = savedKeyContext(id);
    setTokenId(id);
    if (existing) {
      setCoverage((previous) => ({ ...previous, [id]: previous[id] || existing.coverageDeclaration }));
      setKeyTimezones((previous) => ({ ...previous, [id]: previous[id] || existing.timezone }));
    }
    invalidate();
  };
  const configureBilling = (checked: boolean) => {
    invalidate(true); setBilling(checked);
    if (!checked) return;
    if (requiresAuthorization) setAuthorizationId(upstreams.some((resource) => resource.type !== "newapi-key") ? "" : "new");
    const ruleIds = [...new Set(selectedChannels.flatMap((channel) => channel.reconciliation?.ruleIds || []))];
    const existing = ruleIds.length === 1 ? catalogue.rules.find((rule: any) => rule.id === ruleIds[0] && rule.enabled && !rule.archivedAt && rule.ownSource?.namespaceKey === source?.namespaceKey) : null;
    if (existing && monitorMode === "keep" && upstreams.some((resource) => resource.id === existing.upstreamStationId)) {
      setStationId(existing.upstreamStationId); setCreating(false); setAuthorizationId("self"); setMonitor(false);
      setTokenId(existing.tokenId); setCoverage({ [existing.tokenId]: existing.coverageDeclaration || unknownCoverage() }); setKeyTimezones({ [existing.tokenId]: existing.timezone || "Asia/Shanghai" });
    }
  };
  const enableMonitor = async (id: string) => {
    const model = await loadAccounts();
    const resource = [...(model?.accounts.flatMap((account) => account.resources) || []), ...(model?.unverifiedResources || [])].find((entry) => entry.id === id);
    if (!resource?.resourceVersion) { setFailure("未取得资源当前版本，请刷新账号信息后重试。"); return; }
    modal.confirm({ title: `启用“${resource.name}”监控？`, content: "恢复该资源的余额监控，沿用已有告警与成本设置。", okText: "启用监控", cancelText: "取消", onOk: async () => {
      await api(`/api/stations/${encodeURIComponent(id)}`, { method: "PUT", body: { monitorEnabled: true, expectedAuthVersion: resource.authVersion, expectedResourceVersion: resource.resourceVersion } });
      invalidate(); setMonitor(true); await Promise.all([load(false), loadAccounts()]); await onComplete().catch(() => {});
    } });
  };
  const changeMonitorMode = (mode: typeof monitorMode) => {
    setMonitorMode(mode); setMonitor(mode === "add" || mode === "replace" ? main?.monitorEnabled !== false : false); setAdditionalIds([]);
    setRemovals(mode === "remove" ? Object.fromEntries(selectedChannels.map((channel) => [channel.id, onboardingMonitorIds(channel)])) : {});
    invalidate();
  };
  const changeResourceMode = () => {
    const nextCreating = !creating;
    const nextType = nextCreating ? formType : main?.type;
    setCreating(nextCreating); setAuthorizationId(nextType === "newapi-key" ? upstreams.some((resource) => resource.type !== "newapi-key") ? "" : "new" : "self");
    setMonitor((monitorMode === "add" || monitorMode === "replace") && (nextCreating || main?.monitorEnabled !== false));
    invalidate(true);
  };
  const removedIds = (channel: any): string[] => monitorMode === "replace"
    ? onboardingMonitorIds(channel).filter((id) => !(monitor && !creating && stationId === id || additionalIds.includes(id)))
    : removals[channel.id] || [];
  const removalRequested = selectedChannels.some((channel) => removedIds(channel).length);
  const scopeIds = (key: number, ids: number[]) => {
    const verified = probe?.groups.find((group) => group.basis.tokenId === key);
    const saved = savedKeyContext(key);
    return [...new Set<number>([...(verified?.basis.existingChannelIds || saved?.channels.map((channel: any) => channel.channelId) || []), ...ids])].sort((a, b) => a - b);
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
      setWorkflowError(destination.error || "目标来源、核算关联或渠道已变化，请刷新目录后从当前事项重新打开。"); return;
    }
    if (rule && (!upstreams.some((station) => station.id === rule.upstreamStationId) || !Number.isSafeInteger(rule.tokenId) || rule.tokenId < 1)) { setWorkflowError("原账单授权或 Key 已不可用，请核对原核算关联与当前授权后重新打开。"); return; }
    if (rule?.ownSource && source && rule.ownSource.namespaceKey !== source.namespaceKey) { setWorkflowError("原核算关联的本站来源与当前核验来源不同，请先核对本站来源；原历史账单不会改归新来源。"); return; }
    open(ids);
    if (rule) {
      setCoverageRule(rule); setCreating(false); setStationId(rule.upstreamStationId); setMonitor(false); setMonitorMode("keep"); setBilling(true); setTokenId(rule.tokenId); setKeyTimezones({ [rule.tokenId]: rule.timezone || "Asia/Shanghai" });
    }
  // 只用本次最新目录定位一次；取消或提交后不重复打开。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, catalogue, refreshing, stale]);
  const useSaved = (next: BatchResult, intent = next.retryInput) => {
    setResult(next); remember(intent, !next.complete); if (next.complete) forget(intent.requestId); setApproved(false);
    const primary = intent.selections[0];
    const savedId = primary?.stationId || (primary?.monitor ? next.groups.flatMap((group) => group.saved.stationIds).find((id) => !primary.additionalMonitorStationIds.includes(id)) : undefined);
    const authId = next.groups.find((group) => group.saved.authorizationStationId)?.saved.authorizationStationId;
    const accountId = !primary?.linkOnly && primary?.type !== "newapi-key" && !primary?.monitor ? authId : undefined;
    if (savedId || accountId) { setStationId(savedId || accountId!); if (!primary?.credentialUpdateRequested) setCreating(false); }
    if (primary?.type === "newapi-key") { if (authId) setAuthorizationId(authId); }
    else setAuthorizationId("self");
  };
  const recover = async (intent: BatchRecoveryIntent, restore = false) => {
    setRecovering(true); setFailure("");
    try {
      const next: BatchResult = await request("/api/channel-onboarding/batch/recover", intent);
      if (restore) {
        setCoverageRule(null);
        const selection = intent.selections[0]; setOpenIds(intent.groups.flatMap((group) => group.channels.map((entry) => entry.channelId))); setRequestId(intent.requestId); setStationId(selection.stationId || undefined); setCreating(!selection.linkOnly && (!selection.stationId || selection.credentialUpdateRequested)); setMonitor(selection.monitor); setAdditionalIds(selection.additionalMonitorStationIds); setBilling(intent.groups.some((group) => group.reconciliationRequested)); setAuthorizationId(selection.type === "newapi-key" ? selection.authorizationStationId || (upstreams.some((resource) => resource.type !== "newapi-key") ? "" : "new") : "self");
        const restoredRemovals = Object.fromEntries(intent.groups.flatMap((group) => group.channels.map((channel) => [channel.channelId, channel.removeMonitorStationIds || []])));
        setRemovals(restoredRemovals); setMonitorMode(selection.linkOnly ? "remove" : selection.monitor || selection.additionalMonitorStationIds.length ? "add" : "keep");
        setKeyRead(null); setKeyReadVersion((version) => version + 1);
        form.resetFields(); form.setFieldsValue({ type: selection.type, baseUrl: selection.baseUrl, name: "上游账号" });
        authorizationForm.resetFields(); authorizationForm.setFieldsValue({ type: selection.authorizationIdentity?.provider === "sub2api" ? "sub2api" : "newapi", baseUrl: selection.authorizationIdentity?.baseUrl || selection.baseUrl || "", name: "账号账单授权" });
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
    if (!requestId) throw new Error("请求标识无效，请关闭接入窗口后重新打开");
    if (!purposeSelected) throw new Error("请选择余额监控或 Key 对账");
    if (monitorMode === "replace" && !monitor && !additionalIds.length) throw new Error("请先选择并启用要更换的监控资源；仅解除时请选择解除监控。");
    const selection: BatchInput["selections"][number] = { selectionId: "primary", monitor, additionalMonitorStationIds: additionalIds, updateCredentials: false };
    const linkOnly = !monitor && !additionalIds.length && !billing && removalRequested;
    if (!linkOnly) { if (creating) selection.newStation = connection(await form.validateFields()); else selection.stationId = stationId; }
    if (billing && requiresAuthorization && !authorizationId) throw new Error("请选择这把 Key 所属的账号账单授权");
    if (billing && requiresAuthorization && authorizationId !== "self") selection.reconciliationAuthorization = authorizationId === "new" ? { newAuthorization: connection(await authorizationForm.validateFields()) } : { stationId: authorizationId };
    return { requestId, ownStationId: catalogue.ownStation.id, selections: [selection], groups: [...groups].map(([key, ids]) => ({
      groupId: `key-${key}`, selectionId: "primary", channels: ids.map((id) => {
        const channel = channels.find((entry) => entry.id === id);
        const removeMonitorStationIds = channel ? removedIds(channel) : retryInput?.groups.flatMap((group) => group.channels).find((entry) => entry.channelId === id)?.removeMonitorStationIds || [];
        return { channelId: id, channelRevision: channel?.revision || retryInput?.groups.flatMap((group) => group.channels).find((entry) => entry.channelId === id)?.channelRevision || "", ...(removeMonitorStationIds.length ? { removeMonitorStationIds } : {}) };
      }), reconciliation: billing ? { ...(key !== "pending" ? { tokenId: Number(key) } : {}), ...(keyTimezones[key] ? { timezone: keyTimezones[key] } : {}), coverageDeclaration: coverage[key] || unknownCoverage() } : null,
    })), ...(approved && probe ? { previewId: probe.previewId } : {}) };
  };
  const verify = async () => {
    setFailure("");
    try {
      const expectedScopes = new Map([...groups].filter(([key]) => key !== "pending").map(([key, ids]) => [Number(key), scopeIds(Number(key), ids)]));
      const input = await buildInput(), current = ++generation.current; setProbing(true);
      const next: BatchProbe = await request("/api/channel-onboarding/batch/probe", input);
      if (current !== generation.current) return;
      const scopeChanged = billing && next.groups.some((group) => group.basis.tokenId && expectedScopes.has(group.basis.tokenId) && JSON.stringify([...group.basis.proposedChannelIds].sort((a, b) => a - b)) !== JSON.stringify(expectedScopes.get(group.basis.tokenId)));
      setProbe(next); remember(next.retryInput); setApproved(!scopeChanged && next.selections.every((selection) => selection.monitor.status === "verified") && !next.selections.some((selection) => selection.credentialUpdateRequired));
      if (scopeChanged) setFailure("完整渠道范围已变化，请核对下方新增范围后重新预览。");
    } catch (err: any) { if (!err.errorFields) setFailure(err.message || "验证失败，请重试"); setApproved(false); }
    finally { setProbing(false); }
  };
  const save = async () => {
    setSaving(true); setFailure("");
    try {
      if (retryInput) remember(retryInput, true);
      const next: BatchResult = await request("/api/channel-onboarding/batch", await buildInput());
      if (next.complete === true && next.groups.every((group) => group.complete && group.channels.every((entry) => entry.complete))) {
        setOpenIds([]); setSelectedIds([]); forget(requestId); remember(null); message.success(billing ? monitor || additionalIds.length || removalRequested ? "监控调整与 Key 对账已保存" : "Key 对账配置已保存" : "监控关联调整已保存"); await load(false); await onComplete().catch(() => message.warning("配置已保存，页面刷新失败，请刷新页面"));
      } else { useSaved(next); await load(false); await onComplete().catch(() => {}); }
    } catch (err: any) {
      setApproved(false); setFailure(err.message || "保存结果未取得，请核对已保存结果后重新预览");
      if (retryInput) { try { const recovered: BatchResult = await request("/api/channel-onboarding/batch/recover", retryInput); useSaved(recovered); if (recovered.complete) setFailure(""); } catch { /* 保留原意图，允许显式恢复。 */ } }
    } finally { setSaving(false); }
  };
  const changeForm = (changed: any, target: any) => {
    if (changed.type) {
      const allowed = CREDENTIALS[changed.type] || []; target.setFieldsValue(Object.fromEntries(["accessToken", "userId", "apiKey", "email", "password"].filter((key) => !allowed.includes(key)).map((key) => [key, ""])));
      if (target === form) { setMonitor(monitorMode === "add" || monitorMode === "replace"); if (billing) setAuthorizationId(changed.type === "newapi-key" ? upstreams.some((resource) => resource.type !== "newapi-key") ? "" : "new" : "self"); }
    }
    if (Object.keys(changed).some((key) => key !== "name")) invalidate(true);
  };
  const closeDrawer = () => { generation.current += 1; keyGeneration.current += 1; setOpenIds([]); };
  useDrawerEscape(openIds.length > 0 && !busy && !authorization.authorizationOpen, closeDrawer);
  const stopForNewKey = (rule: any) => modal.confirm({
    title: "停止旧 Key 核算后重新关联？", okText: "停止旧关联并选择新 Key", cancelText: "取消", okButtonProps: { danger: true },
    content: `请先在上游将站外或脚本调用与本站销售隔离到不同 Key。将停止核算关联 ${rule.id}，涉及渠道 ${names((rule.channels || []).map((channel: any) => channel.channelId))}；原账、旧范围与监控资源保留。新 Key 仍需实际验证、预览和确认。`,
    onOk: async () => {
      await api(`/api/reconciliation/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      const ids = [...openIds], resourceId = stationId, monitorEnabled = monitor;
      await load(false); open(ids); setStationId(resourceId); setCreating(false); setMonitor(monitorEnabled); setMonitorMode(monitorEnabled ? "add" : "keep"); setBilling(true);
      await onComplete().catch(() => {});
    },
  });
  const purposeSelected = monitor || billing || additionalIds.length > 0 || removalRequested;
  const pendingRecovery = pendingRequests.length === 1 ? pendingRequests[0] : null;
  const pendingForChannel = (id: number) => pendingRequests.find((intent) => intent.groups.some((group) => group.channels.some((channel) => channel.channelId === id)));
  const replacementReady = monitorMode !== "replace" || monitor || additionalIds.length > 0;
  const canSave = purposeSelected && replacementReady && approved && !stale && !coverageSourceChanged && !busy && !keyLoading && !!(creating || stationId || removalRequested) && !!probe && Date.now() < probe.expiresAtMs && !(billing && groups.has("pending") && keys.length > 0);
  return <>
    {!openIds.length && failure ? <Alert type="error" showIcon closable onClose={() => setFailure("")} message={failure} style={{ marginBottom: 16 }} /> : null}
    {workflowError ? <Alert type="warning" showIcon message={workflowError} action={<Space wrap><Button onClick={() => window.location.reload()}>刷新处理目标</Button><Button href="/stations">返回当前资源</Button></Space>} style={{ marginBottom: 16 }} /> : null}
    {destination?.action === "source" && !workflowError ? <section aria-label="核对本站来源" style={{ marginBottom: 16, overflowWrap: "anywhere" }}><Alert type={stale ? "warning" : "info"} showIcon message={stale ? "目录已过期，以下为最后核验来源" : "当前已核验本站来源"} description={<div>{source ? <><div>{source.provider} · {source.baseUrl} · 实际账号 {source.accountId}</div><div>本站资源：{source.stationId} · namespace：{source.namespaceKey}</div></> : <div>尚无核验来源，请读取最新本站渠道。</div>}<div>配置版本：{catalogue?.sourceVersion || "未知"} · 目录核验时间：{catalogue?.syncedAt ? new Date(catalogue.syncedAt).toISOString() : "尚未核验"}</div><div>此目录的已知渠道：{names(channels.map((channel) => channel.id))}</div><Text type="secondary">过期目录不能证明当前远端账号。同步仅更新渠道目录；实际关联仍需按当前来源验证、预览和确认。</Text></div>} action={<Button loading={refreshing} disabled={busy} onClick={() => void load(true)}>读取最新本站渠道</Button>} /></section> : null}
    <Collapse style={{ marginBottom: 16 }} defaultActiveKey={["connections"]} items={[{ key: "connections", label: `渠道接入 · ${channels.length}`, extra: <Button aria-label="发现新渠道" style={{ minHeight: 40 }} size="small" loading={refreshing} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void load(true); }}>发现新渠道</Button>, children: <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Text type="secondary">本站 New API 的渠道和分组自动带入，后台每 5 分钟发现。选择同账号渠道，按实际 Key 集中预览并确认。</Text>
      {stale && catalogue ? <Alert type="warning" showIcon message="渠道目录读取失败，正在显示上次发现的渠道" description={directoryError || catalogue.error || "目录待刷新，暂不能新增关联。"} /> : directoryError ? <Alert type="error" showIcon message="渠道目录暂不可用" description={directoryError} /> : null}
      {catalogue?.syncedAt ? <Text type="secondary">上次成功发现：{new Date(catalogue.syncedAt).toLocaleString("zh-CN")}{stale ? "（已过期）" : ""}</Text> : null}
      <div className="page-toolbar" style={{ width: "100%" }}><Input aria-label="搜索接入渠道" placeholder="搜索渠道、地址或本站分组" allowClear value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: "1 1 200px", minWidth: 0 }} /><Select aria-label="渠道接入状态" value={status} onChange={setStatus} style={{ minWidth: 130 }} options={[{ value: "all", label: "全部渠道" }, { value: "attention", label: "需处理" }, { value: "unlinked", label: "未关联监控" }, { value: "configured", label: "已配置对账" }]} /><Button disabled={busy || refreshing || stale || !selectedIds.length} style={{ minHeight: 44 }} onClick={() => open(selectedIds)} aria-label="批量接入所选渠道">接入所选 {selectedIds.length} 个渠道</Button>{pendingRecovery ? <Button style={{ minHeight: 44, maxWidth: "100%", height: "auto", whiteSpace: "normal", textAlign: "left" }} loading={recovering} disabled={!catalogue || busy} aria-label="恢复上次接入" onClick={() => void recover(pendingRecovery, true)}>继续完成：{names(pendingRecovery.groups.flatMap((group) => group.channels.map((channel) => channel.channelId)))}</Button> : null}</div>
      {pendingRequests.length > 1 ? <section aria-label="待完成接入"><Text strong>待完成 {pendingRequests.length} 项</Text>{pendingRequests.map((intent) => <div key={intent.requestId} style={{ marginTop: 8 }}><Button style={{ minHeight: 44, maxWidth: "100%", height: "auto", whiteSpace: "normal", textAlign: "left" }} disabled={busy} onClick={() => void recover(intent, true)}>继续完成：{names(intent.groups.flatMap((group) => group.channels.map((channel) => channel.channelId)))}</Button></div>)}</section> : null}
      {authorization.recoveryButton}
      {filtered.length ? <Checkbox checked={filtered.every((entry) => selectedIds.includes(entry.id))} indeterminate={filtered.some((entry) => selectedIds.includes(entry.id)) && !filtered.every((entry) => selectedIds.includes(entry.id))} disabled={stale || busy} onChange={(event) => setSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...filtered.map((entry) => entry.id)])].slice(0, 100) : selectedIds.filter((id) => !filtered.some((entry) => entry.id === id)))}>选择当前筛选渠道（最多 100 个）</Checkbox> : null}
      <List loading={refreshing && !catalogue} dataSource={filtered} locale={{ emptyText: stale ? "渠道目录暂不可用，请重试发现" : channels.length ? "没有匹配的渠道" : catalogue?.ownStation ? "暂无渠道，请在本站 New API 添加后发现" : "请先配置我的中转站，以读取渠道目录" }} pagination={filtered.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false} renderItem={(entry: any) => <List.Item style={{ display: "flex", flexWrap: "wrap", gap: 12 }}><Checkbox aria-label={`选择渠道 ${entry.name || entry.id}`} disabled={stale || busy} checked={selectedIds.includes(entry.id)} onChange={(event) => setSelectedIds(event.target.checked ? [...selectedIds, entry.id].slice(0, 100) : selectedIds.filter((id) => id !== entry.id))} /><div style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}><Space wrap><Text strong>{entry.name || `渠道 #${entry.id}`}</Text><Tag>{Number(entry.status) === 1 ? "启用" : Number(entry.status) === 2 ? "手动停用" : Number(entry.status) === 3 ? "自动停用" : "状态未知"}</Tag></Space><div><Text type="secondary">本站分组：{entry.groups?.join("、") || "未提供"}</Text></div><div><Text type="secondary">{entry.baseUrl || "渠道未提供上游地址，接入时补充"}</Text></div><Space wrap><Text>监控：{STATES[entry.monitor?.status] || "未关联"}</Text><Text>对账：{STATES[entry.reconciliation?.status] || "未配置"}</Text></Space></div><Button style={{ minHeight: 44 }} disabled={refreshing || stale || busy} onClick={() => { const pending = pendingForChannel(entry.id); if (pending) void recover(pending, true); else open([entry.id]); }} aria-label={`接入渠道 ${entry.name || entry.id}`}>{pendingForChannel(entry.id) ? "继续完成" : onboardingMonitorIds(entry).length || entry.reconciliation?.ruleIds?.length ? "管理关联" : "接入监控与对账"}</Button></List.Item>} />
    </Space> }]} />
    <Drawer title="接入监控与对账" aria-label="接入监控与对账" open={openIds.length > 0} width={compact ? "100%" : 600} closable={!busy} maskClosable={!busy} keyboard={false} onClose={closeDrawer} extra={!purposeSelected && (hasMonitorLinks || hasSavedBilling) ? <Button style={{ minHeight: 44 }} disabled={busy} onClick={closeDrawer}>完成</Button> : <Button aria-label={result ? "重试未完成步骤" : "确认关联"} style={{ minHeight: 44 }} type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>{result ? "重试未完成步骤" : "确认关联"}</Button>}>
      <Space direction="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
        <section aria-label="当前关联"><Text strong>本次选择 {openIds.length} 个渠道</Text><div><Text type="secondary">{names(openIds)}</Text></div>
          {hasMonitorLinks || hasSavedBilling ? <><div style={{ marginTop: 12 }}><Text strong>当前配置</Text><Text type="secondary"> · 未调整的配置继续保留</Text></div>{selectedChannels.map((channel) => <div key={channel.id} style={{ marginTop: 8 }}>
            {openIds.length > 1 ? <Text strong>{channel.name}</Text> : null}<div>监控：{resourceNames(onboardingMonitorIds(channel))}</div>
            <div>对账：{channel.reconciliation?.ruleIds?.length ? channel.reconciliation.ruleIds.map((id: string) => { const rule = catalogue.rules.find((entry: any) => entry.id === id); return rule ? `${resourceNames([rule.upstreamStationId])} · Key #${rule.tokenId} · ${names(rule.channels.map((entry: any) => entry.channelId))}` : `已保存关联 ${id}`; }).join("；") : "尚未配置"}</div>
          </div>)}</> : null}
          {hasMonitorLinks || hasSavedBilling ? <Space wrap style={{ marginTop: 8 }}>{currentResourceIds.map((id) => { const resource = upstreams.find((entry) => entry.id === id); return resource && resource.type !== "newapi-key" ? <Button key={id} size="small" style={{ minHeight: compact ? 40 : undefined }} disabled={busy} aria-label={`更新资源 ${resource.name} 的授权`} onClick={() => void updateAuthorization(id)}>更新“{resource.name}”授权</Button> : null; })}</Space> : null}
        </section>
        {hasSavedBilling ? <Space wrap>{[...new Set<string>(selectedChannels.flatMap((channel) => channel.reconciliation?.ruleIds || []))].map((id) => { const rule = catalogue.rules.find((entry: any) => entry.id === id); return <Button key={id} size="small" style={{ minHeight: compact ? 40 : undefined }} href={`/stations?action=scope&ruleId=${encodeURIComponent(id)}`}>管理现有 Key #{rule?.tokenId || "未知"} 范围</Button>; })}</Space> : null}
        {stale ? <Alert type="warning" showIcon message="目录已过期，请重新发现后验证" /> : null}{failure ? <Alert type="error" showIcon message={failure} /> : null}
        {result ? <Alert type={result.complete ? "success" : "warning"} showIcon message={result.complete ? "全部请求步骤已保存" : "接入尚有待完成步骤，已保存部分会继续复用"} description={<Space direction="vertical">{result.groups.map((group) => <div key={group.groupId}><Text strong>{names(group.channels.map((entry) => entry.channelId))} · {group.complete ? "已完成" : "待完成"}</Text><div>监控：{STATES[group.monitor.status]}；对账：{STATES[group.reconciliation.status]}</div><div>{group.reason || group.reconciliation.reason}</div><div>已保存资源：{resourceNames(group.saved.stationIds)}{group.saved.authorizationStationId ? `；账单授权：${resourceNames([group.saved.authorizationStationId])}` : ""}{group.saved.ruleId ? `；核算关联：${group.saved.ruleId}` : ""}</div>{group.channels.filter((entry) => !entry.complete).map((entry) => <div key={entry.channelId}>{names([entry.channelId])}：{entry.reason || "请重新预览并补齐剩余步骤"}</div>)}{group.remainingActions.length ? <Text type="secondary">下一步：{group.remainingActions.includes("supply_credentials") ? "补充尚未保存的授权，然后重新预览" : group.remainingActions.includes("select_key") ? "选择实际 Key 后重新预览" : "重新预览后重试未完成步骤"}</Text> : null}</div>)}{retryInput ? <Button disabled={busy} onClick={() => void recover(retryInput)}>核对已保存结果</Button> : null}</Space>} /> : null}
        {coverageRule ? <Alert type="info" showIcon message="核对既有 Key 的完整用途" description={<div>原核算关联 {coverageRule.id} · 上游 Key {coverageRule.tokenId} · 原成员 {names((coverageRule.channels || []).map((channel: any) => channel.channelId))}。本次范围已包含已知漏接渠道，请核对完整用途后重新预览。<Space wrap><Button href={`/stations?action=scope&ruleId=${encodeURIComponent(coverageRule.id)}`}>查看原范围与历史</Button><Button disabled={busy} onClick={() => stopForNewKey(coverageRule)}>隔离站外调用后关联新 Key</Button></Space></div>} /> : null}
        {hasMonitorLinks || hasSavedBilling ? <div><Text strong>本次监控调整</Text><Radio.Group aria-label="监控调整方式" style={{ display: "block", marginTop: 8 }} value={monitorMode} disabled={busy || !!coverageRule} onChange={(event) => changeMonitorMode(event.target.value)}><Space wrap><Radio value="keep" style={{ minHeight: 40, alignItems: "center" }}>保留现有监控</Radio><Radio value="add" style={{ minHeight: 40, alignItems: "center" }}>增加监控</Radio>{hasMonitorLinks ? <><Radio value="replace" style={{ minHeight: 40, alignItems: "center" }}>更换监控</Radio><Radio value="remove" style={{ minHeight: 40, alignItems: "center" }}>解除监控</Radio></> : null}</Space></Radio.Group></div> : null}
        {creating || monitorMode === "add" || monitorMode === "replace" || billing ? <>
          <div><Space wrap><Text strong>{creating ? "新增上游账号或 Key" : "复用已有上游"}</Text>{!coverageRule && upstreams.length ? <Button size="small" style={{ minHeight: compact ? 40 : undefined }} disabled={busy} onClick={changeResourceMode}>{creating ? "返回复用已有上游" : "新增上游账号"}</Button> : null}</Space></div>
          {creating ? <><Text type="secondary">首次填写后保存，其他渠道可直接复用。</Text><Form name="channel-onboarding" form={form} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, form)}><Form.Item name="type" label="监控方式"><Select options={TYPES} /></Form.Item><Form.Item name="name" label="上游资源名称" rules={[{ required: true, message: "请输入资源名称" }]}><Input /></Form.Item><Form.Item name="baseUrl" label="上游站点地址" rules={[{ required: true, message: "请输入站点地址" }]}><Input placeholder="https://upstream.example.com" /></Form.Item><CredentialFields type={formType} /></Form></> : <div><Text>上游账号或 Key 资源</Text><Select<string> aria-label="接入上游资源" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="searchText" value={stationId} disabled={busy || !!coverageRule} placeholder="输入名称或地址查找已保存资源" options={resourceOptions} optionRender={(option) => <div style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}><div>{option.label}</div><Text type="secondary">{option.data.baseUrl}</Text></div>} onChange={(id) => { setStationId(id); setAuthorizationId(upstreams.find((resource) => resource.id === id)?.type === "newapi-key" ? "" : "self"); setMonitor(monitorMode !== "keep" && monitorMode !== "remove" && upstreams.find((item) => item.id === id)?.monitorEnabled !== false); invalidate(true); }} />{main ? <Space wrap style={{ marginTop: 8 }}><Text type="secondary">{main.baseUrl} · 直接复用已保存授权</Text>{main.type !== "newapi-key" && !currentResourceIds.includes(main.id) ? <Button size="small" style={{ minHeight: compact ? 40 : undefined }} disabled={busy} onClick={() => void updateAuthorization(main.id)}>更新此账号授权</Button> : null}</Space> : <Text type="secondary">地址匹配仅供查找，请选择实际账号。</Text>}</div>}
        </> : null}
        {monitorMode === "add" || monitorMode === "replace" ? <>
          <Checkbox checked={monitor} disabled={busy || !creating && main?.monitorEnabled === false} onChange={(event) => { setMonitor(event.target.checked); invalidate(); }}>关联余额监控</Checkbox>
          {!creating && main?.monitorEnabled === false ? <Space wrap><Text type="secondary">此资源的监控已暂停，启用后可直接关联。</Text><Button disabled={busy} onClick={() => void enableMonitor(main.id)}>启用此资源监控</Button></Space> : null}
          <Collapse size="small" items={[{ key: "extra", label: "同时关联其他已有监控资源（可选）", children: <Select aria-label="其他监控资源" mode="multiple" style={{ width: "100%" }} value={additionalIds} disabled={busy} options={upstreams.filter((item) => item.monitorEnabled !== false && item.id !== stationId).map((item) => ({ value: item.id, label: stationLabel(item) }))} onChange={(ids) => { setAdditionalIds(ids); invalidate(); }} /> }]} />
        </> : null}
        {monitorMode === "replace" ? <Text type="warning">仅更换本次所选渠道的监控。旧关联将按最终预览解除，Key 对账保持原配置，除非你同时调整对账。</Text> : null}
        {monitorMode === "remove" ? <section aria-label="选择解除的监控">{selectedChannels.map((channel) => <div key={channel.id}><Text strong>{channel.name}</Text><Checkbox.Group style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }} value={removals[channel.id] || []} options={onboardingMonitorIds(channel).map((id) => ({ value: id, label: `解除 ${resourceNames([id])}` }))} disabled={busy} onChange={(ids) => { setRemovals((previous) => ({ ...previous, [channel.id]: ids as string[] })); invalidate(); }} /></div>)}</section> : null}
        {additionalIds.length ? <Alert type="warning" showIcon message="核对整体监控成本" description="账号余额与 Key 额度可能覆盖同一消费。将沿用各资源的整体成本纳入设置，请核对是否重复计入；Key 对账的成本只算一次，整体监控成本设置需要另行核对。" /> : null}
        <Checkbox checked={billing} disabled={busy} onChange={(event) => configureBilling(event.target.checked)}>{hasSavedBilling ? "调整已有 Key 对账" : "同时配置 Key 对账"}</Checkbox>
        {!purposeSelected && !hasMonitorLinks && !hasSavedBilling ? <Text type="secondary">请选择余额监控或 Key 对账。</Text> : null}
        {billing && groups.has("pending") ? <Text type="secondary">未选择 Key 时，可取消“同时配置 Key 对账”，仅保存余额监控关联。</Text> : null}
        {billing ? <>
          {requiresAuthorization ? <div><Text strong>这把 Key 所属的账号账单授权</Text><Select aria-label="接入账单授权" style={{ width: "100%", marginTop: 8 }} value={authorizationId || undefined} placeholder="选择实际账号，地址匹配仅作提示" disabled={busy} showSearch optionFilterProp="label" options={[...billingCandidates.matched, ...billingCandidates.others].map((item) => ({ value: item.id, label: `${stationLabel(item)} · ${item.baseUrl}` })).concat([{ value: "new", label: "补充账号账单授权" }])} onChange={(id) => { setAuthorizationId(id); invalidate(true); }} />{billingResourceId && !currentResourceIds.includes(billingResourceId) ? <Button size="small" style={{ minHeight: compact ? 40 : undefined }} disabled={busy} onClick={() => void updateAuthorization(billingResourceId)}>更新账单账号授权</Button> : null}</div> : null}
          {requiresAuthorization && authorizationId === "new" ? <><Alert type="info" showIcon message="账单授权只补一次" description="专用授权用于查账，不增加余额监控、告警或整体成本。" /><Form name="channel-onboarding-authorization" form={authorizationForm} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, authorizationForm)}><Form.Item name="type" label="账单授权方式"><Select options={TYPES.filter((type) => type.value !== "newapi-key")} /></Form.Item><Form.Item name="name" label="账单授权名称" rules={[{ required: true, message: "请输入授权名称" }]}><Input /></Form.Item><Form.Item name="baseUrl" label="账单站点地址" rules={[{ required: true, message: "请输入站点地址" }]}><Input /></Form.Item><CredentialFields type={authorizationType} /></Form></> : null}
          {keyLoading ? <Text type="secondary">正在读取账号的 Key 目录…</Text> : null}
          {keyError ? <Alert type="warning" showIcon message={keyError} action={<Button disabled={busy} onClick={() => setKeyReadVersion((version) => version + 1)}>重试读取 Key</Button>} /> : null}
          {accountsError ? <Text type="warning">{accountsError} <Button size="small" style={{ minHeight: compact ? 40 : undefined }} onClick={() => void loadAccounts()}>重试账号信息</Button></Text> : null}
          {billingResourceId && keyRead && !keys.length && !keyError ? <Text type="secondary">此账号尚无可用 Key，请先在上游创建实际调用 Key。</Text> : null}
          <div><Text strong>这些渠道实际使用的上游 Key</Text><Select aria-label="接入上游 Key" style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={tokenId} loading={keyLoading} disabled={busy || keyLoading || !keys.length || splitKeys || !!coverageRule} placeholder={billingResourceId ? "选择实际 Key，同 Key 只选一次" : "填写新授权后，先验证并读取 Key"} options={keyOptions} onChange={chooseKey} /></div>
          {openIds.length > 1 ? <Checkbox checked={splitKeys} disabled={busy || !!coverageRule} onChange={(event) => { setSplitKeys(event.target.checked); setChannelKeys(Object.fromEntries(openIds.map((id) => [id, tokenId]))); invalidate(); }}>这些渠道使用不同 Key，分别指定</Checkbox> : null}
          {splitKeys ? openIds.map((id) => <div key={id}><Text>{names([id])}</Text><Select aria-label={`渠道 ${id} 的上游 Key`} style={{ width: "100%", marginTop: 4 }} value={channelKeys[id]} disabled={busy || keyLoading || !keys.length} options={keyOptions} placeholder="明确选择实际 Key" onChange={(value) => { setChannelKeys((previous) => ({ ...previous, [id]: value })); const existing = savedKeyContext(value); if (existing) { setCoverage((previous) => ({ ...previous, [value]: previous[value] || existing.coverageDeclaration })); setKeyTimezones((previous) => ({ ...previous, [value]: previous[value] || existing.timezone })); } invalidate(); }} /></div>) : null}
          {[...groups].map(([key, ids]) => {
            if (key === "pending") return null;
            const union = scopeIds(Number(key), ids);
            const declaration = coverage[key] || unknownCoverage();
            return <div key={key}><Text strong>{keys.find((item) => item.id === Number(key))?.name || "待选择 Key"} · 完整关联范围</Text><div><Text>以上渠道：{names(union)}</Text></div><Text>除以上渠道外，这把 Key 是否还用于本站其他渠道或站外调用？</Text><Select aria-label={groups.size === 1 ? "Key 消费范围" : `Key ${key} 消费范围`} style={{ width: "100%", marginTop: 8 }} value={declaration.answer} disabled={busy} options={[{ value: "none", label: "没有" }, { value: "other_use", label: "有" }, { value: "unknown", label: "不确定" }]} onChange={(answer) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, answer, otherUse: answer === "other_use" ? "unspecified" : null } })); invalidate(); }} />{declaration.answer === "other_use" ? <><Select aria-label={`Key ${key} 的其他用途`} style={{ width: "100%", marginTop: 8 }} value={declaration.otherUse || "unspecified"} disabled={busy} options={[{ value: "own_channels", label: "本站其他渠道" }, { value: "external", label: "站外调用" }, { value: "unspecified", label: "尚未明确" }]} onChange={(otherUse) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, otherUse } })); invalidate(); }} />{declaration.otherUse === "own_channels" ? <Select aria-label={`Key ${key} 的漏接渠道`} mode="multiple" style={{ width: "100%", marginTop: 8 }} value={declaration.uncoveredOwnChannelIds} disabled={busy} options={channels.filter((entry) => !union.includes(entry.id)).map((entry) => ({ value: entry.id, label: entry.name || `#${entry.id}` }))} onChange={(ids) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, uncoveredOwnChannelIds: ids } })); invalidate(); }} /> : null}</> : null}{declaration.answer !== "none" ? <Text type="secondary">保留成本与收入参考，账面毛利待确认。{declaration.otherUse === "external" ? "请隔离调用 Key 后重新关联。" : "补齐这把 Key 的完整用途后重新预览。"}</Text> : null}</div>;
          })}
        </> : null}
        {purposeSelected ? <Button aria-label="验证并预览" style={{ minHeight: 44 }} loading={probing} disabled={!replacementReady || saving || recovering || keyLoading || stale || coverageSourceChanged || (!creating && !stationId && !removalRequested)} onClick={() => void verify()}>{billing && !billingResourceId && !keys.length ? "验证授权并读取 Key" : "验证并预览"}</Button> : null}
        {probe ? <>
          <Alert type={probe.selections.every((selection) => selection.monitor.status === "verified") ? "success" : "warning"} showIcon message={probe.selections.every((selection) => selection.monitor.status === "verified") ? "变更已验证，尚未保存" : "连接待完成"} description={probe.selections.map((selection) => selection.monitor.reason).filter(Boolean).join("；") || "核对本次变化后，点击顶部确认关联。"} />
          {probe.selections.filter((selection) => selection.credentialUpdateRequired).map((selection) => <Alert key={selection.selectionId} type="warning" showIcon message="此账号已保存" description={<Space direction="vertical"><Text>选择直接复用已有授权，或更新这个账号的授权。</Text><Space wrap><Button disabled={busy || !selection.station?.id} onClick={() => { setStationId(selection.station!.id!); setCreating(false); invalidate(true); }}>复用这个账号</Button><Button disabled={busy || !selection.station?.id} onClick={() => void updateAuthorization(selection.station!.id!, connection(form.getFieldsValue()))}>更新这个账号授权</Button></Space></Space>} />)}
          {probe.groups.flatMap((group) => group.monitorChanges || []).map((change) => <section key={change.channelId} aria-label={`渠道 ${change.channelId} 的监控变更`}>
            <Text strong>{names([change.channelId])} · 监控变更</Text><div>保留：{resourceNames(change.previousStationIds.filter((id) => change.proposedStationIds.includes(id)))}</div>
            <div>增加：{resourceNames(change.addedStationIds)}{creating && monitor ? `；新资源“${form.getFieldValue("name") || "上游账号"}”` : ""}</div><div>解除：{resourceNames(change.removedStationIds)}</div>
          </section>)}
          {billing ? probe.groups.map((group) => <Alert key={group.groupId} type={group.status === "ready" ? "info" : "warning"} showIcon message={group.code === "KEY_REQUIRED" ? "Key 对账待配置" : group.basis.existingRuleId ? "加入已有核算关联" : STATES[group.status] || "接入预览"} description={<Space direction="vertical">
            {group.reason ? <Text>{group.reason}</Text> : null}<Text>实际账单账号：{group.basis.accountIdentity ? `${group.basis.accountIdentity.baseUrl} · 账号 ${group.basis.accountIdentity.accountId}` : "待核验"}</Text>
            <Text>实际 Key：{group.basis.tokenId ? `${keys.find((key) => key.id === group.basis.tokenId)?.name || "上游 Key"} · Key #${group.basis.tokenId}` : "待选择"}</Text>
            <Text>已有渠道：{names(group.basis.existingChannelIds)}；本次加入：{names(group.requestedChannelIds)}</Text><Text>完整范围：{names(group.basis.proposedChannelIds)}</Text>
            <Text>{group.preview.scopeChanged ? "确认后立即生效：从确认时刻开始核算，自然日结束后自动结账。" : `生效时间：${time(group.preview.billingEffectiveFromMs, group.basis.timezone)}（${group.basis.timezone}），范围未变化。`}</Text>
            <Text type="secondary">同一 Key 成本只算一次；消费范围待确认时毛利仅供参考。</Text>
          </Space>} />) : probe.groups.filter((group) => group.reason).map((group) => <Alert key={group.groupId} type="warning" showIcon message="监控关联待完成" description={group.reason} />)}
          <Collapse size="small" items={[{ key: "basis", label: "查看来源与验证详情", children: <Space direction="vertical"><Text>实际本站来源：{source ? `${source.provider} · ${source.baseUrl} · 账号 ${source.accountId}` : "待核验"}</Text><Text>配置版本：{catalogue?.sourceVersion}</Text>{selectedChannels.map((channel) => <Text key={channel.id}>{channel.name} · 本站分组 {channel.groups?.join("、") || "未提供"}</Text>)}</Space> }]} />
          {!approved && !probe.selections.some((selection) => selection.credentialUpdateRequired) ? <Text type="warning">请核对调整后的内容，重新验证并预览。</Text> : null}
        </> : null}
      </Space>
    </Drawer>
    {authorization.overlay}
  </>;
}
