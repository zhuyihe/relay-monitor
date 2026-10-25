"use client";
// 收起区（design/ui-design-spec.md §4.11、ui-copy-spec §8.4）：默认收起，只露一个写明收着什么的文字按钮，展开后内容紧跟在下面。
// anchor 是页面上那一块的 id（那一块自己带这个 id）：页面里指向「#anchor」的链接会展开它，带着这个地址打开或刷新页面时展开并滚过去。
// defaultOpen 只给「收着的内容就是这一页要说的事」时用；值变了要重新按它来，调用处给 More 换 key。
// 换 key 就是重新挂载：用户已经展开或收起的状态回到 defaultOpen，按钮上的焦点也会丢（例如用量分析从「全都读不到」变成「部分读不到」时），这是有意的。
// 页面要自己控制开合时（开合状态从外面传进来、别处的链接要把它打开），传 open 和 onOpenChange（受控）；不传 open 时它自己管（ui-design-spec §4.11），不另写一套收起。
// 一旦传了 open 就一直传（不在受控和不受控之间来回换，和 React 的输入框同一个约定）。
// 收着的内容里有「取消」「保存」这类会把它收起的按钮时，用 buttonRef 拿到收起区的按钮，收起后把焦点还给它。
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Icon } from "./icons";

export function More({
  label,
  anchor,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  buttonRef,
  children,
  className = "",
}: {
  label: string;
  anchor?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
  className?: string;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : inner;
  // 监听里拿到的总是最新的 onOpenChange 和受控与否，不因为页面每次渲染换新函数就重挂监听
  // 在 effect 里更新，不在渲染时写 ref
  const latest = useRef({ controlled, onOpenChange });
  useEffect(() => {
    latest.current = { controlled, onOpenChange };
  });
  const setOpen = useRef((next: boolean) => {
    if (!latest.current.controlled) setInner(next);
    latest.current.onOpenChange?.(next);
  }).current;
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
  }, [anchor, setOpen]);
  return (
    <div className={`jy-more ${className}`.trim()}>
      <button ref={buttonRef} type="button" className="jy-more__toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
        {label}
        <Icon name="expand" className={open ? "is-open" : undefined} />
      </button>
      {open ? <div id={bodyId} className="jy-more__body">{children}</div> : null}
    </div>
  );
}
