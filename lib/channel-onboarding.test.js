import test from "node:test";
import assert from "node:assert/strict";
import { channelConnectionRule, pendingChannelConnections } from "./channel-onboarding.js";

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
