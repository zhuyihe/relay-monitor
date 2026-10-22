import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { sendSmtpMail, smtpReplyCode } from "./smtp.js";
import { errorText } from "./error-copy.js";
import { sendToChannel } from "./notify.js";

// 本机起一个不支持 STARTTLS 的假邮件服务器，记下收到的每一条指令；
// greeting 换掉开头那句，reject(line) 返回一句回复时用它代替「250 ok」
async function plainSmtpServer(t, { greeting = "220 fake ESMTP", reject = () => null } = {}) {
  const lines = [];
  const server = createServer((sock) => {
    let buf = "", inData = false;
    // 客户端发完或放弃后直接断开，这一端会收到 ECONNRESET，不算出错
    sock.on("error", () => {});
    sock.write(`${greeting}\r\n`);
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === ".") { inData = false; sock.write("250 queued\r\n"); } continue; }
        lines.push(line);
        const refused = reject(line);
        if (refused) sock.write(`${refused}\r\n`);
        else if (line.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: server.address().port, lines };
}

const mail = (port, extra = {}) => ({ host: "127.0.0.1", port, from: "a@example.com", to: "b@example.com", ...extra });

test("SMTP：不是 465、服务器又不支持 STARTTLS 时，不发邮箱密码", async (t) => {
  const { port, lines } = await plainSmtpServer(t);
  await assert.rejects(sendSmtpMail(mail(port, { username: "me@example.com", password: "secret-pass" }), "主题", "正文"),
    (err) => err.code === "SMTP_TLS_REQUIRED" && err.message === errorText({ code: "SMTP_TLS_REQUIRED" }));
  assert.equal(lines.some((line) => line.startsWith("AUTH") || line.includes("secret-pass")), false);
  assert.equal(lines.some((line) => line.startsWith("MAIL FROM")), false);
});

test("SMTP：不带密码时照常发（没有要保护的登录信息）", async (t) => {
  const { port, lines } = await plainSmtpServer(t);
  await sendSmtpMail(mail(port), "主题", "正文");
  assert.ok(lines.some((line) => line.startsWith("MAIL FROM")));
  assert.equal(lines.some((line) => line.startsWith("AUTH")), false);
});

const smtpChannel = (port, extra = {}) => ({ type: "smtp", config: mail(port, extra) });

test("SMTP 发不出去时给码（design/ui-copy-spec.md §8.2 通知方式那张表）：被拒、繁忙、连不上、没填全", async (t) => {
  const send = async (options, extra) => {
    const { port } = await plainSmtpServer(t, options);
    return sendToChannel(smtpChannel(port, extra), "主题", "正文");
  };
  // 收件人被拒 → 没收下；暂时失败 → 繁忙
  assert.equal((await send({ reject: (line) => (line.startsWith("RCPT") ? "550 no such user" : null) })).code, "NOTIFY_REJECTED");
  assert.equal((await send({ reject: (line) => (line.startsWith("MAIL") ? "451 try later" : null) })).code, "NOTIFY_BUSY");
  // 一上来就不欢迎：421 暂时忙，其余当作连不上
  assert.equal((await send({ greeting: "421 too busy" })).code, "NOTIFY_BUSY");
  assert.equal((await send({ greeting: "554 go away" })).code, "NETWORK_UNREACHABLE");
  // 不发明文密码的安全提示原样带码，不退成「没发出去」
  const tls = await send({}, { username: "me@example.com", password: "secret-pass" });
  assert.equal(tls.code, "SMTP_TLS_REQUIRED");
  assert.equal(errorText(tls), errorText({ code: "SMTP_TLS_REQUIRED" }));
  // 端口上没人：net 的 ECONNREFUSED 归成连不上
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.equal((await sendToChannel(smtpChannel(port), "主题", "正文")).code, "NETWORK_UNREACHABLE");
  // 直接调发送函数时漏填（sendToChannel 会先按必填项拦下）
  await assert.rejects(sendSmtpMail({ host: "127.0.0.1", from: "", to: "b@example.com" }, "主题", "正文"), (err) => err.code === "NOTIFY_CONFIG_MISSING");
});

test("smtpReplyCode：登录那一步被拒是邮箱用户名或密码不对，504 是不支持这种登录方式；4xx 都算繁忙", () => {
  assert.equal(smtpReplyCode("AUTH", 535), "SMTP_AUTH_FAILED");
  assert.equal(smtpReplyCode("AUTH", 534), "SMTP_AUTH_FAILED");
  assert.equal(smtpReplyCode("AUTH", 504), "NOTIFY_SEND_FAILED");
  assert.equal(smtpReplyCode("AUTH", 454), "NOTIFY_BUSY");
  assert.equal(smtpReplyCode("STARTTLS", 502), "NOTIFY_SEND_FAILED");
  assert.equal(smtpReplyCode("RCPT", 550), "NOTIFY_REJECTED");
  assert.equal(smtpReplyCode("发送", 554), "NOTIFY_REJECTED");
  assert.equal(smtpReplyCode("EHLO", 500), "NOTIFY_REJECTED");
});

// 只完成明文 SMTP 的 STARTTLS 协商，收到 ClientHello 后保持安静或关闭连接。
// 没有用户名、密码或 token；测试真实的 net/tls 客户端超时和错误恢复。
async function stalledStarttlsServer(t, { closeOnClientHello = false } = {}) {
  const sockets = new Set(), lines = [];
  let clientClosed;
  const closed = new Promise((resolve) => { clientClosed = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); clientClosed(); });
    socket.write("220 fake ESMTP\r\n");
    let buf = "", starttls = false;
    socket.on("data", (data) => {
      if (starttls) {
        if (closeOnClientHello) socket.end();
        return;
      }
      buf += data.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        lines.push(line);
        if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 STARTTLS\r\n");
        else if (line === "STARTTLS") { starttls = true; socket.write("220 Begin TLS\r\n"); }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, lines, closed, sockets };
}

test("SMTP：STARTTLS不回应会在握手截止时间失败并关闭连接", { timeout: 3000 }, async (t) => {
  const { port, lines, closed, sockets } = await stalledStarttlsServer(t);
  await assert.rejects(sendSmtpMail(mail(port), "主题", "正文", undefined, { timeoutMs: 150 }),
    (error) => error.code === "NETWORK_UNREACHABLE" && error.message === "SMTP TLS 握手超时");
  await closed;
  assert.equal(sockets.size, 0);
  assert.ok(lines.includes("STARTTLS"));
  assert.equal(lines.some((line) => line.startsWith("AUTH") || line.startsWith("MAIL FROM")), false);
});

test("SMTP：STARTTLS对端关闭后通知返回失败，不等待握手超时", { timeout: 3000 }, async (t) => {
  const { port, lines, closed } = await stalledStarttlsServer(t, { closeOnClientHello: true });
  let finished = false;
  const result = await sendToChannel(smtpChannel(port), "主题", "正文").finally(() => { finished = true; });
  await closed;
  assert.equal(finished, true, "上层调度的finally能够执行");
  assert.equal(result.ok, false);
  assert.ok(["NETWORK_UNREACHABLE", "ECONNRESET"].includes(result.code));
  assert.ok(lines.includes("STARTTLS"));
  assert.equal(lines.some((line) => line.startsWith("MAIL FROM")), false);
});
