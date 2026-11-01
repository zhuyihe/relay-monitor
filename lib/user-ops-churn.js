// 用户运营「流失」页签要的数：纯函数，输入是 buildUsersView 算好的用户行、每天的消费、今天和过去 7 天同一时段的用量、每位用户主要用的模型。
// 口径（design 用户运营 流失 v1）：
//   - 一页回答「谁在少花钱，一天少收多少，先救谁」：损失最大的排最前面；
//   - 状态一个人只标一个，先后：今天明显少了 > 在下滑 > 已流失；
//   - 今天明显少了：今天到现在（算到上一个整点，最近一小时的数还没落齐）比过去 7 天同一时段的平均少一半以上，平时同一时段要有 $5 以上才判；
//     一天少花多少 = 过去 7 天日均 ×（1 − 今天到现在 ÷ 平时这个时段）；
//   - 在下滑：和用户页签同一个规则（lib/user-ops-view.js 的 seriesFlags）；一天少花多少 = 之前 14 天日均 − 近 3 天日均；
//   - 已流失：和用户页签同一个规则（前 30 天有消费、近 7 天没有）；一天少花多少 = 流失前 14 天（最后一次有消费的那天往前 14 天）的日均；
//   - 本周新流失：已流失里最后一次消费在 8～14 天前（今天往前数，近 7 天里刚变成已流失的）；「以前每月花」= 流失前 14 天的日均 × 30；
//   - 回流：近 7 天（含今天）有消费，而且这一段消费开始之前已经连续 7 天以上没消费、再早还有过消费（累计消费比这段数据多一截的，也算再早有过）；
//   - 月留存：上个 30 天（前 60 天到前 31 天）花过钱的人里，这个 30 天（近 30 天，含今天）还在花的占比；上一期是再往前 30 天的同样算法。
import { USERS_VIEW, dayGrid, availableDaysOf, filledFromOf, seriesFlags, sum } from "./user-ops-view.js";

export const CHURN_VIEW = Object.freeze({
  TODAY_MIN_USD: 5, // 今天明显少了：平时同一时段要有这么多才判
  TODAY_RATIO: 0.5, // 少一半以上
  LOSS_DAYS: 14, // 已流失的「以前日均」：最后一次有消费那天往前 14 天
  NEW_CHURN_FROM: 8, // 本周新流失：最后一次消费在今天往前 8～14 天
  NEW_CHURN_TO: 14,
  RETURN_GAP: 7, // 回流：消费开始之前连续没消费的天数
  MONTH: 30,
  RETURN_NAMES: 3, // 回流那格点名的人数，超过写「nova 等 4 个」
  PAGE_SIZE: 50,
  OLDER_TOL_USD: USERS_VIEW.NEW_TOL_USD, // 累计消费比数据里多出这么多，说明再早还花过
  OLDER_TOL_SHARE: USERS_VIEW.NEW_TOL_SHARE,
});

export const CHURN_ONLY = Object.freeze(["all", "todayLow", "down", "churned", "returned"]);

/**
 * rows：buildUsersView 的 users（带 username、big、group、disabled、today、lastUsed、balanceUsd、usedUsd、week）
 * daily：Map(用户名 → 每天消费，长度 USERS_VIEW.DAYS，最后一格是今天)
 * sameTime：Map(用户名 → { today, usual, usualDay })，今天到上一个整点、过去 7 天同一时段的平均、过去 7 天整天的平均；没算的（还没补到 7 天）是 null
 * models：Map(用户名 → 近 30 天花得最多的模型)；读不到是 null
 * ready：buildUsersView 的 ready；backfill：{ done, cursorMs }
 */
export function buildChurnView({ now, tz, rows, daily, sameTime, models, ready, backfill }) {
  const grid = dayGrid(now, tz);
  const N = grid.days;
  const available = availableDaysOf(grid, filledFromOf(backfill, now));
  const ok = {
    down: !!ready.down, churn: !!ready.churn,
    today: available >= 8 && sameTime != null,
    // 上个 30 天 = 前 60～前 31 天，这个 30 天 = 近 30 天：要补到前 60 天；上一期再往前 30 天：要补到前 90 天
    retention: available >= 2 * CHURN_VIEW.MONTH - 1,
    retentionPrev: available >= 3 * CHURN_VIEW.MONTH - 1,
  };

  const items = [];
  const returned = [];
  for (const row of rows) {
    const series = daily.get(row.username) || new Array(N).fill(0);
    const { week, recent3, before, down, priorSpent } = seriesFlags(series, N, ready);
    const st = ok.today ? sameTime.get(row.username) : null;
    const todayLow = !!st && st.usual >= CHURN_VIEW.TODAY_MIN_USD && st.today < st.usual * CHURN_VIEW.TODAY_RATIO;
    const churned = ok.churn && priorSpent && week === 0 && row.today === 0;
    const base = { id: row.id, username: row.username, big: row.big, disabled: row.disabled, group: row.group, lastUsed: row.lastUsed, balanceUsd: row.balanceUsd, model: models?.get(row.username) ?? null };
    if (todayLow) items.push({ ...base, status: "todayLow", before: st.usual, after: st.today, loss: st.usualDay * (1 - st.today / st.usual) });
    else if (down) items.push({ ...base, status: "down", before, after: recent3, loss: before - recent3 });
    else if (churned) {
      // 最后一次有消费的那天（近 7 天没消费，所以在倒数第 9 天或更早）、流失前 14 天的日均
      let last = N - 9;
      while (last >= 0 && !(series[last] > 0)) last -= 1;
      const from = Math.max(0, last - CHURN_VIEW.LOSS_DAYS + 1);
      const daily14 = last >= 0 ? sum(series.slice(from, last + 1)) / Math.min(CHURN_VIEW.LOSS_DAYS, last + 1) : 0;
      items.push({ ...base, status: "churned", before: daily14, after: 0, loss: daily14, daysAgo: N - 1 - last });
    }
    // 回流：近 7 天（含今天）第一笔消费的那天往前，连续没消费 7 天以上，再早有过消费
    let first = -1;
    for (let d = N - 8; d < N; d += 1) if (series[d] > 0) { first = d; break; }
    if (first >= 0) {
      let gap = 0, i = first - 1;
      while (i >= 0 && !(series[i] > 0)) { gap += 1; i -= 1; }
      const olderInData = i >= 0;
      const total = sum(series), used = Number(row.usedUsd);
      const olderBefore = !olderInData && Number.isFinite(used) && used - total > Math.max(CHURN_VIEW.OLDER_TOL_USD, CHURN_VIEW.OLDER_TOL_SHARE * used);
      if (gap >= CHURN_VIEW.RETURN_GAP && (olderInData || olderBefore)) returned.push({ ...base, status: "returned", spend: week + row.today, before: null, after: null, loss: null });
    }
  }
  items.sort((a, b) => b.loss - a.loss || a.username.localeCompare(b.username));
  returned.sort((a, b) => b.spend - a.spend || a.username.localeCompare(b.username));

  const downs = items.filter((item) => item.status === "down");
  const newChurn = items.filter((item) => item.status === "churned" && item.daysAgo >= CHURN_VIEW.NEW_CHURN_FROM && item.daysAgo <= CHURN_VIEW.NEW_CHURN_TO);

  // 月留存：上个 30 天花过钱的人，这个 30 天还在花的占比
  const spent = (series, from, to) => series.slice(from, to + 1).some((value) => value > 0);
  const retention = (cohortFrom, cohortTo, keptFrom, keptTo) => {
    let cohort = 0, kept = 0;
    for (const row of rows) {
      const series = daily.get(row.username);
      if (!series || !spent(series, cohortFrom, cohortTo)) continue;
      cohort += 1;
      if (spent(series, keptFrom, keptTo)) kept += 1;
    }
    return { cohort, kept, rate: cohort > 0 ? kept / cohort : null };
  };
  const M = CHURN_VIEW.MONTH;
  const current = ok.retention ? retention(N - 2 * M, N - M - 1, N - M, N - 1) : null;
  const prior = ok.retentionPrev ? retention(N - 3 * M, N - 2 * M - 1, N - 2 * M, N - M - 1) : null;

  const summary = {
    down: { count: downs.length, loss: sum(downs.map((item) => item.loss)) },
    newChurn: { count: newChurn.length, monthly: sum(newChurn.map((item) => item.before * CHURN_VIEW.MONTH)) },
    retention: current ? { ...current, prev: prior } : null,
    returned: { count: returned.length, top: returned.slice(0, CHURN_VIEW.RETURN_NAMES).map((item) => ({ id: item.id, username: item.username, spend: item.spend })) },
  };
  return { ready: { ...ok, available }, summary, items, returned };
}

/**
 * 主表：只列在少花钱的人（今天明显少了、在下滑、已流失），按一天少花多少从高到低；选「回流」时列回流的人。
 * query：{ only: "all" | "todayLow" | "down" | "churned" | "returned", big, q, page }；个数跟着「只看重点用户」算，搜索不改个数
 */
export function queryChurn(view, query = {}) {
  const only = CHURN_ONLY.includes(query.only) ? query.only : "all";
  const big = query.big === true;
  const key = String(query.q || "").trim().toLowerCase();
  const pageSize = CHURN_VIEW.PAGE_SIZE;
  const pool = (list) => (big ? list.filter((item) => item.big) : list);
  const items = pool(view.items), returned = pool(view.returned);
  const count = (status) => items.filter((item) => item.status === status).length;
  const counts = {
    big: view.items.filter((item) => item.big).length,
    only: {
      all: items.length,
      todayLow: view.ready.today ? count("todayLow") : null,
      down: view.ready.down ? count("down") : null,
      churned: view.ready.churn ? count("churned") : null,
      returned: view.ready.churn ? returned.length : null,
    },
  };
  const source = only === "returned" ? returned : only === "all" ? items : items.filter((item) => item.status === only);
  const matched = source.filter((item) => !key || item.username.toLowerCase().includes(key));
  const total = matched.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page)) || 1));
  return { rows: matched.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize, totals: { count: total, loss: sum(matched.map((item) => item.loss || 0)) }, counts };
}
