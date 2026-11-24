import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { COOKIE_NAME } from "../../../../lib/auth.js";
import { dayKeyInTz } from "../../../../lib/business-time.js";

const hook = registerHooks({ resolve(specifier, context, next) { return next(specifier === "next/server" ? "next/server.js" : specifier, context); }, load(url, context, next) {
  if (url.endsWith("/lib/runtime.js")) return { format: "module", shortCircuit: true, source: "export const getRuntime = async () => globalThis.__userGroupsRuntime;" };
  return next(url, context);
} });
let GET, POST;
try { ({ GET, POST } = await import("./route.js")); } finally { hook.deregister(); }
const request = (query = "", method = "GET", login = true) => new Request(`https://console.test/api/users/groups${query}`, { method, headers: login ? { cookie: `${COOKIE_NAME}=valid` } : {} });
const runtime = (own = true, paused = false) => {
  const now = Date.now();
  return { store: { auth: { isDefault: false }, settings: { userOpsEnabled: !paused }, list: () => own ? [{ id: "own", isOwn: true, type: "newapi", baseUrl: "https://own.test" }] : [] },
    sessions: { verify: token => token === "valid" ? { v: 1 } : null, sessionVersion: () => 1 }, userOps: { refreshLive: () => { throw Error("不得请求源站"); } },
    _userOpsDirectory: { stationId: "own", at: now, users: [] },
    _userOpsPageCache: { payload: { ownStationId: "own", today: dayKeyInTz(now, "Asia/Shanghai"), tz: "Asia/Shanghai", syncedMs: now, users: [], rate: 1 } } };
};

test("分组接口GET与POST均要求真实登录会话", async () => {
  globalThis.__userGroupsRuntime = runtime();
  for (const [method, handler] of [["GET", GET], ["POST", POST]]) assert.equal((await handler(request("", method, false))).status, 401);
});
test("未设置主站及无效日期在入口返回明确错误，不进入采集", async () => {
  globalThis.__userGroupsRuntime = runtime(false);
  assert.equal((await GET(request())).status, 400);
  globalThis.__userGroupsRuntime = runtime();
  const response = await GET(request("?preset=invalid"));
  assert.equal(response.status, 400); assert.equal((await response.json()).code, "USER_GROUPS_RANGE_INVALID");
});
test("暂停时POST不可同步，GET不额外采集并返回未同步状态", async () => {
  globalThis.__userGroupsRuntime = runtime(true, true);
  assert.equal((await POST(request("", "POST"))).status, 403);
  const response = await GET(request());
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.paused, true); assert.equal(body.starting, true); assert.equal(body.asOf, null);
});
