// 改了马上保存（design/ui-copy-spec.md §8.3）：告警中心、系统设置的每一组设置都用这一份。
// 一组 = 一个值 + 一个保存函数。同一页的几组排在同一个队列里（useSaveQueue），一次只存一组，存完接着存排着的，不丢。
// - 没改（和已保存的一样）不存；同一个值正在存，不再发一次（回车后紧接着离开输入框）。
// - 存好：已保存的值以服务端返回的为准；输入框里还是发出去的那个值时，才换成返回的值（服务端可能钳制过），正在输入的新值不动。
// - 存不进去：输入框回到最新已保存的值（不是发起请求那一刻的旧值），留下「没存上」和原文，到下一次存成功为止。
// - confirm 返回 false（例如缩短保留天数时点了「取消」）：不存、回到已保存的值、不算出错。
import { useCallback, useMemo, useRef, useState } from "react";

export type SaveQueue = { run: <R>(task: () => Promise<R>) => Promise<R> };

export function useSaveQueue(): SaveQueue {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  return useMemo(() => ({
    run: <R,>(task: () => Promise<R>) => {
      const next = tail.current.then(task, task);
      tail.current = next.catch(() => undefined);
      return next;
    },
  }), []);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Options<T, E> = {
  queue: SaveQueue;
  // 存进去，返回服务端存好的值
  save: (value: T, saved: T) => Promise<T>;
  equals?: (a: T, b: T) => boolean;
  // 不合法时返回要显示的错（不存）；合法返回 null
  validate?: (value: T) => E | null;
  confirm?: (value: T, saved: T) => Promise<boolean>;
  // 回到已保存的值以后（取消、存不进去），页面要跟着改的别的状态（例如保留天数的「自定义」框）
  onRevert?: (saved: T) => void;
};

export type AutoSave<T, E = string> = {
  value: T;
  // 服务端已保存的值
  saved: T;
  setValue: (next: T | ((current: T) => T)) => void;
  // 读到服务端的值：没改动时连输入框一起换掉，有没存的输入时只换已保存的值
  sync: (saved: T) => void;
  commit: (next?: T) => Promise<void>;
  saving: boolean;
  dirty: boolean;
  invalid: E | null;
  clearInvalid: () => void;
  error: unknown;
  savedAt: number;
};

export function useAutoSave<T, E = string>(initial: T, { queue, save, equals = sameJson, validate, confirm, onRevert }: Options<T, E>): AutoSave<T, E> {
  const [value, setValueState] = useState<T>(initial);
  const [saved, setSaved] = useState<T>(initial);
  const [saving, setSaving] = useState(0);
  const [invalid, setInvalid] = useState<E | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState(0);
  // 最新的输入和已保存的值放在 ref 里：离开输入框时推迟一拍再读，读到的是最后一次输入；回滚用的是最新已保存的值
  const valueRef = useRef(initial);
  const savedRef = useRef(initial);
  const pendingRef = useRef<{ value: T } | null>(null);
  const optionsRef = useRef({ save, equals, validate, confirm, onRevert });
  optionsRef.current = { save, equals, validate, confirm, onRevert };

  const setValue = useCallback((next: T | ((current: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (current: T) => T)(valueRef.current) : next;
    valueRef.current = resolved;
    setValueState(resolved);
  }, []);

  const sync = useCallback((serverValue: T) => {
    const { equals: eq } = optionsRef.current;
    if (eq(valueRef.current, savedRef.current)) setValue(serverValue);
    savedRef.current = serverValue;
    setSaved(serverValue);
  }, [setValue]);

  const commit = useCallback(async (nextArg?: T) => {
    const { equals: eq, validate: check } = optionsRef.current;
    const next = nextArg === undefined ? valueRef.current : nextArg;
    const problem = check ? check(next) : null;
    setInvalid(problem);
    if (problem) return;
    if (pendingRef.current && eq(pendingRef.current.value, next)) return;
    if (!pendingRef.current && eq(next, savedRef.current)) return;
    pendingRef.current = { value: next };
    setSaving((n) => n + 1);
    try {
      await queue.run(async () => {
        const { save: store, confirm: ask, equals: same } = optionsRef.current;
        const revert = () => {
          if (!same(valueRef.current, next)) return;
          setValue(savedRef.current);
          optionsRef.current.onRevert?.(savedRef.current);
        };
        // 排队期间可能已经存成了同一个值
        if (same(next, savedRef.current)) return;
        if (ask && !(await ask(next, savedRef.current))) {
          revert();
          return;
        }
        try {
          const result = await store(next, savedRef.current);
          savedRef.current = result;
          setSaved(result);
          if (same(valueRef.current, next)) setValue(result);
          setSavedAt(Date.now());
          setError(null);
        } catch (e) {
          setError(e);
          revert();
        }
      });
    } finally {
      if (pendingRef.current && eq(pendingRef.current.value, next)) pendingRef.current = null;
      setSaving((n) => n - 1);
    }
  }, [queue, setValue]);

  return {
    value, saved, setValue, sync, commit,
    saving: saving > 0,
    dirty: !equals(value, saved),
    invalid, clearInvalid: () => setInvalid(null),
    error, savedAt,
  };
}

// 数字框「离开输入框或按回车时提交」：推迟一拍，等输入框把越界值钳好再读（antd InputNumber 失焦时才钳）
export function commitOnLeave(commit: () => unknown) {
  const later = () => { window.setTimeout(() => { void commit(); }, 0); };
  return { onBlur: later, onPressEnter: later };
}
