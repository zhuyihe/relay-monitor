"use client";
// 每天的上游成本：一天一根柱，数取每日利润同一份（/profit 的 dailyCost）；今天那根虚线（还会变）。
// 每日利润没有的日子就是 0 或空，不画「缺失」。
import type { ProfitPageResponse } from "../../../lib/client";
import { formatDayKey, formatMoney } from "../../../lib/format";
import { Panel } from "../../components/panel";
import { COPY } from "./copy";

export function DailyCostPanel({ profit, tz }: { profit: ProfitPageResponse; tz: string }) {
  const currency = profit.displayCurrency === "CNY" ? "CNY" : "USD";
  const days = (profit.dailyCost || []).map((item) => ({
    day: item.day,
    value: currency === "CNY" && item.actualCostCny != null ? item.actualCostCny : item.actualCostUsd,
    today: item.day === profit.today,
  }));
  const max = Math.max(0, ...days.map((d) => d.value || 0));
  const money = (value: number) => formatMoney(value, { symbol: currency === "CNY" ? "¥" : "$" });
  return (
    <Panel title={COPY.panel.daily} caption={COPY.dailyCaption}>
      {days.length === 0 ? (
        <p className="jy-caption">{COPY.dailyEmpty}</p>
      ) : (
        <>
          <ul className="jy-daily-cost" aria-label={COPY.panel.daily}>
            {days.map((d) => (
              <li key={d.day} className={d.today ? "is-today" : undefined} title={`${formatDayKey(d.day, tz)}：${money(d.value || 0)}${d.today ? `（${COPY.todayLegend}）` : ""}`}>
                <span className="jy-daily-cost__bar" style={{ height: `${max > 0 ? Math.max(2, ((d.value || 0) / max) * 100) : 2}%` }} />
                <span className="jy-daily-cost__day">{d.day.slice(8)}</span>
              </li>
            ))}
          </ul>
          <p className="jy-caption"><i className="jy-swatch jy-swatch--dashed" aria-hidden="true" /> {COPY.todayLegend}</p>
        </>
      )}
    </Panel>
  );
}
