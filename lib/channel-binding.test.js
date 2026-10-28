import test from "node:test";
import assert from "node:assert/strict";
import { bindableKeys, hostOf, unboundChannelsFor } from "./channel-binding.js";

test("地址只写主机（带端口），没写协议也行，空的是空", () => {
  assert.equal(hostOf("https://api.example.com/v1"), "api.example.com");
  assert.equal(hostOf("127.0.0.1:3000/x"), "127.0.0.1:3000");
  assert.equal(hostOf(""), "");
  assert.equal(hostOf(null), "");
});

test("还能绑的 Key：启用的、名字不重复的、没被别的渠道绑着的；Sub2API 名字重复也算", () => {
  const tokens = [{ id: 1, name: "a", status: 1 }, { id: 2, name: "b", status: 2 }, { id: 3, name: "c", status: 1 }, { id: 4, name: "c", status: 1 }, { id: 5, name: "d", status: 1 }];
  assert.deepEqual(bindableKeys(tokens, [5]).map((token) => token.id), [1]);
  assert.deepEqual(bindableKeys(tokens, [], { platform: "sub2api" }).map((token) => token.id), [1, 3, 4, 5]);
  assert.deepEqual(bindableKeys(null), []);
});

test("渠道的排法：只列还没绑的，地址对得上这个上游的排最前，其余顺序不变", () => {
  const channels = [{ channelId: 1, ruleId: "r", suggestedUpstreamId: null }, { channelId: 2, ruleId: null, suggestedUpstreamId: "u2" }, { channelId: 3, ruleId: null, suggestedUpstreamId: "u1" }, { channelId: 4, ruleId: null, suggestedUpstreamId: null }];
  assert.deepEqual(unboundChannelsFor(channels, "u1").map((item) => item.channelId), [3, 2, 4]);
});
