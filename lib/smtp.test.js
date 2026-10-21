import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { sendSmtpMail } from "./smtp.js";
import { errorText } from "./error-copy.js";

// 本机起一个不支持 STARTTLS 的假邮件服务器，记下收到的每一条指令
async function plainSmtpServer(t) {
  const lines = [];
  const server = createServer((sock) => {
    let buf = "", inData = false;
    // 客户端发完或放弃后直接断开，这一端会收到 ECONNRESET，不算出错
    sock.on("error", () => {});
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === ".") { inData = false; sock.write("250 queued\r\n"); } continue; }
        lines.push(line);
        if (line.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
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
