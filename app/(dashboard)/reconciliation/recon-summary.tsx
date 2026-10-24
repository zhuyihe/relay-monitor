"use client";
// 汇总、没算进利润的上游成本、算一天的时区不同时的分组小计、渠道。
// 金额按服务端定的显示币种（totals.display）汇总；stale 时数字是之前读到的（刷新失败或还在读取），旁边写「数据截至」；
// 换了日期范围还没读回来时，旧数字属于别的日期，不显示，用骨架占位。
// 用语按 design/ui-copy-spec.md §5.6、§11：不显示内部 ID、来源和计法。
import { Alert, Button, Collapse } from "antd";
import Link from "next/link";
import { Panel } from "../../components/panel";
import { Skeleton } from "../../components/data-state";
import { ErrorDetail } from "../../components/error-detail";
import { StatusTag } from "../../components/status";
import type { KnownChannelCoverage, ReconciliationCurrency, ReconciliationDisplayTotals, ReconciliationSummary, ReconciliationWindowGroup, UnaccountedUpstream } from "../../../lib/client";
import { EMPTY, RATE_UNSET_USD, formatAsOf, formatDayZone, formatPct, formatRate, refreshFailedText } from "../../../lib/format";
import { reconciliationChannelStatus, reconciliationCoverageText, reconciliationIssue } from "../../../lib/reconciliation-contract";
import { reconciliationChannelName, reconciliationChannelTag, reconciliationNotCountedText } from "../../../lib/reconciliation-view";
import { NAV_LABELS } from "../../../lib/brand";
import { SummaryMetric } from "./recon-parts";
import { RECON_BUTTONS, amountText, formatWindow, isLivePreset } from "./recon-format";

// 汇总不是这次读到的（§8.1）：failed 刷新失败，写「刷新失败，数据截至 14:30。」[刷新]，原文收进「查看详细原因」；
// reading 还在读，数字照旧、写「读取中」；switching 换了日期范围还没读回来，数字不显示
export type SummaryStale = { kind: "switching" | "failed" | "reading"; asOf?: number | null; timezone?: string; raw?: string } | null;
const staleText = (stale: NonNullable<SummaryStale>) => stale.kind !== "failed" ? "读取中" : refreshFailedText(stale.asOf, stale.timezone);

// 旧响应没有 display 时按美元显示
function displayTotals(totals: ReconciliationWindowGroup["totals"]): ReconciliationDisplayTotals {
  return totals.display || { currency: "USD", knownIncome: totals.knownIncomeUsd, knownCost: totals.knownCostUsd, confirmedProfit: totals.confirmedProfitUsd, confirmedMarginRate: totals.confirmedMarginRate };
}

function WindowMetrics({ totals }: { totals: ReconciliationWindowGroup["totals"] }) {
  const display = displayTotals(totals);
  return <div className="reconciliation-summary__metrics">
    <SummaryMetric label="收入" value={amountText(display.knownIncome, display.currency)} />
    <SummaryMetric label="上游成本" value={amountText(display.knownCost, display.currency)} />
    <SummaryMetric label="毛利" value={amountText(display.confirmedProfit, display.currency)} />
    <SummaryMetric label="毛利率" value={formatPct(display.confirmedMarginRate)} />
  </div>;
}

// 没算进利润的上游成本的状态（§7、§11）：读全了不加标签；估算在数字前加「≈」
const UNACCOUNTED_STATE_LABEL: Record<string, string> = { partial: "没读全", pending: "读取中", unavailable: "读不到" };
const unaccountedTag = (state: string) => state === "complete" || state === "estimated" ? null
  : <StatusTag level={state === "pending" ? "info" : "warn"}>{UNACCOUNTED_STATE_LABEL[state] || EMPTY}</StatusTag>;
const approx = (state: string, text: string) => state === "estimated" && text !== EMPTY ? `≈ ${text}` : text;

// 上游扣费减去已算进利润的上游成本：没绑定的 Key、测试和自用的花费都落在这里。
// rereading：读取中时页面还会自动再读；次数用完后提示点「刷新」。差额的原因写在各上游的说明里（view 的 notes）。
function UnaccountedUpstreamBlock({ data, rereading }: { data: UnaccountedUpstream; rereading: boolean }) {
  const { currency } = data;
  const pending = data.state === "pending";
  const over = data.accounts.some((account) => (account.unaccounted ?? 0) < 0);
  // 截至现在的日期范围里，上游扣费按上次读到的时间截止，和这次读取可能差几分钟
  const live = isLivePreset(data.window.preset);
  const stationNames = (stations: { name: string }[]) => stations.map((station) => station.name).join("、");
  return <section className="reconciliation-unaccounted" aria-label="没算进利润的上游成本">
    <div className="reconciliation-unaccounted__head">
      <SummaryMetric label="没算进利润的上游成本" value={pending ? "读取中" : approx(data.state, amountText(data.total, currency))} />
      {pending ? null : unaccountedTag(data.state)}
    </div>
    <p className="jy-caption">
      上游扣费（和「{NAV_LABELS.my}」读的是同一个数）减去已算进利润的上游成本。
      {pending ? (rereading ? `${reconciliationIssue("UPSTREAM_DATA_UNAVAILABLE").hint}。` : `上游暂时读不到，可以点「${RECON_BUTTONS.refresh}」再读。`)
        : data.state === "estimated" ? "≈ 部分上游按余额变化估算。" : data.state === "partial" ? "部分上游没读全。" : ""}
      {!pending && over ? "有的上游已算进利润的多于上游扣费，合计里按 0 算。" : ""}
      {data.fixedStations.length ? `计入固定成本的上游不在这里：${stationNames(data.fixedStations)}。` : ""}
      {data.excludedStations.length ? `不算进利润的上游不在这里：${stationNames(data.excludedStations)}（绑在${data.excludedStations.length > 1 ? "它们" : "它"}上面的 Key 仍按用量算上游成本）。` : ""}
    </p>
    {data.accounts.length ? <Collapse className="reconciliation-coverage__list" items={[{
      key: "unaccounted-accounts",
      label: "查看各上游",
      children: <ul className="reconciliation-coverage__channels">
        {data.accounts.map((account) => {
          const accountPending = account.state === "pending";
          const asOf = live && account.endMs ? formatAsOf(account.endMs, data.window.timezone) : "";
          const caption = [account.rate ? formatRate(account.rate) : "", asOf, ...account.notes].filter(Boolean).join("；");
          return <li key={account.stationId} className="reconciliation-coverage__channel">
            <div className="reconciliation-coverage__heading">
              <strong>{account.name}</strong>
              {unaccountedTag(account.state)}
            </div>
            <span>
              上游扣费 {accountPending ? "读取中" : approx(account.state, amountText(account.account, currency))}
              {" · "}已算进利润 {amountText(account.accounted, currency)}
              {" · "}没算进利润 {accountPending ? EMPTY : approx(account.state, amountText(account.unaccounted, currency))}
            </span>
            {caption ? <span className="jy-caption">{caption}</span> : null}
          </li>;
        })}
      </ul>,
    }]} /> : null}
  </section>;
}

// fixedCost：本页有包月上游上的绑定，它们的上游成本写「计入固定成本」，费用在自营业务页按天平摊。
// fixedOffProfit：其中暂停监控、不算进利润或已归档的上游，自营业务页也不算它们的固定成本，单独点名。
// preset：当前日期范围；「今天」带到自营业务页，其余用它的默认范围（近 7 天）。
// grouped：没法放在一起汇总（算一天的时区不同、或有绑定的来源还没确认），分组小计写在下面。
export function ReconSummary({ summary, results, coverage, currency, grouped = false, unaccounted, usageRereading = false, stale, onRefresh, fixedCost = false, fixedOffProfit = [], preset }: {
  summary: ReconciliationSummary | null; results: any[]; coverage: KnownChannelCoverage | null; currency: ReconciliationCurrency; grouped?: boolean;
  unaccounted?: UnaccountedUpstream | null; usageRereading?: boolean; stale: SummaryStale; onRefresh?: () => void;
  fixedCost?: boolean; fixedOffProfit?: string[]; preset?: string;
}) {
  if (stale?.kind === "switching") {
    return <Panel title="汇总" className="reconciliation-summary">
      <div aria-busy="true" className="jy-stack" style={{ gap: 10 }}>
        <span className="sr-only">读取中</span>
        <Skeleton height={44} />
        <Skeleton width="60%" />
      </div>
    </Panel>;
  }
  const coverageText = reconciliationCoverageText(summary?.coverage || coverage);
  // 汇总那组的窗口（带时区和预设），用来判断这段时间是不是只有一天
  const range = results[0]?.requestedWindow || results[0]?.window;
  const attentionNote = summary ? reconciliationNotCountedText(summary.totals, range) : "";
  const note = <>
    {coverageText ? `${coverageText}。` : ""}
    {currency === "CNY" ? "按各自设置的汇率换算成人民币（已固定的日子按固定时记下的汇率）。" : `${RATE_UNSET_USD}。`}
    {preset && isLivePreset(preset) ? "今天的数字还会变，过了零点自动固定。" : ""}
    {fixedCost ? <>包月上游的上游成本写「计入固定成本」；扣掉固定成本后的净利见<Link href={preset === "today" ? "/my?range=today" : "/my"}>{NAV_LABELS.my}</Link>。
      {fixedOffProfit.length ? `其中${fixedOffProfit.map((name) => `「${name}」`).join("、")}暂停监控、不算进利润或已归档，${NAV_LABELS.my}也不算${fixedOffProfit.length > 1 ? "它们" : "它"}的固定成本。` : ""}</> : null}
  </>;
  return <Panel title="汇总" className="reconciliation-summary" foot={note}>
    {stale ? <Alert
      type={stale.kind === "failed" ? "warning" : "info"} showIcon title={staleText(stale)}
      description={stale.raw ? <ErrorDetail raw={stale.raw} /> : undefined}
      action={stale.kind === "failed" && onRefresh ? <Button size="small" onClick={onRefresh}>{RECON_BUTTONS.refresh}</Button> : undefined}
    /> : null}
    {summary ? <>
      <WindowMetrics totals={summary.totals} />
      {attentionNote ? <p className="jy-caption">{attentionNote}</p> : null}
      {unaccounted ? <UnaccountedUpstreamBlock data={unaccounted} rereading={usageRereading} /> : null}
    </> : <p className="reconciliation-summary__empty">{EMPTY}{grouped ? <span className="jy-caption">这几条绑定没法放在一起汇总，分开写在下面</span> : null}</p>}
  </Panel>;
}

// 绑定算一天的时区或起止不同时逐组列出，组内金额只在本组里相加；和业务时区一样的组不写时区
// 有共同汇总时只有一组，就是上面的汇总，不再列出
export function ReconWindowGroups({ groups, results, businessTimezone, stale }: {
  groups: ReconciliationWindowGroup[]; results: any[]; businessTimezone?: string; stale: boolean;
}) {
  if (!groups.length) return null;
  return <Collapse className="reconciliation-window-groups" items={groups.map((group) => {
    const timezone = group.timezones[0];
    const zone = group.timezones.length === 1 ? formatDayZone(timezone, businessTimezone) : "";
    const coverageText = reconciliationCoverageText(group.coverage);
    // 「其中 N 条绑定…」说的是这组的绑定，单独一行，紧跟在三个数下面，不接在渠道那句后面
    const attentionNote = reconciliationNotCountedText(group.totals, { ...group.window, timezone });
    return {
      key: group.groupKey,
      label: <span>{formatWindow({ ...group.window, timezone })}{zone ? ` · ${zone}` : ""}{stale ? " · 数据可能不是最新" : ""}</span>,
      children: <div className="reconciliation-window-group">
        <WindowMetrics totals={group.totals} />
        {attentionNote ? <p className="jy-caption">{attentionNote}</p> : null}
        {coverageText ? <p className="jy-caption">{coverageText}。</p> : null}
      </div>,
    };
  })} />;
}

// 渠道汇总按全部渠道算，不随搜索、筛选和翻页变化；默认收起，只看没算进来的
export function ReconCoverage({ coverage }: { coverage: KnownChannelCoverage | null }) {
  const title = reconciliationCoverageText(coverage);
  if (!coverage || !title) return null;
  const pending = coverage.channels.filter((channel) => channel.status !== "accounted");
  return <section className="reconciliation-coverage" aria-label="渠道">
    <Alert type={pending.length ? "warning" : "success"} showIcon title={title} />
    {pending.length ? <Collapse className="reconciliation-coverage__list" items={[{
      key: "known-coverage",
      label: "查看没算进来的",
      children: <ul className="reconciliation-coverage__channels">
        {pending.map((channel, index) => {
          const tag = reconciliationChannelTag(channel);
          const status = reconciliationChannelStatus(channel.status, { channel: reconciliationChannelName(channel) }, channel.issues);
          return <li key={`${channel.ownSource?.namespaceKey || channel.ownStationId}:${channel.channelId}:${index}`} className="reconciliation-coverage__channel">
            <div className="reconciliation-coverage__heading">
              <strong>{reconciliationChannelName(channel)}</strong>
              <StatusTag level={status.needsAction ? "warn" : "info"}>{status.label}</StatusTag>
              {tag ? <StatusTag level="warn">{tag}</StatusTag> : null}
            </div>
            {status.reason || channel.reason ? <span>{status.reason || channel.reason}</span> : null}
            {channel.actions.length ? <div className="reconciliation-coverage__actions">
              {channel.actions.map((action) => <Button key={action.id} size="small" href={action.href}>{action.label}</Button>)}
            </div> : null}
          </li>;
        })}
      </ul>,
    }]} /> : null}
  </section>;
}
