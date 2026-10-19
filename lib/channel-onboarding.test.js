import test from "node:test";
import assert from "node:assert/strict";
import { ONBOARDING_KEY_ONLY_MONITOR, channelConnectionRule, pendingChannelConnections, normalizeBatchInput, normalizeCoverageDeclaration, coalesceVerifiedBatchGroups, groupOnboardingResources } from "./channel-onboarding.js";
import { COVERAGE_ANSWERS, coverageDeclarationOf } from "./reconciliation-contract.js";
import { describeError } from "./error-copy.js";

// 报错只认 code 和它归到 §8.2 的哪一类；throw 的文字只给开发看，不在这里断言。
const failsAs = (code, category) => (error) => error.code === code && describeError(error).category === category;

test("resource suggestions prioritize links and matching addresses without hiding other accounts", () => {
  const resources = [
    { id: "other", name: "碎", baseUrl: "https://other.test" },
    { id: "alice", baseUrl: "https://up.test/", identity: { accountId: "1" } },
    { id: "bob", baseUrl: "HTTPS://UP.TEST", identity: { accountId: "2" } },
    { id: "path", baseUrl: "https://up.test/other" },
    { id: "linked", baseUrl: "https://panel.test" },
    { id: "candidate", baseUrl: "https://alias.test" },
  ];
  const before = structuredClone(resources);
  const result = groupOnboardingResources(resources, [{ baseUrl: "https://up.test", candidates: [{ id: "candidate" }], monitor: { stationIds: ["linked"] } }]);
  assert.deepEqual(result.matched.map((resource) => resource.id), ["linked", "alice", "bob", "candidate"]);
  assert.deepEqual(result.others.map((resource) => resource.id), ["other", "path"]);
  assert.deepEqual(resources, before);
});

test("resource suggestions support multi-channel batches and never match every missing address", () => {
  const resources = [{ id: "empty", baseUrl: "" }, { id: "one", baseUrl: "https://one.test" }, { id: "two", baseUrl: "https://two.test" }];
  assert.deepEqual(groupOnboardingResources(resources, [{ baseUrl: "" }]), { matched: [], others: resources });
  assert.deepEqual(groupOnboardingResources(resources, [{ baseUrl: "https://one.test/" }, { candidates: ["two"] }]).matched.map((resource) => resource.id), ["one", "two"]);
});

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

test("batch rejects missing or invalid request IDs as an expired page", () => {
  for (const requestId of [undefined, "", "not-a-uuid"]) {
    assert.throws(() => normalizeBatchInput({ ...batchInput(), requestId }), failsAs("INVALID_REQUEST", "expired"));
  }
});

test("an invalid upstream address reads as unreachable, not as an expired page", () => {
  const input = batchInput();
  input.selections[0].newStation.baseUrl = "ftp://up.test";
  assert.throws(() => normalizeBatchInput(input), failsAs("ENDPOINT_MISMATCH", "unreachable"));
});

test("Key coverage answers accept exactly the COVERAGE_ANSWERS table and keep the saved shape", () => {
  for (const option of COVERAGE_ANSWERS) {
    const declaration = coverageDeclarationOf(option.value, [9, 3, 9]);
    assert.deepEqual(normalizeCoverageDeclaration(declaration), { ...declaration, uncoveredOwnChannelIds: [...declaration.uncoveredOwnChannelIds].sort((a, b) => a - b) });
  }
  assert.deepEqual(normalizeCoverageDeclaration({ answer: "other_use" }), { answer: "other_use", otherUse: "unspecified", uncoveredOwnChannelIds: [] });
  assert.deepEqual(normalizeCoverageDeclaration({ answer: "none", otherUse: "external" }), { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
  for (const value of [null, {}, { answer: "yes" }, { answer: "other_use", otherUse: "elsewhere" }, { answer: "none", otherUse: "" },
    { answer: "unknown", uncoveredOwnChannelIds: "3" }, { answer: "other_use", otherUse: "own_channels", uncoveredOwnChannelIds: [0] }]) {
    assert.throws(() => normalizeCoverageDeclaration(value), failsAs("INVALID_REQUEST", "expired"));
  }
});

test("batch normalization keeps applicable credentials and explicit intent, rejects cross-group channel duplication", () => {
  const input = batchInput(), normalized = normalizeBatchInput(input);
  assert.deepEqual(normalized.selections[0].newStation, { type: "sub2api-password", baseUrl: "https://up.test", email: "a@example", password: " p " });
  assert.deepEqual(normalized.groups[0].reconciliation.coverageDeclaration, { answer: "none", otherUse: null, uncoveredOwnChannelIds: [] });
  assert.equal(JSON.stringify(normalized).includes("forged"), false);
  input.groups.push({ ...input.groups[0], groupId: "duplicate" });
  assert.throws(() => normalizeBatchInput(input), failsAs("INVALID_REQUEST", "expired"));
  assert.throws(() => normalizeBatchInput({ ...batchInput(), selections: [{ selectionId: "key", monitor: false,
    newStation: { type: "newapi-key", baseUrl: "https://up.test", apiKey: "key" } }] }), (error) => failsAs("KEY_ONLY_MONITOR_REQUIRED", "other")(error)
      && describeError(error).text === ONBOARDING_KEY_ONLY_MONITOR, "只用 Key 的上游没选看余额：直接说要选「看余额」，不说页面过期");
});

test("batch normalization enforces 100-channel/group bounds while Key choice can remain pending", () => {
  const input = batchInput();
  delete input.groups[0].reconciliation.tokenId;
  input.groups[0].channels = Array.from({ length: 100 }, (_, index) => ({ channelId: index + 1, channelRevision: `rev${index}` }));
  assert.equal(normalizeBatchInput(input).groups[0].channels.length, 100);
  input.groups[0].channels.push({ channelId: 101, channelRevision: "extra" });
  assert.throws(() => normalizeBatchInput(input), failsAs("INVALID_REQUEST", "expired"));
  const duplicate = batchInput();
  duplicate.selections.push(duplicate.selections[0]);
  assert.throws(() => normalizeBatchInput(duplicate), failsAs("INVALID_REQUEST", "expired"));
});

test("batch rejects a channel group with neither monitoring nor reconciliation", () => {
  const input = batchInput();
  input.selections[0].monitor = false;
  input.groups[0].reconciliation = null;
  assert.throws(() => normalizeBatchInput(input), failsAs("INVALID_REQUEST", "expired"));
  input.selections.push({ selectionId: "other", stationId: "other-upstream", monitor: true });
  assert.throws(() => normalizeBatchInput(input), failsAs("INVALID_REQUEST", "expired"));
});

test("batch retains billing-only and additional-monitor-only purposes", () => {
  const input = batchInput();
  input.selections[0].monitor = false;
  assert.equal(normalizeBatchInput(input).selections[0].monitor, false);
  input.groups[0].reconciliation = null;
  input.selections[0].additionalMonitorStationIds = ["extra-monitor"];
  assert.deepEqual(normalizeBatchInput(input).selections[0].additionalMonitorStationIds, ["extra-monitor"]);
});

test("batch explicit removals are per-channel, bounded and cannot overlap additions", () => {
  const input = batchInput();
  input.selections = [{ selectionId: "supplier", monitor: false }]; input.groups[0].reconciliation = null;
  input.groups[0].channels[0].removeMonitorStationIds = ["paused", "missing", "paused"];
  const normalized = normalizeBatchInput(input);
  assert.equal(normalized.selections[0].linkOnly, true);
  assert.deepEqual(normalized.groups[0].channels[0].removeMonitorStationIds, ["missing", "paused"]);
  input.groups[0].channels[0].removeMonitorStationIds = [];
  assert.throws(() => normalizeBatchInput(input), /明确选择/);
  input.selections[0] = { selectionId: "supplier", monitor: true, stationId: "same" };
  input.groups[0].channels[0].removeMonitorStationIds = ["same"];
  assert.throws(() => normalizeBatchInput(input), /同时加上又去掉/);
  input.groups[0].channels[0].removeMonitorStationIds = "same";
  assert.throws(() => normalizeBatchInput(input), /解除监控资源格式/);
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
    coverageDeclaration: { answer: "unknown" } } }]), failsAs("GROUP_CONFLICT", "changed"));
});
