// "需要处理"列表：紧急在前，每条一句话说清对象、问题和下一步。
import type { ReactNode } from "react";
import { Sym } from "./icons";
import { LEVEL_LABEL, StatusSym } from "./status";

export type AttentionItem = {
  key: string;
  level: "crit" | "warn";
  who: ReactNode;
  what: ReactNode;
  desc?: ReactNode;
  // 同一对象合并进来的其余事项（"另有 N 项"）
  note?: ReactNode;
  actions?: ReactNode;
};

export function AttentionList({
  items,
  emptyTitle = "一切正常",
  emptyDesc = "没有需要处理的上游资源。",
  more,
}: {
  items: AttentionItem[];
  emptyTitle?: ReactNode;
  emptyDesc?: ReactNode;
  // 列表截断后的展开/收起，或其余资源的一句话交代
  more?: ReactNode;
}) {
  if (!items.length) {
    return (
      <div className="jy-all-clear">
        <Sym kind="good" />
        <div>
          <strong>{emptyTitle}</strong>
          {emptyDesc}
        </div>
      </div>
    );
  }
  return (
    <>
      <ul className="jy-attention">
        {items.map((it) => (
          <li key={it.key}>
            <StatusSym level={it.level} />
            <div>
              <div>
                <strong>{it.who}</strong> {it.what}
                <span className="sr-only">，{LEVEL_LABEL[it.level]}</span>
              </div>
              {it.desc != null && <p>{it.desc}</p>}
              {it.note != null && <p className="jy-attention-note">{it.note}</p>}
            </div>
            {it.actions != null && <div className="actions">{it.actions}</div>}
          </li>
        ))}
      </ul>
      {more != null && <div className="jy-attention-more">{more}</div>}
    </>
  );
}
