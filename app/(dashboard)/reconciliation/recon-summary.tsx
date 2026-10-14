"use client";
// 核算汇总、按账单窗口分组的小计、已知渠道覆盖。
// 金额一律按 USD 汇总；reference 表示当前正在核对（查询中、过期或读取失败），只能当参考。
import { Alert, Button, Collapse } from "antd";
import { Panel } from "../../components/panel";
import { StatusTag } from "../../components/status";
import type { KnownChannelCoverage, ReconciliationSummary, ReconciliationWindowGroup } from "../../../lib/client";
import { formatReconciliationMoney as money } from "../../../lib/reconciliation-view";
import { RECONCILIATION_BILLING_SOURCE_LABEL } from "../../../lib/reconciliation-contract";
import { Detail, SummaryMetric } from "./recon-parts";
import { COVERAGE_STATUS_LABEL, amountTone, channelStateLabel, coverageIssueLabel, formatWindow, iso, percent } from "./recon-format";

function WindowMetrics({ totals }: { totals: ReconciliationWindowGroup["totals"] }) {
  return <div className="reconciliation-summary__metrics">
    <SummaryMetric label="本站已获取收费（USD）" value={money(totals.knownIncomeUsd, null)} />
    <SummaryMetric label="已计入上游成本（USD）" value={money(totals.knownCostUsd, null)} />
    <SummaryMetric label="已确认范围账面毛利" value={money(totals.confirmedProfitUsd, null)} tone={amountTone(totals.confirmedProfitUsd)} />
    <SummaryMetric label="已确认范围毛利率" value={percent(totals.confirmedMarginRate)} />
  </div>;
}

export function ReconSummary({ summary, reference }: { summary: ReconciliationSummary | null; reference: boolean }) {
  const note = <>
    {summary?.totals.profitComplete ? "已知渠道范围的完整账单。" : "仅已确认范围的金额，不代表全站完整利润。"}
    金额按 USD 汇总；本站收费来源：{RECONCILIATION_BILLING_SOURCE_LABEL}。今天、近 7 天、本月为截至现在的实时金额，自然日结束后自动结账。
  </>;
  return <Panel title="核算汇总" className="reconciliation-summary" foot={note}>
    {reference
      ? <Alert type="info" showIcon title="全量摘要仅供参考，正在核对当前窗口" description="关联列表保留已读金额；全量读取完成后再显示当前汇总。" />
      : summary ? <WindowMetrics totals={summary.totals} /> : <p className="reconciliation-summary__empty">暂无共同整日汇总</p>}
  </Panel>;
}

// 关联分属不同账单窗口（时区或起止不同）时逐组列出，组内金额只在本组口径下相加
export function ReconWindowGroups({ groups, reference }: { groups: ReconciliationWindowGroup[]; reference: boolean }) {
  if (!groups.length) return null;
  return <Collapse className="reconciliation-window-groups" items={groups.map((group) => ({
    key: group.groupKey,
    label: <span>账单窗口 · {formatWindow({ ...group.window, timezone: group.timezones[0] })} · {group.timezones.join(" / ")}{reference ? " · 参考" : ""}</span>,
    children: <div className="reconciliation-window-group">
      <div className="reconciliation-detail-grid">
        <Detail label="绝对窗口" value={`${iso(group.window.startMs)} — ${iso(group.window.endMs)}`} />
        <Detail label="本站来源" value={group.ownSource ? `${group.ownSource.provider} · ${group.ownSource.baseUrl} · 账号 ${group.ownSource.accountId} · ${group.ownSource.namespaceKey}` : "来源待核对"} />
        <Detail label="金额口径" value={`${group.amountBasis.currency} · ${group.amountBasis.billingSource} · 计算版本 ${group.amountBasis.calculationVersion} · ${group.amountBasis.conversion || "换算依据待核验"}`} />
        <Detail label="核算关联" value={group.ruleIds.join("、")} />
      </div>
      <WindowMetrics totals={group.totals} />
      <p className="jy-caption">
        {reference ? "本组金额仅供参考。" : group.totals.profitComplete ? "已知范围完整账单。" : "已确认范围小计，完整性待确认。"}
        {" "}已核算 {group.coverage.accountedChannelCount}/{group.coverage.knownChannelCount} 个已知渠道。
        {group.totals.notCountedCostRuleIds.length ? `未计入成本的关联：${group.totals.notCountedCostRuleIds.join("、")}。` : ""}
      </p>
    </div>,
  }))} />;
}

// 覆盖统计按全部已知渠道计算，不随搜索、筛选和分页变化
export function ReconCoverage({ coverage, reference }: { coverage: KnownChannelCoverage | null; reference: boolean }) {
  if (!coverage) return null;
  return <section className="reconciliation-coverage" aria-label="已知渠道覆盖">
    <Alert
      type={coverage.state === "complete_known" ? "success" : "warning"}
      showIcon
      title={`${reference ? "参考 · " : ""}已知渠道覆盖：已核算 ${coverage.accountedChannelCount}/${coverage.knownChannelCount}`}
      description={`${coverage.catalogueState === "verified" ? "当前目录已核验" : "当前目录覆盖未知"}；全站历史渠道全集未核验。搜索、筛选和分页不改变此覆盖统计。`}
    />
    <Collapse className="reconciliation-coverage__list" items={[{
      key: "known-coverage",
      label: "查看全部已知渠道与未核算原因",
      children: <ul className="reconciliation-coverage__channels">
        {coverage.channels.map((channel, index) => <li key={`${channel.ownSource?.namespaceKey || channel.ownStationId}:${channel.channelId}:${index}`} className="reconciliation-coverage__channel">
          <div className="reconciliation-coverage__heading">
            <strong>{channel.name} · ID {channel.channelId}</strong>
            <StatusTag level={channel.status === "accounted" ? "good" : "warn"}>{COVERAGE_STATUS_LABEL[channel.status] || channel.status}</StatusTag>
          </div>
          <span className="jy-caption">{channelStateLabel[channel.operatingState] || "状态未知"} · 本站 {channel.ownStationId} · 核算关联 {channel.ruleIds.join("、") || "无"}</span>
          {channel.issues.length ? <span>{channel.issues.map(coverageIssueLabel).join("；")}</span> : null}
          {channel.actions.length ? <div className="reconciliation-coverage__actions">
            <span className="jy-caption">待处理：{channel.actions.map((action) => action.label).join("；")}</span>
            {channel.actions.map((action) => <Button key={action.id} size="small" href={action.href}>{action.label}</Button>)}
          </div> : null}
        </li>)}
      </ul>,
    }]} />
  </section>;
}
