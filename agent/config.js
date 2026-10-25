import { readFileSync } from "node:fs";
import { SECRET_PROBLEM_TEXT, secretWeakness } from "../lib/key-fingerprint.js";
import { resolveDatabase } from "./dsn.js";

export function configError(message) {
  return Object.assign(new Error(message), { code: "CONFIG_INVALID" });
}

// 读环境变量。不连库；起不来时的话不带 secret、连接串
export function loadConfig(env = process.env) {
  const secret = String(env.RELAY_KEY_AGENT_SECRET ?? "").trim();
  if (!secret) throw configError("没有设置 RELAY_KEY_AGENT_SECRET");
  const weakness = secretWeakness(secret);
  if (weakness) throw configError(SECRET_PROBLEM_TEXT[weakness]);
  let database;
  try { database = resolveDatabase(env); } catch (e) { throw configError(e.message); }
  const port = env.PORT ? Number(env.PORT) : 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError("PORT 不对");
  const certFile = String(env.TLS_CERT_FILE ?? "").trim(), keyFile = String(env.TLS_KEY_FILE ?? "").trim();
  if (!!certFile !== !!keyFile) throw configError("TLS_CERT_FILE 和 TLS_KEY_FILE 要同时设置");
  let tls = null;
  if (certFile) {
    try { tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) }; } catch { throw configError("读不到 TLS_CERT_FILE 或 TLS_KEY_FILE 指向的文件"); }
  }
  return { secret, database, port, host: String(env.HOST ?? "").trim() || "0.0.0.0", tls,
    trustProxy: /^(1|true|yes)$/i.test(String(env.KEY_AGENT_TRUST_PROXY ?? "").trim()),
    // 一键停：不读库，/keys 回 503 PAUSED
    paused: /^(1|true|yes)$/i.test(String(env.KEY_AGENT_PAUSED ?? "").trim()) };
}
