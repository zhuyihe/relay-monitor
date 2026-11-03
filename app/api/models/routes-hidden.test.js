// 模型供需模块隐藏中（lib/features.js）：两个接口都是 404，不碰数据库和用户站；导航里没有这一项。
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { FEATURES } from "../../../lib/features.js";
import { NAV_ITEMS, navItemFor } from "../../../lib/nav.js";

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
// 碰了 store 或 pool 就说明没拦住
const trap = () => new Proxy({}, { get() { throw new Error("隐藏时不该读任何东西"); } });

test("默认是隐藏的", () => { assert.equal(FEATURES.modelsModule, false); });

test("模块隐藏：/api/models 和 /api/models/detail 都是 404，什么都不读", async () => {
  for (const response of [await list(request("/api/models"), trap()), await detail(request("/api/models/detail?name=gpt-5"), trap())]) assert.equal(response.status, 404);
});

test("模块隐藏：导航里没有「模型供需」，/models 也认不出是哪个导航项", () => {
  assert.equal(NAV_ITEMS.some((item) => item.key === "models" || item.path === "/models"), false);
  assert.equal(navItemFor("/models")?.key ?? null, null);
});
