"use client";
// 星期 × 小时热力图：单色阶 6 档（--jy-seq-1..6），悬停或聚焦单元格看具体金额。
import { formatMoney } from "../../lib/format";
import { TipBody, useFloatTip } from "./float-tip";

// 行顺序：周一到周日（与 MySQL WEEKDAY() 的 0..6 一致）
const ROWS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const BINS = [0.1, 0.28, 0.46, 0.64, 0.82];

export function Heatmap({
  grid,
  valueLabel = "平均用量成本",
  peakNote,
  format = formatMoney,
}: {
  // grid[weekday][hour]，weekday 0 = 周一
  grid: number[][];
  valueLabel?: string;
  peakNote?: string;
  format?: (v: number, opts?: { dp?: number }) => string;
}) {
  const tip = useFloatTip();
  const flat = grid.flat();
  const max = Math.max(0, ...flat);
  const min = Math.min(max, ...flat);
  const bin = (v: number) => {
    if (max === min) return v > 0 ? 3 : 1;
    const t = (v - min) / (max - min);
    let k = 0;
    while (k < BINS.length && t > BINS[k]) k++;
    return k + 1;
  };
  let peak = { v: -1, r: 0, h: 0 };
  grid.forEach((row, r) => row.forEach((v, h) => v > peak.v && (peak = { v, r, h })));
  const label = `每小时${valueLabel}热力图。最高在${ROWS[peak.r]} ${peak.h}:00，约 ${format(peak.v)}。${peakNote || ""}`;

  return (
    <>
      <div className="jy-heat" role="img" aria-label={label}>
        {grid.map((row, r) => [
          <span key={`l${r}`} className="rlabel">
            {ROWS[r].slice(1)}
          </span>,
          ...row.map((v, h) => (
            <span
              key={`${r}-${h}`}
              className="cell"
              style={{ background: `var(--jy-seq-${bin(v)})` }}
              {...tip.bind(() => (
                <TipBody title={`${ROWS[r]} ${h}:00 至 ${h + 1}:00`} rows={[[valueLabel, format(v)]]} />
              ))}
            />
          )),
        ])}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={`c${h}`} className="clabel">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
      </div>
      <div className="jy-heat-scale">
        <span className="jy-num">{format(min, { dp: 0 })}</span>
        <span className="ramp" aria-hidden="true">
          {[1, 2, 3, 4, 5, 6].map((k) => (
            <i key={k} style={{ background: `var(--jy-seq-${k})` }} />
          ))}
        </span>
        <span className="jy-num">{format(max, { dp: 0 })}</span>
        {peakNote && <span className="jy-heat-peak">{peakNote}</span>}
      </div>
      {tip.node}
    </>
  );
}
