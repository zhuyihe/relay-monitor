// 报错只说这几类（design/ui-copy-spec.md §8.2）：页面、接口、推送、日报和测试读取都用 describeError 归类。
// 界面上只写这一类的话和下一步按钮；原文只放进「查看详细原因」（app/components/error-detail.tsx），推送和日报不放原文。
// 服务端 throw 的文字只给开发看（§12.4），要归类的错误带 code；没有 code 的再看原文里的关键词，最后看我们自己接口的 HTTP 状态。
// 读上游时在出错的地方按上游的状态给码（lib/providers.js 的 providerError），原文里的 401、500 这些数字不当关键词认。
import { ONBOARDING_KEY_ONLY_MONITOR } from "./channel-onboarding.js";
import { OWN_STATION_UNSET } from "./format.js";
import { fillIssueCopy, reconciliationIssue } from "./reconciliation-contract.js";
import { DESTINATION_CHANGED, workflowActionMeta } from "./workflow-actions.js";

// 每一类在界面上的那句话和下一步按钮（lib/workflow-actions.js 的动作）。
export const ERROR_CATEGORIES = Object.freeze({
  auth: { text: "登录信息不对或过期了", action: "update_authorization" },
  permission: { text: "这份登录信息没有读取权限，需要超级管理员的访问令牌", action: "update_authorization" },
  captcha: { text: "登录时被人机验证拦下，请改用登录令牌", action: "update_authorization" },
  unreachable: { text: "连不上这个地址，检查地址有没有填错；还不行请联系技术同事" },
  busy: { text: "上游暂时繁忙，系统稍后会自动再读" },
  unreadable: { text: "上游返回的内容不对，请把详细原因发给技术同事", action: "view_detail" },
  own_feature_off: { text: "自营站点没开数据看板，请到 New API 后台打开" },
  changed: { text: "内容有变化，请重新预览", action: "refresh" },
  expired: { text: "页面已过期，请刷新后重新打开", action: "refresh" },
  not_found: { text: "找不到这个上游" },
  unset: { text: OWN_STATION_UNSET, action: "setup_own_station" },
  not_ready: { text: "系统还没准备好，请稍后刷新", action: "refresh" },
  other: { text: "操作没完成，请稍后再试", action: "view_detail" },
});

// 错误码 → 哪一类。值是类名，或 { category, text, action } 改写这一类的话；{ issue } 表示按 §5 的问题文案说。
// 只说明哪一步没做成的兜底码（VERIFICATION_FAILED、ONBOARDING_FAILED、SYNC_FAILED 这类）故意不放进来，按原文的关键词归类；SAVE_FAILED 说清了是没存上，在下面。
const CODES = Object.freeze({
  AUTHENTICATION_FAILED: "auth", INVALID_TOKEN: "auth", TOKEN_EXPIRED: "auth", SAVED_AUTHORIZATION_UNAVAILABLE: "auth",
  AUTHORIZATION_UNVERIFIED: "auth", AUTHORIZATION_UPDATE_REQUIRED: "auth",
  UPSTREAM_AUTH_DENIED: "permission", KEY_METADATA_UNAVAILABLE: "permission", OWN_IDENTITY_UNVERIFIED: "permission",
  CAPTCHA_REQUIRED: "captcha",
  NETWORK_UNREACHABLE: "unreachable", ECONNRESET: "unreachable",
  KEY_PROBE_UNAVAILABLE: "busy", UPSTREAM_STAT_UNAVAILABLE: "busy", UPSTREAM_REQUEST_FAILED: "busy", UPSTREAM_WINDOW_PENDING: "busy",
  UPSTREAM_LIST_CHANGED: "busy",
  UPSTREAM_KEY_CATALOGUE_INVALID: "unreadable", CHANNEL_CATALOGUE_INVALID: "unreadable", UPSTREAM_RESPONSE_INVALID: "unreadable",
  OWN_FEATURE_DISABLED: "own_feature_off",
  PREVIEW_BASIS_CHANGED: "changed", PREVIEW_REQUIRED: "changed", EFFECTIVE_PREVIEW_CHANGED: "changed", RESOURCE_CHANGED: "changed",
  OPERATION_CHANGED: "changed", AUTHORIZATION_CHANGED: "changed", CHANNEL_SOURCE_CHANGED: "changed",
  // 要改的绑定已经变了
  STALE_SCOPE: { category: "changed", text: DESTINATION_CHANGED },
  // 同一把 Key 下几个渠道的选择互相冲突：在原处改好再预览，没有可刷新的
  GROUP_CONFLICT: { category: "changed", text: "几个渠道的选择互相冲突，请改好后重新预览", action: null },
  // 保存了，但登录信息有没有换成新的没确认下来
  CREDENTIAL_UPDATE_UNCONFIRMED: { category: "changed", text: "已保存；登录信息有没有更新好还没确认，请重新预览" },
  INVALID_REQUEST: "expired", CHANNEL_CATALOGUE_STALE: "expired",
  INVALID_RESOURCE: "not_found",
  RULE_NOT_FOUND: { category: "not_found", text: "这条绑定已解除" },
  RULE_DISABLED: { category: "not_found", text: "这条绑定已解除" },
  HISTORY_UNAVAILABLE: "not_ready",
  KEY_REQUIRED: { category: "other", text: "请选择这条绑定用的 Key", action: null },
  RULE_IDENTITY_IMMUTABLE: { category: "other", text: "绑定建好后不能直接改 Key，请用「换 Key」", action: "swap_key" },
  TOKEN_NAME_AMBIGUOUS: { category: "other", text: "上游有几把 Key 同名，分不清是哪一把；请先在上游后台把名字改成不一样的", action: null },
  // 接口和测试读取带出来的码，按这几类说
  NOT_READY: "not_ready", UPSTREAM_NOT_FOUND: "not_found", OWN_STATION_UNSET: "unset", OWN_STATION_CHANGED: "changed",
  INVALID_BASE_URL: "unreachable", OWN_CHANNEL_UNAVAILABLE: "permission",
  TIMEZONE_INVALID: "expired", INVALID_SELECTION: "expired", INVALID_TRANSITION_TIME: "expired",
  // 能说清具体原因的（§8.2 第二张表）：填写、选择不对，或这个上游不跟着更新
  TIME_RANGE_INVALID: { category: "other", text: "开始时间要早于结束时间", action: null },
  TIME_RANGE_FUTURE: { category: "other", text: "不能选以后的时间", action: null },
  TIME_RANGE_TOO_LONG: { category: "other", text: "一次最多查 31 天", action: null },
  CHANNEL_REQUIRED: { category: "other", text: "请至少选一个渠道", action: null },
  TRANSITION_TIME_OUT_OF_RANGE: { category: "other", text: "改的时间要在前后两次倍率变化之间", action: null },
  KEY_DISABLED: { category: "other", text: "上游里这把 Key 用不了，可能被关掉、过期或额度用完了", action: null },
  KEY_GROUP_UNSUPPORTED: { category: "other", text: "只有「只走一个分组」的 Key 能绑定", action: null },
  UNSUPPORTED_UPSTREAM_TYPE: { category: "other", text: "请选上游类型", action: null },
  ACCESS_TOKEN_REQUIRED: { category: "other", text: "请填访问令牌", action: null },
  USER_ID_REQUIRED: { category: "other", text: "读不到上游账号，请填用户 ID 再测试读取", action: null },
  BILLING_AUTHORIZATION_REQUIRED: { category: "other", text: "要读账单，还需要这个上游账号的访问令牌", action: null },
  ACCOUNT_MISMATCH: { category: "other", text: "属于别的上游账号", action: null },
  AUTHORIZATION_ACCOUNT_MISMATCH: { category: "other", text: "这份登录信息是另一个上游账号的，请新增上游", action: null },
  MONITOR_ACCOUNT_MISMATCH: { category: "other", text: "看余额和读账单用的登录信息不是同一个上游账号", action: null },
  OWN_STATION_EXCLUDED: { category: "other", text: "自营站点不在这里更新", action: null },
  UPSTREAM_ARCHIVED: { category: "other", text: "这个上游已归档", action: null },
  KEY_ONLY_EXCLUDED: { category: "other", text: "只用 Key 的上游不跟着更新", action: null },
  KEY_ONLY_MONITOR_REQUIRED: { category: "other", text: ONBOARDING_KEY_ONLY_MONITOR, action: null },
  BROWSER_UNSUPPORTED: { category: "other", text: "这个浏览器太旧，请换新版浏览器再试", action: null },
  // 控制台自己的登录（lib/api.js）
  UNAUTHORIZED: { category: "auth", text: "登录已过期，请重新登录", action: null },
  SESSION_EXPIRED: { category: "auth", text: "登录已过期，请重新登录", action: null },
  DEFAULT_PASSWORD_CHANGE_REQUIRED: { category: "other", text: "请先修改初始密码", action: null },
  // 登录控制台、改密码（app/api/auth/login、password 路由）；登录页、系统设置按码把报错放到对应的输入框
  LOGIN_FAILED: { category: "other", text: "用户名或密码不对", action: null },
  LOGIN_RATE_LIMITED: { category: "other", text: "试了太多次，请 5 分钟后再试", action: null },
  WRONG_PASSWORD: { category: "other", text: "原密码不对", action: null },
  PASSWORD_TOO_SHORT: { category: "other", text: "新密码至少 6 位", action: null },
  // 读上游、读自营站点、保存时能说清原因的
  MISSING_CONFIGURATION: { category: "other", text: "地址或登录信息没填全，请到上游里补上", action: null },
  TWO_FACTOR_ENABLED: { category: "auth", text: "这个账号开了两步验证，不能自动登录，请改用登录令牌" },
  ENDPOINT_MISMATCH: { category: "unreachable", text: "地址或类型可能不对，请检查后再填" },
  UPSTREAM_FEATURE_UNSUPPORTED: { category: "other", text: "对方的版本不支持这项功能", action: null },
  UPSTREAM_LIST_TOO_LARGE: { category: "unreadable", text: "数量太多，一次读不完，请把详细原因发给技术同事" },
  OWN_STATION_UNAVAILABLE: { category: "busy", text: "自营站点暂时读不到，请稍后再试", action: "refresh" },
  SAVE_FAILED: { category: "other", text: "没存上，请稍后再试", action: null },
  // 服务端用的旧码，按对应的问题说（§5.2）
  ACCOUNT_IDENTITY_CHANGED: { issue: "SOURCE_BINDING_UNCONFIRMED" },
  UPSTREAM_IDENTITY_CHANGED: { issue: "SOURCE_BINDING_UNCONFIRMED" },
  RULE_OWN_STATION_CONFLICT: { issue: "SOURCE_BINDING_UNCONFIRMED" },
  IDENTITY_CONFLICT: { issue: "COST_OWNER_UNVERIFIED" },
  IDENTITY_UNVERIFIED: { issue: "COST_OWNER_UNVERIFIED" },
  UPSTREAM_IDENTITY_UNAVAILABLE: { issue: "COST_OWNER_UNVERIFIED" },
  UPSTREAM_KEY_UNVERIFIED: { issue: "COST_OWNER_UNVERIFIED" },
  BILLING_CAPABILITY_UNVERIFIED: { issue: "UPSTREAM_CAPABILITY_UNVERIFIED" },
  CHANNEL_CONFLICT: { issue: "DUPLICATE_CHANNEL_ASSIGNMENT" },
});

// 没有 code 时按原文里的关键词归类；先认得出的排前面。
const PATTERNS = [
  ["captcha", /人机验证|captcha|turnstile|cloudflare challenge/i],
  ["own_feature_off", /数据看板|DataExport/i],
  ["permission", /forbidden|permission|privileg|无权|没有.*权限|权限不足/i],
  ["auth", /unauthori[sz]ed|未授权|令牌.*(无效|过期)|(token|jwt).*(invalid|expired|malformed)|登录.*(过期|失效)|密码错误|invalid credentials/i],
  ["unreachable", /timeout|timed out|abort|econnrefused|econnreset|enotfound|eai_again|fetch failed|getaddrinfo|certificate|network|超时|连接被拒绝|无法连接|invalid url|failed to parse url/i],
  ["busy", /too many requests|rate limit|bad gateway|service unavailable|繁忙/i],
  // 只认解析失败的说法；单写 json 会把带这个词的其他报错也归成「上游返回的内容不对」
  ["unreadable", /unexpected token|unexpected end of json|not valid json|invalid json|json parse|响应格式|格式不正确|无效数据|未返回有效/i],
];

// 我们自己接口的 HTTP 状态 → 哪一类（接口没带 code、原文也认不出时）。
const STATUSES = Object.freeze({ 403: "permission", 404: "not_found", 409: "changed", 502: "busy", 503: "not_ready", 504: "busy" });

function rawOf(error) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  return String(error.reason || error.message || error.error || "");
}

function categoryOf(error, raw) {
  const code = typeof error === "object" && error ? error.code || null : null;
  const status = typeof error === "object" && error ? Number(error.status) : NaN;
  // 只认表里自己的键：constructor、toString 这类原型链上的名字不算错误码
  if (code && Object.hasOwn(CODES, code)) return { code, entry: CODES[code] };
  const issue = code ? reconciliationIssue(code) : null;
  if (issue?.known && (issue.kind === "action" || issue.kind === "reading")) return { code, entry: { issue: code } };
  const matched = PATTERNS.find(([, pattern]) => pattern.test(raw));
  if (matched) return { code, entry: matched[0] };
  return { code, entry: STATUSES[status] || "other" };
}

// 每一类的代表码：服务端只有原文、要交给前端或接口一个码时用（errorCodeOf）。「其他」没有代表码。
const CATEGORY_CODES = Object.freeze({
  auth: "AUTHENTICATION_FAILED", permission: "UPSTREAM_AUTH_DENIED", captcha: "CAPTCHA_REQUIRED", unreachable: "NETWORK_UNREACHABLE",
  busy: "UPSTREAM_REQUEST_FAILED", unreadable: "UPSTREAM_RESPONSE_INVALID", own_feature_off: "OWN_FEATURE_DISABLED",
  changed: "RESOURCE_CHANGED", expired: "INVALID_REQUEST", not_found: "UPSTREAM_NOT_FOUND", unset: "OWN_STATION_UNSET", not_ready: "NOT_READY",
});

// 服务端给报错补一个码，接口、读上游、自营站点都用这一个：带着认得的码（上表或 §5 的问题码）就用它，
// 否则按 describeError 的归类给这一类的代表码；归到「其他」时给 fallback（默认 null）。
export function errorCodeOf(error, fallback = null) {
  const { code, entry } = categoryOf(error, rawOf(error));
  if (code && (Object.hasOwn(CODES, code) || entry?.issue)) return code;
  return CATEGORY_CODES[typeof entry === "string" ? entry : entry.category] || fallback;
}

function actionCopy(kind) {
  return kind ? workflowActionMeta(kind)?.label || "" : "";
}

// 一个错误在界面上怎么说：category 类名，text 那一句，action / actionLabel 下一步按钮（没有为 null / ""），raw 原文（只给「详细原因」）。
// error 可以是 Error（带 code、status）、接口返回的 { error, code }、带 reason 的结果，或者一段原文；params 用来填问题文案里的 {channel} 等。
export function describeError(error, { params = {} } = {}) {
  const raw = rawOf(error);
  const { code, entry } = categoryOf(error, raw);
  if (entry?.issue) {
    const issue = reconciliationIssue(entry.issue);
    const text = issue.kind === "reading" ? issue.hint : fillIssueCopy(issue.title, issue.plain, params);
    const action = issue.kind === "action" ? issue.action : null;
    return { category: "issue", code: code || null, issue: entry.issue, text, action, actionLabel: actionCopy(action), raw };
  }
  const category = typeof entry === "string" ? entry : entry.category;
  const base = ERROR_CATEGORIES[category];
  const action = typeof entry === "object" && "action" in entry ? entry.action : base.action || null;
  return { category, code: code || null, text: (typeof entry === "object" && entry.text) || base.text, action, actionLabel: actionCopy(action), raw };
}

// 只要那一句话的地方（message.error、推送、日报）
export function errorText(error, options) {
  return describeError(error, options).text;
}

// 表单漏填（§8.2）：「请填访问令牌」「请填 Key」，英文开头的名字前空一格
export function requiredText(label) {
  return `请填${/^[A-Za-z]/.test(label) ? " " : ""}${label}`;
}

// 表单的必填规则，漏填时说上面那句
export function requiredRule(label) {
  return { required: true, message: requiredText(label) };
}

// 补上句号：自己带了句号、问号、叹号的不再加
export function asSentence(text) {
  return `${text}${/[。？！]$/.test(text) ? "" : "。"}`;
}

// 「保存失败：原因。」「读不到上游账单：原因。」这类句子（§8.1）：what 是没做成的事，reason 是归类后的那句。
export function failureSentence(what, reason) {
  return asSentence(`${what}：${reason}`);
}

// 同上，直接给报错：先按 §8.2 归类成那一句
export function failureText(what, error, options) {
  return failureSentence(what, errorText(error, options));
}

// 浏览器连不上控制台（断网、服务没起来）：fetch 直接报错，不是接口报错（§8.2）
export const CONSOLE_UNREACHABLE = "连不上控制台，请检查网络后再试";

// 控制台自己的接口（登录、改密码、保存设置、通知方式）出错时的那一句（§8.2）。
// 原文说的是控制台内部的事，不按读上游的几类关键词猜：数据库超时不说成「连不上这个地址」，代理 502 不说成「上游繁忙」。
// 带着认得的码照常说；fetch 本身失败说 CONSOLE_UNREACHABLE；502–504 说「系统还没准备好」；其余说「操作没完成」。原文另进「查看详细原因」
export function consoleErrorText(error) {
  if (error instanceof TypeError) return CONSOLE_UNREACHABLE;
  const code = typeof error === "object" && error ? error.code : null;
  if (code && Object.hasOwn(CODES, code)) return errorText(error);
  const status = Number(error?.status);
  return ERROR_CATEGORIES[status >= 502 && status <= 504 ? "not_ready" : "other"].text;
}

// 「保存失败：原因。」这类句子，原因按上面控制台自己的说法
export function consoleFailureText(what, error) {
  return failureSentence(what, consoleErrorText(error));
}

// 刷新一个上游之后的提示（§3.5、§8.1）：读到了写「已刷新「X」」，读不到写「读不到「X」的余额：原因。」
export function refreshOneText(name, balance) {
  if (balance && !balance.ok) return { ok: false, text: failureText(`读不到「${name}」的余额`, balance) };
  return { ok: true, text: `${workflowActionMeta("refresh").done}「${name}」` };
}

// 刷新全部上游之后的提示：「已刷新」；有读不到余额的写「已刷新，其中 2 个上游读不到余额，见「需处理」」。
// 和「需处理」同一口径：归档的、自营站点的余额不算。
export function refreshAllText(stations) {
  const failed = (Array.isArray(stations) ? stations : [])
    .filter((s) => s && !s.archivedAt && !s.isOwn && s.balance && !s.balance.ok).length;
  const done = workflowActionMeta("refresh").done;
  return { failed, text: failed ? `${done}，其中 ${failed} 个上游读不到余额，见「需处理」` : done };
}
