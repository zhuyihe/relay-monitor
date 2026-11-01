"use client";
// 分段控件（时间范围、筛选、图表/表格切换）与标签页。
import { useRef, useState } from "react";
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

// disabled：还没做的标签（灰字，不能点、不进 Tab 顺序，键盘切换跳过）；note 是名字后面的小字（「即将上线」）
export type TabDef<T extends string = string> = { key: T; label: ReactNode; disabled?: boolean; note?: ReactNode };

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
    const enabled = tabs.map((t, k) => (t.disabled ? -1 : k)).filter((k) => k >= 0);
    if (!enabled.length) return;
    const at = enabled.indexOf(i);
    let next = -1;
    if (e.key === "ArrowRight") next = enabled[(at + 1) % enabled.length];
    else if (e.key === "ArrowLeft") next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
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
            aria-controls={t.disabled ? undefined : panelId(idPrefix, t.key)}
            aria-selected={t.key === active}
            aria-disabled={t.disabled || undefined}
            tabIndex={t.key === active && !t.disabled ? 0 : -1}
            onClick={t.disabled ? undefined : () => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.note != null && <small className="jy-tab-note">{t.note}</small>}
          </button>
        ))}
      </div>
      {extra != null && <div className="extra">{extra}</div>}
    </div>
  );
}

// keepMounted：第一次打开后一直挂载，切走只隐藏，表单与向导状态不丢；没打开过的不挂载，不提前发请求
export function TabPanel({
  idPrefix,
  tabKey,
  active,
  keepMounted = false,
  children,
}: {
  idPrefix: string;
  tabKey: string;
  active: boolean;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const [seen, setSeen] = useState(active);
  if (active && !seen) setSeen(true);
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, tabKey)}
      aria-labelledby={tabId(idPrefix, tabKey)}
      className="jy-tabpanel"
      hidden={!active}
    >
      {active || (keepMounted && seen) ? children : null}
    </div>
  );
}
