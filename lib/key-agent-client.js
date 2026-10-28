// 控制台这一侧问渠道 Key 读取服务（K2a，k-plan 第二节 2.4）。只走 HTTPS，带令牌，ETag 省流量；
// 503/网络错误/超时都当「读不到」，不抛出让调用方死等——下一轮自然会再问。
const DEFAULT_TIMEOUT_MS = 5000;

// 读取服务地址不是 https 开头时的说法（设置自营站点的抽屉、保存和「测试读取」的报错共用；design/ui-copy-spec.md §8.2）
export const KEY_AGENT_URL_INVALID_TEXT = "读取服务地址要以 https:// 开头（渠道 Key 要加密传）；有反向代理的，留空用默认地址就行";
export const isKeyAgentUrl = (url) => /^https:\/\/\S+$/i.test(String(url ?? "").trim());

function codeOf(status) {
  if (status === 401) return "KEY_AGENT_UNAUTHORIZED";
  if (status === 503) return "KEY_AGENT_UNAVAILABLE";
  if (status === 404) return "KEY_AGENT_URL_INVALID"; // 地址上没有读取服务
  return "KEY_AGENT_RESPONSE_INVALID";
}

// 响应体（v1）里的渠道要有的样子：{ id, name, type, status, baseUrl } 加 keyless:true，或者 keys:[{i,m,f}]
function validChannel(value) {
  if (!value || typeof value !== "object" || !Number.isFinite(Number(value.id))) return false;
  if (value.keyless === true) return true;
  return Array.isArray(value.keys) && value.keys.every((key) => Number.isFinite(Number(key?.i)) && typeof key?.m === "string" && typeof key?.f === "string");
}

// url、token 由调用方算好（server/key-agent.js 用 lib/key-fingerprint.js 的 deriveAgentKeys 从站点的 keyAgentSecret 派生）。
// etag 是上一次拿到的 ETag，带了就发 If-None-Match；304 时 channels 是 null，调用方沿用上一轮的结果
export async function fetchKeyAgentSnapshot({ url, token, etag = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  if (!/^https:\/\//.test(String(url ?? ""))) return { ok: false, code: "KEY_AGENT_URL_INVALID" };
  const target = `${String(url).replace(/\/+$/, "")}/keys`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(target, {
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip", ...(etag ? { "If-None-Match": etag } : {}) },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, code: "KEY_AGENT_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
  const stale = response.headers?.get?.("x-agent-stale") === "1";
  const staleReason = stale ? (response.headers?.get?.("x-agent-stale-reason") || "DB_ERROR") : null;
  if (response.status === 304) {
    if (!etag) return { ok: false, code: "KEY_AGENT_RESPONSE_INVALID" };
    return { ok: true, status: 304, channels: null, etag, stale, staleReason };
  }
  if (response.status !== 200) return { ok: false, code: codeOf(response.status), status: response.status };
  let body;
  try { body = await response.json(); } catch { return { ok: false, code: "KEY_AGENT_URL_INVALID" }; } // 不是 JSON：多半是连到了别的网页
  if (!Number.isInteger(body?.v) || !Array.isArray(body?.channels) || !body.channels.every(validChannel)) {
    return { ok: false, code: "KEY_AGENT_RESPONSE_INVALID" };
  }
  const nextEtag = response.headers?.get?.("etag") || null;
  return { ok: true, status: 200, channels: body.channels, etag: nextEtag, stale, staleReason, readAt: Number(body.readAt) || null };
}
