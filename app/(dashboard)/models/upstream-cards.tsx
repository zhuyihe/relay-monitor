"use client";
// 「按上游看」（design 模型供需 v5 §4）：每家上游一张卡片——余额还能撑多久、近 24 小时限流 / 故障 / 没钱各几次、影响哪些模型、带 ↗ 的动作链接；
// 每小时最多接多少只在测到时多写一行。带 ↗ 的链接都跳到用户的站或上游网站，控制台不替用户改任何东西。电脑上这块在框里自己滚（样式在 models.css）。
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { COPY } from "./copy";
import { actionHref, approx, lostTotal, upstreamRunway } from "./models-format";
import type { LoadedPage, UpstreamView } from "./models-format";

export function upstreamDomId(id: string | null) { return `jy-up-${id ?? "unbound"}`; }

function Card({ item, page, onOpenModel }: { item: UpstreamView; page: LoadedPage; onOpenModel: (name: string) => void }) {
  const U = COPY.upstream, { headroom, critDays } = page;
  const runway = upstreamRunway(item.hoursLeft, critDays);
  const lost = item.lost24;
  const links = headroom.links;
  return (
    <li id={upstreamDomId(item.upstreamId)} className="jy-hcard" tabIndex={-1}>
      <div className="r1">
        <b>{item.name ?? U.unboundName}</b>
        <span className="jy-hcard-runway">
          {runway && (<><RunwayTrack mini days={runway.days} level={runway.level} critDays={critDays} /><span>{runway.text}</span></>)}
        </span>
      </div>
      {lost !== undefined && lost !== null && (
        <div className="r2">{lostTotal(lost) > 0 ? U.last24(lost.rate_limit, lost.upstream, lost.auth_quota) : <span className="jy-muted">{U.last24None}</span>}</div>
      )}
      {item.limit.kind === "measured" && item.limit.value != null && <div className="r3 jy-caption">{U.limit(approx(item.limit.value))}</div>}
      {item.models.count > 0 && (
        <div className="r5 jy-caption">
          {U.supplies(item.models.count)}
          {item.models.names.map((name, index) => (
            <span key={name}>{index > 0 && "、"}<button type="button" className="jy-link jy-models-linkbtn" onClick={() => onOpenModel(name)}>{name}</button></span>
          ))}
          {item.models.count > item.models.names.length && ` ${U.supplyMore}`}
        </div>
      )}
      {item.actions.length > 0 && (
        <div className="r6">
          {item.actions.map((action) => {
            const href = actionHref(action, item.upstreamId, links);
            return href
              ? <a key={action} className="jy-link" href={href} target="_blank" rel="noreferrer">{U.actions[action]}</a>
              : <span key={action} className="jy-muted">{U.actions[action]}</span>;
          })}
        </div>
      )}
    </li>
  );
}

export function UpstreamCards({ page, onOpenModel }: { page: LoadedPage; onOpenModel: (name: string) => void }) {
  const items = page.headroom.upstreams;
  return (
    <Panel
      className="jy-models-upstreams"
      title={COPY.upstreamsTitle}
      body={false}
      foot={COPY.upstream.foot}
    >
      {items.length ? (
        <ul className="jy-hcards">
          {items.map((item) => <Card key={item.upstreamId ?? "unbound"} item={item} page={page} onOpenModel={onOpenModel} />)}
        </ul>
      ) : <p className="jy-models-empty jy-muted">{COPY.upstreamsNone}</p>}
    </Panel>
  );
}
