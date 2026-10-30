// 读上游、测试读取的报错原文统一在这里脱敏。
const SENSITIVE_KEYS = ["accessToken", "refreshToken", "apiKey", "password", "email"];

function redactInlineSecrets(message) {
  return message
    // 常见请求头和 Bearer 令牌。
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(bearer\s+)[a-z0-9._~+\-/=]+/gi, "$1[已隐藏]")
    // 上游 JSON / 文本诊断里可能回显的敏感字段。
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|email)["']?\s*[:=]\s*)(?:["'])?[^\s,"'}]+(?:["'])?/gi, "$1[已隐藏]")
    // 上游回话里回显的完整 Key（sk- 开头的长串）。
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[已隐藏]")
    // 地址查询参数中的临时令牌或登录信息。
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|email)=)[^&\s]+/gi, "$1[已隐藏]");
}

// 读上游失败的「详细原因」：HTTP 状态码、是哪个接口（只写路径，不带查询参数）、上游回的原话（已脱敏）；没有上游回话的（连不上、超时）写错误原文。
// 和 connectionDiagnostic 同一套脱敏（去掉 Key、令牌、密码、邮箱），截到 500 字。error.upstream 由 lib/providers.js 的 withUpstream / request 带上
export function upstreamErrorDetail(error, station) {
  const info = error?.upstream || {};
  const parts = [];
  if (info.status) parts.push(`HTTP ${info.status}`);
  if (info.path) parts.push(String(info.path).split("?")[0]);
  const said = String(info.message || "").trim() || (info.status ? "" : String(error?.message || "").trim());
  if (said) parts.push(`${info.status ? "上游回" : "错误"}：${said}`);
  return parts.length ? connectionDiagnostic(parts.join(" · "), station) : "";
}

// 报错原文脱敏：去掉 station（可以是几份登录信息）里的密钥、令牌、密码和邮箱，再截到 500 字。
// 只给「详细原因」和日志用；界面上那句话按 lib/error-copy.js 的 describeError 归类（§8.2）。
export function connectionDiagnostic(error, station) {
  return redactDiagnostic(error, station).slice(0, 500);
}

// 只脱敏、不截断：要先把整段原文里的秘密盖掉，再截（截在秘密中间会漏出前几个字）
export function redactDiagnostic(error, station) {
  let message = String(error?.message ?? error ?? "");
  const connections = (Array.isArray(station) ? station : [station]).flatMap((connection) => [connection, connection?.s2Tokens]);
  const secrets = [...new Set(connections.flatMap((connection) => SENSITIVE_KEYS.flatMap((key) => {
    const value = String(connection?.[key] || "");
    return value ? [value, value.trim(), value.replace(/^Bearer\s+/i, "").trim()] : [];
  })))].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of secrets) {
    message = message.split(value).join("[已隐藏]");
  }
  return redactInlineSecrets(message);
}
