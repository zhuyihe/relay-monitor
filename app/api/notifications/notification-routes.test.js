// 通知接口：不回传密钥；测试已保存的通知方式时服务端补齐留空的密钥，但换了地址的站点就不补，类型以已保存的为准
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { UNNAMED_CHANNEL } from "../../../lib/alert-rules.js";
import { NOTIFY_KEYWORD } from "../../../lib/brand.js";
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

test("POST /api/notifications/test：测试消息写通知方式的名字和业务时区的时间；找不到、没说测哪个、类型认不出都带码", async (t) => {
  const { POST } = await load("./test/route.js");
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
  const rt = { store: { channels: [channel()] } };

  assert.equal((await (await POST(post({ channelId: "c1" }), rt)).json()).ok, true);
  const lines = sent.at(-1).text.split("\n");
  assert.equal(lines[0], "【测试通知】炬元告警中心");
  // 带着推荐给钉钉、飞书机器人设的关键词：测试能过，真推送也能过
  assert.ok(sent.at(-1).text.includes(NOTIFY_KEYWORD));
  assert.equal(lines[1], "这是一条来自炬元控制台的测试消息。");
  assert.equal(lines[2], "通知方式：运维群");
  assert.match(lines[3], /^时间：(\d{4}年)?\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}$/);
  // 最后一行和推送一样是落款（§10）
  assert.equal(lines[4], "炬元告警中心");
  assert.equal(lines.length, 5);
  // 弹窗里填的名字优先；还没保存、也没起名字时写类型名，不写 telegram
  await POST(post({ channelId: "c1", name: " 值班群 " }), rt);
  assert.equal(sent.at(-1).text.split("\n")[2], "通知方式：值班群");
  await POST(post({ type: "telegram", config: { botToken: "1:x", chatId: "1" } }), rt);
  assert.equal(sent.at(-1).text.split("\n")[2], "通知方式：Telegram 机器人");
  // 存库时没起名字的存成「未命名通知方式」，也按没起名字写类型名
  await POST(post({ channelId: "c1" }), { store: { channels: [{ ...channel(), name: UNNAMED_CHANNEL }] } });
  assert.equal(sent.at(-1).text.split("\n")[2], "通知方式：Telegram 机器人");

  const gone = await POST(post({ channelId: "nope" }), rt);
  assert.equal(gone.status, 400);
  assert.deepEqual(await gone.json(), { error: errorText({ code: "NOTIFY_NOT_FOUND" }), code: "NOTIFY_NOT_FOUND" });
  const empty = await POST(post({}), rt);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "INVALID_REQUEST");
  // 类型认不出：照常 200，结果里带码，不发请求
  const before = sent.length;
  const unknown = await (await POST(post({ type: "pigeon", config: {} }), rt)).json();
  assert.deepEqual([unknown.ok, unknown.code], [false, "NOTIFY_TYPE_UNSUPPORTED"]);
  assert.equal(sent.length, before);
  // 对方没收下：结果里带平台对应的码，原文另在 error 里
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
  const denied = await (await POST(post({ channelId: "c1" }), rt)).json();
  assert.deepEqual([denied.ok, denied.code, denied.error], [false, "NOTIFY_AUTH_FAILED", "Unauthorized"]);
});

test("POST /api/notifications/channels：类型认不出时 400 带码；PUT 已经删了时 404 带码", async () => {
  const { POST } = await load("./channels/route.js");
  const bad = await POST(new Request("https://local.test/api/notifications/channels", { method: "POST", body: JSON.stringify({ type: "pigeon" }) }), { store: {} });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: errorText({ code: "NOTIFY_TYPE_UNSUPPORTED" }), code: "NOTIFY_TYPE_UNSUPPORTED" });
  const { PUT } = await load("./channels/[id]/route.js");
  const gone = await PUT(new Request("https://local.test/api/notifications/channels/x", { method: "PUT", body: "{}" }), { store: { updateChannel: async () => null } }, { id: "x" });
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { error: errorText({ code: "NOTIFY_NOT_FOUND" }), code: "NOTIFY_NOT_FOUND" });
});
