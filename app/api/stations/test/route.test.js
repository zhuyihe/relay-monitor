// 测试读取：编辑既有上游时留空的令牌沿用已保存的，但换了地址的站点就不沿用（lib/endpoint.js），不把它发到新地址
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { errorText } from "../../../../lib/error-copy.js";

async function route() {
  globalThis.__stationTestCalls = [];
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = (handler) => handler; export const json = (value, status = 200) => Response.json(value, { status });" };
    if (url.endsWith("/lib/providers.js")) return { format: "module", shortCircuit: true, source: [
      "export const STATION_TYPES = [{ value: \"newapi\" }, { value: \"newapi-key\" }, { value: \"fixed\" }];",
      "export async function queryStation(station) { globalThis.__stationTestCalls.push(station); return { result: { ok: true, latencyMs: 1, remaining: 1 } }; }",
    ].join("\n") };
    return nextLoad(url, context);
  } });
  try { return await import("./route.js"); } finally { hook.deregister(); }
}

const saved = { id: "s1", type: "newapi", baseUrl: "https://a.example", accessToken: "tok-saved", userId: "7" };
const rt = { store: { list: () => [saved] } };
const post = (body) => new Request("https://local.test/api/stations/test", { method: "POST", body: JSON.stringify(body) });

test("测试读取：同一站点（含只改路径、没带地址）留空的令牌用已保存的；换了站点就不发出去，带 ENDPOINT_CHANGED_SECRET_REQUIRED", async (t) => {
  t.after(() => { delete globalThis.__stationTestCalls; });
  const { POST } = await route();
  const calls = globalThis.__stationTestCalls;
  const ask = async (body) => { const res = await POST(post({ stationId: "s1", type: "newapi", userId: "7", ...body }), rt); return res.json(); };

  assert.equal((await ask({ baseUrl: "https://a.example/v1", accessToken: "" })).ok, true);
  assert.equal(calls.at(-1).accessToken, "tok-saved");
  assert.equal((await ask({})).ok, true);
  assert.deepEqual([calls.at(-1).baseUrl, calls.at(-1).accessToken], ["https://a.example", "tok-saved"]);

  const before = calls.length;
  for (const baseUrl of ["https://evil.example", "http://a.example", "https://a.example:8443"]) {
    const result = await ask({ baseUrl, accessToken: "" });
    assert.deepEqual([result.ok, result.code, result.message], [false, "ENDPOINT_CHANGED_SECRET_REQUIRED", errorText({ code: "ENDPOINT_CHANGED_SECRET_REQUIRED" })]);
  }
  assert.equal(calls.length, before);

  // 重新填了令牌就照常测
  assert.equal((await ask({ baseUrl: "https://evil.example", accessToken: "tok-new" })).ok, true);
  assert.equal(calls.at(-1).accessToken, "tok-new");
});
