"use client";
// 「渠道」页签（K2d，design/ux/binding-flow.md 第 4 节、ui-copy-spec §3.1 / §5.2 / §5.5）：上游 → 渠道 → 用过的 Key。
// 左边是上游列表（有要处理的事的排在前面），右边是选中的上游下面的渠道，每个渠道一张卡片（同一把 Key 的几个渠道是一张）：
// 需处理 > 在算利润 > 没算利润；在算的右上角是「停止算利润」，没在算的是「开始算利润」；最下面是没对上上游的渠道。
// 写操作只有开始 / 停止算利润和「这把 Key 还给别处用吗？」的回答，都走 /api/reconciliation/channels（server/channel-profit.js）；
// 上游列表和编辑抽屉仍由页面持有，更新登录信息的抽屉在 components/account-authorization.tsx。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { App, Button, Modal, Radio } from "antd";
import { api, readWorkflowDestination } from "../../../lib/client";
import type { AccountReadModel, WorkflowDestination } from "../../../lib/client";
import { STATION_TABS } from "../../../lib/brand.js";
import { balanceMoneyOf } from "../../../lib/profit";
import { DEFAULT_BUSINESS_TIME_ZONE } from "../../../lib/business-time.js";
import { COVERAGE_ANSWERS, COVERAGE_QUESTION, coverageDeclarationOf, fillIssueCopy, reconciliationIssue } from "../../../lib/reconciliation-contract.js";
import { EMPTY, formatZonedDate, formatZonedDateTime, formatZonedTime } from "../../../lib/format";
import { failureText, describeError } from "../../../lib/error-copy.js";
import { workflowActionMeta } from "../../../lib/workflow-actions.js";
import { stationDisplayName } from "../../../lib/overview-actions";
import { EmptyState, Skeleton } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import type { ErrorNote } from "../../components/error-detail";
import { Sym } from "../../components/icons";
import { More } from "../../components/more";
import { Panel } from "../../components/panel";
import { loadAccountModel } from "../../components/use-workflow-actions";
import { useAccountAuthorization } from "../../components/account-authorization";

const START = workflowActionMeta("start_profit")!;
const STOP = workflowActionMeta("stop_profit")!;
const ADD_UPSTREAM = workflowActionMeta("add_upstream")!;
const UPDATE_LOGIN = workflowActionMeta("update_authorization")!;
const PAUSE = workflowActionMeta("pause_monitor")!;
const RESUME = workflowActionMeta("resume_monitor")!;
const ANSWER = workflowActionMeta("confirm_coverage")!;

// 只在这个页签出现的说法（用语按 design/ui-copy-spec.md）；共用的名字从 lib/ 取
const COPY = Object.freeze({
  upstreams: "上游",
  needsAction: "需处理",
  running: "在算利润",
  stopped: "没算利润",
  keysUsed: "用过的 Key",
  noOwn: "还没设置自营站点",
  noOwnDesc: "设置好自营站点，系统才能列出你站里的渠道。",
  noUpstream: "还没有上游",
  noChannels: "你站里没有渠道用这个上游的 Key",
  noChannelsDesc: "渠道里换成这个上游的 Key 以后，系统会自己找到",
  noKeyChannels: "没有渠道用它的 Key",
  unmatchedTitle: (n: number) => `没对上上游的渠道 · ${n} 个`,
  keyNotInUpstream: "这个渠道用的 Key 不在已加的上游里",
  keyUnrecognisable: "这类渠道的 Key 系统认不了，利润算不了",
  multiKey: "这个渠道填了几把 Key，这一版还不能开始算利润",
  noBills: "这个上游读不到每天的账单，只能看余额",
  onlyOneKey: "这个上游只填了一把 Key，换 Key 时要来这里改",
  readerNone: "装好读取服务才能开始算利润",
  readerNoneDesc: "读取服务装在你站的服务器上，读你站每个渠道里填的 Key。装好、填好令牌以后，系统会列出能开始算利润的渠道。",
  readerHowTo: "怎么装",
  readerDown: "读不到你站的渠道 Key",
  readerDownDesc: "系统会自己再读；读到以前，不能开始或停止算利润，在算的渠道照常算。",
  loadFailed: "读不到渠道",
  more: (n: number, names: string) => `还有 ${n} 个渠道（${names}）`,
  moreKeys: (n: number) => `再看 ${n} 段`,
  autoStarted: (at: string) => `${at} 起系统自动开始算`,
  answerHint: "别处也在用的话，上游成本会算多；回答之前，利润先不算",
  sub2WholeDay: (day: string) => `这个上游只能按整天读账单，今天（${day}）整天算进来`,
  startDone: "已开始算利润，今天的数已经在每日利润里",
  allStarted: (n: number) => `已开始算利润（${n} 个渠道）`,
  answered: "已保存",
  paused: "暂停监控",
  pausedHint: "暂停监控时不刷新余额，渠道照常算利润。",
  balance: "余额",
  editUpstream: "编辑上游",
});
const ANSWER_HINT: Record<string, string> = {
  none: "",
  external: "上游成本分不开，利润先不算；给这些渠道换一把单独的 Key 就能算",
  unspecified: "上游成本分不开，利润先不算；给这些渠道换一把单独的 Key 就能算",
  unknown: "选「不确定」的话，利润先不算",
};
// 新流程不问「自营站点的其他渠道也在用」（系统读得到所有渠道的 Key）
const ANSWER_OPTIONS = (COVERAGE_ANSWERS as unknown as { value: string; label: string }[]).filter((item) => item.value !== "own_channels");
// 「别处也在用，利润先不算」：回答了「站外也在用」「别处也在用，说不清是哪」以后这条事的写法（§5.2）
const SHARED_ELSEWHERE = Object.freeze({
  title: "这把 Key 别处也在用，利润先不算",
  detail: "上游成本分不开，用它的渠道利润先不算。在你站给这些渠道换一把只给它们用的 Key，系统会自己跟上，从换的时刻起算；不打算换的，停止算这几个渠道的利润",
});

type KeyLine = { fromMs: number; toMs: number | null; between: [number, number] | null; key: { upstreamStationId: string; tokenId: number; tokenName: string | null }; group: string | null; ratio: number | null };
type Card = {
  id: string; state: "attention" | "running" | "stopped"; upstreamStationId: string; channelIds: number[]; names: string[]; ruleId: string | null; tokenName: string | null;
  startedBy: "auto" | "user" | null; startedAtMs: number | null; issues: string[]; keys: KeyLine[]; startGroupKey: string | null; needsCoverage: boolean; optedOut: boolean;
};
type UpstreamRow = { id: string; name: string; type: string; accountUse: string | null; noBills: boolean; channelCount: number; runningCount: number; attentionCount: number };
type Unmatched = { channelId: number; name: string; reason: string; upstreamStationId?: string };
export type ChannelOverview = { ok: true; reader: { state: "ok" | "not_configured" | "unavailable"; code?: string }; upstreams: UpstreamRow[]; cards: Card[]; unmatched: Unmatched[] };

type Props = {
  // 完整上游列表：含暂停监控与归档的上游
  stations: any[];
  types: any[];
  loadingMeta: boolean;
  compact: boolean;
  loaded: boolean;
  loadingList: boolean;
  loadError: Error | null;
  reload: () => Promise<any>;
  // 页面每次读取上游列表后递增，「渠道」页签随之重读
  reloadToken: number;
  // 打开上游的编辑抽屉；不传上游就是「加上游」
  openEditor: (station: any | null) => void;
};

// 渠道名：一个写名字，几个用「、」连，三个以上写「等 N 个渠道」（停止算利润确认框的标题用）
const listNames = (names: string[]) => (names.length <= 2 ? names.join("、") : `${names[0]}等 ${names.length} 个渠道`);

export function useChannelsTab({ stations, types, loadingMeta, compact, loaded, loadingList, loadError, reload, reloadToken, openEditor }: Props): {
  destination: WorkflowDestination | null;
  destinationSeq: number;
  openWorkflow: (href: string) => void;
  center: ReactNode;
  overlays: ReactNode;
} {
  const { message } = App.useApp();
  const [overview, setOverview] = useState<ChannelOverview | null>(null);
  const [overviewError, setOverviewError] = useState<ErrorNote | null>(null);
  // 更新登录信息这类操作没做成时的提示（写在页签顶部，不说成刷新失败）
  const [actionError, setActionError] = useState<ErrorNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [accountModel, setAccountModel] = useState<AccountReadModel | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [destination, setDestination] = useState<WorkflowDestination | null>(null);
  const [destinationSeq, setDestinationSeq] = useState(0);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [stopTarget, setStopTarget] = useState<Card | null>(null);
  const [answerTarget, setAnswerTarget] = useState<{ card: Card; mode: "answer" | "start" } | null>(null);
  const [answerValue, setAnswerValue] = useState<string>("");
  const [answerError, setAnswerError] = useState<ErrorNote | null>(null);
  const [expandedMore, setExpandedMore] = useState<Record<string, boolean>>({});
  const epoch = useRef(0);
  const resolved = useRef(false);
  const tz = accountModel?.tz || DEFAULT_BUSINESS_TIME_ZONE;
  const own = useMemo(() => stations.find((station) => station.isOwn && !station.archivedAt && station.type === "newapi") ?? null, [stations]);
  const ownId: string = own?.id ?? "";

  const load = useCallback(async (force = true) => {
    const current = ++epoch.current;
    setLoading(true);
    try {
      // 账号的待办（更新登录信息的抽屉要这份，侧栏和运营总览也读它）和渠道的整份数据一起读
      const [accounts, channels] = await Promise.all([
        loadAccountModel(force).catch(() => null) as Promise<AccountReadModel | null>,
        ownId ? api(`/api/reconciliation/channels/overview?ownStationId=${encodeURIComponent(ownId)}`) as Promise<ChannelOverview> : Promise.resolve(null),
      ]);
      if (current !== epoch.current) return;
      if (accounts) setAccountModel(accounts);
      setOverview(channels); setOverviewError(null);
    } catch (err: any) {
      if (current === epoch.current) setOverviewError(noteOf(err));
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  }, [ownId]);

  // 页面第一次读到上游列表时，沿用侧栏刚读过的账号读模型（同一份数据不读两遍）；以后每次重读都取最新的
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!reloadToken) return;
    void load(!firstLoad.current);
    firstLoad.current = false;
  }, [reloadToken, load]);
  useEffect(() => {
    setDestination(readWorkflowDestination(window.location.search, "stations"));
    return () => { epoch.current += 1; };
  }, []);

  const { openAuthorization, authorizationEligible, recoveryButton, overlay: authorizationOverlay } = useAccountAuthorization({
    compact, accountModel, stations, disabled: loading, onComplete: async () => { await reload(); }, onRecoveryError: (note: ErrorNote) => setActionError(note),
  });

  const nameOf = useCallback((id: string) => {
    const station = stations.find((item) => item.id === id);
    return station ? stationDisplayName(station) : id;
  }, [stations]);

  // 左边的上游：有要处理的事的在前，再按有渠道的、名字排
  const upstreams = useMemo(() => [...(overview?.upstreams ?? [])].sort((a, b) =>
    (b.attentionCount > 0 ? 1 : 0) - (a.attentionCount > 0 ? 1 : 0) || (b.channelCount > 0 ? 1 : 0) - (a.channelCount > 0 ? 1 : 0) || a.name.localeCompare(b.name, "zh")), [overview]);
  useEffect(() => {
    if (!upstreams.length) return;
    if (!selectedId || !upstreams.some((item) => item.id === selectedId)) setSelectedId(upstreams[0].id);
  }, [upstreams, selectedId]);

  // 从别处带着处理入口进来（需处理清单、每日利润的链接）：等数据读到后落到对应的上游和卡片
  useEffect(() => {
    if (!destination || resolved.current || !loaded || loading || loadingList || loadError) return;
    resolved.current = true;
    if (destination.error) { setNotice(destination.error); return; }
    const station = stations.find((item) => item.id === destination.stationId);
    const card = overview?.cards.find((item) => destination.ruleId ? item.ruleId === destination.ruleId : false);
    if (["verify", "verify-billing"].includes(destination.action)) {
      // 测试读取只剩上游编辑抽屉里那一个
      if (station && !station.archivedAt) openEditor(station); else setNotice("找不到这个上游。");
    } else if (["authorization", "source"].includes(destination.action)) {
      const account = accountModel?.accounts.find((item) => destination.accountKey ? item.accountKey === destination.accountKey : item.resources.some((resource) => resource.id === destination.stationId));
      if (account && authorizationEligible(account).length) openAuthorization(account);
      else if (station && !station.archivedAt) openEditor(station);
    } else if (destination.action === "coverage" && card) {
      setAnswerTarget({ card, mode: "answer" }); setAnswerValue(""); setAnswerError(null);
    }
    const target = card?.upstreamStationId ?? destination.stationId;
    if (target && overview?.upstreams.some((item) => item.id === target)) setSelectedId(target);
  // 只在上游列表和渠道都读到后定位一次，自动刷新不重复打开
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, loaded, loading, loadingList, loadError, overview, accountModel]);

  const openWorkflow = useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
    resolved.current = false;
    setNotice("");
    setDestination(readWorkflowDestination(url.search, "stations"));
    setDestinationSeq((n) => n + 1);
  }, []);

  const refreshAfterWrite = async () => { await Promise.all([load(), reload().catch(() => {})]); };

  const start = async (card: Card, coverage?: any) => {
    setBusyId(card.id);
    try {
      const result = await api("/api/reconciliation/channels/start", { method: "POST", body: { ownStationId: ownId, channelIds: card.channelIds,
        ...(coverage ? { coverage: { [card.startGroupKey as string]: coverage } } : {}) } });
      if (result.started?.length) message.success(START.done);
      else if (result.failed?.length) message.warning(failureText(`${START.label}没做成`, { code: result.failed[0].code, message: result.failed[0].reason || "" }));
      else if (result.blocked?.length) message.warning(`${START.label}没做成：${blockedText(result.blocked[0].code)}`);
      await refreshAfterWrite();
      return !!result.started?.length;
    } catch (err: any) {
      message.error(failureText(`${START.label}没做成`, err));
      return false;
    } finally { setBusyId(""); }
  };
  const stop = async (card: Card) => {
    setBusyId(card.id);
    try {
      await api("/api/reconciliation/channels/stop", { method: "POST", body: { ownStationId: ownId, channelIds: card.channelIds } });
      message.success(STOP.done);
      setStopTarget(null);
      await refreshAfterWrite();
    } catch (err: any) {
      message.error(failureText(`${STOP.label}没做成`, err));
    } finally { setBusyId(""); }
  };
  const submitAnswer = async () => {
    if (!answerTarget || !answerValue) { setAnswerError({ text: `请回答「${COVERAGE_QUESTION}」`, notice: true } as ErrorNote); return; }
    const { card, mode } = answerTarget;
    const declaration = coverageDeclarationOf(answerValue);
    setBusyId(card.id); setAnswerError(null);
    try {
      if (mode === "answer") {
        await api("/api/reconciliation/channels/answer", { method: "POST", body: { ownStationId: ownId, ruleId: card.ruleId, coverage: declaration } });
        message.success(COPY.answered);
        setAnswerTarget(null);
        await refreshAfterWrite();
      } else if (await start(card, declaration)) setAnswerTarget(null);
    } catch (err: any) {
      setAnswerError({ text: failureText("保存失败", err), raw: describeError(err).raw });
    } finally { setBusyId(""); }
  };

  // 暂停 / 恢复监控：只管这个上游的余额刷不刷，渠道照常算利润
  const setMonitor = async (station: any, enabled: boolean) => {
    setBusyId(`monitor:${station.id}`);
    try {
      await api(`/api/stations/${encodeURIComponent(station.id)}`, { method: "PUT", body: { monitorEnabled: enabled, expectedAuthVersion: station.authVersion, expectedResourceVersion: station.resourceVersion } });
      message.success(enabled ? RESUME.done : PAUSE.done);
      await refreshAfterWrite();
    } catch (err: any) {
      message.error(failureText(`${enabled ? RESUME.label : PAUSE.label}没做成`, err));
    } finally { setBusyId(""); }
  };

  const clickStart = (card: Card) => {
    if (card.needsCoverage) { setAnswerTarget({ card, mode: "start" }); setAnswerValue(""); setAnswerError(null); return; }
    void start(card);
  };

  // ---- 片段 ------------------------------------------------------------------
  const keyText = (line: KeyLine) => {
    const parts = [line.key.tokenName ?? EMPTY, line.group ? `分组 ${line.group}` : "", line.ratio != null ? `倍率 ${line.ratio}` : ""].filter(Boolean).join(" · ");
    const at = (ms: number) => formatZonedDateTime(ms, tz);
    if (line.between) return { when: `${at(line.between[0])}–${formatZonedTime(line.between[1], tz)} 之间换成`, what: parts };
    return { when: `${at(line.fromMs)} 起`, what: parts };
  };
  const renderKeys = (card: Card) => {
    const lines = card.keys;
    if (!lines.length) return null;
    const row = (line: KeyLine, index: number) => {
      const { when, what } = keyText(line);
      return (
        <li key={`${line.fromMs}-${index}`} className="jy-channels-key">
          <span className="jy-channels-key__when">{when}</span>
          <span className="jy-channels-key__what">{what}{line.toMs != null && !line.between ? <span className="jy-caption">　到 {formatZonedDateTime(line.toMs, tz)}</span> : null}</span>
        </li>
      );
    };
    const first = lines.slice(0, 3), rest = lines.slice(3);
    return (
      <div className="jy-channels-keys">
        <p className="jy-channels-keys__title">{COPY.keysUsed}</p>
        <ul>{first.map(row)}</ul>
        {rest.length ? <More label={COPY.moreKeys(rest.length)}><ul>{rest.map((line, index) => row(line, index + 3))}</ul></More> : null}
        {card.startedBy === "auto" && card.startedAtMs != null ? <p className="jy-caption">{COPY.autoStarted(formatZonedDateTime(card.startedAtMs, tz))}</p> : null}
      </div>
    );
  };
  const issueBox = (card: Card, code: string) => {
    const params = { channel: card.names[0] ?? "", time: "" };
    const base = code === "COST_SHARED_ELSEWHERE" ? SHARED_ELSEWHERE : reconciliationIssue(code);
    const title = fillIssueCopy(base.title, (base as any).plain, params), detail = base.detail ? fillIssueCopy(base.detail, (base as any).detailPlain, params) : "";
    return (
      <div className="jy-channels-issue" key={code} role="status">
        <Sym kind="warn" />
        <div className="jy-channels-issue__body">
          <b>{title}</b>
          {detail ? <p className="jy-caption">{detail}</p> : null}
        </div>
        {code === "COST_COVERAGE_UNKNOWN" ? <Button size="small" onClick={() => { setAnswerTarget({ card, mode: "answer" }); setAnswerValue(""); setAnswerError(null); }}>{ANSWER.label}</Button> : null}
        {code === "COST_SHARED_ELSEWHERE" ? <Button size="small" onClick={() => setStopTarget(card)}>{STOP.label}</Button> : null}
        {code === "CHANNEL_KEY_UNMATCHED" ? <Button size="small" onClick={() => openEditor(null)}>{ADD_UPSTREAM.label}</Button> : null}
      </div>
    );
  };
  const renderCard = (card: Card, upstream: UpstreamRow | undefined) => {
    const stateTag = card.state === "attention" ? <span className="jy-tag jy-tag--warn">{COPY.needsAction}</span>
      : card.state === "running" ? <span className="jy-tag jy-tag--info">{COPY.running}</span> : <span className="jy-tag jy-tag--muted">{COPY.stopped}</span>;
    const busy = busyId === card.id;
    const canStart = card.state === "stopped" && !upstream?.noBills;
    return (
      <article key={card.id} className="jy-channels-card" data-card-id={card.id} data-state={card.state}>
        <header className="jy-channels-card__head">
          <h3>{card.names.join("、")}</h3>
          {stateTag}
          <span className="spacer" />
          {card.state !== "stopped" ? <Button type="link" size="small" disabled={busy} onClick={() => setStopTarget(card)}>{STOP.label}</Button> : null}
          {canStart ? <Button size="small" type="primary" loading={busy} onClick={() => clickStart(card)}>{START.label}</Button> : null}
        </header>
        {card.issues.map((code) => issueBox(card, code))}
        {card.state === "stopped" && upstream?.noBills ? <p className="jy-caption">{COPY.noBills}</p> : null}
        {card.state === "stopped" && card.needsCoverage && !upstream?.noBills ? <p className="jy-caption">{COPY.answerHint}</p> : null}
        {renderKeys(card)}
      </article>
    );
  };
  const accountUseText = (item: UpstreamRow) => {
    if (item.type === "newapi-key") return item.runningCount ? `只填了一把 Key · ${item.runningCount} 个渠道在算` : "只填了一把 Key";
    if (!item.channelCount) return COPY.noKeyChannels;
    if (item.accountUse === "only_mine") return `只给我的渠道用 · ${item.runningCount} 个渠道在算`;
    if (item.accountUse === "elsewhere") return `别处也在用 · ${item.runningCount} 个渠道在算`;
    return `还没回答 · ${item.channelCount} 个渠道`;
  };

  const selected = upstreams.find((item) => item.id === selectedId);
  const selectedStation = stations.find((item) => item.id === selectedId);
  const selectedAccount = accountModel?.accounts.find((account) => account.resources.some((resource) => resource.id === selectedId)) ?? null;
  const cardsOf = (id: string) => (overview?.cards ?? []).filter((card) => card.upstreamStationId === id)
    .sort((a, b) => ["attention", "running", "stopped"].indexOf(a.state) - ["attention", "running", "stopped"].indexOf(b.state));
  const unmatched = overview?.unmatched ?? [];
  const noKeyList = unmatched.filter((item) => item.reason !== "KEY_REVEAL_DENIED" && item.reason !== "KEY_UNRESOLVED");

  const reader = overview?.reader;
  const readerBanner = reader && reader.state !== "ok" ? (
    <div className="jy-banner" role="status">
      <Sym kind="warn" />
      <div className="jy-banner__body">
        <b>{reader.state === "not_configured" ? COPY.readerNone : COPY.readerDown}</b>
        <p className="jy-caption">{reader.state === "not_configured" ? COPY.readerNoneDesc : COPY.readerDownDesc}</p>
      </div>
      {own ? <Button size="small" onClick={() => openEditor(own)}>{reader.state === "not_configured" ? COPY.readerHowTo : "检查连接"}</Button> : null}
    </div>
  ) : null;

  let center: ReactNode;
  if (!own && loaded) {
    center = <Panel body={false} label={STATION_TABS.channels}><EmptyState title={COPY.noOwn} desc={COPY.noOwnDesc} /></Panel>;
  } else if (loading && !overview) {
    center = <Panel body={false} label={STATION_TABS.channels}><div className="jy-channels-loading"><Skeleton height={64} /><Skeleton height={64} /><Skeleton height={64} /></div></Panel>;
  } else if (overviewError && !overview) {
    center = <Panel body={false} label={STATION_TABS.channels}><EmptyState title={COPY.loadFailed} desc={<><span>{overviewError.text}</span><ErrorDetail raw={overviewError.raw} /></>} action={<Button onClick={() => { void load(); }}>重新读取</Button>} /></Panel>;
  } else if (!upstreams.length) {
    center = <Panel body={false} label={STATION_TABS.channels}><EmptyState title={COPY.noUpstream} action={<Button type="primary" onClick={() => openEditor(null)} disabled={loadingMeta || !types.length}>{ADD_UPSTREAM.label}</Button>} /></Panel>;
  } else {
    const cards = selected ? cardsOf(selected.id) : [];
    // 没在算的渠道多时只露前面几张，后面的收进「还有 N 个渠道」
    const stoppedCards = cards.filter((card) => card.state === "stopped"), liveCards = cards.filter((card) => card.state !== "stopped");
    const SHOW_STOPPED = 3;
    const showAll = !!expandedMore[selectedId];
    const shownStopped = showAll ? stoppedCards : stoppedCards.slice(0, SHOW_STOPPED), hiddenStopped = showAll ? [] : stoppedCards.slice(SHOW_STOPPED);
    center = (
      <div className="jy-channels" role="region" aria-label={STATION_TABS.channels}>
        {actionError ? <div className="jy-banner jy-banner--crit" role="alert"><Sym kind="warn" /><div className="jy-banner__body"><b>{actionError.text}</b><ErrorDetail raw={actionError.raw} /></div></div> : null}
        {readerBanner}
        {notice ? <div className="jy-banner" role="status"><Sym kind="warn" /><div className="jy-banner__body"><b>{notice}</b></div></div> : null}
        <div className="jy-channels-grid">
          <Panel title={COPY.upstreams} badge={<span className="jy-count">{upstreams.length} 个</span>} body="flush" className="jy-channels-left">
            <ul className="jy-channels-upstreams" role="listbox" aria-label={COPY.upstreams}>
              {upstreams.map((item) => (
                <li key={item.id}>
                  <button type="button" role="option" aria-selected={item.id === selectedId} className={`jy-channels-upstream${item.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(item.id)}>
                    <span className="jy-channels-upstream__name">{item.name}{stations.find((s) => s.id === item.id)?.monitorEnabled === false ? <span className="jy-tag jy-tag--muted">{COPY.paused}</span> : null}</span>
                    {item.attentionCount ? <span className="jy-tag jy-tag--warn">{item.attentionCount} 个{COPY.needsAction}</span> : null}
                    <span className="jy-channels-upstream__sub jy-caption">{accountUseText(item)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {noKeyList.length ? (
              <div className="jy-channels-unmatched">
                <h3>{COPY.unmatchedTitle(noKeyList.length)}</h3>
                <ul>
                  {noKeyList.map((item) => (
                    <li key={item.channelId} data-channel-id={item.channelId}>
                      <div className="jy-channels-unmatched__row">
                        <b>{item.name}</b>
                        <span className="spacer" />
                        {item.reason === "KEY_UNMATCHED" ? <Button size="small" onClick={() => openEditor(null)}>{ADD_UPSTREAM.label}</Button> : null}
                      </div>
                      <p className="jy-caption">{item.reason === "KEY_UNMATCHED" ? COPY.keyNotInUpstream : item.reason === "KEYLESS" ? COPY.keyUnrecognisable : item.reason === "MULTI_KEY" ? COPY.multiKey : COPY.keyNotInUpstream}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>
          <Panel
            body={false}
            className="jy-channels-right"
            title={selected ? selected.name : COPY.upstreams}
            caption={selectedStation?.balance?.ok ? `${COPY.balance} ${balanceMoneyOf(selectedStation, Number(selectedStation.balance.remaining)).text}` : undefined}
            extra={selectedStation && !selectedStation.isOwn ? (
              <>
                <Button size="small" onClick={() => openEditor(selectedStation)}>{COPY.editUpstream}</Button>
                {selectedAccount && authorizationEligible(selectedAccount).length ? (
                  <Button size="small" aria-label={`${UPDATE_LOGIN.label} 上游账号 ${selectedAccount.identity.accountId}`} onClick={() => openAuthorization(selectedAccount)}>{UPDATE_LOGIN.label}</Button>
                ) : null}
                {!selectedStation.archivedAt ? <Button size="small" loading={busyId === `monitor:${selectedStation.id}`} onClick={() => { void setMonitor(selectedStation, selectedStation.monitorEnabled === false); }}>{selectedStation.monitorEnabled === false ? RESUME.label : PAUSE.label}</Button> : null}
              </>
            ) : undefined}
          >
            <div className="jy-channels-cards">
              {selected?.type === "newapi-key" ? <p className="jy-caption">{COPY.onlyOneKey}</p> : null}
              {!cards.length ? <EmptyState title={COPY.noChannels} desc={COPY.noChannelsDesc} center={false} /> : null}
              {liveCards.map((card) => renderCard(card, selected))}
              {shownStopped.map((card) => renderCard(card, selected))}
              {hiddenStopped.length ? (
                <button type="button" className="jy-channels-more" onClick={() => setExpandedMore((current) => ({ ...current, [selectedId]: true }))}>
                  {COPY.more(hiddenStopped.reduce((total, card) => total + card.channelIds.length, 0), hiddenStopped.map((card) => card.names.join("、")).join("、"))}
                </button>
              ) : null}
            </div>
          </Panel>
        </div>
        {recoveryButton}
      </div>
    );
  }

  const stopCard = stopTarget;
  const stopStation = stopCard ? stations.find((item) => item.id === stopCard.upstreamStationId) : null;
  const sub2 = stopStation && /^sub2api/.test(stopStation.type);
  const overlays = (
    <>
      {authorizationOverlay}
      <Modal
        title={stopCard ? `${STOP.label}「${listNames(stopCard.names)}」？` : STOP.label}
        open={!!stopCard}
        onCancel={() => setStopTarget(null)}
        okText={STOP.label}
        cancelText="取消"
        confirmLoading={!!stopCard && busyId === stopCard.id}
        onOk={() => { if (stopCard) void stop(stopCard); }}
        destroyOnHidden
      >
        {sub2 ? <p>这个上游只能按整天读账单，今天（{formatZonedDate(Date.now(), tz)}）整天不算进{stopCard && stopCard.names.length > 1 ? "这几个渠道" : "这个渠道"}的利润。</p> : null}
        {stopCard && stopCard.names.length > 1 ? <p>这几个渠道用同一把 Key，一起停。</p> : null}
        <p>以前的每日记录还在，以后可以再点「{START.label}」接着算。</p>
      </Modal>
      <Modal
        title={COVERAGE_QUESTION}
        open={!!answerTarget}
        onCancel={() => setAnswerTarget(null)}
        okText={answerTarget?.mode === "start" ? START.label : "保存"}
        cancelText="取消"
        confirmLoading={!!answerTarget && busyId === answerTarget.card.id}
        onOk={() => { void submitAnswer(); }}
        destroyOnHidden
      >
        <p className="jy-caption">{COPY.answerHint}</p>
        <Radio.Group value={answerValue} onChange={(event) => setAnswerValue(event.target.value)} className="jy-channels-answers">
          {ANSWER_OPTIONS.map((option) => (
            <Radio key={option.value} value={option.value}>
              {option.label}
              {ANSWER_HINT[option.value] ? <span className="jy-caption jy-channels-answers__hint">{ANSWER_HINT[option.value]}</span> : null}
            </Radio>
          ))}
        </Radio.Group>
        {answerTarget?.mode === "start" && /^sub2api/.test(stations.find((item) => item.id === answerTarget.card.upstreamStationId)?.type || "") ? <p className="jy-caption">{COPY.sub2WholeDay(formatZonedDate(Date.now(), tz))}</p> : null}
        {answerError ? <div className="jy-banner jy-banner--crit" role="alert"><Sym kind="warn" /><div className="jy-banner__body"><b>{answerError.text}</b><ErrorDetail raw={answerError.raw} /></div></div> : null}
      </Modal>
    </>
  );

  return { destination, destinationSeq, openWorkflow, center, overlays };
}

// 开始算利润没做成的原因（blocked 的码）
function blockedText(code: string) {
  if (code === "COVERAGE_ANSWER_REQUIRED") return `请回答「${COVERAGE_QUESTION}」`;
  if (code === "KEY_UNMATCHED") return COPY.keyNotInUpstream;
  if (code === "KEYLESS") return COPY.keyUnrecognisable;
  if (code === "MULTI_KEY") return COPY.multiKey;
  return "这个渠道现在不能开始，稍后再试";
}
