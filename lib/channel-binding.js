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

// 「绑定渠道」小窗口里渠道怎么列。只列还没绑的渠道；address 是主机，启用 / 禁用来自你站渠道目录的 status（1 启用，别的算禁用，options 里的 enabled）。
// 搜：渠道名或地址包含搜的字（不分大小写）。已禁用的默认不列，showDisabled 时排在最后。
// 分组：没在搜、又有地址对得上这个上游（suggestedUpstreamId）的渠道时，分「地址对得上这个上游」和「其他渠道」两组；别的情况只有一组，不写标题。
export function channelChoices(channels, upstreamId, { query = "", showDisabled = false } = {}) {
  const word = String(query ?? "").trim().toLowerCase();
  const unbound = (Array.isArray(channels) ? channels : []).filter((item) => item.ruleId == null);
  const found = word ? unbound.filter((item) => `${item.name ?? ""}\n${item.address ?? ""}`.toLowerCase().includes(word)) : unbound;
  const disabledCount = found.filter((item) => item.enabled === false).length;
  const shown = found.filter((item) => item.enabled !== false || showDisabled);
  const order = (list) => [...list.filter((item) => item.enabled !== false), ...list.filter((item) => item.enabled === false)];
  const isMatch = (item) => item.suggestedUpstreamId === upstreamId;
  // 「没有对得上的」只看不受搜索影响、列得出来的渠道
  const noMatch = !unbound.some((item) => isMatch(item) && (item.enabled !== false || showDisabled));
  const matched = order(shown.filter(isMatch)), others = order(shown.filter((item) => !isMatch(item)));
  let groups;
  if (word) groups = [{ title: null, channels: [...matched, ...others] }];
  else if (matched.length) groups = [{ title: "match", channels: matched }, ...(others.length ? [{ title: "other", channels: others }] : [])];
  else groups = [{ title: null, channels: others }];
  return { groups, visible: groups.flatMap((group) => group.channels), disabledCount, noMatch };
}

// 默认选哪个渠道：只有一个启用的渠道地址对得上这个上游才替用户选好；对得上好几个或一个都对不上，什么都不选
export function defaultChannelId(channels, upstreamId) {
  const matched = (Array.isArray(channels) ? channels : []).filter((item) => item.ruleId == null && item.enabled !== false && item.suggestedUpstreamId === upstreamId);
  return matched.length === 1 ? matched[0].channelId : null;
}
