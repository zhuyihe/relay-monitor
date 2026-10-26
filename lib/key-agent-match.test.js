import assert from "node:assert/strict";
import test from "node:test";
import { classifyUpstreamKey, identifyChannel, identifyKeySlot } from "./key-agent-match.js";
import { fingerprintKey, maskKey } from "./key-fingerprint.js";

const fpBytes = Buffer.alloc(32, 7);
const fullKey = "sk-ABCDEFGHijklmnopqrstuvwxyz0123456789";
const fp = fingerprintKey(fullKey, fpBytes);
const mask = maskKey(fullKey); // "ABCD…6789"

test("classifyUpstreamKey：两段各 4 位是打码（不管分隔符是什么字符），一段够长是完整 Key，太短或形状古怪认不出", () => {
  assert.deepEqual(classifyUpstreamKey("AbC1…9f0c"), { kind: "masked", front: "abc1", back: "9f0c" });
  assert.deepEqual(classifyUpstreamKey("AbC1****9f0c"), { kind: "masked", front: "abc1", back: "9f0c" });
  assert.deepEqual(classifyUpstreamKey("AbC1...9f0c"), { kind: "masked", front: "abc1", back: "9f0c" });
  assert.deepEqual(classifyUpstreamKey(fullKey), { kind: "full", key: fullKey });
  assert.equal(classifyUpstreamKey(""), null);
  assert.equal(classifyUpstreamKey(null), null);
  assert.equal(classifyUpstreamKey("short"), null, "一段但不够长：读不出，不当成完整 Key");
  assert.equal(classifyUpstreamKey("a-b-c"), null, "三段：形状古怪");
  // "sk-" 前缀的完整 Key 去掉前缀以后仍是一段、够长
  assert.deepEqual(classifyUpstreamKey("sk-" + "x".repeat(40)), { kind: "full", key: "sk-" + "x".repeat(40) });
});

test("identifyKeySlot：完整 Key 按指纹精确认出；打码只有一把对上也认出；候选都没有算没找到；有候选没读到就是「这一轮认不出」", () => {
  const slot = { i: 0, m: mask, f: fp };
  const exact = identifyKeySlot(slot, [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }], fpBytes);
  assert.deepEqual(exact, { state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai" }] });
  const byMask = identifyKeySlot(slot, [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: mask }] }], fpBytes);
  assert.deepEqual(byMask, { state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai" }] });
  const notFound = identifyKeySlot(slot, [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: "Zzzz…0000" }] }], fpBytes);
  assert.deepEqual(notFound, { state: "not_found" });
  const unresolved = identifyKeySlot(slot, [{ stationId: "up1", tokens: null }], fpBytes);
  assert.deepEqual(unresolved, { state: "unresolved" });
  // 一个候选没读到、另一个读到但没有：仍是「这一轮认不出」，不能下「没有」的结论
  const mixed = identifyKeySlot(slot, [{ stationId: "up1", tokens: null }, { stationId: "up2", tokens: [{ id: 1, name: "x", maskedKey: "Zzzz…0000" }] }], fpBytes);
  assert.deepEqual(mixed, { state: "unresolved" });
});

test("identifyKeySlot：打码撞了不止一把要 reveal（ambiguous），candidate 之间也算，带着每个候选的 stationId", () => {
  const slot = { i: 0, m: mask, f: fp };
  const ambiguous = identifyKeySlot(slot, [
    { stationId: "up1", tokens: [{ id: 1, name: "a", maskedKey: mask }] },
    { stationId: "up2", tokens: [{ id: 2, name: "b", maskedKey: mask }] },
  ], fpBytes);
  assert.deepEqual(ambiguous, { state: "ambiguous", matches: [{ stationId: "up1", tokenId: 1, tokenName: "a" }, { stationId: "up2", tokenId: 2, tokenName: "b" }] });
});

test("identifyChannel：keyless 的渠道不比；多把 Key 的渠道每把各认一次", () => {
  assert.deepEqual(identifyChannel({ id: 30, keyless: true }, [], fpBytes), { channelId: 30, keyless: true });
  const channel = { id: 12, keys: [{ i: 0, m: mask, f: fp }, { i: 1, m: "Zzzz…0000", f: "other" }] };
  const tokenLists = [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }];
  const result = identifyChannel(channel, tokenLists, fpBytes);
  assert.equal(result.channelId, 12);
  assert.equal(result.keyless, false);
  assert.deepEqual(result.slots.map((slot) => [slot.index, slot.state]), [[0, "identified"], [1, "not_found"]]);
});
