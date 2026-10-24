"use client";
// 告警中心：提醒规则 / 通知方式 / 日报。
// 只在挂载时加载一次、不注册顶栏刷新：自动重载会冲掉正在输入的数字（沿用 v1 的取舍）。
// 提醒规则改了马上保存：开关、通知方式的选择改动即保存，数字输入在离开输入框或按回车时保存。
// 只在本页出现的话都在同目录的 copy.ts 里；规则名里的余额四档、漏填提示、报错的说法从共用的地方取。
// 通知方式没发出去：按接口给的码说那一句（design/ui-copy-spec.md §8.2 通知方式那张表），原文进「查看详细原因」；
// 控制台自己的接口出错按 consoleErrorText 说，原文也进「查看详细原因」。
import "../../styles/pages/notifications.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { commitOnLeave, useAutoSave, useSaveQueue } from "../../components/use-auto-save";
import Link from "next/link";
import { App, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Switch, TimePicker } from "antd";
import dayjs from "dayjs";
import { ALERT_RULES } from "../../../lib/alert-rules";
import { api } from "../../../lib/client";
import { DEFAULT_BUSINESS_TIME_ZONE } from "../../../lib/business-time";
import { SECRET_FIELD_TEXT } from "../../../lib/channel-onboarding";
import { consoleErrorText, consoleFailureText, describeError, failureSentence, requiredText } from "../../../lib/error-copy";
import { BALANCE_STATE_TEXT, formatDayKey, formatZonedTime } from "../../../lib/format";
import { workflowAction } from "../../../lib/workflow-actions";
import { CountBadge, Panel } from "../../components/panel";
import { ErrorState, PanelSkeleton, SaveState } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import { Icon, Sym } from "../../components/icons";
import { StatusText } from "../../components/status";
import { TabPanel, Tabs } from "../../components/seg";
import { COPY } from "./copy";

// secret：密钥，接口不回传、编辑时不回显，留空表示不变；名单在服务端（lib/notify.js CHANNEL_TYPES），这里不另写
type ChannelField = { key: string; label: string; required?: boolean; secret?: boolean };
type ChannelType = { value: string; label: string; fields: ChannelField[] };
// raw：接口本身出错时的原文，只进「查看详细原因」
type TestResult = { ok: boolean; text: string; at: number; raw?: unknown };

// 接口本身出错（不是通知方式发送失败）：按控制台自己的说法，原文留着给「查看详细原因」
const apiFailure = (e: unknown, at = Date.now()): TestResult => ({ ok: false, text: consoleErrorText(e), at, raw: noteOf(e).raw });

// 通知方式发没发出去（测试接口、日报发送结果里的一项 { ok, error, code }）：没发出去时按码说那一句，原文进「查看详细原因」
const deliveryFailure = (r: any) => {
  const note = noteOf(r);
  return { text: note.text, raw: note.raw };
};
const deliveryResult = (r: any, okText: string, at = Date.now()): TestResult =>
  r?.ok ? { ok: true, text: okText, at } : { ok: false, at, ...deliveryFailure(r) };

// 日报区块里那条结果：立即发送的结果，或者预览、发送前就出错。fails 是没发出去的通知方式，各带一个「查看详细原因」；
// setup 表示还没设置自营站点，带「去设置」
type ReportFail = { id: string; label: string; text: string; raw?: unknown };
type ReportResult = TestResult & { kind: "send" | "preview"; fails: ReportFail[]; setup?: boolean };
const SETUP = workflowAction("setup_own_station");

// 通知方式的图标（类型名取接口返回的 channelTypes，这里只有图标上的缩写）
const CH_PLATE: Record<string, string> = {
  telegram: "TG", dingtalk: "DT", wecom: "WC", feishu: "FS", bark: "BK",
  ntfy: "NF", serverchan: "SC", resend: "RS", smtp: "SM", webhook: "WH",
};


// 提醒规则：事件键（选通知方式用）+ 开关键；名字里的余额四档和上游列表、运营总览同一份（BALANCE_STATE_TEXT）
// 提醒规则只有一张表（lib/alert-rules.js）：规则名取余额档位的叫法，「恢复正常」和说明在 copy.ts
const RULES = ALERT_RULES.map((rule) => ({
  ev: rule.ev,
  key: rule.key,
  title: rule.text ? BALANCE_STATE_TEXT[rule.text as keyof typeof BALANCE_STATE_TEXT] : COPY.recover,
  // 「余额偏低」那一行下面就是「余额低于 [5] 时提醒」，不再写一遍说明
  desc: (COPY.ruleDesc as Record<string, string>)[rule.ev] || "",
}));

// 提醒天数内部按天存储；界面按所选单位展示
function etaRuleDisplay(r: any): number {
  const days = Number(r?.etaDays ?? 3);
  return r?.etaUnit === "hours" ? +(days * 24).toFixed(2) : +days.toFixed(2);
}

// 规则里的数字一组存（PUT /api/notifications/rules）；开关和通知方式的选择另外即时存
const ruleFormOf = (r: any): RuleForm => ({
  etaUnit: r?.etaUnit === "hours" ? "hours" : "days",
  etaVal: etaRuleDisplay(r),
  renotify: Number(r?.renotifyHours ?? 24),
  errThreshold: Number(r?.errorThreshold ?? 1),
  errRetry: Number(r?.errorRetrySec ?? 30),
});
type DrForm = { enabled: boolean; time: string; channelIds: string[] };
const drFormOf = (s: any): DrForm => ({ enabled: !!s?.dailyReport?.enabled, time: s?.dailyReport?.time || "09:00", channelIds: s?.dailyReport?.channelIds || [] });

// 字段说明里用的简称：去掉「（可选…）」之类的括注；英文开头时补一个空格
function shortLabel(label: string) {
  const s = label.replace(/（.*?）/g, "").trim();
  return /^[A-Za-z]/.test(s) ? ` ${s}` : s;
}



type RuleForm = {
  etaUnit: "days" | "hours";
  etaVal: number | null;
  renotify: number | null;
  errThreshold: number | null;
  errRetry: number | null;
};

// 测试发送结果：图标 + 文字 + 底色，不单靠颜色。发出去了写「14:30 发送」，没发出去只写时刻
function ResultBox({ r, okTitle, tz }: { r: TestResult; okTitle: string; tz: string }) {
  const time = formatZonedTime(r.at, tz);
  return (
    <div className={`jy-test-result${r.ok ? "" : " jy-test-result--bad"}`}>
      <Sym kind={r.ok ? "good" : "crit"} />
      <b>{r.ok ? okTitle : COPY.sendFailed}</b>
      <span>
        {r.text}
        {r.text ? "；" : ""}
        {r.ok ? COPY.sentAt(time) : time}
      </span>
      <ErrorDetail raw={r.raw} />
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
  // 业务时区（/api/meta 的 tz）：「已保存 14:30」「上次定时发送」按它写
  const [tz, setTz] = useState(DEFAULT_BUSINESS_TIME_ZONE);

  // 改了马上保存（ui-copy-spec §8.3）：三组（规则里的数字、余额提醒线、日报）和开关、通知方式的选择排在同一个队列里
  const queue = useSaveQueue();
  const rulesRef = useRef<any>({});
  rulesRef.current = rules;
  const [toggleSavedAt, setToggleSavedAt] = useState(0);
  const ruleForm = useAutoSave<RuleForm, Record<string, string>>(ruleFormOf({}), {
    queue,
    // 清空视为「未填写」而不是 0；「连续读不到」被禁用（规则关闭）时不拦
    validate: (f) => {
      const errs: Record<string, string> = {};
      if (f.etaVal == null) errs.eta = requiredText(COPY.etaLabel);
      if (f.errThreshold == null && rulesRef.current.onError) errs.errThreshold = requiredText(COPY.errLabel);
      if (f.renotify == null) errs.renotify = `${requiredText(COPY.renotify)}${COPY.renotifyZero}`;
      if (f.errRetry == null) errs.errRetry = `${requiredText(COPY.retry)}${COPY.retryZero}`;
      return Object.keys(errs).length ? errs : null;
    },
    save: async (f) => {
      // 只有用户改过提醒天数才提交 etaDays；否则由服务端保留原值，免得显示用的两位小数把它改掉
      const etaEdited = f.etaVal != null && f.etaVal !== etaRuleDisplay({ ...rulesRef.current, etaUnit: f.etaUnit });
      const val = Number(f.etaVal);
      const r = await api("/api/notifications/rules", {
        method: "PUT",
        body: {
          ...(etaEdited ? { etaDays: f.etaUnit === "hours" ? val / 24 : val } : {}), // 内部统一按天
          etaUnit: f.etaUnit,
          renotifyHours: Number(f.renotify),
          errorThreshold: Number(f.errThreshold ?? rulesRef.current.errorThreshold ?? 1),
          errorRetrySec: Number(f.errRetry),
        },
      });
      setRules(r.rules);
      return ruleFormOf(r.rules);
    },
  });
  // 全局余额提醒线：放在「余额偏低」那一行，存在 /api/settings（没有通知方式时放在空状态下面那一小块）
  const low = useAutoSave<number | null>(null, {
    queue,
    validate: (v) => (v == null ? `${requiredText(COPY.lowLabel)}${COPY.lowZero}` : v < 0 ? COPY.lowNegative : null),
    save: async (v) => {
      const r = await api("/api/settings", { method: "PUT", body: { lowBalanceUsd: Number(v) } });
      setSettings(r.settings);
      dr.sync(drFormOf(r.settings));
      return r.settings?.lowBalanceUsd ?? v;
    },
  });
  // 日报：开关、发送时间、发到哪里改了就存
  const dr = useAutoSave<DrForm>(drFormOf({}), {
    queue,
    save: async (v) => {
      const r = await api("/api/settings", { method: "PUT", body: { dailyReport: v } });
      setSettings(r.settings);
      low.sync(r.settings?.lowBalanceUsd ?? null);
      return drFormOf(r.settings);
    },
  });
  const [channelsFor, setChannelsFor] = useState<Record<string, string[]>>({});

  // 日报的预览、立即发送
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<ReportResult | null>(null);
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

  // 两个来源分开加载：任一失败只影响自己的区块
  const loadNotif = useCallback(async () => {
    setNotifLoading(true);
    setNotifErr(null);
    try {
      const n = await api("/api/notifications");
      setChannels(n.channels);
      setRules(n.rules);
      setChannelTypes(n.channelTypes);
      ruleForm.sync(ruleFormOf(n.rules));
      setChannelsFor(n.rules?.channelsFor || {});
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
      if (m.tz) setTz(m.tz);
      setSettings(m.settings);
      dr.sync(drFormOf(m.settings));
      low.sync(m.settings?.lowBalanceUsd ?? null);
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
    } catch (e) {
      message.error(consoleFailureText(COPY.saveFailed, e));
    }
  };

  const testChannel = async (c: any) => {
    setRowTesting(c.id);
    try {
      const r = await api("/api/notifications/test", { body: { channelId: c.id } });
      setRowTests((m) => ({ ...m, [c.id]: deliveryResult(r, COPY.sentTo(c.name)) }));
    } catch (e) {
      setRowTests((m) => ({ ...m, [c.id]: apiFailure(e) }));
    } finally {
      setRowTesting(null);
    }
  };

  const deleteChannel = (c: any) => {
    modal.confirm({
      title: COPY.removeTitle(c.name),
      content: COPY.removeBody,
      okText: COPY.remove,
      okButtonProps: { danger: true },
      cancelText: COPY.cancel,
      onOk: async () => {
        try {
          await api(`/api/notifications/channels/${c.id}`, { method: "DELETE" });
          await reloadChannels();
          message.success(COPY.deleted);
        } catch (e) {
          message.error(consoleFailureText(COPY.deleteFailed, e));
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
      // 接口不回传密钥（只给 hasSecret），密钥框一律从空开始
      cfg[f.key] = f.secret ? "" : channel?.config?.[f.key] || "";
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
    const missing = (t?.fields || []).filter((f) => f.required && !config[f.key] && !(f.secret && editingCh?.hasSecret?.[f.key]));
    if (missing.length) {
      setChErrors(Object.fromEntries(missing.map((f) => [f.key, requiredText(shortLabel(f.label).trim())])));
      document.getElementById(`${uid}-ch-${missing[0].key}`)?.focus();
      return;
    }
    setChSaving(true);
    try {
      const payload = { name: chName.trim() || COPY.unnamed, type: chType, config };
      if (editingCh) await api(`/api/notifications/channels/${editingCh.id}`, { method: "PUT", body: payload });
      else await api("/api/notifications/channels", { body: payload });
      setChOpen(false);
      await reloadChannels();
      message.success(editingCh ? COPY.saved : COPY.added);
    } catch (e) {
      message.error(consoleFailureText(COPY.saveFailed, e));
    } finally {
      setChSaving(false);
    }
  };

  // 弹窗内测试：按这次填的内容试发，不保存；
  // 编辑时留空的密钥由服务端用已保存的补齐（换了地址的站点就不补，会报「换了地址…请重新填」）
  const testChForm = async () => {
    const config = chFormConfig();
    setChTesting(true);
    setChTest(null);
    try {
      const r = await api("/api/notifications/test", { body: { channelId: editingCh?.id, type: chType, name: chName.trim(), config } });
      setChTest(deliveryResult(r, COPY.checkInbox));
    } catch (e) {
      setChTest(apiFailure(e));
    } finally {
      setChTesting(false);
    }
  };

  // ---- 提醒规则 ---------------------------------------------------------------

  // 开关即时落库（排在同一个队列里）；只更新 rules 和已保存的数字，不覆盖没保存的数字输入
  const toggleRule = (key: string) => queue.run(async () => {
    try {
      const r = await api("/api/notifications/rules", { method: "PUT", body: { [key]: !rulesRef.current[key] } });
      setRules(r.rules);
      ruleForm.sync(ruleFormOf(r.rules));
      setToggleSavedAt(Date.now());
    } catch (e) {
      message.error(consoleFailureText(COPY.saveFailed, e));
    }
  });

  // 每种提醒发到哪些通知方式：选择即落库；失败时回滚为服务端状态
  const saveChannelsFor = (key: string, ids: string[]) => {
    setChannelsFor((cf) => ({ ...cf, [key]: ids }));
    return queue.run(async () => {
      try {
        const r = await api("/api/notifications/rules", { method: "PUT", body: { channelsFor: { [key]: ids } } });
        setRules(r.rules);
        setChannelsFor(r.rules?.channelsFor || {});
        setToggleSavedAt(Date.now());
      } catch (e) {
        message.error(consoleFailureText(COPY.saveFailed, e));
        setChannelsFor(rulesRef.current?.channelsFor || {});
      }
    });
  };

  // 切换单位时把输入值换算过去（两个单位间必然是互换），换算后直接保存。
  // 数值没改过时只保存单位（不提交 etaDays），显示值按已保存的天数重新换算，
  // 不用四舍五入后的值覆盖阈值（5 小时来回切仍是 5 小时）
  const onEtaUnitChange = (u: "days" | "hours") => {
    const f = ruleForm.value;
    let etaVal = f.etaVal;
    if (f.etaVal === etaRuleDisplay(rules)) etaVal = etaRuleDisplay({ ...rules, etaUnit: u });
    else {
      const v = Number(f.etaVal);
      if (f.etaVal != null && Number.isFinite(v) && v > 0) etaVal = u === "hours" ? +(v * 24).toFixed(2) : +(v / 24).toFixed(2);
    }
    const next = { ...f, etaUnit: u, etaVal };
    ruleForm.setValue(next);
    void ruleForm.commit(next);
  };
  const setRuleField = <K extends keyof RuleForm>(key: K, v: RuleForm[K]) => {
    ruleForm.setValue((f) => ({ ...f, [key]: v }));
    ruleForm.clearInvalid();
  };
  const ruleErrors: Record<string, string> = { ...(ruleForm.invalid || {}), ...(low.invalid ? { low: low.invalid } : {}) };
  const leaveRules = commitOnLeave(ruleForm.commit);
  const leaveLow = commitOnLeave(low.commit);
  const rulesSavedAt = Math.max(ruleForm.savedAt, low.savedAt, toggleSavedAt);

  // ---- 日报 -------------------------------------------------------------------

  const drSaved = settings?.dailyReport || {};

  // 日报的开关、发送时间、发到哪里改了就存（ui-copy-spec §8.3）
  const setDr = (over: Partial<DrForm>) => {
    const next = { ...dr.value, ...over };
    dr.setValue(next);
    void dr.commit(next);
  };

  // 预览、立即发送之前就出错：还没设置自营站点时直接说 §8.1 那句、带「去设置」，不再拼「读不到日报预览：」；
  // 其余按控制台自己的说法拼在 what 后面。都显示在日报区块里，原文进「查看详细原因」
  const reportFailure = (kind: ReportResult["kind"], what: string, e: unknown): ReportResult => {
    const failure = apiFailure(e);
    if (describeError(e).category === "unset") return { ...failure, kind, text: describeError(e).text, fails: [], setup: true };
    return { ...failure, kind, text: failureSentence(what, failure.text), fails: [] };
  };

  const previewReport = async () => {
    setPreviewing(true);
    // 上次预览没成的那条换掉；立即发送的结果留着
    setSendResult((r) => (r?.kind === "preview" ? null : r));
    try {
      const r = await api("/api/report/preview", { method: "POST", body: {} });
      setReport({ text: r.text, html: r.html });
      setReportTab("html");
      setReportOpen(true);
    } catch (e) {
      setSendResult(reportFailure("preview", COPY.previewFailed, e));
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
        kind: "send",
        ok: ok > 0,
        text: ok > 0 ? COPY.reportSent(ok, results.length) : COPY.reportNotSent,
        at: Date.now(),
        fails: results.filter((x) => !x.ok).map((x) => ({ id: String(x.id), label: x.name || COPY.unnamed, ...deliveryFailure(x) })),
      });
    } catch (e) {
      // 发之前就出错（没有能发日报的通知方式、还没设置自营站点、读不到自营站点）
      setSendResult(reportFailure("send", COPY.reportNotSent, e));
    } finally {
      setSending(false);
    }
  };

  // ---- 渲染 -------------------------------------------------------------------

  const curType = channelTypes.find((x) => x.value === chType);
  const typeLabel = (type: string) => channelTypes.find((x) => x.value === type)?.label || type;
  const channelOptions = channels.map((c: any) => ({
    value: c.id,
    label: c.enabled === false ? `${c.name}${COPY.disabledSuffix}` : c.name,
  }));

  const testCell = (c: any) => {
    const t = rowTests[c.id];
    if (!t) return <span className="jy-muted">{COPY.untested}</span>;
    return (
      <span className="jy-notifications-test">
        <StatusText level={t.ok ? "good" : "crit"}>
          {t.ok ? COPY.sent : COPY.sendFailed}
          <span className="jy-caption">{formatZonedTime(t.at, tz)}</span>
        </StatusText>
        {!t.ok && t.text && <span className="jy-caption">{t.text}</span>}
        {!t.ok && <ErrorDetail raw={t.raw} />}
      </span>
    );
  };

  const rowActions = (c: any) => (
    <>
      <Button type="link" size="small" loading={rowTesting === c.id} onClick={() => testChannel(c)} aria-label={COPY.testAria(c.name)}>
        {COPY.test}
      </Button>
      <Button type="link" size="small" onClick={() => openChModal(c)} aria-label={COPY.editAria(c.name)}>
        {COPY.edit}
      </Button>
      <Button type="link" size="small" danger onClick={() => deleteChannel(c)} aria-label={COPY.removeAria(c.name)}>
        {COPY.remove}
      </Button>
    </>
  );

  const enabledToggle = (c: any) => (
    <span className="jy-notifications-toggle">
      <Switch size="small" checked={c.enabled !== false} onChange={() => toggleChannel(c)} aria-label={COPY.enable(c.name)} />
      <span>{c.enabled !== false ? COPY.enabled : COPY.disabled}</span>
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

  // 规则行的附加条件：关闭规则时「连续读不到」那个框禁用；余额提醒线、提醒天数也决定页面上的档位，关掉提醒也照样能改
  const ruleCondition = (ruleKey: string) => {
    const off = !rules[ruleKey];
    if (ruleKey === "onLow")
      return (
        <>
          <div className="jy-notifications-cond">
            <label htmlFor={`${uid}-low`}>{COPY.lowBefore}</label>
            <InputNumber
              id={`${uid}-low`}
              aria-label={COPY.lowLabel}
              {...leaveLow}
              min={0}
              value={low.value}
              onChange={(v) => {
                low.setValue(v as number | null);
                low.clearInvalid();
              }}
              disabled={!metaLoaded}
              status={ruleErrors.low ? "error" : undefined}
              aria-invalid={ruleErrors.low ? true : undefined}
              aria-describedby={ruleErrors.low ? `${uid}-low-desc ${uid}-low-err` : `${uid}-low-desc`}
            />
            <span>{COPY.lowAfter}</span>
            {ruleErrors.low && (
              <span className="jy-err" id={`${uid}-low-err`} role="alert">
                <Sym kind="crit" />
                {ruleErrors.low}
              </span>
            )}
          </div>
          <p className="jy-notifications-note" id={`${uid}-low-desc`}>{COPY.lowHint}</p>
        </>
      );
    if (ruleKey === "onEta")
      return (
        <div className="jy-notifications-cond">
          <label htmlFor={`${uid}-eta`}>{COPY.etaBefore}</label>
          <Space.Compact>
            <InputNumber
              id={`${uid}-eta`}
              aria-label={COPY.etaLabel}
              {...leaveRules}
              min={0}
              precision={2}
              value={ruleForm.value.etaVal}
              onChange={(v) => setRuleField("etaVal", v as number | null)}
              status={ruleErrors.eta ? "error" : undefined}
              aria-invalid={ruleErrors.eta ? true : undefined}
              aria-describedby={ruleErrors.eta ? `${uid}-eta-err` : undefined}
            />
            <Select
              aria-label={COPY.etaUnit}
              value={ruleForm.value.etaUnit}
              onChange={onEtaUnitChange}
              options={[
                { value: "days", label: COPY.day },
                { value: "hours", label: COPY.hour },
              ]}
            />
          </Space.Compact>
          <span>{COPY.etaAfter}</span>
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
          <label htmlFor={`${uid}-errThreshold`}>{COPY.errBefore}</label>
          <InputNumber
            id={`${uid}-errThreshold`}
            aria-label={COPY.errLabel}
            {...leaveRules}
            min={1}
            precision={0}
            suffix={COPY.times}
            value={ruleForm.value.errThreshold}
            onChange={(v) => setRuleField("errThreshold", v as number | null)}
            disabled={off}
            status={ruleErrors.errThreshold ? "error" : undefined}
            aria-invalid={ruleErrors.errThreshold ? true : undefined}
            aria-describedby={ruleErrors.errThreshold ? `${uid}-errThreshold-desc ${uid}-errThreshold-err` : `${uid}-errThreshold-desc`}
          />
          <span id={`${uid}-errThreshold-desc`}>{COPY.errAfter}</span>
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
        <PanelSkeleton title={COPY.rules} lines={6} />
        <PanelSkeleton title={COPY.channels} lines={3} />
        <PanelSkeleton title={COPY.report} lines={3} />
      </div>
    );
  }

  const notifFailed = !notifLoaded && !!notifErr;
  // 有提醒或日报要发，却没有能用的通知方式：消息会被悄悄丢掉，放在页首提醒
  const wantsDelivery = RULES.some((r) => rules[r.key]) || !!settings?.dailyReport?.enabled;
  // 还没有通知方式时整页只放一件事（ui-copy-spec §8.3）：先加通知方式，提醒规则和日报等加好以后再出现
  const noChannelsYet = notifLoaded && channels.length === 0;
  const noDelivery = notifLoaded && !noChannelsYet && wantsDelivery && !channels.some((c) => c.enabled !== false);
  const showChannels = () => {
    document.querySelector(".jy-notifications-channels")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="jy-page">
      {noDelivery ? (
        <div className="jy-banner jy-banner--crit" role="alert">
          <Sym kind="crit" />
          <div className="jy-notifications-banner-body">
            <b>{COPY.noDeliveryOff}</b>
            <p className="jy-caption">{COPY.noDeliveryOffHint}</p>
          </div>
          <Button size="small" onClick={showChannels}>
            {COPY.showChannels}
          </Button>
        </div>
      ) : null}
      {/* 提醒规则 */}
      {noChannelsYet ? null : notifFailed ? (
        <Panel title={COPY.rules}>
          <ErrorState what={COPY.rulesFailed} error={notifErr} onRetry={loadNotif} />
        </Panel>
      ) : (
        <Panel
          title={COPY.rules}
          badge={<SaveState saving={ruleForm.saving || low.saving} dirty={ruleForm.dirty || low.dirty} at={rulesSavedAt} tz={tz} error={low.error || ruleForm.error} />}
          caption={COPY.rulesCaption}
          body="flush"
        >
          <div className="jy-table-wrap">
            <table className="jy-data jy-notifications-rules">
              <thead>
                <tr>
                  <th className="col-switch">{COPY.colSwitch}</th>
                  <th>{COPY.colRule}</th>
                  <th className="col-to">{COPY.colTo}</th>
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
                          checkedChildren={COPY.on}
                          unCheckedChildren={COPY.off}
                          onChange={() => toggleRule(rule.key)}
                          aria-labelledby={titleId}
                        />
                      </td>
                      <td>
                        <span className="jy-notifications-rule-title" id={titleId}>
                          {rule.title}
                        </span>
                        {rule.desc ? <span className="jy-notifications-rule-desc">{rule.desc}</span> : null}
                        {ruleCondition(rule.key)}
                      </td>
                      <td className="col-to">
                        <Select
                          mode="multiple"
                          allowClear
                          aria-label={COPY.ruleTo(rule.title)}
                          placeholder={channels.length ? COPY.allChannels : COPY.noChannels}
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
              <legend>{COPY.pace}</legend>
              <p className="fs-desc">{COPY.paceHint}</p>
              <div className="jy-two">
                <div className="jy-field">
                  <label htmlFor={`${uid}-renotify`}>{COPY.renotify}</label>
                  <InputNumber
                    id={`${uid}-renotify`}
                    {...leaveRules}
                    min={0}
                    suffix={COPY.hours}
                    value={ruleForm.value.renotify}
                    onChange={(v) => setRuleField("renotify", v as number | null)}
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
                      {COPY.renotifyHint}
                    </span>
                  )}
                </div>
                <div className="jy-field">
                  <label htmlFor={`${uid}-errRetry`}>{COPY.retry}</label>
                  <InputNumber
                    id={`${uid}-errRetry`}
                    {...leaveRules}
                    min={0}
                    precision={0}
                    suffix={COPY.seconds}
                    value={ruleForm.value.errRetry}
                    onChange={(v) => setRuleField("errRetry", v as number | null)}
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
                      {COPY.retryHint}
                    </span>
                  )}
                </div>
              </div>
            </fieldset>
          </div>
        </Panel>
      )}

      {/* 通知方式 */}
      {notifFailed ? (
        <Panel title={COPY.channels}>
          <ErrorState what={COPY.channelsFailed} error={notifErr} onRetry={loadNotif} />
        </Panel>
      ) : (
        <Panel
          title={COPY.channels}
          className="jy-notifications-channels"
          badge={<CountBadge count={channels.length} muted />}
          caption={COPY.channelsCaption}
          extra={
            channels.length ? (
              <Button icon={<Icon name="plus" />} onClick={() => openChModal(null)}>
                {COPY.add}
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
                      <th>{COPY.colType}</th>
                      <th>{COPY.colName}</th>
                      <th>{COPY.colStatus}</th>
                      <th>{COPY.colTest}</th>
                      <th className="r">{COPY.colActions}</th>
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
              <ul className="jy-m-list" aria-label={COPY.channels}>
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
                <b className="jy-notifications-empty-title">{COPY.noChannels}</b>
                <p className="jy-notifications-empty-desc">{COPY.emptyHint}</p>
              </div>
              <ul className="jy-notifications-types">
                {channelTypes.map((t) => (
                  <li key={t.value}>
                    <Button onClick={() => openChModal(null, t.value)} aria-label={COPY.addType(t.label)}>
                      <span className="jy-notifications-plate" aria-hidden="true">
                        {CH_PLATE[t.value] || "?"}
                      </span>
                      {t.label}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button type="primary" icon={<Icon name="plus" />} onClick={() => openChModal(null)}>
                {COPY.add}
              </Button>
            </div>
          )}
        </Panel>
      )}

      {/* 还没有通知方式：余额提醒线和提醒天数也决定页面上的档位，只在这里放这两个数（有通知方式时在规则那几行里，不两处同时出现） */}
      {noChannelsYet ? (
        <Panel
          title={COPY.linesTitle}
          caption={COPY.linesCaption}
          badge={<SaveState saving={ruleForm.saving || low.saving} dirty={ruleForm.dirty || low.dirty} at={rulesSavedAt} tz={tz} error={low.error || ruleForm.error} />}
        >
          <div className="jy-notifications-lines">
            {ruleCondition("onLow")}
            {ruleCondition("onEta")}
          </div>
        </Panel>
      ) : null}

      {/* 日报：发送时间按业务时区，和每日利润、日汇总同一天界（§6 不另注时区） */}
      {noChannelsYet ? null : !metaLoaded && metaLoading ? (
        <PanelSkeleton title={COPY.report} lines={3} />
      ) : !metaLoaded ? (
        <Panel title={COPY.report}>
          <ErrorState what={COPY.reportFailed} error={metaErr} onRetry={loadMeta} />
        </Panel>
      ) : (
        <Panel title={COPY.report} badge={<SaveState saving={dr.saving} dirty={false} at={dr.savedAt} tz={tz} error={dr.error} />} caption={COPY.reportCaption}>
          <Form layout="vertical" requiredMark={false} component="div" className="jy-form jy-notifications-dr">
            <Form.Item label={COPY.reportEnable} htmlFor={`${uid}-dr-enabled`} extra={COPY.reportEnableHint}>
              <Switch
                id={`${uid}-dr-enabled`}
                checked={dr.value.enabled}
                checkedChildren={COPY.on}
                unCheckedChildren={COPY.off}
                onChange={(v) => setDr({ enabled: v })}
              />
            </Form.Item>
            <div className="jy-two">
              <Form.Item label={COPY.reportTime} htmlFor={`${uid}-dr-time`} extra={COPY.reportTimeHint}>
                <TimePicker
                  id={`${uid}-dr-time`}
                  format="HH:mm"
                  allowClear={false}
                  disabled={!dr.value.enabled}
                  value={dr.value.time ? dayjs(dr.value.time, "HH:mm") : null}
                  onChange={(d) => setDr({ time: d ? d.format("HH:mm") : "09:00" })}
                />
              </Form.Item>
              <Form.Item
                label={<span id={`${uid}-dr-ch`}>{COPY.reportTo}</span>}
                extra={COPY.reportToHint}
              >
                {channels.length ? (
                  <div role="group" aria-labelledby={`${uid}-dr-ch`}>
                    <Checkbox.Group
                      className="jy-notifications-checks"
                      value={dr.value.channelIds}
                      disabled={!dr.value.enabled}
                      onChange={(ids) => setDr({ channelIds: ids as string[] })}
                      options={channels.map((c) => ({ value: c.id, label: c.name }))}
                    />
                  </div>
                ) : (
                  <span className="jy-muted">{notifFailed ? COPY.channelsFailed : COPY.reportNoChannels}</span>
                )}
              </Form.Item>
            </div>
          </Form>
          <div className="jy-notifications-actions">
            <Button loading={previewing} onClick={previewReport}>
              {COPY.reportPreview}
            </Button>
            <Button loading={sending} onClick={sendReport}>
              {COPY.reportSend}
            </Button>
            <span className="jy-caption">
              {drSaved.lastSent ? COPY.reportLastSent(formatDayKey(drSaved.lastSent, tz)) : COPY.reportIdleHint}
            </span>
          </div>
          <div aria-live="polite">
            {sendResult && (
              <div className={`jy-test-result${sendResult.ok ? "" : " jy-test-result--bad"}`}>
                <Sym kind={sendResult.ok ? "good" : "crit"} />
                <b>{sendResult.text}</b>
                <span>{sendResult.ok ? COPY.sentAt(formatZonedTime(sendResult.at, tz)) : formatZonedTime(sendResult.at, tz)}</span>
                {sendResult.fails.map((f) => (
                  <span key={f.id}>
                    {f.label}：{f.text}
                    <ErrorDetail raw={f.raw} />
                  </span>
                ))}
                {sendResult.setup && (
                  <Link href={SETUP.href!}>{SETUP.label}</Link>
                )}
                <ErrorDetail raw={sendResult.raw} />
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* 通知方式弹窗 */}
      <Modal
        open={chOpen}
        title={editingCh ? COPY.editTitle : COPY.addTitle}
        onCancel={() => setChOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setChOpen(false)}>
            {COPY.cancel}
          </Button>,
          <Button key="save" type="primary" loading={chSaving} onClick={saveChannel}>
            {editingCh ? COPY.save : COPY.add}
          </Button>,
        ]}
        destroyOnHidden
      >
        <p className="jy-caption jy-notifications-modal-intro">{COPY.modalIntro}</p>
        <Form layout="vertical" onFinish={saveChannel} autoComplete="off" className="jy-form">
          <div className="jy-two">
            <Form.Item label={COPY.name} htmlFor={`${uid}-ch-name`}>
              <Input
                id={`${uid}-ch-name`}
                autoComplete="off"
                placeholder={COPY.namePlaceholder}
                value={chName}
                onChange={(e) => setChName(e.target.value)}
              />
            </Form.Item>
            <Form.Item
              label={COPY.type}
              htmlFor={`${uid}-ch-type`}
              extra={editingCh ? COPY.typeLocked : undefined}
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
            const secret = !!f.secret;
            const saved = secret && !!editingCh?.hasSecret?.[f.key];
            const val = chConfig[f.key] || "";
            const help = saved
              ? val
                ? SECRET_FIELD_TEXT.replace(shortLabel(f.label))
                : SECRET_FIELD_TEXT.keep(shortLabel(f.label))
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
                    placeholder={saved ? SECRET_FIELD_TEXT.saved : undefined}
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
            {COPY.sendTest}
          </Button>
          <span className="jy-caption">{COPY.sendTestHint}</span>
        </div>
        <div aria-live="polite">{chTest && <ResultBox r={chTest} okTitle={COPY.testSent} tz={tz} />}</div>
      </Modal>

      {/* 日报预览弹窗：邮件 / 聊天软件两个标签页 */}
      <Modal
        open={reportOpen}
        title={COPY.previewTitle}
        width={720}
        onCancel={() => setReportOpen(false)}
        footer={<Button onClick={() => setReportOpen(false)}>{COPY.close}</Button>}
      >
        <p className="jy-caption jy-notifications-modal-intro">{COPY.previewIntro}</p>
        <Tabs
          idPrefix={`${uid}-report`}
          label={COPY.previewFormat}
          active={reportTab}
          onChange={(k) => setReportTab(k as "html" | "text")}
          tabs={[
            { key: "html", label: COPY.previewMail },
            { key: "text", label: COPY.previewText },
          ]}
        />
        <TabPanel idPrefix={`${uid}-report`} tabKey="html" active={reportTab === "html"}>
          <iframe
            className="jy-notifications-frame"
            title={COPY.previewFrame}
            sandbox=""
            srcDoc={report?.html || `<p>${COPY.previewNoMail}</p>`}
          />
        </TabPanel>
        <TabPanel idPrefix={`${uid}-report`} tabKey="text" active={reportTab === "text"}>
          <pre className="jy-notifications-text">{report?.text}</pre>
        </TabPanel>
      </Modal>
    </div>
  );
}
