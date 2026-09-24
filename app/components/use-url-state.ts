"use client";
// 把页面的筛选、时间范围、标签页写进地址栏，刷新和分享链接时保持原样。
// 用 useSearchParams：外壳已在内容区外包了 Suspense。
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function useUrlParams(): [URLSearchParams, (patch: Record<string, string | null | undefined>) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  return [new URLSearchParams(sp?.toString() || ""), set];
}

// 单个参数；不在 allowed 里的值按 fallback 处理，等于 fallback 时从地址栏省略
export function useUrlState<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (v: T) => void] {
  const [sp, set] = useUrlParams();
  const raw = sp.get(key) as T | null;
  const value = raw != null && (!allowed || allowed.includes(raw)) ? raw : fallback;
  const setValue = useCallback((v: T) => set({ [key]: v === fallback ? null : v }), [set, key, fallback]);
  return [value, setValue];
}
