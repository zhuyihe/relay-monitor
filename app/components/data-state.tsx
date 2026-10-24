// 加载、出错、空数据、首次使用：每个面板都用同一套说法和样式。
// 出错时说清楚读不到什么、为什么，并给「刷新」；空状态告诉用户下一步能做什么。
import type { CSSProperties, ReactNode } from "react";
import { Button } from "antd";
import { formatZonedTime, LOADING_TEXT, MINUS, refreshFailedText } from "../../lib/format";
import { consoleFailureText, failureSentence } from "../../lib/error-copy.js";
import { workflowActionMeta } from "../../lib/workflow-actions.js";
import { ErrorDetail, noteOf } from "./error-detail";
import { Sym } from "./icons";
import { Panel } from "./panel";

export function Skeleton({
  width = "100%",
  height = 14,
  className = "",
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return <span className={`jy-skeleton ${className}`.trim()} style={{ display: "block", width, height, ...style }} aria-hidden="true" />;
}

// 面板占位：标题照常显示，正文是几行骨架
export function PanelSkeleton({
  title,
  lines = 3,
  height,
  className,
}: {
  title?: ReactNode;
  lines?: number;
  // 给图表占位时用整块高度，避免加载完成后跳动
  height?: number;
  className?: string;
}) {
  return (
    <Panel title={title} className={className} label={typeof title === "string" ? undefined : LOADING_TEXT}>
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">{LOADING_TEXT}</span>
        {height ? (
          <Skeleton height={height} />
        ) : (
          <div className="jy-stack" style={{ gap: 10 }}>
            {Array.from({ length: lines }, (_, i) => (
              <Skeleton key={i} width={i === lines - 1 ? "60%" : "100%"} />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

// 整块读不到（design/ui-copy-spec.md §8.1）：一句「读不到经营数据：原因。」，what 是前半句，原因按 §8.2 归类；
// 原文只进「查看详细原因」。给了 onRetry 就放「刷新」按钮。
export function ErrorState({
  what,
  error,
  onRetry,
  retrying = false,
  center = false,
  extra,
}: {
  what: string;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  center?: boolean;
  extra?: ReactNode;
}) {
  const note = noteOf(error);
  return (
    <div className={`jy-state${center ? " jy-state--center" : ""}`} role="alert">
      <h3>
        <Sym kind="crit" className="jy-status--crit" />
        {failureSentence(what, note.text)}
      </h3>
      {(onRetry || extra) && (
        <div className="actions">
          {onRetry && <Button type="primary" loading={retrying} onClick={onRetry}>{workflowActionMeta("refresh").label}</Button>}
          {extra}
        </div>
      )}
      <ErrorDetail raw={note.raw} />
    </div>
  );
}

// 表单里有没保存的改动：标在区块标题旁边。告警中心、系统设置共用这一个
export const DIRTY_TEXT = "未保存";
export function Dirty({ show }: { show: boolean }) {
  return show ? (
    <span className="jy-dirty">
      <i aria-hidden="true" />
      {DIRTY_TEXT}
    </span>
  ) : null;
}

// 改了马上保存的区块（ui-copy-spec §8.3）：标题旁写保存中 / 哪一组没存上（带「查看详细原因」，这一组再提交一次就清掉）/
// 有没存进去的输入 / 上次保存时间（按业务时区写）。告警中心、系统设置共用，配 app/components/use-auto-save.ts。
// failed 是一般的「保存失败」（弹窗里、提示条里用），notSaved 是标题旁那一句的开头
export const SAVE_STATE_TEXT = Object.freeze({
  saving: "保存中…",
  savedAt: (time: string) => `已保存 ${time}`,
  failed: "保存失败",
  notSaved: (label: string) => `${label}没存上`,
});
export function SaveState({ saving, dirty, at, tz, failures = [] }: {
  saving: boolean; dirty: boolean; at: number; tz: string; failures?: ({ label: string; error: unknown } | null)[];
}) {
  const failure = failures.find(Boolean);
  return (
    <span aria-live="polite">
      {saving ? <span className="jy-dirty">{SAVE_STATE_TEXT.saving}</span>
        : failure ? <span className="jy-err jy-save-failed" role="alert"><Sym kind="crit" />{consoleFailureText(SAVE_STATE_TEXT.notSaved(failure.label), failure.error)}<ErrorDetail raw={noteOf(failure.error).raw} /></span>
        : dirty ? <Dirty show />
        : at ? <span className="jy-dirty">{SAVE_STATE_TEXT.savedAt(formatZonedTime(at, tz))}</span> : null}
    </span>
  );
}

// 刷新失败、页面还显示着上次读到的数据时，页顶那一条（design/ui-copy-spec.md §8.1）：
// 「刷新失败，数据截至 14:30。」+ 归类后的原因，原文只进「查看详细原因」；各页同一个样子
export function RefreshFailedBanner({
  asOf,
  tz,
  error,
  onRetry,
  retrying = false,
}: {
  asOf: unknown;
  tz?: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const note = noteOf(error);
  return (
    <div className="jy-banner" role="alert">
      <Sym kind="warn" />
      <div className="jy-banner__body">
        <b>{refreshFailedText(asOf, tz)}</b>
        <p className="jy-caption">{note.text}</p>
        <ErrorDetail raw={note.raw} />
      </div>
      {onRetry && <Button size="small" loading={retrying} onClick={onRetry}>{workflowActionMeta("refresh").label}</Button>}
    </div>
  );
}

export function EmptyState({
  title,
  desc,
  action,
  center = true,
}: {
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  center?: boolean;
}) {
  return (
    <div className={`jy-state${center ? " jy-state--center" : ""}`}>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

export type OnboardStep = { title: ReactNode; desc?: ReactNode };

// 首次使用：左边是步骤和主按钮，右边是设置完成后会看到的样子
export function Onboarding({
  title,
  desc,
  steps,
  action,
  figure,
  figureNote,
}: {
  title: ReactNode;
  desc?: ReactNode;
  steps: OnboardStep[];
  action?: ReactNode;
  figure?: ReactNode;
  figureNote?: ReactNode;
}) {
  return (
    <section className="jy-panel">
      <div className="jy-onboard">
        <div>
          <h2>{title}</h2>
          {desc && <p>{desc}</p>}
          <ol className="jy-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <div>
                  <strong>{s.title}</strong>
                  {s.desc && <span>{s.desc}</span>}
                </div>
              </li>
            ))}
          </ol>
          {action}
        </div>
        <div className="jy-onboard-figure" aria-hidden="true">
          {figure ?? (
            <div className="eq-mini">
              <span>收入</span>
              <b>{MINUS}</b>
              <span>上游成本</span>
              <b>{MINUS}</b>
              <span>固定成本</span>
              <b>=</b>
              <span>净利</span>
            </div>
          )}
          {figureNote && (
            <p className="jy-caption" style={{ marginTop: 12 }}>
              {figureNote}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
