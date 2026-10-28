// 渠道绑在上游下面（上游资源的抽屉和「绑定渠道」小窗口）用的小函数，纯函数，不依赖 React。

// 能挂渠道的上游类型（New API、Sub2API 两种登录方式）；别的类型（只用 Key、固定成本）渠道那一列写「—」，也不能点
export const BINDABLE_UPSTREAM_TYPES = Object.freeze(["newapi", "sub2api", "sub2api-password"]);

// 地址只写主机（带端口）：「https://api.example.com/v1」→「api.example.com」
export function hostOf(url) {
  const text = String(url ?? "").trim();
  if (!text) return "";
  try { return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).host; } catch { return text; }
}

// 这个上游里还能绑的 Key：启用的、名字不重复的（Sub2API 的 Key 名可以重复，按 ID 认）、没被别的渠道绑着的
export function bindableKeys(tokens, usedTokenIds = [], { platform = null } = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const used = new Set([...usedTokenIds].map(Number));
  const unique = (name) => platform === "sub2api" || list.filter((token) => token.name === name).length === 1;
  return list.filter((token) => token.status === 1 && unique(token.name) && !used.has(Number(token.id)));
}

// 小窗口里渠道的排法：地址对得上这个上游的排最前（其余保持原来的顺序）
export function unboundChannelsFor(channels, upstreamId) {
  const list = channels.filter((item) => item.ruleId == null);
  return [...list.filter((item) => item.suggestedUpstreamId === upstreamId), ...list.filter((item) => item.suggestedUpstreamId !== upstreamId)];
}
