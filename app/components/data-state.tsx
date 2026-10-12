// 加载、出错、空数据、首次使用：每个面板都用同一套说法和样式。
// 出错时说清楚哪里出了问题并给"重试"；空状态告诉用户下一步能做什么。
import type { CSSProperties, ReactNode } from "react";
import { Button } from "antd";
import { MINUS } from "../../lib/format";
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
    <Panel title={title} className={className} label={typeof title === "string" ? undefined : "正在加载"}>
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">正在加载</span>
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

export function ErrorState({
  title = "数据加载失败",
  error,
  onRetry,
  center = false,
  extra,
}: {
  title?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  center?: boolean;
  extra?: ReactNode;
}) {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    <div className={`jy-state${center ? " jy-state--center" : ""}`} role="alert">
      <h3>
        <Sym kind="crit" className="jy-status--crit" />
        {title}
      </h3>
      {msg && <p>{msg}</p>}
      {(onRetry || extra) && (
        <div className="actions">
          {onRetry && <Button onClick={onRetry}>重试</Button>}
          {extra}
        </div>
      )}
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
              <span>用量成本</span>
              <b>{MINUS}</b>
              <span>固定成本</span>
              <b>=</b>
              <span>毛利</span>
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
