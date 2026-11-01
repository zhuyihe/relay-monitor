"use client";
// 概览：一句结论 → 四个数 → 每天的用户消费（design 用户运营 v6 §2、v7 §2）。
// 一句结论和四个数由 users-format.ts 拼，这里只摆；补数据没补满时哪些数先不出，由接口的 ready 说明。
import { useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState } from "../../components/data-state";
import { Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { TrendChart } from "./charts";
import type { Metric } from "./charts";
import { COPY } from "./copy";
import { SOON_LINK, money, overviewKpis, overviewSentence, prevSeriesOf, seriesOf } from "./users-format";
import type { UsersPage } from "./users-format";

const METRICS: Metric[] = ["cost", "users", "fresh"];

export function OverviewTab({ page, onOpenUser }: { page: UsersPage; onOpenUser: (id: number) => void }) {
  const [metric, setMetric] = useState<Metric>("cost");
  const sentence = useMemo(() => overviewSentence(page), [page]);
  const kpis = useMemo(() => overviewKpis(page), [page]);
  const { rate } = page;
  const values = useMemo(() => seriesOf(page.trend, metric).map((v) => (v == null ? null : metric === "cost" ? v * rate : v)), [page.trend, metric, rate]);
  const hasDays = page.trend.some((day) => day.available);
  const prevRaw = useMemo(() => prevSeriesOf(page, metric), [page, metric]);
  const prev = useMemo(() => (prevRaw ? prevRaw.map((v) => (v == null ? null : metric === "cost" ? v * rate : v)) : null), [prevRaw, metric, rate]);
  return (
    <>
      <p className="jy-users-sentence">
        {sentence.map((part, index) =>
          part.kind === "text" ? <span key={index}>{part.text}</span>
            : part.kind === "user" ? <button key={index} type="button" className="jy-link jy-users-linkbtn" onClick={() => onOpenUser(part.id)}>{part.name}</button>
              : <Link key={index} className="jy-link" href={SOON_LINK}>{part.text}</Link>,
        )}
      </p>
      <Panel label={COPY.overview.kpiLabel}>
        <dl className="jy-kpis jy-users-kpis">
          {kpis.map((kpi) => (
            <div key={kpi.key}>
              <dt title={kpi.titleHint}>{kpi.title}</dt>
              <dd className="jy-kpi-figure">{kpi.value}</dd>
              <dd className="jy-caption">{kpi.sub}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel
        title={COPY.overview.chartTitles[metric]}
        extra={
          <Seg<Metric>
            size="sm"
            label={COPY.overview.metricLabel}
            value={metric}
            onChange={setMetric}
            options={METRICS.map((value) => ({ value, label: COPY.overview.metrics[value] }))}
          />
        }
      >
        {!hasDays ? (
          <EmptyState title={COPY.overview.chartEmpty} />
        ) : (
          <>
            <div className="jy-legend">
              <span><i className="line-key" style={{ background: "var(--jy-s1)" }} />{COPY.overview.legendNow}</span>
              {prev && <span><i className="line-key line-key--dash" />{COPY.overview.legendPrev}</span>}
            </div>
            <TrendChart
              days={page.trend}
              metric={metric}
              values={values}
              prev={prev}
              money={(usd) => money(usd, rate)}
              tz={page.tz}
              asOf={page.asOf}
              height={300}
              hoverOn={page.backfill.done || metric === "fresh"}
              label={COPY.overview.chartLabels[metric]}
            />
          </>
        )}
      </Panel>
    </>
  );
}
