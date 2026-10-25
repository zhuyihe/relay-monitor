"use client";
// 计算明细（抽屉正文）：这天是哪种状态、要处理什么，收入、上游成本、毛利怎么来的，各渠道收入。
// 只用白话（design/ui-copy-spec.md §9）；「改时间」是页面只读的唯一例外，其余处理都由按钮去对应页面。
import { useRef } from "react";
import { Alert, Button, DatePicker, Select } from "antd";
import { EMPTY, formatDayZone, formatPct, formatZonedDateTime } from "../../../lib/format";
import { reconciliationAccountingStart, reconciliationIssue } from "../../../lib/reconciliation-contract";
import {
  hasReconciliationHistory,
  mergeReconciliationChannels,
  reconciliationAccountingStartText,
  reconciliationRowFlags,
} from "../../../lib/reconciliation-view";
import { ErrorDetail } from "../../components/error-detail";
import { ChannelBreakdown, Detail, IssueAction, LossTag } from "./recon-parts";
import {
  RECON_BUTTONS, RECON_COPY, RETRY_FAILED_TEXT, amountText, channelTestText, costText, currentGroup, currentRatioLabel, formatWindow, incomeText, isFixedCost, ratioChangeText, ratioLabel, rateText,
  ruleHistory, segmentPeriod, upstreamName,
} from "./recon-format";
import type { useReconDetail } from "./use-recon-detail";
import type { ReconciliationCurrency } from "../../../lib/client";

type DetailState = ReturnType<typeof useReconDetail>;

// 重复绑定涉及的另外几条（服务端在重复的问题里带上 ruleIds）：还在列表里的可以直接打开看，不在了就写已解除
const CONFLICT_CODES = new Set(["CANONICAL_KEY_CONFLICT", "DUPLICATE_CHANNEL_ASSIGNMENT"]);
const conflictRuleIds = (detail: any) => [...new Set<string>((detail?.health?.issues || [])
  .filter((issue: any) => CONFLICT_CODES.has(issue.code)).flatMap((issue: any) => issue.ruleIds || []))]
  .filter((id) => id !== detail?.rule?.id);

export function ConflictRules({ ids, results, keyName, onOpen }: { ids: string[]; results: any[]; keyName: (rule: any) => string; onOpen: (row: any) => void }) {
  return <div className="reconciliation-button-row">
    {ids.map((id) => {
      const row = results.find((item: any) => item.rule?.id === id);
      return row
        ? <Button key={id} onClick={() => onOpen(row)}>查看 {keyName(row.rule)}</Button>
        : <span key={id} className="jy-caption">有一条绑定已解除</span>;
    })}
  </div>;
}

export function ReconDetail({ detail, state, currency, upstreams, businessTimezone, compact, results, keyName, retrying, retryError, onOpenHistory, onRetry, onOpen, onCorrect }: {
  detail: any; state: DetailState; currency: ReconciliationCurrency; upstreams: any; businessTimezone?: string; compact: boolean; results: any[]; keyName: (rule: any) => string;
  retrying: boolean; retryError?: string; onOpenHistory: (id: string) => void; onRetry: (item: any) => void; onOpen: (row: any) => void; onCorrect: () => void;
}) {
  const timingRef = useRef<HTMLElement>(null);
  const flags = reconciliationRowFlags(detail, currency);
  const status = flags.displayStatus;
  const { profit, margin, currency: profitCurrency } = flags.values;
  const requested = detail.requestedWindow || detail.window;
  const timezone = detail.window?.timezone || detail.rule?.timezone;
  const dayZone = formatDayZone(timezone, businessTimezone);
  const channels = mergeReconciliationChannels(detail.rule?.channels, detail.downstream?.channels);
  const channelTest = channelTestText(detail, currency);
  const fixedCost = isFixedCost(detail);
  const ratioChange = ratioChangeText(detail, timezone);
  const start = reconciliationAccountingStart(detail.rule);
  const revisions = Number(detail.ledger?.revision) - 1;
  const pendingSegments = state.transitionSegments.filter((segment: any) => segment.timingSource === "detected");
  const otherConflicts = status.state === "action" ? conflictRuleIds(detail) : [];
  // 「改时间」在本页下面：滚过去，不另开页面
  const showTiming = pendingSegments.length ? () => timingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }) : undefined;

  return <div className="reconciliation-detail-body">
    <div className="reconciliation-button-row">
      <Button onClick={() => onOpenHistory(detail.rule.id)}>{RECON_BUTTONS.history}</Button>
      <Button loading={retrying} onClick={() => onRetry(detail)}>{RECON_BUTTONS.retry}</Button>
    </div>
    {retryError ? <Alert type="error" showIcon title={RETRY_FAILED_TEXT} description={<ErrorDetail raw={retryError} />} /> : null}

    {/* 需处理只露出最要紧的一条和它的按钮，其余收起成「还有 N 个问题」（§4） */}
    {status.state === "action" ? <Alert
      type="warning" showIcon title={status.title}
      description={status.detail || status.moreCount > 0 || otherConflicts.length ? <>
        {status.detail ? <div>{status.detail}</div> : null}
        {status.moreCount > 0 ? <div>{RECON_COPY.moreIssues(status.moreCount)}</div> : null}
        {otherConflicts.length ? <ConflictRules ids={otherConflicts} results={results} keyName={keyName} onOpen={onOpen} /> : null}
      </> : undefined}
      action={<IssueAction size="small" action={status.action} onDetail={showTiming} />}
    /> : null}
    {status.hints.map((hint: any) => <Alert
      key={hint.code} type="info" showIcon title={hint.text}
      action={<IssueAction size="small" action={hint.action} onDetail={showTiming} />}
    />)}

    <div className="reconciliation-detail-grid">
      <Detail label="时间" value={<>{formatWindow(requested)}{dayZone ? <small>{dayZone}</small> : null}</>} />
      <Detail label="上游" value={upstreamName(detail.rule, upstreams)} />
      <Detail label="Key" value={keyName(detail.rule)} />
      <Detail label="分组 / 倍率" value={`${currentGroup(detail)} · ${currentRatioLabel(detail)}`} />
      <Detail label="收入" value={<>{incomeText(detail, currency)}<small>{channels.length ? RECON_COPY.incomeSource(channels.length) : RECON_COPY.noChannels}</small>{channelTest ? <small>{channelTest}</small> : null}</>} />
      <Detail label="上游成本" value={<>{costText(detail, currency)}{fixedCost ? null
        : <small>来自 Key「{keyName(detail.rule)}」的用量记录{ratioChange ? `；${ratioChange}` : ""}</small>}</>} />
      <Detail label="毛利" value={<>{amountText(profit, profitCurrency as ReconciliationCurrency)} <LossTag show={flags.negative} /></>} />
      <Detail label="毛利率" value={formatPct(margin)} />
      <Detail label="汇率" value={rateText(detail, currency, timezone)} />
      {status.state === "settled" ? <Detail label="固定于" value={formatZonedDateTime(status.settledAt, timezone)} /> : null}
      {start != null && requested && start > requested.startMs ? <Detail label="开始统计" value={reconciliationAccountingStartText(detail.rule, timezone)} /> : null}
      {revisions > 0 ? <Detail label="改过" value={`改过 ${revisions} 次`} /> : null}
    </div>
    <p className="jy-caption">毛利 = 收入 − 上游成本；毛利率 = 毛利 ÷ 收入。{hasReconciliationHistory(ruleHistory(detail)) ? "倍率变了的日子分两段算。" : ""}</p>

    {pendingSegments.length ? <section ref={timingRef} className="reconciliation-transition" aria-label={RECON_BUTTONS.correctTiming}>
      <h3>{reconciliationIssue("SEGMENT_TIMING_UNCONFIRMED").hint}</h3>
      <p className="jy-caption">保存后，未固定的结果按新时间计算。系统会尝试更新昨天的固定记录，更早的固定记录暂不自动更新。</p>
      <div className="reconciliation-transition__controls">
        <Select
          value={state.transitionSegmentId} onChange={state.setTransitionSegmentId} placeholder="选择要改的那次倍率变化"
          style={{ minWidth: compact ? "100%" : 230 }}
          options={pendingSegments.map((segment: any) => ({
            value: segment.id,
            label: `${segment.group || EMPTY} · ${ratioLabel(segment.ratio)} · ${segmentPeriod(segment, timezone)}`,
          }))}
        />
        <DatePicker showTime={{ format: "HH:mm" }} format="YYYY年M月D日 HH:mm" value={state.transitionAt} onChange={(value) => state.setTransitionAt(value)} placeholder="倍率变化的时间" />
        <Button loading={state.correcting} onClick={onCorrect}>{RECON_BUTTONS.correctTiming}</Button>
      </div>
    </section> : null}

    <section className="reconciliation-channels" aria-label="各渠道收入">
      <h3>各渠道收入</h3>
      <ChannelBreakdown item={detail} currency={currency} />
    </section>
  </div>;
}
