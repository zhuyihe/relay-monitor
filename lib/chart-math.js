// 自研 SVG 图表的坐标计算，全部是纯函数（趋势面板、预测图共用）。

// 1 / 2 / 2.5 / 5 / 10 × 10^n 的"好看"步长
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// 覆盖 [min, max] 的整齐刻度，约 count 段
export function niceTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], lo: 0, hi: 1 };
  if (max === min) max = min + 1;
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { ticks, lo, hi };
}

// 柱子：只有远离基线的一端是圆角（4px），正值圆顶、负值圆底
export function barPath(x, top, bottom, w, r, roundTop) {
  const h = bottom - top;
  r = Math.max(0, Math.min(r, w / 2, h));
  if (roundTop) {
    return `M${x},${bottom}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${bottom}Z`;
  }
  return `M${x},${top}V${bottom - r}A${r},${r} 0 0 0 ${x + r},${bottom}H${x + w - r}A${r},${r} 0 0 0 ${x + w},${bottom - r}V${top}Z`;
}

// 折线：遇到 null 断开，不补零
export function linePath(vals, x, y, from = 0, to = vals.length - 1) {
  let d = "";
  let pen = false;
  for (let i = from; i <= to; i++) {
    const v = vals[i];
    if (v == null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

// 横轴刻度下标：从最后一天往前取；超过两周时按整周取，刻度落在同一个星期几
export function xTickIdx(n, plotW) {
  const maxTicks = Math.max(2, Math.floor(plotW / 76));
  let step = Math.ceil(n / maxTicks);
  if (n > 14) step = Math.ceil(step / 7) * 7;
  const idx = [];
  for (let i = n - 1; i >= 0; i -= step) idx.push(i);
  return idx;
}

// 连续为真的区间 [[a, b], ...]，用于缺数日的斜纹带
export function runs(flags) {
  const out = [];
  flags.forEach((f, i) => {
    if (!f) return;
    const last = out[out.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else out.push([i, i]);
  });
  return out;
}

// 线尾标签：按 y 排序，间距不足 gap 时往下错开
export function spreadLabels(items, gap = 15) {
  const out = items.map((it) => ({ ...it })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < out.length; k++) if (out[k].y - out[k - 1].y < gap) out[k].y = out[k - 1].y + gap;
  return out;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
