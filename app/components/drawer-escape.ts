// 抽屉自己处理 Esc（配合 keyboard={false}）。antd 的 keyboard 依赖 rc-portal 的全局 Esc 栈，只有栈顶能响应；
// 下拉框收起动画期间（约 0.2 秒）仍占着栈顶，这时按 Esc 抽屉收不到（#413）。
// 在 window 冒泡阶段监听，而不是挂在抽屉的 onKeyDown 上：抽屉刚打开时焦点在外层容器、按钮禁用后焦点落到 body，
// 这些 Esc 都到不了抽屉面板。展开中的下拉框会拦下 Esc（rc-select stopPropagation），先收起下拉框；
// 日期选择器收起时不拦 Esc，所以在捕获阶段先记下按键时有没有展开的日期面板，有就只收起日期面板；
// 对话框里的 Esc 留给对话框；输入法组字中及刚结束组字时的 Esc 只取消组字。
import { useEffect, useRef } from "react";

const COMPOSITION_LOCK_MS = 200;

// 展开中的日期面板：没被隐藏、也不在收起动画里（收起动画中的面板已经关了，Esc 应该交给抽屉）
function hasOpenPicker() {
  return Array.from(document.querySelectorAll(".ant-picker-dropdown")).some((node) =>
    !node.classList.contains("ant-picker-dropdown-hidden")
    && !Array.from(node.classList).some((name) => name.endsWith("-leave")));
}

export function useDrawerEscape(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!active) return;
    let compositionEndAt = 0;
    let pickerOpenAtKeyDown = false;
    const onCompositionEnd = () => { compositionEndAt = Date.now(); };
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape") pickerOpenAtKeyDown = hasOpenPicker();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || Date.now() - compositionEndAt < COMPOSITION_LOCK_MS) return;
      if (pickerOpenAtKeyDown) return;
      if (event.target instanceof Element && event.target.closest(".ant-modal-wrap")) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("compositionend", onCompositionEnd);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [active]);
}
