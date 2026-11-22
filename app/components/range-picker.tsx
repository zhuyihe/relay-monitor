"use client";
// 各页保留原有查询档位，时间输入、快捷选择、草稿和确认交互共用一个组件。
import { DEFAULT_BUSINESS_TIME_ZONE, dayKeyInTz, dayStartInTz } from "../../lib/business-time";
import { TimeRangePicker } from "./time-range-picker";
import type { RangeOption, TimeBounds } from "./time-range-picker";
export type { RangeOption } from "./time-range-picker";

type CustomRange = { startDate?: string | null; minDate: string; maxDate: string; onApply: (startIso: string) => void };
export function RangePicker({ value, options, onChange, caption, custom, tz = DEFAULT_BUSINESS_TIME_ZONE, range, getRange, label }: {
  value: string; options: RangeOption[]; onChange: (value: string) => void; caption?: React.ReactNode; custom?: CustomRange;
  tz?: string; range?: TimeBounds; getRange?: (preset: string) => TimeBounds; label?: string;
}) {
  return <div className="jy-range">
    <TimeRangePicker value={{ preset: value, ...(custom?.startDate ? { startMs: dayStartInTz(custom.startDate, tz) } : {}) }}
      options={options} tz={tz} range={range} getRange={getRange} label={label}
      custom={custom ? { mode: "start-date", minDate: custom.minDate, maxDate: custom.maxDate } : undefined}
      onApply={(next) => next.preset === "custom" && custom ? custom.onApply(dayKeyInTz(next.startMs!, tz)) : onChange(next.preset)} />
    {caption != null && <span className="jy-caption">{caption}</span>}
  </div>;
}
