// 列表打开抽屉、小窗口、气泡或「更多」菜单时先别动：沿用上次的顺序，新出现的行放最后（按新顺序），没了的行去掉；hold 为假就直接用新顺序。
// 上游列表和每日利润的渠道表共用这一个，不各写一份。
export function keepOrder(previousIds, nextIds, hold) {
  if (!hold || !previousIds?.length) return [...nextIds];
  const next = new Set(nextIds), kept = previousIds.filter((id) => next.has(id)), seen = new Set(kept);
  return [...kept, ...nextIds.filter((id) => !seen.has(id))];
}
