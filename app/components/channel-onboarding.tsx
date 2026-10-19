"use client";
// 上游资源 · 渠道绑定：选自营站点的渠道，按「测试读取 → 预览 → 确认绑定」绑到上游账号和 Key
// （POST /api/channel-onboarding/batch/probe、/batch，没做完的用 /batch/recover 接着做）。
// 文案按 design/ui-copy-spec.md 写；报错按 §8.2 归类，原文只进「查看详细原因」。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Input, List, Radio, Select, Space, Tag, Typography } from "antd";
import { api } from "../../lib/client";
import { createRequestId } from "../../lib/request-id.js";
import { BINDING_COPY, ONBOARDING_PURPOSES, ONBOARDING_PURPOSE_REQUIRED, groupOnboardingResources } from "../../lib/channel-onboarding.js";
import type { BatchInput, BatchProbe, BatchRecoveryIntent, BatchResult, ConnectionInput, CoverageDeclaration, WorkflowDestination, SourceCatalogueProjection } from "../../lib/client";
import { NAV_LABELS, STATION_TABS } from "../../lib/brand";
import { ERROR_CATEGORIES, describeError, failureText, requiredText } from "../../lib/error-copy.js";
import { EMPTY, OWN_STATION_UNSET, formatAsOf, formatDayZone, formatZonedDateTime, refreshFailedText } from "../../lib/format";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, coverageAnswerOption, coverageDeclarationOf, reconciliationChannelStatus, reconciliationIssue } from "../../lib/reconciliation-contract.js";
import { reconciliationChannelName, reconciliationChannelTag, reconciliationKeyName } from "../../lib/reconciliation-view.js";
import { DESTINATION_CHANGED, HISTORY_KEPT, testReadText, workflowAction, workflowActionMeta } from "../../lib/workflow-actions.js";
import { useDrawerEscape } from "./drawer-escape";
import { ErrorDetail } from "./error-detail";

const { Text } = Typography;

// 按钮名和完成提示（§3.5，lib/workflow-actions.js）
const CONNECT = workflowActionMeta("connect_channels")!;
const EDIT = workflowActionMeta("edit_binding")!.label;
const REFRESH = workflowActionMeta("refresh")!.label;
const SWAP = workflowActionMeta("swap_key")!.label;
const REVIEW_SOURCE = workflowActionMeta("review_source")!.label;
const UPDATE_AUTH = workflowActionMeta("update_authorization")!.label;
const TEST_READ = workflowActionMeta("verify_identity")!.label;
const SETUP = workflowAction("setup_own_station");
// 要人动手的问题（§5.2，lib/reconciliation-contract.js）
const SOURCE = reconciliationIssue("SOURCE_BINDING_UNCONFIRMED");
const KEY_DENIED = reconciliationIssue("KEY_INVALID_OR_DENIED");
const COVERAGE = reconciliationIssue("COST_COVERAGE_UNKNOWN");
// 渠道列表里的状态（§5.6）
const channelStatusLabel = (key: string) => reconciliationChannelStatus(key).label;
const ACCOUNTED = channelStatusLabel("accounted");
const UNLINKED = channelStatusLabel("unlinked");
const NEEDS_ACTION = channelStatusLabel("source_unverified");
const MONITOR_ONLY = channelStatusLabel("monitor_only");
const UNSUPPORTED = channelStatusLabel("unsupported");

// 上游类型（§3.7 类型表）；渠道绑定不做固定成本，所以没有那一项
const TYPES = [
  { value: "newapi", label: "New API 账号", hint: "用访问令牌读取余额和账单" },
  { value: "newapi-key", label: "New API Key", hint: "只用一把 Key 读取余额" },
  { value: "sub2api", label: "Sub2API 账号（登录令牌）", hint: "用登录令牌读取" },
  { value: "sub2api-password", label: "Sub2API 账号（邮箱密码）", hint: "用邮箱密码登录，自动续期" },
];
// 输入框名和下方的说明（§3.7）
const FIELDS = Object.freeze({
  type: { label: "类型" },
  name: { label: "上游名称" },
  authorizationName: { label: "名称" },
  baseUrl: { label: "站点地址", hint: "上游网站的地址，例如 https://api.example.com" },
  accessToken: { label: "访问令牌", hint: "在上游后台「个人设置」里生成，用来读取余额和用量记录" },
  loginToken: { label: "登录令牌", hint: "登录 Sub2API 后拿到的一串字符，用来读取余额和用量记录" },
  userId: { label: "用户 ID", hint: "上游后台「个人设置」里的数字 ID；上游要求时才填" },
  apiKey: { label: "Key", hint: "在上游后台的「令牌」或「API 密钥」页面复制，以 sk- 开头" },
  email: { label: "登录邮箱" },
  password: { label: "登录密码", hint: "你在上游登录用的邮箱和密码" },
});
const required = (label: string) => ({ required: true, message: requiredText(label) });

// 渠道绑定独有的话，只在这一处写；用语按 design/ui-copy-spec.md
const USE_SAVED = "用已有上游";
const ADD_OR_UPDATE = `新增上游或${UPDATE_AUTH}`;
const COPY = Object.freeze({
  intro: "自营站点的渠道和分组自动带入，每 5 分钟刷新一次。选好渠道，绑定到同一把 Key。",
  confirm: "确认绑定",
  finish: "接着做完",
  resume: "接着上次没做完的",
  back: "返回",
  cancel: "取消",
  saved: "已保存",
  pending: "还没做完",
  ready: "可以绑定",
  unverified: "还没测试读取",
  // 已经保存，只是页面上别的部分没跟着读到新的
  pageRefreshFailed: "页面没跟着更新，请刷新页面。",
  openFailed: "打开失败",
  refreshFirst: "刷新后才能绑定",
  noChannels: "自营站点里还没有渠道",
  noMatch: "没有匹配的渠道",
  noBaseUrl: "渠道里没填上游地址，绑定时补上",
  notUpdated: (asOf: unknown, span: string, tz?: string) => `${formatAsOf(asOf, tz)}，已经 ${span}没更新。`,
  search: "搜索渠道",
  searchPlaceholder: "搜索渠道、地址或分组",
  statusFilter: "状态",
  allChannels: "全部渠道",
  unmatched: "没对上上游的渠道",
  selectFiltered: "选中筛出来的渠道（最多 100 个）",
  selectChannel: (name: string) => `选择「${name}」`,
  selected: (count: number) => `已选 ${count} 个渠道`,
  prefilled: "自营站点的名称、地址、分组和停用状态已带入，不用再填。",
  ownStation: "自营站点",
  channels: "渠道",
  group: "分组",
  upstreamAccount: "上游账号",
  account: "账号",
  pausedMonitor: "暂停监控",
  existing: "已绑定",
  adding: "这次加",
  allBound: "全部渠道",
  upstream: "上游",
  loginInfo: "登录信息",
  binding: "绑定",
  nextStep: "下一步",
  partial: "还有几步没做完，做完的会保留",
  viewSaved: "查看保存结果",
  supplyCredentials: "登录信息还没保存，请重新填一次",
  swapNotice: `站外也在用的话，先在上游给站外单开一把 Key。换成新 Key 后，旧 Key ${HISTORY_KEPT}。`,
  pickUpstream: "选上游",
  useSaved: USE_SAVED,
  addOrUpdate: ADD_OR_UPDATE,
  whenTitle: "什么时候要填登录信息",
  whenFirst: "第一次加：填还没保存过的上游账号或 Key。",
  whenUpdate: `${UPDATE_AUTH}：填同一个上游账号的新登录信息，保存时沿用原来的上游。`,
  whenSaved: `已经能读到的，选「${USE_SAVED}」，不用再填。`,
  savedHint: "用已保存的站点地址和登录信息，不用再填。地址对得上的排在前面，也可以按名称或地址搜。",
  upstreamPlaceholder: "按名称或地址找上游",
  selectedHint: (name: string) => `已选「${name}」，测试读取时用它已保存的登录信息。只有要换登录信息时才选「${ADD_OR_UPDATE}」。`,
  pickHint: `选一个已保存的上游；地址对得上不一定是同一个账号，请看清账号。要加新账号时选「${ADD_OR_UPDATE}」。`,
  matchedGroup: (count: number) => `地址对得上的上游（${count}）`,
  otherGroup: (count: number) => `其他上游（${count}）`,
  monitorOnlyNote: "只用访问令牌读账单，原来的余额设置不变。",
  extraMonitors: "同时看其他上游的余额（可选）",
  extraAria: "其他上游",
  doubleCost: `同一个上游账号的余额和 Key 额度可能是同一笔花费，绑定只算一次上游成本；${NAV_LABELS.analytics}里要不要算两次，请到上游设置看「算进利润」开关。`,
  billingCheckbox: `同时${ONBOARDING_PURPOSES.billing}（绑定 Key）`,
  noKeyNeeded: "只看余额时，不用选 Key",
  authHint: "用这个上游账号的访问令牌读账单和 Key；权限不够时在这里更新登录信息。",
  authOnceTitle: "访问令牌只填一次",
  authOnce: "只用来读账单，不会多出余额提醒或成本。",
  keysTitle: "这些渠道用的 Key",
  keyPlaceholder: "测试读取后选 Key，同一把 Key 只选一次",
  splitKeys: "这些渠道用的 Key 不一样，分别选",
  channelKey: (name: string) => `「${name}」的 Key`,
  chooseKey: "选择 Key",
  testFirst: "测试读取后选 Key。",
  keySelected: "已选 Key，预览一下这把 Key 绑定的全部渠道。",
  monitorOnlyKey: "只看余额，不用选 Key",
  notSaved: "还没保存",
  notSavedYet: "确认绑定后才保存；取消不会新增上游，也不会提醒",
  updateExisting: "已有这个上游账号，用这次的登录信息更新它",
  noKey: "还没绑定 Key",
  joinExisting: "加到已有绑定",
  startsNow: "从现在开始算利润，今天就能看到；过了零点自动固定。",
  costOnce: "同一把 Key 的上游成本只算一次",
  coverageUnanswered: `回答「${COVERAGE_QUESTION}」之前，利润先不算`,
});
// 保存结果里两种用途各自的状态（§5.6）；没要的用途不显示
const MONITOR_RESULT: Record<string, string> = { linked: COPY.saved, pending: COPY.pending, unavailable: COPY.pending };
const BILLING_RESULT: Record<string, string> = { configured: ACCOUNTED, unverified: COPY.unverified, unsupported: UNSUPPORTED, unavailable: UNSUPPORTED, pending: COPY.pending };
// 测试读取后每把 Key 的预览标题
const PREVIEW_STATE: Record<string, string> = { ready: COPY.ready, monitor_only: MONITOR_ONLY, unverified: COPY.unverified, unsupported: UNSUPPORTED, unavailable: UNSUPPORTED };

const CREDENTIALS: Record<string, string[]> = { newapi: ["accessToken", "userId"], "newapi-key": ["apiKey"], sub2api: ["accessToken"], "sub2api-password": ["email", "password"] };
const RECOVERY_KEY = "channel-onboarding-recovery-v05";
const unknownCoverage = (): CoverageDeclaration => ({ answer: "unknown", otherUse: null, uncoveredOwnChannelIds: [] });
// 接口报错带上 code、status，界面按 describeError 归类
async function request(path: string, body?: any) {
  const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.location.href = "/login";
  if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), { status: response.status }, result);
  return result;
}
function connection(values: any): ConnectionInput {
  const type = values.type || "newapi";
  return Object.fromEntries(["name", "baseUrl", "type", ...(CREDENTIALS[type] || [])].map((key) => [key, values[key] ?? ""])) as ConnectionInput;
}
// 上游的名字；类型名只在选类型处出现（§3.7），这里写账号和是否暂停监控（§3.3）
function stationLabel(station: any) {
  return `${station.name}${station.identity?.accountId ? ` · ${COPY.account} ${station.identity.accountId}` : ""}${station.monitorEnabled === false ? ` · ${COPY.pausedMonitor}` : ""}`;
}
// 渠道列表多久没更新（§8.1）：从来没读到写「读不到」，刷新失败写「刷新失败，数据截至」，否则写隔了多久
function staleText(syncedAt: unknown, failed: boolean, tz?: string, now = Date.now()) {
  if (!syncedAt) return BINDING_COPY.channelsUnreadable;
  if (failed) return refreshFailedText(syncedAt, tz);
  const minutes = Math.max(1, Math.floor((now - new Date(syncedAt as any).getTime()) / 60000));
  return COPY.notUpdated(syncedAt, minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`, tz);
}
function CredentialFields({ type }: { type: string }) {
  const token = type === "newapi" ? FIELDS.accessToken : FIELDS.loginToken;
  return <>
    {type === "newapi" || type === "sub2api" ? <Form.Item name="accessToken" label={token.label} extra={token.hint} rules={[required(token.label)]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "newapi" ? <Form.Item name="userId" label={FIELDS.userId.label} extra={FIELDS.userId.hint}><Input /></Form.Item> : null}
    {type === "newapi-key" ? <Form.Item name="apiKey" label={FIELDS.apiKey.label} extra={FIELDS.apiKey.hint} rules={[required(FIELDS.apiKey.label)]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "sub2api-password" ? <><Form.Item name="email" label={FIELDS.email.label} rules={[required(FIELDS.email.label)]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label={FIELDS.password.label} extra={FIELDS.password.hint} rules={[required(FIELDS.password.label)]}><Input.Password autoComplete="current-password" /></Form.Item></> : null}
  </>;
}
// 新增上游和补访问令牌共用的填写项：类型、名称、站点地址和登录信息
function ConnectionFields({ type, nameLabel, types }: { type: string; nameLabel: string; types: typeof TYPES }) {
  return <>
    <Form.Item name="type" label={FIELDS.type.label} extra={TYPES.find((item) => item.value === type)?.hint}><Select options={types.map(({ value, label }) => ({ value, label }))} /></Form.Item>
    <Form.Item name="name" label={nameLabel} rules={[required(nameLabel)]}><Input /></Form.Item>
    <Form.Item name="baseUrl" label={FIELDS.baseUrl.label} extra={FIELDS.baseUrl.hint} rules={[required(FIELDS.baseUrl.label)]}><Input /></Form.Item>
    <CredentialFields type={type} />
  </>;
}

// 界面上的一条报错或提示：text 那一句，detail 补充说明，raw 原文（只进「查看详细原因」），action 下一步按钮
type Problem = { text: string; detail?: string; raw?: unknown; action?: { label: string; href: string } | null };
function ProblemAlert({ problem, type = "error", extra, style }: { problem: Problem; type?: "error" | "warning"; extra?: ReactNode; style?: CSSProperties }) {
  const description = problem.detail || problem.raw ? <div>{problem.detail ? <div>{problem.detail}</div> : null}<ErrorDetail raw={problem.raw} /></div> : undefined;
  const action = problem.action || extra ? <Space wrap>{problem.action ? <Button href={problem.action.href}>{problem.action.label}</Button> : null}{extra}</Space> : undefined;
  return <Alert type={type} showIcon title={problem.text} description={description} action={action} style={style} />;
}
// 本页自己拦下的情况：已经是界面上的话，不再归类
const uiError = (text: string) => Object.assign(new Error(text), { uiText: text });

export default function ChannelOnboarding({ compact, onComplete, destination }: { compact: boolean; onComplete: () => Promise<void>; destination?: WorkflowDestination | null }) {
  const { message, modal } = App.useApp();
  const [catalogue, setCatalogue] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 渠道列表刷新失败时的错误（接口返回的 { code, reason } 或抛出的 Error），只用来归类和放原文
  const [directoryError, setDirectoryError] = useState<any>("");
  const [workflowError, setWorkflowError] = useState<Problem | null>(null);
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
  const [failure, setFailure] = useState<Problem | null>(null);
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
  const unset = !!catalogue && !catalogue.ownStation;
  // 这次刷新失败的原因：本页读取抛错，或接口记下的上次刷新错误
  const syncFailure = directoryError || (catalogue?.error ? { code: catalogue.errorCode, reason: catalogue.error } : null);
  const upstreams: any[] = catalogue?.upstreams || [];
  const main = upstreams.find((item) => item.id === stationId);
  const requiresAuthorization = (creating ? formType : main?.type) === "newapi-key";
  const channels: any[] = catalogue?.channels || [];
  const resourceGroups = useMemo(() => {
    const selected = new Set(openIds);
    return groupOnboardingResources(upstreams, channels.filter((channel) => selected.has(channel.id)));
  }, [upstreams, channels, openIds]);
  const resourceOption = (station: any) => ({ value: station.id, label: stationLabel(station), baseUrl: station.baseUrl,
    searchText: `${stationLabel(station)} ${station.baseUrl}` });
  const resourceOptions = [
    { label: COPY.matchedGroup(resourceGroups.matched.length), options: resourceGroups.matched.map(resourceOption) },
    { label: COPY.otherGroup(resourceGroups.others.length), options: resourceGroups.others.map(resourceOption) },
  ].filter((group) => group.options.length);
  const source: SourceCatalogueProjection["ownSource"] = catalogue?.ownSource || null;
  const coverageSourceChanged = !!(coverageRule?.ownSource && source && coverageRule.ownSource.namespaceKey !== source.namespaceKey);
  const names = (ids: number[]) => ids.map((id) => reconciliationChannelName(channels.find((entry) => entry.id === id) || { id })).join("、") || EMPTY;
  const stationName = (id: string | null | undefined) => upstreams.find((item) => item.id === id)?.name || COPY.saved;
  const keys = probe?.selections.flatMap((selection) => selection.tokens) || [];
  const keyName = (id: number) => reconciliationKeyName({ tokenName: keys.find((item) => item.id === id)?.name, tokenId: id });
  const keyOptions = [...new Map(keys.map((key) => [key.id, key])).values()].map((key) => ({ value: key.id, disabled: key.status !== 1 || key.crossGroupRetry || key.group === "auto", label: `${reconciliationKeyName({ tokenName: key.name, tokenId: key.id })} · ${COPY.group} ${key.group || EMPTY}` }));
  const groups = new Map<string, number[]>();
  for (const id of openIds) { const key = billing ? String((splitKeys ? channelKeys[id] : tokenId) || "pending") : "monitor"; groups.set(key, [...(groups.get(key) || []), id]); }
  const filtered = channels.filter((entry) => (status === "all" || status === "attention" && (entry.monitor?.status !== "linked" || entry.reconciliation?.status !== "configured") || status === "unlinked" && entry.monitor?.status !== "linked" || status === "configured" && entry.reconciliation?.status === "configured") && `${entry.name} ${entry.id} ${entry.baseUrl} ${(entry.groups || []).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  // 报错的下一步按钮（§8.2）：去设置自营站点，或给已选的上游更新登录信息；别的类在原处改了再试
  const errorAction = (kind: string | null) => {
    if (kind === "setup_own_station") return { label: SETUP.label, href: SETUP.href! };
    if (kind === "update_authorization" && !creating && stationId) return { label: UPDATE_AUTH, href: workflowAction("update_authorization", { stationId }).href! };
    return null;
  };
  const problemOf = (err: any, wrap?: (text: string) => string): Problem => {
    if (err?.uiText) return { text: err.uiText };
    const described = describeError(err);
    return { text: wrap ? wrap(described.text) : described.text, raw: described.raw, action: errorAction(described.action) };
  };
  const sourceProblem = (ownStationId: string | undefined): Problem => ({ text: SOURCE.title, detail: SOURCE.detail,
    action: { label: REVIEW_SOURCE, href: workflowAction("review_source", { ownStationId }).href! } });
  const invalidate = (credentials = false) => {
    generation.current += 1; setApproved(false); setFailure(null);
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
      setCatalogue((previous: any) => next.stale && !next.channels?.length && previous?.channels?.length ? { ...next, channels: previous.channels } : next); setDirectoryError(next.error ? { code: next.errorCode, reason: next.error } : "");
      if (openIds.length && (next.sourceVersion !== catalogue?.sourceVersion || next.ownStation?.id !== catalogue?.ownStation?.id || openIds.some((id) => next.channels?.find((entry: any) => entry.id === id)?.revision !== channels.find((entry) => entry.id === id)?.revision))) invalidate(true);
      if (coverageRule?.ownSource && next.ownSource && coverageRule.ownSource.namespaceKey !== next.ownSource.namespaceKey) { generation.current += 1; setApproved(false); setProbe(null); setFailure(sourceProblem(next.ownStation?.id)); }
      return next;
    } catch (err: any) { setDirectoryError(err || true); setApproved(false); }
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
    let nextRequestId: string;
    try { nextRequestId = createRequestId(); } catch (err: any) { message.error(failureText(COPY.openFailed, err)); return; }
    invalidate(true); setTokenId(undefined); setOpenIds(ids); setResult(null); setRetryInput(null); setRequestId(nextRequestId); setAdditionalIds([]); setBilling(false); setCoverage({}); setCoverageRule(null); setKeyTimezones({}); setSplitKeys(false); setAuthorizationId("self");
    const entries = ids.map((id) => channels.find((entry) => entry.id === id)).filter(Boolean);
    const candidates = entries.map((entry) => entry.monitor?.stationIds?.[0] || (entry.candidates?.length === 1 ? entry.candidates[0]?.id || entry.candidates[0] : undefined));
    const linked = candidates.map((id) => upstreams.find((item) => item.id === id));
    const sameAccount = linked[0]?.identity && linked.every((item) => item?.type !== "newapi-key" && item?.identity?.provider === linked[0].identity.provider && String(item?.identity?.accountId) === String(linked[0].identity.accountId) && item?.baseUrl === linked[0].baseUrl && item?.monitorEnabled === linked[0].monitorEnabled);
    const existing = upstreams.find((item) => candidates[0] && candidates.every((id) => id === candidates[0]) && item.id === candidates[0]) || (sameAccount ? linked[0] : undefined);
    setStationId(existing?.id); setCreating(!upstreams.length); setMonitor(existing?.monitorEnabled !== false);
    form.resetFields(); form.setFieldsValue({ name: entries[0]?.name || "上游账号", baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
    authorizationForm.resetFields(); authorizationForm.setFieldsValue({ name: `${entries[0]?.name || "上游"}${FIELDS.accessToken.label}`, baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
  };
  useEffect(() => {
    if (destination?.action === "source" && catalogue && !refreshing && !destinationResolved.current) {
      destinationResolved.current = true;
      if (destination.error || !destination.ownStationId || destination.ownStationId !== catalogue.ownStation?.id) setWorkflowError({ text: destination.error || DESTINATION_CHANGED });
      return;
    }
    if (!destination || !["connect", "coverage"].includes(destination.action) || destinationResolved.current || !catalogue || refreshing || stale) return;
    destinationResolved.current = true;
    const rule = destination.action === "coverage" ? (catalogue.rules || []).find((rule: any) => rule.id === destination.ruleId && rule.enabled && !rule.archivedAt) : null;
    const ownId = rule?.ownStationId || destination.ownStationId;
    const ids: number[] = rule ? [...new Set<number>([...(rule.channels || []).map((channel: any) => Number(channel.channelId)), ...(rule.coverageDeclaration?.otherUse === "own_channels" ? rule.coverageDeclaration.uncoveredOwnChannelIds || [] : [])])] : destination.channelIds;
    if (destination.error || !ownId || ownId !== catalogue.ownStation?.id || destination.action === "coverage" && !rule || !ids.length || ids.some((id) => !channels.find((channel) => channel.id === id && channel.revision && !channel.missing))) {
      setWorkflowError({ text: destination.error || DESTINATION_CHANGED }); return;
    }
    if (rule && (!upstreams.some((station) => station.id === rule.upstreamStationId) || !Number.isSafeInteger(rule.tokenId) || rule.tokenId < 1)) {
      // 上游还在时，去更新它的登录信息；上游已不在就只说原因
      setWorkflowError({ text: KEY_DENIED.title, detail: KEY_DENIED.detail, action: upstreams.some((station) => station.id === rule.upstreamStationId)
        ? { label: UPDATE_AUTH, href: workflowAction("update_authorization", { stationId: rule.upstreamStationId }).href! } : null });
      return;
    }
    if (rule?.ownSource && source && rule.ownSource.namespaceKey !== source.namespaceKey) { setWorkflowError(sourceProblem(catalogue.ownStation?.id)); return; }
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
    setRecovering(true); setFailure(null);
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
      if (next.complete) message.success(intent.groups.some((group) => group.reconciliationRequested) ? CONNECT.done : COPY.saved);
    } catch (err: any) { setFailure(problemOf(err)); }
    finally { setRecovering(false); }
  };
  const buildInput = async (): Promise<BatchInput> => {
    if (!requestId) throw uiError(ERROR_CATEGORIES.expired.text);
    if (!purposeSelected) throw uiError(ONBOARDING_PURPOSE_REQUIRED);
    const selection: BatchInput["selections"][number] = { selectionId: "primary", monitor, additionalMonitorStationIds: additionalIds, updateCredentials };
    if (creating) selection.newStation = connection(await form.validateFields()); else selection.stationId = stationId;
    if (billing && authorizationId !== "self") selection.reconciliationAuthorization = authorizationId === "new" ? { newAuthorization: connection(await authorizationForm.validateFields()) } : { stationId: authorizationId };
    return { requestId, ownStationId: catalogue.ownStation.id, selections: [selection], groups: [...groups].map(([key, ids]) => ({ groupId: `key-${key}`, selectionId: "primary", channels: ids.map((id) => ({ channelId: id, channelRevision: channels.find((entry) => entry.id === id)?.revision || retryInput?.groups.flatMap((group) => group.channels).find((entry) => entry.channelId === id)?.channelRevision || "" })), reconciliation: billing ? { ...(key !== "pending" ? { tokenId: Number(key) } : {}), ...(keyTimezones[key] ? { timezone: keyTimezones[key] } : {}), coverageDeclaration: coverage[key] || unknownCoverage() } : null })), ...(approved && probe ? { previewId: probe.previewId } : {}) };
  };
  const verify = async () => {
    setFailure(null);
    try {
      const input = await buildInput(), current = ++generation.current; setProbing(true);
      const next: BatchProbe = await request("/api/channel-onboarding/batch/probe", input);
      if (current !== generation.current) return;
      setProbe(next); remember(next.retryInput); setApproved(next.selections.every((selection) => selection.monitor.status === "verified") && (!next.selections.some((selection) => selection.credentialUpdateRequired) || updateCredentials));
    } catch (err: any) { if (!err.errorFields) setFailure(problemOf(err, (text) => testReadText({ ok: false, reason: text }))); setApproved(false); }
    finally { setProbing(false); }
  };
  const save = async () => {
    setSaving(true); setFailure(null);
    try {
      const next: BatchResult = await request("/api/channel-onboarding/batch", await buildInput());
      if (next.complete === true && next.groups.every((group) => group.complete && group.channels.every((entry) => entry.complete))) {
        setOpenIds([]); setSelectedIds([]); remember(null); message.success(billing ? CONNECT.done : COPY.saved); await load(false); await onComplete().catch(() => message.warning(`${COPY.saved}；${COPY.pageRefreshFailed}`));
      } else { useSaved(next); await load(false); await onComplete().catch(() => {}); }
    } catch (err: any) {
      setApproved(false); setFailure(problemOf(err));
      if (retryInput) { try { const recovered: BatchResult = await request("/api/channel-onboarding/batch/recover", retryInput); useSaved(recovered); if (recovered.complete) setFailure(null); } catch { /* 保留原意图，允许显式恢复。 */ } }
    } finally { setSaving(false); }
  };
  const changeForm = (changed: any, target: any) => {
    if (changed.type) {
      const allowed = CREDENTIALS[changed.type] || []; target.setFieldsValue(Object.fromEntries(["accessToken", "userId", "apiKey", "email", "password"].filter((key) => !allowed.includes(key)).map((key) => [key, ""])));
      if (target === form) { setMonitor(true); if (billing) setAuthorizationId(changed.type === "newapi-key" ? "new" : "self"); }
    }
    if (Object.keys(changed).some((key) => key !== "name")) invalidate(true);
  };
  const closeDrawer = () => { generation.current += 1; setOpenIds([]); };
  useDrawerEscape(openIds.length > 0 && !busy, closeDrawer);
  const stopForNewKey = (rule: any) => modal.confirm({
    title: `${SWAP}？`, okText: SWAP, cancelText: COPY.cancel, okButtonProps: { danger: true },
    content: COPY.swapNotice,
    onOk: async () => {
      await api(`/api/reconciliation/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      const ids = [...openIds], resourceId = stationId, monitorEnabled = monitor;
      await load(false); open(ids); setStationId(resourceId); setCreating(false); setMonitor(monitorEnabled); setBilling(true);
      await onComplete().catch(() => {});
    },
  });
  const purposeSelected = monitor || billing || additionalIds.length > 0;
  const canSave = purposeSelected && approved && !stale && !coverageSourceChanged && !busy && !!(creating || stationId) && !!probe && Date.now() < probe.expiresAtMs && !(billing && groups.has("pending") && keys.length > 0);
  const refreshButton = <Button loading={refreshing} disabled={busy} onClick={() => void load(true)}>{REFRESH}</Button>;
  const syncDescribed = syncFailure ? describeError(syncFailure) : null;
  // 渠道列表里一行的状态（§5.6）：要重新确认的先说「需处理」，再看是否算进利润、是否只看余额
  const rowStatus = (entry: any) => entry.monitor?.status === "review_required" || entry.reconciliation?.status === "review_required" ? NEEDS_ACTION
    : entry.reconciliation?.status === "configured" ? ACCOUNTED : entry.monitor?.status === "linked" ? MONITOR_ONLY : UNLINKED;
  // 保存结果里一组的两种用途
  const purposeLine = (group: BatchResult["groups"][number]) => [
    group.monitor.status !== "not_requested" ? `${ONBOARDING_PURPOSES.monitor}：${MONITOR_RESULT[group.monitor.status] || COPY.pending}` : "",
    group.reconciliation.status !== "not_requested" ? `${ONBOARDING_PURPOSES.billing}：${BILLING_RESULT[group.reconciliation.status] || COPY.pending}` : "",
  ].filter(Boolean).join("；");
  const savedLine = (group: BatchResult["groups"][number]) => {
    const rule = group.saved.ruleId ? (catalogue?.rules || []).find((item: any) => item.id === group.saved.ruleId) : null;
    return `${COPY.upstream}：${group.saved.stationIds.map(stationName).join("、") || EMPTY}${group.saved.authorizationStationId ? `；${COPY.loginInfo}：${stationName(group.saved.authorizationStationId)}` : ""}${group.saved.ruleId ? `；${COPY.binding}：${rule ? reconciliationKeyName(rule) : COPY.saved}` : ""}`;
  };
  const allVerified = !!probe && probe.selections.every((selection) => selection.monitor.status === "verified");
  return <>
    {workflowError ? <ProblemAlert problem={workflowError} type="warning" style={{ marginBottom: 16 }} extra={<><Button onClick={() => window.location.reload()}>{REFRESH}</Button><Button href="/stations">{COPY.back}</Button></>} /> : null}
    {destination?.action === "source" && !workflowError ? <section aria-label={REVIEW_SOURCE} style={{ marginBottom: 16, overflowWrap: "anywhere" }}><Alert type={stale ? "warning" : "info"} showIcon title={stale ? staleText(catalogue?.syncedAt, !!syncFailure, catalogue?.tz) : SOURCE.title} description={<div><div>{COPY.ownStation}：{source ? `${catalogue?.ownStation?.name || EMPTY} · ${source.baseUrl}` : EMPTY}</div><div>{COPY.channels}：{names(channels.map((channel) => channel.id))}</div><Text type="secondary">{SOURCE.detail}</Text><ErrorDetail raw={syncDescribed?.raw} /></div>} action={refreshButton} /></section> : null}
    <Collapse style={{ marginBottom: 16 }} defaultActiveKey={["connections"]} items={[{ key: "connections", label: `${STATION_TABS.onboarding} · ${channels.length}`, extra: <Button aria-label={REFRESH} style={{ minHeight: 40 }} size="small" loading={refreshing} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void load(true); }}>{REFRESH}</Button>, children: <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Text type="secondary">{COPY.intro}</Text>
      {stale && catalogue ? (catalogue.ownStation ? <Alert type="warning" showIcon title={staleText(catalogue.syncedAt, !!syncFailure, catalogue.tz)} description={<div>{syncDescribed ? <div>{syncDescribed.text}</div> : null}<div>{COPY.refreshFirst}</div><ErrorDetail raw={syncDescribed?.raw} /></div>} action={refreshButton} /> : null)
        : directoryError ? <Alert type="error" showIcon title={failureText(BINDING_COPY.channelsUnreadable, directoryError)} description={<ErrorDetail raw={syncDescribed?.raw} />} action={refreshButton} /> : null}
      {catalogue?.syncedAt && !stale ? <Text type="secondary">{formatAsOf(catalogue.syncedAt, catalogue.tz)}</Text> : null}
      <div className="page-toolbar" style={{ width: "100%" }}><Input aria-label={COPY.search} placeholder={COPY.searchPlaceholder} allowClear value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: "1 1 200px", minWidth: 0 }} /><Select aria-label={COPY.statusFilter} value={status} onChange={setStatus} style={{ minWidth: 130 }} options={[{ value: "all", label: COPY.allChannels }, { value: "attention", label: NEEDS_ACTION }, { value: "unlinked", label: COPY.unmatched }, { value: "configured", label: ACCOUNTED }]} /><Button disabled={busy || refreshing || stale || !selectedIds.length} style={{ minHeight: 44 }} onClick={() => open(selectedIds)}>{selectedIds.length ? `${CONNECT.label}（${selectedIds.length} 个渠道）` : CONNECT.label}</Button>{pendingRecovery ? <Button style={{ minHeight: 44 }} loading={recovering} disabled={!catalogue || busy} onClick={() => void recover(pendingRecovery, true)}>{COPY.resume}</Button> : null}</div>
      {filtered.length ? <Checkbox checked={filtered.every((entry) => selectedIds.includes(entry.id))} indeterminate={filtered.some((entry) => selectedIds.includes(entry.id)) && !filtered.every((entry) => selectedIds.includes(entry.id))} disabled={stale || busy} onChange={(event) => setSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...filtered.map((entry) => entry.id)])].slice(0, 100) : selectedIds.filter((id) => !filtered.some((entry) => entry.id === id)))}>{COPY.selectFiltered}</Checkbox> : null}
      <List loading={refreshing && !catalogue} dataSource={filtered} locale={{ emptyText: unset ? <Space direction="vertical"><Text>{OWN_STATION_UNSET}</Text><Button href={SETUP.href!}>{SETUP.label}</Button></Space>
        : stale && !channels.length ? <Space direction="vertical"><Text>{BINDING_COPY.channelsUnreadable}</Text>{refreshButton}</Space> : channels.length ? COPY.noMatch : COPY.noChannels }} pagination={filtered.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false} renderItem={(entry: any) => {
        const name = reconciliationChannelName(entry);
        const tag = reconciliationChannelTag(entry);
        const action = entry.monitor?.status === "linked" ? EDIT : CONNECT.label;
        return <List.Item style={{ display: "flex", flexWrap: "wrap", gap: 12 }}><Checkbox aria-label={COPY.selectChannel(name)} disabled={stale || busy} checked={selectedIds.includes(entry.id)} onChange={(event) => setSelectedIds(event.target.checked ? [...selectedIds, entry.id].slice(0, 100) : selectedIds.filter((id) => id !== entry.id))} /><div style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}><Space wrap><Text strong>{name}</Text>{tag ? <Tag>{tag}</Tag> : null}</Space><div><Text type="secondary">{COPY.group}：{entry.groups?.join("、") || EMPTY}</Text></div><div><Text type="secondary">{entry.baseUrl || COPY.noBaseUrl}</Text></div><Text>{rowStatus(entry)}</Text></div><Button style={{ minHeight: 44 }} disabled={refreshing || stale || busy} onClick={() => open([entry.id])} aria-label={`${action}「${name}」`}>{action}</Button></List.Item>;
      }} />
    </Space> }]} />
    <Drawer title={CONNECT.label} aria-label={CONNECT.label} open={openIds.length > 0} width={compact ? "100%" : 600} closable={!busy} maskClosable={!busy} keyboard={false} onClose={closeDrawer} extra={<Button style={{ minHeight: 44 }} type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>{result ? COPY.finish : COPY.confirm}</Button>}>
      <Space direction="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
        <Alert type="info" showIcon title={COPY.selected(openIds.length)} description={<Space direction="vertical"><Text>{names(openIds)}</Text><Text>{COPY.prefilled}</Text>{openIds.map((id) => <Text key={id}>{names([id])} · {COPY.group} {channels.find((entry) => entry.id === id)?.groups?.join("、") || EMPTY}</Text>)}</Space>} />
        {stale ? <Alert type="warning" showIcon title={ERROR_CATEGORIES.expired.text} action={refreshButton} /> : null}{failure ? <ProblemAlert problem={failure} /> : null}
        {result ? <Alert type={result.complete ? "success" : "warning"} showIcon title={result.complete ? (billing ? CONNECT.done : COPY.saved) : COPY.partial} description={<Space direction="vertical">{result.groups.map((group) => {
          const reason = group.reason || group.reconciliation.reason;
          return <div key={group.groupId}><Text strong>{names(group.channels.map((entry) => entry.channelId))} · {group.complete ? COPY.saved : COPY.pending}</Text><div>{purposeLine(group)}</div>{reason || group.code ? <div>{describeError({ code: group.code, reason }).text}<ErrorDetail raw={reason} /></div> : null}<div>{savedLine(group)}</div>{group.channels.filter((entry) => !entry.complete).map((entry) => <div key={entry.channelId}>{names([entry.channelId])}：{entry.reason || entry.code ? describeError({ code: entry.code, reason: entry.reason }).text : ERROR_CATEGORIES.changed.text}<ErrorDetail raw={entry.reason} /></div>)}{group.remainingActions.length ? <Text type="secondary">{COPY.nextStep}：{group.remainingActions.includes("supply_credentials") ? COPY.supplyCredentials : group.remainingActions.includes("select_key") ? describeError({ code: "KEY_REQUIRED" }).text : ERROR_CATEGORIES.changed.text}</Text> : null}</div>;
        })}{retryInput ? <Button disabled={busy} onClick={() => void recover(retryInput)}>{COPY.viewSaved}</Button> : null}</Space>} /> : null}
        {coverageRule ? <Alert type="info" showIcon title={COVERAGE_QUESTION} description={<div><div>{FIELDS.apiKey.label}：{reconciliationKeyName(coverageRule)} · {COPY.channels}：{names((coverageRule.channels || []).map((channel: any) => Number(channel.channelId)))}</div><div>{COVERAGE.detail}</div><Space wrap><Button href={workflowAction("edit_binding", { ruleId: coverageRule.id }).href!}>{EDIT}</Button><Button disabled={busy} onClick={() => stopForNewKey(coverageRule)}>{SWAP}</Button></Space></div>} /> : null}
        <Radio.Group aria-label={COPY.pickUpstream} value={creating ? "authorize" : "saved"} disabled={busy || !!coverageRule} onChange={(event) => { setCreating(event.target.value === "authorize"); invalidate(true); }}>
          <Space direction="vertical">
            <Radio value="saved" disabled={!upstreams.length} style={{ minHeight: 40 }}>{COPY.useSaved}</Radio>
            <Radio value="authorize" style={{ minHeight: 40 }}>{COPY.addOrUpdate}</Radio>
          </Space>
        </Radio.Group>
        {creating ? <Alert type="info" showIcon title={COPY.whenTitle} description={<div><div>{COPY.whenFirst}</div><div>{COPY.whenUpdate}</div><div>{COPY.whenSaved}</div></div>} /> : <Text type="secondary">{COPY.savedHint}</Text>}
        {creating ? <Form name="channel-onboarding" form={form} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, form)}><ConnectionFields type={formType} nameLabel={FIELDS.name.label} types={TYPES} /></Form> : <div><Text strong>{COPY.upstream}</Text><Select<string> aria-label={COPY.upstream} style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="searchText" value={stationId} disabled={busy || !!coverageRule} placeholder={COPY.upstreamPlaceholder} options={resourceOptions} optionRender={(option) => <div style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}><div>{option.label}</div><Text type="secondary">{option.data.baseUrl}</Text></div>} onChange={(id) => { setStationId(id); setAuthorizationId("self"); setMonitor(upstreams.find((item) => item.id === id)?.monitorEnabled !== false); invalidate(true); }} />{main ? <Text type="secondary">{COPY.selectedHint(main.name)}</Text> : <Text type="secondary">{COPY.pickHint}</Text>}</div>}
        <Checkbox checked={monitor} disabled={busy || !creating && main?.monitorEnabled === false || (creating ? formType : main?.type) === "newapi-key"} onChange={(event) => { setMonitor(event.target.checked); invalidate(); }}>{ONBOARDING_PURPOSES.monitor}</Checkbox>{!monitor && billing ? <Text type="secondary">{COPY.monitorOnlyNote}</Text> : null}
        <Collapse size="small" items={[{ key: "extra", label: COPY.extraMonitors, children: <Select aria-label={COPY.extraAria} mode="multiple" style={{ width: "100%" }} value={additionalIds} disabled={busy} options={upstreams.filter((item) => item.monitorEnabled !== false && item.id !== stationId).map((item) => ({ value: item.id, label: item.name }))} onChange={(ids) => { setAdditionalIds(ids); invalidate(); }} /> }]} />
        {additionalIds.length ? <Alert type="warning" showIcon title={COPY.doubleCost} /> : null}
        <Checkbox checked={billing} disabled={busy} onChange={(event) => { setBilling(event.target.checked); if (requiresAuthorization) setAuthorizationId(upstreams.find((item) => item.type !== "newapi-key")?.id || "new"); invalidate(true); }}>{COPY.billingCheckbox}</Checkbox>
        {!purposeSelected ? <Alert type="warning" showIcon title={ONBOARDING_PURPOSE_REQUIRED} description={COPY.noKeyNeeded} /> : null}
        {billing && groups.has("pending") ? <Text type="secondary">{COPY.noKeyNeeded}</Text> : null}
        {billing ? <>
          {requiresAuthorization ? <div><Text strong>{FIELDS.accessToken.label}</Text><Select aria-label={FIELDS.accessToken.label} style={{ width: "100%", marginTop: 8 }} value={authorizationId} disabled={busy} options={[...upstreams.filter((item) => item.type !== "newapi-key").map((item) => ({ value: item.id, label: stationLabel(item) })), { value: "new", label: UPDATE_AUTH }]} onChange={(id) => { setAuthorizationId(id); invalidate(true); }} /></div> : <Text type="secondary">{COPY.authHint}</Text>}
          {authorizationId === "new" ? <><Alert type="info" showIcon title={COPY.authOnceTitle} description={COPY.authOnce} /><Form name="channel-onboarding-authorization" form={authorizationForm} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, authorizationForm)}><ConnectionFields type={authorizationType} nameLabel={FIELDS.authorizationName.label} types={TYPES.filter((type) => type.value !== "newapi-key")} /></Form></> : null}
          <div><Text strong>{COPY.keysTitle}</Text><Select aria-label={FIELDS.apiKey.label} style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={tokenId} disabled={busy || !keys.length || splitKeys || !!coverageRule} placeholder={COPY.keyPlaceholder} options={keyOptions} onChange={(id) => { setTokenId(id); invalidate(); }} /></div>
          {openIds.length > 1 ? <Checkbox checked={splitKeys} disabled={busy || !!coverageRule} onChange={(event) => { setSplitKeys(event.target.checked); setChannelKeys(Object.fromEntries(openIds.map((id) => [id, tokenId]))); invalidate(); }}>{COPY.splitKeys}</Checkbox> : null}
          {splitKeys ? openIds.map((id) => <div key={id}><Text>{names([id])}</Text><Select aria-label={COPY.channelKey(names([id]))} style={{ width: "100%", marginTop: 4 }} value={channelKeys[id]} disabled={busy || !keys.length} options={keyOptions} placeholder={COPY.chooseKey} onChange={(value) => { setChannelKeys((previous) => ({ ...previous, [id]: value })); invalidate(); }} /></div>) : null}
          {[...groups].map(([key]) => {
            const verified = probe?.groups.find((group) => group.basis.tokenId === Number(key));
            if (!verified) return <Text key={key} type="secondary">{key === "pending" ? COPY.testFirst : COPY.keySelected}</Text>;
            const union = verified.basis.proposedChannelIds;
            const declaration = coverage[key] || unknownCoverage();
            const answer = coverageAnswerOption(declaration)?.value;
            // 「这把 Key 还给别处用吗？」只问一次，五个回答和改绑定共用 COVERAGE_ANSWERS
            return <div key={key}><Text strong>{keyName(Number(key))}</Text><div><Text>{COPY.allBound}：{names(union)}</Text></div><Text>{COVERAGE_QUESTION}</Text><Select aria-label={groups.size === 1 ? COVERAGE_QUESTION : `${keyName(Number(key))} · ${COVERAGE_QUESTION}`} style={{ width: "100%", marginTop: 8 }} value={answer} disabled={busy} options={COVERAGE_ANSWERS.map(({ value, label }) => ({ value, label }))} onChange={(value) => { setCoverage((previous) => ({ ...previous, [key]: coverageDeclarationOf(value, declaration.uncoveredOwnChannelIds) as CoverageDeclaration })); invalidate(); }} />{answer === "own_channels" ? <><Text>{BINDING_COPY.uncoveredChannels}</Text><Select aria-label={BINDING_COPY.uncoveredChannels} mode="multiple" style={{ width: "100%", marginTop: 8 }} value={declaration.uncoveredOwnChannelIds} disabled={busy} options={channels.filter((entry) => !union.includes(entry.id)).map((entry) => ({ value: entry.id, label: reconciliationChannelName(entry) }))} onChange={(ids) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, uncoveredOwnChannelIds: ids } })); invalidate(); }} /></> : null}{answer !== "none" ? <Text type="secondary">{COVERAGE.detail}</Text> : null}</div>;
          })}
        </> : <Text type="secondary">{COPY.monitorOnlyKey}</Text>}
        <Button style={{ minHeight: 44 }} loading={probing} disabled={!purposeSelected || saving || recovering || stale || coverageSourceChanged || (!creating && !stationId)} onClick={() => void verify()}>{TEST_READ}</Button>
        {probe ? <><Alert type={allVerified ? "success" : "warning"} showIcon title={allVerified ? `${testReadText({ ok: true, bill: false })}，${COPY.notSaved}` : COPY.pending} description={probe.selections.some((selection) => selection.monitor.reason) ? <div>{probe.selections.filter((selection) => selection.monitor.reason).map((selection) => <div key={selection.selectionId}>{testReadText({ ok: false, reason: describeError(selection.monitor).text })}<ErrorDetail raw={selection.monitor.reason} /></div>)}</div> : COPY.notSavedYet} />{probe.selections.some((selection) => selection.credentialUpdateRequired) ? <Checkbox checked={updateCredentials} disabled={busy} onChange={(event) => { setUpdateCredentials(event.target.checked); invalidate(); }}>{COPY.updateExisting}</Checkbox> : null}{billing ? probe.groups.map((group) => {
          const zone = formatDayZone(group.basis.timezone);
          const start = group.preview.scopeChanged ? COPY.startsNow
            : `${group.preview.billingEffectiveFromMs != null ? reconciliationChannelStatus("not_effective", { start: formatZonedDateTime(group.preview.billingEffectiveFromMs, group.basis.timezone) }).label : COPY.unverified}${zone ? `（${zone}）` : ""}`;
          return <Alert key={group.groupId} type="info" showIcon title={group.code === "KEY_REQUIRED" ? COPY.noKey : group.basis.existingRuleId ? COPY.joinExisting : PREVIEW_STATE[group.status] || BINDING_COPY.preview} description={<Space direction="vertical">{group.reason || group.code ? <div><Text>{describeError({ code: group.code, reason: group.reason }).text}</Text><ErrorDetail raw={group.reason} /></div> : null}<Text>{COPY.ownStation}：{catalogue?.ownStation?.name || EMPTY} · {group.basis.ownSource.baseUrl}</Text><Text>{COPY.upstreamAccount}：{group.basis.accountIdentity ? `${group.basis.accountIdentity.baseUrl} · ${COPY.account} ${group.basis.accountIdentity.accountId}` : EMPTY}</Text><Text>{COPY.existing}：{names(group.basis.existingChannelIds)}；{COPY.adding}：{names(group.requestedChannelIds)}</Text><Text>{COPY.allBound}：{names(group.basis.proposedChannelIds)}</Text><Text>{start}</Text><Text>{COPY.costOnce}{group.preview.costCoverage !== "complete" ? `；${COPY.coverageUnanswered}` : ""}</Text></Space>} />;
        }) : probe.groups.filter((group) => group.reason).map((group) => <Alert key={group.groupId} type="warning" showIcon title={COPY.pending} description={<div>{describeError({ code: group.code, reason: group.reason }).text}<ErrorDetail raw={group.reason} /></div>} />)}{!approved ? <Text type="warning">{ERROR_CATEGORIES.changed.text}</Text> : null}</> : null}
      </Space>
    </Drawer>
  </>;
}
