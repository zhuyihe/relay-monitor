"use client";
// 主表「近 24 小时缺货的模型」（design 模型供需 v5 §2）：只列近 24 小时有缺货失败的模型，按少收的钱从多到少排（接口排好）。
// 一行：缺货失败几次、少收多少、主要原因、出在哪家上游、失败最多的时段、明天预计、一句建议。没失败的收在表下面「另外 N 个模型……」+「显示其余 N 个模型」后面，搜索时在全部里找。
// 拿不到数据时只写一句、放在表的位置。电脑上这块占满剩下的高度，在框里自己滚、表头固定（样式在 models.css）。手机一个模型一张卡片。
import { useState } from "react";
import Link from "next/link";
import { Grid, Input } from "antd";
import { EMPTY } from "../../../lib/format";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { COPY } from "./copy";
import { causeText, isOut, outSinceText, peakText, recoText, tomorrowText, upstreamCell, upstreamParts, yuan, money } from "./models-format";
import type { LoadedPage, LostRowView, Runway } from "./models-format";

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

// 拿不到数据时那一句（放在表的位置）；没开读取的那种后面接「去打开」
export function NoneNote({ page }: { page: LoadedPage }) {
  const { lost } = page.headroom, N = COPY.none;
  if (lost.status === "noErrorLog") {
    return lost.noErrorLogReason === "switchOff"
      ? <p className="jy-models-empty jy-muted" role="status">{N.switchOff} <Link className="jy-link" href="/settings">{N.switchOffLink}</Link></p>
      : <p className="jy-models-empty jy-muted" role="status">{N.noLog}</p>;
  }
  return <p className="jy-models-empty jy-muted" role="status">{N.noFailures}</p>;
}

type Shown = { row: LostRowView | null; name: string; weekUsd: number };

export function ModelsTable({ page, onOpen }: { page: LoadedPage; onOpen: (name: string) => void }) {
  const phone = Grid.useBreakpoint().md === false;
  const [text, setText] = useState("");
  const [showRest, setShowRest] = useState(false);
  const { headroom, rate } = page, { lost } = headroom;
  const needle = text.trim().toLowerCase();
  const failing: Shown[] = lost.rows.map((row) => ({ row, name: row.name, weekUsd: row.weekUsd }));
  const quiet: Shown[] = lost.quiet.map((item) => ({ row: null, name: item.name, weekUsd: item.weekUsd }));
  const restCount = Math.max(lost.quietCount, quiet.length);
  const all = needle || showRest ? [...failing, ...quiet] : failing;
  const shown = needle ? all.filter((item) => item.name.toLowerCase().includes(needle)) : all;
  // 没开错误日志时 rows 里只有断货的模型（不靠错误日志认得）：那句话写在上面，下面照样列它们
  const hasTable = (lost.status === "ok" && (failing.length > 0 || restCount > 0)) || (lost.status === "noErrorLog" && failing.length > 0);

  const name = (item: Shown) => (
    <span className="jy-cell-two">
      <button type="button" className="jy-link jy-models-linkbtn jy-models-name" title={item.name} aria-label={COPY.rowOpen(item.name)} onClick={(event) => { event.stopPropagation(); onOpen(item.name); }}>{item.name}</button>
      <span className="jy-caption">{COPY.weekMoney(money(item.weekUsd, rate))}</span>
    </span>
  );
  const dash = <span className="jy-muted">{COPY.dash}</span>;
  const showFoot = hasTable && !needle && (restCount > 0 || lost.smallCount > 0);
  const foot = showFoot ? (
    <>
      {restCount > 0 && (
        <div className="jy-models-restrow">
          <span>{COPY.quietNote(restCount)}</span>
          {quiet.length > 0 && <button type="button" className="jy-link jy-models-rest" aria-expanded={showRest} onClick={() => setShowRest(!showRest)}>{showRest ? COPY.restHide(restCount) : COPY.restShow(restCount)}</button>}
        </div>
      )}
      {lost.smallCount > 0 && <div className="jy-models-restrow"><span>{COPY.smallNote(lost.smallCount)}</span></div>}
    </>
  ) : undefined;
  const cols = COPY.cols;

  return (
    <Panel
      className="jy-models-panel"
      title={COPY.tableTitle}
      sub={COPY.tableCaption}
      body={false}
      extra={hasTable ? <Input allowClear prefix={<Icon name="search" />} placeholder={COPY.search} aria-label={COPY.search} value={text} onChange={(event) => setText(event.target.value)} className="jy-models-search" /> : undefined}
      foot={foot}
    >
      {!hasTable ? <NoneNote page={page} />
        : <>
        {lost.status === "noErrorLog" && <NoneNote page={page} />}
        {phone ? (
          shown.length ? (
            <ul className="jy-models-cards">
              {shown.map((item) => {
                const row = item.row;
                const out = !!row && isOut(row);
                const line = row ? [row.lostMoney24 > 0 ? (out ? COPY.cardOutMoney(yuan(row.lostMoney24, rate)) : COPY.cardMoney(yuan(row.lostMoney24, rate))) : null, row.mainCause ? causeText(row.mainCause) : null, row.mainUpstream ? upstreamCell(row) : null, peakText(row.peakFailHours)].filter(Boolean) as string[] : [];
                const reco = row ? recoText(row.reco) : null;
                return (
                  <li key={item.name}>
                    <div className="jy-models-card" role="button" tabIndex={0} aria-label={COPY.rowOpen(item.name)} onClick={() => onOpen(item.name)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(item.name); } }}>
                      <span className="r1"><b className="jy-models-cardname">{item.name}</b><span className="jy-hlost">{out ? COPY.outNow : COPY.cardLost(row?.lost24 ?? 0)}</span></span>
                      {line.length > 0 && <span className="r2 jy-caption">{COPY.cardLine(line)}</span>}
                      {row && <span className="r3 jy-caption">{COPY.cardTomorrow(tomorrowText(row.tomorrowLost, out))}</span>}
                      {reco && reco !== EMPTY && <span className="r4 jy-caption">{COPY.cardReco(reco)}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <p className="jy-models-empty jy-muted">{COPY.noMatch}</p>
        ) : (
          <div className="jy-headroom-scroll">
            <table className="jy-data jy-num jy-models-headroom">
              <caption className="sr-only">{COPY.tableTitle}</caption>
              <colgroup><col style={{ width: "17%" }} /><col style={{ width: "10%" }} /><col style={{ width: "13%" }} /><col style={{ width: "8%" }} /><col style={{ width: "14%" }} /><col style={{ width: "10%" }} /><col style={{ width: "10%" }} /><col style={{ width: "18%" }} /></colgroup>
              <thead><tr><th scope="col">{cols.model}</th><th scope="col" className="r">{cols.lost}</th><th scope="col" className="r">{cols.money}</th><th scope="col">{cols.cause}</th><th scope="col">{cols.upstream}</th><th scope="col">{cols.peak}</th><th scope="col" className="r">{cols.tomorrow}</th><th scope="col">{cols.reco}</th></tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={8} className="jy-muted jy-models-empty">{COPY.noMatch}</td></tr>}
                {shown.map((item) => {
                  const row = item.row, out = !!row && isOut(row);
                  const since = out ? outSinceText(row!.outSince, page.tz, page.asOf) : null;
                  return (
                    <tr key={item.name} className="is-clickable" onClick={() => onOpen(item.name)}>
                      <td>{name(item)}</td>
                      <td className="r">{out ? (since ? <span className="jy-cell-two jy-cell-two--r"><span>{COPY.outNow}</span><span className="jy-caption">{since}</span></span> : COPY.outNow) : COPY.timesCell(row?.lost24 ?? 0)}</td>
                      <td className="r">{row && row.lostMoney24 > 0 ? (out ? COPY.outMoney(yuan(row.lostMoney24, rate)) : COPY.moneyCell(yuan(row.lostMoney24, rate))) : dash}</td>
                      <td>{row?.mainCause ? causeText(row.mainCause) : dash}</td>
                      <td>{row && upstreamParts(row) ? <>{upstreamParts(row)!.name}{upstreamParts(row)!.tail && <> <span className="jy-nowrap">{upstreamParts(row)!.tail}</span></>}</> : dash}</td>
                      <td className="jy-hnowrap">{(row && peakText(row.peakFailHours)) || dash}</td>
                      <td className="r">{row ? tomorrowText(row.tomorrowLost, out) : COPY.tomorrowNone}</td>
                      <td>{row ? (recoText(row.reco) === EMPTY ? dash : recoText(row.reco)) : dash}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        </>}
    </Panel>
  );
}
