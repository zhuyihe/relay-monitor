// 两个地址是不是同一个站点（design/ui-copy-spec.md §8.2）：协议、主机、端口都相同才算，只改路径不算换站点。
// 上游的站点地址、通知方式的地址（Telegram API 地址、Bark/ntfy 服务器、Webhook、SMTP 服务器）共用这一个判断：
// 换了站点，已保存的令牌、密码不再沿用，免得发到新地址去。纯函数，前后端都能用。

// 没写协议的（SMTP 服务器只填主机名）按 http 补上再比；默认端口按协议补齐，「https://a」和「https://a:443」算同一个
const DEFAULT_PORTS = Object.freeze({ "http:": "80", "https:": "443" });

export function endpointKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const port = url.port || DEFAULT_PORTS[url.protocol] || "";
    return `${url.protocol}//${url.hostname}:${port}`;
  } catch {
    return raw.toLowerCase();
  }
}

export function sameEndpoint(a, b) {
  return endpointKey(a) === endpointKey(b);
}

// 换了站点时，已保存的哪些密钥这次没有重新给出：没带这个字段、给了 null、给了空串都算。
// 上游保存（db/store.js）、测试读取（app/api/stations/test）、通知方式保存和发送测试（lib/notify.js）共用这一条规则
export function staleSecrets(keys, saved, input) {
  return keys.filter((key) => saved?.[key] && !(input && input[key] != null && String(input[key]) !== ""));
}

// 换了站点又没重新填密钥时抛的错；界面按码说「换了地址，已保存的令牌、密码不会带过去，请重新填」（lib/error-copy.js）
export function endpointChangedError() {
  return Object.assign(new Error("换了地址，已保存的密钥需要重新填"), { code: "ENDPOINT_CHANGED_SECRET_REQUIRED" });
}
