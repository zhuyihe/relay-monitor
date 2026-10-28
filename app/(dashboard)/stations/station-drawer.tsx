"use client";
// 新增 / 编辑上游的右侧抽屉。
// 请求地址与载荷和旧版弹窗逐字段一致；改的是交互：字段分三组、登录信息用密码框、
// 编辑时登录信息没动就不要求重新测试读取、关闭前确认没保存的修改。
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import dayjs from "dayjs";
import { App, Button, Collapse, DatePicker, Drawer, Form, Grid, Input, Select, Switch } from "antd";
import { api } from "../../../lib/client";
import { testReadText, workflowActionMeta } from "../../../lib/workflow-actions";
import { describeError, failureText, requiredText } from "../../../lib/error-copy";
import { formatRate, formatSellPrice, RATE_UNSET_PARITY, SELL_PRICE_UNSET } from "../../../lib/format";
import { NAV_LABELS } from "../../../lib/brand";
import { stationDisplayName } from "../../../lib/overview-actions";
import { CREDENTIAL_FIELDS, credentialFieldOf, SECRET_FIELD_TEXT, UPSTREAM_FORM_TEXT, UPSTREAM_SECRET_FIELDS } from "../../../lib/channel-onboarding.js";
import { Dirty } from "../../components/data-state";
import { useDrawerEscape } from "../../components/drawer-escape";
import { ErrorDetail } from "../../components/error-detail";
import { Icon, Sym } from "../../components/icons";
import { StatusText } from "../../components/status";
import type { Level } from "../../components/status";
import {
  CONNECTION_FIELDS,
  CONNECTION_INPUT_FIELDS,
  connectionFingerprint,
  resultIssue,
  testBalanceText,
  TYPES_MISSING_TEXT,
} from "./model";
import type { ConnectionTestResult } from "./model";

export type StationDrawerHandle = {
  // trigger：关闭后把焦点还给它（名称链接、编辑按钮、更多菜单按钮）
  open: (station: any | null, trigger?: HTMLElement | null) => void;
};

// 参与“有未保存的修改”判断的字段；密钥框初始为空，输入即算修改
const FORM_KEYS = [
  "name", "type", "baseUrl", "accessToken", "userId", "apiKey", "email", "password",
  "lowBalanceUsd", "cnyPerUsd", "costAliasesText", "includeInProfit", "isOwn", "noRenewal",
  "keyAgentUrl", "keyAgentSecret",
];
const TEST_READ = workflowActionMeta("verify_identity").label;

// 只在上游编辑页出现的说法（design/ui-copy-spec.md §3、§11）；输入框名和说明用 CREDENTIAL_FIELDS
const COPY = Object.freeze({
  discardTitle: "放弃没保存的修改？",
  discardDesc: "关闭后，这次填的内容不会保存。",
  discard: "放弃修改",
  keepEditing: "接着改",
  cancel: "取消",
  save: "保存",
  saved: "已保存",
  created: (name: string) => `已新增「${name}」`,
  createdReading: (name: string) => `已新增「${name}」，正在读取余额`,
  saveFailed: "保存失败",
  noChange: "还没有修改",
  testFirst: `请先${TEST_READ}`,
  testFirstToSave: `请先${TEST_READ}，读到了再保存`,
  purchaseBad: "每笔固定成本记录的金额和天数都要大于 0",
  // 测试读取那一行的状态
  testing: "正在读取",
  testOk: "能读到",
  testBad: "读不到",
  testSkip: "登录信息没改，不用重新测试",
  testNone: "还没测试读取",
  account: (name: string) => `上游账号 ${name}`,
  notSavedYet: (button: string) => `这次填的还没保存，点「${button}」才会用上。`,
  changed: "登录信息改过了",
  changedDesc: `保存前请重新${TEST_READ}，确认新的登录信息能读到余额。`,
  hintUnchanged: `只有改了登录信息才要重新${TEST_READ}`,
  hintCreate: `先${TEST_READ}，读到了才能新增`,
  // 分区
  basics: "基本信息",
  login: "登录信息",
  loginDesc: "登录信息存在控制台的服务器上，只用来读取这个上游的余额和用量记录。",
  cost: "成本与提醒线",
  costDesc: "不填就是不设置，不会当成 0。",
  namePlaceholder: "例如：主力上游",
  // 开关和填写项
  isOwn: "这是我的自营站点",
  isOwnDesc: `打开后，「${NAV_LABELS.my}」页会显示这个站点的用户、模型和收入。要填超级管理员的访问令牌和用户 ID。卖给客户的管理员 Key 在「${NAV_LABELS.my}」页的「转售 Key」里勾上，它的花费算收入。`,
  inProfit: "算进利润",
  inProfitFixed: "固定成本按天平摊，从净利里扣。只是看看、不属于这门生意的就关掉。",
  inProfitDesc: "默认算进：就算自营站点的渠道里找不到这个上游，也按用量或余额变化算进上游成本。只是看看，或者会和别的上游重复算时才关掉。",
  fixedTitle: `固定成本不用${TEST_READ}`,
  fixedDesc: "只按固定成本记录按天平摊，不读取上游，也没有余额提醒。",
  rate: "汇率",
  ratePlaceholder: "例如 2",
  rateExample: `例如填 2 就是「${formatRate(2)}」；不填就是「${RATE_UNSET_PARITY}」。`,
  rateNow: (text: string) => `${text}。`,
  rateBalance: "余额提醒照上游自己的余额算。",
  // 自营站点那一格叫「售价」（§3.2、§7）：存的也是 cnyPerUsd，说的是给用户充 1 美元额度收多少元
  sellPrice: "售价",
  sellPlaceholder: "例如 7.5",
  sellExample: `例如填 7.5 就是「${formatSellPrice(7.5)}」；不填就是「${SELL_PRICE_UNSET}」。`,
  lowBalance: "余额提醒线",
  lowBalancePlaceholder: "不填就用告警中心里的",
  lowBalanceDesc: "按这个上游自己的余额算，低于它就提醒。",
  aliases: "渠道里用的其他地址",
  aliasesDesc: "自营站点的渠道里填的不是这个上游的公开地址时（比如内网地址、代理地址），每行填一个，才对得上这个上游。",
  noRenewal: "不再续费",
  noRenewalDesc: "余额第一次低于提醒线时提醒一次，之后不再提醒余额偏低、余额用完和快用完。读不到余额照常提醒。",
  purchases: "固定成本记录",
  purchasesLabel: "固定成本记录（可以记多笔）",
  purchaseGroup: (n: number) => `第 ${n} 笔固定成本记录`,
  amount: "金额（¥）",
  amountOf: (n: number) => `第 ${n} 笔金额（¥）`,
  days: "天数",
  daysOf: (n: number) => `第 ${n} 笔天数`,
  startDate: "开始日期",
  removeOne: "删掉这笔",
  removeOf: (n: number) => `删掉第 ${n} 笔固定成本记录`,
  addOne: "再记一笔",
  purchasesDesc: "每笔按「金额 ÷ 天数」按天平摊，从开始日期算起，到期就不再算；几笔重叠时加在一起（在原来的套餐上加购或续费，就再记一笔）。",
  // 渠道 Key 读取服务（K2a，design/ui-copy-spec.md §3.7、附录「怎么装」收起区）
  keyAgentUrl: "读取服务地址",
  keyAgentUrlHint: "默认是站点地址后面加固定路径，装在别处时才改。",
  keyAgentUrlPlaceholder: "https://api.example.com/relay-monitor-agent",
  keyAgentSecret: "读取服务令牌",
  keyAgentSecretHint: "装渠道 Key 读取服务时设的那个令牌，至少 32 个字符。",
  keyAgentNotConfigured: "还没装读取服务",
  howToInstall: "怎么装（在你站的 docker compose 里加几行）",
  howToInstallSteps: [
    "生成一个令牌：在你站的服务器上运行 openssl rand -base64 32，得到的一串就是令牌，下面两处都用它。",
    "在你站的 docker compose 里加一个 relay-key-agent 服务（镜像、环境变量和示例片段见仓库 deploy/README.md「装渠道 Key 读取服务」第 3 步），令牌填进它的 RELAY_KEY_AGENT_SECRET，然后重启。",
    "有反向代理的，把「站点地址 + 固定路径」转给它，「读取服务地址」不用改；没有反向代理、直接开端口的，在下面「读取服务地址」里填那个地址。都要走 HTTPS。",
    "想更稳妥：按 deploy/README.md 第 2 步给数据库建一个只能查渠道表的专用账号。",
    "装好以后，把令牌填进上面「读取服务令牌」那一栏，点「测试读取」。",
  ],
  keyAgentOk: (n: number) => `能读到：${n} 个渠道的 Key`,
});

// 读取服务那一栏的状态（design/ui-copy-spec.md §5.2「自营站点读到了」）：没配置不算错，太弱说清是哪一种，其余归到和别处一样的「其他」
function keyAgentIssueText(code: string | undefined) {
  if (code === "SECRET_TOO_SHORT") return "令牌至少 32 个字符，用「怎么装」里的命令生成一串";
  if (code === "SECRET_TOO_WEAK") return "令牌太弱，用「怎么装」里的命令生成一串";
  if (code === "KEY_AGENT_URL_INVALID") return "读取服务地址要用加密连接的网址（参考输入框里的示例）";
  return describeError({ code }).text;
}

function snapshotOf(values: any, purchases: any[]) {
  const v: Record<string, unknown> = {};
  for (const k of FORM_KEYS) v[k] = typeof values?.[k] === "boolean" ? values[k] : String(values?.[k] ?? "");
  return JSON.stringify([v, purchases.map((p) => [String(p.amount ?? ""), String(p.days ?? ""), p.startDate || ""])]);
}

// Form.Item 会给直接子元素注入 checked / onChange / id；外包 label 让整行文字都可点击
function SwitchRow({ checked, onChange, id, label }: { checked?: boolean; onChange?: (v: boolean) => void; id?: string; label: ReactNode }) {
  return (
    <label className="jy-stations-switch">
      <Switch id={id} checked={!!checked} onChange={(v) => onChange?.(v)} />
      <span>{label}</span>
    </label>
  );
}

export function StationDrawer({
  ref,
  types,
  onSaved,
}: {
  ref?: Ref<StationDrawerHandle>;
  types: any[];
  // 保存成功后由页面重新拉列表；抛错时按保存失败提示（与旧版一致）
  onSaved: () => Promise<unknown>;
}) {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [form] = Form.useForm();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null); // null = 新增
  const [saving, setSaving] = useState(false);
  const [purchases, setPurchases] = useState<any[]>([]); // 固定成本付费记录行
  const [testing, setTesting] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestResult | null>(null);
  const [formFingerprint, setFormFingerprint] = useState("");
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);
  // 打开编辑时的连接指纹：当前指纹与它相同，说明连接字段没改，沿用已保存的连接即可
  const [initialFingerprint, setInitialFingerprint] = useState("");
  const [dirty, setDirty] = useState(false);
  const initialSnapshot = useRef("");
  const triggerRef = useRef<HTMLElement | null>(null);
  // forceRender 让表单在首次打开前就挂好（setFieldsValue 才有对象），但服务端渲染不出 Portal；
  // 挂载后再渲染抽屉，避免 hydration 不一致
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const formType = Form.useWatch("type", form);
  const typedAccessToken = Form.useWatch("accessToken", form);
  const typedApiKey = Form.useWatch("apiKey", form);
  const typedPassword = Form.useWatch("password", form);
  const typed: Record<string, unknown> = { accessToken: typedAccessToken, apiKey: typedApiKey, password: typedPassword };
  const typedRate = Form.useWatch("cnyPerUsd", form);
  const typedOwn = Form.useWatch("isOwn", form);
  const typedKeyAgentSecret = Form.useWatch("keyAgentSecret", form);

  const needsFor = (type: string): string[] => types.find((item) => item.value === type)?.needs || [];

  const openDrawer = (station: any | null, trigger?: HTMLElement | null) => {
    if (!types.length) {
      message.warning(TYPES_MISSING_TEXT);
      return;
    }
    triggerRef.current = trigger || null;
    setEditing(station || null);
    const values = {
      name: station?.name || "",
      type: station?.type || types[0]?.value,
      baseUrl: station?.baseUrl || "",
      accessToken: "",
      userId: station?.userId || "",
      apiKey: "",
      email: station?.email || "",
      password: "",
      lowBalanceUsd: station?.lowBalanceUsd ?? "",
      cnyPerUsd: station?.cnyPerUsd ?? "",
      costAliasesText: Array.isArray(station?.costAliases) ? station.costAliases.join("\n") : "",
      includeInProfit: station?.includeInProfit !== false,
      isOwn: !!station?.isOwn,
      noRenewal: !!station?.noRenewal,
      keyAgentUrl: station?.keyAgentUrl || "",
      keyAgentSecret: "",
    };
    form.setFieldsValue(values);
    const fingerprint = connectionFingerprint(values, station?.id, needsFor(values.type));
    setFormFingerprint(fingerprint);
    setInitialFingerprint(fingerprint);
    setConnectionTest(null);
    setTestedFingerprint(null);
    // 付费记录：无记录时默认给一行、起始日期今天（同旧版）
    const list = station?.fixedPurchases;
    const rows = list && list.length ? list.map((p: any) => ({ ...p })) : [{ startDate: dayjs().format("YYYY-MM-DD") }];
    setPurchases(rows);
    initialSnapshot.current = snapshotOf(values, rows);
    setDirty(false);
    setOpen(true);
  };

  useImperativeHandle(ref, () => ({ open: openDrawer }));

  // 付费记录不在 Form 里，变化后单独重算“是否有修改”
  useEffect(() => {
    if (!open) return;
    setDirty(snapshotOf(form.getFieldsValue(true), purchases) !== initialSnapshot.current);
  }, [purchases]); // eslint-disable-line react-hooks/exhaustive-deps

  const onValuesChange = (changed: any) => {
    const all = form.getFieldsValue(true);
    if (Object.keys(changed).some((field) => CONNECTION_FIELDS.has(field))) {
      const fingerprint = connectionFingerprint(all, editing?.id, needsFor(all.type));
      setFormFingerprint(fingerprint);
      if (testedFingerprint !== fingerprint) {
        setConnectionTest(null);
        setTestedFingerprint(null);
      }
    }
    // 读取服务地址/令牌不影响上游本身的连接指纹，改了以后只清掉它自己那条结果，不动主结果
    if (("keyAgentUrl" in changed || "keyAgentSecret" in changed) && connectionTest?.keyAgent) {
      setConnectionTest((prev) => (prev ? { ...prev, keyAgent: undefined } : prev));
    }
    setDirty(snapshotOf(all, purchases) !== initialSnapshot.current);
  };

  const close = () => setOpen(false);
  const requestClose = () => {
    if (saving) return;
    if (!dirty) return close();
    modal.confirm({
      title: COPY.discardTitle,
      content: COPY.discardDesc,
      okText: COPY.discard,
      cancelText: COPY.keepEditing,
      okButtonProps: { danger: true },
      onOk: close,
    });
  };
  // 有日期选择器（固定采购到期日），Esc 先收起日期面板再关抽屉（#413）
  useDrawerEscape(open && !saving, requestClose);

  const isFixed = formType === "fixed";
  // 自营站点：「算进利润」「渠道里用的其他地址」只对上游有用，藏起来但照旧提交原来的值（Form.Item hidden 仍收集值）；「汇率」改叫「售价」
  const isOwnStation = formType === "newapi" && !!typedOwn;
  const needs = needsFor(formType);
  const unchangedEdit = !!editing && formFingerprint === initialFingerprint;
  const testPassed = !!connectionTest?.ok && testedFingerprint === formFingerprint;
  const canSave = isFixed || unchangedEdit || testPassed;

  const onTestConnection = async () => {
    const values = form.getFieldsValue();
    const type = String(values.type || "").trim();
    const fields = needsFor(type);
    const fingerprint = connectionFingerprint(values, editing?.id, fields);
    setTesting(true);
    setConnectionTest(null);
    setTestedFingerprint(null);
    try {
      const payload: Record<string, unknown> = { stationId: editing?.id, type };
      if (type !== "fixed") payload.baseUrl = String(values.baseUrl || "").trim();
      for (const field of fields) payload[field] = values[field] ?? "";
      // 渠道 Key 读取服务（K2a）：自营站点顺带测一下，不影响上游本身的测试结果
      if (type === "newapi" && values.isOwn) {
        payload.isOwn = true;
        payload.keyAgentUrl = String(values.keyAgentUrl || "").trim();
        payload.keyAgentSecret = String(values.keyAgentSecret || "").trim();
      }
      const result = await api("/api/stations/test", { body: payload });
      setConnectionTest(result.ok ? result : { ok: false, issue: resultIssue(result) });
      setTestedFingerprint(fingerprint);
    } catch (e: any) {
      setConnectionTest({ ok: false, issue: resultIssue(e) });
      setTestedFingerprint(fingerprint);
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    const v = form.getFieldsValue();
    const type = String(v.type || "").trim();
    const connectionFields = needsFor(type);
    const payload: any = {
      name: String(v.name || "").trim(),
      type,
      lowBalanceUsd: String(v.lowBalanceUsd ?? "").trim(),
      cnyPerUsd: String(v.cnyPerUsd ?? "").trim(),
      costAliases: String(v.costAliasesText || "")
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean),
      includeInProfit: !!v.includeInProfit,
      // 金额/天数保持字符串提交，全空行剔除（同旧版）
      fixedPurchases: purchases
        .map((p) => ({
          amount: String(p.amount ?? "").trim(),
          days: String(p.days ?? "").trim(),
          startDate: p.startDate || "",
        }))
        .filter((p) => p.amount !== "" || p.days !== ""),
      isOwn: v.type === "newapi" && !!v.isOwn,
      // 固定成本的上游一律不「不再续费」：它会关掉到期提醒，而固定成本的表单里没有这个开关（汇率等三项照原值带上）
      noRenewal: v.type !== "fixed" && !!v.noRenewal,
    };
    if (type !== "fixed") {
      payload.baseUrl = String(v.baseUrl || "").trim();
      for (const field of connectionFields) {
        const value = field === "password" ? String(v[field] || "") : String(v[field] ?? "").trim();
        // 编辑时敏感凭证留空表示保持已保存的值；其他当前类型字段按表单值提交
        if (UPSTREAM_SECRET_FIELDS.includes(field)) {
          if (value) payload[field] = value;
        } else {
          payload[field] = value;
        }
      }
    }
    // 渠道 Key 读取服务（K2a）：只对自营站点有意义，留空表示不装 / 保持已保存的令牌
    if (type === "newapi" && v.isOwn) {
      payload.keyAgentUrl = String(v.keyAgentUrl || "").trim();
      const keyAgentSecret = String(v.keyAgentSecret || "").trim();
      if (keyAgentSecret) payload.keyAgentSecret = keyAgentSecret;
    }
    // 切换接入类型时，清掉不再适用的旧凭证和地址；同类型编辑仍允许敏感字段留空以保持原值
    const applicableConnectionFields = new Set(type === "fixed" ? [] : ["baseUrl", ...connectionFields]);
    for (const field of CONNECTION_INPUT_FIELDS) {
      if (!applicableConnectionFields.has(field)) payload[field] = "";
    }
    if (payload.type === "fixed") {
      const bad = payload.fixedPurchases.find((p: any) => !(Number(p.amount) > 0) || !(Number(p.days) > 0));
      if (bad) return message.error(COPY.purchaseBad);
      if (!payload.fixedPurchases.length) return message.error(requiredText(COPY.purchases));
    } else if (!payload.baseUrl) {
      return message.error(requiredText(CREDENTIAL_FIELDS.baseUrl.label));
    }
    // 保存时按当前表单重算指纹，不依赖可能滞后一拍的状态
    const fingerprintNow = connectionFingerprint(form.getFieldsValue(true), editing?.id, connectionFields);
    const connectionOk = (!!editing && fingerprintNow === initialFingerprint)
      || (!!connectionTest?.ok && testedFingerprint === fingerprintNow);
    if (payload.type !== "fixed" && !connectionOk) {
      return message.warning(COPY.testFirstToSave);
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/stations/${editing.id}`, { method: "PUT", body: payload });
        message.success(COPY.saved);
      } else {
        await api("/api/stations", { method: "POST", body: payload });
        const name = stationDisplayName(payload);
        message.success(payload.type === "fixed" ? COPY.created(name) : COPY.createdReading(name));
      }
      setOpen(false);
      await onSaved();
    } catch (e: any) {
      message.error(failureText(COPY.saveFailed, e));
    } finally {
      setSaving(false);
    }
  };

  const saveLabel = editing ? COPY.save : UPSTREAM_FORM_TEXT.create;

  // 测试读取那一行的状态：形状 + 文字，不只靠颜色
  const testState: { level: Level; label: string } = testing
    ? { level: "info", label: COPY.testing }
    : testPassed
      ? { level: "good", label: COPY.testOk }
      : connectionTest
        ? { level: "crit", label: COPY.testBad }
        : unchangedEdit
          ? { level: "muted", label: COPY.testSkip }
          : { level: "muted", label: COPY.testNone };

  // 测试读取的结果和需处理里同一句（testReadText）；上游返回的说明和耗时不上界面
  let testResult: ReactNode = null;
  if (connectionTest?.ok) {
    testResult = (
      <div className="jy-test-result">
        <Sym kind="good" />
        <b>{testReadText({ ok: true, balance: testBalanceText(connectionTest) || "", bill: false })}</b>
        {connectionTest.account ? <span>{COPY.account(connectionTest.account)}</span> : null}
        <span>{COPY.notSavedYet(saveLabel)}</span>
      </div>
    );
  } else if (connectionTest) {
    testResult = (
      <div className="jy-test-result jy-test-result--bad">
        <Sym kind="crit" />
        <b>{testReadText({ ok: false, reason: connectionTest.issue?.text })}</b>
        {connectionTest.issue?.raw ? <div><ErrorDetail raw={connectionTest.issue.raw} /></div> : null}
      </div>
    );
  } else if (editing && !unchangedEdit) {
    testResult = (
      <div className="jy-test-result jy-test-result--stale">
        <Sym kind="warn" />
        <b>{COPY.changed}</b>
        <span>{COPY.changedDesc}</span>
      </div>
    );
  }
  const testHint = testPassed
    ? null
    : unchangedEdit
      ? COPY.hintUnchanged
      : editing
        ? null
        : COPY.hintCreate;

  // 登录信息的输入框：名字和说明来自 CREDENTIAL_FIELDS（§3.7）；编辑时占位「已保存」，说明随是否输入而变（审计 V1）
  const secretItem = (name: "accessToken" | "apiKey" | "password", placeholder: string | undefined, has: boolean) => {
    const field = credentialFieldOf(formType, name);
    const saved = !!editing && has;
    const replacing = !!String(typed[name] || "");
    return (
      <Form.Item
        key={name}
        label={field.label}
        name={name}
        extra={saved ? (replacing ? SECRET_FIELD_TEXT.replace(field.label) : SECRET_FIELD_TEXT.keep(field.label)) : field.hint}
      >
        <Input.Password autoComplete="new-password" placeholder={saved ? SECRET_FIELD_TEXT.saved : placeholder} />
      </Form.Item>
    );
  };

  const credentialItems: ReactNode[] = [];
  if (needs.includes("accessToken")) credentialItems.push(secretItem("accessToken", undefined, !!editing?.hasAccessToken));
  if (needs.includes("userId")) {
    credentialItems.push(
      <Form.Item key="userId" label={CREDENTIAL_FIELDS.userId.label} name="userId" extra={CREDENTIAL_FIELDS.userId.hint}>
        <Input placeholder="例如 1" autoComplete="off" />
      </Form.Item>,
    );
  }
  if (needs.includes("apiKey")) credentialItems.push(secretItem("apiKey", "sk-…", !!editing?.hasApiKey));
  if (needs.includes("email")) {
    credentialItems.push(
      <Form.Item key="email" label={CREDENTIAL_FIELDS.email.label} name="email">
        <Input placeholder="you@example.com" autoComplete="off" inputMode="email" />
      </Form.Item>,
    );
  }
  if (needs.includes("password")) credentialItems.push(secretItem("password", undefined, !!editing?.hasPassword));

  // 渠道 Key 读取服务（K2a）：和主连接测试同一次「测试读取」里带出来，和主结果分开展示，不影响主结果的通过/失败
  const keyAgentResult = testPassed && connectionTest ? connectionTest.keyAgent || null : null;

  const typeHint = types.find((t) => t.value === formType)?.hint;
  const rateText = isOwnStation ? formatSellPrice(typedRate) : formatRate(typedRate);
  const updatePurchase = (i: number, patch: Record<string, unknown>) =>
    setPurchases((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  if (!mounted) return null;
  return (
    <Drawer
      className="jy-drawer"
      placement="right"
      size={screens.md === false ? "100%" : 520}
      open={open}
      onClose={requestClose}
      keyboard={false}
      forceRender
      focusable={{ focusTriggerAfterClose: false }}
      afterOpenChange={(o) => {
        if (o) return;
        const t = triggerRef.current;
        if (t && t.isConnected) t.focus();
      }}
      title={editing ? UPSTREAM_FORM_TEXT.editTitle(stationDisplayName(editing)) : UPSTREAM_FORM_TEXT.create}
      footer={
        <div className="jy-drawer-foot">
          <Dirty show={dirty} />
          <span className="spacer" />
          <Button onClick={requestClose} disabled={saving}>{COPY.cancel}</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!canSave || (!!editing && !dirty)}
            title={!canSave ? COPY.testFirst : editing && !dirty ? COPY.noChange : undefined}
            onClick={onSave}
          >
            {saveLabel}
          </Button>
        </div>
      }
    >
      {/* 抽屉常驻挂载：表单要有 name，字段 id 才不会和页面上其他表单（账号授权、渠道接入）撞车，标签才能指到自己的输入框 */}
      <Form name="station" form={form} layout="vertical" requiredMark={false} onValuesChange={onValuesChange}>
        <fieldset className="jy-fs">
          <legend>{COPY.basics}</legend>
          <Form.Item label={CREDENTIAL_FIELDS.name.label} name="name">
            <Input placeholder={COPY.namePlaceholder} autoComplete="off" />
          </Form.Item>
          <Form.Item label={CREDENTIAL_FIELDS.type.label} name="type" extra={typeHint}>
            <Select options={types.map((t) => ({ value: t.value, label: t.label }))} />
          </Form.Item>
          {!isFixed && (
            <Form.Item label={CREDENTIAL_FIELDS.baseUrl.label} name="baseUrl" extra={CREDENTIAL_FIELDS.baseUrl.hint}>
              <Input placeholder="https://api.example.com" autoComplete="off" inputMode="url" />
            </Form.Item>
          )}
          {formType === "newapi" && (
            <Form.Item name="isOwn" valuePropName="checked" extra={COPY.isOwnDesc}>
              <SwitchRow label={COPY.isOwn} />
            </Form.Item>
          )}
          <Form.Item name="includeInProfit" valuePropName="checked" hidden={isOwnStation} extra={isFixed ? COPY.inProfitFixed : COPY.inProfitDesc}>
            <SwitchRow label={COPY.inProfit} />
          </Form.Item>
        </fieldset>

        <fieldset className="jy-fs">
          <legend>{COPY.login}</legend>
          {!isFixed ? <p className="fs-desc">{COPY.loginDesc}</p> : null}
          {credentialItems.length > 1 ? <div className="jy-two">{credentialItems}</div> : credentialItems}
          {isOwnStation && (
            <>
              <Form.Item label={COPY.keyAgentUrl} name="keyAgentUrl" extra={COPY.keyAgentUrlHint}>
                <Input placeholder={COPY.keyAgentUrlPlaceholder} autoComplete="off" inputMode="url" />
              </Form.Item>
              <Form.Item
                label={COPY.keyAgentSecret}
                name="keyAgentSecret"
                extra={
                  editing?.hasKeyAgentSecret && !String(typedKeyAgentSecret || "")
                    ? SECRET_FIELD_TEXT.keep(COPY.keyAgentSecret)
                    : editing?.hasKeyAgentSecret
                      ? SECRET_FIELD_TEXT.replace(COPY.keyAgentSecret)
                      : COPY.keyAgentSecretHint
                }
              >
                <Input.Password autoComplete="new-password" placeholder={editing?.hasKeyAgentSecret ? SECRET_FIELD_TEXT.saved : undefined} />
              </Form.Item>
              <Collapse
                className="jy-stations-howto"
                ghost
                items={[{
                  key: "how",
                  label: COPY.howToInstall,
                  children: (
                    <ol>
                      {COPY.howToInstallSteps.map((step, i) => <li key={i}>{step}</li>)}
                    </ol>
                  ),
                }]}
              />
            </>
          )}
          {isFixed ? (
            <div className="jy-banner jy-banner--info">
              <Sym kind="info" />
              <div className="jy-banner__body">
                <b>{COPY.fixedTitle}</b>
                <p className="jy-caption">{COPY.fixedDesc}</p>
              </div>
            </div>
          ) : (
            <>
              <div className="jy-test-row">
                <Button icon={<Icon name="test" />} loading={testing} onClick={onTestConnection}>
                  {TEST_READ}
                </Button>
                <StatusText level={testState.level}>{testState.label}</StatusText>
              </div>
              <div aria-live="polite">{testResult}</div>
              {testHint ? <p className="jy-caption jy-stations-hint">{testHint}</p> : null}
              {isOwnStation && keyAgentResult && (
                <div className={keyAgentResult.ok ? "jy-test-result" : "jy-test-result jy-test-result--bad"}>
                  <Sym kind={keyAgentResult.ok ? "good" : keyAgentResult.code === "KEY_AGENT_NOT_CONFIGURED" ? "info" : "crit"} />
                  <b>{keyAgentResult.ok ? COPY.keyAgentOk(keyAgentResult.channelCount) : keyAgentResult.code === "KEY_AGENT_NOT_CONFIGURED" ? COPY.keyAgentNotConfigured : keyAgentIssueText(keyAgentResult.code)}</b>
                </div>
              )}
            </>
          )}
        </fieldset>

        <fieldset className="jy-fs">
          <legend>{COPY.cost}</legend>
          {!isFixed && <p className="fs-desc">{COPY.costDesc}</p>}
          {/* 固定成本的上游用不到下面几项，只藏起来不拿掉：汇率、余额提醒线、其他地址保存时照原值带上，改回按用量算时还在；不再续费保存时写 false（见 onSave） */}
          <Form.Item
            label={isOwnStation ? COPY.sellPrice : COPY.rate}
            name="cnyPerUsd"
            hidden={isFixed}
            extra={isOwnStation ? (rateText ? COPY.rateNow(rateText) : COPY.sellExample) : `${rateText ? COPY.rateNow(rateText) : COPY.rateExample}${COPY.rateBalance}`}
          >
            <Input placeholder={isOwnStation ? COPY.sellPlaceholder : COPY.ratePlaceholder} inputMode="decimal" autoComplete="off" />
          </Form.Item>
          <Form.Item label={COPY.lowBalance} name="lowBalanceUsd" hidden={isFixed} extra={COPY.lowBalanceDesc}>
            <Input placeholder={COPY.lowBalancePlaceholder} inputMode="decimal" autoComplete="off" />
          </Form.Item>
          <Form.Item label={COPY.aliases} name="costAliasesText" hidden={isFixed || isOwnStation} extra={COPY.aliasesDesc}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder={"例如：10.0.0.8:8080\nhttp://relay.internal"} />
          </Form.Item>
          <Form.Item name="noRenewal" valuePropName="checked" hidden={isFixed} extra={COPY.noRenewalDesc}>
            <SwitchRow label={COPY.noRenewal} />
          </Form.Item>
          {isFixed && (
            <Form.Item label={COPY.purchasesLabel}>
              {purchases.map((p, i) => (
                <div key={i} className="jy-stations-purchase" role="group" aria-label={COPY.purchaseGroup(i + 1)}>
                  <Input
                    placeholder={COPY.amount}
                    aria-label={COPY.amountOf(i + 1)}
                    inputMode="decimal"
                    value={p.amount ?? ""}
                    onChange={(e) => updatePurchase(i, { amount: e.target.value })}
                  />
                  <Input
                    placeholder={COPY.days}
                    aria-label={COPY.daysOf(i + 1)}
                    inputMode="numeric"
                    value={p.days ?? ""}
                    onChange={(e) => updatePurchase(i, { days: e.target.value })}
                  />
                  <DatePicker
                    placeholder={COPY.startDate}
                    value={p.startDate ? dayjs(p.startDate) : null}
                    onChange={(d) => updatePurchase(i, { startDate: d ? d.format("YYYY-MM-DD") : "" })}
                  />
                  <button
                    type="button"
                    className="jy-icon-btn"
                    title={COPY.removeOne}
                    aria-label={COPY.removeOf(i + 1)}
                    onClick={() => setPurchases((l) => l.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <Button
                type="dashed"
                icon={<Icon name="plus" />}
                onClick={() => setPurchases((l) => [...l, { startDate: dayjs().format("YYYY-MM-DD") }])}
              >
                {COPY.addOne}
              </Button>
              <p className="jy-caption jy-stations-hint">{COPY.purchasesDesc}</p>
            </Form.Item>
          )}
        </fieldset>
      </Form>
    </Drawer>
  );
}
