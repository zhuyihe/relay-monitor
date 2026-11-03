// 页面的定时刷新：标签页在后台（document.hidden）时不发请求，切回前台立刻刷新一次。
// 各页共用这一个，不各自写 setInterval + visibilitychange：忘了关的后台标签页不该一直按「有人在看」的节奏读用户站。
// （默认的定时器要包一层：原生 setInterval 挂在别的对象上调用会报 Illegal invocation）
// 返回清理函数（给 useEffect 返回）。doc、timers 只有单测会换。
export function visibleInterval(callback, ms, { doc = typeof document === "undefined" ? null : document, timers = { setInterval: (...args) => setInterval(...args), clearInterval: (...args) => clearInterval(...args) } } = {}) {
  const timer = timers.setInterval(() => { if (!doc?.hidden) callback(); }, ms);
  const onVisible = () => { if (!doc.hidden) callback(); };
  doc?.addEventListener?.("visibilitychange", onVisible);
  return () => { timers.clearInterval(timer); doc?.removeEventListener?.("visibilitychange", onVisible); };
}
