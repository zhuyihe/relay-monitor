// 路由外壳：初始化失败和数据库直接抛出来的报错，原文不回给页面（未登录的请求也会走到这里）
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { errorText } from "./error-copy.js";

async function api() {
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === "next/server" ? { url: "stub:next-server", shortCircuit: true } : nextResolve(specifier, context);
  }, load(url, context, nextLoad) {
    if (url === "stub:next-server") return { format: "module", shortCircuit: true,
      source: "export const NextResponse = { json: (data, init) => Response.json(data, init) };" };
    if (url.endsWith("/lib/runtime.js")) return { format: "module", shortCircuit: true,
      source: "export async function getRuntime() { if (globalThis.__apiTestInitError) throw globalThis.__apiTestInitError; return { store: {} }; }" };
    return nextLoad(url, context);
  } });
  try { return await import("./api.js"); } finally { hook.deregister(); }
}

const request = () => new Request("https://local.test/api/meta");
const dbError = () => Object.assign(new Error("Access denied for user 'relay'@'10.0.0.5' / Duplicate entry 'sk-live-secret'"), {
  code: "ER_DUP_ENTRY", sql: "INSERT INTO stations (doc) VALUES ('{\"accessToken\":\"sk-live-secret\"}')", sqlMessage: "Duplicate entry",
});

test("withRuntime：初始化失败只说系统还没准备好；数据库原文不回给页面；普通报错照常带原文", async (t) => {
  t.mock.method(console, "error", () => {});
  t.after(() => { delete globalThis.__apiTestInitError; });
  const { withRuntime } = await api();

  globalThis.__apiTestInitError = dbError();
  const notReady = await withRuntime(async () => new Response("ok"))(request());
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), { error: errorText({ code: "NOT_READY" }), code: "NOT_READY" });
  delete globalThis.__apiTestInitError;

  const failed = await withRuntime(async () => { throw dbError(); })(request());
  assert.equal(failed.status, 500);
  const body = await failed.json();
  assert.equal(body.error, errorText({}));
  assert.doesNotMatch(JSON.stringify(body), /sk-live-secret|relay|INSERT/);

  const plain = await withRuntime(async () => { throw new Error("对账还没跑完"); })(request());
  assert.equal((await plain.json()).error, "对账还没跑完");
  // 日志里也没有原文
  assert.doesNotMatch(JSON.stringify(console.error.mock.calls.map((c) => c.arguments)), /sk-live-secret|INSERT/);
});
