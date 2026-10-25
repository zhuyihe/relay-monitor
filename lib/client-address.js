// 请求从哪来：登录失败限流按它算（app/api/auth/login/route.js），也决定会话 Cookie 信不信代理的 https。
// 预加载的 lib/peer-address.js、lib/api.js、lib/auth.js 共用这一处。只在找地址、分 IPv6 段时用 node:net，不引 Next。
import { isIP } from "node:net";

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

// 去掉 "1.2.3.4:5678"、"[::1]:5678"、"[::1]" 外层的端口和方括号；不是这几种写法的原样返回。
// 没加方括号的 IPv6 本身就带冒号，分不清端口在哪，不处理（真要带端口的代理一般会加方括号）
function stripPort(value) {
  const text = String(value || "").trim();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end === -1 ? text : text.slice(1, end);
  }
  const withPort = text.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  return withPort ? withPort[1] : text;
}

// 规范化、去端口以后，用 net.isIP 校验是不是地址；不是的话是空串，调用方退回下一个来源。
// 挡两件事：XFF 里带了端口的代理（每条新连接算一个新来源，等于没限流）；塞进去的垃圾值（键可以很长，攒 1 万条占内存）
function validAddress(value) {
  const normalized = normalizeAddress(stripPort(value));
  return normalized && isIP(normalized) ? normalized : "";
}

// IPv6 地址展开成 8 组十六进制（处理 "::" 缩写）
function expandIPv6(address) {
  const [head, tail = ""] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill("0"), ...tailParts];
}

// 限流用的键：IPv4（含已经转换过的映射地址）原样；IPv6 只留前 64 位，代表这一段地址，不是单个地址。
// 一个 /64 通常整段分给一个用户，按单个地址算，攻击者换一个地址就能绕开限流，形同虚设（安全审核 10-25）
export function rateLimitKey(address) {
  if (!address) return "";
  return isIP(address) === 6 ? `${expandIPv6(address).slice(0, 4).join(":")}::/64` : address;
}

// 登录失败限流按哪个来源算（部署说明「登录失败限流按哪个来源算」）：
// - 没开 TRUST_PROXY：按真正连进来的地址（预加载写进私有头的那个），客户端猜不到头名、冒充不了；
//   前面有代理时就是代理的地址，全站共用一个计数，和以前一样。没预加载时退回全站一个计数（"local"）。
// - 开了 TRUST_PROXY：取 X-Forwarded-For 的最后一个地址，也就是离我们最近的那层代理追加的。客户端自己填的在前面，
//   换着填也绕不开；隔着好几层代理时最后一个是上一层代理，等于全站共用，偏保守。不是合法地址、或没有这个头时按连接地址。
export function clientIp(request, env = process.env) {
  const header = peerHeaderName(env);
  const peer = header ? validAddress(request.headers.get(header)) : "";
  if (trustsProxyHeaders(env)) {
    const forwarded = String(request.headers.get("x-forwarded-for") || "").split(",").map((part) => part.trim()).filter(Boolean);
    const last = validAddress(forwarded.at(-1) || "");
    return rateLimitKey(last) || rateLimitKey(peer) || "local";
  }
  return rateLimitKey(peer) || "local";
}
