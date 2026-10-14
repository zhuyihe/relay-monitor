// 抽屉自己处理 Esc（配合 keyboard={false}）。antd 的 keyboard 依赖 rc-portal 的全局 Esc 栈，只有栈顶能响应；
// 下拉框收起动画期间（约 0.2 秒）仍占着栈顶，这时按 Esc 抽屉收不到（#413）。
// 在 window 冒泡阶段监听，而不是挂在抽屉的 onKeyDown 上：抽屉刚打开时焦点在外层容器、按钮禁用后焦点落到 body，
// 这些 Esc 都到不了抽屉面板。展开中的下拉框会拦下 Esc（rc-select stopPropagation），先收起下拉框；
// 对话框里的 Esc 留给对话框；输入法组字中及刚结束组字时的 Esc 只取消组字。
// 日期选择器展开时不拦 Esc，含日期选择器的抽屉不要用它。
import { useEffect, useRef } from "react";

const COMPOSITION_LOCK_MS = 200;

export function useDrawerEscape(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!active) return;
    let compositionEndAt = 0;
    const onCompositionEnd = () => { compositionEndAt = Date.now(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || Date.now() - compositionEndAt < COMPOSITION_LOCK_MS) return;
      if (event.target instanceof Element && event.target.closest(".ant-modal-wrap")) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("compositionend", onCompositionEnd);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [active]);
}
