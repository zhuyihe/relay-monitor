// 用户运营的三个接口（/api/users、/api/users/[id]、/api/users/big）：没设置自营站点、后台还没读到过数、用户不存在时返回什么。
// 算数本身在 server/user-ops.test.js 里测；这里只测接口把结果翻成状态码和码。只替换鉴权适配层，路由是真的。
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createUserOps } from "../../../server/user-ops.js";
import { MemoryUserOpsStore } from "../../../server/test-support/user-ops-memory-store.js";

const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
    source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
  return nextLoad(url, context);
} });
let list, one, big;
try {
  list = (await import("./route.js")).GET;
  one = (await import("./[id]/route.js")).GET;
  big = (await import("./big/route.js")).GET;
} finally { hook.deregister(); }

const own = { id: "own1", name: "我的站点", isOwn: true, type: "newapi", baseUrl: "https://own.test", accessToken: "tok" };
const request = (path) => new Request(`https://local.test${path}`);
// 有自营站点、有存储、后台一轮都没跑过
const fresh = () => {
  const rt = { store: { list: () => [own], settings: {}, rules: {}, channels: [] }, pool: {} };
  rt._userOpsStore = new MemoryUserOpsStore();
  rt.userOps = createUserOps(rt, { store: rt._userOpsStore });
  return rt;
};
const none = () => ({ store: { list: () => [], settings: {}, rules: {}, channels: [] }, pool: {} , _userOpsStore: new MemoryUserOpsStore() });

test("没设置自营站点：三个接口都是 400 OWN_STATION_UNSET（页面走设置引导）", async () => {
  const rt = none();
  rt.userOps = createUserOps(rt, { store: rt._userOpsStore });
  for (const response of [await list(request("/api/users"), rt), await one(request("/api/users/1"), rt, { id: "1" }), await big(request("/api/users/big"), rt)]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "OWN_STATION_UNSET");
  }
});

test("后台还没读到过数：整页是 starting（页面写数据补全中），名单 ready: false，抽屉找不到用户是 404 USER_NOT_FOUND", async () => {
  const rt = fresh();
  const page = await (await list(request("/api/users"), rt)).json();
  assert.equal(page.starting, true);
  assert.deepEqual([page.backfill.done, page.backfill.days, page.backfill.total, page.users.length], [false, 0, 60, 0]);
  assert.equal(typeof page.tz, "string");
  assert.equal(page.summary, null);
  assert.deepEqual(await (await big(request("/api/users/big"), rt)).json(), { ready: false, big: [] });
  const missing = await one(request("/api/users/7"), rt, { id: "7" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "USER_NOT_FOUND");
});

test("没有数据库（rt.pool 空）：不报错，整页是 starting，抽屉 404；没设置自营站点仍是 400", async () => {
  const rt = { store: { list: () => [own], settings: {}, rules: {}, channels: [] } };
  assert.equal((await (await list(request("/api/users"), rt)).json()).starting, true);
  assert.equal((await one(request("/api/users/1"), rt, { id: "1" })).status, 404);
  assert.deepEqual(await (await big(request("/api/users/big"), rt)).json(), { ready: false, big: [] });
  const unset = { store: { list: () => [], settings: {}, rules: {}, channels: [] } };
  assert.equal((await list(request("/api/users"), unset)).status, 400);
  assert.equal((await one(request("/api/users/1"), unset, { id: "1" })).status, 400);
});
