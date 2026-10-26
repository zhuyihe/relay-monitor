// 把读出来的行变成响应：拆 Key、认 keyless、打码、指纹、ETag、gzip；读库有节奏：只有控制台来问、并且离上次读库已经过了 4 分钟才读，出错以后断路停一阵（成功、失败的结果都缓存）。
// 缓存里只有打码和指纹，读出来的行算完就丢
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { KEYLESS_CHANNEL_TYPES, fingerprintKey, maskKey, splitChannelKeys } from "../lib/key-fingerprint.js";
import { ReadFailure } from "./reader.js";

export const PROTOCOL_VERSION = 1;
// 两次读库之间至少隔这么久（控制台每 5 分钟问一次，比它短一点，免得错过一轮）
export const MIN_READ_GAP_MS = 4 * 60 * 1000;
// 断路：出错后停 10 分钟，再错翻倍，最多停 1 小时；每小时的额度到顶（max_questions 这类）停到下一个整点
export const BREAKER_BASE_MS = 10 * 60 * 1000;
export const BREAKER_MAX_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// 读库出错以后，上一份成功的结果最多再用这么久（响应带 X-Agent-Stale: 1，readAt 还是那次读库的时刻）：
// 控制台连续几次读不到才算问题，一次瞬时的错不该让它立刻看到 503
export const STALE_MAX_MS = 30 * 60 * 1000;
export const NEVER_STALE_CODES = new Set(["ACCOUNT_TOO_BROAD"]);

function parseChannelInfo(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function channelView(row, fingerprintKeyBytes) {
  const base = { id: Number(row.id), name: String(row.name ?? ""), type: Number(row.type), status: Number(row.status),
    baseUrl: String(row.base_url ?? "") };
  if (KEYLESS_CHANNEL_TYPES.includes(base.type)) return { ...base, keyless: true };
  const info = parseChannelInfo(row.channel_info);
  const { keys, keyless } = splitChannelKeys(row.key, { isMultiKey: info.is_multi_key === true });
  if (keyless) return { ...base, keyless: true };
  return { ...base, keys: keys.map((key, i) => ({ i, m: maskKey(key), f: fingerprintKey(key, fingerprintKeyBytes) })) };
}

// 内容不变，ETag 就不变：readAt 每次读库都会变，不能算进去
export function buildSnapshot(rows, { db, fingerprintKeyBytes, now }) {
  const channels = rows.map((row) => channelView(row, fingerprintKeyBytes));
  const etag = `"${createHash("sha256").update(JSON.stringify({ v: PROTOCOL_VERSION, db, channels })).digest().subarray(0, 16).toString("base64url")}"`;
  const body = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, db, readAt: now, channels }));
  return { ok: true, etag, body, gzip: gzipSync(body), channelCount: channels.length, readAt: now };
}

export function failureSnapshot(failure, now) {
  const code = failure instanceof ReadFailure ? failure.code : "DB_ERROR";
  const driver = failure instanceof ReadFailure ? failure.driver : "UNKNOWN";
  const body = Buffer.from(JSON.stringify({ error: "unavailable", code }));
  return { ok: false, code, driver, hourly: failure instanceof ReadFailure && failure.hourly, body, readAt: now };
}

export function breakerPause(failures, t, { hourly = false } = {}) {
  if (hourly) return HOUR_MS - (t % HOUR_MS);
  return Math.min(BREAKER_BASE_MS * 2 ** (failures - 1), BREAKER_MAX_MS);
}

// 同一时刻只有一次读库；请求只看缓存，读库只在「有人来问、缓存超过 4 分钟、断路没开」时发生。
// paused：KEY_AGENT_PAUSED=1，永远不读库，只回 PAUSED
export function createSnapshotSource({ reader, db, fingerprintKeyBytes, now = Date.now, minGapMs = MIN_READ_GAP_MS, paused = false, onBreaker = () => {} }) {
  let current = null;
  let lastGood = null;
  let inflight = null;
  let failures = 0;
  let pausedUntil = 0;
  // 最近一次是失败、但上一份成功的结果还不到 30 分钟（从上一次成功读库算起）：给上一份，标 stale，原因码在 staleCode。
  // 「不该继续读」的失败（账号权限不合格）不给旧结果：不安全的状态下不能继续给东西
  const serve = (t) => {
    if (current && !current.ok && !NEVER_STALE_CODES.has(current.code) && lastGood && t - lastGood.readAt >= 0 && t - lastGood.readAt < STALE_MAX_MS) {
      return { ...lastGood, stale: true, staleCode: current.code };
    }
    return current;
  };
  return {
    async get() {
      if (paused) return failureSnapshot(new ReadFailure("PAUSED", "PAUSED"), now());
      const t = now();
      // 时钟往回拨时（age 为负、停到的时刻比最长还远）缓存的年龄说不清，重读一次，不让它一直当新的
      const age = current ? t - current.readAt : -1;
      if (pausedUntil - t > BREAKER_MAX_MS) pausedUntil = 0;
      if (current && age >= 0 && age < minGapMs && failures === 0) return serve(t);
      if (current && failures > 0 && t < pausedUntil) return serve(t);
      inflight ??= (async () => {
        try {
          current = lastGood = buildSnapshot(await reader.read(), { db, fingerprintKeyBytes, now: now() });
          failures = 0;
          pausedUntil = 0;
        } catch (err) {
          const at = now();
          current = failureSnapshot(err, at);
          failures += 1;
          pausedUntil = at + breakerPause(failures, at, { hourly: current.hourly });
          onBreaker({ code: current.code, failures, pauseMs: pausedUntil - at });
        } finally {
          inflight = null;
        }
        return serve(now());
      })();
      return inflight;
    },
  };
}
