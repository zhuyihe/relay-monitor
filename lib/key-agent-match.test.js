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

test("identifyKeySlot：完整 Key 按指纹精确认出（via: fingerprint）；打码只有一把对上也认出（via: mask）；都没有算没找到；有没读到的就是「这一轮认不出」", () => {
  const slot = { i: 0, m: mask, f: fp };
  const exact = identifyKeySlot(slot,
    { allTokenLists: [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }], candidateTokenLists: [] }, fpBytes);
  assert.deepEqual(exact, { state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai", via: "fingerprint" }] });
  const byMask = identifyKeySlot(slot,
    { allTokenLists: [], candidateTokenLists: [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: mask }] }] }, fpBytes);
  assert.deepEqual(byMask, { state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai", via: "mask" }] });
  const none = [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: "Zzzz…0000" }] }];
  const notFound = identifyKeySlot(slot, { allTokenLists: none, candidateTokenLists: none }, fpBytes);
  assert.deepEqual(notFound, { state: "not_found" });
  const unresolvedFingerprint = identifyKeySlot(slot, { allTokenLists: [{ stationId: "up1", tokens: null }], candidateTokenLists: [] }, fpBytes);
  assert.deepEqual(unresolvedFingerprint, { state: "unresolved" }, "指纹那份里有没读到的，也算这一轮认不出");
  const unresolvedMask = identifyKeySlot(slot, { allTokenLists: [], candidateTokenLists: [{ stationId: "up1", tokens: null }] }, fpBytes);
  assert.deepEqual(unresolvedMask, { state: "unresolved" }, "打码那份里有没读到的，也算这一轮认不出");
  // 候选之一没读到、另一个读到但没有：仍是「这一轮认不出」，不能下「没有」的结论
  const mixed = identifyKeySlot(slot,
    { allTokenLists: [{ stationId: "up1", tokens: null }, { stationId: "up2", tokens: [{ id: 1, name: "x", maskedKey: "Zzzz…0000" }] }], candidateTokenLists: [] }, fpBytes);
  assert.deepEqual(mixed, { state: "unresolved" });
});

test("identifyKeySlot（审核 #131 H1）：指纹不限候选——渠道填的是代理、内网地址，地址对不上任何候选上游（candidateTokenLists 是空的），指纹照样能在全部已加的上游里精确认出", () => {
  const slot = { i: 0, m: mask, f: fp };
  const result = identifyKeySlot(slot,
    { allTokenLists: [{ stationId: "up-not-a-candidate", tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }], candidateTokenLists: [] }, fpBytes);
  assert.deepEqual(result, { state: "identified", matches: [{ stationId: "up-not-a-candidate", tokenId: 9, tokenName: "oai", via: "fingerprint" }] },
    "地址对不上任何候选，不代表认不出来——指纹在全部上游里找，这正是方案要解决的场景");
});

test("identifyKeySlot（审核 #131 H2）：打码比对不会被放大到全部上游——两个地址不同的上游各有一把打码一样的 Key，不是候选的那把不会被当成这一把", () => {
  const slot = { i: 0, m: mask, f: fp }; // fp 对应 fullKey；这两个候选都只给打码，没给完整 Key，算不出指纹，只能走打码这条路
  const result = identifyKeySlot(slot, {
    allTokenLists: [
      { stationId: "up-candidate", tokens: [{ id: 9, name: "candidate-key", maskedKey: mask }] },
      { stationId: "up-not-candidate", tokens: [{ id: 99, name: "not-a-candidate-key", maskedKey: mask }] }, // 打码一样，但地址没对上，不是候选
    ],
    candidateTokenLists: [{ stationId: "up-candidate", tokens: [{ id: 9, name: "candidate-key", maskedKey: mask }] }],
  }, fpBytes);
  assert.deepEqual(result, { state: "identified", matches: [{ stationId: "up-candidate", tokenId: 9, tokenName: "candidate-key", via: "mask" }] },
    "只认出候选里那一把；「up-not-candidate」即使打码一样、也在 allTokenLists 里，也不会被当成候选——放大打码比对会把别的账号的钱算错");
});

test("identifyKeySlot：打码撞了不止一把要 reveal（ambiguous），候选之间也算，带着每个候选的 stationId 和 via: mask", () => {
  const slot = { i: 0, m: mask, f: fp };
  const tokenLists = [
    { stationId: "up1", tokens: [{ id: 1, name: "a", maskedKey: mask }] },
    { stationId: "up2", tokens: [{ id: 2, name: "b", maskedKey: mask }] },
  ];
  const ambiguous = identifyKeySlot(slot, { allTokenLists: tokenLists, candidateTokenLists: tokenLists }, fpBytes);
  assert.deepEqual(ambiguous, { state: "ambiguous", matches: [
    { stationId: "up1", tokenId: 1, tokenName: "a", via: "mask" }, { stationId: "up2", tokenId: 2, tokenName: "b", via: "mask" },
  ] });
});

test("identifyChannel：keyless 的渠道不比；多把 Key 的渠道每把各认一次", () => {
  assert.deepEqual(identifyChannel({ id: 30, keyless: true }, { allTokenLists: [], candidateTokenLists: [] }, fpBytes), { channelId: 30, keyless: true });
  const channel = { id: 12, keys: [{ i: 0, m: mask, f: fp }, { i: 1, m: "Zzzz…0000", f: "other" }] };
  const tokenLists = { allTokenLists: [{ stationId: "up1", tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }], candidateTokenLists: [] };
  const result = identifyChannel(channel, tokenLists, fpBytes);
  assert.equal(result.channelId, 12);
  assert.equal(result.keyless, false);
  assert.deepEqual(result.slots.map((slot) => [slot.index, slot.state]), [[0, "identified"], [1, "not_found"]]);
});
