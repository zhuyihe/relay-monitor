"use client";
// 已确认账单历史抽屉正文：只读原确认记录，保留原窗口、来源、Key 和成员，不计入当前汇总。
// 金额只显示 USD 原账，不用当前汇率换算；旧记录缺失的信息照实标为「未保存」，不拿当前目录填补。
import { Alert, Button, Collapse, DatePicker, Select, Table } from "antd";
import { StatusTag } from "../../components/status";
import { EmptyState } from "../../components/data-state";
import type { ConfirmedHistoryRecord } from "../../../lib/client";
import { formatReconciliationMoney as money, reconciliationBillingBasis } from "../../../lib/reconciliation-view";
import { Detail } from "./recon-parts";
import { billingAmountText, channelLabel, formatWindowWithZone, iso, percent } from "./recon-format";
import type { useConfirmedHistory } from "./use-confirmed-history";

const { RangePicker } = DatePicker;

type HistoryState = ReturnType<typeof useConfirmedHistory>;

const CONVERSION_LABEL: Record<string, string> = { quota_per_unit: "配额 ÷ 单位", provider_cost_usd: "上游美元账单" };

function windowLabel(record: ConfirmedHistoryRecord) {
  return record.window.timezone ? formatWindowWithZone(record.window) : `${iso(record.window.startMs)} — ${iso(record.window.endMs)} · 原时区未保存`;
}

const legacy = (record: ConfirmedHistoryRecord) => record.sourceCompleteness === "legacy_partial";

function RecordDetails({ record }: { record: ConfirmedHistoryRecord }) {
  const { ownSource, upstreamSource, amountBasis } = record;
  return <div className="reconciliation-confirmed-details" data-history-id={record.historyId}>
    {legacy(record) ? <Alert type="warning" showIcon title="旧记录信息不完整" description="仅显示原存储区间与已保存金额；缺失的原来源、时区或范围未知，不能据此认定完整自然日。" /> : null}
    <Detail label="原账单窗口" value={windowLabel(record)} />
    <Detail label="原本站来源" value={ownSource ? `${ownSource.provider} · ${ownSource.baseUrl} · 账号 ${ownSource.accountId} · ${ownSource.stationId} · ${ownSource.namespaceKey}` : "原本站来源未保存"} />
    <Detail label="原上游来源" value={`${upstreamSource.provider || "原平台未保存"} · ${upstreamSource.baseUrl || "原地址未保存"} · 账号 ${upstreamSource.accountId ?? "未保存"}`} />
    <Detail label="原 Key / 范围" value={`${upstreamSource.tokenName ?? "原 Key 名称未保存"} · #${upstreamSource.tokenId ?? "未保存"} · 范围版本 ${record.scopeVersion ?? "未保存"}`} />
    <Detail label="原关联渠道" value={record.channels.map(channelLabel).join("、") || "原关联渠道未保存"} />
    <Detail label="原生效时间" value={record.billingEffectiveFromMs == null ? "原生效时间未保存" : iso(record.billingEffectiveFromMs)} />
    <Detail label="原收费 / 成本 / 账面毛利" value={`${billingAmountText(record.downstream, null)} / ${billingAmountText(record.upstream, null)} / ${money(record.calculation.profitUsd, null)}`} />
    <Detail label="原毛利率" value={percent(record.calculation.marginRate)} />
    <Detail label="原账单计量" value={`${amountBasis.currency} · ${amountBasis.billingSource} · 计算版本 ${amountBasis.calculationVersion} · ${CONVERSION_LABEL[amountBasis.conversion as string] || "原换算依据未保存"}`} />
    <Detail label="原收费计量 / 成本计量" value={`${reconciliationBillingBasis(record.downstream)} / ${reconciliationBillingBasis(record.upstream)}`} />
    <Detail label="确认保存时间" value={record.confirmedAt} />
  </div>;
}

const LegacyTag = ({ record }: { record: ConfirmedHistoryRecord }) => legacy(record) ? <StatusTag level="warn">旧记录信息不完整</StatusTag> : null;

function RecordList({ history, compact }: { history: HistoryState; compact: boolean }) {
  const records = history.records?.records || [];
  if (compact) {
    return <div className="reconciliation-confirmed-cards">
      {records.map((record) => <Collapse key={record.historyId} ghost className="reconciliation-confirmed-card" items={[{
        key: record.historyId,
        label: <div className="reconciliation-confirmed-card__head">
          <strong>{record.upstreamSource.tokenName ?? "原 Key 名称未保存"} · 原范围 {record.scopeVersion ?? "未保存"}</strong>
          <span>{windowLabel(record)}</span>
          <span>原记录毛利 {money(record.calculation.profitUsd, null)}</span>
          <LegacyTag record={record} />
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
    scroll={{ x: 880 }}
    columns={[
      {
        title: "原窗口 / 范围", key: "window", width: 250,
        render: (_: any, record: ConfirmedHistoryRecord) => <span className="reconciliation-table-identity">{windowLabel(record)}<small>原范围版本 {record.scopeVersion ?? "未保存"}</small><LegacyTag record={record} /></span>,
      },
      {
        title: "原 Key / 渠道", key: "key", width: 220,
        render: (_: any, record: ConfirmedHistoryRecord) => <span className="reconciliation-table-identity">{record.upstreamSource.tokenName ?? "原 Key 名称未保存"}<small>{record.channels.map(channelLabel).join("、") || "原渠道未保存"}</small></span>,
      },
      { title: "原收费", key: "income", width: 110, align: "right", render: (_: any, record: ConfirmedHistoryRecord) => billingAmountText(record.downstream, null) },
      { title: "原成本", key: "cost", width: 110, align: "right", render: (_: any, record: ConfirmedHistoryRecord) => billingAmountText(record.upstream, null) },
      { title: "原记录毛利", key: "profit", width: 110, align: "right", render: (_: any, record: ConfirmedHistoryRecord) => money(record.calculation.profitUsd, null) },
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

export function ReconHistory({ history, compact, rules }: { history: HistoryState; compact: boolean; rules: any[] }) {
  const { records, busy, error, ruleId } = history;
  const emptyTitle = busy ? "正在读取原确认账单"
    : error ? "历史读取失败，请重试"
      : records ? "所选范围没有已保存的确认账单"
        : ruleId ? "请选择日期并查询原确认账单" : "请选择核算关联";

  return <div className="reconciliation-confirmed">
    <Alert type="info" showIcon title="只读原确认账单，不计入当前汇总" description="保留原窗口、来源、Key 和成员；关联目录的当前名称仅用于定位，不填补旧记录。默认读取最近 31 天，每页 20 条，日期范围最多 31 天。" />
    {history.directoryError
      ? <Alert type="warning" showIcon title="历史关联目录读取失败" description={history.directoryError} action={<Button aria-label="重试历史关联目录" onClick={() => void history.loadDirectory()}>重试</Button>} />
      : null}
    <div className="reconciliation-confirmed__field">
      <span className="reconciliation-confirmed__label">核算关联（含已停止）</span>
      <Select
        aria-label="历史核算关联" showSearch optionFilterProp="label" loading={history.directoryBusy} value={ruleId}
        placeholder="选择当前或已停止的核算关联" onChange={history.chooseRule}
        options={(history.directory || rules).map((rule: any) => ({
          value: rule.id,
          label: `${rule.tokenName || `Key ${rule.tokenId ?? "未命名"}`} · ${rule.archivedAt || !rule.enabled ? "已停止 / 归档" : "当前关联"} · ${rule.id}`,
        }))}
      />
    </div>
    <div className="reconciliation-confirmed__field">
      <RangePicker aria-label="已确认账单历史日期" showTime value={history.range} onChange={history.changeRange} />
    </div>
    {history.rangeChanged && records
      ? <Alert type="info" showIcon title="日期已修改，下方保留上次读取记录" description="请查询所选日期；读取成功后替换为该范围的原账单。" />
      : null}
    <Button disabled={!ruleId} loading={busy} onClick={history.query}>查询已确认历史</Button>
    {error
      ? <Alert type="error" showIcon title="确认账单历史读取失败" description={`${error}。已读记录继续保留。`} action={<Button aria-label="重试确认账单历史" onClick={history.retry}>重试</Button>} />
      : null}
    {records?.records.length ? <RecordList history={history} compact={compact} /> : <EmptyState title={emptyTitle} />}
    {records ? <p className="jy-caption">已读取 {records.records.length} 条原确认记录 · 仅 USD 原账，不使用当前汇率换算。</p> : null}
    {records?.nextCursor ? <Button disabled={history.rangeChanged} loading={busy} onClick={history.loadMore}>读取更多原确认账单</Button> : null}
  </div>;
}
