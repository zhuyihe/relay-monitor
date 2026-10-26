import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintKey, maskKey, deriveAgentKeys } from "../lib/key-fingerprint.js";
import { identifyChannels, identifyChannelsCached, IDENTIFY_CACHE_MS } from "./key-agent-identify.js";

const STRONG_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const { fingerprintKey: fpBytes } = deriveAgentKeys(STRONG_SECRET);
const ownStation = { id: "own", isOwn: true, type: "newapi", keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: STRONG_SECRET };
const fullKey = "sk-" + "Ab1c".repeat(10);
const mask = maskKey(fullKey);
const fp = fingerprintKey(fullKey, fpBytes);

function fakeFetch(body, { status = 200, headers = {} } = {}) {
  return async () => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body });
}

test("identifyChannels：候选上游用地址对，指纹精确认出；keyless 的渠道原样带出；候选是 Sub2API 时跳过（目录不给 Key 材料）", async (t) => {
  const channel = (id, baseUrl, keyless) => keyless ? { id, keyless: true, baseUrl } : { id, baseUrl, keys: [{ i: 0, m: mask, f: fp }] };
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [
    channel(1, "https://up.example.com", false),
    channel(2, "", true),
  ] }, { headers: { etag: '"v1"' } }));
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const sub2 = { id: "up2", type: "sub2api", baseUrl: "https://up.example.com" }; // 同地址也是候选，但类型是 Sub2API，这一版跳过
  const rt = { store: { list: () => [ownStation, upstream, sub2] } };
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const result = await identifyChannels(rt, ownStation, { queryMetadata });
  assert.equal(result.ok, true);
  assert.deepEqual(result.channels.find((c) => c.channelId === 2), { channelId: 2, keyless: true });
  const first = result.channels.find((c) => c.channelId === 1);
  assert.deepEqual(first.slots, [{ index: 0, state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai" }] }]);
});

test("identifyChannels：这个站点没配读取服务直接说没配，不发请求", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; return { status: 200, headers: { get: () => null }, json: async () => ({}) }; });
  const result = await identifyChannels({ store: { list: () => [] } }, { id: "own", isOwn: true });
  assert.deepEqual(result, { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" });
  assert.equal(called, false);
});

test("identifyChannelsCached：缓存期内不再问读取服务；缓存期过了带上次的 etag 再问一次", async (t) => {
  let fetchCalls = 0;
  const etags = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    fetchCalls++;
    etags.push(init?.headers?.["If-None-Match"] ?? null);
    return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }) };
  });
  const rt = { store: { list: () => [ownStation] } };
  const first = await identifyChannelsCached(rt, ownStation);
  assert.equal(fetchCalls, 1);
  assert.equal(etags[0], null);
  const second = await identifyChannelsCached(rt, ownStation);
  assert.equal(fetchCalls, 1, "缓存期内不再问");
  assert.deepEqual(second, first);
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1; // 模拟缓存过期
  await identifyChannelsCached(rt, ownStation);
  assert.equal(fetchCalls, 2, "过期后再问一次");
  assert.equal(etags[1], '"v1"', "带上次的 etag");
});

test("identifyChannelsCached：304（读取服务那一侧没变）沿用上一次认出的结果，不重读候选上游的 Key 目录", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }) };
    return { status: 304, headers: { get: () => null }, json: async () => ({}) };
  });
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const rt = { store: { list: () => [ownStation, upstream] } };
  const first = await identifyChannelsCached(rt, ownStation,
    { queryMetadata: async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }) });
  assert.equal(first.channels[0].slots[0].state, "identified");
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1;
  let metadataCalls = 0;
  const second = await identifyChannelsCached(rt, ownStation,
    { queryMetadata: async () => { metadataCalls++; return { tokens: [] }; } });
  assert.equal(metadataCalls, 0, "304 时不该再问候选上游");
  assert.deepEqual(second.channels, first.channels, "沿用上一次认出的结果");
});

// 打码对上不止一把（K2a 的 reveal，k-plan §2.2）：同一个上游两把 Key 打码一样，渠道这把实际是 tokenId 9 那把
const fullKeyA = "sk-" + "Ab1c".repeat(10), fullKeyB = "sk-" + "Zz9y".repeat(10);
// 两把不同的完整 Key，但上游打码显示出来的前后 4 位一样（构造的测试数据：现实里这种撞码的概率极低，才要靠 reveal 分）
const collidingMask = maskKey(fullKeyA);
const collidingFp = fingerprintKey(fullKeyA, fpBytes);
const ambiguousChannel = { id: 3, baseUrl: "https://up.example.com", keys: [{ i: 0, m: collidingMask, f: collidingFp }] };
const ambiguousUpstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
const maskedQueryMetadata = async () => ({ tokens: [
  { id: 9, name: "oai-a", maskedKey: collidingMask }, { id: 10, name: "oai-b", maskedKey: collidingMask },
] });

test("identifyChannels：打码撞了、有 api_key:reveal 权限——批量取完整 Key 算指纹，精确分出是哪一把", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [ambiguousChannel] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, ambiguousUpstream] } };
  const revealCalls = [];
  const revealKeys = async (station, tokenIds) => { revealCalls.push({ stationId: station.id, tokenIds: [...tokenIds] }); return { 9: fullKeyA, 10: fullKeyB }; };
  const result = await identifyChannels(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai-a" }] }]);
  assert.deepEqual(result.revealIssues, []);
  assert.equal(revealCalls.length, 1, "同一个上游这一轮只问一次");
  assert.deepEqual(revealCalls[0].tokenIds.sort((a, b) => a - b), [9, 10]);
});

test("identifyChannels：打码撞了、没有 api_key:reveal 权限——按上游汇总一条，不逐渠道报；slot 维持 ambiguous，下一轮还能再试", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [ambiguousChannel] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, ambiguousUpstream] } };
  const revealKeys = async () => { throw Object.assign(new Error("少了权限"), { code: "ACCESS_TOKEN_SCOPE_DENIED", scope: "api_key:reveal" }); };
  const result = await identifyChannels(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  assert.equal(result.channels[0].slots[0].state, "ambiguous");
  // 不另起一种需处理：沿用 #107 已经定好的码（design/ui-copy-spec.md §8.2 的 KEY_REVEAL_DENIED），不是裸的 ACCESS_TOKEN_SCOPE_DENIED
  assert.deepEqual(result.revealIssues, [{ upstreamStationId: "up1", code: "KEY_REVEAL_DENIED", channelIds: [3] }]);
});

test("identifyChannels：reveal 被限流（或别的失败）——这一轮当认不出，不进 revealIssues、不重试、不升需处理", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [ambiguousChannel] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, ambiguousUpstream] } };
  let revealCalls = 0;
  const revealKeys = async () => { revealCalls++; throw Object.assign(new Error("被限流"), { code: "UPSTREAM_REQUEST_FAILED" }); };
  const result = await identifyChannels(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  assert.equal(result.channels[0].slots[0].state, "ambiguous");
  assert.deepEqual(result.revealIssues, []);
  assert.equal(revealCalls, 1, "这一轮只问一次，不在这一轮里重试");
});

test("identifyChannels：reveal 拿到的完整 Key 只用来算指纹，不出现在返回结果里（k-plan §11.3）", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [ambiguousChannel] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, ambiguousUpstream] } };
  const revealKeys = async () => ({ 9: fullKeyA, 10: fullKeyB });
  const result = await identifyChannels(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  const dump = JSON.stringify(result);
  // 去掉前 4 后 4，中间段不能原样出现在返回结果里（和 k-plan §11.3 的验法一个意思）
  for (const key of [fullKeyA, fullKeyB]) assert.equal(dump.includes(key.slice(7, -4)), false, `${key} 的中间段不该出现在结果里`);
});
