// K2b 分段决策的测试（先于算法写，覆盖 design/ux/binding-flow.md §2「例外三」、§3「换 Key、换倍率时」里的每个例子）：
// [a,b) 窗口两把 Key 都算、Key 在两个渠道之间挪、Sub2API 同一天挪的逐条拆分、例外三跨轮状态的每一种转换，
// 外加「没换 Key 时结果逐字不变」。审核 2 先看这些用例对不对得上 k-plan，再审算法。
import assert from "node:assert/strict";
import test from "node:test";
import {
  planKeyChangeSegments, planMovedKeySegments, planSegmentChanges, splitSub2RecordsAtCutover,
  keyAgentExceptionIssueOf, KEY_READER_UNREACHABLE_THRESHOLD, detectGroupSplit, detectGroupMerges, safeLastSeenAt, planRegroup,
} from "./key-agent-resegment.js";

const ref = (tokenId, upstreamStationId = "up1") => ({ upstreamStationId, tokenId });
const T = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return (h * 60 + m) * 60_000; }; // 当天内的相对毫秒，够比较用

// ---------- [a,b) 窗口：两把 Key 都算（binding-flow.md §1 第 3 步、§3 最后一段） ----------

test("planKeyChangeSegments：定不出精确切点——开 [a,b) 过渡段，两把 Key 都要算，不是只认新的那把", () => {
  const plan = planKeyChangeSegments({ lastSeenAt: T("14:29"), observedAt: T("14:30"), oldRef: ref(9), newRef: ref(10) });
  assert.equal(plan.kind, "windowed");
  assert.equal(plan.windowStart, T("14:29"));
  assert.equal(plan.windowEnd, T("14:30"));
  assert.deepEqual(plan.windowKeys, [ref(9), ref(10)]);
  assert.deepEqual(plan.before, [ref(9)]);
  assert.deepEqual(plan.after, [ref(10)]);
});

test("planKeyChangeSegments：例外三恢复后过渡段变长（读不到渠道 Key 那段时间），两把 Key 照样都算，不因为窗口变长就只认一把", () => {
  // design/ux/binding-flow.md §2 例外三：「有渠道的Key和读不到之前不一样……这段时间的数照常算进汇总、照常固定，不提示」
  const plan = planKeyChangeSegments({ lastSeenAt: T("15:19"), observedAt: T("16:05"), oldRef: ref(9), newRef: ref(10) });
  assert.equal(plan.kind, "windowed");
  assert.equal(plan.windowEnd - plan.windowStart, 46 * 60_000);
  assert.deepEqual(plan.windowKeys, [ref(9), ref(10)]);
});

test("planKeyChangeSegments：New API 逐条用量能精确定出新 Key 第一条用量的时刻——干净切一刀，没有过渡段", () => {
  const preciseAt = T("14:30") + 7_000; // 14:30:07
  const plan = planKeyChangeSegments({ lastSeenAt: T("14:29"), observedAt: T("14:30"), oldRef: ref(9), newRef: ref(10), preciseAt });
  assert.equal(plan.kind, "precise");
  assert.equal(plan.cutoverAt, preciseAt);
  assert.equal(plan.windowKeys, undefined, "精确切点时不该再有过渡段");
});

// ---------- lastSeenAt（a）丢了的兜底：只能往前退，不能往后挪（总指挥 10-26 定，重启场景） ----------

test("safeLastSeenAt：有持久化的「读取服务上一次读成功的时刻」就用它，旧一点也没关系", () => {
  assert.equal(safeLastSeenAt({ keyAgentLastSuccessAtMs: T("10:00"), segmentEffectiveFrom: T("00:00") }), T("10:00"));
});

test("safeLastSeenAt：持久化的成功时刻比开着那段的起点还早（站点的时刻很久没往前推过）——不早于段起点，段不能在自己起点以前结束", () => {
  assert.equal(safeLastSeenAt({ keyAgentLastSuccessAtMs: T("00:10"), segmentEffectiveFrom: T("09:00") }), T("09:00"));
});

test("safeLastSeenAt：没有持久化的成功时刻（没装过读取服务，或者刚装上还没成功读过）——退到这条绑定当前开着那段的起点，一定不晚于真正换 Key 的那一刻", () => {
  assert.equal(safeLastSeenAt({ keyAgentLastSuccessAtMs: null, segmentEffectiveFrom: T("00:00") }), T("00:00"));
});

test("重启场景：a 丢了、退到更早的安全时刻，[a,b) 过渡段依旧盖住真正换 Key 的那一刻 t——不漏 [t,b) 这段新 Key 的花费", () => {
  // t（真正换 Key，没人知道确切时刻）落在 10:00（上一次读成功）和 14:30（这一轮认出新 Key，b）之间，比如 12:00；
  // 重启丢了内存里原本该记的、更贴近 t 的 lastSeenAt，只能退到持久化的「上一次读成功」（10:00）
  const a = safeLastSeenAt({ keyAgentLastSuccessAtMs: T("10:00"), segmentEffectiveFrom: T("00:00") });
  const t = T("12:00"), b = T("14:30");
  assert.ok(a <= t, "退到的时刻不晚于真正换 Key 的那一刻，没有往后挪");
  const plan = planKeyChangeSegments({ lastSeenAt: a, observedAt: b, oldRef: ref(9), newRef: ref(10) });
  assert.equal(plan.kind, "windowed");
  assert.equal(plan.windowStart, a);
  assert.equal(plan.windowEnd, b);
  assert.ok(plan.windowStart <= t && t < plan.windowEnd, "过渡段整段盖住 t，[t,b) 落在过渡段里——不会被漏在旧段（只有旧 Key）或新段（从 b 起）之外");
});

test("planKeyChangeSegments：原来没有 Key 的渠道（新渠道、还没有用量）第一次认出 Key——没有旧 Key 可以一起算，直接在认出的那一刻开段", () => {
  const plan = planKeyChangeSegments({ lastSeenAt: null, observedAt: T("09:00"), oldRef: null, newRef: ref(10) });
  assert.equal(plan.kind, "precise");
  assert.equal(plan.cutoverAt, T("09:00"));
  assert.deepEqual(plan.before, []);
  assert.deepEqual(plan.after, [ref(10)]);
});

// ---------- Key 在两个渠道之间挪（binding-flow.md §3：按 b 切开，不开过渡段，钱不能算两次） ----------

test("planMovedKeySegments：挪过来的 Key 按读到变化的那一刻 b 切开，不开过渡段", () => {
  const plan = planMovedKeySegments({ observedAt: T("16:05"), newRef: ref(10) });
  assert.equal(plan.kind, "moved");
  assert.equal(plan.cutoverAt, T("16:05"));
  assert.deepEqual(plan.after, [ref(10)], "带着挪过来的这把 Key，调用方开段要用");
  assert.equal(plan.windowKeys, undefined, "挪位置不该有两把 Key 都算的过渡段，不然两条绑定会把同一笔钱算两次");
});

test("planSegmentChanges：一把 Key 从渠道 A 挪到渠道 B——A 到 b 为止，B 从 b 起，两边都不开过渡段，合起来恰好不重不漏", () => {
  const plans = planSegmentChanges({
    bindings: [
      { id: "A", before: ref(9), after: ref(10) }, // A 原来用 9，现在换成了 10（10 不在 before 里出现过，是凭空出现的新 Key，不是挪的）
      { id: "B", before: ref(10), after: ref(9) },  // B 原来用 10，现在换成了 9——这把 9 恰好是 A 刚刚放下的
    ],
    lastSeenAt: T("14:29"), observedAt: T("16:05"),
  });
  const planA = plans.find((p) => p.bindingId === "A");
  const planB = plans.find((p) => p.bindingId === "B");
  // A 换成的 10：B 在 before 时刻正握着 10，所以 A 的 10 是“挪过来的”，按 b 切开，不开过渡段
  assert.equal(planA.kind, "moved");
  assert.equal(planA.movedFromBindingId, "B");
  assert.equal(planA.cutoverAt, T("16:05"));
  // B 换成的 9：A 在 before 时刻正握着 9，B 的 9 也是“挪过来的”
  assert.equal(planB.kind, "moved");
  assert.equal(planB.movedFromBindingId, "A");
  assert.equal(planB.cutoverAt, T("16:05"));
});

test("planSegmentChanges：换成的新 Key 不是任何绑定原来握着的（凭空出现）——走过渡段那条路，不是 moved", () => {
  const plans = planSegmentChanges({
    bindings: [{ id: "A", before: ref(9), after: ref(11) }], // 11 没有任何绑定在 before 时刻握着过
    lastSeenAt: T("14:29"), observedAt: T("14:30"),
  });
  assert.equal(plans[0].kind, "windowed");
  assert.equal(plans[0].movedFromBindingId, undefined);
});

// ---------- 没换 Key 时结果逐字不变 ----------

test("planSegmentChanges：没换 Key 的绑定不出现在计划里——调用方不会去改任何段，结果逐字不变", () => {
  const plans = planSegmentChanges({
    bindings: [
      { id: "A", before: ref(9), after: ref(9) },   // 没变
      { id: "B", before: null, after: null },        // 一直没有 Key（keyless 渠道）
      { id: "C", before: ref(5), after: ref(6) },    // 真的变了，应该出现
    ],
    lastSeenAt: T("14:29"), observedAt: T("14:30"),
  });
  assert.deepEqual(plans.map((p) => p.bindingId), ["C"]);
});

test("planSegmentChanges：lastSeenAtByBinding 按 bindingId 覆盖这一批共用的 lastSeenAt（那条绑定的站点没有持久化的成功时刻，退到它自己开着段的起点）", () => {
  const plans = planSegmentChanges({
    bindings: [{ id: "A", before: ref(9), after: ref(10) }, { id: "B", before: ref(5), after: ref(6) }],
    lastSeenAt: T("10:00"), observedAt: T("14:30"),
    lastSeenAtByBinding: { B: T("00:00") }, // B 退到自己段的起点，A 用这一批共用的
  });
  assert.equal(plans.find((p) => p.bindingId === "A").windowStart, T("10:00"));
  assert.equal(plans.find((p) => p.bindingId === "B").windowStart, T("00:00"));
});

// ---------- Sub2API 同一天挪的逐条拆分 ----------

test("splitSub2RecordsAtCutover：Sub2API 没有实时信号，翻这一天的逐条用量按 b 精确切开，before/after 金额相加等于全天总额", () => {
  const records = [
    { at: T("00:30"), amountUsd: 1 }, { at: T("10:00"), amountUsd: 2 }, // 换 Key 之前
    { at: T("16:05"), amountUsd: 3 }, { at: T("20:00"), amountUsd: 4 }, // 换 Key（b）之后，16:05 这条算进 after
  ];
  const { before, after } = splitSub2RecordsAtCutover(records, T("16:05"));
  assert.equal(before.records.length, 2);
  assert.equal(before.amountUsd, 3);
  assert.equal(after.records.length, 2);
  assert.equal(after.amountUsd, 7);
  assert.equal(before.amountUsd + after.amountUsd, records.reduce((s, r) => s + r.amountUsd, 0), "逐条拆分不漏不重");
});

test("splitSub2RecordsAtCutover：Key 已经删除时翻的是整个账号这一天的逐条用量，在本地挑出来——函数本身不关心记录是哪把 Key 的，调用方已经挑好了再传进来", () => {
  const records = [{ at: T("09:00"), amountUsd: 5 }, { at: T("17:00"), amountUsd: 7 }];
  const { before, after } = splitSub2RecordsAtCutover(records, T("12:00"));
  assert.equal(before.amountUsd, 5);
  assert.equal(after.amountUsd, 7);
});

// ---------- 例外三跨轮状态的每一种转换 ----------

test("keyAgentExceptionIssueOf：没有失败——没有问题", () => {
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 0, unreachableSinceMs: null }), null);
});

test("keyAgentExceptionIssueOf：失败次数没到门槛——「实时·还在读取」（KEY_AGENT_UNAVAILABLE），不打扰", () => {
  for (let n = 1; n < KEY_READER_UNREACHABLE_THRESHOLD; n++) {
    assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: n, unreachableSinceMs: 1 }), "KEY_AGENT_UNAVAILABLE", `第 ${n} 次`);
  }
});

test("keyAgentExceptionIssueOf：连续失败到了门槛——升成需处理 KEY_READER_UNREACHABLE", () => {
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: KEY_READER_UNREACHABLE_THRESHOLD, unreachableSinceMs: 1 }), "KEY_READER_UNREACHABLE");
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: KEY_READER_UNREACHABLE_THRESHOLD + 5, unreachableSinceMs: 1 }), "KEY_READER_UNREACHABLE", "过了门槛以后一直是需处理，不会退回实时");
});

test("例外三全流程：连不上→没到门槛→到门槛升需处理→重连且 Key 没变→不提示、不开过渡段", () => {
  // 第 1、2 次失败：还在读取
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 1 }), "KEY_AGENT_UNAVAILABLE");
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 2 }), "KEY_AGENT_UNAVAILABLE");
  // 第 3 次：需处理
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 3 }), "KEY_READER_UNREACHABLE");
  // 重连，Key 没变：planSegmentChanges 不出计划（和「没换 Key 时结果逐字不变」是同一条规则）
  const plans = planSegmentChanges({ bindings: [{ id: "A", before: ref(9), after: ref(9) }], lastSeenAt: T("15:19"), observedAt: T("16:05") });
  assert.deepEqual(plans, []);
});

test("例外三全流程：重连且 Key 变了（不是挪的）——开 [a,b) 过渡段（a=最后一次读到旧 Key，b=重连时刻），两把 Key 都算，照常固定、不提示", () => {
  const plans = planSegmentChanges({ bindings: [{ id: "A", before: ref(9), after: ref(10) }], lastSeenAt: T("15:19"), observedAt: T("16:05") });
  assert.deepEqual(plans, [{ bindingId: "A", kind: "windowed", windowStart: T("15:19"), windowEnd: T("16:05"), windowKeys: [ref(9), ref(10)], before: [ref(9)], after: [ref(10)] }]);
});

test("例外三全流程：重连且 Key 挪到了另一个在算的渠道——按重连时刻 b 切开，两边都不开过渡段", () => {
  const plans = planSegmentChanges({
    bindings: [{ id: "A", before: ref(9), after: ref(10) }, { id: "B", before: ref(10), after: ref(9) }],
    lastSeenAt: T("15:19"), observedAt: T("16:05"),
  });
  for (const plan of plans) { assert.equal(plan.kind, "moved"); assert.equal(plan.cutoverAt, T("16:05")); }
});

test("例外三全流程：读不到超过 7 天——这里只给码（KEY_READER_UNREACHABLE 从第 3 次失败起就已经是需处理），7 天升级是通用的 retry 机制（lib/reconciliation-contract.js 的 SETTLE_LOOKBACK_MS），不是这一层额外做的事", () => {
  // KEY_READER_UNREACHABLE 的 kind 是 "action"（lib/reconciliation-contract.js），从一开始就是需处理，不需要再等 7 天才升级；
  // 这条测试只是把这件事明确记下来，避免以后有人以为例外三也要等 7 天
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 100 }), "KEY_READER_UNREACHABLE");
});

// ---------- 分组、合组：K2b 只检测、不处理，交给 K2c ----------

test("detectGroupSplit：同一条绑定名下的几个渠道，现在读到的 Key 不再是同一把——组散了（分组）", () => {
  assert.equal(detectGroupSplit([ref(9), ref(9)]), false, "都一样，没散");
  assert.equal(detectGroupSplit([ref(9), ref(10)]), true, "不一样了，散了");
  assert.equal(detectGroupSplit([ref(9)]), false, "只有一个渠道，谈不上组散没散");
  assert.equal(detectGroupSplit([ref(9), null]), false, "还没认出的渠道先不算冲突，等认出来再判断");
});

test("detectGroupMerges：两条不同的绑定现在握着同一把 Key——合组了，K2b 不知道该算给哪条", () => {
  const conflicts = detectGroupMerges([{ bindingId: "A", ref: ref(9) }, { bindingId: "B", ref: ref(9) }, { bindingId: "C", ref: ref(5) }]);
  assert.deepEqual(conflicts, [["A", "B"]]);
});

test("detectGroupMerges：各握各的 Key，没有冲突", () => {
  assert.deepEqual(detectGroupMerges([{ bindingId: "A", ref: ref(9) }, { bindingId: "B", ref: ref(5) }]), []);
});

// ---------- 多 Key 段经过切开、复制以后成本不变（审核 1 在 #114 发现的丢 keys 问题，K2b 以后真的会用上多 Key 段） ----------

test("copySegment：多 Key 段复制、改字段以后，keys 原样带过去，不会像 `{...segment}` 那样丢掉（审核 #114：真值 2592 算成了 1684.8 就是因为丢了这个属性）", async () => {
  const { attachSegmentKeys, copySegment } = await import("./reconciliation-repository.js");
  const [segment] = attachSegmentKeys(
    [{ id: "seg1", effectiveFrom: T("00:00"), effectiveTo: T("16:05") }],
    [
      { segment_id: "seg1", upstream_station_id: "up1", token_id: 9, token_name: "oai", match_source: "agent" },
      { segment_id: "seg1", upstream_station_id: "up1", token_id: 10, token_name: "oai-2", match_source: "agent" },
    ],
  );
  assert.equal(segment.keys.length, 2, "原始段带着两把 Key");
  // 典型的「按天切开」复制：改一下窗口字段，其余原样带过去
  const dayCopy = copySegment(segment, { effectiveFrom: T("00:00"), effectiveTo: T("24:00") });
  assert.equal(dayCopy.keys.length, 2, "复制以后两把 Key 还在");
  assert.deepEqual(dayCopy.keys.map((k) => k.tokenId), [9, 10]);
  // 对照：`{...segment}` 的老办法会把不可枚举的 keys 丢掉，这是审核 1 发现的真实 bug 的根因
  assert.equal({ ...segment }.keys, undefined, "展开运算符本身确实会丢（这正是为什么要用 copySegment，不是这个函数的 bug）");
  // JSON 序列化不受影响（keys 本来就不该进 JSON，这是 K1c 定的规矩，复制以后也一样不进）
  assert.equal(JSON.stringify(dayCopy).includes("oai"), false);
});

// ---------- K2c 重新分组（planRegroup） ----------

const rule = (id, tokenId, channelIds, upstreamStationId = "up1") => ({ id, upstreamStationId, tokenId, tokenName: `k${tokenId}`, channelIds });
const refs = (entries) => new Map(Object.entries(entries).map(([channelId, tokenId]) => [Number(channelId), { upstreamStationId: "up1", tokenId, tokenName: `k${tokenId}` }]));
const key = (tokenId) => ({ upstreamStationId: "up1", tokenId, tokenName: `k${tokenId}` });

test("planRegroup 分组：一条绑定两个渠道原来共用 K1，现在 A 还是 K1、B 换成了 K2——旧绑定在 b 归档、[a,b) 放 K1 和 K2，新绑定一渠道一条", () => {
  const plan = planRegroup({ rules: [rule("x", 1, [10, 20])], refByChannelId: refs({ 10: 1, 20: 2 }), flaggedIds: ["x"] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.closes, [{ ruleId: "x", windowKeys: [key(1), key(2)] }]);
  assert.deepEqual(plan.groups.map((group) => [group.ref.tokenId, group.channelIds]), [[1, [10]], [2, [20]]]);
});

test("planRegroup 合组：两条绑定的渠道现在用同一把 Key——旧的两条各自在 b 归档，不开过渡段，新的一条放全部渠道", () => {
  const plan = planRegroup({ rules: [rule("x", 1, [10]), rule("y", 2, [20])], refByChannelId: refs({ 10: 1, 20: 1 }), flaggedIds: ["x", "y"] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.closes, [{ ruleId: "x", windowKeys: null }, { ruleId: "y", windowKeys: null }]);
  assert.deepEqual(plan.groups.map((group) => [group.ref.tokenId, group.channelIds, group.fromRuleIds]), [[1, [10, 20], ["x", "y"]]]);
});

test("planRegroup：牵连的绑定找全——被标记的绑定用到了另一条绑定握着的 Key（唯一约束，要先归档它），那一条也一起分；没牵连的不碰", () => {
  const plan = planRegroup({ rules: [rule("x", 1, [10, 20]), rule("y", 2, [30]), rule("z", 3, [40])], refByChannelId: refs({ 10: 1, 20: 2, 30: 2, 40: 3 }), flaggedIds: ["x"] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.closes.map((close) => close.ruleId), ["x", "y"], "z 没牵连，不动");
  assert.deepEqual(plan.groups.map((group) => [group.ref.tokenId, group.channelIds]), [[1, [10]], [2, [20, 30]]]);
  // 换走的 K2 原来是 y 握着的：x 的过渡段里不放 K2（K2 在 [a,b) 的钱算在 y 名下，放两边就算了两遍）
  assert.deepEqual(plan.closes.find((close) => close.ruleId === "x").windowKeys, null);
});

test("planRegroup：几条绑定都换走到同一把全新的 Key，过渡段只放在排第一的那条里（不算两遍）", () => {
  const plan = planRegroup({ rules: [rule("x", 1, [10, 11]), rule("y", 2, [20, 21])], refByChannelId: refs({ 10: 1, 11: 9, 20: 2, 21: 9 }), flaggedIds: ["x", "y"] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.closes, [{ ruleId: "x", windowKeys: [key(1), key(9)] }, { ruleId: "y", windowKeys: null }]);
  assert.deepEqual(plan.groups.map((group) => [group.ref.tokenId, group.channelIds]), [[1, [10]], [9, [11, 21]], [2, [20]]]);
});

test("planRegroup：牵连的渠道有没认出来的、或者 Key 换到了别的上游，这一轮不分（保持原样）", () => {
  const unresolved = planRegroup({ rules: [rule("x", 1, [10, 20])], refByChannelId: refs({ 10: 1 }), flaggedIds: ["x"] });
  assert.deepEqual([unresolved.ok, unresolved.reason, unresolved.ruleIds], [false, "UNIDENTIFIED", ["x"]]);
  const elsewhere = planRegroup({ rules: [rule("x", 1, [10, 20])], refByChannelId: new Map([[10, key(1)], [20, { upstreamStationId: "up2", tokenId: 5 }]]), flaggedIds: ["x"] });
  assert.deepEqual([elsewhere.ok, elsewhere.reason], [false, "UPSTREAM_CHANGED"]);
  assert.equal(planRegroup({ rules: [rule("x", 1, [10])], refByChannelId: refs({ 10: 1 }), flaggedIds: [] }).ok, false);
});
