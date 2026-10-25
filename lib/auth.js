// 面板登录认证：scrypt 密码哈希 + HMAC 签名会话 Cookie
import { peerHeaderName, trustsProxyHeaders } from "./client-address.js";
import {
  randomBytes,
  scrypt as scryptCallback,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// 异步版本：同步的 scryptSync 会堵住事件循环，分布式乱试密码时拖慢全站所有请求（登录再防一层，10-25）
const scrypt = promisify(scryptCallback);

export const COOKIE_NAME = "rm_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
// 已经登录成功过的浏览器：退出登录不清掉它，只用来豁免全站登录失败上限（见下面 LOGIN_SITE_*），不能拿它直接登录
export const DEVICE_COOKIE_NAME = "rm_device";
const DEVICE_TTL_MS = 180 * 24 * 3600 * 1000; // 180 天，每次登录成功都刷新一次
const DEFAULT_PASSWORD_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/password",
  "/api/auth/logout",
]);

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = (await scrypt(String(password), salt, 32)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(password, salt, hash) {
  try {
    const got = await scrypt(String(password), salt, 32);
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

// 全站登录失败上限（登录再防一层，10-25 总指挥定）：防分布式乱试——按来源限流挡不住很多个来源各试几次。
// 5 分钟内全站失败满这个数，这之后不管哪个来源来的登录请求都直接拒绝、不跑 scrypt，直到窗口滚过去。
// 已经登录成功过的浏览器（设备 Cookie）不受这条约束，单来源的锁和密码校验照常走，见 app/api/auth/login/route.js。
// 固定窗口、不是精确的滑动窗口：和现有单来源限流一个粗细度，挡的是数量级，不用算得很精确
export const LOGIN_SITE_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_SITE_FAILURE_LIMIT = 50;

export class SessionManager {
  constructor(secretFile) {
    this.secretFile = secretFile;
    this.secret = null;
    // 登录失败限流：来源 -> { count, lockedUntil, lastAt }。按最近一次失败排（更新时挪到最后），
    // 太久没动静的删掉，满了先删最旧的（换着地址乱试也撑不大内存，也不会因为满了把所有人挡在外面）
    this.failures = new Map();
    // 全站失败计数（固定窗口），换密钥要重启进程才生效，和这里一样是全新的实例、从 0 开始，不用专门清
    this.siteFailures = { count: 0, windowStartAt: 0 };
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

  issue(username, version = null, ttlMs = SESSION_TTL_MS) {
    const payload = b64url(JSON.stringify({
      u: username,
      v: version,
      exp: Date.now() + ttlMs,
    }));
    return `${payload}.${this.sign(payload)}`;
  }

  // 设备 Cookie：和会话 Cookie 同一套签名、同一个 verify() 校验（只看签名和有效期，不绑用户名和密码哈希——
  // 改了密码，这台浏览器照样豁免全站上限）。有效期长（180 天），每次登录成功都用新的覆盖，不随会话过期或退出登录失效
  issueDevice() {
    return this.issue(null, null, DEVICE_TTL_MS);
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

  cookieHeader(token, secure = false, { name = COOKIE_NAME, maxAgeMs = SESSION_TTL_MS } = {}) {
    const maxAge = Math.floor(maxAgeMs / 1000);
    return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  // 设备 Cookie：HttpOnly、SameSite=Lax，开了 HTTPS（或信任的代理）时带 Secure，和会话 Cookie 一个规矩
  deviceCookieHeader(token, secure = false) {
    return this.cookieHeader(token, secure, { name: DEVICE_COOKIE_NAME, maxAgeMs: DEVICE_TTL_MS });
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
    this.recordSiteFailure(now);
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

  // ---- 全站登录失败上限（防分布式乱试，不分来源）--------------------------
  // 固定窗口：窗口过了就清零重开，不是精确的滑动窗口。已经登录成功过的浏览器不受这条约束，见 DEVICE_COOKIE_NAME
  isSiteLimited(now = Date.now()) {
    if (now - this.siteFailures.windowStartAt >= LOGIN_SITE_WINDOW_MS) return false;
    return this.siteFailures.count >= LOGIN_SITE_FAILURE_LIMIT;
  }

  recordSiteFailure(now = Date.now()) {
    if (now - this.siteFailures.windowStartAt >= LOGIN_SITE_WINDOW_MS) this.siteFailures = { count: 0, windowStartAt: now };
    this.siteFailures.count += 1;
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
