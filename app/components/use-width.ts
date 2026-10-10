"use client";
// 元素内容宽度，随容器尺寸变化更新；图表按实际像素宽度绘制。
// 返回回调 ref：节点卸载再挂载（图表/表格切换）时会重新监听。
import { useEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement = HTMLDivElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return;
    setWidth(node.clientWidth);
    let frame = 0;
    const ro = new ResizeObserver((entries) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(Math.round(entries[0].contentRect.width)));
    });
    ro.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [node]);
  return [setNode, width] as const;
}

// SVG 引用（url(#id)）里不能有 useId 生成的冒号等字符
export const svgId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "");
