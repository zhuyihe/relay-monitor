// 登录信息加密保存：AES-256-GCM，主密钥来自 RELAY_SECRET_KEY（或 RELAY_SECRET_KEY_FILE 指向的文件）。
// 只在 db/store.js 的读写边界用（读库时解开、写库时对副本加密），内存里始终是明文；db/reset-secrets.js 共用同一份字段表。
// 密文写成 enc:v1:<密钥编号>:<iv>:<密文+tag>，附加数据绑定「站点 id + 字段名」「通知方式 id + 字段名」或会话密钥，
// 换到别的站点、别的字段上就解不开。编号只用来报「密钥不对」，本期不做密钥轮换。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { UPSTREAM_SECRET_FIELDS } from "../lib/channel-onboarding.js";
import { channelSecretFields } from "../lib/notify.js";

const CIPHERTEXT = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/;
const TAG_BYTES = 16;

// 上游要加密的字段：令牌、Key、密码，加上邮箱和 Sub2API 自动登录拿到的令牌（整个对象一起加密）
export const STATION_SECRET_FIELDS = Object.freeze([...UPSTREAM_SECRET_FIELDS, "email", "s2Tokens"]);
export const SESSION_SECRET_AAD = "meta:session_secret";

// 这些话只进启动日志和脚本输出，给部署的人看；页面上只说「系统还没准备好」
const RECOVER = "请换回加密时用的那个密钥；找不回的话，按部署说明运行 node db/reset-secrets.js 清掉解不开的登录信息，再到页面上重新填";
export const SECRET_TEXT = Object.freeze({
  both: "RELAY_SECRET_KEY 和 RELAY_SECRET_KEY_FILE 只能配一个",
  unreadable: (path) => `读不到 RELAY_SECRET_KEY_FILE 指向的文件：${path}`,
  invalid: "RELAY_SECRET_KEY 格式不对：要 32 字节、base64 编码，可以用 openssl rand -base64 32 生成",
  missing: `库里的登录信息是加密保存的，但没有配置 RELAY_SECRET_KEY。${RECOVER}`,
  mismatch: (saved, current) => `库里的登录信息是用另一个密钥（编号 ${saved}）加密的，现在配置的密钥编号是 ${current}。${RECOVER}`,
  corrupt: (where) => `解不开库里的登录信息（${where}）：密钥不对，或者数据被改过。${RECOVER}`,
  plaintext: "登录信息还是明文保存在数据库里：配置 RELAY_SECRET_KEY 后重启，会自动加密（见部署说明）",
});

export function secretError(code, message) {
  return Object.assign(new Error(message), { code });
}

// 解析主密钥：没配返回 null（明文运行）；配了但格式不对就报错，不悄悄当成没配
export function loadSecretKey(env = process.env) {
  const inline = String(env.RELAY_SECRET_KEY ?? "").trim();
  const file = String(env.RELAY_SECRET_KEY_FILE ?? "").trim();
  if (inline && file) throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.both);
  let text = inline;
  if (file) {
    try { text = readFileSync(file, "utf8").trim(); } catch { throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.unreadable(file)); }
  }
  return text ? secretKeyOf(text) : null;
}

export function secretKeyOf(text) {
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.invalid);
  const id = createHash("sha256").update("relay-monitor secret key id\0").update(key).digest("hex").slice(0, 8);
  return Object.freeze({ key, id });
}

export function isCiphertext(value) {
  return typeof value === "string" && CIPHERTEXT.test(value);
}

export function sealText(secretKey, plain, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey.key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `enc:v1:${secretKey.id}:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

// 解不开一律报错，不返回空值：Store.load() 后面紧跟 save()，置空会把登录信息永久覆盖
export function openText(secretKey, value, aad) {
  const [, id, iv, body] = String(value).match(CIPHERTEXT) || [];
  if (!id) throw secretError("SECRET_KEY_MISMATCH", SECRET_TEXT.corrupt(aad));
  if (!secretKey) throw secretError("SECRET_KEY_MISSING", SECRET_TEXT.missing);
  if (id !== secretKey.id) throw secretError("SECRET_KEY_MISMATCH", SECRET_TEXT.mismatch(id, secretKey.id));
  try {
    const raw = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secretKey.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw secretError("SECRET_KEY_MISMATCH", SECRET_TEXT.corrupt(aad));
  }
}

// 解得开吗（db/reset-secrets.js 用来挑出要清的）
export function canOpen(secretKey, value, aad) {
  try { openText(secretKey, value, aad); return true; } catch { return false; }
}

// 库里要加密的每一处：{ owner, key, aad, json, kind, ownerId, ownerName }。owner[key] 是这一处的值；
// json 的那处是对象（s2Tokens），按固定的键顺序转成文字再加密，这样内容没变时文字也不变，能复用上次的密文
export function secretSlots(data) {
  const slots = [];
  for (const station of data?.stations || []) {
    for (const key of STATION_SECRET_FIELDS) {
      slots.push({ owner: station, key, aad: `station:${station.id}:${key}`, json: key === "s2Tokens", kind: "station", ownerId: station.id, ownerName: station.name });
    }
  }
  for (const channel of data?.notifications?.channels || []) {
    if (!channel?.config || typeof channel.config !== "object") continue;
    for (const field of channelSecretFields(channel.type)) {
      slots.push({ owner: channel.config, key: field.key, aad: `channel:${channel.id}:${field.key}`, json: false, kind: "channel", ownerId: channel.id, ownerName: channel.name });
    }
  }
  return slots;
}

// 空值不加密（没填就是没填）
export function hasSecretValue(value) {
  return value != null && value !== "";
}

export function slotText(slot, value) {
  if (!slot.json) return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function slotValue(slot, text) {
  return slot.json ? JSON.parse(text) : text;
}
