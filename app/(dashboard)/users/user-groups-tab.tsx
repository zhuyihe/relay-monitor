"use client";
import { useEffect, useState } from "react";
import { Button, Checkbox, Drawer, Grid, Input, Select, Tooltip } from "antd";
import { EMPTY, formatInt, formatPct, formatZonedTime } from "../../../lib/format";
import { Panel } from "../../components/panel";
import { Icon } from "../../components/icons";
import { RefreshFailedBanner } from "../../components/data-state";
import { money } from "./users-format";
import type { UsersPage } from "./users-format";
import "../../styles/pages/user-groups.css";

export type UserGroup = { name: string | null; amount: number; share: number; requests: number | null; pending: boolean; ratio: number | null; ratioSource: "user" | "group" | null };
export type UserGroupRow = { id: number; username: string; big: boolean; disabled: boolean; balanceUsd: number | null; days: number | null; runwayState: string;
  total: number | null; shownAmount: number | null; requests: number | null; groups: UserGroup[] | null; shownGroups: UserGroup[] | null; pending: boolean };
export type UserGroupsPage = { preset: string; startMs: number; endMs: number; asOf: number | null; balanceAt: number | null; rate: number; tz: string; paused: boolean;
  starting: boolean; error: string | null; ratiosAt: number | null; ratiosError: string | null; intervalMs: number; pendingUsers: number; channelGroups: string[]; hasUnclassified: boolean; selectedUser: UserGroupRow | null;
  summary: { users: number; amount: number | null }; list: { rows: UserGroupRow[]; total: number; page: number; pages: number; pageSize: number } };
export type GroupQuery = { q: string; channelGroup: string; active: boolean; sort: string; dir: string; page: number };

function GroupDetails({ row, groups, rate }: { row: UserGroupRow; groups: UserGroup[] | null; rate: number }) {
  if (groups == null) return <p className="jy-ug-empty">{row.total == null ? "分组消费尚未读取，当前余额仍可查看。" : "分组明细正在更新，用户总消费保持主站金额。"}</p>;
  if (!groups.length) return <p className="jy-ug-empty">所选时间内没有分组消费。</p>;
  return <table className="jy-ug-details" aria-label={`${row.username} 的渠道分组消费`}><thead><tr><th>渠道分组</th><th>消费金额</th><th>占用户总消费</th><th>请求数</th></tr></thead><tbody>{groups.map(group => <tr key={group.name || "__unknown"}>
    <td><span className="jy-ug-group-name">{group.name || (group.pending ? "明细待补齐" : "未归类")}</span>{group.name != null && <span className="jy-ug-ratio">当前倍率 <b className="jy-num">{group.ratio == null ? EMPTY : `${group.ratio.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}×`}</b>{group.ratioSource === "user" && <Tooltip title="主站为该客户的用户分组单独设置了这个倍率，优先于渠道分组的默认倍率。"><span className="jy-ug-ratio-special" tabIndex={0}>专属</span></Tooltip>}</span>}</td><td className="jy-num">{money(group.amount, rate)}</td>
    <td><span className="jy-ug-share"><i aria-hidden="true"><b style={{ width: `${group.share * 100}%` }} /></i>{formatPct(group.share)}</span></td><td className="jy-num">{group.requests == null ? EMPTY : formatInt(group.requests)}</td>
  </tr>)}</tbody></table>;
}

export function UserGroupsTab({ data, base, query, rangeKey, userId, loading, error, onQuery, onOpenUser, onCloseUser, onRetry }: {
  data: UserGroupsPage | null; base: UsersPage; query: GroupQuery; rangeKey: string; userId: number | null; loading: boolean; error: any;
  onQuery: (patch: Partial<GroupQuery>) => void; onOpenUser: (id: number) => void; onCloseUser: () => void; onRetry: () => void;
}) {
  const [text, setText] = useState(query.q), [expanded, setExpanded] = useState<Set<number> | null>(null);
  useEffect(() => { setText(query.q); }, [query.q]);
  useEffect(() => { if (text === query.q) return; const timer = setTimeout(() => onQuery({ q: text }), 300); return () => clearTimeout(timer); }, [text]);
  useEffect(() => { setExpanded(null); }, [rangeKey]);
  const phone = Grid.useBreakpoint().md === false;
  const rate = data?.rate ?? base.rate, tz = data?.tz ?? base.tz;
  const fallback: UserGroupRow[] = base.list.rows.map(row => ({ ...row, total: null, shownAmount: null, requests: null, groups: null, shownGroups: null, pending: false }));
  const rows = data?.list.rows || fallback;
  const selected = (data?.selectedUser?.id === userId ? data.selectedUser : null) || rows.find(row => row.id === userId) || fallback.find(row => row.id === userId);
  const isOpen = (id: number) => expanded ? expanded.has(id) : rows[0]?.id === id;
  const toggle = (id: number) => { const next = new Set(expanded ?? (rows[0] ? [rows[0].id] : [])); next.has(id) ? next.delete(id) : next.add(id); setExpanded(next); };
  const allOpen = rows.length > 0 && rows.every(row => isOpen(row.id));
  const asOf = (at: number | null | undefined) => at == null ? "尚未同步" : formatZonedTime(at, tz);
  const ratioNote = data?.ratiosError ? "当前倍率暂未读到，消费金额仍按实际扣费展示。" : `倍率为主站当前设置${data?.ratiosAt ? `，读于 ${asOf(data.ratiosAt)}` : ""}；历史消费保留当时的实际扣费金额。`;
  const sort = (key: string) => onQuery({ sort: key, dir: query.sort === key && query.dir === "desc" ? "asc" : "desc" });
  const name = (row: UserGroupRow) => <><button className="jy-link jy-ug-user-name" onClick={() => onOpenUser(row.id)} aria-label={`查看 ${row.username} 的渠道分组消费`}>{row.username}</button>{row.big && <span className="jy-users-big">重点</span>}</>;
  return <section className="jy-ug" aria-label="用户渠道分组消费">
    <div className="jy-ug-summary"><span>{data && !data.starting ? `${data.summary.users} 位用户 · 所选时间消费合计 ` : "正在读取所选时间的分组消费 "}<strong className="jy-num">{money(data?.summary.amount, rate)}</strong></span>
      <Tooltip title="按用户实际使用的渠道分组汇总，组内各模型的已扣费金额合并；占比以该用户在所选时间内的全部消费为准。"><span className="jy-caption" tabIndex={0}>按用户实际使用的渠道分组统计 <Icon name="info" /></span></Tooltip>
    </div>
    {error && <RefreshFailedBanner asOf={data?.asOf ?? null} tz={tz} error={error} onRetry={onRetry} />}
    {error?.code === "USER_GROUPS_RANGE_INVALID" && <p className="jy-users-progress" role="alert">{error.message}</p>}
    {data?.error && <p className="jy-ug-note" role="status">分组消费更新未完成，{data.asOf ? `保留 ${asOf(data.asOf)} 的明细。` : "当前余额仍可查看。"}<Button type="link" onClick={onRetry}>重新读取</Button></p>}
    {!!data?.pendingUsers && <p className="jy-users-progress" role="status">{data.pendingUsers} 位用户的分组明细尚未齐全，总消费保留主站金额。</p>}
    <Panel title="用户渠道分组消费" sub="客户总消费由各渠道分组金额相加" body="flush" extra={<Input className="jy-ug-search" prefix={<Icon name="search" />} type="search" allowClear aria-label="搜索用户" placeholder="搜索用户" value={text} onChange={event => setText(event.target.value)} />}>
      <div className="jy-ug-filters">
        <label>渠道分组 <Select aria-label="筛选渠道分组" value={query.channelGroup} onChange={channelGroup => onQuery({ channelGroup })} options={[{ value: "", label: "全部渠道分组" }, ...(data?.channelGroups || []).map(group => ({ value: group, label: group })), ...(data?.hasUnclassified ? [{ value: "__unknown", label: "未归类" }] : [])]} /></label>
        <Checkbox checked={query.active} onChange={event => onQuery({ active: event.target.checked })}>仅看有消费</Checkbox>
        <label className="jy-ug-sort">排序 <Select aria-label="用户渠道分组排序" value={`${query.sort}:${query.dir}`} onChange={value => { const [key, dir] = value.split(":"); onQuery({ sort: key, dir }); }} options={[
          { value: "amount:desc", label: "消费从高到低" }, { value: "amount:asc", label: "消费从低到高" }, { value: "balance:asc", label: "余额从低到高" }, { value: "balance:desc", label: "余额从高到低" }, { value: "user:asc", label: "用户名称" },
        ]} /></label>
        <Button type="link" className="jy-ug-expand-all" onClick={() => setExpanded(allOpen ? new Set() : new Set(rows.map(row => row.id)))}>{allOpen ? "收起全部" : "展开全部"}</Button>
      </div>
      <div className="jy-ug-results" aria-busy={loading}>
        {rows.length ? <table className="jy-ug-table" aria-label="用户渠道分组消费列表"><thead><tr><th><button onClick={() => sort("user")}>用户{query.sort === "user" ? query.dir === "asc" ? " ↑" : " ↓" : ""}</button></th><th>渠道分组</th><th className="r"><button onClick={() => sort("amount")}>{query.channelGroup ? "所选分组消费" : "用户总消费"}{query.sort === "amount" ? query.dir === "asc" ? " ↑" : " ↓" : ""}</button></th><th className="r">总请求数</th><th><span className="sr-only">展开分组明细</span></th></tr></thead><tbody>{rows.map(row => {
          const known = row.groups?.filter(group => group.name != null), lead = row.shownGroups?.[0];
          return <UserGroupRows key={row.id} row={row} open={isOpen(row.id)} onToggle={() => toggle(row.id)} name={name(row)} lead={lead?.name || (lead ? lead.pending ? "明细待补齐" : "未归类" : row.groups == null ? "明细更新中" : "暂无分组消费")}
            groupCount={known?.length ?? null} selectedGroup={!!query.channelGroup} rate={rate} onOpen={() => onOpenUser(row.id)} />;
        })}</tbody></table> : <div className="jy-ug-empty"><strong>没有符合条件的用户消费</strong><p>可以更换时间范围、用户名称或渠道分组。</p><Button onClick={() => { setText(""); onQuery({ q: "", channelGroup: "", active: false, page: 1 }); }}>清除筛选</Button></div>}
      </div>
      <div className="jy-ug-footer"><span>{data ? `${data.list.total} 位用户` : "正在读取分组明细"}</span><span>占比以该用户在所选时间内的全部消费为准</span>{data && data.list.pages > 1 && <span><Button disabled={data.list.page <= 1} onClick={() => onQuery({ page: data.list.page - 1 })}>上一页</Button> {data.list.page} / {data.list.pages} <Button disabled={data.list.page >= data.list.pages} onClick={() => onQuery({ page: data.list.page + 1 })}>下一页</Button></span>}</div>
    </Panel>
    <p className="jy-users-progress"><span>消费读于 {asOf(data?.asOf)}</span><span>余额读于 {asOf(data?.balanceAt ?? base.balanceSyncedMs)}</span><span>历史时间按整点汇总，金额与用户运营保持一致。</span></p>
    <p className="jy-users-progress">{ratioNote}</p>
    <Drawer className="jy-drawer jy-users-drawer jy-ug-drawer" open={userId != null} onClose={onCloseUser} size={phone ? "100%" : 640} title={selected?.username || "用户渠道分组消费"}>
      <div className="jy-ug-balance-lead"><span className="jy-caption">当前余额</span><strong className="jy-num">{money(selected?.balanceUsd, rate)}</strong><span className="jy-caption">余额读于 {asOf(data?.balanceAt ?? base.balanceSyncedMs)}</span></div>
      <div className="jy-ug-drawer-heading"><h3>渠道分组消费</h3><span className="jy-caption">消费读于 {asOf(data?.asOf)}</span></div>
      <p className="jy-caption">{data ? `${new Date(data.startMs).toLocaleDateString("zh-CN", { timeZone: tz })} — ${new Date(data.endMs - 1).toLocaleDateString("zh-CN", { timeZone: tz })}` : "正在读取所选时间范围"}</p>
      <p className="jy-ug-drawer-total">所选时间内总消费 <strong className="jy-num">{money(selected?.total, rate)}</strong></p>
      {selected ? <GroupDetails row={selected} groups={selected.groups} rate={rate} /> : <p className="jy-ug-empty">正在读取该用户的渠道分组消费。</p>}
      <p className="jy-caption jy-ug-drawer-foot">{ratioNote}余额始终显示当前值；占比以该用户在同一时间内的全部消费为准。</p>
    </Drawer>
  </section>;
}

function UserGroupRows({ row, open, onToggle, name, lead, groupCount, selectedGroup, rate, onOpen }: { row: UserGroupRow; open: boolean; onToggle: () => void; name: React.ReactNode; lead: string; groupCount: number | null; selectedGroup: boolean; rate: number; onOpen: () => void }) {
  return <><tr className={`jy-ug-user${open ? " is-open" : ""}`} data-user-id={row.id}>
    <td className="jy-ug-identity"><span className="jy-ug-avatar" aria-hidden="true">{row.username.slice(0, 1).toUpperCase()}</span><div><span className="jy-ug-name">{name}</span><span className="jy-caption">当前余额 {money(row.balanceUsd, rate)}</span></div></td>
    <td className="jy-ug-groups"><span title={lead}>{lead}</span><small>{groupCount == null ? "读取中" : `${groupCount} 个渠道分组`}</small></td>
    <td className="r jy-ug-spend"><strong className="jy-num">{money(row.shownAmount, rate)}</strong>{selectedGroup && <small>用户总消费 {money(row.total, rate)}</small>}</td>
    <td className="r jy-ug-requests"><span className="jy-ug-mobile-label">总请求 </span>{row.requests == null ? EMPTY : formatInt(row.requests)}</td>
    <td className="jy-ug-expand"><Button type="text" onClick={onToggle} aria-label={`${open ? "收起" : "展开"} ${row.username} 的渠道分组明细`} aria-expanded={open}><span className="jy-ug-mobile-label">{open ? "收起分组" : "查看分组"}</span><span aria-hidden="true">{open ? "⌄" : "›"}</span></Button></td>
  </tr>{open && <tr className="jy-ug-detail-row"><td colSpan={5}><GroupDetails row={row} groups={row.shownGroups} rate={rate} /><div className="jy-ug-detail-foot"><span>{selectedGroup ? `占比按用户总消费 ${money(row.total, rate)} 计算` : "该用户在各渠道分组的已扣费消费"}</span><Button type="link" onClick={onOpen}>用户详情 →</Button></div></td></tr>}</>;
}
