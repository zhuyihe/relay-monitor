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
