"use client";
// 自营业务页共用：范围与标签常量、金额换算、环比显示、可排序表格。
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { EMPTY, RANGE_TEXT, TOKEN_NOTE as TOKEN_SCOPE, formatDeltaPct, formatMoney, formatUnitPrice, formatZonedRange } from "../../../lib/format";
import { rateSnapshotOf } from "../../../lib/profit";
import { Icon } from "../../components/icons";

export const RANGES = ["today", "7d", "30d"] as const;
export type OwnRange = (typeof RANGES)[number];
// 接口只支持这三档；名字和别的页同一份（RANGE_TEXT）
export const RANGE_OPTIONS: { value: OwnRange; label: string }[] = RANGES.map((value) => ({ value, label: RANGE_TEXT[value] }));

export const TABS = ["overview", "users", "models"] as const;
export type MyTab = (typeof TABS)[number];
// 标签名：标签栏和页里「去某某标签看」的提示共用
export const TAB_TEXT: Record<MyTab, string> = { overview: "概览", users: "用户", models: "模型与渠道" };

// 自营业务里几个面板的名字：按钮、标题、提示里提到时同一个说法（design/ui-copy-spec.md §11）
export const BASIS_TITLE = "利润怎么算";
export const AUDIT_TITLE = "按明细细算";

// 自营站点的账号角色；别的角色不标
export const ROLE_LABEL: Record<number, string> = { 10: "管理员", 100: "超级管理员" };

// 汇总的 Token 只有输入和输出，不含缓存，倍率也不体现
export const TOKEN_NOTE = `${TOKEN_SCOPE}；含缓存的 Token 和倍率见「${AUDIT_TITLE}」`;

// 用户、模型、分组、渠道几张表共用的列名和表头提示（design/ui-copy-spec.md §3.4）
export const COL_TEXT = Object.freeze({
  requests: "请求数",
  tokens: "Token（不含缓存）",
  cost: "消费",
  prev: "上期",
  delta: "环比",
  perM: "每百万 Token 价格",
  perMTitle: "每百万 Token（不含缓存）的价格",
  user: "用户",
  group: "分组",
  share: "占比",
  total: "合计",
});
// 几个标签页都会写的短句（列名以外），只在这一处写
export const MY_TEXT = Object.freeze({
  byDay: "按天",
  noData: "这个时间范围内还没有数据。",
  topUsers: "消费最多的用户",
  // 管理员账号（含超级管理员）：用户名旁边的标记，排行里名字后面的括号
  admin: ROLE_LABEL[10],
  adminSuffix: `（${ROLE_LABEL[10]}）`,
});
// 分组和渠道的数据（flow）读不到时：用户页和模型页同一句
export const FLOW_UNREADABLE = "读不到分组和渠道数据";

// 有效单价：¥ / 百万计费 token。这一列高得离谱的行，通常是缓存写入、长上下文或高倍率在计价
export const perM = (costCny: number, tokens: number) => (tokens > 0 ? formatUnitPrice(costCny / (tokens / 1e6)) : EMPTY);

// 表格里的消费金额：统一两位小数，列内对齐；不足一分但非零的写成 <¥0.01，不让它看起来像没花钱
export const money = (v: number) => (v > 0 && v < 0.005 ? "<¥0.01" : formatMoney(v));

export const sum = <T,>(list: T[], f: (x: T) => number) => list.reduce((a, x) => a + (Number(f(x)) || 0), 0);

// 带环比的行（byModel / byUser / flow.*）：金额已换成人民币
export type UsageRow = {
  tokens: number;
  cost: number;
  requests: number;
  prevCost?: number;
  deltaPct?: number | null;
  isNew?: boolean;
  [k: string]: any;
};

// 接口里的消费金额都是美元额度，统一 × 自营站点售价汇率；profit 已经是人民币
export function deriveOwn(d: any) {
  const rate = rateSnapshotOf(d.station).cnyPerUsd;
  const toCny = (list: any[]): UsageRow[] =>
    (list || []).map((r) => ({ ...r, cost: (r.cost || 0) * rate, prevCost: (r.prevCost || 0) * rate }));
  const models = toCny(d.byModel);
  const users = toCny(d.byUser);
  const totCost = sum(models, (m) => m.cost);
  const totTokens = sum(models, (m) => m.tokens);
  const totReqs = sum(models, (m) => m.requests);
  // 环比对照的是上一段一样长的时间，按业务时区写成「10月8日 0:00–14:30」，放进表头悬停提示
  const prevRange = d.prevWindow ? formatZonedRange(d.prevWindow.startMs, d.prevWindow.endMs, d.tz) : EMPTY;
  const prevDesc = prevRange === EMPTY ? "" : prevRange;
  const prevLabel = prevDesc ? `和上期比（${prevDesc}）` : "和上期比";
  return { d, rate, models, users, totCost, totTokens, totReqs, prevDesc, prevLabel, toCny, profit: d.profit || null };
}
export type OwnView = ReturnType<typeof deriveOwn>;

// 用户表、模型表和概览收入三个合计口径不同，在表下说明差在哪
export function totalsNote(v: OwnView, here: "users" | "models"): string | undefined {
  const userTot = sum(v.users, (u) => u.cost);
  const adminTot = sum(
    v.users.filter((u) => u.isAdmin),
    (u) => u.cost,
  );
  const notes: string[] = [];
  // 管理员 Key 转售出去的消费在概览里算收入（服务端 computeResold），只有自用部分不计入
  const resold = Number(v.profit?.resoldCny) || 0;
  if (here === "users" && adminTot >= 0.005) {
    if (resold >= 0.005) {
      const self = Number(v.profit?.adminUsageCny) || 0;
      notes.push(
        `合计含管理员账号的 ${money(adminTot)}：其中转售 Key 的 ${money(resold)} 算进收入` +
          (self >= 0.005 ? `，管理员自用的 ${money(self)} 不算进收入。` : "。"),
      );
    } else notes.push(`合计含管理员自用的 ${money(adminTot)}，概览里的收入不算这部分。`);
  }
  if (here === "models") notes.push("合计是全部消费，含管理员自用。");
  const mine = here === "users" ? userTot : v.totCost;
  const other = here === "users" ? v.totCost : userTot;
  if (Math.abs(mine - other) >= Math.max(0.01, other * 0.005)) {
    notes.push(`按${here === "users" ? "模型" : "用户"}统计的合计是 ${money(other)}：自营站点分别汇总这两份数据，合计可能有出入。`);
  }
  return notes.length ? notes.join("") : undefined;
}

// 环比：上期为 0 记「上期没有」；涨跌 50% 以上加粗
export function Delta({ pct, isNew }: { pct: number | null | undefined; isNew?: boolean }) {
  if (isNew) return <span className="jy-delta jy-delta--new">上期没有</span>;
  if (pct == null) return <span className="jy-muted">{EMPTY}</span>;
  const cls = ["jy-delta", pct > 0 ? "jy-delta--up" : "", Math.abs(pct) >= 50 ? "jy-my-delta-big" : ""].filter(Boolean).join(" ");
  return <span className={cls}>{formatDeltaPct(pct / 100)}</span>;
}
// 排序用：上期没有的排最前（降序时），没法比的放最后
export const deltaSortValue = (r: UsageRow) => (r.isNew ? Infinity : r.deltaPct ?? null);

// ---- 可排序表格 --------------------------------------------------------------

export type Col<R> = {
  key: string;
  label: ReactNode;
  // 表头悬停说明
  title?: string;
  // 数字列右对齐
  num?: boolean;
  sort?: (r: R) => number | string | null | undefined;
  render: (r: R) => ReactNode;
  foot?: ReactNode;
};

type SortState = { key: string; dir: "asc" | "desc" };

export function DataTable<R>({
  rows,
  cols,
  rowKey,
  empty,
  defaultSort,
  scroll,
  tall,
  compact,
  caption,
}: {
  rows: R[];
  cols: Col<R>[];
  rowKey: (r: R, i: number) => string;
  empty: ReactNode;
  defaultSort?: SortState;
  // 长列表放进固定高度的滚动区，表头和合计行吸附
  scroll?: boolean;
  tall?: boolean;
  compact?: boolean;
  // 读屏用的表格说明
  caption?: string;
}) {
  const [sort, setSort] = useState<SortState | null>(defaultSort || null);
  const sorted = useMemo(() => {
    const col = sort && cols.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const f = col.sort;
    const k = sort.dir === "asc" ? 1 : -1;
    return rows
      .map((r, i) => ({ r, i, v: f(r) }))
      .sort((a, b) => {
        // 空值永远排在最后，不随方向翻转
        const an = a.v == null || (typeof a.v === "number" && Number.isNaN(a.v));
        const bn = b.v == null || (typeof b.v === "number" && Number.isNaN(b.v));
        if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
        const c =
          typeof a.v === "string" || typeof b.v === "string"
            ? String(a.v).localeCompare(String(b.v), "zh-CN")
            : a.v === b.v
              ? 0
              : (a.v as number) < (b.v as number)
                ? -1
                : 1;
        return c === 0 ? a.i - b.i : c * k;
      })
      .map((x) => x.r);
  }, [rows, cols, sort]);

  const onSort = (c: Col<R>) =>
    setSort((s) =>
      s && s.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.num ? "desc" : "asc" },
    );
  const hasFoot = cols.some((c) => c.foot !== undefined);

  return (
    <div className={scroll ? `jy-table-scroll${tall ? " jy-my-tall" : ""}` : "jy-table-wrap"}>
      <table className={`jy-data jy-num${compact ? " jy-data--compact" : ""}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {cols.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.num ? "r" : undefined}
                  title={c.title}
                  aria-sort={c.sort ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                >
                  {c.sort ? (
                    <button type="button" className={`jy-my-sort${active ? " is-active" : ""}`} onClick={() => onSort(c)}>
                      {c.label}
                      {active && <Icon name={sort.dir === "asc" ? "sort" : "sort-down"} />}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length ? (
            sorted.map((r, i) => (
              <tr key={rowKey(r, i)}>
                {cols.map((c) => (
                  <td key={c.key} className={c.num ? "r" : undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="jy-empty-row" colSpan={cols.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
        {hasFoot && sorted.length > 0 && (
          <tfoot>
            <tr>
              {cols.map((c, i) =>
                i === 0 ? (
                  <th key={c.key} scope="row">
                    {c.foot}
                  </th>
                ) : (
                  <td key={c.key} className={c.num ? "r" : undefined}>
                    {c.foot ?? null}
                  </td>
                ),
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
