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
  // 渠道 id → 名字：从两路本来就读到的数据里顺手记下，事项只带渠道 id，上游列表要说「渠道「X」用的 Key…」时用（不多发请求）
  channelNames: Record<string, string>;
};

const INITIAL: WorkflowState = {
  accounts: [],
  bills: [],
  failed: { accounts: false, bills: false },
  at: { accounts: 0, bills: 0 },
  okAt: { accounts: 0, bills: 0 },
  loading: false,
  channelNames: {},
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
    let names: Record<string, string> = {};
    try {
      const r = await api(READS[source]);
      actions = r?.actions || [];
      names = channelNamesOf(r);
    } catch {}
    update({
      ...(actions ? { [source]: actions, channelNames: { ...state.channelNames, ...names } } : {}),
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

// 上游账单（channels）和每日利润（results[].rule.channels）里的渠道名；只记有名字的（没有名字的由用的地方按「N 个渠道」说），
// 不引 lib/reconciliation-view：这个文件每页都加载（侧栏计数），不为一个名字把那一大块带进每页
function channelNamesOf(r: any): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (c: any) => {
    const id = c?.channelId ?? c?.id;
    if (id != null && c?.name) out[String(id)] = String(c.name);
  };
  (Array.isArray(r?.channels) ? r.channels : []).forEach(add);
  (Array.isArray(r?.results) ? r.results : []).forEach((x: any) => (x?.rule?.channels || []).forEach(add));
  return out;
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
