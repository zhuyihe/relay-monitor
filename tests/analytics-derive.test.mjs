// 成本估算页的小函数（app/(dashboard)/analytics/derive.ts）：日期加减、日期合法性。
import test from "node:test";
import assert from "node:assert/strict";
import { addDays, r2, validDay } from "../app/(dashboard)/analytics/derive.ts";

test("addDays 跨月跨年；validDay 拒绝 2 月 31 日这类滚日期；r2 保留两位", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(validDay("2026-02-28"), true);
  assert.equal(validDay("2026-02-31"), false);
  assert.equal(validDay(null), false);
  assert.equal(r2(1.005 * 100 / 100), 1);
});
