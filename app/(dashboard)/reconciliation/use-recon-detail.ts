"use client";
// 计算明细抽屉的状态：当前绑定、倍率变化记录和「改时间」。
// 打开另一条绑定或关闭抽屉后，上一条的请求和修改结果都不再写回（requestId 守卫）。
import { useRef, useState } from "react";
import { App } from "antd";
import { api } from "../../../lib/client";
import { failureText } from "../../../lib/error-copy";
import { workflowActionMeta } from "../../../lib/workflow-actions";

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
      if (token === requestId.current) message.warning("倍率变化记录没读全");
    }
  };

  const clear = () => {
    requestId.current += 1;
    setDetail(null);
  };

  // 单行重新读取成功后，抽屉里若正是这条绑定，同步换成新结果
  const replace = (id: string, row: any) => setDetail((current: any) => String(current?.rule?.id) === id ? row : current);

  // 页面只读的唯一例外：填上倍率实际变化的时间，保存后受影响的日子重算
  const correctTransition = async (reload: () => Promise<any>) => {
    const segment = transitionSegments.find((item: any) => item.id === transitionSegmentId);
    const ruleId = detail?.rule?.id;
    if (!ruleId || !segment?.id || !transitionAt) return message.warning("请填倍率变化的时间");
    const token = ++requestId.current;
    setCorrecting(true);
    try {
      await api(`${rulePath(ruleId)}/transitions/${encodeURIComponent(segment.id)}`, { method: "PUT", body: { effectiveAt: transitionAt.valueOf() } });
      if (token === requestId.current) setTransitionAt(null);
      const next = await reload();
      message.success(workflowActionMeta("correct_timing").done);
      if (token !== requestId.current) return;
      const refreshed = next?.results?.find((item: any) => item.rule?.id === ruleId);
      if (refreshed) setDetail(refreshed);
      const history = await api(`${rulePath(ruleId)}/segments`);
      if (token === requestId.current) applySegments(history.segments || []);
    } catch (err: any) {
      message.error(failureText("保存失败", err));
    } finally {
      setCorrecting(false);
    }
  };

  return {
    detail, transitionAt, setTransitionAt, transitionSegmentId, setTransitionSegmentId, transitionSegments, correcting,
    open, clear, replace, correctTransition,
  };
}
