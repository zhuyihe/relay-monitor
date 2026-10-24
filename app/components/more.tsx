"use client";
// 收起区（design/ui-design-spec.md §4.11、ui-copy-spec §8.4）：默认收起，只露一个写明收着什么的文字按钮，展开后内容紧跟在下面。
// id 给了时，页面里指向「#id」的链接会展开它（点链接、或者带着这个地址打开页面都算）。
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons";

export function More({ label, id, children, className = "" }: { label: string; id?: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  useEffect(() => {
    if (!id) return;
    // 带着 #id 打开页面、或地址栏换成 #id 时展开；页面里指向它的链接每点一次都展开（收起后再点同一个链接，地址栏的 # 不变，不会有 hashchange）
    const check = () => { if (window.location.hash === `#${id}`) setOpen(true); };
    check();
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (link?.getAttribute("href") === `#${id}`) setOpen(true);
    };
    window.addEventListener("hashchange", check);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", check);
      document.removeEventListener("click", onClick);
    };
  }, [id]);
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
