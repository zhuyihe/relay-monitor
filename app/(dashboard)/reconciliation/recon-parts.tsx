"use client";
// 每日利润页的小部件：明细项、行状态、汇总数字、处理按钮、各渠道收入、倍率变化、手机上的绑定卡片。
// 只负责展示，数据和动作都由页面传入；状态、标签和文案来自 lib/reconciliation-view（design/ui-copy-spec.md §4）。
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Alert, Button, Table } from "antd";
import type { ButtonProps } from "antd";
import { RightOutlined } from "@ant-design/icons";
import { StatusTag } from "../../components/status";
import { ErrorDetail } from "../../components/error-detail";
import type { Level } from "../../components/status";
import { EMPTY, formatPct } from "../../../lib/format";
import {
  hasReconciliationHistory,
  mergeReconciliationChannels,
  reconciliationBillingText,
  reconciliationCalculationValues as calculationValues,
  reconciliationChannelName,
  reconciliationChannelTag,
  reconciliationRowFlags,
} from "../../../lib/reconciliation-view";
import {
  RECON_BUTTONS, RECON_COPY, RETRY_FAILED_TEXT, amountText, channelStateSummary, costText, currentGroup, currentRatioLabel, formatWindow, incomeText, ratioLabel, ruleHistory, segmentPeriod,
  segmentTimingLabel, sideRate, upstreamName,
} from "./recon-format";
import type { ReconciliationCurrency } from "../../../lib/client";
import { RecheckConsumeLogButton } from "../../components/recheck-consume-log";

// 三种状态和标签的颜色：需处理提醒、实时是信息、已固定是好的；亏损用红，金额本身不变色（§4、§7）
const STATE_LEVEL: Record<string, Level> = { action: "warn", live: "info", settled: "good" };

export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return <div className="reconciliation-detail">
    <span className="reconciliation-detail__label">{label}</span>
    <span className="reconciliation-detail__value">{value}</span>
  </div>;
}

// 不认识的问题码只写进浏览器控制台，界面上写「这条暂时算不出利润」（§5.5）
function useReportUnknownCode(code?: string) {
  useEffect(() => {
    if (code) console.warn(`[每日利润] 不认识的问题码：${code}`);
  }, [code]);
}

// 一行的状态：需处理 / 实时 / 已固定，下面一句原因或提示；固定时间放在悬停里
export function RowStatus({ item, currency }: { item: any; currency: ReconciliationCurrency }) {
  const status = reconciliationRowFlags(item, currency).displayStatus;
  useReportUnknownCode(status.code);
  // 整天在开始统计之前（C②）：不是状态，状态那一格写灰字，下面一句从哪天开始
  if (status.state === "not_started") return <span className="reconciliation-status-stack">
    <small className="reconciliation-status-note">{status.label}</small>
    {status.note ? <small className="reconciliation-status-note">{status.note}</small> : null}
  </span>;
  const note = status.state === "action" ? status.title : status.note || status.hints?.[0]?.text || "";
  return <span className="reconciliation-status-stack" title={status.state === "settled" ? status.note : undefined}>
    <span className="reconciliation-status-tags">
      <StatusTag level={STATE_LEVEL[status.state] || "info"}>{status.label}</StatusTag>
      {status.revised ? <StatusTag level="info">改过</StatusTag> : null}
    </span>
    {note ? <small className="reconciliation-status-note">{note}</small> : null}
    {status.state === "action" && status.moreCount > 0 ? <small className="reconciliation-status-note">{RECON_COPY.moreIssues(status.moreCount)}</small> : null}
  </span>;
}

export const LossTag = ({ show }: { show: boolean }) => show ? <StatusTag level="crit">亏损</StatusTag> : null;

export function SummaryMetric({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return <div className="reconciliation-summary-metric">
    <span className="reconciliation-summary-metric__label">{label}</span>
    <strong className="reconciliation-summary-metric__value">{value}</strong>
    {children}
  </div>;
}

// 需处理的那个按钮（§3.5）：去别的页面处理的直接跳转；改时间打开计算明细。
// 重新读取、刷新这两种页面上本来就有按钮，这里不重复。列表里每行都有一个，传 target（Key 名）让读屏分得清是哪一行。
export function IssueAction({ action, onDetail, target, ...button }: { action: any; onDetail?: () => void; target?: string } & Omit<ButtonProps, "href" | "onClick">) {
  if (!action || !action.label || action.kind === "retry_bill" || action.kind === "refresh") return null;
  // 重新检查：点了才马上再读一次自营站点的设置（三处入口同一个按钮）
  if (action.kind === "recheck_consume_log") return <RecheckConsumeLogButton {...button} />; // label 空：这一天碰到过自营站点没记收费记录的那段，没有按钮
  const label = target ? `${action.label} ${target}` : undefined;
  if (action.href) return <Button {...button} aria-label={label} href={action.href}>{action.label}</Button>;
  return onDetail ? <Button {...button} aria-label={label} onClick={onDetail}>{action.label}</Button> : null;
}

export function ChannelBreakdown({ item, currency }: { item: any; currency: ReconciliationCurrency }) {
  const rate = sideRate(item, "income", currency);
  const channels = mergeReconciliationChannels(item?.rule?.channels, item?.downstream?.channels);
  if (!channels.length) return <p className="jy-caption">{RECON_COPY.noChannels}。</p>;
  return (
    <div className="reconciliation-channel-list">
      {channels.map((channel: any) => {
        const tag = reconciliationChannelTag(channel);
        return <div key={channel.channelId || channel.id || channel.name} className="reconciliation-channel">
          <div className="reconciliation-channel__name">
            <strong>{reconciliationChannelName(channel)}</strong>
            <small>收入占比 {formatPct(channel.share)}</small>
          </div>
          <div className="reconciliation-channel__figures">
            <strong>{reconciliationBillingText({ state: channel.billingState, amountUsd: channel.amountUsd, knownAmountUsd: channel.knownAmountUsd }, rate)}</strong>
            {tag ? <StatusTag level="warn">{tag}</StatusTag> : null}
          </div>
        </div>;
      })}
    </div>
  );
}

// 倍率变化：每次变化一行，金额只算所选日期里的部分；时间是系统估的可以去改。keyName 是列表里这把 Key 的名字（同名的已加编号）
export function SegmentHistory({ item, keyName, currency, compact, onDetail }: { item: any; keyName: string; currency: ReconciliationCurrency; compact: boolean; onDetail: () => void }) {
  const timezone = item.window?.timezone || item.rule?.timezone;
  const segments = ruleHistory(item).slice().reverse();
  // 每段用这条绑定的汇率和成本算法
  const rows = segments.map((segment: any) => {
    const priced = { ...segment, rates: item.rates };
    return { ...priced, values: calculationValues(segment.calculation, segment.health, priced, currency) };
  });
  const inRange = (row: any, text: ReactNode) => row.window ? text : EMPTY;
  const profitText = (row: any) => row.values.confirmed ? amountText(row.values.profit, row.values.currency) : EMPTY;
  const timing = (row: any) => row.timingSource === "detected"
    ? <span className="reconciliation-history-timing">{segmentTimingLabel(row)}<Button type="link" size="small" onClick={onDetail}>{RECON_BUTTONS.correctTiming}</Button></span>
    : segmentTimingLabel(row);
  const columns: any[] = [
    { title: "时间", key: "period", width: 225, render: (_: any, row: any) => <span className="reconciliation-history-period"><strong>{segmentPeriod(row, timezone)}</strong><small>{row.window ? `算进 ${formatWindow(row.window)}` : "不在所选日期内"}</small></span> },
    { title: "分组 / 倍率", key: "group", width: 160, render: (_: any, row: any) => <span className="reconciliation-history-group"><strong>{row.group || EMPTY}</strong><small>{ratioLabel(row.ratio)}</small></span> },
    { title: "收入", key: "income", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{inRange(row, incomeText(row, currency))}</span> },
    { title: "上游成本", key: "cost", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{inRange(row, costText(row, currency))}</span> },
    { title: "毛利", key: "profit", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{inRange(row, profitText(row))}</span> },
    { title: "毛利率", key: "margin", width: 100, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{inRange(row, row.values.confirmed ? formatPct(row.values.margin) : EMPTY)}</span> },
    { title: "变化时间", key: "timing", width: 200, render: (_: any, row: any) => timing(row) },
  ];

  return <section className="reconciliation-history" aria-label={`${keyName} 的倍率变化`}>
    <div className="reconciliation-history__intro"><strong>倍率变化 · {rows.length - 1} 次</strong><span>金额只算所选日期里的部分。</span></div>
    {compact ? <div className="reconciliation-history-mobile">
      {rows.map((row: any) => <div key={row.id} className="reconciliation-history-mobile__row">
        <div className="reconciliation-history-mobile__heading"><strong>{row.group || EMPTY} · {ratioLabel(row.ratio)}</strong><span>{segmentTimingLabel(row)}</span></div>
        <div className="reconciliation-history-mobile__period">{segmentPeriod(row, timezone)}{row.window ? ` · 算进 ${formatWindow(row.window)}` : " · 不在所选日期内"}</div>
        <div className="reconciliation-history-mobile__figures"><span>收入 <strong>{inRange(row, incomeText(row, currency))}</strong></span><span>上游成本 <strong>{inRange(row, costText(row, currency))}</strong></span><span>毛利 <strong>{inRange(row, profitText(row))}</strong></span><span>毛利率 <strong>{inRange(row, row.values.confirmed ? formatPct(row.values.margin) : EMPTY)}</strong></span></div>
        {row.timingSource === "detected" ? <Button type="link" size="small" onClick={onDetail}>{RECON_BUTTONS.correctTiming}</Button> : null}
      </div>)}
    </div> : <Table className="reconciliation-history-table" size="small" rowKey={(row: any) => row.id} columns={columns} dataSource={rows} scroll={{ x: 1045 }} pagination={rows.length > 6 ? { pageSize: 6, size: "small", showSizeChanger: false } : false} />}
  </section>;
}

export function RuleMobileItem({ item, keyName, currency, upstreams, onDetail, onRetry, retrying, retryError, expanded, onExpand }: {
  item: any; keyName: string; currency: ReconciliationCurrency; upstreams: any; onDetail: () => void; onRetry: () => void; retrying: boolean; retryError?: string; expanded: boolean; onExpand: () => void;
}) {
  const rule = item.rule || {};
  const channels = mergeReconciliationChannels(rule.channels, item.downstream?.channels);
  const flags = reconciliationRowFlags(item, currency);
  const { profit, margin, currency: profitCurrency } = flags.values;
  const history = ruleHistory(item);
  const hasHistory = hasReconciliationHistory(history);
  const channelStates = channelStateSummary(channels);
  return <div className="reconciliation-mobile-item">
    <button type="button" className="reconciliation-mobile-row" onClick={onDetail} aria-label={`查看 ${keyName} 的计算明细`}>
      <span className="reconciliation-mobile-row__top">
        <span className="reconciliation-mobile-row__identity">
          <strong>{upstreamName(rule, upstreams)}</strong>
          <span>Key：{keyName}</span>
          <span>分组 / 倍率：{currentGroup(item)} · {currentRatioLabel(item)}</span>
        </span>
        <span className="reconciliation-mobile-row__finance">
          <RowStatus item={item} currency={currency} />
          <strong>{amountText(profit, profitCurrency as ReconciliationCurrency)}</strong>
          <span>{formatPct(margin)}</span>
          <LossTag show={flags.negative} />
        </span>
        <RightOutlined className="reconciliation-mobile-row__chevron" aria-hidden="true" />
      </span>
      <span className="reconciliation-mobile-row__bottom">收入 {incomeText(item, currency)} <span aria-hidden="true">·</span> 上游成本 {costText(item, currency)} <span aria-hidden="true">·</span> {channels.length} 个渠道</span>
      {channels.length ? <span className="reconciliation-mobile-row__channels">{channels.map(reconciliationChannelName).join("、")}{channelStates ? ` · ${channelStates}` : ""}</span> : null}
    </button>
    <div className="reconciliation-mobile-actions">
      <Button type="link" loading={retrying} aria-label={`${RECON_BUTTONS.retry} ${keyName}`} onClick={onRetry}>{RECON_BUTTONS.retry}</Button>
      <IssueAction type="link" action={flags.displayStatus.action} onDetail={onDetail} target={keyName} />
      {hasHistory ? <Button type="link" onClick={onExpand} aria-expanded={expanded}>{expanded ? "收起倍率变化" : `查看倍率变化 · ${history.length - 1} 次`}</Button> : null}
    </div>
    {retryError ? <Alert type="error" showIcon title={RETRY_FAILED_TEXT} description={<ErrorDetail raw={retryError} />} action={<Button size="small" onClick={onRetry}>{RECON_BUTTONS.retry}</Button>} className="reconciliation-mobile-alert" /> : null}
    {hasHistory && expanded ? <SegmentHistory item={item} keyName={keyName} currency={currency} compact onDetail={onDetail} /> : null}
  </div>;
}
