"use client";
// 新增 / 编辑上游资源的右侧抽屉。
// 请求地址与载荷和旧版弹窗逐字段一致；改的是交互：字段分三组、密钥用密码框、
// 编辑时连接字段没动就不要求重新测试、关闭前确认未保存的修改。
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import dayjs from "dayjs";
import { App, Button, DatePicker, Drawer, Form, Grid, Input, Select, Switch } from "antd";
import { api } from "../../../lib/client";
import { Icon, Sym } from "../../components/icons";
import { StatusText } from "../../components/status";
import type { Level } from "../../components/status";
import {
  CONNECTION_FIELDS,
  CONNECTION_GUIDANCE,
  CONNECTION_INPUT_FIELDS,
  connectionFingerprint,
  resultIssue,
  testBalanceText,
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
];
const SECRET_NOUN: Record<string, string> = { accessToken: "令牌", apiKey: "密钥", password: "密码" };

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

  const needsFor = (type: string): string[] => types.find((item) => item.value === type)?.needs || [];

  const openDrawer = (station: any | null, trigger?: HTMLElement | null) => {
    if (!types.length) {
      message.warning("资源类型暂未加载，请先重试资源配置加载。");
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
    setDirty(snapshotOf(all, purchases) !== initialSnapshot.current);
  };

  const close = () => setOpen(false);
  const requestClose = () => {
    if (saving) return;
    if (!dirty) return close();
    modal.confirm({
      title: "放弃未保存的修改？",
      content: "关闭后，这次填写的内容不会保存。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
      onOk: close,
    });
  };

  const isFixed = formType === "fixed";
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
      const result = await api("/api/stations/test", { body: payload });
      setConnectionTest(result.ok ? result : { ok: false, ...resultIssue(result, result.message, values) });
      setTestedFingerprint(fingerprint);
    } catch (e: any) {
      setConnectionTest({ ok: false, ...resultIssue(null, e.message || "请求失败", values) });
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
      noRenewal: v.type !== "fixed" && !!v.noRenewal,
    };
    if (type !== "fixed") {
      payload.baseUrl = String(v.baseUrl || "").trim();
      for (const field of connectionFields) {
        const value = field === "password" ? String(v[field] || "") : String(v[field] ?? "").trim();
        // 编辑时敏感凭证留空表示保持已保存的值；其他当前类型字段按表单值提交
        if (["accessToken", "apiKey", "password"].includes(field)) {
          if (value) payload[field] = value;
        } else {
          payload[field] = value;
        }
      }
    }
    // 切换接入类型时，清掉不再适用的旧凭证和地址；同类型编辑仍允许敏感字段留空以保持原值
    const applicableConnectionFields = new Set(type === "fixed" ? [] : ["baseUrl", ...connectionFields]);
    for (const field of CONNECTION_INPUT_FIELDS) {
      if (!applicableConnectionFields.has(field)) payload[field] = "";
    }
    if (payload.type === "fixed") {
      const bad = payload.fixedPurchases.find((p: any) => !(Number(p.amount) > 0) || !(Number(p.days) > 0));
      if (bad) return message.error("每笔付费需填写金额与天数（均大于 0）");
      if (!payload.fixedPurchases.length) return message.error("请至少填写一笔付费记录");
    } else if (!payload.baseUrl) {
      return message.error("请填写站点地址");
    }
    // 保存时按当前表单重算指纹，不依赖可能滞后一拍的状态
    const fingerprintNow = connectionFingerprint(form.getFieldsValue(true), editing?.id, connectionFields);
    const connectionOk = (!!editing && fingerprintNow === initialFingerprint)
      || (!!connectionTest?.ok && testedFingerprint === fingerprintNow);
    if (payload.type !== "fixed" && !connectionOk) {
      return message.warning("请先测试连接，确认成功后再保存");
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/stations/${editing.id}`, { method: "PUT", body: payload });
        message.success("已更新");
      } else {
        await api("/api/stations", { method: "POST", body: payload });
        message.success("已添加，正在查询余额…");
      }
      setOpen(false);
      await onSaved();
    } catch (e: any) {
      message.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 连接状态文字：形状 + 文字，不只靠颜色
  const testState: { level: Level; label: string } = testing
    ? { level: "info", label: "测试中" }
    : testPassed
      ? { level: "good", label: "已验证" }
      : connectionTest
        ? { level: "crit", label: "需要修复" }
        : unchangedEdit
          ? { level: "muted", label: "无需重新测试" }
          : { level: "muted", label: "尚未测试" };

  let testResult: ReactNode = null;
  if (connectionTest?.ok) {
    const detail = [connectionTest.account ? `账户 ${connectionTest.account}` : null, testBalanceText(connectionTest)].filter(Boolean).join("，");
    testResult = (
      <div className="jy-test-result">
        <Sym kind="good" />
        <b>
          {connectionTest.message || "连接正常"}
          {connectionTest.latencyMs != null ? `（${connectionTest.latencyMs}ms）` : ""}
        </b>
        {detail ? <span className="jy-num">{detail}</span> : null}
        <span>连接信息尚未写入；点击保存后才会创建或更新资源。</span>
      </div>
    );
  } else if (connectionTest) {
    testResult = (
      <div className="jy-test-result jy-test-result--bad">
        <Sym kind="crit" />
        <b>{connectionTest.category}：{connectionTest.message}</b>
        <span>{connectionTest.action}</span>
        {connectionTest.diagnostic ? (
          <div>
            <details className="jy-stations-diag">
              <summary>查看脱敏诊断</summary>
              <span>{connectionTest.diagnostic}</span>
            </details>
          </div>
        ) : null}
      </div>
    );
  } else if (editing && !unchangedEdit) {
    testResult = (
      <div className="jy-test-result jy-test-result--stale">
        <Sym kind="warn" />
        <b>连接凭证已修改</b>
        <span>保存前请重新测试，确认新的凭证可以查询余额。</span>
      </div>
    );
  }
  const testHint = testPassed
    ? null
    : unchangedEdit
      ? "只有修改连接凭证时才需要重新测试"
      : editing
        ? null
        : "请先测试连接；测试成功后才可保存资源。";

  // 密钥字段：编辑时占位“已保存”，帮助文字随是否输入而变化（审计 V1）
  const secretItem = (name: "accessToken" | "apiKey" | "password", label: string, fallback: string, has: boolean) => {
    const saved = !!editing && has;
    const replacing = !!String(typed[name] || "");
    const noun = SECRET_NOUN[name];
    return (
      <Form.Item
        key={name}
        label={label}
        name={name}
        extra={saved ? (replacing ? `保存后替换原来的${noun}` : `留空则继续使用已保存的${noun}`) : undefined}
      >
        <Input.Password autoComplete="new-password" placeholder={saved ? "已保存" : fallback} />
      </Form.Item>
    );
  };

  const credentialItems: ReactNode[] = [];
  if (needs.includes("accessToken")) {
    credentialItems.push(secretItem(
      "accessToken",
      String(formType || "").startsWith("sub2api") ? "登录令牌（JWT）" : "访问令牌",
      "令牌 / JWT",
      !!editing?.hasAccessToken,
    ));
  }
  if (needs.includes("userId")) {
    credentialItems.push(
      <Form.Item key="userId" label="用户 ID（New-Api-User）" name="userId">
        <Input placeholder="例如 1" autoComplete="off" />
      </Form.Item>,
    );
  }
  if (needs.includes("apiKey")) credentialItems.push(secretItem("apiKey", "API 密钥", "sk-...", !!editing?.hasApiKey));
  if (needs.includes("email")) {
    credentialItems.push(
      <Form.Item key="email" label="登录邮箱" name="email">
        <Input placeholder="you@example.com" autoComplete="off" inputMode="email" />
      </Form.Item>,
    );
  }
  if (needs.includes("password")) credentialItems.push(secretItem("password", "登录密码", "站点的登录密码", !!editing?.hasPassword));

  const guidance = CONNECTION_GUIDANCE[formType] || null;
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
      forceRender
      focusable={{ focusTriggerAfterClose: false }}
      afterOpenChange={(o) => {
        if (o) return;
        const t = triggerRef.current;
        if (t && t.isConnected) t.focus();
      }}
      title={editing ? `编辑上游资源：${editing.name}` : "新增上游资源"}
      footer={
        <div className="jy-drawer-foot">
          {dirty ? (
            <span className="jy-dirty">
              <i aria-hidden="true" />
              有未保存的修改
            </span>
          ) : null}
          <span className="spacer" />
          <Button onClick={requestClose} disabled={saving}>取消</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!canSave || (!!editing && !dirty)}
            title={!canSave ? "请先测试连接" : editing && !dirty ? "还没有修改" : undefined}
            onClick={onSave}
          >
            {editing ? "保存修改" : "添加资源"}
          </Button>
        </div>
      }
    >
      <Form form={form} layout="vertical" requiredMark={false} onValuesChange={onValuesChange}>
        <fieldset className="jy-fs">
          <legend>基本信息</legend>
          <Form.Item label="名称" name="name">
            <Input placeholder="例如：主力资源" autoComplete="off" />
          </Form.Item>
          <Form.Item label="类型" name="type" extra="选择类型后会显示对应的凭证、续期与测试说明。">
            <Select options={types.map((t) => ({ value: t.value, label: t.label }))} />
          </Form.Item>
          {!isFixed && (
            <Form.Item label="站点地址" name="baseUrl">
              <Input placeholder="https://your-relay.com" autoComplete="off" inputMode="url" />
            </Form.Item>
          )}
          {formType === "newapi" && (
            <Form.Item
              name="isOwn"
              valuePropName="checked"
              extra="启用「自营业务」下游分析（分用户/分模型用量与消费预测）。需要管理员（root）账号的系统访问令牌与用户 ID。转售给他人的管理员 Key 可在「自营业务」页的「管理员转售 Key」中勾选，其消费计入转售收入。"
            >
              <SwitchRow label="这是我的自营资源" />
            </Form.Item>
          )}
          <Form.Item
            name="includeInProfit"
            valuePropName="checked"
            extra={isFixed
              ? "固定付费默认按天摊销计入利润成本；纯观察或不属于当前业务时关闭。"
              : "默认计入：即使本站不出现在 New API 渠道列表、只存在于外层 Sub2API 的内部负载均衡中，也会按用量或余额下降计入成本。仅纯观察节点或会造成重复汇总时关闭。"}
          >
            <SwitchRow label="计入利润成本" />
          </Form.Item>
        </fieldset>

        <fieldset className="jy-fs">
          <legend>连接凭证</legend>
          <p className="fs-desc">凭证保存在控制台服务端的数据库中，仅用于连接该上游查询余额和用量。</p>
          {guidance ? (
            <div className="jy-stations-guide">
              <b>{guidance.title}</b>
              <dl>
                <dt>所需凭证</dt>
                <dd>{guidance.credentials}</dd>
                <dt>地址规则</dt>
                <dd>{guidance.address}</dd>
                <dt>续期说明</dt>
                <dd>{guidance.lifecycle}</dd>
                <dt>测试行为</dt>
                <dd>{guidance.test}</dd>
              </dl>
            </div>
          ) : null}
          {credentialItems.length > 1 ? <div className="jy-two">{credentialItems}</div> : credentialItems}
          {isFixed ? (
            <div className="jy-banner jy-banner--info">
              <Sym kind="info" />
              <div className="jy-stations-banner-body">
                <b>固定成本无需测试连接</b>
                <p className="jy-caption">保存后仅按付费记录计算日均摊销，不会访问上游接口、刷新余额或触发连接类告警。</p>
              </div>
            </div>
          ) : (
            <>
              <div className="jy-test-row">
                <Button icon={<Icon name="test" />} loading={testing} onClick={onTestConnection}>
                  {connectionTest ? "重新测试连接" : "测试连接"}
                </Button>
                <StatusText level={testState.level}>{testState.label}</StatusText>
              </div>
              <div aria-live="polite">{testResult}</div>
              {testHint ? <p className="jy-caption jy-stations-hint">{testHint}</p> : null}
            </>
          )}
        </fieldset>

        <fieldset className="jy-fs">
          <legend>成本与阈值</legend>
          {!isFixed && <p className="fs-desc">留空表示不设置，不会按 0 处理。</p>}
          {!isFixed && (
            <Form.Item
              label="充值折算汇率（站点 $1 折合人民币 ¥）"
              name="cnyPerUsd"
              extra="面板金额将按此汇率折算成人民币展示；余额告警仍按站点余额判断。"
            >
              <Input placeholder="如 2 表示 $1 = ¥2，留空按 1:1" inputMode="decimal" autoComplete="off" />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item label="低余额告警阈值（按该资源的余额单位计，可留空）" name="lowBalanceUsd">
              <Input placeholder="留空则用全局阈值" inputMode="decimal" autoComplete="off" />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item
              label="成本渠道匹配别名"
              name="costAliasesText"
              extra="当自有站渠道使用容器域名、内网 IP 或代理地址时，每行填写一个渠道地址；利润计算会将它们归属到此上游。"
            >
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder={"例如：sub2api-internal\n10.0.0.8:8080"} />
            </Form.Item>
          )}
          {!isFixed && (
            <Form.Item
              name="noRenewal"
              valuePropName="checked"
              extra="余额首次低于阈值时提醒一次；之后不再发送持续低余额、余额耗尽或预计耗尽提醒。查询失败告警不受影响。"
            >
              <SwitchRow label="不再续费此资源" />
            </Form.Item>
          )}
          {isFixed && (
            <Form.Item label="固定成本付费记录（可叠加多笔）">
              {purchases.map((p, i) => (
                <div key={i} className="jy-stations-purchase" role="group" aria-label={`第 ${i + 1} 笔付费`}>
                  <Input
                    placeholder="金额（¥）"
                    aria-label={`第 ${i + 1} 笔金额（¥）`}
                    inputMode="decimal"
                    value={p.amount ?? ""}
                    onChange={(e) => updatePurchase(i, { amount: e.target.value })}
                  />
                  <Input
                    placeholder="天数"
                    aria-label={`第 ${i + 1} 笔天数`}
                    inputMode="numeric"
                    value={p.days ?? ""}
                    onChange={(e) => updatePurchase(i, { days: e.target.value })}
                  />
                  <DatePicker
                    placeholder="购买日期"
                    value={p.startDate ? dayjs(p.startDate) : null}
                    onChange={(d) => updatePurchase(i, { startDate: d ? d.format("YYYY-MM-DD") : "" })}
                  />
                  <button
                    type="button"
                    className="jy-icon-btn"
                    title="删除这笔"
                    aria-label={`删除第 ${i + 1} 笔固定成本`}
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
                追加一笔
              </Button>
              <p className="jy-caption jy-stations-hint">
                每笔 = 金额 ÷ 天数 按天摊销，从购买日起生效、到期归零；多笔重叠期间成本叠加（在现有套餐上加购/续费就追加一笔）。不访问任何接口；站点地址可留空，填主机（不带端口）可匹配该主机所有端口的渠道。
              </p>
            </Form.Item>
          )}
        </fieldset>
      </Form>
    </Drawer>
  );
}
