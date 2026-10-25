import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAgentKeys, fingerprintKey, maskKey, normalizeKey, secretWeakness, splitChannelKeys, KEYLESS_CHANNEL_TYPES, WEAK_SECRET_TEXT } from "./key-fingerprint.js";

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
  assert.doesNotThrow(() => deriveAgentKeys("Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE"));
});

test("派生：换一串 secret，令牌和指纹密钥都不同；令牌推不出指纹密钥", () => {
  const a = deriveAgentKeys("Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE"), b = deriveAgentKeys("Yp4w8KnW3sU6xZj2MdC9eGgH7tFbQ5vR");
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

test("打码：不足 24 位不露字符，24 位起前 4 后 4", () => {
  assert.equal(maskKey("sk-0123456789abcdefghijklm"), "…");
  assert.equal(maskKey("0123456789abcdefghijklm"), "…");
  assert.equal(maskKey("0123456789abcdefghijklmn"), "0123…klmn");
  assert.equal(maskKey("sk-0123456789abcdefghijklmn"), "0123…klmn");
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

test("keyless 类型集合：核过 New API v1.0.0-rc.46 的类型号（Baidu 15、Xunfei 18、AWS 33、Codex 57）；腾讯 23、即梦 51 会误伤普通 Bearer Key，不在表里", () => {
  assert.deepEqual([...KEYLESS_CHANNEL_TYPES], [15, 18, 33, 57]);
  assert.ok(!KEYLESS_CHANNEL_TYPES.includes(23) && !KEYLESS_CHANNEL_TYPES.includes(51));
  assert.ok(!KEYLESS_CHANNEL_TYPES.includes(41), "Vertex 的 api_key 模式是一把普通的 key，靠串的样子认");
  assert.ok(!KEYLESS_CHANNEL_TYPES.includes(1));
});

test("弱 secret 启动就拒：太短、不同字符少于 16 个、整串是同一段重复、全数字、全小写字母；openssl rand -base64 32 的样子过", () => {
  assert.equal(secretWeakness("x".repeat(31)), "SECRET_TOO_SHORT");
  for (const weak of ["x".repeat(32), "password".repeat(4), "12345678901234567890123456789012", "abcdefghijklmnopqrstuvwxyzabcdef", "abcdefghijklmnopqrstuvwxyzabcdefg",
    "Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1", "aA1bB2cC3dD4eE5aA1bB2cC3dD4eE5aA1bB2cC3dD4eE5", "0123456789012345678901234567890123"]) {
    assert.equal(secretWeakness(weak), "SECRET_TOO_WEAK", weak);
    assert.throws(() => deriveAgentKeys(weak), { code: "SECRET_TOO_WEAK", message: WEAK_SECRET_TEXT });
  }
  for (const strong of ["Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE", "8kQ1x0Wl3uZc5mRn7oVt9yXe2bFh4gJd6sA/pLi+K0w=", Buffer.from("a very ordinary 32 byte sentence!!").toString("base64"), vectors.secret]) {
    assert.equal(secretWeakness(strong), null, strong);
  }
  assert.equal(secretWeakness(`  ${"Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE"}\n`), null);
  assert.equal(WEAK_SECRET_TEXT, "令牌太弱，请用 openssl rand -base64 32 生成");
  assert.ok(!/Zq3v|x{8}/.test(WEAK_SECRET_TEXT));
});
