"use client";
// 绑定列表：搜索、状态筛选、桌面表格 / 手机卡片、分页和倍率变化展开。
// 列表只读；单行「重新读取」是唯一会写库的动作，改绑定、处理重复等都跳到上游账单。
import { Alert, Button, Input, Table } from "antd";
import { RightOutlined, SearchOutlined } from "@ant-design/icons";
import { CountBadge, Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { EmptyState } from "../../components/data-state";
import { ErrorDetail } from "../../components/error-detail";
import { EMPTY, NOTHING_TO_HANDLE, formatPct } from "../../../lib/format";
import {
  hasReconciliationHistory,
  mergeReconciliationChannels,
  reconciliationChannelName,
  reconciliationRowFlags,
} from "../../../lib/reconciliation-view";
import { IssueAction, LossTag, RowStatus, RuleMobileItem, SegmentHistory } from "./recon-parts";
import {
  RECON_BUTTONS, RETRY_FAILED_TEXT, amountText, channelStateSummary, costText, currentGroup, currentRatioLabel, formatRecentTime, incomeText, ruleHistory,
  sideAmount, upstreamName,
} from "./recon-format";
import type { ReconStatusFilter, useReconResults } from "./use-recon-results";
import type { ReconciliationCurrency } from "../../../lib/client";

type ListState = ReturnType<typeof useReconResults>;

const expandable = (item: any) => hasReconciliationHistory(ruleHistory(item));

// 绑定渠道的地方（§3.1 渠道绑定）
const CONNECT_HREF = "/stations?view=channels";

export function ReconList({ results, keyName: ruleKeyName, list, currency, upstreams, compact, error, ownStation, asOf, retryingRuleIds, ruleRetryErrors, onDetail, onRetry }: {
  results: any[]; keyName: (rule: any) => string; list: ListState; currency: ReconciliationCurrency; upstreams: any; compact: boolean; error: unknown; ownStation: boolean; asOf: string;
  retryingRuleIds: Set<string>; ruleRetryErrors: Record<string, string>; onDetail: (item: any) => void; onRetry: (item: any) => void;
}) {
  const { counts, filtered, currentPage, pageSize, expandedRuleId } = list;
  const flags = (item: any) => reconciliationRowFlags(item, currency);
  const sortAmount = (side: "income" | "cost") => (a: any, b: any) => (sideAmount(a, side, currency) ?? 0) - (sideAmount(b, side, currency) ?? 0);
  const sortValue = (key: "profit" | "margin") => (a: any, b: any) => Number(flags(a).values[key] ?? 0) - Number(flags(b).values[key] ?? 0);
  const keyName = (item: any) => ruleKeyName(item.rule);

  // 金额列紧跟上游和 Key，桌面宽度下不横向滚动也能看到毛利；操作列固定在右侧
  const columns: any[] = [
    { title: "状态", key: "status", width: 150, render: (_: any, item: any) => <RowStatus item={item} currency={currency} /> },
    {
      title: "上游 / Key", key: "upstream", width: 180,
      sorter: (a: any, b: any) => upstreamName(a.rule, upstreams).localeCompare(upstreamName(b.rule, upstreams)),
      render: (_: any, item: any) => <span className="reconciliation-table-identity"><strong>{upstreamName(item.rule, upstreams)}</strong><small>{keyName(item)}</small></span>,
    },
    { title: "收入", key: "income", width: 128, align: "right", sorter: sortAmount("income"), render: (_: any, item: any) => <span className="reconciliation-table-amount">{incomeText(item, currency)}</span> },
    {
      title: "上游成本", key: "cost", width: 128, align: "right", sorter: sortAmount("cost"),
      render: (_: any, item: any) => <span className="reconciliation-table-amount">{costText(item, currency)}</span>,
    },
    {
      title: "毛利", key: "profit", width: 128, align: "right", sorter: sortValue("profit"),
      render: (_: any, item: any) => {
        // 旧数据缺两侧金额时毛利退回美元原值，按它实际的币种显示
        const { values, negative } = flags(item);
        return <span className="reconciliation-table-amount">
          <strong>{amountText(values.profit, values.currency as ReconciliationCurrency)}</strong>
          <LossTag show={negative} />
        </span>;
      },
    },
    {
      title: "毛利率", key: "margin", width: 94, align: "right", sorter: sortValue("margin"),
      render: (_: any, item: any) => <span className="reconciliation-table-amount">{formatPct(flags(item).values.margin)}</span>,
    },
    {
      title: "分组 / 倍率", key: "group", width: 170,
      sorter: (a: any, b: any) => currentGroup(a).localeCompare(currentGroup(b)),
      render: (_: any, item: any) => {
        const history = ruleHistory(item);
        return <span className="reconciliation-table-group">{currentGroup(item)} · {currentRatioLabel(item)}{hasReconciliationHistory(history) ? <small>倍率变化 · {history.length - 1} 次</small> : null}</span>;
      },
    },
    {
      title: "绑定的渠道", key: "channels", width: 190,
      sorter: (a: any, b: any) => (a.rule?.channels?.length || 0) - (b.rule?.channels?.length || 0),
      render: (_: any, item: any) => {
        const channels = mergeReconciliationChannels(item.rule?.channels, item.downstream?.channels);
        const states = channelStateSummary(channels);
        return <span className="reconciliation-table-channels">{channels.map(reconciliationChannelName).join("、") || EMPTY}{states ? <small>{states}</small> : null}</span>;
      },
    },
    {
      title: "数据截至", key: "recent", width: 120, align: "right",
      sorter: (a: any, b: any) => Number(new Date(a.lastSuccessfulAt || 0)) - Number(new Date(b.lastSuccessfulAt || 0)),
      render: (_: any, item: any) => <span className="reconciliation-table-amount">{formatRecentTime(item.lastSuccessfulAt, item.window?.timezone)}</span>,
    },
    {
      title: "操作", key: "actions", width: 160, align: "center", fixed: "right",
      render: (_: any, item: any) => <div className="reconciliation-row-actions" onClick={(event) => event.stopPropagation()}>
        <div className="reconciliation-row-actions__buttons">
          <Button type="link" size="small" aria-label={`查看 ${keyName(item)} 的计算明细`} onClick={() => onDetail(item)}>计算明细</Button>
          <Button type="link" size="small" loading={retryingRuleIds.has(item.rule?.id)} aria-label={`${RECON_BUTTONS.retry} ${keyName(item)}`} onClick={() => onRetry(item)}>{RECON_BUTTONS.retry}</Button>
          <IssueAction type="link" size="small" action={flags(item).displayStatus.action} onDetail={() => onDetail(item)} target={keyName(item)} />
        </div>
        {ruleRetryErrors[item.rule?.id] ? <span className="reconciliation-row-actions__error">{RETRY_FAILED_TEXT}<ErrorDetail raw={ruleRetryErrors[item.rule.id]} /></span> : null}
      </div>,
    },
  ];

  const filters: { value: ReconStatusFilter; label: string }[] = [
    { value: "all", label: `全部 ${counts.all}` },
    { value: "attention", label: `需处理 ${counts.attention}` },
    { value: "negative", label: `亏损 ${counts.negative}` },
  ];
  const calm = asOf ? `${NOTHING_TO_HANDLE}${asOf}。` : NOTHING_TO_HANDLE;

  const body = !results.length
    ? <EmptyState title="还没有绑定" desc="把上游的 Key 和自营站点的渠道绑定后，这里每天算一次利润。" action={<Button type="primary" disabled={!ownStation} href={CONNECT_HREF}>{RECON_BUTTONS.connect}</Button>} />
    : !filtered.length
      ? <EmptyState title={list.statusFilter === "attention" && !list.search ? calm : "没有匹配的绑定"} action={<Button onClick={list.showAll}>查看全部绑定</Button>} />
      : compact
        ? <>
          <div className="reconciliation-mobile-list">
            {list.pageItems.map((item: any) => <RuleMobileItem
              key={item.rule?.id} item={item} keyName={keyName(item)} currency={currency} upstreams={upstreams}
              onDetail={() => onDetail(item)} onRetry={() => onRetry(item)}
              retrying={retryingRuleIds.has(item.rule?.id)} retryError={ruleRetryErrors[item.rule?.id]}
              expanded={expandedRuleId === item.rule?.id} onExpand={() => list.toggleExpanded(item.rule?.id)}
            />)}
          </div>
          <div className="reconciliation-mobile-pagination">
            <span>显示 {(currentPage - 1) * pageSize + 1}–{Math.min(filtered.length, currentPage * pageSize)} / {filtered.length} 条绑定</span>
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
            expandedRowRender: (item: any) => <SegmentHistory item={item} keyName={keyName(item)} currency={currency} compact={false} onDetail={() => onDetail(item)} />,
            onExpand: (expanded: boolean, item: any) => list.setExpandedRuleId(expanded ? item.rule?.id : null),
            expandRowByClick: true,
          }}
          pagination={{ current: currentPage, pageSize, showSizeChanger: false, total: filtered.length, showTotal: (total, range) => `显示 ${range[0]}–${range[1]} / ${total} 条绑定` }}
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

  return <Panel title="绑定列表" badge={<CountBadge count={results.length} muted />} body="flush" className="reconciliation-list">
    <div className="reconciliation-list-tools">
      <Input
        className="reconciliation-search" prefix={<SearchOutlined />} allowClear value={list.search}
        onChange={(event) => list.setSearch(event.target.value)}
        placeholder="搜索上游、Key、渠道名或渠道 ID" aria-label="搜索上游、Key、渠道名或渠道 ID"
      />
      <Seg label="状态筛选" options={filters} value={list.statusFilter} onChange={list.setStatusFilter} />
    </div>
    {!error && results.length > 0 && counts.attention === 0
      ? <Alert type="success" showIcon title={calm} className="reconciliation-list-alert" />
      : null}
    {body}
  </Panel>;
}
