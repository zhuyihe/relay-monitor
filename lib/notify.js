// 通知渠道发送器：全部用原生 fetch 实现，不引第三方 SDK
import { createHmac } from "node:crypto";
import { BRAND } from "./brand.js";
import { endpointChangedError, sameEndpoint, staleSecrets } from "./endpoint.js";
import { errorCodeOf } from "./error-copy.js";
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

// ---- 各渠道实现 -------------------------------------------------------------

async function sendTelegram(cfg, title, body) {
  const base = (cfg.apiBase || TELEGRAM_API).replace(/\/+$/, "");
  const r = await postJson(`${base}/bot${cfg.botToken}/sendMessage`, {
    chat_id: cfg.chatId,
    text: `${title}\n${body}`,
  });
  if (!r.json?.ok) throw new Error(r.json?.description || `HTTP ${r.status}`);
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
  if (r.json?.errcode !== 0) throw new Error(r.json?.errmsg || `HTTP ${r.status}`);
}

async function sendWeCom(cfg, title, body) {
  const r = await postJson(cfg.webhook, {
    msgtype: "text",
    text: { content: `${title}\n${body}` },
  });
  if (r.json?.errcode !== 0) throw new Error(r.json?.errmsg || `HTTP ${r.status}`);
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
  if (code !== 0) throw new Error(r.json?.msg || `HTTP ${r.status}`);
}

async function sendBark(cfg, title, body) {
  const base = (cfg.server || BARK_SERVER).replace(/\/+$/, "");
  const r = await postJson(`${base}/push`, {
    device_key: cfg.deviceKey,
    title,
    body,
    group: BRAND.notificationSignature,
  });
  if (r.json?.code !== 200) throw new Error(r.json?.message || `HTTP ${r.status}`);
}

async function sendNtfy(cfg, title, body) {
  const base = (cfg.server || NTFY_SERVER).replace(/\/+$/, "");
  // JSON 发布模式：中文标题无需处理 header 编码
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const r = await postJson(base, { topic: cfg.topic, title, message: body }, headers);
  if (r.status >= 300) throw new Error(r.json?.error || `HTTP ${r.status}`);
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
    throw new Error(r.json?.message || r.json?.error || `HTTP ${r.status}`);
  }
}

async function sendResend(cfg, title, body, extra) {
  const to = splitRecipients(cfg.to);
  if (!to.length) throw new Error("缺少收件人");
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
    throw new Error(r.json?.message || r.json?.error?.message || `HTTP ${r.status}`);
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
  if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
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
    { key: "apiBase", label: "API 地址（可选，默认官方）", required: false, endpoint: true, fallback: TELEGRAM_API },
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
    { key: "secret", label: "签名校验密钥（可选）", required: false, secret: true },
  ]},
  { value: "bark", label: "Bark（iOS）", fields: [
    { key: "deviceKey", label: "Device Key", required: true, secret: true },
    { key: "server", label: "服务器（可选，默认 api.day.app）", required: false, endpoint: true, fallback: BARK_SERVER },
  ]},
  { value: "ntfy", label: "ntfy", fields: [
    { key: "topic", label: "主题 Topic", required: true },
    { key: "server", label: "服务器（可选，默认 ntfy.sh）", required: false, endpoint: true, fallback: NTFY_SERVER },
    { key: "token", label: "访问令牌（可选）", required: false, secret: true },
  ]},
  { value: "serverchan", label: "Server酱", fields: [
    { key: "sendKey", label: "SendKey", required: true, secret: true },
  ]},
  { value: "resend", label: "Resend 邮件", fields: [
    { key: "apiKey", label: "API Key（re_ 开头）", required: true, secret: true },
    { key: "from", label: `发件人（需已验证域名，如 ${BRAND.notificationSignature} <alert@yourdomain.com>）`, required: true },
    { key: "to", label: "收件人（多个用逗号分隔）", required: true },
  ]},
  { value: "smtp", label: "SMTP 邮件", fields: [
    { key: "host", label: "SMTP 服务器（如 smtp.gmail.com）", required: true, endpoint: true },
    { key: "port", label: "端口（465=SSL / 587=STARTTLS，默认 465）", required: false, endpoint: "port", fallback: "465" },
    { key: "username", label: "用户名（通常是邮箱）", required: false },
    { key: "password", label: "密码 / 应用专用密码", required: false, secret: true },
    { key: "from", label: `发件人（如 ${BRAND.notificationSignature} <me@example.com>）`, required: true },
    { key: "to", label: "收件人（多个用逗号分隔）", required: true },
  ]},
  { value: "webhook", label: "自定义 Webhook", fields: [
    { key: "url", label: "URL", required: true, secret: true, endpoint: true },
    { key: "headersJson", label: "附加请求头 JSON（可选）", required: false, secret: true },
  ]},
];

const fieldsOf = (type) => CHANNEL_TYPES.find((t) => t.value === type)?.fields || [];

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
  if (moved && staleSecrets(fields.filter((field) => field.secret).map((field) => field.key), saved, input).length) throw endpointChangedError();
  for (const field of fields) {
    const v = value(field.key);
    // 没带的字段保持原样；密钥留空表示沿用已保存的（上面已经排除了换站点的情况）
    if (v == null || (v === "" && field.secret)) continue;
    next[field.key] = field.secret ? v : v.trim();
  }
  return next;
}

// 截断，避开各渠道长度上限（Telegram 4096 字符 / 企微 2048 字节）
function clamp(s, max = 1500) {
  s = String(s ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
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

// 发送到单个渠道；返回 {ok, error?}
export async function sendToChannel(channel, title, body, extra = {}) {
  const sender = SENDERS[channel.type];
  if (!sender) return { ok: false, error: `未知渠道类型：${channel.type}` };
  try {
    // 邮件渠道放宽正文长度（日报等长文），IM 类渠道按平台上限截断
    const limit = channel.type === "resend" || channel.type === "smtp" ? 20000 : 1500;
    const branded = applyBrandLanguage(title, body);
    await sender(channel.config || {}, clamp(branded.title, 200), clamp(branded.body, limit), extra);
    return { ok: true };
  } catch (err) {
    // 报错原文里可能带着密钥（例如地址填错时 fetch 会把整条 Webhook 地址写进报错），按这个通知方式自己的密钥值打码；
    // 码只带认得的（lib/error-copy.js），不把 ECONNREFUSED、数字这类原样带出去
    const code = errorCodeOf(err);
    return { ok: false, error: maskSecrets(err?.message || String(err), channel), ...(code ? { code } : {}) };
  }
}

// 这个通知方式的密钥在报错原文里可能出现的样子：原值、去掉首尾空格、URL 编码（大小写两种 %xx）、base64；
// 请求头 JSON 拆开后，每个键和值也单独算。从长到短替换，免得短的先换掉、长的就对不上了
function secretForms(channel) {
  const values = [];
  for (const field of fieldsOf(channel?.type)) {
    if (!field.secret) continue;
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
