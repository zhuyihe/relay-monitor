"use client";
// 点开一个用户：右侧抽屉（design 用户运营 v5 §4）。电脑宽 640，手机整屏。
// 从上到下：标题和状态、四个数、近 30 天每天的消费、今天每小时、按模型分、余额变化和充值。
// 概览那句话里点用户名、用户页签里点一行，打开的是同一个抽屉；数据来自 /api/users/[id]（页面刷新时跟着再读一次）。
import { useEffect, useRef, useState } from "react";
import { Drawer, Grid } from "antd";
import { api } from "../../../lib/client";
import { EMPTY, axisMoney, formatDayKey, formatZonedDate, formatZonedTime, weekdayOfDayKey } from "../../../lib/format";
import { ErrorState, Skeleton } from "../../components/data-state";
import { useDrawerEscape } from "../../components/drawer-escape";
import { Bars } from "../../components/bars";
import { BalanceLine } from "./charts";
import { COPY } from "./copy";
import { BigTag, StatusTag } from "./users-tab";
import { bigTipText, deltaText, lastUsedText, money, runwayText } from "./users-format";
import type { UserDetail, UsersPage, UsersRow } from "./users-format";

const HOUR_MS = 3600000;

export function UserDrawer({ id, page, onClose }: { id: number | null; page: UsersPage; onClose: () => void }) {
  const open = id != null;
  const screens = Grid.useBreakpoint();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notFound" | "failed">("loading");
  const [error, setError] = useState<unknown>(null);
  // 抽屉换了人，旧人的数先不显示
  const shownId = useRef<number | null>(null);
  const load = (userId: number, quiet: boolean) => {
    if (!quiet) { setState("loading"); setDetail(null); }
    api(`/api/users/${userId}`)
      .then((res) => { if (shownId.current === userId) { setDetail(res); setState("ready"); } })
      .catch((e: any) => {
        if (shownId.current !== userId) return;
        if (e?.code === "USER_NOT_FOUND" || e?.status === 404) setState("notFound");
        else if (!quiet) { setError(e); setState("failed"); }
      });
  };
  useEffect(() => {
    shownId.current = id;
    if (id == null) return;
    if (!triggerRef.current) triggerRef.current = document.activeElement as HTMLElement | null;
    load(id, false);
  }, [id]);
  // 整页刷新（asOf 变了）时抽屉里也悄悄刷新一次
  useEffect(() => { if (id != null && state === "ready") load(id, true); }, [page.asOf]);
  useDrawerEscape(open, onClose);

  const row: UsersRow | null = detail?.user || null;
  const rate = detail?.rate ?? page.rate, tz = page.tz;
  const m = (usd: number | null | undefined) => money(usd, rate);
  const name = detail?.username || row?.username || "";

  const body = () => {
    if (state === "notFound") return <p className="jy-muted">{COPY.drawer.notFound}</p>;
    if (state === "failed") return <ErrorState what={COPY.drawer.failed} error={error} onRetry={id != null ? () => load(id, false) : undefined} />;
    if (state === "loading" || !detail) return <div className="jy-stack" aria-busy="true"><Skeleton height={64} /><Skeleton height={140} /><Skeleton height={140} /></div>;
    const dayItems = detail.dayBars.map((bar) => ({ key: bar.day, cost: bar.cost * rate }));
    const hourItems = detail.hourBars.map((bar) => ({ key: String(bar.hourMs), cost: bar.cost * rate }));
    const balanceDays = Math.max(1, Math.round(((detail.balance.at(-1)?.t ?? 0) - (detail.balance[0]?.t ?? 0)) / 86400000));
    const week = row ? (page.ready.week ? m(row.week) : EMPTY) : EMPTY;
    return (
      <>
        {row && (
          <dl className="jy-users-drawer-meta">
            <div><dt>{COPY.drawer.group}</dt><dd>{row.group || EMPTY}</dd></div>
            <div><dt>{COPY.drawer.created}</dt><dd>{row.createdAtMs != null ? formatZonedDate(row.createdAtMs, tz, page.asOf) : EMPTY}</dd></div>
            <div><dt>{COPY.drawer.used}</dt><dd>{m(row.usedUsd)}</dd></div>
          </dl>
        )}
        <dl className="jy-kpis jy-users-drawer-kpis">
          <div><dt>{COPY.drawer.kpiWeek}</dt><dd className="jy-kpi-figure">{week}</dd></div>
          <div><dt>{COPY.drawer.kpiVs}</dt><dd className="jy-kpi-figure">{row && detail.ready.compare ? deltaText(row.week, row.prevWeek) : EMPTY}</dd></div>
          <div><dt>{COPY.drawer.kpiBalance}</dt><dd className="jy-kpi-figure">{m(row?.balanceUsd)}</dd></div>
          <div><dt>{COPY.drawer.kpiDays}</dt><dd className="jy-kpi-figure">{row && detail.ready.balance ? runwayText(row) : EMPTY}</dd></div>
        </dl>
        <section className="jy-users-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.dayTitle}</h3><span className="jy-caption">{COPY.drawer.daySub(formatZonedTime(page.asOf, tz))}</span></div>
          <Bars
            items={dayItems}
            valueLabel={COPY.drawer.costLabel}
            tipTitle={(key) => `${formatDayKey(key, tz, page.asOf)} ${weekdayOfDayKey(key)}`}
            tipValue={(cost) => money(cost / rate, rate)}
            tickLabel={(key, index) => (index === dayItems.length - 1 ? COPY.users.today : formatDayKey(key, tz, page.asOf))}
            axis={axisMoney}
            light
            label={COPY.drawer.dayTitle}
          />
        </section>
        <section className="jy-users-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.hourTitle}</h3></div>
          <Bars
            items={hourItems}
            valueLabel={COPY.drawer.costLabel}
            tipTitle={(key) => `${formatZonedTime(Number(key), tz)}–${formatZonedTime(Number(key) + HOUR_MS, tz)}`}
            tipValue={(cost) => money(cost / rate, rate)}
            tickLabel={(key) => formatZonedTime(Number(key), tz)}
            axis={axisMoney}
            light
            label={COPY.drawer.hourTitle}
          />
        </section>
        <section className="jy-users-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.modelTitle}</h3><span className="jy-caption">{COPY.drawer.modelSub}</span></div>
          <Models models={detail.models} rate={rate} />
        </section>
        <section className="jy-users-chart">
          <div className="jy-chart-sub"><h3>{COPY.drawer.balanceTitle}</h3><span className="jy-caption">{COPY.drawer.balanceSub(balanceDays)}</span></div>
          {detail.balance.length >= 2
            ? <BalanceLine points={detail.balance} recharges={detail.recharges} tz={tz} money={(usd) => m(usd)} rate={rate} label={COPY.drawer.balanceTitle} />
            : <p className="jy-muted">{COPY.drawer.balanceNone}</p>}
        </section>
      </>
    );
  };

  return (
    <Drawer
      className="jy-drawer jy-users-drawer"
      placement="right"
      size={screens.md === false ? "100%" : 640}
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
      title={
        <div className="jy-users-drawer-title">
          <span className="who"><strong>{name}</strong>{row?.big && <BigTag tip={bigTipText(row, page)} />}{row && <StatusTag status={row.status} />}</span>
          {row && <span className="jy-caption">{COPY.drawer.lastUsed(lastUsedText(row, page, true))}</span>}
        </div>
      }
    >
      {body()}
    </Drawer>
  );
}

// 按模型分：一行一个模型，名字，右边「46% · ¥200.87」，下面一根 6px 的条，最长的撑满；多的合成「其他 N 个模型」用灰条
function Models({ models, rate }: { models: UserDetail["models"]; rate: number }) {
  if (models.error === "BUSY") return <p className="jy-muted">{COPY.drawer.modelBusy}</p>;
  if (models.error || !models.models) return <p className="jy-muted">{COPY.drawer.modelFailed}</p>;
  if (!models.models.length) return <p className="jy-muted">{COPY.drawer.modelNone}</p>;
  const rows = [
    ...models.models.map((item) => ({ key: item.model, label: item.model, share: item.share, cost: item.cost, gray: false })),
    ...(models.others ? [{ key: "others", label: COPY.drawer.modelOthers(models.others.count), share: models.others.share, cost: models.others.cost, gray: true }] : []),
  ];
  const top = Math.max(...rows.map((row) => row.share)) || 1;
  return (
    <ul className="jy-users-models">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="line"><span className="name" title={row.label}>{row.label}</span><b>{Math.round(row.share * 100)}% · {money(row.cost, rate)}</b></span>
          <span className="bar"><i className={row.gray ? "is-gray" : undefined} style={{ width: `${(row.share / top) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}
