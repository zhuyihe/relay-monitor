"use client";
// 每天的上游成本：一天一根柱，数取每日利润同一份（/profit 的 dailyCost）；今天那根虚线（还会变）。
// 每日利润没有的日子就是 0 或空，不画「缺失」。
import type { ProfitPageResponse } from "../../../lib/client";
import { formatDayKey, formatMoney } from "../../../lib/format";
import { Panel } from "../../components/panel";
import { COPY } from "./copy";

export function DailyCostPanel({ profit, tz, emptyText }: { profit: ProfitPageResponse; tz: string; emptyText?: React.ReactNode }) {
  const currency = profit.displayCurrency === "CNY" ? "CNY" : "USD";
  const days = (profit.dailyCost || []).map((item) => ({
    day: item.day,
    value: currency === "CNY" && item.actualCostCny != null ? item.actualCostCny : item.actualCostMain ?? item.actualCostUsd,
    today: item.day === profit.today,
  }));
  const max = Math.max(0, ...days.map((d) => d.value || 0));
  const step = 10 ** Math.floor(Math.log10(max || 1));
  const axisMax = max > 0 ? Math.ceil((max * 1.1) / step) * step : 1;
  const labelStep = Math.max(1, Math.ceil(days.length / 8));
  const money = (value: number) => formatMoney(value, { symbol: currency === "CNY" ? "¥" : "$" });
  return (
    <Panel className="jy-analytics-daily" title={COPY.panel.daily} caption={COPY.dailyCaption}>
      {days.length === 0 ? (
        <p className="jy-caption">{emptyText ?? COPY.dailyEmpty}</p>
      ) : (
        <>
          <div className="jy-daily-cost-chart">
            <div className="jy-daily-cost-scale" aria-hidden="true">
              {[1, 0.5, 0].map((ratio) => <span key={ratio}>{money(axisMax * ratio)}</span>)}
            </div>
            <ul className="jy-daily-cost" aria-label={COPY.panel.daily}>
              {days.map((d, index) => (
                <li key={d.day} className={d.today ? "is-today" : undefined} title={`${formatDayKey(d.day, tz)}：${money(d.value || 0)}${d.today ? `（${COPY.todayLegend}）` : ""}`}>
                  <span className="jy-daily-cost__track">
                    <span className="jy-daily-cost__bar" style={{ height: `${((d.value || 0) / axisMax) * 100}%` }} />
                  </span>
                  <span className="jy-daily-cost__day" style={{ visibility: index % labelStep === 0 ? "visible" : "hidden" }}>{d.day.slice(5).replace("-", "/")}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="jy-caption"><i className="jy-swatch jy-swatch--dashed" aria-hidden="true" /> {COPY.todayLegend}</p>
        </>
      )}
    </Panel>
  );
}
