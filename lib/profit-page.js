// 每日利润页 A（设计稿 #118 §9，纯函数）：把现有的对账结果（一条绑定一行，整段的收入 / 实付 / 毛利）和账本按天的几列
// （应付成本、原因、Token；server 的 listLedgerDayFacts）拼成页面要的整页数和一行一行的表。钱都是美元原币，页面按汇率换算；
// 「—」的原因给码，页面查用语规范 §5.7 的字。不引 node: 模块。
//   - 一行 = 一个上游的一把 Key（几条绑定合用一把 Key 时合成一行、金额相加）；
//   - 收入 / 实付成本 / 毛利沿用现有结果：算进利润的行（countsInSummary）才加，需处理的行收入留在 uncountedIncomeUsd；
//   - 差额只按已固定的日子算：每行每天 gapOf(实付, 应付)；「对不上」按每一行每一天判（同时超过门槛的两个数）；
//   - 范围里有今天或还在读取的日子时不给 expectedCostUsd（应付成本只有已固定的日子才有）。
import { activeNowOf } from "./sale-tracker.js";
import { GAP_THRESHOLD, gapOf } from "./expected-cost-day.js";
import { countsInSummary, reconciliationDisplayStatus, reconciliationKeyName } from "./reconciliation-view.js";
import { reconciliationAccountingStart } from "./reconciliation-contract.js";
import { dayKeyInTz, dayStartInTz, shiftDayLabel, shiftedDayStartInTz } from "./business-time.js";
import { amortizeFixedCost, isConfiguredRate, purchasesOf, rateSnapshotOf } from "./profit.js";
import { consumeLogOffOverlap } from "./consume-log.js";

// V1-b 上线以前固定的日子：账本里应付成本和原因都空（用语规范 §5.7「这天在开始算应付成本以前，没算」）
export const EXPECTED_COST_NOT_RECORDED = "EXPECTED_COST_NOT_RECORDED";
// 固定成本的上游：不比实付和应付（没有应付这个概念），state 一律 none（设计稿 §9.2）
export const FIXED_COST_UPSTREAM = "FIXED_COST_UPSTREAM";
export const PROFIT_DAILY_MAX_DAYS = 31;
// 今天，同一个渠道换下来的那条绑定今天没读成、收入记在后绑的那条上（读成了）：这一行照读到的算进合计，只是成本可能少算了（和今天提醒换 Key 同一种提示：蓝色、照算）。
// 用户看不到「绑定」这一层，字里不写绑定
export const UNREAD_TODAY_NOTICE = Object.freeze({ code: "COST_UNREAD_TODAY", text: "成本可能少算了", detail: "换下来的那把 Key 今天的用量还没读到，读到以后会自动补上。", action: null });
const boundAtOf = (rule) => rule.boundAtMs ?? (Date.parse(rule.createdAt) || 0);

// 这条绑定从哪天开始算（业务日标签，没有起点是 null）：整页判断「还没开始算」和固定成本判断永远不固定的日子用同一个口径
export function ruleStartedOn(rule, tz) {
  const start = reconciliationAccountingStart(rule);
  return start == null ? null : dayKeyInTz(start, rule.timezone || tz);
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
// 这条绑定算不算进利润：整段算得出，或者多天范围里底（今天的现读）需处理、但已固定的几天有数（countedDays，server 的 dailyProfitResults 给）——后者按天算进来
const countsInRange = (result) => countsInSummary(result) || Number(result?.countedDays) > 0;
// 这天算不了、在等人处理（状态表的原因码）：这一天的状态行按码写成一件需处理（标题、说明、按钮都从码来），没有就是 null
function blockedAttention(rule, day, code, { tz, now }) {
  const zone = rule.timezone || tz, startMs = dayStartInTz(day, zone), window = { startMs, endMs: shiftedDayStartInTz(startMs, 1, zone), timezone: zone, preset: "custom" };
  const item = { rule, window, requestedWindow: window, calculation: {}, downstream: {}, upstream: {}, health: { code, issues: [{ code, side: null, channelId: rule.channels?.[0]?.channelId ?? null }] } };
  const status = reconciliationDisplayStatus(item, { now, timezone: zone });
  return status.state === "action" ? { code: status.code ?? code, title: status.title ?? null, detail: status.detail ?? null, action: status.action ?? null, fromDay: day, moreCount: 0, shrunk: null } : null;
}

// ---- 每把 Key 分开算（用户 10-30 定）----
// 一天里把渠道的收入分给每把 Key：只有一把，收入全归它（single）；有几把，按原价用量的比例分（raw）；读不到倍率（原价用量算不出）时按上游成本的比例分（cost）；
// 都算不出（成本也读不到、或几把都是 0）这天不分（pending）。keys：[{ tokenId, costUsd, rawUsd }]；返回 { basis, shares: Map(tokenId → 占比 0..1) }
export function splitIncomeByKeys(keys = []) {
  if (!keys.length) return { basis: "pending", shares: new Map() };
  if (keys.length === 1) return { basis: "single", shares: new Map([[keys[0].tokenId, 1]]) };
  const share = (field, basis) => {
    const values = keys.map((key) => finite(key[field]));
    const total = values.every((value) => value != null) ? sum(values) : 0;
    return total > 0 ? { basis, shares: new Map(keys.map((key, index) => [key.tokenId, values[index] / total])) } : null;
  };
  return share("rawUsd", "raw") ?? share("costUsd", "cost") ?? { basis: "pending", shares: new Map() };
}
const BASIS_RANK = { single: 0, raw: 1, cost: 2 };
const weakerBasis = (a, b) => (a == null ? b : b == null ? a : BASIS_RANK[b] > BASIS_RANK[a] ? b : a);
// 同一天同一把 Key 在几条绑定里出现（换上游当天……）：数相加；有一项读不到就是读不到
function mergeDayKeys(entries) {
  const byToken = new Map();
  for (const { key } of entries) {
    const cur = byToken.get(key.tokenId) || { tokenId: key.tokenId, costUsd: 0, rawUsd: 0, ratioWeighted: 0, ratioWeight: 0, ratio: null };
    cur.costUsd = cur.costUsd != null && finite(key.costUsd) != null ? cur.costUsd + key.costUsd : null;
    cur.rawUsd = cur.rawUsd != null && finite(key.rawUsd) != null ? cur.rawUsd + key.rawUsd : null;
    if (finite(key.ratio) != null) { cur.ratio = key.ratio; cur.ratioWeighted += key.ratio * Math.max(finite(key.costUsd) ?? 0, 0); cur.ratioWeight += Math.max(finite(key.costUsd) ?? 0, 0); }
    byToken.set(key.tokenId, cur);
  }
  return [...byToken.values()].map((item) => ({ ...item, ratio: item.ratioWeight > 0 ? item.ratioWeighted / item.ratioWeight : item.ratio }));
}

// 一行（一个渠道）范围里用过的每把 Key：成本、倍率、原价用量、分到的收入（读的时候算）。
// keyData：{ fixed: Map("规则|日期" → [{ tokenId, costUsd, ratio, rawUsd }])（已固定的日子，账本的 Key 行）, live: Map(规则 → [...])（今天现读）,
//   dayKeys: { 规则: { 日期: [{ tokenId, tokenName }] } }（每天记下的 Key，Key 名、没有 Key 行的老日子用） }
// 这天各条绑定的数要么都已固定、要么都是今天现读的，才分收入；只有一边固定的那天不分（pendingDays +1，成本照进 costUsd，收入不进）
function rowKeysOf({ row, labels, today, covers, keyData, facts, stationOf, stickyReasonOf, incomeOfDay }) {
  const byToken = new Map();
  const currentRule = row.rules.find((rule) => rule.archivedAtMs == null) ?? null;
  const nameOf = (rule, tokenId) => (Number(rule.tokenId) === Number(tokenId) ? rule.tokenName : null)
    ?? (keyData.dayKeys?.[rule.id] && Object.values(keyData.dayKeys[rule.id]).flat().find((key) => Number(key.tokenId) === Number(tokenId))?.tokenName) ?? null;
  for (const day of labels) {
    if (day > today || (day < today && stickyReasonOf(day))) continue;
    const due = row.rules.filter((rule) => covers(rule, day));
    if (!due.length) continue;
    const entries = []; let complete = true;
    for (const rule of due) {
      let list = null;
      if (day < today) {
        const fact = facts.get(rule.id)?.get(day);
        if (!fact) { complete = false; continue; }
        list = keyData.fixed?.get(`${rule.id}|${day}`) ?? null;
        if (!list) {
          // 这个功能以前固定的日子没有 Key 行：这天只记了一把 Key（或没记）就都算在它上面，记了几把的拆不开，这天不分
          const recorded = keyData.dayKeys?.[rule.id]?.[day] || [];
          if (recorded.length > 1) { complete = false; continue; }
          list = [{ tokenId: Number(recorded[0]?.tokenId ?? rule.tokenId), costUsd: fact.costBasis === "fixed" ? 0 : finite(fact.costUsd), ratio: null, rawUsd: null }]; // 固定成本的上游那天上游成本记 0，和渠道行同一个口径
        }
      } else {
        list = keyData.live?.get(rule.id) ?? null;
        if (!list) { complete = false; continue; }
      }
      for (const key of list) entries.push({ rule, key });
    }
    const income = complete && entries.length ? incomeOfDay(day) : null;
    const ensure = (tokenId, rule) => {
      const agg = byToken.get(tokenId) || { tokenId, rule, days: new Set(), firstDay: day, lastDay: day, cost: 0, costSplit: 0, raw: 0, income: 0, hasIncome: false, basis: null,
        ratioWeighted: 0, ratioWeight: 0, lastRatio: null, pendingDays: 0 };
      if (day < agg.firstDay) agg.firstDay = day;
      if (day > agg.lastDay) { agg.lastDay = day; agg.rule = rule; }
      byToken.set(tokenId, agg);
      return agg;
    };
    if (income == null) {
      // 这天渠道行没算进去（这几条绑定没都固定、或今天没读到）：这天整个不进 Key 行，成本和收入都不加，各把 Key 的 pendingDays 加 1，
      // 这样各把 Key 的成本加起来一直等于渠道成本（和渠道行的「渠道 × 天」挡一致）。整行都没算进来的不列 Key
      if (!row.counted) continue;
      const tokens = new Map(entries.map((entry) => [entry.key.tokenId, entry.rule]));
      for (const rule of due) for (const key of keyData.dayKeys?.[rule.id]?.[day] || [{ tokenId: rule.tokenId }]) if (!tokens.has(Number(key.tokenId))) tokens.set(Number(key.tokenId), rule);
      for (const [tokenId, rule] of tokens) ensure(tokenId, rule).pendingDays += 1;
      continue;
    }
    const dayKeys = mergeDayKeys(entries);
    const split = splitIncomeByKeys(dayKeys);
    for (const item of dayKeys) {
      const agg = ensure(item.tokenId, entries.find((entry) => entry.key.tokenId === item.tokenId).rule);
      agg.days.add(day);
      agg.cost = agg.cost != null && item.costUsd != null ? agg.cost + item.costUsd : null;
      agg.raw = agg.raw != null && item.rawUsd != null ? agg.raw + item.rawUsd : null;
      if (item.ratio != null) { agg.lastRatio = item.ratio; agg.ratioWeighted += item.ratio * Math.max(item.costUsd ?? 0, 0); agg.ratioWeight += Math.max(item.costUsd ?? 0, 0); }
      if (split.basis === "pending") agg.pendingDays += 1; // 几把 Key 的成本、原价用量都读不到，没法分：成本照进、这天份额不分
      else { agg.income += income * (split.shares.get(item.tokenId) ?? 0); agg.hasIncome = true; agg.basis = weakerBasis(agg.basis, split.basis); agg.costSplit = agg.costSplit != null && item.costUsd != null ? agg.costSplit + item.costUsd : null; }
    }
  }
  return [...byToken.values()].map((agg) => {
    const station = stationOf(agg.rule.upstreamStationId), provider = agg.rule.provider ?? station?.type ?? null;
    const grossProfitUsd = agg.hasIncome && agg.costSplit != null ? agg.income - agg.costSplit : null;
    return { tokenId: agg.tokenId, name: nameOf(agg.rule, agg.tokenId) ?? `#${agg.tokenId}`,
      upstream: { stationId: agg.rule.upstreamStationId, name: station?.name ?? null, provider: /^sub2api/.test(provider || "") ? "sub2api" : provider === "newapi" ? "newapi" : null },
      // active：在绑的渠道现在用的那把；unbound：已解绑的渠道最后用的那把（页面不标标签）；swapped：已换掉的
      state: row.bound ? (currentRule && Number(currentRule.tokenId) === agg.tokenId ? "active" : "swapped") : Number(row.rules[0]?.tokenId) === agg.tokenId ? "unbound" : "swapped", firstDay: agg.firstDay, lastDay: agg.lastDay, days: agg.days.size,
      ratio: agg.ratioWeight > 0 ? agg.ratioWeighted / agg.ratioWeight : agg.lastRatio, ratioKind: /^sub2api/.test(provider || "") ? "actual_over_standard" : "group",
      costUsd: agg.cost, rawUsd: agg.raw, incomeUsd: agg.hasIncome ? agg.income : null, incomeBasis: agg.hasIncome ? agg.basis : null,
      grossProfitUsd, grossMarginRate: grossProfitUsd != null && agg.income > 0 ? grossProfitUsd / agg.income : null, pendingDays: agg.pendingDays };
  }).sort((a, b) => (a.state === "active" ? 0 : 1) - (b.state === "active" ? 0 : 1) || (b.lastDay > a.lastDay ? 1 : b.lastDay < a.lastDay ? -1 : 0) || a.tokenId - b.tokenId);
}

// 一行一天的计算明细（§9.3）：pieces 是这一行各条绑定这天的 { rule, result（账本里的或现算的）, expected（账本 detail.expected）, entry（账本行，没固定是 null） }
// 每把 Key 这一天的数（keys、split）也在这里拼：pieces 里每块可以带 keys（这条绑定这天每把 Key 的 { tokenId, costUsd, ratio, rawUsd }，已固定的取账本、今天取现读，没有是 null）
// 和 dayKeys（这天记下的 Key { tokenId, tokenName }，取 Key 名用）。几块要么都已固定、要么都是现读的，才分收入；少一块的这天不分（split.basis = pending）
export function buildProfitDetail(pieces = [], { day, threshold = GAP_THRESHOLD, stationOf = () => null } = {}) {
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
  // 实付和行上一个口径：固定成本的上游记 0（actualCostOf 同一条规则）
  // 这一天没算出来的（换 Key 冲突期、还在读取、需处理……：没有利润）：实付、毛利写「—」加原因，不把没读到的成本当 0（审核 #133 第 4 轮 M4）
  const unavailable = results.find((result) => result.calculation?.profitUsd == null) ?? null;
  const actualUsd = results.length && !unavailable ? sum(results.map((result) => actualCostOf(result) ?? 0)) : null;
  return { day, settled,
    income: { usd: incomeUsd, adminUsage: { usd: adminAmounts.every((amount) => amount == null) ? null : sum(adminAmounts.map((amount) => amount ?? 0)), deducted }, byChannel },
    expected: { usd: expectedUsd, reason, keyChange: expectedPieces.find((item) => item.keyChange)?.keyChange ?? null, groupName: first?.upstream?.group ?? null, groupRatio: finite(first?.upstream?.ratio),
      segments: pieces.flatMap((piece) => (piece.expected?.segments || []).map((segment) => ({ ...segment, ruleId: piece.rule?.id ?? null }))),
      byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd), missingPriceModels: [...missing.values()].sort((a, b) => b.requests - a.requests),
      byChannel: expectedPieces.flatMap((item) => item.byChannel || []), tokens: expectedPieces.some((item) => item.tokens != null) ? sum(expectedPieces.map((item) => item.tokens ?? 0)) : null },
    actual: { usd: actualUsd, keyName: pieces[0]?.rule?.tokenName ?? null },
    // 这天没算出来的原因（displayStatus 的码、标题、说明）；算出来的是 null
    unavailable: unavailable ? { code: unavailable.displayStatus?.code ?? unavailable.health?.code ?? null, title: unavailable.displayStatus?.title ?? null, detail: unavailable.displayStatus?.detail ?? null } : null,
    gap: gapOf(actualUsd, expectedUsd, threshold), grossProfitUsd: incomeUsd != null && actualUsd != null ? incomeUsd - actualUsd : null,
    // 固定这天时自营站点的设置一直读不到（R2）：计算明细在「固定于」下面写一句，这天算了应付成本时再接半句
    settingUnreadable: pieces.some((piece) => piece.result?.consumeLogSetting || piece.entry?.detail?.settlement?.consumeLogSetting),
    fixedAt: pieces.map((piece) => piece.entry?.settledAt).filter(Boolean).sort().at(-1) ?? null,
    revisions: settled ? Math.max(...pieces.map((piece) => Number(piece.entry?.revision) || 0)) : null,
    ...detailKeysOf(pieces, { incomeUsd, stationOf }) };
}

function detailKeysOf(pieces, { incomeUsd, stationOf }) {
  const entries = [];
  const allFixed = pieces.length > 0 && pieces.every((piece) => piece.entry), allLive = pieces.length > 0 && pieces.every((piece) => !piece.entry);
  let complete = (allFixed || allLive) && pieces.every((piece) => piece.result && Array.isArray(piece.keys));
  for (const piece of pieces) if (Array.isArray(piece.keys)) for (const key of piece.keys) entries.push({ rule: piece.rule, key });
  const merged = mergeDayKeys(entries);
  const split = complete && incomeUsd != null && merged.length ? splitIncomeByKeys(merged) : { basis: "pending", shares: new Map() };
  const nameOf = (tokenId) => {
    for (const piece of pieces) {
      if (Number(piece.rule?.tokenId) === tokenId && piece.rule?.tokenName) return piece.rule.tokenName;
      const hit = (piece.dayKeys || []).find((key) => Number(key.tokenId) === tokenId);
      if (hit?.tokenName) return hit.tokenName;
    }
    return `#${tokenId}`;
  };
  const stationIds = [...new Set(pieces.map((piece) => piece.rule?.upstreamStationId).filter(Boolean))];
  const keys = merged.map((item) => {
    const rule = entries.find((entry) => entry.key.tokenId === item.tokenId).rule, station = stationOf(rule.upstreamStationId), provider = rule.provider ?? station?.type ?? null;
    const share = split.basis === "pending" ? null : split.shares.get(item.tokenId) ?? 0;
    const income = share == null ? null : incomeUsd * share;
    return { tokenId: item.tokenId, name: nameOf(item.tokenId), upstream: { stationId: rule.upstreamStationId, name: station?.name ?? null, provider: /^sub2api/.test(provider || "") ? "sub2api" : provider === "newapi" ? "newapi" : null },
      ratio: item.ratio, ratioKind: /^sub2api/.test(provider || "") ? "actual_over_standard" : "group", costUsd: item.costUsd, rawUsd: item.rawUsd,
      incomeUsd: income, incomeBasis: share == null ? null : split.basis, grossProfitUsd: income != null && item.costUsd != null ? income - item.costUsd : null,
      grossMarginRate: income != null && item.costUsd != null && income > 0 ? (income - item.costUsd) / income : null };
  }).sort((a, b) => (a.tokenId === Number(pieces[0]?.rule?.tokenId) ? 0 : 1) - (b.tokenId === Number(pieces[0]?.rule?.tokenId) ? 0 : 1) || a.tokenId - b.tokenId);
  const ratios = keys.map((key) => key.ratio).filter((ratio) => ratio != null).map((ratio) => Math.round(ratio * 1e6));
  return { keys, split: { basis: split.basis, shares: split.basis === "pending" ? [] : keys.map((key) => ({ tokenId: key.tokenId, percent: Math.round((split.shares.get(key.tokenId) ?? 0) * 10000) / 100 })) },
    swappedUpstream: stationIds.length > 1, keyChangeRatioDiffers: keys.length > 1 && new Set(ratios).size > 1 };
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
  threshold = GAP_THRESHOLD, missingModelsFor = () => [], stickyDays = new Map(), keyData = null, lastSaleOf = null } = {}) {
  const today = dayKeyInTz(now, tz);
  const labels = dayLabelsOf(window, tz, now);
  // 看一天（含看今天）：点开那一行给近 7 天（到那天为止）——看今天时前 6 天是已固定的、最后一格是今天「明天出」（设计稿 §4、§9.2；设计验收 10-26）
  const singleDay = labels.length === 1;
  const facts = new Map(); // ruleId → Map(day → fact)
  for (const fact of dayFacts) { if (!facts.has(fact.ruleId)) facts.set(fact.ruleId, new Map()); facts.get(fact.ruleId).set(fact.billDate, fact); }
  const keyName = (rule) => reconciliationKeyName(rule, results.map((item) => item.rule));

  // 行：按渠道合并（用户 10-30 定）：一个渠道一行，这个渠道在范围里挂过的绑定（在绑的、已解绑的）都在这一行里；
  // 在绑的排前面，行上的上游和 Key 取它（都已解绑取最后解绑的那条）
  const rowsByKey = new Map();
  const archivedDay = (rule) => (rule.archivedAtMs == null ? null : dayKeyInTz(Number(rule.archivedAtMs), rule.timezone || tz));
  const primaryFirst = (a, b) => (a.rule.archivedAtMs == null ? 0 : 1) - (b.rule.archivedAtMs == null ? 0 : 1) || Number(b.rule.archivedAtMs ?? 0) - Number(a.rule.archivedAtMs ?? 0);
  // 这条绑定这天算不算数：从开始算那天到解绑那天（解绑那天整天算）
  const covers = (rule, day) => { const from = ruleStartedOn(rule, tz), to = archivedDay(rule); return (from == null || from <= day) && (to == null || day <= to); };
  for (const result of [...results].sort(primaryFirst)) {
    const rule = result.rule, channelIds = (rule.channels || []).map((channel) => Number(channel.channelId)).sort((a, b) => a - b);
    const rowKey = channelIds.length ? `ch:${rule.ownStationId}:${channelIds.join(",")}` : `${rule.upstreamStationId}:${rule.tokenId}`;
    const upstream = stationOf(rule.upstreamStationId);
    const row = rowsByKey.get(rowKey) || { rowKey, ruleIds: [], channels: [], upstream: { stationId: rule.upstreamStationId, name: upstream?.name ?? null, provider: rule.provider ?? upstream?.type ?? null },
      key: { name: keyName(rule), groupName: result.upstream?.group ?? rule.fixedGroup ?? null, groupRatio: finite(result.upstream?.ratio), upstreamKeyUrl: null },
      // 页面按汇率换算用：收入按自营站点的汇率、成本按这个上游的汇率（现有结果的 rates，已固定的日子是账本记的那份）；没设置是 null
      rates: { income: finite(result.rates?.income?.cnyPerUsd), cost: finite(result.rates?.cost?.cnyPerUsd), costBasis: result.rates?.costBasis ?? null },
      startedOn: null, startedAt: null, bound: false, unboundOn: null, rules: [], parts: [], counted: false, todayCounted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null, uncountedIncomeUsd: null, attention: null, notice: null, timezone: rule.timezone, perDay: new Map() };
    row.ruleIds.push(rule.id);
    row.rules.push(rule);
    row.parts.push({ rule, counted: countsInRange(result) });
    if (result.todayCostUnread && !row.notice) row.notice = { ...UNREAD_TODAY_NOTICE }; // 多天范围里今天那一格（server 的 dailyProfitResults 标的）
    for (const channel of rule.channels || []) if (!row.channels.some((item) => item.channelId === channel.channelId)) row.channels.push({ channelId: channel.channelId, name: channel.name ?? null });
    const start = reconciliationAccountingStart(rule);
    if (start != null) {
      const startedOn = dayKeyInTz(start, rule.timezone || tz);
      if (row.startedOn == null || startedOn < row.startedOn) { row.startedOn = startedOn; row.startedAt = startedOn === today ? start : null; }
    }
    if (countsInSummary(result)) row.todayCounted = true; // 底（今天的现读）本身算得出：今天那格才有数
    if (countsInRange(result)) {
      row.counted = true;
      row.incomeUsd = add(row.incomeUsd, incomeOf(result));
      row.actualCostUsd = add(row.actualCostUsd, actualCostOf(result));
      row.grossProfitUsd = add(row.grossProfitUsd, finite(result.calculation?.profitUsd));
    } else row.uncountedIncomeUsd = add(row.uncountedIncomeUsd, incomeOf(result));
    const status = result.displayStatus;
    // shrunk：这天重算的数比原来少了一半多、没换掉，「重新读取」要先弹确认框（C3，lib/reconciliation-view.js 的 resettleShrunkConfirm）；
    // 只有 RESETTLE_SHRUNK 才有，透传给页面，不在这里拼框的内容（页面按 action.window 取这天）
    if (status?.state === "action" && !row.attention) row.attention = { code: status.code ?? status.action?.code ?? null, title: status.title ?? null, detail: status.detail ?? null, action: status.action ?? null, fromDay: null, moreCount: status.moreCount ?? 0, shrunk: status.shrunk ?? null };
    // 提示类的「感叹号」（只有今天提醒换 Key 一种，CHANNEL_KEY_IDLE_TODAY）：这一行照读到的数算、进合计，不是需处理；页面在渠道名后面亮感叹号、点开写 text 和 detail、按钮是 action
    const notice = (status?.hints || []).find((hint) => hint.code === "CHANNEL_KEY_IDLE_TODAY");
    if (notice && !row.notice) row.notice = { code: notice.code, text: notice.text, detail: notice.note ?? null, action: notice.action ?? null };
    // 这条绑定每天的账本列（同一把 Key 几条绑定：同一天相加）
    for (const [day, fact] of facts.get(rule.id) || []) {
      const slot = row.perDay.get(day) || { settled: true, expectedCostUsd: null, actualCostUsd: null, tokens: null, reason: null, rules: 0, revenueUsd: null, costUsd: null };
      slot.rules += 1;
      const piece = dayGapOf(fact, threshold);
      if (piece.reason) slot.reason ||= piece.reason;
      slot.expectedCostUsd = add(slot.expectedCostUsd, piece.expectedCostUsd);
      slot.actualCostUsd = add(slot.actualCostUsd, piece.actualCostUsd);
      slot.tokens = add(slot.tokens, finite(fact.tokens));
      // 这天的收入和上游成本（账本里的数，每天一行的毛利、柱状图用）；固定成本的上游成本记 0，和行上同一个口径
      slot.revenueUsd = add(slot.revenueUsd, finite(fact.revenueUsd));
      slot.costUsd = add(slot.costUsd, row.rates?.costBasis === "fixed" ? 0 : finite(fact.costUsd));
      if (piece.reason === "MODEL_PRICE_MISSING") slot.missingModels = [...new Set([...(slot.missingModels || []), ...missingModelsFor(rule.id, day)])];
      row.perDay.set(day, slot);
    }
    rowsByKey.set(rowKey, row);
  }

  // 看一天：同一个渠道这天挂着几条绑定（同一天换上游），要几条都算得出才算进来；只有一条有数的整行不算（按「渠道 × 天」挡，不出现只有成本、没有收入的假亏损）。
  // 多天范围已经在 server 的 dailyProfitResults 里按天挡了
  if (singleDay) {
    for (const row of rowsByKey.values()) {
      const cover = row.parts.filter((part) => covers(part.rule, labels[0]));
      const bad = cover.filter((part) => !part.counted);
      // 只在看今天时放宽：没读成的都是已解绑的、收入记在它上面的那条（后绑）读成了，这一行照读到的算，亮提示；过去的天照旧整天不算
      const holder = cover.reduce((best, part) => (boundAtOf(part.rule) > boundAtOf(best.rule) || (boundAtOf(part.rule) === boundAtOf(best.rule) && part.rule.id > best.rule.id) ? part : best), cover[0]);
      if (cover.some((part) => part.counted) && bad.length && labels[0] === today && bad.every((part) => part.rule.archivedAtMs != null) && holder.counted) {
        if (!row.notice) row.notice = { ...UNREAD_TODAY_NOTICE };
      } else if (cover.some((part) => part.counted) && bad.length) {
        row.uncountedIncomeUsd = add(row.uncountedIncomeUsd, row.incomeUsd);
        Object.assign(row, { counted: false, todayCounted: false, incomeUsd: null, actualCostUsd: null, grossProfitUsd: null });
      }
    }
  }

  // 整页按天：一天已固定 = 过去的日子、每条算进来的绑定都有账本行；今天 = 今天；其余还在读取
  // （那天还没开始算的绑定不要求有账本行）
  const countedRules = results.filter(countsInRange).map((item) => item.rule);
  // stickyDays：ruleId → Map(day → 原因码)，永远不固定的日子（换 Key 冲突期、自营站点没记收费记录那段）：不当成「还在读取」，也不拦住整页到不了「全固定」
  const isSticky = (id, day) => stickyDays.get(id)?.has(day) ?? false;
  const dayState = (day) => {
    if (day === today) return "today";
    if (day > today) return "future";
    const due = countedRules.filter((rule) => covers(rule, day) && !isSticky(rule.id, day));
    if (!due.length) return countedRules.some((rule) => covers(rule, day) && isSticky(rule.id, day)) ? "excluded" : "reading";
    return due.every((rule) => facts.get(rule.id)?.has(day)) ? "fixed" : "reading";
  };
  const dayCounts = { fixed: 0, reading: 0, today: 0 };
  for (const day of labels) { const state = dayState(day); if (state in dayCounts) dayCounts[state] += 1; }
  const allFixed = labels.length > 0 && dayCounts.reading === 0 && dayCounts.today === 0;
  const excludedCount = labels.filter((day) => dayState(day) === "excluded").length;
  if (excludedCount) dayCounts.excluded = excludedCount;

  // 每天的实付成本合计（成本估算「每天的上游成本」用，只加算进利润的行）：已固定的日子取账本里那天的数，
  // 今天（和还在读取的日子）没有账本数：这一行整段的实付减去已固定几天的合计，剩下的记在今天；人民币按这一行成本汇率折（没设按 1:1）
  const dailyCost = new Map(labels.map((day) => [day, { day, actualCostUsd: 0, actualCostCny: 0 }]));
  const addDaily = (day, usd, rate) => { const slot = dailyCost.get(day); if (!slot || !usd) return; slot.actualCostUsd += usd; slot.actualCostCny += rate > 0 ? usd * rate : usd; };

  // 每行的差额（只算已固定的日子）、每天小格
  const rows = [...rowsByKey.values()].map((row) => {
    // 已解绑的绑定解绑那天以后不再算；这天这一行有几条绑定在算（少一条没固定就算还在读取）
    row.bound = row.rules.some((rule) => rule.archivedAtMs == null);
    row.unboundOn = row.bound ? null : row.rules.map(archivedDay).sort().at(-1) ?? null;
    const dueCount = (day) => row.rules.filter((rule) => covers(rule, day)).length;
    if (row.counted) {
      let settledUsd = 0;
      for (const day of labels) { const slot = row.perDay.get(day); if (slot && slot.rules === dueCount(day) && slot.actualCostUsd != null) { settledUsd += slot.actualCostUsd; addDaily(day, slot.actualCostUsd, row.rates?.cost); } }
      const rest = (row.actualCostUsd ?? 0) - settledUsd;
      if (rest > 0) addDaily(today, rest, row.rates?.cost);
    }
    // 这一行有一条绑定这天永远不固定：这天不进这一行的合计、差额，小格单独标（原因从状态行来）
    const stickyReasonOf = (day) => { for (const id of row.ruleIds) { const code = stickyDays.get(id)?.get(day); if (code) return code; } return null; };
    const rowDays = labels.filter((day) => (row.startedOn == null || day >= row.startedOn) && (row.unboundOn == null || day <= row.unboundOn) && !stickyReasonOf(day));
    // 这一行合用一把 Key 的几条绑定里，这天是不是每条都有账本行（少一条就算还在读取，不能只看「有没有任何一条」审核 #126 M1）
    const complete = (day) => { const slot = row.perDay.get(day); return !!slot && slot.rules === dueCount(day); };
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
    // 今天（还没有账本）的收入和成本：这一行整段的数减去已固定几天的合计，剩下的记在今天（和「每天的实付成本」同一个算法）；没算进利润的行不给
    const settledOf = (field) => sum(labels.map((day) => { const slot = row.perDay.get(day); return slot && slot.rules === dueCount(day) && slot[field] != null ? slot[field] : 0; }));
    const todayIncome = row.counted && row.todayCounted && row.incomeUsd != null ? Math.max(0, row.incomeUsd - settledOf("revenueUsd")) : null;
    const todayCost = row.counted && row.todayCounted && row.actualCostUsd != null ? Math.max(0, row.actualCostUsd - settledOf("costUsd")) : null;
    const daily = dailyDays.map((day) => {
      const fixed = complete(day), slot = fixed ? row.perDay.get(day) : null;
      const dayGap = !isFixedCost && slot && slot.reason == null && slot.expectedCostUsd != null && slot.actualCostUsd != null ? gapOf(slot.actualCostUsd, slot.expectedCostUsd, threshold) : null;
      const sticky = day < today ? stickyReasonOf(day) : null;
      // 今天：底（今天的现读）需处理时今天不算进来，这格写需处理（不是实时），没有数
      const todayBlocked = day === today && row.attention && !row.todayCounted;
      const state = (row.startedOn != null && day < row.startedOn) || (row.unboundOn != null && day > row.unboundOn) ? "notStarted" : todayBlocked ? "attention" : day === today ? "today" : day > today ? "future" : sticky ? "attention" : fixed ? "fixed" : row.attention ? "attention" : "reading";
      const reason = sticky ? sticky : isFixedCost ? (slot ? FIXED_COST_UPSTREAM : null) : slot?.reason ?? (slot && dayGap == null ? EXPECTED_COST_NOT_RECORDED : null);
      // 这天的收入、上游成本、毛利（美元原币，页面按汇率换算）：已固定的取账本，今天取上面算的，其余没有
      const incomeUsd = state === "fixed" ? slot?.revenueUsd ?? null : state === "today" ? todayIncome : null;
      const actualCostUsd = state === "fixed" ? slot?.costUsd ?? null : state === "today" ? todayCost : null;
      const grossUsd = incomeUsd != null && actualCostUsd != null ? incomeUsd - actualCostUsd : null;
      return { day, state, gapUsd: dayGap?.usd ?? null, gapState: dayGap?.state ?? null, reason, tokens: slot?.tokens ?? null, incomeUsd, actualCostUsd, grossUsd };
    });
    // 看今天时这一行最近一个已固定的日子
    const latestDay = [...row.perDay.keys()].filter((day) => day < today && complete(day)).sort().at(-1) || null;
    const latestSlot = latestDay ? row.perDay.get(latestDay) : null;
    const latestGap = !isFixedCost && latestSlot && latestSlot.reason == null && latestSlot.expectedCostUsd != null && latestSlot.actualCostUsd != null ? gapOf(latestSlot.actualCostUsd, latestSlot.expectedCostUsd, threshold) : null;
    const latestSettledGap = latestDay ? { day: latestDay, usd: latestGap?.usd ?? null, state: latestGap?.state ?? null,
      reason: isFixedCost ? FIXED_COST_UPSTREAM : latestSlot.reason ?? (latestGap ? null : EXPECTED_COST_NOT_RECORDED) } : null;
    // 没算进来的天数：整行不算时是这一行开始算以后的全部日子；算进来的行里是被挡掉的天（需处理、永远不固定）
    const blockedDays = labels.filter((day) => (row.startedOn == null || day >= row.startedOn) && (row.unboundOn == null || day <= row.unboundOn) && stickyReasonOf(day) && day < today);
    const todayExcluded = row.counted && labels.includes(today) && row.attention && !row.todayCounted && (row.startedOn == null || today >= row.startedOn); // 算进来的行里今天需处理：今天这一天也没算进来
    const excludedDays = row.counted ? blockedDays.length + (todayExcluded ? 1 : 0) : rowDays.length;
    // 底没有需处理、只是中间某天被挡：行上补一件需处理（感叹号），内容按被挡那天的原因码来
    if (!row.attention && blockedDays.length) {
      const day = blockedDays[0], ruleId = row.ruleIds.find((id) => stickyDays.get(id)?.get(day)), result = results.find((item) => item.rule.id === ruleId);
      const attention = result ? blockedAttention(result.rule, day, stickyDays.get(ruleId).get(day), { tz, now }) : null;
      if (attention) row.attention = attention;
    }
    // 已解绑的行：没有需处理和提示（数照读）
    if (!row.bound) { row.attention = null; row.notice = null; }
    const grossMarginRate = row.counted && row.incomeUsd > 0 && row.grossProfitUsd != null ? row.grossProfitUsd / row.incomeUsd : null;
    // 每把 Key 的数（keyData 由 server 给；没给就是空）。这天的渠道收入：已固定的取这天各条绑定的账本，今天取上面算的 todayIncome
    const keys = keyData ? rowKeysOf({ row, labels, today, covers, keyData, facts, stationOf, stickyReasonOf,
      incomeOfDay: (day) => (day === today ? todayIncome : complete(day) ? row.perDay.get(day)?.revenueUsd ?? null : null) }) : [];
    // 看今天时给「最近 1 小时有收入」（server 记的、不另读站点）；别的范围 null
    const lastSaleAt = lastSaleOf ? lastSaleOf(row.ruleIds) : null;
    const { perDay, counted, todayCounted, timezone, rules, parts, ...plain } = row;
    return { ...plain, grossMarginRate, keys, lastSaleAt, activeNow: lastSaleOf ? activeNowOf(lastSaleAt, now) : null, counted, expectedCostUsd: allFixed && judged.length === rowDays.length && rowDays.length ? expectedTotal : null, gap, daily, latestSettledGap, excludedDays,
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
  return { range: { preset: window.preset ?? null, startMs: window.startMs, endMs: window.endMs, timezone: tz }, today, dayCounts, pageTotals, dailyCost: [...dailyCost.values()], gap, latestSettledGap, counts, gapThreshold: { ...threshold }, rows: cleanRows };
}

/**
 * 范围里的固定成本和没设汇率的固定上游——读固定成本的地方只有这一个函数（每日利润页；运营总览、自营业务以后也用它）。
 * 固定成本的上游按天平摊（lib/profit.js），换成美元要有汇率：算出金额的那天没有汇率就给 usd: null（页面写「固定成本算不出，净利先不算」）。
 *   - 已固定的日子（整天，表里有这一行）：只认 fixedDays（reconciliation_fixed_cost_days）里的行，不看上游现在是什么计法、归档没有、算不算进利润，
 *     也不看账本、不回退到现在的购买记录：basis 是 fixed 的记那天的人民币金额和汇率，usage / excluded 记 0（不另扣）；
 *   - 今天和表里没有这一行的日子（还没固定）：固定成本的上游（stations）按现在的购买记录和汇率摊，今天只摊到现在；
 *     账本里那天是按用量算的（任一条绑定的成本计法不是 fixed）不摊，一个上游一天只记一次（审核 #126 M3）；
 *   - 自营站点碰到过关着收费记录的那一段的日子（R2）：这天的收入不算进毛利，固定成本也不扣，不然净利会偏低（决定记录 58）；用这个上游的绑定判断。
 * 返回 usd（各天按各自记下的汇率折）和 cny（各天人民币原值直接相加，显示人民币时用它，不再来回折）。
 * stations：现在固定成本的上游；nameOf(id)：点名没设汇率的上游用；results：这一页每条绑定的结果（rule 里有 id、upstreamStationId、ownStationId）；
 * stickyDays：永远不固定的日子（毛利里去掉了的）；dayFacts：listLedgerDayFacts；fixedDays：listFixedCostDays（所有上游）；offPeriodsOf(ownStationId)：自营站点关着收费记录的时间段。
 */
export function fixedCostOfRange({ stations = [], nameOf = () => null, results = [], labels = [], window, now, tz, dayFacts = [], fixedDays = [], offPeriodsOf = () => [], stickyDays = new Map() }) {
  let usd = 0, cnyTotal = 0;
  const unset = new Map();
  const factOf = new Map(dayFacts.map((item) => [`${item.ruleId}:${item.billDate}`, item]));
  const recorded = new Map(fixedDays.map((item) => [`${item.stationId}:${item.billDate}`, item]));
  const boundOf = (stationId) => results.filter((row) => String(row.rule.upstreamStationId) === String(stationId));
  const stationName = (id) => stations.find((station) => String(station.id) === String(id))?.name ?? nameOf(id) ?? String(id);
  const add = (stationId, cny, rate) => {
    if (!cny) return;
    cnyTotal += cny;
    if (!(rate > 0)) { unset.set(String(stationId), { id: stationId, name: stationName(stationId) }); return; }
    usd += cny / Number(rate);
  };
  const offDay = (stationId, startMs, endMs) => boundOf(stationId).some((row) => { const overlap = consumeLogOffOverlap(offPeriodsOf(row.rule.ownStationId), { startMs, endMs }); return overlap.open || overlap.closed; });
  // 毛利里去掉了的「永远不固定的日子」（OWN_CONSUME_LOG_GAP 这类，stickyDays：规则 → 日期 → 原因）：这个上游所有绑定那天都是这样，固定成本也不扣
  // 只看那天已经开始算的绑定（和整页判断「从哪天开始算」同一个口径 ruleStartedOn）
  const stickyDay = (stationId, day) => {
    const started = boundOf(stationId).filter((row) => { const on = ruleStartedOn(row.rule, tz); return on == null || on <= day; });
    return started.length > 0 && started.every((row) => stickyDays.get(row.rule.id)?.has(day));
  };
  const stationIds = new Set(fixedDays.map((item) => String(item.stationId)));
  for (const day of labels) {
    const fullStartMs = dayStartInTz(day, tz), fullEndMs = shiftedDayStartInTz(fullStartMs, 1, tz);
    const dayStartMs = Math.max(fullStartMs, window.startMs);
    const dayEndMs = Math.min(fullEndMs, window.endMs, now);
    if (dayEndMs <= dayStartMs) continue;
    const full = dayStartMs === fullStartMs && dayEndMs === fullEndMs;
    // 表里已经固定的行：所有上游
    for (const id of stationIds) {
      const row = full ? recorded.get(`${id}:${day}`) : null;
      if (!row || row.basis !== "fixed" || offDay(id, dayStartMs, dayEndMs) || stickyDay(id, day)) continue;
      add(id, row.costCny, row.costRate);
    }
    // 还没固定的日子：现在固定成本的上游按现在的设置算
    for (const station of stations) {
      if (full && recorded.has(`${station.id}:${day}`)) continue;
      if (offDay(station.id, dayStartMs, dayEndMs) || stickyDay(station.id, day)) continue;
      if (boundOf(station.id).some((row) => { const fact = factOf.get(`${row.rule.id}:${day}`); return fact && fact.costBasis !== "fixed"; })) continue;
      const rate = rateSnapshotOf(station);
      add(station.id, amortizeFixedCost(purchasesOf(station), { startMs: dayStartMs, endMs: dayEndMs, tz }).exact, isConfiguredRate(rate) ? rate.cnyPerUsd : null);
    }
  }
  if (unset.size) usd = null;
  return { usd, cny: cnyTotal, rateUnset: [...unset.values()] };
}
