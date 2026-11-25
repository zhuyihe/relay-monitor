import { createHash } from "node:crypto";
import { queryNewApiKeyLogPage, queryNewApiTokenStat, unixSecondWindow } from "../lib/providers.js";
import { UpstreamKeyLogStore } from "../db/upstream-key-log-store.js";

const HOUR_MS = 3600000;
const PENDING = { complete: false };
const invalid = (message) => Object.assign(new Error(message), { code: "UPSTREAM_RESPONSE_INVALID" });
const numeric = (v) => typeof v === "number" || typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// self 日志的 id 是上游重新编排的显示序号，不能拿它去重或作为游标。
const pageHash = (rows) => {
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw invalid("上游个人消费日志格式异常");
  return hash(rows.map(({ id: _displayId, ...row }) => Object.keys(row).sort().map((key) => [key, row[key]])));
};

// 按账号共享读取；只存 (秒, token_id, quota) 聚合，不存名称、日志正文或完整 Key。
// 大窗口二分成稳定的小窗口，避免活跃账号一直因新日志插入而从第一页重来。
export function createUpstreamKeyLogReader({ pool, store = new UpstreamKeyLogStore(pool),
  page = queryNewApiKeyLogPage, stat = queryNewApiTokenStat, now = Date.now,
  maxRequests = 48, maxLeafPages = 4, maxDurationMs = 20000 } = {}) {
  const budgets = new Map(), queues = new Map(), requests = new Map();
  let lastPrune = 0;

  const sourceOf = (station, metadata) => {
    const account = metadata?.accountId ?? metadata?.userId;
    if (account == null || metadata?.userId == null || String(account) !== String(metadata.userId)) throw invalid("上游账号身份尚未确认");
    return hash([new URL(station.baseUrl).href.replace(/\/+$/, ""), String(account), station.authVersion || 1, hash(String(station.accessToken || ""))]);
  };
  const budgetOf = (source) => {
    const minute = Math.floor(now() / 60000);
    let budget = budgets.get(source);
    if (budget?.minute !== minute) budgets.set(source, budget = { minute, remaining: maxRequests });
    // 清理不再使用的账号，避免删站或换凭据后无限积累。
    for (const [key, value] of budgets) if (value.minute < minute - 2) budgets.delete(key);
    return budget;
  };

  async function collect(station, metadata, startMs, endMs, { readOnly, statTimeoutMs, freshAfterMs }) {
    const source = sourceOf(station, metadata), budget = budgetOf(source), startedAt = now();
    const canRead = () => budget.remaining > 0 && now() - startedAt < maxDurationMs;
    const read = async (fn, a, b, options = {}) => {
      if (!canRead()) return null;
      budget.remaining -= 1;
      return fn(station, { startMs: a, endMs: b, userId: metadata.userId, status: metadata,
        statTimeoutMs, accountTotal: true, ...options });
    };
    const merged = new Map();
    let latestLogAtMs = null;
    const add = (value) => {
      for (const [second, id, quota] of value.buckets || []) {
        if (second * 1000 < startMs || second * 1000 >= endMs) continue;
        const total = (merged.get(String(id)) || 0) + quota;
        if (!Number.isSafeInteger(total)) throw invalid("上游消费日志额度超出安全精度");
        merged.set(String(id), total);
        latestLogAtMs = Math.max(latestLogAtMs || 0, second * 1000);
      }
    };

    async function walk(a, b) {
      const saved = await store.get(source, a, b), prior = saved?.value;
      const persist = (value) => store.put(source, a, b, value, saved?.revision ?? null, now());
      const split = async () => {
        const mid = Math.floor((a + b) / 2000) * 1000;
        if (!await persist({ split: mid })) return false;
        return children(mid);
      };
      const children = async (mid) => {
        if (a < endMs && mid > startMs && !await walk(a, mid)) return false;
        return !(mid < endMs && b > startMs) || walk(mid, b);
      };
      if (prior?.split > a && prior.split < b) return children(prior.split);
      const closed = b <= now() - 15 * 60000;
      const ttl = closed ? 24 * HOUR_MS : 15000;
      // 结束满结账等待期后至少重新核验一次，不能拿尚在写入的小时缓存直接结账。
      if (prior?.complete && prior.at >= freshAfterMs && now() - prior.at < ttl && (!closed || prior.at >= b + 15 * 60000)
        && prior.throughMs >= Math.min(b, endMs)) { add(prior); return true; }
      if (readOnly || !canRead()) return false;
      const throughMs = Math.min(b, Math.floor(now() / 1000) * 1000);
      const before = await read(stat, a, b);
      if (!before) return false;
      const first = await read(page, a, b);
      if (!first) return false;
      if (first.total > maxLeafPages * 100 && b - a > 1000) return split();
      const head = pageHash(first.rows);
      let progress = prior && !prior.complete && prior.accountQuota === before.quotaUnits && prior.head === head
        && prior.format === first.format && prior.total === first.total ? structuredClone(prior)
        : { nextPage: 0, format: first.format, total: first.total, head, accountQuota: before.quotaUnits, quota: 0, count: 0, buckets: [], hashes: [] };
      const buckets = new Map(progress.buckets.map(([second, id, quota]) => [`${second}:${id}`, [second, id, quota]]));
      let done = false;
      while (!done) {
        const result = progress.nextPage === 0 ? first : await read(page, a, b, { page: progress.nextPage, format: progress.format });
        if (!result) break;
        if (result.format !== progress.format || result.total !== progress.total) { progress = {}; break; }
        const digest = pageHash(result.rows);
        if (result.rows.length && progress.hashes.includes(digest)) throw invalid("上游个人消费日志翻页没有前进");
        for (const row of result.rows) {
          const id = numeric(row.token_id), second = numeric(row.created_at), quota = numeric(row.quota);
          if (!Number.isSafeInteger(id) || id < 0 || id === 0 && quota > 0 || !Number.isSafeInteger(second) || second * 1000 < a || second * 1000 >= b
            || Number(row.type) !== 2 || !Number.isSafeInteger(quota) || quota < 0
            || row.user_id != null && String(row.user_id) !== String(metadata.userId)) throw invalid("上游消费日志缺少有效的 Key ID、额度或窗口身份");
          const key = `${second}:${id}`, entry = buckets.get(key) || [second, id, 0];
          entry[2] += quota; buckets.set(key, entry);
          progress.quota += quota;
          if (!Number.isSafeInteger(progress.quota)) throw invalid("上游消费日志额度超出安全精度");
        }
        progress.count += result.rows.length;
        progress.hashes.push(digest);
        progress.nextPage += 1;
        // total 在部分部署里是封顶值，不能凭 count >= total 就算读全，必须遇到短页/空页。
        done = result.rows.length < 100;
        if (!done && progress.nextPage >= maxLeafPages && b - a > 1000) return split();
      }
      progress.buckets = [...buckets.values()];
      if (done) {
        const after = await read(stat, a, b);
        const tailHead = progress.nextPage > 1 ? await read(page, a, b) : first;
        if (after && tailHead) {
          const complete = before.quotaUnits === after.quotaUnits && progress.quota === after.quotaUnits
            && (progress.total == null || progress.count >= progress.total)
            && pageHash(tailHead.rows) === head && tailHead.total === first.total;
          progress = complete ? { complete: true, buckets: progress.buckets, at: now(), throughMs } : {};
        }
      }
      if (!await persist(progress)) return false;
      if (!progress.complete) return false;
      add(progress); return true;
    }

    for (let a = Math.floor(startMs / HOUR_MS) * HOUR_MS; a < endMs; a += HOUR_MS) {
      if (!await walk(a, a + HOUR_MS)) return PENDING;
    }
    if (!readOnly && now() - lastPrune > 60000) {
      lastPrune = now();
      // 清理失败不影响已经核验过的读取，也不把聚合错报成上游故障。
      await store.prune?.(now()).catch(() => {});
    }
    return { complete: true, byToken: Object.fromEntries(merged), latestLogAtMs };
  }

  return {
    async read(station, { metadata, token, startMs, endMs, readOnly = false, statTimeoutMs, freshAfterMs = 0 }) {
      const window = unixSecondWindow(startMs, endMs);
      const raw = { quotaPerUnit: metadata.quotaPerUnit, emptySecondWindow: window.empty, actualGroups: [], tokenIds: [Number(token.id)], latestLogAtMs: null };
      if (window.empty) return { ...raw, quotaUnits: 0 };
      const a = window.start * 1000, b = (window.end + 1) * 1000;
      const source = sourceOf(station, metadata), key = `${source}:${a}:${b}:${readOnly}:${freshAfterMs}`;
      for (const [id, cached] of requests) if (now() - cached.at > 15000) requests.delete(id);
      let request = requests.get(key);
      if (!request) {
        const previous = queues.get(source) || Promise.resolve();
        const promise = previous.catch(() => {}).then(() => collect(station, metadata, a, b, { readOnly, statTimeoutMs, freshAfterMs }));
        queues.set(source, promise);
        const clear = () => { if (queues.get(source) === promise) queues.delete(source); };
        promise.then(clear, clear);
        request = { at: now(), promise };
        requests.set(key, request);
        promise.then((result) => { if (!result.complete && requests.get(key) === request) requests.delete(key); },
          () => { if (requests.get(key) === request) requests.delete(key); });
        while (requests.size > 256) requests.delete(requests.keys().next().value);
      }
      const result = await request.promise;
      return { ...raw, complete: result.complete, quotaUnits: result.complete ? result.byToken[String(token.id)] || 0 : null,
        latestLogAtMs: result.latestLogAtMs ?? null };
    },
  };
}
