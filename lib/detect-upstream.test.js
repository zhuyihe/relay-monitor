import test from "node:test";
import assert from "node:assert/strict";
import { detectUpstream, hostNameOf } from "./detect-upstream.js";

const ok = (extra = {}) => ({ result: { ok: true, remaining: 5, ...extra } });
const bad = (code) => ({ result: { ok: false, code, error: "x" } });

test("sk- 开头：按只用 Key 的上游读，名字用主机名", async () => {
  const calls = [];
  const out = await detectUpstream({ baseUrl: "https://a.example.com", token: "sk-abc" }, { query: async (s) => { calls.push(s.type); return ok(); }, status: async () => { throw new Error("不该探测"); } });
  assert.deepEqual([out.ok, out.type, out.name, calls], [true, "newapi-key", "a.example.com", ["newapi-key"]]);
});

test("地址是 New API：没给用户 ID 就说还要用户 ID；给了就按 New API 账号读，名字取账号名", async () => {
  const status = async () => ({ quotaPerUnit: 500000 });
  assert.deepEqual(await detectUpstream({ baseUrl: "https://n.test", token: "pat" }, { status, query: async () => { throw new Error("不该读"); } }), { ok: false, type: "newapi", needsUserId: true });
  const out = await detectUpstream({ baseUrl: "https://n.test", token: "pat", userId: "7" }, { status, query: async (s) => { assert.equal(s.userId, "7"); return ok({ account: "boss" }); } });
  assert.deepEqual([out.ok, out.type, out.name], [true, "newapi", "boss"]);
});

test("不是 New API：按 Sub2API 登录令牌试；读不到把原因码带回去", async () => {
  const status = async () => { throw new Error("no"); };
  assert.equal((await detectUpstream({ baseUrl: "https://s.test", token: "jwt" }, { status, query: async (s) => { assert.equal(s.type, "sub2api"); return ok(); } })).type, "sub2api");
  const failed = await detectUpstream({ baseUrl: "https://s.test", token: "jwt" }, { status, query: async () => bad("AUTH_FAILED") });
  assert.deepEqual([failed.ok, failed.type, failed.code], [false, "sub2api", "AUTH_FAILED"]);
});

test("主机名：带不带协议都行", () => {
  assert.equal(hostNameOf("api.x.com/path"), "api.x.com");
  assert.equal(hostNameOf("http://127.0.0.1:3000"), "127.0.0.1:3000");
});

test("sk- 开头但 Key 是错的：按只用 Key 的上游读失败，原因码带回去，不去探测 New API", async () => {
  const out = await detectUpstream({ baseUrl: "https://a.example.com", token: "sk-wrong" }, { query: async () => bad("AUTHENTICATION_FAILED"), status: async () => { throw new Error("不该探测"); } });
  assert.deepEqual([out.ok, out.type, out.code], [false, "newapi-key", "AUTHENTICATION_FAILED"]);
});

test("真调探测实现（不用假 status）：地址的 /api/status 读得到就认成 New API 要用户 ID，读不到按 Sub2API 试；探测不带令牌", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push([String(url), init?.headers?.Authorization]);
    return new Response(JSON.stringify(String(url).startsWith("https://newapi.test") ? { success: true, data: { quota_per_unit: 500000, version: "v1.0.0" } } : { success: false }),
      { status: String(url).startsWith("https://newapi.test") ? 200 : 404, headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await detectUpstream({ baseUrl: "https://newapi.test/", token: "pat" }, { query: async () => { throw new Error("不该读"); } }), { ok: false, type: "newapi", needsUserId: true });
  assert.deepEqual(seen[0], ["https://newapi.test/api/status", undefined], "探测不带令牌");
  const sub = await detectUpstream({ baseUrl: "https://s2.test", token: "jwt" }, { query: async (s) => ok({ account: "a@b.c" }) });
  assert.equal(sub.type, "sub2api");
});
