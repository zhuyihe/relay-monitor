import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// 只换掉鉴权和真正发送这两层，跑的是实际的 POST 处理函数
async function sendRoute(sendReport) {
  globalThis.__reportSendStub = sendReport;
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
    if (url.endsWith("/server/report.js")) return { format: "module", shortCircuit: true,
      source: "export const sendReport = (...args) => globalThis.__reportSendStub(...args);" };
    return nextLoad(url, context);
  } });
  try { return await import("./route.js"); } finally { hook.deregister(); }
}

const request = () => new Request("https://local.test/api/report/send", { method: "POST", body: "{}" });

test("立即发送日报：results 是每个通知方式的结果列表，不再多包一层", async (t) => {
  t.after(() => { delete globalThis.__reportSendStub; });
  const rt = { store: {} };
  const results = [{ id: "a", name: "钉钉", ok: true }, { id: "b", name: "Telegram", ok: false, error: "Unauthorized" }];
  const calls = [];
  const { POST } = await sendRoute(async (...args) => { calls.push(args); return { ok: true, results }; });
  const response = await POST(request(), rt);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, results });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], rt);
});

test("立即发送日报：生成或发送前出错时返回 400，带码给页面按码说", async (t) => {
  t.after(() => { delete globalThis.__reportSendStub; });
  const coded = (code, message) => Object.assign(new Error(message), { code });
  const cases = [
    // 没有能发日报的通知方式、还没设置自营站点：原样带码
    [coded("REPORT_NO_CHANNELS", "没有能发日报的通知方式，请先添加或启用一个"), "REPORT_NO_CHANNELS"],
    [coded("OWN_STATION_UNSET", "还没设置自营站点"), "OWN_STATION_UNSET"],
    // 读自营站点没成：带上游给的码
    [coded("AUTHENTICATION_FAILED", "Unauthorized"), "AUTHENTICATION_FAILED"],
    // 都认不出：按「自营站点暂时读不到」说
    [new Error("boom"), "OWN_STATION_UNAVAILABLE"],
  ];
  for (const [error, code] of cases) {
    const { POST } = await sendRoute(async () => { throw error; });
    const response = await POST(request(), {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: error.message, code });
  }
});
