// 深浅色主题的持久化约定。
// 显式选择写 cookie（服务端首帧即可输出正确的 data-theme）；没选过则跟随系统。
// v1 把选择存在 localStorage 的 app-shell-theme，这里兼容读取并迁移到 cookie。

export const THEME_COOKIE = "jy-theme";
export const LEGACY_THEME_KEY = "app-shell-theme";

const ONE_YEAR = 60 * 60 * 24 * 365;

// 首帧前执行：没有 cookie 时按旧 localStorage 或系统偏好设置 data-theme，避免闪白
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement;var s=localStorage.getItem(${JSON.stringify(LEGACY_THEME_KEY)});var t=s==="dark"||s==="light"?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");d.dataset.theme=t;}catch(e){}})();`;

export function writeThemeCookie(mode) {
  document.cookie = `${THEME_COOKIE}=${mode}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
}

export function readLegacyTheme() {
  try {
    const v = localStorage.getItem(LEGACY_THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}
