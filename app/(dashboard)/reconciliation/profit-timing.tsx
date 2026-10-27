"use client";
// 计算明细里的「改时间」（C2b/C3 做的，搬到新计算明细）：倍率变化的时间是系统估的（timingSource detected）时，让人改成实际的时间；
// 保存以后改到的那几天会重新算。接口和字都不变：GET /api/reconciliation/rules/:id/segments、PUT …/transitions/:segmentId。
// 只对「倍率变化、时间是系统估的」那一段显示；换 Key 开的段（K2b 的 key_change）不出（设计 10-27 定，K2b 合进来以后自然就对了）。
import { useEffect, useRef, useState } from "react";
import { App, Button, DatePicker, Select } from "antd";
import { api } from "../../../lib/client";
import type { ProfitRow } from "../../../lib/client";
import { EMPTY, formatZonedDateTime } from "../../../lib/format";
import { failureText } from "../../../lib/error-copy";
import { reconciliationIssue } from "../../../lib/reconciliation-contract";
import { CORRECT_TIMING_HINT, correctTimingDone, workflowActionMeta } from "../../../lib/workflow-actions";

const CORRECT_TIMING = workflowActionMeta("correct_timing")!.label;
const ratioLabel = (value: any) => (value == null ? reconciliationIssue("GROUP_DATA_UNAVAILABLE").ratio : `${value}×`);
// 一次倍率的起止：「10月9日 14:30–10月10日 0:00」，还在用的写「10月9日 14:30 至今」
const segmentPeriod = (segment: any, timezone?: string) => {
  const from = formatZonedDateTime(segment.effectiveFrom, timezone);
  return segment.effectiveTo == null ? `${from} 至今` : `${from}–${formatZonedDateTime(segment.effectiveTo, timezone)}`;
};

type Pending = { ruleId: string; segment: any };
const rulePath = (ruleId: string) => `/api/reconciliation/rules/${encodeURIComponent(ruleId)}`;

// reload：保存以后让页面重新读（带 observe，服务端重算改到的日子）；读不到返回 null
export function TimingCorrection({ row, timezone, compact, reload }: { row: ProfitRow; timezone: string; compact: boolean; reload: () => Promise<unknown> }) {
  const { message, notification } = App.useApp();
  const [pending, setPending] = useState<Pending[]>([]);
  const [segmentKey, setSegmentKey] = useState<string | null>(null);
  const [at, setAt] = useState<any>(null);
  const [correcting, setCorrecting] = useState(false);
  const token = useRef(0);
  const ruleKey = row.ruleIds.join(",");

  const load = async (mine: number) => {
    try {
      const lists = await Promise.all(row.ruleIds.map(async (ruleId) => ({ ruleId, segments: ((await api(`${rulePath(ruleId)}/segments`))?.segments || []) as any[] })));
      if (mine !== token.current) return;
      const next = lists.flatMap(({ ruleId, segments }) => segments.filter((segment) => segment.timingSource === "detected").map((segment) => ({ ruleId, segment })));
      setPending(next); setSegmentKey((current) => (current && next.some((item) => `${item.ruleId}:${item.segment.id}` === current) ? current : next[0] ? `${next[0].ruleId}:${next[0].segment.id}` : null));
    } catch { if (mine === token.current) message.warning("倍率变化记录没读全"); }
  };
  useEffect(() => { const mine = ++token.current; setPending([]); setSegmentKey(null); setAt(null); void load(mine); return () => { token.current += 1; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);

  if (!pending.length) return null;
  const correct = async () => {
    const picked = pending.find((item) => `${item.ruleId}:${item.segment.id}` === segmentKey);
    if (!picked || !at) return void message.warning("请填倍率变化的时间");
    const mine = ++token.current;
    let saved = false;
    setCorrecting(true);
    try {
      const changed = await api(`${rulePath(picked.ruleId)}/transitions/${encodeURIComponent(picked.segment.id)}`, { method: "PUT", body: { effectiveAt: at.valueOf() } });
      saved = true;
      if (mine !== token.current) return;
      setAt(null);
      const done = correctTimingDone(changed?.resettle, { timezone });
      // 有没自动重算的日子：提示要让人看完，点关闭才收起；都重算了的照旧自动消失
      if (done.persistent) notification.info({ title: done.text, duration: 0 }); else message.success(done.text);
      const next = await reload();
      if (mine !== token.current) return;
      if (!next) message.warning("时间已修改，但最新结果没读到，请重新读取");
      await load(mine);
    } catch (err) {
      if (mine === token.current) message.error(failureText(saved ? "时间已修改，读取结果失败" : "保存失败", err));
    } finally {
      if (mine === token.current) setCorrecting(false);
    }
  };
  return <section className="jy-profit-detail__timing" aria-label={CORRECT_TIMING}>
    <h3>{reconciliationIssue("SEGMENT_TIMING_UNCONFIRMED").hint}</h3>
    <p className="jy-caption">{CORRECT_TIMING_HINT}</p>
    <div className="jy-profit-detail__timing-controls">
      <Select value={segmentKey} onChange={setSegmentKey} placeholder="选择要改的那次倍率变化" style={{ minWidth: compact ? "100%" : 230 }}
        options={pending.map(({ ruleId, segment }) => ({ value: `${ruleId}:${segment.id}`, label: `${segment.group || EMPTY} · ${ratioLabel(segment.ratio)} · ${segmentPeriod(segment, timezone)}` }))} />
      <DatePicker showTime={{ format: "HH:mm" }} format="YYYY年M月D日 HH:mm" value={at} onChange={(value) => setAt(value)} placeholder="倍率变化的时间" />
      <Button loading={correcting} onClick={() => void correct()}>{CORRECT_TIMING}</Button>
    </div>
  </section>;
}
