"use client";
// 主表「今晚高峰的余量」（design 模型供需 v4 §3）：一个模型一行，要多少、能给多少、差多少放在同一行，后面是受影响的重点用户和一句建议。
// 接口给的行已经排好（缺的在前，按缺口 × 每次卖多少排；余的在后，余量越薄越靠前；量很小的最后）；默认只列缺的和余量薄的，其余收在表下面的按钮后面，搜索时在全部里找。
// 电脑上这块占满剩下的高度，在框里自己滚、表头固定（样式在 models.css）。手机一个模型一张卡片。
import { useMemo, useState } from "react";
import Link from "next/link";
import { Grid, Input } from "antd";
import { EMPTY } from "../../../lib/format";
import { Icon, Sym } from "../../components/icons";
import { More } from "../../components/more";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { COPY } from "./copy";
import { HeadroomBar } from "./headroom-bar";
import { approx, growthText, marginView, money, peakText, quantityText, recoView, userLink } from "./models-format";
import type { HeadroomRow, ModelsPage, Runway } from "./models-format";

// 余下的跑道（上游列表同一个组件、同一种说法）；读不到余额画虚线空条
export function RunwayCell({ runway, critDays }: { runway: Runway | null; critDays: number }) {
  if (!runway) return <span className="jy-muted">{EMPTY}</span>;
  return (
    <span className="jy-cell-runway">
      <RunwayTrack mini days={runway.noSpend ? Infinity : runway.days} level={runway.level} failed={runway.failed} critDays={critDays} />
      <span className="v">{runway.text}</span>
    </span>
  );
}

// 受影响的重点用户：名字是链接，开用户运营的抽屉；没有写「没有」；没开错误日志写「—」
function KeyUsers({ row, state }: { row: HeadroomRow; state: ModelsPage["headroom"]["state"] }) {
  if (state === "noErrorLog") return <span className="jy-muted">{COPY.dash}</span>;
  const { count, top } = row.keyUsers;
  if (!count) return <span className="jy-muted">{COPY.keyUsersNone}</span>;
  return (
    <span className="jy-hkeyusers">
      {top.map((user) => <Link key={user.userId} className="jy-link" href={userLink(user.userId)} onClick={(event) => event.stopPropagation()}>{user.name}</Link>)}
      {count > top.length && <span className="jy-caption">{COPY.keyUsersMore(count)}</span>}
    </span>
  );
}

function MarginCell({ row, state }: { row: HeadroomRow; state: ModelsPage["headroom"]["state"] }) {
  const view = marginView(row, state);
  return (
    <span className="jy-hmargin">
      <span className={`jy-hmargin-text is-${view.tone}`}>{view.tone === "short" && <Sym kind="crit" />}{view.text}</span>
      <HeadroomBar need={row.need?.value ?? null} supply={row.supply} label={view.text} />
    </span>
  );
}

function RecoCell({ row, state }: { row: HeadroomRow; state: ModelsPage["headroom"]["state"] }) {
  const reco = recoView(row, state);
  if (reco.kind === "none") return <span className="jy-muted">{COPY.dash}</span>;
  return (
    <span className="jy-cell-two">
      <span>{reco.title}</span>
      {reco.why && <span className="jy-caption">{reco.why}</span>}
    </span>
  );
}

export function HowBody({ page }: { page: ModelsPage }) {
  const how = COPY.how, n = page.headroom.numbers;
  return (
    <ul className="jy-models-how">
      <li><b>{how.notBoughtTitle}</b>{how.notBought}</li>
      <li><b>{how.needTitle}</b>{how.need(n)}</li>
      <li><b>{how.limitTitle}</b>{how.limit(n)}</li>
      <li><b>{how.supplyTitle}</b>{how.supply}</li>
      <li><b>{how.biasTitle}</b>{how.bias}</li>
      <li><b>{how.reasonTitle}</b>{how.reason}</li>
      <li><b>{how.moneyTitle}</b>{how.money}</li>
      <li><b>{how.recoTitle}</b>{how.reco(n)}</li>
      <li><b>{how.smallTitle}</b>{how.small}</li>
    </ul>
  );
}

export function ModelsTable({ page, onOpen }: { page: ModelsPage; onOpen: (name: string) => void }) {
  const phone = Grid.useBreakpoint().md === false;
  const [text, setText] = useState("");
  const [showRest, setShowRest] = useState(false);
  const { headroom, rate } = page, state = headroom.state;
  const needle = text.trim().toLowerCase();
  // 默认只列缺的和余量薄的；搜索时、点开「其余」时列全部
  const gap = useMemo(() => headroom.rows.filter((row) => row.group === "short" || row.group === "thin"), [headroom.rows]);
  const restCount = headroom.rows.length - gap.length;
  const shown = needle ? headroom.rows.filter((row) => row.name.toLowerCase().includes(needle)) : showRest ? headroom.rows : gap;
  const emptyText = needle ? COPY.noMatch : headroom.rows.length ? COPY.noShort : COPY.empty;

  const name = (row: HeadroomRow) => (
    <span className="jy-cell-two">
      <button type="button" className="jy-link jy-models-linkbtn jy-models-name" title={row.name} aria-label={COPY.rowOpen(row.name)} onClick={(event) => { event.stopPropagation(); onOpen(row.name); }}>{row.name}</button>
      <span className="jy-caption">{COPY.weekMoney(money(row.weekUsd, rate))}</span>
    </span>
  );
  const foot = (
    <>
      {restCount > 0 && !needle && (
        <div className="jy-models-restrow">
          <span>{COPY.restNote(restCount)}</span>
          <button type="button" className="jy-link jy-models-rest" aria-expanded={showRest} onClick={() => setShowRest(!showRest)}>{showRest ? COPY.restHide(restCount) : COPY.restShow(restCount)}</button>
        </div>
      )}
      <More label={COPY.how.title} className="jy-models-howmore"><div className="jy-models-howbox"><HowBody page={page} /></div></More>
    </>
  );
  const cols = COPY.cols;
  const th = (label: string, unit = false, right = false) => (
    <th scope="col" className={right ? "r" : undefined}><span className="jy-hth">{label}</span>{unit && <span className="jy-hunit">{COPY.unit}</span>}</th>
  );

  return (
    <Panel
      className="jy-models-panel"
      title={COPY.tableTitle}
      caption={COPY.tableCaption}
      body={false}
      extra={<Input allowClear prefix={<Icon name="search" />} placeholder={COPY.search} aria-label={COPY.search} value={text} onChange={(event) => setText(event.target.value)} className="jy-models-search" />}
      foot={foot}
    >
      {phone ? (
        shown.length ? (
          <ul className="jy-models-cards">
            {shown.map((row) => {
              const view = marginView(row, state), reco = recoView(row, state);
              const peak = peakText(row.peak);
              return (
                <li key={row.name}>
                  <div className="jy-models-card" role="button" tabIndex={0} aria-label={COPY.rowOpen(row.name)} onClick={() => onOpen(row.name)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(row.name); } }}>
                    <span className="r1"><b className="jy-models-cardname">{row.name}</b><span className={`jy-hmargin-text is-${view.tone}`}>{view.tone === "short" && <Sym kind="crit" />}{view.text}</span></span>
                    <span className="r2 jy-caption">
                      <span>{COPY.cardLine(peak ?? COPY.dash, row.need ? COPY.approx(approx(row.need.value)) : COPY.dash, quantityText(row.supply))}</span>
                      <HeadroomBar need={row.need?.value ?? null} supply={row.supply} label={view.text} />
                    </span>
                    {state !== "noErrorLog" && row.keyUsers.count > 0 && <span className="r3 jy-caption"><KeyUsers row={row} state={state} /></span>}
                    {reco.kind !== "none" && <span className="r4 jy-caption">{COPY.cardReco(reco.title, reco.why)}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="jy-models-empty jy-muted">{emptyText}</p>
      ) : (
        <div className="jy-headroom-scroll">
          <table className="jy-data jy-num jy-models-headroom">
            <caption className="sr-only">{COPY.tableTitle}</caption>
            <colgroup><col style={{ width: "19%" }} /><col style={{ width: "10%" }} /><col style={{ width: "11%" }} /><col style={{ width: "10%" }} /><col style={{ width: "13%" }} /><col style={{ width: "14%" }} /><col style={{ width: "23%" }} /></colgroup>
            <thead><tr>{th(cols.model)}{th(cols.peak)}{th(cols.need, true, true)}{th(cols.supply, true, true)}{th(cols.margin)}{th(cols.keyUsers)}{th(cols.reco)}</tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={7} className="jy-muted jy-models-empty">{emptyText}</td></tr>}
              {shown.map((row) => (
                <tr key={row.name} className="is-clickable" onClick={() => onOpen(row.name)}>
                  <td>{name(row)}</td>
                  <td className="jy-hnowrap">{peakText(row.peak) ?? <span className="jy-muted">{COPY.dash}</span>}</td>
                  <td className="r">{row.need
                    ? <span className="jy-cell-two jy-cell-two--r"><span>{COPY.approx(approx(row.need.value))}</span><span className="jy-caption">{growthText(row.need.growth)}</span></span>
                    : <span className="jy-muted">{COPY.dash}</span>}</td>
                  <td className="r">{row.supply.kind === "accumulating" ? <span className="jy-muted">{COPY.accumulating}</span> : quantityText(row.supply)}</td>
                  <td><MarginCell row={row} state={state} /></td>
                  <td><KeyUsers row={row} state={state} /></td>
                  <td><RecoCell row={row} state={state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
