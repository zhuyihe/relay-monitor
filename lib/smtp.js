// 极简 SMTP 客户端：发提醒和日报邮件（纯文本，日报另带 HTML），延续项目零第三方依赖的原则
// 465 端口走隐式 TLS；其他端口先明文连接，服务器支持 STARTTLS 就升级，不支持时不发邮箱密码（SMTP_TLS_REQUIRED）；
// 认证支持 AUTH PLAIN / AUTH LOGIN。正文用 base64 编码传输，天然规避
// dot-stuffing 与行长限制。
// 发不出去时在出错的地方给码（design/ui-copy-spec.md §8.2 通知方式那张表）：连不上、超时、连接被关 → NETWORK_UNREACHABLE；
// 服务器回了错误码见 smtpReplyCode；net / tls 自己的报错（ECONNREFUSED、证书不对）原样抛，由 deliveryErrorCode 归成连不上
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { deliveryError, errorText } from "./error-copy.js";

const CRLF = "\r\n";
const TIMEOUT_MS = 15000;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// "Name <a@b.c>" → a@b.c
function addrOf(s) {
  const m = String(s || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(s || "")).trim();
}

// 非 ASCII 头部按 RFC 2047 编码
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

// 地址的显示名部分单独编码，角括号地址保持原样
function encodeAddress(s) {
  const m = String(s || "").match(/^(.*)<([^>]+)>\s*$/);
  if (!m) return String(s || "").trim();
  const name = m[1].trim().replace(/^"|"$/g, "");
  return name ? `${encodeHeader(name)} <${m[2].trim()}>` : `<${m[2].trim()}>`;
}

const b64wrap = (s) => b64(s).replace(/(.{76})/g, `$1${CRLF}`);

function buildMessage(from, toList, subject, text, html) {
  const common = [
    `From: ${encodeAddress(from)}`,
    `To: ${toList.map(encodeAddress).join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@relay-monitor>`,
    "MIME-Version: 1.0",
  ];
  if (!html) {
    return [
      ...common,
      'Content-Type: text/plain; charset=utf-8',
      "Content-Transfer-Encoding: base64",
      "",
      b64wrap(text),
    ].join(CRLF);
  }
  // multipart/alternative：纯文本 + HTML，客户端优先渲染 HTML
  const boundary = "rmb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return [
    ...common,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(html),
    `--${boundary}--`,
  ].join(CRLF);
}

// 服务器回了错误码：4xx 是临时失败 → 繁忙；AUTH 那一步 535 这类 → 邮箱用户名或密码不对，504 是不支持这种登录方式 → 认不出；
// STARTTLS 不认 → 认不出；其余（MAIL、RCPT、发送正文被拒，EHLO 不认）→ 没收下
export function smtpReplyCode(stage, reply) {
  if (reply >= 400 && reply < 500) return "NOTIFY_BUSY";
  if (stage === "AUTH") return reply === 504 ? "NOTIFY_SEND_FAILED" : "SMTP_AUTH_FAILED";
  if (stage === "STARTTLS") return "NOTIFY_SEND_FAILED";
  return "NOTIFY_REJECTED";
}

export function splitRecipients(s) {
  return String(s || "").split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 发送邮件；提供 html 时按 multipart/alternative 同时携带纯文本与 HTML。
 * cfg: { host, port?, username?, password?, from, to }
 * 第五个参数仅供内部测试缩短超时，不读取用户配置中的 timeoutMs。
 */
export async function sendSmtpMail(cfg, subject, text, html, { timeoutMs = TIMEOUT_MS } = {}) {
  const host = String(cfg.host || "").trim();
  if (!host) throw deliveryError("NOTIFY_CONFIG_MISSING", "缺少 SMTP 服务器地址");
  const port = Number(cfg.port) || 465;
  const from = String(cfg.from || "").trim();
  const toList = splitRecipients(cfg.to);
  if (!from) throw deliveryError("NOTIFY_CONFIG_MISSING", "缺少发件人");
  if (!toList.length) throw deliveryError("NOTIFY_CONFIG_MISSING", "缺少收件人");

  let sock = await new Promise((resolve, reject) => {
    const s = port === 465
      ? tlsConnect({ host, port, servername: host }, () => resolve(s))
      : netConnect({ host, port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(deliveryError("NETWORK_UNREACHABLE", "SMTP 连接超时")); });
  });

  let buf = "";
  let sockErr = null;
  const attach = (s) => {
    s.setEncoding("utf8");
    s.setTimeout(0);
    s.on("data", (d) => { buf += d; });
    s.on("error", (e) => { sockErr = e; });
  };
  attach(sock);

  // 取出一条完整响应（多行响应 250-a / 250-b / 250 c 到最终行为止）
  const extract = () => {
    const m = /^(\d{3})(?: [^\n]*)?\r?\n/m.exec(buf);
    if (!m) return null;
    const end = m.index + m[0].length;
    const text = buf.slice(0, end).trim();
    buf = buf.slice(end);
    return { code: Number(m[1]), text };
  };

  const readResp = () => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (sockErr) return reject(sockErr);
      const r = extract();
      if (r) return resolve(r);
      if (sock.destroyed) return reject(deliveryError("NETWORK_UNREACHABLE", "SMTP 连接被关闭"));
      if (Date.now() - started > timeoutMs) { sock.destroy(); return reject(deliveryError("NETWORK_UNREACHABLE", "SMTP 响应超时")); }
      setTimeout(poll, 25);
    };
    poll();
  });

  const cmd = async (line, okCodes, label) => {
    sock.write(line + CRLF);
    const r = await readResp();
    if (!okCodes.includes(r.code)) {
      const stage = label || line.split(" ")[0];
      throw deliveryError(smtpReplyCode(stage, r.code), `${stage} 失败：${r.text.slice(0, 200)}`);
    }
    return r;
  };

  try {
    const greet = await readResp();
    // 一上来就不欢迎：421 这类是暂时忙；554 这类多半是不收我们这个地址发的信，算没收下
    if (greet.code !== 220) throw deliveryError(greet.code >= 400 && greet.code < 500 ? "NOTIFY_BUSY" : "NOTIFY_REJECTED", `服务器拒绝连接：${greet.text.slice(0, 200)}`);

    let caps = (await cmd("EHLO relay-monitor", [250])).text.toUpperCase();
    // 465 一上来就是加密连接；别的端口要服务器支持 STARTTLS 才升级成加密连接
    let encrypted = port === 465;

    if (port !== 465 && caps.includes("STARTTLS")) {
      await cmd("STARTTLS", [220]);
      const plain = sock;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      buf = "";
      sock = await new Promise((resolve, reject) => {
        const t = tlsConnect({ socket: plain, servername: host });
        const cleanup = () => {
          clearTimeout(timer);
          t.removeListener("secureConnect", connected);
          t.removeListener("error", failed);
          t.removeListener("close", closed);
        };
        const failed = (error) => { cleanup(); t.destroy(); reject(error); };
        const connected = () => { cleanup(); resolve(t); };
        const closed = () => failed(deliveryError("NETWORK_UNREACHABLE", "SMTP TLS 连接被关闭"));
        // attach() 已清掉明文 socket 的空闲超时；TLS 握手需要自己的截止时间。
        const timer = setTimeout(() => failed(deliveryError("NETWORK_UNREACHABLE", "SMTP TLS 握手超时")), timeoutMs);
        t.once("secureConnect", connected);
        t.once("error", failed);
        t.once("close", closed);
      });
      attach(sock);
      caps = (await cmd("EHLO relay-monitor", [250])).text.toUpperCase();
      encrypted = true;
    }

    const user = String(cfg.username || "").trim();
    const pass = String(cfg.password || "");
    // 没有加密连接时不发邮箱密码：明文的 AUTH 会被路上的人截到（design/ui-copy-spec.md §8.2）
    if (user && pass && !encrypted) {
      throw deliveryError("SMTP_TLS_REQUIRED", errorText({ code: "SMTP_TLS_REQUIRED" }));
    }
    if (user && pass) {
      if (/AUTH[ =][^\n]*PLAIN/.test(caps)) {
        await cmd("AUTH PLAIN " + b64(`\u0000${user}\u0000${pass}`), [235], "AUTH");
      } else {
        await cmd("AUTH LOGIN", [334], "AUTH");
        await cmd(b64(user), [334], "AUTH");
        await cmd(b64(pass), [235], "AUTH");
      }
    }

    await cmd(`MAIL FROM:<${addrOf(from)}>`, [250]);
    for (const t of toList) await cmd(`RCPT TO:<${addrOf(t)}>`, [250, 251], "RCPT");
    await cmd("DATA", [354]);
    await cmd(buildMessage(from, toList, subject, text, html) + CRLF + ".", [250], "发送");
    sock.write("QUIT" + CRLF);
  } finally {
    sock.destroy();
  }
}
