"use client";
// 点开一个模型：右侧抽屉（design 模型供需 v5 §5）。电脑宽 760，手机整屏。
// 从上到下：四个数（缺货失败、少收、主要原因、明天预计）、每小时缺货失败（按原因分色，近 24 小时 / 近 7 天按钟点平均）、哪些渠道在失败、受影响的用户、找货帮手。
// 数据来自 /api/models/detail?name=（模型名里可能有「/」，所以不放在路径里）；整页刷新时抽屉里也悄悄刷新一次。
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Drawer, Grid } from "antd";
import { api } from "../../../lib/client";
import { EMPTY, formatAsOfTime } from "../../../lib/format";
import { ErrorState, Skeleton } from "../../components/data-state";
import { useDrawerEscape } from "../../components/drawer-escape";
import { Seg } from "../../components/seg";
import { ChartLegend, HourlyChart } from "./charts";
import { COPY } from "./copy";
import { RunwayCell } from "./models-table";
import { bindLink, causeText, compareText, conclusionText, isOut, limitLine, outSinceText, priceText, tomorrowText, upstreamName, userLink, yuan } from "./models-format";
import type { ChannelView, DetailChannel, DetailHeadroom, LoadedPage, ModelDetail } from "./models-format";
import type { HourBar } from "./charts";

type Mode = "last24" | "clock7d";
type Loaded = ModelDetail & { headroom: DetailHeadroom };

export function ModelDrawer({ name, page, onClose }: { name: string | null; page: LoadedPage; onClose: () => void }) {
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

  // 标题旁的红字：这个模型近 24 小时缺货失败几次（没有失败不写）；详情还没读回来先用主表那一行的
  const lostRow = detail?.headroom?.lost ?? page.headroom.lost.rows.find((item) => item.name === name) ?? null;
  const outNow = !!lostRow && isOut(lostRow);
  const lost24 = lostRow?.lost24 ?? 0;

  const body = () => {
    if (state === "notFound") return <p className="jy-muted">{COPY.drawer.notFound}</p>;
    if (state === "failed") return <ErrorState what={COPY.drawer.failed} error={error} onRetry={name != null ? () => load(name, false) : undefined} />;
    if (detail && !detail.headroom) return <p className="jy-muted">{COPY.drawer.notComputed}</p>;
    if (state === "loading" || !detail) return <div className="jy-stack" aria-busy="true"><Skeleton height={64} /><Skeleton height={200} /><Skeleton height={120} /></div>;
    return <DrawerBody detail={detail as Loaded} mode={mode} setMode={setMode} phone={phone} rate={page.rate} page={page} />;
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
          {outNow ? <span className="jy-hshort">{COPY.outNow}</span> : lost24 > 0 && <span className="jy-hshort">{COPY.drawer.titleLost(lost24)}</span>}
        </span>
      )}
    >
      {body()}
    </Drawer>
  );
}

function DrawerBody({ detail, mode, setMode, phone, rate, page }: { detail: Loaded; mode: Mode; setMode: (m: Mode) => void; phone: boolean; rate: number; page: LoadedPage }) {
  const h = detail.headroom, D = COPY.drawer, lost = h.lost;
  const bars = useMemo<HourBar[] | null>(() => {
    if (!h.hourly) return null;
    if (mode === "last24") return h.hourly.last24.map((p) => ({ hour: p.hour, lost: p.lost }));
    return [...h.hourly.clock7d].sort((a, b) => a.hour - b.hour).map((p) => ({ hour: p.hour, lost: p.lost }));
  }, [h.hourly, mode]);
  const out = !!lost && isOut(lost);
  const since = out ? outSinceText(lost!.outSince, detail.tz, detail.asOf) : null;
  const empty = bars != null && bars.every((bar) => bar.lost.rate_limit + bar.lost.upstream + bar.lost.auth_quota === 0);
  const dash = EMPTY;
  return (
    <>
      <dl className="jy-kpis jy-models-drawer-kpis">
        <div>
          <dt>{D.kpiLost}</dt>
          <dd className="jy-kpi-figure">{out ? COPY.outNow : COPY.timesCell(lost?.lost24 ?? 0)}</dd>
          {(out ? since : D.kpiLostSub) && <dd className="jy-caption">{out ? since : D.kpiLostSub}</dd>}
        </div>
        <div>
          <dt>{D.kpiMoney}</dt>
          <dd className="jy-kpi-figure">{lost && lost.lostMoney24 > 0 ? (out ? COPY.outMoney(yuan(lost.lostMoney24, rate)) : COPY.moneyCell(yuan(lost.lostMoney24, rate))) : dash}</dd>
        </div>
        <div>
          <dt>{D.kpiCause}</dt>
          <dd className="jy-kpi-figure">{lost?.mainCause ? D.causeLine(causeText(lost.mainCause), lost.mainUpstream ? upstreamName(lost.mainUpstream) : null) : dash}</dd>
        </div>
        <div>
          <dt>{D.kpiTomorrow}</dt>
          <dd className="jy-kpi-figure">{lost ? tomorrowText(lost.tomorrowLost, out) : dash}</dd>
        </div>
      </dl>
      <section className="jy-models-chart">
        <div className="jy-chart-sub">
          <h3>{D.chartTitle}</h3>
          <span className="spacer" />
          <Seg<Mode> size="sm" label={D.chartTitle} value={mode} onChange={setMode} options={[{ value: "last24", label: D.last24 }, { value: "clock7d", label: D.clock7d }]} />
        </div>
        {out ? <p className="jy-muted">{D.outChart}</p>
          : bars == null ? <p className="jy-muted">{D.notComputed}</p>
          : empty ? <p className="jy-muted">{D.chartNone}</p>
            : (
              <>
                <HourlyChart bars={bars} label={D.chartLabel} />
                <ChartLegend bars={bars} />
              </>
            )}
        {!out && bars != null && !empty && <p className="jy-models-conclusion">{conclusionText(lost)}</p>}
      </section>
      <section className="jy-models-chart">
        <div className="jy-chart-sub"><h3>{D.channelsTitle}</h3><span className="jy-caption">{D.channelsSub}</span></div>
        <Channels detail={detail} phone={phone} />
      </section>
      <section className="jy-models-chart">
        <div className="jy-chart-sub"><h3>{D.usersTitle}</h3><span className="jy-caption">{D.usersSub}</span></div>
        <Users detail={detail} out={out} />
      </section>
      <section className="jy-models-chart">
        <div className="jy-chart-sub"><h3>{D.finderTitle}</h3><span className="jy-caption">{D.finderSub}</span></div>
        <Finder detail={detail} rate={rate} critDays={page.critDays} phone={phone} />
      </section>
    </>
  );
}

// 受影响的用户：近 24 小时被挡过几次（含后来重试买到的，所以写「受影响 N 次」，不写「失败」），前 5 个，重点用户带「重点」小标签，名字开用户运营的用户抽屉；下面「其他 18 个人受影响 326 次」
function Users({ detail, out }: { detail: Loaded; out: boolean }) {
  const D = COPY.drawer, { users } = detail.headroom;
  if (out) return <p className="jy-muted">{D.outUsers}</p>;
  if (!users.top.length && !users.others) return <p className="jy-muted">{D.usersNone}</p>;
  const biggest = Math.max(1, ...users.top.map((user) => user.blockedRequests));
  return (
    <>
      <ul className="jy-models-users">
        {users.top.map((user) => (
          <li key={user.userId}>
            <span className="line">
              <Link className="jy-link name" href={userLink(user.userId)} title={user.name}>{user.name}</Link>
              {user.key && <span className="jy-tag jy-tag--info">{D.usersKey}</span>}
              <b>{D.usersTimes(user.blockedRequests)}</b>
            </span>
            <span className="bar"><i style={{ width: `${(user.blockedRequests / biggest) * 100}%` }} /></span>
          </li>
        ))}
      </ul>
      {users.others && <p className="jy-caption jy-models-users-others">{D.usersOthers(users.others.count, users.others.blockedRequests)}</p>}
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

// 哪些渠道在失败：渠道、上游、缺货失败、主要原因、状态；渠道名下面一行灰字「每小时最多接约 X 次」只在测到时写；被停用的渠道灰字，停用原因和时间沿用第 0 步
function Channels({ detail, phone }: { detail: Loaded; phone: boolean }) {
  const D = COPY.drawer, cols = D.channelCols;
  const channels = detail.headroom.channels as ChannelView[];
  if (!channels.length) return <p className="jy-muted">{D.channelNone}</p>;
  const old = new Map(detail.channels.map((channel) => [channel.channelId, channel]));
  const rows = channels.map((channel) => ({ channel, stop: old.get(channel.channelId), cls: channel.state === "on" ? undefined : "jy-models-off", state: stateText(old.get(channel.channelId), channel.state, detail.tz, detail.asOf), limit: limitLine(channel) }));
  const lostText = (channel: ChannelView) => COPY.timesCell(channel.lost24 ?? 0);
  if (phone) {
    return (
      <ul className="jy-models-subcards">
        {rows.map(({ channel, stop, cls, state, limit }) => (
          <li key={channel.channelId} className={cls}>
            <span className="r1"><b>{channel.name}</b><span>{lostText(channel)}</span></span>
            {limit && <span className="r2 jy-caption">{limit}</span>}
            <span className="r2 jy-caption">{[channel.upstream?.name ?? D.unbound, channel.mainCause ? causeText(channel.mainCause) : null, state].filter(Boolean).join(" · ")}</span>
            {stop?.stopReason && <StopReason channel={stop} className="r2" />}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="jy-table-wrap">
      <table className="jy-data jy-num jy-data--compact jy-models-channels">
        <caption className="sr-only">{D.channelsTitle}</caption>
        <colgroup><col style={{ width: "24%" }} /><col style={{ width: "16%" }} /><col style={{ width: "14%" }} /><col style={{ width: "14%" }} /><col style={{ width: "32%" }} /></colgroup>
        <thead><tr><th scope="col">{cols.channel}</th><th scope="col">{cols.upstream}</th><th scope="col" className="r">{cols.lost}</th><th scope="col">{cols.cause}</th><th scope="col">{cols.status}</th></tr></thead>
        <tbody>
          {rows.map(({ channel, stop, cls, state, limit }) => (
            <tr key={channel.channelId} className={cls}>
              <td>{limit ? <span className="jy-cell-two"><span>{channel.name}</span><span className="jy-caption">{limit}</span></span> : channel.name}</td>
              <td>{channel.upstream ? (channel.upstream.name ?? EMPTY) : <span className="jy-muted">{D.unbound}</span>}</td>
              <td className="r">{lostText(channel)}</td>
              <td>{channel.mainCause ? causeText(channel.mainCause) : <span className="jy-muted">{COPY.dash}</span>}</td>
              <td>
                {channel.state === "auto" && stop?.stopReason
                  ? (<span className="jy-cell-two"><span>{state}</span><StopReason channel={stop} /></span>)
                  : state}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 找货帮手：已经加了的上游里，谁也卖这个模型，按价格从低到高；还没在供的最右边一个「去绑定渠道」
function Finder({ detail, rate, critDays, phone }: { detail: Loaded; rate: number; critDays: number; phone: boolean }) {
  const D = COPY.drawer, cols = D.finderCols;
  const cards = (
    <ul className="jy-models-subcards">
      {detail.finder.map((item) => (
        <li key={item.upstreamId}>
          <span className="r1"><b>{item.name ?? EMPTY}</b><span>{item.supplying ? D.supplying : D.notSupplying}</span></span>
          <span className="r2 jy-caption">{[item.readable ? priceText(item.price, rate) : D.unreadablePrice, compareText(item)].join(" · ")}</span>
          <span className="r3"><RunwayCell runway={item.runway} critDays={critDays} />{!item.supplying && item.bindable && <Link className="jy-link" href={bindLink(item.upstreamId)} aria-label={`${D.goBind}：${item.name ?? ""}`}>{D.goBind}</Link>}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {detail.finder.length === 0 ? <p className="jy-muted">{D.finderNone}</p> : phone ? cards : (
        <div className="jy-table-wrap">
          <table className="jy-data jy-num jy-data--compact jy-models-finder">
            <caption className="sr-only">{D.finderTitle}</caption>
            <colgroup><col style={{ width: "20%" }} /><col style={{ width: "16%" }} /><col style={{ width: "20%" }} /><col style={{ width: "20%" }} /><col style={{ width: "13%" }} /><col style={{ width: "11%" }} /></colgroup>
            <thead><tr><th scope="col">{cols.upstream}</th><th scope="col" className="r">{cols.price}</th><th scope="col">{cols.vs}</th><th scope="col">{cols.runway}</th><th scope="col">{cols.supply}</th><th scope="col"><span className="sr-only">{D.goBind}</span></th></tr></thead>
            <tbody>
              {detail.finder.map((item) => (
                <tr key={item.upstreamId}>
                  <td>{item.name ?? EMPTY}</td>
                  <td className="r">{item.readable ? priceText(item.price, rate) : <span className="jy-muted">{D.unreadablePrice}</span>}</td>
                  <td>{compareText(item)}</td>
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
