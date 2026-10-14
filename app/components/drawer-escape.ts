// 抽屉自己处理 Esc（配合 keyboard={false}）。antd 的 keyboard 依赖 rc-portal 的全局 Esc 栈，只有栈顶能响应；
// 下拉框收起动画期间（约 0.2 秒）仍占着栈顶，这时按 Esc 抽屉收不到（#413）。
// 展开中的下拉框会自己拦下 Esc（rc-select stopPropagation），先收起下拉框；输入法组字中的 Esc 只取消组字。
import type { KeyboardEvent } from "react";

export function closeOnEscape(enabled: boolean, close: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !enabled || event.nativeEvent.isComposing || event.keyCode === 229) return;
    close();
  };
}
