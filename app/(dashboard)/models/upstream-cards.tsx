"use client";
// 「按上游看」（design 模型供需 v4 §4）：每家上游一张卡片——余额跑道、上限和高峰用了多少、满了还是还空着、被挡按原因分、供哪些模型、带 ↗ 的动作链接。
// 带 ↗ 的链接都跳到用户的站或上游网站，控制台不替用户改任何东西。电脑上这块在框里自己滚（样式在 models.css）。
import { Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { RunwayTrack } from "../../components/runway";
import { COPY } from "./copy";
import { REASON_COLOR } from "./charts";
import { HeadroomBar } from "./headroom-bar";
import { actionHref, approx, upstreamLimitText, upstreamRunway } from "./models-format";
import type { ModelsPage, UpstreamHeadroom } from "./models-format";

const SHOWN_REASONS = ["rate_limit", "upstream", "auth_quota"] as const;

export function upstreamDomId(id: string | null) { return `jy-up-${id ?? "unbound"}`; }

function Card({ item, page, onOpenModel }: { item: UpstreamHeadroom; page: ModelsPage; onOpenModel: (name: string) => void }) {
  const U = COPY.upstream, { headroom, critDays } = page, state = headroom.state;
  const runway = upstreamRunway(item.hoursLeft, critDays);
  const room = item.room;
  const roomText = item.full ? null : room == null ? null : item.limit.kind === "atLeast" ? U.roomAtLeast(approx(room)) : U.room(approx(room));
  const showUsage = item.limit.kind === "measured" || item.limit.kind === "atLeast";
  const links = headroom.links;
  return (
    <li id={upstreamDomId(item.upstreamId)} className="jy-hcard" tabIndex={-1}>
      <div className="r1">
        <b>{item.name ?? U.unboundName}</b>
        <span className="jy-hcard-runway">
          {runway && (<><RunwayTrack mini days={runway.days} level={runway.level} critDays={critDays} /><span>{runway.text}</span></>)}
        </span>
      </div>
      <div className="r2">
        {showUsage && item.limit.value != null
          ? <>{upstreamLimitText(item, state)} · {U.used(item.peakUsed == null ? COPY.dash : approx(item.peakUsed))}</>
          : <span className="jy-muted">{upstreamLimitText(item, state)}</span>}
      </div>
      {showUsage && (
        <div className="r3">
          <HeadroomBar need={item.peakUsed} supply={item.limit} label={item.full ? U.full : roomText ?? ""} />
          {item.full
            ? <span className="jy-hfull"><Sym kind="crit" />{U.full}</span>
            : roomText && <span className="jy-caption">{roomText}</span>}
        </div>
      )}
      {item.blocked24 && (
        <div className="r4 jy-caption">
          {SHOWN_REASONS.map((reason) => (
            <span key={reason} className="jy-hreason"><i style={{ background: REASON_COLOR[reason] }} />{U.reasonCount(U.reasons[reason], item.blocked24![reason])}</span>
          ))}
        </div>
      )}
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

export function UpstreamCards({ page, onOpenModel }: { page: ModelsPage; onOpenModel: (name: string) => void }) {
  const items = page.headroom.upstreams;
  return (
    <Panel
      className="jy-models-upstreams"
      title={COPY.upstreamsTitle}
      caption={COPY.unit}
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
