"use client";
// 核算详情抽屉的状态：当前关联、分段历史和「修正切换时间」。
// 打开另一条关联或关闭抽屉后，上一条的分段请求和修正结果都不再写回（requestId 守卫）。
import { useRef, useState } from "react";
import { App } from "antd";
import { api } from "../../../lib/client";

const detectedSegmentId = (segments: any[]) => segments.find((segment: any) => segment.timingSource === "detected")?.id || null;
const rulePath = (ruleId: string) => `/api/reconciliation/rules/${encodeURIComponent(ruleId)}`;

export function useReconDetail() {
  const { message } = App.useApp();
  const [detail, setDetail] = useState<any>(null);
  const [transitionAt, setTransitionAt] = useState<any>(null);
  const [transitionSegmentId, setTransitionSegmentId] = useState<string | null>(null);
  const [transitionSegments, setTransitionSegments] = useState<any[]>([]);
  const [correcting, setCorrecting] = useState(false);
  const requestId = useRef(0);

  const applySegments = (segments: any[]) => {
    setTransitionSegments(segments);
    setTransitionSegmentId(detectedSegmentId(segments));
  };

  const open = async (item: any) => {
    const token = ++requestId.current;
    setDetail(item);
    setTransitionAt(null);
    applySegments(item.transitionSegments || item.segments || []);
    try {
      const history = await api(`${rulePath(item.rule.id)}/segments`);
      if (token === requestId.current) applySegments(history.segments || []);
    } catch (err: any) {
      if (token === requestId.current) message.warning(err?.message || "未能读取完整分段历史");
    }
  };

  const clear = () => {
    requestId.current += 1;
    setDetail(null);
  };

  // 单行重试成功后，抽屉里若正是这条关联，同步换成新结果
  const replace = (id: string, row: any) => setDetail((current: any) => String(current?.rule?.id) === id ? row : current);

  // 页面只读的唯一例外：人工确认分组切换的实际时间，写入后按新分段重新核算
  const correctTransition = async (reload: () => Promise<any>) => {
    const segment = transitionSegments.find((item: any) => item.id === transitionSegmentId);
    const ruleId = detail?.rule?.id;
    if (!ruleId || !segment?.id || !transitionAt) return message.warning("请选择实际切换时间");
    const token = ++requestId.current;
    setCorrecting(true);
    try {
      await api(`${rulePath(ruleId)}/transitions/${encodeURIComponent(segment.id)}`, { method: "PUT", body: { effectiveAt: transitionAt.valueOf() } });
      message.success("切换时间已修正，正在重新核算");
      if (token === requestId.current) setTransitionAt(null);
      const next = await reload();
      if (token !== requestId.current) return;
      const refreshed = next?.results?.find((item: any) => item.rule?.id === ruleId);
      if (refreshed) setDetail(refreshed);
      const history = await api(`${rulePath(ruleId)}/segments`);
      if (token === requestId.current) applySegments(history.segments || []);
    } catch (err: any) {
      message.error(err?.message || "修正切换时间失败");
    } finally {
      setCorrecting(false);
    }
  };

  return {
    detail, transitionAt, setTransitionAt, transitionSegmentId, setTransitionSegmentId, transitionSegments, correcting,
    open, clear, replace, correctTransition,
  };
}
