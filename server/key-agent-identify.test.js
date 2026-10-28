import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintKey, maskKey, deriveAgentKeys } from "../lib/key-fingerprint.js";
import { identifyChannels, identifyChannelsCached, keyAgentReachability, IDENTIFY_CACHE_MS, UNRESOLVED_RECHECK_MS } from "./key-agent-identify.js";

const STRONG_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const { fingerprintKey: fpBytes } = deriveAgentKeys(STRONG_SECRET);
const ownStation = { id: "own", isOwn: true, type: "newapi", keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: STRONG_SECRET };
const fullKey = "sk-" + "Ab1c".repeat(10);
const mask = maskKey(fullKey);
const fp = fingerprintKey(fullKey, fpBytes);

function fakeFetch(body, { status = 200, headers = {} } = {}) {
  return async () => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body });
}

test("identifyChannels：候选上游用地址对，指纹精确认出；keyless 的渠道原样带出；同地址的 Sub2API 候选也读，它的目录只给指纹，这里指纹对不上，不影响 New API 那把认出来", async (t) => {
  const channel = (id, baseUrl, keyless) => keyless ? { id, keyless: true, baseUrl } : { id, baseUrl, keys: [{ i: 0, m: mask, f: fp }] };
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [
    channel(1, "https://up.example.com", false),
    channel(2, "", true),
  ] }, { headers: { etag: '"v1"' } }));
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const sub2 = { id: "up2", type: "sub2api", baseUrl: "https://up.example.com" }; // 同地址也是候选；它的目录里没有这把（指纹对不上）
  const rt = { store: { list: () => [ownStation, upstream, sub2] } };
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const querySub2Metadata = async (station, { fingerprintOf }) => ({ tokens: [{ id: 5, name: "s2", maskedKey: "", fingerprint: fingerprintOf("sk-some-other-key-entirely-0000") }] });
  const result = await identifyChannels(rt, ownStation, { queryMetadata, querySub2Metadata });
  assert.equal(result.ok, true);
  assert.deepEqual(result.channels.find((c) => c.channelId === 2), { channelId: 2, keyless: true });
  const first = result.channels.find((c) => c.channelId === 1);
  assert.deepEqual(first.slots, [{ index: 0, state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai", via: "fingerprint" }] }]);
});

test("identifyChannels（审核 #131 H1）：渠道填的是代理/内网地址，和哪个上游都对不上（没有候选），指纹照样能在全部已加的上游里精确认出", async (t) => {
  const channel = { id: 1, baseUrl: "http://10.0.0.5:8080", keys: [{ i: 0, m: mask, f: fp }] }; // 内网地址，对不上任何上游
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [channel] }, { headers: { etag: '"v1"' } }));
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" }; // 真正的上游，地址和渠道对不上
  const rt = { store: { list: () => [ownStation, upstream] } };
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }); // 给的是完整 Key（比如 Sub2API 式的目录）
  const result = await identifyChannels(rt, ownStation, { queryMetadata });
  assert.equal(result.ok, true);
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai", via: "fingerprint" }] }],
    "地址对不上任何候选，不代表认不出来——这正是方案要解决的场景（k-plan §2.2）");
});

test("identifyChannels（审核 #131 H2）：打码比对不会被放大到全部上游——另一个地址对不上的上游刚好有一把打码一样的 Key，不会被误认成这一把", async (t) => {
  const channel = { id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: "not-a-real-fingerprint" }] }; // 这里只给打码，指纹对不上任何完整 Key
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [channel] }, { headers: { etag: '"v1"' } }));
  const candidate = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" }; // 地址对上，是候选
  const notCandidate = { id: "up2", type: "newapi", baseUrl: "https://other.example.com" }; // 地址对不上，不是候选，但打码刚好一样
  const rt = { store: { list: () => [ownStation, candidate, notCandidate] } };
  const queryMetadata = async (station) => station.id === "up1"
    ? { tokens: [{ id: 9, name: "candidate-key", maskedKey: mask }] }
    : { tokens: [{ id: 99, name: "not-a-candidate-key", maskedKey: mask }] };
  const result = await identifyChannels(rt, ownStation, { queryMetadata });
  assert.equal(result.ok, true);
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "candidate-key", via: "mask" }] }],
    "只认出候选（地址对上的）那一把；地址对不上的 up2 即使打码一样也不会被当成候选，不然会把钱算到错的账号上");
});

// 审核 #131 第 2 轮：别多读上游。非候选上游的 Key 目录只有在第一步（只读候选）之后还有渠道认不出时才读，
// 而且读过一次发现目录里没有完整 Key（新版 New API 只给打码）的，1 小时内不再为指纹去读
test("identifyChannels（别多读上游）：候选上游就认出来了——非候选的上游一个请求都不发", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, { id: "up1", type: "newapi", baseUrl: "https://up.example.com" }, { id: "up2", type: "newapi", baseUrl: "https://other.example.com" }, { id: "up3", type: "newapi", baseUrl: "https://third.example.com" }] } };
  const read = [];
  const queryMetadata = async (station) => { read.push(station.id); return { tokens: [{ id: 9, name: "oai", maskedKey: station.id === "up1" ? mask : "Zzzz…0000" }] }; };
  const result = await identifyChannels(rt, ownStation, { queryMetadata });
  assert.equal(result.channels[0].slots[0].state, "identified");
  assert.deepEqual(read, ["up1"], "只读了候选上游，非候选的 up2、up3 没读");
});

test("identifyChannels（别多读上游）：候选里认不出才为指纹读非候选的上游；读过发现目录只给打码的，1 小时内下一轮不再读它", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "http://10.0.0.5:8080", keys: [{ i: 0, m: mask, f: fp }] }] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, { id: "old", type: "newapi", baseUrl: "https://old.example.com" }, { id: "new", type: "newapi", baseUrl: "https://new.example.com" }] } };
  const read = [];
  const queryMetadata = async (station) => { read.push(station.id); return { tokens: [{ id: 9, name: "oai", maskedKey: station.id === "old" ? fullKey : "Zzzz…0000" }] }; }; // old：老版本，目录给完整 Key；new：新版本，只给打码
  const first = await identifyChannels(rt, ownStation, { queryMetadata });
  assert.deepEqual(read.sort(), ["new", "old"], "第一轮：没有候选，认不出，才把非候选的都读一遍");
  assert.equal(first.channels[0].slots[0].state, "identified");
  assert.equal(first.channels[0].slots[0].matches[0].stationId, "old");
  read.length = 0;
  await identifyChannels(rt, ownStation, { queryMetadata });
  assert.deepEqual(read, ["old"], "第二轮：new 的目录上次读过、没有完整 Key，不再为指纹读它；old 有完整 Key 还要读");
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

// 审核 #131 M1：两个自营站点各有各的读取服务，缓存（rt._keyAgentIdentifyCache）按站点 id 隔开，不能串
test("identifyChannelsCached：两个自营站点交替问，各拿各的结果，缓存不串（站点 A 的渠道不会出现在站点 B 的结果里）", async (t) => {
  const ownB = { id: "own-b", isOwn: true, type: "newapi", keyAgentUrl: "https://own-b.test/key-agent", keyAgentSecret: STRONG_SECRET };
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    fetched.push(String(url));
    const id = String(url).startsWith("https://own-b.test") ? 2 : 1;
    return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? `"v${id}"` : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id, keyless: true }] }) };
  });
  const rt = { store: { list: () => [ownStation, ownB] } };
  const a1 = await identifyChannelsCached(rt, ownStation);
  const b1 = await identifyChannelsCached(rt, ownB);
  const a2 = await identifyChannelsCached(rt, ownStation);
  assert.deepEqual(a1.channels.map((c) => c.channelId), [1]);
  assert.deepEqual(b1.channels.map((c) => c.channelId), [2], "站点 B 拿到的是自己的渠道，不是 A 缓存的");
  assert.deepEqual(a2.channels.map((c) => c.channelId), [1], "换回 A：还是 A 自己的渠道，不是 B 的");
  assert.deepEqual(fetched.map((u) => new URL(u).host), ["own.test", "own-b.test", "own.test"], "换站点不命中对方的缓存，各问各的读取服务");
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
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "up1", tokenId: 9, tokenName: "oai-a", via: "revealed" }] }]);
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

test("identifyChannels（审核 #131 低项）：reveal 返回里少了某把候选（超过一轮能取的批数、或上游没给）——没读全，slot 保持 ambiguous 下一轮再试，不能误判成 not_found", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [ambiguousChannel] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, ambiguousUpstream] } };
  const revealKeys = async () => ({ 10: fullKeyB }); // 候选 9、10：只回了 10，9 没取到；10 不是渠道这把
  const result = await identifyChannels(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  assert.equal(result.channels[0].slots[0].state, "ambiguous", "9 没取到，不能下「都不是」的结论");
  assert.deepEqual(result.revealIssues, []);
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
  assert.deepEqual(keyAgentReachability(rt, "own"), { consecutiveFailures: 1, unreachableSinceMs: keyAgentReachability(rt, "own").unreachableSinceMs, lastSuccessAtMs: null, lastCode: "KEY_AGENT_UNAVAILABLE" });
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
  const cleared = keyAgentReachability(rt, "own");
  assert.deepEqual([cleared.consecutiveFailures, cleared.unreachableSinceMs, typeof cleared.lastSuccessAtMs], [0, null, "number"], "真的 200（不带 Stale）清零，并记下最近一次真的读到的时刻");
});

test("keyAgentReachability：没配置读取服务，当作拿不到新结果累加；各站点分开记", async (t) => {
  const otherStation = { id: "own2", isOwn: true, type: "newapi" }; // 没配 keyAgentUrl
  const rt = { store: { list: () => [ownStation, otherStation] } };
  await identifyChannelsCached(rt, otherStation);
  assert.equal(keyAgentReachability(rt, "own2").consecutiveFailures, 1);
  assert.equal(keyAgentReachability(rt, "own").consecutiveFailures, 0, "没检查过的站点不受影响");
});

// K2b：fetchedAtMs 是这一份结果真的从读取服务拿到的时刻（给驱动当「读取服务上一次读成功」用；持久化由驱动在换段落库以后做，
// 这里不写 store——读完就写的话 a 会变成 b，见 server/reconciliation.js keyAgentRoundFor）
test("identifyChannelsCached：结果带 fetchedAtMs（真的读成功的时刻）；缓存命中还是原来那一刻；带 X-Agent-Stale、连不上都没有；这里不碰 store", async (t) => {
  const calls = [];
  const store = { list: () => [ownStation], setKeyAgentLastSuccessAt: async (...args) => { calls.push(args); } };
  const rt = { store };
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }, { headers: { etag: '"v1"' } }));
  const before = Date.now();
  const first = await identifyChannelsCached(rt, ownStation);
  assert.ok(first.fetchedAtMs >= before && first.fetchedAtMs <= Date.now());
  const second = await identifyChannelsCached(rt, ownStation); // 缓存命中
  assert.equal(second.fetchedAtMs, first.fetchedAtMs, "缓存命中带的是原来那一刻，不是现在");
  assert.equal(calls.length, 0, "identifyChannelsCached 自己不写 store：由驱动在换段落库以后再写");

  const staleRt = { store };
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }] }, { headers: { "x-agent-stale": "1" } }));
  assert.equal((await identifyChannelsCached(staleRt, ownStation)).fetchedAtMs, null, "读取服务给的是旧结果，不算这一轮真的读成功");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("连不上"); });
  assert.equal((await identifyChannelsCached({ store }, ownStation)).fetchedAtMs, undefined, "连不上：没有结果，也就没有这个时刻");
});

const age = (rt, ms) => { rt._keyAgentIdentifyCache.at -= ms; if (rt._keyAgentIdentifyCache.lastGood) rt._keyAgentIdentifyCache.lastGood.comparedAt -= ms; };
// 304 只说明读取服务那一份没变，不说明上游目录没变
test("identifyChannelsCached：认出的结果里有没认定的（渠道 Key 不在已加的上游里），读取服务回 304 也要重新对一遍上游目录——用户把上游加上以后下一轮就认出来了", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }) };
    return { status: 304, headers: { get: () => null }, json: async () => ({}) };
  });
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const rt = { store: { list: () => [ownStation, upstream] } };
  const first = await identifyChannelsCached(rt, ownStation, { queryMetadata: async () => ({ tokens: [] }) }); // 目录里还没有这把
  assert.equal(first.channels[0].slots[0].state, "not_found");
  age(rt, UNRESOLVED_RECHECK_MS + 1);
  let metadataCalls = 0;
  const second = await identifyChannelsCached(rt, ownStation, { queryMetadata: async () => { metadataCalls++; return { tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }; } });
  assert.equal(metadataCalls, 1, "没认定的：304 也重新读候选上游的目录");
  assert.equal(second.channels[0].slots[0].state, "identified", "上游加上以后认出来了");
  assert.equal(second.fetchedAtMs != null, true);
  // 认定了的就不再多读（上面「304 沿用」那条）
  age(rt, UNRESOLVED_RECHECK_MS + 1);
  await identifyChannelsCached(rt, ownStation, { queryMetadata: async () => { metadataCalls++; return { tokens: [] }; } });
  assert.equal(metadataCalls, 1, "全部认定以后 304 不再读上游");
});

test("identifyChannelsCached：打码撞了又没有 api_key:reveal 权限，读取服务回 304 时补了权限也能重新认出来；重新比对不会把原始渠道列表（指纹、打码）放进返回结果", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) }, json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [ambiguousChannel] }) };
    return { status: 304, headers: { get: () => null }, json: async () => ({}) };
  });
  const rt = { store: { list: () => [ownStation, ambiguousUpstream] } };
  let granted = false;
  const revealKeys = async () => {
    if (!granted) throw Object.assign(new Error("denied"), { code: "ACCESS_TOKEN_SCOPE_DENIED", scope: "api_key:reveal" });
    return { 9: fullKeyA, 10: fullKeyB };
  };
  const first = await identifyChannelsCached(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  assert.equal(first.revealIssues.length, 1);
  granted = true;
  age(rt, UNRESOLVED_RECHECK_MS + 1);
  const second = await identifyChannelsCached(rt, ownStation, { queryMetadata: maskedQueryMetadata, revealKeys });
  assert.deepEqual(second.revealIssues, [], "补了权限：不再有缺权限的");
  assert.equal(second.channels[0].slots[0].state, "identified");
  assert.equal(JSON.stringify(second).includes(collidingFp), false, "原始渠道列表里的指纹不在返回结果里");
});

test("identifyChannelsCached：一次失败（503）不覆盖上一份认出的结果；恢复回 304 时沿用的还是失败前的 channels，不是 null", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }) };
    if (step === 2) return { status: 503, headers: { get: () => null }, json: async () => ({}) };
    return { status: 304, headers: { get: () => null }, json: async () => ({}) };
  });
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const rt = { store: { list: () => [ownStation, upstream] } };
  const options = { queryMetadata: async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }) };
  const first = await identifyChannelsCached(rt, ownStation, options);
  age(rt, UNRESOLVED_RECHECK_MS + 1);
  const failed = await identifyChannelsCached(rt, ownStation, options);
  assert.equal(failed.ok, false);
  age(rt, UNRESOLVED_RECHECK_MS + 1);
  const recovered = await identifyChannelsCached(rt, ownStation, options);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.channels, first.channels, "失败之后恢复，沿用失败前认出的，不是 null");
  assert.ok(recovered.fetchedAtMs != null);
});

test("identifyChannelsCached：持续 not_found 的渠道（例外一的真实场景）304 时最多每 15 分钟重读一次候选上游目录——一小时 15 次缓存到期只读 4 次，不是每 4 分钟一次", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }) };
    return { status: 304, headers: { get: () => null }, json: async () => ({}) };
  });
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const rt = { store: { list: () => [ownStation, upstream] } };
  let reads = 0;
  const options = { queryMetadata: async () => { reads += 1; return { tokens: [] }; } }; // 一直没有这把 Key
  await identifyChannelsCached(rt, ownStation, options);
  assert.equal(reads, 1);
  for (let round = 1; round <= 15; round += 1) { // 每 4 分钟一轮（缓存刚好到期），共 60 分钟
    rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1;
    rt._keyAgentIdentifyCache.lastGood.comparedAt -= IDENTIFY_CACHE_MS + 1;
    await identifyChannelsCached(rt, ownStation, options);
  }
  assert.ok(reads <= 5, `一小时读了 ${reads} 次：第一次 + 每 15 分钟一次，最多 5 次`);
  assert.ok(reads >= 4, "间隔到了还是会重读（上游加上能认出来）");
});

test("identifyChannelsCached：304 重新对上游目录时候选上游读不到——这次比对不算数，不把认得出的渠道降级成 unresolved、不更新 comparedAt，下一轮缓存到期接着重对", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }) };
    return { status: 304, headers: { get: () => null }, json: async () => ({}) };
  });
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const rt = { store: { list: () => [ownStation, upstream] } };
  const first = await identifyChannelsCached(rt, ownStation, { queryMetadata: async () => ({ tokens: [] }) });
  assert.equal(first.channels[0].slots[0].state, "not_found");
  const comparedAt = rt._keyAgentIdentifyCache.lastGood.comparedAt;
  age(rt, UNRESOLVED_RECHECK_MS + 1);
  const second = await identifyChannelsCached(rt, ownStation, { queryMetadata: async () => { throw new Error("upstream 500"); } });
  assert.equal(second.channels[0].slots[0].state, "not_found", "沿用上一份，不是 unresolved");
  assert.ok(second.fetchedAtMs != null, "读取服务读到了（304）");
  assert.ok(rt._keyAgentIdentifyCache.lastGood.comparedAt < comparedAt, "比对没成：comparedAt 没往前更新（age 之后还是更早的那个）");
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1; // 缓存到期，间隔早已超过：马上接着重对
  const third = await identifyChannelsCached(rt, ownStation, { queryMetadata: async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }) });
  assert.equal(third.channels[0].slots[0].state, "identified");
});

test("identifyChannelsCached：带 X-Agent-Stale 的 200（读取服务给的旧结果）带着不同的 etag，也不当「最近一次读成功」：etag 和结果都不换", async (t) => {
  let step = 0;
  t.mock.method(globalThis, "fetch", async () => {
    step++;
    const channels = [{ id: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: mask, f: fp }] }];
    if (step === 1) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) }, json: async () => ({ v: 1, db: "mysql", readAt: 1, channels }) };
    return { status: 200, headers: { get: (name) => ({ etag: '"stale-v2"', "x-agent-stale": "1" })[name.toLowerCase()] ?? null }, json: async () => ({ v: 1, db: "mysql", readAt: 2, channels }) };
  });
  const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };
  const rt = { store: { list: () => [ownStation, upstream] } };
  const options = { queryMetadata: async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] }) };
  await identifyChannelsCached(rt, ownStation, options);
  rt._keyAgentIdentifyCache.at -= IDENTIFY_CACHE_MS + 1;
  const stale = await identifyChannelsCached(rt, ownStation, options);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAtMs, null, "旧结果不算读到");
  assert.equal(rt._keyAgentIdentifyCache.lastGood.etag, '"v1"', "stale 的 etag 不当最近一次读成功的");
});

// Sub2API 的 /api/v1/keys 每一项都带完整 Key（Sub2API v0.2.18 handler/dto/mappers.go:87）：读目录时就地算成指纹，只比指纹（它没有打码）
const sub2Station = { id: "s2", type: "sub2api", baseUrl: "https://s2.example.com", accessToken: "jwt" };
const sub2Catalogue = (...keys) => async (station, { fingerprintOf }) => ({ tokens: keys.map(([id, name, raw]) => ({ id, name, maskedKey: "", fingerprint: fingerprintOf(raw) })) });

test("identifyChannels：渠道地址就是 Sub2API 上游（候选），指纹认出它的哪把 Key；Sub2API 目录没有打码，不会靠打码误认", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [
    { id: 1, baseUrl: "https://s2.example.com", keys: [{ i: 0, m: mask, f: fp }] },
    { id: 2, baseUrl: "https://s2.example.com", keys: [{ i: 0, m: mask, f: "no-such-fingerprint" }] }, // 打码一样但指纹对不上：Sub2API 不参与打码，认不出
  ] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, sub2Station] } };
  const result = await identifyChannels(rt, ownStation, { querySub2Metadata: sub2Catalogue([7, "s2-key", fullKey], [8, "other", "sk-" + "Zz9y".repeat(10)]) });
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "s2", tokenId: 7, tokenName: "s2-key", via: "fingerprint" }] }]);
  assert.equal(result.channels[1].slots[0].state, "not_found");
});

test("identifyChannels：渠道填的是代理地址（没有候选），先只读候选（零），认不出才去读 Sub2API 上游的目录，指纹认出；读过一次就缓存不重读", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "http://10.0.0.5:8080", keys: [{ i: 0, m: mask, f: fp }] }] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, sub2Station] } };
  let reads = 0;
  const querySub2Metadata = async (station, options) => { reads += 1; return sub2Catalogue([7, "s2-key", fullKey])(station, options); };
  const result = await identifyChannels(rt, ownStation, { querySub2Metadata });
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "s2", tokenId: 7, tokenName: "s2-key", via: "fingerprint" }] }]);
  assert.equal(reads, 1);
  assert.equal(rt._keyAgentCatalogKinds.get("s2").hasFullKeys, true, "Sub2API 目录有指纹：算「给完整 Key」的上游，以后也会为指纹去读");
});

test("identifyChannels：Sub2API 完整 Key 不外泄——用真的读目录（fetch 假上游给了完整 Key），认出结果、读取服务缓存里都找不到完整 Key", async (t) => {
  const raw = fullKey;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.includes("key-agent")) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://s2.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }) };
    const data = url.pathname === "/api/v1/auth/me" ? { id: 42 }
      : url.pathname === "/api/v1/keys" ? { total: 1, items: [{ id: 7, user_id: 42, name: "s2-key", status: "active", group_id: 3, key: raw }] } : null;
    return { status: data ? 200 : 404, text: async () => JSON.stringify({ code: data ? 0 : 404, data }) };
  });
  const rt = { store: { list: () => [ownStation, sub2Station] } };
  const result = await identifyChannelsCached(rt, ownStation);
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "s2", tokenId: 7, tokenName: "s2-key", via: "fingerprint" }] }]);
  const leaked = (value) => JSON.stringify(value, (_key, item) => (item instanceof Map ? [...item] : item));
  assert.doesNotMatch(leaked(result), new RegExp(raw.slice(3)), "返回体里没有完整 Key");
  assert.doesNotMatch(leaked(rt), new RegExp(raw.slice(3)), "缓存（识别结果、目录种类）里也没有完整 Key");
  assert.ok(calls.includes("/api/v1/keys"));
});

// 审核 2 对 #142 第 1 轮意见
test("identifyChannels（#142 中 1）：Sub2API 目录是空的（刚建的账号还没有 Key）不记成「没给完整 Key」——下一次有了 Key 就能认出来，不被 1 小时跳过", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "http://10.0.0.5:8080", keys: [{ i: 0, m: mask, f: fp }] }] }, { headers: { etag: '"v1"' } }));
  const rt = { store: { list: () => [ownStation, sub2Station] } };
  let keys = [];
  const querySub2Metadata = async (station, options) => sub2Catalogue(...keys)(station, options);
  const first = await identifyChannels(rt, ownStation, { querySub2Metadata });
  assert.equal(first.channels[0].slots[0].state, "not_found");
  assert.equal(rt._keyAgentCatalogKinds.has("s2"), false, "空目录不记种类");
  keys = [[7, "s2-key", fullKey]]; // 用户在 Sub2API 建了 Key 填进渠道
  delete rt._keyAgentSub2Catalogue; // 5 分钟目录缓存到期
  const second = await identifyChannels(rt, ownStation, { querySub2Metadata });
  assert.equal(second.channels[0].slots[0].state, "identified", "没有被一小时跳过");
});

test("identifyChannels（#142 中 3）：Sub2API 指纹目录按站点缓存 5 分钟（只放指纹）——快照变了也不重读；过期或站点登录信息变了才重读；同时进来的几个调用合并成一次", async (t) => {
  let agentCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { agentCalls += 1; return { status: 200, headers: { get: () => null }, json: async () => ({ v: 1, db: "mysql", readAt: agentCalls, channels: [{ id: 1, baseUrl: "http://10.0.0.5:8080", keys: [{ i: 0, m: mask, f: fp }] }] }) }; });
  const station = { ...sub2Station };
  const rt = { store: { list: () => [ownStation, station] } };
  let reads = 0;
  const querySub2Metadata = async (s, options) => { reads += 1; return sub2Catalogue([7, "s2-key", fullKey])(s, options); };
  await identifyChannels(rt, ownStation, { querySub2Metadata });
  await identifyChannels(rt, ownStation, { querySub2Metadata }); // 快照又来一份（模拟 ETag 变了）
  assert.equal(reads, 1, "5 分钟内不重读");
  assert.doesNotMatch(JSON.stringify([...rt._keyAgentSub2Catalogue]), new RegExp(fullKey.slice(3)), "缓存里只有指纹，没有完整 Key");
  // 缓存里也不放读取服务派生出来的指纹密钥（只放一个摘要当版本戳）：hex、base64 两种写法都找不到
  const cacheDump = JSON.stringify([...rt._keyAgentSub2Catalogue]);
  for (const form of [fpBytes.toString("hex"), fpBytes.toString("base64"), fpBytes.toString("base64url")]) assert.equal(cacheDump.includes(form), false, "缓存里没有指纹密钥原文");
  assert.match(rt._keyAgentSub2Catalogue.get("s2").keyStamp, /^[0-9a-f]{16}$/, "只有 16 位的摘要");
  rt._keyAgentSub2Catalogue.get("s2").at -= 6 * 60 * 1000;
  await identifyChannels(rt, ownStation, { querySub2Metadata });
  assert.equal(reads, 2, "过期重读");
  station.authVersion = 2; // 登录信息改过（authVersion 跟着变，stationBusinessVersion 里有）：不用旧的
  await identifyChannels(rt, ownStation, { querySub2Metadata });
  assert.equal(reads, 3);
  // 同时进来三个调用：合并成一次（读取服务和 Sub2 目录各问一次）
  delete rt._keyAgentSub2Catalogue; rt._keyAgentIdentifyCache = null; agentCalls = 0; reads = 0;
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => identifyChannelsCached(rt, ownStation, { querySub2Metadata })));
  assert.equal(agentCalls, 1);
  assert.equal(reads, 1);
  assert.deepEqual([a === b, b === c], [true, true]);
});

test("identifyChannels（#142 低 5）：同一把 Key 在两个 Sub2API 目录里都有（指纹撞车）——保持 ambiguous，不拿 New API 的 reveal 去问 Sub2API 站点，也不静默选一把", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "http://10.0.0.5:8080", keys: [{ i: 0, m: mask, f: fp }] }] }, { headers: { etag: '"v1"' } }));
  const second = { ...sub2Station, id: "s3", baseUrl: "https://s3.example.com" };
  const rt = { store: { list: () => [ownStation, sub2Station, second] } };
  let reveals = 0;
  const result = await identifyChannels(rt, ownStation, { querySub2Metadata: sub2Catalogue([7, "a", fullKey]), revealKeys: async () => { reveals += 1; return {}; } });
  assert.equal(result.channels[0].slots[0].state, "ambiguous");
  assert.deepEqual(result.channels[0].slots[0].matches.map((match) => match.stationId).sort(), ["s2", "s3"]);
  assert.equal(reveals, 0, "指纹撞车 reveal 分不开，不发");
  assert.deepEqual(result.revealIssues, []);
});

test("identifyChannels（#142 低 6）：候选是 Sub2API（地址对上）只读它、认出就不读非候选；sub2api-password 类型也认得出", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: "https://s2.example.com", keys: [{ i: 0, m: mask, f: fp }] }] }, { headers: { etag: '"v1"' } }));
  const password = { id: "s2", type: "sub2api-password", baseUrl: "https://s2.example.com", email: "a@example.test", password: "pw" };
  const other = { id: "s9", type: "sub2api", baseUrl: "https://other.example.com", accessToken: "jwt" };
  const rt = { store: { list: () => [ownStation, password, other] } };
  const readStations = [];
  const querySub2Metadata = async (station, options) => { readStations.push(station.id); return sub2Catalogue([7, "s2-key", fullKey])(station, options); };
  const result = await identifyChannels(rt, ownStation, { querySub2Metadata });
  assert.deepEqual(result.channels[0].slots, [{ index: 0, state: "identified", matches: [{ stationId: "s2", tokenId: 7, tokenName: "s2-key", via: "fingerprint" }] }]);
  assert.deepEqual(readStations, ["s2"], "只读候选，认出就不读非候选");
});

// 审核 #133 第 2 轮 M1：readAt 是读取服务那台机器的时钟，不能照单全收
test("identifyChannelsCached（M1）：读取服务给的 readAt 在 [现在 − 7 分钟, 现在 + 1 分钟] 里才采用（偏快一点的夹到现在）；偏快很多、偏慢很多都丢掉：b 用控制台的时刻，a 这一轮不推进", async (t) => {
  const real = Date.now();
  t.mock.method(console, "warn", () => {});
  const ask = async (readAt) => {
    t.mock.method(globalThis, "fetch", fakeFetch({ v: 1, db: "mysql", readAt, channels: [{ id: 1, keyless: true }] }, { headers: { etag: `"v-${readAt}"` } }));
    const rt = { store: { list: () => [ownStation] } };
    return identifyChannelsCached(rt, ownStation);
  };
  const fine = await ask(real - 60_000);
  assert.ok(Math.abs(fine.readAtMs - (real - 60_000)) < 2000 && fine.confirmedAtMs === fine.readAtMs, "正常的采用");
  const slightlyAhead = await ask(real + 30_000);
  assert.ok(slightlyAhead.readAtMs <= Date.now() && slightlyAhead.readAtMs >= real, "偏快一点的夹到现在，不会比控制台还晚");
  const farAhead = await ask(real + 60 * 60_000); // 那台机器的钟快了一小时
  assert.equal(farAhead.readAtMs, undefined);
  assert.equal(farAhead.confirmedAtMs, null, "钟快了一小时：不采用，这一轮不推进 a（a 不会被卡在将来，也不会比真正换 Key 的时刻晚）");
  assert.ok(farAhead.fetchedAtMs <= Date.now(), "b 用控制台拿到快照的时刻");
  const farBehind = await ask(real - 60 * 60_000);
  assert.equal(farBehind.readAtMs, undefined);
  assert.equal(farBehind.confirmedAtMs, null, "慢了一小时也一样，a 留在上一次读成功的时刻");
});

test("identifyChannelsCached（#143 低-6）：不传 fresh 时 4 分钟内沿用缓存（不请求读取服务）；传了 fresh 就真的再请求一次读取服务（etag 照用）", async (t) => {
  let asked = 0;
  t.mock.method(globalThis, "fetch", async () => { asked += 1; return { status: 200, headers: { get: () => null }, json: async () => ({ v: 1, db: "mysql", readAt: Date.now(), channels: [{ id: 1, keyless: true }] }) }; });
  const rt = { store: { list: () => [ownStation] } };
  await identifyChannelsCached(rt, ownStation);
  assert.equal(asked, 1);
  await identifyChannelsCached(rt, ownStation);
  assert.equal(asked, 1, "缓存里的，不再问");
  await identifyChannelsCached(rt, ownStation, { fresh: true });
  assert.equal(asked, 2, "fresh：真的再问一次读取服务");
});

test("keyAgentExceptionIssueOf：地址不是 https / 令牌被拒（401）第一次就是需处理（各挂自己的码），别的读不到连续 3 次才是", async () => {
  const { keyAgentExceptionIssueOf } = await import("./key-agent-resegment.js");
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 0, lastCode: null }), null);
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 1, lastCode: "KEY_AGENT_UNAVAILABLE" }), "KEY_AGENT_UNAVAILABLE");
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 3, lastCode: "KEY_AGENT_UNAVAILABLE" }), "KEY_READER_UNREACHABLE");
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 1, lastCode: "KEY_AGENT_UNAUTHORIZED" }), "KEY_AGENT_UNAUTHORIZED");
  assert.equal(keyAgentExceptionIssueOf({ consecutiveFailures: 1, lastCode: "KEY_AGENT_URL_INVALID" }), "KEY_AGENT_URL_INVALID");
});
