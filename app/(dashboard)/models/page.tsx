"use client";
// 模型供需：近 24 小时哪些模型缺货失败、少收了多少、明天预计还会失败多少、该怎么办（design 模型供需 v5）。页面只写结论、数字、该做什么，不讲算法。
// 数据来自 /api/models 的 headroom.lost 和 headroom.upstreams（只在有人打开这一页时读，读完缓存 10 分钟，页面不自己轮询）；顶栏没有时间范围：近 24 小时是固定的口径。
// 电脑上一屏放下、页面本身不滚：顶上三个数，下面左边「近 24 小时缺货的模型」（9 列）、右边「按上游看」（3 列），两块各自在框里滚、表头固定。
// 打开的模型写进地址栏（?model=），刷新、分享链接、后退键都回到同一屏；模型名里有「/」也照写，不放进路径。
import "../../styles/pages/models.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "antd";
import { api } from "../../../lib/client";
import { NAV_LABELS } from "../../../lib/brand";
import { OWN_STATION_UNSET_STEP, OWN_STATION_UNSET_TITLE, formatZonedTime } from "../../../lib/format";
import { describeError } from "../../../lib/error-copy";
import { workflowAction } from "../../../lib/workflow-actions";
import { ErrorState, Onboarding, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { Panel } from "../../components/panel";
import { useShellPage } from "../../components/shell-context";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import { ModelDrawer } from "./model-drawer";
import { USERS_LINK, kpisOf } from "./models-format";
import type { LoadedPage, ModelsPage } from "./models-format";
import { ModelsTable } from "./models-table";
import { UpstreamCards, upstreamDomId } from "./upstream-cards";

const SETUP = workflowAction("setup_own_station");

export default function ModelsPageRoute() {
  const [params, setParams] = useUrlParams();
  const model = params.get("model") || null;
  const [page, setPage] = useState<ModelsPage | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [unset, setUnset] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async (rethrow = false) => {
    const mine = ++latest.current;
    try {
      const res = await api("/api/models");
      if (mine !== latest.current) return;
      setPage(res); setUnset(false); setErr(null);
    } catch (e: any) {
      if (mine !== latest.current) return;
      // 没设置自营站点是引导场景，不当错误
      if (describeError(e).category === "unset") { setUnset(true); setErr(null); return; }
      setErr(e);
      if (rethrow) throw e;
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => load(true), [load]);
  // 「数据截至」写这份数读的时刻（服务端 10 分钟内不重读，页面上写的和服务端一致）
  useShellPage({ onRefresh, asOf: unset ? null : page?.asOf ?? null, tz: page?.tz });

  const open = (name: string) => setParams({ model: name });
  const close = () => setParams({ model: null });
  // 顶上「快没钱的上游」点名字：滚到右边那张卡片
  const toUpstream = (id: string) => {
    const el = document.getElementById(upstreamDomId(id));
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  };

  if (unset) {
    return (
      <div className="jy-page">
        <Onboarding
          title={OWN_STATION_UNSET_TITLE}
          desc={COPY.setupDesc}
          steps={[OWN_STATION_UNSET_STEP]}
          action={SETUP.href ? <Link href={SETUP.href}><Button type="primary" size="large">{SETUP.label}</Button></Link> : undefined}
          figureNote={COPY.setupFigure}
        />
      </div>
    );
  }
  if (!page) {
    if (err) {
      return (
        <div className="jy-page">
          <Panel label={NAV_LABELS.models}>
            <ErrorState center what={COPY.unreadable} error={err} onRetry={() => load()} />
          </Panel>
        </div>
      );
    }
    return (
      <div className="jy-page" aria-busy="true">
        <PanelSkeleton title={COPY.kpiLabel} lines={2} />
        <PanelSkeleton title={COPY.tableTitle} height={300} />
      </div>
    );
  }

  // 这一次没算出来（数据量太大、没有数据库或读库出错）：只写一句，不画下面这些
  if (!page.headroom) {
    return (
      <div className="jy-page">
        {err && <RefreshFailedBanner asOf={page.asOf} tz={page.tz} error={err} onRetry={() => load()} />}
        <Panel label={NAV_LABELS.models}>
          <p className="jy-models-empty jy-muted" role="status">{COPY.none.notComputed}</p>
        </Panel>
      </div>
    );
  }
  const loaded = page as LoadedPage;
  const kpis = kpisOf(loaded);
  return (
    <div className="jy-page jy-models-page">
      {err && <RefreshFailedBanner asOf={page.asOf} tz={page.tz} error={err} onRetry={() => load()} />}
      <section className="jy-models-kpis-wrap" aria-label={COPY.kpiLabel}>
        <dl className="jy-kpis jy-models-kpis">
          {kpis.map((kpi) => (
            <div key={kpi.key}>
              <dt>{kpi.title}</dt>
              <dd className="jy-kpi-figure">{kpi.value}</dd>
              {(kpi.sub || kpi.before || kpi.lead || kpi.after || kpi.users != null) && (
                <dd className="jy-caption">
                  {kpi.before}
                  {kpi.lead && <button type="button" className="jy-link jy-models-linkbtn" onClick={() => (kpi.lead!.kind === "model" ? open(kpi.lead!.id) : toUpstream(kpi.lead!.id))}>{kpi.lead.name}</button>}
                  {kpi.after}
                  {kpi.sub}
                  {kpi.users != null && <>{kpi.sub ? " · " : ""}<Link className="jy-link" href={USERS_LINK}>{COPY.kpi.last24Users(kpi.users)}</Link></>}
                </dd>
              )}
            </div>
          ))}
        </dl>
        <p className="jy-caption jy-models-note">{COPY.asOf(formatZonedTime(page.asOf, page.tz))}</p>
      </section>
      <div className="jy-models-grid">
        <ModelsTable page={loaded} onOpen={open} />
        <UpstreamCards page={loaded} onOpenModel={open} />
      </div>
      <ModelDrawer name={model} page={loaded} onClose={close} />
    </div>
  );
}
