"use client";
// 主表「每个模型的供需」（design 模型供需 v1 §3）：一个模型一行，需求（近 7 天消费、涨跌）和货源（成功率、几个上游、货源还能撑几天）放在同一行，
// 缺口标签最多 3 个；默认只列有缺口的（按每天卖多少钱排），其余的收在表下面的按钮后面，展开后分两段（有缺口的在前、没缺口的在后）；搜索时在全部里找。
// 点表头按那一列排、这时不分段。点一行或名字开抽屉。手机一个模型一张卡片。电脑上这块占满剩下的高度，在框里自己滚、表头固定（样式在 models.css）。
import { useMemo, useState } from "react";
import { Grid, Input } from "antd";
import { EMPTY } from "../../../lib/format";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { DataTable } from "../my/shared";
import type { Col } from "../my/shared";
import { COPY } from "./copy";
import type { GapTag } from "./copy";
import { deltaText, money, nextSort, sortRows, successText, supplyText } from "./models-format";
import type { ModelRow, ModelsPage, Runway, Sort, SortKey } from "./models-format";

const TAG_LEVEL: Record<GapTag, string> = { out: "crit", soon: "crit", fail: "warn", single: "muted", rising: "info" };

export function GapTags({ tags }: { tags: GapTag[] }) {
  return <span className="jy-models-tags">{tags.map((tag) => <span key={tag} className={`jy-tag jy-tag--${TAG_LEVEL[tag]}`} title={COPY.tagTips[tag]}>{COPY.tags[tag]}</span>)}</span>;
}

// 主要上游还能撑：小跑道加「约 2 天」，和上游列表同一个组件、同一种说法；读不到余额画虚线空条
export function RunwayCell({ runway, critDays }: { runway: Runway | null; critDays: number }) {
  if (!runway) return <span className="jy-muted">{EMPTY}</span>;
  return (
    <span className="jy-cell-runway">
      <RunwayTrack mini days={runway.noSpend ? Infinity : runway.days} level={runway.level} failed={runway.failed} critDays={critDays} />
      <span className="v">{runway.text}</span>
    </span>
  );
}

const noop = () => null;

export function ModelsTable({ page, sort, onSort, onOpen }: { page: ModelsPage; sort: Sort; onSort: (next: Sort) => void; onOpen: (name: string) => void }) {
  const phone = Grid.useBreakpoint().md === false;
  const [text, setText] = useState("");
  const { rate, critDays } = page;
  const needle = text.trim().toLowerCase();
  const [showRest, setShowRest] = useState(false);
  const matched = useMemo(() => sortRows(page.rows, sort).filter((row) => !needle || row.name.toLowerCase().includes(needle)), [page.rows, sort, needle]);
  // 默认只列有缺口的；搜索时、点开「其余」时列全部
  const restCount = useMemo(() => page.rows.filter((row) => !row.gap).length, [page.rows]);
  const all = showRest || !!needle;
  const shown = all ? matched : matched.filter((row) => row.gap);
  const gapCount = shown.filter((row) => row.gap).length;
  const emptyText = needle ? COPY.noMatch : page.rows.length ? COPY.noGap : COPY.empty;
  // 默认排法分两段，按表头排时不分
  const segment = (row: ModelRow) => (sort ? null : row.gap ? COPY.segGap(gapCount) : COPY.segNone(shown.length - gapCount));
  const name = (row: ModelRow) => (
    <span className="jy-models-name">
      <button type="button" className="jy-link jy-models-linkbtn" title={row.name} aria-label={COPY.rowOpen(row.name)} onClick={(event) => { event.stopPropagation(); onOpen(row.name); }}>{row.name}</button>
      {row.isNew && <span className="jy-models-new">{COPY.newTag}</span>}
    </span>
  );
  const week = (row: ModelRow) => (
    <span className="jy-cell-two jy-cell-two--r"><b className="jy-models-week">{money(row.week, rate)}</b><span className={`jy-caption${row.prev > 0 ? "" : " jy-muted"}`}>{deltaText(row.week, row.prev)}</span></span>
  );
  const cols: Col<ModelRow>[] = [
    { key: "model", label: COPY.cols.model, sort: noop, render: name },
    { key: "week", label: COPY.cols.week, num: true, sort: noop, render: week },
    { key: "success", label: COPY.cols.success, num: true, sort: noop, render: (row) => <span className={row.success.state === "ok" ? undefined : "jy-muted"}>{successText(row.success)}</span> },
    {
      key: "supply", label: COPY.cols.supply, sort: noop,
      render: (row) => (<span className="jy-cell-two"><span className="jy-models-nowrap">{supplyText(row)}</span>{row.supply.stopped > 0 && <span className="jy-caption">{COPY.supplyStopped(row.supply.stopped)}</span>}</span>),
    },
    {
      key: "runway", label: COPY.cols.runway, sort: noop,
      render: (row) => (row.longest
        ? (<span className="jy-cell-two"><span>{row.longest.name ?? EMPTY}</span><RunwayCell runway={row.longest.runway} critDays={critDays} /></span>)
        : <span className="jy-muted">{COPY.runwayNone}</span>),
    },
    { key: "gap", label: COPY.cols.gap, sort: noop, render: (row) => <GapTags tags={row.tags} /> },
  ];

  const rest = !needle && restCount > 0 && (
    <button type="button" className="jy-link jy-models-rest" aria-expanded={showRest} onClick={() => setShowRest(!showRest)}>{showRest ? COPY.restHide(restCount) : COPY.restShow(restCount)}</button>
  );
  return (
    <Panel
      className="jy-models-panel"
      title={COPY.tableTitle}
      body="flush"
      foot={rest || undefined}
      extra={<Input allowClear prefix={<Icon name="search" />} placeholder={COPY.search} aria-label={COPY.search} value={text} onChange={(event) => setText(event.target.value)} className="jy-models-search" />}
    >
      {phone ? (
        shown.length ? (
          <ul className="jy-models-cards">
            {shown.map((row, i) => {
              const group = segment(row);
              return (
                <li key={row.name}>
                  {group != null && (i === 0 || segment(shown[i - 1]) !== group) && <div className="jy-models-seg">{group}</div>}
                  <button type="button" className="jy-models-card" aria-label={COPY.rowOpen(row.name)} onClick={() => onOpen(row.name)}>
                    <span className="r1"><span className="jy-models-name"><b>{row.name}</b>{row.isNew && <span className="jy-models-new">{COPY.newTag}</span>}<GapTags tags={row.tags} /></span><b className="jy-models-week">{money(row.week, rate)}</b></span>
                    <span className="r2 jy-caption">{COPY.cardVs(deltaText(row.week, row.prev), successText(row.success))}</span>
                    <span className="r3"><span className="jy-caption">{COPY.cardSupply(supplyText(row), row.longest?.name ?? COPY.runwayNone)}</span>{row.longest && <RunwayCell runway={row.longest.runway} critDays={critDays} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="jy-models-empty jy-muted">{emptyText}</p>
      ) : (
        <DataTable<ModelRow>
          caption={COPY.tableTitle}
          rows={shown}
          rowKey={(row) => row.name}
          controlledSort={sort ?? { key: "", dir: "desc" }}
          onSortChange={(next) => onSort(nextSort(sort, next.key as SortKey))}
          empty={emptyText}
          scroll
          cols={cols}
          rowGroup={segment}
          onRowClick={(row) => onOpen(row.name)}
        />
      )}
    </Panel>
  );
}
