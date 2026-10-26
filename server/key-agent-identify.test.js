import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintKey, maskKey, deriveAgentKeys } from "../lib/key-fingerprint.js";
import { identifyChannels, identifyChannelsCached, keyAgentReachability, IDENTIFY_CACHE_MS } from "./key-agent-identify.js";

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

// 例外三（k-plan §6）跨轮状态：读取服务连续拿不到新结果，记在 rt._keyAgentReachability，按真的问了几次记，不按调用次数记
test("keyAgentReachability：连续读不到（连不上）才累加；命中 4 分钟缓存的调用不算一次新的检查", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { fetchCalls++; throw new Error("连不上"); });
  const rt = { store: { list: () => [ownStation] } };
  await identifyChannelsCached(rt, ownStation);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(keyAgentReachability(rt, "own"), { consecutiveFailures: 1, unreachableSinceMs: keyAgentReachability(rt, "own").unreachableSinceMs });
  const since = keyAgentReachability(rt, "own").unreachableSinceMs;
  assert.equal(typeof since, "number");
  await identifyChannelsCached(rt, ownStation); // 还在 4 分钟缓存期内，不会真的再问
  assert.equal(fetchCalls, 1, "缓存期内不重新检查");
  assert.equal(keyAgentReachability(rt, "own").consecutiveFailures, 1, "没真的检查过，次数不变");
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1;
  await identifyChannelsCached(rt, ownStation);
  assert.equal(fetchCalls, 2);
  assert.equal(keyAgentReachability(rt, "own").consecutiveFailures, 2, "过期后真的问了一次，才累加");
  assert.equal(keyAgentReachability(rt, "own").unreachableSinceMs, since, "第一次失败的时间不跟着变");
});

test("keyAgentReachability：带 X-Agent-Stale 的 200 也算拿不到新结果；真的 200 和 304 都算拿到了，清零", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "x-agent-stale" ? "1" : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }) };
    if (step === 2) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "x-agent-stale" ? "1" : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }) };
    return { status: 200, headers: { get: () => null }, json: async () => ({ v: 1, db: "mysql", readAt: 2, channels: [{ id: 1, keyless: true }] }) };
  });
  const rt = { store: { list: () => [ownStation] } };
  await identifyChannelsCached(rt, ownStation);
  assert.equal(keyAgentReachability(rt, "own").consecutiveFailures, 1, "带 Stale 的 200 也算拿不到新结果");
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1;
  await identifyChannelsCached(rt, ownStation);
  assert.equal(keyAgentReachability(rt, "own").consecutiveFailures, 2, "连续第二次还是 Stale，接着累加");
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1;
  await identifyChannelsCached(rt, ownStation);
  assert.deepEqual(keyAgentReachability(rt, "own"), { consecutiveFailures: 0, unreachableSinceMs: null }, "真的 200（不带 Stale）清零");
});

test("keyAgentReachability：没配置读取服务，当作拿不到新结果累加；各站点分开记", async (t) => {
  const otherStation = { id: "own2", isOwn: true, type: "newapi" }; // 没配 keyAgentUrl
  const rt = { store: { list: () => [ownStation, otherStation] } };
  await identifyChannelsCached(rt, otherStation);
  assert.equal(keyAgentReachability(rt, "own2").consecutiveFailures, 1);
  assert.equal(keyAgentReachability(rt, "own").consecutiveFailures, 0, "没检查过的站点不受影响");
});

// K2b：持久化「读取服务上一次读成功的时刻」（给 lastSeenAt 丢了以后兜底用，见 server/key-agent-resegment.js 的 safeLastSeenAt）
test("identifyChannelsCached：真的读成功（200 或 304，不带 X-Agent-Stale）才记一次成功时刻；连不上、带 Stale 的都不记", async (t) => {
  const calls = [];
  const store = { list: () => [ownStation], setKeyAgentLastSuccessAt: async (stationId, atMs) => { calls.push([stationId, atMs]); } };
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }, { headers: { etag: '"v1"' } }));
  await identifyChannelsCached({ store }, ownStation);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "own");
  assert.equal(typeof calls[0][1], "number");
});

test("identifyChannelsCached：连不上时不记成功时刻", async (t) => {
  const calls = [];
  const store = { list: () => [ownStation], setKeyAgentLastSuccessAt: async (...args) => { calls.push(args); } };
  t.mock.method(globalThis, "fetch", async () => { throw new Error("连不上"); });
  await identifyChannelsCached({ store }, ownStation);
  assert.equal(calls.length, 0);
});

test("identifyChannelsCached：200 但带 X-Agent-Stale 时不记成功时刻（读取服务自己读库失败，给的是旧结果，不算这一轮真的读成功）", async (t) => {
  const calls = [];
  const store = { list: () => [ownStation], setKeyAgentLastSuccessAt: async (...args) => { calls.push(args); } };
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] },
    { headers: { "x-agent-stale": "1" } }));
  await identifyChannelsCached({ store }, ownStation);
  assert.equal(calls.length, 0);
});

test("identifyChannelsCached：没提供 setKeyAgentLastSuccessAt（比如旧的测试夹具）不报错——可选调用", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }, { headers: { etag: '"v1"' } }));
  await assert.doesNotReject(identifyChannelsCached({ store: { list: () => [ownStation] } }, ownStation));
});
