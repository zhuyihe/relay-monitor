// 模型供需的两个接口（/api/models、/api/models/detail）：没设置自营站点、缺模型名、找不到模型时返回什么。
// 算数和读取在 lib/models-view.test.js、server/models-page.test.js 里测；这里只测接口把结果翻成状态码和码。只替换鉴权适配层，路由是真的。
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
    source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
  return nextLoad(url, context);
} });
let list, detail;
try {
  list = (await import("./route.js")).GET;
  detail = (await import("./detail/route.js")).GET;
} finally { hook.deregister(); }

const request = (path) => new Request(`https://local.test${path}`);
const none = () => ({ store: { list: () => [], settings: {}, rules: {} } });

test("没设置自营站点：两个接口都是 400 OWN_STATION_UNSET（页面走设置引导）", async () => {
  for (const response of [await list(request("/api/models"), none()), await detail(request("/api/models/detail?name=gpt-5"), none())]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "OWN_STATION_UNSET");
  }
});

test("抽屉接口：没带模型名是 400 MODEL_REQUIRED", async () => {
  const response = await detail(request("/api/models/detail"), none());
  assert.deepEqual([response.status, (await response.json()).code], [400, "MODEL_REQUIRED"]);
});
