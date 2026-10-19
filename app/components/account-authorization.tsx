"use client";
// 更新登录信息：上游账单和渠道绑定共用的抽屉。登录信息只填一次，选好要更新的上游，先预览再保存；
// 没拿到保存结果时记在浏览器里，可以再查看。用语按 design/ui-copy-spec.md，报错按 lib/error-copy.js 归类，原文只放进「查看详细原因」。
import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Drawer, Form, Input, Select, Space, Typography } from "antd";
import { api } from "../../lib/client";
import type { AccountReadModel, AccountRecord, AccountAuthorizationInput, AccountAuthorizationProbe, AccountAuthorizationResult, AccountAuthorizationRecoveryIntent } from "../../lib/client";
import { createRequestId } from "../../lib/request-id.js";
import { BINDING_COPY, CREDENTIAL_FIELDS, UPSTREAM_TYPES, onboardingBaseUrl } from "../../lib/channel-onboarding.js";
import { ERROR_CATEGORIES, describeError, failureText, requiredRule } from "../../lib/error-copy.js";
import { EMPTY } from "../../lib/format";
import { reconciliationChannelName } from "../../lib/reconciliation-view.js";
import { workflowActionMeta } from "../../lib/workflow-actions.js";
import { useDrawerEscape } from "./drawer-escape";
import { ErrorDetail, notice, noteOf } from "./error-detail";
import type { ErrorNote } from "./error-detail";

const { Text } = Typography;
const AUTHORIZATION_RECOVERY_KEY = "account-authorization-recovery-v05";
const AUTHORIZATION_RECOVERY_EVENT = "account-authorization-recovery";
// 按钮名和完成提示（§3.5，lib/workflow-actions.js）
const UPDATE_LOGIN = workflowActionMeta("update_authorization")!;
// 更新登录信息独有的话，只在这一处写
const COPY = Object.freeze({
  confirmUpdate: "确认更新",
  loginOnceTitle: "登录信息只填一次，选好要更新的上游",
  loginOnceDetail: "其他设置、绑定和以前的每日记录都不变。自营站点、只用 Key 的上游、其他上游账号和归档的上游不跟着更新。",
  updatedBefore: (names: string) => `已更新，这次不再改：${names}`,
  reuse: "用已保存的登录信息，不用再填。",
  targets: "要更新的上游",
  ownerUnknownTarget: "还没确认上游账号，预览后才能加进来",
  notFollowing: "不跟着更新",
  otherAccount: "其他上游账号",
  repreview: "重新预览",
  previewTitle: "预览，还没保存",
  affectedUpstreams: "会一起更新的上游",
  affectedBindings: (n: number) => `用到它的绑定 ${n} 条`,
  someNotUpdated: (n: number) => `有 ${n} 个上游没更新上，已更新的不变`,
  alreadyUpdated: "已更新过，不用再改",
  checkResult: "查看保存结果",
  refill: "请重新填写登录信息。",
  refillButton: "重新填写登录信息",
  chooseTargets: "请选择要更新的上游",
  accountMissing: "找不到上次更新的上游账号，请刷新后再试。",
  channels: "渠道",
  recover: `查看上次${UPDATE_LOGIN.label}的结果`,
});
const typeLabel = (value: string) => UPSTREAM_TYPES.find((item) => item.value === value)?.label;
// 更新登录信息后每个上游的结果；没更新上的按原因归类，原文进「查看详细原因」
const authorizationTargetNote = (target: AccountAuthorizationResult["targets"][number]): ErrorNote => {
  if (target.status === "updated") return { text: UPDATE_LOGIN.done };
  if (target.status === "already_updated") return { text: COPY.alreadyUpdated };
  if (target.status === "repreview_required") return { text: ERROR_CATEGORIES.changed.text };
  // 标题已说「没更新上」，这里只写原因；不跟着更新的按具体原因的码说
  return noteOf(target.code === "TARGET_EXCLUDED" ? { code: target.exclusionCode, reason: target.reason } : target);
};

type AuthorizationStation = { id?: string | null; name?: string; isOwn?: boolean };
type AccountAuthorizationOptions = {
  compact: boolean;
  accountModel: AccountReadModel | null;
  stations: AuthorizationStation[];
  disabled?: boolean;
  onComplete: (result: AccountAuthorizationResult) => Promise<void> | void;
  onRecoveryError?: (note: ErrorNote) => void;
};

// 两个入口用同一套接口：明确选好要更新的上游，没拿到结果时同样能再查看
export function useAccountAuthorization({ compact, accountModel, stations, disabled = false, onComplete, onRecoveryError }: AccountAuthorizationOptions) {
  const { message } = App.useApp();
  const [authorizationAccount, setAuthorizationAccount] = useState<AccountRecord | null>(null);
  const [authorizationTargets, setAuthorizationTargets] = useState<string[]>([]);
  const [authorizationRequestId, setAuthorizationRequestId] = useState("");
  const [authorizationProbe, setAuthorizationProbe] = useState<AccountAuthorizationProbe | null>(null);
  const [authorizationResult, setAuthorizationResult] = useState<AccountAuthorizationResult | null>(null);
  const [authorizationError, setAuthorizationError] = useState<ErrorNote | null>(null);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [reuseAuthorization, setReuseAuthorization] = useState(false);
  const [previouslyUpdatedIds, setPreviouslyUpdatedIds] = useState<string[]>([]);
  const [authorizationRecovery, setAuthorizationRecovery] = useState<{ accountKey: string; retryInput: AccountAuthorizationRecoveryIntent } | null>(null);
  const [authorizationForm] = Form.useForm();
  const authorizationType = Form.useWatch("type", authorizationForm) || "newapi";
  const authorizationEpoch = useRef(0);

  useEffect(() => {
    const readRecovery = () => {
      try {
        const stored = JSON.parse(sessionStorage.getItem(AUTHORIZATION_RECOVERY_KEY) || "null");
        if (/^[a-f0-9]{64}$/.test(stored?.accountKey || "") && typeof stored.retryInput?.requestId === "string" && Array.isArray(stored.retryInput.targetStationIds) && stored.retryInput.targetStationIds.every((id: any) => typeof id === "string")) {
          setAuthorizationRecovery({ accountKey: stored.accountKey, retryInput: { requestId: stored.retryInput.requestId, targetStationIds: [...stored.retryInput.targetStationIds] } });
        } else setAuthorizationRecovery(null);
      } catch { /* 读不到上次的结果不影响页面读取 */ }
    };
    readRecovery();
    window.addEventListener(AUTHORIZATION_RECOVERY_EVENT, readRecovery);
    return () => { authorizationEpoch.current += 1; window.removeEventListener(AUTHORIZATION_RECOVERY_EVENT, readRecovery); };
  }, []);

  const rememberAuthorization = (accountKey: string, intent: AccountAuthorizationRecoveryIntent | null) => {
    const safe = intent ? { accountKey, retryInput: { requestId: intent.requestId, targetStationIds: [...intent.targetStationIds] } } : null;
    setAuthorizationRecovery(safe);
    try { if (safe) sessionStorage.setItem(AUTHORIZATION_RECOVERY_KEY, JSON.stringify(safe)); else sessionStorage.removeItem(AUTHORIZATION_RECOVERY_KEY); window.dispatchEvent(new Event(AUTHORIZATION_RECOVERY_EVENT)); } catch { /* 当前抽屉里仍能查看保存结果。 */ }
  };
  const authorizationName = (id: string) => accountModel?.accounts.flatMap((account) => account.resources).find((resource) => resource.id === id)?.name || accountModel?.unverifiedResources.find((resource) => resource.id === id)?.name || stations.find((station) => station.id === id)?.name || id;
  const ownStationName = (id: string) => stations.find((station) => station.id === id)?.name || EMPTY;
  const authorizationEligible = (account: AccountRecord) => account.resources.filter((resource) => !resource.archivedAt && resource.type !== "newapi-key" && !stations.some((station) => station.id === resource.id && station.isOwn));
  const initializeAuthorizationForm = (account: AccountRecord, targetIds?: string[], initial?: AccountAuthorizationInput["authorization"]) => {
    authorizationForm.resetFields();
    authorizationForm.setFieldsValue({ type: account.identity.provider === "newapi" ? "newapi" : authorizationEligible(account).find((resource) => targetIds?.includes(resource.id!))?.type || authorizationEligible(account)[0]?.type || "sub2api" });
    // 渠道绑定里刚填过、地址和上游账号都对得上的登录信息，直接带进来
    if (initial && (account.identity.provider === "newapi" ? initial.type === "newapi" : ["sub2api", "sub2api-password"].includes(initial.type))
      && onboardingBaseUrl(initial.baseUrl) === onboardingBaseUrl(account.identity.baseUrl)
      && (initial.type !== "newapi" || !initial.userId || String(initial.userId) === account.identity.accountId)) {
      authorizationForm.setFieldsValue(initial.type === "sub2api-password"
        ? { type: initial.type, email: initial.email || "", password: initial.password || "" }
        : { type: initial.type, accessToken: initial.accessToken || "" });
    }
  };
  const closeAuthorization = () => {
    authorizationEpoch.current += 1; setAuthorizationAccount(null); setAuthorizationProbe(null); authorizationForm.resetFields();
  };
  // 抽屉里有下拉框：Esc 由抽屉自己处理（#413）
  useDrawerEscape(!!authorizationAccount && !authorizationBusy, closeAuthorization);
  const openAuthorization = (account: AccountRecord, options: { defaultTargetIds?: string[]; initialAuthorization?: AccountAuthorizationInput["authorization"] } = {}) => {
    let nextRequestId: string;
    // 打不开更新登录信息（浏览器太旧）不是账单刷新失败：页面上原样写这一句
    try { nextRequestId = createRequestId(); } catch (err: any) { const note = { ...noteOf(err), notice: true }; onRecoveryError?.(note); message.error(note.text); return; }
    authorizationEpoch.current += 1; setAuthorizationAccount(account); setAuthorizationTargets(options.defaultTargetIds ? options.defaultTargetIds.filter((id) => authorizationEligible(account).some((resource) => resource.id === id)) : authorizationEligible(account).map((resource) => resource.id!)); setAuthorizationRequestId(nextRequestId); setAuthorizationProbe(null); setAuthorizationResult(null); setAuthorizationError(null); setReuseAuthorization(false); setPreviouslyUpdatedIds([]); initializeAuthorizationForm(account, options.defaultTargetIds, options.initialAuthorization);
  };
  const freshAuthorization = () => {
    if (!authorizationAccount) return;
    let nextRequestId: string;
    try { nextRequestId = createRequestId(); } catch (err: any) {
      setAuthorizationProbe(null); setAuthorizationRequestId(""); setAuthorizationError(noteOf(err)); return;
    }
    const saved = authorizationResult?.targets.filter((target) => ["updated", "already_updated"].includes(target.status)).map((target) => target.stationId) || [];
    const remaining = authorizationResult?.targets.filter((target) => !saved.includes(target.stationId) && !authorizationResult.excluded.some((item) => item.stationId === target.stationId)).map((target) => target.stationId);
    setPreviouslyUpdatedIds([...new Set([...previouslyUpdatedIds, ...saved])]); if (remaining) setAuthorizationTargets(remaining);
    authorizationEpoch.current += 1; setAuthorizationRequestId(nextRequestId); setAuthorizationProbe(null); setAuthorizationResult(null); setReuseAuthorization(false); initializeAuthorizationForm(authorizationAccount, remaining || authorizationTargets);
  };
  const authorizationInput = async (reuse = reuseAuthorization): Promise<AccountAuthorizationInput> => {
    if (!authorizationAccount || !authorizationTargets.length) throw notice(COPY.chooseTargets);
    if (!authorizationRequestId) throw notice(ERROR_CATEGORIES.expired.text);
    const intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    if (reuse) return { ...intent, reuseSavedAuthorization: true };
    const values = await authorizationForm.validateFields();
    return { ...intent, authorization: { type: values.type, baseUrl: authorizationAccount.identity.baseUrl,
      ...(values.type === "sub2api-password" ? { email: values.email, password: values.password } : { accessToken: values.accessToken }),
      ...(values.type === "newapi" ? { userId: authorizationAccount.identity.accountId } : {}) } };
  };
  const probeAuthorization = async (reuse = reuseAuthorization) => {
    const current = ++authorizationEpoch.current; setAuthorizationError(null); setAuthorizationBusy(true);
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
        const note = noteOf(err);
        if (reuse) { freshAuthorization(); setAuthorizationError({ ...note, text: `${note.text}。${COPY.refill}` }); }
        else setAuthorizationError(note);
      }
    } finally { setAuthorizationBusy(false); }
  };
  const acceptAuthorizationResult = (next: AccountAuthorizationResult) => {
    setAuthorizationResult(next); setAuthorizationProbe(null); setReuseAuthorization(true); authorizationForm.resetFields();
    rememberAuthorization(next.accountKey, next.complete ? null : next.retryInput);
    if (next.complete) message.success(UPDATE_LOGIN.done);
  };
  const refreshAuthorizationResult = async (next: AccountAuthorizationResult) => {
    try { await onComplete(next); }
    // 没全部更新上时，结果里已经写了哪些没更新上，这里只说页面没跟着更新
    catch { setAuthorizationError({ text: next.complete ? `${BINDING_COPY.saved}；${BINDING_COPY.pageNotUpdated}` : BINDING_COPY.pageNotUpdated, notice: true }); }
  };
  const recoverAuthorization = async (saved = authorizationRecovery, restore = false) => {
    if (!saved) return;
    const account = accountModel?.accounts.find((item) => item.accountKey === saved.accountKey);
    if (restore && !account) { onRecoveryError?.({ text: COPY.accountMissing, notice: true }); return; }
    if (restore && account) { openAuthorization(account); setAuthorizationRequestId(saved.retryInput.requestId); setAuthorizationTargets(saved.retryInput.targetStationIds); }
    setAuthorizationBusy(true); setAuthorizationError(null);
    try { const next: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(saved.accountKey)}/authorization/recover`, { body: saved.retryInput }); acceptAuthorizationResult(next); await refreshAuthorizationResult(next); }
    catch (err: any) { setAuthorizationError(noteOf(err)); }
    finally { setAuthorizationBusy(false); }
  };
  const confirmAuthorization = async () => {
    if (!authorizationProbe || Date.now() >= authorizationProbe.expiresAtMs) { setAuthorizationProbe(null); setAuthorizationError({ text: describeError({ code: "PREVIEW_REQUIRED" }).text, notice: true }); return; }
    setAuthorizationBusy(true); setAuthorizationError(null);
    const accountKey = authorizationAccount!.accountKey, intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    try { const next: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization`, { body: { ...await authorizationInput(), previewId: authorizationProbe.previewId } }); acceptAuthorizationResult(next); await refreshAuthorizationResult(next); }
    catch (err: any) {
      setAuthorizationProbe(null); setAuthorizationError({ text: failureText("保存失败", err), raw: describeError(err).raw });
      try { const recovered: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization/recover`, { body: intent }); acceptAuthorizationResult(recovered); if (recovered.complete) setAuthorizationError(null); await refreshAuthorizationResult(recovered); }
      catch { rememberAuthorization(accountKey, intent); }
    } finally { setAuthorizationBusy(false); }
  };

  const tokenField = authorizationType === "newapi" ? CREDENTIAL_FIELDS.accessToken : CREDENTIAL_FIELDS.loginToken;
  const recoveryButton = authorizationRecovery ? <Button disabled={disabled || authorizationBusy} onClick={() => void recoverAuthorization(authorizationRecovery, true)}>{COPY.recover}</Button> : null;
  const overlay = (
    <Drawer
      className="jy-drawer"
      title={`${UPDATE_LOGIN.label}${authorizationAccount ? ` · 上游账号 ${authorizationAccount.identity.accountId}` : ""}`}
      open={!!authorizationAccount}
      size={compact ? "100%" : 600}
      closable={!authorizationBusy}
      mask={{ closable: !authorizationBusy }}
      keyboard={false}
      onClose={closeAuthorization}
      extra={<Button type="primary" aria-label={`确认${UPDATE_LOGIN.label}`} loading={authorizationBusy} disabled={!authorizationProbe || !authorizationProbe.targets.length || authorizationResult?.complete || Date.now() >= (authorizationProbe?.expiresAtMs || 0)} onClick={() => void confirmAuthorization()}>{COPY.confirmUpdate}</Button>}
    >
      {authorizationAccount ? (
        <Space orientation="vertical" size={16} style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
          <Text strong>{authorizationAccount.identity.baseUrl} · 上游账号 {authorizationAccount.identity.accountId}</Text>
          <Alert type="info" showIcon title={COPY.loginOnceTitle} description={COPY.loginOnceDetail} />
          {authorizationError ? <Alert type="error" showIcon title={authorizationError.text} description={authorizationError.raw ? <ErrorDetail raw={authorizationError.raw} /> : undefined} /> : null}
          {previouslyUpdatedIds.length ? <Text type="secondary">{COPY.updatedBefore(previouslyUpdatedIds.map(authorizationName).join("、"))}</Text> : null}
          {!reuseAuthorization && !authorizationResult?.complete ? (
            <Form
              name="account-authorization"
              form={authorizationForm}
              layout="vertical"
              disabled={authorizationBusy}
              onValuesChange={(changed) => {
                if (changed.type) authorizationForm.setFieldsValue(changed.type === "sub2api-password" ? { accessToken: "" } : { email: "", password: "" });
                authorizationEpoch.current += 1; setAuthorizationProbe(null); setAuthorizationRequestId("");
                try { setAuthorizationRequestId(createRequestId()); setAuthorizationError(null); }
                catch (err: any) { setAuthorizationError(noteOf(err)); }
              }}
            >
              <Form.Item name="type" label={CREDENTIAL_FIELDS.type.label}><Select options={(authorizationAccount.identity.provider === "newapi" ? ["newapi"] : ["sub2api", "sub2api-password"]).map((value) => ({ value, label: typeLabel(value) }))} /></Form.Item>
              {authorizationType === "sub2api-password" ? (
                <>
                  <Form.Item name="email" label={CREDENTIAL_FIELDS.email.label} rules={[requiredRule(CREDENTIAL_FIELDS.email.label)]}><Input autoComplete="username" /></Form.Item>
                  <Form.Item name="password" label={CREDENTIAL_FIELDS.password.label} extra={CREDENTIAL_FIELDS.password.hint} rules={[requiredRule(CREDENTIAL_FIELDS.password.label)]}><Input.Password autoComplete="off" /></Form.Item>
                </>
              ) : <Form.Item name="accessToken" label={tokenField.label} extra={tokenField.hint} rules={[requiredRule(tokenField.label)]}><Input.Password autoComplete="off" /></Form.Item>}
            </Form>
          ) : !authorizationResult?.complete ? <Text>{COPY.reuse}</Text> : null}
          <div>
            <Text strong>{COPY.targets}</Text>
            {[...authorizationEligible(authorizationAccount), ...(accountModel?.unverifiedResources || []).filter((resource) => resource.type !== "newapi-key" && !resource.archivedAt && resource.baseUrl === authorizationAccount.identity.baseUrl && resource.type.startsWith("sub2api") === (authorizationAccount.identity.provider === "sub2api"))].map((resource) => (
              <div key={resource.id}>
                <Checkbox
                  aria-label={`更新 ${resource.name}`}
                  checked={authorizationTargets.includes(resource.id!)}
                  disabled={authorizationBusy || authorizationResult?.complete}
                  onChange={(event) => { setAuthorizationTargets(event.target.checked ? [...authorizationTargets, resource.id!] : authorizationTargets.filter((id) => id !== resource.id)); authorizationEpoch.current += 1; setAuthorizationProbe(null); }}
                >
                  <Text>{resource.name}{!resource.purposes.monitor ? ` · ${BINDING_COPY.monitorPaused}` : ""}{resource.verification !== "verified" ? ` · ${COPY.ownerUnknownTarget}` : ""}</Text>
                </Checkbox>
              </div>
            ))}
          </div>
          <Text type="secondary">{COPY.notFollowing}：{[...authorizationAccount.resources.filter((resource) => resource.archivedAt).map((resource) => `${resource.name}（${BINDING_COPY.archived}）`), ...(accountModel?.accounts || []).filter((account) => account.accountKey !== authorizationAccount.accountKey && account.identity.baseUrl === authorizationAccount.identity.baseUrl).flatMap((account) => account.resources.map((resource) => `${resource.name}（${COPY.otherAccount}）`)), ...(accountModel?.unverifiedResources || []).filter((resource) => resource.type === "newapi-key").map((resource) => `${resource.name}（${BINDING_COPY.keyOnly}）`), ...stations.filter((station) => station.isOwn).map((station) => `${station.name}（自营站点）`)].join("、") || EMPTY}</Text>
          {!authorizationResult?.complete ? <Button aria-label={reuseAuthorization ? COPY.repreview : BINDING_COPY.preview} loading={authorizationBusy} onClick={() => void probeAuthorization()}>{reuseAuthorization ? COPY.repreview : BINDING_COPY.preview}</Button> : null}
          {authorizationProbe ? (
            <Alert
              type="info"
              showIcon
              title={COPY.previewTitle}
              description={
                <Space orientation="vertical">
                  {authorizationProbe.targets.map((target) => {
                    const from = typeLabel(target.currentType), to = typeLabel(target.newType);
                    return <Text key={target.stationId}>{authorizationName(target.stationId)}{from && to && from !== to ? ` · ${from} → ${to}` : ""} · {BINDING_COPY.bindingCount(target.billingRuleIds.length)}</Text>;
                  })}
                  {authorizationProbe.excluded.map((target) => {
                    const note = noteOf(target);
                    return <div key={target.stationId}><Text type="warning">{COPY.notFollowing} {authorizationName(target.stationId)}：{note.text}</Text><ErrorDetail raw={note.raw} /></div>;
                  })}
                  <Text>{COPY.affectedUpstreams}：{authorizationProbe.impact.monitorStationIds.map(authorizationName).join("、") || EMPTY}</Text>
                  <Text>{COPY.affectedBindings(authorizationProbe.impact.billingRuleIds.length)}</Text>
                  <Text>{COPY.channels}：{authorizationProbe.impact.channels.map((channel) => `${reconciliationChannelName(channel)}（自营站点 ${ownStationName(channel.ownStationId)}）`).join("、") || EMPTY}</Text>
                </Space>
              }
            />
          ) : null}
          {authorizationResult ? (
            <Alert
              type={authorizationResult.complete ? "success" : "warning"}
              showIcon
              title={authorizationResult.complete ? UPDATE_LOGIN.done : COPY.someNotUpdated(authorizationResult.targets.filter((target) => !["updated", "already_updated"].includes(target.status)).length)}
              description={
                <Space orientation="vertical">
                  {authorizationResult.targets.map((target) => {
                    const note = authorizationTargetNote(target);
                    return (
                      <div key={target.stationId} data-authorization-target={target.stationId}>
                        <Text strong>{authorizationName(target.stationId)}：{note.text}</Text>
                        <ErrorDetail raw={note.raw} />
                      </div>
                    );
                  })}
                  {authorizationResult.excluded.map((target) => {
                    const note = noteOf(target);
                    return <div key={target.stationId}><Text type="warning">{COPY.notFollowing} {authorizationName(target.stationId)}：{note.text}</Text><ErrorDetail raw={note.raw} /></div>;
                  })}
                  {!authorizationResult.complete ? (
                    <>
                      <Button disabled={authorizationBusy} onClick={() => void recoverAuthorization({ accountKey: authorizationResult.accountKey, retryInput: authorizationResult.retryInput })}>{COPY.checkResult}</Button>
                      <Button disabled={authorizationBusy} onClick={() => { freshAuthorization(); setAuthorizationError(null); }}>{COPY.refillButton}</Button>
                    </>
                  ) : null}
                </Space>
              }
            />
          ) : null}
        </Space>
      ) : null}
    </Drawer>
  );

  return { openAuthorization, authorizationOpen: !!authorizationAccount, authorizationBusy, authorizationEligible, recoveryButton, overlay };
}
