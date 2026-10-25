import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveAgentKeys, fingerprintKey, maskKey, normalizeKey, secretWeakness, splitChannelKeys, KEYLESS_CHANNEL_TYPES, SECRET_PROBLEM_TEXT, WEAK_SECRET_TEXT } from "./key-fingerprint.js";

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

test("弱 secret 启动就拒：太短、不同字符少于 10 个、整串是同一段重复、全数字、全小写、全大写、连着 8 位的递增递减、键盘排；openssl rand -base64 32 / -hex 32 / -hex 16 的样子过", () => {
  assert.equal(secretWeakness("x".repeat(31)), "SECRET_TOO_SHORT");
  for (const weak of ["x".repeat(32), "password".repeat(4), "12345678901234567890123456789012", "abcdefghijklmnopqrstuvwxyzabcdef", "abcdefghijklmnopqrstuvwxyzabcdefg",
    "Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1", "aA1bB2cC3dD4eE5aA1bB2cC3dD4eE5aA1bB2cC3dD4eE5", "0123456789012345678901234567890123",
    "abcdefghijklmnopqrstuvwxyz012345", "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH", "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zq", "Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE01234567",
    "qwertyuiopasdfghjklzxcvbnm1234567890", "Kd83Lm20QweRtYx9zPa5vBn7cJf4hGs2"]) {
    assert.equal(secretWeakness(weak), "SECRET_TOO_WEAK", weak);
    assert.throws(() => deriveAgentKeys(weak), { code: "SECRET_TOO_WEAK", message: WEAK_SECRET_TEXT });
  }
  // openssl rand -hex 32（64 个字符）、-hex 16（32 个字符）的样子：只有 0-9a-f，不能被误拒
  const hex32 = ["3f9a1c7e5b2d84a06c1e9f3b7a5d2c80e4b6a19f3d7c5e2b8a0f4d6c1e9b3a75", "d41d8cd98f00b204e9800998ecf8427e5a7c3e19b0f6d2a48c1e7f35b9d0a62c"];
  const hex16 = ["4e2b9a07c1d35f68a0b7e9c4d2f1836a", "c0ffee4b1d7a29f3085e6a4d9b2c71f0"];
  for (const secret of [...hex32, ...hex16]) assert.equal(secretWeakness(secret), null, secret);
  for (const strong of ["Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE", "8kQ1x0Wl3uZc5mRn7oVt9yXe2bFh4gJd6sA/pLi+K0w=", Buffer.from("a very ordinary 32 byte sentence!!").toString("base64"), vectors.secret]) {
    assert.equal(secretWeakness(strong), null, strong);
  }
  assert.equal(secretWeakness("a".repeat(15) + "Zq3v9LmX2rT7wYk1N"), null, "字符种类够多、没有长递增段");
  assert.equal(secretWeakness(`  ${"Zq3v9LmX2rT7wYk1NcB8dHfJ5sGaP4uE"}\n`), null);
  assert.equal(WEAK_SECRET_TEXT, "令牌太弱，请用 openssl rand -base64 32 生成");
  assert.ok(!/Zq3v|x{8}/.test(WEAK_SECRET_TEXT));
});

test("原因码 → 文案只有一张表：太短、太弱各一句，派生函数的报错就是这句（读取服务和控制台说的一样）", () => {
  assert.deepEqual(Object.keys(SECRET_PROBLEM_TEXT).sort(), ["SECRET_TOO_SHORT", "SECRET_TOO_WEAK"]);
  assert.equal(SECRET_PROBLEM_TEXT.SECRET_TOO_SHORT, "令牌太短（至少 32 个字符）");
  assert.equal(SECRET_PROBLEM_TEXT.SECRET_TOO_WEAK, WEAK_SECRET_TEXT);
  assert.throws(() => deriveAgentKeys("short"), { message: SECRET_PROBLEM_TEXT.SECRET_TOO_SHORT });
  assert.throws(() => deriveAgentKeys("x".repeat(40)), { message: SECRET_PROBLEM_TEXT.SECRET_TOO_WEAK });
});
