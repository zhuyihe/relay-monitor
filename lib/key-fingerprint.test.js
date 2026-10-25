import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAgentKeys, fingerprintKey, maskKey, normalizeKey, splitChannelKeys, KEYLESS_CHANNEL_TYPES } from "./key-fingerprint.js";

const vectors = JSON.parse(readFileSync(new URL("./key-fingerprint.vectors.json", import.meta.url), "utf8"));

test("派生：令牌和指纹密钥和测试向量一致", () => {
  const derived = deriveAgentKeys(vectors.secret);
  assert.equal(derived.token, vectors.token);
  assert.equal(derived.fingerprintKey.toString("hex"), vectors.fingerprintKeyHex);
});

test("派生：首尾空白不算，太短不起来", () => {
  assert.equal(deriveAgentKeys(`  ${vectors.secret}\n`).token, vectors.token);
  assert.throws(() => deriveAgentKeys("x".repeat(31)), { code: "SECRET_TOO_SHORT" });
  assert.throws(() => deriveAgentKeys(""), { code: "SECRET_TOO_SHORT" });
  assert.throws(() => deriveAgentKeys(undefined), { code: "SECRET_TOO_SHORT" });
  assert.doesNotThrow(() => deriveAgentKeys("x".repeat(32)));
});

test("派生：换一串 secret，令牌和指纹密钥都不同；令牌推不出指纹密钥", () => {
  const a = deriveAgentKeys("a".repeat(32)), b = deriveAgentKeys("b".repeat(32));
  assert.notEqual(a.token, b.token);
  assert.notDeepEqual(a.fingerprintKey, b.fingerprintKey);
  assert.notEqual(Buffer.from(a.token, "base64url").toString("hex"), a.fingerprintKey.toString("hex"));
  assert.equal(a.token.length, 43);
});

for (const [index, vector] of vectors.keys.entries()) {
  test(`向量 ${index}：规范化、打码、指纹`, () => {
    const { fingerprintKey: fk } = deriveAgentKeys(vectors.secret);
    assert.equal(normalizeKey(vector.input), vector.normalized);
    assert.equal(maskKey(vector.input), vector.mask);
    assert.equal(fingerprintKey(vector.input, fk), vector.fingerprint);
    assert.equal(vector.fingerprint.length, 22);
  });
}

test("打码：不足 16 位不露字符，16 位起前 4 后 4", () => {
  assert.equal(maskKey("sk-0123456789abcde"), "…");
  assert.equal(maskKey("0123456789abcde"), "…");
  assert.equal(maskKey("0123456789abcdef"), "0123…cdef");
  assert.equal(maskKey(""), "…");
  assert.equal(maskKey(null), "…");
});

test("规范化：只去一个小写 sk- 前缀", () => {
  assert.equal(normalizeKey("sk-sk-x"), "sk-x");
  assert.equal(normalizeKey("SK-x"), "SK-x");
  assert.equal(normalizeKey(" sk- x "), " x");
});

for (const item of vectors.splits) {
  test(`拆法：${item.name}`, () => {
    assert.deepEqual(splitChannelKeys(item.raw, { isMultiKey: item.multi }), item.expected);
  });
}

test("拆法：具体结果", () => {
  assert.deepEqual(splitChannelKeys("a\r\nb\n\nc", { isMultiKey: true }), { keys: ["a", "b", "c"], keyless: false });
  assert.deepEqual(splitChannelKeys("a\nb", { isMultiKey: false }), { keys: ["a\nb"], keyless: false });
  assert.deepEqual(splitChannelKeys('["a"," b ",""]', { isMultiKey: true }), { keys: ["a", "b"], keyless: false });
  assert.deepEqual(splitChannelKeys('["a",{"k":1}]', { isMultiKey: true }), { keys: [], keyless: true });
  assert.deepEqual(splitChannelKeys("", { isMultiKey: true }), { keys: [], keyless: false });
  assert.deepEqual(splitChannelKeys("AK|SK", {}), { keys: [], keyless: true });
});

test("keyless 类型集合：核过 New API v1.0.0-rc.46 的类型号（Baidu 15、Xunfei 18、Tencent 23、AWS 33、Jimeng 51、Codex 57）", () => {
  assert.deepEqual([...KEYLESS_CHANNEL_TYPES], [15, 18, 23, 33, 51, 57]);
  assert.ok(!KEYLESS_CHANNEL_TYPES.includes(41), "Vertex 的 api_key 模式是一把普通的 key，靠串的样子认");
  assert.ok(!KEYLESS_CHANNEL_TYPES.includes(1));
});
