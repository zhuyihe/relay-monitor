"use client";
// 账号关系与账单核算产生的待办：侧栏计数、运营总览、上游资源页共用一份，保证三处条数一致。
// 5 分钟内重复读取直接用缓存；某一路读取失败时保留上次读到的事项。
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../../lib/client";
import type { WorkflowAction } from "../../lib/client";

const TTL_MS = 5 * 60_000;

type WorkflowState = {
  accounts: WorkflowAction[];
  bills: WorkflowAction[];
  error: string;
  loading: boolean;
  at: number;
};

const INITIAL: WorkflowState = { accounts: [], bills: [], error: "", loading: false, at: 0 };
let state = INITIAL;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<WorkflowState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function loadWorkflowActions(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && state.at && Date.now() - state.at < TTL_MS) return Promise.resolve();
  update({ loading: true });
  inflight = (async () => {
    const [accounts, bills] = await Promise.allSettled([
      api("/api/channel-onboarding/accounts"),
      api("/api/reconciliation?preset=yesterday"),
    ]);
    update({
      accounts: accounts.status === "fulfilled" ? accounts.value?.actions || [] : state.accounts,
      bills: bills.status === "fulfilled" ? bills.value?.actions || [] : state.bills,
      error: accounts.status === "rejected" || bills.status === "rejected" ? "部分账号或账单事项未能更新，保留上次已读事项。" : "",
      loading: false,
      at: Date.now(),
    });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// 上游资源页读到新的账号关系后直接更新，不必再请求一次
export function publishAccountActions(actions: WorkflowAction[] | undefined) {
  if (Array.isArray(actions)) update({ accounts: actions });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorkflowActions(enabled = true) {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  useEffect(() => {
    if (enabled) void loadWorkflowActions();
  }, [enabled]);
  const actions = useMemo(() => [...snapshot.accounts, ...snapshot.bills], [snapshot.accounts, snapshot.bills]);
  return {
    actions,
    error: snapshot.error,
    loading: snapshot.loading,
    reload: () => loadWorkflowActions(true),
  };
}
