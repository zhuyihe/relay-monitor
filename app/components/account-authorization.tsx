"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Drawer, Form, Input, Select, Space, Typography } from "antd";
import { api } from "../../lib/client";
import type { AccountReadModel, AccountRecord, AccountAuthorizationInput, AccountAuthorizationProbe, AccountAuthorizationResult, AccountAuthorizationRecoveryIntent } from "../../lib/client";
import { createRequestId } from "../../lib/request-id.js";
import { onboardingBaseUrl } from "../../lib/channel-onboarding.js";
import { useDrawerEscape } from "./drawer-escape";

const { Text } = Typography;
const AUTHORIZATION_RECOVERY_KEY = "account-authorization-recovery-v05";
const AUTHORIZATION_RECOVERY_EVENT = "account-authorization-recovery";

type AuthorizationStation = { id?: string | null; name?: string; isOwn?: boolean };
type AccountAuthorizationOptions = {
  compact: boolean;
  accountModel: AccountReadModel | null;
  stations: AuthorizationStation[];
  disabled?: boolean;
  onComplete: (result: AccountAuthorizationResult) => Promise<void> | void;
  onRecoveryError?: (message: string) => void;
};

// Both entry points use the same explicit-target authorization API and recovery.
export function useAccountAuthorization({ compact, accountModel, stations, disabled = false, onComplete, onRecoveryError }: AccountAuthorizationOptions) {
  const { message } = App.useApp();
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

  useEffect(() => {
    const readRecovery = () => {
      try {
        const stored = JSON.parse(sessionStorage.getItem(AUTHORIZATION_RECOVERY_KEY) || "null");
        if (/^[a-f0-9]{64}$/.test(stored?.accountKey || "") && typeof stored.retryInput?.requestId === "string" && Array.isArray(stored.retryInput.targetStationIds) && stored.retryInput.targetStationIds.every((id: any) => typeof id === "string")) {
          setAuthorizationRecovery({ accountKey: stored.accountKey, retryInput: { requestId: stored.retryInput.requestId, targetStationIds: [...stored.retryInput.targetStationIds] } });
        } else setAuthorizationRecovery(null);
      } catch { /* Recovery must not block resource reads. */ }
    };
    readRecovery();
    window.addEventListener(AUTHORIZATION_RECOVERY_EVENT, readRecovery);
    return () => { authorizationEpoch.current += 1; window.removeEventListener(AUTHORIZATION_RECOVERY_EVENT, readRecovery); };
  }, []);

  const rememberAuthorization = (accountKey: string, intent: AccountAuthorizationRecoveryIntent | null) => {
    const safe = intent ? { accountKey, retryInput: { requestId: intent.requestId, targetStationIds: [...intent.targetStationIds] } } : null;
    setAuthorizationRecovery(safe);
    try { if (safe) sessionStorage.setItem(AUTHORIZATION_RECOVERY_KEY, JSON.stringify(safe)); else sessionStorage.removeItem(AUTHORIZATION_RECOVERY_KEY); window.dispatchEvent(new Event(AUTHORIZATION_RECOVERY_EVENT)); } catch { /* 当前抽屉仍可核对。 */ }
  };
  const authorizationName = (id: string) => accountModel?.accounts.flatMap((account) => account.resources).find((resource) => resource.id === id)?.name || accountModel?.unverifiedResources.find((resource) => resource.id === id)?.name || stations.find((station) => station.id === id)?.name || id;
  const authorizationEligible = (account: AccountRecord) => account.resources.filter((resource) => !resource.archivedAt && resource.type !== "newapi-key" && !stations.some((station) => station.id === resource.id && station.isOwn));
  const initializeAuthorizationForm = (account: AccountRecord, targetIds?: string[], initial?: AccountAuthorizationInput["authorization"]) => {
    authorizationForm.resetFields();
    authorizationForm.setFieldsValue({ type: account.identity.provider === "newapi" ? "newapi" : authorizationEligible(account).find((resource) => targetIds?.includes(resource.id!))?.type || authorizationEligible(account)[0]?.type || "sub2api" });
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
  // Esc 由最上层抽屉处理，保留选择器先关闭的行为。
  useDrawerEscape(!!authorizationAccount && !authorizationBusy, closeAuthorization);
  const openAuthorization = (account: AccountRecord, options: { defaultTargetIds?: string[]; initialAuthorization?: AccountAuthorizationInput["authorization"] } = {}) => {
    let nextRequestId: string;
    try { nextRequestId = createRequestId(); } catch (err: any) { onRecoveryError?.(err.message); message.error(err.message); return; }
    authorizationEpoch.current += 1; setAuthorizationAccount(account); setAuthorizationTargets(options.defaultTargetIds ? options.defaultTargetIds.filter((id) => authorizationEligible(account).some((resource) => resource.id === id)) : authorizationEligible(account).map((resource) => resource.id!)); setAuthorizationRequestId(nextRequestId); setAuthorizationProbe(null); setAuthorizationResult(null); setAuthorizationError(""); setReuseAuthorization(false); setPreviouslyUpdatedIds([]); initializeAuthorizationForm(account, options.defaultTargetIds, options.initialAuthorization);
  };
  const freshAuthorization = () => {
    if (!authorizationAccount) return;
    let nextRequestId: string;
    try { nextRequestId = createRequestId(); } catch (err: any) {
      setAuthorizationProbe(null); setAuthorizationRequestId(""); setAuthorizationError(err.message); return;
    }
    const saved = authorizationResult?.targets.filter((target) => ["updated", "already_updated"].includes(target.status)).map((target) => target.stationId) || [];
    const remaining = authorizationResult?.targets.filter((target) => !saved.includes(target.stationId) && !authorizationResult.excluded.some((item) => item.stationId === target.stationId)).map((target) => target.stationId);
    setPreviouslyUpdatedIds([...new Set([...previouslyUpdatedIds, ...saved])]); if (remaining) setAuthorizationTargets(remaining);
    authorizationEpoch.current += 1; setAuthorizationRequestId(nextRequestId); setAuthorizationProbe(null); setAuthorizationResult(null); setReuseAuthorization(false); initializeAuthorizationForm(authorizationAccount, remaining || authorizationTargets);
  };
  const authorizationInput = async (reuse = reuseAuthorization): Promise<AccountAuthorizationInput> => {
    if (!authorizationAccount || !authorizationTargets.length) throw new Error("请选择明确的更新目标");
    if (!authorizationRequestId) throw new Error("请求标识无效，请关闭授权窗口后重新打开");
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
  const refreshAuthorizationResult = async (next: AccountAuthorizationResult) => {
    try { await onComplete(next); }
    catch { setAuthorizationError("授权结果已取得，但资源列表刷新失败。请刷新列表后继续，已保存目标无需重复更新。"); }
  };
  const recoverAuthorization = async (saved = authorizationRecovery, restore = false) => {
    if (!saved) return;
    const account = accountModel?.accounts.find((item) => item.accountKey === saved.accountKey);
    if (restore && !account) { onRecoveryError?.("原账号暂不在上游账单中，请刷新并核验资源后恢复"); return; }
    if (restore && account) { openAuthorization(account); setAuthorizationRequestId(saved.retryInput.requestId); setAuthorizationTargets(saved.retryInput.targetStationIds); }
    setAuthorizationBusy(true); setAuthorizationError("");
    try { const next: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(saved.accountKey)}/authorization/recover`, { body: saved.retryInput }); acceptAuthorizationResult(next); await refreshAuthorizationResult(next); }
    catch (err: any) { setAuthorizationError(err.message || "结果核对失败，请重试"); }
    finally { setAuthorizationBusy(false); }
  };
  const confirmAuthorization = async () => {
    if (!authorizationProbe || Date.now() >= authorizationProbe.expiresAtMs) { setAuthorizationProbe(null); setAuthorizationError("预览已失效，请重新验证"); return; }
    setAuthorizationBusy(true); setAuthorizationError("");
    const accountKey = authorizationAccount!.accountKey, intent = { requestId: authorizationRequestId, targetStationIds: [...authorizationTargets] };
    try { const next: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization`, { body: { ...await authorizationInput(), previewId: authorizationProbe.previewId } }); acceptAuthorizationResult(next); await refreshAuthorizationResult(next); }
    catch (err: any) {
      setAuthorizationProbe(null); setAuthorizationError(err.message || "保存结果未取得，请核对结果");
      try { const recovered: AccountAuthorizationResult = await api(`/api/channel-onboarding/accounts/${encodeURIComponent(accountKey)}/authorization/recover`, { body: intent }); acceptAuthorizationResult(recovered); if (recovered.complete) setAuthorizationError(""); await refreshAuthorizationResult(recovered); }
      catch { rememberAuthorization(accountKey, intent); }
    } finally { setAuthorizationBusy(false); }
  };

  const recoveryButton = authorizationRecovery ? <Button disabled={disabled || authorizationBusy} onClick={() => void recoverAuthorization(authorizationRecovery, true)}>恢复上次授权更新</Button> : null;
  const overlay = (
    <Drawer
      className="jy-drawer"
      title={`更新账号授权${authorizationAccount ? ` · ${authorizationAccount.identity.accountId}` : ""}`}
      open={!!authorizationAccount}
      size={compact ? "100%" : 600}
      closable={!authorizationBusy}
      mask={{ closable: !authorizationBusy }}
      keyboard={false}
      onClose={closeAuthorization}
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
              name="account-authorization"
              form={authorizationForm}
              layout="vertical"
              disabled={authorizationBusy}
              onValuesChange={(changed) => {
                if (changed.type) authorizationForm.setFieldsValue(changed.type === "sub2api-password" ? { accessToken: "" } : { email: "", password: "" });
                authorizationEpoch.current += 1; setAuthorizationProbe(null); setAuthorizationRequestId("");
                try { setAuthorizationRequestId(createRequestId()); setAuthorizationError(""); }
                catch (err: any) { setAuthorizationError(err.message); }
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
                  {authorizationProbe.targets.map((target) => <Text key={target.stationId}>{authorizationName(target.stationId)} · 授权版本 {target.authVersion} · {target.currentType} → {target.newType} · 监控渠道 {target.monitorChannelIds.join("、") || "无"} · 核算关联 {target.billingRuleIds.join("、") || "无"} · 账单渠道 {target.billingChannelIds.join("、") || "无"}</Text>)}
                  {authorizationProbe.excluded.map((target) => <Text type="warning" key={target.stationId}>排除 {authorizationName(target.stationId)}：{target.reason}</Text>)}
                  <Text>影响监控资源：{authorizationProbe.impact.monitorStationIds.map(authorizationName).join("、") || "无"}</Text>
                  <Text>影响核算关联：{authorizationProbe.impact.billingRuleIds.join("、") || "无"}</Text>
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
  );

  return { openAuthorization, authorizationOpen: !!authorizationAccount, authorizationBusy, authorizationEligible, recoveryButton, overlay };
}
