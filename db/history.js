// 余额历史快照 + 耗尽预测：算法与 v1（lib/history.js）逐字一致。
// 原始快照可长期保留；内存只保存独立的近期热窗口，日汇总用于长期分析。
const MAX_POINTS = 5000; // 每站上限
const HOT_AGE_MS = 30 * 24 * 3600 * 1000; // 仅运行时热数据窗口
const MIN_GAP_MS = 30 * 1000; // 相邻快照最小间隔
const TOPUP_EPSILON = 0.05; // 余额上升超过该值视为充值，回归只取充值之后的段
const ROLLUP_META_KEY = "history_daily_usage_v1";
const CLEANUP_META_KEY = "history_cleanup";

const pad2 = (n) => String(n).padStart(2, "0");
const localDayKey = (t) => {
  const d = new Date(Number(t));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const localDayStart = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const asIso = (t) => Number.isFinite(Number(t)) ? new Date(Number(t)).toISOString() : null;

function retentionDays(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function cleanupState(value) {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return {
    lastRunAt: typeof raw?.lastRunAt === "string" ? raw.lastRunAt : null,
    lastDeletedCount: Number(raw?.lastDeletedCount) || 0,
    lastError: typeof raw?.lastError === "string" ? raw.lastError : null,
    lastRunDay: typeof raw?.lastRunDay === "string" ? raw.lastRunDay : null,
  };
}

// rows 必须按 station_id, t 升序。余额下降按后一快照所在自然日计入。
export function dailyUsageRows(rows, windowStart, windowEnd) {
  const previous = new Map();
  const byDay = new Map();
  for (const row of rows) {
    const id = String(row.station_id ?? row.stationId);
    const t = Number(row.t);
    const remaining = Number(row.remaining);
    const before = previous.get(id);
    if (t >= windowStart && t < windowEnd) {
      const key = `${id}\u0000${localDayKey(t)}`;
      const entry = byDay.get(key) || { stationId: id, date: localDayKey(t), usd: 0 };
      const drop = before == null ? 0 : before - remaining;
      if (drop > 0) entry.usd += drop;
      byDay.set(key, entry);
    }
    previous.set(id, remaining);
  }
  return [...byDay.values()].map((row) => ({ ...row, usd: Math.round(row.usd * 10000) / 10000 }));
}

export class History {
  constructor(pool, getRetentionDays = () => null) {
    this.pool = pool;
    this.getRetentionDays = getRetentionDays;
    // { stationId: [[t, remaining, used], ...] } 按时间升序
    this.data = {};
    this._saveTimer = null;
    this._cleanupTimer = null;
    this._writeChain = Promise.resolve(); // 写入、重算与彻底删除必须串行，避免删除后旧批次回写
    this._pending = []; // 待写透的行 [stationId, t, remaining, used]
    this._removed = new Set(); // 待彻底删除的站点
    this._purged = new Set(); // 已彻底删除的站点不会被在途刷新或旧批次重新写回
    this.cleanup = cleanupState(null);
  }

  async load() {
    // 永久留存不等于全量加载：预测和迷你趋势只读取近期热窗口。
    const cutoff = Date.now() - HOT_AGE_MS;
    const [rows] = await this.pool.query(
      "SELECT station_id, t, remaining, used FROM history_points WHERE t >= ? ORDER BY station_id, t",
      [cutoff]
    );
    this.data = {};
    for (const r of rows) {
      (this.data[r.station_id] ||= []).push([Number(r.t), r.remaining, r.used]);
    }
    // 每站只留最近 MAX_POINTS 个点；数据库原始快照不受此限制。
    for (const id of Object.keys(this.data)) {
      const arr = this.data[id];
      if (arr.length > MAX_POINTS) this.data[id] = arr.slice(arr.length - MAX_POINTS);
    }
    const [cleanupRows] = await this.pool.query("SELECT v FROM meta WHERE k = ?", [CLEANUP_META_KEY]);
    if (cleanupRows.length) this.cleanup = cleanupState(cleanupRows[0].v);
    await this.ensureDailyUsage();
    await this.runScheduledCleanup();
    return this;
  }

  async ensureDailyUsage() {
    const [markers] = await this.pool.query("SELECT k FROM meta WHERE k = ?", [ROLLUP_META_KEY]);
    if (markers.length) return;
    // 只在首次升级时全表回填一次；之后每批新快照只重算当天和前一天。
    await this.pool.query(`
      INSERT INTO station_daily_usage (station_id, date, used_usd)
      SELECT station_id,
             DATE(FROM_UNIXTIME(t / 1000)) AS date,
             SUM(CASE WHEN prev > remaining THEN prev - remaining ELSE 0 END) AS used_usd
      FROM (
        SELECT station_id, t, remaining,
               LAG(remaining) OVER (PARTITION BY station_id ORDER BY t) AS prev
        FROM history_points
      ) snapshots
      GROUP BY station_id, date
      ON DUPLICATE KEY UPDATE used_usd = VALUES(used_usd), updated_at = CURRENT_TIMESTAMP
    `);
    await this.pool.query(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [ROLLUP_META_KEY, JSON.stringify({ completedAt: new Date().toISOString() })]
    );
  }

  async refreshDailyUsage(stationIds) {
    const ids = [...new Set(stationIds.map(String))];
    if (!ids.length) return;
    const todayStart = localDayStart();
    const windowStart = todayStart - 86400000;
    const windowEnd = todayStart + 86400000;
    // 取前一天之前的最后一个点作为基线，保证跨日下降归入后一快照所在日期。
    const [rows] = await this.pool.query(
      `SELECT station_id, t, remaining
       FROM history_points
       WHERE station_id IN (?) AND t >= ? AND t < ?
       UNION ALL
       SELECT h.station_id, h.t, h.remaining
       FROM history_points h
       INNER JOIN (
         SELECT station_id, MAX(t) AS t
         FROM history_points
         WHERE station_id IN (?) AND t < ?
         GROUP BY station_id
       ) previous ON previous.station_id = h.station_id AND previous.t = h.t
       ORDER BY station_id, t`,
      [ids, windowStart, windowEnd, ids, windowStart]
    );
    const values = dailyUsageRows(rows, windowStart, windowEnd);
    await this.pool.query(
      "DELETE FROM station_daily_usage WHERE station_id IN (?) AND date >= ? AND date < ?",
      [ids, localDayKey(windowStart), localDayKey(windowEnd)]
    );
    if (values.length) {
      await this.pool.query(
        "INSERT INTO station_daily_usage (station_id, date, used_usd) VALUES ? ON DUPLICATE KEY UPDATE used_usd = VALUES(used_usd), updated_at = CURRENT_TIMESTAMP",
        [values.map((row) => [row.stationId, row.date, row.usd])]
      );
    }
  }

  async persistCleanup() {
    await this.pool.query(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [CLEANUP_META_KEY, JSON.stringify(this.cleanup)]
    );
  }

  async previewCleanup(days) {
    const retention = retentionDays(days);
    if (!retention) return { retentionDays: null, cutoffAt: null, pointCount: 0, earliestAt: null, latestAt: null };
    const cutoff = Date.now() - retention * 86400000;
    const [[row]] = await this.pool.query(
      "SELECT COUNT(*) AS pointCount, MIN(t) AS earliestAt, MAX(t) AS latestAt FROM history_points WHERE t < ?",
      [cutoff]
    );
    return {
      retentionDays: retention,
      cutoffAt: new Date(cutoff).toISOString(),
      pointCount: Number(row.pointCount) || 0,
      earliestAt: asIso(row.earliestAt),
      latestAt: asIso(row.latestAt),
    };
  }

  async runScheduledCleanup({ force = false } = {}) {
    const retention = retentionDays(this.getRetentionDays?.());
    this.syncCleanupSchedule(retention);
    if (!retention) return { skipped: "permanent" };
    const today = localDayKey(Date.now());
    if (!force && this.cleanup.lastRunDay === today) return { skipped: "already-run" };
    try {
      const [result] = await this.pool.query(
        "DELETE FROM history_points WHERE t < ?",
        [Date.now() - retention * 86400000]
      );
      this.cleanup = {
        lastRunAt: new Date().toISOString(),
        lastDeletedCount: Number(result.affectedRows) || 0,
        lastError: null,
        lastRunDay: today,
      };
      await this.persistCleanup();
      return { deletedCount: this.cleanup.lastDeletedCount };
    } catch (err) {
      this.cleanup = {
        ...this.cleanup,
        lastRunAt: new Date().toISOString(),
        lastError: err?.message || String(err),
        lastRunDay: today,
      };
      await this.persistCleanup().catch(() => {});
      console.error("历史清理失败:", this.cleanup.lastError);
      return { error: this.cleanup.lastError };
    }
  }

  syncCleanupSchedule(retention = retentionDays(this.getRetentionDays?.())) {
    if (!retention) {
      if (this._cleanupTimer) clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
      return;
    }
    if (this._cleanupTimer) return;
    const now = new Date();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    this._cleanupTimer = setTimeout(() => {
      this._cleanupTimer = null;
      this.runScheduledCleanup().catch((err) => console.error("历史定时清理失败:", err?.message));
    }, Math.max(1000, nextDay - Date.now() + 1000));
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  async getSummary() {
    const [[stats]] = await this.pool.query(
      "SELECT COUNT(*) AS pointCount, MIN(t) AS earliestAt, MAX(t) AS latestAt FROM history_points"
    );
    let tableBytes = null;
    try {
      const [[size]] = await this.pool.query(
        "SELECT data_length + index_length AS tableBytes FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = 'history_points'"
      );
      tableBytes = size?.tableBytes == null ? null : Number(size.tableBytes);
    } catch {
      // 某些受限数据库账号无 information_schema 权限，规模信息降级而不影响设置页。
    }
    return {
      retentionDays: retentionDays(this.getRetentionDays?.()),
      pointCount: Number(stats.pointCount) || 0,
      earliestAt: asIso(stats.earliestAt),
      latestAt: asIso(stats.latestAt),
      tableBytes,
      cleanup: {
        lastRunAt: this.cleanup.lastRunAt,
        lastDeletedCount: this.cleanup.lastDeletedCount,
        lastError: this.cleanup.lastError,
      },
    };
  }

  // 合并写透，避免每 60 秒逐行写多次；失败重试交给下一批（内存仍是权威热态）
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 1500);
  }

  flush({ throwOnError = false } = {}) {
    const work = async () => {
      const batch = this._pending; this._pending = [];
      const removed = [...this._removed]; this._removed.clear();
      try {
        if (removed.length) {
          await this.pool.query("DELETE FROM history_points WHERE station_id IN (?)", [removed]);
          await this.pool.query("DELETE FROM station_daily_usage WHERE station_id IN (?)", [removed]);
        }
        // purge 可能发生在前一批的异步写入期间；此处再次过滤，确保不会复活历史。
        const writable = batch.filter(([stationId]) => !this._purged.has(String(stationId)));
        if (writable.length) {
          await this.pool.query(
            "INSERT IGNORE INTO history_points (station_id, t, remaining, used) VALUES ?",
            [writable]
          );
        }
        if (writable.length) await this.refreshDailyUsage(writable.map((row) => row[0]));
        // 默认永久保留；有限期限也只在每天检查一次，避免采集路径反复扫表。
        await this.runScheduledCleanup();
      } catch (err) {
        // 写透失败：把批次放回队列，等下一次 scheduleSave 重试
        this._pending.unshift(...batch.filter(([stationId]) => !this._purged.has(String(stationId))));
        for (const id of removed) this._removed.add(id);
        // purge 的同步失败由 purge() 自己安排一次重试；后台定时重试失败时，
        // 继续按既有 1.5 秒批处理节奏重排，避免待删除历史永久滞留。
        if (removed.length && !throwOnError) this.scheduleSave();
        console.error("历史写库失败:", err?.message);
        if (throwOnError) throw err;
      }
    };
    this._writeChain = this._writeChain.then(work, work);
    return this._writeChain;
  }

  append(stationId, remaining, used) {
    if (!Number.isFinite(remaining)) return;
    stationId = String(stationId);
    if (this._purged.has(stationId)) return;
    const arr = (this.data[stationId] ||= []);
    const now = Date.now();
    const last = arr[arr.length - 1];
    if (last && now - last[0] < MIN_GAP_MS) return;
    const point = [now, Math.round(remaining * 10000) / 10000, Math.round((used || 0) * 10000) / 10000];
    arr.push(point);
    this._pending.push([stationId, point[0], point[1], point[2]]);
    // 热缓存有界，与数据库原始快照留存策略无关。
    const cutoff = now - HOT_AGE_MS;
    while (arr.length > MAX_POINTS || (arr.length && arr[0][0] < cutoff)) arr.shift();
    this.scheduleSave();
  }

  async purge(stationId) {
    stationId = String(stationId);
    this._purged.add(stationId);
    delete this.data[stationId];
    this._pending = this._pending.filter(([id]) => String(id) !== stationId);
    this._removed.add(stationId);
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // 彻底删除接口只有在历史行已实际删除后才能返回成功。
    try {
      await this.flush({ throwOnError: true });
    } catch (err) {
      // 接口向调用方报告失败，但保留的删除任务仍要在后台重试，不能留下孤儿历史。
      this.scheduleSave();
      throw err;
    }
  }

  // 向后兼容旧调用；资源归档不会调用这个方法。
  remove(stationId) { return this.purge(stationId); }

  /**
   * 自某时刻起的实际消耗：累加相邻快照间的余额下降（上升视为充值，忽略）。
   * 基线取 since 之前的最后一个快照；面板离线期间的消耗会在下一个快照补上。
   */
  usedSince(stationId, sinceTs) {
    const arr = this.data[stationId] || [];
    if (arr.length < 2) return 0;
    let start = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i][0] <= sinceTs) start = i;
    let used = 0;
    for (let i = start + 1; i < arr.length; i++) {
      const drop = arr[i - 1][1] - arr[i][1];
      if (drop > 0) used += drop;
    }
    return Math.round(used * 100) / 100;
  }

  // 站点卡片迷你走势图用：等距抽样到 maxPoints 个点，保留最后一个点
  sparkline(stationId, hours = 48, maxPoints = 40) {
    const pts = this.points(stationId, hours);
    if (pts.length <= maxPoints) return pts.map((p) => [p[0], p[1]]);
    const step = pts.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      const p = pts[Math.floor(i * step)];
      out.push([p[0], p[1]]);
    }
    const last = pts[pts.length - 1];
    if (out[out.length - 1][0] !== last[0]) out.push([last[0], last[1]]);
    return out;
  }

  points(stationId, hours = 72) {
    const arr = this.data[stationId] || [];
    const cutoff = Date.now() - hours * 3600 * 1000;
    return arr.filter((p) => p[0] >= cutoff);
  }

  // 某窗口内的实际消耗速率（$/天）：余额下降求和 ÷ 实际跨度。
  // 上升视为充值自动忽略；跨度不足 minSpanH 或点太少返回 null
  burnRate(stationId, windowHours, minSpanH = 1, minPoints = 5) {
    const arr = this.data[stationId] || [];
    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const seg = arr.filter((p) => p[0] >= cutoff);
    if (seg.length < minPoints) return null;
    const spanH = (seg[seg.length - 1][0] - seg[0][0]) / 3600000;
    if (spanH < minSpanH) return null;
    let drop = 0;
    for (let i = 1; i < seg.length; i++) {
      const d = seg[i - 1][1] - seg[i][1];
      if (d > 0) drop += d;
    }
    return { burnPerDay: (drop / spanH) * 24, samples: seg.length, spanHours: spanH };
  }

  /**
   * 耗尽预测——按「实时速率」分层估计：
   *   1. 近 3 小时实际消耗速率（提速/降速 3 小时内即反映到 ETA）
   *   2. 数据不足退近 12 小时
   *   3. 再不足退回充值截断后的 48 小时最小二乘回归（冷启动兜底）
   * 回测依据：合成提速场景下旧 48h 等权回归把 ¥48/天 稀释成 ¥5.4/天
   *（ETA 偏差 10 倍），近窗实际速率精确命中；真实数据上两者误差相当。
   * 返回 { burnPerDay, etaDays, etaAt, basis, samples, spanHours } 或 null。
   */
  predict(stationId, windowHours = 48) {
    const all = this.data[stationId] || [];
    if (all.length < 3) return null;
    const latest = all[all.length - 1];

    let est = this.burnRate(stationId, 3, 1, 5);
    let basis = "近3小时";
    if (!est) { est = this.burnRate(stationId, 12, 2, 5); basis = "近12小时"; }
    if (!est) {
      // 冷启动兜底：充值截断后的窗口回归
      const cutoff = Date.now() - windowHours * 3600 * 1000;
      let pts = all.filter((p) => p[0] >= cutoff);
      if (pts.length < 3) pts = all.slice(-50);
      let start = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i][1] > pts[i - 1][1] + TOPUP_EPSILON) start = i;
      }
      pts = pts.slice(start);
      if (pts.length < 3) return null;
      const spanMs = pts[pts.length - 1][0] - pts[0][0];
      if (spanMs < 10 * 60 * 1000) return null;
      const t0 = pts[0][0];
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const n = pts.length;
      for (const [t, r] of pts) {
        const x = (t - t0) / 3600000;
        sx += x; sy += r; sxx += x * x; sxy += x * r;
      }
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) < 1e-9) return null;
      const slope = (n * sxy - sx * sy) / denom;
      est = { burnPerDay: slope < 0 ? -slope * 24 : 0, samples: n, spanHours: spanMs / 3600000 };
      basis = "回归";
    }

    const burnPerDay = est.burnPerDay;
    if (burnPerDay < 0.0001) {
      return { burnPerDay: 0, etaDays: null, etaAt: null, basis, samples: est.samples, spanHours: Math.round(est.spanHours * 10) / 10 };
    }
    const etaDays = latest[1] / burnPerDay;
    return {
      burnPerDay: Math.round(burnPerDay * 100) / 100,
      etaDays: Math.round(etaDays * 10) / 10,
      etaAt: new Date(latest[0] + etaDays * 86400000).toISOString(),
      basis,
      samples: est.samples,
      spanHours: Math.round(est.spanHours * 10) / 10,
    };
  }
}
