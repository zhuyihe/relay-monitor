"use client";
// 上游账单 · 编辑一条核算关联的本站渠道与 Key 用途。从账单核算页搬来，沿用「预览 → 确认」两步
// （POST /api/reconciliation/rules/{id}/preview + PUT）。上游账号、Key 与账单时区是关联身份，只读显示；
// 确认后立即生效，今天未结账的部分按新配置重算，已结账的日子不变。
import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Form, Select, Space, Typography } from "antd";
import { api } from "../../../lib/client";
import type { CoverageDeclaration, RuleEditPreview } from "../../../lib/client";
import { useDrawerEscape } from "../../components/drawer-escape";

const { Text } = Typography;

// seq 由打开方每次递增：同一条关联再次打开时也重新读取、重置表单
export type AssociationEditTarget = { ruleId: string; title: string; seq: number };

const ANSWERS = ["none", "other_use", "unknown"];
const OTHER_USES = ["own_channels", "external", "unspecified"];

function channelLabel(channel: any) {
  const id = channel.channelId ?? channel.id;
  return `${channel.name || `渠道 ${id ?? "—"}`} · ID ${id ?? "—"}`;
}

function formatTime(value: number | null | undefined, timezone?: string) {
  if (value == null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone || "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

// 与服务端 normalizeRuleSourceBinding 同口径：未声明时按成本覆盖推断（完整 → 没有其他用途）
function initialValues(rule: any) {
  const declaration = rule.coverageDeclaration || {};
  const coverageAnswer = ANSWERS.includes(declaration.answer) ? declaration.answer : rule.costCoverage === "complete" ? "none" : "unknown";
  const otherUse = coverageAnswer === "other_use" ? OTHER_USES.includes(declaration.otherUse) ? declaration.otherUse : "unspecified" : undefined;
  const uncoveredOwnChannelIds = otherUse === "own_channels"
    ? [...new Set<number>((declaration.uncoveredOwnChannelIds || []).map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
    : [];
  return { salesChannelIds: (rule.channels || []).map((channel: any) => Number(channel.channelId)).sort((a: number, b: number) => a - b), coverageAnswer, otherUse, uncoveredOwnChannelIds };
}

export function AssociationEditor({ target, compact, onClose, onSaved }: {
  target: AssociationEditTarget | null;
  compact: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  useDrawerEscape(!!target && !busy, onClose);
  return (
    <Drawer
      className="jy-drawer"
      title={target ? `编辑渠道 · ${target.title}` : "编辑渠道"}
      open={!!target}
      size={compact ? "100%" : 560}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={false}
      destroyOnHidden
      onClose={() => { if (!busy) onClose(); }}
    >
      {target ? (
        <AssociationEditorBody
          key={`${target.ruleId}:${target.seq}`}
          ruleId={target.ruleId}
          onBusyChange={setBusy}
          onDone={() => { setBusy(false); onClose(); void onSaved().catch(() => {}); }}
        />
      ) : null}
    </Drawer>
  );
}

// 每次打开都是新的表单实例，不会带出上一次未保存的选择
function AssociationEditorBody({ ruleId, onBusyChange, onDone }: { ruleId: string; onBusyChange: (busy: boolean) => void; onDone: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const coverageAnswer = Form.useWatch("coverageAnswer", form);
  const otherUse = Form.useWatch("otherUse", form);
  const salesChannelIds: number[] | undefined = Form.useWatch("salesChannelIds", form);
  const [config, setConfig] = useState<any>(null);
  const [rule, setRule] = useState<any>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<RuleEditPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const previewEpoch = useRef(0);
  const loadEpoch = useRef(0);

  const load = async (initial: boolean) => {
    const current = ++loadEpoch.current;
    setRefreshing(true);
    try {
      const next = await api("/api/reconciliation/configuration?refreshChannels=true");
      if (current !== loadEpoch.current) return;
      if (initial) {
        const found = (next.rules || []).find((item: any) => item.id === ruleId && item.enabled && !item.archivedAt);
        if (!found) { setLoadError("此核算关联已停止或不存在，请刷新上游账单后重新打开。"); return; }
        setRule(found);
      }
      // 渠道目录刷新失败时保留上次读到的目录
      setConfig((previous: any) => next.channelsError && previous ? { ...next, channels: previous.channels } : next);
    } catch (err: any) {
      if (current !== loadEpoch.current) return;
      if (initial) setLoadError(err.message || "核算关联读取失败，请重试");
      else setConfig((previous: any) => previous ? { ...previous, channelsError: "本站渠道刷新失败，请稍后重试" } : previous);
    } finally {
      if (current === loadEpoch.current) setRefreshing(false);
    }
  };
  useEffect(() => {
    void load(true);
    return () => { loadEpoch.current += 1; previewEpoch.current += 1; };
  // 只在打开时读取一次；刷新渠道走按钮
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { onBusyChange(previewing || saving); }, [previewing, saving, onBusyChange]);

  const input = (values: any) => ({
    upstreamStationId: rule.upstreamStationId, tokenId: Number(rule.tokenId),
    salesChannelIds: values.salesChannelIds.map(Number), timezone: rule.timezone,
    coverageDeclaration: {
      answer: values.coverageAnswer || "unknown",
      otherUse: values.coverageAnswer === "other_use" ? values.otherUse || "unspecified" : null,
      uncoveredOwnChannelIds: values.coverageAnswer === "other_use" && values.otherUse === "own_channels" ? (values.uncoveredOwnChannelIds || []).map(Number) : [],
    } as CoverageDeclaration,
  });
  const previewEdit = async () => {
    setFormError("");
    try {
      const values = await form.validateFields(), current = ++previewEpoch.current;
      setPreviewing(true);
      const next: RuleEditPreview = await api(`/api/reconciliation/rules/${encodeURIComponent(ruleId)}/preview`, { body: input(values) });
      if (current === previewEpoch.current) setPreview(next);
    } catch (err: any) { if (!err.errorFields) setFormError(err.message || "预览失败，请重试"); setPreview(null); }
    finally { setPreviewing(false); }
  };
  const save = async (values: any) => {
    if (!preview || Date.now() >= preview.expiresAtMs) { setPreview(null); setFormError("预览已失效，请重新预览修改"); return; }
    setSaving(true); setFormError("");
    try {
      await api(`/api/reconciliation/rules/${encodeURIComponent(ruleId)}`, { method: "PUT", body: { ...input(values), previewId: preview.previewId, groupId: preview.groupId } });
    } catch (err: any) {
      setFormError(err?.message || "保存失败，请重新预览"); setPreview(null); setSaving(false);
      return;
    }
    // 已保存：之后上游账单重读失败不能再报成保存失败
    message.success("核算关联已更新");
    setSaving(false);
    onDone();
  };

  if (loadError) {
    return <Alert type="warning" showIcon message={loadError} action={<Button size="small" loading={refreshing} onClick={() => { setLoadError(""); void load(true); }}>重试</Button>} />;
  }
  if (!rule) return <Text type="secondary">正在读取核算关联…</Text>;

  const original: number[] = (rule.channels || []).map((channel: any) => Number(channel.channelId));
  // 与服务端同口径：任何其他有效关联已认领的渠道都不能再选。原来就重复认领的渠道保持可移除，并提示需要移除
  const occupied = new Map<number, string>();
  for (const other of config?.rules || []) {
    if (!other.enabled || other.archivedAt || other.id === rule.id) continue;
    for (const channel of other.channels || []) occupied.set(Number(channel.channelId), other.tokenName || other.id);
  }
  const occupiedNote = (id: number) => {
    const occupiedBy = occupied.get(id);
    if (!occupiedBy) return "";
    return original.includes(id) ? `（与 ${occupiedBy} 重复，需移除）` : `（已用于 ${occupiedBy}）`;
  };
  const directory: any[] = config?.channels || [];
  const options = [
    ...directory.map((channel: any) => {
      const id = Number(channel.id);
      return { value: id, disabled: occupied.has(id) && !original.includes(id), label: `${channelLabel(channel)}${occupiedNote(id)}` };
    }),
    // 目录里找不到的原渠道仍显示，可移除；目录没读到时不能断言它已缺失
    ...(rule.channels || []).filter((channel: any) => !directory.some((entry: any) => Number(entry.id) === Number(channel.channelId)))
      .map((channel: any) => ({ value: Number(channel.channelId),
        label: `${channelLabel(channel)}${occupiedNote(Number(channel.channelId)) || (config?.channelsError && !directory.length ? "（目录未读取）" : "（目录中已缺失）")}` })),
  ];
  const upstream = (config?.upstreams || []).find((station: any) => station.id === rule.upstreamStationId);
  const removed = original.filter((id) => !(salesChannelIds || original).includes(id));
  const busy = previewing || saving;

  return (
    <Form
      name="association-editor"
      form={form}
      layout="vertical"
      requiredMark={false}
      disabled={busy}
      initialValues={initialValues(rule)}
      onFinish={save}
      onValuesChange={() => { previewEpoch.current += 1; setPreview(null); setFormError(""); }}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
        <dl className="jy-accounts-facts">
          <dt>上游资源</dt><dd>{upstream?.name || rule.upstreamStationId}</dd>
          <dt>Key</dt><dd>{rule.tokenName || `Key ${rule.tokenId}`} · #{rule.tokenId}</dd>
          <dt>账单时区</dt><dd>{rule.timezone || "Asia/Shanghai"}</dd>
        </dl>
        <Alert type="info" showIcon message="上游账号、Key 与账单时区不在这里修改" description="需要换一把 Key 时，用「更换 Key」重新接入；这条关联的历史账单保留。" />
        <div>
          <Form.Item
            label="本站销售渠道"
            name="salesChannelIds"
            extra={<span>一个渠道同一时刻只能归属一条有效的核算关联。<Button type="link" size="small" loading={refreshing} onClick={() => void load(false)}>刷新渠道</Button></span>}
            rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个本站渠道" }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              mode="multiple"
              loading={refreshing}
              placeholder="选择一个或多个渠道"
              options={options}
              getPopupContainer={(trigger) => trigger.parentElement || document.body}
            />
          </Form.Item>
          {config?.channelsError ? <Alert type="warning" showIcon message={config.channelsError} action={<Button size="small" loading={refreshing} onClick={() => void load(false)}>刷新渠道</Button>} /> : null}
        </div>
        <div>
          <Form.Item label="除以上渠道外，这把 Key 是否还用于本站其他渠道或站外调用？" name="coverageAnswer">
            <Select aria-label="Key 的其他用途" options={[{ value: "none", label: "没有" }, { value: "other_use", label: "有" }, { value: "unknown", label: "不确定" }]} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          {coverageAnswer === "other_use" ? (
            <Form.Item label="其他用途" name="otherUse">
              <Select options={[{ value: "own_channels", label: "本站其他渠道" }, { value: "external", label: "站外调用" }, { value: "unspecified", label: "尚未明确" }]} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
            </Form.Item>
          ) : null}
          {coverageAnswer === "other_use" && otherUse === "own_channels" ? (
            <Form.Item label="尚未纳入的本站渠道" name="uncoveredOwnChannelIds">
              <Select mode="multiple" options={directory.map((channel: any) => ({ value: Number(channel.id), label: channelLabel(channel) }))} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
            </Form.Item>
          ) : null}
          {coverageAnswer && coverageAnswer !== "none"
            ? <Text type="secondary">收费与成本照常显示，毛利标为待确认。{otherUse === "external" ? "请把站外调用换成单独的 Key 后重新关联。" : "移除渠道后仍使用这把 Key 的渠道也需在其他用途中说明。"}</Text>
            : removed.length ? <Text type="secondary">移除的渠道如果仍在使用这把 Key，请在上方选「有」并说明，否则它们的消耗会算进这条关联的成本。</Text> : null}
        </div>
        <Alert type="info" showIcon message="核算口径" description="这条关联汇总这把 Key 的全部上游成本与所选渠道的全部收费。渠道明细只展示收费占比，不分摊成本。" />
        {formError ? <Alert type="error" showIcon message={formError} /> : null}
        <Button style={{ minHeight: 44 }} loading={previewing} disabled={saving} onClick={() => void previewEdit()} aria-label="预览核算关联修改">预览修改</Button>
        {preview ? (
          <Alert
            type="info"
            showIcon
            message="修改预览，尚未保存"
            description={
              <Space orientation="vertical">
                <Text>原渠道：{preview.basis.existingChannelIds.map((id) => `#${id}`).join("、") || "无"}</Text>
                <Text>最终渠道：{preview.basis.proposedChannelIds.map((id) => `#${id}`).join("、")}</Text>
                <Text>释放渠道：{preview.basis.existingChannelIds.filter((id) => !preview.basis.proposedChannelIds.includes(id)).map((id) => `#${id}`).join("、") || "无"}；原账单保留。</Text>
                <Text>{preview.preview.scopeChanged ? "确认后立即生效；今天尚未结账的部分按新配置重算，已结账的日子不变。" : `生效时间：${formatTime(preview.preview.billingEffectiveFromMs, preview.basis.timezone)}（${preview.basis.timezone}），范围未变化。`}</Text>
                <Text>{preview.preview.costCoverage === "complete" ? "已声明这把 Key 没有其他用途" : "Key 用途待确认，金额作为参考"}</Text>
              </Space>
            }
          />
        ) : null}
        {preview ? <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={saving} disabled={previewing} aria-label="确认修改核算关联">确认修改</Button> : null}
      </Space>
    </Form>
  );
}
