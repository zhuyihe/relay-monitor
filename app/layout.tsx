import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import Providers from "./providers";
import { BRAND } from "../lib/brand";
import { themeStyleText } from "../lib/design-tokens";
import { THEME_COOKIE, THEME_SCRIPT } from "../lib/theme";
import "./globals.css";
import "./styles/jy.css";

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
    { media: "(prefers-color-scheme: light)", color: "#F4F6F9" },
    { media: "(prefers-color-scheme: dark)", color: "#151617" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 显式选择过主题的用户由服务端直接输出 data-theme；没选过的由内联脚本按系统偏好补上
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const initialTheme = saved === "dark" || saved === "light" ? saved : null;
  return (
    <html lang="zh-CN" data-theme={initialTheme ?? undefined} suppressHydrationWarning>
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
