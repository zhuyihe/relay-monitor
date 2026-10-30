import test from "node:test";
import assert from "node:assert/strict";
import { activeNowOf, lastSaleAtOf, noteTodayIncome, SALE_RECENT_MS } from "./sale-tracker.js";

test("今天收入变多才记一次；刚启动就已经有收入的算有收入；没收入的不记", () => {
  const t = new Map();
  noteTodayIncome(t, "a", "10-30", 5, 1000); // 重启后第一次读到、已经有收入
  noteTodayIncome(t, "b", "10-30", 0, 1000);
  assert.equal(lastSaleAtOf(t, ["a"], "10-30"), 1000);
  assert.equal(lastSaleAtOf(t, ["b"], "10-30"), null);
  noteTodayIncome(t, "a", "10-30", 5, 2000); // 没变多
  assert.equal(lastSaleAtOf(t, ["a"], "10-30"), 1000);
  noteTodayIncome(t, "a", "10-30", 6, 3000);
  noteTodayIncome(t, "b", "10-30", 1, 3000);
  assert.equal(lastSaleAtOf(t, ["a", "b"], "10-30"), 3000, "并着几条绑定取最近的");
});

test("满 1 小时没变多就不再算有收入；过了午夜重新记", () => {
  const t = new Map();
  noteTodayIncome(t, "a", "10-30", 5, 0);
  assert.equal(activeNowOf(lastSaleAtOf(t, ["a"], "10-30"), SALE_RECENT_MS - 1), true);
  assert.equal(activeNowOf(lastSaleAtOf(t, ["a"], "10-30"), SALE_RECENT_MS), false);
  assert.equal(lastSaleAtOf(t, ["a"], "10-31"), null, "换了一天旧记录不算");
  noteTodayIncome(t, "a", "10-31", 0.5, 9);
  assert.equal(lastSaleAtOf(t, ["a"], "10-31"), 9, "新的一天收入从头算，有收入就记");
});
