import assert from "node:assert/strict";
import test from "node:test";
import { channelKeyLines, keyRatioText } from "./channel-key-lines.js";

const key = (tokenId, tokenName, upstreamStationId = "up1") => ({ upstreamStationId, tokenId, tokenName });
const rule = (extra) => ({ createdAt: "2026-10-10T00:00:00Z", billingEffectiveFrom: Date.parse("2026-10-10T00:00:00Z"), upstreamStationId: "up1", tokenId: 1, tokenName: "oai", segments: [], ...extra });

test("channelKeyLines：一条绑定只有一段——一行，从绑定开始算的时刻起，还在用", () => {
  const lines = channelKeyLines([rule({ segments: [{ effectiveFrom: 0, effectiveTo: null, group: "a", ratio: 1.2, timingSource: "operator_confirmed", keys: [key(1, "oai")] }] })]);
  assert.deepEqual(lines, [{ fromMs: Date.parse("2026-10-10T00:00:00Z"), toMs: null, between: null, key: key(1, "oai"), group: "a", ratio: 1.2 }]);
});

test("channelKeyLines：换了一把 Key——两行，时间从早到晚；换的时刻定不出时带 between（过渡段 [a, b)，用的是新换上的那把）", () => {
  const a = Date.parse("2026-10-12T07:19:00Z"), b = Date.parse("2026-10-12T08:05:00Z");
  const lines = channelKeyLines([rule({ tokenId: 2, tokenName: "oai-2", segments: [
    { effectiveFrom: 0, effectiveTo: a, group: "a", ratio: 1.2, timingSource: "operator_confirmed", keys: [key(1, "oai")] },
    { effectiveFrom: a, effectiveTo: b, group: "a", ratio: 1.2, timingSource: "key_change_window", keys: [key(1, "oai"), key(2, "oai-2")] },
    { effectiveFrom: b, effectiveTo: null, group: "a", ratio: 1.2, timingSource: "key_change", keys: [key(2, "oai-2")] },
  ] })]);
  assert.deepEqual(lines.map((line) => [line.key.tokenName, line.fromMs, line.toMs, line.between]), [
    ["oai", Date.parse("2026-10-10T00:00:00Z"), a, null],
    ["oai-2", a, null, [a, b]],
  ]);
});

test("channelKeyLines：同一把 Key 换了倍率——多一行；重新分组（绑定换了一条、Key 没换、分组倍率一样）不多出一行", () => {
  const t = Date.parse("2026-10-12T00:00:00Z");
  const lines = channelKeyLines([
    rule({ segments: [
      { effectiveFrom: 0, effectiveTo: t, group: "a", ratio: 1.0, timingSource: "operator_confirmed", keys: [key(1, "oai")] },
      { effectiveFrom: t, effectiveTo: null, group: "a", ratio: 1.2, timingSource: "ratio_change", keys: [key(1, "oai")] },
    ] }),
    rule({ createdAt: "2026-10-15T00:00:00Z", billingEffectiveFrom: Date.parse("2026-10-15T00:00:00Z"), segments: [{ effectiveFrom: 0, effectiveTo: null, group: "a", ratio: 1.2, timingSource: "operator_confirmed", keys: [key(1, "oai")] }] }),
  ]);
  assert.deepEqual(lines.map((line) => [line.ratio, line.toMs]), [[1.0, t], [1.2, null]]);
});

test("channelKeyLines：换到另一个上游的 Key——两条绑定首尾相接，过渡段里新 Key 和新绑定第一行并成一行；没有分段的绑定退回它自己的 Key", () => {
  const a = Date.parse("2026-10-12T07:00:00Z"), b = Date.parse("2026-10-12T09:00:00Z");
  const lines = channelKeyLines([
    rule({ segments: [
      { effectiveFrom: 0, effectiveTo: a, group: "a", ratio: 1, timingSource: "operator_confirmed", keys: [key(1, "oai")] },
      { effectiveFrom: a, effectiveTo: b, group: "a", ratio: 1, timingSource: "key_change_window", keys: [key(1, "oai"), key(9, "new", "up2")] },
    ] }),
    rule({ createdAt: "2026-10-12T09:00:00Z", billingEffectiveFrom: b, upstreamStationId: "up2", tokenId: 9, tokenName: "new", segments: [] }),
  ]);
  // 新绑定没有分段（测试里偷懒）：不凭空多出一行
  assert.deepEqual(lines.map((line) => [line.key.upstreamStationId, line.key.tokenName]), [["up1", "oai"], ["up2", "new"]]);
  assert.deepEqual(lines[1].between, [a, b]);
});

test("keyRatioText：读到了写倍率；没读到时 New API 写「倍率暂时读不到」，Sub2API 本来就不给倍率、不写（不是暂时的，不能让人以为是读取问题）", () => {
  assert.equal(keyRatioText({ ratio: 1.5 }, "newapi"), "倍率 1.5");
  assert.equal(keyRatioText({ ratio: 1.5 }, "sub2api"), "倍率 1.5");
  assert.equal(keyRatioText({ ratio: null }, "newapi"), "倍率暂时读不到");
  assert.equal(keyRatioText({ ratio: null }, "sub2api"), "");
  assert.equal(keyRatioText({ ratio: null }, "sub2api-password"), "");
  assert.equal(keyRatioText({ ratio: null }, undefined), "倍率暂时读不到", "上游类型不明（目录里没有这个上游）按 New API 处理");
});
