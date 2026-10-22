import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { derive } from "../../../(dashboard)/analytics/derive.ts";

const NOW = Date.parse("2026-10-20T04:00:00Z"); // 上海 12:00
const START = Date.parse("2026-10-13T16:00:00Z"); // 近 7 天的 10-14 零点
let route;
async function ownAnalyticsRoute() {
  if (route) return route;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return nextLoad(url, context);
  } });
  try { route = await import("./route.js"); return route; }
  finally { hook.deregister(); }
}

function fixture(t, { failUsers = false, userCount = 2, resold = false } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const own = { id: "own", name: "自营", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "test", cnyPerUsd: 7,
    resoldAdminKeys: resold ? [{ username: "root", tokenName: "sale" }] : [] };
  const users = [...Array.from({ length: userCount - 1 }, (_, i) => ({ id: i + 2, username: i === 0 ? "customer" : `user-${i}`, role: 1 })), { id: 1, username: "root", role: 100 }];
  const rows = [
    { username: "root", model_name: "m", created_at: (START + 5 * 86400000 + 3600000) / 1000, quota: 100 * 500000, token_used: 10, count: 1 },
    { username: "customer", model_name: "m", created_at: (START + 6 * 86400000 + 3600000) / 1000, quota: 10 * 500000, token_used: 10, count: 1 },
  ];
  const calls = [], controls = { onChannels: null };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input); calls.push(url);
    let data;
    if (url.pathname === "/api/user/") {
      if (failUsers) return Response.json({ success: false, message: "temporarily unavailable" }, { status: 503 });
      const p = Math.max(1, Number(url.searchParams.get("p")));
      data = { items: users.slice((p - 1) * 100, p * 100), total: users.length };
    } else if (url.pathname === "/api/data/" || url.pathname === "/api/data/users") {
      const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
      data = rows.filter((r) => r.created_at >= start && r.created_at <= end);
    } else if (url.pathname === "/api/channel/") {
      await controls.onChannels?.();
      data = { items: [], total: 0 };
    }
    else if (url.pathname === "/api/data/flow") data = [];
    else if (url.pathname === "/api/log/stat") {
      const start = Number(url.searchParams.get("start_timestamp"));
      data = { quota: start === (START + 5 * 86400000) / 1000 ? 20 * 500000 : 0 };
    } else throw new Error(`unexpected path ${url.pathname}`);
    return Response.json({ success: true, data });
  });
  return { own, calls, controls, rt: { store: { list: () => [own] }, history: { usedBetween: () => 0 } } };
}

for (const userCount of [2, 1101]) {
  test(`真实自营分析：${userCount} 个用户时管理员自用日不产生收入，成本估算复用真实分日金额`, async (t) => {
    const f = fixture(t, { userCount });
    const { GET } = await ownAnalyticsRoute();
    const res = await GET(new Request("https://local.test/api/own/analytics?range=7d"), f.rt);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.profit.incomeCny, 70);
    assert.equal(body.profit.adminUsageCny, 700);
    assert.equal(body.profit.profitCny, 70);
    assert.equal(body.byUser.find((u) => u.user === "root").isAdmin, true);
    assert.equal(body.incomeDailyApprox, false);
    assert.deepEqual(body.incomeDaily.map((r) => r.incomeCny), [0, 0, 0, 0, 0, 0, 70]);
    const costs = { days: 7, start: "2026-10-14", end: "2026-10-20", tz: body.tz, stations: [], daily: [] };
    const view = derive(costs, body);
    assert.deepEqual(view.rows.map((r) => r.rev), [0, 0, 0, 0, 0, 0, 70]);
    assert.equal(view.revenue, 70);
    assert.equal(view.revenueApprox, false);
    if (userCount === 1101) assert.equal(f.calls.filter((u) => u.pathname === "/api/user/").length, 12);
  });
}

test("真实自营分析：角色目录 503 返回收入不可确认，不缓存虚假利润", async (t) => {
  const f = fixture(t, { failUsers: true });
  const { GET } = await ownAnalyticsRoute();
  const res = await GET(new Request("https://local.test/api/own/analytics?range=7d"), f.rt);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.code, "OWN_INCOME_UNCONFIRMED");
  assert.equal(body.profit, undefined);
  assert.equal(f.rt._ownCache.size, 0);
  assert.equal(f.rt._ownUsersCache, undefined);
});

test("真实自营分析：转售 Key 的收入留在转售发生日，不挪到销售日", async (t) => {
  const f = fixture(t, { resold: true });
  const { GET } = await ownAnalyticsRoute();
  const body = await (await GET(new Request("https://local.test/api/own/analytics?range=7d"), f.rt)).json();
  assert.equal(body.profit.incomeCny, 210);
  assert.equal(body.profit.adminUsageCny, 560);
  assert.equal(body.profit.resoldCny, 140);
  assert.deepEqual(body.incomeDaily.map((r) => r.incomeCny), [0, 0, 0, 0, 0, 140, 70]);
  assert.equal(body.incomeDaily.reduce((sum, d) => sum + d.incomeCny, 0), body.profit.incomeCny);
});

test("真实自营分析：读取渠道期间修改售价，分日收入和利润仍使用同一份售价快照", async (t) => {
  const f = fixture(t);
  f.controls.onChannels = () => { f.own.cnyPerUsd = 8; f.rt._ownCache.clear(); };
  const { GET } = await ownAnalyticsRoute();
  const request = () => new Request("https://local.test/api/own/analytics?range=7d");
  const body = await (await GET(request(), f.rt)).json();
  assert.equal(f.own.cnyPerUsd, 8, "实际配置已在等待点更新");
  assert.equal(body.profit.incomeCny, 70);
  assert.equal(body.station.cnyPerUsd, 7);
  assert.equal(body.incomeDaily.reduce((sum, d) => sum + d.incomeCny, 0), body.profit.incomeCny);
  assert.equal(f.rt._ownCache.size, 0, "旧口径完成后不重新填充已失效的缓存");
  f.controls.onChannels = null;
  const next = await (await GET(request(), f.rt)).json();
  assert.equal(next.profit.incomeCny, 80, "下一次请求使用新售价");
  assert.equal(next.incomeDaily.reduce((sum, d) => sum + d.incomeCny, 0), 80);
});
