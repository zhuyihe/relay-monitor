// 通知方式的密钥：接口不回传、编辑时留空沿用、换了地址的站点就不沿用、发送报错打码
import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_TYPES, publicChannel, resolveChannelConfig, sendToChannel } from "./notify.js";

const SAVED_TELEGRAM = { botToken: "123:abc-token", chatId: "42", apiBase: "" };

test("CHANNEL_TYPES：原来前端那份密钥名单里的字段都标成密钥，地址字段都标了 endpoint", () => {
  const secretKeys = ["botToken", "secret", "token", "sendKey", "apiKey", "password", "deviceKey", "webhook", "url", "headersJson"];
  for (const type of CHANNEL_TYPES) {
    for (const field of type.fields) {
      if (secretKeys.includes(field.key)) assert.equal(field.secret, true, `${type.value}.${field.key}`);
    }
  }
  const endpoints = CHANNEL_TYPES.flatMap((type) => type.fields.filter((f) => f.endpoint).map((f) => `${type.value}.${f.key}`));
  assert.deepEqual(endpoints, ["telegram.apiBase", "dingtalk.webhook", "wecom.webhook", "feishu.webhook", "bark.server", "ntfy.server", "smtp.host", "webhook.url"]);
});

test("publicChannel：密钥换成空串，另给 hasSecret；不改原对象", () => {
  const channel = { id: "c1", type: "telegram", name: "运维群", config: { ...SAVED_TELEGRAM } };
  const view = publicChannel(channel);
  assert.deepEqual(view.config, { botToken: "", chatId: "42", apiBase: "" });
  assert.deepEqual(view.hasSecret, { botToken: true });
  assert.equal(channel.config.botToken, "123:abc-token");
  assert.deepEqual(publicChannel({ id: "c2", type: "dingtalk", config: { webhook: "https://oapi.dingtalk.com/robot/send?access_token=x" } }).hasSecret,
    { webhook: true, secret: false });
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
  // 原来就没存密钥的，换地址不用补
  assert.equal(resolveChannelConfig("ntfy", { topic: "t", server: "https://ntfy.mine.example", token: "" }, { topic: "t", server: "", token: "" }).server, "https://ntfy.mine.example");
});

test("sendToChannel：发送报错里出现的密钥按这个通知方式自己的值打码", async () => {
  const secretUrl = "not-a-url/hook-secret-token-123456";
  const r = await sendToChannel({ type: "webhook", config: { url: secretUrl, headersJson: "" } }, "标题", "正文");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /hook-secret-token-123456/);
  assert.match(r.error, /\*\*\*/);
});
