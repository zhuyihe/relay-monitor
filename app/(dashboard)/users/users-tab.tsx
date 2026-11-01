"use client";
// 用户：一个用户表（design 用户运营 v6 §3、v7 §3、v8 §2）。默认只列近 30 天有消费的人，按近 7 天消费从高到低，每页 50 个；
// 筛选、排序、分页都在服务端（/api/users），这里只管摆：范围 | 只看重点用户 | 状态 | 分组，右边搜索；点一行开抽屉。手机是一人一张卡片。
import { useEffect, useState } from "react";
import { Button, Grid, Input, Select, Tooltip } from "antd";
import { EMPTY } from "../../../lib/format";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { Seg } from "../../components/seg";
import { DataTable } from "../my/shared";
import type { Col } from "../my/shared";
import { SparkLine } from "./charts";
import { UserGroups } from "./groups-panel";
import { COPY } from "./copy";
import { ONLY_LABEL, ONLY_VALUES, bigLabel, bigTipText, deltaText, lastUsedText, money, runwayText, sparkValues } from "./users-format";
import type { ListQuery, Only, Scope, SortKey, UsersPage, UsersRow } from "./users-format";

// 「重点」小标签；提示写这位占多少、全部重点用户合起来占多少。表里和抽屉里鼠标停上去（键盘聚焦、点一下）出提示；
// 手机卡片整张是个按钮（点了开抽屉），标签里放不了第二个按钮，只带 title，抽屉标题上的那个点一下有提示
export function BigTag({ tip, plain }: { tip: string; plain?: boolean }) {
  if (plain) return <span className="jy-users-big" title={tip}>{COPY.big}</span>;
  return (
    <Tooltip title={tip} trigger={["hover", "focus", "click"]} overlayClassName="jy-users-big-tip">
      <span className="jy-users-big" tabIndex={0} aria-label={tip} onClick={(event) => event.stopPropagation()}>{COPY.big}</span>
    </Tooltip>
  );
}
export function StatusTag({ status }: { status: UsersRow["status"] }) {
  if (!status) return null;
  const level = status === "empty" || status === "soon" ? "crit" : status === "down" ? "warn" : status === "churned" ? "muted" : "info";
  return <span className={`jy-tag jy-tag--${level}`}>{COPY.status[status]}</span>;
}

// 可用天数：小跑道 + 「约 13 天」；余额记满 24 小时之前整列写「—」，不画跑道
function RunwayCell({ row, page }: { row: UsersRow; page: UsersPage }) {
  if (!page.ready.balance) return <span className="jy-muted">{EMPTY}</span>;
  const level = row.status === "empty" || row.status === "soon" ? "crit" : "good";
  const has = row.runwayState === "soon" || row.runwayState === "ok";
  return (
    <span className="jy-cell-runway">
      {has && <RunwayTrack mini days={row.days} level={level} critDays={page.level1Days ?? 0.5} warnDays={0} />}
      <span className={`v${has ? "" : " jy-muted"}`}>{runwayText(row)}</span>
    </span>
  );
}

const SEARCH_DELAY_MS = 300;
const noop = () => null;

export function UsersTab({
  page, query, onQuery, onOpenUser, loading,
}: {
  page: UsersPage; query: ListQuery; loading: boolean;
  // 改筛选：页码回到第 1 页由调用方处理（翻页本身不回）
  onQuery: (patch: Partial<ListQuery>) => void; onOpenUser: (id: number) => void;
}) {
  const { list } = page;
  // 搜索框里的字立刻显示，过一小会儿才去问服务端
  const [text, setText] = useState(query.q);
  useEffect(() => { setText(query.q); }, [query.q]);
  useEffect(() => {
    if (text === query.q) return;
    const timer = setTimeout(() => onQuery({ q: text }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const phone = Grid.useBreakpoint().md === false;
  const { rate } = page;
  const compare = !!page.ready.compare;
  const weekOk = !!page.ready.week;
  const searching = query.q.trim() !== "";
  const rows = list.rows;

  const name = (row: UsersRow) => (
    <span className="jy-users-name">
      <button type="button" className="jy-link jy-users-linkbtn" title={row.username} aria-label={COPY.users.rowOpen(row.username)} onClick={(event) => { event.stopPropagation(); onOpenUser(row.id); }}>{row.username}</button>
      {row.big && <BigTag tip={bigTipText(row, page)} />}
      {row.disabled && <span className="jy-tag jy-tag--muted">{COPY.disabled}</span>}
      <StatusTag status={row.status} />
    </span>
  );
  // 近 7 天消费：金额加粗，下面一行小字写比前 7 天
  const vsText = (row: UsersRow) => (!compare ? EMPTY : row.prevWeek > 0 ? COPY.users.vsPrev(deltaText(row.week, row.prevWeek)) : row.week > 0 ? COPY.users.vsNone : EMPTY);
  const cols: Col<UsersRow>[] = [
    {
      key: "user", label: COPY.users.cols.user, sort: noop,
      render: (r) => (<span className="jy-cell-two">{name(r)}{r.group && <span className="jy-caption">{r.group}</span>}</span>),
      foot: searching ? COPY.users.totalMatched(list.total) : COPY.users.total(list.total),
    },
    { key: "spark", label: COPY.users.cols.spark, render: (r) => <SparkLine values={sparkValues(r, page.availableDays)} gray={r.status === "down" || r.status === "churned"} label={COPY.users.sparkLabel(r.username)} /> },
    {
      key: "week", label: COPY.users.cols.week, num: true, sort: noop,
      render: (r) => (<span className="jy-cell-two jy-cell-two--r"><b className="jy-users-week">{weekOk ? money(r.week, rate) : EMPTY}</b><span className={`jy-caption${r.prevWeek > 0 ? "" : " jy-muted"}`}>{vsText(r)}</span></span>),
      foot: weekOk ? money(list.totals.week, rate) : EMPTY,
    },
    { key: "today", label: COPY.users.cols.today, num: true, sort: noop, render: (r) => money(r.today, rate), foot: money(list.totals.today, rate) },
    {
      key: "balance", label: COPY.users.cols.balanceDays, sort: noop,
      render: (r) => (<span className="jy-cell-two"><span className="jy-users-balance">{money(r.balanceUsd, rate)}</span><RunwayCell row={r} page={page} /></span>),
      foot: <span className="jy-users-balance">{money(list.totals.balance, rate)}</span>,
    },
    { key: "last", label: COPY.users.cols.lastUsed, num: true, sort: noop, render: (r) => lastUsedText(r, page) },
  ];
  const empty = searching ? COPY.users.noMatch : list.counts.scope.all === 0 ? COPY.users.noUsers : COPY.users.noOnly;
  const pager = list.total > 0 && (
    <div className="jy-users-pager">
      <span className="jy-caption">{COPY.users.pageNote(list.total, list.pageSize)}</span>
      {list.pages > 1 && (
        <nav className="jy-users-pages" aria-label={COPY.users.pagerLabel}>
          <Button size="small" disabled={list.page <= 1} onClick={() => onQuery({ page: list.page - 1 })}>{COPY.users.prevPage}</Button>
          <span className="jy-caption" aria-live="polite">{COPY.users.pageOf(list.page, list.pages)}</span>
          <Button size="small" disabled={list.page >= list.pages} onClick={() => onQuery({ page: list.page + 1 })}>{COPY.users.nextPage}</Button>
        </nav>
      )}
    </div>
  );

  return (
    <>
    <Panel
      title={COPY.users.tableTitle}
      body="flush"
      extra={
        <Input allowClear prefix={<Icon name="search" />} placeholder={COPY.users.search} aria-label={COPY.users.search} value={text} onChange={(event) => setText(event.target.value)} className="jy-users-search" />
      }
    >
      <div className="jy-users-filters" aria-busy={loading || undefined}>
        <Seg<Scope>
          size="sm"
          className="jy-users-seg-scope"
          label={COPY.users.scopeLabel}
          value={query.scope}
          onChange={(value) => onQuery({ scope: value })}
          options={[
            { value: "active30", label: COPY.users.scopeActive, count: list.counts.scope.active30 },
            { value: "all", label: COPY.users.scopeAll, count: list.counts.scope.all },
          ]}
        />
        <span className="jy-users-filters-rule" aria-hidden="true" />
        <label className="jy-users-bigcheck">
          <input type="checkbox" checked={query.big} onChange={(event) => onQuery({ big: event.target.checked })} />
          <span>{bigLabel(page, list.counts.big)}</span>
        </label>
        <span className="jy-users-filters-rule" aria-hidden="true" />
        <Seg<Only>
          size="sm"
          className="jy-users-seg-status"
          label={COPY.users.filterLabel}
          value={query.only}
          onChange={(value) => onQuery({ only: value })}
          options={ONLY_VALUES.map((value) => ({
            value,
            // 还判不了的类（补数据没补满、余额没记满）个数写「—」
            label: list.counts.only[value] == null ? <>{ONLY_LABEL[value]} <span className="count">{EMPTY}</span></> : ONLY_LABEL[value],
            count: list.counts.only[value] ?? undefined,
          }))}
        />
        {list.groups.length > 0 && (
          <>
            <span className="jy-users-filters-rule" aria-hidden="true" />
            <label className="jy-users-group">
              <span>{COPY.users.groupLabel}</span>
              <Select
                mode="multiple"
                allowClear
                size="small"
                maxTagCount="responsive"
                placeholder={COPY.users.groupAll}
                aria-label={COPY.users.groupLabel}
                value={query.groups}
                onChange={(value) => onQuery({ groups: value })}
                options={list.groups.map((value) => ({ value, label: value }))}
                style={{ minWidth: 140 }}
              />
            </label>
          </>
        )}
      </div>
      {phone ? (
        rows.length ? (
          <ul className="jy-users-cards">
            {rows.map((row) => (
              <li key={row.id}>
                <button type="button" className="jy-users-card" aria-label={COPY.users.rowOpen(row.username)} onClick={() => onOpenUser(row.id)}>
                  <span className="r1">
                    <span className="jy-users-name"><b>{row.username}</b>{row.big && <BigTag plain tip={bigTipText(row, page)} />}<StatusTag status={row.status} /></span>
                    <b className="jy-users-week">{weekOk ? money(row.week, rate) : EMPTY}</b>
                  </span>
                  <span className="r2">
                    <SparkLine values={sparkValues(row, page.availableDays)} gray={row.status === "down" || row.status === "churned"} label={COPY.users.sparkLabel(row.username)} />
                    <span className="jy-caption">{compare ? COPY.users.cardVs(deltaText(row.week, row.prevWeek), money(row.balanceUsd, rate)) : `${COPY.users.balanceWord} ${money(row.balanceUsd, rate)}`}</span>
                  </span>
                  <span className="r3">
                    <span className="jy-caption">{COPY.users.cardLast(lastUsedText(row, page), row.group)}</span>
                    {page.ready.balance ? <RunwayCell row={row} page={page} /> : <span className="jy-caption">{COPY.users.cardDays(EMPTY)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="jy-users-empty jy-muted">{empty}</p>
        )
      ) : (
        <DataTable<UsersRow>
          caption={COPY.users.tableTitle}
          rows={rows}
          rowKey={(row) => String(row.id)}
          controlledSort={{ key: query.sort, dir: query.dir }}
          onSortChange={(next) => onQuery({ sort: next.key as SortKey, dir: next.dir })}
          empty={empty}
          cols={cols}
          onRowClick={(row) => onOpenUser(row.id)}
        />
      )}
      {pager}
    </Panel>
    <UserGroups />
    </>
  );
}
