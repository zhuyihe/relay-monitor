// 每日利润页 A（设计稿 #118 §9，纯函数）：把现有的对账结果（一条绑定一行，整段的收入 / 实付 / 毛利）和账本按天的几列
// （应付成本、原因、Token；server 的 listLedgerDayFacts）拼成页面要的整页数和一行一行的表。钱都是美元原币，页面按汇率换算；
// 「—」的原因给码，页面查用语规范 §5.7 的字。不引 node: 模块。
//   - 一行 = 一个上游的一把 Key（几条绑定合用一把 Key 时合成一行、金额相加）；
//   - 收入 / 实付成本 / 毛利沿用现有结果：算进利润的行（countsInSummary）才加，需处理的行收入留在 uncountedIncomeUsd；
//   - 差额只按已固定的日子算：每行每天 gapOf(实付, 应付)；「对不上」按每一行每一天判（同时超过门槛的两个数）；
//   - 范围里有今天或还在读取的日子时不给 expectedCostUsd（应付成本只有已固定的日子才有）。
import { GAP_THRESHOLD, gapOf } from "./expected-cost-day.js";
import { mergeKeyAmounts } from "./reconciliation-keys.js";
import { countsInSummary, reconciliationKeyName } from "./reconciliation-view.js";
import { reconciliationAccountingStart } from "./reconciliation-contract.js";
import { dayKeyInTz, shiftDayLabel } from "./business-time.js";

// V1-b 上线以前固定的日子：账本里应付成本和原因都空（用语规范 §5.7「这天在开始算应付成本以前，没算」）
export const EXPECTED_COST_NOT_RECORDED = "EXPECTED_COST_NOT_RECORDED";
// 固定成本的上游：不比实付和应付（没有应付这个概念），state 一律 none（设计稿 §9.2）
export const FIXED_COST_UPSTREAM = "FIXED_COST_UPSTREAM";
export const PROFIT_DAILY_MAX_DAYS = 31;

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

// 一行一天的计算明细（§9.3）：pieces 是这一行各条绑定这天的 { rule, result（账本里的或现算的）, expected（账本 detail.expected）, entry（账本行，没固定是 null） }
export function buildProfitDetail(pieces = [], { day, threshold = GAP_THRESHOLD } = {}) {
  const results = pieces.map((piece) => piece.result).filter(Boolean);
  const incomeUsd = results.length ? sum(results.map((result) => finite(result.downstream?.amountUsd) ?? 0)) : null;
  const adminAmounts = results.map((result) => finite(result.downstream?.adminUsageAmountUsd));
  // 扣没扣管理员自用：照 R1 账本每一行（adminUsageDays；R1 以前固定的账那一行没有这个数 = 没扣）
  const adminDays = results.reduce((acc, result) => {
    const days = result.downstream?.adminUsageDays ?? (result.downstream?.adminUsageQuotaUnits !== undefined ? { deducted: 1, undeducted: 0 } : { deducted: 0, undeducted: 1 });
    return { deducted: acc.deducted + (days.deducted ?? 0), undeducted: acc.undeducted + (days.undeducted ?? 0) };
  }, { deducted: 0, undeducted: 0 });
  const deducted = adminDays.deducted > 0 && adminDays.undeducted === 0 ? "all" : adminDays.deducted === 0 ? "none" : "some";
  const byChannel = results.flatMap((result) => (result.downstream?.channels || []).map((channel) => ({ channelId: channel.channelId, usd: finite(channel.knownAmountUsd ?? channel.amountUsd) })));
  const expectedPieces = pieces.map((piece) => piece.expected).filter(Boolean);
  const settled = pieces.some((piece) => piece.entry);
  const complete = pieces.length > 0 && expectedPieces.length === pieces.length && expectedPieces.every((item) => item.usd != null);
  const expectedUsd = complete ? sum(expectedPieces.map((item) => item.usd)) : null;
  const reason = expectedPieces.find((item) => item.reason)?.reason ?? (settled && !complete ? EXPECTED_COST_NOT_RECORDED : null);
  const byModel = new Map();
  for (const item of expectedPieces) for (const row of item.byModel || []) {
    const key = `${row.model}\u0000${row.upstreamModel || ""}`;
    const acc = byModel.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, beforeRatioUsd: 0 };
    for (const field of ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "usd", "beforeRatioUsd"]) acc[field] += Number(row[field]) || 0;
    byModel.set(key, acc);
  }
  const missing = new Map();
  for (const item of expectedPieces) for (const row of item.missingPriceModels || []) {
    const key = `${row.model}\u0000${row.upstreamModel || ""}`;
    const acc = missing.get(key) || { ...row, requests: 0, inputTokens: 0, outputTokens: 0 };
    for (const field of ["requests", "inputTokens", "outputTokens"]) acc[field] += Number(row[field]) || 0;
    missing.set(key, acc);
  }
  const first = results[0];
  const keyAmounts = mergeKeyAmounts(results.map((result) => result.upstream?.byKey ?? []));
  const keyMoves = [...new Map(pieces.flatMap((piece) => piece.moves || []).map((move) => [`${move.key.upstreamStationId}:${move.key.tokenId}@${move.atMs}`, move])).values()].sort((x, y) => x.atMs - y.atMs);
  // 实付和行上一个口径：固定成本的上游记 0（actualCostOf 同一条规则）
  const actualUsd = results.length ? sum(results.map((result) => actualCostOf(result) ?? 0)) : null;
  return { day, settled,
    income: { usd: incomeUsd, adminUsage: { usd: adminAmounts.every((amount) => amount == null) ? null : sum(adminAmounts.map((amount) => amount ?? 0)), deducted }, byChannel },
    expected: { usd: expectedUsd, reason, groupName: first?.upstream?.group ?? null, groupRatio: finite(first?.upstream?.ratio),
      segments: pieces.flatMap((piece) => (piece.expected?.segments || []).map((segment) => ({ ...segment, ruleId: piece.rule?.id ?? null }))),
      byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd), missingPriceModels: [...missing.values()].sort((a, b) => b.requests - a.requests),
      byChannel: expectedPieces.flatMap((item) => item.byChannel || []), tokens: expectedPieces.some((item) => item.tokens != null) ? sum(expectedPieces.map((item) => item.tokens ?? 0)) : null },
    actual: { usd: actualUsd, keyName: pieces[0]?.rule?.tokenName ?? null },
    // 换了 Key、Key 挪了手的那天（用语规范 §9）：amounts 每把 Key 各花了多少（不止一把时才有）、changes 换 Key 的几次、moves Key 在渠道之间挪的几次
    keys: { amounts: keyAmounts.length > 1 ? keyAmounts : [], changes: pieces.flatMap((piece) => piece.changes || []), moves: keyMoves },
    gap: gapOf(actualUsd, expectedUsd, threshold), grossProfitUsd: incomeUsd != null && actualUsd != null ? incomeUsd - actualUsd : null,
    fixedAt: pieces.map((piece) => piece.entry?.settledAt).filter(Boolean).sort().at(-1) ?? null,
    revisions: settled ? Math.max(...pieces.map((piece) => Number(piece.entry?.revision) || 0)) : null };
}

// 范围里的日子（标签）：从起点到终点（不含）或今天为止，按业务时区；一天都没有时空
export function dayLabelsOf(window, tz, now) {
  const labels = [];
  const first = dayKeyInTz(window.startMs, tz), last = dayKeyInTz(Math.min(window.endMs - 1, now), tz);
  for (let label = first, guard = 0; label <= last && guard < 400; label = shiftDayLabel(label, 1), guard += 1) labels.push(label);
  return labels;
}

// 实付成本那一侧：和 summarizeReconciliationWindowGroups 同一个取法（算进来的金额 countedAmountUsd，固定成本的上游记 0）
function actualCostOf(result) {
  if (result.rates?.costBasis === "fixed") return 0;
  const upstream = result.upstream || {};
  return finite(Object.hasOwn(upstream, "countedAmountUsd") ? upstream.countedAmountUsd : upstream.knownAmountUsd ?? upstream.amountUsd);
}
const incomeOf = (result) => finite(result.downstream?.knownAmountUsd ?? result.downstream?.amountUsd);

// 一行一天的差额：固定了而且算得出应付时给数；原因：算不出的码，V1-b 以前固定的给 EXPECTED_COST_NOT_RECORDED
function dayGapOf(fact, threshold) {
  if (!fact?.settledAt) return null;
  if (fact.expectedCostUsd == null) return { reason: fact.gapReason || EXPECTED_COST_NOT_RECORDED, gap: null, expectedCostUsd: null, actualCostUsd: finite(fact.costUsd) };
  return { reason: null, gap: gapOf(fact.costUsd, fact.expectedCostUsd, threshold), expectedCostUsd: fact.expectedCostUsd, actualCostUsd: finite(fact.costUsd) };
}

/**
 * results：queryRules 给的 results（已 enrich：rates、displayStatus、settledAt）；dayFacts：listLedgerDayFacts 的行；
 * window：{ preset, startMs, endMs, timezone }；stationOf(id) → 站点；missingModelsFor(ruleId, day) → 计算明细里「没算进的模型」名（可选，只在看一天时给）
 */
export function buildProfitPage({ results = [], dayFacts = [], window, now = Date.now(), tz = window?.timezone, stationOf = () => null,
  threshold = GAP_THRESHOLD, missingModelsFor = () => [] } = {}) {
  const today = dayKeyInTz(now, tz);
  const labels = dayLabelsOf(window, tz, now);
  // 看一天（含看今天）：点开那一行给近 7 天（到那天为止）——看今天时前 6 天是已固定的、最后一格是今天「明天出」（设计稿 §4、§9.2；设计验收 10-26）
  const singleDay = labels.length === 1;
  const facts = new Map(); // ruleId → Map(day → fact)
  for (const fact of dayFacts) { if (!facts.has(fact.ruleId)) facts.set(fact.ruleId, new Map()); facts.get(fact.ruleId).set(fact.billDate, fact); }
  const keyName = (rule) => reconciliationKeyName(rule, results.map((item) => item.rule));

  // 行：按（上游, Key）合并
  const rowsByKey = new Map();
  for (const result of results) {
    const rule = result.rule, rowKey = `${rule.upstreamStationId}:${rule.tokenId}`;
    const upstream = stationOf(rule.upstreamStationId);
    const row = rowsByKey.get(rowKey) || { rowKey, ruleIds: [], channels: [], upstream: { stationId: rule.upstreamStationId, name: upstream?.name ?? null, provider: rule.provider ?? upstream?.type ?? null },
      key: { name: keyName(rule), groupName: result.upstream?.group ?? rule.fixedGroup ?? null, groupRatio: finite(result.upstream?.ratio), upstreamKeyUrl: null },
      // 页面按汇率换算用：收入按自营站点的汇率、成本按这个上游的汇率（现有结果的 rates，已固定的日子是账本记的那份）；没设置是 null
      rates: { income: finite(result.rates?.income?.cnyPerUsd), cost: finite(result.rates?.cost?.cnyPerUsd), costBasis: result.rates?.costBasis ?? null },
      startedOn: null, startedAt: null, counted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, uncountedIncomeUsd: null, attention: null, timezone: rule.timezone, perDay: new Map() };
    row.ruleIds.push(rule.id);
    for (const channel of rule.channels || []) if (!row.channels.some((item) => item.channelId === channel.channelId)) row.channels.push({ channelId: channel.channelId, name: channel.name ?? null });
    const start = reconciliationAccountingStart(rule);
    if (start != null) {
      const startedOn = dayKeyInTz(start, rule.timezone || tz);
      if (row.startedOn == null || startedOn < row.startedOn) { row.startedOn = startedOn; row.startedAt = startedOn === today ? start : null; }
    }
    if (countsInSummary(result)) {
      row.counted = true;
      row.incomeUsd = add(row.incomeUsd, incomeOf(result));
      row.actualCostUsd = add(row.actualCostUsd, actualCostOf(result));
      row.grossProfitUsd = add(row.grossProfitUsd, finite(result.calculation?.profitUsd));
    } else row.uncountedIncomeUsd = add(row.uncountedIncomeUsd, incomeOf(result));
    const status = result.displayStatus;
    // shrunk：这天重算的数比原来少了一半多、没换掉，「重新读取」要先弹确认框（C3，lib/reconciliation-view.js 的 resettleShrunkConfirm）；
    // 只有 RESETTLE_SHRUNK 才有，透传给页面，不在这里拼框的内容（页面按 action.window 取这天）
    if (status?.state === "action" && !row.attention) row.attention = { code: status.code ?? status.action?.code ?? null, title: status.title ?? null, detail: status.detail ?? null, action: status.action ?? null, fromDay: null, moreCount: status.moreCount ?? 0, shrunk: status.shrunk ?? null };
    // 这条绑定每天的账本列（同一把 Key 几条绑定：同一天相加）
    for (const [day, fact] of facts.get(rule.id) || []) {
      const slot = row.perDay.get(day) || { settled: true, expectedCostUsd: null, actualCostUsd: null, tokens: null, reason: null, rules: 0 };
      slot.rules += 1;
      const piece = dayGapOf(fact, threshold);
      if (piece.reason) slot.reason ||= piece.reason;
      slot.expectedCostUsd = add(slot.expectedCostUsd, piece.expectedCostUsd);
      slot.actualCostUsd = add(slot.actualCostUsd, piece.actualCostUsd);
      slot.tokens = add(slot.tokens, finite(fact.tokens));
      if (piece.reason === "MODEL_PRICE_MISSING") slot.missingModels = [...new Set([...(slot.missingModels || []), ...missingModelsFor(rule.id, day)])];
      row.perDay.set(day, slot);
    }
    rowsByKey.set(rowKey, row);
  }

  // 整页按天：一天已固定 = 过去的日子、每条算进来的绑定都有账本行；今天 = 今天；其余还在读取
  // （那天还没开始算的绑定不要求有账本行）
  const startedOnOf = new Map(results.map((item) => { const start = reconciliationAccountingStart(item.rule); return [item.rule.id, start == null ? null : dayKeyInTz(start, item.rule.timezone || tz)]; }));
  const countedRules = results.filter(countsInSummary).map((item) => item.rule.id);
  const dayState = (day) => {
    if (day === today) return "today";
    if (day > today) return "future";
    const due = countedRules.filter((id) => startedOnOf.get(id) == null || startedOnOf.get(id) <= day);
    return due.length && due.every((id) => facts.get(id)?.has(day)) ? "fixed" : "reading";
  };
  const dayCounts = { fixed: 0, reading: 0, today: 0 };
  for (const day of labels) { const state = dayState(day); if (state in dayCounts) dayCounts[state] += 1; }
  const allFixed = labels.length > 0 && dayCounts.reading === 0 && dayCounts.today === 0;

  // 每行的差额（只算已固定的日子）、每天小格
  const rows = [...rowsByKey.values()].map((row) => {
    const rowDays = labels.filter((day) => row.startedOn == null || day >= row.startedOn);
    // 这一行合用一把 Key 的几条绑定里，这天是不是每条都有账本行（少一条就算还在读取，不能只看「有没有任何一条」审核 #126 M1）
    const complete = (day) => { const slot = row.perDay.get(day); return !!slot && slot.rules === row.ruleIds.length; };
    const fixedDays = rowDays.filter(complete);
    // 固定成本的上游：不比实付和应付，state 一律 none + FIXED_COST_UPSTREAM，不进「对不上」也不进「算不了差额」
    const isFixedCost = row.rates.costBasis === "fixed";
    const computable = isFixedCost ? [] : fixedDays.map((day) => [day, row.perDay.get(day)]).filter(([, slot]) => slot.reason == null && slot.expectedCostUsd != null && slot.actualCostUsd != null);
    const judged = computable.map(([day, slot]) => ({ day, slot, gap: gapOf(slot.actualCostUsd, slot.expectedCostUsd, threshold) }));
    const mismatched = judged.filter((item) => item.gap.state !== "within");
    const expectedTotal = sum(judged.map((item) => item.slot.expectedCostUsd)), gapTotal = sum(judged.map((item) => item.gap.usd));
    const firstReason = fixedDays.map((day) => row.perDay.get(day).reason).find(Boolean) || null;
    const missingPriceModels = isFixedCost ? [] : [...new Set(fixedDays.flatMap((day) => row.perDay.get(day).missingModels || []))];
    // rowDays 已经按 startedOn 筛过（只留开始算以后的日子），范围整段都在开始之前时 rowDays 是空的
    const notStarted = row.startedOn != null && rowDays.length === 0;
    // state 只有 over/under/within/today/reading/none；没开始算、算不出的都是 none，原因在 reason 里；需处理只在 attention 字段
    const state = isFixedCost ? "none"
      : judged.length ? (mismatched.some((item) => item.gap.state === "over") ? "over" : mismatched.length ? "under" : "within")
      : rowDays.length && rowDays.every((day) => day === today) ? "today"
      : notStarted ? "none"
      : fixedDays.length ? "none" : "reading";
    const reason = isFixedCost ? FIXED_COST_UPSTREAM : judged.length ? null : notStarted ? "NOT_STARTED" : fixedDays.length ? firstReason : null;
    const gap = { usd: judged.length ? gapTotal : null, rate: judged.length && expectedTotal > 0 ? gapTotal / expectedTotal : null, state,
      mismatchedDays: mismatched.map((item) => ({ day: item.day, usd: item.gap.usd, state: item.gap.state })), days: judged.length,
      reason, missingPriceModels };
    // 点开那一行：看一天（含今天）给近 7 天（到那天为止），多天给范围里每一天（最多 31 天，取最后的）
    const dailyDays = singleDay ? Array.from({ length: 7 }, (_, index) => shiftDayLabel(labels[0], index - 6)) : labels.slice(-PROFIT_DAILY_MAX_DAYS);
    // 固定成本的上游：点开的小格、最近一个已固定的日子也不比差额，和行上口径一致（审核 #126 第 2 轮 中：M2 没改全）
    const daily = dailyDays.map((day) => {
      const fixed = complete(day), slot = fixed ? row.perDay.get(day) : null;
      const dayGap = !isFixedCost && slot && slot.reason == null && slot.expectedCostUsd != null && slot.actualCostUsd != null ? gapOf(slot.actualCostUsd, slot.expectedCostUsd, threshold) : null;
      const state = row.startedOn != null && day < row.startedOn ? "notStarted" : day === today ? "today" : day > today ? "future" : fixed ? "fixed" : row.attention ? "attention" : "reading";
      const reason = isFixedCost ? (slot ? FIXED_COST_UPSTREAM : null) : slot?.reason ?? (slot && dayGap == null ? EXPECTED_COST_NOT_RECORDED : null);
      return { day, state, gapUsd: dayGap?.usd ?? null, gapState: dayGap?.state ?? null, reason, tokens: slot?.tokens ?? null };
    });
    // 看今天时这一行最近一个已固定的日子
    const latestDay = [...row.perDay.keys()].filter((day) => day < today && complete(day)).sort().at(-1) || null;
    const latestSlot = latestDay ? row.perDay.get(latestDay) : null;
    const latestGap = !isFixedCost && latestSlot && latestSlot.reason == null && latestSlot.expectedCostUsd != null && latestSlot.actualCostUsd != null ? gapOf(latestSlot.actualCostUsd, latestSlot.expectedCostUsd, threshold) : null;
    const latestSettledGap = latestDay ? { day: latestDay, usd: latestGap?.usd ?? null, state: latestGap?.state ?? null,
      reason: isFixedCost ? FIXED_COST_UPSTREAM : latestSlot.reason ?? (latestGap ? null : EXPECTED_COST_NOT_RECORDED) } : null;
    const excludedDays = row.counted ? 0 : rowDays.length;
    const { perDay, counted, timezone, ...plain } = row;
    return { ...plain, counted, expectedCostUsd: allFixed && judged.length === rowDays.length && rowDays.length ? expectedTotal : null, gap, daily, latestSettledGap, excludedDays,
      // underUsd 是正数（少扣的差额大小）；usd = overUsd − underUsd + withinUsd（与 gapTotal 恒等：under 那几天的原始差额本身是负的）
      judgedCount: judged.length, overUsd: sum(mismatched.filter((item) => item.gap.state === "over").map((item) => item.gap.usd)),
      underUsd: -sum(mismatched.filter((item) => item.gap.state === "under").map((item) => item.gap.usd)), withinUsd: sum(judged.filter((item) => item.gap.state === "within").map((item) => item.gap.usd)),
      expectedTotal, actualTotal: sum(judged.map((item) => item.slot.actualCostUsd)), judgedDays: judged.map((item) => item.day) };
  });

  // 整页
  const counted = rows.filter((row) => row.counted);
  const pageTotals = { incomeUsd: counted.length ? sum(counted.map((row) => row.incomeUsd ?? 0)) : null, actualCostUsd: counted.length ? sum(counted.map((row) => row.actualCostUsd ?? 0)) : null,
    grossProfitUsd: counted.length ? sum(counted.map((row) => row.grossProfitUsd ?? 0)) : null, grossMarginRate: null };
  pageTotals.grossMarginRate = pageTotals.incomeUsd > 0 && pageTotals.grossProfitUsd != null ? pageTotals.grossProfitUsd / pageTotals.incomeUsd : null;
  const judgedRows = rows.filter((row) => row.judgedCount > 0);
  const judgedDays = [...new Set(judgedRows.flatMap((row) => row.judgedDays))].sort();
  const contiguous = judgedDays.length > 0 && judgedDays.every((day, index) => index === 0 || shiftDayLabel(judgedDays[index - 1], 1) === day);
  const gap = { days: { first: judgedDays[0] ?? null, last: judgedDays.at(-1) ?? null, count: judgedDays.length, contiguous },
    expectedCostUsd: judgedRows.length ? sum(judgedRows.map((row) => row.expectedTotal)) : null, actualCostUsd: judgedRows.length ? sum(judgedRows.map((row) => row.actualTotal)) : null,
    usd: judgedRows.length ? sum(judgedRows.map((row) => row.gap.usd)) : null, overUsd: sum(judgedRows.map((row) => row.overUsd)), underUsd: sum(judgedRows.map((row) => row.underUsd)),
    withinUsd: sum(judgedRows.map((row) => row.withinUsd)), rowCount: judgedRows.length };
  // 看今天时：最近一个已固定的日子（各行里最近的那天），那天的差额加起来、对不上的行数
  const latestDay = rows.map((row) => row.latestSettledGap?.day).filter(Boolean).sort().at(-1) || null;
  const latestRows = latestDay ? rows.filter((row) => row.latestSettledGap?.day === latestDay) : [];
  const latestSettledGap = latestDay ? { day: latestDay, usd: latestRows.some((row) => row.latestSettledGap.usd != null) ? sum(latestRows.map((row) => row.latestSettledGap.usd ?? 0)) : null,
    mismatchedRowCount: latestRows.filter((row) => ["over", "under"].includes(row.latestSettledGap.state)).length } : null;
  const channelCount = (list) => sum(list.map((row) => row.channels.length));
  // 固定成本的上游不进「算不了差额」
  const uncomputable = {};
  for (const row of rows) if (row.gap.reason && row.gap.reason !== FIXED_COST_UPSTREAM) uncomputable[row.gap.reason] = (uncomputable[row.gap.reason] || 0) + row.channels.length;
  const counts = { channels: channelCount(rows), countedChannels: channelCount(counted), mismatchedChannels: channelCount(rows.filter((row) => ["over", "under"].includes(row.gap.state))),
    attentionChannels: channelCount(rows.filter((row) => row.attention)), uncomputable,
    mismatchedDays: { over: sum(rows.map((row) => row.gap.mismatchedDays.filter((item) => item.state === "over").length)), under: sum(rows.map((row) => row.gap.mismatchedDays.filter((item) => item.state === "under").length)) } };
  // 行的顺序（§3.2）：对不上多扣的差额大的在前；需处理；对不上少扣；其余按毛利从大到小
  const rank = (row) => (row.gap.state === "over" ? 0 : row.attention ? 1 : row.gap.state === "under" ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (b.gap.usd ?? 0) - (a.gap.usd ?? 0) : rank(a) === 2 ? (a.gap.usd ?? 0) - (b.gap.usd ?? 0) : (b.grossProfitUsd ?? -Infinity) - (a.grossProfitUsd ?? -Infinity)));
  const cleanRows = rows.map(({ judgedCount, overUsd, underUsd, withinUsd, expectedTotal, actualTotal, judgedDays, ...row }) => row);
  return { range: { preset: window.preset ?? null, startMs: window.startMs, endMs: window.endMs, timezone: tz }, today, dayCounts, pageTotals, gap, latestSettledGap, counts, gapThreshold: { ...threshold }, rows: cleanRows };
}
