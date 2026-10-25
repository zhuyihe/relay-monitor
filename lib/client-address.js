// 请求从哪来：登录失败限流按它算（app/api/auth/login/route.js），也决定会话 Cookie 信不信代理的 https。
// 预加载的 lib/peer-address.js、lib/api.js、lib/auth.js 共用这一处。只用 Web 标准的 Headers，不引 Next，单测能直接跑。

// TRUST_PROXY：信不信反向代理加的 X-Forwarded-* 头
export function trustsProxyHeaders(env = process.env) {
  return ["1", "true"].includes(String(env.TRUST_PROXY || "").toLowerCase());
}

// 连接地址写在哪个私有头里：名字每个部署随机一个，存在环境变量 RELAY_PEER_HEADER（预加载时生成，Next 的子进程沿用）。
// 名字不对（没预加载、被改坏）时是 null，就不读这个头。
export const PEER_HEADER_PATTERN = /^x-relay-peer-[0-9a-f]{32}$/;
export function peerHeaderName(env = process.env) {
  const name = String(env.RELAY_PEER_HEADER || "");
  return PEER_HEADER_PATTERN.test(name) ? name : null;
}

// ::ffff:1.2.3.4（IPv4 连进 IPv6 监听）和 1.2.3.4 是同一个来源；大小写、前后空白不算不同
export function normalizeAddress(address) {
  const text = String(address || "").trim().toLowerCase();
  return text.startsWith("::ffff:") && text.includes(".") ? text.slice(7) : text;
}

// 登录失败限流按哪个来源算（部署说明「登录失败限流按哪个来源算」）：
// - 没开 TRUST_PROXY：按真正连进来的地址（预加载写进私有头的那个），客户端猜不到头名、冒充不了；
//   前面有代理时就是代理的地址，全站共用一个计数，和以前一样。没预加载时退回全站一个计数（"local"）。
// - 开了 TRUST_PROXY：取 X-Forwarded-For 的最后一个地址，也就是离我们最近的那层代理追加的。客户端自己填的在前面，
//   换着填也绕不开；隔着好几层代理时最后一个是上一层代理，等于全站共用，偏保守。没有这个头时按连接地址。
export function clientIp(request, env = process.env) {
  const header = peerHeaderName(env);
  const peer = header ? normalizeAddress(request.headers.get(header)) : "";
  if (trustsProxyHeaders(env)) {
    const forwarded = String(request.headers.get("x-forwarded-for") || "").split(",").map((part) => part.trim()).filter(Boolean);
    return normalizeAddress(forwarded.at(-1)) || peer || "local";
  }
  return peer || "local";
}
