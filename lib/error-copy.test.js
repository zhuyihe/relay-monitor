import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONSOLE_UNREACHABLE, ERROR_CATEGORIES, asSentence, connectionFailed, consoleErrorText, consoleFailureText, deliveryErrorCode, describeError, errorDetail, errorCodeOf, errorText, failureSentence, failureText, ownStationErrorCode, refreshAllText, refreshOneText, requiredRule, requiredText } from "./error-copy.js";
import { COVERAGE_QUESTION, INCOMPLETE_DAY_TEXT, RECONCILIATION_ISSUE_CODES, reconciliationIssue } from "./reconciliation-contract.js";
import { OWN_STATION_UNSET } from "./format.js";
import { WORKFLOW_ACTION_KINDS, workflowActionMeta } from "./workflow-actions.js";

// lib/error-copy.js 的 CODES 还在加码：从文件里现读码名，新加的码也要过下面的检查
function errorCodes() {
  const source = readFileSync(new URL("./error-copy.js", import.meta.url), "utf8");
  const start = source.indexOf("const CODES = Object.freeze({");
  const body = source.slice(start, source.indexOf("\n});", start));
  return [...new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*:/g)].map((match) => match[1]))];
}
const CODES = errorCodes();
// 只看界面上会写的几项
const shown = (error, options) => {
  const described = describeError(error, options);
  return [described.category, described.text, described.actionLabel];
};
const withCode = (code, message = "", extra = {}) => Object.assign(new Error(message), { code, ...extra });

test("§8.2 第一张表：每一类的那句话和下一步按钮", () => {
  const table = {
    auth: ["登录信息不对或过期了", "更新登录信息"],
    permission: ["这份登录信息没有读取权限，需要超级管理员的访问令牌", "更新登录信息"],
    captcha: ["登录时被人机验证拦下，请改用登录令牌", "更新登录信息"],
    unreachable: ["连不上这个地址，检查地址有没有填错；还不行请联系技术同事", ""],
    busy: ["上游暂时繁忙，系统稍后会自动再读", ""],
    unreadable: ["上游返回的内容不对，请把详细原因发给技术同事", "查看详细原因"],
    own_feature_off: ["自营站点没开数据看板，请到 New API 后台打开", ""],
    changed: ["内容有变化，请重新预览", "刷新"],
    expired: ["页面已过期，请刷新后重新打开", "刷新"],
    not_found: ["找不到这个上游", ""],
    unset: [OWN_STATION_UNSET, "去设置"],
    not_ready: ["系统还没准备好，请稍后刷新", "刷新"],
    other: ["操作没完成，请稍后再试", "查看详细原因"],
  };
  assert.deepEqual(Object.keys(ERROR_CATEGORIES), Object.keys(table));
  for (const [category, [text, button]] of Object.entries(table)) {
    const entry = ERROR_CATEGORIES[category];
    if (entry.action) assert.ok(WORKFLOW_ACTION_KINDS.includes(entry.action), `${category} 的按钮 ${entry.action} 不在动作表里`);
    assert.deepEqual([entry.text, entry.action ? workflowActionMeta(entry.action).label : ""], [text, button], category);
  }
  assert.equal(OWN_STATION_UNSET, "还没设置自营站点：在上游资源里编辑你的 New API 站点，打开「这是我的自营站点」。", "§8.1 的原句");
});

test("每个错误码都归得了类：有一句话、按钮在动作表里、码原样带回", () => {
  assert.ok(CODES.length > 40, "读到了 CODES");
  for (const code of CODES) {
    const described = describeError({ code });
    assert.equal(described.code, code);
    assert.ok(described.category === "issue" || described.category in ERROR_CATEGORIES, `${code} 归到了 ${described.category}`);
    assert.ok(described.text && typeof described.text === "string", `${code} 没有文字`);
    assert.doesNotMatch(described.text, /[{}]/, `${code} 有没填的占位`);
    if (described.action == null) assert.equal(described.actionLabel, "", code);
    else {
      assert.ok(WORKFLOW_ACTION_KINDS.includes(described.action), `${code} 的按钮 ${described.action} 不在动作表里`);
      assert.equal(described.actionLabel, workflowActionMeta(described.action).label, code);
    }
    if (described.category !== "issue") assert.equal(described.issue, undefined, code);
  }
});

test("码归到哪一类", () => {
  const category = (code) => describeError({ code }).category;
  const table = {
    auth: ["AUTHENTICATION_FAILED", "INVALID_TOKEN", "TOKEN_EXPIRED", "SAVED_AUTHORIZATION_UNAVAILABLE", "AUTHORIZATION_UNVERIFIED", "AUTHORIZATION_UPDATE_REQUIRED"],
    permission: ["UPSTREAM_AUTH_DENIED", "KEY_METADATA_UNAVAILABLE", "OWN_IDENTITY_UNVERIFIED", "OWN_CHANNEL_UNAVAILABLE"],
    unreachable: ["NETWORK_UNREACHABLE", "ENDPOINT_MISMATCH", "ECONNRESET", "INVALID_BASE_URL"],
    busy: ["KEY_PROBE_UNAVAILABLE", "UPSTREAM_STAT_UNAVAILABLE", "UPSTREAM_REQUEST_FAILED", "UPSTREAM_WINDOW_PENDING"],
    unreadable: ["UPSTREAM_KEY_CATALOGUE_INVALID", "CHANNEL_CATALOGUE_INVALID"],
    changed: ["PREVIEW_BASIS_CHANGED", "PREVIEW_REQUIRED", "EFFECTIVE_PREVIEW_CHANGED", "RESOURCE_CHANGED", "OPERATION_CHANGED", "AUTHORIZATION_CHANGED", "CHANNEL_SOURCE_CHANGED", "STALE_SCOPE", "GROUP_CONFLICT", "OWN_STATION_CHANGED", "CREDENTIAL_UPDATE_UNCONFIRMED"],
    expired: ["INVALID_REQUEST", "CHANNEL_CATALOGUE_STALE", "TIMEZONE_INVALID", "INVALID_SELECTION", "INVALID_TRANSITION_TIME"],
    not_found: ["INVALID_RESOURCE", "UPSTREAM_NOT_FOUND", "RULE_NOT_FOUND", "RULE_DISABLED"],
    not_ready: ["HISTORY_UNAVAILABLE", "NOT_READY"],
    unset: ["OWN_STATION_UNSET"],
  };
  for (const [name, codes] of Object.entries(table)) for (const code of codes) assert.equal(category(code), name, code);
  assert.deepEqual(shown({ code: "OWN_STATION_UNSET" }), ["unset", OWN_STATION_UNSET, "去设置"]);
  assert.deepEqual(shown({ code: "RULE_NOT_FOUND" }), ["not_found", "这条绑定已解除", ""], "找不到绑定时说更具体的一句");
  assert.deepEqual(shown({ code: "INVALID_TOKEN" }), ["auth", "登录信息不对或过期了", "更新登录信息"]);
});

test("§8.2 第二张表：能说清具体原因的码用那一句，按钮按表", () => {
  const table = {
    KEY_REQUIRED: ["请选择这条绑定用的 Key", ""],
    RULE_IDENTITY_IMMUTABLE: ["绑定建好后不能直接改 Key，请用「换 Key」", "换 Key"],
    TOKEN_NAME_AMBIGUOUS: ["上游有几把 Key 同名，分不清是哪一把；请先在上游后台把名字改成不一样的", ""],
    TIME_RANGE_INVALID: ["开始时间要早于结束时间", ""],
    TIME_RANGE_FUTURE: ["不能选以后的时间", ""],
    TIME_RANGE_TOO_LONG: ["一次最多查 31 天", ""],
    TRANSITION_TIME_OUT_OF_RANGE: ["改的时间要在前后两次倍率变化之间", ""],
    TRANSITION_TIME_IN_FUTURE: ["不能改到以后的时间", ""],
    CHANNEL_REQUIRED: ["请至少选一个渠道", ""],
    KEY_DISABLED: ["上游里这把 Key 用不了，可能被关掉、过期或额度用完了", ""],
    KEY_GROUP_UNSUPPORTED: ["只有「只走一个分组」的 Key 能绑定", ""],
    UNSUPPORTED_UPSTREAM_TYPE: ["请选上游类型", ""],
    ACCESS_TOKEN_REQUIRED: ["请填访问令牌", ""],
    USER_ID_REQUIRED: ["读不到上游账号，请填用户 ID 再测试读取", ""],
    BILLING_AUTHORIZATION_REQUIRED: ["要读账单，还需要这个上游账号的访问令牌", ""],
    AUTHORIZATION_ACCOUNT_MISMATCH: ["这份登录信息是另一个上游账号的，请新增上游", ""],
    MONITOR_ACCOUNT_MISMATCH: ["看余额和读账单用的登录信息不是同一个上游账号", ""],
    ACCOUNT_MISMATCH: ["属于别的上游账号", ""],
    OWN_STATION_EXCLUDED: ["自营站点不在这里更新", ""],
    UPSTREAM_ARCHIVED: ["这个上游已归档", ""],
    KEY_ONLY_EXCLUDED: ["只用 Key 的上游不跟着更新", ""],
    KEY_ONLY_MONITOR_REQUIRED: ["只用 Key 的上游要选「看余额」", ""],
    CREDENTIAL_UPDATE_UNCONFIRMED: ["已保存；登录信息有没有更新好还没确认，请重新预览", "刷新"],
    BROWSER_UNSUPPORTED: ["这个浏览器太旧，请换新版浏览器再试", ""],
  };
  for (const [code, [text, button]] of Object.entries(table)) {
    const described = describeError({ code });
    assert.deepEqual([described.text, described.actionLabel], [text, button], code);
    assert.ok(described.category in ERROR_CATEGORIES, `${code} 仍归在第一张表的某一类`);
  }
  assert.equal(describeError({ code: "KEY_REQUIRED" }).action, null, "写了 action: null 就不带这一类的按钮");
});

test("报错其实是 §5 的问题：按 §5 的标题和按钮说，读取类用实时时的提示", () => {
  const issueOf = (error, options) => {
    const described = describeError(error, options);
    return [described.category, described.issue, described.text, described.action, described.actionLabel];
  };
  // 服务端的旧码
  assert.deepEqual(issueOf({ code: "ACCOUNT_IDENTITY_CHANGED" }), ["issue", "SOURCE_BINDING_UNCONFIRMED", "上游账号或自营站点有变化", "review_source", "去上游资源"]);
  assert.deepEqual(issueOf({ code: "RULE_OWN_STATION_CONFLICT" }).slice(1, 2), ["SOURCE_BINDING_UNCONFIRMED"]);
  assert.deepEqual(issueOf({ code: "IDENTITY_UNVERIFIED" }), ["issue", "COST_OWNER_UNVERIFIED", "还没确认这把 Key 属于哪个上游账号", null, ""]);
  assert.deepEqual(issueOf({ code: "BILLING_CAPABILITY_UNVERIFIED" }), ["issue", "UPSTREAM_CAPABILITY_UNVERIFIED", "还没确认能读到这个上游的完整账单", null, ""]);
  assert.deepEqual(issueOf({ code: "CHANNEL_CONFLICT" }, { params: { channel: "出口一" } }),
    ["issue", "DUPLICATE_CHANNEL_ASSIGNMENT", "渠道「出口一」同时绑了两把 Key", "review_conflict", "处理重复"]);
  assert.equal(errorText({ code: "CHANNEL_CONFLICT" }), "有渠道同时绑了两把 Key", "不知道渠道名就不带名字");
  // 直接带 §5 的问题码
  assert.deepEqual(issueOf({ code: "KEY_INVALID_OR_DENIED" }), ["issue", "KEY_INVALID_OR_DENIED", "上游拒绝读取这把 Key", "update_authorization", "更新登录信息"]);
  assert.deepEqual(issueOf({ code: "COST_COVERAGE_UNKNOWN" }), ["issue", "COST_COVERAGE_UNKNOWN", COVERAGE_QUESTION, "confirm_coverage", "去回答"]);
  assert.deepEqual(issueOf({ code: "UPSTREAM_DATA_UNAVAILABLE" }), ["issue", "UPSTREAM_DATA_UNAVAILABLE", "上游暂时读不到，系统会自动再读", null, ""]);
  assert.deepEqual(issueOf({ code: "STALE" }), ["issue", "STALE", INCOMPLETE_DAY_TEXT, null, ""]);
  const codes = new Set(CODES);
  for (const code of RECONCILIATION_ISSUE_CODES.filter((item) => !codes.has(item))) {
    const issue = reconciliationIssue(code);
    const described = describeError({ code });
    if (issue.kind === "hint") assert.notEqual(described.category, "issue", `${code} 是提示，不当报错说`);
    else assert.deepEqual([described.category, described.text], ["issue", issue.kind === "reading" ? issue.hint : issue.plain || issue.title], code);
  }
});

test("归类顺序：错误码 > §5 问题码 > 原文关键词 > HTTP 状态 > 其他", () => {
  assert.equal(describeError(withCode("INVALID_TOKEN", "captcha required"), {}).category, "auth", "有码就不看原文");
  assert.equal(describeError(withCode("KEY_INVALID_OR_DENIED", "network timeout")).category, "issue", "问题码先于原文");
  assert.equal(describeError(withCode("SALES_CHANNEL_MISSING", "network timeout")).category, "unreachable", "提示类的码不算问题码");
  assert.equal(describeError(withCode("READY")).category, "other");
  // 兜底码只说明哪一步没做成，按原文归类
  assert.deepEqual(shown(withCode("VERIFICATION_FAILED", "HTTP 401 Unauthorized")), ["auth", "登录信息不对或过期了", "更新登录信息"]);
  assert.equal(describeError(withCode("VERIFICATION_FAILED", "boom")).category, "other");
  assert.equal(describeError(withCode("VERIFICATION_FAILED", "boom")).code, "VERIFICATION_FAILED");
  assert.equal(describeError(withCode("SOMETHING_NEW", "fetch failed")).category, "unreachable", "不认识的码按原文归类");
  assert.equal(describeError({ status: 404, message: "request timeout" }).category, "unreachable", "原文先于 HTTP 状态");
  assert.equal(describeError({ status: 503, message: "Service Unavailable" }).category, "busy");
  assert.equal(describeError({ status: 503 }).category, "not_ready");
  // 关键词之间也有先后
  assert.equal(describeError("captcha 403 forbidden").category, "captcha");
  assert.equal(describeError("DataExport 403 forbidden").category, "own_feature_off");
  assert.equal(describeError("Forbidden: Unauthorized").category, "permission");
  assert.equal(describeError("token expired, request timeout").category, "auth");
  assert.equal(describeError("timeout from bad gateway").category, "unreachable");
  assert.equal(describeError("bad gateway, invalid json").category, "busy");
  // 原文里的数字不当关键词：「403 Unauthorized」按 Unauthorized 归到登录
  assert.equal(describeError("403 Unauthorized").category, "auth");
});

test("原文里的关键词", () => {
  const table = {
    captcha: ["需要人机验证", "Captcha required", "turnstile token missing", "Cloudflare challenge"],
    own_feature_off: ["数据看板未开启", "DataExport is disabled"],
    permission: ["Forbidden", "permission denied", "insufficient privileges", "无权访问", "没有读取权限", "权限不足"],
    auth: ["Unauthorized", "unauthorised", "未授权", "访问令牌无效", "令牌已过期", "token invalid", "JWT expired", "jwt malformed", "登录已过期", "登录失效", "密码错误", "Invalid credentials"],
    unreachable: ["timeout", "Request timed out", "This operation was aborted", "connect ECONNREFUSED 127.0.0.1:3000", "read ECONNRESET", "getaddrinfo ENOTFOUND relay.local",
      "EAI_AGAIN", "fetch failed", "certificate has expired", "network error", "请求超时", "连接被拒绝", "无法连接", "Invalid URL", "Failed to parse URL from x"],
    busy: ["Too Many Requests", "rate limit exceeded", "Bad Gateway", "Service Unavailable", "系统繁忙"],
    unreadable: ["Unexpected token < in JSON at position 0", "is not valid JSON", "响应格式不对", "格式不正确", "无效数据", "未返回有效数据"],
    // 单写状态码不算：上游的状态码由读上游的地方换成码，我们自己接口的看 status
    other: ["boom", "", "401", "HTTP 403", "429", "HTTP 500", "502", "code 500"],
  };
  for (const [category, samples] of Object.entries(table)) for (const sample of samples) assert.equal(describeError(sample).category, category, sample);
});

test("我们自己接口的 HTTP 状态", () => {
  const table = { 403: "permission", 404: "not_found", 409: "changed", 502: "busy", 503: "not_ready", 504: "busy", 500: "other" };
  for (const [status, category] of Object.entries(table)) {
    assert.equal(describeError({ status: Number(status) }).category, category, status);
    assert.equal(describeError({ status }).category, category, `字符串 ${status}`);
  }
});

test("几种输入：原文、Error、接口返回、带 reason 的结果、空", () => {
  assert.deepEqual(describeError("fetch failed"), { category: "unreachable", code: null, text: ERROR_CATEGORIES.unreachable.text, action: null, actionLabel: "", raw: "fetch failed" });
  assert.deepEqual(describeError(new Error("401 Unauthorized")), { category: "auth", code: null, text: "登录信息不对或过期了", action: "update_authorization", actionLabel: "更新登录信息", raw: "401 Unauthorized" });
  assert.deepEqual(describeError({ error: "上游返回 429", code: "UPSTREAM_REQUEST_FAILED" }),
    { category: "busy", code: "UPSTREAM_REQUEST_FAILED", text: "上游暂时繁忙，系统稍后会自动再读", action: null, actionLabel: "", raw: "上游返回 429" });
  assert.equal(describeError({ reason: "令牌已过期", message: "ignored" }).raw, "令牌已过期", "reason 先于 message");
  assert.equal(describeError({ message: "m", error: "e" }).raw, "m");
  for (const empty of [null, undefined, {}, ""]) {
    assert.deepEqual(describeError(empty), { category: "other", code: null, text: "操作没完成，请稍后再试", action: "view_detail", actionLabel: "查看详细原因", raw: "" }, String(empty));
  }
  assert.equal(describeError("x").raw, "x", "原文原样留给「查看详细原因」");
});

test("服务端补码：认得的码原样给，只有原文时给这一类的代表码，认不出给 null", () => {
  assert.equal(errorCodeOf(withCode("CAPTCHA_REQUIRED", "boom")), "CAPTCHA_REQUIRED");
  assert.equal(errorCodeOf(withCode("KEY_INVALID_OR_DENIED")), "KEY_INVALID_OR_DENIED", "§5 问题码");
  assert.equal(errorCodeOf("fetch failed"), "NETWORK_UNREACHABLE");
  assert.equal(errorCodeOf(withCode("SOMETHING_NEW", "Unauthorized")), "AUTHENTICATION_FAILED", "不认识的码按原文");
  assert.equal(errorCodeOf({ status: 503 }), "NOT_READY");
  assert.equal(errorCodeOf("boom"), null);
  assert.equal(errorCodeOf(null), null);
  assert.equal(errorCodeOf("boom", "OWN_STATION_UNAVAILABLE"), "OWN_STATION_UNAVAILABLE", "认不出时用调用方给的兜底码");
  assert.equal(errorCodeOf("fetch failed", "OWN_STATION_UNAVAILABLE"), "NETWORK_UNREACHABLE", "认得出就不用兜底码");
  assert.equal(errorCodeOf({ code: 20, message: "boom" }), null, "数字码不往外带");
  // 补上的码回到原来那一类：界面拿码归类，和直接看原文一样
  const samples = { auth: "Unauthorized", permission: "Forbidden", captcha: "captcha required", unreachable: "fetch failed",
    busy: "Too Many Requests", unreadable: "invalid json", own_feature_off: "DataExport disabled",
    changed: { status: 409 }, not_found: { status: 404 }, not_ready: { status: 503 } };
  for (const [category, sample] of Object.entries(samples)) {
    assert.equal(describeError(sample).category, category, category);
    assert.equal(describeError({ code: errorCodeOf(sample) }).category, category, `${category} 的代表码`);
  }
});

test("几个渠道的选择互相冲突和「这条已经变了」分开说：前者在原处改，不给刷新", () => {
  assert.deepEqual(describeError({ code: "GROUP_CONFLICT", reason: "同一 Key 的使用范围、时区或授权选择冲突" }),
    { category: "changed", code: "GROUP_CONFLICT", text: "几个渠道的选择互相冲突，请改好后重新预览", action: null, actionLabel: "",
      raw: "同一 Key 的使用范围、时区或授权选择冲突" });
  assert.equal(errorText({ code: "STALE_SCOPE" }), "这条已经变了，刷新后再看。");
  assert.equal(describeError({ code: "STALE_SCOPE" }).action, "refresh");
  assert.equal(errorText({ code: "MISSING_CONFIGURATION", message: "缺少站点地址" }), "地址或登录信息没填全，请到上游里补上");
});

test("只要一句话和「没做成：原因。」", () => {
  assert.equal(errorText({ code: "TIME_RANGE_TOO_LONG" }), "一次最多查 31 天");
  assert.equal(errorText({ code: "CHANNEL_CONFLICT" }, { params: { channel: "出口一" } }), "渠道「出口一」同时绑了两把 Key");
  assert.equal(failureText("保存失败", { code: "INVALID_TOKEN" }), "保存失败：登录信息不对或过期了。");
  assert.equal(failureText("刷新失败", "fetch failed"), "刷新失败：连不上这个地址，检查地址有没有填错；还不行请联系技术同事。");
  assert.equal(failureText("保存失败", null), "保存失败：操作没完成，请稍后再试。");
  // 已经归类好的那句（上游账单页存的是归类后的话）也走同一个句式
  assert.equal(failureSentence("读不到上游账单", "这条已经变了，刷新后再看。"), "读不到上游账单：这条已经变了，刷新后再看。");
  assert.equal(failureSentence("读不到上游账单", "找不到这个上游"), "读不到上游账单：找不到这个上游。");
});

test("表单漏填写「请填X」（§8.2）", () => {
  assert.equal(requiredText("访问令牌"), "请填访问令牌");
  assert.equal(requiredText("Key"), "请填 Key");
  assert.deepEqual(requiredRule("Key"), { required: true, message: "请填 Key" });
});

test("「没做成：原因。」不出现两个句号或问号接句号", () => {
  const bad = [...CODES, ...RECONCILIATION_ISSUE_CODES].map((code) => [code, failureText("保存失败", { code })]).filter(([, text]) => /[。？！][。？！]$/.test(text));
  assert.deepEqual(bad, []);
});

test("Object.prototype 上的名字不当错误码", () => {
  for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.doesNotThrow(() => describeError({ code }), code);
    assert.equal(describeError({ code }).category, "other", code);
  }
});

test("asSentence: 补上句号，已经带了句号、问号、叹号的不再加", () => {
  assert.equal(asSentence("已保存"), "已保存。");
  for (const text of ["已保存。", "要删除吗？", "好了！"]) assert.equal(asSentence(text), text);
});

test("refreshOneText / refreshAllText: 刷新之后的提示，读不到余额的按归类写原因", () => {
  const done = workflowActionMeta("refresh").done;
  assert.deepEqual(refreshOneText("A 站", { ok: true, remaining: 1 }), { ok: true, text: `${done}「A 站」` });
  assert.deepEqual(refreshOneText("A 站", undefined), { ok: true, text: `${done}「A 站」` });
  assert.deepEqual(refreshOneText("A 站", { ok: false, code: "INVALID_TOKEN", error: "401" }), { ok: false, text: "读不到「A 站」的余额：登录信息不对或过期了。" });

  const bad = { ok: false, code: "INVALID_TOKEN" };
  // 归档的、自营站点的和「需处理」一样不算
  const stations = [
    { balance: { ok: true } }, { balance: bad }, { balance: bad }, { balance: bad, archivedAt: "2026-10-01" },
    { balance: bad, isOwn: true }, {}, null,
  ];
  assert.deepEqual(refreshAllText(stations), { failed: 2, text: `${done}，其中 2 个上游读不到余额，见「需处理」` });
  assert.deepEqual(refreshAllText([]), { failed: 0, text: done });
  assert.deepEqual(refreshAllText(undefined), { failed: 0, text: done });
});

test("consoleErrorText: 控制台自己的接口出错不按读上游的几类关键词猜，认得的码照常说", () => {
  const apiError = (message, extra = {}) => Object.assign(new Error(message), extra);
  // 浏览器连不上控制台：fetch 直接报 TypeError（各浏览器原文不同）
  for (const message of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])
    assert.equal(consoleErrorText(new TypeError(message)), CONSOLE_UNREACHABLE);
  // 认得的码照常说
  assert.equal(consoleErrorText(apiError("原密码不对", { code: "WRONG_PASSWORD", status: 400 })), "原密码不对");
  assert.equal(consoleErrorText(apiError("x", { code: "DEFAULT_PASSWORD_CHANGE_REQUIRED", status: 403 })), "请先修改初始密码");
  // 原文里带 timeout、network，或者代理给的 502/504：不说成「连不上这个地址」「上游繁忙」
  assert.equal(consoleErrorText(apiError("db write timeout", { status: 500 })), ERROR_CATEGORIES.other.text);
  assert.equal(consoleErrorText(apiError("socket hang up: network", { status: 500 })), ERROR_CATEGORIES.other.text);
  for (const status of [502, 503, 504]) assert.equal(consoleErrorText(apiError(`HTTP ${status}`, { status })), ERROR_CATEGORIES.not_ready.text);
  assert.equal(consoleErrorText(apiError("没有启用的日报通知渠道", { status: 400 })), ERROR_CATEGORIES.other.text);
  // 不认得的码不当成码
  assert.equal(consoleErrorText(apiError("x", { code: "SOMETHING_NEW", status: 400 })), ERROR_CATEGORIES.other.text);
  assert.equal(consoleFailureText("保存失败", apiError("db write timeout", { status: 500 })), `保存失败：${ERROR_CATEGORIES.other.text}。`);
  // 对照：同样的原文按读上游的归类会说成「连不上这个地址」
  assert.equal(errorText(apiError("db write timeout", { status: 500 })), ERROR_CATEGORIES.unreachable.text);
});

test("§8.2 通知方式那张表：每个码的那一句，下一步按钮都不跳上游资源", () => {
  const table = {
    NOTIFY_AUTH_FAILED: ["auth", "通知方式的地址、Token 或密钥不对，请编辑后重新填", ""],
    NOTIFY_KEYWORD_MISSING: ["other", "机器人设了关键词，消息里没有：请把关键词设成「炬元」", ""],
    NOTIFY_REJECTED: ["other", "对方没收下这条消息，请检查发件人、收件人、群或机器人的设置", ""],
    NOTIFY_BUSY: ["busy", "对方暂时繁忙，请稍后再试", ""],
    NOTIFY_CONFIG_MISSING: ["other", "这个通知方式没填全，请编辑后补上", ""],
    SMTP_AUTH_FAILED: ["auth", "邮箱的用户名或密码不对，请检查后重新填", ""],
    NOTIFY_TYPE_UNSUPPORTED: ["other", "不支持这种通知方式", ""],
    NOTIFY_NOT_FOUND: ["not_found", "找不到这个通知方式", ""],
    REPORT_NO_CHANNELS: ["other", "没有能发日报的通知方式，请先添加或启用一个", ""],
    NOTIFY_SEND_FAILED: ["other", "没发出去，请把详细原因发给技术同事", "查看详细原因"],
  };
  for (const [code, expected] of Object.entries(table)) assert.deepEqual(shown({ code }), expected, code);
  // 连不上照用上面「连不上」那句
  assert.deepEqual(shown({ code: "NETWORK_UNREACHABLE" }), ["unreachable", "连不上这个地址，检查地址有没有填错；还不行请联系技术同事", ""]);
});

test("deliveryErrorCode：没连上对方算连不上（ECONNRESET 不原样带出）→ 认得的码原样用 → 其余是「没发出去」，不按读上游的关键词猜", () => {
  assert.equal(deliveryErrorCode(withCode("SMTP_TLS_REQUIRED")), "SMTP_TLS_REQUIRED");
  assert.equal(deliveryErrorCode(withCode("NOTIFY_AUTH_FAILED", "Unauthorized")), "NOTIFY_AUTH_FAILED");
  // Node 的网络错误码：net / tls 直接在 code 上，fetch 的在 cause 里；ECONNRESET 在 CODES 里也归成 NETWORK_UNREACHABLE
  assert.equal(deliveryErrorCode(withCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9")), "NETWORK_UNREACHABLE");
  assert.equal(deliveryErrorCode(withCode("ECONNRESET", "read ECONNRESET")), "NETWORK_UNREACHABLE");
  assert.equal(deliveryErrorCode(Object.assign(new TypeError("fetch failed"), { cause: withCode("ENOTFOUND") })), "NETWORK_UNREACHABLE");
  assert.equal(deliveryErrorCode(Object.assign(new TypeError("fetch failed"), { cause: withCode("UND_ERR_CONNECT_TIMEOUT") })), "NETWORK_UNREACHABLE");
  assert.equal(deliveryErrorCode(Object.assign(new TypeError("Failed to parse URL from x"), { cause: withCode("ERR_INVALID_URL") })), "NETWORK_UNREACHABLE");
  for (const code of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"])
    assert.equal(deliveryErrorCode(withCode(code)), "NETWORK_UNREACHABLE", code);
  // 超时（AbortController）
  assert.equal(deliveryErrorCode(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), "NETWORK_UNREACHABLE");
  // 读上游那套会把这几句说成上游的登录信息过期、没有权限、上游繁忙；通知方式不这样猜
  for (const raw of ["Unauthorized", "Forbidden: bot was blocked by the user", "Too Many Requests"]) {
    assert.equal(deliveryErrorCode(new Error(raw)), "NOTIFY_SEND_FAILED", raw);
    assert.notEqual(errorText({ code: deliveryErrorCode(new Error(raw)) }), errorText(raw), raw);
  }
  // 数字码、认不出的码、空
  assert.equal(deliveryErrorCode(withCode(20, "weird")), "NOTIFY_SEND_FAILED");
  assert.equal(deliveryErrorCode(withCode("SOMETHING_ELSE")), "NOTIFY_SEND_FAILED");
  assert.equal(deliveryErrorCode(null), "NOTIFY_SEND_FAILED");
});

test("connectionFailed：读上游和通知方式发送共用的「没连上对方」", () => {
  const yes = [
    new DOMException("This operation was aborted", "AbortError"),
    Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
    // fetch 没带码的两种说法：没连上、中途断掉
    new TypeError("fetch failed"),
    new TypeError("terminated"),
    withCode("EPIPE"),
    Object.assign(new TypeError("fetch failed"), { cause: withCode("UND_ERR_SOCKET") }),
    // 几个地址都连不上：码只在 AggregateError 的 errors 里
    Object.assign(new TypeError("x"), { cause: new AggregateError([withCode("ECONNREFUSED", "connect ECONNREFUSED ::1:9")], "") }),
  ];
  for (const error of yes) assert.equal(connectionFailed(error), true, String(error?.message || error?.name));
  // 请求根本没发出去（令牌里混进中文字符）、对方回了话、字符串、空，都不算
  const no = [
    new TypeError("Cannot convert argument to a ByteString because the character at index 7 has a value of 20320 which is greater than 255."),
    withCode("NOTIFY_AUTH_FAILED", "Unauthorized"), withCode(20, "weird"), "fetch failed", null, undefined,
  ];
  for (const error of no) assert.equal(connectionFailed(error), false, String(error?.message ?? error));
});

test("errorDetail：原文后面补上底层原因，码已经在说明里的不重复写", () => {
  assert.equal(errorDetail(new Error("HTTP 400")), "HTTP 400");
  assert.equal(errorDetail("原文"), "原文");
  assert.equal(errorDetail(null), "");
  assert.equal(errorDetail(Object.assign(new TypeError("fetch failed"), { cause: withCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9") })),
    "fetch failed（connect ECONNREFUSED 127.0.0.1:9）");
  assert.equal(errorDetail(Object.assign(new TypeError("fetch failed"), { cause: withCode("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate") })),
    "fetch failed（UNABLE_TO_VERIFY_LEAF_SIGNATURE：unable to verify the first certificate）");
  const many = Object.assign(new AggregateError([withCode("ECONNREFUSED", "connect ECONNREFUSED ::1:9"), withCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9")], ""), { code: "ECONNREFUSED" });
  assert.equal(errorDetail(Object.assign(new TypeError("fetch failed"), { cause: many })),
    "fetch failed（ECONNREFUSED；connect ECONNREFUSED ::1:9；connect ECONNREFUSED 127.0.0.1:9）");
  // 直接抛出来的 AggregateError（net 连几个地址都没连上）：原文是空的，写它的名字，后面跟各自的原因
  assert.equal(errorDetail(Object.assign(new AggregateError([withCode("ECONNREFUSED", "connect ECONNREFUSED ::1:25"), withCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25")], ""), { code: "ECONNREFUSED" })),
    "AggregateError（connect ECONNREFUSED ::1:25；connect ECONNREFUSED 127.0.0.1:25）");
  assert.equal(errorDetail(new Error("")), "Error");
  // 我们自己给的码不写进原文
  assert.equal(errorDetail(withCode("NOTIFY_AUTH_FAILED", "Unauthorized")), "Unauthorized");
  // cause 不是对象、空对象：照旧只有原文
  assert.equal(errorDetail(Object.assign(new Error("x"), { cause: "why" })), "x");
  assert.equal(errorDetail(Object.assign(new Error("x"), { cause: {} })), "x");
});

test("服务端给前端的结果（{ error, errorCode }）整个传进来也按码归类，原文照旧只进详细原因", () => {
  const profit = { error: "用户「newbie」的身份没读到，收入和利润暂时算不出", errorCode: "OWN_INCOME_UNCONFIRMED" };
  const note = describeError(profit);
  assert.equal(note.code, "OWN_INCOME_UNCONFIRMED");
  assert.equal(note.text, "用户身份或转售记录没读全");
  assert.equal(note.raw, profit.error);
  assert.equal(failureSentence("利润暂时算不出", note.text), "利润暂时算不出：用户身份或转售记录没读全。");
  // code 和 errorCode 都有时以 code 为准；原型链上的名字不算码
  assert.equal(describeError({ code: "NETWORK_UNREACHABLE", errorCode: "OWN_INCOME_UNCONFIRMED", error: "x" }).code, "NETWORK_UNREACHABLE");
  assert.equal(describeError({ errorCode: "constructor", error: "x" }).category, "other");
});


test("ownStationErrorCode：读自营站点没成时，通用的繁忙、列表在变、连不上、连接被重置和认不出的说「自营站点暂时读不到」，内容不对的另说，有自己那句话的照旧", () => {
  const coded = (code) => Object.assign(new Error("raw"), { code });
  for (const code of ["UPSTREAM_REQUEST_FAILED", "UPSTREAM_LIST_CHANGED", "UPSTREAM_STAT_UNAVAILABLE", "NETWORK_UNREACHABLE", "ECONNRESET"]) {
    assert.equal(ownStationErrorCode(coded(code)), "OWN_STATION_UNAVAILABLE", code);
  }
  // 没有码、原文也认不出的
  assert.equal(ownStationErrorCode(new Error("something odd happened")), "OWN_STATION_UNAVAILABLE");
  // 没有码、按原文认出是繁忙或连不上的
  assert.equal(ownStationErrorCode(new Error("Service Unavailable")), "OWN_STATION_UNAVAILABLE");
  assert.equal(ownStationErrorCode(new Error("connect ECONNREFUSED 10.0.0.1:443")), "OWN_STATION_UNAVAILABLE");
  // 内容不对
  assert.equal(ownStationErrorCode(coded("UPSTREAM_RESPONSE_INVALID")), "OWN_STATION_RESPONSE_INVALID");
  assert.equal(ownStationErrorCode(coded("CHANNEL_CATALOGUE_INVALID")), "OWN_STATION_RESPONSE_INVALID");
  assert.equal(ownStationErrorCode(new Error("Unexpected token < in JSON at position 0")), "OWN_STATION_RESPONSE_INVALID");
  assert.equal(errorText({ code: "OWN_STATION_RESPONSE_INVALID" }), "自营站点返回的内容不对，请把详细原因发给技术同事");
  // 有自己那句话的照旧
  for (const code of ["AUTHENTICATION_FAILED", "UPSTREAM_AUTH_DENIED", "OWN_FEATURE_DISABLED", "ENDPOINT_MISMATCH", "UPSTREAM_FEATURE_UNSUPPORTED",
    "UPSTREAM_LIST_TOO_LARGE", "MISSING_CONFIGURATION", "OWN_STATION_UNSET", "REPORT_NO_CHANNELS"]) {
    assert.equal(ownStationErrorCode(coded(code)), code, code);
  }
});
