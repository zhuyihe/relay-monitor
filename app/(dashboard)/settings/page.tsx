"use client";
// 系统设置：刷新与数据、告警阈值、历史数据留存、账户安全、关于。
// 每组单独保存；PUT /api/settings 的请求体仍是原来的三个字段，
// 非本组字段填"已保存的值"，服务端对未变化的值不做任何事（间隔相同不重启调度、留存不缩短不清理）。
import "../../styles/pages/settings.css";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { App, Button, Input, InputNumber, Select } from "antd";
import { BRAND } from "../../../lib/brand";
import { api } from "../../../lib/client";
import { Panel } from "../../components/panel";
import { ErrorState, PanelSkeleton } from "../../components/data-state";
import { Sym } from "../../components/icons";

const RETENTION_PRESETS = [30, 90, 180, 365];

type Group = "refresh" | "threshold" | "retention";
// "all"：首次读取/重试，覆盖全部输入；某一组：只回填该组；"none"：只更新已保存值和历史概况
type ApplyScope = "all" | "none" | Group;

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

type PwErrors = { old?: string; next?: string; confirm?: string; form?: string };

function retentionLabel(days: number | null | undefined) {
  return days == null ? "永久保留" : `保留 ${days} 天`;
}

function formatDateTime(value: string | number | null | undefined) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function formatBytes(value: number | null | undefined, loading = false) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return loading ? "读取中…" : "暂不可用";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function Dirty({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="jy-dirty">
      <i aria-hidden="true" />
      未保存
    </span>
  );
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
    low: `${uid}-low`,
    retention: `${uid}-retention`,
    username: `${uid}-username`,
    pwOld: `${uid}-pw-old`,
    pwNew: `${uid}-pw-new`,
    pwConfirm: `${uid}-pw-confirm`,
  };

  // 运行设置：当前输入值 + 已保存值（用于"未保存"标记和其他组的请求体）
  const [interval, setIntervalSec] = useState<number | null>(null);
  const [savedInterval, setSavedInterval] = useState<number | null>(null);
  const [low, setLow] = useState<number | null>(null);
  const [savedLow, setSavedLow] = useState<number | null>(null);
  const [historyRetentionDays, setHistoryRetentionDays] = useState<number | null>(null);
  const [savedRetentionDays, setSavedRetentionDays] = useState<number | null>(null);
  const [customRetention, setCustomRetention] = useState(false);
  const [history, setHistory] = useState<HistoryHealth | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [previewingCleanup, setPreviewingCleanup] = useState(false);
  const [savingGroup, setSavingGroup] = useState<Group | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ interval?: string; low?: string }>({});

  // 账户（/api/auth/me：用户名 + 是否仍是默认密码）
  const [me, setMe] = useState<{ username: string; isDefaultPassword: boolean } | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [meError, setMeError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwErrors, setPwErrors] = useState<PwErrors>({});
  const [pwSaving, setPwSaving] = useState(false);

  // 关于（/api/meta 的 app：版本号 + 构建 commit）
  const [appInfo, setAppInfo] = useState<{ version: string; commit: string | null } | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const applySettings = useCallback((next: any, nextHistory: HistoryHealth | null | undefined, scope: ApplyScope) => {
    const retention = next.historyRetentionDays == null ? null : Number(next.historyRetentionDays);
    setSavedInterval(next.refreshIntervalSec);
    setSavedLow(next.lowBalanceUsd);
    setSavedRetentionDays(retention);
    // 只回填本次保存的那一组，别的组里还没保存的输入保持不动
    if (scope === "all" || scope === "refresh") setIntervalSec(next.refreshIntervalSec);
    if (scope === "all" || scope === "threshold") setLow(next.lowBalanceUsd);
    if (scope === "all" || scope === "retention") {
      setHistoryRetentionDays(retention);
      setCustomRetention(retention != null && !RETENTION_PRESETS.includes(retention));
    }
    if (nextHistory) setHistory(nextHistory);
  }, []);

  const loadSettings = useCallback(async (scope: ApplyScope = "all") => {
    setSettingsLoading(true);
    try {
      const result = await api("/api/settings");
      applySettings(result.settings, result.history, scope);
      setSettingsError(null);
      setSettingsLoaded(true);
    } catch (e: any) {
      setSettingsError(e.message || "系统设置加载失败");
    } finally {
      setSettingsLoading(false);
    }
  }, [applySettings]);

  const loadMeta = useCallback(async () => {
    setMetaLoaded(false);
    try {
      const result = await api("/api/meta");
      setAppInfo(result.app || null);
      setMetaError(null);
    } catch (e: any) {
      setMetaError(e.message || "系统信息加载失败");
    } finally {
      setMetaLoaded(true);
    }
  }, []);

  // 重试时不把 meLoaded 置回 false：否则其他分组会闪回骨架
  const loadMe = useCallback(async () => {
    try {
      const result = await api("/api/auth/me");
      setMe(result);
      setUsername(result.username || "");
      setMeError(null);
    } catch (e: any) {
      setMeError(e.message || "账户信息加载失败");
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
    if (historyRetentionDays == null) return "permanent";
    return RETENTION_PRESETS.includes(historyRetentionDays) ? String(historyRetentionDays) : "custom";
  }, [historyRetentionDays]);

  const setRetentionChoice = (value: string) => {
    if (value === "permanent") {
      setHistoryRetentionDays(null);
      setCustomRetention(false);
      return;
    }
    if (value === "custom") {
      setCustomRetention(true);
      setHistoryRetentionDays((current) => current && current > 0 ? current : 30);
      return;
    }
    setCustomRetention(false);
    setHistoryRetentionDays(Number(value));
  };

  const busy = savingGroup !== null || previewingCleanup;
  const refreshDirty = settingsLoaded && interval !== savedInterval;
  const lowDirty = settingsLoaded && low !== savedLow;
  const retentionDirty = settingsLoaded && historyRetentionDays !== savedRetentionDays;
  const retentionShortening = historyRetentionDays != null && (
    savedRetentionDays == null || historyRetentionDays < savedRetentionDays
  );
  const accountDirty = !!(pwOld || pwNew || pwConfirm) || (me != null && username !== (me.username || ""));

  // 保存某一组。保存期间锁住所有保存按钮：各组请求体里带着别组的"已保存值"，并发会互相覆盖。
  const persistSettings = async (group: Group, confirmRetentionCleanup = false, retentionDays = historyRetentionDays) => {
    setSavingGroup(group);
    try {
      const r = await api("/api/settings", {
        method: "PUT",
        body: {
          refreshIntervalSec: Number(group === "refresh" ? interval : savedInterval),
          lowBalanceUsd: Number(group === "threshold" ? low : savedLow),
          historyRetentionDays: group === "retention" ? retentionDays : savedRetentionDays,
          ...(confirmRetentionCleanup ? { confirmRetentionCleanup: true } : {}),
        },
      });
      // 服务端可能钳制过（间隔最小 10 秒、阈值最小 0），以返回值为准回显
      applySettings(r.settings, r.history, group);
      if (!r.history) void loadSettings("none");
      message.success("设置已保存");
    } catch (e: any) {
      message.error(e.message || "保存失败");
    } finally {
      setSavingGroup(null);
    }
  };

  const ensureLoaded = () => {
    if (settingsLoaded) return true;
    message.warning("请先重新读取当前设置，再进行保存");
    return false;
  };

  const onSaveRefresh = () => {
    if (!ensureLoaded()) return;
    const err = interval == null ? "请填写自动刷新间隔" : interval < 10 ? "自动刷新间隔最短 10 秒" : undefined;
    setFieldErrors((prev) => ({ ...prev, interval: err }));
    if (err) return focusById(ids.interval);
    void persistSettings("refresh");
  };

  const onSaveThreshold = () => {
    if (!ensureLoaded()) return;
    const err = low == null ? "请填写阈值；不需要余额偏低提醒可填 0" : low < 0 ? "阈值不能小于 0" : undefined;
    setFieldErrors((prev) => ({ ...prev, low: err }));
    if (err) return focusById(ids.low);
    void persistSettings("threshold");
  };

  // 缩短原始快照窗口时，先预览会删多少，再由确认操作明确授权不可逆清理。
  const onSaveRetention = async () => {
    if (!ensureLoaded()) return;
    const nextRetention = historyRetentionDays;
    const isShortening = nextRetention != null && (
      savedRetentionDays == null || nextRetention < savedRetentionDays
    );
    if (!isShortening) {
      void persistSettings("retention");
      return;
    }

    setPreviewingCleanup(true);
    try {
      const result = await api(`/api/settings/history-preview?days=${nextRetention}`);
      const preview = result.preview as CleanupPreview;
      const affectedRange = preview.pointCount > 0
        ? `${formatDateTime(preview.earliestAt)} 至 ${formatDateTime(preview.latestAt)}`
        : "没有符合条件的历史记录";
      modal.confirm({
        title: "确认缩短监测历史留存期限？",
        content: (
          <div className="jy-settings-confirm">
            <p>系统将清理早于新期限的原始监测快照，删除后不能从控制台恢复。</p>
            <p className="jy-caption">
              新策略：{retentionLabel(nextRetention)}。预计删除 {Number(preview.pointCount || 0).toLocaleString("zh-CN")} 条快照（{affectedRange}）。
            </p>
            <p className="jy-caption">将保留 {formatDateTime(preview.cutoffAt)} 之后的记录。</p>
          </div>
        ),
        okText: "确认并保存",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => persistSettings("retention", true, nextRetention),
      });
    } catch (e: any) {
      message.error(e.message || "无法获取历史清理预览");
    } finally {
      setPreviewingCleanup(false);
    }
  };

  // 修改用户名/密码：先在本地校验必填、长度和两次输入一致，服务端仍会再校验原密码与长度。
  const onChangePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errs: PwErrors = {};
    if (!pwOld) errs.old = "请输入当前密码";
    if (!pwNew) errs.next = "请输入新密码";
    else if (pwNew.length < 6) errs.next = "新密码至少 6 位";
    if (!pwConfirm) errs.confirm = "请再次输入新密码";
    else if (pwNew && pwConfirm !== pwNew) errs.confirm = "两次输入的新密码不一致";
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
      message.success("已修改密码，请使用新密码重新登录");
      // 改密接口会使全部旧会话失效，直接回登录页避免继续停留在受限壳中。
      window.setTimeout(() => { window.location.href = "/login"; }, 600);
    } catch (err: any) {
      const msg = err?.message || "修改失败";
      // 服务端的两类已知错误落到对应字段，其余放在表单顶部
      if (msg.includes("原密码")) {
        setPwErrors({ old: "当前密码不正确，请重新输入" });
        focusById(ids.pwOld);
      } else if (msg.includes("新密码")) {
        setPwErrors({ next: msg });
        focusById(ids.pwNew);
      } else {
        setPwErrors({ form: msg });
      }
    } finally {
      setPwSaving(false);
    }
  };

  const restricted = !!me?.isDefaultPassword;
  // 会话信息回来之前不确定是否处于"首次改密"模式，先用骨架占位，避免其他分组闪现后又消失
  const showOthers = meLoaded && !restricted;
  const settingsFailed = !settingsLoaded && !settingsLoading && !!settingsError;

  const versionText = appInfo ? `v${appInfo.version}` : metaError ? "暂不可用" : metaLoaded ? "未提供" : "读取中…";
  const commitText = appInfo ? appInfo.commit || "未提供" : metaError ? "暂不可用" : metaLoaded ? "未提供" : "读取中…";

  const accountPanel = (
    <Panel title="账户安全" badge={<Dirty show={accountDirty} />}>
      {meError ? (
        <div className="jy-settings-inline-error">
          <ErrorState title="账户信息暂时无法读取" error={meError} onRetry={() => void loadMe()} />
        </div>
      ) : null}
      <form className="jy-settings-form" onSubmit={onChangePassword} noValidate aria-describedby={pwErrors.form ? `${uid}-pw-form` : undefined}>
        {pwErrors.form ? (
          <div className="jy-banner jy-banner--crit" role="alert" id={`${uid}-pw-form`}>
            <Sym kind="crit" />
            <span>{pwErrors.form}</span>
          </div>
        ) : null}
        <div className="jy-field">
          <label htmlFor={ids.username}>用户名</label>
          <Input
            id={ids.username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            aria-describedby={`${ids.username}-desc`}
          />
          <span className="jy-caption" id={`${ids.username}-desc`}>
            当前用户：{me?.username || (meLoaded ? "暂不可用" : "读取中…")}。留空则不修改用户名
          </span>
        </div>
        <div className="jy-field">
          <label htmlFor={ids.pwOld}>当前密码</label>
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
            <label htmlFor={ids.pwNew}>新密码</label>
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
              <span className="jy-caption" id={`${ids.pwNew}-desc`}>至少 6 位</span>
            )}
          </div>
          <div className="jy-field">
            <label htmlFor={ids.pwConfirm}>确认新密码</label>
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
            修改密码
          </Button>
          <span className="jy-caption">修改后所有已登录的会话都会退出，需要用新密码重新登录</span>
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
            <b>首次登录请先设置新的管理员密码；完成后需重新登录。</b>
            <span>请完成首次密码修改后继续使用控制台。</span>
          </div>
        </div>
      ) : null}

      {!meLoaded ? (
        <>
          <div className="jy-grid-2">
            <PanelSkeleton title="刷新与数据" lines={2} />
            <PanelSkeleton title="告警阈值" lines={2} />
          </div>
          <PanelSkeleton title="历史数据留存" lines={5} />
        </>
      ) : showOthers ? (
        settingsFailed ? (
          // 三组都依赖同一次读取，失败时合成一处提示，避免同一原因重复三遍
          <Panel title="运行设置">
            <ErrorState title="系统设置暂时无法读取" error={settingsError} onRetry={() => void loadSettings()} />
          </Panel>
        ) : !settingsLoaded ? (
          <>
            <div className="jy-grid-2">
              <PanelSkeleton title="刷新与数据" lines={2} />
              <PanelSkeleton title="告警阈值" lines={2} />
            </div>
            <PanelSkeleton title="历史数据留存" lines={5} />
          </>
        ) : (
          <>
            <div className="jy-grid-2">
              <Panel title="刷新与数据" badge={<Dirty show={refreshDirty} />}>
                <div className="jy-field jy-settings-field">
                  <label htmlFor={ids.interval}>自动刷新间隔</label>
                  <InputNumber
                    id={ids.interval}
                    value={interval}
                    onChange={(v) => {
                      setIntervalSec(v);
                      if (fieldErrors.interval) setFieldErrors((p) => ({ ...p, interval: undefined }));
                    }}
                    min={10}
                    suffix="秒"
                    status={fieldErrors.interval ? "error" : undefined}
                    aria-invalid={!!fieldErrors.interval}
                    aria-describedby={`${ids.interval}-desc${fieldErrors.interval ? ` ${ids.interval}-err` : ""}`}
                  />
                  <span className="jy-caption" id={`${ids.interval}-desc`}>后台按此间隔更新上游资源余额，最短 10 秒</span>
                  <FieldError id={`${ids.interval}-err`} text={fieldErrors.interval} />
                </div>
                <div className="jy-settings-actions">
                  <Button type="primary" onClick={onSaveRefresh} loading={savingGroup === "refresh"} disabled={busy && savingGroup !== "refresh"}>
                    保存修改
                  </Button>
                </div>
              </Panel>

              <Panel title="告警阈值" badge={<Dirty show={lowDirty} />}>
                <div className="jy-field jy-settings-field">
                  <label htmlFor={ids.low}>全局低余额阈值</label>
                  <InputNumber
                    id={ids.low}
                    value={low}
                    onChange={(v) => {
                      setLow(v);
                      if (fieldErrors.low) setFieldErrors((p) => ({ ...p, low: undefined }));
                    }}
                    min={0}
                    status={fieldErrors.low ? "error" : undefined}
                    aria-invalid={!!fieldErrors.low}
                    aria-describedby={`${ids.low}-desc${fieldErrors.low ? ` ${ids.low}-err` : ""}`}
                  />
                  <span className="jy-caption" id={`${ids.low}-desc`}>
                    剩余余额低于此值时标记为「余额偏低」。按各上游资源自己的余额单位比较（设了汇率的是美元额度），不做汇率换算；上游资源单独设置的阈值优先。告警的开关与通知渠道在
                    <Link className="jy-link" href="/notifications">告警中心</Link>
                    设置
                  </span>
                  <FieldError id={`${ids.low}-err`} text={fieldErrors.low} />
                </div>
                <div className="jy-settings-actions">
                  <Button type="primary" onClick={onSaveThreshold} loading={savingGroup === "threshold"} disabled={busy && savingGroup !== "threshold"}>
                    保存修改
                  </Button>
                </div>
              </Panel>
            </div>

            <Panel title="历史数据留存" badge={<Dirty show={retentionDirty} />}>
              {settingsError ? (
                // 已有数据时重新读取失败：保留当前内容，只在本组提示
                <div className="jy-settings-inline-error">
                  <ErrorState title="历史概况暂时无法更新" error={settingsError} onRetry={() => void loadSettings("none")} />
                </div>
              ) : null}
              <div className="jy-field">
                <label htmlFor={ids.retention}>原始快照留存</label>
                <div className="jy-settings-inline">
                  <Select
                    id={ids.retention}
                    value={retentionChoice}
                    onChange={setRetentionChoice}
                    disabled={!settingsLoaded || busy}
                    options={[
                      { value: "permanent", label: "永久保留（默认）" },
                      ...RETENTION_PRESETS.map((days) => ({ value: String(days), label: `${days} 天` })),
                      { value: "custom", label: "自定义…" },
                    ]}
                    aria-describedby={`${ids.retention}-desc`}
                  />
                  {customRetention ? (
                    <InputNumber
                      aria-label="自定义历史留存天数"
                      value={historyRetentionDays}
                      onChange={(value) => {
                        if (value != null) setHistoryRetentionDays(Number(value));
                      }}
                      disabled={!settingsLoaded || busy}
                      min={1}
                      precision={0}
                      suffix="天"
                    />
                  ) : null}
                </div>
                <span className="jy-caption" id={`${ids.retention}-desc`}>
                  保存的是定时采集的余额与消耗快照，不是 API 请求明细；永久保留会持续占用数据库空间。
                </span>
                {retentionDirty && retentionShortening ? (
                  <span className="jy-settings-note">
                    <Sym kind="warn" />
                    缩短留存期限会删除超期快照，保存前会先显示预计删除的数量
                  </span>
                ) : null}
              </div>

              <div className="jy-settings-health">
                <section aria-labelledby={`${uid}-health`}>
                  <h3 id={`${uid}-health`}>历史健康度</h3>
                  <p className="jy-caption">
                    {history?.latestAt ? `数据最新记录于 ${formatDateTime(history.latestAt)}` : "历史规模会随监测持续累积"}
                  </p>
                  <dl className="jy-kv">
                    <dt>最早记录</dt>
                    <dd>{formatDateTime(history?.earliestAt)}</dd>
                    <dt>原始快照</dt>
                    <dd>{history?.pointCount == null ? "—" : `${Number(history.pointCount).toLocaleString("zh-CN")} 条`}</dd>
                    <dt>历史表占用</dt>
                    <dd>{formatBytes(history?.tableBytes, !settingsLoaded)}</dd>
                  </dl>
                </section>
                <section aria-labelledby={`${uid}-cleanup`}>
                  <h3 id={`${uid}-cleanup`}>最近自动清理</h3>
                  {history?.cleanup?.lastError ? (
                    <p className="jy-err">
                      <Sym kind="crit" />
                      清理失败：{history.cleanup.lastError}
                    </p>
                  ) : (
                    <p className="jy-caption">仅设置有限留存期限后才会自动清理超期原始快照</p>
                  )}
                  <dl className="jy-kv">
                    <dt>策略</dt>
                    <dd>{settingsLoaded ? retentionLabel(history?.retentionDays ?? savedRetentionDays) : "读取中…"}</dd>
                    <dt>上次检查</dt>
                    <dd>{history?.cleanup?.lastRunAt ? formatDateTime(history.cleanup.lastRunAt) : "尚未执行"}</dd>
                    <dt>上次清理</dt>
                    <dd>
                      {history?.cleanup?.lastDeletedCount == null
                        ? "尚未执行"
                        : `${Number(history.cleanup.lastDeletedCount).toLocaleString("zh-CN")} 条`}
                    </dd>
                  </dl>
                </section>
              </div>

              <div className="jy-settings-actions">
                <Button
                  type="primary"
                  onClick={() => void onSaveRetention()}
                  loading={savingGroup === "retention" || previewingCleanup}
                  disabled={!settingsLoaded || (busy && savingGroup !== "retention" && !previewingCleanup)}
                >
                  保存修改
                </Button>
              </div>
            </Panel>
          </>
        )
      ) : null}

      {meLoaded ? accountPanel : <PanelSkeleton title="账户安全" lines={4} />}

      {showOthers ? (
        <Panel title="关于">
          {metaError ? (
            <div className="jy-settings-inline-error">
              <ErrorState title="系统信息暂时无法读取" error={metaError} onRetry={() => void loadMeta()} />
            </div>
          ) : null}
          <dl className="jy-kv jy-settings-about">
            <dt>产品</dt>
            <dd>
              <b>{BRAND.productName}</b>
              <span className="jy-caption">当前运行的管理控制台</span>
            </dd>
            <dt>版本</dt>
            <dd>
              <code className="jy-settings-code">{versionText}</code>
              <span className="jy-caption">当前部署版本</span>
            </dd>
            <dt>构建标识</dt>
            <dd>
              <code className="jy-settings-code">{commitText}</code>
              <span className="jy-caption">用于定位当前部署对应的代码版本</span>
            </dd>
          </dl>
        </Panel>
      ) : null}
    </div>
  );
}
