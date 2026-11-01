"use client";
// 余量条（子弹图）：浅灰轨道，灰色填充 = 要多少，竖线 = 能给多少（实线是测到的上限，虚线是没测到、只知道「至少」），超出竖线的那一截红色 = 缺口。
// 主表的「余量或缺口」和「按上游看」的卡片共用这一个；条旁边一定有字，不只靠颜色。
import { barShape } from "./models-format";
import type { Quantity } from "./models-format";

export function HeadroomBar({ need, supply, label }: { need: number | null; supply: Quantity | null | undefined; label: string }) {
  const shape = barShape(need, supply);
  if (!shape) return null;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return (
    <span className="jy-hbar" role="img" aria-label={label}>
      <i className="fill" style={{ width: pct(shape.fill) }} />
      {shape.over > 0 && <i className="over" style={{ left: pct(shape.line ?? 0), width: pct(shape.over) }} />}
      {shape.line != null && <i className={`line${shape.dashed ? " is-dashed" : ""}`} style={{ left: pct(shape.line) }} />}
    </span>
  );
}
