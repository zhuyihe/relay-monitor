"use client";
// 自营业务：自营站点的用户收入、上游成本、毛利与净利，按概览 / 用户 / 模型与渠道分标签。
// 数据来自 /api/own/analytics（同范围 60 秒内复用成功结果，约 30 秒自动刷新一次）；
// 近 7 / 30 天另取 /api/analytics 的逐日上游成本，画每日收入、成本与净利（它慢，不挡着页面先出来）；
// 时间窗口都按服务端的业务时区划日，不传浏览器时区；
// 按明细细算另走 /api/own/audit，开销大，只在点按钮时请求。
import "../../styles/pages/my.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "antd";
import { api } from "../../../lib/client";
import { NAV_LABELS } from "../../../lib/brand";
import { OWN_STATION_UNSET_TITLE, RANGE_TEXT } from "../../../lib/format";
import { ErrorState, Onboarding, PanelSkeleton, RefreshFailedBanner } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { EQ_TEXT, ProfitEquation } from "../../components/profit-equation";
import { RangePicker } from "../../components/range-picker";
import { TabPanel, Tabs } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useUrlState } from "../../components/use-url-state";
import { ModelsTab } from "./models-tab";
import { FC_TITLE, OverviewTab } from "./overview-tab";
import { describeError } from "../../../lib/error-copy";
import { RANGES, RANGE_OPTIONS, TABS, TAB_TEXT, deriveOwn } from "./shared";
import type { MyTab, OwnRange } from "./shared";
import { UsersTab } from "./users-tab";

const TAB_DEFS: { key: MyTab; label: string }[] = TABS.map((key) => ({ key, label: TAB_TEXT[key] }));

// 只在这一页出现的说法（design/ui-copy-spec.md §11）
const COPY = {
  setupDesc: "自营业务会汇总自营站点的收入：减去上游成本得出毛利，再减去固定成本得出净利。",
  setupSteps: [
    { title: "在上游资源里编辑你的 New API 站点", desc: "打开「这是我的自营站点」。" },
    { title: "填写超级管理员的访问令牌", desc: "用于读取用户、渠道和用量记录，只读，不会改动自营站点。" },
    { title: "回到这里查看利润", desc: "设置好后刷新本页，之后每 30 秒自动更新。" },
  ],
  setupFigure: "设置完成后，这里会算出毛利和净利，并列出消费最多的用户和模型。",
  setup: "去设置",
  unreadable: "读不到自营站点的数据",
  topUsers: "消费最多的用户",
  tabsLabel: "自营业务视图",
};

export default function MyStationPage() {
  const router = useRouter();
  // 默认近 7 天：「今天」在早上几乎是空的，首屏看不出走势
  const [range, setRange] = useUrlState<OwnRange>("range", "7d", RANGES);
  const [tab, setTab] = useUrlState<MyTab>("tab", "overview", TABS);

  // data 是最近一次成功的结果（可能是上一个范围的，换范围时先留着变淡显示）
  const [data, setData] = useState<any>(null);
  // 与 data 同一范围的逐日上游成本；undefined 是还在取，取不到时是 { error }，只影响趋势图
  const [costs, setCosts] = useState<any>(undefined);
  const [err, setErr] = useState<{ range: string; error: Error } | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);

  // 按明细细算（开销大，只在点按钮时才逐条看用量记录）
  const [audit, setAudit] = useState<any>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<Error | null>(null);
  const [auditRows, setAuditRows] = useState(4000);
  const [auditOpen, setAuditOpen] = useState(false);

  // 客户端缓存：同范围 60 秒内直接复用；逐日成本失败的结果不复用，下次照常重取
  const cacheRef = useRef<Record<string, { at: number; data: any; costs?: any }>>({});
  const rangeRef = useRef<string>(range);
  rangeRef.current = range;

  const load = useCallback(async (force: boolean, r: string = rangeRef.current, rethrow = false) => {
    const cached = cacheRef.current[r];
    if (!force && cached && !cached.costs?.error && Date.now() - cached.at < 60000) {
      setData(cached.data);
      setCosts(cached.costs);
      setErr(null);
      setUnconfigured(false);
      setAsOf(cached.at);
      return;
    }
    // 逐日成本单独等：自营数据先渲染，趋势图晚一点补上
    const costReq =
      r === "today"
        ? Promise.resolve(null)
        : api(`/api/analytics?days=${r === "7d" ? 7 : 30}`).catch((e: any) => ({ error: e }));
    try {
      const res = await api(`/api/own/analytics?range=${r}`);
      // 新的逐日成本回来前先沿用上一份成功的，免得每次轮询趋势图都闪一下
      const entry: { at: number; data: any; costs?: any } = {
        at: Date.now(),
        data: res,
        costs: cached?.costs?.error ? undefined : cached?.costs,
      };
      cacheRef.current[r] = entry;
      costReq.then((cost) => {
        entry.costs = cost;
        if (rangeRef.current === r && cacheRef.current[r] === entry) setCosts(cost);
      });
      // 响应回来时范围已切走则丢弃
      if (rangeRef.current !== r) return;
      setData(res);
      setCosts(entry.costs);
      setErr(null);
      setUnconfigured(false);
      setAsOf(Date.now());
    } catch (e: any) {
      if (rangeRef.current !== r) return;
      // 没设置自营站点是引导场景，不当错误处理（接口带 OWN_STATION_UNSET，lib/error-copy.js）
      if (describeError(e).category === "unset") {
        setUnconfigured(true);
        setErr(null);
        return;
      }
      setErr({ range: r, error: e });
      // 顶栏刷新要拿到失败，由外壳提示
      if (rethrow) throw e;
    }
  }, []);

  // 范围变化立即拉取；约 30 秒自动刷新一次，切回标签页立即刷一次
  useEffect(() => {
    load(false, range);
    const timer = setInterval(() => load(true), 30000);
    const onVis = () => {
      if (!document.hidden) load(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [range, load]);

  // 范围一换，上一次细算的结果就不是这段时间的了
  useEffect(() => {
    setAudit(null);
    setAuditError(null);
  }, [range]);

  const runAudit = async () => {
    const r = rangeRef.current;
    setAuditing(true);
    setAuditError(null);
    try {
      const res = await api(`/api/own/audit?range=${r}&maxRows=${auditRows}`);
      if (rangeRef.current === r) setAudit(res);
    } catch (e: any) {
      if (rangeRef.current === r) {
        setAuditError(e);
        setAudit(null);
      }
    } finally {
      setAuditing(false);
    }
  };

  const reload = useCallback(() => load(true), [load]);
  const onRefresh = useCallback(() => load(true, rangeRef.current, true), [load]);

  // 外壳会把范围控件渲染两次，元素要稳定；没设置自营站点时不给范围
  const rangePicker = useMemo(
    () => (unconfigured ? undefined : <RangePicker value={range} options={RANGE_OPTIONS} onChange={(x) => setRange(x as OwnRange)} />),
    [unconfigured, range, setRange],
  );
  useShellPage({ onRefresh, asOf, range: rangePicker, tz: costs?.tz || data?.tz });

  const view = useMemo(() => (data ? deriveOwn(data) : null), [data]);

  if (unconfigured) {
    return (
      <div className="jy-page">
        <Onboarding
          title={OWN_STATION_UNSET_TITLE}
          desc={COPY.setupDesc}
          steps={COPY.setupSteps}
          action={
            <Button type="primary" size="large" onClick={() => router.push("/stations")}>
              {COPY.setup}
            </Button>
          }
          figureNote={COPY.setupFigure}
        />
      </div>
    );
  }

  const currentErr = err && err.range === range ? err : null;
  // 没有数据，或手里只有别的范围的旧数据而当前范围失败了：整页报错
  if (!view || (currentErr && data.range !== range)) {
    if (currentErr) {
      return (
        <div className="jy-page">
          <Panel label={NAV_LABELS.my}>
            <ErrorState center what={COPY.unreadable} error={currentErr.error} onRetry={() => load(true)} />
          </Panel>
        </div>
      );
    }
    const blank = { value: null };
    return (
      <div className="jy-page" aria-busy="true">
        <ProfitEquation title={EQ_TEXT.business(RANGE_TEXT[range])} revenue={blank} upstream={blank} fixed={blank} loading />
        <PanelSkeleton title="收入与上游成本" height={220} />
        <div className="jy-grid-2 jy-grid-even">
          <PanelSkeleton title={FC_TITLE} lines={5} />
          <PanelSkeleton title={COPY.topUsers} lines={5} />
        </div>
      </div>
    );
  }

  const stale = data.range !== range;
  // 标签内容的说明文字跟着手里数据的范围走，避免旧数据配新标题
  const shown = (RANGES as readonly string[]).includes(data.range) ? (data.range as OwnRange) : range;
  const audits = {
    audit,
    auditing,
    auditError,
    auditRows,
    setAuditRows,
    run: runAudit,
    open: auditOpen,
    setOpen: setAuditOpen,
    rate: view.rate,
  };

  return (
    <div className="jy-page">
      {currentErr && (
        // 自动刷新失败不清空页面，保留上次的数据
        <RefreshFailedBanner asOf={asOf} tz={data.tz} error={currentErr.error} onRetry={() => load(true)} />
      )}
      <Tabs<MyTab>
        tabs={TAB_DEFS}
        active={tab}
        onChange={setTab}
        idPrefix="my"
        label={COPY.tabsLabel}
        extra={
          <Button icon={<Icon name="gear" />} onClick={() => router.push("/stations")}>
            {COPY.setup}
          </Button>
        }
      />
      {/* 外层包一层：隐藏的标签面板不参与页面的间距 */}
      <div className={stale ? "jy-my-busy" : undefined} aria-busy={stale || undefined}>
        <TabPanel idPrefix="my" tabKey="overview" active={tab === "overview"}>
          <OverviewTab v={view} costs={costs} range={shown} asOf={asOf} onRange={setRange} onTab={setTab} reload={reload} />
        </TabPanel>
        <TabPanel idPrefix="my" tabKey="users" active={tab === "users"}>
          <UsersTab v={view} range={shown} reload={reload} />
        </TabPanel>
        <TabPanel idPrefix="my" tabKey="models" active={tab === "models"}>
          <ModelsTab v={view} range={shown} reload={reload} audit={audits} />
        </TabPanel>
      </div>
    </div>
  );
}
