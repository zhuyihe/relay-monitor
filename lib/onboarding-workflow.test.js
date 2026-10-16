import test from "node:test";
import assert from "node:assert/strict";
import { onboardingMonitorIds, onboardingKeyContext, retainOnboardingRequest } from "./onboarding-workflow.js";

const identity = { provider: "newapi", baseUrl: "https://supplier.test/", accountId: "42" };
const source = { stationId: "own", namespaceKey: "source-current" };
const association = { ruleId: "rule", status: "active", ownStationId: "own", channels: [{ channelId: 4 }], timezone: "Asia/Shanghai", coverageDeclaration: { answer: "none" } };
const rules = [{ id: "rule", enabled: true, ownSource: source }];
const model = { accounts: [{ identity, resources: [{ id: "account" }], keys: [{ tokenId: 7, scopeAmbiguous: false, associations: [association, { ...association, ruleId: "old", status: "stopped", channels: [{ channelId: 99 }] }] }] }] };

test("management includes paused or missing saved links instead of only active monitors", () => {
  assert.deepEqual(onboardingMonitorIds({ monitor: { stationIds: ["active"], links: [{ stationId: "paused" }, { stationId: "missing" }, { stationId: "paused" }] } }), ["paused", "missing"]);
});

test("Key prefill uses only the anchored active rule and excludes stopped historical members", () => {
  const result = onboardingKeyContext(model, "account", { ...identity, baseUrl: "https://supplier.test" }, 7, source, rules);
  assert.equal(result, association);
  assert.deepEqual(result.channels.map((entry) => entry.channelId), [4]);
});

test("Key prefill rejects a different account, platform, source, resource or ambiguous rule", () => {
  for (const changed of [{ ...identity, accountId: "43" }, { ...identity, provider: "sub2api" }, { ...identity, baseUrl: "https://other.test" }]) {
    assert.equal(onboardingKeyContext(model, "account", changed, 7, source, rules), null);
  }
  assert.equal(onboardingKeyContext(model, "other", identity, 7, source, rules), null);
  assert.equal(onboardingKeyContext(model, "account", identity, 7, { ...source, namespaceKey: "new-source" }, rules), null);
  const ambiguous = structuredClone(model);
  ambiguous.accounts[0].keys[0].associations.push({ ...association, ruleId: "other" });
  assert.equal(onboardingKeyContext(ambiguous, "account", identity, 7, source, rules), null);
});

test("another request cannot replace a partially saved operation's recovery intent", () => {
  const original = { requestId: "saved", groups: [{ channelId: 4, reconciliationRequested: true }] };
  const next = { requestId: "another", groups: [{ channelId: 5 }] };
  assert.deepEqual(retainOnboardingRequest([original], next), [original, next]);
  const refreshed = { ...original, updated: true };
  assert.deepEqual(retainOnboardingRequest([original, next], refreshed), [next, refreshed]);
});
