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

// 异步版本：同步的 scryptSync 会堵住事件循环，分布式乱试密码时拖慢全站所有请求（登录再防一层，10-25）。
// 但异步只是不堵事件循环，CPU 和 libuv 线程池（默认 4 条）还是有限的：并发一多会把线程池占满，拖慢别的用它的活
//（读文件、DNS 查询、zlib、别的异步加密）。所以同时最多跑 SCRYPT_CONCURRENCY 个，留 2 条线程给别的活；排队超过
// SCRYPT_QUEUE_LIMIT 个的直接给调用方看得到的信号（`scryptOverloaded()`），不再排队、不占线程池（安全审核 10-25 中-1，总指挥定的值）。
const scrypt = promisify(scryptCallback);
export const SCRYPT_CONCURRENCY = 2;
export const SCRYPT_QUEUE_LIMIT = 16;
let scryptRunning = 0;
const scryptQueue = [];
// 排满了（在跑的 + 排队的都到上限）：调用方该在跑 scrypt 之前就查这个、直接拒绝，不要再调 limitedScrypt
export function scryptOverloaded() {
  return scryptRunning >= SCRYPT_CONCURRENCY && scryptQueue.length >= SCRYPT_QUEUE_LIMIT;
}
async function limitedScrypt(...args) {
  if (scryptRunning >= SCRYPT_CONCURRENCY) await new Promise((resolve) => scryptQueue.push(resolve));
  scryptRunning += 1;
  try {
    return await scrypt(...args);
  } finally {
    scryptRunning -= 1;
    scryptQueue.shift()?.();
  }
}

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
  const hash = (await limitedScrypt(String(password), salt, 32)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(password, salt, hash) {
  try {
    const got = await limitedScrypt(String(password), salt, 32);
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
// 可以用环境变量 LOGIN_SITE_FAILURE_LIMIT 调整，部署说明「登录失败限流按哪个来源算」里写了怎么恢复：
// 填 0 关掉这道全站上限（只剩单来源的锁）；填的不是非负整数时按默认值算。和 TRUST_PROXY 一样读环境变量时传入 env 方便测试
export const LOGIN_SITE_FAILURE_LIMIT_DEFAULT = 50;
export function loginSiteFailureLimit(env = process.env) {
  const raw = env.LOGIN_SITE_FAILURE_LIMIT;
  if (raw === undefined || raw === "") return LOGIN_SITE_FAILURE_LIMIT_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : LOGIN_SITE_FAILURE_LIMIT_DEFAULT;
}

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

  // 设备 Cookie：和会话 Cookie 同一套签名、同一个 verify() 校验，但带 t:"device" 单独标记，两种位置互相拒绝对方
  // （安全审核 10-25 低-2：没有这个标记时，会话 Cookie 可以当设备 Cookie 用，设备 Cookie 放进会话位置也只是因为
  // 比较了 v 字段才被挡住）。version 和会话 Cookie 一样绑凭证版本（sessionVersion(auth)）：改密码、改用户名
  // 以后旧的设备 Cookie 跟着作废，不是永久豁免（安全审核 10-25 低-1）；调用方拿到以后要自己比对当前的 sessionVersion，
  // verify() 这一层不知道「当前」是哪个账号，只管签名、过期、类型对不对。有效期长（180 天），每次登录成功都用新的覆盖，
  // 不随会话过期或退出登录失效
  issueDevice(version) {
    const payload = b64url(JSON.stringify({ t: "device", v: version, exp: Date.now() + DEVICE_TTL_MS }));
    return `${payload}.${this.sign(payload)}`;
  }

  // device: true 只认设备 Cookie（必须带 t:"device"）；默认只认会话 Cookie（不能带这个标记）
  verify(token, { device = false } = {}) {
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
      if (device !== (payload.t === "device")) return null;
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
  // 固定窗口：窗口过了就清零重开，不是精确的滑动窗口。已经登录成功过的浏览器不受这条约束，见 DEVICE_COOKIE_NAME。
  // 上限是 0（LOGIN_SITE_FAILURE_LIMIT 关掉）时直接不顶住，只剩单来源的锁
  isSiteLimited(now = Date.now(), env = process.env) {
    const limit = loginSiteFailureLimit(env);
    if (limit === 0) return false;
    if (now - this.siteFailures.windowStartAt >= LOGIN_SITE_WINDOW_MS) return false;
    return this.siteFailures.count >= limit;
  }

  recordSiteFailure(now = Date.now()) {
    if (now - this.siteFailures.windowStartAt >= LOGIN_SITE_WINDOW_MS) this.siteFailures = { count: 0, windowStartAt: now };
    this.siteFailures.count += 1;
  }

  // ---- 登录尝试占位（防并发绕开限流）----------------------------------------
  // 判断「锁没锁、顶没顶」和「记一次失败」必须在同一次同步调用里做完：如果像原来那样分两步（先判断、等 scrypt 跑完再记），
  // 并发涌进来的请求会在记上失败之前就都通过判断、都去跑 scrypt——限流判断形同虚设（安全审核 10-25 高-1，实测过 500 个并发全部跑了 scrypt）。
  // 这个方法把判断和占位合成一次同步操作：函数内没有 await，调用之间不会被别的请求插进来。
  // 先把这次尝试当失败占位（单来源、全站的计数都提前记上），调用方登录成功时再调 release() 退回，不计入失败次数；
  // 失败不用再调别的方法，占位已经是最终的失败记录。被拒绝（返回 null）时什么都不会被记上。
  // exemptSiteLimit：已经登录成功过的浏览器豁免全站上限，但单来源的锁谁都不能豁免
  reserveLoginAttempt(ip, { exemptSiteLimit = false, now = Date.now() } = {}) {
    if (this.isLocked(ip, now)) return null;
    if (!exemptSiteLimit && this.isSiteLimited(now)) return null;
    this.recordFailure(ip, now);
    return () => {
      // 登录成功：退回占位。单来源整条清掉（和原来「成功清空这个来源的失败记录」一样，即使占位恰好把它锁住也一起解开——
      // 密码对了，没有理由继续锁着）；全站只退一次，不会把 count 退成负数
      this.recordSuccess(ip);
      this.siteFailures.count = Math.max(0, this.siteFailures.count - 1);
    };
  }
}
