"use client";
// 点开一个模型：右侧抽屉（design 模型供需 v1 §5）。电脑宽 720（要放两张表），手机整屏。
// 从上到下：四个数、每天卖多少（近 30 天柱）、成功率（近 30 天线，95% 一条红虚线）、渠道和上游、找货帮手、主要是谁在用、去自营业务看赚多少。
// 数据来自 /api/models/detail?name=（模型名里可能有「/」，所以不放在路径里）；整页刷新时抽屉里也悄悄刷新一次。
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Drawer, Grid } from "antd";
import { api } from "../../../lib/client";
import { EMPTY, axisMoney, formatDayKey, formatPct, formatZonedTime, weekdayOfDayKey } from "../../../lib/format";
import { ErrorState, Skeleton } from "../../components/data-state";
import { useDrawerEscape } from "../../components/drawer-escape";
import { Bars } from "../users/charts";
import { RateLine } from "./charts";
import { GapTags, RunwayCell } from "./models-table";
import { COPY } from "./copy";
import { MY_LINK, bindLink, compareText, deltaText, money, priceText, successText, supplyText, userLink } from "./models-format";
import type { ModelDetail, ModelsPage } from "./models-format";

export function ModelDrawer({ name, page, onClose }: { name: string | null; page: ModelsPage; onClose: () => void }) {
  const open = name != null;
  const screens = Grid.useBreakpoint();
  const phone = screens.md === false;
  const triggerRef = useRef<HTMLElement | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notFound" | "failed">("loading");
  const [error, setError] = useState<unknown>(null);
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
    if (!triggerRef.current) triggerRef.current = document.activeElement as HTMLElement | null;
    load(name, false);
  }, [name]);
  useEffect(() => { if (name != null && state === "ready") load(name, true); }, [page.asOf]);
  useDrawerEscape(open, onClose);

  const row = detail?.row ?? page.rows.find((item) => item.name === name) ?? null;
  const rate = page.rate, tz = page.tz;

  const body = () => {
    if (state === "notFound") return <p className="jy-muted">{COPY.drawer.notFound}</p>;
    if (state === "failed") return <ErrorState what={COPY.drawer.failed} error={error} onRetry={name != null ? () => load(name, false) : undefined} />;
    if (state === "loading" || !detail || !row) return <div className="jy-stack" aria-busy="true"><Skeleton height={64} /><Skeleton height={140} /><Skeleton height={140} /></div>;
    const dayItems = detail.dayBars.map((bar) => ({ key: bar.day, cost: bar.cost * rate }));
    return (
      <>
        <dl className="jy-kpis jy-models-drawer-kpis">
          <div><dt>{COPY.drawer.kpiWeek}</dt><dd className="jy-kpi-figure">{money(row.week, rate)}</dd></div>
          <div><dt>{COPY.drawer.kpiVs}</dt><dd className="jy-kpi-figure">{row.prev > 0 ? deltaText(row.week, row.prev).replace(/^比前 7 天 /, "") : EMPTY}</dd></div>
          <div><dt>{COPY.drawer.kpiSuccess}</dt><dd className="jy-kpi-figure">{successText(row.success)}</dd></div>
          <div><dt>{COPY.drawer.kpiSupply}</dt><dd className="jy-kpi-figure">{supplyText(row)}</dd></div>
        </dl>
        <section className="jy-models-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.dayTitle}</h3><span className="jy-caption">{COPY.drawer.daySub(formatZonedTime(detail.asOf, tz))}</span></div>
          <Bars
            items={dayItems}
            valueLabel={COPY.drawer.costLabel}
            tipTitle={(key) => `${formatDayKey(key, tz, detail.asOf)} ${weekdayOfDayKey(key)}`}
            tipValue={(cost) => money(cost / rate, rate)}
            tickLabel={(key, index) => (index === dayItems.length - 1 ? COPY.drawer.today : formatDayKey(key, tz, detail.asOf).replace(/^\d+年/, ""))}
            axis={axisMoney}
            light
            label={COPY.drawer.dayTitle}
          />
        </section>
        <section className="jy-models-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.successTitle}</h3><span className="jy-caption">{COPY.drawer.successSub}</span></div>
          {detail.successLine == null ? <p className="jy-muted">{COPY.drawer.successUnread}</p>
            : detail.successLine.points.every((point) => point.rate == null) ? <p className="jy-muted">{COPY.drawer.successNone}</p>
              : <RateLine points={detail.successLine.points} low={detail.successLine.low} tz={tz} asOf={detail.asOf} label={COPY.drawer.successTitle} />}
        </section>
        <section className="jy-models-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.channelsTitle}</h3><span className="jy-caption">{COPY.drawer.channelsSub}</span></div>
          <Channels detail={detail} critDays={detail.critDays} phone={phone} />
        </section>
        <section className="jy-models-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.finderTitle}</h3><span className="jy-caption">{COPY.drawer.finderSub}</span></div>
          <Finder detail={detail} rate={rate} critDays={detail.critDays} phone={phone} />
        </section>
        <section className="jy-models-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.usersTitle}</h3><span className="jy-caption">{COPY.drawer.usersSub}</span></div>
          <Users detail={detail} rate={rate} />
        </section>
        <p className="jy-models-foot"><Link className="jy-link" href={MY_LINK}>{COPY.toMy}</Link></p>
      </>
    );
  };

  return (
    <Drawer
      className="jy-drawer jy-models-drawer"
      placement="right"
      size={phone ? "100%" : 720}
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
      title={<span className="jy-models-drawer-title"><strong>{name}</strong>{row && <GapTags tags={row.tags} />}</span>}
    >
      {body()}
    </Drawer>
  );
}

// 渠道和上游：一个渠道一行；被停用的也列（灰字），提醒还有一条路可以开
function Channels({ detail, critDays, phone }: { detail: ModelDetail; critDays: number; phone: boolean }) {
  const cols = COPY.drawer.channelCols;
  if (!detail.channels.length) return <p className="jy-muted">{COPY.drawer.channelNone}</p>;
  // 手机：一个渠道一张卡片——第一行渠道名和状态，第二行优先级 · 流量占比 · 上游，第三行跑道
  if (phone) {
    return (
      <ul className="jy-models-subcards">
        {detail.channels.map((channel) => (
          <li key={channel.channelId} className={channel.state === "on" ? undefined : "jy-models-off"}>
            <span className="r1"><b>{channel.name}</b><span>{COPY.drawer.channelState[channel.state]}</span></span>
            <span className="r2 jy-caption">{COPY.drawer.channelLine(channel.priority, channel.share == null ? EMPTY : formatPct(channel.share, 0), channel.upstream ? (channel.upstream.name ?? EMPTY) : COPY.drawer.unbound)}</span>
            {channel.upstream && <span className="r3"><RunwayCell runway={channel.upstream.runway} critDays={critDays} /></span>}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="jy-table-wrap">
      <table className="jy-data jy-num jy-data--compact">
        <caption className="sr-only">{COPY.drawer.channelsTitle}</caption>
        <thead><tr><th scope="col">{cols.channel}</th><th scope="col">{cols.state}</th><th scope="col" className="r">{cols.priority}</th><th scope="col" className="r">{cols.share}</th><th scope="col">{cols.upstream}</th><th scope="col">{cols.runway}</th></tr></thead>
        <tbody>
          {detail.channels.map((channel) => (
            <tr key={channel.channelId} className={channel.state === "on" ? undefined : "jy-models-off"}>
              <td>{channel.name}</td>
              <td>{COPY.drawer.channelState[channel.state]}</td>
              <td className="r">{channel.priority}</td>
              <td className="r">{channel.share == null ? EMPTY : formatPct(channel.share, 0)}</td>
              <td>{channel.upstream ? (channel.upstream.name ?? EMPTY) : <span className="jy-muted">{COPY.drawer.unbound}</span>}</td>
              <td>{channel.upstream ? <RunwayCell runway={channel.upstream.runway} critDays={critDays} /> : <span className="jy-muted">{EMPTY}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 找货帮手：已经加了的上游里，谁也卖这个模型，按价格从低到高；还没在供的最右边一个「去绑定渠道」
function Finder({ detail, rate, critDays, phone }: { detail: ModelDetail; rate: number; critDays: number; phone: boolean }) {
  const cols = COPY.drawer.finderCols;
  // 手机：一个上游一张卡片——第一行上游名和在不在供（还没在供的右边一个「去绑定渠道」），第二行价格 · 和现在用的比，第三行余额够用的跑道
  const cards = (
    <ul className="jy-models-subcards">
      {detail.finder.map((item) => (
        <li key={item.upstreamId}>
          <span className="r1"><b>{item.name ?? EMPTY}</b><span>{item.supplying ? COPY.drawer.supplying : COPY.drawer.notSupplying}</span></span>
          <span className="r2 jy-caption">{COPY.drawer.finderLine(item.readable ? priceText(item.price, rate) : COPY.drawer.unreadablePrice, compareText(item))}</span>
          <span className="r3"><RunwayCell runway={item.runway} critDays={critDays} />{!item.supplying && item.bindable && <Link className="jy-link" href={bindLink(item.upstreamId)} aria-label={`${COPY.drawer.goBind}：${item.name ?? ""}`}>{COPY.drawer.goBind}</Link>}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {detail.finder.length === 0 ? <p className="jy-muted">{COPY.drawer.finderNone}</p> : phone ? cards : (
        <div className="jy-table-wrap">
          <table className="jy-data jy-num jy-data--compact">
            <caption className="sr-only">{COPY.drawer.finderTitle}</caption>
            <thead><tr><th scope="col">{cols.upstream}</th><th scope="col" className="r">{cols.price}</th><th scope="col">{cols.vs}</th><th scope="col">{cols.runway}</th><th scope="col">{cols.supply}</th><th scope="col"><span className="sr-only">{COPY.drawer.goBind}</span></th></tr></thead>
            <tbody>
              {detail.finder.map((item) => (
                <tr key={item.upstreamId}>
                  <td>{item.name ?? EMPTY}</td>
                  <td className="r">{item.readable ? priceText(item.price, rate) : <span className="jy-muted">{COPY.drawer.unreadablePrice}</span>}</td>
                  <td>{compareText(item)}</td>
                  <td><RunwayCell runway={item.runway} critDays={critDays} /></td>
                  <td>{item.supplying ? COPY.drawer.supplying : COPY.drawer.notSupplying}</td>
                  <td className="r">{!item.supplying && item.bindable && <Link className="jy-link" href={bindLink(item.upstreamId)} aria-label={`${COPY.drawer.goBind}：${item.name ?? ""}`}>{COPY.drawer.goBind}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="jy-caption jy-models-finder-note">{COPY.drawer.finderNote}</p>
    </>
  );
}

// 主要是谁在用：前 4 个人加「其他 N 个人」，一行一个人，右边「31% · ¥220.65」，下面一根条，最长的撑满；名字点了开用户运营的用户抽屉
function Users({ detail, rate }: { detail: ModelDetail; rate: number }) {
  if (!detail.users) return <p className="jy-muted">{COPY.drawer.usersUnread}</p>;
  const { top, others, total } = detail.users;
  if (!top.length) return <p className="jy-muted">{COPY.drawer.usersNone}</p>;
  const rows = [
    ...top.map((item) => ({ key: item.user, label: item.user, cost: item.cost, userId: item.userId, gray: false })),
    ...(others ? [{ key: "others", label: COPY.drawer.usersOthers(others.count), cost: others.cost, userId: null, gray: true }] : []),
  ];
  const biggest = Math.max(...rows.map((row) => row.cost)) || 1;
  return (
    <ul className="jy-models-users">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="line">
            {row.userId != null ? <Link className="jy-link name" href={userLink(row.userId)} title={row.label}>{row.label}</Link> : <span className="name" title={row.label}>{row.label}</span>}
            <b>{total > 0 ? Math.round((row.cost / total) * 100) : 0}% · {money(row.cost, rate)}</b>
          </span>
          <span className="bar"><i className={row.gray ? "is-gray" : undefined} style={{ width: `${(row.cost / biggest) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}
