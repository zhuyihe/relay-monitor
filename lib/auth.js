// 面板登录认证：scrypt 密码哈希 + HMAC 签名会话 Cookie
import { peerHeaderName, trustsProxyHeaders } from "./client-address.js";
import {
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const COOKIE_NAME = "rm_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const DEFAULT_PASSWORD_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/password",
  "/api/auth/logout",
]);

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const got = scryptSync(String(password), salt, 32);
    const want = Buffer.from(hash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export function isDefaultPasswordRouteAllowed(pathname) {
  return DEFAULT_PASSWORD_ALLOWED_PATHS.has(pathname);
}

// 启动日志那一句：登录失败限流现在按什么算
export function loginLimitSourceText() {
  if (trustsProxyHeaders()) return { level: "log", text: "登录限流按 X-Forwarded-For 的最后一个地址（TRUST_PROXY 已开）" };
  if (peerHeaderName()) return { level: "log", text: "登录限流按连接地址" };
  return { level: "warn", text: "登录限流全站共用一个计数：启动时没有预加载 lib/peer-address.js（见部署说明「登录失败限流按哪个来源算」）" };
}

export function shouldMarkCookieSecure({ protocol, forwardedProto, trustProxy } = {}) {
  if (protocol === "https:") return true;
  if (!trustProxy) return false;
  return String(forwardedProto || "").split(",")[0].trim().toLowerCase() === "https";
}

// 登录失败限流：同一个来源累计输错 10 次锁 5 分钟；一天没再输错的计数清掉；最多记 1 万个来源
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_LOCK_MS = 5 * 60 * 1000;
export const LOGIN_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
export const LOGIN_FAILURE_MAX_ENTRIES = 10000;

export class SessionManager {
  constructor(secretFile) {
    this.secretFile = secretFile;
    this.secret = null;
    // 登录失败限流：来源 -> { count, lockedUntil, lastAt }。按最近一次失败排（更新时挪到最后），
    // 太久没动静的删掉，满了先删最旧的（换着地址乱试也撑不大内存，也不会因为满了把所有人挡在外面）
    this.failures = new Map();
  }

  async init() {
    try {
      this.secret = (await readFile(this.secretFile, "utf8")).trim();
      if (!this.secret) throw new Error("empty");
    } catch {
      this.secret = randomBytes(32).toString("hex");
      await mkdir(dirname(this.secretFile), { recursive: true });
      await writeFile(this.secretFile, this.secret, { mode: 0o600 });
    }
    return this;
  }

  sign(payloadB64) {
    return createHmac("sha256", this.secret).update(payloadB64).digest("base64url");
  }

  sessionVersion(auth) {
    return createHmac("sha256", this.secret)
      .update(`${auth?.username || ""}\u0000${auth?.hash || ""}`)
      .digest("base64url");
  }

  issue(username, version = null) {
    const payload = b64url(JSON.stringify({
      u: username,
      v: version,
      exp: Date.now() + SESSION_TTL_MS,
    }));
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const want = this.sign(payloadB64);
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      if (!payload.exp || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  cookieHeader(token, secure = false) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  clearCookieHeader(secure = false) {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  tokenFromRequest(req) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === COOKIE_NAME) return rest.join("=");
    }
    return null;
  }

  // ---- 登录失败限流 --------------------------------------------------------
  isLocked(ip, now = Date.now()) {
    const f = this.failures.get(ip);
    return !!(f && f.lockedUntil && f.lockedUntil > now);
  }

  recordFailure(ip, now = Date.now()) {
    const f = this.failures.get(ip) || { count: 0, lockedUntil: 0, lastAt: 0 };
    this.failures.delete(ip);
    f.count += 1;
    f.lastAt = now;
    if (f.count >= LOGIN_FAILURE_LIMIT) {
      f.lockedUntil = now + LOGIN_LOCK_MS;
      f.count = 0;
    }
    this.failures.set(ip, f);
    this.pruneFailures(now);
  }

  pruneFailures(now = Date.now()) {
    // 最旧的在前：遇到第一个还没过期的就停
    for (const [ip, f] of this.failures) {
      if (now - f.lastAt < LOGIN_FAILURE_TTL_MS || f.lockedUntil > now) break;
      this.failures.delete(ip);
    }
    while (this.failures.size > LOGIN_FAILURE_MAX_ENTRIES) this.failures.delete(this.failures.keys().next().value);
  }

  recordSuccess(ip) {
    this.failures.delete(ip);
  }

  // Express 中间件：保护 /api/*（放行登录接口）
  middleware() {
    return (req, res, next) => {
      const payload = this.verify(this.tokenFromRequest(req));
      if (!payload) return res.status(401).json({ error: "未登录", code: "UNAUTHORIZED" });
      req.session = payload;
      next();
    };
  }
}
