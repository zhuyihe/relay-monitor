"use client";
// 点开一个模型：右侧抽屉（design 模型供需 v4 §5）。电脑宽 760（要放下一张 24 小时的图），手机整屏。
// 从上到下：四个数、每小时成交和被挡（近 24 小时 / 近 7 天按钟点平均）、受影响最多的用户、各渠道的上限、找货帮手。
// 数据来自 /api/models/detail?name=（模型名里可能有「/」，所以不放在路径里）；整页刷新时抽屉里也悄悄刷新一次。
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Drawer, Grid } from "antd";
import { api } from "../../../lib/client";
import { EMPTY, formatAsOfTime } from "../../../lib/format";
import { ErrorState, Skeleton } from "../../components/data-state";
import { useDrawerEscape } from "../../components/drawer-escape";
import { Sym } from "../../components/icons";
import { Seg } from "../../components/seg";
import { ChartLegend, HourlyChart } from "./charts";
import { COPY } from "./copy";
import { RunwayCell } from "./models-table";
import { approx, bindLink, channelStatusText, compareText, conclusionText, finderRoomText, growthText, money, peakText, priceText, quantityText, recoView, userLink } from "./models-format";
import type { DetailChannel, ModelDetail, ModelsPage } from "./models-format";
import type { HourBar } from "./charts";

type Mode = "last24" | "clock7d";

export function ModelDrawer({ name, page, onClose }: { name: string | null; page: ModelsPage; onClose: () => void }) {
  const open = name != null;
  const screens = Grid.useBreakpoint();
  const phone = screens.md === false;
  const triggerRef = useRef<HTMLElement | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notFound" | "failed">("loading");
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<Mode>("last24");
  // 抽屉换了模型，旧模型的数先不显示
  const shown = useRef<string | null>(null);
  const load = (model: string, quiet: boolean) => {
    if (!quiet) { setState("loading"); setDetail(null); }
    api(`/api/models/detail?name=${encodeURIComponent(model)}`)
      .then((res) => { if (shown.current === model) { setDetail(res); setState("ready"); } })
      .catch((e: any) => {
        if (shown.current !== model) return;
        if (e?.code === "MODEL_NOT_FOUND" || e?.status === 404) setState("notFound");
        else if (!quiet) { setError(e); setState("failed"); }
      });
  };
  useEffect(() => {
    shown.current = name;
    if (name == null) return;
    setMode("last24");
    if (!triggerRef.current) triggerRef.current = document.activeElement as HTMLElement | null;
    load(name, false);
  }, [name]);
  useEffect(() => { if (name != null && state === "ready") load(name, true); }, [page.asOf]);
  useDrawerEscape(open, onClose);

  const row = page.headroom.rows.find((item) => item.name === name) ?? null;
  const rate = page.rate;
  // 标题旁的红菱形：缺的写「今晚高峰缺约 N 次/小时」；详情还没读回来先用主表那一行的
  const margin = detail?.headroom.margin ?? row?.margin ?? null;
  const gap = margin?.status === "short" && margin.value != null ? Math.abs(margin.value) : null;

  const body = () => {
    if (state === "notFound") return <p className="jy-muted">{COPY.drawer.notFound}</p>;
    if (state === "failed") return <ErrorState what={COPY.drawer.failed} error={error} onRetry={name != null ? () => load(name, false) : undefined} />;
    if (state === "loading" || !detail) return <div className="jy-stack" aria-busy="true"><Skeleton height={64} /><Skeleton height={200} /><Skeleton height={120} /></div>;
    return <DrawerBody detail={detail} mode={mode} setMode={setMode} phone={phone} rate={rate} page={page} />;
  };

  return (
    <Drawer
      className="jy-drawer jy-models-drawer"
      placement="right"
      size={phone ? "100%" : 760}
      open={open}
      onClose={onClose}
      keyboard={false}
      focusable={{ focusTriggerAfterClose: false }}
      afterOpenChange={(o) => {
        if (o) return;
        const trigger = triggerRef.current;
        triggerRef.current = null;
        if (trigger && trigger.isConnected) trigger.focus();
      }}
      title={(
        <span className="jy-models-drawer-title">
          <strong>{name}</strong>
          {gap != null && <span className="jy-hshort"><Sym kind="crit" />{COPY.drawer.short(approx(gap))}</span>}
        </span>
      )}
    >
      {body()}
    </Drawer>
  );
}

function DrawerBody({ detail, mode, setMode, phone, rate, page }: { detail: ModelDetail; mode: Mode; setMode: (m: Mode) => void; phone: boolean; rate: number; page: ModelsPage }) {
  const h = detail.headroom, D = COPY.drawer, state = page.headroom.state;
  const peak = peakText(h.peak);
  const margin = h.margin;
  const channelsOn = h.channels.filter((channel) => channel.state === "on").length;
  const bars = useMemo<HourBar[] | null>(() => {
    if (!h.hourly) return null;
    if (mode === "last24") return h.hourly.last24.map((p) => ({ hour: p.hour, success: p.success, blocked: p.blocked, notBought: p.notBought }));
    return [...h.hourly.clock7d].sort((a, b) => a.hour - b.hour).map((p) => ({ hour: p.hour, success: p.success, blocked: p.blocked }));
  }, [h.hourly, mode]);
  const empty = bars != null && bars.every((bar) => bar.success === 0 && Object.values(bar.blocked).every((v) => v === 0));
  const isShort = margin.status === "short" && margin.value != null;
  const nb = h.notBought;
  return (
    <>
      <dl className="jy-kpis jy-models-drawer-kpis">
        <div>
          <dt>{D.kpiNeed}</dt>
          <dd className="jy-kpi-figure">{h.need ? COPY.approx(approx(h.need.value)) : EMPTY}</dd>
          <dd className="jy-caption">{D.needSub(peak, h.need ? growthText(h.need.growth).replace(/^涨幅 /, "") : null)}</dd>
        </div>
        <div>
          <dt>{D.kpiSupply}</dt>
          <dd className="jy-kpi-figure">{quantityText(h.supply)}</dd>
          <dd className="jy-caption">{channelsOn > 0 ? D.supplySub(channelsOn) : D.supplyNone}</dd>
        </div>
        <div>
          <dt>{isShort ? D.kpiGap : D.kpiRoom}</dt>
          <dd className={`jy-kpi-figure${isShort ? " jy-hshort-figure" : ""}`}>{margin.value == null || margin.status === "unknown" || margin.status === "none" ? EMPTY : approx(Math.abs(margin.value))}</dd>
          <dd className="jy-caption">{recoLine(detail, state)}</dd>
        </div>
        <div>
          <dt>{D.kpiNotBought}</dt>
          <dd className="jy-kpi-figure">{nb ? COPY.kpi.notBoughtValue(nb.f24) : EMPTY}</dd>
          <dd className="jy-caption">{nb ? D.notBoughtSub(money(nb.lostUsd, rate), nb.blockedRetried) : D.notBoughtNone}</dd>
        </div>
      </dl>
      <section className="jy-models-chart">
        <div className="jy-chart-sub">
          <h3>{D.chartTitle}</h3>
          <span className="spacer" />
          <Seg<Mode> size="sm" label={D.chartTitle} value={mode} onChange={setMode} options={[{ value: "last24", label: D.last24 }, { value: "clock7d", label: D.clock7d }]} />
        </div>
        {bars == null ? <p className="jy-muted">{D.hourlyUnread}</p>
          : empty ? <p className="jy-muted">{D.hourlyNone}</p>
            : (
              <>
                <HourlyChart bars={bars} limit={h.limitLine} peakHours={h.peak?.hours ?? []} label={D.chartLabel} />
                <ChartLegend bars={bars} />
              </>
            )}
        {bars != null && !empty && state !== "noErrorLog" && <p className="jy-models-conclusion">{conclusionText(h.facts)}</p>}
      </section>
      <section className="jy-models-chart">
        <div className="jy-chart-sub"><h3>{D.usersTitle}</h3><span className="jy-caption">{D.usersSub}</span></div>
        <Users detail={detail} state={state} />
      </section>
      <section className="jy-models-chart">
        <div className="jy-chart-sub"><h3>{D.channelsTitle}</h3><span className="jy-caption">{D.channelsSub}</span></div>
        <Channels detail={detail} phone={phone} />
      </section>
      <section className="jy-models-chart">
        <div className="jy-chart-sub"><h3>{D.finderTitle}</h3><span className="jy-caption">{D.finderSub}</span></div>
        <Finder detail={detail} rate={rate} critDays={detail.critDays} phone={phone} />
      </section>
    </>
  );
}

// 缺口那格下面写建议（和主表同一句）；余量够就写余量的说法
function recoLine(detail: ModelDetail, state: ModelsPage["headroom"]["state"]): string {
  const view = recoView({ reco: detail.headroom.reco, supply: detail.headroom.supply, margin: detail.headroom.margin }, state);
  return view.kind === "none" ? EMPTY : view.title;
}

// 受影响最多的用户：近 24 小时被挡过几次，前 5 个，重点用户带「重点」小标签，名字开用户运营的用户抽屉；下面「其他 18 个人被挡 326 次」
function Users({ detail, state }: { detail: ModelDetail; state: ModelsPage["headroom"]["state"] }) {
  const D = COPY.drawer, { users } = detail.headroom;
  if (state === "noErrorLog") return <p className="jy-muted">{D.usersNeedLog}</p>;
  if (!users.top.length && !users.others) return <p className="jy-muted">{D.usersNone}</p>;
  const biggest = Math.max(1, ...users.top.map((user) => user.blocked));
  return (
    <>
      <ul className="jy-models-users">
        {users.top.map((user) => (
          <li key={user.userId}>
            <span className="line">
              <Link className="jy-link name" href={userLink(user.userId)} title={user.name}>{user.name}</Link>
              {user.key && <span className="jy-tag jy-tag--info">{D.usersKey}</span>}
              <b>{D.usersBlocked(user.blocked)}</b>
            </span>
            <span className="bar"><i style={{ width: `${(user.blocked / biggest) * 100}%` }} /></span>
          </li>
        ))}
      </ul>
      {users.others && <p className="jy-caption jy-models-users-others">{D.usersOthers(users.others.count, users.others.blocked)}</p>}
    </>
  );
}

// 被自动停用的渠道：New API 记的停用原因和时间；一行放不下的截短，鼠标放上去看全文
function StopReason({ channel, className = "" }: { channel: DetailChannel; className?: string }) {
  const text = channel.stopReason ?? "";
  return <span className={`jy-caption jy-models-reason ${className}`.trim()} title={text}>{text}</span>;
}
// 状态那一行：被自动停用的带上时间（今天的只写「22:14」，别的天写「10月31日 22:14」）
const stateText = (channel: DetailChannel | undefined, state: "on" | "off" | "auto", tz: string, asOf: number) => (channel?.state === "auto" && channel.stopTime
  ? COPY.drawer.stateAt(COPY.drawer.channelState.auto, formatAsOfTime(channel.stopTime, tz, asOf)) : COPY.drawer.channelState[state]);

// 各渠道的上限：渠道、上游、上限（「约」或「至少」）、高峰用了，最后一格「满了」（红字）/「空约 300」/「被自动停用，不算」；被停用的渠道灰字，停用原因和时间沿用第 0 步
function Channels({ detail, phone }: { detail: ModelDetail; phone: boolean }) {
  const D = COPY.drawer, cols = D.channelCols;
  const channels = detail.headroom.channels;
  if (!channels.length) return <p className="jy-muted">{D.channelNone}</p>;
  const old = new Map(detail.channels.map((channel) => [channel.channelId, channel]));
  const rows = channels.map((channel) => {
    const stop = old.get(channel.channelId);
    return { channel, stop, status: channelStatusText(channel), cls: channel.state === "on" ? undefined : "jy-models-off", state: stateText(stop, channel.state, detail.tz, detail.asOf) };
  });
  if (phone) {
    return (
      <ul className="jy-models-subcards">
        {rows.map(({ channel, stop, status, cls, state }) => (
          <li key={channel.channelId} className={cls}>
            <span className="r1"><b>{channel.name}</b><span className={status.full ? "jy-hfull" : undefined}>{status.full && <Sym kind="crit" />}{status.text}</span></span>
            {channel.state === "auto" && <span className="r2 jy-caption">{state}</span>}
            {stop?.stopReason && <StopReason channel={stop} className="r2" />}
            <span className="r2 jy-caption">{[channel.upstream?.name ?? D.unbound, `${cols.limit} ${quantityText(channel.limit)}`, `${cols.used} ${channel.peakUsed == null ? EMPTY : approx(channel.peakUsed)}`].join(" · ")}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="jy-table-wrap">
      <table className="jy-data jy-num jy-data--compact jy-models-channels">
        <caption className="sr-only">{D.channelsTitle}</caption>
        <colgroup><col style={{ width: "20%" }} /><col style={{ width: "20%" }} /><col style={{ width: "16%" }} /><col style={{ width: "14%" }} /><col style={{ width: "30%" }} /></colgroup>
        <thead><tr><th scope="col">{cols.channel}</th><th scope="col">{cols.upstream}</th><th scope="col" className="r">{cols.limit}</th><th scope="col" className="r">{cols.used}</th><th scope="col">{cols.status}</th></tr></thead>
        <tbody>
          {rows.map(({ channel, stop, status, cls, state }) => (
            <tr key={channel.channelId} className={cls}>
              <td>{channel.name}</td>
              <td>{channel.upstream ? (channel.upstream.name ?? EMPTY) : <span className="jy-muted">{D.unbound}</span>}</td>
              <td className="r">{quantityText(channel.limit)}</td>
              <td className="r">{channel.peakUsed == null ? EMPTY : approx(channel.peakUsed)}</td>
              <td>
                {channel.state === "auto" && stop?.stopReason
                  ? (<span className="jy-cell-two"><span>{status.text}</span><span className="jy-caption">{state}</span><StopReason channel={stop} /></span>)
                  : <span className={status.full ? "jy-hfull" : undefined}>{status.full && <Sym kind="crit" />}{status.text}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 找货帮手：已经加了的上游里，谁也卖这个模型，按价格从低到高，多一项「高峰空约」（便宜的那家高峰还有没有空，决定能不能挪过去）；还没在供的最右边一个「去绑定渠道」
function Finder({ detail, rate, critDays, phone }: { detail: ModelDetail; rate: number; critDays: number; phone: boolean }) {
  const D = COPY.drawer, cols = D.finderCols, room = detail.headroom.finderRoom;
  const cards = (
    <ul className="jy-models-subcards">
      {detail.finder.map((item) => (
        <li key={item.upstreamId}>
          <span className="r1"><b>{item.name ?? EMPTY}</b><span>{item.supplying ? D.supplying : D.notSupplying}</span></span>
          <span className="r2 jy-caption">{D.finderLine(item.readable ? priceText(item.price, rate) : D.unreadablePrice, compareText(item), finderRoomText(room[item.upstreamId]))}</span>
          <span className="r3"><RunwayCell runway={item.runway} critDays={critDays} />{!item.supplying && item.bindable && <Link className="jy-link" href={bindLink(item.upstreamId)} aria-label={`${D.goBind}：${item.name ?? ""}`}>{D.goBind}</Link>}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {detail.finder.length === 0 ? <p className="jy-muted">{D.finderNone}</p> : phone ? cards : (
        <div className="jy-table-wrap">
          <table className="jy-data jy-num jy-data--compact">
            <caption className="sr-only">{D.finderTitle}</caption>
            <thead><tr><th scope="col">{cols.upstream}</th><th scope="col" className="r">{cols.price}</th><th scope="col">{cols.vs}</th><th scope="col" className="r">{cols.room}</th><th scope="col">{cols.runway}</th><th scope="col">{cols.supply}</th><th scope="col"><span className="sr-only">{D.goBind}</span></th></tr></thead>
            <tbody>
              {detail.finder.map((item) => (
                <tr key={item.upstreamId}>
                  <td>{item.name ?? EMPTY}</td>
                  <td className="r">{item.readable ? priceText(item.price, rate) : <span className="jy-muted">{D.unreadablePrice}</span>}</td>
                  <td>{compareText(item)}</td>
                  <td className="r">{finderRoomText(room[item.upstreamId])}</td>
                  <td><RunwayCell runway={item.runway} critDays={critDays} /></td>
                  <td>{item.supplying ? D.supplying : D.notSupplying}</td>
                  <td className="r">{!item.supplying && item.bindable && <Link className="jy-link" href={bindLink(item.upstreamId)} aria-label={`${D.goBind}：${item.name ?? ""}`}>{D.goBind}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="jy-caption jy-models-finder-note">{D.finderNote}</p>
    </>
  );
}
