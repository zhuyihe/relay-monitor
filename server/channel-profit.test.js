import assert from "node:assert/strict";
import test from "node:test";
import { createChannelProfitModule } from "./channel-profit.js";

const KEY_AGENT_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const own = { id: "own", isOwn: true, type: "newapi", keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: KEY_AGENT_SECRET };
const upMine = { id: "up1", type: "newapi", accountUse: "only_mine" };
const upShared = { id: "up2", type: "sub2api", accountUse: "elsewhere" };

const slot = (stationId, tokenId, tokenName = `k${tokenId}`) => ({ index: 0, state: "identified", matches: [{ stationId, tokenId, tokenName, via: "fingerprint" }] });

// 假的运行时：渠道目录、读取服务认出的结果、绑定、「用户停的」都放在内存里；接入向导的 probeBatch / connectBatch 只记下收到的输入
function fixture({ channels, identified, rules = [], optouts = [], stations = [own, upMine, upShared], configured = true, connectResult = null, revealIssues = [] }) {
  const calls = { probe: [], connect: [], archived: [], optoutAdded: [], optoutRemoved: [], marked: [] };
  const state = { rules: [...rules], optouts: [...optouts] };
  const rt = {
    store: { get: (id) => (id === "own" && !configured ? { ...own, keyAgentUrl: "", keyAgentSecret: "" } : stations.find((station) => station.id === id) || null) },
    channelOnboarding: {
      getSourceCatalogue: () => ({ ownSource: { stationId: "own" }, stale: false, channels: channels.map((id) => ({ id, name: `渠道${id}`, revision: `r${id}`, missing: false })) }),
      probeBatch: async (input) => { calls.probe.push(structuredClone(input)); return { previewId: "preview-1", groups: input.groups.map((group) => ({ groupId: group.groupId, status: "ready" })) }; },
      connectBatch: async (input) => {
        calls.connect.push(structuredClone(input));
        return connectResult ? connectResult(input) : { complete: true, groups: input.groups.map((group, index) => ({ groupId: group.groupId, requestedGroupIds: [group.groupId],
          reconciliation: { status: "configured", ruleId: `rule-${index}` } })) };
      },
    },
    reconciliation: {
      listRules: async () => state.rules,
      listChannelOptouts: async () => state.optouts,
      removeChannelOptouts: async (ownStationId, ids) => { calls.optoutRemoved.push([ownStationId, [...ids]]); state.optouts = state.optouts.filter((row) => !ids.includes(row.channelId)); return ids.length; },
      addChannelOptouts: async (ownStationId, ids) => { calls.optoutAdded.push([ownStationId, [...ids]]); state.optouts.push(...ids.map((channelId) => ({ ownStationId, channelId, atMs: 1 }))); return ids.length; },
      markRuleStartSource: async (id, source) => { calls.marked.push([id, source]); return true; },
      archiveRule: async (id, options) => { calls.archived.push([id, options]); state.rules = state.rules.filter((rule) => rule.id !== id); return { ruleId: id }; },
    },
  };
  const module = createChannelProfitModule(rt, { identify: async () => ({ ok: true, stale: false, channels: identified, revealIssues }), randomId: () => "request-1" });
  return { module, calls, state, rt };
}

const running = (id, channelIds) => ({ id, enabled: true, archivedAt: null, ownStationId: "own", channels: channelIds.map((channelId) => ({ channelId })) });

test("status：没装读取服务不能开始；每个渠道是在算 / 能开始 / 不能开始（写明原因）；同一把 Key 的渠道连成一组", async () => {
  const f = fixture({ channels: [1, 2, 3, 4, 5, 6, 7, 8], configured: false, identified: [] });
  assert.deepEqual(await f.module.status("own"), { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" });

  const g = fixture({ channels: [1, 2, 3, 4, 5, 6, 7, 8, 9], optouts: [{ ownStationId: "own", channelId: 3, atMs: 5 }], rules: [running("r-live", [9])], revealIssues: [{ upstreamStationId: "up1", channelIds: [6] }], identified: [
    { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }, // 同一把 Key
    { channelId: 3, keyless: false, slots: [slot("up2", 22)] },
    { channelId: 4, keyless: true },
    { channelId: 5, keyless: false, slots: [{ index: 0, state: "not_found" }] },
    { channelId: 6, keyless: false, slots: [{ index: 0, state: "ambiguous", matches: [{ stationId: "up1", tokenId: 1 }, { stationId: "up1", tokenId: 2 }] }] },
    { channelId: 7, keyless: false, slots: [{ index: 0, state: "unresolved" }] },
    { channelId: 8, keyless: false, slots: [{ index: 0, state: "identified", matches: [{ stationId: "ghost", tokenId: 3 }] }] },
    { channelId: 9, keyless: false, slots: [slot("up1", 99)] },
  ] });
  const status = await g.module.status("own");
  assert.equal(status.ok, true);
  const by = Object.fromEntries(status.channels.map((channel) => [channel.channelId, channel]));
  assert.deepEqual([by[1].state, by[1].groupKey, by[2].groupKey], ["startable", "up1:11", "up1:11"]);
  assert.deepEqual([by[3].state, by[3].optedOut], ["startable", true], "停过的渠道还能点「开始算利润」");
  assert.deepEqual([by[4].reason, by[5].reason, by[6].reason, by[7].reason, by[8].reason], ["KEYLESS", "CHANNEL_KEY_UNMATCHED", "KEY_REVEAL_DENIED", "KEY_UNRESOLVED", "UPSTREAM_UNSUPPORTED"]);
  assert.deepEqual([by[9].state, by[9].ruleId], ["running", "r-live"]);
  assert.deepEqual(status.groups.map((group) => [group.groupKey, group.channelIds]), [["up1:11", [1, 2]], ["up2:22", [3]]]);
});

test("start：同一把 Key 的渠道自动连成一组带上、上游答了「只给我的渠道用」不用再答、走接入向导的预览+确认、成功后删掉「用户停的」记号", async () => {
  const f = fixture({ channels: [1, 2, 3], optouts: [{ ownStationId: "own", channelId: 2, atMs: 5 }], identified: [
    { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }, { channelId: 3, keyless: false, slots: [slot("up1", 33)] },
  ] });
  const result = await f.module.start({ ownStationId: "own", channelIds: [1] }); // 只勾了渠道 1，渠道 2 用同一把 Key
  assert.deepEqual(result.started, [{ groupKey: "up1:11", ruleId: "rule-0", channelIds: [1, 2] }], "渠道 2 一起带上（它之前停过，用户这次点了开始）");
  assert.deepEqual([result.blocked, result.failed, result.alreadyRunning], [[], [], []]);
  const [input] = f.calls.probe;
  assert.equal(input.requestId, "request-1");
  assert.deepEqual(input.selections, [{ selectionId: "s-up1", stationId: "up1", monitor: false }]);
  assert.deepEqual(input.groups, [{ groupId: "g-0", selectionId: "s-up1", channels: [{ channelId: 1, channelRevision: "r1" }, { channelId: 2, channelRevision: "r2" }],
    reconciliation: { tokenId: 11, coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } } }]);
  assert.deepEqual(f.calls.connect[0], { ...input, previewId: "preview-1" }, "确认用的是同一份输入和预览");
  assert.deepEqual(f.calls.optoutRemoved, [["own", [1, 2]]]);
  assert.deepEqual(f.state.optouts, []);
});

test("start：别处也在用 / 没回答的上游每把 Key 要答一次，没答的不开始；答了的照回答建；认不出的、在算的渠道不送", async () => {
  const f = fixture({ channels: [1, 2, 3, 4], rules: [running("r-live", [4])], identified: [
    { channelId: 1, keyless: false, slots: [slot("up2", 22)] },
    { channelId: 2, keyless: false, slots: [slot("up1", 11)] },
    { channelId: 3, keyless: true },
    { channelId: 4, keyless: false, slots: [slot("up1", 44)] },
  ] });
  const first = await f.module.start({ ownStationId: "own", channelIds: [1, 2, 3, 4] });
  assert.deepEqual(first.blocked, [{ channelId: 3, code: "KEYLESS" }, { channelId: 1, code: "COVERAGE_ANSWER_REQUIRED", groupKey: "up2:22" }]);
  assert.deepEqual(first.alreadyRunning, [{ channelId: 4, ruleId: "r-live" }]);
  assert.deepEqual(first.started.map((item) => item.groupKey), ["up1:11"], "只给我的渠道用的那组照常开始");
  assert.equal(f.calls.probe[0].groups.length, 1, "没答的不送");
  const second = await f.module.start({ ownStationId: "own", channelIds: [1], coverage: { "up2:22": { answer: "none" } } });
  assert.deepEqual(second.started.map((item) => item.groupKey), ["up2:22"]);
  assert.deepEqual(f.calls.probe[1].groups[0].reconciliation.coverageDeclaration, { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
});

test("start：预览或确认没做成的组写进 failed（带码和原因），不当成开始了、不删「用户停的」记号；没装读取服务直接说装好才能开始", async () => {
  const f = fixture({ channels: [1], optouts: [{ ownStationId: "own", channelId: 1, atMs: 5 }], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }],
    connectResult: (input) => ({ complete: false, groups: input.groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [group.groupId], code: "PREVIEW_BASIS_CHANGED", reason: "自营站点有变化", reconciliation: { status: "unavailable" } })) }) });
  const result = await f.module.start({ ownStationId: "own", channelIds: [1] });
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.failed, [{ groupKey: "up1:11", channelIds: [1], code: "PREVIEW_BASIS_CHANGED", reason: "自营站点有变化" }]);
  assert.deepEqual(f.calls.optoutRemoved, []);
  assert.equal(f.state.optouts.length, 1);
  const none = fixture({ channels: [1], configured: false, identified: [] });
  await assert.rejects(none.module.start({ ownStationId: "own", channelIds: [1] }), { code: "KEY_AGENT_NOT_CONFIGURED" });
  await assert.rejects(f.module.start({ ownStationId: "own", channelIds: [] }), { code: "CHANNEL_REQUIRED" });
  await assert.rejects(f.module.start({ ownStationId: "own", channelIds: [999] }), { code: "CHANNEL_SOURCE_CHANGED" });
});

test("stop：这几个渠道所在的绑定整条归档（同一把 Key 的渠道一起停）并记「用户停的」；没在算的渠道只记「用户不要算」", async () => {
  const f = fixture({ channels: [1, 2, 3, 4], rules: [running("r-a", [1, 2]), running("r-b", [3])], identified: [] });
  const result = await f.module.stop({ ownStationId: "own", channelIds: [2, 4] });
  assert.deepEqual(f.calls.archived, [["r-a", { optout: true }]], "停渠道 2：整条 r-a 归档，同一把 Key 的渠道 1 一起停");
  assert.deepEqual(result, { stopped: [{ ruleId: "r-a", channelIds: [1, 2] }], optedOut: [4] });
  assert.deepEqual(f.calls.optoutAdded, [["own", [4]]], "没在算的渠道 4（比如第 3 步取消勾的）只记不要算");
  assert.deepEqual(f.state.rules.map((rule) => rule.id), ["r-b"], "别的绑定不动");
  await assert.rejects(f.module.stop({ ownStationId: "own", channelIds: [] }), { code: "CHANNEL_REQUIRED" });
  await assert.rejects(f.module.stop({ ownStationId: "nope", channelIds: [1] }), { code: "OWN_STATION_UNSET" });
});

const mine = { ...upMine, accountUse: "only_mine" };

test("autoStart：只给我的渠道用的上游，认出的新渠道自动开始（来源记 auto，不碰「用户停的」记号）；别处也在用/没回答的上游、用户停过的渠道（整组）、认不出的不自动开始", async () => {
  const f = fixture({ channels: [1, 2, 3, 4, 5, 6], stations: [own, mine, { ...upShared }, { id: "up3", type: "newapi" }],
    optouts: [{ ownStationId: "own", channelId: 4, atMs: 5 }], identified: [
      { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }, // 同一把 Key：一组
      { channelId: 3, keyless: false, slots: [slot("up2", 22)] }, // 别处也在用
      { channelId: 4, keyless: false, slots: [slot("up1", 44)] }, // 用户停过
      { channelId: 5, keyless: false, slots: [slot("up3", 55)] }, // 上游没回答过
      { channelId: 6, keyless: false, slots: [{ index: 0, state: "not_found" }] }, // 认不出
    ] });
  const result = await f.module.autoStart("own");
  assert.deepEqual(result.started.map((item) => [item.groupKey, item.channelIds]), [["up1:11", [1, 2]]]);
  assert.equal(f.calls.probe.length, 1, "只送自动开始的那一组");
  assert.equal(f.calls.probe[0].groups[0].reconciliation.coverageDeclaration.answer, "none");
  assert.deepEqual(f.calls.optoutRemoved, [], "自动开始不删「用户停的」记号");
  assert.deepEqual(f.calls.marked, [["rule-0", "auto"]], "来源记 auto");
  assert.deepEqual((await fixture({ channels: [1], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] }).module.start({ ownStationId: "own", channelIds: [1] })).started.length, 1);
});

test("autoStart：上游从别处也在用改成只给我的渠道用，已经在等的渠道下一轮就自动开始（每轮重新判断，不用另外触发）", async () => {
  const station = { ...upMine, accountUse: "elsewhere" };
  const f = fixture({ channels: [1], stations: [own, station], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] });
  assert.deepEqual((await f.module.autoStart("own")).started, [], "别处也在用：不自动开始");
  station.accountUse = "only_mine"; // 用户在上游编辑里改了答案
  assert.equal((await f.module.autoStart("own")).started.length, 1);
});

test("autoStart：失败的组退避（10 分钟起、每次翻倍、最多 1 小时），退避期间不再预览；退避到了再试；成功以后清掉", async () => {
  let clock = 1_000_000, failing = true;
  const f = fixture({ channels: [1], stations: [own, mine], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }],
    connectResult: (input) => (failing
      ? { complete: false, groups: input.groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [group.groupId], code: "PREVIEW_BASIS_CHANGED", reconciliation: { status: "unavailable" } })) }
      : { complete: true, groups: input.groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [group.groupId], reconciliation: { status: "configured", ruleId: "rule-x" } })) }) });
  const rtLike = { store: { get: (id) => (id === "own" ? own : id === "up1" ? mine : null) }, channelOnboarding: f.rt.channelOnboarding, reconciliation: f.rt.reconciliation };
  const module = createChannelProfitModule(rtLike, { identify: async () => ({ ok: true, stale: false, channels: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }], revealIssues: [] }), randomId: () => "r", now: () => clock });
  await module.autoStart("own");
  assert.equal(f.calls.probe.length, 1);
  clock += 5 * 60 * 1000; await module.autoStart("own");
  assert.equal(f.calls.probe.length, 1, "10 分钟内不再试");
  clock += 6 * 60 * 1000; await module.autoStart("own");
  assert.equal(f.calls.probe.length, 2, "10 分钟到了再试");
  clock += 15 * 60 * 1000; await module.autoStart("own");
  assert.equal(f.calls.probe.length, 2, "第二次失败以后退避翻倍到 20 分钟，15 分钟不够");
  failing = false; clock += 10 * 60 * 1000;
  assert.equal((await module.autoStart("own")).started.length, 1);
  assert.equal(rtLike._autoStartBackoff.size, 0, "成功以后退避清掉");
});

// 「渠道」页签的整份数据（K2d）
const seg = (extra) => ({ effectiveFrom: 0, effectiveTo: null, group: "a", ratio: 1.2, timingSource: "operator_confirmed", keys: [], ...extra });
function overviewFixture(args) {
  const f = fixture(args);
  const segments = args.segments || {};
  f.rt.reconciliation.listSegmentsForRules = async (ids) => Object.fromEntries(ids.map((id) => [id, segments[id] || []]));
  f.rt.store.list = () => args.stations || [own, upMine, upShared];
  return f;
}
const live = (id, channelIds, extra = {}) => ({ ...running(id, channelIds), upstreamStationId: "up1", tokenId: 11, tokenName: "oai", createdAt: "2026-10-10T00:00:00Z", billingEffectiveFrom: Date.parse("2026-10-10T00:00:00Z"),
  billingPolicy: "immediate", costCoverage: "complete", coverageDeclaration: { answer: "none" }, keyIssue: null, ...extra });

test("overview：没装读取服务——照样列出在算的渠道（从绑定读），reader 写明不能开始的原因", async () => {
  const f = overviewFixture({ channels: [1, 2], configured: false, identified: [], rules: [live("r1", [1])], segments: { r1: [seg({ keys: [{ upstreamStationId: "up1", tokenId: 11, tokenName: "oai" }] })] } });
  const view = await f.module.overview("own");
  assert.deepEqual(view.reader, { state: "not_configured", code: "KEY_AGENT_NOT_CONFIGURED" });
  assert.deepEqual(view.cards.map((card) => [card.state, card.names, card.upstreamStationId, card.startedBy]), [["running", ["渠道1"], "up1", "user"]]);
  assert.deepEqual(view.cards[0].keys.map((line) => [line.key.tokenName, line.group, line.ratio, line.toMs]), [["oai", "a", 1.2, null]]);
  assert.deepEqual(view.unmatched, []);
});

test("overview：一个渠道只一种状态（需处理 > 在算 > 没算）；同一把 Key 的几个渠道一张卡片；自动开始的带来源；上游一行的数；没对上上游的列在 unmatched", async () => {
  const f = overviewFixture({ channels: [1, 2, 3, 4, 5, 6, 7], optouts: [{ ownStationId: "own", channelId: 3, atMs: 5 }],
    rules: [live("r-auto", [1, 2], { startSource: "auto" }), live("r-bad", [7], { upstreamStationId: "up2", tokenId: 22, keyIssue: { code: "CHANNEL_KEY_UNMATCHED", sinceMs: 5 } })],
    identified: [
      { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] },
      { channelId: 3, keyless: false, slots: [slot("up1", 33)] }, { channelId: 4, keyless: false, slots: [{ index: 0, state: "not_found" }] },
      { channelId: 5, keyless: true }, { channelId: 6, keyless: false, slots: [{ index: 0, state: "ambiguous", matches: [{ stationId: "up2", tokenId: 1 }] }] },
      { channelId: 7, keyless: false, slots: [slot("up2", 22)] },
    ], revealIssues: [{ upstreamStationId: "up2", channelIds: [6] }] });
  const view = await f.module.overview("own");
  assert.equal(view.reader.state, "ok");
  const by = Object.fromEntries(view.cards.map((card) => [card.id, card]));
  assert.deepEqual([by["rule:r-auto"].state, by["rule:r-auto"].names, by["rule:r-auto"].startedBy], ["running", ["渠道1", "渠道2"], "auto"]);
  assert.deepEqual([by["rule:r-bad"].state, by["rule:r-bad"].issues], ["attention", ["CHANNEL_KEY_UNMATCHED"]]);
  assert.deepEqual([by["key:up1:33"].state, by["key:up1:33"].optedOut, by["key:up1:33"].needsCoverage, by["key:up1:33"].startGroupKey], ["stopped", true, false, "up1:33"]);
  assert.deepEqual(view.unmatched.map((item) => [item.channelId, item.reason]), [[4, "CHANNEL_KEY_UNMATCHED"], [5, "KEYLESS"], [6, "KEY_REVEAL_DENIED"]]);
  assert.equal(view.unmatched[2].upstreamStationId, "up2");
  const up = Object.fromEntries(view.upstreams.map((item) => [item.id, item]));
  assert.deepEqual([up.up1.channelCount, up.up1.runningCount, up.up1.attentionCount, up.up1.accountUse], [3, 2, 0, "only_mine"]);
  assert.deepEqual([up.up2.channelCount, up.up2.runningCount, up.up2.attentionCount], [1, 1, 2], "卡片上一件事 + 读完整 Key 的权限一件事");
});

test("overview：没回答的绑定进需处理（COST_COVERAGE_UNKNOWN）；别处也在用的上游里没在算的渠道，开始前要回答（needsCoverage）；用过的 Key 取自已停的绑定的分段，新的在前", async () => {
  const oldKey = { upstreamStationId: "up1", tokenId: 11, tokenName: "oai" }, newKey = { upstreamStationId: "up2", tokenId: 22, tokenName: "oai-2" };
  const stopped = { ...live("r-old", [1]), enabled: false, archivedAt: "2026-10-12T00:00:00Z" };
  const f = overviewFixture({ channels: [1, 2], identified: [{ channelId: 1, keyless: false, slots: [slot("up2", 22, "oai-2")] }, { channelId: 2, keyless: false, slots: [slot("up2", 22, "oai-2")] }],
    rules: [stopped, live("r-new", [1], { upstreamStationId: "up2", tokenId: 22, tokenName: "oai-2", createdAt: "2026-10-12T00:00:00Z", billingEffectiveFrom: Date.parse("2026-10-12T00:00:00Z"), costCoverage: "unknown", coverageDeclaration: { answer: "unknown" } })],
    segments: { "r-old": [seg({ effectiveTo: Date.parse("2026-10-12T00:00:00Z"), keys: [oldKey] })], "r-new": [seg({ keys: [newKey], ratio: null })] } });
  // 假仓库的 listRules 不看 includeArchived：把已停的也放进去，由模块自己按 enabled 分
  const view = await f.module.overview("own");
  const card = view.cards.find((item) => item.id === "rule:r-new");
  assert.deepEqual([card.state, card.issues], ["attention", ["COST_COVERAGE_UNKNOWN"]]);
  assert.deepEqual(card.keys.map((line) => [line.key.tokenName, line.toMs === null]), [["oai-2", true], ["oai", false]], "新的在前");
  const free = view.cards.find((item) => item.id === "key:up2:22");
  assert.deepEqual([free.state, free.channelIds, free.needsCoverage], ["stopped", [2], true]);
});

test("overview：答了「别处也在用」的渠道需处理写 COST_SHARED_ELSEWHERE（利润先不算，要换 Key 或停止），不再是没回答的那一条", async () => {
  const f = overviewFixture({ channels: [1], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }],
    rules: [live("r1", [1], { costCoverage: "unknown", coverageDeclaration: { answer: "other_use", otherUse: "external" } })] });
  const view = await f.module.overview("own");
  assert.deepEqual(view.cards.map((card) => [card.state, card.issues]), [["attention", ["COST_SHARED_ELSEWHERE"]]]);
});

test("answerCoverage：只改在算的绑定的回答——走绑定编辑的「预览 + 保存」（渠道、Key 都不变）；没在算的、回答不对都不写", async () => {
  const f = fixture({ channels: [1, 2], identified: [], rules: [{ ...running("r1", [1, 2]), upstreamStationId: "up2", tokenId: 22, timezone: "Asia/Shanghai" }] });
  const calls = [];
  f.rt.channelOnboarding.probeRuleEdit = async (id, body) => { calls.push(["probe", id, body]); return { previewId: "p1", groupId: "g1" }; };
  f.rt.channelOnboarding.getPreviewGuard = (previewId, groupId) => ({ previewId, groupId });
  f.rt.reconciliation.updateRule = async (id, body, options) => { calls.push(["update", id, body, options]); return { id }; };
  const result = await f.module.answerCoverage({ ownStationId: "own", ruleId: "r1", coverage: { answer: "none" } });
  assert.deepEqual(result, { ruleId: "r1", answer: "none" });
  const body = { upstreamStationId: "up2", tokenId: 22, salesChannelIds: [1, 2], timezone: "Asia/Shanghai", enabled: true, coverageDeclaration: { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] } };
  assert.deepEqual(calls, [["probe", "r1", body], ["update", "r1", body, { previewGuard: { previewId: "p1", groupId: "g1" } }]]);
  await assert.rejects(f.module.answerCoverage({ ownStationId: "own", ruleId: "r-gone", coverage: { answer: "none" } }), { code: "RULE_NOT_FOUND" });
  await assert.rejects(f.module.answerCoverage({ ownStationId: "own", ruleId: "r1", coverage: { answer: "bogus" } }), { code: "INVALID_REQUEST" });
  assert.equal(calls.length, 2, "答案不对不去预览");
});

test("status：打码撞了但 reveal 只是暂时失败（revealIssues 里没有这个渠道）不报少权限，报 KEY_UNRESOLVED（会自己好）", async () => {
  const f = fixture({ channels: [1], identified: [{ channelId: 1, keyless: false, slots: [{ index: 0, state: "ambiguous", matches: [{ stationId: "up1", tokenId: 1 }, { stationId: "up1", tokenId: 2 }] }] }] });
  assert.equal((await f.module.status("own")).channels[0].reason, "KEY_UNRESOLVED");
});

test("status：几把 Key 的渠道也在用的 Key——和它共用这把 Key 的渠道不能开始（KEY_SHARED_WITH_MULTI_KEY，写明和哪个渠道共用），不建绑定；这把 Key 没人共用的组不受影响", async () => {
  const f = fixture({ channels: [1, 2, 3, 4], identified: [
    { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }, // A、B 用 K11
    { channelId: 3, keyless: false, slots: [slot("up1", 11), slot("up1", 99)].map((item, index) => ({ ...item, index })) }, // C 用两把，其中一把是 K11
    { channelId: 4, keyless: false, slots: [slot("up1", 44)] },
  ] });
  const status = await f.module.status("own");
  const by = Object.fromEntries(status.channels.map((channel) => [channel.channelId, channel]));
  assert.deepEqual([by[1], by[2]].map((channel) => [channel.state, channel.reason, channel.sharedWithChannelIds]), [["blocked", "KEY_SHARED_WITH_MULTI_KEY", [3]], ["blocked", "KEY_SHARED_WITH_MULTI_KEY", [3]]]);
  assert.equal(by[3].reason, "MULTI_KEY");
  assert.deepEqual([by[4].state, status.groups.map((group) => group.groupKey)], ["startable", ["up1:44"]]);
  const result = await f.module.start({ ownStationId: "own", channelIds: [1, 2, 4] });
  assert.deepEqual(result.blocked.map((item) => [item.channelId, item.code]), [[1, "KEY_SHARED_WITH_MULTI_KEY"], [2, "KEY_SHARED_WITH_MULTI_KEY"]]);
  assert.deepEqual(result.started.map((item) => item.channelIds), [[4]], "共用 Key 的那组不建绑定，别的组照常");
});

test("start：fresh——识别缓存没过期时也重新问；一组的回答格式不对只算这一组没答，别的组照常开始", async () => {
  const asked = [];
  const f = fixture({ channels: [1, 2], identified: [] });
  const channels = [{ channelId: 1, keyless: false, slots: [slot("up2", 22)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }];
  const module = createChannelProfitModule(f.rt, { identify: async (rt, own, options) => { asked.push(options?.fresh === true); return { ok: true, stale: false, channels, revealIssues: [] }; }, randomId: () => "request-1" });
  const result = await module.start({ ownStationId: "own", channelIds: [1, 2], coverage: { "up2:22": { answer: "bogus" } } });
  assert.ok(asked.includes(true), "开始前重新问读取服务");
  assert.deepEqual(result.blocked.map((item) => [item.channelId, item.code]), [[1, "COVERAGE_ANSWER_REQUIRED"]]);
  assert.deepEqual(result.started.map((item) => item.channelIds), [[2]]);
});

test("start 和 stop 同一个自营站点一个一个来：同时点开始和停止，停止看到的是开始已经提交的结果；同时停止两次，第二次当成已经停了", async () => {
  const f = fixture({ channels: [1], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] });
  // 假的 connectBatch 让出一下事件循环：不排队的话 stop 会在 start 提交以前读到「没在算」
  const connect = f.rt.channelOnboarding.connectBatch;
  f.rt.channelOnboarding.connectBatch = async (input) => { await new Promise((resolve) => setTimeout(resolve, 5)); const result = await connect(input); f.state.rules.push(running("rule-0", [1])); return result; };
  const [started, stopped] = await Promise.all([f.module.start({ ownStationId: "own", channelIds: [1] }), f.module.stop({ ownStationId: "own", channelIds: [1] })]);
  assert.equal(started.started.length, 1);
  assert.deepEqual(stopped.stopped.map((item) => item.ruleId), ["rule-0"], "停止排在开始后面，看到了刚建好的绑定，真的停了它");
  assert.equal(f.state.rules.length, 0);
  // 同时停止两次：第二次 archiveRule 报 RULE_NOT_FOUND，当成已经停了
  f.state.rules.push(running("rule-1", [1]));
  const archive = f.rt.reconciliation.archiveRule;
  f.rt.reconciliation.archiveRule = async (id, options) => { if (f.state.rules.every((rule) => rule.id !== id)) throw Object.assign(new Error("gone"), { code: "RULE_NOT_FOUND" }); return archive(id, options); };
  const both = await Promise.all([f.module.stop({ ownStationId: "own", channelIds: [1] }), f.module.stop({ ownStationId: "own", channelIds: [1] })]);
  assert.deepEqual(both.map((item) => item.stopped.length + item.optedOut.length), [1, 1]);
});

test("stop：一次最多 1000 个渠道；不在渠道目录也不在在算的绑定里的编号不往「用户不要算」里写", async () => {
  const f = fixture({ channels: [1, 2], identified: [] });
  await assert.rejects(f.module.stop({ ownStationId: "own", channelIds: Array.from({ length: 1001 }, (_, index) => index + 1) }), { code: "INVALID_REQUEST" });
  await assert.rejects(f.module.stop({ ownStationId: "own", channelIds: [2, 999] }), { code: "CHANNEL_SOURCE_CHANGED" });
  assert.deepEqual(f.calls.optoutAdded, [], "编号不对整次都不写");
  assert.deepEqual(await f.module.stop({ ownStationId: "own", channelIds: [2] }), { stopped: [], optedOut: [2] });
});

test("autoStart：缓存识别里不在停过的组里、fresh 识别里却认出和停过的渠道是同一把 Key——start() 用 fresh 的组再判断一遍，整组不自动开始（不是失败，不退避）", async () => {
  const unresolved = { channelId: 1, keyless: false, slots: [{ index: 0, state: "unresolved" }] };
  const channel2 = { channelId: 2, keyless: false, slots: [slot("up1", 11)] };
  const f = fixture({ channels: [1, 2], stations: [own, mine], optouts: [{ ownStationId: "own", channelId: 1, atMs: 5 }], identified: [] });
  const module = createChannelProfitModule(f.rt, { identify: async (rt, ownStation, options) => ({ ok: true, stale: false, revealIssues: [],
    channels: options?.fresh ? [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }, channel2] : [unresolved, channel2] }), randomId: () => "request-1" });
  const result = await module.autoStart("own");
  assert.deepEqual(result.started, []);
  assert.equal(f.calls.probe.length, 0, "没送预览：停过的渠道 1 不会被带进去");
  assert.equal(f.rt._autoStartBackoff.size, 0, "不是失败，不退避");
  assert.deepEqual(f.calls.marked, []);
});

test("autoStart：一轮最多 3 组，合成一次预览和确认；剩下的下一轮再做", async () => {
  const ids = [1, 2, 3, 4, 5];
  const f = fixture({ channels: ids, stations: [own, mine], identified: ids.map((id) => ({ channelId: id, keyless: false, slots: [slot("up1", 10 + id)] })) });
  const result = await f.module.autoStart("own");
  assert.equal(f.calls.probe.length, 1, "一次预览");
  assert.equal(f.calls.connect.length, 1, "一次确认");
  assert.deepEqual(f.calls.connect[0].groups.map((group) => group.channels.map((channel) => channel.channelId)), [[1], [2], [3]], "最多 3 组");
  assert.equal(result.started.length, 3);
});

test("autoStart：新渠道追加进已有的绑定（用户点开始建的）时，只给新建的绑定记来源 auto，已有的那条不动", async () => {
  const f = fixture({ channels: [1, 2], stations: [own, mine], rules: [running("user-rule", [1])],
    identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }],
    connectResult: (input) => ({ complete: true, groups: input.groups.map((group) => ({ groupId: group.groupId, requestedGroupIds: [group.groupId], reconciliation: { status: "configured", ruleId: "user-rule" } })) }) });
  const result = await f.module.autoStart("own");
  assert.equal(result.started.length, 1);
  assert.deepEqual(f.calls.marked, [], "追加进用户的绑定：不记 auto");
});

test("status：上游已经删了（归档）的渠道不能开始（识别缓存最多 4 分钟，还会认）；退避记录只留还在等的组", async () => {
  const f = fixture({ channels: [1], stations: [own, { ...mine, archivedAt: "2026-10-11T00:00:00Z" }], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] });
  assert.equal((await f.module.status("own")).channels[0].reason, "CHANNEL_KEY_UNMATCHED");
  const g = fixture({ channels: [1], stations: [own, mine], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] });
  g.rt._autoStartBackoff = new Map([["own:up1:99", { nextAt: Infinity, delayMs: 1 }], ["other:up1:11", { nextAt: Infinity, delayMs: 1 }]]);
  await g.module.autoStart("own");
  assert.deepEqual([...g.rt._autoStartBackoff.keys()], ["other:up1:11"], "这个站点下不再出现的组清掉，别的站点的不动");
});

test("overview：几把 Key 的渠道写在它用的上游下面（blocked 卡片，写几把），和它共用 Key 的组一张 blocked 卡片（写和哪个渠道共用）；都不进 unmatched，也不算在算", async () => {
  const f = overviewFixture({ channels: [1, 2, 3, 4], identified: [
    { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }, // 共用 K11
    { channelId: 3, keyless: false, slots: [slot("up1", 11), { ...slot("up2", 22), index: 1 }] },
    { channelId: 4, keyless: false, slots: [slot("up1", 44)] },
  ] });
  const view = await f.module.overview("own");
  const byId = Object.fromEntries(view.cards.map((card) => [card.id, card]));
  assert.deepEqual([byId["shared:up1:11"].state, byId["shared:up1:11"].channelIds, byId["shared:up1:11"].blocked], ["blocked", [1, 2], { code: "KEY_SHARED_WITH_MULTI_KEY", sharedWith: ["渠道3"] }]);
  assert.deepEqual([byId["multi:3:up1"].state, byId["multi:3:up1"].blocked, byId["multi:3:up2"].upstreamStationId], ["blocked", { code: "MULTI_KEY", keyCount: 2 }, "up2"], "几把 Key 的渠道写在它用到的每个上游下面");
  assert.equal(byId["key:up1:44"].state, "stopped", "别的组照常");
  assert.deepEqual(view.unmatched, []);
  const upstream = Object.fromEntries(view.upstreams.map((item) => [item.id, item]));
  assert.equal(upstream.up1.runningCount, 0, "blocked 卡片不算在算");
});

test("overview：渠道今天上午属于停掉的绑定、又要追加进别的在算绑定——一张 blocked 卡片写停的时刻和原来那把 Key（COUNTED_EARLIER_TODAY），不进 unmatched，不算在算", async () => {
  const clock = Date.parse("2026-10-11T06:00:00Z"); // 上海 14:00
  const stopped = { ...running("r-old", [3]), enabled: false, archivedAt: "2026-10-11T02:00:00.000Z", archivedAtMs: Date.parse("2026-10-11T02:00:00Z"), timezone: "Asia/Shanghai", tokenName: "oai" };
  const f = overviewFixture({ channels: [1, 3], rules: [{ ...running("r-a", [1]), upstreamStationId: "up1", tokenId: 11 }], identified: [
    { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 3, keyless: false, slots: [slot("up1", 11)] }] });
  f.rt.reconciliation.listRecentlyArchivedRules = async () => [stopped];
  const module = createChannelProfitModule(f.rt, { identify: async () => ({ ok: true, stale: false, revealIssues: [], channels: [
    { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 3, keyless: false, slots: [slot("up1", 11)] }] }), now: () => clock });
  const view = await module.overview("own");
  const card = view.cards.find((item) => item.blocked?.code === "COUNTED_EARLIER_TODAY");
  assert.deepEqual([card.state, card.channelIds, card.blocked.stoppedAtMs, card.blocked.tokenName], ["blocked", [3], Date.parse("2026-10-11T02:00:00Z"), "oai"]);
  assert.deepEqual(view.unmatched, []);
  assert.equal((await module.status("own")).groups.length, 0, "今天不能开始");
});
