"use client";
// 收起区（design/ui-design-spec.md §4.11、ui-copy-spec §8.4）：默认收起，只露一个写明收着什么的文字按钮，展开后内容紧跟在下面。
// anchor 是页面上那一块的 id（那一块自己带这个 id）：页面里指向「#anchor」的链接会展开它，带着这个地址打开或刷新页面时展开并滚过去。
// defaultOpen 只给「收着的内容就是这一页要说的事」时用；值变了要重新按它来，调用处给 More 换 key。
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons";

export function More({ label, anchor, defaultOpen = false, children, className = "" }: { label: string; anchor?: string; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  useEffect(() => {
    if (!anchor) return;
    // 带着 #anchor 打开页面、或地址栏换成 #anchor 时展开；那一块常常等数据读回来才出现，浏览器自己不会再滚，这里滚过去
    const check = () => {
      if (window.location.hash !== `#${anchor}`) return;
      setOpen(true);
      requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
    };
    check();
    // 页面里指向它的链接每点一次都展开（收起后再点同一个链接，地址栏的 # 不变，不会有 hashchange；滚动由浏览器做）
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (link?.getAttribute("href") === `#${anchor}`) setOpen(true);
    };
    window.addEventListener("hashchange", check);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", check);
      document.removeEventListener("click", onClick);
    };
  }, [anchor]);
  return (
    <div className={`jy-more ${className}`.trim()}>
      <button type="button" className="jy-more__toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((v) => !v)}>
        {label}
        <Icon name="expand" className={open ? "is-open" : undefined} />
      </button>
      {open ? <div id={bodyId} className="jy-more__body">{children}</div> : null}
    </div>
  );
}
