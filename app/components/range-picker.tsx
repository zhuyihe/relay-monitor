"use client";
// 顶栏的时间范围：预设分段 + 可选的"自定义"弹层。
// 接口只支持"截至今天的最近 N 天"，所以自定义只选开始日期，结束日期固定为今天。
// 外壳会把同一个元素渲染两次（桌面顶栏和移动端内容顶部），因此所有 id 都按实例生成。
import { useEffect, useId, useRef, useState } from "react";
import { Button, Input } from "antd";
import { formatMonthDay, isoDay, parseDay } from "../../lib/format";
import { Sym } from "./icons";
import { Seg } from "./seg";
import type { SegOption } from "./seg";

export type RangeOption = { value: string; label: string };

export type CustomRange = {
  // 当前自定义的开始日期 YYYY-MM-DD
  startDate?: string | null;
  // 最早可选日期 YYYY-MM-DD
  minDate: string;
  // 今天 YYYY-MM-DD
  maxDate: string;
  onApply: (startIso: string) => void;
};

export function RangePicker({
  value,
  options,
  onChange,
  caption,
  custom,
}: {
  value: string;
  options: RangeOption[];
  onChange: (value: string) => void;
  caption?: React.ReactNode;
  custom?: CustomRange;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [err, setErr] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLInputElement>(null);

  const close = (refocus = false) => {
    setOpen(false);
    setErr("");
    if (refocus) wrapRef.current?.querySelector<HTMLButtonElement>(".jy-seg button:last-child")?.focus();
  };

  useEffect(() => {
    if (!open) return;
    startRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const customLabel = (() => {
    const d = custom?.startDate ? parseDay(custom.startDate) : null;
    return value === "custom" && d ? `${formatMonthDay(d)} 至 今天` : "自定义";
  })();

  // 自定义固定排在最后（Esc 关闭弹层时把焦点还给它）
  const segOptions: SegOption[] = [
    ...options.map((o) => ({ value: o.value, label: o.label })),
    ...(custom ? [{ value: "custom", label: customLabel, icon: "calendar" as const }] : []),
  ];

  const pick = (v: string) => {
    if (v === "custom" && custom) {
      if (open) return close();
      setStart(custom.startDate || custom.minDate);
      setErr("");
      setOpen(true);
      return;
    }
    close();
    onChange(v);
  };

  const apply = () => {
    if (!custom) return;
    const d = parseDay(start);
    if (!d || start < custom.minDate || start > custom.maxDate) {
      const min = parseDay(custom.minDate);
      setErr(`请选择 ${min ? formatMonthDay(min) : custom.minDate} 至今天之间的日期。`);
      return;
    }
    close();
    custom.onApply(isoDay(d));
  };

  return (
    <div className="jy-range">
      <div className="jy-range-wrap" ref={wrapRef}>
        <Seg label="时间范围" value={value} onChange={pick} options={segOptions} />
        {open && custom && (
          <div className="jy-popover" role="dialog" aria-label="自定义时间范围">
            <div className="jy-two">
              <div className="jy-field">
                <label htmlFor={`${uid}-from`}>开始日期</label>
                <Input
                  ref={startRef as any}
                  id={`${uid}-from`}
                  type="date"
                  value={start}
                  min={custom.minDate}
                  max={custom.maxDate}
                  status={err ? "error" : undefined}
                  aria-invalid={!!err || undefined}
                  aria-describedby={err ? `${uid}-err` : undefined}
                  onChange={(e) => setStart(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && apply()}
                />
              </div>
              <div className="jy-field">
                <label htmlFor={`${uid}-to`}>结束日期</label>
                <Input id={`${uid}-to`} type="date" value={custom.maxDate} disabled />
              </div>
            </div>
            {err && (
              <span className="jy-err" id={`${uid}-err`} role="alert">
                <Sym kind="crit" />
                {err}
              </span>
            )}
            <div className="jy-popover-foot">
              <Button onClick={() => close(true)}>取消</Button>
              <Button type="primary" onClick={apply}>
                应用
              </Button>
            </div>
          </div>
        )}
      </div>
      {caption != null && <span className="jy-caption">{caption}</span>}
    </div>
  );
}
