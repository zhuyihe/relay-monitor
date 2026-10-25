import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COVERAGE_ANSWERS,
  COVERAGE_QUESTION,
  INCOMPLETE_DAY_TEXT,
  RECONCILIATION_BILLING_SOURCE,
  RECONCILIATION_CALCULATION_VERSION,
  RECONCILIATION_ISSUE_CODES,
  RECONCILIATION_ISSUE_PRIORITY,
  RECONCILIATION_SETTLE_DELAY_MS,
  coverageAnswerOption,
  coverageDeclarationOf,
  fillIssueCopy,
  isCurrentReconciliationBillingContract,
  isLiveReconciliationPreset,
  isScopedBillingPolicy,
  normalizeSuccessfulResult,
  reconciliationAccountingStart,
  reconciliationChannelStatus,
  reconciliationCoverageText,
  reconciliationIssue,
  reconciliationIssueLabel,
  sameReconciliationWindow,
} from "./reconciliation-contract.js";
import { HISTORY_KEPT, DESTINATION_CHANGED, WORKFLOW_ACTION_KINDS, testReadText, workflowAction, workflowActionMeta } from "./workflow-actions.js";
import { ERROR_CATEGORIES, describeError } from "./error-copy.js";
import {
  FIXED_COST_TEXT,
  NOTHING_TO_HANDLE,
  OWN_STATION_UNSET,
  OWN_STATION_UNSET_HINT,
  OWN_STATION_UNSET_TITLE,
  RATE_UNSET_PARITY,
  RATE_UNSET_USD,
  refreshFailedText,
} from "./format.js";

// 固定时刻：上海 10月9日 13:00
const NOW = Date.parse("2026-10-09T05:00:00Z");
// 填文案用的示例参数
const SAMPLE = { time: "14:30", start: "10月9日 14:30", channel: "出口一", count: 3 };
const RETIRED = ["STALE", "GROUP_OR_RATIO_CHANGED", "BILLING_WINDOW_UNCONFIRMED", "OWN_FLOW_INCOMPLETE"];
const CHANNEL_STATUSES = ["accounted", "bound", "unlinked", "not_effective", "duplicate", "source_unverified", "coverage_unknown", "billing_missing", "monitor_only", "unsupported"];
const chars = (text) => [...text].length;
const label = (kind) => workflowActionMeta(kind)?.label;

test("§5.2 需处理：标题、说明、按钮和表里一字不差", () => {
  const table = {
    KEY_INVALID_OR_DENIED: ["上游拒绝读取这把 Key", "Key 可能已被删除，或上游的登录信息过期了", "更新登录信息"],
    SOURCE_BINDING_UNCONFIRMED: ["上游账号或自营站点有变化", "确认这条绑定还对应原来的账号和渠道，利润才会接着算", "去确认"],
    COST_OWNER_UNVERIFIED: ["还没确认这把 Key 属于哪个上游账号", "测试读取一次就好", "测试读取"],
    LEGACY_IDENTITY_UNVERIFIED: ["还没确认这把 Key 属于哪个上游账号", "测试读取一次就好", "测试读取"],
    UPSTREAM_CAPABILITY_UNVERIFIED: ["还没确认能读到这个上游的完整账单", "测试读取一次就好", "测试读取"],
    BILLING_TIMEZONE_UNVERIFIED: ["还没确认这个上游按哪个时区算一天", "测试读取一次就好", "测试读取"],
    CANONICAL_KEY_CONFLICT: ["这把 Key 绑了两次", "同一把 Key 的上游成本只能算一次，去掉多余的那条", "处理重复"],
    DUPLICATE_CHANNEL_ASSIGNMENT: ["渠道「出口一」同时绑了两把 Key", "同一个渠道的收入只能算一次，去掉多余的那条", "处理重复"],
    COST_COVERAGE_UNKNOWN: ["这把 Key 还给别处用吗？", "别处也在用的话，上游成本会算多；回答之前，利润先不算", "去回答"],
  };
  for (const [code, [title, detail, button]] of Object.entries(table)) {
    const issue = reconciliationIssue(code);
    assert.deepEqual([issue.kind, issue.known, fillIssueCopy(issue.title, issue.plain, SAMPLE), issue.detail, label(issue.action)],
      ["action", true, title, detail, button], code);
  }
  assert.equal(reconciliationIssue("DUPLICATE_CHANNEL_ASSIGNMENT").plain, "有渠道同时绑了两把 Key", "不知道是哪个渠道时");
  assert.equal(reconciliationIssue("COST_COVERAGE_UNKNOWN").title, COVERAGE_QUESTION, "问题标题和填写处的问题共用一句");
  assert.equal(COVERAGE_QUESTION, "这把 Key 还给别处用吗？");
});

test("§5.3 读取类：实时时的提示、7 天后的标题和按钮和表里一字不差", () => {
  const table = {
    PENDING: ["读取中", "这天的账单一直没读到", "重新读取"],
    WAITING_FOR_BILL: ["这天的账单还没读全", "这天的账单一直没读全", "重新读取"],
    HISTORY_UNAVAILABLE: ["固定账暂时读不到，请稍后重新读取", "固定账一直读不到，请重新读取", "重新读取"],
    UPSTREAM_DATA_UNAVAILABLE: ["上游暂时读不到，系统会自动再读", "上游这天的用量记录一直读不到", "重新读取"],
    OWN_BILLING_UNAVAILABLE: ["自营站点暂时读不到，系统会自动再读", "自营站点这天的收费记录一直读不到", "重新读取"],
    // 上游、自营站点哪一侧的日期对不上都会报这个码，所以不写「上游」
    BILLING_WINDOW_MISMATCH: ["读到的日期和这天对不上，系统会再读", "读到的日期一直和这天对不上", "重新读取"],
    // 表里的标题「有收入，但上游一直没有用量记录；可能绑错了 Key」拆成标题和说明，标题才不超过 20 个字
    UPSTREAM_EMPTY_WITH_SALES: ["有收入，但上游的用量还没到", "有收入，但上游一直没有用量记录；可能绑错了 Key", "改绑定"],
    PERSISTENCE_FAILED: ["这次结果没存上，系统会再存", "这天的结果一直没存上", "重新读取"],
  };
  for (const [code, [hint, title, button]] of Object.entries(table)) {
    const issue = reconciliationIssue(code);
    assert.deepEqual([issue.kind, issue.hint, [issue.title, issue.detail].filter(Boolean).join("；"), label(issue.action)], ["reading", hint, title, button], code);
  }
});

test("§5.4 提示类：一句提示、渠道名旁的标签、倍率格的话，不显示的码没有文案", () => {
  const shown = (code) => {
    const issue = reconciliationIssue(code);
    return { kind: issue.kind, display: issue.display !== false, hint: fillIssueCopy(issue.hint, issue.plain, SAMPLE), plain: issue.plain || "",
      tag: issue.tag || "", ratio: issue.ratio || "", button: issue.action ? label(issue.action) : "" };
  };
  const base = { kind: "hint", display: true, hint: "", plain: "", tag: "", ratio: "", button: "" };
  assert.deepEqual(shown("READY"), { ...base, display: false });
  assert.deepEqual(shown("ROUTE_TRANSITION_DETECTED"), { ...base, hint: "倍率在 14:30 变了，这天分两段算", plain: "倍率变了，这天分两段算" });
  assert.deepEqual(shown("SEGMENT_TIMING_UNCONFIRMED"), { ...base, hint: "倍率变化的时间是系统估的", button: "改时间" });
  assert.deepEqual(shown("BILLING_SCOPE_NOT_EFFECTIVE"), { ...base, hint: "从 10月9日 14:30 开始统计", plain: "还没开始统计" });
  assert.deepEqual(shown("SALES_CHANNEL_MISSING"), { ...base, tag: "已删除", hint: "渠道「出口一」在自营站点里已删除，不用了就从绑定里去掉",
    plain: "有渠道在自营站点里已删除，不用了就从绑定里去掉", button: "改绑定" });
  assert.deepEqual(shown("SALES_CHANNEL_DISABLED"), { ...base, tag: "已停用" });
  assert.deepEqual(shown("SALES_CHANNEL_STATE_UNKNOWN"), { ...base, display: false });
  assert.deepEqual(shown("GROUP_DATA_UNAVAILABLE"), { ...base, ratio: "暂时读不到" });
});

test("§5.5 旧码统一说「这天的数据不完整」，归读取类；不认识的码按需处理显示「这条暂时算不出利润」和「刷新」", () => {
  assert.equal(INCOMPLETE_DAY_TEXT, "这天的数据不完整");
  for (const code of RETIRED) {
    const issue = reconciliationIssue(code);
    assert.deepEqual([issue.kind, issue.known, issue.hint, issue.title, label(issue.action)], ["reading", true, INCOMPLETE_DAY_TEXT, INCOMPLETE_DAY_TEXT, "重新读取"], code);
    assert.equal(reconciliationIssueLabel(code), INCOMPLETE_DAY_TEXT);
  }
  for (const code of ["SOMETHING_NEW", "", null, undefined]) {
    const issue = reconciliationIssue(code);
    assert.deepEqual([issue.kind, issue.known, issue.title, label(issue.action), issue.priority, issue.push],
      ["action", false, "这条暂时算不出利润", "刷新", Infinity, false], String(code));
  }
  assert.equal(reconciliationIssue("SOMETHING_NEW").code, "SOMETHING_NEW", "码只交给调用方写进控制台");
  assert.equal(reconciliationIssue(null).code, "");
});

test("每个码都有文案和种类；按钮都在动作表里；需处理的标题不超过 20 个字、不带句号（§5.1、§12.6）", () => {
  assert.equal(RECONCILIATION_ISSUE_CODES.length, 32); // C2b 加了 RESETTLE_SHRUNK、RESETTLE_TOO_OLD
  for (const code of RECONCILIATION_ISSUE_CODES) {
    const issue = reconciliationIssue(code);
    assert.ok(["action", "reading", "hint"].includes(issue.kind), code);
    assert.equal(issue.known, true, code);
    if (issue.action) assert.ok(WORKFLOW_ACTION_KINDS.includes(issue.action), `${code} 的按钮 ${issue.action} 不在动作表里`);
    if (issue.kind !== "hint") {
      assert.ok(issue.action, `${code} 需处理时要有一个按钮`);
      for (const title of [fillIssueCopy(issue.title, issue.plain, SAMPLE), issue.plain].filter(Boolean)) {
        assert.ok(chars(title) <= 20, `${code} 的标题超过 20 个字：${title}`);
        assert.doesNotMatch(title, /。$/, code);
      }
    }
    if (issue.kind === "reading") assert.ok(issue.hint, `${code} 实时时要有一句提示`);
    if (issue.kind === "hint" && issue.display !== false) assert.ok(issue.hint || issue.tag || issue.ratio, `${code} 要显示就得有文案`);
  }
});

test("优先级表覆盖全部码，需处理在前、读取类在中、提示类在后，旧码排在读取类末尾，READY 最后", () => {
  assert.equal(new Set(RECONCILIATION_ISSUE_PRIORITY).size, RECONCILIATION_ISSUE_PRIORITY.length, "没有重复");
  assert.deepEqual([...RECONCILIATION_ISSUE_PRIORITY].sort(), [...RECONCILIATION_ISSUE_CODES].sort());
  const kinds = RECONCILIATION_ISSUE_PRIORITY.map((code) => reconciliationIssue(code).kind);
  const rank = { action: 0, reading: 1, hint: 2 };
  assert.deepEqual(kinds.map((kind) => rank[kind]), [...kinds.map((kind) => rank[kind])].sort((a, b) => a - b));
  const reading = RECONCILIATION_ISSUE_PRIORITY.filter((code) => reconciliationIssue(code).kind === "reading");
  assert.deepEqual(reading.slice(-RETIRED.length), RETIRED);
  assert.equal(RECONCILIATION_ISSUE_PRIORITY.at(-1), "READY");
  RECONCILIATION_ISSUE_PRIORITY.forEach((code, index) => assert.equal(reconciliationIssue(code).priority, index, code));
});

test("推送只标原来那几种", () => {
  assert.deepEqual(RECONCILIATION_ISSUE_CODES.filter((code) => reconciliationIssue(code).push).sort(),
    ["KEY_INVALID_OR_DENIED", "OWN_BILLING_UNAVAILABLE", "PERSISTENCE_FAILED", "SALES_CHANNEL_MISSING", "UPSTREAM_DATA_UNAVAILABLE"]);
});

test("填 {time} {start} {channel}：有一个填不上就用不带名字的那一句，也没有就不显示", () => {
  assert.equal(fillIssueCopy("倍率在 {time} 变了", "倍率变了", { time: "14:30" }), "倍率在 14:30 变了");
  assert.equal(fillIssueCopy("倍率在 {time} 变了", "倍率变了", {}), "倍率变了");
  assert.equal(fillIssueCopy("倍率在 {time} 变了", "倍率变了", { time: "" }), "倍率变了");
  assert.equal(fillIssueCopy("从 {start} 开始统计", undefined, {}), "");
  assert.equal(fillIssueCopy("有 {count} 个渠道", "有渠道", { count: 0 }), "有 0 个渠道", "0 是填得上的值");
  assert.equal(fillIssueCopy("{a} 和 {b}", "两个", { a: "甲" }), "两个");
  assert.equal(fillIssueCopy("{a} 和 {b}", "两个", { a: "甲", b: 2 }), "甲 和 2");
  assert.equal(fillIssueCopy("", "备用", {}), "");
  assert.equal(fillIssueCopy("没有占位", "备用"), "没有占位");
});

test("服务端 health.label：读取类用提示，提示类用不带名字的一句或标签，需处理用不带名字的一句或标题", () => {
  assert.equal(reconciliationIssueLabel("WAITING_FOR_BILL"), "这天的账单还没读全");
  assert.equal(reconciliationIssueLabel("READY"), "");
  assert.equal(reconciliationIssueLabel("SALES_CHANNEL_STATE_UNKNOWN"), "");
  assert.equal(reconciliationIssueLabel("ROUTE_TRANSITION_DETECTED"), "倍率变了，这天分两段算");
  assert.equal(reconciliationIssueLabel("SEGMENT_TIMING_UNCONFIRMED"), "倍率变化的时间是系统估的");
  assert.equal(reconciliationIssueLabel("SALES_CHANNEL_MISSING"), "有渠道在自营站点里已删除，不用了就从绑定里去掉");
  assert.equal(reconciliationIssueLabel("SALES_CHANNEL_DISABLED"), "已停用");
  assert.equal(reconciliationIssueLabel("GROUP_DATA_UNAVAILABLE"), "暂时读不到");
  assert.equal(reconciliationIssueLabel("BILLING_SCOPE_NOT_EFFECTIVE"), "还没开始统计", "没有开始统计的时刻就说不带时刻的那一句");
  assert.equal(reconciliationIssueLabel("DUPLICATE_CHANNEL_ASSIGNMENT"), "有渠道同时绑了两把 Key");
  assert.equal(reconciliationIssueLabel("KEY_INVALID_OR_DENIED"), "上游拒绝读取这把 Key");
  assert.equal(reconciliationIssueLabel("SOMETHING_NEW"), "这条暂时算不出利润");
});

test("§5.6 渠道列表里的状态：需处理时原因取最要紧的一条要处理的问题", () => {
  const status = (name, params, issues) => {
    const entry = reconciliationChannelStatus(name, params, issues);
    return [entry.label, entry.reason, !!entry.counted, !!entry.needsAction, entry.action || null];
  };
  assert.deepEqual(status("accounted"), ["已算进利润", "", true, false, null]);
  assert.deepEqual(status("bound"), ["已绑定", "", false, false, null], "配置绑定不能当成已纳入某一天的利润");
  assert.deepEqual(status("unlinked"), ["没绑定", "", false, false, "connect_channels"]);
  assert.equal(label(reconciliationChannelStatus("unlinked").action), "去绑定");
  assert.deepEqual(status("not_effective", { start: "10月9日 14:30" }), ["从 10月9日 14:30 开始统计", "", false, false, null]);
  assert.deepEqual(status("not_effective"), ["还没开始统计", "", false, false, null]);
  assert.deepEqual(status("billing_missing", {}, ["WAITING_FOR_BILL", "KEY_INVALID_OR_DENIED"]), ["还在读取", "", false, false, null], "不是需处理就不带原因");
  assert.deepEqual(status("monitor_only"), ["只看余额", "", false, false, null]);
  assert.deepEqual(status("unsupported"), ["读不到账单", "", false, false, null]);
  for (const name of ["duplicate", "source_unverified", "coverage_unknown", "something_new"]) assert.deepEqual(status(name), ["需处理", "", false, true, null], name);
  // 两个都是要处理的：CANONICAL_KEY_CONFLICT 排在 DUPLICATE_CHANNEL_ASSIGNMENT 前面；读取类不算原因
  assert.equal(reconciliationChannelStatus("duplicate", {}, ["WAITING_FOR_BILL", "DUPLICATE_CHANNEL_ASSIGNMENT", "CANONICAL_KEY_CONFLICT"]).reason, "这把 Key 绑了两次");
  assert.equal(reconciliationChannelStatus("duplicate", { channel: "出口一" }, ["DUPLICATE_CHANNEL_ASSIGNMENT"]).reason, "渠道「出口一」同时绑了两把 Key");
  assert.equal(reconciliationChannelStatus("duplicate", {}, ["DUPLICATE_CHANNEL_ASSIGNMENT"]).reason, "有渠道同时绑了两把 Key");
  assert.equal(reconciliationChannelStatus("coverage_unknown", {}, ["COST_COVERAGE_UNKNOWN"]).reason, COVERAGE_QUESTION);
  assert.equal(reconciliationChannelStatus("duplicate", {}, ["WAITING_FOR_BILL"]).reason, "");
  assert.equal(reconciliationChannelStatus("source_unverified", {}, ["SOMETHING_NEW"]).reason, "这条暂时算不出利润", "不认识的码也按需处理说");
});

test("§5.6 渠道汇总一句", () => {
  assert.equal(reconciliationCoverageText({ knownChannelCount: 5, accountedChannelCount: 4 }), "5 个渠道里 4 个已算进利润");
  assert.equal(reconciliationCoverageText({ knownChannelCount: 5, accountedChannelCount: 5 }), "5 个渠道都已算进利润");
  assert.equal(reconciliationCoverageText({ knownChannelCount: "3", accountedChannelCount: "0" }), "3 个渠道里 0 个已算进利润");
  assert.equal(reconciliationCoverageText({ knownChannelCount: 0, accountedChannelCount: 0 }), "");
  assert.equal(reconciliationCoverageText({ knownChannelCount: 3 }), "");
  assert.equal(reconciliationCoverageText(null), "");
});

test("§5.2「去回答」的选项：一张表，回答和选项互相找得到", () => {
  assert.deepEqual(COVERAGE_ANSWERS.map((item) => item.label),
    ["只给这些渠道用", "自营站点的其他渠道也在用", "站外也在用（测试、自用、给别人）", "别处也在用，说不清是哪", "不确定"]);
  assert.deepEqual(COVERAGE_ANSWERS.map((item) => [item.answer, item.otherUse]),
    [["none", null], ["other_use", "own_channels"], ["other_use", "external"], ["other_use", "unspecified"], ["unknown", null]]);
  for (const option of COVERAGE_ANSWERS) assert.equal(coverageAnswerOption(coverageDeclarationOf(option.value, [1])), option, option.value);
  assert.equal(coverageAnswerOption({ answer: "other_use" }).value, "unspecified", "没写是哪就是说不清");
  assert.equal(coverageAnswerOption({ answer: "bogus" }), null);
  assert.equal(coverageAnswerOption(null), null);
  assert.deepEqual(coverageDeclarationOf("own_channels", ["3", 3, 4]), { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [3, 4] });
  assert.deepEqual(coverageDeclarationOf("external", [1]), { answer: "other_use", otherUse: "external", uncoveredOwnChannelIds: [] }, "只有自营站点的其他渠道才带渠道");
  assert.deepEqual(coverageDeclarationOf("none"), { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
  assert.equal(coverageDeclarationOf("bogus"), null);
});

test("当前账单来源、实时预设、开始统计的规则和起点", () => {
  assert.equal(RECONCILIATION_SETTLE_DELAY_MS, 15 * 60000);
  for (const preset of ["today", "7d", "month"]) assert.equal(isLiveReconciliationPreset(preset), true, preset);
  for (const preset of ["yesterday", "custom", "", undefined]) assert.equal(isLiveReconciliationPreset(preset), false, String(preset));
  const current = { billingSource: RECONCILIATION_BILLING_SOURCE, calculationVersion: RECONCILIATION_CALCULATION_VERSION };
  assert.equal(isCurrentReconciliationBillingContract(current), true);
  assert.equal(isCurrentReconciliationBillingContract({ downstream: current }), true, "旧结果把来源写在收入一侧");
  assert.equal(isCurrentReconciliationBillingContract({ ...current, calculationVersion: "3" }), true);
  assert.equal(isCurrentReconciliationBillingContract({ ...current, calculationVersion: 2 }), false);
  assert.equal(isCurrentReconciliationBillingContract({ ...current, billingSource: "log" }), false);
  assert.equal(isCurrentReconciliationBillingContract(null), false);

  assert.equal(isScopedBillingPolicy("immediate"), true);
  assert.equal(isScopedBillingPolicy("next-complete-day"), true);
  assert.equal(isScopedBillingPolicy("legacy"), false);
  const from = Date.parse("2026-10-08T06:30:00Z");
  assert.equal(reconciliationAccountingStart({ billingPolicy: "immediate", billingEffectiveFrom: from }), from);
  assert.equal(reconciliationAccountingStart({ billingPolicy: "immediate", billingEffectiveFrom: from, createdAt: "2026-10-08T02:00:00Z" }), Date.parse("2026-10-08T02:00:00Z"), "改绑定不推迟起点");
  assert.equal(reconciliationAccountingStart({ billingPolicy: "next-complete-day", createdAt: "2026-10-08T02:00:00Z" }), Date.parse("2026-10-08T02:00:00Z"));
  assert.equal(reconciliationAccountingStart({ billingPolicy: "immediate", createdAt: "bad" }), null);
  assert.equal(reconciliationAccountingStart({ billingPolicy: "legacy", billingEffectiveFrom: from }), null);
  assert.equal(reconciliationAccountingStart(null), null);
});

test("早期只存了差额的成功记录：READY 时差额就是毛利，否则只是参考差额", () => {
  const already = { calculation: { profitUsd: 1 } };
  assert.equal(normalizeSuccessfulResult(already, "READY"), already);
  const noCalculation = { health: { code: "READY" } };
  assert.equal(normalizeSuccessfulResult(noCalculation, "READY"), noCalculation);
  assert.deepEqual(normalizeSuccessfulResult({ health: { code: "READY" }, calculation: { differenceUsd: 2, marginRate: 0.5 } }).calculation,
    { differenceUsd: 2, marginRate: 0.5, profitUsd: 2, riskDifferenceUsd: null });
  assert.deepEqual(normalizeSuccessfulResult({ calculation: { differenceUsd: 2 } }, "READY").calculation,
    { differenceUsd: 2, marginRate: null, profitUsd: 2, riskDifferenceUsd: null }, "没有健康码时用传进来的");
  assert.deepEqual(normalizeSuccessfulResult({ health: { code: "WAITING_FOR_BILL" }, calculation: { differenceUsd: 2, marginRate: 0.5 } }, "READY").calculation,
    { differenceUsd: 2, marginRate: null, profitUsd: null, riskDifferenceUsd: 2 }, "结果里的健康码优先");
  assert.deepEqual(normalizeSuccessfulResult({ health: { code: "READY" }, calculation: { differenceUsd: null } }).calculation,
    { differenceUsd: null, marginRate: null, profitUsd: null, riskDifferenceUsd: null });
});

test("lib/format.js 的共用文案", () => {
  assert.equal(NOTHING_TO_HANDLE, "没有需要处理的事。");
  assert.equal(FIXED_COST_TEXT, "计入固定成本");
  assert.equal(OWN_STATION_UNSET, "还没设置自营站点：在上游资源里编辑你的 New API 站点，打开「这是我的自营站点」。");
  assert.equal(refreshFailedText("2026-10-09T04:00:00Z", "Asia/Shanghai", NOW), "刷新失败，数据截至 12:00。");
  assert.equal(refreshFailedText(null, "Asia/Shanghai", NOW), "刷新失败");
});

// ---- §12.6 文案守卫：每个码、动作、报错类别的文案都过一遍 §3.6 ----

// tests/ui-copy-guard.test.mjs 的禁用词表加上 §3.6 里它还没收的词，和 §8.1 不许写的空话
const GUARD_SOURCE = readFileSync(new URL("../tests/ui-copy-guard.test.mjs", import.meta.url), "utf8");
const SCANNED = [...GUARD_SOURCE.slice(GUARD_SOURCE.indexOf("const FORBIDDEN = ["), GUARD_SOURCE.indexOf("];", GUARD_SOURCE.indexOf("const FORBIDDEN = ["))).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const BANNED = [...new Set([...SCANNED,
  "关联", "范围", "补结", "区间", "切换", "路由变化", "待生效", "命名空间", "验证", "授权", "金额参考", "参考差额", "风险差额",
  "当前显示上次结果", "最近检查", "最近同步", "结果生成", "读取时间", "重试次数", "目录", "发现", "预测方法", "资源", "站点",
  "消耗", "消费", "同步", "重读", "重试", "未知错误", "出错了", "服务器错误",
])];
// 只当状态标签时不用（§3.6「不标」），句子里可以有，例如「完整账单」
const BANNED_LABELS = ["数据正常", "已核验", "有效", "完整", "已取全"];
// 本文里明写可以用的词：先去掉再查（§3.1 列表页叫「上游资源」，§3.7 的填写项和后台开关名，§8.1、§8.2 的原句）
const ALLOWED_PHRASES = ["自营站点", "站点地址", "上游资源", "New API 站点", "人机验证", "两步验证", "数据看板"];
const ALLOWED_LATIN = /New API|Sub2API|Key|ID|Token/g;

function copyHits(source, text) {
  if (typeof text !== "string") return [`${source}：不是文字（${typeof text}）`];
  if (!text.trim()) return [`${source}：空`];
  const plain = ALLOWED_PHRASES.reduce((value, phrase) => value.replaceAll(phrase, ""), text);
  const hits = BANNED.filter((word) => plain.includes(word)).map((word) => `「${word}」`);
  if (BANNED_LABELS.includes(text)) hits.push(`标签「${text}」`);
  if (/[A-Za-z]/.test(plain.replace(ALLOWED_LATIN, ""))) hits.push("英文字母");
  if (/\/api\//.test(text)) hits.push("接口路径");
  // 后面跟「端口」的是端口号（「请改用 465 端口」），不算状态码
  if (/\b[45]\d\d\b(?! ?端口)/.test(text)) hits.push("HTTP 状态码");
  if (/\d{4}-\d{2}-\d{2}/.test(text)) hits.push("ISO 日期");
  if (/[{}]/.test(text)) hits.push("没填的占位");
  return hits.length ? [`${source}：${text} → ${hits.join("、")}`] : [];
}

// 页面上会出现的全部文字：问题表、渠道状态、去回答、按钮和完成提示、报错归类、format.js 的共用句子
function collectCopy() {
  const entries = [];
  const add = (source, text) => entries.push([source, text]);
  for (const code of [...RECONCILIATION_ISSUE_CODES, "SOMETHING_NEW"]) {
    const issue = reconciliationIssue(code);
    if (issue.kind === "hint" && issue.display === false) continue;
    if (issue.title) add(`${code}.title`, fillIssueCopy(issue.title, issue.plain, SAMPLE));
    if (issue.hint) add(`${code}.hint`, fillIssueCopy(issue.hint, issue.plain, SAMPLE));
    for (const field of ["plain", "detail", "tag", "ratio"]) if (issue[field]) add(`${code}.${field}`, issue[field]);
    if (code !== "SOMETHING_NEW" && reconciliationIssueLabel(code)) add(`${code}.label`, reconciliationIssueLabel(code));
  }
  for (const name of CHANNEL_STATUSES) {
    add(`channel.${name}`, reconciliationChannelStatus(name, { start: SAMPLE.start }).label);
    add(`channel.${name}.plain`, reconciliationChannelStatus(name).label);
  }
  add("coverage.partial", reconciliationCoverageText({ knownChannelCount: 5, accountedChannelCount: 4 }));
  add("coverage.all", reconciliationCoverageText({ knownChannelCount: 5, accountedChannelCount: 5 }));
  for (const option of COVERAGE_ANSWERS) add(`answer.${option.value}`, option.label);
  add("INCOMPLETE_DAY_TEXT", INCOMPLETE_DAY_TEXT);
  for (const kind of WORKFLOW_ACTION_KINDS) {
    const meta = workflowActionMeta(kind);
    add(`${kind}.label`, meta.label);
    for (const field of ["done", "detail", "plain"]) if (meta[field]) add(`${kind}.${field}`, meta[field]);
    const action = workflowAction(kind, { stationId: "up", ruleId: "r1", ownStationId: "own", channelIds: [1, 2, 3] }, { params: SAMPLE });
    if (action.title) add(`${kind}.title`, action.title);
    if (action.detail) add(`${kind}.title.detail`, action.detail);
  }
  add("HISTORY_KEPT", HISTORY_KEPT);
  add("DESTINATION_CHANGED", DESTINATION_CHANGED);
  add("testRead.balance", testReadText({ ok: true, balance: "$123" }));
  add("testRead.bill", testReadText({ ok: true }));
  add("testRead.reachable", testReadText({ ok: true, bill: false }));
  add("testRead.failed", testReadText({ ok: false }));
  for (const [category, entry] of Object.entries(ERROR_CATEGORIES)) add(`error.${category}`, entry.text);
  for (const code of errorCodes()) {
    const described = describeError({ code });
    add(`error.${code}`, described.text);
    if (described.actionLabel) add(`error.${code}.button`, described.actionLabel);
  }
  for (const [name, text] of Object.entries({ NOTHING_TO_HANDLE, FIXED_COST_TEXT, RATE_UNSET_USD, RATE_UNSET_PARITY, OWN_STATION_UNSET_TITLE, OWN_STATION_UNSET_HINT, OWN_STATION_UNSET })) add(name, text);
  add("refreshFailedText", refreshFailedText("2026-10-09T04:00:00Z", "Asia/Shanghai", NOW));
  return entries;
}

// lib/error-copy.js 的 CODES 别的改动还在加码：从文件里现读码名，不在这里抄一份
function errorCodes() {
  const source = readFileSync(new URL("./error-copy.js", import.meta.url), "utf8");
  const start = source.indexOf("const CODES = Object.freeze({");
  const body = source.slice(start, source.indexOf("\n});", start));
  return [...new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*:/g)].map((match) => match[1]))];
}

test("§12.6 文案守卫：问题码、动作、报错类别和共用句子里没有 §3.6 的词和英文代码", () => {
  assert.ok(SCANNED.length > 40, "读到了 tests/ui-copy-guard.test.mjs 的禁用词表");
  assert.ok(errorCodes().length > 40, "读到了 lib/error-copy.js 的错误码");
  const entries = collectCopy();
  assert.ok(entries.length > 150);
  assert.deepEqual(entries.flatMap(([source, text]) => copyHits(source, text)), []);
});

test("§12.6 文案守卫自己认得出违规", () => {
  assert.deepEqual(copyHits("t", "核算结果已生效"), ["t：核算结果已生效 → 「核算」、「生效」"]);
  assert.deepEqual(copyHits("t", "上游站点读不到"), ["t：上游站点读不到 → 「站点」"]);
  assert.deepEqual(copyHits("t", "完整"), ["t：完整 → 标签「完整」"]);
  assert.deepEqual(copyHits("t", "READY"), ["t：READY → 英文字母"]);
  assert.deepEqual(copyHits("t", "按 USD 显示"), ["t：按 USD 显示 → 英文字母"]);
  assert.deepEqual(copyHits("t", "返回 401"), ["t：返回 401 → HTTP 状态码"]);
  assert.deepEqual(copyHits("t", "请改用 465 端口"), []);
  assert.deepEqual(copyHits("t", "渠道「{channel}」"), ["t：渠道「{channel}」 → 英文字母、没填的占位"]);
  assert.deepEqual(copyHits("t", ""), ["t：空"]);
  assert.deepEqual(copyHits("t", "自营站点没开数据看板，请到 New API 后台打开"), []);
  assert.deepEqual(copyHits("t", "还没确认能读到这个上游的完整账单"), []);
  assert.deepEqual(copyHits("t", "上游拒绝读取这把 Key"), []);
});

// 码表是普通对象：Object.prototype 上的名字也被当成认得的码
test("Object.prototype 上的名字不算认得的码", () => {
  for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const issue = reconciliationIssue(code);
    assert.deepEqual([issue.known, issue.kind, issue.title], [false, "action", "这条暂时算不出利润"], code);
  }
});

test("两段窗口是不是同一段：起点、时区、终点；实时预设按请求比时只看预设", () => {
  const start = Date.parse("2026-10-08T16:00:00Z");
  const live = (endMs) => ({ preset: "today", startMs: start, endMs, timezone: "Asia/Shanghai" });
  const day = { preset: "custom", startMs: start, endMs: start + 86400000, timezone: "Asia/Shanghai" };
  // 默认：起止、时区名都要相同，不看预设
  assert.equal(sameReconciliationWindow(day, { ...day, preset: "yesterday" }), true);
  assert.equal(sameReconciliationWindow(day, { ...day, endMs: day.endMs - 1 }), false);
  assert.equal(sameReconciliationWindow(day, { ...day, startMs: start + 1 }), false);
  assert.equal(sameReconciliationWindow(day, { ...day, timezone: "UTC" }), false);
  assert.equal(sameReconciliationWindow(day, { ...day, timezone: "asia/shanghai" }), false, "默认按名字比");
  assert.equal(sameReconciliationWindow(live(start + 1000), live(start + 2000)), false, "默认比终点");
  assert.equal(sameReconciliationWindow(null, day), false);
  assert.equal(sameReconciliationWindow(day, undefined), false);
  // timezone: "canonical" 时大小写、别名不同也算同一个时区；false 时不比
  assert.equal(sameReconciliationWindow(day, { ...day, timezone: "asia/shanghai" }, { timezone: "canonical" }), true);
  assert.equal(sameReconciliationWindow(day, { ...day, timezone: "UTC" }, { timezone: "canonical" }), false);
  assert.equal(sameReconciliationWindow(day, { ...day, timezone: "Not/AZone" }, { timezone: "canonical" }), false);
  assert.equal(sameReconciliationWindow(day, { ...day, timezone: "UTC" }, { timezone: false }), true);
  // asRequested：今天、近 7 天、本月截至取数时刻，同一预设、同一起点就是同一个窗口
  const asRequested = { asRequested: true, timezone: false };
  assert.equal(sameReconciliationWindow(live(start + 1000), live(start + 2000), asRequested), true);
  assert.equal(sameReconciliationWindow(live(start + 1000), { ...live(start + 1000), preset: "custom" }, asRequested), false);
  assert.equal(sameReconciliationWindow({ preset: "custom", startMs: start, endMs: 1 }, { preset: "custom", startMs: start, endMs: 2 }, asRequested), false);
  assert.equal(sameReconciliationWindow({ startMs: start, endMs: 1 }, { startMs: start, endMs: 1 }, asRequested), true);
  assert.equal(sameReconciliationWindow(null, live(1), asRequested), false);
  assert.equal(sameReconciliationWindow(live(start + 1000), { ...live(start + 2000), timezone: "UTC" }, { asRequested: true }), false, "要比时区时时区不同就不是");
});
