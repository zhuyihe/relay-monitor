// 首次加载（design/ui-copy-spec.md §8.1）：只有转圈，不写字；「正在加载」只给读屏
import { LOADING_TEXT } from "../lib/format";
import AppState from "./components/app-state";

export default function Loading() {
  return <AppState kind="loading" title={LOADING_TEXT} />;
}
