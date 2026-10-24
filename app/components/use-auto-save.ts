// 改了马上保存（design/ui-copy-spec.md §8.3）：告警中心、系统设置的每一组设置都用这一份。
// 一组 = 一个值 + 一个保存函数 + 一个组名（没存上时说是哪一组）。同一页的几组排在同一个队列里（useSaveQueue），一次只存一组。
// - 没改（和已保存的一样）不存；同一组同一个值还没存完，不再发一次（回车后紧接着离开输入框）。
// - 同一组排着好几次时，只存最后一次：轮到前面那几次时直接跳过，旧值不会被存，也不会为旧值弹确认框。
// - 存好：已保存的值以服务端返回的为准；输入框里还是发出去的那个值时，才换成返回的值（服务端可能钳制过），正在输入的新值不动。
// - 存不进去：输入框回到最新已保存的值（不是发起请求那一刻的旧值），留下「X没存上：原因。」；
//   这一组再提交一次（改回原值，或者改成别的值存成功）就清掉。
// - confirm 返回 false（例如缩短保留天数时点了「取消」）：不存、回到已保存的值、不算出错；confirm 自己出错（例如预览读不到）算没存上。
//   等用户回答确认框时不算「保存中」。
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

// 一组没存上：组名 + 原文，标题旁的 SaveState 按它写
export type SaveFailure = { label: string; error: unknown } | null;

type Options<T, E> = {
  queue: SaveQueue;
  label: string;
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
  failure: SaveFailure;
  savedAt: number;
};

export function useAutoSave<T, E = string>(initial: T, { queue, label, save, equals = sameJson, validate, confirm, onRevert }: Options<T, E>): AutoSave<T, E> {
  const [value, setValueState] = useState<T>(initial);
  const [saved, setSaved] = useState<T>(initial);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<E | null>(null);
  const [failure, setFailure] = useState<SaveFailure>(null);
  const [savedAt, setSavedAt] = useState(0);
  // 最新的输入和已保存的值放在 ref 里：离开输入框时推迟一拍再读，读到的是最后一次输入；回滚用的是最新已保存的值
  const valueRef = useRef(initial);
  const savedRef = useRef(initial);
  // 这一组最后一次提交：排着的旧提交轮到时看 seq 跳过；同一个值还没存完时不再发
  const lastRef = useRef<{ seq: number; value: T; done: boolean } | null>(null);
  const optionsRef = useRef({ label, save, equals, validate, confirm, onRevert });
  optionsRef.current = { label, save, equals, validate, confirm, onRevert };

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
    const last = lastRef.current;
    if (last && !last.done && eq(last.value, next)) return;
    // 改回已保存的值、而且前面没有排着的：不用存，这一组之前的「没存上」也清掉
    if ((!last || last.done) && eq(next, savedRef.current)) {
      setFailure(null);
      return;
    }
    const seq = (last?.seq ?? 0) + 1;
    const mine = { seq, value: next, done: false };
    lastRef.current = mine;
    await queue.run(async () => {
      const { save: store, confirm: ask, equals: same, label: name } = optionsRef.current;
      const revert = () => {
        if (!same(valueRef.current, next)) return;
        setValue(savedRef.current);
        optionsRef.current.onRevert?.(savedRef.current);
      };
      try {
        // 后面还有这一组更新的提交：这次不存
        if (lastRef.current?.seq !== seq) return;
        if (same(next, savedRef.current)) {
          setFailure(null);
          return;
        }
        try {
          if (ask && !(await ask(next, savedRef.current))) {
            revert();
            return;
          }
        } catch (e) {
          setFailure({ label: name, error: e });
          revert();
          return;
        }
        if (lastRef.current?.seq !== seq) return;
        setSaving(true);
        try {
          const result = await store(next, savedRef.current);
          savedRef.current = result;
          setSaved(result);
          if (same(valueRef.current, next)) setValue(result);
          setSavedAt(Date.now());
          setFailure(null);
        } catch (e) {
          setFailure({ label: name, error: e });
          revert();
        } finally {
          setSaving(false);
        }
      } finally {
        mine.done = true;
      }
    });
  }, [queue, setValue]);

  return {
    value, saved, setValue, sync, commit,
    saving,
    dirty: !equals(value, saved),
    invalid, clearInvalid: () => setInvalid(null),
    failure, savedAt,
  };
}

// 开关、多选这类一点就存的（不经过输入框）：排在同一个队列里，有保存中、没存上和上次保存时间
export function useSaveAction(queue: SaveQueue, label: string) {
  const [saving, setSaving] = useState(0);
  const [failure, setFailure] = useState<SaveFailure>(null);
  const [savedAt, setSavedAt] = useState(0);
  // task 出错时 onFail 负责把页面上的值换回服务端的
  const run = useCallback((task: () => Promise<void>, onFail?: () => void) => queue.run(async () => {
    setSaving((n) => n + 1);
    try {
      await task();
      setFailure(null);
      setSavedAt(Date.now());
    } catch (e) {
      setFailure({ label, error: e });
      onFail?.();
    } finally {
      setSaving((n) => n - 1);
    }
  }), [queue, label]);
  return { run, saving: saving > 0, failure, savedAt };
}

// 数字框「离开输入框或按回车时提交」：推迟一拍，等输入框把越界值钳好再读（antd InputNumber 失焦时才钳）
export function commitOnLeave(commit: () => unknown) {
  const later = () => { window.setTimeout(() => { void commit(); }, 0); };
  return { onBlur: later, onPressEnter: later };
}
