"use client";
// 模型与渠道：模型用量排行、按上游的上游成本、模型明细、用量趋势、分组与渠道、没对上上游的渠道、按明细细算。
import { useState } from "react";
import Link from "next/link";
import { UPSTREAM_FORM_TEXT } from "../../../lib/channel-onboarding";
import { COST_MODE_TEXT, EMPTY, RANGE_TEXT, formatCompact, formatInt, formatMoney, formatPct, formatZonedDate, formatZonedTime } from "../../../lib/format";
import { ErrorState } from "../../components/data-state";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Icon } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { AuditPanel } from "./audit-panel";
import type { AuditProps } from "./audit-panel";
import { COL_TEXT, DataTable, Delta, FLOW_UNREADABLE, MY_TEXT, TOKEN_NOTE, deltaSortValue, money, perM, sum, totalsNote } from "./shared";
import type { Col, OwnRange, OwnView, UsageRow } from "./shared";

// 只在模型与渠道标签页出现的话（design/ui-copy-spec.md §12）；列名、时间范围名、「读不到分组和渠道数据」从共用的地方取
const COPY = Object.freeze({
  byHour: "按小时",
  // 模型用量排行
  otherModels: (n: number) => `其他 ${n} 个模型`,
  barsTitle: "模型用量",
  barsCaption: (range: string) => `${range}，前 10 个`,
  metric: "排行指标",
  noModels: "这个时间范围内还没有模型用量。",
  // 按上游的上游成本
  upstreamCost: "上游成本",
  byUpstream: "按上游",
  upstreamCaption: "按上游，不含固定成本",
  upstreamFailed: "上游成本暂时算不出",
  unreadable: "读不到",
  tipHow: "怎么算的",
  tipNote: "说明",
  noUsageUpstream: "没有按用量算成本的上游。",
  unmatchedNote: (n: number) => `${n} 个在用的渠道没对上上游；如果它们来自还没添加的上游，这部分上游成本没有算进利润。`,
  // 模型明细
  colModel: "模型",
  cacheHeavy: "缓存或倍率高",
  cacheHeavyTitle: "消费占比远高于 Token 占比：可能是缓存、长对话或倍率高",
  tableTitle: "模型明细",
  tableCaption: "模型用量明细",
  // 用量趋势
  trendTitle: "用量趋势",
  trendCaptionHourly: "今天每小时的用量",
  trendCaptionDaily: "每天的用量",
  noUsage: "这个时间范围内还没有用量。",
  colTime: "时间",
  colDay: "日期",
  trendTotal: (n: number, unit: string) => `合计（${n} ${unit}）`,
  unitHour: "小时",
  unitDay: "天",
  // 分组与渠道
  flowTitle: "分组与渠道",
  flowCaption: "按消费从高到低",
  flowShareLead: "，占按模型统计的消费的",
  colChannel: "渠道",
  flowTableCaption: (what: string) => `按${what}的消费`,
  coverageNote: (pct: number) => `按分组只统计到 ${pct}% 的消费：较早的用量记录没有分组信息，没算在里面。`,
  // 没对上上游的渠道
  unmatchedSub: "按渠道地址合并。已添加的上游，成本已经算进利润；这里用来检查还有没有漏加的上游。",
  allMatched: "所有渠道都对上了上游。",
  colAddress: "渠道地址",
  colNames: "渠道名",
  colEnabled: "在用",
  enabledOf: (total: number, enabled: number) => `${total} 个里 ${enabled} 个在用`,
});

export function ModelsTab({
  v,
  range,
  reload,
  audit,
}: {
  v: OwnView;
  range: OwnRange;
  reload: () => Promise<unknown>;
  audit: AuditProps;
}) {
  return (
    <>
      <div className="jy-grid-2 jy-grid-even">
        <ModelBars v={v} range={range} />
        <UpstreamCost v={v} reload={reload} />
      </div>
      <ModelTable v={v} range={range} />
      <UsageTrend v={v} range={range} />
      <Flow v={v} reload={reload} />
      <Unmatched v={v} />
      <AuditPanel {...audit} tz={v.d.tz} />
    </>
  );
}

// ---- 模型用量排行 ----------------------------------------------------------

type Metric = "cost" | "tokens";

function ModelBars({ v, range }: { v: OwnView; range: OwnRange }) {
  const [metric, setMetric] = useState<Metric>("cost");
  // 按当前指标重排后再截前 9 个，其余合成一行；否则 Token 很多的便宜模型会被错误地并进「其他」
  const list = [...v.models].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const top = list.length > 10 ? list.slice(0, 9) : list;
  const rest = list.length > 10 ? list.slice(9) : [];
  const tip = (x: { cost: number; tokens: number; requests: number }): [string, string][] =>
    metric === "cost"
      ? [
          [COL_TEXT.tokens, formatCompact(x.tokens)],
          [COL_TEXT.requests, formatInt(x.requests)],
        ]
      : [
          [COL_TEXT.cost, formatMoney(x.cost)],
          [COL_TEXT.requests, formatInt(x.requests)],
        ];
  const items: HBarItem[] = top.map((m) => ({ key: m.model, name: m.model, value: m[metric] || 0, tipExtra: tip(m) }));
  if (rest.length) {
    const agg = { cost: sum(rest, (m) => m.cost), tokens: sum(rest, (m) => m.tokens), requests: sum(rest, (m) => m.requests) };
    items.push({ key: "__rest", name: COPY.otherModels(rest.length), value: agg[metric], tipExtra: tip(agg) });
  }
  return (
    <Panel
      title={COPY.barsTitle}
      caption={COPY.barsCaption(RANGE_TEXT[range])}
      extra={
        <Seg<Metric>
          size="sm"
          label={COPY.metric}
          value={metric}
          onChange={setMetric}
          options={[
            { value: "cost", label: COL_TEXT.cost },
            { value: "tokens", label: COL_TEXT.tokens },
          ]}
        />
      }
    >
      <HBars
        items={items}
        color="var(--jy-s1)"
        unitName={metric === "cost" ? COL_TEXT.cost : COL_TEXT.tokens}
        format={metric === "cost" ? (x) => formatMoney(x) : (x) => formatCompact(x)}
        empty={COPY.noModels}
      />
    </Panel>
  );
}

// ---- 按上游的上游成本 --------------------------------------------------------

function UpstreamCost({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const p = v.profit;
  if (!p || p.error) {
    return (
      <Panel title={COPY.upstreamCost} caption={COPY.byUpstream}>
        <ErrorState what={COPY.upstreamFailed} error={p} onRetry={() => reload()} />
      </Panel>
    );
  }
  const rows: any[] = (p.costs || []).filter((c: any) => c.mode !== "fixed");
  const items: HBarItem[] = rows.map((c, i) => ({
    key: `${c.stationId ?? c.name}-${i}`,
    name: c.name,
    value: c.error && !c.cny ? null : c.cny,
    note: c.error ? COPY.unreadable : undefined,
    // 不认识的算法不标，只写说明
    tipExtra: [
      ...(COST_MODE_TEXT[c.mode as keyof typeof COST_MODE_TEXT] ? ([[COPY.tipHow, COST_MODE_TEXT[c.mode as keyof typeof COST_MODE_TEXT]]] as [string, string][]) : []),
      ...(c.note ? ([[COPY.tipNote, c.note]] as [string, string][]) : []),
    ],
  }));
  const unmatched: any[] = p.unmatched || [];
  const enabledUnmatched = sum(unmatched, (u) => u.enabled);
  return (
    <Panel title={COPY.upstreamCost} caption={COPY.upstreamCaption}>
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName={COPY.upstreamCost}
        total={items.length ? { label: COL_TEXT.total, value: formatMoney(sum(rows, (c) => c.cny)) } : undefined}
        empty={COPY.noUsageUpstream}
      />
      {enabledUnmatched > 0 && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>
            {COPY.unmatchedNote(enabledUnmatched)}
            <Link className="jy-link" href="/stations?edit=new">
              {UPSTREAM_FORM_TEXT.create}
            </Link>
          </span>
        </div>
      )}
    </Panel>
  );
}

// ---- 模型明细 --------------------------------------------------------------

function ModelTable({ v, range }: { v: OwnView; range: OwnRange }) {
  const { models, totCost, totTokens, totReqs, prevLabel } = v;
  // 消费占比远高于 Token 占比：钱花在缓存、长对话或高倍率上，只看 Token 会得出错误结论
  const cacheHeavy = (r: UsageRow) => {
    if (!(totCost > 0) || !(totTokens > 0)) return false;
    const cs = (r.cost || 0) / totCost;
    const ts = (r.tokens || 0) / totTokens;
    return cs > 0.02 && (ts === 0 || cs / ts >= 3);
  };
  const cols: Col<UsageRow>[] = [
    {
      key: "model",
      label: COPY.colModel,
      sort: (r) => r.model,
      render: (r) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {r.model}
          {cacheHeavy(r) && (
            <span className="jy-tag jy-tag--warn" title={COPY.cacheHeavyTitle}>
              {COPY.cacheHeavy}
            </span>
          )}
        </span>
      ),
      foot: COL_TEXT.total,
    },
    { key: "req", label: COL_TEXT.requests, num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests), foot: formatInt(totReqs) },
    { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatInt(r.tokens), foot: formatInt(totTokens) },
    { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost), foot: money(totCost) },
    {
      key: "pct",
      label: COL_TEXT.share,
      num: true,
      sort: (r) => r.cost,
      render: (r) => (totCost > 0 ? formatPct(r.cost / totCost) : EMPTY),
      foot: totCost > 0 ? formatPct(1) : EMPTY,
    },
    { key: "perM", label: COL_TEXT.perM, title: COL_TEXT.perMTitle, num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens), foot: perM(totCost, totTokens) },
    { key: "delta", label: COL_TEXT.delta, title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
  ];
  return (
    <Panel title={COPY.tableTitle} badge={<CountBadge count={models.length} muted />} caption={RANGE_TEXT[range]} foot={totalsNote(v, "models")}>
      <DataTable<UsageRow>
        scroll
        tall
        caption={COPY.tableCaption}
        rows={models}
        rowKey={(r) => String(r.model)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty={COPY.noModels}
        cols={cols}
      />
    </Panel>
  );
}

// ---- 用量趋势（今天按小时，其余按天）--------------------------------------------

function UsageTrend({ v, range }: { v: OwnView; range: OwnRange }) {
  const { d, rate } = v;
  const hourly = range === "today";
  const rows: { t: number; tokens: number; cost: number; requests: number }[] = (d.trend || []).map((x: any) => ({
    t: x.t,
    tokens: x.tokens || 0,
    requests: x.requests || 0,
    cost: (x.cost || 0) * rate,
  }));
  const any = rows.some((r) => r.tokens || r.requests || r.cost);
  // 按业务时区写：小时「14:00」，天「10月9日」
  const label = (t: number) => (hourly ? formatZonedTime(t, d.tz) : formatZonedDate(t, d.tz));
  return (
    <Panel title={COPY.trendTitle} caption={hourly ? COPY.byHour : MY_TEXT.byDay}>
      <DataTable<(typeof rows)[number]>
        scroll
        compact
        caption={hourly ? COPY.trendCaptionHourly : COPY.trendCaptionDaily}
        rows={any ? rows : []}
        rowKey={(r) => String(r.t)}
        defaultSort={{ key: "t", dir: "desc" }}
        empty={COPY.noUsage}
        cols={[
          // 表格只露出一部分行，合计标明覆盖了多少行，免得误以为只合计了看得见的几行
          { key: "t", label: hourly ? COPY.colTime : COPY.colDay, sort: (r) => r.t, render: (r) => label(r.t), foot: COPY.trendTotal(rows.length, hourly ? COPY.unitHour : COPY.unitDay) },
          { key: "req", label: COL_TEXT.requests, num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests), foot: formatInt(sum(rows, (r) => r.requests)) },
          { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatInt(r.tokens), foot: formatInt(sum(rows, (r) => r.tokens)) },
          { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost), foot: money(sum(rows, (r) => r.cost)) },
        ]}
      />
    </Panel>
  );
}

// ---- 分组与渠道 --------------------------------------------------------------

function Flow({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const { d, toCny, prevLabel } = v;
  const flow = d.flow;
  if (!flow) return null;
  if (flow.error) {
    return (
      <Panel title={COPY.flowTitle}>
        <ErrorState what={FLOW_UNREADABLE} error={flow} onRetry={() => reload()} />
      </Panel>
    );
  }
  const cov: number | null = flow.coveragePct ?? null;
  const tables = [
    { key: "group", title: COL_TEXT.group, rows: toCny(flow.byGroup) },
    { key: "channel", title: COPY.colChannel, rows: toCny(flow.byChannel) },
  ];
  return (
    <Panel
      title={COPY.flowTitle}
      caption={COPY.flowCaption}
      sub={
        <>
          {prevLabel}
          {cov != null ? (
            <>
              {COPY.flowShareLead} <b>{cov}%</b>
            </>
          ) : null}
          。
        </>
      }
    >
      {tables.map((t) => (
        <section key={t.key} className="jy-my-section">
          <h3 className="jy-my-h3">
            {t.title}
            <CountBadge count={t.rows.length} muted />
          </h3>
          <DataTable<UsageRow>
            scroll
            caption={COPY.flowTableCaption(t.title)}
            rows={t.rows}
            rowKey={(r, i) => `${r[t.key] ?? ""}-${i}`}
            defaultSort={{ key: "cost", dir: "desc" }}
            empty={MY_TEXT.noData}
            cols={[
              { key: "name", label: t.title, sort: (r) => r[t.key] || "", render: (r) => r[t.key] || <span className="jy-muted">{EMPTY}</span> },
              { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost) },
              { key: "prev", label: COL_TEXT.prev, title: prevLabel, num: true, sort: (r) => r.prevCost, render: (r) => money(r.prevCost) },
              { key: "delta", label: COL_TEXT.delta, title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
              { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatCompact(r.tokens) },
              { key: "perM", label: COL_TEXT.perM, title: COL_TEXT.perMTitle, num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens) },
            ]}
          />
        </section>
      ))}
      {cov != null && cov < 95 && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>{COPY.coverageNote(cov)}</span>
        </div>
      )}
    </Panel>
  );
}

// ---- 没对上上游的渠道 --------------------------------------------------------

const UNMATCHED_TITLE = "没对上上游的渠道";

function Unmatched({ v }: { v: OwnView }) {
  const p = v.profit;
  const list: any[] = p && !p.error ? p.unmatched || [] : [];
  if (!list.length) return null;
  return (
    <Panel
      title={UNMATCHED_TITLE}
      badge={<CountBadge count={list.length} muted />}
      sub={COPY.unmatchedSub}
    >
      <DataTable<any>
        caption={UNMATCHED_TITLE}
        rows={list}
        rowKey={(u) => u.label}
        empty={COPY.allMatched}
        cols={[
          { key: "label", label: COPY.colAddress, sort: (u) => u.label, render: (u) => u.label },
          { key: "names", label: COPY.colNames, render: (u) => <span className="jy-muted">{(u.names || []).join("、")}</span> },
          { key: "enabled", label: COPY.colEnabled, num: true, sort: (u) => u.enabled, render: (u) => COPY.enabledOf(u.total, u.enabled) },
        ]}
      />
    </Panel>
  );
}
