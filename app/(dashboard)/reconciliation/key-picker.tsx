"use client";
// 手动选 Key（不装读取服务时）：每日利润每个渠道一个「选 Key」下拉框。
// 渠道地址对得上已加的上游（或已经选过 Key）：直接选 Key；对不上：第一步先选它用的是哪个上游，第二步选这个上游的 Key，旁边有「换上游」。
// 没绑过的渠道选了 Key 就开始算（从今天 0 点），上游存进这条绑定；绑过的渠道换 Key。
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

type KeyItem = { value: number; label: string; display: string };

export function KeyPicker({ ownStationId, channel, upstreams, autoOpen = false, onChanged }: {
  ownStationId: string; channel: ChannelOption; upstreams: { id: string; name: string }[]; autoOpen?: boolean; onChanged: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const bound = channel.ruleId != null;
  // 地址对不上任何上游、又没选过的渠道，要先选上游（第一步）
  const needsUpstream = !bound && channel.suggestedUpstreamId == null;
  const [upstreamId, setUpstreamId] = useState<string | null>(channel.upstreamStationId ?? channel.suggestedUpstreamId);
  const [keys, setKeys] = useState<KeyItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const upstreamName = (id: string | null) => upstreams.find((upstream) => upstream.id === id)?.name ?? "";

  const loadKeys = useCallback(async (id: string) => {
    if (loadedFor.current === id) return;
    loadedFor.current = id;
    setLoading(true);
    setFailed(false);
    try {
      const metadata = await api(`/api/reconciliation/upstreams/${encodeURIComponent(id)}/keys`);
      const tokens: { id: number; name: string; status: number; group?: string }[] = metadata?.tokens || [];
      const unique = (name: string) => tokens.filter((token) => token.name === name).length === 1 || metadata?.platform === "sub2api";
      const where = upstreams.find((upstream) => upstream.id === id)?.name ?? "";
      setKeys(tokens.filter((token) => token.status === 1 && unique(token.name)).map((token) => ({
        value: token.id, label: [token.name, token.group ? `${KEY_PICKER.group} ${token.group}` : ""].filter(Boolean).join(" · "), display: [token.name, where].filter(Boolean).join(" · "),
      })));
    } catch {
      loadedFor.current = null;
      setKeys(null);
      setFailed(true);
    } finally { setLoading(false); }
  }, [upstreams]);

  useEffect(() => { if (autoOpen) { setOpen(true); if (upstreamId) void loadKeys(upstreamId); } }, [autoOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (tokenId: number) => {
    const picked = keys?.find((item) => item.value === tokenId);
    setSaving(true);
    try {
      const result = await api("/api/reconciliation/channels/select-key", { method: "POST", body: { ownStationId, channelId: channel.channelId, ...(bound ? {} : { upstreamStationId: upstreamId }), tokenId } });
      message.success(bound ? KEY_PICKER.changed(picked?.display.split(" · ")[0] ?? "", (result?.rekeyedDays?.length ?? 0) > 0) : KEY_PICKER.started(channel.name));
      await onChanged();
    } catch (error: any) {
      message.error(describeError({ code: error?.code, message: error?.message }).text);
    } finally { setSaving(false); }
  };

  const current = bound && channel.tokenId != null ? [{ value: channel.tokenId, label: channel.tokenName ?? String(channel.tokenId), display: [channel.tokenName ?? channel.tokenId, upstreamName(channel.upstreamStationId)].filter(Boolean).join(" · ") }] : [];
  const keyOptions = keys ?? current;
  const empty = failed || (keys != null && keys.length === 0) || !upstreams.length;

  if (needsUpstream && upstreamId == null) {
    return <span className="jy-keypicker jy-keypicker--stacked" onClick={(event) => event.stopPropagation()}>
      <Select
        size="small" className="jy-keypicker__upstream" aria-label={`${KEY_PICKER.upstreamPlaceholder}：${channel.name}`} placeholder={KEY_PICKER.upstreamPlaceholder}
        options={upstreams.map((upstream) => ({ value: upstream.id, label: upstream.name }))}
        notFoundContent={<span>{KEY_PICKER.noUpstream} <a className="jy-link" href="/stations">{KEY_PICKER.upstreamList}</a></span>}
        onChange={(id: string) => { setUpstreamId(id); void loadKeys(id); }}
      />
      <small className="jy-caption">{KEY_PICKER.addressUnmatched}</small>
    </span>;
  }
  return <span className="jy-keypicker" onClick={(event) => event.stopPropagation()}>
    {!bound && !needsUpstream ? <small className="jy-caption">{upstreamName(upstreamId)}</small> : null}
    <Select
      size="small" showSearch className="jy-keypicker__key" aria-label={`${KEY_PICKER.label}：${channel.name}`} placeholder={KEY_PICKER.placeholder} optionLabelProp="display"
      disabled={saving} loading={loading || saving} open={open} onOpenChange={(next) => { setOpen(next); if (next && upstreamId) void loadKeys(upstreamId); }}
      filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.trim().toLowerCase())}
      value={bound ? channel.tokenId ?? undefined : undefined} options={keyOptions}
      notFoundContent={loading ? KEY_PICKER.loading : failed ? KEY_PICKER.keysFailed : !upstreams.length ? <span>{KEY_PICKER.noKeysAtAll} <a className="jy-link" href="/stations">{KEY_PICKER.upstreamList}</a></span> : keys != null && keys.length === 0 ? KEY_PICKER.noKeys : KEY_PICKER.noMatch}
      onChange={(tokenId: number) => void choose(tokenId)}
    />
    {needsUpstream && !bound ? <a className="jy-link" role="button" onClick={() => { setUpstreamId(null); loadedFor.current = null; setKeys(null); }}>{KEY_PICKER.changeUpstream}</a> : null}
  </span>;
}
