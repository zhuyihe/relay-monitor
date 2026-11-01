"use client";
// 用户和分组：用户 × 分组组合的消费，最多 15 项，用来找出是谁在哪个分组涨了。
// 原来在自营业务的「用户」标签里，原样搬到这里，放在用户表最下面的收起区（默认收起，ui-design-spec §4.11 的 More）。
// 数据来自 /api/own/analytics（比较重，要读自营站点），所以展开以后才读；时间范围在收起区里自己选，默认近 7 天。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/client";
import { EMPTY, formatCompact, formatInt } from "../../../lib/format";
import { ErrorState, PanelSkeleton } from "../../components/data-state";
import { More } from "../../components/more";
import { CountBadge } from "../../components/panel";
import { Seg } from "../../components/seg";
import { COL_TEXT, DataTable, Delta, FLOW_UNREADABLE, MY_TEXT, RANGE_OPTIONS, TOKEN_NOTE, deltaSortValue, deriveOwn, money, perM } from "../my/shared";
import type { OwnRange, UsageRow } from "../my/shared";
import { COPY } from "./copy";

// 接口的 key 是"用户 · 分组"，从最后一个分隔符拆开，用户名里带点也不会拆错
const split = (key: string) => {
  const i = String(key).lastIndexOf(" · ");
  return i < 0 ? [key, ""] : [key.slice(0, i), key.slice(i + 3)];
};

export function UserGroups() {
  return (
    <section className="jy-panel jy-users-groups" aria-label={COPY.groups.title}>
      <div className="jy-panel-body">
        <More label={COPY.groups.title}>
          <GroupsBody />
        </More>
      </div>
    </section>
  );
}

// 展开才挂载，也就是展开才读
function GroupsBody() {
  const [range, setRange] = useState<OwnRange>("7d");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (r: OwnRange) => {
    setError(null);
    try { setData(await api(`/api/own/analytics?range=${r}`)); } catch (e) { setError(e); }
  }, []);
  useEffect(() => { void load(range); }, [load, range]);
  const view = useMemo(() => (data ? deriveOwn(data) : null), [data]);
  const stale = !!data && data.range !== range;

  const seg = (
    <Seg<OwnRange> size="sm" label={COPY.groups.rangeLabel} value={range} onChange={setRange} options={RANGE_OPTIONS} />
  );
  let body;
  if (error && (!view || stale)) body = <ErrorState what={COPY.groups.unreadable} error={error} onRetry={() => void load(range)} />;
  else if (!view || stale) body = <PanelSkeleton lines={4} />;
  else if (view.d.flow?.error) body = <ErrorState what={FLOW_UNREADABLE} error={view.d.flow} onRetry={() => void load(range)} />;
  else {
    const rows = view.toCny(view.d.flow?.byUserGroup || []);
    body = (
      <DataTable<UsageRow>
        caption={COPY.groups.caption}
        rows={rows}
        rowKey={(r) => String(r.key)}
        defaultSort={{ key: "cost", dir: "desc" }}
        empty={MY_TEXT.noData}
        cols={[
          { key: "user", label: COL_TEXT.user, sort: (r) => split(r.key)[0], render: (r) => split(r.key)[0] },
          { key: "group", label: COL_TEXT.group, sort: (r) => split(r.key)[1], render: (r) => split(r.key)[1] || <span className="jy-muted">{EMPTY}</span> },
          { key: "req", label: COL_TEXT.requests, num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests) },
          { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost) },
          { key: "prev", label: COL_TEXT.prev, title: view.prevLabel, num: true, sort: (r) => r.prevCost, render: (r) => money(r.prevCost) },
          { key: "delta", label: COL_TEXT.delta, title: view.prevLabel, num: true, sort: deltaSortValue, render: (r) => <Delta pct={r.deltaPct} isNew={r.isNew} /> },
          { key: "tok", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.tokens, render: (r) => formatCompact(r.tokens) },
          { key: "perM", label: COL_TEXT.perM, title: COL_TEXT.perMTitle, num: true, sort: (r) => (r.tokens > 0 ? r.cost / r.tokens : null), render: (r) => perM(r.cost, r.tokens) },
        ]}
      />
    );
  }
  return (
    <div className="jy-users-groups-body" aria-busy={(!view || stale) && !error ? true : undefined}>
      <div className="jy-users-groups-head">
        <p className="jy-caption">{COPY.groups.sub}</p>
        <span className="spacer" />
        {view && !stale && <CountBadge count={(view.d.flow?.byUserGroup || []).length} muted />}
        {seg}
      </div>
      {body}
    </div>
  );
}
