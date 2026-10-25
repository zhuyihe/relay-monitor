// 「合并重复的上游」页面上的字和每一块写什么（design/ux/k1a-merge.md，用语规范 §3.5、§5.4、§8.2、§11 里标 K1a 的那几行）。
// 页面（app/components/merge-upstreams.tsx）只管摆，字都在这里，单测锁住。数据来自 GET /api/upstream-merges（server/upstream-merge.js）。
import { formatMoney, formatZonedDate, formatZonedDateTime, EMPTY } from "./format.js";
import { onboardingBaseUrl } from "./channel-onboarding.js";
import { workflowAction } from "./workflow-actions.js";

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
});

const quote = (names) => names.map((name) => `「${name}」`).join("");
const TIMES = { 2: "两", 3: "三", 4: "四", 5: "五" };
const timesText = (n) => (TIMES[n] ? `${TIMES[n]}遍` : `${n} 遍`);

// 上游列表顶上那条提示。有要合的组才出现；只有合不了的组时换一句。没有组、读不到时不出现
export function mergeNoticeText(counts) {
  if (!counts) return null;
  const mergeable = Number(counts.mergeable) || 0, blocked = Number(counts.blocked) || 0;
  if (mergeable > 0) return `有 ${mergeable + blocked} 组上游是同一个账号，合成一个以后成本估算不再重复算`;
  if (blocked > 0) return `有 ${blocked} 组上游是同一个账号，现在还合不了`;
  return null;
}

// 成本估算总成本下面那一行。一个账号加成几个上游就写算了几遍；好几个账号时不写遍数
export function mergeCostLineText(counts) {
  if (!counts || !(Number(counts.accounts) > 0)) return null;
  const accounts = Number(counts.accounts), upstreams = Number(counts.upstreams);
  return `其中 ${accounts} 个账号加成了 ${upstreams} 个上游，${accounts === 1 ? `这里算了${TIMES[upstreams] ? "" : " "}${timesText(upstreams)}` : "这里都重复算了"}`;
}

// 合并那一组的成本估算前后两行：近 7 天、近 30 天；算不出来写「—」。设了汇率写 ¥，没设写 $（照 G）
export function estimateRows(estimate) {
  const symbol = estimate?.rateConfigured === false ? "$" : "¥";
  const money = (value) => formatMoney(value, { symbol });
  return [7, 30].map((days) => {
    const row = estimate?.windows?.find((item) => item.days === days);
    return { days, label: `近 ${days} 天`, before: row ? money(row.before.cny) : EMPTY, after: row ? money(row.after.cny) : EMPTY, known: !!row };
  });
}

// 合不了的原因，一条一句，说清是哪几个上游、怎么办。nameOf：上游 id → 名字
export function blockerText(blocker, { nameOf, group }) {
  const names = (ids) => quote(ids.map(nameOf));
  if (blocker.code === "RULE_KEY_CONFLICT") {
    const who = blocker.stationIds.map(nameOf).map((name) => `「${name}」`);
    return `${who.length === 2 ? `${who[0]}和${who[1]}` : who.join("")}下都绑了 Key「${blocker.tokenName || `Key #${blocker.tokenId}`}」，合成一个以后这把 Key 会算两次。先在需处理里处理「这把 Key 绑了两次」那一条，再回来合。`;
  }
  const all = names([group.retained.id, ...group.merged.map((station) => station.id)]);
  if (blocker.code === "MONITOR_MISMATCH") return `${all}里有的在监控、有的暂停了。先让它们一样，再回来合。`;
  if (blocker.code === "PROFIT_MISMATCH") return `${all}里有的算进利润、有的不算。先让它们一样，再回来合。`;
  if (blocker.code === "MERGED_HAS_FIXED_COST") return `${blocker.detail}，合并不会带走它们。先处理掉，再回来合。`;
  return "这一组现在合不了。";
}

// 「处理重复」去的地方（用语规范 §3.5 现成的那个动作）：只有同一把 Key 撞了才有
export function conflictAction(group) {
  const blocker = group.blockers.find((item) => item.code === "RULE_KEY_CONFLICT");
  return blocker ? workflowAction("review_conflict", { ruleId: blocker.ruleId, stationId: group.retained.id }) : null;
}

// 一组卡片要写的字。tz：业务时区
/** @param {any} group @param {{ tz?: string, now?: number }} [options] */
export function groupView(group, { tz, now = Date.now() } = {}) {
  const nameOf = (id) => [group.retained, ...group.merged].find((station) => station.id === id)?.name || id;
  const mergedNames = group.merged.map((station) => station.name);
  const size = 1 + group.merged.length;
  const host = onboardingBaseUrl(group.key.baseUrl).replace(/^https?:\/\//, "") || group.key.baseUrl;
  const rows = estimateRows(group.estimate);
  return {
    heading: `「${group.retained.name}」这一组`,
    count: MERGE_TEXT.groupCount(size),
    mergeLine: `${quote(mergedNames)}并进「${group.retained.name}」`,
    whyLine: `留下的是最早加的那个（${formatZonedDate(group.retained.createdAt, tz, now)} 加的，余额历史最长）；名字以后可以在编辑上游里改。地址 ${host}、账号 ID ${group.key.accountId} 都一样。`,
    rows,
    times: `同一个账号原来算了 ${size} 遍`,
    estimateNote: rows.every((row) => row.known) ? null : MERGE_TEXT.estimateUnavailable,
    afterMerge: `被合掉的从上游列表里消失，不再单独读余额；它们的登录信息、余额历史都留着。绑定改到「${group.retained.name}」上，每日利润不变。`,
    blocked: group.blockers.map((blocker) => blockerText(blocker, { nameOf, group })),
    conflict: conflictAction(group),
    confirm: {
      title: `合并「${group.retained.name}」这一组？`,
      lines: [
        `${quote(mergedNames)}会并进「${group.retained.name}」：它们从上游列表里消失，不再单独读余额；登录信息、余额历史都留着。`,
        rows[1].known ? `绑定改到「${group.retained.name}」上，每日利润不变。成本估算近 30 天从 ${rows[1].before} 变成 ${rows[1].after}，不再重复算。`
          : `绑定改到「${group.retained.name}」上，每日利润不变。`,
      ],
      hint: "合错了可以在「合并记录」里退回。",
    },
  };
}

// 合并记录里的一行
/** @param {any} record @param {{ tz?: string, now?: number }} [options] */
export function recordView(record, { tz, now = Date.now() } = {}) {
  const mergedNames = record.merged.map((station) => station.name);
  const size = 1 + record.merged.length;
  return {
    when: formatZonedDateTime(record.mergedAtMs, tz, now),
    text: `${quote(mergedNames)}并进「${record.retained.name}」`,
    undone: record.undoneAtMs ? MERGE_TEXT.undoneAt(formatZonedDateTime(record.undoneAtMs, tz, now)) : null,
    blocked: record.undoBlocked?.detail || null,
    confirm: {
      title: "退回这次合并？",
      lines: [`${quote(mergedNames)}回到上游列表，接着各自读余额；成本估算又会把这个账号算${timesText(size)}。`],
      hint: `合并以后在「${record.retained.name}」上加的绑定和改的设置，留在「${record.retained.name}」上，不跟着走。`,
    },
  };
}

// 合并、退回没成时的一句（§8.2）：原因是归类后的那句，后面固定写「什么都没改。」
export function mergeFailureText(what, reason) {
  return `${what}没成：${String(reason).replace(/[。]+$/, "")}。什么都没改。`;
}
