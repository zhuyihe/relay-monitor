import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

let route;
async function usageRoute() {
  if (route) return route;
  // 保留真实 GET 和 provider，只替换鉴权适配层。
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return nextLoad(url, context);
  } });
  try { route = await import("./route.js"); return route; }
  finally { hook.deregister(); }
}

for (const [name, range, tz, nowIso, startIso] of [
  ["春季切换后的今天不含昨天最后一小时", "today", "America/Los_Angeles", "2026-03-08T19:00:00Z", "2026-03-08T08:00:00Z"],
  ["秋季切换后的今天保留第一个小时", "today", "America/Los_Angeles", "2026-11-01T20:00:00Z", "2026-11-01T07:00:00Z"],
  ["春季近7天从切换前的当地零点开始", "7d", "America/Los_Angeles", "2026-03-12T19:00:00Z", "2026-03-06T08:00:00Z"],
  ["秋季近7天保留起点日首小时", "7d", "America/Los_Angeles", "2026-11-05T20:00:00Z", "2026-10-30T07:00:00Z"],
  ["春季近30天按日历回推", "30d", "America/Los_Angeles", "2026-03-20T19:00:00Z", "2026-02-19T08:00:00Z"],
  ["重复午夜第一次00点后即可读取当天消费", "today", "America/Havana", "2026-11-01T04:30:00Z", "2026-11-01T04:00:00Z"],
  ["不存在的午夜从当天01点开始", "today", "America/Havana", "2026-03-08T05:30:00Z", "2026-03-08T05:00:00Z"],
  ["滚动24小时仍按真实小时回推", "24h", "America/Los_Angeles", "2026-03-08T19:00:00Z", "2026-03-07T19:00:00Z"],
]) {
  test(`真实用量路由：${name}`, async (t) => {
    const now = Date.parse(nowIso), start = Date.parse(startIso);
    t.mock.timers.enable({ apis: ["Date"], now });
    const rows = [
      { created_at: (start - 30 * 60000) / 1000, quota: 100 * 500000, model_name: "model", token_used: 100, count: 1 },
      { created_at: (start + 10 * 60000) / 1000, quota: 10 * 500000, model_name: "model", token_used: 10, count: 1 },
    ];
    const calls = [];
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input); calls.push(url);
      assert.equal(url.pathname, "/api/data/self");
      const from = Number(url.searchParams.get("start_timestamp")), to = Number(url.searchParams.get("end_timestamp"));
      return Response.json({ success: true, data: rows.filter((row) => row.created_at >= from && row.created_at <= to) });
    });
    let saves = 0;
    const rt = { store: {
      list: () => [{ id: "up", name: "上游", type: "newapi", baseUrl: "https://usage.test", accessToken: "test" }],
      save: async () => { saves++; },
    } };
    const { GET } = await usageRoute();
    const response = await GET(new Request(`https://local.test/api/usage?range=${range}&tz=${encodeURIComponent(tz)}`), rt);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.tz, tz);
    assert.equal(body.startMs, start);
    assert.equal(body.endMs, now);
    assert.equal(body.granularity, range === "7d" || range === "30d" ? "day" : "hour");
    assert.equal(body.stations[0].ok, true);
    assert.equal(body.stations[0].summary.cost, 10);
    assert.equal(calls.length, 1);
    assert.equal(Number(calls[0].searchParams.get("start_timestamp")), start / 1000);
    assert.equal(Number(calls[0].searchParams.get("end_timestamp")), now / 1000 - 1);
    assert.equal(saves, 1);
    if (range === "24h") assert.equal(body.endMs - body.startMs, 86400000);
  });
}

test("滚动24小时的Sub2API仍使用日期接口并标明模型口径", async (t) => {
  const now = Date.parse("2026-03-08T19:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input); calls.push(url);
    assert.equal(url.pathname, "/api/v1/usage/dashboard/snapshot-v2");
    return Response.json({ code: 0, data: { models: [], trend: [] } });
  });
  const rt = { store: {
    list: () => [{ id: "sub2", name: "上游", type: "sub2api", baseUrl: "https://sub2.test", accessToken: "test" }],
    save: async () => {},
  } };
  const { GET } = await usageRoute();
  const body = await (await GET(new Request("https://local.test/api/usage?range=24h&tz=America%2FLos_Angeles"), rt)).json();
  assert.equal(body.endMs - body.startMs, 86400000);
  assert.equal(body.stations[0].ok, true);
  assert.equal(body.stations[0].modelsWindow, "date");
  assert.equal(calls.length, 1, "24h不调用today仪表盘接口");
  assert.equal(calls[0].searchParams.get("start_date"), "2026-03-07");
  assert.equal(calls[0].searchParams.get("end_date"), "2026-03-08");
  assert.equal(calls[0].searchParams.get("timezone"), "America/Los_Angeles");
});
