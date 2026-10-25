"use client";
// 上游账单与每日利润产生的需处理事项：侧栏计数、运营总览、上游资源页共用一份，保证三处条数一致。
// 两路分别缓存 5 分钟，重复读取直接用缓存；某一路读取失败时保留上次读到的事项，并记下上次读到的时间。
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../../lib/client";
import type { WorkflowAction } from "../../lib/client";

const TTL_MS = 5 * 60_000;

type Source = "accounts" | "bills";
const ALL_SOURCES: readonly Source[] = ["accounts", "bills"];
const READS: Record<Source, string> = {
  accounts: "/api/channel-onboarding/accounts",
  bills: "/api/reconciliation?preset=yesterday",
};

type WorkflowState = {
  accounts: WorkflowAction[];
  bills: WorkflowAction[];
  failed: Record<Source, boolean>;
  at: Record<Source, number>;
  // 上次读成功的时间，读取失败时用来写「刷新失败，数据截至 14:30」
  okAt: Record<Source, number>;
  loading: boolean;
  // 「自营站点 id:渠道 id」→ 名字：从两路本来就读到的数据里顺手记下，事项只带渠道 id，上游列表要说「渠道「X」用的 Key…」时用（不多发请求）。
  // 渠道 id 只在一个自营站点里唯一，换过自营站点时两边的同号渠道不能互相覆盖，所以带上自营站点 id（channelNameKey）。
  // 分两份：current 是自营站点现在的名字（上游账单的渠道列表、每日利润的 coverage.channels），saved 是绑定保存时存下的名字；
  // 取名字只用 channelNameOf：有现在的名字就用现在的，没有（例如渠道已删）才用存下的，刷新几次也不会新旧来回换
  channelNames: { current: Record<string, string>; saved: Record<string, string> };
};

const INITIAL: WorkflowState = {
  accounts: [],
  bills: [],
  failed: { accounts: false, bills: false },
  at: { accounts: 0, bills: 0 },
  okAt: { accounts: 0, bills: 0 },
  loading: false,
  channelNames: { current: {}, saved: {} },
};
let state = INITIAL;
const inflight: Partial<Record<Source, Promise<void>>> = {};
const listeners = new Set<() => void>();

function update(patch: Partial<WorkflowState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function loadSource(source: Source, force: boolean): Promise<void> {
  const pending = inflight[source];
  if (pending) return pending;
  if (!force && state.at[source] && Date.now() - state.at[source] < TTL_MS) return Promise.resolve();
  update({ loading: true });
  const run = (async () => {
    let actions: WorkflowAction[] | null = null;
    let names: WorkflowState["channelNames"] = { current: {}, saved: {} };
    try {
      const r = await api(READS[source]);
      actions = r?.actions || [];
      names = channelNamesOf(r);
    } catch {}
    update({
      ...(actions
        ? {
            [source]: actions,
            channelNames: { current: { ...state.channelNames.current, ...names.current }, saved: { ...state.channelNames.saved, ...names.saved } },
          }
        : {}),
      failed: { ...state.failed, [source]: !actions },
      at: { ...state.at, [source]: Date.now() },
      ...(actions ? { okAt: { ...state.okAt, [source]: Date.now() } } : {}),
    });
  })().finally(() => {
    delete inflight[source];
    update({ loading: Object.keys(inflight).length > 0 });
  });
  inflight[source] = run;
  return run;
}

export const channelNameKey = (ownStationId: unknown, channelId: unknown) => `${ownStationId ?? ""}:${channelId}`;

// 两路读到的数据里的渠道名；只记有名字的（没有名字的由用的地方按「N 个渠道」说）。
// 现在的名字：上游账单的渠道列表（channels，是这个自营站点现在的渠道，自营站点 id 是同一份数据里的 ownStationId）、
// 每日利润的 coverage.channels（整体的和各组的）。存下的名字：上游账单绑定里的渠道（accounts[].keys[].channels）、每日利润的绑定（results[].rule.channels）。
// 不引 lib/reconciliation-view：这个文件每页都加载（侧栏计数），不为一个名字把那一大块带进每页
function channelNamesOf(r: any): WorkflowState["channelNames"] {
  const current: Record<string, string> = {}, saved: Record<string, string> = {};
  const add = (out: Record<string, string>, own: unknown, c: any) => {
    const id = c?.channelId ?? c?.id;
    if (own != null && id != null && c?.name) out[channelNameKey(own, id)] = String(c.name);
  };
  const list = (x: any) => (Array.isArray(x) ? x : []);
  // 上游账单
  const keyChannels = list(r?.accounts).flatMap((a: any) => list(a?.keys).flatMap((k: any) => list(k?.channels)));
  keyChannels.forEach((c: any) => add(saved, c?.ownStationId, c));
  // 渠道列表属于哪个自营站点，只认接口给的那一个（listAccounts 的 ownStationId），不从别处猜
  list(r?.channels).forEach((c: any) => { if (!c?.missing) add(current, r?.ownStationId, c); });
  // 每日利润
  list(r?.results).forEach((x: any) => list(x?.rule?.channels).forEach((c: any) => add(saved, x?.rule?.ownStationId, c)));
  // coverage 里「自营站点来源没确认」（source_unverified）的那条带的是绑定存下的旧名，和当前那条同一个自营站点 id、渠道 id，算旧名，不然两条按先后互相盖
  [r?.coverage, ...list(r?.groups).map((g: any) => g?.coverage)].forEach((cov: any) =>
    list(cov?.channels).forEach((c: any) => add(c?.status === "source_unverified" ? saved : current, c?.ownStationId, c)),
  );
  return { current, saved };
}

// 一个渠道在界面上的名字：有现在的名字用现在的，没有才用绑定存下的；都没有时 undefined（用的地方按「N 个渠道」说）
export function channelNameOf(names: WorkflowState["channelNames"], ownStationId: unknown, channelId: unknown): string | undefined {
  const key = channelNameKey(ownStationId, channelId);
  return names.current[key] ?? names.saved[key];
}

export function loadWorkflowActions(force = false, sources: readonly Source[] = ALL_SOURCES): Promise<void> {
  return Promise.all(sources.map((source) => loadSource(source, force))).then(() => {});
}

// 上游资源页读到新的上游账单后直接更新，不必再请求一次
export function publishAccountActions(actions: WorkflowAction[] | undefined) {
  if (Array.isArray(actions)) {
    update({ accounts: actions, failed: { ...state.failed, accounts: false }, at: { ...state.at, accounts: Date.now() }, okAt: { ...state.okAt, accounts: Date.now() } });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// sources：这个页面需要自己去读的那几路；上游资源页的账号待办由「上游账单」读好后发布过来
export function useWorkflowActions(enabled = true, sources: readonly Source[] = ALL_SOURCES) {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  const sourceKey = sources.join(",");
  useEffect(() => {
    if (enabled) void loadWorkflowActions(false, sourceKey.split(",") as Source[]);
  }, [enabled, sourceKey]);
  const actions = useMemo(() => [...snapshot.accounts, ...snapshot.bills], [snapshot.accounts, snapshot.bills]);
  const failed = ALL_SOURCES.filter((source) => snapshot.failed[source]);
  // 读取失败时，界面写「刷新失败，数据截至 …」；从来没读到过的写 null，界面写「读不到」
  const staleAsOf = failed.length && failed.every((source) => snapshot.okAt[source]) ? Math.min(...failed.map((source) => snapshot.okAt[source])) : null;
  return {
    actions,
    failed: failed.length > 0,
    staleAsOf,
    loading: snapshot.loading,
    channelNames: snapshot.channelNames,
    reload: () => loadWorkflowActions(true),
  };
}
