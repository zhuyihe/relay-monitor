// 问渠道 Key 读取服务是否配好、连不连得上（K2a）。只依赖轻量模块，供「测试读取」这条路用，
// 不拉 server/own-helpers.js 和 lib/providers.js 那一整条重链（见 server/key-agent-identify.js）。
import { deriveAgentKeys } from "../lib/key-fingerprint.js";
import { fetchKeyAgentSnapshot } from "../lib/key-agent-client.js";

// 这个站点有没有配好读取服务（url、secret 都填了，secret 够强）；配不上当没配，不抛错（和启动时的检查一个道理）
export function keyAgentConfigOf(station) {
  const url = String(station?.keyAgentUrl || "").trim();
  const secret = String(station?.keyAgentSecret || "").trim();
  if (!url || !secret) return null;
  try { return { url, ...deriveAgentKeys(secret) }; } catch { return null; }
}

// 连通性测试（设置自营站点抽屉的「测试读取」，不缓存、不计入轮询的 4 分钟节流）。
// 接受 { keyAgentUrl, keyAgentSecret } 这样的裸配置，不要求是已保存的站点：抽屉里填好就能测，不用先保存。
// 地址没填：没配，不算错；地址填了但令牌太弱：返回码 SECRET_TOO_SHORT/SECRET_TOO_WEAK，界面按 design/ui-copy-spec.md §3.7 写文案
export async function readKeyAgent({ keyAgentUrl, keyAgentSecret }, options = {}) {
  const url = String(keyAgentUrl || "").trim();
  if (!url) return { ok: false, code: "KEY_AGENT_NOT_CONFIGURED" };
  let config;
  try { config = deriveAgentKeys(keyAgentSecret); }
  catch (error) { return { ok: false, code: error.code }; }
  const snapshot = await fetchKeyAgentSnapshot({ url, token: config.token, ...options });
  if (!snapshot.ok) return snapshot;
  return { ok: true, channelCount: (snapshot.channels || []).length, stale: snapshot.stale, staleReason: snapshot.staleReason, etag: snapshot.etag };
}
