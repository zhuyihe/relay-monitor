// 「合并重复的上游」页面上的字和每一块写什么（design/ux/k1a-merge.md，用语规范 §3.5、§5.4、§8.2、§11 里标 K1a 的那几行）。
// 页面（app/components/merge-upstreams.tsx）只管摆，字都在这里，单测锁住。数据来自 GET /api/upstream-merges（server/upstream-merge.js）。
import { formatMoney, formatRate, formatZonedDate, formatZonedDateTime, EMPTY } from "./format.js";
import { UPSTREAM_FORM_TEXT, onboardingBaseUrl } from "./channel-onboarding.js";
import { workflowAction, workflowActionMeta } from "./workflow-actions.js";

export const MERGE_TEXT = Object.freeze({
  title: "合并重复的上游",
  intro: "下面每组是同一个上游账号（类型、地址、账号 ID 都一样），被加成了几个上游。合成一个以后，成本估算不再重复算；每日利润不受影响。",
  empty: "没有要合的上游了。",
  cannotMerge: "合不了",
  estimateUnavailable: "成本估算暂时算不出，合并照样能做",
  confirmCancel: "取消",
  undoneAt: (at) => `已退回（${at}）`,
  mergedToast: (n) => `已合并，上游列表少了 ${n} 个`,
  undoneToast: "已退回",
  retry: "再试一次",
  recordsMenu: "合并记录",
  recordsSummary: (n) => `合并记录（${n} 次）`,
  groupCount: (n) => `${n} 个上游`,
  loadFailed: "合并清单读不到",
  // 这一组 / 这次合并在别处变了（比如另一个窗口已经合过）：重试只会一直失败，让人刷新（§8.2「内容有变化」那一类）
  changedGroup: "这一组已经变了，刷新后再看。",
  changedRecord: "这次合并已经变了，刷新后再看。",
  refresh: "刷新",
  // 「恢复监控」时那个上游在清单读出来以后被改过（版本对不上）：同样让人刷新
  changedStation: "这个上游刚被改过，刷新后再看。",
  // 这一组没有「按量算进利润」的上游：成本估算那两行不写「¥0.00 → ¥0.00」，换一句说明
  noUsageFixedCost: "这一组都按固定成本算，成本估算里没有按用量算的花费，合并前后不变。",
  noUsageNotInProfit: "这一组都不算进利润，成本估算不算它们，合并前后不变。",
});

// 「1 美元 = 7.20 元」只留后面的「7.20 元」
const rateOnly = (rate) => formatRate(rate).replace(/^1 美元 = /, "");

const quote = (names) => names.map((name) => `「${name}」`).join("");
// 上游列表顶上那条提示。有要合的组才出现；只有合不了的组时换一句。没有组、读不到时不出现
export function mergeNoticeText(counts) {
  if (!counts) return null;
  const mergeable = Number(counts.mergeable) || 0, blocked = Number(counts.blocked) || 0;
  if (mergeable > 0) return `有 ${mergeable + blocked} 组上游是同一个账号，合成一个以后成本估算不再重复算`;
  if (blocked > 0) return `有 ${blocked} 组上游是同一个账号，现在还合不了`;
  return null;
}

// 成本估算总成本下面那一行：不写「算了几遍」（后加的上游可能还没有花费记录，数不一定翻几倍）
export function mergeCostLineText(counts) {
  if (!counts || !(Number(counts.accounts) > 0)) return null;
  const accounts = Number(counts.accounts), upstreams = Number(counts.upstreams);
  return accounts === 1 ? `其中 1 个账号加成了 ${upstreams} 个上游，这里重复算了` : `其中 ${accounts} 个账号各加成了几个上游（一共 ${upstreams} 个），这里重复算了`;
}

// 合并那一组的成本估算前后两行：近 7 天、近 30 天；算不出来写「—」。币种和成本估算页总成本同一个格式（G 以前：¥，没设汇率按 1 比 1，
// 估算的带「≈」），G 落地时两处一起换
export function estimateRows(estimate) {
  return [7, 30].map((days) => {
    const row = estimate?.windows?.find((item) => item.days === days);
    const money = (value) => formatMoney(value, { approx: !!row?.approx });
    return { days, label: `近 ${days} 天`, before: row ? money(row.before.cny) : EMPTY, after: row ? money(row.after.cny) : EMPTY, known: !!row,
      same: !!row && row.before.cny === row.after.cny };
  });
}

// 合不了的原因，一条一行：写清是哪几个上游、哪一项不一样、去哪里改（用语规范 §5.4「另外几种合不了的」）。
// action：这一行的按钮——link 是去一个地方（「处理重复」「编辑上游」），resume 是就地恢复被暂停的那个上游；没有按钮是 null。
// nameOf：上游 id → 名字
/** @param {any} blocker @param {{ nameOf: (id: string) => string, group: any }} context */
export function blockerView(blocker, { nameOf, group }) {
  const names = (ids) => quote(ids.map(nameOf));
  const editHref = (id) => `/stations?edit=${encodeURIComponent(id)}`;
  const retained = group.retained.name;
  if (blocker.code === "RULE_KEY_CONFLICT") {
    const who = blocker.stationIds.map(nameOf).map((name) => `「${name}」`);
    const action = workflowAction("review_conflict", { ruleId: blocker.ruleId, stationId: group.retained.id });
    return { text: `${who.length === 2 ? `${who[0]}和${who[1]}` : who.join("")}下都绑了 Key「${blocker.tokenName || `Key #${blocker.tokenId}`}」，合成一个以后这把 Key 会算两次。先在需处理里处理「这把 Key 绑了两次」那一条，再回来合。`,
      action: { kind: "link", label: action.label, href: action.href } };
  }
  if (blocker.code === "MONITOR_MISMATCH") {
    const resume = workflowActionMeta("resume_monitor");
    return { text: `${names(blocker.monitoredIds)}在读余额，${names(blocker.pausedIds)}暂停了监控，合成一个以后不知道该不该接着读。先改成一样（都恢复监控，或者都暂停），再回来合。`,
      action: { kind: "resume", label: resume.label, done: resume.done, stationId: blocker.pausedIds[0], stationName: nameOf(blocker.pausedIds[0]) } };
  }
  if (blocker.code === "PROFIT_MISMATCH") {
    return { text: `${names(blocker.countedIds)}算进利润，${names(blocker.uncountedIds)}不算进利润，合成一个以后不知道该按哪个算。先在编辑上游里改成一样，再回来合。`,
      action: { kind: "link", label: UPSTREAM_FORM_TEXT.edit, href: editHref(blocker.differsIds[0]) } };
  }
  if (blocker.code === "RATE_UNSET_ON_RETAINED") {
    const rates = blocker.mergedRates.map((item) => ({ name: nameOf(item.id), rate: item.rate }));
    const detail = rates.length === 1 ? formatRate(rates[0].rate) : rates.map((item) => `「${item.name}」${formatRate(item.rate)}`).join("，");
    return { text: `「${retained}」没设汇率，${quote(rates.map((item) => item.name))}设了（${detail}），合掉以后这个汇率就不算了。先给「${retained}」设上汇率，再回来合。`,
      action: { kind: "link", label: UPSTREAM_FORM_TEXT.edit, href: editHref(blocker.stationId) } };
  }
  if (blocker.code === "MERGED_HAS_FIXED_COST") {
    return { text: `「${nameOf(blocker.stationId)}」记了固定成本，合掉以后这几笔就不算了。先在「${retained}」上记上同样的固定成本、再从「${nameOf(blocker.stationId)}」上删掉，再回来合。`,
      action: { kind: "link", label: UPSTREAM_FORM_TEXT.edit, href: editHref(blocker.stationId) } };
  }
  if (blocker.code === "MERGED_HAS_RESOLD_KEYS") {
    return { text: `「${nameOf(blocker.stationId)}」上还标着转售 Key，合掉以后这些标记就不算了。先把它上面的转售标记取消，再回来合。`, action: null };
  }
  return { text: "这一组现在合不了。", action: null };
}

// 一组卡片要写的字。tz：业务时区
/** @param {any} group @param {{ tz?: string, now?: number }} [options] */
export function groupView(group, { tz, now = Date.now() } = {}) {
  // 被合掉的汇率和留下的不一样、或没设：不挡，只说合并以后按留下的那个算（被合掉的那几个还没固定的日子，数会照这个汇率变）
  const rateNote = group.rateNote ? `合并以后汇率按「${group.retained.name}」的 ${formatRate(group.rateNote.retainedRate)}算（${
    group.rateNote.others.map((item) => `「${[group.retained, ...group.merged].find((station) => station.id === item.id)?.name || item.id}」${item.rate == null ? "没设汇率" : `是 ${rateOnly(item.rate)}`}`).join("，")}）。` : "";
  const nameOf = (id) => [group.retained, ...group.merged].find((station) => station.id === id)?.name || id;
  const mergedNames = group.merged.map((station) => station.name);
  const size = 1 + group.merged.length;
  const host = onboardingBaseUrl(group.key.baseUrl).replace(/^https?:\/\//, "") || group.key.baseUrl;
  const rows = estimateRows(group.estimate);
  const noUsageNote = group.estimate?.noCounted === "fixed_cost" ? MERGE_TEXT.noUsageFixedCost : group.estimate?.noCounted === "not_in_profit" ? MERGE_TEXT.noUsageNotInProfit : null;
  const blocked = group.blockers.map((blocker) => blockerView(blocker, { nameOf, group }));
  return {
    heading: `「${group.retained.name}」这一组`,
    count: MERGE_TEXT.groupCount(size),
    mergeLine: `${quote(mergedNames)}并进「${group.retained.name}」`,
    whyLine: `留下的是最早加的那个（${formatZonedDate(group.retained.createdAt, tz, now)} 加的，余额历史最长）；名字以后可以在编辑上游里改。地址 ${host}、账号 ID ${group.key.accountId} 都一样。`,
    rows,
    // 有这一句时卡片不写那两行前后的数（都是 0），确认框也不写「从 … 变成 …」
    noUsageNote,
    times: `这个账号加成了 ${size} 个上游`,
    estimateNote: rows.every((row) => row.known) ? null : MERGE_TEXT.estimateUnavailable,
    afterMerge: `被合掉的从上游列表里消失，不再单独读余额；它们的登录信息、余额历史都留着。绑定改到「${group.retained.name}」上，每日利润不变。`,
    rateNote: rateNote || null,
    blocked: blocked.map((item) => item.text),
    // 几项都不一样时一项一行，按钮放第一个有按钮的那一项
    action: blocked.find((item) => item.action)?.action || null,
    confirm: {
      title: `合并「${group.retained.name}」这一组？`,
      lines: [
        `${quote(mergedNames)}会并进「${group.retained.name}」：它们从上游列表里消失，不再单独读余额；登录信息、余额历史都留着。`,
        // 前后一样（被合掉的那个还没有花费记录）、算不出时，不写「从 … 变成 …」
        `绑定改到「${group.retained.name}」上，每日利润不变。${rateNote}${rows[1].known && !rows[1].same && !noUsageNote ? `成本估算近 30 天从 ${rows[1].before} 变成 ${rows[1].after}，不再重复算。` : ""}`,
      ],
      hint: "合错了可以在「合并记录」里退回。",
    },
  };
}

// 合并记录里的一行
/** @param {any} record @param {{ tz?: string, now?: number }} [options] */
export function recordView(record, { tz, now = Date.now() } = {}) {
  const mergedNames = record.merged.map((station) => station.name);
  return {
    when: formatZonedDateTime(record.mergedAtMs, tz, now),
    text: `${quote(mergedNames)}并进「${record.retained.name}」`,
    undone: record.undoneAtMs ? MERGE_TEXT.undoneAt(formatZonedDateTime(record.undoneAtMs, tz, now)) : null,
    blocked: record.undoBlocked?.detail || null,
    confirm: {
      title: "退回这次合并？",
      lines: [`${quote(mergedNames)}回到上游列表，接着各自读余额；成本估算又会把这个账号重复算。`],
      hint: `合并以后在「${record.retained.name}」上加的绑定和改的设置，留在「${record.retained.name}」上，不跟着走。`,
    },
  };
}

// 合并、退回没成时的一句（§8.2）：原因是归类后的那句，后面固定写「什么都没改。」
export function mergeFailureText(what, reason) {
  return `${what}没成：${String(reason).replace(/[。]+$/, "")}。什么都没改。`;
}

// 「恢复监控」的确认框（§3.5 现成的说法）：就地恢复被暂停的那个上游
export function resumeConfirm(name) {
  return { title: `恢复监控「${name}」？`, line: "恢复以后接着读它的余额。这一组改成一样以后就能合。", ok: "恢复监控", cancel: MERGE_TEXT.confirmCancel };
}
