"use client";
// 账号关系与账单核算产生的待办：侧栏计数、运营总览、上游资源页共用一份，保证三处条数一致。
// 两路分别缓存 5 分钟，重复读取直接用缓存；某一路读取失败时保留上次读到的事项。
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
  loading: boolean;
};

const INITIAL: WorkflowState = {
  accounts: [],
  bills: [],
  failed: { accounts: false, bills: false },
  at: { accounts: 0, bills: 0 },
  loading: false,
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
    try {
      const r = await api(READS[source]);
      actions = r?.actions || [];
    } catch {}
    update({
      ...(actions ? { [source]: actions } : {}),
      failed: { ...state.failed, [source]: !actions },
      at: { ...state.at, [source]: Date.now() },
    });
  })().finally(() => {
    delete inflight[source];
    update({ loading: Object.keys(inflight).length > 0 });
  });
  inflight[source] = run;
  return run;
}

export function loadWorkflowActions(force = false, sources: readonly Source[] = ALL_SOURCES): Promise<void> {
  return Promise.all(sources.map((source) => loadSource(source, force))).then(() => {});
}

// 上游资源页读到新的账号关系后直接更新，不必再请求一次
export function publishAccountActions(actions: WorkflowAction[] | undefined) {
  if (Array.isArray(actions)) {
    update({ accounts: actions, failed: { ...state.failed, accounts: false }, at: { ...state.at, accounts: Date.now() } });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// sources：这个页面需要自己去读的那几路；上游资源页的账号关系由账号关系中心读好后发布过来
export function useWorkflowActions(enabled = true, sources: readonly Source[] = ALL_SOURCES) {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  const sourceKey = sources.join(",");
  useEffect(() => {
    if (enabled) void loadWorkflowActions(false, sourceKey.split(",") as Source[]);
  }, [enabled, sourceKey]);
  const actions = useMemo(() => [...snapshot.accounts, ...snapshot.bills], [snapshot.accounts, snapshot.bills]);
  return {
    actions,
    error: snapshot.failed.accounts || snapshot.failed.bills ? "部分账号或账单事项未能更新，保留上次已读事项。" : "",
    loading: snapshot.loading,
    reload: () => loadWorkflowActions(true),
  };
}
