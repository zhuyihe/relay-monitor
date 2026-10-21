"use client";
// 整个页面打不开（design/ui-copy-spec.md §8.1）：「这个页面暂时打不开。」[刷新] [查看详细原因]，原文只进详细原因

import { useEffect } from "react";
import { workflowActionMeta } from "../lib/workflow-actions";
import AppState, { appStateStyles } from "./components/app-state";
import { ErrorDetail } from "./components/error-detail";

const COPY = Object.freeze({ title: "这个页面暂时打不开。" });

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // 线上的报错原文只有一句概括和编号（digest），一起给技术同事
  const raw = [error?.message, error?.digest].filter(Boolean).join("\n");
  return (
    <AppState
      kind="error"
      title={COPY.title}
      actions={
        <>
          <button className={appStateStyles.primaryAction} type="button" onClick={reset}>
            {workflowActionMeta("refresh")!.label}
          </button>
          <ErrorDetail raw={raw} />
        </>
      }
    />
  );
}
