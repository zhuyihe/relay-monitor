"use client";
// 上游资源 · 渠道绑定：选自营站点的渠道，按「测试读取 → 预览 → 确认绑定」绑到上游账号和 Key
// （POST /api/channel-onboarding/batch/probe、/batch，没做完的用 /batch/recover 接着做）。
// 文案按 design/ui-copy-spec.md 写；报错按 §8.2 归类，原文只进「查看详细原因」。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Input, List, Radio, Select, Space, Tag, Typography } from "antd";
import { api } from "../../lib/client";
import { createRequestId } from "../../lib/request-id.js";
import { BINDING_COPY, CREDENTIAL_FIELDS as FIELDS, ONBOARDING_KEY_ONLY_MONITOR, credentialFieldOf, ONBOARDING_PURPOSES, ONBOARDING_PURPOSE_HINT, ONBOARDING_PURPOSE_REQUIRED, ONBOARDING_TYPES as TYPES, UPSTREAM_FORM_TEXT, groupOnboardingResources } from "../../lib/channel-onboarding.js";
import { onboardingKeyContext, onboardingMonitorIds, retainOnboardingRequest } from "../../lib/onboarding-workflow.js";
import type { AccountReadModel, BatchInput, BatchProbe, BatchRecoveryIntent, BatchResult, ConnectionInput, CoverageDeclaration, SourceCatalogueProjection, UpstreamKeyRead, WorkflowDestination } from "../../lib/client";
import { NAV_LABELS, STATION_TABS } from "../../lib/brand";
import { ERROR_CATEGORIES, describeError, failureText, requiredRule } from "../../lib/error-copy.js";
import { EMPTY, OWN_STATION_UNSET, UPSTREAM_GONE, formatAsOf, formatDayZone, formatZonedDateTime, refreshFailedText } from "../../lib/format";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, coverageAnswerOption, coverageDeclarationOf, reconciliationChannelStatus, reconciliationIssue } from "../../lib/reconciliation-contract.js";
import { reconciliationChannelName, reconciliationChannelTag, reconciliationKeyNamer } from "../../lib/reconciliation-view.js";
import { DESTINATION_CHANGED, HISTORY_KEPT, testReadText, workflowAction, workflowActionMeta } from "../../lib/workflow-actions.js";
import { useAccountAuthorization } from "./account-authorization";
import { useDrawerEscape } from "./drawer-escape";
import { ErrorDetail, noteOf, notice, type ErrorNote } from "./error-detail";

const { Text } = Typography;

// 按钮名和完成提示（§3.5，lib/workflow-actions.js）
const CONNECT = workflowActionMeta("connect_channels")!;
const EDIT = workflowActionMeta("edit_binding")!.label;
const REFRESH = workflowActionMeta("refresh")!.label;
const SWAP = workflowActionMeta("swap_key")!.label;
const REVIEW_SOURCE = workflowActionMeta("review_source")!.label;
const UPDATE_AUTH = workflowActionMeta("update_authorization")!.label;
const TEST_READ = workflowActionMeta("verify_identity")!.label;
const RESUME = workflowActionMeta("resume_monitor")!;
const SETUP = workflowAction("setup_own_station");
// 要人动手的问题（§5.2，lib/reconciliation-contract.js）
const SOURCE = reconciliationIssue("SOURCE_BINDING_UNCONFIRMED");
const KEY_DENIED = reconciliationIssue("KEY_INVALID_OR_DENIED");
const COVERAGE = reconciliationIssue("COST_COVERAGE_UNKNOWN");
const OWNER = reconciliationIssue("COST_OWNER_UNVERIFIED");
// 渠道列表里的状态（§5.6）
const channelStatusLabel = (key: string) => reconciliationChannelStatus(key).label;
const BOUND = channelStatusLabel("bound");
const UNLINKED = channelStatusLabel("unlinked");
const NEEDS_ACTION = channelStatusLabel("source_unverified");
const MONITOR_ONLY = channelStatusLabel("monitor_only");
// 这里读取绑定配置，不读取某一天的财务结果；绑定成功不代表账单已完整计入利润。
const ROW_STATES = Object.freeze({ attention: NEEDS_ACTION, unlinked: UNLINKED, monitor: MONITOR_ONLY, configured: BOUND });
const rowState = (entry: any): keyof typeof ROW_STATES => entry.monitor?.status === "review_required" || entry.reconciliation?.status === "review_required" ? "attention"
  : entry.reconciliation?.status === "configured" ? "configured" : entry.monitor?.status === "linked" ? "monitor" : "unlinked";
const UNSUPPORTED = channelStatusLabel("unsupported");


// 渠道绑定独有的话，只在这一处写；用语按 design/ui-copy-spec.md
const CONFIRM = "确认绑定";
const COPY = Object.freeze({
  intro: "自营站点的渠道和分组自动带入，每 5 分钟刷新一次。选好渠道，绑定到同一把 Key。",
  confirm: CONFIRM,
  finish: "接着做完",
  close: "完成",
  back: "返回",
  cancel: "取消",
  pending: "还没做完",
  ready: "可以绑定",
  unverified: "还没测试读取",
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
  selectFiltered: "选中筛出来的渠道（最多 100 个）",
  selectChannel: (name: string) => `选择「${name}」`,
  selected: (count: number) => `已选 ${count} 个渠道`,
  // 抽屉顶部：这些渠道现在绑了什么
  current: "现在的设置",
  currentKeep: " · 不改的部分保持不变",
  channels: "渠道",
  group: "分组",
  upstreamAccount: "上游账号",
  account: "账号",
  existing: "已绑定",
  adding: "这次加",
  allBound: "绑定后这把 Key 的渠道",
  upstream: "上游",
  loginInfo: "登录信息",
  binding: "绑定",
  nextStep: "下一步",
  partial: "还有几步没做完，做完的会保留",
  viewSaved: "查看保存结果",
  supplyCredentials: "登录信息还没保存，请重新填一次",
  swapNotice: `站外也在用的话，先在上游给站外单开一把 Key。换成新 Key 后，旧 Key ${HISTORY_KEPT}。`,
  // 看余额的上游怎么改：不改、加上游、换上游、去掉上游
  monitorHeading: "看余额的上游",
  monitorModeAria: "看余额怎么改",
  modes: Object.freeze({ keep: "不改", add: "加上游", replace: "换上游", remove: "去掉上游" }),
  replaceRequired: "先选要换成的上游；只想去掉的话，选「去掉上游」。",
  replaceNote: "只改这次选的渠道。原来的上游会在预览里列为「去掉」；算利润的绑定不变。",
  removeAria: "选要去掉的上游",
  removeLabel: (name: string) => `去掉「${name}」`,
  // 选上游：用已保存的，或者新增一个
  useSaved: "用已有上游",
  newUpstream: UPSTREAM_FORM_TEXT.create,
  createHint: "保存后，别的渠道也能直接用这个上游。",
  savedLogin: "用已保存的登录信息",
  matchHint: "地址对得上不一定是同一个账号，请选实际用的那个。",
  upstreamPlaceholder: "按名称或地址找上游",
  matchedGroup: (count: number) => `地址对得上的上游（${count}）`,
  otherGroup: (count: number) => `其他上游（${count}）`,
  pausedHint: "这个上游暂停了监控，恢复后就能看余额。",
  resumeNote: "恢复后接着看这个上游的余额，原来的提醒和成本设置不变。",
  extraMonitors: "同时看其他上游的余额（可选）",
  extraAria: "其他上游",
  doubleCost: `同一个上游账号的余额和 Key 额度可能是同一笔花费，绑定只算一次上游成本；${NAV_LABELS.analytics}里要不要算两次，请到上游设置看「算进利润」开关。`,
  billingCheckbox: `同时${ONBOARDING_PURPOSES.billing}（绑定 Key）`,
  noKeyNeeded: "只看余额时，不用选 Key",
  authHint: `用这个上游账号的访问令牌读账单和 Key；读不到时点「${UPDATE_AUTH}」。`,
  // New API Key 类型的上游：读账单要用它所属的上游账号
  keyAccount: "这把 Key 属于哪个上游账号",
  keyAccountRequired: "请选这把 Key 属于哪个上游账号",
  keyAccountPlaceholder: "选实际的上游账号，地址对得上只是提示",
  newAuthorization: "填一个新的访问令牌",
  accountUnverified: "还没确认这个上游是哪个账号",
  accountsUnreadable: "读不到上游账号",
  authOnceTitle: "访问令牌只填一次",
  authOnce: "只用来读账单，不会多出余额提醒或成本。",
  keysTitle: "这些渠道用的 Key",
  keysLoading: "正在读这个账号的 Key…",
  keysUnreadable: "读不到这个账号的 Key",
  noKeys: "这个账号里还没有能用的 Key，请先在上游建一把。",
  keyPlaceholder: "选这些渠道实际用的 Key，同一把只选一次",
  keyPlaceholderNew: "填好访问令牌后，先测试读取",
  keyDisabled: "已停用",
  keyCrossGroup: "会跨分组调用，不能绑定",
  splitKeys: "这些渠道用的 Key 不一样，分别选",
  channelKey: (name: string) => `「${name}」的 Key`,
  chooseKey: "选择 Key",
  // 测试读取之后
  scopeChanged: "这把 Key 绑定的渠道有变化，请看一下下面列出的渠道，再测试读取一次。",
  credentialTitle: Object.freeze({ primary: "这个上游账号已经保存过", authorization: "读账单用的上游账号已经保存过" }),
  credentialPrimary: "可以直接用已保存的登录信息，或者用这次填的更新它。",
  credentialAuthorization: (name: string) => `读账单用的是「${name}」。可以直接用它，或者用这次填的更新它；Key 和用途不变。`,
  reuseSaved: "用已保存的",
  changeAria: (name: string) => `「${name}」看余额的变化`,
  unchanged: "不变",
  added: "加上",
  removed: "去掉",
  newUpstreamName: (name: string) => `新上游「${name}」`,
  details: "自营站点和分组",
  notSaved: "还没保存",
  notSavedYet: `看一下这次的改动，点上方「${CONFIRM}」后才保存。`,
  noKey: "还没绑定 Key",
  joinExisting: "加到已有绑定",
  startsNow: "从现在开始算利润，今天就能看到；过了零点自动固定。",
  costOnce: "同一把 Key 的上游成本只算一次",
  coverageUnanswered: `回答「${COVERAGE_QUESTION}」之前，利润先不算`,
});
// 保存结果里两种用途各自的状态（§5.6）；没要的用途不显示
const MONITOR_RESULT: Record<string, string> = { linked: BINDING_COPY.saved, pending: COPY.pending, unavailable: COPY.pending };
const BILLING_RESULT: Record<string, string> = { configured: BOUND, unverified: COPY.unverified, unsupported: UNSUPPORTED, unavailable: UNSUPPORTED, pending: COPY.pending };
// 测试读取后每把 Key 的预览标题
const PREVIEW_STATE: Record<string, string> = { ready: COPY.ready, monitor_only: MONITOR_ONLY, unverified: COPY.unverified, unsupported: UNSUPPORTED, unavailable: UNSUPPORTED };

// 每类要填的登录信息取类型表的 needs
const CREDENTIALS: Record<string, readonly string[]> = Object.fromEntries(TYPES.map((item) => [item.value, item.needs]));
const RECOVERY_KEY = "channel-onboarding-recovery-v05";
const PENDING_KEY = "channel-onboarding-pending-v06";
type CredentialUpdateTarget = BatchProbe["selections"][number]["credentialUpdates"][number];
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
  return `${station.name}${station.identity?.accountId ? ` · ${COPY.account} ${station.identity.accountId}` : ""}${station.monitorEnabled === false ? ` · ${BINDING_COPY.monitorPaused}` : ""}`;
}
// 渠道列表多久没更新（§8.1）：从来没读到写「读不到」，刷新失败写「刷新失败，数据截至」，否则写隔了多久
function staleText(syncedAt: unknown, failed: boolean, tz?: string, now = Date.now()) {
  if (!syncedAt) return BINDING_COPY.channelsUnreadable;
  if (failed) return refreshFailedText(syncedAt, tz);
  const minutes = Math.max(1, Math.floor((now - new Date(syncedAt as any).getTime()) / 60000));
  return COPY.notUpdated(syncedAt, minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`, tz);
}
function CredentialFields({ type }: { type: string }) {
  const token = credentialFieldOf(type, "accessToken");
  return <>
    {type === "newapi" || type === "sub2api" ? <Form.Item name="accessToken" label={token.label} extra={token.hint} rules={[requiredRule(token.label)]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "newapi" ? <Form.Item name="userId" label={FIELDS.userId.label} extra={FIELDS.userId.hint}><Input /></Form.Item> : null}
    {type === "newapi-key" ? <Form.Item name="apiKey" label={FIELDS.apiKey.label} extra={FIELDS.apiKey.hint} rules={[requiredRule(FIELDS.apiKey.label)]}><Input.Password autoComplete="off" /></Form.Item> : null}
    {type === "sub2api-password" ? <><Form.Item name="email" label={FIELDS.email.label} rules={[requiredRule(FIELDS.email.label)]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label={FIELDS.password.label} extra={FIELDS.password.hint} rules={[requiredRule(FIELDS.password.label)]}><Input.Password autoComplete="current-password" /></Form.Item></> : null}
  </>;
}
// 新增上游和补访问令牌共用的填写项：类型、名称、站点地址和登录信息
function ConnectionFields({ type, nameLabel, types }: { type: string; nameLabel: string; types: typeof TYPES }) {
  return <>
    <Form.Item name="type" label={FIELDS.type.label} extra={TYPES.find((item) => item.value === type)?.hint}><Select options={types.map(({ value, label }) => ({ value, label }))} /></Form.Item>
    <Form.Item name="name" label={nameLabel} rules={[requiredRule(nameLabel)]}><Input /></Form.Item>
    <Form.Item name="baseUrl" label={FIELDS.baseUrl.label} extra={FIELDS.baseUrl.hint} rules={[requiredRule(FIELDS.baseUrl.label)]}><Input /></Form.Item>
    <CredentialFields type={type} />
  </>;
}

// 界面上的一条报错或提示（ErrorNote）：再加 detail 补充说明，action 下一步按钮；给了 onClose 就能关掉
type Problem = ErrorNote & { detail?: string; action?: { label: string; href: string } | null };
function ProblemAlert({ problem, type = "error", extra, style, onClose }: { problem: Problem; type?: "error" | "warning"; extra?: ReactNode; style?: CSSProperties; onClose?: () => void }) {
  const description = problem.detail || problem.raw ? <div>{problem.detail ? <div>{problem.detail}</div> : null}<ErrorDetail raw={problem.raw} /></div> : undefined;
  const action = problem.action || extra ? <Space wrap>{problem.action ? <Button href={problem.action.href}>{problem.action.label}</Button> : null}{extra}</Space> : undefined;
  return <Alert type={type} showIcon title={problem.text} description={description} action={action} closable={onClose ? { onClose } : undefined} style={style} />;
}

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
  const [failure, setFailure] = useState<Problem | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [retryInput, setRetryInput] = useState<BatchRecoveryIntent | null>(null);
  const [pendingRequests, setPendingRequests] = useState<BatchRecoveryIntent[]>([]);
  const [accountModel, setAccountModel] = useState<AccountReadModel | null>(null);
  const [accountsError, setAccountsError] = useState<Problem | null>(null);
  const [keyRead, setKeyRead] = useState<UpstreamKeyRead | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState<Problem | null>(null);
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
  const authorizationOrigin = useRef<{ id: string; adoptTarget?: CredentialUpdateTarget["role"] } | null>(null);
  const discoveryInFlight = useRef(false);
  const stale = !catalogue || catalogue.stale || !!directoryError;
  const unset = !!catalogue && !catalogue.ownStation;
  // 这次刷新失败的原因：本页读取抛错，或接口记下的上次刷新错误
  const syncFailure = directoryError || (catalogue?.error ? { code: catalogue.errorCode, reason: catalogue.error } : null);
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
    { label: COPY.matchedGroup(resourceGroups.matched.length), options: resourceGroups.matched.map(resourceOption) },
    { label: COPY.otherGroup(resourceGroups.others.length), options: resourceGroups.others.map(resourceOption) },
  ].filter((group) => group.options.length);
  const billingCandidates = groupOnboardingResources(upstreams.filter((item) => item.type !== "newapi-key"), [{ baseUrl: creating ? form.getFieldValue("baseUrl") : main?.baseUrl }]);
  const source: SourceCatalogueProjection["ownSource"] = catalogue?.ownSource || null;
  const coverageSourceChanged = !!(coverageRule?.ownSource && source && coverageRule.ownSource.namespaceKey !== source.namespaceKey);
  const names = (ids: number[]) => ids.map((id) => reconciliationChannelName(channels.find((entry) => entry.id === id) || { id })).join("、") || EMPTY;
  // 上游的名字：已经删掉的写「已删除的上游」；保存结果里还没读到的写「已保存」
  const resourceNames = (ids: string[], fallback: string = UPSTREAM_GONE) => ids.map((id) => upstreams.find((item) => item.id === id)?.name || fallback).join("、") || EMPTY;
  const keys = keyRead?.tokens || probe?.selections.flatMap((selection) => selection.tokens) || [];
  const keyRefs = keys.map((key) => ({ tokenName: key.name, tokenId: key.id }));
  // 这一页的 Key 名：读到的 Key 和已有的绑定放在一起比，同名的都加上编号（§3.1）
  const pageKeyName = reconciliationKeyNamer([...keyRefs, ...(catalogue?.rules || [])]);
  const keyName = (id: number) => pageKeyName({ tokenName: keys.find((item) => item.id === id)?.name, tokenId: id });
  const keyOptions = [...new Map(keys.map((key) => [key.id, key])).values()].map((key) => ({ value: key.id, disabled: key.status !== 1 || key.crossGroupRetry || key.group === "auto", label: `${keyName(key.id)} · ${COPY.group} ${key.group || EMPTY}${key.status !== 1 ? ` · ${COPY.keyDisabled}` : key.crossGroupRetry || key.group === "auto" ? ` · ${COPY.keyCrossGroup}` : ""}` }));
  const groups = new Map<string, number[]>();
  for (const id of openIds) { const key = billing ? String((splitKeys ? channelKeys[id] : tokenId) || "pending") : "monitor"; groups.set(key, [...(groups.get(key) || []), id]); }
  const filtered = channels.filter((entry) => (status === "all" || rowState(entry) === status) && `${entry.name} ${entry.id} ${entry.baseUrl} ${(entry.groups || []).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  // 报错的下一步按钮（§8.2）：去设置自营站点，或给已选的上游更新登录信息；别的类在原处改了再试
  const errorAction = (kind: string | null) => {
    if (kind === "setup_own_station") return { label: SETUP.label, href: SETUP.href! };
    if (kind === "update_authorization" && !creating && stationId) return { label: UPDATE_AUTH, href: workflowAction("update_authorization", { stationId }).href! };
    return null;
  };
  const problemOf = (err: any, wrap?: (text: string) => string): Problem => {
    const note = noteOf(err);
    if (note.notice) return note;
    return { ...note, text: wrap ? wrap(note.text) : note.text, action: errorAction(describeError(err).action) };
  };
  const sourceProblem = (ownStationId: string | undefined): Problem => ({ text: SOURCE.title, detail: SOURCE.detail,
    action: { label: REVIEW_SOURCE, href: workflowAction("review_source", { ownStationId }).href! } });
  const invalidate = (credentials = false) => {
    generation.current += 1; setApproved(false); setFailure(null);
    if (credentials) { keyGeneration.current += 1; setKeyRead(null); setKeyError(null); setKeyLoading(false); setProbe(null); setTokenId(coverageRule?.tokenId); setChannelKeys({}); setCoverage(coverageRule ? { [coverageRule.tokenId]: coverageRule.coverageDeclaration || unknownCoverage() } : {}); setKeyTimezones(coverageRule ? { [coverageRule.tokenId]: coverageRule.timezone } : {}); }
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
    try { const next: AccountReadModel = await request("/api/channel-onboarding/accounts"); if (current !== accountGeneration.current) return null; setAccountModel(next); setAccountsError(null); return next; }
    catch (err: any) { if (current === accountGeneration.current) setAccountsError({ ...noteOf(err), text: failureText(COPY.accountsUnreadable, err) }); return null; }
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
  const authorization = useAccountAuthorization({ compact, accountModel, stations: [...upstreams, ...(catalogue?.ownStation ? [{ ...catalogue.ownStation, isOwn: true }] : [])],
    disabled: openingAuthorization, onRecoveryError: setFailure,
    onComplete: async (next) => {
      generation.current += 1; keyGeneration.current += 1; setApproved(false); setProbe(null); setKeyRead(null);
      const origin = authorizationOrigin.current;
      if (origin && next.targets.some((target) => target.stationId === origin.id && ["updated", "already_updated"].includes(target.status))) {
        if (origin.adoptTarget === "primary") { setStationId(origin.id); setCreating(false); form.resetFields(); }
        else if (origin.adoptTarget === "authorization") { setAuthorizationId(origin.id); authorizationForm.resetFields(); }
      }
      setKeyReadVersion((version) => version + 1); await Promise.all([load(false), loadAccounts()]); await onComplete().catch(() => {});
    },
  });
  const busy = probing || saving || recovering || openingAuthorization || authorization.authorizationBusy;
  const updateAuthorization = async (id: string, options: { initialAuthorization?: any; adoptTarget?: CredentialUpdateTarget["role"] } = {}) => {
    setOpeningAuthorization(true); setFailure(null);
    try {
      const model = await loadAccounts();
      if (!model) return;
      const account = model.accounts.find((entry) => entry.resources.some((resource) => resource.id === id));
      if (!account) { setFailure({ text: COPY.accountUnverified, detail: OWNER.detail }); return; }
      authorizationOrigin.current = { id, adoptTarget: options.adoptTarget };
      authorization.openAuthorization(account, { defaultTargetIds: [id], initialAuthorization: options.initialAuthorization });
    } finally { setOpeningAuthorization(false); }
  };
  const reuseCredentialTarget = (target: CredentialUpdateTarget) => {
    if (target.role === "primary") { setStationId(target.stationId); setCreating(false); form.resetFields(); }
    else { setAuthorizationId(target.stationId); authorizationForm.resetFields(); }
    invalidate(); keyGeneration.current += 1; setKeyRead(null); setKeyError(null); setKeyLoading(false); setProbe(null); setKeyReadVersion((version) => version + 1);
  };
  useEffect(() => {
    if (!openIds.length || !billing || !billingResourceId) return;
    const current = ++keyGeneration.current;
    setKeyRead(null); setKeyLoading(true); setKeyError(null);
    void request(`/api/reconciliation/upstreams/${encodeURIComponent(billingResourceId)}/keys?force=true`).then((next: UpstreamKeyRead) => {
      if (current !== keyGeneration.current) return;
      if (next.capability?.reason === "KEY_METADATA_UNAVAILABLE") { setKeyError({ text: failureText(COPY.keysUnreadable, { code: "KEY_METADATA_UNAVAILABLE" }) }); return; }
      setKeyRead(next);
    }).catch((err: any) => { if (current === keyGeneration.current) setKeyError({ ...noteOf(err), text: failureText(COPY.keysUnreadable, err) }); })
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
    try { nextRequestId = createRequestId(); } catch (err: any) { message.error(failureText(COPY.openFailed, err)); return; }
    invalidate(true); setTokenId(undefined); setOpenIds(ids); setResult(null); setRetryInput(null); setRequestId(nextRequestId); setAdditionalIds([]); setBilling(false); setCoverage({}); setCoverageRule(null); setKeyTimezones({}); setSplitKeys(false); setAuthorizationId("self"); setRemovals({});
    const entries = ids.map((id) => channels.find((entry) => entry.id === id)).filter(Boolean);
    const candidates = entries.map((entry) => entry.monitor?.stationIds?.[0] || (entry.candidates?.length === 1 ? entry.candidates[0]?.id || entry.candidates[0] : undefined));
    const linked = candidates.map((id) => upstreams.find((item) => item.id === id));
    const sameAccount = linked[0]?.identity && linked.every((item) => item?.type !== "newapi-key" && item?.identity?.provider === linked[0].identity.provider && String(item?.identity?.accountId) === String(linked[0].identity.accountId) && item?.baseUrl === linked[0].baseUrl && item?.monitorEnabled === linked[0].monitorEnabled);
    const existing = upstreams.find((item) => candidates[0] && candidates.every((id) => id === candidates[0]) && item.id === candidates[0]) || (sameAccount ? linked[0] : undefined);
    const configured = entries.some((entry) => onboardingMonitorIds(entry).length || entry.reconciliation?.ruleIds?.length);
    setStationId(existing?.id); setCreating(!upstreams.length); setMonitorMode(configured ? "keep" : "add"); setMonitor(!configured && existing?.monitorEnabled !== false);
    form.resetFields(); form.setFieldsValue({ name: entries[0]?.name || COPY.upstreamAccount, baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
    authorizationForm.resetFields(); authorizationForm.setFieldsValue({ name: `${entries[0]?.name || COPY.upstream}${FIELDS.accessToken.label}`, baseUrl: entries[0]?.baseUrl || "", type: "newapi" });
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
    if (!model) return;
    if (!resource?.resourceVersion) { setFailure({ text: ERROR_CATEGORIES.expired.text }); return; }
    modal.confirm({ title: `${RESUME.label}「${resource.name}」？`, content: COPY.resumeNote, okText: RESUME.label, cancelText: COPY.cancel, onOk: async () => {
      try {
        await api(`/api/stations/${encodeURIComponent(id)}`, { method: "PUT", body: { monitorEnabled: true, expectedAuthVersion: resource.authVersion, expectedResourceVersion: resource.resourceVersion } });
      } catch (err: any) { setFailure(problemOf(err)); return; }
      message.success(RESUME.done); invalidate(); setMonitor(true); await Promise.all([load(false), loadAccounts()]); await onComplete().catch(() => {});
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
    setMonitor((current) => current && (nextCreating || main?.monitorEnabled !== false));
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
    setRecovering(true); setFailure(null);
    try {
      const next: BatchResult = await request("/api/channel-onboarding/batch/recover", intent);
      if (restore) {
        setCoverageRule(null);
        const selection = intent.selections[0]; setOpenIds(intent.groups.flatMap((group) => group.channels.map((entry) => entry.channelId))); setRequestId(intent.requestId); setStationId(selection.stationId || undefined); setCreating(!selection.linkOnly && (!selection.stationId || selection.credentialUpdateRequested)); setMonitor(selection.monitor); setAdditionalIds(selection.additionalMonitorStationIds); setBilling(intent.groups.some((group) => group.reconciliationRequested)); setAuthorizationId(selection.type === "newapi-key" ? selection.authorizationStationId || (upstreams.some((resource) => resource.type !== "newapi-key") ? "" : "new") : "self");
        const restoredRemovals = Object.fromEntries(intent.groups.flatMap((group) => group.channels.map((channel) => [channel.channelId, channel.removeMonitorStationIds || []])));
        setRemovals(restoredRemovals); setMonitorMode(selection.linkOnly ? "remove" : selection.monitor || selection.additionalMonitorStationIds.length ? "add" : "keep");
        setKeyRead(null); setKeyReadVersion((version) => version + 1);
        form.resetFields(); form.setFieldsValue({ type: selection.type, baseUrl: selection.baseUrl, name: COPY.upstreamAccount });
        authorizationForm.resetFields(); authorizationForm.setFieldsValue({ type: selection.authorizationIdentity?.provider === "sub2api" ? "sub2api" : "newapi", baseUrl: selection.authorizationIdentity?.baseUrl || selection.baseUrl || "", name: `${COPY.upstream}${FIELDS.accessToken.label}` });
        const byChannel: Record<number, number> = {}, declarations: Record<string, CoverageDeclaration> = {};
        const timezones: Record<string, string> = {};
        for (const group of intent.groups) if (group.reconciliation) { group.channels.forEach((entry) => { byChannel[entry.channelId] = group.reconciliation!.tokenId; }); declarations[group.reconciliation.tokenId] = group.reconciliation.coverageDeclaration; timezones[group.reconciliation.tokenId] = group.reconciliation.timezone; }
        setKeyTimezones(timezones);
        const ids = [...new Set(Object.values(byChannel))]; setSplitKeys(ids.length > 1); setTokenId(ids[0]); setChannelKeys(byChannel); setCoverage(declarations); setProbe(null);
      }
      useSaved(next, intent);
      if (next.complete) message.success(intent.groups.some((group) => group.reconciliationRequested) ? CONNECT.done : BINDING_COPY.saved);
    } catch (err: any) { setFailure(problemOf(err)); }
    finally { setRecovering(false); }
  };
  const buildInput = async (): Promise<BatchInput> => {
    if (!requestId) throw notice(ERROR_CATEGORIES.expired.text);
    if (!purposeSelected) throw notice(ONBOARDING_PURPOSE_REQUIRED);
    if (creating && formType === "newapi-key" && !monitor) throw notice(ONBOARDING_KEY_ONLY_MONITOR);
    if (monitorMode === "replace" && !monitor && !additionalIds.length) throw notice(COPY.replaceRequired);
    const selection: BatchInput["selections"][number] = { selectionId: "primary", monitor, additionalMonitorStationIds: additionalIds, updateCredentials: false };
    const linkOnly = !monitor && !additionalIds.length && !billing && removalRequested;
    if (!linkOnly) { if (creating) selection.newStation = connection(await form.validateFields()); else selection.stationId = stationId; }
    if (billing && requiresAuthorization && !authorizationId) throw notice(COPY.keyAccountRequired);
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
    setFailure(null);
    try {
      const expectedScopes = new Map([...groups].filter(([key]) => key !== "pending").map(([key, ids]) => [Number(key), scopeIds(Number(key), ids)]));
      const input = await buildInput(), current = ++generation.current; setProbing(true);
      const next: BatchProbe = await request("/api/channel-onboarding/batch/probe", input);
      if (current !== generation.current) return;
      const scopeChanged = billing && next.groups.some((group) => group.basis.tokenId && expectedScopes.has(group.basis.tokenId) && JSON.stringify([...group.basis.proposedChannelIds].sort((a, b) => a - b)) !== JSON.stringify(expectedScopes.get(group.basis.tokenId)));
      setProbe(next); remember(next.retryInput); setApproved(!scopeChanged && next.selections.every((selection) => selection.monitor.status === "verified") && !next.selections.some((selection) => selection.credentialUpdateRequired));
      if (scopeChanged) setFailure({ text: COPY.scopeChanged });
    } catch (err: any) { if (!err.errorFields) setFailure(problemOf(err, (text) => testReadText({ ok: false, reason: text }))); setApproved(false); }
    finally { setProbing(false); }
  };
  const save = async () => {
    setSaving(true); setFailure(null);
    try {
      if (retryInput) remember(retryInput, true);
      const next: BatchResult = await request("/api/channel-onboarding/batch", await buildInput());
      if (next.complete === true && next.groups.every((group) => group.complete && group.channels.every((entry) => entry.complete))) {
        setOpenIds([]); setSelectedIds([]); forget(requestId); remember(null); message.success(billing ? CONNECT.done : BINDING_COPY.saved); await load(false); await onComplete().catch(() => message.warning(`${BINDING_COPY.saved}；${BINDING_COPY.pageNotUpdated}`));
      } else { useSaved(next); await load(false); await onComplete().catch(() => {}); }
    } catch (err: any) {
      setApproved(false); setFailure(problemOf(err));
      if (retryInput) { try { const recovered: BatchResult = await request("/api/channel-onboarding/batch/recover", retryInput); useSaved(recovered); if (recovered.complete) setFailure(null); } catch { /* 保留原意图，允许显式恢复。 */ } }
    } finally { setSaving(false); }
  };
  const changeForm = (changed: any, target: any) => {
    if (changed.type) {
      const allowed = CREDENTIALS[changed.type] || []; target.setFieldsValue(Object.fromEntries(["accessToken", "userId", "apiKey", "email", "password"].filter((key) => !allowed.includes(key)).map((key) => [key, ""])));
      if (target === form && billing) setAuthorizationId(changed.type === "newapi-key" ? upstreams.some((resource) => resource.type !== "newapi-key") ? "" : "new" : "self");
    }
    if (Object.keys(changed).some((key) => key !== "name")) invalidate(true);
  };
  const closeDrawer = () => { generation.current += 1; keyGeneration.current += 1; setOpenIds([]); };
  useDrawerEscape(openIds.length > 0 && !busy && !authorization.authorizationOpen, closeDrawer);
  const stopForNewKey = (rule: any) => modal.confirm({
    title: `${SWAP}？`, okText: SWAP, cancelText: COPY.cancel, okButtonProps: { danger: true },
    content: COPY.swapNotice,
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
  const pendingNames = (intent: BatchRecoveryIntent) => names(intent.groups.flatMap((group) => group.channels.map((channel) => channel.channelId)));
  const replacementReady = monitorMode !== "replace" || monitor || additionalIds.length > 0;
  const canSave = purposeSelected && replacementReady && approved && !stale && !coverageSourceChanged && !busy && !keyLoading && !!(creating || stationId || removalRequested) && !!probe && Date.now() < probe.expiresAtMs && !(billing && groups.has("pending") && keys.length > 0);
  const refreshButton = <Button loading={refreshing} disabled={busy} onClick={() => void load(true)}>{REFRESH}</Button>;
  const syncDescribed = syncFailure ? describeError(syncFailure) : null;
  // 保存结果里一组的两种用途
  const purposeLine = (group: BatchResult["groups"][number]) => [
    group.monitor.status !== "not_requested" ? `${ONBOARDING_PURPOSES.monitor}：${MONITOR_RESULT[group.monitor.status] || COPY.pending}` : "",
    group.reconciliation.status !== "not_requested" ? `${ONBOARDING_PURPOSES.billing}：${BILLING_RESULT[group.reconciliation.status] || COPY.pending}` : "",
  ].filter(Boolean).join("；");
  const savedLine = (group: BatchResult["groups"][number]) => {
    const rule = group.saved.ruleId ? (catalogue?.rules || []).find((item: any) => item.id === group.saved.ruleId) : null;
    return `${COPY.upstream}：${resourceNames(group.saved.stationIds, BINDING_COPY.saved)}${group.saved.authorizationStationId ? `；${COPY.loginInfo}：${resourceNames([group.saved.authorizationStationId], BINDING_COPY.saved)}` : ""}${group.saved.ruleId ? `；${COPY.binding}：${rule ? pageKeyName(rule) : BINDING_COPY.saved}` : ""}`;
  };
  const allVerified = !!probe && probe.selections.every((selection) => selection.monitor.status === "verified");
  // 按钮上写着渠道名时可以换行；抽屉里的小按钮在手机上加高
  const wrapButton: CSSProperties = { minHeight: 44, maxWidth: "100%", height: "auto", whiteSpace: "normal", textAlign: "left" };
  const smallButton: CSSProperties = { minHeight: compact ? 40 : undefined };
  const radioStyle: CSSProperties = { minHeight: 40, alignItems: "center" };
  const ruleIdsOpen = [...new Set<string>(selectedChannels.flatMap((channel) => channel.reconciliation?.ruleIds || []))];
  return <>
    {!openIds.length && failure ? <ProblemAlert problem={failure} onClose={() => setFailure(null)} style={{ marginBottom: 16 }} /> : null}
    {workflowError ? <ProblemAlert problem={workflowError} type="warning" style={{ marginBottom: 16 }} extra={<><Button onClick={() => window.location.reload()}>{REFRESH}</Button><Button href="/stations">{COPY.back}</Button></>} /> : null}
    {destination?.action === "source" && !workflowError ? <section aria-label={REVIEW_SOURCE} style={{ marginBottom: 16, overflowWrap: "anywhere" }}><Alert type={stale ? "warning" : "info"} showIcon title={stale ? staleText(catalogue?.syncedAt, !!syncFailure, catalogue?.tz) : SOURCE.title} description={<div><div>{BINDING_COPY.ownStation}：{source ? `${catalogue?.ownStation?.name || EMPTY} · ${source.baseUrl}` : EMPTY}</div><div>{COPY.channels}：{names(channels.map((channel) => channel.id))}</div><Text type="secondary">{SOURCE.detail}</Text><ErrorDetail raw={syncDescribed?.raw} /></div>} action={refreshButton} /></section> : null}
    <Collapse style={{ marginBottom: 16 }} defaultActiveKey={["connections"]} items={[{ key: "connections", label: `${STATION_TABS.onboarding} · ${channels.length}`, extra: <Button aria-label={REFRESH} style={{ minHeight: 40 }} size="small" loading={refreshing} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void load(true); }}>{REFRESH}</Button>, children: <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Text type="secondary">{COPY.intro}</Text>
      {stale && catalogue ? (catalogue.ownStation ? <Alert type="warning" showIcon title={staleText(catalogue.syncedAt, !!syncFailure, catalogue.tz)} description={<div>{syncDescribed ? <div>{syncDescribed.text}</div> : null}<div>{COPY.refreshFirst}</div><ErrorDetail raw={syncDescribed?.raw} /></div>} action={refreshButton} /> : null)
        : directoryError ? <Alert type="error" showIcon title={failureText(BINDING_COPY.channelsUnreadable, directoryError)} description={<ErrorDetail raw={syncDescribed?.raw} />} action={refreshButton} /> : null}
      {catalogue?.syncedAt && !stale ? <Text type="secondary">{formatAsOf(catalogue.syncedAt, catalogue.tz)}</Text> : null}
      <div className="page-toolbar" style={{ width: "100%" }}><Input aria-label={COPY.search} placeholder={COPY.searchPlaceholder} allowClear value={search} onChange={(event) => setSearch(event.target.value)} style={{ flex: "1 1 200px", minWidth: 0 }} /><Select aria-label={COPY.statusFilter} value={status} onChange={setStatus} style={{ minWidth: 130 }} options={[{ value: "all", label: COPY.allChannels }, ...Object.entries(ROW_STATES).map(([value, label]) => ({ value, label }))]} /><Button disabled={busy || refreshing || stale || !selectedIds.length} style={{ minHeight: 44 }} onClick={() => open(selectedIds)}>{selectedIds.length ? `${CONNECT.label}（${selectedIds.length} 个渠道）` : CONNECT.label}</Button>{pendingRecovery ? <Button style={wrapButton} loading={recovering} disabled={!catalogue || busy} onClick={() => void recover(pendingRecovery, true)}>{COPY.finish}：{pendingNames(pendingRecovery)}</Button> : null}</div>
      {pendingRequests.length > 1 ? <section aria-label={COPY.pending}><Text strong>{COPY.pending}（{pendingRequests.length}）</Text>{pendingRequests.map((intent) => <div key={intent.requestId} style={{ marginTop: 8 }}><Button style={wrapButton} disabled={busy} onClick={() => void recover(intent, true)}>{COPY.finish}：{pendingNames(intent)}</Button></div>)}</section> : null}
      {authorization.recoveryButton}
      {filtered.length ? <Checkbox checked={filtered.every((entry) => selectedIds.includes(entry.id))} indeterminate={filtered.some((entry) => selectedIds.includes(entry.id)) && !filtered.every((entry) => selectedIds.includes(entry.id))} disabled={stale || busy} onChange={(event) => setSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...filtered.map((entry) => entry.id)])].slice(0, 100) : selectedIds.filter((id) => !filtered.some((entry) => entry.id === id)))}>{COPY.selectFiltered}</Checkbox> : null}
      <List loading={refreshing && !catalogue} dataSource={filtered} locale={{ emptyText: unset ? <Space direction="vertical"><Text>{OWN_STATION_UNSET}</Text><Button href={SETUP.href!}>{SETUP.label}</Button></Space>
        : stale && !channels.length ? <Space direction="vertical"><Text>{BINDING_COPY.channelsUnreadable}</Text>{refreshButton}</Space> : channels.length ? COPY.noMatch : COPY.noChannels }} pagination={filtered.length > 5 ? { pageSize: 5, size: "small", showSizeChanger: false } : false} renderItem={(entry: any) => {
        const name = reconciliationChannelName(entry);
        const tag = reconciliationChannelTag(entry);
        const pending = pendingForChannel(entry.id);
        const action = pending ? COPY.finish : onboardingMonitorIds(entry).length || entry.reconciliation?.ruleIds?.length ? EDIT : CONNECT.label;
        return <List.Item style={{ display: "flex", flexWrap: "wrap", gap: 12 }}><Checkbox aria-label={COPY.selectChannel(name)} disabled={stale || busy} checked={selectedIds.includes(entry.id)} onChange={(event) => setSelectedIds(event.target.checked ? [...selectedIds, entry.id].slice(0, 100) : selectedIds.filter((id) => id !== entry.id))} /><div style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}><Space wrap><Text strong>{name}</Text>{tag ? <Tag>{tag}</Tag> : null}</Space><div><Text type="secondary">{COPY.group}：{entry.groups?.join("、") || EMPTY}</Text></div><div><Text type="secondary">{entry.baseUrl || COPY.noBaseUrl}</Text></div><Text>{ROW_STATES[rowState(entry)]}</Text></div><Button style={{ minHeight: 44 }} disabled={refreshing || stale || busy} onClick={() => { if (pending) void recover(pending, true); else open([entry.id]); }} aria-label={`${action}「${name}」`}>{action}</Button></List.Item>;
      }} />
    </Space> }]} />
    <Drawer title={CONNECT.label} aria-label={CONNECT.label} open={openIds.length > 0} width={compact ? "100%" : 600} closable={!busy} maskClosable={!busy} keyboard={false} onClose={closeDrawer} extra={!purposeSelected && (hasMonitorLinks || hasSavedBilling) ? <Button style={{ minHeight: 44 }} disabled={busy} onClick={closeDrawer}>{COPY.close}</Button> : <Button style={{ minHeight: 44 }} type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>{result ? COPY.finish : COPY.confirm}</Button>}>
      <Space direction="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
        <section aria-label={COPY.current}><Text strong>{COPY.selected(openIds.length)}</Text><div><Text type="secondary">{names(openIds)}</Text></div>
          {hasMonitorLinks || hasSavedBilling ? <><div style={{ marginTop: 12 }}><Text strong>{COPY.current}</Text><Text type="secondary">{COPY.currentKeep}</Text></div>{selectedChannels.map((channel) => <div key={channel.id} style={{ marginTop: 8 }}>
            {openIds.length > 1 ? <Text strong>{reconciliationChannelName(channel)}</Text> : null}<div>{ONBOARDING_PURPOSES.monitor}：{resourceNames(onboardingMonitorIds(channel))}</div>
            <div>{ONBOARDING_PURPOSES.billing}：{channel.reconciliation?.ruleIds?.length ? channel.reconciliation.ruleIds.map((id: string) => { const rule = catalogue.rules.find((entry: any) => entry.id === id); return rule ? `${resourceNames([rule.upstreamStationId])} · ${pageKeyName(rule)} · ${names(rule.channels.map((entry: any) => entry.channelId))}` : BINDING_COPY.saved; }).join("；") : UNLINKED}</div>
          </div>)}
          <Space wrap style={{ marginTop: 8 }}>{currentResourceIds.map((id) => { const resource = upstreams.find((entry) => entry.id === id); return resource && resource.type !== "newapi-key" ? <Button key={id} size="small" style={smallButton} disabled={busy} onClick={() => void updateAuthorization(id)}>{UPDATE_AUTH}「{resource.name}」</Button> : null; })}{ruleIdsOpen.map((id) => { const rule = catalogue.rules.find((entry: any) => entry.id === id); return <Button key={id} size="small" style={smallButton} href={workflowAction("edit_binding", { ruleId: id }).href!}>{EDIT}：{rule ? pageKeyName(rule) : BINDING_COPY.saved}</Button>; })}</Space></> : null}
        </section>
        {stale ? <Alert type="warning" showIcon title={ERROR_CATEGORIES.expired.text} action={refreshButton} /> : null}{failure ? <ProblemAlert problem={failure} /> : null}
        {accountsError ? <ProblemAlert problem={accountsError} type="warning" extra={<Button disabled={busy} onClick={() => void loadAccounts()}>{REFRESH}</Button>} /> : null}
        {result ? <Alert type={result.complete ? "success" : "warning"} showIcon title={result.complete ? (billing ? CONNECT.done : BINDING_COPY.saved) : COPY.partial} description={<Space direction="vertical">{result.groups.map((group) => {
          const reason = group.reason || group.reconciliation.reason;
          return <div key={group.groupId}><Text strong>{names(group.channels.map((entry) => entry.channelId))} · {group.complete ? BINDING_COPY.saved : COPY.pending}</Text><div>{purposeLine(group)}</div>{reason || group.code ? <div>{describeError({ code: group.code, reason }).text}<ErrorDetail raw={reason} /></div> : null}<div>{savedLine(group)}</div>{group.channels.filter((entry) => !entry.complete).map((entry) => <div key={entry.channelId}>{names([entry.channelId])}：{entry.reason || entry.code ? describeError({ code: entry.code, reason: entry.reason }).text : ERROR_CATEGORIES.changed.text}<ErrorDetail raw={entry.reason} /></div>)}{group.remainingActions.length ? <Text type="secondary">{COPY.nextStep}：{group.remainingActions.includes("supply_credentials") ? COPY.supplyCredentials : group.remainingActions.includes("select_key") ? describeError({ code: "KEY_REQUIRED" }).text : ERROR_CATEGORIES.changed.text}</Text> : null}</div>;
        })}{retryInput ? <Button disabled={busy} onClick={() => void recover(retryInput)}>{COPY.viewSaved}</Button> : null}</Space>} /> : null}
        {coverageRule ? <Alert type="info" showIcon title={COVERAGE_QUESTION} description={<div><div>{FIELDS.apiKey.label}：{pageKeyName(coverageRule)} · {COPY.channels}：{names((coverageRule.channels || []).map((channel: any) => Number(channel.channelId)))}</div><div>{COVERAGE.detail}</div><Space wrap><Button href={workflowAction("edit_binding", { ruleId: coverageRule.id }).href!}>{EDIT}</Button><Button disabled={busy} onClick={() => stopForNewKey(coverageRule)}>{SWAP}</Button></Space></div>} /> : null}
        {hasMonitorLinks || hasSavedBilling ? <div><Text strong>{COPY.monitorHeading}</Text><Radio.Group aria-label={COPY.monitorModeAria} style={{ display: "block", marginTop: 8 }} value={monitorMode} disabled={busy || !!coverageRule} onChange={(event) => changeMonitorMode(event.target.value)}><Space wrap><Radio value="keep" style={radioStyle}>{COPY.modes.keep}</Radio><Radio value="add" style={radioStyle}>{COPY.modes.add}</Radio>{hasMonitorLinks ? <><Radio value="replace" style={radioStyle}>{COPY.modes.replace}</Radio><Radio value="remove" style={radioStyle}>{COPY.modes.remove}</Radio></> : null}</Space></Radio.Group></div> : null}
        {creating || monitorMode === "add" || monitorMode === "replace" || billing ? <>
          <div><Space wrap><Text strong>{creating ? COPY.newUpstream : COPY.useSaved}</Text>{!coverageRule && upstreams.length ? <Button size="small" style={smallButton} disabled={busy} onClick={changeResourceMode}>{creating ? COPY.useSaved : COPY.newUpstream}</Button> : null}</Space></div>
          {creating ? <><Text type="secondary">{COPY.createHint}</Text><Form name="channel-onboarding" form={form} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, form)}><ConnectionFields type={formType} nameLabel={FIELDS.name.label} types={TYPES} /></Form></> : <div><Select<string> aria-label={COPY.upstream} style={{ width: "100%" }} showSearch optionFilterProp="searchText" value={stationId} disabled={busy || !!coverageRule} placeholder={COPY.upstreamPlaceholder} options={resourceOptions} optionRender={(option) => <div style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}><div>{option.label}</div><Text type="secondary">{option.data.baseUrl}</Text></div>} onChange={(id) => { setStationId(id); setAuthorizationId(upstreams.find((resource) => resource.id === id)?.type === "newapi-key" ? "" : "self"); setMonitor((current) => current && upstreams.find((item) => item.id === id)?.monitorEnabled !== false); invalidate(true); }} />{main ? <Space wrap style={{ marginTop: 8 }}><Text type="secondary">{main.baseUrl} · {COPY.savedLogin}</Text>{main.type !== "newapi-key" && !currentResourceIds.includes(main.id) ? <Button size="small" style={smallButton} disabled={busy} onClick={() => void updateAuthorization(main.id)}>{UPDATE_AUTH}「{main.name}」</Button> : null}</Space> : <Text type="secondary">{COPY.matchHint}</Text>}</div>}
        </> : null}
        {monitorMode === "add" || monitorMode === "replace" ? <>
          <Checkbox checked={monitor} disabled={busy || !creating && main?.monitorEnabled === false} onChange={(event) => { setMonitor(event.target.checked); invalidate(); }}>{ONBOARDING_PURPOSES.monitor}</Checkbox>
          {!creating && main?.monitorEnabled === false ? <Space wrap><Text type="secondary">{COPY.pausedHint}</Text><Button disabled={busy} onClick={() => void enableMonitor(main.id)}>{RESUME.label}</Button></Space> : null}
          <Collapse size="small" items={[{ key: "extra", label: COPY.extraMonitors, children: <Select aria-label={COPY.extraAria} mode="multiple" style={{ width: "100%" }} value={additionalIds} disabled={busy} options={upstreams.filter((item) => item.monitorEnabled !== false && item.id !== stationId).map((item) => ({ value: item.id, label: stationLabel(item) }))} onChange={(ids) => { setAdditionalIds(ids); invalidate(); }} /> }]} />
        </> : null}
        {monitorMode === "replace" ? <Text type="warning">{COPY.replaceNote}</Text> : null}
        {monitorMode === "remove" ? <section aria-label={COPY.removeAria}>{selectedChannels.map((channel) => <div key={channel.id}><Text strong>{reconciliationChannelName(channel)}</Text><Checkbox.Group style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }} value={removals[channel.id] || []} options={onboardingMonitorIds(channel).map((id) => ({ value: id, label: COPY.removeLabel(resourceNames([id])) }))} disabled={busy} onChange={(ids) => { setRemovals((previous) => ({ ...previous, [channel.id]: ids as string[] })); invalidate(); }} /></div>)}</section> : null}
        {additionalIds.length ? <Alert type="warning" showIcon title={COPY.doubleCost} /> : null}
        <Checkbox checked={billing} disabled={busy} onChange={(event) => configureBilling(event.target.checked)}>{hasSavedBilling ? `${EDIT}（${ONBOARDING_PURPOSES.billing}）` : COPY.billingCheckbox}</Checkbox>
        {!purposeSelected && !hasMonitorLinks && !hasSavedBilling ? <Alert type="warning" showIcon title={ONBOARDING_PURPOSE_REQUIRED} description={ONBOARDING_PURPOSE_HINT} /> : null}
        {billing && groups.has("pending") ? <Text type="secondary">{COPY.noKeyNeeded}</Text> : null}
        {billing ? <>
          {requiresAuthorization ? <div><Text strong>{COPY.keyAccount}</Text><Select aria-label={COPY.keyAccount} style={{ width: "100%", marginTop: 8 }} value={authorizationId || undefined} placeholder={COPY.keyAccountPlaceholder} disabled={busy} showSearch optionFilterProp="label" options={[...billingCandidates.matched, ...billingCandidates.others].map((item) => ({ value: item.id, label: `${stationLabel(item)} · ${item.baseUrl}` })).concat([{ value: "new", label: COPY.newAuthorization }])} onChange={(id) => { setAuthorizationId(id); invalidate(true); }} />{billingResourceId && !currentResourceIds.includes(billingResourceId) ? <Button size="small" style={{ ...smallButton, marginTop: 8 }} disabled={busy} onClick={() => void updateAuthorization(billingResourceId)}>{UPDATE_AUTH}「{resourceNames([billingResourceId])}」</Button> : null}</div> : <Text type="secondary">{COPY.authHint}</Text>}
          {requiresAuthorization && authorizationId === "new" ? <><Alert type="info" showIcon title={COPY.authOnceTitle} description={COPY.authOnce} /><Form name="channel-onboarding-authorization" form={authorizationForm} layout="vertical" requiredMark={false} disabled={busy} onValuesChange={(changed) => changeForm(changed, authorizationForm)}><ConnectionFields type={authorizationType} nameLabel={FIELDS.authorizationName.label} types={TYPES.filter((type) => type.value !== "newapi-key")} /></Form></> : null}
          {keyLoading ? <Text type="secondary">{COPY.keysLoading}</Text> : null}
          {keyError ? <ProblemAlert problem={keyError} type="warning" extra={<Button disabled={busy} onClick={() => setKeyReadVersion((version) => version + 1)}>{REFRESH}</Button>} /> : null}
          {billingResourceId && keyRead && !keys.length && !keyError ? <Text type="secondary">{COPY.noKeys}</Text> : null}
          <div><Text strong>{COPY.keysTitle}</Text><Select aria-label={FIELDS.apiKey.label} style={{ width: "100%", marginTop: 8 }} showSearch optionFilterProp="label" value={tokenId} loading={keyLoading} disabled={busy || keyLoading || !keys.length || splitKeys || !!coverageRule} placeholder={billingResourceId ? COPY.keyPlaceholder : COPY.keyPlaceholderNew} options={keyOptions} onChange={chooseKey} /></div>
          {openIds.length > 1 ? <Checkbox checked={splitKeys} disabled={busy || !!coverageRule} onChange={(event) => { setSplitKeys(event.target.checked); setChannelKeys(Object.fromEntries(openIds.map((id) => [id, tokenId]))); invalidate(); }}>{COPY.splitKeys}</Checkbox> : null}
          {splitKeys ? openIds.map((id) => <div key={id}><Text>{names([id])}</Text><Select aria-label={COPY.channelKey(names([id]))} style={{ width: "100%", marginTop: 4 }} value={channelKeys[id]} disabled={busy || keyLoading || !keys.length} options={keyOptions} placeholder={COPY.chooseKey} onChange={(value) => { setChannelKeys((previous) => ({ ...previous, [id]: value })); const existing = savedKeyContext(value); if (existing) { setCoverage((previous) => ({ ...previous, [value]: previous[value] || existing.coverageDeclaration })); setKeyTimezones((previous) => ({ ...previous, [value]: previous[value] || existing.timezone })); } invalidate(); }} /></div>) : null}
          {[...groups].map(([key, ids]) => {
            if (key === "pending") return null;
            const union = scopeIds(Number(key), ids);
            const declaration = coverage[key] || unknownCoverage();
            const answer = coverageAnswerOption(declaration)?.value;
            // 「这把 Key 还给别处用吗？」只问一次，五个回答和改绑定共用 COVERAGE_ANSWERS
            return <div key={key}><Text strong>{keyName(Number(key))}</Text><div><Text>{COPY.allBound}：{names(union)}</Text></div><Text>{COVERAGE_QUESTION}</Text><Select aria-label={groups.size === 1 ? COVERAGE_QUESTION : `${keyName(Number(key))} · ${COVERAGE_QUESTION}`} style={{ width: "100%", marginTop: 8 }} value={answer} disabled={busy} options={COVERAGE_ANSWERS.map(({ value, label }) => ({ value, label }))} onChange={(value) => { setCoverage((previous) => ({ ...previous, [key]: coverageDeclarationOf(value, declaration.uncoveredOwnChannelIds) as CoverageDeclaration })); invalidate(); }} />{answer === "own_channels" ? <><Text>{BINDING_COPY.uncoveredChannels}</Text><Select aria-label={BINDING_COPY.uncoveredChannels} mode="multiple" style={{ width: "100%", marginTop: 8 }} value={declaration.uncoveredOwnChannelIds} disabled={busy} options={channels.filter((entry) => !union.includes(entry.id)).map((entry) => ({ value: entry.id, label: reconciliationChannelName(entry) }))} onChange={(ids) => { setCoverage((previous) => ({ ...previous, [key]: { ...declaration, uncoveredOwnChannelIds: ids } })); invalidate(); }} /></> : null}{answer !== "none" ? <Text type="secondary">{COVERAGE.detail}</Text> : null}</div>;
          })}
        </> : null}
        {purposeSelected ? <Button style={{ minHeight: 44 }} loading={probing} disabled={!replacementReady || saving || recovering || keyLoading || stale || coverageSourceChanged || (!creating && !stationId && !removalRequested)} onClick={() => void verify()}>{TEST_READ}</Button> : null}
        {probe ? <>
          <Alert type={allVerified ? "success" : "warning"} showIcon title={allVerified ? `${testReadText({ ok: true, bill: false })}，${COPY.notSaved}` : COPY.pending} description={probe.selections.some((selection) => selection.monitor.reason) ? <div>{probe.selections.filter((selection) => selection.monitor.reason).map((selection) => <div key={selection.selectionId}>{testReadText({ ok: false, reason: describeError(selection.monitor).text })}<ErrorDetail raw={selection.monitor.reason} /></div>)}</div> : COPY.notSavedYet} />
          {probe.selections.flatMap((selection) => {
            const targets: CredentialUpdateTarget[] = selection.credentialUpdates ?? (selection.credentialUpdateRequired && selection.station?.id ? [{ role: "primary", stationId: selection.station.id }] : []);
            return targets.map((target) => <Alert key={`${selection.selectionId}:${target.role}:${target.stationId}`} type="warning" showIcon title={COPY.credentialTitle[target.role === "primary" ? "primary" : "authorization"]} description={<Space direction="vertical"><Text>{target.role === "primary" ? COPY.credentialPrimary : COPY.credentialAuthorization(resourceNames([target.stationId]))}</Text><Space wrap><Button disabled={busy} onClick={() => reuseCredentialTarget(target)}>{COPY.reuseSaved}</Button><Button disabled={busy} onClick={() => void updateAuthorization(target.stationId, { initialAuthorization: connection((target.role === "primary" ? form : authorizationForm).getFieldsValue()), adoptTarget: target.role })}>{UPDATE_AUTH}</Button></Space></Space>} />);
          })}
          {probe.groups.flatMap((group) => group.monitorChanges || []).map((change) => <section key={change.channelId} aria-label={COPY.changeAria(names([change.channelId]))}>
            <Text strong>{names([change.channelId])} · {ONBOARDING_PURPOSES.monitor}</Text><div>{COPY.unchanged}：{resourceNames(change.previousStationIds.filter((id) => change.proposedStationIds.includes(id)))}</div>
            <div>{COPY.added}：{[...change.addedStationIds.map((id) => resourceNames([id])), ...(creating && monitor ? [COPY.newUpstreamName(form.getFieldValue("name") || COPY.upstreamAccount)] : [])].join("、") || EMPTY}</div><div>{COPY.removed}：{resourceNames(change.removedStationIds)}</div>
          </section>)}
          {billing ? probe.groups.map((group) => {
          const zone = formatDayZone(group.basis.timezone);
          const start = group.preview.scopeChanged ? COPY.startsNow
            : `${group.preview.billingEffectiveFromMs != null ? reconciliationChannelStatus("not_effective", { start: formatZonedDateTime(group.preview.billingEffectiveFromMs, group.basis.timezone) }).label : COPY.unverified}${zone ? `（${zone}）` : ""}`;
          return <Alert key={group.groupId} type={group.status === "ready" ? "info" : "warning"} showIcon title={group.code === "KEY_REQUIRED" ? COPY.noKey : group.basis.existingRuleId ? COPY.joinExisting : PREVIEW_STATE[group.status] || BINDING_COPY.preview} description={<Space direction="vertical">{group.reason || group.code ? <div><Text>{describeError({ code: group.code, reason: group.reason }).text}</Text><ErrorDetail raw={group.reason} /></div> : null}<Text>{COPY.upstreamAccount}：{group.basis.accountIdentity ? `${group.basis.accountIdentity.baseUrl} · ${COPY.account} ${group.basis.accountIdentity.accountId}` : EMPTY}</Text><Text>{FIELDS.apiKey.label}：{group.basis.tokenId ? keyName(group.basis.tokenId) : EMPTY}</Text><Text>{COPY.existing}：{names(group.basis.existingChannelIds)}；{COPY.adding}：{names(group.requestedChannelIds)}</Text><Text>{COPY.allBound}：{names(group.basis.proposedChannelIds)}</Text><Text>{start}</Text><Text>{COPY.costOnce}{group.preview.costCoverage !== "complete" ? `；${COPY.coverageUnanswered}` : ""}</Text></Space>} />;
        }) : probe.groups.filter((group) => group.reason).map((group) => <Alert key={group.groupId} type="warning" showIcon title={COPY.pending} description={<div>{describeError({ code: group.code, reason: group.reason }).text}<ErrorDetail raw={group.reason} /></div>} />)}
          <Collapse size="small" items={[{ key: "basis", label: COPY.details, children: <Space direction="vertical"><Text>{BINDING_COPY.ownStation}：{catalogue?.ownStation?.name || EMPTY} · {source?.baseUrl || EMPTY}</Text>{selectedChannels.map((channel) => <Text key={channel.id}>{reconciliationChannelName(channel)} · {COPY.group} {channel.groups?.join("、") || EMPTY}</Text>)}</Space> }]} />
          {!approved && !probe.selections.some((selection) => selection.credentialUpdateRequired) ? <Text type="warning">{ERROR_CATEGORIES.changed.text}</Text> : null}
        </> : null}
      </Space>
    </Drawer>
    {authorization.overlay}
  </>;
}
