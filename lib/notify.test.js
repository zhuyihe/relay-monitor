// 通知方式的密钥：接口不回传、编辑时留空沿用、换了地址的站点就不沿用、发送报错打码
import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_TYPES, TRUNCATED_NOTE, publicChannel, resolveChannelConfig, sendToChannel } from "./notify.js";

const SAVED_TELEGRAM = { botToken: "123:abc-token", chatId: "42", apiBase: "" };

test("CHANNEL_TYPES：原来前端那份密钥名单里的字段都标成密钥，地址字段都标了 endpoint", () => {
  const secretKeys = ["botToken", "secret", "token", "sendKey", "apiKey", "password", "deviceKey", "webhook", "url", "headersJson"];
  for (const type of CHANNEL_TYPES) {
    for (const field of type.fields) {
      if (secretKeys.includes(field.key)) assert.equal(field.secret, true, `${type.value}.${field.key}`);
    }
  }
  const endpoints = CHANNEL_TYPES.flatMap((type) => type.fields.filter((f) => f.endpoint).map((f) => `${type.value}.${f.key}`));
  assert.deepEqual(endpoints, ["telegram.apiBase", "dingtalk.webhook", "wecom.webhook", "feishu.webhook", "bark.server", "ntfy.server", "smtp.host", "smtp.port", "webhook.url"]);
});

test("publicChannel：密钥换成空串，另给 hasSecret；不改原对象", () => {
  const channel = { id: "c1", type: "telegram", name: "运维群", config: { ...SAVED_TELEGRAM } };
  const view = publicChannel(channel);
  assert.deepEqual(view.config, { botToken: "", chatId: "42", apiBase: "" });
  assert.deepEqual(view.hasSecret, { botToken: true });
  assert.equal(channel.config.botToken, "123:abc-token");
  assert.deepEqual(publicChannel({ id: "c2", type: "dingtalk", config: { webhook: "https://oapi.dingtalk.com/robot/send?access_token=x" } }).hasSecret,
    { webhook: true, secret: false });
  // 白名单：字段表以外的键、认不出的类型，一律不回
  assert.deepEqual(publicChannel({ id: "c3", type: "telegram", config: { ...SAVED_TELEGRAM, legacyToken: "old-secret" } }).config, { botToken: "", chatId: "42", apiBase: "" });
  assert.deepEqual(publicChannel({ id: "c4", type: "legacy", config: { token: "old-secret" } }).config, {});
});

test("resolveChannelConfig：密钥留空沿用，非密钥按这次填的写（留空就是清空），没出现的字段不动，不认识的字段不收", () => {
  assert.deepEqual(resolveChannelConfig("telegram", { botToken: "", chatId: "43", apiBase: "" }, SAVED_TELEGRAM),
    { botToken: "123:abc-token", chatId: "43", apiBase: "" });
  // 填上官方地址和不填是同一个站点
  assert.equal(resolveChannelConfig("telegram", { botToken: "", apiBase: "https://api.telegram.org/" }, SAVED_TELEGRAM).botToken, "123:abc-token");
  assert.deepEqual(resolveChannelConfig("telegram", { chatId: "43", evil: "x" }, SAVED_TELEGRAM), { ...SAVED_TELEGRAM, chatId: "43" });
  const smtp = { host: "smtp.qq.com", port: "465", username: "me@qq.com", password: "app-pass", from: "me@qq.com", to: "a@b.c" };
  assert.deepEqual(resolveChannelConfig("smtp", { ...smtp, username: "", password: "" }, smtp), { ...smtp, username: "" });
  // 新增时没有已保存的值
  assert.deepEqual(resolveChannelConfig("serverchan", { sendKey: " SCT1 ", other: "x" }, {}), { sendKey: " SCT1 " });
});

test("resolveChannelConfig：换了地址的站点，留空的已保存密钥不沿用；重新填了就放行；只改路径不算换站点", () => {
  const changed = (fn) => assert.throws(fn, (err) => err.code === "ENDPOINT_CHANGED_SECRET_REQUIRED");
  changed(() => resolveChannelConfig("telegram", { botToken: "", apiBase: "https://evil.example" }, SAVED_TELEGRAM));
  assert.equal(resolveChannelConfig("telegram", { botToken: "999:new", apiBase: "https://evil.example" }, SAVED_TELEGRAM).botToken, "999:new");
  // 自建地址清空 = 回到官方地址，也算换站点
  changed(() => resolveChannelConfig("bark", { deviceKey: "", server: "" }, { deviceKey: "dk-123456", server: "https://bark.mine.example" }));
  // SMTP 换主机
  const smtp = { host: "smtp.qq.com", username: "me", password: "app-pass", from: "a", to: "b" };
  changed(() => resolveChannelConfig("smtp", { ...smtp, host: "smtp.evil.example", password: "" }, smtp));
  assert.equal(resolveChannelConfig("smtp", { ...smtp, host: "SMTP.QQ.COM", password: "" }, smtp).password, "app-pass");
  // 地址本身就是密钥（钉钉 Webhook）：换了站点，留空的加签密钥不沿用；同站点只换令牌就沿用
  const ding = { webhook: "https://oapi.dingtalk.com/robot/send?access_token=a", secret: "SEC-123456" };
  changed(() => resolveChannelConfig("dingtalk", { webhook: "https://hook.evil.example/x", secret: "" }, ding));
  assert.equal(resolveChannelConfig("dingtalk", { webhook: "https://oapi.dingtalk.com/robot/send?access_token=b", secret: "" }, ding).secret, "SEC-123456");
  // 换了站点时，请求里干脆不带密钥字段、或者给 null，也算没重填（不能靠「没带就不动」绕过去）
  changed(() => resolveChannelConfig("telegram", { apiBase: "https://evil.example" }, SAVED_TELEGRAM));
  changed(() => resolveChannelConfig("telegram", { apiBase: "https://evil.example", botToken: null }, SAVED_TELEGRAM));
  changed(() => resolveChannelConfig("webhook", { url: "https://evil.example/y" }, { url: "https://hooks.mine.example/x", headersJson: "{\"Authorization\":\"Bearer s\"}" }));
  // SMTP 端口也算地址的一部分；不填按 465
  changed(() => resolveChannelConfig("smtp", { port: "587" }, smtp));
  assert.equal(resolveChannelConfig("smtp", { port: "465", password: "" }, smtp).password, "app-pass");
  // 原来就没存密钥的，换地址不用补
  assert.equal(resolveChannelConfig("ntfy", { topic: "t", server: "https://ntfy.mine.example", token: "" }, { topic: "t", server: "", token: "" }).server, "https://ntfy.mine.example");
});

test("sendToChannel：发送报错里出现的密钥按这个通知方式自己的值打码，码只带认得的", async (t) => {
  const secretUrl = "not-a-url/hook-secret-token-123456";
  const r = await sendToChannel({ type: "webhook", config: { url: secretUrl, headersJson: "" } }, "标题", "正文");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /hook-secret-token-123456/);
  assert.match(r.error, /\*\*\*/);
  // 请求头 JSON 拆开后，值单独出现在报错里也要打码（这里值里带换行，fetch 会把它原样写进报错）
  const headers = await sendToChannel({ type: "webhook", config: { url: "https://hooks.mine.example/x", headersJson: JSON.stringify({ Authorization: "Bearer sk-SECRET\n123456" }) } }, "标题", "正文");
  assert.equal(headers.ok, false);
  assert.doesNotMatch(headers.error, /sk-SECRET/);
  assert.match(headers.error, /\*\*\*/);
  // 去空格后的值、小写 %xx 的 URL 编码也打码
  t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`refused ${url} key=${encodeURIComponent("a/b c+d").toLowerCase()}`); });
  const trimmed = await sendToChannel({ type: "serverchan", config: { sendKey: "  SCT-secret-key  " } }, "标题", "正文");
  assert.doesNotMatch(trimmed.error, /SCT-secret-key/);
  assert.match(trimmed.error, /\*\*\*/);
  const encoded = await sendToChannel({ type: "bark", config: { deviceKey: "a/b c+d", server: "" } }, "标题", "正文");
  assert.doesNotMatch(encoded.error, /a%2fb%20c%2bd/);
  assert.match(encoded.error, /\*\*\*/);
  // 码按通知方式的说法给（lib/error-copy.js deliveryErrorCode）：连不上归成 NETWORK_UNREACHABLE，不原样带 ECONNREFUSED 或数字；
  // 认不出的给「没发出去」，一定带码
  t.mock.method(globalThis, "fetch", async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }); });
  assert.equal((await sendToChannel({ type: "serverchan", config: { sendKey: "SCT-1234" } }, "标题", "正文")).code, "NETWORK_UNREACHABLE");
  t.mock.method(globalThis, "fetch", async () => { throw Object.assign(new Error("weird"), { code: 20 }); });
  assert.equal((await sendToChannel({ type: "serverchan", config: { sendKey: "SCT-1234" } }, "标题", "正文")).code, "NOTIFY_SEND_FAILED");
  // fetch 只说「fetch failed」时，原文后面补上底层原因（同样打码）；中途被重置算连不上，不原样带 ECONNRESET
  t.mock.method(globalThis, "fetch", async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("request to https://api.telegram.org/bot123:abc-token/sendMessage failed"), { code: "UND_ERR_SOCKET" }) });
  });
  const socket = await sendToChannel({ type: "telegram", config: { botToken: "123:abc-token", chatId: "42" } }, "标题", "正文");
  assert.equal(socket.code, "NETWORK_UNREACHABLE");
  assert.match(socket.error, /^fetch failed（UND_ERR_SOCKET：request to .*\*\*\*.* failed）$/);
  assert.doesNotMatch(socket.error, /abc-token/);
  t.mock.method(globalThis, "fetch", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }); });
  assert.equal((await sendToChannel({ type: "serverchan", config: { sendKey: "SCT-1234" } }, "标题", "正文")).code, "NETWORK_UNREACHABLE");
  // 地址写错（fetch 解析不了）算连不上
  t.mock.restoreAll();
  const badUrl = await sendToChannel({ type: "webhook", config: { url: "not-a-url" } }, "标题", "正文");
  assert.equal(badUrl.code, "NETWORK_UNREACHABLE");
});

// 假的对方：回这个状态和 JSON，记下发出去的请求
function reply(t, status, json) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(json == null ? "" : JSON.stringify(json), { status });
  });
  return calls;
}

const CHANNELS = {
  telegram: { botToken: "123:abc", chatId: "42" },
  dingtalk: { webhook: "https://oapi.dingtalk.com/robot/send?access_token=x" },
  wecom: { webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x" },
  feishu: { webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x" },
  bark: { deviceKey: "dk-123456" },
  ntfy: { topic: "alerts" },
  serverchan: { sendKey: "SCT-1234" },
  resend: { apiKey: "re_123456", from: "a@example.com", to: "b@example.com" },
  webhook: { url: "https://hooks.example.com/x" },
};

test("sendToChannel：对方回了话但没收下时，按平台自己的状态码和错误码给码（lib/notify.js 顶部的对照表）", async (t) => {
  const cases = [
    ["telegram", 401, { ok: false, error_code: 401, description: "Unauthorized" }, "NOTIFY_AUTH_FAILED"],
    ["telegram", 404, { ok: false, error_code: 404, description: "Not Found" }, "NOTIFY_AUTH_FAILED"],
    ["telegram", 403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "NOTIFY_REJECTED"],
    ["telegram", 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "NOTIFY_REJECTED"],
    ["telegram", 429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" }, "NOTIFY_BUSY"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "keywords not in content" }, "NOTIFY_KEYWORD_MISSING"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "sign not match" }, "NOTIFY_AUTH_FAILED"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "ip X.X.X.X not in whitelist" }, "NOTIFY_REJECTED"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "invalid timestamp" }, "NOTIFY_SEND_FAILED"],
    // 现网多是中文说明；解决方案那段顺带提到「时间戳」「签名」，只看描述
    ["dingtalk", 200, { errcode: 310000, errmsg: "错误描述:关键词不匹配;解决方案:请联系群管理员查看此机器人的关键词，并在发送的信息中包含此关键词;" }, "NOTIFY_KEYWORD_MISSING"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "错误描述:机器人发送签名不匹配;解决方案:请确认签名和生成签名的时间戳必须都要在发送的URL中;" }, "NOTIFY_AUTH_FAILED"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "错误描述:ip地址不在白名单;解决方案:请确认发送消息的服务器ip是否在白名单中;" }, "NOTIFY_REJECTED"],
    ["dingtalk", 200, { errcode: 310000, errmsg: "错误描述:时间戳不合法，和服务器时间相差超过 1 小时;解决方案:请校准服务器时间后重新签名;" }, "NOTIFY_SEND_FAILED"],
    ["dingtalk", 200, { errcode: 300001, errmsg: "token is not exist" }, "NOTIFY_AUTH_FAILED"],
    ["dingtalk", 200, { errcode: 400101, errmsg: "access_token不存在" }, "NOTIFY_AUTH_FAILED"],
    ["dingtalk", 200, { errcode: 400106, errmsg: "robot 不存在" }, "NOTIFY_AUTH_FAILED"],
    ["dingtalk", 200, { errcode: 400102, errmsg: "机器人已停用" }, "NOTIFY_REJECTED"],
    ["dingtalk", 200, { errcode: 410100, errmsg: "发送速度太快而限流" }, "NOTIFY_BUSY"],
    ["dingtalk", 200, { errcode: 130101, errmsg: "send too fast" }, "NOTIFY_BUSY"],
    ["dingtalk", 404, null, "NOTIFY_AUTH_FAILED"],
    ["feishu", 200, { code: 19001, msg: "param invalid: incoming webhook access token invalid" }, "NOTIFY_AUTH_FAILED"],
    ["feishu", 200, { code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" }, "NOTIFY_AUTH_FAILED"],
    ["feishu", 200, { code: 19024, msg: "Key Words Not Found" }, "NOTIFY_KEYWORD_MISSING"],
    ["feishu", 200, { code: 19022, msg: "Ip Not Allowed" }, "NOTIFY_REJECTED"],
    ["feishu", 200, { code: 11232, msg: "frequency limited" }, "NOTIFY_BUSY"],
    ["wecom", 200, { errcode: 93000, errmsg: "invalid webhook url" }, "NOTIFY_AUTH_FAILED"],
    ["wecom", 200, { errcode: 45009, errmsg: "api freq out of limit" }, "NOTIFY_BUSY"],
    ["wecom", 200, { errcode: 40058, errmsg: "content exceed max length" }, "NOTIFY_REJECTED"],
    ["bark", 400, { code: 400, message: "failed to get device token: not found" }, "NOTIFY_AUTH_FAILED"],
    ["bark", 500, { code: 500, message: "push failed" }, "NOTIFY_BUSY"],
    ["ntfy", 403, { error: "forbidden" }, "NOTIFY_AUTH_FAILED"],
    ["ntfy", 413, { error: "message too large" }, "NOTIFY_REJECTED"],
    ["ntfy", 429, { error: "limit reached" }, "NOTIFY_BUSY"],
    // Server酱没有公开的错误码表：回了 200 但 code 不是 0 一律算没收下；HTTP 不是 2xx 时按 HTTP 状态
    ["serverchan", 200, { code: 40001, message: "bad pushtoken" }, "NOTIFY_REJECTED"],
    ["serverchan", 200, { code: 20001, message: "rejected" }, "NOTIFY_REJECTED"],
    ["serverchan", 404, null, "NOTIFY_AUTH_FAILED"],
    ["serverchan", 502, null, "NOTIFY_BUSY"],
    ["resend", 403, { name: "invalid_api_key", message: "API key is invalid" }, "NOTIFY_AUTH_FAILED"],
    ["resend", 401, { name: "missing_api_key", message: "Missing API key" }, "NOTIFY_AUTH_FAILED"],
    ["resend", 403, { name: "validation_error", message: "The example.com domain is not verified" }, "NOTIFY_REJECTED"],
    ["resend", 429, { name: "rate_limit_exceeded", message: "Too many requests" }, "NOTIFY_BUSY"],
    ["webhook", 401, null, "NOTIFY_AUTH_FAILED"],
    ["webhook", 404, null, "NOTIFY_AUTH_FAILED"],
    ["webhook", 400, null, "NOTIFY_REJECTED"],
    ["webhook", 502, null, "NOTIFY_BUSY"],
  ];
  for (const [type, status, json, code] of cases) {
    reply(t, status, json);
    const r = await sendToChannel({ type, config: CHANNELS[type] }, "标题", "正文");
    assert.equal(r.ok, false, `${type} ${status}`);
    assert.equal(r.code, code, `${type} ${status} ${JSON.stringify(json)}`);
  }
});

test("sendToChannel：类型认不出、必填的没填，都不发请求，直接给码", async (t) => {
  const calls = reply(t, 200, { ok: true });
  // 原型链上的名字（constructor、toString）也不算类型，不能当成发出去了
  for (const type of ["__test__", "constructor", "toString", "hasOwnProperty", "__proto__", undefined]) {
    const r = await sendToChannel({ type, config: {} }, "标题", "正文");
    assert.deepEqual([r.ok, r.code], [false, "NOTIFY_TYPE_UNSUPPORTED"], String(type));
  }
  const missing = await sendToChannel({ type: "telegram", config: { botToken: "  ", chatId: "42" } }, "标题", "正文");
  assert.equal(missing.code, "NOTIFY_CONFIG_MISSING");
  assert.match(missing.error, /botToken/);
  assert.equal((await sendToChannel({ type: "resend", config: { apiKey: "re_1", from: "a@example.com", to: " , " } }, "标题", "正文")).code, "NOTIFY_CONFIG_MISSING");
  assert.equal(calls.length, 0);
});

test("sendToChannel：太长时按这种通知方式的上限截掉，末尾写 TRUNCATED_NOTE；企业微信按字节、连标题一起算", async (t) => {
  const long = "余额".repeat(3000);
  // 标题本来就带签名，发送前不再改（A3-2 删掉改字后任何标题都原样发）
  const TITLE = "【炬元日报】My Site 10月15日";
  // 企业微信：content = 标题 + 换行 + 正文，最长 2048 字节
  let calls = reply(t, 200, { errcode: 0 });
  assert.equal((await sendToChannel({ type: "wecom", config: CHANNELS.wecom }, "【炬元日报】My Site 10月15日", long)).ok, true);
  const content = calls[0].body.text.content;
  assert.ok(Buffer.byteLength(content, "utf8") <= 2048, `${Buffer.byteLength(content, "utf8")} 字节`);
  assert.ok(content.endsWith(TRUNCATED_NOTE));
  assert.ok(Buffer.byteLength(content, "utf8") > 2000, "没有截得太狠");
  // 放得下的不截
  calls = reply(t, 200, { errcode: 0 });
  await sendToChannel({ type: "wecom", config: CHANNELS.wecom }, TITLE, "短正文");
  assert.equal(calls[0].body.text.content, `${TITLE}\n短正文`);
  // 其余聊天软件按 1500 字
  calls = reply(t, 200, { ok: true });
  await sendToChannel({ type: "telegram", config: CHANNELS.telegram }, TITLE, long);
  const text = calls[0].body.text;
  assert.ok(text.endsWith(TRUNCATED_NOTE));
  assert.equal([...text].length, [...`${TITLE}\n`].length + 1500 + [...TRUNCATED_NOTE].length);
  // 邮件放得下整份日报
  calls = reply(t, 200, { id: "m1" });
  await sendToChannel({ type: "resend", config: CHANNELS.resend }, TITLE, long);
  assert.equal(calls[0].body.text, long);
  // Bark 走苹果推送：标题加正文按字节算
  calls = reply(t, 200, { code: 200 });
  await sendToChannel({ type: "bark", config: CHANNELS.bark }, TITLE, long);
  // 预算 3000 字节里给标题和正文之间留了 1 字节：两段合起来最多 2999，也没有截得太狠
  const barkBytes = Buffer.byteLength(calls[0].body.title + calls[0].body.body, "utf8");
  assert.ok(barkBytes <= 2999 && barkBytes > 2950, `${barkBytes} 字节`);
  assert.ok(calls[0].body.body.endsWith(TRUNCATED_NOTE));
  // 不切开一个字（emoji 是两个 UTF-16 单元）
  calls = reply(t, 200, { ok: true });
  await sendToChannel({ type: "telegram", config: CHANNELS.telegram }, TITLE, "😀".repeat(1600));
  assert.doesNotMatch(calls[0].body.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
