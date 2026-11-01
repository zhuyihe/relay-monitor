"use client";
// 模型供需：今晚高峰哪些模型的货不够、还差多少、补几把 Key、先救谁（design 模型供需 v4）。
// 数据来自 /api/models 的 headroom（只在有人打开这一页时读，读完缓存 10 分钟，页面不自己轮询）；顶栏没有时间范围：近 7 天、近 24 小时是固定的口径。
// 电脑上一屏放下、页面本身不滚：顶上三个数，下面左边「今晚高峰的余量」（9 列）、右边「按上游看」（3 列），两块各自在框里滚、表头固定。
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
import { Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { useShellPage } from "../../components/shell-context";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import { ModelDrawer } from "./model-drawer";
import { kpisOf } from "./models-format";
import type { LoadedPage, ModelsPage } from "./models-format";
import { ModelsTable } from "./models-table";
import { UpstreamCards, upstreamDomId } from "./upstream-cards";

const SETUP = workflowAction("setup_own_station");

// 拿不到数据的两种情况和没开整站消费日志，页顶一条提示条（v4 §6）
function StateBanners({ page }: { page: LoadedPage }) {
  const { state, noErrorLogReason, errorLog, consumeLog } = page.headroom, B = COPY.banner;
  const days = errorLog.coveredDays == null ? "" : errorLog.coveredDays < 1 ? B.daysUnder1 : B.days(Math.floor(errorLog.coveredDays));
  return (
    <>
      {state === "noErrorLog" && noErrorLogReason !== "noRecords" && (
        <div className="jy-banner" role="status">
          <Sym kind="warn" />
          <div className="jy-banner__body"><span><b>{B.switchOffLead}</b> {B.switchOff}</span></div>
        </div>
      )}
      {state === "noErrorLog" && noErrorLogReason === "noRecords" && (
        <div className="jy-banner jy-banner--info" role="status">
          <Sym kind="info" />
          <div className="jy-banner__body"><span>{B.noRecordsLead}</span></div>
        </div>
      )}
      {state === "accumulating" && (
        <div className="jy-banner jy-banner--info" role="status">
          <span className="jy-hspin" aria-hidden="true" />
          <div className="jy-banner__body"><span><b>{B.accumulatingLead(days, errorLog.needDays)}</b> {B.accumulating(errorLog.daysLeft ?? errorLog.needDays)}</span></div>
        </div>
      )}
      {!consumeLog && (
        <div className="jy-banner jy-banner--info" role="status">
          <Sym kind="info" />
          <div className="jy-banner__body"><span>{B.noConsumeLead}</span></div>
        </div>
      )}
    </>
  );
}

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

  // 高峰余量这一次没算出来（没有数据库、读库出错）：整页写「读不到」，不画下面这些
  if (!page.headroom) {
    return (
      <div className="jy-page">
        {err && <RefreshFailedBanner asOf={page.asOf} tz={page.tz} error={err} onRetry={() => load()} />}
        <Panel label={NAV_LABELS.models}>
          <ErrorState center what={COPY.headroomNull} error={new Error("headroom unavailable")} onRetry={() => load()} />
        </Panel>
      </div>
    );
  }
  const loaded = page as LoadedPage;
  const kpis = kpisOf(loaded, loaded.headroom);
  return (
    <div className="jy-page jy-models-page">
      {err && <RefreshFailedBanner asOf={page.asOf} tz={page.tz} error={err} onRetry={() => load()} />}
      <StateBanners page={loaded} />
      <section className="jy-models-kpis-wrap" aria-label={COPY.kpiLabel}>
        <dl className="jy-kpis jy-models-kpis">
          {kpis.map((kpi) => (
            <div key={kpi.key}>
              <dt>{kpi.title}</dt>
              <dd className="jy-kpi-figure">{kpi.value}</dd>
              <dd className="jy-caption">
                {kpi.lead && (kpi.lead.kind === "model"
                  ? <>{COPY.kpi.worstPrefix}<button type="button" className="jy-link jy-models-linkbtn" onClick={() => open(kpi.lead!.id)}>{kpi.lead.name}</button>{kpi.more ? ` ${kpi.more}` : ""} </>
                  : <><button type="button" className="jy-link jy-models-linkbtn" onClick={() => toUpstream(kpi.lead!.id)}>{kpi.lead.name}</button>{kpi.more ? ` ${kpi.more}` : ""}</>)}
                {kpi.sub}{kpi.subAfter}
                {kpi.extra && <>。碰到 <b>{kpi.extra}</b></>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="jy-caption jy-models-note">{COPY.readNote(formatZonedTime(page.asOf, page.tz))}</p>
      </section>
      <div className="jy-models-grid">
        <ModelsTable page={loaded} onOpen={open} />
        <UpstreamCards page={loaded} onOpenModel={open} />
      </div>
      <ModelDrawer name={model} page={loaded} onClose={close} />
    </div>
  );
}
