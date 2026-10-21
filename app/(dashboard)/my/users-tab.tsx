"use client";
// 用户：消费排行（可搜索、可排序）、用户余额、用户和分组。
import { useMemo, useState } from "react";
import { Input } from "antd";
import { EMPTY, RANGE_TEXT, formatCompact, formatInt, formatMoney, formatPct } from "../../../lib/format";
import { ErrorState } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { StatusText } from "../../components/status";
import { COL_TEXT, DataTable, Delta, FLOW_UNREADABLE, MY_TEXT, TOKEN_NOTE, deltaSortValue, money, perM, sum, totalsNote } from "./shared";
import type { Col, OwnRange, OwnView, UsageRow } from "./shared";

const GROUPS_TITLE = "用户和分组";

// 只在用户标签页出现的话（design/ui-copy-spec.md §12）；列名、时间范围名、「读不到分组和渠道数据」从共用的地方取
const COPY = Object.freeze({
  matched: (n: number) => `匹配的 ${n} 个用户`,
  shareTitle: "占这个时间范围内全部用户消费的比例",
  noPrev: "上期的用户数据读不到，没法比",
  rankTitle: "用户消费排行",
  search: "搜索用户",
  noMatch: "没有找到这个用户。",
  noUsers: "这个时间范围内还没有用户消费。",
  // 用户余额
  balTitle: "用户余额",
  balCaption: "不含管理员和超级管理员",
  balLead: (n: number) => `共 ${n} 个用户，余额合计`,
  zeroBal: (n: number) => `另有 ${n} 个用户余额为 0。`,
  noBal: "没有余额大于 0 的用户。",
  colBal: "余额",
  colUsed: "累计消费",
  colStatus: "状态",
  disabled: "已禁用",
  // 用户和分组
  groupsSub: "按消费从高到低，最多 15 项，用来找出是谁在哪个分组涨了。",
  groupsCaption: "用户与分组组合的消费",
});

export function UsersTab({ v, range, reload }: { v: OwnView; range: OwnRange; reload: () => Promise<unknown> }) {
  return (
    <>
      <UserTable v={v} range={range} />
      <Balances v={v} />
      <UserGroups v={v} reload={reload} />
    </>
  );
}

// ---- 用户消费排行 ----------------------------------------------------------

function UserTable({ v, range }: { v: OwnView; range: OwnRange }) {
  const [q, setQ] = useState("");
  const { users, d, prevLabel } = v;
  // 占比按用户表自己的合计算，各行加起来是 100%（模型表的合计口径不同，见表下说明）
  const totCost = sum(users, (u) => u.cost);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? users.filter((u) => String(u.user).toLowerCase().includes(k)) : users;
  }, [users, q]);
  // 上期的用户数据读不到时，环比整列留空，也不给排序
  const noPrev = d.prevUserAvailable === false;
  const shownCost = sum(shown, (u) => u.cost);
  const shownTokens = sum(shown, (u) => u.tokens);

  const cols: Col<UsageRow>[] = [
    {
      key: "user",
      label: COL_TEXT.user,
      sort: (u) => u.user,
      render: (u) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {u.user}
          {u.isAdmin && <span className="jy-tag jy-tag--warn">{MY_TEXT.admin}</span>}
        </span>
      ),
      foot: q.trim() ? COPY.matched(shown.length) : COL_TEXT.total,
    },
    { key: "req", label: COL_TEXT.requests, num: true, sort: (u) => u.requests, render: (u) => formatInt(u.requests), foot: formatInt(sum(shown, (u) => u.requests)) },
    { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (u) => u.tokens, render: (u) => formatInt(u.tokens), foot: formatInt(shownTokens) },
    { key: "cost", label: COL_TEXT.cost, num: true, sort: (u) => u.cost, render: (u) => money(u.cost), foot: money(shownCost) },
    {
      key: "pct",
      label: COL_TEXT.share,
      title: COPY.shareTitle,
      num: true,
      sort: (u) => u.cost,
      render: (u) => (totCost > 0 ? formatPct(u.cost / totCost) : EMPTY),
      foot: totCost > 0 ? formatPct(shownCost / totCost) : EMPTY,
    },
    { key: "perM", label: COL_TEXT.perM, title: COL_TEXT.perMTitle, num: true, sort: (u) => (u.tokens > 0 ? u.cost / u.tokens : null), render: (u) => perM(u.cost, u.tokens), foot: perM(shownCost, shownTokens) },
    {
      key: "delta",
      label: COL_TEXT.delta,
      title: noPrev ? COPY.noPrev : prevLabel,
      num: true,
      sort: noPrev ? undefined : deltaSortValue,
      render: (u) => (noPrev ? <span className="jy-muted">{EMPTY}</span> : <Delta pct={u.deltaPct} isNew={u.isNew} />),
    },
  ];

  return (
    <Panel
      title={COPY.rankTitle}
      badge={<CountBadge count={users.length} muted />}
      caption={RANGE_TEXT[range]}
      foot={totalsNote(v, "users")}
      extra={
        <div className="jy-toolbar">
          <Input
            allowClear
            prefix={<Icon name="search" />}
            placeholder={COPY.search}
            aria-label={COPY.search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      }
    >
      <DataTable<UsageRow>
        scroll
        tall
        caption={COPY.rankTitle}
        rows={shown}
        rowKey={(u) => String(u.user)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty={q.trim() ? COPY.noMatch : COPY.noUsers}
        cols={cols}
      />
    </Panel>
  );
}

// ---- 用户余额（不含管理员和超级管理员）------------------------------------

function Balances({ v }: { v: OwnView }) {
  const { d, rate } = v;
  const list = d.userBalances as any[] | null;
  if (!list) return null;
  // 余额为 0 的用户只报数量，不占表格
  const nonZero = list.filter((u) => u.balanceUsd > 0.0001);
  const zeroCount = list.length - nonZero.length;
  const total = sum(list, (u) => u.balanceUsd) * rate;
  return (
    <Panel
      title={COPY.balTitle}
      badge={<CountBadge count={list.length} muted />}
      caption={COPY.balCaption}
      sub={
        <>
          {COPY.balLead(list.length)} <b>{formatMoney(total)}</b>。
        </>
      }
      foot={zeroCount > 0 ? COPY.zeroBal(zeroCount) : undefined}
    >
      <DataTable<any>
        scroll
        caption={COPY.balTitle}
        rows={nonZero}
        rowKey={(u) => String(u.user)}
        defaultSort={{ key: "bal", dir: "desc" }}
        empty={COPY.noBal}
        cols={[
          { key: "user", label: COL_TEXT.user, sort: (u) => u.user, render: (u) => u.user },
          { key: "bal", label: COPY.colBal, num: true, sort: (u) => u.balanceUsd, render: (u) => money(u.balanceUsd * rate) },
          { key: "used", label: COPY.colUsed, num: true, sort: (u) => u.usedUsd, render: (u) => formatMoney(u.usedUsd * rate) },
          {
            key: "status",
            label: COPY.colStatus,
            sort: (u) => (u.status === 1 ? 0 : 1),
            // 正常的不标（§2 第 5 条），只标被禁用的
            render: (u) => (u.status === 1 ? null : <StatusText level="muted">{COPY.disabled}</StatusText>),
          },
        ]}
      />
    </Panel>
  );
}

// ---- 用户和分组 ------------------------------------------------------------

function UserGroups({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const { d, toCny, prevLabel } = v;
  const flow = d.flow;
  if (!flow) return null;
  if (flow.error) {
    return (
      <Panel title={GROUPS_TITLE}>
        <ErrorState what={FLOW_UNREADABLE} error={flow.error} onRetry={() => reload()} />
      </Panel>
    );
  }
  const rows = toCny(flow.byUserGroup);
  if (!rows.length) return null;
  // 接口的 key 是"用户 · 分组"，从最后一个分隔符拆开，用户名里带点也不会拆错
  const split = (key: string) => {
    const i = String(key).lastIndexOf(" · ");
    return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 3)];
  };
  return (
    <Panel
      title={GROUPS_TITLE}
      badge={<CountBadge count={rows.length} muted />}
      sub={COPY.groupsSub}
    >
      <DataTable<UsageRow>
        caption={COPY.groupsCaption}
        rows={rows}
        rowKey={(r) => String(r.key)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty={MY_TEXT.noData}
        cols={[
          { key: "user", label: COL_TEXT.user, sort: (r) => split(r.key)[0], render: (r) => split(r.key)[0] },
          { key: "group", label: COL_TEXT.group, sort: (r) => split(r.key)[1], render: (r) => split(r.key)[1] || <span className="jy-muted">{EMPTY}</span> },
          { key: "req", label: COL_TEXT.requests, num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests) },
          { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost) },
          { key: "prev", label: COL_TEXT.prev, title: prevLabel, num: true, sort: (r) => r.prevCost, render: (r) => money(r.prevCost) },
          { key: "delta", label: COL_TEXT.delta, title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
          { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatCompact(r.tokens) },
          { key: "perM", label: COL_TEXT.perM, title: COL_TEXT.perMTitle, num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens) },
        ]}
      />
    </Panel>
  );
}
