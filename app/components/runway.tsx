"use client";
// 上游余量跑道：每个上游一条 0–14 天的轨道，竖线是紧急 / 注意阈值。
// 查询失败的上游用虚线空轨道，明确写"余额未知"，不画成 0。
import type { ReactNode } from "react";
import { formatDays } from "../../lib/format";
import { TipBody, useFloatTip } from "./float-tip";
import type { TipRow } from "./float-tip";
import { StatusText } from "./status";
import type { Level } from "./status";

export type RunwayItem = {
  key: string;
  name: ReactNode;
  // 名称下方的小字，一般是余额
  sub?: ReactNode;
  days: number | null;
  failed?: boolean;
  level: Level;
  // 天数列的替代文字（如"无消耗"）
  daysLabel?: ReactNode;
  tip?: TipRow[];
  tipTitle?: ReactNode;
};

const pctOf = (d: number, max: number) => `${(d / max) * 100}%`;

export function RunwayScale({ critDays, warnDays, maxDays }: { critDays: number; warnDays: number; maxDays: number }) {
  return (
    <div className="jy-runway-scale" aria-hidden="true">
      <span />
      <div className="axis">
        <span style={{ left: 0, transform: "none" }}>0</span>
        {critDays > 0 && critDays < maxDays && <span style={{ left: pctOf(critDays, maxDays) }}>{critDays} 天</span>}
        {warnDays > critDays && warnDays < maxDays && <span style={{ left: pctOf(warnDays, maxDays) }}>{warnDays} 天</span>}
        <span style={{ left: "100%", transform: "translateX(-100%)" }}>{maxDays} 天</span>
      </div>
      <span />
    </div>
  );
}

export function RunwayTrack({
  days,
  level,
  failed,
  critDays,
  warnDays,
  maxDays = 14,
  mini,
}: {
  days: number | null;
  level: Level;
  failed?: boolean;
  critDays: number;
  warnDays: number;
  maxDays?: number;
  mini?: boolean;
}) {
  const fillCls = level === "crit" ? " is-crit" : level === "warn" ? " is-warn" : "";
  const w = days == null ? 0 : Math.max(mini ? 2 : 1.5, (Math.min(days, maxDays) / maxDays) * 100);
  return (
    <div className={`jy-track${mini ? " jy-mini-track" : ""}${failed ? " is-unknown" : ""}`}>
      {!failed && days != null && <span className={`fill${fillCls}`} style={{ width: `${w}%` }} />}
      {critDays > 0 && critDays < maxDays && <span className="tick" style={{ left: pctOf(critDays, maxDays) }} />}
      {warnDays > critDays && warnDays < maxDays && <span className="tick" style={{ left: pctOf(warnDays, maxDays) }} />}
    </div>
  );
}

export function Runway({
  items,
  critDays = 3,
  warnDays = 7,
  maxDays = 14,
}: {
  items: RunwayItem[];
  critDays?: number;
  warnDays?: number;
  maxDays?: number;
}) {
  const { bind, node } = useFloatTip();
  return (
    <>
      <RunwayScale critDays={critDays} warnDays={warnDays} maxDays={maxDays} />
      <ul className="jy-runway">
        {items.map((s) => (
          <li key={s.key} tabIndex={s.tip ? 0 : undefined} {...(s.tip ? bind(() => <TipBody title={s.tipTitle ?? s.name} rows={s.tip} />) : {})}>
            <div className="who">
              <strong>{s.name}</strong>
              <span>{s.failed ? "余额未知" : s.sub}</span>
            </div>
            <RunwayTrack days={s.days} level={s.level} failed={s.failed} critDays={critDays} warnDays={warnDays} maxDays={maxDays} />
            <div className="days">
              {s.failed ? (
                <>
                  <span className="jy-muted">无法计算</span>
                  <StatusText level="crit">查询失败</StatusText>
                </>
              ) : (
                <>
                  <b>{s.daysLabel ?? formatDays(s.days)}</b>
                  {(s.level === "crit" || s.level === "warn") && <StatusText level={s.level} />}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {node}
    </>
  );
}
