import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintKey, maskKey, deriveAgentKeys } from "../lib/key-fingerprint.js";
import { keyBindingReport } from "./key-agent-report.js";

const STRONG_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
const { fingerprintKey: fpBytes } = deriveAgentKeys(STRONG_SECRET);
const ownStation = { id: "own", isOwn: true, type: "newapi", keyAgentUrl: "https://own.test/key-agent", keyAgentSecret: STRONG_SECRET };
const fullKey = "sk-" + "Ab1c".repeat(10);
const mask = maskKey(fullKey);
const fp = fingerprintKey(fullKey, fpBytes);
const upstream = { id: "up1", type: "newapi", baseUrl: "https://up.example.com" };

function snapshotFetch(channels) {
  return async () => ({ status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
    json: async () => ({ v: 1, db: "mysql", readAt: 1, channels }) });
}

const rule = (patch) => ({ id: "r1", enabled: true, archivedAt: null, ownStationId: "own", upstreamStationId: "up1", tokenId: 9,
  channels: [{ channelId: 1 }], ...patch });

test("keyBindingReport：没绑定但认出来了——没对上，报不是绑错而是没绑定", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.equal(report.ok, true);
  assert.deepEqual(report.mismatches, [{ channelId: 1, kind: "unbound", identified: [{ stationId: "up1", tokenId: 9, tokenName: "oai", via: "fingerprint" }] }]);
});

test("keyBindingReport：绑的 Key 和认出来的不是一把——绑错了", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [rule({ tokenId: 8 })] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.deepEqual(report.mismatches, [{
    channelId: 1, kind: "different_key",
    bound: [{ stationId: "up1", tokenId: 8, ruleId: "r1" }],
    identified: [{ stationId: "up1", tokenId: 9, tokenName: "oai", via: "fingerprint" }],
  }]);
});

test("keyBindingReport：绑的和认出来的是同一把——不进报告", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [rule({ tokenId: 9 })] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.deepEqual(report.mismatches, []);
});

// 审核 #131 低项：标题写了三种认不出的状态，原来只构造了 not_found 一种；三种各造一遍
for (const [state, { queryMetadata, extraMaskedChannel }] of Object.entries({
  not_found: { queryMetadata: async () => ({ tokens: [] }) }, // 候选上游读到了，但没有这把
  unresolved: { queryMetadata: async () => { throw new Error("候选上游这一轮读不到"); } }, // 候选上游这一轮没读到，不下结论
  ambiguous: { queryMetadata: async () => ({ tokens: [{ id: 1, name: "a", maskedKey: mask }, { id: 2, name: "b", maskedKey: mask }] }), extraMaskedChannel: true }, // 打码撞了两把，又没权限取完整 Key
})) {
  test(`keyBindingReport：绑了但这一轮认不出来（${state}）——不进报告，不是绑错了`, async (t) => {
    // ambiguous 要指纹对不上任何完整 Key（只给打码），才会走到「打码撞了」；其余两种沿用能对上的指纹
    const slot = extraMaskedChannel ? { i: 0, m: mask, f: "no-full-key-matches-this" } : { i: 0, m: mask, f: fp };
    t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [slot] }]));
    const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [rule({})] } };
    const revealKeys = async () => { throw Object.assign(new Error("少了权限"), { code: "ACCESS_TOKEN_SCOPE_DENIED", scope: "api_key:reveal" }); };
    const report = await keyBindingReport(rt, ownStation, { queryMetadata, revealKeys });
    assert.deepEqual(report.mismatches, []);
  });
}

test("keyBindingReport（审核 #131 M2）：读取服务给的是旧结果（X-Agent-Stale）时，stale/staleReason 带在报告上，不丢", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 200,
    headers: { get: (name) => ({ "x-agent-stale": "1", "x-agent-stale-reason": "DB_ERROR", etag: '"v1"' })[name.toLowerCase()] ?? null },
    json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }] }) }));
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.equal(report.stale, true);
  assert.equal(report.staleReason, "DB_ERROR");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const freshRt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [] } }; // 新的 rt：不命中上面那份旧结果的缓存
  const fresh = await keyBindingReport(freshRt, ownStation, { queryMetadata });
  assert.equal(fresh.stale, false);
});

test("keyBindingReport：没配读取服务，原样带出没配的码", async () => {
  const rt = { store: { list: () => [] }, reconciliation: { listRules: async () => { throw new Error("不该问绑定规则"); } } };
  const report = await keyBindingReport(rt, { id: "own", isOwn: true });
  assert.deepEqual(report, { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" });
});

test("keyBindingReport：没有名字的渠道（keyless）不进报告", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, keyless: true, baseUrl: upstream.baseUrl }]));
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [] } };
  const report = await keyBindingReport(rt, ownStation);
  assert.deepEqual(report.mismatches, []);
});
