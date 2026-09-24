// 线性图标与状态符号（与 design/mockups/index.html 的 symbol 一致）。
// 状态符号用形状区分：crit 菱形、warn 三角、good 实心圆、unknown 空心圆、info 圆内 i，
// 色觉异常和灰度打印时也能分辨。
import type { SVGProps } from "react";

const PATHS: Record<string, React.ReactNode> = {
  overview: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  stations: (
    <>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <path d="M4.6 4.75h.01M4.6 11.25h.01" />
    </>
  ),
  usage: <path d="M1.5 8.5h3l2-5.5 3 10 2-4.5h3" />,
  my: (
    <>
      <path d="M2.5 6.5 8 2l5.5 4.5V14h-11Z" />
      <path d="M6.5 14v-4h3v4" />
    </>
  ),
  analytics: (
    <>
      <path d="M2 14h12" />
      <path d="M4.5 11V8M8 11V4M11.5 11V6.5" />
    </>
  ),
  recon: (
    <>
      <path d="M2.5 4h7M2.5 8h5M2.5 12h4" />
      <path d="m9.5 11 1.8 1.8L14 9.5" />
    </>
  ),
  bell: (
    <>
      <path d="M4 7a4 4 0 0 1 8 0v3l1.5 2h-11L4 10Z" />
      <path d="M6.5 14h3" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1" />
      <path d="M13.5 2.2v3.3h-3.3" />
    </>
  ),
  theme: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" />
    </>
  ),
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  edit: <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5V10.5Z" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="m3 8.5 3 3 7-7" />,
  sort: <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />,
  "sort-down": <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />,
  restore: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.3 2.3v3h3" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2V11M8 5h.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </>
  ),
  table: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2 6h12M2 9.75h12M6.5 6v7.5" />
    </>
  ),
  chart: <path d="M2 12.5 6 8l3 3 5-6" />,
  collapse: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  expand: <path d="M6 3.5 10.5 8 6 12.5" />,
  logout: (
    <>
      <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
      <path d="M10.5 11 13.5 8l-3-3M13.5 8H6" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
    </>
  ),
  archive: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="3.2" rx=".8" />
      <path d="M3 5.7V13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.7M6.5 8.5h3" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
    </>
  ),
  test: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z" />,
  external: (
    <>
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
      <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  download: (
    <>
      <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7" />
      <path d="M2.5 13.5h11" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "", ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg className={`jy-icon ${className}`.trim()} viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...rest}>
      {PATHS[name]}
    </svg>
  );
}

export type SymKind = "crit" | "warn" | "good" | "unknown" | "info";

export function Sym({ kind, className = "" }: { kind: SymKind; className?: string }) {
  return (
    <svg className={`jy-sym ${className}`.trim()} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {kind === "crit" && <path d="M6 .6 11.4 6 6 11.4.6 6Z" fill="currentColor" />}
      {kind === "warn" && <path d="M6 1 11.6 10.8H.4Z" fill="currentColor" />}
      {kind === "good" && <circle cx="6" cy="6" r="4.2" fill="currentColor" />}
      {kind === "unknown" && <circle cx="6" cy="6" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      {kind === "info" && (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 5.2V8.6M6 3.4h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
