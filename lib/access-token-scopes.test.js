import assert from "node:assert/strict";
import test from "node:test";
import { ACCESS_TOKEN_ERROR_CODES, ACCESS_TOKEN_SCOPES, accessTokenScopeText, isAccessTokenError, missingScopeOf } from "./access-token-scopes.js";

test("权限清单：自营站点六项、上游三项；说明里的文字从这张表生成，没有别的来源（用语规范 §5.2）", () => {
  assert.equal(accessTokenScopeText("own"), "profile:read、channel:read、log:read、user:read、usage:read、option:read");
  assert.equal(accessTokenScopeText("upstream"), "profile:read、api_key:read、usage:read");
  assert.equal(accessTokenScopeText(), accessTokenScopeText("own"), "不是上游的都按自营站点");
  // 说明只读这张表：表里每一项都出现在说明里，说明里没有表以外的权限
  for (const side of ["own", "upstream"]) assert.deepEqual(accessTokenScopeText(side).split("、"), ACCESS_TOKEN_SCOPES[side].map((item) => item.scope));
});

test("New API 在 message 里点出少的那一项：取最后一个「名字:动作」，认不出为空", () => {
  assert.equal(missingScopeOf("The access token lacks the required permission: channel:read"), "channel:read");
  assert.equal(missingScopeOf("令牌缺少所需权限：api_key:read"), "api_key:read");
  assert.equal(missingScopeOf("The access token lacks the required permission: log:read."), "log:read");
  assert.equal(missingScopeOf("没有权限"), "");
  assert.equal(missingScopeOf(null), "");
});

test("只认两个码", () => {
  assert.deepEqual([...ACCESS_TOKEN_ERROR_CODES], ["ACCESS_TOKEN_LEGACY_RETIRED", "ACCESS_TOKEN_SCOPE_DENIED"]);
  assert.equal(isAccessTokenError("ACCESS_TOKEN_SCOPE_DENIED"), true);
  assert.equal(isAccessTokenError("ACCESS_TOKEN_EXPIRED"), false);
  assert.equal(isAccessTokenError("UPSTREAM_AUTH_DENIED"), false);
});
