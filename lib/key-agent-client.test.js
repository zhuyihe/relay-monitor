import assert from "node:assert/strict";
import test from "node:test";
import { fetchKeyAgentSnapshot } from "./key-agent-client.js";

const okChannel = { id: 12, name: "高速 A", type: 1, status: 1, baseUrl: "https://up.example.com", keys: [{ i: 0, m: "AbC1…9f0c", f: "q3J9fingerprint22chars" }] };
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });
const fakeFetch = (respond) => async (url, init) => respond(url, init);

test("只走 HTTPS：地址不是 https:// 直接拒绝，不发请求", async () => {
  let called = false;
  const result = await fetchKeyAgentSnapshot({ url: "http://agent.test", token: "t", fetchImpl: fakeFetch(() => { called = true; }) });
  assert.deepEqual(result, { ok: false, code: "KEY_AGENT_URL_INVALID" });
  assert.equal(called, false);
});

test("200：解析渠道列表，带 Authorization 和 If-None-Match，取出新 ETag", async () => {
  let seen;
  const fetchImpl = fakeFetch((url, init) => {
    seen = { url: String(url), auth: init.headers.Authorization, ifNoneMatch: init.headers["If-None-Match"] };
    return { status: 200, headers: headers({ etag: '"v2"' }), json: async () => ({ v: 1, db: "mysql", readAt: 123, channels: [okChannel] }) };
  });
  const result = await fetchKeyAgentSnapshot({ url: "https://agent.test/", token: "secret-token", etag: '"v1"', fetchImpl });
  assert.equal(seen.url, "https://agent.test/keys");
  assert.equal(seen.auth, "Bearer secret-token");
  assert.equal(seen.ifNoneMatch, '"v1"');
  assert.deepEqual(result, { ok: true, status: 200, channels: [okChannel], etag: '"v2"', stale: false, staleReason: null, readAt: 123 });
});

test("304：沿用上一轮，channels 为 null；没有旧 etag 却收到 304 当响应不对", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 304, headers: headers({}) }));
  const result = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", etag: '"v1"', fetchImpl });
  assert.deepEqual(result, { ok: true, status: 304, channels: null, etag: '"v1"', stale: false, staleReason: null });
  const noEtag = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl });
  assert.deepEqual(noEtag, { ok: false, code: "KEY_AGENT_RESPONSE_INVALID" });
});

test("带 X-Agent-Stale：200 和 304 都识别出来，原因码取 X-Agent-Stale-Reason（没有或不合规时按 DB_ERROR）", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, headers: headers({ etag: '"v1"', "x-agent-stale": "1", "x-agent-stale-reason": "DB_UNREACHABLE" }),
    json: async () => ({ v: 1, db: "mysql", readAt: 1, channels: [] }) }));
  const result = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl });
  assert.deepEqual([result.stale, result.staleReason], [true, "DB_UNREACHABLE"]);
  const noReason = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t",
    fetchImpl: fakeFetch(() => ({ status: 304, headers: headers({ "x-agent-stale": "1" }) })), etag: '"v1"' });
  assert.deepEqual([noReason.stale, noReason.staleReason], [true, "DB_ERROR"]);
});

test("401、503、网络错误、超时、响应形状不对，各给各的码", async () => {
  const unauthorized = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl: fakeFetch(() => ({ status: 401, headers: headers({}) })) });
  assert.deepEqual(unauthorized, { ok: false, code: "KEY_AGENT_UNAUTHORIZED", status: 401 });
  const unavailable = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl: fakeFetch(() => ({ status: 503, headers: headers({}) })) });
  assert.deepEqual(unavailable, { ok: false, code: "KEY_AGENT_UNAVAILABLE", status: 503 });
  const networkError = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl: async () => { throw new Error("boom"); } });
  assert.deepEqual(networkError, { ok: false, code: "KEY_AGENT_UNAVAILABLE" });
  const timeout = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.deepEqual(timeout, { ok: false, code: "KEY_AGENT_UNAVAILABLE" });
  const badJson = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl: fakeFetch(() => ({ status: 200, headers: headers({}), json: async () => { throw new Error("bad"); } })) });
  assert.deepEqual(badJson, { ok: false, code: "KEY_AGENT_RESPONSE_INVALID" });
  const badShape = await fetchKeyAgentSnapshot({ url: "https://agent.test", token: "t", fetchImpl: fakeFetch(() => ({ status: 200, headers: headers({}), json: async () => ({ v: 1, channels: [{ id: 1 }] }) })) });
  assert.deepEqual(badShape, { ok: false, code: "KEY_AGENT_RESPONSE_INVALID" });
});
