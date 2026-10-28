// 加上游只填地址和令牌时，系统自己认类型和名字（上游监控简化第 3 条）：
//   sk- 开头的是只用 Key 的上游；地址是 New API（/api/status 能读到）就按 New API 账号读，要用户 ID；
//   其余按 Sub2API 登录令牌试。认不出来、读不到就把原因（和「测试读取」同一套归类）原样返回，不替用户猜。
// query / status 可注入；status 只看地址、不要令牌（/api/status 是公开接口）。
import { queryNewApiPublicStatus, queryStation } from "./providers.js";

const text = (value) => String(value ?? "").trim();

// 没读到站点自己的名字时，用地址里的主机名
export function hostNameOf(baseUrl) {
  try { return new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).host; } catch { return text(baseUrl); }
}

/**
 * @returns {Promise<{ ok: true, type: string, name: string, account: string | null, result: object }
 *   | { ok: false, needsUserId?: boolean, type?: string, code?: string, error?: string }>}
 */
export async function detectUpstream({ baseUrl, token, userId = "" }, { query = queryStation, status = queryNewApiPublicStatus } = {}) {
  baseUrl = text(baseUrl); token = text(token); userId = text(userId);
  const found = (type, result) => ({ ok: true, type, name: text(result.account) || hostNameOf(baseUrl), account: result.account || null, result });
  if (/^sk-/i.test(token)) {
    const { result } = await query({ type: "newapi-key", baseUrl, apiKey: token });
    return result.ok ? found("newapi-key", result) : { ok: false, type: "newapi-key", code: result.code, error: result.error };
  }
  let isNewApi = false;
  try { const s = await status(baseUrl); isNewApi = !!s; } catch { isNewApi = false; }
  if (isNewApi) {
    if (!userId) return { ok: false, type: "newapi", needsUserId: true };
    const { result } = await query({ type: "newapi", baseUrl, accessToken: token, userId });
    return result.ok ? found("newapi", result) : { ok: false, type: "newapi", code: result.code, error: result.error };
  }
  const { result } = await query({ type: "sub2api", baseUrl, accessToken: token });
  return result.ok ? found("sub2api", result) : { ok: false, type: "sub2api", code: result.code, error: result.error };
}
