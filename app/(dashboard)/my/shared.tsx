"use client";
// 自营业务页共用：范围与标签常量、金额换算、环比显示、可排序表格。
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { EMPTY, formatDeltaPct, formatMoney, formatUnitPrice } from "../../../lib/format";
import { rateOf } from "../../../lib/client";
import { Icon } from "../../components/icons";

export const RANGES = ["today", "7d", "30d"] as const;
export type OwnRange = (typeof RANGES)[number];
// 接口只支持这三档
export const RANGE_OPTIONS: { value: OwnRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];
export const RANGE_LABEL: Record<OwnRange, string> = { today: "今天", "7d": "近 7 天", "30d": "近 30 天" };

export const TABS = ["overview", "users", "models"] as const;
export type MyTab = (typeof TABS)[number];

// 成本口径标签
export const MODE_LABEL: Record<string, string> = { usage: "按用量", fixed: "固定摊销", history: "余额推算" };
export const ROLE_LABEL: Record<number, string> = { 10: "管理员", 100: "root" };

// 看板的 token 只有 prompt + completion，不含缓存读写，倍率也不体现
export const TOKEN_NOTE = "看板口径：prompt + completion，不含缓存读写（缓存与倍率见「日志精算」）";

// 后端文案还是旧叫法，统一换成术语表里的"自营站点"
export const productErrorMessage = (error: any) =>
  String(error?.message || error || "请求失败")
    .replaceAll("「我的中转站」", "自营站点")
    .replaceAll("我的中转站", "自营站点")
    .replaceAll("这是我自己的中转站", "这是我的自营站点");

// 没标记自营站点时接口回 400"还没有标记…"：这是引导场景，不是错误
export const isUnconfigured = (error: any) => String(error?.message || error || "").startsWith("还没有标记");

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
  const rate = rateOf(d.station);
  const toCny = (list: any[]): UsageRow[] =>
    (list || []).map((r) => ({ ...r, cost: (r.cost || 0) * rate, prevCost: (r.prevCost || 0) * rate }));
  const models = toCny(d.byModel);
  const users = toCny(d.byUser);
  const totCost = sum(models, (m) => m.cost);
  const totTokens = sum(models, (m) => m.tokens);
  const totReqs = sum(models, (m) => m.requests);
  // 环比对照的是上一段等长时间，说明写进表头悬停提示
  const prevDesc = d.prevWindow
    ? `${new Date(d.prevWindow.startMs).toLocaleString("zh-CN", { hour12: false })} 起的 ${d.prevWindow.spanDays} 天`
    : "";
  const prevLabel = prevDesc ? `对比上一等长窗口：${prevDesc}` : "对比上一等长窗口";
  return { d, rate, models, users, totCost, totTokens, totReqs, prevDesc, prevLabel, toCny, profit: d.profit || null };
}
export type OwnView = ReturnType<typeof deriveOwn>;

// 环比：上窗为 0 记"新增"；涨跌 50% 以上加粗
export function Delta({ pct, isNew }: { pct: number | null | undefined; isNew?: boolean }) {
  if (isNew) return <span className="jy-delta jy-delta--new">新增</span>;
  if (pct == null) return <span className="jy-muted">{EMPTY}</span>;
  const cls = ["jy-delta", pct > 0 ? "jy-delta--up" : "", Math.abs(pct) >= 50 ? "jy-my-delta-big" : ""].filter(Boolean).join(" ");
  return <span className={cls}>{formatDeltaPct(pct / 100)}</span>;
}
// 排序用：新增排最前（降序时），无法比较的放最后
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
