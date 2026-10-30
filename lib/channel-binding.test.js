import test from "node:test";
import assert from "node:assert/strict";
import { bindableKeys, channelChoices, defaultChannelId, hostOf, keyChoices } from "./channel-binding.js";

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

const ch = (channelId, name, extra = {}) => ({ channelId, name, address: `${name}.test`, ruleId: null, enabled: true, suggestedUpstreamId: null, ...extra });
const sample = [ch(1, "a"), ch(2, "b", { suggestedUpstreamId: "u1" }), ch(3, "c", { ruleId: "r" }), ch(4, "d", { enabled: false, suggestedUpstreamId: "u1" }), ch(5, "e", { enabled: false })];
const ids = (list) => list.map((item) => item.channelId);

test("渠道的列法：只列没绑的、已禁用的默认不列；对得上的一组在前，写标题", () => {
  const result = channelChoices(sample, "u1");
  assert.deepEqual(result.groups.map((group) => [group.title, ids(group.channels)]), [["match", [2]], ["other", [1]]]);
  assert.equal(result.disabledCount, 2);
  assert.equal(result.noMatch, false);
});

test("渠道的列法：显示已禁用的时排在各组最后；没有对得上的只有一组、不写标题，并提示没对上", () => {
  assert.deepEqual(channelChoices(sample, "u1", { showDisabled: true }).groups.map((group) => [group.title, ids(group.channels)]), [["match", [2, 4]], ["other", [1, 5]]]);
  const none = channelChoices(sample, "u9");
  assert.deepEqual(none.groups.map((group) => [group.title, ids(group.channels)]), [[null, [1, 2]]]);
  assert.equal(none.noMatch, true);
  // 对得上的只有已禁用的：没打开显示时也算没对上
  assert.equal(channelChoices([ch(4, "d", { enabled: false, suggestedUpstreamId: "u1" })], "u1").noMatch, true);
});

test("渠道的列法：搜渠道名或地址，不分大小写；搜的时候只有一组、不写标题；搜不到是空的", () => {
  const list = [ch(1, "Az-美西", { address: "hub.example.com" }), ch(2, "k7", { address: "AZ.bridge.net", suggestedUpstreamId: "u1" }), ch(3, "别的")];
  const found = channelChoices(list, "u1", { query: " az " });
  assert.deepEqual(found.groups.map((group) => [group.title, ids(group.channels)]), [[null, [2, 1]]]);
  assert.deepEqual(ids(channelChoices(list, "u1", { query: "hub.example" }).visible), [1]);
  assert.deepEqual(channelChoices(list, "u1", { query: "没有这个" }).visible, []);
  assert.equal(channelChoices(sample, "u1", { query: "e.test", showDisabled: false }).disabledCount, 1, "「已禁用的 N 个」数的是搜得到的");
});

test("默认选中：只有一个启用的渠道对得上才选；好几个或一个都对不上不选；已绑的、已禁用的不算", () => {
  assert.equal(defaultChannelId(sample, "u1"), 2);
  assert.equal(defaultChannelId([ch(1, "a", { suggestedUpstreamId: "u1" }), ch(2, "b", { suggestedUpstreamId: "u1" })], "u1"), null);
  assert.equal(defaultChannelId(sample, "u9"), null);
  assert.equal(defaultChannelId([ch(1, "a", { suggestedUpstreamId: "u1", ruleId: "r" })], "u1"), null);
  assert.equal(defaultChannelId([ch(4, "d", { enabled: false, suggestedUpstreamId: "u1" })], "u1"), null);
});

test("挑 Key 分两堆：能选的在前；不能选的带原因——不能用（New API 状态 2 已停用、3 已过期、4 额度用完；Sub2API 都是已停用）、已被别的渠道用、名字重复（几把）", () => {
  const tokens = [{ id: 1, name: "ok", status: 1 }, { id: 2, name: "off", status: 2 }, { id: 3, name: "old", status: 3 }, { id: 4, name: "empty", status: 4 }, { id: 5, name: "taken", status: 1 },
    { id: 6, name: "jy", status: 1 }, { id: 7, name: "jy", status: 1 }, { id: 8, name: "jy", status: 1 }, { id: 9, name: "jy", status: 1 }];
  const { usable, blocked } = keyChoices(tokens, new Map([[5, "高速 A"]]), { platform: "newapi" });
  assert.deepEqual(usable.map((token) => token.id), [1]);
  assert.deepEqual(blocked.map(({ token, reason }) => [token.id, reason.code, reason.channel ?? reason.count ?? null]), [[2, "DISABLED", null], [3, "EXPIRED", null], [4, "EXHAUSTED", null], [5, "USED", "高速 A"], [6, "DUPLICATE", 4], [7, "DUPLICATE", 4], [8, "DUPLICATE", 4], [9, "DUPLICATE", 4]]);
  assert.equal(blocked.find(({ reason }) => reason.code === "DUPLICATE").reason.name, "jy");
});

test("挑 Key：Sub2API 同名照旧能选、别的状态都是已停用；换 Key 时现在这把哪一堆都不列；已绑的同名 Key 写已绑在哪个渠道", () => {
  const tokens = [{ id: 1, name: "same", status: 1 }, { id: 2, name: "same", status: 1 }, { id: 3, name: "x", status: 9 }, { id: 4, name: "now", status: 1 }];
  const sub = keyChoices(tokens, new Map(), { platform: "sub2api" });
  assert.deepEqual([sub.usable.map((token) => token.id), sub.blocked.map(({ token, reason }) => [token.id, reason.code])], [[1, 2, 4], [[3, "DISABLED"]]]);
  const swap = keyChoices(tokens, new Map([[4, "高速 A"]]), { platform: "sub2api", exceptTokenId: 4 });
  assert.deepEqual([swap.usable.map((token) => token.id), swap.blocked.map(({ token }) => token.id)], [[1, 2], [3]]);
  const taken = keyChoices([{ id: 1, name: "same", status: 1 }, { id: 2, name: "same", status: 1 }], new Map([[1, "高速 A"]]), { platform: "newapi" });
  assert.deepEqual(taken.blocked.map(({ reason }) => reason.code), ["USED", "DUPLICATE"], "已绑的先写已绑在哪个渠道");
  assert.deepEqual(bindableKeys(tokens, [1], { platform: "sub2api" }).map((token) => token.id), [2, 4]);
});
