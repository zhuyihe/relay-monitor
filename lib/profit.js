// 利润口径：我的站点、成本与利润页、每日日报共用这一套算法，保证三处数字对得上。
//   毛利 = 收入 − 上游成本（按用量计费的上游实际扣费）
//   净利 = 毛利 − 固定成本（包月/包年付费按毫秒摊销到窗口）
//   毛利率 = 毛利 / 收入；净利率 = 净利 / 收入（收入为 0 时算不出，记 null）
// 纯函数，前后端都能用；单测见 lib/profit.test.js。
import { dayStartInTz, DEFAULT_BUSINESS_TIME_ZONE } from "./business-time.js";

const DAY_MS = 86400000;
const r2 = (v) => Math.round(v * 100) / 100;
const pct1 = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function purchasesOf(station) {
  return Array.isArray(station?.fixedPurchases) ? station.fixedPurchases : [];
}

// 成本计法：配置了固定付费（或资源类型就是固定成本）的上游只按摊销计，余额下降不再算成本，
// 否则包月站点的用量会和摊销重复计入。
export function costBasisOf(station) {
  return station?.type === "fixed" || purchasesOf(station).length > 0 ? "fixed" : "usage";
}

/**
 * 固定成本在 [startMs, endMs) 内的摊销。每笔付费 amount 元覆盖 days 天：
 * 填了开始日期的，按 [开始日 00:00, +days 天) 与窗口的重叠毫秒数摊销；
 * 没填日期的视为自动续费的常驻成本，整段窗口都摊。今天只摊到 endMs（现在），不按整天算。
 * 返回 { cny, exact, active, expired, total, note }：cny 保留两位，exact 是未舍入的金额。
 * 窗口合计要整段调用一次取 cny，不要逐日舍入后相加（每天各舍入一次会差几分钱）；
 * 逐日的 exact 只用来按比例分配合计（见 splitByCumulative）。note 用于成本明细里的说明。
 */
export function amortizeFixedCost(purchases, { startMs, endMs, tz = DEFAULT_BUSINESS_TIME_ZONE }) {
  const valid = (Array.isArray(purchases) ? purchases : []).filter((p) => {
    const amount = Number(p?.amount), days = Number(p?.days);
    return Number.isFinite(amount) && amount >= 0 && Number.isFinite(days) && days > 0;
  });
  const span = Math.max(0, endMs - startMs);
  let cny = 0, active = 0, expired = 0;
  let firstStart = null;
  valid.forEach((p, i) => {
    const daily = Number(p.amount) / Number(p.days);
    const st = p.startDate ? dayStartInTz(String(p.startDate).slice(0, 10), tz) : null;
    if (i === 0) firstStart = st;
    if (st == null) {
      cny += daily * (span / DAY_MS);
      active++;
      return;
    }
    const end = st + Number(p.days) * DAY_MS;
    cny += daily * (Math.max(0, Math.min(endMs, end) - Math.max(startMs, st)) / DAY_MS);
    if (end <= endMs) expired++;
    else if (st <= endMs) active++;
  });
  let note = null;
  if (valid.length && expired === valid.length) note = valid.length > 1 ? "已全部到期" : "已到期";
  else if (valid.length > 1) note = `${active}/${valid.length} 笔生效中`;
  else if (valid.length === 1 && firstStart != null && firstStart > startMs) note = `${String(valid[0].startDate).slice(0, 10)} 起`;
  return { cny: r2(cny), exact: cny, active, expired, total: valid.length, note };
}

// 站点汇率快照：没配置（或非正数）时按 1:1 折算，source 标明是默认值
/**
 * 把合计 total（元）按 weights 的累计占比分到各项，单位为分：
 * 第 i 项 = round(前 i 项累计占比 × 合计) − round(前 i−1 项累计占比 × 合计)。
 * 各项相加正好等于合计（不会因逐项舍入多出或少掉几分钱），每项与按比例直接舍入最多差 1 分。
 * 权重全为 0（或非正）时各项都是 0。用于把整段固定成本摊回逐日，让逐日之和与合计一致。
 */
export function splitByCumulative(weights, total) {
  const list = (Array.isArray(weights) ? weights : []).map((w) => (Number(w) > 0 ? Number(w) : 0));
  const sum = list.reduce((a, w) => a + w, 0);
  const cents = Math.round((Number(total) || 0) * 100);
  if (!(sum > 0)) return list.map(() => 0);
  let acc = 0;
  let prev = 0;
  return list.map((w, i) => {
    acc += w;
    // 最后一项直接取合计，避免浮点累加与 sum 不完全相等
    const cur = i === list.length - 1 ? cents : Math.round((acc / sum) * cents);
    const part = (cur - prev) / 100;
    prev = cur;
    return part;
  });
}

export function rateSnapshotOf(station) {
  const v = Number(station?.cnyPerUsd);
  return station?.cnyPerUsd != null && v > 0
    ? { cnyPerUsd: v, source: "configured" }
    : { cnyPerUsd: 1, source: "default" };
}

export function toCny(usd, rate) {
  const n = Number(usd);
  const r = typeof rate === "number" ? rate : rate?.cnyPerUsd ?? 1;
  return Number.isFinite(n) ? r2(n * r) : 0;
}

// 收入、上游成本、固定成本 → 毛利 / 净利 / 两个利润率。输入应已是保留两位的人民币金额。
export function summarizeProfit({ incomeCny, upstreamCostCny, fixedCostCny }) {
  const income = Number(incomeCny) || 0;
  const upstream = Number(upstreamCostCny) || 0;
  const fixed = Number(fixedCostCny) || 0;
  const grossProfitCny = r2(income - upstream);
  const netProfitCny = r2(grossProfitCny - fixed);
  return {
    grossProfitCny,
    netProfitCny,
    grossMarginPct: pct1(grossProfitCny, income),
    netMarginPct: pct1(netProfitCny, income),
  };
}
