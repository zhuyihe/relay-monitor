import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// 系统设置接口：GET 多给 ownLog（自营站点的收费记录读到哪儿了、落后多少、哪几天没读全；应付成本 V1-a）；PUT 收 expectedCost（只有明确 false 才关）
let route;
async function settingsRoute() {
  if (route) return route;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    if (url.endsWith("/server/refresh.js")) return { format: "module", shortCircuit: true, source: "export const restartPolling = () => {}; export const refreshAll = async () => {};" };
    return nextLoad(url, context);
  } });
  try { route = await import("./route.js"); return route; }
  finally { hook.deregister(); }
}

const NOW = Date.parse("2026-10-26T06:30:00Z"); // 上海 10-26 14:30
function runtime({ own = true, cursor = { coveredFromMs: Date.parse("2026-10-23T16:00:00Z"), coveredToMs: Date.parse("2026-10-26T05:10:00Z") } } = {}) {
  const settings = { refreshIntervalSec: 60 };
  return {
    pool: {},
    store: { settings, secretsEncrypted: true, list: () => (own ? [{ id: "own", isOwn: true, type: "newapi" }] : []),
      updateSettings: async (patch) => Object.assign(settings, patch) },
    history: { getSummary: async () => ({}) },
    _ownLogStore: { getCursor: async () => cursor },
  };
}

test("GET /api/settings 带 ownLog：进度两头、落后多少、哪几天没读全；没有自营站点或没有进度时 null", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { GET } = await settingsRoute();
  const read = async (rt) => (await (await GET(new Request("http://x/api/settings"), rt)).json()).ownLog;
  assert.deepEqual(await read(runtime()), { coveredFromMs: Date.parse("2026-10-23T16:00:00Z"), coveredToMs: Date.parse("2026-10-26T05:10:00Z"), behindMs: 80 * 60000, incompleteDays: [] }, "读到今天 13:10：落后 80 分钟，过去的日子都全");
  assert.deepEqual((await read(runtime({ cursor: { coveredFromMs: 0, coveredToMs: Date.parse("2026-10-24T03:00:00Z") } }))).incompleteDays, ["2026-10-24", "2026-10-25"], "读到 10-24 11:00：24、25 两天没读全");
  assert.deepEqual((await read(runtime({ cursor: { coveredFromMs: 0, coveredToMs: Date.parse("2026-10-24T16:00:00Z") } }))).incompleteDays, ["2026-10-25"], "正好读到 24 日结束：24 日是全的");
  assert.equal(await read(runtime({ own: false })), null);
  assert.equal(await read(runtime({ cursor: null })), null);
});

test("PUT /api/settings 只带 expectedCost：只认真正的 true / false，别的值一律当关；不带就不动", async () => {
  const { PUT } = await settingsRoute();
  const rt = runtime();
  const put = (body) => PUT(new Request("http://x/api/settings", { method: "PUT", body: JSON.stringify(body) }), rt);
  assert.equal((await (await put({ expectedCost: false })).json()).settings.expectedCost, false);
  assert.equal((await (await put({ expectedCost: true })).json()).settings.expectedCost, true);
  assert.equal((await (await put({ expectedCost: "yes" })).json()).settings.expectedCost, false, "字符串不算开");
  await put({ expectedCost: false });
  assert.equal((await (await put({ refreshIntervalSec: 90 })).json()).settings.expectedCost, false, "不带 expectedCost 就不动");
});
