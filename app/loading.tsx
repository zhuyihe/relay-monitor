import AppState from "./components/app-state";

export default function Loading() {
  return (
    <AppState
      kind="loading"
      title="正在准备工作区"
      description="正在加载页面与最新信息，请稍候。"
    />
  );
}
