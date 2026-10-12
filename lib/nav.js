// 侧栏导航的唯一来源：分组、路由、标签、图标。
// 顶栏标题和 document.title 也从这里取，改名只改 lib/brand.js 的 NAV_LABELS。
import { NAV_LABELS } from "./brand.js";

/** @typedef {{ key: string, path: string, label: string, icon: string }} NavItem */
/** @typedef {{ label: string, items: NavItem[] }} NavGroup */

/** @type {readonly NavGroup[]} */
export const NAV_GROUPS = Object.freeze([
  {
    label: "监控",
    items: [
      { key: "home", path: "/", label: NAV_LABELS.home, icon: "overview" },
      { key: "stations", path: "/stations", label: NAV_LABELS.stations, icon: "stations" },
      { key: "usage", path: "/usage", label: NAV_LABELS.usage, icon: "usage" },
    ],
  },
  {
    label: "经营",
    items: [
      { key: "my", path: "/my", label: NAV_LABELS.my, icon: "my" },
      { key: "analytics", path: "/analytics", label: NAV_LABELS.analytics, icon: "analytics" },
      { key: "reconciliation", path: "/reconciliation", label: NAV_LABELS.reconciliation, icon: "recon" },
    ],
  },
  {
    label: "系统",
    items: [
      { key: "notifications", path: "/notifications", label: NAV_LABELS.notifications, icon: "bell" },
      { key: "settings", path: "/settings", label: NAV_LABELS.settings, icon: "gear" },
    ],
  },
]);

/** @type {readonly NavItem[]} */
export const NAV_ITEMS = Object.freeze(NAV_GROUPS.flatMap((g) => g.items));

// 当前路径对应的导航项：精确匹配优先，其次按最长前缀（/stations/xxx → 上游资源）
/** @param {string} pathname @returns {NavItem | null} */
export function navItemFor(pathname) {
  const path = pathname || "/";
  const exact = NAV_ITEMS.find((it) => it.path === path);
  if (exact) return exact;
  return (
    NAV_ITEMS.filter((it) => it.path !== "/" && path.startsWith(`${it.path}/`)).sort(
      (a, b) => b.path.length - a.path.length,
    )[0] || null
  );
}
