// 把读出来的行变成响应：拆 Key、认 keyless、打码、指纹、ETag、gzip；读库最多 10 秒一次（成功、失败的结果都缓存）。
// 缓存里只有打码和指纹，读出来的行算完就丢
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { KEYLESS_CHANNEL_TYPES, fingerprintKey, maskKey, splitChannelKeys } from "../lib/key-fingerprint.js";
import { ReadFailure } from "./reader.js";

export const PROTOCOL_VERSION = 1;
export const READ_INTERVAL_MS = 10000;

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
  return { ok: false, code, driver, body, readAt: now };
}

// 同一时刻只有一次读库；10 秒内的请求用上次的结果
export function createSnapshotSource({ reader, db, fingerprintKeyBytes, now = Date.now, intervalMs = READ_INTERVAL_MS }) {
  let current = null;
  let inflight = null;
  return {
    async get() {
      // 时钟往回拨时（age 为负）这份缓存的年龄说不清，重读一次，不让它一直当新的
      const age = current ? now() - current.readAt : -1;
      if (current && age >= 0 && age < intervalMs) return current;
      inflight ??= (async () => {
        try {
          current = buildSnapshot(await reader.read(), { db, fingerprintKeyBytes, now: now() });
        } catch (err) {
          current = failureSnapshot(err, now());
        } finally {
          inflight = null;
        }
        return current;
      })();
      return inflight;
    },
  };
}
