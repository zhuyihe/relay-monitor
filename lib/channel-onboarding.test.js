import test from "node:test";
import assert from "node:assert/strict";
import { channelConnectionRule, pendingChannelConnections, normalizeBatchInput, coalesceVerifiedBatchGroups } from "./channel-onboarding.js";

test("discovery preserves sales groups and offers both accounts at a shared URL without choosing by group", () => {
  const upstreams = [
    { id: "alice", type: "newapi", baseUrl: "https://up.example/", name: "A" },
    { id: "bob", type: "newapi", baseUrl: "https://up.example", name: "B" },
    { id: "path", type: "newapi", baseUrl: "https://up.example/other" },
    { id: "own", type: "newapi", baseUrl: "https://up.example", isOwn: true },
  ];
  const [entry] = pendingChannelConnections({ channels: [{ id: 3, baseUrl: "HTTPS://UP.EXAMPLE/", groups: ["sales"] }], upstreams });
  assert.deepEqual(entry.candidates.map((item) => item.id), ["alice", "bob"]);
  assert.deepEqual(entry.groups, ["sales"]);
});

test("only active bindings hide a discovered channel, and absent URLs cannot match every upstream", () => {
  const entries = pendingChannelConnections({
    channels: [{ id: 1 }, { id: 2, baseUrl: "" }, { id: 3 }, { id: 4 }],
    upstreams: [{ id: "up", type: "newapi", baseUrl: "" }],
    rules: [
      { enabled: true, channels: [{ channelId: "1" }] },
      { enabled: false, channels: [{ channelId: 2 }] },
      { enabled: true, archivedAt: "2026-10-09", channels: [{ channelId: 3 }] },
    ],
  });
  assert.deepEqual(entries.map((entry) => entry.id), [2, 3, 4]);
  assert.deepEqual(entries[0].candidates, []);
});

test("existing Key binding is scoped to the own station, upstream account and token ID", () => {
  const rules = [
    { id: "other-own", ownStationId: "old", upstreamStationId: "up", tokenId: 1, enabled: true },
    { id: "other-account", ownStationId: "own", upstreamStationId: "up-2", tokenId: 1, enabled: true },
    { id: "stopped", ownStationId: "own", upstreamStationId: "up", tokenId: 1, enabled: false },
    { id: "active", ownStationId: "own", upstreamStationId: "up", tokenId: "1", enabled: true },
  ];
  assert.equal(channelConnectionRule(rules, "own", "up", 1)?.id, "active");
  assert.equal(channelConnectionRule(rules, "own", "up", 2), null);
});

test("a different own station's numeric channel ID cannot hide a new channel", () => {
  const entries = pendingChannelConnections({
    ownStation: { id: "current" }, channels: [{ id: 1 }],
    rules: [{ enabled: true, ownStationId: "previous", channels: [{ channelId: 1 }] }],
  });
  assert.equal(entries.length, 1);
});

const batchInput = () => ({ requestId: "4a102bfe-f680-4ad8-92ac-26e732b07c9b", ownStationId: "own",
  selections: [{ selectionId: "supplier", monitor: true, newStation: { type: "sub2api-password", baseUrl: "https://up.test/",
    email: "a@example", password: " p ", accessToken: "hidden", verifiedIdentity: { accountId: "forged" }, onboardingOrigin: { requestId: "forged" } } }],
  groups: [{ groupId: "sales", selectionId: "supplier", channels: [{ channelId: 1, channelRevision: "rev1" }],
    reconciliation: { tokenId: 8, coverageDeclaration: { answer: "none" } } }] });

test("batch normalization keeps applicable credentials and explicit intent, rejects cross-group channel duplication", () => {
  const input = batchInput(), normalized = normalizeBatchInput(input);
  assert.deepEqual(normalized.selections[0].newStation, { type: "sub2api-password", baseUrl: "https://up.test", email: "a@example", password: " p " });
  assert.deepEqual(normalized.groups[0].reconciliation.coverageDeclaration, { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
  assert.equal(JSON.stringify(normalized).includes("forged"), false);
  input.groups.push({ ...input.groups[0], groupId: "duplicate" });
  assert.throws(() => normalizeBatchInput(input), (error) => error.code === "INVALID_REQUEST");
  assert.throws(() => normalizeBatchInput({ ...batchInput(), selections: [{ selectionId: "key", monitor: false,
    newStation: { type: "newapi-key", baseUrl: "https://up.test", apiKey: "key" } }] }), /必须请求监控/);
});

test("batch normalization enforces 100-channel/group bounds while Key choice can remain pending", () => {
  const input = batchInput();
  delete input.groups[0].reconciliation.tokenId;
  input.groups[0].channels = Array.from({ length: 100 }, (_, index) => ({ channelId: index + 1, channelRevision: `rev${index}` }));
  assert.equal(normalizeBatchInput(input).groups[0].channels.length, 100);
  input.groups[0].channels.push({ channelId: 101, channelRevision: "extra" });
  assert.throws(() => normalizeBatchInput(input), /1 至 100/);
  const duplicate = batchInput();
  duplicate.selections.push(duplicate.selections[0]);
  assert.throws(() => normalizeBatchInput(duplicate), /标识重复/);
});

test("only verified canonical Key/namespace groups coalesce and all requested IDs survive", () => {
  const base = { groupId: "one", selectionId: "account", canonicalKey: "key-a", ownNamespaceKey: "own-a",
    authorizationIntent: "existing:account", reconciliation: { tokenId: 8, timezone: "Asia/Shanghai", coverageDeclaration: { answer: "none" } },
    channels: [{ channelId: 1, channelRevision: "rev1" }] };
  const groups = coalesceVerifiedBatchGroups([base, { ...base, groupId: "two", channels: [{ channelId: 2, channelRevision: "rev2" }] },
    { ...base, groupId: "other-key", canonicalKey: "key-b", channels: [{ channelId: 3, channelRevision: "rev3" }] },
    { ...base, groupId: "unverified", canonicalKey: null, channels: [{ channelId: 4, channelRevision: "rev4" }] }]);
  assert.deepEqual(groups.map((group) => group.requestedGroupIds), [["one", "two"], ["other-key"], ["unverified"]]);
  assert.deepEqual(groups[0].channels.map((channel) => channel.channelId), [1, 2]);
  assert.throws(() => coalesceVerifiedBatchGroups([base, { ...base, groupId: "conflict", reconciliation: { ...base.reconciliation,
    coverageDeclaration: { answer: "unknown" } } }]), /使用范围/);
});
