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
import { COL_TEXT, DataTable, Delta, FLOW_UNREADABLE, TOKEN_NOTE, deltaSortValue, money, perM, sum, totalsNote } from "./shared";
import type { Col, OwnRange, OwnView, UsageRow } from "./shared";

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
          ["Token", formatCompact(x.tokens)],
          [COL_TEXT.requests, formatInt(x.requests)],
        ]
      : [
          [COL_TEXT.cost, formatMoney(x.cost)],
          [COL_TEXT.requests, formatInt(x.requests)],
        ];
  const items: HBarItem[] = top.map((m) => ({ key: m.model, name: m.model, value: m[metric] || 0, tipExtra: tip(m) }));
  if (rest.length) {
    const agg = { cost: sum(rest, (m) => m.cost), tokens: sum(rest, (m) => m.tokens), requests: sum(rest, (m) => m.requests) };
    items.push({ key: "__rest", name: `其他 ${rest.length} 个模型`, value: agg[metric], tipExtra: tip(agg) });
  }
  return (
    <Panel
      title="模型用量"
      caption={`${RANGE_TEXT[range]}，前 10 个`}
      extra={
        <Seg<Metric>
          size="sm"
          label="排行指标"
          value={metric}
          onChange={setMetric}
          options={[
            { value: "cost", label: "消费" },
            { value: "tokens", label: "Token" },
          ]}
        />
      }
    >
      <HBars
        items={items}
        color="var(--jy-s1)"
        unitName={metric === "cost" ? COL_TEXT.cost : COL_TEXT.tokens}
        format={metric === "cost" ? (x) => formatMoney(x) : (x) => formatCompact(x)}
        empty="这个时间范围内还没有模型用量。"
      />
    </Panel>
  );
}

// ---- 按上游的上游成本 --------------------------------------------------------

function UpstreamCost({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const p = v.profit;
  if (!p || p.error) {
    return (
      <Panel title="上游成本" caption="按上游">
        <ErrorState what="上游成本暂时算不出" error={p?.error} onRetry={() => reload()} />
      </Panel>
    );
  }
  const rows: any[] = (p.costs || []).filter((c: any) => c.mode !== "fixed");
  const items: HBarItem[] = rows.map((c, i) => ({
    key: `${c.stationId ?? c.name}-${i}`,
    name: c.name,
    value: c.error && !c.cny ? null : c.cny,
    note: c.error ? "读不到" : undefined,
    // 不认识的算法不标，只写说明
    tipExtra: [
      ...(COST_MODE_TEXT[c.mode as keyof typeof COST_MODE_TEXT] ? ([["怎么算的", COST_MODE_TEXT[c.mode as keyof typeof COST_MODE_TEXT]]] as [string, string][]) : []),
      ...(c.note ? ([["说明", c.note]] as [string, string][]) : []),
    ],
  }));
  const unmatched: any[] = p.unmatched || [];
  const enabledUnmatched = sum(unmatched, (u) => u.enabled);
  return (
    <Panel title="上游成本" caption="按上游，不含固定成本">
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName="上游成本"
        total={items.length ? { label: "合计", value: formatMoney(sum(rows, (c) => c.cny)) } : undefined}
        empty="没有按用量算成本的上游。"
      />
      {enabledUnmatched > 0 && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>
            {enabledUnmatched} 个在用的渠道没对上上游；如果它们来自还没添加的上游，这部分上游成本没有算进利润。
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
      label: "模型",
      sort: (r) => r.model,
      render: (r) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {r.model}
          {cacheHeavy(r) && (
            <span className="jy-tag jy-tag--warn" title="消费占比远高于 Token 占比：可能是缓存、长对话或倍率高">
              缓存或倍率高
            </span>
          )}
        </span>
      ),
      foot: "合计",
    },
    { key: "req", label: COL_TEXT.requests, num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests), foot: formatInt(totReqs) },
    { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatInt(r.tokens), foot: formatInt(totTokens) },
    { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost), foot: money(totCost) },
    {
      key: "pct",
      label: "占比",
      num: true,
      sort: (r) => r.cost,
      render: (r) => (totCost > 0 ? formatPct(r.cost / totCost) : EMPTY),
      foot: totCost > 0 ? formatPct(1) : EMPTY,
    },
    { key: "perM", label: COL_TEXT.perM, title: COL_TEXT.perMTitle, num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens), foot: perM(totCost, totTokens) },
    { key: "delta", label: COL_TEXT.delta, title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
  ];
  return (
    <Panel title="模型明细" badge={<CountBadge count={models.length} muted />} caption={RANGE_TEXT[range]} foot={totalsNote(v, "models")}>
      <DataTable<UsageRow>
        scroll
        tall
        caption="模型用量明细"
        rows={models}
        rowKey={(r) => String(r.model)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty="这个时间范围内还没有模型用量。"
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
    <Panel title="用量趋势" caption={hourly ? "按小时" : "按天"}>
      <DataTable<(typeof rows)[number]>
        scroll
        compact
        caption={hourly ? "今天每小时的用量" : "每天的用量"}
        rows={any ? rows : []}
        rowKey={(r) => String(r.t)}
        defaultSort={{ key: "t", dir: "desc" }}
        empty="这个时间范围内还没有用量。"
        cols={[
          // 表格只露出一部分行，合计标明覆盖了多少行，免得误以为只合计了看得见的几行
          { key: "t", label: hourly ? "时间" : "日期", sort: (r) => r.t, render: (r) => label(r.t), foot: `合计（${rows.length} ${hourly ? "小时" : "天"}）` },
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
  const { d, toCny, prevDesc, prevLabel } = v;
  const flow = d.flow;
  if (!flow) return null;
  if (flow.error) {
    return (
      <Panel title="分组与渠道">
        <ErrorState what={FLOW_UNREADABLE} error={flow.error} onRetry={() => reload()} />
      </Panel>
    );
  }
  const cov: number | null = flow.coveragePct ?? null;
  const tables = [
    { key: "group", title: "分组", rows: toCny(flow.byGroup) },
    { key: "channel", title: "渠道", rows: toCny(flow.byChannel) },
  ];
  return (
    <Panel
      title="分组与渠道"
      caption="按消费从高到低"
      sub={
        <>
          和上期比{prevDesc ? `（${prevDesc}）` : ""}
          {cov != null ? (
            <>
              ，占按模型统计的消费的 <b>{cov}%</b>
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
            caption={`按${t.title}的消费`}
            rows={t.rows}
            rowKey={(r, i) => `${r[t.key] ?? ""}-${i}`}
            defaultSort={{ key: "cost", dir: "desc" }}
            empty="这个时间范围内还没有数据。"
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
          <span>按分组只统计到 {cov}% 的消费：较早的用量记录没有分组信息，没算在里面。</span>
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
      sub="按渠道地址合并。已添加的上游，成本已经算进利润；这里用来检查还有没有漏加的上游。"
    >
      <DataTable<any>
        caption={UNMATCHED_TITLE}
        rows={list}
        rowKey={(u) => u.label}
        empty="所有渠道都对上了上游。"
        cols={[
          { key: "label", label: "渠道地址", sort: (u) => u.label, render: (u) => u.label },
          { key: "names", label: "渠道名", render: (u) => <span className="jy-muted">{(u.names || []).join("、")}</span> },
          { key: "enabled", label: "在用", num: true, sort: (u) => u.enabled, render: (u) => `${u.total} 个里 ${u.enabled} 个在用` },
        ]}
      />
    </Panel>
  );
}
