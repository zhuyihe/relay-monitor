"use client";
// 手动选 Key（不装读取服务时）：每日利润每个渠道一个「选 Key」下拉框。
// 没绑过的渠道先选它用的是哪个上游、再选 Key，选了就开始算（从今天 0 点）；绑过的渠道只选 Key（换 Key）。
// Key 列表是 GET /api/reconciliation/upstreams/:id/keys（原来绑定页读 Key 的那套），写是 POST /api/reconciliation/channels/select-key。
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Select } from "antd";
import { api } from "../../../lib/client";
import { describeError } from "../../../lib/error-copy";
import { KEY_PICKER } from "./copy";

export type ChannelOption = {
  channelId: number; name: string; ruleId: string | null; upstreamStationId: string | null; tokenId: number | null; tokenName: string | null; suggestedUpstreamId: string | null;
};
export type ChannelOptions = { ok: true; channels: ChannelOption[]; upstreams: { id: string; name: string }[] } | { ok: false; code: string };

// 自营站点的渠道和它们现在选的 Key；选完以后 reload 重读
export function useChannelOptions(ownStationId: string | null | undefined) {
  const [options, setOptions] = useState<ChannelOptions | null>(null);
  const reload = useCallback(async () => {
    if (!ownStationId) { setOptions(null); return; }
    try { setOptions(await api(`/api/reconciliation/channels/options?ownStationId=${encodeURIComponent(ownStationId)}`)); } catch { setOptions(null); }
  }, [ownStationId]);
  useEffect(() => { void reload(); }, [reload]);
  return { options, reload };
}

type KeyItem = { value: number; label: string };

export function KeyPicker({ ownStationId, channel, upstreams, autoOpen = false, onChanged }: {
  ownStationId: string; channel: ChannelOption; upstreams: { id: string; name: string }[]; autoOpen?: boolean; onChanged: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const [upstreamId, setUpstreamId] = useState<string | null>(channel.upstreamStationId ?? channel.suggestedUpstreamId);
  const [keys, setKeys] = useState<KeyItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const bound = channel.ruleId != null;

  const loadKeys = useCallback(async (id: string) => {
    if (loadedFor.current === id) return;
    loadedFor.current = id;
    setLoading(true);
    try {
      const metadata = await api(`/api/reconciliation/upstreams/${encodeURIComponent(id)}/keys`);
      const tokens: { id: number; name: string; status: number }[] = metadata?.tokens || [];
      const unique = (name: string) => tokens.filter((token) => token.name === name).length === 1 || metadata?.platform === "sub2api";
      setKeys(tokens.filter((token) => token.status === 1 && unique(token.name)).map((token) => ({ value: token.id, label: token.name })));
    } catch {
      loadedFor.current = null;
      setKeys(null);
      message.warning(KEY_PICKER.keysFailed);
    } finally { setLoading(false); }
  }, [message]);

  useEffect(() => { if (autoOpen) { setOpen(true); if (upstreamId) void loadKeys(upstreamId); } }, [autoOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (tokenId: number) => {
    setSaving(true);
    try {
      await api("/api/reconciliation/channels/select-key", { method: "POST", body: { ownStationId, channelId: channel.channelId, ...(bound ? {} : { upstreamStationId: upstreamId }), tokenId } });
      message.success(KEY_PICKER.saved);
      await onChanged();
    } catch (error: any) {
      message.error(describeError({ code: error?.code, message: error?.message }).text);
    } finally { setSaving(false); }
  };

  const keyOptions = keys ?? (bound && channel.tokenId != null ? [{ value: channel.tokenId, label: channel.tokenName ?? String(channel.tokenId) }] : []);
  return <span className="jy-keypicker" onClick={(event) => event.stopPropagation()}>
    {!bound ? <Select
      size="small" className="jy-keypicker__upstream" aria-label={KEY_PICKER.upstreamPlaceholder} placeholder={KEY_PICKER.upstreamPlaceholder}
      value={upstreamId ?? undefined} options={upstreams.map((upstream) => ({ value: upstream.id, label: upstream.name }))}
      notFoundContent={KEY_PICKER.noUpstream}
      onChange={(id: string) => { setUpstreamId(id); loadedFor.current = null; setKeys(null); void loadKeys(id); }}
    /> : null}
    <Select
      size="small" className="jy-keypicker__key" aria-label={`${KEY_PICKER.label}：${channel.name}`} placeholder={KEY_PICKER.placeholder}
      disabled={!bound && !upstreamId} loading={loading || saving} open={open} onOpenChange={(next) => { setOpen(next); if (next && upstreamId) void loadKeys(upstreamId); }}
      value={bound ? channel.tokenId ?? undefined : undefined} options={keyOptions} notFoundContent={loading ? KEY_PICKER.loading : KEY_PICKER.noKeys}
      onChange={(tokenId: number) => void choose(tokenId)}
    />
  </span>;
}
