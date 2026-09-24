// 面板：白底描边容器，标题行 + 可选说明行 + 正文 + 页脚。
// 标题行顺序与设计稿一致：标题、计数徽标、说明、弹性空白、右侧操作。
import { useId } from "react";
import type { ReactNode } from "react";

type PanelProps = {
  title?: ReactNode;
  // 标题右侧的灰色说明（"按天，同一纵轴"）
  caption?: ReactNode;
  // 标题后的计数徽标
  badge?: ReactNode;
  // 推到最右侧的操作区（链接、分段控件）
  extra?: ReactNode;
  // 标题下方的一行摘要
  sub?: ReactNode;
  foot?: ReactNode;
  // true：正文带内边距；"flush"：正文左右贴边（列表、表格）；false：直接放 children
  body?: boolean | "flush";
  className?: string;
  label?: string;
  children?: ReactNode;
};

export function Panel({ title, caption, badge, extra, sub, foot, body = true, className = "", label, children }: PanelProps) {
  const id = useId();
  const hasHead = title != null || caption != null || extra != null;
  const content =
    body === false ? children : <div className={`jy-panel-body${body === "flush" ? " jy-panel-body--flush" : ""}`}>{children}</div>;
  return (
    <section
      className={`jy-panel ${className}`.trim()}
      aria-labelledby={title != null ? id : undefined}
      aria-label={title == null ? label : undefined}
    >
      {hasHead && (
        <div className="jy-panel-head">
          {title != null && <h2 id={id}>{title}</h2>}
          {badge}
          {caption != null && <span className="jy-caption">{caption}</span>}
          {extra != null && (
            <>
              <span className="spacer" />
              <div className="extra">{extra}</div>
            </>
          )}
        </div>
      )}
      {sub != null && <p className="jy-panel-sub">{sub}</p>}
      {content}
      {foot != null && <div className="jy-panel-foot jy-caption">{foot}</div>}
    </section>
  );
}

export function CountBadge({ count, muted }: { count: number; muted?: boolean }) {
  return <span className={`jy-count-badge${muted || !count ? " jy-count-badge--muted" : ""}`}>{count}</span>;
}
