"use client";

import { useEffect } from "react";
import AppState, { appStateStyles } from "./components/app-state";

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

  return (
    <AppState
      kind="error"
      title="暂时无法显示此页面"
      description="页面运行时遇到问题。请先重试；如果问题持续存在，可返回运营总览。"
      actions={
        <>
          <button className={appStateStyles.primaryAction} type="button" onClick={reset}>
            重新加载
          </button>
          <a className={appStateStyles.secondaryAction} href="/">
            返回运营总览
          </a>
        </>
      }
    />
  );
}
