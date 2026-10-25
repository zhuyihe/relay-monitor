// 渠道 Key 的打码和指纹：读取服务（agent/）和控制台共用这一份，规则必须一字不差（lib/key-fingerprint.vectors.json 两边都跑）。
// 这里是唯一碰完整 Key 的地方：算完就返回，不留引用（JS 字符串没法清零，做的是「不留引用、尽快丢掉」）。
import { createHmac, hkdfSync } from "node:crypto";

const MASK_ELLIPSIS = "…";
const MIN_MASK_LENGTH = 16;
export const MIN_SECRET_LENGTH = 32;
const TOKEN_INFO = "relay-monitor/key-agent/token";
const FINGERPRINT_INFO = "relay-monitor/key-agent/fingerprint";

// 渠道里填的「Key」整个就不是一把 Bearer Key 的类型（New API 的渠道类型号）。核对的是 New API v1.0.0-rc.46 的
// constant/channel.go（较早的 rc 版本类型号相同）和 relay/channel/ 下各适配器怎么用 key：
// 15 Baidu（client_id|client_secret）、18 Xunfei（appid|apisecret|apikey）、23 Tencent（appid|secretid|secretkey）、
// 33 AWS（ak|sk|region，或 api-key|region）、51 Jimeng（ak|sk）、57 Codex（OAuth 的 JSON）。
// Vertex（41）有两种：JSON 账号文件，或者 api_key 模式下一把普通的 key，所以不整类排除，靠下面按串的样子认；
// Kling（50）在 rc.46 是 JS 插件，没核到格式，也靠串的样子；BaiduV2（46）是 token 或 token|appid，带 | 的靠串的样子
export const KEYLESS_CHANNEL_TYPES = Object.freeze([15, 18, 23, 33, 51, 57]);

// 去首尾空白，再去掉开头一个 sk-。不猜别的前缀
export function normalizeKey(raw) {
  const text = String(raw ?? "").trim();
  return text.startsWith("sk-") ? text.slice(3) : text;
}

// 前 4 + … + 后 4；不足 16 位的只写 …（8 位的 Key 前 4 后 4 就是全文）
export function maskKey(raw) {
  const key = normalizeKey(raw);
  if (key.length < MIN_MASK_LENGTH) return MASK_ELLIPSIS;
  return `${key.slice(0, 4)}${MASK_ELLIPSIS}${key.slice(-4)}`;
}

// HMAC-SHA256 取前 16 字节，base64url，22 个字符
export function fingerprintKey(raw, fingerprintKeyBytes) {
  return createHmac("sha256", fingerprintKeyBytes).update(normalizeKey(raw)).digest().subarray(0, 16).toString("base64url");
}

// 这串东西不是一把 Bearer Key（Vertex 的 JSON、ak|sk 之类）：露出前 4 后 4 也会泄露一半凭据，不打码
function isCompoundCredential(text) {
  return text.startsWith("{") || text.includes("|");
}

// 一个渠道的 key 列：isMultiKey 为真才拆（New API 自己也是这样用）。
// 拆法照 New API 的 GetKeys：去空白后以 [ 开头按 JSON 数组拆（字符串取字符串，对象算 keyless），否则按换行拆。
// 返回 { keys: string[], keyless: boolean }
export function splitChannelKeys(rawKey, { isMultiKey = false } = {}) {
  const text = String(rawKey ?? "").trim();
  if (!text) return { keys: [], keyless: false };
  if (!isMultiKey) return isCompoundCredential(text) ? { keys: [], keyless: true } : { keys: [text], keyless: false };
  let parts;
  if (text.startsWith("[")) {
    try { parts = JSON.parse(text); } catch { parts = null; }
    if (!Array.isArray(parts)) return { keys: [], keyless: true };
  } else {
    parts = text.split("\n");
  }
  const keys = [];
  let keyless = false;
  for (const part of parts) {
    if (typeof part !== "string") { keyless = true; continue; }
    const item = part.trim();
    if (!item) continue;
    if (isCompoundCredential(item)) { keyless = true; continue; }
    keys.push(item);
  }
  return keyless ? { keys: [], keyless: true } : { keys, keyless: false };
}

// 从 RELAY_KEY_AGENT_SECRET 派生请求令牌和指纹密钥（HKDF-SHA256，盐为空）。读取服务和控制台用同一个函数
export function deriveAgentKeys(secret) {
  const text = String(secret ?? "").trim();
  if (text.length < MIN_SECRET_LENGTH) {
    throw Object.assign(new Error("令牌太短"), { code: "SECRET_TOO_SHORT" });
  }
  const derive = (info) => Buffer.from(hkdfSync("sha256", Buffer.from(text, "utf8"), Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
  return Object.freeze({ token: derive(TOKEN_INFO).toString("base64url"), fingerprintKey: derive(FINGERPRINT_INFO) });
}
