"use client";
// 上游余量：每个上游一条 0–14 天的条，按可用天数画；两条竖线是提醒天数和 7 天（§3.3）。
// 读不到余额的上游画虚线空条，不画成 0；档位名（余额偏低 / 快用完 / 余额用完 / 读不到余额）由调用方按 balanceViewOf 给。
// 条下面那段说明（竖线是什么、提醒天数在哪改）和悬停里的行名，运营总览和成本估算共用这一份（RUNWAY_TEXT）。
import Link from "next/link";
import type { ReactNode } from "react";
import { NAV_LABELS } from "../../lib/brand";
import { formatDays } from "../../lib/format";
import { etaWindowDays, RUNWAY_MAX_DAYS, WATCH_DAYS } from "../../lib/overview-actions";
import { TipBody, useFloatTip } from "./float-tip";
import type { TipRow } from "./float-tip";
import { LEVEL_ORDER, StatusText } from "./status";
import type { Level } from "./status";

export type RunwayItem = {
  key: string;
  name: ReactNode;
  // 名称下方的小字，一般是余额
  sub?: ReactNode;
  // 可用天数：Infinity 是近期没有花费，null 是算不出（写「—」）
  days: number | null;
  failed?: boolean;
  level: Level;
  // 档位名，跟在天数后面；正常时不给
  state?: ReactNode;
  // 天数列的替代文字；不给时按 formatDays 写
  daysLabel?: ReactNode;
  tip?: TipRow[];
  tipTitle?: ReactNode;
};

// 可用天数条共用的说法（design/ui-copy-spec.md §3.3）
export const RUNWAY_TEXT = Object.freeze({
  lines: (crit: number, watch: number) => (watch > crit
    ? `竖线是提醒天数：可用天数在 ${crit} 天以内标红，${watch} 天以内标黄。`
    : `竖线是提醒天数：可用天数在 ${crit} 天以内标红。`),
  rulesUnread: (crit: number) => `读不到提醒规则，暂按 ${crit} 天算。`,
  rulesWhereBefore: "提醒天数在",
  rulesWhereAfter: "的提醒规则里改。",
  burn: (money: string) => `日均花费 ${money}`,
  tip: Object.freeze({ reason: "原因", balance: "余额", burn: "日均花费", days: "可用天数", basis: "怎么估的", renewal: "续费" }),
});

// 提醒天数内部按天存；告警中心可以按小时设，界面上按所选的单位写（告警中心的输入框、上游列表状态格的说明共用这两个）
export function etaRuleDisplay(r: any): number {
  const days = Number(r?.etaDays ?? 3);
  return r?.etaUnit === "hours" ? +(days * 24).toFixed(2) : +days.toFixed(2);
}
export const etaWindowText = (r: any) => `${etaRuleDisplay(r)} ${r?.etaUnit === "hours" ? "小时" : "天"}`;

// 余量列表的排序（运营总览、成本估算共用）：先按档位，同档里读不到余额的在前，再按可用天数从少到多
export function compareRunwayItems(a: RunwayItem, b: RunwayItem) {
  return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || Number(!!b.failed) - Number(!!a.failed) || (a.days ?? Infinity) - (b.days ?? Infinity);
}

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
  warnDays = WATCH_DAYS,
  maxDays = RUNWAY_MAX_DAYS,
  mini,
}: {
  days: number | null;
  level: Level;
  failed?: boolean;
  critDays: number;
  // 黄线默认 7 天；不大于提醒天数时不画
  warnDays?: number;
  maxDays?: number;
  mini?: boolean;
}) {
  const fillCls = level === "crit" ? " is-crit" : level === "warn" ? " is-warn" : "";
  const w = days == null || !(days >= 0) ? 0 : Math.max(mini ? 2 : 1.5, (Math.min(days, maxDays) / maxDays) * 100);
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
  critDays = etaWindowDays(null),
  warnDays = WATCH_DAYS,
  maxDays = RUNWAY_MAX_DAYS,
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
              <strong title={typeof s.name === "string" ? s.name : typeof s.tipTitle === "string" ? s.tipTitle : undefined}>{s.name}</strong>
              <span>{s.sub}</span>
            </div>
            <RunwayTrack days={s.days} level={s.level} failed={s.failed} critDays={critDays} warnDays={warnDays} maxDays={maxDays} />
            <div className="days">
              <b>{s.daysLabel ?? formatDays(s.days)}</b>
              {s.state && <StatusText level={s.level}>{s.state}</StatusText>}
            </div>
          </li>
        ))}
      </ul>
      {node}
    </>
  );
}
