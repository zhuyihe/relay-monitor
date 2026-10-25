import assert from "node:assert/strict";
import test from "node:test";
import { readWorkflowDestination } from "./client.ts";
import { ERROR_CATEGORIES } from "./error-copy.js";
import {
  DESTINATION_CHANGED,
  HISTORY_KEPT,
  WORKFLOW_ACTION_KINDS,
  correctTimingDone,
  testReadText,
  workflowAction,
  workflowActionMeta,
  workflowTodo,
} from "./workflow-actions.js";

// 固定的一天：上海 10月8日
const DAY_START = Date.parse("2026-10-07T16:00:00Z");
const DAY_END = Date.parse("2026-10-08T16:00:00Z");
const DAY = { startMs: DAY_START, endMs: DAY_END, timezone: "Asia/Shanghai" };
// 一个什么都填了的去处：上游、绑定、自营站点、几个渠道和一天
const FULL = { accountKey: "acct-1", stationId: "up-1", ruleId: "rule-1", ownStationId: "own-1", channelIds: [3, "1", 3], window: { ...DAY, label: "10月8日" } };
const EXPIRED = "页面已过期，请刷新后重新打开。";
// 按 href 的路径找页面，再交给页面读链接参数
function open(href) {
  const url = new URL(href, "http://relay.local");
  return readWorkflowDestination(url.search, url.pathname.slice(1));
}
const destination = (fields) => ({ action: "inspect", ruleId: null, stationId: null, accountKey: null, ownStationId: null, channelIds: [], window: null, error: "", ...fields });

test("§3.5 按钮名和完成提示：同一个动作只有一个名字", () => {
  const table = {
    update_authorization: ["更新登录信息", "已更新登录信息"],
    review_conflict: ["处理重复", "已处理"],
    review_source: ["去确认", "已确认"],
    verify_identity: ["测试读取", undefined],
    verify_capability: ["测试读取", undefined],
    confirm_coverage: ["去回答", "已保存"],
    retry_bill: ["重新读取", "已重新读取"],
    edit_binding: ["改绑定", "已保存"],
    connect_channels: ["去绑定", "已绑定"],
    inspect_balance: ["查看余额", undefined],
    pause_monitor: ["暂停监控", "已暂停监控，绑定照常算利润"],
    resume_monitor: ["恢复监控", "已恢复监控"],
    correct_timing: ["改时间", "时间已修改，改到的那几天会重新算"],
    refresh: ["刷新", "已刷新"],
    swap_key: ["换 Key", "已换成新 Key，旧 Key 以前的每日记录还在"],
    unbind: ["解除绑定", "已解除绑定，以前的每日记录还在"],
    delete_upstream: ["删除上游", "已删除"],
    view_detail: ["查看详细原因", undefined],
    setup_own_station: ["去设置", undefined],
    open_history: ["以前的每日记录", undefined],
    view_merges: ["查看", undefined],
    go_merge: ["去合并", undefined],
    merge_upstream: ["合并", undefined],
    undo_merge: ["退回", "已退回"],
  };
  assert.deepEqual([...WORKFLOW_ACTION_KINDS].sort(), Object.keys(table).sort());
  for (const [kind, [label, done]] of Object.entries(table)) assert.deepEqual([workflowActionMeta(kind).label, workflowActionMeta(kind).done], [label, done], kind);
  assert.equal(HISTORY_KEPT, "以前的每日记录还在");
  assert.equal(workflowActionMeta("bogus"), null);
  assert.equal(workflowActionMeta(undefined), null);
  assert.ok(Object.isFrozen(WORKFLOW_ACTION_KINDS));
});

test("进运营总览的动作和先后：要紧的在前，渠道没绑定最后；其他动作不进总览", () => {
  const todos = Object.fromEntries(WORKFLOW_ACTION_KINDS.map((kind) => [kind, workflowTodo(kind)]).filter(([, todo]) => todo));
  assert.deepEqual(todos, {
    update_authorization: { order: 0, urgent: true },
    review_conflict: { order: 0, urgent: true },
    review_source: { order: 0, urgent: true },
    verify_identity: { order: 1, urgent: false },
    verify_capability: { order: 1, urgent: false },
    confirm_coverage: { order: 2, urgent: false },
    retry_bill: { order: 2, urgent: false },
    edit_binding: { order: 2, urgent: false },
    connect_channels: { order: 3, urgent: false },
  });
  assert.equal(workflowTodo("bogus"), null);
});

test("「测试读取」的结果一句", () => {
  assert.equal(testReadText({ ok: true, balance: "$123" }), "能读到余额 $123");
  assert.equal(testReadText({ ok: true }), "能读到账单");
  assert.equal(testReadText({ ok: true, bill: false }), "能读到这个上游");
  assert.equal(testReadText({ ok: false, reason: "登录信息不对或过期了" }), "读不到：登录信息不对或过期了");
  assert.equal(testReadText({ ok: false }), `读不到：${ERROR_CATEGORIES.other.text}`, "没有原因时说「操作没完成」");
  assert.equal(testReadText(), "读不到：操作没完成，请稍后再试");
  assert.equal(DESTINATION_CHANGED, "这条已经变了，刷新后再看。");
});

test("事项：不认识的动作直接报错，id 由动作和去处拼成，渠道去重排好，日期只留起止和时区", () => {
  assert.throws(() => workflowAction("bogus"), TypeError);
  const action = workflowAction("retry_bill", FULL);
  assert.equal(action.id, `retry_bill:acct-1:up-1:rule-1:own-1:1,3:${DAY_START}-${DAY_END}`);
  assert.deepEqual(action.channelIds, [1, 3]);
  assert.deepEqual(action.window, DAY);
  assert.deepEqual([action.accountKey, action.stationId, action.ruleId, action.ownStationId], ["acct-1", "up-1", "rule-1", "own-1"]);
  assert.equal("code" in action, false, "没传问题码就不带 code");
  const empty = workflowAction("refresh");
  assert.deepEqual(empty, { id: "refresh::::::", kind: "refresh", label: "刷新", title: "", detail: "", accountKey: null, stationId: null,
    ruleId: null, ownStationId: null, channelIds: [], window: null, href: null });
  assert.equal(workflowAction("connect_channels", { ownStationId: "own-1", channelIds: [2, 1] }).id, "connect_channels::::own-1:1,2:");
  assert.notEqual(workflowAction("retry_bill", { ruleId: "rule-1", window: DAY }).id,
    workflowAction("retry_bill", { ruleId: "rule-1", window: { ...DAY, startMs: DAY_END, endMs: DAY_END + 86400000 } }).id, "不同的日子是不同的事项");
});

test("事项标题：默认取动作自己的问题码，传了问题码取那个码的文案，没有问题码的动作用自己的标题", () => {
  const titled = (kind, target = {}, options) => {
    const action = workflowAction(kind, target, options);
    return [action.label, action.title, action.detail, action.code ?? null];
  };
  assert.deepEqual(titled("update_authorization"), ["更新登录信息", "登录信息不对或过期了", "更新之后才能接着读取余额和账单", null]);
  assert.deepEqual(titled("review_conflict"), ["处理重复", "这把 Key 绑了两次", "同一把 Key 的上游成本只能算一次，去掉多余的那条", null]);
  assert.deepEqual(titled("review_source"), ["去确认", "上游账号或自营站点有变化", "确认这条绑定还对应原来的账号和渠道，利润才会接着算", null]);
  assert.deepEqual(titled("verify_identity"), ["测试读取", "还没确认这把 Key 属于哪个上游账号", "测试读取一次就好", null]);
  assert.deepEqual(titled("verify_capability"), ["测试读取", "还没确认能读到这个上游的完整账单", "测试读取一次就好", null]);
  assert.deepEqual(titled("confirm_coverage"), ["去回答", "这把 Key 还给别处用吗？", "别处也在用的话，上游成本会算多；回答之前，利润先不算", null]);
  assert.deepEqual(titled("retry_bill"), ["重新读取", "这天的账单一直没读全", "", null]);
  assert.deepEqual(titled("edit_binding"), ["改绑定", "有收入，但上游一直没有用量记录", "可能绑错了 Key", null]);
  assert.deepEqual(titled("connect_channels", { channelIds: [4, 5] }), ["去绑定", "有 2 个渠道还没绑定", "绑定之后才能算这些渠道的利润", null]);
  assert.deepEqual(titled("verify_capability", {}, { code: "BILLING_TIMEZONE_UNVERIFIED" }),
    ["测试读取", "还没确认这个上游按哪个时区算一天", "测试读取一次就好", "BILLING_TIMEZONE_UNVERIFIED"]);
  assert.deepEqual(titled("review_conflict", {}, { code: "DUPLICATE_CHANNEL_ASSIGNMENT", params: { channel: "出口一" } }),
    ["处理重复", "渠道「出口一」同时绑了两把 Key", "同一个渠道的收入只能算一次，去掉多余的那条", "DUPLICATE_CHANNEL_ASSIGNMENT"]);
  assert.deepEqual(titled("review_conflict", {}, { code: "DUPLICATE_CHANNEL_ASSIGNMENT" }).slice(1, 2), ["有渠道同时绑了两把 Key"], "不知道渠道名就不带名字");
  assert.deepEqual(titled("retry_bill", {}, { code: "UPSTREAM_DATA_UNAVAILABLE" }).slice(1, 3), ["上游这天的用量记录一直读不到", ""]);
  // 提示类的问题码：标题取那一句提示
  assert.deepEqual(titled("correct_timing", {}, { code: "SEGMENT_TIMING_UNCONFIRMED" }), ["改时间", "倍率变化的时间是系统估的", "", "SEGMENT_TIMING_UNCONFIRMED"]);
  assert.deepEqual(titled("edit_binding", {}, { code: "SALES_CHANNEL_MISSING", params: { channel: "出口一" } }).slice(1, 3),
    ["渠道「出口一」在自营站点里已删除，不用了就从绑定里去掉", ""]);
  assert.deepEqual(titled("refresh", {}, { code: "SOMETHING_NEW" }), ["刷新", "这条暂时算不出利润", "", "SOMETHING_NEW"]);
});

test("跳转地址：每个要去别处处理的动作都指到认得它的页面", () => {
  const href = (kind, target = FULL) => workflowAction(kind, target).href;
  assert.equal(href("update_authorization"), "/stations?action=authorization&accountKey=acct-1");
  assert.equal(href("update_authorization", { stationId: "up-1" }), "/stations?action=authorization&stationId=up-1");
  assert.equal(href("review_conflict"), "/stations?action=conflict&ruleId=rule-1");
  assert.equal(href("review_source"), "/stations?action=source&ownStationId=own-1");
  assert.equal(href("verify_identity"), "/stations?action=verify&stationId=up-1");
  assert.equal(href("verify_capability"), "/stations?action=verify-billing&stationId=up-1");
  assert.equal(href("confirm_coverage"), "/stations?action=coverage&ruleId=rule-1");
  assert.equal(href("retry_bill"), `/reconciliation?action=retry&ruleId=rule-1&startMs=${DAY_START}&endMs=${DAY_END}&timezone=Asia%2FShanghai`);
  assert.equal(href("edit_binding"), "/stations?action=scope&ruleId=rule-1");
  assert.equal(href("connect_channels"), "/stations?action=connect&ownStationId=own-1&channelIds=1%2C3");
  assert.equal(href("inspect_balance"), "/stations?stationId=up-1");
  assert.equal(href("inspect_balance", { accountKey: "acct-1" }), "/stations?accountKey=acct-1");
  assert.equal(href("setup_own_station"), "/stations");
  for (const kind of ["pause_monitor", "resume_monitor", "correct_timing", "refresh", "swap_key", "unbind", "delete_upstream", "view_detail"]) {
    assert.equal(href(kind), null, `${kind} 在当前页面上完成`);
  }
});

test("生成的地址打开后都读得懂：去处一样，不会显示「页面已过期」", () => {
  const opened = (kind, target = FULL) => open(workflowAction(kind, target).href);
  assert.deepEqual(opened("update_authorization"), destination({ action: "authorization", accountKey: "acct-1" }));
  assert.deepEqual(opened("update_authorization", { stationId: "up-1" }), destination({ action: "authorization", stationId: "up-1" }));
  assert.deepEqual(opened("review_conflict"), destination({ action: "conflict", ruleId: "rule-1" }));
  assert.deepEqual(opened("review_source"), destination({ action: "source", ownStationId: "own-1" }));
  assert.deepEqual(opened("verify_identity"), destination({ action: "verify", stationId: "up-1" }));
  assert.deepEqual(opened("verify_capability"), destination({ action: "verify-billing", stationId: "up-1" }));
  assert.deepEqual(opened("confirm_coverage"), destination({ action: "coverage", ruleId: "rule-1" }));
  assert.deepEqual(opened("retry_bill"), destination({ action: "retry", ruleId: "rule-1", window: DAY }));
  assert.deepEqual(opened("edit_binding"), destination({ action: "scope", ruleId: "rule-1" }));
  assert.deepEqual(opened("connect_channels"), destination({ action: "connect", ownStationId: "own-1", channelIds: [1, 3] }));
  assert.deepEqual(opened("inspect_balance"), destination({ stationId: "up-1" }));
  assert.deepEqual(opened("inspect_balance", { accountKey: "acct-1" }), destination({ accountKey: "acct-1" }));
  assert.equal(opened("setup_own_station"), null, "去设置只是打开上游资源页");
});

test("读链接参数：没有去处时不处理，参数不对时只说页面已过期", () => {
  assert.equal(EXPIRED, `${ERROR_CATEGORIES.expired.text}。`);
  assert.equal(readWorkflowDestination("", "stations"), null);
  assert.equal(readWorkflowDestination("?ruleId=rule-1", "stations"), null, "只有 ruleId 不算去处");
  assert.deepEqual(readWorkflowDestination("?action=bogus", "stations"), destination({ action: "bogus", error: EXPIRED }));
  assert.equal(readWorkflowDestination("?action=connect&ownStationId=own-1&channelIds=1", "reconciliation").error, EXPIRED, "每日利润页不认去绑定");
  assert.equal(readWorkflowDestination("?action=retry&ruleId=rule-1", "stations").error, EXPIRED, "上游资源页不认重新读取");
  assert.equal(readWorkflowDestination("?action=scope", "stations").error, EXPIRED, "改绑定要知道是哪条绑定");
  assert.equal(readWorkflowDestination("?action=conflict&ruleId=", "stations").error, EXPIRED);
  assert.equal(readWorkflowDestination("?action=scope", "reconciliation").error, "", "每日利润页上没有 ruleId 就停在列表");

  const channels = (value) => readWorkflowDestination(`?action=connect&ownStationId=own-1&channelIds=${value}`, "stations");
  assert.deepEqual(channels("3,1,3").channelIds, [3, 1], "去重，按链接里的先后");
  for (const bad of ["0", "1,a", "", "1,,2", "-1", "1.5", "99999999999999999"]) assert.equal(channels(encodeURIComponent(bad)).error, EXPIRED, `channelIds=${bad}`);
  const ids = (count) => Array.from({ length: count }, (_, index) => index + 1).join(",");
  assert.equal(channels(ids(100)).error, "");
  assert.equal(channels(ids(100)).channelIds.length, 100);
  assert.equal(channels(ids(101)).error, EXPIRED, "一次最多 100 个渠道");
  assert.equal(channels(`${ids(100)},1`).error, "", "按去重后的个数算");

  const retry = (query) => readWorkflowDestination(`?action=retry&ruleId=rule-1&${query}`, "reconciliation");
  assert.deepEqual(retry(`startMs=${DAY_START}&endMs=${DAY_END}&timezone=UTC`).window, { startMs: DAY_START, endMs: DAY_END, timezone: "UTC" });
  for (const bad of [
    `startMs=${DAY_START}&endMs=${DAY_END}`,
    `startMs=${DAY_START}&timezone=UTC`,
    `startMs=${DAY_END}&endMs=${DAY_END}&timezone=UTC`,
    `startMs=${DAY_END}&endMs=${DAY_START}&timezone=UTC`,
    `startMs=${DAY_START}&endMs=${DAY_END}&timezone=Mars%2FBase`,
    `startMs=2026-10-08&endMs=${DAY_END}&timezone=UTC`,
    `startMs=0&endMs=99999999999999999&timezone=UTC`,
    `startMs=0&endMs=9000000000000000&timezone=UTC`,
  ]) {
    const opened = retry(bad);
    assert.deepEqual([opened.error, opened.window], [EXPIRED, null], bad);
  }
});

// 下面几条是 workflowAction 生成了自己读不懂的地址：按钮点进去只看到「页面已过期」
test("没有渠道的「去绑定」用不带数字的标题，地址也打得开", () => {
  const action = workflowAction("connect_channels", { ownStationId: "own-1" });
  assert.equal(action.title, "有渠道还没绑定");
  assert.equal(open(action.href).error, "");
});

test("去处缺了 ruleId 时地址里不写空的 ruleId=", () => {
  for (const kind of ["review_conflict", "edit_binding", "confirm_coverage"]) {
    const action = workflowAction(kind, { stationId: "up-1" });
    assert.doesNotMatch(action.href, /=(&|$)/, kind);
    assert.equal(open(action.href).error, "", kind);
  }
});

test("没有日期的「重新读取」只打开每日利润页，不生成打不开的地址", () => {
  const action = workflowAction("retry_bill", { ruleId: "rule-1" });
  assert.equal(action.href, "/reconciliation");
  assert.equal(open(action.href), null, "没有要定位的那一天，页面照常打开");
});

test("Object.prototype 上的名字不算动作", () => {
  for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(workflowActionMeta(kind), null, kind);
    assert.equal(workflowTodo(kind), null, kind);
    assert.throws(() => workflowAction(kind), TypeError, kind);
  }
});

test("改时间成功的提示：都重算了照旧自动消失；有太早没自动重算的写出哪几天、为什么，点关闭才收起", () => {
  const now = Date.parse("2026-10-26T03:00:00Z"), tz = "Asia/Shanghai";
  const done = (resettle) => correctTimingDone(resettle, { timezone: tz, now });
  assert.deepEqual(done(null), { text: "时间已修改，改到的那几天会重新算", persistent: false });
  assert.deepEqual(done({ recent: 3, tooOld: [] }), { text: "时间已修改，改到的那几天会重新算", persistent: false });
  assert.deepEqual(done({ recent: 5, tooOld: ["2026-09-01", "2026-09-02", "2026-09-03"] }), { persistent: true,
    text: "时间已修改，改到的那几天会重新算。其中 9月1日–9月3日 在 31 天以前，没自动重算；要按新的时间算，到每日利润选那天点「重新读取」。" });
  assert.deepEqual(done({ recent: 0, tooOld: ["2026-09-01", "2026-09-02", "2026-09-03"] }), { persistent: true,
    text: "时间已修改。改到的 9月1日–9月3日 都在 31 天以前，没自动重算；要按新的时间算，到每日利润选那天点「重新读取」。" });
  assert.equal(done({ recent: 1, tooOld: ["2026-09-01"] }).text.includes("其中 9月1日 在 31 天以前"), true, "一天");
});
