"use client";
// 以前的每日记录（抽屉正文）：每天固定时记下的收入、上游成本和毛利，固定后不再变，也不算进上面的汇总。
// 金额按记下的美元原值显示，不用现在的汇率换算；记录里没有的写「—」，不拿现在的绑定去补。用语按 design/ui-copy-spec.md §3、§9。
import { Alert, Button, Collapse, DatePicker, Select, Table } from "antd";
import { StatusTag } from "../../components/status";
import { EmptyState, Skeleton } from "../../components/data-state";
import { ErrorDetail } from "../../components/error-detail";
import type { ConfirmedHistoryRecord } from "../../../lib/client";
import { EMPTY, FIXED_COST_TEXT, formatPct, formatZonedDate, formatZonedDateTime, refreshFailedText } from "../../../lib/format";
import { SUB2API_UNBIND_DAY } from "../../../lib/workflow-actions";
import { failureText } from "../../../lib/error-copy";
import { INCOMPLETE_DAY_TEXT } from "../../../lib/reconciliation-contract";
import { formatReconciliationMoney as money, reconciliationBillingText, reconciliationChannelName, reconciliationKeyName, reconciliationKeyNamer } from "../../../lib/reconciliation-view";
import { Detail } from "./recon-parts";
import { RECON_BUTTONS, RECON_COPY, formatWindow, rateLine, upstreamName } from "./recon-format";
import type { useConfirmedHistory } from "./use-confirmed-history";

const { RangePicker } = DatePicker;

type HistoryState = ReturnType<typeof useConfirmedHistory>;

// 早期的记录缺了来源、时区或渠道（§5.5）
const incomplete = (record: ConfirmedHistoryRecord) => record.sourceCompleteness === "legacy_partial" || !record.window.timezone;

// 缺时区的早期记录按业务时区写日期
const dayText = (record: ConfirmedHistoryRecord) => formatWindow({ ...record.window, timezone: record.window.timezone || undefined });

// 固定时这个上游计入固定成本：上游成本一格不写金额（§3.2）；其余（含以前的数据）按 Key 用量算
const fixedRecord = (record: ConfirmedHistoryRecord) => record.costBasis === "fixed";
const costText = (record: ConfirmedHistoryRecord) => fixedRecord(record) ? FIXED_COST_TEXT : reconciliationBillingText(record.upstream);

const keyText = (record: ConfirmedHistoryRecord) => record.upstreamSource.tokenName || record.upstreamSource.tokenId != null
  ? reconciliationKeyName(record.upstreamSource) : EMPTY;
const channelsText = (record: ConfirmedHistoryRecord) => record.channels.map(reconciliationChannelName).join("、") || EMPTY;

// 重新固定过的写「改过 N 次」（§4）
const revisions = (record: ConfirmedHistoryRecord) => Number(record.revision) - 1;
const revisionText = (record: ConfirmedHistoryRecord) => revisions(record) > 0 ? `改过 ${revisions(record)} 次` : "";

// 固定时记下的汇率；以前的数据没记，写「—」
function settledRateText(record: ConfirmedHistoryRecord) {
  const rates = record.settlementSource === "migrated" ? null : record.settledRates;
  const text = rates ? rateLine(rates.income, rates.cost, fixedRecord(record)) : EMPTY;
  return text === EMPTY ? EMPTY : `${text}，${formatZonedDateTime(record.confirmedAt, record.window.timezone || undefined)} 固定时记下`;
}

function RecordDetails({ record }: { record: ConfirmedHistoryRecord }) {
  const timezone = record.window.timezone || undefined;
  const start = record.accountingStartMs ?? record.billingEffectiveFromMs;
  return <div className="reconciliation-confirmed-details" data-history-id={record.historyId}>
    {incomplete(record) ? <Alert type="warning" showIcon title={INCOMPLETE_DAY_TEXT} /> : null}
    <Detail label="时间" value={dayText(record)} />
    <Detail label="Key" value={keyText(record)} />
    <Detail label="收入" value={<>{reconciliationBillingText(record.downstream)}<small>{record.channels.length ? RECON_COPY.incomeSource(record.channels.length) : EMPTY}</small></>} />
    <Detail label="上游成本" value={costText(record)} />
    <Detail label="毛利" value={money(record.calculation.profitUsd, null)} />
    <Detail label="毛利率" value={formatPct(record.calculation.marginRate)} />
    <Detail label="汇率" value={settledRateText(record)} />
    <Detail label="固定于" value={formatZonedDateTime(record.confirmedAt, timezone)} />
    {start != null && start > record.window.startMs ? <Detail label="开始统计" value={formatZonedDateTime(start, timezone)} /> : null}
    {record.accountedToMs != null ? <Detail label="统计到" value={`${formatZonedDateTime(record.accountedToMs, timezone)}（解除绑定）`} /> : null}
    {revisionText(record) ? <Detail label="改过" value={revisionText(record)} /> : null}
  </div>;
}

const IncompleteTag = ({ record }: { record: ConfirmedHistoryRecord }) => incomplete(record) ? <StatusTag level="warn">{INCOMPLETE_DAY_TEXT}</StatusTag> : null;
const RevisionNote = ({ record }: { record: ConfirmedHistoryRecord }) => revisionText(record) ? <small>{revisionText(record)}</small> : null;

function RecordList({ history, compact }: { history: HistoryState; compact: boolean }) {
  const records = history.records?.records || [];
  if (compact) {
    return <div className="reconciliation-confirmed-cards">
      {records.map((record) => <Collapse key={record.historyId} ghost className="reconciliation-confirmed-card" items={[{
        key: record.historyId,
        label: <div className="reconciliation-confirmed-card__head">
          <strong>{dayText(record)} · {keyText(record)}</strong>
          <span>毛利 {money(record.calculation.profitUsd, null)}{fixedRecord(record) ? ` · ${FIXED_COST_TEXT}` : ""}</span>
          <RevisionNote record={record} />
          <IncompleteTag record={record} />
        </div>,
        children: <RecordDetails record={record} />,
      }]} />)}
    </div>;
  }
  return <Table
    className="jy-table reconciliation-confirmed-table"
    size="small"
    rowKey="historyId"
    dataSource={records}
    pagination={false}
    scroll={{ x: 820 }}
    columns={[
      {
        title: "日期", key: "day", width: 150,
        render: (_: any, record: ConfirmedHistoryRecord) => <span className="reconciliation-table-identity">{dayText(record)}<RevisionNote record={record} /><IncompleteTag record={record} /></span>,
      },
      { title: "Key", key: "key", width: 140, render: (_: any, record: ConfirmedHistoryRecord) => keyText(record) },
      { title: "渠道", key: "channels", width: 170, render: (_: any, record: ConfirmedHistoryRecord) => channelsText(record) },
      { title: "收入", key: "income", width: 110, align: "right", render: (_: any, record: ConfirmedHistoryRecord) => reconciliationBillingText(record.downstream) },
      { title: "上游成本", key: "cost", width: 120, align: "right", render: (_: any, record: ConfirmedHistoryRecord) => costText(record) },
      { title: "毛利", key: "profit", width: 110, align: "right", render: (_: any, record: ConfirmedHistoryRecord) => money(record.calculation.profitUsd, null) },
    ]}
    expandable={{
      expandedRowKeys: history.expandedId ? [history.expandedId] : [],
      onExpand: (expanded, record) => history.setExpandedId(expanded ? record.historyId : null),
      expandedRowRender: (record) => <RecordDetails record={record} />,
    }}
    onRow={(record) => ({
      tabIndex: 0,
      onKeyDown: (event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          history.toggleExpanded(record.historyId);
        }
      },
    })}
  />;
}

// 读取中：骨架占位，不写字（§8.1）
const ListSkeleton = () => <div aria-busy="true" className="jy-stack" style={{ gap: 10 }}>
  <span className="sr-only">读取中</span>
  {[0, 1, 2].map((i) => <Skeleton key={i} width={i === 2 ? "60%" : "100%"} />)}
</div>;

export function ReconHistory({ history, compact, rules, upstreams, businessTimezone }: {
  history: HistoryState; compact: boolean; rules: any[]; upstreams?: any[]; businessTimezone?: string;
}) {
  const { records, busy, error, ruleId } = history;
  // 这个上游现在计入固定成本，但有的日子当时是按 Key 用量算的：照原样显示，只加一句说明
  const directory = history.directory || rules;
  const rule = directory.find((item: any) => item.id === ruleId);
  const fixedUpstream = upstreams?.find((station: any) => String(station.id) === String(rule?.upstreamStationId))?.costBasis === "fixed";
  const usageRecords = !!records?.records.some((record) => !fixedRecord(record));
  const ended = (item: any) => item.archivedAt || !item.enabled;
  const keyName = reconciliationKeyNamer(directory);

  return <div className="reconciliation-confirmed">
    <p className="jy-caption">每天固定后不会再变，也不算进上面的汇总。默认看最近 31 天，一次最多查 31 天。</p>
    {history.directoryError
      ? <Alert
        type="warning" showIcon title={failureText("读不到绑定列表", history.directoryError)} description={<ErrorDetail raw={history.directoryError} />}
        action={<Button size="small" loading={history.directoryBusy} onClick={() => void history.loadDirectory()}>{RECON_BUTTONS.refresh}</Button>}
      />
      : null}
    <div className="reconciliation-confirmed__field">
      <span className="reconciliation-confirmed__label">绑定（含已解除）</span>
      <Select
        aria-label="绑定" showSearch optionFilterProp="label" loading={history.directoryBusy} value={ruleId}
        placeholder="选择绑定（含已解除）" onChange={history.chooseRule}
        options={directory.map((item: any) => ({
          value: item.id,
          label: `${keyName(item)} · ${upstreamName(item, upstreams)} · ${ended(item) ? "已解除绑定" : "在用"}`,
        }))}
      />
    </div>
    <div className="reconciliation-confirmed__field">
      <RangePicker aria-label="日期" showTime value={history.range} onChange={history.changeRange} />
    </div>
    {history.rangeChanged && records ? <Alert type="info" showIcon title="日期改了，点「查询」后更新" /> : null}
    <Button disabled={!ruleId} loading={busy} onClick={history.query}>查询</Button>
    {error ? <Alert
      type="warning" showIcon
      title={records && history.loadedAt ? refreshFailedText(history.loadedAt, businessTimezone) : failureText(`读不到${RECON_BUTTONS.history}`, error)}
      description={<ErrorDetail raw={error} />}
      action={<Button size="small" loading={busy} onClick={history.retry}>{RECON_BUTTONS.refresh}</Button>}
    /> : null}
    {records?.records.length ? <RecordList history={history} compact={compact} />
      : busy ? <ListSkeleton />
        : error ? null
          : <EmptyState title={records ? "这几天没有每日记录。" : ruleId ? "选好日期后点「查询」" : "请选择绑定"} />}
    {records ? <p className="jy-caption">{records.records.length} 条每日记录 · 按美元显示。只列每天的记录，以前的数据还在。</p> : null}
    {records && rule?.archivedAt && rule.provider === "sub2api"
      ? <p className="jy-caption">{SUB2API_UNBIND_DAY(formatZonedDate(rule.archivedAtMs ?? Date.parse(rule.archivedAt), rule.timezone))}</p>
      : null}
    {records && fixedUpstream && usageRecords
      ? <p className="jy-caption">这个上游现在计入固定成本；没标「{FIXED_COST_TEXT}」的日子是当时按用量算的上游成本，不改。</p>
      : null}
    {records?.nextCursor ? <Button disabled={history.rangeChanged} loading={busy} onClick={history.loadMore}>加载更多</Button> : null}
  </div>;
}
