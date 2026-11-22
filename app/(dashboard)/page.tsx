"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { App, Button, Modal } from "antd";
import { api } from "../../lib/client";
import { balanceDaysText, balanceViewOf, stationDisplayName } from "../../lib/overview-actions";
import { balanceMoneyOf } from "../../lib/profit";
import { EMPTY, formatDays, formatDayKey, formatPct, formatUsd, formatZonedTime, weekdayOfDayKey } from "../../lib/format";
import { visibleInterval } from "../../lib/visible-interval";
import { Icon } from "../components/icons";
import { Panel } from "../components/panel";
import { EmptyState, ErrorState, PanelSkeleton } from "../components/data-state";
import { Seg } from "../components/seg";
import { RangePicker } from "../components/range-picker";
import { presetTimeRange } from "../../lib/time-range";
import { useShellPage } from "../components/shell-context";
import { OverviewChart } from "./overview-chart";
import type { OverviewPageData, OverviewPeriod } from "./overview-types";
import TrendModal from "./trend-modal";
import "../styles/pages/overview.css";

export default function OverviewPage() {
  const { message } = App.useApp();
  const [period, setPeriod] = useState<OverviewPeriod>("today");
  const [data, setData] = useState<OverviewPageData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [customerMode, setCustomerMode] = useState<"reminders" | "ranking">("reminders");
  const [metric, setMetric] = useState<"cost" | "users">("cost");
  const [dialog, setDialog] = useState<"coverage" | "profit" | "basis" | "activity" | "days" | null>(null);
  const [trendStation, setTrendStation] = useState<any>(null);
  const requestId = useRef(0);
  const customersRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await api(`/api/overview?preset=${period}`);
      if (id === requestId.current) { setData(next); setError(null); }
      return next;
    } catch (failure) { if (id === requestId.current) setError(failure); throw failure; }
  }, [period]);
  const intervalMs = data?.intervalMs || 60000;
  useEffect(() => {
    void load().catch(() => {});
    return visibleInterval(() => void load().catch(() => {}), intervalMs);
  }, [load, intervalMs]);
  const refresh = async () => {
    // 始终只刷新今天和当前余额；所看的昨日账本不重算、不登记历史回补。
    const results = await Promise.allSettled([
      api("/api/users", { method: "POST", body: {} }),
      api("/api/refresh", { method: "POST", body: { scope: "upstreams" } }),
      api("/api/reconciliation/query", { method: "POST", body: { preset: "today", observe: true } }),
    ]);
    await load();
    if (results.some((result) => result.status === "rejected")) message.warning("部分数据刷新未完成，请查看各区块的读取时间。 ");
  };
  const range = useMemo(() => <RangePicker value={period} onChange={(value) => setPeriod(value as OverviewPeriod)} tz={data?.tz} range={data?.preset === period ? presetTimeRange(period, { tz: data.tz, now: data.now }) : undefined} options={[{ value: "today", label: "今天" }, { value: "yesterday", label: "昨天" }]} />, [period, data?.tz, data?.preset, data?.now]);
  const headingExtra = useMemo(() => <Button className="jy-ov-heading-info" onClick={() => setDialog("basis")}>数据说明 <Icon name="info" /></Button>, []);
  const subtitle = data && !data.unset ? `${formatDayKey(data.day, data.tz, data.now)} ${weekdayOfDayKey(data.day)} · ${data.preset === "today" ? `截至 ${data.financial.asOf == null ? "未同步" : formatZonedTime(data.financial.asOf, data.tz)}` : "已结束账期"}` : undefined;
  const asOfs = (data?.preset === "yesterday" ? [data?.users?.balanceAt, data?.users?.usageAt] : [data?.financial?.asOf, data?.users?.balanceAt, data?.profit?.asOf ? Date.parse(data.profit.asOf) : null]).filter((value): value is number => value != null && Number.isFinite(value));
  useShellPage({ onRefresh: refresh, range, headingExtra, subtitle, asOf: asOfs.length ? Math.min(...asOfs) : null, autoRefreshMs: intervalMs, tz: data?.tz });
  if (!data) return error ? <ErrorState what="读不到运营总览" error={error} onRetry={() => void load().catch(() => {})} /> : <div className="jy-ov"><PanelSkeleton title="主站经营摘要" lines={3} /><PanelSkeleton title="客户关注" lines={4} /></div>;
  if (data.unset) return <EmptyState title="还没有设置主站" desc="设置主站后，这里显示客户消费、余额提醒和对账进度。" action={<Button href="/my">设置主站</Button>} />;
  const switching = data.preset !== period;
  const time = (value: number | string | null | undefined) => value == null ? "未同步" : formatZonedTime(value, data.tz);
  const current = data.users.customers;
  const reminders = current.filter((user) => user.runwayState === "soon" || user.runwayState === "empty").sort((a, b) => Number(b.runwayState === "empty") - Number(a.runwayState === "empty") || (a.days ?? Infinity) - (b.days ?? Infinity) || (b.today ?? 0) - (a.today ?? 0));
  const ranked = [...current].filter((user) => (user.today ?? 0) > 0).sort((a, b) => (b.today ?? 0) - (a.today ?? 0));
  const shownCustomers = (customerMode === "reminders" ? reminders : ranked).slice(0, 5);
  const days = data.users.trend.filter((day) => day.day <= data.day).slice(-7);
  const hasTrend = days.some((day) => day.available);
  const trendTotal = days.length && days.every((day) => day.available) ? days.reduce((total, day) => total + day.cost, 0) : null;
  const coverage = data.coverage;
  const coverageNote = coverage.total == null ? "昨日完整消费账单尚未同步" : coverage.covered == null
    ? coverage.timeWindowState === "different" ? "账单时间范围与主站昨日不一致，暂不比较金额" : coverage.timeWindowState === "unknown" ? "账单时间范围尚未确认，暂不比较金额" : "昨日对账进度尚未读全"
    : coverage.total === 0 ? "昨日没有客户消费" : "已同步的客户消费均已进入对账";
  const profit = data.profit?.accountingTotals;
  const supplierViews = data.upstreams.filter((station) => station.type !== "fixed").map((station) => ({ station, view: balanceViewOf(station, { settings: data.settings, rules: data.rules }) }))
    .sort((a, b) => Number(b.view.state === "unreadable") - Number(a.view.state === "unreadable") || (a.view.days ?? Infinity) - (b.view.days ?? Infinity));
  const showCustomers = (mode: "reminders" | "ranking") => { setCustomerMode(mode); customersRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const dayLabel = formatDayKey(data.day, data.tz, data.now);
  const userHref = (user: { id: number }) => `/users?tab=users&user=${user.id}`;
  const figure = (amount: number | null | undefined) => {
    const [sign, value] = formatUsd(amount).split("$");
    return value == null ? sign : <>{sign}<span className="jy-ov-currency">$</span>{value}</>;
  };
  return <div className={`jy-ov${switching ? " is-switching" : ""}`} aria-busy={switching}>
    {error && <p className="jy-ov-notice" role="alert">刷新未完成，保留上一次数据。<Button type="link" onClick={() => void load().catch(() => {})}>重新读取</Button></p>}
    <section className="jy-ov-metrics" aria-label="主站经营摘要">
      <div className="jy-ov-metric is-lead"><span className="jy-ov-label">客户消费 <small>{data.preset === "today" ? "今天" : "昨天"}</small></span><strong className="jy-ov-value jy-num">{figure(data.financial.amount)}</strong><span className="jy-caption">{data.financial.amount == null ? data.financial.reason : `主站消费账单 · ${data.preset === "today" ? time(data.financial.asOf) : "全天"}`}</span></div>
      <button className="jy-ov-metric" onClick={() => data.preset === "today" ? showCustomers("ranking") : setDialog("activity")}><span className="jy-ov-label">消费客户</span><strong className="jy-ov-value jy-num">{data.users.activity?.count ?? EMPTY}<small>位</small></strong><span className="jy-caption">有实际消费的普通客户 →</span></button>
      <button className="jy-ov-metric" onClick={() => showCustomers("reminders")}><span className="jy-ov-label">当前需提醒客户</span><strong className={`jy-ov-value jy-num${data.users.reminderCount ? " jy-ov-danger" : ""}`}>{data.users.reminderCount ?? EMPTY}<small>位</small></strong><span className="jy-caption">{data.users.balanceReady ? `${reminders.filter((user) => user.big).length} 位重点客户需关注 →` : "余额预测数据尚未齐全"}</span></button>
      <button className="jy-ov-metric" onClick={() => setDialog("profit")}><span className="jy-ov-label">已对账毛利 <Icon name="info" /></span><strong className="jy-ov-value jy-num">{figure(profit?.gross)}</strong><span className="jy-caption">仅已计入渠道 · {time(data.profit?.asOf)}</span></button>
    </section>
    {(coverage.missing == null || coverage.missing > 0) && <div className="jy-ov-attention-strip"><i className="jy-ov-status-mark" aria-hidden="true" /><p><strong>{coverage.missing == null ? "昨日对账进度待确认" : "昨日对账尚未齐全"}</strong><span>{coverage.missing == null ? coverageNote : coverage.missingChannels.some((channel) => channel.status === "unlinked") ? "有消费渠道待接入，查看未计入金额" : "部分渠道账单未读全，查看未计入金额"}</span></p><button className="jy-ov-text-button" onClick={() => setDialog("coverage")}>查看缺口 <span aria-hidden="true">→</span></button></div>}
    {(data.financial.amount == null || Object.keys(data.errors).length > 0 || data.users.paused || data.users.syncErrors.length > 0) && <div className="jy-ov-notice"><Icon name="info" /><span>{data.users.paused ? "客户数据同步已暂停。" : data.users.syncErrors.length > 0 ? "客户余额或消费更新未完成，请查看各区块的读取时间。" : data.financial.amount == null ? "全站消费账单尚未完整同步，普通客户用量仍可独立查看。" : "部分区块暂时读不到，请查看读取时间。"}</span><Link href="/settings">查看同步设置 →</Link></div>}
    <div className="jy-ov-dashboard">
      <Panel title="客户用量趋势" sub="普通客户 · 最近 7 天" className="jy-ov-trend" extra={<Seg<"cost" | "users"> label="趋势指标" value={metric} onChange={setMetric} size="sm" options={[{ value: "cost", label: "消费" }, { value: "users", label: "客户数" }]} />} foot={<div className="jy-ov-foot"><span><i className="jy-ov-legend-mark is-current" aria-hidden="true" />{days.some((day) => day.day === data.today) ? "今天进行中，尚非全天" : "已结束日期 · 全天汇总"}</span><button className="jy-ov-text-button" aria-label="每日数据 →" onClick={() => setDialog("days")}>每日数据 <Icon name="expand" /></button></div>}>
        {hasTrend ? <><div className="jy-ov-chart-summary"><strong className="jy-num">{metric === "cost" ? formatUsd(trendTotal) : data.users.activity?.count ?? EMPTY}</strong><span className="jy-ov-chart-unit">{metric === "cost" ? "近 7 天普通客户消费" : `${dayLabel}消费客户`}</span><span className="jy-ov-chart-period">{data.preset === "today" ? `今天截至 ${time(data.users.usageAt)}` : "7 个已结束的完整日"}</span></div><OverviewChart key={`${data.preset}-${metric}`} days={days} metric={metric} today={data.today} /></> : <EmptyState title="客户用量还未同步" desc="先显示已同步的余额，消费趋势由后台更新。" />}
      </Panel>
      <Panel title="昨日对账进度" sub={`${formatDayKey(coverage.day, data.tz, data.now)} · 已结束账期`} className="jy-ov-coverage" extra={<Button type="text" size="small" aria-label="查看昨日对账进度说明" onClick={() => setDialog("coverage")}>→</Button>}>
        <div className="jy-ov-coverage-value"><strong className="jy-num">{formatPct(coverage.ratio)}</strong><span className="jy-caption">客户消费已纳入对账</span></div>
        {coverage.ratio != null && <div className="jy-ov-coverage-track" role="img" aria-label={`昨日${formatPct(coverage.ratio)}客户消费已纳入对账`}><span style={{ width: `${Math.max(0, Math.min(100, coverage.ratio * 100))}%` }} /><i /></div>}
        <dl className="jy-ov-amounts"><div><dt><i className="jy-ov-legend-mark" aria-hidden="true" />已纳入对账</dt><dd>{formatUsd(coverage.covered)}</dd></div><div><dt><i className="jy-ov-legend-mark is-gap" aria-hidden="true" />尚未计入</dt><dd className={coverage.missing ? "jy-ov-warning" : ""}>{formatUsd(coverage.missing)}</dd></div></dl>
        {coverage.missingChannels.length > 0 ? <button className="jy-ov-callout" onClick={() => setDialog("coverage")}><span><strong>{coverage.missingChannels.length} 个有消费渠道{coverage.missingChannels.every((channel) => channel.status === "unlinked") ? "待接入" : "未计入对账"}</strong><small>{coverage.missingChannels.slice(0, 2).map((channel) => channel.name).join("、")}{coverage.missingChannels.length > 2 && " 等"}</small></span><Icon name="expand" /></button> : <p className="jy-caption">{coverageNote}</p>}
        <p className="jy-caption jy-ov-coverage-note">毛利仅来自已计入渠道，不代表全站利润。</p>
      </Panel>
      <div ref={customersRef} className="jy-ov-customer-wrap"><Panel title="客户关注" sub={`当前余额 · ${time(data.users.balanceAt)} 更新`} body="flush" className="jy-ov-customers" extra={<Seg<"reminders" | "ranking"> label="客户列表" value={customerMode} onChange={setCustomerMode} size="sm" options={[{ value: "reminders", label: `需提醒 ${data.users.reminderCount ?? EMPTY}` }, { value: "ranking", label: "今日消费榜" }]} />} foot={<div className="jy-ov-foot"><span>{customerMode === "reminders" ? "先显示快用完的，再按今天消费排序" : "按今天消费从高到低"}</span><Link className="jy-ov-text-button" href={`/users?tab=users&scope=all${customerMode === "reminders" ? "&only=soon" : ""}`}>查看客户 →</Link></div>}>
        {shownCustomers.length > 0 ? <table className="jy-data jy-ov-customer-table"><thead><tr><th>客户</th><th className="r">今天消费</th><th className="r">当前余额</th><th className="r"><button className="jy-ov-help" onClick={() => setDialog("basis")} aria-label="预计可用时间怎么算">预计可用 <Icon name="info" /></button></th><th><span className="jy-ov-sr-only">操作</span></th></tr></thead><tbody>{shownCustomers.map((user) => <tr key={user.id}><td><Link className="jy-ov-customer-name" href={userHref(user)}><span className={`jy-ov-avatar tone-${user.id % 3}`} aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><span><strong>{user.username}</strong><small>{user.big ? "重点客户" : user.runwayState === "empty" ? "余额已用完" : customerMode === "ranking" ? "今日有消费" : "余额需要关注"}</small></span></Link></td><td className="r jy-num">{formatUsd(user.today)}</td><td className="r jy-num">{formatUsd(user.balanceUsd)}</td><td className={`r${user.runwayState === "soon" || user.runwayState === "empty" ? " jy-ov-danger" : ""}`}>{user.runwayState === "empty" ? "余额已用完" : formatDays(user.days)}</td><td><Link className="jy-ov-row-arrow" href={userHref(user)} aria-label={`查看 ${user.username} 详情`}><Icon name="expand" /></Link></td></tr>)}</tbody></table> : <EmptyState title={!data.users.balanceReady && customerMode === "reminders" ? "余额预测数据尚未齐全" : !data.users.ready ? "客户消费尚未同步" : customerMode === "reminders" ? "暂时没有需要提醒的客户" : "今天还没有客户消费"} />}
      </Panel></div>
      <Panel title="上游余量" sub="预计最先用完的上游" body="flush" className="jy-ov-suppliers" extra={<Link className="jy-caption-link" href="/stations">全部 {supplierViews.length} 个 <Icon name="expand" /></Link>} foot={<div className="jy-ov-foot"><span>按现有花费速度估算</span><span>当前余额</span></div>}>
        {supplierViews.length ? <ul className="jy-ov-supplier-list">{supplierViews.slice(0, 3).map(({ station, view }) => <li key={station.id}><button onClick={() => setTrendStation(station)} title={`${stationDisplayName(station)} · 余额读取于 ${time(station.balance?.checkedAt)}`}><span className="jy-ov-supplier-top"><strong>{stationDisplayName(station)}</strong><span className={view.level === "crit" ? "jy-ov-danger" : view.level === "warn" ? "jy-ov-warning" : ""}>{view.state === "unreadable" ? "余额读不到" : view.state === "pending" ? "未同步" : view.state === "empty" ? "余额已用完" : balanceDaysText(view)}</span></span><span className="jy-ov-supplier-bottom"><span>余额 {station.balance?.ok ? balanceMoneyOf(station, station.balance.remaining).text : EMPTY}</span>{view.days != null && Number.isFinite(view.days) && <span className="jy-ov-runway-track" aria-label={`预计可用${balanceDaysText(view)}，短条最多显示7天`}><i style={{ width: `${Math.min(view.days / 7 * 100, 100)}%` }} /></span>}</span></button></li>)}</ul> : <EmptyState title="还没有在监测的余额上游" action={<Button href="/stations">添加上游</Button>} />}
      </Panel>
    </div>
    <footer className="jy-ov-data-footer"><span><i className={`jy-ov-sync-dot${data.users.paused || !data.users.fresh || data.users.syncErrors.length ? " is-waiting" : ""}`} aria-hidden="true" />{data.users.paused ? "客户同步已暂停" : data.users.fresh && !data.users.syncErrors.length ? "客户数据已同步" : "客户数据等待更新"}</span><span>消费账单 {time(data.financial.asOf)}</span><span>客户余额 {time(data.users.balanceAt)}</span><button className="jy-ov-text-button" onClick={() => setDialog("basis")}>服务质量监测未启用 <Icon name="info" /></button></footer>
    <Modal open={dialog != null} onCancel={() => setDialog(null)} footer={null} title={dialog === "coverage" ? "昨日对账进度" : dialog === "profit" ? "已对账毛利" : dialog === "activity" ? `${dayLabel}消费客户` : dialog === "days" ? "最近7天客户用量" : "数据说明与预测说明"}>
      {dialog === "basis" && <div className="jy-ov-dialog"><p>客户消费取自已记录的主站消费账单，扣除管理员自用和渠道测试，明确标记转售的管理员 Key 消费继续计入。金额单位与主站保持一致，默认 1:1。</p><p>客户用量趋势与消费榜来自普通客户用量汇总，与消费账单分别读取，不代替财务收入。余额始终显示当前状态。</p><p>预计可用时间沿用已有余额预测：比较近24小时与近7天的余额花费速度，采用较快者；充值带来的余额上涨不当成负消费。它不以表格中的今天消费直接相除，也不代表实际用完时间承诺。</p><p>首页只读取已同步结果；历史账单不会因进入首页或切换日期自动补算。</p><p>服务质量监测尚未启用；当前余额与账单状态不能代表所有业务请求均正常。</p><Link href="/settings">查看数据同步设置 →</Link></div>}
      {dialog === "profit" && <div className="jy-ov-dialog"><p>{dayLabel} · 仅计算已接入渠道 · 读取于 {time(data.profit?.asOf)}</p><dl className="jy-ov-amounts"><div><dt>已对账收入</dt><dd>{formatUsd(profit?.income)}</dd></div><div><dt>对应上游成本</dt><dd>{formatUsd(profit?.actual)}</dd></div><div><dt>已对账毛利</dt><dd>{formatUsd(profit?.gross)}</dd></div></dl><p>全站客户消费与部分渠道毛利分别展示，未计入渠道的成本尚未计算，不能据此代表全站利润。</p><Link href={`/reconciliation?preset=${data.preset}`}>查看每日利润 →</Link></div>}
      {dialog === "coverage" && <div className="jy-ov-dialog"><p>{formatDayKey(coverage.day, data.tz, data.now)} · 完整消费账单截至 {time(coverage.asOf)}</p><p>已计入 {coverage.counted ?? EMPTY} / {coverage.known ?? EMPTY} 个渠道。</p><dl className="jy-ov-amounts"><div><dt>客户消费</dt><dd>{formatUsd(coverage.total)}</dd></div><div><dt>尚未计入对账</dt><dd>{formatUsd(coverage.missing)}</dd></div></dl>{coverage.missingChannels.length ? <table className="jy-data"><thead><tr><th>渠道</th><th className="r">客户消费</th><th>处理</th></tr></thead><tbody>{coverage.missingChannels.map((channel) => <tr key={channel.channelId}><td>{channel.name}</td><td className="r">{formatUsd(channel.amount, { dp: channel.amount > 0 && channel.amount < .01 ? 6 : 2 })}</td><td><Link href={channel.status === "unlinked" ? `/stations?action=connect&ownStationId=${data.own.id}&channelIds=${channel.channelId}` : "/reconciliation?preset=yesterday"}>{channel.status === "unlinked" ? "接入渠道 →" : "查看账单 →"}</Link></td></tr>)}</tbody></table> : <p>{coverageNote}</p>}<Link href="/reconciliation?preset=yesterday">查看昨日账单 →</Link></div>}
      {dialog === "activity" && <div className="jy-ov-dialog"><p>{dayLabel} · 普通客户用量统计。以下为消费最多的客户。</p>{data.users.activity?.top.map((user) => {
        const customer = current.find((item) => item.username === user.username);
        return <p key={user.username}><Link href={customer ? userHref(customer) : "/users?tab=users"}>{user.username}{!customer && "（客户列表）"}</Link><strong className="jy-num">　{formatUsd(user.cost)}</strong></p>;
      })}<Link href="/users?tab=users">查看客户页面 →</Link></div>}
      {dialog === "days" && <div className="jy-ov-dialog"><p>普通客户用量统计，与主站消费账单分别读取。</p><table className="jy-data"><thead><tr><th>日期</th><th className="r">消费</th><th className="r">消费客户</th></tr></thead><tbody>{days.map((day) => <tr key={day.day}><td>{day.day}{day.day === data.today ? " · 进行中" : ""}</td><td className="r">{day.available ? formatUsd(day.cost) : EMPTY}</td><td className="r">{day.available ? day.users : EMPTY}</td></tr>)}</tbody></table></div>}
    </Modal>
    <TrendModal station={trendStation} onClose={() => setTrendStation(null)} settings={data.settings} rules={data.rules} tz={data.tz} />
  </div>;
}
