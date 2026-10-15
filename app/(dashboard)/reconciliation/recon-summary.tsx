"use client";
// 核算汇总、未纳入核算的上游消费、按账单窗口分组的小计、已知渠道覆盖。
// 金额按服务端定的显示币种（totals.display）汇总；reference 表示当前正在核对（查询中、过期或读取失败），只能当参考。
import { Alert, Button, Collapse } from "antd";
import Link from "next/link";
import { Panel } from "../../components/panel";
import { StatusTag } from "../../components/status";
import type { KnownChannelCoverage, ReconciliationDisplayTotals, ReconciliationSummary, ReconciliationWindowGroup, UnaccountedUpstream } from "../../../lib/client";
import { RECONCILIATION_BILLING_SOURCE_LABEL } from "../../../lib/reconciliation-contract";
import { NAV_LABELS } from "../../../lib/brand";
import { Detail, SummaryMetric } from "./recon-parts";
import { COVERAGE_STATUS_LABEL, amountText, amountTone, channelStateLabel, coverageIssueLabel, formatRecentTime, formatWindow, isLivePreset, iso, percent } from "./recon-format";

// 旧响应没有 display 时按 USD 原值显示
function displayTotals(totals: ReconciliationWindowGroup["totals"]): ReconciliationDisplayTotals {
  return totals.display || { currency: "USD", knownIncome: totals.knownIncomeUsd, knownCost: totals.knownCostUsd, confirmedProfit: totals.confirmedProfitUsd, confirmedMarginRate: totals.confirmedMarginRate };
}

function WindowMetrics({ totals }: { totals: ReconciliationWindowGroup["totals"] }) {
  const display = displayTotals(totals);
  return <div className="reconciliation-summary__metrics">
    <SummaryMetric label={`本站已获取收费（${display.currency}）`} value={amountText(display.knownIncome, display.currency)} />
    <SummaryMetric label={`已计入上游成本（${display.currency}）`} value={amountText(display.knownCost, display.currency)} />
    <SummaryMetric label="已确认范围账面毛利" value={amountText(display.confirmedProfit, display.currency)} tone={amountTone(display.confirmedProfit)} />
    <SummaryMetric label="已确认范围毛利率" value={percent(display.confirmedMarginRate)} />
  </div>;
}

const UNACCOUNTED_STATE_LABEL: Record<string, string> = { complete: "已取全", estimated: "估算", partial: "部分", pending: "读取中", unavailable: "读取失败" };
const unaccountedLevel = (state: string) => state === "complete" ? "good" : state === "pending" ? "info" : "warn";

// 上游账号实际扣费减去已计入核算的 Key 成本：没有建核算关联的 Key、测试和自用消耗都落在这里
// rereading：读取中时页面还会自动重读；次数用完后提示点顶栏的刷新。
function UnaccountedUpstreamBlock({ data, rereading }: { data: UnaccountedUpstream; rereading: boolean }) {
  const { currency } = data;
  const pending = data.state === "pending";
  // 已核算多于账号扣费的原因：取数时刻不同、汇率不同或两者都有（mixed）；旧响应没有 overAccounted 时按取数时刻。
  // 每个账号都有的原因直接说，只有部分账号有的说「部分还有」，两种原因各有账号单独占着时说「或」
  const overReasons = new Set(data.accounts.filter((account) => (account.unaccounted ?? 0) < 0).map((account) => account.overAccounted || "timing"));
  const mixed = overReasons.has("mixed"), timing = overReasons.has("timing"), rate = overReasons.has("rate");
  const overReason = !overReasons.size ? "" : timing && rate ? "取数时刻或汇率不同"
    : timing ? (mixed ? "多为取数时刻不同，部分还有汇率不同" : "多为取数时刻不同")
    : rate ? (mixed ? "汇率不同，部分还有取数时刻不同" : "汇率不同") : "取数时刻和汇率不同";
  // 截至现在的窗口里，账号扣费按取数时刻截止（缓存期内复用），核算成本截至本次读取，两者可能差几分钟。
  const live = isLivePreset(data.window.preset);
  const stationNames = (stations: { name: string }[]) => stations.map((station) => station.name).join("、");
  return <section className="reconciliation-unaccounted" aria-label="未纳入核算的上游消费">
    <div className="reconciliation-unaccounted__head">
      <SummaryMetric label={`未纳入核算的上游消费（${currency}）`} value={pending ? "读取中" : amountText(data.total, currency)} />
      <StatusTag level={unaccountedLevel(data.state)}>{UNACCOUNTED_STATE_LABEL[data.state] || data.state}</StatusTag>
    </div>
    <p className="jy-caption">
      各上游账号的实际扣费（和「{NAV_LABELS.my}」同一取数）减去已计入核算的 Key 成本。
      {pending ? (rereading ? "上游用量还在读取，稍后自动重读。" : "上游用量读取较慢，可点顶栏的刷新重试。")
        : data.state === "complete" ? "" : data.state === "estimated" ? "部分账号按余额历史或整日用量估算。" : "部分账号或关联没取全，合计不准确，展开看各账号说明。"}
      {!pending && overReason ? ` 已核算多于账号扣费的账号（${overReason}）在合计里按 0 计。` : ""}
      {data.fixedStations.length ? ` 固定采购的上游不按用量计成本，不在此列：${stationNames(data.fixedStations)}。` : ""}
      {data.excludedStations.length ? ` 设为不计入成本的上游不做账号级对比：${stationNames(data.excludedStations)}（建在${data.excludedStations.length > 1 ? "它们" : "它"}上面的核算关联仍按 Key 用量计成本）。` : ""}
    </p>
    {data.accounts.length ? <Collapse className="reconciliation-coverage__list" items={[{
      key: "unaccounted-accounts",
      label: "查看各上游账号",
      children: <ul className="reconciliation-coverage__channels">
        {data.accounts.map((account) => <li key={account.stationId} className="reconciliation-coverage__channel">
          <div className="reconciliation-coverage__heading">
            <strong>{account.name}</strong>
            <StatusTag level={unaccountedLevel(account.state)}>{UNACCOUNTED_STATE_LABEL[account.state] || account.state}</StatusTag>
          </div>
          <span>
            账号扣费 {account.state === "pending" ? "读取中" : amountText(account.account, currency)}
            {" · "}已核算 {amountText(account.accounted, currency)}
            {" · "}未纳入 {account.state === "pending" ? "—" : amountText(account.unaccounted, currency)}
          </span>
          <span className="jy-caption">
            {account.rate ? `汇率 ¥${account.rate}/$ · ` : ""}{live && account.endMs ? `账号扣费截至 ${formatRecentTime(account.endMs, data.window.timezone)} · ` : ""}核算关联 {account.ruleIds.join("、") || "无"}
            {account.notes.length ? ` · ${account.notes.join("；")}` : ""}
          </span>
        </li>)}
      </ul>,
    }]} /> : null}
  </section>;
}

// fixedCost：本页有建在固定采购上游上的关联，它们的成本记 0，采购费由自营业务页按时段摊销。
// fixedOffProfit：其中没开监控、设为不计入成本或已归档的站点，自营业务页也不摊销它们的采购费，单独点名。
// preset：当前核算范围；「今天」带到自营业务页，其余用它的默认范围（近 7 天）。
export function ReconSummary({ summary, unaccounted, usageRereading = false, reference, fixedCost = false, fixedOffProfit = [], preset }: {
  summary: ReconciliationSummary | null; unaccounted?: UnaccountedUpstream | null; usageRereading?: boolean; reference: boolean;
  fixedCost?: boolean; fixedOffProfit?: string[]; preset?: string;
}) {
  const currency = summary ? displayTotals(summary.totals).currency : "USD";
  const note = <>
    {summary?.totals.profitComplete ? "已知渠道范围的完整账单。" : "仅已确认范围的金额，不代表全站完整利润。"}
    {currency === "CNY" ? "金额按人民币汇总，收费按本站、成本按各上游的汇率折算（查单个已结账的自然日时按结账时记下的汇率，其余按当前汇率）；" : "金额按系统原值（美元）汇总；"}
    本站收费来源：{RECONCILIATION_BILLING_SOURCE_LABEL}。今天、近 7 天、本月为截至现在的实时金额，自然日结束后自动结账。
    {fixedCost ? <>固定采购上游的成本记 0，采购费不在这里分摊；扣掉固定成本后的净利见<Link href={preset === "today" ? "/my?range=today" : "/my"}>{NAV_LABELS.my}</Link>。
      {fixedOffProfit.length ? `其中${fixedOffProfit.map((name) => `「${name}」`).join("、")}没开监控、设为不计入成本或已归档，${NAV_LABELS.my}也不计${fixedOffProfit.length > 1 ? "它们" : "它"}的采购费。` : ""}</> : null}
  </>;
  return <Panel title="核算汇总" className="reconciliation-summary" foot={note}>
    {reference
      ? <Alert type="info" showIcon title="全量摘要仅供参考，正在核对当前窗口" description="关联列表保留已读金额；全量读取完成后再显示当前汇总。" />
      : summary ? <>
        <WindowMetrics totals={summary.totals} />
        {unaccounted ? <UnaccountedUpstreamBlock data={unaccounted} rereading={usageRereading} /> : null}
      </> : <p className="reconciliation-summary__empty">暂无共同整日汇总</p>}
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
