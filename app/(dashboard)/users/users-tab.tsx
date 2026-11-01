"use client";
// 用户：一个用户表（design 用户运营 v6 §3、v7 §3）。默认按近 7 天消费从高到低；每列都能点表头排；
// 上面一行：只看重点用户（勾选框）| 全部 / 快用完 / 在下滑 / 新用户 / 不活跃，右边搜索；点一行开抽屉。手机是一人一张卡片。
import { useMemo, useState } from "react";
import { Grid, Input, Tooltip } from "antd";
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
import { FILTERS, FILTER_LABEL, bigLabel, bigTipText, defaultOrder, deltaText, filterCounts, filterRows, lastUsedText, money, runwayText, sortValue, sparkValues } from "./users-format";
import type { Filter, UsersPage, UsersRow } from "./users-format";

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
  const level = status === "empty" || status === "soon" ? "crit" : status === "down" ? "warn" : status === "inactive" ? "muted" : "info";
  return <span className={`jy-tag jy-tag--${level}`}>{COPY.status[status]}</span>;
}

// 可用天数：小跑道 + 「约 13 天」；余额记满 24 小时之前整列写「—」，不画跑道
function RunwayCell({ row, page }: { row: UsersRow; page: UsersPage }) {
  if (!page.ready.balance) return <span className="jy-muted">{EMPTY}</span>;
  const level = row.status === "empty" || row.status === "soon" ? "crit" : "good";
  const has = row.runwayState === "soon" || row.runwayState === "ok";
  return (
    <span className="jy-cell-runway">
      {has && <RunwayTrack mini days={row.days} level={level} critDays={page.level1Days ?? 3} warnDays={0} />}
      <span className={`v${has ? "" : " jy-muted"}`}>{runwayText(row)}</span>
    </span>
  );
}

export function UsersTab({
  page, big, only, onBig, onOnly, onOpenUser,
}: {
  page: UsersPage; big: boolean; only: Filter;
  onBig: (v: boolean) => void; onOnly: (v: Filter) => void; onOpenUser: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const phone = Grid.useBreakpoint().md === false;
  const { rate } = page;
  const compare = !!page.ready.compare;
  const counts = useMemo(() => filterCounts(page, big), [page, big]);
  const rows = useMemo(() => defaultOrder(filterRows(page.users, { big, only, q })), [page.users, big, only, q]);
  const searching = q.trim() !== "";
  const weekOk = !!page.ready.week;
  const sum = (pick: (row: UsersRow) => number) => rows.reduce((total, row) => total + pick(row), 0);

  const name = (row: UsersRow) => (
    <span className="jy-users-name">
      <button type="button" className="jy-link jy-users-linkbtn" title={row.username} aria-label={COPY.users.rowOpen(row.username)} onClick={(event) => { event.stopPropagation(); onOpenUser(row.id); }}>{row.username}</button>
      {row.big && <BigTag tip={bigTipText(row, page)} />}
      {row.disabled && <span className="jy-tag jy-tag--muted">{COPY.disabled}</span>}
    </span>
  );
  const vs = (row: UsersRow) => (!compare ? <span className="jy-muted">{EMPTY}</span> : <span className={row.prevWeek > 0 ? undefined : "jy-muted"}>{deltaText(row.week, row.prevWeek)}</span>);
  const cols: Col<UsersRow>[] = [
    { key: "user", label: COPY.users.cols.user, sort: (r) => sortValue(r, "user", compare) as string, render: name, foot: searching ? COPY.users.totalMatched(rows.length) : COPY.users.total(rows.length) },
    { key: "spark", label: COPY.users.cols.spark, render: (r) => <SparkLine values={sparkValues(r, page.availableDays)} gray={r.status === "down" || r.status === "inactive"} label={COPY.users.sparkLabel(r.username)} /> },
    { key: "week", label: COPY.users.cols.week, num: true, sort: (r) => sortValue(r, "week", compare) as number, render: (r) => <b className="jy-users-week">{weekOk ? money(r.week, rate) : EMPTY}</b>, foot: weekOk ? money(sum((r) => r.week), rate) : EMPTY },
    { key: "vs", label: COPY.users.cols.vsPrev, num: true, sort: (r) => sortValue(r, "vs", compare) as number, render: vs },
    { key: "today", label: COPY.users.cols.today, num: true, sort: (r) => r.today, render: (r) => money(r.today, rate), foot: money(sum((r) => r.today), rate) },
    { key: "balance", label: COPY.users.cols.balance, num: true, sort: (r) => r.balanceUsd, render: (r) => money(r.balanceUsd, rate), foot: money(sum((r) => r.balanceUsd || 0), rate) },
    { key: "days", label: COPY.users.cols.days, sort: (r) => (page.ready.balance ? (sortValue(r, "days", compare) as number) : null), render: (r) => <RunwayCell row={r} page={page} /> },
    { key: "status", label: COPY.users.cols.status, sort: (r) => sortValue(r, "status", compare) as number, render: (r) => <StatusTag status={r.status} /> },
    { key: "last", label: COPY.users.cols.lastUsed, num: true, sort: (r) => sortValue(r, "last", compare) as number, render: (r) => lastUsedText(r, page) },
  ];
  const empty = searching ? COPY.users.noMatch : page.users.length === 0 ? COPY.users.noUsers : COPY.users.noOnly;

  return (
    <>
    <Panel
      title={COPY.users.tableTitle}
      body="flush"
      extra={
        <Input allowClear prefix={<Icon name="search" />} placeholder={COPY.users.search} aria-label={COPY.users.search} value={q} onChange={(event) => setQ(event.target.value)} className="jy-users-search" />
      }
    >
      <div className="jy-users-filters">
        <label className="jy-users-bigcheck">
          <input type="checkbox" checked={big} onChange={(event) => onBig(event.target.checked)} />
          <span>{bigLabel(page)}</span>
        </label>
        <span className="jy-users-filters-rule" aria-hidden="true" />
        <Seg<Filter>
          size="sm"
          label={COPY.users.filterLabel}
          value={only}
          onChange={onOnly}
          options={FILTERS.map((value) => ({
            value,
            // 还判不了的类（补数据没补满、余额没记满）个数写「—」
            label: counts[value] == null ? <>{FILTER_LABEL[value]} <span className="count">{EMPTY}</span></> : FILTER_LABEL[value],
            count: counts[value] ?? undefined,
          }))}
        />
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
                    <SparkLine values={sparkValues(row, page.availableDays)} gray={row.status === "down" || row.status === "inactive"} label={COPY.users.sparkLabel(row.username)} />
                    <span className="jy-caption">{compare ? COPY.users.cardVs(deltaText(row.week, row.prevWeek), money(row.balanceUsd, rate)) : `${COPY.users.cols.balance} ${money(row.balanceUsd, rate)}`}</span>
                  </span>
                  <span className="r3">
                    <span className="jy-caption">{COPY.users.cardLast(lastUsedText(row, page))}</span>
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
          defaultSort={{ key: "week", dir: "desc" }}
          empty={empty}
          cols={cols}
          onRowClick={(row) => onOpenUser(row.id)}
        />
      )}
    </Panel>
    <UserGroups />
    </>
  );
}
