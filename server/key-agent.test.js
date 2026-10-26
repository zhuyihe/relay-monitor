import assert from "node:assert/strict";
import test from "node:test";
import { deriveAgentKeys } from "../lib/key-fingerprint.js";
import { keyAgentConfigOf, readKeyAgent } from "./key-agent.js";

const STRONG_SECRET = "K7m2-xP9q" + "R4t".repeat(10);

function fakeFetch(body, { status = 200, headers = {} } = {}) {
  return async () => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body });
}

test("keyAgentConfigOf：url、secret 都填了才算配好；secret 太弱当没配（和启动时一样，不抛错）", () => {
  assert.equal(keyAgentConfigOf({ keyAgentUrl: "", keyAgentSecret: STRONG_SECRET }), null);
  assert.equal(keyAgentConfigOf({ keyAgentUrl: "https://a.test", keyAgentSecret: "" }), null);
  assert.equal(keyAgentConfigOf({ keyAgentUrl: "https://a.test", keyAgentSecret: "too-short" }), null);
  const config = keyAgentConfigOf({ keyAgentUrl: "https://a.test", keyAgentSecret: STRONG_SECRET });
  assert.equal(config.url, "https://a.test");
  assert.ok(Buffer.isBuffer(config.fingerprintKey));
});

test("readKeyAgent：地址没填当没配；地址填了令牌太弱说清是哪一种；配好了问读取服务，返回渠道数", async () => {
  assert.deepEqual(await readKeyAgent({ keyAgentUrl: "", keyAgentSecret: "" }), { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" });
  const weak = await readKeyAgent({ keyAgentUrl: "https://a.test", keyAgentSecret: "too-short" });
  assert.equal(weak.code, "SECRET_TOO_SHORT");
  const result = await readKeyAgent({ keyAgentUrl: "https://a.test/key-agent", keyAgentSecret: STRONG_SECRET },
    { fetchImpl: fakeFetch({ v: 1, db: "mysql", readAt: 1, channels: [{ id: 1, keyless: true }, { id: 2, keyless: true }] }, { headers: { etag: '"v1"' } }) });
  assert.deepEqual(result, { ok: true, channelCount: 2, stale: false, staleReason: null, etag: '"v1"' });
});
