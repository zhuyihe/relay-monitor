// 自研 SVG 图表的坐标计算，全部是纯函数（趋势面板、预测图共用）。
import { dayKeyInTz, dayStartInTz, shiftDayLabel, wallTimeInTz } from "./business-time.js";

const HOUR_MS = 3_600_000;

// 1 / 2 / 2.5 / 5 / 10 × 10^n 的"好看"步长
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// 覆盖 [min, max] 的整齐刻度，约 count 段。刻度保留两位小数，步长至少 0.01：
// 金额只有几分钱时（如 ¥0.02）不会出现 0.005 这种步长，被舍入成重复刻度。
export function niceTicks(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], lo: 0, hi: 1, step: 1 };
  if (max === min) max = min + 1;
  const step = Math.max(0.01, niceStep((max - min) / count));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { ticks, lo, hi, step };
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

// 时间横轴的刻度，按业务时区 tz 落点（design/ui-copy-spec.md §6），和浏览器所在时区无关。
// 间隔从 1 小时到 7 天里挑最小的、刻度不超过 maxTicks 个；更长的按整周加大。
// - 按小时：落在 tz 里能被间隔整除的钟点上（1/2/3/6/12 都能整除 24，所以每天的 0 点都有刻度）；
// - 按天、按周：落在每天的 0 点，从起点之后的第一个 0 点数起（起点正好是 0 点就从它开始）。
// 返回 { ticks, daily }：daily 为真时刻度都是 0 点
export function timeAxisTicks(t0, t1, maxTicks, tz) {
  const span = Math.max(HOUR_MS, t1 - t0);
  const limit = Math.max(2, Math.floor(maxTicks));
  const WEEK = 168;
  const hours = [1, 2, 3, 6, 12, 24, 48, 72, WEEK].find((h) => span / (h * HOUR_MS) <= limit)
    ?? Math.ceil(span / limit / (WEEK * HOUR_MS)) * WEEK;
  const ticks = [];
  if (hours >= 24) {
    let first = dayKeyInTz(t0, tz);
    if (dayStartInTz(first, tz) < t0) first = shiftDayLabel(first, 1);
    for (let k = 0; ; k += hours / 24) {
      const t = dayStartInTz(shiftDayLabel(first, k), tz);
      if (t == null || t > t1) break;
      ticks.push(t);
    }
  } else {
    const last = dayKeyInTz(t1, tz);
    for (let label = dayKeyInTz(t0, tz); label && label <= last; label = shiftDayLabel(label, 1)) {
      for (let h = 0; h < 24; h += hours) {
        const t = wallTimeInTz(label, h, tz);
        // 夏令时拨快那天，跳过的钟点和下一个钟点是同一时刻，只留一个
        if (t != null && t >= t0 && t <= t1 && t !== ticks.at(-1)) ticks.push(t);
      }
    }
  }
  return { ticks, daily: hours >= 24 };
}

