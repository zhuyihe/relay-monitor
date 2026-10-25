import test from "node:test";
import assert from "node:assert/strict";
import { blockerText, conflictAction, estimateRows, groupView, mergeCostLineText, mergeFailureText, mergeNoticeText, recordView } from "./upstream-merge-view.js";

const TZ = "Asia/Shanghai";
const NOW = Date.parse("2026-10-25T06:00:00Z");
const window = (days, before, after) => ({ days, before: { cny: before }, after: { cny: after } });
const group = (extra = {}) => ({
  key: { provider: "newapi", baseUrl: "https://api.example.com", accountId: "1024" },
  retained: { id: "a", name: "主力上游", baseUrl: "https://api.example.com", createdAt: "2026-10-03T02:00:00.000Z" },
  merged: [{ id: "b", name: "主力上游（2）" }, { id: "c", name: "主力上游·备用" }],
  ruleIds: [], linkCount: 0, droppedLinkCount: 0, costAliasesAfter: [], blockers: [], canMerge: true,
  estimate: { rateConfigured: true, windows: [window(7, 3211.2, 1070.4), window(30, 13982.4, 4660.8)] },
  ...extra,
});

test("上游列表顶上那条提示：有要合的组才出现，只有合不了的换一句，没有、读不到不出现", () => {
  assert.equal(mergeNoticeText({ mergeable: 2, blocked: 0 }), "有 2 组上游是同一个账号，合成一个以后成本估算不再重复算");
  assert.equal(mergeNoticeText({ mergeable: 1, blocked: 1 }), "有 2 组上游是同一个账号，合成一个以后成本估算不再重复算");
  assert.equal(mergeNoticeText({ mergeable: 0, blocked: 1 }), "有 1 组上游是同一个账号，现在还合不了");
  assert.equal(mergeNoticeText({ mergeable: 0, blocked: 0 }), null);
  assert.equal(mergeNoticeText(null), null);
});

test("成本估算总成本下面那一行：一个账号写算了几遍，好几个账号不写遍数", () => {
  assert.equal(mergeCostLineText({ accounts: 1, upstreams: 2 }), "其中 1 个账号加成了 2 个上游，这里算了两遍");
  assert.equal(mergeCostLineText({ accounts: 1, upstreams: 3 }), "其中 1 个账号加成了 3 个上游，这里算了三遍");
  assert.equal(mergeCostLineText({ accounts: 1, upstreams: 7 }), "其中 1 个账号加成了 7 个上游，这里算了 7 遍");
  assert.equal(mergeCostLineText({ accounts: 2, upstreams: 5 }), "其中 2 个账号加成了 5 个上游，这里都重复算了");
  assert.equal(mergeCostLineText({ accounts: 0, upstreams: 0 }), null);
  assert.equal(mergeCostLineText(null), null);
});

test("成本估算前后两行：设了汇率写 ¥，没设写 $，算不出写「—」", () => {
  assert.deepEqual(estimateRows(group().estimate).map((r) => [r.label, r.before, r.after]), [["近 7 天", "¥3,211.20", "¥1,070.40"], ["近 30 天", "¥13,982.40", "¥4,660.80"]]);
  assert.equal(estimateRows({ rateConfigured: false, windows: [window(7, 16.8, 8.4), window(30, 72, 36)] })[1].before, "$72.00");
  assert.deepEqual(estimateRows(null).map((r) => [r.before, r.after, r.known]), [["—", "—", false], ["—", "—", false]]);
});

test("一组卡片写的字照设计稿", () => {
  const view = groupView(group(), { tz: TZ, now: NOW });
  assert.equal(view.heading, "「主力上游」这一组");
  assert.equal(view.count, "3 个上游");
  assert.equal(view.mergeLine, "「主力上游（2）」「主力上游·备用」并进「主力上游」");
  assert.equal(view.whyLine, "留下的是最早加的那个（10月3日 加的，余额历史最长）；名字以后可以在编辑上游里改。地址 api.example.com、账号 ID 1024 都一样。");
  assert.equal(view.times, "同一个账号原来算了 3 遍");
  assert.equal(view.estimateNote, null);
  assert.equal(view.afterMerge, "被合掉的从上游列表里消失，不再单独读余额；它们的登录信息、余额历史都留着。绑定改到「主力上游」上，每日利润不变。");
  assert.equal(view.confirm.title, "合并「主力上游」这一组？");
  assert.deepEqual(view.confirm.lines, [
    "「主力上游（2）」「主力上游·备用」会并进「主力上游」：它们从上游列表里消失，不再单独读余额；登录信息、余额历史都留着。",
    "绑定改到「主力上游」上，每日利润不变。成本估算近 30 天从 ¥13,982.40 变成 ¥4,660.80，不再重复算。",
  ]);
  assert.equal(view.confirm.hint, "合错了可以在「合并记录」里退回。");
});

test("成本估算算不出：两行写「—」，下面一句，确认框里不写前后的数", () => {
  const view = groupView(group({ estimate: null }), { tz: TZ, now: NOW });
  assert.deepEqual(view.rows.map((r) => [r.before, r.after]), [["—", "—"], ["—", "—"]]);
  assert.equal(view.estimateNote, "成本估算暂时算不出，合并照样能做");
  assert.equal(view.confirm.lines.length, 2);
  assert.doesNotMatch(view.confirm.lines[1], /成本估算/);
});

test("合不了的原因：同一把 Key 撞了写清是哪把 Key、哪两个上游，并有「处理重复」", () => {
  const conflict = { code: "RULE_KEY_CONFLICT", tokenId: 5, tokenName: "oai", ruleId: "r9", stationIds: ["a", "b"], detail: "" };
  const blocked = group({ merged: [{ id: "b", name: "主力上游（2）" }], blockers: [conflict], canMerge: false });
  const view = groupView(blocked, { tz: TZ, now: NOW });
  assert.deepEqual(view.blocked, ["「主力上游」和「主力上游（2）」下都绑了 Key「oai」，合成一个以后这把 Key 会算两次。先在需处理里处理「这把 Key 绑了两次」那一条，再回来合。"]);
  assert.equal(view.conflict.label, "处理重复");
  assert.equal(view.conflict.href, "/stations?action=conflict&ruleId=r9");
  assert.equal(conflictAction(group()), null);
  assert.match(blockerText({ code: "RULE_KEY_CONFLICT", tokenId: 5, tokenName: null, stationIds: ["a", "b"] }, { nameOf: (id) => id, group: blocked }), /Key「Key #5」/);
});

test("别的几种合不了：写清哪几个上游、怎么办；没有「处理重复」", () => {
  const other = group({ blockers: [{ code: "MONITOR_MISMATCH", detail: "" }, { code: "PROFIT_MISMATCH", detail: "" }, { code: "MERGED_HAS_FIXED_COST", detail: "主力上游（2） 有固定成本或转售记录" }], canMerge: false });
  const view = groupView(other, { tz: TZ, now: NOW });
  assert.equal(view.blocked[0], "「主力上游」「主力上游（2）」「主力上游·备用」里有的在监控、有的暂停了。先让它们一样，再回来合。");
  assert.equal(view.blocked[1], "「主力上游」「主力上游（2）」「主力上游·备用」里有的算进利润、有的不算。先让它们一样，再回来合。");
  assert.equal(view.blocked[2], "主力上游（2） 有固定成本或转售记录，合并不会带走它们。先处理掉，再回来合。");
  assert.equal(view.conflict, null);
});

test("合并记录一行、已退回、退回不了、退回的确认框", () => {
  const record = { mergeId: "mg_1", mergedAtMs: Date.parse("2026-10-20T01:12:00Z"), undoneAtMs: null, retained: { id: "a", name: "Key 计费站" }, merged: [{ id: "b", name: "Key 计费站（2）" }], undoable: true, undoBlocked: null };
  const view = recordView(record, { tz: TZ, now: NOW });
  assert.equal(view.when, "10月20日 9:12");
  assert.equal(view.text, "「Key 计费站（2）」并进「Key 计费站」");
  assert.equal(view.undone, null);
  assert.equal(view.confirm.title, "退回这次合并？");
  assert.deepEqual(view.confirm.lines, ["「Key 计费站（2）」回到上游列表，接着各自读余额；成本估算又会把这个账号算两遍。"]);
  assert.equal(view.confirm.hint, "合并以后在「Key 计费站」上加的绑定和改的设置，留在「Key 计费站」上，不跟着走。");
  assert.equal(recordView({ ...record, undoneAtMs: Date.parse("2026-10-20T07:10:00Z"), undoable: false }, { tz: TZ, now: NOW }).undone, "已退回（10月20日 15:10）");
  assert.equal(recordView({ ...record, undoable: false, undoBlocked: { code: "UPSTREAM_DELETED", detail: "「Key 计费站（2）」已经删了，退回不了" } }, { tz: TZ, now: NOW }).blocked, "「Key 计费站（2）」已经删了，退回不了");
});

test("没成时的一句：原因后面固定写「什么都没改。」", () => {
  assert.equal(mergeFailureText("合并", "这条已经变了，刷新后再看。"), "合并没成：这条已经变了，刷新后再看。什么都没改。");
  assert.equal(mergeFailureText("退回", "没存上，请稍后再试"), "退回没成：没存上，请稍后再试。什么都没改。");
});
