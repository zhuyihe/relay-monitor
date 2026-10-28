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
  const calls = { probe: [], connect: [], archived: [], optoutAdded: [], optoutRemoved: [] };
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

const mine = { ...upMine, accountUse: "only_mine" };

test("autoStart：只给我的渠道用的上游，认出的新渠道自动开始（不碰「用户停的」记号）；别处也在用的上游、用户停过的渠道（整组）、认不出的不自动开始；没设 accountUse 的按只给我的渠道用", async () => {
  const f = fixture({ channels: [1, 2, 3, 4, 5, 6], stations: [own, mine, { ...upShared }, { id: "up3", type: "newapi" }],
    optouts: [{ ownStationId: "own", channelId: 4, atMs: 5 }], identified: [
      { channelId: 1, keyless: false, slots: [slot("up1", 11)] }, { channelId: 2, keyless: false, slots: [slot("up1", 11)] }, // 同一把 Key：一组
      { channelId: 3, keyless: false, slots: [slot("up2", 22)] }, // 别处也在用
      { channelId: 4, keyless: false, slots: [slot("up1", 44)] }, // 用户停过
      { channelId: 5, keyless: false, slots: [slot("up3", 55)] }, // 上游没设过 accountUse：按「只给我的渠道用」，也自动开始
      { channelId: 6, keyless: false, slots: [{ index: 0, state: "not_found" }] }, // 认不出
    ] });
  const result = await f.module.autoStart("own");
  assert.deepEqual(result.started.map((item) => [item.groupKey, item.channelIds]).sort(), [["up1:11", [1, 2]], ["up3:55", [5]]]);
  assert.equal(f.calls.probe.length, 1, "自动开始的几组合成一次预览");
  assert.equal(f.calls.probe[0].groups[0].reconciliation.coverageDeclaration.answer, "none");
  assert.deepEqual(f.calls.optoutRemoved, [], "自动开始不删「用户停的」记号");
  assert.deepEqual((await fixture({ channels: [1], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] }).module.start({ ownStationId: "own", channelIds: [1] })).started.length, 1);
});

test("autoStart：没设 accountUse 的上游下认出新渠道就自动开始（默认每把 Key 只给用户站上的渠道用，不出「去回答」），覆盖声明记「只给这些渠道用」", async () => {
  const f = fixture({ channels: [1], stations: [own, { id: "up1", type: "newapi" }], identified: [{ channelId: 1, keyless: false, slots: [slot("up1", 11)] }] });
  const result = await f.module.autoStart("own");
  assert.deepEqual(result.started.map((item) => [item.groupKey, item.channelIds]), [["up1:11", [1]]]);
  assert.equal(f.calls.probe[0].groups[0].reconciliation.coverageDeclaration.answer, "none");
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

test("status：同一把 Key 在两个上游里都有——这一版不算，只提示（KEY_IN_OTHER_UPSTREAM，带两个上游的编号），不进 groups", async () => {
  const f = fixture({ channels: [1], identified: [{ channelId: 1, keyless: false, slots: [{ index: 0, state: "ambiguous", matches: [{ stationId: "up1", tokenId: 1 }, { stationId: "up2", tokenId: 7 }] }] }] });
  const status = await f.module.status("own");
  assert.deepEqual([status.channels[0].state, status.channels[0].reason, status.channels[0].upstreamStationIds, status.groups], ["blocked", "KEY_IN_OTHER_UPSTREAM", ["up1", "up2"], []]);
});

test("options：渠道带自己的地址；绑了的带上游、Key（名、分组）、从哪天绑的；没绑的带地址对得上的上游；Key 列表读不到时分组是空", async () => {
  const f = fixture({ channels: [1, 2, 3], identified: [], stations: [own, { ...upMine, id: "up1", type: "newapi", baseUrl: "https://a.test" }] });
  const all = [own, { ...upMine, id: "up1", type: "newapi", baseUrl: "https://a.test" }];
  f.rt.store.list = () => all; f.rt.store.get = (id) => all.find((station) => station.id === id) || null;
  const catalogue = f.rt.channelOnboarding.getSourceCatalogue;
  f.rt.channelOnboarding.getSourceCatalogue = () => { const value = catalogue(); value.channels = value.channels.map((channel) => ({ ...channel, status: channel.id === 2 ? 2 : channel.id === 3 ? 3 : 1, baseUrl: channel.id === 3 ? "https://a.test/v1" : "https://x.test/api" })); return value; };
  const rule = (id, channelId, tokenId) => ({ id, enabled: true, archivedAt: null, ownStationId: "own", upstreamStationId: "up1", tokenId, tokenName: `k${tokenId}`, timezone: "Asia/Shanghai", billingPolicy: "immediate",
    billingEffectiveFrom: Date.parse("2026-10-20T04:00:00Z"), createdAt: "2026-10-20T04:00:00Z", channels: [{ channelId }] });
  f.state.rules = [rule("r1", 1, 11), rule("r2", 2, 12)];
  f.rt.reconciliation.upstreamTokens = async () => [{ id: 11, status: 1, group: "default" }];
  const out = await f.module.options("own");
  const by = Object.fromEntries(out.channels.map((channel) => [channel.channelId, channel]));
  assert.deepEqual([by[1].address, by[1].upstreamStationId, by[1].tokenName, by[1].tokenGroup, by[1].sinceDay], ["x.test", "up1", "k11", "default", "2026-10-20"]);
  assert.deepEqual([by[2].tokenGroup], [null], "Key 不在列表里：分组空");
  assert.deepEqual([by[3].ruleId, by[3].address, by[3].suggestedUpstreamId], [null, "a.test", "up1"], "没绑的：带地址和对得上的上游");
  assert.deepEqual([by[1].enabled, by[2].enabled, by[3].enabled], [true, false, false], "启用 / 禁用来自渠道目录的 status：1 是启用，别的算禁用");
  assert.deepEqual(out.upstreams, [{ id: "up1", name: undefined }].map((item) => ({ id: item.id, name: all[1].name })));
});
