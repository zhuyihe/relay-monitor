// 「最近 1 小时有收入」：每个绑定记着今天的收入上一次变多是什么时候（只用今天本来就在读的数，不另读用户的站点）。
// 进程刚起来、没有满 1 小时的记录时：今天已经有收入的渠道第一次读到就算「有收入」；过了午夜重新记。
export const SALE_RECENT_MS = 60 * 60 * 1000;

// tracker: Map(ruleId → { day, incomeUsd, lastSaleAt })；每次读到今天的收入调一次
export function noteTodayIncome(tracker, ruleId, dayKey, incomeUsd, now = Date.now()) {
  const income = Number.isFinite(incomeUsd) ? incomeUsd : 0;
  const seen = tracker.get(ruleId);
  if (!seen || seen.day !== dayKey) {
    tracker.set(ruleId, { day: dayKey, incomeUsd: income, lastSaleAt: income > 0 ? now : null });
    return;
  }
  if (income > seen.incomeUsd) seen.lastSaleAt = now;
  seen.incomeUsd = income;
}

// 一行（可能并着几条绑定）最近一次收入变多的时间；没记录是 null
export function lastSaleAtOf(tracker, ruleIds, dayKey) {
  let last = null;
  for (const id of ruleIds) {
    const seen = tracker.get(id);
    if (seen && seen.day === dayKey && seen.lastSaleAt != null && (last == null || seen.lastSaleAt > last)) last = seen.lastSaleAt;
  }
  return last;
}

export const activeNowOf = (lastSaleAt, now = Date.now()) => lastSaleAt != null && now - lastSaleAt < SALE_RECENT_MS;
