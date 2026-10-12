"use client";
// 模型与渠道：模型用量排行、按上游的用量成本、模型明细、用量趋势、分组与渠道、未关联渠道、日志精算。
import { useState } from "react";
import Link from "next/link";
import { EMPTY, formatCompact, formatHhmm, formatInt, formatMoney, formatMonthDay, formatPct } from "../../../lib/format";
import { ErrorState } from "../../components/data-state";
import { HBars } from "../../components/hbars";
import type { HBarItem } from "../../components/hbars";
import { Icon } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { AuditPanel } from "./audit-panel";
import type { AuditProps } from "./audit-panel";
import { DataTable, Delta, MODE_LABEL, RANGE_LABEL, TOKEN_NOTE, deltaSortValue, money, perM, productErrorMessage, sum, totalsNote } from "./shared";
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
      <AuditPanel {...audit} />
    </>
  );
}

// ---- 模型用量排行 ----------------------------------------------------------

type Metric = "cost" | "tokens";

function ModelBars({ v, range }: { v: OwnView; range: OwnRange }) {
  const [metric, setMetric] = useState<Metric>("cost");
  // 按当前指标重排后再截前 9 个，其余合成一行；否则大量 token 的便宜模型会被错误地并进"其他"
  const list = [...v.models].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const top = list.length > 10 ? list.slice(0, 9) : list;
  const rest = list.length > 10 ? list.slice(9) : [];
  const tip = (x: { cost: number; tokens: number; requests: number }): [string, string][] =>
    metric === "cost"
      ? [
          ["Token", formatCompact(x.tokens)],
          ["请求", formatInt(x.requests)],
        ]
      : [
          ["消费", formatMoney(x.cost)],
          ["请求", formatInt(x.requests)],
        ];
  const items: HBarItem[] = top.map((m) => ({ key: m.model, name: m.model, value: m[metric] || 0, tipExtra: tip(m) }));
  if (rest.length) {
    const agg = { cost: sum(rest, (m) => m.cost), tokens: sum(rest, (m) => m.tokens), requests: sum(rest, (m) => m.requests) };
    items.push({ key: "__rest", name: `其他 ${rest.length} 个模型`, value: agg[metric], tipExtra: tip(agg) });
  }
  return (
    <Panel
      title="模型用量"
      caption={`${RANGE_LABEL[range]}，前 10 个`}
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
        unitName={metric === "cost" ? "消费" : "计费 Token"}
        format={metric === "cost" ? (x) => formatMoney(x) : (x) => formatCompact(x)}
        empty="这个时间范围内还没有模型用量。"
      />
    </Panel>
  );
}

// ---- 按上游的用量成本 --------------------------------------------------------

function UpstreamCost({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const p = v.profit;
  if (!p || p.error) {
    return (
      <Panel title="用量成本" caption="按上游">
        <ErrorState title="上游成本暂时算不出来" error={productErrorMessage(p?.error || "接口没有返回利润数据")} onRetry={() => reload()} />
      </Panel>
    );
  }
  const rows: any[] = (p.costs || []).filter((c: any) => c.mode !== "fixed");
  const items: HBarItem[] = rows.map((c, i) => ({
    key: `${c.stationId ?? c.name}-${i}`,
    name: c.name,
    value: c.error && !c.cny ? null : c.cny,
    note: c.error ? "查询失败" : undefined,
    tipExtra: [["口径", MODE_LABEL[c.mode] || c.mode], ...(c.note ? ([["说明", c.note]] as [string, string][]) : [])],
  }));
  const unmatched: any[] = p.unmatched || [];
  const enabledUnmatched = sum(unmatched, (u) => u.enabled);
  return (
    <Panel title="用量成本" caption="按上游，不含固定成本">
      <HBars
        items={items}
        color="var(--jy-s2)"
        unitName="用量成本"
        total={items.length ? { label: "合计", value: formatMoney(sum(rows, (c) => c.cny)) } : undefined}
        empty="没有按用量计成本的上游。"
      />
      {enabledUnmatched > 0 && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>
            {unmatched.length} 个渠道地址没有关联上游资源；如果它们来自还没添加的上游，这部分成本没有算进来。
            <Link className="jy-link" href="/stations">
              添加上游
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
  // 消费占比远高于 token 占比：钱花在缓存写入、长上下文或高倍率上，只看 token 会得出错误结论
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
            <span className="jy-tag jy-tag--warn" title="消费占比远高于 token 占比：缓存写入、长上下文或高倍率计价">
              倍率/缓存计价
            </span>
          )}
        </span>
      ),
      foot: "合计",
    },
    { key: "req", label: "请求数", num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests), foot: formatInt(totReqs) },
    { key: "tok", label: "计费 Token", title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatInt(r.tokens), foot: formatInt(totTokens) },
    { key: "cost", label: "消费", num: true, sort: (r) => r.cost, render: (r) => money(r.cost), foot: money(totCost) },
    {
      key: "pct",
      label: "占比",
      num: true,
      sort: (r) => r.cost,
      render: (r) => (totCost > 0 ? formatPct(r.cost / totCost) : EMPTY),
      foot: totCost > 0 ? formatPct(1) : EMPTY,
    },
    { key: "perM", label: "¥/M", title: "¥ / 百万计费 token", num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens), foot: perM(totCost, totTokens) },
    { key: "delta", label: "环比", title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
  ];
  return (
    <Panel title="模型明细" badge={<CountBadge count={models.length} muted />} caption={RANGE_LABEL[range]} foot={totalsNote(v, "models")}>
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
  const label = (t: number) => (hourly ? formatHhmm(t) : formatMonthDay(new Date(t)));
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
          { key: "req", label: "请求数", num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests), foot: formatInt(sum(rows, (r) => r.requests)) },
          { key: "tok", label: "计费 Token", title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatInt(r.tokens), foot: formatInt(sum(rows, (r) => r.tokens)) },
          { key: "cost", label: "消费", num: true, sort: (r) => r.cost, render: (r) => money(r.cost), foot: money(sum(rows, (r) => r.cost)) },
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
        <ErrorState title="分组和渠道数据暂时取不到" error={productErrorMessage(flow.error)} onRetry={() => reload()} />
      </Panel>
    );
  }
  const cov: number | null = flow.coveragePct ?? null;
  const tables = [
    { key: "group", title: "分组", rows: toCny(flow.byGroup) },
    { key: "channel", title: "上游渠道", rows: toCny(flow.byChannel) },
  ];
  return (
    <Panel
      title="分组与渠道"
      caption="按消费降序"
      sub={
        <>
          环比对照上一等长窗口{prevDesc ? `（${prevDesc}）` : ""}
          {cov != null ? (
            <>
              ，覆盖模型口径消费的 <b>{cov}%</b>
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
              { key: "cost", label: "消费", num: true, sort: (r) => r.cost, render: (r) => money(r.cost) },
              { key: "prev", label: "上窗", title: prevLabel, num: true, sort: (r) => r.prevCost, render: (r) => money(r.prevCost) },
              { key: "delta", label: "环比", title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
              { key: "tok", label: "计费 Token", title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatCompact(r.tokens) },
              { key: "perM", label: "¥/M", title: "¥ / 百万计费 token", num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens) },
            ]}
          />
        </section>
      ))}
      {cov != null && cov < 95 && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>分组口径只覆盖 {cov}% 的消费：New API 的流向查询会跳过没有分组字段的历史记录。</span>
        </div>
      )}
    </Panel>
  );
}

// ---- 未关联上游资源的渠道 ----------------------------------------------------

function Unmatched({ v }: { v: OwnView }) {
  const p = v.profit;
  const list: any[] = p && !p.error ? p.unmatched || [] : [];
  if (!list.length) return null;
  return (
    <Panel
      title="未关联上游资源的渠道"
      badge={<CountBadge count={list.length} muted />}
      sub="按渠道地址合并。上游资源里的成本已单独计入，这里用来检查还有没有漏加的外部上游。"
    >
      <DataTable<any>
        caption="未关联上游资源的渠道"
        rows={list}
        rowKey={(u) => u.label}
        empty="所有渠道都已关联上游资源。"
        cols={[
          { key: "label", label: "渠道地址", sort: (u) => u.label, render: (u) => u.label },
          { key: "names", label: "渠道名", render: (u) => <span className="jy-muted">{(u.names || []).join("、")}</span> },
          { key: "enabled", label: "启用", num: true, sort: (u) => u.enabled, render: (u) => `${u.enabled} / ${u.total}` },
        ]}
      />
    </Panel>
  );
}
