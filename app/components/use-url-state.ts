"use client";
// 把页面的筛选、时间范围、标签页写进地址栏，刷新和分享链接时保持原样。
// 用 useSearchParams：外壳已在内容区外包了 Suspense。
import { useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const norm = (qs: string) => new URLSearchParams(qs).toString();

// router.replace 是异步的，生效前 window.location 还是旧地址。连续写入（可能来自同页不同的参数）
// 要接在上一次还没生效的目标上，否则后一次会把前一次的改动写回旧值。
// targets：这一串写入依次发出的目标；地址栏落到最后一个时结束，落到别处（前进后退等）时作废
let chain: { path: string; targets: string[] } | null = null;

export function useUrlParams(): [URLSearchParams, (patch: Record<string, string | null | undefined>) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const committed = sp?.toString() || "";
  useEffect(() => {
    if (!chain) return;
    const qs = norm(committed);
    // 落到中间某一步：后面的写入还在路上，继续接着
    if (chain.path === pathname && chain.targets.slice(0, -1).includes(qs)) return;
    chain = null;
  }, [committed, pathname]);
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const base = chain?.path === pathname ? chain.targets[chain.targets.length - 1] : window.location.search;
      const next = new URLSearchParams(base);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      // 写回当前地址时地址栏不会变（之前还在路上的写入会被这次取代），等不到落地，直接结束
      if (qs === norm(window.location.search)) chain = null;
      else chain = { path: pathname, targets: [...(chain?.path === pathname ? chain.targets : []), qs] };
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  return [new URLSearchParams(committed), set];
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
