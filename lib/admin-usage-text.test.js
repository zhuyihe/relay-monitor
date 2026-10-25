import test from "node:test";
import assert from "node:assert/strict";
import { adminUsageLineOf } from "./admin-usage-text.js";

const usd = (value) => `$${value.toFixed(2)}`;
const DAY = 86400000;
const line = (billing) => adminUsageLineOf({ state: "complete", ...billing }, usd);

test("每天都扣了：写金额；合计 0 不写；读不到换算、没读全不写", () => {
  assert.deepEqual(line({ adminUsageAmountUsd: 0.12 }), { text: "已扣除管理员自用 $0.12" });
  assert.deepEqual(line({ adminUsageAmountUsd: 0.12, adminUsageDays: { deducted: 3, undeducted: 0 } }), { text: "已扣除管理员自用 $0.12" });
  assert.equal(line({ adminUsageAmountUsd: 0 }), null);
  assert.equal(line({ adminUsageAmountUsd: 0, adminUsageDays: { deducted: 2, undeducted: 0 } }), null);
  assert.equal(line({ adminUsageAmountUsd: null }), null);
  assert.equal(adminUsageLineOf({ state: "partial", adminUsageAmountUsd: 1 }, usd), null);
});

test("有的扣了有的没扣：金额只加扣过的天，悬停写全句；扣过的合计是 0 时不写 $0", () => {
  const mixed = line({ adminUsageAmountUsd: 0.12, adminUsageDays: { deducted: 1, undeducted: 2 } });
  assert.equal(mixed.text, "已扣除管理员自用 $0.12（部分日子没扣）");
  assert.equal(mixed.title, "有几天的账是按以前的规矩固定的，那时还不扣管理员自用，这几天的收入里可能含着它");
  assert.deepEqual(line({ adminUsageAmountUsd: 0, adminUsageDays: { deducted: 1, undeducted: 2 } }),
    { text: "收入里可能含管理员自用（部分日子的账是按以前的规矩固定的，那时还不扣管理员自用）" });
});

test("一天都没扣：几天写「这几天」，一天写「这一天」；没有 adminUsageDays 时（单日账本、R1 以前的多日确认记录）按窗口天数算", () => {
  assert.equal(line({ adminUsageDays: { deducted: 0, undeducted: 3 }, adminUsageAmountUsd: 0 }).text, "收入里可能含管理员自用（这几天的账是按以前的规矩固定的，那时还不扣管理员自用）");
  assert.equal(line({ adminUsageDays: { deducted: 0, undeducted: 1 }, adminUsageAmountUsd: 0 }).text, "收入里可能含管理员自用（这一天的账是按以前的规矩固定的，那时还不扣管理员自用）");
  assert.match(line({ window: { startMs: 0, endMs: DAY } }).text, /这一天/, "单日账本那一行没有这个数");
  assert.match(line({ window: { startMs: 0, endMs: 7 * DAY } }).text, /这几天/, "R1 以前存的 7 天确认记录：按天数写，不写成「这一天」");
  assert.match(line({}).text, /这一天/, "不知道窗口按一天");
});
