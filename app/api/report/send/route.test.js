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

test("立即发送日报：results 是每个通知方式的结果列表，不再多包一层", async () => {
  const results = [{ id: "a", name: "钉钉", ok: true }, { id: "b", name: "Telegram", ok: false, error: "Unauthorized" }];
  const { POST } = await sendRoute(async () => ({ ok: true, results }));
  const response = await POST(new Request("https://local.test/api/report/send", { method: "POST", body: "{}" }), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, results });
});
