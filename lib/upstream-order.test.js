import test from "node:test";
import assert from "node:assert/strict";
import { hoursLeft, keepOrder, orderUpstreams } from "./upstream-order.js";

const NOW = Date.parse("2026-10-29T00:00:00Z"), H = 3600 * 1000;
// 花钱的：remaining ÷ burnPerDay × 24 小时
const spend = (id, remaining, burnPerDay, extra = {}) => ({ id, name: id, remaining, burnPerDay, cny: remaining, ...extra });
const ids = (items) => orderUpstreams(items, NOW).map((item) => item.id);

test("四组的先后：要马上动手的 → 正在花钱的 → 没在花钱的 → 自营站点和不再续费的", () => {
  const items = [
    { id: "own", name: "自营", bottom: true, remaining: 1, burnPerDay: 1 },
    spend("quiet", 500, 0), spend("burning", 100, 50), { id: "pending", name: "pending", cny: 0 },
    { id: "empty", name: "empty", empty: true, remaining: 0 }, { id: "unread", name: "unread", unreadable: true },
    spend("red", 900, 1, { red: true }), spend("noRenew", 10, 10, { bottom: true }),
  ];
  assert.deepEqual(ids(items), ["empty", "unread", "red", "burning", "quiet", "pending", "own", "noRenew"]);
});

test("要马上动手的组内：先用完，再读不到，再红色需处理，同类按名字", () => {
  const items = [spend("r2", 1, 1, { red: true }), spend("r1", 1, 1, { red: true }), { id: "u", name: "u", unreadable: true }, { id: "e", name: "e", empty: true, remaining: 0 }, { id: "e0", name: "d", empty: true, remaining: 0 }];
  assert.deepEqual(ids(items), ["e0", "e", "u", "r1", "r2"]);
});

test("5 小时和 6 小时（舍成 0.1 天会并列）排对：现算小时、不舍入", () => {
  const a = spend("b-6h", 6, 24), b = spend("a-5h", 5, 24);
  assert.equal(hoursLeft(a, NOW), 6);
  assert.equal(hoursLeft(b, NOW), 5);
  // 名字上 a-5h 本来就在前，所以换名字再试一次：按名字会排错的情形
  assert.deepEqual(ids([spend("a-6h", 6, 24), spend("b-5h", 5, 24)]), ["b-5h", "a-6h"]);
});

test("充值场景：A ¥35,101（每天约 ¥161,091）、B ¥23,585（约 7 小时）、C ¥20,413（约 23 小时）先排 A、B、C；给 A 充 ¥100,000 后排 B、A、C", () => {
  const A = spend("A", 35101, 161091), B = spend("B", 23585, (23585 / 7) * 24), C = spend("C", 20413, (20413 / 23) * 24);
  assert.deepEqual(ids([C, B, A]), ["A", "B", "C"]);
  assert.deepEqual(ids([C, B, { ...A, remaining: 135101 }]), ["B", "A", "C"]);
});

test("没在花钱的按余额从多到少（人民币金额），一样的按名字；包月有到期日的和花钱的一组、按离到期的小时排", () => {
  assert.deepEqual(ids([spend("small", 10, 0, { cny: 10 }), spend("big", 99, null, { cny: 990 }), spend("mid", 50, 0, { cny: 50 })]), ["big", "mid", "small"]);
  const fixed = { id: "fixed", name: "fixed", endAt: NOW + 30 * H };
  assert.deepEqual(ids([spend("s48", 48, 24), fixed, spend("s10", 10, 24)]), ["s10", "fixed", "s48"]);
  assert.equal(hoursLeft({ id: "x", endAt: NOW - H }, NOW), 0, "过了到期时间算 0");
  assert.equal(hoursLeft({ id: "q", remaining: 5, burnPerDay: 0 }, NOW), null);
});

test("红色需处理的在最上（排在花钱的前面）", () => {
  assert.deepEqual(ids([spend("soon", 1, 24), spend("red", 9999, 1, { red: true })]), ["red", "soon"]);
});

test("先别动：hold 时沿用上次顺序，新出现的放最后，没了的去掉；不 hold 用新顺序", () => {
  assert.deepEqual(keepOrder(["a", "b", "c"], ["c", "x", "a", "b"], true), ["a", "b", "c", "x"]);
  assert.deepEqual(keepOrder(["a", "b", "c"], ["c", "a"], true), ["a", "c"]);
  assert.deepEqual(keepOrder(["a", "b", "c"], ["c", "a", "b"], false), ["c", "a", "b"]);
  assert.deepEqual(keepOrder([], ["z", "y"], true), ["z", "y"]);
});
