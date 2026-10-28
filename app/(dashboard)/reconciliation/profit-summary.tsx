"use client";
// 每日利润页顶上的四个数（设计稿 daily-profit-a.md §2）：毛利（下面一行小字写净利）、差额、对不上、没算进来。
// 手机上合成一张卡片：毛利大字、收入 − 实付成本、毛利率、净利，底下一行写昨天（或已固定的日子）的差额。
// 数都由 profit-format.ts 的 metrics 算好，这里只摆；金额不上色，对不上的那一格浅红底。
import { Button } from "antd";
import type { ProfitPageResponse } from "../../../lib/client";
import { COPY } from "./copy";
import { heldNote, isTodayView, metrics } from "./profit-format";
import type { Ctx, Metric } from "./profit-format";

type Props = { page: ProfitPageResponse; ctx: Ctx; compact: boolean; onSelectDay: (day: string) => void };

function MetricLink({ metric, onSelectDay }: { metric: Metric; onSelectDay: (day: string) => void }) {
  return metric.link ? <Button type="link" size="small" className="jy-profit-metric__link" onClick={() => onSelectDay(metric.link!.day)}>{metric.link.text}</Button> : null;
}

export function ProfitSummary({ page, ctx, compact, onSelectDay }: Props) {
  const [gross, gap, mismatched, uncounted] = metrics(page, ctx);
  if (compact) {
    // 底下那一行：今天写「昨天比预期少赚 $0.71 · 2 个渠道对不上 [看昨天]」；已固定的日子写「比预期少赚 $0.71（多扣 … · 少扣 … · 门槛以内 …）」
    const foot = isTodayView(page) ? mismatched : gap;
    return <section className="jy-profit-summary jy-profit-summary--mobile" aria-label={gross.title}>
      <div className="jy-profit-summary__main">
        <span className="jy-profit-metric__title">{isTodayView(page) ? COPY.metric.grossTodayMobile : gross.title}</span>
        <strong className="jy-profit-metric__value">{gross.value}</strong>
        {gross.lines.map((line, index) => <p key={index}>{line}</p>)}
      </div>
      <div className={`jy-profit-summary__foot${foot.crit ? " is-crit" : ""}`}>
        <span>{foot.title} <b>{foot.value}</b>{foot.lines[0] ? (isTodayView(page) ? ` · ${foot.lines[0]}` : `（${foot.lines[0]}）`) : ""}</span>
        <MetricLink metric={foot} onSelectDay={onSelectDay} />
      </div>
      {heldNote(page) ? <p className="jy-profit-summary__held">{heldNote(page)}</p> : null}
    </section>;
  }
  return <dl className="jy-profit-summary" aria-label={COPY.table.title}>
    {[gross, gap, mismatched, uncounted].map((metric) => <div key={metric.key} className={`jy-profit-metric${metric.crit ? " jy-profit-metric--crit" : ""}`}>
      <dt className="jy-profit-metric__title">{metric.title}</dt>
      <dd>
        <strong className="jy-profit-metric__value">{metric.value}</strong>
        {metric.lines.map((line, index) => <p key={index} title={metric.key === "gross" && index === metric.lines.length - 1 && index > 0 ? COPY.metric.fixedHover : undefined} className={metric.key === "gross" && index === metric.lines.length - 1 && index > 0 ? "jy-profit-metric__net" : undefined}>
          {line}{index === metric.lines.length - 1 ? <MetricLink metric={metric} onSelectDay={onSelectDay} /> : null}
        </p>)}
        {!metric.lines.length ? <MetricLink metric={metric} onSelectDay={onSelectDay} /> : null}
      </dd>
    </div>)}
  </dl>;
}
