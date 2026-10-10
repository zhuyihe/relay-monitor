"use client";
// 告警中心：告警规则 / 通知渠道 / 每日日报。
// 只在挂载时加载一次、不注册顶栏刷新：自动重载会冲掉正在输入的阈值（沿用 v1 的取舍）。
// 告警规则整块即时生效：开关、渠道选择改动即保存，数字输入在离开输入框或按回车时保存。
import "../../styles/pages/notifications.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { App, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Switch, TimePicker } from "antd";
import dayjs from "dayjs";
import { api } from "../../../lib/client";
import { formatHhmm } from "../../../lib/format";
import { CountBadge, Panel } from "../../components/panel";
import { ErrorState, PanelSkeleton } from "../../components/data-state";
import { Icon, Sym } from "../../components/icons";
import { StatusText } from "../../components/status";
import { TabPanel, Tabs } from "../../components/seg";

type ChannelField = { key: string; label: string; required?: boolean };
type ChannelType = { value: string; label: string; fields: ChannelField[] };
type TestResult = { ok: boolean; text: string; at: number };

// 渠道类型铭牌缩写
const CH_PLATE: Record<string, string> = {
  telegram: "TG", dingtalk: "DT", wecom: "WC", feishu: "FS", bark: "BK",
  ntfy: "NF", serverchan: "SC", resend: "RS", smtp: "SM", webhook: "WH",
};

// 密钥类字段：编辑时不回显，留空提交 = 保持原值（store.updateChannel 对任意键都保留空值原值）。
// Webhook 地址里带着访问令牌，自定义 Webhook 的请求头常含鉴权信息，一并按密钥处理（审计 V1）
const SECRET_KEYS = ["botToken", "secret", "token", "sendKey", "apiKey", "password", "deviceKey", "webhook", "url", "headersJson"];

// 告警规则：事件键（渠道绑定用）+ 开关键
const RULES = [
  { ev: "low", key: "onLow", title: "余额偏低", desc: "剩余余额低于阈值时通知" },
  { ev: "exhaust", key: "onExhaust", title: "余额耗尽", desc: "剩余余额归零时通知" },
  { ev: "error", key: "onError", title: "查询失败", desc: "接口查询出错时通知（令牌失效、上游宕机等）" },
  { ev: "recover", key: "onRecover", title: "恢复正常", desc: "从异常状态恢复后通知" },
  { ev: "eta", key: "onEta", title: "耗尽预警", desc: "按消耗速度预计即将耗尽时通知" },
];

// 阈值内部按天存储；界面按所选单位展示
function etaRuleDisplay(r: any): number {
  const days = Number(r?.etaDays ?? 3);
  return r?.etaUnit === "hours" ? +(days * 24).toFixed(2) : +days.toFixed(2);
}

// 字段说明里用的简称：去掉「（可选…）」之类的括注；英文开头时补一个空格
function shortLabel(label: string) {
  const s = label.replace(/（.*?）/g, "").trim();
  return /^[A-Za-z]/.test(s) ? ` ${s}` : s;
}

function sameIds(a: string[] = [], b: string[] = []) {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function Dirty({ show }: { show: boolean }) {
  return show ? (
    <span className="jy-dirty">
      <i aria-hidden="true" />
      未保存
    </span>
  ) : null;
}

// 即时保存的状态：保存中 / 有没保存的输入 / 上次保存时间
function SaveState({ saving, dirty, at }: { saving: boolean; dirty: boolean; at: number }) {
  return (
    <span aria-live="polite">
      {saving ? <span className="jy-dirty">保存中…</span> : dirty ? <Dirty show /> : at ? <span className="jy-dirty">已保存 {formatHhmm(at)}</span> : null}
    </span>
  );
}

type RuleForm = {
  etaUnit: "days" | "hours";
  etaVal: number | null;
  renotify: number | null;
  errThreshold: number | null;
  errRetry: number | null;
};

// 测试发送结果：图标 + 文字 + 底色，不单靠颜色
function ResultBox({ r, okTitle }: { r: TestResult; okTitle: string }) {
  return (
    <div className={`jy-test-result${r.ok ? "" : " jy-test-result--bad"}`}>
      <Sym kind={r.ok ? "good" : "crit"} />
      <b>{r.ok ? okTitle : "发送失败"}</b>
      <span>
        {r.text}
        {r.text ? "；" : ""}
        {formatHhmm(r.at)} 发送
      </span>
    </div>
  );
}

export default function NotificationsPage() {
  const { message, modal } = App.useApp();
  const uid = useId();

  // 渠道 / 规则 / 渠道类型来自 /api/notifications
  const [notifLoaded, setNotifLoaded] = useState(false);
  const [notifLoading, setNotifLoading] = useState(true);
  const [notifErr, setNotifErr] = useState<unknown>(null);
  const [channels, setChannels] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [channelTypes, setChannelTypes] = useState<ChannelType[]>([]);
  // 日报设置来自 /api/meta 的 settings
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaErr, setMetaErr] = useState<unknown>(null);
  const [settings, setSettings] = useState<any>({});

  // 规则阈值输入（开关和渠道绑定直接落库，不经过这里）
  const [etaVal, setEtaVal] = useState<number | null>(null);
  const [etaUnit, setEtaUnit] = useState<"days" | "hours">("days");
  const [renotify, setRenotify] = useState<number | null>(24);
  const [errThreshold, setErrThreshold] = useState<number | null>(1);
  const [errRetry, setErrRetry] = useState<number | null>(30);
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSavedAt, setRulesSavedAt] = useState(0);
  const [channelsFor, setChannelsFor] = useState<Record<string, string[]>>({});

  // 每日日报表单
  const [drEnabled, setDrEnabled] = useState(false);
  const [drTime, setDrTime] = useState("09:00");
  const [drChannelIds, setDrChannelIds] = useState<string[]>([]);
  const [drSaving, setDrSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<(TestResult & { fails: string[] }) | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportTab, setReportTab] = useState<"html" | "text">("html");
  const [report, setReport] = useState<{ text: string; html: string } | null>(null);

  // 渠道弹窗
  const [chOpen, setChOpen] = useState(false);
  const [editingCh, setEditingCh] = useState<any>(null); // null = 新增
  const [chName, setChName] = useState("");
  const [chType, setChType] = useState("");
  const [chConfig, setChConfig] = useState<Record<string, string>>({});
  const [chErrors, setChErrors] = useState<Record<string, string>>({});
  const [chSaving, setChSaving] = useState(false);
  const [chTesting, setChTesting] = useState(false);
  const [chTest, setChTest] = useState<TestResult | null>(null);
  // 列表行：测试中的渠道 id 与本次会话内的测试结果（服务端不记录测试历史）
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [rowTests, setRowTests] = useState<Record<string, TestResult>>({});

  // 服务端钳制后的规则回显到表单（如 eta 下限 1 小时），否则界面显示的是没生效的输入
  const syncRuleForm = (r: any) => {
    setEtaUnit(r?.etaUnit === "hours" ? "hours" : "days");
    setEtaVal(etaRuleDisplay(r));
    setRenotify(Number(r?.renotifyHours ?? 24));
    setErrThreshold(Number(r?.errorThreshold ?? 1));
    setErrRetry(Number(r?.errorRetrySec ?? 30));
    setChannelsFor(r?.channelsFor || {});
    setRuleErrors({});
  };

  const syncDrForm = (s: any) => {
    setDrEnabled(!!s?.dailyReport?.enabled);
    setDrTime(s?.dailyReport?.time || "09:00");
    setDrChannelIds(s?.dailyReport?.channelIds || []);
  };

  // 两个来源分开加载：任一失败只影响自己的区块
  const loadNotif = useCallback(async () => {
    setNotifLoading(true);
    setNotifErr(null);
    try {
      const n = await api("/api/notifications");
      setChannels(n.channels);
      setRules(n.rules);
      setChannelTypes(n.channelTypes);
      syncRuleForm(n.rules);
      setNotifLoaded(true);
    } catch (e) {
      setNotifErr(e);
    } finally {
      setNotifLoading(false);
    }
  }, []);

  const loadMeta = useCallback(async () => {
    setMetaLoading(true);
    setMetaErr(null);
    try {
      const m = await api("/api/meta");
      setSettings(m.settings);
      syncDrForm(m.settings);
      setMetaLoaded(true);
    } catch (e) {
      setMetaErr(e);
    } finally {
      setMetaLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotif();
    loadMeta();
  }, [loadNotif, loadMeta]);

  // 重新拉取渠道数据：同步渠道绑定（删除渠道时服务端会清理其中的死 id），但不动阈值输入
  const reloadChannels = async () => {
    const n = await api("/api/notifications");
    setChannels(n.channels);
    setRules(n.rules);
    setChannelTypes(n.channelTypes);
    setChannelsFor(n.rules?.channelsFor || {});
  };

  // ---- 渠道操作 ---------------------------------------------------------------

  const toggleChannel = async (c: any) => {
    const next = c.enabled === false;
    try {
      await api(`/api/notifications/channels/${c.id}`, { method: "PUT", body: { enabled: next } });
      setChannels((list) => list.map((x) => (x.id === c.id ? { ...x, enabled: next } : x)));
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const testChannel = async (c: any) => {
    setRowTesting(c.id);
    try {
      const r = await api("/api/notifications/test", { body: { channelId: c.id } });
      setRowTests((m) => ({ ...m, [c.id]: { ok: !!r.ok, text: r.ok ? `已发送到「${c.name}」` : r.error || "", at: Date.now() } }));
    } catch (e: any) {
      setRowTests((m) => ({ ...m, [c.id]: { ok: false, text: e.message, at: Date.now() } }));
    } finally {
      setRowTesting(null);
    }
  };

  const deleteChannel = (c: any) => {
    modal.confirm({
      title: `确定删除渠道「${c.name}」？`,
      content: "删除后不能恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api(`/api/notifications/channels/${c.id}`, { method: "DELETE" });
          await reloadChannels();
          message.success("已删除");
        } catch (e: any) {
          message.error(e.message);
        }
      },
    });
  };

  // ---- 渠道弹窗 ---------------------------------------------------------------

  // 打开弹窗：编辑时回填非密钥字段；密钥字段不回显（留空提交 = 保持原值）
  const openChModal = (channel: any, presetType?: string) => {
    const type = channel?.type || presetType || channelTypes[0]?.value || "";
    const t = channelTypes.find((x) => x.value === type);
    const cfg: Record<string, string> = {};
    for (const f of t?.fields || []) {
      const v = channel?.config?.[f.key] || "";
      cfg[f.key] = SECRET_KEYS.includes(f.key) ? "" : v;
    }
    setEditingCh(channel || null);
    setChType(type);
    setChName(channel?.name || "");
    setChConfig(cfg);
    setChErrors({});
    setChTest(null);
    setChOpen(true);
  };

  // 切换类型时清空动态字段；仅新增时可切
  const onChTypeChange = (type: string) => {
    setChType(type);
    setChConfig({});
    setChErrors({});
    setChTest(null);
  };

  const onChFieldChange = (key: string, value: string) => {
    setChConfig((cfg) => ({ ...cfg, [key]: value }));
    setChErrors((e) => (e[key] ? { ...e, [key]: "" } : e));
    setChTest(null); // 配置变了，上一次的测试结果不再代表当前配置
  };

  // 表单载荷：按当前类型的字段定义取值并 trim
  const chFormConfig = () => {
    const t = channelTypes.find((x) => x.value === chType);
    const config: Record<string, string> = {};
    for (const f of t?.fields || []) config[f.key] = (chConfig[f.key] || "").trim();
    return config;
  };

  const saveChannel = async () => {
    const t = channelTypes.find((x) => x.value === chType);
    const config = chFormConfig();
    // 必填校验：编辑时密钥不回显，已配置过的空值视为「保持不变」不算缺失
    const missing = (t?.fields || []).filter((f) => f.required && !config[f.key] && !editingCh?.config?.[f.key]);
    if (missing.length) {
      setChErrors(Object.fromEntries(missing.map((f) => [f.key, `请填写${shortLabel(f.label).trim()}`])));
      document.getElementById(`${uid}-ch-${missing[0].key}`)?.focus();
      return;
    }
    setChSaving(true);
    try {
      const payload = { name: chName.trim() || "未命名渠道", type: chType, config };
      if (editingCh) await api(`/api/notifications/channels/${editingCh.id}`, { method: "PUT", body: payload });
      else await api("/api/notifications/channels", { body: payload });
      setChOpen(false);
      await reloadChannels();
      message.success("已保存");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setChSaving(false);
    }
  };

  // 弹窗内测试：按 type+config 试发未保存的配置；
  // 编辑时密钥字段不回显，空值用已保存的原值补齐，否则测试必然失败
  const testChForm = async () => {
    const config = chFormConfig();
    if (editingCh?.config) {
      for (const k of Object.keys(config)) {
        if (!config[k] && editingCh.config[k]) config[k] = editingCh.config[k];
      }
    }
    setChTesting(true);
    setChTest(null);
    try {
      const r = await api("/api/notifications/test", { body: { type: chType, config } });
      setChTest({ ok: !!r.ok, text: r.ok ? "请在对应应用里确认是否收到" : r.error || "", at: Date.now() });
    } catch (e: any) {
      setChTest({ ok: false, text: e.message, at: Date.now() });
    } finally {
      setChTesting(false);
    }
  };

  // ---- 告警规则 ---------------------------------------------------------------

  // 开关即时落库；只更新 rules，不覆盖未保存的阈值输入
  // 关闭规则时，它的阈值框会被禁用：清空没保存的话恢复成已保存的值，并清掉报错，免得「未保存」卡住
  const toggleRule = async (key: string) => {
    const turningOff = !!rules[key];
    try {
      const r = await api("/api/notifications/rules", { method: "PUT", body: { [key]: !rules[key] } });
      setRules(r.rules);
      setRulesSavedAt(Date.now());
      if (turningOff && key === "onEta") {
        setEtaVal((v) => v ?? etaRuleDisplay(r.rules));
        setRuleErrors((e) => ({ ...e, eta: "" }));
      }
      if (turningOff && key === "onError") {
        setErrThreshold((v) => v ?? Number(r.rules?.errorThreshold ?? 1));
        setRuleErrors((e) => ({ ...e, errThreshold: "" }));
      }
    } catch (e: any) {
      message.error(e.message);
    }
  };

  // 每类告警的渠道绑定：选择即落库；失败时回滚为服务端状态
  const saveChannelsFor = async (key: string, ids: string[]) => {
    setChannelsFor((cf) => ({ ...cf, [key]: ids }));
    try {
      const r = await api("/api/notifications/rules", { method: "PUT", body: { channelsFor: { [key]: ids } } });
      setRules(r.rules);
      setChannelsFor(r.rules?.channelsFor || {});
      setRulesSavedAt(Date.now());
    } catch (e: any) {
      message.error(e.message);
      setChannelsFor(rules?.channelsFor || {});
    }
  };

  // 切换单位时把输入值换算过去（两个单位间必然是互换），换算后直接保存。
  // 数值没改过时只保存单位（saveRules 不提交 etaDays），显示值按已保存的天数重新换算，
  // 不用四舍五入后的值覆盖阈值（5 小时来回切仍是 5 小时）
  const onEtaUnitChange = (u: "days" | "hours") => {
    if (etaVal === etaRuleDisplay(rules)) {
      const shown = etaRuleDisplay({ ...rules, etaUnit: u });
      setEtaVal(shown);
      setEtaUnit(u);
      void saveRules({ etaUnit: u, etaVal: shown });
      return;
    }
    const v = Number(etaVal);
    const next = etaVal != null && Number.isFinite(v) && v > 0 ? (u === "hours" ? +(v * 24).toFixed(2) : +(v / 24).toFixed(2)) : etaVal;
    setEtaVal(next);
    setEtaUnit(u);
    void saveRules({ etaUnit: u, etaVal: next });
  };

  const rulesDirty =
    notifLoaded &&
    (etaUnit !== (rules?.etaUnit === "hours" ? "hours" : "days") ||
      etaVal !== etaRuleDisplay(rules) ||
      renotify !== Number(rules?.renotifyHours ?? 24) ||
      errThreshold !== Number(rules?.errorThreshold ?? 1) ||
      errRetry !== Number(rules?.errorRetrySec ?? 30));

  // over：刚改、还没进 state 的值（切换单位时）
  const saveRules = async (over: Partial<RuleForm> = {}) => {
    const f: RuleForm = { etaUnit, etaVal, renotify, errThreshold, errRetry, ...over };
    // 清空视为「未填写」而不是 0；被禁用（规则关闭）的空字段沿用已保存的值，不拦截保存
    const errs: Record<string, string> = {};
    if (f.etaVal == null && rules.onEta) errs.eta = "请填写耗尽预警阈值";
    if (f.errThreshold == null && rules.onError) errs.errThreshold = "请填写失败次数";
    if (f.renotify == null) errs.renotify = "请填写重复提醒间隔，0 表示只提醒一次";
    if (f.errRetry == null) errs.errRetry = "请填写重试间隔，0 表示关闭";
    setRuleErrors(errs);
    if (Object.keys(errs).length) return;
    setRulesSaving(true);
    try {
      // 只有用户改过阈值才提交 etaDays；否则由服务端保留原值，免得显示用的两位小数把阈值改掉
      const etaEdited = f.etaVal != null && f.etaVal !== etaRuleDisplay({ ...rules, etaUnit: f.etaUnit });
      const val = Number(f.etaVal);
      const r = await api("/api/notifications/rules", {
        method: "PUT",
        body: {
          ...(etaEdited ? { etaDays: f.etaUnit === "hours" ? val / 24 : val } : {}), // 内部统一按天
          etaUnit: f.etaUnit,
          renotifyHours: Number(f.renotify),
          errorThreshold: Number(f.errThreshold ?? rules.errorThreshold ?? 1),
          errorRetrySec: Number(f.errRetry),
        },
      });
      setRules(r.rules);
      // 回显服务端钳制后的值；保存途中又改了的输入保持用户正在输入的内容
      const keep = <T,>(sent: T, saved: T) => (cur: T) => (cur === sent ? saved : cur);
      setEtaUnit(keep(f.etaUnit, r.rules?.etaUnit === "hours" ? "hours" : "days"));
      setEtaVal(keep(f.etaVal, etaRuleDisplay(r.rules)));
      setRenotify(keep(f.renotify, Number(r.rules?.renotifyHours ?? 24)));
      setErrThreshold(keep(f.errThreshold, Number(r.rules?.errorThreshold ?? 1)));
      setErrRetry(keep(f.errRetry, Number(r.rules?.errorRetrySec ?? 30)));
      setRulesSavedAt(Date.now());
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRulesSaving(false);
    }
  };
  // 离开输入框或按回车时保存；没改动就不发请求。
  // 推迟一拍再读：输入框失焦时才把越界值钳到范围内，要等这次 onChange 渲染完拿到最新值
  const commitRef = useRef<() => void>(null);
  commitRef.current = () => {
    if (rulesDirty) void saveRules();
  };
  const commitRules = () => {
    setTimeout(() => commitRef.current?.(), 0);
  };

  // ---- 每日日报 ---------------------------------------------------------------

  const drSaved = settings?.dailyReport || {};
  const drDirty =
    metaLoaded &&
    (drEnabled !== !!drSaved.enabled || drTime !== (drSaved.time || "09:00") || !sameIds(drChannelIds, drSaved.channelIds || []));

  const saveDailyReport = async () => {
    setDrSaving(true);
    try {
      const r = await api("/api/settings", {
        method: "PUT",
        body: { dailyReport: { enabled: drEnabled, time: drTime || "09:00", channelIds: drChannelIds } },
      });
      setSettings(r.settings);
      syncDrForm(r.settings);
      message.success("日报设置已保存");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDrSaving(false);
    }
  };

  const previewReport = async () => {
    setPreviewing(true);
    try {
      const r = await api("/api/report/preview", { method: "POST", body: {} });
      setReport({ text: r.text, html: r.html });
      setReportTab("html");
      setReportOpen(true);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const sendReport = async () => {
    setSending(true);
    setSendResult(null);
    try {
      const r = await api("/api/report/send", { method: "POST", body: {} });
      const results: any[] = r.results || [];
      const ok = results.filter((x) => x.ok).length;
      setSendResult({
        ok: ok > 0,
        text: `日报已发送：${ok}/${results.length} 个渠道成功`,
        at: Date.now(),
        fails: results.filter((x) => !x.ok).map((x) => `${x.name || x.id}：${x.error || "发送失败"}`),
      });
    } catch (e: any) {
      setSendResult({ ok: false, text: e.message, at: Date.now(), fails: [] });
    } finally {
      setSending(false);
    }
  };

  // ---- 渲染 -------------------------------------------------------------------

  const curType = channelTypes.find((x) => x.value === chType);
  const typeLabel = (type: string) => channelTypes.find((x) => x.value === type)?.label || type;
  const channelOptions = channels.map((c: any) => ({
    value: c.id,
    label: c.enabled === false ? `${c.name}（已停用）` : c.name,
  }));

  const testCell = (c: any) => {
    const t = rowTests[c.id];
    if (!t) return <span className="jy-muted">未测试</span>;
    return (
      <span className="jy-notifications-test">
        <StatusText level={t.ok ? "good" : "crit"}>
          {t.ok ? "发送成功" : "发送失败"}
          <span className="jy-caption">{formatHhmm(t.at)}</span>
        </StatusText>
        {!t.ok && t.text && <span className="jy-caption">{t.text}</span>}
      </span>
    );
  };

  const rowActions = (c: any) => (
    <>
      <Button type="link" size="small" loading={rowTesting === c.id} onClick={() => testChannel(c)} aria-label={`向「${c.name}」发送测试消息`}>
        测试
      </Button>
      <Button type="link" size="small" onClick={() => openChModal(c)} aria-label={`编辑「${c.name}」`}>
        编辑
      </Button>
      <Button type="link" size="small" danger onClick={() => deleteChannel(c)} aria-label={`删除「${c.name}」`}>
        删除
      </Button>
    </>
  );

  const enabledToggle = (c: any) => (
    <span className="jy-notifications-toggle">
      <Switch size="small" checked={c.enabled !== false} onChange={() => toggleChannel(c)} aria-label={`启用渠道「${c.name}」`} />
      <span>{c.enabled !== false ? "已启用" : "已停用"}</span>
    </span>
  );

  const plate = (type: string) => (
    <span className="jy-notifications-type">
      <span className="jy-notifications-plate" aria-hidden="true">
        {CH_PLATE[type] || "?"}
      </span>
      {typeLabel(type)}
    </span>
  );

  // 规则行的附加条件：关闭规则时整体禁用
  const ruleCondition = (ruleKey: string) => {
    const off = !rules[ruleKey];
    if (ruleKey === "onLow")
      return (
        // 纯文字，不用 flex 容器，否则链接两侧会被 gap 撑开
        <p className="jy-notifications-note">
          阈值取全局低余额阈值（<Link className="jy-link" href="/settings">系统设置</Link>），单个上游可单独覆盖
        </p>
      );
    if (ruleKey === "onEta")
      return (
        <div className="jy-notifications-cond">
          <label htmlFor={`${uid}-eta`}>预计在</label>
          <Space.Compact>
            <InputNumber
              id={`${uid}-eta`}
              onBlur={commitRules}
              onPressEnter={commitRules}
              min={0}
              precision={2}
              value={etaVal}
              onChange={(v) => {
                setEtaVal(v as number | null);
                setRuleErrors((e) => ({ ...e, eta: "" }));
              }}
              disabled={off}
              status={ruleErrors.eta ? "error" : undefined}
              aria-invalid={ruleErrors.eta ? true : undefined}
              aria-describedby={ruleErrors.eta ? `${uid}-eta-err` : undefined}
            />
            <Select
              aria-label="耗尽预警阈值单位"
              value={etaUnit}
              onChange={onEtaUnitChange}
              disabled={off}
              options={[
                { value: "days", label: "天" },
                { value: "hours", label: "小时" },
              ]}
            />
          </Space.Compact>
          <span>内用完时通知</span>
          {ruleErrors.eta && (
            <span className="jy-err" id={`${uid}-eta-err`} role="alert">
              <Sym kind="crit" />
              {ruleErrors.eta}
            </span>
          )}
        </div>
      );
    if (ruleKey === "onError")
      return (
        <div className="jy-notifications-cond">
          <label htmlFor={`${uid}-errThreshold`}>连续失败达到</label>
          <InputNumber
            id={`${uid}-errThreshold`}
            onBlur={commitRules}
            onPressEnter={commitRules}
            min={1}
            precision={0}
            suffix="次"
            value={errThreshold}
            onChange={(v) => {
              setErrThreshold(v as number | null);
              setRuleErrors((e) => ({ ...e, errThreshold: "" }));
            }}
            disabled={off}
            status={ruleErrors.errThreshold ? "error" : undefined}
            aria-invalid={ruleErrors.errThreshold ? true : undefined}
            aria-describedby={ruleErrors.errThreshold ? `${uid}-errThreshold-desc ${uid}-errThreshold-err` : `${uid}-errThreshold-desc`}
          />
          <span id={`${uid}-errThreshold-desc`}>才通知（1 = 首次失败即通知）</span>
          {ruleErrors.errThreshold && (
            <span className="jy-err" id={`${uid}-errThreshold-err`} role="alert">
              <Sym kind="crit" />
              {ruleErrors.errThreshold}
            </span>
          )}
        </div>
      );
    return null;
  };

  // 首次加载：与真实布局同形的骨架
  if (!notifLoaded && !notifErr && notifLoading) {
    return (
      <div className="jy-page">
        <PanelSkeleton title="告警规则" lines={6} />
        <PanelSkeleton title="通知渠道" lines={3} />
        <PanelSkeleton title="每日日报" lines={3} />
      </div>
    );
  }

  const notifFailed = !notifLoaded && !!notifErr;
  // 有告警或日报要发，却没有可用的渠道：消息会被静默丢掉，放在页首提醒
  const wantsDelivery = RULES.some((r) => rules[r.key]) || !!settings?.dailyReport?.enabled;
  const noDelivery = notifLoaded && wantsDelivery && !channels.some((c) => c.enabled !== false);
  const showChannels = () => {
    document.querySelector(".jy-notifications-channels")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="jy-page">
      {noDelivery ? (
        <div className="jy-banner jy-banner--crit" role="alert">
          <Sym kind="crit" />
          <div className="jy-notifications-banner-body">
            <b>{channels.length ? "通知渠道都已停用，告警不会送达" : "还没有通知渠道，告警不会送达"}</b>
            <p className="jy-caption">
              {channels.length ? "至少启用一个渠道，已开启的告警和日报才会发出。" : "添加至少一个渠道，已开启的告警和日报才会发出。"}
            </p>
          </div>
          {channels.length ? (
            <Button size="small" onClick={showChannels}>
              查看通知渠道
            </Button>
          ) : (
            <Button size="small" type="primary" icon={<Icon name="plus" />} onClick={() => openChModal(null)}>
              添加渠道
            </Button>
          )}
        </div>
      ) : null}
      {/* 告警规则 */}
      {notifFailed ? (
        <Panel title="告警规则">
          <ErrorState title="告警规则和通知渠道暂时无法加载" error={notifErr} onRetry={loadNotif} />
        </Panel>
      ) : (
        <Panel
          title="告警规则"
          badge={<SaveState saving={rulesSaving} dirty={rulesDirty} at={rulesSavedAt} />}
          caption="改动即时生效；每类告警可单独选择通知渠道，不选则发到所有启用的渠道"
          body="flush"
        >
          <div className="jy-table-wrap">
            <table className="jy-data jy-notifications-rules">
              <thead>
                <tr>
                  <th className="col-switch">开关</th>
                  <th>告警与触发条件</th>
                  <th className="col-to">通知到</th>
                </tr>
              </thead>
              <tbody>
                {RULES.map((rule) => {
                  const on = !!rules[rule.key];
                  const titleId = `${uid}-rule-${rule.ev}`;
                  return (
                    <tr key={rule.key} className={on ? undefined : "is-off"}>
                      <td className="col-switch">
                        <Switch
                          checked={on}
                          checkedChildren="开"
                          unCheckedChildren="关"
                          onChange={() => toggleRule(rule.key)}
                          aria-labelledby={titleId}
                        />
                      </td>
                      <td>
                        <span className="jy-notifications-rule-title" id={titleId}>
                          {rule.title}
                        </span>
                        <span className="jy-notifications-rule-desc">{rule.desc}</span>
                        {ruleCondition(rule.key)}
                      </td>
                      <td className="col-to">
                        <Select
                          mode="multiple"
                          allowClear
                          aria-label={`「${rule.title}」通知到的渠道`}
                          placeholder={channels.length ? "全部启用渠道" : "还没有通知渠道"}
                          maxTagCount="responsive"
                          optionFilterProp="label"
                          value={channelsFor[rule.ev] || []}
                          onChange={(ids) => saveChannelsFor(rule.ev, ids as string[])}
                          options={channelOptions}
                          disabled={!channels.length || !on}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="jy-notifications-pad">
            <fieldset className="jy-fs">
              <legend>提醒节奏</legend>
              <p className="fs-desc">对所有已开启的告警生效。</p>
              <div className="jy-two">
                <div className="jy-field">
                  <label htmlFor={`${uid}-renotify`}>重复提醒间隔</label>
                  <InputNumber
                    id={`${uid}-renotify`}
                    onBlur={commitRules}
                    onPressEnter={commitRules}
                    min={0}
                    suffix="小时"
                    value={renotify}
                    onChange={(v) => {
                      setRenotify(v as number | null);
                      setRuleErrors((e) => ({ ...e, renotify: "" }));
                    }}
                    status={ruleErrors.renotify ? "error" : undefined}
                    aria-invalid={ruleErrors.renotify ? true : undefined}
                    aria-describedby={`${uid}-renotify-desc`}
                  />
                  {ruleErrors.renotify ? (
                    <span key="err" className="jy-err" id={`${uid}-renotify-desc`} role="alert">
                      <Sym kind="crit" />
                      {ruleErrors.renotify}
                    </span>
                  ) : (
                    <span key="desc" className="jy-caption" id={`${uid}-renotify-desc`}>
                      同一异常持续存在时，每隔 N 小时再次提醒（0 = 只提醒一次）
                    </span>
                  )}
                </div>
                <div className="jy-field">
                  <label htmlFor={`${uid}-errRetry`}>失败快速重试</label>
                  <InputNumber
                    id={`${uid}-errRetry`}
                    onBlur={commitRules}
                    onPressEnter={commitRules}
                    min={0}
                    precision={0}
                    suffix="秒"
                    value={errRetry}
                    onChange={(v) => {
                      setErrRetry(v as number | null);
                      setRuleErrors((e) => ({ ...e, errRetry: "" }));
                    }}
                    status={ruleErrors.errRetry ? "error" : undefined}
                    aria-invalid={ruleErrors.errRetry ? true : undefined}
                    aria-describedby={`${uid}-errRetry-desc`}
                  />
                  {ruleErrors.errRetry ? (
                    <span key="err" className="jy-err" id={`${uid}-errRetry-desc`} role="alert">
                      <Sym kind="crit" />
                      {ruleErrors.errRetry}
                    </span>
                  ) : (
                    <span key="desc" className="jy-caption" id={`${uid}-errRetry-desc`}>
                      查询失败后隔 N 秒立即重试一次以尽快确认，不必等下次轮询（0 = 关闭）
                    </span>
                  )}
                </div>
              </div>
            </fieldset>
          </div>
        </Panel>
      )}

      {/* 通知渠道 */}
      {notifFailed ? (
        <Panel title="通知渠道">
          <ErrorState title="通知渠道暂时无法加载" error={notifErr} onRetry={loadNotif} />
        </Panel>
      ) : (
        <Panel
          title="通知渠道"
          className="jy-notifications-channels"
          badge={<CountBadge count={channels.length} muted />}
          caption="告警和日报通过这些渠道推送"
          extra={
            channels.length ? (
              <Button icon={<Icon name="plus" />} onClick={() => openChModal(null)}>
                添加渠道
              </Button>
            ) : null
          }
          body={channels.length ? "flush" : true}
        >
          {channels.length ? (
            <>
              <div className="jy-table-wrap has-mobile">
                <table className="jy-data">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>名称</th>
                      <th>状态</th>
                      <th>本次测试</th>
                      <th className="r">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((c: any) => (
                      <tr key={c.id}>
                        <td>{plate(c.type)}</td>
                        <td className="jy-notifications-name">{c.name}</td>
                        <td>{enabledToggle(c)}</td>
                        <td aria-live="polite">{testCell(c)}</td>
                        <td className="r">
                          <div className="jy-row-actions">{rowActions(c)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="jy-m-list" aria-label="通知渠道">
                {channels.map((c: any) => (
                  <li key={c.id}>
                    <span className="m-top">{c.name}</span>
                    {enabledToggle(c)}
                    <div className="m-sub">
                      {plate(c.type)}
                      <span aria-live="polite">{testCell(c)}</span>
                    </div>
                    <div className="m-actions">{rowActions(c)}</div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="jy-empty-inline">
              <div>
                <b className="jy-notifications-empty-title">还没有通知渠道</b>
                <p className="jy-notifications-empty-desc">添加至少一个渠道后，告警和日报才能送达。可选的渠道类型：</p>
              </div>
              <ul className="jy-notifications-types">
                {channelTypes.map((t) => (
                  <li key={t.value}>
                    <Button onClick={() => openChModal(null, t.value)} aria-label={`添加${t.label}渠道`}>
                      <span className="jy-notifications-plate" aria-hidden="true">
                        {CH_PLATE[t.value] || "?"}
                      </span>
                      {t.label}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button type="primary" icon={<Icon name="plus" />} onClick={() => openChModal(null)}>
                添加渠道
              </Button>
            </div>
          )}
        </Panel>
      )}

      {/* 每日日报 */}
      {!metaLoaded && metaLoading ? (
        <PanelSkeleton title="每日日报" lines={3} />
      ) : !metaLoaded ? (
        <Panel title="每日日报">
          <ErrorState title="日报设置暂时无法加载" error={metaErr} onRetry={loadMeta} />
        </Panel>
      ) : (
        <Panel
          title="每日日报"
          badge={<Dirty show={drDirty} />}
          caption="定时汇总昨日自营业务经营情况并推送（时间按服务器时区）"
        >
          <Form layout="vertical" requiredMark={false} component="div" className="jy-form jy-notifications-dr">
            <Form.Item label="启用日报" htmlFor={`${uid}-dr-enabled`} extra="每天在设定时间生成并发送昨日报告">
              <Switch
                id={`${uid}-dr-enabled`}
                checked={drEnabled}
                checkedChildren="开"
                unCheckedChildren="关"
                onChange={setDrEnabled}
              />
            </Form.Item>
            <div className="jy-two">
              <Form.Item label="发送时间" htmlFor={`${uid}-dr-time`} extra="服务器时区的每日时刻">
                <TimePicker
                  id={`${uid}-dr-time`}
                  format="HH:mm"
                  allowClear={false}
                  disabled={!drEnabled}
                  value={drTime ? dayjs(drTime, "HH:mm") : null}
                  onChange={(d) => setDrTime(d ? d.format("HH:mm") : "")}
                />
              </Form.Item>
              <Form.Item
                label={<span id={`${uid}-dr-ch`}>发送渠道</span>}
                extra="不勾选 = 所有启用的渠道；日报较长，建议勾选邮件渠道"
              >
                {channels.length ? (
                  <div role="group" aria-labelledby={`${uid}-dr-ch`}>
                    <Checkbox.Group
                      className="jy-notifications-checks"
                      value={drChannelIds}
                      disabled={!drEnabled}
                      onChange={(ids) => setDrChannelIds(ids as string[])}
                      options={channels.map((c) => ({ value: c.id, label: c.name }))}
                    />
                  </div>
                ) : (
                  <span className="jy-muted">{notifFailed ? "通知渠道未能加载" : "先添加通知渠道"}</span>
                )}
              </Form.Item>
            </div>
          </Form>
          <div className="jy-notifications-actions">
            <Button type="primary" loading={drSaving} onClick={saveDailyReport}>
              保存日报设置
            </Button>
            <Button loading={previewing} onClick={previewReport}>
              预览
            </Button>
            <Button loading={sending} onClick={sendReport}>
              立即发送
            </Button>
            <span className="jy-caption">
              {drDirty
                ? "「立即发送」按已保存的渠道设置发送"
                : drSaved.lastSent
                  ? `上次定时发送：${drSaved.lastSent}`
                  : "预览按当前数据生成；立即发送不影响当天的定时发送"}
            </span>
          </div>
          <div aria-live="polite">
            {sendResult && (
              <div className={`jy-test-result${sendResult.ok ? "" : " jy-test-result--bad"}`}>
                <Sym kind={sendResult.ok ? "good" : "crit"} />
                <b>{sendResult.text}</b>
                <span>{formatHhmm(sendResult.at)} 发送</span>
                {sendResult.fails.map((f) => (
                  <span key={f}>{f}</span>
                ))}
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* 通知渠道弹窗 */}
      <Modal
        open={chOpen}
        title={editingCh ? "编辑通知渠道" : "添加通知渠道"}
        onCancel={() => setChOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setChOpen(false)}>
            取消
          </Button>,
          <Button key="save" type="primary" loading={chSaving} onClick={saveChannel}>
            {editingCh ? "保存修改" : "添加渠道"}
          </Button>,
        ]}
        destroyOnHidden
      >
        <p className="jy-caption jy-notifications-modal-intro">默认接收所有告警；可在「告警规则」中按告警类型指定渠道。</p>
        <Form layout="vertical" onFinish={saveChannel} autoComplete="off" className="jy-form">
          <div className="jy-two">
            <Form.Item label="名称" htmlFor={`${uid}-ch-name`}>
              <Input
                id={`${uid}-ch-name`}
                autoComplete="off"
                placeholder="例如：运维 Telegram 群"
                value={chName}
                onChange={(e) => setChName(e.target.value)}
              />
            </Form.Item>
            <Form.Item
              label="渠道类型"
              htmlFor={`${uid}-ch-type`}
              extra={editingCh ? "已创建的渠道不能更改类型" : undefined}
            >
              <Select
                id={`${uid}-ch-type`}
                value={chType || undefined}
                onChange={onChTypeChange}
                disabled={!!editingCh}
                options={channelTypes.map((t) => ({ value: t.value, label: t.label }))}
              />
            </Form.Item>
          </div>
          {(curType?.fields || []).map((f) => {
            const id = `${uid}-ch-${f.key}`;
            const secret = SECRET_KEYS.includes(f.key);
            const saved = secret && !!editingCh?.config?.[f.key];
            const val = chConfig[f.key] || "";
            const help = saved
              ? val
                ? `保存后替换原来的${shortLabel(f.label)}`
                : `留空则继续使用已保存的${shortLabel(f.label)}`
              : undefined;
            return (
              <Form.Item
                key={f.key}
                label={f.label}
                htmlFor={id}
                required={!!f.required}
                validateStatus={chErrors[f.key] ? "error" : undefined}
                help={chErrors[f.key] || undefined}
                extra={help}
              >
                {secret ? (
                  <Input.Password
                    id={id}
                    autoComplete="new-password"
                    placeholder={saved ? "已保存" : undefined}
                    value={val}
                    onChange={(e) => onChFieldChange(f.key, e.target.value)}
                  />
                ) : (
                  <Input id={id} autoComplete="off" value={val} onChange={(e) => onChFieldChange(f.key, e.target.value)} />
                )}
              </Form.Item>
            );
          })}
        </Form>
        <div className="jy-test-row">
          <Button icon={<Icon name="test" />} loading={chTesting} onClick={testChForm}>
            发送测试
          </Button>
          <span className="jy-caption">用当前填写的配置发一条测试消息，不会保存</span>
        </div>
        <div aria-live="polite">{chTest && <ResultBox r={chTest} okTitle="测试消息已发送" />}</div>
      </Modal>

      {/* 日报预览弹窗：HTML / 纯文本两个标签页 */}
      <Modal
        open={reportOpen}
        title="日报预览"
        width={720}
        onCancel={() => setReportOpen(false)}
        footer={<Button onClick={() => setReportOpen(false)}>关闭</Button>}
      >
        <p className="jy-caption jy-notifications-modal-intro">按当前数据生成的昨日报告（实际发送时按设定时间的数据）</p>
        <Tabs
          idPrefix={`${uid}-report`}
          label="日报格式"
          active={reportTab}
          onChange={(k) => setReportTab(k as "html" | "text")}
          tabs={[
            { key: "html", label: "HTML（邮件效果）" },
            { key: "text", label: "纯文本（IM 渠道）" },
          ]}
        />
        <TabPanel idPrefix={`${uid}-report`} tabKey="html" active={reportTab === "html"}>
          <iframe
            className="jy-notifications-frame"
            title="日报 HTML 预览"
            sandbox=""
            srcDoc={report?.html || "<p>无 HTML 版本</p>"}
          />
        </TabPanel>
        <TabPanel idPrefix={`${uid}-report`} tabKey="text" active={reportTab === "text"}>
          <pre className="jy-notifications-text">{report?.text}</pre>
        </TabPanel>
      </Modal>
    </div>
  );
}
