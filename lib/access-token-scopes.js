// New API 新式访问令牌（nap_ 开头，rc.41 起）的权限清单和两个报错码，只写在这一处（own-revenue-plan 第三节）。
// 页面和服务端共用，不引 node: 模块。说明文字从这张表生成：以后加权限（R2 的 option:read、K 的读完整 Key）只在这里加一行。
// 清单对着 New API middleware/access_token_routes.go 核过；/api/status 不用登录，不列。
export const ACCESS_TOKEN_LEGACY_RETIRED = "ACCESS_TOKEN_LEGACY_RETIRED"; // 401：旧式令牌过了 30 天作废
export const ACCESS_TOKEN_SCOPE_DENIED = "ACCESS_TOKEN_SCOPE_DENIED"; // 403：令牌少了这条路要的权限，message 里点出少的是哪一项
export const ACCESS_TOKEN_ERROR_CODES = Object.freeze([ACCESS_TOKEN_LEGACY_RETIRED, ACCESS_TOKEN_SCOPE_DENIED]);

// side：own 自营站点（管理员令牌）、upstream 上游（账号令牌）；use 是控制台读哪些接口要它（给开发看，不写进界面）
export const ACCESS_TOKEN_SCOPES = Object.freeze({
  own: Object.freeze([
    { scope: "profile:read", use: "/api/user/self" },
    { scope: "channel:read", use: "/api/channel/" },
    { scope: "log:read", use: "/api/log/、/api/log/stat、/api/data/flow" },
    { scope: "user:read", use: "/api/user/" },
    { scope: "usage:read", use: "/api/data/self" },
    { scope: "option:read", use: "/api/option/（只读 LogConsumeEnabled：自营站点记不记收费记录；还要超级管理员）" },
  ]),
  upstream: Object.freeze([
    { scope: "profile:read", use: "/api/user/self、/api/user/self/groups" },
    { scope: "api_key:read", use: "/api/token/" },
    { scope: "usage:read", use: "/api/log/self/stat、/api/data/self" },
  ]),
});

// 新令牌要勾的权限，写进「访问令牌已经作废了」的说明里；side 不是 upstream 的都按自营站点
export function accessTokenScopeText(side) {
  return ACCESS_TOKEN_SCOPES[side === "upstream" ? "upstream" : "own"].map((item) => item.scope).join("、");
}

// New API 在 message 里点出少的那一项（The access token lacks the required permission: channel:read）：取最后一个「名字:动作」，认不出为空串
export function missingScopeOf(message) {
  const found = String(message || "").match(/[a-z][a-z_]*:[a-z_*]+/gi);
  return found ? found[found.length - 1] : "";
}

export const isAccessTokenError = (code) => ACCESS_TOKEN_ERROR_CODES.includes(code);
