// 模型供需模块隐藏中（lib/features.js 的 modelsModuleEnabled()）：/models 当作没有这个页面（404）。代码留着，改开关就恢复。
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { modelsModuleEnabled } from "../../../lib/features.js";

export default function ModelsLayout({ children }: { children: ReactNode }) {
  if (!modelsModuleEnabled()) notFound();
  return children;
}
