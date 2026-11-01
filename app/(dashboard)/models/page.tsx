"use client";
// 模型供需：哪些模型缺货、每天少收多少、去哪找货（design 模型供需 v1）。
// 数据来自 /api/models（只在有人打开这一页时读自营站点，读完缓存 10 分钟，页面不自己轮询）；顶栏没有时间范围：近 7 天、近 24 小时、近 30 天是固定的口径。
// 排法和打开的模型都写进地址栏（?sort=&dir=&model=），刷新、分享链接、后退键都回到同一屏；模型名里有「/」也照写，不放进路径。
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
import { More } from "../../components/more";
import { Panel } from "../../components/panel";
import { useShellPage } from "../../components/shell-context";
import { useUrlParams } from "../../components/use-url-state";
import { COPY } from "./copy";
import { ModelDrawer } from "./model-drawer";
import { MY_LINK, SORT_KEYS, howNumbers, kpisOf, parseSort } from "./models-format";
import type { ModelsPage, Sort } from "./models-format";
import { ModelsTable } from "./models-table";

const SETUP = workflowAction("setup_own_station");

export default function ModelsPageRoute() {
  const [params, setParams] = useUrlParams();
  const sort = parseSort(params.get("sort"), params.get("dir"));
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

  const onSort = (next: Sort) => setParams({ sort: next ? next.key : null, dir: next ? next.dir : null });
  const open = (name: string) => setParams({ model: name });
  const close = () => setParams({ model: null });

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

  const kpis = kpisOf(page);
  const how = COPY.how, nums = howNumbers(page.rate);
  return (
    <div className="jy-page jy-models-page">
      {err && <RefreshFailedBanner asOf={page.asOf} tz={page.tz} error={err} onRetry={() => load()} />}
      <p className="jy-caption jy-models-note">{COPY.readNote(formatZonedTime(page.asOf, page.tz))}</p>
      {page.perfEmpty && <p className="jy-caption jy-models-perf-empty" role="status">{COPY.perfEmpty}</p>}
      <Panel label={COPY.kpiLabel}>
        <dl className="jy-kpis jy-models-kpis">
          {kpis.map((kpi) => (
            <div key={kpi.key}>
              <dt>{kpi.title}</dt>
              <dd className="jy-kpi-figure">{kpi.value}</dd>
              <dd className="jy-caption">
                {kpi.model && <><button type="button" className="jy-link jy-models-linkbtn" onClick={() => open(kpi.model!)}>{kpi.model}</button>{kpi.more ? ` ${kpi.more}` : ""}：</>}
                {kpi.sub}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
      <ModelsTable page={page} sort={sort} onSort={onSort} onOpen={open} />
      <More label={how.title}>
        <ul className="jy-models-how">
          <li><b>{how.successTitle}</b>{how.success(nums.minRequests)}</li>
          <li><b>{how.blindTitle}</b>{how.blind}</li>
          <li><b>{how.lostTitle}</b>{how.lost(nums.failPct)}</li>
          <li><b>{how.otherTitle}</b>{how.other(nums.soonDays, nums.ratio, nums.minPrev)}</li>
          <li><b>{how.supplyTitle}</b>{how.supply}</li>
          <li><b>{how.smallTitle}</b>{how.small(nums.minShare)}</li>
        </ul>
      </More>
      <p className="jy-models-foot"><Link className="jy-link" href={MY_LINK}>{COPY.toMy}</Link></p>
      <ModelDrawer name={model} page={page} onClose={close} />
    </div>
  );
}
