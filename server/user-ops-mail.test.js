// 给重点用户发邮件的运行时（server/user-ops-mail.js）：收件人只能是一个干净的地址，真的 SMTP 代码对着假服务器测——
// 用户在 New API 里可以随便填邮箱，不能让任何用户借站长的发信渠道给第三方发信。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { sendUserMail } from "./user-ops-mail.js";

// 本机起一个不支持 STARTTLS 的假邮件服务器，记下收到的每一条指令（和 lib/smtp.test.js 同一个写法）
async function fakeSmtp(t) {
  const lines = [];
  let connections = 0;
  const server = createServer((sock) => {
    connections += 1;
    let buf = "", inData = false;
    sock.on("error", () => {});
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { lines.push(line); if (line === ".") { inData = false; sock.write("250 queued\r\n"); } continue; }
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
  return { port: server.address().port, lines, connections: () => connections };
}

const mail = { subject: "我的站点 账户余额快用完了，还能用约 2 天", text: "您好，alice：", html: "<p>您好</p>" };
const channel = (port) => ({ id: "m1", type: "smtp", enabled: true, config: { host: "127.0.0.1", port: String(port), from: "我的站点 <noreply@own.test>", to: "owner@own.test" } });

test("发给一位用户：收件人换成这位用户的邮箱，别的用站长配好的；只有一个 RCPT TO，站长自己的地址不在里面", async (t) => {
  const smtp = await fakeSmtp(t);
  const result = await sendUserMail(channel(smtp.port), "alice@mail.test", mail);
  assert.deepEqual(result, { ok: true, code: undefined });
  assert.deepEqual(smtp.lines.filter((line) => line.startsWith("RCPT TO")), ["RCPT TO:<alice@mail.test>"]);
  assert.ok(smtp.lines.some((line) => line.startsWith("MAIL FROM:<noreply@own.test>")), "发信人是站长配的");
  assert.equal(smtp.lines.some((line) => line.includes("owner@own.test") && line.startsWith("RCPT")), false);
});

test("用户填的邮箱带逗号、全角逗号、分号、换行、尖括号：一封都不发，一个连接都不开", async (t) => {
  const smtp = await fakeSmtp(t);
  const attacks = [
    "alice@mail.test,victim@x.test", "alice@mail.test，victim@x.test", "alice@mail.test;victim@x.test",
    "a@b.test>\r\nRCPT TO:<victim@x.test", "a@b.test\r\nBcc: victim@x.test", "Alice <alice@mail.test>",
  ];
  for (const to of attacks) {
    const result = await sendUserMail(channel(smtp.port), to, mail);
    assert.equal(result.ok, false, JSON.stringify(to));
  }
  assert.equal(smtp.connections(), 0);
  assert.deepEqual(smtp.lines, []);
});

test("发不出去只回错误码，不带服务器的原话（原话里常有收件人）", async (t) => {
  const result = await sendUserMail({ ...channel(1), config: { ...channel(1).config, host: "127.0.0.1", port: "1" } }, "alice@mail.test", mail);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
  assert.ok(!JSON.stringify(result).includes("alice@"));
});
