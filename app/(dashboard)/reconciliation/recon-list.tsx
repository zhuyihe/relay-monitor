"use client";
// 核算关联列表：搜索、状态筛选、桌面表格 / 移动卡片、分页和分组历史展开。
// 列表只读；单行「重试」是唯一会触发观测写库的动作，处理配置都跳到上游账单。
import { Alert, Button, Input, Table } from "antd";
import { RightOutlined, SearchOutlined } from "@ant-design/icons";
import { CountBadge, Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { EmptyState } from "../../components/data-state";
import {
  hasReconciliationHistory,
  mergeReconciliationChannels,
  reconciliationCalculationValues as calculationValues,
} from "../../../lib/reconciliation-view";
import { RowStatus, RuleMobileItem, SegmentHistory, SettlementNote } from "./recon-parts";
import {
  amountText, amountTone, billingCoverageText, channelLabel, channelStateSummary, costText, currentGroup, currentRatioLabel,
  formatRecentTime, incomeText, isFixedCost, percent, ruleHistory, rowHasConflict, sideAmount, upstreamBillsHref, upstreamName,
} from "./recon-format";
import type { ReconStatusFilter, useReconResults } from "./use-recon-results";
import type { ReconciliationCurrency } from "../../../lib/client";

type ListState = ReturnType<typeof useReconResults>;

const keyName = (item: any) => item.rule?.tokenName || "Key";
const expandable = (item: any) => hasReconciliationHistory(ruleHistory(item));

function BillingCell({ text, billing, note }: { text: string; billing: any; note?: string }) {
  return <span className="reconciliation-table-amount">
    {text}
    {note ? <small>{note}</small> : billing?.state !== "complete" ? <small>{billingCoverageText(billing)}</small> : null}
  </span>;
}

export function ReconList({ results, list, currency, upstreams, compact, error, ownStation, retryingRuleIds, ruleRetryErrors, onDetail, onRetry }: {
  results: any[]; list: ListState; currency: ReconciliationCurrency; upstreams: any; compact: boolean; error: string; ownStation: boolean;
  retryingRuleIds: Set<string>; ruleRetryErrors: Record<string, string>; onDetail: (item: any) => void; onRetry: (item: any) => void;
}) {
  const { counts, filtered, currentPage, pageSize, expandedRuleId } = list;
  const values = (item: any) => calculationValues(item.calculation, item.health, item, currency);
  const sortAmount = (side: "income" | "cost") => (a: any, b: any) => (sideAmount(a, side, currency) ?? 0) - (sideAmount(b, side, currency) ?? 0);

  // 金额列紧跟上游 / Key，桌面宽度下不横向滚动也能看到毛利；操作列固定在右侧
  const columns: any[] = [
    { title: "状态", key: "status", width: 112, render: (_: any, item: any) => <RowStatus item={item} currency={currency} /> },
    {
      title: "上游 / Key", key: "upstream", width: 180,
      sorter: (a: any, b: any) => upstreamName(a.rule, upstreams).localeCompare(upstreamName(b.rule, upstreams)),
      render: (_: any, item: any) => <span className="reconciliation-table-identity"><strong>{upstreamName(item.rule, upstreams)}</strong><small>{item.rule?.tokenName || "未命名 Key"}</small></span>,
    },
    { title: "本站收费", key: "income", width: 128, align: "right", sorter: sortAmount("income"), render: (_: any, item: any) => <BillingCell text={incomeText(item, currency)} billing={item.downstream} /> },
    { title: "上游成本", key: "cost", width: 128, align: "right", sorter: sortAmount("cost"), render: (_: any, item: any) => <BillingCell text={costText(item, currency)} billing={item.upstream} note={isFixedCost(item) ? "固定采购" : undefined} /> },
    {
      title: "毛利", key: "profit", width: 128, align: "right",
      sorter: (a: any, b: any) => Number(values(a).profit || 0) - Number(values(b).profit || 0),
      render: (_: any, item: any) => {
        // 旧快照缺两侧金额时毛利退回美元原值，按它实际的币种显示
        const { profit, currency: profitCurrency } = values(item);
        const tone = amountTone(profit);
        return <span className="reconciliation-table-amount">
          <strong className={tone ? `reconciliation-amount--${tone}` : ""}>{profit == null ? "待核算" : amountText(profit, profitCurrency as ReconciliationCurrency)}</strong>
          {profit == null ? null : <SettlementNote item={item} />}
        </span>;
      },
    },
    {
      title: "毛利率", key: "margin", width: 94, align: "right",
      sorter: (a: any, b: any) => Number(values(a).margin || 0) - Number(values(b).margin || 0),
      render: (_: any, item: any) => {
        const margin = values(item).margin;
        const tone = amountTone(margin, { positive: "" });
        return <span className={tone ? `reconciliation-table-amount reconciliation-amount--${tone}` : "reconciliation-table-amount"}>{percent(margin)}</span>;
      },
    },
    {
      title: "当前分组 / 上游倍率", key: "group", width: 185,
      sorter: (a: any, b: any) => currentGroup(a).localeCompare(currentGroup(b)),
      render: (_: any, item: any) => {
        const history = ruleHistory(item);
        return <span className="reconciliation-table-group">{currentGroup(item)} · {currentRatioLabel(item)}{hasReconciliationHistory(history) ? <small>变更历史 · {history.length} 段</small> : null}</span>;
      },
    },
    {
      title: "关联渠道", key: "channels", width: 190,
      sorter: (a: any, b: any) => (a.rule?.channels?.length || 0) - (b.rule?.channels?.length || 0),
      render: (_: any, item: any) => {
        const channels = mergeReconciliationChannels(item.rule?.channels, item.downstream?.channels);
        return <span className="reconciliation-table-channels">{channels.map(channelLabel).join("、") || "—"}{channels.length ? <small>{channelStateSummary(channels)}</small> : null}</span>;
      },
    },
    {
      title: "最近成功", key: "recent", width: 120, align: "right",
      sorter: (a: any, b: any) => Number(new Date(a.lastSuccessfulAt || 0)) - Number(new Date(b.lastSuccessfulAt || 0)),
      render: (_: any, item: any) => <span className="reconciliation-table-amount">{formatRecentTime(item.lastSuccessfulAt, item.window?.timezone)}</span>,
    },
    {
      title: "操作", key: "actions", width: 140, align: "center", fixed: "right",
      render: (_: any, item: any) => <div className="reconciliation-row-actions" onClick={(event) => event.stopPropagation()}>
        <div className="reconciliation-row-actions__buttons">
          <Button type="link" size="small" aria-label={`查看 ${keyName(item)} 的核算详情`} onClick={() => onDetail(item)}>详情</Button>
          <Button type="link" size="small" loading={retryingRuleIds.has(item.rule?.id)} aria-label={`重试 ${keyName(item)} 的当前账单`} onClick={() => onRetry(item)}>重试</Button>
          <Button type="link" size="small" href={upstreamBillsHref(item.rule?.id, rowHasConflict(item))} aria-label={`去上游账单处理 ${keyName(item)} 的核算关联`}>上游账单</Button>
        </div>
        {ruleRetryErrors[item.rule?.id] ? <span className="reconciliation-row-actions__error">{ruleRetryErrors[item.rule.id]}</span> : null}
      </div>,
    },
  ];

  const filters: { value: ReconStatusFilter; label: string }[] = [
    { value: "all", label: `全部 ${counts.all}` },
    { value: "attention", label: `需处理 ${counts.attention}` },
    { value: "negative", label: `负毛利 ${counts.negative}` },
    { value: "pending", label: `切换待确认 ${counts.pending}` },
  ];

  const body = !results.length
    ? <EmptyState title="还没有有效的核算关联" desc="在渠道接入里把上游 Key 和本站销售渠道关联起来后，这里按窗口核算毛利。" action={<Button type="primary" disabled={!ownStation} href="/stations?view=onboarding">去渠道接入</Button>} />
    : !filtered.length
      ? <EmptyState title={list.statusFilter === "attention" && !list.search ? "当前无需处理事项" : "没有匹配的核算关联"} action={<Button onClick={list.showAll}>查看全部关联</Button>} />
      : compact
        ? <>
          <div className="reconciliation-mobile-list">
            {list.pageItems.map((item: any) => <RuleMobileItem
              key={item.rule?.id} item={item} currency={currency} upstreams={upstreams}
              onDetail={() => onDetail(item)} onRetry={() => onRetry(item)}
              retrying={retryingRuleIds.has(item.rule?.id)} retryError={ruleRetryErrors[item.rule?.id]}
              expanded={expandedRuleId === item.rule?.id} onExpand={() => list.toggleExpanded(item.rule?.id)}
            />)}
          </div>
          <div className="reconciliation-mobile-pagination">
            <span>显示 {Math.min(filtered.length, currentPage * pageSize)} / {filtered.length} 条关联</span>
            <div className="reconciliation-mobile-pagination__buttons">
              <Button disabled={currentPage <= 1} onClick={() => list.setPage(currentPage - 1)}>上一页</Button>
              <Button disabled={currentPage * pageSize >= filtered.length} onClick={() => list.setPage(currentPage + 1)}>下一页 <RightOutlined /></Button>
            </div>
          </div>
        </>
        : <Table
          className="jy-table reconciliation-table"
          size="small"
          dataSource={filtered}
          columns={columns}
          rowKey={(item: any) => item.rule?.id}
          rowClassName={(item: any) => expandable(item) ? "reconciliation-row--expandable" : ""}
          scroll={{ x: 1300 }}
          expandable={{
            expandedRowKeys: expandedRuleId ? [expandedRuleId] : [],
            rowExpandable: expandable,
            expandedRowRender: (item: any) => <SegmentHistory item={item} currency={currency} compact={false} onDetail={() => onDetail(item)} />,
            onExpand: (expanded: boolean, item: any) => list.setExpandedRuleId(expanded ? item.rule?.id : null),
            expandRowByClick: true,
          }}
          pagination={{ current: currentPage, pageSize, showSizeChanger: false, total: filtered.length, showTotal: (total, range) => `显示 ${range[0]}–${range[1]} / ${total} 条关联` }}
          onChange={(pagination) => list.setPage(pagination.current || 1)}
          onRow={(item: any) => ({
            tabIndex: expandable(item) ? 0 : undefined,
            onKeyDown: (event: any) => {
              if (expandable(item) && event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                list.toggleExpanded(item.rule?.id);
              }
            },
          })}
        />;

  return <Panel title="核算关联" badge={<CountBadge count={results.length} muted />} body="flush" className="reconciliation-list">
    <div className="reconciliation-list-tools">
      <Input
        className="reconciliation-search" prefix={<SearchOutlined />} allowClear value={list.search}
        onChange={(event) => list.setSearch(event.target.value)}
        placeholder="搜索上游、Key、渠道名称或 ID" aria-label="搜索上游、Key、渠道名称或 ID"
      />
      <Seg label="核算状态筛选" options={filters} value={list.statusFilter} onChange={list.setStatusFilter} />
    </div>
    {!error && results.length > 0 && counts.attention === 0
      ? <Alert type="success" showIcon title={`全部 ${results.length} 条核算关联暂无需处理事项`} className="reconciliation-list-alert" />
      : null}
    {body}
  </Panel>;
}
