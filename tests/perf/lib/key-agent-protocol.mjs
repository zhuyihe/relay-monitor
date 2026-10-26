// 渠道 Key 读取服务的协议（K2a/K2b 量夹具用）：打码、指纹、从 secret 派生请求令牌和指纹密钥。
// 算法和 lib/key-fingerprint.js 一字不差，但这里不从 APP_DIR 引——假站点一个进程要跨 base、head 两版用，
// 不能绑定某一个被测版本的代码；算法本身是写死的协议，两边各自实现，和 agent/、lib/ 两边各自实现、靠测试向量对齐同一个道理。
import { createHmac, hkdfSync } from "node:crypto";

const MASK_ELLIPSIS = "…";
const MIN_MASK_LENGTH = 24;
const TOKEN_INFO = "relay-monitor/key-agent/token";
const FINGERPRINT_INFO = "relay-monitor/key-agent/fingerprint";

export function normalizeKey(raw) {
  const text = String(raw ?? "").trim();
  return text.startsWith("sk-") ? text.slice(3) : text;
}

export function maskKey(raw) {
  const key = normalizeKey(raw);
  if (key.length < MIN_MASK_LENGTH) return MASK_ELLIPSIS;
  return `${key.slice(0, 4)}${MASK_ELLIPSIS}${key.slice(-4)}`;
}

export function fingerprintKey(raw, fingerprintKeyBytes) {
  return createHmac("sha256", fingerprintKeyBytes).update(normalizeKey(raw)).digest().subarray(0, 16).toString("base64url");
}

export function deriveAgentKeys(secret) {
  const text = String(secret ?? "").trim();
  const derive = (info) => Buffer.from(hkdfSync("sha256", Buffer.from(text, "utf8"), Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
  return Object.freeze({ token: derive(TOKEN_INFO).toString("base64url"), fingerprintKey: derive(FINGERPRINT_INFO) });
}

// 够强的 secret（openssl rand -base64 32 那一类）：控制台和读取服务都要求至少 32 个字符、不太规律；
// 夹具固定用这一串，和 db/secrets.test.js、server/key-agent.test.js 已经验过的那一串同一个来源
export const KEY_AGENT_SECRET = "K7m2-xP9q" + "R4t".repeat(10);
