import assert from "node:assert/strict";
import test from "node:test";
import { keyChangesOnDay, keyMovesOnDay } from "./profit-key-changes.js";

const H = 3600000, DAY = { startMs: 24 * H, endMs: 48 * H };
const key = (tokenId, tokenName = `k${tokenId}`) => ({ upstreamStationId: "up", tokenId, tokenName });
const seg = (from, to, keys, timingSource = "key_change") => ({ effectiveFrom: from * H, effectiveTo: to == null ? null : to * H, keys, timingSource });

test("keyChangesOnDay：换 Key 的过渡段 [a, b)——一次换 Key：换走旧 Key、换上新 Key，between 是 [a, b]，atMs 是 b", () => {
  const changes = keyChangesOnDay([seg(0, 30, [key(9)], "initial"), seg(30, 36, [key(9), key(10)], "key_change_window"), seg(36, null, [key(10)])], DAY);
  assert.deepEqual(changes, [{ atMs: 36 * H, between: [30 * H, 36 * H], from: { upstreamStationId: "up", tokenId: 9, tokenName: "k9" }, to: { upstreamStationId: "up", tokenId: 10, tokenName: "k10" } }]);
});

test("keyChangesOnDay：定得出时刻的换 Key（按 b 切开、没有过渡段）；只是倍率变了、Key 没换的不算；这一天以外的换 Key 不算", () => {
  const precise = keyChangesOnDay([seg(0, 40, [key(9)], "initial"), seg(40, null, [key(10)])], DAY);
  assert.deepEqual(precise.map((change) => [change.atMs / H, change.between, change.from.tokenId, change.to.tokenId]), [[40, null, 9, 10]]);
  assert.deepEqual(keyChangesOnDay([seg(0, 40, [key(9)], "initial"), seg(40, null, [key(9)], "group_ratio_change")], DAY), [], "Key 没换");
  assert.deepEqual(keyChangesOnDay([seg(0, 60, [key(9)], "initial"), seg(60, null, [key(10)])], DAY), [], "换的时刻在第二天");
  assert.deepEqual(keyChangesOnDay([seg(0, 10, [key(9)], "initial"), seg(10, null, [key(10)])], DAY), [], "换的时刻在前一天");
});

test("keyChangesOnDay：只有换走没有换上、只有换上没有换走（一组里有渠道走了、来了）不是这条绑定自己换 Key，不写", () => {
  assert.deepEqual(keyChangesOnDay([seg(0, 40, [key(9), key(10)], "initial"), seg(40, null, [key(9)])], DAY), []);
});

test("keyMovesOnDay：Key 在两条绑定之间挪了手——换走的那条和接手的那条各自的明细里都有这一句，同一把 Key 同一刻只记一次", () => {
  const a = { id: "A", channelNames: ["高速 A"], segments: [seg(0, 40, [key(9)], "initial"), seg(40, null, [key(20)])] };
  const b = { id: "B", channelNames: ["标准 B"], segments: [seg(0, 40, [key(10)], "initial"), seg(40, null, [key(9)])] };
  const aChanges = keyChangesOnDay(a.segments, DAY), bChanges = keyChangesOnDay(b.segments, DAY);
  const fromA = keyMovesOnDay(a, aChanges, [a, b], DAY), fromB = keyMovesOnDay(b, bChanges, [a, b], DAY);
  const expected = [{ key: { upstreamStationId: "up", tokenId: 9, tokenName: "k9" }, atMs: 40 * H, fromNames: ["高速 A"], toNames: ["标准 B"] }];
  assert.deepEqual(fromA, expected);
  assert.deepEqual(fromB, expected, "接手的那条：换上的 Key 别的绑定在同一刻放下了");
  // 没挪给别的绑定（A 换走的 Key 没人接）：没有这一句
  assert.deepEqual(keyMovesOnDay(a, aChanges, [a], DAY), []);
  // 相差一分钟以内算同一刻（两条绑定的切点是同一轮读到的）；差得多的不算
  const late = { ...b, segments: [seg(0, 40, [key(10)], "initial"), seg(40 + 0.5 / 60, null, [key(9)])] };
  assert.equal(keyMovesOnDay(a, aChanges, [a, late], DAY).length, 1);
  const far = { ...b, segments: [seg(0, 40, [key(10)], "initial"), seg(42, null, [key(9)])] };
  assert.equal(keyMovesOnDay(a, aChanges, [a, far], DAY).length, 0);
});
