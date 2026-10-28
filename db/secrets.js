// 登录信息加密保存：AES-256-GCM，主密钥来自 RELAY_SECRET_KEY（或 RELAY_SECRET_KEY_FILE 指向的文件）。
// 只在 db/store.js 的读写边界用（读库时解开、写库时对副本加密），内存里始终是明文；db/reset-secrets.js 共用这里的字段表和说法。
// 密文写成 enc:v1:<密钥编号>:<iv>:<密文+tag>，加密的是值的 JSON 文字；附加数据绑定「站点 id + 字段路径」「通知方式 id + 字段名」
// 或 meta 的键，换到别的站点、别的字段上就解不开。编号只用来报「密钥不对」，本期不做密钥轮换。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { credentialFieldOf, UPSTREAM_SECRET_FIELDS } from "../lib/channel-onboarding.js";
import { secretWeakness } from "../lib/key-fingerprint.js";
import { KEY_AGENT_URL_INVALID_TEXT, isKeyAgentUrl } from "../lib/key-agent-client.js";
import { channelSecretFields } from "../lib/notify.js";

const CIPHERTEXT = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/;
const TAG_BYTES = 16;

// 上游加密哪些（字段路径）：令牌、Key、密码、登录邮箱、Sub2API 自动登录拿到的令牌，
// 还有余额结果里记的账号名（Sub2API 账号没有用户名时就是登录邮箱）。
// 读库只按这张表解密，不是「长得像密文就解」：上游返回的任何字符串都可能长得像密文，那样一个上游就能让服务起不来。
// 所以这张表只加不减：去掉一项，库里那一项的密文就会被当成明文用
// keyAgentSecret：渠道 Key 读取服务的令牌（K2a），和上游令牌一样整串加密存
const STATION_SECRET_PATHS = Object.freeze([...UPSTREAM_SECRET_FIELDS, "email", "s2Tokens", "balance.account", "keyAgentSecret"]);
// 读取服务的令牌太短或太弱不让存（和读取服务启动时的检查一样，lib/key-fingerprint.js 的 secretWeakness）
export function assertKeyAgentSecretStrength(secret) {
  const weakness = secretWeakness(secret);
  if (weakness) throw Object.assign(new Error(weakness === "SECRET_TOO_SHORT" ? "令牌至少 32 个字符，用「怎么装」里的命令生成一串" : "令牌太弱，用「怎么装」里的命令生成一串"), { code: weakness });
}
// 读取服务地址：填了就必须是 https（令牌在请求头里走，不走明文）。不填就是没装读取服务（没有默认地址），这里不拦，对账照常按手动绑定算
export function assertKeyAgentUrl(url) {
  const text = String(url ?? "").trim();
  if (text && !isKeyAgentUrl(text)) throw Object.assign(new Error(KEY_AGENT_URL_INVALID_TEXT), { code: "KEY_AGENT_URL_NOT_HTTPS" });
  return text;
}
// 清空时写什么：自动登录的令牌是对象，清成 null；其余是字符串，清成空串
const EMPTY_VALUE = { s2Tokens: null };
// 从上游读回来的（下次刷新会重写）：明文模式下原样存着上游给的字符串，它可能刚好长得像密文。
// 解不开就清空，不中止启动
const DERIVED_PATHS = new Set(["balance.account"]);
// meta 表里整行加密的。没有时生成一个随机值；rotate：第一次加密时换新（旧备份、binlog 里的明文就作废了）。
// rotated、reset 是启动日志和 db/reset-secrets.js 说的话
// - 会话密钥：签登录 Cookie 用
// - 账单身份密钥：Sub2API 账单能力存进库时用它包一层 HMAC（lib/billing-capability-storage.js），升级时 db/pool.js 的 rehashBillingCapabilities 用它包旧格式的行。
//   不能换新，换了库里存的能力就都对不上了
export const META_SECRETS = Object.freeze([
  Object.freeze({ key: "session_secret", label: "会话密钥", rotate: true,
    rotated: "会话密钥已换新，之前登录的设备要重新登录", reset: "下次启动时重新生成，所有设备要重新登录" }),
  Object.freeze({ key: "billing_identity_key", label: "账单身份密钥", rotate: false,
    reset: "下次启动时重新生成。Sub2API 上游能不能按 Key 读账单要重新确认，有消费的那天会自动确认；在那之前，没有消费的日子每日利润算不出来，过后也不会自动补算" }),
]);

// 这些话只进启动日志和脚本输出，给部署的人看；页面上只说「系统还没准备好」
const RECOVER = "请换回加密时用的那个密钥；找不回的话，按部署说明运行 node db/reset-secrets.js 清掉解不开的登录信息，再到页面上重新填";
export const SECRET_TEXT = Object.freeze({
  both: "RELAY_SECRET_KEY 和 RELAY_SECRET_KEY_FILE 只能配一个",
  unreadable: (path) => `读不到 RELAY_SECRET_KEY_FILE 指向的文件：${path}`,
  emptyFile: (path) => `RELAY_SECRET_KEY_FILE 指向的文件是空的：${path}`,
  invalid: (source) => `${source}格式不对：要 32 字节、base64 编码，可以用 openssl rand -base64 32 生成`,
  missing: `库里的登录信息是加密保存的，但没有配置 RELAY_SECRET_KEY。${RECOVER}`,
  mismatch: (saved, current) => `库里的登录信息是用另一个密钥（编号 ${saved}）加密的，现在配置的密钥编号是 ${current}。${RECOVER}`,
  corrupt: (where) => `解不开库里的${where}：密钥不对，或者库里的数据被改过。${RECOVER}`,
  plaintext: "登录信息还是明文保存在数据库里：配置 RELAY_SECRET_KEY 后重启，会自动加密（见部署说明）",
});

export function secretError(code, message) {
  return Object.assign(new Error(message), { code });
}

// 解析主密钥：没配返回 null（明文运行）；配了但格式不对、文件读不到或是空的，都报错，不悄悄当成没配
export function loadSecretKey(env = process.env) {
  const inline = String(env.RELAY_SECRET_KEY ?? "").trim();
  const file = String(env.RELAY_SECRET_KEY_FILE ?? "").trim();
  if (inline && file) throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.both);
  if (!file) return inline ? secretKeyOf(inline) : null;
  let text;
  try { text = readFileSync(file, "utf8").trim(); } catch { throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.unreadable(file)); }
  if (!text) throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.emptyFile(file));
  return secretKeyOf(text, "RELAY_SECRET_KEY_FILE 指向的文件里的密钥");
}

export function secretKeyOf(text, source = "RELAY_SECRET_KEY ") {
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw secretError("SECRET_KEY_INVALID", SECRET_TEXT.invalid(source));
  const id = createHash("sha256").update("relay-monitor secret key id\0").update(key).digest("hex").slice(0, 8);
  return Object.freeze({ key, id });
}

export function isCiphertext(value) {
  return typeof value === "string" && CIPHERTEXT.test(value);
}

// 密文是用哪个密钥加密的（db/reset-secrets.js 报给运行脚本的人）
export function cipherKeyId(value) {
  return isCiphertext(value) ? value.split(":")[2] : null;
}

export function sealText(secretKey, plain, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `enc:v1:${secretKey.id}:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

// 解不开一律报错，不返回空值：Store.load() 后面紧跟 save()，置空会把登录信息永久覆盖。where 是报错里说的「哪一处」
export function openText(secretKey, value, aad, where = aad) {
  const [, id, iv, body] = String(value).match(CIPHERTEXT) || [];
  if (!id) throw secretError("SECRET_KEY_MISMATCH", SECRET_TEXT.corrupt(where));
  if (!secretKey) throw secretError("SECRET_KEY_MISSING", SECRET_TEXT.missing);
  if (id !== secretKey.id) throw secretError("SECRET_KEY_MISMATCH", SECRET_TEXT.mismatch(id, secretKey.id));
  try {
    const raw = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secretKey.key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw secretError("SECRET_KEY_MISMATCH", SECRET_TEXT.corrupt(where));
  }
}

// 解得开吗（db/reset-secrets.js 用来挑出要清的）
export function canOpen(secretKey, value, aad) {
  try { openText(secretKey, value, aad); return true; } catch { return false; }
}

// 加密的是值的 JSON 文字；对象按键排好序，内容没变时文字也不变，能复用上次的密文
export function secretText(value) {
  const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(value));
}

export function secretValue(text) {
  return JSON.parse(text);
}

// 空值不加密（没填就是没填）
export function hasSecretValue(value) {
  return value != null && value !== "";
}

// 存着登录信息的文档：每个上游的 doc、每个通知方式的 config
function secretDocs(data) {
  const docs = (data?.stations || []).map((station) => ({ kind: "station", id: station.id, name: station.name, type: station.type, doc: station }));
  for (const channel of data?.notifications?.channels || []) {
    if (channel?.config && typeof channel.config === "object" && !Array.isArray(channel.config)) {
      docs.push({ kind: "channel", id: channel.id, name: channel.name, type: channel.type, doc: channel.config });
    }
  }
  return docs;
}

const aadOf = (doc, path) => `${doc.kind}:${doc.id}:${path}`;

// 这一处叫什么：「上游「甲」」+「访问令牌」。上游按编辑上游的输入框名，通知方式按告警中心的字段名；启动报错和 db/reset-secrets.js 的输出都用
function holderOf(doc) {
  return `${doc.kind === "station" ? "上游" : "通知方式"}「${doc.name || doc.id}」`;
}

function labelOf(doc, path) {
  const label = doc.kind === "channel"
    ? channelSecretFields(doc.type).find((field) => field.key === path)?.label
    : path === "s2Tokens" ? "自动登录拿到的令牌" : path === "balance.account" ? "余额记录里的账号名" : path === "keyAgentSecret" ? "读取服务令牌" : credentialFieldOf(doc.type, path)?.label;
  return label || path;
}

function locate(doc, path) {
  const keys = path.split(".");
  let owner = doc;
  for (const key of keys.slice(0, -1)) {
    owner = owner?.[key];
    if (!owner || typeof owner !== "object") return null;
  }
  return { owner, key: keys.at(-1) };
}

// 库里加密的每一处（按上面的字段表）：{ owner, key, path, aad, holder, label, where, empty, derived, kind, id }，owner[key] 是这一处的值，
// id 是这一处所在的上游或通知方式。
// Store 读写和 db/reset-secrets.js 都用这一份
export function secretSlots(data) {
  const slots = [];
  for (const doc of secretDocs(data)) {
    const paths = doc.kind === "station" ? STATION_SECRET_PATHS : channelSecretFields(doc.type).map((field) => field.key);
    for (const path of paths) {
      const at = locate(doc.doc, path);
      if (!at) continue;
      const holder = holderOf(doc), label = labelOf(doc, path);
      slots.push({ ...at, path, aad: aadOf(doc, path), holder, label, where: `${holder}的${label}`, kind: doc.kind, id: doc.id,
        empty: Object.hasOwn(EMPTY_VALUE, path) ? EMPTY_VALUE[path] : "", derived: DERIVED_PATHS.has(path) });
    }
  }
  return slots;
}

export const metaAad = (key) => `meta:${key}`;
