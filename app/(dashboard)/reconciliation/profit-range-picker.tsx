"use client";
import { TimeRangePicker } from "../../components/time-range-picker";
import type { TimeBounds } from "../../components/time-range-picker";
import type { ProfitWindow, ProfitPreset } from "./use-profit-page";
import { COPY } from "./copy";

const options = (["today", "yesterday", "7d", "month", "since"] as const).map((value) => ({ value, label: COPY.presets[value] }));
export function ProfitRangePicker({ value, range, tz, sinceMs, onApply }: { value: ProfitWindow; range?: TimeBounds; tz: string; sinceMs?: number; onApply: (value: ProfitWindow) => void }) {
  return <TimeRangePicker value={value} range={range} tz={tz} sinceMs={sinceMs} options={options} custom={{ mode: "datetime", maxDays: 31 }}
    onApply={(next) => onApply({ ...next, preset: next.preset as ProfitPreset })} />;
}
