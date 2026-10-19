export function createRequestId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  // 带码交给 lib/error-copy.js 归类，界面上写「浏览器太旧」那一句
  if (typeof crypto?.getRandomValues !== "function") throw Object.assign(new Error("当前浏览器无法生成请求标识，请更新浏览器后重试"), { code: "BROWSER_UNSUPPORTED" });
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
