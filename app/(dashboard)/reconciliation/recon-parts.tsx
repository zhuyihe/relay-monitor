"use client";
// 账单核算页的小部件：详情行、行状态、汇总指标、渠道明细、分组变更历史、移动端关联卡片。
// 只负责展示，数据和动作都由页面传入。
import type { ReactNode } from "react";
import { Alert, Button, Table } from "antd";
import { RightOutlined } from "@ant-design/icons";
import { StatusTag } from "../../components/status";
import type { Level } from "../../components/status";
import {
  hasReconciliationHistory,
  mergeReconciliationChannels,
  mergeReconciliationSegments,
  reconciliationCalculationValues as calculationValues,
  reconciliationRowFlags,
} from "../../../lib/reconciliation-view";
import {
  SETTLEMENT_LABEL, amountText, amountTone, billingAmountText, channelLabel, channelStateLabel, channelStateSummary, costText, currentGroup,
  currentRatioLabel, formatWindow, incomeText, isFixedCost, percent, ratioLabel, ruleHistory, rowHasConflict, segmentPeriod, segmentTimingLabel,
  sideRate, upstreamBillsHref, upstreamName,
} from "./recon-format";
import type { ReconciliationCurrency } from "../../../lib/client";

const TONE_LEVEL: Record<string, Level> = { danger: "crit", warning: "warn", success: "good", neutral: "muted" };

const amountClass = (tone: string) => (tone ? `reconciliation-amount--${tone}` : "");

export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return <div className="reconciliation-detail">
    <span className="reconciliation-detail__label">{label}</span>
    <span className="reconciliation-detail__value">{value}</span>
  </div>;
}

// 主状态在上，次要状态（数据过期、切换待确认等）依次排在下面
export function RowStatus({ item, currency }: { item: any; currency: ReconciliationCurrency }) {
  const { status, secondaryStatuses } = reconciliationRowFlags(item, currency);
  return <span className="reconciliation-status-stack">
    {[status, ...secondaryStatuses].map((badge: any) => <StatusTag key={badge.label} level={TONE_LEVEL[badge.tone] || "muted"}>{badge.label}</StatusTag>)}
  </span>;
}

export function SummaryMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="reconciliation-summary-metric">
    <span className="reconciliation-summary-metric__label">{label}</span>
    <strong className={tone ? `reconciliation-summary-metric__value reconciliation-amount--${tone}` : "reconciliation-summary-metric__value"}>{value}</strong>
  </div>;
}

// 毛利旁边的结账状态：实时 / 已结账 / 已结束
export function SettlementNote({ item }: { item: any }) {
  const label = SETTLEMENT_LABEL[item?.settlement];
  return label ? <small className="reconciliation-settlement">{label}</small> : null;
}

const CHANNEL_LEVEL = (state: string): Level => (state === "enabled" ? "good" : state === "missing" ? "crit" : "warn");

export function ChannelBreakdown({ item, currency }: { item: any; currency: ReconciliationCurrency }) {
  const rate = sideRate(item, "income", currency);
  const channels = mergeReconciliationChannels(item?.rule?.channels, item?.downstream?.channels);
  if (!channels.length) return <p className="jy-caption">这条核算关联没有本站渠道。</p>;
  return (
    <div className="reconciliation-channel-list">
      {channels.map((channel: any) => (
        <div key={channel.channelId || channel.id || channel.name} className="reconciliation-channel">
          <div className="reconciliation-channel__name">
            <strong>{channel.name || `渠道 ${channel.channelId || channel.id}`}</strong>
            <small>渠道 ID：{channel.channelId || channel.id || "—"} · 收费占比 {percent(channel.share)}</small>
          </div>
          <div className="reconciliation-channel__figures">
            <strong>{billingAmountText({ state: channel.billingState, amountUsd: channel.amountUsd, knownAmountUsd: channel.knownAmountUsd }, rate)}</strong>
            <StatusTag level={CHANNEL_LEVEL(channel.state)}>{channelStateLabel[channel.state] || "状态未知"}</StatusTag>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SegmentHistory({ item, currency, compact, onDetail }: { item: any; currency: ReconciliationCurrency; compact: boolean; onDetail: () => void }) {
  const timezone = item.window?.timezone || item.rule?.timezone;
  const segments = mergeReconciliationSegments(item.transitionSegments, item.segments).slice().reverse();
  // 分段用所属关联的汇率和成本口径
  const rows = segments.map((segment: any) => {
    const priced = { ...segment, rates: item.rates };
    const values = calculationValues(segment.calculation, segment.health, priced, currency);
    return { ...priced, values, result: values.confirmed ? values.profit : values.riskDifference };
  });
  const columns: any[] = [
    { title: "生效区间", key: "period", width: 225, render: (_: any, row: any) => <span className="reconciliation-history-period"><strong>{segmentPeriod(row, timezone)}</strong><small>{row.window ? `本次核算 ${formatWindow(row.window)}` : "查询窗口外 · 无本次金额"}</small></span> },
    { title: "上游分组 / 倍率", key: "group", width: 185, render: (_: any, row: any) => <span className="reconciliation-history-group"><strong>{row.group || "分组未知"}</strong><small>{ratioLabel(row.ratio)}{row.ratioSource === "group_catalog" ? " · 目录观察值" : ""}</small></span> },
    { title: "本站收费", key: "income", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{row.window ? incomeText(row, currency) : "—"}</span> },
    { title: "上游成本", key: "cost", width: 120, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{row.window ? costText(row, currency) : "—"}</span> },
    { title: "毛利 / 风险差额", key: "profit", width: 145, align: "right", render: (_: any, row: any) => <span className="reconciliation-history-result"><strong className={row.values.confirmed && Number(row.values.profit) < 0 ? "reconciliation-amount--danger" : ""}>{row.window ? amountText(row.result, currency) : "—"}</strong><small>{row.window ? row.values.confirmed ? "毛利" : "风险差额" : "本次窗口外"}</small></span> },
    { title: "实际毛利率", key: "margin", width: 110, align: "right", render: (_: any, row: any) => <span className="reconciliation-table-amount">{row.window ? percent(row.values.margin) : "—"}</span> },
    { title: "时间依据", key: "timing", width: 135, render: (_: any, row: any) => row.timingSource === "detected" ? <Button type="link" size="small" onClick={onDetail}>待确认 · 去修正</Button> : segmentTimingLabel(row) },
  ];

  return <section className="reconciliation-history" aria-label={`${item.rule?.tokenName || "上游 Key"} 的分组变更历史`}>
    <div className="reconciliation-history__intro"><strong>分组与倍率历史 · {rows.length} 段</strong><span>金额仅对应顶部查询窗口；窗口外的历史分段不计入本次金额。</span></div>
    {compact ? <div className="reconciliation-history-mobile">
      {rows.map((row: any) => <div key={row.id} className="reconciliation-history-mobile__row">
        <div className="reconciliation-history-mobile__heading"><strong>{row.group || "分组未知"} · {ratioLabel(row.ratio)}</strong><span>{segmentTimingLabel(row)}</span></div>
        <div className="reconciliation-history-mobile__period">{segmentPeriod(row, timezone)}{row.window ? ` · 本次核算 ${formatWindow(row.window)}` : " · 查询窗口外"}</div>
        <div className="reconciliation-history-mobile__figures"><span>收费 <strong>{row.window ? incomeText(row, currency) : "—"}</strong></span><span>成本 <strong>{row.window ? costText(row, currency) : "—"}</strong></span><span>{row.values.confirmed ? "毛利" : "风险差额"} <strong>{row.window ? amountText(row.result, currency) : "—"}</strong></span><span>毛利率 <strong>{row.window ? percent(row.values.margin) : "—"}</strong></span></div>
        {row.timingSource === "detected" ? <Button type="link" size="small" onClick={onDetail}>修正切换时间</Button> : null}
      </div>)}
    </div> : <Table className="reconciliation-history-table" size="small" rowKey={(row: any) => row.id} columns={columns} dataSource={rows} scroll={{ x: 1040 }} pagination={rows.length > 6 ? { pageSize: 6, size: "small", showSizeChanger: false } : false} />}
  </section>;
}

export function RuleMobileItem({ item, currency, upstreams, onDetail, onRetry, retrying, retryError, expanded, onExpand }: {
  item: any; currency: ReconciliationCurrency; upstreams: any; onDetail: () => void; onRetry: () => void; retrying: boolean; retryError?: string; expanded: boolean; onExpand: () => void;
}) {
  const rule = item.rule || {};
  const channels = mergeReconciliationChannels(rule.channels, item.downstream?.channels);
  const calculation = calculationValues(item.calculation, item.health, item, currency);
  const tone = amountTone(calculation.profit);
  const history = ruleHistory(item);
  const hasHistory = hasReconciliationHistory(history);
  return <div className="reconciliation-mobile-item">
    <button type="button" className="reconciliation-mobile-row" onClick={onDetail}>
      <span className="reconciliation-mobile-row__top">
        <span className="reconciliation-mobile-row__identity">
          <strong>{upstreamName(rule, upstreams)}</strong>
          <span>Key：{rule.tokenName || "未命名 Key"}</span>
          <span>现用分组 / 上游倍率：{currentGroup(item)} · {currentRatioLabel(item)}</span>
        </span>
        <span className="reconciliation-mobile-row__finance">
          <RowStatus item={item} currency={currency} />
          <strong className={amountClass(tone)}>{calculation.confirmed ? amountText(calculation.profit, currency) : "待核算"}</strong>
          <span className={amountClass(tone)}>{calculation.confirmed ? percent(calculation.margin) : "—"}</span>
          {calculation.confirmed ? <SettlementNote item={item} /> : null}
        </span>
        <RightOutlined className="reconciliation-mobile-row__chevron" aria-hidden="true" />
      </span>
      <span className="reconciliation-mobile-row__bottom">收费 {incomeText(item, currency)} <span aria-hidden="true">·</span> 成本 {costText(item, currency)}{isFixedCost(item) ? "（固定采购）" : ""} <span aria-hidden="true">·</span> {channels.length} 个渠道</span>
      {channels.length ? <span className="reconciliation-mobile-row__channels">{channels.map(channelLabel).join("、")} · {channelStateSummary(channels)}</span> : null}
    </button>
    <div className="reconciliation-mobile-actions">
      <Button type="link" loading={retrying} onClick={onRetry}>重试当前关联</Button>
      <Button type="link" href={upstreamBillsHref(rule.id, rowHasConflict(item))}>去上游账单处理</Button>
      {hasHistory ? <Button type="link" onClick={onExpand} aria-expanded={expanded}>{expanded ? "收起" : "查看"}分组历史 · {history.length} 段</Button> : null}
    </div>
    {retryError ? <Alert type="error" showIcon title={retryError} action={<Button size="small" onClick={onRetry}>重试</Button>} className="reconciliation-mobile-alert" /> : null}
    {hasHistory && expanded ? <SegmentHistory item={item} currency={currency} compact onDetail={onDetail} /> : null}
  </div>;
}
