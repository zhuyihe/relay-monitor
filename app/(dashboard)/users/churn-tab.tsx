"use client";
// 流失：谁在少花钱，一天少收多少，先救谁（design 用户运营 流失 v1）。页面从上到下两块：四个数、一张表；表是主角，损失最大的排最前面。
// 筛选（只看重点用户、状态）、翻页都在服务端（/api/users/churn），这里只管摆；点一行开用户抽屉（和用户页签同一个）。手机是一人一张卡片。
import { useEffect, useState } from "react";
import { Button, Grid, Input } from "antd";
import { EMPTY, formatZonedTime } from "../../../lib/format";
import { Icon } from "../../components/icons";
import { More } from "../../components/more";
import { Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { DataTable } from "../my/shared";
import type { Col } from "../my/shared";
import { COPY } from "./copy";
import { BigTag } from "./users-tab";
import { CHURN_FILTERS, changeText, churnKpis, lastUsedText, lossText, money, returnedParts } from "./users-format";
import type { ChurnOnly, ChurnPage, ChurnQuery, ChurnRow, UsersPage } from "./users-format";

const SEARCH_DELAY_MS = 300;
const MIN_USD = 5; // 在下滑、今天明显少了：平时要有这么多才判（和 lib/user-ops-view.js、lib/user-ops-churn.js 的门槛一样，只用来写「怎么判断的」）

function ChurnTag({ status }: { status: ChurnRow["status"] }) {
  const level = status === "churned" ? "muted" : status === "returned" ? "info" : "warn";
  return <span className={`jy-tag jy-tag--${level}`}>{COPY.churn.status[status]}</span>;
}

export function ChurnTab({
  page, users, query, onQuery, onOpenUser, onShowReturned, loading,
}: {
  page: ChurnPage; users: UsersPage; query: ChurnQuery; loading: boolean;
  onQuery: (patch: Partial<ChurnQuery>) => void; onOpenUser: (id: number) => void; onShowReturned: () => void;
}) {
  const C = COPY.churn;
  const { list, rate } = page;
  const phone = Grid.useBreakpoint().md === false;
  const [text, setText] = useState(query.q);
  useEffect(() => { setText(query.q); }, [query.q]);
  useEffect(() => {
    if (text === query.q) return;
    const timer = setTimeout(() => onQuery({ q: text }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const searching = query.q.trim() !== "";
  const kpis = churnKpis(page);
  const returned = returnedParts(page);
  const filters: ChurnOnly[] = query.only === "returned" ? [...CHURN_FILTERS, "returned"] : [...CHURN_FILTERS];
  const rows = list.rows;
  const returnedOnly = query.only === "returned";

  const name = (row: ChurnRow) => (
    <span className="jy-users-name">
      <button type="button" className="jy-link jy-users-linkbtn" title={row.username} aria-label={COPY.users.rowOpen(row.username)} onClick={(event) => { event.stopPropagation(); onOpenUser(row.id); }}>{row.username}</button>
      {row.big && <BigTag tip={COPY.bigTipPlain} />}
      {row.disabled && <span className="jy-tag jy-tag--muted">{COPY.disabled}</span>}
    </span>
  );
  const when = (row: ChurnRow) => lastUsedText(row, users);
  // 比的是哪两段；今天明显少了写「平时到 14:00 → 今天到 14:00」（14:00 是比到的上一个整点）
  const basisText = (row: ChurnRow) => (row.status === "todayLow" ? C.basisPeriod(page.sameUntilMs != null ? formatZonedTime(page.sameUntilMs, page.tz) : EMPTY) : row.status === "down" ? C.basis.decline : C.basis.churn);
  const cols: Col<ChurnRow>[] = [
    {
      key: "user", label: C.cols.user,
      render: (r) => (<span className="jy-cell-two">{name(r)}{r.group && <span className="jy-caption">{r.group}</span>}</span>),
      foot: searching ? C.totalMatched(list.total) : C.total(list.total),
    },
    { key: "status", label: C.cols.status, render: (r) => <ChurnTag status={r.status} /> },
    {
      key: "change", label: C.cols.change,
      render: (r) => (<span className="jy-cell-two"><span className="jy-users-balance">{changeText(r, rate)}</span>{r.status !== "returned" && <span className="jy-caption">{basisText(r)}</span>}</span>),
    },
    {
      key: "loss", label: C.cols.loss, num: true,
      render: (r) => <b className="jy-users-week">{lossText(r, rate)}</b>,
      foot: returnedOnly ? undefined : <b className="jy-users-week">{C.lossPerDay(money(list.totals.loss, rate))}</b>,
    },
    { key: "last", label: C.cols.lastUsed, num: true, render: when },
    { key: "balance", label: C.cols.balance, num: true, render: (r) => money(r.balanceUsd, rate) },
    { key: "model", label: C.cols.model, render: (r) => (r.model ? <span className="jy-users-model" title={r.model}>{r.model}</span> : <span className="jy-muted">{C.noModel}</span>) },
  ];
  const empty = searching ? C.noMatch : list.counts.only.all === 0 && !returnedOnly ? (page.ready.down || page.ready.churn ? C.empty : C.notReady) : C.noOnly;
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
  const note = page.modelsError ? (page.modelsError === "BUSY" ? C.modelsBusy : C.modelsFailed) : null;

  return (
    <>
      <Panel label={C.kpiLabel}>
        <dl className="jy-kpis jy-churn-kpis">
          {kpis.map((kpi) => (
            <div key={kpi.key}>
              <dt title={kpi.titleHint}>{kpi.title}</dt>
              <dd className="jy-kpi-figure">{kpi.value}</dd>
              <dd className="jy-caption">
                {kpi.key === "returned" && returned.length
                  ? returned.map((part, index) =>
                    part.kind === "text" ? <span key={index}>{part.text}</span>
                      : part.kind === "user" ? <button key={index} type="button" className="jy-link jy-users-linkbtn" onClick={() => onOpenUser(part.id)}>{part.name}</button>
                        : <button key={index} type="button" className="jy-link jy-users-linkbtn" onClick={onShowReturned}>{part.text}</button>)
                  : kpi.sub}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel
        title={C.tableTitle}
        body="flush"
        extra={<Input allowClear prefix={<Icon name="search" />} placeholder={C.search} aria-label={C.search} value={text} onChange={(event) => setText(event.target.value)} className="jy-users-search" />}
      >
        <div className="jy-users-filters" aria-busy={loading || undefined}>
          <Seg<ChurnOnly>
            size="sm"
            label={C.filterLabel}
            value={query.only}
            onChange={(value) => onQuery({ only: value })}
            options={filters.map((value) => ({
              value,
              label: value === "all" ? C.filterAll : C.status[value],
              count: list.counts.only[value] ?? undefined,
            }))}
          />
          <span className="jy-users-filters-rule" aria-hidden="true" />
          <label className="jy-users-bigcheck">
            <input type="checkbox" checked={query.big} onChange={(event) => onQuery({ big: event.target.checked })} />
            <span>{C.onlyBig(users.big.ready ? String(list.counts.big) : EMPTY)}</span>
          </label>
        </div>
        {returnedOnly && <p className="jy-caption jy-churn-note">{C.returnedNote}</p>}
        {phone ? (
          rows.length ? (
            <ul className="jy-users-cards">
              {rows.map((row) => (
                <li key={row.id}>
                  <button type="button" className="jy-users-card" aria-label={COPY.users.rowOpen(row.username)} onClick={() => onOpenUser(row.id)}>
                    <span className="r1">
                      <span className="jy-users-name"><b>{row.username}</b>{row.big && <BigTag plain tip={COPY.bigTipPlain} />}<ChurnTag status={row.status} /></span>
                      <b className="jy-users-week">{lossText(row, rate)}</b>
                    </span>
                    {row.status !== "returned" && (
                      <span className="r2"><span className="jy-caption">{changeText(row, rate)} · {basisText(row)}</span></span>
                    )}
                    <span className="r3">
                      <span className="jy-caption">{C.cardLast(when(row), money(row.balanceUsd, rate))}</span>
                      <span className="jy-caption jy-users-model" title={row.model || undefined}>{row.model || C.noModel}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="jy-users-empty jy-muted">{empty}</p>
          )
        ) : (
          <DataTable<ChurnRow>
            caption={C.tableTitle}
            rows={rows}
            rowKey={(row) => String(row.id)}
            empty={empty}
            cols={cols}
            onRowClick={(row) => onOpenUser(row.id)}
          />
        )}
        {note && <p className="jy-caption jy-churn-note">{note}</p>}
        {pager}
      </Panel>
      <section className="jy-panel" aria-label={C.howTitle}>
        <div className="jy-panel-body">
          <More label={C.howTitle}>
            <ul className="jy-churn-how">
              <li>{C.howToday(money(MIN_USD, rate))}</li>
              <li>{C.howDown(money(MIN_USD, rate))}</li>
              <li>{C.howChurned}</li>
              <li>{C.howOrder}</li>
            </ul>
          </More>
        </div>
      </section>
    </>
  );
}



