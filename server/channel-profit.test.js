import assert from "node:assert/strict";
import test from "node:test";
import { createChannelProfitModule } from "./channel-profit.js";

const KEY_AGENT_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const own = { id: "own", isOwn: true, type: "newapi", keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: KEY_AGENT_SECRET };
const upMine = { id: "up1", type: "newapi", accountUse: "only_mine" };
const upShared = { id: "up2", type: "sub2api", accountUse: "elsewhere" };

const slot = (stationId, tokenId, tokenName = `k${tokenId}`) => ({ index: 0, state: "identified", matches: [{ stationId, tokenId, tokenName, via: "fingerprint" }] });

// 假的运行时：渠道目录、读取服务认出的结果、绑定、「用户停的」都放在内存里；接入向导的 probeBatch / connectBatch 只记下收到的输入
function fixture({ channels, identified, rules = [], optouts = [], stations = [own, upMine, upShared], configured = true, connectResult = null }) {
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
  const module = createChannelProfitModule(rt, { identify: async () => ({ ok: true, stale: false, channels: identified, revealIssues: [] }), randomId: () => "request-1" });
  return { module, calls, state };
}

const running = (id, channelIds) => ({ id, enabled: true, archivedAt: null, ownStationId: "own", channels: channelIds.map((channelId) => ({ channelId })) });

test("status：没装读取服务不能开始；每个渠道是在算 / 能开始 / 不能开始（写明原因）；同一把 Key 的渠道连成一组", async () => {
  const f = fixture({ channels: [1, 2, 3, 4, 5, 6, 7, 8], configured: false, identified: [] });
  assert.deepEqual(await f.module.status("own"), { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" });

  const g = fixture({ channels: [1, 2, 3, 4, 5, 6, 7, 8, 9], optouts: [{ ownStationId: "own", channelId: 3, atMs: 5 }], rules: [running("r-live", [9])], identified: [
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
  assert.deepEqual([by[4].reason, by[5].reason, by[6].reason, by[7].reason, by[8].reason], ["KEYLESS", "KEY_UNMATCHED", "KEY_REVEAL_DENIED", "KEY_UNRESOLVED", "UPSTREAM_UNSUPPORTED"]);
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
