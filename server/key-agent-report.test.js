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
  assert.deepEqual(report.mismatches, [{ channelId: 1, kind: "unbound", identified: [{ stationId: "up1", tokenId: 9, tokenName: "oai" }] }]);
});

test("keyBindingReport：绑的 Key 和认出来的不是一把——绑错了", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [rule({ tokenId: 8 })] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.deepEqual(report.mismatches, [{
    channelId: 1, kind: "different_key",
    bound: [{ stationId: "up1", tokenId: 8, ruleId: "r1" }],
    identified: [{ stationId: "up1", tokenId: 9, tokenName: "oai" }],
  }]);
});

test("keyBindingReport：绑的和认出来的是同一把——不进报告", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const queryMetadata = async () => ({ tokens: [{ id: 9, name: "oai", maskedKey: fullKey }] });
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [rule({ tokenId: 9 })] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.deepEqual(report.mismatches, []);
});

test("keyBindingReport：绑了但这一轮认不出来（not_found/ambiguous/unresolved）——不进报告，不是绑错了", async (t) => {
  t.mock.method(globalThis, "fetch", snapshotFetch([{ id: 1, baseUrl: upstream.baseUrl, keys: [{ i: 0, m: mask, f: fp }] }]));
  const queryMetadata = async () => ({ tokens: [] }); // 候选上游读不出同名的 Key，认不出
  const rt = { store: { list: () => [ownStation, upstream] }, reconciliation: { listRules: async () => [rule({})] } };
  const report = await keyBindingReport(rt, ownStation, { queryMetadata });
  assert.deepEqual(report.mismatches, []);
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
