"use client";
import "../styles/components/time-range.css";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Input, Popover } from "antd";
import type { InputRef } from "antd";
import { dayKeyInTz, dayStartInTz, wallTimeInTz, zonedParts } from "../../lib/business-time";
import { presetTimeRange } from "../../lib/time-range";
import { Icon } from "./icons";

export type TimeBounds = { startMs: number; endMs: number };
export type TimeSelection = { preset: string; startMs?: number; endMs?: number };
export type RangeOption = { value: string; label: string };
type Props = {
  value: TimeSelection; options: RangeOption[]; tz: string; range?: TimeBounds; sinceMs?: number;
  custom?: { mode: "datetime"; maxDays?: number; minDate?: never; maxDate?: never } | { mode: "start-date"; minDate: string; maxDate: string; maxDays?: never };
  getRange?: (preset: string) => TimeBounds;
  onApply: (value: TimeSelection) => void;
  label?: string;
};

export function TimeRangePicker({ value, options, tz, range, sinceMs, custom, getRange, onApply, label = "选择时间范围" }: Props) {
  const uid = useId(), trigger = useRef<HTMLButtonElement>(null), startInput = useRef<InputRef>(null), presetsRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(value.preset);
  const [start, setStart] = useState(""), [end, setEnd] = useState(""), [error, setError] = useState("");
  const dateOnly = custom?.mode === "start-date";
  const textOf = (at: number) => {
    const p = zonedParts(at, tz), pad = (n: number) => String(n).padStart(2, "0");
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  };
  const boundsOf = (preset: string): TimeBounds => preset === "custom"
    ? { startMs: value.startMs ?? range?.startMs ?? dayStartInTz(dayKeyInTz(Date.now(), tz), tz), endMs: value.endMs ?? range?.endMs ?? Date.now() }
    : getRange?.(preset) ?? presetTimeRange(preset, { tz, sinceMs });
  const current = range ?? boundsOf(value.preset);
  const fill = (bounds: TimeBounds) => { setStart(dateOnly ? dayKeyInTz(bounds.startMs, tz) : textOf(bounds.startMs)); setEnd(dateOnly ? custom?.maxDate ?? dayKeyInTz(bounds.endMs, tz) : textOf(bounds.endMs)); };
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const changeOpen = (next: boolean) => {
    if (next) { setDraft(value.preset); fill(current); setError(""); }
    setOpen(next);
  };
  useEffect(() => {
    if (!open) return;
    if (custom) startInput.current?.focus({ preventScroll: true });
    else presetsRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [open]);
  const pick = (preset: string) => {
    setDraft(preset); setError("");
    if (preset === "custom") { startInput.current?.focus({ preventScroll: true }); return; }
    fill(boundsOf(preset));
  };
  const apply = () => {
    if (draft !== "custom") { onApply({ preset: draft }); close(); return; }
    if (dateOnly) {
      if (!start || start < custom!.minDate! || start > custom!.maxDate!) { setError(`请选择 ${custom!.minDate} 至 ${custom!.maxDate} 之间的日期。`); return; }
      onApply({ preset: "custom", startMs: dayStartInTz(start, tz), endMs: Date.now() }); close(); return;
    }
    const parse = (text: string) => {
      const [date, time = ""] = text.split("T"), [hour, minute, second = 0] = time.split(":").map(Number);
      return wallTimeInTz(date, hour, tz) + minute * 60000 + second * 1000;
    };
    const startMs = parse(start), endMs = parse(end);
    if (!start || !end || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) { setError("请选择有效的起止时间，结束时间须晚于开始时间。"); return; }
    if (endMs > Date.now()) { setError("结束时间不能晚于现在。"); return; }
    if (custom?.maxDays && endMs - startMs > custom.maxDays * 86400000) { setError(`一次最多查询 ${custom.maxDays} 天，请缩短时间范围。`); return; }
    onApply({ preset: "custom", startMs, endMs }); close();
  };
  const choices = custom ? [...options, { value: "custom", label: "自定义" }] : options;
  const content = <form className="jy-time-range-panel" role="dialog" aria-label="选择时间范围" noValidate onSubmit={(event) => { event.preventDefault(); apply(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <div className="jy-time-range-fields">
      <label htmlFor={`${uid}-from`}>{dateOnly ? "开始日期" : "起始时间"}<Input ref={startInput} id={`${uid}-from`} type={dateOnly ? "date" : "datetime-local"} step="1" value={start}
        min={custom?.minDate} max={dateOnly ? custom?.maxDate : textOf(Date.now())} readOnly={!custom}
        status={error ? "error" : undefined} aria-invalid={!!error || undefined} aria-describedby={error ? `${uid}-error` : undefined}
        onChange={(event) => { setStart(event.target.value); setDraft("custom"); setError(""); }} /></label>
      <span className="jy-time-range-separator" aria-hidden="true">~</span>
      <label htmlFor={`${uid}-to`}>{dateOnly ? "结束日期" : "结束时间"}<Input id={`${uid}-to`} type={dateOnly ? "date" : "datetime-local"} step="1" value={end}
        max={dateOnly ? custom?.maxDate : textOf(Date.now())} readOnly={!custom || dateOnly}
        status={error ? "error" : undefined} aria-invalid={!!error || undefined} aria-describedby={error ? `${uid}-error` : undefined}
        onChange={(event) => { setEnd(event.target.value); setDraft("custom"); setError(""); }} /></label>
    </div>
    <div ref={presetsRef} className="jy-time-range-presets" role="group" aria-label="时间范围">{choices.map((option) => <button type="button" key={option.value} aria-pressed={draft === option.value} onClick={() => pick(option.value)}>{option.label}</button>)}</div>
    {error ? <p className="jy-time-range-error" id={`${uid}-error`} role="alert">{error}</p> : null}
    <div className="jy-time-range-foot"><Button htmlType="button" onClick={close}>取消</Button><Button type="primary" htmlType="submit">确认</Button></div>
  </form>;
  const time = (at: number) => { const [date, clock] = textOf(at).split("T"); return <time dateTime={new Date(at).toISOString()}><span>{date}</span><span>{clock}</span></time>; };
  return <Popover trigger="click" placement="bottomRight" arrow={false} open={open} onOpenChange={changeOpen} content={content} rootClassName="jy-time-range-popup">
    <button type="button" ref={trigger} className="jy-time-range-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open}>
      <Icon name="calendar" /><span className="jy-time-range-values">{time(current.startMs)}<span className="jy-time-range-to">~</span>{time(current.endMs)}</span>
    </button>
  </Popover>;
}
