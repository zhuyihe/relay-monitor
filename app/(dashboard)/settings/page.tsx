"use client";
// 设置页：全局设置（刷新间隔/低余额阈值）+ 面板账号（改用户名/密码）+ 关于
// 对照 v1 app.js renderSettings(1397-1460)：文案与保存行为逐条平移；
// 主题切换由 antd 主题体系接管、退出登录在顶栏用户菜单，故不在本页重复。
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import { Alert, App, Button, Input, InputNumber, Select, Space, Typography } from "antd";
import { BRAND, NAV_LABELS } from "../../../lib/brand";
import { api } from "../../../lib/client";

const { Text } = Typography;

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

// 单行设置项：左侧标题+说明，右侧控件（对照 v1 的 .set-row 结构）
function SetRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row__description">
        <div style={{ fontWeight: 600 }}>{title}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {desc}
        </Text>
      </div>
      <div className="setting-row__controls">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { message, modal } = App.useApp();

  // 全局设置（对照 v1 state.settings：refreshIntervalSec / lowBalanceUsd）
  const [interval, setIntervalSec] = useState<number | null>(null);
  const [low, setLow] = useState<number | null>(null);
  const [historyRetentionDays, setHistoryRetentionDays] = useState<number | null>(null);
  const [savedRetentionDays, setSavedRetentionDays] = useState<number | null>(null);
  const [customRetention, setCustomRetention] = useState(false);
  const [history, setHistory] = useState<HistoryHealth | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [previewingCleanup, setPreviewingCleanup] = useState(false);
  const [saving, setSaving] = useState(false);

  // 面板账号（/api/auth/me：用户名 + 默认密码提醒）
  const [me, setMe] = useState<{ username: string; isDefaultPassword: boolean } | null>(null);
  const [username, setUsername] = useState("");
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  // 关于（/api/meta 的 app：版本号 + 构建 commit）
  const [appInfo, setAppInfo] = useState<{ version: string; commit: string | null } | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [meError, setMeError] = useState<string | null>(null);

  const applySettings = useCallback((next: any, nextHistory?: HistoryHealth | null) => {
    setIntervalSec(next.refreshIntervalSec);
    setLow(next.lowBalanceUsd);
    const retention = next.historyRetentionDays == null ? null : Number(next.historyRetentionDays);
    setHistoryRetentionDays(retention);
    setSavedRetentionDays(retention);
    setCustomRetention(retention != null && !RETENTION_PRESETS.includes(retention));
    if (nextHistory) setHistory(nextHistory);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const result = await api("/api/settings");
      applySettings(result.settings, result.history);
      setSettingsError(null);
      setSettingsLoaded(true);
    } catch (e: any) {
      setSettingsError(e.message || "系统设置加载失败");
    }
  }, [applySettings]);

  const loadMeta = useCallback(async () => {
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

  // 保存全局设置；缩短原始快照窗口时由确认操作明确授权不可逆清理。
  const persistSettings = async (confirmRetentionCleanup = false, retentionDays = historyRetentionDays) => {
    setSaving(true);
    try {
      const r = await api("/api/settings", {
        method: "PUT",
        body: {
          refreshIntervalSec: Number(interval),
          lowBalanceUsd: Number(low),
          historyRetentionDays: retentionDays,
          ...(confirmRetentionCleanup ? { confirmRetentionCleanup: true } : {}),
        },
      });
      // 服务端可能钳制过（间隔最小 10 秒、阈值最小 0），以返回值为准回显
      applySettings(r.settings, r.history);
      if (!r.history) void loadSettings();
      message.success("设置已保存");
    } catch (e: any) {
      message.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const onSaveSettings = async () => {
    if (!settingsLoaded) {
      message.warning("请先重新读取当前设置，再进行保存");
      return;
    }

    const nextRetention = historyRetentionDays;
    const isShortening = nextRetention != null && (
      savedRetentionDays == null || nextRetention < savedRetentionDays
    );
    if (!isShortening) {
      void persistSettings();
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
          <div>
            <div>系统将清理早于新期限的原始监测快照，删除后不能从控制台恢复。</div>
            <Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
              新策略：{retentionLabel(nextRetention)}。预计删除 {Number(preview.pointCount || 0).toLocaleString("zh-CN")} 条快照（{affectedRange}）。
            </Text>
            <Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
              将保留 {formatDateTime(preview.cutoffAt)} 之后的记录。
            </Text>
          </div>
        ),
        okText: "确认并保存",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => persistSettings(true, nextRetention),
      });
    } catch (e: any) {
      message.error(e.message || "无法获取历史清理预览");
    } finally {
      setPreviewingCleanup(false);
    }
  };

  // 修改用户名/密码（对照 v1 pw-save：校验交给服务端，成功后清空密码框）
  const onChangePassword = async () => {
    setPwSaving(true);
    try {
      await api("/api/auth/password", {
        body: { oldPassword: pwOld, newPassword: pwNew, username: username.trim() || undefined },
      });
      setPwOld("");
      setPwNew("");
      message.success("密码已修改，请使用新密码重新登录");
      // 改密接口会使全部旧会话失效，直接回登录页避免继续停留在受限壳中。
      window.setTimeout(() => { window.location.href = "/login"; }, 600);
    } catch (e: any) {
      message.error(e.message || "修改失败");
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <PageContainer
      className="responsive-page"
      title={NAV_LABELS.settings}
      subTitle={me?.isDefaultPassword ? "请完成首次密码修改后继续使用控制台" : "运行策略、账户安全与系统信息"}
    >
      <Space direction="vertical" size={16} style={{ display: "flex" }}>
        {settingsError ? (
          <Alert
            type="error"
            showIcon
            message="系统设置暂时无法读取"
            description={settingsError}
            action={<Button size="small" onClick={() => void loadSettings()}>重试</Button>}
          />
        ) : null}
        {metaError ? (
          <Alert
            type="warning"
            showIcon
            message="系统信息暂时无法读取"
            description={metaError}
            action={<Button size="small" onClick={() => void loadMeta()}>重试</Button>}
          />
        ) : null}
        {meError ? (
          <Alert
            type="warning"
            showIcon
            message="账户信息暂时无法读取"
            description={meError}
            action={<Button size="small" onClick={() => void loadMe()}>重试</Button>}
          />
        ) : null}
        {!me?.isDefaultPassword && <ProCard title="运行策略" headerBordered>
          <SetRow title="自动刷新间隔" desc="后台按此间隔更新上游资源余额">
            <Space>
              <InputNumber
                value={interval}
                onChange={(v) => setIntervalSec(v)}
                min={10}
                style={{ width: 120 }}
              />
              <Text type="secondary">秒</Text>
            </Space>
          </SetRow>
          <SetRow title="全局低余额阈值" desc="剩余余额低于此值时标记为「余额偏低」（可被单站阈值覆盖）">
            <Space>
              <Text type="secondary">$</Text>
              <InputNumber value={low} onChange={(v) => setLow(v)} min={0} style={{ width: 120 }} />
            </Space>
          </SetRow>
        </ProCard>}

        <ProCard title="账户安全" headerBordered>
          {me?.isDefaultPassword && (
            <Alert
              type="warning"
              showIcon
              message="首次登录请先设置新的管理员密码；完成后需重新登录。"
              style={{ marginBottom: 16 }}
            />
          )}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600 }}>修改登录密码</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前用户：{me?.username || (meLoaded ? "暂不可用" : "读取中…")}，密码至少 6 位
            </Text>
          </div>
          <Space className="mobile-form-fields" wrap align="end" size={12}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>用户名</div>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: 180 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>原密码</div>
              <Input.Password value={pwOld} onChange={(e) => setPwOld(e.target.value)} style={{ width: 180 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>新密码</div>
              <Input.Password value={pwNew} onChange={(e) => setPwNew(e.target.value)} style={{ width: 180 }} />
            </div>
            <Button type="primary" loading={pwSaving} onClick={onChangePassword}>
              修改
            </Button>
          </Space>
        </ProCard>

        {!me?.isDefaultPassword && <ProCard title="系统信息" headerBordered>
          <SetRow title="产品" desc="当前运行的管理控制台">
            <Text strong>{BRAND.productName}</Text>
          </SetRow>
          <SetRow title="版本" desc="当前部署版本">
            <Text code>{appInfo ? `v${appInfo.version}` : metaError ? "暂不可用" : metaLoaded ? "未提供" : "读取中…"}</Text>
          </SetRow>
          <SetRow title="构建标识" desc="用于定位当前部署对应的代码版本">
            <Text code>{appInfo ? appInfo.commit || "未提供" : metaError ? "暂不可用" : metaLoaded ? "未提供" : "读取中…"}</Text>
          </SetRow>
        </ProCard>}

        {!me?.isDefaultPassword && <ProCard title="监测历史" headerBordered>
          <SetRow title="原始快照留存" desc="保存的是定时采集的余额与消耗快照，不是 API 请求明细；永久保留会持续占用数据库空间。">
            <Space wrap>
              <Select
                value={retentionChoice}
                onChange={setRetentionChoice}
                disabled={!settingsLoaded || saving || previewingCleanup}
                style={{ width: 160 }}
                options={[
                  { value: "permanent", label: "永久保留（默认）" },
                  ...RETENTION_PRESETS.map((days) => ({ value: String(days), label: `${days} 天` })),
                  { value: "custom", label: "自定义…" },
                ]}
              />
              {customRetention ? (
                <Space size={4}>
                  <InputNumber
                    aria-label="自定义历史留存天数"
                    value={historyRetentionDays}
                    onChange={(value) => {
                      if (value != null) setHistoryRetentionDays(Number(value));
                    }}
                    disabled={!settingsLoaded || saving || previewingCleanup}
                    min={1}
                    precision={0}
                    style={{ width: 112 }}
                  />
                  <Text type="secondary">天</Text>
                </Space>
              ) : null}
            </Space>
          </SetRow>
          <SetRow
            title="历史健康度"
            desc={history?.latestAt ? `数据最新记录于 ${formatDateTime(history.latestAt)}` : "历史规模会随监测持续累积"}
          >
            <Space direction="vertical" size={2} style={{ alignItems: "flex-end" }}>
              <Text style={{ fontVariantNumeric: "tabular-nums" }}>最早记录：{formatDateTime(history?.earliestAt)}</Text>
              <Text style={{ fontVariantNumeric: "tabular-nums" }}>原始快照：{history?.pointCount == null ? "—" : `${Number(history.pointCount).toLocaleString("zh-CN")} 条`}</Text>
              <Text style={{ fontVariantNumeric: "tabular-nums" }}>历史表占用：{formatBytes(history?.tableBytes, !settingsLoaded)}</Text>
            </Space>
          </SetRow>
          <SetRow
            title="最近自动清理"
            desc={history?.cleanup?.lastError ? `清理失败：${history.cleanup.lastError}` : "仅设置有限留存期限后才会自动清理超期原始快照"}
          >
            <Space direction="vertical" size={2} style={{ alignItems: "flex-end" }}>
              <Text style={{ fontVariantNumeric: "tabular-nums" }}>策略：{settingsLoaded ? retentionLabel(history?.retentionDays ?? savedRetentionDays) : "读取中…"}</Text>
              <Text style={{ fontVariantNumeric: "tabular-nums" }}>上次检查：{history?.cleanup?.lastRunAt ? formatDateTime(history.cleanup.lastRunAt) : "尚未执行"}</Text>
              <Text style={{ fontVariantNumeric: "tabular-nums" }}>上次清理：{history?.cleanup?.lastDeletedCount == null ? "尚未执行" : `${Number(history.cleanup.lastDeletedCount).toLocaleString("zh-CN")} 条`}</Text>
            </Space>
          </SetRow>
          <SetRow title="保存设置" desc="应用刷新、告警与监测历史留存策略">
            <Button type="primary" loading={saving || previewingCleanup} disabled={!settingsLoaded} onClick={() => void onSaveSettings()}>
              保存
            </Button>
          </SetRow>
        </ProCard>}
      </Space>
    </PageContainer>
  );
}
