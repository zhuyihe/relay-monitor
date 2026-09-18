const SENSITIVE_KEYS = ["accessToken", "apiKey", "password", "email"];

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

function diagnosticOf(error, station) {
  let message = String(error || "连接测试失败").slice(0, 500);
  for (const key of SENSITIVE_KEYS) {
    const value = String(station?.[key] || "").trim();
    if (value) message = message.split(value).join("[已隐藏]");
  }
  return redactInlineSecrets(message);
}

export function describeConnectionFailure(error, station) {
  const diagnostic = diagnosticOf(error, station);
  const text = diagnostic.toLowerCase();

  if (/缺少.*(地址|令牌|密码|邮箱|密钥)|请填写/.test(diagnostic)) {
    return {
      code: "MISSING_CONFIGURATION",
      category: "连接信息不完整",
      message: "连接信息不完整",
      action: "请检查站点地址，以及当前类型要求的令牌、密钥或登录信息。",
      diagnostic,
    };
  }

  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|权限|无权|令牌.*(无效|过期)|token.*(invalid|expired)|jwt.*(invalid|expired|malformed)/.test(text) || /未授权|拒绝访问/.test(diagnostic)) {
    return {
      code: "AUTHENTICATION_FAILED",
      category: "凭证或权限问题",
      message: "凭证无效、已过期或没有所需权限",
      action: "请重新生成具备所需权限的访问令牌，确认用户 ID 与站点类型后再次测试。",
      diagnostic,
    };
  }

  if (/invalid url|failed to parse url|响应中没有额度|quota|\b404\b|not found|路径|接口不存在|平台类型/.test(text)) {
    return {
      code: "ENDPOINT_MISMATCH",
      category: "地址或类型不匹配",
      message: "站点地址或平台类型不匹配",
      action: "请确认地址填写的是站点根地址，并选择与目标平台对应的接入类型。",
      diagnostic,
    };
  }

  if (/abort|timeout|timed out|etimedout|econnrefused|enotfound|eai_again|fetch failed|network|网络|超时|连接被拒绝/.test(text)) {
    return {
      code: "NETWORK_UNREACHABLE",
      category: "网络连接问题",
      message: "无法连接到站点",
      action: "请检查站点地址、服务器网络、DNS、端口和防火墙设置后重试。",
      diagnostic,
    };
  }

  return {
    code: "CONNECTION_FAILED",
    category: "连接测试失败",
    message: "连接测试未通过",
    action: "请核对站点地址与凭证；如仍失败，可根据下方诊断信息排查。",
    diagnostic,
  };
}
