import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

let route;
async function consumeLogRoute() {
  if (route) return route;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    return nextLoad(url, context);
  } });
  try { route = await import("./route.js"); return route; }
  finally { hook.deregister(); }
}

test("自营站点收费记录：GET 只给最近一次的结果不发请求；POST「重新检查」马上再读一次，关着记一段、开回来关上；返回里没有别的设置", async (t) => {
  const { GET, POST } = await consumeLogRoute();
  const own = { id: "own", type: "newapi", isOwn: true, baseUrl: "https://own.test", accessToken: "admin", consumeLogOffPeriods: [] };
  const rt = { store: { list: () => [own], get: () => own, update: async (id, patch) => Object.assign(own, patch) } };
  let value = "false", calls = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/api/option/");
    calls += 1;
    return Response.json({ success: true, data: [{ key: "SMTPToken", value: "秘密" }, { key: "LogConsumeEnabled", value }] });
  });
  const before = await (await GET({}, rt)).json();
  assert.deepEqual([before.status, calls], [null, 0], "GET 不发请求，还没读过就是 null");
  const off = await (await POST({}, rt)).json();
  assert.deepEqual(off.status, { state: "off" });
  assert.equal(off.offPeriods.length, 1);
  assert.equal(off.offPeriods[0].toMs, null);
  assert.ok(!JSON.stringify(off).includes("秘密"), "别的设置不进返回值");
  const same = await (await GET({}, rt)).json();
  assert.deepEqual([same.status, calls], [{ state: "off" }, 1]);
  value = "true";
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60000 });
  const on = await (await POST({}, rt)).json();
  assert.deepEqual(on.status, { state: "on" });
  assert.notEqual(on.offPeriods[0].toMs, null, "开回来：段关上");
  assert.equal(calls, 2);
  const none = await (await GET({}, { store: { list: () => [] } })).json();
  assert.equal(none.code, "OWN_STATION_UNSET");
});
