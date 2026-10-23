// 通知方式发送器：全部用原生 fetch 实现，不引第三方 SDK
import { createHmac } from "node:crypto";
import { BRAND } from "./brand.js";
import { endpointChangedError, sameEndpoint, staleSecrets } from "./endpoint.js";
import { deliveryError, deliveryErrorCode, errorDetail } from "./error-copy.js";
import { sendSmtpMail, splitRecipients } from "./smtp.js";

// 不填时用的官方地址：发送和「换没换地址」的判断共用
const TELEGRAM_API = "https://api.telegram.org";
const BARK_SERVER = "https://api.day.app";
const NTFY_SERVER = "https://ntfy.sh";

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

async function postJson(url, body, headers = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 发不出去时给哪个码 -------------------------------------------------------
// 对方回了话、但没收下：按平台自己的状态码和错误码给码（design/ui-copy-spec.md §8.2 通知方式那张表）。
// 认的是平台自己的机读字段（在出错的地方给码），不进 lib/error-copy.js 的全局关键词；原文照旧只进「查看详细原因」。
// 发都没发出去的（连不上、超时、地址写错）不在这里，由 deliveryErrorCode 归成连不上。
//
//   只有 HTTP 状态的（Webhook、ntfy）  401 / 403 / 404 → NOTIFY_AUTH_FAILED（令牌、请求头或地址不对）；429、5xx → NOTIFY_BUSY；其余 → NOTIFY_REJECTED
//   Telegram                           401（Token 失效）、404（Token 为空或格式不对）→ AUTH；403（机器人被拉黑、踢出群）→ REJECTED；其余同上
//   钉钉（HTTP 200 + errcode）         310000 按 errmsg 分（现网是「错误描述:…;解决方案:…」或「description:…;solution:…」，只看描述那段）：
//                                      关键词 / keywords → NOTIFY_KEYWORD_MISSING，时间戳 / timestamp / 过期 / expire（签名过期也是，多半是服务器时间不准）→ NOTIFY_SEND_FAILED，
//                                      签名 / sign → AUTH，白名单 / ip → REJECTED，其余 → SEND_FAILED；
//                                      410100、130101 发太快，-1 繁忙 → BUSY；400101 access_token 不存在、400106 机器人不存在、说明里提到 token → AUTH
//   飞书（code）                       19001 地址无效、19021 签名不对 → AUTH；19024 关键词 → KEYWORD；11232 限流 → BUSY；19022 IP 白名单等 → REJECTED
//   企业微信（errcode）                93000 地址无效 → AUTH；45009 限流、-1 繁忙 → BUSY
//   Bark                               400（Device Key 找不到）→ AUTH
//   Server酱                           没找到公开的错误码表：HTTP 不是 2xx 时按 HTTP 状态，回了 200 但 code 不是 0 → REJECTED
//   Resend（name）                     *_api_key、401 → AUTH；429、5xx → BUSY；其余（发件人域名没验证等）→ REJECTED
//   SMTP                               见 lib/smtp.js
// 平台的业务码认不出时都算 NOTIFY_REJECTED：对方明确回了「没收下」。
function httpCode(status) {
  if (status === 401 || status === 403 || status === 404) return "NOTIFY_AUTH_FAILED";
  if (status === 429 || status >= 500) return "NOTIFY_BUSY";
  return "NOTIFY_REJECTED";
}

function dingTalkCode(r) {
  const code = r.json?.errcode;
  if (code == null) return httpCode(r.status);
  // 解决方案那段可能顺带提到别的词（签名、时间戳），只看描述
  const msg = String(r.json?.errmsg || "");
  const desc = msg.match(/(?:错误描述|description)\s*[:：]\s*([^;；]*)/i)?.[1] ?? msg;
  if (code === 310000) {
    if (/keyword|关键词/i.test(desc)) return "NOTIFY_KEYWORD_MISSING";
    // 时间不对排在签名前面：「签名过期」是发送时刻和签名时刻差太多，密钥没问题
    if (/timestamp|时间戳|过期|expire/i.test(desc)) return "NOTIFY_SEND_FAILED";
    if (/sign|签名/i.test(desc)) return "NOTIFY_AUTH_FAILED";
    if (/whitelist|白名单|\bip\b/i.test(desc)) return "NOTIFY_REJECTED";
    return "NOTIFY_SEND_FAILED";
  }
  if (code === 410100 || code === 130101 || code === -1) return "NOTIFY_BUSY";
  if (code === 400101 || code === 400106 || /token/i.test(desc)) return "NOTIFY_AUTH_FAILED";
  return "NOTIFY_REJECTED";
}

function feishuCode(r) {
  const code = r.json?.code ?? r.json?.StatusCode;
  if (code == null) return httpCode(r.status);
  if (code === 19001 || code === 19021) return "NOTIFY_AUTH_FAILED";
  if (code === 19024) return "NOTIFY_KEYWORD_MISSING";
  if (code === 11232) return "NOTIFY_BUSY";
  return "NOTIFY_REJECTED";
}

function weComCode(r) {
  const code = r.json?.errcode;
  if (code == null) return httpCode(r.status);
  if (code === 93000) return "NOTIFY_AUTH_FAILED";
  if (code === 45009 || code === -1) return "NOTIFY_BUSY";
  return "NOTIFY_REJECTED";
}

function resendCode(r) {
  if (/_api_key$/.test(String(r.json?.name || "")) || r.status === 401) return "NOTIFY_AUTH_FAILED";
  return r.status === 429 || r.status >= 500 ? "NOTIFY_BUSY" : "NOTIFY_REJECTED";
}

// ---- 各通知方式的实现 ---------------------------------------------------------

async function sendTelegram(cfg, title, body) {
  const base = (cfg.apiBase || TELEGRAM_API).replace(/\/+$/, "");
  const r = await postJson(`${base}/bot${cfg.botToken}/sendMessage`, {
    chat_id: cfg.chatId,
    text: `${title}\n${body}`,
  });
  if (!r.json?.ok) throw deliveryError(r.status === 403 ? "NOTIFY_REJECTED" : httpCode(r.status), r.json?.description || `HTTP ${r.status}`);
}

async function sendDingTalk(cfg, title, body) {
  let url = cfg.webhook;
  if (cfg.secret) {
    const timestamp = Date.now();
    const sign = createHmac("sha256", cfg.secret)
      .update(`${timestamp}\n${cfg.secret}`)
      .digest("base64");
    url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }
  const r = await postJson(url, {
    msgtype: "text",
    text: { content: `${title}\n${body}` },
  });
  if (r.json?.errcode !== 0) throw deliveryError(dingTalkCode(r), r.json?.errmsg || `HTTP ${r.status}`);
}

async function sendWeCom(cfg, title, body) {
  const r = await postJson(cfg.webhook, {
    msgtype: "text",
    text: { content: `${title}\n${body}` },
  });
  if (r.json?.errcode !== 0) throw deliveryError(weComCode(r), r.json?.errmsg || `HTTP ${r.status}`);
}

async function sendFeishu(cfg, title, body) {
  const payload = { msg_type: "text", content: { text: `${title}\n${body}` } };
  if (cfg.secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    // 飞书签名：以 `${timestamp}\n${secret}` 为 key 对空串做 HMAC-SHA256
    const sign = createHmac("sha256", `${timestamp}\n${cfg.secret}`).update("").digest("base64");
    payload.timestamp = String(timestamp);
    payload.sign = sign;
  }
  const r = await postJson(cfg.webhook, payload);
  const code = r.json?.code ?? r.json?.StatusCode;
  if (code !== 0) throw deliveryError(feishuCode(r), r.json?.msg || `HTTP ${r.status}`);
}

async function sendBark(cfg, title, body) {
  const base = (cfg.server || BARK_SERVER).replace(/\/+$/, "");
  const r = await postJson(`${base}/push`, {
    device_key: cfg.deviceKey,
    title,
    body,
    group: BRAND.notificationSignature,
  });
  if (r.json?.code !== 200) {
    const status = Number(r.json?.code) || r.status;
    throw deliveryError(status === 400 ? "NOTIFY_AUTH_FAILED" : httpCode(status), r.json?.message || `HTTP ${r.status}`);
  }
}

async function sendNtfy(cfg, title, body) {
  const base = (cfg.server || NTFY_SERVER).replace(/\/+$/, "");
  // JSON 发布模式：中文标题无需处理 header 编码
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const r = await postJson(base, { topic: cfg.topic, title, message: body }, headers);
  if (r.status >= 300) throw deliveryError(httpCode(r.status), r.json?.error || `HTTP ${r.status}`);
}

async function sendServerChan(cfg, title, body) {
  const key = String(cfg.sendKey || "").trim();
  // ServerChan3（sctp{num}t... 开头的 key）走 {num}.push.ft07.com
  const m = key.match(/^sctp(\d+)t/i);
  const url = m
    ? `https://${m[1]}.push.ft07.com/send/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`;
  const r = await postJson(url, { title, desp: body });
  if (r.json?.code !== 0) {
    throw deliveryError(r.status >= 300 ? httpCode(r.status) : "NOTIFY_REJECTED", r.json?.message || r.json?.error || `HTTP ${r.status}`);
  }
}

async function sendResend(cfg, title, body, extra) {
  const to = splitRecipients(cfg.to);
  if (!to.length) throw deliveryError("NOTIFY_CONFIG_MISSING", "缺少收件人");
  const payload = {
    from: String(cfg.from || "").trim(),
    to,
    subject: title,
    text: body,
  };
  if (extra?.html) payload.html = extra.html; // 日报等富文本
  const r = await postJson("https://api.resend.com/emails", payload,
    { Authorization: `Bearer ${String(cfg.apiKey || "").trim()}` });
  if (r.status >= 300 || !r.json?.id) {
    throw deliveryError(resendCode(r), r.json?.message || r.json?.error?.message || `HTTP ${r.status}`);
  }
}

async function sendSmtp(cfg, title, body, extra) {
  await sendSmtpMail(cfg, title, body, extra?.html);
}

async function sendWebhook(cfg, title, body, extra) {
  let headers = {};
  if (cfg.headersJson) {
    try { headers = JSON.parse(cfg.headersJson); } catch {}
  }
  const { html, ...rest } = extra || {}; // HTML 只给邮件渠道，避免撑爆 webhook 载荷
  const r = await postJson(cfg.url, {
    source: BRAND.productName,
    title,
    body,
    ...rest,
    timestamp: new Date().toISOString(),
  }, headers);
  if (r.status >= 300) throw deliveryError(httpCode(r.status), `HTTP ${r.status}`);
}

const SENDERS = {
  telegram: sendTelegram,
  dingtalk: sendDingTalk,
  wecom: sendWeCom,
  feishu: sendFeishu,
  bark: sendBark,
  ntfy: sendNtfy,
  serverchan: sendServerChan,
  resend: sendResend,
  smtp: sendSmtp,
  webhook: sendWebhook,
};

// 渠道类型元数据（前端表单据此渲染）。
// secret：密钥，接口不回传、编辑时不回显，留空表示不变（db/store.js updateChannel）；
// endpoint：发往哪里，换了站点（lib/endpoint.js）就不再沿用已保存的密钥；"port" 表示这是端口，按值比较；fallback 是不填时用的值
export const CHANNEL_TYPES = [
  { value: "telegram", label: "Telegram 机器人", fields: [
    { key: "botToken", label: "Bot Token", required: true, secret: true },
    { key: "chatId", label: "Chat ID", required: true },
    { key: "apiBase", label: "服务器地址（可选，不填用官方的）", required: false, endpoint: true, fallback: TELEGRAM_API },
  ]},
  { value: "dingtalk", label: "钉钉群机器人", fields: [
    { key: "webhook", label: "Webhook 地址", required: true, secret: true, endpoint: true },
    { key: "secret", label: "加签密钥（可选）", required: false, secret: true },
  ]},
  { value: "wecom", label: "企业微信群机器人", fields: [
    { key: "webhook", label: "Webhook 地址", required: true, secret: true, endpoint: true },
  ]},
  { value: "feishu", label: "飞书群机器人", fields: [
    { key: "webhook", label: "Webhook 地址", required: true, secret: true, endpoint: true },
    { key: "secret", label: "加签密钥（可选）", required: false, secret: true },
  ]},
  { value: "bark", label: "Bark（iOS）", fields: [
    { key: "deviceKey", label: "Device Key", required: true, secret: true },
    { key: "server", label: "服务器地址（可选，不填用官方的）", required: false, endpoint: true, fallback: BARK_SERVER },
  ]},
  { value: "ntfy", label: "ntfy", fields: [
    { key: "topic", label: "Topic", required: true },
    { key: "server", label: "服务器地址（可选，不填用官方的）", required: false, endpoint: true, fallback: NTFY_SERVER },
    { key: "token", label: "ntfy 令牌（可选）", required: false, secret: true },
  ]},
  { value: "serverchan", label: "Server酱", fields: [
    { key: "sendKey", label: "SendKey", required: true, secret: true },
  ]},
  { value: "resend", label: "Resend 邮件", fields: [
    { key: "apiKey", label: "Resend Key（re_ 开头）", required: true, secret: true },
    { key: "from", label: `发件人（需已验证域名，如 ${BRAND.notificationSignature} <alert@yourdomain.com>）`, required: true },
    { key: "to", label: "收件人（多个用逗号分隔）", required: true },
  ]},
  { value: "smtp", label: "SMTP 邮件", fields: [
    { key: "host", label: "SMTP 服务器（如 smtp.gmail.com）", required: true, endpoint: true },
    { key: "port", label: "端口（一般填 465 或 587，不填用 465）", required: false, endpoint: "port", fallback: "465" },
    { key: "username", label: "用户名（通常是邮箱）", required: false },
    { key: "password", label: "密码 / 应用专用密码", required: false, secret: true },
    { key: "from", label: `发件人（如 ${BRAND.notificationSignature} <me@example.com>）`, required: true },
    { key: "to", label: "收件人（多个用逗号分隔）", required: true },
  ]},
  { value: "webhook", label: "自定义 Webhook", fields: [
    { key: "url", label: "Webhook 地址", required: true, secret: true, endpoint: true },
    { key: "headersJson", label: "请求头（可选，JSON 格式）", required: false, secret: true },
  ]},
];

const fieldsOf = (type) => CHANNEL_TYPES.find((t) => t.value === type)?.fields || [];
// 这种通知方式标了 secret 的字段：接口不回传、换地址不沿用、报错打码、存库加密（db/secrets.js）都按这一份
export const channelSecretFields = (type) => fieldsOf(type).filter((field) => field.secret);

// 只留这种通知方式字段表里的键；认不出的类型原样返回（不知道该留哪些）。Store 读库时用它清掉旧键
export function knownChannelConfig(type, config) {
  const fields = fieldsOf(type);
  if (!fields.length || !config || typeof config !== "object" || Array.isArray(config)) return config;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(config, field.key)).map((field) => [field.key, config[field.key]]));
}

// 接口返回的通知方式：只回这种类型的字段（白名单），密钥一律是空串，另给 hasSecret 说明哪些已保存（编辑时显示「已保存」）
export function publicChannel(channel) {
  const saved = channel?.config || {};
  const config = {};
  const hasSecret = {};
  for (const field of fieldsOf(channel?.type)) {
    if (field.secret) {
      hasSecret[field.key] = !!saved[field.key];
      config[field.key] = "";
    } else if (field.key in saved) {
      config[field.key] = saved[field.key];
    }
  }
  return { ...channel, config, hasSecret };
}

// 编辑或测试已保存的通知方式时，算出要用的完整配置：
// - 非密钥字段按这次填的写，留空就是清空；
// - 密钥留空表示沿用已保存的，但只在地址的站点没变时沿用；换了站点又没重新填，就抛 ENDPOINT_CHANGED_SECRET_REQUIRED。
// input 里没出现的字段保持原样（只改名字、开关时不带 config）
export function resolveChannelConfig(type, input, saved = {}) {
  const next = { ...saved };
  const fields = fieldsOf(type);
  const value = (key) => (Object.hasOwn(input, key) && input[key] != null ? String(input[key]) : null);
  // 这次要发往的地址：没带 → 已保存的；密钥地址留空 → 沿用已保存的；普通地址留空 → 不填时的默认值
  const nextEndpoint = (field) => {
    const v = value(field.key);
    if (v == null || (v === "" && field.secret)) return saved[field.key] || field.fallback || "";
    return v.trim() || field.fallback || "";
  };
  const savedEndpoint = (field) => saved[field.key] || field.fallback || "";
  const moved = fields.some((field) => field.endpoint && (field.endpoint === "port"
    ? String(nextEndpoint(field)).trim() !== String(savedEndpoint(field)).trim()
    : !sameEndpoint(nextEndpoint(field), savedEndpoint(field))));
  // 换了站点：已保存的密钥这次没有重新给出（没带、null、空串都算），一律不沿用（lib/endpoint.js，和上游同一条规则）
  if (moved && staleSecrets(channelSecretFields(type).map((field) => field.key), saved, input).length) throw endpointChangedError();
  for (const field of fields) {
    const v = value(field.key);
    // 没带的字段保持原样；密钥留空表示沿用已保存的（上面已经排除了换站点的情况）
    if (v == null || (v === "" && field.secret)) continue;
    next[field.key] = field.secret ? v : v.trim();
  }
  return next;
}

// 消息太长截掉时末尾那句（design/ui-copy-spec.md §10「太长时」）
export const TRUNCATED_NOTE = "……（太长没发完，完整内容请看邮件或控制台）";

// 一条消息能放多少：chars 按字算，bytes 按 UTF-8 字节算；withTitle 表示平台把标题和正文合成一条，标题也占地方
const LIMITS = Object.freeze({
  wecom: { bytes: 2048, withTitle: true }, // 企业微信文本消息的 content 最长 2048 字节
  bark: { bytes: 3000, withTitle: true }, // 走苹果推送，整条约 4KB，给其余字段留出位置
  ntfy: { bytes: 4000 }, // ntfy 正文 4096 字节，超了会变成附件
  resend: { chars: 20000 },
  smtp: { chars: 20000 },
});
const DEFAULT_LIMIT = Object.freeze({ chars: 1500 }); // 其余聊天软件（Telegram 整条 4096 字等）

const utf8Bytes = (s) => Buffer.byteLength(s, "utf8");

// 标题只截到 200 字
function clampTitle(title) {
  const chars = [...String(title ?? "")];
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}…` : chars.join("");
}

// 正文按这种通知方式的上限截，截了就在末尾写 TRUNCATED_NOTE；按字（码点）截，不会切开一个字
function fitBody(type, title, body) {
  const limit = Object.hasOwn(LIMITS, type) ? LIMITS[type] : DEFAULT_LIMIT;
  const chars = [...String(body ?? "")];
  if (limit.chars) return chars.length > limit.chars ? chars.slice(0, limit.chars).join("") + TRUNCATED_NOTE : chars.join("");
  const budget = limit.bytes - (limit.withTitle ? utf8Bytes(title) + 1 : 0);
  const text = chars.join("");
  if (utf8Bytes(text) <= budget) return text;
  const room = budget - utf8Bytes(TRUNCATED_NOTE);
  let used = 0;
  let end = 0;
  while (end < chars.length && used + utf8Bytes(chars[end]) <= room) used += utf8Bytes(chars[end++]);
  return chars.slice(0, end).join("") + TRUNCATED_NOTE;
}

function applyBrandLanguage(title, body) {
  let brandedTitle = String(title ?? "").replaceAll("中转站告警", BRAND.notificationSignature);
  const alreadySigned =
    brandedTitle.includes(BRAND.notificationSignature) ||
    brandedTitle.startsWith(`【${BRAND.name}日报】`);
  if (!alreadySigned) {
    brandedTitle = `${BRAND.notificationSignature} · ${brandedTitle}`;
  }
  return {
    title: brandedTitle,
    body: String(body ?? "").replaceAll("站点：", "资源："),
  };
}

// 发送到单个通知方式；返回 { ok }，没发出去时 { ok: false, error: 原文（打过码）, code }。
// 那一句话由 lib/error-copy.js 按 code 说（errorText(结果)），原文只进「查看详细原因」
export async function sendToChannel(channel, title, body, extra = {}) {
  try {
    // 只认表里自己的键：constructor、toString 这类原型链上的名字不算类型
    const sender = Object.hasOwn(SENDERS, channel.type) ? SENDERS[channel.type] : null;
    if (!sender) throw deliveryError("NOTIFY_TYPE_UNSUPPORTED", `认不出的通知方式类型：${channel.type}`);
    // 必填的没填就不发：Telegram 的 Token 留空会请求 /bot/sendMessage、拿回 404，说成「Token 不对」不准
    const missing = fieldsOf(channel.type).filter((field) => field.required && !String(channel.config?.[field.key] ?? "").trim());
    if (missing.length) throw deliveryError("NOTIFY_CONFIG_MISSING", `没填：${missing.map((field) => field.key).join("、")}`);
    const branded = applyBrandLanguage(title, body);
    const sentTitle = clampTitle(branded.title);
    await sender(channel.config || {}, sentTitle, fitBody(channel.type, sentTitle, branded.body), extra);
    return { ok: true };
  } catch (err) {
    // 原文补上底层原因（fetch 只说「fetch failed」，lib/error-copy.js errorDetail）；里面可能带着密钥
    //（例如地址填错时 fetch 会把整条 Webhook 地址写进报错），按这个通知方式自己的密钥值打码；
    // 码按通知方式的说法给（deliveryErrorCode），不套读上游的那几类，也不把 ECONNREFUSED、数字这类原样带出去
    return { ok: false, error: maskSecrets(errorDetail(err), channel), code: deliveryErrorCode(err) };
  }
}

// 这个通知方式的密钥在报错原文里可能出现的样子：原值、去掉首尾空格、URL 编码（大小写两种 %xx）、base64；
// 请求头 JSON 拆开后，每个键和值也单独算。从长到短替换，免得短的先换掉、长的就对不上了
function secretForms(channel) {
  const values = [];
  for (const field of channelSecretFields(channel?.type)) {
    const value = String(channel?.config?.[field.key] || "");
    values.push(value);
    if (field.key === "headersJson") {
      try {
        for (const [key, item] of Object.entries(JSON.parse(value) || {})) values.push(key, String(item ?? ""));
      } catch { /* 不是合法 JSON：发送时本来就会报错，原值已经算进去了 */ }
    }
  }
  const forms = new Set();
  for (const value of values) {
    for (const raw of [value, value.trim()]) {
      if (raw.length < 4) continue;
      const encoded = encodeURIComponent(raw);
      forms.add(raw).add(encoded).add(encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())).add(Buffer.from(raw).toString("base64"));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function maskSecrets(text, channel) {
  let out = String(text);
  for (const form of secretForms(channel)) out = out.split(form).join("***");
  return out;
}

// 群发到所有启用的渠道
export async function broadcast(channels, title, body, extra = {}) {
  const enabled = (channels || []).filter((c) => c.enabled !== false);
  return Promise.all(
    enabled.map(async (c) => ({ id: c.id, name: c.name, ...(await sendToChannel(c, title, body, extra)) }))
  );
}
