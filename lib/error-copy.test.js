import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ERROR_CATEGORIES, describeError, errorText, failureSentence, failureText, requiredRule, requiredText } from "./error-copy.js";
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
    auth: ["AUTHENTICATION_FAILED", "INVALID_TOKEN", "TOKEN_EXPIRED", "SAVED_AUTHORIZATION_UNAVAILABLE", "AUTHORIZATION_UNVERIFIED", "AUTHORIZATION_UPDATE_REQUIRED", "CREDENTIAL_UPDATE_UNCONFIRMED"],
    permission: ["UPSTREAM_AUTH_DENIED", "KEY_METADATA_UNAVAILABLE", "OWN_IDENTITY_UNVERIFIED", "OWN_CHANNEL_UNAVAILABLE"],
    unreachable: ["NETWORK_UNREACHABLE", "ENDPOINT_MISMATCH", "ECONNRESET", "INVALID_BASE_URL"],
    busy: ["KEY_PROBE_UNAVAILABLE", "UPSTREAM_STAT_UNAVAILABLE", "UPSTREAM_REQUEST_FAILED", "UPSTREAM_WINDOW_PENDING"],
    unreadable: ["UPSTREAM_KEY_CATALOGUE_INVALID", "CHANNEL_CATALOGUE_INVALID"],
    changed: ["PREVIEW_BASIS_CHANGED", "PREVIEW_REQUIRED", "EFFECTIVE_PREVIEW_CHANGED", "RESOURCE_CHANGED", "OPERATION_CHANGED", "AUTHORIZATION_CHANGED", "CHANNEL_SOURCE_CHANGED", "STALE_SCOPE", "GROUP_CONFLICT", "OWN_STATION_CHANGED"],
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
  assert.deepEqual(issueOf({ code: "ACCOUNT_IDENTITY_CHANGED" }), ["issue", "SOURCE_BINDING_UNCONFIRMED", "上游账号或自营站点有变化", "review_source", "去确认"]);
  assert.deepEqual(issueOf({ code: "RULE_OWN_STATION_CONFLICT" }).slice(1, 2), ["SOURCE_BINDING_UNCONFIRMED"]);
  assert.deepEqual(issueOf({ code: "IDENTITY_UNVERIFIED" }), ["issue", "COST_OWNER_UNVERIFIED", "还没确认这把 Key 属于哪个上游账号", "verify_identity", "测试读取"]);
  assert.deepEqual(issueOf({ code: "BILLING_CAPABILITY_UNVERIFIED" }), ["issue", "UPSTREAM_CAPABILITY_UNVERIFIED", "还没确认能读到这个上游的完整账单", "verify_capability", "测试读取"]);
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
  assert.equal(describeError("403 Unauthorized").category, "permission");
  assert.equal(describeError("token expired, request timeout").category, "auth");
  assert.equal(describeError("timeout from 502 gateway").category, "unreachable");
  assert.equal(describeError("502 invalid json").category, "busy");
});

test("原文里的关键词", () => {
  const table = {
    captcha: ["需要人机验证", "Captcha required", "turnstile token missing", "Cloudflare challenge"],
    own_feature_off: ["数据看板未开启", "DataExport is disabled"],
    permission: ["HTTP 403", "Forbidden", "permission denied", "insufficient privileges", "无权访问", "没有读取权限", "权限不足"],
    auth: ["401", "Unauthorized", "unauthorised", "未授权", "访问令牌无效", "令牌已过期", "token invalid", "JWT expired", "jwt malformed", "登录已过期", "登录失效", "密码错误", "Invalid credentials"],
    unreachable: ["timeout", "Request timed out", "This operation was aborted", "connect ECONNREFUSED 127.0.0.1:3000", "read ECONNRESET", "getaddrinfo ENOTFOUND relay.local",
      "EAI_AGAIN", "fetch failed", "certificate has expired", "network error", "请求超时", "连接被拒绝", "无法连接", "Invalid URL", "Failed to parse URL from x"],
    busy: ["429", "HTTP 500", "502", "503", "504", "Too Many Requests", "rate limit exceeded", "Bad Gateway", "Service Unavailable", "系统繁忙"],
    unreadable: ["Unexpected token < in JSON at position 0", "is not valid JSON", "响应格式不对", "格式不正确", "无效数据", "未返回有效数据"],
    other: ["boom", ""],
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
  assert.deepEqual(describeError(new Error("HTTP 401")), { category: "auth", code: null, text: "登录信息不对或过期了", action: "update_authorization", actionLabel: "更新登录信息", raw: "HTTP 401" });
  assert.deepEqual(describeError({ error: "上游返回 429", code: "UPSTREAM_REQUEST_FAILED" }),
    { category: "busy", code: "UPSTREAM_REQUEST_FAILED", text: "上游暂时繁忙，系统稍后会自动再读", action: null, actionLabel: "", raw: "上游返回 429" });
  assert.equal(describeError({ reason: "令牌已过期", message: "ignored" }).raw, "令牌已过期", "reason 先于 message");
  assert.equal(describeError({ message: "m", error: "e" }).raw, "m");
  for (const empty of [null, undefined, {}, ""]) {
    assert.deepEqual(describeError(empty), { category: "other", code: null, text: "操作没完成，请稍后再试", action: "view_detail", actionLabel: "查看详细原因", raw: "" }, String(empty));
  }
  assert.equal(describeError("x").raw, "x", "原文原样留给「查看详细原因」");
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
