// 成本估算页用的小函数：日期加减、日期合法性、保留两位。成本构成和逐日成本的数都取每日利润（/api/reconciliation/profit），
// 不在这里整理。导入带 .js 后缀，单元测试（tests/analytics-derive.test.mjs）可以直接用 node 跑这个文件
import { isoDay, parseDay } from "../../../lib/format.js";

export const r2 = (v: number) => Math.round(v * 100) / 100;

export function addDays(iso: string, n: number) {
  const d = parseDay(iso) || new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// parseDay 会把 2 月 31 日滚到 3 月，这里要求往返一致才算合法日期
export function validDay(s: string | null | undefined): s is string {
  const d = s ? parseDay(s) : null;
  return !!d && isoDay(d) === s;
}
