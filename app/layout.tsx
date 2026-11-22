import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import Providers from "./providers";
import { BRAND } from "../lib/brand";
import { palette, themeStyleText } from "../lib/design-tokens";
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
  themeColor: palette.light.plane,
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 默认首帧白色，保留已保存的手动选择和旧设置迁移。
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const initialTheme = saved === "dark" || saved === "light" ? saved : null;
  return (
    <html lang="zh-CN" data-theme={initialTheme ?? "light"} suppressHydrationWarning>
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
