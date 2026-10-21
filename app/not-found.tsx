// 找不到页面（design/ui-copy-spec.md §8.1）：「找不到这个页面。」[返回运营总览]，页面名取 lib/brand.js
import Link from "next/link";
import { NAV_LABELS } from "../lib/brand";
import AppState, { appStateStyles } from "./components/app-state";

const COPY = Object.freeze({ title: "找不到这个页面。", back: `返回${NAV_LABELS.home}` });

export default function NotFound() {
  return (
    <AppState
      kind="not-found"
      title={COPY.title}
      actions={
        <Link className={appStateStyles.primaryAction} href="/">
          {COPY.back}
        </Link>
      }
    />
  );
}
