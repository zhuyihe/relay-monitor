"use client";
// 上游下面的渠道：右边抽屉（渠道、Key、绑定日期、解绑）+「绑定渠道」「解绑」两个小窗口。上游资源只管绑定、解绑，和利润没有关系；每日利润只管算钱、绑了就自动算。
// 数据只有一个读：GET /api/reconciliation/channels/options（渠道、绑在哪个上游、哪把 Key、从哪天绑的）；Key 列表是 GET /api/reconciliation/upstreams/:id/keys（现有的 5 分钟缓存，不强制刷新）。
// 写：POST /api/reconciliation/channels/select-key（绑定）和 /stop（解绑）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Drawer, Grid, Input, Modal, Radio, Select } from "antd";
import { api } from "../../../lib/client";
import { describeError } from "../../../lib/error-copy";
import { formatDayKey } from "../../../lib/format";
import { bindableKeys, channelChoices, defaultChannelId } from "../../../lib/channel-binding.js";
import { CHANNEL_BINDING } from "../../../lib/channel-binding-text";
import { Icon, Sym } from "../../components/icons";
import { useDrawerEscape } from "../../components/drawer-escape";

export type ChannelOption = {
  channelId: number; name: string; address: string; enabled: boolean; ruleId: string | null; upstreamStationId: string | null; tokenId: number | null; tokenName: string | null;
  tokenGroup: string | null; sinceDay: string | null; suggestedUpstreamId: string | null;
};
export type ChannelOptions = { ok: true; channels: ChannelOption[]; upstreams: { id: string; name: string }[] } | { ok: false; code: string };

export function useChannelOptions(ownStationId: string | null | undefined) {
  const [options, setOptions] = useState<ChannelOptions | null>(null);
  const reload = useCallback(async () => {
    if (!ownStationId) { setOptions(null); return; }
    try { setOptions(await api(`/api/reconciliation/channels/options?ownStationId=${encodeURIComponent(ownStationId)}`)); } catch { setOptions(null); }
  }, [ownStationId]);
  useEffect(() => { void reload(); }, [reload]);
  return { options, reload };
}

export type Upstream = { id: string; name: string; address?: string };

// 右边抽屉：这个上游下挂着的渠道
export function ChannelsDrawer({ upstream, channels, tz, onClose, onBind, onUnbind }: {
  upstream: Upstream | null; channels: ChannelOption[]; tz: string; onClose: () => void; onBind: () => void; onUnbind: (channel: ChannelOption) => void;
}) {
  const screens = Grid.useBreakpoint();
  const mine = useMemo(() => channels.filter((item) => item.upstreamStationId === upstream?.id).sort((a, b) => String(a.sinceDay).localeCompare(String(b.sinceDay)) || a.channelId - b.channelId), [channels, upstream]);
  useDrawerEscape(!!upstream, onClose);
  const C = CHANNEL_BINDING;
  return <Drawer
    className="jy-drawer jy-channels-drawer" placement="right" size={screens.md === false ? "100%" : 720} open={!!upstream} onClose={onClose} keyboard={false} destroyOnHidden
    title={upstream ? <>{C.drawerTitle(upstream.name)} <span className="jy-caption">{mine.length}</span></> : null}
  >
    <div className="jy-channels-top"><Button size="small" onClick={onBind}>{`＋ ${C.bindButton}`}</Button></div>
    {!mine.length ? <p className="jy-caption jy-channels-empty">{C.empty}</p> : (
      <div className="jy-table-wrap">
        <table className="jy-data jy-channels-table">
          <thead><tr><th scope="col">{C.cols.channel}</th><th scope="col">{C.cols.key}</th><th scope="col">{C.cols.since}</th><th scope="col" className="r">{C.cols.actions}</th></tr></thead>
          <tbody>
            {mine.map((channel) => <tr key={channel.channelId}>
              <td>{channel.name}</td>
              <td>{channel.tokenName ? C.keyOf(channel.tokenName, channel.tokenGroup) : ""}</td>
              <td>{channel.sinceDay ? formatDayKey(channel.sinceDay, tz) : ""}</td>
              <td className="r"><Button type="link" size="small" aria-label={`${C.unbind} ${channel.name}`} onClick={() => onUnbind(channel)}>{C.unbind}</Button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    )}
  </Drawer>;
}

// 「绑定渠道」：搜索框 + 固定高的渠道列表（你站上还没绑的；地址对得上这个上游的一组在前；已禁用的默认不列）+ Key 下拉（这个上游里还能绑的；只剩一把时替用户选好）
export function BindChannelModal({ upstream, ownStationId, options, onClose, onDone }: {
  upstream: Upstream | null; ownStationId: string; options: ChannelOptions | null; onClose: () => void; onDone: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const channels = options?.ok ? options.channels : [];
  const [channelId, setChannelId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const [tokenId, setTokenId] = useState<number | null>(null);
  const [keys, setKeys] = useState<{ value: number; label: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hint, setHint] = useState(false);
  const [saving, setSaving] = useState(false);
  const M = CHANNEL_BINDING.bindModal;
  const choices = useMemo(() => (upstream ? channelChoices(channels, upstream.id, { query, showDisabled }) : null), [channels, upstream, query, showDisabled]);

  useEffect(() => { // 每次打开：只有一个启用的渠道对得上才替用户选好
    if (!upstream) return;
    setChannelId(defaultChannelId(channels, upstream.id)); setQuery(""); setShowDisabled(false); setTokenId(null); setKeys(null); setFailed(false); setHint(false); setSaving(false);
  }, [upstream?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!upstream) return;
    let alive = true;
    api(`/api/reconciliation/upstreams/${encodeURIComponent(upstream.id)}/keys`).then((metadata: any) => {
      if (!alive) return;
      const used = channels.filter((item) => item.upstreamStationId === upstream.id && item.tokenId != null).map((item) => Number(item.tokenId));
      const usable = bindableKeys(metadata?.tokens, used, { platform: metadata?.platform });
      const items = usable.map((token: any) => ({ value: token.id as number, label: CHANNEL_BINDING.keyOf(token.name, token.group) }));
      setKeys(items);
      if (items.length === 1) { setTokenId(items[0].value); setHint(true); } else { setTokenId(null); setHint(false); }
    }).catch(() => { if (alive) { setKeys(null); setFailed(true); } });
    return () => { alive = false; };
  }, [upstream?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!upstream) return null;
  // 选中的渠道被搜索挡住、或被收起的已禁用挡住时，不算选着
  const channel = choices?.visible.find((item) => item.channelId === channelId) ?? null;
  const submit = async () => {
    setSaving(true);
    try {
      await api("/api/reconciliation/channels/select-key", { body: { ownStationId, channelId: channel?.channelId, upstreamStationId: upstream.id, tokenId } });
      message.success(CHANNEL_BINDING.done.bound(channel?.name ?? "", upstream.name));
      onClose();
      await onDone();
    } catch (error: any) {
      message.error(describeError({ code: error?.code, message: error?.message }).text);
    } finally { setSaving(false); }
  };
  return <Modal open centered title={M.title} okText={M.ok} cancelText={M.cancel} okButtonProps={{ disabled: !channel || tokenId == null }} confirmLoading={saving} onCancel={onClose} onOk={() => void submit()} width="min(520px, calc(100vw - 24px))" className="jy-bind-modal" destroyOnHidden>
    <p className="jy-caption">{M.sub(upstream.name, upstream.address || "")}</p>
    <label className="jy-bind-label">{M.channel}</label>
    <Input
      allowClear className="jy-bind-search" aria-label={M.searchAria} placeholder={M.search} prefix={<Icon name="search" />} value={query} disabled={saving}
      onChange={(event) => setQuery(event.target.value)}
    />
    {choices?.noMatch ? <p className="jy-caption jy-bind-nomatch"><Sym kind="info" /><span>{M.noMatch}</span></p> : null}
    <Radio.Group className="jy-bind-list" value={channel?.channelId ?? null} onChange={(event) => setChannelId(event.target.value)}>
      {choices?.visible.length ? choices.groups.map((group, index) => (
        <div key={group.title ?? index} role="group" aria-label={group.title ? (group.title === "match" ? M.groupMatch : M.groupOther) : undefined}>
          {group.title ? <div className="jy-bind-group">{group.title === "match" ? M.groupMatch : M.groupOther}</div> : null}
          {group.channels.map((item) => {
            const off = item.enabled === false;
            return <Radio key={item.channelId} value={item.channelId} className="jy-bind-row">
              <span className="jy-bind-channel">
                <span className="jy-bind-line">
                  <span className={`jy-bind-name${off ? " is-off" : ""}`} title={item.name}>{item.name}</span>
                  {off ? <em className="jy-tag jy-tag--type jy-bind-off">{M.disabledTag}</em> : null}
                </span>
                {item.address && !item.name.includes(item.address) ? <small className="jy-caption jy-bind-addr" title={item.address}>{item.address}</small> : null}
              </span>
            </Radio>;
          })}
        </div>
      )) : <p className="jy-caption jy-bind-empty">{choices && !channels.some((item) => item.ruleId == null) ? M.noChannels : M.notFound}</p>}
    </Radio.Group>
    {choices?.disabledCount ? <button type="button" className="jy-link-btn jy-bind-toggle" aria-expanded={showDisabled} onClick={() => setShowDisabled((on) => !on)}>{showDisabled ? M.hideDisabled : M.showDisabled(choices.disabledCount)}</button> : null}
    <label className="jy-bind-label">{M.key}</label>
    <Select
      showSearch className="jy-bind-select" aria-label={M.key} placeholder={M.keyPlaceholder} value={tokenId ?? undefined} options={keys ?? []} loading={keys == null && !failed} disabled={saving}
      filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.trim().toLowerCase())}
      notFoundContent={failed ? M.keysFailed : M.noKeys} onChange={(value: number) => { setTokenId(value); setHint(false); }}
    />
    {hint ? <p className="jy-caption jy-bind-hint">{M.onlyOne}</p> : null}
    {failed ? <p className="jy-caption jy-bind-hint">{M.keysFailed}</p> : null}
  </Modal>;
}

// 「解绑「高速 A」？」
export function UnbindModal({ channel, upstreamName, ownStationId, onClose, onDone }: {
  channel: ChannelOption | null; upstreamName: string; ownStationId: string; onClose: () => void; onDone: () => void | Promise<void>;
}) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  if (!channel) return null;
  const M = CHANNEL_BINDING.unbindModal;
  const submit = async () => {
    setSaving(true);
    try {
      await api("/api/reconciliation/channels/stop", { body: { ownStationId, channelIds: [channel.channelId] } });
      message.success(CHANNEL_BINDING.done.unbound(channel.name));
      onClose();
      await onDone();
    } catch (error: any) {
      message.error(describeError({ code: error?.code, message: error?.message }).text);
    } finally { setSaving(false); }
  };
  return <Modal open centered title={M.title(channel.name)} okText={M.ok} cancelText={M.cancel} okButtonProps={{ danger: true }} confirmLoading={saving} onCancel={onClose} onOk={() => void submit()} width={420} destroyOnHidden>
    <p>{M.body(channel.name, upstreamName)}</p>
  </Modal>;
}
