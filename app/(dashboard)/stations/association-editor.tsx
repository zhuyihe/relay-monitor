"use client";
// 上游账单 · 改绑定：改一条绑定里的渠道和「这把 Key 还给别处用吗？」的回答。沿用「预览 → 改绑定」两步
// （POST /api/reconciliation/rules/{id}/preview + PUT）。上游账号、Key 与时区是绑定本身，只读显示；
// 保存后立即按新设置算，今天的部分重算，已固定的日子不变（design/ui-copy-spec.md §4）。
import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Form, Select, Space, Typography } from "antd";
import { api } from "../../../lib/client";
import type { RuleEditPreview } from "../../../lib/client";
import { BINDING_COPY } from "../../../lib/channel-onboarding.js";
import { describeError, failureText } from "../../../lib/error-copy.js";
import { EMPTY, formatDayZone, refreshFailedText } from "../../../lib/format";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, coverageAnswerOption, coverageDeclarationOf, reconciliationIssue } from "../../../lib/reconciliation-contract.js";
import { reconciliationChannelName, reconciliationChannelTag, reconciliationKeyNamer } from "../../../lib/reconciliation-view.js";
import { HISTORY_KEPT, workflowActionMeta } from "../../../lib/workflow-actions.js";
import { Skeleton } from "../../components/data-state";
import { useDrawerEscape } from "../../components/drawer-escape";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import type { ErrorNote } from "../../components/error-detail";

const { Text } = Typography;

// seq 由打开方每次递增：同一条绑定再次打开时也重新读取、重置表单；fixedCost 表示上游是包月等固定成本（上游成本记 0）
export type AssociationEditTarget = { ruleId: string; title: string; seq: number; fixedCost?: boolean };

const EDIT = workflowActionMeta("edit_binding")!;
const REFRESH = workflowActionMeta("refresh")!.label;
const COVERAGE = reconciliationIssue("COST_COVERAGE_UNKNOWN");
// 改绑定独有的话，只在这一处写；用语按 design/ui-copy-spec.md
const COPY = Object.freeze({
  loadFailed: "读不到这条绑定",
  notRead: "还没读取",
  occupiedOriginal: (key: string) => `已绑了别的 Key：${key}，去掉一条`,
  occupied: (key: string) => `已绑了别的 Key：${key}`,
  fixedFields: "上游账号、Key 和时区不在这里改",
  swapHint: `要换一把 Key，用「${workflowActionMeta("swap_key")!.label}」；${HISTORY_KEPT}。`,
  channels: "渠道",
  channelsExtra: "同一个渠道的收入只能算一次",
  channelsPlaceholder: "选一个或多个渠道",
  removedHint: `去掉的渠道如果还在用这把 Key，请在上面选「${COVERAGE_ANSWERS.find((item) => item.value === "own_channels")!.label}」，不然上游成本会算多。`,
  howTitle: "怎么算的",
  how: "这把 Key 的全部上游成本，减去所选渠道的全部收入。",
  previewTitle: "预览，还没保存",
  before: "原来的渠道",
  after: "改后的渠道",
  removed: "去掉的渠道",
  recalc: "今天按新设置重算；以前还没固定的日子先按原设置固定，不受影响。",
});

// 回答在 COVERAGE_ANSWERS 里的那一项；没回答过的按成本是否算全推断（和服务端 normalizeRuleSourceBinding 一致）
function initialValues(rule: any) {
  const declaration = rule.coverageDeclaration || {};
  const fallback = declaration.answer === "other_use" ? "unspecified" : rule.costCoverage === "complete" ? "none" : "unknown";
  const coverage = (coverageAnswerOption(declaration) || COVERAGE_ANSWERS.find((item) => item.value === fallback))!.value;
  const uncoveredOwnChannelIds = coverage === "own_channels"
    ? [...new Set<number>((declaration.uncoveredOwnChannelIds || []).map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
    : [];
  return { salesChannelIds: (rule.channels || []).map((channel: any) => Number(channel.channelId)).sort((a: number, b: number) => a - b), coverage, uncoveredOwnChannelIds };
}

export function AssociationEditor({ target, compact, businessTz, onClose, onSaved }: {
  target: AssociationEditTarget | null;
  compact: boolean;
  // 业务时区：「数据截至」按它写
  businessTz?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  useDrawerEscape(!!target && !busy, onClose);
  return (
    <Drawer
      className="jy-drawer"
      title={target ? `${EDIT.label} · ${target.title}` : EDIT.label}
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
          fixedCost={!!target.fixedCost}
          businessTz={businessTz}
          onBusyChange={setBusy}
          onDone={() => { setBusy(false); onClose(); void onSaved().catch(() => {}); }}
        />
      ) : null}
    </Drawer>
  );
}

// 每次打开都是新的表单实例，不会带出上一次未保存的选择
function AssociationEditorBody({ ruleId, fixedCost, businessTz, onBusyChange, onDone }: { ruleId: string; fixedCost: boolean; businessTz?: string; onBusyChange: (busy: boolean) => void; onDone: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const coverage = Form.useWatch("coverage", form);
  const salesChannelIds: number[] | undefined = Form.useWatch("salesChannelIds", form);
  const [config, setConfig] = useState<any>(null);
  const [rule, setRule] = useState<any>(null);
  const [loadError, setLoadError] = useState<ErrorNote | null>(null);
  // 渠道列表上次读到的时间（浏览器时钟）；刷新失败时写「刷新失败，数据截至 14:30。」
  const [channelsAsOf, setChannelsAsOf] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<RuleEditPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<ErrorNote | null>(null);
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
        if (!found) { setLoadError({ text: describeError({ code: "RULE_NOT_FOUND" }).text }); return; }
        setRule(found);
      }
      if (!next.channelsError) setChannelsAsOf(Date.now());
      // 渠道列表刷新失败时保留上次读到的列表；channelsError 是固定说法，只进「查看详细原因」，按 channelsErrorCode 归类
      setConfig((previous: any) => next.channelsError && previous ? { ...next, channels: previous.channels } : next);
    } catch (err: any) {
      if (current !== loadEpoch.current) return;
      if (initial) setLoadError({ text: failureText(COPY.loadFailed, err), raw: describeError(err).raw });
      else setConfig((previous: any) => previous ? { ...previous, channelsError: err } : previous);
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
    coverageDeclaration: coverageDeclarationOf(values.coverage || "unknown", values.uncoveredOwnChannelIds || [])!,
  });
  const previewEdit = async () => {
    setFormError(null);
    try {
      const values = await form.validateFields(), current = ++previewEpoch.current;
      setPreviewing(true);
      const next: RuleEditPreview = await api(`/api/reconciliation/rules/${encodeURIComponent(ruleId)}/preview`, { body: input(values) });
      if (current === previewEpoch.current) setPreview(next);
    } catch (err: any) { if (!err.errorFields) setFormError(noteOf(err)); setPreview(null); }
    finally { setPreviewing(false); }
  };
  const save = async (values: any) => {
    if (!preview || Date.now() >= preview.expiresAtMs) { setPreview(null); setFormError({ text: describeError({ code: "PREVIEW_REQUIRED" }).text }); return; }
    setSaving(true); setFormError(null);
    try {
      await api(`/api/reconciliation/rules/${encodeURIComponent(ruleId)}`, { method: "PUT", body: { ...input(values), previewId: preview.previewId, groupId: preview.groupId } });
    } catch (err: any) {
      setFormError({ text: failureText("保存失败", err), raw: describeError(err).raw }); setPreview(null); setSaving(false);
      return;
    }
    // 已保存：之后上游账单重读失败不能再报成保存失败
    message.success(EDIT.done);
    setSaving(false);
    onDone();
  };

  if (loadError) {
    return <Alert type="warning" showIcon title={loadError.text} description={loadError.raw ? <ErrorDetail raw={loadError.raw} /> : undefined}
      action={<Button size="small" loading={refreshing} onClick={() => { setLoadError(null); void load(true); }}>{REFRESH}</Button>} />;
  }
  if (!rule) {
    return <div aria-busy="true" style={{ display: "grid", gap: 12 }}><Skeleton height={56} /><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} width="60%" /></div>;
  }

  const original: number[] = (rule.channels || []).map((channel: any) => Number(channel.channelId));
  // 与服务端一致：别的有效绑定已经用了的渠道不能再选。原来就重复绑定的渠道保持可去掉，并提示去掉一条
  // 在用的绑定一起比 Key 名，同名的都加上编号（§3.1）
  const keyName = reconciliationKeyNamer((config?.rules || []).filter((item: any) => item.enabled && !item.archivedAt));
  const occupied = new Map<number, string>();
  for (const other of config?.rules || []) {
    if (!other.enabled || other.archivedAt || other.id === rule.id) continue;
    for (const channel of other.channels || []) occupied.set(Number(channel.channelId), keyName(other));
  }
  const occupiedNote = (id: number) => {
    const occupiedBy = occupied.get(id);
    if (!occupiedBy) return "";
    return `（${original.includes(id) ? COPY.occupiedOriginal(occupiedBy) : COPY.occupied(occupiedBy)}）`;
  };
  const directory: any[] = config?.channels || [];
  const unread = !!config?.channelsError && !directory.length;
  // 渠道列表读不到的原因：接口给的是固定说法加 code；这次刷新本身失败时是那个报错
  const channelsFailure = typeof config?.channelsError === "string" ? { code: config.channelsErrorCode, error: config.channelsError } : config?.channelsError;
  const missing = (rule.channels || []).filter((channel: any) => !directory.some((entry: any) => Number(entry.id) === Number(channel.channelId)));
  const options = [
    ...directory.map((channel: any) => {
      const id = Number(channel.id);
      return { value: id, disabled: occupied.has(id) && !original.includes(id), label: `${reconciliationChannelName(channel)}${occupiedNote(id)}` };
    }),
    // 列表里找不到的原渠道仍显示，可去掉；列表没读到时不能断言它已删除
    ...missing.map((channel: any) => ({ value: Number(channel.channelId),
      label: `${reconciliationChannelName(channel)}${occupiedNote(Number(channel.channelId)) || `（${unread ? COPY.notRead : reconciliationChannelTag({ missing: true })}）`}` })),
  ];
  const nameOf = (id: number) => {
    const channel = directory.find((entry: any) => Number(entry.id) === id) || (rule.channels || []).find((entry: any) => Number(entry.channelId) === id);
    return reconciliationChannelName(channel || { id });
  };
  const names = (ids: number[]) => ids.map(nameOf).join("、") || EMPTY;
  const upstream = (config?.upstreams || []).find((station: any) => station.id === rule.upstreamStationId);
  const dayZone = formatDayZone(rule.timezone);
  const removed = original.filter((id) => !(salesChannelIds || original).includes(id));
  const busy = previewing || saving;
  const refreshButton = <Button size="small" loading={refreshing} onClick={() => void load(false)}>{REFRESH}</Button>;

  return (
    <Form
      name="association-editor"
      form={form}
      layout="vertical"
      requiredMark={false}
      disabled={busy}
      initialValues={initialValues(rule)}
      onFinish={save}
      onValuesChange={() => { previewEpoch.current += 1; setPreview(null); setFormError(null); }}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
        <dl className="jy-accounts-facts">
          <dt>上游</dt><dd>{upstream?.name || EMPTY}</dd>
          <dt>Key</dt><dd>{keyName(rule)}</dd>
          {dayZone ? <><dt>时区</dt><dd>{dayZone}</dd></> : null}
        </dl>
        <Alert type="info" showIcon title={COPY.fixedFields} description={COPY.swapHint} />
        <div>
          <Form.Item
            label={COPY.channels}
            name="salesChannelIds"
            extra={<span>{COPY.channelsExtra}<Button type="link" size="small" loading={refreshing} onClick={() => void load(false)}>{REFRESH}</Button></span>}
            rules={[{ required: true, type: "array", min: 1, message: BINDING_COPY.channelRequired }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              mode="multiple"
              loading={refreshing}
              placeholder={COPY.channelsPlaceholder}
              options={options}
              getPopupContainer={(trigger) => trigger.parentElement || document.body}
            />
          </Form.Item>
          {config?.channelsError ? (
            <Alert type="warning" showIcon
              title={directory.length && channelsAsOf ? refreshFailedText(channelsAsOf, businessTz) : failureText(BINDING_COPY.channelsUnreadable, channelsFailure)}
              description={<ErrorDetail raw={describeError(channelsFailure).raw} />} action={refreshButton} />
          ) : null}
        </div>
        <div>
          <Form.Item label={COVERAGE_QUESTION} name="coverage">
            <Select aria-label={COVERAGE_QUESTION} options={COVERAGE_ANSWERS.map(({ value, label }) => ({ value, label }))} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
          </Form.Item>
          {coverage === "own_channels" ? (
            <Form.Item label={BINDING_COPY.uncoveredChannels} name="uncoveredOwnChannelIds">
              <Select mode="multiple" options={directory.map((channel: any) => ({ value: Number(channel.id), label: reconciliationChannelName(channel) }))} getPopupContainer={(trigger) => trigger.parentElement || document.body} />
            </Form.Item>
          ) : null}
          {coverage && coverage !== "none"
            ? <Text type="secondary">{COVERAGE.detail}</Text>
            : removed.length ? <Text type="secondary">{COPY.removedHint}</Text> : null}
        </div>
        <Alert type="info" showIcon title={COPY.howTitle} description={COPY.how} />
        {formError ? <Alert type="error" showIcon title={formError.text} description={formError.raw ? <ErrorDetail raw={formError.raw} /> : undefined} /> : null}
        <Button style={{ minHeight: 44 }} loading={previewing} disabled={saving} onClick={() => void previewEdit()} aria-label={BINDING_COPY.preview}>{BINDING_COPY.preview}</Button>
        {preview ? (
          <Alert
            type="info"
            showIcon
            title={COPY.previewTitle}
            description={
              <Space orientation="vertical">
                <Text>{COPY.before}：{names(preview.basis.existingChannelIds)}</Text>
                <Text>{COPY.after}：{names(preview.basis.proposedChannelIds)}</Text>
                <Text>{COPY.removed}：{names(preview.basis.existingChannelIds.filter((id) => !preview.basis.proposedChannelIds.includes(id)))}；{HISTORY_KEPT}。</Text>
                <Text>{COPY.recalc}</Text>
                {preview.preview.costCoverage === "complete"
                  ? <Text>{coverageAnswerOption({ answer: "none" })!.label}</Text>
                  // 包月等固定成本的上游，上游侧的问题不显示（§5.4）
                  : fixedCost ? null : <Text>{COVERAGE.title}{COVERAGE.detail}</Text>}
              </Space>
            }
          />
        ) : null}
        {preview ? <Button type="primary" htmlType="submit" style={{ minHeight: 44 }} loading={saving} disabled={previewing} aria-label={EDIT.label}>{EDIT.label}</Button> : null}
      </Space>
    </Form>
  );
}
