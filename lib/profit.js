// 利润口径：我的站点、成本与利润页、每日日报共用这一套算法，保证三处数字对得上。
//   毛利 = 收入 − 上游成本（按用量计费的上游实际扣费）
//   净利 = 毛利 − 固定成本（包月/包年付费按毫秒摊销到窗口）
//   毛利率 = 毛利 / 收入；净利率 = 净利 / 收入（收入为 0 时算不出，记 null）
// 纯函数，前后端都能用；单测见 lib/profit.test.js。
import { dayStartInTz, DEFAULT_BUSINESS_TIME_ZONE } from "./business-time.js";
import { RATE_UNSET, RATE_UNSET_PARITY, formatMoney, formatRate, formatUsd, formatZonedDate } from "./format.js";

const DAY_MS = 86400000;
const r2 = (v) => Math.round(v * 100) / 100;
const pct1 = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function purchasesOf(station) {
  return Array.isArray(station?.fixedPurchases) ? station.fixedPurchases : [];
}

// 算进利润的上游：不是自营站点，也没关掉「算进利润」（没填按算进）。成本接口、成本估算、运营总览用同一个判断
export function countsInProfit(station) {
  return !!station && !station.isOwn && station.includeInProfit !== false;
}

// 成本计法：配置了固定付费（或资源类型就是固定成本）的上游只按摊销计，余额下降不再算成本，
// 否则包月站点的用量会和摊销重复计入。
export function costBasisOf(station) {
  return station?.type === "fixed" || purchasesOf(station).length > 0 ? "fixed" : "usage";
}

// 能算的固定成本记录：金额不为负、天数大于 0。start / end 是业务时区里开始日 0:00 和到期时刻，没填开始日期的是 null
function fixedRows(purchases, tz) {
  return (Array.isArray(purchases) ? purchases : []).filter((p) => {
    const amount = Number(p?.amount), days = Number(p?.days);
    return Number.isFinite(amount) && amount >= 0 && Number.isFinite(days) && days > 0;
  }).map((p) => {
    const start = p.startDate ? dayStartInTz(String(p.startDate).slice(0, 10), tz) : null;
    return { daily: Number(p.amount) / Number(p.days), start, end: start == null ? null : start + Number(p.days) * DAY_MS };
  });
}

/**
 * 固定成本在 [startMs, endMs) 内的摊销。每笔付费 amount 元覆盖 days 天：
 * 填了开始日期的，按 [开始日 00:00, +days 天) 与窗口的重叠毫秒数摊销；
 * 没填日期的视为自动续费的常驻成本，整段窗口都摊。今天只摊到 endMs（现在），不按整天算。
 * 返回 { cny, exact, active, expired, upcoming, total, note }：cny 保留两位，exact 是未舍入的金额。
 * 按窗口结束时刻数笔数：active 在用、upcoming 还没开始、expired 已到期，三者相加等于 total。
 * 窗口合计要整段调用一次取 cny，不要逐日舍入后相加（每天各舍入一次会差几分钱）；
 * 逐日的 exact 只用来按比例分配合计（见 splitByCumulative）。
 * note 是成本明细里的笔数句（design/ui-copy-spec.md §7）：「2 笔在用，1 笔已到期」只写不为 0 的；
 * 全部到期写「已到期」；只有一笔、在窗口开始之后才开始的写「10月12日起」；只有一笔在用的不写。
 * 页面要按状态判断时看计数，不要匹配 note 的文字。
 */
export function amortizeFixedCost(purchases, { startMs, endMs, tz = DEFAULT_BUSINESS_TIME_ZONE }) {
  const valid = fixedRows(purchases, tz);
  const span = Math.max(0, endMs - startMs);
  let cny = 0, active = 0, expired = 0, upcoming = 0;
  let firstStart = null;
  valid.forEach(({ daily, start: st, end }, i) => {
    if (i === 0) firstStart = st;
    if (st == null) {
      cny += daily * (span / DAY_MS);
      active++;
      return;
    }
    cny += daily * (Math.max(0, Math.min(endMs, end) - Math.max(startMs, st)) / DAY_MS);
    if (end <= endMs) expired++;
    else if (st < endMs) active++;
    else upcoming++;
  });
  let note = null;
  if (valid.length && expired === valid.length) note = "已到期";
  else if (valid.length > 1) {
    note = [[active, "笔在用"], [upcoming, "笔还没开始"], [expired, "笔已到期"]]
      .filter(([n]) => n > 0)
      .map(([n, text]) => `${n} ${text}`)
      .join("，");
  } else if (valid.length === 1 && firstStart != null && firstStart > startMs) note = `${formatZonedDate(firstStart, tz, endMs)}起`;
  return { cny: r2(cny), exact: cny, active, expired, upcoming, total: valid.length, note };
}

/**
 * 固定成本此刻的情况，上游列表用。笔数和 note 就是 amortizeFixedCost 在 now 这一刻数出来的；
 * 另给 daily（在用的几笔每天合计多少，按天平摊）和 nextEnd（在用的里最早哪一刻到期，都没有到期日时 null）。
 */
export function fixedCostNowOf(purchases, { now = Date.now(), tz = DEFAULT_BUSINESS_TIME_ZONE } = {}) {
  const counts = amortizeFixedCost(purchases, { startMs: now, endMs: now, tz });
  let daily = 0, nextEnd = null;
  for (const row of fixedRows(purchases, tz)) {
    if (row.start != null && (row.start >= now || row.end <= now)) continue;
    daily += row.daily;
    if (row.end != null && (nextEnd == null || row.end < nextEnd)) nextEnd = row.end;
  }
  const { active, expired, upcoming, total, note } = counts;
  return { active, expired, upcoming, total, note, daily, nextEnd };
}

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

// 站点汇率快照：没配置（或非正数）时按 1:1 折算，source 标明是默认值
export function rateSnapshotOf(station) {
  const v = Number(station?.cnyPerUsd);
  return station?.cnyPerUsd != null && v > 0
    ? { cnyPerUsd: v, source: "configured" }
    : { cnyPerUsd: 1, source: "default" };
}

// 这个汇率是不是设了的：只认 rateSnapshotOf 标成 configured、而且是正数的。账本里存的、页面拿到的汇率也用它判断
export function isConfiguredRate(rate) {
  return rate?.source === "configured" && Number(rate.cnyPerUsd) > 0;
}

// 每日利润一条绑定两侧的汇率和成本计法：saved 是账本里那天存下的 { rates: { income, cost }, costBasis }，存了就用存的；
// 没存的汇率按现在的设置（rateSnapshotOf），成本计法依次取账本、costBasis（算结果时记下的）、现在的设置（costBasisOf）
export function ratesFor({ own, upstream, saved = null, costBasis = null }) {
  const rate = (station, value) => (value != null ? { cnyPerUsd: value, source: "configured" } : rateSnapshotOf(station));
  return { income: rate(own, saved?.rates?.income), cost: rate(upstream, saved?.rates?.cost),
    costBasis: saved?.costBasis || costBasis || (upstream ? costBasisOf(upstream) : "usage") };
}

// 上游余额（美元额度）怎么写（design/ui-copy-spec.md §7），运营总览和上游列表共用：
//   设置了汇率：text「$12.30」，cny「约 ¥88.56」，full「$12.30（约 ¥88.56）」，note「按 1 美元 = 7.20 元换算」；
//   没设置汇率：暂按 1 美元 = 1 元，text「¥12.30」，full「¥12.30（没设置汇率）」，cny 为 null，note 是 RATE_UNSET_PARITY。
//   表格和趋势图写两行（text，下面写 cny 或「没设置汇率」）；句子和手机列表写一行（full）。
export function balanceMoneyOf(station, amount) {
  const rate = rateSnapshotOf(station);
  if (!isConfiguredRate(rate)) {
    const text = formatMoney(amount);
    return { text, cny: null, full: `${text}（${RATE_UNSET}）`, note: RATE_UNSET_PARITY };
  }
  const text = formatUsd(amount);
  const cny = `约 ${formatMoney(Number(amount) * rate.cnyPerUsd)}`;
  return { text, cny, full: `${text}（${cny}）`, note: `按 ${formatRate(rate.cnyPerUsd)}换算` };
}

// 美元金额按汇率折成人民币、舍到分；rate 是 rateSnapshotOf 给的汇率
export function toCny(usd, rate) {
  const n = Number(usd);
  return Number.isFinite(n) ? r2(n * rate.cnyPerUsd) : 0;
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

// computeProfit 的提示分两类：会让数字不准的（估算、没设置汇率或售价）是原因，其余是说明。
// 按 warningCodes 分，不认文字；每句补上句号。
const ACCURACY_WARNINGS = new Set(["estimated_cost", "rate_unset", "sell_price_unset"]);
export function splitProfitWarnings(profit) {
  const warnings = Array.isArray(profit?.warnings) ? profit.warnings : [];
  const codes = Array.isArray(profit?.warningCodes) ? profit.warningCodes : [];
  const reasons = [], notes = [];
  warnings.forEach((w, i) => (ACCURACY_WARNINGS.has(codes[i]) ? reasons : notes).push(/[。！？]$/.test(w) ? w : `${w}。`));
  return { reasons, notes };
}

// 毛利、净利算不算亏损（§7）：小于 0、而且舍到分以后不是 0（−¥0.00 不算），利润等式和日报共用
export const isLoss = (v) => v != null && v < 0 && Math.abs(v) >= 0.005;

// 利润里哪几项是估算的（§7：估算值前加「≈」），自营业务的利润等式和日报共用：自营站点没设置售价时的收入；
// 有按余额变化估算的、或没设置汇率的上游时的上游成本；毛利、净利在这两样之外，还看说明里有没有影响准不准的那几条
export function profitApproxOf(profit, own) {
  const income = !isConfiguredRate(rateSnapshotOf(own));
  const upstream = !!profit?.estimated || (profit?.rateUnsetStations || []).length > 0;
  return { income, upstream, result: income || upstream || splitProfitWarnings(profit).reasons.length > 0 };
}
