// 读上游、测试读取的报错原文统一在这里脱敏。
const SENSITIVE_KEYS = ["accessToken", "refreshToken", "apiKey", "password", "email"];

function redactInlineSecrets(message) {
  return message
    // 常见请求头和 Bearer 令牌。
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(bearer\s+)[a-z0-9._~+\-/=]+/gi, "$1[已隐藏]")
    // 上游 JSON / 文本诊断里可能回显的敏感字段。
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|email)["']?\s*[:=]\s*)(?:["'])?[^\s,"'}]+(?:["'])?/gi, "$1[已隐藏]")
    // 地址查询参数中的临时令牌或登录信息。
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|email)=)[^&\s]+/gi, "$1[已隐藏]");
}

// 报错原文脱敏：去掉 station（可以是几份登录信息）里的密钥、令牌、密码和邮箱，再截到 500 字。
// 只给「详细原因」和日志用；界面上那句话按 lib/error-copy.js 的 describeError 归类（§8.2）。
export function connectionDiagnostic(error, station) {
  let message = String(error?.message ?? error ?? "");
  const connections = (Array.isArray(station) ? station : [station]).flatMap((connection) => [connection, connection?.s2Tokens]);
  const secrets = [...new Set(connections.flatMap((connection) => SENSITIVE_KEYS.flatMap((key) => {
    const value = String(connection?.[key] || "");
    return value ? [value, value.trim(), value.replace(/^Bearer\s+/i, "").trim()] : [];
  })))].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of secrets) {
    message = message.split(value).join("[已隐藏]");
  }
  return redactInlineSecrets(message).slice(0, 500);
}
