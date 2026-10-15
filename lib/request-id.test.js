import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequestId } from "./request-id.js";
import { normalizeBatchInput } from "./channel-onboarding.js";

const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const input = (requestId) => ({ requestId, ownStationId: "own",
  selections: [{ selectionId: "primary", monitor: true, stationId: "upstream" }],
  groups: [{ groupId: "monitor", selectionId: "primary", channels: [{ channelId: 492, channelRevision: "revision" }] }] });

function useCrypto(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  t.after(() => Object.defineProperty(globalThis, "crypto", previous));
}

test("request ID uses native randomUUID when available", (t) => {
  const id = "11111111-1111-4111-8111-111111111111";
  useCrypto(t, { randomUUID: () => id, getRandomValues: () => assert.fail("native UUID needs no fallback") });
  assert.equal(createRequestId(), id);
});

test("request IDs without randomUUID are distinct UUIDv4 values accepted by actual batch normalization", (t) => {
  useCrypto(t, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const ids = Array.from({ length: 100 }, () => createRequestId());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, uuid);
    assert.equal(normalizeBatchInput(input(id)).requestId, id);
  }
});

test("request ID fallback sets the UUID version and variant for boundary bytes", (t) => {
  useCrypto(t, { getRandomValues: (bytes) => bytes.fill(255) });
  assert.equal(createRequestId(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("missing browser cryptography reports a recoverable error rather than an empty request ID", (t) => {
  useCrypto(t, undefined);
  assert.throws(createRequestId, /无法生成请求标识/);
});
