"use client";
// 分段控件（时间范围、筛选、图表/表格切换）与标签页。
import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";

export type SegOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  count?: number;
  icon?: IconName;
  disabled?: boolean;
  title?: string;
};

export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  size,
  className = "",
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: "sm";
  className?: string;
}) {
  return (
    <div className={`jy-seg${size === "sm" ? " jy-seg--sm" : ""} ${className}`.trim()} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {o.label}
          {o.count != null && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export type TabDef<T extends string = string> = { key: T; label: ReactNode };

const tabId = (prefix: string, key: string) => `${prefix}-tab-${key}`;
const panelId = (prefix: string, key: string) => `${prefix}-panel-${key}`;

// 标签页：左右方向键切换并激活，Home / End 到首尾
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
  label,
  extra,
}: {
  tabs: TabDef<T>[];
  active: T;
  onChange: (key: T) => void;
  idPrefix: string;
  label: string;
  extra?: ReactNode;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = tabs[next].key;
    onChange(key);
    refs.current[key]?.focus();
  };
  return (
    <div className="jy-tabs-bar">
      <div className="jy-tabs" role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.key}
            ref={(n) => {
              refs.current[t.key] = n;
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, t.key)}
            aria-controls={panelId(idPrefix, t.key)}
            aria-selected={t.key === active}
            tabIndex={t.key === active ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {extra != null && <div className="extra">{extra}</div>}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  tabKey,
  active,
  children,
}: {
  idPrefix: string;
  tabKey: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, tabKey)}
      aria-labelledby={tabId(idPrefix, tabKey)}
      className="jy-tabpanel"
      hidden={!active}
    >
      {active ? children : null}
    </div>
  );
}
