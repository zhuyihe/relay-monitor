"use client";
// 每日利润页顶上的四个数：收入、上游成本、毛利、毛利率（手机上两个一排）。数都由 profit-format.ts 的 metrics 算好，这里只摆。
import type { ProfitPageResponse } from "../../../lib/client";
import { COPY } from "./copy";
import { metrics } from "./profit-format";
import type { Ctx } from "./profit-format";

export function ProfitSummary({ page, ctx }: { page: ProfitPageResponse; ctx: Ctx }) {
  return <dl className="jy-profit-summary" aria-label={COPY.table.title}>
    {metrics(page, ctx).map((metric) => <div key={metric.key} className="jy-profit-metric">
      <dt className="jy-profit-metric__title">{metric.title}</dt>
      <dd><strong className="jy-profit-metric__value">{metric.value}</strong></dd>
    </div>)}
  </dl>;
}
