"use client";
// 核算详情抽屉正文：窗口、来源、范围版本、金额和计算依据、健康问题、渠道收费明细。
// 「修正切换时间」是页面只读的唯一例外，其余处理都跳到上游账单。
import { Alert, Button, Collapse, DatePicker, Select } from "antd";
import {
  formatReconciliationMoney as money,
  reconciliationBillingBasis,
  reconciliationCalculationValues as calculationValues,
  reconciliationRowFlags,
} from "../../../lib/reconciliation-view";
import {
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_BILLING_SOURCE_LABEL,
  reconciliationHealthMeta,
} from "../../../lib/reconciliation-contract";
import { ChannelBreakdown, Detail } from "./recon-parts";
import {
  billingAmountText, billingCoverageText, channelLabel, currentRatioLabel, formatRecentTime, formatWindow,
  formatWindowWithZone, healthLabel, iso, percent, rowHasConflict, sameWindow, upstreamBillsHref, upstreamName,
} from "./recon-format";
import type { useReconDetail } from "./use-recon-detail";

type DetailState = ReturnType<typeof useReconDetail>;

// 冲突处理目标涉及的每条关联：在当前结果里就能打开核对，不在了就标明已不可用
export function ConflictRules({ ids, results, onOpen }: { ids: string[]; results: any[]; onOpen: (row: any) => void }) {
  return <div className="reconciliation-button-row">
    {ids.map((id) => {
      const row = results.find((item: any) => item.rule?.id === id);
      return row ? <Button key={id} onClick={() => onOpen(row)}>核对 {id}</Button> : <span key={id} className="jy-caption">已不可用：{id}</span>;
    })}
  </div>;
}

function HealthAlert({ detail }: { detail: any }) {
  const meta = reconciliationHealthMeta(detail.health?.code);
  const negative = reconciliationRowFlags(detail).negative;
  const type = meta.tone === "error" || negative ? "error" : detail.health?.code === "READY" ? "success" : "warning";
  const title = meta.tone === "error" ? detail.health?.label || meta.label : negative ? "这条核算关联毛利为负" : detail.health?.label;
  return <Alert type={type} showIcon title={title} description={detail.health?.detail || "数据来源正常"} />;
}

export function ReconDetail({ detail, state, rate, upstreams, compact, conflictIds, results, retrying, retryError, onOpenHistory, onRetry, onOpen, onCorrect }: {
  detail: any; state: DetailState; rate: any; upstreams: any; compact: boolean; conflictIds: string[]; results: any[];
  retrying: boolean; retryError?: string; onOpenHistory: (id: string) => void; onRetry: (item: any) => void; onOpen: (row: any) => void; onCorrect: () => void;
}) {
  const calculation = calculationValues(detail.calculation, detail.health, detail);
  const requested = detail.requestedWindow || detail.window;
  const pendingSegments = state.transitionSegments.filter((segment: any) => segment.timingSource === "detected");
  const basis = (billing: any) => reconciliationBillingBasis(detail.segments?.length === 1 ? billing : { state: billing?.state, amountUsd: billing?.amountUsd, knownAmountUsd: billing?.knownAmountUsd });
  const resultValue = calculation.confirmed ? calculation.profitUsd : calculation.riskDifferenceUsd;

  return <div className="reconciliation-detail-body">
    <div className="reconciliation-button-row">
      <Button onClick={() => onOpenHistory(detail.rule.id)}>查看已确认账单历史</Button>
      <Button loading={retrying} onClick={() => onRetry(detail)}>重查该窗口账单</Button>
      <Button href={upstreamBillsHref(detail.rule.id, rowHasConflict(detail))}>去上游账单处理</Button>
    </div>
    {retryError ? <Alert type="error" showIcon title={retryError} /> : null}
    {conflictIds.includes(detail.rule.id)
      ? <Alert type="warning" showIcon title="重复销售归属待处理" description={<>涉及关联：{conflictIds.join("、")}。<ConflictRules ids={conflictIds} results={results} onOpen={onOpen} /></>} />
      : null}
    {detail.actions?.length
      ? <div className="reconciliation-button-row">{detail.actions.map((action: any) => <Button key={action.id} href={action.href}>{action.label}</Button>)}</div>
      : null}
    <HealthAlert detail={detail} />

    <div className="reconciliation-detail-grid">
      <Detail label="请求窗口" value={formatWindowWithZone(requested)} />
      <Detail label="返回账单实际窗口" value={formatWindowWithZone(detail.window)} />
      {detail.upstream?.window && !sameWindow(detail.upstream.window, detail.window) ? <Detail label="上游原账单窗口" value={formatWindowWithZone(detail.upstream.window)} /> : null}
      {detail.downstream?.window && !sameWindow(detail.downstream.window, detail.window) ? <Detail label="本站原账单窗口" value={formatWindowWithZone(detail.downstream.window)} /> : null}
      {detail.health?.stale ? <Detail label="成功金额覆盖窗口" value={formatWindowWithZone(detail.lastSuccessfulWindow || detail.window)} /> : null}
      <Detail label="上游账号" value={upstreamName(detail.rule, upstreams)} />
      <Detail label="上游 Key / 分组" value={`${detail.rule?.tokenName || "—"} · ${detail.upstream?.group || detail.currentSegment?.group || detail.rule?.fixedGroup || "—"}`} />
      <Detail label="关联销售渠道" value={(detail.rule?.channels?.length ? detail.rule.channels : detail.downstream?.channels || []).map(channelLabel).join("、") || "未配置渠道"} />
      {detail.scope ? <>
        <Detail label="当前核算范围版本" value={String(detail.scope.scopeVersion ?? "未知")} />
        <Detail label="生效时间" value={iso(detail.scope.billingEffectiveFromMs)} />
        <Detail label="首次结账" value={iso(detail.scope.firstQueryableAtMs)} />
        {detail.scope.accountedFromMs != null ? <Detail label="本窗口核算起点" value={iso(detail.scope.accountedFromMs)} /> : null}
        {detail.scope.recalculated ? <Detail label="配置变更" value="已按新配置重算（修改前尚未结账的时段也按当前配置计算）" /> : null}
      </> : null}
      {detail.billingTimezone
        ? <Detail label="账单时区能力" value={`${detail.billingTimezone.timezone} · ${detail.billingTimezone.state === "verified" ? "已核验" : "待核验，原金额仅供参考"}${detail.billingTimezone.reason ? ` · ${detail.billingTimezone.reason}` : ""}`} />
        : null}
      <Detail label="当前倍率" value={currentRatioLabel(detail)} />
      <Detail label="本站收费" value={`${billingAmountText(detail.downstream, rate)} · ${billingCoverageText(detail.downstream)}`} />
      <Detail label="上游成本" value={`${billingAmountText(detail.upstream, rate)} · ${billingCoverageText(detail.upstream)}`} />
      <Detail label={calculation.confirmed ? "毛利" : "风险差额（未计入毛利）"} value={money(resultValue, rate)} />
      <Detail label="毛利率" value={percent(calculation.marginRate)} />
    </div>

    <Collapse size="small" ghost className="reconciliation-basis" items={[{
      key: "billing-basis",
      label: "查看原始账单与计算依据",
      children: <div className="reconciliation-detail-grid">
        <Detail label="本站收费（美元原值）" value={basis(detail.downstream)} />
        <Detail label="上游成本（美元原值）" value={basis(detail.upstream)} />
        <Detail label={calculation.confirmed ? "毛利（美元原值）" : "风险差额（美元原值）"} value={reconciliationBillingBasis({ state: "complete", amountUsd: resultValue })} />
        <p className="jy-caption">毛利 = 本站收费 − 上游成本；毛利率 = 毛利 ÷ 本站收费。计算使用未舍入金额，跨分段时先分别核算再汇总。</p>
      </div>,
    }]} />

    <div className="reconciliation-detail-grid">
      <Detail label="本站收费来源" value={detail.downstream?.knownAmountUsd == null && detail.downstream?.amountUsd == null ? "未取得" : detail.downstream.billingSource === RECONCILIATION_BILLING_SOURCE ? RECONCILIATION_BILLING_SOURCE_LABEL : "旧版来源（待重新核算）"} />
      <Detail label="渠道账单覆盖" value={billingCoverageText(detail.downstream)} />
      {detail.lastConfirmed ? <>
        <Detail label="最近完整账单（仅参考）" value={`${formatRecentTime(detail.lastConfirmed.generatedAt, detail.lastConfirmed.window?.timezone, true)} · ${formatWindow(detail.lastConfirmed.window)}`} />
        <Detail label="参考收费 / 成本" value={`${money(detail.lastConfirmed.downstream?.amountUsd, rate)} / ${money(detail.lastConfirmed.upstream?.amountUsd, rate)}（不计入当前汇总）`} />
      </> : null}
    </div>

    {(detail.health?.issues || []).map((issue: any, index: number) => <Alert
      key={`${issue.code}-${index}`} type={reconciliationHealthMeta(issue.code).tone === "error" ? "error" : "warning"} showIcon
      title={healthLabel(issue.code)} description={issue.detail}
    />)}

    {pendingSegments.length ? <section className="reconciliation-transition" aria-label="修正分组切换时间">
      <h3>分组切换时间待确认</h3>
      <p className="jy-caption">系统按观测时间推断了切换点；填入实际切换时间后，按新分段重新核算。</p>
      <div className="reconciliation-transition__controls">
        <Select
          value={state.transitionSegmentId} onChange={state.setTransitionSegmentId} placeholder="选择待确认的切换分段"
          style={{ minWidth: compact ? "100%" : 230 }}
          options={pendingSegments.map((segment: any) => ({
            value: segment.id,
            label: `${segment.group} · ${formatWindow(segment.window || { startMs: segment.effectiveFrom, endMs: segment.effectiveTo ?? Date.now(), timezone: detail.window?.timezone || detail.rule?.timezone })}`,
          }))}
        />
        <DatePicker showTime value={state.transitionAt} onChange={(value) => state.setTransitionAt(value)} placeholder="实际切换时间" />
        <Button loading={state.correcting} onClick={onCorrect}>修正切换时间</Button>
      </div>
    </section> : null}

    <section className="reconciliation-channels" aria-label="渠道收费明细">
      <h3>渠道收费明细</h3>
      <ChannelBreakdown item={detail} rate={rate} />
    </section>
  </div>;
}
