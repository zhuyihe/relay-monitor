"use client";
// 用户：消费排行（可搜索、可排序）、用户余额、用户 × 分组。
import { useMemo, useState } from "react";
import { Input } from "antd";
import { EMPTY, formatCompact, formatInt, formatMoney, formatPct } from "../../../lib/format";
import { ErrorState } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { StatusText } from "../../components/status";
import { DataTable, Delta, RANGE_LABEL, TOKEN_NOTE, deltaSortValue, money, perM, productErrorMessage, sum, totalsNote } from "./shared";
import type { Col, OwnRange, OwnView, UsageRow } from "./shared";

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
  // 上一窗口的用户数据取不到时，环比整列留空，也不给排序
  const noPrev = d.prevUserAvailable === false;
  const shownCost = sum(shown, (u) => u.cost);
  const shownTokens = sum(shown, (u) => u.tokens);

  const cols: Col<UsageRow>[] = [
    {
      key: "user",
      label: "用户",
      sort: (u) => u.user,
      render: (u) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {u.user}
          {u.isAdmin && <span className="jy-tag jy-tag--warn">管理员</span>}
        </span>
      ),
      foot: q.trim() ? `匹配的 ${shown.length} 个用户` : "合计",
    },
    { key: "req", label: "请求数", num: true, sort: (u) => u.requests, render: (u) => formatInt(u.requests), foot: formatInt(sum(shown, (u) => u.requests)) },
    { key: "tok", label: "计费 Token", title: TOKEN_NOTE, num: true, sort: (u) => u.tokens, render: (u) => formatInt(u.tokens), foot: formatInt(shownTokens) },
    { key: "cost", label: "消费", num: true, sort: (u) => u.cost, render: (u) => money(u.cost), foot: money(shownCost) },
    {
      key: "pct",
      label: "占比",
      title: "占这个时间范围内全部用户消费的比例",
      num: true,
      sort: (u) => u.cost,
      render: (u) => (totCost > 0 ? formatPct(u.cost / totCost) : EMPTY),
      foot: totCost > 0 ? formatPct(shownCost / totCost) : EMPTY,
    },
    { key: "perM", label: "¥/M", title: "¥ / 百万计费 token", num: true, sort: (u) => (u.tokens > 0 ? u.cost / u.tokens : null), render: (u) => perM(u.cost, u.tokens), foot: perM(shownCost, shownTokens) },
    {
      key: "delta",
      label: "环比",
      title: noPrev ? "上一等长窗口的用户数据取不到，无法对比" : prevLabel,
      num: true,
      sort: noPrev ? undefined : deltaSortValue,
      render: (u) => (noPrev ? <span className="jy-muted">{EMPTY}</span> : <Delta pct={u.deltaPct} isNew={u.isNew} />),
    },
  ];

  return (
    <Panel
      title="用户消费排行"
      badge={<CountBadge count={users.length} muted />}
      caption={RANGE_LABEL[range]}
      foot={totalsNote(v, "users")}
      extra={
        <div className="jy-toolbar">
          <Input
            allowClear
            prefix={<Icon name="search" />}
            placeholder="搜索用户"
            aria-label="搜索用户"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      }
    >
      <DataTable<UsageRow>
        scroll
        tall
        caption="用户消费排行"
        rows={shown}
        rowKey={(u) => String(u.user)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty={q.trim() ? "没有找到这个用户。" : "这个时间范围内还没有用户消费。"}
        cols={cols}
      />
    </Panel>
  );
}

// ---- 用户余额（不含管理员和 root）------------------------------------------

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
      title="用户余额"
      badge={<CountBadge count={list.length} muted />}
      caption="不含管理员"
      sub={
        <>
          共 {list.length} 个用户，余额合计 <b>{formatMoney(total)}</b>。
        </>
      }
      foot={zeroCount > 0 ? `另有 ${zeroCount} 个用户余额为 0。` : undefined}
    >
      <DataTable<any>
        scroll
        caption="用户余额"
        rows={nonZero}
        rowKey={(u) => String(u.user)}
        defaultSort={{ key: "bal", dir: "desc" }}
        empty="没有余额大于 0 的用户。"
        cols={[
          { key: "user", label: "用户", sort: (u) => u.user, render: (u) => u.user },
          { key: "bal", label: "余额", num: true, sort: (u) => u.balanceUsd, render: (u) => money(u.balanceUsd * rate) },
          { key: "used", label: "累计已用", num: true, sort: (u) => u.usedUsd, render: (u) => formatMoney(u.usedUsd * rate) },
          {
            key: "status",
            label: "状态",
            sort: (u) => (u.status === 1 ? 0 : 1),
            render: (u) => (u.status === 1 ? <StatusText level="good">正常</StatusText> : <StatusText level="muted">已禁用</StatusText>),
          },
        ]}
      />
    </Panel>
  );
}

// ---- 用户 × 分组 ------------------------------------------------------------

function UserGroups({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const { d, toCny, prevLabel } = v;
  const flow = d.flow;
  if (!flow) return null;
  if (flow.error) {
    return (
      <Panel title="用户 × 分组">
        <ErrorState title="分组和渠道数据暂时取不到" error={productErrorMessage(flow.error)} onRetry={() => reload()} />
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
      title="用户 × 分组"
      badge={<CountBadge count={rows.length} muted />}
      sub="按消费降序，最多 15 项，用来找出是谁在哪个分组涨了。"
    >
      <DataTable<UsageRow>
        caption="用户与分组组合的消费"
        rows={rows}
        rowKey={(r) => String(r.key)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty="这个时间范围内还没有数据。"
        cols={[
          { key: "user", label: "用户", sort: (r) => split(r.key)[0], render: (r) => split(r.key)[0] },
          { key: "group", label: "分组", sort: (r) => split(r.key)[1], render: (r) => split(r.key)[1] || <span className="jy-muted">{EMPTY}</span> },
          { key: "req", label: "请求数", num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests) },
          { key: "cost", label: "消费", num: true, sort: (r) => r.cost, render: (r) => money(r.cost) },
          { key: "prev", label: "上窗", title: prevLabel, num: true, sort: (r) => r.prevCost, render: (r) => money(r.prevCost) },
          { key: "delta", label: "环比", title: prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
          { key: "tok", label: "计费 Token", title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatCompact(r.tokens) },
          { key: "perM", label: "¥/M", title: "¥ / 百万计费 token", num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens) },
        ]}
      />
    </Panel>
  );
}
