import type { ReactNode } from "react";
import { Icon } from "./icons";

export function SortHeader({ label, direction, onClick }: { label: ReactNode; direction?: "asc" | "desc"; onClick: () => void }) {
  return (
    <button type="button" className={`jy-my-sort${direction ? " is-active" : ""}`} onClick={onClick} title="点击切换排序">
      {label}<Icon name={direction === "asc" ? "sort" : direction === "desc" ? "sort-down" : "sort-both"} />
    </button>
  );
}
