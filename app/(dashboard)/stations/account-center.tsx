"use client";
// 上游账单：按「上游账号 → Key → 绑定」看上游和自营站点的渠道，并承接运营总览、每日利润带来的事项
// （测试读取、更新登录信息、暂停/恢复监控、改绑定、换 Key、解除绑定）。
// 绑定的写操作只在这里；上游列表与编辑抽屉仍由页面持有。用语按 design/ui-copy-spec.md，报错按 lib/error-copy.js 归类，原文只放进「查看详细原因」。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, App, Button, Collapse, Drawer, Input, Modal, Select, Space, Typography } from "antd";
import { api, readWorkflowDestination } from "../../../lib/client";
import { costBasisOf } from "../../../lib/profit.js";
import type { AccountReadModel, AccountRecord, AccountKeyScope, AccountAssociation, UnmatchedAssociation, CoverageDeclaration, PublicResource, WorkflowDestination, UpstreamKeyRead, ResourceIdentityConfirmation } from "../../../lib/client";
import { STATION_TABS } from "../../../lib/brand.js";
import { DEFAULT_BUSINESS_TIME_ZONE } from "../../../lib/business-time.js";
import { BINDING_COPY, ONBOARDING_TYPES } from "../../../lib/channel-onboarding.js";
import { ERROR_CATEGORIES, describeError, errorText, failureSentence, failureText } from "../../../lib/error-copy.js";
import { EMPTY, FIXED_COST_TEXT, NOTHING_TO_HANDLE, RATE_UNSET_PARITY, formatAsOf, formatDayZone, formatRate, formatUsd, formatZonedDateTime, formatZonedRange, refreshFailedText } from "../../../lib/format";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, coverageAnswerOption, fillIssueCopy, reconciliationChannelStatus, reconciliationIssue } from "../../../lib/reconciliation-contract.js";
import { reconciliationChannelName, reconciliationKeyName, reconciliationKeyNamer } from "../../../lib/reconciliation-view.js";
import { DESTINATION_CHANGED, HISTORY_KEPT, testReadText, workflowActionMeta } from "../../../lib/workflow-actions.js";
import { Skeleton } from "../../components/data-state";
import { ErrorDetail, notice, noteOf } from "../../components/error-detail";
import type { ErrorNote } from "../../components/error-detail";
import { Icon, Sym } from "../../components/icons";
import { CountBadge } from "../../components/panel";
import { publishAccountActions } from "../../components/use-workflow-actions";
import { useDrawerEscape } from "../../components/drawer-escape";
import { useAccountAuthorization } from "../../components/account-authorization";
import { AssociationEditor } from "./association-editor";
import type { AssociationEditTarget } from "./association-editor";

const { Text } = Typography;
// 按钮名和完成提示（§3.5，lib/workflow-actions.js）
const PAUSE = workflowActionMeta("pause_monitor")!;
const RESUME = workflowActionMeta("resume_monitor")!;
const TEST_READ = workflowActionMeta("verify_identity")!;
const UPDATE_LOGIN = workflowActionMeta("update_authorization")!;
const EDIT_BINDING = workflowActionMeta("edit_binding")!;
const SWAP_KEY = workflowActionMeta("swap_key")!;
const UNBIND = workflowActionMeta("unbind")!;
const REFRESH = workflowActionMeta("refresh")!;
const INSPECT = workflowActionMeta("inspect_balance")!;
const CONNECT = workflowActionMeta("connect_channels")!;
const OWNER_UNVERIFIED = reconciliationIssue("COST_OWNER_UNVERIFIED");
const KEY_TWICE = reconciliationIssue("CANONICAL_KEY_CONFLICT");
const CHANNEL_TWICE = reconciliationIssue("DUPLICATE_CHANNEL_ASSIGNMENT");
const TIMEZONE_UNVERIFIED = reconciliationIssue("BILLING_TIMEZONE_UNVERIFIED");
// 上游账单独有的话，只在这一处写；用语按 design/ui-copy-spec.md
const COPY = Object.freeze({
  needsAction: "需处理",
  unsupported: "这个上游不支持读取账单，只能看余额。",
  notStarted: "还没开始",
  pausedHint: "暂停监控时不刷新余额，绑定照常算利润。",
  pauseText: "暂停后不再刷新这个上游的余额，随时可以恢复；绑定照常算利润。",
  resumeText: "恢复后接着刷新这个上游的余额。",
  unbound: "已解除绑定",
  notBound: "没绑定",
  activeCount: (n: number) => `${n} 条在用`,
  inProfit: "算进利润",
  notInProfit: "不算进利润",
  noRenewal: "不再续费",
  globalLine: "按系统设置",
  profitPaused: "利润先不算",
  editUpstream: "编辑上游",
  editElsewhere: `在「${STATION_TABS.list}」里看余额和改设置。`,
  conflictWith: (names: string) => `和它重复的：${names}`,
  missingUpstreamDetail: "上游已删除，这条绑定读不到上游成本，请解除绑定",
  unbindHint: `解除后不再算这把 Key 在这些渠道上的利润，空出来的渠道可以重新绑定；${HISTORY_KEPT}，同一把 Key 的其他绑定不受影响。`,
  keyNotBound: "这把 Key 还没绑定。",
  noKeys: `还没有 Key。在「${STATION_TABS.onboarding}」把 Key 和渠道绑定后，显示在这里。`,
  loginOutdated: `${UPDATE_LOGIN.title}，${UPDATE_LOGIN.detail}。`,
  archivedHint: "另有归档的上游，点上方「显示归档的上游」查看。",
  showArchived: "显示归档的上游",
  hideArchived: "隐藏归档的上游",
  searchPlaceholder: "搜索上游、上游账号、Key、渠道",
  allAccounts: "全部上游账号",
  accountCount: (n: number) => `${n} 个上游账号`,
  unverifiedCount: (n: number) => `${n} 个上游还没确认上游账号`,
  unmatchedCount: (n: number) => `${n} 条绑定还没归到 Key 下`,
  noMatchedAccounts: "没有匹配的上游账号",
  noAccounts: "还没有确认过的上游账号。测试读取下面的上游后，会按上游账号列在这里。",
  unmatchedTitle: "还没归到 Key 下的绑定",
  unmatchedSub: `这些绑定还在用，但还不能确认对应哪把 Key。先按提示处理；不用了可以直接解除绑定，${HISTORY_KEPT}。`,
  noMatchedBindings: "没有匹配的绑定。",
  unverifiedTitle: "只用 Key 的上游，和还没确认上游账号的上游",
  unverifiedSub: "这些上游还不能确认属于哪个上游账号，所以单独列出；绑定照常保留。",
  ownerUnknown: "还没确认上游账号",
  matchedChannels: "对上的渠道",
  noMatchedUpstreams: "没有匹配的上游。",
  inspectSub: "同一个上游账号的几个上游可能是同一份余额，下面分开列，不相加。",
  balanceUnread: "读不到余额",
  notRead: "还没读取",
  centerSub: "按上游账号看上游、Key 和绑定；改绑定、解除绑定都在这里。同一个上游账号的几个上游可能是同一份余额，余额按每个上游分开看，不相加。",
  readOnlyTitle: "只读取，不会改动上游",
  readOnlyDetail: "用已保存的登录信息读一次上游账号和 Key 列表。读到上游账号后点「确认」，绑定和设置都不变；Key 能不能读到账单、按哪个时区算一天，在下面分别看。",
  ownStation: "自营站点不在这里测试读取",
  keyOnlyTitle: "只有一把 Key，读不到上游账号",
  addLoginHint: `要确认上游账号，先在上游编辑页补上登录信息再${TEST_READ.label}；也可以到「${STATION_TABS.onboarding}」选渠道，补上读取账单用的登录信息。`,
  timezone: "时区",
  timezoneHelp: "按哪个地方的 0 点算一天",
  testReadKey: "测试读取这把 Key",
  testReadSelected: "测试读取选中的 Key",
  identityRead: (id: string) => `能读到上游账号 ${id}`,
  identityUnread: "读不到上游账号",
  identityHint: "点「确认」后，这个上游归到这个上游账号下。",
  confirmIdentity: "确认",
  identityConfirmed: (id: string) => `已确认上游账号 ${id}`,
  keyListUnread: "上游账号能读到，但读不到 Key 列表；这不代表上游账号下没有 Key。",
  chooseKey: "选一把 Key",
  group: (name: string) => `分组 ${name}`,
  noTokens: "没读到 Key，可以再测试读取一次。",
  billNotRead: "还没读取账单",
  upstreamCost: (amount: string) => `上游成本 ${amount}`,
  probeIncomplete: "这段时间的用量记录没读全",
  probeHint: "这里只是测试读取，不改利润。",
  chooseBinding: "请选择要解除的绑定",
  ownExcluded: "自营站点不在这里改",
  profit: "利润",
  channels: "渠道",
  bindings: "绑定",
  freedChannels: "解除后空出来的渠道",
});
// 还没归到 Key 下的绑定：为什么、怎么办（§5.2 的问题文案）
const UNMATCHED_ISSUES: Record<UnmatchedAssociation["reason"], { title: string; detail: string }> = {
  unverified_resource: OWNER_UNVERIFIED,
  unanchored: reconciliationIssue("LEGACY_IDENTITY_UNVERIFIED"),
  key_changed: reconciliationIssue("SOURCE_BINDING_UNCONFIRMED"),
  missing_resource: { title: ERROR_CATEGORIES.not_found.text, detail: COPY.missingUpstreamDetail },
};

type AccountCenterProps = {
  // 完整上游列表：含暂停监控与归档的上游
  stations: any[];
  types: any[];
  loadingMeta: boolean;
  compact: boolean;
  loaded: boolean;
  loadingList: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  // 页面每次读取上游列表后递增，上游账单随之重读
  reloadToken: number;
  openEditor: (station: any) => void;
  openTrend: (station: any) => void;
};

export function useAccountCenter({
  stations, types, loadingMeta, compact, loaded, loadingList, loadError, reload, reloadToken, openEditor, openTrend,
}: AccountCenterProps): {
  destination: WorkflowDestination | null;
  // 每次在页面内打开新的处理目标时递增，供依赖目标的区块重新定位
  destinationSeq: number;
  openWorkflow: (href: string) => void;
  top: ReactNode;
  center: ReactNode;
  overlays: ReactNode;
} {
  const { message } = App.useApp();
  const [accountModel, setAccountModel] = useState<AccountReadModel | null>(null);
  const [accountError, setAccountError] = useState<ErrorNote | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  // 归档的上游默认收起，上游账单里按需展开，与上游列表的筛选互不影响
  const [showArchived, setShowArchived] = useState(false);
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [destinationSeq, setDestinationSeq] = useState(0);
  const [workflowError, setWorkflowError] = useState("");
  const [expandedAccounts, setExpandedAccounts] = useState<string[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  // 事项指向的绑定：展开所在上游账号与 Key 后高亮
  const [focusRuleId, setFocusRuleId] = useState("");
  const [editTarget, setEditTarget] = useState<AssociationEditTarget | null>(null);
  const editSeq = useRef(0);
  const destinationResolved = useRef(false);
  const [verificationStation, setVerificationStation] = useState<any>(null);
  const [verification, setVerification] = useState<UpstreamKeyRead | null>(null);
  const [verificationTimezone, setVerificationTimezone] = useState(DEFAULT_BUSINESS_TIME_ZONE);
  const [verificationTokenId, setVerificationTokenId] = useState<number>();
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState<ErrorNote | null>(null);
  const verificationEpoch = useRef(0);
  const accountReadEpoch = useRef(0);
  const { openAuthorization, authorizationBusy, authorizationEligible, recoveryButton: authorizationRecoveryButton, overlay: authorizationOverlay } = useAccountAuthorization({
    compact, accountModel, stations, disabled: loadingAccounts, onComplete: reload, onRecoveryError: setAccountError,
  });
  const [purposeTarget, setPurposeTarget] = useState<{ resource?: PublicResource; monitorEnabled?: boolean; keyLabel?: string; association?: AccountAssociation } | null>(null);
  const [purposeBusy, setPurposeBusy] = useState(false);
  const [purposeError, setPurposeError] = useState<ErrorNote | null>(null);
  // 业务时区：时间都按它显示，上游按别的时区算一天时才另外说明（§6）
  const businessTz = accountModel?.tz || DEFAULT_BUSINESS_TIME_ZONE;

  const loadAccounts = useCallback(async () => {
    const current = ++accountReadEpoch.current;
    setLoadingAccounts(true);
    try {
      const next: AccountReadModel = await api("/api/channel-onboarding/accounts");
      if (current === accountReadEpoch.current) { setAccountModel(next); setAccountError(null); publishAccountActions(next.actions); }
    } catch (err: any) {
      if (current === accountReadEpoch.current) setAccountError(noteOf(err));
    } finally {
      if (current === accountReadEpoch.current) setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    if (reloadToken) void loadAccounts();
  }, [reloadToken, loadAccounts]);

  useEffect(() => {
    setDestination(readWorkflowDestination(window.location.search, "stations"));
    return () => { accountReadEpoch.current += 1; };
  }, []);

  useEffect(() => {
    if (!destination || destinationResolved.current || !loaded || !accountModel || loadingAccounts || loadingList || accountError || loadError) return;
    if (["connect", "coverage", "source"].includes(destination.action) && !destination.error) return;
    destinationResolved.current = true;
    if (destination.error) { setWorkflowError(destination.error); return; }
    const account = accountModel.accounts.find((account) => account.accountKey === destination.accountKey || account.resources.some((resource) => resource.id === destination.stationId));
    if (["verify", "verify-billing"].includes(destination.action)) {
      const original = stations.find((station) => station.id === destination.stationId && !station.archivedAt);
      if (!original) { setWorkflowError(`${ERROR_CATEGORIES.not_found.text}。`); return; }
      if (!ONBOARDING_TYPES.some((item) => item.value === original.type)) { setWorkflowError(COPY.unsupported); return; }
      openVerification(original);
    } else if (destination.action === "authorization") {
      if (!account || account.accountKey !== destination.accountKey || !authorizationEligible(account).length) { setWorkflowError(DESTINATION_CHANGED); return; }
      openAuthorization(account);
    } else if (["scope", "conflict"].includes(destination.action)) {
      const located = locateAssociation(destination.ruleId!);
      if (!located) {
        // 绑定还挂在上游上、却没出现在任何 Key 下：还没确认上游账号
        const pending = [...accountModel.accounts.flatMap((item) => item.resources), ...accountModel.unverifiedResources].find((resource) => resource.purposes.billingRuleIds.includes(destination.ruleId!));
        setWorkflowError(pending ? `上游「${pending.name}」${OWNER_UNVERIFIED.title}，${OWNER_UNVERIFIED.detail}。` : `${errorText({ code: "RULE_NOT_FOUND" })}。`);
        if (pending) setAccountSearch(pending.id || "");
        return;
      }
      // 重复的绑定一并展开另一条，便于对照后决定解除哪一条
      const related = [located, ...(destination.action === "conflict" ? located.association.conflictRuleIds.map(locateAssociation).filter((item) => !!item) : [])];
      const accountKeys = [...new Set(related.flatMap((item) => item.account ? [item.account.accountKey] : []))];
      setAccountFilter("all");
      // 有一条在「还没归到 Key 下的绑定」里时不按上游账号筛选，两边都能看到
      setAccountSearch(accountKeys.length === 1 && related.every((item) => item.account) ? accountKeys[0] : "");
      setExpandedAccounts(accountKeys);
      setExpandedKeys([...new Set(related.flatMap((item) => item.key ? [item.key.canonicalKey] : []))]);
      setFocusRuleId(located.association.ruleId);
      if (located.association.status !== "active") setWorkflowError(`${UNBIND.done}，不用再处理。`);
      return;
    } else {
      const original = stations.find((station) => station.id === destination.stationId);
      if (!account && !original) { setWorkflowError(`${ERROR_CATEGORIES.not_found.text}。`); return; }
    }
    setAccountSearch(account?.accountKey || destination.stationId || "");
    if (account) setExpandedAccounts([account.accountKey]);
  // 只在上游列表和上游账单都读到后定位，自动刷新不重复打开更新登录信息。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, loaded, accountModel, loadingAccounts, loadingList, accountError, loadError]);

  // 定位到的绑定：等上游账号与 Key 展开后滚到可见处
  useEffect(() => {
    if (!focusRuleId) return;
    const timer = setTimeout(() => document.querySelector(`[data-rule-id="${CSS.escape(focusRuleId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 200);
    return () => clearTimeout(timer);
  }, [focusRuleId, destinationSeq]);

  // 在页面内打开事项（不整页刷新），与从运营总览、每日利润跳转进来走同一套定位逻辑
  const openWorkflow = useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
    destinationResolved.current = false;
    setWorkflowError("");
    setFocusRuleId("");
    setDestination(readWorkflowDestination(url.search, "stations"));
    setDestinationSeq((n) => n + 1);
  }, []);

  // preset：从某把 Key 打开时预选这把 Key 与它按哪个时区算一天
  const openVerification = (station: any, preset?: { tokenId: number; timezone: string }) => {
    verificationEpoch.current += 1; setVerificationStation(station); setVerification(null); setVerificationTokenId(preset?.tokenId); setVerificationTimezone(preset?.timezone || DEFAULT_BUSINESS_TIME_ZONE); setVerificationError(null); setVerificationBusy(false);
  };
  const closeVerification = () => {
    verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); setVerificationBusy(false);
  };
  const verifyUpstream = async (selected: number | null = verificationTokenId ?? null) => {
    if (!verificationStation || verificationStation.isOwn || verificationStation.type === "newapi-key") return;
    const epoch = ++verificationEpoch.current; setVerificationBusy(true); setVerificationError(null);
    try {
      const params = new URLSearchParams({ force: "true", timezone: verificationTimezone });
      if (selected != null) params.set("tokenId", String(selected));
      const next: UpstreamKeyRead = await api(`/api/reconciliation/upstreams/${encodeURIComponent(verificationStation.id)}/keys?${params}`);
      if (epoch === verificationEpoch.current) setVerification(next);
    } catch (err: any) { if (epoch === verificationEpoch.current) { setVerification(null); const note = noteOf(err); setVerificationError({ ...note, text: testReadText({ ok: false, reason: note.text }) }); } }
    finally { if (epoch === verificationEpoch.current) setVerificationBusy(false); }
  };
  const confirmIdentity = async () => {
    if (!verificationStation || !verification?.identity || verificationBusy) return;
    const epoch = ++verificationEpoch.current; setVerificationBusy(true); setVerificationError(null);
    try {
      const saved: ResourceIdentityConfirmation = await api(`/api/channel-onboarding/resources/${encodeURIComponent(verificationStation.id)}/identity`, {
        method: "POST", body: { identity: verification.identity, resourceVersion: verification.resourceVersion },
      });
      if (epoch !== verificationEpoch.current) return;
      message.success(COPY.identityConfirmed(saved.identity.accountId));
      setExpandedAccounts([saved.accountKey]); setVerificationStation(null); setVerification(null); setVerificationBusy(false);
      verificationEpoch.current += 1;
      await reload();
    } catch (err: any) {
      if (epoch === verificationEpoch.current) { setVerification(null); setVerificationError({ text: failureText("保存失败", err), raw: describeError(err).raw }); }
    } finally { if (epoch === verificationEpoch.current) setVerificationBusy(false); }
  };
  useEffect(() => {
    if (!verificationStation) return;
    const current = stations.find((station) => station.id === verificationStation.id);
    if (!current || current.archivedAt || current.type !== verificationStation.type || current.authVersion !== verificationStation.authVersion || current.resourceVersion !== verificationStation.resourceVersion) {
      verificationEpoch.current += 1; setVerification(null); setVerificationBusy(false); setVerificationError({ text: DESTINATION_CHANGED, notice: true });
    }
  }, [stations, verificationStation]);
  // 只用 Key 的上游 / 自营站点读不到上游账号：去上游编辑页补登录信息
  const editVerificationOriginal = () => {
    const original = stations.find((station) => station.id === verificationStation?.id);
    if (!original) return;
    verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); openEditor(original);
  };

  // 抽屉里有下拉框：Esc 由抽屉自己处理（#413）
  useDrawerEscape(!!verificationStation, closeVerification);
  const confirmPurpose = async () => {
    if (!purposeTarget) return;
    setPurposeBusy(true); setPurposeError(null);
    try {
      if (purposeTarget.resource) {
        const resource = purposeTarget.resource;
        if (stations.some((station) => station.id === resource.id && station.isOwn)) throw notice(COPY.ownExcluded);
        await api(`/api/stations/${encodeURIComponent(resource.id!)}`, { method: "PUT", body: { monitorEnabled: purposeTarget.monitorEnabled === true, expectedAuthVersion: resource.authVersion, expectedResourceVersion: resource.resourceVersion } });
        message.success(purposeTarget.monitorEnabled ? RESUME.done : PAUSE.done);
      } else {
        if (!purposeTarget.association) throw notice(COPY.chooseBinding);
        await api(`/api/reconciliation/rules/${encodeURIComponent(purposeTarget.association.ruleId)}`, { method: "DELETE" }); message.success(UNBIND.done);
      }
    } catch (err: any) {
      setPurposeError(err?.notice ? noteOf(err) : { text: failureText(`${purposeLabel}失败`, err), raw: describeError(err).raw }); setPurposeBusy(false);
      return;
    }
    // 已经改好：之后重读失败不能再报成操作失败
    setPurposeBusy(false); setPurposeTarget(null);
    if (purposeTarget.association?.ruleId === focusRuleId) setFocusRuleId("");
    await reload().catch(() => {});
  };

  // ---- 筛选 ------------------------------------------------------------------
  const accountQuery = accountSearch.trim().toLowerCase();
  const matchesAccountQuery = (values: unknown[]) => values.join(" ").toLowerCase().includes(accountQuery);
  const needsAction = (account: AccountRecord) => account.actions.some((action) => action.kind !== "inspect_balance");
  const filteredAccounts = (accountModel?.accounts || []).filter((account) =>
    (accountFilter !== "attention" || needsAction(account)) &&
    matchesAccountQuery([account.accountKey, account.identity.provider, account.identity.baseUrl, account.identity.accountId,
      ...account.resources.flatMap((resource) => [resource.id, resource.name, resource.type]),
      ...account.keys.flatMap((key) => [key.tokenId, key.tokenName, ...key.channels.flatMap((channel) => [channel.channelId, channel.name]), ...(key.associations || []).map((association) => association.ruleId)])])
  );
  const accountSites = new Map<string, AccountRecord[]>();
  for (const account of filteredAccounts) accountSites.set(account.siteKey, [...(accountSites.get(account.siteKey) || []), account]);
  const unverifiedResources = (accountModel?.unverifiedResources || []).filter((resource) =>
    (showArchived || !resource.archivedAt) && matchesAccountQuery([resource.id, resource.name, resource.type, resource.baseUrl])
  );
  const unmatchedAssociations = (accountModel?.unmatchedAssociations || []).filter((association) =>
    matchesAccountQuery([association.ruleId, association.tokenId, association.tokenName, association.upstreamStationId, stations.find((station) => station.id === association.upstreamStationId)?.name,
      ...association.channels.flatMap((channel) => [channel.channelId, channel.name])])
  );
  const locateAssociation = (ruleId: string): { account: AccountRecord | null; key: AccountKeyScope | null; association: AccountAssociation } | null => {
    for (const account of accountModel?.accounts || []) for (const key of account.keys) {
      const association = (key.associations || []).find((item) => item.ruleId === ruleId);
      if (association) return { account, key, association };
    }
    const unmatched = accountModel?.unmatchedAssociations?.find((item) => item.ruleId === ruleId);
    return unmatched ? { account: null, key: null, association: unmatched } : null;
  };
  // 时间按业务时区显示；这条绑定按别的时区算一天时，在后面补一句（§6）
  const formatAt = (value: number | string | null | undefined, timezone: string) => {
    if (value == null) return COPY.notStarted;
    const text = formatZonedDateTime(value, businessTz);
    if (!text) return EMPTY;
    const dayZone = formatDayZone(timezone, businessTz);
    return dayZone ? `${text}（${dayZone}）` : text;
  };
  const channelNames = (channels: { channelId?: number; id?: number; name?: string }[]) => channels.map(reconciliationChannelName).join("、") || EMPTY;
  const otherUseText = (declaration: CoverageDeclaration) => {
    const option = coverageAnswerOption(declaration) || COVERAGE_ANSWERS.find((item: any) => item.value === "unknown");
    if (option?.value !== "own_channels" || !declaration.uncoveredOwnChannelIds.length) return option?.label || EMPTY;
    const names = declaration.uncoveredOwnChannelIds.map((id) => reconciliationChannelName(accountModel?.channels.find((channel) => channel.id === id) || { channelId: id }));
    return `${option.label}：${names.join("、")}`;
  };
  const ownStationName = (id: string) => stations.find((station) => station.id === id)?.name || EMPTY;
  // 这一页的 Key 名：各上游账号下的 Key 和没对上上游的绑定放在一起比，同名的都加上编号（§3.1）
  const keyTitle: (key: AccountKeyScope | AccountAssociation | UnmatchedAssociation) => string = reconciliationKeyNamer([...(accountModel?.accounts || []).flatMap((account) => account.keys), ...(accountModel?.unmatchedAssociations || [])]);
  const purposeLocked = loadingAccounts || !!accountError || authorizationBusy;

  // ---- 片段 ------------------------------------------------------------------
  // 处理入口保留真实链接（可复制、可在新标签打开）；本页能处理的普通点击直接在页内打开，不整页刷新
  const actionLink = (action: { id: string; href: string; label: string }) => (
    <Button
      key={action.id}
      size="small"
      href={action.href}
      onClick={(event) => {
        if (!action.href.startsWith("/stations") || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openWorkflow(action.href);
      }}
    >
      {action.label}
    </Button>
  );
  const actionLinks = (actions: { id: string; href: string; label: string }[]) => (actions.length ? (
    <div className="jy-accounts-actions">{actions.map(actionLink)}</div>
  ) : null);

  const renderAccountResource = (resource: PublicResource) => {
    const original = stations.find((station) => station.id === resource.id);
    return (
      <div key={resource.id} data-resource-id={resource.id} className="jy-accounts-resource">
        <div className="jy-accounts-line">
          <b>{resource.name}</b>
          {!resource.purposes.monitor ? <span className="jy-tag jy-tag--muted">{BINDING_COPY.monitorPaused}</span> : null}
          {resource.archivedAt ? <span className="jy-tag jy-tag--muted">{BINDING_COPY.archived}</span> : null}
          {resource.purposes.billingRuleIds.length ? <span className="jy-tag jy-tag--info">{BINDING_COPY.bindingCount(resource.purposes.billingRuleIds.length)}</span> : null}
        </div>
        <p className="jy-caption">{resource.baseUrl}</p>
        <p className="jy-caption">余额提醒线：{resource.lowBalanceUsd == null ? COPY.globalLine : formatUsd(resource.lowBalanceUsd)}；汇率：{formatRate(resource.cnyPerUsd) || RATE_UNSET_PARITY}；{resource.includeInProfit ? COPY.inProfit : COPY.notInProfit}{resource.noRenewal ? `；${COPY.noRenewal}` : ""}</p>
        {!resource.purposes.monitor ? <p className="jy-caption">{COPY.pausedHint}</p> : null}
        <div className="jy-accounts-actions">
          {original && !compact
            ? <Button size="small" disabled={loadingMeta || !types.length} aria-label={`${COPY.editUpstream} ${resource.name}`} onClick={() => openEditor(original)}>{COPY.editUpstream}</Button>
            : <span className="jy-caption">{COPY.editElsewhere}</span>}
          {!resource.archivedAt && !original?.isOwn ? (
            <Button
              size="small"
              disabled={purposeLocked}
              aria-label={`${resource.monitorEnabled ? PAUSE.label : RESUME.label} ${resource.name}`}
              onClick={() => { setPurposeError(null); setPurposeTarget({ resource, monitorEnabled: !resource.monitorEnabled }); }}
            >
              {resource.monitorEnabled ? PAUSE.label : RESUME.label}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  // 重复的绑定：同一把 Key 绑了两次的只能解除一条；同一个渠道绑了两把 Key 的也可以改绑定去掉重复的渠道
  const conflictBanner = (association: AccountAssociation) => {
    if (!association.conflict) return null;
    const keyConflicts = association.keyConflictRuleIds, channelConflicts = association.channelConflictRuleIds;
    // 服务端没拆开时两种都提示
    const known = !!keyConflicts && !!channelConflicts;
    const duplicateNames = association.channels.filter((channel) => (association.duplicateChannelIds || []).includes(channel.channelId)).map(reconciliationChannelName).join("、");
    const issues = [
      !known || keyConflicts.length ? { title: KEY_TWICE.title, detail: KEY_TWICE.detail } : null,
      !known || channelConflicts.length ? { title: fillIssueCopy(CHANNEL_TWICE.title, CHANNEL_TWICE.plain, { channel: duplicateNames }), detail: CHANNEL_TWICE.detail } : null,
    ].filter((item): item is { title: string; detail: string } => !!item);
    // 和它重复的那几条：按 Key 和自营站点说，不显示编号
    const others = association.conflictRuleIds.map(locateAssociation).filter((item) => !!item)
      .map((item) => `${keyTitle(item.key || item.association)} · ${BINDING_COPY.ownStation} ${ownStationName(item.association.ownStationId)}`);
    return (
      <div className="jy-banner" role="status">
        <Sym kind="warn" />
        <div className="jy-stations-banner-body">
          {issues.map((issue) => <p key={issue.title}><b>{issue.title}</b><span className="jy-caption">{issue.detail ? `：${issue.detail}` : ""}</span></p>)}
          {others.length ? <p className="jy-caption">{COPY.conflictWith([...new Set(others)].join("；"))}</p> : null}
        </div>
      </div>
    );
  };

  // 一条绑定：这把 Key 在某个自营站点下绑的渠道。按钮只放在在用的绑定上，解除后保留以前的每日记录
  const renderAssociation = (key: AccountKeyScope, association: AccountAssociation) => {
    const active = association.status === "active";
    // 固定成本的上游成本记 0，Key 还给不给别处用不影响利润
    const fixedCost = costBasisOf(stations.find((station) => station.id === association.upstreamStationId)) === "fixed";
    const target = `${keyTitle(key)} · ${ownStationName(association.ownStationId)}`;
    return (
      <li key={association.ruleId} data-rule-id={association.ruleId} className={`jy-accounts-association${focusRuleId === association.ruleId ? " is-focused" : ""}`}>
        <div className="jy-accounts-line">
          <b>{BINDING_COPY.ownStation} {ownStationName(association.ownStationId)}</b>
          {association.conflict ? <>{" "}<span className="jy-tag jy-tag--crit">{COPY.needsAction}</span></>
            : !active ? <>{" "}<span className="jy-tag jy-tag--muted">{COPY.unbound}</span></> : null}
        </div>
        <dl className="jy-accounts-facts">
          <dt>{COPY.channels}</dt><dd>{channelNames(association.channels)}</dd>
          {active
            ? <><dt>开始统计</dt><dd>{formatAt(association.accountingStartMs ?? association.billingEffectiveFromMs, association.timezone)}</dd></>
            : <><dt>解除时间</dt><dd>{formatAt(association.stoppedAt, association.timezone)}</dd></>}
          <dt>{COVERAGE_QUESTION}</dt><dd>{otherUseText(association.coverageDeclaration)}{active && !fixedCost && association.costCoverage !== "complete" ? `；${COPY.profitPaused}` : ""}</dd>
          {fixedCost ? <><dt>上游成本</dt><dd>{FIXED_COST_TEXT}</dd></> : null}
        </dl>
        {conflictBanner(association)}
        {active ? (
          <div className="jy-accounts-actions">
            <Button size="small" disabled={purposeLocked} aria-label={`${EDIT_BINDING.label} ${target}`} onClick={() => setEditTarget({ ruleId: association.ruleId, title: keyTitle(key), seq: ++editSeq.current, fixedCost })}>{EDIT_BINDING.label}</Button>
            <Button size="small" disabled={purposeLocked} aria-label={`${SWAP_KEY.label} ${target}`} onClick={() => openWorkflow(`/stations?action=coverage&ruleId=${encodeURIComponent(association.ruleId)}`)}>{SWAP_KEY.label}</Button>
            <Button size="small" danger disabled={purposeLocked} aria-label={`${UNBIND.label} ${target}`} onClick={() => { setPurposeError(null); setPurposeTarget({ keyLabel: keyTitle(key), association }); }}>{UNBIND.label}</Button>
          </div>
        ) : null}
      </li>
    );
  };

  // 还没归到 Key 下的在用绑定：照常算利润，给处理入口和解除入口
  const renderUnmatched = (association: UnmatchedAssociation) => {
    const issue = UNMATCHED_ISSUES[association.reason] || OWNER_UNVERIFIED;
    const upstream = stations.find((station) => station.id === association.upstreamStationId);
    const keyLabel = keyTitle(association);
    const actions = (accountModel?.actions || []).filter((action) => action.ruleId === association.ruleId
      || (!action.ruleId && action.stationId === association.upstreamStationId && ["verify_identity", "verify_capability"].includes(action.kind)));
    return (
      <li key={association.ruleId} data-rule-id={association.ruleId} className={`jy-accounts-association${focusRuleId === association.ruleId ? " is-focused" : ""}`}>
        <div className="jy-accounts-line">
          <b>{keyLabel}</b>
          {" "}
          <span className={`jy-tag ${association.conflict ? "jy-tag--crit" : "jy-tag--warn"}`}>{COPY.needsAction}</span>
        </div>
        <p className="jy-caption">{issue.title}{issue.detail ? `：${issue.detail}` : ""}</p>
        <dl className="jy-accounts-facts">
          <dt>上游</dt><dd>{upstream?.name || EMPTY}</dd>
          <dt>{BINDING_COPY.ownStation}</dt><dd>{ownStationName(association.ownStationId)}</dd>
          <dt>{COPY.channels}</dt><dd>{channelNames(association.channels)}</dd>
          <dt>开始统计</dt><dd>{formatAt(association.accountingStartMs ?? association.billingEffectiveFromMs, association.timezone)}</dd>
        </dl>
        {conflictBanner(association)}
        <div className="jy-accounts-actions">
          {actions.map(actionLink)}
          <Button size="small" danger disabled={purposeLocked} aria-label={`${UNBIND.label} ${keyLabel} · ${ownStationName(association.ownStationId)}`} onClick={() => { setPurposeError(null); setPurposeTarget({ keyLabel, association }); }}>{UNBIND.label}</Button>
        </div>
      </li>
    );
  };

  const renderKey = (key: AccountKeyScope) => {
    const associations = key.associations || [];
    const current = associations.filter((association) => association.status === "active");
    const conflict = key.scopeAmbiguous || current.some((association) => association.conflict);
    // 用绑定所在上游的登录信息测试读取这把 Key
    const basis = current[0] || associations[0];
    const verifyStation = basis ? stations.find((station) => station.id === basis.upstreamStationId && !station.archivedAt) : null;
    return {
      key: key.canonicalKey,
      label: (
        <span className="jy-accounts-line">
          <b>{keyTitle(key)}</b>
          {" "}
          <span className={`jy-tag ${conflict ? "jy-tag--crit" : current.length ? "jy-tag--info" : "jy-tag--muted"}`}>
            {conflict ? COPY.needsAction : current.length ? COPY.activeCount(current.length) : associations.length ? COPY.unbound : COPY.notBound}
          </span>
        </span>
      ),
      children: (
        <div data-canonical-key={key.canonicalKey} className="jy-accounts-key">
          <div className="jy-accounts-actions">
            <Button
              size="small"
              disabled={!verifyStation || verificationBusy}
              aria-label={`${TEST_READ.label} ${keyTitle(key)}`}
              onClick={() => openVerification(verifyStation, { tokenId: key.tokenId, timezone: basis!.timezone })}
            >
              {TEST_READ.label}
            </Button>
          </div>
          {associations.length ? (
            <ul className="jy-accounts-associations" aria-label={`${keyTitle(key)} 的${COPY.bindings}`}>
              {associations.map((association) => renderAssociation(key, association))}
            </ul>
          ) : <p className="jy-caption">{COPY.keyNotBound}</p>}
        </div>
      ),
    };
  };

  const renderAccount = (account: AccountRecord) => {
    const resources = account.resources.filter((resource) => showArchived || !resource.archivedAt);
    const pending = [...new Set(account.actions.filter((action) => action.kind !== "inspect_balance").map((action) => action.label))].join("、");
    return {
      key: account.accountKey,
      label: (
        <span className="jy-accounts-line">
          <b>上游账号 {account.identity.accountId}</b>
          {" "}
          <span className="jy-caption">{resources.length} 个上游 · {account.keys.length} 把 Key</span>
          {needsAction(account) ? <>{" "}<span className="jy-tag jy-tag--warn">{COPY.needsAction}</span></> : null}
        </span>
      ),
      children: (
        <div data-account-key={account.accountKey} className="jy-accounts-account">
          <p className="jy-accounts-line">
            <span className="jy-caption">{account.identity.baseUrl}</span>
          </p>
          {account.actions.some((action) => action.kind === "update_authorization") ? <p className="jy-caption">{COPY.loginOutdated}</p> : null}
          <p className="jy-accounts-pending">{pending ? `${COPY.needsAction}：${pending}` : NOTHING_TO_HANDLE}</p>
          <div className="jy-accounts-actions">
            {account.actions.map(actionLink)}
            <Button
              size="small"
              disabled={purposeLocked || !authorizationEligible(account).length}
              aria-label={`${UPDATE_LOGIN.label} 上游账号 ${account.identity.accountId}`}
              onClick={() => openAuthorization(account)}
            >
              {UPDATE_LOGIN.label}
            </Button>
          </div>
          <div className="jy-accounts-group">
            {resources.map(renderAccountResource)}
            {account.resources.some((resource) => resource.archivedAt) && !showArchived ? <p className="jy-caption">{COPY.archivedHint}</p> : null}
          </div>
          {account.keys.length ? (
            <Collapse
              ghost
              size="small"
              className="jy-accounts-keys"
              activeKey={expandedKeys}
              onChange={(keys) => {
                // 只改这个上游账号下的 Key，别的上游账号展开着的保持不变
                const own = new Set(account.keys.map((key) => key.canonicalKey)), next = (Array.isArray(keys) ? keys : [keys]).map(String);
                setExpandedKeys((current) => [...current.filter((key) => !own.has(key)), ...next]);
              }}
              items={account.keys.map(renderKey)}
            />
          ) : <p className="jy-caption">{COPY.noKeys}</p>}
        </div>
      ),
    };
  };

  // ---- 事项（从运营总览、每日利润跳转而来）-------------------------------------------
  const inspectTargets = destination?.action === "inspect"
    ? stations.filter((station) => destination.stationId ? station.id === destination.stationId : accountModel?.accounts.find((account) => account.accountKey === destination.accountKey)?.resources.some((resource) => resource.id === station.id))
    : [];
  const top = (
    <>
      {workflowError ? (
        <div className="jy-banner" role="alert">
          <Sym kind="warn" />
          <div className="jy-stations-banner-body"><b>{workflowError}</b></div>
          <div className="jy-accounts-actions">
            <Button size="small" onClick={() => window.location.reload()}>{REFRESH.label}</Button>
            <Button size="small" href="/stations">返回{STATION_TABS.list}</Button>
          </div>
        </div>
      ) : null}
      {destination?.action === "inspect" && !workflowError ? (
        <section className="jy-panel jy-accounts-inspect" aria-label={INSPECT.label}>
          <div className="jy-panel-head"><h2>{INSPECT.label}</h2></div>
          <p className="jy-panel-sub">{COPY.inspectSub}</p>
          <div className="jy-panel-body">
            {inspectTargets.length ? inspectTargets.map((station) => (
              <div key={station.id} className="jy-accounts-resource">
                <div className="jy-accounts-line"><b>{station.name}</b></div>
                <p className="jy-caption">{[station.monitorEnabled === false ? BINDING_COPY.monitorPaused : "", station.balance?.ok ? `余额 ${formatUsd(station.balance.remaining)}` : station.balance ? COPY.balanceUnread : COPY.notRead].filter(Boolean).join(" · ")}</p>
                <div className="jy-accounts-actions">
                  <Button size="small" disabled={!types.length} onClick={() => openEditor(station)}>{COPY.editUpstream}</Button>
                  {station.monitorEnabled !== false && !station.archivedAt ? <Button size="small" onClick={() => openTrend(station)}>{INSPECT.label}</Button> : null}
                </div>
              </div>
            )) : loaded ? <p className="jy-caption">{ERROR_CATEGORIES.not_found.text}。</p> : <Skeleton height={36} />}
          </div>
        </section>
      ) : null}
    </>
  );

  // ---- 上游账单 ----------------------------------------------------------------
  let body: ReactNode;
  if (loadingAccounts && !accountModel && !accountError) {
    body = (
      <div className="jy-accounts-skeleton" aria-busy="true">
        <span className="sr-only">正在读取{STATION_TABS.bills}…</span>
        {[0, 1, 2].map((i) => <Skeleton key={i} height={36} />)}
      </div>
    );
  } else {
    body = (
      <>
        <div className="jy-toolbar jy-accounts-toolbar">
          <Input
            prefix={<Icon name="search" />}
            aria-label={`搜索${STATION_TABS.bills}`}
            allowClear
            placeholder={COPY.searchPlaceholder}
            value={accountSearch}
            onChange={(event) => setAccountSearch(event.target.value)}
          />
          <Select
            aria-label="筛选上游账号"
            className="jy-accounts-filter"
            value={accountFilter}
            onChange={setAccountFilter}
            options={[{ value: "all", label: COPY.allAccounts }, { value: "attention", label: COPY.needsAction }]}
          />
          <Button aria-pressed={showArchived} onClick={() => setShowArchived((current) => !current)}>
            {showArchived ? COPY.hideArchived : COPY.showArchived}
          </Button>
          {authorizationRecoveryButton}
        </div>
        {accountError ? (
          <div className="jy-banner" role="alert">
            <Sym kind="warn" />
            <div className="jy-stations-banner-body">
              {accountError.notice ? <b>{accountError.text}</b>
                : accountModel ? <><b>{refreshFailedText(accountModel.generatedAt, businessTz)}</b><p className="jy-caption">{accountError.text}</p></>
                : <b>{failureSentence(`读不到${STATION_TABS.bills}`, accountError.text)}</b>}
              <ErrorDetail raw={accountError.raw} />
            </div>
            <Button size="small" aria-label={`${REFRESH.label}${STATION_TABS.bills}`} onClick={() => void loadAccounts()}>{REFRESH.label}</Button>
          </div>
        ) : null}
        {accountModel ? (
          <p className="jy-caption">
            {[COPY.accountCount(filteredAccounts.length), COPY.unverifiedCount(unverifiedResources.length), accountModel.unmatchedAssociations?.length ? COPY.unmatchedCount(unmatchedAssociations.length) : ""].filter(Boolean).join("；")}
            {" · "}{formatAsOf(accountModel.generatedAt, businessTz)}
          </p>
        ) : null}
        {actionLinks(accountModel?.actions.filter((action) => action.kind === "review_source") || [])}
        {[...accountSites].map(([siteKey, accounts]) => (
          <div key={siteKey} data-site-key={siteKey} className="jy-accounts-site">
            <h3>{accounts[0].identity.baseUrl}</h3>
            <Collapse
              className="jy-accounts-collapse"
              activeKey={expandedAccounts}
              onChange={(keys) => setExpandedAccounts(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
              items={accounts.map(renderAccount)}
            />
          </div>
        ))}
        {!filteredAccounts.length && accountModel ? (
          <p className="jy-accounts-empty">{accountModel.accounts.length ? COPY.noMatchedAccounts : COPY.noAccounts}</p>
        ) : null}
        {accountModel?.unmatchedAssociations?.length ? (
          <div className="jy-accounts-unverified" data-unmatched-associations>
            <h3>{COPY.unmatchedTitle}</h3>
            <p className="jy-caption">{COPY.unmatchedSub}</p>
            {unmatchedAssociations.length ? (
              <ul className="jy-accounts-associations" aria-label={COPY.unmatchedTitle}>{unmatchedAssociations.map(renderUnmatched)}</ul>
            ) : <p className="jy-caption">{COPY.noMatchedBindings}</p>}
          </div>
        ) : null}
        <div className="jy-accounts-unverified">
          <h3>{COPY.unverifiedTitle}</h3>
          <p className="jy-caption">{COPY.unverifiedSub}</p>
          {unverifiedResources.map((resource) => {
            const actions = accountModel?.actions.filter((action) => action.stationId === resource.id) || [];
            return (
              <div key={resource.id} data-unverified-resource-id={resource.id} className="jy-accounts-unverified-item">
                <span className="jy-tag jy-tag--warn">{resource.type === "newapi-key" ? BINDING_COPY.keyOnly : COPY.ownerUnknown}</span>
                {renderAccountResource(resource)}
                <p className="jy-caption">{COPY.matchedChannels}：{channelNames(accountModel?.channels.filter((channel) => channel.monitor.stationIds.includes(resource.id!)) || [])}</p>
                <p className="jy-accounts-pending">{COPY.needsAction}：{actions.map((action) => action.label).join("、") || TEST_READ.label}</p>
                {actionLinks(actions)}
              </div>
            );
          })}
          {!unverifiedResources.length && accountModel ? <p className="jy-caption">{COPY.noMatchedUpstreams}</p> : null}
        </div>
      </>
    );
  }

  const center = (
    <section className="jy-panel jy-accounts" aria-label={STATION_TABS.bills}>
      <div className="jy-panel-head">
        <h2>{STATION_TABS.bills}</h2>
        {accountModel ? <CountBadge count={accountModel.accounts.length} muted /> : null}
        <span className="spacer" />
        <div className="extra">
          <Button size="small" icon={<Icon name="refresh" />} loading={loadingAccounts} onClick={() => void loadAccounts()}>{REFRESH.label}</Button>
        </div>
      </div>
      <p className="jy-panel-sub">{COPY.centerSub}</p>
      <div className="jy-panel-body jy-accounts-body">{body}</div>
    </section>
  );

  // ---- 抽屉与确认 ----------------------------------------------------------------
  // 确认框的按钮名：暂停监控 / 恢复监控 / 解除绑定
  const purposeLabel = purposeTarget?.resource ? (purposeTarget.monitorEnabled ? RESUME.label : PAUSE.label) : UNBIND.label;
  const capability = verification ? (verification.probe?.capability || verification.capability) : null;
  const billingTimezone = verification ? (verification.probe?.billingTimezone || verification.billingTimezone) : null;
  const overlays = (
    <>
      <Drawer
        className="jy-drawer"
        title={`${TEST_READ.label}${verificationStation ? ` · ${verificationStation.name}` : ""}`}
        open={!!verificationStation}
        size={compact ? "100%" : 600}
        keyboard={false}
        onClose={closeVerification}
      >
        {verificationStation ? (
          <Space orientation="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
            <Text>{verificationStation.baseUrl}</Text>
            <Alert type="info" showIcon title={COPY.readOnlyTitle} description={COPY.readOnlyDetail} />
            {verificationError ? <Alert type="warning" showIcon title={verificationError.text} description={verificationError.raw ? <ErrorDetail raw={verificationError.raw} /> : undefined} action={<Button onClick={() => window.location.reload()}>{REFRESH.label}</Button>} /> : null}
            {verificationStation.isOwn || verificationStation.type === "newapi-key" ? (
              <Alert
                type="warning"
                showIcon
                title={verificationStation.isOwn ? COPY.ownStation : COPY.keyOnlyTitle}
                description={COPY.addLoginHint}
                action={<Space wrap><Button disabled={!types.length} onClick={editVerificationOriginal}>{UPDATE_LOGIN.label}</Button><Button href="/stations">{CONNECT.label}</Button></Space>}
              />
            ) : (
              <>
                <div>
                  <Text strong>{COPY.timezone}</Text>
                  <Input aria-label={COPY.timezone} value={verificationTimezone} disabled={verificationBusy} onChange={(event) => { verificationEpoch.current += 1; setVerificationTimezone(event.target.value); setVerification(null); setVerificationTokenId(undefined); setVerificationError(null); }} />
                  <Text type="secondary">{COPY.timezoneHelp}</Text>
                </div>
                <Button loading={verificationBusy} onClick={() => void verifyUpstream(null)}>{TEST_READ.label}</Button>
                {!verification && verificationTokenId != null ? (
                  <Button type="primary" loading={verificationBusy} onClick={() => void verifyUpstream()}>{COPY.testReadKey}</Button>
                ) : null}
                {verification ? (
                  <>
                    <Alert type={verification.identity ? "success" : "warning"} showIcon title={verification.identity ? COPY.identityRead(verification.identity.accountId) : COPY.identityUnread} description={verification.identity ? COPY.identityHint : undefined} />
                    {verification.identity ? <Button type="primary" loading={verificationBusy} disabled={verificationBusy} onClick={() => void confirmIdentity()}>{COPY.confirmIdentity}</Button> : null}
                    {verification.capability?.reason === "KEY_METADATA_UNAVAILABLE" ? (
                      <Alert type="warning" showIcon title={testReadText({ ok: false, reason: errorText({ code: "KEY_METADATA_UNAVAILABLE" }) })} description={COPY.keyListUnread} />
                    ) : (
                      <>
                        <Select aria-label={COPY.chooseKey} style={{ width: "100%" }} value={verificationTokenId} disabled={verificationBusy} placeholder={COPY.chooseKey} options={verification.tokens.map((key, _, all) => ({ value: key.id, label: [reconciliationKeyName({ tokenName: key.name, tokenId: key.id }, all.map((other) => ({ tokenName: other.name, tokenId: other.id }))), key.maskedKey || "", key.group ? COPY.group(key.group) : ""].filter(Boolean).join(" · "), disabled: key.status !== 1 }))} onChange={(tokenId) => { verificationEpoch.current += 1; setVerificationTokenId(tokenId); setVerification((previous) => previous ? { ...previous, probe: null } : null); setVerificationError(null); }} />
                        <Button disabled={verificationTokenId == null || verificationBusy} loading={verificationBusy} onClick={() => void verifyUpstream()}>{COPY.testReadSelected}</Button>
                        {!verification.tokens.length ? <Text type="secondary">{COPY.noTokens}</Text> : null}
                      </>
                    )}
                    <Text>{capability?.state === "supported" ? testReadText({ ok: true }) : capability?.state === "unsupported" ? reconciliationChannelStatus("unsupported").label : COPY.billNotRead}</Text>
                    {capability?.state === "unsupported" ? <ErrorDetail raw={capability.message || capability.reason} /> : null}
                    {billingTimezone?.state === "verified"
                      ? (formatDayZone(billingTimezone.timezone, businessTz) ? <Text>{formatDayZone(billingTimezone.timezone, businessTz)}</Text> : null)
                      : billingTimezone ? <Text type="warning">{TIMEZONE_UNVERIFIED.title}</Text> : null}
                    {verification.probe ? (
                      <Alert
                        type={verification.probe.complete && verification.probe.billingTimezone?.state === "verified" ? "info" : "warning"}
                        showIcon
                        title={`${reconciliationKeyName({ tokenName: verification.tokens.find((key) => key.id === verification.probe!.tokenId)?.name, tokenId: verification.probe.tokenId }, verification.tokens.map((other) => ({ tokenName: other.name, tokenId: other.id })))} 的上游成本`}
                        description={
                          <div>
                            <div>{formatZonedRange(verification.probe.window.startMs, verification.probe.window.endMs, businessTz)}{formatDayZone(verification.probe.window.timezone, businessTz) ? `（${formatDayZone(verification.probe.window.timezone, businessTz)}）` : ""}</div>
                            <div>{COPY.upstreamCost(formatUsd(verification.probe.actualCostUsd ?? verification.probe.amountUsd))}</div>
                            <div>{verification.probe.complete ? testReadText({ ok: true }) : COPY.probeIncomplete}；{COPY.probeHint}</div>
                          </div>
                        }
                      />
                    ) : null}
                  </>
                ) : null}
                <Button disabled={!types.length || verificationBusy} onClick={editVerificationOriginal}>{UPDATE_LOGIN.label}</Button>
              </>
            )}
          </Space>
        ) : null}
      </Drawer>

      {authorizationOverlay}

      <Modal
        title={purposeTarget?.resource ? `${purposeLabel}「${purposeTarget.resource.name}」？` : `${UNBIND.label}？`}
        open={!!purposeTarget}
        onCancel={() => { if (!purposeBusy) setPurposeTarget(null); }}
        closable={!purposeBusy}
        mask={{ closable: !purposeBusy }}
        keyboard={!purposeBusy}
        confirmLoading={purposeBusy}
        onOk={() => void confirmPurpose()}
        okButtonProps={{ disabled: !purposeTarget?.resource && !purposeTarget?.association, "aria-label": `确认${purposeLabel}` }}
        okText={purposeLabel}
        cancelText="取消"
        width={520}
      >
        <div className="jy-accounts-purpose">
          {purposeError ? (
            <div className="jy-banner jy-banner--crit" role="alert">
              <Sym kind="crit" />
              <div className="jy-stations-banner-body"><b>{purposeError.text}</b><ErrorDetail raw={purposeError.raw} /></div>
            </div>
          ) : null}
          {purposeTarget?.resource ? (
            <>
              <p>{purposeTarget.monitorEnabled ? COPY.resumeText : COPY.pauseText}</p>
              <dl className="jy-accounts-facts">
                <dt>{COPY.profit}</dt><dd>{purposeTarget.resource.includeInProfit ? COPY.inProfit : COPY.notInProfit}</dd>
                <dt>{COPY.channels}</dt><dd>{channelNames(accountModel?.channels.filter((channel) => channel.monitor.stationIds.includes(purposeTarget.resource!.id!)) || [])}</dd>
                <dt>{COPY.bindings}</dt><dd>{purposeTarget.resource.purposes.billingRuleIds.length} 条</dd>
              </dl>
            </>
          ) : purposeTarget?.association ? (
            <>
              <p>{COPY.unbindHint}</p>
              <dl className="jy-accounts-facts">
                <dt>Key</dt><dd>{purposeTarget.keyLabel || EMPTY}</dd>
                <dt>{BINDING_COPY.ownStation}</dt><dd>{ownStationName(purposeTarget.association.ownStationId)}</dd>
                <dt>{COPY.freedChannels}</dt><dd>{channelNames(purposeTarget.association.channels)}</dd>
              </dl>
            </>
          ) : null}
        </div>
      </Modal>

      <AssociationEditor target={editTarget} compact={compact} businessTz={businessTz} onClose={() => setEditTarget(null)} onSaved={reload} />
    </>
  );

  return { destination, destinationSeq, openWorkflow, top, center, overlays };
}
