"use client";
// 自营业务：自营站点的下游收入、上游成本与毛利，按概览 / 用户 / 模型与渠道分标签。
// 数据来自 /api/own/analytics（同范围 60 秒内复用，约 30 秒自动刷新一次）；
// 近 7 / 30 天另取 /api/analytics 的逐日上游成本，画每日收入、成本与毛利；
// 日志精算另走 /api/own/audit，开销大，只在点按钮时请求。
import "../../styles/pages/my.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "antd";
import { api } from "../../../lib/client";
import { formatHhmm } from "../../../lib/format";
import { ErrorState, Onboarding, PanelSkeleton } from "../../components/data-state";
import { Icon, Sym } from "../../components/icons";
import { Panel } from "../../components/panel";
import { ProfitEquation } from "../../components/profit-equation";
import { RangePicker } from "../../components/range-picker";
import { TabPanel, Tabs } from "../../components/seg";
import { useShellPage } from "../../components/shell-context";
import { useUrlState } from "../../components/use-url-state";
import { ModelsTab } from "./models-tab";
import { OverviewTab } from "./overview-tab";
import { RANGES, RANGE_OPTIONS, TABS, deriveOwn, isUnconfigured, productErrorMessage } from "./shared";
import type { MyTab, OwnRange } from "./shared";
import { UsersTab } from "./users-tab";

const TAB_DEFS: { key: MyTab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "users", label: "用户" },
  { key: "models", label: "模型与渠道" },
];

const tzName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function MyStationPage() {
  const router = useRouter();
  const [range, setRange] = useUrlState<OwnRange>("range", "today", RANGES);
  const [tab, setTab] = useUrlState<MyTab>("tab", "overview", TABS);

  // data 是最近一次成功的结果（可能是上一个范围的，换范围时先留着变淡显示）
  const [data, setData] = useState<any>(null);
  // 与 data 同一范围的逐日上游成本；取不到时是 { error }，只影响趋势图
  const [costs, setCosts] = useState<any>(null);
  const [err, setErr] = useState<{ range: string; msg: string } | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);

  // 日志精算（开销大，只在点按钮时才翻日志）
  const [audit, setAudit] = useState<any>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState(4000);
  const [auditOpen, setAuditOpen] = useState(false);

  // 客户端缓存：同范围 60 秒内直接复用
  const cacheRef = useRef<Record<string, { at: number; data: any; costs: any }>>({});
  const rangeRef = useRef<string>(range);
  rangeRef.current = range;

  const load = useCallback(async (force: boolean, r: string = rangeRef.current, rethrow = false) => {
    const cached = cacheRef.current[r];
    if (!force && cached && Date.now() - cached.at < 60000) {
      setData(cached.data);
      setCosts(cached.costs);
      setErr(null);
      setUnconfigured(false);
      setAsOf(cached.at);
      return;
    }
    try {
      const [res, cost] = await Promise.all([
        api(`/api/own/analytics?range=${r}&tz=${encodeURIComponent(tzName())}`),
        r === "today"
          ? null
          : api(`/api/analytics?days=${r === "7d" ? 7 : 30}`).catch((e: any) => ({ error: productErrorMessage(e) })),
      ]);
      cacheRef.current[r] = { at: Date.now(), data: res, costs: cost };
      // 响应回来时范围已切走则丢弃
      if (rangeRef.current !== r) return;
      setData(res);
      setCosts(cost);
      setErr(null);
      setUnconfigured(false);
      setAsOf(Date.now());
    } catch (e: any) {
      if (rangeRef.current !== r) return;
      // 没标记自营站点是引导场景，不当错误处理
      if (isUnconfigured(e)) {
        setUnconfigured(true);
        setErr(null);
        return;
      }
      setErr({ range: r, msg: productErrorMessage(e) });
      // 顶栏刷新要拿到失败，由外壳提示
      if (rethrow) throw new Error(productErrorMessage(e));
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

  // 范围一换，上一次的精算结果就不是这个窗口的了
  useEffect(() => {
    setAudit(null);
    setAuditError(null);
  }, [range]);

  const runAudit = async () => {
    const r = rangeRef.current;
    setAuditing(true);
    setAuditError(null);
    try {
      const res = await api(`/api/own/audit?range=${r}&tz=${encodeURIComponent(tzName())}&maxRows=${auditRows}`);
      if (rangeRef.current === r) setAudit(res);
    } catch (e: any) {
      if (rangeRef.current === r) {
        setAuditError(productErrorMessage(e));
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
  useShellPage({ onRefresh, asOf, range: rangePicker });

  const view = useMemo(() => (data ? deriveOwn(data) : null), [data]);

  if (unconfigured) {
    return (
      <div className="jy-page">
        <Onboarding
          title="还没有设置自营站点"
          desc="自营业务会汇总你自己站点的下游收入，再减去上游用量成本和固定成本，得出期内毛利。"
          steps={[
            { title: "在上游资源中找到你自己的站点", desc: "编辑它，打开“这是我的自营站点”。" },
            { title: "填写管理员访问令牌", desc: "用于读取下游用户和渠道计费数据，只读，不会改动站点。" },
            { title: "回到这里查看毛利", desc: "设置好后刷新本页，之后每 30 秒自动更新。" },
          ]}
          action={
            <Button type="primary" size="large" onClick={() => router.push("/stations")}>
              前往上游资源设置
            </Button>
          }
          figureNote="设置完成后，这里会算出期内毛利，并列出消费最多的用户和模型。"
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
          <Panel label="自营业务">
            <ErrorState center title="自营业务数据加载失败" error={currentErr.msg} onRetry={() => load(true)} />
          </Panel>
        </div>
      );
    }
    const blank = { value: null };
    return (
      <div className="jy-page" aria-busy="true">
        <ProfitEquation title="期内经营" revenue={blank} usage={blank} fixed={blank} loading />
        <PanelSkeleton title="收入与用量成本" height={220} />
        <div className="jy-grid-2 jy-grid-even">
          <PanelSkeleton title="消费预测" lines={5} />
          <PanelSkeleton title="消费最多的用户" lines={5} />
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
        // 轮询失败不清空页面，保留上次的数据
        <div className="jy-banner" role="status">
          <Sym kind="warn" />
          <div>
            最新数据获取失败，显示的是 {formatHhmm(asOf)} 的数据。
            <span className="jy-sub-money">{currentErr.msg}</span>
          </div>
          <Button size="small" className="jy-my-banner-action" onClick={() => load(true)}>
            重试
          </Button>
        </div>
      )}
      <Tabs<MyTab>
        tabs={TAB_DEFS}
        active={tab}
        onChange={setTab}
        idPrefix="my"
        label="自营业务视图"
        extra={
          <Button icon={<Icon name="gear" />} onClick={() => router.push("/stations")}>
            站点设置
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
