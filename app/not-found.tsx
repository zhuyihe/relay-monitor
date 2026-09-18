import Link from "next/link";
import AppState, { appStateStyles } from "./components/app-state";

export default function NotFound() {
  return (
    <AppState
      kind="not-found"
      title="没有找到这个页面"
      description="链接可能已经失效，或页面地址输入有误。你可以返回运营总览继续工作。"
      actions={
        <Link className={appStateStyles.primaryAction} href="/">
          返回运营总览
        </Link>
      }
    />
  );
}
