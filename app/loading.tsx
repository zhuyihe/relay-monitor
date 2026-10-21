// 首次加载（design/ui-copy-spec.md §8.1）：只有转圈，不写字；「加载中」只给读屏
import AppState from "./components/app-state";

export default function Loading() {
  return <AppState kind="loading" title="加载中" />;
}
