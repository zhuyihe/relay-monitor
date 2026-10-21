import test from "node:test";
import assert from "node:assert/strict";
import { endpointKey, sameEndpoint } from "./endpoint.js";

test("sameEndpoint: 协议、主机、端口都相同才算同一个站点，只改路径不算换站点", () => {
  assert.equal(sameEndpoint("https://api.example.com", "https://api.example.com/v1/"), true);
  assert.equal(sameEndpoint("https://API.example.com", "https://api.example.com:443"), true);
  assert.equal(sameEndpoint("https://api.example.com", "https://evil.example.com"), false);
  assert.equal(sameEndpoint("https://api.example.com", "http://api.example.com"), false);
  assert.equal(sameEndpoint("https://api.example.com", "https://api.example.com:8443"), false);
  // 账号写在地址里的也只看站点
  assert.equal(sameEndpoint("https://u:p@api.example.com/x", "https://api.example.com"), true);
  // SMTP 只填主机名
  assert.equal(sameEndpoint("smtp.qq.com", "SMTP.QQ.COM"), true);
  assert.equal(sameEndpoint("smtp.qq.com", "smtp.163.com"), false);
  // Webhook 换了路径里的令牌但站点没变，算同一个站点（令牌本身就是新填的）
  assert.equal(sameEndpoint("https://oapi.dingtalk.com/robot/send?access_token=a", "https://oapi.dingtalk.com/robot/send?access_token=b"), true);
  assert.equal(endpointKey(""), "");
  assert.equal(endpointKey("  "), "");
  assert.equal(sameEndpoint("", ""), true);
});
