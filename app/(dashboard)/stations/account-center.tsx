"use client";
// 账号关系中心：按已核验的上游账号查看资源、Key 与本站渠道，并承接总览/对账带来的处理目标
// （核验账号、更新账号授权、暂停/启用监控、停止 Key 核算）。
// 流程与文案沿用 main 的上游资源页，这里只换成新外观；资源列表与编辑抽屉仍由页面持有。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, App, Button, Checkbox, Collapse, Drawer, Form, Input, Modal, Select, Space, Typography } from "antd";
import { api, usd, readWorkflowDestination } from "../../../lib/client";
import type { AccountReadModel, AccountRecord, AccountKeyScope, PublicResource, AccountAuthorizationInput, AccountAuthorizationProbe, AccountAuthorizationResult, AccountAuthorizationRecoveryIntent, WorkflowDestination, UpstreamKeyRead, ResourceIdentityConfirmation } from "../../../lib/client";
import { Skeleton } from "../../components/data-state";
import { Icon, Sym } from "../../components/icons";
import { CountBadge } from "../../components/panel";
import { publishAccountActions } from "../../components/use-workflow-actions";

const { Text } = Typography;
const AUTHORIZATION_RECOVERY_KEY = "account-authorization-recovery-v05";

type AccountCenterProps = {
  // 完整资源列表：含暂停监控与归档资源
  stations: any[];
  types: any[];
  loadingMeta: boolean;
  compact: boolean;
  showArchived: boolean;
  loaded: boolean;
  loadingList: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  // 页面每次读取资源后递增，账号关系随之重读
  reloadToken: number;
  openEditor: (station: any) => void;
  openTrend: (station: any) => void;
};

export function useAccountCenter({
  stations, types, loadingMeta, compact, showArchived, loaded, loadingList, loadError, reload, reloadToken, openEditor, openTrend,
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
  const [accountError, setAccountError] = useState("");
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [destinationSeq, setDestinationSeq] = useState(0);
  const [workflowError, setWorkflowError] = useState("");
  const [expandedAccounts, setExpandedAccounts] = useState<string[]>([]);
  const destinationResolved = useRef(false);
  const [verificationStation, setVerificationStation] = useState<any>(null);
  const [verification, setVerification] = useState<UpstreamKeyRead | null>(null);
  const [verificationTimezone, setVerificationTimezone] = useState("Asia/Shanghai");
  const [verificationTokenId, setVerificationTokenId] = useState<number>();
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const verificationEpoch = useRef(0);
  const accountReadEpoch = useRef(0);
  const [authorizationAccount, setAuthorizationAccount] = useState<AccountRecord | null>(null);
  const [authorizationTargets, setAuthorizationTargets] = useState<string[]>([]);
  const [authorizationRequestId, setAuthorizationRequestId] = useState("");
  const [authorizationProbe, setAuthorizationProbe] = useState<AccountAuthorizationProbe | null>(null);
  const [authorizationResult, setAuthorizationResult] = useState<AccountAuthorizationResult | null>(null);
  const [authorizationError, setAuthorizationError] = useState("");
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [reuseAuthorization, setReuseAuthorization] = useState(false);
  const [previouslyUpdatedIds, setPreviouslyUpdatedIds] = useState<string[]>([]);
  const [authorizationRecovery, setAuthorizationRecovery] = useState<{ accountKey: string; retryInput: AccountAuthorizationRecoveryIntent } | null>(null);
  const [authorizationForm] = Form.useForm();
  const authorizationType = Form.useWatch("type", authorizationForm) || "newapi";
  const authorizationEpoch = useRef(0);
  const [purposeTarget, setPurposeTarget] = useState<{ resource?: PublicResource; monitorEnabled?: boolean; key?: AccountKeyScope; ruleId?: string } | null>(null);
  const [purposeBusy, setPurposeBusy] = useState(false);
  const [purposeError, setPurposeError] = useState("");

  const loadAccounts = useCallback(async () => {
    const current = ++accountReadEpoch.current;
    setLoadingAccounts(true);
    try {
      const next: AccountReadModel = await api("/api/channel-onboarding/accounts");
      if (current === accountReadEpoch.current) { setAccountModel(next); setAccountError(""); publishAccountActions(next.actions); }
    } catch (err: any) {
      if (current === accountReadEpoch.current) setAccountError(err.message || "账号关系暂不可用");
    } finally {
      if (current === accountReadEpoch.current) setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    if (reloadToken) void loadAccounts();
  }, [reloadToken, loadAccounts]);

  useEffect(() => {
    setDestination(readWorkflowDestination(window.location.search, "stations"));
    try {
      const stored = JSON.parse(sessionStorage.getItem(AUTHORIZATION_RECOVERY_KEY) || "null");
      if (/^[a-f0-9]{64}$/.test(stored?.accountKey || "") && typeof stored.retryInput?.requestId === "string" && Array.isArray(stored.retryInput.targetStationIds) && stored.retryInput.targetStationIds.every((id: any) => typeof id === "string")) {
        setAuthorizationRecovery({ accountKey: stored.accountKey, retryInput: { requestId: stored.retryInput.requestId, targetStationIds: [...stored.retryInput.targetStationIds] } });
      }
    } catch { /* 不阻断资源读取。 */ }
    return () => { authorizationEpoch.current += 1; accountReadEpoch.current += 1; };
  }, []);

  useEffect(() => {
    if (!destination || destinationResolved.current || !loaded || !accountModel || loadingAccounts || loadingList || accountError || loadError) return;
    if (["connect", "coverage", "source"].includes(destination.action) && !destination.error) return;
    destinationResolved.current = true;
    if (destination.error) { setWorkflowError(destination.error); return; }
    const account = accountModel.accounts.find((account) => account.accountKey === destination.accountKey || account.resources.some((resource) => resource.id === destination.stationId));
    if (["verify", "verify-billing"].includes(destination.action)) {
      const original = stations.find((station) => station.id === destination.stationId && !station.archivedAt);
      if (!original) { setWorkflowError("此资源已删除或归档，请刷新当前事项后重新打开。"); return; }
      if (!["newapi", "newapi-key", "sub2api", "sub2api-password"].includes(original.type)) { setWorkflowError("此资源不支持账号与 Key 账单核验，请返回原资源设置。"); return; }
      openVerification(original);
    } else if (destination.action === "authorization") {
      if (!account || account.accountKey !== destination.accountKey || !authorizationEligible(account).length) { setWorkflowError("此账号或可更新目标已变化，请刷新当前账号关系后重新打开。"); return; }
      openAuthorization(account);
    } else {
      const original = stations.find((station) => station.id === destination.stationId);
      if (!account && !original) { setWorkflowError("此资源已删除、归档或不在当前目录中，请刷新当前事项后重新打开。"); return; }
    }
    setAccountSearch(account?.accountKey || destination.stationId || "");
    if (account) setExpandedAccounts([account.accountKey]);
  // 只在当前资源与账号读取均成功后定位，自动刷新不重复打开授权流程。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, loaded, accountModel, loadingAccounts, loadingList, accountError, loadError]);

  // 在页面内打开处理目标（不整页刷新），与从总览、账单核算跳转进来走同一套定位逻辑
  const openWorkflow = useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
    destinationResolved.current = false;
    setWorkflowError("");
    setDestination(readWorkflowDestination(url.search, "stations"));
    setDestinationSeq((n) => n + 1);
  }, []);

  const openVerification = (station: any) => {
    verificationEpoch.current += 1; setVerificationStation(station); setVerification(null); setVerificationTokenId(undefined); setVerificationTimezone("Asia/Shanghai"); setVerificationError(""); setVerificationBusy(false);
  };
  const closeVerification = () => {
    verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); setVerificationBusy(false);
  };
  const verifyUpstream = async (selected: number | null = verificationTokenId ?? null) => {
    if (!verificationStation || verificationStation.isOwn || verificationStation.type === "newapi-key") return;
    const epoch = ++verificationEpoch.current; setVerificationBusy(true); setVerificationError("");
    try {
      const params = new URLSearchParams({ force: "true", timezone: verificationTimezone });
      if (selected != null) params.set("tokenId", String(selected));
      const next: UpstreamKeyRead = await api(`/api/reconciliation/upstreams/${encodeURIComponent(verificationStation.id)}/keys?${params}`);
      if (epoch === verificationEpoch.current) setVerification(next);
    } catch (err: any) { if (epoch === verificationEpoch.current) { setVerification(null); setVerificationError(err.message || "实际核验暂不可用，请检查授权或稍后重试"); } }
    finally { if (epoch === verificationEpoch.current) setVerificationBusy(false); }
  };
  const confirmIdentity = async () => {
    if (!verificationStation || !verification?.identity || verificationBusy) return;
    const epoch = ++verificationEpoch.current; setVerificationBusy(true); setVerificationError("");
    try {
      const saved: ResourceIdentityConfirmation = await api(`/api/channel-onboarding/resources/${encodeURIComponent(verificationStation.id)}/identity`, {
        method: "POST", body: { identity: verification.identity, resourceVersion: verification.resourceVersion },
      });
      if (epoch !== verificationEpoch.current) return;
      message.success(`账号 ${saved.identity.accountId} 的身份已保存`);
      setExpandedAccounts([saved.accountKey]); setVerificationStation(null); setVerification(null); setVerificationBusy(false);
      verificationEpoch.current += 1;
      await reload();
    } catch (err: any) {
      if (epoch === verificationEpoch.current) { setVerification(null); setVerificationError(err.message || "身份未能保存，请重新核验后确认"); }
    } finally { if (epoch === verificationEpoch.current) setVerificationBusy(false); }
  };
  useEffect(() => {
    if (!verificationStation) return;
    const current = stations.find((station) => station.id === verificationStation.id);
    if (!current || current.archivedAt || current.type !== verificationStation.type || current.authVersion !== verificationStation.authVersion || current.resourceVersion !== verificationStation.resourceVersion) {
      verificationEpoch.current += 1; setVerification(null); setVerificationBusy(false); setVerificationError("资源配置已变化，请关闭此处并刷新处理目标后重新核验。");
    }
  }, [stations, verificationStation]);
  // 纯 Key / 本站资源不能核验账号：改去原资源设置补授权
  const editVerificationOriginal = () => {
    const original = stations.find((station) => station.id === verificationStation?.id);
    if (!original) return;
    verificationEpoch.current += 1; setVerificationStation(null); setVerification(null); openEditor(original);
  };

  const rememberAuthorization = (accountKey: string, intent: AccountAuthorizationRecoveryIntent | null) => {
    const safe = intent ? { accountKey, retryInput: { requestId: intent.requestId, targetStationIds: [...intent.targetStationIds] } } : null;
    setAuthorizationRecovery(safe);
    try { if (safe) sessionStorage.setItem(AUTHORIZATION_RECOVERY_KEY, JSON.stringify(safe)); else sessionStorage.removeItem(AUTHORIZATION_RECOVERY_KEY); } catch { /* 当前抽屉仍可核对。 */ }
  };
  const authorizationName = (id: string) => accountModel?.accounts.flatMap((account) => account.resources).find((resource) => resource.id === id)?.name || accountModel?.unverifiedResources.find((resource) => resource.id === id)?.name || stations.find((station) => station.id === id)?.name || id;
  const authorizationEligible = (account: AccountRecord) => account.resources.filter((resource) => !resource.archivedAt && resource.type !== "newapi-key" && !stations.some((station) => station.id === resource.id && station.isOwn));
  const initializeAuthorizationForm = (account: AccountRecord) => {
    authorizationForm.resetFields();
    authorizationForm.setFieldsValue({ type: account.identity.provider === "newapi" ? "newapi" : authorizationEligible(account)[0]?.type || "sub2api" });
  };
  const openAuthorization = (account: AccountRecord) => {
    authorizationEpoch.current += 1; setAuthorizationAccount(account); setAuthorizationTargets(authorizationEligible(account).map((resource) => resource.id!)); setAuthorizationRequestId(crypto.randomUUID()); setAuthorizationProbe(null); setAuthorizationResult(null); setAuthorizationError(""); setReuseAuthorization(false); setPreviouslyUpdatedIds([]); initializeAuthorizationForm(account);
  };
  const freshAuthorization = () => {
    if (!authorizationAccount) return;
    const saved = authorizationResult?.targets.filter((target) => ["updated", "already_updated"].includes(target.status)).map((target) => target.stationId) || [];
    const remaining = authorizationResult?.targets.filter((target) => !saved.includes(target.stationId) && !authorizationResult.excluded.some((item) => item.stationId === target.stationId)).map((target) => target.stationId);
    setPreviouslyUpdatedIds([...new Set([...previouslyUpdatedIds, ...saved])]); if (remaining) setAuthorizationTargets(remaining);
    authorizationEpoch.current += 1; setAuthorizationRequestId(crypto.randomUUID()); setAuthorizationProbe(null); setAuthorizationResult(null); setReuseAuthorization(false); initializeAuthorizationForm(authorizationAccount);
  };
  const authorizationInput = async (reuse = reuseAuthorization): Promise<AccountAuthorizationInput> => {
    if (!authorizationAccount || !authorizationTargets.length) throw new Error("请选择明确的更新目标");
    const intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    if (reuse) return { ...intent, reuseSavedAuthorization: true };
    const values = await authorizationForm.validateFields();
    return { ...intent, authorization: { type: values.type, baseUrl: authorizationAccount.identity.baseUrl,
      ...(values.type === "sub2api-password" ? { email: values.email, password: values.password } : { accessToken: values.accessToken }),
      ...(values.type === "newapi" ? { userId: authorizationAccount.identity.accountId } : {}) } };
  };
  const probeAuthorization = async (reuse = reuseAuthorization) => {
    const current = ++authorizationEpoch.current; setAuthorizationError(""); setAuthorizationBusy(true);
    try {
      const input = await authorizationInput(reuse);
      if (current !== authorizationEpoch.current) return;
      const next: AccountAuthorizationProbe = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(authorizationAccount!.accountKey)}/authorization/probe`, { body: input });
      if (current !== authorizationEpoch.current) return;
      setAuthorizationProbe(next); setReuseAuthorization(reuse); rememberAuthorization(next.accountKey, next.retryInput);
      if (reuse) authorizationForm.resetFields();
    } catch (err: any) {
      if (current !== authorizationEpoch.current) return;
      setAuthorizationProbe(null);
      if (!err.errorFields) {
        if (reuse) { freshAuthorization(); setAuthorizationError(`${err.message}。请重新输入授权，已开始新的更新操作。`); }
        else setAuthorizationError(err.message || "授权预览失败，请重试");
      }
    } finally { setAuthorizationBusy(false); }
  };
  const acceptAuthorizationResult = (next: AccountAuthorizationResult) => {
    setAuthorizationResult(next); setAuthorizationProbe(null); setReuseAuthorization(true); authorizationForm.resetFields();
    rememberAuthorization(next.accountKey, next.complete ? null : next.retryInput);
    if (next.complete) message.success("本次所选目标的授权已更新，原设置与历史保留");
  };
  const recoverAuthorization = async (saved = authorizationRecovery, restore = false) => {
    if (!saved) return;
    const account = accountModel?.accounts.find((item) => item.accountKey === saved.accountKey);
    if (restore && !account) { setAccountError("原账号暂不在当前关系中，请刷新并核验资源后恢复"); return; }
    if (restore && account) { openAuthorization(account); setAuthorizationRequestId(saved.retryInput.requestId); setAuthorizationTargets(saved.retryInput.targetStationIds); }
    setAuthorizationBusy(true); setAuthorizationError("");
    try { acceptAuthorizationResult(await api(`/api/channel-onboarding/accounts/${encodeURIComponent(saved.accountKey)}/authorization/recover`, { body: saved.retryInput })); }
    catch (err: any) { setAuthorizationError(err.message || "结果核对失败，请重试"); }
    finally { setAuthorizationBusy(false); }
  };
  const confirmAuthorization = async () => {
    if (!authorizationProbe || Date.now() >= authorizationProbe.expiresAtMs) { setAuthorizationProbe(null); setAuthorizationError("预览已失效，请重新验证"); return; }
    setAuthorizationBusy(true); setAuthorizationError("");
    const accountKey = authorizationAccount!.accountKey, intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    try { acceptAuthorizationResult(await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization`, { body: { ...await authorizationInput(), previewId: authorizationProbe.previewId } })); await reload(); }
    catch (err: any) {
      setAuthorizationProbe(null); setAuthorizationError(err.message || "保存结果未取得，请核对结果");
      try { const recovered: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization/recover`, { body: intent }); acceptAuthorizationResult(recovered); if (recovered.complete) setAuthorizationError(""); }
      catch { rememberAuthorization(accountKey, intent); }
    } finally { setAuthorizationBusy(false); }
  };
  const confirmPurpose = async () => {
    if (!purposeTarget) return;
    setPurposeBusy(true); setPurposeError("");
    try {
      if (purposeTarget.resource) {
        const resource = purposeTarget.resource;
        if (stations.some((station) => station.id === resource.id && station.isOwn)) throw new Error("本站来源不参与此操作");
        await api(`/api/stations/${encodeURIComponent(resource.id!)}`, { method: "PUT", body: { monitorEnabled: purposeTarget.monitorEnabled === true, expectedAuthVersion: resource.authVersion, expectedResourceVersion: resource.resourceVersion } });
        message.success(purposeTarget.monitorEnabled ? "该资源监控已启用，保持现有成本设置" : "该资源监控已暂停，账单关联与历史保留");
      } else {
        if (!purposeTarget.ruleId) throw new Error("请选择明确的核算规则");
        await api(`/api/reconciliation/rules/${encodeURIComponent(purposeTarget.ruleId)}`, { method: "DELETE" }); message.success("所选规则已停止核算，历史保留");
      }
      setPurposeTarget(null); await reload();
    } catch (err: any) { setPurposeError(`${err.message || "操作失败"}；请刷新关系并重新打开影响预览。`); }
    finally { setPurposeBusy(false); }
  };

  // ---- 筛选 ------------------------------------------------------------------
  const accountQuery = accountSearch.trim().toLowerCase();
  const matchesAccountQuery = (values: unknown[]) => values.join(" ").toLowerCase().includes(accountQuery);
  const needsAction = (account: AccountRecord) => account.actions.some((action) => action.kind !== "inspect_balance");
  const filteredAccounts = (accountModel?.accounts || []).filter((account) =>
    (accountFilter !== "attention" || needsAction(account)) &&
    matchesAccountQuery([account.accountKey, account.identity.provider, account.identity.baseUrl, account.identity.accountId,
      ...account.resources.flatMap((resource) => [resource.id, resource.name, resource.type]),
      ...account.keys.flatMap((key) => [key.tokenId, key.tokenName, ...key.channels.flatMap((channel) => [channel.channelId, channel.name])])])
  );
  const accountSites = new Map<string, AccountRecord[]>();
  for (const account of filteredAccounts) accountSites.set(account.siteKey, [...(accountSites.get(account.siteKey) || []), account]);
  const unverifiedResources = (accountModel?.unverifiedResources || []).filter((resource) =>
    (showArchived || !resource.archivedAt) && matchesAccountQuery([resource.id, resource.name, resource.type, resource.baseUrl])
  );
  const accountBoundary = (value: number | null) => value == null ? "待核验" : `${new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC")}`;
  const purposeLocked = loadingAccounts || !!accountError || authorizationBusy;

  // ---- 片段 ------------------------------------------------------------------
  const actionLinks = (actions: { id: string; href: string; label: string }[]) => (actions.length ? (
    <div className="jy-accounts-actions">
      {actions.map((action) => <Button key={action.id} size="small" href={action.href}>{action.label}</Button>)}
    </div>
  ) : null);

  const renderAccountResource = (resource: PublicResource) => {
    const original = stations.find((station) => station.id === resource.id);
    return (
      <div key={resource.id} data-resource-id={resource.id} className="jy-accounts-resource">
        <div className="jy-accounts-line">
          <b>{resource.name}</b>
          <span className={`jy-tag ${resource.purposes.monitor ? "jy-tag--good" : "jy-tag--muted"}`}>{resource.purposes.monitor ? "余额监控" : "监控暂停 / 未启用"}</span>
          {resource.archivedAt ? <span className="jy-tag jy-tag--muted">已归档</span> : null}
          {resource.purposes.billingRuleIds.length ? <span className="jy-tag jy-tag--info">关联账单规则 {resource.purposes.billingRuleIds.length}</span> : null}
        </div>
        <p className="jy-caption">原资源 ID：{resource.id} · {resource.type} · {resource.baseUrl}</p>
        <p className="jy-caption">提醒阈值：{resource.lowBalanceUsd == null ? "沿用全局" : usd(resource.lowBalanceUsd)}；折算汇率：{resource.cnyPerUsd == null ? "沿用默认" : `${resource.cnyPerUsd} RMB/USD`}；成本设置：{resource.includeInProfit ? "纳入" : "不纳入"}{resource.noRenewal ? "；不再续费" : ""}</p>
        {resource.purposes.billingRuleIds.length ? <p className="jy-caption">账单关系（含历史）：{resource.purposes.billingRuleIds.join("、")}</p> : null}
        {!resource.purposes.monitor ? <p className="jy-caption">监控暂停/未启用，现有账单关系继续保留。</p> : null}
        <div className="jy-accounts-actions">
          {original && !compact
            ? <Button size="small" disabled={loadingMeta || !types.length} aria-label={`查看原资源设置 ${resource.name}`} onClick={() => openEditor(original)}>资源设置</Button>
            : <span className="jy-caption">原资源设置使用完整资源记录；余额与趋势见上方资源列表。</span>}
          {!resource.archivedAt && !original?.isOwn ? (
            <Button
              size="small"
              disabled={purposeLocked}
              aria-label={`${resource.monitorEnabled ? "暂停" : "启用"}监控 ${resource.name}`}
              onClick={() => { setPurposeError(""); setPurposeTarget({ resource, monitorEnabled: !resource.monitorEnabled }); }}
            >
              {resource.monitorEnabled ? "暂停监控" : "启用监控"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderKey = (key: AccountKeyScope) => ({
    key: key.canonicalKey,
    label: (
      <span className="jy-accounts-line">
        <b>{key.tokenName || `Key ${key.tokenId}`} · #{key.tokenId}</b>
        {" "}
        <span className={`jy-tag ${key.scopeAmbiguous ? "jy-tag--crit" : key.activeRuleIds.length ? "jy-tag--info" : "jy-tag--muted"}`}>
          {key.scopeAmbiguous ? "有效规则范围冲突" : key.activeRuleIds.length ? "正在核算" : "已停止核算 / 历史范围"}
        </span>
      </span>
    ),
    children: (
      <div data-canonical-key={key.canonicalKey} className="jy-accounts-key">
        <dl className="jy-accounts-facts">
          <dt>规则（含历史）</dt><dd>{key.ruleIds.join("、")}</dd>
          <dt>有效规则</dt><dd>{key.activeRuleIds.join("、") || "无"}</dd>
          {!key.scopeAmbiguous ? (
            <>
              <dt>{key.activeRuleIds.length ? "当前" : "历史"}范围版本</dt><dd>{key.scopeVersion ?? "待核验"} · {key.costCoverage === "complete" ? "用途范围已确认" : "用途范围待确认"}</dd>
              <dt>{key.activeRuleIds.length ? "生效边界" : "历史生效边界"}</dt><dd>{accountBoundary(key.billingEffectiveFromMs)}</dd>
              <dt>首个完整账单查询边界</dt><dd>{accountBoundary(key.firstQueryableAtMs)}</dd>
            </>
          ) : null}
          {key.coverageDeclaration.answer === "other_use" ? (
            <>
              <dt>其他用途</dt>
              <dd>{key.coverageDeclaration.otherUse === "own_channels" ? `本站其他渠道 ${key.coverageDeclaration.uncoveredOwnChannelIds.map((id) => `#${id}`).join("、") || "待补充"}` : key.coverageDeclaration.otherUse === "external" ? "站外调用" : "尚未明确"}</dd>
            </>
          ) : null}
        </dl>
        {key.scopeAmbiguous ? (
          <div className="jy-banner" role="status">
            <Sym kind="warn" />
            <div className="jy-stations-banner-body">
              <b>存在多个有效规则，范围待核对</b>
              <p className="jy-caption">当前覆盖、生效时间与范围版本尚未统一确认。</p>
            </div>
          </div>
        ) : null}
        <div className="jy-accounts-channels">
          <b>关联渠道（含历史）</b>
          <ul>
            {key.channels.map((channel) => (
              <li key={`${channel.ownSource?.namespaceKey || channel.ownStationId}:${channel.channelId}`}>
                <span>{channel.name || `渠道 ${channel.channelId}`} · #{channel.channelId}</span>
                <span className="jy-caption">{channel.ownSource ? `本站账号 ${channel.ownSource.accountId} · ${channel.ownStationId}` : `来源待核验 · ${channel.ownStationId}`}</span>
              </li>
            ))}
          </ul>
        </div>
        {key.activeRuleIds.length ? (
          <div className="jy-accounts-actions">
            <Button
              size="small"
              disabled={purposeLocked}
              aria-label={`停止 Key ${key.tokenId} 的账单核算`}
              onClick={() => { setPurposeError(""); setPurposeTarget({ key, ruleId: key.activeRuleIds.length === 1 ? key.activeRuleIds[0] : undefined }); }}
            >
              停止此 Key 的账单核算
            </Button>
          </div>
        ) : null}
      </div>
    ),
  });

  const renderAccount = (account: AccountRecord) => {
    const resources = account.resources.filter((resource) => showArchived || !resource.archivedAt);
    const pending = [...new Set(account.actions.filter((action) => action.kind !== "inspect_balance").map((action) => action.label))].join("；");
    return {
      key: account.accountKey,
      label: (
        <span className="jy-accounts-line">
          <b>账号 {account.identity.accountId}</b>
          {" "}
          <span className="jy-caption">{resources.length} 个资源 · {account.keys.length} 把 Key</span>
          {needsAction(account) ? <>{" "}<span className="jy-tag jy-tag--warn">需处理</span></> : null}
        </span>
      ),
      children: (
        <div data-account-key={account.accountKey} className="jy-accounts-account">
          <p className="jy-caption">已核验账号 ID：{account.identity.accountId} · {account.identity.baseUrl}</p>
          <p className="jy-accounts-pending">待处理：{pending || "暂无待处理事项"}</p>
          <div className="jy-accounts-actions">
            {account.actions.map((action) => action.href.startsWith("/stations")
              ? <Button key={action.id} size="small" onClick={() => openWorkflow(action.href)}>{action.label}</Button>
              : <Button key={action.id} size="small" href={action.href}>{action.label}</Button>)}
            <Button
              size="small"
              disabled={purposeLocked || !authorizationEligible(account).length}
              aria-label={`更新账号授权 ${account.identity.provider} ${account.identity.accountId}`}
              onClick={() => openAuthorization(account)}
            >
              更新此账号授权
            </Button>
          </div>
          <div className="jy-accounts-group">
            {resources.map(renderAccountResource)}
            {account.resources.some((resource) => resource.archivedAt) && !showArchived ? <p className="jy-caption">另有归档资源，在资源列表筛选「已归档」后显示。</p> : null}
          </div>
          {account.keys.length
            ? <Collapse ghost size="small" className="jy-accounts-keys" items={account.keys.map(renderKey)} />
            : <p className="jy-caption">尚无已核验的 Key 账单关系。</p>}
        </div>
      ),
    };
  };

  // ---- 处理目标（总览/对账跳转而来）-------------------------------------------
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
            <Button size="small" onClick={() => window.location.reload()}>刷新处理目标</Button>
            <Button size="small" href="/stations">返回当前资源</Button>
          </div>
        </div>
      ) : null}
      {destination?.action === "inspect" && !workflowError ? (
        <section className="jy-panel jy-accounts-inspect" aria-label="定位原资源余额与监控">
          <div className="jy-panel-head"><h2>按原资源查看余额与监控</h2></div>
          <p className="jy-panel-sub">同账号资源可能覆盖同一余额，下方分别显示原记录，不相加。</p>
          <div className="jy-panel-body">
            {inspectTargets.length ? inspectTargets.map((station) => (
              <div key={station.id} className="jy-accounts-resource">
                <div className="jy-accounts-line"><b>{station.name}</b></div>
                <p className="jy-caption">原资源 ID：{station.id} · {station.monitorEnabled === false ? "监控暂停 / 未启用" : "监控启用"} · {station.balance?.ok ? `余额 ${usd(station.balance.remaining)}` : "余额暂不可用"}</p>
                <div className="jy-accounts-actions">
                  <Button size="small" disabled={!types.length} onClick={() => openEditor(station)}>原资源设置</Button>
                  {station.monitorEnabled !== false && !station.archivedAt ? <Button size="small" onClick={() => openTrend(station)}>查看余额与监控趋势</Button> : null}
                </div>
              </div>
            )) : <p className="jy-caption">{loaded ? "当前目录中没有对应的原资源记录。" : "正在读取原资源…"}</p>}
          </div>
        </section>
      ) : null}
    </>
  );

  // ---- 账号关系 ----------------------------------------------------------------
  let body: ReactNode;
  if (loadingAccounts && !accountModel && !accountError) {
    body = (
      <div className="jy-accounts-skeleton" aria-busy="true">
        <span className="sr-only">正在读取账号关系…</span>
        {[0, 1, 2].map((i) => <Skeleton key={i} height={36} />)}
      </div>
    );
  } else {
    body = (
      <>
        <div className="jy-toolbar jy-accounts-toolbar">
          <Input
            prefix={<Icon name="search" />}
            aria-label="搜索账号关系"
            allowClear
            placeholder="搜索站点、账号、资源、Key 或渠道"
            value={accountSearch}
            onChange={(event) => setAccountSearch(event.target.value)}
          />
          <Select
            aria-label="账号关系状态"
            className="jy-accounts-filter"
            value={accountFilter}
            onChange={setAccountFilter}
            options={[{ value: "all", label: "全部账号" }, { value: "attention", label: "需处理" }]}
          />
          {authorizationRecovery ? (
            <Button disabled={loadingAccounts || authorizationBusy} onClick={() => void recoverAuthorization(authorizationRecovery, true)}>恢复上次授权更新</Button>
          ) : null}
        </div>
        {accountError ? (
          <div className="jy-banner" role="alert">
            <Sym kind="warn" />
            <div className="jy-stations-banner-body">
              <b>{accountModel ? "账号关系刷新失败，正在显示上次结果" : "账号关系暂不可用"}</b>
              <p className="jy-caption">{accountError}</p>
            </div>
            <Button size="small" aria-label="重试账号关系" onClick={() => void loadAccounts()}>重试</Button>
          </div>
        ) : null}
        {accountModel ? (
          <p className="jy-caption">
            显示 {filteredAccounts.length}/{accountModel.accounts.length} 个已核验账号；待核验资源 {unverifiedResources.length}/{accountModel.unverifiedResources.length} · 关系读取：{new Date(accountModel.generatedAt).toLocaleString("zh-CN")}
          </p>
        ) : null}
        {actionLinks(accountModel?.actions.filter((action) => action.kind === "review_source") || [])}
        {[...accountSites].map(([siteKey, accounts]) => (
          <div key={siteKey} data-site-key={siteKey} className="jy-accounts-site">
            <h3>{accounts[0].identity.provider === "newapi" ? "New API" : "Sub2API"} · {accounts[0].identity.baseUrl}</h3>
            <Collapse
              className="jy-accounts-collapse"
              activeKey={expandedAccounts}
              onChange={(keys) => setExpandedAccounts(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
              items={accounts.map(renderAccount)}
            />
          </div>
        ))}
        {!filteredAccounts.length && accountModel ? (
          <p className="jy-accounts-empty">{accountModel.accounts.length ? "没有匹配的已核验账号" : "暂无已核验账号"}</p>
        ) : null}
        <div className="jy-accounts-unverified">
          <h3>独立 Key 与待核验资源</h3>
          <p className="jy-caption">保留原记录，渠道关联不能证明所属账号。</p>
          {unverifiedResources.map((resource) => {
            const actions = accountModel?.actions.filter((action) => action.stationId === resource.id) || [];
            return (
              <div key={resource.id} data-unverified-resource-id={resource.id} className="jy-accounts-unverified-item">
                <span className="jy-tag jy-tag--warn">{resource.type === "newapi-key" ? "独立 Key · 所属账号未核验" : "账号身份待核验"}</span>
                {renderAccountResource(resource)}
                <p className="jy-caption">关联本站渠道：{accountModel?.channels.filter((channel) => channel.monitor.stationIds.includes(resource.id!)).map((channel) => `${channel.name} #${channel.id}`).join("、") || "尚无关联"}</p>
                <p className="jy-accounts-pending">待处理：{actions.map((action) => action.label).join("；") || "核验授权和关联"}</p>
                {actionLinks(actions)}
              </div>
            );
          })}
          {!unverifiedResources.length && accountModel ? <p className="jy-caption">当前没有匹配的待核验资源。</p> : null}
        </div>
      </>
    );
  }

  const center = (
    <section className="jy-panel jy-accounts" aria-label="账号关系中心">
      <div className="jy-panel-head">
        <h2>账号关系</h2>
        {accountModel ? <CountBadge count={accountModel.accounts.length} muted /> : null}
        <span className="spacer" />
        <div className="extra">
          <Button size="small" icon={<Icon name="refresh" />} loading={loadingAccounts} onClick={() => void loadAccounts()}>刷新账号关系</Button>
        </div>
      </div>
      <p className="jy-panel-sub">按已核验的上游账号查看资源、Key 与本站渠道。各资源可能覆盖同一余额，继续按原资源查看，不合计账号余额。</p>
      <div className="jy-panel-body jy-accounts-body">{body}</div>
    </section>
  );

  // ---- 抽屉与确认 ----------------------------------------------------------------
  const capability = verification ? (verification.probe?.capability || verification.capability) : null;
  const billingTimezone = verification ? (verification.probe?.billingTimezone || verification.billingTimezone) : null;
  const overlays = (
    <>
      <Drawer
        className="jy-drawer"
        title={`核验账号与账单能力${verificationStation ? ` · ${verificationStation.name}` : ""}`}
        open={!!verificationStation}
        size={compact ? "100%" : 600}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeVerification(); } }}
        onClose={closeVerification}
      >
        {verificationStation ? (
          <Space orientation="vertical" size={16} style={{ width: "100%", overflowWrap: "anywhere" }}>
            <Text>原资源 ID：{verificationStation.id} · {verificationStation.type} · {verificationStation.baseUrl}</Text>
            <Alert type="info" showIcon message="核验只读，确认后保存账号身份" description="使用已保存授权核验实际账号，可明确确认身份并进入账号管理。保存身份保留原资源用途和核算范围；Key 账单能力、请求时区和用途覆盖仍需分别核对。" />
            {verificationError ? <Alert type="warning" showIcon message={verificationError} action={<Button onClick={() => window.location.reload()}>刷新处理目标</Button>} /> : null}
            {verificationStation.isOwn || verificationStation.type === "newapi-key" ? (
              <Alert
                type="warning"
                showIcon
                message={verificationStation.isOwn ? "本站资源请核对本站来源与渠道目录" : "纯 Key 保持独立，不能推断所属账号"}
                description="需要账号权限时，在原资源设置中补充账号授权后重新核验；也可选择真实本站渠道，在接入流程中补专用账单授权。"
                action={<Space wrap><Button disabled={!types.length} onClick={editVerificationOriginal}>补充原资源授权</Button><Button href="/stations">选择真实渠道并补账单授权</Button></Space>}
              />
            ) : (
              <>
                <div>
                  <Text strong>请求账单时区</Text>
                  <Input aria-label="核验账单时区" value={verificationTimezone} disabled={verificationBusy} onChange={(event) => { verificationEpoch.current += 1; setVerificationTimezone(event.target.value); setVerification(null); setVerificationTokenId(undefined); setVerificationError(""); }} />
                </div>
                <Button loading={verificationBusy} onClick={() => void verifyUpstream(null)}>实际核验账号与 Key 目录</Button>
                {verification ? (
                  <>
                    <Alert type={verification.identity ? "success" : "warning"} showIcon message={verification.identity ? `本次实际账号已核验：${verification.identity.accountId}` : "实际账号尚未核验"} description={`${verification.identity?.provider || verification.platform} · ${verification.identity?.baseUrl || verificationStation.baseUrl} · 资源版本 ${verification.resourceVersion}。该结果未回填已保存账号关系。`} />
                    {verification.identity ? <Button type="primary" loading={verificationBusy} disabled={verificationBusy} onClick={() => void confirmIdentity()}>确认保存账号身份</Button> : null}
                    {verification.capability?.reason === "KEY_METADATA_UNAVAILABLE" ? (
                      <Alert type="warning" showIcon message="Key 目录无法读取，请检查目录权限或稍后重试" description="账号身份核验成功；空目录不表示该账号没有 Key，也没有所选 Key 的账单证明。" />
                    ) : (
                      <>
                        <Select aria-label="核验实际 Key" style={{ width: "100%" }} value={verificationTokenId} disabled={verificationBusy} placeholder="从实际目录选择 Key" options={verification.tokens.map((key) => ({ value: key.id, label: `${key.name} · #${key.id} · ${key.group || "无分组"}`, disabled: key.status !== 1 }))} onChange={(tokenId) => { verificationEpoch.current += 1; setVerificationTokenId(tokenId); setVerification((previous) => previous ? { ...previous, probe: null } : null); setVerificationError(""); }} />
                        <Button disabled={verificationTokenId == null || verificationBusy} loading={verificationBusy} onClick={() => void verifyUpstream()}>核验所选 Key 账单</Button>
                        {!verification.tokens.length ? <Text type="secondary">当前已读取目录未返回 Key，可重试目录核验。</Text> : null}
                      </>
                    )}
                    <Text>本次 Key / 日期能力：{capability?.state === "supported" ? "已支持" : capability?.state === "unsupported" ? "不支持" : "待核验"} · {capability?.window} · {capability?.reason || ""}</Text>
                    <Text>请求时区能力：{billingTimezone?.timezone} · {billingTimezone?.state === "verified" ? "已核验" : "未核验，原金额仅供参考"}</Text>
                    {verification.probe ? (
                      <Alert
                        type={verification.probe.complete && verification.probe.billingTimezone?.state === "verified" ? "info" : "warning"}
                        showIcon
                        message={verification.platform === "sub2api" ? "所选 Key 扣费参考" : "所选 Key 原统计"}
                        description={
                          <div>
                            <div>Key #{verification.probe.tokenId} · {verification.probe.window.startMs == null || verification.probe.window.endMs == null ? "返回窗口未知" : `${new Date(verification.probe.window.startMs).toISOString()} — ${new Date(verification.probe.window.endMs).toISOString()}（${verification.probe.window.timezone || "时区未知"}）`}</div>
                            <div>原金额：{verification.probe.amountUsd == null ? "未知" : usd(verification.probe.amountUsd)} · 已获取金额：{verification.probe.knownAmountUsd == null ? "未知" : usd(verification.probe.knownAmountUsd)} · 实际扣费：{verification.probe.actualCostUsd == null ? "未知" : usd(verification.probe.actualCostUsd)}</div>
                            <div>原 quota：{verification.probe.quotaUnits ?? "未知"} · quota / USD：{verification.probe.quotaPerUnit ?? "未知"} · {verification.probe.currency}</div>
                            <div>{verification.probe.complete ? "本次 Key / 日期统计完整" : "本次 Key / 日期统计不完整"}；请求时区与完整用途范围另行核对，此处不确认利润。</div>
                          </div>
                        }
                      />
                    ) : null}
                  </>
                ) : null}
                <Button disabled={!types.length || verificationBusy} onClick={editVerificationOriginal}>补充原资源授权</Button>
              </>
            )}
          </Space>
        ) : null}
      </Drawer>

      <Drawer
        className="jy-drawer"
        title={`更新账号授权${authorizationAccount ? ` · ${authorizationAccount.identity.accountId}` : ""}`}
        open={!!authorizationAccount}
        size={compact ? "100%" : 600}
        closable={!authorizationBusy}
        mask={{ closable: !authorizationBusy }}
        keyboard={!authorizationBusy}
        onClose={() => { authorizationEpoch.current += 1; setAuthorizationAccount(null); setAuthorizationProbe(null); authorizationForm.resetFields(); }}
        extra={<Button type="primary" aria-label="确认更新所选授权" loading={authorizationBusy} disabled={!authorizationProbe || !authorizationProbe.targets.length || authorizationResult?.complete || Date.now() >= (authorizationProbe?.expiresAtMs || 0)} onClick={() => void confirmAuthorization()}>确认更新</Button>}
      >
        {authorizationAccount ? (
          <Space orientation="vertical" size={16} style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
            <Text strong>{authorizationAccount.identity.provider} · {authorizationAccount.identity.baseUrl} · 账号 {authorizationAccount.identity.accountId}</Text>
            <Alert type="info" showIcon message="授权只输入一次，明确选择更新目标" description="保留每条原资源 ID、监控用途、提醒、成本设置、关联与历史。本站、纯 Key、其他账号和已归档资源不跟随更新。" />
            {authorizationError ? <Alert type="error" showIcon message={authorizationError} /> : null}
            {previouslyUpdatedIds.length ? <Text type="secondary">已确认更新，本次不再改写：{previouslyUpdatedIds.map(authorizationName).join("、")}</Text> : null}
            {!reuseAuthorization && !authorizationResult?.complete ? (
              <Form
                form={authorizationForm}
                layout="vertical"
                disabled={authorizationBusy}
                onValuesChange={(changed) => {
                  if (changed.type) authorizationForm.setFieldsValue(changed.type === "sub2api-password" ? { accessToken: "" } : { email: "", password: "" });
                  authorizationEpoch.current += 1; setAuthorizationProbe(null); setAuthorizationRequestId(crypto.randomUUID()); setAuthorizationError("");
                }}
              >
                <Form.Item name="type" label="更新授权方式"><Select options={authorizationAccount.identity.provider === "newapi" ? [{ value: "newapi", label: "New API 访问令牌" }] : [{ value: "sub2api", label: "Sub2API 登录令牌" }, { value: "sub2api-password", label: "Sub2API 邮箱与密码" }]} /></Form.Item>
                {authorizationType === "sub2api-password" ? (
                  <>
                    <Form.Item name="email" label="更新登录邮箱" rules={[{ required: true, message: "请输入邮箱" }]}><Input autoComplete="username" /></Form.Item>
                    <Form.Item name="password" label="更新登录密码" rules={[{ required: true, message: "请输入密码" }]}><Input.Password autoComplete="off" /></Form.Item>
                  </>
                ) : <Form.Item name="accessToken" label="更新访问令牌" rules={[{ required: true, message: "请输入令牌" }]}><Input.Password autoComplete="off" /></Form.Item>}
              </Form>
            ) : !authorizationResult?.complete ? <Text>复用服务端已保存授权重新核验，无需再次输入凭据。</Text> : null}
            <div>
              <Text strong>明确的更新目标</Text>
              {[...authorizationEligible(authorizationAccount), ...(accountModel?.unverifiedResources || []).filter((resource) => resource.type !== "newapi-key" && !resource.archivedAt && resource.baseUrl === authorizationAccount.identity.baseUrl && resource.type.startsWith("sub2api") === (authorizationAccount.identity.provider === "sub2api"))].map((resource) => (
                <div key={resource.id}>
                  <Checkbox
                    aria-label={`更新目标 ${resource.name}`}
                    checked={authorizationTargets.includes(resource.id!)}
                    disabled={authorizationBusy || authorizationResult?.complete}
                    onChange={(event) => { setAuthorizationTargets(event.target.checked ? [...authorizationTargets, resource.id!] : authorizationTargets.filter((id) => id !== resource.id)); authorizationEpoch.current += 1; setAuthorizationProbe(null); }}
                  >
                    <Text>{resource.name} · {resource.id} · {resource.purposes.monitor ? "监控" : "监控未启用"}{resource.verification !== "verified" ? " · 身份待核验，预览后才可加入" : ""}</Text>
                  </Checkbox>
                </div>
              ))}
            </div>
            <Text type="secondary">排除记录：{[...authorizationAccount.resources.filter((resource) => resource.archivedAt).map((resource) => `${resource.name}（已归档）`), ...(accountModel?.accounts || []).filter((account) => account.accountKey !== authorizationAccount.accountKey && account.identity.baseUrl === authorizationAccount.identity.baseUrl).flatMap((account) => account.resources.map((resource) => `${resource.name}（其他账号/平台）`)), ...(accountModel?.unverifiedResources || []).filter((resource) => resource.type === "newapi-key").map((resource) => `${resource.name}（纯 Key）`), ...stations.filter((station) => station.isOwn).map((station) => `${station.name}（本站）`)].join("、") || "无"}</Text>
            {!authorizationResult?.complete ? <Button aria-label={reuseAuthorization ? "重新验证并补未完成" : "预览授权更新"} loading={authorizationBusy} onClick={() => void probeAuthorization()}>{reuseAuthorization ? "重新验证并补未完成" : "验证并预览更新"}</Button> : null}
            {authorizationProbe ? (
              <Alert
                type="info"
                showIcon
                message="授权更新预览，尚未保存"
                description={
                  <Space orientation="vertical">
                    {authorizationProbe.targets.map((target) => <Text key={target.stationId}>{authorizationName(target.stationId)} · 授权版本 {target.authVersion} · {target.currentType} → {target.newType} · 监控渠道 {target.monitorChannelIds.join("、") || "无"} · 账单规则 {target.billingRuleIds.join("、") || "无"} · 账单渠道 {target.billingChannelIds.join("、") || "无"}</Text>)}
                    {authorizationProbe.excluded.map((target) => <Text type="warning" key={target.stationId}>排除 {authorizationName(target.stationId)}：{target.reason}</Text>)}
                    <Text>影响监控资源：{authorizationProbe.impact.monitorStationIds.map(authorizationName).join("、") || "无"}</Text>
                    <Text>影响账单规则：{authorizationProbe.impact.billingRuleIds.join("、") || "无"}</Text>
                    <Text>关联渠道：{authorizationProbe.impact.channels.map((channel) => `${channel.name} #${channel.channelId}（${channel.ownStationId}）`).join("、") || "无"}</Text>
                  </Space>
                }
              />
            ) : null}
            {authorizationResult ? (
              <Alert
                type={authorizationResult.complete ? "success" : "warning"}
                showIcon
                message={authorizationResult.complete ? "本次所选目标已完成授权更新" : "部分目标尚未更新，已保存目标保留"}
                description={
                  <Space orientation="vertical">
                    {authorizationResult.targets.map((target) => (
                      <div key={target.stationId} data-authorization-target={target.stationId}>
                        <Text strong>{authorizationName(target.stationId)}：{{ updated: "已更新", already_updated: "已保存，无需重复更新", failed: "更新失败", repreview_required: "需重新预览" }[target.status]}</Text>
                        <div><Text>{target.reason}{target.savedAuthVersion != null ? ` · 已保存授权版本 ${target.savedAuthVersion}` : ""}</Text></div>
                      </div>
                    ))}
                    {authorizationResult.excluded.map((target) => <Text type="warning" key={target.stationId}>排除 {authorizationName(target.stationId)}：{target.reason}</Text>)}
                    {!authorizationResult.complete ? (
                      <>
                        <Button disabled={authorizationBusy} onClick={() => void recoverAuthorization({ accountKey: authorizationResult.accountKey, retryInput: authorizationResult.retryInput })}>只读核对保存结果</Button>
                        <Button disabled={authorizationBusy} onClick={() => { freshAuthorization(); setAuthorizationError(""); }}>重新输入授权，开始新的更新</Button>
                      </>
                    ) : null}
                  </Space>
                }
              />
            ) : null}
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={purposeTarget?.resource ? `${purposeTarget.monitorEnabled ? "启用" : "暂停"}「${purposeTarget.resource.name}」监控？` : "停止此 Key 的账单核算？"}
        open={!!purposeTarget}
        onCancel={() => { if (!purposeBusy) setPurposeTarget(null); }}
        closable={!purposeBusy}
        mask={{ closable: !purposeBusy }}
        keyboard={!purposeBusy}
        confirmLoading={purposeBusy}
        onOk={() => void confirmPurpose()}
        okButtonProps={{ disabled: !!purposeTarget?.key && !purposeTarget.ruleId, "aria-label": "确认用途操作" }}
        okText="确认操作"
        cancelText="取消"
        width={520}
      >
        <div className="jy-accounts-purpose">
          {purposeError ? (
            <div className="jy-banner jy-banner--crit" role="alert">
              <Sym kind="crit" />
              <div className="jy-stations-banner-body"><b>{purposeError}</b></div>
            </div>
          ) : null}
          {purposeTarget?.resource ? (
            <>
              <p>{purposeTarget.monitorEnabled ? "启用该资源的监控与监控估算，保持现有成本设置" : "仅停止该资源的监控估算"}；Key 账单核算继续，原资源 ID、设置与历史保留。</p>
              <dl className="jy-accounts-facts">
                <dt>现有成本设置</dt><dd>{purposeTarget.resource.includeInProfit ? "纳入" : "不纳入"}</dd>
                <dt>关联监控渠道</dt><dd>{accountModel?.channels.filter((channel) => channel.monitor.stationIds.includes(purposeTarget.resource!.id!)).map((channel) => `${channel.name} #${channel.id}`).join("、") || "无"}</dd>
                <dt>继续保留账单关系</dt><dd>{purposeTarget.resource.purposes.billingRuleIds.join("、") || "无"}</dd>
              </dl>
            </>
          ) : purposeTarget?.key ? (
            <>
              <p>停止所选账单规则，释放它的当前归属范围并保留历史；其他监控资源继续运行。</p>
              {purposeTarget.key.activeRuleIds.length > 1 ? (
                <Select aria-label="要停止的核算规则" style={{ width: "100%" }} value={purposeTarget.ruleId} placeholder="选择要停止的规则" options={purposeTarget.key.activeRuleIds.map((id) => ({ value: id, label: id }))} onChange={(ruleId) => setPurposeTarget({ ...purposeTarget, ruleId })} />
              ) : null}
              <dl className="jy-accounts-facts">
                <dt>所选规则</dt><dd>{purposeTarget.ruleId || "请选择"}</dd>
                <dt>Key 关联范围（含历史）</dt><dd>{purposeTarget.key.channels.map((channel) => `${channel.name} #${channel.channelId}（${channel.ownStationId}）`).join("、")}</dd>
              </dl>
              {purposeTarget.key.activeRuleIds.length > 1 ? <p className="jy-caption">其它有效规则继续保留；本次只停止明确选择的一条。</p> : null}
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );

  return { destination, destinationSeq, openWorkflow, top, center, overlays };
}
