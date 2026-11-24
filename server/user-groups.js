// 用户为主的渠道分组消费。只在查看本模块时按需读取；不读取或写入对账账本。
import { createHash } from "node:crypto";
import { businessTimeZone, dayKeyInTz, dayStartInTz } from "../lib/business-time.js";
import { presetTimeRange } from "../lib/time-range.js";
import { QUOTA_PER_UNIT, queryOwnData, queryOwnFlow, queryOwnGroupRatios } from "../lib/providers.js";
import { OWN_RATE_LIMIT, ownRequestState } from "../lib/own-request-budget.js";

const HOUR = 3600000, HISTORY_TTL = 10 * 60000, PAGE_SIZE = 50;
const invalid = message => Object.assign(new Error(message), { code: "USER_GROUPS_RANGE_INVALID", status: 400 });

export function resolveUserGroupsWindow(input, now = Date.now(), tz = businessTimeZone()) {
  const preset = input.preset || "today";
  if (!["today", "yesterday", "7d", "month", "custom"].includes(preset)) throw invalid("请选择有效的消费时间范围。");
  const window = preset === "custom" ? { startMs: Number(input.startMs), endMs: Number(input.endMs) } : presetTimeRange(preset, { now, tz });
  if (!Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs) || window.startMs < 0 || window.startMs >= window.endMs || window.endMs > now || window.endMs - window.startMs > 31 * 86400000) throw invalid("请选择有效的起止时间，一次最多查询 31 天。");
  const live = preset !== "custom" && window.endMs >= now - 60000;
  if (preset === "custom" && (window.startMs % HOUR !== 0 || window.endMs % HOUR !== 0)) throw invalid("主站按小时汇总，自定义时间请选择整点；实时消费可选择今天、近 7 天或本月。");
  return { ...window, preset, tz, live };
}

// 保留原始额度再汇总；同组内的模型、渠道和 Key 只做加总，不重新乘倍率。
export function buildUserGroupPage({ directory, current = [], usage = [], flow = [], ready, live, startMs, endMs, asOf, balanceAt, rate, paused, error = null, intervalMs, tz, preset,
  ratios = null, ratiosAt = null, ratiosError = null }, input = {}) {
  const totals = new Map(), grouped = new Map(), currentByName = new Map(current.map(user => [user.username, user]));
  for (const row of usage) {
    const name = row.username ?? row.key;
    const total = totals.get(name) || { quota: 0, requests: 0 };
    total.quota += row.quota ?? row.quotaUnits;
    total.requests += row.requests;
    totals.set(name, total);
  }
  for (const row of flow) {
    let groups = grouped.get(row.user);
    if (!groups) grouped.set(row.user, groups = new Map());
    const group = groups.get(row.group) || { name: row.group || null, quota: 0, requests: 0 };
    group.quota += row.quotaUnits; group.requests += row.requests;
    groups.set(row.group, group);
  }
  const allRows = directory.filter(user => user.role < 10).map(user => {
    const previous = currentByName.get(user.username);
    const total = totals.get(user.username) || { quota: 0, requests: 0 };
    const groups = [...(grouped.get(user.username)?.values() || [])].sort((a, b) => b.quota - a.quota || String(a.name).localeCompare(String(b.name)));
    const assigned = groups.reduce((sum, group) => sum + group.quota, 0);
    const pending = ready && (assigned > total.quota || live && assigned !== total.quota);
    // 历史完整窗口内，flow 不包含未记录分组的行；差额保留。实时差额只称待补齐，不猜成未归类。
    if (ready && total.quota > assigned) groups.push({ name: null, quota: total.quota - assigned, requests: null, pending: live });
    return { id: user.id, username: user.username, disabled: user.status !== 1, big: previous?.big || false,
      balanceUsd: user.quotaUsd ?? previous?.balanceUsd ?? null, days: previous?.days ?? null, runwayState: previous?.runwayState ?? "unknown",
      total: ready ? total.quota / QUOTA_PER_UNIT : null, requests: ready ? total.requests : null, pending,
      groups: !ready || assigned > total.quota ? null : groups.map(group => {
        const special = group.name == null ? null : ratios?.overrides[user.group]?.[group.name] ?? null;
        const ratio = special ?? (group.name == null ? null : ratios?.base[group.name] ?? null);
        return { name: group.name, amount: group.quota / QUOTA_PER_UNIT, requests: group.requests, ratio,
          ratioSource: ratio == null ? null : special != null ? "user" : "group",
          share: total.quota > 0 ? group.quota / total.quota : 0, pending: group.pending === true };
      }) };
  }).filter(user => !user.disabled || user.total > 0);
  const groupNames = [...new Set(allRows.flatMap(user => user.groups || []).filter(group => group.name != null).map(group => group.name))].sort((a, b) => a.localeCompare(b));
  const q = String(input.q || "").trim().toLowerCase(), group = input.channelGroup || "", sort = ["amount", "balance", "user"].includes(input.sort) ? input.sort : "amount", dir = input.dir === "asc" ? 1 : -1;
  const matched = allRows.filter(user => user.username.toLowerCase().includes(q) && (input.active === "false" || user.total == null || user.total > 0))
    .map(user => ({ ...user, shownGroups: user.groups?.filter(item => !group || (group === "__unknown" ? item.name == null && !item.pending : item.name === group)) ?? null }))
    .filter(user => !group || user.shownGroups?.length)
    .map(user => ({ ...user, shownAmount: !ready ? null : !group ? user.total : user.shownGroups == null ? null : user.shownGroups.reduce((sum, item) => sum + item.amount, 0) }));
  matched.sort((a, b) => {
    if (sort === "user") return a.username.localeCompare(b.username) * dir;
    const av = sort === "balance" ? a.balanceUsd : a.shownAmount, bv = sort === "balance" ? b.balanceUsd : b.shownAmount;
    return av == null || bv == null ? Number(av == null) - Number(bv == null) || a.id - b.id : (av - bv) * dir || a.id - b.id;
  });
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE)), page = Math.min(pages, Math.max(1, Math.floor(Number(input.page)) || 1));
  const selected = allRows.find(user => Number(user.id) === Number(input.user));
  return { preset, startMs, endMs, asOf, balanceAt, rate, tz, paused, error, ratiosAt, ratiosError, starting: !ready, intervalMs, channelGroups: groupNames,
    hasUnclassified: allRows.some(user => user.groups?.some(item => item.name == null && !item.pending)), pendingUsers: allRows.filter(user => user.pending).length,
    selectedUser: selected ? { ...selected, shownAmount: selected.total, shownGroups: selected.groups } : null,
    summary: { users: matched.length, amount: ready ? matched.reduce((sum, user) => sum + (user.shownAmount || 0), 0) : null },
    list: { rows: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: matched.length, page, pages, pageSize: PAGE_SIZE } };
}

export async function userGroupsPage(rt, { own, page, directory, ops, input, refresh = false, now = Date.now(), readers = { user: queryOwnData, flow: queryOwnFlow, ratios: queryOwnGroupRatios } }) {
  const window = resolveUserGroupsWindow(input, now), midnight = dayStartInTz(dayKeyInTz(now, window.tz), window.tz);
  if (refresh && !window.live && !page.paused) await ops.refreshLive();
  const identity = createHash("sha256").update(JSON.stringify([own.id, own.baseUrl, own.userId, own.authVersion, own.accessToken])).digest("hex");
  if (rt._userGroups?.identity !== identity) rt._userGroups = { identity, entries: new Map() };
  const cache = rt._userGroups.entries, intervalMs = Math.max(30, rt.store.settings.refreshIntervalSec || 60) * 1000;
  const budget = needed => {
    const state = ownRequestState(own.baseUrl);
    if (state.broken || state.used + needed > Math.floor(OWN_RATE_LIMIT * .6)) throw Object.assign(new Error("busy"), { code: "USER_DATA_BUSY" });
  };
  const collect = (startMs, endMs, today) => {
    const key = `${startMs}|${today ? "today" : endMs}`, ttl = today ? intervalMs : HISTORY_TTL;
    let entry = cache.get(key);
    if (entry?.promise) return entry.promise;
    if (!refresh && entry && now - entry.at < ttl || page.paused) return Promise.resolve(entry || { data: null, error: page.paused ? "USER_DATA_DISABLED" : null });
    entry ||= { data: null, error: null, at: now };
    entry.at = now; cache.set(key, entry);
    entry.promise = (async () => {
      try {
        budget(today ? 3 : 2);
        let usage, flow, at = now, cutoff = endMs;
        if (today) {
          const result = await ops.refreshLive();
          if (result.skipped) throw Object.assign(new Error("busy"), { code: "USER_DATA_BUSY" });
          const live = rt._userOpsToday;
          if (!live || live.stationId !== own.id || live.day !== dayKeyInTz(now, window.tz) || live.at < now - intervalMs) throw Object.assign(new Error("today unavailable"), { code: "USER_DATA_UNAVAILABLE" });
          usage = live.rows.filter(row => row.hourMs >= startMs); cutoff = live.at; at = live.at;
          flow = await readers.flow(own, startMs, cutoff, { includeQuotaUnits: true });
        } else {
          [usage, flow] = await Promise.all([readers.user(own, startMs, endMs, "user", { includeQuotaUnits: true }), readers.flow(own, startMs, endMs, { includeQuotaUnits: true })]);
        }
        entry.data = { usage, flow, startMs, endMs: cutoff, at }; entry.error = null;
      } catch (error) { entry.error = error?.code || "USER_GROUPS_UNAVAILABLE"; }
      return entry;
    })().finally(() => { entry.promise = null; });
    // 不按用户、筛选条件建读取缓存，完整窗口共用一份；只保留最近用过的几个范围。
    if (cache.size > 8) for (const [oldKey, old] of cache) if (oldKey !== key && !old.promise) { cache.delete(oldKey); break; }
    return entry.promise;
  };
  // 跨今天的范围：历史部分缓存十分钟，今天单独刷新，避免每分钟重复读取整月。
  const reads = [];
  if (window.live && window.endMs > midnight) {
    if (window.startMs < midnight) reads.push(collect(window.startMs, midnight, false));
    reads.push(collect(Math.max(window.startMs, midnight), window.endMs, true));
  } else reads.push(collect(window.startMs, window.endMs, false));
  // 倍率独立缓存、独立失败：改设置后可刷新查看，既不重算消费，也不因读不到倍率隐藏金额。
  let ratioEntry = rt._userGroups.ratios;
  if (!page.paused && !ratioEntry?.promise && (refresh || !ratioEntry || now - ratioEntry.at >= intervalMs)) {
    ratioEntry ||= { data: null, asOf: null, error: null };
    rt._userGroups.ratios = ratioEntry; ratioEntry.at = now;
    ratioEntry.promise = (async () => {
      try { budget(1); ratioEntry.data = await readers.ratios(own); ratioEntry.asOf = now; ratioEntry.error = null; }
      catch { ratioEntry.data = null; ratioEntry.asOf = null; ratioEntry.error = "OWN_GROUP_RATIOS_UNAVAILABLE"; }
    })().finally(() => { ratioEntry.promise = null; });
  }
  const entries = await Promise.all(reads);
  await ratioEntry?.promise;
  // 余额可以比消费新；消费本身始终使用一整份缓存，不拼新总额和旧分组。
  const current = rt._userOpsPageCache?.payload || page, liveDirectory = rt._userOpsDirectory?.stationId === own.id ? rt._userOpsDirectory : directory;
  const ready = !!liveDirectory && entries.every(entry => entry.data);
  const data = entries.map(entry => entry.data).filter(Boolean);
  return buildUserGroupPage({ directory: liveDirectory?.users || [], current: current.users || [], usage: ready ? data.flatMap(item => item.usage) : [], flow: ready ? data.flatMap(item => item.flow) : [], ready,
    live: window.live, preset: window.preset, startMs: window.startMs, endMs: ready ? data.at(-1).endMs : window.endMs,
    asOf: ready ? data.at(-1).at : null, balanceAt: liveDirectory?.at ?? page.balanceSyncedMs ?? null,
    rate: page.rate, paused: page.paused, error: entries.find(entry => entry.error)?.error || null, intervalMs, tz: window.tz,
    ratios: ratioEntry?.data, ratiosAt: ratioEntry?.asOf, ratiosError: ratioEntry?.error }, input);
}
