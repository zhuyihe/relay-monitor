"use client";
// 横向条形：排行类数据（按站点收入、按上游成本、按模型消费）。
// 缺数据的项画斜纹空条并写明原因，不画成 0。
import type { ReactNode } from "react";
import { formatMoney, formatPct } from "../../lib/format";
import { TipBody, useFloatTip } from "./float-tip";

export type HBarItem = { key?: string; name: string; value: number | null; note?: ReactNode; tipExtra?: [ReactNode, ReactNode][] };

export function HBars({
  items,
  color,
  format = (v: number) => formatMoney(v),
  unitName = "金额",
  total,
  empty = "暂无数据",
}: {
  items: HBarItem[];
  color: string;
  format?: (v: number) => string;
  unitName?: string;
  // 列表下方的合计行
  total?: { label: ReactNode; value: ReactNode };
  empty?: ReactNode;
}) {
  const { bind, node } = useFloatTip();
  const known = items.filter((d) => d.value != null);
  const max = Math.max(0, ...known.map((d) => d.value as number));
  const sum = known.reduce((a, d) => a + Math.max(0, d.value as number), 0);
  if (!items.length) return <p className="jy-muted" style={{ margin: 0 }}>{empty}</p>;
  return (
    <>
      <ul className="jy-hbars">
        {items.map((d, i) => {
          if (d.value == null) {
            return (
              <li key={d.key ?? `${d.name}-${i}`}>
                <span className="name" title={d.name}>{d.name}</span>
                <span className="bar-wrap">
                  <span className="bar bar--unknown jy-hatch" />
                  <span className="val val--muted">{d.note || "无数据"}</span>
                </span>
              </li>
            );
          }
          const v = d.value;
          const w = max > 0 ? (Math.max(0, v) / max) * 76 : 0;
          return (
            <li
              key={d.key ?? `${d.name}-${i}`}
              tabIndex={0}
              {...bind(() => (
                <TipBody
                  title={d.name}
                  rows={[[unitName, format(v)], ["占比", sum > 0 ? formatPct(Math.max(0, v) / sum) : "—"], ...(d.tipExtra || [])]}
                />
              ))}
            >
              <span className="name" title={d.name}>{d.name}</span>
              <span className="bar-wrap">
                <span className="bar" style={{ width: `${w}%`, background: color }} />
                <span className="val">{format(v)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {total && (
        <div className="jy-hbars-total">
          <span>{total.label}</span>
          <b>{total.value}</b>
        </div>
      )}
      {node}
    </>
  );
}
