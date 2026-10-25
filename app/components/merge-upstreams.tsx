"use client";
// 合并重复的上游（K1a，design/ux/k1a-merge.md）：上游列表顶上的提示、成本估算总成本下面那一行、「合并重复的上游」抽屉
// （一组一张卡片、合并确认、合并记录和退回）。字都在 lib/upstream-merge-view.js，这里只管摆。
// 两个页面共用同一个抽屉：useMergeUpstreams 给页面一个 open() 和要挂的 overlay，合并或退回成功后调 onChanged 让页面重读。
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Drawer, Grid, Modal } from "antd";
import { api } from "../../lib/client";
import { errorText } from "../../lib/error-copy.js";
import { MERGE_TEXT, groupView, mergeCostLineText, mergeFailureText, mergeNoticeText, recordView } from "../../lib/upstream-merge-view.js";
import { workflowActionMeta } from "../../lib/workflow-actions.js";
import { Skeleton } from "./data-state";
import { ErrorDetail, noteOf } from "./error-detail";
import { Sym } from "./icons";
import { More } from "./more";
import { useDrawerEscape } from "./drawer-escape";

const VIEW = workflowActionMeta("view_merges")!;
const GO_MERGE = workflowActionMeta("go_merge")!;
const MERGE = workflowActionMeta("merge_upstream")!;
const UNDO = workflowActionMeta("undo_merge")!;

export type MergeCounts = { mergeable: number; blocked: number; accounts: number; upstreams: number; records?: number } | null | undefined;
type Brief = { id: string; name: string };
type MergeGroup = {
  key: { provider: string; baseUrl: string; accountId: string };
  retained: Brief & { baseUrl: string; createdAt: string | null };
  merged: Brief[];
  blockers: any[];
  canMerge: boolean;
  estimate?: any;
};
type MergeRecord = { mergeId: string; mergedAtMs: number; undoneAtMs: number | null; retained: Brief; merged: Brief[]; undoable: boolean; undoBlocked: { detail: string } | null };
type MergeData = { groups: MergeGroup[]; records: MergeRecord[]; counts: MergeCounts; tz?: string };
type Confirm = { kind: "merge"; group: MergeGroup } | { kind: "undo"; record: MergeRecord };

// 上游列表顶上那条提示（有要合的才出现；info 样子，不进需处理）
export function MergeNotice({ counts, onOpen }: { counts: MergeCounts; onOpen: () => void }) {
  const text = mergeNoticeText(counts);
  if (!text) return null;
  return (
    <div className="jy-banner jy-banner--info" role="status" data-testid="merge-notice">
      <Sym kind="info" />
      <div className="jy-banner__body"><span>{text}</span></div>
      <Button type="link" size="small" onClick={onOpen}>{VIEW.label}</Button>
    </div>
  );
}

// 成本估算总成本下面那一行灰字
export function MergeCostLine({ counts, onOpen }: { counts: MergeCounts; onOpen: () => void }) {
  const text = mergeCostLineText(counts);
  if (!text) return null;
  return (
    <div className="jy-caption" data-testid="merge-cost-line">
      {text} <Button type="link" size="small" onClick={onOpen}>{GO_MERGE.label}</Button>
    </div>
  );
}

export function useMergeUpstreams({ onChanged }: { onChanged?: () => void } = {}) {
  const { message } = App.useApp();
  const router = useRouter();
  const screens = Grid.useBreakpoint();
  const compact = screens.md === false;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MergeData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; raw: unknown } | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result: MergeData = await api("/api/upstream-merges");
      if (mine === seq.current) { setData(result); setLoadError(null); }
      return result;
    } catch (error) {
      if (mine === seq.current) setLoadError(error);
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  const openDrawer = useCallback(() => { setOpen(true); setConfirm(null); setFailure(null); void load(); }, [load]);
  const closeDrawer = useCallback(() => { if (!busy) { setOpen(false); setConfirm(null); setFailure(null); } }, [busy]);
  useDrawerEscape(open && !confirm, closeDrawer);
  useEffect(() => () => { seq.current += 1; }, []);

  async function submit() {
    if (!confirm || busy) return;
    const merging = confirm.kind === "merge";
    setBusy(true);
    setFailure(null);
    try {
      if (confirm.kind === "merge") {
        await api("/api/upstream-merges", { body: { retainedId: confirm.group.retained.id, mergedIds: confirm.group.merged.map((station) => station.id) } });
        message.success(MERGE_TEXT.mergedToast(confirm.group.merged.length));
      } else {
        await api("/api/upstream-merges/undo", { body: { mergeId: confirm.record.mergeId } });
        message.success(MERGE_TEXT.undoneToast);
      }
      setConfirm(null);
      await load();
      onChanged?.();
    } catch (error: any) {
      // 清单对不上、退回不了这两类，服务端给的就是写给人看的那一句；其余的按 §8.2 归类
      const reason = error?.code === "UPSTREAM_MERGE_BLOCKED" && error.message ? error.message : errorText(error);
      setFailure({ text: mergeFailureText(merging ? "合并" : "退回", reason), raw: noteOf(error).raw });
    } finally {
      setBusy(false);
    }
  }

  // 合不了的那一组的按钮：去一个地方改（处理重复、编辑上游），或就地恢复被暂停的那个上游（改成一样以后回来就能合）
  async function runAction(action: any) {
    if (action.kind === "link") { setOpen(false); router.push(action.href); return; }
    setResuming(action.stationId);
    try {
      await api(`/api/stations/${encodeURIComponent(action.stationId)}`, { method: "PUT", body: { monitorEnabled: true } });
      message.success(action.done);
      await load();
      onChanged?.();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setResuming(null);
    }
  }

  const tz = data?.tz;
  const groups = data?.groups || [];
  const records = data?.records || [];

  const card = (group: MergeGroup) => {
    const view = groupView(group, { tz });
    return (
      <section key={group.retained.id} className={`jy-merge-card${group.canMerge ? "" : " jy-merge-card--blocked"}`} aria-label={view.heading}>
        <h3 className="jy-merge-card__title">
          {view.heading} <span className="jy-tag jy-tag--type">{view.count}</span>
          {group.canMerge ? null : <span className="jy-tag jy-tag--warn">{MERGE_TEXT.cannotMerge}</span>}
        </h3>
        <p className="jy-merge-card__line"><b>{view.mergeLine}</b></p>
        <p className="jy-merge-card__line jy-merge-card__line--soft">{view.whyLine}</p>
        {group.canMerge ? null : view.blocked.map((text) => <p key={text} className="jy-merge-card__blocked"><b>{text}</b></p>)}
        <div className="jy-merge-card__rows">
          {view.rows.map((row) => (
            <div key={row.days} className="jy-merge-card__row jy-num">
              <span className="jy-merge-card__label">{row.label}</span>
              <span>{row.before} → {row.after}</span>
            </div>
          ))}
          <span className="jy-merge-card__times">{view.times}</span>
        </div>
        {view.estimateNote ? <p className="jy-caption">{view.estimateNote}</p> : null}
        {group.canMerge ? <p className="jy-caption">{view.afterMerge}</p> : null}
        <div className="jy-merge-card__actions">
          {view.action ? <Button loading={resuming === view.action.stationId} onClick={() => void runAction(view.action)}>{view.action.label}</Button> : null}
          <Button type="primary" disabled={!group.canMerge} onClick={() => { setFailure(null); setConfirm({ kind: "merge", group }); }}>{MERGE.label}</Button>
        </div>
      </section>
    );
  };

  const recordRow = (record: MergeRecord) => {
    const view = recordView(record, { tz });
    return (
      <li key={record.mergeId} className="jy-merge-record">
        <span className="jy-merge-record__when jy-num">{view.when}</span>
        <span className="jy-merge-record__text">{view.text}</span>
        {view.undone ? <span className="jy-caption">{view.undone}</span> : (
          <Button size="small" disabled={!record.undoable} title={view.blocked || undefined} onClick={() => { setFailure(null); setConfirm({ kind: "undo", record }); }}>{UNDO.label}</Button>
        )}
      </li>
    );
  };

  const records_block = records.length ? (
    <More label={MERGE_TEXT.recordsSummary(records.length)} className="jy-merge-records">
      <ul className="jy-merge-records__list">{records.map(recordRow)}</ul>
    </More>
  ) : null;

  const confirmView = confirm?.kind === "merge" ? groupView(confirm.group, { tz }).confirm : confirm ? recordView(confirm.record, { tz }).confirm : null;
  const confirmLabel = confirm?.kind === "merge" ? MERGE.label : UNDO.label;

  const overlay = (
    <>
      <Drawer
        className="jy-drawer"
        title={MERGE_TEXT.title}
        open={open}
        placement={compact ? "bottom" : "right"}
        size={compact ? "100%" : 560}
        keyboard={false}
        onClose={closeDrawer}
      >
        <div className="jy-merge-drawer" data-testid="merge-drawer">
          <p className="jy-caption">{MERGE_TEXT.intro}</p>
          {loadError && !data ? (
            <div className="jy-banner jy-banner--crit" role="alert">
              <Sym kind="crit" />
              <div className="jy-banner__body"><b>{MERGE_TEXT.loadFailed}</b><span>{errorText(loadError)}</span><ErrorDetail raw={noteOf(loadError).raw} /></div>
              <Button size="small" loading={loading} onClick={() => void load()}>{MERGE_TEXT.retry}</Button>
            </div>
          ) : !data ? <><Skeleton height={96} /><Skeleton height={96} style={{ marginTop: 12 }} /></> : groups.length ? groups.map(card) : <p className="jy-muted" data-testid="merge-empty">{MERGE_TEXT.empty}</p>}
          {records_block}
        </div>
      </Drawer>
      <Modal
        title={confirmView?.title}
        open={!!confirm}
        onCancel={() => { if (!busy) { setConfirm(null); setFailure(null); } }}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        confirmLoading={busy}
        onOk={() => void submit()}
        okText={failure ? MERGE_TEXT.retry : confirmLabel}
        cancelText={MERGE_TEXT.confirmCancel}
        cancelButtonProps={{ disabled: busy }}
        width={520}
      >
        {failure ? (
          <div className="jy-banner jy-banner--crit" role="alert">
            <Sym kind="crit" />
            <div className="jy-banner__body"><b>{failure.text}</b><ErrorDetail raw={failure.raw} /></div>
          </div>
        ) : null}
        {confirmView?.lines.map((line: string) => <p key={line}>{line}</p>)}
        <p className="jy-caption">{confirmView?.hint}</p>
      </Modal>
    </>
  );

  return { open: openDrawer, overlay };
}
