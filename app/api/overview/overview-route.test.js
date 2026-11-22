import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { COOKIE_NAME } from "../../../lib/auth.js";

// 只换运行时来源；保留真正的 withAuth，确认未登录不能进入首页汇总。
const hook = registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier === "next/server" ? "next/server.js" : specifier, context); }, load(url, context, nextLoad) {
  if (url.endsWith("/lib/runtime.js")) return { format: "module", shortCircuit: true, source: "export const getRuntime = async () => globalThis.__overviewTestRuntime;" };
  return nextLoad(url, context);
} });
let GET;
try { ({ GET } = await import("./route.js")); } finally { hook.deregister(); }
const request = (query = "", login = true) => new Request(`https://console.test/api/overview${query}`, { headers: login ? { cookie: `${COOKIE_NAME}=valid` } : {} });
const runtime = () => ({
  store: { auth: { isDefault: false }, list: () => [] },
  sessions: { verify: token => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 },
});

test("overview GET 要求登录，未登录返回401且不进入数据汇总", async () => {
  globalThis.__overviewTestRuntime = runtime();
  const response = await GET(request("", false));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNAUTHORIZED");
});

test("overview 仅接受今天/昨天，拒绝任意历史范围", async () => {
  globalThis.__overviewTestRuntime = runtime();
  for (const query of ["?preset=7d", "?preset=custom", "?preset=invalid"]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  for (const query of ["", "?preset=today", "?preset=yesterday"]) {
    const response = await GET(request(query));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { unset: true });
  }
});

test("overview 初始密码会话需要先修改密码", async () => {
  globalThis.__overviewTestRuntime = runtime();
  globalThis.__overviewTestRuntime.store.auth.isDefault = true;
  const response = await GET(request());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "DEFAULT_PASSWORD_CHANGE_REQUIRED");
});
