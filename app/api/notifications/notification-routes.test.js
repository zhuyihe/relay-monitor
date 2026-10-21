// 通知接口：不回传密钥；测试已保存的通知方式时服务端补齐留空的密钥，但换了地址的站点就不补，类型以已保存的为准
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { errorText } from "../../../lib/error-copy.js";

async function load(path) {
  const hook = registerHooks({ load(url, context, nextLoad) {
    if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
      source: "export const withAuth = (handler) => handler; export const json = (value, status = 200) => Response.json(value, { status });" };
    return nextLoad(url, context);
  } });
  try { return await import(path); } finally { hook.deregister(); }
}

const channel = () => ({ id: "c1", type: "telegram", name: "运维群", enabled: true, config: { botToken: "123:abc-token", chatId: "42", apiBase: "" } });
const post = (body) => new Request("https://local.test/api/notifications/test", { method: "POST", body: JSON.stringify(body) });

test("GET /api/notifications：密钥换成空串，另给 hasSecret", async () => {
  const { GET } = await load("./route.js");
  const res = await GET(new Request("https://local.test/api/notifications"), { store: { channels: [channel()], rules: {} } });
  const body = await res.json();
  assert.deepEqual(body.channels[0].config, { botToken: "", chatId: "42", apiBase: "" });
  assert.deepEqual(body.channels[0].hasSecret, { botToken: true });
  assert.doesNotMatch(JSON.stringify(body), /abc-token/);
});

test("POST /api/notifications/test：留空的密钥用已保存的补齐；换了地址的站点不补；类型不能改", async (t) => {
  const { POST } = await load("./test/route.js");
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url) => { sent.push(String(url)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
  const rt = { store: { channels: [channel()] } };

  const ok = await (await POST(post({ channelId: "c1", type: "telegram", config: { botToken: "", chatId: "43", apiBase: "" } }), rt)).json();
  assert.equal(ok.ok, true);
  assert.match(sent.at(-1), /^https:\/\/api\.telegram\.org\/bot123:abc-token\/sendMessage$/);

  const moved = await POST(post({ channelId: "c1", type: "telegram", config: { botToken: "", chatId: "42", apiBase: "https://evil.example" } }), rt);
  assert.equal(moved.status, 400);
  assert.deepEqual(await moved.json(), { error: errorText({ code: "ENDPOINT_CHANGED_SECRET_REQUIRED" }), code: "ENDPOINT_CHANGED_SECRET_REQUIRED" });
  assert.equal(sent.length, 1);

  // 换了地址时请求里不带密钥字段、或者给 null，也不补
  for (const config of [{ chatId: "42", apiBase: "https://evil.example" }, { botToken: null, chatId: "42", apiBase: "https://evil.example" }]) {
    const res = await POST(post({ channelId: "c1", type: "telegram", config }), rt);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "ENDPOINT_CHANGED_SECRET_REQUIRED");
  }
  assert.equal(sent.length, 1);

  const retyped = await POST(post({ channelId: "c1", type: "webhook", config: { url: "https://evil.example" } }), rt);
  assert.equal(retyped.status, 400);
  assert.equal((await retyped.json()).code, "INVALID_REQUEST");
  assert.equal(sent.length, 1);
});

test("PUT /api/notifications/channels/:id：换了地址没重填密钥时 400 带码；成功时也不回传密钥", async () => {
  const { PUT } = await load("./channels/[id]/route.js");
  const request = (body) => new Request("https://local.test/api/notifications/channels/c1", { method: "PUT", body: JSON.stringify(body) });
  const failing = { store: { updateChannel: async () => { throw Object.assign(new Error("x"), { code: "ENDPOINT_CHANGED_SECRET_REQUIRED" }); } } };
  const res = await PUT(request({ config: {} }), failing, { id: "c1" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "ENDPOINT_CHANGED_SECRET_REQUIRED");
  const ok = await PUT(request({ name: "x" }), { store: { updateChannel: async () => channel() } }, { id: "c1" });
  assert.deepEqual((await ok.json()).channel.config.botToken, "");
});
