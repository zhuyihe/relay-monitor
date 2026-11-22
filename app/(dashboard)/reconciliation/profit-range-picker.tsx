"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Input, Popover } from "antd";
import type { InputRef } from "antd";
import { Icon } from "../../components/icons";
import { dayKeyInTz, dayStartInTz, shiftedDayStartInTz, wallTimeInTz, zonedParts } from "../../../lib/business-time";
import type { ProfitWindow, ProfitPreset } from "./use-profit-page";
import { COPY } from "./copy";

type Bounds = { startMs: number; endMs: number };
type Props = { value: ProfitWindow; range?: Bounds; tz: string; sinceMs?: number; onApply: (value: ProfitWindow) => void };
const presets = ["today", "yesterday", "7d", "month", "since", "custom"] as const;

export function ProfitRangePicker({ value, range, tz, sinceMs, onApply }: Props) {
  const uid = useId(), trigger = useRef<HTMLButtonElement>(null), startInput = useRef<InputRef>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProfitPreset>(value.preset);
  const [start, setStart] = useState(""), [end, setEnd] = useState("");
  const [error, setError] = useState("");
  const textOf = (at: number) => {
    const p = zonedParts(at, tz), pad = (n: number) => String(n).padStart(2, "0");
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  };
  const boundsOf = (preset: ProfitPreset): Bounds => {
    const now = Date.now(), today = shiftedDayStartInTz(now, 0, tz);
    if (preset === "custom") return { startMs: value.startMs ?? range?.startMs ?? today, endMs: value.endMs ?? range?.endMs ?? now };
    return { startMs: preset === "yesterday" ? shiftedDayStartInTz(now, -1, tz) : preset === "7d" ? shiftedDayStartInTz(now, -6, tz)
      : preset === "month" ? dayStartInTz(`${dayKeyInTz(now, tz).slice(0, 8)}01`, tz) : preset === "since" ? sinceMs ?? today : today,
      endMs: preset === "yesterday" ? today : now };
  };
  const current = range ?? boundsOf(value.preset);
  const changeOpen = (next: boolean) => {
    if (next) { setDraft(value.preset); setStart(textOf(current.startMs)); setEnd(textOf(current.endMs)); setError(""); }
    setOpen(next);
  };
  useEffect(() => { if (open) startInput.current?.focus(); }, [open]);
  const pick = (preset: ProfitPreset) => {
    setDraft(preset); setError("");
    if (preset === "custom") { startInput.current?.focus(); return; }
    const bounds = boundsOf(preset);
    setStart(textOf(bounds.startMs)); setEnd(textOf(bounds.endMs));
  };
  const apply = () => {
    const parse = (text: string) => {
      const [date, time = ""] = text.split("T"), [hour, minute, second = 0] = time.split(":").map(Number);
      return wallTimeInTz(date, hour, tz) + minute * 60000 + second * 1000;
    };
    const startMs = parse(start), endMs = parse(end);
    if (!start || !end || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) { setError("请选择有效的起止时间，结束时间须晚于开始时间。"); return; }
    if (endMs > Date.now()) { setError("结束时间不能晚于现在。"); return; }
    if (draft === "custom" && endMs - startMs > 31 * 86400000) { setError("一次最多查询 31 天，请缩短时间范围。"); return; }
    onApply(draft === "custom" ? { preset: "custom", startMs, endMs } : { preset: draft });
    setOpen(false); trigger.current?.focus();
  };
  const content = <form className="jy-profit-range-panel" role="dialog" aria-label={COPY.customRangeLabel} noValidate onSubmit={(event) => { event.preventDefault(); apply(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <div className="jy-profit-range-fields">
      <label htmlFor={`${uid}-from`}>起始时间<Input ref={startInput} id={`${uid}-from`} type="datetime-local" step="1" value={start} max={textOf(Date.now())}
        status={error ? "error" : undefined} aria-invalid={!!error || undefined} aria-describedby={error ? `${uid}-error` : undefined}
        onChange={(event) => { setStart(event.target.value); setDraft("custom"); setError(""); }} /></label>
      <span className="jy-profit-range-separator" aria-hidden="true">~</span>
      <label htmlFor={`${uid}-to`}>结束时间<Input id={`${uid}-to`} type="datetime-local" step="1" value={end} max={textOf(Date.now())}
        status={error ? "error" : undefined} aria-invalid={!!error || undefined} aria-describedby={error ? `${uid}-error` : undefined}
        onChange={(event) => { setEnd(event.target.value); setDraft("custom"); setError(""); }} /></label>
    </div>
    <div className="jy-profit-range-presets" role="group" aria-label={COPY.rangeLabel}>
      {presets.map((preset) => <button type="button" key={preset} aria-pressed={draft === preset} onClick={() => pick(preset)}>{COPY.presets[preset]}</button>)}
    </div>
    {error ? <p className="jy-profit-range-error" id={`${uid}-error`} role="alert">{error}</p> : null}
    <div className="jy-profit-range-foot"><Button htmlType="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>取消</Button><Button type="primary" htmlType="submit">确认</Button></div>
  </form>;
  const time = (at: number) => { const [date, clock] = textOf(at).split("T"); return <time dateTime={new Date(at).toISOString()}><span>{date}</span><span>{clock}</span></time>; };
  return <Popover trigger="click" placement="bottomRight" arrow={false} open={open} onOpenChange={changeOpen} content={content} rootClassName="jy-profit-range-popup">
    <button type="button" ref={trigger} className="jy-profit-range-trigger" aria-label="选择时间范围" aria-haspopup="dialog" aria-expanded={open}>
      <Icon name="calendar" /><span className="jy-profit-range-values">{time(current.startMs)}<span className="jy-profit-range-to">~</span>{time(current.endMs)}</span>
    </button>
  </Popover>;
}
