// 迷你余额走势（近 48 小时）：只表达形状，不标数值；颜色取设计令牌，深浅主题自动跟随。
// 纵轴按这一段的最高、最低点拉伸，所以只适合看“在降还是在涨”，具体数值进趋势弹窗看。
export function Spark({ pts, width = 88, height = 20 }: { pts: [number, number][]; width?: number; height?: number }) {
  if (!pts || pts.length < 2) return null;
  const P = 2;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  let min = Infinity;
  let max = -Infinity;
  for (const [, v] of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const x = (t: number) => P + ((t - t0) / (t1 - t0 || 1)) * (width - 2 * P);
  const y = (v: number) => P + (1 - (v - min) / (max - min)) * (height - 2 * P);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${height}L${x(t0).toFixed(1)},${height}Z`;
  const last = pts[pts.length - 1];
  return (
    <svg className="jy-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <path d={area} className="area" />
      <path d={line} className="line" />
      <circle cx={x(last[0]).toFixed(1)} cy={y(last[1]).toFixed(1)} r={2} className="dot" />
    </svg>
  );
}
