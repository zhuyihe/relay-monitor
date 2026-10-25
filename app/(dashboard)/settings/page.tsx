"use client";
// 系统设置：刷新与数据、历史数据保留、账户安全、关于（余额提醒线在告警中心「余额偏低」那一行，ui-copy-spec §8.3）。
// 刷新间隔、保留天数改了马上保存（数字框离开或回车时、下拉一改就存），PUT /api/settings 只带这一组的字段；
// 修改密码要原密码，照旧按按钮。
// 只在本页出现的话都在同目录的 copy.ts 里；报错按码说（改密码时按码把报错放到对应的输入框），日期时间按业务时区写
import "../../styles/pages/settings.css";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { App, Button, Input, InputNumber, Select } from "antd";
import { BRAND, NAV_LABELS, VERSION_LABEL } from "../../../lib/brand";
import { api } from "../../../lib/client";
import { DEFAULT_BUSINESS_TIME_ZONE } from "../../../lib/business-time";
import { consoleFailureText, describeError, errorText, requiredText } from "../../../lib/error-copy";
import { EMPTY, formatInt, formatZonedDate, formatZonedDateTime } from "../../../lib/format";
import { Panel } from "../../components/panel";
import { Dirty, ErrorState, PanelSkeleton, SaveState } from "../../components/data-state";
import { commitOnLeave, useAutoSave, useSaveQueue } from "../../components/use-auto-save";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import { Sym } from "../../components/icons";
import { More } from "../../components/more";
import { COPY } from "./copy";

const RETENTION_PRESETS = [30, 90, 180, 365];


type HistoryHealth = {
  earliestAt?: string | number | null;
  latestAt?: string | number | null;
  pointCount?: number;
  tableBytes?: number;
  retentionDays?: number | null;
  cleanup?: {
    lastRunAt?: string | number | null;
    lastDeletedCount?: number | null;
    lastError?: string | null;
  };
};

type CleanupPreview = {
  retentionDays: number | null;
  cutoffAt: string | null;
  pointCount: number;
  earliestAt: string | number | null;
  latestAt: string | number | null;
};

// form：改密码时不属于哪个输入框的报错（接口原样的报错对象，按 §8.2 归类后显示）
type PwErrors = { old?: string; next?: string; confirm?: string; form?: unknown };

// 历史记录的日期时间：按业务时区写「10月9日 14:30」（§6）；没有时写「还没有」
function formatDateTime(value: string | number | null | undefined, tz: string) {
  const text = value ? formatZonedDateTime(value, tz) : EMPTY;
  return text === EMPTY ? COPY.none : text;
}

function formatBytes(value: number | null | undefined, loading = false) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return loading ? COPY.reading : EMPTY;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <span className="jy-err" id={id}>
      <Sym kind="crit" />
      {text}
    </span>
  );
}

function focusById(id: string) {
  window.setTimeout(() => document.getElementById(id)?.focus(), 0);
}

export default function SettingsPage() {
  const { message, modal } = App.useApp();
  const uid = useId();
  const ids = {
    interval: `${uid}-interval`,
    retention: `${uid}-retention`,
    username: `${uid}-username`,
    pwOld: `${uid}-pw-old`,
    pwNew: `${uid}-pw-new`,
    pwConfirm: `${uid}-pw-confirm`,
  };

  // 运行设置：刷新间隔、保留天数各一组，改了马上保存（app/components/use-auto-save.ts），排在同一个队列里
  const queue = useSaveQueue();
  const [customRetention, setCustomRetention] = useState(false);
  const [history, setHistory] = useState<HistoryHealth | null>(null);
  // 业务时区：接口返回的 tz，历史记录的日期时间按它写
  const [tz, setTz] = useState(DEFAULT_BUSINESS_TIME_ZONE);
  // 接口明确说没加密才提示；老接口不带这个字段时不提示
  const [plainSecrets, setPlainSecrets] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const [previewingCleanup, setPreviewingCleanup] = useState(false);

  // 账户（/api/auth/me：用户名 + 是否仍是默认密码）
  const [me, setMe] = useState<{ username: string; isDefaultPassword: boolean } | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [meError, setMeError] = useState<unknown>(null);
  const [username, setUsername] = useState("");
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwErrors, setPwErrors] = useState<PwErrors>({});
  const [pwSaving, setPwSaving] = useState(false);

  // 关于（/api/meta 的 app：版本号 + 构建 commit）
  const [appInfo, setAppInfo] = useState<{ version: string; commit: string | null } | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [metaError, setMetaError] = useState<unknown>(null);

  const isPreset = (days: number | null) => days == null || RETENTION_PRESETS.includes(days);
  // 保存一组：请求体只带这一组的字段（服务端缺哪项就不动哪项）；服务端可能钳制过（间隔最小 10 秒），以返回值为准
  const putSettings = async (body: Record<string, unknown>) => {
    const r = await api("/api/settings", { method: "PUT", body });
    if (r.tz) setTz(r.tz);
    if (r.history) setHistory(r.history);
    else void loadSettings();
    return r.settings;
  };
  const interval = useAutoSave<number | null>(null, {
    queue,
    label: COPY.interval,
    validate: (v) => (v == null ? requiredText(COPY.interval) : v < 10 ? COPY.intervalMin : null),
    save: async (v) => (await putSettings({ refreshIntervalSec: Number(v) })).refreshIntervalSec,
  });
  // 保留天数：缩短时先预览会删多少，再由确认框明确同意不可恢复的删除；取消就回到原来的天数
  const retention = useAutoSave<number | null>(null, {
    queue,
    label: COPY.retention,
    confirm: (next, saved) => (next != null && (saved == null || next < saved) ? confirmShorten(next) : Promise.resolve(true)),
    save: async (next, saved) => {
      const shortening = next != null && (saved == null || next < saved);
      const r = await putSettings({ historyRetentionDays: next, ...(shortening ? { confirmRetentionCleanup: true } : {}) });
      return r.historyRetentionDays == null ? null : Number(r.historyRetentionDays);
    },
    onRevert: (saved) => setCustomRetention(!isPreset(saved)),
  });

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const result = await api("/api/settings");
      if (result.tz) setTz(result.tz);
      const days = result.settings.historyRetentionDays == null ? null : Number(result.settings.historyRetentionDays);
      interval.sync(result.settings.refreshIntervalSec);
      retention.sync(days);
      setCustomRetention((custom) => custom || !isPreset(days));
      if (result.history) setHistory(result.history);
      setPlainSecrets(result.secretsEncrypted === false);
      setSettingsError(null);
      setSettingsLoaded(true);
    } catch (e) {
      setSettingsError(e);
    } finally {
      setSettingsLoading(false);
    }
  // interval.sync、retention.sync 是稳定的
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMeta = useCallback(async () => {
    setMetaLoaded(false);
    try {
      const result = await api("/api/meta");
      setAppInfo(result.app || null);
      setMetaError(null);
    } catch (e) {
      setMetaError(e);
    } finally {
      setMetaLoaded(true);
    }
  }, []);

  // 重试时不把 meLoaded 置回 false：否则其他分组会闪回骨架
  const loadMe = useCallback(async () => {
    try {
      const result = await api("/api/auth/me");
      setMe(result);
      setMeError(null);
    } catch (e) {
      setMeError(e);
    } finally {
      setMeLoaded(true);
    }
  }, []);

  // 挂载时拉一次运行设置、元信息与会话信息。
  useEffect(() => {
    void loadSettings();
    void loadMeta();
    void loadMe();
  }, [loadMe, loadMeta, loadSettings]);

  const retentionChoice = useMemo(() => {
    if (customRetention) return "custom";
    if (retention.value == null) return "permanent";
    return RETENTION_PRESETS.includes(retention.value) ? String(retention.value) : "custom";
  }, [customRetention, retention.value]);

  // 下拉一改就存；选「自定义…」时先出天数框，离开天数框或按回车时再存
  const setRetentionChoice = (value: string) => {
    if (value === "custom") {
      setCustomRetention(true);
      retention.setValue((current) => (current && current > 0 ? current : 30));
      return;
    }
    const days = value === "permanent" ? null : Number(value);
    setCustomRetention(false);
    retention.setValue(days);
    void retention.commit(days);
  };

  const retentionShortening = retention.value != null && (retention.saved == null || retention.value < retention.saved);
  // 用户名输入框默认留空（留空即不修改），填了不同的名字才算有改动
  const accountDirty = !!(pwOld || pwNew || pwConfirm) || (!!username.trim() && username.trim() !== (me?.username || ""));

  // 缩短前先预览会删多少；确认了才存。预览读不到就不存（回到原来的天数，算没存上）
  const confirmShorten = async (nextRetention: number) => {
    setPreviewingCleanup(true);
    let preview: CleanupPreview;
    // 预览读不到时往外抛：不存，标题旁写「历史数据保留没存上：原因。」（useAutoSave 接住）
    try {
      preview = (await api(`/api/settings/history-preview?days=${nextRetention}`)).preview as CleanupPreview;
    } finally {
      setPreviewingCleanup(false);
    }
    const affectedRange = preview.pointCount > 0
      ? COPY.confirmRange(formatDateTime(preview.earliestAt, tz), formatDateTime(preview.latestAt, tz))
      : COPY.confirmNone;
    return new Promise<boolean>((resolve) => {
      modal.confirm({
        title: COPY.confirmTitle,
        content: (
          <div className="jy-settings-confirm">
            <p>{COPY.confirmBody}</p>
            <p className="jy-caption">
              {COPY.confirmPlan(COPY.policy(nextRetention), formatInt(preview.pointCount || 0))}
              {affectedRange}
            </p>
            <p className="jy-caption">{COPY.confirmKeep(formatDateTime(preview.cutoffAt, tz))}</p>
          </div>
        ),
        okText: COPY.confirmOk,
        okButtonProps: { danger: true },
        cancelText: COPY.cancel,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };

  // 修改用户名/密码：先在本地校验必填、长度和两次输入一致，服务端仍会再校验原密码与长度。
  // 新密码太短的那句和服务端同一处来源（PASSWORD_TOO_SHORT）
  const onChangePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errs: PwErrors = {};
    if (!pwOld) errs.old = requiredText(COPY.oldPassword);
    if (!pwNew) errs.next = requiredText(COPY.newPassword);
    else if (pwNew.length < 6) errs.next = errorText({ code: "PASSWORD_TOO_SHORT" });
    if (!pwConfirm) errs.confirm = requiredText(COPY.confirmPassword);
    else if (pwNew && pwConfirm !== pwNew) errs.confirm = COPY.mismatch;
    setPwErrors(errs);
    if (errs.old) return focusById(ids.pwOld);
    if (errs.next) return focusById(ids.pwNew);
    if (errs.confirm) return focusById(ids.pwConfirm);

    setPwSaving(true);
    try {
      await api("/api/auth/password", {
        body: { oldPassword: pwOld, newPassword: pwNew, username: username.trim() || undefined },
      });
      setPwOld("");
      setPwNew("");
      setPwConfirm("");
      message.success(COPY.changed);
      // 改密接口会使全部旧会话失效，直接回登录页避免继续停留在受限壳中。
      window.setTimeout(() => { window.location.href = "/login"; }, 600);
    } catch (err) {
      // 按接口给的码落到对应输入框（原密码不对、新密码太短），其余放在表单顶部
      const { code } = describeError(err);
      if (code === "WRONG_PASSWORD") {
        setPwErrors({ old: errorText(err) });
        focusById(ids.pwOld);
      } else if (code === "PASSWORD_TOO_SHORT") {
        setPwErrors({ next: errorText(err) });
        focusById(ids.pwNew);
      } else {
        setPwErrors({ form: err });
      }
    } finally {
      setPwSaving(false);
    }
  };

  const restricted = !!me?.isDefaultPassword;
  // 上次自动清理没完成：服务端存的是原文，只进「查看详细原因」
  const cleanupError = history?.cleanup?.lastError || null;
  // 现在保留多久：一直保留时不再自动清理
  const keptDays = history?.retentionDays ?? retention.saved;
  // 会话信息回来之前不确定是否处于"首次改密"模式，先用骨架占位，避免其他分组闪现后又消失
  const showOthers = meLoaded && !restricted;
  const settingsFailed = !settingsLoaded && !settingsLoading && !!settingsError;

  // 软件版本和侧栏一样写「2.2.0」；部署时注入了提交编号的，括号里带上，给技术同事定位
  const versionText = appInfo
    ? `${appInfo.version}${appInfo.commit ? `（${appInfo.commit}）` : ""}`
    : metaLoaded ? EMPTY : COPY.reading;
  const pwFormNote = pwErrors.form ? noteOf(pwErrors.form) : null;

  const accountPanel = (
    <Panel title={COPY.account} badge={<Dirty show={accountDirty} />}>
      {meError ? (
        <div className="jy-settings-inline-error">
          <ErrorState what={COPY.accountFailed} error={meError} onRetry={() => void loadMe()} />
        </div>
      ) : null}
      <form className="jy-settings-form" onSubmit={onChangePassword} noValidate aria-describedby={pwFormNote ? `${uid}-pw-form` : undefined}>
        {pwFormNote ? (
          <div className="jy-banner jy-banner--crit" role="alert" id={`${uid}-pw-form`}>
            <Sym kind="crit" />
            <div className="jy-banner__body">
              <b>{consoleFailureText(COPY.changeFailed, pwErrors.form)}</b>
              <ErrorDetail raw={pwFormNote.raw} />
            </div>
          </div>
        ) : null}
        <div className="jy-field">
          <label htmlFor={ids.username}>{COPY.username}</label>
          <Input
            id={ids.username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={me?.username ? COPY.usernameKeep(me.username) : COPY.usernameKeepAny}
            autoComplete="username"
            aria-describedby={`${ids.username}-desc`}
          />
          <span className="jy-caption" id={`${ids.username}-desc`}>
            {COPY.currentUser(me?.username || (meLoaded ? EMPTY : COPY.reading))}
          </span>
        </div>
        <div className="jy-field">
          <label htmlFor={ids.pwOld}>{COPY.oldPassword}</label>
          <Input.Password
            id={ids.pwOld}
            value={pwOld}
            onChange={(e) => {
              setPwOld(e.target.value);
              if (pwErrors.old) setPwErrors((p) => ({ ...p, old: undefined }));
            }}
            autoComplete="current-password"
            status={pwErrors.old ? "error" : undefined}
            aria-invalid={!!pwErrors.old}
            aria-describedby={pwErrors.old ? `${ids.pwOld}-err` : undefined}
          />
          <FieldError id={`${ids.pwOld}-err`} text={pwErrors.old} />
        </div>
        <div className="jy-two">
          <div className="jy-field">
            <label htmlFor={ids.pwNew}>{COPY.newPassword}</label>
            <Input.Password
              id={ids.pwNew}
              value={pwNew}
              onChange={(e) => {
                setPwNew(e.target.value);
                if (pwErrors.next) setPwErrors((p) => ({ ...p, next: undefined }));
              }}
              autoComplete="new-password"
              status={pwErrors.next ? "error" : undefined}
              aria-invalid={!!pwErrors.next}
              aria-describedby={pwErrors.next ? `${ids.pwNew}-err` : `${ids.pwNew}-desc`}
            />
            {pwErrors.next ? (
              <FieldError id={`${ids.pwNew}-err`} text={pwErrors.next} />
            ) : (
              <span className="jy-caption" id={`${ids.pwNew}-desc`}>{COPY.minLength}</span>
            )}
          </div>
          <div className="jy-field">
            <label htmlFor={ids.pwConfirm}>{COPY.confirmPassword}</label>
            <Input.Password
              id={ids.pwConfirm}
              value={pwConfirm}
              onChange={(e) => {
                setPwConfirm(e.target.value);
                if (pwErrors.confirm) setPwErrors((p) => ({ ...p, confirm: undefined }));
              }}
              autoComplete="new-password"
              status={pwErrors.confirm ? "error" : undefined}
              aria-invalid={!!pwErrors.confirm}
              aria-describedby={pwErrors.confirm ? `${ids.pwConfirm}-err` : undefined}
            />
            <FieldError id={`${ids.pwConfirm}-err`} text={pwErrors.confirm} />
          </div>
        </div>
        <div className="jy-settings-actions">
          <Button type="primary" htmlType="submit" loading={pwSaving}>
            {COPY.changePassword}
          </Button>
          <span className="jy-caption">{COPY.changeHint}</span>
        </div>
      </form>
    </Panel>
  );

  return (
    <div className="jy-page">
      {restricted ? (
        <div className="jy-banner jy-banner--crit">
          <Sym kind="crit" />
          <div className="jy-settings-banner-text">
            <b>{errorText({ code: "DEFAULT_PASSWORD_CHANGE_REQUIRED" })}</b>
            <span>{COPY.firstLoginHint}</span>
          </div>
        </div>
      ) : null}

      {plainSecrets ? (
        <div className="jy-banner" role="status">
          <Sym kind="warn" />
          <div className="jy-settings-banner-text">
            <b>{COPY.plainSecrets}</b>
            <span>{COPY.plainSecretsHint}</span>
          </div>
        </div>
      ) : null}

      {/* 版式（ui-design-spec §5.8、#64 第 9 节）：两栏各 6 列，左边刷新与数据、历史数据保留，右边账户安全、关于；
          首次登录必须先改密码时只有账户安全一块，不分栏 */}
      {meLoaded && !showOthers ? (
        accountPanel
      ) : (
        <div className="jy-grid-2 jy-settings-grid">
          <div className="jy-stack">
            {!meLoaded ? (
              <>
                <PanelSkeleton title={COPY.refresh} lines={2} />
                <PanelSkeleton title={COPY.retention} lines={5} />
              </>
            ) : showOthers ? (
              settingsFailed ? (
                // 三组都依赖同一次读取，失败时合成一处提示，避免同一原因重复三遍
                <Panel title={NAV_LABELS.settings}>
                  <ErrorState what={COPY.readFailed} error={settingsError} onRetry={() => void loadSettings()} />
                </Panel>
              ) : !settingsLoaded ? (
                <>
                  <PanelSkeleton title={COPY.refresh} lines={2} />
                  <PanelSkeleton title={COPY.retention} lines={5} />
                </>
              ) : (
                <>
                  <Panel title={COPY.refresh} badge={<SaveState saving={interval.saving} dirty={interval.dirty} at={interval.savedAt} tz={tz} failures={[interval.failure]} />}>
                    <div className="jy-field jy-settings-field">
                      <label htmlFor={ids.interval}>{COPY.interval}</label>
                      <InputNumber
                        id={ids.interval}
                        value={interval.value}
                        onChange={(v) => {
                          interval.setValue(v);
                          interval.clearInvalid();
                        }}
                        {...commitOnLeave(interval.commit)}
                        min={10}
                        suffix={COPY.seconds}
                        status={interval.invalid ? "error" : undefined}
                        aria-invalid={!!interval.invalid}
                        aria-describedby={`${ids.interval}-desc${interval.invalid ? ` ${ids.interval}-err` : ""}`}
                      />
                      <span className="jy-caption" id={`${ids.interval}-desc`}>{COPY.intervalHint}</span>
                      <FieldError id={`${ids.interval}-err`} text={interval.invalid || undefined} />
                    </div>
                    <p className="jy-caption">
                      {COPY.lowLineMovedBefore}
                      <Link className="jy-link" href="/notifications">{NAV_LABELS.notifications}</Link>
                      {COPY.lowLineMovedAfter}
                    </p>
                  </Panel>

                  <Panel title={COPY.retention} badge={<SaveState saving={retention.saving || previewingCleanup} dirty={retention.dirty} at={retention.savedAt} tz={tz} failures={[retention.failure]} />}>
                    {settingsError ? (
                      // 已有数据时重新读取失败：保留当前内容，只在本组提示
                      <div className="jy-settings-inline-error">
                        <ErrorState what={COPY.overviewFailed} error={settingsError} onRetry={() => void loadSettings()} />
                      </div>
                    ) : null}
                    <div className="jy-field">
                      <label htmlFor={ids.retention}>{COPY.keep}</label>
                      <div className="jy-settings-inline">
                        <Select
                          id={ids.retention}
                          value={retentionChoice}
                          onChange={setRetentionChoice}
                          disabled={!settingsLoaded}
                          options={[
                            { value: "permanent", label: COPY.keepForever },
                            ...RETENTION_PRESETS.map((days) => ({ value: String(days), label: COPY.keepDays(days) })),
                            { value: "custom", label: COPY.keepCustom },
                          ]}
                          aria-describedby={`${ids.retention}-desc`}
                        />
                        {customRetention ? (
                          <InputNumber
                            aria-label={COPY.keepCustomLabel}
                            value={retention.value}
                            onChange={(value) => {
                              if (value != null) retention.setValue(Number(value));
                            }}
                            {...commitOnLeave(retention.commit)}
                            disabled={!settingsLoaded}
                            min={1}
                            precision={0}
                            suffix={COPY.days}
                          />
                        ) : null}
                      </div>
                      <span className="jy-caption" id={`${ids.retention}-desc`}>
                        {COPY.keepHint}
                      </span>
                      {retention.dirty && retentionShortening ? (
                        <span className="jy-settings-note">
                          <Sym kind="warn" />
                          {COPY.keepShorter}
                        </span>
                      ) : null}
                    </div>

                    {/* 历史概况、最近自动清理收起来，露一句记录数和最早的日子；上次自动清理没完成时直接展开（原因就是要说的事） */}
                    <div className="jy-more-line jy-settings-health-line">
                      <span className="jy-caption">
                        {history?.pointCount ? COPY.healthSummary(formatInt(history.pointCount), formatZonedDate(history.earliestAt, tz)) : COPY.healthEmpty}
                      </span>
                      <More key={cleanupError ? "err" : "ok"} label={COPY.healthMore} defaultOpen={!!cleanupError}>
                        <div className="jy-settings-health">
                          <section aria-labelledby={`${uid}-health`}>
                            <h3 id={`${uid}-health`}>{COPY.overview}</h3>
                            <p className="jy-caption">
                              {history?.latestAt ? COPY.latest(formatDateTime(history.latestAt, tz)) : COPY.growing}
                            </p>
                            <dl className="jy-kv">
                              <dt>{COPY.earliest}</dt>
                              <dd>{formatDateTime(history?.earliestAt, tz)}</dd>
                              <dt>{COPY.count}</dt>
                              <dd>{history?.pointCount == null ? EMPTY : COPY.rows(formatInt(history.pointCount))}</dd>
                              <dt>{COPY.size}</dt>
                              <dd>{formatBytes(history?.tableBytes, !settingsLoaded)}</dd>
                            </dl>
                          </section>
                          <section aria-labelledby={`${uid}-cleanup`}>
                            <h3 id={`${uid}-cleanup`}>{COPY.cleanup}</h3>
                            {cleanupError ? (
                              <div className="jy-err jy-settings-cleanup-err">
                                <Sym kind="crit" />
                                <div>
                                  {COPY.cleanupFailed}
                                  {keptDays != null ? COPY.cleanupRetry : ""}
                                  <ErrorDetail raw={cleanupError} />
                                </div>
                              </div>
                            ) : (
                              <p className="jy-caption">{COPY.cleanupHint}</p>
                            )}
                            <dl className="jy-kv">
                              <dt>{COPY.keep}</dt>
                              <dd>{settingsLoaded ? COPY.policy(keptDays) : COPY.reading}</dd>
                              <dt>{COPY.lastCheck}</dt>
                              <dd>{formatDateTime(history?.cleanup?.lastRunAt, tz)}</dd>
                              <dt>{COPY.lastDeleted}</dt>
                              <dd>
                                {history?.cleanup?.lastDeletedCount == null
                                  ? COPY.none
                                  : COPY.rows(formatInt(history.cleanup.lastDeletedCount))}
                              </dd>
                            </dl>
                          </section>
                        </div>
                      </More>
                    </div>
                  </Panel>
                </>
              )
            ) : null}

          </div>
          <div className="jy-stack">
            {meLoaded ? accountPanel : <PanelSkeleton title={COPY.account} lines={4} />}
            {showOthers ? (
              <Panel title={COPY.about}>
                {metaError ? (
                  <div className="jy-settings-inline-error">
                    <ErrorState what={COPY.metaFailed} error={metaError} onRetry={() => void loadMeta()} />
                  </div>
                ) : null}
                <dl className="jy-kv jy-settings-about">
                  <dt>{COPY.product}</dt>
                  <dd>
                    <b>{BRAND.productName}</b>
                    <span className="jy-caption">{COPY.productHint}</span>
                  </dd>
                  <dt>{VERSION_LABEL}</dt>
                  <dd>
                    <code className="jy-settings-code">{versionText}</code>
                    <span className="jy-caption">{COPY.versionHint}</span>
                  </dd>
                </dl>
              </Panel>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
