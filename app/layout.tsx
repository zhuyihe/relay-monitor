import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import Providers from "./providers";
import { BRAND } from "../lib/brand";
import { themeStyleText } from "../lib/design-tokens";
import { THEME_COOKIE, THEME_SCRIPT } from "../lib/theme";
import "./globals.css";
import "./styles/jy.css";

// 数字与拉丁字符用 IBM Plex Sans（本地文件，离线构建可用）；中文回落到系统字体
const plex = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--jy-font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: BRAND.productName,
    template: `%s · ${BRAND.name}`,
  },
  description: `${BRAND.positioning}。${BRAND.loginTagline}`,
  manifest: "/manifest.webmanifest",
  applicationName: BRAND.productName,
  icons: {
    icon: [{ url: "/icons/juyuan-mark.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F4F6F8" },
    { media: "(prefers-color-scheme: dark)", color: "#0F141B" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 显式选择过主题的用户由服务端直接输出 data-theme；没选过的由内联脚本按系统偏好补上
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const initialTheme = saved === "dark" || saved === "light" ? saved : null;
  return (
    <html lang="zh-CN" data-theme={initialTheme ?? undefined} className={plex.variable} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeStyleText() }} />
        {!initialTheme && <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />}
      </head>
      <body>
        <AntdRegistry>
          <Providers initialTheme={initialTheme}>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
